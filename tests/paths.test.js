// Orderly paths: worn paths drawn as continuous strips (render/paths.js), braids
// that close into one lane, one-cell gaps that bridge, and derelict buildings
// in the way of trodden paths that come down (sim/roads.js, sim/reclaim.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addBuildingRecord } from '../src/sim/state.js';
import { runPhase } from '../src/sim/hooks.js';
import {
  ensureRoads, monthlyRoads, setTier, cellOf, cellIndex, cellXZ, footprints, bumpWorld, UPGRADE_AT, __test,
} from '../src/sim/roads.js';
import { reclaimDerelicts, inTheWay, RECLAIM_AFTER } from '../src/sim/reclaim.js';
import { workAtSite, projectById } from '../src/sim/buildings.js';
import { setTerrainSeed } from '../src/terrain.js';
import { createPathField, PATH_K, PATH_RANGE } from '../src/render/paths.js';
import { buildNodeField, patchNodeField, NODE_MARGIN } from '../src/path-nodes.js';
import '../src/sim/index.js';

function blank(era = 1) {
  setTerrainSeed(null);
  const s = emptyState(7);
  s.roads = undefined;
  s.era = era;
  ensureRoads(s);
  runPhase('init', s, { services: {} });
  return s;
}

// ---------------------------------------------------------------- render field

function smallRoads(W = 24, H = 24) {
  return { cell: 2, W, H, ox: 0, oz: 0, wear: new Float32Array(W * H), tier: new Uint8Array(W * H), planned: new Uint8Array(W * H), version: 1 };
}

