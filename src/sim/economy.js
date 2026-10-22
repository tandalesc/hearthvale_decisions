// Money-conserving economy.
//
// Coin lives in four kinds of account: the treasury, household savings, enterprise
// cash and institution funds. Coin only appears or disappears through the outside
// world (exports, imports, migrants, loans), and every such flow is counted in
// state.economy.external. So at any time:
//
//   totalMoney(state) - (external.in - external.out) === the starting total
//
// Monthly order: jobs -> public funding -> production -> wages -> household spending
// (food, goods, services, rent, taxes, tithe) -> enterprise upkeep -> exports and trade
// -> loans. Yearly: dividends, institution budgets, year totals.

import {HOME_TIERS, byId} from './state.js';
import {monthlyRent} from './land.js';
import {priceLevel, clamp} from './pressures.js';

export const FOOD_PER_FARMER = 4.2;     // food units per farm worker per month
export const GOODS_PER_WORKER = 2.6;    // goods per goods-sector worker per month
export const BASE_PRICES = {food: 3, goods: 5};
export const BASE_WAGE = 10;            // coin per worker per month at price level 1
const IMPORT_MARKUP = 1.45;        // minus up to 0.35 with river trade
const EXPORT_DISCOUNT = 0.85;
const FOOD_SPOIL = 0.01;
const GOODS_WEAR = 0.01;
const FOOD_STORE_MONTHS = 6;       // food kept in store; the rest is sold downriver
const GOODS_STORE_MONTHS = 3;
const WORK_SHARE = {young: 0.75, family: 0.5, elder: 0.3};

// Multipliers that policies and events may set each month (sim-governance writes
// state.modifiers; missing keys mean 1).
export const MODIFIER_KEYS = ['farmYield', 'goodsOutput', 'millOutput', 'output', 'wage', 'foodNeed', 'tradeVolume', 'exportPrice', 'serviceSpend'];
const mod = (state, key) => state.modifiers?.[key] ?? 1;

const TAX_TABLES = {
  'property-tax': [0, 6, 10, 15],
  'income-tax': [0, 5, 10, 15],
  tithe: [0, 2, 4, 7],
};

// How much of its tax base a town can actually collect: a hamlet with a moot and a
// few tracks takes little; a city with clerks and offices takes it all. Scales taxes,
// site tax and the rent of town-owned homes.
const FISCAL_REACH = [0.4, 0.6, 0.8, 0.9, 1, 1];
export const fiscalReach = (state) => FISCAL_REACH[Math.max(0, Math.min(5, state.era))];

export function taxRate(state, policyId) {
  const p = state.policies[policyId];
  if (!p || p.level <= 0) return 0;
  return Number.isFinite(p.rate) ? p.rate : TAX_TABLES[policyId]?.[p.level] ?? 0;
}

// ---------------------------------------------------------------------------
// Accounts and transfers

export function totalMoney(state) {
  let total = state.treasury;
  for (const h of state.households) total += h.savings;
  for (const e of state.enterprises) total += e.cash;
  for (const i of state.institutions) total += i.funds ?? 0;
  return total;
}

export const externalNet = (state) => state.economy.external.in - state.economy.external.out;

// Resolve an account reference: 'treasury' | 'external' | 'household:<id>' |
// 'enterprise:<id>' | 'body:<id>' (institution id) | a household/enterprise/institution record.
function account(state, ref) {
  if (ref === 'treasury' || ref === 'external') return {kind: ref};
  if (typeof ref === 'object' && ref) {
    if ('savings' in ref) return {kind: 'household', rec: ref};
    if ('cash' in ref) return {kind: 'enterprise', rec: ref};
    if ('budgetShare' in ref) return {kind: 'body', rec: ref};
  }
  if (typeof ref === 'string') {
    // Split at the first colon only: ward ids carry one of their own ('body:ward:4').
    const at = ref.indexOf(':');
    const kind = at < 0 ? ref : ref.slice(0, at), raw = at < 0 ? '' : ref.slice(at + 1);
    if (kind === 'household') return {kind, rec: byId(state, 'households', Number(raw))};
    if (kind === 'enterprise') return {kind, rec: byId(state, 'enterprises', Number(raw))};
    if (kind === 'body') return {kind, rec: state.institutions.find((i) => i.id === raw)};
  }
  return null;
}

function balanceOf(state, acc) {
  if (acc.kind === 'treasury' || acc.kind === 'external') return Infinity;   // the treasury may go into debt
  if (!acc.rec) return 0;
  return acc.kind === 'household' ? acc.rec.savings : acc.kind === 'enterprise' ? acc.rec.cash : acc.rec.funds ?? 0;
}

