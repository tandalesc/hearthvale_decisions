import * as THREE from 'three';
import { heightAt, riverX, WATER_HALF, terrainSeed, terrainKey, terrainWaters, stillDistanceAt, stillBodyKind, STILL_LEVEL, KIND, hasRiver } from '../terrain.js';
import { creekX } from '../waters.js';
import { riverBedAt, riverRocks } from '../river.js';
import { LAYER_REFLECT, patchMaterial, hashId, NOISE } from './shaderlib.js';
import { waterLevel } from './ground.js';
import { RIVER, EMBANK_GLSL, RIVERMAP_GLSL, buildRiverMap, setEmbankRuns, riverRoughAt } from './rivermap.js';
import './atmosphere.js';

// River water (design-visual §2): a ribbon that follows riverX(z) at the
// river's surface level (descending from the mountains where the terrain
// does), a generated tileable normal map, one ShaderMaterial for all tiers,
// and an optional planar reflection on the high tier (flat reaches only).
//
// The river has a character along its course (src/river.js, baked into the
// river map): glassy dark pools on the bends, gravel bars on their insides,
// quick broken riffles between them, white-water cascades where the river
// comes down from the mountains, and boulders with foam rings and wakes.
// Ripples flow at the local speed (two-phase flow, so fast and slow reaches
// never shear the pattern).

export const WATER_Y = 0.025;
const Z_MIN = -950;
const Z_MAX = 950;
const Z_STEP = 2;
// Across-river offsets (metres from the centreline) for the seeded channel
// half-width H. The outer lanes sit just under the bank so the edge is hidden
// by terrain and fades by depth.
// Half-metre lanes, so gravel bars get a clean waterline.
function laneOffsets(H = WATER_HALF) {
  const half = [];
  for (let u = 0; u < H - 0.05; u += 0.5) half.push(u);
  half.push(H, H + 0.4);
  return [...half.slice(1).reverse().map((u) => -u), ...half];
}

// How much of a ribbon vertex lies in still water (a lake, or the sea at the
// river's mouth): over the first STILL_BLEND metres the river's water takes
// on the still surface's colour and calm and fades out, so the river runs
// into the open water instead of ending in a band.
const STILL_BLEND = 16;
function stillShare(x, z) {
  const d = stillDistanceAt(x, z);
  return d >= 0 ? 0 : Math.min(1, -d / STILL_BLEND);
}

/**
 * Ribbon geometry with depth, flow tangent and across/along coordinates.
 * centre(z) and half give the channel (the river by default; delta creeks
 * pass their own). Quads wholly in still water are left out.
 */
