// Fact sheets for the inspector's narrator (read-only over state).
//
//   narrativeFacts(state, {personId | householdId | buildingId | bodyId}) -> facts | null
//
// A fact sheet is a compact, structured summary of one entity: who it is, how it
// is doing (as bands), what its population slices lean toward and where they
// disagree, what happened to it, and the player's rulings that touched it. It
// holds facts only; src/narrative-schema.js validates and renders it, and the
// server turns it into a short note. Kept under about 1.2 KB of JSON.
//
// Per-entity history is read where it exists (household.story, building.origin,
// building.story, richer cardHistory records) and derived from what the state
// already holds where it does not.

import {hash32} from './rng.js';
import {monthIndex} from './clock.js';
import {doorOf} from './people.js';
import {POLICIES, activePolicies, levelOf} from './policies.js';
import {INSTITUTIONS, TEMPLATES, bodyName, personaOf} from './institutions.js';
import {explainCond, makeCtx} from './conditions.js';
import {nearestDistrictId} from './sites.js';
import {wearNorm} from './roads.js';
import {endSummary} from './chronicle.js';
import {EVENTS} from './events.js';
import {FACTIONS, factionOf, moodBand} from './factions.js';
import {KIND_BY_ID} from './decisions/kinds.js';
import {memberships, districtName} from './decisions/slices.js';
import {pool, jsDivergence} from '../decision-pool.js';
import {FACTS_VERSION, ERAS, SEASONS, BUILDING_TYPES, STORY_KINDS, clean, cleanProse, whenText, materialText, hashText} from '../narrative-schema.js';

// ---------------------------------------------------------------------------
// Names (deterministic, from ids; nothing is stored)
// ---------------------------------------------------------------------------

const GIVEN = ['Edda', 'Mara', 'Tamsin', 'Hal', 'Osric', 'Wynn', 'Bryn', 'Isolde', 'Corin', 'Petra', 'Aldo', 'Nell',
  'Rowan', 'Agnes', 'Tobin', 'Maud', 'Jory', 'Hester', 'Cael', 'Ivo', 'Wren', 'Ada', 'Silas', 'Lettice', 'Garth',
  'Elspeth', 'Piers', 'Avice', 'Dunstan', 'Sibyl', 'Ned', 'Orla', 'Bram', 'Juliana', 'Kit', 'Mabel', 'Odo', 'Rosamund',
  'Hugh', 'Bea', 'Ansel', 'Clem', 'Tilda', 'Ewan', 'Frideswide', 'Gil', 'Ida', 'Lark', 'Milo', 'Ottilie'];
const FAMILY = ['Thatcher', 'Marsh', 'Lark', 'Ode', 'Brennick', 'Fenwick', 'Cobb', 'Ashdown', 'Weller', 'Hale', 'Rook',
  'Tanner', 'Fletcher', 'Mercer', 'Holt', 'Dyer', 'Carter', 'Ploughwright', 'Reeve', 'Sawyer', 'Hayward', 'Pike',
  'Wheeler', 'Barrow', 'Cotter', 'Medlar', 'Quill', 'Underhill', 'Wainwright', 'Yarrow', 'Fairweather', 'Gosling',
  'Hobb', 'Kettle', 'Larch', 'Moss', 'Nettle', 'Oakes', 'Penrose', 'Rye'];

const pickName = (list, n) => list[hash32(n) % list.length];

// The family name follows the household a household split from, where known.
export function familyName(state, h) {
  const root = h?.familyId ?? h?.parentId ?? h?.id ?? 0;
  return pickName(FAMILY, (root + 1) * 7919 + (state.seed ?? 1) * 104729);
}

export function personName(state, p, h = householdOf(state, p?.householdId)) {
  const given = pickName(GIVEN, (p?.id ?? 0) * 2654435761 + (state.seed ?? 1));
  return h ? `${given} ${familyName(state, h)}` : given;
}

// ---------------------------------------------------------------------------
// Lookups and bands
// ---------------------------------------------------------------------------

const byIdIn = (list, id) => (id == null ? null : (list ?? []).find((x) => x.id === id) ?? null);
const householdOf = (state, id) => byIdIn(state.households, id);
const buildingOf = (state, id) => byIdIn(state.buildings, id);
const enterpriseOf = (state, id) => byIdIn(state.enterprises, id);

const round2 = (x) => Math.round(x * 100) / 100;
const needBand = (v) => (v == null ? undefined : v < 35 ? 'low' : v > 85 ? 'high' : undefined);
// Only a change is worth telling; a steady trend is left out.
const trendOf = (now, before, eps) => (before == null ? undefined : now - before > eps ? 'rising' : before - now > eps ? 'falling' : undefined);
const band3 = (x) => (x < 0.34 ? 'low' : x < 0.67 ? 'ok' : 'high');
const yearNow = (state) => state.time?.year ?? 0;

function wealthBand(state, wealth) {
  const [t1, t2] = state.bands?.wealth ?? [60, 200];
  return wealth < t1 ? 'poor' : wealth < t2 ? 'middling' : 'wealthy';
}

function header(state, kind, name) {
  return {
    v: FACTS_VERSION, kind, name: clean(name, 40) || 'Unknown',
    year: Math.max(-50, Math.min(400, yearNow(state))),
    season: SEASONS[Math.floor((state.time?.month ?? 0) / 3) % 4],
    era: ERAS[Math.max(0, Math.min(5, state.era ?? 0))],
  };
}

const typeWord = (b) => clean(b?.variant || b?.type || 'building', 24).replace(/-/g, ' ');

// ---------------------------------------------------------------------------
// What the slices lean toward, and where they disagree
// ---------------------------------------------------------------------------

// Options that mean "nothing much is wrong"; the rest make a lean worth telling.
const CALM = {
  household_stay_move: ['stay'], react_to_policy: ['accept', 'support'], crime_charity: ['honest', 'give_alms'],
  household_home: ['keep'], petition: ['wait'], festival_participation: ['join', 'watch'], newcomer_integrate: ['assimilate'],
  event_response: ['help'], strike_vote: ['work'], take_loan: ['hold'], enterprise_plan: ['hold'],
  faction_stance: ['indifferent'], institution_form_support: ['indifferent'], merchant_speculate: ['invest_trade'],
};

const HOUSEHOLD_KINDS = ['household_stay_move', 'react_to_policy', 'crime_charity', 'household_home', 'petition',
  'festival_participation', 'newcomer_integrate', 'event_response'];
const STALE_MONTHS = 36;

// One distribution per slice dimension of this household, fresh answers only.
function sliceParts(state, kindId, m) {
  const kind = KIND_BY_ID[kindId];
  const store = state.governance?.sliceAnswers?.[kindId] ?? {};
  const month = monthIndex(state.time);
  return kind.slices.map((dim) => {
    const entry = store[`${dim}=${m[dim]}`];
    const fresh = entry?.probs && month - (entry.month ?? -1e9) <= STALE_MONTHS;
    return {dim, value: m[dim], probs: fresh ? entry.probs : null, weight: kind.weights[dim] ?? 0.3};
  }).filter((p) => p.probs);
}

function ownEntry(state, kindId, id) {
  const entry = state.governance?.individual?.[kindId]?.[id];
  if (!entry?.probs || monthIndex(state.time) - (entry.month ?? -1e9) > STALE_MONTHS) return null;
  return entry;
}

const ownAnswer = (state, kindId, id) => ownEntry(state, kindId, id)?.probs ?? null;

// The same slices' previous answers, pooled the same way (one level of history).
function previousPooled(state, kindId, m, own) {
  if (own) return own.prev?.probs ?? null;
  const kind = KIND_BY_ID[kindId];
  const store = state.governance?.sliceAnswers?.[kindId] ?? {};
  const parts = kind.slices.map((dim) => ({probs: store[`${dim}=${m[dim]}`]?.prev?.probs, weight: kind.weights[dim] ?? 0.3})).filter((p) => p.probs);
  return parts.length ? pool(parts.map((p) => p.probs), {weights: parts.map((p) => p.weight), allowed: Object.keys(kind.criteria)}) : null;
}

