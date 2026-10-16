// Landscaping as a process, the way worn paths come from feet.
//
// Land carries one signed care level, -1..1. Care raises it a little each
// year; neglect lowers it. What grows there follows from the level alone, in
// stages, and neglect runs the stages backwards:
//
//   level < -0.3   overgrown: long grass, weeds, broken fences, hedges gone wild
//   -0.3 .. 0.15   rough grass (the natural state of untouched land)
//   0.15 .. 0.4    mown and tended
//   0.4 .. 0.7     planted: fences or hedges, beds and shrubs, kerbside planting
//   >= 0.7         formal (from the Borough era): clipped hedges, planters,
//                  formal beds, kept park lawns
//
// Two places hold the level:
//   - Lots: each building keeps b.tend (the positive part) and b.wild (the
//     negative part); at most one of them is above zero. Inputs: the family
//     living there and how long, its wealth and home tier, the era, the town's
//     archetype. An empty or derelict lot runs wild.
//   - Verges and public land: a coarse grid (state.landscape, 8-unit blocks)
//     for road verges, riverbanks, squares and parks. Inputs: the care of the
//     lots around (neighbours spill onto the verge), public places people
//     gather at, parks the town keeps (while it can pay), the Planning Office
//     and the Green reserves rule, the era. Against it: derelicts, crowding
//     and feet trampling the verges of dirt lanes.
//
// Yearly, deterministic, no random draws. Older saves get the grid on the
// first yearly pass, seeded from what already stands there. aesthetics.js
// reads both (gardens and green verges help; overgrowth hurts) and the
// renderer draws the stages.

import {cellIndex, cellCenter, wearNorm, CELL, GRID_W, GRID_H, ORIGIN_X} from './roads.js';
import {bankDistance} from '../terrain.js';
import {levelOf} from './policies.js';

export const BLOCK = 4;                       // cells per block side (8 units)
export const LW = Math.ceil(GRID_W / BLOCK);
export const LH = Math.ceil(GRID_H / BLOCK);
const NO_LOT_CARE = new Set(['farm', 'park', 'bridge', 'monument', 'quay', 'quarry']);
const GATHERING = new Set(['chapel', 'moot', 'school', 'market', 'library', 'inn', 'theatre', 'bathhouse', 'monument', 'infirmary']);

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const r2 = (x) => Math.round(x * 100) / 100;

export const STAGES = ['overgrown', 'rough', 'mown', 'planted', 'formal'];

/** The stage a level shows (formal needs the Borough era). */
export function stageOf(level, era = 0) {
  if (level < -0.3) return 'overgrown';
  if (level < 0.15) return 'rough';
  if (level < 0.4) return 'mown';
  if (level < 0.7 || era < 3) return 'planted';
  return 'formal';
}

/** A lot's signed level. */
export const lotLevel = (b) => (b?.tend ?? 0) - (b?.wild ?? 0);

/** How much of a full garden this building's people keep (0 = nobody does). */
export function careOf(state, b) {
  if (NO_LOT_CARE.has(b.type) || (b.built ?? 1) < 1 || !b.occupied || b.flags?.derelict) return 0;
  const era = state.era ?? 0;
  const garden = state.archetype === 'garden' ? 0.1 : 0;
  const home = b.type === 'home' ? 0.05 : -0.05;
  return clamp(0.12 + 0.55 * (b.wealth ?? 0.3) + 0.05 * ((b.tier ?? 1) - 1) + 0.04 * era + garden + home, 0, 1);
}

/** A first guess for lots with no record yet (older saves). */
export function estimateLotLevel(state, b) {
  const care = careOf(state, b);
  if (care > 0) return care * Math.min(1, (b.age ?? 0) / 20);
  return b.flags?.derelict ? -0.5 : 0;
}

// ---------------------------------------------------------------------------
// Lots

