// Centres: the valley can grow one city or a region of rival towns
// (design-centres.md §1-3). A centre is a core with its own market, its own
// downtown and its own pull on land value. New centres are born where
// composed conditions hold for a while: far from the old core, with people
// already living there, a local draw (a ford, a mill, a crossroads) and
// cheap land.
import { emitChronicle, setTag } from './state.js';
import { riverX, bankSide, slopeAt, bankDistance, FORDS, WATER_HALF, REGION } from '../terrain.js';
import { CELLS, structuralGrid, cellOf, cellCenter } from './roads.js';
import { coarseTravelField, blockCosts } from '../navigation.js';
import { nameDistrict } from './districts.js';

// ---------------------------------------------------------------- records

const KINDS = [[0, 'hamlet'], [100, 'village'], [400, 'town'], [1500, 'borough'], [4000, 'city']];
export const RIVER_DETOUR = 40;           // units of extra distance for crossing without a bridge

export function kindFor(pop) {
  let kind = 'hamlet';
  for (const [n, k] of KINDS) if (pop >= n) kind = k;
  return kind;
}

function makeCentre(state, fields) {
  return {
    id: (state.centres ?? []).reduce((m, c) => Math.max(m, c.id), 0) + 1,
    name: 'Hearthvale', x: 0, z: 0, founded: state.time?.year ?? 0, kind: 'hamlet',
    character: state.archetype ?? 'market-town', pop: 0, jobs: 0, density: 0, coreValue: 0,
    marketId: null, hallId: null, autonomy: 0, rank: 1, parentId: null, mergedInto: null,
    ...fields,
  };
}

// The seat: centre 1 at the first district (the starting hamlet).
export function ensureCentres(state) {
  if (state.centres?.length) return state.centres;
  const d = state.districts?.[0];
  const seat = makeCentre(state, { name: d?.name ?? 'Hearthvale', x: d?.centroid.x ?? 0, z: d?.centroid.z ?? 0, founded: 0 });
  state.centres = [seat];
  return state.centres;
}

// ---------------------------------------------------------------- the seat

// The centre the town is governed from: state.seatCentreId (centre 1 until
// a "Where should the town hall be?" ruling moves it; sim-governance sets
// tag 'seat:<id>').
export function seatOf(state) {
  const live = liveCentres(state);
  return live.find(c => c.id === state.seatCentreId) ?? live.find(c => c.id === 1) ?? live[0] ?? null;
}

const SEAT_HALL_REACH = 60;

function followSeatTag(state) {
  let id = null, year = -1;
  for (const [tag, y] of Object.entries(state.tags ?? {})) {
    const m = /^seat:(\d+)$/.exec(tag);
    if (m && y > year) { year = y; id = Number(m[1]); }
  }
  const target = id != null ? centreById(state, id) : null;
  if (!target || target.mergedInto != null || (state.seatCentreId ?? 1) === id || state.seatMovedYear === year) return;
  const old = seatOf(state);
  state.seatCentreId = id;
  state.seatMovedYear = year;
  emitChronicle(state, {
    kind: 'moment',
    text: `${target.name} is the seat of the town now. The council will meet there once its new hall is built.${old ? ` ${old.name} keeps its markets, but not the council.` : ''}`,
    refs: { centreId: target.id, centre: target.name },
  });
}

