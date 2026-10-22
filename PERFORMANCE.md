# Data locality, second pass: option rows, snapshot keys, the mirror, the river (2026-10-22)

**What changed.** These are items 7, 9, 10 and 11 of `docs/design/data-locality.md`.
- **Student.** The first question layer's norm1 and self-attention queries, keys and values for the option rows are memoized per (kind, options), next to the option tokens. Only the question rows are projected for each question.
- **Snapshots.** `validateState` keeps the clean copy per snapshot object and schema, and `stateKey` keys each clean copy once. This works because the scheduler's snapshots are never changed once made.
- **Render mirror.** Wear is compared only inside the sim's active box joined with the copy's box, and `tier`, `planned` and `low` are compared four cells to a 32-bit word. This runs in the browser sim worker only.
- **River.** `riverX` keeps a cache keyed by the bits of z, cleared whenever the river changes.

**Result.** Towns are bit-identical: `scripts/town-hash.js` gives the same hash at every decade for seeds 66, 7 and 12 over 150 years. On a 40-year replay of 18,040 student questions, every answer is identical. The option-row memo alone takes 0.87× the student's time. With the snapshot keys as well, the student took 0.43× (3.0 s → 1.3 s), because with the answer cache in place most of its time had gone into re-keying snapshots. That comparison ran under varying load, so treat it as approximate. Whole-run timings are still to be measured on a quiet machine.

---

# Data locality: dirty regions and dead rows (2026-10-22)

**What changed.** These are items 2–6 and 8 of `docs/design/data-locality.md`.
- The student's last decoder layer computes only the option rows.
- `structuralGrid` patches footprint-only changes instead of rebuilding.
- The monthly road passes scan only the box of cells with wear or a tier.
- `unsealWay` uses typed scratch arrays.
- The scheduler no longer rebuilds per-tick maps.
- `footprints()` restamps only the cells the changed buildings reach, instead of every building (3,200 full rebuilds in a 150-year town).

**Result.** Towns are bit-identical. The same `serialize()` hash at every decade for seeds 66, 7 and 12 over 150 years, and shadow checks matched the old code at every use. The student takes 0.72× its time on a 40-year replay. Whole-run timings are still to be measured; the machine was under heavy shared load (load average up to 87).

---

# Scheduler: home questions filter first (2026-10-22)

**What changed.** `homeQuestions` (`src/sim/decisions/scheduler.js`) runs on every tick with room for questions. It used to build a whole context for every household with a home, then keep the few within 40 % of affording an upgrade. Now it runs the savings test first and builds contexts only for the households that pass. This came out of the data-locality investigation (`docs/design/data-locality.md`), which ranks the further proposals.

**Result.** In a 150-year headless student town (seed 66, `scripts/town-hash.js`), `homeQuestions` fell from 4.8 % to 1.1 % of the CPU profile, about 2.9 s of a 71–83 s run. Towns are bit-identical: the same `serialize()` hash at all 15 decade checkpoints for seeds 66, 7 and 12 against `914f6aa`.

---

# Ground detail on High: grass, soil, sand, rock (2026-10-22)

**What changed.** On High only (graphics-review P1), the ground gets analytic relief through the existing micro-detail plumbing (`gBumpW` + `MICRO_NORMAL`), each layer faded out by pixel footprint (`reliefFade`). The layers are tufted grass with a faint lay, lumps and cracks on trodden soil, grit on gravel, wind ripples on sand, and rock knobs on two noise planes. Wet sand just above the waterline gets a sheen (`gSpecK` 0.5, roughness 0.3) in any weather. The helper is `vnoised` (value noise with its gradient) in `shaderlib.js`. The code is under the `GROUND_RELIEF` / `GROUND_SHEEN` macros (`MICRO_DETAIL` / `SPECULAR` minus the A/B-only `NO_GROUND_DETAIL`). Two blending fixes apply on every tier: the ground texture's beach-width channel is tapered (`smoothBeach`, `ground.js`), so sand no longer ends in a straight stepped crease where the nearest water changes kind, and the river strip reads that width too, so the green wedge at the river mouth is gone. Shots: `docs/media/ground-detail-*.jpg`.

**Cost.** `scripts/micro-detail-ab.js --feature=ground` (new option, 8 blocks), M5 Pro, DPR 1.25, measured under very heavy shared load (load average 95–115). With the terrain drawn alone, an upper bound: +0.23 ms (city-autumn overview) to +0.73 ms (grass at dawn, 24 m), with most close views at +0.5–0.6 ms. That is over the +0.2 ms target. Whole-frame deltas (−0.07 to +0.85 ms) are within the noise at this load. It was run once and not repeated on a quiet machine. The cheapest cut is the grass, which runs on every near pixel: drop its 7.3/m octave, or fade sooner.

