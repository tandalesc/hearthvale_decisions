// Walkers keep clear of everything a building draws at walking height: the plinth or
// skirt standing proud of its walls, steps, side wings, lean-tos, bays, porticos,
// piles, a farm's house and barns (sim/outline.js; roads.js fp.walls, outlineClear,
// skirtOutlines). Where the renderer draws each walker (its row as the shader
// extrapolates it) is checked against the render kit's own pieces (composeLot), not
// against the sim's copy of them; on a slope the plinths stand tallest.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, createState, fastForward, setIndividualCap, stepTick, createRenderView, PACE, serialize, restore} from '../src/sim/index.js';
import {PERSON_STRIDE_EXTENDED} from '../src/sim/render-view.js';
import {composeLot, createSpecPool} from '../src/render/kit/compose.js';
import {footprints, navGrid, cellOf, cellCenter, frontCell, doorCell, outlineClear, ensureRoads} from '../src/sim/roads.js';
import {findRoute} from '../src/navigation.js';
import {buildingOutline, inRect} from '../src/sim/outline.js';
import {accessPoint} from '../src/sim/people.js';
import {wingFor} from '../src/sim/buildings.js';
import {emptyState, addBuildingRecord} from '../src/sim/state.js';
import {runPhase} from '../src/sim/hooks.js';
import {setTerrainSeed} from '../src/terrain.js';

const FRAME = 1 / 60;
// Pieces nobody stands in at walking height: crops, banners, sails, scaffold poles. A
// market hall's posts are walked among.
const SKIP = new Set(['field', 'banner', 'sails', 'scaffold']);
const PAD = {band: 0.18, posts: 0.11, piles: 0.13};   // the kit draws these proud of their box
// A drawn walker's middle this far inside a piece counts (float32 rows, half a frame).
const SLACK = 0.05;

function drawnPieces(state) {
  const pool = createSpecPool(), grid = new Map(), G = 6;
  for (const b of state.buildings) {
    if (b.type === 'bridge') continue;
    composeLot(b, pool);
    for (const sp of pool.list()) {
      if (SKIP.has(sp.piece) || (sp.piece === 'posts' && b.type === 'market')) continue;
      const pad = PAD[sp.piece] ?? 0;
      const o = {b, piece: sp.piece, x: sp.x, z: sp.z, c: Math.cos(sp.yaw), s: Math.sin(sp.yaw), hx: Math.abs(sp.sx) / 2 + pad, hz: Math.abs(sp.sz) / 2 + pad, y0: sp.y, y1: sp.y + sp.sy};
      const r = Math.hypot(o.hx, o.hz);
      for (let i = Math.floor((o.x - r) / G); i <= Math.floor((o.x + r) / G); i++)
        for (let j = Math.floor((o.z - r) / G); j <= Math.floor((o.z + r) / G); j++) {
          const k = i * 100003 + j;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(o);
        }
    }
  }
  return (x, y, z) => {
    for (const o of grid.get(Math.floor(x / G) * 100003 + Math.floor(z / G)) ?? []) {
      // At body height: from below the knees to above the feet.
      if (o.y1 < y + 0.12 || o.y0 > y + 1.6) continue;
      const dx = x - o.x, dz = z - o.z;
      const lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
      if (Math.min(o.hx - Math.abs(lx), o.hz - Math.abs(lz)) > SLACK) return o;
    }
    return null;
  };
}

function walkDrawn(state, ticks) {
  for (const p of state.people) p.task = null;
  state.walkerFootprintKey = null;
  // Routes planned in the tick (people.js syncRoute, over roads.js walkerGrid), so the
  // run is the same every time; the game's planner (navGrid) keeps to the same walls.
  const services = {};
  const view = createRenderView(state, {rowFloats: PERSON_STRIDE_EXTENDED});
  stepTick(state, 0.1, services);
  let inside = null, key = '', samples = 0, bad = 0, example = null;
  let now = 0;
  const end = state.time.tick + ticks;
  while (state.time.tick < end) {
    now += FRAME;
    stepTick(state, FRAME * PACE, services);
    view.sync(state, {now, speed: PACE});
    view.peopleDirty = null;
    view.buildingEvents.length = 0;
    const k = `${state.worldVersion}:${state.buildingsRev}:${state.buildings.length}`;
    if (k !== key) { key = k; inside = drawnPieces(state); }
    const rows = view.people;
    for (let i = 0; i < state.people.length; i++) {
      const o = i * PERSON_STRIDE_EXTENDED;
      if (rows[o + 14] === 0) continue;   // indoors
      samples++;
      const t = Math.min(now + FRAME / 2, rows[o + 16]) - rows[o + 6];
      const x = rows[o] + rows[o + 3] * t, z = rows[o + 2] + rows[o + 5] * t, y = rows[o + 1] + rows[o + 4] * t;
      const hit = inside(x, y, z);
      if (!hit) continue;
      bad++;
      example ??= {id: state.people[i].id, x: +x.toFixed(2), z: +z.toFixed(2), piece: hit.piece, building: `${hit.b.type}#${hit.b.id}`, task: state.people[i].task?.kind};
    }
  }
  return {samples, bad, example};
}

