# Simulation in a worker (design, not implemented)

At 20× a game year lasts about 6 s, and each one opens at dawn with a building burst.
On the busiest of those ticks the sim takes 8–10 ms; when a month or year job lands on
the same tick, up to about 22 ms. The 20× dawn pass (PERFORMANCE.md, 2026-10-20) made
those ticks cheaper. It also moved the step into a task of its own, posted after each
drawn frame. Even so, about 2 % (city fixture) to 10 % (year-165 metro) of dawn frames
still miss on an M5 Pro, because one tick still holds the main thread longer than a
frame can wait.

This note describes moving `stepTick` and the route planner into a dedicated worker, so
that no tick can delay a frame. It covers:
- everything on the main thread that reads or writes `state` today, and what each needs instead;
- what would cross between the threads per frame, measured;
- the smallest architecture that works, the order to build it in and what it costs;
- the risks;
- a smaller fallback that keeps the sim on the main thread.

**Verdict.** The design is sound, and the data that would cross per frame is small
(§3). It is not a contained change, though. It turns every synchronous state read in the
UI, narrator, saves, dev hooks and eight Playwright specs into messages or snapshots. It
also rewrites the frame loop in `main.js`, and that loop has uncommitted changes from the
dawn pass. So it was not built in this pass. The estimate is 8–11 working days in five
phases (§5); each phase lands green on its own.

## 1. What touches `state` on the main thread today

### Renderer: through the render view, but with live references

`createRenderView(state)` / `view.sync(state, {now, speed})` (`src/sim/render-view.js`)
is the renderer's only entry point to the sim. It is not a copy of the state, though.
- **Copied** (typed or rebuilt each sync):
  - `people`: a `Float32Array` of 20 floats per walker, with its handshake fields `peopleDirty`, `peopleVersion` and `peopleIds`;
  - `bridges`, `lamps`, `embankments`, `attention`, `centres`, `projects` and `time`.
- **Live references into `state`**:
  - `view.buildings === state.buildings`: the same record objects. `kit/compose.js` reads about 27 fields of each;
  - `view.roads === state.roads`: the whole object with its `wear`, `tier`, `planned` and `low` grids (384×384), `version` and `dirty`;
  - `worldEvents`, `weather`, `aesthetics` and `landscape` (whose `level` is an `Int8Array`).
- **Handshakes owned by the consumer**:
  - the renderer sets `view.peopleDirty = null` (`render/people.js:988`);
  - it empties `view.buildingEvents` (`render/buildings.js:254`);
  - it **writes into sim state** with `roads.dirty = null` (`render/roads.js:160,178`). That is the sim's dirty rectangle (`sim/roads.js markDirty`).
- **Change detection by identity**:
  - `lot.record !== b` (`buildings.js:246`) and `list === indexedArray` (`buildings.js:120`);
  - a new `roads` object refills everything (`roads.js:152`), and a new `roads.tier` rebuilds the path field (`paths.js:326`);
  - `roads !== lastRoadsRef` (`trees.js:1119`) and `array !== boundArray` (`people.js:986`).

  A mirror on the main thread has to keep these identities stable, or every check fires every frame.
- **Pure sim imports**: `deckProfile` (`sim/bridges.js`), `stageOf` (`sim/landscape.js`), and `benchesOf`/`GATHER` (`sim/seats.js`). These are pure over the records they are given, so they work on mirrored records.
- **Terrain globals**: `src/terrain.js` (`heightAt`, `terrainKey`, `terrainSeed`, `riverX`, …), `river.js`, `waters.js`, `woodland.js` and `path-nodes.js`. The renderer, picking, `projectPoint`, the camera and `audio.setWaterSources(rapidsSources())` all use them. Both threads need them seeded, so the main thread would call `useTerrain(seed, version, archetype)` from what the worker sends, the way `navigation-worker.js` already does.
- **Picking, `projectPoint` and `follow`** use only renderer data: lot summaries, the walker buffer, `view.peopleIds` and terrain. They need no state.

### UI: through selectors, at about 4 Hz