// When the seat has a finished hall of its own, the old halls elsewhere
// become libraries and the moot's work moves to the new building.
function settleHalls(state) {
  const seat = seatOf(state);
  if (!seat) return;
  const halls = (state.buildings ?? []).filter(b => b.type === 'moot');
  const home = halls.find(b => (b.built ?? 1) >= 1 && Math.hypot(b.x - seat.x, b.z - seat.z) <= SEAT_HALL_REACH);
  if (!home) return;
  for (const old of halls) {
    if (old === home || Math.hypot(old.x - seat.x, old.z - seat.z) <= SEAT_HALL_REACH) continue;
    const from = nearestCentre(state, old.x, old.z).centre;
    for (const e of state.enterprises ?? []) if (e.buildingId === old.id) e.buildingId = home.id;
    old.type = 'library';
    old.variant = 'old-hall';
    old.flags = { ...(old.flags ?? {}), formerHall: 1 };
    old.rev = (old.rev ?? 0) + 1;
    state.buildingsRev = (state.buildingsRev ?? 0) + 1;
    emitChronicle(state, {
      kind: 'line',
      text: `The new town hall in ${seat.name} is open. The old hall${from ? ` in ${from.name}` : ''} is a library now.`,
      refs: { centreId: seat.id, centre: seat.name, buildingId: home.id },
    });
  }
}

export function liveCentres(state) {
  return (state.centres ?? []).filter(c => c.mergedInto == null);
}

// Chronicle refs for a place: {centreId} of the centre it belongs to.
export function centreRef(state, x, z) {
  const id = nearestCentre(state, x, z).centre?.id;
  return id != null ? { centreId: id } : {};
}

export function centreById(state, id) { return (state.centres ?? []).find(c => c.id === id) ?? null; }

// ---------------------------------------------------------------- distance

// Straight distance plus a detour for crossing the river where no bridge is
// near. Pure and cheap, for land value and scoring.
export function centreDistance(state, c, x, z) {
  let d = Math.hypot(x - c.x, z - c.z);
  if (bankSide(x, z) !== bankSide(c.x, c.z) && !bridgeNear(state, (z + c.z) / 2)) d += RIVER_DETOUR;
  return d;
}

const bridgeCache = new WeakMap();

function bridgeNear(state, z) {
  const key = `${state.buildingsRev ?? 0}:${state.buildings?.length ?? 0}`;
  let hit = bridgeCache.get(state);
  if (!hit || hit.key !== key) {
    hit = { key, zs: (state.buildings ?? []).filter(b => b.type === 'bridge' && (b.built ?? 1) >= 1).map(b => b.z) };
    bridgeCache.set(state, hit);
  }
  return hit.zs.some(bz => Math.abs(bz - z) < 60);
}