// Signed distance (world units, > 0 inside) at a world point, bilinear as the GPU samples it.
function sdAt(field, x, z) {
  const fx = x / 2 * PATH_K - 0.5, fz = z / 2 * PATH_K - 0.5;
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const at = (a, b) => field.data[(b * field.TW + a) * 2];
  const val = (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  return (val / 255 - 0.5) * 2 * PATH_RANGE;
}

test('a staircase of trail cells draws one continuous diagonal strip', () => {
  const r = smallRoads();
  // A 4-connected staircase from (4,4) to (14,14), as A* and walkers leave them.
  for (let k = 4; k < 14; k++) {
    r.tier[k * r.W + k] = 1; r.wear[k * r.W + k] = 100;
    r.tier[k * r.W + k + 1] = 1; r.wear[k * r.W + k + 1] = 100;
  }
  const f = createPathField(r);
  assert.ok(f.update(r).length > 0);
  // Along the diagonal between the steps, the strip never breaks...
  for (let t = 5.5; t <= 12.5; t += 0.1) {
    const x = (t + 0.5) * 2 + 1, z = (t + 0.5) * 2;
    assert.ok(sdAt(f, x, z) > 0.1, `inside at ${x.toFixed(1)},${z.toFixed(1)}`);
  }
  // ...and it is a narrow line, not the whole two-cell-wide staircase.
  assert.ok(sdAt(f, 9 * 2 + 1.9, 7 * 2 + 0.1) < 0, 'the outer corner of a step is grass');
});

test('a lone worn cell draws no strip; a paved row is a strip as wide as its cells', () => {
  const r = smallRoads();
  r.tier[5 * r.W + 5] = 2; r.wear[5 * r.W + 5] = 600;
  for (let x = 10; x < 14; x++) { r.tier[12 * r.W + x] = 4; r.planned[12 * r.W + x] = 1; r.wear[12 * r.W + x] = 2000; }
  const f = createPathField(r);
  f.update(r);
  assert.ok(sdAt(f, 11, 11) < -0.5, 'a lone cell stays bare dirt');
  for (let x = 21; x < 27; x += 0.3) assert.ok(sdAt(f, x, 24.1) > 0 && sdAt(f, x, 25.9) > 0, `paving spans the row at ${x.toFixed(1)}`);
});

test('a wide paved block reads solid inside, with no dips between its rows of cells', () => {
  const r = smallRoads();
  for (let z = 8; z < 12; z++) for (let x = 6; x < 14; x++) { const i = z * r.W + x; r.tier[i] = 4; r.planned[i] = 1; r.wear[i] = 2000; }
  const f = createPathField(r);
  f.update(r);
  for (let x = 16; x <= 24; x += 0.5) for (const z of [18, 20, 22]) assert.ok(sdAt(f, x, z) > 0.6, `deep at ${x},${z}: ${sdAt(f, x, z).toFixed(2)}`);
});

test('incremental updates match a full rebuild and touch only nearby tiles', () => {
  const r = smallRoads(48, 48);
  for (let x = 2; x < 46; x++) { r.tier[20 * r.W + x] = 2; r.wear[20 * r.W + x] = 500; }
  const f = createPathField(r);
  f.update(r);
  r.tier[21 * r.W + 30] = 1; r.wear[21 * r.W + 30] = 80;
  for (let z = 22; z < 40; z++) { r.tier[z * r.W + 30] = 1; r.wear[z * r.W + 30] = 80; }
  r.tier[20 * r.W + 10] = 3; r.wear[20 * r.W + 10] = 1300;
  const rects = f.update(r);
  assert.ok(rects.length > 0 && rects.length < 24, `${rects.length} tiles redrawn`);
  assert.equal(f.update(r).length, 0, 'nothing more to do');
  const fresh = createPathField(r);
  fresh.update(r);
  assert.deepEqual(f.data, fresh.data);
});

// ---------------------------------------------------------------- path nodes (path-nodes.js)

const DIAGONALS = (1 << 0) | (1 << 2) | (1 << 5) | (1 << 7);
function trailRoads(W, H, cells) {
  const r = smallRoads(W, H);
  for (const [x, z] of cells) { r.tier[z * W + x] = 1; r.wear[z * W + x] = 100; }
  return r;
}
const nodesOf = (r) => buildNodeField(r, r.tier, r.planned);
const degree = (m) => { let n = 0; for (; m; m &= m - 1) n++; return n; };

test('a T-junction: three arms meet at one node, straight into it, with no web of links', () => {
  const cells = [];
  for (let x = 2; x <= 20; x++) cells.push([x, 10]);
  for (let z = 11; z <= 20; z++) cells.push([11, z]);
  const r = trailRoads(24, 24, cells);
  const n = nodesOf(r);
  const J = 10 * 24 + 11;
  assert.equal(degree(n.links[J]), 3, 'the junction links west, east and south');
  for (const [x, z] of cells) {
    const i = z * 24 + x;
    assert.equal(n.links[i] & DIAGONALS, 0, `no diagonal link at ${x},${z}`);
    if (i !== J) assert.ok(degree(n.links[i]) <= 2, `${x},${z} is on a line`);
  }
  assert.ok(Math.abs(n.x[J] - 11.5) < 0.02 && Math.abs(n.z[J] - 10.5) < 0.02, `meets where the arms cross: ${n.x[J]},${n.z[J]}`);
  for (const [x, z] of cells) {
    const i = z * 24 + x;
    if (z === 10) assert.ok(Math.abs(n.z[i] - 10.5) < 0.05, `the road runs straight at ${x}: z ${n.z[i]}`);
    else assert.ok(Math.abs(n.x[i] - 11.5) < 0.05, `the arm runs straight at ${z}: x ${n.x[i]}`);
  }
  // Drawn: the strip is continuous into the junction, the inside corners stay grass.
  const f = createPathField(r);
  f.update(r);
  for (let x = 6; x <= 38; x += 0.5) assert.ok(sdAt(f, x, 21) > 0.1, `along the road at ${x}`);
  for (let z = 21; z <= 38; z += 0.5) assert.ok(sdAt(f, 23, z) > 0.1, `along the arm at ${z}`);
  assert.ok(sdAt(f, 21.6, 22.4) < 0 && sdAt(f, 24.4, 22.4) < 0, 'no fill in the inside corners');
});

test('a crossroads meets at one node of four links, every arm straight', () => {
  const cells = [];
  for (let x = 2; x <= 20; x++) cells.push([x, 10]);
  for (let z = 2; z <= 20; z++) if (z !== 10) cells.push([11, z]);
  const n = nodesOf(trailRoads(24, 24, cells));
  const J = 10 * 24 + 11;
  assert.equal(n.links[J], (1 << 1) | (1 << 3) | (1 << 4) | (1 << 6), 'north, west, east, south');
  assert.ok(Math.abs(n.x[J] - 11.5) < 1e-6 && Math.abs(n.z[J] - 10.5) < 1e-6);
  for (const [x, z] of cells) {
    const i = z * 24 + x;
    assert.equal(n.links[i] & DIAGONALS, 0);
    assert.ok(z === 10 ? Math.abs(n.z[i] - 10.5) < 1e-6 : Math.abs(n.x[i] - 11.5) < 1e-6, `straight at ${x},${z}`);
  }
});

test('a staircase relaxes into a straight diagonal, each node within its own cells', () => {
  // A 4-connected staircase, as A* and walkers leave them: (k,k) and (k+1,k).
  const cells = [];
  for (let k = 4; k < 18; k++) cells.push([k, k], [k + 1, k]);
  const r = trailRoads(24, 24, cells);
  const n = nodesOf(r);
  const off = [];
  for (const [x, z] of cells) {
    const i = z * 24 + x, px = n.x[i], pz = n.z[i];
    // Its own cell, or a hair into a path cell beside it; never into grass.
    const m = NODE_MARGIN + 1e-6;
    assert.ok(px >= x - m && px <= x + 1 + m && pz >= z - m && pz <= z + 1 + m, `${x},${z} stays home: ${px},${pz}`);
    const cx = Math.floor(px), cz = Math.floor(pz);
    assert.ok(r.tier[cz * 24 + cx] >= 1, `${x},${z}'s node is on a path cell`);
    off.push(px - pz);
  }
  // Away from the ends, every node is on one line x - z = c (it was a zigzag of
  // +-0.17 cells about it, one averaging pass from the cell centres).
  const mid = off.slice(6, -6);
  const c = mid.reduce((a, b) => a + b, 0) / mid.length;
  for (const v of mid) assert.ok(Math.abs(v - c) < 0.03, `on the diagonal: ${(v - c).toFixed(3)}`);
});

test('trails meeting at a little lump of cells meet at one point', () => {
  // A 2 x 2 lump at (10..11, 10..11) with trails west, east and south.
  const cells = [[10, 10], [11, 10], [10, 11], [11, 11]];
  for (let x = 2; x < 10; x++) cells.push([x, 10]);
  for (let x = 12; x < 20; x++) cells.push([x, 11]);
  for (let z = 12; z < 20; z++) cells.push([10, z]);
  const n = nodesOf(trailRoads(24, 24, cells));
  const lump = [10 * 24 + 10, 10 * 24 + 11, 11 * 24 + 10, 11 * 24 + 11];
  for (const i of lump) assert.ok(n.x[i] === n.x[lump[0]] && n.z[i] === n.z[lump[0]], 'one node for the lump');
  assert.ok(n.x[lump[0]] >= 10 && n.x[lump[0]] <= 12 && n.z[lump[0]] >= 10 && n.z[lump[0]] <= 12, 'within its cells');
  // A planned 2 x 2 (a little paved square) keeps its corners instead.
  const r = trailRoads(24, 24, cells);
  for (const i of lump) r.planned[i] = 1;
  const p = nodesOf(r);
  assert.ok(p.x[lump[0]] !== p.x[lump[3]], 'a planned square is not a knot');
});

test('patched nodes equal a fresh build after scattered changes', () => {
  const W = 64, H = 64;
  const cells = [];
  for (let x = 2; x < 60; x++) cells.push([x, 20], [x, 40]);
  for (let z = 5; z < 60; z++) cells.push([30, z], [Math.floor(z / 2) + 5, z]);
  const r = trailRoads(W, H, cells);
  const n = nodesOf(r);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let round = 0; round < 20; round++) {
    const dirty = new Set();
    for (let k = 0; k < 1 + (round % 4) * 3; k++) {
      const [x, z] = cells[Math.floor(rnd() * cells.length)];
      const i = Math.min(W * H - 1, Math.max(0, (z + Math.floor(rnd() * 3) - 1) * W + x + Math.floor(rnd() * 3) - 1));
      if (rnd() < 0.8) r.tier[i] = r.tier[i] ? 0 : 2; else r.planned[i] ^= 1;
      dirty.add(i);
    }
    patchNodeField(r, r.tier, r.planned, n, dirty);
    const fresh = nodesOf(r);
    assert.ok(Buffer.from(n.x.buffer).equals(Buffer.from(fresh.x.buffer)) && Buffer.from(n.z.buffer).equals(Buffer.from(fresh.z.buffer)) &&
      Buffer.from(n.links.buffer).equals(Buffer.from(fresh.links.buffer)), `round ${round}`);
  }
});

