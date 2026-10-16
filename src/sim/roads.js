// Emergent roads: a wear field over a 2-unit grid. Walkers wear the cells they
// enter; worn cells harden into trails, tracks and roads; unused ones fade.
// Paved roads and avenues come only from planned works (works.js).
import { heightAt, waterAt, fordAt, riverX, terrainKey, FORDS, floodDepthAt, terrainVersion, bankSide } from '../terrain.js';
import { findRoute, cellsToWaypoints } from '../navigation.js';
import { buildNodes, patchNodes } from '../path-nodes.js';

export const CELL = 2;
// The region: 384 x 384 cells of 2 units, -384..384 on both axes (room for
// several towns; the mountains stand beyond).
export const GRID_W = 384;
export const GRID_H = 384;
export const ORIGIN_X = -384;
export const ORIGIN_Z = -384;
export const CELLS = GRID_W * GRID_H;

export const TIER_NAMES = ['grass', 'trail', 'track', 'road', 'paved', 'avenue'];
export const TIER_COST = [1.2, 0.95, 0.75, 0.55, 0.42, 0.35];
export const TIER_SPEED = [1, 1.1, 1.25, 1.5, 1.75, 1.9];
export const UPGRADE_AT = [0, 60, 300, 1200];
export const DOWNGRADE = [null, { below: 20, months: 24 }, { below: 100, months: 36 }];
// Highest tier reachable by wear alone, and by planned works, per era.
// Tier 3 is organic from era 1 (§6.2) so the Town entry rule can be met.
export const ORGANIC_MAX = [2, 3, 3, 3, 3, 3];
export const PLANNED_MAX = [2, 3, 4, 4, 5, 5];
export const FLAG = { PLANNED: 1, BRIDGE: 2, LAMP: 4, FORD: 8, TOWPATH: 16 };

export const ADJ_COST = 0.9;
export const FORD_COST = 2.5;
// Crops cost about eight times grass: farmhands can still reach the gate, but
// through-traffic walks round on the headlands. Park lawns are ordinary ground.
export const FIELD_COST = 9.6;
export const LAWN_COST = 1.3;
export const FIELD = { CROP: 1, LAWN: 2 };
// Half a walker's width, minus a little slack: footprints block every cell
// they come within this distance of.
export const PERSON_MARGIN = 0.25;
export const WEAR_STEP = 3;
// Time is compressed (a month is five seconds), so one visible walk stands for
// many daily trips. Walker wear from people.js is multiplied by this.
export const WALKER_SCALE = 4;
export const GROUP_WEAR = 0.14;
export const DECAY = 0.985;
export const XING_DECAY = 0.92;
export const BAND_CELLS = 8;
const SLOPE_COST = 0.3;
// Too steep or too high to walk: mountain flanks and cliffs.
export const NAV_MAX_SLOPE = 0.9;
export const NAV_MAX_HEIGHT = 45;
// Worn ground on steep cells washes out faster.
const EROSION = 0.012;
const RAIN_MUD = 1.3;

// ---------------------------------------------------------------- geometry

export function cellOf(x, z) {
  const cx = Math.floor((x - ORIGIN_X) / CELL);
  const cz = Math.floor((z - ORIGIN_Z) / CELL);
  if (cx < 0 || cz < 0 || cx >= GRID_W || cz >= GRID_H) return -1;
  return cz * GRID_W + cx;
}

export function cellXZ(i) { return [i % GRID_W, Math.floor(i / GRID_W)]; }
export function cellIndex(cx, cz) {
  if (cx < 0 || cz < 0 || cx >= GRID_W || cz >= GRID_H) return -1;
  return cz * GRID_W + cx;
}
export function cellCenter(i) {
  return { x: ORIGIN_X + (i % GRID_W + 0.5) * CELL, z: ORIGIN_Z + (Math.floor(i / GRID_W) + 0.5) * CELL };
}
export function zBand(z) { return Math.floor((z - ORIGIN_Z) / CELL / BAND_CELLS); }
export function bandCenterZ(band) { return ORIGIN_Z + (band + 0.5) * BAND_CELLS * CELL; }

// ---------------------------------------------------------------- terrain cache

let terrainCache = null;

// Static per-cell terrain facts for the current terrain seed (computed once
// per seed). water: 0 land, 1 deep, 2 ford. flood: how deep a great flood
// stands on the cell (the floodplain; all 0 in version-1 valleys).
export function terrainGrid() {
  if (terrainCache && terrainCache.seed === terrainKey()) return terrainCache;
  const water = new Uint8Array(CELLS);
  const height = new Float32Array(CELLS);
  const slope = new Float32Array(CELLS);
  const flood = new Float32Array(CELLS);
  const floods = terrainVersion() >= 2;
  for (let i = 0; i < CELLS; i++) {
    const { x, z } = cellCenter(i);
    height[i] = heightAt(x, z);
    if (waterAt(x, z)) water[i] = fordAt(x, z) ? 2 : 1;
    else if (floods) flood[i] = floodDepthAt(x, z);
  }
  for (let cz = 0; cz < GRID_H; cz++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const i = cz * GRID_W + cx;
      const h = height[i];
      let d = 0;
      if (cx + 1 < GRID_W) d = Math.max(d, Math.abs(height[i + 1] - h));
      if (cx > 0) d = Math.max(d, Math.abs(height[i - 1] - h));
      if (cz + 1 < GRID_H) d = Math.max(d, Math.abs(height[i + GRID_W] - h));
      if (cz > 0) d = Math.max(d, Math.abs(height[i - GRID_W] - h));
      slope[i] = water[i] ? 0 : d / CELL;
    }
  }
  terrainCache = { seed: terrainKey(), water, height, slope, flood, floods };
  return terrainCache;
}

// ---------------------------------------------------------------- state

export function createRoads() {
  const roads = {
    cell: CELL, W: GRID_W, H: GRID_H, ox: ORIGIN_X, oz: ORIGIN_Z,
    wear: new Float32Array(CELLS),
    tier: new Uint8Array(CELLS),
    planned: new Uint8Array(CELLS),
    low: new Uint8Array(CELLS),
    embanked: new Uint8Array(GRID_H),
    embankRev: 0,
    xings: {},
    routes: {},
    counts: [CELLS, 0, 0, 0, 0, 0],
    version: 0,
    navRev: 0,
    dirty: null,
    wearAddedMonth: 0,
  };
  markFords(roads);
  return roads;
}

// Ford bits follow terrainGrid: only cells in a shallow band across the whole
// channel, not the shallow edges of the banks.
function markFords(r) {
  const { water } = terrainGrid();
  for (let i = 0; i < CELLS; i++) {
    if (water[i] === 2) r.planned[i] |= FLAG.FORD;
    else r.planned[i] &= ~FLAG.FORD;
  }
  r.fordsMarked = 1;
  r.fordsSeed = terrainKey();
}

// Fills fields missing from older or partial saves. Safe to call often.
export function ensureRoads(state) {
  if (!state.roads) state.roads = createRoads();
  if (state.roads.W !== GRID_W) migrateRoads(state);
  const r = state.roads;
  if (!r.low) r.low = new Uint8Array(CELLS);
  if (!r.embanked) r.embanked = new Uint8Array(GRID_H);
  r.embankRev ??= 0;
  if (!r.xings) r.xings = {};
  if (!r.routes) r.routes = {};
  if (!r.counts) r.counts = recount(r);
  if (!r.fordsMarked || (r.fordsSeed ?? null) !== terrainKey()) markFords(r);
  r.version ??= 0;
  r.navRev ??= 0;
  r.wearAddedMonth ??= 0;
  return r;
}

