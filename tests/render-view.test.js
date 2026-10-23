import test from 'node:test';
import assert from 'node:assert/strict';
import {createState} from '../src/sim/index.js';
import {createRenderView} from '../src/sim/render-view.js';
import {walkerY, deckAt, DECK_STEP} from '../src/sim/people.js';
import {bridgeGeometry, crossingAt} from '../src/sim/bridges.js';
import {FORDS, riverX} from '../src/terrain.js';

test('walker rows preserve ground, bridge and ford heights across motion and row formats', () => {
  const s = createState(4817);
  const bridge = {id: 99999, type: 'bridge', built: 1, ...bridgeGeometry(crossingAt(70), 'stone')};
  s.buildings.push(bridge);
  s.buildingsRev++;
  s.time.acc = 0.025;
  const base = s.people[0];
  const fordZ = FORDS.find((f) => Math.abs(f.z - 70) > 15).z;
  const cases = [
    {name: 'ground', x: -80, z: 20, wx: -75, wz: 24, deck: false},
    {name: 'bridge ramp', x: bridge.a.x, z: bridge.a.z, wx: bridge.b.x, wz: bridge.b.z, deck: true},
    {name: 'ford', x: riverX(fordZ) - 2, z: fordZ, wx: riverX(fordZ) + 2, wz: fordZ, deck: false},
  ];
  for (const c of cases) {
    const dist = Math.hypot(c.wx - c.x, c.wz - c.z);
    const p = {...base, rev: base.rev + 1, x: c.x, z: c.z, speed: 2.8,
      vx: (c.wx - c.x) * 2.8 / dist, vz: (c.wz - c.z) * 2.8 / dist,
      task: {seg: 0, route: [c.wx, c.wz]}};
    s.people = [p];
    for (const speed of [0, 0.5, 8]) {
      const short = createRenderView(s, {rowFloats: 16});
      const long = createRenderView(s, {rowFloats: 20});
      short.sync(s, {now: 10, speed});
      long.sync(s, {now: 10, speed});
      const r = long.people;
      assert.deepEqual(r.slice(0, 16), short.people.slice(0, 16), c.name);
      assert.equal(r[1], Math.fround(walkerY(s, p.x + p.vx * s.time.acc, p.z + p.vz * s.time.acc)), c.name);
      if (speed === 0) {
        assert.equal(r[4], 0);
        assert.equal(r[16], 10);
        assert.equal(r[19], deckAt(s, p.x + p.vx * s.time.acc, p.z + p.vz * s.time.acc) ? 1 : 0);
      } else {
        assert.equal(r[19], +c.deck, c.name);
        const x = p.x + p.vx * s.time.acc, z = p.z + p.vz * s.time.acc;
        const remaining = Math.hypot(c.wx - x, c.wz - z);
        const step = c.deck ? Math.min(remaining, DECK_STEP) : remaining;
        const endY = walkerY(s, x + (c.wx - x) * step / remaining, z + (c.wz - z) * step / remaining);
        assert.equal(r[4], Math.fround(((endY - walkerY(s, x, z)) * p.speed / step) * speed));
        assert.equal(r[16], Math.fround(10 + remaining / (p.speed * speed)));
      }
    }
  }
  // Idle and route-less walkers use the current deck, even without a segment.
  for (const moving of [false, true]) {
    s.people = [{...base, x: bridge.x, z: bridge.z, speed: moving ? 2.8 : 0, vx: 0, vz: 0, task: null}];
    const view = createRenderView(s);
    view.sync(s, {now: 12, speed: 1});
    assert.equal(view.people[19], 1);
    assert.equal(view.people[16], 12);
    assert.equal(view.people[4], 0);
  }
});

test('each walker keeps its row: a swap-remove moves no row, and only rows written are listed', () => {
  const s = createState(4817);
  const view = createRenderView(s);
  view.sync(s, {now: 1, speed: 1});
  view.peopleDirty = null;
  const n = s.people.length;
  assert.ok(n > 20);
  const rowOf = new Map(s.people.map((p) => [p.id, view.rowOf(p.id)]));
  // Remove the third walker as syncIndividuals does (the last takes its place).
  const gone = s.people[2];
  s.people[2] = s.people.at(-1);
  s.people.pop();
  view.sync(s, {now: 1.01, speed: 1});
  for (const p of s.people) assert.equal(view.rowOf(p.id), rowOf.get(p.id), `walker ${p.id} kept row`);
  const r = rowOf.get(gone.id);
  assert.equal(view.rowOf(gone.id), -1);
  assert.equal(view.peopleIds[r], -1);
  assert.equal(view.people[r * view.rowFloats + 14], 0, 'the freed row is hidden');
  const d = view.peopleDirty;
  assert.ok(d && Array.from(d.list.subarray(0, d.count)).includes(r));
  assert.ok(d.count < 10, `rows written: ${d.count}`);
  view.peopleDirty = null;
  // A newcomer takes the freed row.
  const fresh = {...gone, id: 1e6, rev: 1};
  s.people.push(fresh);
  view.sync(s, {now: 1.02, speed: 1});
  assert.equal(view.rowOf(fresh.id), r);
  assert.equal(view.peopleIds[r], fresh.id);
  assert.equal(view.peopleCount, n);
  // One walker's change lists exactly its row.
  view.peopleDirty = null;
  view.sync(s, {now: 1.021, speed: 1});
  view.peopleDirty = null;
  s.people[5].rev++;
  view.sync(s, {now: 1.022, speed: 1});
  const list = Array.from(view.peopleDirty?.list.subarray(0, view.peopleDirty.count) ?? []);
  assert.ok(list.includes(view.rowOf(s.people[5].id)));
});
