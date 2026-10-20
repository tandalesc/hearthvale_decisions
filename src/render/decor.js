import * as THREE from 'three';
import * as Terrain from '../terrain.js';
import { hashId } from './shaderlib.js';
import { gradeLambert } from './props.js';
import { styleFor } from './kit/styles.js';
import { stageOf } from '../sim/landscape.js';
import { benchesOf, GATHER } from '../sim/seats.js';

// Lived-in decor (design-visual §7): the small things a town gathers as it
// matures, all instanced and placed from sim state, never from game rules.
//
// Landscaping is one process in the sim (landscape.js): every lot and every
// 8-unit block of verge, bank and public land carries a signed care level,
// and this layer only draws the stage that level has reached:
//   overgrown  weeds, long grass, broken and leaning fences, hedges gone wild
//   rough      nothing (untouched grass)
//   mown       a back fence on a lot; tidy verges
//   planted    fences or hedges all round, shrubs, flower borders, verge shrubs
//   formal     clipped hedges, topiary at the gate, planters and beds along
//              made streets, flower rings in parks (Borough era on)
//
// Besides the gardens:
//   Streets   verge planting or weeds by stage, fingerposts at junctions, bins on busy streets (overflowing
//             where residents complain of litter), wells (pumps later),
//             benches by chapels, inns and on embanked towpaths, shop signs,
//             stalls at markets.
//   Parks     a kept path, a low rail or fence with a gate, benches, a bin,
//             a notice board, wildflowers, lamps in later eras; beaches get a
//             sandy bank, boats pulled up, towels in summer and a bathing hut.
//
// Three draw calls: one box batch, one blob batch (foliage turns with the
// season) and one draped sand mesh. The box and blob batches also cast into
// the sun's shadow map (two draws in the shadow pass). Decor stands still, so
// the map is only asked to redraw when the layout changes (or the decor is
// hidden or shown), not every frame. Only what lies within reach of the view
// target is laid out (radius by quality tier); it is redone when the target
// moves on or the town changes, at most every 0.75 s, and hidden when the
// camera is far out.

const { riverX, bankDistance } = Terrain;
const waterHalf = () => Terrain.WATER_HALF;

const MAX_BOXES = 20000;
const MAX_BLOBS = 8000;
const REACH = { low: 70, medium: 100, high: 150 };
const HIDE_BEYOND = 210;   // camera distance: further out the pieces are under a pixel
const REBUILD_GAP = 0.75;  // seconds

const col = (h) => new THREE.Color(h);
const K = {
  wood: col('#8c6a44'), woodDark: col('#6b5236'), woodGrey: col('#8a8478'), wattle: col('#9b8160'),
  stone: col('#b9ad95'), stoneDark: col('#8f8470'), brick: col('#9a5a44'), iron: col('#2f3634'),
  hedge: col('#4f7a40'), hedgeDark: col('#3d6234'), shrub: col('#5f8c4a'), shrubLight: col('#79a055'),
  weeds: col('#8a9a4a'), weedsDry: col('#a69a5a'), gravel: col('#b3a487'), board: col('#e8dcc0'),
  bin: col('#5d6a58'), binLid: col('#46503f'), litter: col('#e8e2d0'), litterDark: col('#9c8c6a'),
  sand: col('#e3cf9f'), hut: col('#e9e1cd'), hutRoof: col('#b2563f'), lampGlass: col('#f2d9a0'),
  thatch: col('#b89a5a'),
};
const FLOWERS = ['#d9574a', '#e8c04a', '#c97ab8', '#f1ead8', '#7a8fd0', '#e88a5a'].map(col);
const AWNINGS = ['#b2563f', '#526d42', '#3f6f8a', '#c9a24a', '#7a4f6d', '#a8553f'].map(col);
const TOWELS = ['#c94a3a', '#3f6f8a', '#e8c04a', '#efe6cf', '#526d42'].map(col);
const PRODUCE = ['#a63d2a', '#6f8f3a', '#d39a3a', '#c9a86a', '#8a3a4f'].map(col);
const LAUNDRY = ['#efe9dc', '#e4e8ec', '#b9c9d6', '#c97a6a', '#d9cfa8', '#8fa6b8', '#efe9dc'].map(col);
const Y = {
  logEnd: col('#b58d5e'), logEndDark: col('#9c7649'), log: col('#5f4630'), soil: col('#5a4632'),
  veg: col('#5d8a3e'), vegLight: col('#86a852'), vegDark: col('#476f34'), pumpkin: col('#d0782e'),
  hay: col('#d6b45c'), hayDark: col('#b8963e'), barrel: col('#7a5634'), hoop: col('#3a3a36'),
  crate: col('#a8865a'), line: col('#d8d2c2'),
};
// Lots whose yard gets barrels and crates by the door.
const STOCKED = new Set(['inn', 'shop', 'workshop', 'warehouse', 'quay', 'mill', 'brewery', 'factory']);

const NO_GARDEN = new Set(['farm', 'park', 'bridge', 'monument', 'quay', 'quarry', 'mill', 'factory', 'warehouse']);
const SIGNED = new Set(['shop', 'inn', 'workshop']);

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

