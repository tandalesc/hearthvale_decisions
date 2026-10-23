// The renderer's window on the simulation (contract §6). The renderer never reads sim
// internals; it reads this view. Call view.sync(state, {now, speed}) once per frame.
//
//   view.people        Float32Array, PERSON_STRIDE (16) floats per walker:
//                        0-2  x, y, z      position at time t0 (y = ground, bridge deck or ford bed)
//                        3-5  vx, vy, vz   velocity in units per renderer second (already x speed)
//                        6    t0           renderer time of the row (same clock as `now`)
//                        7    phase        gait phase offset
//                        8    gait         0 idle, ~1 walking (scaled by speed)
//                        9    action       0 none, 1 carry, 2 build, 3 sit, 4 cheer, 5 protest, 6 dance
//                        10   actionT0     renderer time the action began
//                        11-13 skin, cloth, hat   palette indices
//                        14   scale        0 while indoors (hidden), about 1 otherwise
//                        15   facing       radians, atan2(vx, vz)
//                      The shader extrapolates pos = xyz + v * (uTime - t0).
//                      With createRenderView(state, {rowFloats: 20}) each row has 4 more:
//                        16   t1           renderer time the walker reaches its current
//                                          waypoint; clamp: pos = xyz + v * (min(uTime, t1) - t0)
//                        17-18 wx, wz      that waypoint (the corner), for exact clamping
//                        19   onDeck       1 while the walker or its waypoint is on a bridge deck:
//                                          use the row's y (+ vy) there, not the ground
//   Rows are slots: each person keeps one row for as long as they walk, whatever their
//   place in state.people (the save's tick order), and a person who leaves frees theirs
//   (scale 0, id -1) for the next newcomer. So rows can have holes.
//   view.peopleCount   rows in use: one past the highest live slot (holes included).
//   view.peopleDirty   {start, end, list, count} | null: the rows written since the consumer
//                      last set it to null. list[0..count) are those rows (each once, in no
//                      order); start..end (end exclusive) bounds them.
//   view.peopleVersion bumps when the Float32Array is replaced (capacity grew): re-bind it.
//   view.peopleIds     Int32Array: the person id written in each row (-1 for none), for picking.
//   view.rowOf(id)     the row of a person id, or -1.
//   view.buildings     state.buildings (records as in contract §3)
//   view.buildingEvents [{kind: 'add'|'update'|'remove', id}] appended by each sync; the
//                      consumer empties it (length = 0) after reading. Besides b.rev bumps,
//                      a rolling check of the visible fields catches untouched changes.
//   view.roads         state.roads; view.bridges; view.lamps; view.projects; view.embankments
//                      [{side: 'west'|'east', z0, z1}] (sim-world's embankmentViews)
//   view.centres       [{id, name, x, z, kind, rank, pop}] for centre name labels
//   view.attention     [{bodyId, buildingId, x, z, color, urgent}]: one per body with a live
//                      docket card, so the renderer can raise a pennant on its building.
//   Building records also carry sim-world's foundation, foundationY, foundationDrop and
//   bankDistance (same objects as state.buildings).
//   view.worldEvents, view.weather, view.time {year, month, season, seasonT, yearT, monthT}
//   view.era, view.archetype, view.styleEra (alias of era)
//
// `now` is in seconds on the renderer's clock (default performance.now() / 1000);
// view.sync(state, nowSeconds) is accepted too.
// `speed` is the sim speed multiplier (0 when paused, default 1). A speed change
// rewrites every row.

import {walkerY, deckAt, DECK_STEP} from './people.js';
import {hashUnit} from './rng.js';
import {TICK_SECONDS, TICKS_PER_MONTH, MONTHS_PER_YEAR, season} from './clock.js';
import {LAMP, byId} from './state.js';
import {findHook} from './hooks.js';
import {embankmentViews, bridgeViews} from './works.js';

export const PERSON_STRIDE = 16;          // default row size
export const PERSON_STRIDE_EXTENDED = 20; // rows with the segment end (rowFloats: 20)
// On-screen speed (units per renderer second) the gait cycle was drawn for.
const GAIT_SPEED = 1.4;
const REFRESH_AGE = 2;          // seconds before a moving row is re-anchored (drift control)

