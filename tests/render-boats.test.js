// River craft ride the water they are drawn on: the CPU surface mirror
// matches the water ribbon vertex for vertex, every hull keeps its keel under
// and its floor and gunwale over that surface along its whole loop, never
// grounds on a gravel bar, never jumps, and never passes under a bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { terrainSeed, setTerrainSeed, riverX, WATER_HALF, FORDS } from '../src/terrain.js';
import { riverBedAt } from '../src/river.js';
import { buildRiverMap, riverRoughAt } from '../src/render/rivermap.js';
import { buildRiverRibbon, waterSurfaceAt, SWELL } from '../src/render/water.js';
import { createFleet, planReaches, boatPose, hullPoint, pathAt, HULL, CRAFT, craftHeight, craftDraft } from '../src/render/boats.js';
import { boatGeometry, createProps } from '../src/render/props.js';
import { createGrade } from '../src/render/grade.js';
import { fixtureState } from '../src/sim/index.js';
import { bridgeViews } from '../src/sim/works.js';
import { bridgeGeometry, crossingAt } from '../src/sim/bridges.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The water vertex shader's height for one ribbon vertex (VERT in water.js).
function gpuVertexY(pos, uv, depth, i, t) {
  const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
  const r = riverRoughAt(uv.getX(i), uv.getY(i));
  return y + (SWELL.base + SWELL.rough * r) * Math.sin(x * SWELL.kx + t * SWELL.wx)
    * Math.sin(z * (SWELL.kz + r * SWELL.kzRough) + t * (SWELL.wz + r * SWELL.wzRough)) * smooth(0, SWELL.fadeDepth, depth.getX(i));
}

function withSeed(seed, fn) {
  const before = terrainSeed();
  try {
    setTerrainSeed(seed);
    buildRiverMap();
    return fn();
  } finally {
    setTerrainSeed(before);
    buildRiverMap();
  }
}

test('waterSurfaceAt mirrors the drawn water: ribbon vertices and triangle interiors', () => {
  withSeed(1888, () => {
    const g = buildRiverRibbon();
    const pos = g.attributes.position, uv = g.attributes.uv, depth = g.attributes.aDepth, idx = g.index.array;
    let checked = 0, worst = 0;
    for (const t of [0, 7.3, 1234.5]) {
      for (let k = 0; k < idx.length; k += 3 * 7) {
        const [a, b, c] = [idx[k], idx[k + 1], idx[k + 2]];
        const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        if (Math.abs(z) > 380) continue;
        // A vertex, and a point inside the triangle (barycentric weights 0.2/0.3/0.5).
        const ya = gpuVertexY(pos, uv, depth, a, t), yb = gpuVertexY(pos, uv, depth, b, t), yc = gpuVertexY(pos, uv, depth, c, t);
        const px = 0.2 * pos.getX(a) + 0.3 * pos.getX(b) + 0.5 * pos.getX(c);
        const pz = 0.2 * pos.getZ(a) + 0.3 * pos.getZ(b) + 0.5 * pos.getZ(c);
        const inside = 0.2 * ya + 0.3 * yb + 0.5 * yc;
        const e1 = Math.abs(waterSurfaceAt(pos.getX(a), pos.getZ(a), t) - ya);
        const e2 = Math.abs(waterSurfaceAt(px, pz, t) - inside);
        worst = Math.max(worst, e1, e2);
        checked++;
      }
    }
    assert.ok(checked > 3000, `checked ${checked}`);
    assert.ok(worst < 2e-4, `surface mirror off by ${worst.toFixed(6)} m`);
  });
});

