# Fidelity pass (2026-10-20)

Rendering only; the simulation is untouched. Before/after views: `docs/media/fidelity-before-*.jpg` and `fidelity-after-*.jpg` (`scripts/fidelity-shots.js`).

**What was added, per tier** (named in `src/render/quality.js`):

| | Low | Medium | High |
|---|---|---|---|
| Ground cover (`groundcover.js`): meadow grass in clumps, long grass on neglected land, reeds, bracken; wildflowers only in tended gardens and wildflower meadows | none | grass | grass + flowers |
| Denser woods (`trees.js`): offset second pass, species stands, saplings at the edges, understorey | none | 30 % | all |
| Lived-in yards (`decor.js`): woodpiles, washing lines (in on wet days), vegetable plots by season, barrels and crates, handcarts, hay after harvest | none | yes | yes |
| Weather detail: puddles that mirror the sky, rain rings on water, wind waves over crops | none | yes | yes |
| Valley mist (`mist.js`): dawn, autumn, damp and cold nights, over water and low ground | none | none | yes |

Also fixed on every tier: tree trunks and limbs were wound inside out.

**Cost control.** Everything is instanced and placed on the GPU or in existing batches. New draw calls on High: two ground-cover meshes and one mist mesh. The extra woods trees skip the shadow map; the existing tree-contact decal pass draws them a soft sun-cast shadow instead. They do appear in the river mirror. The trees' road-clearing scan reads precomputed cells and runs at most about three times a second.

**Measured.** `scripts/benchmark-desktop.js` (now with GPU timer queries), High, DPR 2, baseline `6312629` against this branch. Runs alternated, with the order swapped between pairs. Medians are shown. The machine was heavily shared during these runs (load average 7 to 14), so treat them as rough.

| | frame CPU p95 | GPU mean | GPU p95 |
|---|---:|---:|---:|
| city fixture, 1×, close pan, before → after | 10.6 → 11.1 ms | 5.69 → 6.29 ms | 6.81 → 8.07 ms |
| year-165 town, 5×, overview, before → after | 42.2 → 46.9 ms | 6.94 → 8.88 ms | 11.6 → 11.2 ms |

- On the city fixture GPU time rose by about 10 % and frame CPU p95 by about 5 %.
- On the year-165 town, GPU time rose by about 13 % in an earlier, quieter set of five pairs (6.15 → 6.96 ms). That set was run before the extra woods trees went back into the river mirror. The last set, run under heavier load, shows +28 %.
- Low draws the same draw calls and triangle counts as before (for example, 53 calls and 770,448 triangles in the town view). It adds no passes. Its only shader change is a branch on a uniform that stays off.

---

# Release tuning pass (2026-10-20)

Baseline: `fd6e048`. Raw numbers: `benchmarks/release-tuning.json`.

**Result.** In a late-game town, the main thread's worst frames came from the simulation, not the renderer. Walkers' routes were re-checked against every building outline each time any building changed. In a year-165 town that happened about every 7 ticks and cost about 46 ms each time. That check now gives exactly the same answers for a fraction of the work. In the browser at 5× on that town, frame CPU p95 fell from about 50 ms to about 20 ms, and the animation-frame p95 fell from 33–50 ms to 16.8 ms, so frames stopped dropping at p95. **Simulation output is unchanged.** The serialized state after 30 s at 5× hashes identically before and after on both test towns, in every run.

## How it was measured

- **Machine.** Apple M5 Pro (ANGLE Metal), macOS, Node 24.14, and Chrome headless. Other sessions shared the machine, with a load average of 4–19 during the runs. Absolute numbers move by up to about 35% between sets. **Only compare numbers within one set.**
- **Baseline runs.** The baseline is a `git archive` of `fd6e048` run with the same scripts. Baseline and current runs alternate (A, B, A, B…) so that load hits both sides equally. Medians are taken across runs.
- **Towns.**
  - *metro:* a year-165 town grown headless with `node scripts/grow-town.js OUT.json`. It uses seed 1888 and the city profile pushed on to year 165. It has about 7,800 people, 2,000 walkers and 1,040 buildings. This is the stand-in for the README's year-169 save, which exists only in a player's IndexedDB.
  - *city:* the cached `src/sim/fixtures/city.json` (year 92).
