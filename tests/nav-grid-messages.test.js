// The planner sends the worker only what changed in the nav grid (route-planner.js
// gridMessage); the worker must end up with exactly the main thread's grid
// (PERFORMANCE.md, "Route delivery").
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick} from '../src/sim/index.js';
import {navGrid, bumpNav, bumpWorld, addWearAt, setTier, CELLS} from '../src/sim/roads.js';
import {removeBuildingRecord} from '../src/sim/state.js';
import {RouteScheduler} from '../src/navigation.js';

test('the worker rebuilds each grid the planner sends exactly, from what it already has', async () => {
  // The worker module, run here: messages are cloned as postMessage would.
  const received = [];
  const setGrid = RouteScheduler.prototype.setGrid;
  RouteScheduler.prototype.setGrid = function (grid) { received.push(grid); return setGrid.call(this, grid); };
  globalThis.self = {};
  globalThis.postMessage = () => {};
  await import('../src/navigation-worker.js');
  const sent = [];
  globalThis.Worker = class {
    postMessage(m) { sent.push(m); globalThis.self.onmessage({data: structuredClone(m)}); }
    terminate() {}
  };
  const {createRoutePlanner} = await import('../src/route-planner.js');
  try {
    const s = fixtureState('city');
    const planner = createRoutePlanner({worker: true});
    const sim = createRoutePlanner({worker: false});
    let seed = 5;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let round = 0; round < 24; round++) {
      for (let i = 0; i < 5; i++) { sim.tick(s, 1e9); stepTick(s, 0.2, {routes: sim}); }
      if (round % 4 === 0) for (let n = 0; n < 30; n++) addWearAt(s, Math.floor(rand() * CELLS), 500);
      if (round % 5 === 2) for (let n = 0; n < 10; n++) setTier(s, Math.floor(rand() * CELLS), 3);
      if (round % 6 === 3) {
        const b = s.buildings.find((b) => b.type !== 'bridge' && rand() < 0.05);
        if (b) { removeBuildingRecord(s, b.id); bumpWorld(s); }
      }
      if (round % 3 === 0) bumpNav(s);
      const before = received.length;
      planner.sync(s, true);
      const g = navGrid(s);
      if (received.length === before) continue;
      const w = received.at(-1);
      assert.equal(w.key, g.key);
      for (const k of ['cost', 'water', 'height', 'nodeX', 'nodeZ', 'nodeLinks']) assert.deepEqual(w[k], g[k], `${k}, round ${round}`);
    }
    const kept = sent.filter((m) => m.type === 'grid' && m.grid.keep?.length).length;
    const patched = sent.filter((m) => m.type === 'grid' && m.grid.costPatch).length;
    assert.ok(received.length > 10 && kept > 8 && patched > 3, `grids ${received.length}, sharing arrays ${kept}, cost patches ${patched}`);
  } finally {
    RouteScheduler.prototype.setGrid = setGrid;
    delete globalThis.Worker;
  }
});
