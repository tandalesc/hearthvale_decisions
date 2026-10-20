// Headless main-thread cost of a grown town, as the browser loop runs it: per drawn
// frame, routes.tick + sim.stepTick + view.sync (main.js frame()). Routing runs on
// the cooperative scheduler with a large budget so results are deterministic; its
// time is reported separately because the browser does it in a worker.
//
//   node scripts/benchmark-city.js                      # city fixture, 5x, 60 s of play
//   node scripts/benchmark-city.js --fixture=town --speed=1 --seconds=30
//   node scripts/benchmark-city.js --save=path/to/save.json   # any save text (e.g. a grown metropolis)
//   node --expose-gc scripts/benchmark-city.js ...      # adds heap growth after a full GC
//   node scripts/benchmark-city.js --root=/tmp/base     # the same run on another checkout's src/
//
// Route delivery (people.js setRoute, run in the planner's callback) is on the main
// thread in the browser too, where the worker's answer arrives: `deliver` is its time per
// frame, and `mainThread` is sim + sync + the delivery that ran inside routes.tick (the
// rest of routeCompute is the search, which the browser does in the worker).
//
// Prints JSON: per-frame p50/p95/max for each stage, GC pauses, heap, and a hash of
// the serialized state at the end (same hash = same simulation output).
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance, PerformanceObserver} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const opts = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
// --root=DIR runs another checkout's src/ (e.g. a `git archive` of the baseline commit).
const root = opts.root ? pathToFileURL(resolve(opts.root) + '/').href : new URL('../', import.meta.url).href;
const {fixtureState, restore, stepTick, createRenderView, serialize, PACE} = await import(`${root}src/sim/index.js`);
const {createRoutePlanner} = await import(`${root}src/route-planner.js`);
const fixture = opts.fixture ?? 'city';
const speed = Number(opts.speed ?? 5);
const seconds = Number(opts.seconds ?? 60);
const fps = Number(opts.fps ?? 60);
const warmFrames = Number(opts.warmup ?? 120);

const t0 = performance.now();
const state = opts.save ? restore(readFileSync(opts.save, 'utf8')) : fixtureState(fixture);
const loadMs = performance.now() - t0;
const routes = createRoutePlanner({worker: false});
const view = createRenderView(state, {rowFloats: 20});
let deliverMs = 0;
const timedRoutes = {...routes, plan: (st, x0, z0, x1, z1, onRoute) => routes.plan(st, x0, z0, x1, z1, (route) => {
  const t = performance.now();
  try { onRoute(route); } finally { deliverMs += performance.now() - t; }
})};
const services = {decisions: null, routes: timedRoutes, now: 0};

const gcs = [];
new PerformanceObserver((list) => { for (const e of list.getEntries()) gcs.push(e.duration); }).observe({entryTypes: ['gc']});

const stages = {route: [], sim: [], sync: [], frame: [], deliver: [], main: []};
const dt = 1 / fps;
const frames = Math.round(seconds * fps);
let now = 0;
globalThis.gc?.();
const heap0 = process.memoryUsage().heapUsed;
for (let f = -warmFrames; f < frames; f++) {
  now += dt;
  services.now = now * 1000;
  deliverMs = 0;
  const a = performance.now();
  routes.tick(state, 1e9);
  const b = performance.now();
  const deliverInRoute = deliverMs;
  stepTick(state, dt * speed * PACE, services);
  const c = performance.now();
  view.sync(state, {now, speed: speed * PACE});
  view.peopleDirty = null;
  view.buildingEvents.length = 0;
  const d = performance.now();
  if (f === -1) gcs.length = 0;
  if (f < 0) continue;
  stages.route.push(b - a);
  stages.sim.push(c - b);
  stages.sync.push(d - c);
  stages.frame.push(d - b);
  stages.deliver.push(deliverMs);
  stages.main.push(d - b + deliverInRoute);
}
await new Promise((r) => setTimeout(r, 50));   // let the GC observer deliver
globalThis.gc?.();
const heap1 = process.memoryUsage().heapUsed;
const q = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const r = (v) => +v.toFixed(3);
  return {mean: r(a.reduce((x, y) => x + y, 0) / (a.length || 1)), p50: r(s[s.length >> 1] ?? 0), p95: r(s[Math.floor(s.length * 0.95)] ?? 0), p99: r(s[Math.floor(s.length * 0.99)] ?? 0), max: r(s.at(-1) ?? 0)};
};
process.stdout.write(JSON.stringify({
  fixture: opts.save ?? fixture, speed, seconds, fps, loadMs: +loadMs.toFixed(1),
  town: {year: state.time.year, pop: state.indicators.pop, walkers: state.people.length, buildings: state.buildings.length},
  perFrameMs: {mainThread: q(stages.main), deliver: q(stages.deliver), simPlusSync: q(stages.frame), sim: q(stages.sim), sync: q(stages.sync), routeCompute: q(stages.route)},
  gc: {count: gcs.length, totalMs: +gcs.reduce((x, y) => x + y, 0).toFixed(1), maxMs: +Math.max(0, ...gcs).toFixed(2)},
  heapGrowthMB: globalThis.gc ? +((heap1 - heap0) / 1048576).toFixed(2) : null,
  routes: {...routes.stats},
  hash: createHash('sha256').update(serialize(state)).digest('hex').slice(0, 16),
}, null, 2) + '\n', () => process.exit(0));
