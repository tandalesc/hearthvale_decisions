// Enterprises: farms, workshops, mills, shops, inns, quays and the public services.
// Every working building has one enterprise record. Jobs, output and wages are
// settled in economy.js; this module handles the lifecycle.
//
// Monthly: enterprises appear for finished buildings, vanish with their building,
// follow tier changes, and drive the building's visible hooks (open, smoke, lit).
// Yearly: each enterprise plans (hold, expand, automate, diversify, close); a few
// wealthy households found new ones (sim-world places the building); enterprises
// short of cash may borrow.

import {rng} from './rng.js';
import {decide, findHook} from './hooks.js';
import {ENTERPRISE_TYPES, jobsFor, makeEnterprise, byId, touchBuilding, emitChronicle} from './state.js';
import {pay, payBuilders, flow, wageRate, wealthBand, FOOD_PER_FARMER, productivity} from './economy.js';
import {refreshLand, landContext, siteValue} from './land.js';
import {addStory} from './households.js';
import {delta, priceLevel, clamp} from './pressures.js';

const SMOKY = new Set(['mill', 'factory', 'workshop']);
// Closures worth a chronicle line (small shops come and go quietly).
const NOTABLE = new Map([['mill', 'mill'], ['factory', 'factory'], ['market', 'market'], ['exchange', 'exchange'], ['theatre', 'theatre'], ['quay', 'quay company'], ['inn', 'inn']]);
const LOAN_RATE = 0.08;

export function enterprisesMonthly(state) {
  attachToBuildings(state);
  for (const ent of state.enterprises) {
    const b = byId(state, 'buildings', ent.buildingId);
    if (!b) continue;
    const want = jobsFor(ent.type, b.tier ?? 1);
    if (!ent.automated && want !== ent.jobs && !ent.expanded) ent.jobs = want;
    ent.centreId = b.centreId ?? ent.centreId ?? null;
    syncBuildingHooks(state, ent, b);
  }
}

// Create enterprises for finished working buildings; drop those whose building is gone.
function attachToBuildings(state) {
  const have = new Set();
  const moving = new Set();
  for (const e of state.enterprises) {
    have.add(e.buildingId);
    if (e.relocatingFrom != null && e.buildingId !== e.relocatingFrom) movedIn(state, e);
    else if (e.relocatingFrom != null) moving.add(e.id);
  }
  // New premises for a moving business belong to it (sim-world hands them over).
  const awaited = new Set();
  for (const p of state.projects) if (p.data?.enterpriseId != null && moving.has(p.data.enterpriseId)) awaited.add(p.buildingId);
  for (const b of state.buildings) {
    if (b.built < 1 || have.has(b.id) || awaited.has(b.id) || !ENTERPRISE_TYPES[b.type] || b.flags?.derelict) continue;
    state.enterprises.push(makeEnterprise(state, b, {ownerHouseholdId: ENTERPRISE_TYPES[b.type].public ? null : b.ownerHouseholdId ?? null}));
  }
  if (state.enterprises.some((e) => !byId(state, 'buildings', e.buildingId))) {
    for (const e of state.enterprises) if (!byId(state, 'buildings', e.buildingId)) closeEnterprise(state, e, 'gone');
  }
}

function syncBuildingHooks(state, ent, b) {
  const share = ent.jobs > 0 ? clamp(ent.filled / ent.jobs, 0, 1) : ent.public ? 1 : 0;
  const open = share > 0.05 || ent.public;
  const smoke = SMOKY.has(ent.type) ? Math.round(share * (ent.type === 'workshop' ? 4 : 10)) / 10 : 0;
  if (b.open !== open || b.occupied !== open || Math.abs((b.smoke ?? 0) - smoke) >= 0.1) {
    b.open = open;
    b.occupied = open;
    b.smoke = smoke;
    if (smoke > 0) b.chimney = true;
    touchBuilding(state, b);
  }
}

// ---------------------------------------------------------------------------
// Yearly

