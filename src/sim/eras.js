// Eras: condition-gated with a time floor and a time ceiling, checked yearly.
// A town that stalls still moves on at the ceiling, tagged era-late:<n>.

import {holds, makeCtx, evalCond, explainCond} from './conditions.js';
import {emitChronicle, setTag, touchBuilding} from './state.js';
import {rng} from './rng.js';
import {addBuildingStory} from './buildings.js';

export const STYLE_PACKS = ['hearth', 'stone', 'guild', 'terrace', 'civic', 'glass'];

export const ERA = [
  {
    name: 'Hamlet', floor: 0, ceiling: null, checks: [],
    maxHomeTier: 1, maxStoreys: 1, materials: ['timber', 'thatch'], roadTier: {organic: 2, planned: 2},
    ui: ['chronicle', 'docket'], cardsPerYear: [1, 2],
  },
  {
    name: 'Village', floor: 6, ceiling: 15,
    checks: [
      {label: 'At least 120 people', expr: ['gte', 'I.pop', 120]},
      {label: 'At least one body', expr: ['gte', 'C.institutions', 1]},
    ],
    maxHomeTier: 2, maxStoreys: 2, materials: ['timber', 'tile'], roadTier: {organic: 3, planned: 3},
    ui: ['rulebook', 'people'], cardsPerYear: [2, 3],
    arrival: 'Hearthvale is a village now. Houses can rise to two storeys. The paths are turning into tracks.',
  },
  {
    name: 'Town', floor: 25, ceiling: 45,
    checks: [
      {label: 'At least 450 people', expr: ['gte', 'I.pop', 450]},
      {label: 'At least three bodies', expr: ['gte', 'C.institutions', 3]},
      {label: 'Forty stretches of real road', expr: ['gte', 'C.roads3', 40]},
    ],
    maxHomeTier: 3, maxStoreys: 3, materials: ['brick', 'tile'], roadTier: {organic: 3, planned: 4},
    ui: ['bodies', 'overlays'], cardsPerYear: [3, 3],
    arrival: 'Hearthvale is a town now. Brick houses can rise to three storeys. The busiest roads can be paved.',
  },
  {
    name: 'Borough', floor: 55, ceiling: 80,
    checks: [
      {label: 'At least 1,200 people', expr: ['gte', 'I.pop', 1200]},
      {label: 'Better homes on average', expr: ['gte', 'I.avgHomeTier', 2.2]},
      {
        // Something the town is known for. (Wider than the spec's river trade, industry
        // or fame, so every kind of town can earn its charter.)
        label: 'Known for trade, industry, fame, faith or learning',
        expr: ['or', ['gte', 'P.riverTrade', 0.3], ['gte', 'T.industry', 0.25], ['gte', 'P.prestige', 0.3],
          ['gte', 'P.faith', 0.45], ['gte', 'P.learning', 0.3], ['gte', 'T.market', 0.3], ['gte', 'P.ecology', 0.85]],
      },
    ],
    maxHomeTier: 4, maxStoreys: 4, materials: ['brick', 'stone', 'slate'], roadTier: {organic: 3, planned: 4},
    ui: ['debates', 'delegation', 'tensions'], cardsPerYear: [3, 4],
    arrival: 'Hearthvale is a borough now. Houses can rise to four storeys. Bodies can run their own affairs.',
  },
  {
    name: 'City', floor: 90, ceiling: 115,
    checks: [
      {label: 'At least 3,000 people', expr: ['gte', 'I.pop', 3000]},
      {label: 'At least six bodies', expr: ['gte', 'C.institutions', 6]},
      {label: 'At least ten rules in force', expr: ['gte', 'C.policies', 10]},
    ],
    maxHomeTier: 5, maxStoreys: 6, materials: ['stone', 'iron', 'glass'], roadTier: {organic: 3, planned: 5},
    ui: ['budget', 'tensions-dashboard', 'compass'], cardsPerYear: [4, 4],
    arrival: 'Hearthvale is a city now. Apartment blocks can rise to six storeys. Wide avenues can be laid out.',
  },
  {
    name: 'Metropolis', floor: 125, ceiling: 140,
    checks: [
      {label: 'At least 6,000 people', expr: ['gte', 'I.pop', 6000]},
      {label: 'Fine homes on average', expr: ['gte', 'I.avgHomeTier', 3.5]},
      {label: 'Good public health', expr: ['gte', 'P.health', 0.5]},
    ],
    maxHomeTier: 5, maxStoreys: 9, materials: ['concrete', 'steel', 'glass'], roadTier: {organic: 3, planned: 5},
    ui: ['end-preview'], cardsPerYear: [4, 4],
    arrival: 'Hearthvale is a great city now. Towers can rise to nine storeys. The chronicle nears its end.',
  },
];