// Older saves (and other modules' fresh roads) may use a smaller grid with
// the same cell size: copy every per-cell array into the region grid.
function migrateRoads(state) {
  const old = state.roads;
  const next = createRoads();
  const dx = Math.round((old.ox - ORIGIN_X) / CELL), dz = Math.round((old.oz - ORIGIN_Z) / CELL);
  for (const key of ['wear', 'tier', 'planned', 'low']) {
    const src = old[key];
    if (!src) continue;
    const dst = next[key];
    for (let z = 0; z < old.H; z++)
      for (let x = 0; x < old.W; x++) {
        const j = cellIndex(x + dx, z + dz);
        if (j >= 0) dst[j] = src[z * old.W + x];
      }
  }
  if (old.embanked) for (let z = 0; z < old.H; z++) if (z + dz >= 0 && z + dz < GRID_H) next.embanked[z + dz] = old.embanked[z];
  for (const k of ['xings', 'version', 'navRev', 'wearAddedMonth', 'worksDone', 'embankRev', 'towpathEra', 'reclaim']) if (old[k] != null) next[k] = old[k];
  // Crossing bands are numbered from the origin: shift them too.
  const shift = Math.round(dz / BAND_CELLS);
  next.xings = Object.fromEntries(Object.entries(old.xings ?? {}).map(([band, n]) => [String(Number(band) + shift), n]));
  next.counts = recount(next);
  next.routes = {};
  next.version = (old.version ?? 0) + 1;
  next.dirty = { x0: 0, z0: 0, x1: GRID_W - 1, z1: GRID_H - 1 };
  state.roads = next;
}

function recount(r) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < CELLS; i++) counts[r.tier[i]]++;
  return counts;
}

export function markDirty(r, i) {
  const cx = i % GRID_W, cz = (i - cx) / GRID_W;
  const d = r.dirty;
  if (!d) { r.dirty = { x0: cx, z0: cz, x1: cx, z1: cz }; return; }
  if (cx < d.x0) d.x0 = cx; else if (cx > d.x1) d.x1 = cx;
  if (cz < d.z0) d.z0 = cz; else if (cz > d.z1) d.z1 = cz;
}

function markDirtyRect(r, x0, z0, x1, z1) {
  markDirty(r, cellIndex(x0, z0));
  markDirty(r, cellIndex(x1, z1));
}

// ---------------------------------------------------------------- road adjacency

// Count of tier >= 3 neighbours per cell (8-neighbourhood). Derived data, kept
// out of state and rebuilt on demand.
const adjacency = new WeakMap();

function adjacencyOf(r) {
  let adj = adjacency.get(r);
  if (adj) return adj;
  adj = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) if (r.tier[i] >= 3) bumpNeighbours(adj, i, 1);
  adjacency.set(r, adj);
  return adj;
}

function bumpNeighbours(adj, i, delta) {
  const cx = i % GRID_W, cz = (i - cx) / GRID_W;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const j = cellIndex(cx + dx, cz + dz);
      if (j >= 0) adj[j] += delta;
    }
  }
}

export function roadAdjacent(state, i) { return adjacencyOf(state.roads)[i] > 0; }

// ---------------------------------------------------------------- tiers

export function setTier(state, i, tier) {
  const r = state.roads;
  const old = r.tier[i];
  if (old === tier) return false;
  const adj = adjacency.get(r);
  if (adj && (old >= 3) !== (tier >= 3)) bumpNeighbours(adj, i, tier >= 3 ? 1 : -1);
  r.tier[i] = tier;
  structuralDirty.get(r)?.add(i);
  // Path nodes depend on which cells are paths, not on their tiers.
  if ((old >= 1) !== (tier >= 1)) nodesDirty(r, i);
  r.counts[old]--;
  r.counts[tier]++;
  r.low[i] = 0;
  r.version++;
  markDirty(r, i);
  return true;
}

export function organicTier(wear, era) {
  const max = ORGANIC_MAX[clampEra(era)];
  let t = 0;
  while (t < max && wear >= UPGRADE_AT[t + 1]) t++;
  return t;
}

function clampEra(era) { return Math.max(0, Math.min(5, era | 0)); }

function maybeUpgrade(state, i) {
  const r = state.roads;
  const tier = r.tier[i];
  if (tier >= 3 || terrainGrid().water[i]) return;
  const t = organicTier(r.wear[i], state.era ?? 0);
  if (t > tier) setTier(state, i, t);
}

export function countTier(state, minTier) {
  const c = state.roads.counts;
  let n = 0;
  for (let t = minTier; t <= 5; t++) n += c[t];
  return n;
}

// ---------------------------------------------------------------- wear

function rainy(state) { return (state.weather?.rain ?? 0) > 0.5; }

export function addWearAt(state, i, amount = WEAR_STEP) {
  if (i < 0) return;
  // Nobody walks inside a building, and people keep off the crops.
  const fp = footprints(state);
  if (fp.blocked[i] || fp.field[i] === FIELD.CROP) return;
  const r = state.roads;
  const a = r.tier[i] <= 1 && rainy(state) ? amount * RAIN_MUD : amount;
  r.wear[i] += a;
  r.wearAddedMonth += a;
  markDirty(r, i);
  maybeUpgrade(state, i);
}

// Called once per cell a walker enters.
export function addWear(state, x, z, amount = WEAR_STEP) {
  addWearAt(state, cellOf(x, z), amount);
}

export function wearNorm(wear) { return Math.min(1, Math.max(0, Math.log1p(wear) / Math.log1p(3000))); }

// ---------------------------------------------------------------- costs

export function speedAt(state, x, z) {
  const i = cellOf(x, z);
  return i < 0 ? 1 : TIER_SPEED[state.roads.tier[i]];
}

export function isBridge(r, i) { return (r.planned[i] & FLAG.BRIDGE) !== 0 && r.tier[i] >= 2; }

// Fords near a finished bridge are closed to walkers: they take the deck.
// (Still water to look at; carts are not simulated separately.)
export const FORD_NEAR_BRIDGE_COST = Infinity;
const FORD_BRIDGE_REACH = 24;     // world units (12 cells) along the river
const fordMaskCache = new WeakMap();

function fordsNearBridges(state) {
  const bridges = (state.buildings ?? []).filter(b => b.type === 'bridge' && (b.built ?? 1) >= 1);
  const key = bridges.map(b => `${b.id}:${Math.round(b.z)}`).join(',');
  let hit = fordMaskCache.get(state);
  if (hit && hit.key === key) return hit.mask;
  const mask = new Uint8Array(CELLS);
  const { water } = terrainGrid();
  const reach = Math.ceil(FORD_BRIDGE_REACH / CELL) + 6;
  for (const b of bridges) {
    const [cx, cz] = cellXZ(cellOf(b.x, b.z));
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++) {
        const j = cellIndex(cx + dx, cz + dz);
        if (j < 0 || water[j] !== 2) continue;
        const c = cellCenter(j);
        if (Math.abs(c.z - b.z) <= FORD_BRIDGE_REACH) mask[j] = 1;
      }
  }
  fordMaskCache.set(state, { key, mask });
  return mask;
}

function fordCost(state, i) { return fordsNearBridges(state)[i] ? FORD_NEAR_BRIDGE_COST : FORD_COST; }

