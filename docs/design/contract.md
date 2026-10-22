# Hearthvale v2 — Integration Contract (authoritative)

Read with: `brief.md` (owner's request), `design-systems.md` (systems spec), `design-visual.md` (visual/UI spec), all in this scratchpad folder. **Where this contract disagrees with a spec, this contract wins.** Branch `evolving-city`. Do not commit; the lead integrates and commits.

## 0. Owner direction that overrides the specs

1. **No god powers.** The player never places buildings or roads. All influence goes through docket cards, policies and institutions. Public works (paving, bridges, squares) are proposals the player approves; the sim decides the exact location.
2. **Saturate the GPU.** The systems spec's question budget (~720/yr, `≤ B·0.6`) is replaced. Base sweeps run at the spec's cadences. **Edge refinement and individual decisions fill all remaining throughput** (~450–590 q/s available). Do not throttle demand artificially.
3. **Population slicing replaces cohorts.** Population-scale kinds are asked once per *overlapping slice* (district, trade, wealth band, life stage, household type, faction…). A person's distribution is the **weighted average** (linear opinion pool) of their slices' distributions, then local hard-fact terms, then masking. Never a product. Nuance is recovered by refinement where slices disagree (Jensen–Shannon × group size), or by individual questions when groups are tiny or the stakes are high. The decision bus (`src/decision-client.js`, `src/routine-policy.js`, `src/decision-kinds.js`, being built by the `decisions` agent) provides `pool()` and refinement. Sim code asks through it and never calls fetch directly.
4. **Shared `state` in requests.** Decision requests carry a structured `state` (town / district / slice / proposal snapshot) plus short per-question text. Share state wherever it makes sense, because the service caches identical states (4,096 entries, 1 h) and reuse is much faster. Exact values (day, money) are fine when a decision needs them.
5. **Thousands of villagers are visible.** The 600 cap in the systems spec becomes `state.settings.individualCap` (default 2,000, Settings range 300–5,000). Up to that many people are simulated as individuals who walk. The rest are aggregate household members. The renderer draws what is in view.
6. **Time.** 1 tick = 100 ms sim at 1×, 1 month = 50 ticks (5 s), 1 year = 600 ticks (60 s), 150 years ≈ 2.5 h. Time of day is **visual only**, driven by season progress as in visual spec §1.2 (spring morning → summer noon → autumn golden → winter dusk, a short night beat at year end). Settings: Seasonal (default) / Slow cycle (one day per real minute) / Off. **No blocking modal at every year end.** The year end gets a non-blocking chronicle banner. Blocking "moment" cards are only for era changes, institution founding and major disasters, and only at 3× and 8× or when the user enables them.
7. **Language.** All player-facing text follows design-systems §10: plain, short sentences, common words, active voice, one idea per sentence, with warm lead-ins and transitions. It is not literal ASD-STE100. UI labels: People, Homes, Food, Coin, Roads, Bodies (institutions), Rules / The Rule Book (policies), Chronicle. Buttons: Do it, Not now, Refuse, Let them decide.
8. **Determinism.** One seeded RNG in state (`rng(state)`). Decision-model answers are applied in a deterministic order (sorted by question key) and logged in `state.answerLog` (ring buffer, 2,000 entries).
9. **Old saves are dropped.** Save `version: 2`. A v1 save shows a short notice and starts a new town.

## 1. Names and enums (shared)

- **Eras** (`state.era`, 0–5): 0 Hamlet, 1 Village, 2 Town, 3 Borough, 4 City, 5 Metropolis. Entry rules: design-systems §2.
- **Style packs** (renderer materials per era index): 0 `hearth` (timber, limewash, thatch), 1 `stone` (fieldstone, tile/slate), 2 `guild` (brick, half-timber, slate), 3 `terrace` (brick rows, stucco), 4 `civic` (dressed stone, stucco, early concrete), 5 `glass` (stucco, glass accents, green roofs). A building stores the era it was built or restyled in (`styleEra`). Cohesion rules: design-visual §1.3.
- **Archetypes:** `market-town | mill | port | garden | cathedral | commune | exchange | scholar` (design-systems §1.4). They bias building variants and props.
- **Road tiers** (Uint8): 0 grass, 1 trail, 2 track, 3 road (gravel), 4 paved (cobbled/setts, planned only), 5 avenue (planned only, era ≥ 3). The A* cost and speed tables are in design-systems §6.2.
- **Building types:** `home, farm, workshop, mill, shop, market, inn, warehouse, chapel, school, moot, park, infirmary, watch, exchange, theatre, factory, quay, bridge, monument, union-hall, library, bathhouse`. Variants and tiers: design-systems §7.

## 2. World geometry

- Terrain stays analytic in `src/terrain.js` (`heightAt`, `riverX`, `waterAt`), shared by sim and renderer. sim-world may add **fords** (shallow river bands where `heightAt` is above −0.35 in a few z-ranges) and must keep the functions pure and cheap. The renderer's water depth reads `heightAt`, so fords render as shallows for free.
- **Road grid:** cell = 2 units, 256×256 cells, origin at (−256, −256), covering the town area −256..256 on both axes. `state.roads = {cell, W, H, ox, oz, wear: Float32Array (raw traffic units), tier: Uint8Array, planned: Uint8Array (bit flags: 1 planned, 2 bridge, 4 lamp, 8 ford), xings: {}}`. Typed arrays are base64-encoded in saves.
- `roads.version` (int) increments on any tier change. `roads.dirty = {x0, z0, x1, z1} | null` (cell coords) is cleared by the renderer after upload. Wear for rendering: `wearNorm = clamp(log1p(wear) / log1p(3000), 0, 1)`.
- Navigation: A* over the road grid's cells, with cost per cell from `roadCost(state, cellIndex)` (tier table, road-adjacent 0.9, water impassable except fords at 2.5 and bridges). Building footprints are impassable except their door cell. A worker runs it (existing `route-planner.js` / `navigation-worker.js` pattern). Route caching keyed by (from-cell, to-cell, roads.version bucket).

## 3. State schema (v2)

Use design-systems §11.1 verbatim, with these changes and additions:

```js
state.version = 2
state.settings = { individualCap: 2000 }
state.time = { tick, month, year }          // speed lives in the UI, not in state
state.slices: computed transient (not saved), owned by sim-governance/decisions
// remove state.cohorts; households keep districtId, trade, wealth for slicing
state.people[i] = {
  id, householdId, homeId, x, z, heading,
  task: { kind: 'work'|'rest'|'shop'|'leisure'|'worship'|'gather'|'build'|'flee'|'travel', targetId, route: [x,z,...] (flat array), seg, elapsed, dwell },
  needs: { energy, fullness, social },          // 0–100
  action: 0..6,                                  // visual: 0 none, 1 carry, 2 build, 3 sit, 4 cheer, 5 protest, 6 dance
  look: { skin, cloth, hat }                     // small ints, palette indices
}
state.buildings[i] = {
  id, type, variant, tier: 1..5, storeys, lotId,
  x, z, rot: 0..3, w, d,                          // world units; footprint is axis-aligned after rot
  styleEra: 0..5, archetype, material,
  wealth: 0..1, condition: 0..1, age (years), built: 0..1 (construction progress; 1 = complete),
  occupied, open, chimney, smoke: 0..1, banner: null|'protest'|'festival'|'plague', lit,
  extensions: [{side:0..3, w, d}], flags: {heritage?, derelict?, scaffold?}
}
state.projects[i] = { id, kind: 'build'|'upgrade'|'pave'|'bridge'|'demolish'|..., buildingId|null, cells|null, progress, workRequired, workers: [personId], payer: 'treasury'|'household:<id>'|'enterprise:<id>'|'body:<id>' }
state.worldEvents = [ { id, kind: 'market'|'festival'|'protest'|'wedding'|'funeral'|'fire'|'flood'|'strike'|'procession', x, z, radius, strength, faction?, t0, t1 } ]   // for rendering crowds and props
state.weather = { rain: 0..1, wind: [x,z], snow: 0..1 }
```

Money: keep the existing double-entry spirit (treasury, businessCash, household wealth, external flows) so money is conserved. Tests should keep a conservation check.

## 4. Module ownership (agents work in parallel in the same tree. Touch only what you own. Coordinate through SendMessage by agent name.)

| agent | owns | delivers early |
|---|---|---|
| `sim-core` | `src/sim/{rng,clock,conditions,pressures,eras,state,economy,households,enterprises,people,serialize,index,fixtures,render-view}.js`, `src/simulation.js` (becomes a thin facade re-exporting `src/sim/index.js`), tests `tests/sim-core.test.js` etc. Deletes obsolete `tests/simulation.test.js` once replaced. | **Within its first hour:** `createState()`, `stepTick(state, dt, services)` with stubs, `serialize/restore`, `fixtures.js` with `fixtureState(name)` for `'hamlet'`, `'town'` (era 2, ~600 people, ~150 buildings, wear field with roads, 3 institutions, docket), `'city'` (era 4, ~3,000 people, ~1,200 buildings), and `render-view.js`. Then message `artisan-render`, `artisan-ui`, `sim-world` and `sim-governance` that they exist. |
| `sim-world` | `src/sim/{roads,sites,buildings,districts,works}.js`, `src/navigation.js`, `src/navigation-worker.js`, `src/route-planner.js`, `src/spatial.js` (rewrite or retire), `src/terrain.js` (fords only), tests `tests/sim-world.test.js`, `tests/spatial.test.js` (replace) | `roadCost`, wear accumulation API `addWear(state, x, z, amount)`, `proposeSites(state, need)` |
| `sim-governance` | `src/sim/{policies,institutions,docket,events,factions,chronicle,view}.js`, `src/sim/text/voice.js`, `src/sim/decisions/{kinds,effects,scheduler,slices}.js`, tests `tests/sim-governance.test.js` | `view.js` selectors for the UI (§5) |
| `decisions` (already running) | `server/system1.js`, `src/decision-kinds.js`, `src/decision-client.js`, `src/routine-policy.js`, tests `system1/performance` | `ask`, `pool`, refinement API |
| `artisan-render` | `src/render/**` (new), retires `src/world.js`, `src/people-renderer.js`, `src/crowd-lod.js`, `src/static-town.js` once replaced. Tests `tests/render-*.test.js` (pure helpers only). | `createWorld()` API (§6) |
| `artisan-ui` | `src/ui/**`, `src/audio/**`, `src/main.js`, `src/style.css` (may split into `src/ui/*.css`), `index.html`, `public/**`, `tests/browser/**`, `playwright.config.js` | App shell that runs on fixtures early |

Shared rule: if you need a change in a file you don't own, message its owner with the exact request. Never edit another agent's file.

## 5. Sim → UI view models (`src/sim/view.js`, owned by sim-governance; pure functions of state)

- `selectTopBar(state)` → `{year, month, season, era, eraName, people, coin, coinTrend, food, foodMonths, wellbeing}`
- `selectDocket(state)` → Card[] using design-visual §10.1 `Proposal` plus `kind` ('proposal'|'petition'|'event'|'demand'|'debate'|'report'), `from` body id, `expiresInMonths`.
- `selectBodies(state)` → design-visual §10.1 `institutions` shape (with `status`, `power`, `patience`, `delegated`, `metrics[].series` (up to 60 points), `docketCount`, `rules`).
- `selectRuleBook(state)` → categories → policies `{id, title, summary, level, maxLevel, since, by, tensions: [ids], againstGrain: bool}`.
- `selectTensions(state)`, `selectFactions(state)` (`{id, name, size, mood, trend}`), `selectChronicle(state, {limit})`, `selectEraProgress(state)` (conditions toward the next era as `{label, met, progress}`), `selectUnlocks(state)` (which UI surfaces are open: per design-systems §2 table 'UI surfaces' row and §9.2), `selectInspect(state, {buildingId|personId})`.
- Actions (mutations) exported from `src/sim/index.js`: `rule(state, cardId, optionKey)`, `setDelegated(state, bodyId, bool, cap)`, `dissolveBody(state, bodyId)`, `setStandingOrder(...)`. The UI never mutates state directly.

## 6. Sim → renderer (`src/sim/render-view.js` owned by sim-core; `createWorld` owned by artisan-render)

```js
const view = createRenderView(state)   // owns typed buffers; call view.sync(state) once per frame (cheap, incremental)
view.buildings  // array of building records (§3); view.buildingEvents: [{kind:'add'|'update'|'remove', id}] since the last sync
view.people     // Float32Array rows of 16: [x,y,z, vx,vy,vz, t0, phase, speed, action, actionT0, skin, cloth, hat, scale, facing]
view.peopleCount; view.peopleDirty: {start, end} | null   // y = ground/bridge height at that point
view.roads      // state.roads (wear, tier, planned, dirty, version, cell, W, H, ox, oz)
view.bridges    // [{id, z, x0, x1, style:'timber'|'stone'|'iron', built:0..1}]
view.lamps      // [{x,z}]
view.worldEvents, view.weather, view.time {year, month, season 0..3, seasonT 0..1, yearT 0..1}, view.era, view.archetype
view.projects   // construction sites [{id, x, z, w, d, progress, kind}]
```

The renderer API (artisan-render) is

```js
const world = createWorld(canvas, {quality:'auto'})
world.update(view, timeSeconds, dtSeconds)
world.setQuality('auto'|'low'|'medium'|'high'); world.quality()   // the resolved tier
world.setDayCycle('seasonal'|'slow'|'off'); world.setOverlay('none'|'value'|'roads'|'health'); world.focus({x,z}, ms)
world.onPick(cb)  // cb({buildingId}|{personId}|{x,z}) on a tap or click without drag
world.stats()     // {fps, frameMs, drawCalls, triangles, tier}
world.setSceneInsets({top,right,bottom,left})  // UI tells the renderer which pixels are covered so framing centres in the free area
world.dispose()
```

## 7. Main loop (artisan-ui owns main.js)

```
frame(now):
  dt = min(Δ, 0.1); simDt = dt * speed
  stepTick(state, simDt, services)   // services = {decisions: decisionClient, routes: routePlanner, now}
  view.sync(state); world.update(view, now/1000, dt)
  ui.update(state)   // via selectors; throttle heavy panels to 4 Hz
  autosave every 30 s (serialize off the frame where possible)
```
`stepTick` is budgeted (≤ 4 ms on M-series at 3,000 people). Month and year processing may be spread across ticks.

## 8. Quality bar

- Each agent runs `npm test` (its own tests must pass; tell the owner if someone else's test breaks) and `npm run build` before reporting.
- Readable code in new modules (normal formatting, short functions, brief comments where intent is not obvious). No minified one-liners.
- Performance targets: design-visual header (iPhone 15 Pro medium: ≤ 8 ms GPU, ≤ 4 ms JS, ≤ 150 draw calls with 3,000 buildings and 3,000 villagers).
- Report back: files changed, public APIs, test results, known gaps. Keep it concise.
