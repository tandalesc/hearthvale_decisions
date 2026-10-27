// Walkers never stand inside a building footprint: neither in the sim nor where the
// renderer draws them (rows extrapolated and clamped at the segment end).
// Shared invariant of sim-core (people.js, render-view.js) and sim-world (routes, footprints).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick, createRenderView, cellIndex, PACE} from '../src/sim/index.js';
import {deckHeightAt, alongBridge} from '../src/sim/bridges.js';
import {waterAt, bankDistance, fordFactor, heightAt, waterLevelAt, WATER_SURFACE} from '../src/terrain.js';

// A cell the nav grid treats as a ford (shallow water, code 2) is walkable too.
function navFord(x, z) {
  const c = cellOf(x, z);
  return c >= 0 && terrainGrid().water[c] === 2;
}

// Known riverbank mismatch (owner: leave it): a cell the nav grid counts as land, such
// as a towpath at the water's edge, may lie a little inside waterAt's river (seen up to
// 0.13 units, by terrain.bankDistance).
const TOWPATH_SLACK = 0.15;
function onTowpath(x, z) {
  const c = cellOf(x, z);
  return c >= 0 && !terrainGrid().water[c] && bankDistance(x, z) >= -TOWPATH_SLACK;
}

// A ford as the terrain makes it: within a ford's shallowed band (fordFactor > 0: its
// flat bed and the blend either side) and wadeable underfoot, the depth terrain.fordAt
// allows (bed above -0.35 under the 0.025 surface). Wider than the flagged channel cells
// (rows whose centre is wadeable): a leg leaving a ford's outermost row on a slant crosses
// the corner of the next row's bank ramp, ankle-deep or above the water line (town
// fixture, ford at z -314: the leg (5,-309) -> (-7,-299); see the test below).
const WADE = WATER_SURFACE + 0.35;
const atFord = (x, z) => fordFactor(z) > 0 && waterLevelAt(z) - heightAt(x, z) < WADE;

// Clearly on a deck: within its width and away from the abutments (sim-world's deck
// height also covers a 0.6 margin beside the deck, where bank walkers brush past).
const bridgesOf = (state) => state.buildings.filter((b) => b.type === 'bridge' && b.a && (b.built ?? 1) >= 1);
let bridgeList = [];

function clearlyOnDeck(state, x, z) {
  for (const b of bridgeList) {
    const {t, off} = alongBridge(b, x, z);
    if (t > 0.05 && t < 0.95 && off < (b.width ?? 3) / 2 - 0.1) return true;
  }
  return false;
}
import {PERSON_STRIDE_EXTENDED} from '../src/sim/render-view.js';
import {footprints, cellOf, terrainGrid, walkerGrid} from '../src/sim/roads.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {findRoute, cellsToWaypoints} from '../src/navigation.js';

const FRAME = 1 / 60;

function insideAt(state, x, z) {
  const c = cellIndex(state.roads, x, z);
  return c >= 0 && footprints(state).blocked[c] !== 0;
}

