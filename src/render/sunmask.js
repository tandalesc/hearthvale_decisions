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
// fragment and exact (the ground's own filter: sunLitAt), so nothing pops as
// the map refreshes and shade edges line up. Only blob and tree-shadow pixels
// pay for the taps.

export const SUN_MASK_GLSL = /* glsl */ `
uniform sampler2D uSunMap;
uniform mat4 uSunMatrix;
uniform vec4 uSunMapInfo;   // map size in texels, depth bias, 1 when the map is usable, shade depth
uniform vec3 uSunMapFilter; // filter (0 none, 1 PCF, 2 PCF soft), radius, normal bias
float sunCompare(vec2 uv, float z) {
  return step(z, unpackRGBAToDepth(texture2D(uSunMap, uv)));
}
// Sun visibility at world point wp (0 shade .. 1 sun), exactly as three's
// getShadow() lights the ground there (shadowmap_pars_fragment, r180): the same
// normal-biased point, depth bias and filter for the tier's shadow type, so the
// mask's idea of where the shade begins is the drawn one, edge for edge.
float sunLitAt(vec3 wp) {
  vec4 c = uSunMatrix * vec4(wp + vec3(0.0, uSunMapFilter.z, 0.0), 1.0);
  vec3 sc = c.xyz / c.w;
  sc.z += uSunMapInfo.y;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  vec2 texel = vec2(1.0 / uSunMapInfo.x);
  float z = sc.z;
  if (uSunMapFilter.x > 1.5) {
    // PCF soft: three's 3x3 bilinear-weighted kernel.
    float dx = texel.x, dy = texel.y;
    vec2 uv = sc.xy;
    vec2 f = fract(uv * uSunMapInfo.x + 0.5);
    uv -= f * texel;
    return (
      sunCompare(uv, z) + sunCompare(uv + vec2(dx, 0.0), z) + sunCompare(uv + vec2(0.0, dy), z) + sunCompare(uv + texel, z) +
      mix(sunCompare(uv + vec2(-dx, 0.0), z), sunCompare(uv + vec2(2.0 * dx, 0.0), z), f.x) +
      mix(sunCompare(uv + vec2(-dx, dy), z), sunCompare(uv + vec2(2.0 * dx, dy), z), f.x) +
      mix(sunCompare(uv + vec2(0.0, -dy), z), sunCompare(uv + vec2(0.0, 2.0 * dy), z), f.y) +
      mix(sunCompare(uv + vec2(dx, -dy), z), sunCompare(uv + vec2(dx, 2.0 * dy), z), f.y) +
      mix(mix(sunCompare(uv + vec2(-dx, -dy), z), sunCompare(uv + vec2(2.0 * dx, -dy), z), f.x),
          mix(sunCompare(uv + vec2(-dx, 2.0 * dy), z), sunCompare(uv + vec2(2.0 * dx, 2.0 * dy), z), f.x), f.y)
    ) * (1.0 / 9.0);
  }
  if (uSunMapFilter.x > 0.5) {
    // PCF: three's 17 taps at the shadow radius.
    vec2 d0 = -texel * uSunMapFilter.y, d1 = texel * uSunMapFilter.y, d2 = d0 * 0.5, d3 = d1 * 0.5;
    vec2 p = sc.xy;
    return (
      sunCompare(p + vec2(d0.x, d0.y), z) + sunCompare(p + vec2(0.0, d0.y), z) + sunCompare(p + vec2(d1.x, d0.y), z) +
      sunCompare(p + vec2(d2.x, d2.y), z) + sunCompare(p + vec2(0.0, d2.y), z) + sunCompare(p + vec2(d3.x, d2.y), z) +
      sunCompare(p + vec2(d0.x, 0.0), z) + sunCompare(p + vec2(d2.x, 0.0), z) + sunCompare(p, z) +
      sunCompare(p + vec2(d3.x, 0.0), z) + sunCompare(p + vec2(d1.x, 0.0), z) +
      sunCompare(p + vec2(d2.x, d3.y), z) + sunCompare(p + vec2(0.0, d3.y), z) + sunCompare(p + vec2(d3.x, d3.y), z) +
      sunCompare(p + vec2(d0.x, d1.y), z) + sunCompare(p + vec2(0.0, d1.y), z) + sunCompare(p + vec2(d1.x, d1.y), z)
    ) * (1.0 / 17.0);
  }
  return sunCompare(sc.xy, z);
}
// The light factor the shadow map already gives the ground at wp (1 in sun).
float mapLight(vec3 wp, vec3 sunDir) {
  if (uSunMapInfo.z < 0.5 || uSunMapInfo.w < 0.001) return 1.0;
  return 1.0 - uSunMapInfo.w * (1.0 - sunLitAt(wp));
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
    uSunMapFilter: { value: new THREE.Vector3(0, 1, 0) },
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
    // The renderer's shadow type and the light's radius and normal bias, so
    // the lookup filters exactly as the ground's shading does.
    const type = renderer?.shadowMap?.type;
    const filter = type === THREE.PCFSoftShadowMap ? 2 : type === THREE.PCFShadowMap ? 1 : 0;
    uniforms.uSunMapFilter.value.set(filter, shadow.radius, shadow.normalBias);
  }
  return { uniforms, update };
}