// ---------------------------------------------------------------- formation

test('a fainter braid beside a busy lane drifts onto it and fades', () => {
  const s = blank(1);
  const [cx0, cz] = cellXZ(cellOf(-120, 60));
  const lane = [], braid = [];
  for (let x = cx0; x < cx0 + 20; x++) { lane.push(cellIndex(x, cz)); braid.push(cellIndex(x, cz + 1)); }
  for (let m = 0; m < 48; m++) {
    for (const i of lane) s.roads.wear[i] += 40;
    for (const i of braid) s.roads.wear[i] += 4;
    monthlyRoads(s);
  }
  assert.ok(lane.every(i => s.roads.tier[i] >= 2), 'the lane is a track');
  assert.ok(braid.every(i => s.roads.tier[i] === 0), 'the braid has closed into the lane');
});

test('a crossing path keeps its wear where it meets a lane', () => {
  const s = blank(1);
  const [cx, cz] = cellXZ(cellOf(-120, 60));
  const lane = [], cross = [];
  for (let x = cx - 10; x < cx + 10; x++) lane.push(cellIndex(x, cz));
  for (let z = cz + 1; z < cz + 10; z++) cross.push(cellIndex(cx, z));
  for (let m = 0; m < 48; m++) {
    for (const i of lane) s.roads.wear[i] += 40;
    for (const i of cross) s.roads.wear[i] += 6;
    monthlyRoads(s);
  }
  assert.ok(cross.every(i => s.roads.tier[i] >= 1), 'the crossing path stays a trail right up to the lane');
});

