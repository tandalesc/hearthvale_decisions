// Advisers (docs/design/governance-budgets-advisors.md §4): a bench of up to
// three seats at the town hall, one per area, filled from real townsfolk. An
// adviser answers the cards of the bodies in its area by a fixed, explainable
// scoring of its beliefs, and each answer waits a season (a month for a
// blunt one) so you can let it stand or change it. Per seat: Advise only,
// Routine (the default) or All in their area. You may dismiss an adviser;
// one may resign if you overrule them too often, and they retire after
// twenty years or when their household leaves.
//
// Areas are matched by tags, not lists: a body belongs to the area that owns
// most of the categories of what it drafts (its templates and its rules),
// ties to its faction, then its axis, then works, land, learning (§4.1).
//
// state.advisers = {
//   seats: [{id: 's1'|'s2'|'s3', area: null|'land'|'works'|'learning', adviserId, mode: 'advise'|'routine'|'all', openedYear}],
//   roster: [adviser], slate: {year, seatId, salt, candidates: [adviser]} | null,
//   barred: {householdId: untilYear}, nextId, redrawYear, unlockedYear
// }
// adviser = {id, name, householdId, background: {label, trade, centreId, old}, beliefs: {industry, market,
//   innovation, authority, faith, thrift}, issues: [{policy, stance}], temper, salary, hiredYear, seatId, area,
//   leftYear?, leftWhy?, stats: {answered, stood, changed, spent, byYear: [{y, standing, answered, changed}]},
//   year: {answered, changed, stood, against}, start: {patience, metrics: {bodyId: [m1, m2]}}}
// card.advice = {adviserId, option, factor?, rationale: [{term, text, weight}], month, dueMonth, act}
//
// No random numbers: slates vary by hash32(seed, year, household); the scorer is a pure argmax.
// Salaries are paid monthly from the treasury to the adviser's household ('adviser-salary').

import {monthIndex} from './clock.js';
import {hash32} from './rng.js';
import {pay} from './economy.js';
import {POLICIES, TRAITS, levelOf, fiscalBase} from './policies.js';
import {addChronicle} from './chronicle.js';
import {FACTIONS, factionGroup, isNewcomer, nudgeMood} from './factions.js';
import {opinionOf} from './opinion.js';
import {INSTITUTIONS, TEMPLATES, METRICS, bodyOf, focusBody} from './institutions.js';
import {personName} from './narrative-facts.js';
import {localStances} from './decisions/scheduler.js';
import {askOf, seasonRoom, grantedThisSeason, ASK_FIRST, TRIMS} from './budgets.js';
import {coin} from './text/voice.js';

export const ADVISER_ERA = 4;
export const ADVISER_MIN_BODIES = 7;
export const SEAT_BODIES = [7, 10, 10];
export const SLATE_POOL = 12;
export const SERVE_YEARS = 20;
export const BARRED_YEARS = 10;
export const MODES = ['advise', 'routine', 'all'];
export const AREAS = {
  land: {name: 'Land, trade and labour', short: 'Land and trade', categories: ['food', 'land', 'trade', 'labour', 'tax']},
  works: {name: 'Works, river and order', short: 'Works and order', categories: ['infrastructure', 'environment', 'civic', 'health']},
  learning: {name: 'Faith, learning and festivity', short: 'Faith and learning', categories: ['faith', 'education']},
};
const AREA_ORDER = ['works', 'land', 'learning'];
const FACTION_AREA = {farmers: 'land', crafters: 'land', merchants: 'land', labourers: 'land', scholars: 'learning', clergy: 'learning'};
const CATEGORY_AREA = Object.fromEntries(Object.entries(AREAS).flatMap(([a, d]) => d.categories.map((c) => [c, a])));

// The area a kind of body belongs to (null for the Moot).
const areaCache = new Map();
export function areaOf(kind) {
  if (!kind || kind === 'moot' || !INSTITUTIONS[kind]) return null;
  if (areaCache.has(kind)) return areaCache.get(kind);
  const def = INSTITUTIONS[kind];
  const score = {land: 0, works: 0, learning: 0};
  for (const t of def.templates ?? []) { const a = CATEGORY_AREA[TEMPLATES[t]?.category]; if (a) score[a]++; }
  for (const p of def.policies ?? []) { const a = CATEGORY_AREA[POLICIES[p]?.category]; if (a) score[a]++; }
  const best = Math.max(...Object.values(score));
  let tied = Object.keys(score).filter((a) => score[a] === best);
  if (tied.length > 1 && FACTION_AREA[def.faction] && tied.includes(FACTION_AREA[def.faction])) tied = [FACTION_AREA[def.faction]];
  // Then a lean mostly toward (or against) order puts it with works.
  const axis = def.axis ?? {};
  const authority = Math.abs(axis.authority ?? 0);
  if (tied.length > 1 && authority > 0 && Object.values(axis).every((v) => Math.abs(v) <= authority) && tied.includes('works')) tied = ['works'];
  const area = AREA_ORDER.find((a) => tied.includes(a));
  areaCache.set(kind, area);
  return area;
}

