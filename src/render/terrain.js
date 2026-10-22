import * as THREE from 'three';
import * as T from '../terrain.js';
import { patchMaterial, NOISE, LAYER_REFLECT, GRADE_HEAD, MICRO_HEAD, MICRO_NORMAL, SPEC_HEAD, SPEC_PARS, SPEC_NORMAL, SPEC_END, hashId } from './shaderlib.js';
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
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
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
// Ground detail (docs/design/graphics-review.md P1) rides on micro-detail
// (relief) and specular (the wet-sand sheen). NO_GROUND_DETAIL turns it off
// on its own, for A/B runs (micro-detail-ab.js --feature=ground).
#if defined(MICRO_DETAIL) && !defined(NO_GROUND_DETAIL)
  #define GROUND_RELIEF
#endif
#if defined(SPECULAR) && !defined(NO_GROUND_DETAIL)
  #define GROUND_SHEEN
#endif
${NOISE}
${ROAD_GLSL}
#ifdef GROUND_RELIEF
// Relief of the ground the roads lie on (grass, sand, shingle, rock): world
// slope, mixed as the colours are. gGrassW is the share that is sward, gPx
// metres per pixel, gPud standing water (which lies flat).
vec3 gGround = vec3(0.0);
float gGrassW = 1.0;
float gPx = 1.0;
float gPud = 0.0;