// A* cost of entering a cell. Infinity means impassable.
export function roadCost(state, i) {
  if (i < 0 || i >= CELLS) return Infinity;
  const r = state.roads;
  const { water, slope } = terrainGrid();
  if (water[i]) {
    if (isBridge(r, i)) return TIER_COST[r.tier[i]];
    return water[i] === 2 ? fordCost(state, i) : Infinity;
  }
  const fp = footprints(state);
  if (fp.blocked[i] || tooSteep(terrainGrid(), i)) return Infinity;
  return landCost(r.tier[i], r.wear[i], adjacencyOf(r)[i], fp.field[i], slope[i]);
}

// Below tier 3, wear eases the cost part of the way toward the next tier, so
// walkers prefer trodden ground before it becomes a trail and paths converge.
const WEAR_PULL = 0.6;

function landCost(tier, wear, adj, field, slope) {
  let c = TIER_COST[tier];
  if (tier < 3) {
    const t = Math.min(1, Math.max(0, (wear - UPGRADE_AT[tier]) / (UPGRADE_AT[tier + 1] - UPGRADE_AT[tier])));
    c -= (c - TIER_COST[tier + 1]) * WEAR_PULL * t;
  }
  if (tier < 3 && adj > 0 && c > ADJ_COST) c = ADJ_COST;
  if (field === FIELD.CROP) c = FIELD_COST;
  else if (field === FIELD.LAWN && tier === 0) c = LAWN_COST;
  return c + slope * SLOPE_COST;
}

// ---------------------------------------------------------------- footprints

// Building footprints block movement except at their door cell. Farms and
// parks are fields: passable but a little slow.
const footprintCache = new WeakMap();

// Call after adding, removing or resizing a building footprint.
export function bumpWorld(state) { state.worldVersion = (state.worldVersion ?? 0) + 1; }

export function footprintKey(state) {
  return `${state.worldVersion ?? 0}:${state.buildings?.length ?? 0}`;
}

export function footprints(state) {
  const wv = state.worldVersion ?? 0, len = state.buildings?.length ?? 0;
  let fp = footprintCache.get(state);
  if (fp && fp.wv === wv && fp.len === len) return fp;
  const key = `${wv}:${len}`;
  fp = { key, wv, len, blocked: new Int32Array(CELLS), field: new Uint8Array(CELLS) };
  for (const b of state.buildings ?? []) stampBuilding(fp, b);
  footprintCache.set(state, fp);
  return fp;
}

export function buildingCells(b) {
  const cx0 = Math.floor((b.x - b.w / 2 - ORIGIN_X) / CELL + 0.001);
  const cz0 = Math.floor((b.z - b.d / 2 - ORIGIN_Z) / CELL + 0.001);
  const cx1 = Math.ceil((b.x + b.w / 2 - ORIGIN_X) / CELL - 0.001) - 1;
  const cz1 = Math.ceil((b.z + b.d / 2 - ORIGIN_Z) / CELL - 0.001) - 1;
  return { cx0, cz0, cx1: Math.max(cx0, cx1), cz1: Math.max(cz0, cz1) };
}

// rot 0..3 is the direction the front faces: 0 +z, 1 +x, 2 -z, 3 -x.
export const ROT_DIR = [[0, 1], [1, 0], [0, -1], [-1, 0]];

// The footprint cell in the middle of the front edge.
export function doorCell(b) {
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  const mx = (cx0 + cx1) >> 1, mz = (cz0 + cz1) >> 1;
  const rot = b.rot ?? 0;
  if (rot === 0) return cellIndex(mx, cz1);
  if (rot === 1) return cellIndex(cx1, mz);
  if (rot === 2) return cellIndex(mx, cz0);
  return cellIndex(cx0, mz);
}

// The cell just outside the door: where the building meets the street.
export function frontCell(b) {
  const door = doorCell(b);
  const [cx, cz] = cellXZ(door);
  const [dx, dz] = ROT_DIR[b.rot ?? 0];
  return cellIndex(cx + dx, cz + dz);
}

// Where people go to enter: the doorstep just outside the door (never inside
// the walls). Farms: their gate cell on the headland.
export function doorPoint(b) {
  if (b.type === 'farm' || b.type === 'park') return cellCenter(doorCell(b));
  const front = frontCell(b);
  return cellCenter(front >= 0 ? front : doorCell(b));
}

function stampBuilding(fp, b) {
  if (b.type === 'bridge') return;
  if (b.type === 'farm' || b.type === 'park') return stampField(fp, b);
  // Conservative: every cell the footprint (plus a walker's margin) touches.
  const m = PERSON_MARGIN;
  const cx0 = Math.floor((b.x - b.w / 2 - m - ORIGIN_X) / CELL);
  const cz0 = Math.floor((b.z - b.d / 2 - m - ORIGIN_Z) / CELL);
  const cx1 = Math.floor((b.x + b.w / 2 + m - ORIGIN_X) / CELL - 1e-6);
  const cz1 = Math.floor((b.z + b.d / 2 + m - ORIGIN_Z) / CELL - 1e-6);
  for (let z = cz0; z <= cz1; z++)
    for (let x = cx0; x <= cx1; x++) {
      const j = cellIndex(x, z);
      if (j >= 0) fp.blocked[j] = b.id + 1;
    }
  for (const j of [doorCell(b), frontCell(b)]) if (j >= 0 && fp.blocked[j] === b.id + 1) fp.blocked[j] = 0;
}

// Farms: crops inside, a one-cell headland ring people may walk and wear.
// Parks: lawn throughout.
function stampField(fp, b) {
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  const crop = b.type === 'farm';
  for (let z = cz0; z <= cz1; z++)
    for (let x = cx0; x <= cx1; x++) {
      const j = cellIndex(x, z);
      if (j < 0) continue;
      const edge = x === cx0 || x === cx1 || z === cz0 || z === cz1;
      if (!crop) fp.field[j] = FIELD.LAWN;
      else if (!edge) fp.field[j] = FIELD.CROP;
    }
}

// Is the rest of a flat [x, z, ...] route still clear of buildings, from the
// waypoint at flat index fromIndex? Visits every cell each segment passes
// through (a grid traversal: a leg clipping the corner of a wall by a hair
// counts), except the cell the walk starts in.
export function routeStillValid(state, route, fromIndex = 0) {
  if (!route || route.length < 4) return true;
  const { blocked } = footprints(state);
  for (let k = Math.max(0, fromIndex); k + 3 < route.length; k += 2) {
    if (!segmentClear(blocked, route[k], route[k + 1], route[k + 2], route[k + 3], k === fromIndex)) return false;
  }
  return true;
}

// routeStillValid of [x, z, ...route from flat index seg] without building
// that list: the walk from (x, z) to the waypoint skips its starting cell.
export function routeClearFrom(state, x, z, route, seg) {
  if (!route || seg + 1 >= route.length) return true;
  const { blocked } = footprints(state);
  if (!segmentClear(blocked, x, z, route[seg], route[seg + 1], true)) return false;
  for (let k = seg; k + 3 < route.length; k += 2) {
    if (!segmentClear(blocked, route[k], route[k + 1], route[k + 2], route[k + 3], false)) return false;
  }
  return true;
}

