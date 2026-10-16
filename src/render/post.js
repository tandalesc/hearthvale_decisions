import * as THREE from 'three';
import { createSSAO, SSAO_COMPOSITE_GLSL } from './ssao.js';
import { aoDayFactor } from './occlusion.js';

// High-tier finishing pass (design-visual §3.6): the scene renders into an
// MSAA half-float target, then one full-screen triangle applies a faint
// tilt-shift (a vertical blur that grows toward the top and bottom edges, so
// the town reads like a model on a table) and a 1-2 % grain dither that stops
// banding in the sky and water. Tone mapping happens here, once.
// With quality.ao === 'ssao' the target also carries a depth texture and
// screen-space AO (ssao.js) is multiplied into the scene colour first, so the
// tilt-shift blurs it like everything else.

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D tScene;
#ifdef USE_AO
${SSAO_COMPOSITE_GLSL}
  #define TAP(o) (texture2D(tScene, vUv + (o)).rgb * texture2D(tAO, vUv + (o)).r)
#else
  #define TAP(o) texture2D(tScene, vUv + (o)).rgb
#endif
uniform vec2 uTexel;
uniform float uMaxBlur;
uniform float uFocusY;
uniform float uTime;
varying vec2 vUv;

void main() {
  // Blur radius: zero in the focus band (35 % of the height around the
  // focus line), ramping to uMaxBlur pixels at the top and bottom edges.
  float d = abs(vUv.y - uFocusY);
  float k = smoothstep(0.175, 0.5, d);
  float r = k * uMaxBlur;
  vec3 col = texture2D(tScene, vUv).rgb;
  #ifdef USE_AO
    // Depth-aware upsample where the image is sharp; the blurred taps below
    // read the half-res AO bilinearly (the blur hides its edges).
    col *= aoAt();
  #endif
  if (r > 0.05) {
    // 9-tap vertical Gaussian (sigma ~ 2 taps), offsets scaled by r.
    vec2 step = vec2(0.0, uTexel.y * r * 0.5);
    col = col * 0.2270;
    col += TAP(step * 1.0) * 0.1945;
    col += TAP(-step * 1.0) * 0.1945;
    col += TAP(step * 2.0) * 0.1216;
    col += TAP(-step * 2.0) * 0.1216;
    col += TAP(step * 3.0) * 0.0540;
    col += TAP(-step * 3.0) * 0.0540;
    col += TAP(step * 4.0) * 0.0162;
    col += TAP(-step * 4.0) * 0.0162;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Grain after the output transform: +-1.5/255, animated so it never sits still.
  float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor.rgb += (n - 0.5) * (3.0 / 255.0);
}
`;

// Screen-space AO strength in daylight (scaled by aoDayFactor).
const AO_INTENSITY = 2.4;

/**
 * ctx (optional): the world context; ctx.quality.ao picks screen-space AO,
 * ctx.grade fades it with the day, ctx.grade.uniforms carries the ground
 * texture (to tell water from the river bed under it).
 */

export function createPost(renderer, ctx = null) {
  let target = null;
  let targetAO = false;
  let ssao = null;
  const size = new THREE.Vector2();
  const uniforms = {
    tScene: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uMaxBlur: { value: 2.5 },
    uFocusY: { value: 0.5 },
    uTime: { value: 0 },
    tDepth: { value: null },
    tAO: { value: null },
    uAOSize: { value: new THREE.Vector2(1, 1) },
    uClip: { value: new THREE.Vector2(0.5, 1600) },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false });
  // One triangle covering the screen.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function ensure(wantAO) {
    renderer.getDrawingBufferSize(size);
    if (target && targetAO !== wantAO) {
      target.dispose();
      target = null;
    }
    if (!target) {
      // The depth texture receives the MSAA depth on resolve (one sample per
      // pixel, which is what AO wants), so the scene still renders once.
      target = new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        samples: 4,
        depthTexture: wantAO ? new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType) : null,
      });
      targetAO = wantAO;
      if (wantAO) material.defines.USE_AO = 1;
      else delete material.defines.USE_AO;
      material.needsUpdate = true;
    } else if (target.width !== size.x || target.height !== size.y) {
      target.setSize(size.x, size.y);
    }
    uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    uniforms.tScene.value = target.texture;
    uniforms.tDepth.value = wantAO ? target.depthTexture : null;
  }

  /** Render `scene` through the finishing pass. focusY: 0 bottom .. 1 top. */
  function render(scene, camera, time, focusY = 0.5) {
    const day = aoDayFactor(ctx?.grade?.current);
    const wantAO = ctx?.quality?.ao === 'ssao' && !!ctx.grade?.uniforms?.tGround;
    ensure(wantAO);
    uniforms.uTime.value = time;
    uniforms.uFocusY.value = focusY;
    uniforms.uMaxBlur.value = 2.5 * renderer.getPixelRatio();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    if (wantAO) {
      ssao ??= createSSAO(renderer, ctx.grade.uniforms);
      uniforms.tAO.value = ssao.render(target.depthTexture, camera, {
        fogNear: scene.fog?.near ?? 1e4,
        fogFar: scene.fog?.far ?? 2e4,
        intensity: AO_INTENSITY * day,
      });
      uniforms.uAOSize.value.copy(ssao.size);
      uniforms.uClip.value.set(camera.near, camera.far);
    } else if (ssao) {
      ssao.dispose();
      ssao = null;
    }
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCamera);
  }

  /** Compile every material for the offscreen pass (not the screen). */
  function warm(scene, camera) {
    ensure(ctx?.quality?.ao === 'ssao' && !!ctx.grade?.uniforms?.tGround);
    renderer.setRenderTarget(target);
    const done = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(null);
    return done;
  }

  return {
    render,
    warm,
    dispose() {
      target?.dispose();
      target = null;
      ssao?.dispose();
      ssao = null;
      geometry.dispose();
      material.dispose();
    },
  };
}
