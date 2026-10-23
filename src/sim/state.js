// State creation and the record primitives every module shares.
//
// createState(seed) builds a Hamlet at year 0: about 28 people in 7 households, a few
// huts and a moot hall on the west bank near the river, two fields and a small
// workshop. There are no roads yet; paths wear in as people walk.

import {seedStreams, hashUnit, hash32} from './rng.js';
import {createTime} from './clock.js';
import {setTerrainSeed, useTerrain, TERRAIN_VERSION, hasRiver, terrainArchetype} from '../terrain.js';
import {placeStartingHamlet} from './buildings.js';
import {createRoads as createWorldRoads, CELL, GRID_W, GRID_H, ORIGIN_X, ORIGIN_Z} from './roads.js';
import {runPhase} from './hooks.js';
import {newSeed, seedCode, parseSeed} from '../seed.js';

export const SAVE_VERSION = 3;
export const DEFAULT_SEED = 4817;

export const ROAD_GRID = {cell: CELL, W: GRID_W, H: GRID_H, ox: ORIGIN_X, oz: ORIGIN_Z};
// roads.planned bit flags
export const PLANNED = 1, BRIDGE = 2, LAMP = 4, FORD = 8;

export const TRAIT_KEYS = ['industry', 'market', 'innovation', 'authority'];
export const PRESSURE_KEYS = ['riverTrade', 'faith', 'learning', 'ecology', 'health', 'unrest', 'prestige'];
export const TRADES = ['farm', 'craft', 'trade', 'labour', 'clerical', 'clergy', 'gentry', 'none'];

// Home capacity (people) and base cost by tier (era-0 coin).
export const HOME_TIERS = {
  1: {capacity: 5, cost: 500, storeys: 1},
  2: {capacity: 7, cost: 1100, storeys: 2},
  3: {capacity: 10, cost: 2200, storeys: 3},
  4: {capacity: 16, cost: 4200, storeys: 4},
  5: {capacity: 30, cost: 9000, storeys: 6},
};

// createState(seed?): with no seed, a new random valley. A seed may be a number or a
// share code / any text (see parseSeed). The terrain follows the seed.
export function createState(seed, options = {}) {
  const value = seed == null ? newSeed() : parseSeed(seed);
  // New towns get the newest valleys (lakes, deltas, the sea); options.terrainVersion 1
  // gives the river-only valley, options.archetype forces one of waters.js's ARCHETYPES.
  const terrainVersion = options.terrainVersion ?? TERRAIN_VERSION;
  const terrainArchetype = options.archetype ?? null;
  setTerrainSeed(value, terrainVersion, terrainArchetype);
  const state = emptyState(value, options);
  state.terrainVersion = terrainVersion;
  state.terrainArchetype = terrainArchetype;
  layOutHamlet(state);
  runPhase('init', state, {services: options.services ?? {}});
  return state;
}

// A blank v2 state with every top-level field present. Fixtures build on this too.
export function emptyState(seed = DEFAULT_SEED, options = {}) {
  return {
    version: SAVE_VERSION,
    seed,
    terrainSeed: seed,
    // 1: the river-only valley every save before water bodies had; see terrain.js.
    terrainVersion: 1,
    terrainArchetype: null,
    rng: seedStreams(seed),
    // individualCap: null = everyone walks (a number caps it, for tests and benchmarks).
    settings: {individualCap: null, ...(options.settings ?? {})},
    time: createTime(),
    nextId: 1,

    traits: {industry: 0, market: 0, innovation: 0, authority: 0},
    traitVel: {industry: 0, market: 0, innovation: 0, authority: 0},
    pressures: {riverTrade: 0.05, faith: 0.2, learning: 0.05, ecology: 0.9, health: 0.4, unrest: 0, prestige: 0},
    indicators: emptyIndicators(),
    indicatorHistory: {},
    tags: {},
    tagCounts: {},
    deltaLog: [],
    era: 0,
    eraEntered: [0],
    archetype: 'market-town',
    archetypeScore: 0,

    households: [],
    enterprises: [],
    factions: [],
    institutions: [],
    policies: {},
    docket: [],
    cardHistory: [],
    events: {active: [], cooldownUntil: {}},
    disagreement: {},
    bands: {},
    answerLog: [],

    roads: createRoads(),
    lots: [],
    districts: [],
    buildings: [],
    projects: [],
    people: [],
    worldEvents: [],
    weather: {rain: 0, wind: [1, 0.3], snow: 0},

    treasury: 0,
    debt: 0,
    food: 0,
    goods: 0,
    economy: createEconomyState(),
    budget: {income: {tax: 0, tolls: 0, tithe: 0}, spend: {upkeep: 0, policies: 0, bodies: {}, projects: 0}},
    chronicle: {entries: [], summary: null},
    notes: {},        // inspector notes (narrator); the sim never reads them
    notesSeq: 0,
    buildingsRev: 0,
  };
}

