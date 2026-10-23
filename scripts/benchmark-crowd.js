// Crowd scale (docs/design/crowd-scale.md §1): the city fixture with every household's
// size multiplied by k, everyone walking, stepped tick by tick as the sim worker does.
// Per tick: routes.tick (cooperative planner, a clock that never advances, so every
// request is answered within the tick it is due and runs are reproducible), stepTick of
// one tick, view.sync and the mirror's delta (as sim-worker.js), and the mirror's apply.
// Route delivery (people.js setRoute, in the planner's callback) is timed on its own.
//
//   node --single-threaded scripts/benchmark-crowd.js --k=2            # ~10k walkers
//   node --single-threaded scripts/benchmark-crowd.js --k=4 --frozen   # the walker loop alone
//   node scripts/benchmark-crowd.js --k=2 --root=/tmp/base             # another checkout's src/
//
// --frozen calls stepPeople directly and advances time.tick by hand: no month or year
// jobs, no building changes, no population drift. It then forces --changes footprint
// changes (a worldVersion bump each) and times the tick that checks them.
//
// Prints JSON: CPU ms per tick (process.cpuUsage, so robust to a shared machine) and
// wall ms per stage (mean, p50, p95, max), trips and rows per tick, bytes per step, and
// a hash of serialize(state) at the end (the same hash = the same town).
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const opts = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const root = opts.root ? pathToFileURL(resolve(opts.root) + '/').href : new URL('../', import.meta.url).href;
const sim = await import(`${root}src/sim/index.js`);
const {createRoutePlanner} = await import(`${root}src/route-planner.js`);
const peopleMod = await import(`${root}src/sim/people.js`);
const mirrorMod = await import(`${root}src/sim/render-mirror.js`);
const {rng} = await import(`${root}src/sim/rng.js`);
const {addBuildingRecord} = await import(`${root}src/sim/state.js`);
const {bumpWorld} = await import(`${root}src/sim/roads.js`);
const {fixtureState, stepTick, createRenderView, serialize, setIndividualCap, TICK_SECONDS = 0.1} = sim;

const k = Number(opts.k ?? 1);
const warm = Number(opts.warmup ?? 600);
const ticks = Number(opts.ticks ?? 600);
const frozen = 'frozen' in opts;
const changes = Number(opts.changes ?? 5);

const state = fixtureState(opts.fixture ?? 'city');
setIndividualCap(state, null);
if (k !== 1) {
  for (const h of state.households) h.size = Math.max(1, Math.round(h.size * k));
  peopleMod.syncIndividuals(state);
}
const routes = createRoutePlanner({worker: false, clock: () => 0, maxPending: 1e9});
let deliverMs = 0, trips = 0;
const timed = (fn) => (...args) => {
  const t = performance.now();
  try { return fn(...args); } finally { deliverMs += performance.now() - t; }
};
const timedRoutes = {
  ...routes,
  plan: (st, x0, z0, x1, z1, onRoute) => { trips++; return routes.plan(st, x0, z0, x1, z1, timed(onRoute)); },
};
const services = {decisions: null, routes: timedRoutes, now: 0};
// The walker loop's own context, as stepTick makes it (frozen mode).
const peopleCtx = {services, rng: (stream) => rng(state, stream), now: null, skipPeople: false, flags: 0, monthIndex: 0};
const view = createRenderView(state, {rowFloats: 20});
const source = mirrorMod.createMirrorSource({});
const mirror = mirrorMod.createRenderMirror({rowFloats: 20});

const stages = {route: [], deliver: [], step: [], sync: [], delta: [], apply: [], cpu: [], rows: [], bytes: [], trips: []};
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
let now = 0;

function rowsOf(d) {
  const p = d.people;
  if (p.slots) return p.slots.length;
  return p.rows ? p.end - p.start : 0;
}
function bytesOf(transfer) {
  return transfer.reduce((n, b) => n + b.byteLength, 0);
}

function tick(record) {
  now += TICK_SECONDS;
  services.now = now * 1000;
  deliverMs = 0;
  trips = 0;
  const c0 = cpuNow();
  const a = performance.now();
  routes.tick(state, 1e9);
  const b = performance.now();
  const deliverInRoute = deliverMs;
  if (frozen) {
    state.time.tick++;
    peopleMod.stepPeople(state, peopleCtx, TICK_SECONDS);
  } else {
    stepTick(state, TICK_SECONDS, services);
  }
  const c = performance.now();
  view.sync(state, {now, speed: 1});
  const d = performance.now();
  const {delta, transfer} = source.delta(view, state);
  const e = performance.now();
  mirror.apply(delta);
  mirror.view.peopleDirty = null;
  mirror.view.buildingEvents.length = 0;
  const f = performance.now();
  const c1 = cpuNow();
  if (!record) return;
  stages.route.push(b - a - deliverInRoute);
  stages.deliver.push(deliverMs);
  stages.step.push(c - b - (deliverMs - deliverInRoute));
  stages.sync.push(d - c);
  stages.delta.push(e - d);
  stages.apply.push(f - e);
  stages.cpu.push(c1 - c0);
  stages.rows.push(rowsOf(delta));
  stages.bytes.push(bytesOf(transfer.filter((t) => delta.people.rows?.buffer === t || delta.people.ids?.buffer === t || delta.people.slots?.buffer === t)));
  stages.trips.push(trips);
}

const t0 = performance.now();
for (let i = 0; i < warm; i++) tick(false);
for (let i = 0; i < ticks; i++) tick(true);
const walkers = state.people.length;

let footprint = null;
if (frozen && changes > 0) {
  const times = [];
  for (let i = 0; i < changes; i++) {
    // A small house on a leg ahead of one walker under way (the same walker on any
    // checkout of the same town), as a building placed in a busy town would be.
    const walking = state.people.filter((p) => p.task?.route && !p.task.waiting && p.task.seg + 5 < p.task.route.length);
    const w = walking[(i * 7919) % walking.length];
    if (w) {
      const r = w.task.route, s = w.task.seg + 2;
      addBuildingRecord(state, {type: 'home', x: (r[s] + r[s + 2]) / 2, z: (r[s + 1] + r[s + 3]) / 2, w: 3, d: 3});
    }
    bumpWorld(state);
    const a = performance.now();
    state.time.tick++;
    peopleMod.stepPeople(state, peopleCtx, TICK_SECONDS);
    times.push(performance.now() - a);
    for (let j = 0; j < 20; j++) tick(false);
  }
  footprint = times.map((t) => +t.toFixed(2));
}

const q = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const r = (v) => +v.toFixed(3);
  return {mean: r(a.reduce((x, y) => x + y, 0) / (a.length || 1)), p50: r(s[s.length >> 1] ?? 0), p95: r(s[Math.floor(s.length * 0.95)] ?? 0), max: r(s.at(-1) ?? 0)};
};
const out = {
  k, frozen, walkers, year: state.time.year, buildings: state.buildings.length,
  cpuMsPerTick: q(stages.cpu),
  wallMs: {route: q(stages.route), deliver: q(stages.deliver), step: q(stages.step), sync: q(stages.sync), delta: q(stages.delta), apply: q(stages.apply)},
  tripsPerTick: q(stages.trips).mean, rowsPerStep: q(stages.rows).mean, kbPerStep: +(q(stages.bytes).mean / 1024).toFixed(1),
  footprintChangeMs: footprint,
  routes: {...routes.stats},
  heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(0),
  seconds: +((performance.now() - t0) / 1000).toFixed(1),
  hash: createHash('sha256').update(serialize(state)).digest('hex').slice(0, 16),
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n', () => process.exit(0));