// Did the strongest non-calm option move by five points or more since last time?
function shiftOf(kindId, probs, prev) {
  if (!prev) return undefined;
  const drama = topOf(probs).find(([o]) => !(CALM[kindId] ?? []).includes(o));
  if (!drama) return undefined;
  const delta = drama[1] - (prev[drama[0]] ?? 0);
  return Math.abs(delta) >= 0.05 ? {o: drama[0], dir: delta > 0 ? 'up' : 'down'} : undefined;
}

const calmShare = (kindId, probs) => (CALM[kindId] ?? []).reduce((n, o) => n + (probs[o] ?? 0), 0);
const topOf = (probs) => Object.entries(probs).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

// The two or three options worth telling: the top two, plus the strongest
// non-calm option if it is not among them.
function topOptions(kindId, probs) {
  const sorted = topOf(probs).filter(([, p]) => p >= 0.04);
  const top = sorted.slice(0, 2);
  const drama = sorted.find(([o]) => !(CALM[kindId] ?? []).includes(o));
  if (drama && !top.some(([o]) => o === drama[0]) && drama[1] >= 0.08) top.push(drama);
  return top.map(([o, p]) => ({o, p: round2(p)}));
}

// The rule change the react_to_policy answers are about: the newest one.
function newestRule(state) {
  let best = null;
  for (const p of activePolicies(state)) if (!best || (p.since ?? 0) > (best.since ?? 0)) best = p;
  return best ? clean(lower(best.def.title), 48) : undefined;
}

const aboutFor = (state, kindId) => (kindId === 'react_to_policy' ? newestRule(state) : undefined);

function leansFor(state, h, {extra = []} = {}) {
  const m = memberships(state, h);
  const leans = [];
  const torn = [];
  const kinds = HOUSEHOLD_KINDS.filter((k) => k !== 'newcomer_integrate' || m.newcomer === 'yes');
  for (const kindId of kinds) {
    const parts = sliceParts(state, kindId, m);
    const own = ownEntry(state, kindId, h.id);
    const offered = Object.keys(KIND_BY_ID[kindId].criteria);
    const probs = own?.probs ?? (parts.length ? pool(parts.map((p) => p.probs), {weights: parts.map((p) => p.weight), allowed: offered}) : null);
    if (!probs) continue;
    const shift = shiftOf(kindId, probs, previousPooled(state, kindId, m, own));
    leans.push({k: kindId, probs, shift, score: (kindId === 'household_stay_move' ? 2 : 1 - calmShare(kindId, probs)) + (shift ? 0.2 : 0)});
    const split = tornPair(kindId, parts);
    if (split) torn.push(split);
  }
  for (const e of extra) if (e.probs) leans.push({...e, score: 1 - calmShare(e.k, e.probs)});
  const chosen = leans.filter((l) => l.score >= 0.15).sort((a, b) => b.score - a.score).slice(0, 3);
  return {
    leans: chosen.map((l) => ({k: l.k, about: aboutFor(state, l.k), top: topOptions(l.k, l.probs), shift: l.shift})),
    torn: torn.sort((a, b) => b.d - a.d).slice(0, 2).map(({d, ...t}) => ({...t, about: aboutFor(state, t.k)})),
  };
}

// The pair of slices that disagree most, when their top choices differ.
function tornPair(kindId, parts) {
  let best = null;
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      const ta = topOf(a.probs)[0][0], tb = topOf(b.probs)[0][0];
      if (ta === tb) continue;
      const d = jsDivergence([a.probs, b.probs]) / Math.LN2;
      if (d >= 0.03 && (!best || d > best.d)) {
        best = {d, k: kindId, a: {dim: a.dim, value: clean(a.value, 24), o: ta}, b: {dim: b.dim, value: clean(b.value, 24), o: tb}};
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rulings and rules that touched a trade
// ---------------------------------------------------------------------------

// What a card was about and whom it helped or hurt, from the record or its template.
function cardSubject(c) {
  const [verb, key] = String(c.templateId ?? '').split(':');
  let helps = c.helps, hurts = c.hurts, title = null, builds = [];
  if (key && ['adopt', 'raise', 'ease'].includes(verb) && POLICIES[key]) {
    const def = POLICIES[key];
    const the = def.title.toLowerCase().replace(/^(a|an) /, 'the ');
    title = verb === 'adopt' ? def.title : `a step ${verb === 'raise' ? 'up' : 'down'} in ${the}`;
    const [h, x] = verb === 'ease' ? [def.hurts, def.helps] : [def.helps, def.hurts];
    helps ??= h; hurts ??= x;
    if (def.building) builds = [def.building];
  } else if (verb === 'form' && INSTITUTIONS[key]) {
    title = `forming the ${INSTITUTIONS[key].name}`;
    helps ??= INSTITUTIONS[key].constituency?.trades ?? [];
  } else if (verb === 'event' && EVENTS[key]) {
    title = EVENTS[key].title;
    builds = (EVENTS[key].choices ?? []).flatMap((o) => (o.effects ?? []).filter((e) => e.build).map((e) => e.build));
  } else if (verb === 'debate') {
    title = c.title;
    const def = POLICIES[c.policy];
    if (def && c.outcome === 'accepted') { helps ??= def.helps; hurts ??= def.hurts; }
  } else if (verb === 'grievance') {
    // 'The clerks petition the council' -> "the clerks' petition"
    title = String(c.title ?? '').replace(/^the (\w+?)(s?) petition .*$/i, (m, who, s) => `the ${who}${s}${s ? "'" : "'s"} petition`);
    const faction = FACTIONS.find((f) => String(c.title ?? '').toLowerCase().includes(f.name.toLowerCase()));
    helps ??= faction?.trades ?? [];
  } else if (TEMPLATES[c.templateId]) {
    const t = TEMPLATES[c.templateId];
    title = t.title;
    helps ??= t.helps; hurts ??= t.hurts;
    builds = (t.options ?? []).flatMap((o) => (o.effects ?? []).filter((e) => e.build).map((e) => e.build));
  }
  if (!title || /which first/i.test(title)) title = c.title && !/which first/i.test(c.title) ? c.title : String(c.templateId ?? 'a plan').replace(/[:-]/g, ' ');
  return {title, helps: helps ?? [], hurts: hurts ?? [], builds};
}

const ACT_OF = {accepted: 'approved', refused: 'refused', deferred: 'deferred', delegated: 'delegated', expired: 'lapsed'};

function actOf(c) {
  if (c.outcome === 'accepted' && c.kind === 'petition' && c.choice === 'hear') return 'heard';
  return ACT_OF[c.outcome] ?? null;
}

function fxFor(subject, trade) {
  const helps = subject.helps.includes(trade), hurts = subject.hurts.includes(trade);
  return helps && hurts ? 'mixed' : helps ? 'helped' : hurts ? 'hurt' : null;
}

const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// The player's rulings that touched one trade (and its faction), newest first.
// Repeats of the same ruling fold into one line.
function rulingsFor(state, trade, factionId, {limit = 4, years = 30, also = null} = {}) {
  const since = yearNow(state) - years;
  const ownBodies = new Set(Object.entries(INSTITUTIONS).filter(([, d]) => d.faction === factionId).map(([id]) => id));
  const seen = new Map();
  const out = [];
  const history = state.cardHistory ?? [];
  for (let i = history.length - 1; i >= 0 && out.length < limit * 3; i--) {
    const c = history[i];
    if (c.year < since) break;
    const act = actOf(c);
    if (!act || c.kind === 'event' && act !== 'refused' && !also?.(c)) continue;
    const subject = cardSubject(c);
    const fx = fxFor(subject, trade) ?? (ownBodies.has(c.from) ? 'touched' : null);
    if (!fx && !also?.(c)) continue;
    const key = `${c.templateId}|${act}`;
    if (seen.has(key)) { seen.get(key).times++; continue; }
    const row = {year: c.year, act, what: lower(subject.title), times: 1};
    if (fx) row.fx = fx;
    if (c.from && c.from !== 'moot' && INSTITUTIONS[c.from]) row.by = bodyName(state, c.from);
    const stance = c.stances?.[factionId];
    if (['for', 'against', 'split'].includes(stance)) row.stance = stance;
    seen.set(key, row);
    out.push(row);
  }
  const rank = (r) => (r.fx === 'helped' || r.fx === 'hurt' || r.fx === 'mixed' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.year - a.year).slice(0, limit).map(({times, ...r}) => ({
    ...r, what: clean(times > 1 ? `${r.what}, ${times} times` : r.what, 60), ...(r.by ? {by: clean(r.by, 40)} : {}),
  }));
}

function rulesFor(state, trade) {
  const rows = [];
  for (const p of activePolicies(state)) {
    const fx = p.def.helps?.includes(trade) ? 'helps' : p.def.hurts?.includes(trade) ? 'hurts' : null;
    if (!fx) continue;
    const by = p.by === 'player' ? 'you' : INSTITUTIONS[p.by] ? `the ${bodyName(state, p.by)}` : null;
    rows.push({what: clean(lower(p.def.title), 48), fx, since: p.since ?? undefined, by: by ? clean(by, 40) : undefined, mine: p.by === 'player'});
  }
  return rows.sort((a, b) => (b.mine - a.mine) || (b.since ?? 0) - (a.since ?? 0)).slice(0, 3).map(({mine, ...r}) => r);
}

function recentEvents(state, years = 8) {
  const now = yearNow(state);
  return Object.entries(state.tags ?? {})
    .filter(([tag, y]) => tag.startsWith('event:') && EVENTS[tag.slice(6)] && now - y <= years)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag, y]) => ({year: y, what: clean(lower(EVENTS[tag.slice(6)].title), 48)}));
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

