// Traits (slow, bipolar, with momentum and lock-in), pressures (unipolar, decaying),
// indicators (derived monthly) and the trajectory archetype (yearly).
//
// Everything that wants to move the town's character calls delta(state, key, amount,
// source). Deltas pile up in state.deltaLog during the month; applyDeltas() folds them in
// at month end.

import {TRAIT_KEYS, PRESSURE_KEYS, HOME_TIERS, emitChronicle, byId} from './state.js';
import {makeCtx, evalCond, resolvePath} from './conditions.js';

// Decay per month toward the baseline. A steady push of d a month settles at
// baseline + d / decay, so these rates decide how far lasting rules carry a town (the
// spec's 0.002-0.005 let any two rules pin faith, learning or prestige near 1).
export const PRESSURES = {
  riverTrade: {baseline: 0.05, decay: 0.007},
  faith: {baseline: 0.2, decay: 0.007},
  learning: {baseline: 0.05, decay: 0.007},
  ecology: {baseline: 0.9, decay: 0.006},
  health: {baseline: 0.4, decay: 0.01},
  unrest: {baseline: 0, decay: 0.03},
  prestige: {baseline: 0, decay: 0.01},
};

// Which way each kind of institution anchors the traits (used in lock-in).
export const INSTITUTION_AXES = {
  'agri-council': {industry: -1},
  'trades-guild': {market: -0.5, innovation: -1},
  exchange: {market: 1},
  planning: {authority: 1},
  union: {market: -1},
  parish: {innovation: -1},
  'school-board': {innovation: 1},
};

const DELTA_LOG_CAP = 5000;

export function delta(state, key, amount, source = 'unknown') {
  if (!Number.isFinite(amount) || amount === 0) return;
  if (!(key in state.traits) && !(key in state.pressures)) throw new Error(`Unknown pressure or trait: ${key}`);
  if (state.deltaLog.length < DELTA_LOG_CAP) state.deltaLog.push({key, amount, source});
  else mergeIntoLast(state.deltaLog, key, amount);
}

// Keep the log bounded without losing totals.
function mergeIntoLast(log, key, amount) {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].key === key) { log[i].amount += amount; return; }
  }
  log[log.length - 1] = {key, amount, source: 'merged'};
}

export function sumDeltas(log) {
  const sums = {};
  for (const {key, amount} of log) sums[key] = (sums[key] ?? 0) + amount;
  return sums;
}

// Month end: traits get momentum and lock-in; pressures decay toward their baseline.
export function applyDeltas(state) {
  const sums = sumDeltas(state.deltaLog);
  if (state._traceDeltas) traceSources(state);
  for (const k of TRAIT_KEYS) updateTrait(state, k, sums[k] ?? 0);
  for (const k of PRESSURE_KEYS) {
    const {baseline, decay} = PRESSURES[k];
    const p = state.pressures[k];
    state.pressures[k] = clamp(p + (sums[k] ?? 0) - decay * (p - baseline), 0, 1);
  }
  state.lastDeltas = sums;
  state.deltaLog.length = 0;
}

// Diagnostics (tools only): with state._traceDeltas = true, totals per key and source
// kind (the part of the source before ':') pile up in state._deltaSources.
function traceSources(state) {
  const out = (state._deltaSources ??= {});
  for (const {key, amount, source} of state.deltaLog) {
    const kind = String(source).split(':')[0];
    const row = (out[key] ??= {});
    row[kind] = (row[kind] ?? 0) + amount;
  }
}

export function lockFor(state, key) {
  const t = state.traits[key];
  return Math.min(0.75, 0.6 * t * t + 0.05 * anchors(state, key, Math.sign(t)));
}

// Momentum: v = 0.8·v + Σdeltas (design-systems §1.3). Applied as 0.3·v, so a steady
// push moves the trait by 1.5× its plain total, smoothed and delayed; as specced (×1)
// every push was multiplied by five and traits pinned at ±1.
const MOMENTUM_GAIN = 0.3;

function updateTrait(state, key, sum) {
  const v = state.traitVel[key] * 0.8 + sum;
  const t = state.traits[key];
  const lock = lockFor(state, key);
  const reinforcing = Math.sign(v) === Math.sign(t) && t !== 0;
  state.traitVel[key] = Math.abs(v) < 1e-7 ? 0 : v;
  state.traits[key] = clamp(t + MOMENTUM_GAIN * v * (reinforcing ? 1 + 0.5 * lock : 1 - lock), -1, 1);
}

// Live institutions pulling this trait in direction `sign`.
function anchors(state, key, sign) {
  if (sign === 0) return 0;
  let n = 0;
  for (const inst of state.institutions) {
    if (inst.status !== 'active') continue;
    const axis = inst.axis ?? INSTITUTION_AXES[inst.kind];
    const w = axis?.[key];
    if (w && Math.sign(w) === sign) n += Math.abs(w);
  }
  return n;
}

