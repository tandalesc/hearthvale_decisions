import * as THREE from 'three';
import { patchMaterial } from './shaderlib.js';
import { GROUND_GLSL } from './ground.js';

// Villagers (design-visual §4.5): one instanced mesh for everyone, animated
// entirely in the vertex shader. The sim's render view owns the per-person
// rows (16 floats, see src/sim/render-view.js); we bind that Float32Array
// zero-copy as an interleaved instance buffer and upload only dirty rows.
// A second draw of the same buffer lays a soft contact blob under each
// person so they sit on the ground at every quality tier.
//
// Walkers drape on the shared ground texture (ground.js) between waypoints,
// except where their row height is clearly off the ground (bridge decks,
// fords), where the row's own height is kept.
//
// Picking returns the person's state id from view.peopleIds[row].

// A walker whose extrapolated row height is within this of the ground follows
// the ground; anything further off (decks, ford beds) keeps the row height.
const DRAPE_TOLERANCE = 0.3;

const STRIDE = 16;

// Body parts (aPart) and bones (aBone).
const PART = { SKIN: 0, CLOTH: 1, LEGS: 2, HAT: 3, HAIR: 4, WOOD: 5, SIGN: 6, CRATE: 7 };
const BONE = {
  TORSO: 0, HEAD: 1, ARM_L: 2, ARM_R: 3, LEG_L: 4, LEG_R: 5,
  HAT: 6, BRIM: 7, CRATE: 8, HAMMER: 9, SIGN: 10,
};

// Muted tabletop palettes (sRGB). Nothing pure white or black.
const SKIN = ['#f1d2b6', '#e3b994', '#c99a72', '#a87452', '#86583a', '#5f3d29'];
const CLOTH = [
  '#a06a50', '#7f9262', '#5d7d90', '#c49a52', '#8c6a8a', '#bb7446', '#6e7e56', '#d2b888',
  '#7d5c44', '#4c6c7a', '#ae5c58', '#e0d2ae', '#8fa2ae', '#c88a68', '#64845c', '#9e8a68',
];
const LEGS = ['#5a5046', '#4b5664', '#6a5a44', '#56604a'];
const HATS = ['#6b5a44', '#7a5e3c', '#c9a86a', '#4b4f55'];
const HAIR = ['#3b2a1e', '#5a3e26', '#7a5a34', '#2e2a26'];

const colors = (list) => list.map((h) => new THREE.Color(h));

// ---------------------------------------------------------------------------
// Geometry: chunky boxes, ~1.75 m tall facing +z. Each face carries a part
// (colour family) and every vertex a bone (animation group).

