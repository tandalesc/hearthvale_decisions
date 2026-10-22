import * as THREE from 'three';
import * as T from '../terrain.js';
import { riverBarLift } from '../river.js';
import { embankedAt } from './rivermap.js';

// The single source of truth for ground height in the renderer.
//
// A float texture over -420..420 at 1 unit per sample that every shader reads
// with the same manual filter (linear on the terrain mesh's triangles), and a CPU mirror of the exact same
// data for placement, picking and camera clamps. Four channels per sample:
//   R  ground height (terrain + building pads), with the river bed as the
//      channel strip draws it (gravel bars, none against a quay wall)
//   G  signed offset from the river centreline, u = x - riverX(z), so shaders
//      know the banks for any terrain seed without a copy of riverX
//   B  distance to the nearest water of any kind (negative over it): the
//      river's banks, and lake, pond, creek and sea shores
//   A  shore character: + beach width in metres (sand on the sea, shingle on
//      lakes), - marsh strength (the delta's mud flats and reeds)
// Building pads flatten a footprint to its foundation height and blend back
// to natural ground over PAD_BLEND units, so houses, fields, fences, decals
// and villagers all agree with the terrain mesh. Where the blends of two pads
// meet they are weighted like sim/spatial.js padHeight, never applied one
// over the other. Changes upload row ranges only (texSubImage2D), never the
// whole texture.

export const GROUND_ORIGIN = -420;
export const GROUND_STEP = 1;
export const GROUND_N = 841; // samples per side: x = ORIGIN + i * STEP (covers -420..420)
export const GROUND_LIMIT = GROUND_ORIGIN + (GROUND_N - 1) * GROUND_STEP;
const PAD_BLEND = 1.5;

/** Water surface height along the river (sim-world's waterLevelAt when present). */
export function waterLevel(z) {
  return typeof T.waterLevelAt === 'function' ? T.waterLevelAt(z) : 0.025;
}

/** GLSL: exact height (on the mesh's triangles), normal and river offset from the ground texture. */
export const GROUND_GLSL = /* glsl */ `
uniform highp sampler2D tGround;
uniform vec2 uGroundOrigin;
uniform float uGroundStep;
uniform float uGroundN;
uniform float uWaterHalf;
vec4 groundTexel(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(int(uGroundN) - 1));
  return texelFetch(tGround, c, 0);
}
// Manual interpolation on NEAREST float data, identical to the CPU mirror:
// linear over the same two triangles per cell that the terrain mesh draws
// (split along the (1,0)-(0,1) diagonal, terrain.js buildGridLevel), so
// anything placed or draped with it lies exactly on the visible ground,
// where a bilinear blend would float or sink by up to a quarter of the
// cell's twist (pad edges, banks).
vec4 groundBilinear(vec2 xz) {
  vec2 p = (xz - uGroundOrigin) / uGroundStep;
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  vec4 b = groundTexel(c + ivec2(1, 0));
  vec4 d = groundTexel(c + ivec2(0, 1));
  if (f.x + f.y <= 1.0) {
    vec4 a = groundTexel(c);
    return a + (b - a) * f.x + (d - a) * f.y;
  }
  vec4 e = groundTexel(c + ivec2(1, 1));
  return e + (d - e) * (1.0 - f.x) + (b - e) * (1.0 - f.y);
}
// Metres to the nearest water (negative over it) and the shore's character.
float groundShore(vec2 xz) {
  return groundBilinear(xz).b;
}
float groundBeach(vec2 xz) {
  return groundBilinear(xz).a;
}
float groundHeight(vec2 xz) {
  return groundBilinear(xz).r;
}
// Signed metres from the river centreline (negative = west bank side).
float groundRiverU(vec2 xz) {
  return groundBilinear(xz).g;
}
vec3 groundNormal(vec2 xz) {
  float s = uGroundStep;
  float dx = groundHeight(xz + vec2(s, 0.0)) - groundHeight(xz - vec2(s, 0.0));
  float dz = groundHeight(xz + vec2(0.0, s)) - groundHeight(xz - vec2(0.0, s));
  return normalize(vec3(-dx, 2.0 * s, -dz));
}
`;