- **Headless benchmark.** `node --expose-gc scripts/benchmark-city.js [--save=FILE] [--root=BASELINE]`. It runs the browser loop's main-thread work (`stepTick` and `view.sync`) per 60 fps frame at 5× for 30 s. Routing runs separately with a large budget, so the run is deterministic. That routing time is not counted, because the browser does it in the worker. The run prints a hash of the final state.
- **Browser benchmark.** `scripts/benchmark-desktop.js --dprs=2 --save=FILE --speed=5`. It forces the High tier, blocks the decision model, warms up for 8 s and samples for 16 s.

## Before and after

**Headless, metro, 5×.** Per frame, in ms. Median of 3 alternating runs each.

| | sim mean | sim p95 | sim p99 | sim max | view sync mean | sync p95 |
|---|---:|---:|---:|---:|---:|---:|
| before | 5.48 | 58.0 | 91.2 | 132 | 0.99 | 2.58 |
| after | 2.71 | 17.1 | 29.1 | 47.7 | 0.49 | 1.21 |

**Headless, city (year 92), 5×.**

| | sim mean | sim p95 | sim p99 | sim max | sync mean |
|---|---:|---:|---:|---:|---:|
| before | 2.46 | 7.5 | 40.8 | 52.2 | 0.54 |
| after | 1.40 | 7.5 | 16.1 | 30.9 | 0.36 |

An earlier metro set, run under heavier load, gave 7.36 → 3.94 mean and 56.7 → 23.2 p95. The ratios match.

**Browser, metro, 5×, overview camera, High, DPR 2.** Values are in ms, two runs each.

| | frame CPU mean | frame CPU p95 | frame CPU max | rAF p95 | rAF max | world CPU mean |
|---|---:|---:|---:|---:|---:|---:|
| before | 9.29 / 9.29 | 48.8 / 50.7 | 142 / 149 | 33.4 / 49.9 | 150 / 167 | 3.00 / 3.00 |
| after | 6.39 / 6.87 | 18.9 / 20.6 | 47 / 47 | 16.8 / 16.8 | 50 / 33 | 2.98 / 3.22 |

**Browser, metro, 1×, close camera with a slow pan.**

| | frame CPU mean | frame CPU p95 | frame CPU max | rAF max |
|---|---:|---:|---:|---:|
| before | 3.03 / 3.02 | 8.3 / 9.0 | 68 / 74 | 67 / 67 |
| after | 2.52 / 2.37 | 7.8 / 7.5 | 63 / 60 | 50 / 50 |

Rendering CPU ("world CPU") did not change: it was never the bottleneck on this machine. Draw calls (65–153) and triangles (1.6–3.3 M) vary between runs with what is in view, not with these changes.

## Changes

Single sequential runs on the metro, so each step is only indicative: headless sim p95 went 49.7 → 37.5 → 34.3 → 15.2 ms across items 1–3, all with the same hash.