const HOME_WORK = {repair: 'repaired it', extend: 'added a room to it', rebuild_up: 'rebuilt it bigger', buy_second: 'bought a second home'};
const TRADE_NAMES = {farm: 'farming', craft: 'a craft', trade: 'trade', labour: 'labouring', clerical: 'clerking', clergy: 'the church', gentry: 'gentry life', none: 'no trade'};

function storyText(s) {
  switch (s.kind) {
    case 'moved': return s.from && s.to ? (s.from === s.to ? `within ${s.to}` : `from ${s.from} to ${s.to}`) : s.to;
    case 'loan': return s.to ? `a ${s.to} loan` : undefined;
    case 'founded': case 'closed': return s.to ? `the ${String(s.to).replace(/-/g, ' ')}` : s.text;
    case 'home': return HOME_WORK[s.to] ?? s.text;
    case 'trade': return s.to ? `${s.from ? `from ${TRADE_NAMES[s.from] ?? s.from} ` : ''}to ${TRADE_NAMES[s.to] ?? s.to}` : undefined;
    case 'birth': case 'death': return undefined;
    case 'arrived': return s.text ? `settling in ${s.text}` : undefined;
    case 'upgraded': return s.text ? `to a ${String(s.text).replace(/-/g, ' ')}` : undefined;
    default: return s.text ?? s.to;
  }
}

// Which past moments are worth a line: hardship and choices before births and deaths.
const STORY_WEIGHT = {
  protest: 9, strike: 9, petition: 8, 'lost-job': 8, hungry: 8, closed: 7, founded: 7, trade: 6, moved: 5,
  loan: 5, home: 4, job: 4, arrived: 4, formed: 3, death: 2, birth: 1,
  built: 6, upgraded: 7, extended: 5, restyled: 5, repaired: 3, raised: 7, derelict: 8, converted: 6, damaged: 8, owner: 5,
  displaced: 8,
};

// Newest first, repeats of a kind folded into one line, at most `limit` lines.
function storyRows(list, limit = 4) {
  const folded = new Map();
  const startYears = new Set((list ?? []).filter((s) => s.kind === 'arrived' || s.kind === 'formed').map((s) => s.year));
  for (const s of [...(list ?? [])].reverse()) {
    if (!STORY_KINDS.includes(s.kind) || !Number.isFinite(s.year)) continue;
    if (s.kind === 'moved' && s.from === s.to && startYears.has(s.year)) continue;   // settling in, not a move
    const row = folded.get(s.kind);
    if (row) { row.times++; continue; }
    folded.set(s.kind, {year: s.year, kind: s.kind, text: storyText(s), times: 1});
  }
  const rows = [...folded.values()]
    .sort((a, b) => (STORY_WEIGHT[b.kind] ?? 1) - (STORY_WEIGHT[a.kind] ?? 1) || b.year - a.year)
    .slice(0, limit)
    .sort((a, b) => b.year - a.year);
  return rows.map(({times, text, ...r}) => {
    const extra = times > 1 ? (r.kind === 'hungry' ? 'for many months' : `the latest of ${times}`) : null;
    const t = [text, extra].filter(Boolean).join(', ');
    return t ? {...r, text: clean(t, 60)} : r;
  });
}

function householdStory(state, h, owned, faction) {
  const rows = storyRows(h.story, 4);
  // What their faction did as a group fills spare lines (protests, petitions).
  if (faction?.story?.length && rows.length < 4) {
    const group = clean(faction.name.toLowerCase(), 24);
    for (const row of storyRows(faction.story, 2)) {
      if (rows.length >= 4 || rows.some((r) => r.kind === row.kind && r.year === row.year)) continue;
      rows.push({...row, group});
    }
  }
  const has = (kind) => rows.some((r) => r.kind === kind) || (h.story ?? []).some((r) => r.kind === kind);
  if (rows.length < 4 && !has('arrived') && !has('formed') && (h.formedYear ?? 0) > 0) {
    rows.push({year: h.formedYear, kind: h.parentId != null ? 'formed' : 'arrived'});
  }
  for (const ent of owned) {
    if (rows.length < 4 && (ent.since ?? 0) > 0 && !has('founded')) rows.push({year: ent.since, kind: 'founded', text: clean(`the ${typeWord(ent)}`, 60)});
  }
  return rows.sort((a, b) => b.year - a.year);
}

// ---------------------------------------------------------------------------
// People and households
// ---------------------------------------------------------------------------

function workState(h) {
  if (!h || (h.workers ?? 0) <= 0.01) return 'none';
  const share = (h.employed ?? 0) / h.workers;
  return share >= 0.85 ? 'working' : share >= 0.4 ? 'short' : 'idle';
}

function rentState(h) {
  const rent = h.rent ?? 0;
  if (rent <= 0) return undefined;
  return rent > 0.3 * Math.max(1, h.income ?? 0) ? 'heavy' : 'light';
}

