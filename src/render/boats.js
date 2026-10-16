// River craft: where each boat is and how it sits on the water, on the CPU.
//
// The water's surface is the ribbon in water.js plus its vertex swell;
// waterSurfaceAt() mirrors it exactly, and every boat's waterline is fitted to
// it under the hull (bow, stern and both sides): heave is their mean, pitch
// and roll their slopes. Sampling across the whole hull is the smoothing - a
// long barge rides over short waves that rock a punt - and it is a pure
// function of the two clocks, so it is deterministic and frame-rate free.
//
// Boats keep to the deep water of clear reaches between fords, bridges and
// steep water, shifted off the gravel bars on the inside of the bends, and
// go round a stadium loop (up one side, a turn, down the other) instead of
// flipping end for end at the reach ends. Boats sharing a reach share its
// loop, evenly spaced, so they never run into one another.
//
// Lakes, ponds and the sea (version-2 valleys) have boats too: each body near
// the town gets a smooth closed loop through its deep water, baked once per
// valley, and the hulls ride the still surface (stillSurfaceAt). With both
// river and still water, every other boat takes to the still water; with no
// open river, all of them do.
//
// props.js draws them: one instanced mesh, poses written into two small
// instance attributes each frame (no allocation, no extra draw calls).

import { riverX, waterLevelAt, WATER_HALF, terrainSeed, terrainKey, riverOpenAt, terrainWaters, stillDistanceAt, heightAt, STILL_LEVEL } from '../terrain.js';
import { riverBedAt } from '../river.js';
import { waterSurfaceAt, stillSurfaceAt } from './water.js';
import { coastZ } from '../waters.js';
import { hashId } from './shaderlib.js';

// Hull geometry (props.js boatGeometry, metres in the hull's own frame):
// keel, floor boards, gunwale and the top of a barge's cargo.
export const HULL = { bottom: -0.06, floor: 0.17, gunwale: 0.32, cargoTop: 0.52 };

// Craft types: size and where the water comes to on the hull (laden barges
// sit deeper than punts).
export const CRAFT = {
  punt: { kind: 'punt', length: 3.4, beam: 1.05, cargo: 0, waterline: 0.065, rock: 0.012 },
  barge: { kind: 'barge', length: 7.2, beam: 2.1, cargo: 1, waterline: 0.1, rock: 0.005 },
};

/** Height of a craft's highest point above its waterline (m). */
export const craftHeight = (spec) => (spec.cargo ? HULL.cargoTop : HULL.gunwale) - spec.waterline;
/** Depth of the keel below the waterline (m). */
export const craftDraft = (spec) => spec.waterline - HULL.bottom;

// Boats ply the town reaches only (river.js keeps boulders out of their lanes there).
export const BOAT_Z0 = -360;
export const BOAT_Z1 = 360;
const MIN_REACH = 40;
// Water at least this deep counts as navigable (keel + the swell's shallow fade).
const DEEP = 0.3;
// Keep a hull's side this far inside the deep water.
const SIDE_GAP = 0.6;
// Surface steeper than this (m per m) is a rapid: boats keep off it.
const STEEP = 0.004;

/** n boats: the first half punts, the rest barges. */
export function createFleet(n = 8) {
  const fleet = [];
  for (let i = 0; i < n; i++) {
    const spec = i >= n / 2 ? CRAFT.barge : CRAFT.punt;
    fleet.push({
      i, spec, seed: hashId(i, 44),
      // Set by planReaches: inner reach ends, lane, speed, loop and phase.
      za: 0, zb: 1, lane: 1, rA: 1, rB: 1, speed: 0.8, loop: 1, phase: 0,
    });
  }
  return fleet;
}

// ---------------------------------------------------------------- deep channel

const NAV_Z0 = BOAT_Z0 - 20;
const NAV_N = BOAT_Z1 - BOAT_Z0 + 41;
let nav = null, navKey;

