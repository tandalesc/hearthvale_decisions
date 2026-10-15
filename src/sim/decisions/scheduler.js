// The decision scheduler: who asks what, when, and what happens to the answer.
//
// 1. Base sweeps run at each kind's cadence (months). A population kind asks
//    one question per slice value; actor kinds ask one per actor.
// 2. On-demand questions follow game moments: a rule changes (reactions), a
//    card is drafted (faction stances), an event fires (responses).
// 3. When the service has room, refinement fills the rest: intersection
//    questions where slices disagree (Jensen–Shannon × group size), then
//    individual questions for small or high-stakes groups (contract §0.2–0.3).
// 4. Answers are applied in a deterministic order (sorted by key) and logged
//    in state.answerLog. With no service, each question gets its local
//    fallback distribution at once, so the offline town runs the same way.
//
// Other modules read the model's pooled answers through the `distribution`
// hook: sim-core's decide(state, kind, {type, record}, {prior}) in hooks.js.

import {monthIndex} from '../clock.js';
import {byId} from '../state.js';
import {rng, sampleDist} from '../rng.js';
import {POLICIES, levelOf} from '../policies.js';
import {moodBand, factionById, splitFaction, rootFaction} from '../factions.js';
import {addChronicle} from '../chronicle.js';
import * as bodies from '../institutions.js';
import {pool, disagreement} from '../../decision-pool.js';
import {KIND_BY_ID, KINDS} from './kinds.js';
import {EFFECTS, fallbackFor, normalise, applySweepDeltas} from './effects.js';
import {
  buildSlices, sliceValues, combinations, comboKey, memberships, townSnapshot, districtSnapshot,
  proposalSnapshot, bodySnapshot, districtIdByName, centreIdByName, safe, updateBands,
} from './slices.js';

export const ANSWER_LOG_CAP = 2000;
const SWEEP_DEADLINE_TICKS = 40;
const SWEEP_DEADLINE_MS = 2500;
const REFINE_D = 0.25;
const REFINE_MIN_N = 12;
const INDIVIDUAL_TTL_MONTHS = 24;

// Base cadences (months) and the month in the cycle each sweep runs on, so
// sweeps spread across the year.
const SWEEPS = {
  resident_routine: {every: 1, at: 0},
  household_stay_move: {every: 12, at: 1},
  choose_trade: {every: 12, at: 2},
  petition: {every: 6, at: 3},
  household_home: {every: 12, at: 4},
  crime_charity: {every: 12, at: 5},
  newcomer_integrate: {every: 12, at: 7},
  enterprise_plan: {every: 12, at: 8},
  merchant_speculate: {every: 12, at: 10},
  migration_wave: {every: 12, at: 11},
  enterprise_found: {every: 24, at: 6},
  take_loan: {every: 24, at: 9},
};

const PRIORITY = {player: 100, sweep: 50, refine: 20, individual: 10};
const PLAYER_FACING = new Set(['institution_draft', 'institution_negotiate', 'faction_stance', 'institution_form_support']);

// ---------------------------------------------------------------------------
// Runtime (transient, never saved)
// ---------------------------------------------------------------------------

const runtimes = new WeakMap();

function runtimeOf(state) {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = {inbox: [], personCursor: 0, asked: new Set(), pooled: new Map(), bus: null};
    runtimes.set(state, rt);
  }
  return rt;
}

export const resetScheduler = (state) => runtimes.delete(state);