export function enterprisesYearly(state) {
  const rand = () => rng(state);
  refreshLand(state);
  for (const ent of [...state.enterprises]) {
    if (ent.public) continue;
    if (ent.ownerHouseholdId == null || !byId(state, 'households', ent.ownerHouseholdId)) adoptOwner(state, ent);
    repayDebt(state, ent);
    plan(state, ent, rand);
  }
}

// Yearly, as its own step: list who may found what this year (state.founding). The
// attempts then run one per tick (foundingStep), since each costs a site search.
export function enterprisesFound(state) {
  planFounding(state);
}

export function monthlyCost(state, ent) {
  return ent.jobs * wageRate(state) + (ent.upkeep ?? 2) * priceLevel(state);
}

// Prior: profit and cash decide. Pooled answers come from kind enterprise_plan.
function plan(state, ent, rand) {
  const cost = monthlyCost(state, ent);
  const profit = ent.profitLastYear ?? 0;
  const rich = ent.cash > 8 * cost, poor = ent.cash < cost;
  if (profit < 0 && poor) ent.lossYears++;
  else if (profit >= 0) ent.lossYears = 0;
  const labourShort = (state.economy.jobs[ent.trade]?.workers ?? 0) < (state.economy.jobs[ent.trade]?.jobs ?? 0);
  landContext(state, ent);
  // Squeezed: the land's rent is a real share of takings, and the business makes less
  // than its land would fetch (owner-occupiers count the rent they forgo).
  const squeezed = ent.rentShare > 0.12 && profit < Math.max(0, ent.rentLastYear ?? 0);
  const prior = {
    hold: 1,
    // Idle hands nearby make growing cheap: expand on a modest cushion then.
    expand: profit > 0 && rich && !labourShort ? 0.35
      : profit >= 0 && ent.cash > 4 * cost && idleShare(state, ent.trade) > 0.15 ? 0.3
      : ent.type === 'farm' && ent.cash > 2 * cost && foodShortfall(state) > 0 ? 0.5 : 0.02,
    automate: state.era >= 3 && profit > 0 && labourShort ? 0.25 : 0,
    diversify: profit < 0 ? 0.05 : 0.01,
    close: ent.lossYears >= 2 ? 0.4 + 0.2 * ent.lossYears : 0.002,
    // Bid-rent: dear land pushes thin-margin work out, or tempts the owner to sell.
    relocate: ent.cheaper && ent.rentShare > 0.12 ? (squeezed ? 0.3 : 0.1) + ent.rentShare : 0,
    sell_site: ent.siteRatio > 2 ? (profit < (ent.rentLastYear ?? 0) ? 0.15 : 0.05) + 0.05 * Math.min(4, ent.siteRatio) : 0,
    downsize: profit < 0 && ent.jobs > 3 ? 0.15 + ent.rentShare : 0,
  };
  // The town's last farm or workshop hangs on; the household keeps it going.
  if (isLastOfType(state, ent)) prior.close *= 0.05;
  const mask = ['hold', 'expand', 'close', 'downsize'];
  if (state.era >= 3 && !ent.automated && ent.sector === 'goods') mask.push('automate');
  if (ent.cheaper && ent.relocatingFrom == null && ent.cash >= 2 * cost) mask.push('relocate');
  if (ent.ownerHouseholdId != null) mask.push('sell_site');
  const choice = decide(state, 'enterprise_plan', {type: 'enterprise', record: ent}, {prior, facts: landFacts(ent), mask, rng: rand});
  if (choice === 'expand') expand(state, ent);
  else if (choice === 'automate') automate(state, ent);
  else if (choice === 'close') closeEnterprise(state, ent, 'losses');
  else if (choice === 'relocate') relocate(state, ent, cost);
  else if (choice === 'sell_site') sellSite(state, ent);
  else if (choice === 'downsize') downsize(state, ent);
  else if (poor) maybeBorrow(state, ent, rand);
}

