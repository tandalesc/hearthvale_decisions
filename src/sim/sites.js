// Lots and candidate building sites. proposeSites() scores places next to the
// paths people already walk, so settlement follows the wear field (§6.4, §7.1).
import { rng } from './rng.js';
import { decide } from './hooks.js';
import { policyModifiers } from './policies.js';
import { riverX, bankDistance, bankSide, heightAt, FORDS, WATER_HALF, nearestWaterKind, waterKindAt, KIND, riverOpenAt, floodDepthAt, hasRiver } from '../terrain.js';
import { centrePeakValue, nearestCentre, centreBias, corePull } from './centres.js';
import {
  CELL, GRID_W, GRID_H, CELLS, ROT_DIR, ORIGIN_X, ORIGIN_Z,
  cellIndex, cellXZ, cellCenter, cellOf, terrainGrid, footprints, wearNorm, buildingCells, frontCell, NAV_MAX_SLOPE, NAV_MAX_HEIGHT,
} from './roads.js';

// Lot sizes in cells [frontage, depth] by type and tier (index tier - 1).
export const LOT_SIZES = {
  home: [[2, 2], [2, 2], [2, 3], [3, 3], [4, 4]],
  farm: [[6, 6]],
  mill: [[5, 4]],
  workshop: [[3, 3], [3, 3], [4, 4]],
  factory: [[4, 5]],
  shop: [[2, 2], [2, 3], [3, 4]],
  market: [[4, 4]],
  inn: [[3, 3], [3, 3], [4, 4]],
  warehouse: [[3, 4]],
  chapel: [[3, 4], [4, 5], [5, 7]],
  school: [[3, 3], [4, 4]],
  moot: [[3, 3], [4, 4], [5, 5]],
  park: [[4, 4], [6, 6]],
  infirmary: [[3, 3], [4, 5]],
  watch: [[2, 2]],
  exchange: [[4, 4]],
  theatre: [[3, 4]],
  quay: [[3, 2]],
  quarry: [[4, 4]],
  monument: [[2, 2]],
  'union-hall': [[3, 3]],
  library: [[3, 3]],
  bathhouse: [[3, 3]],
};

const WATER_TYPES = new Set(['mill', 'quay']);
const RIVER_LIKES = new Set(['warehouse', 'quay', 'mill']);
const FLAT_TYPES = { farm: 0.08, market: 0.12, park: 0.15 };
// Pits and quarries go where the rock shows: on slopes and hills.
export const HILL_WORKS = new Set(['coal-pit', 'clay-pit', 'kiln', 'quarry']);

// Steepest lot allowed (height change per unit across the lot). Early
// builders keep to gentle ground; from the Town era terraced rows step up
// moderate slopes; pits and quarries take rough ground in any era.
export function maxSlopeFor(type, era, hillWork = false) {
  if (hillWork) return 0.6;
  if (FLAT_TYPES[type] != null) return FLAT_TYPES[type];
  return era >= 2 ? 0.4 : 0.2;
}

// How far a point stands above the ground 20 units around it, 0..1 (8 units
// or more counts as a real hilltop).
export function prominenceAt(p) {
  const h = heightAt(p.x, p.z);
  const around = (heightAt(p.x + 20, p.z) + heightAt(p.x - 20, p.z) + heightAt(p.x, p.z + 20) + heightAt(p.x, p.z - 20)) / 4;
  return Math.max(0, Math.min(1, (h - around) / 8));
}

// Farms belong at the edge of town: dear, crowded land counts against them
// (cancelling the usual pull of land value), open edges for them.
function farmEdgeBias(state, terms, mx, mz) {
  const { centroid, radius } = buildingBins(state);
  const p = cellCenter(cellIndex(mx, mz));
  const edge = radius > 0 ? Math.min(1, Math.hypot(p.x - centroid.x, p.z - centroid.z) / (radius + 20)) : 0.5;
  return -2.2 * terms.landValue - 1.5 * localDensity(state, mx, mz, 10) + 0.8 * edge;
}

// Moving out: cheaper land counts for a lot, a fresh start in another centre
// helps, and the old neighbourhood is no use.
function relocationBias(state, need, terms, p) {
  const from = need.from;
  if (from && Math.hypot(p.x - from.x, p.z - from.z) < 40) return -5;
  const here = from ? nearestCentre(state, from.x, from.z).centre : null;
  const there = nearestCentre(state, p.x, p.z).centre;
  return -1.5 * terms.landValue + (here && there && here.id !== there.id ? 0.5 : 0);
}

// Land given up by a farm or a workshop goes back to building: lots on it
// get a pull for VACATED_YEARS years (state.vacated: [{cx, cz, w, h, year}]).
export const VACATED_YEARS = 15;

function vacatedBias(state, lot) {
  const year = state.time?.year ?? 0;
  for (const v of state.vacated ?? []) {
    if (year - v.year > VACATED_YEARS) continue;
    if (lot.cx < v.cx + v.w && lot.cx + lot.w > v.cx && lot.cz < v.cz + v.h && lot.cz + lot.h > v.cz) return 0.4;
  }
  return 0;
}

export function recordVacated(state, rect) {
  const year = state.time?.year ?? 0;
  state.vacated = (state.vacated ?? []).filter(v => year - v.year <= VACATED_YEARS);
  state.vacated.push({ cx: rect.cx, cz: rect.cz, w: rect.w, h: rect.h, year });
}

// Candidate sites for a business that has to move (rising rents): cheaper
// districts, the town edge or another centre, scored for its type (farms:
// open flat land at the edge; workshops: labour and roads; warehouses: the
// water or a road).
export function relocationSites(state, enterprise, { count = 4 } = {}) {
  const b = (state.buildings ?? []).find(x => x.id === enterprise.buildingId);
  const type = b?.type ?? enterprise.type;
  return proposeSites(state, { type, tier: b?.tier ?? 1, count, relocate: true, from: b ? { x: b.x, z: b.z } : null });
}

function hillBias(type, hillWork, slope, prominence) {
  if (hillWork) return 1.0 * Math.min(1, slope / 0.3) + 0.5 * prominence;
  if (type === 'chapel') return 0.8 * prominence;
  return 0;
}
const SMOKY = new Set(['mill', 'factory', 'workshop']);
const LANDMARKS = { market: 18, exchange: 22, chapel: 14, moot: 12, monument: 16, theatre: 10 };
export const LV_MAX = 60;
const FRONTIER_RADIUS = 30;
const MAX_ANCHORS = 600;
const MIN_APART = 6;

export function lotSize(type, tier = 1) {
  const sizes = LOT_SIZES[type] ?? [[3, 3]];
  return sizes[Math.min(sizes.length, Math.max(1, tier)) - 1];
}

// ---------------------------------------------------------------- density

const DENSITY = [0.3, 0.4, 0.6, 0.75, 0.85, 0.95];
const DENSITY_BIAS = { garden: 0.7, commune: 0.8, port: 1.1, exchange: 1.1 };

export function targetDensity(era, archetype) {
  const base = DENSITY[Math.max(0, Math.min(5, era | 0))];
  return Math.min(1, base * (DENSITY_BIAS[archetype] ?? 1));
}

// The town's density target with the zoning rules applied: zoningDensity caps
// it, densityPush raises it.
export function densityTarget(state) {
  const mods = policyModifiers(state);
  let t = targetDensity(state.era ?? 0, state.archetype) + mods.sum('densityPush');
  const cap = mods.sum('zoningDensity');
  if (cap > 0) t = Math.min(t, cap);
  return Math.max(0.1, Math.min(1, t));
}

// ---------------------------------------------------------------- banks

// Ordinary buildings keep SETBACK units between every part of their footprint
// (plus FOOTPRINT_MARGIN) and the water's edge; on embanked stretches only
// EMBANKED_SETBACK. Waterfront types may sit on the bank and overhang the
// water by up to OVERHANG units.
export const SETBACK = 3;
export const EMBANKED_SETBACK = 1;
export const OVERHANG = 2;
// Waterfront buildings leave this much walkable apron (towpath) between their
// walls and the water.
export const APRON = 2.2;
export const FOOTPRINT_MARGIN = 1;
export const WATERFRONT = new Set(['mill', 'quay', 'warehouse', 'boathouse']);
// The floodplain (terrain.js floodDepthAt): homes and most buildings keep off
// ground a great flood covers more than FLOOD_BAR deep, and shun shallower
// flooding; fields, parks and the trades that need the water do not mind.
// An embankment protects the ground behind it.
export const FLOOD_BAR = 0.3;
export const FLOOD_TOLERANT = new Set(['farm', 'park', 'bridge', 'mill', 'quay', 'warehouse', 'boathouse']);

