// Water bodies of version-2 valleys: lakes on the river, oxbow ponds beside
// its bends, a delta's creeks and the sea on the downstream (-z) edge. Pure
// and deterministic: deriveWaters() lays them out once per seed from its own
// random stream (the river, hills and ring keep version 1's stream), and the
// distance functions below are cheap enough to call per cell or per vertex.
//
// terrain.js owns the public API (waterAt, bankDistance, waterKindAt, ...);
// this module only knows shapes. Signed distances are in metres, negative
// over the water; they are exact on straight shores and first-order
// accurate on curved ones, which is all setbacks and beaches need.
//
// No islands: creeks are shallow enough to wade along their whole length,
// ponds and lakes never enclose land, and the coast is a single-valued
// function of x.

// shore: a coast with no river; dry: no surface water at all (the town
// draws on wells). Every other archetype has the river.
export const ARCHETYPES = ['river', 'lake', 'greatlake', 'delta', 'coast', 'shore', 'dry'];
const WEIGHTS = [0.2, 0.2, 0.12, 0.12, 0.16, 0.1, 0.1];
export const RIVERLESS = new Set(['shore', 'dry']);

// Water kinds (Uint8 codes for hot paths).
export const KIND = { LAND: 0, RIVER: 1, CREEK: 2, LAKE: 3, POND: 4, SEA: 5 };
export const KIND_NAMES = ['land', 'river', 'creek', 'lake', 'pond', 'sea'];

// Still water lies in the lowland, at the town reaches' level.
export const STILL_LEVEL = 0.025;
// A creek's bed under its centre line: wadeable (terrain.js fordAt's
// contract is heightAt above -0.35).
export const CREEK_BED = -0.2;
export const CREEK_RAMP = 2.0;

// Keep every body this far from the first hamlet's ford (|z| < 25 at the
// origin) so it is founded dry, apart and near a crossing.
const HAMLET_CLEAR = 75;

import { gradientNoise, noiseLine } from './land.js';

