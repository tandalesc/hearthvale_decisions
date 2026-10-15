// Visible walkers. Up to state.settings.individualCap people are simulated one by
// one: needs, tasks, routes and movement. Everyone else lives only as a household
// count. syncIndividuals() promotes and demotes walkers as the population changes.
//
// Movement runs every tick with dt = 0.1 s. A walker moves along a flat route
// [x0, z0, x1, z1, ...] at a speed set by the road tier underneath. Whenever the
// velocity or the visible action changes, p.rev is bumped so the render view
// rewrites that walker's row; otherwise the renderer extrapolates from velocity.
//
// Routes come from services.routes (sim-world's planner, see planRoute below) or,
// without a planner, from a straight-line fallback that crosses the river at the
// nearest ford or bridge.

import {heightAt, riverX, waterAt, FORDS} from '../terrain.js';
import {rng, hash32, hashUnit} from './rng.js';
import {decide, findHook} from './hooks.js';
import {byId, cellIndex, lookFor, nextId, BRIDGE} from './state.js';
import {monthIndex} from './clock.js';
import {doorPoint, frontCell, cellCenter, footprints, footprintKey, nearestOpen, routeStillValid, structuralGrid, cellOf, recordCrossingBand} from './roads.js';
import {findRoute, cellsToWaypoints} from '../navigation.js';
import {projectSite} from './buildings.js';
import {alongBridge, deckSurfaceY, DECK_VERGE} from './bridges.js';

export const ACTION = {none: 0, carry: 1, build: 2, sit: 3, cheer: 4, protest: 5, dance: 6};
export const TASK_KINDS = ['work', 'rest', 'shop', 'leisure', 'worship', 'gather', 'build', 'flee', 'travel'];

const WALK_SPEED = 1.4;                                  // units per sim second on grass
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
  const door = home ? accessPoint(home) : {x: 0, z: 0};
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

// Keep min(cap, pop) walkers, spread over households in proportion to their size.
export function syncIndividuals(state) {
  const cap = Math.max(0, state.settings.individualCap | 0);
  const households = state.households.filter((h) => h.homeId != null);
  const pop = households.reduce((n, h) => n + h.size, 0);
  const target = Math.min(cap, pop);
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
  for (const pr of open) {
    const site = projectSite(state, pr);
    if (!site || !Number.isFinite(site.x)) continue;
    const want = Math.min(6, 2 + Math.floor((pr.workRequired ?? 30) / 40));
    while (pr.workers.length < want && candidates.length) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const d = (c.x - site.x) ** 2 + (c.z - site.z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      const [p] = candidates.splice(best, 1);
      pr.workers.push(p.id);
      assigned.add(p.id);
    }
  }
}

// ---------------------------------------------------------------------------
// The tick

// Reused per tick so the hot loop allocates nothing.
const SYNC_ROUTES_PER_TICK = 4;
const inFlight = new WeakSet();   // tasks with a planner request out (transient)
const scratch = {projectsById: new Map(), workerProject: new Map(), onSite: new Map(), syncRoutes: SYNC_ROUTES_PER_TICK};

export function stepPeople(state, ctx, dt) {
  const people = state.people;
  if (!people.length) return;
  const now = simTime(state);
  indexProjects(state);
  scratch.syncRoutes = SYNC_ROUTES_PER_TICK;
  const world = worldIndex(state);
  checkFootprints(state, now);
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
    if (task.seg < task.route.length) move(state, p, task, dt, now);
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

function move(state, p, task, dt, now) {
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
  if (task.seg >= route.length) arrive(state, p, task, now);
}

// Bridge decks arch and ramp: while on one, the render row is renewed every
// DECK_STEP units so the drawn height keeps to the deck (ramps curve fast).
export const DECK_STEP = 0.4;

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
  state.roads.wearAddedMonth = (state.roads.wearAddedMonth ?? 0) + amount;
}