/** How deep a great flood would stand at (x, z), embankments considered (m). */
export function floodAt(state, x, z) {
  const i = cellOf(x, z);
  const d = i < 0 ? 0 : terrainGrid().flood[i];
  return d > 0 && isEmbanked(state, x, z) ? 0 : d;
}

function footprintFlood(state, rect) {
  let worst = 0;
  sampleRect(rect, 0, (x, z) => { worst = Math.max(worst, floodAt(state, x, z)); });
  return worst;
}

function embankRow(z) { return Math.max(0, Math.min(GRID_H - 1, Math.floor((z - ORIGIN_X) / CELL))); }

// Embanked stretches: state.roads.embanked is one byte per grid row, bit 1
// for the west bank and bit 2 for the east bank. Only the river is embanked:
// a lake, pond or sea shore in the same row is not.
export function isEmbanked(state, x, z) {
  const e = state.roads?.embanked;
  return !!e && (e[embankRow(z)] & (bankSide(x, z) ? 2 : 1)) !== 0 && nearestWaterKind(x, z) === KIND.RIVER;
}

export function setbackAt(state, x, z) { return isEmbanked(state, x, z) ? EMBANKED_SETBACK : SETBACK; }

// Samples a world rectangle {x, z, w, d} (already axis-aligned after rot) at
// about one unit. minBank/nearest include the margin; minBankCore,
// maxH and minH are for the footprint itself.
export function footprintBank(rect, margin = FOOTPRINT_MARGIN) {
  const out = { minBank: Infinity, minBankCore: Infinity, nearest: { x: rect.x, z: rect.z }, maxH: -Infinity, minH: Infinity };
  sampleRect(rect, margin, (x, z) => {
    const bank = bankDistance(x, z);
    if (bank < out.minBank) { out.minBank = bank; out.nearest = { x, z }; }
  });
  sampleRect(rect, 0, (x, z) => {
    const bank = bankDistance(x, z);
    if (bank < out.minBankCore) out.minBankCore = bank;
    const h = heightAt(x, z);
    if (h > out.maxH) out.maxH = h;
    if (h < out.minH) out.minH = h;
  });
  return out;
}

// Calls fn(x, z) on a grid of about one unit over the rectangle grown by
// margin, edges and corners included.
function sampleRect(rect, margin, fn) {
  const hw = rect.w / 2 + margin, hd = rect.d / 2 + margin;
  const nx = Math.max(1, Math.ceil(hw * 2)), nz = Math.max(1, Math.ceil(hd * 2));
  for (let a = 0; a <= nx; a++)
    for (let b = 0; b <= nz; b++) fn(rect.x - hw + (2 * hw * a) / nx, rect.z - hd + (2 * hd * b) / nz);
}

// Quick test that a rectangle is far enough from the river to skip sampling.
function farFromRiver(rect) {
  return bankDistance(rect.x, rect.z) - Math.hypot(rect.w, rect.d) / 2 - FOOTPRINT_MARGIN > SETBACK + 1;
}

// Is this footprint allowed here for this type?
export function riverClear(state, rect, type) {
  if (WATER_TYPES.has(type)) {
    // Mills and quays stand right by the water, behind a walkable apron.
    // Both need the river itself (flowing water), not a lake or the sea.
    const fb = footprintBank(rect, 0);
    return fb.minBankCore >= APRON && fb.minBankCore <= APRON + 3 && nearestWaterKind(fb.nearest.x, fb.nearest.z) === KIND.RIVER;
  }
  if (!FLOOD_TOLERANT.has(type) && footprintFlood(state, rect) > FLOOD_BAR) return false;
  if (farFromRiver(rect)) return true;
  const fb = footprintBank(rect);
  if (WATERFRONT.has(type)) return fb.minBankCore >= APRON;
  return fb.minBank >= setbackAt(state, fb.nearest.x, fb.nearest.z);
}

// Floods reach buildings within 6 units of the water; embankments cut the risk.
// Version-2 valleys: anything on the floodplain, by how deep a flood stands there.
export function floodRisk(state, b) {
  if (terrainGrid().floods) {
    const d = terrainGrid().flood[cellOf(b.x, b.z)] ?? 0;
    if (d <= 0) return 0;
    return Math.min(1, 0.3 + d) * (isEmbanked(state, b.x, b.z) ? 0.3 : 1);
  }
  const bank = b.bankDistance ?? bankDistance(b.x, b.z);
  if (bank >= 6) return 0;
  return isEmbanked(state, b.x, b.z) ? 0.3 : 1;
}

// ---------------------------------------------------------------- lot occupancy

const lotCache = new WeakMap();

// Per-cell lot id + 1 (0 = free). Transient, rebuilt when lots change.
export function lotGrid(state) {
  const lots = state.lots ?? [];
  const key = `${lots.length}:${state.lotsRev ?? 0}`;
  let g = lotCache.get(state);
  if (g && g.key === key) return g;
  g = { key, cells: new Int32Array(CELLS) };
  for (const lot of lots) fillLot(g.cells, lot, lot.id + 1);
  lotCache.set(state, g);
  return g;
}

function fillLot(cells, lot, value) {
  for (let z = lot.cz; z < lot.cz + lot.h; z++)
    for (let x = lot.cx; x < lot.cx + lot.w; x++) {
      const j = cellIndex(x, z);
      if (j >= 0) cells[j] = value;
    }
}

// ---------------------------------------------------------------- spatial bins

const binCache = new WeakMap();
const BIN = 8;
const BINS_W = Math.ceil(GRID_W / BIN);

// Buildings bucketed by 8-cell bins, plus the town centroid and built radius.
export function buildingBins(state) {
  const key = `${state.buildingsRev ?? 0}:${state.buildings?.length ?? 0}`;
  let b = binCache.get(state);
  if (b && b.key === key) return b;
  const bins = new Map();
  let sx = 0, sz = 0, n = 0;
  for (const bd of state.buildings ?? []) {
    const [cx, cz] = worldToCell(bd.x, bd.z);
    const k = Math.floor(cz / BIN) * BINS_W + Math.floor(cx / BIN);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(bd);
    if (bd.type !== 'farm' && bd.type !== 'bridge') { sx += bd.x; sz += bd.z; n++; }
  }
  const centroid = n ? { x: sx / n, z: sz / n } : { x: 0, z: 0 };
  let radius = 0;
  for (const bd of state.buildings ?? []) {
    if (bd.type === 'farm' || bd.type === 'bridge') continue;
    radius = Math.max(radius, Math.hypot(bd.x - centroid.x, bd.z - centroid.z));
  }
  b = { key, bins, centroid, radius, count: n };
  binCache.set(state, b);
  return b;
}

export function worldToCell(x, z) {
  return [Math.floor((x - ORIGIN_X) / CELL), Math.floor((z - ORIGIN_X) / CELL)];
}

// Buildings whose centre lies within `rad` cells of (cx, cz).
export function buildingsNear(state, cx, cz, rad) {
  const { bins } = buildingBins(state);
  const out = [];
  const b0x = Math.floor((cx - rad) / BIN), b1x = Math.floor((cx + rad) / BIN);
  const b0z = Math.floor((cz - rad) / BIN), b1z = Math.floor((cz + rad) / BIN);
  const r2 = (rad * CELL) ** 2;
  const { x, z } = cellCenter(cellIndex(Math.max(0, Math.min(GRID_W - 1, cx)), Math.max(0, Math.min(GRID_H - 1, cz))));
  for (let bz = b0z; bz <= b1z; bz++)
    for (let bx = b0x; bx <= b1x; bx++) {
      for (const bd of bins.get(bz * BINS_W + bx) ?? []) {
        if ((bd.x - x) ** 2 + (bd.z - z) ** 2 <= r2) out.push(bd);
      }
    }
  return out;
}

// ---------------------------------------------------------------- land value

