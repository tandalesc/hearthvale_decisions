// Households: the aggregate population. Each household has a size, savings, a trade,
// a life stage and a home. Visible walkers (people.js) are drawn from households.
//
// Monthly: life stage and type, the housing market (homeless households find room).
// Yearly: births and deaths, new households splitting off, stay-or-move choices, a
// baseline trickle of migrants, wealth bands. Big migration waves, famine and plague
// are events (sim-governance) that call immigrate(), emigrate() and killShare().

import {rng, roundRandom} from './rng.js';
import {decide, findHook} from './hooks.js';
import {capacityOf, canUpgrade, costOf, repairBuilding, noteRebuildWish} from './buildings.js';
import {HOME_TIERS, TRADES, makeHousehold, byId, emitChronicle} from './state.js';
import {pay, payBuilders, workersOf, flow} from './economy.js';
import {priceLevel, clamp} from './pressures.js';
import {districtLooks} from './aesthetics.js';

const NEWCOMER_YEARS = 10;
const SPLIT_SIZE = 6;
const BASE_BIRTH = 0.06;
const BASE_DEATH = 0.012;

export const homeCapacity = (b) => (b && b.type === 'home' && b.built >= 1 ? capacityOf(b) || (HOME_TIERS[b.tier]?.capacity ?? 5) : 0);

export const population = (state) => state.households.reduce((n, h) => n + h.size, 0);

// ---------------------------------------------------------------------------
// Family stories: a short ring of what happened to each household, for the inspect
// notes. Entries are {year, month, kind, ref?, text?, from?, to?}; text stays short and
// plain (letters, digits, space and , . - ').

