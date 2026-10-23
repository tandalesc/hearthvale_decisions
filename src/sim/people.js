// Visible walkers. Every resident is simulated one by one: needs, tasks, routes
// and movement (state.settings.individualCap, when a test or benchmark sets one,
// keeps the rest as household counts). syncIndividuals() promotes and demotes
// walkers as the population changes.
//
// Movement runs every tick with dt = 0.1 s. A walker moves along a flat route
// [x0, z0, x1, z1, ...] at a speed set by the road tier underneath. Whenever the
// velocity or the visible action changes, p.rev is bumped so the render view
// rewrites that walker's row; otherwise the renderer extrapolates from velocity.
//
// Routes come from services.routes (sim-world's planner, see planRoute below) or,
// without a planner, from a straight-line fallback that crosses the river at the
// nearest ford or bridge.

import {heightAt, riverX, waterAt, bankDistance, FORDS, hasRiver, dryAlong} from '../terrain.js';
import {rng, hash32, hashUnit} from './rng.js';
import {decide, findHook} from './hooks.js';
import {byId, cellIndex, lookFor, nextId, BRIDGE} from './state.js';
import {monthIndex} from './clock.js';
import {doorPoint, frontCell, cellCenter, footprints, footprintKey, nearestOpen, routeStillValid, routeClearFrom, wallMemo, wallsStillClear, structuralGrid, cellOf, recordCrossingBand, outlineClear, skirtOutlines, skirtMemo, skirtStillClear, walkerGrid, standPoint, FLAG, walkerSegmentBlocked, walkerLegOutlined, structuralWaterAt, growActiveBox, legCertified, changedTilesSince, footprintGen, tilesTouched, memoTouched, tileBox, ORIGIN_X, ORIGIN_Z, CELL, GRID_W, GRID_H} from './roads.js';
import {halfWidth, wearBucket} from '../render/paths.js';   // the drawn path widths (pure, no renderer state)
import {findRoute, cellsToWaypoints} from '../navigation.js';
import {projectSite} from './buildings.js';
import {alongBridge, deckSurfaceY, DECK_VERGE} from './bridges.js';
import {seatsOf} from './seats.js';
import {rebuildDensity, densityAt} from './density.js';
import {pointGrid, ringSearch} from './near.js';
import {gatheringActivity, layoutOf, occasionFor, occasionSpot, wanderRoute, kinReset, kinAdd, ACTIVITIES, deckSpot, RAIL_MIN_HALF, railStand} from './gatherings.js';
// A passer-by keeps this far (centre to centre) from a rail stander: half a body's
// width plus half its depth.
const RAIL_PASS = 0.37;
import {outingTarget, alternativeOuting} from './leisure.js';

// 8-12: leisure poses (render/people.js): a fishing rod cast then held, leaning on a rail,
// lying on the grass, kneeling (a picnic, berry picking), pointing (birds, the view).
export const ACTION = {none: 0, carry: 1, build: 2, sit: 3, cheer: 4, protest: 5, dance: 6, bench: 7, fish: 8, lean: 9, lie: 10, kneel: 11, point: 12};
export const TASK_KINDS = ['work', 'rest', 'shop', 'leisure', 'worship', 'gather', 'build', 'flee', 'travel'];

// Units per sim second on grass. The game runs at half pace (sim/clock.js PACE),
// so this reads on screen as an ordinary 1.4 units a second at 1x.
const WALK_SPEED = 2.8;
const TIER_SPEED = [1, 1.1, 1.25, 1.5, 1.75, 1.9];
const FORD_SPEED = 0.6;
const WEAR_PER_CELL = 3;
const NEED_DECAY = {energy: 0.45, fullness: 0.55, social: 0.3};   // per sim second
const DWELL = {work: [12, 24], rest: [10, 20], shop: [4, 8], leisure: [6, 14], worship: [6, 10], gather: [12, 24], build: [10, 16], flee: [6, 10], travel: [3, 6]};
const INDOOR = new Set(['work', 'rest', 'shop', 'worship']);
const OUTDOOR_WORK = new Set(['farm', 'quay', 'market']);
const SHOP_TYPES = ['market', 'shop', 'inn'];
const LEISURE_TYPES = ['park', 'inn', 'theatre', 'market', 'bathhouse', 'monument'];
const ROUTE_RETRY = 2;                                   // seconds before re-asking the planner

// ---------------------------------------------------------------------------
// Records

export function makePerson(state, household, home) {
  const id = nextId(state);
  // Walkers appear on the street in front of their door, never inside a footprint.
  const door = home ? accessPoint(home, state) : {x: 0, z: 0};
  const jitter = (hashUnit(id) - 0.5) * 0.6;
  return {
    id,
    householdId: household.id,
    homeId: home?.id ?? null,
    centreId: household.centreId ?? home?.centreId ?? state.centres?.[0]?.id ?? null,
    x: door.x + jitter,
    z: door.z - jitter,
    heading: 0,
    task: null,
    needs: {energy: 60 + (id % 35), fullness: 55 + ((id * 7) % 40), social: 45 + ((id * 13) % 50)},
    action: ACTION.none,
    actionT: 0,
    look: lookFor(id),
    vx: 0,
    vz: 0,
    speed: 0,
    indoor: false,
    phase: hashUnit(id * 31) * Math.PI * 2,
    cell: -1,
    workId: null,
    rev: 1,
  };
}

// Door point: the front of the footprint. rot k means the front faces 0 +z, 1 +x, 2 -z, 3 -x.
const FRONT = [[0, 1], [1, 0], [0, -1], [-1, 0]];
export function doorOf(b) {
  const [fx, fz] = FRONT[(b.rot ?? 0) & 3];
  const half = fx !== 0 ? (b.w ?? 4) / 2 : (b.d ?? 4) / 2;
  return {x: b.x + fx * (half + 0.8), z: b.z + fz * (half + 0.8)};
}

// ---------------------------------------------------------------------------
// Promote / demote

// Keep everyone walking (or min(cap, pop) under a cap), spread over households
// in proportion to their size.
export function syncIndividuals(state) {
  const cap = state.settings?.individualCap;
  const households = state.households.filter((h) => h.homeId != null);
  const pop = households.reduce((n, h) => n + h.size, 0);
  const target = cap > 0 ? Math.min(cap | 0, pop) : pop;
  const ratio = pop > 0 ? target / pop : 0;

  const want = new Map();
  let carry = 0;
  for (const h of households) {
    const exact = h.size * ratio + carry;
    const n = Math.min(h.size, Math.floor(exact + 1e-9));
    carry = exact - n;
    want.set(h.id, n);
  }

  const have = new Map();
  const people = state.people;
  for (let i = people.length - 1; i >= 0; i--) {
    const p = people[i];
    const n = have.get(p.householdId) ?? 0;
    const h = byId(state, 'households', p.householdId);
    if (n >= (want.get(p.householdId) ?? 0)) {
      removeAt(state, i);
      continue;
    }
    have.set(p.householdId, n + 1);
    if (h) p.centreId = h.centreId ?? byId(state, 'buildings', h.homeId)?.centreId ?? state.centres?.[0]?.id ?? null;
    if (h && p.homeId !== h.homeId) {
      p.homeId = h.homeId;
      if (p.task?.kind === 'rest') p.task = null;
    }
  }
  for (const h of households) {
    const missing = (want.get(h.id) ?? 0) - (have.get(h.id) ?? 0);
    if (missing <= 0) continue;
    const home = byId(state, 'buildings', h.homeId);
    for (let k = 0; k < missing; k++) people.push(makePerson(state, h, home));
  }
}

// Swap-remove keeps the array dense; the render view compares rows by id.
function removeAt(state, i) {
  const people = state.people;
  const last = people.length - 1;
  if (i !== last) people[i] = people[last];
  people.pop();
}

// ---------------------------------------------------------------------------
// Builders

// Assign walkers from craft and labour households to open projects, nearest first.
export function assignBuilders(state) {
  const open = state.projects.filter((p) => (p.progress ?? 0) < 1);
  if (!open.length) return;
  const assigned = new Set();
  const alive = new Set(state.people.map((p) => p.id));
  for (const pr of open) {
    pr.workers = (pr.workers ?? []).filter((id) => alive.has(id) && !assigned.has(id));
    for (const id of pr.workers) assigned.add(id);
  }
  const candidates = state.people.filter((p) => {
    if (assigned.has(p.id)) return false;
    const h = byId(state, 'households', p.householdId);
    return h && (h.trade === 'craft' || h.trade === 'labour' || h.trade === 'none');
  });
  // Nearest first, the earlier candidate on a tie: by a grid of where they stand, once
  // there are enough of them for that to pay.
  const nearest = candidates.length > NEAR_SCAN ? nearestCandidate(candidates) : null;
  let left = candidates.length;
  for (const pr of open) {
    const site = projectSite(state, pr);
    if (!site || !Number.isFinite(site.x)) continue;
    const want = Math.min(6, 2 + Math.floor((pr.workRequired ?? 30) / 40));
    while (pr.workers.length < want && left) {
      let p;
      if (nearest) p = nearest(site.x, site.z);
      else {
        let best = -1, bestD = Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const d = (c.x - site.x) ** 2 + (c.z - site.z) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
        [p] = candidates.splice(best, 1);
      }
      left--;
      pr.workers.push(p.id);
      assigned.add(p.id);
    }
  }
}

// Below this many points a plain scan is as quick as a grid. (Tests set it to check
// the grid gives the scan's answers.)
let NEAR_SCAN = 48;
export function setNearScan(n) { NEAR_SCAN = n; }

// The scan of assignBuilders as a search: (x, z) -> the candidate nearest it, the
// earliest in the list on a tie, taken out of the running. Squared distances are
// worked out exactly as the scan does.
function nearestCandidate(list) {
  const n = list.length;
  const xs = new Float64Array(n), zs = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = list[i].x; zs[i] = list[i].z; }
  const grid = pointGrid(xs, zs, n, 24);
  const taken = new Uint8Array(n);
  return (x, z) => {
    let best = -1, bestD = Infinity;
    ringSearch(grid, x, z, (i) => {
      if (taken[i]) return;
      const c = list[i];
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bestD || (d === bestD && i < best)) { bestD = d; best = i; }
    }, (bound2) => best >= 0 && bestD < bound2);
    taken[best] = 1;
    return list[best];
  };
}

// ---------------------------------------------------------------------------
// The tick

// Reused per tick so the hot loop allocates nothing.
const SYNC_ROUTES_PER_TICK = 4;
const inFlight = new WeakSet();   // tasks with a planner request out (transient)
const scratch = {
  projectsById: new Map(), workerProject: new Map(), onSite: new Map(), seats: new Set(), syncRoutes: SYNC_ROUTES_PER_TICK,
  // Rebuilt each tick (see crowdIndex): seats taken per building, seat counts (lazily).
  seatsTaken: new Map(), seatCount: new Map(),
};

export function stepPeople(state, ctx, dt) {
  const people = state.people;
  if (!people.length) return;
  const now = simTime(state);
  indexProjects(state);
  scratch.syncRoutes = SYNC_ROUTES_PER_TICK;
  const world = worldIndex(state);
  checkFootprints(state, now);
  crowdIndex(state);
  // In array order: the array (and so the order) is part of the save.
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    decayNeeds(p, dt);
    if (!p.task) chooseTask(state, ctx, p, world, now);
    const task = p.task;
    if (!task) continue;
    task.elapsed += dt;
    if (task.waiting) {
      // A planner request lost with an old session (save and reload) is asked again.
      if (now >= task.retryAt || (task.awaitingPlanner && !inFlight.has(task))) requestRoute(state, ctx, p, task, now);
      continue;
    }
    if (task.seg < task.route.length) move(state, ctx, p, task, dt, now);
    else dwell(state, p, task, dt, now);
  }
  for (const pr of state.projects) pr.onSite = scratch.onSite.get(pr.id) ?? 0;
}

const simTime = (state) => state.time.tick * 0.1;

function indexProjects(state) {
  scratch.projectsById.clear();
  scratch.workerProject.clear();
  scratch.onSite.clear();
  for (const pr of state.projects) {
    if ((pr.progress ?? 0) >= 1) continue;
    scratch.projectsById.set(pr.id, pr);
    for (const id of pr.workers ?? []) scratch.workerProject.set(id, pr.id);
  }
}

function decayNeeds(p, dt) {
  const n = p.needs;
  n.energy = n.energy > 0 ? n.energy - NEED_DECAY.energy * dt : 0;
  n.fullness = n.fullness > 0 ? n.fullness - NEED_DECAY.fullness * dt : 0;
  n.social = n.social > 0 ? n.social - NEED_DECAY.social * dt : 0;
}

function move(state, ctx, p, task, dt, now) {
  const route = task.route;
  if (p.speed <= 0) setVelocity(state, p, task, now);
  let budget = p.speed * dt;
  while (budget > 0 && task.seg < route.length) {
    const tx = route[task.seg], tz = route[task.seg + 1];
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= budget) {
      p.x = tx;
      p.z = tz;
      budget -= dist;
      task.seg += 2;
      if (task.seg < route.length) setVelocity(state, p, task, now);
    } else {
      p.x += (dx / dist) * budget;
      p.z += (dz / dist) * budget;
      budget = 0;
    }
  }
  enterCell(state, p, task, now);
  reanchorOnDeck(state, p, task, now);
  if (task.seg >= route.length) arrive(state, ctx, p, task, now);
}

// Bridge decks arch and ramp: while on one, the render row is renewed every
// DECK_STEP units so the drawn height keeps to the deck (ramps curve fast). At 0.4
// a walker at 1x could go two ticks between renewals and be drawn still climbing
// past an arch's crest; at 0.2 it is renewed every tick it walks on a deck.
export const DECK_STEP = 0.2;

