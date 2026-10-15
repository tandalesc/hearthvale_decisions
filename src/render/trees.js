import * as THREE from 'three';
import { heightAt, riverX, WATER_HALF, terrainSeed } from '../terrain.js';
import { patchMaterial, hashId, LAYER_REFLECT, GRADE_HEAD } from './shaderlib.js';
import { GROUND_GLSL, GROUND_ORIGIN, GROUND_LIMIT } from './ground.js';
import { WOODLAND, useHaze } from './terrain.js';

// Trees (design-visual §3.5, §4.4): a deterministic woodland that frames the
// town like a model village — woods and copses on the hills and at the map
// edge, willows along the river, hedgerows between fields, a few orchards and
// lone field trees. Four global InstancedMeshes (round, tall, pine, bush),
// ~50 triangles each, flat shaded. Seasons, wind and the chop animation all
// run in the vertex shader; the CPU only writes a chop time when a lot or a
// road claims a tree, so steady state costs nothing.

export const KIND = { ROUND: 0, TALL: 1, PINE: 2, BUSH: 3 };
const KIND_NAMES = ['round', 'tall', 'pine', 'bush'];
// Slots kept at the start of each mesh for park trees (placed per park lot).
const PARK_RESERVE = [96, 48, 0, 96];
const EXTENT = 470;
const CELL = 5;
// Default town centre; createTrees passes the real one (ctx.townCentre).
const DEFAULT_TOWN = [-40, 0];
const FLAG_BLOSSOM = 1;
// Kept share of wild trees per quality tier (lowest priority trees drop first).
const KEEP = { low: 0.35, medium: 0.6, high: 1 };

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Placement

/** 0..1 woodland field: broad wavy bands with smaller copse-sized lumps. */
function woodField(x, z) {
  const a = Math.sin(x / 37 + Math.sin(z / 53) * 1.3) * 0.25;
  const b = Math.sin(z / 29 - x / 61 + 1.7) * 0.2;
  const c = Math.sin((x + z) / 17 + Math.cos(x / 23)) * 0.12;
  const d = Math.sin(x / 11 - z / 13) * 0.06;
  return 0.5 + a + b + c + d;
}

/** Share of pines: higher ground and a few large conifer stands. */
function pineShare(x, z, h) {
  const stand = 0.5 + 0.5 * Math.sin(x / 47 + Math.cos(z / 61) * 2);
  return 0.1 + 0.4 * smoothstep(0.55, 0.9, stand) + 0.4 * smoothstep(2.4, 3.6, h);
}

let cachedForest = null;
let cachedSeed;

/**
 * The wild forest, sorted by priority (highest first) so a quality tier can
 * keep a prefix. Arrays are indexed by global tree index.
 */