1. **Skirt sampling** (`src/sim/roads.js`). A leg's samples in a cell with no outline pieces near it are skipped as a run. The run is computed with a one-sample and 1e-6 margin, so rounding can never cross a cell edge. A waypoint's two water checks run only once a piece is actually within reach.
2. **Tight piece lists** (`nearIn`). Near lists are stamped from bounding boxes grown by the wall reach. Instrumented, the metro tested 90 M piece/sample pairs for 12 k hits. Each cell's list is now filtered once per footprint build to the pieces that reach the cell, using a separating-axis test with a small tolerance. Every outline test reads the shorter list. A test compares `outlineClear` with a brute-force check over every piece at 20,000 points.
3. **Skirt memo** (`skirtMemo` / `skirtStillClear`, used by `people.js reskirt`). After a walk has been checked once with no waypoint near any piece, the memo records which 16-unit tiles its legs sample. Each footprint build stamps the tiles whose near lists changed. While none of a walk's tiles have changed, only the leg from where the walker now stands is checked, and the result is provably the same as checking the whole walk. Memos live in a `WeakMap`, are never saved, and a restored town does the full check once. A test removes buildings beside walks and checks that every memo that still holds agrees with the full check.
4. **Cheaper repeated lookups.**
   - `terrainKey()` is memoised. It used to build a new string on every call, and it is asked for per cell.
   - The nav grid rebuild looks up the roads and terrain grid once per build instead of per cell.
   - `embankmentCrossings` caches bank cells per valley, lists quays once, and calls `riverX` only when needed. Render-view sync runs it on every road change.
5. **Auto quality** (`src/render/quality.js`).
   - The tuner used to decide once, after 3 s, and never again. It now settles again after each step down, so a slow machine reaches Low within about 7 s.
   - After settling, it keeps watching in 5 s windows. Two windows in a row with a median over 25 ms (under 40 fps) step it down one tier, which covers a town that grows slow. It never steps back up on its own, so it can't oscillate.
   - The first guess reads the GPU name. Software renderers (SwiftShader, llvmpipe) start on Low. Integrated GPUs (Intel, Ryzen "Radeon(TM) Graphics"/Vega, Mali, Adreno, PowerVR) start on Medium. Everything else starts on High, as before.
   - The tier contents themselves are unchanged. Medium already drops SSAO, post, reflections and soft shadows; Low also caps DPR at 1.25 and uses 1024 shadows.
6. **Shader pre-compile** (`src/render/index.js`).
   - The first drawn frame now waits (up to 4 s) for `compileAsync`, which compiles in parallel where the browser supports `KHR_parallel_shader_compile`. Before, the first frame compiled every program synchronously. Later rebuilds still compile in the background.
   - Production build, 7 runs each, medians:

     | | fresh town: first frame | longest task | city fixture: first frame | sum of long tasks |
     |---|---:|---:|---:|---:|
     | before | 737 ms | 258 ms | 959 ms | 783 ms |
     | after | 777 ms | 287 ms | 940 ms | 704 ms |

   - **This is within noise on this Mac**, where compiles are fast. Fresh runs are bimodal at about 600 or 1,300 ms in both builds. The profile shows the first frame's `getUniforms` (synchronous program link) dropping from about 207 ms to about 54 ms. The win should show on GPUs with slow compiles (ANGLE/D3D11 on Windows); it was not measured there.
7. **Decision client** (`src/decision-client.js`). In Auto pacing the send log was never pruned (only the Manual ceiling read it), so it grew by one entry per request for the whole session. The send and completion logs are now trimmed when appended to. Behaviour is unchanged.

## Memory and long sessions

- **Headless, metro, three game-years at 5×**, with a forced GC every quarter. The heap levels off at 43–45 MB after warm-up. The roughly 24 MB growth in the first 30 s is caches filling, not a leak.
- **Browser soak, metro, 5×, 180 s (about 7.5 game-years).**
  - Three.js geometries went 69 → 75 (they follow town content), textures 15 → 15 and programs 64 → 64.
  - The JS heap after a forced GC went 180 → 173 MB.
  - rAF p95 was 16.8 ms over 10,578 frames.
- No listener, geometry or texture leak was found.

## Build

`npm run build` is clean. JS is about 1.7 MB raw, about 600 KB gzip: three is 494 KB / 125 KB gzip, the sim 293 + 318 KB, and the UI entry 243 KB. Chunking and minification are unchanged: three and controls are already split out, and the sim, renderer and narrator load as parallel dynamic imports. The cached town and city fixtures (7 MB) are emitted into `dist/` but only fetched with `?fixture=`.