export function emptyIndicators() {
  return {
    pop: 0, households: 0, tension: 0, density: 0, inequality: 0, housingPressure: 0,
    foodBalance: 0, jobBalance: 0, treasuryYears: 0, avgWealth: 0, traffic: 0, literacy: 0,
    avgHomeTier: 1, wellbeing: 60, employment: 1,
  };
}

export function createEconomyState() {
  return {
    external: {in: 0, out: 0},     // all coin that entered or left the town
    loans: [],                     // [{id, principal, rate, monthly, remaining}]
    month: {},                     // flows of the month in progress (reset monthly)
    lastMonth: {},                 // the last finished month's flows
    year: {},                      // running totals for the year in progress
    lastYear: {},                  // the last finished year's totals
    prices: {food: 1.5, goods: 4},
    wageRate: 10,
    jobs: {},                      // per trade: {jobs, workers, filled}
    shortage: {food: 0, goods: 0}, // unmet need this month (units)
  };
}

// The road grid is sim-world's (roads.js): the whole region, with fords marked.
export const createRoads = () => createWorldRoads();

export const cellIndex = (roads, x, z) => {
  const i = Math.floor((x - roads.ox) / roads.cell), j = Math.floor((z - roads.oz) / roads.cell);
  return i < 0 || j < 0 || i >= roads.W || j >= roads.H ? -1 : j * roads.W + i;
};

export const nextId = (state) => state.nextId++;

// ---------------------------------------------------------------------------
// Seeds live in src/seed.js so the main menu can use them without the sim.
export {newSeed, seedCode, parseSeed};

// Point the shared terrain at this state's valley (cheap when it already is).
export function useTerrainOf(state) {
  useTerrain(state.terrainSeed ?? null, state.terrainVersion ?? 1, state.terrainArchetype ?? null);
}

// ---------------------------------------------------------------------------
// Buildings. sim-world owns the rules for where and when buildings appear; these are
// the primitives that keep records complete and the render view informed.

const BUILDING_DEFAULTS = {
  variant: 'basic', tier: 1, storeys: 1, lotId: null, rot: 0, w: 4, d: 4,
  styleEra: 0, archetype: 'market-town', material: 'timber',
  wealth: 0.3, condition: 1, age: 0, built: 1,
  occupied: false, open: false, chimney: false, smoke: 0, banner: null, lit: false,
  ownerHouseholdId: null, districtId: null, restyleAt: null,
};

export function makeBuilding(state, fields) {
  const b = {id: nextId(state), type: 'home', x: 0, z: 0, ...BUILDING_DEFAULTS, ...fields};
  b.extensions = fields.extensions ?? [];
  b.flags = fields.flags ?? {};
  b.rev = 1;
  return b;
}

export function addBuildingRecord(state, fields) {
  const b = makeBuilding(state, fields);
  state.buildings.push(b);
  state.buildingsRev++;
  return b;
}

export function removeBuildingRecord(state, id) {
  const at = state.buildings.findIndex((b) => b.id === id);
  if (at < 0) return null;
  const [b] = state.buildings.splice(at, 1);
  state.buildingsRev++;
  return b;
}

// Call after changing any field the renderer shows (tier, storeys, built, smoke...).
export function touchBuilding(state, b) {
  b.rev = (b.rev ?? 0) + 1;
  state.buildingsRev++;
}

// ---------------------------------------------------------------------------
// Id indexes (transient, rebuilt on demand; never saved).

const indexes = new WeakMap();

export function byId(state, collection, id) {
  const list = state[collection];
  let entry = indexes.get(list);
  if (!entry || entry.length !== list.length) entry = rebuildIndex(list);
  let found = entry.map.get(id);
  if (found && found.id === id && list[entry.pos.get(id)] === found) return found;
  entry = rebuildIndex(list);
  return entry.map.get(id) ?? null;
}

