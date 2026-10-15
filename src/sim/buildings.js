// Buildings: tiers and variants, placement on lots, construction projects
// with builders, upgrades in place, merging into terraces, decay and the
// renderer hook fields (contract §3, design-systems §7).
//
// Money never moves here. Every project carries `cost`, `payer` and `paid`.
// Callers that already charged (docket rulings) pass paid: true; the economy
// charges the payer of unpaid projects.
import { rng, hashUnit } from './rng.js';
import { ERA, materialFor } from './eras.js';
import { addBuildingRecord, removeBuildingRecord, touchBuilding, emitChronicle, byId } from './state.js';
import { findHook, decide } from './hooks.js';
import { centreRef } from './centres.js';
import {
  lotSize, claimSite, releaseLot, resizeLot, deepenLot, footprintFor, localDensity, targetDensity, lotForBuilding, proposeSites, chooseSite, densityTarget, siteText, siteStillFree, siteContext, districtValueRank, pathCover, frontCells, lotSlope, landValueNorm, landValueAt, worldToCell, buildingBins,
  recordVacated, relocationSites,
  footprintBank, setbackAt, isEmbanked, WATERFRONT, lotGrid, hamletLayout,
} from './sites.js';
import {
  bumpWorld, cellCenter, frontCell, footprints, terrainGrid, navGrid, cellIndex, buildingCells, setTier, markDirty, bumpNav, doorCell, setTowpath,
  ORIGIN_X, ORIGIN_Z, CELL, GRID_W, CELLS,
} from './roads.js';
import { bankDistance } from '../terrain.js';
import { delta } from './pressures.js';
import { components } from '../navigation.js';

// ---------------------------------------------------------------- catalogue

// variants[tier-1]; minEra[tier-1]; cost[tier-1] in era-0 coin.
export const TYPES = {
  home: { variants: ['cottage', 'house', 'townhouse', 'terrace', 'apartments'], minEra: [0, 1, 2, 3, 4], cost: [500, 1100, 2200, 4200, 9000], storeys: [1, 2, 3, 4, 6], capacity: [5, 7, 10, 16, 30], chimney: true },
  farm: { variants: ['field', 'farmstead'], minEra: [0, 2], cost: [300, 900], storeys: [1, 1] },
  workshop: { variants: ['workshop', 'manufactory', 'works'], minEra: [0, 2, 3], cost: [400, 1400, 3200], storeys: [1, 2, 3], chimney: true, smoke: [0.3, 0.5, 0.8] },
  mill: { variants: ['water-mill', 'steam-mill'], minEra: [0, 3], cost: [1200, 3600], storeys: [2, 4], chimney: true, smoke: [0.1, 0.8] },
  factory: { variants: ['factory'], minEra: [3], cost: [6000], storeys: [3], chimney: true, smoke: [0.9] },
  shop: { variants: ['stall', 'arcade-shop', 'department-store'], minEra: [0, 2, 4], cost: [350, 1600, 5200], storeys: [1, 2, 4] },
  market: { variants: ['market-cross', 'market-hall'], minEra: [0, 2], cost: [600, 2400], storeys: [1, 2] },
  inn: { variants: ['inn', 'coaching-inn', 'hotel'], minEra: [0, 2, 4], cost: [700, 1800, 6000], storeys: [2, 3, 5], chimney: true },
  warehouse: { variants: ['store', 'warehouse'], minEra: [1, 3], cost: [800, 2400], storeys: [2, 4] },
  chapel: { variants: ['chapel', 'church', 'cathedral'], minEra: [0, 2, 3], cost: [900, 3000, 12000], storeys: [1, 2, 3], heights: [12, 22, 40] },
  school: { variants: ['school', 'college'], minEra: [1, 3], cost: [900, 3500], storeys: [1, 3] },
  moot: { variants: ['moot-hall', 'town-hall', 'city-hall'], minEra: [0, 2, 4], cost: [800, 3000, 9000], storeys: [1, 2, 4], chimney: true },
  park: { variants: ['green', 'park'], minEra: [0, 3], cost: [200, 900], storeys: [0, 0] },
  infirmary: { variants: ['infirmary', 'hospital'], minEra: [2, 4], cost: [1500, 6000], storeys: [2, 4] },
  watch: { variants: ['watch-house'], minEra: [1], cost: [500], storeys: [2] },
  exchange: { variants: ['exchange'], minEra: [3], cost: [7000], storeys: [3] },
  theatre: { variants: ['theatre'], minEra: [3], cost: [4500], storeys: [3] },
  quay: { variants: ['quay'], minEra: [1], cost: [1200], storeys: [1] },
  quarry: { variants: ['quarry'], minEra: [1], cost: [900], storeys: [0] },
  monument: { variants: ['cross', 'fountain', 'statue', 'bandstand'], minEra: [0], cost: [400], storeys: [0] },
  'union-hall': { variants: ['union-hall'], minEra: [3], cost: [2200], storeys: [2] },
  library: { variants: ['library'], minEra: [2], cost: [2600], storeys: [2] },
  bathhouse: { variants: ['bathhouse'], minEra: [2], cost: [2000], storeys: [1] },
};

// Era cost scale: labour and materials get dearer as the town grows.
export const ERA_COST = [1, 1.2, 1.5, 1.9, 2.4, 3];
const WORK_PER_COIN = 1 / 30;      // builder-seconds of work per era-0 coin
const BUILDER_SLOTS = { build: 3, upgrade: 2, extend: 2, merge: 3, demolish: 2 };
const HIDDEN_CREW_AFTER = 50;       // ticks without builders before a hidden crew helps
const HIDDEN_CREW_RATE = 0.5;       // builder-equivalents
const STUCK_AFTER = 600;            // ticks with assigned walkers but nobody on site
const MERGE_WINDOW = 2;             // years in which both owners must want to rebuild

export function maxTier(type) { return TYPES[type]?.variants.length ?? 1; }

// Highest tier of a type the era allows; 0 when the type is not yet known.
export function eraMaxTier(type, era) {
  const t = TYPES[type];
  if (!t) return 0;
  if (type === 'home') return ERA[clampEra(era)].maxHomeTier;
  let best = 0;
  t.minEra.forEach((e, k) => { if (e <= era) best = k + 1; });
  return best;
}

export function eraMaxStoreys(era) { return ERA[clampEra(era)].maxStoreys; }

function clampEra(era) { return Math.max(0, Math.min(5, era | 0)); }

export function costOf(type, tier, era = 0) {
  const t = TYPES[type];
  return Math.round((t?.cost[Math.min(tier, t.cost.length) - 1] ?? 500) * ERA_COST[clampEra(era)]);
}

export function capacityOf(b) {
  if (b.type !== 'home') return 0;
  const base = TYPES.home.capacity[Math.min(5, b.tier) - 1];
  return b.tier === 5 ? Math.round(base * Math.max(1, b.storeys / 5)) : base;
}

export function storeysFor(type, tier, era) {
  const s = TYPES[type]?.storeys[Math.min(tier, TYPES[type].storeys.length) - 1] ?? 1;
  const extra = type === 'home' && tier === 5 && era >= 5 ? 3 : 0;
  return Math.min(s + extra, eraMaxStoreys(era));
}

// Variant by type, tier and the town's archetype (§7.2).
export function variantFor(type, tier, state, seed = 0) {
  const arch = state.archetype ?? 'market-town';
  const era = state.era ?? 0;
  if (type === 'home') {
    if (tier === 1) return era === 0 ? 'hut' : 'cottage';
    if (tier === 4) return { mill: 'terrace', port: 'tenement', exchange: 'tenement', garden: 'villa-row', commune: 'courtyard' }[arch] ?? 'terrace';
    if (tier === 5) return era >= 5 ? 'tower' : arch === 'exchange' || arch === 'garden' ? 'mansion-block' : 'apartments';
  }
  if (type === 'farm' && tier === 1) {
    const options = { garden: ['market-garden', 'orchard'], commune: ['field', 'field'], cathedral: ['field', 'orchard'] }[arch] ?? ['field', 'dairy'];
    return options[Math.floor(hashUnit(seed) * options.length)];
  }
  if (type === 'shop' && tier === 1 && era >= 1) return 'shop';
  if (type === 'workshop' && tier === 1 && hashUnit(seed + 7) < 0.4) return 'smithy';
  if (type === 'monument') return arch === 'cathedral' ? 'cross' : 'fountain';
  return TYPES[type]?.variants[tier - 1] ?? 'basic';
}