for (const [name, make, ticks] of [
  ['the town', () => fixtureState('town'), 600],
  ['the city', () => fixtureState('city'), 240],
  // The hilliest of the first forty valleys (mean slope by the centre): tall plinths.
  ['a hill town', () => { const s = createState(16); fastForward(s, 30); setIndividualCap(s, 1500); return s; }, 600],
]) {
  test(`drawn walkers never pass through a plinth, step, wing or wall: ${name}`, () => {
    const s = make();
    const r = walkDrawn(s, ticks);
    assert.ok(r.samples > 50000, `walkers drawn (${r.samples})`);
    assert.equal(r.bad, 0, `${r.bad} of ${r.samples} drawn inside a piece, e.g. ${JSON.stringify(r.example)}`);
  });
}

function blank() {
  setTerrainSeed(null);
  const s = emptyState(7);
  s.roads = undefined;
  s.era = 1;
  ensureRoads(s);
  runPhase('init', s, {services: {}});
  return s;
}

test('a side wing and its plinth are walls to walkers, not to the lots', () => {
  const s = blank();
  const b = addBuildingRecord(s, {type: 'shop', x: -100, z: 60, w: 3.4, d: 3.4, rot: 0, extensions: [{side: 1, w: 3, d: 2.4}]});
  const fp = footprints(s);
  const wing = buildingOutline(b).find((r) => r.x > b.x + b.w / 2);
  assert.ok(wing, 'the wing is in the outline');
  const c = cellOf(wing.x, wing.z);
  assert.ok(fp.walls[c] && !fp.blocked[c], 'walkers keep off the wing; the lot layer is as it was');
  assert.ok(!outlineClear(s, wing.x, wing.z));
  // A walk past the shop goes round the wing.
  const route = findRoute(navGrid(s), cellOf(-100, 52), cellOf(-100, 68));
  assert.ok(route.cells && route.cells.every((i) => !fp.walls[i] || fp.door[i]), 'round, not through');
});

test('door cells inside the walls are a place to end, never a way through', () => {
  const s = fixtureState('town');
  const fp = footprints(s), grid = navGrid(s);
  const homes = s.buildings.filter((b) => b.type === 'home' && (b.built ?? 1) >= 1);
  let checked = 0;
  for (let i = 0; i < homes.length && checked < 40; i += 4) {
    const a = accessPoint(homes[i], s), b = accessPoint(homes[(i * 7 + 13) % homes.length], s);
    const r = findRoute(grid, cellOf(a.x, a.z), cellOf(b.x, b.z), {maxNodes: 20000});
    if (!r.cells) continue;
    checked++;
    assert.ok(r.cells.slice(1, -1).every((c) => !fp.door[c]), 'no route crosses a door cell');
  }
  assert.ok(checked >= 20, `routes checked (${checked})`);
  // Every way in stays open, outside the building's own pieces.
  for (const b of s.buildings) {
    if (b.type === 'bridge' || b.type === 'park') continue;
    const d = accessPoint(b, s);
    assert.equal(fp.walls[cellOf(d.x, d.z)], 0, `${b.type} ${b.id}: its doorstep is open`);
    assert.ok(!buildingOutline(b).some((r) => inRect(r, d.x, d.z)), `${b.type} ${b.id}: its doorstep is outside its steps and wings`);
  }
});

test('the doorstep steps out past a porch over the street cell; without the state, the street cell as before', () => {
  const s = fixtureState('city');
  let moved = 0;
  for (const b of s.buildings) {
    if (['bridge', 'park', 'farm'].includes(b.type)) continue;
    const front = cellCenter(frontCell(b)), plain = accessPoint(b);
    assert.deepEqual(plain, front, 'the lot layer\'s way in is the street cell');
    const d = accessPoint(b, s);
    if (d.x === front.x && d.z === front.z) continue;
    moved++;
    // Beyond the steps, straight out from the door.
    const door = cellCenter(doorCell(b));
    assert.ok(Math.hypot(d.x - door.x, d.z - door.z) > Math.hypot(front.x - door.x, front.z - door.z), 'further out');
  }
  assert.ok(moved > 0, 'some doorsteps lie past a porch, steps or a wing');
});

test('side wings go to the sides, never across the door', () => {
  const s = fixtureState('town');
  for (const b of s.buildings.filter((q) => q.type === 'home' || q.type === 'shop').slice(0, 60)) {
    const wing = wingFor(s, {...b, extensions: []});
    assert.ok(wing && (wing.side === 1 || wing.side === 3), `${b.type} ${b.id}: a side, not the front or back (${wing?.side})`);
  }
});

test('a restored town walls its walkers in the same cells', () => {
  const s = fixtureState('town');
  for (let t = 0; t < 30; t++) stepTick(s, 0.1, {});
  const r = restore(serialize(s));
  const a = footprints(s), b = footprints(r);
  assert.deepEqual(Array.from(b.walls), Array.from(a.walls));
  assert.deepEqual(Array.from(b.door), Array.from(a.door));
  assert.deepEqual([...b.wayIn], [...a.wayIn]);
});
