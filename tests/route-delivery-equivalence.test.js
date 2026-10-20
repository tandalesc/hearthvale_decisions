// Route delivery's shortcuts (people.js setRoute: legOpen, pushOpen; PERFORMANCE.md,
// "Route delivery") must give exactly the answers of the sample-by-sample work they skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick} from '../src/sim/index.js';
import {footprints, outlineClear, structuralGrid, structuralWaterAt, walkerSegmentBlocked, setTier, cellOf, terrainGrid, navGrid, bumpNav, bumpWorld, addWearAt, FLAG, ORIGIN_X, ORIGIN_Z, CELL, CELLS, GRID_W, __test as roadsTest} from '../src/sim/roads.js';
import {removeBuildingRecord} from '../src/sim/state.js';
import {cellIndex} from '../src/sim/state.js';
import {deckAt, __test} from '../src/sim/people.js';
import {waterAt, riverX, dryAlong, setTerrainSeed} from '../src/terrain.js';
import {ARCHETYPES} from '../src/waters.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {buildingOutline} from '../src/sim/outline.js';

let seed = 7;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const spread = (v) => (rand() * 2 - 1) * v;

// The tests as they were, one sample at a time.
function refSegmentBlocked(s, x0, z0, x1, z1) {
  const {walls} = footprints(s);
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 2);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    const c = cellIndex(s.roads, x, z);
    if (c >= 0 && walls[c]) return true;
    if (i > 0 && !outlineClear(s, x, z)) return true;
  }
  return false;
}
function refLegOpen(s, x0, z0, x1, z1) {
  if (refSegmentBlocked(s, x0, z0, x1, z1)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.25));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    const c = cellOf(x, z);
    if (waterAt(x, z) && !deckAt(s, x, z) && !(c >= 0 && structuralGrid(s).water[c] === 2)) return false;
    if (i > 0 && i < steps && !outlineClear(s, x, z)) return false;
  }
  return true;
}
function refPushOpen(s, out, route, x, z) {
  const lx = out[out.length - 2], lz = out[out.length - 1];
  if (refLegOpen(s, lx, lz, x, z)) { out.push(x, z); return; }
  let best = -1, bestD = Infinity;
  for (let k = 0; k + 1 < route.length; k += 2) {
    const wx = route[k], wz = route[k + 1];
    const d = Math.hypot(wx - x, wz - z);
    if (d < bestD && refLegOpen(s, lx, lz, wx, wz) && refLegOpen(s, wx, wz, x, z)) { best = k; bestD = d; }
  }
  if (best >= 0) out.push(route[best], route[best + 1]);
  out.push(x, z);
}

// Legs of the kinds walkers ask about: by and through drawn pieces, across the river and
// its decks, along cell edges (where rounding decides the cell), short, empty, off the map.
function legs(s, n) {
  const pieces = s.buildings.filter((b) => b.type !== 'bridge' && b.type !== 'park').flatMap((b) => buildingOutline(b));
  const bridges = s.buildings.filter((b) => b.type === 'bridge' && b.a);
  const out = [];
  for (let k = 0; k < n; k++) {
    let x0, z0;
    const kind = k % 6;
    if (kind <= 2) { const r = pieces[Math.floor(rand() * pieces.length)]; x0 = r.x + spread(r.hx + r.hz + 2); z0 = r.z + spread(r.hx + r.hz + 2); }
    else if (kind === 3 && bridges.length) { const b = bridges[Math.floor(rand() * bridges.length)]; x0 = (b.a.x + b.b.x) / 2 + spread(12); z0 = (b.a.z + b.b.z) / 2 + spread(12); }
    else if (kind === 4) { z0 = spread(300); x0 = riverX(z0) + spread(14); }
    else { x0 = spread(390); z0 = spread(390); }
    const len = k % 17 === 0 ? 0 : rand() < 0.3 ? rand() * 2 : rand() * 30;
    const a = rand() * Math.PI * 2;
    let x1 = x0 + Math.cos(a) * len, z1 = z0 + Math.sin(a) * len;
    if (k % 11 === 1) { x0 = ORIGIN_X + CELL * Math.round((x0 - ORIGIN_X) / CELL); x1 = x0; }   // down a cell edge
    if (k % 13 === 2) { z0 = ORIGIN_Z + CELL * Math.round((z0 - ORIGIN_Z) / CELL); z1 = z0; }
    out.push([x0, z0, x1, z1]);
  }
  return out;
}

test('walker leg tests cell by cell agree with testing every sample', () => {
  const s = fixtureState('city');
  const fp = footprints(s);
  let blocked = 0, open = 0, wet = 0;
  for (const [x0, z0, x1, z1] of legs(s, 40000)) {
    assert.equal(walkerSegmentBlocked(fp, x0, z0, x1, z1), refSegmentBlocked(s, x0, z0, x1, z1), `segment ${x0},${z0} ${x1},${z1}`);
    const got = __test.legOpen(s, x0, z0, x1, z1), want = refLegOpen(s, x0, z0, x1, z1);
    assert.equal(got, want, `leg ${x0},${z0} ${x1},${z1}`);
    if (!want) blocked++; else open++;
    if (!want && !refSegmentBlocked(s, x0, z0, x1, z1)) wet++;
  }
  assert.ok(blocked > 5000 && open > 5000 && wet > 300, `blocked ${blocked}, open ${open}, failing on water or pieces alone ${wet}`);
});

