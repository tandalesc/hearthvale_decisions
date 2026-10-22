// sim-governance's plug-in for the tick (see hooks.js): the Rule Book, bodies,
// docket, events, factions, chronicle and the decision scheduler.
// src/sim/index.js registers it with registerSystem(governanceSystem).
//
//   tick     scheduler: due questions out, answers in (sorted by key)
//   month    modifiers -> rules -> upkeep -> bodies -> budgets -> events -> docket expiry
//   quarter  docket session
//   year     factions -> approval -> bodies (purses, patience, power) -> budgets -> yearly transfers
//   yearEnd  chronicle line (and the end page at year 150)

import {monthIndex} from './clock.js';
import {pay, payBuilders} from './economy.js';
import {delta} from './pressures.js';
import {setTag} from './state.js';
import {devLint, LINES, coin} from './text/voice.js';
import {
  POLICIES, CATEGORIES, policiesMonthly, policyModifiers, yearlyUpkeep, weightsFor, costScale, adoptPolicy, fiscalBase,
} from './policies.js';
import {
  INSTITUTIONS, TEMPLATES, METRICS, initGovernance, institutionsMonthly, bodyColor, bodySeat, updateAutonomy, unionCard, hallCard, institutionsYearly, dissolveBody,
  eligibleTemplates, draftCard, bodyOf, markDrafted,
} from './institutions.js';
import {docketMonthly, docketQuarterly, rule, addCard, setCardProse, answerBudget} from './docket.js';
import {initBudgets, budgetsMonthly, budgetsYearly, strikeBudgetLine, approveAllBudgets, trimAllToFit} from './budgets.js';
import {initAdvisers, advisersMonthly, advisersYearly, hireAdviser, dismissAdviser, setAdviserMode, redrawSlate, letStand} from './advisors.js';
import {EVENTS, eventsMonthly, eventModifiers} from './events.js';
import {initFactions, factionsYearly, countFactions, addFactionStory, nudgeMood} from './factions.js';
import {addStory} from './households.js';
import {chronicleYearly, addChronicle, setChronicleProse, setSummaryProse} from './chronicle.js';
import {schedulerTick, distribution, resetScheduler, forgetRetiredKinds} from './decisions/scheduler.js';
import {updateBands} from './decisions/slices.js';
import {initApproval, approvalYearly} from './approval.js';

// Player-facing catalogues are linted once at load in development builds.
devLint('rules', {CATEGORIES, POLICIES});
devLint('bodies', {INSTITUTIONS, TEMPLATES, METRICS});
devLint('events', EVENTS);
devLint('lines', LINES);

// At most this share of the treasury's income goes on rule upkeep.
export const UPKEEP_CAP = 0.4;

// Rule modifier names -> the economy's MODIFIER_KEYS where they differ.
const MOD_ALIASES = {wages: 'wage', foodUse: 'foodNeed', food: 'farmYield'};
const TAX_RATES = {'property-tax': 'propertyTax', 'income-tax': 'incomeTax', tithe: 'titheShare'};

export function writeModifiers(state) {
  const mods = policyModifiers(state);
  const out = {};
  for (const [k, v] of Object.entries(mods.mul)) {
    const key = MOD_ALIASES[k] ?? k;
    out[key] = (out[key] ?? 1) * v;
  }
  for (const [k, v] of Object.entries(eventModifiers(state))) {
    if (k === 'unrestDrift') continue;
    out[k] = (out[k] ?? 1) * v;
  }
  state.modifiers = out;
  state.modifierAdds = {...mods.add};
  // Tax rules carry their rate where the economy reads it.
  for (const [id, key] of Object.entries(TAX_RATES)) {
    const p = state.policies[id];
    if (p?.level > 0 && mods.add[key] !== undefined) {
      const levels = POLICIES[id].add[key];
      p.rate = levels[Math.min(p.level, levels.length) - 1];
    }
  }
}

function month(state) {
  writeModifiers(state);
  policiesMonthly(state, state.governance.ruleFunding ?? 1);
  // Rule upkeep is paid monthly to the people who do the work. The town never
  // spends more than 40% of its free income on rules: past that, every rule
  // is underfunded alike and does proportionally less.
  const wanted = yearlyUpkeep(state) / 12;
  // The cap counts what is left after the town's public services (schools,
  // infirmaries and the like), and never falls below a quarter of income.
  const income = fiscalBase(state);
  const room = Math.max(0.25 * income, income - (state.economy?.lastYear?.publicServices ?? 0));
  const cap = (UPKEEP_CAP * room) / 12;
  const funding = wanted > cap ? cap / wanted : 1;
  state.governance.ruleFunding = Math.round(funding * 1000) / 1000;
  const upkeep = Math.round(wanted * funding);
  if (upkeep > 0) payBuilders(state, 'treasury', upkeep, 'policies');
  if (funding < 0.8 && state.governance.underfundedYear !== state.time.year) {
    state.governance.underfundedYear = state.time.year;
    addChronicle(state, 'The town cannot pay for all its rules. Each one does less than it should.', 'line');
  }
  for (const a of state.events.active) if (a.mods?.unrestDrift) delta(state, 'unrest', a.mods.unrestDrift, `event:${a.event}`);
  institutionsMonthly(state);
  budgetsMonthly(state);
  advisersMonthly(state);
  eventsMonthly(state);
  docketMonthly(state);
}