**Not checked.** Whether Low and Medium compile byte-identical preprocessed shaders. By construction every addition sits under the new macros, but the river strip's vertex shader on all tiers now reads `groundBeach` (the blending fix above).

**Dev hooks.** `&ground=0` on the render dev page (`groundDetail: false` in `tierPatch`).

# Micro-detail: lapped roof courses (2026-10-21)

**What changed.** On High only, tile, slate and shingle roofs tilt the shading normal by the slope of lapped courses (a step up at each course line) and grooved joints, from the same analytic pattern the roof already draws (`src/render/kit/material.js`). The derivatives of `vLocal` and the view position are taken at the top of the colour hook, and Mikkelsen's 2010 formula (`microPerturb`, `MICRO_ARB` in `shaderlib.js`) turns the gradient into a normal: no new attributes. Gated by `MICRO_DETAIL` on the kit materials (`setKitMicroDetail`, from `buildings.js` `applyQuality`); Low and Medium compile what they did before. It fades with `roofSharp`, so it shows when zoomed in, not at the default overview. Design: `docs/design/micro-detail.md` §4b.

**Cost.** `scripts/micro-detail-ab.js --target=kit` (new option) with the buildings drawn alone, an upper bound: about +0.03 to +0.06 ms per pass on an M5 Pro, from one run under heavy shared load (load average 19–31). Whole-frame differences are within noise.

---

# Micro-detail: stone relief on the paving (2026-10-21)

**What changed.** On High only, cobbles and setts on the road splat tilt the shading normal by the slope of their own analytic shape (`stoneSlope` in `src/render/roads.js`, applied as a surface gradient by `MICRO_NORMAL` in `src/render/shaderlib.js`). There are no textures, tangents or extra geometry. It is gated by the `microDetail` tier flag through the terrain's `MICRO_DETAIL` define, so Low and Medium compile the same shader as before. The relief fades out as the pixel footprint grows from 6 to 12 cm, so it is not computed in far views. Design, survey and rollout plan: `docs/design/micro-detail.md`.

**Cost.** `scripts/micro-detail-ab.js` (new) flips the define in one loaded page and times interleaved blocks. With the terrain drawn alone, which is an upper bound, it costs +0.02 to +0.06 ms per pass on an M5 Pro (1–2.5 % of the terrain). In whole frames, and in `fidelity-shots.js --noshot` against `a5347fc`, the change is lost in the noise. The machine was heavily shared (load average 11–22) while these were measured.

**Dev hooks.** `&micro=0|1` on the render dev page (the `tierPatch` option of `createWorld`) and `fidelity-shots.js --extra="micro=0"`.

---

# The sim in a Web Worker (2026-10-21)

**What changed.** The town's state now lives in a dedicated module worker (`src/sim-worker.js`). `stepTick`, the route planner (it starts its navigation worker from there), the decision client, the prose keeper, player actions and saves all run there. The main thread draws a mirrored render view (`src/sim/render-mirror.js`) and UI snapshots (`src/sim-snapshot.js`), so no tick can hold up a frame. Design: `docs/design/sim-worker.md`; the brief it was built from: `docs/handoff-sim-worker.md`.

