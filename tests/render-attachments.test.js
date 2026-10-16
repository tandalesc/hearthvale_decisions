import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLot, createSpecPool } from '../src/render/kit/compose.js';
import { GEOMETRY } from '../src/render/buildings.js';
import { heightAt, bankDistance } from '../src/terrain.js';

// Building attachments (porches, lean-tos, porticos, bays, poles, scaffolds)
// must stand on the ground or on a plinth, never hover on sloped lots; wall
// fittings must touch their wall; and no two pieces of a lot may share a
// coplanar face (z-fighting flicker up close).

const record = (over = {}) => ({
  id: 7, type: 'home', variant: 0, tier: 2, storeys: 2, x: -30, z: 12, rot: 0, w: 10, d: 10,
  styleEra: 1, wealth: 0.6, condition: 0.9, age: 12, built: 1, occupied: true, lit: true,
  chimney: true, smoke: 0.2, banner: null, extensions: [], flags: {}, ...over,
});

const TYPES = ['home', 'shop', 'inn', 'workshop', 'farm', 'market', 'chapel', 'mill', 'factory', 'warehouse', 'watch',
  'monument', 'moot', 'school', 'infirmary', 'library', 'theatre', 'exchange', 'union-hall', 'bathhouse'];

function compose(b) {
  const pool = createSpecPool();
  const summary = composeLot(b, pool);
  return { summary, list: pool.list().map((s) => ({ ...s, shape: [...s.shape] })) };
}

