// Population slices and the shared request states (contract §0.3–0.4).
//
// A household belongs to one value of every slice dimension (district, trade,
// wealth band, life stage, household type, faction, newcomer, faith band).
// Population-scale questions are asked once per slice value; a household's
// answer is the weighted average of its slices' answers (see scheduler.js).
//
// Snapshots are what a question carries as `state`. Shared snapshots hold
// bands only and are cached per season, so the service cache sees the same
// bytes between sweeps.

import {riverX} from '../../terrain.js';
import {monthIndex} from '../clock.js';
import {levelOf} from '../policies.js';
import {factionOf, isNewcomer} from '../factions.js';
import {ERA_KEYS, WEALTH, FAITH, SLICE_DIMS} from './kinds.js';
import {townLooks, districtLooks, looksBand} from '../aesthetics.js';

export const DIMS = Object.keys(SLICE_DIMS);

// Text the service accepts: letters, digits, spaces and _ , . / -
export const safe = (s, max = 24) => String(s ?? '').replace(/[^A-Za-z0-9 _,.\/-]/g, '').slice(0, max) || 'none';

// ---------------------------------------------------------------------------
// Bands (tertiles recomputed yearly)
// ---------------------------------------------------------------------------

function tertiles(values, fallback) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 6) return fallback;
  return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]];
}

export function updateBands(state) {
  const wealth = state.households.map((h) => h.wealth ?? h.savings ?? 0);
  const rent = state.households.map((h) => h.rent ?? 0);
  state.bands ??= {};
  state.bands.wealth = tertiles(wealth, state.bands.wealth ?? [60, 200]);
  state.bands.rent = tertiles(rent, state.bands.rent ?? [2, 6]);
  state.bands.year = state.time.year;
}

const bandIndex = (x, [t1, t2]) => (x < t1 ? 0 : x < t2 ? 1 : 2);

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

const LIFE_BY_STAGE = {young: 'young', family: 'family', elder: 'elder'};
const TYPE_MAP = {single: 'single', couple: 'couple', 'family-with-children': 'family', family: 'family', 'kin-group': 'kin', kin: 'kin'};

// A merged centre answers as the centre it joined.
export function centreSliceName(state, id) {
  const c = (state.centres ?? []).find((x) => x.id === id) ?? state.centres?.[0];
  if (!c) return 'Hearthvale';
  if (c.mergedInto != null) return centreSliceName(state, c.mergedInto);
  return safe(c.name);
}

export const centreIdByName = (state, name) => (state.centres ?? []).find((c) => safe(c.name) === name)?.id ?? state.centres?.[0]?.id ?? null;

export function districtName(state, id) {
  const d = state.districts?.find((x) => x.id === id);
  return safe(d?.name ?? 'Old Ford');
}

export function memberships(state, h, names = null, centres = null) {
  return {
    district: names?.get(h.districtId) ?? districtName(state, h.districtId),
    centre: centres?.get(h.centreId) ?? centreSliceName(state, h.centreId),
    trade: h.trade ?? 'none',
    wealthBand: WEALTH[bandIndex(h.wealth ?? h.savings ?? 0, state.bands?.wealth ?? [60, 200])],
    lifeStage: LIFE_BY_STAGE[h.lifeStage] ?? 'family',
    householdType: TYPE_MAP[h.householdType] ?? 'family',
    faction: factionOf(state, h),
    newcomer: isNewcomer(state, h) ? 'yes' : 'no',
    faithBand: FAITH[Math.max(0, Math.min(2, h.faithBand ?? 1))],
  };
}

// Slice table: {dims: {dim: {value: {people, households}}}, members: [{h, m}]}.
// Cached for one tick only, so it is always a function of the state as it is
// now (a restored game rebuilds exactly what the original saw).
const sliceCache = new WeakMap();

export function buildSlices(state) {
  const month = monthIndex(state.time);
  const cached = sliceCache.get(state);
  if (cached && cached.tick === state.time.tick && cached.count === state.households.length) return cached;
  const dims = {};
  for (const d of DIMS) dims[d] = {};
  const members = [];
  let people = 0;
  // District names once per build, not once per household.
  const names = new Map((state.districts ?? []).map((d) => [d.id, safe(d.name)]));
  const centres = new Map((state.centres ?? []).map((c) => [c.id, safe(c.mergedInto != null ? centreSliceName(state, c.mergedInto) : c.name)]));
  for (const h of state.households) {
    const m = memberships(state, h, names, centres);
    const n = h.size ?? 1;
    people += n;
    members.push({h, m, n});
    for (const d of DIMS) {
      const row = (dims[d][m[d]] ??= {people: 0, households: 0});
      row.people += n;
      row.households++;
    }
  }
  const table = {month, tick: state.time.tick, count: state.households.length, dims, members, people};
  sliceCache.set(state, table);
  return table;
}

export const invalidateSlices = (state) => sliceCache.delete(state);