// Local facts (sim-governance's weights): heavy rent pushes land-hungry work to move,
// a rich offer for the site tempts its owner to sell, and either makes holding on less likely.
const LAND_HUNGRY = new Set(['farm', 'mill', 'warehouse', 'workshop', 'factory']);

function landFacts(ent) {
  const hungry = LAND_HUNGRY.has(ent.type) ? 2 : 1;
  const crushing = ent.rentShare >= 0.3, heavy = ent.rentShare >= 0.15;
  const huge = ent.siteRatio >= 4, rich = ent.siteRatio >= 2;
  return {
    relocate: (crushing ? 8 : heavy ? 4 : 1) * hungry,
    sell_site: (huge ? 10 : rich ? 6 : 1) * hungry,
    hold: heavy || rich ? 0.6 : 1,
  };
}

// relocate: sim-world's relocateEnterprise builds new premises on cheaper ground (the
// edge or another centre), moves the business in when they stand and clears the old
// building. The enterprise pays for the build and two months of costs for the move.
function relocate(state, ent, monthly) {
  const hook = findHook('relocateEnterprise');
  if (!hook || ent.relocatingFrom != null) return;
  const result = hook(state, ent, {payer: `enterprise:${ent.id}`, reason: 'relocated'});
  if (!result?.ok) return;
  ent.relocatingFrom = ent.buildingId;
  ent.costs += payBuilders(state, ent, 2 * monthly, 'moving');
}

// The move is done (sim-world switched the building): a chronicle line and the owner's story.
function movedIn(state, ent) {
  const old = byId(state, 'buildings', ent.relocatingFrom);
  const b = byId(state, 'buildings', ent.buildingId);
  ent.relocatingFrom = null;
  ent.centreId = b?.centreId ?? ent.centreId ?? null;
  const from = state.districts.find((d) => d.id === old?.districtId)?.name;
  const to = state.districts.find((d) => d.id === b?.districtId)?.name;
  const owner = ent.ownerHouseholdId != null ? byId(state, 'households', ent.ownerHouseholdId) : null;
  if (owner) addStory(state, owner, 'moved-business', {to: to ?? '', ref: ent.id});
  if (from && to && from !== to) {
    emitChronicle(state, {kind: 'line', text: `The ${label(ent)} moved out to ${to}. Rents in ${from} had grown too high.`, refs: {enterpriseId: ent.id, buildingId: b?.id, centreId: b?.centreId}});
  }
}

// Tell sim-governance a business was pushed out (factions, stories, cards): the owner
// and up to five households of the same trade in the old district. (Relocations report
// it from sim-world when the move completes.)
function displaced(state, ent, building, reason) {
  const hook = findHook('displaced');
  if (!hook) return;
  const households = [];
  if (ent.ownerHouseholdId != null) households.push(ent.ownerHouseholdId);
  for (const h of state.households) {
    if (households.length >= 6) break;
    if (h.trade === ent.trade && h.districtId === building?.districtId && !households.includes(h.id)) households.push(h.id);
  }
  hook(state, {kind: ent.type, reason, households, buildingId: building?.id ?? null, enterpriseId: ent.id, trade: ent.trade});
}

// sell_site: a well-off household buys the site (it pays the owner what a developer
// would) and the business shuts; the lot is left for redevelopment.
function sellSite(state, ent) {
  const b = byId(state, 'buildings', ent.buildingId);
  const owner = ent.ownerHouseholdId != null ? byId(state, 'households', ent.ownerHouseholdId) : null;
  if (!b || !owner) return;
  const price = siteValue(state, ent);
  let buyer = null;
  for (const h of state.households) if (h !== owner && h.savings >= price && (!buyer || h.savings > buyer.savings)) buyer = h;
  if (!buyer || pay(state, buyer, owner, price, 'landSales') < price - 1e-6) return;
  b.ownerHouseholdId = buyer.id;
  addStory(state, owner, 'sold-site', {to: ent.type, ref: b.id});
  displaced(state, ent, b, 'sale');
  addStory(state, buyer, 'bought-site', {to: ent.type, ref: b.id});
  const district = state.districts.find((d) => d.id === b.districtId)?.name ?? 'town';
  if (NOTABLE.has(ent.type) || ent.type === 'farm' || ent.type === 'workshop') {
    emitChronicle(state, {kind: 'line', text: `The ${label(ent)} in ${district} sold its land. The site is worth more than the trade.`, refs: {buildingId: b.id}});
  }
  closeEnterprise(state, ent, 'sold');
  // The buyer redevelops: sim-world clears the building and offers the lot.
  findHook('buildingReleased')?.(state, b);
}

