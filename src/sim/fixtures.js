// Ready-made states for the renderer, the UI and tests:
//
//   fixtureState('hamlet')   year 0, the starting hamlet
//   fixtureState('town')     era 2, ~600+ people, bodies, rules, a docket
//   fixtureState('city')     era 4, ~3,000+ people, ~1,000 buildings, many bodies and rules
//
// Town and city are grown, not drawn: the real simulation runs headless from a seed
// (fallback answers, no decision service) while a stand-in council rules the docket,
// and a steady stream of settlers speeds up the early years. Roads, lots and buildings
// therefore come out of the same desire paths and site choices as in play.
//
// Both are cached as saves in src/sim/fixtures/{town,city}.json (walkers and the
// answer log are left out; walkers are re-drawn on load), so a change to the economy
// does not silently reshape the towns the tests and the UI read. Regenerate them on
// purpose, and keep the tests that read them free of their incidental layout:
//
//   node src/sim/fixtures/build.js town city
//
// In the browser, call `await loadFixture('city')` once to fetch the cached file; after
// that fixtureState('city') is instant. Without a usable cache it grows on the spot.

import {createState, stepTick, rule, immigrate, serialize, restore, trimAllToFit} from './index.js';
import {syncIndividuals} from './people.js';
import {POLICIES} from './policies.js';

export const FIXTURE_VERSION = 1;

export const FIXTURE_PROFILES = {
  town: {seed: 2024, cached: true, pop: 600, era: 2, minYear: 30, maxYear: 60, boost: 0.08, accept: 0.35, acceptBodies: 0.85},
  city: {seed: 1888, cached: true, pop: 3000, era: 4, minYear: 92, maxYear: 125, boost: 0.06, accept: 0.35, acceptBodies: 0.85},
};

const memo = new Map();   // name -> save text

export function fixtureState(name = 'hamlet', options = {}) {
  // Fixtures are baselines: they keep the river-only (version 1) valleys they were grown in.
  if (name === 'hamlet') return createState(options.seed, {terrainVersion: 1, ...options});
  if (!FIXTURE_PROFILES[name]) throw new Error(`Unknown fixture: ${name}`);
  const cached = FIXTURE_PROFILES[name].cached;
  const text = memo.get(name) ?? (cached ? readCache(name) : null) ?? growAndRemember(name);
  memo.set(name, text);
  return wake(restore(text), options);
}

// Browser helper: fetch the cached save once (falls back to growing it).
export async function loadFixture(name, options = {}) {
  if (name !== 'hamlet' && FIXTURE_PROFILES[name]?.cached && !memo.has(name)) {
    try {
      const res = await fetch(cacheUrl(name));
      if (res.ok) {
        const text = await res.text();
        if (usable(text)) memo.set(name, text);
      }
    } catch {
      // No cache reachable: fixtureState grows it below.
    }
  }
  return fixtureState(name, options);
}

// ---------------------------------------------------------------------------
// Growing

// Run the real sim headless until the profile's era and population are reached.
export function growFixture(name, {onYear = null} = {}) {
  const profile = FIXTURE_PROFILES[name];
  const state = createState(profile.seed, {terrainVersion: 1});
  const council = standInCouncil(profile);
  const done = () => state.era >= profile.era && state.indicators.pop >= profile.pop && state.time.year >= profile.minYear;
  while (!done() && state.time.year < profile.maxYear) {
    steerGrowth(state, profile);
    runYear(state, council);
    onYear?.(state);
  }
  // Leave the last few cards unread so the docket has something on it.
  for (let q = 0; q < 8 && state.docket.length < 2; q++) runTicks(state, 150);
  state.fixture = {version: FIXTURE_VERSION, name, seed: profile.seed};
  return state;
}

// Settlers arrive faster while the town is small; past the target the stream dries up.
function steerGrowth(state, profile) {
  const pop = state.indicators.pop;
  if (pop < profile.pop) immigrate(state, Math.round(pop * profile.boost));
  state.migrationBias = pop > profile.pop * 1.15 ? -0.4 : 0;
}

function runYear(state, council) {
  const year = state.time.year;
  while (state.time.year === year) {
    stepTick(state, 4, {}, {skipPeople: true});
    council(state);
  }
}

const runTicks = (state, n) => {
  for (let i = 0; i < n; i++) stepTick(state, 0.1, {}, {skipPeople: true});
};

// A simple, deterministic player. Without a taste it says yes to a share of the cards it
// can afford (more readily to new bodies), otherwise "Not now". With a taste
// (profile.prefers: weights on traits and pressures, profile.bodies, profile.builds) it
// scores each option by what it would do: rules by their monthly deltas, new bodies and
// buildings by liking. It takes the best option it likes and refuses what it dislikes;
// cards it has no view on fall back to the plain behaviour.
export function standInCouncil(profile) {
  let seed = profile.seed >>> 0;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const seen = new Set();
  const choose = chooser(profile, rand);
  return (state) => {
    // Budgets: the season's asks, trimmed alike to the town's room (all approved if they fit).
    if (state.docket.some((c) => c.kind === 'budget')) trimAllToFit(state);
    for (const card of [...state.docket]) {
      // Only cards a player could see: queued cards wait for the next session.
      if (seen.has(card.id) || ('surfacedMonth' in card && card.surfacedMonth == null)) continue;
      seen.add(card.id);
      choose(state, card);
    }
  };
}