// ---------------------------------------------------------------- stories

// A short memory per building for the inspect panel (plain JSON, saved):
// b.origin = {year, month, reason, payer, site, card, frontage} and b.story,
// the last STORY_LEN events [{year, month, kind, text?}]. Kinds: built,
// upgraded, extended, restyled, repaired, raised, derelict, converted, damaged.
export const STORY_LEN = 6;

export function addBuildingStory(state, b, kind, fields = {}) {
  b.story ??= [];
  b.story.push({ year: state.time?.year ?? 0, month: state.time?.month ?? 0, kind, ...fields });
  if (b.story.length > STORY_LEN) b.story.splice(0, b.story.length - STORY_LEN);
}

// ---------------------------------------------------------------- projects

// Project kinds can be extended (works.js registers pave, bridge, ...).
const projectKinds = new Map();

export function registerProjectKind(kind, handlers) { projectKinds.set(kind, handlers); }

function nextProjectId(state) {
  state.nextProjectId ??= (state.projects ?? []).reduce((m, p) => Math.max(m, p.id), 0) + 1;
  return state.nextProjectId++;
}

// fields: {kind, buildingId?, cells?, x, z, w?, d?, cost, payer, work?, data?}
export function createProject(state, fields) {
  const p = {
    id: nextProjectId(state),
    kind: fields.kind,
    buildingId: fields.buildingId ?? null,
    cells: fields.cells ?? null,
    x: fields.x, z: fields.z, w: fields.w ?? 4, d: fields.d ?? 4,
    progress: 0,
    workRequired: Math.max(4, fields.work ?? (fields.cost ?? 500) * WORK_PER_COIN),
    workDone: 0,
    workers: [],
    payer: fields.payer ?? 'treasury',
    cost: fields.cost ?? 0,
    paid: !!fields.paid,
    idle: 0,
    after: fields.after ?? [],
    started: state.time ? { year: state.time.year, month: state.time.month } : null,
    data: fields.data ?? {},
  };
  state.projects ??= [];
  state.projects.push(p);
  return p;
}

export function projectById(state, id) { return (state.projects ?? []).find(p => p.id === id) ?? null; }

function waiting(state, p) { return p.after.some(id => projectById(state, id)); }

// Where builders stand: the street in front of a building, or the next
// unfinished cell of a road work.
export function projectSite(state, p) {
  const handler = projectKinds.get(p.kind);
  if (handler?.site) return handler.site(state, p);
  const b = p.buildingId != null ? byId(state, 'buildings', p.buildingId) : null;
  if (!b) return { x: p.x, z: p.z };
  const front = frontCell(b);
  return front >= 0 ? cellCenter(front) : { x: p.x, z: p.z };
}

// Projects that want more builders: [{projectId, x, z, slots}].
export function buildersWanted(state) {
  const out = [];
  for (const p of state.projects ?? []) {
    if (waiting(state, p)) continue;
    const slots = (BUILDER_SLOTS[p.kind] ?? 4) - p.workers.length;
    if (slots <= 0) continue;
    out.push({ projectId: p.id, ...projectSite(state, p), slots });
  }
  return out;
}

export function joinProject(state, projectId, personId) {
  const p = projectById(state, projectId);
  if (!p || p.workers.includes(personId)) return !!p;
  if (p.workers.length >= (BUILDER_SLOTS[p.kind] ?? 4)) return false;
  p.workers.push(personId);
  return true;
}

export function leaveProject(state, projectId, personId) {
  const p = projectById(state, projectId);
  if (p) p.workers = p.workers.filter(id => id !== personId);
}

// A builder standing at the site works for dt sim-seconds. Progress accrues
// only through this call (and the hidden crew in tickProjects).
export function workAtSite(state, projectId, dt, builders = 1) {
  const p = projectById(state, projectId);
  if (!p || waiting(state, p)) return false;
  p.idle = 0;
  advance(state, p, dt * builders);
  return true;
}

function advance(state, p, work) {
  p.workDone = Math.min(p.workRequired, p.workDone + work);
  const before = p.progress;
  p.progress = p.workDone / p.workRequired;
  projectKinds.get(p.kind)?.progress?.(state, p, before);
  const b = p.buildingId != null ? byId(state, 'buildings', p.buildingId) : null;
  if (b && p.kind === 'build') {
    const built = Math.floor(p.progress * 20) / 20;
    if (built !== b.built && built < 1) { b.built = built; touchBuilding(state, b); }
  }
  if (p.progress >= 1) finishProject(state, p);
}

// Every tick: builders on site (people.js counts them into project.onSite)
// advance the work. Projects nobody is assigned to get a slow hidden crew
// after a few seconds, and so do projects whose walkers never arrive, so
// work never stalls when the walkers are elsewhere.
export function tickProjects(state, dt) {
  const crewScale = aggregateCrewScale(state);
  for (const p of [...(state.projects ?? [])]) {
    if (waiting(state, p)) continue;
    const crew = p.onSite ?? 0;
    if (crew > 0) {
      p.idle = 0;
      advance(state, p, dt * crew * crewScale);
      continue;
    }
    p.idle = (p.idle ?? 0) + 1;
    const abandoned = p.workers.length ? p.idle > STUCK_AFTER : p.idle > HIDDEN_CREW_AFTER;
    if (abandoned) advance(state, p, dt * HIDDEN_CREW_RATE);
  }
}

// When far more people live in town than walk as individuals, each visible
// builder stands for a few unseen ones (capped at 3x).
function aggregateCrewScale(state) {
  const walkers = state.people?.length ?? 0;
  const pop = state.indicators?.pop ?? walkers;
  return walkers > 0 ? Math.max(1, Math.min(3, pop / walkers)) : 1;
}

function finishProject(state, p) {
  state.projects = state.projects.filter(q => q !== p);
  const handler = projectKinds.get(p.kind);
  if (handler?.complete) handler.complete(state, p);
}

// ---------------------------------------------------------------- placement

// Places a new building on a site from proposeSites. Returns {building, lot,
// project}. The building starts at built = 0 with a scaffold.
export function placeBuilding(state, site, spec) {
  const type = spec.type ?? site.type;
  const tier = Math.max(1, Math.min(spec.tier ?? site.tier ?? 1, eraMaxTier(type, state.era ?? 0)));
  const lot = claimSite(state, site, { districtId: spec.districtId });
  const fp = footprintFor(lot, type);
  const era = state.era ?? 0;
  // From the Town era, homes on a slope are built as stepped hill terraces.
  const hillside = type === 'home' && era >= 2 && lotSlope(lot) > 0.2;
  const b = addBuildingRecord(state, {
    type, tier, lotId: lot.id, ...fp,
    variant: spec.variant ?? (hillside ? 'terrace-hill' : variantFor(type, tier, state, lot.id)),
    storeys: storeysFor(type, tier, era),
    styleEra: era, archetype: state.archetype, material: materialFor(era, type),
    wealth: spec.wealth ?? 0.3, condition: 1, age: 0, built: 0,
    districtId: lot.districtId, ownerHouseholdId: spec.ownerHouseholdId ?? null,
    chimney: !!TYPES[type]?.chimney, flags: { scaffold: 1 },
  });
  lot.buildingId = b.id;
  b.origin = {
    year: state.time?.year ?? 0, month: state.time?.month ?? 0, reason: spec.reason ?? null, payer: spec.payer ?? null,
    site: site.bands ? siteText(site).slice(0, 60) : null, card: spec.card ?? null, frontage: lot.frontageTier,
  };
  setFoundation(state, b);
  bumpWorld(state);
  // Building over a path costs more; the extra goes to the path's users
  // (organic paths) or the treasury (planned streets), not to the builders.
  const cover = OPEN_BUILD.has(type) ? null : pathCover(state, lot);
  const base = spec.cost ?? costOf(type, tier, era);
  const surcharge = cover && cover.share > 0
    ? { organic: Math.round(base * cover.organic), planned: Math.round(base * cover.planned), districtId: lot.districtId }
    : null;
  const cost = base + (surcharge ? surcharge.organic + surcharge.planned : 0) + (lot.landSale?.amount ?? 0);
  const project = createProject(state, {
    kind: 'build', buildingId: b.id, x: b.x, z: b.z, w: b.w, d: b.d, cost, payer: spec.payer, paid: spec.paid,
    data: { reason: spec.reason ?? null },
  });
  if (surcharge) project.surcharge = surcharge;
  if (WATERFRONT.has(type)) layApron(state, b);
  // Built on sold farmland: the farmer is paid out of the build cost
  // (project.cost includes it; the economy pays landSale.amount to landSale.to).
  if (lot.landSale) project.landSale = lot.landSale;
  if (cover?.worst) closePathsUnder(state, b, cover.worst, lot.districtId);
  return { building: b, lot, project };
}

