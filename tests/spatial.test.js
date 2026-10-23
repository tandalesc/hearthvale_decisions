// Navigation over the road grid: sliced A*, flow fields, the route scheduler
// and the worker-free route planner. (Replaces the pre-v2 continuous-space tests.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addBuildingRecord } from '../src/sim/state.js';
import { ensureRoads, navGrid, structuralGrid, setTier, cellOf, cellIndex, cellXZ, bumpWorld, stepAlongRoute } from '../src/sim/roads.js';
import { buildNodes, buildNodeField } from '../src/path-nodes.js';
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
  const planner = createRoutePlanner({ worker: false, clock: () => 0 });
  assert.equal(planner.stats.mode, 'cooperative');
  const people = [0, 1, 2].map(k => ({ id: k + 1, x: -140 + k, z: -60, task: { kind: 'work', elapsed: 0 } }));
  const goal = { x: -80, z: -30 };
  for (const p of people) assert.ok(planner.request(s, p, goal, p.task));
  for (let i = 0; i < 500 && planner.stats.pending; i++) planner.tick(s, 5);
  for (const p of people) {
    assert.equal(p.task.pending, false);
    assert.equal(p.task.seg, 0);
    const r = p.task.route;
    assert.ok(r instanceof Float32Array && r.length >= 4 && r.length % 2 === 0, 'flat [x, z, ...], as float32');
    assert.deepEqual(Array.from(r.slice(0, 2)), [Math.fround(p.x), Math.fround(p.z)]);
    assert.deepEqual(Array.from(r.slice(-2)), [Math.fround(goal.x), Math.fround(goal.z)]);
    while (stepAlongRoute(s, p, 2));
    assert.ok(Math.hypot(p.x - goal.x, p.z - goal.z) < 1e-4);
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
  const planner = createRoutePlanner({ worker: false, clock: () => 0 });
  // A goal sealed inside a ring of buildings.
  for (const [dx, dz] of [[-8, 0], [8, 0], [0, -8], [0, 8], [-8, -8], [8, 8], [-8, 8], [8, -8]]) {
    addBuildingRecord(s, { type: 'workshop', x: -100 + dx, z: 50 + dz, w: 8, d: 8, rot: 0 });
  }
  bumpWorld(s);
  const p = { id: 1, x: -150, z: 50, task: { kind: 'work', elapsed: 0 } };
  planner.request(s, p, { x: -100, z: 50 }, p.task);
  for (let i = 0; i < 2000 && planner.stats.pending; i++) planner.tick(s, 20);
  assert.equal(p.task.blocked, true);
  assert.equal(p.task.route.length, 0);
});

// This used to be 'waypoints keep only the turns' and expected start, the
// corner cell's centre, goal. Waypoints are now pulled straight over open
// ground, so an L of grass cells (no paths, the real terrain's slope costs) is
// one straight leg from start to goal: the corner is no longer a waypoint.
test('an L of open ground is walked as one straight leg', () => {
  const s = blank();
  const grid = navGrid(s);
  const [cx, cz] = cellXZ(cellOf(-100, -100));
  const cells = Int32Array.from([0, 1, 2, 3, 4].map(k => cellIndex(cx + k, cz)).concat([1, 2, 3].map(k => cellIndex(cx + 4, cz + k))));
  const start = { x: -100.3, z: -100.2 }, goal = { x: -91, z: -93 };
  const w = cellsToWaypoints(grid, cells, start, goal);
  assert.deepEqual(w, [start.x, start.z, goal.x, goal.z], 'start, goal');
});

// ---------------------------------------------------------------- waypoints on small grids

// Flat open ground (grass cost), 2-unit cells from the origin; `paths` are
// [x, z] cells worn to a trail, with their nodes from path-nodes.js.
function flatGrid(W = 32, H = 32, paths = []) {
  const cost = new Float32Array(W * H).fill(1.2), water = new Uint8Array(W * H), tier = new Uint8Array(W * H);
  for (const [x, z] of paths) { tier[z * W + x] = 1; cost[z * W + x] = 0.95; }
  return withNodes({ W, H, ox: 0, oz: 0, cell: 2, cost, water, tier });
}
function withNodes(grid) {
  return Object.assign(grid, buildNodes(grid, grid.tier, null));
}
const centreOf = (grid, i) => [grid.ox + (i % grid.W + 0.5) * grid.cell, grid.oz + (Math.floor(i / grid.W) + 0.5) * grid.cell];
// Every cell a walk passes through, sampled finely along its legs.
function cellsWalked(grid, w) {
  const seen = new Set();
  for (let k = 0; k + 3 < w.length; k += 2) {
    const n = Math.ceil(Math.hypot(w[k + 2] - w[k], w[k + 3] - w[k + 1]) / 0.02);
    for (let q = 0; q <= n; q++) {
      const x = w[k] + (w[k + 2] - w[k]) * q / n, z = w[k + 1] + (w[k + 3] - w[k + 1]) * q / n;
      seen.add(Math.floor(z / grid.cell) * grid.W + Math.floor(x / grid.cell));
    }
  }
  return seen;
}
const hasPoint = (w, x, z) => w.some((v, k) => k % 2 === 0 && v === x && w[k + 1] === z);

