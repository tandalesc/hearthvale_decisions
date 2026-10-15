// Planned works. The sim finds where a work is needed and what it costs; the
// bodies turn candidates into docket cards; the player only approves. An
// approved work becomes projects that builders carry out cell by cell.
import { addBuildingRecord, removeBuildingRecord, touchBuilding, byId, emitChronicle, setTag } from './state.js';
import { riverX, bankDistance, bankSide, WATER_HALF, FORDS } from '../terrain.js';
import {
  CELL, GRID_W, GRID_H, CELLS, PLANNED_MAX, FLAG, BAND_CELLS, ORIGIN_X, ORIGIN_Z,
  cellIndex, cellXZ, cellCenter, terrainGrid, footprints, setPlannedTier, bumpNav, bandCenterZ, markDirty, setTowpath,
  structuralGrid, cellOf, setTier, crossRiverShare, crossRiverTies, zBand, nearestOpen,
} from './roads.js';
import { ERA_COST, createProject, registerProjectKind, demolish, costOf, placeBuilding } from './buildings.js';
import { buildingBins, nearestDistrictId, proposeSites } from './sites.js';
import { settleFoundations } from './buildings.js';
import { liveCentres, centreRef } from './centres.js';
import { crossingAt, bridgeGeometry, deckCells, deckYFor, BRIDGE_WIDTH, DECK_TIER, bridgeLoad, bridgeCapacity, settleDesignTraffic } from './bridges.js';
import { findRoute } from '../navigation.js';
import { districtById } from './districts.js';
import { policyModifiers } from './policies.js';

export const UNIT_COST = { grade: 40, pave: 90, avenue: 150, ring: 70, square: 120, grid: 40, turnpike: 60 };
export const BRIDGE_COST = { basic: 350, timber: 1600, stone: 4800 };
export const BRIDGE_XINGS = 400;
const BRIDGE_SPACING = 30;     // cells between bridges
const PAVE_MIN_CELLS = 12;
const PAVE_MAX_CELLS = 60;
const PAVE_WEAR = { 3: 600, 4: 2000 };   // average wear wanted, by target tier
const AVENUE_WEAR = 6000;
const SQUARE_SIZE = 6;
const GRID_SPACING = 8;
const GRID_RADIUS = 16;

function scale(state) { return ERA_COST[Math.max(0, Math.min(5, state.era ?? 0))]; }
function done(state) { return (state.roads.worksDone ??= {}); }

function placeName(state, x, z) {
  const d = districtById(state, nearestDistrictId(state, x, z));
  return d?.name ?? 'the town';
}

function centreOf(cells) {
  let x = 0, z = 0;
  for (const i of cells) { const c = cellCenter(i); x += c.x; z += c.z; }
  return { x: x / cells.length, z: z / cells.length };
}

function coarseKey(i) {
  const [cx, cz] = cellXZ(i);
  return `${Math.floor(cx / 16)},${Math.floor(cz / 16)}`;
}

// 4-connected components of cells matching `test`.
function components(test) {
  const seen = new Uint8Array(CELLS);
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    if (seen[i] || !test(i)) continue;
    const comp = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      for (const n of neighbours4(c)) {
        if (!seen[n] && test(n)) { seen[n] = 1; stack.push(n); }
      }
    }
    out.push(comp);
  }
  return out;
}

function neighbours4(i) {
  const [cx, cz] = cellXZ(i);
  const out = [];
  if (cx > 0) out.push(i - 1);
  if (cx < GRID_W - 1) out.push(i + 1);
  if (cz > 0) out.push(i - GRID_W);
  if (cz < GRID_H - 1) out.push(i + GRID_W);
  return out;
}

// The busiest contiguous stretch of a component: a breadth-first walk from
// its most worn cell through well-worn cells, in walking order.
function busiestStretch(state, comp, minWear, maxCells) {
  const wear = state.roads.wear;
  const inComp = new Set(comp);
  let seed = comp[0];
  for (const i of comp) if (wear[i] > wear[seed]) seed = i;
  const order = [seed];
  const seen = new Set(order);
  for (let k = 0; k < order.length && order.length < maxCells; k++) {
    const next = neighbours4(order[k]).filter(n => inComp.has(n) && !seen.has(n) && wear[n] >= minWear * 0.5);
    next.sort((a, b) => wear[b] - wear[a]);
    for (const n of next) {
      if (order.length >= maxCells) break;
      seen.add(n);
      order.push(n);
    }
  }
  return order;
}

function avgWear(state, cells) {
  let s = 0;
  for (const i of cells) s += state.roads.wear[i];
  return cells.length ? s / cells.length : 0;
}

// ---------------------------------------------------------------- pave / grade

// Era 1 grades busy tracks into roads (tier 3); from era 2 the busiest roads
// can be paved (tier 4). Top `limit` stretches by wear.
export function paveCandidates(state, { limit = 3 } = {}) {
  const target = Math.min(4, PLANNED_MAX[state.era ?? 0]);
  if (target < 3) return [];
  const source = target - 1;
  const { tier, planned } = state.roads;
  const { water } = terrainGrid();
  const minWear = PAVE_WEAR[target];
  const out = [];
  for (const comp of components(i => tier[i] === source && !water[i] && !(planned[i] & FLAG.PLANNED))) {
    if (comp.length < PAVE_MIN_CELLS) continue;
    const cells = busiestStretch(state, comp, minWear, PAVE_MAX_CELLS);
    const wear = avgWear(state, cells);
    if (cells.length < PAVE_MIN_CELLS || wear < minWear) continue;
    out.push({ cells, wear });
  }
  out.sort((a, b) => b.wear - a.wear);
  return out.slice(0, limit).map(({ cells, wear }) => paveCard(state, cells, wear, target));
}

function paveCard(state, cells, wear, tier) {
  const kind = 'pave';
  const unit = UNIT_COST[tier === 3 ? 'grade' : 'pave'] * scale(state);
  const half = cells.slice(0, Math.ceil(cells.length / 2));
  const c = centreOf(cells);
  const where = placeName(state, c.x, c.z);
  const cost = Math.round(cells.length * unit);
  return {
    key: `${kind}:${coarseKey(cells[0])}`,
    kind, tier, cells, wear: Math.round(wear), x: c.x, z: c.z, where, place: `in ${where}`, cost,
    title: tier === 3 ? `Grade the track in ${where}` : `Pave the lane in ${where}`,
    why: tier === 3
      ? `The track in ${where} is busy. Carts get stuck when it rains. A graded road would drain and stay firm.`
      : `The road in ${where} is the busiest in town. In wet weather it turns to mud. Cobbles would keep it clean.`,
    options: [
      { key: 'all', cost, cells: cells.length },
      { key: 'half', cost: Math.round(half.length * unit), cells: half.length },
      { key: 'wait', cost: 0 },
    ],
    half,
  };
}

// ---------------------------------------------------------------- bridges

function bridgeZs(state, { carts = false } = {}) {
  // A fallen bridge no longer holds a crossing, unless it is being rebuilt.
  const rebuilding = new Set((state.projects ?? []).map(p => p.data?.replaces ?? p.buildingId));
  const zs = (state.buildings ?? []).filter(b => b.type === 'bridge' && (!carts || b.variant !== 'footbridge') && (!b.collapsed || rebuilding.has(b.id))).map(b => b.z);
  for (const p of state.projects ?? []) if (p.kind === 'bridge') zs.push(p.z);
  return zs;
}

// A bridge where crossings concentrate: a band with >= 400 crossings a year
// and no bridge within 30 cells. With {basic: true}: a cheap narrow timber
// cart bridge at the busiest ford, offered from the first years, once a
// band sees max(12, 0.12 x population) crossings a year or 8% of households
// cross the river. A footbridge there does not count against it.
export const BASIC_SHARE = 0.08;

