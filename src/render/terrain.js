import * as THREE from 'three';
import * as T from '../terrain.js';
import { patchMaterial, NOISE, LAYER_REFLECT, GRADE_HEAD, hashId } from './shaderlib.js';
import { ROAD_GLSL } from './roads.js';
import { GROUND_GLSL, GROUND_ORIGIN, GROUND_LIMIT, shoreCharacter } from './ground.js';
import './atmosphere.js';
import { riverBedAt, riverBarLift } from '../river.js';
import { RIVER, EMBANK_GLSL } from './rivermap.js';
import { GROUND_AO, GROUND_AO_GLSL } from './occlusion.js';

// Terrain in three parts that share one shading function:
//
//  1. Ground chunks over the ground texture (-420..420): a 5x5 grid of
//     160-unit chunks, each a THREE.LOD with 1, 2 and 4 unit grids. Vertices
//     sit on texel centres and read their height and normal from the ground
//     texture in the vertex shader, so building pads show in the land and
//     every draped prop agrees with the mesh. Skirts hide LOD cracks.
//  2. A channel strip along the river (|u| < half-width + 3) in river-relative
//     coordinates with analytic heights, so banks stay crisp; the chunks
//     discard their fragments inside it. Its bed carries the render-only
//     gravel bars of src/river.js (dropped again where a quay wall stands).
//  3. A far ring out to ~950 (hills, the mountain ring) as one flat-shaded,
//     faceted mesh with no shadows.
// Shading: grass on gentle ground, meadow and alpine tones by altitude, rock
// on steep faces, scree on the shoulders below, darker woodland under trees,
// sandy banks, a seasonal snowline, plus the road splat, valley snow, cloud
// shadows and overlays. Distance haze is the shared atmosphere (atmosphere.js).

// 840 m of ground texture in 5 x 5 chunks (divisible by every LOD step).
const CHUNK = 168;
const LOD_STEPS = [1, 2, 4];
const LOD_DIST = [0, 230, 430];
const STRIP_STEP = 1;
const RING_STEP = 8;
const RING_EXTENT = 950;

const lin = (hex) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

// Woodland density from trees.js (darker green under woods). Shared object so
// the trees, built after the terrain, can hand over their texture.
const emptyWood = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
emptyWood.needsUpdate = true;
export const WOODLAND = {
  tWood: { value: emptyWood },
  uWoodRect: { value: new THREE.Vector4(GROUND_ORIGIN, GROUND_ORIGIN, GROUND_LIMIT - GROUND_ORIGIN, GROUND_LIMIT - GROUND_ORIGIN) },
};

/**
 * Kept for callers: the capped haze is now the world's one atmosphere and is
 * installed for every fogged material by atmosphere.js, so there is nothing
 * left to swap per material.
 */
export function useHaze(material) {
  return material;
}

/** Summer snowline from sim-world's terrainInfo (only the highest peaks). */
function summerSnowline() {
  // sim-world's snowline (0.6 x peak height) is the winter-ish line; summer
  // keeps snow on the upper quarter of the peaks only.
  const line = typeof T.terrainInfo === 'function' ? T.terrainInfo().snowline : null;
  return line ? Math.max(40, line * 1.25) : 95;
}

/** Where the river meets a great lake or the sea (-Infinity: it runs off the map). */
function riverEnd() {
  const W = typeof T.terrainWaters === 'function' ? T.terrainWaters() : null;
  if (W?.noRiver) return 1e9;   // no channel strip anywhere
  return W && W.mouth != null ? W.mouth : -1e9;
}

/** Seed palette: grey or honey stone. */
function rockColor() {
  const seed = T.terrainSeed();
  const honey = seed != null && hashId(Number(seed) | 0, 77) < 0.45;
  return new THREE.Color(honey ? '#b8a27a' : '#8f8f86');
}

