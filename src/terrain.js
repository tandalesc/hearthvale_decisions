// Analytic terrain shared by the simulation, the renderer and the navigation
// worker. Every function here is pure, deterministic and cheap enough to call
// per cell or per vertex, for the current terrain seed.
//
// The seed is module state: call setTerrainSeed(seed) before building or
// restoring a town, before the renderer builds its terrain and water, and in
// the navigation worker. setTerrainSeed(null) gives the classic valley.

import {
  deriveWaters, KIND, STILL_LEVEL, CREEK_BED, CREEK_RAMP, lakeDistance, pondDistance, seaDistance,
  coveAt, coastZ, creekX, creekOffset, stillProfile,
} from './waters.js';
import { deriveLand, hillsAt, mountainsAt, riverLiftAt, swellAt, gradientNoise, noiseLine } from './land.js';

// ---------------------------------------------------------------- parameters

// The classic valley (seed null): the river and hills of the original game.
const CLASSIC = {
  seed: null,
  river: { base: 17, tilt: 0, a1: 7, l1: 23, p1: 0, a2: 5, l2: 51, p2: 0 },
  half: 6,
  hills: { base: 1.3, ax: 1.7, lx: 21, px: 0, az: 1.2, lz: 27, pz: 0, ad: 0.8, ld: 31, pd: 0 },
  rise: [10, 10],          // inland distance over which the banks climb: [west, east]
  fords: [{ z: -136, half: 5 }, { z: 2, half: 5 }, { z: 74, half: 5 }, { z: 182, half: 5 }],
  relief: null,            // hills, ridges and the mountain ring (seeded valleys only)
};

let P = CLASSIC;

// Version-2 water bodies (lakes, ponds, a delta, the sea; src/waters.js), or
// null for version-1 and classic valleys, which keep their exact old code paths.
let W = null;

// New towns get the newest terrain; saves without a terrainVersion are 1.
export const TERRAIN_VERSION = 2;

// Live bindings: importers always see the current seed's values.
export let WATER_HALF = CLASSIC.half;
export let FORDS = CLASSIC.fords;

