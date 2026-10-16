// The path field: worn paths drawn as continuous strips, not cell blobs.
//
// The road grid is coarse (2-unit cells) and A* paths on it step in 45-degree
// staircases, so sampling tiers straight from the grid gives beads, blots and
// ragged widths. Here every path cell (tier >= 1) becomes a node, placed and
// linked to its neighbours by path-nodes.js (a staircase relaxes into a straight
// diagonal, a junction of trails meets at one point, two parallel braids close
// into one lane), and each node and each link is drawn as a round-capped
// capsule into a finer texture (K texels per cell). Walkers route along the
// same nodes and links.
//
// Each texel stores, in R, the signed distance to the nearest strip's edge,
// encoded 0..1 (0.5 is the edge, >0.5 inside), and in G the tier of the strip
// it belongs to (tier * 51). A distance field filters linearly, so edges stay
// smooth and straight between texels; the terrain shader adds a little noise
// for an organic edge.
//
// Width follows the hierarchy: a trail is a narrow line, a track a lane, a road
// a broad gravel way, paving a little broader still. Paving follows the worn
// roads it was laid on, so it is smoothed like them: a paved line runs straight
// along a diagonal or a curve, and a paved square or yard keeps its straight
// sides (every edge cell moves alike) with rounded corners. Within a tier,
// busier cells are a touch wider. Lone worn cells draw no strip (they stay
// bare dirt).
//
// Towpaths, quays and waterfront aprons (towpath cells, laid in a band two or
// three cells deep along the bank) follow the river instead: each such node
// sits on one line a fixed distance from the water's edge at its own z, so the
// band draws as a single lane of even width that curves with the bank, not a
// staircase of filled cells. Trails and roads that meet it link to that line.
//
// Work is incremental: a key per cell (tier and wear bucket) is compared with
// the last build; the nodes a change can move are patched, and only the tiles
// near changed cells and moved nodes are redrawn.

import { buildNodeField, patchNodeField, isLane as laneAt, LINK_DX, LINK_DZ, TOW_BANK } from '../path-nodes.js';

export { TOW_BANK };

export const PATH_K = 4;              // texels per road cell
export const PATH_TILE = 8;           // cells per tile side
export const PATH_RANGE = 1.25;       // world units encoded on each side of an edge
// Half-widths (world units) per tier: grass, trail, track, road, paved, avenue.
export const PATH_HALF = [0, 0.5, 0.82, 1.2, 1.3, 1.55];
// Planned cells are never narrower than a cell, so paved areas stay solid.
const PLANNED = 1;
const PLANNED_HALF = 1.08;
// Towpath lane: centre TOW_BANK from the water's edge (see path-nodes.js),
// half-width by tier (track, gravel, paved promenade). Towpath cells further
// than TOW_REACH from the river (none are laid so) keep the planned fill.
const TOW_HALF = [0, 1.0, 1.1, 1.2, 1.35, 1.45];
const MARGIN = 4;                     // cells of influence around a node (it may sit off its cell)
const SQRT2 = Math.SQRT2;
const NODE_BITS = 0xe0;               // the key bits path-nodes depends on: path, planned, lane
const BAND_LO = [0, 60, 300, 1200, 1200, 1200];
const BAND_HI = [1, 300, 1200, 3000, 3000, 3000];

/** Wear bucket 0..2 within a tier's band (wider when busier). */
export function wearBucket(tier, wear) {
  if (tier >= 4) return 1;
  const f = (wear - BAND_LO[tier]) / (BAND_HI[tier] - BAND_LO[tier]);
  return f < 0.33 ? 0 : f < 0.66 ? 1 : 2;
}

export function halfWidth(tier, bucket) {
  return PATH_HALF[tier] * (0.88 + 0.12 * bucket);
}

/**
 * createPathField({W, H, cell, ox, oz}) -> {data, TW, TH, update(roads, budget) -> rows|null}
 * data: Uint8Array(TW * TH * 2), RG per texel. ox, oz: the grid's world origin.
 */