export function nearestCentre(state, x, z) {
  let best = null, bestD = Infinity;
  for (const c of liveCentres(state)) {
    const d = centreDistance(state, c, x, z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return { centre: best, dist: bestD };
}

// ---------------------------------------------------------------- land value peaks

// Each centre lifts land value around its core: a peak scaled by its pop,
// jobs and market (coreValue), falling off over its reach.
export function reachOf(c) { return 40 + 2.2 * Math.sqrt(Math.max(0, c.pop)); }

export function centrePeakValue(state, x, z) {
  let best = 0;
  for (const c of liveCentres(state)) {
    const d = centreDistance(state, c, x, z);
    const reach = reachOf(c);
    if (d < reach) best = Math.max(best, c.coreValue * (1 - d / reach));
  }
  return best;
}

// 0..1: how close a point is to the heart of its centre (1 at the core).
export function corePull(state, x, z) {
  const { centre, dist } = nearestCentre(state, x, z);
  if (!centre) return 0;
  return Math.max(0, 1 - dist / reachOf(centre));
}

// ---------------------------------------------------------------- yearly

// Assigns centreId by travel cost over the walkable grid (one Dijkstra over
// coarse blocks from every core), refreshes each centre's numbers, rank and kind,
// and founds new centres where the seed score has held for two years.
export function updateCentres(state) {
  ensureCentres(state);
  followSeatTag(state);
  settleHalls(state);
  assignByTravel(state);
  refreshStats(state);
  if (fadeSmall(state)) {
    assignByTravel(state);
    refreshStats(state);
  }
  const founded = considerSeeds(state);
  if (founded) {
    assignByTravel(state);
    refreshStats(state);
  }
  return founded;
}

// The same pass in steps, one a tick (world.js): returns the next step, or
// null when done. 0 halls, 1 the travel grid, 2 its block costs (both
// caches), 3 assign, 4 fade, 5 reassign after a fade, 6 seeds, 7 reassign
// after a founding.
export function updateCentresStep(state, step) {
  switch (step) {
    case 0: ensureCentres(state); followSeatTag(state); settleHalls(state); return 1;
    case 1: structuralGrid(state); return 2;
    case 2: blockCosts(structuralGrid(state)); return 3;
    case 3: assignByTravel(state); refreshStats(state); return 4;
    case 4: return fadeSmall(state) ? 5 : 6;
    case 5: assignByTravel(state); refreshStats(state); return 6;
    case 6: return considerSeeds(state) ? 7 : null;
    case 7: assignByTravel(state); refreshStats(state); return null;
    default: return null;
  }
}

function assignByTravel(state) {
  const live = liveCentres(state);
  const sources = live.map(c => cellOf(c.x, c.z)).filter(i => i >= 0);
  if (!sources.length) return;
  // Travel cost over 8 x 8 cell blocks: the river and the walls still count,
  // at a fraction of the cost of a full-grid search.
  const field = coarseTravelField(structuralGrid(state), sources);
  const idOf = i => {
    const k = field.labelOf(i);
    return k >= 0 ? live[k].id : nearestCentre(state, ...xzOf(i)).centre?.id ?? live[0].id;
  };
  for (const b of state.buildings ?? []) b.centreId = idOf(cellOf(b.x, b.z));
  const homes = new Map((state.buildings ?? []).map(b => [b.id, b.centreId]));
  for (const lot of state.lots ?? []) if (lot.buildingId != null) lot.centreId = homes.get(lot.buildingId) ?? null;
  for (const h of state.households ?? []) {
    const id = homes.get(h.homeId);
    if (id != null) h.centreId = id;
  }
  for (const d of state.districts ?? []) d.centreId = idOf(cellOf(d.centroid.x, d.centroid.z));
}

function xzOf(i) {
  const c = cellCenter(Math.max(0, i));
  return [c.x, c.z];
}

export const HISTORY = 60;

const JOBS_FOR = new Set(['market', 'shop', 'workshop', 'mill', 'factory', 'inn', 'warehouse', 'quay', 'exchange']);

function refreshStats(state) {
  const live = liveCentres(state);
  const by = new Map(live.map(c => [c.id, { pop: 0, homes: 0, jobs: 0, market: null, hall: null, cells: 0 }]));
  for (const h of state.households ?? []) {
    const s = by.get(h.centreId);
    if (s) s.pop += h.size ?? 1;
  }
  const byId = new Map((state.buildings ?? []).map(b => [b.id, b]));
  for (const e of state.enterprises ?? []) {
    const b = byId.get(e.buildingId);
    const s = b && by.get(b.centreId);
    if (s) s.jobs += e.jobs ?? 0;
  }
  for (const b of state.buildings ?? []) {
    const s = by.get(b.centreId);
    if (!s) continue;
    if (b.type === 'home') s.homes++;
    if (b.type === 'market' && !s.market) s.market = b.id;
    if ((b.type === 'moot' || b.type === 'union-hall') && !s.hall) s.hall = b.id;
    if (JOBS_FOR.has(b.type) && !(state.enterprises ?? []).length) s.jobs += 4;
  }
  const year = state.time?.year ?? 0;
  for (const c of live) {
    const s = by.get(c.id);
    c.pop = s.pop;
    c.jobs = s.jobs;
    // Yearly history for the Places view (up to HISTORY points).
    c.history ??= { year: [], pop: [], jobs: [] };
    if (c.history.year.at(-1) !== year) {
      c.history.year.push(year);
      c.history.pop.push(c.pop);
      c.history.jobs.push(c.jobs);
      for (const k of ['year', 'pop', 'jobs']) if (c.history[k].length > HISTORY) c.history[k].splice(0, c.history[k].length - HISTORY);
    }
    c.marketId = s.market;
    c.hallId = s.hall;
    c.kind = kindFor(c.pop);
    c.density = Math.min(1, s.homes / Math.max(1, (Math.PI * reachOf(c) ** 2) / 60));
    // The core's pull: people, work and a market to trade in.
    c.coreValue = Math.min(40, 6 + 3 * Math.log1p(c.pop) + 2 * Math.log1p(c.jobs) + (c.marketId ? 6 : 0));
    recentre(state, c);
  }
  const score = c => (c.pop + 1) * (c.jobs + 1) * (1 + (state.pressures?.prestige ?? 0));
  const ranked = [...live].sort((a, b) => score(b) - score(a) || a.id - b.id);
  const leaderBefore = live.find(c => c.biggest) ?? live.find(c => c.rank === 1);
  // Hysteresis: the old leader keeps first place until clearly beaten.
  if (leaderBefore && ranked[0] !== leaderBefore && score(ranked[0]) < score(leaderBefore) * 1.1) {
    ranked.splice(ranked.indexOf(leaderBefore), 1);
    ranked.unshift(leaderBefore);
  }
  const leader = ranked[0];
  for (const c of live) c.biggest = c === leader;
  // The seat always ranks first; the others by size and work.
  const seat = seatOf(state);
  if (seat && ranked[0] !== seat) {
    ranked.splice(ranked.indexOf(seat), 1);
    ranked.unshift(seat);
  }
  ranked.forEach((c, k) => { c.rank = k + 1; });
  if (leaderBefore && leader && leaderBefore.id !== leader.id && leader.founded > 0 && leader.id !== (state.seatCentreId ?? 1)) {
    setTag(state, `centre-overtook:${leader.id}`);
    emitChronicle(state, { kind: 'moment', text: `${leader.name} has grown bigger than ${leaderBefore.name}. People wonder where the town hall should be.`, refs: { centreId: leader.id, centre: leader.name } });
  }
}

// The core drifts toward its market (or its busiest homes), slowly.
function recentre(state, c) {
  const market = c.marketId != null ? (state.buildings ?? []).find(b => b.id === c.marketId) : null;
  if (market) {
    c.x += (market.x - c.x) * 0.2;
    c.z += (market.z - c.z) * 0.2;
  }
}

// A centre that never took off folds back into its nearest bigger
// neighbour (its people simply say they live in that town now).
function fadeSmall(state) {
  const year = state.time?.year ?? 0;
  let faded = 0;
  for (const c of liveCentres(state)) {
    if (c.founded === 0 || c.id === state.seatCentreId || year - c.founded < FADE_YEARS || c.pop >= FADE_POP) continue;
    const others = liveCentres(state).filter(o => o !== c && o.pop > c.pop);
    if (!others.length) continue;
    const into = others.sort((a, b) => centreDistance(state, a, c.x, c.z) - centreDistance(state, b, c.x, c.z) || a.id - b.id)[0];
    c.mergedInto = into.id;
    faded++;
    emitChronicle(state, { kind: 'line', text: `${c.name} never grew into a town of its own. Its people count themselves part of ${into.name} now.`, refs: { centreId: c.id, centre: c.name, into: into.id } });
  }
  return faded;
}

// ---------------------------------------------------------------- founding

export const SEED_THRESHOLD = 2.8;
export const SEED_MIN_PEOPLE = 8;        // people already living there, far from any core
export const SEED_SEAT_POP = 400;        // the seat must be a real village first
export const SEED_GAP_YEARS = 18;        // between foundings
export const FADE_YEARS = 25;            // a centre still this small after this long fades
export const FADE_POP = 250;
export const SEED_YEARS = 2;
const SEED_W = { far: 1.0, commuters: 1.0, draw: 1.0, cheap: 0.6, rough: 1.0 };

// Candidate points for a new centre, each with its local draw (0..1).
export function seedPoints(state) {
  const out = [];
  const add = (x, z, draw, what) => { if (Math.abs(x) < REGION && Math.abs(z) < REGION) out.push({ x, z, draw, what }); };
  for (const f of FORDS) for (const side of [-1, 1]) add(riverX(f.z) + side * (WATER_HALF + 10), f.z, 0.6, 'ford');
  for (const b of state.buildings ?? []) {
    if (b.type === 'bridge' && (b.built ?? 1) >= 1) {
      add(b.x - b.w / 2 - 10, b.z, 0.7, 'bridge');
      add(b.x + b.w / 2 + 10, b.z, 0.7, 'bridge');
    }
    if (b.type === 'mill') add(b.x, b.z, 0.5, 'mill');
    if (b.type === 'quay') add(b.x, b.z, 0.5, 'quay');
    if (b.type === 'quarry' || b.variant === 'coal-pit' || b.variant === 'clay-pit') add(b.x, b.z, 0.4, 'pit');
    // Businesses pushed out by rents settle somewhere cheaper: a seed.
    if (b.origin?.reason === 'relocated' || b.origin?.reason === 'moved-out') add(b.x, b.z, 0.4, 'relocated');
  }
  // Busy crossroads: the most worn tier >= 2 cells, sampled coarsely.
  const { tier, wear } = state.roads;
  for (let i = 0; i < CELLS; i += 7) {
    if (tier[i] >= 2 && wear[i] > 1500) {
      const c = cellCenter(i);
      add(c.x, c.z, Math.min(0.6, wear[i] / 5000), 'crossroads');
    }
  }
  return out;
}

export function seedScore(state, p) {
  const { centre, dist } = nearestCentre(state, p.x, p.z);
  if (!centre) return 0;
  const far = ramp(dist, 80, 160);
  if (far <= 0) return 0;
  let commuters = 0;
  for (const h of state.households ?? []) {
    const home = homeOf(state, h);
    if (!home || Math.hypot(home.x - p.x, home.z - p.z) > 24) continue;
    if (centreDistance(state, centre, home.x, home.z) > 60) commuters += h.size ?? 1;
  }
  if (commuters < SEED_MIN_PEOPLE) return 0;
  const seat = liveCentres(state).find(c => c.rank === 1) ?? centre;
  const cheap = Math.max(0, 1 - centrePeakValue(state, p.x, p.z) / Math.max(1, seat.coreValue));
  const rough = Math.min(1, slopeAt(p.x, p.z) / 0.4) + (bankDistance(p.x, p.z) < 6 ? 0.5 : 0);
  return SEED_W.far * far + SEED_W.commuters * Math.min(1, commuters / 25) + SEED_W.draw * p.draw
    + SEED_W.cheap * cheap - SEED_W.rough * rough;
}

let homeIndex = null;
function homeOf(state, h) {
  if (!homeIndex || homeIndex.state !== state || homeIndex.len !== state.buildings.length) {
    homeIndex = { state, len: state.buildings.length, map: new Map(state.buildings.map(b => [b.id, b])) };
  }
  return homeIndex.map.get(h.homeId) ?? null;
}

function ramp(v, a, b) { return Math.max(0, Math.min(1, (v - a) / (b - a))); }

// Seeds whose score stays above the threshold for SEED_YEARS years in a row
// become centres (best first, at most one a year). state.centreSeeds keeps
// {key: {years, x, z, what}} between years.
function considerSeeds(state) {
  const year = state.time?.year ?? 0;
  const seat = liveCentres(state).find(c => c.rank === 1);
  const last = Math.max(...liveCentres(state).map(c => c.founded));
  if (!seat || seat.pop < SEED_SEAT_POP || (liveCentres(state).length > 1 && year - last < SEED_GAP_YEARS)) {
    state.centreSeeds = {};
    return null;
  }
  const seen = {};
  for (const p of seedPoints(state)) {
    const key = `${Math.round(p.x / 24)},${Math.round(p.z / 24)}`;
    const score = seedScore(state, p);
    if (score < SEED_THRESHOLD) continue;
    if (!seen[key] || seen[key].score < score) seen[key] = { ...p, score };
  }
  const prev = state.centreSeeds ?? {};
  const next = {};
  for (const [key, p] of Object.entries(seen)) next[key] = { x: p.x, z: p.z, what: p.what, score: Math.round(p.score * 100) / 100, years: (prev[key]?.years ?? 0) + 1 };
  state.centreSeeds = next;
  const ripe = Object.values(next).filter(p => p.years >= SEED_YEARS).sort((a, b) => b.score - a.score || a.x - b.x);
  if (!ripe.length) return null;
  return foundCentre(state, ripe[0]);
}

const LINES = {
  ford: n => `Folk at the far ford now call their lanes ${n}. It has a life of its own.`,
  bridge: n => `Across the bridge a new place has grown. People call it ${n}.`,
  mill: n => `Folk by the mill now call their lanes ${n}.`,
  quay: n => `The quay has its own little town now. People call it ${n}.`,
  pit: n => `Workers at the pits have built a village. They call it ${n}.`,
  crossroads: n => `The busy crossroads has become a place of its own. People call it ${n}.`,
  relocated: n => `Workshops and farms priced out of the old town have gathered at ${n}. It is a place of its own now.`,
};

export function foundCentre(state, p) {
  const taken = new Set((state.centres ?? []).map(c => c.name));
  let name = null;
  for (let k = 0; k < 12 && (!name || taken.has(name)); k++) {
    name = nameDistrict(state, { x: p.x, z: p.z }, []).replace(/ (Quarter|End|Row|Side|Lane|Gate)$/, ' Town');
  }
  if (taken.has(name)) name = `${name} ${taken.size + 1}`;
  const c = makeCentre(state, { name, x: p.x, z: p.z, founded: state.time?.year ?? 0, parentId: liveCentres(state).find(x => x.rank === 1)?.id ?? null });
  state.centres.push(c);
  state.centresRev = (state.centresRev ?? 0) + 1;
  delete state.centreSeeds[`${Math.round(p.x / 24)},${Math.round(p.z / 24)}`];
  setTag(state, 'centre-founded');
  emitChronicle(state, { kind: 'moment', text: (LINES[p.what] ?? LINES.crossroads)(name), refs: { centreId: c.id, centre: name } });
  return c;
}

// ---------------------------------------------------------------- growth pressure

// Congestion near a centre's core: how worn and crowded the streets within
// a third of its reach are, 0..1. Pushes homes outward and to other centres.
export function congestion(state, c) {
  const r = reachOf(c) / 3;
  const { wear } = state.roads;
  let sum = 0, n = 0;
  for (let dz = -r; dz <= r; dz += 4)
    for (let dx = -r; dx <= r; dx += 4) {
      const i = cellOf(c.x + dx, c.z + dz);
      if (i < 0) continue;
      sum += wear[i];
      n++;
    }
  return Math.min(1, (n ? sum / n : 0) / 2500 + c.density * 0.5);
}

// Every centre's congestion, cached per tick (pure for replay).
const congestionCache = new WeakMap();

export function congestionMap(state) {
  const tick = state.time?.tick ?? 0;
  let hit = congestionCache.get(state);
  if (hit && hit.tick === tick && hit.n === (state.centres?.length ?? 0)) return hit.map;
  const map = new Map(liveCentres(state).map(c => [c.id, congestion(state, c)]));
  congestionCache.set(state, { tick, n: state.centres?.length ?? 0, map });
  return map;
}

// For site scoring: homes avoid congested cores; workplaces like busy ones
// (agglomeration). Returns a score adjustment.
export function centreBias(state, type, x, z) {
  const { centre, dist } = nearestCentre(state, x, z);
  if (!centre) return 0;
  const pull = Math.max(0, 1 - dist / reachOf(centre));
  const jam = congestionMap(state).get(centre.id) ?? 0;
  if (type === 'home') return -0.8 * jam * pull;
  if (JOBS_FOR.has(type)) return 0.4 * Math.min(1, centre.jobs / 200) * pull;
  return 0;
}

