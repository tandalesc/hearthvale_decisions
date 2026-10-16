// Boats on lakes, ponds and the sea: the CPU mirror matches the drawn still
// water, every hull keeps its keel clear of the bed and stays on the water
// all round its loop, and river boats never sail into a lake or out to sea.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/terrain.js';
import { ARCHETYPES, archetypeOf } from '../src/waters.js';
import { buildStillWater, stillSurfaceAt, STILL_SWELL } from '../src/render/water.js';
import { createFleet, planReaches, stillLoops, boatPose, hullPoint, craftDraft } from '../src/render/boats.js';

const seedFor = (archetype) => {
  for (let s = 1; s < 5000; s++) if (archetypeOf(s) === archetype) return s;
  throw new Error(archetype);
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The water vertex shader's STILL height for one vertex (VERT in water.js).
function gpuVertexY(g, i, t) {
  const p = g.attributes.position, S = STILL_SWELL;
  const x = p.getX(i), z = p.getZ(i);
  return p.getY(i) + S.amp * g.attributes.aFlow.getX(i) * smooth(0, S.fadeDepth, g.attributes.aDepth.getX(i))
    * ((1 - S.mix) * Math.sin(x * S.ax + z * S.az + t * S.wa) + S.mix * Math.sin(x * S.bx + z * S.bz + t * S.wb));
}

test('stillSurfaceAt mirrors the drawn still water: vertices and triangle interiors', () => {
  for (const a of ['lake', 'coast']) {
    T.setTerrainSeed(seedFor(a), 2);
    const g = buildStillWater();
    const pos = g.attributes.position, idx = g.index.array;
    let checked = 0, worst = 0;
    for (const t of [0, 5.5, 987.6]) {
      for (let k = 0; k < idx.length; k += 3 * 11) {
        const [i, j, l] = [idx[k], idx[k + 1], idx[k + 2]];
        if (Math.abs(pos.getX(i)) > 500 || Math.abs(pos.getZ(i)) > 500) continue;
        const yi = gpuVertexY(g, i, t), yj = gpuVertexY(g, j, t), yl = gpuVertexY(g, l, t);
        const px = 0.2 * pos.getX(i) + 0.3 * pos.getX(j) + 0.5 * pos.getX(l);
        const pz = 0.2 * pos.getZ(i) + 0.3 * pos.getZ(j) + 0.5 * pos.getZ(l);
        // Next to a vertex (just inside its triangle: a vertex on a coarse
        // cell's edge, a T-junction, has two heights there) and mid-triangle.
        const qx = 0.98 * pos.getX(i) + 0.01 * pos.getX(j) + 0.01 * pos.getX(l);
        const qz = 0.98 * pos.getZ(i) + 0.01 * pos.getZ(j) + 0.01 * pos.getZ(l);
        worst = Math.max(worst, Math.abs(stillSurfaceAt(qx, qz, t) - (0.98 * yi + 0.01 * yj + 0.01 * yl)), Math.abs(stillSurfaceAt(px, pz, t) - (0.2 * yi + 0.3 * yj + 0.5 * yl)));
        checked++;
      }
    }
    g.dispose();
    assert.ok(checked > 500, `${a}: checked ${checked}`);
    assert.ok(worst < 1e-4, `${a}: still surface mirror off by ${worst.toFixed(6)} m`);
  }
});

for (const a of ARCHETYPES) {
  test(`${a}: boats keep to deep water (still water and open river), keels clear of the bed`, () => {
    T.setTerrainSeed(seedFor(a), 2);
    const W = T.terrainWaters();
    const loops = stillLoops();
    const stillBodies = W.lakes.length + W.ponds.length + (W.sea ? 1 : 0);
    if (a === 'dry') assert.equal(loops.length, 0);
    if (W.sea || W.lakes.length) assert.ok(loops.length > 0, `${a} has a loop`);
    const fleet = createFleet(8);
    planReaches(fleet, { fords: T.FORDS, bridges: [] });
    assert.equal(fleet.none, a === 'dry');
    if (a === 'dry') return;
    if (!T.hasRiver()) assert.ok(fleet.every((b) => b.still != null), 'no river: every boat on still water');
    if (stillBodies && T.hasRiver()) assert.ok(fleet.some((b) => b.still != null) && fleet.some((b) => b.still == null), 'boats on both');
    const pose = {}, p = {};
    for (const b of fleet) {
      const L = b.spec.length / 2, B = b.spec.beam / 2;
      for (let t = 0; t < 600; t += 2.3) {
        boatPose(b, t, t * 1.7, pose);
        if (b.still == null) {
          assert.ok(T.riverOpenAt(pose.z), `river boat ${b.i} at z ${pose.z.toFixed(1)} keeps to open river`);
          continue;
        }
        // Every corner of the hull's keel: over still water, deep enough.
        for (const [lx, lz] of [[-B, -L], [B, -L], [-B, L], [B, L], [0, 0]]) {
          hullPoint(b, pose, lx, 0, lz, p);
          assert.ok(T.stillDistanceAt(p.x, p.z) < 0, `boat ${b.i} corner on the water at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
          const keel = pose.y - craftDraft(b.spec);
          assert.ok(keel - T.heightAt(p.x, p.z) > 0.25, `boat ${b.i} keel clear of the bed (${(keel - T.heightAt(p.x, p.z)).toFixed(2)})`);
        }
      }
    }
  });
}
