// View models for the UI (contract §5). Pure functions of state: they read,
// never write. The UI calls them (throttled for heavy panels) and renders.

import {monthIndex} from './clock.js';
import {eraProgress, ERA} from './eras.js';
import {
  POLICIES, CATEGORIES, CATEGORY_ERA, levelOf, againstGrain, upkeepFor, detectTensions, tensionText,
} from './policies.js';
import {INSTITUTIONS, METRICS, canDelegate} from './institutions.js';
import {EVENTS} from './events.js';
import {ERA_NAMES, ARCHETYPE_NAMES, seasonOf, coin} from './text/voice.js';
import {previewSummary} from './chronicle.js';
import {seedCode} from './state.js';

const pct = (x) => Math.round((x ?? 0) * 100);
const r1 = (x) => Math.round((x ?? 0) * 10) / 10;

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export function selectTopBar(state) {
  const I = state.indicators ?? {};
  const history = state.indicatorHistory?.treasury ?? [];
  const lastYear = state.economy?.lastYear ?? {};
  const coinTrend = Math.round((lastYear.treasuryIncome ?? 0) - (lastYear.treasurySpend ?? 0)) ||
    (history.length >= 2 ? Math.round(history.at(-1) - history.at(-2)) : 0);
  return {
    year: state.time.year,
    month: state.time.month,
    season: seasonOf(state.time.month),
    era: state.era ?? 0,
    eraName: ERA_NAMES[state.era ?? 0],
    people: I.pop ?? 0,
    coin: Math.round(state.treasury ?? 0),
    coinTrend,
    food: Math.round(state.food ?? 0),
    foodMonths: r1(I.foodBalance),
    wellbeing: Math.round(I.wellbeing ?? 0),
    archetype: state.archetype,
    archetypeName: ARCHETYPE_NAMES[state.archetype] ?? state.archetype,
    homes: homesOf(state),
    homesWaiting: (state.households ?? []).filter((h) => h.homeId == null).length,
    seed: seedCode(state.seed),
  };
}

const homesOf = (state) => (state.buildings ?? []).reduce((n, b) => n + (b.type === 'home' && (b.built ?? 1) >= 1 ? 1 : 0), 0);

// ---------------------------------------------------------------------------
// Docket
// ---------------------------------------------------------------------------

const STANCE_DIR = {for: 2, against: -2, split: 0, indifferent: 0};
const NO_REACTION = new Set(['not_now', 'refuse', 'neither', 'ok', 'negotiate']);

const factionName = (state, id) => state.factions?.find((f) => f.id === id)?.name ?? id;
const bodyName = (state, id) => state.institutions?.find((b) => b.id === id)?.name ?? INSTITUTIONS[id]?.name ?? 'The Moot';

// Faction chips for one option, from the stances cached on the card. In a
// debate each side's option shows how the factions felt about that side's plan.
function reactionsFor(state, card, option) {
  if (NO_REACTION.has(option.key) || card.kind === 'report') return [];
  const stances = (option.side && card.data?.sideStances?.[option.side]) || card.stances || {};
  const rows = Object.entries(stances)
    .map(([faction, s]) => {
      let dir = STANCE_DIR[s.stance] ?? 0;
      if (dir && (s.p ?? 0) < 0.6) dir = Math.sign(dir);
      return {faction, name: factionName(state, faction), dir, stance: s.stance, p: s.p ?? 0};
    })
    .filter((r) => r.dir !== 0 || r.stance === 'split')
    .sort((a, b) => Math.abs(b.dir) - Math.abs(a.dir) || b.p - a.p || a.faction.localeCompare(b.faction));
  return rows.slice(0, 3);
}

function debateStrip(state, card) {
  const rows = Object.entries(card.stances ?? {}).map(([faction, s]) => ({faction, name: factionName(state, faction), ...s}));
  const split = new Set(state.factions?.filter((f) => f.split).map((f) => f.id));
  return {
    for: rows.filter((r) => r.stance === 'for').sort((a, b) => b.p - a.p).slice(0, 3).map((r) => ({faction: r.faction, name: r.name, p: r.p, split: split.has(r.faction)})),
    against: rows.filter((r) => r.stance === 'against').sort((a, b) => b.p - a.p).slice(0, 3).map((r) => ({faction: r.faction, name: r.name, p: r.p, split: split.has(r.faction)})),
    split: rows.filter((r) => r.stance === 'split').map((r) => r.faction),
  };
}

