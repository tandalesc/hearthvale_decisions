// Path nodes: where the centreline of a worn path runs through each path cell,
// and which neighbouring nodes it links to.
//
// Shared by the path renderer (src/render/paths.js), which draws a capsule for
// every node and every link, and the nav grid (src/sim/roads.js), whose
// waypoints walk along the same nodes and links, so walkers follow the line
// that is drawn. Pure: a function of the road tiers, the planned flags and the
// grid geometry (and, for towpath cells, of the river, fixed per terrain seed).
//
// Links. A path cell (tier >= 1) links to each path cell beside it, and to a
// diagonal one only when neither cell across the corner is a path (that corner
// already joins them); two towpath-lane cells always link.
//
// Positions, in four kinds of cell:
//  - Lane: a towpath cell by the river (planned & TOWPATH, within TOW_REACH of
//    the bank) sits on one lane TOW_BANK from the water's edge at its own z, so
//    a band of towpath cells two or three deep is one even lane along the bank.
//  - Area: a cell in a 2 x 2 block of path cells (a square, a yard, a broad
//    road, two braids side by side) keeps its seed position, its centre pulled
//    toward its path neighbours ((2 x own centre + their centres) / (2 + count)),
//    so a paved block keeps its straight sides and rounded corners and two
//    braids close into one lane.
//  - Knot: a small unplanned lump of area cells (a 2 x 2 block: at most
//    KNOT_MAX cells within KNOT_SPAN x KNOT_SPAN) where two or more paths meet. All its cells share
//    one node, at the meeting point of the paths into it, so a junction of worn
//    trails is one clean point rather than a little web of links.
//  - Line: the rest, thin paths. Starting from the seed position, RELAX_ITER
//    rounds of constrained Laplacian smoothing move each node toward its linked
//    neighbours' nodes: a node on a line (two links) strongly toward their
//    midpoint, so a staircase becomes a straight diagonal and a curve a curve;
//    an end (one link) stays where its seed put it; a junction (three or more) to the
//    least-squares meeting point of its arms' lines, so the arms run straight
//    into it. Each line node stays in its own cell, or NODE_MARGIN into a path
//    cell beside it, and NODE_INSET back from a side with no path (a knot
//    node, within its cells), so a node never leaves the path's own cells.
//
// A tier change moves nodes up to NODE_REACH cells away. patchNodes redoes a
// window of cells around each change and gives exactly what a fresh build gives.
//
// geom: {W, H, cell, ox, oz}. Positions are in cell units (a cell's centre is
// at x + 0.5, z + 0.5) unless stated otherwise.

import { riverX, bankDistance, WATER_HALF } from './terrain.js';

export const TOWPATH = 16;          // roads.planned flag (sim/roads.js FLAG.TOWPATH)
const PLANNED = 1;                  // roads.planned flag (FLAG.PLANNED)
export const TOW_BANK = 1.7;        // lane centre, world units from the water's edge
export const TOW_REACH = 8;         // towpath cells further from the bank keep the planned fill
export const RELAX_ITER = 4;
const LINE_PULL = 0.6;              // a line node's step toward its neighbours' midpoint, per round
const END_PULL = 0;                 // an end (one link) keeps its seed: the drawn line ends where it did
export const NODE_MARGIN = 0.15;    // cells a line node may stray into a path cell beside it
export const NODE_INSET = 0.2;      // and keeps back from a side with no path beside it (a wall, the water)
export const KNOT_MAX = 4;
export const KNOT_SPAN = 2;
// Cells a change can move nodes by (a change reaches a few cells through the
// kinds and knots, and each round of smoothing up to 4 more; changes on the
// city move nodes at most 9 cells away; this leaves room), and the extra
// window a patch solves around those so that their values are exact.
export const NODE_REACH = 12;
const WINDOW_PAD = 16;

// Link directions: bit d of a link mask is the neighbour (LINK_DX[d], LINK_DZ[d]);
// the opposite direction is 7 - d.
export const LINK_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
export const LINK_DZ = [-1, -1, -1, 0, 0, 1, 1, 1];

export function isPathAt(geom, tier, x, z) {
  return x >= 0 && z >= 0 && x < geom.W && z < geom.H && tier[z * geom.W + x] >= 1;
}

