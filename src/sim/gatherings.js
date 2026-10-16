// What people do when they stop somewhere in sight, and where exactly they stand: a
// small, data-driven activity layer.
//
// Walkers who stop in sight take a standing spot of their own (people.js). Most use the
// plain spot finder (a ring round a building's walls, a spiral round a point). A walker
// at a gathering or out for leisure instead has an activity (ACTIVITIES below), chosen
// from the place and the reason it is there (OCCASIONS). An activity names:
//
//   layout   how candidate spots are laid out at the place (LAYOUTS), computed once per
//            place and cached (an "occasion"): a fan facing a focus, a tight crush,
//            conversation clusters, a lawn scored by appeal, a line along a bank
//   pick     how a walker chooses among them (PICKERS): front first, join a cluster,
//            the most appealing nearby, beside family
//   space    personal space [base, per-walker jitter]: how far from strangers it stands
//   kin      the social rule for household members and workmates already there
//   face     what it looks at (the focus, the group's middle, the view, family);
//            resolved into each spot's facing point when the layout is built
//   action   the pose (people.js ACTION name), or null for standing
//   wander   how it moves on during its dwell (WANDERS), with hop timing
//   weight / prefer   how often it is chosen among the activities sharing a layout,
//            and its season and weather preferences
//
// The four gathering styles are entries: ceremony (focal: a loose fan on the focus's
// open side, front first, ragged rows, never a closed ring), mingle and browse (milling:
// F-formation groups of two to four facing a shared middle, lone browsers at the stalls,
// drifting between groups), the lawn activities (dispersed leisure: rest, play, stroll,
// watch the view, picnic with family, each well apart from strangers) and crush
// (crowding: packed in tight, pushing up to the focus). Leisure outings (sim/leisure.js
// chooses them) are further entries on more layouts: anglers along a reach of bank
// ('bank') or a bridge rail ('rail': on the deck, at deck height), gazers at the rail
// (facing the sun when the light is low: daylight.js), picnics behind the bank
// ('bankside'), the woods' edge ('woodedge': walks along it, berries, birds), a trail's
// far end ('view'), a building's steps ('steps'), the ground before a home ('yard').
// A single walker uses a picker exactly as a crowd does.
//
// Determinism: layouts are pure functions of the world (buildings, footprints, terrain,
// the event); choices hash the walker's id, so a restored town picks exactly the same.
// "Free" means clear of everyone else's claimed spot by the walker's personal space
// (the standing hash in people.js), less for its own household. Every spot is on open,
// dry ground off bridge decks (people.js standable).

import {bankDistance, waterAt} from '../terrain.js';
import {hash32, hashUnit} from './rng.js';
import {byId} from './state.js';
import {season} from './clock.js';
import {footprints, footprintKey} from './roads.js';
import {densityAt} from './density.js';
import {benchesOf, hashId} from './seats.js';
import {accessPoint, standable, stepClear, spotClear, deckAt, bridgeDecks} from './people.js';
import {placeById, traceShore, shoreGradient, riverFordNear} from './places.js';
import {alongBridge} from './bridges.js';
import {woodField} from '../woodland.js';
import {simPhase, lowSun, SUN_DIR} from '../daylight.js';

// ---------------------------------------------------------------------------
// The activities

const LAWN = {layout: 'lawn', pick: 'appeal', space: [1.7, 0.8], kin: 'picnic', face: 'view'};
const MINGLE_HOP = {chance: 0.55, after: [5, 10], again: 0.35};

export const ACTIVITIES = {
  // Gatherings.
  ceremony: {layout: 'fan', pick: 'front', space: [0.78, 0.32], kin: 'beside', face: 'focus', action: null},
  crush: {layout: 'crush', pick: 'front', space: [0.62, 0.06], kin: 'beside', face: 'focus', action: null},
  mingle: {layout: 'cluster', pick: 'cluster', space: [0.64, 0], kin: 'group', face: 'group', action: null, wander: 'regroup', hop: MINGLE_HOP},
  browse: {layout: 'cluster', pick: 'cluster', space: [0.64, 0], kin: 'group', face: 'attraction', action: null, wander: 'regroup', hop: MINGLE_HOP},
  // On the lawn (chosen among by weight and preference).
  'lawn-rest': {...LAWN, action: 'sit', weight: 0.4, prefer: {seasons: [1, 1.2, 0.9, 0.4], rain: 0.3}},
  'lawn-play': {...LAWN, action: null, weight: 0.22, wander: 'loop', hop: {after: [1, 3], every: [2, 4.5]}, prefer: {seasons: [1, 1.3, 0.8, 0.6], rain: 0.4}},
  'lawn-stroll': {...LAWN, action: null, weight: 0.2, wander: 'ring', hop: {after: [0.5, 1.5]}, prefer: {rain: 0.7}},
  'lawn-watch': {...LAWN, action: null, weight: 0.18},
  'lawn-lie': {...LAWN, action: 'lie', weight: 0.12, prefer: {seasons: [0.4, 1.8, 0.4, 0], rain: 0}},
  // Joining family already on the lawn (the lawn activities' kin rule).
  picnic: {layout: 'lawn', pick: 'beside-kin', space: [1.6, 0], kin: null, face: 'kin', action: 'kneel'},

  // Leisure outings (sim/leisure.js chooses them; dwell: seconds there, [lo, hi]).
  // By the water: anglers spaced along a calm reach, or at a bridge rail; gazers lean on
  // the rail and, when the light is low, face the sun; picnics on the grass behind the
  // bank.
  fishing: {layout: 'bank', pick: 'front', space: [2.6, 1.2], kin: 'beside', face: 'water', action: 'fish', dwell: [16, 30]},
  'bridge-fish': {layout: 'rail', pick: 'front', space: [2.8, 0.6], kin: 'beside', face: 'water', action: 'fish', dwell: [14, 24]},
  'bridge-gaze': {layout: 'rail', pick: 'front', space: [2.3, 0.6], kin: 'beside', face: 'sunset', action: 'lean', dwell: [6, 12]},
  'bank-gaze': {layout: 'bank', pick: 'front', space: [2.4, 1.0], kin: 'beside', face: 'sunset', action: null, dwell: [6, 12]},
  'river-picnic': {layout: 'bankside', pick: 'front', space: [2.4, 1.0], kin: 'beside', face: 'water', action: 'sit', dwell: [12, 22]},
  // The woods: a walk along their edge (out and back), berries in autumn, birds.
  'wood-walk': {layout: 'woodedge', pick: 'front', space: [1.2, 0.4], kin: 'beside', face: 'woods', action: null, wander: 'edge', hop: {after: [0, 0.3]}, dwell: [3, 6]},
  'berry-pick': {layout: 'woodedge', pick: 'front', space: [1.6, 0.6], kin: 'beside', face: 'woods', action: 'kneel', dwell: [8, 14]},
  birdwatch: {layout: 'woodedge', pick: 'front', space: [2.2, 0.8], kin: 'beside', face: 'woods', action: 'point', dwell: [6, 10]},
  // Out along a track past the houses, a look at the view, and home.
  'trail-walk': {layout: 'view', pick: 'front', space: [1.2, 0.5], kin: 'beside', face: 'view', action: null, dwell: [4, 8]},
  // Round the inside of a wild park's hedge (a nature reserve, parks.js), once.
  'reserve-walk': {layout: 'lawn', pick: 'appeal', space: [1.4, 0.6], kin: 'beside', face: 'view', action: null, wander: 'perimeter', hop: {after: [0, 0.5]}, dwell: [3, 6]},
  // Sitting on the steps of the chapel or hall, watching the street.
  'steps-sit': {layout: 'steps', pick: 'front', space: [0.9, 0.3], kin: 'beside', face: 'view', action: 'sit', dwell: [6, 12]},
  // Children chasing about in front of home.
  tag: {layout: 'yard', pick: 'front', space: [1.0, 0.4], kin: 'beside', face: 'view', action: null, wander: 'loop', hop: {after: [0.3, 1], every: [1.2, 2.5]}, dwell: [6, 12]},
};

