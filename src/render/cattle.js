import * as THREE from 'three';
import { GROUND_GLSL } from './ground.js';
import { gradeLambert } from './props.js';
import { GRADE_HEAD } from './shaderlib.js';

// Cattle on a dairy's pasture (decor.js places one record per cow, from spring
// to autumn). One small instanced mesh, animated entirely in the vertex
// shader like the villagers: each cow wanders between grazing spots in its
// field, walks there (legs swinging in diagonal pairs, turning as it sets off),
// then grazes with its head down and nibbling, takes a step now and then,
// looks up a while, and swishes its tail. The body sits level with the ground
// under its own hooves, pitched on a slope, and every hoof stays on the ground.

const MAX_COWS = 96;
const PART = { COAT: 0, PATCH: 1, MUZZLE: 2, HORN: 3 };
const BONE = { BODY: 0, HEAD: 2, LEG: 4, TAIL: 8 };

/** Box-built cow, metres, facing +z: body, patch, head, muzzle, horns, legs, tail. */
function cowGeometry() {
  const pos = [], bone = [], part = [];
  function box(min, max, b, parts) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const faces = {
      pz: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
      nz: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
      px: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
      nx: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      py: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
      ny: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    };
    for (const [name, p] of Object.entries(parts)) {
      if (p === null || p === undefined) continue;
      const [a, bb, c, d] = faces[name];
      for (const v of [a, bb, c, a, c, d]) { pos.push(...v); bone.push(b); part.push(p); }
    }
  }
  const all = (p, skip = []) => {
    const o = { pz: p, nz: p, px: p, nx: p, py: p, ny: p };
    for (const s of skip) o[s] = null;
    return o;
  };
  box([-0.34, 0.68, -0.75], [0.34, 1.28, 0.75], BONE.BODY, all(PART.COAT));
  box([-0.352, 0.8, -0.18], [0.352, 1.292, 0.34], BONE.BODY, all(PART.PATCH, ['ny']));
  box([-0.17, 0.94, 0.66], [0.17, 1.3, 1.16], BONE.HEAD, all(PART.COAT, ['nz']));
  box([-0.15, 0.94, 1.12], [0.15, 1.1, 1.3], BONE.HEAD, all(PART.MUZZLE, ['nz']));
  box([-0.22, 1.26, 0.8], [-0.12, 1.36, 0.86], BONE.HEAD, all(PART.HORN, ['ny']));
  box([0.12, 1.26, 0.8], [0.22, 1.36, 0.86], BONE.HEAD, all(PART.HORN, ['ny']));
  [[-0.22, 0.55], [0.22, 0.55], [-0.22, -0.55], [0.22, -0.55]].forEach(([x, z], i) => {
    box([x - 0.07, 0, z - 0.07], [x + 0.07, 0.72, z + 0.07], BONE.LEG + i, { ...all(PART.COAT, ['py']), ny: PART.HORN });
  });
  box([-0.03, 0.62, -0.79], [0.03, 1.26, -0.74], BONE.TAIL, all(PART.COAT, ['py']));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aBone', new THREE.Float32BufferAttribute(bone, 1));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  return g;
}