export function cardView(state, card) {
  const m = monthIndex(state.time);
  const expiresInMonths = card.expiresMonth != null ? Math.max(0, card.expiresMonth - m) : null;
  return {
    id: card.id,
    kind: card.kind,
    from: card.from,
    institution: card.from,
    institutionName: bodyName(state, card.from),
    templateId: card.templateId,
    category: card.category,
    title: card.title,
    why: card.prose?.why ?? card.why,
    templateWhy: card.why,
    prose: card.prose ?? null,
    needsProse: !!card.needsProse,
    asker: card.asker,
    urgency: card.urgency ?? 0,
    cost: card.cost ?? 0,
    upkeep: card.upkeep ?? 0,
    againstGrain: !!card.againstGrain,
    grainNote: card.againstGrain ? 'This goes against the grain of the town. It will cost more and people will grumble.' : null,
    negotiating: !!card.negotiating,
    options: card.options.map((o) => ({
      key: o.key,
      label: o.label,
      tradeoff: card.prose?.options?.[o.key] ?? o.tradeoff,
      templateTradeoff: o.tradeoff,
      cost: o.cost ?? 0,
      ...(o.upkeep ? {upkeep: o.upkeep} : {}),
      affordable: !(o.cost > 0) || (state.treasury ?? 0) >= o.cost || o.key === 'delegate',
      reactions: reactionsFor(state, card, o),
    })),
    details: card.details ?? [],
    debate: card.kind === 'debate' || Object.keys(card.stances ?? {}).length ? debateStrip(state, card) : null,
    sides: card.data?.sides ?? null,
    expiresInMonths,
    deadlineYear: card.expiresMonth != null ? Math.floor(card.expiresMonth / 12) : null,
    place: card.data?.x != null ? {x: card.data.x, z: card.data.z} : null,
  };
}

const KIND_ORDER = {event: 0, demand: 1, petition: 2, debate: 3, proposal: 4, report: 5};

// The cards awaiting a ruling (surfaced by a session), most urgent first.
export function selectDocket(state) {
  // A demand waiting on the body's answer to an offer stays off the table.
  return state.docket
    .filter((c) => c.surfacedMonth != null && !c.negotiating)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.urgency ?? 0) - (a.urgency ?? 0) ||
      (a.expiresMonth ?? 0) - (b.expiresMonth ?? 0) || a.id.localeCompare(b.id))
    .map((c) => cardView(state, c));
}

export const selectDocketCount = (state) => state.docket.filter((c) => c.surfacedMonth != null && c.kind !== 'report').length;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function metricRows(state, body) {
  const def = INSTITUTIONS[body.kind];
  return (def?.metrics ?? []).slice(0, 6).map((id) => {
    const m = METRICS[id];
    const series = Array.isArray(body.metrics?.[id]) ? body.metrics[id].slice(-60) : [];
    const value = body.status === 'waning' && series.length ? series.at(-1) : m.read(state);
    const prev = series.length >= 5 ? series.at(-5) : series[0] ?? value;
    return {id, label: m.label, unit: m.unit, value, series, delta: Math.round((value - prev) * 100) / 100};
  });
}

function bodyRules(state, body) {
  return Object.entries(state.policies ?? {})
    .filter(([id, p]) => p.level > 0 && POLICIES[id] && (p.by === body.id || (POLICIES[id].by?.includes(body.kind) && body.kind !== 'moot')))
    .map(([id, p]) => ({id, title: POLICIES[id].title, summary: POLICIES[id].summary, level: p.level, since: p.since}));
}