const SHADE_GLSL = /* glsl */ `
uniform vec3 uRockColor;
uniform float uSnowline;
uniform sampler2D tWood;
uniform vec4 uWoodRect;
uniform float uYearT;
${GROUND_AO_GLSL}
varying vec3 vWorldP;
varying float vUp;
varying float vRiverU;
varying float vShore;
varying float vBeach;
${NOISE}
${ROAD_GLSL}

// Ground albedo from position, up-ness of the normal, the distance to the
// nearest water (e, negative over it) and the shore's character (beach width
// in metres, or minus the marsh strength).
vec3 terrainAlbedo(vec3 p, float up, float e, float beach, out float rock, out float n) {
  // Patchwork of three grass tones.
  float pp = sin(p.x * 0.045 + sin(p.z * 0.031) * 2.0) * 0.5 + 0.5;
  float qq = sin(p.z * 0.052 - p.x * 0.017 + 1.7) * 0.5 + 0.5;
  vec3 g = mix(${lin('#8fb562')}, ${lin('#9bbd6a')}, pp * 0.8);
  g = mix(g, ${lin('#86ab5c')}, qq * 0.6);
  n = vnoise(p.xz * 0.07) * 0.6 + vnoise(p.xz * 0.23) * 0.4;
  // Altitude bands with ragged edges: meadow on the hills, alpine above.
  float alt = p.y + (n - 0.5) * 3.0;
  g = mix(g, ${lin('#b3c76a')}, smoothstep(3.5, 10.0, alt) * 0.45);
  g = mix(g, ${lin('#8e9a6a')}, smoothstep(24.0, 46.0, alt) * 0.8);
  // Woodland floor: darker green where trees cluster.
  float wood = 0.0;
  #ifdef RING
    wood = smoothstep(0.55, 0.72, vnoise(p.xz * 0.018 + 3.0)) * smoothstep(2.0, 8.0, p.y) * (1.0 - smoothstep(30.0, 55.0, p.y));
  #else
    vec2 wuv = (p.xz - uWoodRect.xy) / uWoodRect.zw;
    if (wuv.x > 0.0 && wuv.y > 0.0 && wuv.x < 1.0 && wuv.y < 1.0) wood = texture2D(tWood, wuv).r;
  #endif
  g = mix(g, ${lin('#5d7f45')}, smoothstep(0.1, 0.55, wood) * 0.6);
  // Slope: 1 - up. Rock on steep faces (~40 deg+), scree on the shoulders
  // below them, both with noisy edges so bands look hand-painted.
  float slope = 1.0 - up;
  rock = smoothstep(0.22, 0.32, slope + (n - 0.5) * 0.1);
  float scree = smoothstep(0.1, 0.2, slope + (n - 0.5) * 0.08) * (1.0 - rock) * smoothstep(4.0, 14.0, alt);
  // Strata: faint horizontal layers, like stacked card on a model.
  float strata = 0.9 + 0.12 * step(0.5, fract(p.y * 0.18 + n * 0.4));
  vec3 c = mix(g, ${lin('#a69d8c')} * (0.9 + 0.2 * n), scree * 0.75);
  c = mix(c, uRockColor * strata * (0.85 + 0.25 * n), rock);
  // Beaches: pale sand above the sea's waterline, grey-gold shingle on lake
  // shores, a ragged edge where the grass takes over.
  float bw = max(beach, 0.0);
  if (bw > 0.0 && e < bw + 3.0) {
    float edge = bw * (0.75 + 0.5 * n);
    vec3 sand = mix(${lin('#cdb98a')}, ${lin('#e2d3a4')}, smoothstep(2.0, bw, e) * (0.6 + 0.4 * n));
    vec3 shingle = mix(uRockColor * 1.05, ${lin('#b9ad8c')}, 0.5 + 0.5 * n);
    vec3 shore = mix(shingle, sand, smoothstep(4.0, 10.0, bw));
    // Wet sand: darker and cooler just above the waterline.
    shore = mix(shore * vec3(0.72, 0.74, 0.78), shore, smoothstep(0.0, 1.8, e));
    c = mix(c, shore, (1.0 - smoothstep(edge, edge + 2.5, e)) * (1.0 - rock * 0.7));
  }
  // Delta marsh: reed-green flats and dark mud by the creeks.
  float marsh = max(-beach, 0.0);
  if (marsh > 0.0) {
    vec3 reeds = mix(${lin('#7a8450')}, ${lin('#98975c')}, n);
    vec3 mud = ${lin('#5f5a44')};
    vec3 marshCol = mix(reeds, mud, (1.0 - smoothstep(0.0, 2.5, e)) * 0.8);
    c = mix(c, marshCol, smoothstep(0.0, 0.6, marsh) * 0.85);
  }
  // Banks: damp sand at the waterline, dry sand above, bed below.
  if (e < 3.0) {
    vec3 sand = ${lin('#d5c48f')};
    vec3 bank = mix(${lin('#a39a6c')}, sand, smoothstep(-0.8, 0.4, e));
    bank = mix(${lin('#7d8a6a')}, bank, smoothstep(-1.6, -1.0, e));
    c = mix(c, sand, (1.0 - smoothstep(0.2, 1.6, e)) * 0.75);
    c = mix(c, bank, 1.0 - smoothstep(0.2, 0.6, e));
  }
  return c;
}
`;