// Beach width (+, metres) or marsh strength (-) at (x, z): the A channel.
// Version-1 valleys have only the river: 0 everywhere.
export const BEACH = { sea: 14, lake: 4, pond: 1.5 };
export function shoreCharacter(x, z, d = T.bankDistance(x, z)) {
  if (typeof T.terrainWaters !== 'function' || !T.terrainWaters()) return 0;
  const marsh = T.marshAt(x, z);
  if (marsh > 0.02) return -marsh;
  if (d > 60) return 0;
  const k = T.nearestWaterKind(x, z);
  return k === T.KIND.SEA ? BEACH.sea : k === T.KIND.LAKE ? BEACH.lake : k === T.KIND.POND ? BEACH.pond : 0;
}

/**
 * Taper the beach widths of the A channel (RGBA rows of n x n samples) in
 * place. shoreCharacter jumps (14 m of sand to none) where the nearest water
 * changes kind, from the sea to the river say, and the sand then ended in a
 * straight, stepped crease along that line. Two box passes of radius r per
 * axis (a tent of about 2r metres) let it run out instead. Marsh (negative)
 * samples are kept as they are.
 */
export function smoothBeach(data, n, r = 6) {
  const b = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) b[k] = Math.max(0, data[k * 4 + 3]);
  const tmp = new Float32Array(n);
  const pass = (stride, step) => {
    for (let line = 0; line < n; line++) {
      const o = line * stride;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += b[o + Math.max(0, Math.min(n - 1, i)) * step];
      for (let i = 0; i < n; i++) {
        tmp[i] = sum / (2 * r + 1);
        sum += b[o + Math.min(n - 1, i + r + 1) * step] - b[o + Math.max(0, i - r) * step];
      }
      for (let i = 0; i < n; i++) b[o + i * step] = tmp[i];
    }
  };
  for (let k = 0; k < 2; k++) { pass(n, 1); pass(1, n); }
  for (let k = 0; k < n * n; k++) if (data[k * 4 + 3] >= 0) data[k * 4 + 3] = b[k];
}

/**
 * Where the river meets the sea or a great lake, let the shore's beach wrap
 * round the mouth and run a little way up both banks, thinning as it goes
 * (render only: channel A). Without it the beach stopped dead at the river
 * and each bank ended in a sharp grass point at the shore. A delta's mouths
 * keep their marsh.
 */
export function estuaryBeach(data, n, run = 28) {
  const W = typeof T.terrainWaters === 'function' ? T.terrainWaters() : null;
  if (!W || W.noRiver || W.mouth == null || W.delta) return;
  const width = W.sea ? BEACH.sea : BEACH.lake;
  // Upstream is away from the open water (riverEnd lies past the mouth).
  const out = Math.sign((W.riverEnd ?? W.mouth - 1) - W.mouth) || -1;
  const reach = T.WATER_HALF + 12;
  for (let j = 0; j < n; j++) {
    const up = (GROUND_ORIGIN + j * GROUND_STEP - W.mouth) * -out;
    if (up < -12 || up > run) continue;
    const b = width * (up <= 0 ? 1 : 1 - smooth(up / run));
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 4;
      if (Math.abs(data[k + 1]) > reach || data[k + 3] < 0) continue;
      data[k + 3] = Math.max(data[k + 3], b);
    }
  }
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const toI = (x) => (x - GROUND_ORIGIN) / GROUND_STEP;