export function createRenderView(state, {capacity = 0, rowFloats = PERSON_STRIDE_EXTENDED} = {}) {
  const view = {
    people: new Float32Array(0),
    peopleCount: 0,
    peopleDirty: null,
    peopleVersion: 0,
    buildings: state.buildings,
    buildingEvents: [],
    roads: state.roads,
    bridges: [],
    lamps: [],
    embankments: [],
    attention: [],
    centres: [],
    projects: [],
    worldEvents: state.worldEvents,
    weather: state.weather,
    time: {year: 0, month: 0, season: 0, seasonT: 0, yearT: 0, monthT: 0},
    era: state.era,
    styleEra: state.era,
    archetype: state.archetype,
    rowFloats: rowFloats === PERSON_STRIDE_EXTENDED ? PERSON_STRIDE_EXTENDED : PERSON_STRIDE,
    sync: (s, opts) => sync(view, inner, s, opts),
    rowOf: (id) => inner.slotOf.get(id) ?? -1,
  };
  const inner = {
    rowId: new Int32Array(0),
    rowRev: new Uint32Array(0),
    rowT: new Float32Array(0),
    rowOpen: new Uint8Array(0), // 1 = the row's waypoint is a corner, not the route's end
    rowGen: new Uint32Array(0), // the sync that last found the row's person
    slotOf: new Map(),          // person id -> row
    free: [],                   // rows given up, for newcomers
    high: 0,                    // one past the highest row in use
    peopleGen: 0,
    slotAt: new Int32Array(0),  // state.people index -> row, as of the last sync (a hint)
    dirtyFlag: new Uint8Array(0),
    dirtyList: new Int32Array(0),
    speed: -1,
    cursor: 0,
    verifyCursor: 0,
    seen: new Map(),       // building id -> {rev, gen}
    gen: 0,
    buildingsRev: -1,
    buildingsRef: null,
    roadsVersion: -1,
    roadsRef: null,
    embankRev: -1,
    attentionKey: '',
    centresKey: '',
    dirty: {start: 0, end: 0, list: null, count: 0},
  };
  grow(view, inner, Math.max(capacity, state.people.length, 64));
  return view;
}

function grow(view, inner, rows) {
  const stride = view.rowFloats;
  const cap = Math.max(rows, Math.ceil(view.people.length / stride * 1.5));
  const people = new Float32Array(cap * stride);
  people.set(view.people.subarray(0, Math.min(view.people.length, people.length)));
  view.people = people;
  const rowId = new Int32Array(cap).fill(-1);
  rowId.set(inner.rowId.subarray(0, Math.min(inner.rowId.length, cap)));
  inner.rowId = rowId;
  view.peopleIds = rowId;
  const rowRev = new Uint32Array(cap);
  rowRev.set(inner.rowRev.subarray(0, Math.min(inner.rowRev.length, cap)));
  inner.rowRev = rowRev;
  const rowT = new Float32Array(cap);
  rowT.set(inner.rowT.subarray(0, Math.min(inner.rowT.length, cap)));
  inner.rowT = rowT;
  const rowOpen = new Uint8Array(cap);
  rowOpen.set(inner.rowOpen.subarray(0, Math.min(inner.rowOpen.length, cap)));
  inner.rowOpen = rowOpen;
  const rowGen = new Uint32Array(cap);
  rowGen.set(inner.rowGen.subarray(0, Math.min(inner.rowGen.length, cap)));
  inner.rowGen = rowGen;
  const flag = new Uint8Array(cap);
  flag.set(inner.dirtyFlag.subarray(0, Math.min(inner.dirtyFlag.length, cap)));
  inner.dirtyFlag = flag;
  const list = new Int32Array(cap);
  list.set(inner.dirtyList.subarray(0, Math.min(inner.dirtyList.length, cap)));
  inner.dirtyList = list;
  inner.dirty.list = list;
  view.peopleVersion++;
}

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