function reanchorOnDeck(state, p, task, now) {
  if (task.seg >= task.route.length || Math.hypot(p.x - (p.anchorX ?? 1e9), p.z - (p.anchorZ ?? 1e9)) < DECK_STEP) return;
  if (deckAt(state, p.x, p.z)) setVelocity(state, p, task, now);
}

// Point the walker at its next waypoint at the speed of the ground underneath.
function setVelocity(state, p, task, now) {
  const tx = task.route[task.seg], tz = task.route[task.seg + 1];
  const dx = tx - p.x, dz = tz - p.z;
  const dist = Math.hypot(dx, dz) || 1;
  const speed = WALK_SPEED * groundSpeed(state, p.x, p.z) * (task.kind === 'flee' ? 1.6 : 1);
  p.vx = (dx / dist) * speed;
  p.vz = (dz / dist) * speed;
  p.speed = speed;
  p.heading = Math.atan2(p.vx, p.vz);
  p.anchorX = p.x;
  p.anchorZ = p.z;
  const action = task.kind === 'build' && hash32(p.id) % 2 === 0 ? ACTION.carry : ACTION.none;
  setAction(p, action, now);
  p.indoor = false;
  p.rev++;
}

function groundSpeed(state, x, z) {
  const roads = state.roads;
  const c = cellIndex(roads, x, z);
  if (c < 0) return 1;
  const flags = roads.planned[c];
  const deck = flags & BRIDGE || waterAt(x, z) ? deckAt(state, x, z) : null;
  if (deck) return DECK_SPEED[deck.bridge.style ?? deck.bridge.variant] ?? TIER_SPEED[3];
  if (flags & BRIDGE) return TIER_SPEED[3];
  if (waterAt(x, z)) return FORD_SPEED;
  return TIER_SPEED[roads.tier[c]] ?? 1;
}

// Wear once per cell entered; a speed change at a tier boundary needs a new row.
function enterCell(state, p, task, now) {
  const roads = state.roads;
  const c = cellIndex(roads, p.x, p.z);
  if (c === p.cell) return;
  p.cell = c;
  if (c < 0) return;
  addWear(state, p.x, p.z, WEAR_PER_CELL);
  if (task.seg < task.route.length) {
    const speed = WALK_SPEED * groundSpeed(state, p.x, p.z) * (task.kind === 'flee' ? 1.6 : 1);
    if (Math.abs(speed - p.speed) > 0.01) setVelocity(state, p, task, now);
  }
}

// sim-world's addWear when registered; raw wear otherwise.
function addWear(state, x, z, amount) {
  const hook = findHook('addWear');
  if (hook) {
    hook(state, x, z, amount);
    return;
  }
  const c = cellIndex(state.roads, x, z);
  if (c < 0) return;
  state.roads.wear[c] += amount;
  growActiveBox(state.roads, c);
  state.roads.wearAddedMonth = (state.roads.wearAddedMonth ?? 0) + amount;
}

function arrive(state, ctx, p, task, now) {
  p.vx = 0;
  p.vz = 0;
  p.speed = 0;
  if (task.leaving) return finish(p, now);   // off a bridge rail, at the deck's end
  const target = task.targetType === 'building' ? byId(state, 'buildings', task.targetId) : null;
  p.indoor = INDOOR.has(task.kind) && !!target && !(task.kind === 'work' && OUTDOOR_WORK.has(target.type));
  // A gathering's spot claimed in advance but not reached (the route ended short):
  // given up, and one found from here.
  if (task.claim && task.spot && Math.hypot(task.spot[0] - p.x, task.spot[1] - p.z) > 0.05) {
    task.claim = 0;
    task.spot = null;
  }
  // Staying in sight: a standing spot of its own near the goal, not on someone's head.
  if (!p.indoor && !task.seat && !task.spot && !takeSpot(state, ctx, p, task, now)) return;
  if (task.seat) p.heading = task.seat.yaw;
  else if (task.face && !p.indoor) p.heading = Math.atan2(task.face[0] - p.x, task.face[1] - p.z);
  setAction(p, dwellAction(state, p, task, target), now);
  p.rev++;
}

// Per-tick crowd index, from the saved state alone: seats taken, the standing hash
// (standing walkers, spots claimed by walkers on their last step to one, seats being
// walked to) for the spot finder, and the coarse density grid (density.js) the
// destination choice reads. Exported for tests.
export function crowdIndex(state) {
  scratch.seats.clear();
  scratch.seatsTaken.clear();
  scratch.seatCount.clear();
  standClear();
  kinReset();
  rebuildDensity(state);
  for (const p of state.people) {
    const task = p.task;
    if (!task) continue;
    if (task.seat) {
      scratch.seats.add(task.seat.key);
      scratch.seatsTaken.set(task.targetId, (scratch.seatsTaken.get(task.targetId) ?? 0) + 1);
    }
    if (p.indoor) continue;
    // A claimed spot holds while its walker waits for a route there (gatherings).
    if (task.spot) {
      standAdd(task.spot[0], task.spot[1], p.id, p.householdId);
      if (task.activity) kinAdd(p);
    } else if (task.waiting) continue;
    else if (task.seat) standAdd(task.tx, task.tz, p.id, p.householdId);
    else if (task.seg >= task.route.length) standAdd(p.x, p.z, p.id, p.householdId);
  }
}

// ---------------------------------------------------------------------------
// Standing spots
//
// Walkers pass through each other on the move, but those who stop in sight (outdoor
// work, a gate, a gathering, a building site, a halted flight) each take a spot of
// their own. Candidates lie on a tight sunflower spiral round what they came for
// (crowdPlan: the building, pulled toward its door; a gathering's own point; else where
// the walk ended), turned by the walker's id and rev; a candidate is taken if it is
// outside the building, open, dry ground off any deck, at least SPOT_SPACING from every
// other standing walker, and reachable by a straight clear step. Within the plan's
// inner reach the walker steps there and faces the attraction; if the crowd is fuller
// than that, the goal is relaxed instead of squeezing in: another target of the same
// kind nearby, else a short stay at the crowd's edge, else home. The chosen spot (and
// the point faced) is kept in the task (saved), so a restored town picks the same.

export const SPOT_SPACING = 0.7;
const SPOT_STEP = 0.3;                     // spiral density: about 0.57 between candidates
export const SPOT_INNER = 2.5;
const SPOT_OUTER = 3.4;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const MAX_RETARGET = 2;
const ALT_REACH = 60;                      // how far another stall or park may be
const SHORT_DWELL = 3;                     // seconds, at the edge of a full crowd

// Per-tick spatial hash of standing walkers: cells of SPOT_SPACING, each a flat
// [x, z, id, household, ...] list (lists are pooled between ticks).
const stand = {cells: new Map(), pool: []};
const standKey = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);

function standClear() {
  for (const list of stand.cells.values()) {
    list.length = 0;
    stand.pool.push(list);
  }
  stand.cells.clear();
}

function standAdd(x, z, id, household = -1) {
  const key = standKey(Math.floor(x / SPOT_SPACING), Math.floor(z / SPOT_SPACING));
  let list = stand.cells.get(key);
  if (!list) {
    list = stand.pool.pop() ?? [];
    stand.cells.set(key, list);
  }
  list.push(x, z, id, household ?? -1);
}

function spotFree(x, z, id) {
  const ix = Math.floor(x / SPOT_SPACING), iz = Math.floor(z / SPOT_SPACING);
  const min2 = SPOT_SPACING * SPOT_SPACING;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const list = stand.cells.get(standKey(ix + dx, iz + dz));
      if (!list) continue;
      for (let k = 0; k < list.length; k += 4) {
        if (list[k + 2] === id) continue;
        const ex = list[k] - x, ez = list[k + 1] - z;
        if (ex * ex + ez * ez < min2) return false;
      }
    }
  return true;
}

// As spotFree, with a personal space r of the walker's own (gatherings.js), and near
// (at most r) for standers of its own household.
export function spotClear(x, z, id, r, household = -1, near = r) {
  const ix = Math.floor(x / SPOT_SPACING), iz = Math.floor(z / SPOT_SPACING);
  const reach = Math.ceil(r / SPOT_SPACING);
  const r2 = r * r, n2 = near * near, hh = household ?? -1;
  for (let dz = -reach; dz <= reach; dz++)
    for (let dx = -reach; dx <= reach; dx++) {
      const list = stand.cells.get(standKey(ix + dx, iz + dz));
      if (!list) continue;
      for (let k = 0; k < list.length; k += 4) {
        if (list[k + 2] === id) continue;
        const ex = list[k] - x, ez = list[k + 1] - z;
        if (ex * ex + ez * ez < (hh >= 0 && list[k + 3] === hh ? n2 : r2)) return false;
      }
    }
  return true;
}

// Open, dry ground off any bridge deck.
export function standable(state, blocked, x, z) {
  return clearOfWalls(state, blocked, x, z) && !waterAt(x, z) && !deckAt(state, x, z);
}

// Open, and not within WALL_GAP of a walls cell (roads.js fp.walls). A point a hair from a blocked
// cell's edge reads inside it once the renderer has rounded it to float32 (the drawn
// walker at its spot or corner), so stops and corners keep this little gap.
const WALL_GAP = 0.05;
function clearOfWalls(state, blocked, x, z) {
  const roads = state.roads;
  for (let k = 0; k < 4; k++) {
    const c = cellIndex(roads, x + (k & 1 ? WALL_GAP : -WALL_GAP), z + (k & 2 ? WALL_GAP : -WALL_GAP));
    if (c < 0 || blocked[c]) return false;
  }
  // ...and clear of the drawn plinth, steps and wings by a walker's margin.
  return outlineClear(state, x, z);
}

// A short step with no wall, water or deck on the way.
export function stepClear(state, x0, z0, x1, z1) {
  if (!routeStillValid(state, [x0, z0, x1, z1], 0)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.4));
  for (let i = 1; i < steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    if (waterAt(x, z) || deckAt(state, x, z)) return false;
  }
  return true;
}

// Where a crowd for this goal gathers, and the point standers face. A building with
// walls: spots round its footprint (ringSpots), front first and wrapping round the
// sides, facing the building, not a disc round the empty doorstep. A park or farm (open
// ground): a spiral from halfway between its middle and its gate, onto the lawn. A
// gathering: a spiral round the event's own point, out to most of its radius. Farm
// rows, building sites and the rest: a spiral round where the walk ended. Spiral plans
// carry a centre and how far out a spot counts as in the crowd (inner) or at its edge
// (outer). A walker with an activity (gatherings.js: task.activity) takes a spot of
// that activity's layout at the place instead: plan.occ.
export function crowdPlan(state, targetType, targetId, tail, x, z, activity = null) {
  if (activity) {
    const occ = occasionFor(state, layoutOf(activity), targetType, targetId);
    if (occ) return {occ, fx: occ.fx, fz: occ.fz, skip: null};
  }
  if (targetType === 'building' && !tail) {
    const b = byId(state, 'buildings', targetId);
    if (b && b.type !== 'park' && b.type !== 'farm') return {ring: ringSpots(state, b), fx: b.x, fz: b.z, skip: b};
    if (b) {
      const door = accessPoint(b, state);
      const cx = (b.x + door.x) / 2, cz = (b.z + door.z) / 2;
      const inner = Math.hypot(door.x - cx, door.z - cz) + SPOT_INNER;
      return {cx, cz, inner, outer: inner + SPOT_OUTER - SPOT_INNER, fx: b.x, fz: b.z, skip: null};
    }
  }
  if (targetType === 'event') {
    const ev = state.worldEvents.find((e) => e.id === targetId);
    if (ev) {
      const inner = Math.max(SPOT_INNER, (ev.radius ?? 6) * 0.8);
      return {cx: ev.x, cz: ev.z, inner, outer: inner + SPOT_OUTER - SPOT_INNER, fx: ev.x, fz: ev.z, skip: null};
    }
  }
  return {cx: x, cz: z, inner: SPOT_INNER, outer: SPOT_OUTER, fx: NaN, fz: NaN, skip: null};
}

const insideOf = (b, x, z, m) => Math.abs(x - b.x) < (b.w ?? 4) / 2 + m && Math.abs(z - b.z) < (b.d ?? 4) / 2 + m;

// Standing spots round a building, best first: candidates on a lightly jittered grid
// (RING_GRID apart) out to RING_OUTER from its walls, on open, dry ground off decks,
// ordered by distance from the walls plus RING_FRONT for each unit of turning away from
// the front (the side its door faces: 0 in front, 1 at the sides, 2 behind), so a crowd
// fills the front a little deep, then wraps round. Spots within RING_INNER of the walls
// come first; the rest are the crowd's edge. A pure function of the building and the
// world (cached per building until the footprints or buildings change), the same list
// for every walker: each takes the first that is free and reachable.
const RING_GRID = 0.45;
const RING_INNER = 4;
const RING_OUTER = 4.9;
const RING_FRONT = 1.2;
const ringCache = new Map();

