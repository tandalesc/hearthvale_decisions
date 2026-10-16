import * as THREE from 'three';
import { GROUND_GLSL } from './ground.js';

// Screen-space ambient occlusion for the high tier's finishing pass (post.js).
//
// No extra scene render: it reads the depth the scene pass already wrote
// (the MSAA target's depth, resolved into a DepthTexture) and rebuilds view
// positions and normals from it. Two half-resolution passes:
//
//  1. AO: a 12-tap spiral (SAO-style) in a world-space radius around each
//     pixel, cosine-weighted with a range falloff, so geometry far in front
//     of a pixel (a roof edge over the street behind it, a bank over the
//     water) never darkens it and the sky never occludes or is occluded.
//     The spiral's spin follows a fixed 4x4 screen pattern, never time, so
//     the result does not crawl while the camera moves. Output: (visibility,
//     view depth) in a half-float RG target.
//  2. Blur: a 5x5 depth-aware tent whose weights cover the 4x4 spin pattern
//     exactly once, which removes the pattern without smearing across edges.
//
// The post pass then upsamples it (depth-aware at the focus band) and
// multiplies it into the scene colour before tilt-shift and tone mapping.
//
// Fades: with the valley haze (the same curve as atmosphere.js), so far land
// keeps its aerial look; out over water (the depth there is the river bed
// under a transparent surface); and with the day grade (aoDayFactor).

const VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMMON = /* glsl */ `
uniform highp sampler2D tDepth;
uniform vec2 uFull;
uniform mat4 uProjInv;
float rawDepth(ivec2 p) {
  return texelFetch(tDepth, clamp(p, ivec2(0), ivec2(uFull) - 1), 0).r;
}
vec3 viewPos(ivec2 p, float d) {
  vec2 uv = (vec2(p) + 0.5) / uFull;
  vec4 v = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
`;

const AO_FRAG = /* glsl */ `
#define SAMPLES 12
#define TURNS 7.0
#define BIAS 0.12
${COMMON}
${GROUND_GLSL}
uniform mat4 uViewInv;
uniform float uRadius;
uniform float uIntensity;
uniform float uProjScale;
uniform vec2 uFog;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

float haze(float d) {
  float lin = clamp((d - uFog.x) / max(uFog.y - uFog.x, 1.0), 0.0, 1.0);
  float far = smoothstep(uFog.x, uFog.y * 2.0, d);
  return min(lin, 0.16 + 0.26 * far);
}

void main() {
  ivec2 hp = ivec2(gl_FragCoord.xy);
  ivec2 p = hp * 2;
  float d = rawDepth(p);
  if (d >= 0.999999) { gl_FragColor = vec4(1.0, 1.0e4, 0.0, 1.0); return; }
  vec3 P = viewPos(p, d);
  float z = -P.z;

  // Normal from depth: per axis, the neighbour on the same surface.
  vec3 pr = viewPos(p + ivec2(1, 0), rawDepth(p + ivec2(1, 0)));
  vec3 pl = viewPos(p - ivec2(1, 0), rawDepth(p - ivec2(1, 0)));
  vec3 pu = viewPos(p + ivec2(0, 1), rawDepth(p + ivec2(0, 1)));
  vec3 pd = viewPos(p - ivec2(0, 1), rawDepth(p - ivec2(0, 1)));
  vec3 dx = abs(pr.z - P.z) < abs(pl.z - P.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(pd.z - P.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));

  float vis = 1.0;
  float ssR = uRadius * uProjScale / z; // half-res pixels
  if (ssR > 0.75) {
    ssR = min(ssR, 36.0);
    float spin = BAYER[(hp.x & 3) + ((hp.y & 3) << 2)] * (6.2831853 / 16.0);
    float r2 = uRadius * uRadius;
    float sum = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      float a = (float(i) + 0.5) / float(SAMPLES);
      float ang = a * (TURNS * 6.2831853) + spin;
      vec2 off = vec2(cos(ang), sin(ang)) * (a * ssR * 2.0);
      ivec2 q = p + ivec2(floor(off + 0.5));
      vec3 Q = viewPos(q, rawDepth(q));
      vec3 v = Q - P;
      float vv = dot(v, v);
      float f = max(0.0, 1.0 - vv / r2);
      sum += f * max(0.0, dot(v, N) * inversesqrt(vv + 1.0e-4) - BIAS);
    }
    float occ = sum / (float(SAMPLES) * (1.0 - BIAS));
    vis = 1.0 - clamp(occ * uIntensity, 0.0, 0.55);
    // Small on screen (far zoom): ease in rather than pop.
    vis = mix(1.0, vis, smoothstep(0.75, 2.0, ssR));
  }

  // Water: the depth is the river bed under a transparent surface.
  vec3 W = (uViewInv * vec4(P, 1.0)).xyz;
  float ru = groundRiverU(W.xz);
  if (abs(ru) < uWaterHalf + 0.2) {
    float bankTop = groundHeight(vec2(W.x - ru + sign(ru) * uWaterHalf, W.z));
    float under = 1.0 - smoothstep(bankTop - 0.3, bankTop - 0.1, W.y);
    // Fully: a share left over shows the bed's deepest line through the water
    // as a seam down the middle of the river.
    vis = mix(vis, 1.0, under);
  }
  // Lakes, ponds and the sea: the bed under still water takes no occlusion either.
  if (groundShore(W.xz) < 0.3 && abs(ru) >= uWaterHalf + 0.2) vis = mix(vis, 1.0, 1.0 - smoothstep(-0.2, 0.02, W.y));
  // Haze: occlusion under the valley's aerial perspective.
  vis = 1.0 - (1.0 - vis) * (1.0 - haze(z));
  gl_FragColor = vec4(vis, z, 0.0, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uHalf;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = ivec2(uHalf) - 1;
  vec2 c = texelFetch(tAO, p, 0).rg;
  if (c.g > 9.0e3) { gl_FragColor = vec4(1.0, c.g, 0.0, 1.0); return; }
  float tol = 0.035 * c.g + 0.2;
  float s = 0.0, sw = 0.0;
  for (int j = -2; j <= 2; j++) {
    float wj = abs(j) == 2 ? 0.5 : 1.0;
    for (int i = -2; i <= 2; i++) {
      float w = wj * (abs(i) == 2 ? 0.5 : 1.0);
      vec2 t = texelFetch(tAO, clamp(p + ivec2(i, j), ivec2(0), hi), 0).rg;
      float dz = (t.g - c.g) / tol;
      w *= max(0.0, 1.0 - dz * dz);
      s += t.r * w;
      sw += w;
    }
  }
  gl_FragColor = vec4(s / max(sw, 1.0e-4), c.g, 0.0, 1.0);
}
`;

