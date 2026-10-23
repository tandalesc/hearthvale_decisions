// The sim worker (src/sim-worker.js) gives exactly the town the main thread would: the
// worker module, driven through worker_threads with a synchronous route planner, against
// an inline run of the same frames as main.js stepped them before the worker (routes.tick,
// stepTick, view.sync). Same serialize(state) hash = same simulation output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {fixtureState, stepTick, createRenderView, serialize, PACE} from '../src/sim/index.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {createMirrorSource, createRenderMirror} from '../src/sim/render-mirror.js';

const FRAMES = 360;
const SPEED = 20;
const frameNow = (f) => (f + 1) * 1000 / 60;
const owedOf = (f) => (f % 7 === 3 ? 0.05 : 1 / 60);   // now and then a late frame
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function inlineRun(fixture) {
  const state = fixtureState(fixture);
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  const services = {decisions: null, routes, now: 0, rate: SPEED * PACE};
  const view = createRenderView(state, {rowFloats: 20});
  view.sync(state, {now: 0, speed: 0});
  for (let f = 0; f < FRAMES; f++) {
    const now = frameNow(f);
    services.now = now;
    routes.tick(state);
    stepTick(state, owedOf(f) * SPEED * PACE, services, {until: Infinity});
    view.sync(state, {now: now / 1000, speed: SPEED * PACE});
    // What the mirror's source takes over from the renderer.
    view.peopleDirty = null;
    view.buildingEvents.length = 0;
    state.roads.dirty = null;
  }
  return hash(serialize(state));
}

function startWorker() {
  const worker = new Worker(new URL('./sim-worker-node.js', import.meta.url));
  const pending = new Map();
  let nextId = 1;
  worker.on('message', (data) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error.message));
    else p.resolve(data.value);
  });
  const call = (op, ...args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, op, args});
  });
  return {call, stop: () => worker.terminate()};
}

async function workerRun(fixture) {
  const w = startWorker();
  try {
    await w.call('setup', {entitlement: {tier: 'paid'}, routes: {worker: false, fixedClock: true}, decisions: false, prose: false, model: false, budgetMs: Infinity, pace: PACE});
    const mirror = createRenderMirror({rowFloats: 20});
    const opened = await w.call('init', {kind: 'fixture', name: fixture}, 0);
    assert.ok(opened.info, 'the town opened');
    mirror.apply(opened.delta);
    let ticks = 0;
    for (let f = 0; f < FRAMES; f++) {
      const r = await w.call('step', owedOf(f), frameNow(f), SPEED);
      assert.equal(r.error, null);
      ticks += r.ticks;
      mirror.apply(r.delta);
    }
    const text = await w.call('serialize');
    return {hash: hash(text), ticks, mirror: mirror.view};
  } finally {
    await w.stop();
  }
}

for (const fixture of ['town', 'city']) {
  test(`the worker's ${fixture} matches an inline run of the same frames`, async () => {
    const [inline, worker] = [inlineRun(fixture), await workerRun(fixture)];
    assert.ok(worker.ticks > FRAMES, 'the town ran');
    assert.equal(worker.hash, inline);
    assert.ok(worker.mirror.buildings.length > 50 && worker.mirror.peopleCount > 0, 'the mirror has the town');
  });
}