function ringSpots(state, b) {
  const key = `${footprintKey(state)}:${state.buildingsRev ?? 0}:${b.x},${b.z},${b.w},${b.d},${b.rot}`;
  const hit = ringCache.get(b.id);
  if (hit && hit.state === state && hit.key === key) return hit;
  const {walls: blocked} = footprints(state);
  const hw = (b.w ?? 4) / 2, hd = (b.d ?? 4) / 2;
  const door = accessPoint(b, state);
  const fl = Math.hypot(door.x - b.x, door.z - b.z) || 1;
  const fx = (door.x - b.x) / fl, fz = (door.z - b.z) / fl;
  const found = [];
  const n = Math.ceil((Math.max(hw, hd) + RING_OUTER) / RING_GRID);
  for (let j = -n; j <= n; j++)
    for (let i = -n; i <= n; i++) {
      const h = hash32((b.id * 7919 + (i + 512) * 1031 + (j + 512)) >>> 0);
      const x = b.x + (i + ((h & 255) / 255 - 0.5) * 0.5) * RING_GRID;
      const z = b.z + (j + (((h >>> 8) & 255) / 255 - 0.5) * 0.5) * RING_GRID;
      const ex = Math.max(0, Math.abs(x - b.x) - hw), ez = Math.max(0, Math.abs(z - b.z) - hd);
      const wall = Math.hypot(ex, ez);
      if (wall <= 0.3 || wall > RING_OUTER || !standable(state, blocked, x, z)) continue;
      const dl = Math.hypot(x - b.x, z - b.z) || 1;
      const turn = 1 - ((x - b.x) * fx + (z - b.z) * fz) / dl;
      found.push({x, z, edge: wall > RING_INNER, score: wall + RING_FRONT * turn});
    }
  found.sort((p, q) => (p.edge - q.edge) || (p.score - q.score) || (p.x - q.x) || (p.z - q.z));
  const spots = new Float64Array(found.length * 3);
  found.forEach((c, k) => { spots[k * 3] = c.x; spots[k * 3 + 1] = c.z; spots[k * 3 + 2] = c.edge ? 1 : 0; });
  if (ringCache.size > 512) ringCache.clear();
  const entry = {state, key, spots, fx, fz};
  ringCache.set(b.id, entry);
  return entry;
}

// The first free spot on the spiral round the plan's centre that the walker can reach
// from (ox, oz): {x, z, edge, via} (edge: beyond plan.inner), or null when there is none
// out to plan.outer. Reached by a straight clear step, or, round a building, by two:
// along the front to beside the spot (via), then straight in, so a crowd can wrap round
// the sides as well as fill the front.
export function findSpot(state, id, rev, plan, ox, oz) {
  const {walls: blocked} = footprints(state);
  if (plan.ring) return ringSpot(state, blocked, id, plan.ring, ox, oz);
  const turn = hashUnit(id * 53 + rev * 7 + 1) * Math.PI * 2;
  const {cx, cz, skip} = plan;
  // The front: from the building's centre toward where the walker stands (its door).
  let fx = 0, fz = 0;
  if (skip) {
    const fl = Math.hypot(ox - skip.x, oz - skip.z) || 1;
    fx = (ox - skip.x) / fl;
    fz = (oz - skip.z) / fl;
  }
  for (let k = 0; ; k++) {
    const r = SPOT_STEP * Math.sqrt(k);
    if (r > plan.outer) return null;
    const a = turn + k * GOLDEN;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (skip && insideOf(skip, x, z, 0.3)) continue;
    if (!spotFree(x, z, id) || !standable(state, blocked, x, z)) continue;
    if (Math.hypot(x - ox, z - oz) <= 0.02 || stepClear(state, ox, oz, x, z)) return {x, z, edge: r > plan.inner, via: null};
    if (!skip) continue;
    // Beside the spot on the door's line across the front.
    const t = (x - ox) * fx + (z - oz) * fz;
    const vx = x - fx * t, vz = z - fz * t;
    if (t > -0.3 || !standable(state, blocked, vx, vz) || !stepClear(state, ox, oz, vx, vz) || !stepClear(state, vx, vz, x, z)) continue;
    return {x, z, edge: r > plan.inner, via: [vx, vz]};
  }
}

// The first free, reachable spot of a building's ring (ringSpots), or null.
function ringSpot(state, blocked, id, ring, ox, oz) {
  const {spots, fx, fz} = ring;
  for (let k = 0; k < spots.length; k += 3) {
    const x = spots[k], z = spots[k + 1];
    if (!spotFree(x, z, id)) continue;
    const edge = spots[k + 2] === 1;
    if (Math.hypot(x - ox, z - oz) <= 0.02 || stepClear(state, ox, oz, x, z)) return {x, z, edge, via: null};
    // Round the corner: along the front's line to beside the spot, then straight in.
    const t = (x - ox) * fx + (z - oz) * fz;
    const vx = x - fx * t, vz = z - fz * t;
    if (t > -0.3 || !standable(state, blocked, vx, vz) || !stepClear(state, ox, oz, vx, vz) || !stepClear(state, vx, vz, x, z)) continue;
    return {x, z, edge, via: [vx, vz]};
  }
  return null;
}

// On arrival in sight. True: stand here now. False: the walker set off on its last
// step to a spot, or the goal was relaxed (a new task, or none).
function takeSpot(state, ctx, p, task, now) {
  const plan = crowdPlan(state, task.targetType, task.targetId, task.tail, p.x, p.z, task.activity);
  const spot = plan.occ ? occasionSpot(state, p, task, plan.occ, p.x, p.z) : findSpot(state, p.id, p.rev, plan, p.x, p.z);
  // A gathering's spot out of a straight step's reach is walked to by a route, once;
  // after that, the plain finder round where the walker is.
  // (Not at a bridge rail: a spot off the rail would face along the deck.)
  if (spot && plan.occ && !spot.reach && task.rerouted && plan.occ.layout === 'rail') return relaxGoal(state, ctx, p, task, null, now);
  if (spot && plan.occ && !spot.reach && task.rerouted) {
    const near = crowdPlan(state, 'point', null, null, p.x, p.z);
    const step = findSpot(state, p.id, p.rev, near, p.x, p.z);
    if (step) step.activity = null;   // just standing by, not part of the activity's layout
    return step && !step.edge ? stepTo(state, p, task, step, plan, now) : relaxGoal(state, ctx, p, task, step, now, near);
  }
  if (spot && !spot.edge) return plan.occ && !spot.reach ? routeToSpot(state, ctx, p, task, spot, now) : stepTo(state, p, task, spot, plan, now);
  return relaxGoal(state, ctx, p, task, spot, now, plan);
}

// The crowd is full (spot: at its edge, or null): another target of the same kind,
// else a short stay at the edge, else home.
function relaxGoal(state, ctx, p, task, spot, now, plan = null) {
  const relax = (task.relax ?? 0) + 1;
  const alt = relax <= MAX_RETARGET ? alternativeTarget(state, p, task) : null;
  if (alt) {
    p.rev++;
    startTask(state, ctx, p, task.kind, alt, now, {relax, avoid: [...(task.avoid ?? []), task.targetId], dwellFor: task.outing ? null : task.dwellFor});
    return false;
  }
  if (spot) {
    task.relax = relax;
    task.dwellFor = Math.min(task.dwellFor, SHORT_DWELL);
    if (plan?.occ) {
      spot.hopIn = null;
      if (!spot.reach) return routeToSpot(state, ctx, p, task, spot, now);
    }
    return stepTo(state, p, task, spot, plan, now);
  }
  p.rev++;
  const home = p.homeId != null ? byId(state, 'buildings', p.homeId) : null;
  if (home && !(task.kind === 'rest' && task.targetId === home.id)) {
    startTask(state, ctx, p, 'rest', buildingTarget(state, home), now, {relax});
    return false;
  }
  finish(p, now);
  return false;
}

function stepTo(state, p, task, spot, plan, now) {
  task.spot = [spot.x, spot.z];
  // Standers face what they came for (kept in the task: the save carries it); at a
  // gathering, what its spot faces (the focus, the group's middle, the view).
  const fx = spot.fx ?? plan.fx, fz = spot.fz ?? plan.fz;
  task.face = Number.isFinite(fx) && Math.hypot(fx - spot.x, fz - spot.z) > 0.05 ? [fx, fz] : null;
  if (plan.occ) gatheringSpot(p, task, spot);
  standAdd(spot.x, spot.z, p.id, p.householdId);
  if (Math.hypot(spot.x - p.x, spot.z - p.z) < 0.02) return true;
  pushSkirted(state, p, task, spot.via ? [spot.via[0], spot.via[1], spot.x, spot.z] : [spot.x, spot.z]);
  setVelocity(state, p, task, now);
  return false;
}

// Points skirtOutlines leaves be: on or by a bridge deck (alongDecks has set its lanes).
function deckKeep(state) {
  const decks = deckList(state);
  if (!decks.length) return null;
  return (x, z) => !!deckZone(state, x, z) || decks.some(({bridge}) => Math.hypot(bridge.a.x - x, bridge.a.z - z) < DECK_KEEP || Math.hypot(bridge.b.x - x, bridge.b.z - z) < DECK_KEEP);
}

// Points added to a walker's route from where it is (its route's last point, or where
// it stands), round the corner of any drawn plinth, step or wing they cut (roads.js
// skirtOutlines).
function pushSkirted(state, p, task, pts) {
  const route = task.route, n = route.length;
  const leg = skirtOutlines(state, [n >= 2 ? route[n - 2] : p.x, n >= 2 ? route[n - 1] : p.z, ...pts], deckKeep(state));
  task.route = extendRoute(route, leg, 2);
}

// Routes are Float32Arrays of [x, z, ...] (half the memory of a list of doubles, and
// saved compactly): built once, and replaced, never grown in place.
export const toRoute = (list) => (list instanceof Float32Array ? list : Float32Array.from(list));
function extendRoute(route, pts, from = 0) {
  const out = new Float32Array(route.length + pts.length - from);
  out.set(route);
  for (let k = from; k < pts.length; k++) out[route.length + k - from] = pts[k];
  return out;
}

// An activity's spot (gatherings.js occasionSpot) taken: what the walker does there
// (task.activity: the picker may settle it), its conversation group, and when it next
// moves on (task.hopAt, seconds of dwell).
function gatheringSpot(p, task, spot) {
  if (spot.activity !== undefined) task.activity = spot.activity;
  task.group = spot.group >= 0 ? spot.group : null;
  task.hopAt = spot.hopIn != null ? task.dwell + spot.hopIn : null;
}

// Claim a gathering's spot and make it the walk's destination: the route pipeline
// takes the walker there (the tail is the exact spot), and the claim holds meanwhile.
function claimSpot(p, task, spot) {
  if (!task.claim) task.goal = [task.tx, task.tz, task.tail];
  task.spot = [spot.x, spot.z];
  task.face = Math.hypot(spot.fx - spot.x, spot.fz - spot.z) > 0.05 ? [spot.fx, spot.fz] : null;
  task.claim = 1;
  task.tx = spot.x;
  task.tz = spot.z;
  task.tail = [spot.x, spot.z];
  gatheringSpot(p, task, spot);
  standAdd(spot.x, spot.z, p.id, p.householdId);
  kinAdd(p);
}

// A claimed spot a new footprint has covered (or the river has taken) is given up: the
// walk goes to the goal itself again, and a spot is found on arrival.
function checkClaim(state, task) {
  const [x, z] = task.spot;
  if (layoutOf(task.activity) === 'rail' ? deckSpot(state, x, z) : standable(state, footprints(state).walls, x, z)) return;
  task.claim = 0;
  task.spot = null;
  [task.tx, task.tz, task.tail] = task.goal ?? [task.tx, task.tz, null];
}

function routeToSpot(state, ctx, p, task, spot, now) {
  claimSpot(p, task, spot);
  task.rerouted = 1;
  requestRoute(state, ctx, p, task, now);
  return false;
}

// A new task with an activity (a gathering, a leisure visit): from nearby, its spot is chosen now (when one
// is free in the crowd's inner reach) and walked to by the route; from further off, on
// arrival, as for any crowd (so the front fills with those who get there first, not
// with places kept for walkers still crossing town).
const CLAIM_REACH = 24;
function planGathering(state, p, task) {
  const activity = task.activity ?? gatheringActivity(state, task.kind, task.targetType, task.targetId, task.eventKind);
  if (!activity) return;
  task.activity = activity;
  // An outing's spot (a reach of bank, a rail) is kept from the start, however far.
  if (!task.outing && Math.hypot(task.tx - p.x, task.tz - p.z) > CLAIM_REACH) return;
  const occ = occasionFor(state, layoutOf(activity), task.targetType, task.targetId);
  if (!occ) return;
  const spot = occasionSpot(state, p, task, occ, p.x, p.z);
  if (spot && !spot.edge) claimSpot(p, task, spot);
}

// From a rail spot to just beyond the nearer end of its deck, along the deck: the end in
// the stander's lane (half its offset, as deckLane keeps lanes inside the parapets), then
// DECK_APPROACH beyond it on dry, open ground. False if there is no such way off.
function leaveDeck(state, p, task, now) {
  const deck = deckAt(state, p.x, p.z);
  if (!deck) return false;
  const b = deck.bridge;
  const [e, o] = deck.t < 0.5 ? [b.a, b.b] : [b.b, b.a];
  const len = Math.hypot(o.x - e.x, o.z - e.z) || 1;
  const ux = (e.x - o.x) / len, uz = (e.z - o.z) / len;
  // The stander's signed offset across the deck (positive: right of a -> b).
  const ax = (b.b.x - b.a.x) / len, az = (b.b.z - b.a.z) / len;
  const off = ((p.x - b.a.x) * az - (p.z - b.a.z) * ax) * 0.5;
  const ex = e.x + az * off, ez = e.z - ax * off;
  const qx = ex + ux * DECK_APPROACH, qz = ez + uz * DECK_APPROACH;
  if (waterAt(qx, qz) || deckAt(state, qx, qz) || !clearOfWalls(state, footprints(state).walls, qx, qz)) return false;
  if (!legOpen(state, ex, ez, qx, qz)) return false;
  task.leaving = 1;
  task.route = extendRoute(task.route, [ex, ez, qx, qz]);
  setVelocity(state, p, task, now);
  return true;
}

