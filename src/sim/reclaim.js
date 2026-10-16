// Empty buildings in the way of foot traffic.
//
// A derelict building (a closed mill, a home left to rot) blocks the ground
// like any other: walkers go round it, and the wear splits into a loop on
// both sides. While it stands that is right: nobody walks through walls.
// Once it has stood empty for RECLAIM_AFTER years with trodden paths pressing
// on opposite sides, the town pulls it down and the path takes the straight
// line through the lot (queueReclaimedPath wears it to a track when the
// building is gone, which also keeps new lots off that line; the rest of the
// lot is free to build on).
//
// Heritage buildings stay. Fields (farms, parks), bridges and monuments are
// never reclaimed. At most RECLAIM_PER_YEAR go each year, busiest first.
import { GRID_W, cellIndex, buildingCells, footprints, queueReclaimedPath } from './roads.js';
import { demolish, addBuildingStory } from './buildings.js';
import { emitChronicle } from './state.js';

export const RECLAIM_AFTER = 4;        // years derelict and empty
export const RECLAIM_PER_YEAR = 3;
// Trodden cells needed along each of two opposite sides of the footprint.
const SIDE_MIN = 1;
const NEVER = new Set(['farm', 'park', 'bridge', 'monument']);

// The four sides of the walled cells, one cell out: [{cells, wear, best}],
// in order west, east, north, south.
function sides(state, b) {
  const fp = footprints(state);
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  // Grow to the blocked margin (walls plus the walker's margin).
  let x0 = cx0, x1 = cx1, z0 = cz0, z1 = cz1;
  const mine = j => j >= 0 && fp.blocked[j] === b.id + 1;
  while (mine(cellIndex(x0 - 1, (z0 + z1) >> 1))) x0--;
  while (mine(cellIndex(x1 + 1, (z0 + z1) >> 1))) x1++;
  while (mine(cellIndex((x0 + x1) >> 1, z0 - 1))) z0--;
  while (mine(cellIndex((x0 + x1) >> 1, z1 + 1))) z1++;
  const r = state.roads;
  const side = (pts) => {
    let trodden = 0, wear = 0, best = -1;
    for (const [x, z] of pts) {
      const j = cellIndex(x, z);
      if (j < 0 || fp.blocked[j]) continue;
      if (r.tier[j] >= 1) trodden++;
      wear += r.wear[j];
      if (best < 0 || r.wear[j] > r.wear[best]) best = j;
    }
    return { trodden, wear, best };
  };
  const col = (x) => Array.from({ length: z1 - z0 + 1 }, (_, k) => [x, z0 + k]);
  const row = (z) => Array.from({ length: x1 - x0 + 1 }, (_, k) => [x0 + k, z]);
  return { box: { x0, x1, z0, z1 }, w: side(col(x0 - 1)), e: side(col(x1 + 1)), n: side(row(z0 - 1)), s: side(row(z1 + 1)) };
}

// How hard foot traffic presses on the building from two opposite sides, and
// the straight line between the busiest cells on those sides. null when the
// building is not in anyone's way.
export function inTheWay(state, b) {
  const sd = sides(state, b);
  let best = null;
  for (const [a, c] of [[sd.w, sd.e], [sd.n, sd.s]]) {
    if (a.trodden < SIDE_MIN || c.trodden < SIDE_MIN || a.best < 0 || c.best < 0) continue;
    const pressure = Math.min(a.wear, c.wear);
    if (!best || pressure > best.pressure) best = { pressure, from: a.best, to: c.best };
  }
  if (!best) return null;
  return { pressure: best.pressure, cells: lineCells(best.from, best.to) };
}

// 8-connected cells on the straight line between two cells (inclusive).
function lineCells(a, b) {
  const ax = a % GRID_W, az = (a - ax) / GRID_W, bx = b % GRID_W, bz = (b - bx) / GRID_W;
  const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const j = cellIndex(Math.round(ax + (bx - ax) * k / Math.max(1, n)), Math.round(az + (bz - az) * k / Math.max(1, n)));
    if (j >= 0 && out[out.length - 1] !== j) out.push(j);
  }
  return out;
}

function reclaimable(state, b) {
  return b.flags?.derelict && !b.flags.heritage && !b.occupied && !NEVER.has(b.type) && (b.built ?? 1) >= 1 &&
    !(state.projects ?? []).some(p => p.buildingId === b.id) &&
    !(state.enterprises ?? []).some(e => e.buildingId === b.id);
}

// Yearly (world.js YEAR_STEPS): count derelict years, pull down the ones most
// in the way. Returns the ids reclaimed.
export function reclaimDerelicts(state) {
  const due = [];
  for (const b of state.buildings ?? []) {
    if (!reclaimable(state, b)) {
      if (b.derelictYears != null && !b.flags?.derelict) delete b.derelictYears;
      continue;
    }
    b.derelictYears = (b.derelictYears ?? 0) + 1;
    if (b.derelictYears < RECLAIM_AFTER) continue;
    const way = inTheWay(state, b);
    if (way) due.push({ b, ...way });
  }
  due.sort((p, q) => q.pressure - p.pressure || p.b.id - q.b.id);
  const done = [];
  for (const { b, cells } of due.slice(0, RECLAIM_PER_YEAR)) {
    const r = demolish(state, b, { payer: 'treasury', reason: 'reclaimed' });
    if (!r.ok) continue;
    addBuildingStory(state, b, 'derelict', { text: 'pulled down so the path can run straight' });
    queueReclaimedPath(state, b.id, cells);
    done.push(b.id);
  }
  if (done.length) {
    emitChronicle(state, {
      kind: 'line',
      text: done.length === 1
        ? 'An empty building came down. People had walked round it for years. Now the path runs straight.'
        : 'Some empty buildings came down. People had walked round them for years. Now the paths run straight.',
      refs: { buildingId: done[0] },
    });
  }
  return done;
}