function buildVillagerGeometry() {
  const pos = [];
  const nor = [];
  const bone = [];
  const part = [];

  // Axis-aligned box; `parts` maps face name -> part (null skips the face).
  function box(min, max, b, parts) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const faces = {
      pz: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]],
      nz: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]],
      px: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]],
      nx: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]],
      py: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]],
      ny: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]],
    };
    for (const [name, p] of Object.entries(parts)) {
      if (p === null || p === undefined) continue;
      const [a, bb, c, d, n] = faces[name];
      for (const v of [a, bb, c, a, c, d]) {
        pos.push(...v);
        nor.push(...n);
        bone.push(b);
        part.push(p);
      }
    }
  }
  const all = (p, skip = []) => {
    const o = { pz: p, nz: p, px: p, nx: p, py: p, ny: p };
    for (const s of skip) o[s] = null;
    return o;
  };

  // Legs: sides only (tops hide in the torso, soles on the ground).
  box([0.02, 0, -0.09], [0.19, 0.72, 0.09], BONE.LEG_L, all(PART.LEGS, ['py', 'ny']));
  box([-0.19, 0, -0.09], [-0.02, 0.72, 0.09], BONE.LEG_R, all(PART.LEGS, ['py', 'ny']));
  // Torso.
  box([-0.22, 0.68, -0.14], [0.22, 1.3, 0.14], BONE.TORSO, all(PART.CLOTH, ['ny']));
  // Head: face and sides skin, hair on top and at the back.
  box([-0.17, 1.31, -0.16], [0.17, 1.65, 0.16], BONE.HEAD, {
    pz: PART.SKIN, px: PART.SKIN, nx: PART.SKIN, nz: PART.HAIR, py: PART.HAIR,
  });
  // Arms: sleeves with a skin-coloured hand cap at the end.
  box([0.23, 0.74, -0.07], [0.36, 1.28, 0.07], BONE.ARM_L, { ...all(PART.CLOTH, ['py']), ny: PART.SKIN });
  box([-0.36, 0.74, -0.07], [-0.23, 1.28, 0.07], BONE.ARM_R, { ...all(PART.CLOTH, ['py']), ny: PART.SKIN });
  // Hat crown and brim (variants are shaped in the shader).
  box([-0.15, 1.63, -0.14], [0.15, 1.79, 0.14], BONE.HAT, all(PART.HAT, ['ny']));
  box([-0.25, 1.63, -0.24], [0.25, 1.67, 0.24], BONE.BRIM, { py: PART.HAT, ny: PART.HAT });
  // Crate carried at chest height (action 1).
  box([-0.18, 0.9, 0.22], [0.18, 1.16, 0.46], BONE.CRATE, all(PART.CRATE, ['ny']));
  // Mallet in the right hand (action 2): rest pose hangs below the hand.
  box([-0.33, 0.48, -0.03], [-0.27, 0.76, 0.03], BONE.HAMMER, all(PART.WOOD, ['py', 'ny']));
  box([-0.35, 0.44, -0.11], [-0.25, 0.54, 0.11], BONE.HAMMER, all(PART.WOOD, ['ny']));
  // Placard on a pole in the right hand (action 5); points up once the arm is raised.
  // Held placard: the only protest cue (no static event props), so it is a
  // little larger than life to read from the default camera.
  box([-0.33, -0.05, -0.025], [-0.27, 0.95, 0.025], BONE.SIGN, all(PART.WOOD, ['py', 'ny']));
  box([-0.72, -0.1, -0.025], [0.12, 0.42, 0.025], BONE.SIGN, { pz: PART.SIGN, nz: PART.SIGN });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aBone', new THREE.Float32BufferAttribute(bone, 1));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  return g;
}

// ---------------------------------------------------------------------------
// Shaders

const DRAPE_GLSL = /* glsl */ `
${GROUND_GLSL}
#ifdef SEGMENT_END
attribute vec4 iD;   // t1 (time the walker reaches its waypoint), waypoint x, waypoint z, onDeck
#endif
attribute vec2 iFade; // time of the last indoors/outdoors change, scale before it

// Time to extrapolate to: now, but never past the current waypoint, so a late
// row update cannot carry a walker through a corner or into a wall.
float rowTime(float t0) {
  #ifdef SEGMENT_END
    if (iD.x > t0) return min(uTime, iD.x);
  #endif
  return uTime;
}

// Indoors/outdoors changes ease over 0.3 s at the door instead of popping:
// shrink away after going in, grow back after coming out.
float fadedScale(float s) {
  float k = clamp((uTime - iFade.x) / 0.3, 0.0, 1.0);
  if (s < 0.01) return iFade.y * (1.0 - k);
  if (iFade.x > 0.0 && iFade.y < 0.01) return s * k;
  return s;
}

// Row position extrapolated to now, then draped on the ground texture so the
// figure follows the terrain's curvature mid-segment.
vec3 drapedBase(vec3 pos, vec3 vel, float t0) {
  vec3 base = pos + vel * clamp(rowTime(t0) - t0, 0.0, 3.0);
  #ifdef SEGMENT_END
    // On a bridge deck the row's own y follows the deck profile; don't drape.
    if (iD.w > 0.5) return base;
  #endif
  float g = groundHeight(base.xz);
  if (abs(base.y - g) < ${DRAPE_TOLERANCE.toFixed(2)}) base.y = g;
  return base;
}
`;