export function bridgeCandidates(state, { threshold = BRIDGE_XINGS, basic = false } = {}) {
  if (basic) return basicBridgeCandidates(state);
  // A footbridge does not count: a cart bridge replaces it.
  const existing = bridgeZs(state, { carts: true });
  const bands = Object.entries(state.roads.xings ?? {})
    .map(([band, n]) => ({ band: Number(band), n }))
    .filter(b => b.n >= threshold)
    .sort((a, b) => b.n - a.n || a.band - b.band);
  const out = [];
  for (const { band, n } of bands) {
    const z = bandCenterZ(band);
    if (existing.some(bz => Math.abs(bz - z) < BRIDGE_SPACING * CELL)) continue;
    if (out.some(c => Math.abs(c.z - z) < BRIDGE_SPACING * CELL)) continue;
    const span = bridgeSpan(state, band);
    if (span) out.push(bridgeCard(state, span, n));
  }
  return out;
}

function basicBridgeCandidates(state) {
  const pop = state.indicators?.pop ?? (state.households ?? []).reduce((n, h) => n + (h.size ?? 1), 0);
  const need = Math.max(12, 0.12 * pop);
  const share = crossRiverShare(state);
  const existing = bridgeZs(state, { carts: true });
  const bands = Object.entries(state.roads.xings ?? {})
    .map(([band, n]) => ({ band: Number(band), n }))
    .filter(b => b.n >= need || (share >= BASIC_SHARE && b.n > 0))
    .sort((a, b) => b.n - a.n || a.band - b.band);
  for (const { band, n } of bands) {
    const z = bandCenterZ(band);
    if (existing.some(bz => Math.abs(bz - z) < BRIDGE_SPACING * CELL)) continue;
    const span = bridgeSpan(state, band, { preferFord: true });
    if (!span) continue;
    const card = bridgeCard(state, span, n);
    const cost = Math.round(BRIDGE_COST.basic * scale(state));
    return [{
      ...card, key: `bridge:basic:${band}`, basic: true, cost, share: Math.round(share * 100) / 100,
      title: `A cart bridge at the ${card.where} ford`,
      why: `Carts and people splash through the ford by ${card.where} every day. A simple timber bridge would carry them over.`,
      options: [{ key: 'timber', cost, tier: 3 }, { key: 'wait', cost: 0 }],
    }];
  }
  return [];
}

// The best crossing in a band: the shortest span perpendicular to the river
// (ends on dry ground), near the middle of the band. Fords are preferred when
// asked (a basic bridge goes where the river is shallow).
export function bridgeSpan(state, band, { preferFord = false } = {}) {
  const { water } = terrainGrid();
  const z0 = ORIGIN_Z + band * BAND_CELLS * CELL;
  let best = null;
  for (let k = 0; k < BAND_CELLS * 2; k++) {
    const z = z0 + (k + 0.5) * CELL / 2;
    const crossing = crossingAt(z);
    const centre = cellOf(crossing.centre.x, z);
    const ford = centre >= 0 && water[centre] === 2;
    const score = crossing.length + Math.abs(z - (z0 + BAND_CELLS * CELL / 2)) * 0.05 - (preferFord && ford ? 6 : 0);
    if (!best || score < best.score) best = { crossing, z, ford, score };
  }
  if (!best) return null;
  const { crossing } = best;
  const geo = bridgeGeometry(crossing, 'timber');
  return { crossing, cells: geo.cells, a: crossing.a, b: crossing.b, x: geo.x, z: geo.z, w: geo.w, d: geo.d, length: crossing.length, band, ford: best.ford };
}

function bridgeCard(state, span, crossings) {
  const where = placeName(state, span.x, span.z);
  const ford = span.ford || span.cells.some(i => terrainGrid().water[i] === 2);
  const s = scale(state);
  return {
    key: `bridge:${span.band}`,
    kind: 'bridge', cells: span.cells, x: span.x, z: span.z, w: span.w, d: span.d, band: span.band,
    a: span.a, b: span.b, crossing: span.crossing, length: Math.round(span.length * 10) / 10,
    crossings: Math.round(crossings), where, ford, place: ford ? `at the ford by ${where}` : `near ${where}`,
    cost: Math.round(BRIDGE_COST.timber * s),
    title: ford ? `A bridge at the ${where} ford` : `A bridge by ${where}`,
    why: ford
      ? `Many people wade across at the ford by ${where}. In spring it floods. A bridge would save them time.`
      : `People walk a long way round to cross the river near ${where}. A bridge would bring both banks together.`,
    options: [
      { key: 'timber', cost: Math.round(BRIDGE_COST.timber * s), tier: 3 },
      { key: 'stone', cost: Math.round(BRIDGE_COST.stone * s), tier: 4 },
      { key: 'ferry', cost: 0 },
    ],
  };
}

// ---------------------------------------------------------------- avenue

function blockingBuildings(state, cells) {
  const fp = footprints(state);
  const ids = new Set();
  for (const i of cells) if (fp.blocked[i]) ids.add(fp.blocked[i] - 1);
  return [...ids].map(id => byId(state, 'buildings', id)).filter(Boolean);
}

function compensation(state, buildings) {
  return buildings.reduce((sum, b) => sum + Math.round(costOf(b.type, b.tier, state.era ?? 0) * 0.5), 0);
}

export function avenueCandidates(state, { limit = 2 } = {}) {
  if ((state.era ?? 0) < 3 || PLANNED_MAX[state.era] < 5) return [];
  const { tier } = state.roads;
  const { water } = terrainGrid();
  const out = [];
  for (const comp of components(i => tier[i] === 4)) {
    if (comp.length < PAVE_MIN_CELLS || avgWear(state, comp) < AVENUE_WEAR) continue;
    const wide = new Set(comp);
    for (const i of comp) for (const n of neighbours4(i)) if (!water[n] && tier[n] < 5) wide.add(n);
    const cells = [...wide];
    const moves = blockingBuildings(state, cells);
    if (moves.some(b => b.flags?.heritage || b.type === 'bridge')) continue;
    const c = centreOf(comp);
    const where = placeName(state, c.x, c.z);
    const homes = moves.filter(b => b.type === 'home').length;
    const cost = Math.round(cells.length * UNIT_COST.avenue * scale(state)) + compensation(state, moves);
    out.push({
      key: `widen:${coarseKey(comp[0])}`, kind: 'widen', tier: 5, cells, x: c.x, z: c.z, where, place: `in ${where}`,
      demolish: moves.map(b => b.id), cost, wear: Math.round(avgWear(state, comp)),
      title: `A wide avenue through ${where}`,
      why: `The paved street in ${where} is packed every day. A wide avenue would carry the crowds.${homes ? ` ${homes} ${homes === 1 ? 'home' : 'homes'} must move; the town pays them.` : ''}`,
      options: [{ key: 'build', cost }, { key: 'wait', cost: 0 }],
    });
  }
  return out.sort((a, b) => b.wear - a.wear).slice(0, limit);
}

// ---------------------------------------------------------------- ring road

export function ringCandidate(state) {
  if (done(state).ring != null || (state.era ?? 0) < 2) return null;
  if ((state.indicators?.traffic ?? 0) < 0.6) return null;
  const { centroid, radius } = buildingBins(state);
  if (radius < 30) return null;
  const core = Math.max(12, radius / CELL * 0.4);
  if (wearShareWithin(state, centroid, core) < 0.4) return null;
  const r = radius * 1.3;
  const cells = circleCells(centroid, r);
  if (cells.length < 40) return null;
  const moves = blockingBuildings(state, cells).filter(b => b.type !== 'farm' && b.type !== 'park');
  if (moves.some(b => b.flags?.heritage)) return null;
  const tier = Math.min(4, PLANNED_MAX[state.era]);
  const cost = Math.round(cells.length * UNIT_COST.ring * scale(state)) + compensation(state, moves);
  return {
    key: 'ring', kind: 'ring', tier, cells, x: centroid.x, z: centroid.z, radius: r, where: 'the town', place: 'in the centre',
    demolish: moves.map(b => b.id), cost,
    title: 'A ring road round the town',
    why: 'The middle of town is choked with carts. A road round the edge would take them away from the centre.',
    options: [{ key: 'build', cost }, { key: 'wait', cost: 0 }],
  };
}