const SHADE_FRAGMENT = /* glsl */ `
  #ifdef GRID
    // The channel strip draws the river banks here (down to the river's mouth).
    if (abs(vRiverU) < uWaterHalf + 2.5 && vWorldP.z > uRiverEnd) discard;
  #endif
  float rock, n;
  vec3 ground = terrainAlbedo(vWorldP, vUp, vShore, vBeach, rock, n);
  // Soft mottling and broad drier / lusher meadow patches on grass only.
  float m = vnoise(vWorldP.xz * 0.11) * 0.6 + vnoise(vWorldP.xz * 0.37) * 0.4;
  float meadow = vnoise(vWorldP.xz * 0.023 + 7.0);
  vec3 grassy = ground * (0.9 + 0.16 * m);
  grassy = mix(grassy, grassy * vec3(1.12, 1.02, 0.78), smoothstep(0.55, 0.85, meadow) * 0.7);
  grassy = mix(grassy, grassy * vec3(0.74, 0.86, 0.8), smoothstep(0.45, 0.15, meadow) * 0.6);
  // Water meadows: the low ground a great flood would cover reads lusher
  // and cooler (version-2 valleys, which have a floodplain; terrain.js
  // floodDepthAt: up to about 1.5 m over the water, within its reach).
  if (uFloodplain > 0.5 && vShore > 0.0) {
    float fl = (1.0 - smoothstep(1.1, 1.7, vWorldP.y)) * (1.0 - smoothstep(90.0, 150.0, vShore));
    grassy = mix(grassy, grassy * vec3(0.84, 1.05, 0.92), fl * 0.55);
  }
  // Close up, the sward breaks into tufts and worn patches; faded with
  // distance so it never shimmers.
  float nearK = 1.0 - smoothstep(60.0, 170.0, length(vWorldP - cameraPosition));
  if (nearK > 0.0) {
    float tuft = vnoise(vWorldP.xz * 0.9) * 0.55 + vnoise(vWorldP.xz * 2.7 + 3.0) * 0.3 + vnoise(vWorldP.xz * 7.3) * 0.15;
    grassy *= mix(1.0, 0.9 + 0.2 * tuft, nearK);
    grassy = mix(grassy, grassy * vec3(1.1, 1.04, 0.82), smoothstep(0.62, 0.8, tuft) * 0.35 * nearK);
  }
  ground = mix(grassy, ground, rock);
  #ifdef STRIP
    // Gravel bars: pale water-sorted shingle, darker and cooler where wet.
    float barK = smoothstep(0.02, 0.12, vBankS.x);
    if (barK > 0.0) {
      float pebble = vnoise(vWorldP.xz * 3.1) * 0.6 + vnoise(vWorldP.xz * 9.7) * 0.4;
      float cobble = vnoise(vWorldP.xz * 1.3 + 11.0);
      vec3 gravel = mix(${lin('#8f8672')}, ${lin('#b5ab93')}, pebble);
      // Larger cobbles in the rock colour, darker gaps between stones.
      gravel = mix(gravel, uRockColor * 0.9, smoothstep(0.6, 0.78, pebble) * 0.65);
      gravel *= 0.86 + 0.2 * smoothstep(0.3, 0.7, cobble);
      gravel *= 1.0 - 0.18 * smoothstep(0.3, 0.12, pebble);
      // Wet margin: dark and cool just above the waterline.
      gravel *= mix(0.55, 1.0, smoothstep(-0.03, 0.08, vBankS.y));
      // Grass and willow scrub creep onto the highest, oldest shingle.
      float scrub = smoothstep(0.1, 0.16, vBankS.y) * smoothstep(0.5, 0.7, vnoise(vWorldP.xz * 0.6 + 4.0));
      gravel = mix(gravel, ground, scrub * 0.6);
      ground = mix(ground, gravel, barK);
    }
  #endif
  // Pull saturation down a touch so ACES does not push grass to neon.
  float lum = dot(ground, vec3(0.3, 0.55, 0.15));
  ground = mix(vec3(lum), ground, 0.78);
  vec3 col = ground;
  float roadA = 0.0;
  #ifndef RING
    vec4 road = roadSurface(vWorldP, ground, 1.0);
    col = road.rgb;
    roadA = road.a;
  #endif
  // Wet weather darkens roads more than grass.
  // Wet ground darkens; trodden roads darken most and read as sheened mud.
  col *= 1.0 - uWet * (0.12 + 0.16 * roadA);
  // Valley snow settles on flat ground; trodden roads keep a darker slush.
  float snow = smoothstep(0.25, 0.8, uSnow) * smoothstep(0.55, 0.92, vUp);
  snow *= 1.0 - 0.55 * roadA;
  snow *= smoothstep(-0.2, 0.15, vWorldP.y);
  // Seasonal snowline on the mountains: the seed's summer line, sinking to
  // under half of it in winter.
  float snowline = mix(uSnowline, uSnowline * 0.45, max(uSnow, smoothstep(0.75, 0.92, uYearT) * 0.5));
  float cap = smoothstep(snowline - 5.0, snowline + 5.0, vWorldP.y + (m - 0.5) * 12.0);
  snow = max(snow, cap * smoothstep(0.25, 0.55, vUp) * (1.0 - 0.5 * rock));
  col = mix(col, vec3(0.90, 0.92, 0.94), snow * (0.85 + 0.15 * m));
  #ifdef CLOUD_SHADOW
    float cs = vnoise(vWorldP.xz * 0.011 + vec2(uTime * 0.006, 0.0));
    col *= 1.0 - 0.13 * smoothstep(0.5, 0.78, cs) * (1.0 - uNight);
  #endif
  // Overlay 'roads': mute the land so the network reads.
  if (uOverlay > 1.5 && uOverlay < 2.5) {
    float l = dot(col, vec3(0.3, 0.55, 0.15));
    col = mix(vec3(l) * 0.9, col * vec3(1.15, 0.95, 0.7), roadA);
  }
  // Snow keeps most of its white under warm grades.
  diffuseColor.rgb = col * mix(uTint, vec3(1.0), snow * 0.7);
  #ifndef RING
    // Baked ground occlusion: soft darkening at wall feet and in tight blocks.
    diffuseColor.rgb *= groundOcclusion(vWorldP.xz);
  #endif
`;

