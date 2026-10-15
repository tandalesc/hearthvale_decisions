import * as THREE from 'three';
import { heightAt, riverX, WATER_HALF } from '../terrain.js';
import { LAYER_REFLECT } from './shaderlib.js';
import { waterLevel } from './ground.js';
import { HAZE_GLSL } from './terrain.js';

// River water (design-visual §2): a ribbon that follows riverX(z) at the
// river's surface level (descending from the mountains where the terrain
// does), a generated tileable normal map, one ShaderMaterial for all tiers,
// and an optional planar reflection on the high tier (flat reaches only).
// Steep reaches run as rapids: choppier ripples and white streaks.

export const WATER_Y = 0.025;
const Z_MIN = -950;
const Z_MAX = 950;
const Z_STEP = 2;
// Across-river offsets (metres from the centreline) for the seeded channel
// half-width H. The outer lanes sit just under the bank so the edge is hidden
// by terrain and fades by depth.
function laneOffsets() {
  const H = WATER_HALF;
  const bed = H - 1.6;
  const half = [0, bed * 0.25, bed * 0.5, bed * 0.75, bed, bed + 0.4, bed + 0.8, bed + 1.2, H, H + 0.4];
  return [...half.slice(1).reverse().map((u) => -u), ...half];
}

/** Ribbon geometry with depth, flow tangent and across/along coordinates. */
export function buildRiverRibbon({ zMin = Z_MIN, zMax = Z_MAX, step = Z_STEP } = {}) {
  const rows = Math.floor((zMax - zMin) / step) + 1;
  const LANES = laneOffsets();
  const n = LANES.length;
  const pos = new Float32Array(rows * n * 3);
  const uv = new Float32Array(rows * n * 2);
  const depth = new Float32Array(rows * n);
  const flow = new Float32Array(rows * n * 2);
  const bank = new Float32Array(rows * n);
  const reach = new Float32Array(rows * n * 2);
  const index = [];
  for (let r = 0; r < rows; r++) {
    const z = zMin + r * step;
    const cx = riverX(z);
    // Tangent of the centreline: d(riverX)/dz.
    const dx = riverX(z + 0.5) - riverX(z - 0.5);
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
      depth[i] = Math.max(0, level - heightAt(x, z));
      reach[i * 2] = drop; reach[i * 2 + 1] = flat;
      flow[i * 2] = dx / len; flow[i * 2 + 1] = 1 / len;
      bank[i] = Math.max(0, WATER_HALF - Math.abs(u));
      if (r > 0 && l > 0) {
        const p = i - n;
        index.push(p - 1, i - 1, i, p - 1, i, p);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
  g.setAttribute('aBank', new THREE.BufferAttribute(bank, 1));
  g.setAttribute('aReach', new THREE.BufferAttribute(reach, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
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
attribute vec2 aReach;
varying vec2 vReach;
attribute vec2 aFlow;
attribute float aBank;
varying vec3 vWorld;
varying float vDepth;
varying float vBank;
varying vec2 vUv;
varying vec2 vFlow;
varying vec4 vReflectUv;
void main() {
  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  #include <defaultnormal_vertex>
  vec3 transformed = position;
  // Two low-frequency swells, tiny, only to move the silhouette mid-river.
  transformed.y += 0.012 * sin(position.x * 1.7 + uTime * 1.3) * sin(position.z * 1.1 + uTime * 0.9) * smoothstep(0.0, 0.25, aDepth);
  #include <project_vertex>
  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  vWorld = worldPosition.xyz;
  vDepth = aDepth;
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
// Embanked runs: (side -1 west / +1 east, z0, z1, unused); side 0 = empty.
uniform vec4 uEmbank[16];
float embanked(vec2 uvAcross) {
  float e = 0.0;
  for (int i = 0; i < 16; i++) {
    vec4 r = uEmbank[i];
    if (r.x == 0.0) break;
    float onSide = step(0.0, uvAcross.x * r.x);
    float inRun = step(r.y, uvAcross.y) * step(uvAcross.y, r.z);
    e = max(e, onSide * inRun);
  }
  return e;
}
varying vec3 vWorld;
varying float vDepth;
varying float vBank;
varying vec2 vUv;
varying vec2 vFlow;
varying vec4 vReflectUv;
varying vec2 vReach;

// Tile stores slopes (dh/dx, dh/dz) in RG; build a normal from them.
vec2 slope(vec2 uv) { return texture2D(tNormals, uv).rg * 2.0 - 1.0; }

void main() {
  // Flow-aligned coordinates: x across (metres), y along the river (metres).
  vec2 base = vec2(vUv.x, vUv.y);
  vec2 s = slope(base * 0.085 + vec2(0.0, uTime * 0.05));
  #if WATER_TIER > 0
    // Second octave scrolls slower and sideways so the pattern never repeats visibly.
    s += 0.7 * slope(base * vec2(0.19, 0.16) + vec2(uTime * 0.011, uTime * 0.026) + 0.37);
  #endif
  // Fords: shallow water mid-channel (not the bank shallows) runs as riffles;
  // steep reaches coming down from the hills run as rapids.
  float riffle = (1.0 - smoothstep(0.28, 0.46, vDepth)) * smoothstep(0.8, 2.0, vBank);
  riffle = max(riffle, smoothstep(0.02, 0.12, vReach.x) * smoothstep(0.3, 1.5, vBank));
  // Strength: small slopes read as gentle ripples, calmer at the banks,
  // choppier over a ford.
  float calm = smoothstep(0.0, 0.35, vDepth) * (1.0 + 1.6 * riffle) + riffle * 0.5;
  vec3 n = normalize(vec3(-s.x * 0.22 * calm, 1.0, -s.y * 0.22 * calm));

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

  // Body colour: sandy shallows to deep teal, by analytic depth.
  vec3 shallow = vec3(0.15, 0.22, 0.15);
  vec3 deep = vec3(0.018, 0.075, 0.08);
  // Fords take the colour of moderately deep water: shallow, but still river.
  vec3 body = mix(shallow, deep, smoothstep(0.05, 0.75, max(vDepth, riffle * 0.5)));
  // Light scattering: shallow water picks up some sunlight.
  body *= 0.55 + 0.45 * uSunColor * (1.0 - uNight * 0.7);
  float shadow = 1.0;
  #if WATER_TIER > 0
    shadow = getShadowMask();
    body *= 0.55 + 0.45 * shadow;
  #endif

  // Sun glitter: Blinn-Phong with a sharp and a broad lobe.
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(n, H), 0.0);
  // The sharp lobe is masked by ripple crests so it breaks into sparkles.
  float crest = smoothstep(0.55, 0.95, length(s) * 0.6);
  float spec = pow(NoH, 420.0) * 1.6 * crest + pow(NoH, 60.0) * 0.05;
  spec *= shadow * (1.0 + uWet * 0.6) * smoothstep(0.0, 0.1, uSunDir.y);

  vec3 col = mix(body, reflCol, clamp(fresnel + 0.05, 0.0, 1.0));
  col += uSunColor * spec;

  float alpha = mix(0.0, 0.94, smoothstep(0.0, 0.42, vDepth));
  // A ford is shallow but still a river: keep it mostly opaque and green so
  // the pale bed never reads as a translucent slab.
  alpha = max(alpha, riffle * 0.86);
  col = mix(col, col * vec3(0.9, 1.04, 1.0), riffle * 0.5);
  #if WATER_TIER > 0
    // Shoreline foam: a broken band near the waterline, drifting with the flow.
    float band = 1.0 - smoothstep(0.0, 0.12, abs(vDepth - 0.09));
    float fn = texture2D(tNormals, base * 0.06 + vec2(0.0, uTime * 0.07)).b;
    float fn2 = texture2D(tNormals, base * 0.11 - vec2(uTime * 0.01, uTime * 0.04)).b;
    float foam = band * smoothstep(0.5, 0.78, fn * 0.6 + fn2 * 0.4) * (1.0 - uSnow * 0.7);
    // Against a dressed stone wall the water barely froths.
    foam *= 1.0 - 0.85 * embanked(vec2(vUv.x, vUv.y));
    // Riffle streaks: white water stretched along the flow over a ford.
    // Streaks run along the flow (fine across, long along) and are broken up
    // by a second, slower octave so they never line up into bands.
    float rn = texture2D(tNormals, base * vec2(0.55, 0.07) + vec2(0.0, uTime * 0.3)).b;
    float rn2 = texture2D(tNormals, base * vec2(0.19, 0.11) - vec2(0.13, uTime * 0.08)).b;
    // Thin broken streaks only: fords should glint, not read as painted bands.
    float rapids = riffle * smoothstep(0.7, 0.9, rn * 0.65 + rn2 * 0.35) * (1.0 - uSnow * 0.6);
    foam = max(foam, rapids * 0.22);
    // Foam stays a soft, broken trim rather than a painted white line.
    col = mix(col, vec3(0.82, 0.87, 0.84), foam * 0.45);
    alpha = max(alpha, foam * 0.5);
  #endif
  // Winter: a pale ice rim along the banks.
  float ice = uSnow * (1.0 - smoothstep(0.03, 0.22, vDepth));
  col = mix(col, vec3(0.80, 0.86, 0.88), ice * 0.8);
  alpha = max(alpha, ice * 0.9);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
${HAZE_GLSL}
}
`;

export function createWater({ renderer, scene, grade, quality }) {
  const geometry = buildRiverRibbon();
  const normals = buildNormalTile();
  const reflectMatrix = new THREE.Matrix4();
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]);
  Object.assign(uniforms, grade.uniforms, {
    tNormals: { value: normals },
    tReflect: { value: null },
    uReflectMatrix: { value: reflectMatrix },
    uReflectMix: { value: 0.72 },
    uBankColor: { value: new THREE.Color('#4f6a3a') },
    uEmbank: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
  });
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

  const reflection = createPlanarReflection(renderer);
  let tier = null;
  let frame = 0;
  const bankLinear = new THREE.Color();
  const bankBase = new THREE.Color('#5c7a40');

  function applyQuality(q) {
    if (tier === q.water) return;
    tier = q.water;
    material.defines.WATER_TIER = tier === 'low' ? 0 : 1;
    if (tier === 'high') {
      material.defines.PLANAR = 1;
      uniforms.tReflect.value = reflection.texture();
    } else {
      delete material.defines.PLANAR;
      reflection.dispose();
    }
    mesh.receiveShadow = tier !== 'low';
    material.needsUpdate = true;
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
    const slots = uniforms.uEmbank.value;
    for (let i = 0; i < slots.length; i++) {
      const r = list?.[i];
      if (r) slots[i].set(r.side === 'west' ? -1 : 1, r.z0, r.z1, 0);
      else slots[i].set(0, 0, 0, 0);
    }
  }

  return { mesh, material, applyQuality, beforeRender, setEmbankments, dispose: () => reflection.dispose() };
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