export function generateForest(TOWN = DEFAULT_TOWN) {
  if (cachedForest && cachedSeed === terrainSeed()) return cachedForest;
  const list = [];
  const push = (x, z, kind, scale, seedId, flags = 0) => {
    if (Math.abs(x) > EXTENT || Math.abs(z) > EXTENT) return;
    if (Math.abs(x - riverX(z)) < WATER_HALF + 2.5) return;
    // Treeline: woods thin out over ~12 units below a ragged line, and steep
    // faces (over ~38 degrees) stay bare rock.
    const h = heightAt(x, z);
    const line = 42 + 18 * hashId(seedId, 24);
    if (h > line || (h > line - 12 && hashId(seedId, 25) < (h - line + 12) / 12)) return;
    const steep = Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1));
    if (steep > 1.6) return;
    list.push({ x, z, kind, scale, seed: hashId(seedId, 21), yaw: hashId(seedId, 22) * Math.PI * 2, p: hashId(seedId, 23), flags });
  };

  // Woods, copses, river trees and lone field trees from one jittered grid.
  const n = Math.round((EXTENT * 2) / CELL);
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const id = gx * 1009 + gz;
      const x = -EXTENT + (gx + hashId(id, 1)) * CELL;
      const z = -EXTENT + (gz + hashId(id, 2)) * CELL;
      const w = woodField(x, z);
      let density = w > 0.62 ? 0.4 + (w - 0.62) * 1.1 : w > 0.52 ? (w - 0.52) * 3 : 0.022;
      density += smoothstep(260, 390, Math.max(Math.abs(x), Math.abs(z))) * 0.2;
      const river = Math.abs(x - riverX(z));
      const riparian = river < 17 ? 0.22 * (0.5 + 0.5 * Math.sin(z / 19 + 1.3)) : 0;
      density += riparian;
      density *= 0.22 + 0.78 * smoothstep(25, 140, Math.hypot(x - TOWN[0], z - TOWN[1]));
      if (hashId(id, 3) >= density) continue;
      const h = heightAt(x, z);
      const pine = riparian > 0 ? 0.03 : pineShare(x, z, h);
      const r = hashId(id, 4);
      const kind = r < pine ? KIND.PINE : riparian > 0 || hashId(id, 5) < 0.55 ? KIND.ROUND : KIND.TALL;
      // Trees deep in the woods grow a little bigger than those at the edge.
      const scale = (0.95 + hashId(id, 6) * 0.5) * (1 + 0.25 * smoothstep(0.62, 0.85, w));
      push(x, z, kind, scale, id);
      // Understory bushes along the wood edges.
      if (w > 0.5 && w < 0.7 && hashId(id, 7) < 0.3) {
        const a = hashId(id, 8) * Math.PI * 2;
        push(x + Math.cos(a) * 2.6, z + Math.sin(a) * 2.6, KIND.BUSH, 0.7 + hashId(id, 9) * 0.5, id + 500000);
      }
    }
  }

  // Hedgerows: broken lines of bushes and small trees between fields.
  for (let i = 0; i < 56; i++) {
    const a = hashId(i, 31) * Math.PI * 2;
    const r = 60 + hashId(i, 32) * 300;
    let x = TOWN[0] + Math.cos(a) * r;
    let z = TOWN[1] + Math.sin(a) * r;
    const alongX = hashId(i, 33) < 0.5;
    const bend = (hashId(i, 34) - 0.5) * 0.25;
    const dx = alongX ? Math.cos(bend) : Math.sin(bend);
    const dz = alongX ? Math.sin(bend) : Math.cos(bend);
    const len = 40 + hashId(i, 35) * 80;
    for (let s = 0, k = 0; s < len; s += 3.6, k++) {
      const id = 700000 + i * 100 + k;
      if (hashId(id, 36) < 0.14) continue; // gaps and field gates
      const px = x + dx * s + (hashId(id, 37) - 0.5) * 0.8;
      const pz = z + dz * s + (hashId(id, 38) - 0.5) * 0.8;
      const pick = hashId(id, 39);
      const kind = pick < 0.62 ? KIND.BUSH : pick < 0.9 ? KIND.ROUND : KIND.TALL;
      push(px, pz, kind, kind === KIND.BUSH ? 0.85 + hashId(id, 40) * 0.5 : 0.85 + hashId(id, 40) * 0.3, id);
    }
  }

  // Copses: small clumps of mixed trees round a few bushes, closer to town
  // than the woods so the village never sits on a bare lawn.
  for (let i = 0; i < 26; i++) {
    const a = hashId(i, 81) * Math.PI * 2;
    const r = 45 + hashId(i, 82) * 190;
    const cx = TOWN[0] + Math.cos(a) * r;
    const cz = TOWN[1] + Math.sin(a) * r;
    const n = 4 + Math.floor(hashId(i, 83) * 7);
    for (let k = 0; k < n; k++) {
      const id = 900000 + i * 100 + k;
      const ang = hashId(id, 84) * Math.PI * 2;
      const rr = Math.sqrt(hashId(id, 85)) * (3 + n * 0.8);
      const pick = hashId(id, 86);
      const kind = pick < 0.25 ? KIND.BUSH : pick < 0.6 ? KIND.ROUND : pick < 0.85 ? KIND.TALL : KIND.PINE;
      push(cx + Math.cos(ang) * rr, cz + Math.sin(ang) * rr, kind, 0.85 + hashId(id, 87) * 0.5, id);
    }
  }
  // Lone field trees scattered through the near meadows.
  for (let i = 0; i < 90; i++) {
    const id = 950000 + i;
    const a = hashId(id, 88) * Math.PI * 2;
    const r = 35 + hashId(id, 89) * 160;
    push(TOWN[0] + Math.cos(a) * r, TOWN[1] + Math.sin(a) * r, hashId(id, 90) < 0.7 ? KIND.ROUND : KIND.TALL, 1 + hashId(id, 91) * 0.45, id);
  }

  // Orchards: small tidy grids of round fruit trees that blossom in spring.
  for (let i = 0; i < 9; i++) {
    const a = hashId(i, 41) * Math.PI * 2;
    const r = 85 + hashId(i, 42) * 150;
    const cx = TOWN[0] + Math.cos(a) * r;
    const cz = TOWN[1] + Math.sin(a) * r;
    const turn = (hashId(i, 43) - 0.5) * 0.4;
    const rows = 3 + Math.floor(hashId(i, 44) * 3);
    const cols = 4 + Math.floor(hashId(i, 45) * 3);
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        const lx = (cc - (cols - 1) / 2) * 5.5;
        const lz = (rr - (rows - 1) / 2) * 5.5;
        const id = 800000 + i * 100 + rr * 10 + cc;
        push(cx + lx * Math.cos(turn) - lz * Math.sin(turn), cz + lx * Math.sin(turn) + lz * Math.cos(turn),
          KIND.ROUND, 0.75 + hashId(id, 46) * 0.2, id, FLAG_BLOSSOM);
      }
    }
  }

  list.sort((a, b) => b.p - a.p);
  const count = list.length;
  const forest = {
    count,
    x: new Float32Array(count), z: new Float32Array(count), y: new Float32Array(count),
    scale: new Float32Array(count), yaw: new Float32Array(count), seed: new Float32Array(count),
    priority: new Float32Array(count), kind: new Uint8Array(count), flags: new Uint8Array(count),
  };
  list.forEach((t, i) => {
    forest.x[i] = t.x; forest.z[i] = t.z; forest.y[i] = heightAt(t.x, t.z) - 0.12;
    forest.scale[i] = t.scale; forest.yaw[i] = t.yaw; forest.seed[i] = t.seed;
    forest.priority[i] = t.p; forest.kind[i] = t.kind; forest.flags[i] = t.flags;
  });
  cachedForest = forest;
  cachedSeed = terrainSeed();
  return forest;
}

