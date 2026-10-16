// The Chronicle: entries as things happen, a short line at each year's end,
// and the end-of-chronicle page at year 150 (design-systems §9.4).
//
// Entries live in state.chronicle.entries (sim-core's emitChronicle keeps the
// cap). kind: 'line' | 'decision' | 'moment' | 'year'.

import {emitChronicle} from './state.js';
import {ARCHETYPE_NAMES, ERA_NAMES, count, capitalise, seasonOf} from './text/voice.js';

export const END_YEAR = 150;

// Every entry written here gets a stable id; entries from other modules get
// one derived from their content in selectChronicle.
export function addChronicle(state, text, kind = 'line', refs = undefined, extra = {}) {
  if (!text) return null;
  const g = (state.governance ??= {});
  const id = `ch${(g.nextChronicleId = (g.nextChronicleId ?? 0) + 1)}`;
  emitChronicle(state, {id, text, kind, ...(refs ? {refs} : {}), ...extra});
  return id;
}

const cleanText = (t, max) => (typeof t === 'string' && t.trim() ? t.replace(/[^\S ]+/g, ' ').trim().slice(0, max) : null);

// Narrator prose for a year line (cosmetic). Matches the 'year' entry written
// at that year's end (entry.year === year + 1), else the latest one.
export function setChronicleProse(state, {year, text, source} = {}) {
  const entries = state.chronicle?.entries ?? [];
  let entry = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'year') continue;
    entry ??= e;
    if (e.year === year + 1) { entry = e; break; }
  }
  const clean = cleanText(text, 300);
  if (!entry || !clean) return {ok: false, reason: 'no-entry'};
  entry.prose = {text: clean, source: cleanText(source, 40) ?? 'narrator'};
  entry.needsProse = false;
  return {ok: true, id: entry.id ?? null};
}

// Narrator prose for the end page (cosmetic).
export function setSummaryProse(state, {eras, closing, centres, source} = {}) {
  const summary = state.chronicle?.summary;
  if (!summary) return {ok: false, reason: 'no-summary'};
  const e = (Array.isArray(eras) ? eras : [])
    .filter((x) => Number.isInteger(x?.era) && x.era >= 0 && x.era <= 5 && cleanText(x.text, 400))
    .map((x) => ({era: x.era, text: cleanText(x.text, 400)}));
  const c = (Array.isArray(closing) ? closing : []).map((t) => cleanText(t, 200)).filter(Boolean).slice(0, 3);
  const known = new Set((summary.centres ?? []).map((x) => x.id));
  const per = (Array.isArray(centres) ? centres : [])
    .filter((x) => known.has(x?.id) && cleanText(x.text, 300))
    .map((x) => ({id: x.id, text: cleanText(x.text, 300)}));
  summary.prose = {eras: e, closing: c, centres: per, source: cleanText(source, 40) ?? 'narrator'};
  summary.needsProse = false;
  return {ok: true};
}

// Snapshot the numbers the year line compares against.
function yearSnapshot(state) {
  return {
    pop: state.indicators?.pop ?? 0,
    coin: Math.round(state.treasury ?? 0),
    food: state.indicators?.foodBalance ?? 0,
    rules: Object.values(state.policies ?? {}).filter((p) => p.level > 0).length,
    bodies: (state.institutions ?? []).filter((b) => b.status === 'active').length,
    wellbeing: state.indicators?.wellbeing ?? 60,
    unrest: state.pressures?.unrest ?? 0,
  };
}

// Called after the era check at each year end.
export function chronicleYearly(state) {
  const g = state.governance;
  const now = yearSnapshot(state);
  const before = g.yearStart ?? now;
  // The archetype arc and the trait compass path, for the end page.
  g.archetypeArc ??= [];
  if (g.archetypeArc.at(-1)?.archetype !== state.archetype) {
    g.archetypeArc.push({year: state.time.year, archetype: state.archetype});
  }
  g.traitPath ??= [];
  g.traitPath.push({year: state.time.year, ...roundAll(state.traits)});
  if (g.traitPath.length > END_YEAR + 5) g.traitPath.shift();

  addChronicle(state, yearLine(state, before, now), 'year', undefined, {needsProse: true});
  g.yearStart = now;
  if (state.time.year >= END_YEAR && !state.chronicle.summary) state.chronicle.summary = endSummary(state);
}