const VARYINGS = 'varying vec3 vWorldP;\nvarying float vUp;\nvarying float vRiverU;\nvarying float vShore;\nvarying float vBeach;\n';

// Ground chunks: height and normal from the ground texture.
const GRID_NORMAL = /* glsl */ `
  vec2 gXZ = (modelMatrix * vec4(position, 1.0)).xz;
  objectNormal = groundNormal(gXZ);
`;
const GRID_BEGIN = /* glsl */ `
  transformed.y = groundHeight(gXZ) - aSkirt;
`;
// Channel strip: aBank = (gravel bar lift, height above the water). A quay
// wall (embanked run) takes the bar away.
const STRIP_BEGIN = /* glsl */ `
  float embK = embanked(vec2(aRiverU, position.z));
  transformed.y -= aBank.x * embK;
  vBankS = vec2(aBank.x * (1.0 - embK), aBank.y - aBank.x * embK);
`;

function makeMaterial(grade, roads, variant) {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: variant === 'ring' });
  material.defines = {};
  const defines = variant === 'grid' ? { GRID: 1 } : variant === 'ring' ? { RING: 1 } : { STRIP: 1 };
  const uniforms = {
    ...roads.uniforms, ...WOODLAND, ...GROUND_AO, uRockColor: { value: rockColor() }, uSnowline: { value: summerSnowline() },
    uRiverEnd: { value: riverEnd() },
    uFloodplain: { value: typeof T.terrainVersion === 'function' && T.terrainVersion() >= 2 ? 1 : 0 },
  };
  const grid = variant === 'grid';
  const strip = variant === 'strip';
  if (strip) uniforms.uEmbank = RIVER.uEmbank;
  patchMaterial(material, grade, {
    key: `terrain:${variant}`,
    uniforms,
    defines,
    vertexHead: GROUND_GLSL + VARYINGS + (grid ? 'attribute float aSkirt;\n' : 'attribute float aRiverU;\n')
      + (variant === 'ring' ? 'attribute vec2 aShore;\n' : '')
      + (strip ? 'attribute vec2 aBank;\nvarying vec2 vBankS;\n' + EMBANK_GLSL : ''),
    vertexNormal: grid ? GRID_NORMAL : '',
    vertexBegin: grid ? GRID_BEGIN : strip ? STRIP_BEGIN : '',
    vertexEnd: /* glsl */ `
      vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vUp = normalize(mat3(modelMatrix) * objectNormal).y;
      ${grid ? 'vRiverU = groundRiverU(gXZ);' : 'vRiverU = aRiverU;'}
      ${grid ? 'vShore = groundShore(gXZ); vBeach = groundBeach(gXZ);'
        : variant === 'ring' ? 'vShore = aShore.x; vBeach = aShore.y;'
          : 'vShore = abs(aRiverU) - uWaterHalf; vBeach = 0.0;'}
    `,
    fragmentHead: 'uniform float uWaterHalf;\nuniform float uRiverEnd;\nuniform float uFloodplain;\n' + (strip ? 'varying vec2 vBankS;\n' : '') + SHADE_GLSL,
    fragmentColor: SHADE_FRAGMENT,
  });
  useHaze(material, grade);
  material.userData.variant = variant;
  material.userData.defines = defines;
  return material;
}