// Moving on during the dwell: to another conversation group, a loop of play, a turn
// round the park (gatherings.js wanderRoute). True if the walker set off.
function wander(state, p, task, now) {
  const occ = occasionFor(state, layoutOf(task.activity), task.targetType, task.targetId);
  const pts = wanderRoute(state, p, task, occ);
  if (!pts) return false;
  standAdd(task.spot[0], task.spot[1], p.id, p.householdId);   // a new spot, held from now
  pushSkirted(state, p, task, pts);
  setVelocity(state, p, task, now);
  return true;
}

// Another target of the same kind near the full one, with room to stand as things
// are now, or null: one of the ALT_TRIES nearest other buildings of the type (any
// leisure place, a free seat first, for leisure) within ALT_REACH. A gathering has no
// other point: its crowd already fills most of its radius round its centre.
const ALT_TRIES = 3;
const altScratch = [];

// Room in the crowd for a target (a candidate goal, before setting off): its plan, as
// if the walker had just arrived at the target point.
function hasRoom(state, p, target, kind) {
  const activity = gatheringActivity(state, kind, target.type, target.id, target.eventKind);
  const plan = crowdPlan(state, target.type, target.id, target.tail ?? null, target.x, target.z, activity);
  const [ox, oz] = target.tail ?? [target.x, target.z];
  const spot = plan.occ ? occasionSpot(state, p, {kind, targetType: target.type, targetId: target.id, activity}, plan.occ, ox, oz) : findSpot(state, p.id, p.rev, plan, ox, oz);
  return !!spot && !spot.edge;
}

function alternativeTarget(state, p, task) {
  // An outing whose place is full: the next such place (another reach, another rail).
  if (task.outing) return alternativeOuting(state, p, task, worldIndex(state));
  if (task.targetType !== 'building') return null;
  const b = byId(state, 'buildings', task.targetId);
  if (!b) return null;
  const world = worldIndex(state);
  const types = task.kind === 'leisure' ? LEISURE_TYPES : [b.type];
  const avoid = task.avoid ?? [];
  // The nearest few, nearest first (ties by list order, which is the save's).
  altScratch.length = 0;
  for (const t of types) {
    for (const c of world.byType.get(t) ?? []) {
      if (c === b || avoid.includes(c.id)) continue;
      const d = (c.x - b.x) ** 2 + (c.z - b.z) ** 2;
      if (d > ALT_REACH * ALT_REACH) continue;
      let i = altScratch.length;
      while (i > 0 && altScratch[i - 1].d > d) i--;
      if (i < ALT_TRIES) altScratch.splice(i, 0, {c, d});
      if (altScratch.length > ALT_TRIES) altScratch.length = ALT_TRIES;
    }
  }
  for (const {c} of altScratch) {
    if (task.kind === 'leisure') {
      const target = seatTarget(state, p, buildingTarget(state, c));
      if (target.seat || hasRoom(state, p, target, task.kind)) return target;
      continue;
    }
    const target = buildingTarget(state, c);
    if (c.type === 'farm') farmRows(state, p, c, target);
    if (hasRoom(state, p, target, task.kind)) return target;
  }
  return null;
}

function dwellAction(state, p, task, target) {
  if (p.indoor) return ACTION.none;
  if (task.kind === 'build') return ACTION.build;
  if (task.kind === 'work') return target?.type === 'farm' ? ACTION.build : ACTION.carry;
  if (task.kind === 'gather') {
    const kind = task.eventKind;
    if (kind === 'protest' || kind === 'strike') return ACTION.protest;
    if (kind === 'festival' || kind === 'wedding') return hash32(p.id) % 3 === 0 ? ACTION.dance : ACTION.cheer;
    return ACTION.none;
  }
  if (task.seat) return task.seat.bench ? ACTION.bench : hash32(p.id + 7) % 4 === 0 ? ACTION.none : ACTION.sit;
  // An activity's pose (gatherings.js ACTIVITIES: an ACTION name, or null to stand).
  if (task.activity) return ACTION[ACTIVITIES[task.activity]?.action] ?? ACTION.none;
  if (task.kind === 'leisure') return hash32(p.id + 7) % 2 === 0 ? ACTION.sit : ACTION.none;
  return ACTION.none;
}

function setAction(p, action, now) {
  if (p.action === action) return;
  p.action = action;
  p.actionT = now;
}

function dwell(state, p, task, dt, now) {
  task.dwell += dt;
  const n = p.needs;
  if (task.kind === 'rest') n.energy = Math.min(100, n.energy + 5 * dt);
  else if (task.kind === 'shop') n.fullness = Math.min(100, n.fullness + 9 * dt);
  else if (task.kind === 'leisure' || task.kind === 'gather' || task.kind === 'worship') n.social = Math.min(100, n.social + 4 * dt);
  if (task.kind === 'build') {
    const pr = scratch.projectsById.get(task.targetId);
    if (!pr) return finish(p, now);
    scratch.onSite.set(pr.id, (scratch.onSite.get(pr.id) ?? 0) + 1);
  }
  if (task.hopAt != null && task.dwell >= task.hopAt && task.dwell < task.dwellFor && !p.indoor && wander(state, p, task, now)) return;
  // Done at a bridge rail: first along the deck and off its nearer end, so the next walk
  // starts on the bank (a route planned from the middle of a deck can step off its side).
  if (task.dwell >= task.dwellFor && !task.leaving && task.spot && layoutOf(task.activity) === 'rail' && leaveDeck(state, p, task, now)) return;
  // A bridge that has closed under someone at its rail: off they go.
  if (task.spot && task.activity && layoutOf(task.activity) === 'rail' && !deckSpot(state, p.x, p.z)) return finish(p, now);
  if (task.dwell >= task.dwellFor) finish(p, now);
}

function finish(p, now) {
  p.task = null;
  if (p.indoor || p.action !== ACTION.none) {
    p.indoor = false;
    setAction(p, ACTION.none, now);
    p.rev++;
  }
}

// ---------------------------------------------------------------------------
// Choosing what to do next

// Per-tick lookup tables for targets (rebuilt when the building list changes).
let worldCache = null;
function worldIndex(state) {
  const key = `${state.buildingsRev}:${state.buildings.length}:${state.worldEvents.length}:${state.enterprises.length}`;
  if (worldCache?.state === state && worldCache.key === key) return worldCache;
  const byType = new Map();
  for (const b of state.buildings) {
    if (b.built < 1) continue;
    if (!byType.has(b.type)) byType.set(b.type, []);
    byType.get(b.type).push(b);
  }
  const workplaces = new Map();
  for (const e of state.enterprises) {
    if (e.jobs <= 0) continue;
    if (!workplaces.has(e.trade)) workplaces.set(e.trade, []);
    workplaces.get(e.trade).push(e);
  }
  worldCache = {state, key, byType, workplaces, allWork: state.enterprises.filter((e) => e.jobs > 0)};
  return worldCache;
}

function chooseTask(state, ctx, p, world, now) {
  const h = byId(state, 'households', p.householdId);
  const home = p.homeId != null ? byId(state, 'buildings', p.homeId) : null;
  const projectId = scratch.workerProject.get(p.id);
  if (projectId != null) return startTask(state, ctx, p, 'build', projectTarget(state, scratch.projectsById.get(projectId), p), now);

  const danger = nearEvent(state, p, ['fire', 'flood']);
  if (danger && home) return startTask(state, ctx, p, 'flee', buildingTarget(state, home), now);

  const targets = {
    work: workTarget(state, p, h, world),
    rest: home ? buildingTarget(state, home) : null,
    shop: nearestOf(state, world, SHOP_TYPES, p, 3, h),
    leisure: seatTarget(state, p, nearestOf(state, world, LEISURE_TYPES, p, 4, h)) ?? strollTarget(state, p),
    worship: nearestOf(state, world, ['chapel'], p, 2, h),
    gather: gatherTarget(state, p),
  };
  const n = p.needs;
  const prior = {
    work: h && h.trade !== 'gentry' ? 1.2 : 0.1,
    rest: 0.2 + (100 - n.energy) / 35,
    shop: 0.1 + (100 - n.fullness) / 35,
    leisure: 0.2 + (100 - n.social) / 45,
    worship: 0.1 + state.pressures.faith * (h?.faithBand ?? 1) * 0.5,
    gather: 1.5,
  };
  // Local hard facts: very low needs dominate whatever the slice prefers.
  const facts = {
    rest: n.energy < 15 ? 6 : 1,
    shop: n.fullness < 15 ? 6 : 1,
    leisure: n.social < 10 ? 3 : 1,
  };
  const mask = [];
  for (const k in targets) if (targets[k]) mask.push(k);
  if (!mask.length) return startTask(state, ctx, p, 'leisure', strollTarget(state, p), now);
  const kind = decide(state, 'resident_routine', {type: 'person', record: p, household: h}, {
    prior, facts, mask, rng: () => rng(state, 'people'),
  });
  // Leisure: sometimes an outing of the walker's own (leisure.js) instead.
  if (kind === 'leisure') {
    const outing = outingTarget(state, p, h, world);
    if (outing) return startTask(state, ctx, p, kind, outing, now);
  }
  startTask(state, ctx, p, kind, targets[kind], now);
}

// Walkers head for the street cell in front of the door (shared by everyone going in,
// so the route cache and flow fields can serve them all) and "go in" there: indoor
// walkers are hidden, they never walk into the footprint.
function buildingTarget(state, b) {
  const door = accessPoint(b, state);
  return {type: 'building', id: b.id, x: door.x, z: door.z, building: b};
}

// A park, or a gathering place with benches by its door: sit on a free bench seat
// or a spot on the lawn rather than all at the gate. Seats taken this tick are in
// scratch.seats; one in a footprint's margin or the river is skipped. Every seat
// taken: the gate, as before.
function seatTarget(state, p, target) {
  const b = target?.building;
  if (!b) return target;
  const seats = seatsOf(b);
  if (!seats.length) return target;
  const {walls: blocked} = footprints(state);
  const start = hash32(p.id * 31 + p.rev) % seats.length;
  for (let k = 0; k < seats.length; k++) {
    const seat = seats[(start + k) % seats.length];
    if (scratch.seats.has(seat.key)) continue;
    // A park's lawn is laid out by appeal instead (gatherings.js): only its benches here.
    if (!seat.bench && b.type === 'park') continue;
    const c = cellIndex(state.roads, seat.x, seat.z);
    if (c < 0 || blocked[c] || waterAt(seat.x, seat.z)) continue;
    scratch.seats.add(seat.key);
    return {...target, x: seat.x, z: seat.z, seat: {key: seat.key, yaw: seat.yaw, bench: seat.bench}};
  }
  return target;
}

// The doorstep (roads.js doorstepCell): in front of the door, beyond the building's
// own steps or porch. A farm: the lane outside its gate (farm work steps on into the
// rows from there, farmRows).
// (With the state, the town's own way in: roads.js footprints' wayIn, the street cell
// itself where the cell beyond an old wing is someone else's lot.)
export function accessPoint(b, state = null) {
  if (b.type === 'farm') {
    const front = frontCell(b);
    if (front >= 0) return cellCenter(front);
  }
  return doorPoint(b, state);
}

// When buildings appear or change, walkers standing inside a new footprint step out to
// the nearest open cell, and routes that now cross one are planned again.
// The last footprint key walkers were checked against is kept in the state, so a
// restored town behaves exactly like the original.
// A walk found clear may also hold a certificate (walkCertificate): while it holds, the
// route checks below are known to find nothing, so they are not run. Certificates live
// outside the state (never saved), like the memos: a restored town checks in full once.
function checkFootprints(state, now) {
  checkDecks(state);
  const key = footprintKey(state);
  if (state.walkerFootprintKey === key) return;
  const first = state.walkerFootprintKey == null;
  state.walkerFootprintKey = key;
  const {walls: blocked} = footprints(state);
  const roads = state.roads;
  // The tiles changed since the last check, and this check's number.
  const seen = footprintChecks.get(state);
  const changed = seen ? changedTilesSince(state, seen.gen) : null;
  const check = (seen?.check ?? 0) + 1;
  const now0 = footprintGen(state);
  footprintChecks.set(state, {gen: now0.gen, check});
  for (const p of state.people) {
    const c = cellIndex(roads, p.x, p.z);
    if (c >= 0 && blocked[c]) {
      const open = nearestOpen(state, c, 8, true);
      if (open >= 0) {
        const at = standPoint(state, open);
        p.x = at.x;
        p.z = at.z;
        p.cell = open;
        p.rev++;
      }
      if (p.task) replan(p, now);
      continue;
    }
    // A walk whose certificate holds is clear where the walker stands as well (it is on
    // a certified leg), so nothing below would find anything.
    const task = p.task;
    if (changed && !first && task && !task.waiting && task.seg < task.route.length && certHolds(certificates.get(task), p, task, changed, check)) {
      certShadow?.(state, p, deckKeep(state));
      continue;
    }
    // On open ground, but a building just drawn here reaches over the spot (its plinth
    // or steps): a step aside, clear of it, and on from there.
    if (!first && !p.indoor && !p.task?.seat && !outlineClear(state, p.x, p.z)) {
      const at = standPoint(state, c);
      p.x = at.x;
      p.z = at.z;
      p.rev++;
      if (p.task) replan(p, now);
      continue;
    }
    if (first || !task || task.waiting || task.seg >= task.route.length) continue;
    const route = task.route;
    if (!routeStillClear(state, p)) {
      replan(p, now);
      continue;
    }
    reskirt(state, p, now);
    if (p.task === task && task.route === route && !task.waiting) walkCertificate(state, p, task, check, now0);
  }
}

const footprintChecks = new WeakMap();   // state -> {gen, check}: the last footprint check
// Tests: called for each walker a certificate let off, to run the full checks on it.
let certShadow = null;
export function shadowCertificates(fn) { certShadow = fn; }
const certificates = new WeakMap();      // task -> certificate (walkCertificate)

