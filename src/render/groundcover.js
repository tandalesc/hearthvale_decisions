import * as THREE from 'three';
import { patchMaterial, NOISE } from './shaderlib.js';
import { GROUND_GLSL, GROUND_ORIGIN, GROUND_LIMIT } from './ground.js';
import { WOODLAND } from './terrain.js';
import { PATH_RANGE } from './paths.js';

// Ground cover: the meadow grass, long grass, reeds, bracken and wildflowers
// that turn the lawn-flat land into countryside close to the eye.
//
// Nothing is placed on the CPU. Each cover mesh is one instanced draw over a
// square grid of world cells around the view; the vertex shader hashes its
// cell into a jittered spot and reads everything else from textures the
// terrain already has: ground height, shore distance and beach character
// (tGround), roads, worn ground and building pads (tRoad, tPath), woodland
// (tWood). Two small textures come from here: what kind of lot a spot lies
// in (farm yards and fields bare, gardens a short lawn) and the sim's
// landscaping level (overgrown verges grow long, kept ones are mown).
// Cells hash by world position, so panning only adds and drops tufts at the
// rim, where they have already shrunk away.
//
// Kinds, by place and season:
//   meadow grass   tufts of blades, taller in drifts, flattened by snow
//   long grass     on neglected land, with tawny seed heads
//   reeds          tall and upright along wild banks and in marshes
//   bracken        wide arching fronds on the woodland floor, rust in autumn
//   dune grass     sparse and pale behind beaches
//   wildflowers    (separate mesh) only in tended gardens and in wildflower
//                  meadows (broad patches of open country), in drifts that
//                  change with the season: buttercups and daisies in spring, poppies and
//                  cornflowers in summer, bluebells under the trees
// Wind bends every blade and sends slow gust bands across the meadows.
//
// Tier: Low draws none; Medium the grass mesh over a smaller square; High
// adds the flowers. Hidden when the camera is far out (sub-pixel there).

// By the tier's groundCover setting (quality.js).
const COVER = {
  none: null,
  grass: { grassN: 120, grassCell: 1.25, flowerN: 0, flowerCell: 2.4 },
  full: { grassN: 210, grassCell: 0.95, flowerN: 124, flowerCell: 1.6 },
};
const HIDE_BEYOND = 260;        // camera distance (m)
const LOT_CELL = 2;             // lot mask resolution (m)
const LOT_N = Math.ceil((GROUND_LIMIT - GROUND_ORIGIN) / LOT_CELL);
const LOT_REBUILD_GAP = 1.0;    // seconds
// Lots whose ground is worked or paved: no cover at all.
const BARE_LOTS = new Set(['farm', 'market', 'square', 'quarry', 'quay', 'bridge', 'factory', 'warehouse', 'mill', 'monument', 'works', 'yard']);