function g(state) {
  // A bare state (emptyState without the init phase) still works.
  const gov = (state.governance ??= {petitionWait: {}, cardsThisYear: 0, nextCardId: 1, lastSessionMonth: -1, flags: {}});
  gov.sliceAnswers ??= {};
  gov.refined ??= {};
  gov.individual ??= {};
  gov.asks ??= [];
  return gov;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export function schedulerTick(state, ctx = {}) {
  const rt = runtimeOf(state);
  const bus = busOf(ctx);
  rt.bus = bus;
  const m = monthIndex(state.time);
  const gov = g(state);
  // The swept month is saved, so a restored game does not sweep it twice.
  if (gov.sweptMonth !== m) {
    gov.sweptMonth = m;
    rt.pooled.clear();
    if (state.time.month === 0 || !state.bands?.wealth) updateBands(state);
    queueDueSweeps(state, rt, m, !!bus);
  }
  // A sweep is spread over ticks: built on one, answered over the next (a
  // capped batch per tick), finished on a tick of its own. At most one build
  // or finish per tick, and none on ticks that run a rollover job. Sweeps in
  // flight are saved (governance.inflight), so a restored game continues exactly.
  const quiet = !state.time.jobs?.length;
  let heavy = quiet && finishOne(state, rt, ctx);
  // The month's slice table and snapshots are rebuilt on a quiet tick first.
  if (quiet && !heavy && gov.asks.length && gov.preparedMonth !== m) {
    gov.preparedMonth = m;
    heavy = true;
    for (const d of state.districts ?? []) districtSnapshot(state, d.id);
  }
  if (quiet && !heavy && gov.asks.length) {
    const next = gov.asks[0];
    // A body that drafts works needs sim-world's candidates: fetch them on a
    // tick of their own, then start the draft on the next.
    const drafter = next.kind === 'institution_draft' ? bodies.bodyOf(state, next.meta?.bodyId) : null;
    if (drafter && !bodies.worksFresh(state) && bodies.draftsWorks(drafter)) {
      bodies.refreshWorks(state);   // one kind per tick
    } else if (drafter && !bodies.basicFresh(state) && bodies.draftsBasicBridge(drafter)) {
      bodies.basicBridges(state);
    } else if (drafter && !bodies.upgradesFresh(state) && bodies.draftsUpgrades(drafter)) {
      bodies.bridgeUpgrades(state);
    } else {
      startOnDemand(state, rt, gov.asks.shift());
    }
  }
  dispatch(state, rt, bus, ctx);
  if (bus) fillThroughput(state, rt, bus);
  applyInbox(state, rt);
}

function busOf(ctx) {
  const bus = ctx?.services?.decisions;
  if (!bus || typeof bus.ask !== 'function') return null;
  const s = bus.stats?.();
  if (s && (s.state === 'backoff' || s.network === 'offline')) return null;
  return bus;
}

const nowMs = (ctx) => (typeof ctx?.now === 'number' ? ctx.now : ctx?.services?.now?.() ?? 0);

function queueDueSweeps(state, rt, m, online) {
  const asks = g(state).asks;
  // Bodies first: their drafts are what the player sees.
  for (const body of bodies.bodiesDueToDraft(state)) asks.push({kind: 'institution_draft', meta: {bodyId: body.id}});
  for (const [kind, s] of Object.entries(SWEEPS)) {
    if ((m - s.at) % s.every !== 0) continue;
    if (kind === 'merchant_speculate' && (state.era ?? 0) < 3) continue;
    if (kind === 'resident_routine') {
      // Walkers use the model's routine answers only; offline they keep sim-core's prior.
      if (!online) continue;
      for (const timeOfDay of ['morning', 'midday', 'evening']) asks.push({kind, meta: {variant: timeOfDay, timeOfDay}});
      continue;
    }
    asks.push({kind, meta: {}});
  }
}

// ---------------------------------------------------------------------------
// On-demand questions (pushed by the docket and events)
// ---------------------------------------------------------------------------

export function cardAdded(state, card) {
  if (!['proposal', 'demand', 'debate', 'petition'].includes(card.kind)) return;
  const kind = card.data?.forms ? 'institution_form_support' : 'faction_stance';
  // Stances show at once (fallback); the model's view replaces them when it lands.
  for (const q of buildQuestions(state, kind, {cardId: card.id, card})) {
    const p = fallbackFor(kind, q.context, q.snapshot, state, q.allowed);
    card.stances[q.subject.faction] = {stance: argmax(p), p: round2(p[argmax(p)]), probs: roundAll(p), source: 'local'};
  }
  g(state).asks.push({kind, meta: {cardId: card.id}});
}

export function policyChanged(state, policyId, change, card) {
  g(state).asks.push({kind: 'react_to_policy', meta: {policy: policyId, change, cardId: card?.id ?? null}});
}

export function negotiationRequested(state, card) {
  g(state).asks.push({kind: 'institution_negotiate', meta: {cardId: card.id}});
}

export function eventResponseRequested(state, record, kind = 'event_response') {
  g(state).asks.push({kind, meta: {record: record.id, event: record.event}});
}

function startOnDemand(state, rt, ask) {
  if (!KIND_BY_ID[ask.kind]) return;
  if (ask.kind === 'institution_draft') {
    const body = bodies.bodyOf(state, ask.meta.bodyId);
    if (!body || !bodies.bodiesDueToDraft(state).includes(body)) return;
  }
  newSweep(state, rt, ask.kind, ask.meta ?? {});
}

// ---------------------------------------------------------------------------
// Building questions
// ---------------------------------------------------------------------------

// Questions answered locally per tick (offline), across all sweeps in flight.
const LOCAL_ANSWERS_PER_TICK = 48;

function newSweep(state, rt, kind, meta) {
  const questions = buildQuestions(state, kind, meta);
  if (!questions.length) return null;
  const gov = g(state);
  const {card, ...plainMeta} = meta ?? {};
  const sweep = {id: (gov.nextSweepId = (gov.nextSweepId ?? 0) + 1), kind, meta: plainMeta, month: monthIndex(state.time),
    tick: state.time.tick, startedMs: null, questions, answers: {}, answered: 0};
  (gov.inflight ??= []).push(sweep);
  return sweep;
}

const sweepById = (state, id) => g(state).inflight?.find((x) => x.id === id) ?? null;

const sizeBand = (n, pop) => (n < pop * 0.08 ? 'small' : n < pop * 0.25 ? 'mid' : 'large');
const qkey = (kind, m, tail) => `${kind}.${m}.${safe(tail, 60).replace(/[ ,/]/g, '-')}`;

function sliceQuestions(state, kind, meta, extra, snapFor) {
  const def = KIND_BY_ID[kind];
  const table = buildSlices(state);
  const m = monthIndex(state.time);
  const out = [];
  for (const dim of def.slices) {
    for (const value of sliceValues(state, dim)) {
      const people = table.dims[dim][value].people;
      const context = {[dim]: value, group: Math.max(1, Math.min(100000, people)), ...extra(dim, value)};
      out.push({
        key: qkey(kind, m, `${meta.variant ?? ''}${dim}-${value}`),
        subject: {dim, value},
        context, snapshot: snapFor(dim, value), allowed: null, priority: PRIORITY.sweep,
      });
    }
  }
  return out;
}

// A split part says which side of the split it is (the first part only).
function splitPart(state, f) {
  if (!f.parent) return {};
  const parent = factionById(state, f.parent);
  if (f.id !== parent?.splitInto?.[0]) return {};
  if (parent.splitDim === 'centre') return {centre: safe((state.centres ?? []).find((c) => c.id === parent.splitValue)?.name ?? 'Hearthvale')};
  return parent.splitDim === 'district' ? {district: districtSnapshotName(state, parent.splitValue)} : {wealthBand: parent.splitValue};
}

const districtSnapshotName = (state, id) => safe(state.districts?.find((d) => d.id === id)?.name ?? 'Old Ford');

const townOr = (state) => (dim, value) => (dim === 'district' ? districtSnapshot(state, districtIdByName(state, value)) : townSnapshot(state));

function factionQuestions(state, kind, meta, extra, snap) {
  const m = monthIndex(state.time);
  const pop = buildSlices(state).people || 1;
  return state.factions.filter((f) => f.size > 0).map((f) => ({
    key: qkey(kind, m, `${meta.cardId ?? ''}-${f.id}`),
    subject: {dim: 'faction', value: f.id, faction: f.id, cardId: meta.cardId},
    context: {faction: rootFaction(state, f.id), mood: moodBand(f.mood), group: Math.max(1, f.size), ...splitPart(state, f), ...extra(f, pop)},
    snapshot: snap, allowed: null, priority: PLAYER_FACING.has(kind) ? PRIORITY.player : PRIORITY.sweep,
  }));
}

function buildQuestions(state, kind, meta) {
  const m = monthIndex(state.time);
  switch (kind) {
    case 'resident_routine':
      return sliceQuestions(state, kind, meta, () => ({timeOfDay: meta.timeOfDay}), townOr(state));
    case 'household_stay_move': {
      const homes = townSnapshot(state).homes;
      const otherTowns = (state.centres ?? []).filter((c) => c.mergedInto == null).length > 1 ? 'some' : 'none';
      return sliceQuestions(state, kind, meta, () => ({vacancy: homes === 'scarce' ? 'none' : homes === 'plenty' ? 'many' : 'few', otherTowns}), townOr(state))
        .map((q) => (otherTowns === 'none' ? {...q, allowed: ['stay', 'move_within', 'emigrate', 'bring_kin']} : q));
    }
    case 'choose_trade':
      return sliceQuestions(state, kind, meta, () => ({openJobs: openJobsText(state)}), () => townSnapshot(state));
    case 'crime_charity': {
      const watch = bodies.bodyOf(state, 'watch')?.status === 'active' ? 'yes' : 'no';
      const alms = state.tags['alms-house'] != null || levelOf(state, 'tithe') > 0 ? 'yes' : 'no';
      return sliceQuestions(state, kind, meta, () => ({watch, alms}), townOr(state));
    }
    case 'newcomer_integrate':
      if (!state.factions.some((f) => f.id === 'newcomers' && f.size > 0)) return [];
      return sliceQuestions(state, kind, meta, () => ({}), townOr(state));
    case 'household_home':
      return [...sliceQuestions(state, kind, meta, () => ({}), () => townSnapshot(state)), ...homeQuestions(state, 40)];
    case 'react_to_policy': {
      const def = POLICIES[meta.policy];
      if (!def) return [];
      g(state).lastReact = {policy: meta.policy, change: meta.change, cardId: meta.cardId ?? null};
      const snap = proposalSnapshot(state, ruleCardFor(meta));
      meta.rule = def.title;
      return sliceQuestions(state, kind, {...meta, variant: meta.policy}, () => ({change: meta.change, rule: safe(def.title, 40)}), () => snap);
    }
    case 'faction_stance':
    case 'institution_form_support': {
      const card = meta.card ?? state.docket.find((c) => c.id === meta.cardId);
      if (!card) return [];
      const snap = proposalSnapshot(state, card);
      return factionQuestions(state, kind, meta, (f, pop) => (kind === 'faction_stance'
        ? {sizeBand: sizeBand(f.size, pop), side: sideFor(f, card)}
        : {sizeBand: sizeBand(f.size, pop), body: card.data.forms}), snap);
    }
    case 'petition': {
      const snap = townSnapshot(state);
      const qs = factionQuestions(state, kind, meta, (f) => ({grievance: grievanceOf(state, f), hasBody: factionHasBody(state, f) ? 'yes' : 'no'}), snap);
      return [...qs, ...tornPetitions(state, m, snap)];
    }
    case 'festival_participation':
    case 'event_response':
    case 'strike_vote': {
      const event = {fair: 'fair', 'feast-day': 'feast', 'founders-jubilee': 'jubilee'}[meta.event] ?? meta.event;
      const wages = (state.economy?.wageRate ?? 10) < 9 ? 'low' : (state.economy?.wageRate ?? 10) < 13 ? 'fair' : 'good';
      const extra = kind === 'strike_vote' ? () => ({wages}) : () => ({event: validEvent(kind, event)});
      if (kind === 'strike_vote') {
        const snap = proposalSnapshot(state, {id: `strike-${meta.record}`, from: 'union', category: 'labour', title: 'A strike', cost: 0, helps: ['labour'], hurts: ['gentry']});
        return sliceQuestions(state, kind, {...meta, variant: meta.record}, extra, () => snap);
      }
      if (!validEvent(kind, event)) return [];
      return sliceQuestions(state, kind, {...meta, variant: meta.record}, extra, townOr(state));
    }
    case 'merchant_speculate': {
      const merchants = factionById(state, 'merchants');
      const mood = moodBand(merchants?.mood ?? 0.6);
      return sliceQuestions(state, kind, meta, () => ({mood}), townOr(state));
    }
    case 'migration_wave': {
      const snap = townSnapshot(state);
      const prestige = (state.pressures.prestige ?? 0) < 0.2 ? 'low' : (state.pressures.prestige ?? 0) < 0.5 ? 'mid' : 'high';
      const neighbours = Math.sin(state.time.year / 7) > 0.6 ? 'troubled' : 'quiet';
      return [{key: qkey(kind, m, 'world'), subject: {id: 'world'}, context: {prestige, recent: snap.recent.slice(0, 60), neighbours},
        snapshot: snap, allowed: null, priority: PRIORITY.sweep}];
    }
    case 'institution_draft': {
      const body = bodies.bodyOf(state, meta.bodyId);
      if (!body) return [];
      const options = bodies.eligibleTemplates(state, body).slice(0, 6);
      if (!options.length) {
        bodies.markDrafted(state, body);
        return [];
      }
      const context = {body: body.kind};
      options.forEach((o, i) => {
        context[`p${i + 1}`] = safe(o.title, 60);
        context[`n${i + 1}`] = Math.max(0, Math.min(3, Math.round(o.need * 3)));
      });
      const allowed = [...options.map((_, i) => `p${i + 1}`), 'none'];
      return [{key: qkey(kind, m, body.kind), subject: {bodyId: body.id, options}, context, allowed,
        snapshot: bodySnapshot(state, body, bodies.bodyFacts(state, body)), priority: PRIORITY.player}];
    }
    case 'institution_negotiate': {
      const card = state.docket.find((c) => c.id === meta.cardId);
      const body = card && bodies.bodyOf(state, card.from);
      if (!body) return [];
      const ask = Math.max(0, card.cost ?? 0);
      return [{key: qkey(kind, m, card.id), subject: {cardId: card.id}, priority: PRIORITY.player,
        context: {body: body.kind, power: round2(body.power), patience: round2(body.patience), ask, offer: Math.round(ask / 2)},
        snapshot: bodySnapshot(state, body, bodies.bodyFacts(state, body)), allowed: null}];
    }
    case 'enterprise_plan':
      return state.enterprises.filter((e) => !e.public).map((e) => ({
        key: qkey(kind, m, `e${e.id}`), subject: {enterpriseId: e.id}, context: enterpriseContext(state, e),
        snapshot: townSnapshot(state), allowed: (state.era ?? 0) < 3 ? ['hold', 'expand', 'diversify', 'close'] : null, priority: PRIORITY.sweep,
      }));
    case 'enterprise_found': {
      const owners = new Set(state.enterprises.map((e) => e.ownerHouseholdId));
      const [, rich] = state.bands?.wealth ?? [60, 200];
      const short = shortGoodsText(state);
      const river = (state.pressures.riverTrade ?? 0) < 0.2 ? 'low' : (state.pressures.riverTrade ?? 0) < 0.5 ? 'mid' : 'high';
      return state.households
        .filter((h) => !owners.has(h.id) && (h.savings ?? 0) >= Math.max(rich, 300))
        .sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0) || a.id - b.id)
        .slice(0, 20)
        .map((h) => ({key: qkey(kind, m, `h${h.id}`), subject: {householdId: h.id},
          context: {savings: Math.min(1e9, Math.round(h.savings ?? 0)), shortGoods: short, riverTrade: river},
          snapshot: townSnapshot(state), allowed: null, priority: PRIORITY.sweep}));
    }
    case 'take_loan': {
      const short = state.households.filter((h) => (h.savings ?? 0) < (h.rent ?? 0)).slice(0, 20);
      return short.map((h) => ({key: qkey(kind, m, `h${h.id}`), subject: {householdId: h.id}, priority: PRIORITY.sweep,
        context: {who: 'household', cash: Math.round(h.savings ?? 0), monthlyCost: Math.round(Math.max(0, h.rent ?? 0)), debt: Math.round(h.debt ?? 0), rate: 'mid'},
        snapshot: townSnapshot(state), allowed: null}));
    }
    default:
      return [];
  }
}