function credit(state, acc, amount) {
  if (acc.kind === 'treasury') state.treasury += amount;
  else if (acc.kind === 'external') {
    if (amount > 0) state.economy.external.out += amount;
    else state.economy.external.in -= amount;
  } else if (acc.kind === 'household') acc.rec.savings += amount;
  else if (acc.kind === 'enterprise') acc.rec.cash += amount;
  else acc.rec.funds = (acc.rec.funds ?? 0) + amount;
}

// Move coin between two accounts. Households, enterprises and bodies cannot go below
// zero, so the amount actually paid may be less. Returns the amount paid.
export function pay(state, from, to, amount, reason = 'other') {
  if (!(amount > 0)) return 0;
  const a = account(state, from), b = account(state, to);
  if (!a || !b || (a.kind !== 'treasury' && a.kind !== 'external' && !a.rec) || (b.kind !== 'treasury' && b.kind !== 'external' && !b.rec)) return 0;
  const paid = Math.min(amount, Math.max(0, balanceOf(state, a)));
  if (!(paid > 0)) return 0;
  credit(state, a, -paid);
  credit(state, b, paid);
  flow(state, reason, paid);
  if (a.kind === 'treasury') {
    flow(state, 'treasurySpend', paid);
    flow(state, `spend:${reason}`, paid);   // what the treasury paid for, by reason
  }
  if (b.kind === 'treasury') flow(state, 'treasuryIncome', paid);
  return paid;
}

// Pay for building work: the coin goes to the town's builders (craft enterprises by
// jobs, else craft and labour households, else outside builders).
export function payBuilders(state, from, amount, reason = 'projects') {
  const {enterprises, households} = buildersOf(state);
  if (enterprises.length) return splitPay(state, from, enterprises, (e) => e.jobs, amount, reason);
  if (households.length) return splitPay(state, from, households, (h) => h.size, amount, reason);
  return pay(state, from, 'external', amount, reason);
}

// Cached per tick and per collection size, so monthly upkeep stays linear.
const buildersCache = new WeakMap();
function buildersOf(state) {
  const key = `${state.time.tick}:${state.enterprises.length}:${state.households.length}`;
  let entry = buildersCache.get(state);
  if (entry?.key !== key) {
    entry = {
      key,
      enterprises: state.enterprises.filter((e) => e.sector === 'goods' && e.trade === 'craft' && e.jobs > 0),
      households: state.households.filter((h) => h.trade === 'craft' || h.trade === 'labour'),
    };
    buildersCache.set(state, entry);
  }
  return entry;
}

// One payer, many recipients by weight. Enterprises count it as revenue.
function splitPay(state, from, recipients, weightOf, amount, reason) {
  const fromAcc = account(state, from);
  if (!fromAcc) return 0;
  const available = Math.min(amount, Math.max(0, balanceOf(state, fromAcc)));
  let totalWeight = 0;
  for (const r of recipients) totalWeight += weightOf(r);
  if (!(available > 0) || totalWeight <= 0) return 0;
  credit(state, fromAcc, -available);
  shareOut(recipients, weightOf, totalWeight, available);
  flow(state, reason, available);
  if (fromAcc.kind === 'treasury') {
    flow(state, 'treasurySpend', available);
    flow(state, `spend:${reason}`, available);
  }
  return available;
}

function shareOut(recipients, weightOf, totalWeight, amount) {
  for (const r of recipients) {
    const part = (amount * weightOf(r)) / totalWeight;
    if ('cash' in r) {
      r.cash += part;
      r.revenue += part;
    } else r.savings += part;
  }
}

// Coin already taken from its payers goes to the builders (or outside builders).
function creditBuilders(state, amount, reason) {
  if (!(amount > 0)) return;
  const {enterprises, households} = buildersOf(state);
  const list = enterprises.length ? enterprises : households;
  const weightOf = enterprises.length ? (e) => e.jobs : (h) => h.size;
  let total = 0;
  for (const r of list) total += weightOf(r);
  if (total > 0) shareOut(list, weightOf, total, amount);
  else state.economy.external.out += amount;
  flow(state, reason, amount);
}

export function flow(state, key, amount) {
  const e = state.economy;
  e.month[key] = (e.month[key] ?? 0) + amount;
  e.year[key] = (e.year[key] ?? 0) + amount;
}

