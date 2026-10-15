import * as THREE from 'three';

// High-tier finishing pass (design-visual §3.6): the scene renders into an
// MSAA half-float target, then one full-screen triangle applies a faint
// tilt-shift (a vertical blur that grows toward the top and bottom edges, so
// the town reads like a model on a table) and a 1-2 % grain dither that stops
// banding in the sky and water. Tone mapping happens here, once.

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D tScene;
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
  if (r > 0.05) {
    // 9-tap vertical Gaussian (sigma ~ 2 taps), offsets scaled by r.
    vec2 step = vec2(0.0, uTexel.y * r * 0.5);
    col = col * 0.2270;
    col += texture2D(tScene, vUv + step * 1.0).rgb * 0.1945;
    col += texture2D(tScene, vUv - step * 1.0).rgb * 0.1945;
    col += texture2D(tScene, vUv + step * 2.0).rgb * 0.1216;
    col += texture2D(tScene, vUv - step * 2.0).rgb * 0.1216;
    col += texture2D(tScene, vUv + step * 3.0).rgb * 0.0540;
    col += texture2D(tScene, vUv - step * 3.0).rgb * 0.0540;
    col += texture2D(tScene, vUv + step * 4.0).rgb * 0.0162;
    col += texture2D(tScene, vUv - step * 4.0).rgb * 0.0162;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Grain after the output transform: +-1.5/255, animated so it never sits still.
  float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor.rgb += (n - 0.5) * (3.0 / 255.0);
}
`;

export function createPost(renderer) {
  let target = null;
  const size = new THREE.Vector2();
  const uniforms = {
    tScene: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uMaxBlur: { value: 2.5 },
    uFocusY: { value: 0.5 },
    uTime: { value: 0 },
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

  function ensure() {
    renderer.getDrawingBufferSize(size);
    if (!target) {
      target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    } else if (target.width !== size.x || target.height !== size.y) {
      target.setSize(size.x, size.y);
    }
    uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    uniforms.tScene.value = target.texture;
  }

  /** Render `scene` through the finishing pass. focusY: 0 bottom .. 1 top. */
  function render(scene, camera, time, focusY = 0.5) {
    ensure();
    uniforms.uTime.value = time;
    uniforms.uFocusY.value = focusY;
    uniforms.uMaxBlur.value = 2.5 * renderer.getPixelRatio();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCamera);
  }

  return {
    render,
    dispose() {
      target?.dispose();
      target = null;
      geometry.dispose();
      material.dispose();
    },
  };
}
