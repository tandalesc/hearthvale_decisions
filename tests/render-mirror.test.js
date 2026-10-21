// The render mirror (src/sim/render-mirror.js) against the live render view it copies:
// a town run through a year end (the restyle) and an era change, with every delta sent
// through structuredClone as postMessage would. Each frame the mirror must match the view
// field for field, and keep the identities the renderer checks: the same buildings
// array, record objects, roads object and grids unless the sim replaced them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick, createRenderView, PACE, TICKS_PER_YEAR} from '../src/sim/index.js';
import {addBuildingRecord, removeBuildingRecord, touchBuilding} from '../src/sim/state.js';
import {createMirrorSource, createRenderMirror} from '../src/sim/render-mirror.js';
import {createRoutePlanner} from '../src/route-planner.js';

const plain = (b) => Object.fromEntries(Object.entries(b).filter(([k]) => k[0] !== '_'));

function run({frames, speed = 20, before, pre, each}) {
  const state = fixtureState('town');
  before?.(state);
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  const services = {decisions: null, routes, now: 0};
  const view = createRenderView(state, {rowFloats: 20});
  const source = createMirrorSource();
  const mirror = createRenderMirror({rowFloats: 20});
  for (let f = 0; f < frames; f++) {
    const now = (f + 1) / 60;
    services.now = now * 1000;
    pre?.(f, state);
    if (speed > 0) {
      routes.tick(state, 1e9);
      stepTick(state, speed * PACE / 60, services);
    }
    view.sync(state, {now, speed: speed * PACE});
    const {delta, transfer} = source.delta(view, state);
    mirror.apply(structuredClone(delta, {transfer}));
    each?.(f, state, view, mirror.view);
  }
  return {state, view, mirror: mirror.view};
}

function sameView(state, view, m, {records = true} = {}) {
  const stride = view.rowFloats;
  assert.equal(m.peopleCount, view.peopleCount);
  assert.equal(m.people.length, view.people.length);
  assert.deepEqual(m.people.subarray(0, view.peopleCount * stride), view.people.subarray(0, view.peopleCount * stride));
  assert.deepEqual(m.peopleIds.subarray(0, view.peopleCount), view.peopleIds.subarray(0, view.peopleCount));
  assert.deepEqual(m.buildings.map((b) => b.id), state.buildings.map((b) => b.id));
  if (records) for (let i = 0; i < state.buildings.length; i++) assert.deepEqual(m.buildings[i], plain(state.buildings[i]), `building ${state.buildings[i].id}`);
  for (const k of ['wear', 'tier', 'planned', 'low', 'embanked']) assert.deepEqual(m.roads[k], state.roads[k], `roads.${k}`);
  for (const [k, v] of Object.entries(state.roads)) if (k !== 'dirty' && (v === null || typeof v !== 'object')) assert.equal(m.roads[k], v, `roads.${k}`);
  for (const k of ['bridges', 'lamps', 'embankments', 'attention', 'centres', 'projects', 'time', 'era', 'styleEra', 'archetype', 'weather', 'worldEvents', 'aesthetics', 'landscape']) {
    assert.deepEqual(m[k], view[k], k);
  }
}

test('the mirror matches the render view through a year end and an era change, keeping identities', () => {
  let year = null, restyled = false, eraFrom = null, mirrorRoads = null, mirrorTier = null, mirrorList = null;
  const records = new Map();   // id -> [sim record, mirror record]
  let stale = 0;
  run({
    // Close to the turn of a year, so the run crosses it (and the restyle with it).
    before: (s) => {
      year = s.time.year;
      for (let i = 0; i < 4000 && (s.time.tick % TICKS_PER_YEAR) < TICKS_PER_YEAR - 120; i++) stepTick(s, 4, {}, {skipPeople: true});
      year = s.time.year;
    },
    frames: 420,
    pre(f, state) {
      if (f === 200) {
        // An era change, and a building added, replaced and removed by hand.
        eraFrom = state.era;
        state.era = Math.min(5, state.era + 1);
        const b = addBuildingRecord(state, {type: 'home', x: 1, z: 1, w: 3, d: 3});
        touchBuilding(state, b);
        const at = state.buildings.findIndex((r) => r.type === 'home' && r.id !== b.id);
        state.buildings[at] = {...state.buildings[at]};
        state.buildingsRev++;
        removeBuildingRecord(state, state.buildings.find((r) => r.type === 'farm')?.id ?? state.buildings[3].id);
      }
    },
    each(f, state, view, m) {
      if (state.time.year !== year) restyled = true;
      // Field for field every frame, except records changed with no event: the scan
      // catches those within a pass (every 60 frames), as the renderer's own scan does.
      sameView(state, view, m, {records: false});
      for (let i = 0; i < state.buildings.length; i++) {
        try { assert.deepEqual(m.buildings[i], plain(state.buildings[i])); } catch { stale++; }
      }
      // Identities: kept unless the sim replaced the object.
      if (mirrorRoads) assert.equal(m.roads, mirrorRoads, 'roads object');
      if (mirrorTier) assert.equal(m.roads.tier, mirrorTier, 'roads.tier');
      if (mirrorList) assert.equal(m.buildings, mirrorList, 'buildings array');
      mirrorRoads = m.roads;
      mirrorTier = m.roads.tier;
      mirrorList = m.buildings;
      for (let i = 0; i < state.buildings.length; i++) {
        const b = state.buildings[i], was = records.get(b.id);
        if (was && was[0] === b) assert.equal(m.buildings[i], was[1], `record ${b.id} kept its object`);
        if (was && was[0] !== b) assert.notEqual(m.buildings[i], was[1], `record ${b.id} replaced`);
        records.set(b.id, [b, m.buildings[i]]);
      }
    },
  });
  assert.ok(restyled, 'the run crossed a year end');
  assert.notEqual(eraFrom, null);
  // Few stale record-frames at all, and none left once a scan pass has gone by.
  assert.ok(stale < 420 * 5, `stale record-frames: ${stale}`);
});

test('after a scan pass with the sim still, every record matches', () => {
  const {state, view, mirror} = run({frames: 120, speed: 20});
  const source = createMirrorSource();
  // A fresh pair, primed from this state, then a pass with nothing stepping.
  const m2 = createRenderMirror({rowFloats: 20});
  for (let f = 0; f < 70; f++) {
    view.sync(state, {now: 3 + f / 60, speed: 0});
    const {delta, transfer} = source.delta(view, state);
    m2.apply(structuredClone(delta, {transfer}));
  }
  sameView(state, view, m2.view);
  assert.ok(mirror.buildings.length > 50);
});