// Wind ripples on sand, crests about 0.7 m apart, wobbling every couple of
// metres and dying out in patches: x the crest (-1..1, for colour), yz the
// slope of amp metres of them. n is the albedo's broad noise.
vec3 ripples(vec2 p, float n, float amp) {
  float k = reliefFade(0.7, gPx);
  if (k <= 0.0) return vec3(0.0);
  vec2 d = vec2(0.6, 0.8);
  vec3 w = vnoised(p * 0.45 + 21.0);
  float ph = dot(p, d) * 9.0 + n * 4.0 + w.x * 3.0;
  amp *= k * smoothstep(0.2, 0.75, vnoise(p * 0.3 + 7.0) * 0.6 + n * 0.4);
  return vec3(sin(ph) * amp / 0.012, (d * 9.0 + w.yz * (3.0 * 0.45)) * (cos(ph) * amp));
}
#endif
#ifdef GROUND_SHEEN
// Wet sand just above the waterline (0..1): it shines in any weather.
float gWetSand = 0.0;
#endif

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
  // Soft-edged (a triangle wave through a smoothstep): a hard step drew a
  // stair of bright and dark bands across the far hills' facets.
  float strata = 0.9 + 0.12 * smoothstep(0.3, 0.7, abs(fract(p.y * 0.18 + n * 0.4) - 0.5) * 2.0);
  vec3 c = mix(g, ${lin('#a69d8c')} * (0.9 + 0.2 * n), scree * 0.75);
  c = mix(c, uRockColor * strata * (0.85 + 0.25 * n), rock);
  #ifdef GROUND_RELIEF
    gGrassW = 1.0 - scree * 0.75;
    // Rock faces: knobs from two planes of noise, the plan (p.xz, 1.7 m)
    // and an upright one (across and up the face, 0.6 m). Two are enough on
    // a height field: a steep face spans height more than plan.
    float rk1 = reliefFade(1.7, gPx);
    if (rock > 0.0 && rk1 > 0.0) {
      vec3 r1 = vnoised(p.xz / 1.7);
      vec3 r2 = vnoised(vec2(p.x - p.z, p.y * 1.3) / 0.6 + 5.0);
      vec3 rs = vec3(r1.y, 0.0, r1.z) * (0.12 / 1.7 * rk1);
      rs += vec3(r2.y, r2.z * 1.3, -r2.y) * (0.05 / 0.6 * reliefFade(0.6, gPx));
      gGround = rs * rock;
      c *= mix(1.0, 0.86 + 0.28 * (r1.x * 0.6 + r2.x * 0.4), rock * rk1);
    }
  #endif
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
    #ifdef GROUND_RELIEF
      // Wind ripples on sand; shingle stays smooth.
      float sandK = smoothstep(4.0, 10.0, bw);
      vec3 rip = ripples(p.xz, n, 0.0035) * sandK;
      shore *= 1.0 + 0.04 * rip.x;
    #endif
    c = mix(c, shore, (1.0 - smoothstep(edge, edge + 2.5, e)) * (1.0 - rock * 0.7));
    #if defined(GROUND_RELIEF) || defined(GROUND_SHEEN)
      float shoreW = (1.0 - smoothstep(edge, edge + 2.5, e)) * (1.0 - rock * 0.7);
    #endif
    #ifdef GROUND_RELIEF
      gGround = mix(gGround, vec3(rip.y, 0.0, rip.z), shoreW);
      gGrassW *= 1.0 - shoreW;
    #endif
    #ifdef GROUND_SHEEN
      gWetSand = (1.0 - smoothstep(0.0, 1.8, e)) * smoothstep(-0.5, -0.1, e) * shoreW;
    #endif
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
    #ifdef GROUND_RELIEF
      vec3 rip = ripples(p.xz, n, 0.0025);
      sand *= 1.0 + 0.04 * rip.x;
    #endif
    vec3 bank = mix(${lin('#a39a6c')}, sand, smoothstep(-0.8, 0.4, e));
    bank = mix(${lin('#7d8a6a')}, bank, smoothstep(-1.6, -1.0, e));
    c = mix(c, sand, (1.0 - smoothstep(0.2, 1.6, e)) * 0.75);
    c = mix(c, bank, 1.0 - smoothstep(0.2, 0.6, e));
    #ifdef GROUND_RELIEF
      float bankW = 1.0 - (1.0 - (1.0 - smoothstep(0.2, 1.6, e)) * 0.75) * smoothstep(0.2, 0.6, e);
      gGround = mix(gGround, vec3(rip.y, 0.0, rip.z), bankW);
      gGrassW *= 1.0 - bankW;
    #endif
    #ifdef GROUND_SHEEN
      gWetSand = max(gWetSand, (1.0 - smoothstep(0.1, 0.7, e)) * smoothstep(-0.4, -0.05, e));
    #endif
  }
  return c;
}
`;

const SHADE_FRAGMENT = /* glsl */ `
  #ifdef GRID
    // The channel strip draws the river banks here (down to the river's mouth).
    if (abs(vRiverU) < uWaterHalf + 2.5 && vWorldP.z > uRiverEnd) discard;
  #endif
  #ifdef GROUND_RELIEF
    gPx = length(fwidth(vWorldP));
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
    #ifdef GROUND_RELIEF
      // The same tufts with their slopes: tussocks of a few centimetres
      // that catch a low sun, each octave faded by its own footprint.
      vec3 t1 = vnoised(vWorldP.xz * 0.9), t2 = vnoised(vWorldP.xz * 2.7 + 3.0), t3 = vnoised(vWorldP.xz * 7.3);
      float tuft = t1.x * 0.55 + t2.x * 0.3 + t3.x * 0.15;
      vec2 tg = t1.yz * (0.9 * 0.05 * reliefFade(1.0 / 0.9, gPx)) + t2.yz * (2.7 * 0.03 * reliefFade(1.0 / 2.7, gPx))
        + t3.yz * (7.3 * 0.02 * reliefFade(1.0 / 7.3, gPx));
      gGround.xz += tg * gGrassW * (1.0 - rock) * nearK;
      // Lay: the sward combed along the prevailing wind, long faint streaks.
      vec2 ld = vec2(0.894, 0.447);
      float lay = vnoise(vec2(dot(vWorldP.xz, ld) * 0.25, dot(vWorldP.xz, vec2(-ld.y, ld.x)) * 1.4));
      grassy *= 1.0 + (lay - 0.5) * 0.1 * nearK;
    #else
    float tuft = vnoise(vWorldP.xz * 0.9) * 0.55 + vnoise(vWorldP.xz * 2.7 + 3.0) * 0.3 + vnoise(vWorldP.xz * 7.3) * 0.15;
    #endif
    grassy *= mix(1.0, 0.9 + 0.2 * tuft, nearK);
    grassy = mix(grassy, grassy * vec3(1.1, 1.04, 0.82), smoothstep(0.62, 0.8, tuft) * 0.35 * nearK);
  }
  // The sward a little less saturated than the rest: lit tufts read as neon otherwise.
  grassy = mix(vec3(dot(grassy, vec3(0.3, 0.55, 0.15))), grassy, 0.86) * 0.97;
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
      #ifdef GROUND_RELIEF
        // The bigger stones stand 2 cm proud.
        vec3 bp = pebbles(vWorldP.xz, 3.1, 0.02) * reliefFade(1.0 / 3.1, gPx);
        gGround = mix(gGround, vec3(bp.y, 0.0, bp.z), barK * (1.0 - scrub * 0.6));
      #endif
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
  #ifdef SPECULAR
    // Wet sheen only in the rain, faded out with distance.
    gSpecK *= smoothstep(0.1, 0.6, uWet) * (1.0 - smoothstep(250.0, 400.0, length(vWorldP - cameraPosition)));
  #endif
  #ifdef GROUND_SHEEN
    // Wet sand just above the waterline shines in any weather: a sheen of
    // gloss 0.5 and roughness 0.3, blended with whatever the roads set.
    float wsG = 0.5 * gWetSand * (1.0 - roadA) * (1.0 - smoothstep(250.0, 400.0, length(vWorldP - cameraPosition)));
    gSpecRough = (gSpecK * gSpecRough + wsG * 0.3) / max(gSpecK + wsG, 1e-4);
    gSpecK = max(gSpecK, wsG);
  #endif
  // Wet weather darkens roads more than grass.
  // Wet ground darkens; trodden roads darken most and read as sheened mud.
  col *= 1.0 - uWet * (0.12 + 0.16 * roadA);
  #ifndef RING
    // Puddles: hollows in lanes and trodden ground hold water that mirrors
    // the sky, more of them the longer the rain has set in.
    if (uWet > 0.05 && uWeatherDetail > 0.5) {
      float pud = vnoise(vWorldP.xz * 0.42 + 17.0) * 0.7 + vnoise(vWorldP.xz * 1.3 + 4.0) * 0.3;
      float pk = smoothstep(0.66 - 0.12 * uWet, 0.74 - 0.1 * uWet, pud) * max(roadA, 0.18 * (1.0 - rock)) * smoothstep(0.85, 0.97, vUp);
      pk *= smoothstep(0.15, 0.6, uWet) * (1.0 - smoothstep(0.3, 0.7, uSnow));
      #ifdef GROUND_RELIEF
        gPud = pk;
      #endif
      vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, 0.35) * (1.0 - 0.5 * uNight);
      #ifdef SPECULAR
        // Standing water: a smooth mirror (the specular term reflects the
        // sky and the sun), over dark wet ground.
        col = mix(col, col * 0.45 + skyRefl * 0.12, pk * 0.8);
        gSpecK = mix(gSpecK, 1.0, pk);
        gSpecRough = mix(gSpecRough, 0.06, pk);
      #else
        col = mix(col, col * 0.45 + skyRefl * 0.32, pk * 0.8);
      #endif
    }
  #endif
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
  #ifdef GROUND_RELIEF
    // The ground's relief under the roads, the soil's on them; standing
    // water and snow lie flat.
    gBumpW += (gGround * (1.0 - roadA) + gSoil) * (1.0 - snow) * (1.0 - gPud);
  #endif
  #ifdef SPECULAR
    gSpecK *= (1.0 - snow) * step(uOverlay, 0.5);
  #endif
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
// wall (embanked run) takes the bar away. On the dry bank the strip also
// follows the ground texture where that is higher (building pads that reach
// the river, which otherwise ended in a step at the chunks' edge), and
// beyond STRIP_TEXTURE_U past the water's edge it is the texture outright,
// so everything draped on the texture stands on what is drawn. The bank-top
// kink is concave, so the texture only ever reads low there and the max
// keeps the bank crisp.
const STRIP_TEXTURE_U = 1.5;
const STRIP_HEAD = /* glsl */ `
float stripHeight(out float onTex) {
  float y = position.y - aBank.x * embanked(vec2(aRiverU, position.z));
  onTex = 0.0;
  float ru = abs(aRiverU) - uWaterHalf;
  if (ru < 0.0) return y;
  // The outer edge keeps its tuck under the chunks (buildStrip).
  float tex = groundHeight(position.xz) - (ru >= 2.9 ? 0.04 : 0.0);
  if (ru < ${STRIP_TEXTURE_U.toFixed(2)} && tex <= y) return y;
  onTex = 1.0;
  return tex;
}
`;
const STRIP_NORMAL = /* glsl */ `
  float stripOnTex;
  float stripY = stripHeight(stripOnTex);
  if (stripOnTex > 0.5) objectNormal = groundNormal(position.xz);
`;
const STRIP_BEGIN = /* glsl */ `
  float embK = embanked(vec2(aRiverU, position.z));
  vBankS = vec2(aBank.x * (1.0 - embK), aBank.y + stripY - position.y);
  transformed.y = stripY;
`;