// docket.js / events.js interface: the town builds what the player ruled on.
// variant may name a variant of the first tier ('guild-hall', 'kiln'), a
// higher tier's variant ('town-hall', 'college') or 'upgrade': those upgrade
// the best existing building of that type one tier instead. With no free site
// the request waits in state.buildQueue and is retried monthly.
// Returns {ok, building?, project?, queued?, reason?}.
export function requestBuilding(state, type, opts = {}) {
  if (!TYPES[type]) return { ok: false, reason: 'type' };
  if (!eraMaxTier(type, state.era ?? 0)) return { ok: false, reason: 'era' };
  const { variant = null, payer = 'treasury', near, districtId } = opts;
  const paid = opts.paid ?? opts.card != null;
  const tierOfVariant = TYPES[type].variants.indexOf(variant) + 1;
  if (variant === 'upgrade' || tierOfVariant > 1) {
    const target = upgradeTarget(state, type, near);
    if (target) return startUpgrade(state, target, { payer, paid });
    if (variant === 'upgrade') return { ok: false, reason: 'none' };
  }
  const tier = tierOfVariant > 1 ? Math.min(tierOfVariant, eraMaxTier(type, state.era ?? 0)) : 1;
  // Moving out (rising rents): cheaper ground, close to where it was asked for.
  const relocate = opts.reason === 'relocate';
  const need = { type, tier, near, districtId, variant, relocate, nearWeight: relocate ? 0.05 : undefined };
  // New businesses reuse one site search per type a year (see foundingCandidates).
  const prepared = opts.reason === 'found' && !near && !districtId ? foundingCandidates(state, type, tier) : null;
  const site = opts.site ?? chooseSite(state, need, undefined, prepared);
  if (!site) {
    state.buildQueue ??= [];
    if (!opts.fromQueue) state.buildQueue.push({ type, variant, payer, paid, ownerHouseholdId: opts.ownerHouseholdId ?? null, reason: opts.reason ?? null, month: (state.time?.year ?? 0) * 12 + (state.time?.month ?? 0) });
    return { ok: false, queued: true, reason: 'no-site' };
  }
  const named = tierOfVariant <= 1 ? variant : null;
  const placed = placeBuilding(state, site, { type, tier, variant: named ?? undefined, payer, paid, ownerHouseholdId: opts.ownerHouseholdId, reason: opts.reason, card: opts.card });
  return { ok: true, ...placed };
}

// Founding requests share one site search per building type a year, like the
// monthly home batch: the candidate list lives in saved state (so a restored
// town picks exactly the same sites), and each request takes the top four
// candidates that are still free. A list that runs dry is searched again once.
const FOUNDING_SITES = 8;

function foundingCandidates(state, type, tier) {
  const year = state.time?.year ?? 0;
  state.foundingSites ??= {};
  let batch = state.foundingSites[type];
  let fresh = false;
  if (!batch || batch.year !== year || batch.tier !== tier) {
    batch = { year, tier, refreshed: false, sites: proposeSites(state, { type, tier, count: FOUNDING_SITES }) };
    state.foundingSites[type] = batch;
    fresh = true;
  }
  const ctx = siteContext(state);
  batch.sites = batch.sites.filter((site) => siteStillFree(state, site, ctx));
  if (!batch.sites.length && !fresh && !batch.refreshed) {
    batch.sites = proposeSites(state, { type, tier, count: FOUNDING_SITES });
    batch.refreshed = true;
  }
  return batch.sites.slice(0, 4);
}

// With `near`, only buildings of the type within NEAR_UPGRADE units count:
// "a town hall at Millbridge" builds one there rather than upgrading the old.
const NEAR_UPGRADE = 60;

function upgradeTarget(state, type, near = null) {
  let best = null;
  for (const b of state.buildings ?? []) {
    if (b.type !== type || !canUpgrade(state, b).ok) continue;
    if (near && Math.hypot(b.x - near.x, b.z - near.z) > NEAR_UPGRADE) continue;
    if (!best || b.tier > best.tier || (b.tier === best.tier && b.id < best.id)) best = b;
  }
  return best;
}

// Monthly: retry queued building requests (oldest first; one site search a
// month keeps the month tick cheap).
// Requests that still find no site after RETRY_LIMIT tries are dropped.
const RETRY_EVERY = 3;
const RETRY_LIMIT = 6;

export function retryBuildQueue(state, max = 1) {
  const queue = state.buildQueue ?? [];
  if (!queue.length || (state.time?.month ?? 0) % RETRY_EVERY !== 0) return;
  for (let k = 0; k < max && queue.length; k++) {
    const req = queue.shift();
    const r = requestBuilding(state, req.type, { ...req, fromQueue: true });
    if (!r.ok && r.queued && (req.tries = (req.tries ?? 0) + 1) < RETRY_LIMIT) {
      queue.push(req);
      break;
    }
  }
}

// The starting hamlet for the current terrain seed: adds the moot hall, huts,
// fields and smithy from hamletLayout() and returns the records
// {centre, moot, homes, farms, workshop} so state.js can attach households,
// enterprises and per-hut looks. Footprints only; no lots yet (init adopts them).
export function placeStartingHamlet(state, opts = {}) {
  const layout = hamletLayout(state, opts);
  const add = (rect, fields) => rect && addBuildingRecord(state, {
    x: rect.x, z: rect.z, w: rect.w, d: rect.d, rot: rect.rot, type: rect.type,
    styleEra: 0, built: 1, districtId: opts.districtId ?? 1,
    origin: { year: state.time?.year ?? 0, month: 0, reason: 'founding', payer: null, site: null, card: null, frontage: 0 },
    story: [], ...fields,
  });
  const out = {
    centre: layout.centre,
    moot: add(layout.moot, { variant: 'moot-hall', material: 'timber', chimney: true }),
    homes: layout.homes.map(r => add(r, { variant: 'hut', material: 'thatch', chimney: true })),
    farms: layout.farms.map(r => add(r, { variant: 'field', material: 'timber' })),
    workshop: add(layout.workshop, { variant: 'smithy', material: 'timber', chimney: true }),
  };
  for (const b of state.buildings) setFoundation(state, b);
  bumpWorld(state);
  return out;
}

const OPEN_BUILD = new Set(['farm', 'park', 'bridge']);

// The walkable deck between a waterfront building and the water: land cells
// within three cells of the walls that lie nearer the water than the walls
// do. They join the towpath.
function layApron(state, b) {
  const fb = footprintBank(b, 0);
  if (fb.minBankCore > 6) return 0;
  const fp = footprints(state);
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  let n = 0;
  for (let z = cz0 - 3; z <= cz1 + 3; z++)
    for (let x = cx0 - 3; x <= cx1 + 3; x++) {
      const j = cellIndex(x, z);
      if (j < 0 || fp.blocked[j] || terrainGrid().water[j]) continue;
      const c = cellCenter(j);
      if (bankDistance(c.x, c.z) < fb.minBankCore && setTowpath(state, j)) n++;
    }
  if (n) bumpNav(state);
  return n;
}