/** A towpath cell by the river: its node goes on the bank-following lane. */
export function isLane(geom, planned, i) {
  if (!planned || !(planned[i] & TOWPATH)) return false;
  const { W, cell, ox, oz } = geom;
  const x = ox + (i % W + 0.5) * cell, z = oz + (((i / W) | 0) + 0.5) * cell;
  const d = bankDistance(x, z);
  return d > -1 && d < TOW_REACH;
}

/** The links of path cell (x, z) as a mask of LINK_DX/LINK_DZ bits. */
export function linkMask(geom, tier, planned, x, z) {
  const { W } = geom;
  const i = z * W + x;
  let mask = 0, lane = -1;
  for (let d = 0; d < 8; d++) {
    const dx = LINK_DX[d], dz = LINK_DZ[d];
    if (!isPathAt(geom, tier, x + dx, z + dz)) continue;
    if (dx && dz && (isPathAt(geom, tier, x + dx, z) || isPathAt(geom, tier, x, z + dz))) {
      // Across a joined corner: only two lane cells link (they sit on one line).
      if (lane < 0) lane = isLane(geom, planned, i) ? 1 : 0;
      if (!lane || !isLane(geom, planned, (z + dz) * W + x + dx)) continue;
    }
    mask |= 1 << d;
  }
  return mask;
}

function inBlock(geom, tier, x, z) {
  for (let bz = z - 1; bz <= z; bz++)
    for (let bx = x - 1; bx <= x; bx++)
      if (isPathAt(geom, tier, bx, bz) && isPathAt(geom, tier, bx + 1, bz) && isPathAt(geom, tier, bx, bz + 1) && isPathAt(geom, tier, bx + 1, bz + 1)) return true;
  return false;
}

/**
 * The seed node of path cell (x, z), in cell units, into out[0], out[1]: the lane
 * position for a lane cell, else the centre pulled toward its path neighbours.
 */
export function seedNode(geom, tier, planned, x, z, out) {
  const { W, cell, ox, oz } = geom;
  const i = z * W + x;
  if (isLane(geom, planned, i)) {
    // On the lane: the water's edge plus TOW_BANK, on this cell's bank, at its z.
    const wx = ox + (x + 0.5) * cell, wz = oz + (z + 0.5) * cell;
    const rx = riverX(wz), half = WATER_HALF;
    const lx = rx + (wx < rx ? -1 : 1) * (half + TOW_BANK);
    out[0] = (lx - ox) / cell; out[1] = z + 0.5;
    return out;
  }
  let sx = 2 * (x + 0.5), sz = 2 * (z + 0.5), n = 2;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dz) || !isPathAt(geom, tier, x + dx, z + dz)) continue;
      sx += x + dx + 0.5; sz += z + dz + 0.5; n++;
    }
  out[0] = sx / n; out[1] = sz / n;
  return out;
}

// ---------------------------------------------------------------- the solver

const NONE = 0, LINE = 1, AREA = 2, LANE = 3, KNOT = 4;
const seedOut = new Float64Array(2);

// Window scratch, grown as needed (the solver is not re-entrant).
let cap = 0;
let kind, links, knotOf, p0x, p0z, cx, cz, nx, nz, box, diag, nb;
function ensure(n) {
  if (n <= cap) return;
  cap = Math.max(n, cap * 2);
  kind = new Uint8Array(cap); links = new Uint8Array(cap); knotOf = new Int32Array(cap);
  p0x = new Float64Array(cap); p0z = new Float64Array(cap);
  cx = new Float64Array(cap); cz = new Float64Array(cap);
  nx = new Float64Array(cap); nz = new Float64Array(cap);
  box = new Float64Array(cap * 4);   // clamp box: x0, x1, z0, z1
  diag = new Uint8Array(cap);        // which diagonal neighbours are paths (bits: -,-  +,-  -,+  +,+)
  nb = new Int32Array(cap * 2);      // a line node's (one or two) linked neighbours, window-local (-1 outside)
}

const popcount = (m) => { let n = 0; for (; m; m &= m - 1) n++; return n; };

// An area cell (in a 2 x 2 block, not on the towpath lane), anywhere in the grid.
function areaAt(geom, tier, planned, x, z) {
  return isPathAt(geom, tier, x, z) && inBlock(geom, tier, x, z) && !isLane(geom, planned, z * geom.W + x);
}