// The rule a reaction is about, as a proposal for its snapshot.
function ruleCardFor({policy, cardId}) {
  const def = POLICIES[policy];
  return {id: cardId ?? `rule-${policy}`, from: 'moot', category: def.category, title: def.title, cost: 0, helps: def.helps, hurts: def.hurts};
}

// The group torn between its trade and its street is the one that organises:
// one extra petition question for each of the three most torn groups.
const CATEGORY_GRIEVANCE = {food: 'food', land: 'housing', labour: 'wages', trade: 'tolls', tax: 'wages', health: 'health',
  education: 'schooling', faith: 'faith', environment: 'flood', infrastructure: 'roads', civic: 'crime'};

function tornPetitions(state, m, snap) {
  const last = g(state).lastReact;
  const grievance = CATEGORY_GRIEVANCE[POLICIES[last?.policy]?.category] ?? 'none';
  if (grievance === 'none') return [];
  return Object.entries(state.disagreement?.react_to_policy ?? {})
    .filter(([, r]) => r.D >= 0.3 && r.n >= 30)
    .sort((a, b) => b[1].D * b[1].n - a[1].D * a[1].n || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([key, row]) => {
      const parts = Object.fromEntries(key.split('|').map((p) => p.split('=')));
      const fid = TRADE_FACTION[parts.trade] ?? 'labourers';
      const f = factionById(state, fid);
      const context = {faction: fid, mood: moodBand(f?.mood ?? 0.5), group: Math.max(1, row.n), grievance,
        hasBody: f && factionHasBody(state, f) ? 'yes' : 'no'};
      for (const d of ['trade', 'district', 'wealthBand']) if (parts[d]) context[d] = parts[d];
      return {key: qkey('petition', m, `torn-${key}`), subject: {faction: fid, torn: key}, context, snapshot: snap, allowed: null, priority: PRIORITY.sweep};
    });
}

function validEvent(kind, event) {
  const values = KIND_BY_ID[kind].context.event?.values ?? [];
  return values.includes(event) ? event : null;
}

function sideFor(f, card) {
  if ((card.hurts ?? []).some((t) => f.trades.includes(t))) return 'hurts';
  if ((card.helps ?? []).some((t) => f.trades.includes(t))) return 'helps';
  return 'neutral';
}