/** A tuft: five blades (one triangle each) fanned round the centre. */
function tuftGeometry() {
  const pos = [], out = [];
  const BLADES = 5;
  for (let i = 0; i < BLADES; i++) {
    const a = (i / BLADES) * Math.PI * 2 + (i % 2) * 0.4;
    const ox = Math.cos(a), oz = Math.sin(a);
    // Blade faces sideways to its lean; base corners either side of its root.
    const tx = -oz * 0.075, tz = ox * 0.075;
    const rx = ox * 0.07, rz = oz * 0.07;
    const k = 0.75 + 0.25 * ((i * 7) % 5) / 4; // blades of a tuft differ in height
    pos.push(rx - tx, 0, rz - tz, rx + tx, 0, rz + tz, rx * 1.4, k, rz * 1.4);
    for (let v = 0; v < 3; v++) out.push(ox, oz, i / BLADES);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aOut', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

/** A flower clump: four stems, each with a small cross-shaped head. */
function flowerGeometry() {
  const pos = [], out = [];
  const STEMS = 4;
  for (let i = 0; i < STEMS; i++) {
    const a = (i / STEMS) * Math.PI * 2 + 0.6;
    const r = 0.12 + 0.08 * (i % 2);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const h = 0.8 + 0.2 * ((i * 3) % 4) / 3;
    const tx = -Math.sin(a) * 0.022, tz = Math.cos(a) * 0.022;
    // Stem (aOut.z < 0.5).
    pos.push(cx * 0.4 - tx, 0, cz * 0.4 - tz, cx * 0.4 + tx, 0, cz * 0.4 + tz, cx, h, cz);
    for (let v = 0; v < 3; v++) out.push(cx, cz, 0);
    // Head: two small triangles crossing, tilted up to face the sky (aOut.z = 1).
    const s = 0.21;
    pos.push(cx - s, h, cz, cx + s, h, cz, cx, h + s * 0.6, cz + s * 0.9);
    pos.push(cx, h, cz - s, cx, h, cz + s, cx + s * 0.9, h + s * 0.6, cz);
    for (let v = 0; v < 6; v++) out.push(cx, cz, 1);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aOut', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

const VERTEX_HEAD = GROUND_GLSL + NOISE + /* glsl */ `
attribute float aIndex;
attribute vec3 aOut;
uniform vec2 uCoverCenter;
uniform float uCoverCell;
uniform float uCoverN;
uniform float uCoverFade;
uniform float uYearT;
uniform sampler2D tRoad;
uniform sampler2D tPath;
uniform vec2 uRoadOrigin;
uniform vec2 uRoadSize;
uniform sampler2D tWood;
uniform vec4 uWoodRect;
uniform sampler2D tLots;
uniform vec4 uLotsRect;
uniform sampler2D tCare;
uniform vec4 uCareRect;
varying vec3 vCoverCol;
vec3 coverWorld;
bool coverDead;
float inRect(vec2 uv) {
  return step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
}
`;

// Placement, kind, size and colour, run before the normal is needed (the
// normal follows the blade's lean).
const VERTEX_PLACE = /* glsl */ `
  vec2 gIdx = vec2(mod(aIndex, uCoverN), floor(aIndex / uCoverN));
  vec2 cell = floor(uCoverCenter / uCoverCell) + gIdx - floor(uCoverN * 0.5);
  float h1 = hash12(cell * 1.31 + 0.7);
  float h2 = hash12(cell * 0.77 + 19.1);
  float h3 = hash12(cell.yx * 1.13 + 5.3);
  float h4 = hash12(cell * 2.03 + 41.7);
  vec2 base = (cell + 0.1 + 0.8 * vec2(h1, h2)) * uCoverCell;
  // Shrink toward the rim of the square, and with the camera's distance.
  vec2 rel = (base - uCoverCenter) / (uCoverN * uCoverCell * 0.5);
  float size = (1.0 - smoothstep(0.62, 0.97, length(rel))) * uCoverFade;

  vec4 gt = groundBilinear(base);
  float gy = gt.r;
  float shore = gt.b;
  float beach = gt.a;
  ivec2 gc = ivec2((base - uGroundOrigin) / uGroundStep);
  float slope = abs(groundTexel(gc + ivec2(1, 0)).r - groundTexel(gc).r) + abs(groundTexel(gc + ivec2(0, 1)).r - groundTexel(gc).r);

  // Roads, paths, trampled and worn ground, building pads.
  float open = 1.0;
  vec2 ruv = (base - uRoadOrigin) / uRoadSize;
  if (inRect(ruv) > 0.5) {
    vec4 rd = texture2D(tRoad, ruv);
    float sd = (texture2D(tPath, ruv).r - 0.5) * ${(2 * PATH_RANGE).toFixed(3)};
    open *= 1.0 - smoothstep(-0.9, -0.3, sd);
    open *= 1.0 - smoothstep(0.05, 0.25, rd.b);
    open *= 1.0 - smoothstep(0.02, 0.2, rd.a);
    open *= 1.0 - smoothstep(0.3, 0.55, rd.r);
  }
  // Lots: worked and paved ground bare, gardens a short lawn.
  vec2 luv = (base - uLotsRect.xy) / uLotsRect.zw;
  float lot = inRect(luv) > 0.5 ? texture2D(tLots, luv).r : 0.0;
  open *= step(lot, 0.75);
  float lawn = step(0.2, lot);
  // The sim's landscaping level (-1 overgrown .. 1 formal).
  vec2 cuv = (base - uCareRect.xy) / uCareRect.zw;
  float care = inRect(cuv) > 0.5 ? texture2D(tCare, cuv).r * 2.0 - 1.0 : 0.0;
  vec2 wuv = (base - uWoodRect.xy) / uWoodRect.zw;
  float wood = inRect(wuv) > 0.5 ? texture2D(tWood, wuv).r : 0.0;

  float drift = vnoise(base * 0.045 + 3.0);
  float patchN = vnoise(base * 0.11 + 9.0);
  // Clumps: grass gathers in lush patches with thinner sward between.
  float clump = smoothstep(0.32, 0.72, vnoise(base * 0.075 + 21.0) * 0.7 + patchN * 0.3);
  // kind: 0 meadow, 1 long grass, 2 reeds, 3 bracken, 4 dune grass
  float kind = 0.0;
  float height = (0.35 + 0.25 * h3) * (0.75 + 0.6 * clump) + 0.3 * smoothstep(0.55, 0.85, drift);
  float width = 0.85 + 0.5 * clump;
  float lean = 0.28;
  float keep = 0.16 + 0.82 * clump;
  float marsh = max(-beach, 0.0);
  float neglect = smoothstep(-0.2, -0.6, care);
  if (shore < 0.25 && marsh < 0.2) keep = 0.0;
  else if (shore < 2.6 && beach < 0.5) {
    // Reeds by the water: patchy on wild banks, gone where the bank is kept.
    kind = 2.0;
    height = 1.45 + 0.8 * h3;
    width = 0.55;
    lean = 0.1;
    keep = (0.35 + 0.6 * smoothstep(0.35, 0.65, patchN) + marsh) * (1.0 - smoothstep(0.1, 0.4, care));
  } else if (beach > 0.5 && shore < beach + 3.0) {
    kind = 4.0;
    height = 0.6 + 0.35 * h3;
    width = 0.7;
    lean = 0.35;
    keep = smoothstep(beach - 2.0, beach + 2.5, shore) * 0.45;
  } else if (wood > 0.22) {
    // Woodland floor: bracken under the trees, thinning out at the edge.
    kind = 3.0;
    height = 0.5 + 0.35 * h3;
    width = 2.4;
    lean = 0.75;
    keep = smoothstep(0.22, 0.45, wood) * (0.4 + 0.5 * patchN);
  } else if (neglect > 0.0 && lawn < 0.5) {
    kind = 1.0;
    height = 0.8 + 0.45 * h3;
    keep = 0.9;
  }
  if (kind < 0.5 || kind > 0.5 && kind < 1.5) {
    // Meadow: kept land is mown short, gardens are lawns.
    float mown = max(lawn, smoothstep(0.15, 0.4, care));
    height *= mix(1.0, 0.45, mown);
    keep *= mix(1.0, 0.55, mown) * (1.0 - 0.75 * smoothstep(0.65, 0.85, care));
    // High ground: thinner, shorter alpine turf.
    keep *= 1.0 - 0.7 * smoothstep(30.0, 46.0, gy);
  }
  keep *= open * (1.0 - smoothstep(0.55, 0.9, slope));
  // Snow presses the grass flat; reeds and bracken stand above it.
  float snowK = smoothstep(0.25, 0.8, uSnow);
  height *= 1.0 - snowK * (kind > 1.5 && kind < 3.5 ? 0.35 : 0.75);
  coverDead = h4 >= keep || size < 0.02;

  // Colour: summer green -> spring fresh, autumn tawny, winter straw.
  float spring = smoothstep(0.03, 0.12, uYearT) * (1.0 - smoothstep(0.24, 0.34, uYearT));
  vec3 green = mix(vec3(0.19, 0.33, 0.075), vec3(0.23, 0.36, 0.085), h1);
  green = mix(green, green * vec3(0.8, 0.88, 0.85), smoothstep(0.4, 0.9, clump) * 0.6);
  green = mix(green, vec3(0.26, 0.42, 0.08), spring * 0.6);
  vec3 tawny = vec3(0.42, 0.33, 0.12);
  vec3 straw = vec3(0.40, 0.35, 0.24);
  vec3 col = green;
  if (kind > 1.5 && kind < 2.5) col = mix(vec3(0.16, 0.22, 0.09), vec3(0.20, 0.24, 0.10), h1);
  if (kind > 2.5 && kind < 3.5) col = mix(vec3(0.07, 0.15, 0.04), vec3(0.10, 0.19, 0.05), h1);
  if (kind > 3.5) col = vec3(0.30, 0.33, 0.20);
  float autumnK = clamp(uAutumn * 1.4 - h2 * 0.4, 0.0, 1.0);
  vec3 turned = kind > 2.5 && kind < 3.5 ? vec3(0.36, 0.13, 0.04) : tawny; // bracken goes rust
  col = mix(col, turned, autumnK * (kind > 0.5 ? 0.9 : 0.45));
  col = mix(col, straw, uBare * (kind > 0.5 ? 0.85 : 0.5));
  // Long grass in summer carries pale seed heads.
  float seedHead = (kind > 0.5 && kind < 1.5 ? 1.0 : 0.0) * smoothstep(0.3, 0.45, uYearT);
  // Damp ground under rain cloud reads darker and richer.
  col *= 1.0 - 0.12 * uWet;

  // The blade: lean out from the centre, scaled, turned, bent by the wind.
  vec3 p = position;
  float tip = step(0.5, p.y);
  p.xz *= width;
  p.xz += aOut.xy * lean * tip * (0.7 + 0.6 * h4);
  p.y *= height;
  p *= size;
  float yaw = h3 * 6.2832;
  float cy = cos(yaw), sy = sin(yaw);
  p.xz = mat2(cy, sy, -sy, cy) * p.xz;
  float windL = length(uWind);
  vec2 windD = uWind / max(windL, 1e-3);
  // Gust bands roll across the meadow along the wind; each tuft also flutters.
  float gust = 0.5 + 0.5 * sin(dot(base, windD) * 0.16 - uDecoTime * (1.1 + 0.6 * windL));
  float flutter = sin(uDecoTime * 2.6 + base.x * 0.7 + base.y * 0.5 + aOut.z * 6.0);
  float stiff = kind > 1.5 && kind < 2.5 ? 0.6 : kind > 2.5 && kind < 3.5 ? 0.35 : 1.0;
  vec2 bend = windD * (0.12 + 0.55 * gust) * (0.4 + windL) + vec2(-windD.y, windD.x) * flutter * 0.08;
  p.xz += bend * stiff * tip * p.y * 0.55;
  p.y -= dot(bend, bend) * tip * p.y * 0.12 * stiff;
  coverWorld = vec3(base.x + p.x, gy - 0.04 + p.y, base.y + p.z);

  // Darker at the root (the sward's own shade), lighter toward the tips.
  vec3 tipCol = mix(col * 1.25 + vec3(0.02, 0.02, 0.0), vec3(0.55, 0.47, 0.30), seedHead * 0.8);
  vCoverCol = mix(col * 0.62, tipCol, tip);
  vCoverCol = mix(vCoverCol, vec3(0.80, 0.83, 0.88), snowK * 0.45 * tip);
  objectNormal = normalize(vec3(aOut.x * 0.35 * tip, 1.0, aOut.y * 0.35 * tip));
`;

// Flowers: the same placement (masks), then a seasonal palette for the heads.
const FLOWER_PLACE = /* glsl */ `
  vec2 gIdx = vec2(mod(aIndex, uCoverN), floor(aIndex / uCoverN));
  vec2 cell = floor(uCoverCenter / uCoverCell) + gIdx - floor(uCoverN * 0.5);
  float h1 = hash12(cell * 1.71 + 3.7);
  float h2 = hash12(cell * 0.93 + 11.3);
  float h3 = hash12(cell.yx * 1.37 + 2.9);
  float h4 = hash12(cell * 2.41 + 17.9);
  vec2 base = (cell + 0.1 + 0.8 * vec2(h1, h2)) * uCoverCell;
  vec2 rel = (base - uCoverCenter) / (uCoverN * uCoverCell * 0.5);
  float size = (1.0 - smoothstep(0.62, 0.97, length(rel))) * uCoverFade;
  vec4 gt = groundBilinear(base);
  float gy = gt.r;
  float shore = gt.b;
  float beach = gt.a;
  float open = step(3.0, shore) * step(beach, 0.3);
  vec2 ruv = (base - uRoadOrigin) / uRoadSize;
  if (inRect(ruv) > 0.5) {
    vec4 rd = texture2D(tRoad, ruv);
    float sd = (texture2D(tPath, ruv).r - 0.5) * ${(2 * PATH_RANGE).toFixed(3)};
    open *= step(sd, -0.6) * step(rd.b, 0.05) * step(rd.a, 0.02) * step(rd.r, 0.3);
  }
  vec2 luv = (base - uLotsRect.xy) / uLotsRect.zw;
  float lot = inRect(luv) > 0.5 ? texture2D(tLots, luv).r : 0.0;
  open *= step(lot, 0.75);
  float garden = step(0.2, lot);
  float gardenTend = clamp((lot - 0.25) / 0.25, 0.0, 1.0) * garden;
  vec2 cuv = (base - uCareRect.xy) / uCareRect.zw;
  float care = inRect(cuv) > 0.5 ? texture2D(tCare, cuv).r * 2.0 - 1.0 : 0.0;
  vec2 wuv = (base - uWoodRect.xy) / uWoodRect.zw;
  float wood = inRect(wuv) > 0.5 ? texture2D(tWood, wuv).r : 0.0;
  float inWood = smoothstep(0.2, 0.4, wood);
  // Flowers grow in two places only: tended gardens, and the wildflower
  // meadows (broad patches of open country, with drifts inside them). Open
  // pasture, verges and kept town land between them stay plain grass.
  float meadowZone = smoothstep(0.58, 0.7, vnoise(base * 0.012 + 31.0)) * (1.0 - garden);
  meadowZone *= 1.0 - smoothstep(0.15, 0.4, care);
  float drift = vnoise(base * 0.06 + 13.0);
  float keep = meadowZone * smoothstep(0.45, 0.68, drift) * 0.9;
  // Gardens: a scatter of flowers where the lot is well kept.
  keep += smoothstep(0.35, 0.7, gardenTend) * 0.4;
  keep *= 1.0 - 0.7 * smoothstep(28.0, 44.0, gy);
  // Season: spring and summer only; heads close and fade in autumn.
  float y = uYearT;
  float spring = smoothstep(0.04, 0.1, y) * (1.0 - smoothstep(0.26, 0.32, y));
  float summer = smoothstep(0.26, 0.32, y) * (1.0 - smoothstep(0.55, 0.64, y));
  float season = max(spring, summer) * (1.0 - smoothstep(0.2, 0.6, uSnow));
  // Bluebells: a spring carpet in the woods' meadow-side clearings only.
  keep = mix(keep, keep * spring * 1.3, inWood);
  coverDead = h4 >= keep * open || size * season < 0.02;
  float isHead = step(0.5, aOut.z);
  // Palettes (linear): spring buttercup, daisy, lady's smock, primrose;
  // summer poppy, cornflower, knapweed, ox-eye; bluebells under the trees.
  float pick = floor(fract(drift * 7.0 + h3 * 0.35) * 4.0);
  vec3 sp = pick < 0.5 ? vec3(0.85, 0.62, 0.05) : pick < 1.5 ? vec3(0.86, 0.85, 0.80) : pick < 2.5 ? vec3(0.62, 0.48, 0.70) : vec3(0.88, 0.80, 0.35);
  vec3 su = pick < 0.5 ? vec3(0.75, 0.06, 0.03) : pick < 1.5 ? vec3(0.13, 0.25, 0.75) : pick < 2.5 ? vec3(0.45, 0.16, 0.45) : vec3(0.86, 0.85, 0.80);
  vec3 head = mix(sp, su, smoothstep(0.24, 0.32, y));
  head = mix(head, vec3(0.20, 0.25, 0.70), inWood);
  vec3 stem = vec3(0.10, 0.20, 0.05);
  vCoverCol = mix(stem * 0.8, head, isHead) * (1.0 - 0.1 * uWet);

  vec3 p = position;
  p *= size * (0.5 + 0.3 * h3) * (0.4 + 0.6 * season);
  float yaw = h3 * 6.2832;
  float cy = cos(yaw), sy = sin(yaw);
  p.xz = mat2(cy, sy, -sy, cy) * p.xz;
  float windL = length(uWind);
  vec2 windD = uWind / max(windL, 1e-3);
  float gust = 0.5 + 0.5 * sin(dot(base, windD) * 0.16 - uDecoTime * (1.1 + 0.6 * windL));
  float nod = sin(uDecoTime * 2.1 + base.x * 0.9 + aOut.x * 8.0);
  p.xz += (windD * (0.1 + 0.4 * gust) * (0.4 + windL) + vec2(-windD.y, windD.x) * nod * 0.06) * p.y * 0.6;
  coverWorld = vec3(base.x + p.x, gy - 0.03 + p.y, base.y + p.z);
  objectNormal = vec3(0.0, 1.0, 0.0);
`;

const PROJECT = /* glsl */ `
  vec4 mvPosition = viewMatrix * vec4(coverWorld, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (coverDead) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;

function makeMaterial(grade, uniforms, flowers) {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  patchMaterial(material, grade, {
    key: flowers ? 'cover:flowers' : 'cover:grass',
    uniforms,
    vertexHead: VERTEX_HEAD,
    vertexNormal: flowers ? FLOWER_PLACE : VERTEX_PLACE,
    vertexEnd: /* glsl */ `
      #ifdef USE_SHADOWMAP
        worldPosition = vec4(coverWorld, 1.0);
      #endif
    `,
    fragmentHead: 'varying vec3 vCoverCol;\n',
    fragmentColor: 'diffuseColor.rgb = vCoverCol * uTint;\n',
  });
  const patched = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    patched(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', PROJECT);
    // Thin blades: both faces take the light as the up-facing side does.
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n  normal = normalize(normal * faceDirection);');
  };
  return material;
}

export function createGroundCover(ctx) {
  const { scene, grade, roads, buildings } = ctx;
  const group = new THREE.Group();
  group.name = 'groundcover';
  scene.add(group);

  // Lot mask: 0 open land, 0.25..0.5 garden / park lawn (by how well kept),
  // 1 bare (yards, fields, paving).
  const lotData = new Uint8Array(LOT_N * LOT_N);
  const tLots = new THREE.DataTexture(lotData, LOT_N, LOT_N, THREE.RedFormat, THREE.UnsignedByteType);
  tLots.magFilter = THREE.NearestFilter;
  tLots.minFilter = THREE.NearestFilter;
  tLots.needsUpdate = true;
  // Landscaping level, one texel per sim block (neutral until the sim has one).
  const careEmpty = new Uint8Array([128]);
  let tCare = new THREE.DataTexture(careEmpty, 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tCare.needsUpdate = true;

  const uniforms = {
    ...roads.uniforms, ...WOODLAND,
    tLots: { value: tLots },
    uLotsRect: { value: new THREE.Vector4(GROUND_ORIGIN, GROUND_ORIGIN, LOT_N * LOT_CELL, LOT_N * LOT_CELL) },
    tCare: { value: tCare },
    uCareRect: { value: new THREE.Vector4(-1e6, -1e6, 1, 1) },
    uCoverCenter: { value: new THREE.Vector2() },
    uCoverFade: { value: 1 },
  };

  function makeMesh(geometry, flowers, cap) {
    const idx = new Float32Array(cap);
    for (let i = 0; i < cap; i++) idx[i] = i;
    geometry.setAttribute('aIndex', new THREE.InstancedBufferAttribute(idx, 1));
    geometry.instanceCount = 0;
    // Each mesh has its own grid size and cell on top of the shared uniforms.
    const own = { ...uniforms, uCoverN: { value: 1 }, uCoverCell: { value: 1 } };
    const mesh = new THREE.Mesh(geometry, makeMaterial(grade, own, flowers));
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.visible = false;
    mesh.userData.own = own;
    group.add(mesh);
    return mesh;
  }
  const grass = makeMesh(tuftGeometry(), false, COVER.full.grassN ** 2);
  const flowers = makeMesh(flowerGeometry(), true, COVER.full.flowerN ** 2);

  let spec = null;
  let lotsVersion = -1;
  let lastLotBuild = -10;
  let careSig = null;

  function applyQuality(q) {
    spec = COVER[q?.groundCover] ?? null;
    for (const [mesh, n, cell] of [[grass, spec?.grassN ?? 0, spec?.grassCell ?? 1], [flowers, spec?.flowerN ?? 0, spec?.flowerCell ?? 1]]) {
      mesh.geometry.instanceCount = n * n;
      mesh.userData.own.uCoverN.value = Math.max(1, n);
      mesh.userData.own.uCoverCell.value = cell;
      mesh.userData.active = n > 0;
      mesh.visible = false;
    }
  }

  function rebuildLots() {
    lotData.fill(0);
    const span = LOT_N * LOT_CELL;
    for (const lot of buildings.lots.values()) {
      const s = lot.summary;
      if (!s) continue;
      const bare = BARE_LOTS.has(s.type);
      // Gardens carry how well they are kept: 64 (neglected) .. 127 (tended).
      const tend = Math.max(0, Math.min(1, lot.record?.tend ?? 0));
      const v = bare ? 255 : 64 + Math.round(tend * 63);
      // A little margin round worked ground; gardens stop at the fence.
      const m = bare ? 1 : 0;
      const i0 = Math.max(0, Math.floor((s.x - s.w / 2 - m - GROUND_ORIGIN) / LOT_CELL));
      const i1 = Math.min(LOT_N - 1, Math.floor((s.x + s.w / 2 + m - GROUND_ORIGIN) / LOT_CELL));
      const j0 = Math.max(0, Math.floor((s.z - s.d / 2 - m - GROUND_ORIGIN) / LOT_CELL));
      const j1 = Math.min(LOT_N - 1, Math.floor((s.z + s.d / 2 + m - GROUND_ORIGIN) / LOT_CELL));
      if (i1 < 0 || j1 < 0 || i0 >= LOT_N || j0 >= LOT_N || span <= 0) continue;
      for (let j = j0; j <= j1; j++) {
        const row = j * LOT_N;
        for (let i = i0; i <= i1; i++) if (lotData[row + i] < v) lotData[row + i] = v;
      }
    }
    tLots.needsUpdate = true;
  }

  function syncCare(view) {
    const L = view?.landscape;
    if (!L?.level || !L.W) return;
    const sig = `${L.year}:${L.W}:${L.H}`;
    if (sig === careSig) return;
    careSig = sig;
    const data = new Uint8Array(L.W * L.H);
    for (let k = 0; k < data.length; k++) data[k] = Math.max(0, Math.min(255, Math.round((L.level[k] / 100 + 1) * 127.5)));
    const tex = new THREE.DataTexture(data, L.W, L.H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    if (tCare.image.data !== careEmpty) tCare.dispose();
    tCare = tex;
    uniforms.tCare.value = tex;
    for (const mesh of [grass, flowers]) mesh.userData.own.tCare.value = tex;
    uniforms.uCareRect.value.set(L.ox, L.ox, L.W * L.cell, L.H * L.cell);
  }

  const centre = new THREE.Vector2();
  function update(view, frame) {
    if (!spec) return;
    const d = frame.distance ?? 100;
    const fade = 1 - THREE.MathUtils.smoothstep(d, HIDE_BEYOND * 0.7, HIDE_BEYOND);
    const shown = fade > 0.01;
    for (const mesh of [grass, flowers]) mesh.visible = shown && mesh.userData.active;
    if (!shown) return;
    const bv = buildings.version();
    if (bv !== lotsVersion && frame.time - lastLotBuild > LOT_REBUILD_GAP) {
      lotsVersion = bv;
      lastLotBuild = frame.time;
      rebuildLots();
    }
    syncCare(view);
    // Centre the square a little toward the eye, where the ground is nearest.
    const t = frame.target, eye = frame.camera.position;
    centre.set(t.x + (eye.x - t.x) * 0.3, t.z + (eye.z - t.z) * 0.3);
    for (const mesh of [grass, flowers]) {
      mesh.userData.own.uCoverCenter.value.copy(centre);
      mesh.userData.own.uCoverFade.value = fade;
    }
  }

  applyQuality(ctx.quality);

  return {
    group,
    update,
    applyQuality,
    /** Instances submitted per mesh (diagnostics). */
    stats: () => ({ grass: grass.visible ? grass.geometry.instanceCount : 0, flowers: flowers.visible ? flowers.geometry.instanceCount : 0 }),
    dispose() {
      for (const mesh of [grass, flowers]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      tLots.dispose();
      tCare.dispose();
      scene.remove(group);
    },
  };
}