function wearShareWithin(state, centre, cellsRadius) {
  const wear = state.roads.wear;
  const r2 = (cellsRadius * CELL) ** 2;
  let inside = 0, total = 0;
  for (let i = 0; i < CELLS; i++) {
    const w = wear[i];
    if (!w) continue;
    total += w;
    const c = cellCenter(i);
    if ((c.x - centre.x) ** 2 + (c.z - centre.z) ** 2 <= r2) inside += w;
  }
  return total ? inside / total : 0;
}

// Cells on a circle, skipping water (the river splits the ring at bridges).
function circleCells(centre, r) {
  const { water } = terrainGrid();
  const steps = Math.ceil(2 * Math.PI * r / (CELL * 0.5));
  const seen = new Set();
  const out = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2;
    const x = centre.x + Math.cos(a) * r, z = centre.z + Math.sin(a) * r;
    const cx = Math.floor((x - ORIGIN_X) / CELL), cz = Math.floor((z - ORIGIN_X) / CELL);
    const i = cellIndex(cx, cz);
    if (i < 0 || seen.has(i) || water[i]) continue;
    seen.add(i);
    out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------- square

const SQUARE_ARCHETYPES = new Set(['market-town', 'exchange', 'cathedral']);

export function squareCandidate(state) {
  if ((state.era ?? 0) < 2 || !SQUARE_ARCHETYPES.has(state.archetype ?? 'market-town')) return null;
  const squares = (state.buildings ?? []).filter(b => b.flags?.square);
  const junction = busiestJunction(state, squares);
  if (!junction) return null;
  const [jx, jz] = cellXZ(junction);
  const x0 = jx - SQUARE_SIZE / 2, z0 = jz - SQUARE_SIZE / 2;
  const cells = [];
  const { water } = terrainGrid();
  for (let z = z0; z < z0 + SQUARE_SIZE; z++)
    for (let x = x0; x < x0 + SQUARE_SIZE; x++) {
      const i = cellIndex(x, z);
      if (i < 0 || water[i]) return null;
      cells.push(i);
    }
  const moves = blockingBuildings(state, cells);
  if (moves.some(b => b.flags?.heritage || ['chapel', 'moot', 'bridge', 'exchange'].includes(b.type))) return null;
  const c = centreOf(cells);
  const where = placeName(state, c.x, c.z);
  const tier = Math.min(5, PLANNED_MAX[state.era]);
  const cost = Math.round(cells.length * UNIT_COST.square * scale(state)) + compensation(state, moves);
  const homes = moves.filter(b => b.type === 'home').length;
  return {
    key: `square:${coarseKey(junction)}`, kind: 'square', tier, cells, x: c.x, z: c.z, where, place: `in ${where}`,
    demolish: moves.map(b => b.id), cost,
    title: `A market square in ${where}`,
    why: `The crossroads in ${where} is where everyone meets. A proper square would give the market room.${homes ? ` ${homes} ${homes === 1 ? 'home' : 'homes'} must move.` : ''}`,
    options: [{ key: 'build', cost }, { key: 'wait', cost: 0 }],
  };
}

// The tier >= 3 cell with roads leaving in at least three directions and the
// most wear around it, at least 30 cells from any square.
function busiestJunction(state, squares) {
  const { tier, wear } = state.roads;
  let best = -1, bestScore = 0;
  for (let i = 0; i < CELLS; i++) {
    if (tier[i] < 3) continue;
    const [cx, cz] = cellXZ(i);
    let arms = 0;
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
      const j = cellIndex(cx + dx, cz + dz);
      if (j >= 0 && tier[j] >= 3) arms++;
    }
    if (arms < 3) continue;
    const c = cellCenter(i);
    if (squares.some(s => Math.hypot(s.x - c.x, s.z - c.z) < 30 * CELL)) continue;
    let score = 0;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const j = cellIndex(cx + dx, cz + dz);
        if (j >= 0) score += wear[j];
      }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best >= 0 ? best : null;
}

// ---------------------------------------------------------------- grid a district

// Offered when a district is young and small, or when many households wait
// for homes: lay roads in a grid before houses come.
export function gridCandidates(state) {
  const year = state.time?.year ?? 0;
  const out = [];
  const tier = 3;
  for (const d of state.districts ?? []) {
    if (d.founded == null || year - d.founded > 2 || (d.buildings ?? 0) > 25) continue;
    if (done(state)[`grid:${d.id}`] != null) continue;
    const card = gridCard(state, d.centroid, `grid:${d.id}`, d.name, tier);
    if (card) out.push(card);
  }
  if (!out.length && (state.indicators?.housingPressure ?? 0) >= 0.5 && (state.era ?? 0) >= 1) {
    const site = proposeSites(state, { type: 'home', count: 1 })[0];
    if (site) {
      const { centroid } = buildingBins(state);
      const dx = site.x - centroid.x, dz = site.z - centroid.z, len = Math.hypot(dx, dz) || 1;
      const centre = { x: site.x + dx / len * 20, z: site.z + dz / len * 20 };
      const key = `grid:${coarseKey(cellIndexAt(centre))}`;
      if (done(state)[key] == null) {
        const card = gridCard(state, centre, key, placeName(state, centre.x, centre.z), tier);
        if (card) out.push(card);
      }
    }
  }
  return out;
}

function cellIndexAt(p) { return cellIndex(Math.floor((p.x - ORIGIN_X) / CELL), Math.floor((p.z - ORIGIN_X) / CELL)); }

function gridCard(state, centre, key, where, tier) {
  const cells = gridCells(state, centre);
  if (cells.length < 20) return null;
  const cost = Math.round(cells.length * UNIT_COST.grid * scale(state));
  return {
    key, kind: 'grid', tier, cells, x: centre.x, z: centre.z, where, place: `at ${where}`, cost,
    title: `Plan the new quarter at ${where}`,
    why: `New homes are going up at ${where}. We could lay straight streets first. Or we can let the lanes find their own way.`,
    options: [{ key: 'plan', cost }, { key: 'organic', cost: 0 }],
  };
}

function gridCells(state, centre) {
  const { water, slope } = terrainGrid();
  const fp = footprints(state);
  const [ccx, ccz] = [Math.floor((centre.x - ORIGIN_X) / CELL), Math.floor((centre.z - ORIGIN_X) / CELL)];
  const out = [];
  for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++)
    for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
      if (dx % GRID_SPACING !== 0 && dz % GRID_SPACING !== 0) continue;
      const i = cellIndex(ccx + dx, ccz + dz);
      if (i < 0 || water[i] || fp.blocked[i] || slope[i] > 0.3 || state.roads.tier[i] >= 3) continue;
      out.push(i);
    }
  // Walk outward from the centre so the streets grow from the middle.
  return out.sort((a, b) => ringDistance(a, ccx, ccz) - ringDistance(b, ccx, ccz) || a - b);
}

function ringDistance(i, cx, cz) {
  const [x, z] = cellXZ(i);
  return Math.max(Math.abs(x - cx), Math.abs(z - cz));
}

// ---------------------------------------------------------------- all candidates

// Every candidate work right now. sim-governance picks from these to draft
// cards for the Planning Office, River Authority or Moot.
export const WORK_KINDS = ['pave', 'bridge', 'bridge-upgrade', 'widen', 'ring', 'square', 'grid', 'quay', 'embankment', 'turnpike'];

export function candidateWorks(state, kinds = WORK_KINDS) {
  const out = [];
  const want = new Set(kinds);
  if (want.has('pave')) out.push(...paveCandidates(state));
  if (want.has('bridge')) out.push(...bridgeCandidates(state));
  if (want.has('widen')) out.push(...avenueCandidates(state));
  if (want.has('quay')) out.push(...quayCandidates(state));
  if (want.has('embankment')) out.push(...embankmentCandidates(state));
  if (want.has('turnpike')) out.push(...corridorCandidates(state));
  if (want.has('bridge-upgrade')) out.push(...bridgeUpgradeCandidates(state));
  if (want.has('ring')) { const r = ringCandidate(state); if (r) out.push(r); }
  if (want.has('square')) { const s = squareCandidate(state); if (s) out.push(s); }
  if (want.has('grid')) out.push(...gridCandidates(state));
  const busy = new Set((state.projects ?? []).map(p => p.data?.workKey).filter(Boolean));
  for (const c of out) c.id = c.key;
  return out.filter(c => !busy.has(c.key));
}