const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const h32 = (...xs) => xs.reduce((h, x) => hash32((h ^ (x >>> 0)) >>> 0), 2166136261);
const unit = (...xs) => h32(...xs) / 4294967296;

const sitting = (state) => (state.institutions ?? []).filter((b) => b.kind !== 'moot' && b.status === 'active');

// ---------------------------------------------------------------------------
// State, unlock, seats
// ---------------------------------------------------------------------------

export function initAdvisers(state) {
  const a = (state.advisers ??= {});
  a.seats ??= [];
  a.roster ??= [];
  a.slate ??= null;
  a.barred ??= {};
  a.nextId ??= 1;
  a.redrawYear ??= null;
  a.unlockedYear ??= null;
  return a;
}

// City, seven sitting bodies, and one budget season done (the unlock stays once it came).
export function advisersReady(state) {
  if (state.advisers?.unlockedYear != null) return true;
  return (state.era ?? 0) >= ADVISER_ERA && sitting(state).length >= ADVISER_MIN_BODIES && (state.governance?.budgets?.seasons ?? 0) >= 1;
}

// Seats the town has now: the first at the unlock, the second at ten bodies or
// Metropolis, the third at Metropolis with ten bodies.
export function seatCount(state) {
  if (!advisersReady(state)) return 0;
  const n = sitting(state).length, metro = (state.era ?? 0) >= 5;
  return 1 + (n >= SEAT_BODIES[1] || metro ? 1 : 0) + (metro && n >= SEAT_BODIES[2] ? 1 : 0);
}

export const adviserById = (state, id) => state.advisers?.roster?.find((x) => x.id === id) ?? null;
export const seatOf = (state, area) => state.advisers?.seats?.find((s) => s.area === area && s.adviserId) ?? null;
// The seated adviser for a body's cards (none for the Moot, or an empty area).
export function adviserFor(state, bodyId) {
  const body = bodyOf(state, bodyId);
  const area = body ? areaOf(body.kind) : null;
  const seat = area ? seatOf(state, area) : null;
  return seat ? {seat, adviser: adviserById(state, seat.adviserId)} : null;
}

// Yearly (governance year()): open seats, pay nothing here, stats and departures.
export function advisersYearly(state) {
  initAdvisers(state);
  const a = state.advisers;
  if (!advisersReady(state)) return;
  if (a.unlockedYear == null) {
    a.unlockedYear = state.time.year;
    addChronicle(state, 'The council takes on advisers to share the load.', 'moment', {advisers: 'unlocked'});
  }
  yearStats(state);
  departures(state);
  openSeats(state);
}

function openSeats(state) {
  const a = state.advisers;
  const want = seatCount(state);
  while (a.seats.length < want) {
    const seat = {id: `s${a.seats.length + 1}`, area: null, adviserId: null, mode: 'routine', openedYear: state.time.year};
    a.seats.push(seat);
    if (a.seats.length > 1) addChronicle(state, 'A new seat opens on the advisers\' bench.', 'line', {advisers: 'seat', seat: seat.id});
  }
  // An empty seat with no slate gets one.
  const empty = a.seats.find((s) => !s.adviserId);
  if (empty && (!a.slate || !a.seats.some((s) => s.id === a.slate.seatId && !s.adviserId))) drawSlate(state, empty.id);
}

// ---------------------------------------------------------------------------
// Candidates from real townsfolk (§4.2)
// ---------------------------------------------------------------------------

const TRADE_AXES = {
  farm: {industry: -0.5}, craft: {market: -0.3, innovation: -0.3}, trade: {market: 0.6}, gentry: {market: 0.6},
  labour: {market: -0.6}, clerical: {innovation: 0.5, authority: 0.3}, clergy: {innovation: -0.5},
};
const TRADE_LABEL = {farm: 'Farmer', craft: 'Master maker', trade: 'Merchant', labour: 'Labourer', clerical: 'Clerk', clergy: 'Chaplain', gentry: 'Gentry', none: 'Of no trade'};
const EX_LABEL = {farm: 'Ex-farmer', craft: 'Ex-maker', trade: 'Ex-merchant', labour: 'Ex-labourer', clerical: 'Ex-clerk', clergy: 'Ex-chaplain', gentry: 'Once gentry'};
const TEMPERS = ['Tactful', 'Blunt', 'Shrewd', 'Steady'];
const wealthBand = (state, h) => {
  const [t1, t2] = state.bands?.wealth ?? [60, 200];
  const w = h.wealth ?? h.savings ?? 0;
  return w < t1 ? 0 : w < t2 ? 1 : 2;
};

