import * as THREE from 'three';
import * as Terrain from '../terrain.js';
// Fallback deck height for bridge records without deckY (the sim no longer
// exports one; every current record carries its own deckY).
const BRIDGE_DECK = 0.9;
import * as Bridges from '../sim/bridges.js';
import { patchMaterial, hashId, LAYER_REFLECT } from './shaderlib.js';
import { GROUND_GLSL } from './ground.js';
import { createFleet, planReaches, boatPose, BOAT_POSE_GLSL } from './boats.js';

// Props (design-visual §2.4, §5, §7): bridges (timber, stone, iron,
// footbridges; built from both banks while under construction), embankment
// walls with towpath copings, steps, ford ramps and slipways, square and
// avenue furniture, street lamps with their glow and warm light pools, event
// dressing and work-site dressing (stalls, bunting, placards, stone piles,
// scaffolds), pennants that flag a body's open docket card, boats and birds.
// Ten draw calls.
// Geometry is rebuilt only when its source list changes; boats, birds and
// pennants move in the vertex shader. Nothing here draws a flat disc at one
// height: ground marks drape on the shared ground texture.

const { riverX } = Terrain;
// Read live: the terrain seed sets the channel half-width.
const waterHalf = () => Terrain.WATER_HALF;

// People walk at this height on bridge cells. Set per bridge from deckY when
// the view provides one (builders read it while that bridge is built).
let DECK_Y = BRIDGE_DECK;
const MAX_LAMPS = 1500;
const MAX_GLOWS = 340;
const MAX_STALLS = 120;
const MAX_BOXES = 700;
const MAX_FLAGS = 900;
const MAX_MARKS = 40;
const MAX_POOLS = 300;
const MAX_PENNANTS = 24;
const POOL_RADIUS = 4.6; // a lamp's light pool on the ground (m)
const LANTERN_Y = 2.72;  // the lantern's centre above the lamp's base (lampGeometry)

/** A lamp's arm angle (its instance rotation) and its lantern, 0.52 m out along the arm. */
function lampArm(x, z) {
  const r = Math.floor(hashId(Math.round(x * 3 + z * 7), 1) * 4) * Math.PI / 2;
  return { r, lx: x + Math.cos(r) * 0.52, lz: z - Math.sin(r) * 0.52 };
}

const col = (h) => new THREE.Color(h);
const C = {
  plank: col('#9a7a52'), plankDark: col('#7a5d3e'), pile: col('#5f4a33'), rope: col('#d9c9a0'),
  stone: col('#bba98a'), stoneDark: col('#8f8470'), setts: col('#8e8a80'), coping: col('#d6ccb4'),
  iron: col('#4f5d58'), ironDark: col('#3a4542'), lampIron: col('#2f3634'), lampGlass: col('#f2d9a0'),
  wood: col('#8c6a44'), cream: col('#efe6cf'),
};
const FLAG_FESTIVAL = ['#b2563f', '#c9a24a', '#3f6f8a', '#526d42', '#efe6cf', '#a8553f'].map(col);
const FLAG_WEDDING = ['#efe6cf', '#e8c6cc', '#cfdde6', '#f1ead8'].map(col);
const FLAG_FUNERAL = ['#3b3f44', '#4a4f55'].map(col);
const PLACARD_BANDS = ['#b2563f', '#526d42', '#3f6f8a', '#c9a24a', '#7a4f6d'].map(col);
const AWNINGS = ['#b2563f', '#526d42', '#3f6f8a', '#c9a24a', '#7a4f6d', '#a8553f'].map(col);
const SCORCH = col('#2e2620');
const FLOOD = col('#4f7f86');
const POOL_COLOR = col('#ffb866');
const PRODUCE = ['#a63d2a', '#6f8f3a', '#d39a3a', '#c9a86a', '#8a3a4f'].map(col);
const WORK_KINDS_DRESSED = new Set(['embankment', 'square', 'widen', 'ring', 'grid', 'pave', 'quay']);
const W_COL = {
  gravel: col('#a8987a'), gravelEdge: col('#8a7c62'), setts: col('#8e8a80'), wet: col('#5f6460'),
  bench: col('#7a5d3e'), benchIron: col('#3a4542'), planter: col('#b3a184'), leaf: col('#5f8c4a'),
  leafDark: col('#4e7e52'), trunk: col('#6b5236'), ring: col('#2f3634'), bollard: col('#5f4a33'),
  shrub: col('#6a8f4c'),
};

// ---------------------------------------------------------------------------
// Geometry builder: flat-shaded triangles with per-vertex colour and an extra
// float (glow / part flag).

const UNIT_BOX = [
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
];
const BOX_FACES = [[4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6], [0, 4, 7, 3], [7, 6, 2, 3], [0, 1, 5, 4]];

export class Geo {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.e = [];
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.v = UNIT_BOX.map(() => new THREE.Vector3());
    this.ab = new THREE.Vector3(); this.ac = new THREE.Vector3(); this.nn = new THREE.Vector3();
  }

  tri(a, b, c, color, extra = 0) {
    this.ab.subVectors(b, a); this.ac.subVectors(c, a);
    this.nn.crossVectors(this.ab, this.ac).normalize();
    for (const v of [a, b, c]) {
      this.p.push(v.x, v.y, v.z);
      this.n.push(this.nn.x, this.nn.y, this.nn.z);
      this.c.push(color.r, color.g, color.b);
      this.e.push(extra);
    }
  }

  quad(a, b, c, d, color, extra = 0) {
    this.tri(a, b, c, color, extra);
    this.tri(a, c, d, color, extra);
  }

  /** Unit cube transformed by `matrix`. Skip faces with faces = {top:false, bottom:false}. */
  box(matrix, color, extra = 0, faces = {}) {
    for (let i = 0; i < 8; i++) this.v[i].fromArray(UNIT_BOX[i]).applyMatrix4(matrix);
    BOX_FACES.forEach((f, i) => {
      if ((i === 4 && faces.top === false) || (i === 5 && faces.bottom === false)) return;
      this.quad(this.v[f[0]], this.v[f[1]], this.v[f[2]], this.v[f[3]], color, extra);
    });
  }

  boxAt(x, y, z, sx, sy, sz, color, extra = 0, rotY = 0, faces) {
    this.q.setFromAxisAngle(Y_AXIS, rotY);
    this.m.compose(TMP.set(x, y, z), this.q, TMP2.set(sx, sy, sz));
    this.box(this.m, color, extra, faces);
  }

  /** Square beam of thickness t from a to b (oriented box). */
  beam(ax, ay, az, bx, by, bz, t, color, extra = 0, tz = t) {
    TMP.set(bx - ax, by - ay, bz - az);
    const len = TMP.length();
    this.q.setFromUnitVectors(X_AXIS, TMP.normalize());
    this.m.compose(TMP2.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), this.q, TMP3.set(len, t, tz));
    this.box(this.m, color, extra);
  }

  /** Copy the triangles of `src` whose centroid x passes `keep(x)`. */
  appendFiltered(src, keep) {
    for (let t = 0; t < src.p.length; t += 9) {
      const cx = (src.p[t] + src.p[t + 3] + src.p[t + 6]) / 3;
      if (!keep(cx)) continue;
      for (let k = 0; k < 9; k++) { this.p.push(src.p[t + k]); this.n.push(src.n[t + k]); this.c.push(src.c[t + k]); }
      const e = t / 3;
      this.e.push(src.e[e], src.e[e + 1], src.e[e + 2]);
    }
  }

  /** Low-poly blob (icosahedron) for canopies and shrubs. */
  blob(x, y, z, r, sy, color, extra = 0) {
    const ico = BLOB.attributes.position;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < ico.count; i += 3) {
      a.fromBufferAttribute(ico, i); b.fromBufferAttribute(ico, i + 1); c.fromBufferAttribute(ico, i + 2);
      for (const v of [a, b, c]) v.set(x + v.x * r, y + v.y * r * sy, z + v.z * r);
      this.tri(a, b, c, color, extra);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aExtra', new THREE.Float32BufferAttribute(this.e, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const BLOB = new THREE.IcosahedronGeometry(1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TMP3 = new THREE.Vector3();
/** Numeric id for hashing; event ids may be strings like 'e14:festival'. */
function numId(id) {
  if (typeof id === 'number') return id | 0;
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 1;
}

const jitter = (c, seed, amt = 0.12) => c.clone().multiplyScalar(1 - amt / 2 + amt * seed);

// ---------------------------------------------------------------------------
// Materials

// World-up of the shaded normal, for snow on up-facing surfaces.
const UP_VERT = /* glsl */ `
#ifdef USE_INSTANCING
  vUpW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;
#else
  vUpW = normalize(mat3(modelMatrix) * objectNormal).y;
#endif
`;
const SNOW_TINT = /* glsl */ `
  float snowP = smoothstep(0.25, 0.8, uSnow) * smoothstep(0.5, 0.85, vUpW);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.92, 0.95), snowP) * uTint;
`;

export function gradeLambert(grade, key, spec = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: !!spec.vertexColors, side: spec.side ?? THREE.FrontSide });
  patchMaterial(m, grade, {
    key: `props:${key}`,
    uniforms: spec.uniforms,
    vertexHead: 'varying float vUpW;\n' + (spec.vertexHead ?? ''),
    vertexNormal: spec.vertexNormal,
    vertexBegin: spec.vertexBegin,
    vertexEnd: UP_VERT + (spec.vertexEnd ?? ''),
    fragmentHead: 'varying float vUpW;\n' + (spec.fragmentHead ?? ''),
    fragmentColor: (spec.fragmentColor ?? '') + SNOW_TINT,
    fragmentEmissive: spec.fragmentEmissive,
  });
  return m;
}

// The river centreline and its slope for shaders, from a 1-unit lookup of
// riverX(z) (so any terrain seed works). Rebuilt when the seed changes.
const RIVER_N = 1024;
const RIVER_Z0 = -512;
const RIVER_GLSL = /* glsl */ `
uniform highp sampler2D tRiverPath;
vec2 riverAt(float z) {
  float p = clamp(z - float(${RIVER_Z0}), 0.0, float(${RIVER_N - 2}));
  float i = floor(p);
  vec2 a = texelFetch(tRiverPath, ivec2(int(i), 0), 0).rg;
  vec2 b = texelFetch(tRiverPath, ivec2(int(i) + 1, 0), 0).rg;
  return mix(a, b, p - i);
}
float riverXg(float z) { return riverAt(z).x; }
float riverDX(float z) { return riverAt(z).y; }
// Water surface height along the river (sim-world's waterLevelAt).
float riverLevel(float z) {
  float p = clamp(z - float(${RIVER_Z0}), 0.0, float(${RIVER_N - 2}));
  float i = floor(p);
  float a = texelFetch(tRiverPath, ivec2(int(i), 0), 0).b;
  float b = texelFetch(tRiverPath, ivec2(int(i) + 1, 0), 0).b;
  return mix(a, b, p - i);
}
`;