const STORY_LENGTH = 8;
const STORY_TEXT = /[^A-Za-z0-9 ,.'-]/g;

export function addStory(state, h, kind, fields = {}) {
  const entry = {year: state.time.year, month: state.time.month, kind};
  if (fields.ref != null) entry.ref = fields.ref;
  if (fields.text) entry.text = String(fields.text).replace(STORY_TEXT, '').slice(0, 60);
  if (fields.from != null) entry.from = String(fields.from).slice(0, 24);
  if (fields.to != null) entry.to = String(fields.to).slice(0, 24);
  const story = (h.story ??= []);
  story.push(entry);
  if (story.length > STORY_LENGTH) story.shift();
}

// Yearly counts of people born, died, arrived and left (state.demography.year, and
// .lastYear for the finished year).
export function countPeople(state, key, n) {
  const d = (state.demography ??= {year: {}, lastYear: {}});
  d.year[key] = (d.year[key] ?? 0) + n;
}

const districtName = (state, id) => state.districts.find((d) => d.id === id)?.name ?? null;

// ---------------------------------------------------------------------------
// Monthly

export function householdsMonthly(state) {
  const year = state.time.year;
  for (const h of state.households) {
    const age = year - h.formedYear;
    h.lifeStage = age < 10 ? 'young' : age < 35 ? 'family' : 'elder';
    h.householdType = typeOf(h);
    if (h.newcomerUntil != null && year >= h.newcomerUntil) h.newcomerUntil = null;
    noteHardTimes(state, h, year);
  }
  housingMarket(state);
}

// Story entries for hunger (once a year) and for losing or finding work.
function noteHardTimes(state, h, year) {
  if ((h.hunger ?? 0) >= 0.5 && h.hungryYear !== year) {
    h.hungryYear = year;
    addStory(state, h, 'hungry');
  }
  if (!(h.workers > 0)) return;
  const working = h.employed / h.workers >= 0.5;
  if (h.working === true && !working && h.employed / h.workers < 0.2) addStory(state, h, 'lost-job');
  else if (h.working === false && working) addStory(state, h, 'job');
  if (working || h.employed / h.workers < 0.2) h.working = working;
}

function typeOf(h) {
  if (h.size <= 1) return 'single';
  if (h.size === 2) return 'couple';
  return h.size >= SPLIT_SIZE ? 'kin-group' : 'family-with-children';
}

// Occupants (people) per home id.
export function occupancy(state) {
  const occ = new Map();
  for (const h of state.households) if (h.homeId != null) occ.set(h.homeId, (occ.get(h.homeId) ?? 0) + h.size);
  return occ;
}

// Homes with free room, as [{home, free}].
export function vacancies(state, occ = occupancy(state)) {
  const list = [];
  for (const b of state.buildings) {
    const cap = homeCapacity(b);
    if (!cap) continue;
    const free = cap - (occ.get(b.id) ?? 0);
    if (free > 0) list.push({home: b, free});
  }
  return list;
}

// Homeless households move into homes with room, richest first, preferring their
// own district. Households whose home is gone become homeless.
function housingMarket(state) {
  for (const h of state.households) {
    if (h.homeId != null && !homeCapacity(byId(state, 'buildings', h.homeId))) h.homeId = null;
  }
  const homeless = state.households.filter((h) => h.homeId == null);
  if (!homeless.length) return;
  const occ = occupancy(state);
  const free = vacancies(state, occ);
  if (!free.length) return;
  homeless.sort((a, b) => b.savings - a.savings || a.id - b.id);
  for (const h of homeless) {
    let best = null, bestScore = -Infinity;
    for (const v of free) {
      if (v.free < Math.min(h.size, 3)) continue;
      // Those who can choose pick the nicer streets (looks 0..1, 0.5 plain).
      const looks = ((v.home.looks ?? 0.5) - 0.5) * (h.savings >= 100 ? 8 : 3);
      const score = v.free + (v.home.districtId === h.districtId ? 4 : 0) + (h.preferCentre != null && v.home.centreId === h.preferCentre ? 6 : 0) -
        (v.home.tier ?? 1) * (h.savings < 100 ? 1 : 0) + looks;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    if (!best) continue;
    moveInto(state, h, best.home);
    best.free -= h.size;
  }
}

// Empty homes with no owner belong to the town; their tenants pay rent to the treasury.
export function moveInto(state, h, home) {
  const from = h.districtId;
  h.preferCentre = null;
  h.homeId = home.id;
  h.districtId = home.districtId ?? h.districtId;
  h.centreId = home.centreId ?? h.centreId ?? null;
  addStory(state, h, 'moved', {ref: home.id, from: districtName(state, from), to: districtName(state, h.districtId)});
}

// ---------------------------------------------------------------------------
// Yearly

// Yearly, in two steps (index.js runs them on consecutive ticks).
export function householdsYearly(state) {
  householdsYearlyLife(state);
  householdsYearlyHomes(state);
  householdsYearlyMoves(state);
}

export function householdsYearlyLife(state) {
  const d = (state.demography ??= {year: {}, lastYear: {}});
  d.lastYear = d.year;
  d.year = {};
  for (const h of state.households) {
    const home = h.homeId != null ? byId(state, 'buildings', h.homeId) : null;
    h.yearAgo = {wealth: Math.round(h.wealth), income: Math.round(h.income ?? 0), size: h.size, homeTier: home?.tier ?? 0};
  }
  updateWealthBands(state);
  births(state);
  deaths(state);
  splits(state, () => rng(state));
  removeEmpty(state);
}

export function householdsYearlyHomes(state) {
  improveHomes(state, () => rng(state));
}

export function householdsYearlyMoves(state) {
  const rand = () => rng(state);
  stayOrMove(state, rand);
  trickleMigration(state, rand);
  removeEmpty(state);
}

function updateWealthBands(state) {
  const w = state.households.map((h) => h.wealth).sort((a, b) => a - b);
  if (w.length < 3) return;
  state.bands.wealth = [w[Math.floor(w.length / 3)], w[Math.floor((2 * w.length) / 3)]];
}

function hungerOf(h) {
  return clamp(h.hunger ?? 0, 0, 1);
}

function births(state) {
  const P = state.pressures;
  const occ = occupancy(state);
  for (const h of state.households) {
    if (h.lifeStage === 'elder' || h.size < 2) continue;
    const home = h.homeId != null ? byId(state, 'buildings', h.homeId) : null;
    const cap = homeCapacity(home);
    const crowded = cap ? clamp((occ.get(h.homeId) ?? 0) / cap, 0, 1.5) : 1.3;
    const rate = BASE_BIRTH * (1 - 0.7 * hungerOf(h)) * (1.2 - 0.4 * crowded) * (0.8 + 0.4 * P.health);
    const n = roundRandom(state, Math.max(0, h.size * rate * (h.lifeStage === 'young' ? 1.3 : 1)));
    if (n > 0) {
      h.size += n;
      countPeople(state, 'born', n);
      addStory(state, h, 'birth', {text: n > 1 ? `${n} children` : 'a child'});
    }
  }
}

function deaths(state) {
  const health = state.pressures.health;
  for (const h of state.households) {
    const elder = h.lifeStage === 'elder' ? 0.035 : 0;
    const rate = BASE_DEATH + 0.02 * (1 - health) + 0.12 * hungerOf(h) + elder + (h.homeId == null ? 0.01 : 0);
    const n = Math.min(h.size, roundRandom(state, h.size * rate));
    if (n > 0) {
      h.size -= n;
      countPeople(state, 'died', n);
      addStory(state, h, 'death', {text: n > 1 ? `${n} died` : 'one died'});
    }
  }
}

// Death or illness across the town (plague, famine). Returns people lost.
export function killShare(state, share) {
  let lost = 0;
  for (const h of state.households) {
    const n = Math.min(h.size, roundRandom(state, h.size * share));
    h.size -= n;
    lost += n;
  }
  countPeople(state, 'died', lost);
  removeEmpty(state);
  return lost;
}

// Big households send a young couple out to start their own.
function splits(state, rand) {
  const born = [];
  for (const h of state.households) {
    if (h.size < SPLIT_SIZE || h.lifeStage === 'young') continue;
    const n = Math.min(h.size - 2, 2);
    const savings = h.savings * 0.2;
    h.size -= n;
    h.savings -= savings;
    const child = makeHousehold(state, {
      size: n, savings, wealth: savings, districtId: h.districtId, centreId: h.centreId ?? null, faithBand: h.faithBand,
      trade: chooseTrade(state, h.trade, rand), loyalty: {...h.loyalty},
    });
    child.parentId = h.id;
    addStory(state, child, 'formed', {ref: h.id});
    born.push(child);
  }
  state.households.push(...born);
}

// Young people pick a trade. Prior: open jobs per trade, a pull toward the parents'
// trade. Pooled answers come from the decision layer (kind choose_trade).
export function chooseTrade(state, parentTrade, rand, subject = null) {
  const jobs = state.economy.jobs ?? {};
  const prior = {};
  for (const t of TRADES) {
    if (t === 'none') continue;
    const r = jobs[t];
    const open = r ? Math.max(0, r.jobs - r.filled) : 0;
    prior[t] = 0.05 + open / Math.max(4, (r?.workers ?? 0) + 4) + (t === parentTrade ? 0.6 : 0);
  }
  prior.gentry = 0;
  prior.leave_town = 0.02;
  if (!state.institutions.some((i) => i.kind === 'parish' && i.status === 'active') && !state.enterprises.some((e) => e.type === 'chapel')) prior.clergy = 0;
  const pick = decide(state, 'choose_trade', subject ?? {type: 'youth', parentTrade}, {prior, rng: rand});
  return pick === 'leave_town' || !pick ? parentTrade ?? 'labour' : pick;
}

export function assignTrade(state, h, trade) {
  if (!TRADES.includes(trade) || trade === h.trade) return;
  addStory(state, h, 'trade', {from: h.trade, to: trade});
  h.trade = trade;
}

// Kind household_home: owners with savings near the next tier's cost may keep, repair,
// extend or rebuild up. The best-placed few each year decide (richest against the cost
// first); sim-world's requestUpgrade does the work and the economy charges them.
function improveHomes(state, rand) {
  sellTownHomes(state);
  const upgrade = findHook('requestUpgrade');
  // Every owned home counts: landlords rebuild the homes they let, too.
  const candidates = [];
  for (const home of state.buildings) {
    if (home.type !== 'home' || home.ownerHouseholdId == null || home.built < 1) continue;
    const h = byId(state, 'households', home.ownerHouseholdId);
    if (!h) continue;
    const cost = costOf('home', (home.tier ?? 1) + 1, state.era);
    const ratio = h.savings / Math.max(1, cost);
    if (ratio >= 0.2 || (home.condition ?? 1) < 0.5) candidates.push({h, home, ratio, cost});
  }
  candidates.sort((a, b) => b.ratio - a.ratio || a.h.id - b.h.id);
  const limit = Math.min(150, Math.max(3, Math.round(state.households.length * 0.08)));
  for (const {h, home, ratio, cost} of candidates.slice(0, limit)) {
    // With a fifth saved, a household that earns enough may borrow the rest.
    const fundable = ratio >= 0.6 || (ratio >= 0.2 && canBorrow(state, h, cost));
    const prior = {keep: 1, repair: (home.condition ?? 1) < 0.6 ? 1.5 : 0.05, extend: fundable ? 0.4 : 0, rebuild_up: fundable ? 1.2 : 0};
    const mask = upgrade ? ['keep', 'repair', 'extend', 'rebuild_up'] : ['keep', 'repair'];
    let choice = decide(state, 'household_home', {type: 'household', record: h}, {prior, mask, rng: rand});
    // Whether the lot allows growth is checked only for those who want it (it is costly).
    if ((choice === 'extend' || choice === 'rebuild_up') && !canUpgrade(state, home).ok) choice = 'keep';
    if (choice === 'repair') {
      payBuilders(state, h, 0.05 * buildingValueOf(state, home), 'repairs');
      repairBuilding(state, home);
      addStory(state, h, 'home', {to: 'repair', ref: home.id});
    } else if (choice === 'extend' || choice === 'rebuild_up') {
      if (choice === 'rebuild_up') noteRebuildWish(state, home);   // neighbours may merge into a terrace
      if (h.savings < cost) takeMortgage(state, h, cost - h.savings);
      if (upgrade(state, home, {payer: `household:${h.id}`, reason: choice})?.ok !== false) addStory(state, h, 'home', {to: choice, ref: home.id});
    }
  }
}

// Homes the town paid for are sold each year, about a quarter of them at 70% of their
// cost: to a tenant who can pay, else to a well-off household as a landlord. The coin
// returns to the treasury, and owners improve their homes.
function sellTownHomes(state) {
  const forSale = state.buildings.filter((b) => b.type === 'home' && b.built >= 1 && b.ownerHouseholdId == null);
  if (!forSale.length) return;
  const tenants = new Map();
  for (const h of state.households) if (h.homeId != null && !tenants.has(h.homeId)) tenants.set(h.homeId, h);
  const buyers = [...state.households].sort((a, b) => b.savings - a.savings || a.id - b.id);
  let sold = 0;
  const limit = Math.max(2, Math.ceil(forSale.length * 0.25));
  for (const home of forSale) {
    if (sold >= limit) break;
    const price = 0.7 * costOf('home', home.tier ?? 1, state.era);
    const tenant = tenants.get(home.id);
    const buyer = tenant && tenant.savings >= price ? tenant : buyers.find((h) => h.savings >= 2 * price);
    if (!buyer || pay(state, buyer, 'treasury', price, 'homeSales') < price - 1e-6) continue;
    home.ownerHouseholdId = buyer.id;
    addStory(state, buyer, 'home', {to: buyer === tenant ? 'bought' : 'bought-to-let', ref: home.id});
    sold++;
  }
}

// Mortgages: outside lenders, 5% a year over ten years. The coin comes in from outside
// and goes back out with the repayments (economy.js, monthly).
const MORTGAGE_RATE = 0.05, MORTGAGE_MONTHS = 120;

function canBorrow(state, h, cost) {
  const yearly = (h.income ?? 0) * 12;
  return yearly > 0 && (h.debt ?? 0) + cost <= yearly * 5;
}

export function takeMortgage(state, h, amount) {
  if (!(amount > 0)) return 0;
  const r = MORTGAGE_RATE / 12;
  h.debt = (h.debt ?? 0) + amount;
  h.debtRate = MORTGAGE_RATE;
  h.debtPayment = (h.debtPayment ?? 0) + (amount * r) / (1 - Math.pow(1 + r, -MORTGAGE_MONTHS));
  h.savings += amount;
  state.economy.external.in += amount;
  flow(state, 'mortgagesIn', amount);
  addStory(state, h, 'loan', {to: 'mortgage'});
  return amount;
}

const buildingValueOf = (state, b) => (HOME_TIERS[b.tier]?.cost ?? 500) * priceLevel(state);

// Households weigh staying against moving. Prior: hunger, rent burden and unrest
// push people away; good times bring kin.
function stayOrMove(state, rand) {
  const I = state.indicators, P = state.pressures;
  const homesFree = vacancies(state).reduce((n, v) => n + v.free, 0);
  const leaving = [];
  const centres = (state.centres ?? []).filter((c) => c.mergedInto == null && c.monthly);
  for (const h of state.households) {
    const hunger = hungerOf(h);
    const rentBurden = h.income > 0 ? clamp(h.rent / h.income, 0, 2) : h.rent > 0 ? 1 : 0;
    // An eyesore next door: those with savings look for a nicer street.
    const home = h.homeId != null ? byId(state, 'buildings', h.homeId) : null;
    const shabby = home?.looks != null ? clamp((0.45 - home.looks) / 0.25, 0, 1) : 0;
    const prior = {
      stay: 1,
      move_within: (h.homeId == null || rentBurden > 0.4 ? 0.15 : 0.02) + (h.savings > 100 ? 0.06 : 0.02) * shabby,
      emigrate: 0.008 + 0.25 * hunger + 0.04 * P.unrest + (I.wellbeing < 40 ? 0.03 : 0) + 0.02 * (state.migrationBias < 0 ? -state.migrationBias : 0) + 0.006 * shabby,
      bring_kin: I.wellbeing > 60 && homesFree > 6 && I.jobBalance > -0.1 ? 0.012 : 0.003,
      move_to_centre: 0,
    };
    // Another town in the valley with better work draws those who lack it here.
    const better = centres.length > 1 ? betterCentre(centres, h) : null;
    if (better) prior.move_to_centre = 0.01 + 0.15 * better.gain;
    const facts = {emigrate: h.savings < h.rent ? 0.2 : 1, move_within: 1 + 1.5 * shabby};
    const mask = ['stay', 'emigrate'];
    if (homesFree > 0) mask.push('move_within', 'bring_kin');
    if (better) mask.push('move_to_centre');
    const choice = decide(state, 'household_stay_move', {type: 'household', record: h}, {prior, facts, mask, rng: rand});
    if (choice === 'emigrate') leaving.push(h);
    else if (choice === 'bring_kin') bringKin(state, h, 1 + Math.floor(rand() * 3));
    else if (choice === 'move_within') h.homeId = null;   // the housing market rehouses them next month
    else if (choice === 'move_to_centre') moveToCentre(state, h, better.centre);
  }
  for (const h of leaving) emigrate(state, h);
}

// The centre (other than this household's) with the best work prospects, and how much
// better they are (employment difference, 0..1), or null if none is better.
function betterCentre(centres, h) {
  const own = centres.find((c) => c.id === h.centreId);
  const ownWork = own?.monthly.employment ?? 1;
  let best = null;
  for (const c of centres) {
    if (c === own) continue;
    const gain = c.monthly.employment - ownWork + (c.monthly.wellbeing - (own?.monthly.wellbeing ?? 50)) / 200;
    if (gain > 0.05 && (!best || gain > best.gain)) best = {centre: c, gain: Math.min(1, gain)};
  }
  return best;
}

// Leave the home and look for one in another centre: the housing market prefers homes
// there (h.preferCentre), and sim-world builds near the household's new district.
export function moveToCentre(state, h, centre) {
  const from = state.centres.find((c) => c.id === h.centreId)?.name ?? null;
  const district = state.districts.find((d) => d.centreId === centre.id);
  h.homeId = null;
  h.preferCentre = centre.id;
  if (district) h.districtId = district.id;
  h.centreId = centre.id;
  addStory(state, h, 'moved', {from, to: centre.name});
}

export function bringKin(state, h, n) {
  h.size += n;
  countPeople(state, 'arrived', n);
  const savings = 20 * n * priceLevel(state);
  h.savings += savings;
  state.economy.external.in += savings;
  flow(state, 'migrantsIn', savings);
}

// ---------------------------------------------------------------------------
// Migration

// How much the town draws people (-1..1): food, homes, work, wellbeing, fame.
export function attractiveness(state) {
  const I = state.indicators, P = state.pressures;
  const food = clamp((I.foodBalance - 1) / 4, -1, 1);
  const homes = clamp(0.5 - 2 * I.housingPressure, -1, 1);
  const work = clamp(I.jobBalance * 2, -1, 1);
  const mood = clamp((I.wellbeing - 50) / 30, -1, 1);
  // Big towns pull less: dearer land, longer walks, crowding.
  const crowding = clamp((I.pop - 5000) / 10000, 0, 1);
  const score = 0.2 * food + 0.3 * homes + 0.35 * work + 0.2 * mood + 0.3 * P.prestige - 0.3 * P.unrest - 0.35 * crowding + (state.migrationBias ?? 0);
  return clamp(score, -1, 1);
}

// A steady trickle in good years (and out in bad ones). Waves are events.
function trickleMigration(state, rand) {
  const pop = population(state);
  const a = attractiveness(state);
  if (a > 0) {
    const free = vacancies(state).reduce((n, v) => n + v.free, 0);
    // Newcomers may arrive ahead of the housing: sim-world builds for the homeless.
    const room = free + Math.max(8, pop * 0.02);
    // The pull per resident fades as the town becomes a city.
    const perHead = 0.06 * (1 - Math.min(0.5, pop / 16000));
    const people = Math.min(room, roundRandom(state, a * (16 + perHead * pop)));
    if (people >= 1) immigrate(state, people, {rand});
  } else if (a < -0.2 && state.households.length > 3) {
    const n = roundRandom(state, state.households.length * 0.02 * -a);
    for (let i = 0; i < n && state.households.length > 3; i++) {
      const h = state.households[Math.floor(rand() * state.households.length)];
      emigrate(state, h);
    }
  }
}

// New households arrive from outside, bringing their savings. Returns the households.
export function immigrate(state, people, {rand = () => rng(state), districtId = null, trade = null, wealth = 1} = {}) {
  const arrived = [];
  let left = Math.round(people);
  const price = priceLevel(state);
  const view = districtId == null ? settleView(state) : null;
  while (left > 0) {
    const size = Math.min(left, 1 + Math.floor(rand() * 4));
    left -= size;
    const savings = Math.round((40 + rand() * 120) * price * wealth);
    const settleIn = districtId ?? settleDistrict(state, rand, view, migrantKind(savings / price, trade), savings);
    if (view && settleIn != null) view.free[settleIn] = Math.max(0, (view.free[settleIn] ?? 0) - size);
    const h = makeHousehold(state, {
      size, savings, wealth: savings,
      trade: trade ?? chooseTrade(state, null, rand, {type: 'migrant'}),
      districtId: settleIn,
      centreId: state.districts.find((d) => d.id === settleIn)?.centreId ?? state.centres?.[0]?.id ?? null,
      newcomerUntil: state.time.year + NEWCOMER_YEARS,
      faithBand: rand() < state.pressures.faith ? 2 : rand() < 0.5 ? 1 : 0,
    });
    state.economy.external.in += savings;
    flow(state, 'migrantsIn', savings);
    state.households.push(h);
    countPeople(state, 'arrived', size);
    addStory(state, h, 'arrived', {text: districtName(state, h.districtId) ?? ''});
    arrived.push(h);
  }
  return arrived;
}

const migrantKind = (savings, trade) => (trade === 'trade' || savings > 140 ? 'merchant' : trade === 'craft' ? 'craftsman' : 'poor_family');

// What newcomers see of each district on arrival: free room (people), average
// household rent and land value per district id, and the mean land value.
function settleView(state) {
  const free = {}, rent = {}, homes = {};
  for (const v of vacancies(state)) free[v.home.districtId] = (free[v.home.districtId] ?? 0) + v.free;
  for (const h of state.households) {
    if (h.districtId == null) continue;
    rent[h.districtId] = (rent[h.districtId] ?? 0) + (h.rent ?? 0);
    homes[h.districtId] = (homes[h.districtId] ?? 0) + 1;
  }
  for (const id in rent) rent[id] /= homes[id];
  const land = state.districtLand ?? {};
  const values = state.districts.map((d) => land[d.id]).filter((v) => v > 0);
  const meanLand = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {free, rent, land, meanLand};
}

// How dear land draws (+) or puts off (-) each kind of newcomer.
const LAND_LEAN = {poor_family: -0.8, craftsman: -0.2, merchant: 0.5};

// Where a newcomer settles: a weighted draw over the districts with free homes
// (over all of them once none has room). Room to live, work in the district's
// centre and pleasant streets draw everyone. Dear land puts off the poor and
// draws merchants, and a district whose rent would eat their savings within
// six months is a long shot. Settling takes up the room, so a wave spreads out
// instead of piling into one district.
function settleDistrict(state, rand, view, migrant, savings) {
  const districts = state.districts;
  if (!districts.length) return null;
  const lean = LAND_LEAN[migrant] ?? 0;
  const anyRoom = districts.some((d) => view.free[d.id] > 0);
  let total = 0;
  const weights = districts.map((d) => {
    const room = anyRoom ? view.free[d.id] ?? 0 : 1;
    const land = view.meanLand > 0 ? clamp((view.land[d.id] ?? view.meanLand) / view.meanLand, 0.25, 4) : 1;
    const dear = (view.rent[d.id] ?? 0) * 6 > savings ? 0.3 : 1;
    const w = room * centreWorkPull(state, d.centreId) * (0.6 + 0.8 * districtLooks(state, d.id)) * land ** lean * dear;
    total += w;
    return w;
  });
  let pick = districts.at(-1);
  let x = rand() * total;
  for (let i = 0; i < districts.length; i++) {
    if ((x -= weights[i]) < 0) { pick = districts[i]; break; }
  }
  return pick.id;
}

// 0.5..2: open jobs against idle hands in a centre (from last month's figures).
function centreWorkPull(state, centreId) {
  const m = state.centres?.find((c) => c.id === centreId)?.monthly;
  if (!m || !m.workers) return 1;
  return clamp(1 + (m.jobs - m.workers) / m.workers, 0.5, 2);
}

// A household leaves town with its savings. Its home stays (owned homes go to the town).
export function emigrate(state, h) {
  const at = state.households.indexOf(h);
  if (at < 0) return false;
  if (h.savings > 0) {
    state.economy.external.out += h.savings;
    flow(state, 'migrantsOut', h.savings);
    h.savings = 0;
  }
  releaseHomes(state, h, null);
  state.households.splice(at, 1);
  countPeople(state, 'left', h.size);
  return true;
}

// Households with nobody left: savings and property pass to kin in the same district,
// or to the town.
function removeEmpty(state) {
  if (!state.households.some((h) => h.size <= 0)) return;
  const alive = state.households.filter((h) => h.size > 0);
  for (const h of state.households) {
    if (h.size > 0) continue;
    const heir = alive.find((k) => k.id === h.parentId) ??
      alive.find((k) => k.districtId === h.districtId && k.trade === h.trade) ?? alive[0] ?? null;
    if (h.savings > 0) pay(state, h, heir ?? 'treasury', h.savings, 'inheritance');
    releaseHomes(state, h, heir);
    for (const e of state.enterprises) if (e.ownerHouseholdId === h.id) e.ownerHouseholdId = heir?.id ?? null;
  }
  state.households = alive;
}

function releaseHomes(state, h, heir) {
  for (const b of state.buildings) if (b.ownerHouseholdId === h.id) b.ownerHouseholdId = heir?.id ?? null;
  for (const e of state.enterprises) if (e.ownerHouseholdId === h.id && !heir) e.ownerHouseholdId = null;
}

// Summary used by the chronicle at year end.
export function yearSummary(state, popBefore) {
  const pop = population(state);
  const change = pop - popBefore;
  if (Math.abs(change) >= Math.max(5, popBefore * 0.08)) {
    emitChronicle(state, {
      kind: 'line',
      text: change > 0 ? `The town grew this year. ${pop} people live here now.` : `The town shrank this year. ${pop} people are left.`,
      refs: {pop, change},
    });
  }
  return change;
}

export {workersOf};