const COW_GLSL = /* glsl */ `
${GROUND_GLSL}
attribute float aBone;
attribute float aPart;
attribute vec4 iField; // the pasture: centre x, z, half width, half depth (its own frame)
attribute vec4 iCow;   // the field's yaw, seed (0..1), patch on, unused

float cowHash(float a, float b) { return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453); }
// A grazing spot in the field, the k-th of this cow's wanderings.
vec2 cowSpot(float k, float seed) {
  vec2 h = vec2(cowHash(k, seed * 91.7), cowHash(k + 17.0, seed * 37.3)) * 2.0 - 1.0;
  vec2 l = h * max(iField.zw - vec2(0.9), vec2(0.0));
  float c = cos(iCow.x), s = sin(iCow.x);
  return iField.xy + vec2(l.x * c + l.y * s, -l.x * s + l.y * c);
}
float headingOf(vec2 d, float fallback) { return dot(d, d) > 1e-4 ? atan(d.x, d.y) : fallback; }
vec3 cowSwingX(vec3 p, vec3 pivot, float a) {
  vec3 d = p - pivot;
  float c = cos(a), s = sin(a);
  return pivot + vec3(d.x, d.y * c + d.z * s, -d.y * s + d.z * c);
}
vec3 cowSwingZ(vec3 p, vec3 pivot, float a) {
  vec3 d = p - pivot;
  float c = cos(a), s = sin(a);
  return pivot + vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}

// The posed cow vertex in world space.
vec3 cowPosition(vec3 position) {
  float seed = iCow.y;
  float T = uDecoTime;
  float period = 15.0 + 7.0 * seed;
  float tt = T + seed * 97.0;
  float k = floor(tt / period);
  float u = fract(tt / period);
  // Walk from the last spot to this one over the first fifth of the period,
  // then graze there, with one short step forward partway through.
  vec2 A = cowSpot(k - 1.0, seed), B = cowSpot(k, seed), Z = cowSpot(k - 2.0, seed);
  float walkK = smoothstep(0.0, 0.2, u);
  float walking = 1.0 - step(0.2, u);
  float prevH = headingOf(A - Z, seed * 6.283);
  float h = headingOf(B - A, prevH);
  float turn = smoothstep(0.0, 0.05, u);
  float dh = mod(h - prevH + 3.14159265, 6.2831853) - 3.14159265;
  float yaw = prevH + dh * turn;
  vec2 dir = vec2(sin(yaw), cos(yaw));
  float stepK = smoothstep(0.55, 0.6, u);
  float stepping = step(0.55, u) * (1.0 - step(0.6, u));
  vec2 at = mix(A, B, walkK) + dir * 0.25 * stepK;

  float bone = floor(aBone + 0.5);
  vec3 p = position;
  // Legs: diagonal pairs swing while walking or stepping.
  float gait = max(walking, stepping * 0.6);
  float w = T * 5.5 + seed * 20.0;
  if (bone >= 4.0 && bone <= 7.0) {
    float pair = (bone == 4.0 || bone == 7.0) ? 1.0 : -1.0;
    vec3 hip = vec3(position.x > 0.0 ? 0.22 : -0.22, 0.72, position.z > 0.0 ? 0.55 : -0.55);
    p = cowSwingX(p, hip, 0.38 * gait * pair * sin(w));
  }
  // Head: up a little while walking; down in the grass grazing, nibbling;
  // raised for a look round late in each stay.
  if (bone == 2.0) {
    // (cowSwingX by a > 0 tips the snout up: grazing is negative.)
    float look = smoothstep(0.7, 0.74, u) * (1.0 - smoothstep(0.84, 0.88, u));
    float graze = -1.0 - 0.08 * sin(T * 5.0 + seed * 9.0);
    float pitch = mix(mix(graze, -0.2, walking), 0.12, look);
    p = cowSwingX(p, vec3(0.0, 1.1, 0.7), pitch);
  }
  // Tail: a lazy swish.
  if (bone == 8.0) p = cowSwingZ(p, vec3(0.0, 1.26, -0.76), 0.32 * sin(T * 1.8 + seed * 7.0));
  // Hide the patch on plain cows.
  if (aPart > 0.5 && aPart < 1.5 && iCow.z < 0.5) p = vec3(0.0, 1.0, 0.0);

  // On the ground: level with its own hooves, pitched on a slope.
  float cy = cos(yaw), sy = sin(yaw);
  vec2 fwd = vec2(sy, cy) * 0.55;
  float gF = groundHeight(at + fwd), gB = groundHeight(at - fwd);
  float pitchBody = atan(gF - gB, 1.1);
  p = cowSwingX(p, vec3(0.0, 0.0, 0.0), pitchBody);
  vec3 world = vec3(at.x, 0.5 * (gF + gB), at.y) + vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  // Hooves stay on the ground under them (the leg stretches or shortens).
  if (bone >= 4.0 && bone <= 7.0 && position.y < 0.05) world.y = groundHeight(world.xz);
  return world;
}
`;

export function createCattle(ctx) {
  const { scene, grade } = ctx;
  const geo = new THREE.InstancedBufferGeometry();
  const base = cowGeometry();
  for (const name of ['position', 'normal', 'aBone', 'aPart']) geo.setAttribute(name, base.getAttribute(name));
  const field = new THREE.InstancedBufferAttribute(new Float32Array(MAX_COWS * 4), 4);
  const cow = new THREE.InstancedBufferAttribute(new Float32Array(MAX_COWS * 4), 4);
  const coat = new THREE.InstancedBufferAttribute(new Float32Array(MAX_COWS * 3), 3);
  const patch = new THREE.InstancedBufferAttribute(new Float32Array(MAX_COWS * 3), 3);
  geo.setAttribute('iField', field);
  geo.setAttribute('iCow', cow);
  geo.setAttribute('iCoat', coat);
  geo.setAttribute('iPatch', patch);
  geo.instanceCount = 0;

  const material = gradeLambert(grade, 'cattle', {
    vertexHead: COW_GLSL + 'attribute vec3 iCoat;\nattribute vec3 iPatch;\nvarying vec3 vCowColor;\n',
    vertexBegin: /* glsl */ `
      transformed = cowPosition(position);
      float cp = floor(aPart + 0.5);
      vCowColor = cp < 0.5 ? iCoat : cp < 1.5 ? iPatch : cp < 2.5 ? vec3(0.62, 0.42, 0.36) : vec3(0.16, 0.13, 0.11);
    `,
    fragmentHead: 'varying vec3 vCowColor;\n',
    fragmentColor: 'diffuseColor.rgb = vCowColor;\n',
  });
  material.flatShading = true;

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms);
    shader.vertexShader = GRADE_HEAD + COW_GLSL + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed = cowPosition(position);',
    );
  };
  depth.customProgramCacheKey = () => 'cattle-depth';

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'cattle';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depth;
  mesh.visible = false;
  scene.add(mesh);

  /**
   * The herd: [{x, z, hw, hd, yaw, seed, coat: Color, patch: Color | null}],
   * x/z/hw/hd/yaw the cow's pasture (its field's centre, half sizes, turn).
   */
  function setHerd(list) {
    const n = Math.min(MAX_COWS, list.length);
    for (let i = 0; i < n; i++) {
      const c = list[i];
      field.array.set([c.x, c.z, c.hw, c.hd], i * 4);
      cow.array.set([c.yaw, c.seed, c.patch ? 1 : 0, 0], i * 4);
      c.coat.toArray(coat.array, i * 3);
      (c.patch ?? c.coat).toArray(patch.array, i * 3);
    }
    for (const a of [field, cow, coat, patch]) a.needsUpdate = true;
    geo.instanceCount = n;
    mesh.visible = n > 0;
  }

  return {
    mesh,
    setHerd,
    setVisible(v) { mesh.visible = v && geo.instanceCount > 0; },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      base.dispose();
      material.dispose();
      depth.dispose();
    },
  };
}
