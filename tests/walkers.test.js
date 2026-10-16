// Walkers never stand inside a building footprint: neither in the sim nor where the
// renderer draws them (rows extrapolated and clamped at the segment end).
// Shared invariant of sim-core (people.js, render-view.js) and sim-world (routes, footprints).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick, createRenderView, cellIndex, PACE} from '../src/sim/index.js';
import {deckHeightAt, alongBridge} from '../src/sim/bridges.js';
import {waterAt, FORDS, bankDistance} from '../src/terrain.js';

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

// Fords are bands across the river (terrain.FORDS), wider than the flagged channel cells.
const atFord = (z) => FORDS.some((f) => Math.abs(z - f.z) <= f.half + 1);

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
import {footprints, cellOf, terrainGrid} from '../src/sim/roads.js';
import {createRoutePlanner} from '../src/route-planner.js';

const FRAME = 1 / 60;

function insideAt(state, x, z) {
  const c = cellIndex(state.roads, x, z);
  return c >= 0 && footprints(state).blocked[c] !== 0;
}

function run(speed, ticks) {
  const state = fixtureState('town');
  for (const p of state.people) p.task = null;
  state.walkerFootprintKey = null;   // re-check everyone on the first tick
  const routes = createRoutePlanner({worker: false});
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
      if (waterAt(p.x, p.z) && deckY == null && !atFord(p.z) && !navFord(p.x, p.z) && !onTowpath(p.x, p.z)) {
        bad.wet++;
        bad.wetExample ??= {id: p.id, x: p.x, z: p.z};
      }
      // Where the renderer draws this walker half a frame later.
      const o = i * PERSON_STRIDE_EXTENDED;
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
