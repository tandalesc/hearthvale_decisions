import * as THREE from 'three';

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
export const GRADE_HEAD = /* glsl */ `
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
