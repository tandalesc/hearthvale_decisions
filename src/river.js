// River character: what the water does along its course, for the renderer
// and the soundscape. Pure, deterministic functions of position for the
// current terrain seed; nothing here feeds the simulation (the sim's channel
// is still terrain.js: riverX, WATER_HALF, heightAt, waterAt), so saves,
// fixtures and replays are untouched.
//
// Along a meandering river the bed sorts itself (design-visual §2):
//   - POOLS on the bends: deep, slow, glassy water against the outer bank;
//   - point BARS of gravel on the inside of each bend, narrowing the water;
//   - RIFFLES at the crossings between bends: shallow, quick, broken water,
//     with a few boulders near the banks;
//   - CASCADES where the river comes down from the mountains: white water
//     round boulders strewn across the channel.
// Fords keep their own shallows and are left clear of bars and boulders.
//
// For audio: rapidsAt(x, z) gives white-water intensity (0..1) at a point,
// riverRapidsSites() the loud spots ({x, z, intensity, kind}).

import { riverX, waterLevelAt, fordFactor, heightAt, terrainKey, WATER_HALF, riverLift, riverOpenAt } from './terrain.js';

export const RIVER_Z0 = -950;
export const RIVER_Z1 = 950;
const N = RIVER_Z1 - RIVER_Z0 + 1; // one sample per metre
// Boats ply the town reaches (props.js) about 1-2 m either side of the centre
// line: valley boulders keep out of that lane.
const BOAT_LANE = 3.0;
const BOAT_REACH = 365;

function hash(id, salt = 0) {
  let h = (id * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function blur(a, radius) {
  const out = new Float32Array(a.length);
  let sum = 0, n = 0;
  for (let i = -radius; i < a.length + radius; i++) {
    const add = i + radius, sub = i - radius - 1;
    if (add >= 0 && add < a.length) { sum += a[add]; n++; }
    if (sub >= 0 && sub < a.length) { sum -= a[sub]; n--; }
    if (i >= 0 && i < a.length) out[i] = sum / Math.max(1, n);
  }
  return out;
}

let cache = null;
let cacheKey;

/** Per-metre tables for the current seed (built once per seed). */
function tables() {
  const key = `${terrainKey()}:${WATER_HALF}`;
  if (cache && cacheKey === key) return cache;
  const H = WATER_HALF;
  const curv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const z = RIVER_Z0 + i;
    curv[i] = (riverX(z + 4) - 2 * riverX(z) + riverX(z - 4)) / 16;
  }
  let cmax = 1e-6;
  for (let i = 0; i < N; i++) cmax = Math.max(cmax, Math.abs(curv[i]));
  const ford = new Float32Array(N), cascade = new Float32Array(N), gorge = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const z = RIVER_Z0 + i;
    ford[i] = fordFactor(z);
    const drop = Math.abs(waterLevelAt(z + 1) - waterLevelAt(z - 1)) / 2;
    cascade[i] = smoothstep(0.012, 0.07, drop);
    gorge[i] = smoothstep(0.3, 2.5, riverLift(z));
  }
  // Bends and the crossings between them. Each bend (a run of one curvature
  // sign) gets its own strength, so some bends grow big bars and some none.
  const barSide = new Float32Array(N), bar = new Float32Array(N), pool = new Float32Array(N), riffle = new Float32Array(N);
  let bendId = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0 && Math.sign(curv[i]) !== Math.sign(curv[i - 1])) bendId++;
    const bend = Math.abs(curv[i]) / cmax;
    const strength = hash(bendId, 7);
    // Where the river runs through a lake or out to sea it has no bed of its own.
    const open = riverOpenAt(RIVER_Z0 + i) ? 1 : 0;
    const clear = (1 - ford[i]) * (1 - gorge[i]) * open;
    // Inside of the bend: +x when the centreline curves toward +x.
    barSide[i] = curv[i] >= 0 ? 1 : -1;
    // Signed: + on the east (+x) bank, - on the west, so blurring never flips sides.
    bar[i] = barSide[i] * smoothstep(0.3, 0.85, bend) * smoothstep(0.25, 0.6, strength) * clear;
    pool[i] = smoothstep(0.4, 0.9, bend) * (1 - ford[i]) * (1 - cascade[i]) * open;
    cascade[i] *= open;
    // Riffles where the river crosses over between bends.
    const crossing = 1 - smoothstep(0.04, 0.3, bend);
    riffle[i] = crossing * (0.35 + 0.65 * hash(bendId, 11)) * smoothstep(0.2, 0.45, hash(bendId, 13) + 0.15) * (1 - ford[i]) * open;
  }
  const barS = blur(bar, 9), poolS = blur(pool, 6), riffleS = blur(riffle, 5), cascadeS = blur(cascade, 3);
  const rapids = new Float32Array(N), speed = new Float32Array(N), barW = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Bar footprint (metres in from the bank edge); about half of it is dry.
    barSide[i] = barS[i] >= 0 ? 1 : -1;
    // Blurring spreads bars; fords keep their own shallows.
    barW[i] = Math.abs(barS[i]) * H * 1.15 * (1 - ford[i]);
    const narrows = Math.abs(barS[i]) * 0.35;
    rapids[i] = Math.max(riffleS[i] * 0.75 + narrows * 0.4, cascadeS[i]);
    speed[i] = (1 + 1.5 * rapids[i]) * (1 - 0.45 * poolS[i]) * (1 + narrows);
  }
  cache = { H, barSide, barW, pool: poolS, riffle: riffleS, cascade: cascadeS, rapids, speed, ford, gorge };
  cacheKey = key;
  rocksCache = null;
  sitesCache = null;
  return cache;
}