// downsize: fewer hands, the same building.
function downsize(state, ent) {
  ent.jobs = Math.max(1, Math.round(ent.jobs * 0.7));
  ent.expanded = true;   // keeps the custom job count (enterprisesMonthly)
}

const label = (ent) => (ent.type === 'workshop' ? 'workshop' : ent.type === 'farm' ? 'farm' : NOTABLE.get(ent.type) ?? ent.type);


// An enterprise whose owners are gone passes to a household of its trade that owns
// nothing yet (the best-off of them). If there is none it stays a cooperative: its
// profits are shared among the households of its trade (economy.payDividends).
function adoptOwner(state, ent) {
  const owners = new Set();
  for (const e of state.enterprises) if (e.ownerHouseholdId != null) owners.add(e.ownerHouseholdId);
  let best = null;
  for (const h of state.households) {
    if (h.trade !== ent.trade || owners.has(h.id)) continue;
    if (!best || h.savings > best.savings) best = h;
  }
  ent.ownerHouseholdId = best?.id ?? null;
}

// Share of a trade's workers without work (any trade can fill labour jobs).
function idleShare(state, trade) {
  const row = state.economy.jobs?.[trade];
  return row && row.workers > 0 ? Math.max(0, 1 - row.filled / row.workers) : 0;
}

function isLastOfType(state, ent) {
  for (const e of state.enterprises) if (e !== ent && e.type === ent.type) return false;
  return true;
}

function expand(state, ent) {
  const b = byId(state, 'buildings', ent.buildingId);
  ent.jobs = Math.round(ent.jobs * 1.25 + 1);
  ent.expanded = true;
  // sim-world may grow the building (an annex or a storey) and charge the enterprise.
  findHook('requestUpgrade')?.(state, b, {reason: 'expand', payer: `enterprise:${ent.id}`});
}

function automate(state, ent) {
  ent.automated = true;
  ent.jobs = Math.max(1, Math.round(ent.jobs * 0.7));
  delta(state, 'industry', 0.0012, `automate:${ent.id}`);
  delta(state, 'innovation', 0.0012, `automate:${ent.id}`);
}

export function closeEnterprise(state, ent, reason = 'closed') {
  const at = state.enterprises.indexOf(ent);
  if (at < 0) return;
  const owner = ent.ownerHouseholdId != null ? byId(state, 'households', ent.ownerHouseholdId) : null;
  if (owner && reason !== 'gone') addStory(state, owner, 'closed', {to: ent.type, ref: ent.id});
  if (ent.cash > 0) pay(state, ent, ent.ownerHouseholdId != null ? `household:${ent.ownerHouseholdId}` : 'treasury', ent.cash, 'closures');
  if (ent.cash > 0) pay(state, ent, 'treasury', ent.cash, 'closures');
  if (ent.debt > 0) ent.debt = 0;   // the lender writes it off
  state.enterprises.splice(at, 1);
  const b = byId(state, 'buildings', ent.buildingId);
  if (b && reason !== 'gone') {
    b.flags.derelict = 1;
    b.open = false;
    b.occupied = false;
    b.smoke = 0;
    touchBuilding(state, b);
    if (NOTABLE.has(b.type) && reason !== 'sold') {
      emitChronicle(state, {kind: 'line', text: `The ${NOTABLE.get(b.type)} closed its doors. The work had dried up.`, refs: {buildingId: b.id}});
    }
  }
}

