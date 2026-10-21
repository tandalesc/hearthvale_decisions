# Handoff: run the simulation in a Web Worker

**Task: build it.** Move the simulation step off the main thread so that no sim tick can delay a rendered frame. This is an implementation task, not a design task. A design already exists (below). Write code and ship it working.

## Why

At 20× speed every game year opens at dawn with a building burst. A tick that places a building still costs about 8–10 ms on the main thread, and up to about 22 ms when a month or year job lands on the same tick. Some dawn frames still miss on an M5 Pro: about 2% on the city fixture and 8–11% on a year-165 save. Earlier work cut those costs and moved the step into its own task after each frame (see PERFORMANCE.md, "20× dawn hitch pass"). What's left only goes away when the sim stops running on the main thread.

## Start from

- **Branch:** `claude/graphics-optimization-20x-b4ad68`, commit `bae45d3`. It contains the dawn-pass work this builds on: `stepChannel`/`step()` in `src/main.js`, the walker memos in `src/sim/roads.js` and `people.js`, and `scripts/benchmark-daycycle.js`. Branch from here.
- **Design doc:** `docs/design/sim-worker.md` on branch `claude/silly-keller-d8bdd4` (commit `3463a5f`), with `scripts/sim-worker-deltas.js`. Bring it in with `git cherry-pick 3463a5f` or `git show 3463a5f:docs/design/sim-worker.md`. Read sections 1 (everything that touches `state` on the main thread, with file:line), 3 (measured per-frame delta sizes) and 4 (architecture). Ignore its day estimates and its "smaller alternative" section: the goal is the worker.

## Done means

1. In the browser, `stepTick`, `routes.tick` and the route planner, the decision client and the prose keeper all run in a dedicated module worker (`src/sim-worker.js`). The main thread never calls `stepTick`.
2. `node scripts/benchmark-daycycle.js --speed=20` on the city fixture, and with `--save=<year-165 save>`, shows dawn missed frames near 0%. Main-thread time per frame at dawn should be about the renderer's (~3 ms) plus the mirror's apply step. Grow the save with `node scripts/grow-town.js OUT.json`. Teach the script to read the worker's step time from the step reply rather than `hearthvale.view().stepMs`.
3. `npm test`, `npx playwright test` and `npm run build` all pass.
4. **Simulation output is bit-identical.** `node scripts/benchmark-city.js` prints a state hash. Compare it before and after on `--fixture=city` and `--fixture=town` at `--speed=20`; it must match. Add a Node test that drives the worker module through `worker_threads` with a synchronous route planner (`createRoutePlanner({worker: false})`) for N frames. Compare its final `serialize(state)` hash with an inline run of the same frames.
5. `?simWorker=0` (and any failure to start the worker) falls back to running inline, through the same host interface.
6. PERFORMANCE.md gets a new top section with before/after numbers from alternating runs. The machine is shared and noisy: alternate baseline and new runs, and compare only within one set.

## Architecture (from the design doc, condensed)