test('pushOpen tries the nearest waypoints first and takes the same one as the full scan', () => {
  const s = fixtureState('city');
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  for (let i = 0; i < 60; i++) { routes.tick(s, 1e9); stepTick(s, 0.1, {routes}); }
  let fallbacks = 0;
  for (const p of s.people) {
    const r = p.task?.route;
    if (!r || r.length < 8) continue;
    for (let t = 0; t < 4; t++) {
      // From somewhere near the walk, to one of its points or a point near one.
      const k = 2 * Math.floor(rand() * (r.length / 2));
      const from = [r[k] + spread(6), r[k + 1] + spread(6)];
      const j = 2 * Math.floor(rand() * (r.length / 2));
      const x = r[j] + (t & 1 ? spread(4) : 0), z = r[j + 1] + (t & 1 ? spread(4) : 0);
      const a = [...from], b = [...from];
      __test.pushOpen(s, a, r, x, z);
      refPushOpen(s, b, r, x, z);
      assert.deepEqual(a, b, `walker ${p.id}`);
      if (a.length > 4) fallbacks++;
    }
  }
  assert.ok(fallbacks > 50, `routed round by a waypoint: ${fallbacks}`);
});

test('ford codes read without patching the structural grid match the patched grid', () => {
  const s = fixtureState('city');
  const {water} = terrainGrid();
  const wet = [];
  for (let i = 0; i < CELLS; i++) if (water[i]) wet.push(i);
  structuralGrid(s);
  for (let round = 0; round < 6; round++) {
    // Tier changes on and beside the water, some making or unmaking deck cells.
    for (let n = 0; n < 40; n++) {
      const i = wet[Math.floor(rand() * wet.length)] + (n & 1 ? (Math.floor(rand() * 3) - 1) * GRID_W + Math.floor(rand() * 3) - 1 : 0);
      if (i < 0 || i >= CELLS) continue;
      if (n % 5 === 0) s.roads.planned[i] |= FLAG.BRIDGE;
      setTier(s, i, Math.floor(rand() * 4));
    }
    const read = wet.map((i) => structuralWaterAt(s, i));
    const grid = structuralGrid(s).water;
    assert.deepEqual(read, wet.map((i) => grid[i]), `round ${round}`);
  }
  // A grid that would be built afresh (new navigation works) reads the same too.
  s.roads.navRev++;
  const read = wet.map((i) => structuralWaterAt(s, i));
  assert.deepEqual(read, wet.map((i) => structuralGrid(s).water[i]));
});

test('a leg dryAlong passes has no water at any sample, on every kind of valley', () => {
  const valleys = [[null, 1], [1888, 1], [2024, 1], ...ARCHETYPES.map((a, k) => [101 + k * 977, 2, a]), [1888, 2, null], [31337, 2, null]];
  try {
    for (const [sd, version, archetype] of valleys) {
      setTerrainSeed(sd, version, archetype);
      let dry = 0, maybe = 0;
      for (let k = 0; k < 6000; k++) {
        // Near the river half the time, anywhere the rest.
        const z0 = spread(380), x0 = k & 1 ? riverX(z0) + spread(60) : spread(380);
        const len = rand() * (k % 3 ? 12 : 60), a = rand() * Math.PI * 2;
        const x1 = x0 + Math.cos(a) * len, z1 = z0 + Math.sin(a) * len;
        if (!dryAlong(x0, z0, x1, z1)) { maybe++; continue; }
        dry++;
        const steps = Math.max(1, Math.ceil(len / 0.05));
        for (let i = 0; i <= steps; i++) {
          const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
          assert.equal(waterAt(x, z), false, `valley ${sd}/${version}/${archetype}: (${x}, ${z}) on ${x0},${z0} ${x1},${z1}`);
        }
      }
      assert.ok(dry > 1000 && (maybe > 300 || archetype === 'dry'), `valley ${sd}/${version}/${archetype}: dry ${dry}, maybe ${maybe}`);
    }
  } finally {
    setTerrainSeed(null);
  }
});

test('a nav grid rebuilt from the cells whose inputs changed is the grid built afresh', () => {
  const s = fixtureState('city');
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  const r = s.roads;
  const {water} = terrainGrid();
  const wet = [];
  for (let i = 0; i < CELLS; i++) if (water[i]) wet.push(i);
  const same = (round) => {
    bumpNav(s);   // a new bucket: built, not patched
    const g = navGrid(s), want = roadsTest.freshNavCells(s);
    assert.equal(g.footprintsOnly, false);
    assert.deepEqual(g.cost, want.cost, `costs, round ${round}`);
    assert.deepEqual(g.water, want.water, `water codes, round ${round}`);
  };
  same(-1);
  for (let round = 0; round < 8; round++) {
    // Walkers wear the ground and the town changes as in play...
    for (let i = 0; i < 20; i++) { routes.tick(s, 1e9); stepTick(s, 0.2, {routes}); }
    // ...and by hand: wear (also written straight into the array), tiers by the river
    // and on land, deck flags, a demolition.
    for (let n = 0; n < 60; n++) {
      const i = Math.floor(rand() * CELLS);
      if (n % 3 === 0) addWearAt(s, i, rand() * 400);
      else if (n % 3 === 1) r.wear[i] = rand() * 2000;
      else setTier(s, i, Math.floor(rand() * 6));
      const w = wet[Math.floor(rand() * wet.length)];
      if (n % 4 === 0) r.planned[w] ^= FLAG.BRIDGE;
      if (n % 4 === 1) setTier(s, w, Math.floor(rand() * 4));
    }
    if (round % 3 === 1) {
      const b = s.buildings.find((b) => b.type !== 'bridge' && b.type !== 'park' && rand() < 0.05);
      if (b) { removeBuildingRecord(s, b.id); bumpWorld(s); }
    }
    same(round);
    // A footprint patch between builds changes nothing for the next build.
    if (round % 2 === 0) { navGrid(s, {fresh: true}); }
  }
});
