import test from 'node:test';
import assert from 'node:assert/strict';
import { villagerTriangles } from '../src/render/people.js';

test('villager mesh stays within the per-person triangle budget', () => {
  const tris = villagerTriangles();
  // 114 since the legs gained soles (a swinging leg showed its hollow bottom).
  assert.ok(tris > 40 && tris <= 116, `villager has ${tris} triangles`);
  // 3,000 villagers must fit comfortably inside the 1.2 M on-screen budget.
  assert.ok(tris * 3000 < 350000);
});