// ---------------------------------------------------------------- quay

// A stone quay on the best riverside site, once river trade is under way.
export const QUAY_TRADE = 0.15;

export function quayCandidates(state) {
  if ((state.era ?? 0) < 1 || (state.pressures?.riverTrade ?? 0) < QUAY_TRADE) return [];
  if ((state.buildings ?? []).filter(b => b.type === 'quay').length >= 3) return [];
  const [site] = proposeSites(state, { type: 'quay', count: 1 });
  if (!site) return [];
  const where = placeName(state, site.x, site.z);
  const cost = costOf('quay', 1, state.era ?? 0);
  return [{
    key: `quay:${coarseKey(site.front)}`, kind: 'quay', site, x: site.x, z: site.z, where, place: `by ${where}`, cost,
    title: `A stone quay by ${where}`,
    why: `Boats tie up on the mud bank by ${where}. A stone quay would let them load in any weather.`,
    options: [{ key: 'build', cost }, { key: 'wait', cost: 0 }],
  }];
}

// docket.js interface: start the candidate with this id. variant picks the
// option ('full' | 'half' for paving, 'timber' | 'stone' | 'ferry' for bridges).
export function startWork(state, workId, { variant = null, payer = 'treasury', paid = false } = {}) {
  const work = candidateWorks(state).find(w => w.id === workId);
  if (!work) return { ok: false, reason: 'gone' };
  const key = optionFor(work, variant);
  return executeWork(state, work, key, { payer, paid });
}

function optionFor(work, variant) {
  if (variant === 'full') return work.options[0].key;
  if (variant && work.options.some(o => o.key === variant)) return variant;
  return work.options[0].key;
}

// ---------------------------------------------------------------- execution

// Carries out an approved work. Returns {ok, projects, ferry?}. Money is not
// moved here: each project carries cost and payer.
export function executeWork(state, work, optionKey, { payer = 'treasury', paid = false } = {}) {
  const option = work.options?.find(o => o.key === optionKey);
  if (!option) return { ok: false, reason: 'option' };
  if (['wait', 'organic'].includes(optionKey)) return { ok: true, projects: [] };
  if (work.kind === 'bridge' && optionKey === 'ferry') {
    done(state)[work.key] = state.time?.year ?? 0;
    setTag(state, 'ferry');
    return { ok: true, projects: [], ferry: true };
  }
  const demolitions = [];
  for (const id of work.demolish ?? []) {
    const b = byId(state, 'buildings', id);
    if (!b) continue;
    const r = demolish(state, b, { payer, reason: 'works' });
    if (r.ok) demolitions.push(r.project);
  }
  const after = demolitions.map(p => p.id);
  if (work.kind === 'quay') {
    const { project } = placeBuilding(state, work.site, { type: 'quay', payer, paid, cost: option.cost });
    project.data.workKey = work.key;
    return { ok: true, projects: [project] };
  }
  if (work.kind === 'bridge-upgrade') return executeBridgeUpgrade(state, work, option, payer, paid);
  if (work.kind === 'embankment') {
    return { ok: true, projects: [...demolitions, startEmbankment(state, work, option.cost, payer, after, paid)] };
  }
  const main = work.kind === 'bridge'
    ? startBridge(state, work, optionKey, payer, after, paid)
    : startCellWork(state, work, optionKey === 'half' ? work.half : work.cells, option.cost, payer, after, paid);
  return { ok: true, projects: [...demolitions, main] };
}

function startCellWork(state, work, cells, cost, payer, after, paid) {
  const c = centreOf(cells);
  return createProject(state, {
    kind: work.kind, cells: [...cells], x: c.x, z: c.z, cost, payer, after, paid,
    work: cells.length * 2.5,
    data: { workKey: work.key, tier: work.tier, where: work.where, laid: 0 },
  });
}

function startBridge(state, work, style, payer, after, paid, { width = null, replaces = null } = {}) {
  const crossing = work.crossing ?? crossingAt(work.z);
  const geo = bridgeGeometry(crossing, style, { width });
  const { cells, ...fields } = geo;
  retireFootbridgesNear(state, geo.z, geo.x, replaces);
  const b = addBuildingRecord(state, {
    type: 'bridge', variant: style, tier: DECK_TIER[style], ...fields,
    built: 0, styleEra: state.era ?? 0, material: style === 'stone' ? 'stone' : style === 'iron' ? 'iron' : 'timber',
    occupied: true, flags: { scaffold: 1 },
  });
  const option = work.options.find(o => o.key === style);
  return createProject(state, {
    kind: 'bridge', buildingId: b.id, cells, x: geo.x, z: geo.z, w: geo.w, d: geo.d,
    cost: option?.cost ?? 0, payer, after, paid, work: style === 'stone' ? 160 : style === 'footbridge' ? 20 : 70,
    data: { workKey: work.key, tier: DECK_TIER[style], where: work.where, style, band: work.band, replaces },
  });
}

// A fallen bridge's record goes when a new bridge opens at its crossing.
function clearRuinsNear(state, b) {
  for (const ruin of [...(state.buildings ?? [])]) {
    if (ruin.type !== 'bridge' || !ruin.collapsed || ruin.id === b.id) continue;
    if (Math.abs(ruin.z - b.z) > RETIRE_REACH || Math.abs(ruin.x - b.x) > 40) continue;
    removeBuildingRecord(state, ruin.id);
    state.projects = (state.projects ?? []).filter(p => p.buildingId !== ruin.id);
  }
}

// A cart bridge going up near a footbridge (or another crossing point)
// replaces it: the old planks come up.
const RETIRE_REACH = 24;

export function retireFootbridgesNear(state, z, x, exceptId = null) {
  let n = 0;
  for (const fb of [...(state.buildings ?? [])]) {
    if (fb.type !== 'bridge' || fb.variant !== 'footbridge' || fb.id === exceptId) continue;
    if (Math.abs(fb.z - z) > RETIRE_REACH || Math.abs(fb.x - x) > 40) continue;
    clearDeck(state, fb);
    removeBuildingRecord(state, fb.id);
    state.projects = (state.projects ?? []).filter(p => p.buildingId !== fb.id);
    n++;
    emitChronicle(state, { kind: 'line', text: 'The old planks came up when the new bridge opened.', refs: { buildingId: fb.id, ...centreRef(state, fb.x, fb.z) } });
  }
  if (n) bumpNav(state);
  return n;
}

// Clears a bridge's deck cells (the river runs free again there). Anyone
// standing on them steps back to the nearest bank.
function clearDeck(state, b, { keepWalkers = false } = {}) {
  const r = state.roads;
  const cells = b.a ? deckCells(b.a, b.b, b.width) : [];
  const cleared = new Set();
  for (const i of cells) {
    if (!terrainGrid().water[i]) {
      // A land end stops being deck but stays a road.
      r.planned[i] &= ~FLAG.BRIDGE;
      markDirty(r, i);
      continue;
    }
    r.planned[i] &= ~(FLAG.BRIDGE | FLAG.PLANNED);
    setTier(state, i, 0);
    markDirty(r, i);
    cleared.add(i);
  }
  if (!keepWalkers) stepOffCells(state, cleared);
}

// A bridge gives way: the deck closes at once (walkers on it step back to
// land, routes over it are dropped), the fords beside it open again, and the
// record stays as a ruin (collapsed, built 0, not drawn) until a repair or a
// rebuild from bridgeUpgradeCandidates re-lays it.
export function collapseBridge(state, b) {
  if (typeof b !== 'object') b = byId(state, 'buildings', b);
  if (!b || b.type !== 'bridge' || b.collapsed || (b.built ?? 1) < 1) return { ok: false, reason: 'standing' };
  clearDeck(state, b);
  b.collapsed = true;
  b.condition = 0;
  b.built = 0;
  b.collapsedYear = state.time?.year ?? 0;
  bumpNav(state);
  touchBuilding(state, b);
  return { ok: true, bridgeId: b.id };
}