// The trade a household had before, if its story says so.
const pastTrade = (h) => h.pastTrade ?? [...(h.story ?? [])].reverse().find((s) => s.kind === 'trade' && s.from && s.from !== h.trade)?.from ?? null;

function standingOf(state, h) {
  const band = wealthBand(state, h);
  return (band === 2 ? 2 : band === 1 ? 1 : 0) + (['clerical', 'clergy', 'gentry'].includes(h.trade) ? 1.5 : 0) +
    Math.min(1.5, (state.time.year - (h.formedYear ?? state.time.year)) / 30) + unit(state.seed ?? 1, h.id, 3) * 0.5;
}

// How a trade took the rules lately (react_to_policy slice answers): protest leans away from order.
function tradeLean(state, trade) {
  const p = state.governance?.sliceAnswers?.react_to_policy?.[`trade=${trade}`]?.probs;
  if (!p) return 0;
  return clamp(((p.protest ?? 0) + (p.strike ?? 0) + (p.leave ?? 0)) - (p.support ?? 0), -1, 1);
}

function candidateFrom(state, h, salt) {
  const year = state.time.year;
  const seed = state.seed ?? 1;
  const beliefs = {};
  for (const k of TRAITS) {
    const base = TRADE_AXES[h.trade]?.[k] ?? 0;
    const jitter = (unit(seed, h.id, salt, k.length, k.charCodeAt(0)) - 0.5) * 0.6;
    beliefs[k] = r2(clamp(base + jitter + 0.2 * (state.traits?.[k] ?? 0) + (k === 'authority' ? -0.3 * tradeLean(state, h.trade) : 0)));
  }
  beliefs.faith = r2(h.faithBand === 0 ? -0.6 : h.faithBand === 2 ? 0.6 : (unit(seed, h.id, 11) - 0.5) * 0.4);
  const income = Math.max(1, h.income ?? 1);
  const band = wealthBand(state, h);
  beliefs.thrift = r2(band >= 1 && (h.savings ?? 0) >= 24 * income ? 0.6 : band === 0 ? -0.4 : (unit(seed, h.id, 13) - 0.5) * 0.6);
  const past = pastTrade(h);
  const old = year - (h.formedYear ?? year) >= 40;
  const labels = [past ? EX_LABEL[past] ?? `Once ${past}` : TRADE_LABEL[h.trade] ?? 'Townsfolk'];
  const mainCentre = state.centres?.[0]?.id ?? null;
  if (h.centreId != null && h.centreId !== mainCentre) labels.push(`From ${state.centres?.find((c) => c.id === h.centreId)?.name ?? 'the valley'}`);
  if (old) labels.push('Old family');
  const issues = petIssues(state, h.trade, beliefs);
  const temper = TEMPERS[h32(seed, h.id, 17) % TEMPERS.length];
  const fb = fiscalBase(state);
  const salary = Math.round(fb * (0.015 + 0.01 * (['gentry', 'clerical'].includes(h.trade) ? 1 : 0) + 0.0025 * issues.length) * (0.9 + 0.2 * unit(seed, h.id, 19)));
  const p = {id: h.id * 7 + 1};
  return {
    id: null, name: personName(state, p, h), householdId: h.id,
    background: {label: labels.join(' · '), trade: h.trade, pastTrade: past, centreId: h.centreId ?? null, old},
    beliefs, issues, temper, salary, standing: r2(standingOf(state, h)),
  };
}

// One or two policies they feel strongly about: those that help or hurt their
// trade, else the one whose trait pushes most agree or clash with them.
function petIssues(state, trade, beliefs) {
  const scored = [];
  for (const [id, def] of Object.entries(POLICIES)) {
    if (def.oneOff) continue;
    let s = 0;
    if (def.helps?.includes(trade)) s += 1;
    if (def.hurts?.includes(trade)) s -= 1;
    let lean = 0;
    for (const k of TRAITS) lean += (beliefs[k] ?? 0) * (Array.isArray(def.deltas?.[k]) ? def.deltas[k][0] : def.deltas?.[k] ?? 0) * 150;
    s += clamp(lean, -0.8, 0.8);
    if (Math.abs(s) >= 0.6) scored.push({policy: id, stance: s > 0 ? 1 : -1, w: Math.abs(s)});
  }
  scored.sort((a, b) => b.w - a.w || (a.policy < b.policy ? -1 : 1));
  return scored.slice(0, 2).map(({policy, stance}) => ({policy, stance}));
}

const distance = (a, b) => Object.keys(a.beliefs).reduce((n, k) => n + Math.abs((a.beliefs[k] ?? 0) - (b.beliefs[k] ?? 0)), 0);