test('boat hull geometry: closed from above, keel/floor/gunwale where HULL says', () => {
  const g = boatGeometry();
  const p = g.attributes.position, n = g.attributes.normal, e = g.attributes.aExtra;
  let ymin = Infinity, ymax = -Infinity, floorUp = 0, rimUp = 0, keelDown = 0;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (e.getX(i) < 0.5) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    if (Math.abs(y - HULL.floor) < 1e-6 && n.getY(i) > 0.99) floorUp++;
    if (Math.abs(y - HULL.gunwale) < 1e-6 && n.getY(i) > 0.99) rimUp++;
    if (Math.abs(y - HULL.bottom) < 1e-6 && n.getY(i) < -0.99) keelDown++;
    // Nothing pokes outside the hull outline (unit length and beam).
    assert.ok(Math.abs(p.getX(i)) <= 0.5 + 1e-6 && Math.abs(p.getZ(i)) <= 0.5 + 1e-6);
  }
  assert.ok(Math.abs(ymin - HULL.bottom) < 1e-6 && Math.abs(ymax - HULL.gunwale) < 0.02, `hull ${ymin}..${ymax}`);
  // The floor and gunwale face up (the river never shows inside a boat), the keel plate down.
  assert.ok(floorUp >= 24 && rimUp >= 24 && keelDown >= 24, `floor ${floorUp} rim ${rimUp} keel ${keelDown}`);
  for (const spec of Object.values(CRAFT)) {
    assert.ok(spec.waterline > HULL.bottom + 0.08 && spec.waterline < HULL.floor - 0.05, `${spec.kind} waterline`);
    assert.ok(craftDraft(spec) > 0.1 && craftHeight(spec) < 0.5);
  }
});

const HULL_POINTS = [];
for (const [x, z] of [[-0.5, -0.36], [-0.5, 0.36], [-0.28, 0.5], [0.28, 0.5], [0.5, 0.36], [0.5, -0.36], [0.28, -0.5], [-0.28, -0.5], [0, 0], [0.5, 0], [-0.5, 0]]) HULL_POINTS.push([x, z]);

for (const fixture of ['city', 'town']) {
  test(`${fixture}: every craft rides the surface along its whole loop, clear of bars, smooth`, () => {
    const s = fixtureState(fixture);
    buildRiverMap();
    const fleet = createFleet(8);
    assert.equal(planReaches(fleet, { fords: FORDS, bridges: bridgeViews(s) }), true);
    assert.equal(planReaches(fleet, { fords: FORDS, bridges: bridgeViews(s) }), false, 'replanning is a no-op');
    const pose = {}, prev = {}, q = {};
    for (const b of fleet) {
      const period = b.loop / b.speed;
      let keel = Infinity, floor = Infinity, gunwale = Infinity, bed = Infinity;
      const N = Math.ceil(period / 0.1);
      for (let k = 0; k <= N; k++) {
        const decoT = (k / N) * period, waterT = 50 + decoT * 1.7;
        boatPose(b, decoT, waterT, pose);
        assert.ok(Math.abs(pose.pitch) <= 0.06 && Math.abs(pose.roll) <= 0.06, 'gentle tilt');
        if (k > 0) {
          // 0.1 s apart: no jumps across the channel, no flips end for end.
          assert.ok(Math.hypot(pose.x - prev.x, pose.z - prev.z) < 0.25, `boat ${b.i} jumps at t=${decoT.toFixed(1)}`);
          const dy = Math.atan2(Math.sin(pose.yaw - prev.yaw), Math.cos(pose.yaw - prev.yaw));
          assert.ok(Math.abs(dy) < 0.12, `boat ${b.i} swings ${dy.toFixed(2)} rad at t=${decoT.toFixed(1)}`);
        }
        Object.assign(prev, pose);
        for (const [ux, uz] of HULL_POINTS) {
          const lx = ux * b.spec.beam, lz = uz * b.spec.length;
          hullPoint(b, pose, lx, HULL.bottom, lz, q);
          keel = Math.min(keel, waterSurfaceAt(q.x, q.z, waterT) - q.y);
          bed = Math.min(bed, q.y - riverBedAt(q.x, q.z));
          hullPoint(b, pose, lx * 0.84, HULL.floor, lz * 0.9, q);
          floor = Math.min(floor, q.y - waterSurfaceAt(q.x, q.z, waterT));
          hullPoint(b, pose, lx, HULL.gunwale, lz, q);
          gunwale = Math.min(gunwale, q.y - waterSurfaceAt(q.x, q.z, waterT));
        }
      }
      assert.ok(keel > 0.05, `boat ${b.i}: keel only ${keel.toFixed(3)} under the surface`);
      assert.ok(floor > 0.01, `boat ${b.i}: water ${(-floor).toFixed(3)} over the floor boards`);
      assert.ok(gunwale > 0.12, `boat ${b.i}: gunwale ${gunwale.toFixed(3)} over the water`);
      assert.ok(bed > 0.1, `boat ${b.i}: keel ${bed.toFixed(3)} over the bed (aground)`);
      // The loop keeps inside the channel and the town reaches.
      for (let d = 0; d < b.loop; d += 1) {
        pathAt(b, d, q);
        assert.ok(Math.abs(q.x - riverX(q.z)) < WATER_HALF - 1, 'in the channel');
      }
    }
    // Boats sharing a reach share its loop and never meet.
    for (const a of fleet) {
      for (const b of fleet) {
        if (b.i <= a.i || a.za !== b.za) continue;
        assert.equal(a.loop, b.loop);
        const gap = Math.abs(((a.phase - b.phase) % 1 + 1.5) % 1 - 0.5) * a.loop;
        assert.ok(gap > (a.spec.length + b.spec.length) / 2 + 2, `boats ${a.i} and ${b.i} only ${gap.toFixed(1)} m apart`);
      }
    }
  });
}