function arrive(state, p, task, now) {
  p.vx = 0;
  p.vz = 0;
  p.speed = 0;
  const target = task.targetType === 'building' ? byId(state, 'buildings', task.targetId) : null;
  p.indoor = INDOOR.has(task.kind) && !!target && !(task.kind === 'work' && OUTDOOR_WORK.has(target.type));
  setAction(p, dwellAction(state, p, task, target), now);
  p.rev++;
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
  if (danger && home) return startTask(state, ctx, p, 'flee', buildingTarget(home), now);

  const targets = {
    work: workTarget(state, p, h, world),
    rest: home ? buildingTarget(home) : null,
    shop: nearestOf(world, SHOP_TYPES, p, 3),
    leisure: nearestOf(world, LEISURE_TYPES, p, 4) ?? strollTarget(state, p),
    worship: nearestOf(world, ['chapel'], p, 2),
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
  startTask(state, ctx, p, kind, targets[kind], now);
}

// Walkers head for the street cell in front of the door (shared by everyone going in,
// so the route cache and flow fields can serve them all) and "go in" there: indoor
// walkers are hidden, they never walk into the footprint.
function buildingTarget(b) {
  const door = accessPoint(b);
  return {type: 'building', id: b.id, x: door.x, z: door.z, building: b};
}

export function accessPoint(b) {
  const front = frontCell(b);
  return front >= 0 ? cellCenter(front) : doorPoint(b);
}

// When buildings appear or change, walkers standing inside a new footprint step out to
// the nearest open cell, and routes that now cross one are planned again.
// The last footprint key walkers were checked against is kept in the state, so a
// restored town behaves exactly like the original.
function checkFootprints(state, now) {
  checkDecks(state);
  const key = footprintKey(state);
  if (state.walkerFootprintKey === key) return;
  const first = state.walkerFootprintKey == null;
  state.walkerFootprintKey = key;
  const {blocked} = footprints(state);
  const roads = state.roads;
  for (const p of state.people) {
    const c = cellIndex(roads, p.x, p.z);
    if (c >= 0 && blocked[c]) {
      const open = nearestOpen(state, c, 8);
      if (open >= 0) {
        const at = cellCenter(open);
        p.x = at.x;
        p.z = at.z;
        p.cell = open;
        p.rev++;
      }
      if (p.task) replan(p, now);
      continue;
    }
    if (!first && p.task && !p.task.waiting && !routeStillValid(state, [p.x, p.z, ...p.task.route.slice(p.task.seg)], 0)) replan(p, now);
  }
}

// Goals inside a footprint or in the river (a crowd spot on a roof or by a flood, a
// stroll into a wall) move to the nearest open dry cell; the farm-field step stays where
// it is (fields are open ground).
function openGround(state, target) {
  const c = cellIndex(state.roads, target.x, target.z);
  if (c < 0 || !(footprints(state).blocked[c] || (waterAt(target.x, target.z) && !deckAt(state, target.x, target.z)))) return;
  const open = nearestOpen(state, c, 8);
  if (open < 0) return;
  const at = cellCenter(open);
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
  const {blocked} = footprints(state);
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 2);
  for (let i = 0; i <= steps; i++) {
    const c = cellIndex(state.roads, x0 + ((x1 - x0) * i) / steps, z0 + ((z1 - z0) * i) / steps);
    if (c >= 0 && blocked[c]) return true;
  }
  return false;
}

// Walkers cross a bridge along its centre line: where a leg of the route goes over a
// deck, the deck's two ends are put in between (the end on the walker's side first).
function alongDecks(state, route) {
  if (route.length < 4 || !deckList(state).length) return route;
  const out = [route[0], route[1]];
  for (let k = 2; k + 1 < route.length; k += 2) {
    const x0 = out[out.length - 2], z0 = out[out.length - 1], x1 = route[k], z1 = route[k + 1];
    const bridge = deckCrossed(state, x0, z0, x1, z1);
    if (bridge) {
      // Enter at the end on the walker's side of the river (t < 0.5 is the a side).
      const aFirst = alongBridge(bridge, x0, z0).t < 0.5;
      const [p, q] = aFirst ? [bridge.a, bridge.b] : [bridge.b, bridge.a];
      out.push(p.x, p.z, q.x, q.z);
    }
    out.push(x1, z1);
  }
  return out;
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
  return !routeStillValid(state, [x, z, ...route], 0);
}