test('a staircase of path cells is walked along its smoothed nodes, the line the renderer draws', () => {
  // A 4-connected staircase from (4,4) to (14,14), as A* and walkers leave them.
  const stairs = [];
  for (let k = 4; k < 14; k++) stairs.push([k, k], [k + 1, k]);
  const grid = flatGrid(24, 24, stairs);
  const cells = Int32Array.from(stairs.map(([x, z]) => z * grid.W + x));
  const [sx, sz] = centreOf(grid, cells[0]), [gx, gz] = centreOf(grid, cells.at(-1));
  const w = cellsToWaypoints(grid, cells, { x: sx, z: sz }, { x: gx, z: gz });
  // The relaxed nodes (path-nodes.js, as render/paths.js draws them) run as one
  // straight diagonal, so the walk keeps only a few of them.
  const field = buildNodeField(grid, grid.tier, null);
  assert.ok(w.length >= 6, 'by the line\'s nodes, not straight from start to goal');
  for (let k = 2; k + 2 < w.length; k += 2) {
    const hit = stairs.find(([x, z]) => {
      const i = z * grid.W + x;
      return Math.abs(w[k] - field.x[i] * 2) < 1e-5 && Math.abs(w[k + 1] - field.z[i] * 2) < 1e-5;
    });
    assert.ok(hit, `waypoint ${w[k]},${w[k + 1]} is a node`);
    const [cx, cz] = centreOf(grid, hit[1] * grid.W + hit[0]);
    assert.ok(w[k] !== cx || w[k + 1] !== cz, 'not a cell centre');
  }
  assert.deepEqual(w.slice(-2), [gx, gz]);
});

// The drawn corner is now rounded (path-nodes.js relaxes the nodes), so the walk
// may clip the inside corner by a hair; it used to be held to the road's cells
// exactly. It still never cuts across the grass inside the corner.
test('a road corner keeps its corner: walkers never cut from a road across grass', () => {
  const road = [];
  for (let x = 2; x <= 12; x++) road.push([x, 5]);
  for (let z = 6; z <= 15; z++) road.push([12, z]);
  const grid = flatGrid(24, 24, road);
  const cells = Int32Array.from(road.map(([x, z]) => z * grid.W + x));
  const [sx, sz] = centreOf(grid, cells[0]), [gx, gz] = centreOf(grid, cells.at(-1));
  const w = cellsToWaypoints(grid, cells, { x: sx, z: sz }, { x: gx, z: gz });
  // Distance (units) from (x, z) to the nearest road cell.
  const offRoad = (x, z) => Math.min(...road.map(([cx, cz]) => Math.hypot(Math.max(0, cx * 2 - x, x - cx * 2 - 2), Math.max(0, cz * 2 - z, z - cz * 2 - 2))));
  for (let k = 0; k + 3 < w.length; k += 2)
    for (let q = 0; q <= 20; q++) {
      const x = w[k] + (w[k + 2] - w[k]) * q / 20, z = w[k + 1] + (w[k + 3] - w[k + 1]) * q / 20;
      assert.ok(offRoad(x, z) < 0.3, `on the road at ${x.toFixed(2)},${z.toFixed(2)}`);
    }
});

test('a diagonal over open ground is one straight leg, not a 45-degree staircase', () => {
  const grid = flatGrid(32, 32);
  const from = 3 * grid.W + 2, to = 13 * grid.W + 22;
  const { cells } = findRoute(grid, from, to);
  assert.ok(cells.length > 15);
  const start = { x: 5.2, z: 7.1 }, goal = { x: 45.3, z: 26.8 };
  assert.deepEqual(cellsToWaypoints(grid, cells, start, goal), [start.x, start.z, goal.x, goal.z]);
});

test('a shortcut never crosses dearer ground or water, even cheap water', () => {
  // An L of grass around a corner; the straight cut from end to end passes (7,10).
  const L = [];
  for (let x = 2; x <= 12; x++) L.push([x, 5]);
  for (let z = 6; z <= 15; z++) L.push([12, z]);
  const block = 10 * 24 + 7;
  for (const [what, set] of [
    ['a field', g => { g.cost[block] = 9.6; }],
    ['a bridge deck', g => { g.cost[block] = 0.55; g.water[block] = 3; }],
    ['a ford', g => { g.cost[block] = 2.5; g.water[block] = 2; }],
    ['steeper grass', g => { g.cost[block] = 1.3; }],
  ]) {
    const grid = flatGrid(24, 24);
    set(grid);
    const cells = Int32Array.from(L.map(([x, z]) => z * grid.W + x));
    const w = cellsToWaypoints(grid, cells, { x: 5, z: 11 }, { x: 25, z: 31 });
    assert.ok(w.length > 4, `${what}: not one straight cut`);
    assert.equal(cellsWalked(grid, w).has(block), false, `${what}: never crossed`);
    // Still pulled straight where the ground allows: far fewer points than cells.
    assert.ok(w.length / 2 < 8, `${what}: ${w.length / 2} waypoints`);
  }
});