// Kind take_loan: borrow from outside lenders, repay a tenth a year with interest.
function maybeBorrow(state, ent, rand) {
  const cost = monthlyCost(state, ent);
  const prior = {hold: 1, borrow_small: 0.5, borrow_large: 0.1, sell_up: ent.lossYears > 1 ? 0.3 : 0.02};
  // Lenders balk at a business already owing a year of costs, whatever the owner wants.
  const facts = (ent.debt ?? 0) > 12 * cost ? {borrow_small: 0.6, borrow_large: 0.2} : null;
  const choice = decide(state, 'take_loan', {type: 'enterprise', record: ent}, {prior, facts, rng: rand});
  if (choice === 'borrow_small' || choice === 'borrow_large') {
    const amount = cost * (choice === 'borrow_small' ? 4 : 10);
    ent.cash += amount;
    ent.debt = (ent.debt ?? 0) + amount;
    const owner = ent.ownerHouseholdId != null ? byId(state, 'households', ent.ownerHouseholdId) : null;
    if (owner) addStory(state, owner, 'loan', {ref: ent.id, to: choice === 'borrow_small' ? 'small' : 'large'});
    state.economy.external.in += amount;
    flow(state, 'loanIn', amount);
  } else if (choice === 'sell_up') {
    closeEnterprise(state, ent, 'sold');
  }
}

function repayDebt(state, ent) {
  if (!(ent.debt > 0)) return;
  const due = ent.debt * (0.1 + LOAN_RATE);
  const paid = pay(state, ent, 'external', due, 'loanService');
  ent.debt = Math.max(0, ent.debt * (1 + LOAN_RATE) - paid);
}

// New enterprises, two ways. Wealthy households found one when goods run short; and
// where many workers of one trade sit idle, the best-off of them starts a cooperative in
// that trade (paying what it can; the rest is the members' labour). sim-world's
// requestBuilding hook, (state, type, opts) -> {ok}, picks the site and starts the
// project; the enterprise appears once the building is finished.
const COOP_TYPE = {farm: 'farm', craft: 'workshop', trade: 'shop', labour: 'mill', none: 'farm'};

// The year's founding attempts, in order: food-shortage farms, cooperatives of idle
// hands, then wealthy founders. Saved in state.founding so a save resumes exactly:
//   {year, items: [{kind: 'farm'|'coop'|'wealth', hh, type?, idle?}], next, failed: [types],
//    owners: [household ids that founded this year], wealthFounded}
export function planFounding(state) {
  const owners = new Set(state.enterprises.map((e) => e.ownerHouseholdId));
  const items = [];
  const shortfall = foodShortfall(state);
  if (shortfall > 0) {
    // One farm for each farm's worth of shortfall (up to three a year), each by the
    // best-off household not yet running a business. Imports cover the gap meanwhile.
    const perFarm = 6 * FOOD_PER_FARMER * productivity(state) * 12;
    const wanted = Math.min(3, Math.ceil(shortfall / perFarm));
    for (const h of bestOff(state.households.filter((x) => !owners.has(x.id) && x.homeId != null), wanted)) items.push({kind: 'farm', hh: h.id});
  }
  const idle = {};
  for (const h of state.households) idle[h.trade] = (idle[h.trade] ?? 0) + Math.max(0, (h.workers ?? 0) - (h.employed ?? 0));
  const trades = Object.keys(idle).filter((t) => idle[t] >= 3 && COOP_TYPE[t]).sort((a, b) => idle[b] - idle[a] || (a < b ? -1 : 1));
  for (const trade of trades) {
    let type = COOP_TYPE[trade];
    if (type === 'mill' && state.era < 1) type = 'farm';
    // Roughly one new cooperative per 20 idle hands, up to ten a year in a big town.
    const wanted = Math.min(10, Math.ceil(idle[trade] / 20));
    for (const h of bestOff(state.households.filter((x) => x.trade === trade && !owners.has(x.id)), wanted)) items.push({kind: 'coop', hh: h.id, type, idle: idle[trade]});
  }
  // Wealthy founders (two at most succeed; a dozen are asked in turn).
  const cost = 1000 * priceLevel(state);
  for (const h of state.households) {
    if (items.filter((i) => i.kind === 'wealth').length >= 12) break;
    if (!owners.has(h.id) && wealthBand(state, h) >= 2 && h.savings >= cost) items.push({kind: 'wealth', hh: h.id});
  }
  state.founding = {year: state.time.year, items, next: 0, failed: [], owners: [], wealthFounded: 0};
}