// The lump of area cells linked to (x, z), if it is a knot: {cells (sorted), x0, z0,
// x1, z1, arms: [[member, arm], ...]}; null if it is too big, planned, or joins
// fewer than two paths.
function knotFrom(geom, tier, planned, x, z) {
  const { W } = geom;
  const cells = [z * W + x];
  let x0 = x, x1 = x, z0 = z, z1 = z;
  for (let q = 0; q < cells.length; q++) {
    const i = cells[q], ix = i % W, iz = (i - ix) / W;
    if (planned && planned[i] & PLANNED) return null;
    const m = linkMask(geom, tier, planned, ix, iz);
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const jx = ix + LINK_DX[d], jz = iz + LINK_DZ[d], j = jz * W + jx;
      if (cells.includes(j) || !areaAt(geom, tier, planned, jx, jz)) continue;
      cells.push(j);
      x0 = Math.min(x0, jx); x1 = Math.max(x1, jx); z0 = Math.min(z0, jz); z1 = Math.max(z1, jz);
      if (cells.length > KNOT_MAX || x1 - x0 >= KNOT_SPAN || z1 - z0 >= KNOT_SPAN) return null;
    }
  }
  cells.sort((a, b) => a - b);
  const arms = [];
  for (const i of cells) {
    const ix = i % W, iz = (i - ix) / W;
    const m = linkMask(geom, tier, planned, ix, iz);
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const j = (iz + LINK_DZ[d]) * W + ix + LINK_DX[d];
      if (!cells.includes(j)) arms.push(i, j);
    }
  }
  if (arms.length < 4) return null;
  return { cells, x0, z0, x1, z1, arms, px: 0, pz: 0 };
}

/**
 * Solve the nodes of window [wx0, wx1) x [wz0, wz1) (clipped to the grid) and
 * hand each cell of [ex0, ex1) x [ez0, ez1) to emit(i, x, z, links) (cell units,
 * NaN and 0 off the paths; with onlyPaths, path cells only). Exact for emitted
 * cells at least WINDOW_PAD inside the window, or at the grid's edge.
 */
