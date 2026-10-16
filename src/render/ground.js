import * as THREE from 'three';
import * as T from '../terrain.js';

// The single source of truth for ground height in the renderer.
//
// A float texture over -420..420 at 1 unit per sample that every shader reads
// with the same manual bilinear filter, and a CPU mirror of the exact same
// data for placement, picking and camera clamps. Four channels per sample:
//   R  ground height (terrain + building pads)
//   G  signed offset from the river centreline, u = x - riverX(z), so shaders
//      know the banks for any terrain seed without a copy of riverX
//   B  distance to the nearest water of any kind (negative over it): the
//      river's banks, and lake, pond, creek and sea shores
//   A  shore character: + beach width in metres (sand on the sea, shingle on
//      lakes), - marsh strength (the delta's mud flats and reeds)
// Building pads flatten a footprint to its foundation height and blend back
// to natural ground over PAD_BLEND units, so houses, fields, fences, decals
// and villagers all agree with the terrain mesh. Changes upload row ranges
// only (texSubImage2D), never the whole texture.

export const GROUND_ORIGIN = -420;
export const GROUND_STEP = 1;
export const GROUND_N = 841; // samples per side: x = ORIGIN + i * STEP (covers -420..420)
export const GROUND_LIMIT = GROUND_ORIGIN + (GROUND_N - 1) * GROUND_STEP;
const PAD_BLEND = 1.5;

/** Water surface height along the river (sim-world's waterLevelAt when present). */
export function waterLevel(z) {
  return typeof T.waterLevelAt === 'function' ? T.waterLevelAt(z) : 0.025;
}

/** GLSL: exact bilinear height, normal and river offset from the ground texture. */
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
// Manual bilinear on NEAREST float data: identical to the CPU mirror.
vec4 groundBilinear(vec2 xz) {
  vec2 p = (xz - uGroundOrigin) / uGroundStep;
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  vec4 a = groundTexel(c);
  vec4 b = groundTexel(c + ivec2(1, 0));
  vec4 d = groundTexel(c + ivec2(0, 1));
  vec4 e = groundTexel(c + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
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

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const toI = (x) => (x - GROUND_ORIGIN) / GROUND_STEP;

export function createGround() {
  const count = GROUND_N * GROUND_N;
  const natural = new Float32Array(count);
  const height = new Float32Array(count); // CPU mirror of channel R
  const data = new Float32Array(count * 4); // RGBA texture data
  const texture = new THREE.DataTexture(data, GROUND_N, GROUND_N, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  const pads = new Map(); // id -> {x0, z0, x1, z1, y}
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
        natural[k] = T.heightAt(x, z);
        data[k * 4 + 1] = x - rx;
        const shore = T.bankDistance(x, z);
        data[k * 4 + 2] = Math.max(-200, Math.min(200, shore));
        data[k * 4 + 3] = shoreCharacter(x, z, shore);
      }
    }
    height.set(natural);
    for (const pad of pads.values()) applyPad(pad, 0, 0, GROUND_N - 1, GROUND_N - 1);
    for (let k = 0; k < count; k++) data[k * 4] = height[k];
    uniforms.uWaterHalf.value = T.WATER_HALF;
    texture.clearUpdateRanges();
    texture.needsUpdate = true;
    fullPending = true;
    dirty = null;
    version++;
  }

  /** Blend one pad into `height` within the sample rect (inclusive). */
  function applyPad(pad, i0, j0, i1, j1) {
    const a0 = Math.max(i0, Math.floor(toI(pad.x0 - PAD_BLEND)));
    const a1 = Math.min(i1, Math.ceil(toI(pad.x1 + PAD_BLEND)));
    const b0 = Math.max(j0, Math.floor(toI(pad.z0 - PAD_BLEND)));
    const b1 = Math.min(j1, Math.ceil(toI(pad.z1 + PAD_BLEND)));
    for (let j = b0; j <= b1; j++) {
      const z = GROUND_ORIGIN + j * GROUND_STEP;
      const dz = Math.max(pad.z0 - z, 0, z - pad.z1);
      for (let i = a0; i <= a1; i++) {
        const x = GROUND_ORIGIN + i * GROUND_STEP;
        const dx = Math.max(pad.x0 - x, 0, x - pad.x1);
        // Rounded-rect distance outside the footprint, eased to natural ground.
        const w = 1 - smooth(Math.hypot(dx, dz) / PAD_BLEND);
        if (w <= 0) continue;
        const k = j * GROUND_N + i;
        height[k] += (pad.y - height[k]) * w;
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
    for (let j = r.j0; j <= r.j1; j++) {
      const row = j * GROUND_N;
      height.set(natural.subarray(row + r.i0, row + r.i1 + 1), row + r.i0);
    }
    for (const pad of pads.values()) {
      const pr = rectOf(pad);
      if (pr.i1 < r.i0 || pr.i0 > r.i1 || pr.j1 < r.j0 || pr.j0 > r.j1) continue;
      applyPad(pad, r.i0, r.j0, r.i1, r.j1);
    }
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const k = j * GROUND_N + i;
        data[k * 4] = height[k];
      }
    }
    dirty = dirty
      ? { i0: Math.min(dirty.i0, r.i0), j0: Math.min(dirty.j0, r.j0), i1: Math.max(dirty.i1, r.i1), j1: Math.max(dirty.j1, r.j1) }
      : { ...r };
    version++;
  }

  /**
   * Flatten an axis-aligned footprint to height y (a building's foundation).
   * Re-setting the same id with the same values is a no-op.
   */
  function setPad(id, { x, z, w, d, y }) {
    const next = { x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2, y };
    const old = pads.get(id);
    if (old && old.x0 === next.x0 && old.z0 === next.z0 && old.x1 === next.x1 && old.z1 === next.z1 && old.y === next.y) return;
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

  /** CPU mirror: exact same bilinear as the shader (clamped to the texture). */
  function sample(x, z) {
    const px = Math.min(GROUND_N - 1.0001, Math.max(0, toI(x)));
    const pz = Math.min(GROUND_N - 1.0001, Math.max(0, toI(z)));
    const i = Math.floor(px), j = Math.floor(pz);
    const fx = px - i, fz = pz - j;
    const k = j * GROUND_N + i;
    const a = height[k], b = height[k + 1], c = height[k + GROUND_N], e = height[k + GROUND_N + 1];
    const top = a + (b - a) * fx;
    return top + (c + (e - c) * fx - top) * fz;
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
    flush,
    rebuild: fillNatural,
    version: () => version,
    dispose: () => texture.dispose(),
  };
}
