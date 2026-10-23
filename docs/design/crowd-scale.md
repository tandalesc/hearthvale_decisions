# Crowd scale: tens and hundreds of thousands of walkers (investigation)

> **Status** (2026-10-22, later): stage 1 items 1, 2, 3, 4, 6, 7, 8 and 9 are implemented on
> branch `claude/dreamy-rubin-ac86c0`, item 5 (shared delivery) was tried and dropped, and
> item 9 without its "on screen first" part (the sim must not depend on the camera). Results
> and new baselines: PERFORMANCE.md, "Crowds, stage 1". The text below is the investigation
> as it was.
>
> **Status** (2026-10-22): research only. Nothing here is implemented. The measurements
> come from throwaway harnesses (described in §1, not committed). The branch moved during
> the session, from `34ae9a9` ("Everyone walks") to `57c3189`:
> - the CPU profiles and the full-sim runs up to k = 10 ran on `34ae9a9`/`eaa8bf7`;
> - the frozen-town runs and the k = 20 full-sim run ran on `57c3189`.
>
> The commits in between change the mirror's road diff, bridge decks and terrain noise,
> not walker, routing or people-drawing code.

**Question.** Now that every resident walks, what would it take to simulate and draw
10,000, 50,000 and 100,000+ individual walkers? Assume the decision system keeps up.

**Answer.** The walker loop itself is not the problem: it costs about 0.7 µs per walker
per tick and grows linearly. What breaks is everything that happens **per trip**, **per
waypoint** and **per building change**, and on the GPU **per vertex of every walker,
seen or not**:

1. **Route planning and delivery.** About 1 trip per walker per 35 sim seconds, each
   costing about 0.3 ms of A* plus 0.15 ms of route post-processing (`setRoute`). At
   97k walkers that is 274 trips a tick: 80 ms of A* and 40 ms of delivery per tick.
   The route cache could serve about half of these, but it is cleared every time the nav
   grid's key moves (at least every two game months), so it serves 1–3 %.
2. **Drawing.** Every walker runs a 336-vertex posed figure and two 27-vertex blob quads
   every frame, even off screen and beyond the far LOD (where every vertex collapses to a
   point). People cost **0.22–0.28 µs of GPU per walker per frame on an M5 Pro, whatever
   the camera**: 2.5 ms at 5k, 21 ms at 89k.
3. **Per-waypoint row churn and per-change full scans.** Routes carry about 100 points
   after smoothing, and every point a walker passes rewrites its render row. A quarter of
   all rows change every tick, and because the dirty set is a single range the whole
   buffer crosses the thread boundary every step (84 bytes a walker: 8 MB at 100k).
   Every building change re-checks every walker (`checkFootprints`): 170 ms at 97k
   (p95 1.4 s).

The fix is not a struct-of-arrays rewrite first. It is to stop paying per waypoint and per
unseen walker:
- **10k** needs no new model, only a set of targeted changes (§5, stage 1): routes that
  survive grid changes, shared route post-processing, a tile index for footprint checks,
  sparse render rows, and culled, banded drawing.
- **50k** needs walkers whose **trips are analytic**: a polyline with a time table that
  both the sim and the GPU evaluate. Then nothing is stepped per tick per walker, and
  only trip starts cross to the main thread.
- **100k+** adds more cores for routing and delivery, GPU-driven LOD, and on phones a
  device-scaled individual cap over the aggregate model the game already has.

Simulation detail must never depend on the camera. Only drawing may.

---

## 1. How it was measured

All CPU numbers are **process CPU time** (`process.cpuUsage`) under `node --single-threaded`
(no parallel GC or compiler threads), so they are robust to the machine's load. The
machine was shared: its load average ran between 9 and 23. Wall times from the same runs
were 2–8× longer and are not used.

- **Machine.** Apple M5 Pro, macOS, Node 24.14, Chrome with ANGLE Metal.
- **Town.** `fixtureState('city')` (year 92, 637 buildings, 4,834 residents with homes),
  then `setIndividualCap(s, null)`.
- **Scaling.** Every household's `size` is multiplied by k (1, 2, 4, 10, 20), then
  `syncIndividuals`. This makes the town **denser, not bigger**:
  - it has the same buildings, so crowds at destinations are k times fuller;
  - routes are the same length (a real 100k town would be larger, with longer routes);
  - in the full-sim runs, month and year jobs split and evict the overcrowded households,
    so the population drifts down during a run (k = 20: 96.7k → 69.9k). Rows are labelled
    by the walker count during the measured window.