function solve(geom, tier, planned, wx0, wz0, wx1, wz1, ex0, ez0, ex1, ez1, emit, onlyPaths = false) {
  const { W, H } = geom;
  wx0 = Math.max(0, wx0); wz0 = Math.max(0, wz0); wx1 = Math.min(W, wx1); wz1 = Math.min(H, wz1);
  const ww = wx1 - wx0, wh = wz1 - wz0;
  if (ww <= 0 || wh <= 0) return;
  ensure(ww * wh);
  const local = (x, z) => (x >= wx0 && z >= wz0 && x < wx1 && z < wz1 ? (z - wz0) * ww + (x - wx0) : -1);
  const list = [];
  const knots = [];
  // 1. Kind, links and seed position of every path cell.
  kind.fill(NONE, 0, ww * wh);
  for (let z = wz0; z < wz1; z++)
    for (let x = wx0, i = z * W + wx0; x < wx1; x++, i++) {
      if (!(tier[i] >= 1)) continue;
      const l = (z - wz0) * ww + (x - wx0);
      knotOf[l] = -1;
      list.push(l);
      kind[l] = isLane(geom, planned, z * W + x) ? LANE : inBlock(geom, tier, x, z) ? AREA : LINE;
      const m = links[l] = linkMask(geom, tier, planned, x, z);
      seedNode(geom, tier, planned, x, z, seedOut);
      p0x[l] = cx[l] = seedOut[0]; p0z[l] = cz[l] = seedOut[1];
      if (kind[l] !== LINE) continue;
      // A line node starts from its cell's centre: the seed's pull toward
      // unlinked diagonal neighbours would bias where its junctions meet.
      cx[l] = x + 0.5; cz[l] = z + 0.5;
      // Within its own cell, or a little into a path cell beside it.
      box[l * 4] = x + (isPathAt(geom, tier, x - 1, z) ? -NODE_MARGIN : NODE_INSET);
      box[l * 4 + 1] = x + 1 + (isPathAt(geom, tier, x + 1, z) ? NODE_MARGIN : -NODE_INSET);
      box[l * 4 + 2] = z + (isPathAt(geom, tier, x, z - 1) ? -NODE_MARGIN : NODE_INSET);
      box[l * 4 + 3] = z + 1 + (isPathAt(geom, tier, x, z + 1) ? NODE_MARGIN : -NODE_INSET);
      diag[l] = (isPathAt(geom, tier, x - 1, z - 1) ? 1 : 0) | (isPathAt(geom, tier, x + 1, z - 1) ? 2 : 0) |
        (isPathAt(geom, tier, x - 1, z + 1) ? 4 : 0) | (isPathAt(geom, tier, x + 1, z + 1) ? 8 : 0);
      let q = 0;
      nb[l * 2] = nb[l * 2 + 1] = -1;
      if (popcount(m) <= 2) for (let d = 0; d < 8 && q < 2; d++) if (m & (1 << d)) nb[l * 2 + q++] = local(x + LINK_DX[d], z + LINK_DZ[d]);
    }
  // 2. Knots among the area cells.
  for (const l of list) {
    if (kind[l] !== AREA || knotOf[l] !== -1) continue;
    const x = wx0 + l % ww, z = wz0 + ((l / ww) | 0);
    const k = knotFrom(geom, tier, planned, x, z);
    if (!k) { knotOf[l] = -2; continue; }
    const id = knots.length;
    knots.push(k);
    let sx = 0, sz = 0;
    for (const i of k.cells) {
      const ix = i % W, iz = (i - ix) / W, m = local(ix, iz);
      if (m >= 0) { kind[m] = KNOT; knotOf[m] = id; }
      seedNode(geom, tier, planned, ix, iz, seedOut);
      sx += seedOut[0]; sz += seedOut[1];
    }
    k.px = sx / k.cells.length; k.pz = sz / k.cells.length;
  }
  // Current position of any cell: solved in the window, else its seed.
  const posX = (x, z) => { const m = local(x, z); if (m >= 0) return cx[m]; seedNode(geom, tier, planned, x, z, seedOut); return seedOut[0]; };
  const posZ = (x, z) => { const m = local(x, z); if (m >= 0) return cz[m]; seedNode(geom, tier, planned, x, z, seedOut); return seedOut[1]; };
  // The meeting point of the arms [from, arm, ...] into a junction now at (jx, jz):
  // the least-squares intersection of the arms' lines, each through its first
  // node along its line (or toward the junction where the arm is no line).
  const meet = (arms, jx, jz, out, members) => {
    let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0, sx = 0, sz = 0, n = 0;
    for (let q = 0; q < arms.length; q += 2) {
      const from = arms[q], a = arms[q + 1];
      const ax = a % W, az = (a - ax) / W;
      const px = posX(ax, az), pz = posZ(ax, az);
      sx += px; sz += pz; n++;
      let dx = px - jx, dz = pz - jz;
      const m = local(ax, az);
      if (m >= 0 && kind[m] === LINE && popcount(links[m]) === 2) {
        for (let d = 0; d < 8; d++) {
          if (!(links[m] & (1 << d))) continue;
          const bx = ax + LINK_DX[d], bz = az + LINK_DZ[d], b = bz * W + bx;
          if (b === from || (members && members.includes(b))) continue;
          dx = px - posX(bx, bz); dz = pz - posZ(bx, bz);
          break;
        }
      }
      const len = Math.hypot(dx, dz);
      if (len < 1e-9) continue;
      dx /= len; dz /= len;
      // (I - d d^T): the squared distance to the arm's line.
      const m00 = 1 - dx * dx, m01 = -dx * dz, m11 = 1 - dz * dz;
      a00 += m00; a01 += m01; a11 += m11;
      b0 += m00 * px + m01 * pz; b1 += m01 * px + m11 * pz;
    }
    const det = a00 * a11 - a01 * a01;
    if (det > 0.05 * n) { out[0] = (a11 * b0 - a01 * b1) / det; out[1] = (a00 * b1 - a01 * b0) / det; }
    else { out[0] = sx / n; out[1] = sz / n; }
  };
  const armsOf = (x, z, m) => {
    const arms = [], i = z * W + x;
    for (let d = 0; d < 8; d++) if (m & (1 << d)) arms.push(i, (z + LINK_DZ[d]) * W + x + LINK_DX[d]);
    return arms;
  };
  const point = new Float64Array(2);
  // 3. Smoothing rounds (each from the last round's positions only).
  for (let it = 0; it < RELAX_ITER; it++) {
    for (const k of knots) {
      meet(k.arms, k.px, k.pz, point, k.cells);
      k.nx = Math.min(k.x1 + 1, Math.max(k.x0, point[0]));
      k.nz = Math.min(k.z1 + 1, Math.max(k.z0, point[1]));
    }
    for (const l of list) {
      const t = kind[l];
      if (t === KNOT) { const k = knots[knotOf[l]]; nx[l] = k.nx; nz[l] = k.nz; continue; }
      if (t !== LINE) { nx[l] = p0x[l]; nz[l] = p0z[l]; continue; }
      const x = wx0 + l % ww, z = wz0 + ((l / ww) | 0), m = links[l], deg = popcount(m);
      let px = cx[l], pz = cz[l];
      if (deg === 0) { px = p0x[l]; pz = p0z[l]; }
      else if (deg === 2) {
        const a = nb[l * 2], b = nb[l * 2 + 1];
        let sx, sz;
        if (a >= 0 && b >= 0) { sx = cx[a] + cx[b]; sz = cz[a] + cz[b]; }
        else {
          sx = 0; sz = 0;
          for (let d = 0; d < 8; d++) if (m & (1 << d)) { sx += posX(x + LINK_DX[d], z + LINK_DZ[d]); sz += posZ(x + LINK_DX[d], z + LINK_DZ[d]); }
        }
        px += (sx / 2 - px) * LINE_PULL; pz += (sz / 2 - pz) * LINE_PULL;
      } else if (deg === 1) {
        if (END_PULL) {
          const a = nb[l * 2];
          const sx = a >= 0 ? cx[a] : posX(x + LINK_DX[31 - Math.clz32(m)], z + LINK_DZ[31 - Math.clz32(m)]);
          const sz = a >= 0 ? cz[a] : posZ(x + LINK_DX[31 - Math.clz32(m)], z + LINK_DZ[31 - Math.clz32(m)]);
          px += (sx - px) * END_PULL; pz += (sz - pz) * END_PULL;
        }
      } else {
        meet(armsOf(x, z, m), px, pz, point, null);
        px = point[0]; pz = point[1];
      }
      const lo = box[l * 4], hi = box[l * 4 + 1], lz = box[l * 4 + 2], hz = box[l * 4 + 3];
      px = px < lo ? lo : px > hi ? hi : px;
      pz = pz < lz ? lz : pz > hz ? hz : pz;
      // Into a margin on both axes is into the diagonal neighbour: only if that is a path too.
      const ox = px < x ? px - x : px > x + 1 ? px - x - 1 : 0, oz = pz < z ? pz - z : pz > z + 1 ? pz - z - 1 : 0;
      if (ox && oz && !(diag[l] & (1 << ((ox > 0 ? 1 : 0) + (oz > 0 ? 2 : 0))))) {
        if (Math.abs(ox) < Math.abs(oz)) px -= ox; else pz -= oz;
      }
      nx[l] = px; nz[l] = pz;
    }
    for (const k of knots) { k.px = k.nx; k.pz = k.nz; }
    for (const l of list) { cx[l] = nx[l]; cz[l] = nz[l]; }
  }
  // 4. Out.
  if (onlyPaths) {
    for (const l of list) {
      const x = wx0 + l % ww, z = wz0 + ((l / ww) | 0);
      if (x >= ex0 && x < ex1 && z >= ez0 && z < ez1) emit(z * W + x, cx[l], cz[l], links[l]);
    }
    return;
  }
  for (let z = Math.max(ez0, wz0); z < Math.min(ez1, wz1); z++)
    for (let x = Math.max(ex0, wx0); x < Math.min(ex1, wx1); x++) {
      const l = (z - wz0) * ww + (x - wx0);
      if (kind[l] === NONE) emit(z * W + x, NaN, NaN, 0);
      else emit(z * W + x, cx[l], cz[l], links[l]);
    }
}