const roundAll = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));

function yearLine(state, a, b) {
  const parts = [`Year ${state.time.year - 1} ends.`];
  const dp = b.pop - a.pop;
  if (Math.abs(dp) >= Math.max(3, a.pop * 0.03)) {
    parts.push(dp > 0 ? `${capitalise(count(dp))} more people live here.` : `${capitalise(count(-dp))} fewer people live here.`);
  }
  if (b.food < 2) parts.push('Food is short.');
  else if (b.food > a.food + 3) parts.push('The stores are fuller.');
  if (b.rules > a.rules) parts.push(b.rules - a.rules === 1 ? 'One new rule stands.' : `${capitalise(count(b.rules - a.rules))} new rules stand.`);
  if (b.bodies > a.bodies) parts.push('A new body sits.');
  if (b.unrest > 0.4 && b.unrest > a.unrest) parts.push('People grow angry.');
  else if (b.wellbeing > a.wellbeing + 5) parts.push('People are in good spirits.');
  if (parts.length === 1) parts.push('A quiet year.');
  return parts.slice(0, 4).join(' ');
}

// Everything that happened in one year, for summaries written elsewhere (narrator).
export function chronicleYearFacts(state, year = state.time.year - 1) {
  const hist = state.indicatorHistory ?? {};
  const at = (key, y) => hist[key]?.[y] ?? null;
  const entries = (state.chronicle?.entries ?? []).filter((e) => e.year === year || (e.kind === 'year' && e.year === year + 1));
  return {
    year,
    era: state.era,
    archetype: state.archetype,
    people: {start: at('pop', Math.max(0, year - 1)), end: at('pop', year) ?? state.indicators?.pop ?? null},
    wellbeing: at('wellbeing', year),
    approval: (state.approval?.history ?? []).find((h) => h.y === year)?.all ?? null,
    entries: entries.map((e) => ({month: e.month ?? 0, kind: e.kind, text: e.text, refs: e.refs ?? null})),
    rulings: (state.cardHistory ?? []).filter((h) => h.year === year)
      .map((h) => ({title: h.title, from: h.from, kind: h.kind, choice: h.choice, label: h.label ?? null, outcome: h.outcome, stances: h.stances ?? {}})),
    events: Object.keys(state.tags ?? {}).filter((t) => t.startsWith('event:') && state.tags[t] === year).map((t) => t.slice(6)),
    rules: Object.entries(state.policies ?? {}).filter(([, p]) => p.level > 0 && p.since === year).map(([id]) => id),
    bodies: (state.institutions ?? []).filter((b) => b.foundedYear === year || b.dissolvedYear === year)
      .map((b) => ({id: b.id, name: b.name, change: b.dissolvedYear === year ? 'dissolved' : 'founded'})),
    factions: (state.factions ?? []).map((f) => ({id: f.id, name: f.name, mood: f.mood, trend: f.trend, story: (f.story ?? []).filter((x) => x.year === year)})),
  };
}

// ---------------------------------------------------------------------------
// End of chronicle
// ---------------------------------------------------------------------------

const band = (x, lo, hi) => (x < lo ? 0 : x < hi ? 1 : 2);

const BECAME = {
  'market-town': 'Hearthvale grew into a busy market town. Every road led to its square.',
  mill: 'Hearthvale became a mill town. Its chimneys could be seen for miles.',
  port: 'Hearthvale became a river port. Boats crowded its quays from dawn to dusk.',
  garden: 'Hearthvale became a garden town. Trees lined its streets and parks.',
  cathedral: 'Hearthvale became a cathedral town. Pilgrims came from across the land.',
  commune: 'Hearthvale stayed a town of commons. Neighbours shared the land and the work.',
  exchange: 'Hearthvale became a merchant town. Its exchange set prices for the valley.',
  scholar: 'Hearthvale became a town of scholars. Its colleges drew the curious.',
};