function createRiverPath() {
  const data = new Float32Array(RIVER_N * 4);
  const texture = new THREE.DataTexture(data, RIVER_N, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.NoColorSpace;
  let seed;
  return {
    uniform: { value: texture },
    /** Refill when the terrain seed changes (cheap: 1,024 samples). */
    sync() {
      const s = Terrain.terrainKey();
      if (s === seed) return;
      seed = s;
      for (let i = 0; i < RIVER_N; i++) {
        const z = RIVER_Z0 + i;
        data[i * 4] = riverX(z);
        data[i * 4 + 1] = riverX(z + 0.5) - riverX(z - 0.5);
        data[i * 4 + 2] = typeof Terrain.waterLevelAt === 'function' ? Terrain.waterLevelAt(z) : 0.025;
      }
      texture.needsUpdate = true;
    },
    dispose: () => texture.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Bridges

// Ground for draping ramps (set by rebuildBridges: the shared ground sampler).
let groundAt = (x, z) => Terrain.heightAt(x, z);

/** Highest ground under a level footprint (half extents hx, hz): seat props on it. */
function groundMaxAt(x, z, hx, hz) {
  let m = groundAt(x, z);
  for (const [dx, dz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]]) m = Math.max(m, groundAt(x + dx, z + dz));
  return m;
}

/**
 * Bridges with endpoints a -> b (the new contract) are built in a canonical
 * frame (span along x, centred, z = 0) and rotated into place, so every
 * builder works at any river angle. Legacy {z, x0, x1} bridges use the world
 * frame directly (their span is along x, as the sim's bridge cells are).
 */
function bridgeFrame(b, heightAt) {
  if (!(b.a && b.b)) return { rec: b, height: heightAt, place: null };
  const dx = b.b.x - b.a.x, dz = b.b.z - b.a.z;
  const L = Math.hypot(dx, dz) || 1;
  const cos = dx / L, sin = dz / L;
  const mx = (b.a.x + b.b.x) / 2, mz = (b.a.z + b.b.z) / 2;
  const toWorld = (x, z) => [mx + x * cos - z * sin, mz + x * sin + z * cos];
  const height = (x, z) => heightAt(...toWorld(x, z));
  // Where the span crosses the river centreline, by bisection along it.
  const off = (x) => { const [wx, wz] = toWorld(x, 0); return wx - riverX(wz); };
  let lo = -L / 2, hi = L / 2;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (Math.sign(off(m)) === Math.sign(off(lo))) lo = m; else hi = m;
  }
  const rec = { ...b, z: 0, x0: -L / 2, x1: L / 2, cx: (lo + hi) / 2 };
  return { rec, height, place: { cos, sin, mx, mz } };
}

/** Append `src` into `dst`, rotated about y by (cos, sin) and moved to (mx, mz). */
function appendPlaced(dst, src, { cos, sin, mx, mz }) {
  for (let i = 0; i < src.p.length; i += 3) {
    const x = src.p[i], z = src.p[i + 2];
    dst.p.push(mx + x * cos - z * sin, src.p[i + 1], mz + x * sin + z * cos);
    const nx = src.n[i], nz = src.n[i + 2];
    dst.n.push(nx * cos - nz * sin, src.n[i + 1], nx * sin + nz * cos);
  }
  for (const c of src.c) dst.c.push(c);
  for (const e of src.e) dst.e.push(e);
}

// ---------------------------------------------------------------------------
// The walking surface. Every bridge's deck top, parapets and rails follow one
// profile along the span, the same one walkers stand on (sim-world's
// deckProfile when present, else a mirror of its deckHeightAt: a line between
// the bank heights at a and b, rising to deckY over the first and last 3 m).
// Arches, piles and trusses hang underneath; nothing invents its own height.

const RAMP_LEN = 3;
let deckAt = () => DECK_Y;

/** Set the profile for one bridge, in its canonical frame (span x0..x1). */
function setDeckProfile(src, b) {
  const L = Math.max(1e-3, b.x1 - b.x0);
  const deckY = src.deckY ?? BRIDGE_DECK;
  const ha = src.a ? Terrain.heightAt(src.a.x, src.a.z) : Terrain.heightAt(b.x0, b.z);
  const hb = src.b ? Terrain.heightAt(src.b.x, src.b.z) : Terrain.heightAt(b.x1, b.z);
  const profile = typeof Bridges.deckProfile === 'function' && src.a ? (t) => Bridges.deckProfile(src, t) : null;
  deckAt = (x) => {
    const t = Math.max(0, Math.min(1, (x - b.x0) / L));
    if (profile) return profile(t);
    const ends = ha * (1 - t) + hb * t;
    const ramp = Math.min(1, (Math.min(t, 1 - t) * L) / RAMP_LEN);
    return ends + (deckY - ends) * ramp;
  };
}

/** Sample points along [xa, xb]: denser on the ramps, every metre elsewhere. */
function deckStations(xa, xb, x0, x1) {
  const pts = [];
  for (let x = xa; x < xb - 1e-3;) {
    pts.push(x);
    const onRamp = x < x0 + RAMP_LEN || x > x1 - RAMP_LEN - 0.75;
    x = Math.min(xb, x + (onRamp ? 0.75 : 1.5));
  }
  pts.push(xb);
  return pts;
}

/** A slab whose top follows the deck profile (+dy), from xa to xb. */
function profileSlab(g, xa, xb, x0, x1, z, width, thick, color, dy = 0) {
  const pts = deckStations(xa, xb, x0, x1);
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], c = pts[k];
    g.beam(a, deckAt(a) + dy - thick / 2, z, c, deckAt(c) + dy - thick / 2, z, thick, color, 0, width);
  }
}

/**
 * Footbridge: a narrow walkway of uneven planks on timber posts, low over a
 * ford, with a pole-and-rope handrail; the planks run bank to bank.
 */
export function buildFoot(g, b, heightAt, limit = Infinity) {
  const { z, x0, x1 } = b;
  const W = 1.3;
  const end = Math.min(x1, limit);
  // Posts in pairs every ~2 m, from the bed to just under the planks.
  for (let x = x0 + RAMP_LEN * 0.8; x <= x1 - RAMP_LEN * 0.8 + 0.01 && x <= end; x += 2) {
    const top = deckAt(x) - 0.15;
    for (const s of [-1, 1]) g.boxAt(x, (top - 0.9) / 2, z + s * (W / 2 - 0.08), 0.16, top + 0.9, 0.16, C.pile);
    g.boxAt(x, top - 0.02, z, 0.18, 0.12, W + 0.2, C.pile);
  }
  // Uneven planks: each a little higher or lower, wider or narrower, skewed;
  // level boards stepping along the profile like a real plank ramp.
  let i = 0;
  for (let x = x0; x < end - 0.05; i++) {
    const h = hashId(numId(b.id) * 131 + i, 3);
    const w = 0.3 + 0.12 * h;
    g.boxAt(x + w / 2, deckAt(x + w / 2) - 0.05 + (h - 0.5) * 0.04, z + (hashId(i, 4) - 0.5) * 0.08, w - 0.04, 0.09, W + (h - 0.5) * 0.2,
      jitter(C.plank, hashId(numId(b.id) * 97 + i, 1), 0.28), 0, (h - 0.5) * 0.08);
    x += w;
  }
  // Handrail on the span: poles, a sagging rope on one side, a pole rail on the other.
  const ra = x0 + RAMP_LEN * 0.6, rb = Math.min(x1 - RAMP_LEN * 0.6, end);
  for (const s of [-1, 1]) {
    const zs = z + s * (W / 2 - 0.05);
    let px = null;
    for (let x = ra; x <= rb + 0.01; x += 2) {
      g.boxAt(x, deckAt(x) + 0.5, zs, 0.08, 1.0, 0.08, C.pile);
      if (px !== null) {
        if (s > 0) {
          const mx = (px + x) / 2;
          g.beam(px, deckAt(px) + 0.95, zs, mx, deckAt(mx) + 0.82, zs, 0.035, C.rope);
          g.beam(mx, deckAt(mx) + 0.82, zs, x, deckAt(x) + 0.95, zs, 0.035, C.rope);
        } else {
          g.beam(px, deckAt(px) + 0.92, zs, x, deckAt(x) + 0.92, zs, 0.06, C.plankDark);
        }
      }
      px = x;
    }
  }
}

/** Scaffold and timber stacks at the growing ends of a bridge under construction. */
function bridgeWorks(g, b, W, ends) {
  for (const x of ends) {
    const top = deckAt(x);
    for (const dx of [-0.6, 0.6]) {
      for (const s of [-1, 1]) g.boxAt(x + dx, (top + 1.6 - 0.9) / 2, b.z + s * (W / 2 + 0.3), 0.1, top + 1.6 + 0.9, 0.1, C.plankDark);
    }
    for (const y of [top + 0.4, top + 1.4]) {
      for (const s of [-1, 1]) g.boxAt(x, y, b.z + s * (W / 2 + 0.3), 1.4, 0.07, 0.35, C.plank);
    }
  }
  // Timber stacked flat on both banks, set back from the edge and seated on
  // the highest ground under the stack so it never cuts into a slope.
  for (const [x, dir] of [[b.x0 - 3.5, -1], [b.x1 + 3.5, 1]]) {
    const zs = b.z + W + 0.8;
    const y = Math.max(0.05, groundMaxAt(x, zs, 1.4, 0.5));
    for (let k = 0; k < 4; k++) g.boxAt(x + dir * 0.1 * k, y + 0.08 + k * 0.16, zs, 2.6, 0.16, 0.9 - k * 0.12, jitter(C.plank, hashId(k, 9), 0.2));
  }
}

function buildTimber(g, b, W, heightAt, limit) {
  const { z, x0, x1 } = b;
  const cx = b.cx ?? riverX(z);
  const end = Math.min(x1, limit);
  // Pile bents in the channel with cap beams and cross braces.
  const H = waterHalf();
  for (const u of [-H, -0.6 * H, 0.6 * H, H]) {
    const x = cx + u;
    if (x > limit + 0.5 || x < x0 || x > x1) continue;
    const top = deckAt(x) - 0.2;
    for (const s of [-1, 1]) g.boxAt(x, (top - 1.0) / 2, z + s * W * 0.4, 0.26, top + 1.0, 0.26, C.pile);
    g.boxAt(x, top - 0.06, z, 0.3, 0.2, W + 0.5, C.pile);
    g.beam(x, -0.35, z - W * 0.4, x, top - 0.2, z + W * 0.4, 0.1, C.plankDark);
  }
  // Stringers under the planks, following the profile.
  for (const s of [-1, 1]) profileSlab(g, x0 + 0.4, end, x0, x1, z + s * W * 0.33, 0.22, 0.2, C.plankDark, -0.12);
  // Plank deck, bank to bank.
  let i = 0;
  for (let x = x0; x < end - 0.05; x += 0.44, i++) {
    g.boxAt(x + 0.21, deckAt(x + 0.21) - 0.06, z, 0.4, 0.12, W, jitter(C.plank, hashId(b.id * 97 + i, 1), 0.2));
  }
  // Railings along the span (posts every 1.6 m, two rails), off the ramps' feet.
  const ra = x0 + 1.2, rb = Math.min(x1 - 1.2, end);
  for (const s of [-1, 1]) {
    const zs = z + s * (W / 2 - 0.07);
    for (let x = ra; x <= rb + 0.01; x += 1.6) g.boxAt(x, deckAt(x) + 0.45, zs, 0.12, 0.9, 0.12, C.plankDark);
    if (rb > ra) {
      profileSlab(g, ra, rb, x0, x1, zs, 0.13, 0.1, C.plank, 0.93);
      profileSlab(g, ra, rb, x0, x1, zs, 0.08, 0.07, C.plank, 0.535);
    }
  }
}

function buildStone(g, b, W, heightAt, limit) {
  const { z, x0, x1 } = b;
  const cx = b.cx ?? riverX(z);
  // Three arches sized to the seeded channel (classic half-width 6).
  const H = waterHalf();
  const arches = [
    { c: cx, half: 0.52 * H, spring: -0.3, rise: 0.82 },
    { c: cx - 0.88 * H, half: 0.27 * H, spring: -0.4, rise: 0.7 },
    { c: cx + 0.88 * H, half: 0.27 * H, spring: -0.4, rise: 0.7 },
  ];
  // Below the town reaches' bed (-0.8): the river is never raised where
  // bridges stand (tests/render-props.test.js), so fixed depths hide under it.
  const bed = -0.95;
  const xs = x0, xe = Math.min(x1, limit);
  // Spandrels stop just under the deck slab.
  const top = (x) => deckAt(x) - 0.2;
  // Sample the underside profile: arch curves inside arches, piers elsewhere.
  const pts = [];
  const archAt = (x) => arches.find((a) => Math.abs(x - a.c) < a.half - 1e-4);
  const bottom = (x) => {
    const a = archAt(x);
    if (!a) return bed;
    const k = (x - a.c) / a.half;
    return Math.min(a.spring + a.rise * Math.sqrt(Math.max(0, 1 - k * k)), top(x) - 0.25);
  };
  const breaks = [xs, xe, ...deckStations(xs, xe, x0, x1)];
  for (const a of arches) for (let k = 0; k <= 10; k++) breaks.push(a.c - a.half + (2 * a.half * k) / 10);
  for (const x of breaks.filter((x) => x >= xs && x <= xe).sort((p, q) => p - q)) {
    if (pts.length && Math.abs(x - pts[pts.length - 1]) < 1e-3) continue;
    pts.push(x);
  }
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Cv = new THREE.Vector3(), D = new THREE.Vector3();
  for (let i = 0; i < pts.length - 1; i++) {
    const xa = pts[i], xb = pts[i + 1];
    const mid = (xa + xb) / 2;
    const inArch = !!archAt(mid);
    const ya = inArch ? bottom(xa + 1e-4) : bed, yb = inArch ? bottom(xb - 1e-4) : bed;
    const shade = jitter(C.stone, hashId(b.id * 31 + i, 2), 0.1);
    // Spandrel / pier faces on both sides; over an arch, a darker band of
    // voussoirs follows the curve.
    const band = inArch ? 0.24 : 0;
    for (const s of [1, -1]) {
      const zs = z + (s * W) / 2;
      if (band) {
        A.set(xa, ya, zs); B.set(xb, yb, zs); Cv.set(xb, yb + band, zs); D.set(xa, ya + band, zs);
        if (s > 0) g.quad(A, B, Cv, D, C.stoneDark); else g.quad(B, A, D, Cv, C.stoneDark);
      }
      A.set(xa, ya + band, zs); B.set(xb, yb + band, zs); Cv.set(xb, top(xb), zs); D.set(xa, top(xa), zs);
      if (s > 0) g.quad(A, B, Cv, D, shade); else g.quad(B, A, D, Cv, shade);
    }
    if (inArch) {
      // Intrados: the underside of the arch, facing down into the opening.
      A.set(xa, ya, z - W / 2); B.set(xb, yb, z - W / 2); Cv.set(xb, yb, z + W / 2); D.set(xa, ya, z + W / 2);
      g.quad(A, B, Cv, D, C.stoneDark);
    }
  }
  // Pier faces under each arch spring, and cutwaters on the piers.
  for (const a of arches) {
    for (const side of [-1, 1]) {
      const x = a.c + side * a.half;
      if (x < xs || x > xe) continue;
      A.set(x, bed, z - W / 2); B.set(x, a.spring, z - W / 2); Cv.set(x, a.spring, z + W / 2); D.set(x, bed, z + W / 2);
      if (side < 0) g.quad(A, D, Cv, B, C.stoneDark); else g.quad(A, B, Cv, D, C.stoneDark);
    }
  }
  for (const px of [cx - 0.52 * H, cx + 0.52 * H]) {
    if (px > xe) continue;
    for (const s of [-1, 1]) g.boxAt(px, (bed + 0.3) / 2, z + s * (W / 2 + 0.25), 0.75, 0.3 - bed, 0.75, C.stoneDark, 0, Math.PI / 4);
  }
  // Setts deck and parapets with coping, all on the walking profile.
  profileSlab(g, xs, xe, x0, x1, z, W, 0.2, C.setts);
  const pa = x0 + 0.6, pb = Math.min(x1 - 0.6, xe);
  for (const s of [-1, 1]) {
    const zs = z + s * (W / 2 - 0.12);
    if (pb > pa) {
      profileSlab(g, pa, pb, x0, x1, zs, 0.28, 0.62, C.stone, 0.6);
      profileSlab(g, pa, pb, x0, x1, zs, 0.36, 0.09, C.coping, 0.68);
    }
  }
}