test('a one-cell break in a line bridges; the strip between two parallel paths does not', () => {
  const s = blank(1);
  const [cx0, cz] = cellXZ(cellOf(-120, 60));
  for (let x = cx0; x < cx0 + 12; x++) {
    if (x === cx0 + 6) continue;
    s.roads.wear[cellIndex(x, cz)] = 500; setTier(s, cellIndex(x, cz), 2);
  }
  const gap = cellIndex(cx0 + 6, cz);
  s.roads.wear[gap] = 150;
  // Two parallel trails two cells apart, with some wear between them.
  for (let x = cx0; x < cx0 + 12; x++) {
    for (const z of [cz + 6, cz + 8]) { s.roads.wear[cellIndex(x, z)] = 100; setTier(s, cellIndex(x, z), 1); }
    s.roads.wear[cellIndex(x, cz + 7)] = 40;
  }
  __test.bridgeGaps(s);
  assert.equal(s.roads.tier[gap], 2, 'the gap takes the line tier');
  assert.ok(s.roads.wear[gap] >= UPGRADE_AT[2]);
  for (let x = cx0 + 1; x < cx0 + 11; x++) assert.equal(s.roads.tier[cellIndex(x, cz + 7)], 0, 'parallel paths stay apart');
});

// ---------------------------------------------------------------- derelicts