// mulberry32 over the seed; only used to derive parameters.
function seededRandom(seed) {
  let t = (seed >>> 0) ^ 0x5bd1e995;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function deriveParams(seed) {
  const rnd = seededRandom(seed);
  const range = (lo, hi) => lo + rnd() * (hi - lo);
  const sign = () => (rnd() < 0.5 ? -1 : 1);
  const amp = range(4, 10);                   // total meander amplitude
  const split = range(0.55, 0.8);
  const river = {
    base: sign() * range(12, 26),             // the hamlet near the origin sits on either bank
    tilt: range(-0.12, 0.12),
    a1: amp * split, l1: range(18, 32), p1: range(0, Math.PI * 2),
    a2: amp * (1 - split), l2: range(40, 75), p2: range(0, Math.PI * 2),
  };
  const lift = range(0.6, 1.4);
  const hills = {
    base: range(1.0, 1.7),
    ax: 1.7 * lift * range(0.7, 1.3), lx: range(16, 30), px: range(0, Math.PI * 2),
    az: 1.2 * lift * range(0.7, 1.3), lz: range(20, 36), pz: range(0, Math.PI * 2),
    ad: 0.8 * lift * range(0.5, 1.5), ld: range(24, 40), pd: range(0, Math.PI * 2),
  };
  // One broad floodplain and one steeper bank.
  const broad = range(16, 26), steep = range(7, 11);
  const rise = rnd() < 0.5 ? [broad, steep] : [steep, broad];
  const fords = deriveFords(rnd, range);
  return { seed, river, half: range(5, 7), hills, rise, fords, relief: deriveRelief(rnd, range, river, rise) };
}

// The buildable region: the road grid covers -384..384 (src/sim/roads.js);
// hills spread over it and the mountains stand beyond it.
export const REGION = 360;

// Knolls and hills (Gaussian bumps), a ridge or two (Gaussian of distance to
// a segment), a gentle corridor along the river, and a mountain ring beyond
// the town with a gap where the river runs through.
function deriveRelief(rnd, range, river, rise) {
  const bumps = [];
  const count = 9 + Math.floor(rnd() * 7);
  for (let k = 0; k < count; k++) {
    const r = range(25, 70);
    bumps.push({ x: range(-REGION, REGION), z: range(-REGION, REGION), h: range(5, 25), r2: r * r });
  }
  const ridges = [];
  const nr = 2 + Math.floor(rnd() * 2);
  for (let k = 0; k < nr; k++) {
    const a = range(0, Math.PI), len = range(80, 240);
    const x = range(-REGION * 0.8, REGION * 0.8), z = range(-REGION * 0.8, REGION * 0.8);
    const w = range(15, 30);
    ridges.push({ x0: x - Math.cos(a) * len / 2, z0: z - Math.sin(a) * len / 2, x1: x + Math.cos(a) * len / 2, z1: z + Math.sin(a) * len / 2, h: range(8, 20), w2: w * w });
  }
  // The steep flank (short rise) carries more relief; the floodplain less.
  const flank = rise[0] < rise[1] ? [1.3, 0.6] : [0.6, 1.3];
  return {
    bumps, ridges, flank,
    // A level strip along the water before any hill may rise: wide on the
    // floodplain side, narrow under the steep flank.
    flat: [flank[0] > 1 ? 10 : 24, flank[1] > 1 ? 10 : 24],
    corridor: [range(20, 45) * (flank[0] > 1 ? 0.6 : 1), range(20, 45) * (flank[1] > 1 ? 0.6 : 1)],
    ring: { start: REGION + 40, full: range(650, 850), h: range(60, 150), lobes: 2 + Math.floor(rnd() * 4), phase: range(0, Math.PI * 2), gap: range(40, 70) },
  };
}

// 4-6 fords, one within 30 units of the origin so the hamlet has a crossing,
// the rest spread out at least 60 units apart.
function deriveFords(rnd, range) {
  const count = 4 + Math.floor(rnd() * 3);
  const fords = [{ z: Math.round(range(-25, 25)), half: Math.round(range(4, 6)) }];
  for (let tries = 0; fords.length < count && tries < 200; tries++) {
    const z = Math.round(range(-REGION + 20, REGION - 20));
    if (fords.every(f => Math.abs(f.z - z) >= 60)) fords.push({ z, half: Math.round(range(4, 6)) });
  }
  return fords.sort((a, b) => a.z - b.z);
}

// version 1: the valley as first released for this seed (river and hills).
// version 2: the same river and hills plus water bodies (src/waters.js), of
// the seed's archetype or the one asked for.
export function setTerrainSeed(seed, version = 1, archetype = null) {
  P = seed == null ? CLASSIC : deriveParams(seed);
  W = null;
  MEANDER = null;
  clearRiverCache();
  if (seed != null && version >= 2) {
    const mr = seededRandom((seed ^ 0x3c6ef372) >>> 0);
    MEANDER = { noise: gradientNoise(mr), a: 14 + mr() * 8, l: 95 + mr() * 45 };
    clearRiverCache();
    W = deriveWaters(seed, { riverX, half: P.half, fords: P.fords }, archetype);
    W.forced = archetype ?? null;
    W.land = deriveLand(seededRandom((seed ^ 0x51ed2705) >>> 0), P.relief);
    W.seaTop = W.sea ? seaTop(W.sea) : -Infinity;
    W.mouths = W.creeks.map((C) => ({ x: creekX(C, riverX, C.zEnd + 25), z: coastZ(W.sea, creekX(C, riverX, C.zEnd + 25)) - 14 }));
  }
  WATER_HALF = P.half;
  FORDS = W ? W.fords : P.fords;
  KEY = null;
  return P.seed;
}

/**
 * Point the shared terrain at a valley; cheap (returns false) when it already
 * is. archetype null means the seed's own archetype.
 */
export function useTerrain(seed, version = 1, archetype = null) {
  const v = seed != null && version >= 2 ? 2 : 1;
  if (P.seed === (seed ?? null) && terrainVersion() === v && (W?.forced ?? null) === (v === 2 ? archetype ?? null : null)) return false;
  setTerrainSeed(seed, version, archetype);
  return true;
}

export function terrainSeed() { return P.seed; }
export function terrainVersion() { return W ? 2 : 1; }
export function terrainArchetype() { return W ? W.archetype : null; }
/** Cache key for anything derived from the terrain: seed, version and archetype. */
export function terrainKey() { return (KEY ??= W ? `${P.seed}:2:${W.archetype}` : `${P.seed}`); }
let KEY = null;   // terrainKey(), made once per setTerrainSeed (it is asked for per cell)
/** The current valley's water bodies (null for version-1 and classic valleys). */
export function terrainWaters() { return W; }
/** Whether this valley has a river (every one does but the riverless archetypes). */
export function hasRiver() { return !W || !W.noRiver; }

function seaTop(S) {
  let top = -Infinity;
  for (let x = -960; x <= 960; x += 2) top = Math.max(top, coastZ(S, x));
  return top + 4;
}

// ---------------------------------------------------------------- the river

// riverX is asked for the same z over and over: every sample row of a footprint check
// (sites.js sampleRect walks columns of the same rows), and each height and water test.
// A small cache keyed by the bits of z, cleared whenever the river changes
// (setTerrainSeed), hands back exactly what the sum below gives.
const RIVER_SLOTS = 1024;
const riverLo = new Uint32Array(RIVER_SLOTS), riverHi = new Uint32Array(RIVER_SLOTS), riverVal = new Float64Array(RIVER_SLOTS);
const riverSet = new Uint8Array(RIVER_SLOTS);
const zBits = new Float64Array(1), zWords = new Uint32Array(zBits.buffer);
function clearRiverCache() { riverSet.fill(0); }

export function riverX(z) {
  zBits[0] = z;
  const lo = zWords[0], hi = zWords[1];
  const slot = Math.imul(lo ^ Math.imul(hi, 0x85ebca6b), 0x9e3779b1) >>> 22;
  if (riverSet[slot] && riverLo[slot] === lo && riverHi[slot] === hi) return riverVal[slot];
  const x = riverAt(z);
  riverLo[slot] = lo;
  riverHi[slot] = hi;
  riverVal[slot] = x;
  riverSet[slot] = 1;
  return x;
}

function riverAt(z) {
  const r = P.river;
  if (!MEANDER) return r.base + r.tilt * z + Math.sin(z / r.l1 + r.p1) * r.a1 + Math.sin(z / r.l2 + r.p2) * r.a2;
  // Version 2: the two waves damped, irregular bends laid over them.
  const waves = Math.sin(z / r.l1 + r.p1) * r.a1 + Math.sin(z / r.l2 + r.p2) * r.a2;
  return r.base + r.tilt * z + waves * 0.45 + MEANDER.a * noiseLine(MEANDER.noise, z / MEANDER.l, 3, 5.5);
}

// Version 2: irregular meanders over version 1's two waves, so no two bends
// repeat (null for version 1 and classic valleys).
let MEANDER = null;

// Fords are shallow bands across the river. The bed rises to FORD_BED inside a
// band and blends back to the full depth over FORD_BLEND units on each side.
const FORD_BLEND = 4;
const FORD_BED = -0.22;
const RIVER_BED = -0.8;
const BANK_RAMP = 1.6;

function smooth(t) { return t * t * (3 - 2 * t); }

// 0 outside every ford, 1 in the middle of one.
export function fordFactor(z) {
  let best = 0;
  for (const f of FORDS) {
    const d = Math.abs(z - f.z) - f.half;
    if (d <= 0) return 1;
    if (d < FORD_BLEND) best = Math.max(best, 1 - smooth(d / FORD_BLEND));
  }
  return best;
}

export function heightAt(x, z) {
  return W ? heightV2(x, z) : heightV1(x, z);
}

function heightV1(x, z) {
  const rx = riverX(z);
  const dist = Math.abs(x - rx);
  const h = P.hills;
  if (dist < P.half) {
    const lift = riverLift(z);
    const bed = RIVER_BED + (FORD_BED - RIVER_BED) * fordFactor(z) + lift;
    if (dist < P.half - BANK_RAMP) return bed;
    return bed + (dist - (P.half - BANK_RAMP)) / BANK_RAMP * (0.18 + lift - bed);
  }
  const hills = h.base + Math.sin(x / h.lx + h.px) * h.ax + Math.cos(z / h.lz + h.pz) * h.az + Math.sin((x + z) / h.ld + h.pd) * h.ad;
  const side = x < rx ? 0 : 1;
  const rise = P.rise[side];
  const ground = 0.18 + Math.max(0.1, hills - 0.18) * Math.min(1, (dist - P.half) / rise);
  return P.relief ? ground + reliefAt(x, z, dist - P.half, side, rx) : ground;
}

// Extra height from hills, ridges and mountains (seeded valleys only).
function reliefAt(x, z, bank, side, rx) {
  const R = P.relief;
  let up = 0;
  for (const b of R.bumps) {
    const d2 = (x - b.x) ** 2 + (z - b.z) ** 2;
    if (d2 < 9 * b.r2) up += b.h * Math.exp(-d2 / b.r2);
  }
  for (const g of R.ridges) {
    const d2 = segmentDist2(x, z, g);
    if (d2 < 9 * g.w2) up += g.h * Math.exp(-d2 / g.w2);
  }
  // Keep the river corridor gentle, so the first hamlet has room, and never
  // let a hill rise from the water faster than a walkable valley side.
  up *= R.flank[side] * smooth(Math.min(1, Math.max(0, bank / R.corridor[side])));
  up = Math.min(up, BANK_SLOPE * Math.max(0, bank - R.flat[side]));
  return up + mountainAt(x, z, rx);
}

const BANK_SLOPE = 0.3;

function segmentDist2(x, z, g) {
  const dx = g.x1 - g.x0, dz = g.z1 - g.z0;
  const t = Math.max(0, Math.min(1, ((x - g.x0) * dx + (z - g.z0) * dz) / (dx * dx + dz * dz)));
  return (x - g.x0 - t * dx) ** 2 + (z - g.z0 - t * dz) ** 2;
}

// The backdrop ring: rises past `start` to full height at `full`, lobed so
// the peaks vary, and opened into a valley where the river comes through.
function mountainAt(x, z, rx) {
  const m = P.relief.ring;
  const r = Math.sqrt(Math.sqrt(x ** 4 + z ** 4));     // a rounded square, matching the map
  if (r <= m.start) return 0;
  const t = smooth(Math.min(1, (r - m.start) / (m.full - m.start)));
  const lobes = 0.75 + 0.25 * Math.sin(Math.atan2(z, x) * m.lobes + m.phase);
  const gap = Math.exp(-((x - rx) ** 2) / (m.gap * m.gap));
  const h = m.h * t * lobes * (1 - 0.85 * gap);
  return W ? h * mountainOpen(x, z) : h;
}

// How far the river has come down from the mountains at z: the valley
// floor of the gap at the centre line (0 inside the town).
export function riverLift(z) {
  if (W) { const rx = riverX(z); return riverLiftAt(W.land, rx, z) * mountainOpen(rx, z); }
  return P.relief ? mountainAt(riverX(z), z, riverX(z)) : 0;
}

// The water surface along the centre line: 0.025 in the town reaches, rising
// where the river comes down from the mountains. Always >= bed + 0.2.
export const WATER_SURFACE = 0.025;
export function waterLevelAt(z) { return WATER_SURFACE + riverLift(z); }

// Steepness: height change per unit of distance (central differences).
export function slopeAt(x, z) {
  const e = 0.75;
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return Math.hypot(gx, gz);
}

// Facts about the valley for the renderer.
export function terrainInfo() {
  const ring = P.relief?.ring;
  return {
    seed: P.seed,
    valleyAxis: { x0: riverX(-256), z0: -256, x1: riverX(256), z1: 256, tilt: P.river.tilt },
    waterHalf: P.half,
    fords: P.fords,
    mountainStart: ring?.start ?? null,
    mountainFull: ring?.full ?? null,
    mountainHeight: ring?.h ?? 0,
    snowline: ring ? Math.round(ring.h * 0.6) : null,
    floodplain: P.rise[0] > P.rise[1] ? 'west' : 'east',
    version: terrainVersion(),
    archetype: terrainArchetype(),
  };
}

export function waterAt(x, z) {
  return W ? waterKindAt(x, z) !== KIND.LAND : Math.abs(x - riverX(z)) < P.half;
}

// A ford is a z-band where the whole channel is shallow enough to wade
// (contract: heightAt above -0.35). Testing the channel centre keeps the
// shallow bank edges elsewhere from counting as crossings.
// Version 2: every creek of a delta is wadeable along its whole length; lakes,
// ponds and the sea never are.
export function fordAt(x, z) {
  if (!W) return waterAt(x, z) && heightAt(riverX(z), z) > -0.35;
  const k = waterKindAt(x, z);
  return k === KIND.CREEK || (k === KIND.RIVER && heightAt(riverX(z), z) > -0.35);
}

// ---------------------------------------------------------------- banks

// How far a point is from the water's edge: negative over the water, 0 at the
// edge, growing inland. (The render ribbon reaches about WATER_HALF + 0.4.)
// Version 2 measures to the nearest water of any kind (lakes, ponds, creeks
// and the sea too), so setbacks and "by the water" hold on every shore.
export function bankDistance(x, z) {
  if (!W) return Math.abs(x - riverX(z)) - P.half;
  let d = z > W.riverEnd ? Math.abs(x - riverX(z)) - P.half : Infinity;
  for (const C of W.creeks) {
    if (z > C.zs || z < C.box.z0 || x < C.box.x0 || x > C.box.x1) continue;
    d = Math.min(d, creekOffset(C, riverX, x, z) - C.half);
  }
  const s = stillDistance(x, z);
  return s < d ? s : d;
}

// 0 for the west bank, 1 for the east bank.
// A valley without a river is all one side.
export function bankSide(x, z) { return W?.noRiver ? 0 : x < riverX(z) ? 0 : 1; }

// ---------------------------------------------------------------- version 2: water bodies

export { KIND, KIND_NAMES, STILL_LEVEL } from './waters.js';

const MARSH_H = 0.24;
const STILL_BANK_SLOPE = 0.3;
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Nearest still body (lake, pond or sea) to (x, z): its signed distance is
// returned and the body left in stillBody. Bodies whose box misses the point
// are skipped in a few compares.
let stillBody = null;
function stillDistance(x, z) {
  let best = Infinity;
  stillBody = null;
  for (const L of W.lakes) {
    const b = L.box;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    const d = lakeDistance(L, x, z);
    if (d < best) { best = d; stillBody = L; }
  }
  for (const Q of W.ponds) {
    const b = Q.box;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    const d = pondDistance(Q, x, z);
    if (d < best) { best = d; stillBody = Q; }
  }
  if (W.sea && z < W.seaTop + W.sea.rise) {
    const d = seaDistance(W.sea, x, z);
    if (d < best) { best = d; stillBody = W.sea; }
  }
  return best;
}

/** Signed distance to the nearest lake, pond or sea (Infinity when there are none). */
export function stillDistanceAt(x, z) {
  return W ? stillDistance(x, z) : Infinity;
}

/** Which still body is nearest (after stillDistanceAt): its KIND, and whether it is a great lake. */
export function stillBodyKind() {
  return stillBody ? (stillBody.great ? -KIND.LAKE : stillBody.kind) : KIND.LAND;
}

/** What kind of water is at (x, z): KIND.LAND, RIVER, CREEK, LAKE, POND or SEA. */
export function waterKindAt(x, z) {
  if (!W) return Math.abs(x - riverX(z)) < P.half ? KIND.RIVER : KIND.LAND;
  if (stillDistance(x, z) < 0) return stillBody.kind;
  if (z > W.riverEnd && Math.abs(x - riverX(z)) < P.half) return KIND.RIVER;
  for (const C of W.creeks) {
    if (z > C.zs || z < C.box.z0 || x < C.box.x0 || x > C.box.x1) continue;
    if (creekOffset(C, riverX, x, z) < C.half) return KIND.CREEK;
  }
  return KIND.LAND;
}

/**
 * Is waterAt false all along the straight stretch from (x0, z0) to (x1, z1), and a
 * millionth of a unit either side? true only when bounds alone settle it (false: it may
 * not be; test the points). So a leg's samples, which lie within rounding of the
 * stretch, need no waterAt of their own. It follows waterKindAt: lakes, ponds, creeks
 * and the sea are only looked at inside their boxes or bands, so a stretch whose box
 * misses all of them meets none; and riverX never strays more than riverSwing() from
 * the straight axis base + tilt * z, so neither can a stretch whose offset from that
 * axis (linear along it) stays beyond the swing and the half-width. Keep in step with
 * waterKindAt.
 */
const DRY_EPS = 1e-6;
export function dryAlong(x0, z0, x1, z1) {
  const xa = Math.min(x0, x1) - DRY_EPS, xb = Math.max(x0, x1) + DRY_EPS;
  const za = Math.min(z0, z1) - DRY_EPS, zb = Math.max(z0, z1) + DRY_EPS;
  if (!(xb - xa < Infinity && zb - za < Infinity)) return false;   // NaN or unbounded
  if (W) {
    const meets = (b) => !(xb < b.x0 || xa > b.x1 || zb < b.z0 || za > b.z1);
    for (const L of W.lakes) if (meets(L.box)) return false;
    for (const Q of W.ponds) if (meets(Q.box)) return false;
    if (W.sea && za < W.seaTop + W.sea.rise) return false;
    for (const C of W.creeks) if (!(za > C.zs || zb < C.box.z0 || xb < C.box.x0 || xa > C.box.x1)) return false;
    if (zb <= W.riverEnd) return true;
  }
  const r = P.river;
  const d0 = x0 - (r.base + r.tilt * z0), d1 = x1 - (r.base + r.tilt * z1);
  const reach = riverSwing() * (1 + 1e-9) + P.half + DRY_EPS * (2 + Math.abs(r.tilt));
  return Math.min(d0, d1) >= reach || Math.max(d0, d1) <= -reach;
}

// The most riverX can differ from base + tilt * z: the sines are at most 1, and the
// meander's gradient noise is under 1.4 (0.7 times a blend of gradient dots, each under
// 2 in size, land.js gradientNoise), and so is noiseLine's weighted mean of it.
function riverSwing() {
  const r = P.river;
  const waves = Math.abs(r.a1) + Math.abs(r.a2);
  return MEANDER ? waves * 0.45 + Math.abs(MEANDER.a) * 1.4 : waves;
}

/** The kind of the water nearest (x, z): mills and quays want KIND.RIVER. */
export function nearestWaterKind(x, z) {
  if (!W) return KIND.RIVER;
  if (W.noRiver && !W.sea && !W.lakes.length) return KIND.LAND;
  let d = z > W.riverEnd ? Math.abs(x - riverX(z)) - P.half : Infinity, k = KIND.RIVER;
  for (const C of W.creeks) {
    if (z > C.zs || z < C.box.z0 || x < C.box.x0 || x > C.box.x1) continue;
    const c = creekOffset(C, riverX, x, z) - C.half;
    if (c < d) { d = c; k = KIND.CREEK; }
  }
  if (stillDistance(x, z) < d) k = stillBody.kind;
  return k;
}

// How far a great flood rises over each kind of water: the river in spate,
// a creek, a lake after a wet winter, a pond, the sea in a storm surge.
export const FLOOD_RISE = [0, 1.5, 1.0, 0.8, 0.4, 1.2];
const FLOOD_REACH = 150;

/**
 * How deep a great flood would stand at (x, z), in metres (0 above it): the
 * floodplain. Version-1 valleys have none (they keep their old flood rule).
 */
export function floodDepthAt(x, z) {
  if (!W) return 0;
  const d = bankDistance(x, z);
  if (d > FLOOD_REACH) return 0;
  const k = nearestWaterKind(x, z);
  const level = (k === KIND.RIVER ? waterLevelAt(z) : STILL_LEVEL) + FLOOD_RISE[k];
  return Math.max(0, level - heightAt(x, z));
}

/** Height of the water surface at (x, z): the river's level, or still water's. */
export function surfaceLevelAt(x, z) {
  if (!W) return waterLevelAt(z);
  const k = waterKindAt(x, z);
  return k === KIND.LAKE || k === KIND.POND || k === KIND.SEA ? STILL_LEVEL : waterLevelAt(z);
}

/** Delta marsh: 1 on the low flats of the fan between its outer creeks, 0 off them. */
export function marshAt(x, z) {
  const D = W?.delta;
  if (!D) return 0;
  const e = D.edge;
  if (z < D.z0 - e || z > D.z1 + e || x < D.x0 - e || x > D.x1 + e) return 0;
  let lo = riverX(z), hi = lo;
  for (const C of W.creeks) {
    const cx = creekX(C, riverX, Math.max(z, C.zEnd));
    if (cx < lo) lo = cx;
    if (cx > hi) hi = cx;
  }
  const fx = Math.min(x - lo, hi - x) + 18, fz = Math.min(z - D.z0, D.z1 - z);
  return smooth01((fx + e) / (2 * e)) * smooth01((fz + e) / (2 * e));
}

/** Whether the river channel is open (not swallowed by a lake or the sea) at z. */
export function riverOpenAt(z) {
  if (!W) return true;
  if (z <= W.riverEnd) return false;
  const x = riverX(z);
  for (const L of W.lakes) if (z >= L.box.z0 && z <= L.box.z1 && lakeDistance(L, x, z) < P.half + 2) return false;
  if (W.sea && seaDistance(W.sea, x, z) < P.half + 2) return false;
  return true;
}

// The ring opens where it meets the sea, and stands back from a great lake's shore.
function mountainOpen(x, z) {
  let k = 1;
  if (W.sea) k *= smooth01((seaDistance(W.sea, x, z) - 60) / 260);
  for (const L of W.lakes) if (L.great) k *= smooth01((lakeDistance(L, x, z) - 40) / 160);
  return k;
}

// ---------------------------------------------------------------- version 2: the land

// The land (everything but the water) is baked once per valley onto a 4 m
// grid and read back bilinearly (far cheaper than the noise it is made of);
// the water is carved into it analytically, so banks and shores stay crisp.
const LAND_STEP = 4;
const LAND_EXTENT = 1024;
const LAND_N = (2 * LAND_EXTENT) / LAND_STEP + 1;
const landCache = new Map(); // terrainKey -> Float32Array (a few valleys at most)

/** The land at (x, z) from its noise: floodplain swells, hills, mountains. */
function landRaw(x, z) {
  const rx = riverX(z);
  const dist = Math.abs(x - rx);
  const side = x < rx ? 0 : 1;
  const bank = Math.max(0, dist - P.half);
  const ground = 0.18 + Math.max(0.1, swellAt(W.land, x, z) - 0.18) * Math.min(1, bank / P.rise[side]);
  return ground + hillsAt(W.land, x, z, bank, side) + mountainsAt(W.land, x, z, rx) * mountainOpen(x, z);
}

function bakeLand() {
  const key = terrainKey();
  const hit = landCache.get(key);
  if (hit) return hit;
  const n = LAND_N;
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -LAND_EXTENT + j * LAND_STEP;
    for (let i = 0; i < n; i++) H[j * n + i] = landRaw(-LAND_EXTENT + i * LAND_STEP, z);
  }
  if (landCache.size >= 4) landCache.delete(landCache.keys().next().value);
  landCache.set(key, H);
  return H;
}