## Remaining hotspots (found, not fixed)

1. **Route delivery on the main thread.** `people.js setRoute` runs `alongDecks`, `pushOpen` and `legOpen`, and `legOpen` samples every leg every 0.25 units with `waterAt` and outline tests. It is now the largest remaining sim cost in a metro, about a fifth of profiled main-thread sim time. Routes from the planner's cache are shared, so per-leg results could be shared across walkers.
2. **Nav grid rebuild cadence.** In the metro at 5×, the browser's walker grid rebuilds about 9 times a second (`VERSION_BUCKET` 16 and `NAV_MONTHS` 2). Each rebuild takes 5–8 ms on the main thread, and about 2.5 MB is structured-cloned to the worker each time. Possible fixes are patching only changed cells, or building in the worker. Changing the cadence changes walker routes, so it is a design call.
3. **Render "roads" stage.** Path-field `capsule` and `scan` cost 1.6–1.7 ms per drawn frame while a city keeps wearing new paths. This is the largest renderer CPU item; it was already budgeted in `fd6e048`.
4. **Startup.**
   - A new town spends about 140 ms in `terrainGrid` (147 k height/water samples), and `createGround` and `createTerrain` sample heights again (about 150 ms).
   - Fixture loads restore the save twice (`usable()`, about 80 ms). This is dev only.
   - The sim and renderer chunks are only requested after the 243 KB entry chunk runs. Modulepreload hints would need `index.html` or the boot code, which the main-menu work owns.
5. **Weak GPUs are unmeasured.** All GPU numbers come from an M5 Pro. The new first guess and continuous downgrade are the safety net. Check them on an Intel or AMD integrated laptop and on a phone. HANDOFF already notes that iPhone is untested.
6. **Pre-existing test failures on `fd6e048`, unchanged by this pass.**
   - `paths.test.js`: "a T-junction…" and "a towpath follows the bank…".
   - `foundations.test.js`: "drawn walkers never pass through a plinth… hill town".
   - `walkers.test.js`: "no walker inside a footprint over 3,000 ticks". This test drives the cooperative planner with a 2 ms wall-clock budget, so its result depends on machine load. On the baseline it found 468 or 6 walkers in the water, and on this branch 0, 7 or 43.
   - `crowds.test.js`: "gatherings still draw a crowd" is flaky on both.

## Tools added

- `scripts/benchmark-city.js`: headless per-frame cost, GC, heap and state hash. `--root` runs it against another checkout.
- `scripts/grow-town.js`: grows a late-game save.
- `scripts/benchmark-startup.js`: production boot and first frame, long tasks and script bytes, with optional CPU profiles.
- `scripts/benchmark-desktop.js`: new `--save`, `--speed`, and GPU-resource and heap readings, so a long `--duration` works as a soak.
- `tests/perf-equivalence.test.js`.

---

> **Historical.** This describes the game before the evolving-city rework (16-question batches, one request in flight, placed buildings). For current numbers and design, see HANDOFF.md.

# Hearthvale performance pass

The game now reuses validated activity distributions, schedules navigation away from input/render work, and batches the town and its residents. The measured 1,000-resident crowd workload renders about three times faster. These results are a local comparison, not a hardware FPS guarantee.

## Measured rendering comparison

Chrome headless on macOS, SwiftShader software rendering, 1164 × 703, device pixel ratio 1, unchanged resolution and camera. Local AI was disabled to isolate simulation/render cost. A fresh browser context loaded the same deterministic crowd fixture for each population. Each run waited 500 ms, then sampled up to 45 animation frames over roughly four seconds. The short sample sizes make these directional measurements rather than a statistical performance guarantee.

| Residents | Median frame before | Median frame after | p95 before | p95 after | Draw calls before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 28 | 166.1 ms | 115.9 ms | 173.5 ms | 124.5 ms | 682 → 161 |
| 250 | 219.9 ms | 153.7 ms | 224.1 ms | 160.1 ms | 2,236 → 161 |
| 1,000 | 417.8 ms | 137.8 ms | 424.8 ms | 157.5 ms | 7,486 → 154 |