export const LATE_ARRIVAL = 'The town moves into a new age, but it is behind its neighbours.';

export const eraCondition = (n) => (ERA[n]?.checks.length ? ['and', ...ERA[n].checks.map((c) => c.expr)] : true);

// Yearly. Returns the new era index if the town moved on, else null.
export function checkEra(state) {
  const next = state.era + 1;
  const def = ERA[next];
  if (!def || state.time.year < def.floor) return null;
  const met = holds(eraCondition(next), makeCtx(state));
  if (!met && state.time.year < def.ceiling) return null;
  enterEra(state, next, !met);
  return next;
}

export function enterEra(state, n, late = false) {
  state.era = n;
  state.eraEntered[n] = state.time.year;
  setTag(state, `era:${n}`);
  if (late) setTag(state, `era-late:${n}`);
  const text = late ? `${LATE_ARRIVAL} ${ERA[n].arrival}` : ERA[n].arrival;
  emitChronicle(state, {kind: 'moment', text, refs: {era: n, late}});
  scheduleRestyle(state);
}

// On a new era, about 20% of buildings (wealthier ones first) take the new style over
// the next five years. Same tier, new materials.
function scheduleRestyle(state) {
  const year = state.time.year;
  for (const b of state.buildings) {
    if (b.type === 'farm' || b.type === 'park' || b.built < 1 || b.styleEra >= state.era) continue;
    if (rng(state) < 0.1 + 0.2 * (b.wealth ?? 0.3)) b.restyleAt = year + 1 + Math.floor(rng(state) * 5);
  }
}

// Yearly: apply restyles that are due. A restyled building wears scaffold for a year.
export function applyRestyles(state) {
  const year = state.time.year;
  for (const b of state.buildings) {
    if (b.scaffoldUntil != null && b.scaffoldUntil <= year) {
      b.scaffoldUntil = null;
      if (b.built >= 1) delete b.flags.scaffold;
      touchBuilding(state, b);
    }
    if (b.restyleAt == null || b.restyleAt > year) continue;
    b.restyleAt = null;
    b.styleEra = state.era;
    b.material = materialFor(state.era, b.type);
    b.flags.scaffold = 1;
    b.scaffoldUntil = year + 1;
    addBuildingStory(state, b, 'restyled');
    touchBuilding(state, b);
  }
}

export function materialFor(era, type) {
  const mats = ERA[Math.max(0, Math.min(5, era))].materials;
  if (type === 'home' && era === 0) return 'thatch';
  return mats[0];
}

// For the UI's era panel: one row per check of the next era.
export function eraProgress(state) {
  const next = state.era + 1;
  const def = ERA[next];
  if (!def) return {next: null, name: null, checks: []};
  const ctx = makeCtx(state);
  return {
    next,
    name: def.name,
    floor: def.floor,
    ceiling: def.ceiling,
    yearsToFloor: Math.max(0, def.floor - state.time.year),
    yearsToCeiling: Math.max(0, def.ceiling - state.time.year),
    checks: def.checks.map((c) => {
      const info = explainCond(c.expr, ctx);
      return {label: c.label, met: evalCond(c.expr, ctx) >= 1, progress: info.progress ?? info.value};
    }),
  };
}