/** Steep dry spots on the default terrain (largest rise over a 16 m square). */
function steepSpots(n) {
  const spots = [];
  for (let x = -300; x <= 300; x += 8) {
    for (let z = -300; z <= 300; z += 8) {
      if (bankDistance(x, z) < 14) continue;
      let lo = Infinity, hi = -Infinity;
      for (const dx of [-8, 0, 8]) for (const dz of [-8, 0, 8]) {
        const h = heightAt(x + dx, z + dz);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      if (lo > 0.3) spots.push({ x, z, rise: hi - lo });
    }
  }
  spots.sort((a, b) => b.rise - a.rise);
  const out = [];
  for (const s of spots) {
    if (out.every((o) => Math.hypot(o.x - s.x, o.z - s.z) > 40)) out.push(s);
    if (out.length === n) break;
  }
  return out;
}

/** Lot-local <-> world helpers for a record (front of the lot is local +z). */
function frame(b) {
  const a = (((b.rot ?? 0) % 4 + 4) % 4) * Math.PI / 2;
  const ca = Math.cos(a), sa = Math.sin(a);
  return {
    toLocal: (x, z) => { const dx = x - b.x, dz = z - b.z; return [dx * ca - dz * sa, dx * sa + dz * ca]; },
  };
}

/** World xz points under a spec's footprint (unit-space spots, metric pad m). */
function footprint(s, spots, m = 0) {
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  return spots.map(([u, v]) => {
    const lx = u * s.sx + Math.sign(u) * m, lz = v * s.sz + Math.sign(v) * m;
    return [s.x + lx * c + lz * sn, s.z - lx * sn + lz * c];
  });
}

const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
const POSTS = [...CORNERS, [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]];
const HEX = [0, 1, 2, 3, 4, 5].map((k) => [Math.cos(k * Math.PI / 3) * 0.5, Math.sin(k * Math.PI / 3) * 0.5]);

/** True when world point p lies inside spec s's footprint (band adds 0.18 m a side). */
function covers(s, [px, pz], eps = 0.02) {
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  const dx = px - s.x, dz = pz - s.z;
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  const m = s.piece === 'band' ? 0.18 : 0;
  return Math.abs(lx) <= s.sx / 2 + m + eps && Math.abs(lz) <= s.sz / 2 + m + eps;
}

test('attachments on sloped lots reach the ground or a plinth beneath them', () => {
  const EPS = 0.05;
  const spots = steepSpots(4);
  assert.ok(spots[0].rise > 2, `a steep test site exists (rise ${spots[0].rise.toFixed(2)} m)`);
  const failures = [];
  let checked = 0;
  for (const spot of spots) {
    for (const type of TYPES) {
      for (const styleEra of [0, 1, 2, 3, 4]) {
        for (const rot of [0, 1, 2, 3]) {
          for (const id of [3, 11, 24, 57]) {
            const b = record({
              type, styleEra, rot, id, x: spot.x, z: spot.z, storeys: 3, tier: 3,
              variant: id % 2 ? 'fountain' : 'cross', flags: { square: type === 'monument' ? 1 : 0 },
              banner: id === 24 ? 'festival' : null, built: id === 57 ? 0.6 : 1,
              extensions: id === 11 ? [{ side: 1, w: 3, d: 2.4 }] : [],
            });
            const { summary, list } = compose(b);
            // Rendered ground never sits below the natural ground or the
            // lot's pad height, whichever is lower; inside a pad it is the pad.
            const ground = (x, z) => {
              for (const p of summary.pads) if (Math.abs(x - p.x) <= p.w / 2 && Math.abs(z - p.z) <= p.d / 2) return p.y;
              return Math.min(heightAt(x, z), ...summary.pads.map((p) => p.y), Infinity);
            };
            // Floor level: the lowest wall's ground floor (else just above the lowest piece).
            const bodies = list.filter((s) => s.piece === 'body');
            const floor = bodies.length ? Math.min(...bodies.map((s) => s.y + s.shape[0])) : Math.min(...list.map((s) => s.y)) + 0.6;
            for (const s of list) {
              let pts;
              if (s.piece === 'posts' || s.piece === 'scaffold') pts = footprint(s, POSTS);
              else if (s.piece === 'portico' || s.piece === 'piles') pts = footprint(s, CORNERS);
              else if (s.piece === 'banner') pts = s.y < floor ? footprint(s, [[0, 0]]) : null; // poles, not wall signs
              else if (s.piece === 'stack') pts = footprint(s, HEX);
              else if (s.piece === 'body') pts = footprint(s, CORNERS);
              else if (s.piece === 'band' && s.y < floor - 0.05) pts = footprint(s, CORNERS, 0.18);
              if (!pts || s.y > floor + 0.5) continue; // roof-top and wall pieces
              for (const p of pts) {
                checked++;
                if (s.y <= ground(...p) + EPS) continue;
                const held = list.some((o) => o !== s && ['band', 'body', 'piles', 'flat'].includes(o.piece)
                  && o.y <= s.y + EPS && o.y + o.sy >= s.y - EPS && covers(o, p));
                if (!held) failures.push(`${type} era ${styleEra} rot ${rot} id ${id}: ${s.piece} hovers ${(s.y - ground(...p)).toFixed(2)} m`);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 5000, `checked ${checked} footing points`);
  assert.deepEqual(failures.slice(0, 12), [], `${failures.length} hovering footings`);
});

test('awnings, sign boards and inn signs touch the front wall', () => {
  for (const rot of [0, 1, 2, 3]) {
    for (const [type, styleEra] of [['shop', 1], ['shop', 2], ['inn', 1], ['inn', 3]]) {
      const b = record({ type, styleEra, rot, wealth: 0.8 });
      const { list } = compose(b);
      const f = frame(b);
      const body = list.find((s) => s.piece === 'body');
      const [, bz] = f.toLocal(body.x, body.z);
      const front = bz + body.sz / 2;
      for (const s of list) {
        const [, lz] = f.toLocal(s.x, s.z);
        if (s.piece === 'awning') assert.ok(Math.abs(lz - front) < 0.05, `${type} awning on the wall (${(lz - front).toFixed(3)})`);
        // Inn sign pole: 0.1 m thick, so its centre sits 0.05 m out.
        if (s.piece === 'banner' && type === 'inn') assert.ok(Math.abs(lz - front - 0.05) < 0.02, `inn sign pole on the wall (${(lz - front).toFixed(3)})`);
      }
    }
  }
});

// --- z-fighting --------------------------------------------------------------

const geometries = {};
function trianglesOf(s) {
  const g = (geometries[s.piece] ??= GEOMETRY[s.piece]());
  const P = g.getAttribute('position'), M = g.getAttribute('aMetric'), S = g.getAttribute('aShape');
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  const w = (i) => {
    const lx = P.getX(i) * s.sx + M.getX(i) + S.getX(i) * s.shape[1];
    const ly = P.getY(i) * s.sy + M.getY(i) + S.getY(i) * s.shape[2];
    const lz = P.getZ(i) * s.sz + M.getZ(i) + S.getZ(i) * s.shape[1];
    return [s.x + lx * c + lz * sn, s.y + ly, s.z - lx * sn + lz * c];
  };
  const out = [];
  for (let i = 0; i < P.count; i += 3) {
    const a = w(i), b = w(i + 1), d = w(i + 2);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-6) continue;
    n[0] /= l; n[1] /= l; n[2] /= l;
    out.push({ p: [a, b, d], n, dist: n[0] * a[0] + n[1] * a[1] + n[2] * a[2] });
  }
  return out;
}

/** Do two coplanar triangles overlap by more than a sliver? (2D separating axes.) */
function overlapIn2D(t1, t2) {
  const n = t1.n;
  const ax = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1 = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
  const l = Math.hypot(...e1);
  e1 = e1.map((v) => v / l);
  const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  const pr = (p) => [p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]];
  const A = t1.p.map(pr), B = t2.p.map(pr);
  for (const T of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const p = T[i], q = T[(i + 1) % 3];
      const axis = [q[1] - p[1], p[0] - q[0]];
      const L = Math.hypot(axis[0], axis[1]);
      if (L < 1e-9) continue;
      const proj = (X) => X.map((x) => (x[0] * axis[0] + x[1] * axis[1]) / L);
      const pa = proj(A), pb = proj(B);
      if (Math.min(...pa) >= Math.max(...pb) - 0.01 || Math.min(...pb) >= Math.max(...pa) - 0.01) return false;
    }
  }
  return true;
}

test('no two pieces of a lot share a coplanar face (no z-fighting)', () => {
  const failures = new Set();
  for (const type of TYPES) {
    for (let styleEra = 0; styleEra <= 5; styleEra++) {
      for (const [id, extensions] of [[3, []], [24, [{ side: 1, w: 3, d: 2.4 }, { side: 3, w: 3, d: 2.4 }]], [41, [{ side: 0, w: 3, d: 2.4 }, { side: 2, w: 3, d: 2.4 }]]]) {
        const b = record({ type, styleEra, id, storeys: 3, tier: 3, wealth: 0.8, extensions, variant: 'fountain', flags: { square: type === 'monument' ? 1 : 0 } });
        const tris = compose(b).list.map(trianglesOf);
        for (let i = 0; i < tris.length; i++) {
          for (let j = i + 1; j < tris.length; j++) {
            for (const t1 of tris[i]) {
              for (const t2 of tris[j]) {
                if (t1.n[0] * t2.n[0] + t1.n[1] * t2.n[1] + t1.n[2] * t2.n[2] < 0.9995) continue;
                if (Math.abs(t1.dist - t2.dist) > 0.004) continue;
                if (overlapIn2D(t1, t2)) failures.add(`${type} era ${styleEra} id ${id}: pieces ${i} and ${j}`);
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual([...failures].slice(0, 12), [], `${failures.size} lots with coplanar faces`);
});
