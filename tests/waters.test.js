import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/terrain.js';
import { ARCHETYPES, KIND, archetypeOf } from '../src/waters.js';
import { terrainGrid, cellCenter, GRID_W, GRID_H, CELLS } from '../src/sim/roads.js';
import { createState } from '../src/sim/state.js';
import { serialize, restore } from '../src/sim/serialize.js';

// Golden hashes of version-1 valleys, taken before water bodies existed:
// heights, water, fords, bank distance and side over the whole map, plus the
// river line, its level, the ford bands and the channel width.
const GOLDEN = {
  null: '42b30ad0', 1888: 'f39bc0b1', 1: 'b2bfcbf8', 42: '9fe79929', 777: 'c648ed9b',
  123456: '5f463ad8', 99999999: '52432b1c', 3141592653: 'f1d61bd8',
};

function fnv(h, v) {
  const u = new Uint32Array(new Float64Array([v]).buffer);
  h = Math.imul(h ^ u[0], 16777619);
  return Math.imul(h ^ u[1], 16777619) >>> 0;
}

function valleyHash() {
  let h = 2166136261;
  for (let z = -900; z <= 900; z += 7.3) for (let x = -900; x <= 900; x += 7.3) {
    h = fnv(h, T.heightAt(x, z)); h = fnv(h, T.waterAt(x, z) ? 1 : 0); h = fnv(h, T.fordAt(x, z) ? 1 : 0);
    h = fnv(h, T.bankDistance(x, z)); h = fnv(h, T.bankSide(x, z));
  }
  for (let z = -900; z <= 900; z += 3.1) { h = fnv(h, T.riverX(z)); h = fnv(h, T.waterLevelAt(z)); h = fnv(h, T.fordFactor(z)); }
  h = fnv(h, T.WATER_HALF);
  for (const f of T.FORDS) { h = fnv(h, f.z); h = fnv(h, f.half); }
  return h.toString(16);
}

const seedFor = (archetype) => {
  for (let s = 1; s < 5000; s++) if (archetypeOf(s) === archetype) return s;
  throw new Error(archetype);
};

test('version-1 and classic valleys are exactly the valleys they always were', () => {
  for (const [seed, hash] of Object.entries(GOLDEN)) {
    T.setTerrainSeed(seed === 'null' ? null : Number(seed));
    assert.equal(valleyHash(), hash, `seed ${seed}`);
  }
  // Asking for version 2 of the classic valley still gives the classic valley.
  T.setTerrainSeed(null, 2);
  assert.equal(T.terrainVersion(), 1);
  assert.equal(valleyHash(), GOLDEN.null);
});

test('version-2 valleys are deterministic per seed, and keep near the seed\'s river', () => {
  for (const seed of [3, 1888, 424242]) {
    T.setTerrainSeed(seed);
    const river = [-300, 0, 300].map((z) => T.riverX(z));
    T.setTerrainSeed(seed, 2);
    const a = valleyHash();
    // Irregular meanders wander round version 1's line, never far from it.
    [-300, 0, 300].forEach((z, k) => assert.ok(Math.abs(T.riverX(z) - river[k]) < 15, `seed ${seed} at ${z}`));
    T.setTerrainSeed(7);
    T.setTerrainSeed(seed, 2);
    assert.equal(valleyHash(), a);
    assert.equal(T.terrainKey(), `${seed}:2:${archetypeOf(seed)}`);
  }
});

test('seeds spread over every archetype, and each archetype has its water', () => {
  const count = Object.fromEntries(ARCHETYPES.map((a) => [a, 0]));
  for (let s = 1; s <= 400; s++) count[archetypeOf(s)]++;
  for (const a of ARCHETYPES) assert.ok(count[a] > 30, `${a}: ${count[a]}`);
  for (let s = 1; s <= 30; s++) {
    for (const a of ARCHETYPES) {
      T.setTerrainSeed(s, 2, a);
      const W = T.terrainWaters();
      assert.equal(W.archetype, a);
      if (a === 'lake') assert.ok(W.lakes.length >= 1 && W.riverEnd === -Infinity);
      if (a === 'greatlake') assert.ok(W.lakes[0].great && W.riverEnd > -400);
      if (a === 'coast' || a === 'delta') assert.ok(W.sea && W.riverEnd > -450);
      if (a === 'delta') assert.ok(W.creeks.length >= 2);
      if (a === 'coast' || a === 'shore') assert.ok(W.sea.bays.some((b) => b.d > 0), 'coves');
      if (a === 'shore' || a === 'dry') assert.ok(W.noRiver && !T.hasRiver() && T.FORDS.length === 0 && !T.riverOpenAt(0));
      if (a === 'shore') assert.ok(W.sea && !W.lakes.length);
      if (a === 'dry') assert.ok(!W.sea && !W.lakes.length && !W.ponds.length && !W.creeks.length);
    }
  }
});