function sync(view, inner, state, opts = {}) {
  if (typeof opts === 'number') opts = {now: opts};
  const now = opts.now ?? defaultNow();
  const speed = opts.speed ?? 1;
  syncPeople(view, inner, state, now, speed);
  syncBuildings(view, inner, state);
  syncRoads(view, inner, state);
  syncProjects(view, state);
  syncAttention(view, inner, state);
  syncCentres(view, inner, state);
  syncTime(view.time, state.time);
  view.roads = state.roads;
  view.worldEvents = state.worldEvents;
  view.weather = state.weather;
  view.era = state.era;
  view.styleEra = state.era;
  view.archetype = state.archetype;
  // Gardens, eyesores and parks (aesthetics.js): read by the decor layer.
  view.aesthetics = state.aesthetics ?? null;
  view.landscape = state.landscape ?? null;
  return view;
}

// ---------------------------------------------------------------------------
// People

function syncPeople(view, inner, state, now, speed) {
  const people = state.people;
  const n = people.length;
  if (inner.slotAt.length < n) {
    const at = new Int32Array(Math.max(n, Math.ceil(inner.slotAt.length * 1.5))).fill(-1);
    at.set(inner.slotAt);
    inner.slotAt = at;
  }
  if (n * view.rowFloats > view.people.length) grow(view, inner, n);
  const force = speed !== inner.speed;
  inner.speed = speed;
  const lag = state.time.acc ?? 0;      // sim seconds since the last tick
  const dirty = inner.dirty;
  if (view.peopleDirty == null) {
    // A new set: forget the last one's rows.
    const flag = inner.dirtyFlag, list = inner.dirtyList;
    for (let k = 0; k < dirty.count; k++) flag[list[k]] = 0;
    dirty.count = 0;
    dirty.start = Infinity;
    dirty.end = 0;
  }

  const stride = view.rowFloats;
  const gen = ++inner.peopleGen;
  const {slotOf, slotAt} = inner;
  // (A newcomer can grow the arrays: they are read again after one.)
  let buf = view.people, {rowId, rowRev, rowOpen, rowGen} = inner;
  for (let i = 0; i < n; i++) {
    const p = people[i];
    let r = slotAt[i];
    if (r < 0 || rowId[r] !== p.id) {
      r = slotOf.get(p.id) ?? -1;
      if (r < 0) {
        r = takeSlot(view, inner, p.id);
        buf = view.people;
        ({rowId, rowRev, rowOpen, rowGen} = inner);
      }
      slotAt[i] = r;
    }
    rowGen[r] = gen;
    // A row also renews when its walker reaches a corner before the next tick
    // (its waypoint time has passed), so they turn it instead of waiting there.
    const turn = speed > 0 && rowOpen[r] === 1 && stride === PERSON_STRIDE_EXTENDED && buf[r * stride + 16] <= now;
    if (!force && !turn && rowRev[r] === p.rev && rowId[r] === p.id) continue;
    rowOpen[r] = writeRow(buf, stride, r, p, state, now, speed, lag);
    rowId[r] = p.id;
    rowRev[r] = p.rev;
    inner.rowT[r] = now;
    markRow(inner, r);
  }
  // Rows whose person has gone: hidden where they stood, and free for a newcomer.
  if (slotOf.size > n) {
    for (let r = 0; r < inner.high; r++) {
      if (rowId[r] < 0 || rowGen[r] === gen) continue;
      slotOf.delete(rowId[r]);
      rowId[r] = -1;
      rowOpen[r] = 0;
      const o = r * stride;
      for (let k = 3; k < 6; k++) buf[o + k] = 0;
      buf[o + 8] = 0;
      buf[o + 14] = 0;
      if (stride === PERSON_STRIDE_EXTENDED) buf[o + 16] = now;
      inner.free.push(r);
      markRow(inner, r);
    }
    while (inner.high > 0 && rowId[inner.high - 1] < 0) inner.high--;
  }
  refreshStale(view, inner, state, now, speed, lag, n);
  view.peopleCount = inner.high;
  view.peopleDirty = dirty.count ? dirty : null;
}