// A slate for a seat: the most standing first, then the most different.
export function drawSlate(state, seatId, {salt = 0} = {}) {
  initAdvisers(state);
  const a = state.advisers;
  const year = state.time.year;
  const benched = new Set(a.roster.filter((x) => x.leftYear == null).map((x) => x.householdId));
  const pool = (state.households ?? [])
    .filter((h) => (h.lifeStage === 'family' || h.lifeStage === 'elder') && year - (h.formedYear ?? year) >= 8 &&
      !isNewcomer(state, h) && !benched.has(h.id) && !((a.barred[h.id] ?? -Infinity) > year))
    .map((h) => ({h, s: standingOf(state, h) + unit(state.seed ?? 1, h.id, year, salt) * 1.2}))
    .sort((x, y) => y.s - x.s || x.h.id - y.h.id)
    .slice(0, SLATE_POOL)
    .map(({h}) => candidateFrom(state, h, salt));
  const n = (state.era ?? 0) >= 5 ? 4 : 3;
  const picked = pool.length ? [pool[0]] : [];
  while (picked.length < n && picked.length < pool.length) {
    const rest = pool.filter((c) => !picked.includes(c));
    rest.sort((x, y) => Math.min(...picked.map((p) => distance(y, p))) - Math.min(...picked.map((p) => distance(x, p))) || x.householdId - y.householdId);
    picked.push(rest[0]);
  }
  picked.forEach((c, i) => { c.id = `cand:${year}:${salt}:${i}`; });
  a.slate = {year, seatId, salt, candidates: picked};
  return a.slate;
}

// "See others": a fresh slate, at most once a year.
export function redrawSlate(state) {
  const a = initAdvisers(state);
  if (!a.slate) return {ok: false, reason: 'no-slate'};
  if (a.redrawYear === state.time.year) return {ok: false, reason: 'once-a-year', text: 'You can ask for others once a year.'};
  a.redrawYear = state.time.year;
  drawSlate(state, a.slate.seatId, {salt: (a.slate.salt ?? 0) + 1});
  return {ok: true};
}

// Hire a candidate for the slate's seat, in an area no other seat holds.
export function hireAdviser(state, candidateId, area) {
  const a = initAdvisers(state);
  const c = a.slate?.candidates.find((x) => x.id === candidateId);
  const seat = a.seats.find((s) => s.id === a.slate?.seatId);
  if (!c || !seat || seat.adviserId) return {ok: false, reason: 'no-card', text: 'That candidate is no longer free.'};
  const taken = new Set(a.seats.filter((s) => s.adviserId).map((s) => s.area));
  const pick = area ?? seat.area ?? AREA_ORDER.find((x) => !taken.has(x));
  if (!AREAS[pick] || taken.has(pick)) return {ok: false, reason: 'no-option', text: 'Another adviser holds that area.'};
  const adviser = {...c, id: `a${a.nextId++}`, hiredYear: state.time.year, seatId: seat.id, area: pick,
    stats: {answered: 0, stood: 0, changed: 0, spent: 0, byYear: []}, year: {answered: 0, changed: 0, stood: 0, against: 0},
    start: tenureStart(state, pick)};
  delete adviser.standing;
  a.roster.push(adviser);
  Object.assign(seat, {area: pick, adviserId: adviser.id});
  a.slate = null;
  const once = adviser.background.pastTrade ? `, once a ${String(adviser.background.pastTrade).replace('farm', 'farmer').replace('craft', 'maker')},` : '';
  addChronicle(state, `${adviser.name}${once} joins the council as adviser for ${AREAS[pick].short.toLowerCase()}.`, 'decision', {advisers: 'hired', adviser: adviser.id});
  // A pet issue standing against them: they press the body that drafts it to bring it back.
  for (const issue of adviser.issues) {
    const lvl = levelOf(state, issue.policy);
    if ((issue.stance < 0 && lvl > 0) || (issue.stance > 0 && lvl === 0)) {
      const by = (POLICIES[issue.policy]?.by ?? []).map((k) => bodyOf(state, k)).find((b) => b?.status === 'active' && areaOf(b.kind) === pick);
      if (by) focusBody(state, by.id, POLICIES[issue.policy].category, 0.35);
    }
  }
  // Openings left: the next empty seat gets its slate.
  const empty = a.seats.find((s) => !s.adviserId);
  if (empty) drawSlate(state, empty.id);
  return {ok: true, adviser: adviser.id};
}

function tenureStart(state, area) {
  const bodies = sitting(state).filter((b) => areaOf(b.kind) === area);
  const metrics = {};
  for (const b of bodies) metrics[b.id] = (INSTITUTIONS[b.kind]?.metrics ?? []).slice(0, 2).map((m) => METRICS[m]?.read(state, b) ?? 0);
  return {metrics, patience: bodies.length ? r2(bodies.reduce((n, b) => n + b.patience, 0) / bodies.length) : 1};
}

export function setAdviserMode(state, seatId, mode) {
  const seat = initAdvisers(state).seats.find((s) => s.id === seatId);
  if (!seat || !MODES.includes(mode)) return {ok: false, reason: 'no-option'};
  seat.mode = mode;
  return {ok: true};
}