/**
 * Land height at (x, z) from the baked grid (analytic beyond it). Bicubic
 * (Catmull-Rom), so slopes are smooth across grid lines: bilinear would
 * crease the ground every 4 m and the creases show in the shading.
 */
function landAt(x, z) {
  const px = (x + LAND_EXTENT) / LAND_STEP, pz = (z + LAND_EXTENT) / LAND_STEP;
  if (px < 1 || pz < 1 || px >= LAND_N - 2 || pz >= LAND_N - 2) return landRaw(x, z);
  const H = W.landGrid ??= bakeLand();
  const i = px | 0, j = pz | 0, fx = px - i, fz = pz - j;
  let out = 0;
  for (let b = -1; b <= 2; b++) {
    const k = (j + b) * LAND_N + i;
    const row = cubic(H[k - 1], H[k], H[k + 1], H[k + 2], fx);
    out += row * cubicWeight(b, fz);
  }
  return out;
}

function cubic(a, b, c, d, t) {
  return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}

// Catmull-Rom weight of tap b (-1..2) at t.
function cubicWeight(b, t) {
  const t2 = t * t, t3 = t2 * t;
  if (b === -1) return 0.5 * (-t3 + 2 * t2 - t);
  if (b === 0) return 0.5 * (3 * t3 - 5 * t2 + 2);
  if (b === 1) return 0.5 * (-3 * t3 + 4 * t2 + t);
  return 0.5 * (t3 - t2);
}