export function selectBodies(state) {
  return (state.institutions ?? [])
    .filter((b) => b.status !== 'dissolved')
    .map((b) => {
      const def = INSTITUTIONS[b.kind] ?? {};
      const docket = state.docket.filter((c) => c.surfacedMonth != null && (c.from === b.id || c.data?.sides?.includes(b.id)));
      const rules = bodyRules(state, b);
      return {
        id: b.id,
        kind: b.kind,
        name: b.name,
        icon: def.icon ?? 'hall',
        founded: b.foundedYear,
        status: b.status,
        power: Math.round((b.power ?? 0) * 100) / 100,
        patience: Math.round((b.patience ?? 0) * 100) / 100,
        demanding: (b.power ?? 0) >= 0.7 && b.kind !== 'moot',
        delegated: !!b.delegated,
        delegateCap: b.delegateCap ?? 0,
        canDelegate: canDelegate(state, b),
        budgetShare: b.budgetShare ?? 0,
        funds: Math.round(b.funds ?? 0),
        asker: b.asker,
        explainer: def.explainer ?? '',
        metrics: metricRows(state, b),
        docket: docket.map((c) => cardView(state, c)),
        docketCount: docket.filter((c) => c.kind !== 'report').length,
        rules,
        policies: rules,
        standingOrders: b.standingOrders ?? [],
        rivals: def.rivals ?? [],
      };
    });
}

// ---------------------------------------------------------------------------
// The Rule Book
// ---------------------------------------------------------------------------

export function selectRuleBook(state) {
  const tensions = detectTensions(state);
  const era = state.era ?? 0;
  return CATEGORIES.map((cat) => ({
    id: cat.id,
    title: cat.title,
    blurb: cat.blurb,
    // A category opens with its era, or as soon as any of its rules is in
    // force, since a rule adopted early must still be visible in the book.
    open: era >= (CATEGORY_ERA[cat.id] ?? 0)
      || Object.values(POLICIES).some((p) => p.category === cat.id && levelOf(state, p.id) > 0),
    policies: Object.values(POLICIES)
      .filter((p) => p.category === cat.id)
      .map((p) => {
        const rec = state.policies?.[p.id];
        const level = levelOf(state, p.id);
        return {
          id: p.id,
          title: p.title,
          summary: p.summary,
          level,
          maxLevel: p.maxLevel,
          levelName: level > 0 ? p.levelNames[level - 1] : null,
          since: rec?.since ?? null,
          by: rec?.by ?? null,
          byName: rec?.by && rec.by !== 'player' ? bodyName(state, rec.by) : null,
          upkeep: level > 0 ? upkeepFor(state, p.id, level) : 0,
          tensions: tensions.filter((t) => t.left === p.id || t.right === p.id).map((t) => (t.left === p.id ? t.right : t.left)),
          againstGrain: level > 0 && againstGrain(state, p.id, level).against,
        };
      }),
  }));
}

// ---------------------------------------------------------------------------
// Tensions: rules that pull against each other, and torn streets
// ---------------------------------------------------------------------------

function backers(state, policyId) {
  const def = POLICIES[policyId];
  return (state.factions ?? []).filter((f) => f.size > 0 && def.helps?.some((t) => f.trades?.includes(t))).map((f) => f.name);
}

const DIM_WORDS = {
  wealthBand: {poor: 'Poor', middling: 'Middling', wealthy: 'Wealthy'},
  trade: {farm: 'farm', craft: 'maker', trade: 'merchant', labour: 'labouring', clerical: 'clerk', clergy: 'clergy', gentry: 'gentry', none: 'idle'},
  lifeStage: {young: 'young', family: 'family', elder: 'elderly'},
};

function tornText(key) {
  const parts = Object.fromEntries(key.split('|').map((p) => p.split('=')));
  const who = [parts.wealthBand && DIM_WORDS.wealthBand[parts.wealthBand], parts.trade && DIM_WORDS.trade[parts.trade],
    parts.lifeStage && DIM_WORDS.lifeStage[parts.lifeStage], 'families'].filter(Boolean).join(' ');
  const where = parts.district ? ` in ${parts.district}` : '';
  const first = who.charAt(0).toUpperCase() + who.slice(1);
  const dims = Object.keys(parts);
  const a = dims[0] === 'district' ? 'street' : dims[0] === 'wealthBand' ? 'purse' : dims[0];
  const b = dims[1] === 'district' ? 'street' : dims[1] === 'wealthBand' ? 'purse' : dims[1];
  return `${first}${where} are torn. Their ${a} and their ${b} point different ways.`;
}