const FAIRNESS = [
  'Rich and poor lived close, and not far apart.',
  'Some grew rich and some stayed poor.',
  'A few families held most of the wealth. Many had little.',
];

const LAND = [
  'The river ran dark and the woods were gone.',
  'The land bore the marks of its growth.',
  'The river ran clear and the fields stayed green.',
];

export function endSummary(state) {
  const g = state.governance ?? {};
  const arc = g.archetypeArc ?? [{year: 0, archetype: state.archetype}];
  const ineq = band(state.indicators?.inequality ?? 0, 0.3, 0.5);
  const eco = band(state.pressures?.ecology ?? 0.5, 0.45, 0.75);
  const late = Object.keys(state.tags ?? {}).filter((t) => t.startsWith('era-late:')).length;
  const sentences = [
    BECAME[state.archetype] ?? BECAME['market-town'],
    FAIRNESS[ineq],
    LAND[eco],
  ];
  if (late) sentences.push('It was often behind its neighbours, but it endured.');
  const institutions = (state.institutions ?? []).map((b) => ({
    id: b.id, name: b.name, founded: b.foundedYear, status: b.status, dissolved: b.dissolvedYear ?? null,
  }));
  const refused = Object.keys(state.tags ?? {}).filter((t) => t.startsWith('refused:')).map((t) => t.slice(8));
  return {
    year: state.time.year,
    archetype: state.archetype,
    archetypeName: ARCHETYPE_NAMES[state.archetype] ?? state.archetype,
    era: state.era,
    eraName: ERA_NAMES[state.era] ?? '',
    arc: arc.map((a) => ({year: a.year, archetype: a.archetype, name: ARCHETYPE_NAMES[a.archetype] ?? a.archetype})),
    compass: g.traitPath ?? [],
    highlights: highlights(state, 12),
    institutions,
    refused,
    rules: Object.values(state.policies ?? {}).filter((p) => p.level > 0).length,
    people: state.indicators?.pop ?? 0,
    sentences,
    centres: centreRoll(state),
    needsProse: true,
    prose: null,
  };
}

// One line per centre of the valley, for the end page (and narrator).
const CENTRE_LINE = {
  merged: (c, into) => `${c.name} grew into ${into} and became part of it.`,
  federated: (c) => `${c.name} kept its own council inside the federation.`,
  apart: (c) => `${c.name} stayed proudly apart, ${ARCHETYPE_NAMES[c.character] ?? 'a town'} of its own.`,
};
function centreRoll(state) {
  const centres = state.centres ?? [];
  if (centres.length < 2) return [];
  return centres.map((c, i) => {
    const into = c.mergedInto != null ? centres.find((x) => x.id === c.mergedInto)?.name : null;
    const line = i === 0 ? `${c.name} remained the seat of the valley.`
      : into ? CENTRE_LINE.merged(c, into) : c.federated ? CENTRE_LINE.federated(c) : CENTRE_LINE.apart(c);
    return {id: c.id, name: c.name, kind: c.kind, pop: c.monthly?.pop ?? c.pop ?? 0, character: c.character, founded: c.founded,
      autonomy: c.autonomy ?? 0, mergedInto: c.mergedInto ?? null, federated: !!c.federated, line};
  });
}

// A preview for the Metropolis era: "How will the chronicle read?"
export const previewSummary = (state) => endSummary(state);

function highlights(state, n) {
  const entries = state.chronicle?.entries ?? [];
  const picked = entries.filter((e) => e.kind === 'moment' || (e.kind === 'decision' && e.refs?.event) ||
    (e.kind === 'line' && e.refs?.event));
  if (picked.length <= n) return picked.map(slim);
  // Spread the picks across the whole story.
  const step = picked.length / n;
  return Array.from({length: n}, (_, i) => slim(picked[Math.floor(i * step)]));
}

const slim = (e) => ({year: e.year, text: e.text, kind: e.kind, season: seasonOf(e.month ?? 0)});