function buildIron(g, b, W, heightAt, limit) {
  const { z, x0, x1 } = b;
  const cx = b.cx ?? riverX(z);
  const xa = x0 + RAMP_LEN + 0.3, xb = x1 - RAMP_LEN - 0.3;
  const end = Math.min(x1, limit);
  const tEnd = Math.min(xb, limit);
  // Stone piers in the channel and abutments where the ramps meet the span.
  for (const u of [-0.6, 0.6]) {
    const x = cx + u * waterHalf();
    const top = deckAt(x) - 0.25;
    g.boxAt(x, (top - 1.0) / 2, z, 0.9, top + 1.0, W + 0.6, C.stone);
  }
  for (const x of [xa - 0.3, xb + 0.3]) {
    if (x > end) continue;
    const top = deckAt(x) - 0.25;
    g.boxAt(x, (top - 0.4) / 2, z, 0.8, top + 0.4, W + 0.8, C.stone);
  }
  // Setts deck on the profile, iron girders under it.
  profileSlab(g, x0, end, x0, x1, z, W, 0.24, C.setts);
  profileSlab(g, x0 + 0.5, end, x0, x1, z, W - 0.4, 0.18, C.ironDark, -0.24);
  // Warren trusses over the level span: chords, verticals, alternating diagonals.
  const h = 1.75;
  const panels = Math.max(2, Math.round((xb - xa - 2) / 1.6));
  const step = (xb - xa - 2) / panels;
  const y = (x) => deckAt(x);
  for (const s of [-1, 1]) {
    const zs = z + s * (W / 2 + 0.06);
    if (tEnd > xa) g.beam(xa, y(xa), zs, tEnd, y(tEnd), zs, 0.16, C.iron);
    const ta = xa + 1, tb = Math.min(xb - 1, tEnd);
    if (tb > ta) g.beam(ta, y(ta) + h, zs, tb, y(tb) + h, zs, 0.18, C.iron);
    if (tEnd > xa + 1) g.beam(xa, y(xa), zs, xa + 1, y(xa + 1) + h, zs, 0.16, C.iron);
    if (limit >= x1) g.beam(xb, y(xb), zs, xb - 1, y(xb - 1) + h, zs, 0.16, C.iron);
    for (let i = 0; i <= panels; i++) {
      const x = xa + 1 + i * step;
      if (x > tEnd) break;
      g.beam(x, y(x), zs, x, y(x) + h, zs, 0.1, C.ironDark);
      if (i < panels && x + step <= tEnd) {
        if (i % 2) g.beam(x, y(x), zs, x + step, y(x + step) + h, zs, 0.09, C.ironDark);
        else g.beam(x, y(x) + h, zs, x + step, y(x + step), zs, 0.09, C.ironDark);
      }
    }
  }
  // Overhead cross ties.
  for (let i = 0; i <= panels; i += 2) {
    const x = xa + 1 + i * step;
    if (x > tEnd) break;
    g.boxAt(x, y(x) + h, z, 0.1, 0.1, W + 0.2, C.ironDark);
  }
}

// ---------------------------------------------------------------------------
// Embankments: a dressed-stone wall face on the water side only, whose top is
// a walkable coping flush with the bank (the towpath). Nothing stands proud of
// the ground on the land side, so walkers on the towpath never clip it.

/** Unit normal pointing from a bank into the water at z, and the bank tangent. */
function bankFrame(side, z, out) {
  const s = side === 'east' ? -1 : 1; // west bank looks toward +x, east toward -x
  const d = riverX(z + 0.5) - riverX(z - 0.5);
  const len = Math.hypot(1, d);
  out.nx = (s * 1) / len; out.nz = (-s * d) / len; // perpendicular to (d, 1)
  out.tx = d / len; out.tz = 1 / len;
  out.wallX = riverX(z) - s * waterHalf();
  return out;
}

/** Distance along z to the nearest crossing or bridge (gaps in the parapet). */
function gapNear(z, crossings, bridges) {
  let d = Infinity;
  for (const c of crossings) d = Math.min(d, Math.abs(c.z - z) - 1.6);
  for (const b of bridges) d = Math.min(d, Math.abs(b.z - z) - 2.6);
  return d;
}

export function buildEmbankment(g, run, heightAt, era, bridges) {
  const west = run.side !== 'east';
  const side = west ? -1 : 1; // the wall line sits at riverX + side * H
  const H = waterHalf();
  const bed = -0.85; // the town reaches' bed, as for bridges (buildStone)
  const step = 1;
  const z0 = Math.min(run.z0, run.z1), z1 = Math.max(run.z0, run.z1);
  const crossings = run.crossings ?? [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Cv = new THREE.Vector3(), D = new THREE.Vector3();
  const edge = (z) => riverX(z) + side * H;
  // Flush with the land just behind the wall: the coping is the towpath edge.
  const topAt = (z) => Math.max(0.2, heightAt(edge(z) + side * 0.7, z) + 0.03);
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, color) => {
    A.set(ax, ay, az); B.set(bx, by, bz); Cv.set(cx, cy, cz); D.set(dx, dy, dz);
    if (side < 0) g.quad(A, B, Cv, D, color); else g.quad(B, A, D, Cv, color);
  };
  for (let z = z0, k = 0; z < z1 - 1e-3; z += step, k++) {
    const za = z, zb = Math.min(z1, z + step);
    const xa = edge(za), xb = edge(zb);
    const ta = topAt(za), tb = topAt(zb);
    const shade = jitter(C.stone, hashId(Math.round(za * 3) + side * 7919, 12), 0.14);
    // Face toward the river: a darker waterline course, then dressed stone.
    quad(xb, bed, zb, xa, bed, za, xa, 0.12, za, xb, 0.12, zb, C.stoneDark);
    quad(xb, 0.12, zb, xa, 0.12, za, xa, ta - 0.14, za, xb, tb - 0.14, zb, shade);
    // Coping: overhangs the face by 0.1 and runs 0.6 inland, top at grade.
    const lip = -side * 0.1, back = side * 0.6;
    quad(xb + lip, tb - 0.14, zb, xa + lip, ta - 0.14, za, xa + lip, ta, za, xb + lip, tb, zb, C.coping);
    A.set(Math.min(xa + lip, xa + back), ta, za);
    B.set(Math.min(xb + lip, xb + back), tb, zb);
    Cv.set(Math.max(xb + lip, xb + back), tb, zb);
    D.set(Math.max(xa + lip, xa + back), ta, za);
    g.quad(A, B, Cv, D, C.coping);
    // Iron mooring rings on the face every 7 m.
    if (k % 7 === 3) g.boxAt(xa - side * 0.04, ta - 0.45, za, 0.06, 0.24, 0.24, W_COL.ring);
    // Edge furniture, broken at every crossing and bridge.
    if (gapNear(za + 0.5, crossings, bridges) <= 0) continue;
    if (era >= 3) {
      // Low stone parapet with a pale cap (promenade).
      g.beam(xa + side * 0.12, ta + 0.25, za, xb + side * 0.12, tb + 0.25, zb, 0.5, C.stone, 0, 0.24);
      g.beam(xa + side * 0.12, ta + 0.53, za, xb + side * 0.12, tb + 0.53, zb, 0.07, C.coping, 0, 0.32);
    } else if (k % 4 === 1) {
      // Timber bollards on the towpath edge.
      g.boxAt(xa + side * 0.2, ta + 0.28, za, 0.24, 0.56, 0.24, W_COL.bollard);
    }
  }
}

/**
 * Where paths meet the water: 'steps' down the wall, 'ramp' (fords, bridge
 * abutments) draped from the bank into the shallows, 'slipway' by quays.
 * Oriented across the bank at that z, whatever the river's angle.
 */
export function buildCrossing(g, c, heightAt, era, bridges) {
  const f = bankFrame(c.side, c.z, {});
  const { nx, nz, tx, tz } = f;
  // At a bridge abutment, stairs go beside the bridge, not under the deck.
  const bridge = bridges.find((b) => Math.abs(b.z - c.z) < 5);
  let ox = f.wallX, oz = c.z;
  let kind = c.kind;
  if (bridge && kind === 'ramp') {
    const away = Math.sign(c.z - bridge.z) || 1;
    oz = bridge.z + away * 3.8;
    ox = riverX(oz) - (c.side === 'east' ? -1 : 1) * waterHalf();
    kind = 'steps';
  }
  const at = (u, v) => [ox + nx * u + tx * v, oz + nz * u + tz * v]; // u toward water, v along bank
  const top = Math.max(0.2, heightAt(...at(-0.8, 0)) + 0.03);
  const paved = era >= 3;
  if (kind === 'steps') {
    // Stone stairs built against the wall face, running along the bank from
    // the coping down to the water, with a cheek wall on the river side.
    const n = 6, tread = 0.5, width = 1.15;
    const yaw = Math.atan2(-nz, nx);
    for (let k = 0; k < n; k++) {
      const y = top - ((k + 1) * (top + 0.2)) / n;
      const [x, z] = at(width / 2 + 0.02, -1.5 + k * tread);
      g.boxAt(x, (y - 0.85) / 2, z, width, y + 0.85, tread + 0.02, jitter(C.stoneDark, hashId(k, 21), 0.1), 0, yaw);
    }
    const [xa, za] = at(width + 0.12, -1.6), [xb, zb] = at(width + 0.12, -1.5 + n * tread);
    g.beam(xa, top - 0.1, za, xb, -0.25, zb, 0.36, C.stone, 0, 0.2);
    return;
  }
  // Ramp or slipway: a draped slab from 2.5 m inland out into the water.
  const slip = kind === 'slipway';
  const width = slip ? 3.2 : 2.6;
  const u0 = -2.5, u1 = slip ? 4.0 : 2.8;
  const surface = slip || paved ? C.setts : W_COL.gravel;
  const segs = 12;
  const yAt = (u) => {
    const [x, z] = at(u, 0);
    const ground = heightAt(x, z);
    // Slipways run straight down into the water; ramps follow the bank and
    // the ford bed, never above the bank top.
    if (slip) return Math.max(-0.5, top - ((u - u0) / (u1 - u0)) * (top + 0.5));
    return Math.max(ground, -0.3) + 0.04;
  };
  for (let k = 0; k < segs; k++) {
    const ua = u0 + ((u1 - u0) * k) / segs, ub = u0 + ((u1 - u0) * (k + 1)) / segs;
    const [xa, za] = at(ua, 0), [xb, zb] = at(ub, 0);
    const wet = (yAt(ua) + yAt(ub)) / 2 < 0.05;
    g.beam(xa, yAt(ua) - 0.06, za, xb, yAt(ub) - 0.06, zb, 0.12, wet ? W_COL.wet : surface, 0, width);
    // Edging stones along both sides.
    for (const v of [-width / 2, width / 2]) {
      const [ea, fa] = at(ua, v), [eb, fb] = at(ub, v);
      g.beam(ea, yAt(ua) - 0.02, fa, eb, yAt(ub) - 0.02, fb, 0.14, W_COL.gravelEdge, 0, 0.16);
    }
  }
}

// ---------------------------------------------------------------------------
// Square and avenue furniture (benches, planters, clipped trees). Trees mark
// their canopy vertices (aExtra 2) so the material turns them with the season.

function bench(g, x, y, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  // The seat sits on the highest ground under the legs; each leg reaches
  // down to its own ground, so nothing hovers on a slope.
  const legs = [-0.6, 0.6].map((lx) => P(lx, -0.02));
  y = Math.max(y, ...legs.map(([lx, lz]) => groundAt(lx, lz)));
  let [px, pz] = P(0, 0);
  g.boxAt(px, y + 0.45, pz, 1.4, 0.07, 0.42, W_COL.bench, 0, yaw);
  [px, pz] = P(0, -0.2);
  g.boxAt(px, y + 0.7, pz, 1.4, 0.4, 0.06, W_COL.bench, 0, yaw);
  for (const [lx, lz] of legs) {
    const foot = Math.min(y, groundAt(lx, lz)) - 0.05;
    g.boxAt(lx, (foot + y + 0.44) / 2, lz, 0.07, y + 0.44 - foot, 0.42, W_COL.benchIron, 0, yaw);
  }
}

