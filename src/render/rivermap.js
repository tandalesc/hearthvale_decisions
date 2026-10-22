import * as THREE from 'three';
import { WATER_HALF } from '../terrain.js';
import { RIVER_Z0, RIVER_Z1, riverInfo, riverRocks } from '../river.js';

// The river map: river character (src/river.js) baked into a small texture in
// river coordinates (u = metres across from the centre line, z), read by the
// water shader. Shared uniforms also carry the embanked runs, which the water
// (calm foam) and the terrain strip (no gravel bars against a quay wall) use.
//
//   R  foam from boulders: a ring round each stone and a wake trailing
//      downstream (the river runs toward -z)
//   G  white-water roughness: riffles, cascades, turbulence behind stones
//   B  surface speed / 2.5
//   A  pool calm (deep, slow, glassy)

const ACROSS = 32;
const ALONG_STEP = 0.5;

export const RIVER = {
  tRiver: { value: null },
  // (u min, u range, z min, z range)
  uRiverSpan: { value: new THREE.Vector4() },
  // Embanked runs: (side -1 west / +1 east, z0, z1, unused); side 0 = empty.
  uEmbank: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
};

export const EMBANK_GLSL = /* glsl */ `
uniform vec4 uEmbank[16];
// 1 where the bank at river coordinates (u across, z) is a dressed stone wall.
float embanked(vec2 uz) {
  float e = 0.0;
  for (int i = 0; i < 16; i++) {
    vec4 r = uEmbank[i];
    if (r.x == 0.0) break;
    // Soft across the middle and at the run's ends: a hard step drew the
    // switch to the walled bed as a seam down the centre of the river.
    float onSide = smoothstep(-1.8, 1.8, uz.x * r.x);
    float inRun = smoothstep(r.y - 3.0, r.y + 3.0, uz.y) * (1.0 - smoothstep(r.z - 3.0, r.z + 3.0, uz.y));
    e = max(e, onSide * inRun);
  }
  return e;
}
`;

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Is the river bank beside a lot a quay wall? toRiver is the side the river
 * lies on (+1: greater x); checked along the lot's depth.
 */
export function quayBeside(riverXAt, half, x, z, d, toRiver, runs) {
  if (!runs?.length) return false;
  for (const dz of [-d / 2, 0, d / 2]) {
    if (embankedAt(-toRiver * half, z + dz, runs) > 0.5) return true;
  }
  return false;
}

/** CPU mirror of EMBANK_GLSL embanked() for runs [{side: 'west'|'east', z0, z1}]. */
export function embankedAt(u, z, runs) {
  let e = 0;
  for (const r of runs ?? []) {
    const onSide = smoothstep(-1.8, 1.8, u * (r.side === 'west' ? -1 : 1));
    const inRun = smoothstep(r.z0 - 3, r.z0 + 3, z) * (1 - smoothstep(r.z1 - 3, r.z1 + 3, z));
    e = Math.max(e, onSide * inRun);
  }
  return e;
}

export const RIVERMAP_GLSL = /* glsl */ `
uniform sampler2D tRiver;
uniform vec4 uRiverSpan;
vec4 riverMap(vec2 uz) {
  return texture2D(tRiver, vec2((uz.x - uRiverSpan.x) / uRiverSpan.y, (uz.y - uRiverSpan.z) / uRiverSpan.w));
}
`;