// A certificate for a walk just checked and found clear, with both memos taken: from
// where the walker stands, its legs up to CERT_REACH ahead are clear of walls and drawn
// pieces as lines (roads.js legCertified). Then while the walker is still on one of
// them, the same route, and no tile under those legs or the memos' changed, every check
// checkFootprints runs on its route gives what it gave now: the memos hold (nothing
// they cover changed) and the leg from where it stands is part of a certified one.
const CERT_REACH = 24;
const CERT_ON_LEG = 1e-7;   // how far off its leg's line a walker may be (rounding only)
function walkCertificate(state, p, task, check, gens) {
  const route = task.route, seg = task.seg;
  const walls = wallMemos.get(task), skirt = skirtMemos.get(task);
  const old = certificates.get(task);
  const tiles = old?.tiles ?? [];
  tiles.length = 0;
  if (!walls || walls.route !== route || !skirt || skirt.route !== route || !legCertified(footprints(state), p.x, p.z, route[seg], route[seg + 1], tiles)) {
    if (old) certificates.delete(task);
    return;
  }
  const fp = footprints(state);
  let last = seg;
  for (let k = seg, reach = Math.hypot(route[seg] - p.x, route[seg + 1] - p.z); k + 3 < route.length && reach < CERT_REACH; k += 2) {
    if (!legCertified(fp, route[k], route[k + 1], route[k + 2], route[k + 3], tiles)) break;
    reach += Math.hypot(route[k + 2] - route[k], route[k + 3] - route[k + 1]);
    last = k + 2;
  }
  const box = tileBox(tiles);
  const cert = old ?? {};
  cert.route = route;
  cert.length = route.length;
  cert.seg0 = seg;
  cert.seg1 = last;
  cert.x0 = p.x;
  cert.z0 = p.z;
  cert.tiles = tiles;
  cert.tx0 = box.tx0; cert.tz0 = box.tz0; cert.tx1 = box.tx1; cert.tz1 = box.tz1;
  cert.check = check;
  cert.tileGen = gens.tileGen;
  cert.wallGen = gens.wallGen;
  cert.wallMemo = walls;
  cert.skirtMemo = skirt;
  if (!old) certificates.set(task, cert);
}

// Does the certificate still hold for this walker at check number `check`? It must have
// held (or been made) at the check before, against the same tile arrays, with none of
// its tiles changed since (changed: roads.js changedTilesSince), nor any its memos'
// legs sample, and the walker on one of its legs of the same route, with both memos
// still the ones it was made with.
function certHolds(cert, p, task, changed, check) {
  if (!cert || cert.check !== check - 1 || cert.tileGen !== changed.tileGen || cert.wallGen !== changed.wallGen) return false;
  const route = task.route, seg = task.seg;
  if (route !== cert.route || route.length !== cert.length || seg < cert.seg0 || seg > cert.seg1) return false;
  const walls = wallMemos.get(task), skirt = skirtMemos.get(task);
  if (walls !== cert.wallMemo || skirt !== cert.skirtMemo || walls.memo.from > seg || skirt.clear.from > seg) return false;
  const ax = seg === cert.seg0 ? cert.x0 : route[seg - 2], az = seg === cert.seg0 ? cert.z0 : route[seg - 1];
  if (!onLeg(p.x, p.z, ax, az, route[seg], route[seg + 1])) return false;
  if (tilesTouched(changed, cert.tiles, cert.tx0, cert.tz0, cert.tx1, cert.tz1) || memoTouched(changed, walls.memo) || memoTouched(changed, skirt.clear)) return false;
  cert.check = check;
  return true;
}

// Is (x, z) on the segment a -> b, to within CERT_ON_LEG?
function onLeg(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
  const px = x - ax, pz = z - az;
  if (len2 === 0) return px * px + pz * pz <= CERT_ON_LEG * CERT_ON_LEG;
  const t = (px * dx + pz * dz) / len2;
  const len = Math.sqrt(len2), e = CERT_ON_LEG / len;
  if (t < -e || t > 1 + e) return false;
  return Math.abs(px * dz - pz * dx) / len <= CERT_ON_LEG;
}

// routeClearFrom for the rest of a walker's route. A walk found clear keeps a memo
// (roads.js wallMemo); while no wall has come or gone near the legs ahead, only the
// leg from where the walker stands is checked, with exactly the full check's answer.
// Memos live outside the state (never saved): a restored town checks in full once.
const wallMemos = new WeakMap();   // task -> {route, memo}
function routeStillClear(state, p) {
  const task = p.task, route = task.route;
  const held = wallMemos.get(task);
  const known = held && held.route === route ? wallsStillClear(state, held.memo, p.x, p.z, route, task.seg) : undefined;
  if (known !== undefined) return known;
  const clear = routeClearFrom(state, p.x, p.z, route, task.seg);
  if (clear) wallMemos.set(task, {route, memo: wallMemo(state, route, task.seg)});
  else wallMemos.delete(task);
  return clear;
}

// A walk under way when something new is drawn by it (a plinth, steps or a wing on a
// building just placed or changed): the rest of the route goes round it, as a fresh
// route would (roads.js skirtOutlines). Untouched when nothing is in the way.
// Most walks are far from what changed: a walk found clear once keeps a memo (roads.js
// skirtMemo), and while it holds only the leg from where the walker stands is checked,
// with exactly the result the whole walk would give. Memos live outside the state
// (never saved), so a restored town does the full check once and agrees.
// One scratch list for the rest of each walk: skirtOutlines hands back a new array when
// it changes anything, and the scratch itself is never kept.
const skirtMemos = new WeakMap();   // task -> memo for task.route
const restScratch = [];
const skirtReport = {near: false};
function reskirt(state, p, now) {
  const task = p.task, route = task.route;
  const memo = skirtMemos.get(task);
  if (memo && memo.route === route && skirtStillClear(state, memo.clear, route, task.seg, p.x, p.z)) return;
  const rest = restScratch;
  rest.length = 0;
  rest.push(p.x, p.z);
  for (let k = task.seg; k < route.length; k++) rest.push(route[k]);
  skirtReport.near = false;
  const out = skirtOutlines(state, rest, deckKeep(state), skirtReport);
  if (out === rest) {
    if (skirtReport.near) skirtMemos.delete(task);
    else skirtMemos.set(task, {route, clear: skirtMemo(state, route, task.seg)});
    return;
  }
  task.route = toRoute(out);
  task.seg = 2;
  setVelocity(state, p, task, now);
}

// Goals inside a footprint or in the river (a crowd spot on a roof or by a flood, a
// stroll into a wall) move to the nearest open dry cell, and goals on a drawn plinth or
// step to the nearest point clear of it; the farm-field step stays where it is (fields
// are open ground).
function openGround(state, target) {
  const c = cellIndex(state.roads, target.x, target.z);
  if (c < 0) return;
  if (!(footprints(state).walls[c] || (waterAt(target.x, target.z) && !deckAt(state, target.x, target.z)))) {
    // Open, but on a drawn plinth or step reaching into the cell: the nearest clear point.
    if (outlineClear(state, target.x, target.z)) return;
    const at = standPoint(state, c);
    target.x = at.x;
    target.z = at.z;
    return;
  }
  const open = nearestOpen(state, c, 8, true);
  if (open < 0) return;
  const at = standPoint(state, open);
  target.x = at.x;
  target.z = at.z;
}

// Stop and wait for a new route. The walker stands still meanwhile, so its render row
// must stop too (a stale velocity would carry it on toward the old waypoint).
// When a bridge opens (or closes), walkers standing on or heading over its deck get a
// fresh render row, so the deck height applies at once. (They finish their current leg;
// stopping them could leave someone standing in the ford that just closed.)
function checkDecks(state) {
  const key = deckList(state).map((d) => d.bridge.id).join(',');
  if (state.walkerDeckKey === key) return;
  const first = state.walkerDeckKey == null;
  state.walkerDeckKey = key;
  if (first) return;
  for (const p of state.people) {
    const task = p.task;
    const ahead = task && task.seg + 1 < task.route.length ? deckCrossed(state, p.x, p.z, task.route[task.seg], task.route[task.seg + 1]) : null;
    if (deckAt(state, p.x, p.z) || ahead) p.rev++;
  }
}

function replan(p, now, delay = 0) {
  p.task.waiting = true;
  p.task.retryAt = now + delay;
  halt(p);
}

function halt(p) {
  if (p.speed === 0 && p.vx === 0 && p.vz === 0) return;
  p.speed = 0;
  p.vx = 0;
  p.vz = 0;
  p.rev++;
}

function segmentBlocked(state, x0, z0, x1, z1) {
  const fp = footprints(state);
  if (gridLaidOut(state.roads)) return walkerSegmentBlocked(fp, x0, z0, x1, z1);
  const {walls: blocked} = fp;
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 2);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    const c = cellIndex(state.roads, x, z);
    if (c >= 0 && blocked[c]) return true;
    // ...or a drawn piece (a farmhouse's plinth by the rows) within a walker's margin.
    if (i > 0 && !outlineClear(state, x, z)) return true;
  }
  return false;
}

// Walkers use a bridge only along its centre line, joining and leaving it at its
// ends. Grid routes do not know that: on a deck set at an angle to the grid the
// path's cells lie up to a cell off the axis, and a path cell beside an abutment
// can send a leg across the deck's side or corner, where the drawn walker would
// meet the deck as a step. So:
//   1. waypoints on a deck (or its verge) are dropped, unless that would take
//      a leg through a wall;
//   2. a leg over a deck from one bank to the other goes end to end;
//   3. any other leg that touches a deck joins or leaves it at the nearer end,
//      by a point just off the end along the axis; one that only grazes the
//      deck goes round that end.
// Inserted points are kept off walls and water.
const DECK_APPROACH = 1.6;

// lane: the walker's lane fraction in [-1, 1] (laneFraction): its bridge ends and their
// approach points move across the deck by that share of the deck's walkable half-width
// (right of the direction of travel), the same at both ends, so a crossing is a straight
// line parallel to the parapets. 0 keeps the centre line.
export function alongDecks(state, route, lane = 0) {
  if (route.length < 4 || !deckList(state).length) return route;
  const pts = [[route[0], route[1]]];
  for (let k = 2; k + 3 < route.length; k += 2) {
    const x = route[k], z = route[k + 1];
    const deck = deckZone(state, x, z);
    const prev = pts[pts.length - 1];
    if (deck) {
      // A run of waypoints on one deck (smoothed routes put nodes on its
      // centre line) between points on opposite banks of it: drop the run, so
      // the crossing below is one straight leg in the walker's lane.
      let e = k;
      while (e + 3 < route.length && deckZone(state, route[e], route[e + 1]) === deck) e += 2;
      const nx = route[e], nz = route[e + 1];
      if (!prev.cross && !deckZone(state, prev[0], prev[1]) && deckZone(state, nx, nz) !== deck &&
        (alongBridge(deck, prev[0], prev[1]).t < 0.5) !== (alongBridge(deck, nx, nz).t < 0.5)) {
        // A marker, expanded below into the crossing itself: never left to a
        // straight bank-to-bank leg, which could miss the deck on a bend.
        pts.push({cross: deck});
        k = e - 2;
        continue;
      }
    }
    const next = [route[k + 2], route[k + 3]];
    if (deck && legOpen(state, prev[0], prev[1], next[0], next[1])) continue;
    pts.push([x, z]);
  }
  pts.push([route[route.length - 2], route[route.length - 1]]);
  const out = [pts[0][0], pts[0][1]];
  for (let k = 1; k < pts.length; k++) {
    const x0 = out[out.length - 2], z0 = out[out.length - 1];
    if (pts[k].cross) {
      // End to end in the walker's lane, as for a leg that crosses the whole deck.
      const bridge = pts[k].cross;
      const [nx, nz] = pts[k + 1];
      const aFirst = alongBridge(bridge, x0, z0).t < 0.5;
      const [p, q] = aFirst ? [bridge.a, bridge.b] : [bridge.b, bridge.a];
      const [ps, qs, pre, post] = deckLane(state, bridge, p, q, lane, x0, z0, nx, nz);
      if (pre) for (const a of pre) pushOpen(state, out, route, a.x, a.z);
      else approach(state, out, bridge, ps, qs, x0, z0);
      pushOpen(state, out, route, ps.x, ps.z);
      pushOpen(state, out, route, qs.x, qs.z);
      if (post) for (const a of post) pushOpen(state, out, route, a.x, a.z);
      else approach(state, out, bridge, qs, ps, nx, nz);
      continue;
    }
    const [x1, z1] = pts[k];
    const on0 = deckZone(state, x0, z0), on1 = deckZone(state, x1, z1);
    const bridge = deckCrossed(state, x0, z0, x1, z1);
    if (bridge) {
      // Enter at the end on the walker's side of the river (t < 0.5 is the a side);
      // a walker already on this deck goes straight on to the far end.
      const aFirst = alongBridge(bridge, x0, z0).t < 0.5;
      const [p, q] = aFirst ? [bridge.a, bridge.b] : [bridge.b, bridge.a];
      const [ps, qs, pre, post] = deckLane(state, bridge, p, q, lane, x0, z0, x1, z1);
      if (on0 !== bridge) {
        if (pre) for (const a of pre) pushOpen(state, out, route, a.x, a.z);
        else approach(state, out, bridge, ps, qs, x0, z0);
        pushOpen(state, out, route, ps.x, ps.z);
      }
      pushOpen(state, out, route, qs.x, qs.z);
      if (on1 !== bridge) {
        if (post) for (const a of post) pushOpen(state, out, route, a.x, a.z);
        else approach(state, out, bridge, qs, ps, x1, z1);
      }
    } else {
      const touched = on0 ?? on1 ?? deckTouched(state, x0, z0, x1, z1);
      if (touched && !(on0 === touched && on1 === touched)) {
        if (on1 === touched) {
          // Stepping onto a deck: at its nearer end (heading for the other).
          const e = nearerEnd(touched, x0, z0);
          const [es, os] = deckLane(state, touched, e, otherEnd(touched, e), lane, x0, z0, null, null);
          approach(state, out, touched, es, os, x0, z0);
          pushOpen(state, out, route, es.x, es.z);
        } else if (on0 === touched) {
          // Stepping off: at the end nearer where the walker is going.
          const e = nearerEnd(touched, x1, z1);
          const [os, es] = deckLane(state, touched, otherEnd(touched, e), e, lane, null, null, x1, z1);
          pushOpen(state, out, route, es.x, es.z);
          approach(state, out, touched, es, os, x1, z1);
        } else {
          // Only grazing it: round the nearer end.
          const e = nearerEnd(touched, x0, z0);
          approach(state, out, touched, e, otherEnd(touched, e), x0, z0, true);
        }
      }
    }
    pushOpen(state, out, route, x1, z1);
  }
  return out;
}