function smooth(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// mulberry32, as in terrain.js, on a salted seed so version 1's stream is untouched.
function stream(seed) {
  // Scramble first: neighbouring seeds should not get neighbouring valleys.
  let t = Math.imul(((seed >>> 0) ^ 0x2c1b3c6d) >>> 0, 0x85ebca6b);
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
  t = (t ^ (t >>> 16)) >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** The archetype a seed gets unless one is asked for. */
export function archetypeOf(seed) {
  const rnd = stream(seed);
  const r = rnd();
  let acc = 0;
  for (let i = 0; i < ARCHETYPES.length; i++) {
    acc += WEIGHTS[i];
    if (r < acc) return ARCHETYPES[i];
  }
  return ARCHETYPES[ARCHETYPES.length - 1];
}

// ---------------------------------------------------------------- shapes

/** Lobed ellipse around (cx, cz): half-width b across x, half-length a along z. */
export function lakeDistance(L, x, z) {
  const ex = (x - L.cx) / L.b, ez = (z - L.cz) / L.a;
  const rho = Math.hypot(ex, ez);
  if (rho < 1e-9) return -Math.min(L.a, L.b);
  const r = 1 + lakeLobes(L, ex / rho, ez / rho);
  const grad = Math.hypot(ex / L.b, ez / L.a) / rho;
  return (rho - r) / grad;
}

// The outline's wander off the ellipse at direction (cx, cz) (a unit vector):
// noise sampled round a circle, so it closes on itself with no seam and no
// repeating lobes. Bounded by L.lobe.
function lakeLobes(L, cx, cz) {
  let s = 0, a = L.lobe * 0.75, f = 0.8;
  for (let o = 0; o < 3; o++) {
    s += a * L.noise(cx * f + L.ox + o * 13.1, cz * f + L.oz - o * 7.7);
    a *= 0.5; f *= 2.2;
  }
  return s;
}

/** Crescent: an arc of radius R round (cx, cz), bulging toward side s, `span` either side. */
export function pondDistance(Q, x, z) {
  const qx = (x - Q.cx) * Q.s, qz = z - Q.cz;
  const phi = Math.atan2(qz, qx);
  if (Math.abs(phi) <= Q.span) return Math.abs(Math.hypot(qx, qz) - Q.R) - Q.w / 2;
  const ex = Q.R * Math.cos(Q.span), ez = Q.R * Math.sin(Q.span) * (qz < 0 ? -1 : 1);
  return Math.hypot(qx - ex, qz - ez) - Q.w / 2;
}

/** Coastline: the sea lies where z < coastZ(x). */
export function coastZ(S, x) {
  // Broad swings and a ragged fringe of points and inlets (fractal noise),
  // plus the coves, headlands and the river's estuary or delta lobe.
  let z = S.z0 + S.swing * noiseLine(S.noise, x / S.swingL, 2, 1.7) + S.fringe * noiseLine(S.noise, x / S.fringeL, 2, 9.3);
  for (const c of S.bays) z += c.d * Math.exp(-(((x - c.x) / c.w) ** 2));
  return z;
}

// The coast's direction, over 16 m: the fringe's small wiggles must not
// make the distance inland flicker (it shapes the beach for 100 m and more).
function coastSlope(S, x) {
  return (coastZ(S, x + 8) - coastZ(S, x - 8)) / 16;
}

/** Signed distance to the coast: positive on land (z above the coast). */
export function seaDistance(S, x, z) {
  return (z - coastZ(S, x)) / Math.sqrt(1 + coastSlope(S, x) ** 2);
}

/** How much of a cove the shore at x is (0..1): coves shelve steeply. */
export function coveAt(S, x) {
  let k = 0;
  for (const c of S.bays) if (c.d > 0) k = Math.max(k, Math.exp(-(((x - c.x) / c.w) ** 2)));
  return k;
}

/** A creek's centre line at z (it leaves the river at zs and meets the sea past zEnd). */
export function creekX(C, riverX, z) {
  const f = clamp((C.zs - z) / (C.zs - C.zEnd), 0, 1);
  return riverX(z) + C.s * f * f * (3 - 2 * f) + C.wig * C.noise(z / C.wl, C.wp) * 4 * f * (1 - f);
}

/** Across-channel distance from a creek's centre line (perpendicular, approximately). */
export function creekOffset(C, riverX, x, z) {
  const cx = creekX(C, riverX, z);
  const d = creekX(C, riverX, z + 0.5) - creekX(C, riverX, z - 0.5);
  return Math.abs(x - cx) / Math.sqrt(1 + d * d);
}

// ---------------------------------------------------------------- profiles

/**
 * Ground height across a still shore at signed distance s (negative over the
 * water): a beach rising inland, a shallow shelf, then the drop to the deep.
 */
export function stillProfile(B, s, shelfW = B.shelfW) {
  const top = B.level + 0.12;
  if (s >= 0) return top + B.beach * s;
  const t = -s;
  return top - (0.12 + B.shelfDepth) * smooth(t / shelfW) - (B.depth - B.shelfDepth) * smooth((t - shelfW) / B.dropW);
}

// ---------------------------------------------------------------- layout

/**
 * Lay out the water of a version-2 valley.
 *   ctx: { riverX(z), half, fords: [{z, half}] } of the same seed
 * Returns { archetype, lakes, ponds, sea, creeks, riverEnd, delta, fords }.
 */
export function deriveWaters(seed, ctx, archetype = null) {
  const rnd = stream(seed);
  const picked = archetypeOf(seed);
  rnd(); // the archetype draw
  const kind = ARCHETYPES.includes(archetype) ? archetype : picked;
  const range = (lo, hi) => lo + rnd() * (hi - lo);
  const noise = gradientNoise(rnd);
  const sign = () => (rnd() < 0.5 ? -1 : 1);
  const { riverX, half } = ctx;
  const W = { archetype: kind, lakes: [], ponds: [], sea: null, creeks: [], riverEnd: -Infinity, delta: null, fords: ctx.fords, noRiver: RIVERLESS.has(kind) };

  if (kind === 'lake') {
    const s = sign();
    W.lakes.push(throughLake(range, noise, riverX, half, s, 40, 135));
    if (rnd() < 0.35) W.lakes.push(throughLake(range, noise, riverX, half, -s, 25, 55));
  }
  if (kind === 'greatlake') {
    const top = -range(170, 270);
    const a = range(250, 320);
    W.lakes.push({
      cx: riverX(top) + range(-50, 50), cz: top - a, a, b: a * range(0.65, 0.95),
      noise, lobe: range(0.32, 0.46), ox: range(-90, 90), oz: range(-90, 90),
      ...STILL.greatlake,
    });
    W.lakes[0].great = true;
  }
  if (kind === 'coast' || kind === 'delta' || kind === 'shore') W.sea = deriveSea(rnd, range, noise, riverX, kind);
  if (kind === 'delta') deriveDelta(W, rnd, range, sign, riverX, noise);

  for (const L of W.lakes) L.box = lakeBox(L);
  // The river ends in a great lake or the sea (it carries on through a lake).
  if (W.noRiver) {
    // No river: no channel anywhere, no fords, no oxbows.
    W.riverEnd = Infinity;
    W.fords = [];
    return W;
  }
  // mouth: where the river's centre line reaches the shore.
  if (W.sea) W.mouth = mouthZ((z) => seaDistance(W.sea, riverX(z), z));
  else if (W.lakes[0]?.great) W.mouth = mouthZ((z) => lakeDistance(W.lakes[0], riverX(z), z));
  if (W.mouth != null) W.riverEnd = W.mouth - 25;

  // Oxbow ponds beside strong bends (none in the delta's flats).
  const ponds = kind === 'river' ? Math.floor(rnd() * 3) : kind === 'lake' || kind === 'coast' ? Math.floor(rnd() * 2) : 0;
  if (ponds) derivePonds(W, ponds, rnd, range, riverX, half);

  W.fords = ctx.fords.filter((f) => fordClear(W, riverX, half, f));
  if (!W.fords.length) W.fords = [ctx.fords.reduce((a, b) => (Math.abs(a.z) < Math.abs(b.z) ? a : b))];
  return W;
}

// Shore character by body: beach slope inland, the shallow shelf, the deep.
const STILL = {
  lake: { kind: KIND.LAKE, level: STILL_LEVEL, beach: 0.06, shelfW: 6, shelfDepth: 0.5, depth: 3.5, dropW: 25, rise: 22 },
  greatlake: { kind: KIND.LAKE, level: STILL_LEVEL, beach: 0.045, shelfW: 9, shelfDepth: 0.5, depth: 8, dropW: 60, rise: 30 },
  pond: { kind: KIND.POND, level: STILL_LEVEL, beach: 0.1, shelfW: 2, shelfDepth: 0.35, depth: 1.0, dropW: 3, rise: 8 },
  sea: { kind: KIND.SEA, level: STILL_LEVEL, beach: 0.03, shelfW: 14, shelfDepth: 0.5, depth: 7, dropW: 80, rise: 45 },
};

/** A lake the river runs through, on side s of the town (+1 upstream). */
function throughLake(range, noise, riverX, half, s, aLo, aHi) {
  for (let tries = 0; tries < 40; tries++) {
    const a = range(aLo, aHi);
    const cz = s * range(HAMLET_CLEAR + a, 360 - a);
    if (Math.abs(cz) - a < HAMLET_CLEAR || Math.abs(cz) + a > 370) continue;
    const b = range(Math.max(30, a * 0.4), Math.max(36, a * 0.85));
    const L = {
      cx: riverX(cz) + range(-0.3, 0.3) * b, cz, a, b,
      noise, lobe: range(0.26, 0.4), ox: range(-90, 90), oz: range(-90, 90),
      ...STILL.lake,
    };
    // Lobes reach past the ellipse: keep the whole outline clear of the hamlet.
    const reach = L.a * lobeReach(L);
    if (Math.abs(cz) - reach < HAMLET_CLEAR || Math.abs(cz) + reach > 375) continue;
    // The river must enter and leave through the lake's ends.
    let ok = true;
    for (let k = -0.7; k <= 0.7 + 1e-9; k += 0.1) {
      const z = cz + k * a;
      if (lakeDistance(L, riverX(z), z) > -half - 6) { ok = false; break; }
    }
    if (ok) return L;
  }
  // Fallback: a round lake straddling the river.
  const a = aLo, cz = s * (HAMLET_CLEAR + a + 20);
  return { cx: riverX(cz), cz, a, b: Math.max(30, a), noise, lobe: 0, ox: 0, oz: 0, ...STILL.lake };
}

// The furthest the outline can wander past the ellipse (noise stays within
// about +-0.75 per octave).
function lobeReach(L) {
  return 1 + L.lobe * 0.75 * (1 + 0.5 + 0.25) * 0.75;
}

function lakeBox(L) {
  const r = lobeReach(L);
  // The shore may rise over up to three times the body's rise (see terrain.js).
  const m = L.rise * 3 + 4;
  return { x0: L.cx - L.b * r - m, x1: L.cx + L.b * r + m, z0: L.cz - L.a * r - m, z1: L.cz + L.a * r + m };
}

function deriveSea(rnd, range, noise, riverX, kind) {
  for (let tries = 0; tries < 40; tries++) {
    const S = {
      ...STILL.sea,
      z0: kind === 'delta' ? -range(215, 270) : -range(110, 190),
      noise, swing: range(16, 32), swingL: range(130, 220), fringe: range(5, 9), fringeL: range(34, 52),
      bays: [],
    };
    const mouthX = riverX(S.z0);
    // A delta builds its fan out into the sea: a broad lobe round the mouth.
    if (kind === 'delta') S.bays.push({ x: mouthX, w: range(90, 130), d: -range(30, 55), lobe: true });
    // A river meeting the open coast widens into an estuary bay.
    else if (kind === 'coast') S.bays.push({ x: mouthX, w: range(22, 34), d: range(22, 40), estuary: true });
    const room = (x, w) => Math.abs(x) < 330 && Math.abs(x - mouthX) > w + 35 && S.bays.every((c) => Math.abs(c.x - x) > c.w + w + 10);
    const coves = kind !== 'delta' ? 2 + Math.floor(rnd() * 2) : Math.floor(rnd() * 2);
    const heads = kind !== 'delta' ? 1 : 0;
    for (let k = 0, guard = 0; k < coves + heads && guard < 60; guard++) {
      const w = range(35, 62), x = range(-330, 330);
      if (!room(x, w)) continue;
      S.bays.push(k < coves ? { x, w, d: range(35, 70) } : { x, w: w * 1.3, d: -range(25, 50) });
      k++;
    }
    // Keep the hamlet's reach dry.
    let top = -Infinity;
    for (let x = -120; x <= 120; x += 4) top = Math.max(top, coastZ(S, x));
    if (top > -HAMLET_CLEAR - S.rise * 0.25) continue;
    return S;
  }
  return { ...STILL.sea, z0: -260, noise, swing: 0, swingL: 1, fringe: 0, fringeL: 1, bays: [] };
}

function deriveDelta(W, rnd, range, sign, riverX, noise) {
  const S = W.sea;
  const mouth = mouthZ((z) => seaDistance(S, riverX(z), z));
  const zs = Math.min(-HAMLET_CLEAR - 10, mouth + range(130, 210));
  const n = 2 + Math.floor(rnd() * 3);
  const spreads = [];
  for (let guard = 0; spreads.length < n && guard < 80; guard++) {
    const s = sign() * range(30, 140);
    if (spreads.every((t) => Math.abs(t - s) >= 30)) spreads.push(s);
  }
  spreads.sort((a, b) => a - b);
  for (const s of spreads) {
    const xm = riverX(mouth) + s;
    W.creeks.push({
      s, zs, zEnd: Math.min(mouth, coastZ(S, xm)) - 25,
      half: range(3, 4.5), wig: range(5, 10), wl: range(22, 36), wp: range(-50, 50), noise,
    });
  }
  let x0 = Infinity, x1 = -Infinity;
  for (let z = mouth - 30; z <= zs; z += 4) {
    x0 = Math.min(x0, riverX(z) + Math.min(0, spreads[0] ?? 0));
    x1 = Math.max(x1, riverX(z) + Math.max(0, spreads[spreads.length - 1] ?? 0));
  }
  // The marsh: low flats over the fan, fading out over `edge` metres.
  W.delta = { x0: x0 - 18, x1: x1 + 18, z0: mouth - 60, z1: zs + 15, edge: 30, mouth, zs };
  for (const C of W.creeks) {
    C.box = { x0: W.delta.x0 - 10, x1: W.delta.x1 + 10, z0: C.zEnd - 5, z1: C.zs + 2 };
  }
}

/** First z (walking downstream from the town) where the river is well inside the body. */
function mouthZ(dist) {
  for (let z = 0; z > -950; z -= 1) if (dist(z) < 0) return z;
  return -950;
}

function derivePonds(W, count, rnd, range, riverX, half) {
  const bends = [];
  for (let z = -340; z <= 340; z++) {
    const d0 = riverX(z) - riverX(z - 1), d1 = riverX(z + 1) - riverX(z);
    if (Math.sign(d0) !== Math.sign(d1) && Math.abs(z) > HAMLET_CLEAR) bends.push(z);
  }
  for (let guard = 0; W.ponds.length < count && guard < 30 && bends.length; guard++) {
    const zb = bends[Math.floor(rnd() * bends.length)];
    // Outward: the side the bend bulges toward.
    const s = Math.sign(riverX(zb) - (riverX(zb - 30) + riverX(zb + 30)) / 2) || 1;
    const R = range(18, 32), w = range(7, 11), span = range(1.0, 1.35);
    const Q = { cx: riverX(zb) + s * (half + range(5, 9)), cz: zb, s, R, w, span, ...STILL.pond };
    const m = R + w + Q.rise + 2;
    Q.box = { x0: Q.cx - m, x1: Q.cx + m, z0: Q.cz - m, z1: Q.cz + m };
    if (!pondClear(W, Q, riverX, half)) continue;
    W.ponds.push(Q);
  }
}

function pondClear(W, Q, riverX, half) {
  if (W.ponds.some((P) => Math.hypot(P.cx - Q.cx, P.cz - Q.cz) < P.R + Q.R + 40)) return false;
  if (W.lakes.some((L) => lakeDistance(L, Q.cx, Q.cz) < Q.R + 30)) return false;
  if (W.sea && seaDistance(W.sea, Q.cx, Q.cz) < Q.R + 60) return false;
  if (z0OutOfTown(Q) || Math.abs(Q.cz) - Q.R - Q.w < HAMLET_CLEAR) return false;
  // Clear of the river along the whole crescent.
  for (let z = Q.cz - Q.R - Q.w; z <= Q.cz + Q.R + Q.w; z += 1) {
    for (let u = -half - 4; u <= half + 4; u += 1) if (pondDistance(Q, riverX(z) + u, z) < 0) return false;
  }
  return true;
}

function z0OutOfTown(Q) { return Math.abs(Q.cz) + Q.R > 360 || Math.abs(Q.cx) + Q.R > 360; }

/** A ford survives when its band stays on open river, clear of lakes, the sea and the delta. */
function fordClear(W, riverX, half, f) {
  for (let z = f.z - f.half - 8; z <= f.z + f.half + 8; z += 2) {
    if (z < W.riverEnd + 40) return false;
    if (W.delta && z < W.delta.z1 + 10) return false;
    const x = riverX(z);
    for (const L of W.lakes) if (lakeDistance(L, x, z) < half + 12) return false;
    for (const Q of W.ponds) if (pondDistance(Q, x, z) < 6) return false;
  }
  return true;
}