function streetTree(g, x, y, z, seed, planter) {
  if (planter) g.boxAt(x, y + 0.25, z, 1.0, 0.5, 1.0, W_COL.planter);
  const base = y + (planter ? 0.5 : 0);
  g.boxAt(x, base + 1.0, z, 0.18, 2.0, 0.18, W_COL.trunk);
  g.blob(x, base + 2.6, z, 1.15 + 0.25 * seed, 0.9, seed < 0.5 ? W_COL.leaf : W_COL.leafDark, 2);
}

function planterShrub(g, x, y, z, seed) {
  g.boxAt(x, y + 0.22, z, 0.9, 0.44, 0.9, W_COL.planter);
  g.blob(x, y + 0.62, z, 0.48 + 0.1 * seed, 0.8, W_COL.shrub, 2);
}

// ---------------------------------------------------------------------------
// Static instanced pieces

function lampGeometry() {
  const g = new Geo();
  // The plinth reaches half a metre down: the lamp stands on the highest
  // ground under it (lampBase), and on a slope the low side still meets it.
  g.boxAt(0, -0.1, 0, 0.34, 0.8, 0.34, C.lampIron);
  g.boxAt(0, 1.6, 0, 0.12, 2.9, 0.12, C.lampIron);
  g.boxAt(0.27, 3.0, 0, 0.62, 0.07, 0.07, C.lampIron);
  g.boxAt(0.52, 2.72, 0, 0.3, 0.38, 0.3, C.lampGlass, 1);
  g.boxAt(0.52, 2.95, 0, 0.4, 0.08, 0.4, C.lampIron);
  return g.build();
}

function stallGeometry() {
  // Facing +z: counter, four posts, a sloped striped awning, produce crates.
  // Posts and the counter reach a metre below y = 0: the stall stands on the
  // highest ground under it, and on a slope the downhill side still meets
  // the ground (the uphill side is simply buried).
  const g = new Geo();
  g.boxAt(0, -0.05, 0.1, 1.9, 1.9, 0.8, C.wood);
  for (const [x, z] of [[-0.95, -0.45], [0.95, -0.45], [-0.95, 0.6], [0.95, 0.6]]) g.boxAt(x, 0.6, z, 0.08, 3.2, 0.08, C.pile);
  g.beam(0, 2.25, -0.6, 0, 1.85, 0.95, 0.06, C.cream, 1, 2.2);
  for (let i = 0; i < 5; i++) g.boxAt(-0.72 + i * 0.36, 0.98, 0.15, 0.3, 0.16, 0.42, PRODUCE[i], 2);
  return g.build();
}

function flagGeometry() {
  // A pennant hanging from its top edge (local y down), both sides.
  const g = new Geo();
  const a = new THREE.Vector3(-0.22, 0, 0), b = new THREE.Vector3(0.22, 0, 0), c = new THREE.Vector3(0, -0.45, 0);
  g.tri(a, c, b, C.cream); // single-sided triangle; the material is DoubleSide
  return g.build();
}

export function boatGeometry() {
  // Unit length along z (-0.5..0.5), unit width along x; heights in metres
  // (boats.js HULL: keel -0.06, floor 0.17, gunwale 0.32; the craft's
  // waterline is set per type there). aExtra: 0 hull, 1 cargo (collapsed on punts).
  const g = new Geo();
  const hull = col('#6b4f34'), rim = col('#8c6a44'), inside = col('#5a4330');
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const h = 0.32, keel = -0.06, floor = 0.17;
  const mid = (y) => V(0, y, 0);
  // Sides (tapered at both ends), inner walls, gunwale rim, floor and keel
  // plate, around the outline (counter-clockwise seen from above).
  const outline = [[-0.5, -0.36], [-0.5, 0.36], [-0.28, 0.5], [0.28, 0.5], [0.5, 0.36], [0.5, -0.36], [0.28, -0.5], [-0.28, -0.5]];
  for (let i = 0; i < outline.length; i++) {
    const [x0, z0] = outline[i];
    const [x1, z1] = outline[(i + 1) % outline.length];
    g.quad(V(x0, keel, z0), V(x1, keel, z1), V(x1, h, z1), V(x0, h, z0), hull);
    // Inner wall (thin rim reads as a hull edge).
    g.quad(V(x1 * 0.86, floor, z1 * 0.92), V(x0 * 0.86, floor, z0 * 0.92), V(x0 * 0.86, h, z0 * 0.92), V(x1 * 0.86, h, z1 * 0.92), inside);
    // Rim and floor face up, the keel plate down: seen from above the boat is
    // closed, so the river never shows inside it (the floor sits above the
    // waterline), and through clear shallows the hull reads solid.
    g.quad(V(x0, h, z0), V(x1, h, z1), V(x1 * 0.86, h, z1 * 0.92), V(x0 * 0.86, h, z0 * 0.92), rim);
    g.tri(mid(floor), V(x0 * 0.86, floor, z0 * 0.92), V(x1 * 0.86, floor, z1 * 0.92), inside);
    g.tri(mid(keel), V(x1, keel, z1), V(x0, keel, z0), hull);
  }
  for (let i = 0; i < 5; i++) g.boxAt(-0.34 + i * 0.17, 0.18, 0, 0.012, 0.012, 0.9, rim);
  // Thwarts (seats).
  for (const z of [-0.25, 0.22]) g.boxAt(0, 0.26, z, 0.86, 0.04, 0.06, rim);
  // Cargo: crates and a tarpaulin bundle.
  g.boxAt(-0.18, 0.3, -0.18, 0.4, 0.42, 0.18, col('#a07b52'), 1);
  g.boxAt(0.2, 0.28, -0.2, 0.36, 0.38, 0.16, col('#8c6a44'), 1);
  g.boxAt(0, 0.3, 0.16, 0.7, 0.44, 0.26, col('#6f7a5a'), 1);
  return g.build();
}

function birdGeometry() {
  // Body diamond plus two wings; aWing = -1/1 marks wingtips, 0 elsewhere.
  const pos = [
    0, 0, 0.35, -0.08, 0, 0, 0.08, 0, 0,
    0, 0, 0.35, 0.08, 0, 0, -0.08, 0, 0,
    -0.08, 0, 0, 0, 0, -0.3, 0.08, 0, 0,
    -0.08, 0, 0, 0.08, 0, 0, 0, 0, -0.3,
    -0.05, 0, 0.12, -0.6, 0, -0.05, -0.05, 0, -0.12,
    -0.05, 0, 0.12, -0.05, 0, -0.12, -0.6, 0, -0.05,
    0.05, 0, 0.12, 0.05, 0, -0.12, 0.6, 0, -0.05,
    0.05, 0, 0.12, 0.6, 0, -0.05, 0.05, 0, -0.12,
  ];
  const wing = pos.map((_, i) => i).filter((i) => i % 3 === 0).map((i) => (Math.abs(pos[i]) > 0.5 ? Math.sign(pos[i]) : 0));
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  return g;
}

function quadXY() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function attr(g, name, size, count) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

function instancedMesh(geometry, material, cap, { cast = false, receive = true, reflect = false } = {}) {
  const m = new THREE.InstancedMesh(geometry, material, cap);
  m.count = 0;
  m.frustumCulled = false;
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (reflect) m.layers.enable(LAYER_REFLECT);
  m.visible = false;
  return m;
}

// ---------------------------------------------------------------------------
// Shaders for glows, ground marks, pennants, boats and birds