function householdCore(state, h) {
  const owned = (state.enterprises ?? []).filter((e) => e.ownerHouseholdId === h.id);
  const home = buildingOf(state, h.homeId);
  const fid = factionOf(state, h);
  const faction = (state.factions ?? []).find((f) => f.id === fid);
  const who = {
    stage: h.lifeStage, trade: h.trade, district: clean(districtName(state, h.districtId), 24),
    family: Math.max(1, Math.min(60, Math.round(h.size ?? 1))),
  };
  if (owned.length) who.role = clean(`owners of the ${typeWord(owned[0])}${owned.length > 1 ? ` and ${owned.length - 1} more` : ''}`, 60);
  if (home) who.home = clean(`a ${typeWord(home)}`, 40);
  else who.home = 'no home of their own';
  if (h.newcomerUntil != null && h.newcomerUntil >= yearNow(state)) who.newcomer = true;
  if (Number.isFinite(h.formedYear) && h.formedYear > 0) who.since = Math.round(h.formedYear);

  const wealth = h.wealth ?? h.savings ?? 0;
  const now = {
    wealth: wealthBand(state, wealth),
    wealthTrend: trendOf(wealth, h.yearAgo?.wealth, Math.max(20, Math.abs(h.yearAgo?.wealth ?? 0) * 0.1)),
    work: workState(h),
    rent: rentState(h),
  };
  if (faction) {
    now.mood = moodBand(faction.mood ?? 0.6);
    now.moodTrend = trendOf(faction.mood ?? 0, faction.lastMood, 0.01);
    now.moodOf = clean(faction.name.toLowerCase(), 24);
  }
  if ((h.hunger ?? 0) > 0.3) now.hungry = true;

  const extra = [{k: 'take_loan', probs: ownAnswer(state, 'take_loan', h.id)}];
  const {leans, torn} = leansFor(state, h, {extra});
  return {
    who, now, leans, torn,
    story: householdStory(state, h, owned, faction),
    rulings: rulingsFor(state, h.trade, fid, {limit: 3}),
    rules: rulesFor(state, h.trade).slice(0, 2),
    events: recentEvents(state).slice(0, 2),
  };
}

function personFacts(state, p) {
  const h = householdOf(state, p.householdId);
  const facts = header(state, 'person', personName(state, p, h));
  const core = h ? householdCore(state, h) : {who: {}, now: {}};
  const task = typeof p.task === 'string' ? p.task : p.task?.kind;
  const now = {
    doing: task ?? undefined,
    place: placeOf(state, p),
    energy: needBand(p.needs?.energy), food: needBand(p.needs?.fullness), company: needBand(p.needs?.social),
    ...core.now,
  };
  const job = enterpriseOf(state, p.workId);
  if (job) now.work = 'working';
  const who = {...core.who};
  if (job && !who.role) {
    const owner = householdOf(state, job.ownerHouseholdId);
    who.role = clean(`works at the ${typeWord(job)}${owner && owner.id !== h?.id ? ` of the ${familyName(state, owner)} family` : ''}`, 60);
  }
  return finish({...facts, ...core, who, now});
}

function placeOf(state, p) {
  const t = p.task;
  if (!t || typeof t !== 'object') return undefined;
  if (t.eventKind) return clean(`a ${t.eventKind}`, 40);
  if (t.targetType === 'building' || t.targetId != null) {
    const b = buildingOf(state, t.targetId);
    if (!b) return undefined;
    if (b.id === p.homeId) return 'home';
    return clean(`the ${typeWord(b)}`, 40);
  }
  return undefined;
}

function householdFacts(state, h) {
  const facts = header(state, 'household', `The ${familyName(state, h)} family`);
  return finish({...facts, ...householdCore(state, h)});
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

const ROAD_TIERS = ['grass', 'trail', 'track', 'road', 'paved', 'avenue'];

// The best road tier at or beside the building's door.
function roadAtDoor(state, b) {
  const r = state.roads;
  if (!r?.tier || !r.W) return undefined;
  const door = doorOf(b);
  const cx = Math.floor((door.x - (r.ox ?? -256)) / (r.cell ?? 2));
  const cz = Math.floor((door.z - (r.oz ?? -256)) / (r.cell ?? 2));
  let best = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= r.W || z >= (r.H ?? r.W)) continue;
      best = Math.max(best, r.tier[z * r.W + x] ?? 0);
    }
  }
  return ROAD_TIERS[Math.min(5, best)];
}

// The body a civic building belongs to: its rulings tell the building's story.
const CIVIC_BODY = {
  moot: 'moot', school: 'school-board', library: 'school-board', chapel: 'parish', infirmary: 'health-board',
  bathhouse: 'health-board', watch: 'watch', exchange: 'exchange', 'union-hall': 'union', quay: 'river-authority',
  bridge: 'river-authority', theatre: 'arts-society', monument: 'arts-society', park: 'planning',
};

function bodyRulings(state, bodyId, limit) {
  const rows = [];
  const history = state.cardHistory ?? [];
  for (let i = history.length - 1; i >= 0 && rows.length < limit; i--) {
    const c = history[i];
    const act = actOf(c);
    if (c.from !== bodyId || !act || c.kind === 'event') continue;
    rows.push({year: c.year, act, what: clean(lower(cardSubject(c).title), 60)});
  }
  return rows;
}

const conditionOf = (c) => (c >= 0.8 ? 'good' : c >= 0.5 ? 'worn' : c >= 0.25 ? 'shabby' : 'failing');

const REASON_WORDS = {homes: 'to house new families', found: 'for a new business', works: 'as public works', expand: 'to grow a business', founding: 'when the town was founded'};

// sites.js siteText: 'no path yet, low land value, few neighbours, clean air, by the river'
function siteWords(site) {
  const parts = String(site ?? '').split(',').map((x) => x.trim());
  const out = [];
  if (parts[0] === 'no path yet') out.push('where no path ran yet');
  else if (parts[0]?.startsWith('on a')) out.push(parts[0]);
  if (/^low land/.test(parts[1] ?? '')) out.push('on cheap land');
  else if (/^high land/.test(parts[1] ?? '')) out.push('on dear land');
  if (/by the river/.test(site ?? '')) out.push('by the river');
  return out.join(', ');
}

function payerWords(state, payer) {
  const [kind, id] = String(payer ?? '').split(':');
  if (kind === 'treasury') return 'the town paid';
  if (kind === 'household') {
    const h = householdOf(state, Number(id));
    return h ? `the ${familyName(state, h)} family paid` : 'a family paid';
  }
  if (kind === 'body' && INSTITUTIONS[id]) return `the ${bodyName(state, id)} paid`;
  if (kind === 'enterprise') return 'a business paid';
  return null;
}

// The accepted card that likely built this building (same type, near its build year).
function buildingCard(state, b) {
  const built = yearNow(state) - Math.round(b.age ?? 0);
  if (b.origin?.card) return (state.cardHistory ?? []).find((c) => c.id === b.origin.card) ?? null;
  return (state.cardHistory ?? []).find((c) => c.outcome === 'accepted' && Math.abs(c.year - built) <= 1 &&
    cardSubject(c).builds.includes(b.type)) ?? null;
}

function originText(state, b, card) {
  const o = b.origin ?? {};
  const year = o.year ?? yearNow(state) - Math.round(b.age ?? 0);
  const parts = [o.reason === 'founding' || year <= 1 ? 'one of the first buildings' : `built in year ${year}`];
  if (card) parts.push(`after you approved ${lower(cardSubject(card).title)}`);
  else if (REASON_WORDS[o.reason] && o.reason !== 'founding') parts.push(REASON_WORDS[o.reason]);
  if (o.site) parts.push(siteWords(o.site));
  const payer = payerWords(state, o.payer);
  if (payer) parts.push(payer);
  // Whole clauses only, within 80 characters.
  let text = '';
  for (const part of parts.filter(Boolean)) {
    const next = text ? `${text}, ${part}` : part;
    if (next.length > 80) break;
    text = next;
  }
  return clean(text, 80);
}