/**
 * Per metre along the town reaches: the centre of the deep water (offset
 * from the river's centre line) and its half-width, eroded along the river
 * by a hull's length and smoothed, so a boat can follow it without wiggling.
 */
export function navChannel() {
  const key = `${terrainKey()}:${WATER_HALF}`;
  if (nav && navKey === key) return nav;
  const H = WATER_HALF, STEP = 0.25;
  const lo = new Float32Array(NAV_N), hi = new Float32Array(NAV_N);
  for (let i = 0; i < NAV_N; i++) {
    const z = NAV_Z0 + i, cx = riverX(z), level = waterLevelAt(z);
    // The deep run nearest the centre line.
    let best = null, start = null;
    for (let u = -H; u <= H + 1e-6; u += STEP) {
      const deep = level - riverBedAt(cx + u, z) >= DEEP;
      if (deep && start === null) start = u;
      if ((!deep || u + STEP > H + 1e-6) && start !== null) {
        const end = deep ? u : u - STEP;
        const d = end >= 0 && start <= 0 ? 0 : Math.min(Math.abs(start), Math.abs(end));
        if (!best || d < best.d || (d === best.d && end - start > best.end - best.start)) best = { start, end, d };
        start = null;
      }
    }
    lo[i] = best ? best.start : 0;
    hi[i] = best ? best.end : 0;
  }
  // Erode along the river (a hull is up to 7 m long), then centre and smooth.
  const W = 5, B = 6;
  const loE = new Float32Array(NAV_N), hiE = new Float32Array(NAV_N), c = new Float32Array(NAV_N), half = new Float32Array(NAV_N);
  for (let i = 0; i < NAV_N; i++) {
    let a = -Infinity, b = Infinity;
    for (let k = Math.max(0, i - W); k <= Math.min(NAV_N - 1, i + W); k++) { a = Math.max(a, lo[k]); b = Math.min(b, hi[k]); }
    loE[i] = a; hiE[i] = Math.max(a, b);
  }
  for (let i = 0; i < NAV_N; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - B); k <= Math.min(NAV_N - 1, i + B); k++) { s += (loE[k] + hiE[k]) / 2; n++; }
    c[i] = s / n;
  }
  for (let i = 0; i < NAV_N; i++) half[i] = Math.max(0, Math.min(hiE[i] - c[i], c[i] - loE[i]));
  nav = { c, half };
  navKey = key;
  steepCache = null;
  return nav;
}

function navSample(arr, z) {
  const f = Math.min(NAV_N - 1.001, Math.max(0, z - NAV_Z0));
  const i = Math.floor(f), t = f - i;
  return arr[i] + (arr[i + 1] - arr[i]) * t;
}

/** Offset of a boat's lane from the river centre line at z (before ±lane). */
export const laneCentre = (z) => navSample(navChannel().c, z);

/** Lane half-offset a hull of `beam` can keep at z without leaving deep water. */
function laneAt(boat, z, beam) {
  const room = navSample(navChannel().half, z) - beam / 2 - SIDE_GAP;
  return Math.max(0.25, Math.min(boat.lane, room));
}

// ---------------------------------------------------------------- reaches

let closedCache = null, closedKey;
/** z runs where the river is not open (in a lake, out at sea, or absent). */
function closedStops() {
  if (closedCache && closedKey === terrainKey()) return closedCache;
  const out = [];
  let start = null;
  for (let z = BOAT_Z0 - 10; z <= BOAT_Z1 + 10; z++) {
    const open = riverOpenAt(z);
    if (!open && start === null) start = z;
    if ((open || z === BOAT_Z1 + 10) && start !== null) { out.push([start - 6, z + 6]); start = null; }
  }
  closedCache = out;
  closedKey = terrainKey();
  return out;
}

let steepCache = null;
function steepStops() {
  navChannel();
  if (steepCache) return steepCache;
  const out = [];
  for (let z = BOAT_Z0; z <= BOAT_Z1; z++) {
    if (Math.abs(waterLevelAt(z + 1) - waterLevelAt(z - 1)) / 2 <= STEEP) continue;
    const last = out[out.length - 1];
    if (last && z - 6 <= last[1]) last[1] = z + 6;
    else out.push([z - 6, z + 6]);
  }
  steepCache = out;
  return out;
}