// Builders stand where sim-world says the work is (the street in front, the next
// unfinished road cell), spread a little so they don't stack.
function projectTarget(state, pr, p) {
  if (!pr) return null;
  const site = projectSite(state, pr);
  if (!site || !Number.isFinite(site.x)) return null;
  const a = hashUnit(p.id * 17) * Math.PI * 2;
  return {type: 'project', id: pr.id, x: site.x, z: site.z, tail: [site.x + Math.cos(a) * 0.8, site.z + Math.sin(a) * 0.8]};
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
  const target = buildingTarget(b);
  if (b.type === 'farm') {
    // Farm work happens out in the field: walk to the gate, then step into the rows.
    const u = hashUnit(p.id * 3 + p.rev) - 0.5, v = hashUnit(p.id * 5 + p.rev) - 0.5;
    const tail = [b.x + u * (b.w - 1), b.z + v * (b.d - 1)];
    // Only if the step from the gate stays on open ground (a farmhouse may stand there).
    if (!segmentBlocked(state, target.x, target.z, tail[0], tail[1])) target.tail = tail;
  }
  return target;
}

// One of the k nearest buildings of the given types, picked by a stable hash.
const nearScratch = [];
function nearestOf(world, types, p, k) {
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
  if (!nearScratch.length) return null;
  const pick = nearScratch[hash32(p.id + p.rev) % nearScratch.length].b;
  return buildingTarget(pick);
}

function strollTarget(state, p) {
  const a = hashUnit(p.id * 13 + p.rev) * Math.PI * 2;
  const r = 6 + hashUnit(p.id * 29 + p.rev) * 14;
  let x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
  if (waterAt(x, z)) x = p.x - Math.cos(a) * r;
  return {type: 'point', id: null, x, z};
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

function startTask(state, ctx, p, kind, target, now) {
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
    route: [],
    seg: 0,
    elapsed: 0,
    dwell: 0,
    dwellFor: lo + rng(state, 'people') * (hi - lo),
    waiting: true,
    retryAt: now,
    started: now,
  };
  requestRoute(state, ctx, p, p.task, now);
}

// ---------------------------------------------------------------------------
// Routes
//
// services.routes (sim-world) must provide:
//   plan(state, x0, z0, x1, z1, onRoute) -> boolean   // false = busy, ask again later
//   onRoute(route: number[] | Float32Array | null)    // flat [x, z, ...], may be called synchronously
// A null route means unreachable; the walker uses the fallback path.

function requestRoute(state, ctx, p, task, now) {
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
      // Unreachable: stay put for this task rather than walking through walls.
      setRoute(state, task, route && route.length >= 2 ? route : [], route && route.length >= 2);
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
  setRoute(state, task, route && route.length >= 2 ? route : [], !!route);
}

// A* over sim-world's structural grid: a pure function of the saved state (no wear
// sampled at an arbitrary moment), so a restored town plans exactly the same routes.
function syncRoute(state, x0, z0, x1, z1) {
  const grid = structuralGrid(state);
  const result = findRoute(grid, cellOf(x0, z0), cellOf(x1, z1), {maxNodes: 20000});
  for (const band of result.crossings ?? []) recordCrossingBand(state, band);
  return result.cells ? cellsToWaypoints(grid, result.cells, {x: x0, z: z0}, {x: x1, z: z1}) : null;
}

function setRoute(state, task, route, reachable = true) {
  task.route = alongDecks(state, Array.from(route));   // a copy: planner routes are shared through its cache
  // The last step off the street (into a field) is checked again: something may have
  // been built there since the task began.
  const n = task.route.length;
  if (task.tail && reachable && n >= 2 && !segmentBlocked(state, task.route[n - 2], task.route[n - 1], task.tail[0], task.tail[1])) {
    task.route.push(task.tail[0], task.tail[1]);
  }
  task.seg = 0;
  task.waiting = false;
}

// Straight line, or via the nearest crossing when the walk crosses the river. Without
// any crossing the walker goes to its own bank opposite the goal and turns back.
export function fallbackRoute(state, x0, z0, x1, z1) {
  const west0 = x0 < riverX(z0), west1 = x1 < riverX(z1);
  if (west0 === west1) return [x1, z1];
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
