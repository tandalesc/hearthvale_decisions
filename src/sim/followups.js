// What came of a ruling (E2, "the feedback loop"). Two pieces, both template
// text with no model calls, so a town replays the same:
//
//   rulingReceipt(state, card, option, outcome): one line for the toast the
//     player sees as a ruling lands ("Approved: a summer fair. −250 coin.
//     Farmers are pleased.").
//   Follow-ups: a year and five years after you approve a request, the
//     chronicle says how the thing it was about has gone since (food for a
//     food plan, health for a health plan, the town's spirits otherwise).
//     Each line carries refs {card, followup: 1|5} back to the ruling.
//
// state.followups = [{card, subject, category, year, month, base, due: [m1, m5], done}]
// is written when docket.record() notes an accepted card, read by the docket's
// monthly pass, and saved with the town (serialize.js gives old saves an empty list).

import {monthIndex} from './clock.js';
import {addChronicle} from './chronicle.js';
import {capitalise, coin, joinList} from './text/voice.js';

export const FOLLOWUP_YEARS = [1, 5];
const KEEP = 400;                         // pending follow-ups at most (the oldest go)
const NO_FOLLOWUP = new Set(['event', 'report', 'budget']);

// How each area of a request is measured, and how its change reads.
// read(state) -> number; step: the change that counts; lower: a fall is better.
const MEASURES = {
  food: {read: (s) => s.indicators?.foodBalance ?? 0, step: 0.5,
    up: 'the stores are fuller', down: 'food is shorter than it was', flat: 'food is much as it was'},
  health: {read: (s) => s.pressures?.health ?? 0, step: 0.03,
    up: 'fewer people fall sick', down: 'more people fall sick', flat: 'health is much as it was'},
  education: {read: (s) => s.indicators?.literacy ?? 0, step: 0.02,
    up: 'more people can read', down: 'fewer people can read', flat: 'reading is much as it was'},
  environment: {read: (s) => s.pressures?.ecology ?? 0, step: 0.03,
    up: 'the land looks greener', down: 'the land has suffered', flat: 'the land is much as it was'},
  faith: {read: (s) => s.pressures?.faith ?? 0, step: 0.03,
    up: 'more people come to pray', down: 'fewer people come to pray', flat: 'the chapels are much as they were'},
  trade: {read: (s) => s.pressures?.riverTrade ?? 0, step: 0.03,
    up: 'more trade comes up the river', down: 'trade has slowed', flat: 'trade is much as it was'},
  labour: {read: (s) => s.indicators?.employment ?? 1, step: 0.02,
    up: 'more people have work', down: 'fewer people have work', flat: 'work is much as it was'},
  tax: {read: (s) => Math.round(s.treasury ?? 0), step: (base) => Math.max(50, 0.1 * Math.abs(base)),
    up: 'the chest is fuller', down: 'the chest is lighter', flat: 'the chest is much as it was'},
  land: {read: (s) => s.indicators?.housingPressure ?? 0, step: 0.02, lower: true,
    up: 'more families have a roof', down: 'more families lack a home', flat: 'homes are much as they were'},
  spirits: {read: (s) => s.indicators?.wellbeing ?? 60, step: 3,
    up: 'people are in better spirits', down: 'people are in lower spirits', flat: 'life goes on much as before'},
};
export const FOLLOWUP_PHRASES = Object.fromEntries(Object.entries(MEASURES).map(([k, m]) => [k, {up: m.up, down: m.down, flat: m.flat}]));
const measureOf = (category) => MEASURES[category] ?? MEASURES.spirits;
const LEAD = {1: 'A year on', 5: 'Five years on'};

// The plan you approved, as the chronicle names it: a debate by the side you
// backed, "Which first?" by the plan you chose, a petition by who brought it.
function subjectOf(state, card, option) {
  if (card.kind === 'debate') {
    const side = (card.data?.cards ?? []).find((c) => c.from === option?.side);
    if (side) return {title: side.title, category: side.category ?? card.category};
  }
  const batch = card.data?.batch;
  if (batch?.length === 2 && /^[xy]_/.test(option?.key ?? '')) {
    const mine = option.key[0] === 'x' ? batch[0] : batch[1];
    return {title: mine.title, category: mine.category ?? card.category};
  }
  if (card.kind === 'petition' && card.data?.faction && !card.data?.forms) {
    const ids = card.data.petitioners?.length ? card.data.petitioners.map((p) => p.faction) : [card.data.faction];
    const names = ids.map((id) => `the ${(state.factions ?? []).find((f) => f.id === id)?.name.toLowerCase() ?? id}`);
    return {heard: joinList(names), category: card.category};
  }
  return {title: card.title, category: card.category};
}