/**
 * Give each boat a clear reach: the stretches between fords, bridges and
 * steep water (they never cross a ford's shallows or pass under a deck).
 * Returns true when the plan changed. Cheap (no allocation) when nothing did,
 * so it can run every frame.
 */
export function planReaches(fleet, { fords = [], bridges = [] } = {}) {
  let h = Math.imul(Number(terrainSeed()) | 0, 16777619) ^ Math.round(WATER_HALF * 1000);
  for (let i = 0; i < fords.length; i++) h = Math.imul(h ^ Math.round(fords[i].z * 4 + fords[i].half * 131), 16777619);
  for (let i = 0; i < bridges.length; i++) {
    const b = bridges[i];
    const k = b.a && b.b ? b.a.z * 3 + b.b.z * 7 + (b.width ?? 4) * 11 : b.z * 5;
    h = Math.imul(h ^ Math.round(k), 16777619);
  }
  if (h === fleet.planHash) return false;
  fleet.planHash = h;
  const stops = [];
  for (const f of fords) stops.push([f.z - f.half - 8, f.z + f.half + 8]);
  for (const b of bridges) {
    if (b.a && b.b) {
      const pad = (b.width ?? 4) / 2 + 5;
      stops.push([Math.min(b.a.z, b.b.z) - pad, Math.max(b.a.z, b.b.z) + pad]);
    } else {
      stops.push([b.z - 8, b.z + 8]);
    }
  }
  for (const s of steepStops()) stops.push(s);
  // Where the river runs through a lake or out to sea, or has none.
  for (const s of closedStops()) stops.push(s);
  const sig = `${navKey}|` + stops.map((r) => r.map((v) => v.toFixed(0)).join(':')).join('|');
  if (sig === fleet.planned) return false;
  fleet.planned = sig;
  stops.sort((a, b) => a[0] - b[0]);
  const reaches = [];
  let from = BOAT_Z0;
  for (const [a, b] of stops) {
    if (a - from > MIN_REACH) reaches.push([from, a]);
    from = Math.max(from, b);
  }
  if (BOAT_Z1 - from > MIN_REACH) reaches.push([from, BOAT_Z1]);
  // Still-water loops; with none and no open river, the fleet stays ashore.
  const loops = stillLoops();
  const river = reaches.length > 0;
  fleet.none = !river && !loops.length;
  if (!reaches.length) reaches.push([BOAT_Z0, BOAT_Z1]);
  const onStill = (b) => loops.length > 0 && (!river || b.i % 2 === 1);
  // Loops come nearest the town first, so the first boats sail where people are.
  const sailors = loops.map(() => []);
  let n = 0;
  for (const b of fleet) {
    b.still = onStill(b) ? n++ % loops.length : null;
    if (b.still != null) sailors[b.still].push(b);
  }
  sailors.forEach((crew, k) => crew.forEach((b, j) => {
    b.loop = loops[k].len;
    b.speed = 0.9 + hashId(k + 1, 45) * 0.4;
    b.phase = (j + hashId(k + 1, 46) * 0.5) / crew.length;
  }));
  // Longest reaches first, so the busiest water gets the most boats.
  reaches.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
  // Each boat takes its share of the reaches, unless it cannot turn round in
  // one (a barge needs a winding hole as wide as it is long): then the
  // longest reach that can turn it.
  const crews = reaches.map(() => []);
  for (const b of fleet) {
    if (b.still != null) continue;
    let k = b.i % reaches.length;
    if (!turnEnds(reaches[k], b.spec)) {
      const alt = reaches.findIndex((r) => turnEnds(r, b.spec));
      if (alt >= 0) k = alt;
    }
    crews[k].push(b);
  }
  reaches.forEach((r, k) => {
    const crew = crews[k];
    if (!crew.length) return;
    // One loop per reach, shared by its boats and set by the biggest hull:
    // where it can turn, and how close in to the deep water's edge it keeps.
    const big = crew.reduce((a, b) => (b.spec.length > a.spec.length ? b : a)).spec;
    const ends = turnEnds(r, big) ?? [r[0] + big.length / 2 + 1, r[1] - big.length / 2 - 1];
    const [za, zb] = ends;
    const lane = 1.1 + hashId(k + 1, 42) * 0.5;
    const speed = 0.75 + hashId(k + 1, 43) * 0.3;
    crew.forEach((b, j) => {
      Object.assign(b, { za, zb, lane, speed, beamMax: big.beam });
      b.rA = laneAt(b, za, big.beam);
      b.rB = laneAt(b, zb, big.beam);
      b.loop = 2 * (zb - za) + Math.PI * (b.rA + b.rB);
      b.phase = (j + hashId(k + 1, 44) * 0.5) / crew.length;
    });
  });
  return true;
}