/**
 * Woodland density over the ground area for the terrain shader (darker floor
 * under woods): trees per 5 m cell, blurred twice, as an R8 texture.
 */
function woodlandTexture(forest) {
  const N = 128;
  const span = GROUND_LIMIT - GROUND_ORIGIN;
  let grid = new Float32Array(N * N);
  for (let i = 0; i < forest.count; i++) {
    if (forest.kind[i] === KIND.BUSH) continue;
    const cx = Math.floor(((forest.x[i] - GROUND_ORIGIN) / span) * N);
    const cz = Math.floor(((forest.z[i] - GROUND_ORIGIN) / span) * N);
    if (cx >= 0 && cz >= 0 && cx < N && cz < N) grid[cz * N + cx] += 1;
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(N * N);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        let sum = 0, w = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
            sum += grid[zz * N + xx]; w++;
          }
        }
        next[z * N + x] = sum / w;
      }
    }
    grid = next;
  }
  const data = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) data[k] = Math.min(255, grid[k] * 110);
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Deterministic park planting: trees around the lawn, bushes at the edge. */
export function parkPlanting(lot) {
  const s = lot;
  const out = [];
  const hw = s.w / 2, hd = s.d / 2;
  const nTrees = 3 + Math.floor(hashId(s.id, 51) * 4);
  const ring = Math.min(hw, hd) * 0.62;
  for (let i = 0; i < nTrees; i++) {
    // Diagonal angles keep the gravel cross paths clear.
    const a = Math.PI / 4 + (i / nTrees) * Math.PI * 2 + (hashId(s.id * 7 + i, 52) - 0.5) * 0.5;
    const r = ring * (0.85 + hashId(s.id * 7 + i, 53) * 0.3);
    out.push({ kind: hashId(s.id * 7 + i, 54) < 0.7 ? KIND.ROUND : KIND.TALL, x: s.x + Math.cos(a) * r * (hw / Math.max(hw, hd)), z: s.z + Math.sin(a) * r * (hd / Math.max(hw, hd)), scale: 0.85 + hashId(s.id * 7 + i, 55) * 0.3, seed: hashId(s.id * 7 + i, 56), flags: hashId(s.id, 57) < 0.4 ? FLAG_BLOSSOM : 0 });
  }
  const nBush = 2 + Math.floor(hashId(s.id, 58) * 4);
  for (let i = 0; i < nBush; i++) {
    const side = Math.floor(hashId(s.id * 13 + i, 59) * 4);
    const t = hashId(s.id * 13 + i, 60) * 2 - 1;
    const bx = side < 2 ? t * (hw - 1) : (side === 2 ? -1 : 1) * (hw - 0.9);
    const bz = side < 2 ? (side === 0 ? -1 : 1) * (hd - 0.9) : t * (hd - 1);
    out.push({ kind: KIND.BUSH, x: s.x + bx, z: s.z + bz, scale: 0.7 + hashId(s.id * 13 + i, 61) * 0.4, seed: hashId(s.id * 13 + i, 62), flags: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry: non-indexed, one normal per face, with aPart (0 trunk, 1 canopy,
// 2 evergreen), aPivot (canopy blob centre, for the bare-winter shrink) and
// aShade (per-face brightness jitter for a hand-painted look).

class TreeBuilder {
  constructor(salt) {
    this.pos = []; this.part = []; this.pivot = []; this.shade = []; this.salt = salt; this.face = 0;
  }

  tri(a, b, c, part, pivot) {
    // Per-face shade: random jitter, undersides darker.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
    const shade = (0.88 + hashId(this.face++, this.salt) * 0.22) * (ny / len < -0.2 ? 0.82 : 1);
    for (const v of [a, b, c]) {
      this.pos.push(v[0], v[1], v[2]);
      this.part.push(part);
      this.pivot.push(pivot[0], pivot[1], pivot[2]);
      this.shade.push(shade);
    }
  }

  /** Tapered n-sided prism (trunks), sides only. */
  trunk(r0, r1, y0, y1, sides = 4) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const p = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
      this.tri(p(a1, r0, y0), p(a0, r0, y0), p(a0, r1, y1), 0, [0, 0, 0]);
      this.tri(p(a1, r0, y0), p(a0, r1, y1), p(a1, r1, y1), 0, [0, 0, 0]);
    }
  }

  /** Icosahedron blob with deterministic vertex jitter (shared corners move together). */
  blob(cx, cy, cz, r, sy = 1, part = 1, jitter = 0.16) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const p = g.attributes.position;
    const jit = (x, y, z) => {
      const k = Math.round(x * 97) * 7 + Math.round(y * 89) * 13 + Math.round(z * 83) * 29;
      return 1 + (hashId(k + this.salt * 1000, 71) - 0.5) * 2 * jitter;
    };
    const verts = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const j = jit(x, y, z);
      verts.push([cx + x * r * j, cy + y * r * sy * j, cz + z * r * j]);
    }
    for (let i = 0; i < verts.length; i += 3) this.tri(verts[i], verts[i + 1], verts[i + 2], part, [cx, cy, cz]);
    g.dispose();
  }

  /** Six-sided open cone (pine tiers). */
  cone(r, y0, h, sides = 6, twist = 0) {
    const apex = [0, y0 + h, 0];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2 + twist, a1 = ((i + 1) / sides) * Math.PI * 2 + twist;
      const b0 = [Math.cos(a0) * r, y0, Math.sin(a0) * r];
      const b1 = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
      // No base cap: from the game camera and the sun the tiers above and
      // below hide it, and the back faces still close the shadow silhouette.
      this.tri(b1, b0, apex, 2, [0, y0, 0]);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.pivot, 3));
    g.setAttribute('aShade', new THREE.Float32BufferAttribute(this.shade, 1));
    g.computeVertexNormals(); // non-indexed: face normals
    g.computeBoundingSphere();
    return g;
  }
}