/** The bridge mesh props.js builds for these bridge records. */
function bridgeMesh(bridges) {
  const scene = new THREE.Scene();
  const props = createProps({ scene, grade: createGrade(), heightAt: (x, z) => 0, buildings: { version: () => 0, lots: [] }, ground: { version: () => 0 } });
  props.update({ era: 4, bridges, buildings: [], embankments: [], lamps: [], projects: [], worldEvents: [] }, { time: 5, dt: 0.016, target: new THREE.Vector3(), distance: 100 });
  let mesh = null;
  scene.traverse((o) => { if (!mesh && o.isMesh && o.name !== 'boats' && !o.geometry.attributes.aBoatP && o.geometry.attributes.position?.count > 500) mesh = o; });
  props.dispose?.();
  return mesh;
}

test('no craft ever passes under a bridge deck (city bridges and one of each style)', () => {
  const s = fixtureState('city');
  buildRiverMap();
  const bridges = bridgeViews(s);
  for (const [i, style] of ['footbridge', 'iron'].entries()) {
    const g = bridgeGeometry(crossingAt(300 + i * 30), style);
    bridges.push({ id: 9000 + i, a: g.a, b: g.b, width: g.width, deckY: g.deckY, style, built: 1, z: g.z });
  }
  const mesh = bridgeMesh(bridges);
  assert.ok(mesh, 'bridge mesh built');
  // Every bridge vertex over the channel lies in some bridge's footprint
  // (the a->b span, widened by half its width plus cutwaters).
  const inFoot = (x, z, pad) => bridges.some((b) => {
    const dx = b.b.x - b.a.x, dz = b.b.z - b.a.z, L2 = dx * dx + dz * dz;
    const t = ((x - b.a.x) * dx + (z - b.a.z) * dz) / L2;
    const off = Math.abs((x - b.a.x) * dz - (z - b.a.z) * dx) / Math.sqrt(L2);
    return t > -0.05 && t < 1.05 && off < (b.width ?? 4) / 2 + pad;
  });
  const p = mesh.geometry.attributes.position;
  let over = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    if (Math.abs(x - riverX(z)) > WATER_HALF) continue;
    over++;
    assert.ok(inFoot(x, z, 1.0), `bridge vertex (${x.toFixed(1)}, ${z.toFixed(1)}) outside every footprint`);
  }
  assert.ok(over > 1000);
  // No hull point, over a whole loop, comes within a metre of a footprint.
  const fleet = createFleet(8);
  planReaches(fleet, { fords: FORDS, bridges });
  const pose = {}, q = {};
  for (const b of fleet) {
    const period = b.loop / b.speed;
    for (let t = 0; t <= period; t += 0.5) {
      boatPose(b, t, t, pose);
      for (const [ux, uz] of HULL_POINTS) {
        hullPoint(b, pose, ux * b.spec.beam, HULL.gunwale, uz * b.spec.length, q);
        assert.ok(!inFoot(q.x, q.z, 2.0), `boat ${b.i} under a bridge at z=${q.z.toFixed(1)}`);
      }
    }
  }
});