// ---------------------------------------------------------------- fields

/**
 * Node field in cell units: {x, z: Float32Array (NaN off the paths), links: Uint8Array}.
 */
export function buildNodeField(geom, tier, planned) {
  const N = geom.W * geom.H;
  const field = { x: new Float32Array(N).fill(NaN), z: new Float32Array(N).fill(NaN), links: new Uint8Array(N) };
  solve(geom, tier, planned, 0, 0, geom.W, geom.H, 0, 0, geom.W, geom.H, (i, x, z, m) => {
    field.x[i] = x; field.z[i] = z; field.links[i] = m;
  }, true);
  return field;
}

// Windows for a set of changed cells: nearby changes share one window. Returns
// null when one solve of the whole grid is cheaper.
function windows(geom, dirty) {
  const span = 2 * NODE_REACH;
  const boxes = [];
  for (const i of [...dirty].sort((a, b) => a - b)) {
    const x = i % geom.W, z = (i - x) / geom.W;
    let box = boxes.find(b => Math.max(b.x1, x) - Math.min(b.x0, x) <= span && Math.max(b.z1, z) - Math.min(b.z0, z) <= span);
    if (!box) boxes.push(box = { x0: x, z0: z, x1: x, z1: z });
    box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x); box.z0 = Math.min(box.z0, z); box.z1 = Math.max(box.z1, z);
  }
  const pad = NODE_REACH + WINDOW_PAD;
  let area = 0;
  for (const b of boxes) area += (b.x1 - b.x0 + 1 + 2 * pad) * (b.z1 - b.z0 + 1 + 2 * pad);
  return area > geom.W * geom.H / 2 ? null : boxes;
}

