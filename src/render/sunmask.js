import * as THREE from 'three';

// The sun's shadow map as part of the ground-shadow mask. Tree shadows
// (decals.js) and people's blobs (people.js) are a mask, not a stack: their
// MIN passes keep, in the frame's alpha, the lowest light factor at each
// pixel, and one apply multiplies it in. The shadow map's shade (buildings,
// and trees with 'detailed' shadows) is lighting, already in the ground's
// colour; so each blob or tree-shadow fragment looks the map up at its own
// ground point and asks only for the darkening beyond it:
//   factor = min(1, light / mapLight)
// which, after the multiply, leaves the darker of the two, never both. Per
// fragment and exact, so nothing pops as the map refreshes. Only blob and
// tree-shadow pixels pay for the four taps.

export const SUN_MASK_GLSL = /* glsl */ `
uniform sampler2D uSunMap;
uniform mat4 uSunMatrix;
uniform vec4 uSunMapInfo; // map size in texels, depth bias, 1 when the map is usable, shade depth
// Sun visibility at world point wp: 0 in shade, 1 in sun, bilinear between
// the four nearest texels (three's texture2DCompare on unpackRGBAToDepth).
float sunLitAt(vec3 wp) {
  vec4 c = uSunMatrix * vec4(wp, 1.0);
  vec3 sc = c.xyz / c.w;
  sc.z += uSunMapInfo.y;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float size = uSunMapInfo.x;
  vec2 px = sc.xy * size - 0.5;
  vec2 f = fract(px);
  vec2 uv = (floor(px) + 0.5) / size;
  float t = 1.0 / size;
  float a = step(sc.z, unpackRGBAToDepth(texture2D(uSunMap, uv)));
  float b = step(sc.z, unpackRGBAToDepth(texture2D(uSunMap, uv + vec2(t, 0.0))));
  float e = step(sc.z, unpackRGBAToDepth(texture2D(uSunMap, uv + vec2(0.0, t))));
  float g = step(sc.z, unpackRGBAToDepth(texture2D(uSunMap, uv + vec2(t, t))));
  return mix(mix(a, b, f.x), mix(e, g, f.x), f.y);
}
// The light factor the shadow map already gives the ground at wp (1 in sun),
// sampled a little up and toward the sun, clear of the ground's own depth.
float mapLight(vec3 wp, vec3 sunDir) {
  if (uSunMapInfo.z < 0.5 || uSunMapInfo.w < 0.001) return 1.0;
  return 1.0 - uSunMapInfo.w * (1.0 - sunLitAt(wp + vec3(0.0, 0.25, 0.0) + sunDir * 0.3));
}
// A mask fragment's light factor with the map's shade taken out.
float maskOverMap(float light, vec3 wp, vec3 sunDir) {
  return min(1.0, light / max(mapLight(wp, sunDir), 0.05));
}
`;

// Ground light factor in full shadow-map shade: about the sky-lit share
// (people.js SHADE_DEPTH), times the sun's share of the light now.
const SHADE_DEPTH = 0.66;

export function createSunMask(lights, renderer) {
  const uniforms = {
    uSunMap: { value: null },
    uSunMatrix: { value: lights.sun.shadow.matrix },
    uSunMapInfo: { value: new THREE.Vector4(1, 0, 0, 0) },
  };
  /** Every frame: the map (recreated on a tier change) and how deep its shade is. */
  function update(grade) {
    const shadow = lights.sun.shadow;
    const map = lights.sun.castShadow && renderer?.shadowMap?.enabled ? shadow.map?.texture ?? null : null;
    uniforms.uSunMap.value = map;
    uniforms.uSunMatrix.value = shadow.matrix;
    const sunY = grade.uniforms.uSunDir.value.y;
    const share = Math.min(1, (grade.current?.sunI ?? 2.8) / 2.3) * THREE.MathUtils.smoothstep(sunY, 0.02, 0.2);
    uniforms.uSunMapInfo.value.set(shadow.mapSize.x, shadow.bias, map ? 1 : 0, SHADE_DEPTH * share);
  }
  return { uniforms, update };
}
