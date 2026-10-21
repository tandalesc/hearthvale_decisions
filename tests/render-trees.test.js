import test from 'node:test';
import assert from 'node:assert/strict';
import { generateForest, parkPlanting, orchardPlanting, KIND } from '../src/render/trees.js';
import { riverX, WATER_HALF } from '../src/terrain.js';

test('forest is deterministic, sorted by priority and keeps off the river', () => {
  const f = generateForest();
  assert.ok(f.count > 3000 && f.count < 30000, `tree count ${f.count}`);
  for (let i = 1; i < f.count; i++) assert.ok(f.priority[i - 1] >= f.priority[i]);
  for (let i = 0; i < f.count; i++) assert.ok(Math.abs(f.x[i] - riverX(f.z[i])) >= WATER_HALF + 2.5);
  const kinds = new Set(f.kind);
  for (const k of Object.values(KIND)) assert.ok(kinds.has(k), `kind ${k} present`);
});

test('park planting stays inside the lot and repeats for the same lot', () => {
  const lot = { id: 42, x: 10, z: -20, w: 12, d: 10 };
  const a = parkPlanting(lot);
  assert.deepEqual(a, parkPlanting(lot));
  assert.ok(a.length >= 5);
  for (const t of a) {
    assert.ok(Math.abs(t.x - lot.x) <= lot.w / 2 && Math.abs(t.z - lot.z) <= lot.d / 2);
  }
});

test('orchard farms plant fruit trees on their field, nothing else does', () => {
  const field = { x: 30, z: 40, w: 8, d: 5.2, yaw: Math.PI / 2, kind: 2 };
  const lot = { id: 7, type: 'farm', x: 30, z: 42, w: 12, d: 12, field };
  const a = orchardPlanting(lot);
  assert.deepEqual(a, orchardPlanting(lot));
  assert.equal(a.length, 3 * 2);
  for (const t of a) {
    assert.equal(t.kind, KIND.ROUND);
    // Within the field's rectangle (turned a quarter: w runs along z).
    assert.ok(Math.abs(t.z - field.z) <= field.w / 2 && Math.abs(t.x - field.x) <= field.d / 2, `${t.x},${t.z}`);
  }
  assert.deepEqual(orchardPlanting({ ...lot, field: { ...field, kind: 0 } }), []);
  assert.deepEqual(orchardPlanting({ ...lot, type: 'park' }), []);
});