// ---------------------------------------------------------------------------
// Answering (§4.4): a pure argmax over the options, explained by its two largest terms
// ---------------------------------------------------------------------------

const MINOR = new Set(['not_now', 'refuse', 'neither', 'negotiate', 'refuse_anyway']);
const atLevel = (v, level) => (Array.isArray(v) ? v[Math.min(Math.max(1, level), v.length) - 1] ?? 0 : v ?? 0);
const TRAIT_WORDS = {
  industry: ['For industry', 'For the fields'], market: ['For markets', 'For the commons'],
  innovation: ['For new ways', 'For the old ways'], authority: ['For order', 'For freedom'],
};

// Each option's score, term by term.
export function scoreOptions(state, adviser, card) {
  const b = adviser.beliefs;
  const body = bodyOf(state, card.from);
  const fb = Math.max(1, fiscalBase(state));
  const op = opinionOf(state, localStances(state, card));
  const opinion = clamp((op.for ?? 0) - (op.against ?? 0), -0.5, 0.5);
  const out = [];
  for (const o of card.options) {
    if (o.key === 'negotiate' && card.kind !== 'demand') continue;
    const terms = [];
    const add = (term, weight, text) => { if (Math.abs(weight) > 1e-6) terms.push({term, weight: r2(weight), text}); };
    if (o.key === 'not_now') { out.push({option: o.key, score: 0, terms}); continue; }
    if (MINOR.has(o.key)) {
      add('cost-of-refusing', o.key === 'negotiate' ? -0.05 : -0.2, 'Refusing costs the body\'s patience');
      // What the town and their own lean say against doing it.
      add('town', -0.4 * opinion, opinion > 0 ? 'The town wants it' : 'The town is against it');
      out.push({option: o.key, score: terms.reduce((n, t) => n + t.weight, 0), terms});
      continue;
    }
    // Rules: the trait pushes at the new level.
    for (const e of o.effects ?? []) {
      if (!e.policy) continue;
      const def = POLICIES[e.policy];
      const before = levelOf(state, e.policy);
      const level = e.level === '+1' ? before + 1 : e.level === '-1' ? before - 1 : e.level ?? before + 1;
      const dir = Math.sign(level - before) || 1;
      for (const k of TRAITS) {
        const d = atLevel(def.deltas?.[k], Math.max(level, before)) * dir;
        if (d) add(`axis:${k}`, clamp(b[k] * d * 150, -1, 1), TRAIT_WORDS[k][(b[k] >= 0) === (d >= 0) ? 0 : 1]);
      }
      if (def.category === 'faith') add('faith', 0.5 * b.faith * dir, b.faith >= 0 ? 'Keeps the chapel strong' : 'Cool on the chapel');
      for (const issue of adviser.issues) {
        if (issue.policy === e.policy) add('issue', issue.stance * dir, `${issue.stance * dir > 0 ? 'For' : 'Against'} ${def.title.toLowerCase()}`);
      }
    }
    // A plan: the body's own lean, and what it costs.
    const cost = o.cost ?? 0;
    if (cost > 0) {
      const axis = INSTITUTIONS[body?.kind]?.axis ?? {};
      let lean = 0;
      for (const k of TRAITS) lean += (axis[k] ?? 0) * (b[k] ?? 0);
      add('body-lean', 0.4 * clamp(lean), lean >= 0 ? `Likes what the ${body?.name ?? 'body'} stands for` : `Wary of what the ${body?.name ?? 'body'} stands for`);
      add('thrift', -b.thrift * (cost / fb) * 4, b.thrift > 0 ? `Careful with coin: ${coin(cost)} is dear` : 'Spend it on people');
      const cat = TEMPLATES[card.templateId]?.category;
      if (cat === 'faith') add('faith', 0.4 * b.faith, b.faith >= 0 ? 'Keeps the chapel strong' : 'Cool on the chapel');
    }
    add('town', 0.8 * opinion, opinion >= 0 ? 'The town wants it' : 'The town is against it');
    const trade = adviser.background.trade;
    const helps = (card.helps ?? []).includes(trade), hurts = (card.hurts ?? []).includes(trade);
    if (helps || hurts) add('trade', 0.4 * ((helps ? 1 : 0) - (hurts ? 1 : 0)), helps ? 'Good for their own trade' : 'Hard on their own trade');
    if (body && body.kind !== 'moot') add('body', 0.3 * ((body.power ?? 0.5) - 0.5) * 2, (body.power ?? 0.5) >= 0.5 ? `Keeps a strong ${body.name} sweet` : `The ${body.name} carries little weight`);
    out.push({option: o.key, score: r2(terms.reduce((n, t) => n + t.weight, 0)), terms});
  }
  return out;
}