// The cells under a new footprint stop being path: tier 0, no wear. Walkers
// reroute and wear a detour. A cut track gets a chronicle line; a cut road
// also makes people a little angry.
function closePathsUnder(state, b, worst, districtId) {
  clearUnder(state, b);
  bumpNav(state);
  if (worst < 2) return;
  const where = state.districts?.find(d => d.id === districtId)?.name;
  const what = worst >= 3 ? 'the road' : 'the old lane';
  emitChronicle(state, {
    kind: 'line',
    text: `A family built across ${what}${where ? ` in ${where}` : ''}. People now walk around it.`,
    refs: { buildingId: b.id, districtId, ...centreRef(state, b.x, b.z) },
  });
  if (worst >= 3) delta(state, 'unrest', 0.01, 'road-cut');
}

// Clears tier and wear under a building (its door cell keeps its wear: it is
// the doorstep people use). Returns the number of cells changed.
function clearUnder(state, b) {
  const r = state.roads;
  const { cx0, cz0, cx1, cz1 } = buildingCells(b);
  const door = doorCell(b);
  let changed = 0;
  for (let z = cz0; z <= cz1; z++)
    for (let x = cx0; x <= cx1; x++) {
      const j = cellIndex(x, z);
      // Water under a deck stays deck; a land cell under a building is no road.
      if (j < 0 || j === door || ((r.planned[j] & 2) && terrainGrid().water[j])) continue;
      if (r.tier[j] || r.wear[j]) {
        setTier(state, j, 0);
        r.wear[j] = 0;
        r.low[j] = 0;
        markDirty(r, j);
        changed++;
      }
    }
  return changed;
}

// First tick and yearly: no road stays painted under a building.
export function clearRoadsUnderBuildings(state) {
  let cells = 0;
  for (const b of state.buildings ?? []) {
    if (OPEN_BUILD.has(b.type) || b.type === 'monument') continue;
    cells += clearUnder(state, b);
  }
  if (cells) bumpNav(state);
  return cells;
}

// Gives buildings without a lot (the starting hamlet, fixtures) a lot record.
export function adoptLots(state) {
  for (const b of state.buildings ?? []) {
    if (b.lotId != null || b.type === 'bridge') continue;
    const rect = lotForBuilding(b);
    const lot = claimSite(state, { ...rect, front: -1 }, { buildingId: b.id, districtId: b.districtId });
    b.lotId = lot.id;
  }
}

registerProjectKind('build', {
  complete(state, p) {
    const b = byId(state, 'buildings', p.buildingId);
    if (!b) return;
    b.built = 1;
    delete b.flags.scaffold;
    addBuildingStory(state, b, 'built');
    if (p.data?.replaces != null) finishRelocation(state, p, b);
    touchBuilding(state, b);
    // Lets enterprises.js open the business once its building stands.
    findHook('buildingDone')?.(state, b, p);
  },
});

// ---------------------------------------------------------------- organic growth

// New homes for households without one: one home per household-sized gap,
// sites chosen by builders through choose_site. Later eras build a tier below
// the era's best. Monthly, homesWanted() sets the target; startHomes() then
// places at most one home per call (the tick hook spreads the work).
export function homesWanted(state, maxStarts = 6) {
  const homeless = (state.households ?? []).filter(h => h.homeId == null);
  if (!homeless.length) return (state.homesWanted = 0);
  const people = homeless.reduce((n, h) => n + (h.size ?? 1), 0);
  const pending = (state.projects ?? []).filter(p => p.kind === 'build' && byId(state, 'buildings', p.buildingId)?.type === 'home').length;
  const tier = newHomeTier(state);
  state.homesWanted = Math.max(0, Math.min(maxStarts, Math.ceil(people / TYPES.home.capacity[tier - 1]) - pending));
  return state.homesWanted;
}

// A tier below the era's best, or the best in the town's most valuable
// districts (top third by land value).
function newHomeTier(state, districtId = null) {
  const best = eraMaxTier('home', state.era ?? 0);
  return districtId != null && districtValueRank(state, districtId) >= 2 / 3 ? best : Math.max(1, best - 1);
}

// The richest household that can put down half the cost of a new home.
const LANDLORD_SHARE = 0.5;

function landlordFor(state, cost) {
  let best = null;
  for (const h of state.households ?? []) {
    if ((h.savings ?? 0) < cost * LANDLORD_SHARE) continue;
    if (!best || h.savings > best.savings || (h.savings === best.savings && h.id < best.id)) best = h;
  }
  return best;
}

// Home sites are searched once a month as a batch and re-checked before use.
// The batch lives in state (state.homeBatch) so a restored save replays exactly.
function homeCandidates(state, tier, near) {
  const month = (state.time?.year ?? 0) * 12 + (state.time?.month ?? 0);
  let batch = state.homeBatch;
  let fresh = false;
  if (!batch || batch.month !== month || batch.tier !== tier || !batch.sites.length) {
    batch = { month, tier, sites: proposeSites(state, { type: 'home', tier, near, count: 4 + 4 * (state.homesWanted ?? 1) }) };
    state.homeBatch = batch;
    fresh = true;
  }
  const ctx = siteContext(state);
  const out = [];
  while (batch.sites.length && out.length < 4) {
    const site = batch.sites.shift();
    if (siteStillFree(state, site, ctx)) out.push(site);
  }
  batch.sites.unshift(...out);
  // A stale batch that has run dry: search once more.
  if (!out.length && !fresh) {
    batch.sites = [];
    return homeCandidates(state, tier, near);
  }
  return { options: out, ctx, batch };
}

export function startHomes(state, max = 1) {
  let started = 0;
  while (started < max && (state.homesWanted ?? 0) > 0) {
    state.homesWanted--;
    const building = new Set((state.projects ?? []).map(p => byId(state, 'buildings', p.buildingId)?.ownerHouseholdId).filter(id => id != null));
    const homeless = (state.households ?? []).filter(h => h.homeId == null && !building.has(h.id));
    homeless.sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0) || a.id - b.id);
    const h = homeless[0];
    const districtId = h?.districtId ?? null;
    const near = districtId != null ? state.districts?.find(d => d.id === districtId)?.centroid : undefined;
    const tier = newHomeTier(state, districtId);
    // Homes are never a charge on the treasury: the homeless household builds
    // (and pays what it can), else a landlord with the means does, else we wait.
    const owner = h ?? landlordFor(state, costOf('home', tier, state.era ?? 0));
    if (!owner) break;
    const { options, ctx, batch } = homeCandidates(state, tier, near);
    const site = options.length ? chooseSite(state, { type: 'home', tier, near }, undefined, options) : null;
    if (!site) continue;
    batch.sites = batch.sites.filter(s => s !== site);
    if (!siteStillFree(state, site, ctx, true)) continue;
    placeBuilding(state, site, { type: 'home', tier, payer: `household:${owner.id}`, ownerHouseholdId: owner.id, reason: h ? 'homes' : 'landlord' });
    started++;
  }
  return started;
}

// Convenience for tests and tools: set the target and start everything now.
export function growHomes(state, maxStarts = 6) {
  homesWanted(state, maxStarts);
  return startHomes(state, maxStarts);
}

// Yearly: neighbours who both chose to rebuild merge into terraces.
export function mergeWilling(state, max = 3) {
  let merged = 0;
  for (const pair of mergeCandidates(state)) {
    if (merged >= max) break;
    if (mergeIntoTerrace(state, pair.a, pair.b).ok) merged++;
  }
  return merged;
}

// ---------------------------------------------------------------- upgrades

// Can this building go up a tier now? {ok, reason?, tier, cost, grow?}
export function canUpgrade(state, b) {
  const era = state.era ?? 0;
  const tier = (b.tier ?? 1) + 1;
  if ((b.built ?? 1) < 1 || hasProject(state, b.id)) return { ok: false, reason: 'busy' };
  if (tier > maxTier(b.type)) return { ok: false, reason: 'top' };
  if (tier > eraMaxTier(b.type, era)) return { ok: false, reason: 'era' };
  // Density shapes how homes grow (taller, terraces), so only the big tiers
  // (4: terraces and tenements, 5: blocks) wait for room.
  if (b.type === 'home' && tier >= 4 && overDensity(state, b)) return { ok: false, reason: 'density' };
  const lot = lotOf(state, b);
  const [, needDepth] = lotSize(b.type, tier);
  const [, haveDepth] = lot ? depthOf(lot) : [0, needDepth];
  let grow = null;
  if (lot && needDepth > haveDepth) {
    grow = deepenLot(state, lot, needDepth - haveDepth, b.type);
    if (!grow) return { ok: false, reason: 'room' };
  }
  return { ok: true, tier, cost: costOf(b.type, tier, era) - Math.round(costOf(b.type, tier - 1, era) * 0.4), grow };
}