test('the water kinds agree with waterAt, fords and the bed', () => {
  for (const a of ARCHETYPES) {
    T.setTerrainSeed(seedFor(a), 2);
    const seen = new Set();
    for (let z = -380; z <= 380; z += 3) for (let x = -380; x <= 380; x += 3) {
      const k = T.waterKindAt(x, z);
      seen.add(k);
      assert.equal(T.waterAt(x, z), k !== KIND.LAND);
      if (T.fordAt(x, z)) assert.ok(k === KIND.CREEK || k === KIND.RIVER);
      if (k === KIND.CREEK) assert.ok(T.heightAt(x, z) > -0.35, 'creeks are wadeable');
      if (k === KIND.LAND) assert.ok(T.bankDistance(x, z) >= -1e-9);
      else assert.ok(T.bankDistance(x, z) < 1e-9);
      if (k === KIND.SEA || k === KIND.LAKE || k === KIND.POND) assert.equal(T.surfaceLevelAt(x, z), T.STILL_LEVEL);
    }
    if (a === 'delta') assert.ok(seen.has(KIND.CREEK) && seen.has(KIND.SEA));
    if (a === 'coast') assert.ok(seen.has(KIND.SEA));
    if (a === 'lake') assert.ok(seen.has(KIND.LAKE));
    if (a === 'shore') assert.ok(seen.has(KIND.SEA) && !seen.has(KIND.RIVER));
    if (a === 'dry') assert.deepEqual([...seen], [KIND.LAND]);
  }
});

test('the lowland water is open: no islands, every dry cell reachable by wading', () => {
  for (const a of ARCHETYPES) {
    for (const seed of [seedFor(a), seedFor(a) + 1000]) {
      T.setTerrainSeed(seed, 2, a);
      const { water } = terrainGrid();
      const comp = new Int32Array(CELLS).fill(-1);
      const sizes = [];
      for (let i = 0; i < CELLS; i++) {
        if (water[i] === 1 || comp[i] >= 0) continue;
        const id = sizes.length;
        let n = 0;
        const stack = [i];
        comp[i] = id;
        while (stack.length) {
          const c = stack.pop();
          n++;
          const cx = c % GRID_W, cz = (c - cx) / GRID_W;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= GRID_W || nz >= GRID_H) continue;
            const j = nz * GRID_W + nx;
            if (water[j] !== 1 && comp[j] < 0) { comp[j] = id; stack.push(j); }
          }
        }
        sizes.push(n);
      }
      const total = sizes.reduce((s, n) => s + n, 0);
      const stray = total - Math.max(...sizes);
      // A few cells may pinch off where a crescent pond's tip meets the 2 m grid.
      assert.ok(stray <= 6, `${a} seed ${seed}: ${sizes.length} land pieces, ${stray} cells cut off`);
    }
  }
});

test('the hamlet\'s reach stays dry and every ford is on open river', () => {
  for (let s = 1; s <= 60; s++) {
    T.setTerrainSeed(s, 2);
    const W = T.terrainWaters();
    if (T.hasRiver()) assert.ok(T.FORDS.some((f) => Math.abs(f.z) <= 30), `seed ${s} keeps a ford by the hamlet`);
    for (let z = -60; z <= 60; z += 3) for (let x = -60; x <= 60; x += 3) {
      const k = T.waterKindAt(x + T.riverX(z), z);
      assert.ok(k === KIND.LAND || k === KIND.RIVER, `seed ${s} (${W.archetype}) has ${k} near the hamlet`);
    }
    for (const f of T.FORDS) {
      assert.ok(T.riverOpenAt(f.z), `seed ${s} ford at ${f.z}`);
      assert.ok(T.fordAt(T.riverX(f.z), f.z));
    }
  }
});

test('new towns get the newest valley; saves keep theirs, and old saves stay version 1', () => {
  const s = createState(seedFor('delta'));
  assert.equal(s.terrainVersion, T.TERRAIN_VERSION);
  assert.equal(T.terrainArchetype(), 'delta');
  const forced = createState(99, { archetype: 'coast' });
  assert.equal(T.terrainArchetype(), 'coast');
  const back = restore(serialize(forced));
  assert.equal(back.terrainArchetype, 'coast');
  assert.equal(T.terrainKey(), '99:2:coast');
  // A save written before terrain versions: no terrainVersion field.
  const old = JSON.parse(serialize(s));
  delete old.terrainVersion;
  delete old.terrainArchetype;
  const oldState = restore(JSON.stringify(old));
  assert.equal(oldState.terrainVersion, 1);
  assert.equal(T.terrainVersion(), 1);
  assert.equal(T.terrainWaters(), null);
});
