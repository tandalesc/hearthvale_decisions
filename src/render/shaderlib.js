import * as THREE from 'three';
import { COVER_GLSL, COVER_APPLY } from './shadowsurface.js';

// Small helpers for patching Three's built-in materials with our grade
// uniforms and shader snippets via onBeforeCompile.

/**
 * Patch a built-in material. `spec` fields (all optional):
 *  key            unique cache key for this patch variant
 *  uniforms       extra uniforms (merged with the grade uniforms)
 *  defines        extra defines
 *  vertexHead     GLSL prepended to the vertex shader (attributes, varyings)
 *  vertexBegin    GLSL appended after `#include <begin_vertex>` (edit `transformed`)
 *  vertexEnd      GLSL appended after `#include <worldpos_vertex>`
 *  fragmentHead   GLSL prepended to the fragment shader
 *  fragmentColor  GLSL appended after `#include <color_fragment>` (edit `diffuseColor`)
 *  fragmentNormal GLSL appended after `#include <normal_fragment_maps>` (edit the view-space `normal`)
 *  fragmentPars   GLSL appended after `#include <lights_lambert_pars_fragment>` (light functions)
 *  fragmentLights GLSL appended after `#include <lights_fragment_end>` (direct light is summed)
 *  fragmentEmissive GLSL appended after `#include <emissivemap_fragment>` (edit `totalEmissiveRadiance`)
 *  fragmentEnd    GLSL appended after `#include <opaque_fragment>`... (edit gl_FragColor before fog)
 */
export function patchMaterial(material, grade, spec) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms, spec.uniforms ?? {});
    shader.defines = { ...(shader.defines ?? {}), ...(spec.defines ?? {}) };
    let v = shader.vertexShader;
    let f = shader.fragmentShader;
    v = GRADE_HEAD + (spec.vertexHead ?? '') + '\n' + v;
    f = GRADE_HEAD + (spec.fragmentHead ?? '') + '\n' + f;
    if (spec.vertexBegin) v = v.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + spec.vertexBegin);
    if (spec.vertexNormal) v = v.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + spec.vertexNormal);
    if (spec.vertexEnd) v = v.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + spec.vertexEnd);
    if (spec.fragmentColor) f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + spec.fragmentColor);
    // The ground's shadow surface (shadowsurface.js): people's and soft tree
    // shadows take the sun away like the shadow map does.
    if (!spec.noCover) f = f.replace('#include <aomap_fragment>', COVER_APPLY + '#include <aomap_fragment>');
    if (spec.fragmentNormal) f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + spec.fragmentNormal);
    if (spec.fragmentPars) f = f.replace('#include <lights_lambert_pars_fragment>', '#include <lights_lambert_pars_fragment>\n' + spec.fragmentPars);
    if (spec.fragmentLights) f = f.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + spec.fragmentLights);
    if (spec.fragmentEmissive) f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + spec.fragmentEmissive);
    if (spec.fragmentEnd) f = f.replace('#include <fog_fragment>', spec.fragmentEnd + '\n#include <fog_fragment>');
    shader.vertexShader = v;
    shader.fragmentShader = f;
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => spec.key ?? material.uuid;
  return material;
}

// Grade uniforms shared by every patched shader.
export const GRADE_HEAD = COVER_GLSL + /* glsl */ `
uniform float uTime;
// Clock for decorative motion (sails, sway, boats, flags): frozen under reduced motion.
uniform float uDecoTime;
uniform vec3 uSunDir;
uniform vec3 uTint;
uniform float uSnow;
uniform float uAutumn;
uniform float uBare;
uniform float uBlossom;
uniform float uNight;
uniform vec2 uWind;
uniform float uWet;
uniform float uOverlay;
// 1 where the tier draws weather detail (puddles, crop waves; quality.js).
uniform float uWeatherDetail;
`;

// Hash and value noise, cheap enough for every fragment.
export const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// Micro-detail (docs/design/micro-detail.md): pattern code adds the slope of
// its analytic height (metres per metre, world space) to gBumpW, and
// MICRO_NORMAL tilts the shading normal by it. This is Mikkelsen's surface
// gradient for a volumetric height: the slope projected onto the surface,
// so no tangents or UVs are needed. Where SPECULAR is on, SPEC_NORMAL widens
// the highlight by how much this normal varies over a pixel.
export const MICRO_HEAD = /* glsl */ `
vec3 gBumpW = vec3(0.0);
`;
export const MICRO_NORMAL = /* glsl */ `
  {
    vec3 gV = mat3(viewMatrix) * gBumpW;
    normal = normalize(normal - (gV - dot(gV, normal) * normal));
  }
`;

