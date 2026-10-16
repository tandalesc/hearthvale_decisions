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

const ATMOS_PARS = /* glsl */ `
#ifdef USE_FOG
bool hvHazed = false;
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