function run(speed, ticks) {
  const state = fixtureState('town');
  for (const p of state.people) p.task = null;
  state.walkerFootprintKey = null;   // re-check everyone on the first tick
  // A clock that never advances: each tick runs the planner's full slice cap, so
  // the run is the same however busy the machine is (route-planner.js).
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  const services = {routes};
  const view = createRenderView(state, {rowFloats: PERSON_STRIDE_EXTENDED});
  stepTick(state, 0.1, services);
  const bad = {sim: 0, drawn: 0, samples: 0, example: null, wet: 0, wetExample: null, deck: 0, deckSamples: 0, deckExample: null};
  let now = 0;
  const end = state.time.tick + ticks;
  while (state.time.tick < end) {
    now += FRAME;
    stepTick(state, FRAME * speed * PACE, services);   // the game's own pace (src/main.js)
    routes.tick?.(state);
    view.sync(state, {now, speed: speed * PACE});
    view.peopleDirty = null;
    view.buildingEvents.length = 0;
    bridgeList = bridgesOf(state);
    const rows = view.people;
    for (let i = 0; i < state.people.length; i++) {
      const p = state.people[i];
      bad.samples++;
      if (insideAt(state, p.x, p.z)) {
        bad.sim++;
        bad.example ??= {id: p.id, x: p.x, z: p.z, task: p.task?.kind};
      }
      // In the river only at a ford or on a bridge deck.
      const deckY = deckHeightAt(state, p.x, p.z);
      if (waterAt(p.x, p.z) && deckY == null && !atFord(p.x, p.z) && !navFord(p.x, p.z) && !onTowpath(p.x, p.z)) {
        bad.wet++;
        bad.wetExample ??= {id: p.id, x: p.x, z: p.z};
      }
      // Where the renderer draws this walker half a frame later.
      const o = view.rowOf(p.id) * PERSON_STRIDE_EXTENDED;
      if (rows[o + 14] === 0) continue;   // indoors: not drawn
      const t = Math.min(now + FRAME / 2, rows[o + 16]) - rows[o + 6];
      const dx = rows[o] + rows[o + 3] * t, dz = rows[o + 2] + rows[o + 5] * t;
      if (insideAt(state, dx, dz)) bad.drawn++;
      // On a deck the drawn height follows the deck.
      const drawnDeck = clearlyOnDeck(state, dx, dz) ? deckHeightAt(state, dx, dz) : null;
      if (drawnDeck != null) {
        bad.deckSamples++;
        const dy = rows[o + 1] + rows[o + 4] * t;
        // At 8x a frame covers more ground than the 0.4-unit re-anchor step, so allow a little more.
        if (Math.abs(dy - drawnDeck) > (speed > 1 ? 0.15 : 0.1) || rows[o + 19] !== 1) {
          bad.deck++;
          bad.deckExample ??= {id: p.id, y: +dy.toFixed(2), deck: +drawnDeck.toFixed(2), flag: rows[o + 19]};
        }
      }
    }
  }
  return bad;
}

for (const speed of [1, 8]) {
  test(`no walker inside a footprint over 3,000 ticks at ${speed}x (sim and drawn)`, () => {
    const bad = run(speed, 3000);
    assert.equal(bad.sim, 0, `sim: ${bad.sim} of ${bad.samples} samples inside, e.g. ${JSON.stringify(bad.example)}`);
    assert.equal(bad.drawn, 0, `drawn: ${bad.drawn} of ${bad.samples} samples inside`);
    assert.equal(bad.wet, 0, `in the water outside fords and decks: ${bad.wet}, e.g. ${JSON.stringify(bad.wetExample)}`);
    assert.equal(bad.deck, 0, `deck height off by more than 0.1 (or no onDeck flag): ${bad.deck} of ${bad.deckSamples}, e.g. ${JSON.stringify(bad.deckExample)}`);
    assert.ok(bad.deckSamples > 0, 'some walkers crossed a bridge');
  });
}

// The smallest case of a walker found in the river at 1x (person 1377, year 34): the town
// fixture's valley (seed 2024) has a ford at z -314, and a route from the east bank to
// the west wades it along its outermost row, then leaves on a slant. Every water cell it
// enters must be a ford (never deep water), and every point along its legs must be dry,
// on a ford's wadeable ground or a ford cell.
test('a route over the ford at the south of the town fixture wades only the ford', () => {
  const s = fixtureState('town');
  const grid = walkerGrid(s);
  const from = {x: 16.86, z: -309}, to = {x: -7, z: -299};
  const r = findRoute(grid, cellOf(from.x, from.z), cellOf(to.x, to.z), {maxNodes: 40000});
  assert.ok(r.cells, 'a route');
  const water = terrainGrid().water;
  const wet = [...r.cells].filter((c) => water[c]);
  assert.ok(wet.length > 0, 'it wades');
  assert.ok(wet.every((c) => water[c] === 2), `only ford cells (${wet.map((c) => water[c])})`);
  const route = cellsToWaypoints(grid, r.cells, from, to);
  for (let i = 2; i < route.length; i += 2) {
    for (let t = 0; t <= 1; t += 0.01) {
      const x = route[i - 2] + (route[i] - route[i - 2]) * t, z = route[i - 1] + (route[i + 1] - route[i - 1]) * t;
      assert.ok(!waterAt(x, z) || atFord(x, z) || navFord(x, z) || onTowpath(x, z),
        `(${x.toFixed(2)}, ${z.toFixed(2)}) is in the river, ${(waterLevelAt(z) - heightAt(x, z)).toFixed(2)} deep, off the ford`);
    }
  }
});