function buildingFacts(state, b) {
  const ent = (state.enterprises ?? []).find((e) => e.buildingId === b.id) ?? null;
  const owner = householdOf(state, b.ownerHouseholdId ?? ent?.ownerHouseholdId);
  const district = clean(districtName(state, b.districtId), 24);
  const name = b.type === 'home' && owner ? `The ${familyName(state, owner)} home` : `The ${typeWord(b)} in ${district}`;
  const facts = header(state, 'building', name);
  const card = buildingCard(state, b);
  const building = {
    type: BUILDING_TYPES.includes(b.type) ? b.type : 'home',
    variant: typeWord(b),
    tier: Math.max(1, Math.min(5, b.tier ?? 1)),
    storeys: Math.max(1, Math.min(12, b.storeys ?? 1)),
    age: Math.max(0, Math.min(400, Math.round(b.age ?? 0))),
    built: round2(Math.max(0, Math.min(1, b.built ?? 1))),
    condition: conditionOf(b.condition ?? 1),
    wealth: (b.wealth ?? 0.3) < 0.34 ? 'poor' : (b.wealth ?? 0.3) < 0.67 ? 'middling' : 'wealthy',
    material: b.material ? clean(b.material, 16) : undefined,
    style: ERAS[Math.max(0, Math.min(5, b.styleEra ?? 0))],
    road: roadAtDoor(state, b),
    roadThen: Number.isInteger(b.origin?.frontage) ? ROAD_TIERS[Math.max(0, Math.min(5, b.origin.frontage))] : undefined,
    nearRiver: Number.isFinite(b.bankDistance) ? b.bankDistance < 12 : undefined,
    flags: Object.keys(b.flags ?? {}).filter((f) => b.flags[f] && ['heritage', 'derelict', 'raised'].includes(f)),
    owner: owner ? `the ${familyName(state, owner)} family` : undefined,
    origin: originText(state, b, card),
  };
  // Scaffolding only counts while a project is open on the building.
  if (b.flags?.scaffold && (b.built < 1 || (state.projects ?? []).some((p) => p.buildingId === b.id))) building.flags.push('scaffold');
  if (!building.flags.length) delete building.flags;

  const residents = (state.households ?? []).filter((h) => h.homeId === b.id);
  const out = {...facts, who: {district}, building};
  if (residents.length) {
    out.residents = {
      households: residents.length,
      people: residents.reduce((n, h) => n + Math.round(h.size ?? 1), 0),
      families: [...new Set(residents.map((h) => `the ${familyName(state, h)}s`))].slice(0, 3),
      trades: [...new Set(residents.map((h) => h.trade))].slice(0, 3),
    };
  }

  const civic = CIVIC_BODY[b.type] && (!ent || ent.public) ? CIVIC_BODY[b.type] : null;
  const mainTrade = civic ? null : ent?.trade ?? residents[0]?.trade ?? owner?.trade ?? null;
  if (ent && (ent.jobs ?? 0) > 0) {
    const wage = state.economy?.wageRate ?? 20;
    const payroll = Math.max(1, (ent.jobs ?? 1) * wage);
    out.business = {
      type: typeWord(ent),
      jobs: Math.round(ent.jobs ?? 0),
      filled: Math.round(ent.filled ?? 0),
      // Public services (the watch, the school) have no profit to speak of.
      profit: ent.public ? undefined : (ent.profitLastYear ?? 0) < 0 || (ent.lossYears ?? 0) > 0 ? 'losing'
        : (ent.profitLastYear ?? 0) < 0.05 * Math.max(1, ent.revenue ?? 0) ? 'even' : 'making',
      cash: ent.public ? undefined : (ent.cash ?? 0) < payroll ? 'short' : (ent.cash ?? 0) > 12 * payroll ? 'flush' : 'steady',
      automated: ent.automated ? true : undefined,
      since: (ent.since ?? 0) > 0 ? ent.since : undefined,
    };
    const plan = ownAnswer(state, 'enterprise_plan', ent.id);
    if (plan) out.leans = [{k: 'enterprise_plan', top: topOptions('enterprise_plan', plan)}];
  } else if (residents[0]) {
    const {leans} = leansFor(state, residents[0]);
    if (leans.length) out.leans = leans.slice(0, 2);
  }

  out.story = storyRows(b.story, 4);
  if (!out.story.length) delete out.story;
  const fid = residents[0] ? factionOf(state, residents[0]) : FACTIONS.find((f) => f.trades.includes(mainTrade))?.id;
  // Civic buildings tell the ruling that built them; homes and businesses the rulings that touched their people.
  const rulings = mainTrade && (ent || residents.length) ? rulingsFor(state, mainTrade, fid, {limit: 3, also: (c) => c === card}) : [];
  if (civic) rulings.push(...bodyRulings(state, civic, 3));
  if (card && !rulings.some((r) => r.year === card.year)) {
    rulings.unshift({year: card.year, act: 'approved', what: clean(lower(cardSubject(card).title), 60)});
  }
  if (rulings.length) out.rulings = rulings.slice(0, 3);
  if (mainTrade && (ent || residents.length)) {
    const rules = rulesFor(state, mainTrade).slice(0, 2);
    if (rules.length) out.rules = rules;
  }
  return finish(out);
}

// ---------------------------------------------------------------------------
// Bodies (institutions)
// ---------------------------------------------------------------------------

function bodyFacts(state, body) {
  const facts = header(state, 'body', bodyName(state, body.kind ?? body.id));
  const out = {
    ...facts,
    body: {
      founded: Math.round(body.foundedYear ?? 0),
      status: ['petition', 'active', 'waning', 'dissolved', 'suspended'].includes(body.status) ? body.status : 'active',
      power: band3(body.power ?? 0.5),
      patience: band3(body.patience ?? 0.5),
    },
  };
  const rulings = bodyRulings(state, body.id, 4);
  if (rulings.length) out.rulings = rulings;
  const trade = INSTITUTIONS[body.kind]?.constituency?.trades?.[0];
  if (trade) {
    const rules = rulesFor(state, trade).slice(0, 2);
    if (rules.length) out.rules = rules;
  }
  return finish(out);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Drop empty lists and undefined fields so the sheet stays small and valid.
function finish(facts) {
  const prune = (v) => {
    if (Array.isArray(v)) return v.map(prune);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined || x === null || (Array.isArray(x) && !x.length)) continue;
        out[k] = prune(x);
      }
      return out;
    }
    return v;
  };
  const out = prune(facts);
  for (const k of ['who', 'now']) if (out[k] && !Object.keys(out[k]).length) delete out[k];
  // The material key comes from the whole sheet, before trimming, so a change in
  // passing facts (which shifts what fits) never changes it.
  const key = hashText(materialText(out));
  const fitted = fit(out);
  materialKeys.set(fitted, key);
  return fitted;
}

const materialKeys = new WeakMap();   // fact sheet -> material key computed before trimming

// The key a kept note is valid for. Sheets from narrativeFacts carry their own;
// any other sheet is keyed from what it holds.
export function materialKey(facts) {
  return materialKeys.get(facts) ?? hashText(materialText(facts));
}

// 'person:12' | 'household:7' | 'building:45' | 'body:moot'
export function entityRef({personId, householdId, buildingId, bodyId} = {}) {
  if (personId != null) return `person:${personId}`;
  if (householdId != null) return `household:${householdId}`;
  if (buildingId != null) return `building:${buildingId}`;
  if (bodyId != null) return `body:${bodyId}`;
  return null;
}

export function refQuery(ref) {
  const [kind, id] = String(ref ?? '').split(':');
  const num = Number(id);
  if (kind === 'person') return {personId: num};
  if (kind === 'household') return {householdId: num};
  if (kind === 'building') return {buildingId: num};
  if (kind === 'body') return {bodyId: id};
  return {};
}

export const FACTS_BUDGET = 1200;

// Trim the least telling lists first until the sheet fits the budget.
const TRIM = [['events', 1], ['rules', 1], ['story', 3], ['leans', 2], ['events', 0], ['rulings', 2], ['story', 2], ['rules', 0],
  ['torn', 1], ['leans', 1], ['torn', 0], ['rulings', 1], ['story', 1]];

function fit(facts) {
  for (const [key, keep] of TRIM) {
    if (JSON.stringify(facts).length <= FACTS_BUDGET) break;
    if (!facts[key] || facts[key].length <= keep) continue;
    if (keep) facts[key] = facts[key].slice(0, keep);
    else delete facts[key];
  }
  return facts;
}