Nothing in `src/ui/components`, `sheet.js` or `model.js` imports `src/sim`. `app.js` reads state through `host.state()` (`main.js:368`), and only through the pure selectors in `src/sim/view.js`.
- `doRefresh` (`app.js:763`) is throttled to `REFRESH_MS = 250`. `refresh(true)` also runs after every action, speed change and panel toggle.
- **Every refresh** runs `selectTopBar`, `selectUnlocks`, `selectDocket`, `selectBodies`, `selectEraProgress`, `selectChronicle({limit: 40})`, `selectEvents` and `selectCentres`. It runs `selectFactions` every 2 s, and `selectBudgetSeason` and `selectAdvisers` once unlocked.
  - **Measured:** 0.40 ms in the city, 110 KB of JSON, and 0.34 ms to `structuredClone` the bundle.
- **Raw reads, for audio**: `state.weather.wind/rain/snow`, `state.worldEvents` and `state.projects.length` (`app.js:806`).
- **Panel selectors, only while that panel is open** (`updateViews`): `selectRuleBook`, `selectCompass`, `selectApproval`, `selectChronicle({limit: chronicleLimit})` together with `state.chronicle.entries.length`, `selectEndPreview`, `selectTensions` and `selectBudget`.
- **Inspector**, about 4 Hz while open. A pick from the renderer gives `{personId}` or `{buildingId}`. Each refresh then runs `selectInspect(state, target)`, `narrativeFacts(state, query)` and `peekNote` (which calls `narrativeFacts` a second time).
- **Identity-keyed caches in the UI path**:
  - the `idCache` WeakMap on `state.chronicle.entries` (`view.js:563`): a miss only costs time;
  - the `memoryNotes` WeakMap on `state` (`narrator-client.js:234`): unused while `state.notes` exists, which is always the case with the real sim.

  All UI state between refreshes is keyed by id or by string, so snapshots break nothing.

### Writes from the main thread

| Write | Where | Shape today |
|---|---|---|
| player actions: `rule`, `strikeBudgetLine`, `approveAllBudgets`, `trimAllToFit`, `hireAdviser`, `dismissAdviser`, `setAdviserMode`, `redrawSlate`, `letStand`, `dissolveBody` | `host.act` (`main.js:375`); 6 call sites in `app.js` (464, 475, 490, 499, 984) | sync, result `{ok, text\|reason\|error}` shown at once |
| `setIndividualCap` | `host.setIndividualCap` (`main.js:382`) | sync, result unused |
| inspector notes: `setEntityNote` after a stream; `touchEntityNote` on show | `narrator-client.js:245,254` | async write onto the `state` captured earlier |
| prose: `setCardProse`, `setChronicleProse`, `setSummaryProse` | prose keeper, every 1 s (`main.js:414`) | facts read sync, write after `await fetch` |
| dev hooks: `advanceEra`, `foundBody`, `addCard` | `window.hearthvale.dev` | sync, then `app.refresh()` |
| tests | `advisers`, `budgets`, `approval` specs `import('/src/sim/...')` in the page and run `stepTick`, `addCard`, `hireAdviser`, `fastForward` and splices on live state; `ui`, `hud`, `dock` and `menu` specs read `hearthvale.state()` | sync, in `page.evaluate` |

### Services

- **Route planner** (`src/route-planner.js`). `tick(state)` runs before each step. Finished routes **write state**: `task.route`, `recordCrossingBand` and `countDeckTrips`. It must therefore live with the state. It already has its own navigation worker, plus a cooperative fallback.
- **Decision client** (`src/decision-client.js`).
  - The only caller is `sim/decisions/scheduler.js`. It calls `ask()` and also calls `stats()` synchronously (`busOf`, :144; :1055).
  - Answers only push to a per-state inbox, which is applied in sorted order inside a tick, so they do not depend on timing within a tick.
  - It uses `fetch`, `setTimeout` and `AbortSignal`: no DOM, so it is fine in a worker.
  - The settings panel reads `stats()` and calls `configure()`, `reset()` and enable.
- **Narrator.**
  - `startProseKeeper(() => state)` reads facts synchronously and writes through actions. It uses `fetch('/api/narrate')`, so it is fine in a worker.
  - `noteFor` streams tokens into the inspector, which is on the main thread.

### Saves and boot