// The collapse event's rebuild, already paid for: 'stone' (else iron, else a
// wider timber deck) builds a new deck that replaces the ruin; 'timber' re-lays
// the old one. Either way the crossing stays closed until the work is done.
export function rebuildBridge(state, b, how = 'timber', { payer = 'treasury', paid = true } = {}) {
  if (typeof b !== 'object') b = byId(state, 'buildings', b);
  if (!b?.collapsed) return { ok: false, reason: 'standing' };
  const work = bridgeUpgradeCandidates(state, { fallen: true }).find(w => w.bridgeId === b.id);
  if (!work) return { ok: false, reason: 'busy' };
  const keys = work.options.map(o => o.key);
  const key = how === 'stone' ? ['stone', 'iron', 'widen', 'repair'].find(k => keys.includes(k)) : 'repair';
  return { ...executeWork(state, work, key, { payer, paid }), option: key };
}

// A repaired ruin opens again.
function reopenBridge(state, b) {
  delete b.collapsed;
  delete b.collapsedYear;
  b.built = 1;
  if (b.a) for (const i of deckCells(b.a, b.b, b.width)) {
    setPlannedTier(state, i, DECK_TIER[b.variant] ?? DECK_TIER.timber, FLAG.BRIDGE, { uncapped: true });
    markDirty(state.roads, i);
  }
  bumpNav(state);
}

// When a deck is cleared: walkers on it, or in the water beside it, step to
// the nearest open land; walkers whose route still runs over it choose again.
export function stepOffCells(state, cells) {
  if (!cells.size) return 0;
  const { water } = terrainGrid();
  const near = new Set();
  for (const i of cells) {
    const [cx, cz] = cellXZ(i);
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) {
        const j = cellIndex(cx + dx, cz + dz);
        if (j >= 0 && water[j] === 1 && !(state.roads.planned[j] & FLAG.BRIDGE)) near.add(j);
      }
  }
  let moved = 0;
  for (const p of state.people ?? []) {
    const i = cellOf(p.x, p.z);
    if (cells.has(i) || near.has(i)) {
      const open = nearestOpen(state, i, 10);
      if (open < 0) continue;
      const c = cellCenter(open);
      p.x = c.x;
      p.z = c.z;
      p.task = null;
      moved++;
    } else if (p.task?.route && routeCrosses(p.task.route, p.task.seg ?? 0, cells)) {
      p.task = null;
    }
  }
  return moved;
}

function routeCrosses(route, from, cells) {
  for (let k = Math.max(0, from - 2); k + 3 < route.length; k += 2) {
    const ax = route[k], az = route[k + 1], bx = route[k + 2], bz = route[k + 3];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    for (let t = 0; t <= steps; t++) if (cells.has(cellOf(ax + (bx - ax) * t / steps, az + (bz - az) * t / steps))) return true;
  }
  return false;
}

// Old saves: bridges laid along a row of cells get the perpendicular
// geometry (a, b, width, deckY) and their deck cells re-laid along a -> b.
export function rebuildOldBridges(state) {
  const r = state.roads;
  let n = 0;
  for (const b of state.buildings ?? []) {
    if (b.type !== 'bridge') continue;
    if (b.a) {
      // Older records: deck heights by style (footbridges low, cart bridges high).
      const deckY = Math.round(deckYFor(b.a, b.b, b.z, BRIDGE_WIDTH[b.variant] ? b.variant : 'timber') * 100) / 100;
      if (deckY !== b.deckY) { b.deckY = deckY; touchBuilding(state, b); }
      // Saves from before every deck cell carried the bridge flag.
      if ((b.built ?? 1) >= 1) for (const i of deckCells(b.a, b.b, b.width)) r.planned[i] |= FLAG.BRIDGE;
      continue;
    }
    const { water } = terrainGrid();
    const [cx0, cz0] = cellXZ(cellOf(b.x - (b.w ?? 14) / 2 - 2, b.z - (b.d ?? 4) / 2 - 2));
    const [cx1, cz1] = cellXZ(cellOf(b.x + (b.w ?? 14) / 2 + 2, b.z + (b.d ?? 4) / 2 + 2));
    const cleared = new Set();
    for (let z = cz0; z <= cz1; z++)
      for (let x = cx0; x <= cx1; x++) {
        const i = cellIndex(x, z);
        // Deck cells over land (the ramps) carry the flag too; they keep
        // their road, only the water cells go back to river.
        if (i < 0 || !(r.planned[i] & FLAG.BRIDGE)) continue;
        r.planned[i] &= ~FLAG.BRIDGE;
        if (!water[i]) continue;
        setTier(state, i, 0);
        cleared.add(i);
      }
    const style = BRIDGE_WIDTH[b.variant] ? b.variant : 'timber';
    const { cells, ...geo } = bridgeGeometry(crossingAt(b.z), style);
    Object.assign(b, geo);
    if ((b.built ?? 1) >= 1) for (const i of cells) setPlannedTier(state, i, DECK_TIER[style], FLAG.BRIDGE, { uncapped: true });
    const p = (state.projects ?? []).find(q => q.buildingId === b.id);
    if (p) p.cells = cells;
    const deck = new Set(cells);
    stepOffCells(state, new Set([...cleared].filter(i => !deck.has(i) || (b.built ?? 1) < 1)));
    touchBuilding(state, b);
    n++;
  }
  if (n) bumpNav(state);
  return n;
}

// Lays cells as progress advances, so paving visibly creeps along the road.
function layCells(state, p, upTo) {
  const n = Math.min(p.cells.length, upTo);
  for (let k = p.data.laid; k < n; k++) setPlannedTier(state, p.cells[k], p.data.tier);
  if (n > p.data.laid) {
    p.data.laid = n;
    bumpNav(state);
  }
}

function nextCellSite(state, p) {
  const { water } = terrainGrid();
  const k = Math.min(p.cells.length - 1, p.data.laid ?? 0);
  const i = water[p.cells[k]] ? p.cells[0] : p.cells[k];
  return cellCenter(i);
}

const WORK_LINES = {
  pave: (w, tier) => tier === 3 ? `The track in ${w} is a proper road now. Carts roll easily.` : `The lane in ${w} is paved now. It stays clean in the rain.`,
  widen: w => `The new avenue in ${w} is open. It is wide and handsome.`,
  ring: () => 'The ring road is finished. Carts go round the town now, not through it.',
  square: w => `The square in ${w} is finished. Market days will be grand.`,
  grid: w => `The new streets at ${w} are laid out. Homes can follow.`,
  turnpike: w => `The turnpike ${w} is open. Carts run between the towns in half the time.`,
};

for (const kind of ['pave', 'widen', 'ring', 'grid', 'square', 'turnpike']) {
  registerProjectKind(kind, {
    site: nextCellSite,
    progress(state, p) { layCells(state, p, Math.floor(p.progress * p.cells.length)); },
    complete(state, p) {
      layCells(state, p, p.cells.length);
      done(state)[p.data.workKey] = state.time?.year ?? 0;
      if (kind === 'square') addSquareMonument(state, p);
      setTag(state, `works:${kind}`);
      emitChronicle(state, { kind: 'line', text: WORK_LINES[kind](p.data.where, p.data.tier), refs: { projectKind: kind, ...centreRef(state, p.x, p.z) } });
    },
  });
}

function addSquareMonument(state, p) {
  const c = centreOf(p.cells);
  const variant = state.archetype === 'cathedral' ? 'cross' : 'fountain';
  addBuildingRecord(state, {
    type: 'monument', variant, x: c.x, z: c.z, w: 2.4, d: 2.4, rot: 0, built: 1,
    styleEra: state.era ?? 0, material: 'stone', occupied: true, flags: { square: 1 },
  });
}