export function selectTensions(state) {
  const rules = detectTensions(state).map((t) => ({
    id: t.id,
    type: 'rules',
    reason: t.why,
    left: {id: t.left, title: POLICIES[t.left].title, backers: backers(state, t.left)},
    right: {id: t.right, title: POLICIES[t.right].title, backers: backers(state, t.right)},
    text: tensionText(t),
    upkeep: upkeepFor(state, t.left) + upkeepFor(state, t.right),
  }));
  const torn = [];
  for (const [kind, rows] of Object.entries(state.disagreement ?? {})) {
    for (const [key, row] of Object.entries(rows)) {
      if (row.D < 0.25) continue;
      torn.push({id: `${kind}:${key}`, type: 'torn', kind, key, D: row.D, n: row.n, text: tornText(key)});
    }
  }
  torn.sort((a, b) => b.D * b.n - a.D * a.n || a.id.localeCompare(b.id));
  return {rules, torn: torn.slice(0, 5), tension: state.indicators?.tension ?? 0};
}

// ---------------------------------------------------------------------------
// Factions, chronicle, era progress
// ---------------------------------------------------------------------------

export function selectFactions(state) {
  return (state.factions ?? [])
    .filter((f) => f.size > 0)
    .map((f) => ({id: f.id, name: f.name, size: f.size, households: f.households ?? 0,
      mood: Math.round((f.mood ?? 0) * 100) / 100, trend: f.trend ?? 0, split: !!f.split,
      parent: f.parent ?? null, parentName: f.parent ? factionName(state, f.parent) : null}))
    .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
}

export function selectChronicle(state, {limit = 60, kinds = null} = {}) {
  const entries = state.chronicle?.entries ?? [];
  const out = [];
  const ids = entryIds(entries);
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (kinds && !kinds.includes(e.kind)) continue;
    out.push({id: ids[i], year: e.year, month: e.month ?? 0, season: seasonOf(e.month ?? 0),
      text: e.prose?.text ?? e.text, templateText: e.text, needsProse: !!e.needsProse,
      kind: e.kind === 'year' ? 'line' : e.kind, era: e.era ?? 0, yearEnd: e.kind === 'year',
      refs: e.refs ?? null, centreId: e.refs?.centreId ?? e.refs?.centre ?? null,
      centreName: centreNameOf(state, e.refs?.centreId ?? e.refs?.centre)});
  }
  return out.reverse();
}

const centreNameOf = (state, id) => (id == null ? null : (state.centres ?? []).find((c) => c.id === id)?.name ?? null);