function rebuildIndex(list) {
  const map = new Map(), pos = new Map();
  for (let i = 0; i < list.length; i++) {
    map.set(list[i].id, list[i]);
    pos.set(list[i].id, i);
  }
  const entry = {length: list.length, map, pos};
  indexes.set(list, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Tags and chronicle

export function setTag(state, name) {
  state.tags[name] = state.time.year;
  state.tagCounts[name] = (state.tagCounts[name] ?? 0) + 1;
}

const CHRONICLE_CAP = 4000;

// entry: {text, kind: 'line'|'decision'|'moment'|'year', refs?}. sim-governance's
// chronicle.js reads these; anyone may emit through this helper.
export function emitChronicle(state, entry) {
  const {year, month} = state.time;
  state.chronicle.entries.push({year, month, era: state.era, kind: 'line', ...entry});
  if (state.chronicle.entries.length > CHRONICLE_CAP) state.chronicle.entries.splice(0, 500);
}

// ---------------------------------------------------------------------------
// The starting hamlet

const HAMLET_TRADES = ['farm', 'farm', 'farm', 'farm', 'craft', 'trade', 'farm'];
const HAMLET_SIZES = [4, 5, 3, 4, 5, 3, 4];

function layOutHamlet(state) {
  state.treasury = 600;
  state.food = 120;
  state.goods = 30;
  state.institutions.push(createMoot());
  state.policies['property-tax'] = {level: 1, since: 0, by: 'moot', rate: 8};

  // sim-world picks safe sites for this valley: off the bank, no overlaps, open doors.
  const placed = placeStartingHamlet(state, {homes: HAMLET_SIZES.length, districtId: 1});
  const centre = placed.centre;
  // Named for what it was founded on: the ford, or, with no river, the shore or the well.
  const firstName = hasRiver() ? 'Old Ford' : terrainArchetype() === 'shore' ? 'Old Strand' : 'Old Well';
  state.districts.push({id: 1, name: firstName, character: 'old-town', centroid: {x: centre.x, z: centre.z}, lots: 0, tags: []});
  const civic = {occupied: true, open: true, wealth: 0.4};
  if (placed.moot) Object.assign(placed.moot, civic);
  for (const f of placed.farms) Object.assign(f, {occupied: true, open: true});
  if (placed.workshop) Object.assign(placed.workshop, {occupied: true, open: true, smoke: 0.3});
  placed.homes.forEach((home, i) => Object.assign(home, {
    occupied: true, wealth: 0.2 + hashUnit(i) * 0.2, condition: 0.85 + hashUnit(i + 3) * 0.15, age: 3 + (i % 5),
  }));

  // Seven families; any hut the valley had no room for leaves its family to the
  // housing market (they find room next month or build).
  for (let i = 0; i < HAMLET_SIZES.length; i++) {
    const home = placed.homes[i] ?? null;
    const hh = makeHousehold(state, {
      homeId: home?.id ?? null, size: HAMLET_SIZES[i], trade: HAMLET_TRADES[i],
      savings: 80 + Math.round(hashUnit(i + 40) * 120), districtId: 1,
      formedYear: -10 - (hash32(i) % 25),
    });
    if (home) home.ownerHouseholdId = hh.id;
    state.households.push(hh);
  }

  // Owners: the first farm households hold the fields; the craft household runs the smithy.
  const farmers = state.households.filter((h) => h.trade === 'farm');
  const crafter = state.households.find((h) => h.trade === 'craft');
  const cash = [160, 140];
  placed.farms.forEach((farm, i) => state.enterprises.push(makeEnterprise(state, farm, {ownerHouseholdId: farmers[i]?.id ?? null, cash: cash[i] ?? 100})));
  if (placed.workshop) state.enterprises.push(makeEnterprise(state, placed.workshop, {ownerHouseholdId: crafter?.id ?? null, cash: 90}));
  if (placed.moot) state.enterprises.push(makeEnterprise(state, placed.moot, {cash: 0}));
}

export function createMoot() {
  return {
    id: 'moot', kind: 'moot', foundedYear: 0, status: 'active', budgetShare: 0, power: 0.5,
    patience: 1, metrics: {}, lastProposalMonth: -99, funds: 0,
  };
}

// ---------------------------------------------------------------------------
// Record factories shared with households.js / enterprises.js / fixtures.js.

export function makeHousehold(state, fields) {
  const formedYear = fields.formedYear ?? state.time.year;
  return {
    id: nextId(state),
    homeId: null,
    size: 1,
    savings: 50,
    wealth: 50,
    trade: 'none',
    lifeStage: 'young',
    householdType: 'single',
    rent: 0,
    faithBand: 1,
    districtId: null,
    newcomerUntil: null,
    loyalty: {},
    formedYear,
    income: 0,
    workers: 0,
    employed: 0,
    hunger: 0,
    ...fields,
  };
}

// Jobs and sector by building type. `public` enterprises are paid by the treasury.
export const ENTERPRISE_TYPES = {
  farm: {sector: 'food', trade: 'farm', jobs: 6, upkeep: 2},
  mill: {sector: 'goods', trade: 'labour', jobs: 10, upkeep: 6, food: 0.4},
  workshop: {sector: 'goods', trade: 'craft', jobs: 4, upkeep: 2},
  factory: {sector: 'goods', trade: 'labour', jobs: 40, upkeep: 20},
  shop: {sector: 'services', trade: 'trade', jobs: 3, upkeep: 2},
  market: {sector: 'services', trade: 'trade', jobs: 8, upkeep: 4},
  inn: {sector: 'services', trade: 'trade', jobs: 4, upkeep: 3},
  warehouse: {sector: 'trade', trade: 'labour', jobs: 6, upkeep: 3},
  quarry: {sector: 'goods', trade: 'labour', jobs: 6, upkeep: 2},
  quay: {sector: 'trade', trade: 'labour', jobs: 10, upkeep: 4},
  exchange: {sector: 'trade', trade: 'trade', jobs: 12, upkeep: 8},
  theatre: {sector: 'services', trade: 'trade', jobs: 6, upkeep: 6},
  bathhouse: {sector: 'services', trade: 'trade', jobs: 4, upkeep: 4},
  moot: {sector: 'public', trade: 'clerical', jobs: 0, upkeep: 1, public: true},
  chapel: {sector: 'public', trade: 'clergy', jobs: 2, upkeep: 2, public: true},
  school: {sector: 'public', trade: 'clerical', jobs: 3, upkeep: 3, public: true},
  infirmary: {sector: 'public', trade: 'clerical', jobs: 4, upkeep: 4, public: true},
  watch: {sector: 'public', trade: 'labour', jobs: 4, upkeep: 3, public: true},
  library: {sector: 'public', trade: 'clerical', jobs: 2, upkeep: 2, public: true},
  'union-hall': {sector: 'public', trade: 'clerical', jobs: 1, upkeep: 1, public: true},
};

// Jobs grow with the building's tier. A windmill needs a miller and a few hands,
// not a water mill's crew (economy.js gives each of them more output in a good wind).
export const WINDMILL_JOBS = 4;
export function jobsFor(type, tier = 1, variant = null) {
  if (type === 'moot') return 1 + 2 * (tier - 1);   // a clerk from the start, more as the hall grows
  if (type === 'mill' && variant === 'windmill') return WINDMILL_JOBS;
  const def = ENTERPRISE_TYPES[type];
  return def ? Math.round(def.jobs * (1 + 0.6 * (tier - 1))) : 0;
}

export function makeEnterprise(state, building, fields = {}) {
  const def = ENTERPRISE_TYPES[building.type];
  return {
    id: nextId(state),
    type: building.type,
    variant: building.variant,
    buildingId: building.id,
    ownerHouseholdId: null,
    sector: def.sector,
    trade: def.trade,
    public: !!def.public,
    jobs: jobsFor(building.type, building.tier ?? 1, building.variant),
    upkeep: def.upkeep,
    filled: 0,
    cash: 0,
    output: 0,
    revenue: 0,
    costs: 0,
    profit: 0,
    profitLastYear: 0,
    lossYears: 0,
    wagesBand: 1,
    automated: false,
    since: state.time.year,
    ...fields,
  };
}

// Stable look for a walker: small palette indices, derived from the id.
export function lookFor(id) {
  const h = hash32(id * 2654435761);
  return {skin: h % 6, cloth: (h >>> 3) % 12, hat: (h >>> 8) % 4};   // hat 0 = none
}
