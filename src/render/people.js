import * as THREE from 'three';
import { patchMaterial } from './shaderlib.js';
import { GROUND_GLSL } from './ground.js';
import { deckProfile } from '../sim/bridges.js';
import { railStyle, railInner, RAIL_TOP } from '../sim/gatherings.js';
import { surfaceLevelAt } from '../terrain.js';

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
// The sim's wading depth (sim/people.js walkerY): rows at it are in a ford.
const FORD_BED = -0.3;

const STRIDE = 16;

// Leg rig (figure units, before scale): hip pivot at LEG_Y, knee halfway.
const LEG_Y = 0.72;
const KNEE_Y = 0.36;

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

  // Legs: thigh and shin, open at the knee. The shader places three rings of
  // vertices by their rest height (hip 0.72, knee 0.36, sole 0), so the two
  // halves share the knee ring and bend without a gap. Tops hide in the torso.
  // Soles in a dark shoe brown: a swinging leg tilts its bottom toward the
  // camera, and an open sole shows the hollow.
  box([0.02, KNEE_Y, -0.09], [0.19, 0.72, 0.09], BONE.LEG_L, all(PART.LEGS, ['py', 'ny']));
  box([0.02, 0, -0.09], [0.19, KNEE_Y, 0.09], BONE.LEG_L, { ...all(PART.LEGS, ['py']), ny: PART.WOOD });
  box([-0.19, KNEE_Y, -0.09], [-0.02, 0.72, 0.09], BONE.LEG_R, all(PART.LEGS, ['py', 'ny']));
  box([-0.19, 0, -0.09], [-0.02, KNEE_Y, 0.09], BONE.LEG_R, { ...all(PART.LEGS, ['py']), ny: PART.WOOD });
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
  // Crate carried at chest height (action 1). While building (action 2) the
  // shader shrinks it into the mallet's head, on the placard pole as handle.
  box([-0.18, 0.9, 0.22], [0.18, 1.16, 0.46], BONE.CRATE, all(PART.CRATE, ['ny']));
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
// onGround: 1 when the base was draped (the feet can follow the ground too),
// 2 on a bridge deck (the feet follow the deck: surfaceY), 0 otherwise.
vec3 drapedBase(vec3 pos, vec3 vel, float t0, out float onGround) {
  vec3 base = pos + vel * clamp(rowTime(t0) - t0, 0.0, 3.0);
  onGround = 0.0;
  #ifdef SEGMENT_END
    // On a bridge deck the row's own y follows the deck profile; don't drape
    // (but the feet still find the deck under them: onGround 2).
    if (iD.w > 0.5) { onGround = 2.0; return base; }
  #endif
  float g = groundHeight(base.xz);
  #ifdef SEGMENT_END
    // Decks are flagged, so any other row is on the ground: the sim's natural
    // terrain, which a building pad's blend (ground.js) can lift or cut by
    // more than the tolerance on a slope, right where people reach doors.
    // Waders keep their row height (the sim's ford bed, above the channel's).
    if (base.y > ${(FORD_BED + 0.01).toFixed(2)} || abs(base.y - g) < ${DRAPE_TOLERANCE.toFixed(2)}) { base.y = g; onGround = 1.0; }
  #else
    if (abs(base.y - g) < ${DRAPE_TOLERANCE.toFixed(2)}) { base.y = g; onGround = 1.0; }
  #endif
  return base;
}
vec3 drapedBase(vec3 pos, vec3 vel, float t0) {
  float onGround;
  return drapedBase(pos, vel, t0, onGround);
}
// Bridge decks near the view (people.js setDecks): ends, half-widths and a
// table of DECK_SAMPLES heights along each deck (the sim's deckProfile:
// ramps up from the banks, arched on stone and iron), so a shadow lies on
// the deck and its ramps instead of sinking to the ground beneath, and feet
// on a deck land on its slope (groundRel).
#define MAX_DECKS 8
#define DECK_SAMPLES 20
const float DECK_VERGE = 0.6;
uniform int uDeckN;
uniform vec4 uDeckAB[MAX_DECKS];
uniform float uDeckHalf[MAX_DECKS];
uniform vec4 uDeckH[MAX_DECKS * 5];
uniform vec2 uDeckRail[MAX_DECKS]; // rail top above the deck, the rail's middle from the centre line (metres)
float deckSample(int i, int k) {
  vec4 v = uDeckH[i * 5 + k / 4];
  int c = k - (k / 4) * 4;
  return c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w;
}
// The walking surface under xz: a deck (with its sloping verge) or the ground.
// Which deck (index into uDeck*) a point stands on, or -1.
int deckIndexAt(vec2 xz) {
  for (int i = 0; i < MAX_DECKS; i++) {
    if (i >= uDeckN) break;
    vec4 ab = uDeckAB[i];
    vec2 d = ab.zw - ab.xy;
    float t = dot(xz - ab.xy, d) / max(dot(d, d), 1e-6);
    if (t < 0.0 || t > 1.0) continue;
    if (length(xz - (ab.xy + d * t)) <= uDeckHalf[i]) return i;
  }
  return -1;
}
float surfaceY(vec2 xz) {
  float g = groundHeight(xz);
  for (int i = 0; i < MAX_DECKS; i++) {
    if (i >= uDeckN) break;
    vec4 ab = uDeckAB[i];
    vec2 d = ab.zw - ab.xy;
    float t = dot(xz - ab.xy, d) / max(dot(d, d), 1e-6);
    if (t < 0.0 || t > 1.0) continue;
    float off = length(xz - (ab.xy + d * t));
    float hw = uDeckHalf[i];
    if (off > hw + DECK_VERGE) continue;
    float f = t * float(DECK_SAMPLES - 1);
    int k = int(min(floor(f), float(DECK_SAMPLES - 2)));
    float y = mix(deckSample(i, k), deckSample(i, k + 1), f - float(k));
    // Beside the deck over lower ground (water, a bank below): a hard edge,
    // which the ledge rule in main() holds up. The verge only blends where
    // the ground rises to meet a ramp.
    if (off > hw && g < y) return g;
    return mix(y, g, clamp((off - hw) / DECK_VERGE, 0.0, 1.0));
  }
  return g;
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
attribute vec3 iTurn; // heading shown when the row's heading last changed, time of that change; z: an angler's water level (fishLineWater)
uniform float uLodNear;
uniform float uIkNear;  // feet and hands read the ground within this distance
uniform float uTurnEase; // 1: ease turns; 0: snap (reduced motion)
uniform float uLodFar;
uniform float uFigureScale;

// A fishing rod (action 8) is the placard's pole, stretched and pointed out over the
// water from the right hand; the placard itself becomes the line hanging from its tip.
// No extra triangles. Cast (the rod sweeps up over the shoulder and forward) over the
// first ROD_CAST seconds, then held, bobbing a little.
const float ROD_LEN = 2.1;
const float ROD_CAST = 1.3;
const float LINE_LEN = 2.0;
// waterY: the water surface under the rod's tip in the figure's own units (the row's
// level, from markFades, less the walker's base, over its scale), or below -100 when
// unknown (the line then hangs LINE_LEN).
vec3 rodVertex(vec3 position, vec3 hand, float actT, float phase, float part, float waterY) {
  float castT = clamp(actT / ROD_CAST, 0.0, 1.0);
  float a = 0.55 + 1.9 * sin(3.14159265 * castT) + 0.04 * sin(uTime * 1.7 + phase) * castT;
  vec3 dir = vec3(0.0, sin(a), cos(a));
  vec3 side = vec3(1.0, 0.0, 0.0);
  vec3 nrm = cross(dir, side);
  vec3 tip = hand + dir * ROD_LEN;
  if (part > 5.5) {
    // The line: a thin strip from the tip straight down to the water (bobbing on it),
    // paid out as the cast lands.
    float bottom = waterY > -100.0 ? waterY + 0.012 * sin(uTime * 2.3 + phase) : tip.y - LINE_LEN;
    float drop = max(0.0, tip.y - bottom) * castT * castT;
    float top = step(0.1, position.y);
    return tip + vec3(position.x < -0.3 ? -0.006 : 0.006, -drop * (1.0 - top), 0.0);
  }
  float t = clamp((position.y + 0.05) / 1.0, 0.0, 1.0);
  float taper = (1.0 - 0.65 * t) * 0.55;
  return hand + dir * (t * ROD_LEN) + side * ((position.x + 0.30) * taper) + nrm * (position.z * taper);
}

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

// The sim turns walkers instantly at every waypoint and turns standers to
// face a building or event on arrival. Ease from the heading shown at that
// moment (iTurn, kept by markFades) to the row's own, along the shorter arc:
// about 0.25 s on the move, 0.4 s for the arrival turn.
float easedYaw(float target) {
  if (uTurnEase < 0.5) return target;
  float dur = length(iVel.xz) > 0.05 ? 0.25 : 0.4;
  float k = smoothstep(0.0, 1.0, clamp((uTime - iTurn.y) / dur, 0.0, 1.0));
  float d = mod(target - iTurn.x + 3.14159265, 6.2831853) - 3.14159265;
  return iTurn.x + d * k;
}

// --- Grounding IK (everyone, every frame, in this shader; no CPU cost) ------
// Legs are two bones (thigh and shin, SHANK each) solved analytically toward
// a foot target in the figure's own y-z plane; the hips settle so the lower
// planted foot can reach the ground. Feet read the ground texture under their
// own soles, so on a slope one knee bends and the other leg straightens.
// Arms aim at a hand target (hands on knees, on the grass) and stretch a little
// to reach it. All in figure units (before scale), relative to the base.
const float LEG_Y = ${LEG_Y.toFixed(2)};
const float SHANK = ${(LEG_Y - KNEE_Y).toFixed(2)};
const float LEG_REACH = 0.70;  // hip to planted sole: knees stay soft, never locked
const float ARM_LEN = 0.50;    // shoulder pivot to the end of the hand

// The walking surface under a point of the figure's own frame (x, z): the
// ground, or on a bridge the deck and its ramps; relative to the base, in
// figure units. 0 in a ford, and over a ledge (a quay edge, a pad's lip, a
// parapet), where a foot holds the walking plane instead.
float groundRel(vec3 base, vec2 local, float cy, float sy, float scale, float onGround) {
  if (onGround < 0.5) return 0.0;
  vec2 w = base.xz + vec2(local.x * cy + local.y * sy, -local.x * sy + local.y * cy) * scale;
  float d = ((onGround > 1.5 ? surfaceY(w) : groundHeight(w)) - base.y) / scale;
  return abs(d) > 0.4 ? 0.0 : d;
}

// Thigh and shin angles from straight down (> 0 swings forward) for a hip and
// a foot target, both (y, z); the knee bends forward. Out of reach: straight,
// pointing at the target.
vec2 legAngles(vec2 hip, vec2 foot) {
  vec2 d = foot - hip;
  float len = clamp(length(d), 0.02, 2.0 * SHANK - 1e-3);
  float phi = atan(d.y, -d.x);
  float bend = acos(len / (2.0 * SHANK));
  return vec2(phi + bend, phi - bend);
}

// One step of the walk for a leg at cycle position c (0..1): planted from
// +stride to -stride over the first half (moving back exactly as fast as the
// body moves forward, so the sole stays put on the ground), then swung forward
// clear of the ground. Returns (z, lift).
vec2 stepFoot(float c, float stride) {
  if (c < 0.5) return vec2(stride * (1.0 - 4.0 * c), 0.0);
  float u = (c - 0.5) * 2.0;
  return vec2(stride * (2.0 * smoothstep(0.0, 1.0, u) - 1.0), 0.35 * stride * sin(3.14159265 * u));
}

// A leg vertex: hip ring, knee ring (mitred between thigh and shin) or sole
// ring, by its rest height. Soles stay flat on the ground while the shin is
// near upright (a planted foot), and turn with the shin when it lies out.
vec3 legVertex(vec3 p, float legX, float hipY, vec2 ang) {
  vec3 off = vec3(p.x - legX, 0.0, p.z);
  vec3 hip = vec3(legX, hipY, 0.0);
  if (p.y > LEG_Y - 0.01) return swingX(hip + off, hip, ang.x);
  vec3 knee = hip + vec3(0.0, -SHANK * cos(ang.x), SHANK * sin(ang.x));
  if (p.y > 0.01) return swingX(knee + off, knee, 0.5 * (ang.x + ang.y));
  vec3 foot = knee + vec3(0.0, -SHANK * cos(ang.y), SHANK * sin(ang.y));
  return swingX(foot + off, foot, ang.y * smoothstep(0.35, 0.8, abs(ang.y)));
}

// Arm angle (forward from down) and stretch that bring the hand of an arm
// hanging from \`shoulder\` (rest pose) to \`target\` (figure frame), given the
// upper body's lift and its tilt about the hips.
vec2 armAim(vec3 shoulder, vec3 target, float up, float tiltA, float hipY) {
  vec3 t = swingX(target, vec3(0.0, hipY, 0.0), -tiltA) - vec3(0.0, up, 0.0);
  vec2 d = t.yz - shoulder.yz;
  return vec2(atan(d.y, -d.x), clamp(length(d) / ARM_LEN, 0.8, 1.3));
}
// Stretch an arm vertex along the hanging arm before it swings.
vec3 armStretch(vec3 p, vec3 shoulder, float s) {
  return vec3(p.x, shoulder.y + (p.y - shoulder.y) * s, p.z);
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
  float onGround;
  vec3 base = drapedBase(iPos, iVel, t0, onGround);
  bool lod = dist > uLodNear;
  // Face the direction of travel, else the stored facing.
  float yaw = easedYaw(length(iVel.xz) > 0.05 ? atan(iVel.x, iVel.z) : iC.y);
  float cy = cos(yaw), sy = sin(yaw);
  float sc = max(scale, 0.05);

  // Walk cycle. Cadence follows gait (capped so 8x stays readable); the
  // stride is whatever keeps a planted foot still: the body's own speed over
  // half a cycle. Arms swing against the legs.
  float g = min(gait, 1.2);
  float moving = step(0.05, gait);
  float omega = 7.0 * clamp(gait, 0.6, 2.5);
  float w = uTime * omega + phase;
  float stride = moving * min(length(iVel.xz) / sc * 1.5707963 / omega, 0.36);
  float swing = sin(w) * 0.55 * g;
  float armL = -swing * 0.8, armR = swing * 0.8;
  float outL = 0.07, outR = 0.07;
  float cycL = fract((w - 1.5707963) / 6.2831853);
  vec2 stepL = stepFoot(cycL, stride);
  vec2 stepR = stepFoot(fract(cycL + 0.5), stride);
  float lift = 0.0;   // hop (cheer, dance): the whole figure, feet and all
  float twist = 0.0;
  float tilt = 0.0;   // upper body forward (< 0) about the hips
  float lie = 0.0;    // the whole figure laid on its back
  // Idle: a slow breath so standing crowds are not frozen.
  float breath = (1.0 - moving) * sin(uTime * 1.6 + phase) * 0.012;

  // Action pose, eased in over 0.3 s from the walk pose. Legs are posed by
  // their foot targets (z forward, y up) and, for seated poses, the hips.
  float k = smoothstep(0.0, 0.3, actT);
  float aL = armL, aR = armR, oL = outL, oR = outR, li = 0.0;
  vec2 fL = vec2(stepL.x, 0.0), fR = vec2(stepR.x, 0.0); // action feet (z, y above ground)
  float seat = -1.0;       // hips' height above the base when seated; < 0 standing
  float reach = 0.0;       // 1: the hands go to targets (handL, handR) instead
  vec3 handL = vec3(0.0), handR = vec3(0.0);
  // Feet follow the ground near the view; further out they stand level (unseen).
  float ground = dist < uIkNear ? onGround : 0.0;
  if (action == 1.0) {            // carry: both arms forward under the crate
    aL = 1.15; aR = 1.15; oL = 0.0; oR = 0.0;
  } else if (action == 2.0) {     // build: mallet strikes at 2 Hz
    float strike = sin(actT * 12.566);
    aR = 1.9 + 0.8 * strike; aL = 0.7; oR = 0.15;
    fL = vec2(0.0); fR = vec2(0.0);
  } else if (action == 3.0) {     // sit on the grass, legs out, leaning back on the hands
    seat = 0.1; fL = vec2(0.66, 0.05); fR = vec2(0.64, 0.05);
    aL = 0.35; aR = 0.35; tilt = 0.18; reach = 1.0;
    handL = vec3(0.3, 0.0, -0.3); handR = vec3(-0.3, 0.0, -0.3);
  } else if (action == 7.0) {     // sit on a bench: torso on the seat, feet on the ground, hands on the knees
    // The bench stands on the highest ground under its legs (decor.js bench).
    float bench = max(groundRel(base, vec2(0.6 / sc, 0.0), cy, sy, sc, ground),
                      groundRel(base, vec2(-0.6 / sc, 0.0), cy, sy, sc, ground));
    seat = max(bench, 0.0) + 0.485 / sc + 0.04;
    fL = vec2(0.4, 0.0); fR = vec2(0.42, 0.0);
    aL = 0.5; aR = 0.5; reach = 1.0;
  } else if (action == 4.0) {     // cheer: arms up, bouncing
    float b = sin(actT * 9.0 + phase);
    aL = 2.7 + 0.25 * b; aR = 2.7 - 0.25 * b; oL = 0.35; oR = 0.35;
    li = abs(sin(actT * 6.0 + phase)) * 0.12;
  } else if (action == 5.0) {     // protest: placard held high, fist pumping
    aR = 2.95 + 0.12 * sin(actT * 4.0 + phase);
    aL = 0.4 + 0.6 * max(0.0, sin(actT * 3.0 + phase)); oR = 0.05;
  } else if (action == 6.0) {     // dance: alternating arms and feet, sway and hop
    float d = sin(actT * 5.0 + phase);
    aL = 1.4 + d; aR = 1.4 - d; oL = 0.5; oR = 0.5;
    fL = vec2(0.24 * d, 0.0); fR = vec2(-0.24 * d, 0.0);
    li = abs(d) * 0.1;
    twist = 0.7 * sin(actT * 2.5 + phase);
  } else if (action == 8.0) {     // fish: both hands on the rod, out in front
    aR = 0.85; oR = 0.12; aL = 0.8; oL = -0.12; fL = vec2(0.0); fR = vec2(0.0);
  } else if (action == 9.0) {     // lean on a rail: upper body tipped over it, hands on its top
    aL = 1.35; aR = 1.35; oL = 0.05; oR = 0.05; fL = vec2(0.0); fR = vec2(0.06, 0.0);
    tilt = -0.34;
    // On a bridge (gatherings.js 'rail': standing in from the parapet, facing
    // out over it): both hands on the rail's top straight ahead. A truss's
    // chord is above the shoulders, so hands go on its middle rail instead.
    int di = deckIndexAt(base.xz);
    if (di >= 0 && ground > 1.5) {
      vec4 ab = uDeckAB[di];
      vec2 dd = ab.zw - ab.xy;
      float tt = clamp(dot(base.xz - ab.xy, dd) / max(dot(dd, dd), 1e-6), 0.0, 1.0);
      float off = length(base.xz - (ab.xy + dd * tt));
      float ahead = clamp(uDeckRail[di].y - off, 0.2, 0.7) / sc;
      float top = (surfaceY(base.xz) - base.y + min(uDeckRail[di].x, 1.05)) / sc;
      handL = vec3(0.2, top + 0.03, ahead);
      handR = vec3(-0.2, top + 0.03, ahead);
      reach = 1.0;
    }
  } else if (action == 10.0) {    // lie on the grass, face up, arms at the sides
    aL = 0.12; aR = 0.12; oL = 0.18; oR = 0.18; fL = vec2(0.0); fR = vec2(0.04, 0.0);
    lie = 1.0; ground = 0.0;
  } else if (action == 11.0) {    // kneel: knees and shins on the ground, hands down in front
    seat = 0.37 + groundRel(base, vec2(0.0, 0.04), cy, sy, sc, ground);
    fL = vec2(-0.37, 0.03); fR = vec2(-0.35, 0.03);
    aL = 0.75; aR = 0.7; oL = 0.05; oR = 0.05;
    tilt = -0.52; reach = 1.0;
    handL = vec3(0.22, 0.04, 0.44); handR = vec3(-0.22, 0.04, 0.4);
    handL.y += groundRel(base, handL.xz, cy, sy, sc, ground);
    handR.y += groundRel(base, handR.xz, cy, sy, sc, ground);
  } else if (action == 12.0) {    // point: right arm out toward what is watched
    aR = 1.6 + 0.05 * sin(actT * 1.3 + phase); oR = 0.06; aL = 0.15;
  }
  bool posed = action > 0.5;
  if (!posed) k = 0.0;
  armL = mix(armL, aL, k); armR = mix(armR, aR, k);
  outL = mix(outL, oL, k); outR = mix(outR, oR, k);
  lift = li * k;
  tilt *= k;

  // Feet: the walk's or the pose's, each on the ground under its own sole.
  float hipY = LEG_Y;
  vec2 angL = vec2(0.0), angR = vec2(0.0);
  if (!lod) {
    vec2 zL = vec2(mix(stepL.x, fL.x, k), mix(stepL.y, fL.y, k));
    vec2 zR = vec2(mix(stepR.x, fR.x, k), mix(stepR.y, fR.y, k));
    float gL = groundRel(base, vec2(0.1, zL.x), cy, sy, sc, ground);
    float gR = groundRel(base, vec2(-0.1, zR.x), cy, sy, sc, ground);
    // Standing hips: as high as the lower planted foot allows (an inverted
    // pendulum over the stance leg, so the body dips at full stride).
    float standY = min(gL + sqrt(max(LEG_REACH * LEG_REACH - zL.x * zL.x, 0.04)),
                       gR + sqrt(max(LEG_REACH * LEG_REACH - zR.x * zR.x, 0.04)));
    standY = clamp(standY, LEG_Y - 0.3, LEG_Y + 0.2);
    hipY = seat >= 0.0 ? mix(standY, seat, k) : standY;
    hipY += lift;
    angL = legAngles(vec2(hipY, 0.0), vec2(gL + zL.y + lift, zL.x));
    angR = legAngles(vec2(hipY, 0.0), vec2(gR + zR.y + lift, zR.x));
    if (reach > 0.5 && action == 7.0) {
      // Hands rest just above the knees.
      vec3 kneeL = vec3(0.1, hipY - SHANK * cos(angL.x), SHANK * sin(angL.x));
      vec3 kneeR = vec3(-0.1, hipY - SHANK * cos(angR.x), SHANK * sin(angR.x));
      handL = kneeL + vec3(0.06, 0.1, -0.05);
      handR = kneeR + vec3(-0.06, 0.1, -0.05);
    } else if (reach > 0.5 && action == 3.0) {
      handL.y += groundRel(base, handL.xz, cy, sy, sc, ground) + 0.02;
      handR.y += groundRel(base, handR.xz, cy, sy, sc, ground) + 0.02;
    }
  } else {
    hipY = LEG_Y + lift + (seat >= 0.0 ? (seat - LEG_Y) * k : 0.0);
  }
  float up = hipY - LEG_Y + breath;

  vec3 p = position;
  vec3 hide = vec3(0.0, 1.0, 0.0); // inside the torso
  vec3 shoulderL = vec3(0.29, 1.24, 0.0);
  vec3 shoulderR = vec3(-0.29, 1.24, 0.0);
  // Hand targets: aim and stretch the arms there.
  float stretchL = 1.0, stretchR = 1.0;
  if (reach > 0.5 && !lod) {
    vec2 aimL = armAim(shoulderL, handL, up, tilt, hipY);
    vec2 aimR = armAim(shoulderR, handR, up, tilt, hipY);
    armL = mix(armL, aimL.x, k); stretchL = mix(1.0, aimL.y, k);
    armR = mix(armR, aimR.x, k); stretchR = mix(1.0, aimR.y, k);
  }

  bool rod = false;
  bool rightHand = bone == 3.0 || bone == 9.0 || bone == 10.0 || (bone == 8.0 && action == 2.0);
  if (bone == 4.0) p = legVertex(p, 0.105, hipY, angL);
  else if (bone == 5.0) p = legVertex(p, -0.105, hipY, angR);
  else if (bone == 2.0) p = swingZ(swingX(armStretch(p, shoulderL, stretchL), shoulderL, armL), shoulderL, outL) + vec3(0.0, up, 0.0);
  else if (rightHand) {
    if (bone == 9.0) p = hide;
    else if (bone == 10.0 && action == 8.0) {
      vec3 hand = swingZ(swingX(vec3(-0.30, 0.76, 0.06), shoulderR, armR), shoulderR, -outR) + vec3(0.0, up, 0.0);
      float waterY = iTurn.z > -100.0 ? (iTurn.z - base.y) / max(scale, 1e-3) : -1e4;
      p = k > 0.99 ? rodVertex(position, hand, actT, phase, floor(aPart + 0.5), waterY) : hide;
      rod = true;
    }
    else if (bone == 10.0 && action == 2.0) {
      // Mallet: the pole is the handle, hanging from the hand; no placard.
      p = aPart > 5.5 && aPart < 6.5 ? hide : vec3(p.x, 0.76 - (0.95 - p.y) * 0.28, p.z);
    }
    else if (bone == 10.0 && action != 5.0) p = hide;
    else if (bone == 8.0) {
      // Mallet: the crate shrunk into its head at the bottom of the handle.
      vec3 u = (p - vec3(-0.18, 0.9, 0.22)) / vec3(0.36, 0.26, 0.24);
      p = vec3(-0.35, 0.44, -0.11) + u * vec3(0.1, 0.1, 0.22);
    }
    // (The rod is built in the figure's frame from the hand already.)
    if (p != hide && !rod) p = swingZ(swingX(armStretch(p, shoulderR, stretchR), shoulderR, armR), shoulderR, -outR) + vec3(0.0, up, 0.0);
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
  // Leaning and kneeling tip everything above the hips forward.
  if (tilt != 0.0 && bone != 4.0 && bone != 5.0) p = swingX(p, vec3(0.0, hipY, 0.0), tilt);
  // Lying down: the whole figure on its back, head away from the faced view.
  if (lie > 0.5) p = swingX(p, vec3(0.0, 0.0, 0.0), 1.5 * k) + vec3(0.0, 0.17 * k, 0.0);

  if (lod) {
    // Far: one standing block (torso stretched to the ground plus head/hat).
    if (bone >= 2.0 && bone <= 5.0 || bone >= 8.0) p = hide;
    if (bone == 0.0 && p.y < 0.75) p.y = 0.0;
  }

  yaw += twist * k;
  cy = cos(yaw); sy = sin(yaw);
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

// Blob shadow, sun-aware (design-visual §4.5), one draw for everyone:
//  - contact: a small, faint, round blob right under the walker, the same in
//    every pose (an N64-style drop shadow, much softer); it only blends the
//    cast into the feet;
//  - cast: in 'blob' mode a soft capsule from the walker away from the sun,
//    body-wide, body-tall over tan(elevation) (capped), feathered toward the
//    tip, fading at dusk and weaker under the moon and when rain dims the
//    light. The low tier draws the contact alone.
// The two join as a soft union, with no seam. Everything is worked out here
// per vertex and per fragment from per-frame uniforms, so blobs move with
// their walkers at the full frame rate. In 'full' mode (uSunShadow 0) only
// the contact is drawn.
//
// One shadow surface: the blob is drawn into the ground's shadow coverage map
// (shadowsurface.js) before the frame: R how much of the sun the walker blocks
// there, G the contact under the feet, B the surface's height. Lit surfaces at
// that height take the sun away there exactly as the sun's shadow map does, so
// a walker's shadow and a building's are one kind of shade: union, never
// stacked, no seam where they meet, as deep as the scene's own shade. On the
// screen only waders' ripple rings are drawn (BLOB_APPLY).
// Never down a ledge: a quad vertex whose surface drops away from the plane
// under the feet (a deck's or quay's edge, a parapet face, a bank) stays on
// that plane and fades out.
const BLOB_VERT = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_vertex>
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iA;
attribute vec4 iB;
attribute vec2 iC;
uniform float uTime;
uniform float uLodFar;
uniform float uFigureScale;
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform float uSunShadow; // 0 = contact only; else direct-sun share (rain dims it)
uniform float uNight;
#ifdef BLOB_LAMP
// The street lamps nearest the view (props.js): lantern x, z, lantern y, pool radius.
uniform vec4 uLamps[16];
uniform int uLampN;
varying vec3 vLamp;
#endif
varying vec2 vUv;
varying float vWade;
varying float vEdge;    // 0 where the quad is held up over a ledge (fades out)
varying vec4 vDeckAB;   // the deck a walker stands on (ends), for an exact edge clip
varying float vDeckHalf; // its half-width; below 0 when not on a deck
varying vec2 vWorldXZ;  // this fragment's ground position
varying float vWorldY;  // and its height (the shadow map's lookup)
varying vec2 vLocal;    // metres from the feet: (away from the sun, across)
varying vec4 vShape;    // cast length, near radius, far radius, sun strength
varying float vContact; // contact radius
varying vec2 vSlope;    // ground rise per metre along (away, across)
${DRAPE_GLSL}
// A drop below the plane under the feet larger than this is a ledge.
const float LEDGE = 0.35;
// The surface at xz for the slope estimate: a ledge counts as level, so a
// walker by a parapet or a quay edge sees the deck or quay, not the drop.
float surfaceNear(vec2 xz, float s0) {
  float y = surfaceY(xz);
  return s0 - y > LEDGE ? s0 : y;
}
// River surface height (water.js WATER_Y); wading walkers stand below it.
const float WATER_LEVEL = 0.025;
const float MAX_STRETCH = 2.6; // shadow length per body height (sun ~21 deg)
void main() {
  vec3 base = drapedBase(iPos, iVel, iA.x);
  #ifdef BLOB_COVER
    float d = distance(base, uEye); // drawn from above: measure from the main camera
  #else
    float d = distance(base, cameraPosition);
  #endif
  // Hidden indoors and well before the people themselves fade out.
  float fs = fadedScale(iC.x);
  float on = step(0.01, fs) * (1.0 - step(uLodFar * 0.75, d));
  vUv = position.xz;
  vLocal = vec2(0.0);
  vShape = vec4(0.0, 1.0, 1.0, 0.0);
  vContact = 1.0;
  vSlope = vec2(0.0);
  vEdge = 1.0;
  vDeckAB = vec4(0.0);
  vDeckHalf = -1.0;
  vWorldXZ = base.xz;
  vWorldY = base.y;
  // Wading at a ford: the blob becomes a ripple ring on the water surface.
  vWade = step(base.y, WATER_LEVEL - 0.04);
  vec3 transformed;
  if (vWade > 0.5) {
    transformed = vec3(base.x, WATER_LEVEL + 0.012, base.z) + vec3(position.x, 0.0, position.z) * 0.65 * fs * on;
  } else {
  #ifdef BLOB_APPLY
    // The screen pass draws only the ripple rings of waders now: shadows go
    // to the shadow surface (BLOB_COVER). Nothing to draw here.
    transformed = base;
  #else
    float S = fs * uFigureScale;
    // Sun on the ground: direction away from it, and how strongly it casts.
    float sunY = clamp(uSunDir.y, 0.0, 1.0);
    vec2 away = -uSunDir.xz / max(length(uSunDir.xz), 1e-4);
    vec2 side = vec2(away.y, -away.x);
    // At night the light is the moon (grade.js): uSunShadow already scales
    // the cast by its weaker light.
    float sun = uSunShadow * smoothstep(0.02, 0.2, sunY);
    // The surface under the feet (deck, ramp or ground) and its normal.
    float s0 = surfaceY(base.xz);
    bool onSurface = abs(base.y - s0) < 0.2;
    vec3 n = vec3(0.0, 1.0, 0.0);
    if (onSurface) {
      const float E = 0.6;
      float hx = surfaceNear(base.xz + vec2(E, 0.0), s0) - surfaceNear(base.xz - vec2(E, 0.0), s0);
      float hz = surfaceNear(base.xz + vec2(0.0, E), s0) - surfaceNear(base.xz - vec2(0.0, E), s0);
      n = normalize(vec3(-hx, 2.0 * E, -hz));
    }
    float ndl = dot(n, uSunDir);
    // Body height: head top 1.65, a hat adds a little.
    float height = (1.65 + (iB.w > 0.5 ? 0.1 : 0.0)) * S;
    // Where the shadow of the head lands: the ray from it, away from the sun,
    // meets the local ground plane. A slope facing the sun shortens it, one
    // facing away lengthens it. Its plan direction is always "away".
    // Bounded: never more than twice its flat-ground length, so a shadow on a
    // slope facing away from the sun does not reach over the crest.
    float tRay = height * n.y / max(ndl, max(sunY, 0.05) * 0.5);
    float len = sun > 0.001 ? min(length(uSunDir.xz) * tRay, height * MAX_STRETCH) : 0.0;
    // Lit slopes show a slightly crisper shadow, glancing ones a slightly
    // softer one; never gone, so it reads on every hill.
    sun *= mix(0.8, 1.15, clamp(ndl / max(sunY, 0.1), 0.0, 1.0));
  #ifdef BLOB_LAMP
    // Cast from the nearest lit lantern instead of the sun, fading out
    // toward the pool's rim and right under the lantern.
    float best = 1e9;
    vec4 L = vec4(0.0, 0.0, 0.0, 1.0);
    for (int k = 0; k < 16; k++) {
      if (k >= uLampN) break;
      vec2 dv = base.xz - uLamps[k].xy;
      float d2 = dot(dv, dv);
      if (d2 < best) { best = d2; L = uLamps[k]; }
    }
    float sL = sqrt(best);
    float lampOn = smoothstep(0.25, 0.75, uNight) * (1.0 - smoothstep(L.w * 0.75, L.w, sL)) * smoothstep(0.1, 0.3, sL);
    away = (base.xz - L.xy) / max(sL, 1e-3);
    side = vec2(away.y, -away.x);
    // Similar triangles: the head's shadow lands sL * h / (H - h) past the feet.
    float lampH = L.z - base.y;
    len = min(sL * height / max(lampH - height, 0.3), L.w * 1.5);
    sun = lampOn;
    on *= step(1e-3, lampOn);
    vLamp = vec3(L.xy, L.w);
  #endif
    // Body-wide near the feet; the penumbra widens toward the far end, so
    // the tip is feathered more than the feet.
    float r0 = 0.42 * S;
    float r1 = r0 + 0.14 * len;
    // Contact: a small round blob, about the walker's width.
    float rc = 0.5 * S;
    // Quad from just behind the feet to past the tip, wide enough for both.
    float along = mix(-max(r0, rc), len + r1, position.z * 0.5 + 0.5);
    float across = position.x * max(r1, rc);
    // (across, along) -> world is a rotation, never a mirror, so the quad keeps its winding.
    vec2 off = away * along + side * across;
    vec3 p = base + vec3(off.x, 0.0, off.y) * on;
    // Lie on the walking surface (deck, ramp or ground) along the whole length,
    // but never down a ledge: where the surface falls away from the plane
    // under the feet, stay on that plane and fade out.
    if (onSurface) {
      vec2 grad = -n.xz / max(n.y, 0.2);
      float plane = s0 + dot(grad, off);
      float sy = surfaceY(p.xz);
      float drop = plane - sy;
      // Faded from a small drop, so nothing of the blob reaches past a deck's
      // or quay's edge onto its side face.
      vEdge = 1.0 - smoothstep(0.05, 0.15, drop);
      p.y = drop > LEDGE ? plane : sy;
      // On a deck: the fragment clips at the deck's own edge as well, exactly,
      // however far apart the quad's vertices are.
      int di = deckIndexAt(base.xz);
      if (di >= 0 && base.y > groundHeight(base.xz) + 0.25) {
        vDeckAB = uDeckAB[di];
        vDeckHalf = uDeckHalf[di];
      }
    } else {
      p.y = base.y;
    }
    // A little more lift on steep ground so the draped quad never dips under it.
    transformed = p + vec3(0.0, 0.05 + 0.25 * (1.0 - n.y), 0.0);
    vWorldY = p.y;
    vWorldXZ = p.xz;
    vLocal = vec2(along, across);
    vShape = vec4(len, r0, r1, sun);
    vContact = rc;
    // The ground's rise per metre in the blob's own frame, so the fragment can
    // measure distances along the surface (a circle on a slope, not in plan).
    vec2 grad = -n.xz / max(n.y, 0.2);
    vSlope = vec2(dot(grad, away), dot(grad, side));
  #endif
  }
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BLOB_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
uniform vec3 uSunDir;
varying float vWorldY;
// Ground light factor in full shadow: about the sky-lit share (0.34).
const float SHADE_DEPTH = 0.66;
#define BLOB_BIG 60000.0
varying float vEdge;
varying vec4 vDeckAB;
varying float vDeckHalf;
varying vec2 vWorldXZ;
uniform float uNight;
uniform float uStrength;
uniform float uTime;
#ifdef BLOB_LAMP
uniform vec3 uPoolColor;
varying vec3 vLamp;
#endif
varying vec2 vUv;
varying float vWade;
varying vec2 vLocal;
varying vec4 vShape;
varying float vContact;
varying vec2 vSlope;
// Smooth bump: 1 at the centre, 0 with zero slope at x = 1 (gaussian-like, no edge).
float bump(float x) {
  float k = max(1.0 - x * x, 0.0);
  return k * k * k;
}
void main() {
  #if defined(BLOB_COVER) || defined(BLOB_LAMP)
    if (vWade > 0.5) discard;
  #endif
  if (vWade > 0.5) {
    // Two soft rings breathing outward around the legs.
    float r = length(vUv);
    float ring = 1.0 - smoothstep(0.0, 0.09, abs(r - (0.55 + 0.18 * sin(uTime * 3.0))));
    ring = max(ring, (1.0 - smoothstep(0.0, 0.06, abs(r - 0.3))) * 0.6);
    float a = ring * 0.45 * (1.0 - smoothstep(0.85, 1.0, r));
    #ifdef USE_FOG
      a *= 1.0 - hvHazeAmount(vFogDepth);
    #endif
    // Apply pass: the water brightens by up to ~1.4x. Min pass: nothing.
    #ifdef BLOB_APPLY
      gl_FragColor = vec4(vec3(0.9 * a), 1.0);
    #else
      gl_FragColor = vec4(vec3(BLOB_BIG), 1.0);
    #endif
  } else {
    // Contact: a small, faint round blob right under the walker, the same in
    // every pose. It only blends the cast into the feet (no gap at the soles).
    // Distance along the ground surface (the height change counts), so the
    // blob stays round on a slope instead of smearing down it.
    float rise = dot(vSlope, vLocal);
    float contact = bump(sqrt(dot(vLocal, vLocal) + rise * rise) / vContact) * uStrength * (1.0 - 0.5 * uNight);
    // Sun: distance to the feet-to-tip segment against a radius that grows
    // toward the tip. Round caps at both ends, convex everywhere.
    float len = vShape.x;
    float t = len > 1e-3 ? clamp(vLocal.x / len, 0.0, 1.0) : 0.0;
    // Narrower across than along (a body, not a disc); still convex.
    float dist = length(vec2(vLocal.x - t * len, vLocal.y * 1.3));
    float sunA = bump(dist / mix(vShape.y, vShape.z, t)) * mix(1.0, 0.5, t) * 0.74 * vShape.w;
    // Union of the two (no crease where they meet); faded where held up over a ledge.
    // vEdge is blended linearly across each triangle; sharpened here so only
    // the part over the walking surface shows, not a half-faded wash beyond it.
    float keep = smoothstep(0.7, 1.0, vEdge);
    // A walker on a deck: nothing past the deck's edge (onto a parapet or its side).
    if (vDeckHalf > 0.0) {
      vec2 d = vDeckAB.zw - vDeckAB.xy;
      float t = dot(vWorldXZ - vDeckAB.xy, d) / max(dot(d, d), 1e-6);
      float off = length(vWorldXZ - (vDeckAB.xy + d * clamp(t, 0.0, 1.0)));
      keep *= 1.0 - smoothstep(vDeckHalf - 0.35, vDeckHalf - 0.2, off);
    }
    // Haze thins the shadow with distance (hvAtmosphere's curve, atmosphere.js).
    #ifdef USE_FOG
      keep *= 1.0 - hvHazeAmount(vFogDepth);
    #endif
    float a = (1.0 - (1.0 - contact) * (1.0 - sunA)) * keep;
    // Min pass: colour untouched (BLOB_BIG is above any HDR value), alpha the
    // light factor, so the darkest blob at a pixel wins. Apply pass: colour
    // times that factor (src 0), alpha back to 1. It multiplies the ground, so
    // it keeps the ground's own colour at noon, at dusk and on snow.
    #ifdef BLOB_COVER
      // The shadow surface (shadowsurface.js): how much of the sun the walker
      // blocks here (a body blocks it all at the core), the contact, and the
      // height of the surface it lies on. The lighting takes the sun away.
      float t2 = len > 1e-3 ? clamp(vLocal.x / len, 0.0, 1.0) : 0.0;
      float blocked = bump(dist / mix(vShape.y, vShape.z, t2)) * mix(1.0, 0.7, t2) * step(1e-3, vShape.w) * keep;
      gl_FragColor = vec4(blocked, contact * 0.66 * keep, vWorldY, 1.0);
    #elif defined(BLOB_LAMP)
      // Take back the lamp pool's light (the same falloff as the pool,
      // props.js) where the walker blocks it. Blending: rgb = dst - src *
      // dstAlpha, alpha = dstAlpha * (1 - blocked), so overlapping walkers
      // block the union and it never goes darker than the unlit ground.
      float tL = len > 1e-3 ? clamp(vLocal.x / len, 0.0, 1.0) : 0.0;
      float blockedL = bump(dist / mix(vShape.y, vShape.z, tL)) * mix(1.0, 0.55, tL) * vShape.w * keep * 0.85;
      vec2 q = (vWorldXZ - vLamp.xy) / vLamp.z;
      float pool = max(1.0 - dot(q, q), 0.0);
      pool = pool * pool * smoothstep(0.25, 0.75, uNight) * 0.42;
      gl_FragColor = vec4(uPoolColor * pool * blockedL, blockedL);
    #else
      discard;
    #endif
  }
}
`;

// Heading a row asks for, as the vertex shader reads it: the direction of
// travel when moving, else the stored facing.
function rowHeading(a, o) {
  const vx = a[o + 3], vz = a[o + 5];
  return Math.hypot(vx, vz) > 0.05 ? Math.atan2(vx, vz) : a[o + 15];
}
const wrapAngle = (d) => d - Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
/** CPU twin of easedYaw(): the heading on show at `now`. */
function shownHeading(from, t0, target, slow, now) {
  const x = Math.min(1, Math.max(0, (now - t0) / (slow ? 0.4 : 0.25)));
  return from + wrapAngle(target - from) * (x * x * (3 - 2 * x));
}

// CPU twin of the held rod (rodVertex, action 8, cast landed, no bob): where its tip is
// in the figure's own units, forward of the feet (+z) and up. Mirrors the hand
// (swingX/swingZ about the right shoulder by the fish pose's arm angles) and ROD_LEN
// along the held angle.
const ROD = { len: 2.1, hold: 0.55, arm: 0.85, out: 0.12, hand: [-0.30, 0.76, 0.06], shoulder: [-0.29, 1.24, 0] };
export function rodTip() {
  const [hx, hy, hz] = ROD.hand, [sx, sy, sz] = ROD.shoulder;
  // swingX about the shoulder by the arm angle...
  let dx = hx - sx, dy = hy - sy, dz = hz - sz;
  const c = Math.cos(ROD.arm), sn = Math.sin(ROD.arm);
  [dy, dz] = [dy * c + dz * sn, -dy * sn + dz * c];
  // ...then swingZ by -out.
  const cz = Math.cos(-ROD.out), sz2 = Math.sin(-ROD.out);
  [dx, dy] = [dx * cz - dy * sz2, dx * sz2 + dy * cz];
  return { forward: sz + dz + ROD.len * Math.cos(ROD.hold), up: sy + dy + ROD.len * Math.sin(ROD.hold) };
}
const ROD_TIP = rodTip();

/** The water surface under an angler's rod tip, for a row at (x, z) facing `heading`,
 * drawn at `scale` (row scale times the figure scale): what the line hangs down to. */
export function fishLineWater(x, z, heading, scale) {
  const d = ROD_TIP.forward * scale;
  return surfaceLevelAt(x + Math.sin(heading) * d, z + Math.cos(heading) * d);
}

// ---------------------------------------------------------------------------

export function createPeople(ctx) {
  const { scene, grade, lights } = ctx;
  const baseGeometry = buildVillagerGeometry();
  // Subdivided along its length so a long low-sun blob lies on the slope.
  const blobBase = new THREE.PlaneGeometry(2, 2, 2, 8).rotateX(-Math.PI / 2);

  // Bridge decks near the view (setDecks): the blob's surface and the feet's.
  const deckUniforms = {
    uDeckN: { value: 0 },
    uDeckAB: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uDeckHalf: { value: new Array(8).fill(0) },
    uDeckH: { value: Array.from({ length: 40 }, () => new THREE.Vector4()) },
    uDeckRail: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) },
  };
  const lodUniforms = {
    uLodNear: { value: 120 },
    uIkNear: { value: 70 },
    uLodFar: { value: 260 },
    // Slightly toy-scaled (~1.9 m) so figures read at the default camera distance.
    uFigureScale: { value: 1.1 },
    uShadowFocus: { value: new THREE.Vector3() },
    uTurnEase: { value: 1 },
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
    uniforms: { ...lodUniforms, ...paletteUniforms, ...deckUniforms },
    vertexHead: DRAPE_GLSL + POSE_HEAD + COLOR_HEAD,
    vertexBegin: /* glsl */ `
      transformed = personPosition(position);
      vPersonColor = personColor();
    `,
    fragmentHead: 'varying vec3 vPersonColor;\n',
    fragmentColor: 'diffuseColor.rgb = vPersonColor * uTint;\n',
  });

  // Shadow caster (opt-in 'full' people shadows): same pose; only people near
  // the view target cast, since the shadow map refreshes at a few Hz at most.
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms, lodUniforms, deckUniforms);
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
    uFigureScale: lodUniforms.uFigureScale,
    // Shared with the grade, which sets it every frame.
    uSunDir: grade.uniforms.uSunDir,
    uSunShadow: { value: 1 },
    uStrength: { value: 0.26 },
    ...deckUniforms,
    uEye: ctx.shadowSurface?.uniforms.uEye ?? { value: new THREE.Vector3() },
  });
  const blobOptions = {
    uniforms: blobUniforms,
    vertexShader: BLOB_VERT,
    fragmentShader: BLOB_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    blending: THREE.CustomBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  };
  // Pass 1: min(dst, src) per channel (blend factors unused): alpha keeps the
  // darkest light factor, colour is untouched (the src colour is huge).
  // The shadow surface pass (shadowsurface.js): coverage is the union (MAX).
  const blobMaterial = new THREE.ShaderMaterial({
    ...blobOptions,
    defines: { BLOB_COVER: 1 },
    fog: false,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    polygonOffset: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  // Pass 2: rgb = src * dst + dst * dstAlpha (src 0: dst times the factor; a
  // ripple's src brightens), alpha = 1. Each pixel is darkened once.
  const blobApplyMaterial = new THREE.ShaderMaterial({
    ...blobOptions,
    defines: { BLOB_APPLY: 1 },
    // Its quad is flat and loose (BLOB_VERT): no depth test, nothing to lose.
    depthTest: false,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.DstAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.ZeroFactor,
  });

  // Walkers' shadows from the street lamps at night, High tier only
  // (props.js fills uLamps with the lamps nearest the view).
  const lampShadow = { uLamps: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) }, uLampN: { value: 0 } };
  ctx.lampShadow = lampShadow;
  const blobLampMaterial = new THREE.ShaderMaterial({
    ...blobOptions,
    uniforms: { ...blobUniforms, ...lampShadow, uPoolColor: { value: new THREE.Color('#ffb866') } },
    defines: { BLOB_LAMP: 1 },
    // The frame's alpha is 1 on the ground (pools and ripples keep it); post
    // ignores it, so here it carries the pool light still unblocked.
    blending: THREE.CustomBlending,
    blendEquation: THREE.ReverseSubtractEquation,
    blendSrc: THREE.DstAlphaFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });

  const mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), material);
  mesh.name = 'people';
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.customDepthMaterial = depthMaterial;
  mesh.visible = false;
  // Shadows: drawn into the shadow surface before the frame (shadowsurface.js).
  const blobs = new THREE.Mesh(new THREE.InstancedBufferGeometry(), blobMaterial);
  blobs.name = 'people-blobs';
  blobs.frustumCulled = false;
  blobs.visible = false;
  // On screen, only the ripple rings of waders at a ford.
  const blobsApply = new THREE.Mesh(blobs.geometry, blobApplyMaterial);
  blobsApply.name = 'people-blobs-apply';
  blobsApply.frustumCulled = false;
  blobsApply.renderOrder = 1.51;
  blobsApply.visible = false;
  const blobsLamp = new THREE.Mesh(blobs.geometry, blobLampMaterial);
  blobsLamp.name = 'people-blobs-lamp';
  blobsLamp.frustumCulled = false;
  blobsLamp.renderOrder = 1.55; // after the lamp pools (props marks, 1) and the ripples (alpha back to 1)
  blobsLamp.visible = false;
  scene.add(mesh, blobsApply, blobsLamp);
  (ctx.shadowSurface?.scene ?? scene).add(blobs);

  let stride = STRIDE; // 16, or 20 when the view carries segment ends
  let fadeAttr = null;   // per-row [change time, scale before]
  let prevScale = null;
  let turnAttr = null;   // per-row [heading shown at the last change, change time, an angler's water level]
  let turnTarget = null; // per-row heading the row asked for at that change
  let turnSlow = null;   // per-row 1 when that change was a stander's (slower) turn
  let boundArray = null;
  let boundVersion = -1;
  let buffer = null;
  let count = 0;
  let castShadow = false;
  // People shadows: 'blob' (sun-aware blob only, the default) or 'full'
  // (also cast into the shadow map, where the tier has one).
  let shadowMode = 'blob';
  let contactOnly = false; // only the round blob under the feet (full shadows, or the low tier)
  let tierQuality = ctx.quality;
  let lampShadows = false; // tier allows walkers' lamp shadows

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
    for (const m of [blobMaterial, blobApplyMaterial, blobLampMaterial]) {
      if (!!m.defines?.SEGMENT_END !== segment) {
        m.defines = { ...(m.defines ?? {}) };
        if (segment) m.defines.SEGMENT_END = 1; else delete m.defines.SEGMENT_END;
        m.needsUpdate = true;
      }
    }
    const rows = Math.floor(array.length / stride);
    fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(rows * 2), 2);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    prevScale = new Float32Array(rows);
    for (let i = 0; i < rows; i++) prevScale[i] = array[i * stride + 14];
    // Turns start settled: shown heading = the row's heading, long ago.
    const turns = new Float32Array(rows * 3);
    turnTarget = new Float32Array(rows);
    turnSlow = new Uint8Array(rows);
    for (let i = 0; i < rows; i++) {
      const h = rowHeading(array, i * stride);
      turnTarget[i] = h;
      turns[i * 3] = h;
      turns[i * 3 + 1] = -1e4;
      turns[i * 3 + 2] = lineWater(array, i * stride, h);
    }
    turnAttr = new THREE.InstancedBufferAttribute(turns, 3);
    turnAttr.setUsage(THREE.DynamicDrawUsage);
    buffer = new THREE.InstancedInterleavedBuffer(array, stride);
    buffer.setUsage(THREE.DynamicDrawUsage);
    const attrs = {
      iPos: new THREE.InterleavedBufferAttribute(buffer, 3, 0),
      iVel: new THREE.InterleavedBufferAttribute(buffer, 3, 3),
      iA: new THREE.InterleavedBufferAttribute(buffer, 4, 6),
      iB: new THREE.InterleavedBufferAttribute(buffer, 4, 10),
      iC: new THREE.InterleavedBufferAttribute(buffer, 2, 14),
      iFade: fadeAttr,
      iTurn: turnAttr,
    };
    if (segment) attrs.iD = new THREE.InterleavedBufferAttribute(buffer, 4, 16);
    const g = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'normal', 'aBone', 'aPart']) g.setAttribute(name, baseGeometry.getAttribute(name));
    for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, a);
    const b = new THREE.InstancedBufferGeometry();
    b.setAttribute('position', blobBase.getAttribute('position'));
    b.setIndex(blobBase.getIndex());
    for (const name of ['iPos', 'iVel', 'iA', 'iB', 'iC', 'iFade', ...(segment ? ['iD'] : [])]) b.setAttribute(name, attrs[name]);
    // Disposing the old geometries frees the old GPU buffers.
    mesh.geometry.dispose();
    blobs.geometry.dispose();
    mesh.geometry = g;
    blobs.geometry = b;
    blobsApply.geometry = b;
    blobsLamp.geometry = b;
    boundArray = array;
    boundVersion = version;
  }

  function update(view, frame) {
    lastView = view;
    const array = view?.people;
    if (!array || !array.length) {
      mesh.visible = blobs.visible = blobsApply.visible = marker.visible = false;
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
    mesh.visible = blobs.visible = blobsApply.visible = count > 0;
    blobsLamp.visible = lampShadows && count > 0 && lampShadow.uLampN.value > 0 && grade.uniforms.uNight.value > 0.2;

    updateMarker(frame.time);
    syncTurnEase();

    setDecks(view, frame);

    // Direct-sun share for the blob, every drawn frame: rain dims the sun.
    blobUniforms.uSunShadow.value = contactOnly ? 0 : Math.min(1, (grade.current?.sunI ?? 2.8) / 2.3);

    if (castShadow && count > 0) {
      lodUniforms.uShadowFocus.value.copy(frame.target);
      // Moving casters: refresh the shadow map with them (every frame on high,
      // 30 Hz below; lights.js).
      lights.animateFor(0.3, frame.time, { follow: true });
    }
  }

  // The finished bridges nearest the view target, for the blob's surface and
  // the feet on a deck (surfaceY). Redone every couple of seconds (a bridge may have been
  // finished) or when the view moves on; heights come from the sim's deckProfile.
  let decksTime = -Infinity, decksAt = null;
  function setDecks(view, frame) {
    const list = view.buildings;
    if (!list) return;
    const t = frame.target;
    const moved = !decksAt || (decksAt.x - t.x) ** 2 + (decksAt.z - t.z) ** 2 > 40 * 40;
    if (!moved && frame.time - decksTime < 2) return;
    decksTime = frame.time;
    decksAt = { x: t.x, z: t.z };
    const decks = list.filter((b) => b.type === 'bridge' && b.a && b.b && (b.built ?? 1) >= 1)
      .map((b) => ({ b, d: ((b.a.x + b.b.x) / 2 - t.x) ** 2 + ((b.a.z + b.b.z) / 2 - t.z) ** 2 }))
      .sort((p, q) => p.d - q.d).slice(0, 8);
    const u = deckUniforms;
    u.uDeckN.value = decks.length;
    decks.forEach(({ b }, i) => {
      u.uDeckAB.value[i].set(b.a.x, b.a.z, b.b.x, b.b.z);
      // The drawn deck's half-width (footbridges are drawn 1.3 wide, not their record's 2).
      u.uDeckHalf.value[i] = (b.style ?? b.variant) === 'footbridge' ? 0.65 : (b.width ?? b.d ?? 3) / 2;
      const h = [];
      for (let k = 0; k < 20; k++) h.push(deckProfile(b, k / 19));
      for (let j = 0; j < 5; j++) u.uDeckH.value[i * 5 + j].set(h[j * 4], h[j * 4 + 1], h[j * 4 + 2], h[j * 4 + 3]);
      // Where a leaner's hands go (gatherings.js railInner, RAIL_TOP): the rail's
      // top, at the middle of its width (timber 0.13, a stone coping 0.36, iron 0.16).
      const style = railStyle(b);
      u.uDeckRail.value[i].set(RAIL_TOP[style] ?? 0.95, railInner(b) + (style === 'stone' ? 0.18 : style === 'iron' ? 0.08 : 0.065));
    });
  }

  /** Note rows that just went indoors or came out (door fade) or turned (heading ease). */
  function markFades(array, start, end, now) {
    const f = fadeAttr.array;
    const tr = turnAttr.array;
    let lo = Infinity, hi = -1, tlo = Infinity, thi = -1;
    for (let i = start; i < end; i++) {
      const o = i * stride;
      const s = array[o + 14];
      const prev = prevScale[i];
      if ((s < 0.01) !== (prev < 0.01)) {
        f[i * 2] = now;
        f[i * 2 + 1] = prev;
        if (i < lo) lo = i;
        if (i > hi) hi = i;
      }
      prevScale[i] = s;
      // Heading change: restart the ease from what the walker shows right
      // now (mid-turn included), so an interrupted turn never jumps.
      const h = rowHeading(array, o);
      // An angler's line hangs to the water under the rod's tip.
      const w = lineWater(array, o, h);
      if (w !== tr[i * 3 + 2]) {
        tr[i * 3 + 2] = w;
        if (i < tlo) tlo = i;
        if (i > thi) thi = i;
      }
      if (Math.abs(wrapAngle(h - turnTarget[i])) > 0.01) {
        tr[i * 3] = shownHeading(tr[i * 3], tr[i * 3 + 1], turnTarget[i], turnSlow[i], now);
        tr[i * 3 + 1] = now;
        turnTarget[i] = h;
        turnSlow[i] = Math.hypot(array[o + 3], array[o + 5]) > 0.05 ? 0 : 1;
        if (i < tlo) tlo = i;
        if (i > thi) thi = i;
      }
    }
    if (hi >= lo) {
      fadeAttr.clearUpdateRanges();
      fadeAttr.addUpdateRange(lo * 2, (hi - lo + 1) * 2);
      fadeAttr.needsUpdate = true;
    }
    if (thi >= tlo) {
      turnAttr.clearUpdateRanges();
      turnAttr.addUpdateRange(tlo * 3, (thi - tlo + 1) * 3);
      turnAttr.needsUpdate = true;
    }
  }

  // The water level an angler's line reaches (action 8 rows), else -1e4.
  function lineWater(array, o, heading) {
    if (Math.round(array[o + 9]) !== 8) return -1e4;
    return fishLineWater(array[o], array[o + 2], heading, array[o + 14] * lodUniforms.uFigureScale.value);
  }

  // Reduced motion keeps the sim's instant turns.
  function syncTurnEase() {
    lodUniforms.uTurnEase.value = ctx.reducedMotion ? 0 : 1;
  }

  function applyQuality(q) {
    tierQuality = q;
    lampShadows = Boolean(q.lampShadows);
    castShadow = shadowMode === 'full' && q.shadowMapSize > 0;
    mesh.castShadow = castShadow;
    const near = q.name === 'low' ? 90 : q.name === 'high' ? 140 : 120;
    lodUniforms.uLodNear.value = near;
    lodUniforms.uLodFar.value = q.name === 'low' ? 200 : q.name === 'high' ? 300 : 260;
    // Low tier: the simple round blob only, no cast (and no shadow-map taps).
    contactOnly = castShadow || q.name === 'low';
    // Contact strength: faint under the blob cast; a light touch under a real
    // shadow; a little darker when it is the whole shadow.
    blobUniforms.uStrength.value = castShadow ? 0.28 : contactOnly ? 0.36 : 0.26;
    blobUniforms.uSunShadow.value = contactOnly ? 0 : 1;
    lights.markDirty();
  }
  applyQuality(ctx.quality);

  /** 'blob' (default) or 'full' (people also cast into the shadow map). */
  function setShadowMode(mode) {
    const next = mode === 'full' ? 'full' : 'blob';
    if (next === shadowMode) return;
    shadowMode = next;
    applyQuality(tierQuality);
  }

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
      if ((stride >= 20 && y > FORD_BED + 0.01) || Math.abs(y - g) < DRAPE_TOLERANCE) y = g;
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
    setShadowMode,
    shadowMode: () => shadowMode,
    pick,
    positionOf,
    setSelected,
    selected: () => selectedId,
    count: () => count,
    dispose() {
      scene.remove(mesh, blobs, blobsApply, marker);
      markerGeometry.dispose();
      markerMaterial.dispose();
      mesh.geometry.dispose();
      blobs.geometry.dispose();
      baseGeometry.dispose();
      blobBase.dispose();
      material.dispose();
      depthMaterial.dispose();
      blobMaterial.dispose();
      blobApplyMaterial.dispose();
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