// Sorted values of one dimension that have people in them.
export function sliceValues(state, dim) {
  const t = buildSlices(state).dims[dim] ?? {};
  return Object.keys(t).filter((v) => t[v].people > 0).sort();
}

// Members grouped by their combination over some dimensions: key -> {n, households, m}.
// Cached with the slice table (monthly), one entry per set of dimensions.
export function combinations(state, dims) {
  const table = buildSlices(state);
  const cacheKey = [...dims].sort().join('|');
  table.combos ??= new Map();
  const cached = table.combos.get(cacheKey);
  if (cached) return cached;
  const groups = new Map();
  for (const {h, m, n} of table.members) {
    const key = comboKey(m, dims);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = {key, n: 0, households: [], m}));
    g.n += n;
    g.households.push(h);
  }
  table.combos.set(cacheKey, groups);
  return groups;
}

// "dim=value|dim=value" with dims sorted, matching conditions.js `torn`.
const sortedDims = new Map();

export function comboKey(m, dims) {
  const id = dims.join(',');
  let sorted = sortedDims.get(id);
  if (!sorted) sortedDims.set(id, (sorted = [...dims].sort()));
  let key = '';
  for (let i = 0; i < sorted.length; i++) key += `${i ? '|' : ''}${sorted[i]}=${m[sorted[i]]}`;
  return key;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const RECENT_TAGS = ['flood', 'fire', 'plague', 'fair', 'strike', 'riot', 'blight', 'drought', 'boom', 'bust',
  'schism', 'royal-visit', 'jubilee', 'bridge-collapse', 'exodus', 'famine', 'coal', 'press'];

const b3 = (x, lo, hi, names) => names[x < lo ? 0 : x < hi ? 1 : 2];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

function rulesList(state) {
  return Object.entries(state.policies ?? {})
    .filter(([, p]) => p.level > 0)
    .map(([id, p]) => (p.level > 1 ? `${id} ${p.level}` : id))
    .sort()
    .join(',')
    .slice(0, 480);
}

function recentList(state) {
  const year = state.time.year;
  return RECENT_TAGS.filter((t) => state.tags?.[t] != null && year - state.tags[t] <= 3)
    .sort((a, b) => (state.tags[b] - state.tags[a]) || a.localeCompare(b))
    .slice(0, 4)
    .sort()
    .join(',');
}

// Households only form where a home exists, so homelessness is nearly always 0;
// what newcomers feel is whether any home stands empty.
function homesBand(state, I) {
  if ((I.housingPressure ?? 0) > 0.02) return 'scarce';
  const used = new Set();
  for (const h of state.households ?? []) if (h.homeId != null) used.add(h.homeId);
  let homes = 0, empty = 0;
  for (const b of state.buildings ?? []) {
    if (b.type !== 'home' || (b.built ?? 1) < 1) continue;
    homes++;
    if (!used.has(b.id)) empty++;
  }
  const vacancy = homes ? empty / homes : 0;
  return vacancy < 0.005 ? 'scarce' : vacancy > 0.05 ? 'plenty' : 'balanced';
}

function computeTownSnapshot(state) {
  const I = state.indicators ?? {};
  const P = state.pressures ?? {};
  const treasury = state.treasury ?? 0;
  const ty = I.treasuryYears ?? 1;
  return {
    era: ERA_KEYS[Math.max(0, Math.min(5, state.era ?? 0))],
    season: SEASONS[Math.floor((state.time.month % 12) / 3)],
    archetype: state.archetype ?? 'market-town',
    food: b3(I.foodBalance ?? 6, 2, 8, ['low', 'ok', 'plenty']),
    coin: treasury < 0 ? 'debt' : ty < 0.5 ? 'tight' : ty < 3 ? 'ok' : 'rich',
    // Bands say how this town compares with the usual run of towns (measured over
    // 150-year headless runs): the decision model and the fallbacks only see words,
    // and fixed cut-offs left nearly every town reading 'good' / 'scarce' / 'plenty'.
    // Wellbeing sits between 75 and 95 in practice (p10 80, p60 89).
    wellbeing: b3(I.wellbeing ?? 85, 80, 89, ['poor', 'fair', 'good']),
    // Towns always have more hands than jobs; the band is relative to that (quartiles).
    jobs: (I.jobBalance ?? 0) < -0.42 ? 'scarce' : (I.jobBalance ?? 0) > -0.2 ? 'plenty' : 'balanced',
    homes: homesBand(state, I),
    health: b3(P.health ?? 0.4, 0.35, 0.65, ['poor', 'fair', 'good']),
    unrest: b3(P.unrest ?? 0, 0.2, 0.5, ['calm', 'uneasy', 'angry']),
    faith: b3(P.faith ?? 0.2, 0.3, 0.6, ['low', 'mid', 'high']),
    river: b3(P.riverTrade ?? 0, 0.2, 0.5, ['quiet', 'busy', 'thronged']),
    taxStep: Math.min(6, levelOf(state, 'property-tax') + Math.ceil(levelOf(state, 'income-tax') / 2)),
    rules: rulesList(state),
    recent: recentList(state),
    bodies: (state.institutions ?? []).filter((b) => b.status === 'active').map((b) => b.kind).sort().join(','),
    looks: looksBand(townLooks(state)),
  };
}

// Cached per season in state (small), so it survives a save and stays byte-stable.
export function townSnapshot(state) {
  const g = state.governance;
  const key = `${state.time.year}:${Math.floor(state.time.month / 3)}`;
  if (g.townSnapshot?.key === key) return g.townSnapshot.snap;
  const snap = computeTownSnapshot(state);
  g.townSnapshot = {key, snap};
  g.districtSnapshots = {};
  return snap;
}

function districtFacts(state, d) {
  const homes = state.households.filter((h) => h.districtId === d.id);
  const rents = homes.map((h) => h.rent ?? 0);
  const avgRent = rents.length ? rents.reduce((a, b) => a + b, 0) / rents.length : 0;
  const c = d.centroid ?? {x: 0, z: 0};
  const roads = state.roads;
  let best = 0;
  if (roads?.tier) {
    const ci = Math.floor((c.x - roads.ox) / roads.cell), cj = Math.floor((c.z - roads.oz) / roads.cell);
    for (let j = cj - 6; j <= cj + 6; j++) {
      for (let i = ci - 6; i <= ci + 6; i++) {
        if (i < 0 || j < 0 || i >= roads.W || j >= roads.H) continue;
        best = Math.max(best, roads.tier[j * roads.W + i]);
      }
    }
  }
  return {
    districtName: safe(d.name),
    character: ['farms', 'mill', 'market', 'quays', 'garden', 'old-town', 'new-quarter', 'slum'].includes(d.character) ? d.character : 'old-town',
    rent: ['low', 'mid', 'high'][bandIndex(avgRent, state.bands?.rent ?? [2, 6])],
    roads: best >= 4 ? 'paved' : best >= 3 ? 'roads' : best >= 2 ? 'tracks' : 'paths',
    crowding: b3(state.indicators?.density ?? 0, 0.35, 0.7, ['loose', 'snug', 'packed']),
    nearRiver: Math.abs(c.x - riverX(c.z)) < 30 ? 'yes' : 'no',
    kin: b3(homes.length, 10, 40, ['few', 'some', 'many']),
    looks: looksBand(districtLooks(state, d.id)),
  };
}

export function districtSnapshot(state, districtId) {
  const town = townSnapshot(state);
  const g = state.governance;
  g.districtSnapshots ??= {};
  const cached = g.districtSnapshots[districtId];
  if (cached) return cached;
  const d = state.districts?.find((x) => x.id === districtId) ?? state.districts?.[0] ?? {id: 0, name: 'Old Ford', centroid: {x: 0, z: 0}};
  const snap = {...town, ...districtFacts(state, d)};
  g.districtSnapshots[districtId] = snap;
  return snap;
}

export const districtIdByName = (state, name) => state.districts?.find((d) => safe(d.name) === name)?.id ?? state.districts?.[0]?.id ?? 0;

const COST_BANDS = (cost, state) => {
  const tax = Math.max(100, state.budget?.income?.tax ?? 300);
  return !cost ? 'none' : cost < tax * 0.5 ? 'low' : cost < tax * 1.5 ? 'mid' : 'high';
};

export function proposalSnapshot(state, card) {
  return {
    ...townSnapshot(state),
    proposalId: safe(card.id, 40),
    proposalFrom: card.from && card.from !== 'player' ? (state.institutions.find((b) => b.id === card.from)?.kind ?? 'moot') : 'moot',
    category: card.category ?? 'civic',
    summary: safe(card.title, 160),
    costBand: COST_BANDS(card.cost ?? 0, state),
    helps: safe((card.helps ?? []).join(','), 80),
    hurts: safe((card.hurts ?? []).join(','), 80),
  };
}

export function bodySnapshot(state, body, facts) {
  return {
    ...townSnapshot(state),
    body: body.kind,
    year: Math.min(200, state.time.year),
    budget: Math.max(0, Math.round(body.funds ?? 0)),
    spent: Math.max(0, Math.round(body.spentThisYear ?? 0)),
    patience: round2(body.patience),
    power: round2(body.power),
    metrics: safe(Object.entries(facts.metrics).map(([k, v]) => `${k} ${v}`).join(', '), 200),
    lastRulings: safe(facts.lastRulings.join(','), 80),
    rivalsLive: safe(state.docket.filter((c) => c.kind === 'proposal' && c.from !== body.id).map((c) => c.from).sort().join(','), 80),
  };
}

const round2 = (x) => Math.round(Math.max(0, Math.min(1, x ?? 0)) * 100) / 100;

// Stable content hash for a snapshot (FNV-1a over sorted JSON).
export function snapshotKey(snap) {
  const text = JSON.stringify(snap, Object.keys(snap).sort());
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `s${h.toString(36)}`;
}