export function narrativeFacts(state, {personId, householdId, buildingId, bodyId} = {}) {
  if (!state) return null;
  if (personId != null) {
    const p = byIdIn(state.people, personId);
    return p ? personFacts(state, p) : null;
  }
  if (householdId != null) {
    const h = householdOf(state, householdId);
    return h ? householdFacts(state, h) : null;
  }
  if (buildingId != null) {
    const b = buildingOf(state, buildingId);
    return b ? buildingFacts(state, b) : null;
  }
  if (bodyId != null) {
    const body = (state.institutions ?? []).find((x) => x.id === bodyId || x.kind === bodyId);
    return body ? bodyFacts(state, body) : null;
  }
  return null;
}

// A key that changes when the facts change (for per-entity caches in the UI).
export function factsKey(facts) {
  const text = JSON.stringify(facts ?? null);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Docket cards: what the asker's prose may draw on
//
//   cardFacts(state, cardId) -> facts for /api/narrate {kind: 'card'} | null
//
// Titles, labels, costs and effects here are the template's and stay
// authoritative; the model only rewrites `why` and each option's trade-off.
// ---------------------------------------------------------------------------

export const CARD_BUDGET = 2500;

const PATH_WORDS = {
  'P.riverTrade': 'river trade', 'P.faith': 'faith', 'P.learning': 'learning', 'P.ecology': 'the health of the land',
  'P.health': 'public health', 'P.unrest': 'unrest', 'P.prestige': "the town's good name",
  'T.industry': 'industry', 'T.market': 'markets', 'T.innovation': 'new ideas', 'T.authority': 'order and authority',
  'I.traffic': 'traffic on the roads', 'I.tension': 'tension between groups', 'I.inequality': 'the gap between rich and poor',
  'I.housingPressure': 'the need for homes', 'I.literacy': 'reading', 'I.density': 'crowding', 'I.jobBalance': 'spare jobs',
  'I.wellbeing': 'spirits', 'I.treasuryYears': 'the treasury', 'I.foodBalance': 'food in store', 'I.avgWealth': 'wealth',
  'I.pop': 'people', 'I.employment': 'work',
};
const COUNT_WORDS = {enterprises: 'businesses', households: 'households', institutions: 'bodies', policies: 'rules', bigEnterprises: 'big works'};

// Bands for the indicators a category is about (used when a card has no condition of its own).
const CATEGORY_PATHS = {
  land: ['I.housingPressure', 'I.density'], labour: ['I.jobBalance', 'I.inequality'], trade: ['P.riverTrade', 'T.market'],
  tax: ['I.treasuryYears'], food: ['I.foodBalance'], health: ['P.health', 'I.density'], education: ['I.literacy', 'P.learning'],
  faith: ['P.faith'], environment: ['P.ecology'], infrastructure: ['I.traffic'], civic: ['P.unrest', 'I.tension'],
};
const BANDS = {'I.foodBalance': [2, 6], 'I.treasuryYears': [0.3, 1.5], 'I.jobBalance': [-0.05, 0.1], 'I.wellbeing': [50, 75]};

function bandWord(path, v) {
  const [lo, hi] = BANDS[path] ?? [0.25, 0.55];
  return v < lo ? 'low' : v < hi ? 'fair' : 'high';
}

function pathValue(ctx, path) {
  const [ns, k] = path.split('.');
  const table = ctx[ns];
  const v = ns === 'C' ? ctx.C[k] : table?.[k];
  return Number.isFinite(v) ? v : 0;
}

function termText(state, ctx, expr) {
  const [op, a] = expr;
  if (['gte', 'gt', 'lte', 'lt', 'between'].includes(op) && typeof a === 'string' && a.includes('.')) {
    const v = pathValue(ctx, a);
    if (a === 'I.pop') return `${Math.round(v)} people live here`;
    if (a.startsWith('C.')) {
      // Counts become words: the player does not care that there are 65 farms.
      const k = a.slice(2);
      const many = op.startsWith('g') ? (v >= 20 ? 'a great many' : v >= 6 ? 'many' : 'a few') : 'few';
      return `the town has ${many} ${COUNT_WORDS[k] ?? `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}s`}`;
    }
    const label = PATH_WORDS[a] ?? a.slice(2);
    if (a.startsWith('T.')) return op.startsWith('g') ? `the town leans toward ${label}` : `the town leans away from ${label}`;
    return `${label} is ${bandWord(a, v)}`;
  }
  if (op === 'tag') {
    const year = state.tags?.[a];
    return year == null ? null : `${a.replace(/[-:]/g, ' ')}, ${whenText(year, state.time.year).toLowerCase()}`;
  }
  if (op === 'has') {
    const [, what, id] = expr;
    if (what === 'policy' && POLICIES[id]) return `the rule ${lower(POLICIES[id].title)} stands`;
    if (what === 'institution' && INSTITUTIONS[id]) return `the ${bodyName(state, id)} sits`;
    if (what === 'building') return `the town has a ${id}`;
  }
  if (op === 'torn') return 'people are divided';
  return null;
}

// The true leaves of a condition, as plain fact phrases.
function trueTerms(state, ctx, node, out) {
  if (!node || out.length >= 4) return;
  if (node.terms) {
    for (const t of node.terms) if (t.value > 0.5 || t.op === 'soft' || t.op === 'and' || t.op === 'or') trueTerms(state, ctx, t, out);
    return;
  }
  if (!(node.value > 0.5) || !Array.isArray(node.expr)) return;
  const text = termText(state, ctx, node.expr);
  if (text && !out.includes(text)) out.push(text);
}

function conditionOfCard(card) {
  const [verb, key] = String(card.templateId ?? '').split(':');
  if (TEMPLATES[card.templateId]?.when) return TEMPLATES[card.templateId].when;
  if (verb === 'form') return INSTITUTIONS[key]?.when ?? null;
  if (verb === 'event') return EVENTS[key]?.when ?? null;
  return null;
}

function cardTrigger(state, card) {
  const ctx = makeCtx(state);
  const out = [];
  const cond = conditionOfCard(card);
  if (cond) {
    try { trueTerms(state, ctx, explainCond(cond, ctx), out); } catch { /* a condition this module cannot read */ }
  }
  for (const path of CATEGORY_PATHS[card.category] ?? []) {
    if (out.length >= 3) break;
    const text = termText(state, ctx, ['gte', path, 0]);
    if (text && !out.includes(text)) out.push(text);
  }
  for (const d of card.details ?? []) {
    if (out.length >= 5) break;
    if (d?.label && d?.value) out.push(`${d.label}: ${d.value}`);
  }
  return out.map((t) => cleanProse(t, 90)).filter(Boolean).slice(0, 5);
}

function cardPlace(state, card) {
  const {x, z} = card.data ?? {};
  if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
  const r = state.roads;
  const place = {district: clean(districtName(state, nearestDistrictId(state, x, z)), 24)};
  if (r?.tier && r.W) {
    const cx = Math.floor((x - (r.ox ?? -256)) / (r.cell ?? 2));
    const cz = Math.floor((z - (r.oz ?? -256)) / (r.cell ?? 2));
    const i = cz * r.W + cx;
    if (cx >= 0 && cz >= 0 && cx < r.W && i < r.tier.length) {
      place.road = ROAD_TIERS[Math.min(5, r.tier[i] ?? 0)];
      const w = wearNorm(r.wear?.[i] ?? 0);
      place.traffic = w < 0.35 ? 'quiet' : w < 0.7 ? 'busy' : 'very busy';
    }
  }
  return place;
}

