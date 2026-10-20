import * as THREE from 'three';
import { heightAt, riverX, WATER_HALF, terrainKey, bankDistance } from '../terrain.js';
import { patchMaterial, hashId, LAYER_REFLECT, GRADE_HEAD, NOISE } from './shaderlib.js';
import { GROUND_GLSL, GROUND_ORIGIN, GROUND_LIMIT, shoreCharacter } from './ground.js';
import { WOODLAND } from './terrain.js';
import { woodField } from '../woodland.js';
import { TIERS } from './quality.js';

// Trees (design-visual §3.5, §4.4): a deterministic woodland that frames the
// town like a model village — woods and copses on the hills and at the map
// edge, willows along the river, hedgerows between fields, a few orchards and
// lone field trees.
//
// Five species meshes (broadleaf, tall, fir, bush, willow), each with two
// levels of detail drawn as two InstancedMeshes: FAR holds the whole forest
// and drops trees near the eye in its vertex shader; NEAR holds only the
// trees within reach of the eye (refilled on the CPU when the camera has
// moved a few metres) and draws them with full crowns. Seasons, species
// palettes, wind, light through leaves and the chop animation all run on the
// GPU; the CPU only writes a chop time when a lot or a road claims a tree.

export const KIND = { ROUND: 0, TALL: 1, PINE: 2, BUSH: 3, WILLOW: 4 };
const KIND_NAMES = ['round', 'tall', 'pine', 'bush', 'willow'];
const KINDS = KIND_NAMES.length;
// Slots kept at the start of each mesh for park trees (placed per park lot).
const PARK_RESERVE = [96, 48, 0, 96, 0];
const EXTENT = 470;
const CELL = 5;
// Default town centre; createTrees passes the real one (ctx.townCentre).
const DEFAULT_TOWN = [-40, 0];
const FLAG_BLOSSOM = 1;
// Trees of the denser-woods pass (High; a share on Medium). Never on Low.
const FLAG_EXTRA = 2;
// Kept share of wild trees per quality tier (lowest priority trees drop first),
// and of the denser-woods pass.
const KEEP = { low: 0.35, medium: 0.6, high: 1 };
const KEEP_EXTRA = { low: TIERS.low.woods, medium: TIERS.medium.woods, high: TIERS.high.woods };
const TIER_RANK = { low: 0, medium: 1, high: 2 };
// Trees closer than this to the eye draw at full detail (metres), per tier.
const NEAR_DIST = { low: 55, medium: 85, high: 120 };
// The near set is refilled when the eye has moved this far; it holds every
// tree within NEAR_DIST + NEAR_SLACK, so the GPU test always finds its tree.
const NEAR_SLACK = 10;
const NEAR_MOVE = 8;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Placement