// A row for a person seen for the first time: one given up by someone who left, else
// the next after the highest in use.
function takeSlot(view, inner, id) {
  let r = -1;
  while (inner.free.length) {
    const f = inner.free.pop();
    if (inner.rowId[f] < 0) { r = f; break; }
  }
  if (r < 0) {
    while (inner.high < inner.rowId.length && inner.rowId[inner.high] >= 0) inner.high++;
    if ((inner.high + 1) * view.rowFloats > view.people.length) grow(view, inner, inner.high + 64);
    r = inner.high;
  }
  if (r + 1 > inner.high) inner.high = r + 1;
  inner.rowId[r] = id;
  inner.rowRev[r] = 0;
  inner.rowOpen[r] = 0;
  inner.slotOf.set(id, r);
  return r;
}

function markRow(inner, r) {
  if (inner.dirtyFlag[r]) return;
  inner.dirtyFlag[r] = 1;
  const d = inner.dirty;
  d.list[d.count++] = r;
  if (r < d.start) d.start = r;
  if (r + 1 > d.end) d.end = r + 1;
}

// Re-anchor a slice of long-running moving rows each frame so the extrapolation never
// drifts far from the sim (frame clamping, tick quantisation).
function refreshStale(view, inner, state, now, speed, lag, n) {
  if (!n || speed === 0) return;
  const batch = Math.max(8, Math.ceil(n / 60));
  for (let k = 0; k < batch; k++) {
    const i = inner.cursor++ % n;
    const p = state.people[i];
    const r = inner.slotAt[i];
    if (p.speed <= 0 || now - inner.rowT[r] < REFRESH_AGE) continue;
    inner.rowOpen[r] = writeRow(view.people, view.rowFloats, r, p, state, now, speed, lag);
    inner.rowT[r] = now;
    markRow(inner, r);
  }
  if (inner.cursor > 1e9) inner.cursor = 0;
}

// Writes row i and returns 1 when its waypoint is a corner with more route
// after it (the row then renews on reaching it), else 0.
function writeRow(buf, stride, i, p, state, now, speed, lag) {
  const o = i * stride;
  const moving = p.speed > 0;
  const route = p.task?.route;
  // Carried on along the route by the time since the last tick, as the sim
  // will move them (move() in people.js), turning any corners on the way. The
  // row then points at the waypoint ahead of that spot: a row is extrapolated
  // in a straight line, and never past its waypoint (writeSegmentEnd).
  let x = p.x, z = p.z, vx = p.vx, vz = p.vz;
  let seg = moving && route ? p.task.seg : Infinity;
  if (seg + 1 < route?.length) {
    let budget = p.speed * lag;
    while (budget > 0 && seg + 1 < route.length) {
      const dx = route[seg] - x, dz = route[seg + 1] - z;
      const dist = Math.hypot(dx, dz);
      if (dist <= budget) {
        x = route[seg];
        z = route[seg + 1];
        budget -= dist;
        seg += 2;
      } else {
        x += (dx / dist) * budget;
        z += (dz / dist) * budget;
        budget = 0;
      }
    }
    if (seg !== p.task.seg && seg + 1 < route.length) {
      const dx = route[seg] - x, dz = route[seg + 1] - z;
      const dist = Math.hypot(dx, dz) || 1;
      vx = (dx / dist) * p.speed;
      vz = (dz / dist) * p.speed;
    }
  }
  const hasWaypoint = seg + 1 < (route?.length ?? 0);
  const y = walkerY(state, x, z);
  // Vertical speed: from here to the current waypoint, so ramps and decks are followed.
  let vy = 0;
  let segmentOnDeck = false;
  if (hasWaypoint) {
    // Aim at the waypoint, or one re-anchor step ahead on a deck (people.DECK_STEP).
    const wx = route[seg], wz = route[seg + 1];
    const dist = Math.hypot(wx - x, wz - z);
    segmentOnDeck = crossesDeck(state, x, z, wx, wz);
    const step = segmentOnDeck ? Math.min(dist, DECK_STEP) : dist;
    if (step > 1e-3) vy = ((walkerY(state, x + ((wx - x) * step) / dist, z + ((wz - z) * step) / dist) - y) * p.speed) / step;
  }
  const simNow = state.time.tick * TICK_SECONDS + lag;
  buf[o] = x;
  buf[o + 1] = y;
  buf[o + 2] = z;
  const live = moving && speed > 0;
  buf[o + 3] = live ? vx * speed : 0;
  buf[o + 4] = live ? vy * speed : 0;
  buf[o + 5] = live ? vz * speed : 0;
  buf[o + 6] = now;
  buf[o + 7] = p.phase;
  buf[o + 8] = live ? (p.speed * speed) / GAIT_SPEED : 0;
  buf[o + 9] = p.action;
  buf[o + 10] = speed > 0 ? now - Math.max(0, simNow - p.actionT) / speed : now;
  buf[o + 11] = p.look.skin;
  buf[o + 12] = p.look.cloth;
  buf[o + 13] = p.look.hat;
  buf[o + 14] = p.indoor ? 0 : 0.9 + 0.2 * hashUnit(p.id);
  buf[o + 15] = seg === p.task?.seg || !hasWaypoint ? p.heading : Math.atan2(vx, vz);
  if (stride === PERSON_STRIDE_EXTENDED) writeSegmentEnd(buf, o, p, x, z, seg, now, speed, live, state, segmentOnDeck);
  return live && route && seg + 3 < route.length ? 1 : 0;
}