- **Saves.**
  - `serialize(state)` is a synchronous `JSON.stringify` of everything except walkers and `_` keys. It takes 19 ms on the town and **57 ms on the city**, on the main thread, at every 30 s autosave, every ruling (debounced) and on `visibilitychange`/`pagehide`. A worker removes that hitch as a side effect.
  - `metaFromSave(state)`, export, `importSave` (which validates with `sim.restore`), the thumbnail and the BroadcastChannel writer claim are all on the main thread.
  - `save-store.js` gzips in `save-worker.js` and stores in IndexedDB. Both work inside a worker as well.
- **Boot.** `createState`, `restore` and `loadFixture` all run on the main thread; `loadFixture` uses `fetch` with `import.meta.url` and so works in a worker. `restore` sets the terrain globals.

### Worker safety of `src/sim`

- No DOM, `window`, `localStorage` or rAF anywhere in `src/sim`.
- `Math.random` appears only as an unused default parameter (`works.js:1258`), and there is no `Date`.
- `performance.now` appears only in the step budget, diagnostics and `render-view`'s default clock.
- `sim/outline.js` imports `render/kit/compose.js`, so `three`'s math code comes into the worker bundle. It has no DOM use; this costs parse time, nothing more.

## 2. Determinism

The sim's code does not change, so the headless runs are unchanged by construction:
- `scripts/benchmark-city.js` hashes the serialized state after a fixed number of frames with a synchronous planner;
- `tests/perf-equivalence.test.js` and `tests/route-delivery-equivalence.test.js` check the sim's shortcuts against the full computations.