// Place and reason -> the activity (or, for a layout shared by several, the first of
// them: the picker settles which).
const EVENT_ACTIVITY = {
  market: 'mingle', festival: 'mingle', fair: 'mingle',
  protest: 'crush', strike: 'crush', riot: 'crush',
  wedding: 'ceremony', funeral: 'ceremony', procession: 'ceremony', ceremony: 'ceremony', speech: 'ceremony',
};
const LEISURE_ACTIVITY = {park: 'lawn-rest', monument: 'ceremony', market: 'mingle', inn: 'mingle', theatre: 'mingle', bathhouse: 'mingle'};
// A ceremony this big turns into a crush (the town turning out for an unveiling).
const CRUSH_STRENGTH = 0.95, CRUSH_RADIUS = 20;

export function eventOf(state, id) {
  for (const ev of state.worldEvents ?? []) if (ev.id === id) return ev;
  return null;
}

// The activity for a task (kind, targetType, targetId, eventKind), or null for the
// plain spot finder (work, building sites, a stroll down the street, flight...).
export function gatheringActivity(state, kind, targetType, targetId, eventKind) {
  if (targetType === 'event' && kind === 'gather') {
    const id = EVENT_ACTIVITY[eventKind] ?? 'mingle';
    if (id === 'ceremony') {
      const ev = eventOf(state, targetId);
      if (ev && (ev.strength ?? 0) >= CRUSH_STRENGTH && (ev.radius ?? 0) >= CRUSH_RADIUS) return 'crush';
    }
    return id;
  }
  if (targetType === 'building' && kind === 'leisure') {
    const b = byId(state, 'buildings', targetId);
    return b ? LEISURE_ACTIVITY[b.type] ?? null : null;
  }
  return null;
}

export const layoutOf = (activity) => ACTIVITIES[activity]?.layout ?? null;

// How much an activity is wanted now: its season multiplier, and its rain multiplier
// scaled by how hard it is raining (state.weather.rain, 0..1).
export function preference(state, a) {
  let w = a.weight ?? 0;
  const pf = a.prefer;
  if (!pf || w <= 0) return w;
  if (pf.seasons) w *= pf.seasons[season(state.time?.month ?? 0)] ?? 1;
  const rain = state.weather?.rain ?? 0;
  if (pf.rain != null && rain > 0) w *= 1 + (pf.rain - 1) * Math.min(1, rain);
  return w;
}

