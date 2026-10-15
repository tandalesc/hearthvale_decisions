import * as THREE from 'three';
import { hashId } from './shaderlib.js';

// Particles (design-visual §7): chimney smoke, construction dust and the
// seasonal / weather layer. Three instanced quad meshes, all motion in the
// vertex shader. The CPU only writes instance data when chimneys change
// (smoke), when a dust event arrives (ring buffer) or never (ambient).

const SMOKE_LIFE = 6.0;
const PUFFS = 6;
const SMOKE_CELL = 24;     // metres
const SMOKE_PER_CELL = 3;  // chimneys smoking per cell, nearest first
const DUST_EVENTS = 48;
const DUST_PUFFS = 12;
const AMBIENT_MAX = 1500;
const AMBIENT_BOX = 160;

// Shared GLSL: a camera-facing quad offset in view space.
const BILLBOARD = /* glsl */ `
vec4 billboard(vec3 world, vec2 corner, vec2 size) {
  vec4 mv = viewMatrix * vec4(world, 1.0);
  mv.xy += corner * size;
  return mv;
}
`;

// Lit smoke/dust colour: sun and sky light, much darker at night.
const LIT = /* glsl */ `
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform float uNight;
vec3 litColor(vec3 albedo) {
  vec3 light = uSunColor * 0.55 + uSkyHorizon * 0.55;
  return albedo * light * (1.0 - 0.7 * uNight);
}
`;

const SMOKE_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aOrigin;   // xyz chimney top, w tone (0 pale wood smoke, 1 dark fire smoke)
attribute vec4 aInfo;     // phase, amount, seed, scale
uniform float uTime;
uniform vec2 uWind;
uniform float uSnow;
uniform float uAutumn;
varying vec2 vUv;
varying float vAlpha;
varying float vTone;
varying float vSeed;
${BILLBOARD}
void main() {
  // Age 0..1 along a looping life; each puff of a chimney is phase-shifted.
  float t = fract(uTime / ${SMOKE_LIFE.toFixed(1)} + aInfo.x);
  // Some hearths are lit even in summer (cooking); in the cold every
  // chimney smokes and winter fires burn harder.
  float hearth = step(aInfo.z, 0.18) * 0.25 + step(aInfo.z, 0.5) * (0.25 * uSnow + 0.08 * uAutumn);
  float amount = max(aInfo.y, hearth) * (0.6 + 0.3 * uSnow + 0.1 * uAutumn);
  vec3 p = aOrigin.xyz;
  // Rise slows as the puff cools; wind bends the column quadratically.
  p.y += (1.0 - (1.0 - t) * (1.0 - t)) * (3.6 + 1.6 * aInfo.z) * aInfo.w;
  p.xz += uWind * (t * t * 4.0) * aInfo.w;
  p.xz += vec2(sin(t * 5.0 + aInfo.z * 20.0), cos(t * 4.0 + aInfo.z * 13.0)) * 0.18 * t;
  float size = (0.55 + t * 2.3) * aInfo.w;
  vec4 mvPosition = billboard(p, position.xy, vec2(size));
  gl_Position = projectionMatrix * mvPosition;
  // Lit hearths read clearly (alpha ~0.3-0.75); cold chimneys stay clear.
  // Kept gentle: a town of thousands of chimneys must not look like a fog bank.
  float strength = step(0.04, amount) * (0.28 + 0.34 * clamp(amount * 1.6, 0.0, 1.0));
  vAlpha = smoothstep(0.0, 0.12, t) * (1.0 - t) * strength;
  vUv = position.xy + 0.5;
  vTone = aOrigin.w;
  vSeed = aInfo.z;
  #include <fog_vertex>
}
`;

const PUFF_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
${LIT}
uniform vec3 uAlbedo;
uniform vec3 uDark;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
varying float vTone;
varying float vSeed;
void main() {
  // A soft cloudlet: two overlapping round blobs offset by the puff's seed,
  // so puffs read as little clouds rather than discs.
  vec2 c = vUv - 0.5;
  vec2 off = vec2(cos(vSeed * 40.0), sin(vSeed * 40.0)) * 0.16;
  float b1 = 1.0 - smoothstep(0.1, 0.42, length(c - off * 0.5));
  float b2 = 1.0 - smoothstep(0.05, 0.3, length(c + off));
  float a = max(b1, b2 * 0.85) * vAlpha * uOpacity;
  if (a < 0.01) discard;
  // Lighter on top, as if lit from above.
  vec3 albedo = mix(uAlbedo, uDark, vTone) * (0.8 + 0.3 * vUv.y);
  gl_FragColor = vec4(litColor(albedo), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const DUST_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aOrigin;  // xyz, birth time
attribute vec4 aInfo;    // dir x, dir z, size, seed
uniform float uTime;
varying vec2 vUv;
varying float vAlpha;
varying float vTone;
varying float vSeed;
${BILLBOARD}
void main() {
  float age = (uTime - aOrigin.w) / 1.8;
  float alive = step(0.0, age) * step(age, 1.0);
  age = clamp(age, 0.0, 1.0);
  // Burst outward fast, then drift up and settle.
  float burst = 1.0 - pow(1.0 - age, 3.0);
  vec3 p = aOrigin.xyz;
  p.xz += aInfo.xy * aInfo.z * 0.55 * burst;
  p.y += age * 1.3 + 0.3;
  float size = (0.5 + age * 1.6) * (0.35 + aInfo.z * 0.09) * alive;
  vec4 mvPosition = billboard(p, position.xy, vec2(size));
  gl_Position = projectionMatrix * mvPosition;
  vAlpha = pow(1.0 - age, 2.0) * 0.7 * alive;
  vUv = position.xy + 0.5;
  vTone = 0.0;
  vSeed = aInfo.w;
  #include <fog_vertex>
}
`;

