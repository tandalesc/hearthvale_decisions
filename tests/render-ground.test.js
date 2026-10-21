import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGround, GROUND_ORIGIN, GROUND_STEP, GROUND_N, GROUND_GLSL, waterLevel } from '../src/render/ground.js';
import { raycastTerrain } from '../src/render/terrain.js';
import { generateForest } from '../src/render/trees.js';
import { heightAt, riverX, setTerrainSeed, terrainSeed, WATER_HALF, bankDistance } from '../src/terrain.js';

test('ground mirror matches heightAt on samples and interpolates between them', () => {
  const g = createGround();
  for (const [x, z] of [[0, 0], [-40, 12], [100, -73], [17, 5]]) {
    assert.ok(Math.abs(g.sample(x, z) - heightAt(x, z)) < 1e-4, `sample point ${x},${z}`);
  }
  // Halfway between two samples: the average of the two.
  const a = heightAt(10, 20), b = heightAt(11, 20);
  assert.ok(Math.abs(g.sample(10.5, 20) - (a + b) / 2) < 1e-4);
  // Outside the textured area the analytic height is used.
  assert.equal(g.covers(500, 0), false);
  assert.equal(g.sample(500, 3), heightAt(500, 3));
  assert.match(GROUND_GLSL, /float groundHeight\(vec2 xz\)/);
  assert.equal(waterLevel(0), 0.025);
});

test('ground mirror interpolates on the terrain mesh\'s own two triangles per cell', () => {
  // terrain.js buildGridLevel splits each cell along its (1,0)-(0,1) diagonal,
  // so a point placed with the mirror lies exactly on the drawn ground.
  const g = createGround();
  const a = heightAt(10, 20), b = heightAt(11, 20), c = heightAt(10, 21), e = heightAt(11, 21);
  const near = (x, y) => Math.abs(x - y) < 1e-4;
  assert.ok(near(g.sample(10.25, 20.25), a + (b - a) * 0.25 + (c - a) * 0.25), 'lower triangle');
  assert.ok(near(g.sample(10.75, 20.75), e + (c - e) * 0.25 + (b - e) * 0.25), 'upper triangle');
  assert.ok(near(g.sample(10.5, 20.5), (b + c) / 2), 'on the diagonal: the two triangles agree');
});

test('pads flatten a footprint, blend to natural ground and can be removed', () => {
  const g = createGround();
  const v0 = g.version();
  g.setPad(1, { x: -40, z: 30, w: 8, d: 6, y: 5 });
  assert.ok(g.version() > v0);
  assert.ok(Math.abs(g.sample(-40, 30) - 5) < 1e-6, 'centre at pad height');
  assert.ok(Math.abs(g.sample(-43.5, 32.5) - 5) < 1e-6, 'inside corner at pad height');
  // 3 units outside the footprint: back on natural ground.
  assert.ok(Math.abs(g.sample(-40, 36) - heightAt(-40, 36)) < 1e-4);
  // Same pad again is a no-op.
  const v1 = g.version();
  g.setPad(1, { x: -40, z: 30, w: 8, d: 6, y: 5 });
  assert.equal(g.version(), v1);
  // The first flush re-sends the whole texture (the GPU copy is not there yet).
  const tex = g.uniforms.tGround.value;
  assert.ok(g.flush());
  assert.equal(tex.updateRanges.length, 0);
  // Later changes upload one row range per dirty row, in pixels x 4 (Three's stride).
  g.setPad(1, { x: -40, z: 30, w: 8, d: 6, y: 6 });
  assert.ok(g.flush());
  assert.ok(tex.updateRanges.length >= 8 && tex.updateRanges.every((r) => r.start % 4 === 0 && r.count % 4 === 0));
  g.removePad(1);
  assert.ok(Math.abs(g.sample(-40, 30) - heightAt(-40, 30)) < 1e-4, 'natural after removal');
  // Texture data carries the river offset in G and the distance to the water in B.
  const k = (Math.round((5 - GROUND_ORIGIN) / GROUND_STEP) * GROUND_N + Math.round((0 - GROUND_ORIGIN) / GROUND_STEP)) * 4;
  assert.ok(Math.abs(tex.image.data[k + 1] - (0 - riverX(5))) < 1e-4);
  assert.ok(Math.abs(tex.image.data[k + 2] - bankDistance(0, 5)) < 1e-4);
});

test('terrain ray can use the ground mirror (pads included)', () => {
  const g = createGround();
  g.setPad(2, { x: -60, z: -60, w: 10, d: 10, y: 9 });
  const ray = new THREE.Ray(new THREE.Vector3(-60, 80, -60), new THREE.Vector3(0, -1, 0));
  const hit = new THREE.Vector3();
  assert.ok(raycastTerrain(ray, hit, 200, g.sample));
  assert.ok(Math.abs(hit.y - 9) < 0.05);
});

test('forest follows the terrain seed and keeps off steep faces and high ground', () => {
  const before = terrainSeed();
  try {
    setTerrainSeed(15);
    const f = generateForest();
    assert.ok(f.count > 2000);
    for (let i = 0; i < f.count; i++) {
      const x = f.x[i], z = f.z[i];
      assert.ok(Math.abs(x - riverX(z)) >= WATER_HALF + 2.5);
      assert.ok(heightAt(x, z) <= 60.5, 'below the treeline');
    }
    setTerrainSeed(17);
    const g = generateForest();
    assert.notEqual(g, f, 'a new seed regenerates the forest');
  } finally {
    setTerrainSeed(before);
  }
});