function segmentClear(blocked, ax, az, bx, bz, skipFirst) {
  let x = Math.floor((ax - ORIGIN_X) / CELL), z = Math.floor((az - ORIGIN_Z) / CELL);
  const ex = Math.floor((bx - ORIGIN_X) / CELL), ez = Math.floor((bz - ORIGIN_Z) / CELL);
  const dx = bx - ax, dz = bz - az;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(CELL / dx) : Infinity, tdz = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
  let tx = dx !== 0 ? ((sx > 0 ? x + 1 : x) * CELL + ORIGIN_X - ax) / dx : Infinity;
  let tz = dz !== 0 ? ((sz > 0 ? z + 1 : z) * CELL + ORIGIN_Z - az) / dz : Infinity;
  const n = Math.abs(ex - x) + Math.abs(ez - z);
  for (let k = 0; ; k++) {
    if (!(skipFirst && k === 0)) {
      const c = cellIndex(x, z);
      if (c >= 0 && blocked[c]) return false;
    }
    if (k >= n) return true;
    if (tx < tz) { x += sx; tx += tdx; } else { z += sz; tz += tdz; }
  }
}

// ---------------------------------------------------------------- nav grid

// The grid handed to navigation (main thread or worker): one cost per cell and
// a water code (0 land, 1 deep, 2 ford, 3 bridge). Rebuilt when roads change
// tier bucket, planned works land, footprints change, or every NAV_MONTHS
// months so that fresh wear starts to pull walkers together.
export const VERSION_BUCKET = 16;
export const NAV_MONTHS = 2;
const navCache = new WeakMap();

function navBucket(state) {
  const r = state.roads;
  const months = (state.time?.year ?? 0) * 12 + (state.time?.month ?? 0);
  return `${Math.floor(r.version / VERSION_BUCKET)}:${r.navRev}:${Math.floor(months / NAV_MONTHS)}`;
}

export function navKey(state) {
  return `${navBucket(state)}:${footprintKey(state)}`;
}

// Footprint-only changes (a new building, a demolition) patch the previous
// grid's cells in place instead of rebuilding, and are coalesced to at most
// one patch every FOOTPRINT_TICKS ticks after the last one. States without roads get them lazily.
const FOOTPRINT_TICKS = 10;

// fresh: skip the coalescing (a caller found a route through a new building).
export function navGrid(state, { fresh = false } = {}) {
  ensureRoads(state);
  const key = navKey(state);
  let grid = navCache.get(state);
  if (grid && grid.key === key) return grid;
  const bucket = navBucket(state);
  const tick = state.time?.tick ?? 0;
  if (grid && grid.bucket === bucket) {
    if (!fresh && grid.patchedAt != null && tick - grid.patchedAt < FOOTPRINT_TICKS && tick >= grid.patchedAt) return grid;
    grid = patchFootprints(state, grid, key, tick);
  } else {
    grid = buildNavGrid(state, key, bucket, tick, grid);
  }
  navCache.set(state, grid);
  return grid;
}

function cellCost(state, i, fp, adj, fords = fordsNearBridges(state)) {
  const r = state.roads;
  const t = terrainGrid();
  const w = t.water[i];
  if (w) return isBridge(r, i) ? TIER_COST[r.tier[i]] : w === 2 ? (fords[i] ? FORD_NEAR_BRIDGE_COST : FORD_COST) : Infinity;
  if (fp.blocked[i] || tooSteep(t, i)) return Infinity;
  return landCost(r.tier[i], r.wear[i], adj[i], fp.field[i], t.slope[i]);
}

function tooSteep(t, i) { return t.slope[i] > NAV_MAX_SLOPE || t.height[i] > NAV_MAX_HEIGHT; }

// Path nodes (path-nodes.js): where the drawn centreline of each path cell
// runs, in world units (NaN off the paths), and which neighbours it links to,
// for waypoints that follow the drawn lines.
const NAV_GEOM = { W: GRID_W, H: GRID_H, cell: CELL, ox: ORIGIN_X, oz: ORIGIN_Z };
function navNodes(r) { return buildNodes(NAV_GEOM, r.tier, r.planned); }
// A copy of `prev`'s nodes with every node the changed cells can move redone.
function patchedNodes(r, prev, dirty) {
  const nodes = { nodeX: prev.nodeX.slice(), nodeZ: prev.nodeZ.slice(), nodeLinks: prev.nodeLinks.slice() };
  patchNodes(NAV_GEOM, r.tier, r.planned, nodes, dirty);
  return nodes;
}
// roads -> cells that became or stopped being paths, or changed towpath or
// planned flag, since navGrid's / structuralGrid's nodes were built.
const navNodeDirty = new WeakMap();
const structuralNodeDirty = new WeakMap();
// The nodes around cell i may move.
function nodesDirty(r, i) {
  navNodeDirty.get(r)?.add(i);
  structuralNodeDirty.get(r)?.add(i);
}
// grid -> the roads its nodes were made from.
const nodeOwner = new WeakMap();
// Nodes for a new grid over roads r: the previous grid's (prev, of the same
// roads), patched for the cells changed since (`dirtyMap`), or a fresh build;
// both give exactly the same nodes.
function nodesFor(r, prev, dirtyMap) {
  const dirty = dirtyMap.get(r);
  const nodes = !prev || nodeOwner.get(prev) !== r || !dirty ? navNodes(r)
    : dirty.size ? patchedNodes(r, prev, dirty) : { nodeX: prev.nodeX, nodeZ: prev.nodeZ, nodeLinks: prev.nodeLinks };
  dirtyMap.set(r, new Set());
  return nodes;
}
function owned(grid, r) { nodeOwner.set(grid, r); return grid; }

function buildNavGrid(state, key, bucket, tick, prev) {
  const r = state.roads;
  const { water } = terrainGrid();
  const adj = adjacencyOf(r);
  const fp = footprints(state);
  const fords = fordsNearBridges(state);
  const cost = new Float32Array(CELLS);
  const wcode = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    wcode[i] = water[i] ? (isBridge(r, i) ? 3 : water[i]) : 0;
    cost[i] = cellCost(state, i, fp, adj, fords);
  }
  const nodes = nodesFor(r, prev, navNodeDirty);
  return owned({ key, bucket, tick, footprintsOnly: false, fp, W: GRID_W, H: GRID_H, ox: ORIGIN_X, oz: ORIGIN_Z, cell: CELL, cost, water: wcode, height: terrainGrid().height, ...nodes }, r);
}

// A new grid object (consumers compare identity and keys) sharing the water
// codes, with only the cells whose footprint changed recomputed.
function patchFootprints(state, prev, key, tick) {
  const fp = footprints(state);
  const adj = adjacencyOf(state.roads);
  const fords = fordsNearBridges(state);
  const cost = prev.cost.slice();
  const old = prev.fp;
  for (let i = 0; i < CELLS; i++) {
    if (old.blocked[i] !== fp.blocked[i] || old.field[i] !== fp.field[i]) cost[i] = cellCost(state, i, fp, adj, fords);
  }
  // The nodes are shared while no path cell has changed since they were
  // built; otherwise a copy has the nodes around those cells redone.
  const r = state.roads;
  const nodes = nodesFor(r, prev, navNodeDirty);
  return owned({ ...prev, key, tick, patchedAt: tick, footprintsOnly: true, fp, cost, ...nodes, comp: undefined, coarse: undefined }, r);
}

// The grid for simulation-side routes (aggregate group traffic). It must be
// a pure function of saved state so a restored town replays exactly, so it
// ignores wear softening (wear at an arbitrary build moment) and coalescing,
// and every tier change since it was built is patched in before it is used.
const structuralCache = new WeakMap();
const structuralDirty = new WeakMap();   // roads -> cells whose tier changed since the build

