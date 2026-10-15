// Seeded randomness. Every random draw in the simulation goes through rng(state).
//
// The state keeps one uint32 per stream in `state.rng`. The 'main' stream drives
// the economy, households, eras and governance. The 'people' stream drives the
// visible walkers only, so that walker timing (which depends on asynchronous
// route results in the browser) can never change the economy's draw sequence.

const DEFAULT_STREAM = 'main';

export function seedStreams(seed) {
  const base = (seed >>> 0) || 1;
  return {main: base, people: hash32(base ^ 0x9e3779b9)};
}

// mulberry32: fast, small, good enough for games.
export function rng(state, stream = DEFAULT_STREAM) {
  let t = (state.rng[stream] = (state.rng[stream] + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const chance = (state, p, stream) => rng(state, stream) < p;

export const rngInt = (state, lo, hi, stream) => lo + Math.floor(rng(state, stream) * (hi - lo + 1));

export const rngRange = (state, lo, hi, stream) => lo + rng(state, stream) * (hi - lo);

export function pick(state, list, stream) {
  return list.length ? list[Math.floor(rng(state, stream) * list.length)] : undefined;
}

export function shuffle(state, list, stream) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng(state, stream) * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Round a non-negative expected count to an integer, keeping the expectation:
// 2.3 becomes 3 with probability 0.3, otherwise 2.
export function roundRandom(state, x, stream) {
  const whole = Math.floor(x);
  return whole + (rng(state, stream) < x - whole ? 1 : 0);
}

// Sample a key from {key: weight} (or an index from a weight array) with r in [0, 1).
// Keys are visited in sorted order so the result never depends on insertion order.
export function sampleDist(probs, r) {
  if (Array.isArray(probs)) {
    let total = 0;
    for (const p of probs) total += p > 0 ? p : 0;
    if (total <= 0) return -1;
    let x = r * total;
    for (let i = 0; i < probs.length; i++) {
      if (probs[i] > 0 && (x -= probs[i]) < 0) return i;
    }
    return probs.length - 1;
  }
  const keys = Object.keys(probs).sort();
  let total = 0;
  for (const k of keys) total += probs[k] > 0 ? probs[k] : 0;
  if (total <= 0) return null;
  let x = r * total;
  let last = null;
  for (const k of keys) {
    if (!(probs[k] > 0)) continue;
    last = k;
    if ((x -= probs[k]) < 0) return k;
  }
  return last;
}

// Small integer hash, used for stable per-id variation (looks, phases) without
// consuming random draws.
export function hash32(n) {
  let h = n >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

export const hashUnit = (n) => hash32(n) / 4294967296;