// Far ring: smooth node normals with a trace of the facet, so the hills
// keep their cut-paper look without each facet lighting up on its own.
const RING_FACET_GLSL = /* glsl */ `
  normal = normalize(mix(normal, normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))), 0.3));
`;

function makeMaterial(grade, roads, variant) {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
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
      + (strip ? 'attribute vec2 aBank;\nvarying vec2 vBankS;\n' + EMBANK_GLSL + STRIP_HEAD : ''),
    vertexNormal: grid ? GRID_NORMAL : strip ? STRIP_NORMAL : '',
    vertexBegin: grid ? GRID_BEGIN : strip ? STRIP_BEGIN : '',
    vertexEnd: /* glsl */ `
      vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vUp = normalize(mat3(modelMatrix) * objectNormal).y;
      ${grid ? 'vRiverU = groundRiverU(gXZ);' : 'vRiverU = aRiverU;'}
      ${grid ? 'vShore = groundShore(gXZ); vBeach = groundBeach(gXZ);'
        : variant === 'ring' ? 'vShore = aShore.x; vBeach = aShore.y;'
          : 'vShore = abs(aRiverU) - uWaterHalf; vBeach = groundBeach(position.xz);'}
    `,
    fragmentHead: 'uniform float uWaterHalf;\nuniform float uRiverEnd;\nuniform float uFloodplain;\n' + (strip ? 'varying vec2 vBankS;\n' : '') + MICRO_HEAD
      + `#ifdef SPECULAR\n${SPEC_HEAD}\n#endif\n` + SHADE_GLSL,
    fragmentColor: SHADE_FRAGMENT,
    fragmentNormal: `${variant === 'ring' ? RING_FACET_GLSL : ''}#ifdef MICRO_DETAIL\n${MICRO_NORMAL}\n#endif\n#ifdef SPECULAR\n${SPEC_NORMAL}\n#endif\n`,
    fragmentPars: `#ifdef SPECULAR\n${SPEC_PARS}\n#endif\n`,
    fragmentLights: `#ifdef SPECULAR\n${SPEC_END}\n#endif\n`,
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
/**
 * A chunk's LOD, picked by the camera's distance to the chunk's nearest point
 * rather than its centre. Chunks are 168 m, so measured to the centre the
 * ground right under a close camera could drop to the 2 or 4 m grid while
 * everything standing on it (pads, fields, decals, trees, people) reads the
 * 1 m texture, and floats or sinks by the difference. Same hysteresis.
 */
function nearestPointLod(cx, cz) {
  const { lo, hi } = chunkRange(cx, cz);
  const lod = new THREE.LOD();
  const cam = new THREE.Vector3();
  lod.update = function update(camera) {
    const levels = this.levels;
    if (levels.length < 2) return;
    cam.setFromMatrixPosition(camera.matrixWorld);
    const dx = Math.max(Math.abs(cam.x - cx) - CHUNK / 2, 0);
    const dz = Math.max(Math.abs(cam.z - cz) - CHUNK / 2, 0);
    const dy = Math.max(cam.y - hi, lo - cam.y, 0);
    const distance = Math.hypot(dx, dy, dz) / camera.zoom;
    levels[0].object.visible = true;
    let i = 1;
    for (; i < levels.length; i++) {
      let d = levels[i].distance;
      if (levels[i].object.visible) d -= d * levels[i].hysteresis;
      if (distance < d) break;
      levels[i - 1].object.visible = false;
      levels[i].object.visible = true;
    }
    this._currentLevel = i - 1;
    for (; i < levels.length; i++) levels[i].object.visible = false;
  };
  return lod;
}

function chunkRange(cx, cz) {
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j <= 16; j++) {
    for (let i = 0; i <= 16; i++) {
      const h = T.heightAt(cx - CHUNK / 2 + (i * CHUNK) / 16, cz - CHUNK / 2 + (j * CHUNK) / 16);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
  }
  return { lo, hi };
}

function chunkSphere(cx, cz) {
  let { lo, hi } = chunkRange(cx, cz);
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
  g.boundingSphere.radius += 4; // its bank follows the texture's pads
  return g;
}

/** Far ring: faceted analytic land from the ground texture's edge outward. */
function buildRing() {
  const n = (RING_EXTENT * 2) / RING_STEP;
  // Each grid node once: height, river offset, shore distance and character.
  const N = Math.ceil(n) + 1;
  const node = new Float32Array(N * N * 4);
  // Heights everywhere (the edge nodes' normals read their inner neighbours).
  const hgt = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) hgt[j * N + i] = T.heightAt(-RING_EXTENT + i * RING_STEP, -RING_EXTENT + j * RING_STEP);
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -RING_EXTENT + i * RING_STEP, z = -RING_EXTENT + j * RING_STEP;
      // Inside the ground texture only the edge nodes are used.
      const inner = x > GROUND_ORIGIN + RING_STEP && x < GROUND_LIMIT - RING_STEP && z > GROUND_ORIGIN + RING_STEP && z < GROUND_LIMIT - RING_STEP;
      if (inner) continue;
      const k = (j * N + i) * 4;
      const shore = T.bankDistance(x, z);
      node[k] = hgt[j * N + i];
      node[k + 1] = x - T.riverX(z);
      node[k + 2] = Math.max(-200, Math.min(200, shore));
      node[k + 3] = shoreCharacter(x, z, shore);
    }
  }
  // Smooth node normals from central differences: shared by every facet at
  // a node, so light and the slope bands (rock, scree, snow) run smoothly
  // across the facets instead of switching at each edge. The fragment shader
  // keeps a trace of the facet (RING_FACET_GLSL).
  const nrm = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(N - 1, j + 1);
      const dx = (hgt[j * N + i1] - hgt[j * N + i0]) / ((i1 - i0) * RING_STEP);
      const dz = (hgt[j1 * N + i] - hgt[j0 * N + i]) / ((j1 - j0) * RING_STEP);
      const l = Math.hypot(dx, 1, dz);
      nrm.set([-dx / l, 1 / l, -dz / l], (j * N + i) * 3);
    }
  }
  const pos = [];
  const normal = [];
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
          const kn = (vj * N + vi) * 3;
          normal.push(nrm[kn], nrm[kn + 1], nrm[kn + 2]);
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
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
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
      const lod = nearestPointLod(cx, cz);
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
    const cloud = q.cloudShadow ? 1 : 0;
    // Stone relief on the paving (micro-detail) and the wet sheen
    // (specular); the far ring draws no roads.
    const micro = q.microDetail ? 1 : 0;
    const spec = q.specular ? 1 : 0;
    // The ground's own detail (graphics-review P1) rides on both; only A/B
    // runs and the dev page's &ground=0 turn it off on its own.
    const noGround = q.groundDetail === false && (micro || spec) ? 1 : 0;
    for (const m of materials) {
      const ring = m.userData.variant === 'ring';
      const wantMicro = ring ? 0 : micro;
      const wantSpec = ring ? 0 : spec;
      const wantNoGround = ring ? 0 : noGround;
      if (cloud === (m.defines.CLOUD_SHADOW ? 1 : 0) && wantMicro === (m.defines.MICRO_DETAIL ? 1 : 0)
        && wantSpec === (m.defines.SPECULAR ? 1 : 0) && wantNoGround === (m.defines.NO_GROUND_DETAIL ? 1 : 0)) continue;
      if (cloud) m.defines.CLOUD_SHADOW = 1;
      else delete m.defines.CLOUD_SHADOW;
      if (wantMicro) m.defines.MICRO_DETAIL = 1;
      else delete m.defines.MICRO_DETAIL;
      if (wantSpec) m.defines.SPECULAR = 1;
      else delete m.defines.SPECULAR;
      if (wantNoGround) m.defines.NO_GROUND_DETAIL = 1;
      else delete m.defines.NO_GROUND_DETAIL;
      // Off keeps the key it had before the specular term existed.
      const key = `terrain:${m.userData.variant}:${cloud}:${wantMicro}${wantSpec ? ':spec' : ''}${wantNoGround ? ':noground' : ''}`;
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