const DELTA_WORDS = {
  riverTrade: 'river trade', faith: 'faith', learning: 'learning', ecology: 'green land', health: 'health', unrest: 'unrest',
  prestige: 'fame', industry: 'industry', market: 'trade', innovation: 'new ideas', authority: 'order',
};
const BUDGET_WORDS = (b) => (b <= 0.03 ? 'a small purse' : b >= 0.1 ? 'a generous purse' : 'a fair purse');

function effectRows(state, card, option) {
  const body = bodyName(state, card.from);
  const rows = [];
  for (const e of option.effects ?? []) {
    if (e.policy && POLICIES[e.policy]) {
      const what = POLICIES[e.policy].title.toLowerCase().replace(/^(a|an) /, 'the ');
      const now = levelOf(state, e.policy);
      const target = e.level === '+1' ? now + 1 : e.level === '-1' ? now - 1 : Number(e.level ?? 1);
      rows.push({act: target <= 0 ? 'repeal' : now <= 0 ? 'adopt' : target > now ? 'raise' : 'lower', what});
    } else if (e.spend) rows.push({act: 'spend', what: e.spend === 'half' ? 'half the cost' : 'town coin'});
    else if (e.build) rows.push({act: 'build', what: `a ${String(e.variant && e.variant !== 'upgrade' ? e.variant : e.build).replace(/-/g, ' ')}`});
    else if (e.work !== undefined) rows.push({act: 'works', what: 'the works'});
    else if (e.form) rows.push({act: 'form', what: `the ${bodyName(state, e.form)} with ${BUDGET_WORDS(e.budget ?? 0.06)}`});
    else if (e.event) rows.push({act: 'event', what: lower(EVENTS[e.event]?.title ?? e.event)});
    else if (e.wait) rows.push({act: 'wait', what: 'they ask again later'});
    else if (e.refuseBody) rows.push({act: 'displease', what: `the ${body} and its backers`});
    else if (e.loan) rows.push({act: 'loan', what: 'from the valley bank'});
    else if (e.deltas) {
      for (const [k, v] of Object.entries(e.deltas)) {
        if (DELTA_WORDS[k] && v) rows.push({act: v > 0 ? 'more' : 'less', what: DELTA_WORDS[k]});
      }
    }
  }
  if (!rows.length) {
    if (option.key === 'not_now') rows.push({act: 'wait', what: 'they ask again later'});
    else if (/^refuse/.test(option.key)) rows.push({act: 'displease', what: `the ${body}`});
    else if (option.key === 'negotiate') rows.push({act: 'negotiate'});
    else rows.push({act: 'nothing'});
  }
  return rows.slice(0, 5).map((r) => (r.what ? {...r, what: clean(r.what, 48)} : r));
}

