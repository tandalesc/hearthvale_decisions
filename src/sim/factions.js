// Factions: the town's interest groups, derived yearly from households
// (design-systems §5.1). A faction is a trade (or the newcomers) plus a mood.
//
// state.factions[i] = {id, name, trades, size (people), households, mood 0..1,
//   lastMood, trend, split: bool, stances: {}, story: []}
//
// A faction torn between its trade and its street (or its purse) splits in two
// (design-systems §5.3): the parent keeps {splitInto, splitDim, splitValue} and
// two children `${id}:a` / `${id}:b` take its households. They merge back after
// ten calm years.

import {POLICIES, activePolicies} from './policies.js';
import {addChronicle} from './chronicle.js';

export const FACTIONS = [
  {id: 'farmers', name: 'Farmers', trades: ['farm']},
  {id: 'crafters', name: 'Makers', trades: ['craft']},
  {id: 'merchants', name: 'Merchants', trades: ['trade']},
  {id: 'labourers', name: 'Labourers', trades: ['labour', 'none']},
  {id: 'clergy', name: 'Clergy', trades: ['clergy']},
  {id: 'scholars', name: 'Clerks', trades: ['clerical']},
  {id: 'gentry', name: 'Gentry', trades: ['gentry']},
  {id: 'newcomers', name: 'Newcomers', trades: [], newcomer: true},
];

export const FACTION_IDS = FACTIONS.map((f) => f.id);

const BY_TRADE = {};
for (const f of FACTIONS) for (const t of f.trades) BY_TRADE[t] = f.id;

export const isNewcomer = (state, h) => h.newcomerUntil != null && h.newcomerUntil >= state.time.year;

const baseFactionOf = (state, h) => (isNewcomer(state, h) ? 'newcomers' : BY_TRADE[h.trade] ?? 'labourers');

export function factionOf(state, h) {
  const base = baseFactionOf(state, h);
  if (!state.factions?.some((f) => f.splitInto)) return base;
  const parent = state.factions.find((f) => f.id === base);
  if (!parent?.splitInto) return base;
  return splitValueOf(state, h, parent.splitDim) === parent.splitValue ? parent.splitInto[0] : parent.splitInto[1];
}

// The top-level faction (a split part answers for its parent in questions).
export const rootFaction = (state, id) => state.factions?.find((f) => f.id === id)?.parent ?? id;

// A faction, or its two parts if it has split.
export function factionGroup(state, id) {
  const f = factionById(state, id);
  if (!f) return [];
  return f.splitInto ? f.splitInto.map((c) => factionById(state, c)).filter(Boolean) : [f];
}

function splitValueOf(state, h, dim) {
  if (dim === 'district') return h.districtId;
  if (dim === 'centre') return h.centreId;
  const [t1, t2] = state.bands?.wealth ?? [60, 200];
  const w = h.wealth ?? h.savings ?? 0;
  return w < t1 ? 'poor' : w < t2 ? 'middling' : 'wealthy';
}

const WEALTH_NAMES = {poor: ['Poor', 'Better-off'], middling: ['Middling', 'Other'], wealthy: ['Wealthy', 'Humbler']};

export function splitFaction(state, id, dim, value) {
  const parent = factionById(state, id);
  if (!parent || parent.splitInto || parent.parent || id === 'newcomers') return null;
  const plural = parent.name.toLowerCase();
  let names;
  if (dim === 'district') {
    const d = state.districts?.find((x) => x.id === value);
    names = [`${d?.name ?? 'Riverside'} ${plural}`, `${parent.name} elsewhere`];
  } else if (dim === 'centre') {
    const c = state.centres?.find((x) => x.id === value);
    names = [`${c?.name ?? 'Valley'} ${plural}`, `${parent.name} of the old town`];
  } else {
    const [a, b] = WEALTH_NAMES[value] ?? ['Some', 'Other'];
    names = [`${a} ${plural}`, `${b} ${plural}`];
  }
  const kids = names.map((name, i) => ({
    id: `${id}:${'ab'[i]}`, parent: id, name, ...(dim === 'centre' && i === 0 ? {centreId: value} : {}), trades: [...parent.trades], size: 0, households: 0,
    mood: parent.mood, lastMood: parent.mood, trend: 0, split: false, stances: {}, story: [],
  }));
  Object.assign(parent, {splitInto: kids.map((k) => k.id), splitDim: dim, splitValue: value, splitYear: state.time.year, split: true});
  state.factions.push(...kids);
  countFactions(state);
  return kids;
}