**Result.** `scripts/benchmark-daycycle.js --speed=20`, High, DPR 2, on an M5 Pro. The baseline is `7380658` (a `git archive` of it, run with this commit's script). Runs alternated base, worker, base, worker; the values below are two runs each. A missed frame is an animation-frame interval over 25 ms. "Main" is all main-thread time for a frame. Before, that was the frame callback plus the sim step. With the worker, it is the frame callback plus applying the step's reply to the mirror.

| | dawn frames missed | long frames / 30 s | dawn main mean | dawn main p95 | rest-of-day main mean | reached |
|---|---:|---:|---:|---:|---:|---:|
| city fixture, before | 2 % / 4 % | 7 / 13 | 11.7 / 12.5 ms | 22.3 / 25.8 ms | 6.9 / 7.1 ms | 19.2× / 19.3× |
| city fixture, worker | 0 % / 1 % | 1 / 2 | 2.6 / 2.6 ms | 5.2 / 5.0 ms | 2.2 / 2.2 ms | 20.0× / 19.7× |
| year-165 metro, before | 7 % / 12 % | 21 / 36 | 13.0 / 13.8 ms | 24.7 / 28.8 ms | 7.5 / 7.6 ms | 20× / 20× |
| year-165 metro, worker | 0 % / 0 % | 1 / 1 | 3.0 / 3.0 ms | 8.9 / 9.3 ms | 2.4 / 2.6 ms | 19.7× / 19.8× |

- **The one long frame left** in each worker run is the frame where the CPU profiler starts (phase 0.34). The baseline runs have it too. Main-thread frames over 8 ms that remain are the renderer's own work (`world`): lots re-composed after a year-end restyle, path tiles. The sim takes no main-thread time.
- **Applying a step's reply to the mirror** takes 0.07–0.08 ms per frame at dawn (p95 0.2 ms). The worker's message handler, apply included, is about 0.1 ms per frame in the CPU profile.
- **The sim's own time is unchanged.** In the worker it is 8.6–9.5 ms per step at dawn, about what it was on the main thread (8.5–10 ms). The worker's step budget is 30 ms (main thread: 10 ms), and the town reached 19.7–20×.
- **GPU time is unchanged** (6.2–7.3 ms against 6.0–6.8 ms).
- **`?simWorker=0`** (the inline fallback, one run): 2 % of dawn frames missed, dawn main 11.9 ms, 19.3×. That is the baseline's numbers, so the snapshot layer costs the inline path nothing measurable.
- **The 57 ms autosave serialize** on the city now runs in the worker too.

**Simulation output is unchanged.** `scripts/benchmark-city.js --speed=20 --seconds=30` hashes `c0e2092717006adb` (city) and `3448e520a03bcc89` (town) before and after. `tests/sim-worker.test.js` drives the worker module through `worker_threads`, with a synchronous route planner, for 360 frames at 20× (some of them late) on the town and the city. It gets the same `serialize(state)` hash as an inline run of the same frames, done as `main.js` stepped them before.

## How it fits together

1. **One session, two hosts.**
   - `src/sim-session.js` is one running town: init, step, the view sync, actions, snapshots, saves, notes and the test hooks.
   - `src/sim-host.js` wraps it in two ways. `createWorkerHost` sends messages to `sim-worker.js`. `createInlineHost` calls the session on the main thread and keeps the old step-after-the-frame task. The inline host is used for `?simWorker=0`, the stub sim, and a worker that fails to start (within 20 s).
   - The same session code serves both hosts, so they cannot drift apart. `app.js` and `main.js` treat every answer as possibly a Promise.
2. **Step pacing.**
   - Each drawn frame posts `{owed, now, speed}`, but only once the last step has been answered. Until then, owed time accumulates, capped at 0.25 s.
   - A frame never waits: it draws the last mirrored view, and walkers are carried on to the frame's time.
   - `services.now` and walker row stamps use the main thread's clock, sent in the message. The step budget uses the worker's own clock.
   - Reached speed is computed from the `ticks` in each reply.
3. **The render mirror.** It has exactly `createRenderView`'s shape, so `src/render` is unchanged.
   - Walker rows: the dirty range, as transferred copies.
   - Buildings: the records in the render view's events, plus any record whose object changed. A round-robin slice of records is also compared field for field, about one full pass a second, which catches changes no event announced. Records are patched in place on stable objects.
   - Roads: `wear` is compared with a copy every step. `tier`, `planned` and `low` are compared when `roads.version` changes or a cell is dirty. The changed rectangle of each grid is sent and patched into stable arrays.
   - Small fields every step. `aesthetics` and `landscape` only when their revision changes.
   - The mirror replaces an object exactly when the sim replaced its own, and patches it otherwise. So the renderer's identity checks (`lot.record !== b`, a new `roads` or `roads.tier`, a new people buffer) fire as they did.
   - `roads.dirty`, `peopleDirty` and `buildingEvents` are the union of what arrived since the renderer last cleared them. The worker clears the sim's own `roads.dirty` after each sync.
   - `tests/render-mirror.test.js` checks the mirror against the live view field for field, every frame, through a year end and an era change, along with these identities.
4. **The UI.**
   - `doRefresh` asks for one snapshot of every selector it shows. It has one request out at a time and draws what comes back. Views opened while a snapshot was on its way ask for another.
   - Actions are awaited. The same action is not sent again while one is on its way, so a fast double click rules once.
   - The inspector reads bundles (`selectInspect`, the narrator's facts, the kept note). `noteFor` writes notes back through the host (`notes.set` and `notes.touch`).
   - The Council is handed the app's current data when it opens, so a card asked for by id is found before the next snapshot lands.
5. **Saves and boot.**
   - Boot creates, restores or loads the fixture in the worker. The worker replies with the terrain, and the main thread calls `useTerrain` before the renderer starts.
   - The worker serializes saves. The thumbnail, the IndexedDB write, the writer claim and the toasts stay on the main thread.
   - `pagehide` saves are best effort. The `visibilitychange → hidden` save covers almost every real case.
6. **Worker death.**
   - A worker that fails to load falls back to inline.
   - After start, an uncaught error, or 15 s of silence while steps wait, prompts a ping. No answer within 5 s means the worker is dead: the loop stops, and a notice offers to reopen the town from its last save.
   - Calls that may run long on purpose (opening a town, a save, test hooks) hold the watchdog off.
7. **Dev and test hooks.**
   - `hearthvale.inSim(fn, ...args)` runs `fn`'s source where the town is, with `(state, sim, ...args)`, and returns JSON; `sim.docket` is the docket module.
   - `hearthvale.snapshot()` is an async clone of the whole state.
   - `hearthvale.state()` returns the live state only on the inline host.
   - The eight Playwright specs that touched state use these hooks. `benchmark-daycycle.js` reads the worker's step time from each reply (`host.onStep`) and the mirror's apply time; `--inline` runs `?simWorker=0`.
   - `benchmark-desktop.js` and `benchmark-longframes.js` read the town through `host.inSim`.

## Remaining

- **Bundle.** The worker bundle is 760 KB: the sim, plus three's math through `sim/outline.js` → `render/kit/compose.js`. The main thread still loads the sim modules for the inline fallback, the renderer's pure imports and the narrator.
- **UI timing.** UI snapshots are drawn in their own task, not in the frame callback. `benchmark-daycycle.js`'s `ui` column is now near 0; the draw shows in the CPU profile instead.
- **Building scan.** The round-robin record check costs the worker about one record's `JSON.stringify` per sixtieth of the town per step. If a later change makes the sim announce every record change with `touchBuilding`, this could go.

---

# 20× dawn hitch pass (2026-10-20)

**What the hitch was.** It was not fog, mist or shadows. In seasonal mode the year carries the day (`daylight.js`), so every year opens at dawn, and at 20× a year lasts about 6 s. The first tenth of each year is when the town builds: the year's founding attempts, new homes, the year-end restyles and household moves. Every building placed or reshaped made each walker's route be checked again on the main thread (`people.js checkFootprints`). Through the whole day at 20× the GPU stayed at about 6 ms a frame, and the renderer's CPU at about 3 ms. The sim went from about 4.5 ms a frame to 10–12 ms in the early morning.

**Result.** `scripts/benchmark-daycycle.js` (new), at 20×, High, DPR 2, on an M5 Pro. Baseline is `fc40aae` (a `git archive` of it). Runs alternated; the values below are two runs each. A missed frame is an animation-frame interval over 25 ms. "Main" is all main-thread time for a frame: the frame callback plus the sim step.

| | dawn frames missed | long frames / 30 s | dawn main mean | dawn sim mean | render CPU (rest of day) |
|---|---:|---:|---:|---:|---:|
| city fixture, before | 18 % / 15 % | 50 / 42 | 15.0 / 14.3 ms | 11.1 / 10.4 ms | 2.7 ms |
| city fixture, after | 2 % / 2 % | 7 / 7 | 11.2 / 11.6 ms | 8.1 / 8.4 ms | 2.0 ms |
| year-165 metro, before | 28 % / 26 % | 79 / 79 | 16.8 / 16.6 ms | 12.2 / 12.0 ms | 3.0 ms |
| year-165 metro, after | 8 % / 11 % | 25 / 33 | 13.3 / 13.3 ms | 9.6 / 9.6 ms | 2.2 ms |

Both builds reached 19–20× throughout. GPU time is unchanged (6–7 ms). Outside dawn, under 1 % of frames miss in either build.

Headless, per sim tick on the city fixture over three game years (a per-tick timing harness, not committed):

| | ticks in the year's first tenth | of those, ticks that place or change a building | year-end tick | `checkFootprints` on such a tick |
|---|---:|---:|---:|---:|
| before | 6.8 ms | 16.2 ms | 25.8 ms | 7.7 ms |
| after | 4.9 ms | 10.7 ms | 8.2 ms | 5.0 ms |

**Simulation output is unchanged.** The serialized state hashes identically before and after for the city fixture at 20× (2,280 and 7,000 frames, about 19 game years) and at 5×, for the town fixture at 20×, and for the year-165 metro at 20×. Tests in `tests/perf-equivalence.test.js` check each shortcut against the full computation, after buildings come down beside walks and go up across them.

## Changes

1. **The sim steps in a task of its own** (`main.js`). The step is posted as each drawn frame is handed to the GPU, so the GPU draws while the sim works. Before, the step ran first in the frame. On a frame with a heavy tick, the step, the frame's CPU and then its GPU time came to more than 16.7 ms.
   - Each frame draws the state the last step left, and walkers are carried on to the frame's time as before.
   - The speed reached and the budget rules (`SIM_BUDGET_MS`) are as they were.
   - `hearthvale.view().stepMs` is the last step's time.
   - `benchmark-desktop.js` frameCpu no longer includes the sim step: it now also reports `stepCpu`.
2. **Walkers' route checks after a building change** (`sim/roads.js`, `sim/people.js`, `sim/outline.js`). All of these are exact.
   - *Walls memo.* `routeClearFrom` walked the whole rest of every walker's route. A walk found clear now keeps a memo (`wallMemo`). While no cell near its legs has become or stopped being a wall (`wallGen`, stamped per tile like the near-list `tileGen`), only the leg from where the walker stands is checked.
   - *Stale memos are re-checked in part.* When tiles under a walk did change, only the legs whose boxes meet those tiles are checked again (`memoCatchUp`), and the waypoints at their ends. This holds for the skirt memo and the walls memo alike. If they all pass, the full check would leave the walk as it is.
   - *A log of changed tiles.* Each footprint build lists the tiles it stamped (`TILE_LOG` builds kept), so a memo is brought up to date by testing those few tiles against its bounding box.
   - *Outlines keep their identity when their shape does.* A restyle rebuilt every restyled building's pieces as new objects, even when they were the same shape. Near lists are compared by identity, so every walker's memo went stale at the turn of the year. `buildingOutline` now hands back the old pieces when the new ones are equal. This was most of the year-end tick.
   - *Outline cache key.* The key is compared field by field instead of building a 17-field string per building on every footprint build.
   - The tile diff skips tiles already marked in the current build.
3. **`busyRef`** (`sim/sites.js`) sorted the wear of every trodden cell on each site search to read one percentile. It now selects it (`kthLargest`), which gives the same value.
4. **Renderer.**
   - *Path field* (`render/paths.js`, `roads.js`). The scan of every road cell (about 0.4 ms in a city, plus node sync) ran on every frame that still had tiles queued, which is nearly every frame at high speed. It now runs at the texture's upload rate (2 Hz), and frames in between only draw queued tiles. Tiles are drawn from what the last scan saw (`tierSeen`), so they always agree with that scan's nodes. The golden-pixel test is unchanged. This saves about 0.7 ms of render CPU per frame at 20×.
   - *Mist* (`render/mist.js`). Its 2 s ease ran in real time, so at 20× it never cleared and hung over the town all day. It now eases over 2 s ÷ speed. Below about 0.05 (under 1.5 % opacity) it fades out and the full-screen pass is skipped. That pass costs about 0.26 ms of GPU here (A/B within one run). Screenshots of four looks differ from the baseline by less than two baseline runs differ from each other.

## Also measured, not changed

- **Shadows.** At 20× the sun turns enough to re-render the shadow map on about half of all frames, at every time of day. This costs about 0.2 ms of GPU per frame on average here. Throttling it would make the shadows step visibly.
- **Weather.** Rain eases in real time (8 s in, 4 s out), so at 20× each month's shower blurs into a constant light wetness (`uWet` about 0.11). This is a design call: easing it in game time would flash showers on and off twice a second.

## Remaining (found, not fixed)

1. **About 2 % (city) to 10 % (metro) of dawn frames still miss at 20× on this machine.** A tick that places a building still costs about 8–10 ms:
   - the full footprint rebuild (`roads.js footprints`, about 2.5 ms);
   - each walker's checks of its current leg (about 2 ms for 2,000 walkers);
   - route deliveries;
   - monthly jobs that land on the same tick.

   An incremental footprint build would need to reproduce the stamping order exactly: wall ownership, `unsealWay` pockets and the order of the near lists. The lasting fix is to step the sim in a worker, so no tick can hold up a frame.
2. The per-tick harness used for the headless table is not committed. `benchmark-daycycle.js` gives the in-browser split by time of day, with a CPU profile split the same way.

---

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