export function structuralGrid(state) {
  ensureRoads(state);
  const r = state.roads;
  const base = `${r.navRev}:${footprintKey(state)}`;
  let grid = structuralCache.get(state);
  if (grid && grid.base === base && grid.roads === r) {
    const dirty = structuralDirty.get(r), nodeDirty = structuralNodeDirty.get(r);
    if (!dirty?.size && !nodeDirty?.size) return grid;
    grid = owned(patchStructural(state, grid, dirty, nodeDirty), r);
    dirty.clear();
    nodeDirty.clear();
    structuralCache.set(state, grid);
    return grid;
  }
  const prev = grid;
  const cost = new Float32Array(CELLS);
  const wcode = new Uint8Array(CELLS);
  const ctx = structuralContext(state);
  for (let i = 0; i < CELLS; i++) structuralCell(ctx, i, cost, wcode);
  const nodes = nodesFor(r, prev, structuralNodeDirty);
  grid = owned({ key: `${base}:${r.version}`, bucket: base, base, roads: r, W: GRID_W, H: GRID_H, ox: ORIGIN_X, oz: ORIGIN_Z, cell: CELL, cost, water: wcode, height: terrainGrid().height, ...nodes }, r);
  structuralCache.set(state, grid);
  structuralDirty.set(r, new Set());
  return grid;
}

function structuralContext(state) {
  const r = state.roads;
  return { r, t: terrainGrid(), adj: adjacencyOf(r), fp: footprints(state), fords: fordsNearBridges(state) };
}

function structuralCell({ r, t, adj, fp, fords }, i, cost, wcode) {
  const w = t.water[i];
  if (w) {
    const bridge = isBridge(r, i);
    wcode[i] = bridge ? 3 : w;
    cost[i] = bridge ? TIER_COST[r.tier[i]] : w === 2 ? (fords[i] ? FORD_NEAR_BRIDGE_COST : FORD_COST) : Infinity;
  } else {
    const tier = r.tier[i];
    wcode[i] = 0;
    cost[i] = fp.blocked[i] || tooSteep(t, i) ? Infinity : landCost(tier, UPGRADE_AT[Math.min(tier, 3)], adj[i], fp.field[i], t.slope[i]);
  }
}

// A changed cell and its neighbours (their road adjacency counts may change too),
// into a copy: anything cached on the old grid object stays with it.
function patchStructural(state, prev, dirty, nodeDirty) {
  const cost = prev.cost.slice(), wcode = prev.water.slice();
  const nodes = nodeDirty.size ? patchedNodes(state.roads, prev, nodeDirty) : { nodeX: prev.nodeX, nodeZ: prev.nodeZ, nodeLinks: prev.nodeLinks };
  const ctx = structuralContext(state);
  for (const i of dirty) {
    const cx = i % GRID_W, cz = (i - cx) / GRID_W;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x >= 0 && z >= 0 && x < GRID_W && z < GRID_H) structuralCell(ctx, z * GRID_W + x, cost, wcode);
      }
  }
  return { ...prev, key: `${prev.base}:${state.roads.version}`, cost, water: wcode, ...nodes, comp: undefined, coarse: undefined, blockCost: undefined };
}

// ---------------------------------------------------------------- crossings

export function recordCrossing(state, z, weight = 1) {
  const band = String(zBand(z));
  const x = state.roads.xings;
  x[band] = (x[band] ?? 0) + weight;
}

export function recordCrossingBand(state, band, weight = 1) {
  const x = state.roads.xings;
  x[band] = (x[band] ?? 0) + weight;
}

// ---------------------------------------------------------------- monthly pass

export function monthlyRoads(state, ctx = {}) {
  const r = ensureRoads(state);
  if ((state.era ?? 0) >= TOWPATH_PAVED_ERA && r.towpathEra !== TOWPATH_PAVED_ERA) paveTowpaths(state);
  applyGroupTraffic(state);
  recordCrossRiverTies(state, !!ctx.skipPeople);
  consolidateWear(state);
  decayAndRetier(state);
  bridgeGaps(state);
  seedReclaimedPaths(state);
  for (const k of Object.keys(r.xings)) {
    r.xings[k] *= XING_DECAY;
    if (r.xings[k] < 0.5) delete r.xings[k];
  }
  // Bridge traffic decays the same way (a running year's worth of trips).
  for (const b of state.buildings ?? []) if (b.type === 'bridge' && b.traffic) b.traffic *= XING_DECAY;
}

function decayAndRetier(state) {
  const r = state.roads;
  const { wear, tier, low } = r;
  const { water, slope } = terrainGrid();
  const { blocked, field } = footprints(state);
  const era = state.era ?? 0;
  let x0 = GRID_W, z0 = GRID_H, x1 = -1, z1 = -1;
  for (let i = 0; i < CELLS; i++) {
    let w = wear[i];
    const t = tier[i];
    if (w === 0 && t === 0) continue;
    if (t <= 2) {
      w *= DECAY - EROSION * Math.min(1, slope[i] / 0.4);
      if (w < 0.5) w = 0;
    } else if (w > UPGRADE_AT[3]) {
      w = Math.max(UPGRADE_AT[3], w * DECAY);
    }
    wear[i] = w;
    const cx = i % GRID_W, cz = (i - cx) / GRID_W;
    if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
    if (cz < z0) z0 = cz; if (cz > z1) z1 = cz;
    if (t >= 3 || water[i] || blocked[i] || field[i] === FIELD.CROP) continue;
    const up = organicTier(w, era);
    if (up > t) { setTier(state, i, up); continue; }
    const rule = (r.planned[i] & FLAG.PLANNED) ? null : DOWNGRADE[t];
    if (rule && w < rule.below) {
      if (++low[i] >= rule.months) setTier(state, i, t - 1);
    } else {
      low[i] = 0;
    }
  }
  if (x1 >= 0) markDirtyRect(r, x0, z0, x1, z1);
}

// ---------------------------------------------------------------- orderly paths

// Desire lines braid: walkers a step to one side of a busy lane wear a
// second, fainter lane beside it, and wide smears form where many routes
// nearly agree. Each month a little of the wear on the flank of a busier
// lane drifts onto it (people step onto the trodden line), so braids close
// into one lane and smears narrow to their ridge. A cell is a flank when a
// 4-neighbour carries at least FLANK_RATIO times its wear and the cell on
// its other side is fainter still; a path crossing a lane (worn on both
// sides along its own line) is not a flank and keeps its wear.
export const FLANK_RATIO = 2;
export const FLANK_SHARE = 0.08;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
let flankScratch = null;

function consolidateWear(state) {
  const r = state.roads;
  const { wear, tier, planned } = r;
  const { water } = terrainGrid();
  const { blocked, field } = footprints(state);
  if (!flankScratch) flankScratch = { to: new Int32Array(CELLS), list: [] };
  const { to, list } = flankScratch;
  list.length = 0;
  for (let i = 0; i < CELLS; i++) {
    const w = wear[i];
    if (w < 5 || tier[i] > 2 || (planned[i] & FLAG.PLANNED) || water[i] || blocked[i]) continue;
    const cx = i % GRID_W, cz = (i - cx) / GRID_W;
    let best = -1, bestW = w * FLANK_RATIO, bd = 0;
    for (let d = 0; d < 4; d++) {
      const j = cellIndex(cx + N4[d][0], cz + N4[d][1]);
      if (j < 0 || wear[j] < bestW || tier[j] < tier[i] || water[j] || blocked[j] || field[j] === FIELD.CROP) continue;
      if (wear[j] === bestW && best >= 0 && j > best) continue;
      best = j; bestW = wear[j]; bd = d;
    }
    if (best < 0) continue;
    const o = cellIndex(cx - N4[bd][0], cz - N4[bd][1]);
    if (o >= 0 && wear[o] > w * 0.5) continue;
    to[list.length] = best;
    list.push(i);
  }
  // Apply after the scan, so the result does not depend on scan order.
  for (let k = 0; k < list.length; k++) {
    const i = list[k], j = to[k];
    const move = wear[i] * FLANK_SHARE;
    wear[i] -= move;
    wear[j] += move;
    markDirty(r, i);
    markDirty(r, j);
  }
}