// One of the activities sharing a layout, by weight and preference, from a stable
// hash u in [0, 1).
function chooseActivity(state, layout, u) {
  let total = 0;
  for (const id in ACTIVITIES) if (ACTIVITIES[id].layout === layout) total += preference(state, ACTIVITIES[id]);
  let x = u * total, last = null;
  for (const id in ACTIVITIES) {
    const a = ACTIVITIES[id];
    if (a.layout !== layout) continue;
    const w = preference(state, a);
    if (w <= 0) continue;
    last = id;
    if ((x -= w) < 0) return id;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Places and occasions: the candidate spots of one layout at one place, cached
//
// spots: Float64Array, SPOT_STRIDE per spot, best first:
//   x, z, face x, face z (the point a stander there faces), group (-1: none), edge (1:
//   beyond the crowd's inner reach), appeal (lawn)
// groups (cluster): Int32Array [first spot, count] per group, best first.

export const SPOT_STRIDE = 7;
const occasions = new Map();

const strHash = (s) => {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};

// The occasion of a layout at a target ({type, id}), or null when the target is gone.
export function occasionFor(state, layout, targetType, targetId) {
  const build = LAYOUTS[layout];
  if (!build) return null;
  const focus = focusOf(state, targetType, targetId);
  if (!focus) return null;
  const b = focus.b ?? focus.park, ev = focus.ev;
  const deck = focus.place?.bridge;
  const geo = b ? `${b.x},${b.z},${b.w},${b.d},${b.rot}` : deck ? `${deck.style ?? deck.variant},${deck.width},${deck.a.x},${deck.a.z},${deck.b.x},${deck.b.z}` : '';
  const evKey = ev ? `${ev.x},${ev.z},${ev.radius}` : '';
  // Footprints (and so the building list), the focus and the event: buildingsRev alone
  // moves on with every repair and scaffold, which changes no spot.
  const key = `${footprintKey(state)}:${geo}:${evKey}`;
  const id = `${layout}|${targetType}|${targetId}`;
  const hit = occasions.get(id);
  if (hit && hit.state === state && hit.key === key) return hit;
  const occ = {state, key, id, layout, targetType, targetId, seed: strHash(id), b: focus.b, ev, fx: focus.fx, fz: focus.fz, spots: null, groups: null, park: null};
  build(state, occ, focus);
  if (occasions.size > 256) occasions.clear();
  occasions.set(id, occ);
  return occ;
}

const insideRect = (b, x, z, m) => Math.abs(x - b.x) < (b.w ?? 4) / 2 + m && Math.abs(z - b.z) < (b.d ?? 4) / 2 + m;
const wallDist = (b, x, z) => Math.hypot(Math.max(0, Math.abs(x - b.x) - (b.w ?? 4) / 2), Math.max(0, Math.abs(z - b.z) - (b.d ?? 4) / 2));

// What the occasion is about: a building (its walls kept clear: b), a park or field
// (open ground: park), or an event's point, held at the building it stands on when
// there is one (events are placed on a building's middle). fx, fz: the point faced.
function focusOf(state, targetType, targetId) {
  if (targetType === 'place') {
    const pl = placeById(state, targetId);
    return pl ? {b: null, park: null, ev: null, place: pl, x: pl.x, z: pl.z, fx: pl.x, fz: pl.z, radius: null} : null;
  }
  let b = null, ev = null;
  if (targetType === 'building') b = byId(state, 'buildings', targetId);
  else if (targetType === 'event') {
    ev = eventOf(state, targetId);
    if (!ev) return null;
    for (const c of state.buildings) {
      if (c.type === 'bridge' || c.type === 'farm' || c.type === 'park' || !insideRect(c, ev.x, ev.z, 0.6)) continue;
      b = c;
      break;
    }
  }
  if (!b && !ev) return null;
  const x = b ? b.x : ev.x, z = b ? b.z : ev.z;
  const walls = b && b.type !== 'park' && b.type !== 'farm';
  // A monument is looked at; any other building, its door.
  let fx = x, fz = z;
  if (walls && b.type !== 'monument') {
    const door = accessPoint(b, state);
    const l = Math.hypot(door.x - b.x, door.z - b.z) || 1;
    const reach = Math.min(Math.abs((door.x - b.x) / l) > 0.5 ? b.w / 2 : b.d / 2, l);
    fx = b.x + ((door.x - b.x) / l) * reach;
    fz = b.z + ((door.z - b.z) / l) * reach;
  }
  return {b: walls ? b : null, park: b && !walls ? b : null, ev, x, z, fx, fz, radius: ev ? ev.radius ?? 6 : null};
}

// Distance from the focus: from a building's walls, else from the point.
const focusDist = (f, x, z) => (f.b ? wallDist(f.b, x, z) : Math.hypot(x - f.x, z - f.z));

// ---------------------------------------------------------------------------
// Layouts

// Fan (ceremony) and crush: on the focus's open side, best (front, middle) first.
const FAN = {gap: 1.0, gapPoint: 2.2, inner: 3.6, innerR: 0.75, edge: 2.4, spread: 1.3, ang: 2.4, noise: 0.55, grid: 0.5};
const CRUSH = {gap: 0.35, gapPoint: 1.0, inner: 3.0, innerR: 0.45, edge: 1.4, spread: 2.3, ang: 0.7, noise: 0.18, grid: 0.42};

// The bearing (radians, atan2(dz, dx)) of the focus's open side: of 16, the one with
// the most open, dry ground beyond it (smoothed over its neighbours), favouring a
// building's front.
function openBearing(state, blocked, f) {
  const N = 16, open = new Float64Array(N);
  let frontA = null;
  if (f.b) {
    const door = accessPoint(f.b, state);
    frontA = Math.atan2(door.z - f.b.z, door.x - f.b.x);
  }
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
    let exit = 0;
    if (f.b) {
      const hw = (f.b.w ?? 4) / 2, hd = (f.b.d ?? 4) / 2;
      exit = Math.min(Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity, Math.abs(uz) > 1e-6 ? hd / Math.abs(uz) : Infinity);
    }
    for (const d of [1.2, 2.6, 4, 5.5]) {
      if (standable(state, blocked, f.x + ux * (exit + d), f.z + uz * (exit + d))) open[i] += 1;
    }
  }
  let best = 0, bestS = -Infinity;
  for (let i = 0; i < N; i++) {
    let s = open[(i + N - 1) % N] + 2 * open[i] + open[(i + 1) % N];
    if (frontA != null) s += 3 * Math.max(0, Math.cos((i / N) * Math.PI * 2 - frontA));
    if (s > bestS + 1e-9) { bestS = s; best = i; }
  }
  return (best / N) * Math.PI * 2;
}

const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

function writeSpots(occ, list) {
  occ.spots = new Float64Array(list.length * SPOT_STRIDE);
  list.forEach((c, k) => occ.spots.set([c.x, c.z, c.fx, c.fz, c.group ?? -1, c.edge ?? 0, c.appeal ?? 0], k * SPOT_STRIDE));
}

function buildFan(P) {
  return (state, occ, f) => {
    const {walls: blocked} = footprints(state);
    const openA = openBearing(state, blocked, f);
    const inner = Math.max(P.inner, (f.radius ?? 0) * P.innerR), outer = inner + P.edge;
    const gap = f.b ? P.gap : P.gapPoint;
    const ext = (f.b ? Math.max(f.b.w ?? 4, f.b.d ?? 4) / 2 : 0) + outer + 0.5;
    const n = Math.ceil(ext / P.grid);
    const found = [];
    for (let j = -n; j <= n; j++)
      for (let i = -n; i <= n; i++) {
        const h = hash32((occ.seed + (i + 512) * 1031 + (j + 512) * 7919) >>> 0);
        const x = f.x + (i + ((h & 255) / 255 - 0.5) * 0.6) * P.grid;
        const z = f.z + (j + (((h >>> 8) & 255) / 255 - 0.5) * 0.6) * P.grid;
        const d = focusDist(f, x, z);
        if (d < gap || d > outer) continue;
        const t = wrap(Math.atan2(z - f.z, x - f.x) - openA) / P.spread;
        if (Math.abs(t) > 1) continue;
        if (!standable(state, blocked, x, z)) continue;
        const score = d + P.ang * t * t + (((h >>> 16) & 1023) / 1023 - 0.5) * P.noise;
        found.push({x, z, fx: f.fx, fz: f.fz, edge: d > inner ? 1 : 0, score});
      }
    found.sort((p, q) => (p.edge - q.edge) || (p.score - q.score) || (p.x - q.x) || (p.z - q.z));
    writeSpots(occ, found);
    occ.openA = openA;
    occ.inner = inner;
  };
}

// Cluster (mingle, browse): conversation groups spread over the open ground round the
// attractions; a group too cramped for a circle is a lone browser facing a stall.
const GROUP_GRID = 2.15;
const GROUP_RHO = [0, 0, 0.5, 0.56, 0.62];       // slot radius by group size
const ATTRACTIONS = new Set(['market', 'shop', 'inn', 'theatre', 'monument', 'bathhouse', 'chapel', 'exchange']);

function buildCluster(state, occ, f) {
  const {walls: blocked} = footprints(state);
  const inner = f.ev ? Math.min(16, Math.max(7, f.radius * 1.3)) : 6;
  const outer = inner + 3;
  // Things people drift between: the focus and the doors of shops and stalls nearby.
  const attr = [f.fx, f.fz];
  const reach = (f.b ? Math.max(f.b.w ?? 4, f.b.d ?? 4) / 2 : 0) + outer + 4;
  for (const c of state.buildings) {
    if (c === f.b || !ATTRACTIONS.has(c.type) || (c.built ?? 1) < 1) continue;
    if (Math.abs(c.x - f.x) > reach || Math.abs(c.z - f.z) > reach) continue;
    const door = accessPoint(c, state);
    attr.push(door.x, door.z);
  }
  const ext = (f.b ? Math.max(f.b.w ?? 4, f.b.d ?? 4) / 2 : 0) + outer;
  const n = Math.ceil(ext / GROUP_GRID);
  const groups = [];
  for (let j = -n; j <= n; j++)
    for (let i = -n; i <= n; i++) {
      const h = hash32((occ.seed + (i + 512) * 3301 + (j + 512) * 6007) >>> 0);
      const cx = f.x + (i + ((h & 255) / 255 - 0.5) * 0.7) * GROUP_GRID;
      const cz = f.z + (j + (((h >>> 8) & 255) / 255 - 0.5) * 0.7) * GROUP_GRID;
      const d = focusDist(f, cx, cz);
      if (d < 1.4 || d > outer || !standable(state, blocked, cx, cz)) continue;
      // The nearest attraction: what a lone browser looks at, and how good the place is.
      let ax = f.fx, az = f.fz, ad = Infinity;
      for (let k = 0; k < attr.length; k += 2) {
        const e = Math.hypot(attr[k] - cx, attr[k + 1] - cz);
        if (e < ad) { ad = e; ax = attr[k]; az = attr[k + 1]; }
      }
      const u = ((h >>> 16) & 1023) / 1023;
      const size = u < 0.15 ? 1 : u < 0.45 ? 2 : u < 0.78 ? 3 : 4;
      const slots = [];
      if (size > 1) {
        const a0 = hashUnit(h ^ 0x9e37) * Math.PI * 2, rho = GROUP_RHO[size];
        for (let k = 0; k < size; k++) {
          const a = a0 + (k / size) * Math.PI * 2 + (hashUnit(h + k * 131) - 0.5) * 0.35;
          const sx = cx + Math.cos(a) * rho, sz = cz + Math.sin(a) * rho;
          if (standable(state, blocked, sx, sz) && focusDist(f, sx, sz) >= 0.9) slots.push(sx, sz, cx, cz);
        }
      }
      if (slots.length < 8) slots.splice(0, slots.length, cx, cz, ax, az);
      groups.push({slots, edge: d > inner ? 1 : 0, rank: ad * 0.55 + d * 0.15 + hashUnit(h ^ 0x51ed) * 2.5});
    }
  groups.sort((p, q) => (p.edge - q.edge) || (p.rank - q.rank) || (p.slots[0] - q.slots[0]) || (p.slots[1] - q.slots[1]));
  const list = [];
  occ.groups = new Int32Array(groups.length * 2);
  groups.forEach((g, gi) => {
    occ.groups[gi * 2] = list.length;
    occ.groups[gi * 2 + 1] = g.slots.length / 4;
    for (let k = 0; k < g.slots.length; k += 4) list.push({x: g.slots[k], z: g.slots[k + 1], fx: g.slots[k + 2], fz: g.slots[k + 3], group: gi, edge: g.edge});
  });
  writeSpots(occ, list);
  occ.inner = inner;
}

// Lawn: every spot in a park scored by its appeal, best first. The drawn park
// (render/decals.js, render/trees.js parkPlanting, seats.js benches): a gravel cross
// along its axes and a ring path at 0.42 of its smaller half-size, trees round the lawn
// at 0.62, a clipped hedge rim.
const LAWN_GRID = 0.9;
const PATH_CLEAR = 1.05;           // keep this far from a path's centre line
const WATER_VIEW = 18;             // water this near is worth looking at

export function parkTrees(b) {
  const id = b.id | 0;
  const hw = b.w / 2, hd = b.d / 2, m = Math.max(hw, hd);
  const n = 3 + Math.floor(hashId(id, 51) * 4);
  const ring = Math.min(hw, hd) * 0.62;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 4 + (i / n) * Math.PI * 2 + (hashId(id * 7 + i, 52) - 0.5) * 0.5;
    const r = ring * (0.85 + hashId(id * 7 + i, 53) * 0.3);
    out.push(b.x + Math.cos(a) * r * (hw / m), b.z + Math.sin(a) * r * (hd / m));
  }
  return out;
}