export function createGround() {
  const count = GROUND_N * GROUND_N;
  const natural = new Float32Array(count);
  // Shore character before pads (channel A): built ground takes no sand.
  const shoreBase = new Float32Array(count);
  const height = new Float32Array(count); // CPU mirror of channel R
  const data = new Float32Array(count * 4); // RGBA texture data
  const texture = new THREE.DataTexture(data, GROUND_N, GROUND_N, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  const pads = new Map(); // id -> {x0, z0, x1, z1, y}
  let embank = [];       // embanked runs [{side, z0, z1}]: no gravel bars there
  let embankKey = '';
  let embankRef = null, embankLen = -1;
  let version = 0;
  let dirty = null; // {i0, j0, i1, j1} sample rect awaiting upload
  // A whole-texture upload is pending (first upload, or after a rebuild).
  // Partial update ranges must never ride on it: Three would upload only the
  // ranges into fresh storage and leave the rest of the texture zero.
  let fullPending = true;

  const uniforms = {
    tGround: { value: texture },
    uGroundOrigin: { value: new THREE.Vector2(GROUND_ORIGIN, GROUND_ORIGIN) },
    uGroundStep: { value: GROUND_STEP },
    uGroundN: { value: GROUND_N },
    uWaterHalf: { value: T.WATER_HALF },
  };

  /** Rebuild from the current terrain seed (natural ground, river offsets, pads). */
  function fillNatural() {
    for (let j = 0; j < GROUND_N; j++) {
      const z = GROUND_ORIGIN + j * GROUND_STEP;
      const rx = T.riverX(z);
      for (let i = 0; i < GROUND_N; i++) {
        const x = GROUND_ORIGIN + i * GROUND_STEP;
        const k = j * GROUND_N + i;
        natural[k] = channelHeight(x, z, x - rx);
        data[k * 4 + 1] = x - rx;
        const shore = T.bankDistance(x, z);
        data[k * 4 + 2] = Math.max(-200, Math.min(200, shore));
        data[k * 4 + 3] = shoreCharacter(x, z, shore);
      }
    }
    estuaryBeach(data, GROUND_N);
    smoothBeach(data, GROUND_N);
    for (let k = 0; k < count; k++) shoreBase[k] = data[k * 4 + 3];
    composite({ i0: 0, j0: 0, i1: GROUND_N - 1, j1: GROUND_N - 1 });
    uniforms.uWaterHalf.value = T.WATER_HALF;
    texture.clearUpdateRanges();
    texture.needsUpdate = true;
    fullPending = true;
    dirty = null;
    version++;
  }

  /**
   * Natural ground, and in the river channel the bed as the channel strip
   * draws it (terrain.js buildStrip): the gravel bars of src/river.js rise out
   * of it, except against a quay wall. Bars reach at most 1.6 m up the bank.
   */
  function channelHeight(x, z, u) {
    const h = T.heightAt(x, z);
    if (Math.abs(u) > T.WATER_HALF + 1.7) return h;
    const bar = riverBarLift(x, z);
    return bar > 0 ? h + bar * (1 - embankedAt(u, z, embank)) : h;
  }

  /**
   * Rebuild `height` (and channel R) in a sample rect (inclusive) from natural
   * ground and every overlapping pad. Inside a footprint the ground is the
   * pad's height (the highest, where footprints overlap); in the blend ring
   * pads are averaged by their weights and eased into natural ground by the
   * total, as sim/spatial.js padHeight does, so neighbouring pads at
   * different heights meet halfway instead of the later one overwriting the
   * other's edge.
   */
  function composite(r) {
    const rw = r.i1 - r.i0 + 1, rh = r.j1 - r.j0 + 1;
    const wSum = new Float32Array(rw * rh), wy = new Float32Array(rw * rh), core = new Float32Array(rw * rh).fill(-Infinity);
    // How built each sample is, for the beach: pads that keep their sand
    // (a park by the water becomes a beach) do not count.
    const builtW = new Float32Array(rw * rh);
    for (const pad of pads.values()) {
      const a0 = Math.max(r.i0, Math.floor(toI(pad.x0 - PAD_BLEND)));
      const a1 = Math.min(r.i1, Math.ceil(toI(pad.x1 + PAD_BLEND)));
      const b0 = Math.max(r.j0, Math.floor(toI(pad.z0 - PAD_BLEND)));
      const b1 = Math.min(r.j1, Math.ceil(toI(pad.z1 + PAD_BLEND)));
      for (let j = b0; j <= b1; j++) {
        const z = GROUND_ORIGIN + j * GROUND_STEP;
        const dz = Math.max(pad.z0 - z, 0, z - pad.z1);
        for (let i = a0; i <= a1; i++) {
          const x = GROUND_ORIGIN + i * GROUND_STEP;
          const dx = Math.max(pad.x0 - x, 0, x - pad.x1);
          const q = (j - r.j0) * rw + (i - r.i0);
          if (dx === 0 && dz === 0) {
            core[q] = Math.max(core[q], pad.y);
            if (!pad.sand) builtW[q] = 1;
            continue;
          }
          // Rounded-rect distance outside the footprint, eased to natural ground.
          const w = 1 - smooth(Math.hypot(dx, dz) / PAD_BLEND);
          if (w <= 0) continue;
          wSum[q] += w;
          wy[q] += w * pad.y;
          if (!pad.sand) builtW[q] = Math.min(1, builtW[q] + w);
        }
      }
    }
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const k = j * GROUND_N + i, q = (j - r.j0) * rw + (i - r.i0);
        const n = natural[k];
        const h = core[q] > -Infinity ? core[q] : wSum[q] > 0 ? n + (wy[q] / wSum[q] - n) * Math.min(1, wSum[q]) : n;
        height[k] = h;
        data[k * 4] = h;
        // A beach stops at built ground: under a footprint no sand at all,
        // in its blend ring less by the pads' weight (marsh is left alone).
        // Parks keep theirs.
        const built = builtW[q];
        const b = shoreBase[k];
        data[k * 4 + 3] = b > 0 ? b * (1 - built) : b;
      }
    }
  }

  function rectOf(pad) {
    return {
      i0: Math.max(0, Math.floor(toI(pad.x0 - PAD_BLEND)) - 1),
      j0: Math.max(0, Math.floor(toI(pad.z0 - PAD_BLEND)) - 1),
      i1: Math.min(GROUND_N - 1, Math.ceil(toI(pad.x1 + PAD_BLEND)) + 1),
      j1: Math.min(GROUND_N - 1, Math.ceil(toI(pad.z1 + PAD_BLEND)) + 1),
    };
  }

  /** Recompute a sample rect from natural ground plus every overlapping pad. */
  function refresh(r) {
    composite(r);
    dirty = dirty
      ? { i0: Math.min(dirty.i0, r.i0), j0: Math.min(dirty.j0, r.j0), i1: Math.max(dirty.i1, r.i1), j1: Math.max(dirty.j1, r.j1) }
      : { ...r };
    version++;
  }

  /**
   * Flatten an axis-aligned footprint to height y (a building's foundation).
   * Re-setting the same id with the same values is a no-op.
   */
  function setPad(id, { x, z, w, d, y, sand = false }) {
    const next = { x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2, y, sand };
    const old = pads.get(id);
    if (old && old.x0 === next.x0 && old.z0 === next.z0 && old.x1 === next.x1 && old.z1 === next.z1 && old.y === next.y && old.sand === sand) return;
    pads.set(id, next);
    const r = rectOf(next);
    if (old) {
      const o = rectOf(old);
      r.i0 = Math.min(r.i0, o.i0); r.j0 = Math.min(r.j0, o.j0);
      r.i1 = Math.max(r.i1, o.i1); r.j1 = Math.max(r.j1, o.j1);
    }
    refresh(r);
  }

  function removePad(id) {
    const old = pads.get(id);
    if (!old) return;
    pads.delete(id);
    refresh(rectOf(old));
  }

  /**
   * Embanked runs from the view ([{side: 'west'|'east', z0, z1}], as
   * rivermap.js setEmbankRuns): a quay wall takes the gravel bar away, in the
   * channel strip and here alike. Rows near changed runs are rebuilt.
   */
  function setEmbankments(list) {
    if (list === embankRef && (list?.length ?? 0) === embankLen) return;
    embankRef = list;
    embankLen = list?.length ?? 0;
    const next = (list ?? []).slice(0, 16).map((e) => ({ side: e.side, z0: e.z0, z1: e.z1 }));
    const key = next.map((e) => `${e.side}:${e.z0}:${e.z1}`).join('|');
    if (key === embankKey) return;
    const touched = [...embank, ...next];
    embank = next;
    embankKey = key;
    for (const e of touched) {
      const j0 = Math.max(0, Math.floor(toI(Math.min(e.z0, e.z1) - 4)));
      const j1 = Math.min(GROUND_N - 1, Math.ceil(toI(Math.max(e.z0, e.z1) + 4)));
      if (j1 < j0) continue;
      // Only the channel and its banks change.
      let i0 = GROUND_N - 1, i1 = 0;
      for (let j = j0; j <= j1; j++) {
        const z = GROUND_ORIGIN + j * GROUND_STEP;
        const rx = T.riverX(z);
        const a = Math.max(0, Math.floor(toI(rx - T.WATER_HALF - 2))), b = Math.min(GROUND_N - 1, Math.ceil(toI(rx + T.WATER_HALF + 2)));
        for (let i = a; i <= b; i++) natural[j * GROUND_N + i] = channelHeight(GROUND_ORIGIN + i * GROUND_STEP, z, GROUND_ORIGIN + i * GROUND_STEP - rx);
        i0 = Math.min(i0, a); i1 = Math.max(i1, b);
      }
      if (i1 >= i0) refresh({ i0, j0, i1, j1 });
    }
  }

  /**
   * Upload pending changes (call once per frame): one texSubImage2D row range
   * per dirty row. Three's update ranges count 4 components per pixel, so
   * ranges are given in pixels x 4 regardless of the RG format.
   */
  function flush() {
    if (fullPending) {
      texture.clearUpdateRanges();
      texture.needsUpdate = true;
      fullPending = false;
      dirty = null;
      return true;
    }
    if (!dirty) return false;
    const w = dirty.i1 - dirty.i0 + 1;
    for (let j = dirty.j0; j <= dirty.j1; j++) {
      texture.addUpdateRange((j * GROUND_N + dirty.i0) * 4, w * 4);
    }
    texture.needsUpdate = true;
    dirty = null;
    return true;
  }

  /** CPU mirror: exact same interpolation as the shader, on the terrain mesh's
   * own triangles (clamped to the texture). */
  function sample(x, z) {
    const px = Math.min(GROUND_N - 1.0001, Math.max(0, toI(x)));
    const pz = Math.min(GROUND_N - 1.0001, Math.max(0, toI(z)));
    const i = Math.floor(px), j = Math.floor(pz);
    const fx = px - i, fz = pz - j;
    const k = j * GROUND_N + i;
    const b = height[k + 1], c = height[k + GROUND_N];
    if (fx + fz <= 1) {
      const a = height[k];
      return a + (b - a) * fx + (c - a) * fz;
    }
    const e = height[k + GROUND_N + 1];
    return e + (c - e) * (1 - fx) + (b - e) * (1 - fz);
  }

  /** Inside the textured area? (Outside, callers fall back to heightAt.) */
  function covers(x, z) {
    return x > GROUND_ORIGIN && z > GROUND_ORIGIN && x < GROUND_LIMIT && z < GROUND_LIMIT;
  }

  /** Height anywhere: texture inside, analytic outside. */
  function heightAtGround(x, z) {
    return covers(x, z) ? sample(x, z) : T.heightAt(x, z);
  }

  /** Smooth ground normal from the mirror (central differences). */
  function normal(x, z, out) {
    const dx = heightAtGround(x + 1, z) - heightAtGround(x - 1, z);
    const dz = heightAtGround(x, z + 1) - heightAtGround(x, z - 1);
    return out.set(-dx, 2, -dz).normalize();
  }

  fillNatural();

  return {
    uniforms,
    sample: heightAtGround,
    normal,
    covers,
    setPad,
    removePad,
    setEmbankments,
    flush,
    rebuild: fillNatural,
    version: () => version,
    dispose: () => texture.dispose(),
  };
}