// True when a push of `amount` on `key` goes against a strong trait (|T| > 0.4).
// policies.js uses this for the reversal cost: upkeep x (1 + 2|T|), unrest +0.01/month.
export function againstGrain(state, key, amount) {
  const t = state.traits[key];
  return t !== undefined && Math.abs(t) > 0.4 && amount !== 0 && Math.sign(amount) !== Math.sign(t);
}

// ---------------------------------------------------------------------------
// Indicators (monthly)

const TRAFFIC_NORM = 25;   // wear units per person per month that count as heavy traffic

export function computeIndicators(state) {
  const I = state.indicators;
  const hh = state.households;
  let pop = 0, homeless = 0, wealthSum = 0, tierWeighted = 0, housed = 0;
  for (const h of hh) {
    pop += h.size;
    wealthSum += h.wealth;
    if (h.homeId == null) { homeless++; continue; }
    const home = byId(state, 'buildings', h.homeId);
    tierWeighted += home?.tier ?? 1;
    housed++;
  }
  const price = priceLevel(state);
  I.pop = pop;
  I.households = hh.length;
  I.housingPressure = hh.length ? homeless / hh.length : 0;
  I.avgWealth = hh.length ? wealthSum / hh.length / price : 0;
  I.inequality = gini(hh);
  I.avgHomeTier = housed ? tierWeighted / housed : 1;
  I.density = densityOf(state);
  I.foodBalance = clamp(state.food / Math.max(1, pop), 0, 24);
  I.literacy = clamp((I.literacy ?? 0) + (0.03 + 0.9 * state.pressures.learning - (I.literacy ?? 0)) * 0.05, 0, 1);
  I.traffic = clamp((state.roads.wearAddedMonth ?? 0) / Math.max(1, pop) / TRAFFIC_NORM, 0, 1);
  I.tension = tensionOf(state, pop);
  const jobs = jobTotals(state);
  I.jobBalance = jobs.workers ? clamp((jobs.jobs - jobs.workers) / jobs.workers, -1, 1) : 0;
  I.employment = jobs.workers ? clamp(jobs.filled / jobs.workers, 0, 1) : 1;
  const yearlySpend = yearlyNetSpend(state);
  I.treasuryYears = yearlySpend > 0 ? clamp(state.treasury / yearlySpend, 0, 10) : (state.treasury > 0 ? 10 : 0);
  I.wellbeing = wellbeingOf(state);
  return I;
}

export const priceLevel = (state) => 1 + 0.25 * state.era + 0.15 * Math.max(0, state.traits.innovation);

function gini(households) {
  const n = households.length;
  if (n < 2) return 0;
  const w = households.map((h) => Math.max(0, h.wealth)).sort((a, b) => a - b);
  let cum = 0, weighted = 0;
  for (let i = 0; i < n; i++) {
    cum += w[i];
    weighted += (i + 1) * w[i];
  }
  return cum > 0 ? clamp((2 * weighted) / (n * cum) - (n + 1) / n, 0, 1) : 0;
}

// Home units (capacity / 5) per 100 cells of built footprint, normalised at 60.
function densityOf(state) {
  let units = 0, cells = 0;
  for (const b of state.buildings) {
    if (b.type === 'farm' || b.type === 'park' || b.type === 'bridge') continue;
    cells += ((b.w + 2) * (b.d + 2)) / 4;
    if (b.type === 'home') units += (HOME_TIERS[b.tier]?.capacity ?? 5) / 5;
  }
  return cells ? clamp((units * 100) / cells / 60, 0, 1) : 0;
}

function tensionOf(state, pop) {
  const year = state.time.year;
  let total = 0, kinds = 0;
  for (const kind in state.disagreement) {
    const rows = state.disagreement[kind];
    let sum = 0, any = false;
    for (const key in rows) {
      const r = rows[key];
      if (r.year < year - 1) continue;
      sum += r.D * r.n;
      any = true;
    }
    if (any) { total += sum; kinds++; }
  }
  return kinds && pop ? clamp(total / kinds / pop, 0, 1) : 0;
}

function jobTotals(state) {
  let jobs = 0, workers = 0, filled = 0;
  for (const t in state.economy.jobs) {
    const row = state.economy.jobs[t];
    jobs += row.jobs;
    workers += row.workers;
    filled += row.filled;
  }
  return {jobs, workers, filled};
}

function yearlyNetSpend(state) {
  const last = state.economy.lastYear;
  if (Number.isFinite(last.treasurySpend) && last.treasurySpend > 0) return last.treasurySpend;
  return (state.economy.lastMonth.treasurySpend ?? 0) * 12;
}

