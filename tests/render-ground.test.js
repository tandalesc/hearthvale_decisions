import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGround, GROUND_ORIGIN, GROUND_STEP, GROUND_N, GROUND_GLSL, waterLevel, smoothBeach } from '../src/render/ground.js';
import { raycastTerrain } from '../src/render/terrain.js';
import { generateForest } from '../src/render/trees.js';
import { heightAt, riverX, setTerrainSeed, terrainSeed, WATER_HALF, bankDistance, waterLevelAt } from '../src/terrain.js';
import { riverBarLift, riverBedAt } from '../src/river.js';
import { composeLot, createSpecPool } from '../src/render/kit/compose.js';
import { fixtureState } from '../src/sim/index.js';

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
  tex.onUpdate(tex); // Three uploaded it (a frame drew)
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

// Frames can flush without drawing (the first frame waits while materials
// compile), and Three only uploads a texture when something drawn samples it.
// A pad that changes in between must not put row ranges on the first upload:
// Three would allocate the texture and send only those rows, leaving the rest
// zero (river offset 0 everywhere, so the ground chunks discard every fragment
// and the town stands on nothing).
test('changes before the ground texture first reaches the GPU ride the whole upload', () => {
  const g = createGround();
  const tex = g.uniforms.tGround.value;
  g.setPad(1, { x: -40, z: 30, w: 8, d: 6, y: 5 });
  assert.ok(g.flush());
  assert.equal(tex.updateRanges.length, 0, 'first flush: the whole texture');
  // No draw yet: another pad, another flush.
  g.setPad(2, { x: 20, z: -10, w: 6, d: 6, y: 4 });
  g.flush();
  assert.equal(tex.updateRanges.length, 0, 'still the whole texture, pad 2 included');
  // Once Three has uploaded it, changes go up as row ranges again.
  tex.onUpdate(tex);
  g.setPad(2, { x: 20, z: -10, w: 6, d: 6, y: 4.5 });
  g.flush();
  assert.ok(tex.updateRanges.length > 0);
  // A rebuild (a new valley) queues the whole texture again, until it uploads.
  tex.clearUpdateRanges();
  g.rebuild();
  g.setPad(3, { x: 0, z: 60, w: 4, d: 4, y: 3 });
  g.flush();
  assert.equal(tex.updateRanges.length, 0, 'after a rebuild: the whole texture');
});

test('a restored WebGL context sends the whole ground texture again before any rows', () => {
  const g = createGround();
  const tex = g.uniforms.tGround.value;
  g.flush();
  tex.onUpdate(tex);
  // A pad changes, its rows queue, then the context is lost and restored.
  g.setPad(1, { x: -40, z: 30, w: 8, d: 6, y: 5 });
  g.flush();
  assert.ok(tex.updateRanges.length > 0);
  const before = tex.version;
  g.reupload();
  assert.equal(tex.updateRanges.length, 0, 'queued rows dropped');
  assert.ok(tex.version > before, 'the texture is marked for upload');
  g.setPad(1, { x: -40, z: 30, w: 8, d: 6, y: 6 });
  g.flush();
  assert.equal(tex.updateRanges.length, 0, 'changes ride the whole upload');
  tex.onUpdate(tex);
  g.setPad(1, { x: -40, z: 30, w: 8, d: 6, y: 7 });
  g.flush();
  assert.ok(tex.updateRanges.length > 0, 'rows again once it has gone up');
});

test('neighbouring pads blend by weight: order does not matter and they meet halfway', () => {
  // Two lots 2 m apart at different heights (their blend rings overlap).
  const a = { x: -100, z: 50, w: 6, d: 6, y: 3 };
  const b = { x: -92, z: 50, w: 6, d: 6, y: 5 };
  const ab = createGround(), ba = createGround();
  ab.setPad('a', a); ab.setPad('b', b);
  ba.setPad('b', b); ba.setPad('a', a);
  for (let x = -98; x <= -94; x += 0.25) assert.ok(Math.abs(ab.sample(x, 50) - ba.sample(x, 50)) < 1e-5, `order-free at ${x}`);
  // Each footprint keeps its own height right to its edge; the sample halfway
  // between takes the mean of the two, eased into natural ground by the summed weight.
  assert.ok(Math.abs(ab.sample(-97, 50) - 3) < 1e-5 && Math.abs(ab.sample(-95, 50) - 5) < 1e-5);
  const n = heightAt(-96, 50), w = 1 - (1 / 1.5) ** 2 * (3 - 2 / 1.5);
  assert.ok(Math.abs(ab.sample(-96, 50) - (n + (4 - n) * Math.min(1, 2 * w))) < 1e-4);
  // Removing one leaves the other exactly as if it were alone.
  ab.removePad('b');
  const solo = createGround();
  solo.setPad('a', a);
  for (let x = -98; x <= -90; x += 0.5) assert.ok(Math.abs(ab.sample(x, 50) - solo.sample(x, 50)) < 1e-5);
});