function maxTierNear(state, cx, cz, rad) {
  const tier = state.roads.tier;
  let best = 0;
  for (let dz = -rad; dz <= rad; dz++)
    for (let dx = -rad; dx <= rad; dx++) {
      const j = cellIndex(cx + dx, cz + dz);
      if (j >= 0 && tier[j] > best) best = tier[j];
    }
  return best;
}

function maxWearNear(state, cx, cz, rad) {
  const wear = state.roads.wear;
  let best = 0;
  for (let dz = -rad; dz <= rad; dz++)
    for (let dx = -rad; dx <= rad; dx++) {
      const j = cellIndex(cx + dx, cz + dz);
      if (j >= 0 && wear[j] > best) best = wear[j];
    }
  return best;
}

const SHORE_VIEW = 30;

// Raw land value at a cell: roads, landmarks and nearness to the centre.
export function landValueAt(state, cx, cz) {
  const { centroid } = buildingBins(state);
  const { x, z } = cellCenter(cellIndex(cx, cz));
  let v = 18 + maxTierNear(state, cx, cz, 2) * 6;
  let square = false;
  for (const b of buildingsNear(state, cx, cz, 15)) {
    // A park nearby is a good address; a derelict next door is not.
    if (b.type === 'park') v += 10 * Math.max(0, 1 - Math.hypot(b.x - x, b.z - z) / CELL / 15);
    else if (b.flags?.derelict) v -= 4 * Math.max(0, 1 - Math.hypot(b.x - x, b.z - z) / CELL / 8);
    const bonus = LANDMARKS[b.type];
    if (!bonus) continue;
    const d = Math.hypot(b.x - x, b.z - z) / CELL;
    v += bonus * (b.tier ?? 1) * 0.5 * Math.max(0, 1 - d / 15);
    if (b.type === 'monument' && b.flags?.square) square = true;
  }
  // Many centres, many peaks: each core lifts the land around it; away from
  // every core land is cheaper. (Before any centre exists: the town centroid.)
  const near = nearestCentre(state, x, z);
  if (near.centre) v += centrePeakValue(state, x, z) - near.dist / CELL * 0.15;
  else v -= Math.hypot(x - centroid.x, z - centroid.z) / CELL * 0.3;
  if (square) v *= 1.3;
  // A view from the hill.
  v += 6 * prominenceAt({ x, z });
  // An embanked waterfront is a good address; so is a lakeside or seaside one.
  const bank = bankDistance(x, z);
  if (bank < 16 && isEmbanked(state, x, z)) v += 8;
  // Ground the floods reach is cheap.
  const flood = floodAt(state, x, z);
  if (flood > 0) v -= 12 * Math.min(1, flood / FLOOD_BAR);
  if (bank < SHORE_VIEW) {
    const k = nearestWaterKind(x, z);
    if (k === KIND.LAKE || k === KIND.SEA) v += 7 * (1 - Math.max(0, bank) / SHORE_VIEW);
  }
  return Math.max(0, v);
}

// Land value at each district's centre, ranked 0 (cheapest) .. 1 (dearest).
// Cached per tick.
const districtValueCache = new WeakMap();

export function districtValueRank(state, districtId) {
  const month = state.time?.tick ?? 0;
  let hit = districtValueCache.get(state);
  if (!hit || hit.month !== month) {
    const values = (state.districts ?? []).map(d => {
      const [cx, cz] = worldToCell(d.centroid.x, d.centroid.z);
      return { id: d.id, v: landValueAt(state, cx, cz) };
    }).sort((a, b) => a.v - b.v || a.id - b.id);
    const rank = new Map(values.map((e, k) => [e.id, values.length > 1 ? k / (values.length - 1) : 0.5]));
    hit = { month, rank };
    districtValueCache.set(state, hit);
  }
  return hit.rank.get(districtId) ?? 0.5;
}

export function landValueNorm(state, cx, cz) {
  return Math.min(1, landValueAt(state, cx, cz) / LV_MAX);
}

// ---------------------------------------------------------------- frontier

// Coarse blocks within FRONTIER_RADIUS cells of any building.
function nearBuiltMask(state) {
  const blocks = new Uint8Array(BINS_W * BINS_W);
  const reach = Math.ceil(FRONTIER_RADIUS / BIN);
  for (const b of state.buildings ?? []) {
    const [cx, cz] = worldToCell(b.x, b.z);
    const bx = Math.floor(cx / BIN), bz = Math.floor(cz / BIN);
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++) {
        const x = bx + dx, z = bz + dz;
        if (x >= 0 && z >= 0 && x < BINS_W && z < BINS_W) blocks[z * BINS_W + x] = 1;
      }
  }
  return blocks;
}

// Anchor cells a lot may front onto: worn or tiered cells near buildings, and
// the ring of cells around existing lots. Falls back to a disc around `near`.
function frontierCells(state) {
  const { tier, wear } = state.roads;
  const { water } = terrainGrid();
  const blocks = nearBuiltMask(state);
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    if (water[i] || (tier[i] < 1 && wear[i] < 25)) continue;
    const cx = i % GRID_W, cz = (i - cx) / GRID_W;
    if (blocks[Math.floor(cz / BIN) * BINS_W + Math.floor(cx / BIN)]) out.push(i);
  }
  for (const lot of state.lots ?? []) ringCells(lot, out);
  for (const v of state.vacated ?? []) ringCells(v, out);
  if (farBankPull(state) > 0) fordLandings(state, out);
  return out;
}

// ---------------------------------------------------------------- the far bank

// The bank most of the town stands on (0 west, 1 east).
export function homeBank(state) {
  const { centroid } = buildingBins(state);
  return bankSide(centroid.x, centroid.z);
}

// How strongly the far bank draws settlers, 0..1. It starts once the town has
// grown past a village and rises with crowding and families waiting for homes.
export function farBankPull(state) {
  const n = buildingBins(state).count;
  const grown = Math.max(0, Math.min(1, (n - FAR_BANK_START) / 60));
  if (!grown) return 0;
  const waiting = state.indicators?.housingPressure ?? 0;
  const { centroid } = buildingBins(state);
  const [cx, cz] = worldToCell(centroid.x, centroid.z);
  const crowd = localDensity(state, cx, cz, 10);
  return Math.min(1, grown * (0.5 + 0.5 * crowd) + 0.5 * waiting);
}

const FAR_BANK_START = 40;      // buildings before anyone settles across
const FORD_REACH = 24;          // world units: how far a ford counts as access

// Land cells on the far side of each ford near town: the first frontier there.
function fordLandings(state, out) {
  const { centroid, radius } = buildingBins(state);
  const far = 1 - homeBank(state);
  for (const f of FORDS) {
    if (Math.abs(f.z - centroid.z) > radius + 80) continue;
    const rx = riverX(f.z);
    const dir = far ? 1 : -1;
    for (let d = WATER_HALF + 3; d <= WATER_HALF + 13; d += 2)
      for (let dz = -8; dz <= 8; dz += 2) pushCell(out, Math.floor((rx + dir * d - ORIGIN_X) / CELL), Math.floor((f.z + dz - ORIGIN_X) / CELL));
  }
}

// Fords count as access on the far bank: a lot near a ford landing is as
// reachable as one on a trail.
function fordAccess(x, z) {
  let best = 0;
  for (const f of FORDS) {
    const d = Math.hypot(x - riverX(f.z), z - f.z) - WATER_HALF;
    if (d < FORD_REACH) best = Math.max(best, 0.6 * (1 - Math.max(0, d) / FORD_REACH));
  }
  return best;
}

const FAR_FAVOURED = { farm: 0.6, mill: 0.5, workshop: 0.2, home: 0 };

function ringCells(lot, out) {
  for (let x = lot.cx - 1; x <= lot.cx + lot.w; x++) {
    pushCell(out, x, lot.cz - 1);
    pushCell(out, x, lot.cz + lot.h);
  }
  for (let z = lot.cz; z < lot.cz + lot.h; z++) {
    pushCell(out, lot.cx - 1, z);
    pushCell(out, lot.cx + lot.w, z);
  }
}

function discCells(center, rad, out) {
  const [cx, cz] = worldToCell(center.x, center.z);
  for (let dz = -rad; dz <= rad; dz += 2)
    for (let dx = -rad; dx <= rad; dx += 2) if (dx * dx + dz * dz <= rad * rad) pushCell(out, cx + dx, cz + dz);
}

