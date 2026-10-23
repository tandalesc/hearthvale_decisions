// Emergent roads: a wear field over a 2-unit grid. Walkers wear the cells they
// enter; worn cells harden into trails, tracks and roads; unused ones fade.
// Paved roads and avenues come only from planned works (works.js).
import { heightAt, waterAt, fordAt, riverX, terrainKey, FORDS, floodDepthAt, terrainVersion, bankSide } from '../terrain.js';
import { findRoute, cellsToWaypoints } from '../navigation.js';
import { buildNodes, patchNodes } from '../path-nodes.js';
import { buildingOutline, inRect, rectBounds } from './outline.js';

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
  growBox(activeBoxes.get(r), cx, cz);
  const d = r.dirty;
  if (!d) { r.dirty = { x0: cx, z0: cz, x1: cx, z1: cz }; return; }
  if (cx < d.x0) d.x0 = cx; else if (cx > d.x1) d.x1 = cx;
  if (cz < d.z0) d.z0 = cz; else if (cz > d.z1) d.z1 = cz;
}

// The box holding every cell with wear or a tier (more, never less): the monthly passes
// skip cells with neither, so they need scan only the box. Grown wherever wear or a tier
// can appear (markDirty, which every such write calls, and growActiveBox), shrunk to what
// decayAndRetier finds. In memory only, worked out afresh for new grids.
const activeBoxes = new WeakMap();
function growBox(box, cx, cz) {
  if (!box) return;
  if (cx < box.x0) box.x0 = cx;
  if (cx > box.x1) box.x1 = cx;
  if (cz < box.z0) box.z0 = cz;
  if (cz > box.z1) box.z1 = cz;
}
export function growActiveBox(r, i) { growBox(activeBoxes.get(r), i % GRID_W, Math.floor(i / GRID_W)); }
// The box as {x0, z0, x1, z1} (empty when x1 < x0), for the render mirror's wear compare. Read only.
export function activeWearBox(r) { return activeBox(r); }
function activeBox(r) {
  let box = activeBoxes.get(r);
  if (box && box.wear === r.wear && box.tier === r.tier) return box;
  box = { wear: r.wear, tier: r.tier, x0: GRID_W, z0: GRID_H, x1: -1, z1: -1 };
  for (let i = 0; i < CELLS; i++) if (r.wear[i] !== 0 || r.tier[i] !== 0) growBox(box, i % GRID_W, (i - (i % GRID_W)) / GRID_W);
  activeBoxes.set(r, box);
  return box;
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

// A* cost of entering a cell. Infinity means impassable. The lot layer's (fp.blocked:
// the town's aggregate traffic); walker: the walkers' (fp.walls, doors dear).
export function roadCost(state, i, walker = false) {
  if (i < 0 || i >= CELLS) return Infinity;
  const r = state.roads;
  const { water, slope } = terrainGrid();
  if (water[i]) {
    if (isBridge(r, i)) return TIER_COST[r.tier[i]];
    return water[i] === 2 ? fordCost(state, i) : Infinity;
  }
  const fp = footprints(state);
  if ((walker ? fp.walls[i] : fp.blocked[i]) || tooSteep(terrainGrid(), i)) return Infinity;
  if (walker && fp.door[i]) return DOOR_COST;
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
  const prev = footprintCache.get(state);
  if (prev && prev.wv === wv && prev.len === len) return prev;
  const list = state.buildings ?? [];
  const sigs = list.map((b) => buildingSig(b, prev));
  const fp = (prev && regionalFootprints(prev, list, sigs, wv, len)) || fullFootprints(prev, list, sigs, wv, len);
  footprintCache.set(state, fp);
  return fp;
}

// What a building's stamps are made from, and the box of cells they can touch (inf:
// [x0, z0, x1, z1], or null): its lot, field, door and front cells, doorstep and the
// walls reach of its drawn pieces. The last build's record is handed back while those
// inputs are the same (buildingOutline hands back the same pieces for the same shape),
// so an unchanged building keeps the identical record.
function buildingSig(b, prev) {
  const rects = b.type === 'bridge' || b.type === 'park' ? null : buildingOutline(b);
  const k = prev?.sigAt?.get(b.id), p = k === undefined ? null : prev.sigs[k];
  if (p && p.type === b.type && p.x === b.x && p.z === b.z && p.w === b.w && p.d === b.d && p.rot === b.rot && p.rects === rects) return p;
  const step = rects ? doorstepCell(b, rects) : -1;
  return { b, id: b.id, type: b.type, x: b.x, z: b.z, w: b.w, d: b.d, rot: b.rot, rects, step, front: frontCell(b), inf: influenceOf(b, rects, step) };
}

function influenceOf(b, rects, step) {
  if (b.type === 'bridge') return null;
  const box = [GRID_W, GRID_H, -1, -1];
  const add = (x0, z0, x1, z1) => {
    box[0] = Math.min(box[0], x0); box[1] = Math.min(box[1], z0);
    box[2] = Math.max(box[2], x1); box[3] = Math.max(box[3], z1);
  };
  const cell = (c) => { if (c >= 0) { const x = c % GRID_W, z = (c - x) / GRID_W; add(x, z, x, z); } };
  if (b.type === 'farm' || b.type === 'park') {
    const { cx0, cz0, cx1, cz1 } = buildingCells(b);
    add(cx0, cz0, cx1, cz1);
  } else add(...stampRect(b));
  cell(doorCell(b));
  cell(frontCell(b));
  cell(step);
  for (const r of rects ?? []) add(...reachCells(r));
  box[0] = Math.max(0, box[0]); box[1] = Math.max(0, box[1]);
  box[2] = Math.min(GRID_W - 1, box[2]); box[3] = Math.min(GRID_H - 1, box[3]);
  return box[0] > box[2] || box[1] > box[3] ? null : box;
}

// The way in a building keeps open (wayIn's rule, from its record).
function wayInOf(s, blocked) {
  if (!s.rects) return -1;
  if (s.type === 'farm') return s.step;
  return s.step !== s.front && s.step >= 0 && blocked[s.step] ? s.front : s.step;
}

const ALL = { x0: 0, z0: 0, x1: GRID_W - 1, z1: GRID_H - 1 };
const inBox = (R, c) => { const x = c % GRID_W, z = (c - x) / GRID_W; return x >= R.x0 && x <= R.x1 && z >= R.z0 && z <= R.z1; };

// Every building stamped in list order: the lot layer, the ways in kept open, the walls
// (fp.walls0: before pockets are unsealed), near lists and doors.
function fullFootprints(prev, list, sigs, wv, len) {
  const fp = { key: `${wv}:${len}`, wv, len, blocked: new Int32Array(CELLS), field: new Uint8Array(CELLS), walls: null, door: new Uint8Array(CELLS), nearAt: new Int32Array(CELLS), near: [], wayIn: new Map(), doorsteps: new Map(), liveNear: 0, deadNear: 0 };
  for (const b of list) stampBuilding(fp, b);
  fp.walls = fp.blocked.slice();
  fp.wallCells = [];
  fp.doorCells = [];
  // Every way in stays open: a wing or lean-to drawn over a neighbour's doorstep
  // does not seal that door (walkers' finer checks still go round what is drawn).
  const keepOpen = new Set();
  for (const s of sigs) {
    const c = wayInOf(s, fp.blocked);
    if (c >= 0) { keepOpen.add(c); fp.wayIn.set(s.id, c); }
  }
  list.forEach((b, k) => stampWalls(fp, b, keepOpen, sigs[k].rects));
  return finishFootprints(fp, prev, sigs, keepOpen, null);
}

// A world bump usually changes a building or two. The cells their old and new records
// can touch (R) are cleared and stamped again by every building that reaches them, in
// list order, onto copies of the last build's arrays; outside R every stamp is as it was.
// Each cell's result depends only on the buildings that reach it, in list order, so this
// is the full build's result. R grows to take in any cell whose keep-open state changed
// (a way in moved to the street cell). Falls back to the full build when the order of the
// buildings changed, R is large or stale near lists have piled up.
const REGION_MAX = CELLS / 8;
function regionalFootprints(prev, list, sigs, wv, len) {
  if (!prev.sigs || prev.terrain !== terrainKey() || prev.sigAt.size !== prev.sigs.length || prev.deadNear > prev.liveNear + 4096) return null;
  const R = { x0: GRID_W, z0: GRID_H, x1: -1, z1: -1 };
  const grow = (x0, z0, x1, z1) => {
    R.x0 = Math.min(R.x0, x0); R.z0 = Math.min(R.z0, z0);
    R.x1 = Math.max(R.x1, x1); R.z1 = Math.max(R.z1, z1);
  };
  const growInf = (inf) => { if (inf) grow(...inf); };
  const at = new Map(), redo = new Set(), removed = [];
  let last = -1;
  for (let k = 0; k < sigs.length; k++) {
    const s = sigs[k];
    if (at.has(s.id)) return null;
    at.set(s.id, k);
    const p = prev.sigAt.get(s.id);
    if (p === undefined) { growInf(s.inf); redo.add(k); continue; }
    if (p < last) return null;
    last = p;
    if (prev.sigs[p] !== s) { growInf(prev.sigs[p].inf); growInf(s.inf); redo.add(k); }
  }
  for (const ps of prev.sigs) if (!at.has(ps.id)) { growInf(ps.inf); removed.push(ps.id); }
  const hits = (inf) => !!inf && inf[0] <= R.x1 && inf[2] >= R.x0 && inf[1] <= R.z1 && inf[3] >= R.z0;
  const eachCell = (f) => {
    for (let z = R.z0; z <= R.z1; z++) for (let c = z * GRID_W + R.x0, end = z * GRID_W + R.x1; c <= end; c++) f(c);
  };
  const fp = { key: `${wv}:${len}`, wv, len, blocked: prev.blocked.slice(), field: prev.field.slice(), walls: null, door: prev.door.slice(), nearAt: prev.nearAt.slice(), near: null, wayIn: new Map(), doorsteps: new Map(), liveNear: prev.liveNear, deadNear: prev.deadNear, wallCells: null, doorCells: null };
  const keptBefore = prev.keptCount ??= countCells(prev.wayIn);
  let way;
  for (;;) {
    if (R.x1 >= R.x0 && (R.x1 - R.x0 + 1) * (R.z1 - R.z0 + 1) > REGION_MAX) return null;
    eachCell((c) => { fp.blocked[c] = 0; fp.field[c] = 0; });
    for (let k = 0; k < sigs.length; k++) if (hits(sigs[k].inf)) stampBuilding(fp, list[k], R);
    way = new Map(prev.wayIn);
    for (const id of removed) way.delete(id);
    const again = [...removed];
    for (let k = 0; k < sigs.length; k++) {
      const s = sigs[k];
      if (!redo.has(k) && !hits(s.inf)) continue;
      const c = wayInOf(s, fp.blocked);
      if (c >= 0) way.set(s.id, c); else way.delete(s.id);
      again.push(s.id);
    }
    const kept = countCells(way);
    let grew = false;
    for (const id of again) {
      for (const c of [prev.wayIn.get(id), way.get(id)]) {
        if (c === undefined || inBox(R, c) || !keptBefore.get(c) === !kept.get(c)) continue;
        const x = c % GRID_W, z = (c - x) / GRID_W;
        grow(x, z, x, z);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const keepOpen = new Set();
  for (const s of sigs) {
    const c = way.get(s.id);
    if (c !== undefined) { keepOpen.add(c); fp.wayIn.set(s.id, c); }
  }
  // Walls (before unsealing), doors and near lists inside R; the near lists of R's cells
  // are made anew, the old ones left unused in fp.near.
  fp.walls = prev.walls0.slice();
  fp.near = prev.near.slice();
  eachCell((c) => {
    fp.walls[c] = fp.blocked[c];
    fp.door[c] = 0;
    if (fp.nearAt[c]) { fp.nearAt[c] = 0; fp.liveNear--; fp.deadNear++; }
  });
  for (let k = 0; k < sigs.length; k++) if (hits(sigs[k].inf)) stampWalls(fp, list[k], keepOpen, sigs[k].rects, R);
  // The cell lists, as sets: a wall cell is one drawn pieces took (walls but no lot), a
  // door cell one marked door.
  fp.wallCells = R.x1 < R.x0 ? prev.wallCells0.slice() : prev.wallCells0.filter((c) => !inBox(R, c));
  fp.doorCells = R.x1 < R.x0 ? prev.doorCells.slice() : prev.doorCells.filter((c) => !inBox(R, c));
  eachCell((c) => {
    if (fp.walls[c] && !fp.blocked[c]) fp.wallCells.push(c);
    if (fp.door[c]) fp.doorCells.push(c);
  });
  return finishFootprints(fp, prev, sigs, keepOpen, R);
}

function countCells(way) {
  const n = new Map();
  for (const c of way.values()) n.set(c, (n.get(c) ?? 0) + 1);
  return n;
}

// Unseals pockets (every way in, in order, as the full build does), and notes the tiles
// that changed: all cells after a full build, R and the cells unsealed in either build
// after a regional one (outside R, walls differ only there and the near lists are the
// same lists).
function finishFootprints(fp, prev, sigs, keepOpen, region) {
  fp.walls0 = fp.walls;
  fp.wallCells0 = fp.wallCells;
  fp.walls = fp.walls0.slice();
  fp.opened = [];
  for (const c of keepOpen) unsealWay(fp, c);
  if (fp.opened.length) fp.wallCells = fp.wallCells0.filter((c) => fp.walls[c]);
  if (!fp.liveNear) { fp.near = []; fp.deadNear = 0; }
  fp.sigs = sigs;
  fp.sigAt = new Map(sigs.map((s, k) => [s.id, k]));
  fp.terrain = terrainKey();
  noteChangedTiles(fp, prev, region);
  return fp;
}

// Which parts of the map a footprint build changed, for walkers' memos (skirtMemo,
// wallMemo): tiles of NEAR_TILE cells, each stamped with the generation of the last
// build in which some cell of it got a different near list (other pieces, or the same
// ones in another order; tileGen) or became a wall or stopped being one (wallGen).
// The last TILE_LOG builds also list the tiles they stamped (log), so a memo a build or
// two behind can be brought up by looking at those few tiles rather than all of its own.
// Kept per lineage of builds for one state, in memory only.
const NEAR_TILE = 8;
const TILES_W = Math.ceil(GRID_W / NEAR_TILE), TILES_H = Math.ceil(GRID_H / NEAR_TILE);
const TILE_LOG = 8;
function noteChangedTiles(fp, prev, region = null) {
  if (!prev?.tileGen) {
    fp.gen = 1;
    fp.tileGen = new Int32Array(TILES_W * TILES_H).fill(1);
    fp.wallGen = new Int32Array(TILES_W * TILES_H).fill(1);
    fp.log = new Array(TILE_LOG).fill(null);
    return;
  }
  const gen = (fp.gen = prev.gen + 1), tileGen = (fp.tileGen = prev.tileGen), wallGen = (fp.wallGen = prev.wallGen);
  const entry = { gen, near: [], wall: [] };
  (fp.log = prev.log)[gen % TILE_LOG] = entry;
  const wa = prev.walls, wb = fp.walls, na = prev.nearAt, nb = fp.nearAt;
  const note = (c) => {
    const a = na[c], b = nb[c];
    const wall = !wa[c] !== !wb[c];
    if (!wall && !a && !b) return;
    const x = c % GRID_W, z = (c - x) / GRID_W;
    const t = Math.floor(z / NEAR_TILE) * TILES_W + Math.floor(x / NEAR_TILE);
    if (wall && wallGen[t] !== gen) { wallGen[t] = gen; entry.wall.push(t); }
    // A tile already marked in this build needs no more comparing.
    if (tileGen[t] === gen || (!a && !b)) return;
    if (a && b && sameList(prev.near[a - 1], fp.near[b - 1])) return;
    tileGen[t] = gen;
    entry.near.push(t);
  };
  if (!region || !prev.opened) {
    for (let c = 0; c < CELLS; c++) note(c);
    return;
  }
  // The tiles and log entries are only ever read as sets, so the order cells are seen in
  // does not matter.
  for (let z = region.z0; z <= region.z1; z++) for (let c = z * GRID_W + region.x0, end = z * GRID_W + region.x1; c <= end; c++) note(c);
  for (const c of prev.opened) note(c);
  for (const c of fp.opened) note(c);
}

// Could a tile the memo covers have been stamped (in the 'near' or 'wall' log) since
// memo.gen? False only when the log reaches back that far and none of the tiles it
// lists lies in the memo's box (which holds all of memo.tiles).
function maybeChanged(fp, memo, which) {
  if (fp.gen - memo.gen > TILE_LOG) return true;
  for (let g = memo.gen + 1; g <= fp.gen; g++) {
    const e = fp.log[g % TILE_LOG];
    if (!e || e.gen !== g) return true;
    for (const t of e[which]) {
      const tx = t % TILES_W, tz = (t - tx) / TILES_W;
      if (tx >= memo.tx0 && tx <= memo.tx1 && tz >= memo.tz0 && tz <= memo.tz1) return true;
    }
  }
  return false;
}
function sameList(la, lb) {
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) return false;
  return true;
}

// A way in that drawn pieces have closed into a small pocket (an old wing built across
// a neighbour's door) gets a corridor out: the fewest cells of those pieces (never of
// a lot) between the pocket and open ground beyond it are opened again, so nobody is
// shut in; walkers' finer checks still keep them off the rest.
const POCKET = 48, CORRIDOR = 400;
const pocketMark = new Int32Array(CELLS), pocketQueue = new Int32Array(POCKET + 8);
let pocketGen = 0;
// The corridor search: cells reached this search (corridorMark), the cell each came from
// (-1 for the pocket), in the order reached.
const corridorMark = new Int32Array(CELLS), corridorFrom = new Int32Array(CELLS), corridorFront = new Int32Array(POCKET + CORRIDOR + 8);
let corridorGen = 0;
function unsealWay(fp, start) {
  const { water } = terrainGrid();
  const walls = fp.walls;
  // The open ground the way in opens onto, while it is a small pocket.
  const gen = ++pocketGen;
  let head = 0, tail = 0;
  pocketQueue[tail++] = start;
  pocketMark[start] = gen;
  while (head < tail) {
    if (tail > POCKET) return;
    const c = pocketQueue[head++], x = c % GRID_W;
    for (let k = 0; k < 4; k++) {
      const n = k === 0 ? (x > 0 ? c - 1 : -1) : k === 1 ? (x < GRID_W - 1 ? c + 1 : -1) : k === 2 ? c - GRID_W : c + GRID_W;
      if (n < 0 || n >= CELLS || pocketMark[n] === gen || walls[n] || water[n]) continue;
      pocketMark[n] = gen;
      pocketQueue[tail++] = n;
    }
  }
  // Sealed: out through the drawn pieces (never a lot) to the nearest open ground,
  // trying each cell's neighbours west, east, north, south. The cells opened are listed
  // in fp.opened, and leave fp.wallCells when footprints() is done.
  const cg = ++corridorGen, front = corridorFront, blocked = fp.blocked;
  let n = 0;
  for (let k = 0; k < tail; k++) {
    const c = pocketQueue[k];
    front[n++] = c;
    corridorMark[c] = cg;
    corridorFrom[c] = -1;
  }
  for (let k = 0; k < n && n < CORRIDOR; k++) {
    const c = front[k], x = c % GRID_W;
    let out = -1;
    for (let d = 0; d < 4 && out < 0; d++) {
      const m = d === 0 ? (x > 0 ? c - 1 : -1) : d === 1 ? (x < GRID_W - 1 ? c + 1 : -1) : d === 2 ? (c >= GRID_W ? c - GRID_W : -1) : (c < CELLS - GRID_W ? c + GRID_W : -1);
      if (m < 0 || corridorMark[m] === cg || water[m]) continue;
      if (!walls[m]) { out = m; corridorMark[m] = cg; corridorFrom[m] = c; break; }
      if (blocked[m]) continue;
      corridorMark[m] = cg;
      corridorFrom[m] = c;
      front[n++] = m;
    }
    if (out < 0) continue;
    for (let p = corridorFrom[out]; p >= 0 && pocketMark[p] !== gen; p = corridorFrom[p]) { walls[p] = 0; fp.opened.push(p); }
    return;
  }
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
// the walls). Farms: their gate cell on the headland. Without the state, the street
// cell in front of the door, as the lots and the town's aggregate traffic know it;
// with it, where a walker stops: the way in past the building's own steps, porch or
// wing (footprints' wayIn, doorstepCell).
export function doorPoint(b, state = null) {
  if (b.type === 'farm' || b.type === 'park') {
    if (!state || b.type === 'park') return cellCenter(doorCell(b));
  } else if (!state) {
    const front = frontCell(b);
    return cellCenter(front >= 0 ? front : doorCell(b));
  }
  const fp = footprints(state);
  let at = fp.doorsteps.get(b.id);
  if (!at) {
    const step = fp.wayIn.get(b.id) ?? doorstepCell(b);
    at = clearPoint(state, fp, step >= 0 ? step : doorCell(b));
    fp.doorsteps.set(b.id, at);
  }
  return { x: at.x, z: at.z };
}

// Where a walker put out of a wall (or a goal moved off one) stands in cell c.
export function standPoint(state, c) { return clearPoint(state, footprints(state), c); }

// The middle of cell c, or, where a drawn piece reaches over it (a neighbour's wing
// over a doorstep kept open), the nearest point within 2.5 units, on open ground and
// a walker's margin clear of every piece.
function clearPoint(state, fp, c) {
  const { x, z } = cellCenter(c);
  if (outlineClear(state, x, z)) return { x, z };
  let best = null, bd = Infinity;
  for (let u = -10; u <= 10; u++)
    for (let v = -10; v <= 10; v++) {
      const d = u * u + v * v;
      if (d >= bd) continue;
      const px = x + u * 0.25, pz = z + v * 0.25;
      const q = cellIndex(Math.floor((px - ORIGIN_X) / CELL), Math.floor((pz - ORIGIN_Z) / CELL));
      if (q < 0 || fp.walls[q] || fp.door[q] || terrainGrid().water[q] || !outlineClear(state, px, pz)) continue;
      best = { x: px, z: pz };
      bd = d;
    }
  return best ?? { x, z };
}

function stampBuilding(fp, b, R = ALL) {
  if (b.type === 'bridge') return;
  if (b.type === 'farm' || b.type === 'park') return stampField(fp, b, R);
  // Conservative: every cell the footprint (plus a walker's margin) touches.
  const [cx0, cz0, cx1, cz1] = stampRect(b);
  for (let z = Math.max(cz0, R.z0); z <= Math.min(cz1, R.z1); z++)
    for (let x = Math.max(cx0, R.x0); x <= Math.min(cx1, R.x1); x++) fp.blocked[z * GRID_W + x] = b.id + 1;
  for (const j of [doorCell(b), frontCell(b)]) if (j >= 0 && inBox(R, j) && fp.blocked[j] === b.id + 1) fp.blocked[j] = 0;
}

// The cells a building's lot layer stamps: its w x d plus a walker's margin.
function stampRect(b) {
  const m = PERSON_MARGIN;
  return [Math.floor((b.x - b.w / 2 - m - ORIGIN_X) / CELL), Math.floor((b.z - b.d / 2 - m - ORIGIN_Z) / CELL),
    Math.floor((b.x + b.w / 2 + m - ORIGIN_X) / CELL - 1e-6), Math.floor((b.z + b.d / 2 + m - ORIGIN_Z) / CELL - 1e-6)];
}

// The cells whose near lists a drawn piece joins: its bounds grown by the walls test's reach.
function reachCells(r) {
  const [x0, z0, x1, z1] = rectBounds(r, PERSON_MARGIN + WALL_CORE + 0.01);
  return [Math.floor((x0 - ORIGIN_X) / CELL), Math.floor((z0 - ORIGIN_Z) / CELL), Math.floor((x1 - ORIGIN_X) / CELL), Math.floor((z1 - ORIGIN_Z) / CELL)];
}
// ---------------------------------------------------------------- walls (walkers)

// fp.blocked is the lot layer: each building's w x d (plus a walker's margin), what
// sites, lots and doors are judged by. Walkers keep off more than that: everything the
// building draws at walking height (sim/outline.js: plinths and skirts standing proud
// of the walls, steps, side wings, lean-tos, bays, porticos, piles, a farm's house and
// barns). fp.walls is fp.blocked plus every cell whose middle (WALL_CORE either way)
// comes within a walker's margin of such a piece; fp.near lists the pieces by every
// cell near one, for the finer test of points a walker stops at or is offset to
// (outlineClear). fp.door marks the door cells, which lie inside the walls: open so
// the door stays reachable, but never a place to stand or be put.
const WALL_CORE = 0.5;
// A door cell is open (a route may end there) but dear: never a way through the walls.
// The grids carry it as passCap: a straightened leg never crosses a cell this dear
// (navigation.js cellOk) unless the cell path itself goes there.
const DOOR_COST = 400;
// Is the middle of cell (i, j) (its centre, WALL_CORE either way) within m of r?
function coreHit(r, i, j, m) {
  const cx = ORIGIN_X + (i + 0.5) * CELL, cz = ORIGIN_Z + (j + 0.5) * CELL;
  // Axis-aligned pieces (most): the square grown by the piece is exact.
  if (Math.abs(r.c) < 1e-6 || Math.abs(r.s) < 1e-6) return inRect(r, cx, cz, m + WALL_CORE);
  for (const u of [-WALL_CORE, 0, WALL_CORE])
    for (const v of [-WALL_CORE, 0, WALL_CORE]) if (inRect(r, cx + u, cz + v, m)) return true;
  return Math.abs(r.x - cx) <= WALL_CORE && Math.abs(r.z - cz) <= WALL_CORE;
}

// The cell every building's way in must keep open (wayInOf): its doorstep (doorstepCell),
// or, where its own wing or porch covers the street cell and the cell beyond is someone
// else's lot (an old wing built across the door), the street cell itself.

// R clips the stamp to a box of cells (regionalFootprints); fp.wallCells and fp.doorCells
// are kept here only when they are lists (the full build).
function stampWalls(fp, b, keepOpen, rects = buildingOutline(b), R = ALL) {
  if (b.type === 'bridge' || b.type === 'park') return;
  if (!rects.length) return;
  // Near lists hold every piece within a walker's margin of some point of the cell; the walls
  // test reaches WALL_CORE further.
  const m = PERSON_MARGIN;
  const field = b.type === 'farm';
  const door = doorCell(b);
  const doorHere = door >= 0 && inBox(R, door);
  const before = field || !doorHere ? 0 : fp.walls[door];
  for (const r of rects) {
    const [i0, j0, i1, j1] = reachCells(r);
    for (let j = Math.max(j0, R.z0); j <= Math.min(j1, R.z1); j++)
      for (let i = Math.max(i0, R.x0); i <= Math.min(i1, R.x1); i++) {
        const c = j * GRID_W + i;
        let k = fp.nearAt[c];
        if (!k) { fp.near.push([]); k = fp.nearAt[c] = fp.near.length; fp.liveNear++; }
        fp.near[k - 1].push(r);
        if (!fp.walls[c] && !keepOpen.has(c) && coreHit(r, i, j, m)) { fp.walls[c] = b.id + 1; fp.wallCells?.push(c); }
      }
  }
  if (!field && doorHere) {
    // The door cell stays as the lot layer has it (open); people stop on the doorstep.
    if (fp.walls[door] !== before && !before) fp.wallCells?.splice(fp.wallCells.indexOf(door), 1);
    fp.walls[door] = before;
    if (!fp.blocked[door] && !fp.door[door]) { fp.door[door] = 1; fp.doorCells?.push(door); }
  }
}
// The cells a drawn piece takes from walkers (its middle within a walker's margin of
// the piece: the walls test), as a list.
export function pieceCells(r) {
  const [x0, z0, x1, z1] = rectBounds(r, PERSON_MARGIN + WALL_CORE);
  const out = [];
  for (let j = Math.floor((z0 - ORIGIN_Z) / CELL); j <= Math.floor((z1 - ORIGIN_Z) / CELL); j++)
    for (let i = Math.floor((x0 - ORIGIN_X) / CELL); i <= Math.floor((x1 - ORIGIN_X) / CELL); i++) {
      const c = cellIndex(i, j);
      if (c >= 0 && coreHit(r, i, j, PERSON_MARGIN)) out.push(c);
    }
  return out;
}

// Clear of every drawn piece near (x, z) by a walker's margin? (The cell itself is
// fp.walls' business; the part of a door cell outside the walls is fine to stand on.)
export function outlineClear(state, x, z) {
  const fp = footprints(state);
  const c = cellIndex(Math.floor((x - ORIGIN_X) / CELL), Math.floor((z - ORIGIN_Z) / CELL));
  if (c < 0) return false;
  const list = nearIn(fp, c);
  if (!list) return true;
  for (const r of list) if (inRect(r, x, z, PERSON_MARGIN)) return false;
  return true;
}

// The pieces of cell c's near list that reach into the cell itself by a walker's margin,
// in list order; null when none do. Near lists are stamped from bounding boxes grown by
// the wall reach, so most of a list misses the cell, and a point in the cell can only be
// inside these: the walker tests below give the same answers from the shorter list.
// (A separating-axis test of the piece, grown by the margin, against the cell square,
// both a millionth of a unit generous.) Worked out once per cell per footprint build.
const NEAR_EPS = 1e-6;
function nearIn(fp, c) {
  const q = fp.nearAt[c];
  if (!q) return null;
  const at = (fp.nearInAt ??= new Int32Array(CELLS));
  let k = at[c];
  if (k === 0) {
    const i = c % GRID_W, j = (c - i) / GRID_W;
    const mx = ORIGIN_X + (i + 0.5) * CELL, mz = ORIGIN_Z + (j + 0.5) * CELL, h = CELL / 2 + NEAR_EPS;
    let list = null;
    for (const r of fp.near[q - 1]) {
      const hx = r.hx + PERSON_MARGIN + NEAR_EPS, hz = r.hz + PERSON_MARGIN + NEAR_EPS;
      const ac = Math.abs(r.c), as = Math.abs(r.s), dx = mx - r.x, dz = mz - r.z;
      if (Math.abs(dx) > ac * hx + as * hz + h || Math.abs(dz) > as * hx + ac * hz + h) continue;
      if (Math.abs(dx * r.c - dz * r.s) > hx + (ac + as) * h || Math.abs(dx * r.s + dz * r.c) > hz + (ac + as) * h) continue;
      (list ??= []).push(r);
    }
    if (list) { (fp.nearIn ??= []).push(list); k = fp.nearIn.length; } else k = -1;
    at[c] = k;
  }
  return k > 0 ? fp.nearIn[k - 1] : null;
}

// people.js segmentBlocked, for a road grid laid out as this module's: a sample every
// half unit, ends included, in a wall cell, or (after the first) off the map or within a
// walker's margin of a drawn piece. The samples are taken a cell at a time (sameCellRun):
// a cell with no wall and no pieces near it passes them all, and so does one whose
// pieces the stretch of leg through it cannot reach (piecesAlong). The same answer as
// testing every sample.
export function walkerSegmentBlocked(fp, x0, z0, x1, z1) {
  const walls = fp.walls;
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 2);
  // No length: the one sample is the start (x0 + 0 / 0 is NaN, which meets no cell).
  if (steps === 0) return false;
  const sx = (x1 - x0) / steps, sz = (z1 - z0) / steps;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    const cx = Math.floor((x - ORIGIN_X) / CELL), cz = Math.floor((z - ORIGIN_Z) / CELL);
    const c = cellIndex(cx, cz);
    if (c < 0) {
      if (i > 0) return true;
      continue;
    }
    if (walls[c]) return true;
    const e = Math.min(steps, i + sameCellRun(x, z, cx, cz, sx, sz));
    const list = fp.nearAt[c] ? nearIn(fp, c) : null;
    if (list && piecesAlong(list, x0, z0, x1, z1, steps, Math.max(1, i), e)) return true;
    i = e;
  }
  return false;
}

// people.js legOpen's outline test: one of the interior samples (i / steps along the
// leg, 0 < i < steps) off the map or within a walker's margin of a drawn piece, as
// outlineClear at each, taken a cell at a time as above.
export function walkerLegOutlined(fp, x0, z0, x1, z1, steps) {
  const sx = (x1 - x0) / steps, sz = (z1 - z0) / steps;
  for (let i = 1; i < steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    const cx = Math.floor((x - ORIGIN_X) / CELL), cz = Math.floor((z - ORIGIN_Z) / CELL);
    const c = cellIndex(cx, cz);
    if (c < 0) return true;
    const e = Math.min(steps - 1, i + sameCellRun(x, z, cx, cz, sx, sz));
    const list = fp.nearAt[c] ? nearIn(fp, c) : null;
    if (list && piecesAlong(list, x0, z0, x1, z1, steps, i, e)) return true;
    i = e;
  }
  return false;
}

// Samples k..e (j / n of the way from a to b), all in one cell, and some within a
// walker's margin of a piece of the cell's list (inRect, as outlineClear)? When the
// straight stretch from sample k to sample e passes every piece, grown by the margin and
// a millionth of a unit, by at least that millionth, no sample on it can be inside one
// (each lies within rounding, about 1e-13 here, of that stretch), so they are not tested.
const ALONG_EPS = 1e-6;
function piecesAlong(list, ax, az, bx, bz, n, k, e) {
  if (k > e) return false;
  const px = ax + ((bx - ax) * k) / n, pz = az + ((bz - az) * k) / n;
  const qx = ax + ((bx - ax) * e) / n, qz = az + ((bz - az) * e) / n;
  let near = false;
  for (const r of list) if (stretchMeets(r, px, pz, qx, qz)) { near = true; break; }
  if (!near) return false;
  for (let j = k; j <= e; j++) {
    const x = ax + ((bx - ax) * j) / n, z = az + ((bz - az) * j) / n;
    for (const r of list) if (inRect(r, x, z, PERSON_MARGIN)) return true;
  }
  return false;
}

// Does the stretch from p to q come inside piece r grown by a walker's margin and
// ALONG_EPS (or touch it)? Clipped against the piece's slabs in its own frame (inRect's).
function stretchMeets(r, px, pz, qx, qz) {
  const m = PERSON_MARGIN + ALONG_EPS, hx = r.hx + m, hz = r.hz + m;
  let dx = px - r.x, dz = pz - r.z;
  const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
  dx = qx - r.x;
  dz = qz - r.z;
  const ux = dx * r.c - dz * r.s - lx, uz = dx * r.s + dz * r.c - lz;
  let t0 = 0, t1 = 1;
  if (ux === 0) {
    if (Math.abs(lx) >= hx) return false;
  } else {
    const a = (-hx - lx) / ux, b = (hx - lx) / ux;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  if (uz === 0) return Math.abs(lz) < hz;
  const a = (-hz - lz) / uz, b = (hz - lz) / uz;
  return Math.max(t0, Math.min(a, b)) <= Math.min(t1, Math.max(a, b));
}

// No water anywhere along the leg (every half unit, and its ends)?
function legDry(ax, az, bx, bz) {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
  for (let k = 0; k <= n; k++) if (waterAt(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n)) return false;
  return true;
}

// A leg's interior samples (every SKIRT_STEP) clear of the drawn pieces near it?
// Samples in a cell with no pieces near it are skipped in a run (sameCellRun), so a
// long leg through open cells costs a few lookups per cell, not per sample.
const SKIRT_STEP = 0.25;
function legClearOfOutlines(fp, ax, az, bx, bz) {
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / SKIRT_STEP);
  const sx = (bx - ax) / n, sz = (bz - az) / n;
  for (let k = 1; k < n; k++) {
    const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
    const cx = Math.floor((x - ORIGIN_X) / CELL), cz = Math.floor((z - ORIGIN_Z) / CELL);
    const c = cellIndex(cx, cz);
    const list = c >= 0 ? nearIn(fp, c) : null;
    if (list) {
      for (const r of list) if (inRect(r, x, z, PERSON_MARGIN)) return false;
    } else {
      k += sameCellRun(x, z, cx, cz, sx, sz);
    }
  }
  return true;
}

// How many of the next samples (x + j * sx, z + j * sz for j = 1, 2, ...) are sure to
// fall in the same cell (cx, cz) as (x, z): a margin of a whole sample and a millionth
// of a unit keeps rounding in the samples' own arithmetic from ever crossing an edge.
const RUN_EPS = 1e-6;
function sameCellRun(x, z, cx, cz, sx, sz) {
  return Math.max(0, Math.min(runAlong(x, sx, cx, ORIGIN_X), runAlong(z, sz, cz, ORIGIN_Z)));
}
function runAlong(p, s, c, origin) {
  if (s === 0) return Infinity;
  const room = (s > 0 ? (c + 1) * CELL + origin - p : p - (c * CELL + origin)) - RUN_EPS;
  return room > 0 ? Math.floor(room / Math.abs(s)) - 1 : 0;
}

// The leg's deepest sample inside a piece (grown by a walker's margin): {r, lx, lz}
// in the piece's own frame, or null.
function deepestHit(fp, ax, az, bx, bz) {
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / SKIRT_STEP);
  let best = null, depth = 0;
  for (let k = 1; k < n; k++) {
    const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
    const c = cellIndex(Math.floor((x - ORIGIN_X) / CELL), Math.floor((z - ORIGIN_Z) / CELL));
    const list = c >= 0 ? nearIn(fp, c) : null;
    if (!list) continue;
    for (const r of list) {
      const dx = x - r.x, dz = z - r.z;
      const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
      const d = Math.min(r.hx + PERSON_MARGIN - Math.abs(lx), r.hz + PERSON_MARGIN - Math.abs(lz));
      if (d > depth) { depth = d; best = {r, lx, lz}; }
    }
  }
  return best;
}

// Grid routes and their string-pulled legs keep to open cells, but a long leg can still
// cut the corner of a plinth, step or wing reaching into a cell it passes (a cell is
// open while its middle is clear). Each such leg goes round instead: by the corner of
// the piece it cuts (or straight out from its nearest side), a walker's margin and a
// little beyond, where that point and both new legs are clear (a few tries a leg).
// Flat [x, z, ...] in; the same array when nothing is cut, else a new one.
const SKIRT_PAD = 0.1;
const SKIRT_DEPTH = 3;
// keep(x, z): points never moved or added (people.js: a bridge deck and its approaches).
// Legs over water (fords, decks) are left as they are, and no new leg gets wet.
// report (optional): report.near is set when some interior waypoint is within a
// walker's margin of a piece (whether or not it moved); see skirtMemo.
export function skirtOutlines(state, route0, keep = null, report = null) {
  let route = route0;
  if (!route || route.length < 4) return route;
  const fp = footprints(state);
  if (!fp.near.length) return route;
  // Interior waypoints within a walker's margin of a piece (string-pulled and path-node
  // points lie anywhere in their open cells) step out from its nearest side first.
  for (let k = 2; k + 3 < route.length; k += 2) {
    const x = route[k], z = route[k + 1];
    const c = cellIndex(Math.floor((x - ORIGIN_X) / CELL), Math.floor((z - ORIGIN_Z) / CELL));
    const list = c >= 0 ? nearIn(fp, c) : null;
    if (!list) continue;
    if (report && !report.near && list.some((r) => inRect(r, x, z, PERSON_MARGIN))) report.near = true;
    if (keep?.(x, z)) continue;
    const px0 = route[k - 2], pz0 = route[k - 1], nx = route[k + 2], nz = route[k + 3];
    // Both legs must be dry for the point to move; asked only once a piece is in reach
    // (most waypoints by a building are already clear of it).
    let dry = null;
    for (const r of list) {
      const dx = x - r.x, dz = z - r.z;
      const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
      const px = r.hx + PERSON_MARGIN - Math.abs(lx), pz = r.hz + PERSON_MARGIN - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue;
      dry ??= legDry(px0, pz0, x, z) && legDry(x, z, nx, nz);
      if (!dry) break;
      const ux = px < pz ? (lx < 0 ? -1 : 1) * (r.hx + PERSON_MARGIN + SKIRT_PAD) : lx;
      const uz = px < pz ? lz : (lz < 0 ? -1 : 1) * (r.hz + PERSON_MARGIN + SKIRT_PAD);
      const qx = r.x + ux * r.c + uz * r.s, qz = r.z - ux * r.s + uz * r.c;
      const qc = cellIndex(Math.floor((qx - ORIGIN_X) / CELL), Math.floor((qz - ORIGIN_Z) / CELL));
      if (qc < 0 || fp.walls[qc] || keep?.(qx, qz) || !outlineClear(state, qx, qz) || !legDry(px0, pz0, qx, qz) || !legDry(qx, qz, nx, nz)) continue;
      if (route === route0) route = route.slice();
      route[k] = qx;
      route[k + 1] = qz;
      break;
    }
  }
  let out = null;
  for (let k = 0; k + 3 < route.length; k += 2) {
    const ax = route[k], az = route[k + 1], bx = route[k + 2], bz = route[k + 3];
    if (legClearOfOutlines(fp, ax, az, bx, bz) || !legDry(ax, az, bx, bz)) { if (out) out.push(bx, bz); continue; }
    if (!out) out = route.slice(0, k + 2);
    const mark = out.length;
    if (!skirtLeg(state, fp, ax, az, bx, bz, 0, out, keep)) out.length = mark;   // no way round: as it was
    out.push(bx, bz);
  }
  return out ?? route;
}

// A memo for a walk skirtOutlines has just left as it was, with no waypoint near any
// piece (report.near unset): from flat index `from` on, every waypoint is out of reach
// of every piece and every leg is clear of them (or wet, and so left be). That stays
// true, whatever happens elsewhere, while the cells those legs sample keep the same near
// lists: skirtStillClear then only needs the leg from where the walker now stands.
// Pass the same route object, unchanged in length, and a `from` no later than the
// walker's segment. (Legs sample the cells inside their bounding box; one cell of
// margin on it covers rounding at cell edges.)
export function skirtMemo(state, route, from) {
  const fp = footprints(state);
  return { gen: fp.gen, tileGen: fp.tileGen, length: route.length, from, ...walkTiles(route, from) };
}

// The tiles (NEAR_TILE cells a side) a walk's legs from flat index `from` on can
// sample: each leg's bounding box, one cell of margin for rounding at cell edges.
// tiles: all of them, once each; boxes: [tx0, tz0, tx1, tz1] per leg, in order from
// boxFrom (a memo's `from` may move on; its boxes stay where they were).
function walkTiles(route, from) {
  const tiles = [];
  const seen = new Set();
  const boxes = new Int16Array(Math.max(0, (route.length - from - 2) >> 1) * 4);
  let bx0 = TILES_W, bz0 = TILES_H, bx1 = -1, bz1 = -1;
  const tile = (v, origin, max) => Math.max(0, Math.min(max - 1, Math.floor((v - origin) / (CELL * NEAR_TILE))));
  for (let k = from, j = 0; k + 3 < route.length; k += 2, j += 4) {
    const x0 = Math.min(route[k], route[k + 2]) - CELL, x1 = Math.max(route[k], route[k + 2]) + CELL;
    const z0 = Math.min(route[k + 1], route[k + 3]) - CELL, z1 = Math.max(route[k + 1], route[k + 3]) + CELL;
    const tx0 = tile(x0, ORIGIN_X, TILES_W), tz0 = tile(z0, ORIGIN_Z, TILES_H);
    const tx1 = tile(x1, ORIGIN_X, TILES_W), tz1 = tile(z1, ORIGIN_Z, TILES_H);
    boxes[j] = tx0; boxes[j + 1] = tz0; boxes[j + 2] = tx1; boxes[j + 3] = tz1;
    if (tx0 < bx0) bx0 = tx0;
    if (tz0 < bz0) bz0 = tz0;
    if (tx1 > bx1) bx1 = tx1;
    if (tz1 > bz1) bz1 = tz1;
    for (let tz = tz0; tz <= tz1; tz++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = tz * TILES_W + tx;
        if (!seen.has(t)) { seen.add(t); tiles.push(t); }
      }
  }
  return { tiles, boxes, boxFrom: from, tx0: bx0, tz0: bz0, tx1: bx1, tz1: bz1 };
}

// Brings a walk memo up to the current build. Nothing it covers changed: true. Some
// tiles did: each leg from flat index seg on whose box meets one must pass
// holds(k) (k: the leg's start), and then the memo narrows to seg and holds too.
// False: the memo cannot tell (do the full check).
function memoCatchUp(fp, memo, gens, which, seg, holds) {
  if (memo.gen === fp.gen) return true;
  let changed = false;
  if (maybeChanged(fp, memo, which)) for (const t of memo.tiles) if (gens[t] > memo.gen) { changed = true; break; }
  if (changed) {
    const b = memo.boxes;
    for (let k = seg; k + 3 < memo.length; k += 2) {
      const j = ((k - memo.boxFrom) >> 1) * 4;
      let hit = false;
      for (let tz = b[j + 1]; tz <= b[j + 3] && !hit; tz++)
        for (let tx = b[j]; tx <= b[j + 2]; tx++) if (gens[tz * TILES_W + tx] > memo.gen) { hit = true; break; }
      if (hit && !holds(k)) return false;
    }
    memo.from = seg;
  }
  memo.gen = fp.gen;
  return true;
}

// Is waypoint k of a route within a walker's margin of a drawn piece (skirtOutlines'
// report.near test)?
function nearPiece(fp, route, k) {
  const x = route[k], z = route[k + 1];
  const c = cellIndex(Math.floor((x - ORIGIN_X) / CELL), Math.floor((z - ORIGIN_Z) / CELL));
  const list = c >= 0 ? nearIn(fp, c) : null;
  return !!list && list.some((r) => inRect(r, x, z, PERSON_MARGIN));
}

// skirtOutlines would leave [x, z, ...route from flat index seg] as it is, known from
// the memo without walking the route: every leg it covers whose tiles changed since
// is still clear or wet, with no waypoint at either end (but the walk's last) now in
// reach of a piece, and the first leg, from (x, z), is clear or wet. False means "not
// known" (do the full skirtOutlines). A memo that holds is moved up to the current build.
export function skirtStillClear(state, memo, route, seg, x, z) {
  const fp = footprints(state);
  if (!memo || memo.tileGen !== fp.tileGen || memo.length !== route.length || seg < memo.from || seg + 1 >= route.length) return false;
  const last = route.length - 2;
  const holds = (k) => !nearPiece(fp, route, k) && (k + 2 === last || !nearPiece(fp, route, k + 2)) &&
    (legClearOfOutlines(fp, route[k], route[k + 1], route[k + 2], route[k + 3]) || !legDry(route[k], route[k + 1], route[k + 2], route[k + 3]));
  if (!memoCatchUp(fp, memo, fp.tileGen, 'near', seg, holds)) return false;
  if (!fp.near.length) return true;
  return legClearOfOutlines(fp, x, z, route[seg], route[seg + 1]) || !legDry(x, z, route[seg], route[seg + 1]);
}

// Points (pushed onto out) that take the leg a -> b round the pieces it cuts: by the
// corner of the one it cuts deepest, or straight out from its nearer side, each new
// leg done the same way in turn (SKIRT_DEPTH deep). False, with out as it was, if
// there is no clear way.
function skirtLeg(state, fp, ax, az, bx, bz, depth, out, keep) {
  if (legClearOfOutlines(fp, ax, az, bx, bz)) return true;
  if (depth >= SKIRT_DEPTH) return false;
  const hit = deepestHit(fp, ax, az, bx, bz);
  if (!hit) return true;
  const {r, lx, lz} = hit;
  const ex = r.hx + PERSON_MARGIN + SKIRT_PAD, ez = r.hz + PERSON_MARGIN + SKIRT_PAD;
  const sx = lx < 0 ? -1 : 1, sz = lz < 0 ? -1 : 1;
  const near = r.hx - Math.abs(lx) < r.hz - Math.abs(lz);
  const tries = [[sx * ex, sz * ez], near ? [sx * ex, lz] : [lx, sz * ez]];
  const mark = out.length;
  for (const [ux, uz] of tries) {
    const qx = r.x + ux * r.c + uz * r.s, qz = r.z - ux * r.s + uz * r.c;
    const c = cellIndex(Math.floor((qx - ORIGIN_X) / CELL), Math.floor((qz - ORIGIN_Z) / CELL));
    if (c < 0 || fp.walls[c] || keep?.(qx, qz) || !outlineClear(state, qx, qz)) continue;
    if (!segmentClear(fp.walls, ax, az, qx, qz, true) || !segmentClear(fp.walls, qx, qz, bx, bz, false)) continue;
    if (!legDry(ax, az, qx, qz) || !legDry(qx, qz, bx, bz)) continue;
    if (skirtLeg(state, fp, ax, az, qx, qz, depth + 1, out, keep)) {
      out.push(qx, qz);
      if (skirtLeg(state, fp, qx, qz, bx, bz, depth + 1, out, keep)) return true;
    }
    out.length = mark;
  }
  return false;
}

// Where people stop to go in: the street cell in front of the door (a farm: its gate
// on the headland), or, where the building's own steps, porch or plinth (a farmhouse
// by the gate) reach over it, the first cell beyond them (up to two more, on dry
// walkable ground). A pure function of the record and the terrain, so a restored town
// agrees.
export function doorstepCell(b, rects = null) {
  const front = b.type === 'farm' ? doorCell(b) : frontCell(b);
  if (front < 0 || b.type === 'park' || b.type === 'bridge') return front;
  rects ??= buildingOutline(b);
  if (!rects.length) return front;
  const [fx, fz] = cellXZ(front);
  const [dx, dz] = ROT_DIR[b.rot ?? 0];
  const t = terrainGrid();
  for (let k = 0; k < 3; k++) {
    const i = fx + dx * k, j = fz + dz * k;
    const c = cellIndex(i, j);
    // Not into the river (a mill's race) or over a drop: then the street cell it is.
    if (c < 0 || (k > 0 && (t.water[c] || tooSteep(t, c)))) break;
    if (!rects.some((r) => coreHit(r, i, j, PERSON_MARGIN))) return c;
  }
  return front;
}

// Farms: crops inside, a one-cell headland ring people may walk and wear.
// Parks: lawn throughout.
function stampField(fp, b, R = ALL) {
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  const crop = b.type === 'farm';
  for (let z = Math.max(cz0, R.z0); z <= Math.min(cz1, R.z1); z++)
    for (let x = Math.max(cx0, R.x0); x <= Math.min(cx1, R.x1); x++) {
      const j = z * GRID_W + x;
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
  const { walls: blocked } = footprints(state);
  for (let k = Math.max(0, fromIndex); k + 3 < route.length; k += 2) {
    if (!segmentClear(blocked, route[k], route[k + 1], route[k + 2], route[k + 3], k === fromIndex)) return false;
  }
  return true;
}

// A memo for a walk routeClearFrom has just found clear: from flat index `from` on,
// every leg's cells are open. That stays true while no cell in the tiles those legs
// cover becomes a wall (wallGen), so wallsStillClear then only needs the leg from
// where the walker now stands. Same rules as skirtMemo: the same route object,
// unchanged in length, and a `from` no later than the walker's segment.
export function wallMemo(state, route, from) {
  const fp = footprints(state);
  return { gen: fp.gen, wallGen: fp.wallGen, length: route.length, from, ...walkTiles(route, from) };
}

// routeClearFrom(state, x, z, route, seg), known from the memo without walking the
// whole route: only legs whose tiles changed since are walked again, and the leg from
// where the walker stands. Undefined when the memo cannot tell (do the full check).
// A memo that holds is moved up to the current build.
export function wallsStillClear(state, memo, x, z, route, seg) {
  const fp = footprints(state);
  if (!memo || memo.wallGen !== fp.wallGen || memo.length !== route.length || seg < memo.from || seg + 1 >= route.length) return undefined;
  const walls = fp.walls;
  if (!memoCatchUp(fp, memo, fp.wallGen, 'wall', seg, (k) => segmentClear(walls, route[k], route[k + 1], route[k + 2], route[k + 3], false))) return undefined;
  return segmentClear(walls, x, z, route[seg], route[seg + 1], true);
}

// Footprint checks by tile (people.js checkFootprints). A walker whose next few legs are
// clear of every wall and drawn piece as continuous lines, not only at the samples the
// checks take, gets the same answers from those checks wherever it is along them: each
// sample a check takes from where it stands lies on such a leg, within rounding. So
// while the tiles under those legs (and under its memos' legs) keep their cells, it
// need not be checked at all (legsCertified, changedTilesSince).

// Is the leg a -> b clear of walls and drawn pieces as a line: every cell within
// CERT_EPS of it open, on the map, and no piece near those cells (grown by a walker's
// margin and ALONG_EPS) met by it? tiles (an array), when given, collects the tiles of
// those cells (each once while they come in order). Conservative: false only means
// "not known".
const CERT_EPS = 1e-6;
export function legCertified(fp, ax, az, bx, bz, tiles = null) {
  const x0 = Math.min(ax, bx) - CERT_EPS, x1 = Math.max(ax, bx) + CERT_EPS;
  const z0 = Math.min(az, bz) - CERT_EPS, z1 = Math.max(az, bz) + CERT_EPS;
  const cx0 = Math.floor((x0 - ORIGIN_X) / CELL), cx1 = Math.floor((x1 - ORIGIN_X) / CELL);
  const cz0 = Math.floor((z0 - ORIGIN_Z) / CELL), cz1 = Math.floor((z1 - ORIGIN_Z) / CELL);
  if (cx0 < 0 || cz0 < 0 || cx1 >= GRID_W || cz1 >= GRID_H) return false;
  const walls = fp.walls;
  for (let cz = cz0; cz <= cz1; cz++)
    for (let cx = cx0; cx <= cx1; cx++) {
      // Only cells the leg (grown by CERT_EPS) passes through.
      const qx = ORIGIN_X + cx * CELL, qz = ORIGIN_Z + cz * CELL;
      if (!segmentMeetsBox(ax, az, bx, bz, qx - CERT_EPS, qz - CERT_EPS, qx + CELL + CERT_EPS, qz + CELL + CERT_EPS)) continue;
      const c = cz * GRID_W + cx;
      if (walls[c]) return false;
      if (fp.nearAt[c]) {
        const list = nearIn(fp, c);
        if (list) for (const r of list) if (stretchMeets(r, ax, az, bx, bz)) return false;
      }
      if (tiles) {
        const t = Math.floor(cz / NEAR_TILE) * TILES_W + Math.floor(cx / NEAR_TILE);
        if (!tiles.includes(t)) tiles.push(t);
      }
    }
  return true;
}

// Does the segment a -> b meet the box [x0, x1] x [z0, z1] (edges included)?
function segmentMeetsBox(ax, az, bx, bz, x0, z0, x1, z1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  if (dx === 0) { if (ax < x0 || ax > x1) return false; }
  else {
    const a = (x0 - ax) / dx, b = (x1 - ax) / dx;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  if (dz === 0) return az >= z0 && az <= z1;
  const a = (z0 - az) / dz, b = (z1 - az) / dz;
  return Math.max(t0, Math.min(a, b)) <= Math.min(t1, Math.max(a, b));
}

// The tiles whose cells changed (near lists or walls) in the footprint builds after
// generation gen, as a mask over the tiles with the generation it is good for:
// {gen, mask, lineage} where lineage is the tile arrays a memo or certificate was made
// against. Null when the log does not reach back that far (then nothing is known).
export function changedTilesSince(state, gen) {
  const fp = footprints(state);
  if (gen == null || fp.gen - gen > TILE_LOG || fp.gen < gen) return null;
  const mask = new Uint8Array(TILES_W * TILES_H);
  let tx0 = TILES_W, tz0 = TILES_H, tx1 = -1, tz1 = -1, count = 0;
  for (let g = gen + 1; g <= fp.gen; g++) {
    const e = fp.log[g % TILE_LOG];
    if (!e || e.gen !== g) return null;
    for (const list of [e.near, e.wall]) {
      for (const t of list) {
        if (mask[t]) continue;
        mask[t] = 1;
        count++;
        const tx = t % TILES_W, tz = (t - tx) / TILES_W;
        if (tx < tx0) tx0 = tx;
        if (tx > tx1) tx1 = tx;
        if (tz < tz0) tz0 = tz;
        if (tz > tz1) tz1 = tz;
      }
    }
  }
  return { gen: fp.gen, mask, count, tx0, tz0, tx1, tz1, tileGen: fp.tileGen, wallGen: fp.wallGen };
}

// Could a tile in tiles (with their box tx0..tz1, as walkTiles gives) be in changed
// (changedTilesSince)? The boxes first, then the tiles themselves.
export function tilesTouched(changed, tiles, tx0, tz0, tx1, tz1) {
  if (!changed.count || tx1 < changed.tx0 || tx0 > changed.tx1 || tz1 < changed.tz0 || tz0 > changed.tz1) return false;
  const mask = changed.mask;
  for (let i = 0; i < tiles.length; i++) if (mask[tiles[i]]) return true;
  return false;
}

// The footprint build's generation and tile arrays (what changedTilesSince is asked from).
export function footprintGen(state) {
  const fp = footprints(state);
  return { gen: fp.gen, tileGen: fp.tileGen, wallGen: fp.wallGen };
}

// Could a tile a memo's legs sample (skirtMemo, wallMemo) be in changed?
export const memoTouched = (changed, memo) => tilesTouched(changed, memo.tiles, memo.tx0, memo.tz0, memo.tx1, memo.tz1);

// The box of a list of tiles.
export function tileBox(tiles) {
  let tx0 = TILES_W, tz0 = TILES_H, tx1 = -1, tz1 = -1;
  for (const t of tiles) {
    const tx = t % TILES_W, tz = (t - tx) / TILES_W;
    if (tx < tx0) tx0 = tx;
    if (tx > tx1) tx1 = tx;
    if (tz < tz0) tz0 = tz;
    if (tz > tz1) tz1 = tz;
  }
  return { tx0, tz0, tx1, tz1 };
}

// routeStillValid of [x, z, ...route from flat index seg] without building
// that list: the walk from (x, z) to the waypoint skips its starting cell.
export function routeClearFrom(state, x, z, route, seg) {
  if (!route || seg + 1 >= route.length) return true;
  const { walls: blocked } = footprints(state);
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
// The walkable grid as the lot layer has it (fp.blocked, not the walkers' walls):
// whether a door opens onto the town is a matter of lots and footprints, as sites and
// lots judge it (buildings.js freeSealedDoors), not of the plinth and steps drawn on
// them. Only which cells are passable is meaningful here.
const lotNavCache = new WeakMap();
const NO_DOORS = new Uint8Array(CELLS);
export function lotNavGrid(state) {
  ensureRoads(state);
  const key = navKey(state);
  const hit = lotNavCache.get(state);
  if (hit && hit.key === key) return hit;
  const fp = footprints(state);
  const lot = { walls: fp.blocked, door: NO_DOORS, field: fp.field };
  const adj = adjacencyOf(state.roads), fords = fordsNearBridges(state);
  const cost = new Float32Array(CELLS);
  for (let i = 0; i < CELLS; i++) cost[i] = cellCost(state, i, lot, adj, fords);
  const grid = { key, W: GRID_W, H: GRID_H, ox: ORIGIN_X, oz: ORIGIN_Z, cell: CELL, cost };
  lotNavCache.set(state, grid);
  return grid;
}

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
  return cellCostOf(state.roads, terrainGrid(), i, fp, adj, fords);
}

// cellCost with the roads and terrain grid looked up once by the caller (whole-grid loops).
function cellCostOf(r, t, i, fp, adj, fords) {
  const w = t.water[i];
  if (w) return isBridge(r, i) ? TIER_COST[r.tier[i]] : w === 2 ? (fords[i] ? FORD_NEAR_BRIDGE_COST : FORD_COST) : Infinity;
  if (fp.walls[i] || tooSteep(t, i)) return Infinity;
  if (fp.door[i]) return DOOR_COST;
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
  const t = terrainGrid();
  const { water } = t;
  const adj = adjacencyOf(r);
  const fp = footprints(state);
  const fords = fordsNearBridges(state);
  const last = navInputs.get(state);
  let cost, wcode;
  if (last && last.r === r && last.t === t && inputViews(r, adj, fords)) {
    // Every cell's cost and water code is a function of its own inputs alone: the cells
    // whose inputs are as they were at the last build keep that build's values.
    // Copied when a cell first changes, so a build that changes nothing shares the
    // last one's arrays (as a footprint patch shares its water codes).
    cost = last.cost;
    wcode = last.water;
    const redo = (i) => {
      const w = water[i] ? (isBridge(r, i) ? 3 : water[i]) : 0;
      if (w !== wcode[i]) {
        if (wcode === last.water) wcode = wcode.slice();
        wcode[i] = w;
      }
      const c = Math.fround(cellCostOf(r, t, i, fp, adj, fords));
      if (!Object.is(c, cost[i])) {
        if (cost === last.cost) cost = cost.slice();
        cost[i] = c;
      }
    };
    const now = inputViews(r, adj, fords), was = last.views;
    for (let w = 0; w < CELLS / 4; w++) {
      if (now.tier[w] === was.tier[w] && now.planned[w] === was.planned[w] && now.adj[w] === was.adj[w] && now.fords[w] === was.fords[w]) continue;
      for (let i = w * 4; i < w * 4 + 4; i++) redo(i);
    }
    for (let i = 0; i < CELLS; i++) if (now.wear[i] !== was.wear[i]) redo(i);
    if (fp.key !== last.fpKey) {
      for (let i = 0; i < CELLS; i++) {
        if ((fp.walls[i] ? 1 : 0) !== last.walls[i] || (fp.door[i] ? 1 : 0) !== last.door[i] || fp.field[i] !== last.field[i]) redo(i);
      }
    }
  } else {
    cost = new Float32Array(CELLS);
    wcode = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
      wcode[i] = water[i] ? (isBridge(r, i) ? 3 : water[i]) : 0;
      cost[i] = cellCostOf(r, t, i, fp, adj, fords);
    }
  }
  noteNavInputs(state, r, t, adj, fp, fords, cost, wcode);
  const nodes = nodesFor(r, prev, navNodeDirty);
  return owned({ key, bucket, tick, footprintsOnly: false, fp, W: GRID_W, H: GRID_H, ox: ORIGIN_X, oz: ORIGIN_Z, cell: CELL, cost, passCap: DOOR_COST, passOpen: TIER_COST[0], water: wcode, height: terrainGrid().height, ...nodes }, r);
}

// What each cell's cost and water code were last built from (cellCostOf's inputs: tier,
// wear, flags, road adjacency, the fords closed by bridges, walls, door and field; the
// terrain grid as a whole), with that build's costs and codes. In memory only; a footprint
// patch in between changes nothing here, since the next build compares with this one.
const navInputs = new WeakMap();
function noteNavInputs(state, r, t, adj, fp, fords, cost, water) {
  const prev = navInputs.get(state);
  const keep = prev && prev.r === r ? prev : null;
  const copy = (src, old) => (old && old.length === src.length ? (old.set(src), old) : src.slice());
  const next = {
    r, t, cost, water, fpKey: fp.key,
    tier: copy(r.tier, keep?.tier), planned: copy(r.planned, keep?.planned), adj: copy(adj, keep?.adj),
    fords: copy(fords, keep?.fords), wear: copy(r.wear, keep?.wear),
    walls: keep?.walls ?? new Uint8Array(CELLS), door: keep?.door ?? new Uint8Array(CELLS), field: keep?.field ?? new Uint8Array(CELLS),
  };
  if (keep?.fpKey !== fp.key) {
    for (let i = 0; i < CELLS; i++) { next.walls[i] = fp.walls[i] ? 1 : 0; next.door[i] = fp.door[i] ? 1 : 0; }
    next.field.set(fp.field);
  }
  next.views = inputViews(next, next.adj, next.fords);
  if (!next.views) { navInputs.delete(state); return; }
  navInputs.set(state, next);
}

// The inputs as 32-bit words for comparing (four cells to a word for the byte arrays,
// wear by its bits), or null when an array is not of the expected kind.
function inputViews(r, adj, fords) {
  const words = (a, kind) => (a instanceof kind && a.length === CELLS && a.byteOffset % 4 === 0 ? new Uint32Array(a.buffer, a.byteOffset, (a.length * kind.BYTES_PER_ELEMENT) / 4) : null);
  const v = { tier: words(r.tier, Uint8Array), planned: words(r.planned, Uint8Array), adj: words(adj, Uint8Array), fords: words(fords, Uint8Array), wear: words(r.wear, Float32Array) };
  return v.tier && v.planned && v.adj && v.fords && v.wear ? v : null;
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
    if (old.walls[i] !== fp.walls[i] || old.door[i] !== fp.door[i] || old.field[i] !== fp.field[i]) cost[i] = cellCost(state, i, fp, adj, fords);
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

// Region labels depend only on grid dimensions and cost < Infinity, not the
// cost of walking through each open cell. Reuse them only while that stays true.
function structuralComponents(grid) {
  return grid?.W === GRID_W && grid?.H === GRID_H && grid.comp?.length === CELLS ? grid.comp : undefined;
}

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
  const ctx = structuralContext(state);
  let cost, wcode, comp = structuralComponents(prev);
  if (prev && prev.roads === r && prev.navRev === r.navRev && prev.fp && prev.fords === ctx.fords) {
    // Only the footprints changed (same roads, works and bridges): every cell's cost is a
    // function of its own inputs, so only the cells whose lot layer changed, and those beside
    // a tier changed since, can differ from a full build. The rest keep their values.
    cost = prev.cost.slice();
    wcode = prev.water.slice();
    const redo = (i) => {
      structuralCell(ctx, i, cost, wcode);
      if (comp && (cost[i] < Infinity) !== (prev.cost[i] < Infinity)) comp = undefined;
    };
    const ob = prev.fp.blocked, nb = ctx.fp.blocked, of = prev.fp.field, nf = ctx.fp.field;
    for (let i = 0; i < CELLS; i++) if (!ob[i] !== !nb[i] || of[i] !== nf[i]) redo(i);
    for (const i of structuralDirty.get(r) ?? []) {
      const cx = i % GRID_W, cz = (i - cx) / GRID_W;
      for (let z = Math.max(0, cz - 1); z <= Math.min(GRID_H - 1, cz + 1); z++)
        for (let x = Math.max(0, cx - 1); x <= Math.min(GRID_W - 1, cx + 1); x++) redo(z * GRID_W + x);
    }
  } else {
    cost = new Float32Array(CELLS);
    wcode = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
      structuralCell(ctx, i, cost, wcode);
      if (comp && (cost[i] < Infinity) !== (prev.cost[i] < Infinity)) comp = undefined;
    }
  }
  const nodes = nodesFor(r, prev, structuralNodeDirty);
  grid = owned({ key: `${base}:${r.version}`, bucket: base, base, roads: r, navRev: r.navRev, fp: ctx.fp, fords: ctx.fords, W: GRID_W, H: GRID_H, ox: ORIGIN_X, oz: ORIGIN_Z, cell: CELL, cost, water: wcode, height: terrainGrid().height, ...nodes, comp }, r);
  structuralCache.set(state, grid);
  structuralDirty.set(r, new Set());
  return grid;
}

// structuralGrid(state).water[i], without bringing the grid up to date: where
// structuralGrid would build it afresh (no grid yet, a new footprint or works), or patch
// this cell (one beside a tier changed since), the cell's code is worked out as
// structuralCell would; elsewhere it is read from the grid as it stands. Walkers ask this
// of every wet sample of a leg (people.js fordCell), and updating the grid there, between
// any two tier changes, copied the whole grid each time; it is now updated when a route
// search or the centres next need it, to the same contents.
export function structuralWaterAt(state, i) {
  ensureRoads(state);
  const r = state.roads;
  const grid = structuralCache.get(state);
  if (!grid || grid.roads !== r || grid.base !== `${r.navRev}:${footprintKey(state)}`) return structuralWaterOf(r, i);
  const dirty = structuralDirty.get(r);
  if (dirty?.size) {
    const cx = i % GRID_W, cz = (i - cx) / GRID_W;
    for (let z = Math.max(0, cz - 1); z <= Math.min(GRID_H - 1, cz + 1); z++)
      for (let x = Math.max(0, cx - 1); x <= Math.min(GRID_W - 1, cx + 1); x++) {
        if (dirty.has(z * GRID_W + x)) return structuralWaterOf(r, i);
      }
  }
  return grid.water[i];
}

// structuralCell's water code for cell i as the roads are now.
function structuralWaterOf(r, i) {
  const w = terrainGrid().water[i];
  return w ? (isBridge(r, i) ? 3 : w) : 0;
}

// The structural grid as walkers see it (people.js syncRoute): the same costs, with
// the cells drawn pieces take (fp.walls beyond the lot layer) closed and the door
// cells dear. The structural grid itself stays the lot layer's: the town's aggregate
// traffic, centres and works plan over lots and footprints, as before. Pure for the
// same saved state, like the grid it is made from.
const walkerGridCache = new WeakMap();
export function walkerGrid(state) {
  const base = structuralGrid(state);
  const fp = footprints(state);
  const hit = walkerGridCache.get(state);
  if (hit && hit.base === base && hit.fp === fp) return hit.grid;
  const cost = base.cost.slice();
  for (const i of fp.wallCells) cost[i] = Infinity;
  for (const i of fp.doorCells) if (cost[i] < Infinity) cost[i] = DOOR_COST;
  const grid = { ...base, key: `${base.key}:w${fp.key}`, cost, passCap: DOOR_COST, passOpen: TIER_COST[0], comp: undefined, coarse: undefined, blockCost: undefined };
  walkerGridCache.set(state, { base, fp, grid });
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
  let comp = structuralComponents(prev);
  const nodes = nodeDirty.size ? patchedNodes(state.roads, prev, nodeDirty) : { nodeX: prev.nodeX, nodeZ: prev.nodeZ, nodeLinks: prev.nodeLinks };
  const ctx = structuralContext(state);
  for (const i of dirty) {
    const cx = i % GRID_W, cz = (i - cx) / GRID_W;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x >= 0 && z >= 0 && x < GRID_W && z < GRID_H) {
          const i = z * GRID_W + x;
          structuralCell(ctx, i, cost, wcode);
          if (comp && (cost[i] < Infinity) !== (prev.cost[i] < Infinity)) comp = undefined;
        }
      }
  }
  return { ...prev, key: `${prev.base}:${state.roads.version}`, cost, water: wcode, ...nodes, comp, coarse: undefined, blockCost: undefined };
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
  const box = activeBox(r);
  let x0 = GRID_W, z0 = GRID_H, x1 = -1, z1 = -1;
  for (let bz = box.z0, bz1 = box.z1, bx0 = box.x0, bx1 = box.x1; bz <= bz1; bz++)
  for (let i = bz * GRID_W + bx0, end = bz * GRID_W + bx1; i <= end; i++) {
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
  // Every cell with wear or a tier was in the box and is now in [x0, x1] x [z0, z1].
  Object.assign(box, { x0, z0, x1, z1 });
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
  const box = activeBox(r);
  for (let bz = box.z0; bz <= box.z1; bz++)
  for (let i = bz * GRID_W + box.x0, end = bz * GRID_W + box.x1; i <= end; i++) {
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
  // Two cells in from the edge, so every neighbour index below is in range; cells
  // outside the box have no wear.
  const box = activeBox(r);
  const xa = Math.max(2, box.x0), xb = Math.min(W - 3, box.x1);
  for (let z = Math.max(2, box.z0); z <= Math.min(GRID_H - 3, box.z1); z++) {
    for (let x = xa, i = z * W + xa; x <= xb; x++, i++) {
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
// footprints, and centroids can land on a roof or in the river). walker: passable to
// walkers (fp.walls), and never a door cell inside the walls.
export function nearestOpen(state, i, radius = 6, walker = false) {
  if (i < 0) return -1;
  const door = walker ? footprints(state).door : NO_DOORS;
  if (Number.isFinite(roadCost(state, i, walker)) && !terrainGrid().water[i] && !door[i]) return i;
  const [cx, cz] = cellXZ(i);
  for (let rad = 1; rad <= radius; rad++) {
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
        const j = cellIndex(cx + dx, cz + dz);
        if (j >= 0 && !terrainGrid().water[j] && !door[j] && Number.isFinite(roadCost(state, j, walker))) return j;
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
// The nav grid's costs and water codes worked out afresh for every cell (as buildNavGrid
// did before it reused unchanged cells).
function freshNavCells(state) {
  const r = state.roads, t = terrainGrid(), adj = adjacencyOf(r), fp = footprints(state), fords = fordsNearBridges(state);
  const cost = new Float32Array(CELLS), water = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    water[i] = t.water[i] ? (isBridge(r, i) ? 3 : t.water[i]) : 0;
    cost[i] = cellCostOf(r, t, i, fp, adj, fords);
  }
  return { cost, water };
}

export const __test = { consolidateWear, bridgeGaps, decayAndRetier, seedReclaimedPaths, freshNavCells };


