// Strikes: who walks out when the union calls one.
//
// The town asks one question per strike (decision kind strike_resolve): how
// hard the workers hold out, from the wage, their hardship, their savings and
// the labourers' mood. Everything else is the sim's own: each working
// household draws strike, short hours or work from its own circumstances,
// scaled by that resolve, and the strike's output penalty follows the share of
// jobs that walked out.

import {rng} from './rng.js';
import {BASE_WAGE} from './economy.js';
import {priceLevel, clamp} from './pressures.js';
import {factionById, moodBand} from './factions.js';
import {addStory} from './households.js';

// How readily each trade walks out. Gentry have no wage to withhold.
const TRADE_LEAN = {labour: 1, none: 1, craft: 0.8, trade: 0.4, clerical: 0.4, farm: 0.3, clergy: 0, gentry: 0};
// strike_resolve's answer, lowest first, as a multiplier on striking.
export const RESOLVE = {back_down: 0.4, some: 0.8, most: 1.25, solid: 1.7};
const STORIES = 12;

const owners = (state) => new Set(state.enterprises.map((e) => e.ownerHouseholdId).filter((id) => id != null));

// Households who could strike: they work for someone else's business.
function strikers(state) {
  const own = owners(state);
  return state.households.filter((h) => h.employed > 0 && (TRADE_LEAN[h.trade] ?? 0) > 0 && !own.has(h.id));
}

const rentBurden = (h) => (h.income > 0 ? clamp((h.rent ?? 0) / h.income, 0, 2) : h.rent > 0 ? 1 : 0);
const hardship = (h) => clamp(0.6 * rentBurden(h) + 0.8 * clamp(h.hunger ?? 0, 0, 1), 0, 1.5);
const monthsSaved = (h) => (h.savings ?? 0) / Math.max(1, h.income ?? 0);
const labourMood = (state) => factionById(state, 'labourers')?.mood ?? 0.5;

// The strike_resolve question's context: the workers' situation in bands.
export function strikeContext(state) {
  const hs = strikers(state);
  let jobs = 0, hard = 0;
  const saved = [];
  for (const h of hs) {
    jobs += h.employed;
    hard += hardship(h) * h.employed;
    saved.push(monthsSaved(h));
  }
  hard = jobs > 0 ? hard / jobs : 0;
  saved.sort((a, b) => a - b);
  const median = saved.length ? saved[saved.length >> 1] : 0;
  // The day wage against what it would be with no wage rules: a wage floor
  // lifts it (x1.08, 1.16, 1.25 by level), so no floor reads as low.
  const wage = (state.economy?.wageRate ?? BASE_WAGE) / (BASE_WAGE * priceLevel(state) * (1 + 0.22 * state.era));
  return {
    wages: wage < 1.04 ? 'low' : wage < 1.2 ? 'fair' : 'good',
    hardship: hard < 0.2 ? 'none' : hard < 0.5 ? 'some' : 'much',
    savings: median < 2 ? 'thin' : median < 6 ? 'some' : 'plenty',
    mood: moodBand(labourMood(state)),
  };
}

// Expected multiplier from strike_resolve probabilities (1 with none).
export const resolveOf = (probs) => (probs ? Object.entries(RESOLVE).reduce((m, [k, v]) => m + (probs[k] ?? 0) * v, 0) /
  Math.max(1e-9, Object.keys(RESOLVE).reduce((n, k) => n + (probs[k] ?? 0), 0)) : 1);

// Each working household chooses; the strike event's output penalty follows the
// work lost. -> {strike, partial}: shares of the town's employed.
export function walkout(state, recordId, resolve = 1) {
  const mood = labourMood(state);
  let all = 0, struck = 0, part = 0, told = 0;
  for (const h of state.households) all += h.employed > 0 ? h.employed : 0;
  for (const h of strikers(state)) {
    const lean = TRADE_LEAN[h.trade];
    const g = hardship(h) + 0.4 * (1 - mood);
    const buffer = clamp(monthsSaved(h) / 3, 0, 1);
    // A labourer in an ordinary year (a little grievance, savings put by)
    // walks out nearly half the time; farmers and shopkeepers far less, so a
    // mixed town loses about a third of its output and a mill town more.
    const w = {
      strike: lean * (0.5 + 0.8 * g) * (0.6 + 0.4 * buffer) * resolve,
      partial: 0.2 * lean,
      work: 0.25 + 0.4 * Math.max(0, 1 - g),
    };
    let x = rng(state) * (w.strike + w.partial + w.work);
    if ((x -= w.strike) < 0) {
      struck += h.employed;
      if (told++ < STORIES) addStory(state, h, 'strike');
    } else if (x - w.partial < 0) part += h.employed;
  }
  const out = all > 0 ? {strike: struck / all, partial: part / all} : {strike: 0, partial: 0};
  // The strike's modifier entry lasts as long as the strike (its event record
  // only to the month's end), so the walkout is kept there.
  const mods = state.events.active.find((e) => e.id === `${recordId}m`);
  if (!mods) return out;
  // Work lost: strikers' whole day, short hours half of it.
  if (all > 0) mods.mods.output = Math.round(Math.max(0.4, 1 - out.strike - out.partial * 0.5) * 100) / 100;
  mods.walkout = {strike: Math.round(out.strike * 100) / 100, partial: Math.round(out.partial * 100) / 100, resolve: Math.round(resolve * 100) / 100};
  return out;
}