export function mergeFaction(state, id) {
  const parent = factionById(state, id);
  if (!parent?.splitInto) return;
  const kids = factionGroup(state, id);
  const total = kids.reduce((n, k) => n + k.size, 0) || 1;
  parent.mood = kids.reduce((n, k) => n + k.mood * k.size, 0) / total;
  parent.mergedYear = state.time.year;
  state.factions = state.factions.filter((f) => f.parent !== id);
  Object.assign(parent, {splitInto: null, splitDim: null, splitValue: null, split: false});
  countFactions(state);
}

export const factionById = (state, id) => state.factions.find((f) => f.id === id) ?? null;

export function initFactions(state) {
  if (!state.factions?.length) {
    state.factions = FACTIONS.map((f) => ({id: f.id, name: f.name, trades: [...f.trades], size: 0, households: 0,
      mood: 0.6, lastMood: 0.6, trend: 0, split: false, stances: {}}));
  }
  for (const f of state.factions) {
    const def = FACTIONS.find((d) => d.id === (f.parent ?? f.id));
    f.name ??= def?.name ?? f.id;
    f.trades ??= [...(def?.trades ?? [])];
  }
  countFactions(state);
}

export function countFactions(state) {
  const size = {}, hh = {};
  for (const h of state.households) {
    const id = factionOf(state, h);
    size[id] = (size[id] ?? 0) + (h.size ?? 1);
    hh[id] = (hh[id] ?? 0) + 1;
  }
  for (const f of state.factions) {
    f.size = size[f.id] ?? 0;
    f.households = hh[f.id] ?? 0;
  }
}

// How the standing rules sit with a faction: +1 per rule that helps it, -1 per rule that hurts.
export function ruleBalance(state, faction) {
  let n = 0;
  for (const p of activePolicies(state)) {
    const def = POLICIES[p.id];
    if (def.helps?.some((t) => faction.trades.includes(t))) n += p.level;
    if (def.hurts?.some((t) => faction.trades.includes(t))) n -= p.level;
  }
  return n;
}

export function factionsYearly(state) {
  countFactions(state);
  const wellbeing = state.indicators?.wellbeing ?? 60;
  const year = state.time.year;
  for (const f of [...state.factions]) {
    const target = clamp01(0.5 + 0.06 * ruleBalance(state, f) + (wellbeing - 60) / 200 - (state.pressures?.unrest ?? 0) * 0.3);
    f.lastMood = f.mood;
    f.mood = clamp01(f.mood * 0.8 + target * 0.2);
    f.trend = Math.round((f.mood - f.lastMood) * 1000) / 1000;
    if (f.splitInto) {
      // Ten calm years and the two halves become one again.
      if (year - (f.lastTornYear ?? f.splitYear ?? year) >= 10) {
        mergeFaction(state, f.id);
        addChronicle(state, `The ${f.name.toLowerCase()} speak with one voice again.`, 'line', {faction: f.id, merged: true});
      }
    } else if (!f.parent) {
      const schism = state.governance?.flags?.[`split:${f.id}`];
      f.split = schism != null && year - schism < 10;
    }
    // Stances are per card; drop those for cards long gone.
    const live = new Set(state.docket.map((c) => c.id));
    for (const id of Object.keys(f.stances ?? {})) if (!live.has(id)) delete f.stances[id];
  }
}

// A short ring of what the faction did, for notes and summaries.
const STORY_RING = 8;
export function addFactionStory(state, factionId, kind, text = null) {
  for (const f of factionGroup(state, factionId)) addStoryTo(state, f, kind, text);
}

function addStoryTo(state, f, kind, text) {
  const story = (f.story ??= []);
  story.push({year: state.time.year, month: state.time.month, kind, ...(text ? {text} : {})});
  if (story.length > STORY_RING) story.shift();
}

export const moodBand = (mood) => (mood < 0.35 ? 'angry' : mood < 0.55 ? 'uneasy' : mood < 0.75 ? 'content' : 'glad');

const clamp01 = (x) => Math.max(0, Math.min(1, x));
