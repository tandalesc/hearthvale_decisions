import * as THREE from 'three';
import { NOISE, GRADE_HEAD } from './shaderlib.js';
import { GROUND_GLSL } from './ground.js';

// Valley mist (High tier): three faint translucent sheets draped over the
// ground round the view, 0.5-2.5 m above it, that gather over water and the low
// valley floor and fade on rising ground. Soft noise drifts with the wind, so
// the mist moves in slow banks. It lies thickest at dawn, on autumn days,
// under rain cloud and on winter nights, and burns off by a summer noon.
// One draw call; the sheets follow the view in whole grid steps, so the
// mist never swims under a still camera.

const N = 72;          // vertices per side of a sheet
const SPAN = 300;      // metres
const STEP = SPAN / (N - 1);
// Several faint layers rather than one thick sheet: where a wall or trunk
// passes through them the mist builds up gradually instead of in a band.
const LAYERS = [0.55, 1.4, 2.3];

function sheetGeometry() {
  const pos = [], layer = [], idx = [];
  LAYERS.forEach((h, l) => {
    const o = (pos.length / 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        pos.push((i / (N - 1) - 0.5) * SPAN, h, (j / (N - 1) - 0.5) * SPAN);
        layer.push(l);
      }
    }
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = o + j * N + i;
        idx.push(a, a + N, a + 1, a + 1, a + N, a + N + 1);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  g.setIndex(idx);
  return g;
}

const VERT = GRADE_HEAD + GROUND_GLSL + /* glsl */ `
attribute float aLayer;
uniform vec2 uMistCentre;
varying vec3 vMistW;
varying float vMistLow;
varying float vMistLayer;
void main() {
  vec2 xz = position.xz + uMistCentre;
  vec4 gt = groundBilinear(xz);
  float shore = gt.b;
  // Over water the bed is below the surface: lift the sheet clear of it.
  float y = gt.r + position.y + (shore < 0.0 ? 1.2 : 0.0);
  // Mist pools by the water and on the low valley floor, not on the hills.
  float nearWater = 1.0 - smoothstep(4.0, 45.0, shore);
  float low = 1.0 - smoothstep(1.5, 6.0, gt.r);
  vMistLow = max(nearWater, low * 0.3) * (1.0 - smoothstep(5.0, 12.0, gt.r));
  // Fade the sheet out toward its rim.
  vec2 rel = position.xz / (${SPAN.toFixed(1)} * 0.5);
  vMistLow *= 1.0 - smoothstep(0.6, 0.98, max(abs(rel.x), abs(rel.y)));
  vMistW = vec3(xz.x, y, xz.y);
  vMistLayer = aLayer;
  gl_Position = projectionMatrix * viewMatrix * vec4(vMistW, 1.0);
}
`;

const FRAG = GRADE_HEAD + NOISE + /* glsl */ `
uniform float uMist;
uniform vec3 uSunColor;
uniform vec3 uFogTint;
uniform vec3 uSkyHorizon;
varying vec3 vMistW;
varying float vMistLow;
varying float vMistLayer;
void main() {
  if (vMistLow * uMist < 0.01) discard;
  // Banks drifting with the wind, with finer wisps inside them.
  vec2 drift = uWind * uDecoTime * 0.6;
  vec2 p = vMistW.xz + drift + vMistLayer * 37.0;
  float bank = vnoise(p * 0.018) * 0.65 + vnoise(p * 0.047 + 5.0) * 0.35;
  float wisp = vnoise(p * 0.13 - drift * 0.5);
  float a = smoothstep(0.35, 0.8, bank) * (0.75 + 0.25 * wisp) * vMistLow * uMist;
  // Densest at the bottom, thinning upward.
  a *= 0.26 * (1.0 - vMistLayer * 0.25);
  // Thin out right under the camera so the view never fills with grey.
  a *= smoothstep(6.0, 40.0, distance(vMistW, cameraPosition));
  if (a < 0.004) discard;
  // Lit by the low sun and the sky; dimmer at night.
  vec3 col = mix(uFogTint, uSkyHorizon, 0.4) + uSunColor * 0.12 * (1.0 - uNight);
  col *= 1.0 - 0.55 * uNight;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createMist(ctx) {
  const { scene, grade } = ctx;
  const uniforms = {
    ...grade.uniforms,
    uMist: { value: 0 },
    uMistCentre: { value: new THREE.Vector2() },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(sheetGeometry(), material);
  mesh.name = 'mist';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;
  scene.add(mesh);
  let enabled = false;
  let amount = 0;

  /** How misty the air is now: dawn, autumn, damp, cold nights. */
  function target() {
    const c = grade.current;
    const u = grade.uniforms;
    const ph = c.phase ?? 0.5;
    const dawn = Math.max(0, 1 - Math.abs(ph - 0.27) / 0.09);
    const morning = Math.max(0, 1 - Math.abs(ph - 0.33) / 0.12);
    return Math.min(0.95,
      dawn * 0.85 + morning * 0.25
      + u.uAutumn.value * 0.4
      + u.uWet.value * 0.35
      + u.uNight.value * 0.3
      + u.uSnow.value * 0.15);
  }

  return {
    update(view, frame) {
      if (!enabled) return;
      const want = target();
      amount += (want - amount) * Math.min(1, (frame.dt ?? 0.016) / 2);
      // Mist is a close-up effect: thinned as the camera rises.
      const far = THREE.MathUtils.smoothstep(frame.distance ?? 100, 180, 320);
      uniforms.uMist.value = amount * (1 - far);
      mesh.visible = uniforms.uMist.value > 0.01;
      if (!mesh.visible) return;
      const t = frame.target;
      uniforms.uMistCentre.value.set(Math.round(t.x / STEP) * STEP, Math.round(t.z / STEP) * STEP);
    },
    applyQuality(q) {
      enabled = !!q.mist;
      if (!enabled) mesh.visible = false;
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