const POSE_HEAD = /* glsl */ `
attribute float aBone;
attribute float aPart;
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iA;   // t0, phase, gait, action
attribute vec4 iB;   // actionT0, skin, cloth, hat
attribute vec2 iC;   // scale, facing
uniform float uLodNear;
uniform float uLodFar;
uniform float uFigureScale;

// Rotate p about a pivot around the x axis. a > 0 swings a hanging limb
// forward (+z): (0,-1,0) -> (0,-cos a, sin a).
vec3 swingX(vec3 p, vec3 pivot, float a) {
  vec3 d = p - pivot;
  float c = cos(a), s = sin(a);
  return pivot + vec3(d.x, d.y * c + d.z * s, -d.y * s + d.z * c);
}
// Rotate about the z axis. a > 0 lifts a hanging limb toward +x.
vec3 swingZ(vec3 p, vec3 pivot, float a) {
  vec3 d = p - pivot;
  float c = cos(a), s = sin(a);
  return pivot + vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}

// Posed, scaled, rotated and placed vertex in world space.
// Hidden people collapse every vertex onto one point (zero-area triangles).
vec3 personPosition(vec3 position) {
  float t0 = iA.x;
  float phase = iA.y;
  float gait = iA.z;
  float action = floor(iA.w + 0.5);
  float actT = max(uTime - iB.x, 0.0);
  float hat = floor(iB.w + 0.5);
  float scale = fadedScale(iC.x) * uFigureScale;
  float bone = floor(aBone + 0.5);

  // Extrapolate from the row's anchor (clamped so a stalled sim never slides
  // far); cull hidden and distant people before paying for the drape.
  vec3 raw = iPos + iVel * clamp(rowTime(t0) - t0, 0.0, 3.0);
  // Waiting at a waypoint for the next row: stand, don't walk on the spot.
  if (rowTime(t0) < uTime) gait = 0.0;
  float dist = distance(raw, cameraPosition);
  if (scale < 0.01 || dist > uLodFar) return raw;
  vec3 base = drapedBase(iPos, iVel, t0);
  bool lod = dist > uLodNear;

  // Walk cycle. Frequency follows gait (capped so 8x stays readable),
  // amplitude saturates at a brisk walk.
  float g = min(gait, 1.2);
  float w = uTime * 7.0 * min(gait, 2.5) + phase;
  float swing = sin(w) * 0.55 * g;
  float legL = swing, legR = -swing;
  float armL = -swing * 0.8, armR = swing * 0.8;
  float outL = 0.07, outR = 0.07;
  float bob = abs(cos(w)) * 0.05 * g;
  float lift = 0.0;
  float twist = 0.0;
  // Idle: a slow breath so standing crowds are not frozen.
  bob += (1.0 - step(0.05, gait)) * sin(uTime * 1.6 + phase) * 0.012;

  // Action pose, eased in over 0.3 s from the walk pose.
  float k = smoothstep(0.0, 0.3, actT);
  float aL = armL, aR = armR, oL = outL, oR = outR, lL = legL, lR = legR, li = 0.0;
  if (action == 1.0) {            // carry: both arms forward under the crate
    aL = 1.15; aR = 1.15; oL = 0.0; oR = 0.0;
  } else if (action == 2.0) {     // build: mallet strikes at 2 Hz
    float strike = sin(actT * 12.566);
    aR = 1.9 + 0.8 * strike; aL = 0.7; oR = 0.15;
    lL = 0.0; lR = 0.0;
  } else if (action == 3.0) {     // sit on the ground, legs out
    lL = 1.45; lR = 1.45; aL = 0.35; aR = 0.35; li = -0.62;
  } else if (action == 4.0) {     // cheer: arms up, bouncing
    float b = sin(actT * 9.0 + phase);
    aL = 2.7 + 0.25 * b; aR = 2.7 - 0.25 * b; oL = 0.35; oR = 0.35;
    li = abs(sin(actT * 6.0 + phase)) * 0.12;
  } else if (action == 5.0) {     // protest: placard held high, fist pumping
    aR = 2.95 + 0.12 * sin(actT * 4.0 + phase);
    aL = 0.4 + 0.6 * max(0.0, sin(actT * 3.0 + phase)); oR = 0.05;
  } else if (action == 6.0) {     // dance: alternating arms, sway and hop
    float d = sin(actT * 5.0 + phase);
    aL = 1.4 + d; aR = 1.4 - d; oL = 0.5; oR = 0.5;
    lL = 0.35 * d; lR = -0.35 * d;
    li = abs(d) * 0.1;
    twist = 0.7 * sin(actT * 2.5 + phase);
  }
  if (action > 0.5) {
    armL = mix(armL, aL, k); armR = mix(armR, aR, k);
    outL = mix(outL, oL, k); outR = mix(outR, oR, k);
    legL = mix(legL, lL, k); legR = mix(legR, lR, k);
    lift = li * k;
  }

  vec3 p = position;
  vec3 hide = vec3(0.0, 1.0, 0.0); // inside the torso
  vec3 shoulderL = vec3(0.29, 1.24, 0.0);
  vec3 shoulderR = vec3(-0.29, 1.24, 0.0);
  float up = bob + lift;

  if (bone == 4.0) p = swingX(p, vec3(0.1, 0.72, 0.0), legL);
  else if (bone == 5.0) p = swingX(p, vec3(-0.1, 0.72, 0.0), legR);
  else if (bone == 2.0) p = swingZ(swingX(p, shoulderL, armL), shoulderL, outL) + vec3(0.0, up, 0.0);
  else if (bone == 3.0 || bone == 9.0 || bone == 10.0) {
    if (bone == 9.0 && action != 2.0) p = hide;
    else if (bone == 10.0 && action != 5.0) p = hide;
    else p = swingZ(swingX(p, shoulderR, armR), shoulderR, -outR) + vec3(0.0, up, 0.0);
  } else if (bone == 8.0) {
    p = action == 1.0 ? p + vec3(0.0, up, 0.0) : hide;
  } else if (bone == 6.0 || bone == 7.0) {
    // Hat variants: 0 none, 1 felt hat, 2 wide straw hat, 3 snug cap.
    vec3 c = vec3(0.0, 1.63, 0.0);
    if (hat < 0.5) p = hide;
    else if (hat > 1.5 && hat < 2.5) p = c + (p - c) * (bone == 7.0 ? vec3(1.35, 1.0, 1.35) : vec3(1.0, 0.55, 1.0));
    else if (hat > 2.5) p = bone == 7.0 ? hide : c + (p - c) * vec3(1.18, 0.6, 1.2) - vec3(0.0, 0.03, 0.0);
    if (hat > 0.5) p.y += up;
  } else {
    p.y += up;
  }
  // Legs carry the hip drop when sitting.
  if (bone == 4.0 || bone == 5.0) p.y += lift;

  if (lod) {
    // Far: one standing block (torso stretched to the ground plus head/hat).
    if (bone >= 2.0 && bone <= 5.0 || bone >= 8.0) p = hide;
    if (bone == 0.0 && p.y < 0.75) p.y = 0.0;
  }

  // Face the direction of travel, else the stored facing.
  float yaw = length(iVel.xz) > 0.05 ? atan(iVel.x, iVel.z) : iC.y;
  yaw += twist * k;
  float cy = cos(yaw), sy = sin(yaw);
  p *= scale;
  return base + vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
}
`;