// The woodland field (0..1) lives in ../woodland.js, shared with the sim (walks along
// the woods' edge go where these woods are drawn).

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
  if (cachedForest && cachedSeed === terrainKey()) return cachedForest;
  const list = [];
  const push = (x, z, kind, scale, seedId, flags = 0) => {
    if (Math.abs(x) > EXTENT || Math.abs(z) > EXTENT) return;
    // Out of every water (river, creeks, lakes, the sea) and off the beaches.
    const shore = bankDistance(x, z);
    if (shore < 2.5) return;
    const beach = shore < 60 ? shoreCharacter(x, z, shore) : 0;
    if (beach > 0 && shore < beach + 3) return;
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
      // Distance from the water's centre line, as for the river (so lake and
      // pond shores get their willows and alders too; beaches stay open).
      const river = bankDistance(x, z) + WATER_HALF;
      const riparian = river < 17 ? 0.22 * (0.5 + 0.5 * Math.sin(z / 19 + 1.3)) : 0;
      density += riparian;
      density *= 0.22 + 0.78 * smoothstep(25, 140, Math.hypot(x - TOWN[0], z - TOWN[1]));
      if (hashId(id, 3) >= density) continue;
      const h = heightAt(x, z);
      const pine = riparian > 0 ? 0.03 : pineShare(x, z, h);
      const r = hashId(id, 4);
      // Willows lean over the water; alders and birches stand behind them.
      const willow = river < 13.5 && hashId(id, 10) < 0.6;
      const kind = willow ? KIND.WILLOW : r < pine ? KIND.PINE : riparian > 0 || hashId(id, 5) < 0.55 ? KIND.ROUND : KIND.TALL;
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

  // Denser woods: a second grid, offset half a cell, fills the deep woods;
  // species gather in stands (birch groves, beech and oak, conifers where the
  // first pass put them); saplings and scrub soften the edges, and bushes grow
  // under the canopy. All flagged extra: High draws them, Medium a share.
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const id = 2000000 + gx * 1009 + gz;
      const x = -EXTENT + (gx + 0.5 + (hashId(id, 1) - 0.5) * 0.9) * CELL;
      const z = -EXTENT + (gz + 0.5 + (hashId(id, 2) - 0.5) * 0.9) * CELL;
      const w = woodField(x, z);
      if (w < 0.54) continue;
      const townK = 0.22 + 0.78 * smoothstep(25, 140, Math.hypot(x - TOWN[0], z - TOWN[1]));
      const deep = smoothstep(0.6, 0.8, w);
      const edge = smoothstep(0.54, 0.62, w) * (1 - deep);
      const r = hashId(id, 3);
      const h = heightAt(x, z);
      const birchy = 0.5 + 0.5 * Math.sin(z / 33 - Math.sin(x / 41) * 2 + 0.6);
      const pick = () => {
        if (hashId(id, 4) < pineShare(x, z, h)) return KIND.PINE;
        return hashId(id, 5) < 0.25 + 0.6 * smoothstep(0.62, 0.85, birchy) ? KIND.TALL : KIND.ROUND;
      };
      if (r < deep * 0.72 * townK) {
        // Canopy: bigger and more varied the deeper in.
        push(x, z, pick(), (0.8 + hashId(id, 6) * 0.65) * (1 + 0.22 * deep), id, FLAG_EXTRA);
      } else if (r < (deep * 0.72 + edge * 0.45) * townK) {
        // Saplings and young trees at the margin.
        push(x, z, pick(), 0.55 + hashId(id, 6) * 0.3, id, FLAG_EXTRA);
      }
      // Understorey: holly, hazel and bramble under the trees and at the edge.
      if (hashId(id, 7) < (0.3 * deep + 0.35 * edge) * townK) {
        const a = hashId(id, 8) * Math.PI * 2;
        push(x + Math.cos(a) * 1.9, z + Math.sin(a) * 1.9, KIND.BUSH, 0.6 + hashId(id, 9) * 0.6, id + 500000, FLAG_EXTRA);
      }
    }
  }
  // Rank by the tiers that draw a tree (Low's set, then Medium's additions,
  // then High's), then by priority: every tier keeps a prefix.
  // Per kind, as the tiers always kept their share of each species.
  for (let k = 0; k < KINDS; k++) {
    for (const extra of [false, true]) {
      const group = list.filter((t) => t.kind === k && !!(t.flags & FLAG_EXTRA) === extra).sort((a, b) => b.p - a.p);
      const low = extra ? 0 : Math.round(group.length * KEEP.low);
      const medium = Math.round(group.length * (extra ? KEEP_EXTRA.medium : KEEP.medium));
      group.forEach((t, i) => { t.rank = i < low ? 0 : i < medium ? 1 : 2; });
    }
  }
  list.sort((a, b) => a.rank - b.rank || b.p - a.p);
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
    // Sort key: the tier rank first, then the tree's own priority.
    forest.priority[i] = (2 - t.rank + t.p) / 3; forest.kind[i] = t.kind; forest.flags[i] = t.flags;
  });
  // Trees each tier draws (a prefix of the list), overall and per kind.
  forest.tierCount = [0, 0, 0];
  forest.tierKind = [0, 1, 2].map(() => new Array(KINDS).fill(0));
  list.forEach((t) => {
    for (let r = t.rank; r < 3; r++) { forest.tierCount[r]++; forest.tierKind[r][t.kind]++; }
  });
  cachedForest = forest;
  cachedSeed = terrainKey();
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
    // The woodland floor follows the first pass (the same on every tier).
    if (forest.kind[i] === KIND.BUSH || forest.flags[i] & FLAG_EXTRA) continue;
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
// Geometry: non-indexed, with soft "volume" normals, aPart (0 trunk/branch,
// 1 deciduous canopy, 2 evergreen), aPivot (canopy clump centre, for the
// bare-winter shrink) and aShade (baked crown occlusion x per-clump tone).
//
// Every species has two levels: NEAR (a crown of several lumpy clumps, real
// branches, tiered firs, hanging willow fronds; ~60-150 triangles) for trees
// close to the eye, and FAR (one or two blobs; ~20-40 triangles) for the rest
// of the forest. Both levels share the crown's bounding volume, so their
// normals and occlusion agree and the swap reads as a gain in detail only.

// FAR draws trees beyond the near distance; NEAR those within it; ALL (bushes,
// too small to need a near level) draws every instance.
const LOD = { FAR: 0, NEAR: 1, ALL: 2 };

class TreeBuilder {
  constructor(salt) {
    this.salt = salt;
    this.v = []; // {p, f (face normal), part, pivot, ring, clump, faceShade}
    this.face = 0;
    this.clumps = 0;
  }