/** Shadow depth for ground chunks: same texture-driven heights. */
function makeGridDepth(grade) {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms);
    shader.vertexShader = GRADE_HEAD + GROUND_GLSL + 'attribute float aSkirt;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvec2 gXZ = (modelMatrix * vec4(position, 1.0)).xz;\n' + GRID_BEGIN,
    );
  };
  depth.customProgramCacheKey = () => 'terrain:grid-depth';
  return depth;
}

// ---------------------------------------------------------------------------
// Geometry

/**
 * A CHUNK x CHUNK grid at `step`, centred on the origin, flat (y comes from
 * the texture), with a skirt: the border repeated and dropped by aSkirt.
 */
function buildGridLevel(step) {
  const n = CHUNK / step;
  const side = n + 1;
  const pos = [];
  const skirt = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      pos.push(-CHUNK / 2 + i * step, 0, -CHUNK / 2 + j * step);
      skirt.push(0);
    }
  }
  const index = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  // Border ring, walked once around, duplicated as the dropped skirt.
  const border = [];
  for (let i = 0; i < n; i++) border.push(i);
  for (let j = 0; j < n; j++) border.push(j * side + n);
  for (let i = n; i > 0; i--) border.push(n * side + i);
  for (let j = n; j > 0; j--) border.push(j * side);
  const base = pos.length / 3;
  for (const v of border) {
    pos.push(pos[v * 3], 0, pos[v * 3 + 2]);
    // Deep enough to cover the step-8 far ring and steep mountain edges.
    skirt.push(3 + 2 * step);
  }
  for (let k = 0; k < border.length; k++) {
    const a = border[k], b = border[(k + 1) % border.length];
    const sa = base + k, sb = base + ((k + 1) % border.length);
    // Both windings: the skirt only ever shows through cracks, from any side.
    index.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
  }
  return {
    position: new THREE.Float32BufferAttribute(pos, 3),
    aSkirt: new THREE.Float32BufferAttribute(skirt, 1),
    index: new THREE.Uint32BufferAttribute(index, 1),
  };
}