registerProjectKind('bridge', {
  site: nextCellSite,
  progress(state, p) {
    const b = byId(state, 'buildings', p.buildingId);
    if (!b) return;
    const built = Math.floor(p.progress * 20) / 20;
    if (built !== b.built && built < 1) { b.built = built; touchBuilding(state, b); }
  },
  complete(state, p) {
    // An upgrade: the old deck stays open until now, then the new one opens.
    if (p.data.replaces != null) {
      const old = byId(state, 'buildings', p.data.replaces);
      if (old) {
        // The new deck takes over the old one's traffic: it is built for it.
        const b = byId(state, 'buildings', p.buildingId);
        if (b) b.traffic = old.traffic ?? 0;
        clearDeck(state, old, { keepWalkers: true });
        removeBuildingRecord(state, old.id);
      }
    }
    for (const i of p.cells) setPlannedTier(state, i, p.data.tier, FLAG.BRIDGE, { uncapped: true });
    bumpNav(state);
    const b = byId(state, 'buildings', p.buildingId);
    if (b && p.data.style !== 'footbridge') {
      retireFootbridgesNear(state, b.z, b.x, b.id);
      clearRuinsNear(state, b);
    }
    if (b) {
      b.built = 1;
      delete b.flags.scaffold;
      touchBuilding(state, b);
    }
    done(state)[p.data.workKey] = state.time?.year ?? 0;
    const n = (state.buildings ?? []).filter(x => x.type === 'bridge' && x.built >= 1).length;
    setTag(state, `bridge:${n}`);
    emitChronicle(state, p.data.style === 'footbridge'
      ? { kind: 'line', text: `Folk at the ${p.data.where} ford laid planks across the water.`, refs: { buildingId: p.buildingId, ...centreRef(state, p.x, p.z) } }
      : { kind: 'moment', text: `The ${p.data.style} bridge by ${p.data.where} is open. People cross dry-shod now.`, refs: { buildingId: p.buildingId, ...centreRef(state, p.x, p.z) } });
    for (const i of p.cells) markDirty(state.roads, i);
  },
});

// Bridges for the renderer: [{id, z, x0, x1, style, built}].
// Bridges for the renderer: [{id, a: {x, z}, b: {x, z}, width, deckY, style,
// built}] (plus the older z / x0 / x1 for readers that still use them).
export function bridgeViews(state) {
  return (state.buildings ?? []).filter(b => b.type === 'bridge' && !b.collapsed).map(b => {
    const style = BRIDGE_WIDTH[b.variant] ? b.variant : 'timber';
    const geo = b.a ? b : { ...bridgeGeometry(crossingAt(b.z), style) };
    return {
      id: b.id, a: geo.a, b: geo.b, width: geo.width, deckY: geo.deckY, style, built: b.built ?? 1,
      z: geo.z, x0: Math.min(geo.a.x, geo.b.x), x1: Math.max(geo.a.x, geo.b.x),
    };
  });
}

// ---------------------------------------------------------------- embankment

export const EMBANK_COST = 70;     // per grid row (2 units of bank), era-scaled
const EMBANK_REACH = 14;           // buildings this close to the water press for it
const EMBANK_MIN_ROWS = 8;
const EMBANK_MAX_ROWS = 40;

// A stone embankment along the busiest unembanked stretch of bank. Offered
// from the Town era, or earlier after a flood. On an embanked stretch homes
// may come within one unit of the water and waterfront buildings stand on
// stone quays.
export function embankmentCandidates(state, { limit = 1 } = {}) {
  const flooded = state.tags?.flood != null && (state.time?.year ?? 0) - state.tags.flood <= 10;
  if ((state.era ?? 0) < 2 && !flooded) return [];
  const e = state.roads.embanked;
  const out = [];
  for (const side of [0, 1]) {
    const press = new Uint16Array(GRID_H);
    for (const b of state.buildings ?? []) {
      if (b.type === 'bridge' || bankSide(b.x, b.z) !== side) continue;
      if ((b.bankDistance ?? bankDistance(b.x, b.z)) >= EMBANK_REACH) continue;
      const r0 = Math.max(0, Math.floor((b.z - b.d / 2 - 4 - ORIGIN_X) / CELL));
      const r1 = Math.min(GRID_H - 1, Math.floor((b.z + b.d / 2 + 4 - ORIGIN_X) / CELL));
      for (let r = r0; r <= r1; r++) press[r]++;
    }
    for (const run of pressedRuns(press, e, side)) out.push(embankCard(state, side, run));
  }
  return out.sort((a, b) => b.pressure - a.pressure).slice(0, limit);
}

// Contiguous unembanked rows with buildings near the bank (gaps <= 3 rows).
function pressedRuns(press, embanked, side) {
  const bit = side ? 2 : 1;
  const runs = [];
  let start = -1, last = -1, total = 0;
  const close = () => {
    if (start >= 0 && last - start + 1 >= EMBANK_MIN_ROWS) runs.push({ r0: start, r1: Math.min(last, start + EMBANK_MAX_ROWS - 1), pressure: total });
    start = -1; total = 0;
  };
  for (let r = 0; r < GRID_H; r++) {
    const open = press[r] > 0 && !(embanked[r] & bit);
    if (open) {
      if (start < 0 || r - last > 4) { close(); start = r; }
      last = r;
      total += press[r];
    }
  }
  close();
  return runs;
}

// The first land cell at the water's edge on one bank, for a grid row.
function bankCell(side, row) {
  const z = ORIGIN_X + (row + 0.5) * CELL;
  const { water } = terrainGrid();
  const dir = side ? 1 : -1;
  let cx = Math.floor((riverX(z) - ORIGIN_X) / CELL);
  for (let k = 0; k < 12; k++, cx += dir) {
    const i = cellIndex(cx, row);
    if (i < 0) return -1;
    if (!water[i]) return i;
  }
  return -1;
}

function embankCard(state, side, run) {
  const rows = [];
  for (let r = run.r0; r <= run.r1; r++) rows.push(r);
  const cells = rows.map(r => bankCell(side, r)).filter(i => i >= 0);
  const c = centreOf(cells);
  const where = placeName(state, c.x, c.z);
  const cost = Math.round(rows.length * EMBANK_COST * scale(state));
  return {
    key: `embankment:${side}:${Math.floor(run.r0 / 16)}`, kind: 'embankment', side, rows, cells,
    x: c.x, z: c.z, where, place: `along ${where}`, cost, pressure: run.pressure, lengthCells: rows.length,
    title: `Build an embankment along ${where}`,
    why: `Homes in ${where} crowd the river bank. The water eats at the mud each spring. A stone embankment would hold the bank and give us a fine waterfront.`,
    options: [{ key: 'stone', cost }, { key: 'wait', cost: 0 }],
  };
}

function startEmbankment(state, work, cost, payer, after, paid) {
  const c = centreOf(work.cells);
  return createProject(state, {
    kind: 'embankment', cells: [...work.cells], x: c.x, z: c.z, cost, payer, after, paid,
    work: work.rows.length * 3,
    data: { workKey: work.key, side: work.side, rows: [...work.rows], laid: 0, where: work.where },
  });
}

// Marks rows embanked as the work advances.
function layRows(state, p, upTo) {
  const r = state.roads;
  const bit = p.data.side ? 2 : 1;
  const n = Math.min(p.data.rows.length, upTo);
  for (let k = p.data.laid; k < n; k++) {
    r.embanked[p.data.rows[k]] |= bit;
    // The top of the wall is a towpath: walkers keep to the river.
    if (p.cells[k] >= 0) { setTowpath(state, p.cells[k]); markDirty(r, p.cells[k]); }
  }
  if (n > p.data.laid) {
    p.data.laid = n;
    r.embankRev++;
    r.version++;
  }
}

registerProjectKind('embankment', {
  site(state, p) { return cellCenter(p.cells[Math.min(p.cells.length - 1, p.data.laid)]); },
  progress(state, p) { layRows(state, p, Math.floor(p.progress * p.data.rows.length)); },
  complete(state, p) {
    layRows(state, p, p.data.rows.length);
    done(state)[p.data.workKey] = state.time?.year ?? 0;
    settleFoundations(state);
    setTag(state, 'embankment');
    emitChronicle(state, { kind: 'line', text: `The new embankment along ${p.data.where} is finished. The river stays in its bed now.`, refs: { projectKind: 'embankment', ...centreRef(state, p.x, p.z) } });
  },
});