// Ids for entries written without one: a content hash, with a count when the
// same line appears twice in a month. Cached per entries array and length.
const idCache = new WeakMap();
function entryIds(entries) {
  const cached = idCache.get(entries);
  if (cached?.length === entries.length && cached.first === entries[0]) return cached.ids;
  const seen = new Map();
  const ids = entries.map((e) => {
    if (e.id) return e.id;
    let h = 2166136261;
    const t = `${e.year}:${e.month}:${e.kind}:${e.text}`;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
    const base = `cx${h.toString(36)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  });
  idCache.set(entries, {length: entries.length, first: entries[0], ids});
  return ids;
}

export function selectEraProgress(state) {
  const p = eraProgress(state);
  const def = ERA[state.era ?? 0];
  const entered = state.eraEntered?.[state.era ?? 0] ?? 0;
  const span = p.next != null && p.ceiling != null ? Math.max(1, p.ceiling - entered) : 1;
  return {
    era: state.era ?? 0,
    eraName: def?.name ?? ERA_NAMES[state.era ?? 0],
    next: p.next,
    nextName: p.name,
    yearsToFloor: p.yearsToFloor ?? 0,
    yearsToCeiling: p.yearsToCeiling ?? 0,
    yearT: p.next != null ? Math.max(0, Math.min(1, (state.time.year - entered) / span)) : 1,
    conditions: (p.checks ?? []).map((c) => ({label: c.label, met: !!c.met, progress: Math.round(Math.max(0, Math.min(1, c.progress ?? 0)) * 100) / 100})),
  };
}

// The valley's centres for the Places view (design-centres §7).
const CENTRE_KIND_NAMES = {hamlet: 'hamlet', village: 'village', town: 'town', borough: 'borough', city: 'city'};
export function selectCentres(state) {
  const centres = state.centres ?? [];
  const live = centres.filter((c) => c.mergedInto == null);
  const rows = centres.map((c, i) => {
    const ward = (state.institutions ?? []).find((b) => b.kind === 'ward' && b.centreId === c.id && b.status !== 'dissolved');
    return {
      id: c.id, name: c.name, kind: CENTRE_KIND_NAMES[c.kind] ?? 'hamlet', seat: i === 0,
      pop: c.monthly?.pop ?? c.pop ?? 0, popSeries: (c.popSeries ?? c.history?.pop ?? []).slice(-60),
      character: c.character ?? state.archetype, characterName: ARCHETYPE_NAMES[c.character ?? state.archetype] ?? c.character,
      autonomy: c.autonomy ?? 0, rank: c.rank ?? i + 1, x: c.x, z: c.z,
      bodyId: ward?.id ?? null, mergedInto: c.mergedInto ?? null, federated: !!c.federated,
    };
  });
  return {region: {people: state.indicators?.pop ?? 0, centres: live.length}, centres: rows};
}

// Which surfaces the UI shows (design-systems §2 'UI surfaces', §9.2).
export function selectUnlocks(state) {
  const era = state.era ?? 0;
  const bodies = (state.institutions ?? []).filter((b) => b.status === 'active').length;
  return {
    chronicle: true,
    docket: true,
    ruleBook: era >= 1 || Object.keys(state.policies ?? {}).length > 1,
    ruleCategories: CATEGORIES.filter((c) => era >= (CATEGORY_ERA[c.id] ?? 0)).map((c) => c.id),
    people: era >= 1,
    bodies: era >= 2 || bodies >= 2,
    bodyTabs: bodies >= 2,
    overlays: era >= 2,
    debates: era >= 3 || state.docket.some((c) => c.kind === 'debate'),
    delegation: era >= 3 || (state.institutions ?? []).some((b) => canDelegate(state, b)),
    standingOrders: era >= 3,
    tensions: era >= 3,
    tensionsDashboard: era >= 4,
    budget: era >= 4,
    compass: era >= 4,
    endPreview: era >= 5 || state.time.year >= 140,
    endPage: !!state.chronicle?.summary,
    places: (state.centres ?? []).filter((c) => c.mergedInto == null).length >= 2,
  };
}

// ---------------------------------------------------------------------------
// Inspect a building or a person
// ---------------------------------------------------------------------------

const TYPE_NAMES = {
  home: 'Home', farm: 'Farm', workshop: 'Workshop', mill: 'Mill', shop: 'Shop', market: 'Market', inn: 'Inn',
  warehouse: 'Warehouse', chapel: 'Chapel', school: 'School', moot: 'Moot hall', park: 'Park', infirmary: 'Infirmary',
  watch: 'Watch house', exchange: 'Exchange', theatre: 'Playhouse', factory: 'Factory', quay: 'Quay', bridge: 'Bridge',
  monument: 'Monument', 'union-hall': 'Union hall', library: 'Library', bathhouse: 'Bathhouse',
};

const conditionWord = (c) => (c >= 0.8 ? 'Well kept' : c >= 0.5 ? 'Worn' : c >= 0.25 ? 'Shabby' : 'Falling down');
const TASK_WORDS = {work: 'Working', rest: 'Resting', shop: 'Shopping', leisure: 'Taking it easy', worship: 'At prayer',
  gather: 'In the crowd', build: 'Building', flee: 'Fleeing', travel: 'On the road'};

export function selectInspect(state, {buildingId, personId} = {}) {
  if (buildingId != null) {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b) return null;
    const owner = b.ownerHouseholdId != null ? state.households.find((h) => h.id === b.ownerHouseholdId) : null;
    const residents = state.households.filter((h) => h.homeId === b.id);
    const ent = state.enterprises.find((e) => e.buildingId === b.id);
    const district = state.districts?.find((d) => d.id === b.districtId);
    const rows = [
      {label: 'Built', value: b.built >= 1 ? `${Math.round(b.age ?? 0)} years ago` : `${Math.round((b.built ?? 0) * 100)} in 100 done`},
      {label: 'State', value: conditionWord(b.condition ?? 1)},
    ];
    if (residents.length) rows.push({label: 'Lives here', value: `${residents.reduce((n, h) => n + h.size, 0)} people`});
    if (ent) rows.push({label: 'Work', value: `${ent.filled ?? 0} of ${ent.jobs} jobs filled`});
    if (owner) rows.push({label: 'Owner', value: `A ${owner.trade === 'none' ? 'family' : `${owner.trade} family`}`});
    if (district) rows.push({label: 'Quarter', value: district.name});
    return {
      kind: 'building', id: b.id, type: b.type, title: TYPE_NAMES[b.type] ?? b.type, variant: b.variant,
      tier: b.tier, storeys: b.storeys, rows: rows.slice(0, 6), banner: b.banner ?? null,
      flags: b.flags ?? {}, x: b.x, z: b.z,
    };
  }
  if (personId != null) {
    const p = state.people.find((x) => x.id === personId);
    if (!p) return null;
    const h = state.households.find((x) => x.id === p.householdId);
    const faction = h ? state.factions.find((f) => f.trades?.includes(h.trade)) : null;
    const task = typeof p.task === 'string' ? p.task : p.task?.kind;
    return {
      kind: 'person', id: p.id, title: h ? `A ${h.trade === 'none' ? 'neighbour' : `${h.trade} worker`}` : 'A neighbour',
      rows: [
        {label: 'Doing', value: TASK_WORDS[task] ?? 'Walking'},
        ...(h ? [{label: 'Household', value: `${h.size} people`}, {label: 'Savings', value: coin(h.savings ?? 0)}] : []),
        ...(faction ? [{label: 'Mood of their kind', value: moodWord(faction.mood)}] : []),
      ],
      needs: p.needs ?? null, x: p.x, z: p.z,
    };
  }
  return null;
}

const moodWord = (m) => (m < 0.35 ? 'Angry' : m < 0.55 ? 'Uneasy' : m < 0.75 ? 'Content' : 'Glad');

// ---------------------------------------------------------------------------
// Extras for later eras
// ---------------------------------------------------------------------------

// The four-axis compass (era 4+): today's traits and the path so far.
export function selectCompass(state) {
  return {now: {...state.traits}, path: state.governance?.traitPath ?? []};
}

// Budget sheet (era 4+): last year's money in and out, by account.
export function selectBudget(state) {
  const ly = state.economy?.lastYear ?? {};
  return {
    income: {tax: Math.round(state.budget?.income?.tax ?? 0), tolls: Math.round(state.budget?.income?.tolls ?? 0), total: Math.round(ly.treasuryIncome ?? 0)},
    spend: {
      rules: Math.round(state.budget?.spend?.policies ?? 0),
      bodies: Object.entries(state.budget?.spend?.bodies ?? {}).map(([id, n]) => ({id, name: bodyName(state, id), coin: Math.round(n)})),
      total: Math.round(ly.treasurySpend ?? 0),
    },
  };
}

export const selectEndPreview = (state) => state.chronicle?.summary ?? previewSummary(state);

// Live events; titleCard marks the ones that deserve a moment card.
export const selectEvents = (state) => (state.events?.active ?? [])
  .filter((a) => EVENTS[a.event] && !a.mods)
  .map((a) => ({id: a.id, event: a.event, title: EVENTS[a.event].title, icon: EVENTS[a.event].icon,
    titleCard: !!EVENTS[a.event].titleCard, startedMonth: a.startedMonth}));

export const TITLE_CARD_EVENTS = Object.keys(EVENTS).filter((id) => EVENTS[id].titleCard);