function buildGeometry(kind) {
  const b = new TreeBuilder(kind + 3);
  if (kind === KIND.ROUND) {
    b.trunk(0.2, 0.13, -0.3, 2.7);
    b.blob(0, 3.5, 0, 1.75, 0.88);
    b.blob(0.75, 2.75, 0.45, 1.15, 0.85);
  } else if (kind === KIND.TALL) {
    b.trunk(0.17, 0.11, -0.3, 3.2);
    b.blob(0, 4.3, 0, 1.3, 1.55, 1, 0.12);
    b.blob(-0.35, 2.85, 0.2, 1.0, 1.0);
  } else if (kind === KIND.PINE) {
    b.trunk(0.2, 0.14, -0.3, 1.4);
    b.cone(1.75, 0.9, 2.2, 6, 0);
    b.cone(1.32, 2.15, 1.95, 6, 0.5);
    b.cone(0.86, 3.3, 1.75, 6, 0.15);
  } else {
    b.blob(0, 0.6, 0, 1.0, 0.72, 1, 0.24);
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// Shaders

const VERTEX_HEAD = GROUND_GLSL + /* glsl */ `
attribute float aPart;
attribute vec3 aPivot;
attribute float aShade;
attribute vec4 iTree;   // seed, priority, chop start time (0 = standing), flags
uniform float uYearT;
`;

// Object space: winter bareness shrinks deciduous canopies toward their blob
// centre; the chop tilts the tree ~12 degrees about its base, shrinks it, then
// collapses it to a point.
const VERTEX_BEGIN = /* glsl */ `
  float seedT = iTree.x;
  float bareK = 0.0;
  #if TREE_KIND != 2
    // Bare branches arrive tree by tree (seed staggers the turn).
    bareK = clamp(uBare * 1.35 - seedT * 0.35, 0.0, 1.0);
    #if TREE_KIND == 3
      bareK *= 0.55;
    #endif
    if (aPart > 0.5 && aPart < 1.5) {
      transformed = aPivot + (transformed - aPivot) * mix(vec3(1.0), vec3(0.6, 0.66, 0.6), bareK);
    }
  #endif
  float chopK = iTree.z != 0.0 ? clamp((uTime - iTree.z) / 0.6, 0.0, 1.0) : 0.0;
  float tilt = 0.21 * smoothstep(0.0, 0.55, chopK);
  transformed.yz = mat2(cos(tilt), sin(tilt), -sin(tilt), cos(tilt)) * transformed.yz;
  transformed.y *= 1.0 - smoothstep(0.35, 1.0, chopK);
  transformed *= step(chopK, 0.999);
`;

// World space wind: a slow two-frequency sway that grows with height above
// the lower trunk, so roots stay put and crowns move.
const PROJECT = /* glsl */ `
  vec4 treeWorld = instanceMatrix * vec4(transformed, 1.0);
  // Drape on the shared ground (building pads included) inside its area;
  // trees beyond it keep their analytic height.
  vec2 baseXZ = instanceMatrix[3].xz;
  vec2 gLo = uGroundOrigin + 1.0;
  vec2 gHi = uGroundOrigin + (uGroundN - 2.0) * uGroundStep;
  if (all(greaterThan(baseXZ, gLo)) && all(lessThan(baseXZ, gHi))) {
    treeWorld.y += groundHeight(baseXZ) - 0.12 - instanceMatrix[3].y;
  }
  float swayH = max(0.0, transformed.y - 1.5);
  float sway = sin(uDecoTime * 1.1 + treeWorld.x * 0.09 + treeWorld.z * 0.07 + iTree.x * 6.28) * 0.6
             + sin(uDecoTime * 2.3 + iTree.x * 17.0) * 0.15;
  treeWorld.xz += uWind * sway * swayH * 0.022;
  vec4 mvPosition = modelViewMatrix * treeWorld;
  gl_Position = projectionMatrix * mvPosition;
`;

const VERTEX_COLOR = /* glsl */ `
  // Leaf colour: summer greens by seed, autumn turn staggered per tree,
  // bare winter wood, spring freshness and blossom on fruit trees.
  float s2 = fract(seedT * 7.13);
  float s3 = fract(seedT * 3.71);
  vec3 trunkCol = vec3(0.16, 0.095, 0.05) * (0.85 + 0.3 * s3);
  vec3 leaf;
  #if TREE_KIND == 2
    leaf = mix(vec3(0.060, 0.160, 0.066), vec3(0.048, 0.125, 0.056), s2);
  #else
    leaf = s2 < 0.33 ? vec3(0.114, 0.262, 0.069) : s2 < 0.66 ? vec3(0.141, 0.262, 0.073) : vec3(0.076, 0.209, 0.085);
    #if TREE_KIND == 3
      leaf *= vec3(0.9, 0.95, 0.85);
    #endif
    float fresh = smoothstep(0.07, 0.14, uYearT) * (1.0 - smoothstep(0.22, 0.34, uYearT));
    leaf = mix(leaf, leaf * vec3(1.35, 1.3, 0.8), fresh * 0.6);
    vec3 autumnCol = s3 < 0.25 ? vec3(0.571, 0.279, 0.044) : s3 < 0.5 ? vec3(0.479, 0.122, 0.027)
                   : s3 < 0.75 ? vec3(0.693, 0.445, 0.069) : vec3(0.323, 0.195, 0.026);
    float turn = clamp(uAutumn * 1.6 - seedT * 0.6, 0.0, 1.0);
    #if TREE_KIND == 3
      turn *= 0.5;
    #endif
    leaf = mix(leaf, autumnCol, turn);
    leaf = mix(leaf, vec3(0.195, 0.144, 0.098), bareK);
    float blossomOn = mod(iTree.w, 2.0) >= 1.0 || seedT < 0.12 ? 1.0 : 0.0;
    #if TREE_KIND == 3
      blossomOn = 0.0; // blossoming bushes read as pale rocks from above
    #endif
    leaf = mix(leaf, vec3(0.90, 0.56, 0.64), uBlossom * blossomOn * 0.85);
  #endif
  // Lower canopy faces sit in their own shade.
  float under = aPart > 0.5 ? smoothstep(-1.6, 0.6, position.y - aPivot.y) : 1.0;
  vTreeCol = (aPart < 0.5 ? trunkCol : leaf * (0.78 + 0.22 * under)) * aShade;
  vTreeUp = normalize(mat3(instanceMatrix) * objectNormal).y;
  vTreeBare = aPart > 0.5 && aPart < 1.5 ? bareK : 0.0;
`;

function makeMaterials(grade, kind) {
  const defines = { TREE_KIND: kind };
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  patchMaterial(material, grade, {
    key: `tree:${kind}`,
    defines,
    vertexHead: VERTEX_HEAD + 'varying vec3 vTreeCol;\nvarying float vTreeUp;\nvarying float vTreeBare;\n',
    vertexBegin: VERTEX_BEGIN,
    vertexEnd: VERTEX_COLOR,
    fragmentHead: 'varying vec3 vTreeCol;\nvarying float vTreeUp;\nvarying float vTreeBare;\n',
    fragmentColor: /* glsl */ `
      vec3 col = vTreeCol;
      // Snow caps on up-facing faces (bare crowns hold a little less), plus a
      // light frosting on every face so winter woods read pale, not black.
      float snowAmt = smoothstep(0.25, 0.8, uSnow);
      float snowK = snowAmt * smoothstep(0.12, 0.55, vTreeUp) * (1.0 - 0.25 * vTreeBare);
      col = mix(col, vec3(0.62, 0.64, 0.68), snowAmt * 0.22);
      col = mix(col, vec3(0.88, 0.9, 0.93), snowK);
      diffuseColor.rgb = col * uTint;
    `,
  });
  useHaze(material, grade);
  const patched = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    patched(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', PROJECT);
  };

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms);
    shader.defines = { ...(shader.defines ?? {}), ...defines };
    shader.vertexShader = GRADE_HEAD + VERTEX_HEAD + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERTEX_BEGIN)
      .replace('#include <project_vertex>', PROJECT);
  };
  depth.customProgramCacheKey = () => `treedepth:${kind}`;
  return { material, depth };
}