/**
 * Bring `emit`'s target up to date after the cells in `dirty` changed tier, lane
 * or planned flags: every cell a change can move is emitted again, exactly as a
 * fresh build would give it.
 */
export function patchNodeCells(geom, tier, planned, dirty, emit) {
  if (!dirty.size) return;
  const boxes = windows(geom, dirty);
  if (!boxes) { solve(geom, tier, planned, 0, 0, geom.W, geom.H, 0, 0, geom.W, geom.H, emit); return; }
  const R = NODE_REACH, P = NODE_REACH + WINDOW_PAD;
  for (const b of boxes) solve(geom, tier, planned, b.x0 - P, b.z0 - P, b.x1 + 1 + P, b.z1 + 1 + P, b.x0 - R, b.z0 - R, b.x1 + 1 + R, b.z1 + 1 + R, emit);
}

/** Patch a node field (cell units) in place; returns the cells whose node or links changed. */
export function patchNodeField(geom, tier, planned, field, dirty) {
  const changed = [];
  patchNodeCells(geom, tier, planned, dirty, (i, x, z, m) => {
    const fx = Math.fround(x), fz = Math.fround(z);
    if (Object.is(field.x[i], fx) && Object.is(field.z[i], fz) && field.links[i] === m) return;
    field.x[i] = fx; field.z[i] = fz; field.links[i] = m;
    changed.push(i);
  });
  return changed;
}

// ---------------------------------------------------------------- world units (nav grids)

// World position of a node; the cell-unit position is rounded to float32 first,
// as the renderer stores it.
function writeWorld(geom, nodes, i, x, z, m) {
  nodes.nodeX[i] = x === x ? geom.ox + Math.fround(x) * geom.cell : NaN;
  nodes.nodeZ[i] = z === z ? geom.oz + Math.fround(z) * geom.cell : NaN;
  nodes.nodeLinks[i] = m;
}

/**
 * Node positions in world units for a whole grid: {nodeX, nodeZ: Float32Array
 * (NaN where the cell is not a path), nodeLinks: Uint8Array (link masks)}.
 */
export function buildNodes(geom, tier, planned) {
  const N = geom.W * geom.H;
  const nodes = { nodeX: new Float32Array(N).fill(NaN), nodeZ: new Float32Array(N).fill(NaN), nodeLinks: new Uint8Array(N) };
  solve(geom, tier, planned, 0, 0, geom.W, geom.H, 0, 0, geom.W, geom.H, (i, x, z, m) => writeWorld(geom, nodes, i, x, z, m), true);
  return nodes;
}

/** Patch world-unit nodes ({nodeX, nodeZ, nodeLinks}) in place after the cells in `dirty` changed. */
export function patchNodes(geom, tier, planned, nodes, dirty) {
  patchNodeCells(geom, tier, planned, dirty, (i, x, z, m) => writeWorld(geom, nodes, i, x, z, m));
}