export function advise(state, adviser, card) {
  if (card.kind === 'budget') return adviseBudget(state, adviser, card);
  const scored = scoreOptions(state, adviser, card);
  if (!scored.length) return null;
  scored.sort((x, y) => y.score - x.score || (x.option < y.option ? -1 : 1));
  const best = scored[0];
  // Why: the answer's two largest terms; turning a plan down (no terms of its
  // own), the two that weigh most against doing it.
  const byWeight = (terms) => [...terms].sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight) || (x.term < y.term ? -1 : 1));
  let rationale = byWeight(best.terms.filter((t) => t.term !== 'cost-of-refusing'));
  if (MINOR.has(best.option)) {
    const doing = scored.find((x) => !MINOR.has(x.option));
    const against = byWeight((doing?.terms ?? []).filter((t) => t.weight < 0));
    if (against.length) rationale = against;
  }
  return {option: best.option, rationale: rationale.slice(0, 2)};
}

// Budgets (§4.7): careful advisers trim; over the season's room they trim to
// fit (the depth "Trim all to fit" would take); bodies they are wary of get less.
function adviseBudget(state, adviser, card) {
  const b = card.data.budget;
  const body = bodyOf(state, card.from);
  const asked = askOf(b);
  const open = state.docket.filter((c) => c.kind === 'budget');
  const left = Math.max(0, seasonRoom(state) - grantedThisSeason(state));
  const all = open.reduce((n, c) => n + askOf(c.data.budget), 0);
  let lean = 0;
  for (const k of TRAITS) lean += (INSTITUTIONS[body?.kind]?.axis?.[k] ?? 0) * (adviser.beliefs[k] ?? 0);
  const thrift = adviser.beliefs.thrift;
  if (all > left && all > 0) {
    const factor = Math.round((left / all) * 1000) / 1000;
    return {option: 'trim', factor, rationale: [
      {term: 'room', weight: -1, text: `The asks are over the town's room: trims all to fit (${Math.round(factor * 100)}%)`},
      ...(thrift > 0 ? [{term: 'thrift', weight: -thrift, text: 'Careful with coin'}] : []),
    ]};
  }
  if (thrift >= 0.4 && asked > 0) return {option: 'trim90', rationale: [{term: 'thrift', weight: -thrift, text: `Careful with coin: ${coin(asked)} can be less`}]};
  if (lean < -0.4) return {option: 'trim75', rationale: [{term: 'body-lean', weight: lean, text: `Wary of what the ${body?.name ?? 'body'} stands for`}]};
  return {option: 'approve', rationale: [{term: 'room', weight: 0.5, text: 'It fits the town\'s room'}, ...(lean > 0.2 ? [{term: 'body-lean', weight: lean, text: `Likes what the ${body?.name ?? 'body'} stands for`}] : [])]};
}

// Whether a seat's adviser answers a card (act) or only says what it would do.
function acts(state, seat, adviser, card) {
  const mode = seat.mode;
  if (mode === 'advise' || card.kind === 'event' || card.data?.forms || card.data?.revive) return false;
  if (card.kind === 'petition') return false;
  if (ASK_FIRST.has(card.templateId)) return false;
  const pet = card.data?.policy && adviser.issues.some((i) => i.policy === card.data.policy);
  if (card.kind === 'budget' || card.kind === 'report') return true;
  if (card.kind === 'proposal') return mode === 'all' || !pet;
  if (card.kind === 'demand') return mode === 'all';
  if (card.kind === 'debate') return mode === 'all' && (card.data?.sides ?? []).every((s) => areaOf(bodyOf(state, s)?.kind) === adviser.area);
  return false;
}

// docket.addCard calls this for a card that is about to wait for you.
// Stages (or recommends) the seated adviser's answer on it. Returns true when staged to act.
export function adviseCard(state, card) {
  if (!state.advisers?.roster?.length || card.kind === 'report' || card.from === 'moot' || card.advice) return false;
  const found = adviserFor(state, card.from);
  if (!found?.adviser) return false;
  const {seat, adviser} = found;
  const answer = advise(state, adviser, card);
  if (!answer) return false;
  const m = monthIndex(state.time);
  const act = acts(state, seat, adviser, card);
  const due = adviser.temper === 'Blunt' ? m + 1 : Math.ceil((m + 3) / 3) * 3;
  card.advice = {adviserId: adviser.id, option: answer.option, ...(answer.factor != null ? {factor: answer.factor} : {}),
    rationale: answer.rationale, month: m, dueMonth: due, act};
  return act;
}

// Monthly, from docketMonthly: staged answers whose time has come are applied,
// in docket order, as the adviser's ruling. rule(state, id, key, {adviser}) / answerBudget.
export function applyDue(state, {rule, answerBudget}) {
  const m = monthIndex(state.time);
  for (const card of [...state.docket]) {
    const adv = card.advice;
    if (!adv?.act || adv.dueMonth > m) continue;
    applyAdvice(state, card, {rule, answerBudget});
  }
}