// Ambient weather: world-anchored particles in a box that wraps around the
// camera target and scales with the zoom (side ~1.3x the camera distance),
// so coverage is uniform wherever you look and the on-screen density stays
// the same when zooming out. Particles fade at the box's rim, near the
// camera and with the eased intensity, so nothing ever pops. Motion uses its
// own clock (uPTime), which stops while the game is paused.
const AMBIENT_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed;
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uCenter;
uniform float uScale;
uniform float uBox;        // box side (m)
uniform float uFallH;      // fall height (m)
uniform float uPTime;      // particle clock: frozen while paused
uniform float uCount;      // live particle fraction (quality)
uniform vec4 uModes;       // rain, snow, leaves, pollen intensities 0..1
uniform float uFireflies;
varying vec2 vUv;
varying float vAlpha;
varying float vMode;       // 0 rain, 1 snow, 2 leaf, 3 pollen/blossom, 4 firefly
varying float vSeed;
${BILLBOARD}

// Wrap a world coordinate into the box centred on c (period = box size).
float wrapTo(float v, float c) {
  return c + (fract((v - c) / uBox + 0.5) - 0.5) * uBox;
}

void main() {
  float total = uModes.x + uModes.y + uModes.z + uModes.w + uFireflies;
  // Pick a mode by the particle's seed against the cumulative weights.
  float pickV = aSeed.y * max(total, 1e-3);
  float mode = 4.0;
  if (pickV < uModes.x) mode = 0.0;
  else if (pickV < uModes.x + uModes.y) mode = 1.0;
  else if (pickV < uModes.x + uModes.y + uModes.z) mode = 2.0;
  else if (pickV < uModes.x + uModes.y + uModes.z + uModes.w) mode = 3.0;
  // Fewer live particles when the effect is light or the tier is low.
  float live = step(aSeed.w, min(total, 1.0) * uCount);

  float uTime = uPTime;     // local: every motion below runs on the particle clock
  vec2 base = aSeed.xz * uBox;
  vec3 p;
  vec2 size;
  float alpha = 1.0;
  // Per-particle random, independent of its box position.
  float s = fract(sin(dot(aSeed.xz, vec2(12.9898, 78.233))) * 43758.5453);
  if (mode < 0.5) {
    // Rain: fast vertical streaks, slanted by the wind.
    float fall = fract(uTime * 1.1 * 34.0 / uFallH + s * 7.0);
    p = vec3(base.x, uFallH * (1.0 - fall), base.y);
    p.xz += uWind * 4.0 * fall;
    // Thin, short, faint streaks: the wet grade does most of the work.
    size = vec2(0.026, 1.0) * uScale;
    alpha = 0.24;
  } else if (mode < 1.5) {
    // Snow: slow fall with a lazy sway.
    float fall = fract(uTime * 0.045 * 30.0 / uFallH + s * 5.0);
    p = vec3(base.x, uFallH * (1.0 - fall), base.y);
    p.x += sin(uTime * 0.7 + s * 40.0) * 1.2 + uWind.x * fall * 6.0;
    p.z += cos(uTime * 0.6 + s * 31.0) * 1.2 + uWind.y * fall * 6.0;
    size = vec2(0.18) * uScale;
    alpha = 0.7;
  } else if (mode < 2.5) {
    // Leaves: tumble down in loops, drifting with the wind.
    float fall = fract(uTime * 0.03 + s * 3.0);
    p = vec3(base.x, 14.0 * (1.0 - fall) + 0.2, base.y);
    p.x += sin(uTime * 1.3 + s * 50.0) * 1.6 + uWind.x * fall * 14.0;
    p.z += cos(uTime * 1.1 + s * 23.0) * 1.6 + uWind.y * fall * 14.0;
    // Flutter: the quad flattens as it spins edge-on.
    float spin = sin(uTime * (2.0 + s * 3.0) + s * 60.0);
    size = vec2(0.3, 0.3 * (0.25 + 0.75 * abs(spin))) * uScale;
  } else if (mode < 3.5) {
    // Pollen and blossom: tiny motes rising and drifting.
    float rise = fract(uTime * 0.02 + s * 9.0);
    p = vec3(base.x, 0.5 + rise * 9.0, base.y);
    p.x += sin(uTime * 0.5 + s * 70.0) * 2.0 + uWind.x * rise * 8.0;
    p.z += cos(uTime * 0.4 + s * 17.0) * 2.0 + uWind.y * rise * 8.0;
    size = vec2(0.13) * uScale;
    alpha = 0.85 * sin(rise * 3.1416);
  } else {
    // Fireflies: hover low and wander, blinking softly.
    p = vec3(base.x, 0.6 + 1.6 * fract(s * 13.0), base.y);
    p.x += sin(uTime * 0.35 + s * 80.0) * 2.5;
    p.z += cos(uTime * 0.3 + s * 41.0) * 2.5;
    p.y += sin(uTime * 0.9 + s * 11.0) * 0.4;
    size = vec2(0.5) * uScale;
    alpha = smoothstep(0.2, 0.9, sin(uTime * (1.2 + s) + s * 90.0) * 0.5 + 0.5);
  }
  p.x = wrapTo(p.x, uCenter.x);
  p.z = wrapTo(p.z, uCenter.z);
  p.y += uCenter.y;
  // A round volume: fade toward the rim so wrapping never shows an edge,
  // and fade out close to the camera so no flake fills the screen.
  float rim = length(p.xz - uCenter.xz) / (uBox * 0.5);
  alpha *= 1.0 - smoothstep(0.6, 0.95, rim);
  alpha *= smoothstep(3.0, 12.0, distance(p, cameraPosition));
  vec4 mvPosition;
  if (mode < 0.5) {
    // Rain streaks stay vertical in screen space: offset in world y.
    mvPosition = viewMatrix * vec4(p + vec3(0.0, position.y * size.y, 0.0), 1.0);
    mvPosition.x += position.x * size.x * 3.0;
  } else {
    mvPosition = billboard(p, position.xy, size);
  }
  gl_Position = projectionMatrix * mvPosition;
  // Dead particles are moved outside the clip volume.
  if (live < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAlpha = alpha * live;
  vUv = position.xy + 0.5;
  vMode = mode;
  vSeed = s;
  #include <fog_vertex>
}
`;

const AMBIENT_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
${LIT}
uniform float uAutumn;
uniform float uBlossom;
varying vec2 vUv;
varying float vAlpha;
varying float vMode;
varying float vSeed;
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;
  vec3 col;
  float a = vAlpha;
  if (vMode < 0.5) {
    // Faint streaks tinted toward the sky's horizon.
    col = mix(litColor(vec3(0.75, 0.80, 0.85)), uSkyHorizon, 0.4);
    a *= smoothstep(0.5, 0.2, abs(c.x)) * smoothstep(0.5, 0.3, abs(c.y));
  } else if (vMode < 1.5) {
    col = litColor(vec3(0.96, 0.97, 1.0)) + 0.08;
    a *= smoothstep(1.0, 0.5, d);
  } else if (vMode < 2.5) {
    // Autumn palette: ochre, rust, gold, brown.
    float k = fract(vSeed * 17.0);
    vec3 leaf = k < 0.25 ? vec3(0.58, 0.28, 0.05) : k < 0.5 ? vec3(0.48, 0.14, 0.03) : k < 0.75 ? vec3(0.70, 0.45, 0.07) : vec3(0.32, 0.20, 0.03);
    col = litColor(leaf);
    // Leaf shape: a pointed oval.
    a *= smoothstep(1.0, 0.85, length(c * vec2(2.0, 1.2)) * 1.6 + abs(c.x) * 0.6);
  } else if (vMode < 3.5) {
    vec3 mote = mix(vec3(0.95, 0.88, 0.45), vec3(0.97, 0.80, 0.86), uBlossom);
    col = litColor(mote) + mote * 0.15;
    a *= smoothstep(1.0, 0.2, d);
  } else {
    // Firefly: bright core with a soft halo (HDR so tone mapping blooms it).
    float core = smoothstep(0.35, 0.0, d);
    float halo = smoothstep(1.0, 0.0, d) * 0.35;
    col = vec3(0.85, 1.0, 0.45) * (1.5 + 3.0 * core);
    a *= core + halo;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function quadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function instanced(g, name, size, count) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

function puffMaterial(grade, vertexShader, albedo, dark, opacity) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(uniforms, grade.uniforms, {
    uAlbedo: { value: new THREE.Color(albedo) },
    uDark: { value: new THREE.Color(dark) },
    uOpacity: { value: opacity },
  });
  return new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader: PUFF_FRAG,
    transparent: true, depthWrite: false, fog: true,
  });
}

function makeMesh(geometry, material, renderOrder) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

export function createParticles(ctx) {
  const { scene, grade, buildings, quality, heightAt } = ctx;
  let tier = quality;

  // --- (a) Chimney smoke -------------------------------------------------
  const smokeCap = 600 * PUFFS;
  const smokeGeo = quadGeometry();
  const smokeOrigin = instanced(smokeGeo, 'aOrigin', 4, smokeCap);
  const smokeInfo = instanced(smokeGeo, 'aInfo', 4, smokeCap);
  smokeGeo.instanceCount = 0;
  const smoke = makeMesh(smokeGeo, puffMaterial(grade, SMOKE_VERT, '#d8d4cc', '#4a4642', 1), 6);
  scene.add(smoke);
  let smokeVersion = -1;
  let smokeHash = 0;
  let lastSmokeCheck = -10;
  const lastCentre = new THREE.Vector3(1e9, 0, 0);
  // Candidate chimneys, reused between rebuilds: [x, y, z, amount, tone, dist2]
  const candidates = [];
  let candidateCount = 0;
  const cellCounts = new Map();

  function pushCandidate(x, y, z, amount, tone, cx, cz) {
    if (candidateCount === candidates.length) candidates.push(new Float64Array(6));
    const c = candidates[candidateCount++];
    c[0] = x; c[1] = y; c[2] = z; c[3] = amount; c[4] = tone;
    c[5] = (x - cx) * (x - cx) + (z - cz) * (z - cz);
  }

  function chimneyHash(view) {
    let h = 7;
    for (const lot of buildings.lots.values()) {
      const s = lot.summary;
      if (!s) continue;
      h = Math.imul(h ^ (s.chimneys.length * 131 + Math.round((s.smoke ?? 0) * 10) + (s.built >= 1 ? 7 : 0)), 16777619);
    }
    for (const e of view?.worldEvents ?? []) if (e.kind === 'fire') h = Math.imul(h ^ Math.round(e.x * 7 + e.z * 13), 16777619);
    return h;
  }

  function rebuildSmoke(view, centre) {
    candidateCount = 0;
    for (const lot of buildings.lots.values()) {
      const s = lot.summary;
      if (!s || !s.chimneys.length || (s.built ?? 1) < 1) continue;
      for (const ch of s.chimneys) pushCandidate(ch[0], ch[1], ch[2], s.smoke ?? 0, 0, centre.x, centre.z);
    }
    // Fires: thick dark columns from a few points in the event radius.
    for (const e of view?.worldEvents ?? []) {
      if (e.kind !== 'fire') continue;
      for (let k = 0; k < 4; k++) {
        const a = hashId(k * 7 + 1, Math.round(e.x)) * Math.PI * 2;
        const r = (e.radius ?? 4) * 0.4 * hashId(k + 9, Math.round(e.z));
        const fx = e.x + Math.cos(a) * r, fz = e.z + Math.sin(a) * r;
        pushCandidate(fx, heightAt(fx, fz) + 1.5, fz, 1.2, 1, centre.x, centre.z);
      }
    }
    // Nearest chimneys first when over the cap (fires always win: tone 1).
    const used = candidates.slice(0, candidateCount);
    used.sort((a, b) => (b[4] - a[4]) || (a[5] - b[5]));
    const cap = Math.round(600 * Math.min(1, 0.4 + tier.particles * 0.6));
    const o = smokeOrigin.array;
    const info = smokeInfo.array;
    // At most a few chimneys smoke per 24 m cell (nearest first, fires exempt),
    // so a dense quarter reads as a few wisps instead of a fog bank.
    cellCounts.clear();
    let k = 0;
    let chosen = 0;
    for (let i = 0; i < used.length && chosen < cap; i++) {
      const c = used[i];
      if (c[4] < 0.5) {
        const cell = Math.floor(c[0] / SMOKE_CELL) * 4096 + Math.floor(c[2] / SMOKE_CELL);
        const m = cellCounts.get(cell) ?? 0;
        if (m >= SMOKE_PER_CELL) continue;
        cellCounts.set(cell, m + 1);
      }
      chosen++;
      const seed = hashId(Math.round(c[0] * 7.3 + c[2] * 13.1), 3);
      for (let p = 0; p < PUFFS; p++, k++) {
        o[k * 4] = c[0]; o[k * 4 + 1] = c[1]; o[k * 4 + 2] = c[2]; o[k * 4 + 3] = c[4];
        info[k * 4] = p / PUFFS + seed * 0.37;
        info[k * 4 + 1] = c[3];
        info[k * 4 + 2] = hashId(i * 4 + p, 5);
        info[k * 4 + 3] = c[4] > 0.5 ? 2.6 : 0.9 + seed * 0.3;
      }
    }
    smokeGeo.instanceCount = k;
    smokeOrigin.clearUpdateRanges();
    smokeInfo.clearUpdateRanges();
    smokeOrigin.needsUpdate = true;
    smokeInfo.needsUpdate = true;
    smoke.visible = k > 0;
  }

  // --- (b) Construction dust and demolition puffs -------------------------
  const dustCap = DUST_EVENTS * DUST_PUFFS;
  const dustGeo = quadGeometry();
  const dustOrigin = instanced(dustGeo, 'aOrigin', 4, dustCap);
  const dustInfo = instanced(dustGeo, 'aInfo', 4, dustCap);
  for (let i = 0; i < dustCap; i++) dustOrigin.array[i * 4 + 3] = -1e6; // long dead
  dustGeo.instanceCount = dustCap;
  const dust = makeMesh(dustGeo, puffMaterial(grade, DUST_VERT, '#cdbb98', '#cdbb98', 1), 6);
  scene.add(dust);
  let dustHead = 0;
  let lastDust = -1e6;

  function emitDust(e, time, heightAt) {
    const slot = dustHead;
    dustHead = (dustHead + 1) % DUST_EVENTS;
    const size = Math.min(14, Math.max(3, e.size ?? 6)) * (e.kind === 'complete' ? 0.6 : 1);
    const y = Math.max(0.05, heightAt(e.x, e.z));
    const o = dustOrigin.array;
    const info = dustInfo.array;
    for (let p = 0; p < DUST_PUFFS; p++) {
      const k = slot * DUST_PUFFS + p;
      const a = (p / DUST_PUFFS) * Math.PI * 2 + hashId(k, 1) * 0.6;
      o[k * 4] = e.x; o[k * 4 + 1] = y; o[k * 4 + 2] = e.z; o[k * 4 + 3] = time + hashId(k, 2) * 0.25;
      info[k * 4] = Math.cos(a); info[k * 4 + 1] = Math.sin(a); info[k * 4 + 2] = size * (0.6 + 0.5 * hashId(k, 3)); info[k * 4 + 3] = hashId(k, 4);
    }
    for (const attr of [dustOrigin, dustInfo]) {
      attr.addUpdateRange(slot * DUST_PUFFS * 4, DUST_PUFFS * 4);
      attr.needsUpdate = true;
    }
    lastDust = time;
  }

  // --- (c) Seasonal and weather layer ------------------------------------
  const ambGeo = quadGeometry();
  const seeds = new Float32Array(AMBIENT_MAX * 4);
  // aSeed: xz = position in the box (-0.5..0.5), y = mode pick, w = live fraction.
  for (let i = 0; i < AMBIENT_MAX; i++) {
    seeds[i * 4] = hashId(i, 21) - 0.5;
    seeds[i * 4 + 1] = hashId(i, 22);
    seeds[i * 4 + 2] = hashId(i, 23) - 0.5;
    seeds[i * 4 + 3] = hashId(i, 24);
  }
  ambGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  ambGeo.instanceCount = AMBIENT_MAX;
  const ambUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(ambUniforms, grade.uniforms, {
    uCenter: { value: new THREE.Vector3() },
    uScale: { value: 1 },
    uBox: { value: AMBIENT_BOX },
    uFallH: { value: 34 },
    uPTime: { value: 0 },
    uCount: { value: 1 },
    uModes: { value: new THREE.Vector4() },
    uFireflies: { value: 0 },
  });
  const ambient = makeMesh(ambGeo, new THREE.ShaderMaterial({
    uniforms: ambUniforms, vertexShader: AMBIENT_VERT, fragmentShader: AMBIENT_FRAG,
    transparent: true, depthWrite: false, fog: true,
  }), 7);
  scene.add(ambient);


  function updateAmbient(view, frame) {
    const u = grade.uniforms;
    const yearT = u.uYearT.value;
    // Intensities come from the grade's eased weather (never toggled).
    const eased = grade.weather ?? { rain: 0, snow: 0 };
    // Light drizzle is carried by the wet grade alone; streaks fade in with real rain.
    const rain = THREE.MathUtils.smoothstep(eased.rain, 0.15, 0.7);
    const snowFall = Math.max(eased.snow, u.uSnow.value > 0.3 ? (u.uSnow.value - 0.3) * 0.7 : 0) * (1 - rain);
    // Sparse seasonal motes: falling leaves in autumn, pollen and blossom in
    // spring, a little summer pollen, fireflies on summer nights.
    const leaves = u.uAutumn.value * 0.3 * (1 - rain) * (1 - snowFall);
    const springT = Math.max(0, 1 - Math.abs(yearT - 0.16) / 0.12);
    const summerT = Math.max(0, 1 - Math.abs(yearT - 0.4) / 0.14);
    const pollen = (springT * 0.25 + summerT * 0.06 + u.uBlossom.value * 0.15) * (1 - rain) * (1 - u.uNight.value);
    const fireflies = u.uNight.value * summerT * 0.5 * (1 - rain);
    // Motion pauses with the game (particles stay visible).
    if (!frame.paused) ambUniforms.uPTime.value += Math.min(frame.dt, 0.25);
    // Box scales with the zoom so the whole view is covered at any distance.
    ambUniforms.uBox.value = THREE.MathUtils.clamp(frame.distance * 1.3, 70, 520);
    ambUniforms.uFallH.value = THREE.MathUtils.clamp(frame.distance * 0.45, 24, 150);
    ambUniforms.uModes.value.set(rain, snowFall, leaves, pollen);
    ambUniforms.uFireflies.value = fireflies;
    ambUniforms.uCount.value = tier.particles;
    ambUniforms.uCenter.value.copy(frame.target);
    // Bigger flakes when far, so they still read at the default distance.
    ambUniforms.uScale.value = THREE.MathUtils.clamp(frame.distance / 55, 1, 2.6);
    // Reduced motion: the static wet/snow grade only.
    ambient.visible = !ctx.reducedMotion && rain + snowFall + leaves + pollen + fireflies > 0.01;
  }

  return {
    update(view, frame) {
      const time = frame.time;
      // Smoke: rebuild on topology change, or when chimneys/smoke differ (checked 1 Hz),
      // or when the camera target moved far (nearest-first selection).
      const v = buildings.version();
      const moved = lastCentre.distanceToSquared(frame.target) > 60 * 60;
      if (v !== smokeVersion || moved || time - lastSmokeCheck > 1) {
        lastSmokeCheck = time;
        const h = chimneyHash(view);
        if (v !== smokeVersion || moved || h !== smokeHash) {
          smokeVersion = v;
          smokeHash = h;
          lastCentre.copy(frame.target);
          rebuildSmoke(view, frame.target);
        }
      }
      // Thinner smoke from far away: many wisps overlap on screen when zoomed out.
      smoke.material.uniforms.uOpacity.value = 1 - 0.55 * THREE.MathUtils.smoothstep(frame.distance, 80, 260);
      for (const e of buildings.events) emitDust(e, time, heightAt);
      dust.visible = time - lastDust < 2.5;
      updateAmbient(view, frame);
    },
    applyQuality(q) {
      tier = q;
      smokeVersion = -1;
    },
    dispose() {
      for (const m of [smoke, dust, ambient]) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
      }
    },
  };
}