// The current waypoint and when the walker gets there (renderer clock). The shader
// stops extrapolating at t1, so a late row update never carries a walker past a corner.
function writeSegmentEnd(buf, o, p, x, z, seg, now, speed, live, state, segmentOnDeck) {
  const route = p.task?.route;
  const ahead = live && route && seg + 1 < route.length;
  if (ahead) {
    const wx = route[seg], wz = route[seg + 1];
    buf[o + 16] = now + Math.hypot(wx - x, wz - z) / (p.speed * speed);
    buf[o + 17] = wx;
    buf[o + 18] = wz;
  } else {
    buf[o + 16] = now;
    buf[o + 17] = x;
    buf[o + 18] = z;
  }
  // The height calculation already sampled this same segment for a live walker.
  const onDeck = ahead ? segmentOnDeck : deckAt(state, x, z);
  buf[o + 19] = onDeck ? 1 : 0;
}

// Does the walk from (x0, z0) to (x1, z1) touch a bridge deck? Sampled every unit.
function crossesDeck(state, x0, z0, x1, z1) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0)));
  for (let i = 0; i <= steps; i++) {
    if (deckAt(state, x0 + ((x1 - x0) * i) / steps, z0 + ((z1 - z0) * i) / steps)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Buildings: add / update / remove events by id and rev.

const EVENTS_CAP = 50000;   // a consumer that never reads must not grow this forever

function syncBuildings(view, inner, state) {
  view.buildings = state.buildings;
  if (view.buildingEvents.length > EVENTS_CAP) view.buildingEvents.length = 0;
  verifySlice(view, inner, state);
  if (state.buildingsRev === inner.buildingsRev && state.buildings === inner.buildingsRef) return;
  inner.buildingsRev = state.buildingsRev;
  inner.buildingsRef = state.buildings;
  const gen = ++inner.gen;
  const events = view.buildingEvents;
  for (const b of state.buildings) {
    const seen = inner.seen.get(b.id);
    if (!seen) {
      inner.seen.set(b.id, {rev: b.rev ?? 0, gen, sig: signature(b)});
      events.push({kind: 'add', id: b.id});
    } else {
      seen.gen = gen;
      if (seen.rev !== (b.rev ?? 0)) {
        seen.rev = b.rev ?? 0;
        seen.sig = signature(b);
        events.push({kind: 'update', id: b.id});
      }
    }
  }
  for (const [id, seen] of inner.seen) {
    if (seen.gen !== gen) {
      inner.seen.delete(id);
      events.push({kind: 'remove', id});
    }
  }
  rebuildBridges(view, state);
}

// Check about a thirtieth of the buildings each frame for visible changes that nobody
// announced with touchBuilding, so a missed rev bump shows up within half a second.
function verifySlice(view, inner, state) {
  const list = state.buildings;
  const n = list.length;
  if (!n) return;
  const batch = Math.max(16, Math.ceil(n / 30));
  for (let k = 0; k < batch && k < n; k++) {
    const b = list[inner.verifyCursor++ % n];
    const seen = inner.seen.get(b.id);
    if (!seen) continue;
    const sig = signature(b);
    if (sig !== seen.sig) {
      seen.sig = sig;
      seen.rev = b.rev ?? 0;
      view.buildingEvents.push({kind: 'update', id: b.id});
    }
  }
  if (inner.verifyCursor > 1e9) inner.verifyCursor = 0;
}

// A cheap numeric digest of the fields the renderer draws.
function signature(b) {
  let h = 17;
  const mix = (v) => { h = (Math.imul(h, 31) + (v | 0)) | 0; };
  mix(b.x * 8); mix(b.z * 8); mix(b.w * 8); mix(b.d * 8); mix(b.rot); mix(b.tier); mix(b.storeys);
  mix(b.styleEra); mix((b.built ?? 1) * 100); mix((b.wealth ?? 0) * 100); mix((b.condition ?? 1) * 100);
  mix((b.smoke ?? 0) * 100); mix(b.lit ? 1 : 0); mix(b.occupied ? 1 : 0); mix(b.open ? 1 : 0); mix(b.chimney ? 1 : 0);
  mix(b.extensions?.length ?? 0);
  mix((b.foundationY ?? 0) * 100); mix((b.foundationDrop ?? 0) * 100);
  for (const s of [b.banner, b.material, b.variant, b.type, b.foundation]) {
    if (!s) { mix(0); continue; }
    for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
  }
  const f = b.flags;
  if (f) mix((f.heritage ? 1 : 0) | (f.derelict ? 2 : 0) | (f.scaffold ? 4 : 0));
  return h;
}


// sim-world's bridgeViews(state) decides the shape ({id, a, b, width, style, built}
// once endpoints land); the deck width is added if it is missing.
function rebuildBridges(view, state) {
  view.bridges = bridgeViews(state).map((v) => {
    const b = byId(state, 'buildings', v.id);
    return {...v, width: v.width ?? b?.d, d: v.d ?? v.width ?? b?.d};
  });
}

// ---------------------------------------------------------------------------
// Roads: lamps are rebuilt when roads.version changes (sim-world bumps it on any tier or
// planned-flag change).

function syncRoads(view, inner, state) {
  const roads = state.roads;
  if (roads.version === inner.roadsVersion && roads === inner.roadsRef && (roads.embankRev ?? 0) === inner.embankRev) return;
  inner.roadsVersion = roads.version;
  inner.roadsRef = roads;
  inner.embankRev = roads.embankRev ?? 0;
  view.embankments = embankmentViews(state);
  view.lamps.length = 0;
  const {planned, W, cell, ox, oz} = roads;
  for (let c = 0; c < planned.length; c++) {
    if (!(planned[c] & LAMP)) continue;
    view.lamps.push({x: ox + ((c % W) + 0.5) * cell, z: oz + (Math.floor(c / W) + 0.5) * cell});
  }
}

// ---------------------------------------------------------------------------
// Attention pennants: bodies with a live card on the docket. sim-governance may provide
// bodyColor(state, bodyId) and bodyBuilding(state, bodyId) hooks; otherwise a body's
// colour comes from the table below and its building from its kind (the moot hall as a
// last resort). Rebuilt only when the docket or the buildings change.

const BODY_COLORS = {
  moot: '#b5543c', 'agri-council': '#6f8f3a', 'trades-guild': '#a7742f', exchange: '#c9a227',
  'river-authority': '#3f7fa6', 'school-board': '#5a6fb0', parish: '#8a5aa6', 'health-board': '#3e9a86',
  planning: '#7a7f86', union: '#c23b3b', watch: '#34495e', 'arts-society': '#d0699a',
};
const BODY_BUILDINGS = {
  moot: ['moot'], parish: ['chapel'], 'school-board': ['school', 'library'], 'health-board': ['infirmary', 'bathhouse'],
  watch: ['watch'], exchange: ['exchange', 'market'], union: ['union-hall'], 'trades-guild': ['workshop', 'market'],
  'agri-council': ['farm'], 'river-authority': ['quay', 'warehouse', 'bridge'], 'arts-society': ['theatre'], planning: ['moot'],
};

function syncAttention(view, inner, state) {
  let key = `${state.buildingsRev}`;
  for (const card of state.docket) key += `|${card.id}:${card.from}:${card.urgency ?? 0}:${card.surfacedMonth ?? ''}`;
  if (key === inner.attentionKey) return;
  inner.attentionKey = key;
  const byBody = new Map();
  for (const card of state.docket) {
    if (!card.from || card.kind === 'report') continue;
    if ('surfacedMonth' in card && card.surfacedMonth == null) continue;   // still queued, not yet shown
    const urgent = card.kind === 'demand' || (card.urgency ?? 0) >= 2;
    byBody.set(card.from, (byBody.get(card.from) ?? false) || urgent);
  }
  const colorHook = findHook('bodyColor'), buildingHook = findHook('bodyBuilding');
  view.attention = [];
  for (const [bodyId, urgent] of byBody) {
    const inst = state.institutions.find((i) => i.id === bodyId);
    const kind = inst?.kind ?? bodyId;
    const b = buildingHook?.(state, bodyId) ?? buildingForBody(state, kind);
    if (!b) continue;
    view.attention.push({bodyId, buildingId: b.id, x: b.x, z: b.z, color: colorHook?.(state, bodyId) ?? BODY_COLORS[kind] ?? '#b5543c', urgent});
  }
}

function buildingForBody(state, kind) {
  for (const type of [...(BODY_BUILDINGS[kind] ?? []), 'moot']) {
    let best = null;
    for (const b of state.buildings) {
      if (b.type === type && b.built >= 1 && (!best || (b.tier ?? 1) > (best.tier ?? 1))) best = b;
    }
    if (best) return best;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Centre labels: [{id, name, x, z, kind, rank, pop}] for live centres, rebuilt when a
// centre is founded, renamed, re-ranked or moves a whole unit.

function syncCentres(view, inner, state) {
  const centres = state.centres ?? [];
  let key = '';
  for (const c of centres) key += `${c.id}:${c.name}:${c.kind}:${c.rank}:${c.pop}:${Math.round(c.x)}:${Math.round(c.z)}:${c.mergedInto ?? ''}|`;
  if (key === inner.centresKey) return;
  inner.centresKey = key;
  view.centres = centres.filter((c) => c.mergedInto == null).map((c) => ({id: c.id, name: c.name, x: c.x, z: c.z, kind: c.kind, rank: c.rank, pop: c.pop}));
}

// ---------------------------------------------------------------------------
// Construction sites, updated in place.

function syncProjects(view, state) {
  const out = view.projects;
  let n = 0;
  for (const pr of state.projects) {
    const site = projectSite(state, pr);
    if (!site) continue;
    const row = out[n] ?? (out[n] = {id: 0, x: 0, z: 0, w: 0, d: 0, progress: 0, kind: ''});
    row.id = pr.id;
    row.x = site.x;
    row.z = site.z;
    row.w = site.w;
    row.d = site.d;
    row.progress = pr.progress ?? 0;
    row.kind = pr.kind;
    n++;
  }
  out.length = n;
}

const siteScratch = {x: 0, z: 0, w: 0, d: 0};
function projectSite(state, pr) {
  if (pr.buildingId != null) {
    const b = byId(state, 'buildings', pr.buildingId);
    if (b) return fill(b.x, b.z, b.w, b.d);
  }
  if (pr.x != null) return fill(pr.x, pr.z, pr.w ?? 4, pr.d ?? 4);
  if (pr.cells?.length) {
    const r = state.roads;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const c of pr.cells) {
      const x = r.ox + ((c % r.W) + 0.5) * r.cell, z = r.oz + (Math.floor(c / r.W) + 0.5) * r.cell;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    return fill((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0 + r.cell, z1 - z0 + r.cell);
  }
  return null;
}

function fill(x, z, w, d) {
  siteScratch.x = x;
  siteScratch.z = z;
  siteScratch.w = w;
  siteScratch.d = d;
  return siteScratch;
}

function syncTime(out, time) {
  const monthT = ((time.tick % TICKS_PER_MONTH) + (time.acc ?? 0) / TICK_SECONDS) / TICKS_PER_MONTH;
  out.year = time.year;
  out.month = time.month;
  out.season = season(time.month);
  out.seasonT = ((time.month % 3) + monthT) / 3;
  out.yearT = (time.month + monthT) / MONTHS_PER_YEAR;
  out.monthT = monthT;
}