// Micro-detail for surfaces whose frame the fragment does not know (kit
// instances turn by yaw): Mikkelsen 2010, "Bump Mapping Unparametrized
// Surfaces on the GPU" (three's perturbNormalArb), but with the position
// derivatives left unnormalised, so dHdxy in metres per pixel gives the true
// slope. The caller passes derivatives it took where control flow is uniform.
export const MICRO_ARB = /* glsl */ `
vec3 microPerturb(vec3 n, vec3 dPdx, vec3 dPdy, vec2 dHdxy, float faceDir) {
  vec3 r1 = cross(dPdy, n);
  vec3 r2 = cross(n, dPdx);
  float det = dot(dPdx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

// Specular (docs/design/micro-detail.md §6), High only, behind the SPECULAR
// define. Lambert stays the diffuse model; pattern code sets a gloss
// (gSpecK, 0 = none, and the term is skipped), a perceptual roughness and F0
// for what it drew, and these chunks add two lobes on top:
//  - the sun (or moon): GGX with Schlick Fresnel and Kelemen visibility,
//    inside three's own light loop (RE_Direct), so it is shadowed exactly
//    as the diffuse is;
//  - the sky: the grade's sky gradient (ground below the horizon) in the
//    reflected direction, weighted by Karis's analytic environment BRDF.
// Specular aliasing: the roughness widens by the variance of the shading
// normal over the pixel (Kaplanyan and Hoffman 2016), which tames the
// micro-detail relief, and pattern code band-limits its gloss masks.
// The host declares uSkyHorizon and uSkyZenith.
export const SPEC_HEAD = /* glsl */ `
uniform vec3 uSkyGround;
float gSpecK = 0.0;
float gSpecRough = 0.5;
float gSpecF0 = 0.02;
// Tilt of the specular normal only, along the surface's horizontal and
// vertical tangents (glass panes that are not quite flat).
vec2 gSpecTilt = vec2(0.0);
// 1: the sun lobe sees the sun mirrored in the horizon. The camera is always
// above a window, and vertical glass seen from above mirrors the ground, so
// a true sun glint never reaches it; this is the toy-like stand-in, as if
// each pane leant out a little (glass; the value scales the lobe, so it
// fades out at high sun).
float gSpecMirror = 0.0;
vec3 gSpecN = vec3(0.0, 0.0, 1.0);
float gSpecA2 = 0.25;
vec3 gSpecSun = vec3(0.0);
`;
export const SPEC_PARS = /* glsl */ `
void RE_Direct_Spec(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  RE_Direct_Lambert(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  if (gSpecK > 0.0) {
    vec3 l = directLight.direction;
    if (gSpecMirror > 0.0) {
      vec3 upV = mat3(viewMatrix)[1];
      l -= 2.0 * dot(l, upV) * upV;
    }
    vec3 h = normalize(l + geometryViewDir);
    float nh = saturate(dot(gSpecN, h));
    float lh = saturate(dot(l, h));
    float nl = saturate(dot(gSpecN, l));
    float d = nh * nh * (gSpecA2 - 1.0) + 1.0;
    float F = gSpecF0 + (1.0 - gSpecF0) * pow(1.0 - lh, 5.0);
    // Capped, so a sharp lobe reads as a glint rather than a flare.
    gSpecSun += directLight.color * (gSpecMirror > 0.0 ? gSpecMirror : 1.0) * min(nl * gSpecA2 / (PI * d * d) * F / (4.0 * max(lh * lh, 0.05)), 6.0);
  }
}
#undef RE_Direct
#define RE_Direct RE_Direct_Spec
`;
// After MICRO_NORMAL: the filtered roughness and the specular normal.
export const SPEC_NORMAL = /* glsl */ `
  {
    vec3 nDx = dFdx(normal), nDy = dFdy(normal);
    float a = gSpecRough * gSpecRough;
    gSpecA2 = clamp(a * a + min(0.5 * (dot(nDx, nDx) + dot(nDy, nDy)), 0.18), 2e-4, 1.0);
    gSpecN = normal;
    if (gSpecTilt != vec2(0.0)) {
      vec3 upV = mat3(viewMatrix)[1];
      gSpecN = normalize(normal + gSpecTilt.x * normalize(cross(upV, normal)) + gSpecTilt.y * upV);
    }
  }
`;
export const SPEC_END = /* glsl */ `
  if (gSpecK > 0.0) {
    vec3 sR = reflect(-geometryViewDir, gSpecN) * mat3(viewMatrix);
    float sNV = saturate(dot(gSpecN, geometryViewDir));
    vec3 sEnv = mix(uSkyGround * 0.8, uSkyHorizon, smoothstep(-0.35, 0.05, sR.y));
    sEnv = mix(sEnv, uSkyZenith, smoothstep(0.15, 0.7, sR.y));
    // Rain cloud greys the sky.
    sEnv = mix(sEnv, vec3(dot(sEnv, vec3(0.3, 0.55, 0.15))), 0.5 * uWet);
    // Karis 2014, the mobile analytic fit of the split-sum environment BRDF.
    vec4 sr = gSpecRough * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
    float a004 = min(sr.x * sr.x, exp2(-9.28 * sNV)) * sr.x + sr.y;
    vec2 AB = vec2(-1.04, 1.04) * a004 + sr.zw;
    totalEmissiveRadiance += (sEnv * (gSpecF0 * AB.x + AB.y) + gSpecSun) * gSpecK;
  }
`;

/** Deterministic 0..1 hash of an integer id (instance jitter, never Math.random). */
export function hashId(id, salt = 0) {
  let h = (id * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Convert an indexed geometry to flat-shaded, non-indexed geometry. */
export function flatten(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute?.('normal');
  g.computeVertexNormals();
  return g;
}

export const LAYER_REFLECT = 1;

/** Shared scratch objects; never hold references across calls. */
export const scratch = {
  v3a: new THREE.Vector3(),
  v3b: new THREE.Vector3(),
  v3c: new THREE.Vector3(),
  m4: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  color: new THREE.Color(),
};