  tri(a, b, c, part, pivot, ring = [1, 1, 1], clump = 0) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const faceShade = 0.95 + hashId(this.face++, this.salt) * 0.1;
    [a, b, c].forEach((p, k) => this.v.push({ p, f: [nx, ny, nz], part, pivot, ring: ring[k], clump, faceShade }));
  }

  /** Tapered n-sided prism from base (x0,y0,z0) to top (x1,y1,z1). */
  limb(r0, r1, p0, p1, sides = 5) {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const al = Math.hypot(ax, ay, az);
    const d = [ax / al, ay / al, az / al];
    // A basis perpendicular to the limb.
    const t = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let e1 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
    const l1 = Math.hypot(...e1); e1 = e1.map((x) => x / l1);
    const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const ring = (p, r, a) => [p[0] + (Math.cos(a) * e1[0] + Math.sin(a) * e2[0]) * r, p[1] + (Math.cos(a) * e1[1] + Math.sin(a) * e2[1]) * r, p[2] + (Math.cos(a) * e1[2] + Math.sin(a) * e2[2]) * r];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      this.tri(ring(p0, r0, a1), ring(p0, r0, a0), ring(p1, r1, a0), 0, p0);
      this.tri(ring(p0, r0, a1), ring(p1, r1, a0), ring(p1, r1, a1), 0, p0);
    }
  }

  /** Lumpy icosahedron clump (shared corners jitter together). */
  blob(cx, cy, cz, r, sy = 1, part = 1, jitter = 0.18, detail = 0) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const p = g.attributes.position;
    const clump = this.clumps++;
    const jit = (x, y, z) => {
      const k = Math.round(x * 97) * 7 + Math.round(y * 89) * 13 + Math.round(z * 83) * 29 + clump * 1013;
      return 1 + (hashId(k + this.salt * 1000, 71) - 0.5) * 2 * jitter;
    };
    const verts = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const j = jit(x, y, z);
      verts.push([cx + x * r * j, cy + y * r * sy * j, cz + z * r * j]);
    }
    for (let i = 0; i < verts.length; i += 3) this.tri(verts[i], verts[i + 1], verts[i + 2], part, [cx, cy, cz], [1, 1, 1], clump);
    g.dispose();
  }

  /**
   * A fir tier: drooping outer skirt -> shoulder ring -> apex. `droop` lowers
   * alternate tips so the edge is ragged, not a clean cone.
   */
  tier(r, y0, h, sides, twist, droop = 0.18, shoulder = true) {
    const clump = this.clumps++;
    const apex = [0, y0 + h, 0];
    const outer = [], mid = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + twist;
      const rr = r * (0.9 + 0.2 * hashId(i + clump * 31, this.salt + 5));
      outer.push([Math.cos(a) * rr, y0 - (i % 2 ? droop : 0), Math.sin(a) * rr]);
      const am = a + Math.PI / sides;
      mid.push([Math.cos(am) * r * 0.52, y0 + h * 0.38, Math.sin(am) * r * 0.52]);
    }
    const pv = [0, y0, 0];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (shoulder) {
        // Outer band (tips bright) up to the shoulder ring (in shade), then the cap.
        this.tri(outer[j], outer[i], mid[i], 2, pv, [1, 1, 0.72], clump);
        this.tri(outer[j], mid[i], mid[j], 2, pv, [1, 0.72, 0.72], clump);
        this.tri(mid[j], mid[i], apex, 2, pv, [0.72, 0.72, 0.9], clump);
      } else {
        this.tri(outer[j], outer[i], apex, 2, pv, [1, 1, 0.9], clump);
      }
    }
  }

  /**
   * Willow fronds: a closed skirt hanging from the crown, its hem ragged
   * (alternate strands longer), faces turned outward. Centred on the dome
   * (cx, cz) and starting inside it (r0), so the strands grow out from under
   * the crown and flare to r1 at the hem, with no gap between them.
   */
  curtain(r0, r1, yTop, yBot, sides, phase, cx = 0, cz = 0) {
    const clump = this.clumps++;
    const top = [], bot = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + phase;
      const len = (i % 2 ? 0.55 : 1) * (0.8 + 0.35 * hashId(i + clump * 17, this.salt + 9));
      top.push([cx + Math.cos(a) * r0, yTop - (i % 2 ? 0.12 : 0), cz + Math.sin(a) * r0]);
      const rb = r1 * (0.95 + 0.1 * hashId(i + clump * 23, this.salt + 13));
      bot.push([cx + Math.cos(a) * rb, yTop - (yTop - yBot) * len, cz + Math.sin(a) * rb]);
    }
    const out = (p, q, r) => {
      // Keep the winding outward from the trunk axis.
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
      const mx = (p[0] + q[0] + r[0]) / 3 - cx, mz = (p[2] + q[2] + r[2]) / 3 - cz;
      return nx * mx + nz * mz >= 0 ? [p, q, r] : [p, r, q];
    };
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const pv = [cx, yTop, cz];
      // Fronds are thin and let light through: lift the crown occlusion
      // toward the hem so the skirt does not read as a dark shade.
      const lit = (p) => 1 + 0.5 * (1 - (p[1] - yBot) / Math.max(0.1, yTop - yBot));
      const [a1, b1, c1] = out(top[i], top[j], bot[j]);
      this.tri(a1, b1, c1, 1, pv, [lit(a1), lit(b1), lit(c1)], clump);
      const [a2, b2, c2] = out(top[i], bot[j], bot[i]);
      this.tri(a2, b2, c2, 1, pv, [lit(a2), lit(b2), lit(c2)], clump);
    }
  }

  build() {
    // Crown volume from the foliage vertices: soft normals and occlusion are
    // taken against it, so near and far levels shade alike.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const v of this.v) {
      if (v.part === 0) continue;
      x0 = Math.min(x0, v.p[0]); x1 = Math.max(x1, v.p[0]);
      y0 = Math.min(y0, v.p[1]); y1 = Math.max(y1, v.p[1]);
      z0 = Math.min(z0, v.p[2]); z1 = Math.max(z1, v.p[2]);
    }
    return finishGeometry(this, { cx: 0, cy: (y0 + y1) / 2, cz: 0, rx: Math.max(x1, -x0, z1, -z0), y0, y1 });
  }
}

const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