// A derelict mill sitting across a busy east-west lane.
function millInTheWay() {
  const s = blank(1);
  s.treasury = 5000;
  const mill = addBuildingRecord(s, { type: 'mill', x: -100, z: 60, w: 5.4, d: 5.4, tier: 1, built: 1 });
  mill.flags = { derelict: 1 };
  mill.occupied = false;
  bumpWorld(s);
  const [, cz] = cellXZ(cellOf(-100, 60));
  const [cxa] = cellXZ(cellOf(-130, 60));
  const fp = footprints(s);
  for (let x = cxa; x < cxa + 30; x++) {
    const i = cellIndex(x, cz);
    if (fp.blocked[i]) continue;
    s.roads.wear[i] = 600; setTier(s, i, 2);
  }
  // The detour round the north side.
  const [mx0, , mx1] = (() => { const c = cellXZ(cellOf(-104, 60))[0], d = cellXZ(cellOf(-96, 60))[0]; return [c - 1, 0, d + 1]; })();
  for (let x = mx0; x <= mx1; x++) { const i = cellIndex(x, cz - 3); s.roads.wear[i] = 600; setTier(s, i, 2); }
  return { s, mill, cz };
}

test('a derelict building across a trodden path comes down after some years, and the path runs straight through', () => {
  const { s, mill, cz } = millInTheWay();
  assert.ok(inTheWay(s, mill), 'traffic presses on both sides');
  for (let y = 1; y < RECLAIM_AFTER; y++) assert.deepEqual(reclaimDerelicts(s), [], `still standing in year ${y}`);
  assert.deepEqual(reclaimDerelicts(s), [mill.id]);
  const project = s.projects.find(p => p.kind === 'demolish' && p.buildingId === mill.id);
  assert.ok(project, 'pulled down');
  assert.ok(s.chronicle.entries.some(e => /came down/.test(e.text)));
  for (let i = 0; i < 5000 && projectById(s, project.id); i++) workAtSite(s, project.id, 0.5, 3);
  assert.ok(!s.buildings.some(b => b.id === mill.id), 'gone');
  monthlyRoads(s);
  const [x0] = cellXZ(cellOf(-104, 60)), [x1] = cellXZ(cellOf(-96, 60));
  for (let x = x0; x <= x1; x++) assert.ok(s.roads.tier[cellIndex(x, cz)] >= 2, `the lane runs through the old lot at ${x}`);
  assert.equal(s.roads.reclaim.length, 0);
});

test('heritage, occupied and out-of-the-way derelicts stay standing', () => {
  const { s, mill } = millInTheWay();
  mill.flags.heritage = 1;
  const lone = addBuildingRecord(s, { type: 'mill', x: 60, z: -120, w: 5.4, d: 5.4, tier: 1, built: 1 });
  lone.flags = { derelict: 1 };
  bumpWorld(s);
  for (let y = 0; y < RECLAIM_AFTER + 3; y++) assert.deepEqual(reclaimDerelicts(s), []);
  assert.equal(inTheWay(s, lone), null);
});

test('a pending reclaim survives save and restore exactly', async () => {
  const { serialize, restore, stepTick } = await import('../src/sim/index.js');
  const { s, mill } = millInTheWay();
  mill.derelictYears = RECLAIM_AFTER - 1;
  reclaimDerelicts(s);
  assert.equal(s.roads.reclaim.length, 1);
  const saved = serialize(s);
  const a = restore(saved), b = restore(saved);
  for (let k = 0; k < 400; k++) { stepTick(a, 0.1, {}, { skipPeople: true }); stepTick(b, 0.1, {}, { skipPeople: true }); }
  assert.equal(serialize(a), serialize(b));
});

// ---------------------------------------------------------------- waypoints near water

// A small grid: land, a deep channel down column 5, a ford band across it at rows 5-8.
function fordGrid() {
  const W = 12, H = 12;
  const cost = new Float32Array(W * H).fill(1), water = new Uint8Array(W * H);
  for (let z = 0; z < H; z++) {
    const i = z * W + 5;
    if (z >= 5 && z <= 8) { water[i] = 2; cost[i] = 2.5; } else { water[i] = 1; cost[i] = Infinity; }
  }
  return { W, H, ox: 0, oz: 0, cell: 2, cost, water };
}