// sim-world's projects carry {cost, payer, paid}. Unpaid ones are charged once, as
// soon as they appear: the payer's coin goes to the builders. A payer who cannot
// cover it all pays what it has (p.paidAmount records how much). Building over paths
// adds p.surcharge = {organic, planned, districtId} to the cost: the planned part
// (paved or planned streets) goes to the treasury, the organic part (worn trails and
// roads) to the households of that district, the path's users. A short payer scales all
// three parts alike.
export function chargeProjects(state) {
  for (const p of state.projects) {
    if (p.paid || !(p.cost > 0)) continue;
    p.paid = true;
    const sur = p.surcharge;
    const sale = p.landSale;
    if (!sur && !sale) {
      p.paidAmount = payBuilders(state, p.payer ?? 'treasury', p.cost, 'projects');
      continue;
    }
    if (!sur) {
      // The land is bought from its owner; the rest goes to the builders.
      const payer = account(state, p.payer ?? 'treasury');
      if (!payer) continue;
      const scale = Math.min(1, Math.max(0, balanceOf(state, payer)) / p.cost);
      p.paidAmount = pay(state, p.payer ?? 'treasury', sale.to, sale.amount * scale, 'landSales') +
        payBuilders(state, p.payer ?? 'treasury', Math.max(0, p.cost - sale.amount) * scale, 'projects');
      continue;
    }
    const payer = account(state, p.payer ?? 'treasury');
    if (!payer) continue;
    const scale = Math.min(1, Math.max(0, balanceOf(state, payer)) / p.cost);
    const planned = (sur.planned ?? 0) * scale, organic = (sur.organic ?? 0) * scale;
    const landPart = sale?.amount ?? 0;
    const base = Math.max(0, p.cost - (sur.planned ?? 0) - (sur.organic ?? 0) - landPart) * scale;
    let paid = payBuilders(state, p.payer ?? 'treasury', base, 'projects');
    if (sale) paid += pay(state, p.payer ?? 'treasury', sale.to, landPart * scale, 'landSales');
    paid += pay(state, p.payer ?? 'treasury', 'treasury', planned, 'pathCharges');
    const users = state.households.filter((h) => h.districtId === sur.districtId);
    paid += users.length
      ? splitPay(state, p.payer ?? 'treasury', users, () => 1, organic, 'pathCharges')
      : pay(state, p.payer ?? 'treasury', 'treasury', organic, 'pathCharges');
    p.paidAmount = paid;
  }
}

// ---------------------------------------------------------------------------
// Loans: coin from outside, repaid monthly with interest.

export function takeLoan(state, amount, {years = 10, rate = 0.06, lender = 'outside'} = {}) {
  if (!(amount > 0)) return null;
  const r = rate / 12, n = years * 12;
  const monthly = (amount * r) / (1 - Math.pow(1 + r, -n));
  const loan = {id: state.nextId++, principal: amount, rate, monthly, remaining: amount, lender, year: state.time.year};
  state.economy.loans.push(loan);
  credit(state, {kind: 'external'}, -amount);
  state.treasury += amount;
  flow(state, 'loanIn', amount);
  state.debt = state.economy.loans.reduce((s, l) => s + l.remaining, 0);
  return loan;
}

function serviceLoans(state) {
  const loans = state.economy.loans;
  for (const loan of loans) {
    const interest = loan.remaining * (loan.rate / 12);
    const payment = Math.min(loan.monthly, loan.remaining + interest);
    pay(state, 'treasury', 'external', payment, 'loanService');
    loan.remaining = Math.max(0, loan.remaining + interest - payment);
  }
  state.economy.loans = loans.filter((l) => l.remaining > 0.01);
  state.debt = state.economy.loans.reduce((s, l) => s + l.remaining, 0);
}

// The town keeps its roads: per cell a month, by tier (tracks are cheap, avenues dear),
// paid by the treasury to the builders. Uses sim-world's per-tier cell counts.
const ROAD_UPKEEP = [0, 0, 0.02, 0.05, 0.1, 0.15];

function roadUpkeep(state) {
  const counts = state.roads?.counts;
  if (!Array.isArray(counts)) return;
  let due = 0;
  for (let t = 2; t < ROAD_UPKEEP.length; t++) due += (counts[t] ?? 0) * ROAD_UPKEEP[t];
  if (due > 0) payBuilders(state, 'treasury', due * priceLevel(state), 'roadUpkeep');
}

