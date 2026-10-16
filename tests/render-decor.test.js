import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDecor } from '../src/render/decor.js';
import { createGrade } from '../src/render/grade.js';
import { fixtureState } from '../src/sim/index.js';
import { createRenderView } from '../src/sim/render-view.js';
import { heightAt } from '../src/terrain.js';

// Decor is laid out again around the view target as the camera pans. A piece
// in reach of two layouts in a row must stay exactly where it was: benches,
// bins and fingerposts are picked one per block, and the riverbank is sampled
// on a lattice, and neither may depend on where the camera looks. (Before the
// fix, 36 pieces in the town and 72 in the city moved on this walk.)
for (const fixture of ['town', 'city']) {
  test(`${fixture}: decor in reach of two layouts stays put as the camera pans`, () => {
    const state = fixtureState(fixture);
    const view = createRenderView(state);
    view.sync?.(state, { now: 0, speed: 0 });
    const scene = new THREE.Scene();
    let dirty = 0;
    const decor = createDecor({ scene, grade: createGrade(), heightAt, buildings: null, lights: { markDirty() { dirty++; } }, quality: { name: 'medium' } });
    const meshes = [];
    scene.traverse((o) => { if (o.parent?.name === 'decor' && o.isInstancedMesh) meshes.push(o); });
    const read = () => meshes.map((m) => {
      const a = m.instanceMatrix.array, out = [];
      for (let i = 0; i < m.count; i++) out.push([a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14]]);
      return out;
    });
    const key = (p) => p.map((v) => v.toFixed(3)).join(',');
    const c = state.centres?.[0] ?? { x: 0, z: 0 };
    // Each pan is past the decor's redo distance (a third of the medium reach, 100).
    let prev = null, pc = null, t = 0, compared = 0, moved = 0, layouts = 0;
    for (const [dx, dz] of [[0, 0], [37, 3], [74, 9], [41, 47], [3, 77], [-33, 41]]) {
      const cx = c.x + dx, cz = c.z + dz;
      decor.update(view, { target: new THREE.Vector3(cx, 0, cz), distance: 60, time: (t += 5) });
      layouts++;
      const cur = read();
      if (prev) {
        const both = (p) => (p[0] - cx) ** 2 + (p[2] - cz) ** 2 < 85 * 85 && (p[0] - pc[0]) ** 2 + (p[2] - pc[1]) ** 2 < 85 * 85;
        for (let m = 0; m < cur.length; m++) {
          const now = new Set(cur[m].filter(both).map(key));
          for (const k of prev[m].filter(both).map(key)) {
            compared++;
            if (!now.has(k)) moved++;
          }
        }
      }
      prev = cur;
      pc = [cx, cz];
    }
    assert.ok(compared > 1000, `enough pieces to compare (${compared})`);
    assert.equal(moved, 0, `${moved} of ${compared} pieces moved between layouts`);
    assert.ok(dirty >= layouts, 'each new layout asks the shadow map to redraw once');
  });
}

// Walkers wear the streets and residents tend their lots all the time; laid
// out again, decor must not flicker for small changes (stages and bins hold
// until a value is clearly past its threshold).
test('city: small changes in wear and care do not make decor flicker', () => {
  const state = fixtureState('city');
  const view = createRenderView(state);
  view.sync?.(state, { now: 0, speed: 0 });
  const scene = new THREE.Scene();
  const decor = createDecor({ scene, grade: createGrade(), heightAt, buildings: null, lights: { markDirty() {} }, quality: { name: 'medium' } });
  const meshes = [];
  scene.traverse((o) => { if (o.parent?.name === 'decor' && o.isInstancedMesh) meshes.push(o); });
  const read = () => meshes.map((m) => {
    const a = m.instanceMatrix.array, out = new Set();
    // Plan position only: a shrub a little taller is growth, not flicker.
    for (let i = 0; i < m.count; i++) out.add([a[i * 16 + 12], a[i * 16 + 14]].map((v) => v.toFixed(3)).join(','));
    return out;
  });
  const c = state.centres?.[0] ?? { x: 0, z: 0 };
  const target = new THREE.Vector3(c.x, 0, c.z);
  let t = 0;
  decor.update(view, { target, distance: 60, time: (t += 5) });
  const before = read();
  // A seeded wobble around the original values (hovering, not drifting):
  // wear +-15 %, care levels +-3 points, a lot's tending +-0.03.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const r0 = Float32Array.from(view.roads.wear);
  const l0 = view.landscape?.level ? Float32Array.from(view.landscape.level) : null;
  const t0 = new Map(state.buildings.filter((b) => b.tend != null).map((b) => [b, b.tend]));
  for (let round = 0; round < 4; round++) {
    const r = view.roads;
    for (let i = 0; i < r.wear.length; i++) if (r0[i] > 0) r.wear[i] = r0[i] * (1 + 0.15 * rnd());
    const L = view.landscape;
    if (l0) for (let i = 0; i < L.level.length; i++) L.level[i] = l0[i] + 3 * rnd();
    for (const [b, v] of t0) b.tend = v + 0.03 * rnd();
    // A new signature forces a fresh layout at the same view.
    if (r.version != null) r.version++;
    if (L) L.rev = (L.rev ?? 0) + 1;
    decor.update(view, { target, distance: 60, time: (t += 5) });
  }
  const after = read();
  for (let m = 0; m < meshes.length; m++) {
    const gone = [...before[m]].filter((k) => !after[m].has(k)).length;
    const came = [...after[m]].filter((k) => !before[m].has(k)).length;
    // Without the hysteresis about 12 % of the pieces changed here.
    assert.ok(gone + came <= Math.ceil(before[m].size * 0.002), `mesh ${m}: ${gone} pieces vanished and ${came} appeared out of ${before[m].size}`);
  }
});