const FACTION_GRIEVANCE = {
  farmers: (s) => ((s.indicators.foodBalance ?? 6) < 3 ? 'food' : (s.tags.flood != null && s.time.year - s.tags.flood <= 3) ? 'flood' : 'none'),
  labourers: (s) => ((s.indicators.inequality ?? 0) > 0.4 ? 'wages' : (s.indicators.housingPressure ?? 0) > 0.25 ? 'housing' : 'none'),
  merchants: (s) => (levelOf(s, 'tolls') >= 2 ? 'tolls' : (s.indicators.traffic ?? 0) > 0.5 ? 'roads' : 'none'),
  crafters: (s) => (levelOf(s, 'free-trade') ? 'wages' : 'none'),
  clergy: (s) => ((s.pressures.faith ?? 0) < 0.25 ? 'faith' : 'none'),
  scholars: (s) => ((s.indicators.literacy ?? 0) < 0.3 && (s.era ?? 0) >= 2 ? 'schooling' : 'none'),
  gentry: (s) => ((s.pressures.unrest ?? 0) > 0.35 ? 'crime' : 'none'),
  newcomers: (s) => ((s.indicators.housingPressure ?? 0) > 0.15 ? 'housing' : 'none'),
};

function grievanceOf(state, f) {
  const health = (state.pressures.health ?? 0.4) < 0.3 ? 'health' : null;
  const g0 = FACTION_GRIEVANCE[f.parent ?? f.id]?.(state);
  return g0 && g0 !== 'none' ? g0 : health ?? 'none';
}

function factionHasBody(state, f) {
  const own = {farmers: 'agri-council', crafters: 'trades-guild', merchants: 'exchange', labourers: 'union', clergy: 'parish', scholars: 'school-board'}[f.parent ?? f.id];
  return own ? bodies.bodyOf(state, own)?.status === 'active' : false;
}

function openJobsText(state) {
  const jobs = state.economy?.jobs ?? {};
  const parts = [];
  for (const t of ['farm', 'craft', 'trade', 'labour', 'clerical']) {
    const j = jobs[t];
    if (!j) continue;
    const open = (j.jobs ?? 0) - (j.workers ?? j.filled ?? 0);
    parts.push(`${t} ${open > 4 ? 'many' : open > 0 ? 'some' : 'none'}`);
  }
  return safe(parts.join(', '), 80);
}

function shortGoodsText(state) {
  const s = state.economy?.shortage ?? {};
  const parts = [];
  if ((s.food ?? 0) > 0 || (state.indicators.foodBalance ?? 6) < 3) parts.push('food');
  if ((s.goods ?? 0) > 0) parts.push('goods');
  if ((state.indicators.housingPressure ?? 0) > 0.2) parts.push('homes');
  return safe(parts.join(', '), 60);
}

function enterpriseContext(state, e) {
  const demand = (state.economy?.shortage?.[e.sector === 'food' ? 'food' : 'goods'] ?? 0) > 0 ? 'high' : (e.profitLastYear ?? 0) < 0 ? 'low' : 'mid';
  const rules = Object.keys(state.policies).filter((id) => ['wage-floor', 'smoke-limits', 'hours-cap', 'mill-rights', 'price-floor', 'free-trade'].includes(id));
  return {
    type: safe(e.type, 20), jobs: Math.max(0, Math.min(10000, Math.round(e.jobs ?? 0))),
    cash: clampN(Math.round(e.cash ?? 0)), profit: clampN(Math.round(e.profitLastYear ?? e.profit ?? 0)),
    demand, labour: (state.indicators.jobBalance ?? 0) > 0.1 ? 'short' : 'ok',
    ...(rules.length ? {rules: safe(rules.join(', '), 80)} : {}),
    ...rentContext(e),
  };
}

// Ground-rent facts sim-core keeps on the enterprise, refreshed yearly:
// rentShare (rent / revenue), siteOffer (a developer's price / what the business
// is worth), cheaper ({districtId, ratio, distance} | null). Bands as sim-core suggests.
const LAND_HUNGRY = new Set(['farm', 'mill', 'warehouse', 'workshop', 'factory']);
function rentContext(e) {
  const out = {landHungry: LAND_HUNGRY.has(e.type) ? 'yes' : 'no'};
  if (Number.isFinite(e.rentShare)) out.rent = e.rentShare < 0.05 ? 'light' : e.rentShare < 0.15 ? 'moderate' : e.rentShare < 0.3 ? 'heavy' : 'crushing';
  if (Number.isFinite(e.siteOffer)) out.siteOffer = e.siteOffer < 1 ? 'none' : e.siteOffer < 2 ? 'fair' : e.siteOffer < 4 ? 'rich' : 'huge';
  if (e.cheaper !== undefined) out.cheaperSite = !e.cheaper ? 'none' : (e.cheaper.distance ?? 999) < 80 ? 'near' : 'far';
  return out;
}

const clampN = (x) => Math.max(-1e9, Math.min(1e9, x));

function homeContext(state, h) {
  const home = h.homeId != null ? byId(state, 'buildings', h.homeId) : null;
  const tier = home?.tier ?? 1;
  const nextCost = [500, 1100, 2200, 4200, 9000][Math.min(4, tier)] * (1 + 0.6 * (state.era ?? 0));
  const eraMax = [1, 2, 3, 4, 5, 5][state.era ?? 0];
  return {
    savings: Math.max(0, Math.round(h.savings ?? 0)), income: clampN(Math.round(h.income ?? 0)), rent: Math.max(0, Math.round(h.rent ?? 0)),
    homeTier: Math.max(1, Math.min(5, tier)), condition: round2(home?.condition ?? 1), canExtend: (home?.storeys ?? 1) < [1, 2, 3, 4, 6, 9][state.era ?? 0] ? 'yes' : 'no',
    neighboursTier: Math.max(1, Math.min(5, state.indicators.avgHomeTier ?? 1)), eraMaxTier: eraMax, nextCost: Math.round(nextCost),
  };
}

// Individual home questions for the households closest to affording an upgrade.
function homeQuestions(state, limit, skip = new Set()) {
  const m = monthIndex(state.time);
  const ranked = state.households
    .filter((h) => h.homeId != null && !skip.has(h.id))
    .map((h) => ({h, c: homeContext(state, h)}))
    .filter(({c}) => c.savings >= 0.4 * c.nextCost)
    .sort((a, b) => b.c.savings / b.c.nextCost - a.c.savings / a.c.nextCost || a.h.id - b.h.id)
    .slice(0, limit);
  return ranked.map(({h, c}) => ({key: qkey('household_home', m, `h${h.id}`), subject: {householdId: h.id}, context: c,
    snapshot: townSnapshot(state), allowed: null, priority: PRIORITY.individual}));
}

// ---------------------------------------------------------------------------
// Sending and receiving
// ---------------------------------------------------------------------------

function dispatch(state, rt, bus, ctx) {
  let budget = bus ? Infinity : LOCAL_ANSWERS_PER_TICK;
  for (const sweep of g(state).inflight ?? []) {
    if (sweep.tick === state.time.tick) continue; // built this tick: start next tick
    sweep.startedMs ??= nowMs(ctx);
    for (const q of sweep.questions) {
      if (budget <= 0) return;
      if (q.sent) continue;
      q.sent = true;
      send(state, rt, bus, sweep, q);
      budget--;
    }
  }
}