export const parkRingRadius = (b) => (Math.min(b.w, b.d) / 2) * 0.42;
export const pathDistance = (b, x, z) => {
  const lx = x - b.x, lz = z - b.z;
  return Math.min(Math.abs(lx), Math.abs(lz), Math.abs(Math.hypot(lx, lz) - parkRingRadius(b)));
};

function buildLawn(state, occ, f) {
  const b = f.park ?? f.b;
  const {walls: blocked} = footprints(state);
  occ.spots = new Float64Array(0);
  if (!b) return;
  const hw = (b.w ?? 4) / 2 - 0.6, hd = (b.d ?? 4) / 2 - 0.6;
  const gate = accessPoint(b, state);
  const trees = parkTrees(b), benches = benchesOf(b);
  const found = [];
  const nx = Math.ceil(hw / LAWN_GRID), nz = Math.ceil(hd / LAWN_GRID);
  for (let j = -nz; j <= nz; j++)
    for (let i = -nx; i <= nx; i++) {
      const h = hash32((occ.seed + (i + 512) * 2749 + (j + 512) * 9227) >>> 0);
      const x = b.x + (i + ((h & 255) / 255 - 0.5) * 0.8) * LAWN_GRID;
      const z = b.z + (j + (((h >>> 8) & 255) / 255 - 0.5) * 0.8) * LAWN_GRID;
      if (Math.abs(x - b.x) > hw || Math.abs(z - b.z) > hd) continue;
      if (pathDistance(b, x, z) < PATH_CLEAR || !standable(state, blocked, x, z)) continue;
      let appeal = (((h >>> 16) & 1023) / 1023 - 0.5) * 1.2;
      // Shade: beside a tree (not at its trunk).
      let tree = Infinity;
      for (let k = 0; k < trees.length; k += 2) tree = Math.min(tree, Math.hypot(trees[k] - x, trees[k + 1] - z));
      if (tree < 0.9) continue;
      if (tree < 2.6) appeal += 1.0;
      // A view of the water.
      const bank = bankDistance(x, z);
      if (bank > 0 && bank < WATER_VIEW) appeal += 1.4 * (1 - bank / WATER_VIEW);
      // Near a bench (sitters' company), not on it.
      let bench = Infinity;
      for (const bb of benches) bench = Math.min(bench, Math.hypot(bb.x - x, bb.z - z));
      if (bench < 1.2) continue;
      if (bench < 3) appeal += 0.3;
      // Away from the gate and the street.
      const g = Math.hypot(gate.x - x, gate.z - z);
      if (g < 3) appeal -= 1.2 * (1 - g / 3);
      // The lawn's edge is a little more sheltered than its middle.
      if (Math.min(hw - Math.abs(x - b.x), hd - Math.abs(z - b.z)) < 1.2) appeal += 0.25;
      // The view: the water when it is in sight, else across the lawn from the gate.
      let fx, fz;
      const toWater = bank > 0 && bank < WATER_VIEW ? shoreGradient(x, z) : null;
      if (toWater) { fx = x - toWater[0] * bank; fz = z - toWater[1] * bank; }
      else {
        const l = Math.hypot(x - gate.x, z - gate.z) || 1;
        fx = x + ((x - gate.x) / l) * 4;
        fz = z + ((z - gate.z) / l) * 4;
      }
      found.push({x, z, fx, fz, appeal});
    }
  found.sort((p, q) => (q.appeal - p.appeal) || (p.x - q.x) || (p.z - q.z));
  writeSpots(occ, found);
  occ.park = b;
}

// Line: spots along a line, in order, each facing to one side of it. lineSpots is the
// reusable part (a bank, a quay, a bridge rail, a hedge: any polyline); the 'bank'
// layout lines the river's near bank by the focus, BANK_SET inland from the water's
// edge, facing the water, nearest the focus first. (Bridge decks are not standable
// ground yet: standing at a rail needs deck heights for standers; see the report.)
//   pts: flat [x, z, ...]; side: spots face along (uz, -ux) * side for a leg along
//   (ux, uz), and stand offset back from the line; step: spacing along the line; face:
//   distance to the faced point; from: rank by distance from this point (else in order).
export function lineSpots(state, pts, {offset = 0, side = 1, step = 0.9, face = 6, from = null} = {}) {
  const {walls: blocked} = footprints(state);
  const out = [];
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const x0 = pts[k], z0 = pts[k + 1], x1 = pts[k + 2], z1 = pts[k + 3];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const ux = (x1 - x0) / len, uz = (z1 - z0) / len, nx = uz * side, nz = -ux * side;
    for (let t = 0; t < len; t += step) {
      const x = x0 + ux * t - nx * offset, z = z0 + uz * t - nz * offset;
      if (!standable(state, blocked, x, z)) continue;
      out.push({x, z, fx: x + nx * face, fz: z + nz * face, rank: from ? Math.hypot(x - from[0], z - from[1]) : out.length});
    }
  }
  out.sort((p, q) => p.rank - q.rank || p.x - q.x || p.z - q.z);
  return out;
}

