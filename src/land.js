// The land of version-2 valleys: everything but the water. Pure and
// deterministic per seed; terrain.js carves the river, creeks, lakes and the
// sea into it. Swap this module (say, for a baked eroded heightmap) to change
// the land without touching any consumer.
//
// Shapes, from the river outward:
//   - the floodplain: a level strip along the water (wide on one bank, narrow
//     under the steeper flank), with only the long, low swells of version 1;
//   - the valley sides: rolling hills from domain-warped gradient noise, with
//     rounded crests and soft creases where rain would run off, rising with
//     distance from the river and never steeper than a walkable valley side
//     close to it;
//   - the mountains: a range beyond the town with an irregular foot, ridged
//     peaks and a valley floor where the river comes through.
//
// Version 1 keeps its own land (terrain.js heightV1); nothing here touches it.

function smooth(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }

/** Seeded 2D gradient noise (improved Perlin), about -1..1. */
export function gradientNoise(rnd) {
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x * 1.41421356;
      case 5: return -x * 1.41421356;
      case 6: return y * 1.41421356;
      default: return -y * 1.41421356;
    }
  };
  return (x, y) => {
    const fx = Math.floor(x), fy = Math.floor(y);
    const xf = x - fx, yf = y - fy;
    const X = fx & 255, Y = fy & 255;
    const u = fade(xf), v = fade(yf);
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1], ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 0.7;
  };
}

/**
 * Land parameters for a seed. rnd is the water stream's generator (so the
 * land and water of a valley are drawn together); relief is version 1's
 * (floodplain widths and flank strengths are kept, so the seed's character
 * survives).
 */
export function deriveLand(rnd, relief) {
  const range = (lo, hi) => lo + rnd() * (hi - lo);
  const noise = gradientNoise(rnd);
  const ring = relief.ring;
  return {
    noise,
    // Hills: wavelength of the broad swells, their height, and how ridged.
    hillScale: range(170, 240),
    hillH: range(16, 30),
    crest: range(0.25, 0.5),
    warp: range(25, 45),
    flank: relief.flank, flat: relief.flat, corridor: relief.corridor.map((c) => c * 1.6),
    // Mountains: where the range begins (ragged), its full height and peaks.
    mStart: ring.start, mFull: ring.full, mH: ring.h * range(0.9, 1.2), mScale: range(280, 380), gap: ring.gap,
    ox: range(-500, 500), oz: range(-500, 500),
  };
}

const BANK_SLOPE = 0.3;
const MOUNT_FLOOR = 0.15;  // the river's valley floor through the range, as a share of its height

/** Rounded-square distance from the map's middle (matches the map's shape). */
const ringR = (x, z) => Math.sqrt(Math.sqrt(x ** 4 + z ** 4));

function fbm(L, x, z, octaves) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * L.noise(x * f + o * 17.3, z * f - o * 9.1);
    n += a;
    a *= 0.5; f *= 2.03;
  }
  return s / n;
}

/** Long, low swells over the whole valley floor (in place of version 1's sine lattice). */
export function swellAt(L, x, z) {
  return 1.3 + 1.1 * fbm(L, (x - L.oz) / 140, (z + L.ox) / 140, 2);
}

/**
 * Hills on the valley sides at (x, z), `bank` metres from the river's edge
 * on `side` (0 west, 1 east). 0 on the floodplain.
 */
export function hillsAt(L, x, z, bank, side) {
  const ramp = smooth((bank - L.flat[side]) / L.corridor[side]);
  if (ramp <= 0) return 0;
  const sx = (x + L.ox) / L.hillScale, sz = (z + L.oz) / L.hillScale;
  // Domain warp: the hills lean and wander instead of sitting on a lattice.
  const wx = sx + (L.warp / L.hillScale) * L.noise(sz * 1.7 + 3.1, sx * 1.7 - 5.2);
  const wz = sz + (L.warp / L.hillScale) * L.noise(sx * 1.7 - 7.4, sz * 1.7 + 1.9);
  const body = fbm(L, wx, wz, 3) * 0.5 + 0.5;
  // Crests: rounded ridgelines along the noise's zero set; creases between.
  const r = 1 - Math.abs(L.noise(wx * 1.3 + 11.7, wz * 1.3 - 4.4));
  const shape = (1 - L.crest) * body + L.crest * r * r * body * 1.6;
  const far = 0.6 + 0.4 * smooth(bank / 260);
  let up = L.hillH * L.flank[side] * ramp * far * shape;
  // Never steeper than a walkable valley side close to the water.
  return Math.min(up, BANK_SLOPE * Math.max(0, bank - L.flat[side]));
}

/** The envelope of the range at (x, z): 0 inside the town, rising to 1. */
function rangeEnvelope(L, x, z) {
  // A ragged foot: the range starts nearer in some places than others.
  const r = ringR(x, z) + 110 * fbm(L, x / 420 + 4.2, z / 420 - 8.8, 2);
  if (r <= L.mStart) return 0;
  return smooth((r - L.mStart) / (L.mFull - L.mStart));
}

/** Mountains at (x, z) beside a river whose centre line is at rx. */
export function mountainsAt(L, x, z, rx) {
  const t = rangeEnvelope(L, x, z);
  if (t <= 0) return 0;
  const sx = (x + L.ox) / L.mScale, sz = (z + L.oz) / L.mScale;
  // Ridged peaks over broad massifs.
  const mass = fbm(L, sx * 0.5 + 21.4, sz * 0.5 - 13.2, 2) * 0.5 + 0.5;
  // Ridged multifractal (Musgrave): each octave's ridges grow where the last
  // one's did, so ridgelines branch into spurs instead of scattering.
  let ridge = 0, a = 1, f = 1, weight = 1;
  for (let o = 0; o < 3; o++) {
    let n = 1 - Math.abs(L.noise(sx * f - 31.7 + o * 5.3, sz * f + 12.9 - o * 7.7));
    n *= n * weight;
    weight = n * 2 > 1 ? 1 : n * 2;
    ridge += a * n;
    a *= 0.38; f *= 2.1;
  }
  ridge /= 1.4;
  const peaks = 0.25 + 0.75 * (0.4 * mass + 0.6 * ridge);
  const gap = Math.exp(-((x - rx) ** 2) / (L.gap * L.gap));
  return L.mH * t * (MOUNT_FLOOR + (1 - MOUNT_FLOOR) * (1 - gap) * peaks);
}

/**
 * The river's rise through the range at z: the valley floor, smooth and
 * steadily climbing (no noise), never above the land beside it.
 */
export function riverLiftAt(L, x, z) {
  return L.mH * MOUNT_FLOOR * smoothEnvelope(L, x, z);
}

// The envelope without the ragged foot, for the river (so it climbs steadily).
function smoothEnvelope(L, x, z) {
  const r = ringR(x, z) - 80;  // the foot's nearest reach, so the land beside is never lower
  if (r <= L.mStart) return 0;
  return smooth((r - L.mStart) / (L.mFull - L.mStart));
}

/** Fractal 1D noise along a line (about -1..1): organic wiggles, no sinusoids. */
export function noiseLine(noise, x, octaves = 3, salt = 0) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * noise(x * f + o * 31.7, salt + o * 7.3);
    n += a; a *= 0.5; f *= 2.13;
  }
  return s / n;
}