// A one-cell break in a line of trodden cells (both opposite neighbours worn
// to at least a trail) is part of the same path: people step over it every
// day. If it carries some wear of its own it takes the lower of the two
// tiers, so paths read and route as continuous lines.
const GAP_PAIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
export const GAP_WEAR = 0.25;

function bridgeGaps(state) {
  const r = state.roads;
  const { wear, tier } = r;
  const { water } = terrainGrid();
  const { blocked, field } = footprints(state);
  const max = ORGANIC_MAX[clampEra(state.era ?? 0)];
  const minWear = GAP_WEAR * UPGRADE_AT[1];
  const W = GRID_W;
  const fill = [];
  // Two cells in from the edge, so every neighbour index below is in range.
  for (let z = 2; z < GRID_H - 2; z++) {
    for (let x = 2, i = z * W + 2; x < W - 2; x++, i++) {
      const t = tier[i];
      if (t >= 3 || wear[i] < minWear || water[i] || blocked[i] || field[i] === FIELD.CROP) continue;
      let want = 0;
      for (let k = 0; k < 4; k++) {
        const dx = GAP_PAIRS[k][0], dz = GAP_PAIRS[k][1];
        const d = dz * W + dx;
        const a = i + d, b = i - d;
        const ta = tier[a], tb = tier[b];
        if (!ta || !tb || ta <= t || tb <= t || water[a] || water[b]) continue;
        // A diagonal break is only a break if the corners beside it are open
        // (otherwise the cells already join, or this is a parallel path).
        if (dx && dz && (tier[i + dx] || tier[i - dx] || tier[i + dz * W] || tier[i - dz * W])) continue;
        const m = Math.min(ta, tb, max);
        if (m <= want || wear[i] < GAP_WEAR * UPGRADE_AT[m]) continue;
        // Both sides must run on away from the gap: a break in one line, not
        // the strip between two parallel paths.
        if (!runsOn(tier, a, dx, dz) || !runsOn(tier, b, -dx, -dz)) continue;
        want = m;
      }
      if (want > t) fill.push(i, want);
    }
  }
  for (let k = 0; k < fill.length; k += 2) {
    const i = fill[k], t = fill[k + 1];
    wear[i] = Math.max(wear[i], UPGRADE_AT[t]);
    if (t > tier[i]) setTier(state, i, t);
  }
}

// Is there a trodden cell beyond cell j, continuing in direction (dx, dz)
// (straight on, or bending by 45 degrees)? j is at least one cell from the edge.
function runsOn(tier, j, dx, dz) {
  const W = GRID_W;
  if (tier[j + dz * W + dx]) return true;
  if (dx && dz) return tier[j + dx] > 0 || tier[j + dz * W] > 0;
  return tier[j + (dz + dx) * W + dx - dz] > 0 || tier[j + (dz - dx) * W + dx + dz] > 0;
}

// Cells to wear through a reclaimed lot once its building is gone
// (reclaim.js queues them; see reclaimDerelicts). Entries wait while the
// demolition runs and lapse after RECLAIM_WAIT_MONTHS.
export const RECLAIM_WAIT_MONTHS = 60;

export function queueReclaimedPath(state, buildingId, cells, tier = 2) {
  const r = state.roads;
  r.reclaim = r.reclaim ?? [];
  r.reclaim.push({ buildingId, cells: cells.slice(), tier, months: 0 });
}

function seedReclaimedPaths(state) {
  const r = state.roads;
  if (!r.reclaim?.length) return;
  const standing = new Set((state.buildings ?? []).map(b => b.id));
  const max = ORGANIC_MAX[clampEra(state.era ?? 0)];
  const keep = [];
  for (const entry of r.reclaim) {
    if (standing.has(entry.buildingId)) {
      if (++entry.months < RECLAIM_WAIT_MONTHS) keep.push(entry);
      continue;
    }
    const { blocked, field } = footprints(state);
    const t = Math.min(entry.tier, max);
    for (const i of entry.cells) {
      if (i < 0 || blocked[i] || field[i] === FIELD.CROP || terrainGrid().water[i]) continue;
      r.wear[i] = Math.max(r.wear[i], UPGRADE_AT[t]);
      if (r.tier[i] < t) setTier(state, i, t);
      markDirty(r, i);
    }
  }
  r.reclaim = keep;
}

// ---------------------------------------------------------------- group traffic

// Trades map to the building types their members walk to each day.
export const TRADE_DESTINATIONS = {
  farm: ['farm', 'mill', 'market'],
  craft: ['workshop', 'mill', 'factory'],
  trade: ['shop', 'market', 'inn', 'warehouse', 'quay', 'exchange'],
  labour: ['mill', 'factory', 'warehouse', 'quay', 'farm', 'workshop'],
  clerical: ['moot', 'school', 'exchange', 'library'],
  clergy: ['chapel'],
  gentry: ['market', 'exchange', 'moot', 'theatre'],
  none: ['market', 'shop', 'chapel'],
  // Everyone's other trip: the market, a shop, the chapel or the moot.
  errand: ['market', 'chapel', 'moot'],
};
const ERRAND_SHARE = 0.5;