function send(state, rt, bus, sweep, q) {
  if (!bus) {
    rt.inbox.push({sweepId: sweep.id, q, probs: fallbackFor(sweep.kind, q.context, q.snapshot, state, q.allowed ?? undefined), src: 'local'});
    return;
  }
  const id = q.key.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80);
  const opts = {priority: q.priority ?? PRIORITY.sweep, ...(q.allowed ? {allowed: q.allowed} : {}), state: q.snapshot,
    tag: q.subject?.dim ? 'slice' : 'sweep'};
  let answered = false;
  Promise.resolve(bus.ask(sweep.kind, id, q.context, opts)).then((answer) => {
    answered = true;
    const probs = answerProbs(sweep.kind, answer, q.allowed);
    rt.inbox.push({sweepId: sweep.id, q, probs: probs ?? fallbackFor(sweep.kind, q.context, q.snapshot, state, q.allowed ?? undefined), src: probs ? 'model' : 'local'});
  }, () => {
    if (!answered) rt.inbox.push({sweepId: sweep.id, q, probs: fallbackFor(sweep.kind, q.context, q.snapshot, state, q.allowed ?? undefined), src: 'local'});
  });
}

// The service may return probabilities, or just a choice with a confidence.
function answerProbs(kind, answer, allowed) {
  if (!answer || answer.choice == null) return null;
  const offered = allowed ?? Object.keys(KIND_BY_ID[kind].criteria);
  if (answer.probabilities) return normalise(answer.probabilities, offered);
  const c = Math.max(0, Math.min(1, answer.confidence ?? 0.6));
  const rest = (1 - c) / Math.max(1, offered.length - 1);
  return Object.fromEntries(offered.map((o) => [o, o === answer.choice ? c : rest]));
}

// Answers apply in key order, so the same answers replay identically.
function applyInbox(state, rt) {
  if (!rt.inbox.length) return;
  const batch = rt.inbox.splice(0).sort((a, b) => (a.q.key < b.q.key ? -1 : a.q.key > b.q.key ? 1 : 0));
  const log = state.answerLog;
  for (const item of batch) {
    const sweep = item.sweepId != null ? sweepById(state, item.sweepId) : null;
    const choice = sampleDist(item.probs, rng(state));
    log.push({key: item.q.key, kind: sweep?.kind ?? item.kind, month: monthIndex(state.time), choice, probs: roundAll(item.probs), src: item.src});
    if (log.length > ANSWER_LOG_CAP) log.splice(0, log.length - ANSWER_LOG_CAP);
    if (sweep && !sweep.answers[item.q.key]) {
      sweep.answers[item.q.key] = {key: item.q.key, subject: item.q.subject, context: item.q.context, probs: item.probs, choice, src: item.src};
      sweep.answered++;
    }
    else if (item.extra) storeExtra(state, item, choice);
  }
}

// Finish the oldest sweep whose answers are all in (or that waited too long
// for the service). Returns true when it did one.
function finishOne(state, rt, ctx) {
  const inflight = g(state).inflight ?? [];
  for (let i = 0; i < inflight.length; i++) {
    const sweep = inflight[i];
    const done = sweep.answered >= sweep.questions.length;
    const late = sweep.startedMs != null && state.time.tick - sweep.tick >= SWEEP_DEADLINE_TICKS &&
      nowMs(ctx) - sweep.startedMs >= SWEEP_DEADLINE_MS && sweep.questions.every((q) => q.sent);
    if (!done && !late) continue;
    if (!done) {
      for (const q of sweep.questions) {
        if (sweep.answers[q.key]) continue;
        const probs = fallbackFor(sweep.kind, q.context, q.snapshot, state, q.allowed ?? undefined);
        sweep.answers[q.key] = {key: q.key, subject: q.subject, context: q.context, probs, choice: sampleDist(probs, rng(state)), src: 'late'};
      }
    }
    inflight.splice(i, 1);
    finishSweep(state, rt, sweep);
    return true;
  }
  return false;
}

function finishSweep(state, rt, sweep) {
  const kind = KIND_BY_ID[sweep.kind];
  const gov = g(state);
  const answers = Object.values(sweep.answers).sort((a, b) => (a.key < b.key ? -1 : 1));
  const store = (gov.sliceAnswers[storeKey(sweep.kind, sweep.meta)] ??= {});
  const month = monthIndex(state.time);
  let actors = 0;
  const shares = {};
  for (const a of answers) {
    if (a.subject.dim) {
      const key = `${a.subject.dim}=${a.subject.value}`;
      store[key] = withPrev(store[key], {probs: roundAll(a.probs), month, src: a.src});
    }
    if (a.subject.enterpriseId != null || a.subject.householdId != null) {
      const id = a.subject.enterpriseId ?? a.subject.householdId;
      const table = (gov.individual[sweep.kind] ??= {});
      table[id] = withPrev(table[id], {probs: roundAll(a.probs), month, choice: a.choice, src: a.src});
      actors++;
      for (const [o, p] of Object.entries(a.probs)) shares[o] = (shares[o] ?? 0) + p;
    }
  }
  // Population kinds: pool per combination, then deltas from the expected shares.
  if (kind.slices.length && answers.some((a) => a.subject.dim) && kind.slices[0] !== 'faction') {
    const pooledShares = populationShares(state, sweep.kind, store, kind);
    applySweepDeltas(state, sweep.kind, pooledShares);
    // Disagreement feeds I.tension, the torn op and refinement (online only).
    if (GAME_TORN_KINDS.has(sweep.kind) || rt.bus) measureDisagreement(state, sweep.kind, store, kind);
    if (sweep.kind === 'react_to_policy') watchSplits(state);
  } else if (kind.slices[0] === 'faction') {
    const n = answers.length || 1;
    const avg = {};
    for (const a of answers) for (const [o, p] of Object.entries(a.probs)) avg[o] = (avg[o] ?? 0) + p / n;
    applySweepDeltas(state, sweep.kind, avg);
  }
  if (actors) applySweepDeltas(state, sweep.kind, Object.fromEntries(Object.entries(shares).map(([o, s]) => [o, s / actors])));
  rt.pooled.clear();
  EFFECTS[sweep.kind]?.apply?.(state, answers, sweep);
}

const storeKey = (kind, meta) => (meta?.variant && kind === 'resident_routine' ? `${kind}@${meta.variant}` : kind);

// ---------------------------------------------------------------------------
// Pooling (linear opinion pool, never a product)
// ---------------------------------------------------------------------------

// Thin wrapper over the decision bus's pool(): parts = [{probs, weight}].
export function linearPool(parts, offered) {
  const usable = parts.filter((p) => p.probs && p.weight > 0);
  if (!usable.length) return null;
  return pool(usable.map((p) => p.probs), {weights: usable.map((p) => p.weight), allowed: offered});
}

// The pool is linear with the same weights for everyone, so the town-wide
// share of an option is the weighted mix of each dimension's slice answers,
// each slice counted by its people. O(slices), not O(groups).
function populationShares(state, kindId, store, kind) {
  const table = buildSlices(state);
  const offered = Object.keys(kind.criteria);
  const shares = Object.fromEntries(offered.map((o) => [o, 0]));
  let wTotal = 0;
  for (const d of kind.slices) {
    const w = kind.weights[d] ?? 0.3;
    let people = 0;
    const mix = Object.fromEntries(offered.map((o) => [o, 0]));
    for (const [value, row] of Object.entries(table.dims[d] ?? {})) {
      const p = store[`${d}=${value}`]?.probs;
      if (!p || !row.people) continue;
      people += row.people;
      for (const o of offered) mix[o] += row.people * (p[o] ?? 0);
    }
    if (!people) continue;
    wTotal += w;
    for (const o of offered) shares[o] += (w * mix[o]) / people;
  }
  if (wTotal > 0) for (const o of offered) shares[o] /= wTotal;
  return shares;
}

// Jensen–Shannon divergence in bits (0..1 for two answers). The bus computes
// it (in nats); the bookkeeping into state.disagreement and I.tension is ours.
export const jsd = (p, q) => Math.max(0, Math.min(1, disagreement([p, q]) / Math.LN2));

