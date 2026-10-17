import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState, addBuildingRecord, removeBuildingRecord} from '../src/sim/state.js';
import {ensureRoads, structuralGrid, setTier, bumpNav, bumpWorld, cellCenter} from '../src/sim/roads.js';
import {components, findRoute} from '../src/navigation.js';
import {setTerrainSeed} from '../src/terrain.js';

const freshLabels = (grid) => components({...grid, comp: undefined});

test('structural regions survive cost changes and invalidate on blocked or reopened cells', () => {
  setTerrainSeed(4817);
  const s = emptyState(4817);
  ensureRoads(s);
  const first = structuralGrid(s);
  const labels = components(first);
  const cell = first.cost.findIndex((c, i) => c < Infinity && first.water[i] === 0 && labels[i] && i % first.W > 50 && i % first.W < 100);
  assert.ok(cell >= 0);
  const goal = first.cost.findIndex((c, i) => i > cell && c < Infinity && labels[i] === labels[cell]);
  setTier(s, cell, 3);
  const patched = structuralGrid(s);
  assert.notEqual(patched, first);
  assert.notEqual(patched.cost[cell], first.cost[cell]);
  assert.equal(patched.comp, labels, 'cost-only patch preserves immutable regions');
  assert.deepEqual(patched.comp, freshLabels(patched));
  assert.deepEqual(findRoute(patched, cell, goal), findRoute({...patched, comp: undefined}, cell, goal));
  bumpNav(s);
  const rebuilt = structuralGrid(s);
  assert.equal(rebuilt.comp, labels, 'full cost-only build preserves regions too');
  assert.deepEqual(rebuilt.comp, freshLabels(rebuilt));

  const p = cellCenter(cell);
  const building = addBuildingRecord(s, {type: 'home', x: p.x, z: p.z, w: 6, d: 6});
  bumpWorld(s);
  const blocked = structuralGrid(s);
  assert.equal(blocked.cost[cell], Infinity);
  assert.equal(blocked.comp, undefined, 'new barriers discard old regions');
  const blockedLabels = components(blocked);
  assert.deepEqual(blockedLabels, freshLabels(blocked));
  removeBuildingRecord(s, building.id);
  bumpWorld(s);
  const reopened = structuralGrid(s);
  assert.ok(reopened.cost[cell] < Infinity);
  assert.equal(reopened.comp, undefined, 'removing a barrier discards old regions');
  assert.deepEqual(components(reopened), freshLabels(reopened));

  reopened.W--;
  bumpNav(s);
  const resized = structuralGrid(s);
  assert.equal(resized.W, first.W);
  assert.equal(resized.comp, undefined, 'labels from different dimensions are not reused');
});