function heightV2(x, z) {
  const rx = riverX(z);
  const dist = Math.abs(x - rx);
  let h;
  if (dist < P.half && z > W.riverEnd) {
    const lift = riverLift(z);
    const bed = RIVER_BED + (FORD_BED - RIVER_BED) * fordFactor(z) + lift;
    h = dist < P.half - BANK_RAMP ? bed : bed + (dist - (P.half - BANK_RAMP)) / BANK_RAMP * (0.18 + lift - bed);
  } else {
    h = landAt(x, z);
  }
  // The delta's flats: low marsh between the creeks.
  if (W.delta) {
    const m = marshAt(x, z);
    if (m > 0 && h > MARSH_H) h += (MARSH_H + 0.05 * Math.sin(x * 0.13) * Math.sin(z * 0.11) - h) * m;
  }
  for (const C of W.creeks) {
    if (z > C.zs || z < C.box.z0 || x < C.box.x0 || x > C.box.x1) continue;
    const u = creekOffset(C, riverX, x, z);
    if (u >= C.half) continue;
    const inner = C.half - CREEK_RAMP;
    const bed = u <= inner ? CREEK_BED : CREEK_BED + (u - inner) / CREEK_RAMP * (0.18 - CREEK_BED);
    if (bed < h) h = bed;
  }
  const s = stillDistance(x, z);
  const B = stillBody;
  if (B && s < B.rise * 3) {
    const shelf = B === W.sea ? B.shelfW * (1 - 0.7 * coveAt(B, x)) : B.shelfW;
    const p = stillProfile(B, s, shelf);
    if (s < 0) {
      if (p < h) h = p;
      // Sandbars off the creek mouths: pale shallows, never dry.
      if (B === W.sea) for (const M of W.mouths) {
        const r2 = ((x - M.x) ** 2 + ((z - M.z) * 1.6) ** 2) / 256;
        if (r2 < 1) h = Math.max(h, STILL_LEVEL - 0.06 - 0.6 * r2);
      }
    } else {
      // Rise over the body's width, or longer below high ground so a hill
      // never drops to the water steeper than a walkable bank.
      const rise = Math.max(B.rise, (h - p) / STILL_BANK_SLOPE);
      if (s < rise) {
        const v = p + (h - p) * smooth01(s / rise);
        if (v < h) h = v;
      }
    }
  }
  return h;
}