// ---------------------------------------------------------------------------
// System

export function createTrees(ctx) {
  const { scene, grade, lights } = ctx;
  const forest = generateForest(ctx.townCentre ? [ctx.townCentre.x, ctx.townCentre.z] : undefined);
  const group = new THREE.Group();
  group.name = 'trees';
  scene.add(group);

  // Global tree index -> slot in its kind mesh. Wild trees follow the park
  // reserve, in priority order, so a tier keeps a prefix of each mesh.
  const slotOf = new Int32Array(forest.count);
  const wildCount = [0, 0, 0, 0];
  for (let i = 0; i < forest.count; i++) {
    const k = forest.kind[i];
    slotOf[i] = PARK_RESERVE[k] + wildCount[k]++;
  }

  const meshes = [];
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < 4; k++) {
    const capacity = PARK_RESERVE[k] + wildCount[k];
    const { material, depth } = makeMaterials(grade, k);
    const mesh = new THREE.InstancedMesh(buildGeometry(k), material, Math.max(1, capacity));
    mesh.name = `trees:${KIND_NAMES[k]}`;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = depth;
    mesh.layers.enable(LAYER_REFLECT);
    const iTree = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 4), 4);
    iTree.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('iTree', iTree);
    // Park reserve starts hidden.
    matrix.makeScale(0, 0, 0);
    for (let s = 0; s < PARK_RESERVE[k]; s++) mesh.setMatrixAt(s, matrix);
    meshes.push({ mesh, iTree, lo: Infinity, hi: -1, freePark: Array.from({ length: PARK_RESERVE[k] }, (_, i) => PARK_RESERVE[k] - 1 - i) });
    group.add(mesh);
  }

  for (let i = 0; i < forest.count; i++) {
    const m = meshes[forest.kind[i]];
    const s = slotOf[i];
    pos.set(forest.x[i], forest.y[i], forest.z[i]);
    quat.setFromAxisAngle(up, forest.yaw[i]);
    scl.setScalar(forest.scale[i]);
    matrix.compose(pos, quat, scl);
    m.mesh.setMatrixAt(s, matrix);
    m.iTree.array.set([forest.seed[i], forest.priority[i], 0, forest.flags[i]], s * 4);
  }
  for (const m of meshes) m.mesh.instanceMatrix.needsUpdate = true;

  // Spatial hash of wild trees for footprint clearing.
  const GRID = 12;
  const grid = new Map();
  const key = (cx, cz) => cx * 100003 + cz;
  for (let i = 0; i < forest.count; i++) {
    const k = key(Math.floor(forest.x[i] / GRID), Math.floor(forest.z[i] / GRID));
    let cell = grid.get(k);
    if (!cell) grid.set(k, (cell = []));
    cell.push(i);
  }

  WOODLAND.tWood.value = woodlandTexture(forest);

  // Shared with decals.js (tree contact blobs follow chops and the tier).
  const chopT = new Float32Array(forest.count);
  const shared = { forest, chopT, chopVersion: 0, keep: 1 };
  ctx.forest = shared;

  let primed = false;
  let lastBuildings = -1;
  let lastRoadsRef = null;
  let lastRoadsVersion = -1;
  let choppedThisFrame = 0;
  const lotKeys = new Map(); // lot id -> footprint key already cleared
  const parks = new Map(); // lot id -> [{kind, slot}]

  function chop(i, time) {
    if (chopT[i] !== 0) return;
    chopT[i] = time;
    const m = meshes[forest.kind[i]];
    const s = slotOf[i];
    m.iTree.array[s * 4 + 2] = time;
    if (s < m.lo) m.lo = s;
    if (s > m.hi) m.hi = s;
    shared.chopVersion++;
    choppedThisFrame++;
  }

  /** Chop trees whose crowns overlap a box (lot footprint x1.3). */
  function clearBox(x0, z0, x1, z1, time) {
    for (let cz = Math.floor((z0 - 3) / GRID); cz <= Math.floor((z1 + 3) / GRID); cz++) {
      for (let cx = Math.floor((x0 - 3) / GRID); cx <= Math.floor((x1 + 3) / GRID); cx++) {
        const cell = grid.get(key(cx, cz));
        if (!cell) continue;
        for (const i of cell) {
          const r = forest.kind[i] === KIND.BUSH ? 0.5 : 1.1 * forest.scale[i];
          const x = forest.x[i], z = forest.z[i];
          if (x + r > x0 && x - r < x1 && z + r > z0 && z - r < z1) chop(i, time);
        }
      }
    }
  }

  function clearRoads(roads, time) {
    const { W, H, cell, ox, oz, tier, wear } = roads;
    if (!tier) return;
    for (let i = 0; i < forest.count; i++) {
      if (chopT[i] !== 0) continue;
      const reach = forest.kind[i] === KIND.BUSH ? 0.7 : 1.5 * forest.scale[i];
      for (let k = 0; k < 5; k++) {
        const x = forest.x[i] + (k === 1 ? reach : k === 2 ? -reach : 0);
        const z = forest.z[i] + (k === 3 ? reach : k === 4 ? -reach : 0);
        const cx = Math.floor((x - ox) / cell), cz = Math.floor((z - oz) / cell);
        if (cx < 0 || cz < 0 || cx >= W || cz >= H) continue;
        const c = cz * W + cx;
        if (tier[c] >= 2 || (wear && wear[c] >= 300)) { chop(i, time); break; }
      }
    }
  }

  function syncLots(time) {
    const seen = new Set();
    for (const [id, lot] of ctx.buildings.lots) {
      const s = lot.summary;
      if (!s) continue;
      seen.add(id);
      const k = `${s.x},${s.z},${s.w},${s.d}`;
      if (lotKeys.get(id) !== k) {
        lotKeys.set(id, k);
        const hw = s.w * 0.65, hd = s.d * 0.65;
        clearBox(s.x - hw, s.z - hd, s.x + hw, s.z + hd, time);
        if (s.type === 'park') plantPark(id, s);
        else removePark(id);
      }
    }
    for (const id of lotKeys.keys()) {
      if (!seen.has(id)) { lotKeys.delete(id); removePark(id); }
    }
  }

  function plantPark(id, s) {
    removePark(id);
    const slots = [];
    for (const t of parkPlanting(s)) {
      const m = meshes[t.kind];
      const slot = m.freePark.pop();
      if (slot === undefined) continue;
      pos.set(t.x, ctx.heightAt(t.x, t.z) - 0.12, t.z);
      quat.setFromAxisAngle(up, t.seed * Math.PI * 2);
      scl.setScalar(t.scale);
      matrix.compose(pos, quat, scl);
      m.mesh.setMatrixAt(slot, matrix);
      m.iTree.array.set([t.seed, 1, 0, t.flags], slot * 4);
      if (slot < m.lo) m.lo = slot;
      if (slot > m.hi) m.hi = slot;
      m.matrixDirty = true;
      slots.push({ kind: t.kind, slot });
    }
    parks.set(id, slots);
  }

  function removePark(id) {
    const slots = parks.get(id);
    if (!slots) return;
    matrix.makeScale(0, 0, 0);
    for (const { kind, slot } of slots) {
      const m = meshes[kind];
      m.mesh.setMatrixAt(slot, matrix);
      m.freePark.push(slot);
      if (slot < m.lo) m.lo = slot;
      if (slot > m.hi) m.hi = slot;
      m.matrixDirty = true;
    }
    parks.delete(id);
  }

  function flush() {
    for (const m of meshes) {
      if (m.hi < m.lo) continue;
      m.iTree.clearUpdateRanges();
      m.iTree.addUpdateRange(m.lo * 4, (m.hi - m.lo + 1) * 4);
      m.iTree.needsUpdate = true;
      if (m.matrixDirty) {
        const im = m.mesh.instanceMatrix;
        im.clearUpdateRanges();
        im.addUpdateRange(m.lo * 16, (m.hi - m.lo + 1) * 16);
        im.needsUpdate = true;
        m.matrixDirty = false;
      }
      m.lo = Infinity;
      m.hi = -1;
    }
  }

  function update(view, frame) {
    // On the first frame everything already claimed vanishes at once.
    const time = primed ? frame.time : -1000;
    choppedThisFrame = 0;
    const roads = view?.roads;
    if (roads && (roads !== lastRoadsRef || roads.version !== lastRoadsVersion)) {
      lastRoadsRef = roads;
      lastRoadsVersion = roads.version;
      clearRoads(roads, time);
    }
    const bv = ctx.buildings.version();
    if (bv !== lastBuildings) {
      lastBuildings = bv;
      syncLots(time);
    }
    flush();
    if (primed && choppedThisFrame) lights.animateFor(0.8, frame.time);
    else if (!primed) lights.markDirty();
    primed = true;
  }

  function applyQuality(q) {
    const keep = KEEP[q.name] ?? 1;
    shared.keep = keep;
    for (let k = 0; k < 4; k++) {
      meshes[k].mesh.count = PARK_RESERVE[k] + Math.round(wildCount[k] * keep);
    }
    // Low tier: the shadow pass skips bushes.
    meshes[KIND.BUSH].mesh.castShadow = q.name !== 'low';
  }
  applyQuality(ctx.quality);

  return {
    group,
    update,
    applyQuality,
    count: () => forest.count,
    triangles: () => meshes.reduce((n, m) => n + (m.mesh.geometry.attributes.position.count / 3) * m.mesh.count, 0),
    dispose() {
      for (const m of meshes) {
        m.mesh.geometry.dispose();
        m.mesh.material.dispose();
        m.mesh.customDepthMaterial.dispose();
      }
      WOODLAND.tWood.value.dispose();
      scene.remove(group);
    },
  };
}