const GLOW_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aGlow;   // x, y, z, size
attribute vec2 aKind;   // 0 lamp, 1 fire, 2 lantern string; seed
uniform float uTime;
uniform float uNight;
varying vec2 vUv;
varying float vI;
varying float vKind;
void main() {
  float flicker = 0.85 + 0.15 * sin(uTime * 13.0 + aKind.y * 40.0) * sin(uTime * 7.3 + aKind.y * 9.0);
  float night = smoothstep(0.25, 0.75, uNight);
  // Lamps light at dusk; fires glow all the time, stronger at night.
  float i = aKind.x < 0.5 ? night : aKind.x < 1.5 ? (0.55 + 0.45 * night) * flicker : night * 0.9;
  vec4 mvPosition = viewMatrix * vec4(aGlow.xyz, 1.0);
  float size = aGlow.w * (aKind.x > 0.5 && aKind.x < 1.5 ? flicker : 1.0);
  mvPosition.xy += position.xy * size;
  // Pull the sprite toward the camera so it is not clipped by its lantern.
  mvPosition.z += 0.4;
  gl_Position = projectionMatrix * mvPosition;
  if (i < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = position.xy + 0.5;
  vI = i;
  vKind = aKind.x;
  #include <fog_vertex>
}
`;

const GLOW_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying vec2 vUv;
varying float vI;
varying float vKind;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  // Bright core and a wide soft halo (inverse-square-ish falloff).
  float g = smoothstep(1.0, 0.0, d);
  float a = g * g * 0.7 + smoothstep(0.25, 0.0, d) * 0.6;
  vec3 c = vKind > 0.5 && vKind < 1.5 ? vec3(1.0, 0.5, 0.16) : vec3(1.0, 0.76, 0.42);
  gl_FragColor = vec4(c * a * vI * 1.6, 1.0);
  #include <fog_fragment>
}
`;

// Ground marks drape on the shared ground texture: every vertex of a
// subdivided disc samples groundHeight, so marks follow slopes and pads.
// Modes: 1 scorch, 3 flood sheet, 4 lamp light pool. Output is premultiplied:
// marks blend normally, light pools add (alpha 0) in the same draw call.
const MARK_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${GROUND_GLSL}
attribute vec4 aMark;    // x, z, radius, seed
attribute vec4 aMarkCol; // rgb, mode
varying vec2 vLocal;
varying vec4 vCol;
varying float vSeed;
varying float vRadius;
void main() {
  vec2 xz = aMark.xy + position.xz * aMark.z;
  vRadius = aMark.z;
  vec3 p = vec3(xz.x, groundHeight(xz) + 0.05, xz.y);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vLocal = position.xz;
  vCol = aMarkCol;
  vSeed = aMark.w;
  #include <fog_vertex>
}
`;

const MARK_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform float uNight;
uniform float uLampShadows;
varying vec2 vLocal;
varying vec4 vCol;
varying float vSeed;
varying float vRadius;
// The lamp post's own shadow from its lantern (High tier). The post stands 0.52 m
// behind the lantern (vSeed = arm angle) and is taller than it, so it blocks a
// wedge from the post outward; the 0.3 m lantern makes it a soft partial shade.
float postShade(vec2 p, float ang) {
  vec2 u = vec2(-cos(ang), sin(ang));       // lantern -> post, in plan
  float t = dot(p, u);                       // metres along it
  float s = abs(p.x * u.y - p.y * u.x) / max(t, 1e-3); // tan of the angle off it
  return (1.0 - smoothstep(0.06, 0.3, s)) * smoothstep(0.45, 0.9, t) * 0.7;
}
void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;
  float mode = vCol.a;
  vec3 light = uSunColor * 0.6 + uSkyHorizon * 0.5;
  vec4 outc;
  if (mode < 2.0) {
    // Scorch: a soft charred patch, ragged at the edge.
    float edge = 0.75 + 0.2 * sin(atan(vLocal.y, vLocal.x) * 5.0 + vSeed * 20.0);
    float a = smoothstep(edge, edge * 0.4, r) * 0.75;
    outc = vec4(vCol.rgb * light * (1.0 - 0.6 * uNight) * a, a);
  } else if (mode < 3.5) {
    // Flood water: a still sheet with a soft shoreline.
    float a = smoothstep(1.0, 0.7, r) * 0.62;
    vec3 c = mix(vCol.rgb, uSkyHorizon * 0.5, 0.25) * light * 0.55 * (1.0 - 0.5 * uNight);
    outc = vec4(c * a, a);
  } else {
    // Lamp pool: warm light falling off with distance; adds, never darkens.
    float i = (1.0 - r * r);
    i = i * i * smoothstep(0.25, 0.75, uNight) * 0.42;
    i *= 1.0 - uLampShadows * postShade(vLocal * vRadius, vSeed);
    outc = vec4(vCol.rgb * i, 0.0);
  }
  if (outc.a < 0.003 && dot(outc.rgb, vec3(1.0)) < 0.003) discard;
  gl_FragColor = outc;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Unit disc grid in [-1, 1]^2 on xz, subdivided so it can drape. */
function markGeometry(segments = 10) {
  const plane = new THREE.PlaneGeometry(2, 2, segments, segments);
  plane.rotateX(-Math.PI / 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.attributes.position);
  return g;
}

// Pennants: a pole, a finial, a swallowtail banner and a small lantern, in
// local metres with y = 0 at the pole top (the pole itself is a unit height
// the shader stretches). aPart: 0 pole, 1 banner, 2 finial, 3 lantern.
// aCloth: banner (u along the fly, v down the hoist).
function pennantGeometry() {
  const pos = [], part = [], cloth = [];
  const push = (x, y, z, p, u = 0, v = 0) => { pos.push(x, y, z); part.push(p); cloth.push(u, v); };
  const box = (x0, y0, z0, x1, y1, z1, p) => {
    const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const f of BOX_FACES) {
      for (const k of [0, 1, 2, 0, 2, 3]) push(...c[f[k]], p);
    }
  };
  box(-0.07, 0, -0.07, 0.07, 1, 0.07, 0);            // pole (unit height)
  box(-0.13, 0.04, -0.13, 0.13, 0.3, 0.13, 2);        // finial above the top
  box(-0.15, -2.0, 0.08, 0.15, -1.64, 0.38, 3);       // lantern on a short arm
  box(-0.03, -1.67, 0.0, 0.03, -1.6, 0.3, 3);         // its arm
  // Banner: 7 x 2 grid, 3.0 m fly, 1.4 m hoist, swallowtail cut at the tip.
  const U = 7, V = 2;
  const vert = (i, j) => {
    const u = i / U, v = j / V;
    let x = 0.08 + u * 3.0;
    const y = -0.12 - v * 1.4;
    if (i === U && j === 1) x -= 0.55; // the notch
    return [x, y, 0, u, v];
  };
  for (let i = 0; i < U; i++) {
    for (let j = 0; j < V; j++) {
      const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
      for (const q of [a, b, c, a, c, d]) push(q[0], q[1], q[2], 1, q[3], q[4]);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('aCloth', new THREE.Float32BufferAttribute(cloth, 2));
  // Shading uses derivative normals (flatShading); this one only feeds the
  // snow test, pointing sideways so cloth never collects snow.
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  return g;
}

const BIRD_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${RIVER_GLSL}
attribute float aWing;
attribute vec4 aBird;   // offset x, y, z within the flock, phase
attribute vec4 aBird2;  // flock seed, flock radius, size, kind (0 flock, 1 heron)
uniform float uTime;
uniform float uNight;
uniform vec3 uTown;
varying float vShade;
void main() {
  float t = uTime;
  vec3 c;
  vec2 dir;
  float flap;
  if (aBird2.w < 0.5) {
    // Flocks wheel over the town on slow Lissajous loops.
    float k = aBird2.x * 6.283;
    float R = aBird2.y;
    float w = 7.0 / R;
    c = uTown + vec3(cos(t * w + k) * R, 26.0 + sin(t * 0.21 + k) * 4.0, sin(t * w * 0.8 + k * 1.7) * R * 0.7);
    dir = normalize(vec2(-sin(t * w + k) * R * w, cos(t * w * 0.8 + k * 1.7) * R * 0.7 * w * 0.8));
    // Flap in bursts, glide in between.
    float burst = smoothstep(-0.2, 0.4, sin(t * 0.7 + aBird.w * 3.0));
    flap = sin(t * 10.0 + aBird.w * 6.283) * 0.55 * burst + 0.12 * (1.0 - burst);
  } else {
    // The heron follows the river slowly, wings beating at ~2 Hz.
    float z = mod(aBird.z + t * 2.2 + 300.0, 600.0) - 300.0;
    c = vec3(riverXg(z) + 2.5 * sin(t * 0.13 + aBird.w), 7.0 + sin(t * 0.4) * 0.6, z);
    dir = normalize(vec2(riverDX(z), 1.0));
    flap = sin(t * 2.2 * 6.283 * 0.5 + aBird.w) * 0.45;
  }
  // Offset within the flock in the flock's heading frame.
  float yaw = atan(dir.x, dir.y);
  float cy = cos(yaw), sy = sin(yaw);
  vec3 off = aBird.xyz * (aBird2.w < 0.5 ? 1.0 : 0.0);
  off.xz += vec2(sin(t * 1.3 + aBird.w * 7.0), cos(t * 1.1 + aBird.w * 5.0)) * 0.4;
  vec3 local = position * aBird2.z;
  local.y += abs(aWing) * flap * aBird2.z;
  // Hide at night.
  local *= 1.0 - smoothstep(0.55, 0.8, uNight);
  // Shrink away as the camera comes close, rather than clip through the near plane.
  local *= smoothstep(2.0, 7.0, distance(c + off, cameraPosition));
  vec3 rel = local + off;
  vec3 p = c + vec3(rel.x * cy + rel.z * sy, rel.y, -rel.x * sy + rel.z * cy);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vShade = 0.75 + 0.25 * abs(aWing) * flap;
  #include <fog_vertex>
}
`;

const BIRD_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uBirdColor;
varying float vShade;
void main() {
  gl_FragColor = vec4(uBirdColor * vShade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;


const PENNANT_HEAD = /* glsl */ `
attribute float aPart;
attribute vec2 aCloth;
attribute vec4 aPen;   // x, base y, z, pole height
attribute vec4 aPen2;  // rgb, urgent
attribute vec4 aPen3;  // raised at, lowered at, seed
varying float vPart;
varying vec2 vCloth;
varying vec4 vPenCol;
varying float vLantern;
`;

const PENNANT_BEGIN = /* glsl */ `
  float since = uTime - aPen3.x;
  float rise = clamp(since / 0.7, 0.0, 1.0);
  // easeOutBack: the banner snaps open with a little overshoot.
  float r1 = rise - 1.0;
  float unfurl = rise <= 0.0 ? 0.0 : 1.0 + 2.70158 * r1 * r1 * r1 + 1.70158 * r1 * r1;
  float lowerK = clamp((uTime - aPen3.y) / 0.9, 0.0, 1.0);
  float poleK = smoothstep(0.0, 0.35, since) * (1.0 - step(0.999, lowerK));
  float Hp = aPen.w * poleK;
  float urgent = aPen2.w;
  vec3 lp = position;
  if (aPart < 0.5) {
    // Pole: a unit box stretched to its height.
    lp.y *= Hp;
  } else if (aPart < 1.5) {
    // Banner: unfurls from the pole, waves along its fly, slides down when lowered.
    float u = aCloth.x;
    float s = (1.0 - 0.85 * lowerK);
    lp.x *= max(unfurl, 0.0) * s;
    lp.y *= mix(0.2, 1.0, clamp(unfurl, 0.0, 1.0)) * s;
    float wind = clamp(length(uWind), 0.0, 1.5);
    float speed = urgent > 0.5 ? 6.8 : 3.2;
    float wave = sin(uDecoTime * speed - u * 4.2 + aPen3.z * 6.283) + 0.35 * sin(uDecoTime * speed * 1.7 - u * 7.0);
    lp.z += wave * u * (0.18 + 0.22 * wind) * s;
    lp.y -= u * u * 0.18 * (1.0 - min(wind, 1.0));
    lp.y += Hp - lowerK * max(Hp - 1.8, 0.0);
  } else if (aPart < 2.5) {
    lp.y += Hp; // finial
  } else {
    // Lantern on its arm, only for urgent cards.
    lp *= step(0.5, urgent);
    lp.y += Hp;
  }
  // Turn the pennant about its pole so the banner streams downwind, but lean
  // it toward broadside to the camera so it never reads edge-on.
  vec2 wd = normalize(uWind + vec2(1e-4, 0.0));
  vec2 toCam = normalize(cameraPosition.xz - aPen.xz + vec2(1e-4, 0.0));
  vec2 side = vec2(-toCam.y, toCam.x);
  side *= sign(dot(side, wd) + 1e-4);
  wd = normalize(mix(wd, side, 0.65));
  lp = vec3(lp.x * wd.x - lp.z * wd.y, lp.y, lp.x * wd.y + lp.z * wd.x);
  transformed = aPen.xyz + lp * step(0.001, poleK);
  vPart = aPart;
  vCloth = aCloth;
  vPenCol = aPen2;
  vLantern = urgent;
`;

const PENNANT_COLOR = /* glsl */ `
  vec3 pc;
  if (vPart < 0.5) pc = vec3(0.24, 0.17, 0.11);
  else if (vPart < 1.5) {
    pc = vPenCol.rgb;
    // A pale hoist band at the pole and a darker hem.
    pc = mix(pc, vec3(0.86, 0.80, 0.66), step(vCloth.x, 0.07));
    pc = mix(pc, pc * 0.72, step(0.9, vCloth.y));
  } else if (vPart < 2.5) pc = vec3(0.72, 0.55, 0.2);
  else pc = vec3(0.9, 0.74, 0.46);
  diffuseColor.rgb = pc;
`;

const PENNANT_EMISSIVE = /* glsl */ `
  float nightP = smoothstep(0.25, 0.75, uNight);
  if (vPart > 2.5) totalEmissiveRadiance += vec3(1.0, 0.68, 0.32) * vLantern * (0.25 + 2.4 * nightP);
  // The lantern washes the hoist end of the banner, so it still reads at night.
  else if (vPart > 0.5 && vPart < 1.5) totalEmissiveRadiance += vPenCol.rgb * vLantern * nightP * 0.55 * (1.0 - vCloth.x);
`;

// ---------------------------------------------------------------------------

export function createProps(ctx) {
  const { scene, grade, heightAt, buildings, ground } = ctx;
  const ctxReduced = () => !!ctx.reducedMotion;
  const group = new THREE.Group();
  group.name = 'props';
  scene.add(group);
  const scratchM = new THREE.Matrix4();
  const scratchQ = new THREE.Quaternion();
  const scratchP = new THREE.Vector3();
  const scratchS = new THREE.Vector3();

  const riverPath = createRiverPath();
  riverPath.sync();

  // --- Bridges and embankments (one mesh) -----------------------------------
  const bridgeMat = gradeLambert(grade, 'bridge', {
    vertexColors: true,
    vertexHead: 'attribute float aExtra;\nvarying float vPartB;\n',
    vertexEnd: 'vPartB = aExtra;\n',
    fragmentHead: 'varying float vPartB;\n',
    fragmentColor: /* glsl */ `
      // Street-tree canopies (aExtra 2) turn with the season like the woods.
      if (vPartB > 1.5) {
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.34, 0.10), uAutumn * 0.8);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.24, 0.17), uBare * 0.75);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.80, 0.84), uBlossom * 0.35);
      }
    `,
  });
  const bridgeMesh = new THREE.Mesh(new THREE.BufferGeometry(), bridgeMat);
  bridgeMesh.castShadow = true;
  bridgeMesh.receiveShadow = true;
  bridgeMesh.layers.enable(LAYER_REFLECT);
  bridgeMesh.visible = false;
  group.add(bridgeMesh);
  let bridgeSig = 0;

  function rebuildBridges(view) {
    groundAt = heightAt;
    const g = new Geo();
    const era = view.era ?? 0;
    const bridges = view.bridges ?? [];
    for (const src of bridges) {
      const rec = view.buildings?.find?.((r) => r.id === src.id);
      const foot = src.style === 'footbridge' || rec?.variant === 'footbridge';
      const W = foot ? 1.3 : Math.max(2.4, Math.min(6, src.width ?? src.d ?? rec?.d ?? 3.2));
      const built = Math.max(0, Math.min(1, src.built ?? 1));
      const frame = bridgeFrame(src, heightAt);
      const b = frame.rec;
      groundAt = frame.height;
      DECK_Y = src.deckY ?? BRIDGE_DECK;
      setDeckProfile(src, b);
      // Build in the bridge's own frame, then place it in the world.
      const gg = frame.place ? new Geo() : g;
      // Build the whole bridge, then keep what is finished: work advances
      // from both banks toward the middle.
      const full = built >= 1 ? gg : new Geo();
      if (foot) buildFoot(full, b, frame.height);
      else if (b.style === 'stone') buildStone(full, b, W, frame.height, Infinity);
      else if (b.style === 'iron') buildIron(full, b, W, frame.height, Infinity);
      else buildTimber(full, b, W, frame.height, Infinity);
      if (built < 1) {
        const reach = ((b.x1 - b.x0) / 2) * built;
        const left = b.x0 + reach, right = b.x1 - reach;
        // Decks are short profile segments, so the finished stretches from
        // each bank survive the centroid filter on their own.
        gg.appendFiltered(full, (x) => x <= left || x >= right);
        bridgeWorks(gg, b, W, [left, right]);
      }
      if (frame.place) appendPlaced(g, gg, frame.place);
    }
    groundAt = heightAt;
    DECK_Y = BRIDGE_DECK;
    // Bridge positions in world space, for keeping crossings clear of them.
    const bridgeSpots = bridges.map((b) => (b.a && b.b ? { z: (b.a.z + b.b.z) / 2 } : b));
    for (const run of view.embankments ?? []) {
      // Only built things draw: steps down an embankment wall (one flight per
      // 14 m, none within 6 m of a bridge) and slipways by quays. Fords and
      // abutments need no pieces of their own: the road splat and the ford's
      // riffles show the crossing, and bridges carry their own approaches.
      const kept = thinCrossings(run.crossings ?? [])
        .filter((c) => c.kind !== 'ramp')
        .filter((c) => !bridgeSpots.some((b) => Math.abs(b.z - c.z) < 6));
      buildEmbankment(g, { ...run, crossings: kept }, heightAt, era, bridgeSpots);
      for (const c of kept) buildCrossing(g, c, heightAt, era, bridgeSpots);
    }
    buildFurniture(g, view);
    bridgeMesh.geometry.dispose();
    bridgeMesh.geometry = g.build();
    bridgeMesh.visible = g.p.length > 0;
  }

  function thinCrossings(list) {
    const out = [];
    let lastStep = -Infinity;
    for (const c of [...list].sort((p, q) => p.z - q.z)) {
      if (c.kind === 'steps') {
        if (c.z - lastStep < 14) continue;
        lastStep = c.z;
      }
      out.push(c);
    }
    return out;
  }

  /**
   * Squares (tier >= 4 cells around a square monument) get benches facing in
   * and trees in planters on the corners; avenues (tier 5 runs) get street
   * trees (garden and scholar towns) or planters along their edges.
   */
  function buildFurniture(g, view) {
    const r = view.roads;
    if (!r?.tier) return;
    const { W, H, cell, ox, oz, tier } = r;
    const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : tier[j * W + i]);
    const centre = (i, j) => [ox + (i + 0.5) * cell, oz + (j + 0.5) * cell];
    const inSquare = new Set();
    let items = 0;
    const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const b of view.buildings ?? []) {
      if (b.type !== 'monument' || !b.flags?.square) continue;
      const ci = Math.floor((b.x - ox) / cell), cj = Math.floor((b.z - oz) / cell);
      // Flood the paved cells around the monument (radius 7 cells).
      const seen = new Set([cj * W + ci]);
      const queue = [[ci, cj]];
      const cells = [];
      while (queue.length) {
        const [i, j] = queue.pop();
        if (at(i, j) >= 4 || (i === ci && j === cj)) cells.push([i, j]);
        else continue;
        for (const [di, dj] of N4) {
          const ni = i + di, nj = j + dj, k = nj * W + ni;
          if (seen.has(k) || Math.abs(ni - ci) > 7 || Math.abs(nj - cj) > 7) continue;
          seen.add(k);
          queue.push([ni, nj]);
        }
      }
      for (const [i, j] of cells) inSquare.add(j * W + i);
      for (const [i, j] of cells) {
        const out = N4.filter(([di, dj]) => at(i + di, j + dj) < 4);
        if (!out.length || items > 400) continue;
        const [x, z] = centre(i, j);
        const ux = out.reduce((a, [di]) => a + di, 0), uz = out.reduce((a, [, dj]) => a + dj, 0);
        const px = x + Math.sign(ux) * cell * 0.3, pz = z + Math.sign(uz) * cell * 0.3;
        if (blocked(px, pz, 0.3)) continue;
        const y = heightAt(px, pz);
        if (out.length >= 2) {
          streetTree(g, px, y, pz, hashId(i * 31 + j, 5), true);
          items++;
        } else if ((i + j) % 2 === 0) {
          // Bench on the edge, facing the monument.
          bench(g, px, y, pz, Math.atan2(b.x - px, b.z - pz));
          items++;
        }
      }
    }
    // Avenues: every fourth edge cell of a tier-5 run, away from squares.
    const trees = view.archetype === 'garden' || view.archetype === 'scholar';
    for (let j = 0; j < H && items < 600; j++) {
      for (let i = 0; i < W; i++) {
        if (at(i, j) < 5 || inSquare.has(j * W + i) || (i * 7 + j * 13) % 4 !== 0) continue;
        for (const [di, dj] of N4) {
          // The verge: any neighbour that is not itself a made street.
          if (at(i + di, j + dj) >= 3) continue;
          const [x, z] = centre(i, j);
          const px = x + di * cell * 0.7, pz = z + dj * cell * 0.7;
          if (blocked(px, pz, 0.4)) continue;
          const y = heightAt(px, pz);
          if (trees) streetTree(g, px, y, pz, hashId(i * 17 + j, 6), false);
          else planterShrub(g, px, y, pz, hashId(i * 17 + j, 6));
          items++;
          break;
        }
      }
    }
  }

  // Numeric signature (no per-frame string building). Squares and avenues
  // follow the road tiers, so roads.version is part of it (throttled below).
  function bridgeSignature(view) {
    let h = 5;
    for (const b of view.bridges ?? []) {
      h = Math.imul(h ^ (numId(b.id) * 7 + (b.style?.length ?? 0) + (b.style === 'footbridge' ? 101 : 0)), 16777619);
      h = Math.imul(h ^ (Math.round((b.built ?? 1) * 20) + Math.round(b.z * 10) * 31), 16777619);
    }
    for (const e of view.embankments ?? []) {
      h = Math.imul(h ^ (Math.round(e.z0 * 3) * 7 + Math.round(e.z1 * 3) * 13 + (e.side === 'east' ? 1 : 2)), 16777619);
      h = Math.imul(h ^ (e.crossings?.length ?? 0), 16777619);
    }
    h = Math.imul(h ^ (view.crossings?.length ?? 0), 16777619);
    h = Math.imul(h ^ Math.round(waterHalf() * 100), 16777619);
    h = Math.imul(h ^ ((view.era ?? 0) >= 3 ? 7 : 3), 16777619);
    h = Math.imul(h ^ (view.roads?.version ?? 0), 16777619);
    for (const b of view.buildings ?? []) if (b.flags?.square) h = Math.imul(h ^ numId(b.id), 16777619);
    return h;
  }
  let lastBridgeBuild = -10;

  // --- Lamps and glows -----------------------------------------------------
  const lampMat = gradeLambert(grade, 'lamp', {
    vertexColors: true,
    vertexHead: 'attribute float aExtra;\nvarying float vGlow;\n',
    vertexEnd: 'vGlow = aExtra;\n',
    fragmentHead: 'varying float vGlow;\n',
    fragmentEmissive: 'totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * vGlow * smoothstep(0.25, 0.75, uNight) * 2.4;\n',
  });
  const lamps = instancedMesh(lampGeometry(), lampMat, MAX_LAMPS, { cast: false });
  group.add(lamps);
  let lampSig = 0;

  const glowGeo = quadXY();
  const glowPos = attr(glowGeo, 'aGlow', 4, MAX_GLOWS);
  const glowKind = attr(glowGeo, 'aKind', 2, MAX_GLOWS);
  glowGeo.instanceCount = 0;
  const glowUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(glowUniforms, grade.uniforms);
  const glows = new THREE.Mesh(glowGeo, new THREE.ShaderMaterial({
    uniforms: glowUniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  }));
  glows.frustumCulled = false;
  glows.renderOrder = 8;
  group.add(glows);
  const lastGlowCentre = new THREE.Vector3(1e9, 0, 0);
  const lastShadowLampCentre = new THREE.Vector3(1e9, 0, 0);
  let lampGlowCount = 0;
  let eventGlowCount = 0;
  const lampOrder = [];

  function lampSignature(view) {
    const l = view.lamps ?? [];
    let h = l.length;
    if (l.length) h = Math.imul(h ^ Math.round(l[0].x * 10 + l[l.length - 1].z * 7), 16777619);
    return h;
  }

  /** A street lamp's ground: the highest under its plinth (0.34 m square). */
  function lampBase(x, z) {
    let y = heightAt(x, z);
    for (const [dx, dz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) y = Math.max(y, heightAt(x + dx, z + dz));
    return y;
  }

  function rebuildLamps(view) {
    const list = view.lamps ?? [];
    const n = Math.min(MAX_LAMPS, list.length);
    for (let i = 0; i < n; i++) {
      const { x, z } = list[i];
      scratchQ.setFromAxisAngle(Y_AXIS, lampArm(x, z).r);
      scratchM.compose(scratchP.set(x, lampBase(x, z), z), scratchQ, scratchS.set(1, 1, 1));
      lamps.setMatrixAt(i, scratchM);
    }
    lamps.count = n;
    lamps.visible = n > 0;
    lamps.instanceMatrix.clearUpdateRanges();
    lamps.instanceMatrix.needsUpdate = true;
  }

  /** Lamp glows go to the nearest lamps (cap); event glows follow them. */
  function rebuildLampGlows(view, centre) {
    const list = view.lamps ?? [];
    lampOrder.length = 0;
    for (let i = 0; i < Math.min(MAX_LAMPS, list.length); i++) lampOrder.push(i);
    const d2 = (i) => (list[i].x - centre.x) ** 2 + (list[i].z - centre.z) ** 2;
    if (lampOrder.length > MAX_GLOWS - 40) lampOrder.sort((a, b) => d2(a) - d2(b));
    lampGlowCount = Math.min(lampOrder.length, MAX_GLOWS - 40);
    for (let k = 0; k < lampGlowCount; k++) {
      const { x, z } = list[lampOrder[k]];
      const { r, lx, lz } = lampArm(x, z);
      writeGlow(k, lx, lampBase(x, z) + LANTERN_Y, lz, 3.0, 0, hashId(k, 3));
      // A warm pool of light on the street under the lantern; its seed slot
      // carries the arm angle, for the post's shadow.
      if (k < MAX_POOLS) {
        const o = (MAX_MARKS + k) * 4;
        markPos.array.set([lx, lz, POOL_RADIUS, r], o);
        markCol.array.set([POOL_COLOR.r, POOL_COLOR.g, POOL_COLOR.b, 4], o);
      }
    }
    poolCount = Math.min(MAX_POOLS, lampGlowCount);
    markPos.needsUpdate = true;
    markCol.needsUpdate = true;
    lastGlowCentre.copy(centre);
  }

  function writeGlow(i, x, y, z, size, kind, seed) {
    glowPos.array.set([x, y, z, size], i * 4);
    glowKind.array[i * 2] = kind;
    glowKind.array[i * 2 + 1] = seed;
  }

  function flushGlows() {
    // Event glows live after the lamp block.
    glowGeo.instanceCount = lampGlowCount + eventGlowCount;
    glowPos.clearUpdateRanges();
    glowKind.clearUpdateRanges();
    glowPos.needsUpdate = true;
    glowKind.needsUpdate = true;
    glows.visible = glowGeo.instanceCount > 0;
  }

  // --- Event dressing ------------------------------------------------------
  const stallMat = gradeLambert(grade, 'stall', {
    vertexColors: false,
    vertexHead: 'attribute vec3 color;\nattribute float aExtra;\nvarying vec3 vBaseCol;\nvarying float vPart;\nvarying float vLx;\n',
    vertexEnd: 'vBaseCol = color;\nvPart = aExtra;\nvLx = position.x;\n',
    fragmentHead: 'varying vec3 vBaseCol;\nvarying float vPart;\nvarying float vLx;\n',
    fragmentColor: /* glsl */ `
      vec3 sc = vBaseCol;
      #ifdef USE_INSTANCING_COLOR
        // Awning: stripes of the stall colour and cream.
        if (vPart > 0.5 && vPart < 1.5) sc = mix(vColor, vec3(0.86, 0.80, 0.66), step(0.5, fract(vLx * 2.4 + 0.25)));
      #endif
      diffuseColor.rgb = sc;
    `,
  });
  const stalls = instancedMesh(stallGeometry(), stallMat, MAX_STALLS, { cast: true });
  stalls.setColorAt(0, C.cream);
  group.add(stalls);

  const boxGeo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  boxGeo.computeVertexNormals();
  const boxMat = gradeLambert(grade, 'box');
  const boxes = instancedMesh(boxGeo, boxMat, MAX_BOXES, { cast: true });
  boxes.setColorAt(0, C.cream);
  group.add(boxes);

  const flagMat = gradeLambert(grade, 'flag', {
    side: THREE.DoubleSide,
    vertexBegin: /* glsl */ `
      // Flutter: swing about the top edge, stronger toward the tip.
      vec3 fp = instanceMatrix[3].xyz;
      float sway = sin(uDecoTime * 3.1 + fp.x * 0.7 + fp.z * 0.9) * 0.5 + sin(uDecoTime * 5.3 + fp.x * 1.3) * 0.25;
      transformed.z += -transformed.y * sway * (0.6 + length(uWind) * 0.6);
    `,
  });
  const flags = instancedMesh(flagGeometry(), flagMat, MAX_FLAGS, { cast: false });
  flags.setColorAt(0, C.cream);
  group.add(flags);

  // --- Ground marks and lamp pools (one draped, premultiplied mesh) --------
  // Slots 0..MAX_MARKS-1 hold event marks; lamp pools follow at MAX_MARKS.
  const markGeo = markGeometry(10);
  const markPos = attr(markGeo, 'aMark', 4, MAX_MARKS + MAX_POOLS);
  const markCol = attr(markGeo, 'aMarkCol', 4, MAX_MARKS + MAX_POOLS);
  markGeo.instanceCount = 0;
  const markUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(markUniforms, grade.uniforms);
  markUniforms.uLampShadows = { value: ctx.quality?.lampShadows ? 1 : 0 }; // the post's wedge in its pool
  const marks = new THREE.Mesh(markGeo, new THREE.ShaderMaterial({
    uniforms: markUniforms, vertexShader: MARK_VERT, fragmentShader: MARK_FRAG,
    transparent: true, depthWrite: false, fog: true,
    // Premultiplied: normal blending for marks, pure addition for light pools.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  marks.frustumCulled = false;
  marks.renderOrder = 1;
  group.add(marks);
  let poolCount = 0;
  let groundVersion = -1;
  let lastGroundSync = -10;

  /** Event marks always draw; lamp pools only once dusk sets in. */
  function updateMarkCount() {
    const night = grade.uniforms.uNight.value > 0.2;
    // Pools are packed right after the mark slots, so either draw the marks
    // alone or everything up to the last pool (unused mark slots are r = 0).
    markGeo.instanceCount = night && poolCount ? MAX_MARKS + poolCount : counts.marks;
    marks.visible = markGeo.instanceCount > 0;
  }

  // --- Pennants: a body's open docket card flies a banner on its building --
  const pennantGeo = pennantGeometry();
  const penA = attr(pennantGeo, 'aPen', 4, MAX_PENNANTS);   // x, base y, z, pole height
  const penB = attr(pennantGeo, 'aPen2', 4, MAX_PENNANTS);  // rgb colour, urgent
  const penC = attr(pennantGeo, 'aPen3', 4, MAX_PENNANTS);  // raised at, lowered at, seed, -
  pennantGeo.instanceCount = 0;
  const pennantMat = gradeLambert(grade, 'pennant', {
    side: THREE.DoubleSide,
    vertexHead: PENNANT_HEAD,
    vertexBegin: PENNANT_BEGIN,
    fragmentHead: 'varying float vPart;\nvarying vec2 vCloth;\nvarying vec4 vPenCol;\nvarying float vLantern;\n',
    fragmentColor: PENNANT_COLOR,
    fragmentEmissive: PENNANT_EMISSIVE,
  });
  pennantMat.flatShading = true; // derivative normals catch the cloth's folds
  const pennants = new THREE.Mesh(pennantGeo, pennantMat);
  pennants.frustumCulled = false;
  pennants.visible = false;
  group.add(pennants);
  const flown = new Map(); // bodyId -> {buildingId, x, z, color, urgent, raised, lowered, seed}
  let attentionSig = 0;
  let lastPennantLayout = -10;
  let pennantLotVersion = -1;

  // The owner disliked pennants on the hall for every docket card; the UI's
  // dock chip is the attention cue now. Keep the code, fly nothing.
  const PENNANTS_ON = false;
  const attentionOf = (view) => (PENNANTS_ON ? view.attention ?? [] : []);

  function attentionSignature(view) {
    let h = 11;
    for (const a of attentionOf(view)) {
      h = Math.imul(h ^ (numId(a.bodyId) * 13 + numId(a.buildingId) * 7 + (a.urgent ? 1 : 0)), 16777619);
      h = Math.imul(h ^ numId(String(a.color)), 16777619);
    }
    return h;
  }

  /** Raise new pennants, lower vanished ones (ease out in the shader). */
  function syncAttention(view, time) {
    const live = new Set();
    for (const a of attentionOf(view)) {
      const key = String(a.bodyId);
      live.add(key);
      const prev = flown.get(key);
      const color = new THREE.Color(a.color ?? '#b5543c');
      if (!prev || prev.lowered < Infinity) {
        flown.set(key, { buildingId: a.buildingId, x: a.x, z: a.z, color, urgent: !!a.urgent, raised: prev && prev.lowered < Infinity ? time : time, lowered: Infinity, seed: hashId(numId(key), 17) });
      } else {
        Object.assign(prev, { buildingId: a.buildingId, x: a.x, z: a.z, color, urgent: !!a.urgent });
      }
    }
    for (const [key, p] of flown) if (!live.has(key) && p.lowered === Infinity) p.lowered = time;
  }

  /** Write pennant instances: poles stand on the roof, stacked per building. */
  function layoutPennants(time) {
    // Drop pennants whose lowering has finished.
    for (const [key, p] of flown) if (time - p.lowered > 1.2) flown.delete(key);
    const perBuilding = new Map();
    let n = 0;
    for (const p of flown.values()) {
      if (n >= MAX_PENNANTS) break;
      const lot = buildings?.lots?.get?.(p.buildingId);
      const s = lot?.summary;
      const k = perBuilding.get(p.buildingId) ?? 0;
      perBuilding.set(p.buildingId, k + 1);
      const cx = s ? s.x : p.x ?? 0;
      const cz = s ? s.z : p.z ?? 0;
      // Side by side along the ridge, each a little taller than the last.
      const ox = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 1.5;
      const x = cx + ox, z = cz;
      const roof = s ? Math.max(s.top ?? 0, (s.base ?? 0) + (s.bodyH ?? 4)) : heightAt(x, z);
      const base = s ? roof - 1.0 : roof;
      const height = (s ? 4.6 : 7.0) + k * 0.8;
      penA.array.set([x, base, z, height], n * 4);
      penB.array.set([p.color.r, p.color.g, p.color.b, p.urgent ? 1 : 0], n * 4);
      penC.array.set([p.raised, p.lowered === Infinity ? 1e9 : p.lowered, p.seed, 0], n * 4);
      n++;
    }
    pennantGeo.instanceCount = n;
    pennants.visible = n > 0;
    for (const a of [penA, penB, penC]) {
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
    lastPennantLayout = time;
  }

  let eventSig = 0;
  const counts = { stalls: 0, boxes: 0, flags: 0, marks: 0 };

  /** True when a point sits inside a building lot (event dressing avoids them). */
  function blocked(x, z, pad = 0.6) {
    for (const lot of buildings?.lots?.values?.() ?? []) {
      const s = lot.summary;
      if (!s || s.type === 'park' || s.type === 'bridge') continue;
      if (Math.abs(x - s.x) < s.w / 2 + pad && Math.abs(z - s.z) < s.d / 2 + pad) return true;
    }
    return Math.abs(x - riverX(z)) < waterHalf() + 1;
  }

  function addBox(x, y, z, sx, sy, sz, color, rotY = 0) {
    if (counts.boxes >= MAX_BOXES) return;
    scratchQ.setFromAxisAngle(Y_AXIS, rotY);
    scratchM.compose(scratchP.set(x, y, z), scratchQ, scratchS.set(sx, sy, sz));
    boxes.setMatrixAt(counts.boxes, scratchM);
    boxes.setColorAt(counts.boxes, color);
    counts.boxes++;
  }

  function addBeamBox(ax, ay, az, bx, by, bz, t, color) {
    if (counts.boxes >= MAX_BOXES) return;
    scratchP.set(bx - ax, by - ay, bz - az);
    const len = scratchP.length();
    scratchQ.setFromUnitVectors(X_AXIS, scratchP.normalize());
    scratchM.compose(scratchP.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), scratchQ, scratchS.set(len, t, t));
    boxes.setMatrixAt(counts.boxes, scratchM);
    boxes.setColorAt(counts.boxes, color);
    counts.boxes++;
  }

  function addFlag(x, y, z, yaw, color) {
    if (counts.flags >= MAX_FLAGS) return;
    scratchQ.setFromAxisAngle(Y_AXIS, yaw);
    scratchM.compose(scratchP.set(x, y, z), scratchQ, scratchS.set(1, 1, 1));
    flags.setMatrixAt(counts.flags, scratchM);
    flags.setColorAt(counts.flags, color);
    counts.flags++;
  }

  /** A draped ground mark (1 scorch, 3 flood). */
  function addMark(x, z, radius, color, mode, seed) {
    if (counts.marks >= MAX_MARKS) return;
    const i = counts.marks++;
    markPos.array.set([x, z, radius, hashId(seed, 13)], i * 4);
    markCol.array.set([color.r, color.g, color.b, mode], i * 4);
  }

  /** Bunting: poles in a ring with sagging strings of pennants between them. */
  function bunting(e, palette, poles) {
    const r = (e.radius ?? 8) * 0.85;
    const pts = [];
    for (let i = 0; i < poles; i++) {
      const a = (i / poles) * Math.PI * 2 + hashId(numId(e.id), 7);
      let x = e.x + Math.cos(a) * r, z = e.z + Math.sin(a) * r;
      // Keep poles out of the river: pull them toward the centre, then to the bank.
      const clear = waterHalf() + 1.5;
      for (let k = 0; k < 6 && Math.abs(x - riverX(z)) < clear; k++) { x = e.x + (x - e.x) * 0.7; z = e.z + (z - e.z) * 0.7; }
      if (Math.abs(x - riverX(z)) < clear) x = riverX(z) + Math.sign(x - riverX(z) || 1) * clear;
      const y = heightAt(x, z);
      addBox(x, y + 1.8, z, 0.12, 3.6, 0.12, C.wood);
      pts.push([x, y + 3.5, z]);
      eventGlow(x, y + 3.65, z, 1.1, 2, i);
    }
    for (let i = 0; i < poles; i++) {
      const [ax, ay, az] = pts[i];
      const [bx, by, bz] = pts[(i + 1) % poles];
      const yaw = Math.atan2(bx - ax, bz - az) + Math.PI / 2;
      const n = 11;
      let px = ax, py = ay, pz = az;
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        const sag = 0.9 * 4 * t * (1 - t);
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t - sag;
        addFlag(x, y, z, yaw, palette[(k + i) % palette.length]);
        addBeamBox(px, py, pz, x, y, z, 0.03, C.rope);
        px = x; py = y; pz = z;
      }
      addBeamBox(px, py, pz, bx, by, bz, 0.03, C.rope);
    }
  }

  function eventGlow(x, y, z, size, kind, seed) {
    if (lampGlowCount + eventGlowCount >= MAX_GLOWS) return;
    writeGlow(lampGlowCount + eventGlowCount, x, y, z, size, kind, hashId(seed, 11));
    eventGlowCount++;
  }

  /**
   * Construction dressing at a public work's site: stone and sett piles that
   * shrink as the work advances, a barrow, and for embankments a scaffold on
   * the bank. Lives in the event boxes mesh (no extra draw call).
   */
  function dressSite(p) {
    const id = numId(p.id);
    const H = waterHalf();
    let x = p.x, z = p.z;
    // Keep the dressing on land: step out of the river onto the nearer bank.
    const u = x - riverX(z);
    if (Math.abs(u) < H + 3.5) x = riverX(z) + (Math.sign(u) || 1) * (H + 4);
    // Find a free spot near the site (not inside a lot).
    for (let k = 0; k < 8 && blocked(x, z, 0.4) && p.kind !== 'embankment'; k++) {
      const a = hashId(id, 30 + k) * Math.PI * 2;
      x = p.x + Math.cos(a) * (2 + k);
      z = p.z + Math.sin(a) * (2 + k);
    }
    // Everything sits level, on the highest ground under it (never tilted
    // into a slope).
    const y = groundMaxAt(x, z, 2.2, 1.6);
    const left = 1 - Math.min(1, p.progress ?? 0);
    const piles = 1 + Math.ceil(left * 3);
    for (let k = 0; k < piles; k++) {
      const a = (k / piles) * Math.PI * 2 + hashId(id, 40);
      const px = x + Math.cos(a) * 1.4, pz = z + Math.sin(a) * 1.4;
      const py = groundMaxAt(px, pz, 0.5, 0.5);
      const stone = jitter(C.stone, hashId(id * 7 + k, 41), 0.2);
      // A small pyramid of blocks.
      addBox(px, py + 0.2, pz, 0.9, 0.4, 0.7, stone, a);
      addBox(px + 0.1, py + 0.55, pz, 0.6, 0.3, 0.5, C.stoneDark, a + 0.3);
      if (k % 2) addBox(px - 0.1, py + 0.8, pz + 0.05, 0.35, 0.22, 0.35, stone, a);
    }
    // Setts stacked flat for paving works.
    if (p.kind !== 'embankment' && p.kind !== 'quay') {
      for (let k = 0; k < 3; k++) addBox(x + 1.8, y + 0.08 + k * 0.14, z - 0.6, 1.1 - k * 0.15, 0.12, 0.8, C.setts, 0.2);
    }
    // A wheelbarrow: tub, handles and a wheel.
    addBox(x - 1.2, y + 0.42, z + 1.0, 0.55, 0.3, 0.8, C.wood, 0.6);
    addBeamBox(x - 1.2, y + 0.4, z + 1.4, x - 1.55, y + 0.55, z + 1.9, 0.05, C.plankDark);
    addBox(x - 1.15, y + 0.18, z + 0.55, 0.06, 0.36, 0.36, C.ironDark, 0.6);
    if (p.kind === 'embankment') {
      // Scaffold poles and a plank walk at the bank edge.
      const s = Math.sign(x - riverX(z)) || 1;
      const ex = riverX(z) + s * (H + 0.6);
      for (const dz of [-1.6, 1.6]) {
        for (const dx of [0, s * 1.2]) addBox(ex + dx, heightAt(ex + dx, z + dz) + 1.0, z + dz, 0.1, 2.4, 0.1, C.plankDark);
      }
      addBox(ex + s * 0.6, y + 1.3, z, 1.5, 0.07, 3.6, C.plank);
    }
  }

  function rebuildEvents(view) {
    counts.stalls = counts.boxes = counts.flags = counts.marks = 0;
    eventGlowCount = 0;
    for (const e of view.worldEvents ?? []) {
      const id = numId(e.id);
      const R = e.radius ?? 8;
      switch (e.kind) {
        case 'market': {
          // Stalls on two rings around the square; skip spots inside lots.
          const n = Math.max(4, Math.min(10, Math.round(R * 0.9)));
          let placed = 0;
          for (let i = 0; i < n * 3 && placed < n && counts.stalls < MAX_STALLS; i++) {
            const a = (i / n) * Math.PI * 2 + hashId(id, 2) * 0.5 + Math.floor(i / n) * 0.4;
            const r = R * (Math.floor(i / n) === 1 ? 0.35 : 0.62 + 0.18 * hashId(id * 13 + i, 3)) * (i >= 2 * n ? 1.3 : 1);
            const x = e.x + Math.cos(a) * r, z = e.z + Math.sin(a) * r;
            if (blocked(x, z, 1.0)) continue;
            // Face the centre: local +z toward the middle of the market.
            const yaw = Math.atan2(e.x - x, e.z - z);
            scratchQ.setFromAxisAngle(Y_AXIS, yaw);
            const s = 0.92 + 0.16 * hashId(id * 7 + i, 4);
            // Highest ground under the corners (posts reach down from there).
            const cy = Math.cos(yaw), sy = Math.sin(yaw);
            let top = heightAt(x, z);
            for (const [lx, lz] of [[-1, -0.5], [1, -0.5], [-1, 0.7], [1, 0.7]]) top = Math.max(top, heightAt(x + lx * cy + lz * sy, z - lx * sy + lz * cy));
            scratchM.compose(scratchP.set(x, top, z), scratchQ, scratchS.set(s, s, s));
            stalls.setMatrixAt(counts.stalls, scratchM);
            stalls.setColorAt(counts.stalls, AWNINGS[(id + i) % AWNINGS.length]);
            counts.stalls++;
            placed++;
          }
          break;
        }
        // Free-standing pole rings and rows read as picket signs (owner
        // feedback), so festivals, weddings, funerals and processions draw no
        // poles for now; the gathered crowd carries the moment.
        case 'festival':
        case 'wedding':
        case 'funeral':
          break;
        // Static placards on bare poles read as unattended pickets (owner
        // feedback). Protests show through the gathered walkers themselves.
        case 'protest':
        case 'strike':
          break;
        case 'procession':
          break;
        case 'fire': {
          addMark(e.x, e.z, R, SCORCH, 1, id);
          for (let k = 0; k < 5; k++) {
            const a = hashId(id, k + 20) * Math.PI * 2;
            const r = hashId(id, k + 30) * R * 0.5;
            const x = e.x + Math.cos(a) * r, z = e.z + Math.sin(a) * r;
            eventGlow(x, heightAt(x, z) + 1.2 + k * 0.3, z, 4 + hashId(id, k) * 3, 1, id * 5 + k);
          }
          break;
        }
        case 'flood':
          addMark(e.x, e.z, R, FLOOD, 3, id);
          break;
        default:
          break;
      }
    }
    for (const p of view.projects ?? []) if (WORK_KINDS_DRESSED.has(p.kind)) dressSite(p);
    for (const [mesh, n] of [[stalls, counts.stalls], [boxes, counts.boxes], [flags, counts.flags]]) {
      mesh.count = n;
      mesh.visible = n > 0;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.needsUpdate = true;
      }
    }
    // Clear mark slots this rebuild did not use (pools draw past them).
    markPos.array.fill(0, counts.marks * 4, MAX_MARKS * 4);
    markPos.needsUpdate = true;
    markCol.needsUpdate = true;
  }

  function eventSignature(view) {
    let h = 3;
    for (const p of view.projects ?? []) {
      if (!WORK_KINDS_DRESSED.has(p.kind)) continue;
      h = Math.imul(h ^ (numId(p.id) * 13 + Math.round((p.progress ?? 0) * 4)), 16777619);
      h = Math.imul(h ^ Math.round(p.x * 2 + p.z * 5), 16777619);
    }
    for (const e of view.worldEvents ?? []) {
      h = Math.imul(h ^ (numId(e.id) * 31 + e.kind.length), 16777619);
      h = Math.imul(h ^ Math.round(e.x * 4 + e.z * 9 + (e.radius ?? 0) * 13), 16777619);
    }
    return h;
  }

  // --- Boats ---------------------------------------------------------------
  // Paths and poses come from boats.js (CPU, riding the water's displayed
  // surface); the shader only places the hull. Eight instances, one draw.
  const BOATS = 8;
  const fleet = createFleet(BOATS);
  const boatGeo = new THREE.InstancedBufferGeometry().copy(boatGeometry());
  const boatP = attr(boatGeo, 'aBoatP', 4, BOATS);  // x, waterline y, z, yaw
  const boatQ = attr(boatGeo, 'aBoatQ', 4, BOATS);  // pitch, roll, waterline (hull frame), 0
  const boatB = attr(boatGeo, 'aBoat2', 4, BOATS);  // length, width, cargo, seed
  for (const b of fleet) boatB.array.set([b.spec.length, b.spec.beam, b.spec.cargo, b.seed], b.i * 4);
  const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  const boatFords = { fords: null, bridges: null };

  function updateBoats(view) {
    boatFords.fords = Terrain.FORDS ?? [];
    boatFords.bridges = view.bridges ?? [];
    planReaches(fleet, boatFords);
    const u = grade.uniforms;
    const decoT = u.uDecoTime.value, waterT = u.uTime.value;
    const P = boatP.array, Q = boatQ.array;
    for (let i = 0; i < boatGeo.instanceCount; i++) {
      const b = fleet[i];
      boatPose(b, decoT, waterT, pose);
      P[i * 4] = pose.x; P[i * 4 + 1] = pose.y; P[i * 4 + 2] = pose.z; P[i * 4 + 3] = pose.yaw;
      Q[i * 4] = pose.pitch; Q[i * 4 + 1] = pose.roll; Q[i * 4 + 2] = b.spec.waterline; Q[i * 4 + 3] = 0;
    }
    boatP.needsUpdate = true;
    boatQ.needsUpdate = true;
  }
  boatGeo.instanceCount = 0;
  const boatMat = gradeLambert(grade, 'boat', {
    vertexColors: true,
    vertexHead: 'attribute vec4 aBoatP;\nattribute vec4 aBoatQ;\nattribute vec4 aBoat2;\nattribute float aExtra;\n' + BOAT_POSE_GLSL,
    vertexNormal: /* glsl */ `
      mat3 boatR = boatBasis(aBoatQ, aBoatP.w);
      objectNormal = boatR * objectNormal;
    `,
    vertexBegin: /* glsl */ `
      vec3 lb = transformed;
      lb.xz *= vec2(aBoat2.y, aBoat2.x);
      // Punts carry no cargo.
      if (aExtra > 0.5) lb *= aBoat2.z;
      // Hull frame to the water: the waterline (aBoatQ.z) sits on the surface.
      lb.y -= aBoatQ.z;
      transformed = aBoatP.xyz + boatR * lb;
    `,
  });
  const boats = new THREE.Mesh(boatGeo, boatMat);
  boats.frustumCulled = false;
  boats.receiveShadow = true;
  boats.layers.enable(LAYER_REFLECT);
  group.add(boats);

  // --- Birds ---------------------------------------------------------------
  const birdGeo = birdGeometry();
  const FLOCKS = 3, PER_FLOCK = 9;
  const BIRDS = FLOCKS * PER_FLOCK + 1;
  const birdA = attr(birdGeo, 'aBird', 4, BIRDS);
  const birdB = attr(birdGeo, 'aBird2', 4, BIRDS);
  for (let f = 0; f < FLOCKS; f++) {
    for (let i = 0; i < PER_FLOCK; i++) {
      const k = f * PER_FLOCK + i;
      // Loose V: birds trail behind and to the sides of the leader.
      const side = i % 2 ? 1 : -1;
      const rank = Math.ceil(i / 2);
      birdA.array.set([side * rank * 1.3 + (hashId(k, 51) - 0.5), (hashId(k, 52) - 0.5) * 1.2, -rank * 1.4, hashId(k, 53) * 6.283], k * 4);
      birdB.array.set([hashId(f, 54), 70 + f * 35, 1.1, 0], k * 4);
    }
  }
  birdA.array.set([0, 0, 40, 1.3], (BIRDS - 1) * 4);
  birdB.array.set([0.5, 0, 2.6, 1], (BIRDS - 1) * 4);
  birdGeo.instanceCount = BIRDS;
  const birdUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(birdUniforms, grade.uniforms, {
    uTown: { value: new THREE.Vector3(-20, 0, 0) },
    uBirdColor: { value: new THREE.Color('#3d4646') },
    tRiverPath: riverPath.uniform,
  });
  const birds = new THREE.Mesh(birdGeo, new THREE.ShaderMaterial({
    uniforms: birdUniforms, vertexShader: BIRD_VERT, fragmentShader: BIRD_FRAG,
    side: THREE.DoubleSide, fog: true,
  }));
  birds.frustumCulled = false;
  group.add(birds);

  // -------------------------------------------------------------------------

  return {
    update(view, frame) {
      if (!view) return;
      const time = frame.time;
      riverPath.sync();
      // Ground pads change under props (new buildings, a new seed): re-place
      // everything that stands on the ground, at most once a second.
      const gv = ground?.version?.() ?? 0;
      if (gv !== groundVersion && time - lastGroundSync > 1) {
        groundVersion = gv;
        lastGroundSync = time;
        bridgeSig = lampSig = eventSig = 0;
        pennantLotVersion = -1;
      }
      // Bridges, walls and street furniture: rebuilt on change, at most once a
      // second (paving creeps cell by cell during works).
      if (time - lastBridgeBuild > 1) {
        const bs = bridgeSignature(view);
        if (bs !== bridgeSig) {
          bridgeSig = bs;
          lastBridgeBuild = time;
          rebuildBridges(view);
        }
      }

      let glowsDirty = false;
      const ls = lampSignature(view);
      if (ls !== lampSig) {
        lampSig = ls;
        rebuildLamps(view);
        rebuildLampGlows(view, frame.target);
        glowsDirty = true;
      } else if ((view.lamps?.length ?? 0) > MAX_GLOWS - 40 && lastGlowCentre.distanceToSquared(frame.target) > 60 * 60) {
        rebuildLampGlows(view, frame.target);
        glowsDirty = true;
      }

      const es = eventSignature(view);
      if (es !== eventSig || glowsDirty) {
        eventSig = es;
        rebuildEvents(view);
        glowsDirty = true;
      }
      if (glowsDirty) flushGlows();
      updateMarkCount();
      // The 16 lamps nearest the view, for walkers' lamp shadows (people.js).
      if (ctx.lampShadow && markUniforms.uLampShadows.value
        && (glowsDirty || lastShadowLampCentre.distanceToSquared(frame.target) > 36)) {
        lastShadowLampCentre.copy(frame.target);
        const list = view.lamps ?? [];
        const t = frame.target;
        const near = [];
        for (let i = 0; i < Math.min(MAX_LAMPS, list.length); i++) {
          const d2 = (list[i].x - t.x) ** 2 + (list[i].z - t.z) ** 2;
          if (near.length < 16 || d2 < near[near.length - 1][0]) {
            near.push([d2, i]);
            near.sort((p, q) => p[0] - q[0]);
            if (near.length > 16) near.pop();
          }
        }
        const u = ctx.lampShadow;
        near.forEach(([, i], k) => {
          const { x, z } = list[i];
          const { lx, lz } = lampArm(x, z);
          u.uLamps.value[k].set(lx, lz, lampBase(x, z) + LANTERN_Y, POOL_RADIUS);
        });
        u.uLampN.value = near.length;
      }

      // Pennants: raise/lower on attention changes; re-seat on lot changes.
      const as = attentionSignature(view);
      let relayout = false;
      if (as !== attentionSig) {
        attentionSig = as;
        syncAttention(view, time);
        relayout = true;
      }
      const lv = buildings?.version?.() ?? 0;
      if (lv !== pennantLotVersion && time - lastPennantLayout > 1) { pennantLotVersion = lv; relayout = true; }
      for (const p of flown.values()) if (p.lowered < Infinity && time - p.lowered > 1.2) relayout = true;
      if (relayout) layoutPennants(time);

      // Boats appear with the era: punts from era 2, barges from era 4.
      const era = view.era ?? 0;
      boatGeo.instanceCount = fleet.none ? 0 : era >= 4 ? BOATS : era >= 2 ? 4 : 0;
      boats.visible = boatGeo.instanceCount > 0;
      if (boats.visible) updateBoats(view);
      // Reduced motion: no birds (boats stay, moored where the frozen clock left them).
      birds.visible = !ctxReduced();
    },
    applyQuality(q) {
      markUniforms.uLampShadows.value = q.lampShadows ? 1 : 0;
      lastShadowLampCentre.set(1e9, 0, 0); // refill the walkers' lamps on the way back up
    },
    dispose() {
      riverPath.dispose();
      scene.remove(group);
      group.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
    },
  };
}