// Embanked runs for the renderer: [{side: 'west' | 'east', z0, z1}].
export function embankmentViews(state) {
  const e = state.roads?.embanked;
  if (!e) return [];
  const crossings = embankmentCrossings(state);
  const out = [];
  for (const [bit, side] of [[1, 'west'], [2, 'east']]) {
    let start = -1;
    for (let r = 0; r <= GRID_H; r++) {
      const on = r < GRID_H && (e[r] & bit);
      if (on && start < 0) start = r;
      if (!on && start >= 0) {
        const z0 = ORIGIN_X + start * CELL, z1 = ORIGIN_X + r * CELL;
        out.push({ side, z0, z1, crossings: crossings.filter(c => c.side === side && c.z >= z0 && c.z <= z1) });
        start = -1;
      }
    }
  }
  return out;
}

// Where paths meet the waterfront, so the renderer can place steps, ramps
// and slipways: [{x, z, side, kind: 'steps'|'ramp'|'slipway', dir: [dx, dz]}].
// Fords and bridge abutments get ramps on both banks whether or not the bank
// is walled; worn paths, towpath ends and quays meeting an embanked stretch
// get steps or slipways.
export function embankmentCrossings(state) {
  const r = state.roads;
  const { water } = terrainGrid();
  const out = [];
  const seen = new Set();
  const add = (i, kind, sideName) => {
    if (i < 0 || seen.has(i)) return;
    seen.add(i);
    const c = cellCenter(i);
    out.push({ x: c.x, z: c.z, side: sideName, kind, dir: [sideName === 'west' ? 1 : -1, 0] });
  };
  for (let row = 0; row < GRID_H; row++) {
    const z = ORIGIN_X + (row + 0.5) * CELL;
    const rx = riverX(z);
    for (const [side, sideName] of [[0, 'west'], [1, 'east']]) {
      const edge = bankCell(side, row);
      if (edge < 0 || water[edge]) continue;
      const out1 = cellIndex((edge % GRID_W) + (side ? 1 : -1), row);
      const toWater = cellIndex((edge % GRID_W) + (side ? -1 : 1), row);
      const ford = toWater >= 0 && water[toWater] === 2;
      const bridge = toWater >= 0 && (r.planned[toWater] & FLAG.BRIDGE);
      if (ford || bridge) { add(edge, 'ramp', sideName); continue; }
      if (!(state.roads.embanked?.[row] & (side ? 2 : 1))) continue;
      const quay = (state.buildings ?? []).some(b => b.type === 'quay' && Math.abs(b.z - z) < b.d / 2 + 1 && Math.abs(b.x - rx) < WATER_HALF + 10 && (b.x > rx) === !!side);
      if (quay) add(edge, 'slipway', sideName);
      else if (out1 >= 0 && r.tier[out1] >= 1 && !(r.planned[out1] & FLAG.TOWPATH)) add(edge, 'steps', sideName);
    }
  }
  return out;
}

// ---------------------------------------------------------------- corridors between centres

const CORRIDOR_WEAR = 800;        // average wear along the way that calls for a proper road
const CORRIDOR_LOW_SHARE = 0.3;   // ... when this share of it is still below a graded road