const TENSION_KINDS = ['household_stay_move', 'react_to_policy', 'petition', 'crime_charity'];
// Kinds whose disagreement the game itself reads (tension, torn conditions, splits).
const GAME_TORN_KINDS = new Set([...TENSION_KINDS, 'festival_participation']);

// Torn intersections: pairs of slice dims whose answers disagree.
function measureDisagreement(state, kindId, store, kind) {
  const dims = kind.slices;
  const rows = [];
  // People per (value of d1, value of d2) for every pair, in one pass.
  const pairs = [];
  for (let i = 0; i < dims.length; i++) for (let j = i + 1; j < dims.length; j++) pairs.push([dims[i], dims[j], new Map()]);
  for (const {m, n} of buildSlices(state).members) {
    for (const [d1, d2, counts] of pairs) {
      let inner = counts.get(m[d1]);
      if (!inner) counts.set(m[d1], (inner = new Map()));
      inner.set(m[d2], (inner.get(m[d2]) ?? 0) + n);
    }
  }
  for (const [d1, d2, counts] of pairs) {
    const first = d1 < d2 ? d1 : d2;
    for (const [v1, inner] of counts) {
      const a = store[`${d1}=${v1}`]?.probs;
      if (!a) continue;
      for (const [v2, n] of inner) {
        const b = store[`${d2}=${v2}`]?.probs;
        if (!b) continue;
        const D = jsd(a, b);
        if (D < 0.05) continue;
        const key = first === d1 ? `${d1}=${v1}|${d2}=${v2}` : `${d2}=${v2}|${d1}=${v1}`;
        rows.push({key, D: Math.round(D * 1000) / 1000, n});
      }
    }
  }
  rows.sort((x, y) => y.D * y.n - x.D * x.n || (x.key < y.key ? -1 : 1));
  state.disagreement ??= {};
  const table = {};
  for (const r of rows.slice(0, 40)) table[r.key] = {D: r.D, n: r.n, year: state.time.year};
  state.disagreement[kindId] = table;
  updateTension(state);
}

// A trade torn against its street or its purse on two rule reactions in a row
// splits its faction (D >= 0.3, n >= 30). Any tear (D >= 0.15) keeps a split alive.
const TRADE_FACTION = {farm: 'farmers', craft: 'crafters', trade: 'merchants', labour: 'labourers', none: 'labourers',
  clergy: 'clergy', clerical: 'scholars', gentry: 'gentry'};

function watchSplits(state) {
  const gov = g(state);
  gov.splitWatch ??= {};
  const rows = state.disagreement?.react_to_policy ?? {};
  const torn = {}, stirred = new Set();
  for (const [key, row] of Object.entries(rows)) {
    const parts = Object.fromEntries(key.split('|').map((p) => p.split('=')));
    const fid = TRADE_FACTION[parts.trade];
    if (!fid) continue;
    if (row.D >= 0.15) stirred.add(fid);
    const dim = parts.centre ? 'centre' : parts.district ? 'district' : parts.wealthBand ? 'wealthBand' : null;
    if (!dim || row.D < 0.3 || row.n < 30) continue;
    if (!torn[fid] || row.D * row.n > torn[fid].score) torn[fid] = {score: row.D * row.n, dim, value: parts[dim]};
  }
  for (const f of state.factions) if (f.splitInto && stirred.has(f.id)) f.lastTornYear = state.time.year;
  for (const fid of Object.values(TRADE_FACTION)) {
    const t = torn[fid];
    gov.splitWatch[fid] = t ? (gov.splitWatch[fid] ?? 0) + 1 : 0;
    if (!t || gov.splitWatch[fid] < 2) continue;
    const value = t.dim === 'district' ? districtIdByName(state, t.value) : t.dim === 'centre' ? centreIdByName(state, t.value) : t.value;
    if (splitFaction(state, fid, t.dim, value)) {
      gov.splitWatch[fid] = 0;
      const f = factionById(state, fid);
      addChronicle(state, `The ${f.name.toLowerCase()} no longer speak with one voice. ${f.splitInto.map((id) => factionById(state, id).name).join(' and ')} go their own ways.`, 'line', {faction: fid, split: true});
    }
  }
}

export function updateTension(state) {
  const pop = buildSlices(state).people || 1;
  let sum = 0, kinds = 0;
  for (const k of TENSION_KINDS) {
    const t = state.disagreement?.[k];
    if (!t) continue;
    kinds++;
    const pairs = Math.max(1, (KIND_BY_ID[k].slices.length * (KIND_BY_ID[k].slices.length - 1)) / 2);
    for (const r of Object.values(t)) sum += (r.D * r.n) / pairs;
  }
  const tension = kinds ? Math.min(1, sum / pop / kinds) : 0;
  state.governance.tension = Math.round(tension * 1000) / 1000;
  if (state.indicators) state.indicators.tension = state.governance.tension;
}

// ---------------------------------------------------------------------------
// Reading distributions (the `distribution` hook)
//
// sim-core and sim-world call decide(state, kind, {type, record, ...}) with
// their own prior. This returns what the decision model said for that actor
// (its own answer, a refined intersection, or its slices pooled), or null so
// the caller's prior stands. Local fallbacks never override a caller's prior.
// ---------------------------------------------------------------------------

const isModel = (entry, m, ttl = INDIVIDUAL_TTL_MONTHS) => entry && entry.src === 'model' && m - entry.month <= ttl;

export function distribution(state, kindId, subject) {
  const kind = KIND_BY_ID[kindId];
  if (!kind || !subject || !state.governance) return null;
  const gov = g(state);
  const m = monthIndex(state.time);
  const rec = subject.record ?? subject;
  const type = subject.type ?? (rec.cash !== undefined ? 'enterprise' : rec.size !== undefined ? 'household' : null);
  let probs = null;

  if (kind.slices.length && kind.slices[0] !== 'faction') {
    const variant = kindId === 'resident_routine' ? timeOfDayOf(state) : '';
    if (type === 'person') {
      const own = gov.individual.resident_routine?.[`p${rec.id}.${variant}`];
      if (isModel(own, m, 2)) probs = own.probs;
      const h = subject.household ?? state.households.find((x) => x.id === rec.householdId);
      if (!probs && h) probs = modelPooled(state, kindId, memberships(state, h), variant);
    } else if (type === 'household' || type === 'youth' || type === 'migrant') {
      const h = rec.size !== undefined ? rec : null;
      const own = h && gov.individual[kindId]?.[h.id];
      if (isModel(own, m)) probs = own.probs;
      else if (h) probs = modelPooled(state, kindId, memberships(state, h), variant);
      else if (subject.parentTrade) probs = modelPooled(state, kindId, {trade: subject.parentTrade}, variant, ['trade']);
    }
    if (probs && kindId === 'household_stay_move' && rec.size !== undefined) probs = leaveBias(state, rec, probs);
    return probs ? {...probs} : null;
  }

  if (kindId === 'where_to_settle') return settleDistribution(state, subject);
  if (kindId === 'farm_land') return farmDistribution(state, subject);
  if (type === 'site' || kindId === 'choose_site') {
    const context = siteContext(rec);
    const key = signature(context);
    const own = gov.individual.choose_site?.[key];
    if (isModel(own, m, 12)) return {...own.probs};
    const rt = runtimeOf(state);
    if (rt.bus) {
      const snap = subject.districtId != null ? districtSnapshot(state, subject.districtId) : townSnapshot(state);
      askExtra(state, rt, rt.bus, 'choose_site', key, context, snap, null, PRIORITY.player);
    }
    return null;
  }
  const own = rec.id != null ? gov.individual[kindId]?.[rec.id] : null;
  return isModel(own, m) ? {...own.probs} : null;
}