function pushCell(out, cx, cz) {
  const j = cellIndex(cx, cz);
  if (j >= 0) out.push(j);
}

// ---------------------------------------------------------------- lot geometry

// A lot whose front edge faces the anchor cell. side is the direction from the
// anchor to the lot; the building faces back toward the anchor (rot).
export function lotAt(anchor, side, frontage, depth, setback = 0) {
  const [ax0, az0] = cellXZ(anchor);
  const [dx, dz] = ROT_DIR[side];
  // With a setback the lot stands one cell further off; that verge cell is
  // the front (the doorstep) and the anchor stays open as the street.
  const ax = ax0 + dx * setback, az = az0 + dz * setback;
  const rot = (side + 2) % 4;
  const alongX = dz !== 0;
  const w = alongX ? frontage : depth;
  const h = alongX ? depth : frontage;
  let cx, cz;
  if (alongX) {
    cx = ax - Math.floor((frontage - 1) / 2);
    cz = dz > 0 ? az + 1 : az - depth;
  } else {
    cz = az - Math.floor((frontage - 1) / 2);
    cx = dx > 0 ? ax + 1 : ax - depth;
  }
  return { cx, cz, w, h, rot, front: setback ? cellIndex(ax, az) : anchor, anchor, setback };
}

// Why a lot rectangle cannot be used, or null if it can.
function lotProblem(state, lot, type, ctx, gap) {
  const { fp, lots } = ctx;
  const { water } = terrainGrid();
  const tier = state.roads.tier;
  for (let z = lot.cz - gap; z < lot.cz + lot.h + gap; z++)
    for (let x = lot.cx - gap; x < lot.cx + lot.w + gap; x++) {
      const j = cellIndex(x, z);
      const inside = x >= lot.cx && z >= lot.cz && x < lot.cx + lot.w && z < lot.cz + lot.h;
      if (j < 0) {
        if (inside) return 'edge';
        continue;
      }
      // A one-cell gap from every other lot, so yards and back lanes exist.
      // (Terraces close the gap when two homes merge.)
      if (lots[j] || fp.blocked[j] || fp.field[j]) return 'taken';
      if (!inside) continue;
      if (water[j]) return 'water';
      if (tier[j] >= 3 && (state.roads.planned[j] & 1)) return 'planned';
      if (state.roads.planned[j] & 2) return 'bridge';   // never on a deck or its ends
    }
  return null;
}

function cellBank(j) {
  const { x, z } = cellCenter(j);
  return bankDistance(x, z);
}

// ---------------------------------------------------------------- doors

const OPEN_TYPES = new Set(['farm', 'park', 'bridge']);

// Cells just outside every building's door. New lots may not cover them.
// Cached per footprint version (doors only move with footprints or rot).
const frontCache = new WeakMap();

export function frontCells(state) {
  const key = `${state.worldVersion ?? 0}:${state.buildings?.length ?? 0}`;
  const hit = frontCache.get(state);
  if (hit && hit.key === key) return hit.set;
  const out = new Set();
  for (const b of state.buildings ?? []) {
    if (OPEN_TYPES.has(b.type)) continue;
    const f = frontCell(b);
    if (f >= 0) out.add(f);
  }
  frontCache.set(state, { key, set: out });
  return out;
}

function freeCell(j, ctx, water) {
  return j >= 0 && !ctx.fp.blocked[j] && !ctx.lots[j] && water[j] !== 1 && !steepCell(j);
}

// Cells nobody can walk: cliffs and mountain flanks (see roads.js NAV_MAX_*).
function steepCell(j) {
  const t = terrainGrid();
  return t.slope[j] > NAV_MAX_SLOPE || t.height[j] > NAV_MAX_HEIGHT;
}

// The lot must not seal a neighbour's door, and its own door must open onto a
// free cell that leads somewhere (a free neighbour besides the door itself).
function doorClear(state, lot, ctx) {
  const { water } = terrainGrid();
  for (let z = lot.cz; z < lot.cz + lot.h; z++)
    for (let x = lot.cx; x < lot.cx + lot.w; x++) if (ctx.fronts.has(cellIndex(x, z))) return false;
  const front = lot.front;
  if (!freeCell(front, ctx, water)) return false;
  const [fx, fz] = cellXZ(front);
  const inLot = (x, z) => x >= lot.cx && z >= lot.cz && x < lot.cx + lot.w && z < lot.cz + lot.h;
  for (const [dx, dz] of ROT_DIR) {
    const x = fx + dx, z = fz + dz;
    if (!inLot(x, z) && freeCell(cellIndex(x, z), ctx, water)) return true;
  }
  return false;
}

// Would building on this lot cut a door off from the town? Flood-fills a
// little way from the new door and from every door within DOOR_NEAR cells,
// with the lot counted as built. A door is fine when the fill reaches
// DOOR_REACH open cells. (Reaching a track is not enough: old tracks end up
// enclosed by buildings.)
const DOOR_REACH = 200;
const DOOR_NEAR = 6;

export function sealsDoors(state, lot, ctx = { fp: footprints(state), lots: lotGrid(state).cells, fronts: frontCells(state) }) {
  const inLot = j => {
    const x = j % GRID_W, z = (j - x) / GRID_W;
    return x >= lot.cx && z >= lot.cz && x < lot.cx + lot.w && z < lot.cz + lot.h;
  };
  const starts = lot.front >= 0 ? [lot.front] : [];
  for (const f of ctx.fronts) {
    const [fx, fz] = cellXZ(f);
    if (fx >= lot.cx - DOOR_NEAR && fz >= lot.cz - DOOR_NEAR && fx < lot.cx + lot.w + DOOR_NEAR && fz < lot.cz + lot.h + DOOR_NEAR) starts.push(f);
  }
  return starts.some(f => !doorReaches(state, f, ctx, inLot));
}