function finishGeometry(b, crown) {
  const n = b.v.length;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const part = new Float32Array(n), pivot = new Float32Array(n * 3), shade = new Float32Array(n);
  const sm = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  b.v.forEach((v, i) => {
    const [x, y, z] = v.p;
    pos.set(v.p, i * 3);
    pivot.set(v.pivot, i * 3);
    part[i] = v.part;
    let nn;
    let ao;
    const hf = (y - crown.y0) / Math.max(0.01, crown.y1 - crown.y0);
    const rad = Math.hypot(x - crown.cx, z - crown.cz) / Math.max(0.01, crown.rx);
    if (v.part === 0) {
      // Bark: rounded around the limb's own axis, darker low and under the crown.
      const r = norm(x - v.pivot[0], 0, z - v.pivot[2]);
      nn = norm(v.f[0] * 0.45 + r[0] * 0.55, v.f[1] * 0.45, v.f[2] * 0.45 + r[2] * 0.55);
      ao = 0.62 + 0.3 * sm((y + 0.3) / 1.2) - 0.18 * sm((y - crown.y0 + 0.6) / 1.2);
    } else if (v.part === 2) {
      // Fir: radial from the trunk axis with the cone's lift, plus the facet.
      const r = norm(x, 0, z);
      const soft = norm(r[0], 0.55, r[2]);
      nn = norm(v.f[0] * 0.4 + soft[0] * 0.6, v.f[1] * 0.4 + soft[1] * 0.6, v.f[2] * 0.4 + soft[2] * 0.6);
      ao = (0.6 + 0.4 * sm(hf * 1.1)) * v.ring;
    } else {
      // Broadleaf: a blend of the clump's own roundness and the whole crown's,
      // keeping a trace of the facet so it still reads as cut paper.
      const c = norm(x - v.pivot[0], y - v.pivot[1], z - v.pivot[2]);
      const w = norm(x - crown.cx, (y - crown.cy) * 1.15, z - crown.cz);
      nn = norm(v.f[0] * 0.3 + c[0] * 0.3 + w[0] * 0.4, v.f[1] * 0.3 + c[1] * 0.3 + w[1] * 0.4, v.f[2] * 0.3 + c[2] * 0.3 + w[2] * 0.4);
      // Occlusion: darker low in the crown and toward its heart.
      ao = (0.58 + 0.42 * sm(hf * 1.05 + 0.05)) * (0.78 + 0.22 * sm(rad * 1.4)) * v.ring;
    }
    nor.set(nn, i * 3);
    const tone = v.part === 0 ? 1 : 0.92 + 0.16 * hashId(v.clump + 1, b.salt + 77);
    shade[i] = ao * tone * v.faceShade;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  g.setAttribute('aPivot', new THREE.BufferAttribute(pivot, 3));
  g.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
  g.computeBoundingSphere();
  return g;
}

export function buildGeometry(kind, lod = LOD.NEAR) {
  const b = new TreeBuilder(kind + 3 + lod * 11);
  const near = lod === LOD.NEAR;
  if (kind === KIND.ROUND) {
    // Broadleaf (oak, beech, lime): a short trunk forking into two limbs under
    // a broad, lumpy dome of clumps.
    if (near) {
      b.limb(0.23, 0.15, [0, -0.3, 0], [0.04, 2.1, 0.02], 6);
      b.limb(0.12, 0.05, [0.04, 1.8, 0.02], [0.9, 3.0, 0.35], 4);
      b.limb(0.11, 0.05, [0.02, 1.9, 0], [-0.75, 3.05, -0.45], 4);
      b.blob(0, 4.05, 0, 1.3, 0.92);
      b.blob(0.98, 3.35, 0.38, 1.02, 0.88);
      b.blob(-0.9, 3.45, -0.42, 1.06, 0.9);
      b.blob(0.22, 3.25, -1.02, 0.98, 0.86);
      b.blob(-0.32, 3.15, 0.98, 0.94, 0.86);
      b.blob(0.45, 4.6, 0.42, 0.78, 0.9);
    } else {
      b.limb(0.22, 0.14, [0, -0.3, 0], [0, 2.6, 0], 3);
      b.blob(0.05, 3.62, 0, 1.92, 0.84, 1, 0.12);
    }
  } else if (kind === KIND.TALL) {
    // Columnar (poplar) or airy (birch, by seed in the shader): a slim stem
    // under stacked, narrowing clumps.
    if (near) {
      b.limb(0.17, 0.08, [0, -0.3, 0], [0, 4.4, 0], 5);
      b.blob(0.05, 2.65, 0.05, 0.92, 1.0);
      b.blob(0.3, 3.15, -0.3, 0.72, 1.05);
      b.blob(-0.1, 3.7, 0.12, 0.98, 1.2);
      b.blob(0.08, 4.75, -0.05, 0.84, 1.3);
      b.blob(0.0, 5.65, 0.0, 0.55, 1.4);
    } else {
      b.limb(0.17, 0.1, [0, -0.3, 0], [0, 2.6, 0], 3);
      b.blob(0, 4.0, 0, 1.08, 1.95, 1, 0.1);
    }
  } else if (kind === KIND.PINE) {
    // Fir and spruce: ragged tiers that droop at the tips.
    if (near) {
      b.limb(0.2, 0.08, [0, -0.3, 0], [0, 4.6, 0], 5);
      const tiers = 5;
      for (let i = 0; i < tiers; i++) {
        const r = 1.95 - i * 0.37;
        b.tier(r, 0.75 + i * 0.86, 1.55 - i * 0.12, 7, i * 0.45, 0.2 - i * 0.025);
      }
    } else {
      b.limb(0.2, 0.14, [0, -0.3, 0], [0, 1.2, 0], 3);
      b.tier(1.85, 0.8, 2.6, 6, 0, 0.1, false);
      b.tier(1.2, 2.45, 2.4, 6, 0.5, 0.08, false);
    }
  } else if (kind === KIND.BUSH) {
    if (near) {
      b.blob(0, 0.62, 0, 0.88, 0.72, 1, 0.24);
      b.blob(0.6, 0.45, 0.25, 0.62, 0.7, 1, 0.24);
      b.blob(-0.45, 0.48, -0.35, 0.66, 0.7, 1, 0.24);
    } else {
      b.blob(0, 0.6, 0, 1.0, 0.72, 1, 0.2);
    }
  } else {
    // Willow: a leaning, forked trunk; a low dome; fronds that sweep the water.
    if (near) {
      b.limb(0.26, 0.17, [0, -0.3, 0], [0.35, 2.0, 0.1], 6);
      b.limb(0.15, 0.07, [0.33, 1.9, 0.1], [1.0, 3.3, 0.5], 4);
      b.limb(0.14, 0.07, [0.33, 1.9, 0.1], [-0.4, 3.4, -0.35], 4);
      b.blob(0.3, 3.75, 0.05, 1.45, 0.62, 1, 0.16);
      b.blob(1.1, 3.45, 0.55, 0.95, 0.6, 1, 0.16);
      b.blob(-0.5, 3.5, -0.5, 1.0, 0.6, 1, 0.16);
      b.curtain(1.05, 1.8, 3.55, 0.7, 18, 0.2, 0.3, 0.05);
    } else {
      b.limb(0.24, 0.16, [0, -0.3, 0], [0.3, 2.4, 0.1], 3);
      b.blob(0.3, 3.7, 0.05, 1.85, 0.6, 1, 0.12);
      b.curtain(1.35, 1.85, 3.5, 0.9, 10, 0.2, 0.3, 0.05);
    }
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
uniform vec3 uLodEye;
uniform float uLodDist;
`;

// Object space: the LOD split (each tree is drawn by exactly one level: the
// test is the same expression on the same instance data), winter bareness
// shrinking deciduous clumps toward their centres, leaf flutter, and the chop
// (tilt ~12 degrees about the base, shrink, collapse to a point).
const VERTEX_BEGIN = /* glsl */ `
  float seedT = iTree.x;
  float lodD = distance(instanceMatrix[3].xyz, uLodEye);
  #if TREE_LOD == 1
    float lodKeep = 1.0 - step(uLodDist, lodD);
  #elif TREE_LOD == 0
    float lodKeep = step(uLodDist, lodD);
  #else
    float lodKeep = 1.0;
  #endif
  float bareK = 0.0;
  #if TREE_KIND != 2
    // Bare branches arrive tree by tree (seed staggers the turn).
    bareK = clamp(uBare * 1.35 - seedT * 0.35, 0.0, 1.0);
    #if TREE_KIND == 3
      bareK *= 0.55;
    #endif
    if (aPart > 0.5 && aPart < 1.5) {
      transformed = aPivot + (transformed - aPivot) * mix(vec3(1.0), vec3(0.55, 0.6, 0.55), bareK);
    }
  #endif
  // Leaf flutter: a small breathing of the foliage along its normal.
  float windK = 0.3 + 0.7 * min(1.0, length(uWind));
  if (aPart > 0.5) {
    float fl = sin(uDecoTime * 3.3 + position.x * 2.1 + position.y * 1.7 + position.z * 1.3 + seedT * 40.0);
    transformed += normal * fl * 0.035 * windK * (1.0 - bareK * 0.7);
  }
  #if TREE_KIND == 4
    // Willow fronds swing below the crown.
    float hang = max(0.0, 3.6 - position.y) * step(0.5, aPart);
    transformed.xz += normalize(uWind + 1e-4) * hang * 0.07 * windK * sin(uDecoTime * 1.6 + seedT * 9.0 + position.x);
  #endif
  float chopK = iTree.z != 0.0 ? clamp((uTime - iTree.z) / 0.6, 0.0, 1.0) : 0.0;
  float tilt = 0.21 * smoothstep(0.0, 0.55, chopK);
  transformed.yz = mat2(cos(tilt), sin(tilt), -sin(tilt), cos(tilt)) * transformed.yz;
  transformed.y *= 1.0 - smoothstep(0.35, 1.0, chopK);
  // Denser-woods trees (flag 2) stay out of the shadow map: decals.js draws
  // their shadows as cast blobs on the ground, far cheaper with thousands.
  #ifdef TREE_DEPTH
    lodKeep *= 1.0 - step(0.5, mod(floor(iTree.w * 0.5 + 0.01), 2.0));
  #endif
  transformed *= step(chopK, 0.999) * lodKeep;
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

const VARYINGS = /* glsl */ `
varying vec3 vTreeCol;
varying vec3 vTreeW;
varying vec3 vTreeN;
varying float vTreeBare;
varying float vTreeLeaf;
varying float vTreeBirch;
varying float vTreeY;
`;

// Species palettes (linear). Summer greens by seed, an autumn turn staggered
// per tree, bare winter wood, spring freshness and blossom on fruit trees.
const VERTEX_COLOR = /* glsl */ `
  #ifdef USE_SHADOWMAP
    // Shadow lookups at the draped, swaying position the tree is drawn at.
    worldPosition = treeWorld;
  #endif
  float s2 = fract(seedT * 7.13);
  float s3 = fract(seedT * 3.71);
  vec3 trunkCol = vec3(0.15, 0.095, 0.055) * (0.85 + 0.3 * s3);
  float birch = 0.0;
  vec3 leaf;
  vec3 autumnCol;
  #if TREE_KIND == 2
    // Scots pine / fir greens, and a few blue-grey spruces.
    leaf = mix(vec3(0.052, 0.140, 0.060), vec3(0.040, 0.112, 0.052), s2);
    leaf = mix(leaf, vec3(0.050, 0.118, 0.095), step(0.8, s3));
    trunkCol = vec3(0.17, 0.085, 0.05) * (0.85 + 0.3 * s3);
    autumnCol = leaf;
  #elif TREE_KIND == 1
    // Birch (pale bark, airy yellow-green) or poplar (dark, glossy).
    birch = step(s3, 0.38);
    leaf = mix(vec3(0.075, 0.190, 0.062), vec3(0.150, 0.270, 0.065), birch);
    trunkCol = mix(trunkCol, vec3(0.62, 0.60, 0.55), birch);
    autumnCol = mix(vec3(0.62, 0.46, 0.06), vec3(0.72, 0.52, 0.07), s2);
  #elif TREE_KIND == 4
    // Willow: silvery yellow-green, yellow in autumn.
    leaf = mix(vec3(0.150, 0.250, 0.075), vec3(0.135, 0.230, 0.090), s2);
    trunkCol = vec3(0.13, 0.10, 0.07) * (0.85 + 0.3 * s3);
    autumnCol = vec3(0.55, 0.45, 0.08);
  #elif TREE_KIND == 3
    leaf = s2 < 0.5 ? vec3(0.090, 0.210, 0.060) : vec3(0.110, 0.200, 0.075);
    autumnCol = s3 < 0.5 ? vec3(0.45, 0.16, 0.04) : vec3(0.40, 0.26, 0.05);
  #else
    // Oak, beech, lime, and the odd copper beech.
    leaf = s2 < 0.33 ? vec3(0.100, 0.235, 0.062) : s2 < 0.66 ? vec3(0.135, 0.255, 0.066) : vec3(0.080, 0.205, 0.080);
    leaf = mix(leaf, vec3(0.20, 0.07, 0.06), step(0.965, s3));
    autumnCol = s3 < 0.25 ? vec3(0.571, 0.279, 0.044) : s3 < 0.5 ? vec3(0.479, 0.122, 0.027)
              : s3 < 0.75 ? vec3(0.693, 0.445, 0.069) : vec3(0.323, 0.195, 0.026);
  #endif
  #if TREE_KIND != 2
    float fresh = smoothstep(0.07, 0.14, uYearT) * (1.0 - smoothstep(0.22, 0.34, uYearT));
    leaf = mix(leaf, leaf * vec3(1.35, 1.3, 0.8), fresh * 0.6);
    float turn = clamp(uAutumn * 1.6 - seedT * 0.6, 0.0, 1.0);
    #if TREE_KIND == 3
      turn *= 0.5;
    #endif
    leaf = mix(leaf, autumnCol, turn);
    // Bare crowns read as a haze of grey-brown twigs, not a solid ball.
    leaf = mix(leaf, vec3(0.27, 0.22, 0.18), bareK);
    float blossomOn = mod(iTree.w, 2.0) >= 1.0 || seedT < 0.12 ? 1.0 : 0.0;
    #if TREE_KIND != 0
      blossomOn = 0.0; // only fruit trees and a few wild cherries blossom
    #endif
    leaf = mix(leaf, vec3(0.90, 0.56, 0.64), uBlossom * blossomOn * 0.85);
  #endif
  vTreeLeaf = aPart > 0.5 ? 1.0 : 0.0;
  vTreeCol = (aPart < 0.5 ? trunkCol : leaf) * aShade;
  vTreeW = treeWorld.xyz;
  vTreeN = normalize(mat3(instanceMatrix) * objectNormal);
  vTreeBare = aPart > 0.5 && aPart < 1.5 ? bareK : 0.0;
  vTreeBirch = birch * (1.0 - vTreeLeaf);
  vTreeY = position.y;
`;

const FRAGMENT_HEAD = VARYINGS + NOISE + /* glsl */ `
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
`;

const FRAGMENT_COLOR = /* glsl */ `
  vec3 col = vTreeCol;
  // Leafy break-up: soft light and dark dapples across each crown.
  float dapple = vnoise(vTreeW.xz * 1.6 + vTreeW.y * 1.9) * 0.6 + vnoise(vTreeW.xz * 4.1 - vTreeW.y * 3.3) * 0.4;
  col *= mix(1.0, 0.86 + 0.28 * dapple, vTreeLeaf);
  // Twiggy break-up on bare crowns: fine light and dark flecks.
  float twig = vnoise(vTreeW.xz * 6.5 + vTreeW.y * 7.0);
  col *= mix(1.0, 0.75 + 0.5 * twig, vTreeBare);
  // Birch bark: dark lenticels across the white stem.
  float marks = smoothstep(0.62, 0.7, vnoise(vec2(vTreeW.x * 3.0 + vTreeW.z * 3.0, vTreeY * 9.0)));
  col = mix(col, vec3(0.06, 0.05, 0.045), marks * vTreeBirch * 0.85);
  // Snow caps on up-facing faces (bare crowns hold a little less), plus a
  // light frosting on every face so winter woods read pale, not black.
  vec3 nW = normalize(vTreeN);
  float snowAmt = smoothstep(0.25, 0.8, uSnow);
  float snowK = snowAmt * smoothstep(0.05, 0.5, nW.y + (dapple - 0.5) * 0.3) * (1.0 - 0.25 * vTreeBare);
  #if TREE_KIND == 2
    snowK *= 0.7; // firs shed snow off their drooping tips: keep some green
  #endif
  col = mix(col, vec3(0.62, 0.64, 0.68), snowAmt * (0.22 + 0.15 * vTreeBare));
  col = mix(col, vec3(0.88, 0.9, 0.93), snowK);
  diffuseColor.rgb = col * uTint;
`;

// Light through leaves: crowns glow at their edges when the sun is behind
// them, and silhouettes pick up a breath of sky.
const FRAGMENT_EMISSIVE = /* glsl */ `
  {
    vec3 eyeDir = normalize(vTreeW - cameraPosition);
    vec3 nW2 = normalize(vTreeN);
    float edge = 1.0 - abs(dot(nW2, eyeDir));
    float back = pow(max(dot(eyeDir, uSunDir), 0.0), 3.0);
    float day = smoothstep(0.0, 0.15, uSunDir.y) * (1.0 - uNight);
    float leafy = vTreeLeaf * (1.0 - vTreeBare * 0.8) * (1.0 - smoothstep(0.25, 0.8, uSnow));
    totalEmissiveRadiance += diffuseColor.rgb * uSunColor * back * (0.25 + 0.75 * edge) * 0.55 * day * leafy;
    totalEmissiveRadiance += uSkyHorizon * pow(edge, 3.0) * 0.045 * vTreeLeaf * (1.0 - uNight * 0.8);
  }
`;

function makeMaterials(grade, kind, lod, lodUniforms) {
  const defines = { TREE_KIND: kind, TREE_LOD: lod };
  // Willow fronds are a thin skirt hanging past the dome: seen from above,
  // the eye looks over its near edge into the canopy, so they draw from both
  // sides (three flips the normal on back faces) instead of showing a hole.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, side: kind === KIND.WILLOW ? THREE.DoubleSide : THREE.FrontSide });
  patchMaterial(material, grade, {
    key: `tree:${kind}:${lod}`,
    defines,
    uniforms: lodUniforms,
    vertexHead: VERTEX_HEAD + VARYINGS,
    vertexBegin: VERTEX_BEGIN,
    vertexEnd: VERTEX_COLOR,
    fragmentHead: FRAGMENT_HEAD,
    fragmentColor: FRAGMENT_COLOR,
    fragmentEmissive: FRAGMENT_EMISSIVE,
  });
  const patched = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    patched(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', PROJECT);
  };

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms, lodUniforms);
    shader.defines = { ...(shader.defines ?? {}), ...defines, TREE_DEPTH: 1 };
    shader.vertexShader = GRADE_HEAD + VERTEX_HEAD + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERTEX_BEGIN)
      .replace('#include <project_vertex>', PROJECT);
  };
  depth.customProgramCacheKey = () => `treedepth:${kind}:${lod}`;
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
  const wildCount = new Array(KINDS).fill(0);
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
  // LOD split shared by both levels: the eye (main camera, also during the
  // shadow and reflection passes) and the near distance.
  const lodUniforms = { uLodEye: { value: new THREE.Vector3(0, 1e5, 0) }, uLodDist: { value: NEAR_DIST.high } };
  const instanced = (k, lod, capacity) => {
    const { material, depth } = makeMaterials(grade, k, lod, lodUniforms);
    const mesh = new THREE.InstancedMesh(buildGeometry(k, lod), material, Math.max(1, capacity));
    mesh.name = `trees:${KIND_NAMES[k]}${lod === LOD.NEAR ? ':near' : ''}`;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = depth;
    // The quarter-res river mirror draws the far level only (every tree, see
    // setReflectionPass), so the near level stays out of the reflection layer.
    if (lod !== LOD.NEAR) mesh.layers.enable(LAYER_REFLECT);
    const iTree = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 4), 4);
    iTree.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('iTree', iTree);
    group.add(mesh);
    return { mesh, iTree };
  };
  for (let k = 0; k < KINDS; k++) {
    const capacity = PARK_RESERVE[k] + wildCount[k];
    const bush = k === KIND.BUSH;
    const { mesh, iTree } = instanced(k, bush ? LOD.ALL : LOD.FAR, capacity);
    // Park reserve starts hidden.
    matrix.makeScale(0, 0, 0);
    for (let s = 0; s < PARK_RESERVE[k]; s++) mesh.setMatrixAt(s, matrix);
    const near = bush ? null : instanced(k, LOD.NEAR, capacity);
    if (near) {
      near.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      near.mesh.count = 0;
      near.mesh.visible = false;
    }
    meshes.push({ mesh, iTree, near, lo: Infinity, hi: -1, freePark: Array.from({ length: PARK_RESERVE[k] }, (_, i) => PARK_RESERVE[k] - 1 - i) });
  }

  for (let i = 0; i < forest.count; i++) {
    const m = meshes[forest.kind[i]];
    const s = slotOf[i];
    pos.set(forest.x[i], forest.y[i], forest.z[i]);
    quat.setFromAxisAngle(up, forest.yaw[i]);
    // Crowns vary in build as well as size: some broad, some lanky.
    const shape = 0.88 + 0.26 * forest.seed[i];
    scl.set(forest.scale[i] * (1.06 - (shape - 0.88) * 0.5), forest.scale[i] * shape, forest.scale[i] * (1.06 - (shape - 0.88) * 0.5));
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
  let lastRoadsCheck = -Infinity;
  let choppedThisFrame = 0;
  let nearDirty = true;
  const nearEye = new THREE.Vector3(0, 1e5, 0);
  const lotKeys = new Map(); // lot id -> footprint key already cleared
  const parks = new Map(); // lot id -> [{kind, slot}]

  function chop(i, time) {
    if (chopT[i] !== 0) return;
    chopT[i] = time;
    const m = meshes[forest.kind[i]];
    const s = slotOf[i];
    m.iTree.array[s * 4 + 2] = time;
    nearDirty = true;
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

  // Road cells under each tree's five reach samples (-1 outside the grid),
  // worked out once per road grid: a road change then only reads them.
  let reachCells = null, reachKey = '';
  function clearRoads(roads, time) {
    const { W, H, cell, ox, oz, tier, wear } = roads;
    if (!tier) return;
    const key = `${W},${H},${cell},${ox},${oz}`;
    if (key !== reachKey) {
      reachKey = key;
      reachCells = new Int32Array(forest.count * 5);
      for (let i = 0; i < forest.count; i++) {
        const reach = forest.kind[i] === KIND.BUSH ? 0.7 : 1.5 * forest.scale[i];
        for (let k = 0; k < 5; k++) {
          const x = forest.x[i] + (k === 1 ? reach : k === 2 ? -reach : 0);
          const z = forest.z[i] + (k === 3 ? reach : k === 4 ? -reach : 0);
          const cx = Math.floor((x - ox) / cell), cz = Math.floor((z - oz) / cell);
          reachCells[i * 5 + k] = cx < 0 || cz < 0 || cx >= W || cz >= H ? -1 : cz * W + cx;
        }
      }
    }
    for (let i = 0; i < forest.count; i++) {
      if (chopT[i] !== 0) continue;
      for (let k = i * 5, e = k + 5; k < e; k++) {
        const c = reachCells[k];
        if (c >= 0 && (tier[c] >= 2 || (wear && wear[c] >= 300))) { chop(i, time); break; }
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
    nearDirty = true;
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
    nearDirty = true;
  }

  /**
   * Refill the near meshes with every standing slot within reach of the eye
   * (a copy of the far mesh's rows, so chops and parks carry over).
   */
  function rebuildNear(eye) {
    nearEye.copy(eye);
    nearDirty = false;
    const r = lodUniforms.uLodDist.value + NEAR_SLACK;
    const r2 = r * r;
    for (const m of meshes) {
      const near = m.near;
      if (!near) continue;
      const src = m.mesh.instanceMatrix.array, srcT = m.iTree.array;
      const dst = near.mesh.instanceMatrix.array, dstT = near.iTree.array;
      let n = 0;
      for (let s = 0, count = m.mesh.count; s < count; s++) {
        const o = s * 16;
        if (src[o] === 0 && src[o + 2] === 0) continue; // hidden park slot
        const dx = src[o + 12] - eye.x, dy = src[o + 13] - eye.y, dz = src[o + 14] - eye.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        for (let k = 0; k < 16; k++) dst[n * 16 + k] = src[o + k];
        for (let k = 0; k < 4; k++) dstT[n * 4 + k] = srcT[s * 4 + k];
        n++;
      }
      near.mesh.count = n;
      near.mesh.visible = n > 0;
      if (!n) continue;
      const im = near.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      near.iTree.clearUpdateRanges();
      near.iTree.addUpdateRange(0, n * 4);
      near.iTree.needsUpdate = true;
    }
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
    // Roads change most frames in a busy town: check them a few times a
    // second (a tree a road claims falls a moment later, unseen).
    if (roads && (roads !== lastRoadsRef || roads.version !== lastRoadsVersion) && (!primed || frame.time - lastRoadsCheck >= 0.3)) {
      lastRoadsCheck = frame.time;
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
    // Level of detail follows the eye.
    const eye = frame?.camera?.position;
    if (eye) {
      lodUniforms.uLodEye.value.copy(eye);
      if (nearDirty || eye.distanceToSquared(nearEye) > NEAR_MOVE * NEAR_MOVE) rebuildNear(eye);
    }
    if (primed && choppedThisFrame) lights.animateFor(0.8, frame.time);
    else if (!primed) lights.markDirty();
    primed = true;
  }

  function applyQuality(q) {
    const rank = TIER_RANK[q.name] ?? 1;
    // decals.js keeps the same global prefix (round(count * keep)).
    shared.keep = forest.tierCount[rank] / Math.max(1, forest.count);
    for (let k = 0; k < KINDS; k++) {
      meshes[k].mesh.count = PARK_RESERVE[k] + forest.tierKind[rank][k];
    }
    lodUniforms.uLodDist.value = NEAR_DIST[q.name] ?? NEAR_DIST.medium;
    nearDirty = true;
    // Low tier: the shadow pass skips bushes.
    meshes[KIND.BUSH].mesh.castShadow = q.name !== 'low';
  }
  applyQuality(ctx.quality);

  return {
    group,
    update,
    applyQuality,
    count: () => forest.count,
    /** Submitted triangles (both levels; the far level collapses near trees). */
    triangles: () => meshes.reduce((n, m) => n + (m.mesh.geometry.attributes.position.count / 3) * m.mesh.count
      + (m.near ? (m.near.mesh.geometry.attributes.position.count / 3) * m.near.mesh.count : 0), 0),
    /** Trees drawn at full detail right now. */
    nearCount: () => meshes.reduce((n, m) => n + (m.near?.mesh.count ?? 0), 0),
    /**
     * Around the river mirror render: the far level draws every tree (the
     * near level is not in the reflection layer), then the split returns.
     */
    setReflectionPass(on) {
      lodUniforms.uLodDist.value = on ? 0 : NEAR_DIST[ctx.quality?.name] ?? NEAR_DIST.medium;
    },
    dispose() {
      for (const m of meshes) {
        for (const mesh of m.near ? [m.mesh, m.near.mesh] : [m.mesh]) {
          mesh.geometry.dispose();
          mesh.material.dispose();
          mesh.customDepthMaterial.dispose();
        }
      }
      WOODLAND.tWood.value.dispose();
      scene.remove(group);
    },
  };
}