// Soft fail (design-systems §9.3): deep debt brings a steward who raises
// taxes and holds the purse strings until the treasury is back above zero.
function receivership(state) {
  const spend = state.economy?.lastYear?.treasurySpend ?? 0;
  const g = state.governance;
  if (!g.receivership && spend > 0 && state.treasury < -2 * spend) {
    g.receivership = {since: state.time.year};
    setTag(state, 'receivership');
    delta(state, 'prestige', -0.2, 'receivership');
    addChronicle(state, 'The town cannot pay its debts. A steward from the valley bank now holds the purse.', 'moment', {receivership: true});
  }
  if (!g.receivership) return;
  if (state.treasury >= 0) {
    g.receivership = null;
    addChronicle(state, 'The debts are paid. The steward hands the purse back to the council.', 'moment');
    return;
  }
  // The steward raises the property tax a step a year and pays no purses.
  const level = state.policies['property-tax']?.level ?? 0;
  if (level < POLICIES['property-tax'].maxLevel) {
    adoptPolicy(state, 'property-tax', level + 1, 'steward');
    addChronicle(state, 'The steward raised the property tax.', 'line');
  }
}

// The other side of receivership: coin piled beyond four years of spending is
// put to the town's own upkeep (repairs, drains, paths), a quarter of the
// excess a year, paid to its builders. No rule is made and nothing is placed.
export const RESERVE_YEARS = 4;
function townUpkeep(state) {
  const ly = state.economy?.lastYear ?? {};
  const income = ly.treasuryIncome ?? 0;
  const yearly = Math.max(ly.treasurySpend ?? 0, 0.5 * income);
  if (!(yearly > 0) || state.governance.receivership) return;
  const excess = (state.treasury ?? 0) - RESERVE_YEARS * yearly;
  if (excess <= 0) return;
  const paid = payBuilders(state, 'treasury', Math.round(0.25 * excess), 'town-upkeep');
  if (!paid) return;
  const share = Math.min(1, paid / Math.max(1, income));
  delta(state, 'health', 0.01 * share, 'town-upkeep');
  delta(state, 'prestige', 0.005 * share, 'town-upkeep');
  if (share > 0.3) addChronicle(state, `The council spent ${coin(paid)} on repairs, drains and paths.`, 'line', {upkeep: Math.round(paid)});
}

function year(state) {
  receivership(state);
  townUpkeep(state);
  const last = state.time.year - 1;
  const d = state.governance.displaced ?? {};
  const n = (d.farm?.[last] ?? 0) + (d.workshop?.[last] ?? 0) + (d.shop?.[last] ?? 0);
  if (n >= 2) addChronicle(state, `Rents and land sales pushed ${n} old businesses out of the centre last year.`, 'line', {displaced: n});
  countFactions(state);
  factionsYearly(state);
  approvalYearly(state);
  institutionsYearly(state);
  budgetsYearly(state);
  advisersYearly(state);
  updateAutonomy(state);
  unionCard(state);
  hallCard(state);
  yearlyTransfers(state);
  updateBands(state);
}

// Tolls bring coin from outside; some rules shift wealth between rich and poor.
function yearlyTransfers(state) {
  const add = state.modifierAdds ?? {};
  if (add.tollIncome) {
    const amount = Math.round(add.tollIncome * costScale(state) * (0.5 + (state.pressures.riverTrade ?? 0)));
    const paid = pay(state, 'external', 'treasury', amount, 'tolls');
    state.budget.income.tolls = paid;
  }
  const shift = (add.inequalityShift ?? 0) + (state.governance.inequalityShock ?? 0);
  state.governance.inequalityShock = 0;
  if (Math.abs(shift) > 1e-6 && state.households.length >= 5) shiftWealth(state, shift);
}

// Move a share of all savings between the poorer half and the richest fifth.
// Each payer pays one recipient in turn, so this stays linear in households.
function shiftWealth(state, shift) {
  const ranked = [...state.households].sort((a, b) => (a.savings ?? 0) - (b.savings ?? 0) || a.id - b.id);
  const total = ranked.reduce((n, h) => n + Math.max(0, h.savings ?? 0), 0);
  const poor = ranked.slice(0, Math.floor(ranked.length / 2));
  const rich = ranked.slice(Math.floor(ranked.length * 0.8));
  const [from, to] = shift > 0 ? [poor, rich] : [rich, poor];
  const fromTotal = from.reduce((n, h) => n + Math.max(0, h.savings ?? 0), 0);
  if (fromTotal <= 0 || !to.length) return;
  const amount = Math.min(Math.abs(shift) * total, fromTotal * 0.5);
  from.forEach((h, i) => {
    const share = (amount * Math.max(0, h.savings ?? 0)) / fromTotal;
    if (share >= 0.5) pay(state, h, to[i % to.length], share, 'wealth-shift');
  });
}