// Households repay their mortgages to outside lenders. Arrears add to the debt.
function serviceMortgages(state) {
  for (const h of state.households) {
    if (!(h.debt > 0)) continue;
    const interest = h.debt * ((h.debtRate ?? 0.05) / 12);
    const paid = pay(state, h, 'external', Math.min(h.debtPayment ?? 0, h.debt + interest), 'mortgages');
    h.debt = Math.max(0, h.debt + interest - paid);
    if (h.debt < 0.01) {
      h.debt = 0;
      h.debtPayment = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Values

const BUILDING_VALUE = {
  farm: 900, workshop: 1200, mill: 3000, shop: 900, market: 1800, inn: 1400, warehouse: 1600,
  quay: 2400, exchange: 6000, theatre: 4000, factory: 8000, bathhouse: 2500,
};

export function buildingValue(state, b) {
  const base = b.type === 'home' ? HOME_TIERS[b.tier]?.cost ?? 500 : BUILDING_VALUE[b.type] ?? 0;
  return base * (1 + 0.5 * ((b.type === 'home' ? 1 : b.tier ?? 1) - 1)) * priceLevel(state) * (0.5 + 0.5 * (b.condition ?? 1));
}

// Each era makes work more productive; wages share in it.
export const productivity = (state) => 1 + 0.3 * state.era + 0.2 * Math.max(0, state.traits.innovation);
export const wageRate = (state) => BASE_WAGE * priceLevel(state) * (1 + 0.22 * state.era) * mod(state, 'wage');
export const prices = (state) => ({food: BASE_PRICES.food * priceLevel(state), goods: BASE_PRICES.goods * priceLevel(state)});

export const workersOf = (h) => (h.trade === 'gentry' ? 0 : h.size * (WORK_SHARE[h.lifeStage] ?? 0.5));

export function wealthBand(state, h) {
  const [t1, t2] = state.bands.wealth ?? [100, 300];
  return h.wealth < t1 ? 0 : h.wealth < t2 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// The month

// The month in two halves (index.js runs them on consecutive ticks): first work and
// pay, then spending, trade and loans.
export function economyMonthly(state) {
  economyMonthlyWork(state);
  economyMonthlySpend(state);
}

export function economyMonthlyWork(state) {
  const e = state.economy;
  e.lastMonth = e.month;
  e.month = {};
  e.prices = prices(state);
  e.wageRate = wageRate(state);
  const t = state._timings ? timer(state._timings) : (name, fn) => fn();
  t('jobs', () => matchJobs(state));
  t('public', () => fundPublic(state));
  e.made = t('produce', () => produce(state));
  t('wages', () => payWages(state));
}

export function economyMonthlySpend(state) {
  const made = state.economy.made ?? {food: 0, goods: 0};
  const t = state._timings ? timer(state._timings) : (name, fn) => fn();
  t('spending', () => householdSpending(state, made));
  t('upkeep', () => enterpriseUpkeep(state));
  t('exports', () => exportSurplus(state, made));
  t('trade', () => riverTrade(state));
  t('roads', () => roadUpkeep(state));
  t('loans', () => {
    serviceLoans(state);
    serviceMortgages(state);
  });
  for (const h of state.households) h.wealth = h.savings - (h.debt ?? 0);
}

// Diagnostics (tools only): with state._timings = {}, milliseconds per step pile up there.
function timer(out) {
  return (name, fn) => {
    const t0 = performance.now();
    const result = fn();
    out[name] = (out[name] ?? 0) + performance.now() - t0;
    return result;
  };
}

// Two passes: workers fill jobs of their own trade first; leftover workers of any
// trade fill leftover jobs.
function matchJobs(state) {
  const rows = {};
  const row = (t) => (rows[t] ??= {jobs: 0, workers: 0, filled: 0});
  for (const ent of state.enterprises) row(ent.trade).jobs += ent.jobs;
  for (const h of state.households) {
    h.workers = workersOf(h);
    row(h.trade).workers += h.workers;
  }
  let spareJobs = 0, spareWorkers = 0;
  for (const t in rows) {
    const r = rows[t];
    r.filled = Math.min(r.jobs, r.workers);
    spareJobs += r.jobs - r.filled;
    spareWorkers += r.workers - r.filled;
  }
  const extra = Math.min(spareJobs, spareWorkers);
  const jobFill = spareJobs > 0 ? extra / spareJobs : 0;
  const workerFill = spareWorkers > 0 ? extra / spareWorkers : 0;

  for (const ent of state.enterprises) {
    const r = rows[ent.trade];
    const own = r.jobs > 0 ? ent.jobs * (r.filled / r.jobs) : 0;
    ent.filledOwn = own;
    ent.filledSpare = (ent.jobs - own) * jobFill;
    ent.filled = ent.filledOwn + ent.filledSpare;
  }
  for (const h of state.households) {
    const r = rows[h.trade];
    const own = r.workers > 0 ? h.workers * (r.filled / r.workers) : 0;
    h.employedOwn = own;
    h.employedSpare = (h.workers - own) * workerFill;
    h.employed = h.employedOwn + h.employedSpare;
  }
  for (const t in rows) rows[t].filled += (rows[t].workers - rows[t].filled) * workerFill;
  state.economy.jobs = rows;
}

// The treasury pays the wages and upkeep of public enterprises (moot, school, watch...).
// The chapel is paid by the tithe when there is one.
function fundPublic(state) {
  const wage = state.economy.wageRate, price = priceLevel(state);
  const tithe = taxRate(state, 'tithe') > 0;
  for (const ent of state.enterprises) {
    if (!ent.public || (ent.type === 'chapel' && tithe)) continue;
    const need = ent.filled * wage + (ent.upkeep ?? 1) * price - ent.cash;
    if (need > 0) pay(state, 'treasury', ent, need, 'publicServices');
  }
}

function produce(state) {
  const food = mod(state, 'farmYield') * mod(state, 'output') * FOOD_PER_FARMER * ecologyFactor(state) * productivity(state);
  const goods = mod(state, 'goodsOutput') * mod(state, 'output') * GOODS_PER_WORKER * productivity(state);
  let foodMade = 0, goodsMade = 0;
  for (const ent of state.enterprises) {
    let f = 0, g = 0;
    if (ent.type === 'farm') f = ent.filled * food;
    else if (ent.sector === 'goods') {
      const boost = ent.automated ? 1.4 : 1;
      g = ent.filled * goods * boost * (ent.type === 'mill' ? mod(state, 'millOutput') * 1.3 * windFactor(state, ent) : 1);
    }
    ent.output = f + g;
    ent.foodMade = f;
    ent.goodsMade = g;
    foodMade += f;
    goodsMade += g;
  }
  state.food = state.food * (1 - FOOD_SPOIL) + foodMade;
  state.goods = state.goods * (1 - GOODS_WEAR) + goodsMade;
  flow(state, 'foodMade', foodMade);
  flow(state, 'goodsMade', goodsMade);
  return {food: foodMade, goods: goodsMade};
}

const ecologyFactor = (state) => 0.75 + 0.3 * state.pressures.ecology;

// A windmill's few hands each grind more than a water mill's crew, and more in a
// good wind (b.wind, the site's exposure 0..1, set when it was placed): at
// exposure 0.7 its four hands make about four-fifths of what a water mill's ten do.
function windFactor(state, ent) {
  const b = byId(state, 'buildings', ent.buildingId);
  return b?.variant === 'windmill' ? 1.2 + 1.2 * (b.wind ?? 0.5) : 1;
}

// Enterprises pay what they can; wages flow into per-trade pools and from there to the
// households whose workers filled those jobs.
function payWages(state) {
  const wage = state.economy.wageRate;
  const ownPool = {}, ownEmployed = {};
  let sparePool = 0, spareEmployed = 0;
  for (const ent of state.enterprises) {
    const bill = ent.filled * wage * (ent.automated ? 0.85 : 1);
    const paid = Math.min(bill, Math.max(0, ent.cash));
    ent.cash -= paid;
    ent.wagesPaid = paid;
    ent.costs += paid;
    ent.wagesBand = bill > 0 && paid < bill * 0.8 ? 0 : 1;
    if (ent.filled <= 0 || paid <= 0) continue;
    ownPool[ent.trade] = (ownPool[ent.trade] ?? 0) + (paid * ent.filledOwn) / ent.filled;
    sparePool += (paid * ent.filledSpare) / ent.filled;
  }
  for (const h of state.households) {
    ownEmployed[h.trade] = (ownEmployed[h.trade] ?? 0) + h.employedOwn;
    spareEmployed += h.employedSpare;
  }
  const incomeTax = (taxRate(state, 'income-tax') / 100) * fiscalReach(state);
  let distributed = 0, taxed = 0;
  for (const h of state.households) {
    const own = ownEmployed[h.trade] > 0 ? ((ownPool[h.trade] ?? 0) * h.employedOwn) / ownEmployed[h.trade] : 0;
    const spare = spareEmployed > 0 ? (sparePool * h.employedSpare) / spareEmployed : 0;
    const gross = own + spare;
    const tax = gross * incomeTax;
    h.savings += gross - tax;
    h.income = gross;
    distributed += gross;
    taxed += tax;
  }
  // Pools with no recipient (cannot happen when filled > 0, but keep the books exact).
  let pooled = sparePool;
  for (const t in ownPool) pooled += ownPool[t];
  const leftover = pooled - distributed;
  if (Math.abs(leftover) > 1e-9) state.treasury += leftover;
  state.treasury += taxed;
  flow(state, 'wages', distributed);
  flow(state, 'incomeTax', taxed);
  flow(state, 'treasuryIncome', taxed);
}

function householdSpending(state, made) {
  const price = state.economy.prices;
  const foodNeedPer = mod(state, 'foodNeed');
  let foodDemand = 0, goodsDemand = 0;
  for (const h of state.households) {
    h.foodNeed = h.size * foodNeedPer;
    h.goodsNeed = h.size * (0.15 + 0.08 * wealthBand(state, h));
    foodDemand += h.foodNeed;
    goodsDemand += h.goodsNeed;
  }
  const foodLocal = foodDemand > 0 ? Math.min(1, state.food / foodDemand) : 1;
  const goodsLocal = goodsDemand > 0 ? Math.min(1, state.goods / goodsDemand) : 1;

  let foodBought = 0, foodRevenue = 0, goodsBought = 0, goodsRevenue = 0, hunger = 0, goodsShort = 0;
  let foodImport = 0, goodsImport = 0;
  const markup = IMPORT_MARKUP - 0.35 * state.pressures.riverTrade;
  for (const h of state.households) {
    const f = buy(h, h.foodNeed, foodLocal, price.food, markup);
    foodBought += f.local; foodRevenue += f.localCost; foodImport += f.importCost;
    h.hunger = h.foodNeed > 0 ? 1 - (f.local + f.imported) / h.foodNeed : 0;
    hunger += h.foodNeed - f.local - f.imported;
    const g = buy(h, h.goodsNeed, goodsLocal, price.goods, markup);
    goodsBought += g.local; goodsRevenue += g.localCost; goodsImport += g.importCost;
    goodsShort += h.goodsNeed - g.local - g.imported;
  }
  state.food = Math.max(0, state.food - foodBought);
  state.goods = Math.max(0, state.goods - goodsBought);
  state.economy.shortage = {food: hunger, goods: goodsShort};
  creditExternal(state, foodImport + goodsImport, 'imports');
  sellToProducers(state, 'foodMade', made.food, foodRevenue, 'farm');
  sellToProducers(state, 'goodsMade', made.goods, goodsRevenue, 'goods');
  flow(state, 'foodBought', foodBought);

  const t = state._timings ? timer(state._timings) : (name, fn) => fn();
  t('housing', () => housingCosts(state));
  t('services', () => services(state));
  t('tithe', () => tithe(state));
}

// One household buys `need` units: a share `localShare` from the town's stock, the
// rest imported at a markup, all limited by savings.
function buy(h, need, localShare, price, markup) {
  const local = need * localShare, imported = need - local;
  const cost = local * price + imported * price * markup;
  const scale = cost > 0 ? Math.min(1, Math.max(0, h.savings) / cost) : 1;
  const localCost = local * price * scale, importCost = imported * price * markup * scale;
  h.savings -= localCost + importCost;
  return {local: local * scale, imported: imported * scale, localCost, importCost};
}

function creditExternal(state, amount, reason) {
  if (!(amount > 0)) return;
  state.economy.external.out += amount;
  flow(state, reason, amount);
}

function receiveExternal(state, ent, amount, reason) {
  if (!(amount > 0)) return;
  state.economy.external.in += amount;
  if (ent === 'treasury') state.treasury += amount;
  else {
    ent.cash += amount;
    ent.revenue += amount;
  }
  flow(state, reason, amount);
}

// Revenue for goods sold from stock goes to the producers of this month, by output.
// With no producer this month (selling from the granary), the treasury keeps it.
function sellToProducers(state, field, totalMade, revenue, sector) {
  if (!(revenue > 0)) return;
  if (totalMade <= 0) {
    state.treasury += revenue;
    flow(state, 'treasuryIncome', revenue);
    return;
  }
  for (const ent of state.enterprises) {
    const share = ent[field] / totalMade;
    if (share > 0) {
      ent.cash += revenue * share;
      ent.revenue += revenue * share;
    }
  }
  flow(state, sector === 'farm' ? 'foodSales' : 'goodsSales', revenue);
}

// Housing costs follow what a household earns, so they stay bearable as homes grow
// grander. Owners pay property tax to the treasury; tenants pay rent to the owner (or
// to the treasury for town-owned homes). Enterprises pay tax on their buildings.
function housingCosts(state) {
  const reach = fiscalReach(state);
  const rate = (taxRate(state, 'property-tax') / 100) * reach;
  const price = priceLevel(state);
  let taxTotal = 0, rentToTown = 0, rentToOwners = 0;
  for (const h of state.households) {
    h.rent = 0;
    if (h.homeId == null) continue;
    const home = byId(state, 'buildings', h.homeId);
    if (!home) continue;
    const value = buildingValue(state, home);
    if (home.ownerHouseholdId === h.id) {
      taxTotal += take(h, rate * (0.6 * h.income + 0.002 * value));
      continue;
    }
    const owner = home.ownerHouseholdId != null ? byId(state, 'households', home.ownerHouseholdId) : null;
    // Town-owned homes are let cheaply (half, and scaled like the taxes).
    const fair = Math.min(value * 0.002, 0.25 * h.income + 0.5 * price);
    const rent = take(h, owner ? fair : fair * 0.5 * reach);
    h.rent = rent;
    if (owner) {
      owner.savings += rent;
      rentToOwners += rent;
    } else rentToTown += rent;
  }
  const ground = groundRent(state, rate);
  rentToOwners += ground.toOwners;
  toTreasury(state, taxTotal, 'propertyTax');
  toTreasury(state, ground.siteTax, 'siteTax');
  toTreasury(state, rentToTown, 'rent');
  flow(state, 'rent', rentToOwners);
  state.economy.month.propertyTaxTotal = taxTotal;
}

// Enterprises pay ground rent (land.js): tenants the full rent to their landlord;
// owner-occupiers only the site tax, the property-tax rate's share of it. Returns what
// went to owners and what is due to the treasury as site tax.
export function groundRent(state, rate = taxRate(state, 'property-tax') / 100) {
  let siteTax = 0, toOwners = 0;
  for (const ent of state.enterprises) {
    if (ent.public) continue;
    const b = byId(state, 'buildings', ent.buildingId);
    if (!b) continue;
    const rent = monthlyRent(state, ent);
    ent.rent = (ent.rent ?? 0) + rent;
    const landlord = b.ownerHouseholdId != null && b.ownerHouseholdId !== ent.ownerHouseholdId ? byId(state, 'households', b.ownerHouseholdId) : null;
    // A land-value tax rule (modifierAdds.landTax 1 or 2) takes more of the site's rent.
    const siteShare = Math.min(1, rate * 2 + 0.25 * (state.modifierAdds?.landTax ?? 0));
    const paid = take(ent, landlord ? rent : rent * siteShare);
    ent.costs += paid;
    if (landlord) {
      landlord.savings += paid;
      toOwners += paid;
    } else siteTax += paid;
  }
  return {siteTax, toOwners};
}

// Hot-path helpers for the monthly loops: take coin from a household or enterprise
// (never below zero) and book a batch of it into the treasury with one flow entry.
function take(rec, amount) {
  const key = 'savings' in rec ? 'savings' : 'cash';
  const paid = amount > 0 ? Math.min(amount, Math.max(0, rec[key])) : 0;
  rec[key] -= paid;
  return paid;
}

function toTreasury(state, amount, reason) {
  if (!(amount > 0)) return;
  state.treasury += amount;
  flow(state, reason, amount);
  flow(state, 'treasuryIncome', amount);
}

// Shops, inns and markets: a share of each household's income, plus a little of any
// savings beyond a three-month cushion.
function services(state) {
  const sellers = state.enterprises.filter((e) => e.sector === 'services' && e.filled > 0);
  if (!sellers.length) return;
  // Footfall: shops on dear (central) land see more customers.
  const footfall = (s) => s.filled * (1 + (s.landValue ?? 20) / 30);
  let weight = 0;
  for (const s of sellers) weight += footfall(s);
  const share = 0.08 * mod(state, 'serviceSpend');
  let pot = 0;
  for (const h of state.households) {
    const cushion = 3 * (h.foodNeed * state.economy.prices.food + h.goodsNeed * state.economy.prices.goods);
    const spare = Math.max(0, h.savings - cushion);
    const spend = Math.min(h.savings, h.income * share + spare * 0.03, h.size * 4 * priceLevel(state));
    if (!(spend > 0)) continue;
    h.savings -= spend;
    pot += spend;
  }
  for (const s of sellers) {
    const part = (pot * footfall(s)) / weight;
    s.cash += part;
    s.revenue += part;
  }
  flow(state, 'services', pot);
}

function tithe(state) {
  const rate = taxRate(state, 'tithe') / 100;
  if (rate <= 0) return;
  const chapel = state.enterprises.find((e) => e.type === 'chapel');
  const parish = state.institutions.find((i) => i.kind === 'parish' && i.status === 'active');
  let total = 0;
  for (const h of state.households) total += take(h, h.income * rate);
  if (chapel) chapel.cash += total;
  else if (parish) parish.funds = (parish.funds ?? 0) + total;
  else state.treasury += total;
  flow(state, 'tithe', total);
  if (!chapel && !parish) flow(state, 'treasuryIncome', total);
  state.economy.month.titheTotal = total;
}

// Building upkeep and repairs go to the town's builders.
function enterpriseUpkeep(state) {
  const price = priceLevel(state);
  let pot = 0;
  for (const ent of state.enterprises) {
    const paid = take(ent, (ent.upkeep ?? 2) * price);
    ent.costs += paid;
    pot += paid;
  }
  creditBuilders(state, pot, 'upkeep');
}

// What the town makes beyond its store is sold downriver at a discount, up to this
// month's output. The coin goes to the producers.
// Buyers downriver take only so much: more with river trade and a name for industry.
// Whatever cannot be sold or stored spoils.
function exportSurplus(state, made) {
  const pop = state.indicators.pop || state.households.reduce((s, h) => s + h.size, 0);
  const price = state.economy.prices, exportPrice = mod(state, 'exportPrice') * EXPORT_DISCOUNT;
  const reach = 0.5 + state.pressures.riverTrade + 0.5 * Math.max(0, state.traits.industry);
  const foodStore = pop * FOOD_STORE_MONTHS, goodsStore = pop * 0.25 * GOODS_STORE_MONTHS;
  sellAbroad(state, 'food', 'foodMade', made.food, state.food - foodStore, price.food * exportPrice, pop * 0.3 * reach);
  sellAbroad(state, 'goods', 'goodsMade', made.goods, state.goods - goodsStore, price.goods * exportPrice, pop * 0.15 * reach);
  if (state.food > foodStore * 1.5) state.food -= (state.food - foodStore * 1.5) * 0.2;
  if (state.goods > goodsStore * 1.5) state.goods -= (state.goods - goodsStore * 1.5) * 0.2;
}

function sellAbroad(state, stock, field, made, extra, unitPrice, market) {
  const units = Math.min(extra, made, market);
  if (!(units > 0)) return;
  state[stock] -= units;
  for (const ent of state.enterprises) {
    if (ent[field] > 0) receiveExternal(state, ent, (units * unitPrice * ent[field]) / made, 'exports');
  }
  flow(state, `${stock}Exported`, units);
}

// Trade enterprises (warehouses, quays, the exchange) earn from river traffic.
function riverTrade(state) {
  const traders = state.enterprises.filter((e) => e.sector === 'trade' && e.filled > 0);
  if (!traders.length) return;
  const pop = state.indicators.pop;
  const income = state.pressures.riverTrade * pop * 0.4 * priceLevel(state) * mod(state, 'tradeVolume');
  let weight = 0;
  for (const t of traders) weight += t.filled;
  for (const t of traders) {
    const share = (income * t.filled) / weight;
    receiveExternal(state, t, share, 'riverTrade');
  }
}

// ---------------------------------------------------------------------------
// The year

export function economyYearly(state) {
  const e = state.economy;
  payDividends(state);
  fundInstitutions(state);
  e.lastYear = e.year;
  e.year = {};
  const last = e.lastYear;
  state.budget = {
    income: {tax: purseBase(last), tolls: last.tolls ?? 0, tithe: last.tithe ?? 0},
    spend: {
      upkeep: last.publicServices ?? 0,
      policies: last.policies ?? 0,
      bodies: {...(last.bodies ?? {})},
      projects: last.projects ?? 0,
      loans: last.loanService ?? 0,
    },
  };
  for (const ent of state.enterprises) {
    ent.profitLastYear = ent.revenue - ent.costs;
    ent.revenueLastYear = ent.revenue;
    ent.rentLastYear = ent.rent ?? 0;
    ent.revenue = 0;
    ent.costs = 0;
    ent.rent = 0;
  }
}

// Enterprises keep three months of costs; 70% of anything above goes to the owner, or,
// for ownerless cooperatives, to the households of its trade by their working members.
function payDividends(state) {
  const wage = state.economy.wageRate;
  let members = null;
  for (const ent of state.enterprises) {
    if (ent.public) continue;
    const reserve = 3 * (ent.jobs * wage + (ent.upkeep ?? 2) * priceLevel(state));
    const excess = ent.cash - reserve;
    if (!(excess > 0)) continue;
    const owner = ent.ownerHouseholdId != null ? byId(state, 'households', ent.ownerHouseholdId) : null;
    if (owner) {
      pay(state, ent, owner, excess * 0.7, 'dividends');
      continue;
    }
    members ??= membersByTrade(state);
    const group = members[ent.trade];
    if (group?.length) splitPay(state, ent, group, (h) => h.employed || 0.01, excess * 0.7, 'dividends');
  }
}

function membersByTrade(state) {
  const out = {};
  for (const h of state.households) (out[h.trade] ??= []).push(h);
  return out;
}

// Each active body gets its share of the year's tax income. The base is every
// tax the treasury levies: property, income and site tax. A land-value-tax town
// takes most of its tax as site tax, and it must still fund its bodies (the base
// used to leave site tax out, so a town that taxed only land paid every purse 0).
export const purseBase = (year = {}) => (year.propertyTax ?? 0) + (year.incomeTax ?? 0) + (year.siteTax ?? 0);

// Bodies on a yearly budget (budgets.js), or with one answered and waiting to
// be paid at this turn of the year, have no purse share.
function fundInstitutions(state) {
  const tax = purseBase(state.economy.year);
  const bodies = (state.economy.year.bodies = {});
  for (const inst of state.institutions) {
    if (inst.kind === 'moot' || inst.status !== 'active' || !(inst.budgetShare > 0)) continue;
    if (inst.budget?.mode === 'annual' || inst.budget?.next) continue;
    const amount = Math.min(inst.budgetShare * tax, Math.max(0, state.treasury));
    bodies[inst.id] = pay(state, 'treasury', inst, amount, 'bodyBudgets');
  }
}

export {clamp};