export function createDecor(ctx) {
  const { scene, grade, heightAt, buildings, lights } = ctx;
  const group = new THREE.Group();
  group.name = 'decor';
  scene.add(group);

  // --- Meshes --------------------------------------------------------------
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  boxGeo.computeVertexNormals();
  const boxMat = gradeLambert(grade, 'decor-box');
  // Small pieces cast from their front faces: three's default (back faces for
  // a front-sided material) leaves a lit gap between a bin or bench and the
  // start of its shadow, which reads as a hole at its foot.
  boxMat.shadowSide = THREE.FrontSide;
  const boxes = new THREE.InstancedMesh(boxGeo, boxMat, MAX_BOXES);
  boxes.count = 0;
  boxes.frustumCulled = false;
  boxes.receiveShadow = true;
  boxes.castShadow = true;
  boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boxes.setColorAt(0, K.wood);
  group.add(boxes);

  const blobGeo = new THREE.IcosahedronGeometry(1, 0);
  blobGeo.computeVertexNormals();
  const leafAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BLOBS), 1);
  leafAttr.setUsage(THREE.DynamicDrawUsage);
  blobGeo.setAttribute('aLeaf', leafAttr);
  const blobMat = gradeLambert(grade, 'decor-blob', {
    vertexHead: 'attribute float aLeaf;\nvarying float vLeaf;\n',
    vertexEnd: 'vLeaf = aLeaf;\n',
    fragmentHead: 'varying float vLeaf;\n',
    fragmentColor: /* glsl */ `
      // Hedges and shrubs turn with the season (flowers wilt a little).
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.38, 0.16), uAutumn * 0.55 * vLeaf);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.30, 0.22), uBare * 0.45 * vLeaf);
    `,
  });
  blobMat.shadowSide = THREE.FrontSide;
  const blobs = new THREE.InstancedMesh(blobGeo, blobMat, MAX_BLOBS);
  blobs.count = 0;
  blobs.frustumCulled = false;
  blobs.receiveShadow = true;
  blobs.castShadow = true;
  blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  blobs.setColorAt(0, K.shrub);
  group.add(blobs);

  // Sand: one draped mesh for every beach in reach.
  const sandMat = gradeLambert(grade, 'decor-sand', { vertexColors: true });
  sandMat.transparent = true;
  sandMat.depthWrite = false;
  sandMat.polygonOffset = true;
  sandMat.polygonOffsetFactor = -2;
  sandMat.polygonOffsetUnits = -4;
  sandMat.vertexColors = true;
  const sand = new THREE.Mesh(new THREE.BufferGeometry(), sandMat);
  sand.frustumCulled = false;
  sand.receiveShadow = true;
  sand.renderOrder = 1;
  sand.visible = false;
  group.add(sand);

  // --- Instance writers ----------------------------------------------------
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const Q2 = new THREE.Quaternion();
  const P = new THREE.Vector3();
  const S = new THREE.Vector3();
  const D = new THREE.Vector3();
  let nBox = 0, nBlob = 0;

  function box(x, y, z, sx, sy, sz, color, yaw = 0, tilt = 0) {
    if (nBox >= MAX_BOXES) return;
    Q.setFromAxisAngle(Y_AXIS, yaw);
    if (tilt) Q.multiply(Q2.setFromAxisAngle(X_AXIS, tilt));
    M.compose(P.set(x, y, z), Q, S.set(sx, sy, sz));
    boxes.setMatrixAt(nBox, M);
    boxes.setColorAt(nBox, color);
    nBox++;
  }

  /** A box from a to b (centre line at the given heights), t wide and h tall. */
  function beam(ax, ay, az, bx, by, bz, t, h, color) {
    if (nBox >= MAX_BOXES) return;
    D.set(bx - ax, by - ay, bz - az);
    const len = D.length();
    if (len < 0.05) return;
    Q.setFromUnitVectors(X_AXIS, D.multiplyScalar(1 / len));
    M.compose(P.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), Q, S.set(len, h, t));
    boxes.setMatrixAt(nBox, M);
    boxes.setColorAt(nBox, color);
    nBox++;
  }

  function blob(x, y, z, rx, ry, rz, color, leaf = 1, yaw = 0) {
    if (nBlob >= MAX_BLOBS) return;
    Q.setFromAxisAngle(Y_AXIS, yaw);
    M.compose(P.set(x, y, z), Q, S.set(rx, ry, rz));
    blobs.setMatrixAt(nBlob, M);
    blobs.setColorAt(nBlob, color);
    leafAttr.array[nBlob] = leaf;
    nBlob++;
  }

  // --- Small pieces --------------------------------------------------------
  // Anything on legs stands on the highest ground under its feet, and each
  // leg (post, counter, wall) reaches down to the ground under it: nothing
  // hovers on a slope.
  /** A post or leg from the ground under (x, z) up to world height top. */
  function leg(x, z, top, sx, sz, color, yaw = 0) {
    const foot = Math.min(top, heightAt(x, z)) - 0.05;
    box(x, (foot + top) / 2, z, sx, top - foot, sz, color, yaw);
  }
  /** Highest ground under local points [lx, lz] of a piece at (x, z, yaw). */
  function topGround(x, z, yaw, pts) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let y = heightAt(x, z);
    for (const [lx, lz] of pts) y = Math.max(y, heightAt(x + lx * c + lz * s, z - lx * s + lz * c));
    return y;
  }

  function bench(x, z, yaw) {
    const y = topGround(x, z, yaw, [[-0.6, 0], [0.6, 0]]);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    let [px, pz] = at(0, 0);
    box(px, y + 0.45, pz, 1.4, 0.07, 0.42, K.wood, yaw);
    [px, pz] = at(0, -0.2);
    box(px, y + 0.7, pz, 1.4, 0.36, 0.06, K.wood, yaw);
    for (const lx of [-0.6, 0.6]) {
      [px, pz] = at(lx, -0.02);
      leg(px, pz, y + 0.44, 0.07, 0.4, K.iron, yaw);
    }
  }

  function bin(x, z, overflowing, seed) {
    const y = topGround(x, z, 0, [[-0.25, -0.25], [0.25, 0.25], [0.25, -0.25], [-0.25, 0.25]]);
    leg(x, z, y + 0.8, 0.5, 0.5, K.bin, seed * 6);
    box(x, y + 0.83, z, 0.56, 0.06, 0.56, K.binLid, seed * 6);
    if (!overflowing) return;
    // Rubbish heaped on the lid and spilt around it.
    blob(x, y + 0.95, z, 0.32, 0.18, 0.3, K.litter, 0);
    for (let i = 0; i < 5; i++) {
      const a = hashId(Math.round(seed * 1e6) + i, 31) * Math.PI * 2, r = 0.5 + hashId(Math.round(seed * 1e6) + i, 32) * 0.9;
      const lx = x + Math.cos(a) * r, lz = z + Math.sin(a) * r;
      box(lx, heightAt(lx, lz) + 0.05, lz, 0.22, 0.08, 0.16, i % 2 ? K.litter : K.litterDark, a);
    }
  }

  function fingerpost(x, z, yaw) {
    const y = heightAt(x, z);
    box(x, y + 1.1, z, 0.1, 2.2, 0.1, K.woodDark);
    box(x + Math.cos(yaw) * 0.35, y + 1.95, z - Math.sin(yaw) * 0.35, 0.75, 0.16, 0.04, K.board, yaw);
    const y2 = yaw + Math.PI / 2;
    box(x + Math.cos(y2) * 0.3, y + 1.7, z - Math.sin(y2) * 0.3, 0.65, 0.14, 0.04, K.board, y2);
  }

  function noticeBoard(x, z, yaw) {
    const y = topGround(x, z, yaw, [[-0.45, 0], [0.45, 0]]);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const lx of [-0.45, 0.45]) leg(x + lx * c, z - lx * s, y + 1.4, 0.08, 0.08, K.woodDark, yaw);
    box(x, y + 1.15, z, 1.0, 0.6, 0.05, K.board, yaw);
    box(x, y + 1.5, z, 1.15, 0.06, 0.25, K.woodDark, yaw);
  }

  function well(x, z, era) {
    const y = topGround(x, z, 0, [[-0.7, 0], [0.7, 0], [0, -0.7], [0, 0.7], [0.5, 0.45], [0.5, -0.45]]);
    if (era >= 3) {
      // A cast-iron pump with a trough.
      leg(x, z, y + 1.2, 0.22, 0.22, K.iron);
      box(x + 0.25, y + 1.0, z, 0.4, 0.08, 0.08, K.iron);
      leg(x + 0.5, z, y + 0.37, 0.5, 0.9, K.stoneDark);
      return;
    }
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      leg(x + Math.cos(a) * 0.55, z - Math.sin(a) * 0.55, y + 0.8, 0.3, 1.3, K.stone, a);
    }
    for (const sx of [-0.7, 0.7]) leg(x + sx, z, y + 2.0, 0.1, 0.1, K.woodDark);
    box(x, y + 2.0, z, 1.6, 0.1, 0.1, K.woodDark);
    if (era >= 1) {
      box(x, y + 2.25, z - 0.3, 1.8, 0.06, 0.8, K.thatch, 0, 0.5);
      box(x, y + 2.25, z + 0.3, 1.8, 0.06, 0.8, K.thatch, 0, -0.5);
    }
  }

  function stall(x, z, yaw, seed) {
    const corners = [[-0.95, -0.45], [0.95, -0.45], [-0.95, 0.6], [0.95, 0.6]];
    const y = topGround(x, z, yaw, corners);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    let [px, pz] = at(0, 0.1);
    // The counter is a skirt down to the lowest ground under it.
    const low = Math.min(...corners.map(([lx, lz]) => heightAt(...at(lx, lz)))) - 0.05;
    box(px, (low + y + 0.9) / 2, pz, 1.9, y + 0.9 - low, 0.8, K.wood, yaw);
    for (const [lx, lz] of corners) {
      [px, pz] = at(lx, lz);
      leg(px, pz, y + 2.2, 0.08, 0.08, K.woodDark, yaw);
    }
    [px, pz] = at(0, 0.15);
    box(px, y + 2.1, pz, 2.1, 0.06, 1.6, AWNINGS[Math.floor(seed * AWNINGS.length) % AWNINGS.length], yaw, -0.25);
    for (let i = 0; i < 4; i++) {
      [px, pz] = at(-0.6 + i * 0.4, 0.15);
      box(px, y + 0.98, pz, 0.3, 0.16, 0.4, PRODUCE[(i + Math.floor(seed * 5)) % PRODUCE.length], yaw);
    }
  }

  function lamp(x, z) {
    const y = heightAt(x, z);
    box(x, y + 1.4, z, 0.1, 2.8, 0.1, K.iron);
    box(x, y + 2.85, z, 0.3, 0.32, 0.3, K.lampGlass);
    box(x, y + 3.05, z, 0.38, 0.06, 0.38, K.iron);
  }

  // The verge / public land level under a point (view.landscape, -1..1).
  function landAt(view, x, z) {
    const L = view.landscape;
    if (!L?.level) return 0;
    const i = Math.floor((x - L.ox) / L.cell), j = Math.floor((z - L.ox) / L.cell);
    if (i < 0 || j < 0 || i >= L.W || j >= L.H) return 0;
    // Held steady while it hovers (stickyLevel): banks, verges and parks all
    // read their thresholds from it.
    return stickyLevel(j * L.W + i, L.level[j * L.W + i] / 100);
  }

  function clippedShrub(x, z, r, seed) {
    const y = topGround(x, z, 0, [[-0.4, -0.4], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4]]);
    box(x, y - 0.1, z, 0.8, 1.08, 0.8, K.stone, seed);
    blob(x, y + 0.44 + r * 0.8, z, r, r * 0.9, r, K.hedge, 1, seed);
  }

  // --- Gardens -------------------------------------------------------------
  /** Fence, wall, railing or hedge along a lot-local segment. */
  function boundary(frame, x0, z0, x1, z1, kind, b, seed) {
    const { wx, wz } = frame;
    const wild = b.wild ?? 0;
    const ax = wx(x0, z0), az = wz(x0, z0), bx = wx(x1, z1), bz = wz(x1, z1);
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / (kind === 'hedge' ? 1.6 : 1.3)));
    for (let i = 0; i < n; i++) {
      const s = hashId(seed * 977 + i, 41);
      // Neglect: segments fall away and posts lean.
      if (wild > 0.25 && s < wild * 0.55) continue;
      const t0 = i / n, t1 = (i + 1) / n;
      const px = ax + (bx - ax) * t0, pz = az + (bz - az) * t0;
      const qx = ax + (bx - ax) * t1, qz = az + (bz - az) * t1;
      const hp = heightAt(px, pz), hq = heightAt(qx, qz);
      const lean = wild > 0.25 ? (hashId(seed * 977 + i, 42) - 0.5) * wild * 0.9 : 0;
      if (kind === 'clipped') {
        // A formal hedge: squared off, kept low.
        beam(px, hp + 0.4, pz, qx, hq + 0.4, qz, 0.55, 0.8, K.hedge);
      } else if (kind === 'hedge') {
        const mx = (px + qx) / 2, mz = (pz + qz) / 2;
        const grow = 1 + wild * 0.9 * (0.6 + 0.4 * s);
        const yaw = Math.atan2(-(qz - pz), qx - px);
        blob(mx, (hp + hq) / 2 + 0.45 * grow, mz, (len / n) * 0.62 * (1 + wild * 0.3), 0.55 * grow, 0.42 * grow,
          wild > 0.4 ? K.hedgeDark : K.hedge, 1, yaw);
      } else if (kind === 'wall' || kind === 'brick') {
        beam(px, hp + 0.32, pz, qx, hq + 0.32, qz, 0.28, 0.64, kind === 'brick' ? K.brick : K.stone);
        if (wild > 0.3 && s < wild) blob(px, hp + 0.7, pz, 0.45, 0.35, 0.45, K.weeds, 1);
      } else {
        const post = wild > 0.35 ? K.woodGrey : kind === 'rail' ? K.iron : kind === 'wattle' ? K.wattle : K.wood;
        const h = kind === 'rail' ? 0.95 : kind === 'wattle' ? 0.7 : 0.85;
        const yaw = Math.atan2(-(qz - pz), qx - px);
        box(px, hp + h / 2, pz, 0.08, h, 0.08, post, yaw, lean);
        if (kind === 'wattle') {
          beam(px, hp + 0.35, pz, qx, hq + 0.35, qz, 0.07, 0.5, post);
        } else {
          beam(px, hp + h * 0.75, pz, qx, hq + h * 0.75, qz, 0.05, 0.06, post);
          if (kind !== 'rail' && !(wild > 0.5 && s > 0.6)) beam(px, hp + h * 0.35, pz, qx, hq + h * 0.35, qz, 0.05, 0.06, post);
          if (kind === 'rail') beam(px, hp + 0.12, pz, qx, hq + 0.12, qz, 0.2, 0.24, K.stoneDark);
        }
        if (i === n - 1) box(qx, hq + h / 2, qz, 0.08, h, 0.08, post, yaw, -lean);
      }
    }
  }

  function boundaryKind(b, era) {
    const w = b.wealth ?? 0.3;
    const id = b.id | 0;
    if (era <= 1) return w > 0.55 && hashId(id, 43) < 0.5 ? 'hedge' : hashId(id, 44) < 0.45 ? 'wattle' : 'picket';
    if (era <= 2) return w > 0.5 ? (hashId(id, 43) < 0.6 ? 'hedge' : 'wall') : hashId(id, 44) < 0.5 ? 'picket' : 'wall';
    return w > 0.5 ? (hashId(id, 43) < 0.5 ? 'hedge' : 'rail') : hashId(id, 44) < 0.5 ? 'brick' : 'rail';
  }

  // Hysteresis. Walkers wear the streets and residents tend their lots all the
  // time, so a care level or a cell's wear can hover at a threshold; laid out
  // again every few seconds, a flower bed or a bin would flicker on and off
  // as people pass. Each place keeps the stage (and each block its bin cell)
  // it last had until the value is clearly past the line.
  const STAGE_MARGIN = 0.05;
  const stageMem = new Map();
  function stickyStage(key, level, era) {
    const now = stageOf(level, era);
    const prev = stageMem.get(key);
    if (prev && prev !== now && (stageOf(level - STAGE_MARGIN, era) === prev || stageOf(level + STAGE_MARGIN, era) === prev)) return prev;
    stageMem.set(key, now);
    return now;
  }
  // A lot's care values feed many small rules (fence runs, shrub and weed
  // counts); snapped to steps that only move once the value is clearly past
  // the step, they all hold still while the value hovers.
  const levelMem = new Map();
  const STEP = 0.05;
  function stickyLevel(key, v) {
    // The band is measured from the value at the last change, not from its
    // snapped step, so a value hovering anywhere within it holds.
    const prev = levelMem.get(key);
    if (prev && Math.abs(v - prev.raw) < STEP * 0.75) return prev.q;
    const q = Math.round(v / STEP) * STEP;
    levelMem.set(key, { raw: v, q });
    return q;
  }
  const binMem = new Map();   // block -> chosen cell index
  const BIN_ON = 400, BIN_OFF = 300, BIN_SWITCH = 1.5;

  /** Fences, hedges, shrubs and flowers on one lot, by how well it is kept. */
  function garden(b, era) {
    // The lot's landscaping level (landscape.js): b.tend above zero, b.wild below.
    const tend = stickyLevel(`tend:${b.id}`, b.tend ?? Math.min(1, (b.age ?? 0) / 20) * (0.15 + 0.5 * (b.wealth ?? 0.3)) * (b.occupied ? 1 : 0));
    const wild = stickyLevel(`wild:${b.id}`, b.wild ?? (b.flags?.derelict ? 0.5 : 0));
    const stage = stickyStage(`lot:${b.id}`, tend - wild, era);
    if (stage === 'rough' && wild < 0.15) return;
    const rot = (((b.rot ?? 0) % 4) + 4) % 4;
    const angle = (rot * Math.PI) / 2, ca = Math.cos(angle), sa = Math.sin(angle);
    const lw = rot % 2 ? b.d : b.w, ld = rot % 2 ? b.w : b.d;
    const frame = { wx: (x, z) => b.x + x * ca + z * sa, wz: (x, z) => b.z - x * sa + z * ca };
    const hw = lw / 2 + 0.2, hd = ld / 2 + 0.2;
    const id = b.id | 0;
    const styleEra = Math.max(0, Math.min(5, b.styleEra ?? era));
    const formal = stage === 'formal';
    const kind = formal && (b.wealth ?? 0) > 0.45 ? 'clipped' : boundaryKind(b, styleEra);
    // Rows and flats share side walls: no side fences, a front rail at most.
    const row = b.variant === 'terrace' || b.variant === 'apartments' || (b.extensions?.length ?? 0) > 0 || (b.tier ?? 1) >= 4;
    // Mown: a back fence. Planted: sides and front too. Overgrown: what is
    // left of the old fences, broken up by boundary().
    const t = Math.max(tend, wild > 0.3 ? 0.45 : 0);
    if (!row) {
      if (t > 0.15) boundary(frame, -hw, -hd, hw, -hd, kind, b, id * 4);
      if (t > 0.3) {
        boundary(frame, -hw, -hd, -hw, hd, kind, b, id * 4 + 1);
        boundary(frame, hw, -hd, hw, hd, kind, b, id * 4 + 2);
      }
    }
    if (t > 0.4 && (!row || styleEra >= 3)) {
      // The front, with a gate in the middle.
      const gate = 0.75;
      const fk = row ? 'rail' : kind;
      boundary(frame, -hw, hd, -gate, hd, fk, b, id * 4 + 3);
      boundary(frame, gate, hd, hw, hd, fk, b, id * 4 + 5);
    }
    // Shrubs at the corners and by the gate, more as the garden matures.
    const shrubs = Math.min(4, Math.max(0, Math.floor((tend - 0.15) * 6)));
    const spots = [[-hw, -hd], [hw, -hd], [-1.15, hd], [1.15, hd], [-hw, hd], [hw, hd]];
    for (let i = 0; i < shrubs; i++) {
      const [lx, lz] = spots[(i + (id & 1) * 2) % spots.length];
      const x = frame.wx(lx, lz), z = frame.wz(lx, lz);
      const r = 0.38 + hashId(id * 7 + i, 45) * 0.25 + wild * 0.3;
      blob(x, heightAt(x, z) + r * 0.75, z, r, r * 0.85, r, hashId(id * 7 + i, 46) < 0.5 ? K.shrub : K.shrubLight, 1, i);
    }
    // Topiary either side of the gate on formal lots.
    if (formal && wild < 0.1) {
      for (const sx of [-1, 1]) {
        const x = frame.wx(sx * 1.0, hd + 0.35), z = frame.wz(sx * 1.0, hd + 0.35);
        const y = heightAt(x, z);
        box(x, y + 0.35, z, 0.1, 0.7, 0.1, K.woodDark);
        blob(x, y + 0.95, z, 0.36, 0.36, 0.36, K.hedgeDark, 1);
      }
    }
    // A flower border along the front for the well kept.
    if (tend > 0.55 && wild < 0.2 && (b.wealth ?? 0) > 0.3) {
      const n = 2 + Math.floor(hashId(id, 47) * 3);
      for (let i = 0; i < n; i++) {
        const side = i % 2 ? 1 : -1;
        const lx = side * (1.4 + 0.55 * Math.floor(i / 2)), lz = hd - 0.25;
        if (Math.abs(lx) > hw - 0.3) continue;
        const x = frame.wx(lx, lz), z = frame.wz(lx, lz);
        blob(x, heightAt(x, z) + 0.18, z, 0.26, 0.2, 0.26, FLOWERS[(id + i) % FLOWERS.length], 0.3);
      }
    }
    // Weeds, nettles and long grass where nobody lives: tufts all round the
    // lot, thicker and taller the longer it has been left.
    if (wild > 0.2) {
      const per = 2 * (hw + hd);
      const n = Math.min(40, Math.round((per / 1.1) * Math.min(1, wild * 1.4)));
      for (let i = 0; i < n; i++) {
        const u = (hashId(id * 11 + i, 48) * per);
        const [lx, lz] = u < 2 * hw ? [u - hw, (i % 2 ? 1 : -1) * hd] : [(i % 2 ? 1 : -1) * hw, u - 2 * hw - hd];
        const j = (hashId(id * 11 + i, 49) - 0.5) * 0.8;
        const x = frame.wx(lx + j, lz - j), z = frame.wz(lx + j, lz - j);
        const r = 0.3 + hashId(id * 11 + i, 50) * 0.35 + wild * 0.3;
        blob(x, heightAt(x, z) + r * 0.55, z, r, r * (0.7 + wild * 0.5), r, i % 3 === 0 ? K.weedsDry : K.weeds, 1, i);
      }
    }
  }

  /** A hanging sign on a bracket by the shop door. */
  function shopSign(b, era) {
    const rot = (((b.rot ?? 0) % 4) + 4) % 4;
    const angle = (rot * Math.PI) / 2, ca = Math.cos(angle), sa = Math.sin(angle);
    const lw = rot % 2 ? b.d : b.w, ld = rot % 2 ? b.w : b.d;
    const style = styleFor(b.styleEra ?? era);
    const bw = Math.max(3.4, lw * style.fill), bd = Math.max(3.4, ld * style.fill);
    const front = bd / 2 + ((ld - bd) / 2) * 0.35;
    const lx = bw / 2 - 0.25, lz = front + 0.55;
    const x = b.x + lx * ca + lz * sa, z = b.z - lx * sa + lz * ca;
    const y = heightAt(b.x, b.z) + 2.7;
    const yaw = angle + Math.PI / 2;
    box(b.x + lx * ca + (front + 0.3) * sa, y + 0.35, b.z - lx * sa + (front + 0.3) * ca, 0.06, 0.06, 0.7, K.iron, angle);
    box(x, y, z, 0.05, 0.55, 0.75, AWNINGS[(b.id | 0) % AWNINGS.length], yaw - Math.PI / 2);
  }

  // --- Yards (Medium and High) ---------------------------------------------
  // The small things of a lived-in lot, placed in the lot's own frame beside
  // the house body (kit/compose.js: body centred on x, nudged toward the
  // street by frontZ, garden behind): a woodpile against a side wall while
  // homes burn wood, a washing line in the back garden on dry days, a
  // vegetable plot in cottage gardens that follows the seasons, barrels and
  // crates by trading doors, a handcart in working yards, and hay on the
  // stubble after harvest.
  function barrel(x, y, z, yaw) {
    box(x, y + 0.36, z, 0.5, 0.72, 0.5, Y.barrel, yaw);
    box(x, y + 0.36, z, 0.5, 0.72, 0.5, Y.barrel, yaw + Math.PI / 4);
    for (const h of [0.16, 0.56]) box(x, y + h, z, 0.53, 0.05, 0.53, Y.hoop, yaw + Math.PI / 4);
  }

  function handcart(x, z, yaw) {
    const y = heightAt(x, z);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    // The bed rests tipped forward on its handles, wheels either side.
    box(x, y + 0.5, z, 1.3, 0.1, 0.8, K.wood, yaw, 0);
    for (const sz of [-0.38, 0.38]) {
      const [px, pz] = at(0, sz);
      box(px, y + 0.62, pz, 1.3, 0.2, 0.05, K.woodDark, yaw);
      const [wx, wz] = at(0.15, sz * 1.25);
      blob(wx, y + 0.36, wz, 0.36, 0.36, 0.05, K.woodDark, 0, yaw);
      const [hx, hz] = at(-0.95, sz * 0.8);
      beam(px, y + 0.55, pz, hx, y + 0.12, hz, 0.05, 0.05, K.woodDark);
    }
  }

  function yard(b, era, dry, season, free) {
    const id = b.id | 0;
    const occupied = b.occupied !== false && !b.flags?.derelict;
    if (!occupied) return;
    const rot = (((b.rot ?? 0) % 4) + 4) % 4;
    const angle = (rot * Math.PI) / 2, ca = Math.cos(angle), sa = Math.sin(angle);
    const lw = rot % 2 ? b.d : b.w, ld = rot % 2 ? b.w : b.d;
    const L = (lx, lz) => [b.x + lx * ca + lz * sa, b.z - lx * sa + lz * ca];
    const ext = new Set((b.extensions ?? []).map((e) => e.side ?? 1));
    const home = b.type === 'home';
    const tall = (b.tier ?? 1) >= 4 || b.variant === 'apartments';

    if (b.type === 'farm') {
      // Farmhouse front-left, barn front-right, the field behind (compose.js).
      const hw = Math.min(6, lw * 0.42), hd = Math.min(5.5, ld * 0.32);
      const bwid = Math.min(7, lw * 0.45);
      const gap = lw - 1.2 - hw - bwid;
      if (gap > 1.1) {
        const [x, z] = L(-lw / 2 + 0.6 + hw + gap / 2, ld / 2 - 1.2);
        handcart(x, z, angle + Math.PI / 2 + (hashId(id, 90) - 0.5) * 0.5);
      }
      if (era <= 3 && hashId(id, 91) < 0.7) {
        // Logs stacked against the farmhouse's side.
        const [x, z] = L(-lw / 2 + 0.6 + hw + 0.4, ld / 2 - 0.6 - hd * 0.65);
        woodpile(x, z, angle, id);
      }
      // After harvest: haystacks (round bales from the Industrial era) on the stubble.
      if (season === 2) {
        const fd = Math.max(2, ld - hd - 4.2);
        const fw = Math.max(2, lw - 4);
        const n = 3 + Math.floor(hashId(id, 92) * 4);
        for (let i = 0; i < n; i++) {
          const lx = (hashId(id * 13 + i, 93) - 0.5) * (fw - 2);
          const lz = -ld / 2 + 3 + hashId(id * 13 + i, 94) * Math.max(0.5, fd - 2);
          const [x, z] = L(lx, lz);
          const y = heightAt(x, z);
          if (era >= 4) blob(x, y + 0.5, z, 0.62, 0.55, 0.62, i % 3 ? Y.hay : Y.hayDark, 0, hashId(id + i, 95) * 3);
          else {
            blob(x, y + 0.8, z, 1.0, 1.25, 1.0, Y.hay, 0, i);
            blob(x, y + 1.85, z, 0.55, 0.45, 0.55, Y.hayDark, 0, i);
          }
        }
      }
      return;
    }

    // Most homes fill their lot, so the yard is the strip just outside it,
    // past the garden fence (0.2 m out): every piece checks that its ground
    // is clear of roads, water and other buildings first.
    const hx = lw / 2, hz = ld / 2;
    const ok = (pts) => pts.every(([lx, lz]) => { const [x, z] = L(lx, lz); return free(x, z, id); });

    // Woodpile against a side, while homes burn wood (to the Industrial era).
    if ((home || b.type === 'workshop') && era <= 3 && !tall && hashId(id, 96) < 0.6) {
      const sgn = hashId(id, 97) < 0.5 ? 1 : -1;
      const lx = sgn * (hx + 0.6), lz = -hz * 0.25;
      if (!ext.has(sgn > 0 ? 1 : 3) && ok([[lx, lz - 0.8], [lx, lz + 0.8], [lx + sgn * 0.5, lz]])) {
        const [x, z] = L(lx, lz);
        woodpile(x, z, angle, id);
      }
    }
    // Behind the house: a vegetable plot in cottage gardens, else (on dry
    // days) a washing line.
    const tend = b.tend ?? 0;
    const behind = !ext.has(2);
    let plot = false;
    if (behind && home && era <= 3 && !tall && tend > 0.2 && (b.wild ?? 0) < 0.2 && hashId(id, 102) < 0.5) {
      const pw = Math.min(lw + 0.6, 3.4), pd = 2.0;
      const cx = 0, cz = -hz - 0.6 - pd / 2;
      if (ok([[cx - pw / 2, cz - pd / 2], [cx + pw / 2, cz - pd / 2], [cx - pw / 2, cz + pd / 2], [cx + pw / 2, cz + pd / 2], [cx, cz]])) {
        plot = true;
        const [x, z] = L(cx, cz);
        box(x, heightAt(x, z) + 0.01, z, pw, 0.1, pd, Y.soil, angle);
        const grown = season === 0 ? 0.5 : season === 3 ? 0 : 1;
        if (grown > 0) {
          const rows = Math.max(2, Math.floor(pd / 0.55));
          const per = Math.max(2, Math.floor(pw / 0.45));
          for (let r = 0; r < rows; r++) {
            const lz = cz - pd / 2 + (r + 0.5) * (pd / rows);
            const kind = (id + r) % 3;
            for (let k = 0; k < per; k++) {
              const lx = cx - pw / 2 + (k + 0.5) * (pw / per);
              const [px, pz] = L(lx, lz);
              const autumnPumpkin = season === 2 && kind === 0 && (k + r) % 2 === 0;
              const rr = (kind === 1 ? 0.14 : 0.18) * grown;
              const c = autumnPumpkin ? Y.pumpkin : kind === 0 ? Y.veg : kind === 1 ? Y.vegLight : Y.vegDark;
              blob(px, heightAt(px, pz) + 0.08 + rr * 0.6, pz, rr, rr * (kind === 2 ? 1.5 : 0.85), rr, c, autumnPumpkin ? 0 : 0.6, k);
            }
          }
        }
      }
    }
    if (!plot && behind && home && dry && era >= 1 && era <= 4 && hashId(id, 98) < (tall ? 0.2 : 0.45)) {
      const half = Math.min(hx + 0.4, 2.3);
      const lz = -hz - 1.3;
      if (half > 0.9 && ok([[-half, lz], [half, lz], [0, lz], [0, lz + 0.6]])) {
        const [ax, az] = L(-half, lz), [bx2, bz2] = L(half, lz);
        const ya = heightAt(ax, az), yb = heightAt(bx2, bz2);
        leg(ax, az, ya + 1.9, 0.07, 0.07, K.woodDark);
        leg(bx2, bz2, yb + 1.9, 0.07, 0.07, K.woodDark);
        beam(ax, ya + 1.82, az, bx2, yb + 1.82, bz2, 0.015, 0.015, Y.line);
        let u = 0.25;
        for (let i = 0; i < 6 && u < 2 * half - 0.3; i++) {
          const w = 0.32 + hashId(id * 17 + i, 99) * 0.5;
          const h = 0.45 + hashId(id * 17 + i, 100) * 0.4;
          const t = (u + w / 2) / (2 * half);
          const x = ax + (bx2 - ax) * t, z = az + (bz2 - az) * t;
          const y = ya + (yb - ya) * t + 1.8 - h / 2 - 0.02;
          box(x, y, z, w, h, 0.025, LAUNDRY[(id + i * 3) % LAUNDRY.length], angle, (hashId(id + i, 101) - 0.5) * 0.25);
          u += w + 0.12;
        }
      }
    }
    // Barrels and crates by trading and working doors.
    if (STOCKED.has(b.type)) {
      const sgn = hashId(id, 104) < 0.5 ? 1 : -1;
      const lx = sgn * (hx + 0.55);
      if (!ext.has(sgn > 0 ? 1 : 3)) {
        const n = 2 + Math.floor(hashId(id, 105) * 3);
        for (let i = 0; i < n; i++) {
          const lz = hz - 0.45 - i * 0.62;
          if (!ok([[lx, lz], [lx + sgn * 0.3, lz]])) continue;
          const [x, z] = L(lx + (hashId(id + i, 106) - 0.5) * 0.15, lz);
          const y = heightAt(x, z);
          if ((i + id) % 3 === 2) box(x, y + 0.28, z, 0.56, 0.56, 0.56, Y.crate, angle + hashId(id + i, 107) * 0.6);
          else barrel(x, y, z, angle + hashId(id + i, 107));
        }
        const cz = -hz * 0.4;
        if (b.type === 'workshop' && ok([[lx + sgn * 0.6, cz - 0.9], [lx + sgn * 0.6, cz + 0.9], [lx + sgn * 1.2, cz]])) {
          const [x, z] = L(lx + sgn * 0.6, cz);
          handcart(x, z, angle + Math.PI / 2);
        }
      }
    }
  }

  function woodpile(x, z, yaw, id) {
    const y = topGround(x, z, yaw, [[0, -0.75], [0, 0.75]]);
    for (let r = 0; r < 3; r++) {
      const len = 1.5 - r * 0.12 - hashId(id + r, 108) * 0.1;
      box(x, y + 0.15 + r * 0.27, z, 0.55, 0.27, len, r % 2 ? Y.logEndDark : Y.logEnd, yaw);
    }
    // A plank roof leaning on the wall, and the chopping block.
    const c = Math.cos(yaw), s = Math.sin(yaw);
    box(x, y + 1.02, z, 0.8, 0.05, 1.75, K.woodDark, yaw, 0);
    box(x + c * 0.75 + s * 0.6, y + 0.2, z - s * 0.75 + c * 0.6, 0.38, 0.4, 0.38, Y.log, yaw + 0.4);
  }

  // --- Parks ---------------------------------------------------------------
  function park(b, era, season, sandQuads, level) {
    const id = b.id | 0;
    // A park the town stops keeping goes back to meadow and scrub.
    const neglect = Math.max(0, -level);
    const hw = b.w / 2, hd = b.d / 2;
    const frame = { wx: (x) => b.x + x, wz: (_, z) => b.z + z };
    const at = (lx, lz) => [b.x + lx, b.z + lz];
    // Which side faces the water (beaches): the bank side.
    const toRiver = Math.sign(riverX(b.z) - b.x) || 1;
    const beach = !!b.flags?.beach;
    // A low rail (or a post-and-rail fence) round it, gates on two sides.
    const rail = era >= 3 ? 'rail' : 'picket';
    const pseudo = { wild: neglect, id };
    for (const [x0, z0, x1, z1, k] of [[-hw, -hd, hw, -hd, 0], [-hw, hd, hw, hd, 1], [-hw, -hd, -hw, hd, 2], [hw, -hd, hw, hd, 3]]) {
      // Leave the water side open on a beach.
      if (beach && ((k === 2 && toRiver < 0) || (k === 3 && toRiver > 0))) continue;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const alongX = z0 === z1;
      const g = 0.9;
      if (alongX) {
        boundary(frame, x0, z0, mx - g, z0, rail, pseudo, id * 8 + k * 2);
        boundary(frame, mx + g, z0, x1, z1, rail, pseudo, id * 8 + k * 2 + 1);
      } else {
        boundary(frame, x0, z0, x0, mz - g, rail, pseudo, id * 8 + k * 2);
        boundary(frame, x0, mz + g, x1, z1, rail, pseudo, id * 8 + k * 2 + 1);
      }
    }
    // The path itself is drawn on the ground by the park decal (decals.js);
    // benches, lamps and beds follow its ring.
    const r = Math.min(hw, hd) * 0.55;
    // Benches on the path, facing in (a beach's face the water): sim/seats.js,
    // where walkers find them too.
    for (const s of benchesOf(b)) bench(s.x, s.z, s.yaw);
    // A notice board at the gate, a bin from the Town era.
    {
      const [x, z] = at(1.3, hd - 0.6);
      noticeBoard(x, z, 0);
      if (era >= 2) { const [bx2, bz2] = at(-1.3, hd - 0.6); bin(bx2, bz2, false, hashId(id, 62)); }
    }
    // Wildflowers: the meadow is let grow between the path and the rail.
    const nf = 8 + Math.floor(hashId(id, 63) * 8);
    for (let i = 0; i < nf; i++) {
      const lx = (hashId(id * 31 + i, 64) - 0.5) * 2 * (hw - 0.6), lz = (hashId(id * 31 + i, 65) - 0.5) * 2 * (hd - 0.6);
      const e = Math.hypot(lx / Math.max(0.1, hw), lz / Math.max(0.1, hd));
      if (e < 0.7) continue;  // keep the middle mown
      const [x, z] = at(lx, lz);
      blob(x, heightAt(x, z) + 0.12, z, 0.24, 0.16, 0.24, FLOWERS[(i + id) % FLOWERS.length], 0.4);
      if (i % 3 === 0) blob(x + 0.3, heightAt(x, z) + 0.22, z - 0.2, 0.3, 0.3, 0.3, K.shrubLight, 1);
    }
    if (era >= 3 && neglect < 0.3) for (const s of [-1, 1]) { const [x, z] = at(s * (r + 0.4), 0); lamp(x, z); }
    // Formal: a ring of flower beds round the middle.
    if (stickyStage(`park:${id}`, level, era) === 'formal') {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const [x, z] = at(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45);
        blob(x, heightAt(x, z) + 0.16, z, 0.42, 0.2, 0.42, FLOWERS[(i + id) % FLOWERS.length], 0.3);
      }
    }
    // Neglect: scrub creeps in from the edges.
    for (let i = 0; i < Math.round(neglect * 10); i++) {
      const lx = (hashId(id * 37 + i, 75) - 0.5) * 2 * (hw - 0.5), lz = (hashId(id * 37 + i, 76) - 0.5) * 2 * (hd - 0.5);
      const [x, z] = at(lx, lz);
      const rr = 0.45 + hashId(id * 37 + i, 77) * 0.5;
      blob(x, heightAt(x, z) + rr * 0.6, z, rr, rr * 0.8, rr, i % 2 ? K.weeds : K.shrub, 1);
    }
    if (beach) beachDressing(b, era, season, toRiver, sandQuads);
  }

  function beachDressing(b, era, season, toRiver, sandQuads) {
    const id = b.id | 0;
    const hd = b.d / 2;
    // The sand runs from the park's water edge down to the river.
    const edge = b.x + toRiver * (b.w / 2);
    const water = riverX(b.z) - toRiver * waterHalf();
    sandQuads.push({ x0: Math.min(edge - toRiver * 2.5, water), x1: Math.max(edge - toRiver * 2.5, water), z0: b.z - hd - 2, z1: b.z + hd + 2 });
    const mid = (edge + water) / 2;
    // Boats pulled up on the sand.
    for (let i = 0; i < 2; i++) {
      const z = b.z + (i ? 1 : -1) * hd * 0.5, x = mid + (hashId(id + i, 66) - 0.5);
      const y = heightAt(x, z);
      // A rowing boat, keel up the sand: hull, gunwales and a seat.
      const yaw = Math.PI / 2 + (i ? 0.25 : -0.2);
      box(x, y + 0.18, z, 2.6, 0.3, 0.9, K.woodDark, yaw);
      box(x, y + 0.36, z, 2.7, 0.08, 1.0, K.wood, yaw);
      box(x, y + 0.24, z, 2.2, 0.06, 0.7, K.board, yaw);
      box(x, y + 0.42, z, 0.18, 0.06, 0.9, K.wood, yaw);
    }
    // Towels and a sunshade on summer days.
    if (season === 1) {
      for (let i = 0; i < 4; i++) {
        const z = b.z + (hashId(id * 5 + i, 67) - 0.5) * 2 * hd, x = mid + (hashId(id * 5 + i, 68) - 0.5) * 2;
        box(x, heightAt(x, z) + 0.03, z, 0.8, 0.03, 1.6, TOWELS[(id + i) % TOWELS.length], hashId(id * 5 + i, 69) * 0.6);
      }
    }
    if (era >= 3) {
      const x = edge - toRiver * 1.2, z = b.z - hd + 1.2;
      const pts = [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]];
      const y = topGround(x, z, 0, pts);
      const low = Math.min(...pts.map(([lx, lz]) => heightAt(x + lx, z + lz))) - 0.05;
      box(x, (low + y + 2) / 2, z, 1.6, y + 2 - low, 1.6, K.hut);
      box(x, y + 2.15, z, 1.9, 0.3, 1.9, K.hutRoof);
    }
  }

  function buildSand(quads) {
    const pos = [], colr = [];
    const step = 1.5;
    for (const q of quads) {
      const nx = Math.max(1, Math.ceil((q.x1 - q.x0) / step)), nz = Math.max(1, Math.ceil((q.z1 - q.z0) / step));
      const vx = (i) => q.x0 + ((q.x1 - q.x0) * i) / nx, vz = (j) => q.z0 + ((q.z1 - q.z0) * j) / nz;
      const alpha = (x, z) => {
        // Soft at the land edge and the ends; under the water line it fades into the shallows.
        const ez = Math.min(z - q.z0, q.z1 - z) / 2.2;
        const bank = bankDistance(x, z);
        const ew = bank < 0 ? 1 + bank / 1.2 : 1;
        return Math.max(0, Math.min(1, ez, ew)) * 0.85;
      };
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          const c = [[vx(i), vz(j)], [vx(i + 1), vz(j)], [vx(i + 1), vz(j + 1)], [vx(i), vz(j + 1)]];
          for (const k of [0, 2, 1, 0, 3, 2]) {
            const [x, z] = c[k];
            pos.push(x, heightAt(x, z) + 0.04, z);
            colr.push(K.sand.r, K.sand.g, K.sand.b, alpha(x, z));
          }
        }
    }
    sand.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 4));
    g.computeVertexNormals();
    sand.geometry = g;
    sand.visible = pos.length > 0;
  }

  // --- Streets -------------------------------------------------------------
  function streets(view, cx, cz, reach, lotCells, litterSpots) {
    const r = view.roads;
    if (!r?.tier) return;
    const { W, H, cell, ox, oz, tier, wear, planned } = r;
    const era = view.era ?? 0;
    const T = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : tier[j * W + i]);
    const ci = Math.floor((cx - ox) / cell), cj = Math.floor((cz - oz) / cell);
    // Pieces kept one per block (fingerposts, bins, benches) must not depend
    // on where the camera looks: a block is in or out by its own centre, and
    // all of its cells are weighed, so panning never moves a bench to another
    // cell. The scan runs a block past the reach so edge blocks are whole.
    const PAD = 12;
    const rad = Math.ceil(reach / cell) + PAD;
    const blockIn = (i, j, size) => {
      const bx = ox + (Math.floor(i / size) + 0.5) * size * cell, bz = oz + (Math.floor(j / size) + 0.5) * size * cell;
      return (bx - cx) ** 2 + (bz - cz) ** 2 <= reach * reach;
    };
    const signBins = new Set(), binBins = new Map(), benchBins = new Set();
    const free = (i, j) => !lotCells.has(j * W + i) && T(i, j) === 0 && bankDistance(ox + (i + 0.5) * cell, oz + (j + 0.5) * cell) > 1;
    for (let j = cj - rad; j <= cj + rad; j++) {
      for (let i = ci - rad; i <= ci + rad; i++) {
        const t = T(i, j);
        if (t < 1) continue;
        const x = ox + (i + 0.5) * cell, z = oz + (j + 0.5) * cell;
        const near = (x - cx) ** 2 + (z - cz) ** 2 <= reach * reach;
        const k = j * W + i;
        // Verges by stage: weeds where the block is overgrown, shrubs where it
        // is planted, planters with clipped shrubs on formal made streets.
        if (near && t >= 2 && view.landscape) {
          const level = landAt(view, x, z);
          const stage = stickyStage(k, level, era);
          const h = hashId(k, 78);
          if (stage === 'overgrown' || stage === 'planted' || stage === 'formal') {
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (!free(i + di, j + dj)) continue;
              const vx = x + di * cell * 0.7, vz = z + dj * cell * 0.7;
              if (stage === 'overgrown' && h < 0.45) {
                const rr = 0.35 + h * 0.6;
                blob(vx, heightAt(vx, vz) + rr * 0.5, vz, rr, rr * 0.7, rr, h < 0.2 ? K.weedsDry : K.weeds, 1);
              } else if (stage === 'planted' && h < 0.22) {
                const rr = 0.4 + h;
                blob(vx, heightAt(vx, vz) + rr * 0.7, vz, rr, rr * 0.8, rr, K.shrub, 1);
              } else if (stage === 'formal' && t >= 3 && (i + j) % 3 === 0) {
                if (era >= 4 && (i + j) % 2) {
                  // A raised flower bed.
                  box(vx, heightAt(vx, vz) - 0.1, vz, 1.2, 1.0, 1.2, K.stone);
                  for (let f = 0; f < 3; f++) blob(vx + (f - 1) * 0.35, heightAt(vx, vz) + 0.5, vz, 0.24, 0.18, 0.24, FLOWERS[(k + f) % FLOWERS.length], 0.3);
                } else clippedShrub(vx, vz, 0.42, h * 6);
              }
              break;
            }
          }
        }
        // Fingerposts where three ways meet (from the Village era).
        if (era >= 1 && t >= 2 && blockIn(i, j, 8)) {
          let arms = 0;
          for (const [di, dj] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) if (T(i + di, j + dj) >= 2) arms++;
          const sb = `${Math.floor(i / 8)},${Math.floor(j / 8)}`;
          if (arms >= 3 && !signBins.has(sb)) {
            for (const [di, dj] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
              if (!free(i + di, j + dj)) continue;
              signBins.add(sb);
              fingerpost(x + di * cell * 0.8, z + dj * cell * 0.8, hashId(k, 70) * Math.PI);
              break;
            }
          }
        }
        // Bins on busy made streets (from the Town era): the busiest verge
        // cell in each 8-cell block keeps one.
        if (era >= 2 && t >= 3 && blockIn(i, j, 8)) {
          const w = wear[k];
          if (w > BIN_OFF) {
            // Candidates per block: the busiest cell, and the cell that had the
            // bin last time (decided after the scan, with hysteresis).
            const bb = Math.floor(i / 8) * 4096 + Math.floor(j / 8);
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (!free(i + di, j + dj)) continue;
              const spot = { w, k, x: x + di * cell * 0.75, z: z + dj * cell * 0.75, seed: hashId(k, 71) };
              const c = binBins.get(bb) ?? { best: null, kept: null };
              if (!c.best || w > c.best.w) c.best = spot;
              if (binMem.get(bb) === k) c.kept = spot;
              binBins.set(bb, c);
              break;
            }
          }
        }
        // Benches along embanked towpaths, looking at the water.
        if (era >= 2 && (planned[k] & 16) && (i + j) % 9 === 0 && blockIn(i, j, 10)) {
          const bb = `${Math.floor(i / 10)},${Math.floor(j / 10)}`;
          if (!benchBins.has(bb)) {
            benchBins.add(bb);
            const side = Math.sign(riverX(z) - x) || 1;
            bench(x - side * 0.6, z, side > 0 ? Math.PI / 2 : -Math.PI / 2);
          }
        }
      }
    }
    // Riverbanks: where the bank is kept, a bench looking at the water; where
    // it has gone wild, reeds and nettles.
    if (view.landscape && era >= 1) {
      const bankBins = new Set();
      // Every other cell on a fixed (even) lattice, not one counted from the
      // view centre, so the sampled cells stay put as the camera pans.
      const j0 = (cj - rad) & ~1, i0 = (ci - rad) & ~1;
      for (let j = j0; j <= cj + rad; j += 2) {
        for (let i = i0; i <= ci + rad; i += 2) {
          const x = ox + (i + 0.5) * cell, z = oz + (j + 0.5) * cell;
          const bd = bankDistance(x, z);
          if (bd < 1 || bd > 3.5 || !free(i, j)) continue;
          const near = (x - cx) ** 2 + (z - cz) ** 2 <= reach * reach;
          const level = landAt(view, x, z);
          const side = Math.sign(riverX(z) - x) || 1;
          if (level >= 0.4) {
            if (!blockIn(i, j, 12)) continue;
            const bb = `${Math.floor(i / 12)},${Math.floor(j / 12)}`;
            if (bankBins.has(bb)) continue;
            bankBins.add(bb);
            bench(x, z, side > 0 ? Math.PI / 2 : -Math.PI / 2);
          } else if (near && level < -0.3 && hashId(j * W + i, 79) < 0.5) {
            const h = heightAt(x, z);
            for (let r2 = 0; r2 < 3; r2++) blob(x + (r2 - 1) * 0.5, h + 0.6, z + (r2 % 2) * 0.4, 0.22, 0.8, 0.22, r2 % 2 ? K.weeds : K.hedge, 1);
          }
        }
      }
    }
    for (const [bb, c] of binBins) {
      // Keep last time's cell unless another is clearly busier; a new bin
      // needs a busy cell (BIN_ON), an existing one stays down to BIN_OFF.
      const b = c.kept && !(c.best.w > c.kept.w * BIN_SWITCH) ? c.kept : c.best.w > BIN_ON ? c.best : null;
      if (!b) { binMem.delete(bb); continue; }
      binMem.set(bb, b.k);
      const over = litterSpots.some((s) => (s.x - b.x) ** 2 + (s.z - b.z) ** 2 < 16 * 16);
      bin(b.x, b.z, over, b.seed);
    }
  }

  // --- Layout --------------------------------------------------------------
  let lastBuild = -10;
  let sig = 0;
  const lastCentre = new THREE.Vector3(1e9, 0, 1e9);

  function tierName() {
    return ctx.quality?.name ?? 'medium';
  }

  // Washing comes in when it rains or snows.
  const dryDay = (view) => (view.weather?.rain ?? 0) < 0.2 && (view.weather?.snow ?? 0) < 0.2;

  function signature(view) {
    let h = (buildings?.version?.() ?? 0) * 31 + (view.roads?.version ?? 0) + (dryDay(view) ? 0 : 7);
    h = Math.imul(h ^ (view.aesthetics?.rev ?? -1), 16777619);
    h = Math.imul(h ^ (view.landscape?.rev ?? -1), 16777619);
    h = Math.imul(h ^ ((view.era ?? 0) * 7 + (view.time?.season ?? 0)), 16777619);
    return h;
  }

  /**
   * Whether yard ground at (x, z) is clear: not on a road or trodden lane,
   * not by the water, and outside every other building's lot (plus 0.4 m).
   * Uses every building, not just those in reach, so the answer never
   * depends on where the camera is.
   */
  function yardClearance(view) {
    const G = 8, grid = new Map();
    for (const o of view.buildings ?? []) {
      const r = Math.max(o.w, o.d) / 2 + 0.4;
      for (let gz = Math.floor((o.z - r) / G); gz <= Math.floor((o.z + r) / G); gz++)
        for (let gx = Math.floor((o.x - r) / G); gx <= Math.floor((o.x + r) / G); gx++) {
          const k = gx * 65536 + gz;
          let cell = grid.get(k);
          if (!cell) grid.set(k, (cell = []));
          cell.push(o);
        }
    }
    const R = view.roads;
    return (x, z, selfId) => {
      if (R?.tier) {
        const i = Math.floor((x - R.ox) / R.cell), j = Math.floor((z - R.oz) / R.cell);
        if (i >= 0 && j >= 0 && i < R.W && j < R.H) {
          const k = j * R.W + i;
          if (R.tier[k] > 0 || (R.wear && R.wear[k] > 60)) return false;
        }
      }
      if (bankDistance(x, z) < 1.5) return false;
      for (const o of grid.get(Math.floor(x / G) * 65536 + Math.floor(z / G)) ?? []) {
        if ((o.id | 0) === selfId) continue;
        if (Math.abs(x - o.x) < o.w / 2 + 0.4 && Math.abs(z - o.z) < o.d / 2 + 0.4) return false;
      }
      return true;
    };
  }

  function layout(view, centre) {
    nBox = 0;
    nBlob = 0;
    const reach = REACH[tierName()] ?? REACH.medium;
    const era = view.era ?? 0;
    const season = view.time?.season ?? 0;
    const cx = centre.x, cz = centre.z;
    const lotCells = new Set();
    const r = view.roads;
    const sandQuads = [];
    // Litter hot spots residents complain about (aesthetics.js).
    const litterSpots = [];
    for (const list of Object.values(view.aesthetics?.experiences ?? {})) {
      for (const e of list) if (e.what === 'litter' && e.severity >= 0.2) litterSpots.push(e);
    }
    const near = [];
    for (const b of view.buildings ?? []) {
      if ((b.x - cx) ** 2 + (b.z - cz) ** 2 > (reach + 10) ** 2) continue;
      near.push(b);
      if (r && b.type !== 'bridge') {
        const i0 = Math.floor((b.x - b.w / 2 - r.ox) / r.cell), i1 = Math.floor((b.x + b.w / 2 - r.ox) / r.cell);
        const j0 = Math.floor((b.z - b.d / 2 - r.oz) / r.cell), j1 = Math.floor((b.z + b.d / 2 - r.oz) / r.cell);
        for (let j = j0 - 1; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) lotCells.add(j * r.W + i);
      }
    }
    // Nearest first, so the caps drop the far edge.
    near.sort((a, b) => (a.x - cx) ** 2 + (a.z - cz) ** 2 - ((b.x - cx) ** 2 + (b.z - cz) ** 2) || a.id - b.id);
    const districtsWithWell = new Set();
    // Yards: by tier (quality.js; Low draws what it always drew).
    const yards = !!ctx.quality?.yards;
    const yardFree = yards ? yardClearance(view) : null;
    const dry = dryDay(view);
    for (const b of near) {
      if ((b.built ?? 1) < 1) continue;
      if (b.type === 'park') { park(b, era, season, sandQuads, view.landscape ? landAt(view, b.x, b.z) : 0.5); continue; }
      if (!NO_GARDEN.has(b.type)) garden(b, era);
      if (yards) yard(b, era, dry, season, yardFree);
      if (SIGNED.has(b.type) && b.occupied !== false && !b.flags?.derelict && era >= 1) shopSign(b, era);
      if (b.type === 'market' || (b.type === 'shop' && b.variant === 'stall')) {
        const n = b.type === 'market' ? 3 + Math.floor(hashId(b.id, 72) * 3) : 1;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + 0.4;
          const rr = Math.max(b.w, b.d) / 2 + 1.6;
          const x = b.x + Math.cos(a) * rr, z = b.z + Math.sin(a) * rr;
          if (r && lotCells.has(Math.floor((z - r.oz) / r.cell) * r.W + Math.floor((x - r.ox) / r.cell)) && b.type !== 'market') continue;
          stall(x, z, Math.atan2(b.x - x, b.z - z) + Math.PI, hashId(b.id * 3 + i, 73));
        }
      }
      // Benches by the doors of the places people gather.
      if (GATHER.has(b.type)) for (const s of benchesOf(b)) bench(s.x, s.z, s.yaw);
      // A well (later a pump) by the first homes of each district.
      if (b.type === 'home' && b.districtId != null && !districtsWithWell.has(b.districtId) && hashId(b.id, 74) < 0.25) {
        const rot = (((b.rot ?? 0) % 4) + 4) % 4, angle = (rot * Math.PI) / 2;
        const lw = rot % 2 ? b.d : b.w, ld = rot % 2 ? b.w : b.d;
        const lx = lw / 2 + 1.3, lz = ld / 2 + 1.6;
        const x = b.x + lx * Math.cos(angle) + lz * Math.sin(angle), z = b.z - lx * Math.sin(angle) + lz * Math.cos(angle);
        if (!r || !lotCells.has(Math.floor((z - r.oz) / r.cell) * r.W + Math.floor((x - r.ox) / r.cell))) {
          districtsWithWell.add(b.districtId);
          well(x, z, era);
        }
      }
    }
    streets(view, cx, cz, reach, lotCells, litterSpots);
    boxes.count = nBox;
    blobs.count = nBlob;
    // Upload only the rows in use (the buffers are sized for the busiest view).
    for (const m of [boxes, blobs]) {
      const n = Math.max(1, m.count);
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.clearUpdateRanges();
        m.instanceColor.addUpdateRange(0, n * 3);
        m.instanceColor.needsUpdate = true;
      }
    }
    leafAttr.clearUpdateRanges();
    leafAttr.addUpdateRange(0, Math.max(1, nBlob));
    leafAttr.needsUpdate = true;
    boxes.visible = nBox > 0;
    blobs.visible = nBlob > 0;
    buildSand(sandQuads);
    lastCentre.set(cx, 0, cz);
    // Benches, planters and the rest cast shadows: redraw the map once.
    lights?.markDirty?.();
  }

  return {
    update(view, frame) {
      if (!view) return;
      const shown = (frame.distance ?? 0) < HIDE_BEYOND;
      if (shown !== group.visible) {
        group.visible = shown;
        lights?.markDirty?.();
      }
      if (!shown) return;
      const t = frame.time;
      const reach = REACH[tierName()] ?? REACH.medium;
      const s = signature(view);
      const moved = lastCentre.distanceToSquared(frame.target) > (reach * 0.35) ** 2;
      if ((s !== sig || moved) && t - lastBuild > REBUILD_GAP) {
        sig = s;
        lastBuild = t;
        layout(view, frame.target);
      }
    },
    applyQuality() {
      sig = 0;
    },
    stats() {
      return { boxes: nBox, blobs: nBlob };
    },
    dispose() {
      scene.remove(group);
      boxGeo.dispose();
      blobGeo.dispose();
      sand.geometry.dispose();
      boxMat.dispose();
      blobMat.dispose();
      sandMat.dispose();
    },
  };
}