At 1,000 residents, median frame time fell 67%; draw calls fell 98%. A programmatic pause handler followed by the next animation frame took 508.7 ms before and 138.4 ms after. This measures handler-to-next-frame turnaround, not complete physical input latency. The final worker diagnostics reported all 1,000 initial route requests completed and no pending callbacks.

The fixture deliberately puts extra residents into the original town, exceeding ordinary housing capacity. It isolates resident load rather than simulating a mature economy or sprawling map. At this zoom, all 1,000 figures used simplified animated silhouettes; the 28- and 250-resident runs retained detailed figures. Near residents and active builders retain the detailed model. Software rendering remains slow in absolute terms; large cities, many simultaneous construction sites, and other GPU/browser combinations need further profiling.

## Adaptive model policy

- **Automatic measured-throughput pacing** replaces the original fixed 100-question/sec limit. One network batch runs at a time, with at most 16 questions (also enforced by the server). Batch size targets about 250 ms from an exponential moving average of end-to-end milliseconds/question, halved under >25 ms frame work. Idle time is response duration × (1 − utilization) / utilization, default utilization 80%. The first estimate is 40 ms/question; measured responses replace it gradually. Network admission is checked each animation frame independently of the 100 ms cohort-sampling timer. Rendering cadence, actual demand and cohort coverage can keep achieved throughput below estimated capacity. Manual mode adds a rolling 1–2000 question/real-second ceiling; it never promises that throughput. Cohort identity is independent of the budget.
- Villages of at most 100 residents use individual context keys. Larger villages share by needs bands, savings band, bank/district, routine phase, food/wellbeing pressure, tax and accessible activities. This is approximate context sharing, not proof that all villagers have identical preferences.
- The adapter now retains the service's observed `probabilities` map. Valid high-entropy answers can be used even when the winning activity has confidence below 0.45. Invalid mass, unknown activities and malformed maps are rejected. Legacy winner-only replies remain individual and are never invented into a shared distribution.
- Each resident samples independently and deterministically from the compatible distribution, masking unavailable activities. Builders bypass routine decisions; critical hunger/energy needs use the appropriate available local action. Assignments are stable within a day/context, rather than rerolling on every render frame.
- Unknown/stale contexts receive coverage first. Large uncertain cohorts refresh sooner, using entropy and observed changes between returned distributions. Repeated queries do not establish a claim of improved model accuracy.
- The cache holds at most 512 distributions, valid for at most 12 real seconds and two game days. Changed constraints create a new key. Stale replies and replies from before disabling/resetting the policy cannot apply. Network failures back off while local rules continue.
- Settings shows session model-question and sample counts, context count and coverage. Read-only `window.hearthvale.view()` exposes frame work, navigation mode/queue/cache counts and render batches; `routineStatus()` exposes policy counters. The API key stays on the local Node server.

A deterministic test served 1,000 compatible residents from one returned distribution, producing all four activity choices with separate resident samples. A browser scenario also exercises shared sampling and the request ceiling with a mocked probability response; a separate browser case verifies live local-service application.

## Navigation and simulation work

The synchronous reference benchmark's first step took 174.81 ms for 28 residents, 1,257.50 ms for 250, and 5,044.47 ms for 1,000. Those bursts initialized all routes on the calling thread.

Browser route searches now run in a dedicated worker. A* yields every 32 expansions; worker work is sliced, the main thread admits at most 128 pending callbacks, and route requests coalesce/reuse up to 256 cached paths. Topology changes invalidate cached paths. Results apply only to the still-current actor task. A failed/unavailable worker uses cooperative 2 ms planning slices on the main thread.

