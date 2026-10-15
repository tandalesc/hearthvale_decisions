// Navigation over the road grid: sliced A*, flow fields, the route scheduler
// and the worker-free route planner. (Replaces the pre-v2 continuous-space tests.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addBuildingRecord } from '../src/sim/state.js';
import { ensureRoads, navGrid, cellOf, cellIndex, cellXZ, bumpWorld, stepAlongRoute, CELL, ORIGIN_X } from '../src/sim/roads.js';
import {
  RouteScheduler, searchJob, createScratch, findRoute, flowFieldJob, followField, runToEnd, cellsToWaypoints, pathCost,
} from '../src/navigation.js';
import { createRoutePlanner } from '../src/route-planner.js';
import { FORDS, fordAt, heightAt, waterAt, riverX, setTerrainSeed } from '../src/terrain.js';

function blank() {
  setTerrainSeed(null);
  const s = emptyState(3);
  s.roads = undefined;
  s.era = 1;
  ensureRoads(s);
  return s;
}

test('fords are shallow bands across the river; elsewhere it is deep', () => {
  for (const f of FORDS) {
    assert.ok(fordAt(riverX(f.z), f.z));
    assert.ok(heightAt(riverX(f.z), f.z) > -0.35);
    assert.ok(waterAt(riverX(f.z) + 4, f.z));
  }
  assert.equal(fordAt(riverX(40), 40), false);
  assert.ok(heightAt(riverX(40), 40) < -0.7);
  assert.equal(fordAt(riverX(40) - 5.5, 40), false, 'shallow banks are not fords');
  assert.equal(heightAt(3, 4), heightAt(3, 4), 'pure');
});

test('sliced A* yields while it works and matches the one-shot search', () => {
  const s = blank();
  const grid = navGrid(s);
  const from = cellOf(-200, -200), to = cellOf(-40, 150);
  const job = searchJob(grid, createScratch(grid.W * grid.H), from, to);
  let yields = 0, r;
  while (!(r = job.next()).done) yields++;
  assert.ok(yields > 0, 'long searches are sliced');
  const once = findRoute(grid, from, to);
  assert.deepEqual([...r.value.cells], [...once.cells]);
  assert.equal(r.value.cells[0], from);
  assert.equal(r.value.cells.at(-1), to);
  for (let k = 1; k < once.cells.length; k++) {
    const [ax, az] = cellXZ(once.cells[k - 1]), [bx, bz] = cellXZ(once.cells[k]);
    assert.ok(Math.max(Math.abs(ax - bx), Math.abs(az - bz)) === 1, 'steps are to neighbours');
  }
});

test('flow fields give the same routes as A* toward a popular door', () => {
  const s = blank();
  const grid = navGrid(s);
  const goal = cellOf(-60, 0);
  const field = runToEnd(flowFieldJob(grid, createScratch(grid.W * grid.H), goal));
  for (const [x, z] of [[-150, -80], [-100, 120], [-30, 40]]) {
    const from = cellOf(x, z);
    const viaField = followField(field, from);
    const viaSearch = findRoute(grid, from, goal, { hWeight: 0 });
    assert.equal(viaField.at(-1), goal);
    const cost = cells => pathCost(grid, cells);
    assert.ok(Math.abs(cost(viaField) - viaSearch.cost) < 1e-3, 'both are shortest');
  }
});

test('the scheduler dedupes, caches, switches to flow fields and honours its budget', () => {
  const s = blank();
  let clock = 0;
  const q = new RouteScheduler({ clock: () => clock, fieldThreshold: 3 });
  q.setGrid(navGrid(s));
  const goal = cellOf(-60, 10);
  const results = [];
  for (const x of [-200, -190, -180, -170]) assert.ok(q.request(cellOf(x, -100), goal, r => results.push(r)));
  assert.ok(q.request(cellOf(-200, -100), goal, r => results.push(r)), 'duplicate joins the pending job');
  assert.equal(q.jobs.size, 4);
  // A zero budget does no work at all.
  assert.equal(q.tick(0, 1), 0);
  clock = 0;
  const step = () => { clock += 0.001; return clock; };
  q.clock = step;
  for (let i = 0; i < 20000 && q.pending; i++) q.tick(1, 8);
  assert.equal(q.pending, 0);
  assert.equal(results.length, 5);
  assert.ok(results.every(r => r.cells?.at(-1) === goal));
  assert.equal(q.stats.fields, 1, 'popular destination got a flow field');
  q.request(cellOf(-200, -100), goal, r => results.push(r));
  assert.equal(q.stats.cacheHits, 1);
  q.request(cellOf(-150, 60), goal, r => results.push(r));
  assert.ok(q.stats.fieldHits >= 1, 'new origins are served from the field at once');
  assert.equal(results.length, 7);
});