function tendLots(state) {
  // A year of public works tidies the town's untended corners a little.
  const tidy = state.tags?.['public-works'] != null && (state.time?.year ?? 0) - state.tags['public-works'] <= 1;
  for (const b of state.buildings) {
    if (NO_LOT_CARE.has(b.type) || (b.built ?? 1) < 1) continue;
    const care = careOf(state, b);
    let level = b.tend == null && b.wild == null ? estimateLotLevel(state, b) : lotLevel(b);
    if (care > 0) {
      // Weeds go first, then the garden grows in over ten to twenty years;
      // past what the family can keep, it slips back slowly.
      if (level < 0) level = Math.min(0, level + 0.3);
      else if (level < care) level = Math.min(care, level + 0.03 + 0.05 * (b.wealth ?? 0.3));
      else level = Math.max(care, level - 0.02);
    } else {
      // Nobody there: beds go to grass, then the yard runs wild.
      level -= level > 0 ? 0.15 : 0.15 + ((b.condition ?? 1) < 0.3 ? 0.08 : 0);
    }
    if (tidy && level < 0) level = Math.min(0, level + 0.1);
    level = clamp(level, -1, 1);
    b.tend = r2(Math.max(0, level));
    b.wild = r2(Math.max(0, -level));
  }
}

// ---------------------------------------------------------------------------
// Verges and public land

export function ensureLandscape(state) {
  const L = state.landscape;
  if (L?.level instanceof Int8Array && L.level.length === LW * LH) return L;
  state.landscape = {block: BLOCK, W: LW, H: LH, ox: ORIGIN_X, cell: CELL * BLOCK, level: new Int8Array(LW * LH), year: -1, seeded: false};
  return state.landscape;
}

/** Signed level (-1..1) of the block under a world point. */
export function landAt(state, x, z) {
  const L = state.landscape;
  if (!L?.level) return 0;
  const i = Math.floor((x - L.ox) / L.cell), j = Math.floor((z - L.ox) / L.cell);
  if (i < 0 || j < 0 || i >= L.W || j >= L.H) return 0;
  return L.level[j * L.W + i] / 100;
}

/** Mean signed level over the (2r+1)^2 blocks around a world point. */
export function landAround(state, x, z, r = 1) {
  const L = state.landscape;
  if (!L?.level) return 0;
  const ci = Math.floor((x - L.ox) / L.cell), cj = Math.floor((z - L.ox) / L.cell);
  let s = 0, n = 0;
  for (let j = cj - r; j <= cj + r; j++)
    for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || j < 0 || i >= L.W || j >= L.H) continue;
      s += L.level[j * L.W + i];
      n++;
    }
  return n ? s / n / 100 : 0;
}

// Per-block inputs gathered from the buildings and the road grid.
function gather(state) {
  const n = LW * LH;
  const lotSum = new Float32Array(n), lotN = new Uint16Array(n), derelict = new Uint8Array(n), built = new Uint16Array(n);
  const park = new Int8Array(n), publicPlace = new Uint8Array(n), road = new Uint8Array(n), trample = new Float32Array(n), roadN = new Uint16Array(n);
  const blockOf = (x, z) => {
    const i = Math.floor((x - ORIGIN_X) / (CELL * BLOCK)), j = Math.floor((z - ORIGIN_X) / (CELL * BLOCK));
    return i < 0 || j < 0 || i >= LW || j >= LH ? -1 : j * LW + i;
  };
  const funded = (state.treasury ?? 0) >= 0;
  for (const b of state.buildings) {
    if (b.type === 'bridge') continue;
    if (b.type === 'park') {
      // A park covers its blocks: kept while the town can pay, else it goes to seed.
      for (let z = b.z - b.d / 2; z <= b.z + b.d / 2; z += CELL * BLOCK / 2)
        for (let x = b.x - b.w / 2; x <= b.x + b.w / 2; x += CELL * BLOCK / 2) {
          const k = blockOf(x, z);
          if (k >= 0) park[k] = funded && (b.built ?? 1) >= 1 ? 1 : -1;
        }
      continue;
    }
    const k = blockOf(b.x, b.z);
    if (k < 0) continue;
    built[k]++;
    if (b.flags?.derelict) derelict[k]++;
    if (GATHERING.has(b.type) && b.occupied !== false) publicPlace[k] = 1;
    if (!NO_LOT_CARE.has(b.type) && (b.built ?? 1) >= 1) {
      lotSum[k] += lotLevel(b);
      lotN[k]++;
    }
  }
  const {tier, wear} = state.roads;
  for (let j = 0; j < GRID_H; j++)
    for (let i = 0; i < GRID_W; i++) {
      const c = j * GRID_W + i;
      const t = tier[c];
      if (!t) continue;
      const k = Math.floor(j / BLOCK) * LW + Math.floor(i / BLOCK);
      if (t > road[k]) road[k] = t;
      roadN[k]++;
      // Feet spill off dirt lanes onto the verge; made streets have kerbs.
      if (t <= 2) trample[k] += wearNorm(wear[c]);
    }
  for (let k = 0; k < n; k++) if (roadN[k]) trample[k] /= roadN[k];
  return {lotSum, lotN, derelict, built, park, publicPlace, road, trample};
}