test('fords and bridges keep their cell centres', () => {
  // A deep channel down column 10, a ford across rows 8-10, a bridge deck at (10,20)
  // on a road that steps down a row as it leaves the deck.
  const W = 24, H = 28;
  const road = [];
  for (let x = 3; x <= 10; x++) road.push([x, 20]);
  for (let x = 11; x <= 18; x++) road.push([x, 21]);
  const grid = flatGrid(W, H, road);
  for (let z = 0; z < H; z++) {
    const i = z * W + 10;
    if (z >= 8 && z <= 10) { grid.water[i] = 2; grid.cost[i] = 2.5; }
    else if (z === 20) { grid.water[i] = 3; grid.cost[i] = 0.55; }
    else { grid.water[i] = 1; grid.cost[i] = Infinity; }
  }
  const wet = (w) => {
    for (let k = 2; k + 2 < w.length; k += 2) {
      const i = Math.floor(w[k + 1] / 2) * W + Math.floor(w[k] / 2);
      if (grid.water[i]) assert.deepEqual([w[k], w[k + 1]], centreOf(grid, i), 'a waypoint in the water is its cell centre');
    }
    for (const i of cellsWalked(grid, w)) assert.notEqual(grid.water[i], 1, 'never in deep water');
  };
  // Across the ford on a slant.
  const ford = findRoute(grid, 4 * W + 4, 14 * W + 17);
  const fordCells = [...ford.cells].filter(i => grid.water[i]);
  assert.ok(fordCells.length && fordCells.every(i => grid.water[i] === 2));
  const wf = cellsToWaypoints(grid, ford.cells, { x: 9, z: 9 }, { x: 35, z: 29 });
  wet(wf);
  for (const i of [fordCells[0], fordCells.at(-1)]) assert.ok(hasPoint(wf, ...centreOf(grid, i)), 'enters and leaves the ford at cell centres');
  // Along the road over the bridge: the deck is a path cell whose node is off
  // its centre (pulled toward the road's step), but the walk takes its centre.
  const deck = 20 * W + 10;
  const [dx, dz] = centreOf(grid, deck);
  assert.ok(grid.nodeX[deck] !== dx || grid.nodeZ[deck] !== dz);
  const cells = Int32Array.from(road.map(([x, z]) => z * W + x));
  const wb = cellsToWaypoints(grid, cells, { x: 7, z: 41 }, { x: 37, z: 43 });
  wet(wb);
  assert.ok(hasPoint(wb, dx, dz), 'crosses by the deck centre');
});

test('structural grid nodes patched after tier changes equal a fresh build', () => {
  const s = blank();
  const before = structuralGrid(s);
  assert.equal(before.nodeX.length, before.W * before.H);
  const [cx, cz] = cellXZ(cellOf(-60, -60));
  for (let k = 0; k < 12; k++) { setTier(s, cellIndex(cx + k, cz + (k >> 1)), 1); setTier(s, cellIndex(cx + k + 1, cz + (k >> 1)), 2); }
  setTier(s, cellIndex(cx + 3, cz + 1), 0);
  const patched = structuralGrid(s);
  assert.notEqual(patched, before);
  const fresh = buildNodes(patched, s.roads.tier, s.roads.planned);
  const same = (a, b) => Buffer.from(a.buffer).equals(Buffer.from(b.buffer));
  assert.ok(same(patched.nodeX, fresh.nodeX) && same(patched.nodeZ, fresh.nodeZ), 'patched = fresh');
  const i = cellIndex(cx + 4, cz + 2);
  assert.ok(Number.isFinite(patched.nodeX[i]) && Number.isNaN(before.nodeX[i]));
  // The planner's grid carries the same nodes for the same tiers.
  const live = navGrid(s, { fresh: true });
  assert.ok(same(live.nodeX, fresh.nodeX) && same(live.nodeZ, fresh.nodeZ));
  // A footprint patch after more tier changes (same tier bucket) patches its nodes too.
  setTier(s, cellIndex(cx + 3, cz + 1), 2);
  setTier(s, cellIndex(cx + 20, cz + 9), 1);
  addBuildingRecord(s, { type: 'workshop', x: -20, z: -20, w: 6, d: 6 });
  bumpWorld(s);
  const after = navGrid(s, { fresh: true });
  assert.ok(after.footprintsOnly && after.bucket === live.bucket);
  const again = buildNodes(after, s.roads.tier, s.roads.planned);
  assert.ok(same(after.nodeX, again.nodeX) && same(after.nodeZ, again.nodeZ), 'patched nav nodes = fresh');
  assert.ok(!same(after.nodeX, live.nodeX), 'the tier changes moved nodes');
});