function sample(arr, z) {
  const f = Math.min(N - 1.001, Math.max(0, z - RIVER_Z0));
  const i = Math.floor(f), t = f - i;
  return arr[i] + (arr[i + 1] - arr[i]) * t;
}

/** Everything the water shader and the soundscape want to know at z. */
export function riverInfo(z) {
  const t = tables();
  const i = Math.round(Math.min(N - 1, Math.max(0, z - RIVER_Z0)));
  return {
    rapids: sample(t.rapids, z),
    riffle: sample(t.riffle, z),
    cascade: sample(t.cascade, z),
    pool: sample(t.pool, z),
    speed: sample(t.speed, z),
    barSide: t.barSide[i],
    barWidth: sample(t.barW, z),
  };
}

/**
 * Extra height of the gravel bar above the natural bed at (x, z), render only.
 * The bar rises out of the inner bank, about half of it dry, and slopes away
 * under the water until it meets the natural bed.
 */
export function riverBarLift(x, z) {
  const t = tables();
  const w = sample(t.barW, z);
  if (w < 0.05) return 0;
  const u = x - riverX(z);
  const i = Math.round(Math.min(N - 1, Math.max(0, z - RIVER_Z0)));
  const side = t.barSide[i];
  const inward = t.H - side * u; // metres in from the bar-side bank edge
  if (inward < -1.6 || inward > t.H * 2) return 0;
  const k = Math.max(0, inward) / w;
  const water = waterLevelAt(z);
  const barTop = water + 0.16 * Math.min(1, w / 2) - 0.55 * k * k;
  return Math.max(0, barTop - heightAt(x, z));
}

/** Render bed: the analytic terrain plus gravel bars. */
export function riverBedAt(x, z) {
  return heightAt(x, z) + riverBarLift(x, z);
}

/** White-water intensity at a point (0 off the water). */
export function rapidsAt(x, z) {
  const u = Math.abs(x - riverX(z));
  if (u > WATER_HALF + 0.5) return 0;
  const i = riverInfo(z);
  // Riffles run strongest mid-channel; cascades fill the whole width.
  const across = 1 - 0.5 * smoothstep(0.3, 1, u / WATER_HALF);
  return clamp01(Math.max(i.cascade, i.rapids * across));
}

let rocksCache = null;

/**
 * Boulders in the channel: strewn across cascades, along the banks at riffles,
 * and a few dry ones on the bars. [{x, z, y, r, u, wet}] where y is the
 * boulder's centre and wet its water level.
 */