export function buildRiverRibbon({ zMin = Z_MIN, zMax = Z_MAX, step = Z_STEP, centre = riverX, half = WATER_HALF } = {}) {
  const rows = Math.floor((zMax - zMin) / step) + 1;
  const LANES = laneOffsets(half);
  // A riverless valley keeps the vertices (the CPU mirror indexes them) but draws nothing.
  const draw = centre !== riverX || hasRiver();
  const n = LANES.length;
  const pos = new Float32Array(rows * n * 3);
  const uv = new Float32Array(rows * n * 2);
  const depth = new Float32Array(rows * n);
  const depth0 = new Float32Array(rows * n);
  const flow = new Float32Array(rows * n * 2);
  const bank = new Float32Array(rows * n);
  const reach = new Float32Array(rows * n * 2);
  const still = new Float32Array(rows * n);
  const index = [];
  for (let r = 0; r < rows; r++) {
    const z = zMin + r * step;
    const cx = centre(z);
    // Tangent of the centreline: d(centre)/dz.
    const dx = centre(z + 0.5) - centre(z - 0.5);
    const len = Math.hypot(dx, 1);
    const level = waterLevel(z);
    // Reach: how fast the surface drops (rapids) and how close it is to the
    // town's mirror plane (planar reflection only where flat).
    const drop = Math.abs(waterLevel(z + 1) - waterLevel(z - 1)) / 2;
    const flat = 1 - Math.min(1, Math.max(0, (Math.abs(level - WATER_Y) - 0.05) / 0.45));
    for (let l = 0; l < n; l++) {
      const i = r * n + l;
      const u = LANES[l];
      const x = cx + u;
      pos[i * 3] = x; pos[i * 3 + 1] = level; pos[i * 3 + 2] = z;
      uv[i * 2] = u; uv[i * 2 + 1] = z;
      // Depth over the render bed (gravel bars included) and over the natural
      // bed (where a quay wall replaces the bar).
      depth[i] = Math.max(0, level - riverBedAt(x, z));
      depth0[i] = Math.max(0, level - heightAt(x, z));
      reach[i * 2] = drop; reach[i * 2 + 1] = flat;
      flow[i * 2] = dx / len; flow[i * 2 + 1] = 1 / len;
      bank[i] = Math.max(0, half - Math.abs(u));
      still[i] = stillShare(x, z);
      if (r > 0 && l > 0) {
        const p = i - n;
        if (draw && (still[p - 1] < 1 || still[i - 1] < 1 || still[i] < 1 || still[p] < 1)) index.push(p - 1, i - 1, i, p - 1, i, p);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  g.setAttribute('aDepth0', new THREE.BufferAttribute(depth0, 1));
  g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
  g.setAttribute('aBank', new THREE.BufferAttribute(bank, 1));
  g.setAttribute('aReach', new THREE.BufferAttribute(reach, 2));
  g.setAttribute('aStill', new THREE.BufferAttribute(still, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** All of a delta's creeks as one ribbon geometry (null without creeks). */
export function buildCreekRibbons() {
  const W = terrainWaters();
  if (!W?.creeks.length) return null;
  const parts = W.creeks.map((C) => buildRiverRibbon({
    zMin: Math.floor(C.zEnd), zMax: Math.ceil(C.zs), step: 1, half: C.half,
    centre: (z) => creekX(C, riverX, z),
  }));
  return mergeGeometries(parts);
}

function mergeGeometries(parts) {
  const names = Object.keys(parts[0].attributes);
  const g = new THREE.BufferGeometry();
  for (const name of names) {
    const size = parts[0].attributes[name].itemSize;
    const total = parts.reduce((s, p) => s + p.attributes[name].array.length, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const p of parts) { arr.set(p.attributes[name].array, o); o += p.attributes[name].array.length; }
    g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  const index = [];
  let base = 0;
  for (const p of parts) {
    for (const k of p.index.array) index.push(k + base);
    base += p.attributes.position.count;
  }
  g.setIndex(index);
  g.computeBoundingSphere();
  for (const p of parts) p.dispose();
  return g;
}

// ---------------------------------------------------------------------------
// Still water: lakes, ponds and the sea as one level surface at STILL_LEVEL.
// A grid of 16 m cells over the bodies, cut to 4 m cells along the shores (so
// the shallows shade by depth and the waterline is clean), and 128 m cells
// from 1 km out to the horizon on the sea. The terrain hides whatever lies
// under dry ground.

export const STILL = { cell: 16, fine: 4, far: 128, near: 1024, horizon: 4096 };
// Swell on still water, by body: the sea heaves, lakes barely move. Mirrored
// on the CPU by stillSurfaceAt (boats ride it).
// Two long-crested swells from different quarters (a product of sines would
// read as a checkerboard on open water).
export const STILL_SWELL = { amp: 0.07, ax: 0.27, az: -0.19, wa: 0.8, bx: -0.11, bz: 0.29, wb: 0.62, mix: 0.4, fadeDepth: 0.6 };
const EXPOSURE = { sea: 1, great: 0.45, lake: 0.25, pond: 0.1 };

function exposureAt(x, z) {
  const d = stillDistanceAt(x, z);
  const k = stillBodyKind();
  return { d, e: k === KIND.SEA ? EXPOSURE.sea : k === -KIND.LAKE ? EXPOSURE.great : k === KIND.LAKE ? EXPOSURE.lake : EXPOSURE.pond };
}

// One still-water vertex: shore distance, exposure and depth (shared by the
// mesh and its CPU mirror, so they agree exactly).
function stillVertex(x, z) {
  const { d, e } = exposureAt(x, z);
  const far = Math.abs(x) > STILL.near || Math.abs(z) > STILL.near;
  const bed = far ? STILL_LEVEL - 30 : Math.min(heightAt(x, z), STILL_LEVEL + 0.5);
  return { d, e, depth: Math.max(0, STILL_LEVEL - bed) };
}

// VERT's STILL swell at one vertex.
function stillVertexY(x, z, t) {
  const v = stillVertex(x, z);
  const S = STILL_SWELL;
  const k = Math.min(1, v.depth / S.fadeDepth);
  return STILL_LEVEL + S.amp * v.e * k * k * (3 - 2 * k)
    * ((1 - S.mix) * Math.sin(x * S.ax + z * S.az + t * S.wa) + S.mix * Math.sin(x * S.bx + z * S.bz + t * S.wb));
}

/**
 * Height of the drawn still water (lakes, ponds, the sea) at (x, z) at water
 * time t: the mesh of buildStillWater() with its vertex swell, interpolated
 * across the same triangles as the GPU does. What a hull on still water rides.
 */
export function stillSurfaceAt(x, z, t) {
  // The cell that covers (x, z), chosen as buildStillWater chose it.
  let s;
  if (Math.abs(x) >= STILL.near || Math.abs(z) >= STILL.near) s = STILL.far;
  else {
    const C = STILL.cell;
    const cx = Math.floor(x / C) * C, cz = Math.floor(z / C) * C;
    s = stillDistanceAt(cx + C / 2, cz + C / 2) < -C * 0.75 - 3 ? C : STILL.fine;
  }
  const x0 = Math.floor(x / s) * s, z0 = Math.floor(z / s) * s;
  const u = (x - x0) / s, v = (z - z0) / s;
  // Quad (a, b, c, d) = (x0,z0), (x1,z0), (x0,z1), (x1,z1); triangles (a, c, b) and (b, c, d).
  const b = stillVertexY(x0 + s, z0, t), c = stillVertexY(x0, z0 + s, t);
  if (u + v <= 1) {
    const a = stillVertexY(x0, z0, t);
    return a + u * (b - a) + v * (c - a);
  }
  const d = stillVertexY(x0 + s, z0 + s, t);
  return d + (1 - u) * (c - d) + (1 - v) * (b - d);
}

/** Still-water geometry for the current valley (null when it has none). */
export function buildStillWater() {
  const W = terrainWaters();
  if (!W || (!W.lakes.length && !W.ponds.length && !W.sea)) return null;
  const pos = [], uv = [], depth = [], flow = [], bank = [], reach = [], still = [], index = [];
  const verts = new Map();
  const vertex = (x, z) => {
    const key = `${x},${z}`;
    let v = verts.get(key);
    if (v !== undefined) return v;
    v = pos.length / 3;
    verts.set(key, v);
    const { d, e, depth: dp } = stillVertex(x, z);
    pos.push(x, STILL_LEVEL, z);
    uv.push(x, z);
    depth.push(dp);
    flow.push(e, 0);
    bank.push(Math.max(0, -d));
    reach.push(0, 1);
    still.push(0);
    return v;
  };
  const quad = (x0, z0, x1, z1) => {
    const a = vertex(x0, z0), b = vertex(x1, z0), c = vertex(x0, z1), d = vertex(x1, z1);
    index.push(a, c, b, b, c, d);
  };
  // Bounds of all still water near the town.
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const B of [...W.lakes, ...W.ponds]) {
    bx0 = Math.min(bx0, B.box.x0); bx1 = Math.max(bx1, B.box.x1);
    bz0 = Math.min(bz0, B.box.z0); bz1 = Math.max(bz1, B.box.z1);
  }
  if (W.sea) { bx0 = -STILL.near; bx1 = STILL.near; bz0 = -STILL.near; bz1 = Math.max(bz1, W.seaTop + 8); }
  const C = STILL.cell, F = STILL.fine, R = C * 0.75;
  const gx0 = Math.max(-STILL.near, Math.floor(bx0 / C) * C), gx1 = Math.min(STILL.near, Math.ceil(bx1 / C) * C);
  const gz0 = Math.max(-STILL.near, Math.floor(bz0 / C) * C), gz1 = Math.min(STILL.near, Math.ceil(bz1 / C) * C);
  for (let z = gz0; z < gz1; z += C) {
    for (let x = gx0; x < gx1; x += C) {
      const mid = stillDistanceAt(x + C / 2, z + C / 2);
      if (mid > R + 3) continue;               // dry land
      if (mid < -R - 3) { quad(x, z, x + C, z + C); continue; }  // open water
      for (let fz = z; fz < z + C; fz += F) {
        for (let fx = x; fx < x + C; fx += F) {
          if (stillDistanceAt(fx + F / 2, fz + F / 2) > F + 1.5) continue;
          quad(fx, fz, fx + F, fz + F);
        }
      }
    }
  }
  // The open sea out to the horizon.
  if (W.sea) {
    const H = STILL.horizon, Q = STILL.far;
    for (let z = -H; z < -STILL.near; z += Q) {
      for (let x = -H; x < H; x += Q) quad(x, z, x + Q, z + Q);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  g.setAttribute('aDepth0', new THREE.Float32BufferAttribute(depth, 1));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
  g.setAttribute('aBank', new THREE.Float32BufferAttribute(bank, 1));
  g.setAttribute('aReach', new THREE.Float32BufferAttribute(reach, 2));
  g.setAttribute('aStill', new THREE.Float32BufferAttribute(still, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// The displayed surface on the CPU (boats ride it): the ribbon's per-vertex
// level plus VERT's swell, interpolated across the ribbon's triangles exactly
// as the GPU does. Keep swellAmp / the sine terms in step with VERT.

export const SWELL = { base: 0.012, rough: 0.03, kx: 1.7, wx: 1.3, kz: 1.1, kzRough: 1.6, wz: 0.9, wzRough: 2.0, fadeDepth: 0.25 };
const g = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v)); // a GLSL float literal
// Static per-vertex terms (x, level, amplitude, z wavenumber, z frequency) in
// a small direct-mapped cache: craft revisit the same few vertices for
// seconds at a time, so the bed and river-map lookups run once per vertex.
const VC = 1024;
const vcKey = new Float64Array(VC).fill(NaN);
const vcData = new Float64Array(VC * 5);
let vcStamp = null, vcTex = null, vcLanes = null, vcHalf = NaN;

function vertexStatic(row, lane, slot) {
  const z = Z_MIN + row * Z_STEP;
  const u = vcLanes[lane];
  const x = riverX(z) + u;
  const level = waterLevel(z);
  const rough = riverRoughAt(u, z);
  const depth = Math.max(0, level - riverBedAt(x, z));
  const t = Math.min(1, depth / SWELL.fadeDepth);
  const o = slot * 5;
  vcData[o] = x;
  vcData[o + 1] = level;
  vcData[o + 2] = (SWELL.base + SWELL.rough * rough) * t * t * (3 - 2 * t);
  vcData[o + 3] = SWELL.kz + rough * SWELL.kzRough;
  vcData[o + 4] = SWELL.wz + rough * SWELL.wzRough;
}

function vertexY(row, lane, t) {
  const key = row * 4096 + lane;
  const slot = ((row * 31 + lane * 7) >>> 0) % VC;
  if (vcKey[slot] !== key) { vcKey[slot] = key; vertexStatic(row, lane, slot); }
  const o = slot * 5;
  const z = Z_MIN + row * Z_STEP;
  return vcData[o + 1] + vcData[o + 2] * Math.sin(vcData[o] * SWELL.kx + t * SWELL.wx) * Math.sin(z * vcData[o + 3] + t * vcData[o + 4]);
}

/**
 * Height of the rendered water surface at (x, z) at water time t (the
 * grade's uTime): what a hull's waterline must meet. Exact for the ribbon
 * built by buildRiverRibbon() with its default rows.
 */
export function waterSurfaceAt(x, z, t) {
  const tex = RIVER.tRiver.value, seed = terrainKey();
  if (tex !== vcTex || seed !== vcStamp || WATER_HALF !== vcHalf) {
    vcTex = tex; vcStamp = seed; vcHalf = WATER_HALF;
    vcLanes = laneOffsets();
    vcKey.fill(NaN);
  }
  const fr = Math.min(Math.max((z - Z_MIN) / Z_STEP, 0), (Z_MAX - Z_MIN) / Z_STEP - 1e-6);
  const r0 = Math.floor(fr), s = fr - r0;
  const cx0 = riverX(Z_MIN + r0 * Z_STEP), cx1 = riverX(Z_MIN + (r0 + 1) * Z_STEP);
  const u = x - (cx0 + (cx1 - cx0) * s);
  // Lane pair around u (the rows' lanes are the same offsets; the quad is a
  // parallelogram, so (s, f) is affine on both of its triangles).
  const L = vcLanes;
  let l = 0;
  if (u >= L[L.length - 1]) l = L.length - 2;
  else if (u > L[0]) {
    let hi = L.length - 1;
    while (hi - l > 1) { const m = (l + hi) >> 1; if (L[m] <= u) l = m; else hi = m; }
  }
  const f =Math.min(1, Math.max(0, (u - L[l]) / (L[l + 1] - L[l])));
  // Ribbon index order: triangles (A, B, C) and (A, C, D) with A = (row 0,
  // lane l), B = (row 1, lane l), C = (row 1, lane l+1), D = (row 0, lane l+1).
  const A = vertexY(r0, l, t), C = vertexY(r0 + 1, l + 1, t);
  if (s >= f) { const B = vertexY(r0 + 1, l, t); return A + s * (B - A) + f * (C - B); }
  const D = vertexY(r0, l + 1, t);
  return A + f * (D - A) + s * (C - D);
}

/**
 * 64x64 tileable normal tile. RG = slope of a sum of integer-frequency waves
 * (tileable by construction), B = an independent scalar noise for foam.
 */
export function buildNormalTile(size = 64) {
  let seed = 1337;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const waves = [];
  for (let i = 0; i < 26; i++) {
    let kx = 0, ky = 0;
    while (kx === 0 && ky === 0) {
      kx = Math.round((rand() - 0.5) * 2 * (1 + i * 0.35));
      ky = Math.round((rand() - 0.5) * 2 * (1 + i * 0.35));
    }
    const k = Math.hypot(kx, ky);
    waves.push({ kx, ky, amp: 1 / Math.pow(k, 1.35), phase: rand() * Math.PI * 2 });
  }
  const foamWaves = waves.map((w) => ({ ...w, phase: w.phase * 1.7 + 2.1 }));
  const data = new Uint8Array(size * size * 4);
  const tau = (Math.PI * 2) / size;
  let maxSlope = 0;
  const slopes = new Float32Array(size * size * 2);
  const foam = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sx = 0, sy = 0, f = 0;
      for (const w of waves) {
        const a = tau * (w.kx * x + w.ky * y) + w.phase;
        const c = Math.cos(a) * w.amp;
        sx += c * w.kx; sy += c * w.ky;
      }
      for (const w of foamWaves) f += Math.sin(tau * (w.kx * x + w.ky * y) + w.phase) * w.amp;
      const i = y * size + x;
      slopes[i * 2] = sx; slopes[i * 2 + 1] = sy; foam[i] = f;
      maxSlope = Math.max(maxSlope, Math.abs(sx), Math.abs(sy));
    }
  }
  let fMin = Infinity, fMax = -Infinity;
  for (const f of foam) { fMin = Math.min(fMin, f); fMax = Math.max(fMax, f); }
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = (slopes[i * 2] / maxSlope * 0.5 + 0.5) * 255;
    data[i * 4 + 1] = (slopes[i * 2 + 1] / maxSlope * 0.5 + 0.5) * 255;
    data[i * 4 + 2] = ((foam[i] - fMin) / (fMax - fMin)) * 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
uniform float uTime;
uniform mat4 uReflectMatrix;
attribute float aDepth;
attribute float aDepth0;
attribute vec2 aReach;
varying vec2 vReach;
attribute vec2 aFlow;
attribute float aBank;
attribute float aStill;
varying float vStill;
varying vec3 vWorld;
varying float vDepth;
varying float vDepth0;
varying float vBank;
varying vec2 vUv;
varying vec2 vFlow;
varying vec4 vReflectUv;
${RIVERMAP_GLSL}
void main() {
  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  #include <defaultnormal_vertex>
  vec3 transformed = position;
  // Two low-frequency swells, tiny, only to move the silhouette mid-river;
  // white water stands up in short choppy waves. Mirrored on the CPU by
  // waterSurfaceAt() (SWELL), which the boats ride: change both together.
  #ifdef STILL
    // Still water: a slow, long swell, heaving most on the open sea (aFlow.x
    // is the body's exposure). Mirrored on the CPU by stillSurfaceAt().
    transformed.y += ${g(STILL_SWELL.amp)} * aFlow.x * smoothstep(0.0, ${g(STILL_SWELL.fadeDepth)}, aDepth)
      * ((1.0 - ${g(STILL_SWELL.mix)}) * sin(position.x * ${g(STILL_SWELL.ax)} + position.z * ${g(STILL_SWELL.az)} + uTime * ${g(STILL_SWELL.wa)})
        + ${g(STILL_SWELL.mix)} * sin(position.x * ${g(STILL_SWELL.bx)} + position.z * ${g(STILL_SWELL.bz)} + uTime * ${g(STILL_SWELL.wb)}));
  #else
  float roughV = riverMap(uv).g;
  transformed.y += (${g(SWELL.base)} + ${g(SWELL.rough)} * roughV) * sin(position.x * ${g(SWELL.kx)} + uTime * ${g(SWELL.wx)})
    * sin(position.z * (${g(SWELL.kz)} + roughV * ${g(SWELL.kzRough)}) + uTime * (${g(SWELL.wz)} + roughV * ${g(SWELL.wzRough)}))
    * smoothstep(0.0, ${g(SWELL.fadeDepth)}, aDepth);
  #endif
  vStill = aStill;
  #include <project_vertex>
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  vWorld = worldPosition.xyz;
  vDepth = aDepth;
  vDepth0 = aDepth0;
  vReach = aReach;
  vBank = aBank;
  vUv = uv;
  vFlow = aFlow;
  vReflectUv = uReflectMatrix * worldPosition;
  #include <shadowmap_vertex>
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
uniform sampler2D tNormals;
uniform sampler2D tReflect;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uFogTint;
uniform float uSnow;
uniform float uNight;
uniform float uWet;
uniform float uReflectMix;
uniform vec3 uBankColor;
${EMBANK_GLSL}
${RIVERMAP_GLSL}
varying vec3 vWorld;
varying float vDepth;
varying float vDepth0;
varying float vBank;
varying vec2 vUv;
varying vec2 vFlow;
varying vec4 vReflectUv;
varying vec2 vReach;
varying float vStill;

// Tile stores slopes (dh/dx, dh/dz) in RG; build a normal from them.
vec2 slope(vec2 uv) { return texture2D(tNormals, uv).rg * 2.0 - 1.0; }

void main() {
  // Flow-aligned coordinates: x across (metres), y along the river (metres).
  vec2 base = vec2(vUv.x, vUv.y);
  // River character at this spot: boulder foam, white water, speed, pool.
  #if defined(STILL) || defined(CALM)
    // Still water and delta creeks have no river character of their own:
    // calm, glassy, nothing embanked.
    vec4 rm = vec4(0.0, 0.0, 0.0, 0.5);
    float emb = 0.0;
  #else
    vec4 rm = riverMap(base);
    float emb = embanked(base);
  #endif
  // A quay wall replaces the gravel bar: use the natural bed's depth there.
  float depth = mix(vDepth, vDepth0, emb);
  float speed = rm.b * 2.5;
  float pool = rm.a * (1.0 - emb * 0.5);
  float white = rm.g;
  #if WATER_TIER > 0
    // Two-phase flow: two copies of the ripples slide downstream at the local
    // speed and cross-fade, so quick and slow reaches never shear apart.
    float ph = uTime * 0.3;
    float p0 = fract(ph), p1 = fract(ph + 0.5);
    float w0 = 1.0 - abs(2.0 * p0 - 1.0);
    float travel = speed * 0.05 / 0.3;
    vec2 s = mix(slope(base * 0.085 + vec2(0.0, p1 * travel) + 0.5), slope(base * 0.085 + vec2(0.0, p0 * travel)), w0);
    // Second octave scrolls slower and sideways so the pattern never repeats visibly.
    s += 0.7 * slope(base * vec2(0.19, 0.16) + vec2(uTime * 0.011, uTime * 0.026) + 0.37);
  #else
    vec2 s = slope(base * 0.085 + vec2(0.0, uTime * 0.05));
  #endif
  #ifdef STILL
    // Open water spans hundreds of metres, where the river's two aligned
    // octaves of one 12 m tile repeat in a visible grid. Read the tile
    // through a slow warp, turn the octaves apart and add a broad third one.
    vec2 warp = vec2(texture2D(tNormals, base * 0.0061 + 0.21).b, texture2D(tNormals, base * 0.0057 + 0.63).b) - 0.5;
    vec2 bw = base + warp * 14.0;
    s = slope(bw * 0.085 + vec2(uTime * 0.004, uTime * 0.009));
    s += 0.6 * slope(mat2(0.8, -0.6, 0.6, 0.8) * bw * 0.173 + vec2(uTime * 0.011, uTime * 0.026) + 0.37);
    s += 0.55 * slope(mat2(0.34, 0.94, -0.94, 0.34) * bw * 0.037 - vec2(uTime * 0.006, uTime * 0.003) + 0.11);
    s *= 0.8;
  #endif
  // Fords: shallow water mid-channel (not the bank shallows) runs as riffles;
  // steep reaches coming down from the hills run as rapids.
  float riffle = (1.0 - smoothstep(0.28, 0.46, depth)) * smoothstep(0.8, 2.0, vBank) * (1.0 - smoothstep(0.5, 0.9, vDepth0 - depth));
  riffle = max(riffle, smoothstep(0.02, 0.12, vReach.x) * smoothstep(0.3, 1.5, vBank));
  #ifdef CALM
    riffle *= 0.2;
  #endif
  #ifdef STILL
    riffle = 0.0;
    // Wind chop on open water: the sea is never glassy.
    white = 0.0;
  #endif
  #if !defined(STILL)
    // Into the open water the current dies away: no riffles or white water.
    riffle *= 1.0 - vStill;
    white *= 1.0 - vStill;
  #endif
  float rough = max(riffle, white);
  // Strength: pools lie glassy, riffles and white water break up.
  float calm = smoothstep(0.0, 0.35, depth) * (1.0 + 1.6 * rough) * (1.0 - 0.55 * pool) + rough * 0.5;
  #ifdef STILL
    // Wind on open water comes in broad patches (cat's paws and calm slicks),
    // which also hides the ripple tile's repeat.
    float gust = texture2D(tNormals, base * 0.0037 + vec2(uTime * 0.0021, uTime * 0.0013)).b;
    calm *= (1.0 + 1.2 * vFlow.x) * (0.45 + 1.1 * smoothstep(0.2, 0.8, gust));
  #endif
  vec3 n = normalize(vec3(-s.x * 0.22 * calm, 1.0, -s.y * 0.22 * calm));
  // Rain: rings spreading from the drops (two offset lattices of drop
  // sites, each on its own clock), brightening the surface where they run.
  float rainRing = 0.0;
  #if WATER_TIER > 0
    if (uWet > 0.05) {
      for (int k = 0; k < 2; k++) {
        vec2 rp = vWorld.xz * 1.3 + float(k) * vec2(0.5, 0.37);
        vec2 c = floor(rp);
        vec2 f = rp - c;
        vec3 h = fract(sin(vec3(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)), dot(c, vec2(419.2, 371.9))) + float(k) * 3.7) * 43758.5453);
        float t = fract(uTime * 0.85 + h.x);
        float d = length(f - (0.25 + 0.5 * h.yz));
        rainRing += smoothstep(0.05, 0.0, abs(d - t * 0.42)) * (1.0 - t) * step(0.35, h.y + h.z * 0.5);
      }
      rainRing *= smoothstep(0.1, 0.6, uWet);
    }
  #endif

  vec3 V = normalize(cameraPosition - vWorld);
  // Reflection uses a calmer normal than the glitter: ripples should break
  // up the sun, not turn the whole surface into patches of sky.
  vec3 nr = normalize(mix(vec3(0.0, 1.0, 0.0), n, 0.4));
  float NoV = max(dot(nr, V), 0.0);
  // Schlick Fresnel for water (F0 = 0.02).
  float fresnel = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

  // Sky reflection: analytic gradient by the reflected ray's elevation.
  vec3 R = reflect(-V, nr);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.6, R.y));
  vec3 reflCol = sky;
  // Grassy banks mirror in the water near the edges (cheap stand-in for
  // geometry reflection on low and medium tiers).
  float bankRefl = 1.0 - smoothstep(0.0, 2.6, vBank);
  reflCol = mix(reflCol, uBankColor, bankRefl * 0.55);
  #ifdef PLANAR
    // Projective lookup into the mirrored render, nudged by the ripple normal.
    vec4 ruv = vReflectUv;
    ruv.xy += n.xz * 0.6 * ruv.w * 0.06;
    vec3 planar = texture2DProj(tReflect, ruv).rgb;
    reflCol = mix(reflCol, planar, uReflectMix * vReach.y);
  #endif

  // Body colour: sandy shallows to deep teal, by analytic depth; pools read
  // deeper, white water paler and greener with air.
  vec3 shallow = vec3(0.15, 0.22, 0.15);
  vec3 deep = vec3(0.018, 0.075, 0.08);
  #ifdef STILL
    // Open water reads bluer and deeper the more exposed it is.
    deep = mix(deep, vec3(0.012, 0.05, 0.085), vFlow.x);
  #else
    // A river mouth takes on the open water's colour as it fades into it.
    deep = mix(deep, vec3(0.012, 0.05, 0.085), vStill * 0.8);
  #endif
  vec3 body = mix(shallow, deep, smoothstep(0.05, 0.75, max(depth, riffle * 0.5) + pool * 0.2));
  body = mix(body, body * vec3(0.8, 0.88, 0.95), pool * 0.5);
  body = mix(body, vec3(0.16, 0.26, 0.24), white * 0.45);
  float shadow = 1.0;
  #if WATER_TIER > 0
    shadow = getShadowMask();
  #endif
  // The water's own colours (body, foam, white water, ice) take the same
  // light as the land: Lambert irradiance on a level surface from the scene's
  // hemisphere and sun, so they darken at night and in shade exactly as the
  // banks do (noon in sun this is ~1, as before).
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 irradiance = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
    irradiance += getHemisphereLightIrradiance(hemisphereLights[0], upV);
  #endif
  #if NUM_DIR_LIGHTS > 0
    irradiance += max(dot(upV, directionalLights[0].direction), 0.0) * directionalLights[0].color * shadow;
  #endif
  vec3 lit = irradiance * RECIPROCAL_PI;
  body *= lit;

  // Sun glitter: Blinn-Phong with a sharp and a broad lobe.
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(n, H), 0.0);
  // The sharp lobe is masked by ripple crests so it breaks into sparkles.
  float crest = smoothstep(0.55, 0.95, length(s) * 0.6);
  float spec = pow(NoH, 420.0) * 1.6 * crest + pow(NoH, 60.0) * 0.05;
  // At night the 'sun' is moonlight: a faint glint, not a daytime sparkle.
  spec *= shadow * (1.0 + uWet * 0.6) * smoothstep(0.0, 0.1, uSunDir.y) * (1.0 - 0.8 * uNight);

  // Pools hold a clearer mirror of the sky and banks.
  vec3 col = mix(body, reflCol, clamp(fresnel + 0.05 + pool * 0.12, 0.0, 1.0));
  col += uSunColor * spec;

  col += mix(uSkyHorizon, vec3(1.0), 0.35) * rainRing * 0.18 * (1.0 - 0.6 * uNight);
  float alpha = mix(0.0, 0.94, smoothstep(0.0, 0.42, depth));
  // A ford is shallow but still a river: keep it mostly opaque and green so
  // the pale bed never reads as a translucent slab.
  alpha = max(alpha, riffle * 0.86 * smoothstep(0.0, 0.08, depth));
  col = mix(col, col * vec3(0.9, 1.04, 1.0), riffle * 0.5);
  #if WATER_TIER > 0
    // Shoreline foam: a broken band near the waterline, drifting with the flow.
    float band = 1.0 - smoothstep(0.0, 0.12, abs(depth - 0.09));
    #ifdef STILL
      // Lapping: the foam line creeps up and down the shore with the swell,
      // and on the sea, rollers break into surf over the shallows.
      float lap = 0.05 * sin(uTime * 1.1 - vBank * 0.7) * (0.4 + vFlow.x);
      band = 1.0 - smoothstep(0.0, 0.12 + 0.1 * vFlow.x, abs(depth - 0.09 - lap));
      float roller = smoothstep(0.55, 0.92, sin(vBank * 0.75 - uTime * 1.3)) * (1.0 - smoothstep(0.15, 0.7, depth));
      band = max(band, roller * vFlow.x * 0.85);
    #endif
    float fn = texture2D(tNormals, base * 0.06 + vec2(0.0, uTime * 0.07)).b;
    float fn2 = texture2D(tNormals, base * 0.11 - vec2(uTime * 0.01, uTime * 0.04)).b;
    float foam = band * smoothstep(0.5, 0.78, fn * 0.6 + fn2 * 0.4) * (1.0 - uSnow * 0.7);
    #ifdef STILL
      // On open shores the wash is a soft, nearly continuous line.
      foam = band * mix(smoothstep(0.45, 0.78, fn * 0.6 + fn2 * 0.4), 0.55 + 0.25 * fn2, 0.6 * vFlow.x) * (1.0 - uSnow * 0.7);
    #endif
    // Against a dressed stone wall the water barely froths.
    foam *= 1.0 - 0.85 * emb;
    // White water: streaks stretched along the flow (fine across, long
    // along), broken by a slower octave; the rougher the water, the more of
    // the surface they cover.
    float rn = texture2D(tNormals, base * vec2(0.55, 0.07) + vec2(0.0, uTime * (0.3 + 0.25 * white))).b;
    float rn2 = texture2D(tNormals, base * vec2(0.19, 0.11) - vec2(0.13, uTime * 0.08)).b;
    float streaks = rn * 0.65 + rn2 * 0.35;
    // Fords and gentle riffles only glint; cascades boil white.
    float rapids = riffle * smoothstep(0.7, 0.9, streaks) * 0.22;
    rapids = max(rapids, smoothstep(0.78 - 0.4 * white, 0.92 - 0.3 * white, streaks) * smoothstep(0.15, 0.6, white) * 0.9);
    // Boulders: a frothing collar and a wake broken into flecks.
    float fleck = texture2D(tNormals, base * vec2(0.9, 0.35) + vec2(0.0, uTime * 0.45)).b;
    float stones = rm.r * smoothstep(0.25, 0.65, fleck * 0.7 + rm.r * 0.5);
    foam = max(foam, max(rapids, stones) * (1.0 - uSnow * 0.6));
    // Foam stays a soft, broken trim rather than a painted white line.
    col = mix(col, vec3(0.82, 0.87, 0.84) * lit, foam * 0.75);
    alpha = max(alpha, foam * 0.85);
  #else
    // Low tier: white water as a flat pale tint.
    col = mix(col, vec3(0.7, 0.77, 0.74) * lit, max(white * 0.35, rm.r * 0.5));
  #endif
  // Winter: a pale ice rim along the banks and over the pools.
  float ice = uSnow * max(1.0 - smoothstep(0.03, 0.22, depth), pool * 0.35 * (1.0 - white));
  col = mix(col, vec3(0.80, 0.86, 0.88) * lit, ice * 0.8);
  alpha = max(alpha, ice * 0.9);

  // A river entering a lake or the sea fades into the still surface.
  // Its sides go first, so it ends as a soft tongue rather than a band.
  alpha *= 1.0 - smoothstep(0.15, 1.0, vStill);
  alpha *= mix(1.0, smoothstep(0.0, 3.5, vBank), min(1.0, vStill * 4.0));
  gl_FragColor = vec4(col, alpha);
  // The shared atmosphere is applied by the tone mapping chunk (atmosphere.js).
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Boulders: one instanced mesh of lumpy, flat-shaded stones in the seed's
// rock colour, dark and glossy where wet, mossy on top in the valley.
function boulderGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = Math.round(x * 50) * 7 + Math.round(y * 50) * 13 + Math.round(z * 50) * 29;
    const j = 0.82 + hashId(k, 91) * 0.32;
    // Water-worn: squat, with a flatter base.
    p.setXYZ(i, x * j * 1.12, (y < 0 ? y * 0.55 : y * 0.8) * j, z * j * 0.95);
  }
  const flat = g.index ? g.toNonIndexed() : g;
  flat.computeVertexNormals();
  return flat;
}

function createBoulders(grade, scene) {
  const rocks = riverRocks();
  const geometry = boulderGeometry();
  geometry.setAttribute('aWetY', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, rocks.length)), 1));
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const seed = terrainSeed();
  const honey = seed != null && hashId(Number(seed) | 0, 77) < 0.45;
  patchMaterial(material, grade, {
    key: 'boulders',
    uniforms: { uRock: { value: new THREE.Color(honey ? '#a8956f' : '#85857c') } },
    vertexHead: 'attribute float aWetY;\nvarying float vWetY;\nvarying vec3 vRockW;\nvarying float vRockUp;\n',
    vertexEnd: `
      vWetY = aWetY;
      vRockW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      vRockUp = normalize(mat3(instanceMatrix) * objectNormal).y;
    `,
    fragmentHead: 'uniform vec3 uRock;\nvarying float vWetY;\nvarying vec3 vRockW;\nvarying float vRockUp;\n' + NOISE,
    fragmentColor: `
      float n = vnoise(vRockW.xz * 2.3 + vRockW.y * 1.7);
      vec3 col = uRock * (0.82 + 0.3 * n);
      // Wet below the splash line: darker and cooler.
      float wet = 1.0 - smoothstep(vWetY + 0.02, vWetY + 0.22, vRockW.y);
      col = mix(col, col * vec3(0.42, 0.46, 0.48), wet);
      // Moss and lichen on dry, up-facing stone.
      float moss = smoothstep(0.35, 0.8, vRockUp) * smoothstep(0.45, 0.75, n) * (1.0 - wet);
      col = mix(col, vec3(0.20, 0.27, 0.10), moss * 0.55);
      float snowR = smoothstep(0.25, 0.8, uSnow) * smoothstep(0.3, 0.7, vRockUp) * (1.0 - wet);
      col = mix(col, vec3(0.88, 0.9, 0.93), snowR);
      diffuseColor.rgb = col * uTint;
    `,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, rocks.length));
  mesh.name = 'river:boulders';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const wet = geometry.attributes.aWetY.array;
  rocks.forEach((r, i) => {
    pos.set(r.x, r.y, r.z);
    q.setFromAxisAngle(up, r.seed * Math.PI * 2);
    scl.set(r.r * (0.9 + r.seed * 0.3), r.r, r.r * (1.15 - r.seed * 0.3));
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    wet[i] = r.wet;
  });
  mesh.count = rocks.length;
  mesh.visible = rocks.length > 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Small and mostly wet: left out of the river mirror to save a draw call.
  mesh.computeBoundingSphere();
  scene.add(mesh);
  return mesh;
}