const BANK_REACH = 20;
function buildBank({offset, step}) {
  return (state, occ, f) => {
    // Along the shore of whatever water is nearest (places.js traceShore: the river, a
    // creek, a lake, a pond or the sea), `offset` back from its edge, nearest the focus
    // first, each spot facing the water. Not right beside a bridge: the walk away from
    // there would step onto the deck from its side (decks are joined at their ends:
    // people.js alongDecks).
    const {walls: blocked} = footprints(state);
    const list = [];
    for (const q of traceShore(f.x, f.z, offset, step, BANK_REACH)) {
      // Dry, open, and with the water right there in front (not round a point's corner).
      if (waterAt(q.x, q.z) || !waterAt(q.x + q.fx * (offset + 1.8), q.z + q.fz * (offset + 1.8))) continue;
      if (!standable(state, blocked, q.x, q.z) || besideDeck(state, q.x, q.z) || riverFordNear(q.x, q.z, q.fx, q.fz, 8)) continue;
      list.push({x: q.x, z: q.z, fx: q.x + q.fx * 6, fz: q.z + q.fz * 6, rank: Math.hypot(q.x - f.x, q.z - f.z)});
    }
    list.sort((p, q) => p.rank - q.rank || p.x - q.x || p.z - q.z);
    writeSpots(occ, list);
  };
}

const DECK_CLEAR = 3.5;
function besideDeck(state, x, z) {
  for (const {bridge: b, x0, x1, z0, z1} of bridgeDecks(state)) {
    if (x < x0 - DECK_CLEAR || x > x1 + DECK_CLEAR || z < z0 - DECK_CLEAR || z > z1 + DECK_CLEAR) continue;
    const {t, off} = alongBridge(b, x, z);
    if (t > -0.2 && t < 1.2 && off < (b.width ?? b.d ?? 3) / 2 + DECK_CLEAR) return true;
  }
  return false;
}

// Rail: along both parapets of a bridge deck, over the water, facing out over its own
// rail, standing just clear of the rail as drawn (railStand, below, per bridge style).
// Through-walkers keep their lanes inside the standers (people.js deckLane), so they
// pass them instead of walking through them.
// A deck holds only a few: one per 2-3 m of rail per side (the activities' personal
// space) and RAIL_PER_M per metre of deck in all (occ.cap), so it never reads as a
// crowd; when it is full, people go to the next deck or bank (leisure.js
// alternativeOuting). Footbridges are too narrow to stop on: no spots. Standers are on
// the deck: people.js walkerY gives their height, the row's deck flag keeps them drawn
// there.
export const RAIL_MIN_HALF = 1.2;
const RAIL_PER_M = 0.25;        // standers per metre of deck, at most (both sides)
export const deckHalf = (b) => ((b.style ?? b.variant) === 'footbridge' ? 0.65 : Math.min(3, Math.max(1.2, (b.width ?? b.d ?? 3) / 2)));
export const railCap = (b) => Math.max(1, Math.min(6, Math.round(Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z) * RAIL_PER_M)));

function buildRail(state, occ, f) {
  const b = f.place?.bridge;
  occ.spots = new Float64Array(0);
  if (!b || deckHalf(b) < RAIL_MIN_HALF) return;
  occ.cap = railCap(b);
  const L = Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z) || 1;
  const ux = (b.b.x - b.a.x) / L, uz = (b.b.z - b.a.z) / L;
  const reach = railStand(b);
  // Only where the rail itself runs (and the deck is near its full height), not on the
  // ramps where it starts.
  const ends = (RAIL_ENDS[railStyle(b)] ?? 1.7) / L, t0 = Math.max(0.2, ends), t1 = Math.min(0.8, 1 - ends);
  const list = [];
  for (let t = t0; t <= t1; t += 0.9 / L)
    for (const side of [1, -1]) {
      const nx = uz * side, nz = -ux * side;
      const x = b.a.x + ux * L * t + nx * reach, z = b.a.z + uz * L * t + nz * reach;
      if (!deckSpot(state, x, z) || !waterAt(x + nx * 1.5, z + nz * 1.5)) continue;
      list.push({x, z, fx: x + nx * 6, fz: z + nz * 6, rank: Math.abs(t - 0.5) + (side < 0 ? 0.01 : 0)});
    }
  list.sort((p, q) => p.rank - q.rank || p.x - q.x || p.z - q.z);
  writeSpots(occ, list);
}

// The drawn rail's inner face, measured from the deck's centre line, per style
// (render/props.js, with W the drawn width, 2.4 to 6): timber rails and posts at
// W/2 - 0.07, 0.13 thick; the stone parapet at W/2 - 0.12, 0.28 thick under a 0.36
// coping; the iron truss chords at W/2 + 0.06, 0.16 thick. RAIL_TOP: how high above the
// deck the rail stands. RAIL_SET: how far inside the face a stander's feet go, so that
// its body (0.25 round) leaning over the rail (the 'lean' pose tips the upper body 0.34
// rad forward about the hips at 0.72) stays clear of it up to the rail's top (the tall
// iron truss needs most room). RAIL_ENDS: how far in from each end the rail starts
// (plus half a metre).
export const railStyle = (b) => {
  const s = b.style ?? b.variant;
  return s === 'stone' || s === 'iron' || s === 'footbridge' ? s : 'timber';
};
export const drawnDeckWidth = (b) => Math.max(2.4, Math.min(6, b.width ?? b.d ?? 3.2));
export const RAIL_TOP = {timber: 0.98, stone: 0.725, iron: 1.75};
const RAIL_SET = {timber: 0.35, stone: 0.3, iron: 0.62};
const RAIL_ENDS = {timber: 1.7, stone: 1.1, iron: 3.8};
export function railInner(b) {
  const W = drawnDeckWidth(b), style = railStyle(b);
  return style === 'stone' ? W / 2 - 0.3 : style === 'iron' ? W / 2 - 0.02 : W / 2 - 0.135;
}
export const railStand = (b) => railInner(b) - (RAIL_SET[railStyle(b)] ?? 0.35);

/** On a finished bridge's deck, inside its walkable width. */
export function deckSpot(state, x, z) {
  const d = deckAt(state, x, z);
  return !!d && d.t > 0.02 && d.t < 0.98 && d.off <= deckHalf(d.bridge) - 0.1;
}

// Spots in a small sunflower disc round a point (out to `reach`), on standable ground
// outside `avoid`'s walls, each facing face(x, z) -> [fx, fz]; nearest the point first.
function discSpots(state, occ, cx, cz, reach, face, avoid = null) {
  const {walls: blocked} = footprints(state);
  const list = [];
  for (let k = 0; ; k++) {
    const r = 0.45 * Math.sqrt(k);
    if (r > reach) break;
    const a = k * 2.39996 + (occ.seed % 628) / 100;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (avoid && insideRect(avoid, x, z, 0.3)) continue;
    if (!standable(state, blocked, x, z)) continue;
    const [fx, fz] = face(x, z);
    list.push({x, z, fx, fz});
  }
  writeSpots(occ, list);
}

// Woods' edge (places.js woods): round the edge point, facing into the wood.
function buildWoodEdge(state, occ, f) {
  const w = f.place;
  if (!w) { occ.spots = new Float64Array(0); return; }
  discSpots(state, occ, w.x, w.z, 3.5, (x, z) => [x + w.gx * 6, z + w.gz * 6]);
}

// View (places.js trails): round a trail's far end, looking out away from town.
function buildView(state, occ, f) {
  const t = f.place;
  if (!t) { occ.spots = new Float64Array(0); return; }
  discSpots(state, occ, t.x, t.z, 3.5, (x, z) => [x + t.ox * 8, z + t.oz * 8]);
}