Browser runs are not reproducible today either: route answers and model answers arrive whenever they arrive, and the frame budget sets how many ticks run per frame. A worker keeps the same rules:
- route deliveries, model answers and player actions all land **between** `stepTick` calls, never inside one, as they do now (they are handled by the worker's own event loop);
- `services.now` stays the main thread's frame clock, sent with each step message (below);
- `services.rate` stays speed × PACE.

The check, for whoever builds it: compare `benchmark-city.js` hashes on the city and town fixtures before and after, plus a Node test that drives the worker module through `worker_threads` with a synchronous planner and compares its final hash with an inline run of the same frames.

## 3. What would cross per frame (measured)

`scripts/sim-worker-deltas.js` (added with this note) runs the browser loop headless: 20×, 60 fps, two game years, `routes.tick` + `stepTick` + `view.sync` per frame. For each frame it builds what a worker would post:
- the changed building records (from `buildingEvents`);
- the dirty road rectangle (`wear`, `tier`, `planned`);
- the dirty walker rows.

It times a `structuredClone` of that payload, which is serialize plus deserialize, so it is an upper bound on either thread's share. "Dawn" means the first tenth of each year. Format: mean / p99 / max.

| city fixture (dawn-pass code) | sim per frame, ms | delta clone, ms | buildings changed | road cells in dirty rect | walker rows |
|---|---|---|---|---|---|
| dawn (74 frames) | 9.9 / 35.3 / 35.3 | 0.24 / 2.9 / 2.9 | 37 / 631 / 631 | 40 k / 61 k / 61 k | 1,800 / 2,000 |
| rest of year (646) | 3.9 / 17.6 / 33.8 | 0.08 / 0.21 / 0.42 | 1.9 / 16 / 21 | 43 k / 61 k / 61 k | 1,990 / 2,000 |

| town fixture (main) | sim per frame | delta clone | buildings changed |
|---|---|---|---|
| dawn | 3.9 / 26.7 / 26.7 | 0.10 / 1.0 / 1.0 | 12 / 184 / 184 |
| rest | 0.85 / 6.2 / 11.1 | 0.04 / 0.15 / 0.20 | 1.5 / 15 / 22 |

The two sizes that matter:
- **Typical frame:** about 0.1 ms of clone, so the main thread's share is well under 0.1 ms. That is small next to the 8–35 ms ticks it would take off the main thread. The road rectangle covers most of the town every frame, because walkers wear paths everywhere. It is still only about 360 KB of typed arrays, and typed arrays clone at memcpy speed.
- **Worst frame:** the year-end restyle, which touches every building (631 records), at about 2.9 ms round trip. Sending only the fields the renderer reads (about 27 of 43) roughly halves that, and the renderer already re-composes all those lots that frame today.

For comparison, cloning the whole city `state` takes 21 ms, and cloning it without `people`, `roads`, `households` and `buildings` still takes 5.4 ms. A replica of `state` on the main thread is therefore not an option. The main thread gets a render view and a UI snapshot.

## 4. Proposed architecture

**The worker owns `state`. The main thread gets a mirrored render view every step and a UI snapshot at the refresh rate, and sends actions and requests as messages.** `src/sim` is unchanged.

```
main thread                                   sim worker (src/sim-worker.js, module)
-----------                                   --------------------------------------
frame(now) ── {step, owed, now, speed} ─────▶ routes.tick; stepTick(state, owed·speed·PACE,
                                                 services{now, rate, decisions, routes});
                                                 view.sync(state, {now, speed})
mirror.apply(delta) ◀── {delta, seq, ticks, ── people rows (transfer), peopleIds, buildings
world.update(mirror)     stepMs, reached}       changed + events, road rect patch, small fields
app (4 Hz) ── {ui, want[], inspect, limit} ─▶ selectors → snapshot (+ inspect, facts, note,
app.render(snapshot) ◀── {snapshot} ────────    decision stats)
act(name, args) ── {act, id, name, args} ───▶ sim.actions[name](state, ...) between steps
   ◀── {id, result, snapshot} ───────────────
save() ── {save} ───────────────────────────▶ serialize(state) → text (off the main thread)
   ◀── {text, meta} ─────────────────────────
                                               nested navigation worker (as today)
                                               decision client + prose keeper (fetch)
```

### Pieces

1. **`SimHost` interface** (`src/sim-host.js`), with two implementations.
   - **What it exposes:** `init(choice)`, `step(owed, now, speed)`, `act(name, ...args) → Promise`, `ui({want, inspect, chronicleLimit}) → Promise<snapshot>`, `save() → Promise<{text, meta}>`, `setIndividualCap`, `decisions.{configure, setEnabled, reset}`, `notes.{set, touch}`, `dev.*` and `dispose`.
   - **`InlineHost`** wraps today's same-thread calls behind the same interface. It is used for `?stub=1`, `?simWorker=0`, browsers without module workers, and the Node tests. It keeps one UI code path.
   - **`WorkerHost`** sends the same calls as messages, with ids, to `sim-worker.js`.

2. **Step pacing.**
   - Each drawn frame posts `{step, owed, now, speed}`, but only if the previous step has been answered. Otherwise the owed time accumulates, capped as `simOwed` is today.
   - The worker applies its own `until` budget, which can now be generous (for example 30 ms), and keeps the `MAX_CARRY_SECONDS` cap.
   - The reached-speed figure is computed from the `ticks` each reply returns.
   - A frame never waits. If the worker is mid-tick, the frame draws the last mirrored view, and walkers are carried on by the shader's `t0`/`t1` clamping, as between ticks today.
   - The worker's `performance.now()` has a different `timeOrigin`. Rows must be stamped with the main thread's `now` from the message, and `services.now` comes from it too.

3. **Mirrored render view** (`src/sim/render-mirror.js`). It presents exactly the shape `createRenderView` returns, so `src/render` does not change.
   - **Buildings.** One stable `buildings` array. Each changed record is applied **in place**: `Object.assign` with the sent fields, plus deleting fields that went away. Removals splice the record out. Records and the array keep their identity, so `lot.record !== b` and `b.rev` work as they do now. `buildingEvents` is forwarded as-is.
   - **Roads.** One stable `roads` object whose grids are patched in place from the rectangle sent. `version`, `embankRev` and so on are copied. `dirty` is set to the union of the rectangles received since the renderer last cleared it, so the renderer's `roads.dirty = null` now lands on the mirror only.
     - A new grid (a restore, or a new town) is sent whole and makes a new `roads` object, which is the one case where the renderer is meant to refill.
     - The worker reads and clears the sim's own `roads.dirty` after each sync, which takes over the renderer's job of clearing it today.
   - **People.**
     - **Rows.** The worker keeps writing rows into its own buffer and sends the dirty range, as a transferred copy; the mirror writes it into a stable main-thread buffer.
     - **Handshake.** `peopleDirty` is kept as a union until the renderer clears it, as today.
     - **Capacity.** `peopleVersion` bumps only when capacity grows.
   - **Small fields.** `bridges`, `lamps`, `embankments`, `attention`, `centres`, `projects`, `time`, `worldEvents`, `weather`, `era`, `archetype` and `styleEra` are sent every step; they are small.
   - **Revision-gated fields.** `aesthetics` and `landscape` are sent only when their revision changes, and their objects are mutated in place on the mirror.

4. **UI snapshot.** `app.js` keeps its structure, but `host.state()` goes away.
   - **Requests.** `doRefresh` asks the host for a snapshot holding:
     - every selector it runs today;
     - the panel selectors in `want`;
     - the inspect bundle (`selectInspect`, `narrativeFacts`, the saved note) for the current target;
     - the raw audio fields, decision stats and `chronicle.entries.length`.
   - **Drawing.** It draws the last snapshot it has, so refreshes never wait. `refresh(true)` after an action uses the snapshot that came back with the action's reply.
   - **Size and cost.** 70–110 KB at 4 Hz, and 0.2–0.4 ms for the worker to compute.
5. **Actions become async.**
   - `host.act` returns a Promise.
   - The six call sites in `app.js` `await` it before showing `M.actionError(result)`. Each control stays disabled until its reply arrives (see risk 3).
   - The worker runs the action between steps; after it (when `ok`), the main thread runs `saveSoon()`.
6. **Services move into the worker.**
   - **Route planner.** `createRoutePlanner()` is created inside the worker and spawns its navigation worker from there. Nested dedicated workers work in Chrome, Firefox and Safari 15.5 and later. Where they don't, it falls back to its cooperative scheduler, which then shares the worker's time but never the frame's.
   - **Decision client.** It moves too, because the scheduler calls `stats()` synchronously. The model-enabled Proxy moves with it. Settings arrive as messages, and stats come back in the snapshot.
   - **Prose keeper.** It runs in the worker with `() => state`.
   - **Inspector notes.** Streaming stays on the main thread. `noteFor` is changed to take the facts and saved note from the snapshot instead of `state`, and to send `notes.set`/`notes.touch` back.
7. **Saves and boot.**
   - **Saves.** `save()` asks the worker for `{text, meta}`, so the 57 ms serialize leaves the main thread. The thumbnail, IndexedDB write, writer claim and toasts stay where they are. `exportSave` works the same way, and `importSave` validates with a `restore` in the worker.
   - **`pagehide`.** It can only post a save. A torn-down page may kill the worker before the write finishes, which is already true of today's async IndexedDB write. The `visibilitychange → hidden` save covers almost every real case.
   - **Boot.** The menu's `openChoice` becomes `host.init(choice)`. The worker creates, restores or fetches the fixture, then replies with `{terrain: {seed, version, archetype}, townName, slot meta, fullDelta}`. The main thread calls `useTerrain(...)` before `createWorld`, so the renderer and `rapidsSources()` see the same valley.
8. **Dev and test hooks.**
   - **Rewrapped hooks.** `window.hearthvale.state()` becomes `hearthvale.snapshot()`, an async whole-state `structuredClone` from the worker that is fine for tests. The `dev.*` hooks become messages.
   - **`hearthvale.inSim(fn, ...args)`.** This is new, for dev and test builds only. It sends `fn.toString()` to the worker, which runs it there with `(state, sim, ...args)` and returns its JSON result. The three specs that import `src/sim` in the page move to it. Their bodies stay the same, apart from `s = window.hearthvale.state()` becoming the `state` argument.
   - **Read-only specs** read the snapshot instead.

### Phases (each lands green: `npm test`, `npx playwright test`)

| | work | days |
|---|---|---|
| P0 | `SimHost` + `InlineHost`. `main.js` and `app.js` go through it: snapshot-driven `doRefresh`, async `act`, notes as messages, the prose keeper behind the host. No worker yet. Behaviour unchanged, which also proves the UI has no other state reads. | 2–3 |
| P1 | `render-mirror.js` plus a Node test. Over N frames of the city fixture, a mirror fed deltas must match the direct view field for field, including the identity rules (same record objects, same `roads` and `tier` objects, unless the grid is replaced). | 2 |
| P2 | `sim-worker.js` + `WorkerHost`: boot/restore/fixture, terrain on both threads, step pacing and reached speed, planner and decision client inside, saves. `?simWorker=0` falls back to inline, and so does a worker failure at boot. | 2–3 |
| P3 | `inSim` and the snapshot test hooks; migrate the eight specs; teach `benchmark-daycycle.js` and `benchmark-desktop.js` to read the worker's step time from the delta (`stepMs`) instead of main-thread timing. | 1–2 |
| P4 | Measure: `benchmark-daycycle.js --speed=20` on the city and the year-165 metro (target: dawn misses about 0 %, main-thread time at dawn about the render's 3 ms plus under 0.5 ms of mirror). Check the `benchmark-city.js` hashes and the worker-vs-inline hash test. PERFORMANCE.md section. | 1 |

## 5. Risks

1. **Live-reference reads that are missed.** The renderer reads `weather`, `worldEvents`, `aesthetics` and `landscape` objects that the sim mutates in place, and some modules compare revisions on them (for example `aesthetics.rev`). The mirror must send each one whenever it changes. P1's field-for-field test is the guard, and it has to cover a year of play, including the restyle and an era change.
2. **Identity rules.** If any mirrored object is replaced when it should have been patched, a whole renderer subsystem rebuilds every frame. The result is slow, not wrong, which makes it easy to miss. The guard is the P1 test, plus `world.stats()` rebuild counters checked in P4.
3. **Latency the player can see.** The UI is at most one frame plus 250 ms behind the sim, as it is today with its throttle. Action results arrive a message later, under 1 ms when the worker is idle. If the click lands during a 20–35 ms tick, the action waits for that tick to finish (still under one rendered frame on most ticks). Card buttons must stay disabled until the reply comes, or a fast double click could rule twice.
4. **Two code paths.** InlineHost and WorkerHost can drift apart. Mitigations: run the Playwright suite in worker mode by default, and keep a smoke run with `?simWorker=0`.
5. **Saves at `pagehide`** are best effort, as noted above. Losing the last up-to-30 s on a hard close is the same exposure as today.
6. **Worker failure.** If the worker dies (an exception or out-of-memory), the state in it is gone. The host would toast, offer to reopen from the last save, and stop the loop, rather than pretend. Today a sim error keeps the town drawn but frozen; that would stay true until the reopen.
7. **Memory and load.**
   - The mirror holds a second copy of the buildings and road grids: about 2 MB in the city.
   - The worker bundle includes `three`'s math (via `sim/outline.js` → `render/kit/compose.js`). That is parsed once, in parallel with the menu.
   - The worker's heap is the town's, as before.
8. **Nested workers in old Safari.** These fall back to the cooperative planner inside the sim worker. That is slower to plan, but still off the main thread.
9. **The dawn-pass changes are not committed yet.** They sit in another worktree. P0 and P2 rewrite the same `frame()`/`step()` code in `main.js`, so that work should land first.

## 6. A smaller alternative: sliced ticks on the main thread

If 8–11 days is too much, the frame misses can be cut without moving state. Make a tick resumable at its two big loops: `checkFootprints`'s walker pass and `stepPeople`'s walker loop. Then yield to the event loop when the slice's budget runs out.

While a tick is half done:
- `view.sync` and `app` refreshes are skipped, and the frame draws the last view;
- route deliveries and player actions are queued and applied at the tick's end, so nothing sees or changes a half tick.

Walker order is unchanged, so the result is bit-identical.

Limits:
- The longest unsliceable pieces stay atomic: the footprint rebuild (about 2.5 ms) and the single heaviest month or year job (up to about 8 ms after the dawn pass).
- It does not take the 57 ms autosave serialize off the main thread.

Estimate: 2–3 days. Risk: it touches `people.js` control flow, which the perf-equivalence tests guard. It is a stopgap. The worker in §4 is the fix that removes the sim from the frame entirely.