- **The worker owns `state`.** `src/sim` itself does not change; it is already free of the DOM, `localStorage` and `Math.random`.
- **Host interface** (`src/sim-host.js`): `init(choice)`, `step(owed, now, speed)`, `act(name, ...args) → Promise`, `ui({want, inspect, chronicleLimit}) → Promise<snapshot>`, `save() → Promise<{text, meta}>`, `setIndividualCap`, `decisions.{configure, setEnabled, reset}`, `notes.{set, touch}`, `dev.*`, `dispose`. There are two implementations: `InlineHost` (today's behaviour) and `WorkerHost` (messages). A good first step is to route `main.js` and `app.js` through `InlineHost` with no worker at all. That proves the UI has no other state reads.
- **Step pacing:**
  - Each drawn frame posts `{step, owed, now, speed}`, and only when the previous step has been answered. Otherwise owed time accumulates, capped at 0.25 s as now.
  - Frames never wait: they draw the last mirrored view.
  - Use the main thread's `now` (sent in the message) for `services.now` and for walker row stamps. The worker's `performance.now()` has a different origin.
  - Compute reached speed from the `ticks` each reply returns.
- **Render mirror** (`src/sim/render-mirror.js`). It must present exactly the shape `createRenderView` returns, so `src/render` stays unchanged. The worker sends, each step:
  - changed building records (from `buildingEvents`), applied **in place** on stable record objects;
  - the dirty road rectangle (`wear`, `tier`, `planned`), patched into stable typed arrays;
  - dirty walker rows, transferred;
  - the small per-step fields (`bridges`, `lamps`, `embankments`, `attention`, `centres`, `projects`, `time`, `worldEvents`, `weather`, `era`, …);
  - `aesthetics` and `landscape` only when their revision changes, mutated in place.
- **UI:** `app.js doRefresh` (250 ms throttle) asks for a snapshot of the selectors it already runs, plus the panels in `want` and the inspector bundle (`selectInspect`, `narrativeFacts`, the saved note). It draws the last snapshot it has. In the city this is about 110 KB and 0.4 ms in the worker.
- **Actions:** `host.act` becomes async. The six call sites in `app.js` await it, and each control stays disabled until its reply arrives, so a double click cannot rule twice.
- **Saves:** the worker runs `serialize` (57 ms in the city today, on the main thread). The main thread keeps the thumbnail, IndexedDB write, writer claim and toasts. Boot creates, restores or loads the fixture in the worker, which replies with terrain `{seed, version, archetype}`. The main thread calls `useTerrain(...)` before `createWorld`.

## Traps (each one will bite)

1. **The renderer detects changes by object identity**: `lot.record !== b` and `list === indexedArray` (`render/buildings.js`), `roads !== lastRoadsRef` (`trees.js`), a new `roads` or `roads.tier` triggering a full refill (`render/roads.js`, `paths.js`), and `array !== boundArray` (`people.js`). Replace a mirrored object instead of patching it, and that subsystem rebuilds every frame: slow, not wrong, and easy to miss. A new road grid (restore or new town) is the one case that should replace the object.
2. **The renderer writes into sim state**: `roads.dirty = null` (`render/roads.js`). On the mirror that is fine. In the worker, clear the sim's `roads.dirty` after each sync yourself. The mirror's `dirty` is the union of the rectangles received since the renderer last cleared it. `peopleDirty` and `buildingEvents` work the same way.
3. **`sim/decisions/scheduler.js` calls `decisionClient.stats()` synchronously**, so the decision client must live in the worker. The settings panel reads stats from the snapshot.
4. **Route deliveries write state** (`task.route`, `recordCrossingBand`, `countDeckTrips`), so the planner lives in the worker. It starts its navigation worker from there; nested workers work in current Chrome, Firefox and Safari, and where they don't, the planner falls back to cooperative mode.
5. **Terrain globals** (`src/terrain.js` `heightAt`, `riverX`, …) are used by the renderer, picking, the camera and audio (`rapidsSources()`). Seed both threads, the way `navigation-worker.js` already does.
6. **Eight Playwright specs touch `state` inside the page.** `advisers`, `budgets` and `approval` import `/src/sim/...` and mutate live state; `ui`, `hud`, `dock` and `menu` read `hearthvale.state()`. Add a dev/test hook, `hearthvale.inSim(fn, ...args)`, that runs `fn.toString()` in the worker with `(state, sim, ...args)` and returns JSON. Add an async `hearthvale.snapshot()`. Migrate the specs to them.
7. **The narrator's `noteFor`** streams on the main thread but reads facts from `state` and writes notes back. Pass it the facts from the snapshot, and send `notes.set`/`notes.touch` to the worker.
8. **`sim/outline.js` imports `render/kit/compose.js`**, so three's math code comes into the worker bundle. That's fine (no DOM), but check the Vite worker build handles it (`new Worker(new URL('./sim-worker.js', import.meta.url), {type: 'module'})`, as `route-planner.js` does).
9. **Worker death:** show a toast, stop the loop, and offer to reopen from the last save. Don't keep drawing a frozen town and pretend it's live.
10. **`pagehide` saves** become best effort: post a save to the worker. The `visibilitychange → hidden` save covers almost every real case.

## Useful tools already in the repo

- `scripts/benchmark-daycycle.js`: in-browser per-frame cost by time of day, dawn vs rest, missed-frame share, CPU profile split the same way. It uses `--save=PATH` and `--speed`, serves files from the current directory, and can be run from a `git archive` of the baseline for alternating A/B runs.
- `scripts/benchmark-city.js`: headless per-frame cost plus the state hash.
- `scripts/sim-worker-deltas.js` (design branch): measured delta sizes per frame.
- `tests/perf-equivalence.test.js`: exactness checks for the walker memos.
