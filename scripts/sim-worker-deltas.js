// What a simulation worker would post to the main thread per drawn frame
// (docs/design/sim-worker.md). Runs the browser loop headless at 20x and 60 fps
// (routes.tick + stepTick + view.sync per frame). For each frame it builds the
// delta a worker would send: changed building records, the dirty road rectangle,
// and the dirty walker rows. It times a structuredClone of that delta (serialize
// plus deserialize, so an upper bound on either thread's share). Frames in the
// first tenth of each year ('dawn', the building burst) are reported apart from
// the rest. It also times the UI's 4 Hz selector bundle (app.js doRefresh).
//
//   node scripts/sim-worker-deltas.js [fixture=city] [years=2] [--root=DIR]
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const rootOpt = process.argv.find((a) => a.startsWith('--root='))?.slice(7);
const root = rootOpt ? pathToFileURL(resolve(rootOpt)).href : new URL('..', import.meta.url).href.replace(/\/$/, '');
const fx = args[0] ?? 'city', years = Number(args[1] ?? 2);
const {fixtureState, stepTick, createRenderView, PACE, TICKS_PER_YEAR} = await import(root + '/src/sim/index.js');
const V = await import(root + '/src/sim/view.js');
const {createRoutePlanner} = await import(root + '/src/route-planner.js');
const state = fixtureState(fx);
const routes = createRoutePlanner({worker: false});
const services = {decisions: null, routes, now: 0};
const view = createRenderView(state, {rowFloats: 20});
const frames = Math.round(years * TICKS_PER_YEAR * 0.1 / (20 * PACE / 60));
const rec = {dawn: [], rest: []};
let now = 0;
const byId = new Map();
for (let f = 0; f < frames; f++) {
  now += 1 / 60;
  services.now = now * 1000;
  routes.tick(state, 1e9);
  const t0 = performance.now();
  stepTick(state, 20 * PACE / 60, services);
  const simMs = performance.now() - t0;
  view.sync(state, {now, speed: 20 * PACE});
  byId.clear(); for (const b of state.buildings) byId.set(b.id, b);
  const ids = new Set(view.buildingEvents.map((e) => e.id));
  const recs = [...ids].map((id) => byId.get(id)).filter(Boolean);
  const d = view.roads.dirty;
  const cells = d ? (d.x1 - d.x0 + 1) * (d.z1 - d.z0 + 1) : 0;
  const pd = view.peopleDirty;
  const rows = pd ? pd.end - pd.start : 0;
  const t1 = performance.now();
  // the delta message: changed building records, the dirty road rectangle (wear, tier, planned), dirty walker rows
  const msg = {b: recs, ev: view.buildingEvents.slice(), rows: view.people.slice(pd?.start * 20 || 0, (pd?.end ?? 0) * 20), ids: view.peopleIds.slice(pd?.start || 0, pd?.end ?? 0),
    wear: cells ? new Float32Array(cells) : null, tier: cells ? new Uint8Array(cells * 2) : null};
  structuredClone(msg);
  const cloneMs = performance.now() - t1;
  view.buildingEvents.length = 0; view.roads.dirty = null; view.peopleDirty = null;
  (view.time.yearT < 0.1 ? rec.dawn : rec.rest).push({simMs, cloneMs, b: recs.length, cells, rows});
}
// selector snapshot at 4 Hz
const snap = () => ({top: V.selectTopBar(state), unlocks: V.selectUnlocks(state), docket: V.selectDocket(state), bodies: V.selectBodies(state), era: V.selectEraProgress(state),
  chronicle: V.selectChronicle(state, {limit: 40}), events: V.selectEvents?.(state), centres: V.selectCentres(state), factions: V.selectFactions(state), season: V.selectBudgetSeason?.(state), advisers: V.selectAdvisers?.(state)});
snap();
let t = performance.now(); let s; for (let i = 0; i < 10; i++) s = snap(); const selMs = (performance.now() - t) / 10;
t = performance.now(); for (let i = 0; i < 10; i++) structuredClone(s); const snapClone = (performance.now() - t) / 10;
const q = (a, k, p) => { const v = a.map((x) => x[k]).sort((x, y) => x - y); return +(v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0).toFixed(2); };
const mean = (a, k) => +(a.reduce((s, x) => s + x[k], 0) / a.length).toFixed(3);
for (const [k, a] of Object.entries(rec)) console.log(fx, k, a.length, 'frames', JSON.stringify({sim: [mean(a, 'simMs'), q(a, 'simMs', .99), q(a, 'simMs', 1)], deltaClone: [mean(a, 'cloneMs'), q(a, 'cloneMs', .99), q(a, 'cloneMs', 1)], buildingsChanged: [mean(a, 'b'), q(a, 'b', .99), q(a, 'b', 1)], roadCells: [mean(a, 'cells'), q(a, 'cells', .99), q(a, 'cells', 1)], rows: [mean(a, 'rows'), q(a, 'rows', 1)]}));
console.log(fx, 'selectors', selMs.toFixed(2), 'ms; snapshot JSON', (JSON.stringify(s).length / 1024).toFixed(0), 'KB; clone', snapClone.toFixed(2), 'ms');