/**
 * Where in reach r a hull can turn round: the first and last z at which the
 * deep water is wider than the hull's diagonal (crosswise mid-turn), with
 * room for a straight run between. null when it cannot.
 */
function turnEnds(r, spec) {
  const need = Math.hypot(spec.length / 2, spec.beam / 2) + 0.3;
  const half = navChannel().half;
  const ok = (z) => {
    for (let q = z - 2.5; q <= z + 2.5; q += 0.5) if (navSample(half, q) < need) return false;
    return true;
  };
  const a0 = r[0] + spec.length / 2 + 2, b0 = r[1] - spec.length / 2 - 2;
  let za = null, zb = null;
  for (let z = a0; z <= b0; z += 0.5) if (ok(z)) { za = z; break; }
  for (let z = b0; z >= a0; z -= 0.5) if (ok(z)) { zb = z; break; }
  return za !== null && zb !== null && zb - za >= 20 ? [za, zb] : null;
}

// ---------------------------------------------------------------- still water

// Still water at least this deep is navigable (deeper than the river's: the
// sea's swell is bigger), and a loop keeps this far off the shallows.
const STILL_DEEP = 0.6;
const LOOP_CLEAR = 6;
const LOOP_ANGLES = 96;
const LOOP_POINTS = 480;
const LOOP_REACH = 380;   // only water near the town
let loopCache = null, loopKey;

/** Navigable still water at (x, z): in a lake, pond or the sea, and deep enough. */
export function stillNavigable(x, z) {
  return stillDistanceAt(x, z) < -2 && STILL_LEVEL - heightAt(x, z) >= STILL_DEEP;
}

/**
 * Closed loops through the deep still water near the town, baked once per
 * valley: [{pts: [x, z, ...], cum, len}] with pts evenly spaced along the loop.
 */
export function stillLoops() {
  if (loopCache && loopKey === terrainKey()) return loopCache;
  loopKey = terrainKey();
  loopCache = [];
  const W = terrainWaters();
  if (!W) return loopCache;
  const centres = [];
  for (const L of W.lakes) {
    // A great lake's loop stays off the town's shore; a small lake's fills it.
    if (L.great) centres.push({ x: L.cx, z: L.cz + L.a * 0.62, reach: 110 });
    else centres.push({ x: L.cx, z: L.cz, reach: Math.max(L.a, L.b) * 1.4 });
  }
  if (W.sea) {
    // Off the beaches in front of the town, and in each cove near it.
    const x0 = W.noRiver ? 0 : riverX(W.mouth ?? 0) + 70;
    centres.push({ x: x0, z: coastZ(W.sea, x0) - 75, reach: 90 });
    for (const c of W.sea.bays) {
      if (!(c.d > 0) || c.estuary || Math.abs(c.x) > 300) continue;
      centres.push({ x: c.x, z: coastZ(W.sea, c.x) - 22, reach: 40 });
    }
  }
  centres.sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z));
  for (const c of centres) {
    if (Math.abs(c.x) > LOOP_REACH || Math.abs(c.z) > LOOP_REACH || !stillNavigable(c.x, c.z)) continue;
    const loop = loopRound(c);
    if (loop) loopCache.push(loop);
  }
  return loopCache;
}