/** Bake the river map for the current terrain seed (Uint8 RGBA). */
export function buildRiverMap() {
  const H = WATER_HALF;
  const uMin = -(H + 0.5), uRange = 2 * H + 1;
  const rows = Math.round((RIVER_Z1 - RIVER_Z0) / ALONG_STEP) + 1;
  const foam = new Float32Array(ACROSS * rows);
  const turb = new Float32Array(ACROSS * rows);
  const data = new Uint8Array(ACROSS * rows * 4);
  const uAt = (i) => uMin + ((i + 0.5) / ACROSS) * uRange;

  // Boulders: a ring of foam hugging the stone and a wake trailing downstream.
  for (const rock of riverRocks()) {
    const above = rock.y + rock.r * 0.75 - rock.wet; // how much stone breaks the surface
    if (above < -0.25) continue;
    const k = Math.min(1, 0.35 + (above + 0.25) * 1.2);
    const wake = 2.5 + rock.r * 5;
    const j0 = Math.max(0, Math.floor((rock.z - wake - RIVER_Z0) / ALONG_STEP));
    const j1 = Math.min(rows - 1, Math.ceil((rock.z + rock.r + 1.2 - RIVER_Z0) / ALONG_STEP));
    for (let j = j0; j <= j1; j++) {
      const dz = RIVER_Z0 + j * ALONG_STEP - rock.z;
      for (let i = 0; i < ACROSS; i++) {
        const du = uAt(i) - rock.u;
        if (Math.abs(du) > rock.r + 2) continue;
        const d = Math.hypot(du, dz);
        const ring = Math.exp(-(((d - rock.r * 0.95) / 0.35) ** 2));
        const down = -dz; // metres downstream
        const trail = down > 0 ? Math.exp(-((du / (rock.r * 0.75 + down * 0.08)) ** 2)) * Math.exp(-down / wake) : 0;
        const c = j * ACROSS + i;
        foam[c] = Math.max(foam[c], k * Math.max(ring, trail * 0.75));
        turb[c] = Math.max(turb[c], k * Math.max(ring * 0.6, trail * 0.8));
      }
    }
  }

  for (let j = 0; j < rows; j++) {
    const z = RIVER_Z0 + j * ALONG_STEP;
    const info = riverInfo(z);
    for (let i = 0; i < ACROSS; i++) {
      const u = uAt(i);
      const c = j * ACROSS + i;
      const white = rapidsAtU(u, info);
      const o = c * 4;
      data[o] = Math.round(Math.min(1, foam[c]) * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(white, turb[c])) * 255);
      data[o + 2] = Math.round(Math.min(1, info.speed / 2.5) * 255);
      data[o + 3] = Math.round(Math.min(1, info.pool) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, ACROSS, rows, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  RIVER.tRiver.value?.dispose?.();
  RIVER.tRiver.value = tex;
  RIVER.uRiverSpan.value.set(uMin, uRange, RIVER_Z0, RIVER_Z1 - RIVER_Z0);
  return tex;
}

/**
 * CPU mirror of riverMap(uz).g, the white-water roughness the water's vertex
 * swell reads: the baked map filtered as the GPU does (LINEAR, clamp to edge,
 * texel centres at half-texel offsets). 0 before the map is baked.
 */
export function riverRoughAt(u, z) {
  const tex = RIVER.tRiver.value;
  if (!tex) return 0;
  const { data, width, height } = tex.image;
  const s = RIVER.uRiverSpan.value;
  const px = ((u - s.x) / s.y) * width - 0.5;
  const py = ((z - s.z) / s.w) * height - 0.5;
  const i = Math.floor(px), j = Math.floor(py);
  const fx = px - i, fy = py - j;
  const i0 = i < 0 ? 0 : i > width - 1 ? width - 1 : i, i1 = i + 1 < 0 ? 0 : i + 1 > width - 1 ? width - 1 : i + 1;
  const j0 = j < 0 ? 0 : j > height - 1 ? height - 1 : j, j1 = j + 1 < 0 ? 0 : j + 1 > height - 1 ? height - 1 : j + 1;
  const a = data[(j0 * width + i0) * 4 + 1], b = data[(j0 * width + i1) * 4 + 1];
  const c = data[(j1 * width + i0) * 4 + 1], d = data[(j1 * width + i1) * 4 + 1];
  return ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) / 255;
}

// river.js rapidsAt() in river coordinates, reusing the row's info.
function rapidsAtU(u, info) {
  const a = Math.abs(u) / WATER_HALF;
  const t = Math.min(1, Math.max(0, (a - 0.3) / 0.7));
  const across = 1 - 0.5 * t * t * (3 - 2 * t);
  return Math.max(info.cascade, info.rapids * across);
}

/** Push the view's embanked runs into the shared uniform. */
export function setEmbankRuns(list) {
  const slots = RIVER.uEmbank.value;
  for (let i = 0; i < slots.length; i++) {
    const r = list?.[i];
    if (r) slots[i].set(r.side === 'west' ? -1 : 1, r.z0, r.z1, 0);
    else slots[i].set(0, 0, 0, 0);
  }
}