// Adds a point, first by way of one of the grid route's own waypoints when the
// straight leg there would cut a wall or wade (a dropped turn put back; nearest the
// point first). With no such waypoint the leg stays as it was.
// The waypoints are tried nearest first (the earlier of two as near), so the first that
// works is the one taken.
function pushOpen(state, out, route, x, z) {
  const lx = out[out.length - 2], lz = out[out.length - 1];
  if (legOpen(state, lx, lz, x, z)) { out.push(x, z); return; }
  const m = route.length >> 1;
  const dist = new Float64Array(m), order = [];
  for (let j = 0; j < m; j++) {
    dist[j] = Math.hypot(route[j * 2] - x, route[j * 2 + 1] - z);
    if (dist[j] < Infinity) order.push(j);   // never one at no finite distance
  }
  order.sort((a, b) => dist[a] - dist[b] || a - b);
  for (const j of order) {
    const wx = route[j * 2], wz = route[j * 2 + 1];
    if (legOpen(state, lx, lz, wx, wz) && legOpen(state, wx, wz, x, z)) { out.push(wx, wz); break; }
  }
  out.push(x, z);
}

// The bridge whose deck or verge is under (x, z), or null (sim-world's deck test).
function deckZone(state, x, z) {
  return deckAt(state, x, z)?.bridge ?? null;
}

// The first bridge whose deck or verge a leg passes over, or null. (None when the leg's
// box, and a millionth of a unit for its samples' rounding, misses every deck's box,
// which deckAt tests first.)
function deckTouched(state, x0, z0, x1, z1) {
  if (!nearDeckBox(state, x0, z0, x1, z1)) return null;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.25));
  for (let i = 1; i < steps; i++) {
    const b = deckZone(state, x0 + ((x1 - x0) * i) / steps, z0 + ((z1 - z0) * i) / steps);
    if (b) return b;
  }
  return null;
}

function nearDeckBox(state, x0, z0, x1, z1) {
  const xa = Math.min(x0, x1) - 1e-6, xb = Math.max(x0, x1) + 1e-6, za = Math.min(z0, z1) - 1e-6, zb = Math.max(z0, z1) + 1e-6;
  if (!(xb - xa < Infinity && zb - za < Infinity)) return true;
  for (const d of deckList(state)) if (xb >= d.x0 && xa <= d.x1 && zb >= d.z0 && za <= d.z1) return true;
  return false;
}

function nearerEnd(bridge, x, z) { return alongBridge(bridge, x, z).t < 0.5 ? bridge.a : bridge.b; }
const otherEnd = (bridge, e) => (e === bridge.a ? bridge.b : bridge.a);

// The walker's lane across a deck walked from end p to end q: both ends moved the same
// way, right of the direction of travel, by lane times the deck's walkable half-width
// (to the drawn deck's edge less 0.4; footbridges are drawn 1.3 wide).
// Where a bank meets the deck at an angle, a lane far off the axis would start or end
// over the water: the lane is halved, then given up (the centre line), unless both
// ends can be walked onto dry from DECK_APPROACH beyond them, and from the walker's
// previous point (x0, z0) and to its next (x1, z1) when those are off the deck.
function deckLane(state, bridge, p, q, lane, x0, z0, x1, z1) {
  if (!lane) return [p, q];
  const half = (bridge.style ?? bridge.variant) === 'footbridge' ? 0.65 : Math.min(3, Math.max(1.2, (bridge.width ?? bridge.d ?? 3) / 2));
  // On decks wide enough to stop on, walkers keep RAIL_PASS inside where people stand at
  // the rails to look at the water (gatherings.js railStand), so they pass them.
  const reach = Math.max(0, half >= RAIL_MIN_HALF ? Math.min(half - 0.4, railStand(bridge) - RAIL_PASS) : half - 0.4) * lane;
  const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  for (const f of LANE_TRIES) {
    const nx = uz * reach * f, nz = -ux * reach * f;
    const ps = {x: p.x + nx, z: p.z + nz}, qs = {x: q.x + nx, z: q.z + nz};
    const pre = laneEndPath(state, ps, -ux, -uz, x0, z0);
    if (!pre) continue;
    const post = laneEndPath(state, qs, ux, uz, x1, z1);
    if (!post) continue;
    // The ways on and off: walked bank-side first, then reversed on the far bank.
    return [ps, qs, pre, post.slice().reverse()];
  }
  return [p, q, null, null];
}

// A shifted deck end e can be walked onto dry from (x, z), straight or by way of the
// point DECK_APPROACH beyond it along the axis (outward u); with no such point given
// (the walker is on the deck), that approach point must be open.
// How a walker gets from (x, z) on the bank to lane end e (the deck runs on
// from e along -(ux, uz)): a list of points to walk first ([] for straight
// in), or null if nothing works. Rather than give up on the lane, it looks a
// little: approach points further out along the deck's line, and a sidestep
// before them (shuffling along the bank or a wall) until the walker lines up.
const APPROACH_OUT = [1, 1.6, 2.4];
const APPROACH_SIDE = [0, 0.6, -0.6, 1.2, -1.2];
function laneEndPath(state, e, ux, uz, x, z) {
  if (x != null && !deckZone(state, x, z) && dryLeg(state, x, z, e.x, e.z)) return [];
  const {walls: blocked} = footprints(state);
  const standable = (px, pz) => !waterAt(px, pz) && !deckZone(state, px, pz) && clearOfWalls(state, blocked, px, pz);
  for (const k of APPROACH_OUT) {
    const ax = e.x + ux * DECK_APPROACH * k, az = e.z + uz * DECK_APPROACH * k;
    if (!standable(ax, az) || !dryLeg(state, ax, az, e.x, e.z)) continue;
    if (x == null || deckZone(state, x, z)) return [{x: ax, z: az}];
    for (const side of APPROACH_SIDE) {
      if (!side) {
        if (dryLeg(state, x, z, ax, az)) return [{x: ax, z: az}];
        continue;
      }
      const sx = ax - uz * side, sz = az + ux * side;
      if (standable(sx, sz) && dryLeg(state, x, z, sx, sz) && dryLeg(state, sx, sz, ax, az)) return [{x: sx, z: sz}, {x: ax, z: az}];
    }
  }
  return null;
}

// Clear of walls, and out of the river except on a deck: unlike legOpen, no ford
// allowance (the nav grid counts water by a bridge's abutments as a ford; walking a
// lane beside the abutment there would wade the deep channel).
function dryLeg(state, x0, z0, x1, z1) {
  if (segmentBlocked(state, x0, z0, x1, z1)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.25));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    if (waterAt(x, z) && !deckZone(state, x, z)) return false;
  }
  return true;
}

// Adds the point just off end e along the bridge's axis (o: the other end, in the same
// lane), when (x, z) is beside the deck rather than already beyond that end, and the
// point is dry, open ground the walker can reach from the last point in a straight
// line. always: also when the walker is beyond the end (a leg that only grazes the deck).
function approach(state, out, bridge, e, o, x, z, always = false) {
  const len = Math.hypot(e.x - o.x, e.z - o.z) || 1;
  const t = alongBridge(bridge, x, z).t;
  if (!always && (t < 0 || t > 1)) return;
  const px = e.x + ((e.x - o.x) / len) * DECK_APPROACH, pz = e.z + ((e.z - o.z) / len) * DECK_APPROACH;
  if (waterAt(px, pz) || deckZone(state, px, pz)) return;
  if (!clearOfWalls(state, footprints(state).walls, px, pz)) return;
  const lx = out[out.length - 2], lz = out[out.length - 1];
  if (!legOpen(state, lx, lz, px, pz) || !legOpen(state, px, pz, e.x, e.z)) return;
  out.push(px, pz);
}

// A straight leg clear of walls and of water (except over a deck or its verge).
// Every sample is tested every 0.25 for water and (inside the leg) for drawn pieces;
// the answer is whether all pass, so the pieces, which are cheap to rule out cell by
// cell (roads.js walkerLegOutlined), go first, and the water after, unless the whole
// leg is surely dry (terrain.js dryAlong).
function legOpen(state, x0, z0, x1, z1) {
  if (segmentBlocked(state, x0, z0, x1, z1)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.25));
  if (walkerLegOutlined(footprints(state), x0, z0, x1, z1, steps)) return false;
  if (dryAlong(x0, z0, x1, z1)) return true;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    if (waterAt(x, z) && !deckZone(state, x, z) && !fordCell(state, x, z)) return false;
  }
  return true;
}

// The road grid has roads.js's layout (it always does): its cell tests can be shared.
const gridLaidOut = (r) => r.ox === ORIGIN_X && r.oz === ORIGIN_Z && r.cell === CELL && r.W === GRID_W && r.H === GRID_H;

// A shallow ford cell on the nav grid (walkable water).
function fordCell(state, x, z) {
  const c = cellOf(x, z);
  return c >= 0 && structuralWaterAt(state, c) === 2;
}

// The bridge a leg passes over from one side to the other, if any.
function deckCrossed(state, x0, z0, x1, z1) {
  for (const {bridge} of deckList(state)) {
    const s = alongBridge(bridge, x0, z0), e = alongBridge(bridge, x1, z1);
    const crosses = (s.t < 0.5) !== (e.t < 0.5) && Math.min(s.t, e.t) < 0.9 && Math.max(s.t, e.t) > 0.1;
    if (!crosses) continue;
    // ...and somewhere along it the walker is over the deck.
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0)));
    for (let i = 0; i <= steps; i++) {
      const {t, off} = alongBridge(bridge, x0 + ((x1 - x0) * i) / steps, z0 + ((z1 - z0) * i) / steps);
      if (t >= 0 && t <= 1 && off <= (bridge.width ?? 3) / 2 + 1) return bridge;
    }
  }
  return null;
}

function pathBlocked(state, x, z, route) {
  return !routeClearFrom(state, x, z, route, 0);
}


// Builders head where sim-world says the work is (the street in front, the next
// unfinished road cell) and spread out there by the standing-spot finder.
function projectTarget(state, pr, p) {
  if (!pr) return null;
  const site = projectSite(state, pr);
  if (!site || !Number.isFinite(site.x)) return null;
  return {type: 'project', id: pr.id, x: site.x, z: site.z};
}

// Each walker keeps one workplace among the enterprises of its household's trade.
function workTarget(state, p, h, world) {
  if (!h || h.trade === 'gentry') return null;
  let ent = p.workId != null ? byId(state, 'enterprises', p.workId) : null;
  if (!ent || ent.jobs <= 0) {
    const list = world.workplaces.get(h.trade) ?? world.allWork;
    if (!list.length) return null;
    let total = 0;
    for (const e of list) total += e.jobs;
    let x = hashUnit(p.id * 7 + state.time.year) * total;
    ent = list[list.length - 1];
    for (const e of list) if ((x -= e.jobs) < 0) { ent = e; break; }
    p.workId = ent.id;
  }
  const b = byId(state, 'buildings', ent.buildingId);
  if (!b) return null;
  const target = buildingTarget(state, b);
  if (b.type === 'farm') farmRows(state, p, b, target);
  return target;
}

// Farm work happens out in the field: walk to the gate, then step into the rows (a
// spot there is found on arrival like any other).
function farmRows(state, p, b, target) {
  const u = hashUnit(p.id * 3 + p.rev) - 0.5, v = hashUnit(p.id * 5 + p.rev) - 0.5;
  const tail = [b.x + u * (b.w - 1), b.z + v * (b.d - 1)];
  // Only if the step from the gate stays on open ground (a farmhouse may stand there).
  if (!segmentBlocked(state, target.x, target.z, tail[0], tail[1])) target.tail = tail;
}

// One of the k nearest buildings of the given types, the quietest by the walker's
// taste (pickQuiet).
const nearScratch = [];
function nearestOf(state, world, types, p, k, h) {
  nearScratch.length = 0;
  const near = typeGrid(world, types);
  if (!near || !nearestByGrid(near, p, k)) {
    nearScratch.length = 0;
    for (const t of types) {
      const list = world.byType.get(t);
      if (!list) continue;
      for (const b of list) {
        const d = (b.x - p.x) ** 2 + (b.z - p.z) ** 2;
        if (nearScratch.length < k) nearScratch.push({b, d});
        else {
          let worst = 0;
          for (let i = 1; i < nearScratch.length; i++) if (nearScratch[i].d > nearScratch[worst].d) worst = i;
          if (d < nearScratch[worst].d) nearScratch[worst] = {b, d};
        }
      }
    }
  }
  if (!nearScratch.length) return null;
  return buildingTarget(state, pickQuiet(state, p, nearScratch, crowdTolerance(p, h)));
}