function loopRound(c) {
  // Free radius along each bearing: out until the water turns shallow or the
  // shore comes near, less a hull's clearance.
  const r = new Float64Array(LOOP_ANGLES);
  for (let k = 0; k < LOOP_ANGLES; k++) {
    const a = (k / LOOP_ANGLES) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    let d = 0;
    while (d < c.reach && stillNavigable(c.x + dx * (d + 1), c.z + dz * (d + 1))) d += 1;
    r[k] = d - LOOP_CLEAR;
  }
  // Keep inside the narrowest nearby bearing, then round off.
  const er = new Float64Array(LOOP_ANGLES), sr = new Float64Array(LOOP_ANGLES);
  for (let k = 0; k < LOOP_ANGLES; k++) {
    let m = Infinity;
    for (let j = -4; j <= 4; j++) m = Math.min(m, r[(k + j + LOOP_ANGLES) % LOOP_ANGLES]);
    er[k] = m;
  }
  for (let k = 0; k < LOOP_ANGLES; k++) {
    let t = 0;
    for (let j = -4; j <= 4; j++) t += er[(k + j + LOOP_ANGLES) % LOOP_ANGLES];
    sr[k] = Math.min(er[k] + 2, (t / 9) * 0.85);
  }
  let lo = Infinity;
  for (const v of sr) lo = Math.min(lo, v);
  if (lo < 10) return null;   // too cramped to sail round
  // Dense, evenly spaced points (periodic Catmull-Rom over the bearings).
  const dense = [];
  const M = LOOP_POINTS;
  for (let i = 0; i < M; i++) {
    const f = (i / M) * LOOP_ANGLES, k = Math.floor(f), t = f - k;
    const p0 = sr[(k - 1 + LOOP_ANGLES) % LOOP_ANGLES], p1 = sr[k % LOOP_ANGLES], p2 = sr[(k + 1) % LOOP_ANGLES], p3 = sr[(k + 2) % LOOP_ANGLES];
    const rr = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    const a = (i / M) * Math.PI * 2;
    dense.push(c.x + Math.cos(a) * rr, c.z + Math.sin(a) * rr);
  }
  const cum = new Float64Array(M + 1);
  for (let i = 1; i <= M; i++) {
    const j = (i % M) * 2, h = (i - 1) * 2;
    cum[i] = cum[i - 1] + Math.hypot(dense[j] - dense[h], dense[j + 1] - dense[h + 1]);
  }
  return { pts: dense, cum, len: cum[M], centre: c };
}

/** Position at distance s round a still-water loop. */
function loopAt(loop, s, out) {
  const { pts, cum, len } = loop;
  s = ((s % len) + len) % len;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  const n = pts.length / 2, a = lo % n, b = hi % n;
  out.x = pts[a * 2] + (pts[b * 2] - pts[a * 2]) * t;
  out.z = pts[a * 2 + 1] + (pts[b * 2 + 1] - pts[a * 2 + 1]) * t;
  out.u = 0;
  return out;
}

// ---------------------------------------------------------------- path and pose

/** Position at loop distance s: up one side, round, down the other, round. */
export function pathAt(b, s, out) {
  if (b.still != null) return loopAt(stillLoops()[b.still], s, out);
  const P = b.loop, R = b.zb - b.za;
  s = ((s % P) + P) % P;
  let z, u;
  if (s < R) {
    z = b.za + s;
    u = laneCentre(z) + laneAt(b, z, b.beamMax ?? b.spec.beam);
  } else if (s < R + Math.PI * b.rB) {
    const a = (s - R) / b.rB;
    z = b.zb + b.rB * Math.sin(a);
    u = laneCentre(b.zb) + b.rB * Math.cos(a);
  } else if (s < 2 * R + Math.PI * b.rB) {
    z = b.zb - (s - R - Math.PI * b.rB);
    u = laneCentre(z) - laneAt(b, z, b.beamMax ?? b.spec.beam);
  } else {
    const a = (s - 2 * R - Math.PI * b.rB) / b.rA;
    z = b.za - b.rA * Math.sin(a);
    u = laneCentre(b.za) - b.rA * Math.cos(a);
  }
  out.x = riverX(z) + u;
  out.z = z;
  out.u = u;
  return out;
}