function doorReaches(state, start, ctx, blockedExtra) {
  const { water } = terrainGrid();
  const open = j => j >= 0 && !ctx.fp.blocked[j] && water[j] !== 1 && !blockedExtra(j) && !steepCell(j);
  if (!open(start)) return false;
  const seen = new Set([start]);
  const queue = [start];
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k];
    if (seen.size >= DOOR_REACH) return true;
    const x = c % GRID_W;
    for (const n of [x > 0 ? c - 1 : -1, x < GRID_W - 1 ? c + 1 : -1, c - GRID_W, c + GRID_W]) {
      if (n < 0 || n >= CELLS || seen.has(n) || !open(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return false;
}

// Checks a footprint someone else wants to place by hand (fixtures, the
// starting hamlet): {type, x, z, w, d, rot}. Returns {ok, reason?} where
// reason is 'overlap' | 'water' | 'bank' | 'door' | 'seals'.
export function validateFootprint(state, b, { ignoreId = null } = {}) {
  const fp = footprints(state);
  const { water } = terrainGrid();
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  const open = OPEN_TYPES.has(b.type);
  for (let z = cz0; z <= cz1; z++)
    for (let x = cx0; x <= cx1; x++) {
      const j = cellIndex(x, z);
      if (j < 0) return { ok: false, reason: 'water' };
      const owner = fp.blocked[j] - 1;
      if (owner >= 0 && owner !== ignoreId) return { ok: false, reason: 'overlap' };
      if (water[j] && !WATERFRONT.has(b.type)) return { ok: false, reason: 'water' };
    }
  if (!riverClear(state, b, b.type)) return { ok: false, reason: 'bank' };
  if (open) return { ok: true };
  const fronts = frontCells(state);
  for (let z = cz0; z <= cz1; z++)
    for (let x = cx0; x <= cx1; x++) if (fronts.has(cellIndex(x, z))) return { ok: false, reason: 'seals' };
  const f = frontCell(b);
  const owner = f >= 0 ? fp.blocked[f] - 1 : -2;
  if (f < 0 || (owner >= 0 && owner !== ignoreId) || water[f] === 1) return { ok: false, reason: 'door' };
  return { ok: true };
}

export function lotSlope(lot) {
  const { height } = terrainGrid();
  let lo = Infinity, hi = -Infinity;
  for (let z = lot.cz; z < lot.cz + lot.h; z++)
    for (let x = lot.cx; x < lot.cx + lot.w; x++) {
      const h = height[cellIndex(x, z)];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  return (hi - lo) / (Math.max(lot.w, lot.h) * CELL);
}

// Any water within reach cells of the lot; riverOnly asks for the river itself.
function riverAdjacent(lot, reach = 3, riverOnly = false) {
  const { water } = terrainGrid();
  for (let z = lot.cz - reach; z < lot.cz + lot.h + reach; z++)
    for (let x = lot.cx - reach; x < lot.cx + lot.w + reach; x++) {
      const j = cellIndex(x, z);
      if (j < 0 || !water[j]) continue;
      if (!riverOnly) return true;
      const c = cellCenter(j);
      if (waterKindAt(c.x, c.z) === KIND.RIVER) return true;
    }
  return false;
}

// Building over a path is allowed but costly. Each covered cell has a cost
// multiplier: worn grass or a trail x1.3, a track x2, a gravel road x4, paved
// or avenue x8. pathCover gives the lot's multiplier (1 + the mean extra),
// the worst tier covered, and the extra split into organic and planned shares.
export const PATH_MULT = [1, 1.3, 2, 4, 8, 8];
const TRAIL_WEAR = 60;
const PATH_PENALTY = 1.5;
const BUSY_PENALTY = 2.5;     // outweighs the best access a path frontage gives (2.0)

// How busy a path is is relative to the town: a dirt path a hamlet uses every
// day matters to it as much as a city's gravel road. busyRef is the wear of
// the town's busy ground (the 90th percentile of trodden cells), cached per
// road version; a covered cell's busyness is log-wear over log of that.
const BUSY_TRODDEN = 25;      // wear that counts as trodden ground
const BUSY_FLOOR = 120;       // never call a faint trail busy in a tiny hamlet
const busyCache = new WeakMap();
const smoothstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export function busyRef(state) {
  const r = state.roads;
  const hit = busyCache.get(r);
  if (hit && hit.version === r.version) return hit.ref;
  const vals = [];
  for (let i = 0; i < r.wear.length; i++) if (r.wear[i] >= BUSY_TRODDEN) vals.push(r.wear[i]);
  vals.sort((a, b) => a - b);
  const ref = Math.max(BUSY_FLOOR, vals.length ? vals[Math.floor(vals.length * 0.9)] : 0);
  busyCache.set(r, { version: r.version, ref });
  return ref;
}

export function pathCover(state, lot) {
  const { tier, wear, planned } = state.roads;
  const logRef = Math.log1p(busyRef(state));
  let extra = 0, organic = 0, plannedExtra = 0, worst = 0, cells = 0, busy = 0;
  for (let z = lot.cz; z < lot.cz + lot.h; z++)
    for (let x = lot.cx; x < lot.cx + lot.w; x++) {
      const j = cellIndex(x, z);
      if (j < 0) continue;
      cells++;
      if (!(planned[j] & 1)) busy = Math.max(busy, Math.log1p(wear[j]) / logRef);
      const t = tier[j] || (wear[j] >= TRAIL_WEAR ? 1 : 0);
      if (!t) continue;
      const m = PATH_MULT[t] - 1;
      extra += m;
      if (planned[j] & 1) plannedExtra += m; else organic += m;
      if (t > worst) worst = t;
    }
  const n = Math.max(1, cells);
  return { mult: 1 + extra / n, worst, organic: organic / n, planned: plannedExtra / n, share: extra / n, busy };
}

// Where several busy paths meet, from era 2, open space is kept: it becomes
// a square on its own. Cached per road version (saved, so replays match).
const junctionCache = new WeakMap();

function junctionMask(state) {
  const month = state.roads.version;
  let hit = junctionCache.get(state);
  if (hit && hit.month === month) return hit.mask;
  const mask = new Uint8Array(CELLS);
  const { tier } = state.roads;
  for (let i = 0; i < CELLS; i++) {
    if (tier[i] < 2) continue;
    const [cx, cz] = cellXZ(i);
    let arms = 0;
    for (const [dx, dz] of ROT_DIR) {
      const j = cellIndex(cx + dx * 3, cz + dz * 3);
      if (j >= 0 && tier[j] >= 2) arms++;
    }
    if (arms < 3) continue;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const j = cellIndex(cx + dx, cz + dz);
        if (j >= 0) mask[j] = 1;
      }
  }
  junctionCache.set(state, { month, mask });
  return mask;
}

function coversJunction(state, lot) {
  if ((state.era ?? 0) < 2) return false;
  const mask = junctionMask(state);
  for (let z = lot.cz; z < lot.cz + lot.h; z++)
    for (let x = lot.cx; x < lot.cx + lot.w; x++) if (mask[cellIndex(x, z)]) return true;
  return false;
}

// Share of cells within `rad` covered by lots or buildings, normalised so 0.6
// coverage reads as 1 (the indicator's 60/100 scale).
export function localDensity(state, cx, cz, rad = 6) {
  const lots = lotGrid(state).cells;
  const fp = footprints(state);
  let used = 0, total = 0;
  for (let dz = -rad; dz <= rad; dz++)
    for (let dx = -rad; dx <= rad; dx++) {
      const j = cellIndex(cx + dx, cz + dz);
      if (j < 0) continue;
      total++;
      if (lots[j] || fp.blocked[j]) used++;
    }
  return Math.min(1, used / Math.max(1, total) / 0.6);
}

// ---------------------------------------------------------------- scoring

function pollutionNear(state, cx, cz) {
  const { x, z } = cellCenter(cellIndex(cx, cz));
  let p = 0;
  for (const b of buildingsNear(state, cx, cz, 10)) {
    if (!SMOKY.has(b.type) && !(b.smoke > 0)) continue;
    const d = Math.hypot(b.x - x, b.z - z) / CELL;
    p += Math.max(b.smoke ?? 0.3, 0.3) * Math.max(0, 1 - d / 10);
  }
  return Math.min(1, p);
}

function sameTypeNear(state, cx, cz, type) {
  let n = 0;
  for (const b of buildingsNear(state, cx, cz, 6)) if (b.type === type) n++;
  return Math.min(3, n) / 3;
}

function archetypeBias(state, type, lot, density) {
  const arch = state.archetype ?? 'market-town';
  const river = riverAdjacent(lot) ? 1 : 0;
  let bias = 0;
  if (arch === 'garden') bias += 0.4 * (1 - density);
  if (arch === 'port' && RIVER_LIKES.has(type)) bias += 1.0 * river;
  if (type === 'mill') bias += 1.5 * (riverAdjacent(lot, 3, true) ? 1 : 0) * (state.policies?.['mill-rights'] ? 1 : 0.5);
  if ((type === 'warehouse' || type === 'quay') && arch !== 'port') bias += 0.5 * river;
  return bias;
}

// Scores one lot. Returns null when the lot is unusable for this need.
export function scoreLot(state, lot, need, ctx) {
  const type = need.type;
  if (lotProblem(state, lot, type, ctx, 1)) return null;
  if (!OPEN_TYPES.has(type) && !doorClear(state, lot, ctx)) return null;
  if (!riverClear(state, footprintFor(lot, type), type)) return null;
  const slope = WATERFRONT.has(type) ? 0 : lotSlope(lot);
  const hillWork = HILL_WORKS.has(need.variant) || type === 'quarry';
  if (slope > maxSlopeFor(type, state.era ?? 0, hillWork)) return null;
  const river = riverAdjacent(lot);
  if (WATER_TYPES.has(type) && !(river && riverAdjacent(lot, 3, true))) return null;
  const [fx, fz] = cellXZ(lot.front);
  const mx = lot.cx + (lot.w >> 1), mz = lot.cz + (lot.h >> 1);
  const tierNear = maxTierNear(state, fx, fz, 2);
  const frontPt = cellCenter(lot.front);
  const farSide = ctx.farPull > 0 && bankSide(frontPt.x, frontPt.z) !== ctx.homeBank;
  const access = Math.min(1, Math.max(tierNear / 3, wearNorm(maxWearNear(state, fx, fz, 1)) * 0.6, farSide ? fordAccess(frontPt.x, frontPt.z) : 0));
  const density = localDensity(state, mx, mz);
  const terms = {
    access,
    landValue: landValueNorm(state, mx, mz),
    sameType: sameTypeNear(state, mx, mz, type),
    pollution: type === 'home' || type === 'school' || type === 'infirmary' ? pollutionNear(state, mx, mz) : 0,
    slope: Math.min(1, slope / 0.25),
    density,
    river: river ? 1 : 0,
    flood: Math.min(1, floodAt(state, frontPt.x, frontPt.z) / FLOOD_BAR),
  };
  const cover = pathCover(state, lot);
  terms.path = cover.share;
  terms.pathTier = cover.worst;
  // Covering one of the town's own busy paths cuts it, whatever its tier.
  // Open ground (fields, parks) lets people keep walking across it.
  terms.busyPath = OPEN_TYPES.has(type) ? 0 : smoothstep(0.85, 1.05, cover.busy);
  // Streets read when lots stand a cell back from the path they face.
  const anchorTier = lot.anchor != null ? state.roads.tier[lot.anchor] : 0;
  terms.setback = lot.setback && anchorTier >= 1 ? 1 : 0;
  // Each centre grows its own downtown: denser near its core.
  const target = Math.min(1, ctx.target * (0.7 + 0.5 * corePull(state, frontPt.x, frontPt.z)));
  let score = 2.0 * terms.access + 1.2 * terms.landValue + 0.8 * terms.sameType
    - 1.0 * terms.pollution - 0.6 * terms.slope - 0.5 * (density - target) ** 2
    + archetypeBias(state, type, lot, density)
    - PATH_PENALTY * Math.min(4, cover.share)
    - BUSY_PENALTY * terms.busyPath
    + 0.3 * terms.setback - (anchorTier >= 2 && !lot.setback ? 0.2 : 0)
    - (coversJunction(state, lot) ? 1.0 : 0)
    + hillBias(type, hillWork, slope, terms.prominence = prominenceAt(cellCenter(cellIndex(mx, mz))))
    + (type === 'farm' ? farmEdgeBias(state, terms, mx, mz) : 0)
    + centreBias(state, type, frontPt.x, frontPt.z)
    // Flood meadows: good grazing and hay, a poor place for a house.
    + (FLOOD_TOLERANT.has(type) ? (type === 'farm' ? 0.4 : 0) : -3) * terms.flood
    + (need.relocate ? relocationBias(state, need, terms, frontPt) : 0)
    + vacatedBias(state, lot)
    // Across the river land is cheap and open; the pull grows as the near bank fills.
    + (farSide ? ctx.farPull * (0.8 + (FAR_FAVOURED[type] ?? 0.2)) : 0);
  terms.farBank = farSide ? 1 : 0;
  if (need.near && !farSide) score -= (need.nearWeight ?? 0.01) * Math.max(0, Math.hypot(frontPt.x - need.near.x, frontPt.z - need.near.z) / CELL - 10);
  if (need.districtId != null && need.relocate && nearestDistrictId(state, frontPt.x, frontPt.z) === need.districtId) score += 0.5;
  return { score, terms, tierNear };
}

// ---------------------------------------------------------------- proposeSites

// need = {type, tier = 1, count = 4, near?: {x, z}, districtId?}
// Returns up to `count` distinct candidates (>= 6 cells apart), best first:
// {cx, cz, w, h, rot, front, x, z, score, terms, bands, districtId}.
export function proposeSites(state, need) {
  const tier = need.tier ?? 1;
  const [frontage, depth] = lotSize(need.type, tier);
  const ctx = {
    fp: footprints(state), lots: lotGrid(state).cells, target: densityTarget(state), fronts: frontCells(state),
    farPull: farBankPull(state), homeBank: homeBank(state),
  };
  const anchors = sampleAnchors(state, cachedFrontier(state, need), (need.count ?? 4) <= 1 ? ONE_OFF_ANCHORS : MAX_ANCHORS);
  const scored = [];
  const tried = new Set();
  for (const anchor of anchors) {
    for (let side = 0; side < 4; side++)
      for (const setback of [1, 0]) {
        const lot = lotAt(anchor, side, frontage, depth, setback);
        if (lot.front < 0) continue;
        const key = `${lot.cx},${lot.cz},${lot.w},${lot.rot}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const s = scoreLot(state, lot, need, ctx);
        if (s) scored.push({ ...lot, ...s });
      }
  }
  scored.sort((a, b) => b.score - a.score || a.front - b.front);
  // Batch searches (count > 4) skip the flood fill; their sites are checked
  // again with siteStillFree(..., doors = true) when used.
  const count = need.count ?? 4;
  const keepsDoors = OPEN_TYPES.has(need.type) || count > 4 ? () => true : c => !sealsDoors(state, c, ctx);
  return pickDistinct(scored, count, keepsDoors).map(c => describe(state, c, need));
}

// One-off requests (count 1) look at fewer anchors: the busiest frontage
// still dominates, and the search costs a third.
const ONE_OFF_ANCHORS = 300;

// The frontier, shared by every site search within a tick (the yearly
// enterprise round asks several in a row).
const frontierCache = new WeakMap();

function cachedFrontier(state, need) {
  // Per tick: a restored save must replay exactly, so nothing cached may
  // outlive the tick it was made in (wear changes every tick).
  const key = state.time?.tick ?? 0;
  let hit = frontierCache.get(state);
  if (!hit || hit.key !== key) {
    hit = { key, ...splitBusiest(state, [...new Set(frontierCells(state))], MAX_ANCHORS / 2) };
    frontierCache.set(state, hit);
  }
  if (hit.top.length + hit.rest.length >= 8) return hit;
  // An empty map (a new town): look around the wanted spot instead.
  const disc = [];
  discCells(need.near ?? buildingBins(state).centroid, 14, disc);
  return { top: [...new Set([...hit.top, ...hit.rest, ...disc])], rest: [] };
}

// The k most worn cells (in order) and the rest, in linear time plus a
// sort of k: a full sort of a city's frontier every month is too slow.
function splitBusiest(state, cells, k) {
  const { wear } = state.roads;
  if (cells.length <= k) return { top: cells.sort((a, b) => wear[b] - wear[a] || a - b), rest: [] };
  const values = Float32Array.from(cells, c => wear[c]);
  const cut = kthLargest(values, k);
  const top = [], rest = [];
  for (const c of cells) (wear[c] > cut && top.length < k ? top : rest).push(c);
  for (const c of rest) if (top.length < k && wear[c] === cut) top.push(c);
  const inTop = new Set(top);
  top.sort((a, b) => wear[b] - wear[a] || a - b);
  return { top, rest: rest.filter(c => !inTop.has(c)) };
}

// Quickselect (deterministic middle pivot) on a scratch copy.
function kthLargest(values, k) {
  let lo = 0, hi = values.length - 1;
  const target = k - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (values[i] > pivot) i++;
      while (values[j] < pivot) j--;
      if (i <= j) { const t = values[i]; values[i] = values[j]; values[j] = t; i++; j--; }
    }
    if (target <= j) hi = j;
    else if (target >= i) lo = i;
    else break;
  }
  return values[target];
}

// Keeps the busiest half, and samples the rest so quiet edges still get a chance.
function sampleAnchors(state, frontier, max) {
  const keep = frontier.top.slice(0, max / 2);
  const rest = frontier.rest;
  if (keep.length + rest.length <= max) return keep.concat(rest);
  for (let k = 0; k < max / 2; k++) keep.push(rest[Math.floor(rng(state) * rest.length)]);
  return keep;
}

function pickDistinct(sorted, count, accept = () => true) {
  const out = [];
  for (const c of sorted) {
    const mx = c.cx + c.w / 2, mz = c.cz + c.h / 2;
    if (out.some(o => Math.hypot(o.cx + o.w / 2 - mx, o.cz + o.h / 2 - mz) < MIN_APART)) continue;
    if (!accept(c)) continue;
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

const ACCESS_BANDS = ['none', 'trail', 'track', 'road', 'paved', 'avenue'];

function band3(v, a, b, names) { return v < a ? names[0] : v < b ? names[1] : names[2]; }

function describe(state, c, need) {
  const x = ORIGIN_X + (c.cx + c.w / 2) * CELL;
  const z = ORIGIN_X + (c.cz + c.h / 2) * CELL;
  return {
    type: need.type,
    tier: need.tier ?? 1,
    cx: c.cx, cz: c.cz, w: c.w, h: c.h, rot: c.rot, front: c.front,
    x, z,
    score: c.score,
    terms: c.terms,
    bands: {
      access: ACCESS_BANDS[c.tierNear] ?? 'none',
      landValue: band3(c.terms.landValue, 0.35, 0.65, ['low', 'mid', 'high']),
      neighbours: band3(c.terms.sameType, 0.01, 0.67, ['none', 'few', 'many']),
      pollution: band3(c.terms.pollution, 0.15, 0.5, ['clean', 'some', 'smoky']),
      river: c.terms.river ? 'yes' : 'no',
      path: c.terms.pathTier >= 3 ? 'road' : c.terms.pathTier === 2 ? 'lane' : c.terms.pathTier === 1 ? 'footpath' : 'none',
    },
    districtId: nearestDistrictId(state, x, z),
  };
}

export function nearestDistrictId(state, x, z) {
  let best = null, bestD = Infinity;
  for (const d of state.districts ?? []) {
    const dist = Math.hypot(d.centroid.x - x, d.centroid.z - z);
    if (dist < bestD) { bestD = dist; best = d.id; }
  }
  return best;
}

// Is a candidate from an earlier search still buildable now? The cheap
// checks only; `doors` adds the flood fill (run it on the chosen site).
export function siteContext(state) {
  return { fp: footprints(state), lots: lotGrid(state).cells, fronts: frontCells(state) };
}

export function siteStillFree(state, site, ctx = siteContext(state), doors = false) {
  if (lotProblem(state, site, site.type, ctx, 1)) return false;
  if (OPEN_TYPES.has(site.type)) return true;
  if (!doorClear(state, site, ctx)) return false;
  return !doors || !sealsDoors(state, site, ctx);
}

// ---------------------------------------------------------------- choose-site

const LETTERS = ['a', 'b', 'c', 'd'];

// Short band description of a candidate for the choose_site question.
export function siteText(site) {
  const b = site.bands;
  const access = b.access === 'none' ? 'no path yet' : `on a ${b.access}`;
  const river = b.river === 'yes' ? ', by the river' : '';
  const path = b.path === 'road' ? 'blocks a road, ' : b.path === 'lane' ? 'blocks a busy lane, ' : b.path === 'footpath' ? 'over a footpath, ' : '';
  return `${path}${access}, ${b.landValue} land value, ${b.neighbours} neighbours, ${b.pollution} air${river}`.slice(0, 80);
}

// The builder picks among the top candidates through the choose_site
// decision kind (sim-governance pools the answers). The scores give the prior.
// Returns a candidate, or null when there is none or the builder waits.
export function chooseSite(state, need, rand = () => rng(state), prepared = null) {
  const sites = prepared ?? proposeSites(state, need);
  if (!sites.length) return null;
  const record = { need: need.type };
  const prior = { wait: 0.04 };
  sites.forEach((site, k) => {
    record[LETTERS[k]] = siteText(site);
    prior[LETTERS[k]] = Math.exp(2 * (site.score - sites[0].score));
  });
  const subject = { type: 'site', record, districtId: sites[0].districtId, need };
  const pick = decide(state, 'choose_site', subject, { prior, mask: [...LETTERS.slice(0, sites.length), 'wait'], rng: rand });
  if (pick === 'wait') return null;
  return sites[LETTERS.indexOf(pick)] ?? sites[0];
}

// ---------------------------------------------------------------- lots

function nextLotId(state) {
  state.nextLotId ??= (state.lots ?? []).reduce((m, l) => Math.max(m, l.id), 0) + 1;
  return state.nextLotId++;
}

// Turns a candidate into a lot record and reserves its cells.
export function claimSite(state, site, fields = {}) {
  state.lots ??= [];
  const lot = {
    id: nextLotId(state),
    cx: site.cx, cz: site.cz, w: site.w, h: site.h, rot: site.rot,
    buildingId: fields.buildingId ?? null,
    districtId: fields.districtId ?? site.districtId ?? null,
    landValue: Math.round(landValueAt(state, site.cx + (site.w >> 1), site.cz + (site.h >> 1))),
    frontageTier: state.roads.tier[site.front] ?? 0,
  };
  const sale = landSaleFor(state, lot);
  if (sale) lot.landSale = sale;
  state.lots.push(lot);
  state.lotsRev = (state.lotsRev ?? 0) + 1;
  return lot;
}

// Farmland a farmer has sold for building: state.landSales =
// [{cx, cz, w, h, owner, perCell, year}]. Whoever builds there pays the
// farmer through project.landSale. Offers lapse after LAND_SALE_YEARS.
export const LAND_SALE_YEARS = 30;

function landSaleFor(state, lot) {
  const year = state.time?.year ?? 0;
  state.landSales = (state.landSales ?? []).filter(s => year - s.year <= LAND_SALE_YEARS && s.cells > 0);
  for (const s of state.landSales) {
    const x0 = Math.max(lot.cx, s.cx), x1 = Math.min(lot.cx + lot.w, s.cx + s.w);
    const z0 = Math.max(lot.cz, s.cz), z1 = Math.min(lot.cz + lot.h, s.cz + s.h);
    const cells = Math.max(0, x1 - x0) * Math.max(0, z1 - z0);
    if (!cells) continue;
    s.cells -= cells;
    return { to: s.owner, amount: Math.round(cells * s.perCell) };
  }
  return null;
}

export function releaseLot(state, lotId) {
  const at = (state.lots ?? []).findIndex(l => l.id === lotId);
  if (at < 0) return null;
  const [lot] = state.lots.splice(at, 1);
  state.lotsRev = (state.lotsRev ?? 0) + 1;
  return lot;
}

export function resizeLot(state, lot, rect) {
  Object.assign(lot, rect);
  state.lotsRev = (state.lotsRev ?? 0) + 1;
}

// Can a lot grow `extra` cells deeper (away from its front)? Returns the new
// rectangle or null.
export function deepenLot(state, lot, extra, type = 'home') {
  const [dx, dz] = ROT_DIR[lot.rot ?? 0];
  const rect = { cx: lot.cx, cz: lot.cz, w: lot.w, h: lot.h };
  if (dz > 0) { rect.cz -= extra; rect.h += extra; }
  else if (dz < 0) rect.h += extra;
  else if (dx > 0) { rect.cx -= extra; rect.w += extra; }
  else rect.w += extra;
  const lots = lotGrid(state).cells;
  const fp = footprints(state);
  const fronts = frontCells(state);
  const { water } = terrainGrid();
  const tier = state.roads.tier;
  for (let z = rect.cz; z < rect.cz + rect.h; z++)
    for (let x = rect.cx; x < rect.cx + rect.w; x++) {
      if (x >= lot.cx && z >= lot.cz && x < lot.cx + lot.w && z < lot.cz + lot.h) continue;
      const j = cellIndex(x, z);
      if (j < 0 || lots[j] || fp.blocked[j] || fp.field[j] || water[j] || tier[j] >= 2 || fronts.has(j)) return null;
    }
  if (sealsDoors(state, { ...rect, front: -1 })) return null;
  return riverClear(state, footprintFor({ ...rect, rot: lot.rot }, type), type) ? rect : null;
}

// Building footprint (world units) for a lot: the lot minus a small margin.
export function footprintFor(lot, type) {
  const margin = type === 'farm' || type === 'park' ? 0 : 0.6;
  return {
    x: ORIGIN_X + (lot.cx + lot.w / 2) * CELL,
    z: ORIGIN_X + (lot.cz + lot.h / 2) * CELL,
    w: lot.w * CELL - margin,
    d: lot.h * CELL - margin,
    rot: lot.rot ?? 0,
  };
}

// Lot rectangle (cells) covering an existing building without a lot.
export function lotForBuilding(b) {
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  return { cx: cx0, cz: cz0, w: cx1 - cx0 + 1, h: cz1 - cz0 + 1, rot: b.rot ?? 0 };
}

// ---------------------------------------------------------------- event placement

// Where a flood comes ashore: the river bank nearest the town centre, on the
// side where most buildings stand.
export function floodPoint(state) {
  const { centroid } = buildingBins(state);
  if (!hasRiver()) return { x: centroid.x, z: centroid.z, radius: 24 };
  // The nearest reach of open river (not where it runs through a lake or the sea).
  let z = centroid.z;
  for (let k = 0; k < 400 && !riverOpenAt(z); k++) z = centroid.z + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 4;
  const rx = riverX(z);
  const side = Math.sign(centroid.x - rx) || -1;
  return { x: rx + side * (WATER_HALF + 4), z, radius: 24 };
}

const FLAMMABLE = new Set(['timber', 'thatch']);

// The most crowded block of timber and thatch: where a fire would spread.
// Returns {x, z, radius, buildingIds} or null.
export function fireBlock(state, rad = 6) {
  let best = null, bestN = 0;
  for (const b of state.buildings ?? []) {
    if (!FLAMMABLE.has(b.material) || b.type === 'farm' || b.type === 'bridge') continue;
    const [cx, cz] = worldToCell(b.x, b.z);
    const near = buildingsNear(state, cx, cz, rad).filter(o => FLAMMABLE.has(o.material) && o.type !== 'farm');
    if (near.length > bestN) { bestN = near.length; best = { b, near }; }
  }
  if (!best || bestN < 3) return null;
  return { x: best.b.x, z: best.b.z, radius: rad * CELL, buildingIds: best.near.map(o => o.id) };
}

// ---------------------------------------------------------------- the starting hamlet

const HAMLET_GAP = 1.5;

// A pleasant spot for the first hamlet: flat, dry ground a short walk from a
// ford near the origin, never on the bank. Deterministic for a terrain seed.
export function hamletCentre() {
  if (!hasRiver()) return drySiteCentre();
  const fords = FORDS.filter(f => Math.abs(f.z) <= 60);
  const pool = fords.length ? fords : [FORDS.reduce((a, b) => (Math.abs(a.z) < Math.abs(b.z) ? a : b))];
  let best = null;
  for (const f of pool)
    for (const side of [-1, 1])
      for (const d of [10, 14, 18, 22, 26, 32])
        for (const dz of [-24, -16, -8, 0, 8, 16, 24]) {
          const z = f.z + dz;
          const x = riverX(z) + side * (WATER_HALF + d);
          // The first houses stand on the terrace above the flood meadows.
          const score = -4 * groundRange(x, z, 18) - 0.04 * Math.abs(dz) - 0.03 * Math.abs(d - 18) - 0.01 * Math.hypot(x, z) - 6 * floodDepthAt(x, z);
          if (!best || score > best.score) best = { x, z, side, ford: f, score };
        }
  return best;
}

// No river: the flattest dry ground near the middle of the valley, on the
// terrace above any shore and its flood line.
function drySiteCentre() {
  let best = null;
  for (let z = -80; z <= 80; z += 8)
    for (let x = -80; x <= 80; x += 8) {
      if (bankDistance(x, z) < 30) continue;
      const score = -4 * groundRange(x, z, 18) - 0.02 * Math.hypot(x, z) - 6 * floodDepthAt(x, z);
      if (!best || score > best.score) best = { x, z, side: 1, ford: null, score };
    }
  return best ?? { x: 0, z: 0, side: 1, ford: null, score: 0 };
}

function groundRange(x, z, radius) {
  let lo = Infinity, hi = -Infinity;
  for (let a = -2; a <= 2; a++)
    for (let b = -2; b <= 2; b++) {
      const h = heightAt(x + (a * radius) / 2, z + (b * radius) / 2);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  return hi - lo;
}

// Layout for the starting hamlet: {centre, moot, homes, farms, workshop},
// each a footprint {type, x, z, w, d, rot}. Every footprint keeps the bank
// setback, sits on gentle ground, overlaps nothing (with a small gap) and has
// its door open toward the middle.
export function hamletLayout(state, { homes = 7, farms = 2, workshop = true } = {}) {
  const centre = hamletCentre();
  const placed = [];
  const towardRiver = centre.side > 0 ? 3 : 1;
  // Dry ground first: houses go on the floodplain only if nothing else fits.
  const put = (spec, tries) => {
    for (const dry of [true, false]) {
      for (const t of tries) {
        const rect = { ...spec, ...t };
        if (dry && !FLOOD_TOLERANT.has(rect.type) && footprintFlood(state, rect) > 0) continue;
        if (hamletFits(state, rect, placed)) { placed.push(rect); return rect; }
      }
    }
    return null;
  };
  const ring = (radii, n, k, phase = 0.4) => {
    const out = [];
    for (const r of radii)
      for (let j = 0; j < 12; j++) {
        const a = ((k + j / 12) / n) * Math.PI * 2 + phase;
        const x = Math.round(centre.x + Math.cos(a) * r), z = Math.round(centre.z + Math.sin(a) * r);
        out.push({ x, z, rot: rotToward(x, z, centre) });
      }
    return out;
  };
  // Walls stand 0.3 inside their cells (as grown buildings do), so a walker's
  // margin never spills into the neighbouring cells.
  const moot = put({ type: 'moot', w: 5.4, d: 4.4 }, [
    { x: Math.round(centre.x), z: Math.round(centre.z), rot: towardRiver },
    ...ring([4, 7, 10], 6, 0).map(t => ({ ...t, rot: towardRiver })),
  ]);
  const out = { centre, moot, homes: [], farms: [], workshop: null };
  // Last resort on broken ground: any spot in a spiral around the centre.
  const spiral = [];
  for (let r = 8; r <= 44; r += 3)
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = Math.round(centre.x + Math.cos(a) * r), z = Math.round(centre.z + Math.sin(a) * r);
      spiral.push({ x, z, rot: rotToward(x, z, centre) });
    }
  for (let i = 0; i < homes; i++) {
    const home = put({ type: 'home', w: 3.4, d: 3.4 }, [...ring([11, 13, 15, 17, 20, 23, 26, 29, 32], homes, i), ...spiral]);
    if (home) out.homes.push(home);
  }
  if (workshop) out.workshop = put({ type: 'workshop', w: 3.4, d: 3.4 }, [...ring([16, 19, 22, 26], 1, 0.6, 0), ...spiral]);
  // Fields lie inland, away from the river.
  const inland = centre.side > 0 ? 0 : Math.PI;
  for (let i = 0; i < farms; i++) {
    const tries = [];
    for (const r of [30, 34, 38, 44, 50, 56, 62])
      for (const da of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75]) {
        const a = inland + (i - (farms - 1) / 2) * 0.9 + da;
        tries.push({ x: Math.round(centre.x + Math.cos(a) * r), z: Math.round(centre.z + Math.sin(a) * r), rot: 0 });
      }
    const farm = put({ type: 'farm', w: 12, d: 12 }, tries);
    if (farm) out.farms.push(farm);
  }
  return out;
}

function rotToward(x, z, c) {
  const dx = c.x - x, dz = c.z - z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
  return dz > 0 ? 0 : 2;
}

function rectsOverlap(a, b, gap) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.z - b.z) < (a.d + b.d) / 2 + gap;
}

function hamletFits(state, rect, placed) {
  if (Math.abs(rect.x) > 370 || Math.abs(rect.z) > 370) return false;
  if (!riverClear(state, rect, rect.type)) return false;
  const fb = footprintBank(rect, 0);
  // Gentle ground: a plinth covers small drops; fields follow the land.
  const allowed = rect.type === 'farm' ? 2.0 : 0.3 + 0.2 * Math.max(rect.w, rect.d);
  if (fb.maxH - fb.minH > allowed) return false;
  if (placed.some(p => rectsOverlap(p, rect, HAMLET_GAP))) return false;
  // Cell-level checks, as navigation and validateFootprint see them.
  const cells = cellSet(rect);
  if (placed.some(p => [...cellSet(p)].some(c => cells.has(c)))) return false;
  if (rect.type === 'farm') return true;
  const front = frontCell(rect);
  if (front < 0 || terrainGrid().water[front]) return false;
  for (const p of placed) {
    if (cellSet(p).has(front)) return false;
    if (p.type !== 'farm' && cells.has(frontCell(p))) return false;
  }
  return true;
}

function cellSet(rect) {
  const { cx0, cz0, cx1, cz1 } = buildingCells(rect);
  const out = new Set();
  for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) out.add(cellIndex(x, z));
  return out;
}