// where_to_settle: sim-core passes {type: 'migrant', record: {migrant, candidates:
// [districtId, ...] best first}}. The model sees them as D1..D4; its answer
// comes back keyed 'd<districtId>' (sim-core's option keys) plus 'pass_by'.
function settleDistribution(state, subject) {
  const rec = subject.record ?? {};
  const ids = (rec.candidates ?? []).slice(0, 4);
  if (!ids.length) return null;
  const gov = g(state);
  const context = {migrant: ['poor_family', 'craftsman', 'merchant'].includes(rec.migrant) ? rec.migrant : 'poor_family'};
  ids.forEach((id, i) => { context[`d${i + 1}`] = districtLine(state, id); });
  const key = signature(context);
  const own = gov.individual.where_to_settle?.[key];
  if (isModel(own, monthIndex(state.time), 12)) {
    const out = {pass_by: own.probs.pass_by ?? 0};
    ids.forEach((id, i) => { out[`d${id}`] = own.probs[`d${i + 1}`] ?? 0; });
    return out;
  }
  const rt = runtimeOf(state);
  if (rt.bus) askExtra(state, rt, rt.bus, 'where_to_settle', key, context, townSnapshot(state), [...ids.map((_, i) => `d${i + 1}`), 'pass_by'], PRIORITY.individual);
  return null;
}

// farm_land: sim-world passes {type: 'farm', record: {buildingId, landValue:
// 'rising'|'high'|'very high', profit (coin), districtId}}. Model answers only.
function farmDistribution(state, subject) {
  const rec = subject.record ?? {};
  if (rec.buildingId == null) return null;
  const gov = g(state);
  const profit = Number(rec.profit) || 0;
  const lv = String(rec.landValue ?? 'rising').replace(' ', '_');
  const value = {rising: 600, high: 1200, very_high: 2400}[lv] ?? 600;
  const ratio = profit > 0 ? value / profit : 99;
  const owner = state.households.find((h) => h.id === byId(state, 'buildings', rec.buildingId)?.ownerHouseholdId);
  const context = {
    landValue: ['rising', 'high', 'very_high'].includes(lv) ? lv : 'rising',
    profit: profit < 0 ? 'loss' : profit < 60 ? 'thin' : 'good',
    valueRatio: ratio < 4 ? 'low' : ratio < 10 ? 'mid' : ratio < 25 ? 'high' : 'very_high',
    agriCouncil: bodies.bodyOf(state, 'agri-council')?.status === 'active' ? 'yes' : 'no',
    ...(owner ? {ownerAge: memberships(state, owner).lifeStage, wealthBand: memberships(state, owner).wealthBand,
      yearsFarmed: Math.max(0, Math.min(300, state.time.year - (owner.formedYear ?? state.time.year)))} : {}),
  };
  const key = `farm${rec.buildingId}`;
  const own = gov.individual.farm_land?.[key];
  if (isModel(own, monthIndex(state.time), 12)) return {...own.probs};
  const rt = runtimeOf(state);
  if (rt.bus) askExtra(state, rt, rt.bus, 'farm_land', key, context, rec.districtId != null ? districtSnapshot(state, rec.districtId) : townSnapshot(state), null, PRIORITY.individual);
  return null;
}

function districtLine(state, id) {
  const s = districtSnapshot(state, id);
  return safe(`${s.districtName ?? 'a quarter'}, ${s.character ?? 'old-town'}, rent ${s.rent ?? 'mid'}, ${s.roads ?? 'paths'}, ${s.crowding ?? 'snug'}`, 80);
}

const timeOfDayOf = (state) => ['morning', 'midday', 'evening'][Math.min(2, Math.floor(((state.time.tick % 50) / 50) * 3))];

function siteContext(rec) {
  const out = {need: safe(rec.need ?? 'home', 20)};
  for (const k of ['a', 'b', 'c', 'd']) if (rec[k]) out[k] = safe(rec[k], 80);
  if (!out.a) out.a = 'a free lot';
  return out;
}

// Pool only what the model said for these slices.
function modelPooled(state, kindId, m, variant, dims = null) {
  const kind = KIND_BY_ID[kindId];
  const use = dims ?? kind.slices;
  const rt = runtimeOf(state);
  const key = `${kindId}@${variant}|${comboKey(m, use)}`;
  if (rt.pooled.has(key)) return rt.pooled.get(key);
  const gov = g(state);
  const month = monthIndex(state.time);
  const refined = gov.refined[kindId]?.[comboKey(m, use)];
  let probs = null;
  if (isModel(refined, month, 12)) probs = refined.probs;
  else {
    const store = gov.sliceAnswers[variant ? `${kindId}@${variant}` : kindId] ?? {};
    const parts = use.map((d) => {
      const entry = store[`${d}=${m[d]}`];
      return {probs: isModel(entry, month, 24) ? entry.probs : null, weight: kind.weights[d] ?? 0.3};
    });
    probs = linearPool(parts, Object.keys(kind.criteria));
  }
  rt.pooled.set(key, probs);
  return probs;
}

function leaveBias(state, h, probs) {
  const bias = state.governance.leaveBias?.[h.trade];
  if (!bias || bias.until < state.time.year || !probs) return probs;
  return {...probs, emigrate: (probs.emigrate ?? 0) + bias.amount * 0.5};
}

const signature = (context) => JSON.stringify(context);