export function createPathField({ W, H, cell, ox = 0, oz = 0 }) {
  const K = PATH_K;
  const TW = W * K, TH = H * K;
  const s = cell / K;                  // texel size in world units
  const data = new Uint8Array(TW * TH * 2);
  const key = new Uint8Array(W * H);   // last drawn key per cell (0 = no node)
  const tilesX = Math.ceil(W / PATH_TILE), tilesZ = Math.ceil(H / PATH_TILE);
  const dirtyTiles = new Uint8Array(tilesX * tilesZ);
  const queue = [];
  // Node positions (cell units, centre = +0.5) and link masks, from path-nodes.js.
  let nodes = null;
  let tierRef = null;
  const geom = { W, H, cell, ox, oz };
  const nodeDirty = new Set();

  const isPlanned = (roads, i) => roads.planned ? (roads.planned[i] & PLANNED) !== 0 : false;

  // A towpath cell by the river: its node goes on the bank-following lane.
  const isLane = (roads, i) => laneAt(geom, roads.planned, i);

  function nodeKey(roads, i) {
    const t = roads.tier[i];
    if (!t) return 0;
    return 0x80 | (isPlanned(roads, i) ? 0x40 : 0) | (isLane(roads, i) ? 0x20 : 0) | (t << 2) | wearBucket(t, roads.wear[i]);
  }

  function nodeHalf(roads, i) {
    const t = roads.tier[i];
    if (isLane(roads, i)) return TOW_HALF[t];
    const h = halfWidth(t, wearBucket(t, roads.wear[i]));
    return isPlanned(roads, i) ? Math.max(h, PLANNED_HALF) : h;
  }

  function markTilesAround(cx, cz) {
    const tx0 = Math.max(0, Math.floor((cx - MARGIN) / PATH_TILE)), tx1 = Math.min(tilesX - 1, Math.floor((cx + MARGIN) / PATH_TILE));
    const tz0 = Math.max(0, Math.floor((cz - MARGIN) / PATH_TILE)), tz1 = Math.min(tilesZ - 1, Math.floor((cz + MARGIN) / PATH_TILE));
    for (let tz = tz0; tz <= tz1; tz++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = tz * tilesX + tx;
        if (!dirtyTiles[t]) { dirtyTiles[t] = 1; queue.push(t); }
      }
  }

  /** Compare every cell with the last build; queue the tiles that changed. */
  function scan(roads) {
    const n = W * H;
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const k = nodeKey(roads, i);
      if (k === key[i]) continue;
      if ((k & NODE_BITS) !== (key[i] & NODE_BITS)) nodeDirty.add(i);
      key[i] = k;
      changed++;
      markTilesAround(i % W, (i / W) | 0);
    }
    return changed;
  }

  // Bring the nodes up to date with the cells the last scan found changed.
  function syncNodes(roads) {
    if (!nodes) {
      nodes = buildNodeField(geom, roads.tier, roads.planned);
    } else if (nodeDirty.size) {
      for (const i of patchNodeField(geom, roads.tier, roads.planned, nodes, nodeDirty)) markTilesAround(i % W, (i / W) | 0);
    }
    nodeDirty.clear();
  }

  // Each tile is drawn into a scratch frame with an apron of APRON texels, so
  // the interior pass below sees the boundary just beyond the tile.
  const APRON = 5;
  const SW = PATH_TILE * K + 2 * APRON;
  const sv = new Float32Array(SW * SW);     // signed distance inside an edge (world units)
  const st = new Uint8Array(SW * SW);       // tier of that strip
  const dist = new Float32Array(SW * SW);   // chamfer distance to outside (texels)
  let fx0 = 0, fz0 = 0;                     // frame origin in texels

  // Draw a capsule (a..b in cell units, half-width hw in world units) into
  // the scratch frame: per texel, the furthest inside any strip wins.
  function capsule(ax, az, bx, bz, hw, tier) {
    const reach = (hw + PATH_RANGE) / s;            // texels
    const Ax = ax * K - fx0, Az = az * K - fz0, Bx = bx * K - fx0, Bz = bz * K - fz0;   // frame texels
    const lx = Math.max(0, Math.floor(Math.min(Ax, Bx) - reach)), hx = Math.min(SW - 1, Math.ceil(Math.max(Ax, Bx) + reach));
    const lz = Math.max(0, Math.floor(Math.min(Az, Bz) - reach)), hz = Math.min(SW - 1, Math.ceil(Math.max(Az, Bz) + reach));
    if (lx > hx || lz > hz) return;
    const dx = Bx - Ax, dz = Bz - Az;
    const len2 = dx * dx + dz * dz;
    const inv = len2 > 1e-9 ? 1 / len2 : 0;
    for (let z = lz; z <= hz; z++) {
      const pz = z + 0.5 - Az;
      let o = z * SW + lx;
      for (let x = lx; x <= hx; x++, o++) {
        const px = x + 0.5 - Ax;
        let t = (px * dx + pz * dz) * inv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - dx * t, ez = pz - dz * t;
        const v = hw - Math.sqrt(ex * ex + ez * ez) * s;     // world units inside the edge
        const cur = sv[o];
        if (v > cur + 0.004 || (v >= cur - 0.004 && tier > st[o])) {
          sv[o] = v;
          st[o] = tier;
        }
      }
    }
  }

  // The capsules' field is a true distance near an edge but not deep inside
  // a wide area (a yard, a paved block): there it dips between the rows of
  // cells. A chamfer distance to the nearest outside texel, less a little
  // slack so edges keep the capsules' smooth shape, fills those dips.
  const SLACK = 0.35;
  function fillInterior() {
    const D = SQRT2;
    for (let i = 0; i < SW * SW; i++) dist[i] = sv[i] > 0 ? 1e6 : 0;
    for (let z = 0; z < SW; z++)
      for (let x = 0; x < SW; x++) {
        const i = z * SW + x;
        let d = dist[i];
        if (!d) continue;
        if (x > 0) d = Math.min(d, dist[i - 1] + 1);
        if (z > 0) {
          d = Math.min(d, dist[i - SW] + 1);
          if (x > 0) d = Math.min(d, dist[i - SW - 1] + D);
          if (x < SW - 1) d = Math.min(d, dist[i - SW + 1] + D);
        }
        dist[i] = d;
      }
    for (let z = SW - 1; z >= 0; z--)
      for (let x = SW - 1; x >= 0; x--) {
        const i = z * SW + x;
        let d = dist[i];
        if (!d) continue;
        if (x < SW - 1) d = Math.min(d, dist[i + 1] + 1);
        if (z < SW - 1) {
          d = Math.min(d, dist[i + SW] + 1);
          if (x < SW - 1) d = Math.min(d, dist[i + SW + 1] + D);
          if (x > 0) d = Math.min(d, dist[i + SW - 1] + D);
        }
        dist[i] = d;
        const deep = (d - 0.5) * s - SLACK;
        if (deep > sv[i]) sv[i] = Math.min(deep, PATH_RANGE);
      }
  }

  function drawTile(roads, t) {
    const tier = roads.tier;
    const tx = t % tilesX, tz = (t / tilesX) | 0;
    const cx0 = tx * PATH_TILE, cz0 = tz * PATH_TILE;
    const cx1 = Math.min(W, cx0 + PATH_TILE), cz1 = Math.min(H, cz0 + PATH_TILE);
    const x0 = cx0 * K, z0 = cz0 * K, x1 = cx1 * K, z1 = cz1 * K;
    fx0 = x0 - APRON; fz0 = z0 - APRON;
    sv.fill(-PATH_RANGE);
    st.fill(0);
    const nx = nodes.x, nz = nodes.z, nl = nodes.links;
    const ax0 = Math.max(0, cx0 - MARGIN), az0 = Math.max(0, cz0 - MARGIN);
    const ax1 = Math.min(W - 1, cx1 - 1 + MARGIN), az1 = Math.min(H - 1, cz1 - 1 + MARGIN);
    for (let z = az0; z <= az1; z++) {
      for (let x = ax0; x <= ax1; x++) {
        const i = z * W + x;
        const ti = tier[i];
        const links = nl[i];
        if (!ti || !links) continue;   // a lone worn cell draws no strip
        const hi = nodeHalf(roads, i);
        // Forward links only (directions 4..7: east and the row below), so each
        // pair is drawn once per tile pass.
        for (let d = 4; d < 8; d++) {
          if (!(links & (1 << d))) continue;
          const j = (z + LINK_DZ[d]) * W + x + LINK_DX[d];
          const tj = tier[j];
          const hj = nodeHalf(roads, j);
          const hw = ti === tj ? (hi + hj) / 2 : ti < tj ? hi : hj;
          capsule(nx[i], nz[i], nx[j], nz[j], hw, Math.min(ti, tj));
        }
        capsule(nx[i], nz[i], nx[i], nz[i], hi, ti);
      }
    }
    fillInterior();
    // Encode the tile (the apron was only for context).
    const scale = 255 / (2 * PATH_RANGE);
    for (let z = z0; z < z1; z++) {
      let o = (z * TW + x0) * 2;
      let f = (z - fz0) * SW + (x0 - fx0);
      for (let x = x0; x < x1; x++, o += 2, f++) {
        const v = 127.5 + sv[f] * scale;
        data[o] = v <= 0 ? 0 : v >= 255 ? 255 : v;
        data[o + 1] = data[o] ? st[f] * 51 : 0;
      }
    }
    return { z0, z1, x0, x1 };
  }

  /**
   * Bring the field up to date with roads. Redraws at most `budget` tiles
   * (Infinity for all). Returns the texel row ranges touched as
   * [{x0, x1, z0, z1}], an empty list if nothing changed.
   */
  function update(roads, budget = Infinity) {
    if (roads.tier !== tierRef) {
      // A new road grid (load, migration): rebuild from nothing.
      tierRef = roads.tier;
      nodes = null;
      key.fill(0);
      data.fill(0);
      dirtyTiles.fill(0);
      queue.length = 0;
    }
    scan(roads);
    syncNodes(roads);
    const rects = [];
    let done = 0;
    let head = 0;
    while (head < queue.length && done < budget) {
      const t = queue[head++];
      dirtyTiles[t] = 0;
      rects.push(drawTile(roads, t));
      done++;
    }
    queue.splice(0, head);
    return rects;
  }

  return { data, TW, TH, update, pending: () => queue.length };
}