// Groups of household members who are not simulated as walkers, keyed by
// district and trade, with the door of their average home and of their work.
// With headless = true (fastForward skips walkers) every member counts, since
// the frozen walkers would otherwise leave no trace.
export function aggregateGroups(state, headless = false) {
  const walkers = new Map();
  if (!headless) for (const p of state.people ?? []) walkers.set(p.householdId, (walkers.get(p.householdId) ?? 0) + 1);
  const byId = buildingMap(state);
  const groups = new Map();
  for (const h of state.households ?? []) {
    const n = (h.size ?? 0) - (walkers.get(h.id) ?? 0);
    const home = byId.get(h.homeId);
    if (n <= 0 || !home) continue;
    // Split by bank, so a group's centre never sits in the river and
    // far-bank commuters really cross.
    const door = doorPoint(home);
    const side = bankSide(door.x, door.z);
    const key = `${h.districtId ?? 0}|${h.trade ?? 'none'}|${side}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, trade: h.trade ?? 'none', size: 0, sx: 0, sz: 0 });
    g.size += n;
    g.sx += door.x * n;
    g.sz += door.z * n;
  }
  const byType = workplacesByType(state);
  for (const g of groups.values()) {
    g.home = { x: g.sx / g.size, z: g.sz / g.size };
    g.work = workFor(byType, g.trade, g.home);
    g.errand = workFor(byType, 'errand', g.home);
  }
  return groups;
}

function buildingMap(state) {
  const m = new Map();
  for (const b of state.buildings ?? []) m.set(b.id, b);
  return m;
}

function workplacesByType(state) {
  const out = new Map();
  for (const b of state.buildings ?? []) {
    if ((b.built ?? 1) < 1) continue;
    if (!out.has(b.type)) out.set(b.type, []);
    out.get(b.type).push(b);
  }
  return out;
}

// Workplaces of each type binned on a 32-unit grid, for nearest searches.
const TBIN = 32;
function binTypes(byType) {
  const out = new Map();
  for (const [type, list] of byType) {
    const bins = new Map();
    for (const b of list) {
      const k = Math.floor((b.x + 512) / TBIN) * 64 + Math.floor((b.z + 512) / TBIN);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(b);
    }
    out.set(type, bins);
  }
  return out;
}

// Nearest building of the trade's types to home, searching rings of bins.
function nearestFor(binned, trade, home) {
  const types = TRADE_DESTINATIONS[trade] ?? TRADE_DESTINATIONS.none;
  const hx = Math.floor((home.x + 512) / TBIN), hz = Math.floor((home.z + 512) / TBIN);
  let best = null, bestD = Infinity;
  for (let r = 0; r < 32; r++) {
    if (best && (r - 1) * TBIN > Math.sqrt(bestD)) break;
    for (const type of types) {
      const bins = binned.get(type);
      if (!bins) continue;
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const b of bins.get((hx + dx) * 64 + hz + dz) ?? []) {
            const d = (b.x - home.x) ** 2 + (b.z - home.z) ** 2;
            if (d < bestD) { bestD = d; best = b; }
          }
        }
    }
  }
  return best ? doorPoint(best) : null;
}

function workFor(byType, trade, home) {
  let best = null, bestD = Infinity;
  for (const type of TRADE_DESTINATIONS[trade] ?? TRADE_DESTINATIONS.none) {
    for (const b of byType.get(type) ?? []) {
      const d = (b.x - home.x) ** 2 + (b.z - home.z) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
  }
  return best ? doorPoint(best) : null;
}

// Refreshes the cached route list for aggregate groups. Routes whose ends
// moved by more than a few cells are marked stale; tickRoads recomputes them.
export function refreshGroups(state, headless = false) {
  const r = state.roads;
  const groups = aggregateGroups(state, headless);
  const next = {};
  const add = (key, home, dest, size) => {
    if (!dest) return;
    const from = nearestOpen(state, cellOf(home.x, home.z));
    const to = nearestOpen(state, cellOf(dest.x, dest.z));
    if (from < 0 || to < 0 || from === to) return;
    const old = r.routes[key];
    const same = old && cellDist(old.from, from) <= 3 && cellDist(old.to, to) <= 3;
    next[key] = same
      ? { ...old, size }
      : { size, from, to, cells: old?.cells ?? null, stale: true };
  };
  for (const g of groups.values()) {
    add(g.key, g.home, g.work, g.size);
    if (g.errand && (!g.work || Math.hypot(g.errand.x - g.work.x, g.errand.z - g.work.z) > 8)) {
      add(`${g.key}|errand`, g.home, g.errand, g.size * ERRAND_SHARE);
    }
  }
  r.routes = next;
}

function cellDist(a, b) {
  const [ax, az] = cellXZ(a), [bx, bz] = cellXZ(b);
  return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

// Nearest passable cell to i within a small radius (doors sit inside
// footprints, and centroids can land on a roof or in the river).
export function nearestOpen(state, i, radius = 6) {
  if (i < 0) return -1;
  if (Number.isFinite(roadCost(state, i)) && !terrainGrid().water[i]) return i;
  const [cx, cz] = cellXZ(i);
  for (let rad = 1; rad <= radius; rad++) {
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
        const j = cellIndex(cx + dx, cz + dz);
        if (j >= 0 && !terrainGrid().water[j] && Number.isFinite(roadCost(state, j))) return j;
      }
  }
  return -1;
}

function applyGroupTraffic(state) {
  const r = state.roads;
  for (const route of Object.values(r.routes)) {
    if (!route.cells?.length) continue;
    const amount = WEAR_STEP * route.size * GROUP_WEAR;
    for (const i of route.cells) addWearAt(state, i, amount);
    // Each member makes the round trip about once a month: two crossings
    // (bridge demand is per year, >= 400).
    // (Crossing demand comes from crossRiverTies, which counts every
    // household with ties across the river, so it is not counted here.)
  }
}

// ---------------------------------------------------------------- cross-river ties

// Households whose home is on one bank and whose work or errands are on the
// other. Each such household's unseen members (walkers count their own trips)
// add their monthly round trips to the band of the crossing they use: the
// nearest ford or bridge, or, more than 40 cells away, the band they want.
const TRIPS_PER_MONTH = 2;
const tieCache = new WeakMap();

export function crossRiverTies(state) {
  const tick = `${state.time?.tick ?? 0}:${state.households?.length ?? 0}:${state.buildings?.length ?? 0}`;
  const hit = tieCache.get(state);
  if (hit && hit.tick === tick) return hit.ties;
  const walkers = new Map();
  for (const p of state.people ?? []) walkers.set(p.householdId, (walkers.get(p.householdId) ?? 0) + 1);
  const byId = buildingMap(state);
  const byType = workplacesByType(state);
  // Neighbours share destinations: one search per trade and 16-unit block.
  // Households of one district, trade and bank share their destinations:
  // one search per group (from the group's first home).
  const binned = binTypes(byType);
  const memo = new Map();
  const destFor = (trade, home, h, side) => {
    const key = `${h.districtId ?? 0}|${trade}|${side}`;
    let dest = memo.get(key);
    if (dest === undefined) { dest = nearestFor(binned, trade, home); memo.set(key, dest); }
    return dest;
  };
  const ties = [];
  for (const h of state.households ?? []) {
    const home = byId.get(h.homeId);
    if (!home) continue;
    const side = bankSide(home.x, home.z);
    for (const dest of [destFor(h.trade ?? 'none', home, h, side), destFor('errand', home, h, side)]) {
      if (!dest || bankSide(dest.x, dest.z) === side) continue;
      ties.push({ h, members: Math.max(0, (h.size ?? 1) - (walkers.get(h.id) ?? 0)), size: h.size ?? 1, z: (home.z + dest.z) / 2, from: home, to: dest });
      break;
    }
  }
  tieCache.set(state, { tick, ties });
  return ties;
}

// The share of households with ties across the river.
export function crossRiverShare(state) {
  const n = (state.households ?? []).filter(h => h.homeId != null).length;
  return n ? crossRiverTies(state).length / n : 0;
}

// Where a tie crosses: the nearest ford or finished bridge (fords next to a
// bridge are closed, so its users take the bridge), or the band it wants
// when the nearest is more than 40 cells away. {band, bridge|null}
function tieCrossing(state, z, bridges) {
  const open = FORDS.filter(f => !bridges.some(b => Math.abs(b.z - f.z) <= FORD_BRIDGE_REACH));
  let best = null, dist = Infinity, bridge = null;
  for (const f of open) if (Math.abs(f.z - z) < dist) { dist = Math.abs(f.z - z); best = f.z; bridge = null; }
  for (const b of bridges) if (Math.abs(b.z - z) < dist) { dist = Math.abs(b.z - z); best = b.z; bridge = b; }
  const near = best != null && dist <= 40 * CELL;
  return { band: zBand(near ? best : z), bridge: near ? bridge : null };
}

// headless: walkers are frozen, so every member counts. Trips over a
// bridge count as its traffic; trips at a ford count as crossing demand.
function recordCrossRiverTies(state, headless = false) {
  const bridges = (state.buildings ?? []).filter(b => b.type === 'bridge' && (b.built ?? 1) >= 1);
  for (const t of crossRiverTies(state)) {
    const n = headless ? t.size : t.members;
    if (n <= 0) continue;
    const { band, bridge } = tieCrossing(state, t.z, bridges);
    if (bridge) bridge.traffic = (bridge.traffic ?? 0) + n * TRIPS_PER_MONTH;
    recordCrossingBand(state, band, n * TRIPS_PER_MONTH);
  }
}

// Demand per crossing band, per 100 people: {band: crossings a year per 100}.
export function crossingDemand(state) {
  const pop = Math.max(1, state.indicators?.pop ?? (state.households ?? []).reduce((n, h) => n + (h.size ?? 1), 0));
  const out = {};
  for (const [band, n] of Object.entries(state.roads.xings ?? {})) out[band] = Math.round((n / pop) * 100 * 10) / 10;
  return out;
}

// ---------------------------------------------------------------- tick hook

// Per-tick work: refresh the group list once a month and recompute at most
// `ctx.routeBudget` (default 1) stale group routes synchronously.
export function tickRoads(state, ctx = {}) {
  const r = ensureRoads(state);
  const stamp = `${state.time?.year ?? 0}:${state.time?.month ?? 0}`;
  if (r.groupsAt !== stamp) {
    r.groupsAt = stamp;
    refreshGroups(state, !!ctx.skipPeople);
  }
  const budget = ctx.routeBudget ?? 1;
  let done = 0;
  for (const route of Object.values(r.routes)) {
    if (done >= budget) break;
    if (!route.stale) continue;
    const result = findRoute(structuralGrid(state), route.from, route.to, { maxNodes: 20000 });
    route.cells = result.cells ? Array.from(result.cells) : null;
    route.crossings = result.crossings;
    route.stale = false;
    done++;
  }
}

// ---------------------------------------------------------------- walking

// Synchronous route between two world points as a flat [x, z, ...] list,
// with crossing demand recorded. For tests, fixtures and rare one-off trips.
export function routeBetween(state, start, goal, opts = {}) {
  const grid = navGrid(state);
  const from = cellOf(start.x, start.z), to = cellOf(goal.x, goal.z);
  const result = findRoute(grid, from, to, opts);
  if (opts.record !== false) for (const band of result.crossings) recordCrossingBand(state, band);
  return result.cells ? cellsToWaypoints(grid, result.cells, start, goal) : null;
}

// Moves a walker `dist` units (before road speed) along task.route, a flat
// [x, z, ...] list; task.seg is the flat index of the x of the waypoint being
// walked to (0, 2, 4, ...), as in people.js. Adds wear once per cell entered.
// Returns false once the route is finished.
export function stepAlongRoute(state, p, dist) {
  const task = p.task;
  const route = task?.route;
  if (!route || route.length < 2) return false;
  task.seg ??= 0;
  let left = dist;
  while (left > 1e-6 && task.seg < route.length) {
    const tx = route[task.seg], tz = route[task.seg + 1];
    const dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) { task.seg += 2; continue; }
    const m = speedAt(state, p.x, p.z);
    const step = Math.min(d, left * m, CELL * 0.5);
    p.x += dx / d * step;
    p.z += dz / d * step;
    p.heading = Math.atan2(dx, dz);
    left -= step / m;
    enterCell(state, p);
    if (step >= d - 1e-6) task.seg += 2;
  }
  return task.seg < route.length;
}

// Transient last-cell memory, so wear is added once per cell entered.
const lastCell = new WeakMap();

function enterCell(state, p) {
  const i = cellOf(p.x, p.z);
  if (lastCell.get(p) === i) return;
  lastCell.set(p, i);
  addWearAt(state, i);
}

// ---------------------------------------------------------------- planned works support

// Bridges pass uncapped: a deck takes its style's tier in any era.
export function setPlannedTier(state, i, tier, flags = 0, { uncapped = false } = {}) {
  const r = state.roads;
  const max = PLANNED_MAX[clampEra(state.era ?? 0)];
  const t = uncapped ? tier : Math.min(tier, Math.max(max, 3));
  const before = r.planned[i];
  r.planned[i] |= FLAG.PLANNED | flags;
  // Planned cells never join a knot (path-nodes.js): the nodes about it may move.
  if (r.planned[i] !== before) nodesDirty(r, i);
  if (r.planned[i] !== before && t <= r.tier[i]) r.version++;
  if (t > r.tier[i]) setTier(state, i, t);
  if (r.wear[i] < UPGRADE_AT[3] && t >= 3) r.wear[i] = Math.max(r.wear[i], UPGRADE_AT[3]);
  markDirty(r, i);
}

// ---------------------------------------------------------------- towpaths

// The walkable strip along the water: a track at first, a paved promenade
// from the Borough era. Laid by embankments and by waterfront aprons; it
// never fades and wears like any path.
export const TOWPATH_PAVED_ERA = 3;

export function setTowpath(state, i) {
  if (i < 0 || terrainGrid().water[i] || footprints(state).blocked[i]) return false;
  const r = state.roads;
  const before = r.planned[i];
  r.planned[i] |= FLAG.TOWPATH | FLAG.PLANNED;
  const tier = (state.era ?? 0) >= TOWPATH_PAVED_ERA ? 4 : 2;
  if (r.tier[i] < tier) setTier(state, i, tier);
  else if (before !== r.planned[i]) {
    // A new towpath flag moves this cell's path node onto the bank lane.
    structuralDirty.get(r)?.add(i);
    nodesDirty(r, i);
    r.version++;
  }
  markDirty(r, i);
  return true;
}

function paveTowpaths(state) {
  const r = state.roads;
  for (let i = 0; i < CELLS; i++) if ((r.planned[i] & FLAG.TOWPATH) && r.tier[i] < 4) setTier(state, i, 4);
  r.towpathEra = TOWPATH_PAVED_ERA;
  bumpNav(state);
}

// Planned works change connectivity (bridges) or costs a lot at once, so they
// force a fresh navigation grid.
export function bumpNav(state) { state.roads.navRev++; }

export function lampPositions(state) {
  const r = state.roads;
  const out = [];
  for (let i = 0; i < CELLS; i++) if (r.planned[i] & FLAG.LAMP) out.push(cellCenter(i));
  return out;
}

// Lamps on roads of at least minTier, about every 6 cells (12 units).
export function placeLamps(state, spacing = 6, minTier = 4) {
  const r = state.roads;
  let placed = 0;
  for (let i = 0; i < CELLS; i++) {
    if (r.tier[i] < minTier || (r.planned[i] & FLAG.LAMP)) continue;
    const [cx, cz] = cellXZ(i);
    if (cx % spacing === 0 || cz % spacing === 0) {
      if (hasLampNear(r, cx, cz, spacing - 1)) continue;
      r.planned[i] |= FLAG.LAMP;
      markDirty(r, i);
      placed++;
    }
  }
  // render-view rebuilds its lamp list when the version moves.
  if (placed) r.version++;
  return placed;
}

function hasLampNear(r, cx, cz, rad) {
  for (let dz = -rad; dz <= rad; dz++)
    for (let dx = -rad; dx <= rad; dx++) {
      const j = cellIndex(cx + dx, cz + dz);
      if (j >= 0 && (r.planned[j] & FLAG.LAMP)) return true;
    }
  return false;
}

// River centre at a world z, for works that span the river.
export function riverCentre(z) { return riverX(z); }

// Internals for tests and benchmarks.
export const __test = { consolidateWear, bridgeGaps, decayAndRetier, seedReclaimedPaths };