const pa = { x: 0, z: 0, u: 0 }, pb = { x: 0, z: 0, u: 0 };
const MAX_TILT = 0.06;

/**
 * Pose of boat `b` at decorative time `decoT` (travel, rocking; frozen under
 * reduced motion) and water time `waterT` (the swell it rides):
 * out = {x, y, z, yaw, pitch, roll}, y being the waterline's height.
 */
export function boatPose(b, decoT, waterT, out) {
  const s = b.speed * decoT + b.phase * b.loop;
  pathAt(b, s - 0.25, pa);
  pathAt(b, s + 0.25, pb);
  const x = (pa.x + pb.x) / 2, z = (pa.z + pb.z) / 2;
  const yaw = Math.atan2(pb.x - pa.x, pb.z - pa.z);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  // Waterline points: 0.4 of the way to the bow, stern and either side.
  const L = b.spec.length * 0.4, W = b.spec.beam * 0.4;
  const surface = b.still != null ? stillSurfaceAt : waterSurfaceAt;
  const bow = surface(x + sy * L, z + cy * L, waterT);
  const stern = surface(x - sy * L, z - cy * L, waterT);
  const port = surface(x + cy * W, z - sy * W, waterT);
  const stbd = surface(x - cy * W, z + sy * W, waterT);
  const tilt = (v) => (v > MAX_TILT ? MAX_TILT : v < -MAX_TILT ? -MAX_TILT : v);
  out.x = x;
  out.z = z;
  out.y = (bow + stern + port + stbd) / 4;
  out.yaw = yaw;
  out.pitch = tilt(Math.atan2(bow - stern, 2 * L) + 0.004 * Math.sin(decoT * 1.3 + b.seed * 6));
  out.roll = tilt(Math.atan2(port - stbd, 2 * W) + b.spec.rock * Math.sin(decoT * 1.6 + b.seed * 6.283));
  return out;
}

/**
 * World position of a point on the hull: lx across and lz along (metres from
 * the hull's centre), ly in the hull's own frame (HULL). The boat shader in
 * props.js applies the same roll, pitch and yaw.
 */
export function hullPoint(b, pose, lx, ly, lz, out) {
  const y0 = ly - b.spec.waterline;
  const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll);
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
  const x1 = lx * cr - y0 * sr, y1 = lx * sr + y0 * cr;
  const y2 = y1 * cp + lz * sp, z2 = lz * cp - y1 * sp;
  out.x = pose.x + x1 * cy + z2 * sy;
  out.y = pose.y + y2;
  out.z = pose.z - x1 * sy + z2 * cy;
  return out;
}

/** GLSL for the boat vertex shader: the same transform as hullPoint(). */
export const BOAT_POSE_GLSL = /* glsl */ `
// aBoatP: x, waterline y, z, yaw. aBoatQ: pitch, roll, waterline (hull frame).
mat3 boatBasis(vec4 q, float yaw) {
  float cr = cos(q.y), sr = sin(q.y), cp = cos(q.x), sp = sin(q.x), cy = cos(yaw), sy = sin(yaw);
  mat3 roll = mat3(cr, sr, 0.0, -sr, cr, 0.0, 0.0, 0.0, 1.0);
  mat3 pitch = mat3(1.0, 0.0, 0.0, 0.0, cp, -sp, 0.0, sp, cp);
  mat3 yawM = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  return yawM * pitch * roll;
}
`;