// A simulated player, for runs that should look like play rather than a perfect
// council. It opens the docket in sessions (some months, not every month), takes up
// only some of the cards it sees and lets the rest lapse at their deadline, as an
// absent player's would, rules on the ones it takes at its next session, and now and
// then picks an option at random. Otherwise it chooses like standInCouncil with the
// same profile. Engagement is drawn per player unless given: attend (share of cards
// taken up), session (chance of opening the docket in a month), slip (chance of a
// random pick). It keeps its own random stream, so who answers the town's questions
// does not change how the player behaves, only what it sees.
export function simulatedPlayer(profile) {
  let seed = ((profile.seed >>> 0) ^ 0x9e3779b9) >>> 0 || 1;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const attend = profile.attend ?? 0.5 + 0.45 * rand();
  const session = profile.session ?? 0.35 + 0.5 * rand();
  const slip = profile.slip ?? 0.05 + 0.15 * rand();
  const choose = chooser(profile, rand);
  const taken = new Map();
  let lastMonth = null;
  const play = (state) => {
    const m = state.time.year * 12 + state.time.month;
    if (m === lastMonth) return;
    lastMonth = m;
    if (rand() >= session) return;
    for (const card of [...state.docket]) {
      if ('surfacedMonth' in card && card.surfacedMonth == null) continue;
      if (!taken.has(card.id)) taken.set(card.id, rand() < attend);
      if (!taken.get(card.id)) continue;
      // Budgets are answered together, trimmed alike to the town's room.
      if (card.kind === 'budget') { trimAllToFit(state); continue; }
      const options = card.options ?? [];
      if (options.length && rand() < slip) {
        const o = options[Math.floor(rand() * options.length)];
        if (rule(state, card.id, o.key)?.ok) continue;
      }
      choose(state, card);
    }
  };
  play.engagement = {attend, session, slip};
  return play;
}

// How a council profile rules one card.
function chooser(profile, rand) {
  return (state, card) => {
    const options = card.options ?? [];
    const budget = profile.spendShare ?? 0.3;   // the most of the treasury one card may take
    const affordable = (o) => profile.reckless || (o.cost ?? card.cost ?? 0) <= budget * state.treasury;
    const later = options.filter((o) => /not_now|wait|later|hold|quiet/.test(o.key));
    const no = [...later, ...[...options].reverse()];
    const taste = profile.prefers ? tasteFor(profile, options) : null;
    let order;
    if (taste && taste.best.score > 0.2) order = [taste.best.option, ...no];
    else if (taste && taste.best.score < -0.2) order = no;
    else {
      const forming = String(card.templateId ?? '').startsWith('form:');
      const yes = rand() < (forming ? profile.acceptBodies : profile.accept) && (state.treasury > 0 || profile.reckless);
      order = yes ? options.filter(affordable) : no;
    }
    for (const o of order) if ((o === order[0] || affordable(o) || no.includes(o)) && rule(state, card.id, o.key)?.ok) break;
  };
}

// The best-liked option of a card: {best: {option, score}}. Scores are roughly -1..1.
function tasteFor(profile, options) {
  let best = {option: null, score: 0};
  let any = false;
  for (const o of options) {
    let score = 0, judged = false;
    for (const e of o.effects ?? []) {
      if (e.policy) {
        const deltas = POLICIES[e.policy]?.deltas ?? {};
        for (const [key, perLevel] of Object.entries(deltas)) {
          const w = profile.prefers[key];
          if (!w) continue;
          const d = Array.isArray(perLevel) ? perLevel[Math.max(0, Math.min(perLevel.length, e.level ?? 1) - 1)] : perLevel;
          score += w * d * 150;   // 0.004 a month ≈ 0.6 for a full liking
          judged = true;
        }
      }
      if (e.form) {
        score += (profile.bodies ?? []).includes(e.form) ? 1 : -0.1;
        judged = true;
      }
      if (e.build && (profile.builds ?? []).includes(e.build)) {
        score += 0.8;
        judged = true;
      }
    }
    if (!judged) continue;
    any = true;
    if (!best.option || score > best.score) best = {option: o, score};
  }
  return any ? {best} : null;
}

// ---------------------------------------------------------------------------
// Cache

function growAndRemember(name) {
  return fixtureText(growFixture(name));
}

// The save text kept in the cache: no walkers (re-drawn on load), no answer log.
export function fixtureText(state) {
  const people = state.people, answers = state.answerLog;
  state.people = [];
  state.answerLog = [];
  try {
    return serialize(state);
  } finally {
    state.people = people;
    state.answerLog = answers;
  }
}

function usable(text) {
  try {
    return restore(text).fixture?.version === FIXTURE_VERSION;
  } catch {
    return false;
  }
}

const cacheUrl = (name) => new URL(`./fixtures/${name}.json`, import.meta.url);   // the cached profiles: town, city

// Node only, synchronously, without importing node modules (keeps the browser build clean).
function readCache(name) {
  const fs = globalThis.process?.getBuiltinModule?.('fs');
  if (!fs) return null;
  try {
    const text = fs.readFileSync(cacheUrl(name), 'utf8');
    return usable(text) ? text : null;
  } catch {
    return null;
  }
}

// Re-draw walkers and let them set off, so a fresh fixture looks alive at once.
function wake(state, options) {
  if (options.settings) Object.assign(state.settings, options.settings);
  syncIndividuals(state);
  for (let i = 0; i < 30; i++) stepTick(state, 0.1);
  return state;
}