export function applyAdvice(state, card, {rule, answerBudget}) {
  const adv = card.advice;
  const adviser = adviserById(state, adv.adviserId);
  if (!adviser || adviser.leftYear != null) { delete card.advice; return {ok: false, reason: 'no-card'}; }
  const option = card.options.find((o) => o.key === adv.option);
  // What the chest cannot pay stays with you.
  if (adv.option !== 'trim' && (option?.cost ?? 0) > (state.treasury ?? 0)) { adv.act = false; return {ok: false, reason: 'no-coin'}; }
  const title = card.kind === 'budget' ? `the ${bodyOf(state, card.from)?.name ?? 'body'}'s budget` : card.title.toLowerCase();
  const res = card.kind === 'budget'
    ? answerBudget(state, card.id, adv.option, {factor: adv.factor ?? null, adviser: adviser.id})
    : rule(state, card.id, adv.option, {adviser: adviser.id});
  if (res?.ok) {
    const label = adv.option === 'trim' ? 'trimmed to fit' : card.options.find((o) => o.key === adv.option)?.label?.toLowerCase() ?? adv.option;
    addChronicle(state, `${adviser.name} answered for you: ${title}, ${label}.`, 'line', {card: card.id, adviser: adviser.id, adviserAnswer: true});
    if (adviser.temper === 'Shrewd' && (option?.cost ?? 0) > 0) pay(state, 'external', 'treasury', 0.05 * option.cost, 'adviser-haggle');
  }
  return res;
}

// "Let it stand": apply the staged answer now.
export function letStand(state, cardId, fns) {
  const card = state.docket.find((c) => c.id === cardId);
  if (!card?.advice) return {ok: false, reason: 'no-card'};
  card.advice.act = true;
  const res = applyAdvice(state, card, fns);
  if (res?.ok) {
    const adviser = adviserById(state, card.advice?.adviserId) ?? null;
    if (adviser) { adviser.stats.stood++; adviser.year.stood++; }
  }
  return res;
}

// After any ruling on an advised card: the adviser's books.
// byAdviser: the adviser applied it; else the player ruled (changed if a different option).
export function noteRuling(state, card, optionKey, {byAdviser = false} = {}) {
  const adv = card.advice;
  if (!adv) return null;
  const adviser = adviserById(state, adv.adviserId);
  if (!adviser) return null;
  const changed = !byAdviser && adv.act !== false && optionKey !== adv.option;
  const counted = byAdviser || adv.act;
  if (counted) {
    adviser.stats.answered++;
    adviser.year.answered++;
    if (changed) { adviser.stats.changed++; adviser.year.changed++; }
    else if (!byAdviser) { adviser.stats.stood++; adviser.year.stood++; }   // you chose what they would have
    const cost = card.options.find((o) => o.key === optionKey)?.cost ?? 0;
    if (byAdviser) adviser.stats.spent += cost;
  }
  // A rule enacted against their pet issue.
  const opt = card.options.find((o) => o.key === optionKey);
  for (const e of opt?.effects ?? []) {
    const issue = e.policy && adviser.issues.find((i) => i.policy === e.policy);
    if (!issue) continue;
    const up = e.level === '-1' ? -1 : 1;
    if (issue.stance * up < 0 && !byAdviser) adviser.year.against++;
  }
  return {adviserId: adviser.id, changed, byAdviser};
}

// ---------------------------------------------------------------------------
// Pay, performance, departures
// ---------------------------------------------------------------------------

// Monthly: salaries to their households.
export function advisersMonthly(state) {
  for (const adviser of state.advisers?.roster ?? []) {
    if (adviser.leftYear != null) continue;
    if (!state.households.some((h) => h.id === adviser.householdId)) continue;
    pay(state, 'treasury', `household:${adviser.householdId}`, adviser.salary / 12, 'adviser-salary');
  }
}

// The Standing score (§4.5), 0-100.
export function standingScore(state, adviser) {
  const a = adviser.year ?? {};
  const bodies = sitting(state).filter((b) => areaOf(b.kind) === adviser.area);
  const rarely = a.answered > 0 ? 1 - a.changed / a.answered : 0.5;
  let moves = 0, n = 0;
  for (const b of bodies) {
    const was = adviser.start?.metrics?.[b.id];
    if (!was) continue;
    (INSTITUTIONS[b.kind]?.metrics ?? []).slice(0, 2).forEach((m, i) => {
      const now = METRICS[m]?.read(state, b) ?? 0;
      if (Math.abs(was[i] ?? 0) > 1e-9) { moves += clamp((now - was[i]) / Math.abs(was[i]), -1, 1); n++; }
    });
  }
  const dash = clamp(0.5 + (n ? moves / n : 0) / 0.4, 0, 1);
  const groups = new Set(bodies.map((b) => INSTITUTIONS[b.kind]?.faction).filter(Boolean));
  const rows = state.approval?.rows?.faction ?? {};
  const approvals = [...groups].map((f) => rows[f]?.v).filter(Number.isFinite);
  const approval = approvals.length ? approvals.reduce((x, y) => x + y, 0) / approvals.length : 0.5;
  const patience = bodies.length ? bodies.reduce((x, b) => x + (b.patience ?? 1), 0) / bodies.length : 1;
  const room = seasonRoom(state), granted = grantedThisSeason(state);
  const within = granted > room && granted > 0 ? room / granted : 1;
  return Math.round(30 * rarely + 25 * dash + 20 * approval + 15 * patience + 10 * within);
}