const COLOR_HEAD = /* glsl */ `
uniform vec3 uSkin[6];
uniform vec3 uCloth[16];
uniform vec3 uLegs[4];
uniform vec3 uHat[4];
uniform vec3 uHair[4];
varying vec3 vPersonColor;

vec3 personColor() {
  int skin = int(clamp(floor(iB.y + 0.5), 0.0, 5.0));
  int cloth = int(clamp(floor(iB.z + 0.5), 0.0, 15.0));
  int hat = int(clamp(floor(iB.w + 0.5), 0.0, 3.0));
  float part = floor(aPart + 0.5);
  if (part == 0.0) return uSkin[skin];
  if (part == 1.0) return uCloth[cloth];
  if (part == 2.0) return uLegs[(skin + cloth) % 4];
  if (part == 3.0) return uHat[hat];
  if (part == 4.0) return uHair[(skin * 3 + int(abs(iA.y) * 2.0)) % 4];
  if (part == 5.0) return vec3(0.30, 0.20, 0.12);
  if (part == 6.0) return vec3(0.84, 0.78, 0.62);
  return vec3(0.55, 0.40, 0.24);
}
`;

const BLOB_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iA;
attribute vec2 iC;
uniform float uTime;
uniform float uLodFar;
varying vec2 vUv;
varying float vWade;
${DRAPE_GLSL}
// River surface height (water.js WATER_Y); wading walkers stand below it.
const float WATER_LEVEL = 0.025;
void main() {
  vec3 base = drapedBase(iPos, iVel, iA.x);
  float d = distance(base, cameraPosition);
  // Hidden indoors and well before the people themselves fade out.
  float fs = fadedScale(iC.x);
  float on = step(0.01, fs) * (1.0 - step(uLodFar * 0.75, d));
  // Wading at a ford: the blob becomes a ripple ring on the water surface.
  vWade = step(base.y, WATER_LEVEL - 0.04);
  vec3 anchor = vWade > 0.5 ? vec3(base.x, WATER_LEVEL + 0.012, base.z) : base + vec3(0.0, 0.05, 0.0);
  vec3 transformed = anchor + vec3(position.x * 0.5, 0.0, position.z * 0.5) * fs * on * (1.0 + 0.3 * vWade);
  vUv = position.xz;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BLOB_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uNight;
uniform float uStrength;
uniform float uTime;
varying vec2 vUv;
varying float vWade;
void main() {
  float r = length(vUv);
  if (vWade > 0.5) {
    // Two soft rings breathing outward around the legs.
    float ring = 1.0 - smoothstep(0.0, 0.09, abs(r - (0.55 + 0.18 * sin(uTime * 3.0))));
    ring = max(ring, (1.0 - smoothstep(0.0, 0.06, abs(r - 0.3))) * 0.6);
    gl_FragColor = vec4(vec3(0.84, 0.9, 0.88), ring * 0.45 * (1.0 - smoothstep(0.85, 1.0, r)));
  } else {
    float a = (1.0 - smoothstep(0.25, 1.0, r)) * uStrength * (1.0 - 0.5 * uNight);
    gl_FragColor = vec4(vec3(0.10, 0.11, 0.07), a);
  }
  #include <fog_fragment>
}
`;

// ---------------------------------------------------------------------------

export function createPeople(ctx) {
  const { scene, grade, lights } = ctx;
  const baseGeometry = buildVillagerGeometry();
  const blobBase = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

  const lodUniforms = {
    uLodNear: { value: 120 },
    uLodFar: { value: 260 },
    // Slightly toy-scaled (~1.9 m) so figures read at the default camera distance.
    uFigureScale: { value: 1.1 },
    uShadowFocus: { value: new THREE.Vector3() },
  };
  const paletteUniforms = {
    uSkin: { value: colors(SKIN) },
    uCloth: { value: colors(CLOTH) },
    uLegs: { value: colors(LEGS) },
    uHat: { value: colors(HATS) },
    uHair: { value: colors(HAIR) },
  };

  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  patchMaterial(material, grade, {
    key: 'people',
    uniforms: { ...lodUniforms, ...paletteUniforms },
    vertexHead: DRAPE_GLSL + POSE_HEAD + COLOR_HEAD,
    vertexBegin: /* glsl */ `
      transformed = personPosition(position);
      vPersonColor = personColor();
    `,
    fragmentHead: 'varying vec3 vPersonColor;\n',
    fragmentColor: 'diffuseColor.rgb = vPersonColor * uTint;\n',
  });

  // Shadow caster (high tier): same pose; only people near the view target
  // cast, since the shadow map refreshes at a few Hz at most.
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms, lodUniforms);
    shader.vertexShader = 'uniform float uTime;\nuniform vec3 uShadowFocus;\n' + DRAPE_GLSL + POSE_HEAD + shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      transformed = personPosition(position);
      if (distance(transformed.xz, uShadowFocus.xz) > 70.0) transformed = vec3(0.0, -50.0, 0.0);`,
    );
  };
  depthMaterial.customProgramCacheKey = () => 'people-depth';

  const blobUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(blobUniforms, {
    uTime: grade.uniforms.uTime,
    tGround: grade.uniforms.tGround,
    uGroundOrigin: grade.uniforms.uGroundOrigin,
    uGroundStep: grade.uniforms.uGroundStep,
    uGroundN: grade.uniforms.uGroundN,
    uNight: grade.uniforms.uNight,
    uLodFar: lodUniforms.uLodFar,
    uStrength: { value: 0.34 },
  });
  const blobMaterial = new THREE.ShaderMaterial({
    uniforms: blobUniforms,
    vertexShader: BLOB_VERT,
    fragmentShader: BLOB_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), material);
  mesh.name = 'people';
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.customDepthMaterial = depthMaterial;
  mesh.visible = false;
  const blobs = new THREE.Mesh(new THREE.InstancedBufferGeometry(), blobMaterial);
  blobs.name = 'people-blobs';
  blobs.frustumCulled = false;
  blobs.renderOrder = 1;
  blobs.visible = false;
  scene.add(mesh, blobs);

  let stride = STRIDE; // 16, or 20 when the view carries segment ends
  let fadeAttr = null;   // per-row [change time, scale before]
  let prevScale = null;
  let boundArray = null;
  let boundVersion = -1;
  let buffer = null;
  let count = 0;
  let castShadow = false;

  /** (Re)bind the sim's Float32Array as the interleaved instance buffer. */
  function bind(array, version, rowFloats) {
    stride = rowFloats === 20 ? 20 : STRIDE;
    const segment = stride === 20;
    for (const m of [material, depthMaterial]) {
      if (!!m.defines?.SEGMENT_END !== segment) {
        m.defines = { ...(m.defines ?? {}) };
        if (segment) m.defines.SEGMENT_END = 1; else delete m.defines.SEGMENT_END;
        m.needsUpdate = true;
      }
    }
    if (!!blobMaterial.defines?.SEGMENT_END !== segment) {
      blobMaterial.defines = { ...(blobMaterial.defines ?? {}) };
      if (segment) blobMaterial.defines.SEGMENT_END = 1; else delete blobMaterial.defines.SEGMENT_END;
      blobMaterial.needsUpdate = true;
    }
    const rows = Math.floor(array.length / stride);
    fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(rows * 2), 2);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    prevScale = new Float32Array(rows);
    for (let i = 0; i < rows; i++) prevScale[i] = array[i * stride + 14];
    buffer = new THREE.InstancedInterleavedBuffer(array, stride);
    buffer.setUsage(THREE.DynamicDrawUsage);
    const attrs = {
      iPos: new THREE.InterleavedBufferAttribute(buffer, 3, 0),
      iVel: new THREE.InterleavedBufferAttribute(buffer, 3, 3),
      iA: new THREE.InterleavedBufferAttribute(buffer, 4, 6),
      iB: new THREE.InterleavedBufferAttribute(buffer, 4, 10),
      iC: new THREE.InterleavedBufferAttribute(buffer, 2, 14),
      iFade: fadeAttr,
    };
    if (segment) attrs.iD = new THREE.InterleavedBufferAttribute(buffer, 4, 16);
    const g = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'normal', 'aBone', 'aPart']) g.setAttribute(name, baseGeometry.getAttribute(name));
    for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, a);
    const b = new THREE.InstancedBufferGeometry();
    b.setAttribute('position', blobBase.getAttribute('position'));
    b.setIndex(blobBase.getIndex());
    for (const name of ['iPos', 'iVel', 'iA', 'iC', 'iFade', ...(segment ? ['iD'] : [])]) b.setAttribute(name, attrs[name]);
    // Disposing the old geometries frees the old GPU buffers.
    mesh.geometry.dispose();
    blobs.geometry.dispose();
    mesh.geometry = g;
    blobs.geometry = b;
    boundArray = array;
    boundVersion = version;
  }

  function update(view, frame) {
    lastView = view;
    const array = view?.people;
    if (!array || !array.length) {
      mesh.visible = blobs.visible = marker.visible = false;
      count = 0;
      return;
    }
    if (array !== boundArray || (view.peopleVersion ?? 0) !== boundVersion) {
      bind(array, view.peopleVersion ?? 0, view.rowFloats);
      view.peopleDirty = null; // a fresh buffer uploads whole
    }
    const dirty = view.peopleDirty;
    if (dirty && dirty.end > dirty.start) {
      buffer.addUpdateRange(dirty.start * stride, (dirty.end - dirty.start) * stride);
      buffer.needsUpdate = true;
      markFades(array, dirty.start, Math.min(dirty.end, prevScale.length), frame.time);
    }
    view.peopleDirty = null;

    count = Math.min(view.peopleCount ?? 0, Math.floor(array.length / stride));
    mesh.geometry.instanceCount = count;
    blobs.geometry.instanceCount = count;
    mesh.visible = blobs.visible = count > 0;

    updateMarker(frame.time);

    if (castShadow && count > 0) {
      lodUniforms.uShadowFocus.value.copy(frame.target);
      // Moving casters: keep the static shadow map refreshing (rate-capped in lights.js).
      lights.animateFor(0.3, frame.time);
    }
  }

  /** Note rows that just went indoors or came out, for the door fade. */
  function markFades(array, start, end, now) {
    const f = fadeAttr.array;
    let lo = Infinity, hi = -1;
    for (let i = start; i < end; i++) {
      const s = array[i * stride + 14];
      const prev = prevScale[i];
      if ((s < 0.01) !== (prev < 0.01)) {
        f[i * 2] = now;
        f[i * 2 + 1] = prev;
        if (i < lo) lo = i;
        if (i > hi) hi = i;
      }
      prevScale[i] = s;
    }
    if (hi >= lo) {
      fadeAttr.clearUpdateRanges();
      fadeAttr.addUpdateRange(lo * 2, (hi - lo + 1) * 2);
      fadeAttr.needsUpdate = true;
    }
  }

  function applyQuality(q) {
    castShadow = !!q.peopleCast;
    mesh.castShadow = castShadow;
    const near = q.name === 'low' ? 90 : q.name === 'high' ? 140 : 120;
    lodUniforms.uLodNear.value = near;
    lodUniforms.uLodFar.value = q.name === 'low' ? 200 : q.name === 'high' ? 300 : 260;
    blobUniforms.uStrength.value = castShadow ? 0.24 : 0.34;
    lights.markDirty();
  }
  applyQuality(ctx.quality);

  // ---------------------------------------------------------------------
  // CPU mirror of the shader's placement, for picking, the selection marker
  // and camera follow. Same extrapolation, same drape rule.

  const ground = ctx.ground;
  let lastView = null;

  /** Seconds to extrapolate row o by at `time`: never past its waypoint. */
  function rowDt(a, o, time) {
    const t0 = a[o + 6];
    const t1 = stride === 20 && a[o + 16] > t0 ? Math.min(time, a[o + 16]) : time;
    return Math.min(3, Math.max(0, t1 - t0));
  }

  /** Feet position of row i at `time`, draped like the shader. */
  function rowPosition(i, time, out) {
    const a = boundArray;
    const o = i * stride;
    const dt = rowDt(a, o, time);
    const x = a[o] + a[o + 3] * dt;
    const z = a[o + 2] + a[o + 5] * dt;
    let y = a[o + 1] + a[o + 4] * dt;
    const onDeck = stride >= 20 && a[o + 19] > 0.5;
    if (ground && !onDeck) {
      const g = ground.sample(x, z);
      if (Math.abs(y - g) < DRAPE_TOLERANCE) y = g;
    }
    return out.set(x, y, z);
  }

  /** Person id written in row i (falls back to the row index). */
  const idOf = (i) => {
    const ids = lastView?.peopleIds;
    return ids && i < ids.length && ids[i] >= 0 ? ids[i] : i;
  };

  // Row lookup for an id, cached and re-verified each use (rows can move).
  let cachedId = null;
  let cachedRow = -1;
  function rowOf(id) {
    if (id == null || !boundArray) return -1;
    const ids = lastView?.peopleIds;
    if (!ids) return id < count ? id : -1;
    if (cachedId === id && cachedRow >= 0 && cachedRow < count && ids[cachedRow] === id) return cachedRow;
    cachedId = id;
    cachedRow = -1;
    for (let i = 0; i < count; i++) {
      if (ids[i] === id) { cachedRow = i; break; }
    }
    return cachedRow;
  }

  /** Current feet position of a person by id; false when hidden or gone. */
  function positionOf(id, time, out) {
    const row = rowOf(id);
    if (row < 0 || boundArray[row * stride + 14] < 0.01) return false;
    rowPosition(row, time, out);
    return true;
  }

  /**
   * Picking: the nearest visible person whose body passes within `radiusPx`
   * screen pixels of the ray. Pixels convert to a distance at each person's
   * range (pxAngle radians per pixel), so no per-person projection is needed.
   * Returns {personId, distance} or null.
   */
  const feet = new THREE.Vector3();
  const head = new THREE.Vector3();
  function pick(ray, time, { maxDist = Infinity, radiusPx = 14, pxAngle = 0.001 } = {}) {
    const a = boundArray;
    if (!a || !count) return null;
    const far = lodUniforms.uLodFar.value;
    const tanPx = Math.tan(pxAngle * radiusPx);
    const o0 = ray.origin, dir = ray.direction;
    let best = -1;
    let bestAlong = Infinity;
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const s = a[o + 14];
      if (s < 0.01) continue;
      // Coarse cull on the raw anchor: behind the camera, beyond the ground
      // hit or the draw distance, or far off the ray.
      const dt = rowDt(a, o, time);
      const px = a[o] + a[o + 3] * dt - o0.x;
      const py = a[o + 1] + a[o + 4] * dt - o0.y;
      const pz = a[o + 2] + a[o + 5] * dt - o0.z;
      const along = px * dir.x + py * dir.y + pz * dir.z;
      if (along <= 0 || along > maxDist + 2 || along > far || along > bestAlong) continue;
      const tol = along * tanPx + 0.35 * s;
      const perp2 = px * px + py * py + pz * pz - along * along;
      if (perp2 > (tol + 2.2 * s) * (tol + 2.2 * s)) continue;
      // Precise: distance from the ray to the body's axis (feet to head).
      rowPosition(i, time, feet);
      const h = 1.9 * s * lodUniforms.uFigureScale.value;
      head.copy(feet).y += h;
      const d2 = ray.distanceSqToSegment(feet, head);
      if (d2 > tol * tol) continue;
      best = i;
      bestAlong = along;
    }
    return best < 0 ? null : { personId: idOf(best), distance: bestAlong };
  }

  // ---------------------------------------------------------------------
  // Selection marker: a small gold pin bobbing above the selected head.

  const markerGeometry = new THREE.OctahedronGeometry(1, 0);
  markerGeometry.scale(0.26, 0.38, 0.26);
  const markerMaterial = new THREE.MeshLambertMaterial({ color: '#f0c65a', emissive: '#c08a26', flatShading: true });
  patchMaterial(markerMaterial, grade, { key: 'people-marker' });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial);
  marker.name = 'people-marker';
  marker.visible = false;
  marker.castShadow = false;
  marker.renderOrder = 3;
  scene.add(marker);
  let selectedId = null;

  function setSelected(id) {
    selectedId = id ?? null;
    if (selectedId === null) marker.visible = false;
  }

  function updateMarker(time) {
    if (selectedId === null || !boundArray || !positionOf(selectedId, time, feet)) {
      marker.visible = false;
      return;
    }
    const row = rowOf(selectedId);
    const s = boundArray[row * stride + 14] * lodUniforms.uFigureScale.value;
    const dist = feet.distanceTo(ctx.camera.position);
    if (dist > lodUniforms.uLodFar.value) {
      marker.visible = false;
      return;
    }
    // Grows with distance so it stays ~25 px tall on screen, never tiny.
    const grow = Math.max(1.2, dist / 20);
    marker.visible = true;
    marker.scale.setScalar(grow);
    marker.position.copy(feet);
    marker.position.y += 2.3 * s + 0.35 * grow + 0.12 * grow * Math.sin(time * 3.2);
    marker.rotation.y = time * 1.6;
  }

  return {
    update,
    applyQuality,
    pick,
    positionOf,
    setSelected,
    selected: () => selectedId,
    count: () => count,
    dispose() {
      scene.remove(mesh, blobs, marker);
      markerGeometry.dispose();
      markerMaterial.dispose();
      mesh.geometry.dispose();
      blobs.geometry.dispose();
      baseGeometry.dispose();
      blobBase.dispose();
      material.dispose();
      depthMaterial.dispose();
      blobMaterial.dispose();
    },
  };
}

/** Triangles per villager (for budgets and tests). */
export function villagerTriangles() {
  const g = buildVillagerGeometry();
  const n = g.getAttribute('position').count / 3;
  g.dispose();
  return n;
}