/** Height range of a chunk (coarse samples) for its culling sphere. */
function chunkSphere(cx, cz) {
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j <= 16; j++) {
    for (let i = 0; i <= 16; i++) {
      const h = T.heightAt(cx - CHUNK / 2 + (i * CHUNK) / 16, cz - CHUNK / 2 + (j * CHUNK) / 16);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
  }
  lo -= 8; hi += 8; // pads and skirts
  const mid = (lo + hi) / 2;
  return new THREE.Sphere(new THREE.Vector3(0, mid, 0), Math.hypot(CHUNK / 2, CHUNK / 2, (hi - lo) / 2));
}

/** River-relative channel strip with analytic heights (crisp banks). */
function buildStrip(z0, z1) {
  const H = T.WATER_HALF;
  const bed = H - 1.6;
  // Half-metre columns across the channel (gravel bars need them), the bank
  // foot exactly, then the banks out to the ground chunks.
  const half = [];
  for (let u = 0; u < H - 0.05; u += 0.5) if (Math.abs(u - bed) > 0.15) half.push(u);
  half.push(bed, H, H + 0.5, H + 1, H + 1.5, H + 2, H + 2.5, H + 3);
  half.sort((a, b) => a - b);
  const cols = [...half.slice(1).reverse().map((u) => -u), ...half];
  const rows = Math.round((z1 - z0) / STRIP_STEP) + 1;
  const ncol = cols.length;
  const pos = new Float32Array(rows * ncol * 3);
  const nor = new Float32Array(rows * ncol * 3);
  const riverU = new Float32Array(rows * ncol);
  const bank = new Float32Array(rows * ncol * 2);
  const e = 0.5;
  for (let r = 0, k = 0; r < rows; r++) {
    const z = z0 + r * STRIP_STEP;
    const rx = T.riverX(z);
    for (let c = 0; c < ncol; c++, k++) {
      const u = cols[c];
      const x = rx + u;
      // The outer edge tucks 4 cm under the ground chunks, so the overlap
      // band never z-fights.
      const tuck = Math.abs(u) >= H + 2.9 ? 0.04 : 0;
      const y = riverBedAt(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = y - tuck; pos[k * 3 + 2] = z;
      bank[k * 2] = riverBarLift(x, z);
      bank[k * 2 + 1] = y - T.waterLevelAt(z);
      const dx = riverBedAt(x + e, z) - riverBedAt(x - e, z);
      const dz = riverBedAt(x, z + e) - riverBedAt(x, z - e);
      const len = Math.hypot(dx, 2 * e, dz);
      nor[k * 3] = -dx / len; nor[k * 3 + 1] = (2 * e) / len; nor[k * 3 + 2] = -dz / len;
      riverU[k] = u;
    }
  }
  const index = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < ncol - 1; c++) {
      const a = r * ncol + c, b = a + 1, d = a + ncol, f = d + 1;
      index.push(a, d, b, b, d, f);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aRiverU', new THREE.BufferAttribute(riverU, 1));
  g.setAttribute('aBank', new THREE.BufferAttribute(bank, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** Far ring: faceted analytic land from the ground texture's edge outward. */
function buildRing() {
  const n = (RING_EXTENT * 2) / RING_STEP;
  // Each grid node once: height, river offset, shore distance and character.
  const N = Math.ceil(n) + 1;
  const node = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -RING_EXTENT + i * RING_STEP, z = -RING_EXTENT + j * RING_STEP;
      // Inside the ground texture only the edge nodes are used.
      const inner = x > GROUND_ORIGIN + RING_STEP && x < GROUND_LIMIT - RING_STEP && z > GROUND_ORIGIN + RING_STEP && z < GROUND_LIMIT - RING_STEP;
      if (inner) continue;
      const k = (j * N + i) * 4;
      const shore = T.bankDistance(x, z);
      node[k] = T.heightAt(x, z);
      node[k + 1] = x - T.riverX(z);
      node[k + 2] = Math.max(-200, Math.min(200, shore));
      node[k + 3] = shoreCharacter(x, z, shore);
    }
  }
  const pos = [];
  const riverU = [];
  const shoreA = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -RING_EXTENT + i * RING_STEP, z0 = -RING_EXTENT + j * RING_STEP;
      const x1 = x0 + RING_STEP, z1 = z0 + RING_STEP;
      // Skip quads covered by the ground chunks.
      if (x0 >= GROUND_ORIGIN && x1 <= GROUND_LIMIT && z0 >= GROUND_ORIGIN && z1 <= GROUND_LIMIT) continue;
      const a = [i, j], b = [i + 1, j], c = [i, j + 1], d = [i + 1, j + 1];
      // Alternate the diagonal for a less regular facet pattern.
      const tris = (i + j) % 2 ? [[a, c, b], [b, c, d]] : [[a, c, d], [a, d, b]];
      for (const tri of tris) {
        for (const [vi, vj] of tri) {
          const k = (vj * N + vi) * 4;
          pos.push(-RING_EXTENT + vi * RING_STEP, node[k], -RING_EXTENT + vj * RING_STEP);
          riverU.push(node[k + 1]);
          shoreA.push(node[k + 2], node[k + 3]);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aRiverU', new THREE.Float32BufferAttribute(riverU, 1));
  g.setAttribute('aShore', new THREE.Float32BufferAttribute(shoreA, 2));
  g.computeVertexNormals(); // non-indexed: one normal per facet
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------

export function createTerrain({ scene, grade, roads, quality }) {
  const group = new THREE.Group();
  group.name = 'terrain';
  const meshes = [];
  const gridMat = makeMaterial(grade, roads, 'grid');
  const stripMat = makeMaterial(grade, roads, 'strip');
  const ringMat = makeMaterial(grade, roads, 'ring');
  const gridDepth = makeGridDepth(grade);
  const materials = [gridMat, stripMat, ringMat];

  // Ground chunks with three LOD levels each; levels share attributes.
  const levels = LOD_STEPS.map(buildGridLevel);
  const chunkMeshes = [];
  const span = GROUND_LIMIT - GROUND_ORIGIN;
  const count = Math.round(span / CHUNK);
  for (let cj = 0; cj < count; cj++) {
    for (let ci = 0; ci < count; ci++) {
      const cx = GROUND_ORIGIN + CHUNK / 2 + ci * CHUNK;
      const cz = GROUND_ORIGIN + CHUNK / 2 + cj * CHUNK;
      const lod = new THREE.LOD();
      lod.position.set(cx, 0, cz);
      const sphere = chunkSphere(cx, cz);
      levels.forEach((lv, k) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', lv.position);
        g.setAttribute('aSkirt', lv.aSkirt);
        g.setIndex(lv.index);
        g.boundingSphere = sphere.clone();
        const mesh = new THREE.Mesh(g, gridMat);
        mesh.customDepthMaterial = gridDepth;
        mesh.receiveShadow = true;
        mesh.layers.enable(LAYER_REFLECT);
        lod.addLevel(mesh, LOD_DIST[k], 0.08);
        meshes.push(mesh);
        chunkMeshes.push(mesh);
      });
      lod.layers.enable(LAYER_REFLECT);
      lod.updateMatrixWorld(true);
      group.add(lod);
    }
  }

  // Channel strip, banded along z for culling.
  // (It stops where the river meets a great lake or the sea; the chunks draw the shore there.)
  const stripFrom = Math.max(GROUND_ORIGIN, Math.floor(riverEnd()));
  for (let z0 = stripFrom; z0 < GROUND_LIMIT; z0 += 128) {
    const mesh = new THREE.Mesh(buildStrip(z0, Math.min(GROUND_LIMIT, z0 + 128)), stripMat);
    mesh.receiveShadow = true;
    mesh.layers.enable(LAYER_REFLECT);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  // Far ring: one draw call, no shadows.
  const ring = new THREE.Mesh(buildRing(), ringMat);
  ring.name = 'terrain:ring';
  ring.layers.enable(LAYER_REFLECT);
  ring.matrixAutoUpdate = false;
  group.add(ring);
  meshes.push(ring);
  scene.add(group);

  function applyQuality(q) {
    const want = q.cloudShadow ? 1 : 0;
    for (const m of materials) {
      const has = m.defines.CLOUD_SHADOW ? 1 : 0;
      if (want === has) continue;
      if (want) m.defines.CLOUD_SHADOW = 1;
      else delete m.defines.CLOUD_SHADOW;
      const key = `terrain:${m.userData.variant}:${want}`;
      m.customProgramCacheKey = () => key;
      m.needsUpdate = true;
    }
    // Hills shadow the valley on medium and high.
    for (const m of chunkMeshes) m.castShadow = q.name !== 'low';
  }
  applyQuality(quality);

  return { group, meshes, material: gridMat, applyQuality };
}

/**
 * Ray-march a height field (default: analytic heightAt; pass ground.sample to
 * include building pads). Returns true and fills `out` on hit.
 */
export function raycastTerrain(ray, out, maxDist = 1500, heightFn = T.heightAt) {
  const o = ray.origin;
  const d = ray.direction;
  let t = 0;
  let step = 2;
  let prevT = 0;
  if (o.y - heightFn(o.x, o.z) < 0) return false;
  while (t < maxDist) {
    t += step;
    const x = o.x + d.x * t;
    const y = o.y + d.y * t;
    const z = o.z + d.z * t;
    const above = y - Math.max(heightFn(x, z), 0.025);
    if (above <= 0) {
      // Bisect between the last two samples for a precise hit.
      let a = prevT;
      let b = t;
      for (let i = 0; i < 12; i++) {
        const m = (a + b) / 2;
        const mx = o.x + d.x * m, mz = o.z + d.z * m;
        if (o.y + d.y * m - Math.max(heightFn(mx, mz), 0.025) > 0) a = m; else b = m;
      }
      out.copy(d).multiplyScalar((a + b) / 2).add(o);
      return true;
    }
    prevT = t;
    step = Math.min(8, Math.max(0.5, above * 0.6));
  }
  return false;
}