export function riverRocks() {
  const t = tables();
  if (rocksCache) return rocksCache;
  const H = t.H;
  const rocks = [];
  const add = (u, z, r, id, sink) => {
    const x = riverX(z) + u;
    const water = waterLevelAt(z);
    const bed = riverBedAt(x, z);
    // Sit on the bed, and in water show a shoulder above the surface.
    const y = Math.max(bed + r * 0.25, Math.min(water - r * sink, bed + r * 0.6));
    rocks.push({ x, z, y, r, u, wet: water, seed: hash(id, 5) });
  };
  for (let z = RIVER_Z0 + 2; z < RIVER_Z1 - 2; z += 2) {
    const id = z + 5000;
    const info = riverInfo(z);
    if (t.ford[z - RIVER_Z0] > 0.05 || !riverOpenAt(z)) continue;
    const town = Math.abs(z) < BOAT_REACH;
    // Cascades: boulders across the channel.
    if (info.cascade > 0.25 && hash(id, 1) < 0.25 + 0.5 * info.cascade) {
      const n = 1 + Math.floor(hash(id, 2) * 2.5);
      for (let k = 0; k < n; k++) {
        const u = (hash(id * 7 + k, 3) * 2 - 1) * (H - 0.8);
        if (town && Math.abs(u) < BOAT_LANE) continue;
        add(u, z + hash(id * 7 + k, 4) * 2, 0.45 + hash(id * 7 + k, 6) * 0.9, id * 7 + k, 0.3);
      }
    }
    // Riffles: boulders near the banks (mid-channel too outside the town
    // reaches, where no boats ply).
    if (info.riffle > 0.3 && hash(id, 8) < 0.4 * info.riffle) {
      const side = hash(id, 9) < 0.5 ? -1 : 1;
      const lane = town ? BOAT_LANE + 0.4 : 0.6;
      const u = side * (lane + hash(id, 10) * (H - lane - 0.9));
      add(u, z, 0.35 + hash(id, 12) * 0.5, id * 13, 0.45);
    }
    // Dry stones on the bars, in twos and threes.
    if (info.barWidth > 2.5 && hash(id, 14) < 0.07) {
      const n = 1 + Math.floor(hash(id, 18) * 3);
      for (let k = 0; k < n; k++) {
        const u = info.barSide * (H - (0.3 + hash(id * 5 + k, 15) * 0.5) * info.barWidth * 0.55);
        add(u, z + (hash(id * 5 + k, 19) - 0.5) * 2.4, 0.28 + hash(id * 5 + k, 16) * 0.4, id * 17 + k, 0);
      }
    }
  }
  rocksCache = rocks;
  return rocks;
}

let sitesCache = null;

/** Loud spots along the river: local peaks of white water. */
export function riverRapidsSites(threshold = 0.3) {
  const t = tables();
  if (sitesCache && sitesCache.threshold === threshold) return sitesCache.list;
  const list = [];
  for (let i = 3; i < N - 3; i++) {
    const v = t.rapids[i];
    if (v < threshold) continue;
    if (v < t.rapids[i - 3] || v < t.rapids[i + 3] || v < t.rapids[i - 1] || v <= t.rapids[i + 1]) continue;
    const z = RIVER_Z0 + i;
    if (list.length && z - list[list.length - 1].z < 12) continue;
    list.push({ x: riverX(z), z, intensity: Math.round(v * 100) / 100, kind: t.cascade[i] > 0.3 ? 'cascade' : 'riffle' });
  }
  sitesCache = { threshold, list };
  return list;
}

let sourcesCache = null;
let sourcesKey;

/**
 * Sound sources for the soundscape (audio.setWaterSources): every stretch of
 * broken water as [{x, z, intensity: 0..1, radius, kind}] in world units.
 * Riffles give one source each; long cascades are split into pieces of at
 * most 50 m so the roar follows the channel. Pure and deterministic for the
 * current terrain seed (call it again after setTerrainSeed).
 */
export function rapidsSources(threshold = 0.22) {
  const t = tables();
  const key = `${terrainKey()}:${WATER_HALF}:${threshold}`;
  if (sourcesCache && sourcesKey === key) return sourcesCache;
  const out = [];
  const flush = (i0, i1) => {
    const n = Math.max(1, Math.ceil((i1 - i0 + 1) / 50));
    const len = (i1 - i0 + 1) / n;
    for (let k = 0; k < n; k++) {
      const a = Math.round(i0 + k * len);
      const b = Math.min(i1, Math.round(i0 + (k + 1) * len) - 1);
      let peak = 0, at = a;
      for (let i = a; i <= b; i++) if (t.rapids[i] > peak) { peak = t.rapids[i]; at = i; }
      const zMid = RIVER_Z0 + (a + b) / 2;
      out.push({
        x: Math.round(riverX(zMid) * 10) / 10,
        z: Math.round(zMid * 10) / 10,
        intensity: Math.round(Math.min(1, peak) * 100) / 100,
        radius: Math.round(((b - a + 1) / 2 + WATER_HALF + 6) * 10) / 10,
        kind: t.cascade[at] > 0.3 ? 'cascade' : 'riffle',
      });
    }
  };
  let start = -1;
  for (let i = 0; i < N; i++) {
    const on = t.rapids[i] >= threshold;
    if (on && start < 0) start = i;
    if (start >= 0 && (!on || i === N - 1)) {
      flush(start, on ? i : i - 1);
      start = -1;
    }
  }
  sourcesCache = out;
  sourcesKey = key;
  return out;
}