test('the river bed carries the gravel bars the channel strip draws, except at a quay wall', () => {
  const g = createGround();
  // A dry bar: well above the natural bed, out of the water.
  let at = null;
  for (let z = -300; z <= 300 && !at; z++) {
    for (let u = -WATER_HALF; u <= WATER_HALF; u += 1) {
      const x = Math.round(riverX(z) + u);
      if (riverBarLift(x, z) > 0.5 && riverBedAt(x, z) > waterLevelAt(z)) { at = { x, z, u: x - riverX(z) }; break; }
    }
  }
  assert.ok(at, 'the classic valley has a dry bar');
  assert.ok(Math.abs(g.sample(at.x, at.z) - riverBedAt(at.x, at.z)) < 1e-4, 'texel on the bar');
  // Off the channel, nothing changes.
  assert.ok(Math.abs(g.sample(Math.round(riverX(at.z)) + 20, at.z) - heightAt(Math.round(riverX(at.z)) + 20, at.z)) < 1e-4);
  // A quay wall on that bank takes the bar away (and only rows near the run upload).
  g.flush();
  g.uniforms.tGround.value.onUpdate(g.uniforms.tGround.value); // Three uploaded it
  g.setEmbankments([{ side: at.u < 0 ? 'west' : 'east', z0: at.z - 20, z1: at.z + 20 }]);
  assert.ok(Math.abs(g.sample(at.x, at.z) - heightAt(at.x, at.z)) < 1e-4, 'no bar against the wall');
  const tex = g.uniforms.tGround.value;
  assert.ok(g.flush());
  assert.ok(tex.updateRanges.length > 0 && tex.updateRanges.length <= 50);
  // The same list again is a no-op; clearing it brings the bar back.
  const v = g.version();
  g.setEmbankments([{ side: at.u < 0 ? 'west' : 'east', z0: at.z - 20, z1: at.z + 20 }]);
  assert.equal(g.version(), v);
  g.setEmbankments([]);
  assert.ok(Math.abs(g.sample(at.x, at.z) - riverBedAt(at.x, at.z)) < 1e-4);
});

// Portico steps (kit/compose.js stepsDown) run from the floor down to the
// ground in front: no tread may end up under the drawn ground, whether a pad
// berm or a slope across the flight (it once ran down to the lowest ground
// across its 5 m width and into the hill on the other side).
test('portico steps stay above the drawn ground, on slopes too', () => {
  const state = fixtureState('city');
  const pool = createSpecPool();
  // The fixture's own lots, plus libraries (always civic) facing every way
  // on the steepest ground a lot stands on (the city's steepest lot has a
  // gradient of 0.34).
  const steep = [];
  for (let z = -200; z <= 200; z += 9) {
    for (let x = -200; x <= 200; x += 9) {
      if (Math.abs(x - riverX(z)) < 30) continue;
      const s = Math.hypot(heightAt(x + 4, z) - heightAt(x - 4, z), heightAt(x, z + 4) - heightAt(x, z - 4)) / 8;
      if (s <= 0.35) steep.push({ x, z, s });
    }
  }
  steep.sort((a, b) => b.s - a.s);
  const extra = steep.slice(0, 16).map((p, i) => ({ id: 900000 + i, type: 'library', x: p.x, z: p.z, w: 12, d: 14, rot: i % 4, styleEra: 4, built: 1, wealth: 0.8 }));
  const check = (records, g = createGround()) => {
    const flights = [];
    for (const b of records) {
      const s = composeLot(b, pool);
      s.pads.forEach((p, i) => g.setPad(`${b.id}:${i}`, p));
      const specs = Array.from({ length: pool.count() }, (_, i) => ({ ...pool.at(i) }));
      for (const p of specs.filter((q) => q.piece === 'portico')) {
        const sn = Math.sin(p.yaw), c = Math.cos(p.yaw);
        // Treads: bands centred 1.35..2.6 m in front of the portico's centre.
        const treads = specs.filter((q) => {
          if (q.piece !== 'band') return false;
          const t = (q.x - p.x) * sn + (q.z - p.z) * c, l = (q.x - p.x) * c - (q.z - p.z) * sn;
          return t > 1.3 && t < 2.7 && Math.abs(l) < 0.1;
        });
        flights.push(treads.length);
        for (const q of treads) {
          const top = q.y + q.sy, hx = (q.sx + 0.36) / 2 - 0.05, hz = (q.sz + 0.36) / 2 - 0.05;
          for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
            const x = q.x + u * hx * c + v * hz * sn, z = q.z - u * hx * sn + v * hz * c;
            assert.ok(g.sample(x, z) < top + 0.01, `lot ${b.id}: a tread at ${q.x.toFixed(1)},${q.z.toFixed(1)} is ${(g.sample(x, z) - top).toFixed(2)} m under the ground`);
          }
        }
      }
    }
    return flights;
  };
  const clear = (g, records) => { for (const b of records) for (let i = 0; i < 8; i++) g.removePad(`${b.id}:${i}`); };
  assert.ok(check(state.buildings).some((n) => n > 0), 'the city has portico steps');
  // One at a time: the steepest sites lie 9 m apart, and the libraries would overlap.
  const g = createGround();
  const flights = extra.flatMap((b) => { const n = check([b], g); clear(g, [b]); return n; });
  assert.equal(flights.length, extra.length, 'every library has a portico');
  assert.ok(flights.filter((n) => n > 0).length >= extra.length / 2, 'and most have steps');
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

test('beach widths taper where the nearest water changes kind; marsh is kept', () => {
  const n = 40;
  const data = new Float32Array(n * n * 4);
  // Sea beach (14 m) on the left half, none on the right, marsh in one corner.
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) data[(j * n + i) * 4 + 3] = i < 20 ? 14 : 0;
  data[3] = -0.5;
  smoothBeach(data, n);
  const at = (i, j) => data[(j * n + i) * 4 + 3];
  assert.equal(at(0, 0), -0.5);
  assert.ok(Math.abs(at(5, 20) - 14) < 1e-4, 'far from the change: unchanged');
  assert.ok(Math.abs(at(35, 20)) < 1e-4);
  // Across the change it falls step by step, never by more than 2 m a sample.
  for (let i = 1; i < n; i++) {
    assert.ok(at(i, 20) <= at(i - 1, 20) + 1e-6);
    assert.ok(at(i - 1, 20) - at(i, 20) < 2);
  }
});