/** Yearly: lots first, then verges and public land. */
export function yearlyLandscape(state) {
  tendLots(state);
  const L = ensureLandscape(state);
  const g = gather(state);
  const era = state.era ?? 0;
  const planning = (state.institutions ?? []).some((b) => b.kind === 'planning' && b.status === 'active');
  const reserve = levelOf(state, 'park-reserve');
  // Public upkeep: the Planning Office and the Green reserves rule keep made
  // streets and banks; later eras keep more.
  const publicCare = (planning ? 0.12 : 0) + 0.06 * reserve + 0.03 * Math.max(0, era - 1);
  const first = !L.seeded;
  for (let j = 0; j < LH; j++)
    for (let i = 0; i < LW; i++) {
      const k = j * LW + i;
      // Neighbourhood sums over 3x3 blocks.
      let lots = 0, lotsN = 0, der = 0, dense = 0, near = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= LW || jj >= LH) continue;
          const q = jj * LW + ii;
          lots += g.lotSum[q];
          lotsN += g.lotN[q];
          der += g.derelict[q];
          dense += g.built[q];
          near += g.built[q] + (g.park[q] ? 1 : 0);
        }
      const before = L.level[k] / 100;
      // Untouched country stays rough; only land people live by is shaped.
      if (!near && !g.road[k]) {
        if (before) L.level[k] = Math.round(before * 0.8 * 100);
        continue;
      }
      const {x, z} = cellCenter(cellIndex(i * BLOCK + (BLOCK >> 1), j * BLOCK + (BLOCK >> 1)));
      const bank = bankDistance(x, z);
      const riverbank = bank > 0 && bank < 10 && near > 0;
      const resident = lotsN ? lots / lotsN : 0;
      const crowd = clamp((dense - 14) / 10, 0, 1);
      let target = 0.8 * resident
        + (g.road[k] >= 3 ? publicCare : 0)
        + (g.road[k] >= 4 ? 0.1 : 0)
        + (g.publicPlace[k] ? 0.2 : 0)
        + (riverbank ? 0.1 + publicCare * 0.5 : 0)
        - 0.45 * Math.min(1, der / 2)
        - 0.25 * crowd
        - 0.35 * g.trample[k];
      if (g.park[k] > 0) target = Math.max(target, 0.55 + 0.1 * Math.min(3, era - 1) + 0.05 * reserve);
      else if (g.park[k] < 0) target = Math.min(target, -0.4);
      target = clamp(target, -1, 1);
      let level;
      if (first) level = target * 0.7;   // an older save: what already stands has had time to grow
      else level = target > before ? Math.min(target, before + 0.05) : Math.max(target, before - 0.08);
      L.level[k] = Math.round(clamp(level, -1, 1) * 100);
    }
  L.seeded = true;
  L.year = state.time?.year ?? 0;
  L.rev = (L.rev ?? 0) + 1;
  return L;
}

/** Counts of blocks per stage (for tools and tests). */
export function landscapeCounts(state) {
  const L = state.landscape;
  const out = Object.fromEntries(STAGES.map((s) => [s, 0]));
  if (!L?.level) return out;
  for (let k = 0; k < L.level.length; k++) if (L.level[k]) out[stageOf(L.level[k] / 100, state.era ?? 0)]++;
  return out;
}