/** GLSL for the post pass: depth-aware upsample of the blurred AO at this pixel. */
export const SSAO_COMPOSITE_GLSL = /* glsl */ `
uniform highp sampler2D tDepth;
uniform sampler2D tAO;
uniform vec2 uAOSize;
uniform vec2 uClip; // near, far
float aoAt() {
  float d = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r;
  if (d >= 0.999999) return 1.0;
  float z = uClip.x * uClip.y / (uClip.y - d * (uClip.y - uClip.x));
  vec2 hp = (gl_FragCoord.xy - 0.5) * 0.5;
  vec2 b = floor(hp);
  vec2 f = hp - b;
  ivec2 i0 = ivec2(b);
  ivec2 hi = ivec2(uAOSize) - 1;
  float tol = 0.03 * z + 0.15;
  float s = 0.0, sw = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec2 t = texelFetch(tAO, clamp(i0 + o, ivec2(0), hi), 0).rg;
    float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float dz = (t.g - z) / tol;
    float w = (wb + 1.0e-3) / (1.0 + dz * dz * 8.0);
    s += t.r * w;
    sw += w;
  }
  return s / sw;
}
`;

export function createSSAO(renderer, groundUniforms) {
  const size = new THREE.Vector2();
  const half = new THREE.Vector2();
  const opts = { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  const raw = new THREE.WebGLRenderTarget(1, 1, { ...opts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const blurred = new THREE.WebGLRenderTarget(1, 1, opts);
  raw.texture.generateMipmaps = false;
  blurred.texture.generateMipmaps = false;

  const aoUniforms = {
    tDepth: { value: null },
    uFull: { value: new THREE.Vector2(1, 1) },
    uProjInv: { value: new THREE.Matrix4() },
    uViewInv: { value: new THREE.Matrix4() },
    // World radius in metres: a wall's foot, an alley, the underside of eaves.
    uRadius: { value: 3.2 },
    uIntensity: { value: 1.0 },
    uProjScale: { value: 1 },
    uFog: { value: new THREE.Vector2(150, 440) },
    tGround: groundUniforms.tGround,
    uGroundOrigin: groundUniforms.uGroundOrigin,
    uGroundStep: groundUniforms.uGroundStep,
    uGroundN: groundUniforms.uGroundN,
    uWaterHalf: groundUniforms.uWaterHalf,
  };
  const blurUniforms = { tAO: { value: raw.texture }, uHalf: { value: half } };
  const pass = (uniforms, fragmentShader) => {
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(tri, m);
    mesh.frustumCulled = false;
    const s = new THREE.Scene();
    s.add(mesh);
    return { scene: s, material: m };
  };
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const aoPass = pass(aoUniforms, AO_FRAG);
  const blurPass = pass(blurUniforms, BLUR_FRAG);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /**
   * Compute AO from `depthTexture` (full drawing-buffer size) for `camera`.
   * params: {fogNear, fogFar, intensity}. Returns the blurred RG texture.
   */
  function render(depthTexture, camera, params) {
    renderer.getDrawingBufferSize(size);
    half.set(Math.ceil(size.x / 2), Math.ceil(size.y / 2));
    if (raw.width !== half.x || raw.height !== half.y) {
      raw.setSize(half.x, half.y);
      blurred.setSize(half.x, half.y);
    }
    const u = aoUniforms;
    u.tDepth.value = depthTexture;
    u.uFull.value.copy(size);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uViewInv.value.copy(camera.matrixWorld);
    // Half-res pixels per metre at unit depth (projection [1][1] = cot(fov/2)).
    u.uProjScale.value = camera.projectionMatrix.elements[5] * half.y * 0.5;
    u.uFog.value.set(params.fogNear, params.fogFar);
    u.uIntensity.value = params.intensity;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(raw);
    renderer.render(aoPass.scene, cam);
    renderer.setRenderTarget(blurred);
    renderer.render(blurPass.scene, cam);
    renderer.setRenderTarget(prevTarget);
    return blurred.texture;
  }

  return {
    render,
    size: half,
    dispose() {
      raw.dispose();
      blurred.dispose();
      tri.dispose();
      aoPass.material.dispose();
      blurPass.material.dispose();
    },
  };
}