function depthOf(lot) {
  const facingZ = (lot.rot ?? 0) % 2 === 0;
  return facingZ ? [lot.w, lot.h] : [lot.h, lot.w];
}

const DENSITY_SLACK = 0.35;

function overDensity(state, b) {
  const [cx, cz] = [Math.floor((b.x - ORIGIN_X) / CELL), Math.floor((b.z - ORIGIN_Z) / CELL)];
  return localDensity(state, cx, cz) > densityTarget(state) + DENSITY_SLACK;
}

export function lotOf(state, b) { return (state.lots ?? []).find(l => l.id === b.lotId) ?? null; }

export function hasProject(state, buildingId) {
  return (state.projects ?? []).some(p => p.buildingId === buildingId);
}

// Starts an in-place upgrade (tier + 1). The building stays in use under a
// scaffold until the work is done.
export function startUpgrade(state, b, { payer, paid = false } = {}) {
  const check = canUpgrade(state, b);
  if (!check.ok) return { ok: false, reason: check.reason };
  b.flags.scaffold = 1;
  touchBuilding(state, b);
  const project = createProject(state, {
    kind: 'upgrade', buildingId: b.id, x: b.x, z: b.z, w: b.w, d: b.d,
    cost: check.cost, payer: payer ?? ownerPayer(b), paid, data: { tier: check.tier, grow: check.grow },
  });
  return { ok: true, project };
}

function ownerPayer(b) { return b.ownerHouseholdId != null ? `household:${b.ownerHouseholdId}` : 'treasury'; }

registerProjectKind('upgrade', {
  complete(state, p) {
    const b = byId(state, 'buildings', p.buildingId);
    if (!b) return;
    const era = state.era ?? 0;
    const lot = lotOf(state, b);
    // The town may have changed since the upgrade began: grow only if the
    // extra ground is still free (else the new tier fits the old lot).
    const extra = p.data.grow && lot ? p.data.grow.w * p.data.grow.h / Math.max(1, lot.w * lot.h) : 0;
    const grow = extra > 1 ? deepenLot(state, lot, Math.round((p.data.grow.w * p.data.grow.h - lot.w * lot.h) / ((lot.rot ?? 0) % 2 === 0 ? lot.w : lot.h)), b.type) : null;
    if (grow && lot) {
      resizeLot(state, lot, grow);
      Object.assign(b, footprintFor(lot, b.type));
      bumpWorld(state);
      clearUnder(state, b);
      bumpNav(state);
    }
    b.tier = p.data.tier;
    b.storeys = Math.max(b.storeys ?? 1, storeysFor(b.type, b.tier, era));
    b.variant = variantFor(b.type, b.tier, state, b.id);
    b.styleEra = era;
    b.material = materialFor(era, b.type);
    b.condition = 1;
    delete b.flags.scaffold;
    setFoundation(state, b);
    addBuildingStory(state, b, 'upgraded', { text: p.data.merged ? `${b.variant} (two homes joined)` : b.variant });
    touchBuilding(state, b);
  },
});

// Extend: one more storey if the era allows, otherwise a side extension (max 2).
export function extendBuilding(state, b, { payer, paid = false } = {}) {
  if ((b.built ?? 1) < 1 || hasProject(state, b.id)) return { ok: false, reason: 'busy' };
  const era = state.era ?? 0;
  const storey = (b.storeys ?? 1) < Math.min(eraMaxStoreys(era), storeysFor(b.type, b.tier, era) + 1);
  if (!storey && (b.extensions?.length ?? 0) >= 2) return { ok: false, reason: 'room' };
  b.flags.scaffold = 1;
  touchBuilding(state, b);
  const cost = Math.round(costOf(b.type, b.tier, era) * 0.3);
  const project = createProject(state, { kind: 'extend', buildingId: b.id, x: b.x, z: b.z, w: b.w, d: b.d, cost, payer: payer ?? ownerPayer(b), paid, data: { storey } });
  return { ok: true, project };
}

registerProjectKind('extend', {
  complete(state, p) {
    const b = byId(state, 'buildings', p.buildingId);
    if (!b) return;
    if (p.data.storey) b.storeys = (b.storeys ?? 1) + 1;
    else {
      b.extensions ??= [];
      const side = (b.rot + 1 + b.extensions.length * 2) % 4;
      b.extensions.push({ side, w: Math.min(b.w, 3), d: Math.min(b.d, 2.4) });
    }
    addBuildingStory(state, b, 'extended', { text: p.data.storey ? 'another storey' : 'a side wing' });
    delete b.flags.scaffold;
    touchBuilding(state, b);
  },
});

// An enterprise chose to expand: up a tier if it can, else a storey or an
// annex. Returns {ok, project?, reason?}.
export function growBuilding(state, b, { payer, paid = false } = {}) {
  if (!b) return { ok: false, reason: 'gone' };
  const up = startUpgrade(state, b, { payer, paid });
  if (up.ok) return up;
  if (up.reason === 'busy') return up;
  return extendBuilding(state, b, { payer, paid });
}

// Repair resets condition and freshens age a little.
export function repairBuilding(state, b) {
  b.condition = 1;
  b.age = Math.max(0, (b.age ?? 0) - 5);
  delete b.flags.derelict;
  addBuildingStory(state, b, 'repaired');
  touchBuilding(state, b);
}

// ---------------------------------------------------------------- merges

// A household on this home chose rebuild-up. Remember it; two neighbours who
// both want it within MERGE_WINDOW years can merge into a terrace.
export function noteRebuildWish(state, b) { b.wantsUp = state.time?.year ?? 0; }

// Adjacent home pairs (tier <= 2, same facing, sharing a full edge) whose
// owners both want to rebuild. Requires era >= 3 (terraces).
export function mergeCandidates(state) {
  if ((state.era ?? 0) < 3) return [];
  const year = state.time?.year ?? 0;
  const lots = new Map((state.lots ?? []).map(l => [l.id, l]));
  const homes = state.buildings.filter(b => b.type === 'home' && b.tier <= 2 && (b.built ?? 1) >= 1
    && b.wantsUp != null && year - b.wantsUp <= MERGE_WINDOW && lots.has(b.lotId) && !hasProject(state, b.id));
  const out = [];
  const used = new Set();
  for (const a of homes) {
    if (used.has(a.id)) continue;
    for (const c of homes) {
      if (c === a || used.has(c.id)) continue;
      const rect = mergedRect(lots.get(a.lotId), lots.get(c.lotId));
      if (!rect || !mergedDoorFree(state, rect, a, c) || !gapFree(state, rect, a, c)) continue;
      out.push({ a: a.id, b: c.id, rect });
      used.add(a.id);
      used.add(c.id);
      break;
    }
  }
  return out;
}

// The merged terrace's door (middle of the joined front) must open onto a
// free cell, not into a third building or lot.
function mergedDoorFree(state, rect, a, c) {
  const f = frontCell({ ...footprintFor(rect, 'home') });
  if (f < 0 || terrainGrid().water[f] === 1) return false;
  const owner = footprints(state).blocked[f] - 1;
  if (owner >= 0 && owner !== a.id && owner !== c.id) return false;
  const lot = lotGrid(state).cells[f] - 1;
  return lot < 0 || lot === a.lotId || lot === c.lotId;
}

// The cells between two merging lots must be empty ground, and nobody
// else's doorstep.
function gapFree(state, rect, a, c) {
  const fp = footprints(state);
  const lots = lotGrid(state).cells;
  const fronts = frontCells(state);
  const own = new Set([frontCell(a), frontCell(c)]);
  for (let z = rect.cz; z < rect.cz + rect.h; z++)
    for (let x = rect.cx; x < rect.cx + rect.w; x++) {
      const j = cellIndex(x, z);
      const owner = fp.blocked[j] - 1, lot = lots[j] - 1;
      if (owner >= 0 && owner !== a.id && owner !== c.id) return false;
      if (lot >= 0 && lot !== a.lotId && lot !== c.lotId) return false;
      if (fronts.has(j) && !own.has(j)) return false;
    }
  return true;
}