// The buildings of these types as a grid (null when so few that a scan is as quick),
// kept with the world index.
function typeGrid(world, types) {
  const key = types.join();
  const grids = (world.grids ??= new Map());
  if (grids.has(key)) return grids.get(key);
  const list = types.flatMap((t) => world.byType.get(t) ?? []);
  const near = list.length > NEAR_SCAN ? {list, grid: pointGrid(list.map((b) => b.x), list.map((b) => b.z), list.length, 32)} : null;
  grids.set(key, near);
  return near;
}

// nearestOf's k nearest by the grid, into nearScratch. The scan keeps the k smallest
// distances, and which of several buildings at the k-th distance it keeps depends on
// the order it met them: when there is such a tie this gives up (false), and the scan
// decides. Otherwise the k are the same buildings (pickQuiet does not care in what order).
function nearestByGrid(near, p, k) {
  const {list, grid} = near;
  const all = [];
  let worstD = -1;
  ringSearch(grid, p.x, p.z, (i) => {
    const b = list[i];
    const d = (b.x - p.x) ** 2 + (b.z - p.z) ** 2;
    all.push(d);
    if (nearScratch.length < k) {
      nearScratch.push({b, d});
      if (nearScratch.length === k) worstD = Math.max(...nearScratch.map((c) => c.d));
    } else if (d < worstD) {
      let worst = 0;
      for (let j = 1; j < k; j++) if (nearScratch[j].d > nearScratch[worst].d) worst = j;
      nearScratch[worst] = {b, d};
      worstD = -1;
      for (let j = 0; j < k; j++) if (nearScratch[j].d > worstD) worstD = nearScratch[j].d;
    }
  }, (bound2) => nearScratch.length === k && worstD < bound2);
  if (nearScratch.length < k) return true;
  let within = 0;
  for (const d of all) if (d <= worstD) within++;
  return within === k;
}

// Crowd-aware choice. Each candidate scores its distance, a stable per-walker taste
// (up to PICK_SPREAD units, so not everyone goes to the nearest), and a crowd
// penalty weighted by how little the walker likes crowds. Lowest score wins (ties:
// the lower building id). Gatherings never come here: they pull people in on purpose.
const PICK_SPREAD = 40;
const CROWD_COST = 10;                     // units of extra walk per walker-per-block of density, at zero tolerance
                                           // (a quiet street reads about 1, a busy centre 15-20)
const SEAT_FULL = 8;                       // a building with every seat taken counts as this many
const TRADE_TOLERANCE = {trade: 0.15, labour: 0.05, craft: 0, none: 0, farm: -0.1, gentry: -0.2};

// 0 (always the quiet one) .. 1 (doesn't mind a crush): a hash of the walker's id,
// nudged by its household's trade.
export function crowdTolerance(p, h) {
  const t = hashUnit(p.id * 61 + 5) + (TRADE_TOLERANCE[h?.trade] ?? 0);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// How busy a building is this tick: the walker density round its door (density.js,
// walkers per 8-unit block, smoothed), plus, for a building with seats, the share of
// its seats taken (SEAT_FULL when all are).
export function crowdAt(state, b) {
  const door = accessPoint(b, state);
  let crowd = densityAt(state, door.x, door.z);
  if (b.type === 'park' || LEISURE_TYPES.includes(b.type)) {
    let n = scratch.seatCount.get(b.id);
    if (n == null) { n = seatsOf(b).length; scratch.seatCount.set(b.id, n); }
    if (n > 0) crowd += ((scratch.seatsTaken.get(b.id) ?? 0) / n) * SEAT_FULL;
  }
  return crowd;
}

// cands: [{b, d}] with d the squared distance from the walker.
export function pickQuiet(state, p, cands, tol) {
  const w = CROWD_COST * (1 - tol) * (1 - tol);
  let best = null, bestS = Infinity;
  for (const {b, d} of cands) {
    let score = Math.sqrt(d) + hashUnit(p.id * 131 + p.rev * 7 + b.id * 3) * PICK_SPREAD;
    if (w > 0) score += w * crowdAt(state, b);
    if (score < bestS || (score === bestS && b.id < best.id)) { best = b; bestS = score; }
  }
  return best;
}

// A stroll ends somewhere a walker can stand: not in the water, on a bridge deck,
// or inside a building's walls (its plinth, steps or wings). Strolls in a crowded
// quarter used to end inside a house, and the last step crossed its plinth.
function strollTarget(state, p) {
  const a0 = hashUnit(p.id * 13 + p.rev) * Math.PI * 2;
  const r = 6 + hashUnit(p.id * 29 + p.rev) * 14;
  const {walls} = footprints(state);
  for (let k = 0; k < 8; k++) {
    const a = a0 + k * GOLDEN;
    for (const s of [1, -1]) {
      const x = p.x + s * Math.cos(a) * r, z = p.z + s * Math.sin(a) * r;
      if (standable(state, walls, x, z)) return {type: 'point', id: null, x, z};
    }
  }
  return {type: 'point', id: null, x: p.x, z: p.z};
}

function nearEvent(state, p, kinds) {
  const month = monthIndex(state.time);
  for (const ev of state.worldEvents) {
    if (!kinds.includes(ev.kind) || (ev.t1 != null && ev.t1 < month)) continue;
    const r = (ev.radius ?? 10) * 1.5;
    if ((ev.x - p.x) ** 2 + (ev.z - p.z) ** 2 < r * r) return ev;
  }
  return null;
}

const GATHER_KINDS = ['market', 'festival', 'protest', 'wedding', 'funeral', 'strike', 'procession'];
function gatherTarget(state, p) {
  const month = monthIndex(state.time);
  for (const ev of state.worldEvents) {
    if (!GATHER_KINDS.includes(ev.kind) || (ev.t1 != null && ev.t1 < month)) continue;
    const reach = (ev.radius ?? 10) * 8 + 40 * (ev.strength ?? 0.5);
    if ((ev.x - p.x) ** 2 + (ev.z - p.z) ** 2 > reach * reach) continue;
    if (hashUnit(p.id * 11 + ev.id) > (ev.strength ?? 0.5)) continue;
    const a = hashUnit(p.id * 19) * Math.PI * 2, r = hashUnit(p.id * 23) * (ev.radius ?? 6);
    return {type: 'event', id: ev.id, x: ev.x + Math.cos(a) * r, z: ev.z + Math.sin(a) * r, eventKind: ev.kind};
  }
  return null;
}

// Tools and tests: send a walker to a building now, as chooseTask would.
export function sendWalker(state, p, kind, b, ctx = {}) {
  startTask(state, ctx, p, kind, buildingTarget(state, b), simTime(state));
  return p.task;
}

// Tools and tests: send a walker on a leisure outing (leisure.js outingFor) now.
export function goOut(state, p, target, ctx = {}) {
  startTask(state, ctx, p, 'leisure', target, simTime(state));
  return p.task;
}

// Tools and tests: send a walker to a gathering (a world event) now.
export function joinGathering(state, p, ev, ctx = {}) {
  startTask(state, ctx, p, 'gather', {type: 'event', id: ev.id, x: ev.x, z: ev.z, eventKind: ev.kind}, simTime(state));
  return p.task;
}

// keep: carried over when a full goal is relaxed ({relax, avoid, dwellFor}).
function startTask(state, ctx, p, kind, target, now, keep = null) {
  if (!target) {
    p.task = null;
    return;
  }
  const [lo, hi] = DWELL[kind] ?? [8, 14];
  openGround(state, target);
  p.task = {
    kind,
    targetId: target.id,
    targetType: target.type,
    eventKind: target.eventKind ?? null,
    tx: target.x,
    tz: target.z,
    tail: target.tail ?? null,
    seat: target.seat ?? null,
    route: new Float32Array(0),
    seg: 0,
    elapsed: 0,
    dwell: 0,
    dwellFor: keep?.dwellFor ?? lo + rng(state, 'people') * (hi - lo),
    waiting: true,
    retryAt: now,
    started: now,
    spot: null,
  };
  if (keep?.relax) p.task.relax = keep.relax;
  if (keep?.avoid) p.task.avoid = keep.avoid;
  // A leisure outing (leisure.js): its activity, and how long it lasts.
  if (target.activity) {
    p.task.activity = target.activity;
    if (target.outing) p.task.outing = 1;
    const span = ACTIVITIES[target.activity]?.dwell;
    if (span && !keep?.dwellFor) p.task.dwellFor = span[0] + hashUnit((p.id * 389 + Math.floor(now * 10)) >>> 0) * (span[1] - span[0]);
  }
  if (!p.task.seat) planGathering(state, p, p.task);
  requestRoute(state, ctx, p, p.task, now);
}

// ---------------------------------------------------------------------------
// Routes
//
// services.routes (sim-world) must provide:
//   plan(state, x0, z0, x1, z1, onRoute) -> boolean   // false = busy, ask again later
//   onRoute(route: number[] | Float32Array | null)    // flat [x, z, ...], may be called synchronously
// A null route means unreachable; the walker uses the fallback path.

// A stroll point can be built over while its walker waits for a route (a new lot
// goes down on it). Pick another before routing there.
function strollStillOpen(state, p, task) {
  if (task.targetType !== 'point' || standable(state, footprints(state).walls, task.tx, task.tz)) return true;
  p.rev++;
  const next = strollTarget(state, p);
  task.tx = next.x;
  task.tz = next.z;
  return false;
}

function requestRoute(state, ctx, p, task, now) {
  if (task.claim && task.spot) checkClaim(state, task);
  strollStillOpen(state, p, task);
  const planner = ctx?.services?.routes;
  if (planner?.plan) {
    task.waiting = true;
    task.retryAt = now + ROUTE_RETRY;
    halt(p);
    const accepted = planner.plan(state, p.x, p.z, task.tx, task.tz, (route) => {
      inFlight.delete(task);
      task.awaitingPlanner = false;
      if (p.task !== task) return;
      // A route through a footprint that appeared since the planner's grid was built:
      // ask again in a moment (the grid catches up within a few ticks).
      if (route && route.length >= 2 && pathBlocked(state, p.x, p.z, route)) {
        replan(p, simTime(state), 1);
        return;
      }
      // Its stroll point was built over while the planner worked: ask again (for another point).
      if (task.targetType === 'point' && !standable(state, footprints(state).walls, task.tx, task.tz)) {
        replan(p, simTime(state), 1);
        return;
      }
      // Unreachable: stay put for this task rather than walking through walls.
      setRoute(state, p, task, route && route.length >= 2 ? route : [], route && route.length >= 2);
    });
    if (accepted && task.waiting) {
      task.retryAt = now + 30;   // a lost answer is retried eventually
      task.awaitingPlanner = true;
      inFlight.add(task);
    }
    return;
  }
  // No planner (headless, or before it exists): a synchronous A*, a few per tick; the
  // rest wait their turn. Never a straight line across water or walls.
  if (scratch.syncRoutes <= 0) {
    task.waiting = true;
    task.retryAt = now + 0.5;
    halt(p);
    return;
  }
  scratch.syncRoutes--;
  const route = syncRoute(state, p.x, p.z, task.tx, task.tz);
  setRoute(state, p, task, route && route.length >= 2 ? route : [], !!route);
}

// A* over sim-world's structural grid: a pure function of the saved state (no wear
// sampled at an arbitrary moment), so a restored town plans exactly the same routes.
function syncRoute(state, x0, z0, x1, z1) {
  const grid = walkerGrid(state);
  const result = findRoute(grid, cellOf(x0, z0), cellOf(x1, z1), {maxNodes: 20000});
  for (const band of result.crossings ?? []) recordCrossingBand(state, band);
  return result.cells ? cellsToWaypoints(grid, result.cells, {x: x0, z: z0}, {x: x1, z: z1}) : null;
}

function setRoute(state, p, task, route, reachable = true) {
  // A copy: planner routes are shared through its cache. Each walker keeps to its own
  // side of the path's centre line.
  // Last, legs that cut the corner of a drawn plinth, step or wing go round it.
  const walk = skirtOutlines(state, roundRoute(state, laneOffset(state, p.id, alongDecks(state, Array.from(route), laneFraction(p.id)))), deckKeep(state));
  // A gathering's claimed spot is where this route goes (given up if it cannot be reached).
  if (task.claim && !reachable) task.claim = 0;
  if (!task.claim) task.spot = null;
  // The last step off the street (into a field) is checked again: something may have
  // been built there since the task began.
  const n = walk.length;
  if (task.tail && reachable && n >= 2 && !segmentBlocked(state, walk[n - 2], walk[n - 1], task.tail[0], task.tail[1])) {
    walk.push(task.tail[0], task.tail[1]);
  }
  task.route = toRoute(walk);
  task.seg = 0;
  task.waiting = false;
}

// Side offset. Walkers sharing a cached route would walk one centre line in single
// file; each keeps a stable lane instead: a fraction in [-1, 1] from a hash of its id
// (laneFraction, uniform, so a crowd fills the path evenly) of the path's reach, its
// drawn half-width less half a walker and a little (render/paths.js widths), right of
// its direction of travel. Interior waypoints move perpendicular to the local
// direction (along the bisector at corners); the first and last points stay. A point
// that would meet a wall or water at its full offset tries half; failing that, it
// stays. Points on or by a bridge deck are left alone here: alongDecks has already
// put the walker's lane across the deck. Edits the route in place and returns it.
const LANE_EDGE = 0.3;            // centre of a walker this far inside the drawn edge
const GRASS_REACH = 0.45;         // open ground: no drawn edge, a modest spread
const PLANNED_HALF = 1.08;        // render/paths.js: planned cells are at least this wide
const TOW_HALF = [0, 1.0, 1.1, 1.2, 1.35, 1.45];   // render/paths.js towpath lanes (not exported there)
const DECK_KEEP = 2.6;            // no offset this near a bridge end (DECK_APPROACH + 1)

export const laneFraction = (id) => hashUnit(id * 41 + 3) * 2 - 1;

// How far either side of a waypoint in cell c a walker may keep: the drawn half-width
// there (towpath lane, planned fill, or tier and wear) less LANE_EDGE.
export function laneReach(state, c, x, z) {
  const r = state.roads;
  const t = r.tier[c];
  if (!t) return GRASS_REACH;
  let half;
  if (r.planned && r.planned[c] & FLAG.TOWPATH && Math.abs(bankDistance(x, z) - 3.5) < 4.5) half = TOW_HALF[t];
  else {
    half = halfWidth(t, wearBucket(t, r.wear[c]));
    if (r.planned && r.planned[c] & FLAG.PLANNED) half = Math.max(half, PLANNED_HALF);
  }
  return Math.max(0, half - LANE_EDGE);
}

export function laneOffset(state, id, route) {
  const n = route.length;
  if (n < 6) return route;
  const lane = laneFraction(id);
  if (Math.abs(lane) < 0.02) return route;
  const decks = deckList(state);
  const {walls: blocked} = footprints(state);
  // 1. Each interior point's wanted offset (magnitude; the side is the lane's sign)
  // and the direction to push it (the corner's bisector, mitred).
  const m = n / 2;
  const want = new Float64Array(m), side = new Float64Array(m * 2), tan = new Float64Array(m * 2), seg = new Float64Array(m);
  for (let i = 1; i < m; i++) seg[i] = Math.hypot(route[i * 2] - route[i * 2 - 2], route[i * 2 + 1] - route[i * 2 - 1]);
  for (let i = 1; i < m - 1; i++) {
    const k = i * 2, x = route[k], z = route[k + 1];
    const ax = x - route[k - 2], az = z - route[k - 1], bx = route[k + 2] - x, bz = route[k + 3] - z;
    const la = seg[i], lb = seg[i + 1];
    if (la < 1e-6 || lb < 1e-6) continue;
    let tx = ax / la + bx / lb, tz = az / la + bz / lb;
    const lt = Math.hypot(tx, tz);
    if (lt < 0.3) continue;                     // a near U-turn: leave it
    tx /= lt;
    tz /= lt;
    const c = cellIndex(state.roads, x, z);
    if (c < 0 || waterAt(x, z)) continue;
    // On or by a deck: alongDecks already put it in this walker's deck lane.
    if (decks.length && (deckAt(state, x, z) || decks.some(({bridge}) => Math.hypot(bridge.a.x - x, bridge.a.z - z) < DECK_KEEP || Math.hypot(bridge.b.x - x, bridge.b.z - z) < DECK_KEEP))) { want[i] = NaN; continue; }
    // Miter: the offset at a corner is longer so both legs keep the same lateral gap.
    const miter = Math.min(1.4, 1 / Math.max(0.2, (ax * tx + az * tz) / la));
    want[i] = Math.abs(lane) * laneReach(state, c, x, z) * miter;
    side[i * 2] = tz * Math.sign(lane); side[i * 2 + 1] = -tx * Math.sign(lane);
    tan[i * 2] = tx; tan[i * 2 + 1] = tz;
  }
  // 2. The offset changes only gradually along the route: no sideways jump where
  // the path changes width, and a ramp in from the start and out at the end.
  // (Points fixed in a deck lane, NaN, are passed over: they are in lane already.)
  const ease = (v) => {
    let last = v[0], run = 0;
    for (let i = 1; i < m; i++) {
      run += seg[i];
      if (Number.isNaN(v[i])) continue;
      v[i] = Math.min(v[i], last + LANE_RATE * run);
      last = v[i]; run = 0;
    }
    last = v[m - 1]; run = 0;
    for (let i = m - 2; i >= 0; i--) {
      run += seg[i + 1];
      if (Number.isNaN(v[i])) continue;
      v[i] = Math.min(v[i], last + LANE_RATE * run);
      last = v[i]; run = 0;
    }
  };
  want[0] = 0;
  want[m - 1] = 0;
  // 3. Apply, sliding along a wall before giving any up; a point that cannot take
  // its share pins it lower, and the ramp is eased again round it.
  const base = Float64Array.from(route);
  for (let round = 0; round < 3; round++) {
    ease(want);
    let pinned = false;
    for (let i = 1; i < m - 1; i++) {
      const k = i * 2, x = base[k], z = base[k + 1];
      route[k] = x;
      route[k + 1] = z;
      if (Number.isNaN(want[i]) || want[i] < 0.01) continue;
      let got = 0;
      for (const f of LANE_TRIES) {
        for (const slide of LANE_SLIDES) {
          const d = want[i] * f;
          const sx = x + side[i * 2] * d + tan[i * 2] * slide, sz = z + side[i * 2 + 1] * d + tan[i * 2 + 1] * slide;
          if (!laneOpen(state, decks, blocked, x, z, sx, sz, route[k - 2], route[k - 1], base[k + 2], base[k + 3])) continue;
          route[k] = sx;
          route[k + 1] = sz;
          got = d;
          break;
        }
        if (got) break;
      }
      if (got < want[i] - 1e-9) { want[i] = got; pinned = true; }
    }
    if (!pinned) break;
  }
  return route;
}

// Corner cutting (Chaikin) over a walker's route, so it walks curves instead
// of swivelling at every waypoint. A corner is cut only where the cut stays on
// open, dry ground off any deck; elsewhere (walls, water, deck lanes, the ends)
// the original point is kept.
const ROUND_PASSES = 2;
const ROUND_CUT = 0.25;     // share of each leg cut away at a corner
const ROUND_MAX = 1.2;      // and never more than this far (units)
const ROUND_MIN_TURN = 0.1; // radians: straighter than this is left alone
export function roundRoute(state, route) {
  let r = route;
  const {walls: blocked} = footprints(state);
  for (let pass = 0; pass < ROUND_PASSES; pass++) {
    if (r.length < 6 || r.length > 800) break;
    const out = [r[0], r[1]];
    for (let k = 2; k + 3 < r.length; k += 2) {
      const x = r[k], z = r[k + 1];
      const px = r[k - 2], pz = r[k - 1], nx = r[k + 2], nz = r[k + 3];
      const la = Math.hypot(x - px, z - pz), lb = Math.hypot(nx - x, nz - z);
      const turn = la > 1e-6 && lb > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, ((x - px) * (nx - x) + (z - pz) * (nz - z)) / (la * lb)))) : 0;
      if (turn < ROUND_MIN_TURN || waterAt(x, z) || deckZone(state, x, z)) { out.push(x, z); continue; }
      const ca = Math.min(ROUND_CUT * la, ROUND_MAX) / la, cb = Math.min(ROUND_CUT * lb, ROUND_MAX) / lb;
      const qx = x + (px - x) * ca, qz = z + (pz - z) * ca, rx = x + (nx - x) * cb, rz = z + (nz - z) * cb;
      const lx = out[out.length - 2], lz = out[out.length - 1];
      const ok = [[qx, qz], [rx, rz]].every(([ux, uz]) => !waterAt(ux, uz) && !deckZone(state, ux, uz) && clearOfWalls(state, blocked, ux, uz)) &&
        legOpen(state, lx, lz, qx, qz) && legOpen(state, qx, qz, rx, rz) && legOpen(state, rx, rz, nx, nz) &&
        routeStillValid(state, [lx, lz, qx, qz, rx, rz, nx, nz], 0);
      if (ok) out.push(qx, qz, rx, rz);
      else out.push(x, z);
    }
    out.push(r[r.length - 2], r[r.length - 1]);
    r = out;
  }
  return r;
}
const LANE_TRIES = [1, 0.75, 0.5];
// How fast a walker's lane offset may change along its route (units per unit walked).
const LANE_RATE = 0.3;
// Slides along the route (in units) tried for a blocked lane point before its
// offset is reduced: a walker shuffles along a wall rather than give up its lane.
const LANE_SLIDES = [0, 0.3, -0.3, 0.6, -0.6];