test('new buildings prune only the cached routes they block', () => {
  const s = blank();
  const q = new RouteScheduler();
  q.setGrid(navGrid(s));
  let a, b;
  q.request(cellOf(-150, -100), cellOf(-100, -100), r => (a = r));
  q.request(cellOf(-150, 100), cellOf(-100, 100), r => (b = r));
  while (q.pending) q.tick(50);
  assert.ok(a.cells && b.cells);
  addBuildingRecord(s, { type: 'workshop', x: -125, z: -100, w: 6, d: 6 });
  bumpWorld(s);
  const grid = navGrid(s);
  assert.ok(grid.footprintsOnly);
  q.setGrid(grid);
  assert.equal(q.cache.has(`${cellOf(-150, -100)}>${cellOf(-100, -100)}`), false);
  assert.equal(q.cache.has(`${cellOf(-150, 100)}>${cellOf(-100, 100)}`), true);
});

test('the cooperative planner writes flat routes into tasks and walkers wear them', () => {
  const s = blank();
  const planner = createRoutePlanner({ worker: false });
  assert.equal(planner.stats.mode, 'cooperative');
  const people = [0, 1, 2].map(k => ({ id: k + 1, x: -140 + k, z: -60, task: { kind: 'work', elapsed: 0 } }));
  const goal = { x: -80, z: -30 };
  for (const p of people) assert.ok(planner.request(s, p, goal, p.task));
  for (let i = 0; i < 500 && planner.stats.pending; i++) planner.tick(s, 5);
  for (const p of people) {
    assert.equal(p.task.pending, false);
    assert.equal(p.task.seg, 0);
    const r = p.task.route;
    assert.ok(r.length >= 4 && r.length % 2 === 0, 'flat [x, z, ...]');
    assert.deepEqual(r.slice(0, 2), [p.x, p.z]);
    assert.deepEqual(r.slice(-2), [goal.x, goal.z]);
    while (stepAlongRoute(s, p, 2));
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1e-6);
  }
  assert.ok(s.roads.wearAddedMonth > 0);
  const again = { id: 9, x: -140, z: -60, task: { kind: 'work' } };
  planner.request(s, again, goal, again.task);
  assert.ok(planner.stats.cacheHits >= 1);
  assert.equal(again.task.pending, false, 'cache hits land at once');
  planner.dispose();
});

test('unreachable goals block the task instead of walking through walls', () => {
  const s = blank();
  const planner = createRoutePlanner({ worker: false });
  // A goal sealed inside a ring of buildings.
  for (const [dx, dz] of [[-8, 0], [8, 0], [0, -8], [0, 8], [-8, -8], [8, 8], [-8, 8], [8, -8]]) {
    addBuildingRecord(s, { type: 'workshop', x: -100 + dx, z: 50 + dz, w: 8, d: 8, rot: 0 });
  }
  bumpWorld(s);
  const p = { id: 1, x: -150, z: 50, task: { kind: 'work', elapsed: 0 } };
  planner.request(s, p, { x: -100, z: 50 }, p.task);
  for (let i = 0; i < 2000 && planner.stats.pending; i++) planner.tick(s, 20);
  assert.equal(p.task.blocked, true);
  assert.deepEqual(p.task.route, []);
});

test('waypoints keep only the turns', () => {
  const s = blank();
  const grid = navGrid(s);
  const [cx, cz] = cellXZ(cellOf(-100, -100));
  const cells = Int32Array.from([0, 1, 2, 3, 4].map(k => cellIndex(cx + k, cz)).concat([1, 2, 3].map(k => cellIndex(cx + 4, cz + k))));
  const start = { x: -100.3, z: -100.2 }, goal = { x: -91, z: -93 };
  const w = cellsToWaypoints(grid, cells, start, goal);
  assert.equal(w.length, 6, 'start, the corner, goal');
  assert.equal(w[2], ORIGIN_X + (cx + 4.5) * CELL);
});