const cleanTitle = (t) => String(t ?? '').replace(/[?!.]+$/, '').trim();

// docket.record() calls this for every accepted card.
export function noteAccepted(state, card, option) {
  if (!card || NO_FOLLOWUP.has(card.kind) || card.data?.topUp) return;
  const list = (state.followups ??= []);
  if (list.some((f) => f.card === card.id)) return;
  const {title, heard, category} = subjectOf(state, card, option);
  const area = MEASURES[category] ? category : 'spirits';
  const m = monthIndex(state.time);
  list.push({
    card: card.id, title: title ? cleanTitle(title) : null, heard: heard ?? null, area,
    year: state.time.year, base: measureOf(area).read(state),
    due: FOLLOWUP_YEARS.map((y) => m + 12 * y), done: 0,
  });
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

// The follow-up line for one entry at stage i (0: a year on, 1: five years on).
export function followupText(state, f, i) {
  const measure = measureOf(f.area);
  const now = measure.read(state);
  const step = typeof measure.step === 'function' ? measure.step(f.base) : measure.step;
  let d = now - f.base;
  if (measure.lower) d = -d;
  const how = d >= step ? measure.up : d <= -step ? measure.down : measure.flat;
  const years = FOLLOWUP_YEARS[i];
  const first = f.heard ? `You heard ${f.heard} in year ${f.year}.` : `${capitalise(f.title)}, approved in year ${f.year}.`;
  return `${first} ${LEAD[years] ?? `${years} years on`}, ${how}.`;
}

// Month rollover: write the follow-ups that have come due, oldest first.
export function followupsMonthly(state) {
  const list = state.followups;
  if (!list?.length) return;
  const m = monthIndex(state.time);
  for (const f of list) {
    while (f.done < f.due.length && m >= f.due[f.done]) {
      addChronicle(state, followupText(state, f, f.done), 'line', {card: f.card, followup: FOLLOWUP_YEARS[f.done]});
      f.done++;
    }
  }
  state.followups = list.filter((f) => f.done < f.due.length);
}

// Registered for its defaults only: the monthly pass runs inside the docket's
// month (docket.docketMonthly), so no rollover job is added and the tick
// timing of every other system stays as it was.
export const followupsSystem = {
  id: 'followups',
  order: 30,
  init(state) { state.followups ??= []; },
  restore(state) { state.followups ??= []; },
};

// ---------------------------------------------------------------------------
// The ruling receipt
// ---------------------------------------------------------------------------

// Factions whose trades a card helps or hurts, by name ("Farmers", "Makers").
export function factionsFor(state, trades) {
  if (!trades?.length) return [];
  return (state.factions ?? []).filter((f) => f.trades?.some((t) => trades.includes(t))).map((f) => f.name);
}

// Faction names are plural ("Farmers", "Makers"): "Farmers and makers are pleased."
const WHO_FEELS = (names, verb) => {
  if (!names.length) return '';
  return `${joinList(names.map((n, i) => (i === 0 ? n : n.toLowerCase())))} ${verb}.`;
};

// One short line saying what a ruling did, or null (reports, budgets).
export function rulingReceipt(state, card, option, outcome) {
  if (!card || card.kind === 'report' || card.kind === 'budget') return null;
  const subject = subjectOf(state, card, option);
  const title = subject.title ? cleanTitle(subject.title).toLowerCase() : null;
  const helps = factionsFor(state, card.helps);
  const hurts = factionsFor(state, card.hurts).filter((n) => !helps.includes(n));
  const parts = [];
  if (outcome === 'accepted') {
    if (card.kind === 'event') parts.push(`Chosen: ${cleanTitle(option?.label ?? card.title).toLowerCase()}.`);
    else if (subject.heard) parts.push(`You heard ${subject.heard}.`);
    else parts.push(`Approved: ${title}.`);
    const cost = option?.cost ?? 0;
    if (cost > 0) parts.push(`−${coin(cost)}.`);
    if (card.kind !== 'event') {
      parts.push(WHO_FEELS(helps, 'are pleased'));
      parts.push(WHO_FEELS(hurts, 'grumble'));
    }
  } else if (outcome === 'refused') {
    parts.push(card.kind === 'debate' ? 'You backed neither side.' : `Refused: ${title ?? cleanTitle(card.title).toLowerCase()}.`);
    parts.push(WHO_FEELS(helps, 'are let down'));
  } else if (outcome === 'deferred') {
    parts.push(`Put off: ${title ?? cleanTitle(card.title).toLowerCase()}. They will ask again.`);
  } else if (outcome === 'negotiating') {
    parts.push('You offered to talk. They will give their answer soon.');
  } else {
    return null;
  }
  return parts.filter(Boolean).join(' ');
}