// When two centres trade a lot, the road between them wears hard. Planning
// can offer a turnpike: grade (or pave, from the Town era) the whole way.
export function corridorCandidates(state, { limit = 2 } = {}) {
  const live = liveCentres(state).filter(c => c.pop >= 100);
  if (live.length < 2) return [];
  const pairs = [];
  for (let a = 0; a < live.length; a++)
    for (let b = a + 1; b < live.length; b++) pairs.push([live[a], live[b]]);
  pairs.sort((p, q) => (q[0].pop + q[1].pop) - (p[0].pop + p[1].pop) || p[0].id - q[0].id);
  const target = Math.max(3, Math.min(4, PLANNED_MAX[state.era ?? 0]));
  const { tier, wear } = state.roads;
  const { water } = terrainGrid();
  const out = [];
  for (const [a, b] of pairs.slice(0, 3)) {
    const key = `turnpike:${a.id}-${b.id}`;
    if (done(state)[key] != null) continue;
    const route = findRoute(structuralGrid(state), cellOf(a.x, a.z), cellOf(b.x, b.z), { maxNodes: 40000 });
    if (!route.cells || route.cells.length < 20) continue;
    const land = [...route.cells].filter(i => !water[i]);
    const avg = land.reduce((n, i) => n + wear[i], 0) / Math.max(1, land.length);
    const cells = land.filter(i => tier[i] < target);
    if (avg < CORRIDOR_WEAR || cells.length / land.length < CORRIDOR_LOW_SHARE) continue;
    const cost = Math.round(cells.length * UNIT_COST.turnpike * scale(state));
    const where = `from ${a.name} to ${b.name}`;
    out.push({
      key, kind: 'turnpike', tier: target, cells, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, where, place: where, cost,
      centres: [a.id, b.id], wear: Math.round(avg), lengthCells: cells.length,
      title: `A turnpike ${where}`,
      why: `Carts between ${a.name} and ${b.name} churn the lane to mud. A proper road would join the two towns.`,
      options: [{ key: 'build', cost }, { key: 'wait', cost: 0 }],
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- bridge upgrades

// A busy, worn or old cart bridge asks to be repaired, widened or rebuilt
// in a stronger style: timber -> wider timber or stone (era >= 2), stone ->
// wider stone or iron (era >= 4). Costs are era-scaled; the old deck stays
// open until the new one is finished.
export const UPGRADE_LOAD = 0.8;
export const WORN = 0.35;
const UPGRADE_COST = { 'timber-wide': 1.2 * BRIDGE_COST.timber, stone: BRIDGE_COST.stone, 'stone-wide': 1.3 * BRIDGE_COST.stone, iron: 2 * BRIDGE_COST.stone };
const REPAIR_SHARE = 0.2;

// With {fallen: true}, fallen bridges too (sim-governance's collapse event
// rebuilds through rebuildBridge); otherwise the event is the only question
// about a fallen bridge.
export function bridgeUpgradeCandidates(state, { fallen: withFallen = false } = {}) {
  const era = state.era ?? 0;
  const busy = new Set((state.projects ?? []).filter(p => p.data?.replaces != null || p.kind === 'bridge-repair').map(p => p.data?.replaces ?? p.buildingId));
  const out = [];
  for (const b of state.buildings ?? []) {
    if (b.type !== 'bridge' || b.variant === 'footbridge' || busy.has(b.id)) continue;
    if (b.collapsed ? !withFallen : (b.built ?? 1) < 1) continue;
    const load = bridgeLoad(state, b);
    const fallen = !!b.collapsed;
    const condition = b.condition ?? 1;
    const old = b.variant === 'timber' && (b.age ?? 0) >= 30 && era >= 2;
    if (load < UPGRADE_LOAD && condition > WORN && !old) continue;
    const s = scale(state);
    const where = placeName(state, b.x, b.z);
    const options = [];
    // 'widen' keeps the style and widens the deck; 'stone' and 'iron' rebuild.
    if (b.variant === 'timber') {
      options.push({ key: 'widen', cost: Math.round(UPGRADE_COST['timber-wide'] * s), style: 'timber', width: 6 });
      if (era >= 2) options.push({ key: 'stone', cost: Math.round(UPGRADE_COST.stone * s), style: 'stone' });
    } else if (b.variant === 'stone') {
      options.push({ key: 'widen', cost: Math.round(UPGRADE_COST['stone-wide'] * s), style: 'stone', width: 7 });
      if (era >= 4) options.push({ key: 'iron', cost: Math.round(UPGRADE_COST.iron * s), style: 'iron' });
    }
    // A fallen bridge's 'repair' rebuilds the deck in its old style, at full cost.
    const repairCost = Math.round((fallen ? 1 : REPAIR_SHARE) * (BRIDGE_COST[b.variant] ?? BRIDGE_COST.timber) * s);
    options.push({ key: 'repair', cost: repairCost }, { key: 'wait', cost: 0 });
    const reason = fallen ? 'fallen' : load >= UPGRADE_LOAD ? 'busy' : condition <= WORN ? 'worn' : 'old';
    out.push({
      key: `bridge-up:${b.id}`, id: `bridge-up:${b.id}`, kind: 'bridge-upgrade', bridgeId: b.id, style: b.variant, x: b.x, z: b.z, where, place: `by ${where}`,
      cells: b.a ? deckCells(b.a, b.b, b.width) : [], traffic: Math.round(b.traffic ?? 0), capacity: b.capacity,
      load: Math.round(load * 100) / 100, condition: Math.round(condition * 100) / 100, age: b.age ?? 0, reason,
      cost: options[0].cost,
      title: reason === 'fallen' ? `Rebuild the bridge by ${where}` : reason === 'worn' ? `Mend the bridge by ${where}` : `A bigger bridge by ${where}`,
      why: reason === 'fallen'
        ? `The bridge by ${where} has fallen into the river. People wade at the ford or take the long way round.`
        : reason === 'busy'
        ? `The bridge by ${where} is jammed every day. Carts wait their turn to cross. A wider or stronger bridge would carry them all.`
        : reason === 'worn'
          ? `The bridge by ${where} is worn. Planks are loose and the piers lean. It should be mended before it fails.`
          : `The old timber bridge by ${where} has stood a long time. A stone bridge would last for generations.`,
      options,
    });
  }
  return out;
}

function executeBridgeUpgrade(state, work, option, payer, paid) {
  const b = byId(state, 'buildings', work.bridgeId);
  if (!b) return { ok: false, reason: 'gone' };
  if (option.key === 'repair') {
    const project = createProject(state, {
      kind: 'bridge-repair', buildingId: b.id, x: b.x, z: b.z, w: b.w, d: b.d, cost: option.cost, payer, paid,
      work: b.collapsed ? (b.variant === 'stone' ? 160 : 70) : 20, data: { workKey: work.key, where: work.where },
    });
    return { ok: true, projects: [project] };
  }
  const crossing = { a: b.a, b: b.b, centre: { x: (b.a.x + b.b.x) / 2, z: b.z }, length: Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z) };
  const next = { key: work.key, crossing, z: b.z, where: work.where, band: zBand(b.z), options: [{ key: option.style, cost: option.cost }] };
  const project = startBridge(state, next, option.style, payer, [], paid, { width: option.width ?? null, replaces: b.id });
  return { ok: true, projects: [project] };
}

registerProjectKind('bridge-repair', {
  complete(state, p) {
    const b = byId(state, 'buildings', p.buildingId);
    if (!b) return;
    const fallen = !!b.collapsed;
    if (fallen) reopenBridge(state, b);
    b.condition = 1;
    touchBuilding(state, b);
    emitChronicle(state, fallen
      ? { kind: 'moment', text: `The bridge by ${p.data.where} stands again. People cross dry-shod once more.`, refs: { buildingId: b.id, ...centreRef(state, b.x, b.z) } }
      : { kind: 'line', text: `The bridge by ${p.data.where} is mended. Carts roll over it safely again.`, refs: { buildingId: b.id, ...centreRef(state, b.x, b.z) } });
  },
});

// Yearly: bridges age; condition wears with age and with load over capacity,
// up to twice as fast (timber over decades, stone over a century or more,
// iron hardly at all).
const BRIDGE_WEAR = { timber: 0.025, stone: 0.006, iron: 0.003 };

export function yearlyBridges(state) {
  for (const b of state.buildings ?? []) {
    if (b.type !== 'bridge' || b.variant === 'footbridge' || (b.built ?? 1) < 1) continue;
    b.age = (b.age ?? 0) + 1;
    settleDesignTraffic(b);
    const load = bridgeLoad(state, b);
    const wear = (BRIDGE_WEAR[b.variant] ?? 0.02) * (1 + Math.min(1, Math.max(0, load - 1)));
    b.condition = Math.max(0, (b.condition ?? 1) - wear);
    // For readers that want plain numbers (the collapse event, the inspect panel).
    const cap = bridgeCapacity(b);
    b.capacity = Number.isFinite(cap) ? Math.round(cap) : null;
    b.load = Math.round(load * 100) / 100;
  }
}

// ---------------------------------------------------------------- footbridges

// Households who cross at a ford often enough, two years running, lay a
// plank footbridge there themselves: no card, paid by the household that
// uses it most (with the most savings). Walkable at track cost; carts still
// ford. Footbridges age, and a flood can carry an old one away; folk lay
// new planks when the demand comes back.
export const FOOTBRIDGE_YEARS = 2;
export const FOOTBRIDGE_COST = 90;

export function footbridgeNeed(state) {
  const pop = state.indicators?.pop ?? 0;
  return Math.max(8, 0.06 * pop);
}

export function yearlyFootbridges(state, rand = Math.random) {
  ageFootbridges(state, rand);
  const watch = (state.roads.footbridgeWatch ??= {});
  const need = footbridgeNeed(state);
  const bridges = bridgeZs(state);
  const built = [];
  for (const f of FORDS) {
    const band = String(zBand(f.z));
    const demand = state.roads.xings?.[band] ?? 0;
    if (demand < need || bridges.some(z => Math.abs(z - f.z) < BRIDGE_SPACING * CELL)) { delete watch[band]; continue; }
    watch[band] = (watch[band] ?? 0) + 1;
    if (watch[band] < FOOTBRIDGE_YEARS) continue;
    delete watch[band];
    const payer = footbridgePayer(state, f.z);
    if (!payer) continue;
    const crossing = crossingAt(f.z);
    const where = placeName(state, crossing.centre.x, f.z);
    const cost = Math.round(FOOTBRIDGE_COST * scale(state));
    const work = { key: `footbridge:${band}`, kind: 'bridge', crossing, z: f.z, where, band: Number(band), options: [{ key: 'footbridge', cost }] };
    built.push(startBridge(state, work, 'footbridge', `household:${payer.id}`, [], false));
  }
  return built;
}

// The household with ties across this ford and the most savings.
function footbridgePayer(state, z) {
  let best = null;
  for (const t of crossRiverTies(state)) {
    if (Math.abs(t.z - z) > 60) continue;
    if (!best || (t.h.savings ?? 0) > (best.savings ?? 0)) best = t.h;
  }
  return best;
}

function ageFootbridges(state, rand) {
  const flooded = state.tags?.flood === (state.time?.year ?? 0) || state.tags?.flood === (state.time?.year ?? 0) - 1;
  for (const fb of [...(state.buildings ?? [])]) {
    if (fb.type !== 'bridge' || fb.variant !== 'footbridge' || (fb.built ?? 1) < 1) continue;
    fb.condition = Math.max(0, (fb.condition ?? 1) - 0.05);
    if (flooded && (fb.condition < 0.6 || rand() < 0.3)) {
      clearDeck(state, fb);
      removeBuildingRecord(state, fb.id);
      bumpNav(state);
      emitChronicle(state, { kind: 'line', text: 'The flood carried the planks away at the ford. Folk wade again for now.', refs: { buildingId: fb.id, ...centreRef(state, fb.x, fb.z) } });
    }
  }
}

// ---------------------------------------------------------------- paving fund

// Yearly, with the paving-fund rule: pave the busiest candidate stretch the
// fund can pay for (or the busiest half of it). No card; the rule already
// says yes. The treasury pays through the economy (paid: false).
export function spendPavingFund(state) {
  const budget = policyModifiers(state).sum('pavingBudget') * scale(state);
  if (budget <= 0) return null;
  for (const work of paveCandidates(state)) {
    const option = work.options.find(o => o.key !== 'wait' && o.cost <= budget);
    if (!option) continue;
    const r = executeWork(state, work, option.key, { payer: 'treasury' });
    return r.ok ? r : null;
  }
  return null;
}
