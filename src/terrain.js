// Analytic terrain shared by the simulation, the renderer and the navigation
// worker. Every function here is pure, deterministic and cheap enough to call
// per cell or per vertex, for the current terrain seed.
//
// The seed is module state: call setTerrainSeed(seed) before building or
// restoring a town, before the renderer builds its terrain and water, and in
// the navigation worker. setTerrainSeed(null) gives the classic valley.

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

export function setTerrainSeed(seed) {
  P = seed == null ? CLASSIC : deriveParams(seed);
  WATER_HALF = P.half;
  FORDS = P.fords;
  return P.seed;
}

export function terrainSeed() { return P.seed; }

// ---------------------------------------------------------------- the river

export function riverX(z) {
  const r = P.river;
  return r.base + r.tilt * z + Math.sin(z / r.l1 + r.p1) * r.a1 + Math.sin(z / r.l2 + r.p2) * r.a2;
}

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
  for (const f of P.fords) {
    const d = Math.abs(z - f.z) - f.half;
    if (d <= 0) return 1;
    if (d < FORD_BLEND) best = Math.max(best, 1 - smooth(d / FORD_BLEND));
  }
  return best;
}

export function heightAt(x, z) {
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
  return m.h * t * lobes * (1 - 0.85 * gap);
}

// How far the river has come down from the mountains at z: the valley
// floor of the gap at the centre line (0 inside the town).
export function riverLift(z) {
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
  };
}

export function waterAt(x, z) { return Math.abs(x - riverX(z)) < P.half; }

// A ford is a z-band where the whole channel is shallow enough to wade
// (contract: heightAt above -0.35). Testing the channel centre keeps the
// shallow bank edges elsewhere from counting as crossings.
export function fordAt(x, z) { return waterAt(x, z) && heightAt(riverX(z), z) > -0.35; }

// ---------------------------------------------------------------- banks

// How far a point is from the water's edge: negative over the water, 0 at the
// edge, growing inland. (The render ribbon reaches about WATER_HALF + 0.4.)
export function bankDistance(x, z) { return Math.abs(x - riverX(z)) - P.half; }

// 0 for the west bank, 1 for the east bank.
export function bankSide(x, z) { return x < riverX(z) ? 0 : 1; }