// Steps: a row along a building's front, either side of the door, facing the street.
function buildSteps(state, occ, f) {
  const b = f.b;
  occ.spots = new Float64Array(0);
  if (!b) return;
  const door = accessPoint(b, state);
  const l = Math.hypot(door.x - b.x, door.z - b.z) || 1;
  const nx = (door.x - b.x) / l, nz = (door.z - b.z) / l;
  const tx = -nz, tz = nx;
  // Along +t the normal (uz, -ux) is (nx, nz): out from the building.
  writeSpots(occ, lineSpots(state, [door.x - tx * 3, door.z - tz * 3, door.x + tx * 3, door.z + tz * 3], {step: 0.8, side: 1, face: 6, from: [door.x, door.z]}));
}

// Yard: the open ground in front of a home's door, facing it.
function buildYard(state, occ, f) {
  const b = f.b;
  if (!b) { occ.spots = new Float64Array(0); return; }
  const door = accessPoint(b, state);
  discSpots(state, occ, door.x, door.z, 4.5, () => [door.x, door.z], b);
}

const LAYOUTS = {
  fan: buildFan(FAN), crush: buildFan(CRUSH), cluster: buildCluster, lawn: buildLawn,
  bank: buildBank({offset: 1.2, step: 0.9}), bankside: buildBank({offset: 3.2, step: 1.4}),
  rail: buildRail, woodedge: buildWoodEdge, view: buildView, steps: buildSteps, yard: buildYard,
};

// ---------------------------------------------------------------------------
// Kin: walkers at an activity, by household and workplace (rebuilt each tick by
// people.js crowdIndex, and added to as spots are claimed). Lists are pooled.

const kin = {household: new Map(), work: new Map(), pool: []};

export function kinReset() {
  for (const m of [kin.household, kin.work]) {
    for (const list of m.values()) {
      list.length = 0;
      kin.pool.push(list);
    }
    m.clear();
  }
}

function kinPush(m, key, p) {
  let list = m.get(key);
  if (!list) {
    list = kin.pool.pop() ?? [];
    m.set(key, list);
  }
  list.push(p);
}

export function kinAdd(p) {
  if (p.householdId != null) kinPush(kin.household, p.householdId, p);
  if (p.workId != null) kinPush(kin.work, p.workId, p);
}