- **Harnesses** (in the session's scratchpad, not committed):
  - `crowd-bench`: the full sim. Per tick, `routes.tick` is drained (route-planner in
    cooperative mode, a clock that never advances, unlimited pending), then `stepTick`,
    `view.sync` (rowFloats 20) and `createMirrorSource().delta`. Deliveries
    (`people.js setRoute`, run in the planner's callbacks) are timed separately. There are
    600 warm-up ticks, then 600 measured.
  - `walker-only`: the walker loop in a **frozen** town. It calls `stepPeople` directly
    and advances `time.tick` by hand, so there are no month or year jobs, no building
    changes and no population drift. There are 900 warm-up ticks, then 600 measured.
    Then 5 forced footprint changes (`worldVersion++`) measure `checkFootprints`.
  - `astar`: 1,500 A* searches from walker positions to random doors on the city nav grid,
    plus full-grid flow fields.
  - `sharing`: logs every route request over 1,500 ticks and replays it through an
    8,192-entry LRU, to see what a cache that is never cleared would hit.
  - `gpu-ab`: Chrome, High tier, 1440×900 at DPR 2 (1.75 after the tier cap), blob
    shadows, 1× speed. It loads scaled saves through the `?fixture=city` route, waits
    15 s, then alternates 2 s windows with the people meshes drawn and hidden
    (`material.visible`), four rounds, and reads `EXT_disjoint_timer_query_webgl2` per
    frame.
  - Two CPU profiles of `crowd-bench` (k = 1 and 10) give the function shares.
- **Phones are not measured** (HANDOFF notes iPhone is untested). Phone figures below
  assume JS runs **3–4× slower** than an M5 Pro performance core and the GPU is **8–15×
  slower** than the M5 Pro's. They are estimates, marked as such.

Ticks per real second are 5 × speed (`TICK_SECONDS` 0.1, `PACE` 0.5): 5 at 1×, 25 at 5×
and 100 at 20×. At 20× a tick must cost under 10 ms of the sim worker's core, and under
about 6 ms to leave headroom.

## 2. What a walker costs today

### 2.1 Data layout

Walkers are plain objects in `state.people`, in an order that is part of the save (it is
the tick order).
- **A person** has about 25 fields: ids, x/z, velocity, speed, heading, action and its
  time, `rev`, cell, and nested `needs` and `look` objects.
- **A task** has about 20 fields, plus `route`, a JS array of doubles of **about 100
  points** after lane offset, deck lanes, two Chaikin passes and skirting.
- **Heap.** About 4.5–6.5 KB per walker: 63 MB at 4.8k, 221 MB at 48k, 452 MB at 97k
  (sim worker only).
- **Save.** Walkers are saved as JSON: **4.5 KB per walker**, almost all of it the route.
  A city save goes from 5 MB without walkers to 27.7 MB with 5k, and `serialize` takes
  0.46 s. At 100k that would be about 450 MB.

There are no typed arrays on the walker side. There are on the grid side: wear, tier, the
nav grid and footprints are all typed.

### 2.2 Work per tick, by kind

| kind | where | cost | scaling |
|---|---|---|---|
| per walker, per tick | `stepPeople` loop: `decayNeeds`, `move`, `enterCell`, `reanchorOnDeck`, `dwell` | 0.57–0.90 µs | O(n) |
| per walker, per tick | `crowdIndex` (seat set, standing hash, kin lists) + `rebuildDensity` | in the above | O(n) |
| per walker, per frame | `render-view syncPeople` (rev compare, `refreshStale` n/60) | 13–15 ms at 48–70k | O(n) |
| per waypoint passed | `setVelocity` → `rev++` → row rewrite, `writeRow` (`walkerY`, `crossesDeck`) | **22–25 % of rows every tick** | O(n) |
| per trip | `chooseTask` (6 targets, each scanning buildings of a type), `startTask`, `planGathering` | ~40 µs | O(trips × buildings): O(n²) when buildings grow with n |
| per trip | A* in the planner (`searchJob`, corridor, components) | 0.26–0.34 ms | O(trips) |
| per trip | delivery: `alongDecks` → `laneOffset` → `roundRoute` → `skirtOutlines` | 0.13–0.16 ms | O(trips) |
| per arrival | `takeSpot` → `findSpot`/`ringSpot`/`occasionSpot`, `relaxGoal` → `alternativeTarget` → `hasRoom` | 10–30 µs, more in full crowds | O(local crowd) per arrival |
| per footprint change | `checkFootprints`: every walker's cell, outline, `routeStillClear`, `reskirt` | 18 ms at 5k, 169 ms at 97k (p50) | O(n) per change, O(n²) per game year |
| per month | `syncIndividuals`, `assignBuilders` (linear nearest plus `splice` per slot) | ~12 ms at 48k | O(projects × slots × n) |

### 2.3 Measured scaling curve

**Frozen town** (`walker-only`): the walker loop, routes and deliveries, with nothing else
changing. CPU ms per tick:

| walkers | `stepPeople` | per walker | deliveries | A* (nav worker in play) | trips per tick | one footprint change, p50 (mean) | heap |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4,834 | 3.5 | 0.73 µs | 2.2 | 4.8 | 14 | 18 (39) ms | 63 MB |
| 9,668 | 5.5 | 0.57 µs | 3.7 | 7.4 | 28 | 22 (43) ms | 95 MB |
| 19,336 | 17.4 | 0.90 µs | 10.4 | 18.4 | 57 | 48 (109) ms | 136 MB |
| 48,340 | 31.0 | 0.64 µs | 19.0 | 36.3 | 139 | 80 (203) ms | 221 MB |
| 96,680 | 67.2 | 0.70 µs | 39.8 | 80.0 | 274 | 169 (424) ms; p95 1.4 s | 452 MB |

Trips per tick are 2.8–2.9 per 1,000 walkers: each walker sets out about every 35 sim
seconds (7 game months).

**Full sim** (`crowd-bench`): every tick's jobs, building churn included. CPU ms per tick,
mean / p50 / p95 / max:

| walkers (window) | `stepTick` | deliveries | A* | `view.sync` | mirror delta | rows per step | bytes per step |
|---:|---|---:|---:|---:|---:|---:|---:|
| 5.0k | 5.6 / 3.6 / 17 / 43 | 2.4 | 6.1 | 1.1 | 0.9 | 5.0k | 0.42 MB |
| 8.7k | 12.8 / 7.3 / 39 / 90 | 6.9 | 18.1 | 2.2 | 1.1 | 8.7k | 0.73 MB |
| 15.8k | 41 / 31 / 121 / 242 | 14.1 | 38.0 | 6.6 | 1.8 | 15.8k | 1.34 MB |
| 34k | 52 / 41 / 124 / 985 | 22.4 | 55.3 | 8.7 | 2.1 | 34k | 2.9 MB |
| 48.7k (profile run) | 98 / 51 / 356 / 609 | 54.7 | 111 | 14.7 | 3.1 | 48.7k | 4.1 MB |
| 69.6k | 77 / 48 / 187 / 2,039 | 41.1 | 84.0 | 13.4 | 3.7 | 69.6k | 5.9 MB |

The full-sim rows are noisier than the frozen ones. The scaled towns are in a building
boom, as evicted households get new homes, and every building placed costs a
`checkFootprints` pass over all walkers. That is the 1–2 s maximum. Where the time goes,
from the CPU profiles (inclusive share of the whole run):

| | 4.8k | 48k |
|---|---:|---:|
| A* (`searchJob` + corridor + components) | 24 % | 28 % |
| delivery (`setRoute`) | 15 % | 19 % |
| `stepPeople` | 22 % | 27 % |
| of which `checkFootprints` | 4.7 % | 10.7 % |
| of which `move` (with `enterCell`, `reanchorOnDeck`) | 7.1 % | 8.1 % |
| `view.sync` + mirror delta | 9 % | 5 % |
| nav grid rebuilds (`navGrid`) | 7.8 % | 2.0 % |
| garbage collector | 4.0 % | 7.6 % |

**What that means for play on an M5 Pro.** At 5k the sim worker needs about 8 ms a tick
(p95 about 20 ms), so 10× is comfortable and 20× is marginal, as it was at dawn before.
At 97k it needs more than 107 ms a tick even in a frozen town, so it sustains under 2×.
`stepTick`'s budget then runs the town slower than the chosen speed rather than stall
(`MAX_CARRY_SECONDS`). On a phone (estimated), today's 5k is already a 3× town, and
50k or more is not playable.

### 2.4 Route planning

- **One search.** The nav grid is 384 × 384 cells of 2 units, 140,499 of them open.
  - In-game trips expand 440–620 nodes, about 0.26–0.34 ms of CPU each.
  - Random walker-to-door pairs expand 1,555 on average (p95 5,746, max 13.7k), with a
    mean of 1.2 ms and a p95 of 3.9 ms.
  - A full-grid flow field (Dijkstra, `flowFieldJob`) takes 76 ms.
- **Requests grow linearly**, at 14, 28, 57, 139 and 274 a tick. At 20× and 100k that is
  about 27,000 routes a second, or about 8 s of A* per second. No number of workers fixes
  that.
- **The cache barely hits.** The planner's cache served 2.4 % of requests at 5k and
  1.4 % at 70k.
  - Requests that join an identical search already in flight (the scheduler merges them
    by key) took another 11 % at 5k and 40 % at 70k: the denser town sends many walkers
    from the same door to the same goal at once.
  - A* therefore ran for 89 % of requests at 5k and 59 % at 70k.
  - Replaying the 5k request stream through an LRU that is never cleared hits **53 %**:
    `distinct (start, goal)` was 11.8k of 25.8k requests.

  The difference is invalidation:
  `route-planner.sync` clears the cache whenever the nav grid's key changes in anything
  but footprints, which happens every `VERSION_BUCKET` (16) road versions and at least
  every `NAV_MONTHS` (2) game months, which is 100 ticks.
- **Goals are concentrated.** The top 16 goal cells take 53 % of requests, the top 64
  take 68 %, and the top 256 take 83 %. The scheduler already has flow fields
  (`fieldThreshold` 16, `maxFields` 12), but `setGrid` drops them on every grid change.
  They served 17 of 21k requests at 5k and 895 of 385k at 70k.
- **Cold start.** In the browser, loading the scaled saves left most walkers waiting for
  a first route after about 30 s: 36k of 44k, and 80k of 89k. Only 6–7k were ever moving.
  The planner admits 1,024 pending requests and a rejected walker retries after
  `ROUTE_RETRY`. A 100k town needs about 30 s of A* and about 15 s of delivery before
  everyone has set off.

### 2.5 The bridge to the main thread

- **Rows.** `render-view` writes 20-float rows (80 bytes, plus a 4-byte id) and keeps a
  dirty **range**, `{start, end}`. A row is rewritten when its walker's `rev` changes:
  - at every waypoint (`setVelocity`);
  - at every speed change at a cell boundary;
  - every `DECK_STEP` on a bridge;
  - on arrive, finish and halt;
  - when the renderer's waypoint time passes;
  - by `refreshStale` (n/60 rows a frame, so every moving row at least every 2 s).
- **Churn.** 22–25 % of rows change every tick. Since they are scattered, the range is
  always the whole buffer. Every step therefore posts **84 bytes per walker**: 0.42 MB at
  5k, 4.1 MB at 49k and 8.4 MB at 100k. Each is sliced in the worker, transferred, then
  `view.people.set` on the main thread (0.14 ms at 100k: memcpy is not the problem).
- **Main-thread cost per frame.** `render/people.js markFades` walks every dirty row
  (`atan2`, `hypot`, the heading ease, the angler's line):
  - 0.3 ms at 5k, 3.4 ms at 50k and 6.5 ms at 100k on the M5 Pro (microbenchmark, all
    rows dirty);
  - an estimated 10–25 ms on a phone at 100k.
  - The upload is `bufferSubData` of the same range, 8 MB a frame at 100k.
- **Sim-side cost.** `view.sync` costs 13–15 ms a tick at 48–70k. Most of that is
  `writeRow` (`walkerY`, `crossesDeck` sampling every unit) for the quarter of rows that
  changed, plus the O(n) rev comparison.

### 2.6 Drawing

`src/render/people.js` draws:
- one instanced mesh of 112 triangles (336 vertices, not indexed);
- a blob quad (27 vertices, 32 triangles) twice: once into the shadow surface
  (`BLOB_COVER`), and once on screen (`BLOB_APPLY`, which draws only waders' ripples; every
  other walker's quad collapses to a point).

There are **390 vertex shader invocations per walker per frame**, plus 336 more for the
depth pass when people shadows are 'full'.

- **No culling.** `frustumCulled = false`, and every instance is drawn every frame.
  - Beyond `uLodFar` (300 on High) the vertex shader returns early, but it still runs for
    all 336 vertices.
  - Inside `uLodNear` (140) **each vertex recomputes the whole pose**: the drape, two foot
    ground reads (`groundRel`), the leg IK (`acos`, `atan`), arm aims and up to eight
    deck tests. That is per-instance work done 336 times over.
- **Measured** (M5 Pro, High, DPR 1.75; people drawn vs hidden, ms per frame):

  | walkers | overview: on / off / **people** | close (distance 60): on / off / **people** | triangles added |
  |---:|---|---|---:|
  | 5.1k | 17.6 / 15.1 / **2.5** | 11.9 / 9.6 / **2.4** | 0.47 M |
  | 17.2k | 15.4 / 11.5 / **3.9** | — | 2.6 M |
  | 44.0k | 23.7 / 11.5 / **12.2** | 19.2 / 7.1 / **12.2** | 7.7 M |
  | 89.3k | 31.2 / 10.2 / **21.0** | 26.5 / 7.3 / **19.2** | 15.7 M |

  The cost is the same from the overview and from close up, where only a few hundred
  walkers are on screen. People are **vertex-bound and pay for every walker in the
  town**: about 0.24 µs each. Fragments are cheap: the figures are small, and the blob
  cover pass only shades its 90–300-unit square.
- **What breaks at 100k.**
  - About 39 M vertex invocations and 15.7 M submitted triangles a frame. On a
    tile-based GPU (Apple, Mali, Adreno) the triangles all go through the binner,
    degenerate or not.
  - 8 MB of instance upload and the `markFades` pass every frame.
  - On a phone the people alone would take an estimated 200–400 ms a frame. Even today's
    5k is an estimated 20–35 ms there, more than the whole frame.
- **Picking** (`pick`) and the selection marker's `rowOf` are O(n) linear scans: about
  1–2 ms at 100k, and only on a click or when the selection changes rows. Not a
  bottleneck.

### 2.7 Behaviour that already shifted with the cap removed

These are not scale costs, but they matter for any tier:
- `WALKER_SCALE` (4) multiplies **every** walker's wear. It was meant for "one visible walk
  stands for many daily trips" when about 2,000 walkers stood for a 7,800-person metro.
  Now that everyone walks, the aggregate groups (`aggregateGroups`, `GROUP_WEAR`) are
  empty and walker wear is 4× per resident. Whether the road network now tiers up faster
  than before is worth checking. Every tier below assumes **one function of wear per real
  trip**, whatever the simulation detail.
- `aggregateCrewScale` (builders) and `crossRiverTies` (unseen commuters) are now no-ops.
  They are the existing statistical layer, and the phone fallback in §4.3 would revive
  them.

## 3. The top three bottlenecks

1. **Trips: A* plus delivery, on two threads.**
   - At 97k this is 80 ms of A* and 40 ms of `setRoute` per tick, which is 64 % of all
     walker CPU in the frozen town.
   - The cache that could halve the A* is cleared at least every 100 ticks. The flow
     fields that could serve two thirds of requests are dropped on every grid change.
   - Delivery reprocesses every route per walker, although walkers share most routes.
2. **GPU: every walker pays a full posed figure plus two blob quads per frame,** seen or
   not. That is 21 ms at 89k on an M5 Pro, the same close up as from the overview, and an
   estimated tenfold on a mid phone.
3. **Per-waypoint row churn and O(n) scans per event.**
   - About 100 waypoints per route means a quarter of rows are rewritten every tick. With
     a range-shaped dirty set the whole buffer crosses the thread boundary every step
     (8.4 MB at 100k), and the main thread's `markFades` walks all of it.
   - Every building change re-checks every walker: 169 ms at 97k, with a p95 of 1.4 s.
     That makes the dawn hitch O(n²) in a growing town.

Memory and saves come next: 4.5 KB of JSON per walker, nearly all route points, so about
450 MB of save at 100k. They are not a frame-rate problem, but they block 100k outright.

## 4. Architecture

### 4.0 Rules for every tier

1. **The camera never changes the simulation.** Simulation LOD may depend on *who the
   walker is and what it is doing*, never on where the player looks. Otherwise the same
   save played twice diverges by camera path, headless runs stop matching the browser, and
   a selected walker behaves differently from an unselected one. "Near" and "far" are
   render concepts only.
2. **One canonical movement model.** A trip is a polyline with a time at each vertex. The
   sim and the renderer evaluate the **same** function, so they cannot disagree, and the
   renderer needs a new row only when the trip changes, not at each corner.
3. **One wear function per real trip.** Whatever the detail tier, a trip deposits the
   same wear on the same cells at the same ticks. Lane spread is part of it, because it is
   what widens paths.
4. **Determinism stays where it is today.**
   - Headless runs with a synchronous planner are pure functions of the save.
   - Browser runs are not reproducible: route and model answers arrive when they arrive.
   - Every stage either keeps towns bit-identical (render-only and exact-index changes) or
     sets a new hash baseline, and says which.
   - **Headless student towns** (`distill-collect`, `town-hash`) run `fastForward` with
     `skipPeople`, so no change in this document affects them, provided the headless
     aggregate path (`aggregateGroups(state, true)`) is left alone.

### 4.1 Tier 1: 10,000 walkers (individual agents, made cheap)

**Design.** Keep the object model and per-tick loop (about 7 ms a tick at 10k). Remove the
per-trip, per-waypoint, per-change and per-unseen-walker waste:
- **Routes outlive grid changes.**
  - A cached cell path stays valid while its cells are passable. Validate it against the
    new grid, as `prune` already does for footprint-only changes, instead of clearing.
  - Keep flow fields for the top goals (the 64 busiest goals take 68 % of requests)
    across grid changes, and refresh them round-robin, one field every few ticks in the
    nav worker.
  - Routes then follow costs that are up to a few months stale. Passability stays exact.
- **Shared delivery.**
  - Cache the centre-line part of `setRoute` per (cell path, footprint generation): deck
    crossings, rounding and skirting.
  - Apply only the walker's own lane per walker, re-checking the few legs the offset moves
    near a wall.
- **A tile index for footprint checks.**
  - Register each walk under the 16-unit tiles its remaining legs touch. The skirt and
    wall memos already compute exactly these tiles.
  - A footprint build visits only the walkers under changed tiles. The answers are the
    same as the memo path, so this is exact.
- **Sparse, stable render rows.**
  - Keep a dirty *list* of rows rather than a range.
  - Keep a row slot per person id inside `render-view`, so `state.people` order (the save's
    tick order) is untouched and swap-removes do not move rows.
  - Post only changed rows, and run `markFades` only on them.
- **Rows carry a short polyline window.** The next 4 waypoints and their times go in the
  row, and the shader walks them. A row then renews every 4 corners instead of every one,
  which cuts churn to about 6 % of rows a tick.
- **Culled, banded drawing.** In the worker, or on the main thread from the mirrored rows,
  bucket rows by 16-unit tile and compact the visible ones into per-band instance lists:
  - a **near band** of full rigs, capped (about 3,000 on desktop and 800 on a phone);
  - a **mid band** of 2-triangle impostors (an atlas of 8 headings × a few gait frames,
    tinted by the palette indices);
  - **beyond `uLodFar`**, nothing.

  Blob quads go to the near band only.
- **Smaller saves.** Routes become `Float32Array`s, both in the live state and in the save
  (typed arrays already serialize as base64). That is 4.5 KB → about 1.1 KB per walker.

**Budgets** (estimates from the measured per-item costs):

| | desktop (M5-class) | mid phone (est.) |
|---|---|---|
| sim worker per tick | 5–7 ms: loop 5.5, deliveries 3.7 → ~1.3, footprint changes ~2 | 18–25 ms |
| fastest sustainable speed | 20× | 3–5× |
| nav worker per tick | ~3 ms (7.4 today) | ~10 ms |
| rows crossing per step | ~600 (0.05 MB) | same |
| people GPU per frame | 0.5–1 ms (2.4 today at 10k) | 3–5 ms at Medium |

**Behaviour.**
- **Unchanged:** needs, tasks, decisions, gatherings, leisure, standing spots and wear
  (cells entered per tick).
- **Changed:**
  - routes chosen on slightly stale costs;
  - lane geometry near walls (the shared centre line is offset once rather than planned
    per walker);
  - routes stored as float32.
- **Bit-identity:** sparse rows, culling and LOD, and the footprint tile index keep towns
  bit-identical. The route and save changes set a new baseline for
  `scripts/benchmark-city.js`, and need a save-version migration (float64 routes → float32
  on restore).

### 4.2 Tier 2: 50,000 walkers (analytic trips, struct of arrays, events instead of ticks)

**Design.** Replace the per-tick walker loop with trips that are functions of time:
- **A trip** is a route reference into a shared **route store** (float32 x, z and a
  cumulative time per vertex) plus `t0`, a lane and a speed table.
  - Speed per leg is the ground's tier at planning time, which `groundSpeed` reads today at
    each cell entry.
  - A tier change under a walker mid-trip re-times the rest of that trip as an event,
    which is rare.
  - Position at any tick is a binary search over the time table, so it is exact and
    cheap, and the GPU evaluates the same table from a route atlas texture.
- **An event calendar** (a bucketed queue by tick) replaces stepping:
  - cell entries, which deposit wear and move density counts (8-unit blocks), at their
    exact entry tick;
  - corners only where something happens: a speed change, a deck, an arrival;
  - dwell ends, wander hops, need thresholds.

  **Needs are linear in time** (`NEED_DECAY` and the dwell gains), so they are stored as
  (value, t, rate) and read in closed form. A tick costs O(events), not O(walkers):
  at 50k about 140 trip starts, 140 arrivals and about 7,000 cell entries a tick.
- **The struct-of-arrays store.**
  - Walker scalars go in typed arrays in the worker: ids, household, home, work, needs
    triples, action and time, flags, current trip. That is about 64 bytes a walker.
  - Tasks live in a typed task pool. Routes are in the store with reference counts.
  - The heap falls from about 5 KB to about 0.5 KB per walker, the GC share (7.6 % at 48k)
    all but goes, and a save writes the arrays as base64 (about 10 MB at 100k, plus the
    route store).
  - This is where struct-of-arrays pays, unlike the town-growth case in
    `docs/design/data-locality.md`: the walker set is the only collection that reaches
    10⁵.
- **The crowd model** becomes capacity counters with deterministic slot geometry:
  - Each ring, occasion layout and lawn keeps an occupancy count. A walker that arrives
    takes the next free slot by rank, the same `ringSpots` order, which keeps
    front-first-then-wrap-round.
  - The standing hash and kin lists update on arrive and leave events instead of being
    rebuilt each tick.
- **Routing.**
  - Flow fields for the busiest goals and a cache that survives grid changes (tier 1).
  - A* hierarchical over the path-node graph (`path-nodes.js`) for long trips.
  - 2–4 nav workers (`navigator.hardwareConcurrency`).
- **The bridge.** Only trip starts, ends and action changes cross: about 300 a tick at 50k,
  of 32 bytes each, plus new route-store entries. That is 20–60 KB a step, against
  2.9–4.1 MB today. `SharedArrayBuffer` is not needed at this size, and would need
  COOP/COEP headers that `cloudflare/worker.js` does not set today.

**Budgets:**

| | desktop | mid phone (est.) |
|---|---|---|
| sim worker per tick | 15–20 ms: 140 decisions × ~40 µs, 140 shared deliveries × ~50 µs, ~7k cell events × ~0.2 µs, arrivals | 55–70 ms |
| fastest sustainable speed | 5× (3× with headroom) | 1× |
| nav workers per tick | ~15 ms over 2 workers | — |
| main thread per frame | under 0.5 ms (apply plus a few hundred rows) | ~2 ms |
| people GPU per frame | 1–1.5 ms | 4–6 ms at Medium, near band capped |

**Behaviour.**
- **Preserved:**
  - needs, decisions and task logic (the same functions, read at the same ticks);
  - wear per cell entered, at the same tick, with lanes;
  - gatherings and leisure (the same activities and layouts);
  - the decision system's inputs (`decide` still gets the person and household).
- **Changed:**
  - who stands in which slot of a crowd (rank order instead of straight-step
    reachability);
  - float rounding of positions (analytic instead of accumulated `move()` steps), so
    corner and cell-entry ticks can differ by one in rare cases;
  - a new save version with a migration: an object walker mid-route becomes a trip from
    where it stands along the rest of its route.

  Play towns get a new hash baseline. Headless student towns are untouched.

### 4.3 Tier 3: 100,000 walkers and more

**Design.** Tier 2, plus parallelism and GPU-driven drawing:
- **Delivery moves into the nav workers.** Route post-processing is a pure function of the
  grid, the footprints and outlines, and the decks. Send the nav workers a footprint and
  outline snapshot (they already get the grid) and let them return finished
  polylines-with-times. That takes about 40 % off the sim worker.
- **Decisions are batched** per tick, for the decision system. 300 decisions a tick is
  30,000 a second at 20×, which is the stated assumption.
- **Drawing driven by the GPU.**
  - A per-instance pose pass: in WebGL2, render-to-texture with one texel row of bone
    angles per near-band instance; in WebGPU, compute. Vertex shaders then only skin, so
    the IK runs once per walker rather than 336 times.
  - Indirect or compacted draws per band.
  - Beyond the impostor band, a **crowd density splat**: the 2-unit density grid drawn as
    dithered dots on the ground, at a fixed cost whatever the count.
- **The phone path: a device-scaled individual cap.** A mid phone cannot run 100k
  per-resident decisions and routes beyond 1×, nor hold 100k of trip state comfortably
  next to the renderer. Above a device budget (about 15–20k walkers on a phone), the rest
  revert to the aggregate layer the game already had: `aggregateGroups` with `GROUP_WEAR`,
  `crossRiverTies` and `aggregateCrewScale`. Wear is normalised per real trip (rule 3).
  - A phone's town is then statistically the same as a desktop's, not identical. That is
    the same standing as browser runs today, which are not reproducible either.
  - Saves keep every resident's identity in households. `syncIndividuals` already promotes
    and demotes on load.

**Budgets:**

| | desktop | mid phone (est.) |
|---|---|---|
| sim worker per tick | 25–35 ms (delivery off-thread) | — (capped at about 15–20k individuals: about 25 ms) |
| fastest sustainable speed | 3–5× | 3× at the cap |
| nav workers per tick | 30–45 ms over 3 workers, delivery included | — |
| bridge | 40–120 KB a step | — |
| people GPU per frame | 1.5–2 ms (fixed near band, impostors at ~0.01 µs each, the splat) | 4–6 ms |
| heap | about 60 MB walkers plus the route store | — |

**What would justify WASM or WebGPU compute.**
- **WASM:** only for the numeric kernels (A*, flow fields, the event calendar's
  cell-entry pass), and only if they still dominate after sharing. The expected gain is
  1.5–3×. Delivery is geometry against object-shaped outlines, and porting it would
  touch most of `roads.js`.
- **WebGPU:** the renderer is three.js WebGL with many GLSL patches (`patchMaterial`), so a
  move to `WebGPURenderer` is a large project of its own. The WebGL2 route (CPU
  compaction, a render-to-texture pose pass) reaches the tier 3 targets. WebGPU compute
  becomes worth it past about 200k, or to move the event calendar onto the GPU, which
  would also put wear on the GPU and needs read-back for the sim. Not recommended.

## 5. Staged plan, by gain over effort

Effort sizes: **S** is up to 2 days, **M** up to a week, **L** 2–4 weeks and **XL** more
than a month. "Exact" means towns stay bit-identical; otherwise the change sets a new
`benchmark-city` baseline.

| # | change | tier | gain | effort | exact? |
|---:|---|---|---|---|---|
| 1 | Sparse dirty-row list plus a stable row slot per id in `render-view` and the mirror; `markFades` over changed rows only | 1 | bytes per step 8.4 MB → about 2 MB at 100k (only the 25 % that change); main thread −4×; upload −4× | S | yes (render only) |
| 2 | Tile index for `checkFootprints` (walk → tiles, from the existing memos) | 1 | footprint tick 169 ms → a few ms at 97k; the dawn hitch stops growing with n | M | yes |
| 3 | Route cache validated, not cleared, on grid changes; flow fields kept and refreshed round-robin | 1 | A* calls −50 % (measured LRU ceiling 53 %) to −70 % (the top 64 goals take 68 % of requests); nav worker 80 → ~25–40 ms per tick at 97k | S–M | no |
| 4 | Culled, banded drawing: tile-bucketed compaction, a capped near band, 2-triangle impostors, blobs for the near band only | 1 | people GPU 21 → ~2–3 ms at 89k (estimate); phones become possible | M | yes (render only) |
| 5 | Shared centre-line delivery, lane applied per walker | 1 | deliveries −50–70 % (40 → ~15 ms per tick at 97k) | M | no |
| 6 | Spatial indexes for `nearestOf`, `assignBuilders` and kin lists (same tie-breaks) | 1 | removes the O(trips × buildings) and O(slots × n) terms | S | yes |
| 7 | `Float32Array` routes in the state and the save | 1 | save 4.5 → ~1.1 KB per walker; heap −40 % | S | no (new save version) |
| 8 | Rows carry the next 4 waypoints and times; the shader walks them | 1 | row churn 25 % → ~6 % a tick; `writeRow` −4× | M | yes (render only) |
| 9 | Cold start: admit route requests by priority (on screen, then by id) and raise `maxPending`; first trips staggered by hash | 1 | a 100k load walks within seconds instead of ~30 s | S | no |
| 10 | Analytic trips: a route store with time tables, a route atlas in the shader, rows only per trip | 2 | bridge −50×; `writeRow` and `refreshStale` go; position is exact anywhere | L | no |
| 11 | An event calendar instead of the per-tick loop (cell entries, arrivals, dwell ends, closed-form needs) | 2 | walker loop 67 → ~5–10 ms per tick at 97k | L | no |
| 12 | Struct-of-arrays walker store, a task pool, a reference-counted route store, save v3 with a migration | 2 | heap ~5 → ~0.5 KB per walker; GC share → ~0; 100k saves in about 1 s | L | no |
| 13 | Crowd capacity counters with ranked slots; incremental standing hash and kin lists | 2 | arrivals O(1); `crowdIndex` per tick goes | M–L | no |
| 14 | 2–4 nav workers; hierarchical A* over path nodes for long trips | 2 | nav throughput ×2–4 | M | no (different paths) |
| 15 | Delivery in the nav workers (a footprint and outline snapshot there) | 3 | sim worker −40 % | L | no |
| 16 | Per-instance pose pass (render-to-texture), indirect band draws, a density splat beyond far | 3 | near-band vertex ALU −10× or more; constant far cost | L | yes (render only) |
| 17 | Device-scaled individual cap over the aggregate layer, with wear normalised per real trip | 3 | phones at 100k-resident towns | M | no (phone towns differ) |
| 18 | WASM kernels (A*, flow fields, the cell-entry pass), if still dominant | 3 | 1.5–3× on those kernels | L | must be (same arithmetic) |

**Suggested order.**
1. Items 1, 2, 6 and 4. They are exact and reach about 10k on desktop at 20×. Check them
   with `tests/render-mirror.test.js`, `tests/perf-equivalence.test.js` and the
   `benchmark-city` hash.
2. Items 3, 5, 7, 8 and 9. They are one baseline change, together; with them tier 1 is
   done, and phones manage 10k.
3. Items 10–14. These are tier 2, a rewrite of `people.js` movement and of the
   render-view walker contract (`docs/design/contract.md` §6). Prototype the analytic
   trip and the event calendar behind the existing `stepPeople` interface first, and
   compare wear grids and arrival ticks against the stepped model over a game year.
4. Items 15–18, only if 100k is a target on desktop, or on phones beyond the cap.

## 6. Keeping the game's behaviour

- **Needs and tasks.** These are the same functions in every tier. In tier 2 the needs are
  read in closed form at the ticks where `chooseTask` and `dwell` read them today.
- **Footfall wear driving roads.** Wear is per cell entered, at the tick of entry, with
  lanes (rule 3). Re-tune `WALKER_SCALE` now that every resident walks (§2.7). Check the
  monthly road passes (`decayAndRetier`, `consolidateWear`) on a year's wear grid,
  comparing stepped against analytic walkers, before switching.
- **Gatherings and leisure.** Activities, layouts and wander hops are kept. Tier 2 changes
  only how a spot is allocated (slot rank) and keeps the layouts' order.
- **Determinism.**
  - The sim stays a pure function of the save and the planner's answers.
  - The camera never enters it (rule 1).
  - Event order within a tick must be fixed: by tick, then person id, then kind. That
    replaces today's array order.
- **Save compatibility.** Each non-exact stage bumps `SAVE_VERSION` with a migration in
  `restore`. Old saves open, and continue deterministically from there, but differently
  from how the old code would have continued.
- **Bit-identical towns.**
  - Headless student towns are untouched by everything here: they skip walkers.
  - For play towns, items 1, 2, 4, 6, 8 and 16 are exact. Check them with
    `scripts/benchmark-city.js` and the walker equivalence tests. Every other item sets a
    new baseline, stated in its commit.

## 7. Open questions

- **Is a denser town representative?** The scaled fixture is a k-times denser town: the
  same routes, fuller crowds. A real 100k town (grown with `scripts/grow-town.js` to a
  larger valley) would have longer routes (more A* per trip) but thinner crowds. Grow one
  before committing to tier 2 budgets.
- **Phone numbers are estimates.** Measure an iPhone and a mid Android on the 10k scaled
  save after items 1 and 4. Both are render-only, so this can be done early.
- **The decision system.** It must answer about 2.9 decisions per 1,000 walkers per tick:
  about 290 a tick at 100k, or 29,000 a second at 20×. That was the brief's assumption,
  and it is worth checking against the student's per-answer cost.