// Two lots merge when they face the same way and sit side by side along the
// frontage with equal depth.
// Lots keep a one-cell gap, so the merged terrace takes in the gap too.
export function mergedRect(l1, l2) {
  if (!l1 || !l2 || (l1.rot ?? 0) !== (l2.rot ?? 0)) return null;
  const facingZ = (l1.rot ?? 0) % 2 === 0;
  if (facingZ) {
    if (l1.cz !== l2.cz || l1.h !== l2.h) return null;
    const [left, right] = l1.cx < l2.cx ? [l1, l2] : [l2, l1];
    const gap = right.cx - (left.cx + left.w);
    if (gap < 0 || gap > 1) return null;
    return { cx: left.cx, cz: left.cz, w: right.cx + right.w - left.cx, h: left.h, rot: l1.rot };
  }
  if (l1.cx !== l2.cx || l1.w !== l2.w) return null;
  const [low, high] = l1.cz < l2.cz ? [l1, l2] : [l2, l1];
  const gap = high.cz - (low.cz + low.h);
  if (gap < 0 || gap > 1) return null;
  return { cx: low.cx, cz: low.cz, w: low.w, h: high.cz + high.h - low.cz, rot: l1.rot };
}

// Merges two neighbouring homes into one building on the joined lot and
// starts the rebuild to a tier-4 terrace. Households of the removed home move
// into the merged one.
export function mergeIntoTerrace(state, idA, idB, { payer } = {}) {
  const a = byId(state, 'buildings', idA), c = byId(state, 'buildings', idB);
  if (!a || !c || (state.era ?? 0) < 3) return { ok: false, reason: 'era' };
  const la = lotOf(state, a), lc = lotOf(state, c);
  const rect = mergedRect(la, lc);
  if (!rect) return { ok: false, reason: 'shape' };
  releaseLot(state, lc.id);
  resizeLot(state, la, rect);
  removeBuildingRecord(state, c.id);
  for (const h of state.households ?? []) if (h.homeId === c.id) h.homeId = a.id;
  Object.assign(a, footprintFor(la, 'home'));
  a.tier = Math.max(a.tier, c.tier);
  a.wantsUp = null;
  a.flags.scaffold = 1;
  a.mergedFrom = [...(a.mergedFrom ?? []), c.id];
  clearUnder(state, a);
  setFoundation(state, a);
  touchBuilding(state, a);
  bumpWorld(state);
  const era = state.era ?? 0;
  const project = createProject(state, {
    kind: 'upgrade', buildingId: a.id, x: a.x, z: a.z, w: a.w, d: a.d,
    cost: costOf('home', 4, era) - costOf('home', 2, era), payer: payer ?? ownerPayer(a),
    data: { tier: Math.min(4, eraMaxTier('home', era)), grow: null, merged: true },
  });
  return { ok: true, building: a, project };
}

// ---------------------------------------------------------------- demolition

export function demolish(state, b, { payer = 'treasury', reason = 'old' } = {}) {
  if (b.flags?.heritage && reason === 'old') return { ok: false, reason: 'heritage' };
  if ((state.projects ?? []).some(p => p.buildingId === b.id && p.kind === 'demolish')) return { ok: false, reason: 'busy' };
  state.projects = (state.projects ?? []).filter(p => p.buildingId !== b.id);
  b.flags.scaffold = 1;
  touchBuilding(state, b);
  const project = createProject(state, {
    kind: 'demolish', buildingId: b.id, x: b.x, z: b.z, w: b.w, d: b.d,
    cost: Math.round(costOf(b.type, b.tier, state.era ?? 0) * 0.1), payer, work: 6, data: { reason },
  });
  return { ok: true, project };
}

registerProjectKind('demolish', {
  complete(state, p) {
    const b = byId(state, 'buildings', p.buildingId);
    if (!b) return;
    if (b.lotId != null) {
      const lot = releaseLot(state, b.lotId);
      if (lot && (VACATED_TYPES.has(b.type) || p.data?.redevelop)) recordVacated(state, lot);
    }
    removeBuildingRecord(state, b.id);
    for (const h of state.households ?? []) if (h.homeId === b.id) h.homeId = null;
    for (const e of state.enterprises ?? []) if (e.buildingId === b.id) e.buildingId = null;
    bumpWorld(state);
  },
});

// ---------------------------------------------------------------- foundations