// The claimed spot of a household member (first) or workmate in the same layout at the
// same place: {x, z, household}, or null. One who stays put first: a stroller's spot is
// only where the stroll is now.
function kinAt(p, task, layout) {
  for (let pass = 0; pass < 2; pass++) {
    const key = pass ? p.workId : p.householdId;
    if (key == null) continue;
    const list = (pass ? kin.work : kin.household).get(key);
    if (!list) continue;
    let moving = null;
    for (const q of list) {
      const t = q.task;
      if (q === p || !t || !t.spot || t.targetId !== task.targetId || t.targetType !== task.targetType || layoutOf(t.activity) !== layout) continue;
      if (ACTIVITIES[t.activity]?.wander) { moving ??= t; continue; }
      return {x: t.spot[0], z: t.spot[1], household: !pass};
    }
    if (moving) return {x: moving.spot[0], z: moving.spot[1], household: !pass};
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pickers
//
// occasionSpot(state, p, task, occ, ox, oz) -> null, or
//   {x, z, fx, fz, edge, reach, group, activity, hopIn}
// activity: what the walker does there (the task's own, or the picker's choice: a lawn
// activity by weight, a picnic beside family, a browse at a lone slot); hopIn: seconds
// of dwell before it next moves on, or null; reach: the spot can be walked to from
// (ox, oz) in one clear straight step.

const personalSpace = (a, id) => a.space[0] + a.space[1] * hashUnit(id * 97 + 7);
const hh = (p) => p.householdId ?? -1;
const KIN_SPACE = 0.72;              // how close family may stand

export function occasionSpot(state, p, task, occ, ox, oz) {
  if (!occ.spots.length || (occ.cap != null && occasionTaken(occ, p.id) >= occ.cap)) return null;
  const a = ACTIVITIES[task.activity] ?? ACTIVITIES[firstOf(occ.layout)];
  const k = PICKERS[a.pick](state, p, task, occ, a);
  if (!k) return null;
  k.reach = Math.hypot(k.x - ox, k.z - oz) <= 0.02 || stepClear(state, ox, oz, k.x, k.z);
  return k;
}

/** How many of an occasion's spots are claimed (by anyone but `id`): a claim sits
 * exactly on its spot (the standing hash, people.js). */
export function occasionTaken(occ, id = -1) {
  const s = occ.spots;
  let n = 0;
  for (let k = 0; k < s.length; k += SPOT_STRIDE) if (!spotClear(s[k], s[k + 1], id, 0.05)) n++;
  return n;
}

/** Room at an occasion: spots laid out, and under its cap if it has one. */
export const occasionHasRoom = (occ) => occ.spots.length > 0 && (occ.cap == null || occasionTaken(occ) < occ.cap);

function firstOf(layout) {
  for (const id in ACTIVITIES) if (ACTIVITIES[id].layout === layout) return id;
  return null;
}

const spotAt = (occ, i, activity, hopIn = null) => {
  const o = i * SPOT_STRIDE, s = occ.spots;
  return {x: s[o], z: s[o + 1], fx: s[o + 2], fz: s[o + 3], group: s[o + 4], edge: s[o + 5] === 1, activity, hopIn};
};

// Seconds of dwell before the first hop of an activity (or null), by a stable hash.
function firstHop(a, u) {
  const h = a.hop;
  if (!h) return null;
  if (h.chance != null && u >= h.chance) return null;
  const v = h.chance != null ? u / h.chance : u;
  return h.after[0] + v * (h.after[1] - h.after[0]);
}

// Front: the first free spot in the layout's order, each at its own personal space;
// with family here, the first free one beside them.
function pickFront(state, p, task, occ, a) {
  const s = occ.spots, n = s.length / SPOT_STRIDE;
  const space = personalSpace(a, p.id), near = Math.min(space, KIN_SPACE);
  const id = task.activity;
  // Sunset gazers: when the light is low, a spot looking toward the sun first, and they
  // face the sun itself (daylight.js, as the grade draws it).
  const sunset = a.face === 'sunset' && lowSun(simPhase(state.time));
  const sunward = (o) => (s[o + 2] - s[o]) * SUN_DIR[0] + (s[o + 3] - s[o + 1]) * SUN_DIR[1] > 0;
  const done = (i) => {
    const spot = spotAt(occ, i, id, firstHop(a, hashUnit((p.id * 7 + 3) >>> 0)));
    if (sunset) [spot.fx, spot.fz] = towardSun(spot.x, spot.z, spot.fx, spot.fz);
    return spot;
  };
  const k = a.kin ? kinAt(p, task, occ.layout) : null;
  if (k) {
    for (let i = 0; i < n; i++) {
      const o = i * SPOT_STRIDE;
      if (Math.hypot(s[o] - k.x, s[o + 1] - k.z) > 1.7) continue;
      if (spotClear(s[o], s[o + 1], p.id, space, hh(p), near)) return done(i);
    }
  }
  for (let pass = sunset ? 0 : 1; pass < 2; pass++)
    for (let i = 0; i < n; i++) {
      const o = i * SPOT_STRIDE;
      if (!pass && !sunward(o)) continue;
      if (spotClear(s[o], s[o + 1], p.id, space, hh(p), near)) return done(i);
    }
  return null;
}

// Facing the sun in low light, but never turning away from what the spot looks out over
// (the water, past its own rail): within SUN_TURN of the spot's own facing, toward the
// sun if the sun is on that side at all, else straight out.
const SUN_TURN = Math.PI / 3;
export function towardSun(x, z, fx, fz) {
  let ox = fx - x, oz = fz - z;
  const l = Math.hypot(ox, oz) || 1;
  ox /= l;
  oz /= l;
  const dot = ox * SUN_DIR[0] + oz * SUN_DIR[1];
  if (dot <= 0) return [fx, fz];
  const angle = Math.acos(Math.min(1, dot));
  if (angle <= SUN_TURN) return [x + SUN_DIR[0] * 6, z + SUN_DIR[1] * 6];
  const turn = Math.sign(ox * SUN_DIR[1] - oz * SUN_DIR[0]) * SUN_TURN, c = Math.cos(turn), sn = Math.sin(turn);
  return [x + (ox * c - oz * sn) * 6, z + (ox * sn + oz * c) * 6];
}

// A free slot of group gi, or -1; taken.n: how many are taken.
const taken = {n: 0};
function freeSlot(occ, gi, id, h, space) {
  const first = occ.groups[gi * 2], count = occ.groups[gi * 2 + 1], s = occ.spots;
  let free = -1;
  taken.n = 0;
  for (let i = first; i < first + count; i++) {
    const o = i * SPOT_STRIDE;
    if (spotClear(s[o], s[o + 1], id, space, h, space)) { if (free < 0) free = i; }
    else taken.n++;
  }
  return free;
}

const CLUSTER_LOOK = 12;       // groups weighed per pick (the best few with room)
const CLUSTER_TASTE = 3;       // units of rank a walker's taste may outweigh

// Cluster: family or workmates' group if it has room (else the nearest group to them
// with room); otherwise the best of the first few groups with room, by rank, a stable
// taste of the walker's, a pull toward groups already talking and away from the
// busiest blocks. exclude: a group not to pick (the one just left); near: only groups
// within 10 of this point.
function pickCluster(state, p, task, occ, a, exclude = -1, near = null) {
  const groups = occ.groups, ng = groups.length / 2, h = hh(p), space = personalSpace(a, p.id);
  const k = exclude < 0 && a.kin ? kinAt(p, task, occ.layout) : null;
  if (k) {
    let best = -1, bestD = 4;
    for (let gi = 0; gi < ng; gi++) {
      const o = groups[gi * 2] * SPOT_STRIDE, d = Math.hypot(occ.spots[o] - k.x, occ.spots[o + 1] - k.z);
      if (d < bestD && freeSlot(occ, gi, p.id, h, space) >= 0) { bestD = d; best = gi; }
    }
    if (best >= 0) return clustered(occ, freeSlot(occ, best, p.id, h, space), p, task);
  }
  let pick = -1, pickS = Infinity, seen = 0;
  for (let gi = 0; gi < ng && seen < CLUSTER_LOOK; gi++) {
    if (gi === exclude) continue;
    const o = groups[gi * 2] * SPOT_STRIDE;
    if (occ.spots[o + 5] === 1 && pick >= 0) break;          // inner groups with room come first
    if (near && Math.hypot(occ.spots[o] - near[0], occ.spots[o + 1] - near[1]) > 10) continue;
    const i = freeSlot(occ, gi, p.id, h, space);
    if (i < 0) continue;
    seen++;
    const talking = taken.n > 0 ? 1.8 : 0;
    const score = gi * 0.25 + hashUnit((p.id * 131 + gi * 17 + (p.rev | 0) * 7) >>> 0) * CLUSTER_TASTE - talking + 0.12 * densityAt(state, occ.spots[o], occ.spots[o + 1]);
    if (score < pickS) { pickS = score; pick = i; }
  }
  return pick >= 0 ? clustered(occ, pick, p, task) : null;
}

// A cluster slot: a lone one is a browse at the stall, any other a mingle.
function clustered(occ, i, p, task) {
  const g = occ.spots[i * SPOT_STRIDE + 4];
  const id = occ.groups[g * 2 + 1] > 1 ? 'mingle' : 'browse';
  return spotAt(occ, i, id, firstHop(ACTIVITIES[id], hashUnit((p.id * 43 + (task.relax ?? 0) * 5 + 11) >>> 0)));
}

// Appeal: with family already here and the activity's kin rule a picnic, beside them;
// otherwise the most appealing free spot of the first few, by taste (and, with family
// here but no room beside them, nearness to them), well away from strangers; then one
// of the activities sharing the layout, by weight and preference.
const APPEAL_LOOK = 6;
const KIN_JOIN = 0.65;
const KIN_NEAR = 0.8;            // per unit from the family, against appeal and order: something of their own, nearby

function pickAppeal(state, p, task, occ, a) {
  const s = occ.spots, n = s.length / SPOT_STRIDE, h = hh(p);
  const space = personalSpace(a, p.id);
  const k = a.kin ? kinAt(p, task, occ.layout) : null;
  // Most join the family's picnic; the rest find something of their own nearby.
  if (k && k.household && a.kin === 'picnic' && hashUnit((p.id * 61 + 5) >>> 0) < KIN_JOIN) {
    const spot = PICKERS['beside-kin'](state, p, task, occ, ACTIVITIES.picnic, k);
    if (spot) return spot;
  }
  let pick = -1, pickS = Infinity, seen = 0;
  const look = k ? APPEAL_LOOK * 4 : APPEAL_LOOK;
  for (let i = 0; i < n && seen < look; i++) {
    const o = i * SPOT_STRIDE;
    if (!spotClear(s[o], s[o + 1], p.id, space, h, KIN_SPACE)) continue;
    let score = i * 0.15 - s[o + 6] + hashUnit((p.id * 173 + i * 29 + (p.rev | 0)) >>> 0) * 1.5 + 0.1 * densityAt(state, s[o], s[o + 1]);
    if (k) score += KIN_NEAR * Math.hypot(s[o] - k.x, s[o + 1] - k.z);
    seen++;
    if (score < pickS) { pickS = score; pick = i; }
  }
  if (pick < 0) return null;
  // Part of the lawn's mix (weighted): settle which; an outing's own activity stays.
  const id = !task.outing && (ACTIVITIES[task.activity]?.weight ?? 0) > 0 ? chooseActivity(state, occ.layout, hashUnit((p.id * 37 + 17) >>> 0)) ?? task.activity : task.activity;
  return spotAt(occ, pick, id, firstHop(ACTIVITIES[id], hashUnit((p.id * 7 + 1) >>> 0)));
}

// Beside kin: a free place on a small ring round a family member's spot (inside the
// park and off its paths), facing them.
function pickBesideKin(state, p, task, occ, a, k = kinAt(p, task, occ.layout)) {
  if (!k) return null;
  const {walls: blocked} = footprints(state);
  const b = occ.park, h = hh(p);
  const space = Math.min(personalSpace(a, p.id), a.space[0]);
  const a0 = hashUnit(p.id * 59 + 3) * Math.PI * 2;
  for (let t = 0; t < 16; t++) {
    const ang = a0 + t * (Math.PI / 4) + (t >= 8 ? Math.PI / 8 : 0), r = t < 8 ? 0.95 : 1.45;
    const x = k.x + Math.cos(ang) * r, z = k.z + Math.sin(ang) * r;
    if (b && (Math.abs(x - b.x) > b.w / 2 - 0.6 || Math.abs(z - b.z) > b.d / 2 - 0.6 || pathDistance(b, x, z) < PATH_CLEAR)) continue;
    if (!standable(state, blocked, x, z) || !spotClear(x, z, p.id, space, h, KIN_SPACE)) continue;
    return {x, z, fx: k.x, fz: k.z, group: -1, edge: false, activity: 'picnic', hopIn: null};
  }
  return null;
}

const PICKERS = {front: pickFront, cluster: pickCluster, appeal: pickAppeal, 'beside-kin': pickBesideKin};

// ---------------------------------------------------------------------------
// Wanders: moving on during the dwell
//
// wanderRoute(state, p, task, occ) -> flat [x, z, ...] to walk now, or null; updates
// the task (its spot, group, face and activity for a move to another group; its next
// hop). Every leg is a clear straight step on standable ground.

export function wanderRoute(state, p, task, occ) {
  const a = ACTIVITIES[task.activity];
  task.hopAt = null;
  if (!occ || !task.spot || !a?.wander) return null;
  return WANDERS[a.wander](state, p, task, occ, a);
}

// Regroup: drift to another conversation group nearby (a straight step away).
function regroup(state, p, task, occ, a) {
  const next = pickCluster(state, p, task, occ, a, task.group ?? -1, [p.x, p.z]);
  if (!next || !stepClear(state, p.x, p.z, next.x, next.z)) return null;
  task.spot = [next.x, next.z];
  task.face = [next.fx, next.fz];
  task.group = next.group;
  task.activity = next.activity;
  if (hashUnit((p.id * 71 + Math.floor(task.dwell * 10)) >>> 0) < a.hop.again) task.hopAt = task.dwell + a.hop.after[0];
  return [next.x, next.z];
}

// A walk through points, each leg a clear straight step on standable ground within the
// bounds (b: a building's rectangle, less 0.4), cut short where a leg is not clear, and
// back to (sx, sz) from the last point that can get there. Reusable for any loop.
export function loopRoute(state, x0, z0, pts, sx, sz, b = null) {
  const {walls: blocked} = footprints(state);
  const out = [];
  let lx = x0, lz = z0;
  for (let k = 0; k + 1 < pts.length; k += 2) {
    const x = pts[k], z = pts[k + 1];
    if (b && (Math.abs(x - b.x) >= b.w / 2 - 0.4 || Math.abs(z - b.z) >= b.d / 2 - 0.4)) break;
    if (!standable(state, blocked, x, z) || !stepClear(state, lx, lz, x, z)) break;
    out.push(x, z);
    lx = x;
    lz = z;
  }
  while (out.length && !stepClear(state, out[out.length - 2], out[out.length - 1], sx, sz)) out.length -= 2;
  if (!out.length) return null;
  out.push(sx, sz);
  return out;
}

// Loop: a small loop round the spot (a game of chase, a kickabout), back to it; again
// every hop.every seconds.
function playLoop(state, p, task, occ, a) {
  const [sx, sz] = task.spot;
  const seed = (p.id * 89 + Math.floor(task.dwell * 10) * 13) >>> 0;
  const a0 = hashUnit(seed) * Math.PI * 2, dir = hashUnit(seed + 1) < 0.5 ? 1 : -1;
  const n = 3 + (hash32(seed + 2) % 3), pts = [];
  for (let k = 0; k < n; k++) {
    const ang = a0 + dir * (k / n) * Math.PI * 2, r = 1 + 1.2 * hashUnit(seed + 3 + k);
    pts.push(sx + Math.cos(ang) * r, sz + Math.sin(ang) * r);
  }
  const every = a.hop.every;
  task.hopAt = task.dwell + every[0] + hashUnit(seed + 9) * (every[1] - every[0]);
  return loopRoute(state, p.x, p.z, pts, sx, sz, occ.park);
}

// Ring: once round the park's path ring from the nearest point, then back to the spot.
function ringStroll(state, p, task, occ) {
  const b = occ.park;
  if (!b) return null;
  const [sx, sz] = task.spot;
  const seed = (p.id * 89 + Math.floor(task.dwell * 10) * 13) >>> 0;
  const R = parkRingRadius(b), a0 = Math.atan2(sz - b.z, sx - b.x), dir = hashUnit(seed + 4) < 0.5 ? 1 : -1;
  const pts = [];
  for (let k = 0; k <= 8; k++) {
    const ang = a0 + dir * (k / 8) * Math.PI * 2;
    pts.push(b.x + Math.cos(ang) * R, b.z + Math.sin(ang) * R);
  }
  return loopRoute(state, p.x, p.z, pts, sx, sz, b);
}

// Edge: along the woods' edge, following the field's contour through the walker's spot
// (woodland.js), WOOD_LEGS legs out and the same way back.
const WOOD_LEG = 3.5, WOOD_LEGS = 7;
const woodGrad = (x, z) => {
  const h = 0.5;
  const gx = (woodField(x + h, z) - woodField(x - h, z)) / (2 * h), gz = (woodField(x, z + h) - woodField(x, z - h)) / (2 * h);
  const l = Math.hypot(gx, gz) || 1;
  return [gx / l, gz / l, l];
};

export function edgeWalk(state, p, task) {
  const [sx, sz] = task.spot;
  const level = woodField(sx, sz), dir = hashUnit((p.id * 131 + (p.rev | 0)) >>> 0) < 0.5 ? 1 : -1;
  const pts = [];
  let x = sx, z = sz;
  for (let k = 0; k < WOOD_LEGS; k++) {
    // Along the contour (across the field's gradient), then back onto it.
    let [gx, gz] = woodGrad(x, z);
    x += -gz * dir * WOOD_LEG;
    z += gx * dir * WOOD_LEG;
    const [hx, hz, g] = woodGrad(x, z);
    const e = Math.max(-0.05, Math.min(0.05, woodField(x, z) - level));
    x -= (e / g) * hx;
    z -= (e / g) * hz;
    pts.push(x, z);
  }
  for (let k = pts.length - 4; k >= 0; k -= 2) pts.push(pts[k], pts[k + 1]);
  return loopRoute(state, p.x, p.z, pts, sx, sz);
}

// Perimeter: once round the inside of a park's hedge, from the nearest corner.
function perimeterWalk(state, p, task, occ) {
  const b = occ.park;
  if (!b) return null;
  const [sx, sz] = task.spot;
  const hw = b.w / 2 - 0.9, hd = b.d / 2 - 0.9;
  const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  let start = 0, best = Infinity;
  corners.forEach(([cx, cz], i) => {
    const d = Math.hypot(b.x + cx - sx, b.z + cz - sz);
    if (d < best) { best = d; start = i; }
  });
  const dir = hashUnit((p.id * 17 + 5) >>> 0) < 0.5 ? 1 : 3;
  const pts = [];
  for (let k = 0; k <= 4; k++) {
    const [cx, cz] = corners[(start + k * dir) % 4];
    pts.push(b.x + cx, b.z + cz);
  }
  return loopRoute(state, p.x, p.z, pts, sx, sz, b);
}

const WANDERS = {regroup, loop: playLoop, ring: ringStroll, edge: edgeWalk, perimeter: perimeterWalk};