An 80-step cooperative fallback run at 1,000 residents had a 1.79 ms first step and a 3.91 ms maximum step. **Work was deferred:** 128 callbacks were still pending at the end of that short CPU run. This demonstrates bounded interactive steps, not an equivalent-work throughput speedup. A separate fallback regression runs the queue until residents move and checks collision safety.

Building/type lookups, household property values and daily counts are indexed/cached by spatial revision. Builder assignment avoids sorting the whole population and repeated resident scans. Pending navigation tasks are safely replanned on save/reload.

## Rendering changes

Detailed villagers share eight instance batches. Tiny crowd figures use a separate animated silhouette batch with hysteresis around the detail threshold. Frustum checks omit off-screen figures. Instance buffers grow geometrically and upload only the used range.

Static building/road surfaces merge by material, shadow mode and 100-unit region. Source geometry remains available for accurate picking. Windmills, smoke, fountains, windows, construction animations and overlays remain active. Static shadow maps are reused; construction shadows refresh at a bounded cadence. These changes do not reduce canvas resolution.

## Reproduce and inspect

Start `npm run dev -- --strictPort` in a terminal with access to the local decision service. Then:

```sh
npm test
npm run build
npx playwright test
node scripts/benchmark-simulation.js
node scripts/benchmark-simulation.js --budgeted
BENCH_LABEL=repeat node scripts/benchmark-browser.js
```

The browser benchmark uses local Chrome (or `CHROME_PATH`) with SwiftShader. It writes its JSON and screenshots to `/tmp`; the simulation benchmark prints JSON. Benchmark fixtures use isolated browser contexts and never replace the user's actual saved town. `scripts/load-fixture.js` documents the dense-crowd fixture. Absolute timing varies with hardware and concurrent load.

Validation: 43 Node tests and the production build pass. All ten Chrome scenarios passed across the complete suite and targeted reruns, including the 1,000-resident mocked-cohort case, real local-service application, and navigation with workers disabled. Raw measured JSON is saved in `benchmarks/`.

## Accelerated simulation correction

A deterministic delayed-route reproduction found that renewing the same work intent on the next game day replaced all 28 pending tasks and doubled route submissions from 28 to 56. Task revision included the intent expiry date. Faster game days amplified unnecessary route cancellation, independently of model throttling or probability sampling.

Routine advice now applies at natural task boundaries. Renewal, changed advice and expiration preserve pending routes and ongoing trips; critical needs and builder assignments can interrupt. Deterministic regression coverage checks repeated renewals and alternating advice across seven days, then expiry and natural task completion. Simulation and route planning continue independently of AI request admission.

Server admission now bounds concurrency instead of enforcing the old arbitrary QPS ceiling. Busy responses carry a 250 ms retry; the client does not turn this into a 15-second outage. Failed requests release the policy slot and retry after one second without contributing successful-throughput samples. Completed throughput includes valid HTTP responses even if their game-day snapshot has aged out; that separates service performance from useful decision coverage.

Settings → Decision pacing exposes automatic/manual modes, 25/50/80/100% service utilization, and an optional manual ceiling. Observed completions use a trailing five-second window; capacity is an estimate from response costs, not a guaranteed service rate. The resident breakdown distinguishes route waits and blocked paths from travel and time spent at activities. Preferences persist in local storage.

The controller is single-flight and approximate. It does not infer unlimited service capacity, guarantee full AI coverage at 8×, or synchronize utilization across multiple browser tabs. A shared busy server asks competing clients to retry. Existing crowd GPU benchmarks above remain historical measurements of the prior rendering pass, not new FPS claims for this correction.

Verification for this correction: 46 Node tests and the production build pass. All 12 Chrome scenarios passed; after separating network admission from the sampling timer, the four affected AI scenarios were checked again (live service, 1,000-resident cohort sharing, delayed 250-resident playback at 8×, and 1×/3×/8× plus busy recovery and persistent mobile controls). The playback test compares existing resident IDs so village growth does not invalidate its movement measurement. Sampled resident counts include legitimate activity time and occasional blocked routes; these are not classified as model throttling.