// (px, pz) is the previous point as already offset; (nx, nz) the next as planned.
function laneOpen(state, decks, blocked, x, z, sx, sz, px, pz, nx, nz) {
  if (!clearOfWalls(state, blocked, sx, sz) || waterAt(sx, sz)) return false;
  if (decks.length) {
    for (const {bridge} of decks) {
      if (Math.hypot(bridge.a.x - x, bridge.a.z - z) < DECK_KEEP || Math.hypot(bridge.b.x - x, bridge.b.z - z) < DECK_KEEP) return false;
    }
    if (deckAt(state, x, z) || deckAt(state, sx, sz)) return false;
  }
  return laneLeg(state, decks, px, pz, sx, sz) && laneLeg(state, decks, sx, sz, nx, nz) && routeStillValid(state, [px, pz, sx, sz, nx, nz], 0);
}

// A leg of an offset route: off every deck and verge, and out of the water except at
// a ford (walls are checked exactly by routeStillValid).
function laneLeg(state, decks, x0, z0, x1, z1) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  // Well back from the river (it bends gently), the leg cannot reach the water; away
  // from every deck's bounding box, it cannot touch a deck.
  const wet = !dryAlong(x0, z0, x1, z1) && bankDistance(x0, z0) < 3 * len + 1;
  const lx0 = Math.min(x0, x1), lx1 = Math.max(x0, x1), lz0 = Math.min(z0, z1), lz1 = Math.max(z0, z1);
  let near = false;
  for (const d of decks) if (lx1 >= d.x0 && lx0 <= d.x1 && lz1 >= d.z0 && lz0 <= d.z1) { near = true; break; }
  if (!near && !wet) return true;
  const steps = Math.max(1, Math.ceil(len / 0.4));
  for (let i = 1; i < steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps, z = z0 + ((z1 - z0) * i) / steps;
    if (near && deckAt(state, x, z)) return false;
    if (wet && waterAt(x, z) && !fordCell(state, x, z)) return false;
  }
  return true;
}

// Straight line, or via the nearest crossing when the walk crosses the river. Without
// any crossing the walker goes to its own bank opposite the goal and turns back.
export function fallbackRoute(state, x0, z0, x1, z1) {
  const west0 = x0 < riverX(z0), west1 = x1 < riverX(z1);
  if (west0 === west1 || !hasRiver()) return [x1, z1];
  const crossings = crossingsOf(state);
  if (!crossings.length) return [riverX(z1) + (west0 ? -9 : 9), z1];
  let best = crossings[0], bestCost = Infinity;
  for (const c of crossings) {
    const cost = Math.abs(z0 - c.z) + Math.abs(z1 - c.z);
    if (cost < bestCost) { best = c; bestCost = cost; }
  }
  const rx = riverX(best.z);
  const a = west0 ? -best.half : best.half;
  return [rx + a, best.z, rx - a, best.z, x1, z1];
}

let crossingCache = null;
function crossingsOf(state) {
  const key = `${state.roads.version}:${state.buildingsRev}`;
  if (crossingCache?.state === state && crossingCache.key === key) return crossingCache.list;
  const list = [];
  for (const b of state.buildings) if (b.type === 'bridge' && b.built >= 1) list.push({z: b.z, half: Math.max(7, (b.w ?? 14) / 2 + 1)});
  // Fords as the terrain defines them for this valley.
  for (const f of FORDS) list.push({z: f.z, half: 9});
  crossingCache = {state, key, list};
  return list;
}

// Height of a walker's feet: the bridge deck, the ford bed, or the ground.
export function walkerY(state, x, z) {
  const deck = deckAt(state, x, z);
  if (deck) return deckSurfaceY(deck.bridge, deck.t, deck.off, x, z);
  const h = heightAt(x, z);
  return h < -0.3 ? -0.3 : h;
}

// The finished bridge whose deck is under (x, z), with how far along it the point is,
// or null. Finished bridges are cached with their bounding boxes.
const bridgeCache = new WeakMap();

// Finished bridges with their padded bounding boxes ({bridge, x0, x1, z0, z1}), cached.
export const bridgeDecks = (state) => deckList(state);

function deckList(state) {
  let entry = bridgeCache.get(state);
  if (!entry || entry.rev !== state.buildingsRev || entry.count !== state.buildings.length) {
    const list = state.buildings.filter((b) => b.type === 'bridge' && b.a && b.b && (b.built ?? 1) >= 1).map((bridge) => {
      const pad = (bridge.width ?? bridge.d ?? 3) / 2 + 1;
      return {bridge, x0: Math.min(bridge.a.x, bridge.b.x) - pad, x1: Math.max(bridge.a.x, bridge.b.x) + pad, z0: Math.min(bridge.a.z, bridge.b.z) - pad, z1: Math.max(bridge.a.z, bridge.b.z) + pad};
    });
    entry = {rev: state.buildingsRev, count: state.buildings.length, list};
    bridgeCache.set(state, entry);
  }
  return entry.list;
}

export function deckAt(state, x, z) {
  for (const {bridge, x0, x1, z0, z1} of deckList(state)) {
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    const {t, off} = alongBridge(bridge, x, z);
    // The same test as sim-world's deckHeightAt, so walkers and the drawn deck agree.
    if (t >= 0 && t <= 1 && off <= (bridge.width ?? bridge.d ?? 3) / 2 + DECK_VERGE) return {bridge, t, off};
  }
  return null;
}

// Kept for older readers: decks now have their own heights (sim-world's deckProfile).
export const BRIDGE_DECK = 0.62;

// Walking pace over a bridge by its style: planks are narrow, stone and iron are broad.
const DECK_SPEED = {footbridge: 1.1, timber: 1.5, stone: 1.75, iron: 1.75};

// For tests (tests/route-delivery-equivalence.test.js).
export const __test = {legOpen, pushOpen};