// The district where most of a faction's households live.
function factionHome(state, factionId) {
  const counts = new Map();
  for (const h of state.households ?? []) {
    if (factionOf(state, h) !== factionId) continue;
    counts.set(h.districtId, (counts.get(h.districtId) ?? 0) + (h.size ?? 1));
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? clean(districtName(state, best[0]), 24) : undefined;
}

function stanceRows(state, card) {
  const rows = Object.entries(card.stances ?? {}).map(([fid, s]) => {
    const top = s.probs ? topOf(s.probs)[0] : [s.stance, s.p ?? 0.5];
    const name = (state.factions ?? []).find((f) => f.id === fid)?.name ?? FACTIONS.find((f) => f.id === fid)?.name ?? fid;
    return {fid, who: clean(name.toLowerCase(), 24), lean: top[0], p: round2(top[1] ?? 0.5)};
  }).filter((r) => ['for', 'against', 'split', 'indifferent', 'back', 'oppose'].includes(r.lean))
    .sort((a, b) => (b.lean !== 'indifferent') - (a.lean !== 'indifferent') || b.p - a.p)
    .filter((r, i, all) => r.lean !== 'indifferent' || all[i - 1]?.lean !== 'indifferent')   // one 'not moved' line is enough
    .slice(0, 6);
  // The faction most at stake gets its home quarter: a place the template cannot name.
  if (rows[0] && rows[0].lean !== 'indifferent') rows[0].where = factionHome(state, rows[0].fid);
  return rows.map(({fid, ...r}) => r);
}

// The body's asks over the last two years.
function recentRecord(state, bodyId) {
  const since = monthIndex(state.time) - 24;
  const record = {approved: 0, refused: 0, deferred: 0};
  for (const c of state.cardHistory ?? []) {
    if (c.from !== bodyId || c.kind === 'event' || c.year * 12 + (c.month ?? 0) < since) continue;
    if (c.outcome === 'accepted') record.approved++;
    else if (c.outcome === 'refused') record.refused++;
    else if (c.outcome === 'deferred') record.deferred++;
  }
  return record.approved || record.refused || record.deferred ? record : undefined;
}

function bodyRecord(state, bodyId) {
  const record = {approved: 0, refused: 0, deferred: 0};
  for (const c of state.cardHistory ?? []) {
    if (c.from !== bodyId || c.kind === 'event') continue;
    if (c.outcome === 'accepted') record.approved++;
    else if (c.outcome === 'refused') record.refused++;
    else if (c.outcome === 'deferred') record.deferred++;
  }
  return record;
}

export function cardFacts(state, cardId) {
  const card = (state?.docket ?? []).find((c) => c.id === cardId);
  if (!card) return null;
  // A petition to form a body speaks for that body's people, not for the council that carries it.
  const forms = card.data?.forms && INSTITUTIONS[card.data.forms] ? card.data.forms : null;
  const persona = {...(forms ? INSTITUTIONS[forms].asker ?? {} : personaOf(state, card.from) ?? {}), ...(card.asker ?? {})};
  const asker = {
    name: clean(persona.name || 'A neighbour', 40),
    role: persona.role ? clean(persona.role, 24) : undefined,
    traits: (persona.traits ?? []).slice(0, 3).map((t) => clean(t, 16)).filter(Boolean),
    body: !forms && INSTITUTIONS[card.from] ? clean(bodyName(state, card.from), 40) : undefined,
  };
  const head = header(state, 'card', card.title);
  const facts = {
    v: 1, type: 'card', id: clean(card.id, 16), kind: card.kind, template: clean(String(card.templateId ?? '').replace(/\|/g, ' '), 60),
    category: card.category ? clean(card.category, 24) : undefined,
    title: cleanProse(card.title, 80) || 'A proposal', year: head.year, season: head.season, era: head.era,
    urgency: Math.max(0, Math.min(2, card.urgency ?? 0)), grain: card.againstGrain ? true : undefined,
    asker,
    why: cleanProse(card.why, 320) || undefined,
    trigger: cardTrigger(state, card),
    place: cardPlace(state, card),
    options: card.options.slice(0, 7).map((o) => ({
      key: o.key, label: cleanProse(o.label, 60) || o.key,
      cost: Math.max(0, Math.round(o.cost ?? 0)), upkeep: Math.max(0, Math.round(o.upkeep ?? 0)),
      effects: effectRows(state, card, o), tradeoff: cleanProse(o.tradeoff, 180) || undefined,
    })),
    stances: stanceRows(state, card),
    past: bodyRulings(state, card.from, 6).filter((r, i, all) => all.findIndex((x) => x.what === r.what) === i).slice(0, 4),
    record: bodyRecord(state, card.from),
    recent: recentRecord(state, card.from),
    helps: (card.helps ?? []).slice(0, 6),
    hurts: (card.hurts ?? []).slice(0, 6),
    events: recentEvents(state, 4).slice(0, 2),
  };
  const out = finishPlain(facts);
  for (const [k, keep] of [['events', 0], ['past', 2], ['stances', 4], ['trigger', 3]]) {
    if (JSON.stringify(out).length <= CARD_BUDGET) break;
    if (out[k]) out[k] = out[k].slice(0, keep);
    if (!out[k]?.length) delete out[k];
  }
  return out;
}

// Cards that still want prose, oldest first.
export const cardsNeedingProse = (state) =>
  (state?.docket ?? []).filter((c) => !c.prose && c.needsProse !== false).sort((a, b) => (a.createdMonth ?? 0) - (b.createdMonth ?? 0));

// ---------------------------------------------------------------------------
// The chronicle: a year's line and the end page
//
//   chronicleFacts(state, {year})      -> year facts (the year that just ended)
//   chronicleFacts(state, {end: true}) -> end-of-chronicle facts
// ---------------------------------------------------------------------------

const ENTRY_RANK = {moment: 0, line: 1, decision: 2};
const ERA_NAMES = ['Hamlet', 'Village', 'Town', 'Borough', 'City', 'Metropolis'];

function yearFacts(state, year) {
  const hist = state.indicatorHistory ?? {};
  const entries = (state.chronicle?.entries ?? []).filter((e) => e.year === year && e.kind !== 'year');
  const yearEntry = (state.chronicle?.entries ?? []).find((e) => e.kind === 'year' && e.year === year + 1);
  const rulings = [];
  const seen = new Set();
  for (const c of [...(state.cardHistory ?? [])].reverse()) {
    if (c.year !== year || rulings.length >= 4) continue;
    const act = actOf(c);
    const what = clean(lower(cardSubject(c).title), 60);
    if (!act || seen.has(what)) continue;
    seen.add(what);
    rulings.push({act, what, by: c.from && c.from !== 'moot' && INSTITUTIONS[c.from] ? clean(bodyName(state, c.from), 40) : undefined});
  }
  const wellbeing = hist.wellbeing?.[year] ?? state.indicators?.wellbeing;
  const facts = {
    v: 1, type: 'year', year,
    era: ERAS[Math.max(0, Math.min(5, entries.at(-1)?.era ?? state.era ?? 0))],
    archetype: clean(state.archetype ?? '', 24).replace(/-/g, ' ') || undefined,
    people: Number.isFinite(hist.pop?.[year]) ? {start: Math.round(hist.pop[Math.max(0, year - 1)] ?? hist.pop[year]), end: Math.round(hist.pop[year])} : undefined,
    mood: Number.isFinite(wellbeing) ? (wellbeing < 50 ? 'low' : wellbeing < 75 ? 'fair' : 'good') : undefined,
    lines: entries.filter((e) => (e.kind === 'moment' || e.kind === 'line') && !/^you (refused|put off|turned down)/i.test(e.text ?? ''))
      .sort((a, b) => ENTRY_RANK[a.kind] - ENTRY_RANK[b.kind]).slice(0, 4).map((e) => cleanProse(e.text, 180)).filter(Boolean),
    rulings,
    events: Object.keys(state.tags ?? {}).filter((t) => t.startsWith('event:') && state.tags[t] === year && EVENTS[t.slice(6)])
      .slice(0, 4).map((t) => clean(lower(EVENTS[t.slice(6)].title), 48)),
    rules: Object.entries(state.policies ?? {}).filter(([id, p]) => p.level > 0 && p.since === year && POLICIES[id])
      .slice(0, 3).map(([id]) => clean(lower(POLICIES[id].title), 48)),
    bodies: (state.institutions ?? []).filter((b) => b.foundedYear === year || b.dissolvedYear === year).slice(0, 3)
      .map((b) => ({name: clean(bodyName(state, b.kind ?? b.id), 40), change: b.dissolvedYear === year ? 'dissolved' : 'founded'})),
    moods: (state.factions ?? []).filter((f) => f.size > 0 && Math.abs(f.trend ?? 0) >= 0.03).slice(0, 3)
      .map((f) => ({who: clean(f.name.toLowerCase(), 24), mood: moodBand(f.mood ?? 0.6), trend: f.trend > 0 ? 'rising' : 'falling'})),
    template: yearEntry ? cleanProse(yearEntry.text, 320) : undefined,
  };
  return finishPlain(facts);
}

function endFacts(state) {
  const summary = state.chronicle?.summary ?? endSummary(state);
  const entered = state.eraEntered ?? [0];
  const now = state.time.year;
  const hist = state.indicatorHistory ?? {};
  const arc = state.governance?.archetypeArc ?? [];
  const entries = state.chronicle?.entries ?? [];
  const eras = entered.map((from, era) => {
    const to = era + 1 < entered.length ? Math.max(from, entered[era + 1] - 1) : now;
    const archetype = [...arc].reverse().find((a) => a.year <= to)?.archetype;
    const moments = entries.filter((e) => e.era === era && (e.kind === 'moment' || (e.kind === 'line' && e.refs?.event)));
    const step = Math.max(1, Math.floor(moments.length / 3));
    const ruled = {approved: 0, refused: 0};
    for (const c of state.cardHistory ?? []) {
      if (c.year < from || c.year > to || c.kind === 'event') continue;
      if (c.outcome === 'accepted') ruled.approved++;
      else if (c.outcome === 'refused') ruled.refused++;
    }
    return {
      era, name: ERA_NAMES[era] ?? 'Town', from, to,
      archetype: archetype ? clean(archetype, 24).replace(/-/g, ' ') : undefined,
      people: Number.isFinite(hist.pop?.[to]) ? Math.round(hist.pop[to]) : undefined,
      moments: moments.filter((_, i) => i % step === 0).slice(0, 3).map((e) => cleanProse(e.text, 160)).filter(Boolean),
      founded: (state.institutions ?? []).filter((b) => b.foundedYear >= from && b.foundedYear <= to && b.foundedYear > 0)
        .slice(0, 3).map((b) => clean(bodyName(state, b.kind ?? b.id), 40)),
      ruled: ruled.approved || ruled.refused ? ruled : undefined,
    };
  }).slice(0, 6);
  return finishPlain({
    v: 1, type: 'end', year: now,
    archetype: clean(state.archetype ?? '', 24).replace(/-/g, ' '),
    eraName: ERA_NAMES[state.era] ?? 'Town',
    people: Math.round(state.indicators?.pop ?? 0),
    rules: Object.values(state.policies ?? {}).filter((p) => p.level > 0).length,
    eras,
    became: (summary.sentences ?? []).slice(0, 4).map((t) => cleanProse(t, 180)),
    ...((summary.centres ?? []).length >= 2 ? {centres: summary.centres.slice(0, 6).map((c, i) => ({
      id: c.id, name: clean(c.name, 40), kind: clean(c.kind ?? '', 16), people: Math.max(0, Math.round(c.pop ?? 0)),
      character: clean(c.character ?? '', 24).replace(/-/g, ' '),
      status: i === 0 ? 'seat' : c.mergedInto != null ? 'merged' : c.federated ? 'federated' : 'apart',
      line: cleanProse(c.line, 180),
    }))} : {}),
    refused: [...new Set((summary.refused ?? []).map((id) => (INSTITUTIONS[id] ? bodyName(state, id) : null)).filter(Boolean))].slice(0, 4).map((n) => clean(n, 40)),
  });
}

export function chronicleFacts(state, {year, end = false} = {}) {
  if (!state) return null;
  if (end) return endFacts(state);
  return yearFacts(state, year ?? state.time.year - 1);
}

// Year lines that still want prose (newest first) and whether the end page does.
export const yearEntriesNeedingProse = (state) =>
  (state?.chronicle?.entries ?? []).filter((e) => e.kind === 'year' && e.needsProse && !e.prose).reverse();
export const summaryNeedsProse = (state) => !!state?.chronicle?.summary?.needsProse && !state.chronicle.summary.prose;

// Like finish() without the entity budget.
function finishPlain(facts) {
  const prune = (v) => {
    if (Array.isArray(v)) return v.map(prune);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined || x === null || (Array.isArray(x) && !x.length) || (x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length)) continue;
        out[k] = prune(x);
      }
      return out;
    }
    return v;
  };
  return prune(facts);
}