// 0-100, shown in the top bar. Food, homes, work, health and calm.
function wellbeingOf(state) {
  const I = state.indicators, P = state.pressures;
  const food = I.foodBalance >= 2 ? 1 : I.foodBalance / 2;
  const homes = 1 - I.housingPressure;
  const work = I.employment;
  const shortage = state.economy.shortage;
  const hunger = shortage.food > 0 ? Math.min(1, shortage.food / Math.max(1, I.pop)) : 0;
  // Rules and events add a little on top (feast days, festival fund, curfew).
  const extra = state.modifierAdds?.happiness ?? 0;
  const score = 30 * food + 18 * homes + 18 * work + 16 * P.health + 18 * (1 - P.unrest) - 25 * hunger + extra;
  return Math.round(clamp(score, 0, 100));
}

// Yearly samples for trend lines and the end-of-chronicle page.
const HISTORY_KEYS = ['pop', 'households', 'inequality', 'housingPressure', 'foodBalance', 'avgWealth', 'avgHomeTier', 'density', 'wellbeing', 'tension', 'literacy'];
const HISTORY_CAP = 200;

export function recordHistory(state) {
  const push = (key, value) => {
    const list = (state.indicatorHistory[key] ??= []);
    list.push(Math.round(value * 1000) / 1000);
    if (list.length > HISTORY_CAP) list.shift();
  };
  for (const k of HISTORY_KEYS) push(k, state.indicators[k] ?? 0);
  push('treasury', state.treasury);
  for (const k of TRAIT_KEYS) push(`T.${k}`, state.traits[k]);
  for (const k of PRESSURE_KEYS) push(`P.${k}`, state.pressures[k]);
}

// ---------------------------------------------------------------------------
// Archetype (yearly). Each archetype has a `when` (shown in the UI) made of measured
// terms plus gates. Its score is the smallest ratio of value to threshold over its
// terms (1 = just there; for a negative threshold, -value / -threshold). Of the
// archetypes whose gates and terms all hold, the town takes the highest score, keeping
// its current one unless another leads by 5%. (The spec's "first match wins" let one
// trait decide nearly every town.)

const GARDEN_RULES = ['or', ['has', 'policy', 'park-reserve'], ['has', 'policy', 'woodland-reserve'], ['has', 'policy', 'market-gardens']];

export const ARCHETYPES = [
  {id: 'cathedral', label: 'a cathedral town', terms: [['P.faith', 0.6], ['P.prestige', 0.2]]},
  {id: 'mill', label: 'a mill town', terms: [['T.industry', 0.45]]},
  {id: 'port', label: 'a river port', terms: [['P.riverTrade', 0.55]]},
  {id: 'garden', label: 'a garden town', terms: [['P.ecology', 0.8]], gates: [GARDEN_RULES, ['gte', 'I.pop', 400]]},
  {id: 'commune', label: 'a commune', terms: [['T.market', -0.35]], gates: [['lte', 'T.authority', 0]]},
  {id: 'exchange', label: 'a merchant town', terms: [['T.market', 0.4]]},
  {id: 'scholar', label: 'a town of scholars', terms: [['P.learning', 0.6]]},
  {id: 'market-town', label: 'a market town', terms: []},
];
for (const a of ARCHETYPES) {
  const terms = a.terms.map(([path, t]) => (t < 0 ? ['lte', path, t] : ['gte', path, t]));
  a.when = terms.length || a.gates ? ['and', ...terms, ...(a.gates ?? [])] : true;
}

const STICKINESS = 1.05;

export function archetypeScore(a, ctx) {
  if (a.gates && !a.gates.every((g) => evalCond(g, ctx) >= 1)) return 0;
  if (!a.terms.length) return 1;
  let score = Infinity;
  for (const [path, t] of a.terms) score = Math.min(score, resolvePath(path, ctx) / t);
  return score;
}

export function chooseArchetype(state) {
  const ctx = makeCtx(state);
  let best = ARCHETYPES.at(-1), bestScore = 1;
  for (const a of ARCHETYPES) {
    const score = archetypeScore(a, ctx);
    if (score >= 1 && score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  const current = ARCHETYPES.find((a) => a.id === state.archetype);
  const currentScore = current ? archetypeScore(current, ctx) : 0;
  if (current && currentScore >= 1 && best !== current && bestScore < currentScore * STICKINESS) return current;
  return best;
}

export function updateArchetype(state) {
  const match = chooseArchetype(state);
  const previous = state.archetype;
  if (match.id === previous) {
    state.archetypeScore = Math.min(1, (state.archetypeScore ?? 0) + 0.1);
    return false;
  }
  state.archetype = match.id;
  state.archetypeScore = 0;
  (state.archetypeLog ??= []).push({year: state.time.year, archetype: match.id});
  emitChronicle(state, {kind: 'moment', text: `Hearthvale is becoming ${match.label}.`, refs: {archetype: match.id, from: previous}});
  return true;
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