export function createWater({ renderer, scene, grade, quality }) {
  const geometry = buildRiverRibbon();
  const normals = buildNormalTile();
  buildRiverMap();
  const boulders = createBoulders(grade, scene);
  const reflectMatrix = new THREE.Matrix4();
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]);
  Object.assign(uniforms, grade.uniforms, {
    tNormals: { value: normals },
    tReflect: { value: null },
    uReflectMatrix: { value: reflectMatrix },
    uReflectMix: { value: 0.72 },
    uBankColor: { value: new THREE.Color('#4f6a3a') },
  }, RIVER);
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    lights: true,
    fog: true,
    defines: { WATER_TIER: 1 },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'river';
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false; // one long ribbon; bounding sphere would cull nothing anyway
  scene.add(mesh);

  // Delta creeks share the river's material; lakes, ponds and the sea get its
  // STILL variant (same uniforms, so light, time and reflection follow).
  const extra = [];
  const creekMaterial = material.clone();
  creekMaterial.uniforms = uniforms;
  creekMaterial.defines = { ...material.defines, CALM: 1 };
  const creekGeometry = buildCreekRibbons();
  if (creekGeometry) {
    const creeks = new THREE.Mesh(creekGeometry, creekMaterial);
    creeks.name = 'river:creeks';
    creeks.renderOrder = 2;
    creeks.receiveShadow = true;
    scene.add(creeks);
    extra.push(creeks);
  }
  const stillGeometry = buildStillWater();
  const stillMaterial = material.clone();
  stillMaterial.uniforms = uniforms;
  stillMaterial.defines = { ...material.defines, STILL: 1 };
  if (stillGeometry) {
    const still = new THREE.Mesh(stillGeometry, stillMaterial);
    still.name = 'water:still';
    still.renderOrder = 2;
    still.receiveShadow = true;
    still.frustumCulled = false; // spans the map to the horizon
    scene.add(still);
    extra.push(still);
  }
  const materials = [material, stillMaterial, creekMaterial];

  const reflection = createPlanarReflection(renderer);
  let tier = null;
  let frame = 0;
  const bankLinear = new THREE.Color();
  const bankBase = new THREE.Color('#5c7a40');

  function applyQuality(q) {
    if (tier === q.water) return;
    tier = q.water;
    for (const m of materials) {
      m.defines.WATER_TIER = tier === 'low' ? 0 : 1;
      if (tier === 'high') m.defines.PLANAR = 1;
      else delete m.defines.PLANAR;
      m.needsUpdate = true;
    }
    if (tier === 'high') uniforms.tReflect.value = reflection.texture();
    else reflection.dispose();
    mesh.receiveShadow = tier !== 'low';
    for (const e of extra) e.receiveShadow = tier !== 'low';
  }
  applyQuality(quality);

  /** Called before the main render. Renders the mirror every 2nd frame. */
  function beforeRender(camera) {
    // Bank reflection colour follows the light so it never glows at night.
    bankLinear.copy(bankBase).multiply(grade.uniforms.uSunColor.value).multiplyScalar(0.25 + 0.75 * (1 - grade.uniforms.uNight.value));
    uniforms.uBankColor.value.copy(bankLinear);
    if (tier !== 'high') return;
    frame++;
    if (frame % 2 === 0 && reflection.ready()) return;
    reflection.render(scene, camera, reflectMatrix);
    uniforms.tReflect.value = reflection.texture();
  }

  /** Embanked runs from the view: [{side, z0, z1}] (refreshed when the list changes). */
  let embankRef = null;
  let embankLen = -1;
  function setEmbankments(list) {
    if (list === embankRef && (list?.length ?? 0) === embankLen) return;
    embankRef = list;
    embankLen = list?.length ?? 0;
    // Shared with the terrain strip, which drops gravel bars at a quay wall.
    setEmbankRuns(list);
  }

  return {
    mesh, material, boulders, applyQuality, beforeRender, setEmbankments, extra,
    dispose() {
      reflection.dispose();
      for (const e of extra) { scene.remove(e); e.geometry.dispose(); }
      stillMaterial.dispose();
      creekMaterial.dispose();
      scene.remove(boulders);
      boulders.geometry.dispose();
      boulders.material.dispose();
    },
  };
}