function yearStats(state) {
  const y = state.time.year - 1;
  for (const adviser of state.advisers.roster) {
    if (adviser.leftYear != null) continue;
    const standing = standingScore(state, adviser);
    adviser.stats.byYear.push({y, standing, answered: adviser.year.answered, changed: adviser.year.changed});
    if (adviser.stats.byYear.length > 60) adviser.stats.byYear.splice(0, adviser.stats.byYear.length - 60);
    adviser.lastYear = {...adviser.year};
    adviser.year = {answered: 0, changed: 0, stood: 0, against: 0};
  }
}

function departures(state) {
  for (const adviser of state.advisers.roster) {
    if (adviser.leftYear != null) continue;
    const last = adviser.lastYear ?? {answered: 0, changed: 0, against: 0};
    const share = last.answered >= 3 ? last.changed / last.answered : 0;
    if (!state.households.some((h) => h.id === adviser.householdId)) leave(state, adviser, 'left', `${adviser.name} has left town. The seat is empty.`);
    else if (state.time.year - adviser.hiredYear >= SERVE_YEARS) leave(state, adviser, 'retired', `${adviser.name} retires from the advisers' bench after twenty years.`);
    else if (adviser.temper !== 'Steady' && (share >= 0.6 || (share > 0.5 && last.against > 0))) {
      const issue = adviser.issues.find(() => last.against > 0);
      leave(state, adviser, 'resigned', `${adviser.name} resigned: the council would not hear them${issue ? ` on ${POLICIES[issue.policy].title.toLowerCase()}` : ''}.`);
    }
  }
}

function leave(state, adviser, why, line) {
  const a = state.advisers;
  adviser.leftYear = state.time.year;
  adviser.leftWhy = why;
  const seat = a.seats.find((s) => s.adviserId === adviser.id);
  if (seat) seat.adviserId = null;
  // Their staged answers go back to you.
  for (const c of state.docket) if (c.advice?.adviserId === adviser.id) delete c.advice;
  addChronicle(state, line, why === 'retired' || why === 'left' ? 'line' : 'moment', {advisers: why, adviser: adviser.id});
  if (seat && (!a.slate || a.slate.seatId !== seat.id)) drawSlate(state, seat.id);
}

// Dismiss (§4.6): half a year's salary, their answers withdrawn, a new slate, and
// they are not offered again for ten years.
export function dismissAdviser(state, adviserId) {
  const a = initAdvisers(state);
  const adviser = adviserById(state, adviserId);
  if (!adviser || adviser.leftYear != null) return {ok: false, reason: 'no-card'};
  const standing = adviser.stats.byYear.at(-1)?.standing ?? standingScore(state, adviser);
  if (state.households.some((h) => h.id === adviser.householdId)) pay(state, 'treasury', `household:${adviser.householdId}`, adviser.salary / 2, 'adviser-salary');
  if (standing >= 60) {
    const faction = FACTIONS.find((f) => f.trades.includes(adviser.background.trade))?.id;
    for (const f of factionGroup(state, faction)) nudgeMood(f, Math.max(0, f.mood - 0.03), 'rulings');
  }
  a.barred[adviser.householdId] = state.time.year + BARRED_YEARS;
  leave(state, adviser, 'dismissed', `You dismissed ${adviser.name}.`);
  return {ok: true};
}

// ---------------------------------------------------------------------------
// Budgets: an adviser lifts the plans it would back (§4.7, "raise a body's plan priority")
// ---------------------------------------------------------------------------

// +0.1 need for a plan the area's adviser leans toward (the body's lean, against what it costs).
export function planBoost(state, body, cost) {
  const found = adviserFor(state, body.id);
  if (!found?.adviser) return 0;
  const b = found.adviser.beliefs;
  let lean = 0;
  for (const k of TRAITS) lean += (INSTITUTIONS[body.kind]?.axis?.[k] ?? 0) * (b[k] ?? 0);
  const score = 0.4 * clamp(lean) - b.thrift * (cost / Math.max(1, fiscalBase(state))) * 4 + 0.1;
  return score > 0 ? 0.1 : 0;
}

export {TRIMS};