function askExtra(state, rt, bus, kindId, subjectKey, context, snap, allowed, priority) {
  const tag = `${kindId}:${subjectKey}`;
  if (rt.asked.has(tag)) return;
  rt.asked.add(tag);
  const id = `${kindId}.${subjectKey}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80);
  Promise.resolve(bus.ask(kindId, id, context, {priority, ...(allowed ? {allowed} : {}), state: snap, tag: 'individual'})).then((answer) => {
    rt.asked.delete(tag);
    const probs = answerProbs(kindId, answer, allowed);
    if (probs) rt.inbox.push({sweepId: null, extra: true, kind: kindId, subjectKey, q: {key: id, context}, probs, src: 'model'});
  }, () => rt.asked.delete(tag));
}

// One level of history, so notes can say "more of them think of leaving".
const withPrev = (old, next) => (old ? {...next, prev: {probs: old.probs, month: old.month}} : next);

function storeExtra(state, item) {
  const gov = g(state);
  const month = monthIndex(state.time);
  const table = item.refine ? (gov.refined[item.kind] ??= {}) : (gov.individual[item.kind] ??= {});
  table[item.subjectKey] = withPrev(table[item.subjectKey], {probs: roundAll(item.probs), month, src: 'model'});
  pruneTable(table, item.refine ? 400 : 5000);
  if (item.refine && item.kind === 'react_to_policy') refinedReaction(state, item.subjectKey, item.probs);
  runtimeOf(state).pooled.clear();
}

// A refined answer for a torn group nudges its trade's faction mood, in
// proportion to the group's share of the town.
function refinedReaction(state, comboKeyStr, probs) {
  const parts = Object.fromEntries(comboKeyStr.split('|').map((p) => p.split('=')));
  if (!parts.trade) return;
  const row = state.disagreement?.react_to_policy?.[comboKeyStr];
  const share = row ? row.n / Math.max(1, buildSlices(state).people) : 0.05;
  const push = ((probs.support ?? 0) * 0.2 - (probs.grumble ?? 0) * 0.08 - ((probs.protest ?? 0) + (probs.strike ?? 0) + (probs.leave ?? 0)) * 0.2) * share;
  for (const f of state.factions) if (f.trades?.includes(parts.trade)) f.mood = Math.max(0, Math.min(1, f.mood + push));
}

function pruneTable(table, cap) {
  const keys = Object.keys(table);
  if (keys.length <= cap) return;
  keys.sort((a, b) => table[a].month - table[b].month || (a < b ? -1 : 1));
  for (const k of keys.slice(0, keys.length - cap)) delete table[k];
}

// ---------------------------------------------------------------------------
// Filling spare throughput: refinement, then individuals
// ---------------------------------------------------------------------------

const REFINE_KINDS = ['household_stay_move', 'react_to_policy', 'choose_trade', 'crime_charity', 'resident_routine', 'event_response'];

function fillThroughput(state, rt, bus) {
  let room = Math.max(0, Math.min(256, bus.stats?.().room ?? 0) - rt.asked.size);
  if (room <= 0) return;
  const m = monthIndex(state.time);
  const gov = g(state);

  // 1. Intersections where slices disagree, largest D × n first.
  const torn = [];
  for (const kindId of REFINE_KINDS) {
    for (const [key, row] of Object.entries(state.disagreement?.[kindId] ?? {})) {
      if (row.D < REFINE_D) continue;
      const done = gov.refined[kindId]?.[key];
      if (done && m - done.month < 12) continue;
      torn.push({kindId, key, row});
    }
  }
  torn.sort((a, b) => b.row.D * b.row.n - a.row.D * a.row.n || (a.key < b.key ? -1 : 1));
  for (const t of torn) {
    if (room <= 0) return;
    const kind = KIND_BY_ID[t.kindId];
    const context = {};
    for (const part of t.key.split('|')) {
      const [dim, value] = part.split('=');
      context[dim] = value;
    }
    context.group = Math.max(1, t.row.n);
    if (t.kindId === 'resident_routine') context.timeOfDay = ['morning', 'midday', 'evening'][m % 3];
    if (t.kindId === 'event_response') continue; // asked with its moment
    let snap = context.district ? districtSnapshot(state, districtIdByName(state, context.district)) : townSnapshot(state);
    if (t.kindId === 'react_to_policy') {
      // Refine the last rule's reaction against that rule's own snapshot.
      const last = gov.lastReact;
      if (!last || !POLICIES[last.policy]) continue;
      Object.assign(context, {change: last.change, rule: safe(POLICIES[last.policy].title, 40)});
      snap = proposalSnapshot(state, ruleCardFor(last));
    }
    if (t.row.n < REFINE_MIN_N || kind.highStakes) {
      room -= askIndividuals(state, rt, bus, t.kindId, t.key, room, context, snap);
      continue;
    }
    askRefine(state, rt, bus, t.kindId, t.key, context, snap);
    room--;
  }

  // 2. Individuals: visible people's routines, then homes, round-robin.
  const people = state.people ?? [];
  const hh = new Map(state.households.map((h) => [h.id, h]));
  const variant = ['morning', 'midday', 'evening'][Math.floor(state.time.tick / 17) % 3];
  for (let i = 0; i < people.length && room > 0; i++) {
    const p = people[(rt.personCursor + i) % people.length];
    const h = hh.get(p.householdId);
    if (!h) continue;
    const m0 = memberships(state, h);
    const context = {district: m0.district, lifeStage: m0.lifeStage, trade: m0.trade, timeOfDay: variant,
      energy: needBand(p.needs?.energy), fullness: needBand(p.needs?.fullness), social: needBand(p.needs?.social)};
    askExtra(state, rt, bus, 'resident_routine', `p${p.id}.${variant}`, context, districtSnapshot(state, h.districtId), null, PRIORITY.individual);
    room--;
    if (i === people.length - 1 || room <= 0) rt.personCursor = (rt.personCursor + i + 1) % Math.max(1, people.length);
  }
  if (room > 0) {
    const skip = new Set(Object.keys(gov.individual.household_home ?? {}).filter((k) => m - gov.individual.household_home[k].month < 12).map(Number));
    for (const q of homeQuestions(state, Math.min(room, 64), skip)) {
      askExtra(state, rt, bus, 'household_home', q.subject.householdId, q.context, q.snapshot, null, PRIORITY.individual);
      room--;
    }
  }
}

const needBand = (v) => (v == null ? undefined : v < 30 ? 'low' : v < 70 ? 'ok' : 'high');

function askRefine(state, rt, bus, kindId, comboKey, context, snap) {
  const tag = `${kindId}:refine:${comboKey}`;
  if (rt.asked.has(tag)) return;
  rt.asked.add(tag);
  const id = `${kindId}.r.${comboKey}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80);
  Promise.resolve(bus.ask(kindId, id, context, {priority: PRIORITY.refine, state: snap, tag: 'refine'})).then((answer) => {
    rt.asked.delete(tag);
    const probs = answerProbs(kindId, answer, null);
    if (probs) rt.inbox.push({sweepId: null, extra: true, refine: true, kind: kindId, subjectKey: comboKey, q: {key: id, context}, probs, src: 'model'});
  }, () => rt.asked.delete(tag));
}

function askIndividuals(state, rt, bus, kindId, comboKeyStr, limit, base = {}, snap = null) {
  const kind = KIND_BY_ID[kindId];
  const want = Object.fromEntries(comboKeyStr.split('|').map((p) => p.split('=')));
  let n = 0;
  for (const {h, m} of buildSlices(state).members) {
    if (n >= limit) break;
    if (!Object.entries(want).every(([d, v]) => m[d] === v)) continue;
    const context = {...base};
    delete context.group;
    for (const d of kind.slices) context[d] = m[d];
    if (kindId === 'household_stay_move') {
      context.rentShare = Math.min(10, Math.round(((h.rent ?? 0) / Math.max(1, h.savings ?? 1)) * 100) / 100);
    }
    askExtra(state, rt, bus, kindId, h.id, context, snap ?? districtSnapshot(state, h.districtId), null, PRIORITY.individual);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const round2 = (x) => Math.round(Math.max(0, Math.min(1, x ?? 0)) * 100) / 100;
const roundAll = (p) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
const argmax = (p) => Object.keys(p).sort().reduce((best, k) => (p[k] > (p[best] ?? -1) ? k : best), Object.keys(p).sort()[0]);

// For tests and tools: every question a full set of sweeps would ask right now.
export function previewQuestions(state, kinds = KINDS.map((k) => k.id)) {
  const out = [];
  for (const kindId of kinds) {
    const meta = kindId === 'resident_routine' ? {variant: 'morning', timeOfDay: 'morning'}
      : kindId === 'react_to_policy' ? {policy: 'commons', change: 'adopted'}
        : kindId === 'event_response' ? {record: 'test', event: 'flood'}
          : kindId === 'festival_participation' ? {record: 'test', event: 'fair'}
            : kindId === 'strike_vote' ? {record: 'test', event: 'strike'}
              : {};
    if (kindId === 'faction_stance' || kindId === 'institution_form_support' || kindId === 'institution_negotiate') {
      const card = state.docket.find((c) => (kindId === 'institution_form_support' ? c.data?.forms : !c.data?.forms));
      if (!card) continue;
      meta.cardId = card.id;
    }
    if (kindId === 'institution_draft') {
      const body = bodies.activeBodies(state)[0];
      if (!body) continue;
      meta.bodyId = body.id;
    }
    for (const q of buildQuestions(state, kindId, meta)) out.push({kind: kindId, ...q});
  }
  return out;
}