/** Mirror camera about y = WATER_Y with an oblique near plane (Lengyel). */
function createPlanarReflection(renderer) {
  let target = null;
  const virtual = new THREE.PerspectiveCamera();
  virtual.layers.set(LAYER_REFLECT);
  const normal = new THREE.Vector3(0, 1, 0);
  const planePoint = new THREE.Vector3(0, WATER_Y, 0);
  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const view = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const rot = new THREE.Matrix4();
  const plane = new THREE.Plane();
  const clip = new THREE.Vector4();
  const q = new THREE.Vector4();
  const size = new THREE.Vector2();

  function ensureTarget() {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(256, Math.round(size.x * 0.33));
    const h = Math.max(160, Math.round(size.y * 0.33));
    if (!target) {
      target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 });
      target.texture.generateMipmaps = false;
    } else if (target.width !== w || target.height !== h) {
      target.setSize(w, h);
    }
  }

  function render(scene, camera, textureMatrix) {
    ensureTarget();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    view.subVectors(planePoint, camPos);
    if (view.dot(normal) > 0) return; // camera under water
    view.reflect(normal).negate().add(planePoint);
    rot.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    tgt.subVectors(planePoint, lookAt).reflect(normal).negate().add(planePoint);
    virtual.position.copy(view);
    virtual.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    virtual.lookAt(tgt);
    virtual.far = camera.far;
    virtual.updateMatrixWorld();
    virtual.projectionMatrix.copy(camera.projectionMatrix);

    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(virtual.projectionMatrix).multiply(virtual.matrixWorldInverse);

    // Replace the near plane with the water plane so nothing below it draws.
    plane.setFromNormalAndCoplanarPoint(normal, planePoint).applyMatrix4(virtual.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = virtual.projectionMatrix.elements;
    q.x = (Math.sign(clip.x) + e[8]) / e[0];
    q.y = (Math.sign(clip.y) + e[9]) / e[5];
    q.z = -1;
    q.w = (1 + e[10]) / e[14];
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - 0.003; e[14] = clip.w;
    virtual.projectionMatrixInverse.copy(virtual.projectionMatrix).invert();

    const prev = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, virtual);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = prevShadow;
  }

  return {
    render,
    ready: () => !!target,
    texture: () => { ensureTarget(); return target.texture; },
    dispose() { target?.dispose(); target = null; },
  };
}