function yearEnd(state) {
  chronicleYearly(state);
}

function init(state) {
  initGovernance(state);
  initBudgets(state);
  initAdvisers(state);
  initFactions(state);
  updateBands(state);
  state.governance.yearStart = null;
  writeModifiers(state);
  // The hamlet starts with one card on the table, so there is something to rule on.
  if (state.time.year === 0 && !state.docket.length) firstCard(state);
  initApproval(state);
}

function firstCard(state) {
  const moot = bodyOf(state, 'moot');
  const [best] = eligibleTemplates(state, moot);
  if (!best) return;
  const card = addCard(state, draftCard(state, moot, best));
  markDrafted(state, moot);
  if (card) {
    card.surfacedMonth = monthIndex(state.time);
    card.expiresMonth = card.surfacedMonth + 24;
    state.governance.cardsThisYear = 1;
  }
}

function restore(state) {
  initGovernance(state);
  initBudgets(state);
  initAdvisers(state);
  initFactions(state);
  resetScheduler(state);
  forgetRetiredKinds(state);
  writeModifiers(state);
  initApproval(state);
}

// ---------------------------------------------------------------------------
// Displacement: sim-core / sim-world report a business pushed out by rent or
// a land sale. info = {kind: 'farm'|'workshop'|'shop'|..., reason: 'rent'|'sale',
// buildingId?, enterpriseId?, households?: [ids], trade?}
// ---------------------------------------------------------------------------

const DISPLACED_TAG = {farm: 'farmland-sold', workshop: 'workshop-displaced', mill: 'workshop-displaced', shop: 'shop-displaced'};
const TRADE_OF = {farm: 'farm', workshop: 'craft', mill: 'craft', shop: 'trade', inn: 'trade', warehouse: 'labour'};

export function noteDisplaced(state, info = {}) {
  const kind = info.kind === 'mill' || info.kind === 'factory' ? 'workshop' : info.kind ?? 'shop';
  const g = state.governance;
  const table = ((g.displaced ??= {})[kind] ??= {});
  table[state.time.year] = (table[state.time.year] ?? 0) + 1;
  for (const y of Object.keys(table)) if (state.time.year - Number(y) > 10) delete table[y];
  setTag(state, DISPLACED_TAG[kind] ?? 'shop-displaced');
  const trade = info.trade ?? TRADE_OF[kind] ?? 'trade';
  for (const f of state.factions) if (f.trades?.includes(trade)) nudgeMood(f, Math.max(0, f.mood - 0.02), 'displaced');
  delta(state, 'unrest', 0.003, `displaced:${kind}`);
  const text = info.reason === 'sale' ? 'sold up and moved out' : 'priced out of the centre';
  for (const id of (info.households ?? []).slice(0, 12)) {
    const h = state.households.find((x) => x.id === id);
    if (h) addStory(state, h, 'displaced', {text});
  }
  addFactionStory(state, tradeFaction(trade), 'displaced', text);
}

const tradeFaction = (trade) => ({farm: 'farmers', craft: 'crafters', trade: 'merchants', labour: 'labourers'}[trade] ?? 'labourers');

// ---------------------------------------------------------------------------
// The system object
// ---------------------------------------------------------------------------

export const governanceSystem = {
  id: 'governance',
  order: 10,
  init,
  restore,
  tick: (state, ctx) => schedulerTick(state, ctx),
  month: (state) => month(state),
  quarter: (state) => docketQuarterly(state),
  year: (state) => year(state),
  yearEnd: (state) => yearEnd(state),
  distribution: (state, kind, subject) => distribution(state, kind, subject),
  optionWeights: (state, kind) => {
    const w = weightsFor(state, kind);
    return Object.keys(w).length ? w : null;
  },
  actions: {
    rule: (state, cardId, optionKey) => rule(state, cardId, optionKey),
    strikeBudgetLine,
    hireAdviser,
    dismissAdviser,
    setAdviserMode,
    redrawSlate,
    letStand: (state, cardId) => letStand(state, cardId, {rule, answerBudget}),
    approveAllBudgets: (state) => approveAllBudgets(state, rule),
    trimAllToFit: (state) => trimAllToFit(state, (card, choice, opts) => answerBudget(state, card.id, choice, opts)),
    dissolveBody,
    setCardProse,
    setChronicleProse,
    setSummaryProse,
  },
  displaced: (state, info) => noteDisplaced(state, info),
  bodyColor: (state, bodyId) => bodyColor(state, bodyId),
  bodyBuilding: (state, bodyId) => bodySeat(state, bodyId),
};