// Renderer hook fields for how a building meets the ground:
//   foundation      'field' (farms and parks: drape on the terrain),
//                   'plinth' (a level base on dry land), 'piles' (timber
//                   posts on the bank or over the water) or 'quay' (a stone
//                   waterfront: era >= 2 waterfront builds, or an embankment)
//   foundationY     the top of the base: the highest ground under the footprint
//   foundationDrop  how far the base falls to the lowest ground (skirt height)
//   bankDistance    distance from the water's edge (negative over the water)
export function foundationFor(state, b) {
  const fb = bankOf(b);
  // Fields and lawns follow the ground: the renderer drapes them.
  if (b.type === 'farm' || b.type === 'park') {
    return { foundation: 'field', foundationY: round2(fb.maxH), foundationDrop: round2(fb.maxH - Math.max(fb.minH, -0.8)), bankDistance: round2(fb.minBankCore) };
  }
  // Waterfront buildings at the water (behind their apron) always stand on
  // piles or a stone quay.
  const waterside = WATERFRONT.has(b.type) && fb.minBankCore <= 5.5;
  const near = waterside || fb.minBank < setbackAt(state, fb.nearest.x, fb.nearest.z);
  const embanked = isEmbanked(state, fb.nearest.x, fb.nearest.z);
  let foundation = 'plinth';
  if (near && WATERFRONT.has(b.type)) foundation = embanked || (b.styleEra ?? state.era ?? 0) >= 2 ? 'quay' : 'piles';
  else if (near) foundation = embanked ? 'quay' : 'piles';
  const ground = Math.max(fb.maxH, foundation === 'plinth' ? -Infinity : 0.25);
  return {
    foundation,
    foundationY: round2(ground),
    foundationDrop: round2(ground - Math.max(fb.minH, -0.8)),
    bankDistance: round2(fb.minBankCore),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

// The bank survey depends only on the footprint and the terrain, so it is kept
// on the building (not saved) and survives embankment work, which changes
// only the cheap part of the foundation rule.
function bankOf(b) {
  const key = `${b.x},${b.z},${b.w},${b.d}`;
  if (b._fb?.key !== key) b._fb = { key, bank: footprintBank(b) };
  return b._fb.bank;
}

function foundationKey(state, b) { return `${b.x},${b.z},${b.w},${b.d},${b.type},${state.roads?.embankRev ?? 0}`; }

// Sets the foundation fields; returns true if anything changed.
export function setFoundation(state, b) {
  if (b.type === 'bridge') return false;
  const key = foundationKey(state, b);
  if (b._fk === key) return false;
  b._fk = key;
  const f = foundationFor(state, b);
  if (b.foundation === f.foundation && b.foundationY === f.foundationY && b.foundationDrop === f.foundationDrop) {
    b.bankDistance = f.bankDistance;
    return false;
  }
  Object.assign(b, f);
  return true;
}

// On init, restore and every year: every building gets its foundation, and
// ordinary buildings that stand too close to the river (old saves, fixtures,
// a bank that was never checked) are raised on posts rather than removed.
export function settleFoundations(state) {
  return reportRaised(state, settleFoundationsSpan(state, 0, Infinity).raised);
}

// Buildings [from, from + count): world.js spreads the yearly pass over ticks.
// Returns how many were raised and where the next span starts (null at the end).
export function settleFoundationsSpan(state, from, count) {
  const list = state.buildings ?? [];
  const end = Math.min(list.length, from + count);
  let raised = 0;
  for (let k = from; k < end; k++) {
    const b = list[k];
    const wasRaised = b.flags?.raised;
    if (!setFoundation(state, b)) continue;
    if (b.foundation !== 'plinth' && !WATERFRONT.has(b.type) && !wasRaised) {
      b.flags.raised = 1;
      addBuildingStory(state, b, 'raised', { text: 'set on posts above the river' });
      raised++;
    }
    touchBuilding(state, b);
  }
  return { raised, next: end < list.length ? end : null };
}

export function reportRaised(state, raised) {
  if (raised) {
    const text = raised === 1
      ? 'A family by the river raised their house on posts above the water.'
      : `${countWord(raised)} households by the river raised their buildings on posts above the water.`;
    emitChronicle(state, { kind: 'line', text, refs: { raised } });
  }
  return raised;
}

// Buildings whose door opens into another building, the river, off the map
// or into a closed-in pocket turn to face a side that reaches the town's main
// walkable region (same footprint). Returns how many turned.
export function freeSealedDoors(state) {
  const grid = navGrid(state);
  const comp = components(grid);
  const sizes = new Map();
  for (const c of comp) if (c) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  let main = 0, best = 0;
  for (const [c, n] of sizes) if (n > best) { best = n; main = c; }
  const fp = footprints(state);
  const reaches = f => f >= 0 && comp[f] === main;
  // A cell blocked only by this building's own margin opens once its door
  // faces it; it counts if a neighbour reaches the town.
  const reachesFor = (b, f) => reaches(f) || (f >= 0 && fp.blocked[f] === b.id + 1 && neighbours4(f).some(reaches));
  let turned = 0;
  for (const b of state.buildings ?? []) {
    if (['farm', 'park', 'bridge', 'monument'].includes(b.type) || reaches(frontCell(b))) continue;
    const rot = b.rot ?? 0;
    for (let k = 1; k < 4; k++) {
      const r = (rot + k) % 4;
      if (!reachesFor(b, frontCell({ ...b, rot: r }))) continue;
      b.rot = r;
      touchBuilding(state, b);
      turned++;
      break;
    }
  }
  if (turned) bumpWorld(state);
  return turned;
}

function neighbours4(i) {
  const x = i % GRID_W;
  return [x > 0 ? i - 1 : -1, x < GRID_W - 1 ? i + 1 : -1, i - GRID_W, i + GRID_W].filter(j => j >= 0 && j < CELLS);
}

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
function countWord(n) { return COUNT_WORDS[n] ?? String(n); }

// ---------------------------------------------------------------- farms give way

const VACATED_TYPES = new Set(['farm', 'workshop', 'mill', 'warehouse', 'factory', 'shop', 'inn']);

// A business moves to cheaper ground: the new building goes up first; when it
// is finished the business moves in and the old one comes down (its lot goes
// back to building). Returns {ok, building?, project?, reason?}.
export function relocateEnterprise(state, enterprise, { site = null, payer = null, reason = 'relocated' } = {}) {
  const old = byId(state, 'buildings', enterprise.buildingId);
  if (!old) return { ok: false, reason: 'gone' };
  const choice = site ?? chooseSite(state, { type: old.type, tier: old.tier, relocate: true, from: { x: old.x, z: old.z } }, undefined, relocationSites(state, enterprise));
  if (!choice) return { ok: false, reason: 'no-site' };
  const placed = placeBuilding(state, choice, {
    type: old.type, tier: old.tier, variant: old.variant, ownerHouseholdId: old.ownerHouseholdId ?? enterprise.ownerHouseholdId ?? null,
    payer: payer ?? `enterprise:${enterprise.id}`, reason,
  });
  placed.project.data.replaces = old.id;
  placed.project.data.enterpriseId = enterprise.id;
  return { ok: true, ...placed };
}

// An empty building handed back (a business moved, a site was sold): it is
// cleared and its lot goes back into the site pool at today's land value,
// with a pull for redevelopment. Heritage buildings stay standing.
export function releaseBuilding(state, b) {
  if (!b || b.type === 'bridge' || b.flags?.heritage) return { ok: false, reason: 'kept' };
  if ((state.enterprises ?? []).some(e => e.buildingId === b.id)) return { ok: false, reason: 'in-use' };
  const r = demolish(state, b, { payer: b.ownerHouseholdId != null ? `household:${b.ownerHouseholdId}` : 'treasury', reason: 'released' });
  if (r.ok) r.project.data.redevelop = true;
  return r;
}

function finishRelocation(state, p, b) {
  const old = byId(state, 'buildings', p.data.replaces);
  const firm = (state.enterprises ?? []).find(e => e.id === p.data.enterpriseId);
  if (firm) firm.buildingId = b.id;
  if (old) {
    demolish(state, old, { payer: p.payer, reason: 'relocated' });
    addBuildingStory(state, b, 'converted', { text: 'moved here from dearer ground' });
    findHook('displaced')?.(state, { kind: old.type, reason: 'relocated', households: [old.ownerHouseholdId].filter(id => id != null), buildingId: old.id });
  }
}

// Yearly: farms where land has grown dear think about selling (decision kind
// farm_land: keep | sell_some_plots | sell_all_and_move_out). Selling frees
// land along the paths for homes; the farmer is paid when someone builds
// there (state.landSales), and may start a new farm at the edge of town.
const FARM_SALE_VALUE = 0.5;          // land value (0..1) where farmers start to think
const COIN_PER_VALUE = 1200;          // a field's worth as building land, per unit of land value
const SALE_PER_CELL = 10;             // coin per cell at full land value

const FARM_SALE_POP = 300;            // a town, not a hamlet, before farms sell up
const FARM_SALE_FOOD = 6;             // months of food in store that make a sale safe
const FARM_SALE_GAP = 15;             // years between sales of the same farm

// Does the town need the land, and can it spare the food?
function farmlandWanted(state) {
  const I = state.indicators ?? {};
  if ((I.pop ?? 0) < FARM_SALE_POP || (I.foodBalance ?? 0) < FARM_SALE_FOOD) return false;
  if ((state.buildings ?? []).filter(b => b.type === 'farm').length < 3) return false;
  return (I.housingPressure ?? 0) > 0.2 || (state.households ?? []).some(h => h.homeId == null);
}

export function farmsGiveWay(state, rand = () => rng(state), { force = false } = {}) {
  if (!force && !farmlandWanted(state)) return 0;
  let sold = 0;
  const year = state.time?.year ?? 0;
  for (const b of [...(state.buildings ?? [])]) {
    if (b.soldAt != null && year - b.soldAt < FARM_SALE_GAP) continue;
    if (b.type !== 'farm' || (b.built ?? 1) < 1 || hasProject(state, b.id)) continue;
    // What the land is worth as building plots: judged at the gate (on the
    // street) as well as in the middle of the field.
    const [cx, cz] = worldToCell(b.x, b.z);
    const gate = frontCell(b);
    const value = Math.max(landValueNorm(state, cx, cz), gate >= 0 ? landValueNorm(state, gate % GRID_W, Math.floor(gate / GRID_W)) : 0);
    if (value < FARM_SALE_VALUE) continue;
    const firm = (state.enterprises ?? []).find(e => e.buildingId === b.id);
    const owner = b.ownerHouseholdId ?? firm?.ownerHouseholdId ?? null;
    const profit = Math.max(1, firm?.profitLastYear ?? firm?.profit ?? 50);
    const ratio = (value * COIN_PER_VALUE) / profit;
    const prior = { keep: 4, sell_some_plots: Math.min(4, ratio / 6), sell_all_and_move_out: Math.min(2, (ratio / 12) ** 2) };
    const choice = decide(state, 'farm_land', {
      type: 'farm', record: { buildingId: b.id, landValue: band3(value), profit: Math.round(profit), districtId: b.districtId, cells: (b.w * b.d) / 4 },
    }, { prior, rng: rand });
    if (choice === 'sell_some_plots' && sellHalf(state, b, owner, value)) sold++;
    else if (choice === 'sell_all_and_move_out' && sellAll(state, b, owner, value)) sold++;
  }
  return sold;
}

function band3(v) { return v < 0.65 ? 'rising' : v < 0.8 ? 'high' : 'very high'; }

function recordSale(state, rect, owner, value) {
  state.landSales ??= [];
  state.landSales.push({ ...rect, cells: rect.w * rect.h, owner: owner != null ? `household:${owner}` : 'treasury', perCell: Math.round(SALE_PER_CELL * value * 10) / 10, year: state.time?.year ?? 0 });
}

// Sells the half of the field nearer the middle of town.
function sellHalf(state, b, owner, value) {
  const lot = lotOf(state, b);
  if (!lot || Math.max(lot.w, lot.h) < 6) return false;
  const { centroid } = buildingBins(state);
  const alongX = lot.w >= lot.h;
  const keep = { ...lot };
  const sold = { ...lot };
  const half = Math.floor((alongX ? lot.w : lot.h) / 2);
  const townFirst = alongX ? centroid.x < b.x : centroid.z < b.z;
  if (alongX) {
    keep.w = lot.w - half; sold.w = half;
    if (townFirst) keep.cx = lot.cx + half; else sold.cx = lot.cx + lot.w - half;
  } else {
    keep.h = lot.h - half; sold.h = half;
    if (townFirst) keep.cz = lot.cz + half; else sold.cz = lot.cz + lot.h - half;
  }
  resizeLot(state, lot, { cx: keep.cx, cz: keep.cz, w: keep.w, h: keep.h });
  Object.assign(b, footprintFor(lot, 'farm'));
  setFoundation(state, b);
  bumpWorld(state);
  bumpNav(state);
  recordSale(state, sold, owner, value);
  b.soldAt = state.time?.year ?? 0;
  addBuildingStory(state, b, 'converted', { text: 'half the field sold for houses' });
  touchBuilding(state, b);
  recordVacated(state, sold);
  emitChronicle(state, { kind: 'line', text: 'A farming family sold the bottom field. Houses will go up where the barley grew.', refs: { buildingId: b.id, ...centreRef(state, b.x, b.z) } });
  findHook('displaced')?.(state, { kind: 'farm', reason: 'sale', households: [owner].filter(id => id != null), buildingId: b.id });
  return true;
}

// Sells the whole farm and moves out to the edge of town.
function sellAll(state, b, owner, value) {
  const lot = lotOf(state, b);
  if (!lot) return false;
  const rect = { cx: lot.cx, cz: lot.cz, w: lot.w, h: lot.h };
  // The new farm first: nobody sells the land that feeds them before the
  // new fields are begun.
  const firm = (state.enterprises ?? []).find(e => e.buildingId === b.id);
  const site = firm ? chooseSite(state, { type: 'farm', relocate: true, from: { x: b.x, z: b.z } }, undefined, relocationSites(state, firm)) : null;
  const moved = requestBuilding(state, 'farm', { payer: owner != null ? `household:${owner}` : 'treasury', ownerHouseholdId: owner, reason: 'moved-out', fromQueue: true, site: site ?? undefined });
  if (!moved.ok) return false;
  if (!demolish(state, b, { payer: owner != null ? `household:${owner}` : 'treasury', reason: 'sold' }).ok) return false;
  recordSale(state, rect, owner, value);
  recordVacated(state, rect);
  emitChronicle(state, { kind: 'line', text: 'A farming family sold their land to the town and moved out past the last houses.', refs: { buildingId: b.id, ...centreRef(state, b.x, b.z) } });
  findHook('displaced')?.(state, { kind: 'farm', reason: 'sale', households: [owner].filter(id => id != null), buildingId: b.id });
  return true;
}

// ---------------------------------------------------------------- visual hooks

// Monthly: occupied / open / lit / smoke from households and enterprises.
export function monthlyBuildings(state) {
  // Anyone added without one (older saves, other modules) gets a foundation.
  for (const b of state.buildings ?? []) if (b.foundation == null && setFoundation(state, b)) touchBuilding(state, b);
  const homes = new Set((state.households ?? []).map(h => h.homeId));
  const firms = new Map();
  for (const e of state.enterprises ?? []) if (e.buildingId != null) firms.set(e.buildingId, e);
  for (const b of state.buildings ?? []) {
    const done = (b.built ?? 1) >= 1;
    const firm = firms.get(b.id);
    const occupied = done && (b.type === 'home' ? homes.has(b.id) : !!firm || PUBLIC.has(b.type));
    const working = !!firm && (firm.public || (firm.filled ?? 1) > 0);
    const smoke = done && working ? smokeFor(b) : b.type === 'home' && occupied ? 0.15 : 0;
    const open = occupied && b.type !== 'home' && (b.type !== 'farm' || working);
    if (b.occupied !== occupied || b.open !== open || b.lit !== occupied || Math.abs((b.smoke ?? 0) - smoke) > 0.01) {
      b.occupied = occupied;
      b.open = open;
      b.lit = occupied;
      b.smoke = smoke;
      touchBuilding(state, b);
    }
  }
}

const PUBLIC = new Set(['chapel', 'moot', 'school', 'market', 'park', 'monument', 'infirmary', 'watch', 'library', 'bathhouse', 'union-hall', 'bridge', 'quay']);

function smokeFor(b) {
  const s = TYPES[b.type]?.smoke;
  return s ? s[Math.min(b.tier, s.length) - 1] : 0;
}

// Yearly: age, condition, derelicts and heritage. Restyles on era change are
// scheduled and applied by eras.js (scheduleRestyle / applyRestyles).
// The whole yearly pass at once (tests, tools). In play world.js runs these
// steps one per tick (see YEAR_STEPS there).
export function yearlyBuildings(state) {
  followOwnerWealth(state);
  farmsGiveWay(state);
  clearRoadsUnderBuildings(state);
  freeSealedDoors(state);
  settleFoundations(state);
  ageBuildings(state);
}

// Age, condition, derelicts and heritage.
export function ageBuildings(state) {
  for (const b of state.buildings ?? []) {
    if ((b.built ?? 1) < 1 || b.type === 'bridge') continue;
    b.age = (b.age ?? 0) + 1;
    const wear = b.wealth < 0.3 ? 0.015 : 0.01;
    b.condition = Math.max(0, (b.condition ?? 1) - wear);
    if (!b.occupied && b.condition < 0.3 && b.type !== 'park' && b.type !== 'monument' && !b.flags.derelict) {
      b.flags.derelict = 1;
      addBuildingStory(state, b, 'derelict');
    }
    if (b.age >= 80 && !b.flags.heritage && !b.flags.heritageChecked) {
      b.flags.heritageChecked = 1;
      if (rng(state) < 0.05) {
        b.flags.heritage = 1;
        emitChronicle(state, { kind: 'line', text: `People are proud of the old ${labelOf(b)}. They want it kept.`, refs: { buildingId: b.id, ...centreRef(state, b.x, b.z) } });
      }
    }
    touchBuilding(state, b);
  }
}

// Homes drift toward their residents' wealth rank in town (0 poorest, 1
// richest), so rich streets look cared for and poor ones shabby.
export function followOwnerWealth(state) {
  const list = (state.households ?? []).filter(h => h.homeId != null);
  if (list.length < 2) return;
  const sorted = list.map(h => h.wealth ?? 0).sort((a, b) => a - b);
  const rank = w => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < w) lo = mid + 1; else hi = mid; }
    return lo / (sorted.length - 1);
  };
  const sums = new Map();
  for (const h of list) {
    const s = sums.get(h.homeId) ?? { r: 0, n: 0 };
    s.r += rank(h.wealth ?? 0);
    s.n++;
    sums.set(h.homeId, s);
  }
  for (const [id, s] of sums) {
    const b = byId(state, 'buildings', id);
    if (b) setBuildingWealth(state, b, (b.wealth ?? 0.3) + (s.r / s.n - (b.wealth ?? 0.3)) * 0.3);
  }
}

function labelOf(b) { return (b.variant ?? b.type).replace(/-/g, ' '); }

// Owner wealth moves the building's look (trim, windows, gardens).
export function setBuildingWealth(state, b, wealth) {
  const w = Math.max(0, Math.min(1, wealth));
  if (Math.abs((b.wealth ?? 0) - w) < 0.02) return;
  b.wealth = w;
  touchBuilding(state, b);
}
