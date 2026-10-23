// Routes and flow fields outlive nav-grid changes while they can still be walked
// (docs/design/crowd-scale.md §4.1): stale costs are allowed, closed cells never are.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState} from '../src/sim/index.js';
import {navGrid, cellOf} from '../src/sim/roads.js';
import {RouteScheduler, pathOpen, followField} from '../src/navigation.js';

function setup() {
  const s = fixtureState('town');
  const g = navGrid(s);
  const sched = new RouteScheduler({clock: () => 0, fieldThreshold: 3, maxFields: 4});
  sched.setGrid(g);
  const homes = s.buildings.filter((b) => b.type === 'home');
  const cells = homes.slice(0, 8).map((b) => cellOf(b.x, b.z + (b.d ?? 4) / 2 + 2)).filter((c) => Number.isFinite(g.cost[c]));
  return {s, g, sched, cells};
}
const ask = (sched, from, to) => {
  let got;
  assert.ok(sched.request(from, to, (r) => { got = r; }));
  for (let i = 0; i < 200 && !got; i++) sched.tick(1e9, 4096);
  return got;
};

test('a cached route is kept across a change of costs, and dropped once a cell on it closes', () => {
  const {g, sched, cells} = setup();
  const [a, b, c] = cells;
  const ab = ask(sched, a, b), ac = ask(sched, a, c);
  assert.ok(ab.cells && ac.cells);
  // New costs everywhere (another bucket), the same passable cells.
  const cost = g.cost.map((v) => (Number.isFinite(v) ? v * 1.3 : v));
  sched.setGrid({...g, key: 'k2', bucket: 'b2', cost});
  const hits = sched.stats.cacheHits;
  assert.equal(ask(sched, a, b), ab, 'served from the cache');
  assert.equal(sched.stats.cacheHits, hits + 1);
  // A wall across the middle of a -> c.
  const closed = cost.slice();
  const mid = ac.cells[ac.cells.length >> 1];
  closed[mid] = Infinity;
  sched.setGrid({...g, key: 'k3', bucket: 'b3', cost: closed});
  const again = ask(sched, a, c);
  assert.notEqual(again, ac, 'searched again');
  assert.ok(!again.cells || pathOpen({...g, cost: closed}, again.cells));
});

test('a flow field outlives a grid change, and a route through a closed cell is not taken from it', () => {
  const {g, sched, cells} = setup();
  const goal = cells[0];
  for (const from of cells.slice(1)) ask(sched, from, goal);
  for (let i = 0; i < 400 && !sched.fields.has(goal); i++) sched.tick(1e9, 4096);
  const field = sched.fields.get(goal);
  assert.ok(field, 'a field for the busy goal');
  const path = followField(field, cells[1]);
  const closed = g.cost.slice();
  closed[path[path.length >> 1]] = Infinity;
  sched.setGrid({...g, key: 'k2', bucket: 'b2', cost: closed});
  assert.equal(sched.fields.get(goal), field, 'kept');
  const hits = sched.stats.fieldHits;
  const r = ask(sched, cells[1], goal);
  assert.equal(sched.stats.fieldHits, hits, 'not from the field: its way is closed');
  assert.ok(!r.cells || pathOpen({...g, cost: closed}, r.cells));
});