const bestOff = (list, n) => list.sort((a, b) => b.savings - a.savings || a.id - b.id).slice(0, n);

// One founding attempt (index.js calls this on ticks without a rollover job).
export function foundingStep(state) {
  const f = state.founding;
  if (!f || f.next >= f.items.length) return false;
  const request = findHook('requestBuilding');
  const item = f.items[f.next++];
  if (f.next >= f.items.length) state.founding = null;
  if (!request) return true;
  const h = byId(state, 'households', item.hh);
  if (!h || f.owners.includes(h.id) || state.enterprises.some((e) => e.ownerHouseholdId === h.id)) return true;
  const rand = () => rng(state);
  if (item.kind === 'farm') {
    const choice = decide(state, 'enterprise_found', {type: 'household', record: h}, {prior: {none: 0.3, farm: 2}, rng: rand});
    if (choice === 'farm') startFounding(state, f, request, h, 'farm', true);
  } else if (item.kind === 'coop') {
    const prior = {none: 0.5, [item.type]: 1 + item.idle / 6};
    const choice = decide(state, 'enterprise_found', {type: 'household', record: h}, {prior, rng: rand});
    if (choice === item.type) startFounding(state, f, request, h, item.type, true);
  } else if (f.wealthFounded < 2 && wealthBand(state, h) >= 2 && h.savings >= 1000 * priceLevel(state)) {
    const shortages = shortGoods(state);
    const prior = {none: 3, farm: shortages.food ? 1 : 0.1, workshop: shortages.goods ? 1 : 0.2, shop: 0.3, inn: 0.2, mill: state.era >= 1 ? 0.15 : 0, warehouse: state.pressures.riverTrade > 0.2 ? 0.3 : 0};
    const choice = decide(state, 'enterprise_found', {type: 'household', record: h}, {prior, rng: rand});
    if (choice && choice !== 'none' && ENTERPRISE_TYPES[choice] && startFounding(state, f, request, h, choice, false)) f.wealthFounded++;
  }
  return true;
}

// Start one founding. A type whose site search found nothing this year is not tried
// again until next year; private founders wait if that type is already being built.
function startFounding(state, f, request, h, type, cooperative) {
  if (f.failed.includes(type)) return false;
  if (!cooperative && buildingTypesUnderway(state).has(type)) return false;
  const result = request(state, type, {payer: `household:${h.id}`, ownerHouseholdId: h.id, reason: 'found'});
  if (!result?.ok) {
    if (result?.reason === 'no-site') f.failed.push(type);
    return false;
  }
  addStory(state, h, 'founded', {to: type, ref: result.building?.id});
  f.owners.push(h.id);
  return true;
}

// Food a year the town needs beyond what it grew last year (with a tenth to spare).
export function foodShortfall(state) {
  const last = state.economy.lastYear;
  const need = state.indicators.pop * 12 * 1.1;
  return need - (last.foodMade ?? 0);
}

// Building types with a project already under way (one new start per type a year).
function buildingTypesUnderway(state) {
  const types = new Set();
  for (const p of state.projects) {
    const b = p.buildingId != null ? byId(state, 'buildings', p.buildingId) : null;
    if (b && b.built < 1) types.add(b.type);
  }
  return types;
}

export function shortGoods(state) {
  const s = state.economy.shortage ?? {};
  const pop = Math.max(1, state.indicators.pop);
  return {food: state.indicators.foodBalance < 3 || (s.food ?? 0) > pop * 0.05, goods: (s.goods ?? 0) > pop * 0.03};
}