function legsTouchDeep(grid, w) {
  for (let k = 0; k + 3 < w.length; k += 2) {
    const n = Math.ceil(Math.hypot(w[k + 2] - w[k], w[k + 3] - w[k + 1]) / 0.05);
    for (let q = 0; q <= n; q++) {
      const x = w[k] + (w[k + 2] - w[k]) * q / n, z = w[k + 1] + (w[k + 3] - w[k + 1]) * q / n;
      if (grid.water[Math.floor(z / 2) * grid.W + Math.floor(x / 2)] === 1) return [x, z];
    }
  }
  return null;
}

test('a route that starts away from its first cell never cuts through deep water beside a ford', async () => {
  const { cellsToWaypoints } = await import('../src/navigation.js');
  const grid = fordGrid();
  const at = (x, z) => z * grid.W + x;
  // Planned from (4,6) across the ford and on south; the walker now stands at
  // (4,3), south-west of the ford, so a straight line to the first turn
  // would cross the deep channel.
  const cells = [at(4, 6), at(5, 6), at(6, 6), at(7, 6), at(7, 5), at(7, 4)];
  const plain = [9, 7, 15, 13, 15, 9];   // what a straight first leg would be
  assert.ok(legsTouchDeep(grid, plain), 'the naive first leg is wet');
  const w = cellsToWaypoints(grid, cells, { x: 9, z: 7 }, { x: 15.4, z: 9.3 });
  assert.equal(legsTouchDeep(grid, w), null, `dry legs: ${w.join(',')}`);
  assert.deepEqual(w.slice(0, 4), [9, 7, 9, 13], 'by the first cell, then on');
  // A goal in the deep channel is never entered: the walk ends on the ford.
  const g = cellsToWaypoints(grid, [at(4, 6), at(5, 6)], { x: 9, z: 13 }, { x: 11, z: 9.2 });
  assert.equal(legsTouchDeep(grid, g), null);
});

test('a towpath follows the bank as one even lane, however deep its cells are laid', async () => {
  const { riverX, bankDistance } = await import('../src/terrain.js');
  const { TOW_BANK } = await import('../src/render/paths.js');
  // The real grid around the river's west bank, z 20..80: a towpath band one to
  // three cells deep, stepping with the curving bank.
  const W = 384, H = 384, cell = 2, ox = -384, oz = -384;
  const r = { cell, W, H, ox, oz, wear: new Float32Array(W * H), tier: new Uint8Array(W * H), planned: new Uint8Array(W * H), version: 1 };
  for (let z = 20; z < 80; z += 2) {
    const depth = 1 + ((z / 2) % 3);
    let laid = 0;
    for (let x = Math.floor(riverX(z)) - 2; laid < depth; x -= 2) {
      const cx = Math.floor((x - ox) / cell), cz = Math.floor((z - oz) / cell);
      const c = { x: ox + (cx + 0.5) * cell, z: oz + (cz + 0.5) * cell };
      if (bankDistance(c.x, c.z) < 0) continue;
      const i = cz * W + cx;
      r.tier[i] = 2; r.planned[i] = 1 | 16; r.wear[i] = 400;
      laid++;
    }
  }
  const f = createPathField(r);
  f.update(r);
  const sd = (x, z) => {
    const fx = (x - ox) / cell * PATH_K - 0.5, fz = (z - oz) / cell * PATH_K - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const at = (a, b) => f.data[(b * f.TW + a) * 2];
    return ((at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v) / 255 * 2 * PATH_RANGE - PATH_RANGE;
  };
  for (let z = 26; z < 74; z += 0.5) {
    const half = Math.abs(-1000 - riverX(z)) - bankDistance(-1000, z);
    const centre = riverX(z) - half - TOW_BANK;
    assert.ok(sd(centre, z) > 0.8, `on the lane at z ${z}`);
    assert.ok(sd(centre - 2.6, z) < 0, `grass beyond the lane at z ${z}`);
    assert.ok(sd(centre + 2.4, z) < 0, `no path at the water's edge at z ${z}`);
  }
});
