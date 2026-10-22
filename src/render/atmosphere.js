import * as THREE from 'three';

// One atmosphere for the whole world (design-visual §3.4).
//
// Before this module, distant buildings and distant land were fogged by two
// different paths:
//  - built-in and kit materials used Three's fog chunk, which runs AFTER tone
//    mapping and the sRGB transform: full smoothstep fog to an untonemapped
//    fog colour, so far buildings turned a pale mint ghost;
//  - terrain, trees and water swapped in a capped "haze" (at most 48 %),
//    mixing the sRGB fog colour with the linear horizon colour, also after
//    tone mapping.
// The two never agreed, and both disagreed with the sky dome, whose horizon
// band is tone mapped like everything else.
//
// Now every fogged material, built-in or custom, gets the same aerial
// perspective, in linear light, before tone mapping:
//  - `fog_pars_fragment` gains hvAtmosphere(), the one haze curve;
//  - `tonemapping_fragment` applies it first (then tone maps, as before);
//  - `fog_fragment` applies it only if the shader had no tone mapping chunk.
// The fog colour reaches shaders in linear working space on every tier
// (LinearFogColor), so it matches the sky dome's horizon after tone mapping.

// Valley mist lives in the same pass (mist.js drives it): an exponential
// height fog over the valley floor, thickest at the water and thinning by
// MIST_HEIGHT metres, integrated along the view ray from the camera to each
// fragment, with slow banks drifting in it. No sheets and no extra draw: walls,
// trunks and slopes fade into it with depth instead of cutting hard lines
// through a layer, and it costs a few operations in the fog every fogged
// material already runs. Materials without the grade uniforms read 0: none.
const MIST_HEIGHT = 2.2;

const ATMOS_VERT_PARS = /* glsl */ `
#ifdef USE_FOG
varying vec3 vHvWorld;
#endif
`;

// The fragment's world position from the view-space one three already has:
// the view's inverse rotation is its transpose, plus the camera's position.
const ATMOS_VERT = /* glsl */ `
#ifdef USE_FOG
  vHvWorld = transpose(mat3(viewMatrix)) * mvPosition.xyz + cameraPosition;
#endif
`;

const ATMOS_PARS = /* glsl */ `
#ifdef USE_FOG
bool hvHazed = false;
varying vec3 vHvWorld;
uniform float uMistAmt;   // 0 clear .. 1 thick (mist.js)
uniform vec2 uMistDrift;  // the banks' drift with the wind (metres)
uniform vec3 uMistColor;  // lit mist colour, linear
float hvMistHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hvMistNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hvMistHash(i), hvMistHash(i + vec2(1.0, 0.0)), u.x),
             mix(hvMistHash(i + vec2(0.0, 1.0)), hvMistHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Mist between the camera and world point w: the density falls off as
// exp(-h / H) with height h above the water; its average along the ray is
// (e^-k*h0 - e^-k*h1) / (k * (h1 - h0)) between the two ends (positive either
// way up).
float hvMist(vec3 w) {
  if (uMistAmt < 0.002) return 0.0;
  const float k = 1.0 / ${MIST_HEIGHT.toFixed(2)};
  float h0 = max(cameraPosition.y, 0.0), h1 = max(w.y, 0.0);
  float a = exp(-k * h0), b = exp(-k * h1);
  float dh = h1 - h0;
  float avg = abs(dh) > 0.02 ? max((a - b) / (k * dh), 0.0) : b;
  float banks = hvMistNoise(w.xz * 0.011 + uMistDrift * 0.011) * 0.7 + hvMistNoise(w.xz * 0.031 - uMistDrift * 0.02 + 7.0) * 0.3;
  float density = 0.07 * uMistAmt * mix(0.35, 1.45, smoothstep(0.25, 0.8, banks));
  return clamp(1.0 - exp(-density * distance(w, cameraPosition) * avg), 0.0, 0.62);
}

// Haze amount at view depth d: Three's linear valley fog, capped so distant
// relief keeps 58-84 % of its colour (mountains and far towns still read).
float hvHazeAmount(float d) {
  #ifdef FOG_EXP2
    return 1.0 - exp(-fogDensity * fogDensity * d * d);
  #else
    float lin = clamp((d - fogNear) / max(fogFar - fogNear, 1.0), 0.0, 1.0);
    float far = smoothstep(fogNear, fogFar * 2.0, d);
    return min(lin, 0.16 + 0.26 * far);
  #endif
}
vec3 hvAtmosphere(vec3 col) {
  col = mix(col, uMistColor, hvMist(vHvWorld));
  return mix(col, fogColor, hvHazeAmount(vFogDepth));
}
#endif
`;

const ATMOS_APPLY = /* glsl */ `
#ifdef USE_FOG
  if (!hvHazed) {
    gl_FragColor.rgb = hvAtmosphere(gl_FragColor.rgb);
    hvHazed = true;
  }
#endif
`;

let installed = false;

/** Patch Three's shader chunks once, before any material compiles. */
export function installAtmosphere() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = C.fog_pars_vertex + ATMOS_VERT_PARS;
  C.fog_vertex = C.fog_vertex + ATMOS_VERT;
  C.fog_pars_fragment = C.fog_pars_fragment + ATMOS_PARS;
  C.tonemapping_fragment = ATMOS_APPLY + C.tonemapping_fragment;
  C.fog_fragment = ATMOS_APPLY;
}

/**
 * Fog colour that always uploads in linear working space. Three converts the
 * fog colour to the output space (sRGB) when drawing to the screen, which was
 * right for its post-tonemap fog but wrong for haze applied in linear light.
 */
export class LinearFogColor extends THREE.Color {
  getRGB(target) {
    target.r = this.r;
    target.g = this.g;
    target.b = this.b;
    return target;
  }
}

/** Same haze curve on the CPU (tests, picking tints, debugging). */
export function hazeAmount(depth, near, far) {
  const lin = Math.min(1, Math.max(0, (depth - near) / Math.max(far - near, 1)));
  const t = Math.min(1, Math.max(0, (depth - near) / (far * 2 - near)));
  const farK = t * t * (3 - 2 * t);
  return Math.min(lin, 0.16 + 0.26 * farK);
}

installAtmosphere();
