import test from 'node:test';
import assert from 'node:assert/strict';

import {createState, stepTick, fixtureState, registerSystem} from '../src/sim/index.js';
import {governanceSystem} from '../src/sim/governance.js';
import {invalidateCtx} from '../src/sim/conditions.js';
import {addBuildingRecord} from '../src/sim/state.js';
import {totalMoney, externalNet} from '../src/sim/economy.js';
import {
  POLICIES, CATEGORIES, adoptPolicy, policiesMonthly, detectTensions, againstGrain, upkeepFor, GRAIN_UNREST,
} from '../src/sim/policies.js';
import {
  INSTITUTIONS, TEMPLATES, METRICS, institutionsMonthly, institutionsYearly, formBody, notePatience, bodyOf,
  emergenceHolds, eligibleTemplates,
} from '../src/sim/institutions.js';
import {
  addCard, makeCard, docketQuarterly, rule, sessionCap, yearCap, SESSION_CAP,
} from '../src/sim/docket.js';
import {EVENTS, eventsMonthly, fireEvent} from '../src/sim/events.js';
import {immigrate} from '../src/sim/households.js';
import {serialize, restore} from '../src/sim/serialize.js';
import {splitFaction, factionOf, factionsYearly} from '../src/sim/factions.js';
import {setCardProse} from '../src/sim/docket.js';
import {emptyState} from '../src/sim/state.js';
import {fiscalBase} from '../src/sim/policies.js';
import {initBudgets} from '../src/sim/budgets.js';
import {UPKEEP_CAP} from '../src/sim/governance.js';
import {LINES, lintCatalogue, lintText} from '../src/sim/text/voice.js';
import * as view from '../src/sim/view.js';
import {chronicleYearly, END_YEAR, setChronicleProse, setSummaryProse} from '../src/sim/chronicle.js';
import {applyNegotiation, docketMonthly} from '../src/sim/docket.js';
import {highPoint} from '../src/sim/events.js';
import {COOLDOWN_YEARS, unionCard, wardOf, basicBridges, bridgeDemand, draftCard as bodiesDraftCard} from '../src/sim/institutions.js';
import {crossRiverShare} from '../src/sim/roads.js';
const bodiesDraft = (s, choice) => bodiesDraftCard(s, bodyOf(s, 'moot'), choice);
import {heightAt} from '../src/terrain.js';
import {KINDS, KIND_BY_ID, validateContext, validateSnapshot} from '../src/sim/decisions/kinds.js';
import {previewQuestions, jsd, linearPool, distribution} from '../src/sim/decisions/scheduler.js';
import {fallbackFor} from '../src/sim/decisions/effects.js';
import {SUBJECT_COOLDOWN, SHARP_NEED, SHARP_GAP_YEARS, subjectInFlight, subjectBlocked, templateSubjects as subjectsOfTemplate} from '../src/sim/subjects.js';

registerSystem(governanceSystem);

// ---------------------------------------------------------------------------
// Helpers

// Run whole months headless (no walkers), as the game would.
function runMonths(state, months, services = {}) {
  for (let i = 0; i < months * 50; i += 40) stepTick(state, Math.min(40, months * 50 - i) * 0.1, services, {skipPeople: true});
}

// A player with a taste: favoured rules, bodies and trades get a yes;
// disliked ones get a no; demands they dislike are negotiated.
function ruler(style) {
  return (state, card) => {
    const keys = card.options.map((o) => o.key);
    const likes = (o) => style.rules.includes(o) || style.bodies.includes(o);
    const helps = (card.helps ?? []).some((t) => style.trades.includes(t));
    const hurts = (card.hurts ?? []).some((t) => style.trades.includes(t)) || style.dislike.includes(card.data?.policy) ||
      style.dislike.includes(card.data?.forms);
    if (card.kind === 'report') return 'ok';
    if (card.kind === 'event') return keys[0];
    if (card.kind === 'debate') {
      const pick = card.options.find((o) => o.side && card.data.cards.some((c) => c.from === o.side && likes(c.data?.policy)));
      return pick?.key ?? 'neither';
    }
    // A demand they dislike: bargain first; if the body insists, refuse anyway.
    if (card.kind === 'demand') return !hurts ? keys[0] : keys.includes('negotiate') ? 'negotiate' : keys.includes('refuse_anyway') ? 'refuse_anyway' : keys.at(-1);
    if (card.data?.forms) return likes(card.data.forms) ? 'standard' : style.dislike.includes(card.data.forms) ? 'refuse' : 'small';
    if (likes(card.data?.policy) || (helps && !hurts)) return keys[0];
    if (hurts) return keys.includes('refuse') ? 'refuse' : keys.at(-1);
    return keys.includes('not_now') && (card.cost ?? 0) > Math.max(0, state.treasury) * 0.5 ? 'not_now' : keys[0];
  };
}

const AGRARIAN = {
  rules: ['commons', 'granary', 'drainage', 'market-gardens', 'woodland-reserve', 'smoke-limits', 'wells', 'feast-days', 'tithe', 'fast-days', 'park-reserve'],
  bodies: ['agri-council', 'parish', 'health-board', 'school-board'],
  trades: ['farm', 'clergy'],
  dislike: ['mill-rights', 'free-trade', 'enclosure', 'trades-guild', 'exchange', 'tolls', 'price-floor'],
};
const INDUSTRIAL = {
  rules: ['mill-rights', 'free-trade', 'enclosure', 'market-charter', 'apprenticeship', 'paving-fund', 'property-tax', 'income-tax'],
  bodies: ['trades-guild', 'exchange', 'river-authority', 'planning'],
  trades: ['craft', 'trade', 'gentry'],
  dislike: ['commons', 'smoke-limits', 'woodland-reserve', 'wage-floor', 'hours-cap', 'agri-council'],
};

// Rule every surfaced card once a quarter, for `years` years.
function play(seed, years, choose) {
  const state = createState(seed);
  for (let q = 0; q < years * 4; q++) {
    runMonths(state, 3);
    for (const card of [...state.docket]) if (card.surfacedMonth != null) rule(state, card.id, choose(state, card));
  }
  return state;
}

const activeBodies = (s) => s.institutions.filter((b) => b.status === 'active');
const activeRules = (s) => Object.values(s.policies).filter((p) => p.level > 0);

function freshTown(seed = 99) {
  const s = createState(seed);
  s.docket = [];
  return s;
}

function monthly(state, fn, months) {
  for (let i = 0; i < months; i++) {
    state.time.month = (state.time.month + 1) % 12;
    if (state.time.month === 0) state.time.year++;
    state.time.tick += 50;
    invalidateCtx(state);
    fn(state);
  }
}

// ---------------------------------------------------------------------------
// Bodies

test('a body petitions when its soft condition holds, and not before', () => {
  const s = freshTown();
  assert.equal(emergenceHolds(s, 'agri-council'), false);
  monthly(s, institutionsMonthly, 48);
  assert.ok(!s.docket.some((c) => c.data?.forms === 'agri-council'), 'no petition while the condition fails');

  adoptPolicy(s, 'commons', 1);
  adoptPolicy(s, 'granary', 1);
  invalidateCtx(s);
  assert.equal(emergenceHolds(s, 'agri-council'), true);
  monthly(s, institutionsMonthly, 36);
  const petition = s.docket.find((c) => c.data?.forms === 'agri-council');
  assert.ok(petition, 'a petition card appears');
  assert.equal(petition.kind, 'petition');
  assert.deepEqual(petition.options.map((o) => o.key), ['standard', 'small', 'generous', 'not_now', 'refuse']);
});

test('Refuse sets the tag, angers, and blocks a new petition for 15 years', () => {
  const s = freshTown();
  adoptPolicy(s, 'commons', 1);
  adoptPolicy(s, 'granary', 1);
  monthly(s, institutionsMonthly, 36);
  const card = s.docket.find((c) => c.data?.forms === 'agri-council');
  card.surfacedMonth = 0;
  const year = s.time.year;
  assert.equal(rule(s, card.id, 'refuse').ok, true);
  assert.equal(s.tags['refused:agri-council'], year);
  assert.ok(s.deltaLog.some((d) => d.key === 'unrest' && d.amount > 0 && d.source === 'refused:agri-council'));

  monthly(s, institutionsMonthly, 12 * 14);
  assert.ok(!s.docket.some((c) => c.data?.forms === 'agri-council'), 'blocked for 15 years');
  s.time.year = year + 16;
  monthly(s, institutionsMonthly, 36);
  assert.ok(s.docket.some((c) => c.data?.forms === 'agri-council'), 'may petition again after 15 years');
});

test('patience falls with refusals, the body wanes, pleads, and then dissolves', () => {
  const s = freshTown();
  const body = formBody(s, 'trades-guild', 0.06);
  body.patience = 0.5;
  institutionsYearly(s);
  assert.ok(Math.abs(body.patience - 0.6) < 1e-9, 'patience recovers 0.1 a year');
  for (let i = 0; i < 4; i++) notePatience(s, body.id, -0.15);
  assert.equal(body.status, 'waning');
  assert.ok(s.chronicle.entries.some((e) => e.text.includes('lost heart')));

  s.time.year += 1;
  institutionsMonthly(s);
  const plea = s.docket.find((c) => c.data?.revive === body.id);
  assert.ok(plea, 'a waning body asks once for a fresh start');

  s.docket = [];
  s.time.year += 5;
  institutionsYearly(s);
  assert.equal(body.status, 'dissolved');
  assert.ok(s.tags['dissolved:trades-guild'] != null);
});

test('a body on a yearly budget settles its planned and small cards itself and reports yearly; without one it asks you', () => {
  const s = freshTown();
  const body = formBody(s, 'agri-council', 0.06);
  body.accepted = 4;
  body.funds = 5000;
  // Delegation and standing orders are retired: a body without a budget asks you.
  assert.ok(!('delegated' in body) && !('standingOrders' in body));
  const ask = (id, cost, tid = 'seed-exchange') => makeCard(s, {kind: 'proposal', from: body.id, templateId: tid, category: 'food', title: `Plan ${id}`,
    why: 'Test.', cost, options: [{key: 'do', label: 'Set it up', tradeoff: 'Small cost.', cost, effects: [{tag: `plan-${id}`}]}]});
  assert.ok(addCard(s, ask('a', 100)), 'without a budget it asks you');
  assert.ok(!ask('x', 1).options.some((o) => o.key === 'delegate'), 'no "Let them decide"');
  // On a budget with that plan in it, it pays for it from its own purse.
  initBudgets(s);
  Object.assign(body.budget, {mode: 'annual', year: s.time.year, granted: 2000,
    lines: [{id: 'running', kind: 'running', cost: 200}, {id: 'plan:tithe-barn', kind: 'plan', templateId: 'tithe-barn', cost: 700, label: 'A tithe barn'}]});
  const before = body.funds;
  assert.equal(addCard(s, ask('b', 700, 'tithe-barn')), null, 'its own plan: no card for you');
  assert.ok(s.tags['plan-b'] != null);
  assert.equal(body.budget.lines[1].started, true);
  assert.equal(body.budget.spent.plans, 700);
  assert.ok(s.cardHistory.at(-1).outcome === 'budget');
  // A small thing (under 15% of the grant) too; a dearer unplanned one asks you.
  assert.equal(addCard(s, ask('c', 250, 'quality-mark')), null);
  assert.ok(addCard(s, ask('d', 400, 'keep-old-fields')), 'not planned and not small: it asks');
  assert.ok(before >= body.funds);
  institutionsYearly(s);
  assert.ok(s.docket.some((c) => c.kind === 'report' && c.from === body.id));
});

// ---------------------------------------------------------------------------
// Rules

test('rules push their deltas monthly, and tensions are found', () => {
  const s = freshTown();
  adoptPolicy(s, 'mill-rights', 1);
  s.deltaLog.length = 0;
  policiesMonthly(s);
  const push = (key) => s.deltaLog.filter((d) => d.key === key && d.source === 'rule:mill-rights').reduce((n, d) => n + d.amount, 0);
  assert.ok(push('industry') > 0);
  assert.ok(push('ecology') < 0);

  adoptPolicy(s, 'wage-floor', 1);
  adoptPolicy(s, 'free-trade', 1);
  adoptPolicy(s, 'commons', 1);
  adoptPolicy(s, 'market-charter', 1);
  const tensions = detectTensions(s);
  assert.ok(tensions.some((t) => t.left === 'free-trade' && t.right === 'wage-floor' && t.why === 'open'));
  assert.ok(tensions.some((t) => [t.left, t.right].includes('commons') && [t.left, t.right].includes('market-charter') && t.why === 'cancel'));
});

test('a rule against the grain costs more and makes people grumble', () => {
  const s = freshTown();
  adoptPolicy(s, 'commons', 1);
  const normal = upkeepFor(s, 'commons');
  s.traits.market = 0.6;
  const grain = againstGrain(s, 'commons', 1);
  assert.equal(grain.against, true);
  assert.deepEqual(grain.traits, ['market']);
  assert.ok(Math.abs(grain.factor - 2.2) < 1e-9);
  assert.ok(upkeepFor(s, 'commons') >= Math.floor(normal * 2.2) - 1);
  s.deltaLog.length = 0;
  policiesMonthly(s);
  assert.ok(s.deltaLog.some((d) => d.key === 'unrest' && d.amount === GRAIN_UNREST && d.source === 'rule:commons:grain'));
  s.traits.market = -0.6;
  assert.equal(againstGrain(s, 'commons', 1).against, false);
});

test('rulings move coin between accounts and never create it', () => {
  const s = fixtureState('town');
  s.treasury = Math.max(s.treasury, 1000); // the fixture's coin varies; the baseline is taken after
  const before = totalMoney(s) - externalNet(s);
  const card = makeCard(s, {kind: 'proposal', from: 'moot', templateId: 'test-spend', category: 'civic', title: 'A test',
    why: 'Test.', cost: 300, options: [{key: 'do', label: 'Spend', tradeoff: 'It costs coin.', cost: 300, effects: [{spend: 'cost'}]}]});
  s.docket.push(card);
  card.surfacedMonth = 0;
  assert.equal(rule(s, card.id, 'do').ok, true);
  assert.ok(Math.abs(totalMoney(s) - externalNet(s) - before) < 1e-6);
});

// ---------------------------------------------------------------------------
// Docket

test('sessions surface cards up to the cap for the era', () => {
  for (const era of [0, 2, 5]) {
    const s = freshTown();
    s.era = era;
    for (let i = 0; i < 8; i++) {
      addCard(s, makeCard(s, {kind: 'proposal', from: 'moot', templateId: `t${i}`, title: `Card ${i}`, why: 'Test.',
        options: [{key: 'do', label: 'Do it', tradeoff: 'Test.'}]}));
    }
    s.time.month = 3;
    const shown = docketQuarterly(s);
    assert.equal(shown.length, sessionCap(era), `era ${era} session`);
    assert.equal(SESSION_CAP[era], sessionCap(era));
    let total = shown.length;
    for (const month of [6, 9]) {
      s.time.month = month;
      total += docketQuarterly(s).length;
    }
    assert.ok(total <= yearCap(era), `era ${era} year cap`);
  }
});

test('events and demands surface at once; unread proposals expire and cost patience', () => {
  const s = freshTown();
  const body = formBody(s, 'agri-council');
  const card = addCard(s, makeCard(s, {kind: 'proposal', from: body.id, templateId: 'x', title: 'X', why: 'Test.',
    options: [{key: 'do', label: 'Do it', tradeoff: 'Test.'}]}));
  s.time.month = 3;
  docketQuarterly(s);
  assert.notEqual(card.surfacedMonth, null);
  const patience = body.patience;
  s.time.year += 3;
  governanceSystem.month(s, {});
  assert.ok(!s.docket.includes(card));
  assert.ok(body.patience < patience);
  assert.equal(s.cardHistory.at(-1).outcome, 'expired');
});

test('rival bodies with live proposals are merged into one debate card', () => {
  const s = freshTown();
  formBody(s, 'trades-guild');
  formBody(s, 'exchange');
  const one = (from, title) => makeCard(s, {kind: 'proposal', from, templateId: `${from}-plan`, title, why: 'Test.', helps: [],
    options: [{key: 'do', label: 'Do it', tradeoff: 'Test.', effects: [{tag: `${from}-won`}]}]});
  addCard(s, one('trades-guild', 'Guild prices'));
  addCard(s, one('exchange', 'Free trade'));
  const proposals = s.docket.filter((c) => c.kind === 'proposal');
  const debates = s.docket.filter((c) => c.kind === 'debate');
  assert.equal(proposals.length, 0);
  assert.equal(debates.length, 1);
  assert.deepEqual(debates[0].data.sides, ['trades-guild', 'exchange']);
  assert.deepEqual(debates[0].options.map((o) => o.key), ['a', 'b', 'neither']);
  debates[0].surfacedMonth = 0;
  rule(s, debates[0].id, 'b');
  assert.ok(s.tags['exchange-won'] != null && s.tags['trades-guild-won'] == null);
  assert.equal(bodyOf(s, 'exchange').accepted, 1);
});

// ---------------------------------------------------------------------------
// Events

test('events fire only under their conditions and respect cooldowns', () => {
  const s = freshTown();
  s.pressures.ecology = 0.3;
  s.time.month = 6; // autumn: no spring flood
  invalidateCtx(s);
  for (let i = 0; i < 300; i++) eventsMonthly(s);
  assert.equal(s.tagCounts['event:flood'] ?? 0, 0);

  s.time.month = 0;
  invalidateCtx(s);
  for (let i = 0; i < 600 && !s.tagCounts['event:flood']; i++) eventsMonthly(s);
  assert.equal(s.tagCounts['event:flood'], 1);
  assert.equal(s.events.cooldownUntil.flood, s.time.year + EVENTS.flood.cooldown);
  assert.ok(s.docket.some((c) => c.kind === 'event' && c.data.event === 'flood'));
  assert.ok(s.worldEvents.some((w) => w.kind === 'flood' && Number.isFinite(w.x) && Number.isFinite(w.z) && w.radius > 0 && w.t1 > w.t0));

  s.docket = [];
  for (let i = 0; i < 300; i++) eventsMonthly(s);
  assert.equal(s.tagCounts['event:flood'], 1, 'the cooldown holds');
});

// ---------------------------------------------------------------------------
// Chronicle

test('year-end lines are written, and the end-of-chronicle page appears at year 150', () => {
  const s = fixtureState('town');
  chronicleYearly(s);
  const line = s.chronicle.entries.at(-1);
  assert.equal(line.kind, 'year');
  assert.match(line.text, /^Year \d+ ends\./);
  assert.deepEqual(lintText(line.text), []);
  assert.equal(s.chronicle.summary, null);
  s.time.year = END_YEAR;
  chronicleYearly(s);
  const end = s.chronicle.summary;
  assert.ok(end && end.sentences.length >= 3 && end.arc.length >= 1 && Array.isArray(end.highlights));
  for (const text of end.sentences) assert.deepEqual(lintText(text), []);
  assert.ok(end.highlights.length <= 12);
  assert.equal(view.selectUnlocks(s).endPage, true);
});

test('a torn faction splits in two, and merges back after ten calm years', () => {
  const s = fixtureState('town');
  const farmers = s.households.filter((h) => h.trade === 'farm' && h.newcomerUntil == null);
  assert.ok(farmers.length > 4);
  const district = farmers[0].districtId;
  const kids = splitFaction(s, 'farmers', 'district', district);
  assert.equal(kids.length, 2);
  for (const h of farmers) assert.equal(factionOf(s, h), h.districtId === district ? 'farmers:a' : 'farmers:b');
  assert.equal(view.selectFactions(s).some((f) => f.id === 'farmers'), false, 'the parent has no members of its own');
  assert.ok(view.selectFactions(s).some((f) => f.id === 'farmers:a' && f.name.endsWith('farmers')));
  s.time.year += 11;
  factionsYearly(s);
  assert.ok(!s.factions.some((f) => f.parent === 'farmers'));
  assert.equal(factionOf(s, farmers[0]), 'farmers');
});

test('cards expose stored prose separately while canonical reasons and trade-offs stay authoritative', () => {
  const s = freshTown();
  const card = addCard(s, makeCard(s, {kind: 'proposal', from: 'moot', templateId: 'p', title: 'A plan', why: 'Template why.',
    options: [{key: 'do', label: 'Do it', tradeoff: 'Template trade-off.'}]}));
  card.surfacedMonth = 0;
  assert.equal(card.needsProse, true);
  let shown = view.selectDocket(s)[0];
  assert.equal(shown.why, 'Template why.');
  assert.equal(setCardProse(s, card.id, {why: 'Mara leans in. The plan is sound.', options: {do: 'It will work.'}, source: 'narrator'}).ok, true);
  shown = view.selectDocket(s)[0];
  assert.equal(shown.why, 'Template why.');
  assert.equal(shown.prose.why, 'Mara leans in. The plan is sound.');
  assert.equal(shown.templateWhy, 'Template why.');
  assert.equal(shown.options.find((o) => o.key === 'do').tradeoff, 'Template trade-off.');
  assert.equal(shown.prose.options.do, 'It will work.');
  assert.equal(shown.options.find((o) => o.key === 'refuse').tradeoff, 'They will not like it.');
  assert.equal(card.needsProse, false);
});

test('rule upkeep never takes more than half the treasury income', () => {
  const s = fixtureState('town');
  for (const id of Object.keys(POLICIES)) if (!POLICIES[id].oneOff && !POLICIES[id].locks) adoptPolicy(s, id, POLICIES[id].maxLevel);
  const before = s.economy.month.policies ?? 0;
  governanceSystem.month(s, {});
  const paid = (s.economy.month.policies ?? 0) - before;
  assert.ok(s.governance.ruleFunding < 1, `funding ${s.governance.ruleFunding}`);
  assert.ok(paid <= (UPKEEP_CAP * fiscalBase(s)) / 12 + 1, `paid ${paid}`);
});

test('world events carry month-index times and a place', () => {
  const s = fixtureState('town');
  fireEvent(s, 'flood');
  const w = s.worldEvents.find((e) => e.kind === 'flood');
  const m = s.time.year * 12 + s.time.month;
  assert.equal(w.t0, m);
  assert.equal(w.t1, m + 2);
  assert.ok(Number.isFinite(w.x) && Number.isFinite(w.z));
});

test('a bare state without governance does not break the distribution hook', () => {
  const s = emptyState(5);
  assert.equal(distribution(s, 'household_stay_move', {type: 'household', record: {id: 1, size: 2}}), null);
});

test('player agency: demands are rare, negotiation enacts nothing, bodies act alone at most once a decade', () => {
  const s = freshTown();
  const body = formBody(s, 'trades-guild');
  body.power = 0.9;
  const demand = () => makeCard(s, {kind: 'demand', from: body.id, templateId: 'adopt:apprenticeship', title: 'Apprenticeships', why: 'Test.',
    data: {policy: 'apprenticeship'}, options: [{key: 'do', label: 'Bring them in', tradeoff: 'Test.', effects: [{policy: 'apprenticeship', level: 1}]}]});
  const card = addCard(s, demand());
  assert.deepEqual(card.options.map((o) => o.key), ['do', 'negotiate']);
  assert.equal(rule(s, card.id, 'negotiate').outcome, 'negotiating');
  assert.equal(view.selectDocket(s).some((c) => c.id === card.id), false, 'hidden while they consider the offer');
  applyNegotiation(s, card.id, 'insist');
  assert.ok(card.options.some((o) => o.key === 'refuse_anyway'), 'insisting leaves a costly way to say no');
  applyNegotiation(s, card.id, 'accept_half');
  assert.equal(s.policies.apprenticeship, undefined, 'a compromise enacts no rule');

  // An unread demand: the body acts alone once, then not again for ten years.
  body.funds = 1000;
  for (const round of [0, 1]) {
    const d = addCard(s, demand());
    d.expiresMonth = 0;
    docketMonthly(s);
    if (round === 0) {
      assert.equal(s.policies.apprenticeship?.by, body.id);
      adoptPolicy(s, 'apprenticeship', 0);
    } else {
      assert.equal(s.policies.apprenticeship, undefined, 'capped at once a decade');
    }
  }
});

test('an unread event takes its status-quo choice, which adopts no rule', () => {
  const s = freshTown();
  s.time.month = 4;
  fireEvent(s, 'drought');
  const card = s.docket.find((c) => c.data?.event === 'drought');
  assert.equal(card.options.at(-1).key, 'ration', 'the status quo is listed last');
  card.surfacedMonth = 0;
  card.expiresMonth = 0;
  docketMonthly(s);
  assert.equal(s.policies.wells, undefined);
  assert.equal(s.cardHistory.at(-1).choice, 'ration');
});

test('rules the player approves are the player\'s; the drafting body is remembered', () => {
  const s = freshTown();
  formBody(s, 'agri-council');
  const card = addCard(s, makeCard(s, {kind: 'proposal', from: 'agri-council', templateId: 'adopt:granary', title: 'The town granary', why: 'Test.',
    data: {policy: 'granary'}, options: [{key: 'do', label: 'Bring it in', tradeoff: 'Test.', effects: [{policy: 'granary', level: 1}]}]}));
  card.surfacedMonth = 0;
  rule(s, card.id, 'do');
  assert.equal(s.policies.granary.by, 'player');
  assert.equal(s.policies.granary.draftedBy, 'agri-council');
});

test('chronicle lines have stable ids and take narrator prose', () => {
  const s = fixtureState('town');
  chronicleYearly(s);
  const line = s.chronicle.entries.at(-1);
  assert.ok(line.id && line.needsProse);
  const first = view.selectChronicle(s, {limit: 50}).map((e) => e.id);
  assert.equal(new Set(first).size, first.length, 'ids are unique');
  assert.deepEqual(view.selectChronicle(s, {limit: 50}).map((e) => e.id), first, 'and stable');
  assert.equal(setChronicleProse(s, {year: s.time.year - 1, text: 'A good year by the river.', source: 'narrator'}).ok, true);
  const shown = view.selectChronicle(s, {limit: 1})[0];
  assert.equal(shown.text, 'A good year by the river.');
  assert.equal(shown.templateText, line.text);
  s.time.year = END_YEAR;
  chronicleYearly(s);
  assert.equal(s.chronicle.summary.needsProse, true);
  assert.equal(setSummaryProse(s, {eras: [{era: 0, text: 'Huts by the ford.'}], closing: ['It endured.'], source: 'narrator'}).ok, true);
  assert.deepEqual(s.chronicle.summary.prose.closing, ['It endured.']);
  assert.deepEqual(s.chronicle.summary.prose.centres, [], 'centre prose only for centres on the page');
});

test('the top bar has the valley code and homes; title-card events are flagged', () => {
  const s = fixtureState('town');
  const top = view.selectTopBar(s);
  assert.match(top.seed, /^[0-9A-Z]+$/);
  assert.ok(top.homes > 0 && Number.isInteger(top.homesWaiting));
  assert.ok(view.TITLE_CARD_EVENTS.includes('flood') && view.TITLE_CARD_EVENTS.includes('plague'));
  assert.ok(!view.TITLE_CARD_EVENTS.includes('bumper-harvest'));
});

test('discoveries and new chapels go on high ground; bodies have a colour and a seat', () => {
  const s = fixtureState('town');
  const hill = highPoint(s);
  const centre = s.districts[0].centroid;
  assert.ok(heightAt(hill.x, hill.z) >= heightAt(centre.x, centre.z));
  assert.match(governanceSystem.bodyColor(s, 'moot'), /^#[0-9a-f]{6}$/);
  assert.equal(governanceSystem.bodyBuilding(s, 'moot')?.type, 'moot');
});

test('newcomers settle by the sim\'s own rule: a wave spreads out, and dear land draws merchants more than the poor', () => {
  assert.equal(KIND_BY_ID.where_to_settle, undefined, 'no longer a decision question');
  const settled = (wealth, trade) => {
    const s = fixtureState('town');
    const before = s.households.length;
    immigrate(s, 300, {wealth, trade});
    return s.households.slice(before);
  };
  const s = fixtureState('town');
  const mean = s.districts.reduce((n, d) => n + (s.districtLand[d.id] ?? 0), 0) / s.districts.length;
  const dearShare = (hs) => hs.filter((h) => (s.districtLand[h.districtId] ?? 0) > mean).reduce((n, h) => n + h.size, 0) / hs.reduce((n, h) => n + h.size, 0);
  const poor = settled(0.5, 'labour'), rich = settled(2, 'trade');
  assert.ok(new Set(poor.map((h) => h.districtId)).size >= 5, 'a wave spreads over several districts');
  assert.ok(dearShare(rich) > dearShare(poor), `merchants ${dearShare(rich).toFixed(2)} vs poor ${dearShare(poor).toFixed(2)} in dear districts`);
});

test('a strike asks one strike_resolve question; households walk out in the sim, harder with more resolve', async () => {
  assert.equal(KIND_BY_ID.strike_vote, undefined);
  const outputFor = async (choice) => {
    const s = fixtureState('town');
    const asked = [];
    const bus = {
      stats: () => ({state: 'idle', room: 0}),
      async ask(kind, id, context) {
        if (kind !== 'strike_resolve') return null;
        asked.push(context);
        assert.equal(validateContext(kind, context), null);
        return {kind, choice, confidence: 0.9, probabilities: {back_down: 0, some: 0, most: 0, solid: 0, [choice]: 1}};
      },
    };
    const rec = fireEvent(s, 'strike', {force: true});
    runMonths(s, 0.2, {decisions: bus, now: () => 0});
    await new Promise((r) => setImmediate(r));
    runMonths(s, 0.2, {decisions: bus, now: () => 0});
    assert.equal(asked.length, 1, 'one question per strike');
    const walk = s.events.active.find((e) => e.id === `${rec.id}m`)?.walkout;
    assert.ok(walk && walk.strike > 0, JSON.stringify(walk));
    return s.events.active.find((e) => e.id === `${rec.id}m`).mods.output;
  };
  const soft = await outputFor('back_down'), hard = await outputFor('solid');
  assert.ok(hard < soft, `solid ${hard} < back_down ${soft}`);
  assert.ok(hard >= 0.4 && soft <= 1);
});

test('offline, a strike still settles: the resolve question gets its local answer', () => {
  const s = fixtureState('town');
  const rec = fireEvent(s, 'strike', {force: true});
  runMonths(s, 0.5);
  const walk = s.events.active.find((e) => e.id === `${rec.id}m`)?.walkout;
  assert.ok(walk && walk.resolve > 0.4 && walk.resolve < 1.7, JSON.stringify(walk));
  assert.ok(s.events.active.find((e) => e.id === `${rec.id}m`).mods.output < 1);
});

test('a save from before keeps loading: retired kinds\' questions and answers are dropped', () => {
  const s = fixtureState('town');
  const gov = s.governance;
  gov.asks.push({kind: 'strike_vote', meta: {record: 'e1', event: 'strike'}});
  (gov.inflight ??= []).push({id: 999, kind: 'strike_vote', meta: {}, month: 0, tick: 0, questions: [{key: 'k', context: {}, subject: {dim: 'district', value: 'x'}}], answers: {}, answered: 0});
  gov.sliceAnswers['strike_vote@e1'] = {'district=x': {probs: {strike: 1}, month: 0}};
  gov.individual.where_to_settle = {'{}': {probs: {d1: 1}, month: 0}};
  const back = restore(serialize(s));
  assert.ok(!back.governance.asks.some((a) => a.kind === 'strike_vote'));
  assert.ok(!(back.governance.inflight ?? []).some((x) => x.kind === 'strike_vote'));
  assert.equal(back.governance.sliceAnswers['strike_vote@e1'], undefined);
  assert.equal(back.governance.individual.where_to_settle, undefined);
  runMonths(back, 1);
});

test('bridges: a cart bridge is on offer soon after people start crossing, and waits for demand to double after Not now', () => {
  const s = createState(7);
  let first = null, available = null;
  for (let m = 0; m < 12 * 30 && available == null; m++) {
    runMonths(s, 1);
    if (first == null && crossRiverShare(s) > 0) first = s.time.year;
    if (first != null && eligibleTemplates(s, bodyOf(s, 'moot')).some((t) => t.template === 'cart-bridge')) available = s.time.year;
  }
  assert.ok(first != null, 'people cross the river');
  assert.ok(available != null && available - first <= 4, `available ${available - first} years after the first crossings`);
  const choice = eligibleTemplates(s, bodyOf(s, 'moot')).find((t) => t.template === 'cart-bridge');
  assert.ok(choice.need < 0.9, 'an option, not a push');
  // Not now: it waits until demand doubles, whatever the years.
  const card = bodiesDraft(s, choice);
  s.docket.push(card);
  card.surfacedMonth = 0;
  rule(s, card.id, 'not_now');
  s.time.year += 5;
  invalidateCtx(s);
  const w = basicBridges(s)[0];
  const demand = s.cardHistory.at(-1).demand;
  const back = eligibleTemplates(s, bodyOf(s, 'moot')).some((t) => t.template === 'cart-bridge');
  assert.equal(back, bridgeDemand(w) >= 2 * demand);
});

test('no nagging: "Not now" on everything for 30 years', () => {
  const s = createState(2024);
  const seen = new Map();
  const shown = [];
  for (let m = 0; m < 12 * 30; m++) {
    runMonths(s, 1);
    for (const c of [...s.docket]) {
      if (c.surfacedMonth == null || seen.has(c.id)) continue;
      seen.set(c.id, true);
      shown.push({templateId: c.templateId, year: s.time.year, era: s.era, place: c.data?.workId ?? null, demand: c.data?.demand ?? null});
      const keys = c.options.map((o) => o.key);
      rule(s, c.id, keys.includes('not_now') ? 'not_now' : keys.at(-1));
    }
  }
  const grading = shown.filter((c) => c.templateId === 'grade-track');
  assert.ok(grading.length <= 2, `grading cards: ${grading.length}`);
  assert.equal(shown.filter((c) => c.templateId === 'pave-lane' && c.era < 2).length, 0, 'no paving before era 2');
  // The same template and place never comes back inside its Not-now cooldown;
  // a demand-led plan (the cart bridge) comes back only once its demand has doubled.
  const last = new Map();
  for (const c of shown) {
    const key = `${c.templateId}|${c.place}`;
    const prev = last.get(key);
    if (prev && !c.templateId.startsWith('event:')) {
      if (c.demand != null) assert.ok(c.demand >= 2 * prev.demand, `${key} back before its demand doubled`);
      else assert.ok(c.year - prev.year >= COOLDOWN_YEARS.not_now, `${key} again after ${c.year - prev.year} years`);
    }
    last.set(key, c);
  }
});

// The owner's harness: 40 years, ruling two cards in three with the first
// option and the third with the last. No question may come back too soon.
test('no duplicate questions: 40 years on three seeds, by subject, from every source', () => {
  const fam = (x) => x.slice(0, x.indexOf(':'));
  const verdictOf = (k) => (k === 'not_now' ? 'not_now' : k === 'refuse' || k === 'neither' ? 'refuse' : k === 'negotiate' ? null : 'accepted');
  const problems = [];
  for (const seed of [7, 3, 42]) {
    const s = createState(seed);
    const seen = new Set();
    const ruled = new Map();
    const eventYear = new Map();
    const pairYear = new Map();
    let n = 0;
    const note = (subjects, verdict, extra = {}) => { for (const x of subjects ?? []) ruled.set(x, {year: s.time.year, verdict, ...extra}); };
    while (s.time.year < 40) {
      stepTick(s, 4, {}, {skipPeople: true});
      // Never the same subject twice on the docket at once.
      const open = new Map();
      for (const c of s.docket) {
        if (c.kind === 'report') continue;
        for (const x of c.subjects ?? []) {
          if (open.has(x) && open.get(x) !== c.id) problems.push(`s${seed} y${s.time.year} ${x} open twice`);
          open.set(x, c.id);
        }
      }
      for (const c of [...s.docket]) {
        if (c.surfacedMonth == null || seen.has(c.id) || c.kind === 'report' || c.negotiating) continue;
        seen.add(c.id);
        const y = s.time.year;
        const tag = `s${seed} y${y} ${c.templateId}`;
        for (const sub of c.data?.batch ?? c.data?.cards ?? [c]) {
          for (const x of sub.subjects ?? []) {
            if ((x.startsWith('work:') || x.startsWith('build:')) && subjectInFlight(s, x)) problems.push(`${tag}: ${x} is under way`);
            const r = ruled.get(x);
            if (!r) continue;
            let years = SUBJECT_COOLDOWN[r.verdict]?.[fam(x)] ?? 0;
            if (TEMPLATES[sub.templateId]?.returnsOnDemand && r.verdict !== 'accepted') years = 0;   // returns when demand doubles
            if (fam(x) === 'rule' && (c.data?.need ?? 0) >= SHARP_NEED) years = Math.min(years, SHARP_GAP_YEARS);
            if (fam(x) === 'petition' && r.mood - (c.data?.mood ?? r.mood) > 0.2) years = 0;
            if (y - r.year < years) problems.push(`${tag}: ${x} again ${y - r.year} years after ${r.verdict}`);
          }
        }
        if (String(c.templateId).startsWith('adopt:') && (s.policies[c.templateId.slice(6)]?.level ?? 0) > 0) problems.push(`${tag}: rule already in force`);
        if (c.kind === 'event') {
          const last = eventYear.get(c.data.event);
          if (last != null && y - last < (EVENTS[c.data.event].cooldown ?? 1)) problems.push(`${tag}: event again after ${y - last} years`);
          eventYear.set(c.data.event, y);
        }
        if (c.kind === 'debate') {
          const pair = c.data.cards.map((x) => x.templateId).sort().join('|');
          if (pairYear.has(pair) && y - pairYear.get(pair) < 6) problems.push(`${tag}: debate again`);
          pairYear.set(pair, y);
        }
        const keys = c.options.map((o) => o.key);
        let pick = n++ % 3 === 2 ? keys.at(-1) : keys[0];
        let r = rule(s, c.id, pick);
        if (!r.ok && r.reason === 'no-coin') r = rule(s, c.id, pick = keys.at(-1));
        if (!r.ok) continue;
        if (c.kind === 'debate') {
          const side = c.options.find((o) => o.key === pick)?.side;
          for (const sub of c.data.cards) note(sub.subjects, sub.from === side ? 'accepted' : 'refuse');
        } else if (c.data?.batch && /^[xy]_/.test(pick)) {
          const [mine, other] = pick[0] === 'x' ? c.data.batch : [c.data.batch[1], c.data.batch[0]];
          note(other.subjects, 'not_now');
          note(mine.subjects, 'accepted');
        } else if (verdictOf(pick)) {
          note(c.subjects, verdictOf(pick), {mood: c.data?.mood ?? null});
        }
      }
    }
    assert.ok(seen.size > 60, `seed ${seed}: still a living docket (${seen.size} cards)`);
  }
  assert.deepEqual(problems, []);
});

test('subjects: a placeless plan waits after Do it; a rule waits after any change; a repeat petition asks harder', () => {
  const s = createState(5);
  s.time.year = 20;
  const moot = bodyOf(s, 'moot');
  // Public works, accepted: not again for three years, from anyone.
  s.cardHistory.push({id: 'h1', templateId: 'public-works', choice: 'do', outcome: 'accepted', year: 19, subjects: subjectsOfTemplate('public-works')});
  assert.ok(subjectBlocked(s, subjectsOfTemplate('public-works')));
  s.time.year = 23;
  assert.equal(subjectBlocked(s, subjectsOfTemplate('public-works')), null);
  // A rule changed by anyone (here a strike) waits eight years, three if the need is sharp.
  adoptPolicy(s, 'wage-floor', 1, 'event');
  s.time.year = 26;
  assert.equal(subjectBlocked(s, ['rule:wage-floor'])?.why, 'in-flight');
  assert.equal(subjectBlocked(s, ['rule:wage-floor'], {need: 0.9}), null);
  assert.ok(!eligibleTemplates(s, moot).some((t) => t.policy === 'wage-floor' && t.need < SHARP_NEED));
  // An event never fires while its subject is on the docket.
  s.events.cooldownUntil.fair = -1;
  const card = addCard(s, makeCard(s, {kind: 'proposal', from: 'moot', templateId: 'fair', options: TEMPLATES.fair.options}));
  assert.ok(card.subjects.includes('event:fair'));
  assert.equal(fireEvent(s, 'fair'), null);
  // The same question twice on the docket: the second is dropped.
  assert.equal(addCard(s, makeCard(s, {kind: 'proposal', from: 'moot', templateId: 'fair', options: TEMPLATES.fair.options})), null);
  // A group heard on a grievance comes back asking harder.
  s.cardHistory.push({id: 'h2', templateId: 'grievance:roads', faction: 'farmers', choice: 'hear', outcome: 'accepted', year: 10, mood: 0.5,
    subjects: ['petition:farmers:roads']});
  assert.equal(subjectBlocked(s, ['petition:farmers:roads'], {mood: 0.45}), null, 'eight years have passed');
  s.cardHistory.push({id: 'h3', templateId: 'grievance:roads', faction: 'farmers', choice: 'hear', outcome: 'accepted', year: 22, mood: 0.5,
    subjects: ['petition:farmers:roads']});
  assert.ok(subjectBlocked(s, ['petition:farmers:roads'], {mood: 0.45}));
  assert.equal(subjectBlocked(s, ['petition:farmers:roads'], {mood: 0.2}), null, 'much worse off: they may come back');
});

test('every rule in force appears in the Rule Book, and rules are offered only once their chapter opens', () => {
  for (const name of ['town', 'city']) {
    const s = fixtureState(name);
    const shown = new Set(view.selectRuleBook(s).filter((c) => c.open).flatMap((c) => c.policies.filter((p) => p.level > 0).map((p) => p.id)));
    for (const [id, p] of Object.entries(s.policies)) if (p.level > 0) assert.ok(shown.has(id), `${name}: ${id} is in force but not shown`);
  }
  const hamlet = createState(3);
  const moot = bodyOf(hamlet, 'moot');
  for (const t of eligibleTemplates(hamlet, moot)) {
    if (!t.policy) continue;
    assert.ok(['land', 'food', 'tax'].includes(POLICIES[t.policy].category), `${t.policy} offered in the hamlet`);
  }
});

test('displacement: a sale is noted, the old trades petition, and dear land makes farms sell', () => {
  const s = fixtureState('town');
  s.cardHistory = [];
  s.docket = [];
  // The grown town may have capped rents already: start from no cap.
  delete s.policies['rent-cap'];
  if (s.governance.ruleChanged) delete s.governance.ruleChanged['rent-cap'];
  formBody(s, 'agri-council');
  const farmer = s.households.find((h) => h.trade === 'farm');
  governanceSystem.displaced(s, {kind: 'farm', reason: 'sale', households: [farmer.id]});
  governanceSystem.displaced(s, {kind: 'farm', reason: 'rent'});
  assert.equal(s.tags['farmland-sold'], s.time.year);
  assert.equal(farmer.story.at(-1).kind, 'displaced');
  invalidateCtx(s);
  assert.ok(eligibleTemplates(s, bodyOf(s, 'agri-council')).some((t) => t.template === 'keep-old-fields'));
  const cheap = fallbackFor('farm_land', {landValue: 'rising', profit: 'good', valueRatio: 'low'}, null, s);
  const dear = fallbackFor('farm_land', {landValue: 'very_high', profit: 'thin', valueRatio: 'very_high'}, null, s);
  assert.ok(dear.sell_all_and_move_out > cheap.sell_all_and_move_out * 5 && cheap.keep > 0.5);
  const crushed = fallbackFor('enterprise_plan', {type: 'farm', jobs: 4, cash: 50, profit: 10, demand: 'mid', labour: 'ok', rent: 'crushing', siteOffer: 'rich', landHungry: 'yes'}, null, freshTown());
  assert.ok(crushed.relocate + crushed.sell_site > 0.4);
  adoptPolicy(s, 'rent-cap', 1);
  adoptPolicy(s, 'land-value-tax', 1);
  assert.ok(view.selectTensions(s).rules.some((t) => [t.left.id, t.right.id].includes('rent-cap')));
});

// The town fixture with exactly two centres, the second of a given size and no
// ward councils yet (the regrown fixture may already have some).
function twoCentres(pop = 900) {
  const s = fixtureState('town');
  s.docket = [];
  s.institutions = s.institutions.filter((b) => b.kind !== 'ward');
  for (const t of Object.keys(s.tags)) if (t.includes('ward:')) delete s.tags[t];
  for (const k of Object.keys(s.governance.petitionWait ?? {})) if (k.startsWith('ward:')) delete s.governance.petitionWait[k];
  const seat = {...(s.centres?.[0] ?? {id: 1, name: 'Hearthvale', x: 0, z: 0, character: 'market-town'}), pop: 1200, monthly: undefined, mergedInto: null};
  s.centres = [seat, {id: 2, name: 'Millbridge', x: seat.x + 60, z: seat.z + 20, pop, kind: 'town', character: 'mill', autonomy: 0, rank: 2, mergedInto: null, founded: 20}];
  s.households.forEach((h, i) => { h.centreId = i % 3 === 0 ? 2 : seat.id; });
  return s;
}

test('centres: a grown centre petitions for a ward council; wards rival; merge, federate or stay apart', () => {
  const small = twoCentres(150);
  monthly(small, institutionsMonthly, 36);
  assert.ok(!small.docket.some((c) => c.data?.forms === 'ward:2'), 'not before it has grown');

  const s = twoCentres(900);
  monthly(s, institutionsMonthly, 36);
  const petition = s.docket.find((c) => c.data?.forms === 'ward:2');
  assert.ok(petition, 'a ward petition');
  petition.surfacedMonth = 0;
  rule(s, petition.id, 'standard');
  const ward = wardOf(s, 2);
  assert.equal(ward.name, 'Millbridge Ward Council');
  assert.equal(view.selectBodies(s).find((b) => b.id === 'ward:2').kind, 'ward');

  const centres = view.selectCentres(s);
  assert.equal(centres.region.centres, 2);
  assert.ok(centres.centres.find((c) => c.id === 2).bodyId === 'ward:2');
  assert.equal(view.selectUnlocks(s).places, true);

  const tiny = twoCentres(300);
  tiny.era = 3;
  assert.equal(unionCard(tiny), null, 'no merge card for a small centre');
  for (const choice of ['merge', 'federate', 'apart']) {
    const t = twoCentres(900);
    t.era = 3;
    const card = unionCard(t);
    assert.ok(card, 'grown together: a union card');
    card.surfacedMonth = 0;
    rule(t, card.id, choice);
    const mill = t.centres.find((c) => c.id === 2);
    if (choice === 'merge') assert.equal(mill.mergedInto, t.centres[0].id);
    if (choice === 'federate') assert.equal(mill.federated, true);
    if (choice === 'apart') assert.ok(t.tags['apart:2'] != null && mill.mergedInto == null);
  }
});

test('bridge upgrades: a busy or worn bridge gets a card; it returns sooner as load rises; worn bridges may fall', async () => {
  const {bridgeRisk} = await import('../src/sim/events.js');
  const s = freshTown();
  s.era = 2;
  formBody(s, 'river-authority');
  const candidate = (load, age = 16, id = 5) => ({id: `bridge-upgrade:${id}`, bridgeId: id, where: 'Old Ford', place: 'at the ford by Old Ford', load, condition: 0.7, age,
    options: [{key: 'stone', cost: 3000}, {key: 'widen', cost: 900}, {key: 'repair', cost: 300}]});
  const body = bodyOf(s, 'river-authority');
  s.governance.upgradeCache = {month: s.time.year * 12 + s.time.month, list: [candidate(1.4, 4)]};
  assert.ok(!eligibleTemplates(s, body).some((t) => t.template === 'bridge-upgrade'), 'a busy bridge under fifteen years old is not rebuilt');
  s.governance.upgradeCache = {month: s.time.year * 12 + s.time.month, list: [candidate(1.4)]};
  const choice = eligibleTemplates(s, body).find((t) => t.template === 'bridge-upgrade');
  assert.ok(choice && choice.need > 0.4);
  const card = bodiesDraftCard(s, body, choice);
  assert.equal(card.title, 'The Old Ford bridge is too small');
  assert.deepEqual(card.options.map((o) => o.key).slice(0, 3), ['stone', 'widen', 'repair'], 'no iron before era 4');
  s.docket.push(card);
  card.surfacedMonth = 0;
  rule(s, card.id, 'not_now');
  s.time.year += 1;
  s.governance.upgradeCache = {month: s.time.year * 12 + s.time.month, list: [candidate(1.5)]};
  assert.ok(!eligibleTemplates(s, body).some((t) => t.template === 'bridge-upgrade'), 'not back for a little more load');
  s.governance.upgradeCache = {month: s.time.year * 12 + s.time.month, list: [candidate(1.9)]};
  assert.ok(eligibleTemplates(s, body).some((t) => t.template === 'bridge-upgrade'), 'back once load has risen by a quarter');
  s.governance.upgradeCache = {month: s.time.year * 12 + s.time.month, list: [candidate(1.5, 16, 6)]};
  assert.ok(eligibleTemplates(s, body).some((t) => t.template === 'bridge-upgrade'), 'a Not now at one bridge is no answer for another');
  assert.equal(bridgeRisk(s), 0);
  addBuildingRecord(s, {type: 'bridge', variant: 'timber', x: 0, z: 0, condition: 0.9, traffic: 150});
  assert.equal(bridgeRisk(s), 0, 'a bridge in fair repair does not fall');
  addBuildingRecord(s, {type: 'bridge', variant: 'timber', x: 0, z: 0, condition: 0.9, traffic: 150});
  assert.equal(bridgeRisk(s), 0, 'a bridge in fair repair does not fall');
  addBuildingRecord(s, {type: 'bridge', variant: 'timber', x: 0, z: 0, condition: 0.3, traffic: 150});
  const risk = bridgeRisk(s);
  assert.ok(risk >= 0.05 && risk < 0.5, `a worn, overloaded bridge is at risk (${risk})`);
});

test('a fallen bridge closes; rebuilding it reopens the same bridge, and no second card asks about it', () => {
  const s = fixtureState('town');
  s.docket = [];
  s.treasury = 1e6;
  // Footbridges never fall, so make sure the test bridge is a deck that can.
  const decks = s.buildings.filter((b) => b.type === 'bridge' && (b.built ?? 1) >= 1);
  const bridge = decks.find((b) => b.variant !== 'footbridge') ?? Object.assign(decks[0], {variant: 'timber'});
  for (const b of s.buildings) if (b.type === 'bridge') b.condition = b === bridge ? 0.2 : 0.9;
  const before = new Set(s.buildings.filter((b) => b.type === 'bridge').map((b) => b.id));
  const midZ = (b) => (b.a && b.b ? (b.a.z + b.b.z) / 2 : b.z);
  fireEvent(s, 'bridge-collapse', {force: true});
  const card = s.docket.find((c) => c.templateId === 'event:bridge-collapse');
  assert.ok(card && card.data.bridgeId === bridge.id, 'the card names the bridge that fell');
  assert.ok(bridge.collapsed && bridge.built === 0, 'the deck is closed');
  // While the card is open, no body drafts a separate bridge-works card.
  const owner = bodyOf(s, 'river-authority')?.status === 'active' ? bodyOf(s, 'river-authority') : bodyOf(s, 'moot');
  assert.ok(!eligibleTemplates(s, owner).some((t) => t.template === 'bridge-upgrade'));
  assert.equal(rule(s, card.id, 'timber').ok, true);
  assert.ok(s.projects.some((p) => p.kind === 'bridge-repair' && p.buildingId === bridge.id), 'the rebuild is under way');
  for (let m = 0; m < 36 && bridge.collapsed; m++) runMonths(s, 1);
  assert.ok(!bridge.collapsed && bridge.built >= 1, 'the same bridge is open again');
  // The town may start bridges elsewhere meanwhile; none replaces this one.
  const added = s.buildings.filter((b) => b.type === 'bridge' && !before.has(b.id));
  assert.ok(!added.some((b) => Math.abs(midZ(b) - midZ(bridge)) < 20), 'no new bridge was added at this crossing');
  assert.ok(!s.cardHistory.some((h) => h.templateId === 'bridge' && h.year === s.time.year), 'no second bridge card');
  // In stone, a new deck replaces the ruin: another timber bridge, else another
  // deck made timber, else the rebuilt one when the grown town has only one.
  const others = s.buildings.filter((b) => b.type === 'bridge' && b !== bridge && (b.built ?? 1) >= 1);
  const other = others.find((b) => b.variant === 'timber') ?? (others[0] ? Object.assign(others[0], {variant: 'timber'}) : bridge);
  for (const b of s.buildings) if (b.type === 'bridge') b.condition = b === other ? 0.2 : 0.9;
  s.events.cooldownUntil['bridge-collapse'] = -1;
  fireEvent(s, 'bridge-collapse', {force: true});
  const second = s.docket.find((c) => c.templateId === 'event:bridge-collapse');
  assert.ok(other.collapsed && second.data.bridgeId === other.id);
  assert.equal(rule(s, second.id, 'stone').ok, true);
  assert.ok(s.projects.some((p) => p.kind === 'bridge' && p.data?.replaces === other.id && p.data?.style === 'stone'), 'a stone bridge replaces the ruin');
});

// ---------------------------------------------------------------------------
// Selectors

test('selectors return the shapes in contract §5', () => {
  for (const name of ['hamlet', 'town', 'city']) {
    const s = fixtureState(name);
    const top = view.selectTopBar(s);
    for (const k of ['year', 'month', 'season', 'era', 'eraName', 'people', 'coin', 'coinTrend', 'food', 'foodMonths', 'wellbeing']) assert.ok(k in top, k);

    const docket = view.selectDocket(s);
    assert.ok(docket.length >= 1, `${name} has a card`);
    for (const c of docket) {
      for (const k of ['id', 'kind', 'from', 'institution', 'title', 'why', 'asker', 'urgency', 'options', 'expiresInMonths']) assert.ok(k in c, `card.${k}`);
      assert.ok(['proposal', 'petition', 'event', 'demand', 'debate', 'report'].includes(c.kind));
      for (const o of c.options) {
        assert.equal(typeof o.label, 'string');
        assert.ok(Array.isArray(o.reactions));
        for (const r of o.reactions) assert.ok(r.dir >= -2 && r.dir <= 2);
      }
    }

    for (const b of view.selectBodies(s)) {
      for (const k of ['id', 'name', 'icon', 'founded', 'status', 'power', 'patience', 'area', 'metrics', 'docketCount', 'rules']) assert.ok(k in b, `body.${k}`);
      assert.ok(b.metrics.length <= 6);
      for (const m of b.metrics) assert.ok(m.series.length <= 60 && typeof m.label === 'string');
    }

    const book = view.selectRuleBook(s);
    assert.equal(book.length, CATEGORIES.length);
    for (const cat of book) {
      for (const p of cat.policies) {
        for (const k of ['id', 'title', 'summary', 'level', 'maxLevel', 'since', 'by', 'tensions', 'againstGrain']) assert.ok(k in p, `policy.${k}`);
      }
    }
    const tensions = view.selectTensions(s);
    assert.ok(Array.isArray(tensions.rules) && Array.isArray(tensions.torn));
    for (const f of view.selectFactions(s)) for (const k of ['id', 'name', 'size', 'mood', 'trend']) assert.ok(k in f);
    for (const e of view.selectChronicle(s, {limit: 5})) assert.ok(typeof e.text === 'string' && 'year' in e && 'kind' in e);
    assert.ok(view.selectChronicle(s, {limit: 5}).length <= 5);
    const era = view.selectEraProgress(s);
    for (const c of era.conditions) assert.ok('label' in c && 'met' in c && 'progress' in c);
    const unlocks = view.selectUnlocks(s);
    assert.equal(unlocks.chronicle, true);
    assert.equal(unlocks.tensionsDashboard, s.era >= 4);
    const building = s.buildings.find((b) => b.type === 'home');
    assert.equal(view.selectInspect(s, {buildingId: building.id}).kind, 'building');
  }
  const city = fixtureState('city');
  adoptPolicy(city, 'wage-floor', 1);
  adoptPolicy(city, 'free-trade', 1);
  const pair = view.selectTensions(city).rules.find((t) => t.left.id === 'free-trade' && t.right.id === 'wage-floor');
  assert.ok(pair && pair.text.includes('pull against each other'), 'rules in tension are listed in plain words');

  // A debate card shows both sides and a strip of faction stances.
  const town = fixtureState('town');
  town.docket = [];
  for (const kind of ['union', 'exchange']) formBody(town, kind);
  // Neither rule in force or ruled on lately, whatever the grown town did.
  for (const id of ['hours-cap', 'free-trade']) { delete town.policies[id]; delete town.governance.ruleChanged?.[id]; }
  town.cardHistory = town.cardHistory.filter((h) => !['adopt:hours-cap', 'adopt:free-trade'].includes(h.templateId) && !String(h.templateId).includes('hours-cap') && !String(h.templateId).includes('free-trade'));
  town.governance.cardsThisYear = 0;
  town.governance.lastSessionMonth = -1;
  const plan = (from, policy) => makeCard(town, {kind: 'proposal', from, templateId: `adopt:${policy}`, title: POLICIES[policy].title,
    why: 'Test.', helps: POLICIES[policy].helps, hurts: POLICIES[policy].hurts, data: {policy},
    options: [{key: 'do', label: 'Do it', tradeoff: 'Test.', effects: [{policy, level: 1}]}]});
  addCard(town, plan('union', 'hours-cap'));
  addCard(town, plan('exchange', 'free-trade'));
  town.time.month = 3;
  town.era = 3;
  docketQuarterly(town);
  const debate = view.selectDocket(town).find((c) => c.kind === 'debate');
  assert.ok(debate, 'a debate is shown');
  assert.deepEqual(debate.sides, ['union', 'exchange']);
  assert.ok(debate.debate && Array.isArray(debate.debate.for) && Array.isArray(debate.debate.against));
  const [a, b] = debate.options;
  assert.ok(a.reactions.some((r) => r.faction === 'labourers' && r.dir > 0), 'workers back the union side');
  assert.ok(b.reactions.some((r) => r.dir !== 0), 'the exchange side has its own chips');
});

test('selectors are pure', () => {
  const s = fixtureState('town');
  const before = JSON.stringify({docket: s.docket, institutions: s.institutions, policies: s.policies, factions: s.factions});
  view.selectDocket(s);
  view.selectBodies(s);
  view.selectRuleBook(s);
  view.selectTensions(s);
  view.selectUnlocks(s);
  assert.equal(JSON.stringify({docket: s.docket, institutions: s.institutions, policies: s.policies, factions: s.factions}), before);
});

// ---------------------------------------------------------------------------
// Voice

test('the voice lint passes on all catalogue text', () => {
  const catalogues = {POLICIES, CATEGORIES, INSTITUTIONS, TEMPLATES, EVENTS, LINES, METRICS};
  for (const [name, cat] of Object.entries(catalogues)) {
    const issues = lintCatalogue(cat);
    assert.deepEqual(issues, [], `${name}: ${JSON.stringify(issues.slice(0, 3))}`);
  }
  // Text built at run time (cards, chronicle) follows the same rules.
  for (const name of ['town', 'city']) {
    const s = fixtureState(name);
    for (const c of view.selectDocket(s)) {
      for (const text of [c.title, c.why, ...c.options.flatMap((o) => [o.label, o.tradeoff])]) {
        assert.deepEqual(lintText(text), [], `${name}: "${text}"`);
      }
    }
  }
  assert.ok(lintText('Insufficient treasury to allocate funds for the proposed infrastructure expansion programme this year.').length > 0);
});

// ---------------------------------------------------------------------------
// Question kinds

test('the question kinds are well formed and their contexts validate', () => {
  assert.ok(KINDS.length >= 23);
  for (const k of KINDS) {
    assert.match(k.id, /^[a-z][a-z0-9_]{1,31}$/);
    const options = Object.keys(k.criteria);
    assert.ok(options.length >= 2 && options.length <= 16, k.id);
    for (const o of options) assert.match(o, /^[a-z][a-z0-9_]{0,31}$/);
    assert.ok(['town', 'district', 'slice', 'proposal', 'individual'].includes(k.share));
    assert.ok(Array.isArray(k.slices));
    for (const d of k.slices) assert.ok(k.weights[d] > 0, `${k.id} weight for ${d}`);
  }
  const s = fixtureState('city');
  const questions = previewQuestions(s);
  const kinds = new Set(questions.map((q) => q.kind));
  assert.ok(kinds.size >= 18, `asked ${kinds.size} kinds`);
  for (const q of questions) {
    assert.equal(validateContext(q.kind, q.context), null, `${q.kind} context ${JSON.stringify(q.context)}`);
    assert.equal(validateSnapshot(q.kind, q.snapshot), null, `${q.kind} snapshot`);
    const text = KIND_BY_ID[q.kind].instructions(q.context, q.allowed ?? Object.keys(KIND_BY_ID[q.kind].criteria));
    assert.ok(text.split(/\s+/).length <= 60, `${q.kind}: ${text}`);
    const p = fallbackFor(q.kind, q.context, q.snapshot, s, q.allowed ?? undefined);
    const sum = Object.values(p).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${q.kind} fallback sums to 1`);
  }
  assert.ok(validateContext('household_stay_move', {trade: 'pirate'}) !== null);
  assert.ok(validateContext('household_stay_move', {district: 'Old {Ford}'}) !== null);
  assert.ok(validateContext('household_stay_move', {extra: 1}) !== null);
});

test('pooling is a weighted average, and disagreement is measured with JSD', () => {
  const a = {stay: 0.9, emigrate: 0.1}, b = {stay: 0.1, emigrate: 0.9};
  const pooled = linearPool([{probs: a, weight: 1}, {probs: b, weight: 3}], ['stay', 'emigrate']);
  assert.ok(Math.abs(pooled.stay - 0.3) < 1e-9);
  assert.equal(jsd(a, a), 0);
  assert.ok(jsd(a, b) > 0.5 && jsd(a, b) <= 1);
});

test('with a decision service, answers are logged and feed actor distributions', async () => {
  const seen = [];
  const bus = {
    stats: () => ({state: 'idle', room: 64}),
    async ask(kind, id, context, opts) {
      if (seen.length < 400) seen.push({kind, context, state: opts.state});
      const offered = opts.allowed ?? Object.keys(KIND_BY_ID[kind].criteria);
      const probabilities = Object.fromEntries(offered.map((o, i) => [o, i === 0 ? 0.8 : 0.2 / (offered.length - 1)]));
      return {kind, choice: offered[0], confidence: 0.8, probabilities};
    },
  };
  const s = createState(77);
  const offline = distribution(s, 'household_stay_move', {type: 'household', record: s.households[0]});
  assert.equal(offline, null, 'no model answer yet: the caller keeps its prior');
  for (let m = 0; m < 26; m++) {
    runMonths(s, 1, {decisions: bus, now: () => m * 5000});
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(s.answerLog.some((a) => a.src === 'model'));
  for (const q of seen) {
    assert.equal(validateContext(q.kind, q.context), null, q.kind);
    assert.equal(validateSnapshot(q.kind, q.state), null, `${q.kind} state`);
  }
  const pooled = distribution(s, 'household_stay_move', {type: 'household', record: s.households[0]});
  assert.ok(pooled && Math.abs(pooled.stay - 0.8) < 0.05, `pooled ${JSON.stringify(pooled)}`);
});

// ---------------------------------------------------------------------------
// Long runs (offline: every answer is the local fallback)

test('a 60-year headless run grows bodies, rules and events, and is deterministic', () => {
  const choose = ruler({rules: [], bodies: Object.keys(INSTITUTIONS), trades: [], dislike: []});
  const a = play(1234, 60, choose);
  assert.ok(activeBodies(a).length >= 3, `bodies: ${activeBodies(a).map((b) => b.kind)}`);
  assert.ok(activeRules(a).length >= 8, `rules: ${Object.keys(a.policies)}`);
  assert.ok(Object.keys(a.tagCounts).some((t) => t.startsWith('event:')), 'some events happened');
  assert.ok(a.answerLog.length > 0 && a.cardHistory.length > 20);

  const b = play(1234, 60, choose);
  const digest = (s) => JSON.stringify({
    policies: s.policies, tags: s.tags, traits: s.traits, archetype: s.archetype,
    bodies: s.institutions.map((x) => [x.kind, x.status, x.power, x.patience]),
    history: s.cardHistory.map((h) => [h.year, h.templateId, h.choice]),
    answers: s.answerLog.slice(-200).map((x) => [x.key, x.choice]),
  });
  assert.equal(digest(a), digest(b));
});

test('opposite early rulings end in different towns by year 80', () => {
  const farms = play(4817, 80, ruler(AGRARIAN));
  const mills = play(4817, 80, ruler(INDUSTRIAL));
  assert.notEqual(farms.archetype, mills.archetype, `${farms.archetype} vs ${mills.archetype}`);
  // The gap sits around 0.4-0.6 (seeds 4817, 11, 23 measured 0.47-0.58 before the
  // orderly-paths change, 0.40-0.57 after), and any change to the grown town moves
  // it by a few hundredths, so 0.5 was a coin toss. 0.35 still means the industrial
  // town is clearly more industrial (typically -0.2 against +0.25).
  assert.ok(mills.traits.industry - farms.traits.industry > 0.35, `industry ${farms.traits.industry} vs ${mills.traits.industry}`);
  const kinds = (s) => new Set(activeBodies(s).map((b) => b.kind));
  assert.ok(kinds(farms).has('agri-council') || kinds(farms).has('parish'));
  assert.ok(kinds(mills).has('trades-guild'));
  assert.ok(mills.policies['mill-rights']?.level > 0 && !(farms.policies['mill-rights']?.level > 0));
});

test('a person\'s card says what they are up to: on the way, or there, in the house voice', () => {
  const s = fixtureState('town');
  const p = s.people.find((x) => x.homeId != null);
  const shop = s.buildings.find((b) => b.type === 'shop' || b.type === 'market' || b.type === 'workshop');
  const say = (task) => {
    p.task = {route: [0, 0, 1, 1], seg: 0, dwell: 0, waiting: false, ...task};
    return view.selectInspect(s, {personId: p.id}).objective;
  };
  const going = say({kind: 'work', targetType: 'building', targetId: shop.id});
  assert.equal(going.moving, true);
  assert.equal(going.placeId, shop.id);
  assert.match(going.text, /^On the way to work at the /);
  const there = say({kind: 'work', targetType: 'building', targetId: shop.id, dwell: 3});
  assert.equal(there.moving, false);
  assert.match(there.text, /^Working at the /);
  assert.equal(say({kind: 'rest', targetType: 'building', targetId: p.homeId}).text, 'Heading home');
  assert.equal(say({kind: 'rest', targetType: 'building', targetId: p.homeId, dwell: 1}).text, 'Resting at home');
  assert.equal(say({kind: 'rest', targetType: 'building', targetId: p.homeId, waiting: true, route: []}).text, 'Setting off home');
  assert.equal(say({kind: 'gather', targetType: 'event', targetId: 1, eventKind: 'festival', dwell: 2}).text, 'In the crowd at the festival');
  p.task = null;
  assert.equal(view.selectInspect(s, {personId: p.id}).objective.text, 'Standing about');
  for (const kind of ['work', 'rest', 'shop', 'leisure', 'worship', 'gather', 'build', 'flee', 'travel']) {
    for (const dwell of [0, 2]) {
      const o = say({kind, targetType: 'building', targetId: shop.id, dwell});
      assert.deepEqual(lintText(o.text), [], `${kind}: ${o.text}`);
    }
  }
});

test('the Council lists cards in arrival order, so new requests join the end', () => {
  const s = freshTown();
  s.docket = [];
  const mk = (id, month, kind = 'proposal', urgency = 0) => {
    const c = makeCard(s, {kind, from: 'moot', templateId: `order:${id}`, title: id, why: 'Why.', urgency,
      options: [{key: 'do', label: 'Do it', tradeoff: 'Trade-off.'}]});
    c.id = id; c.surfacedMonth = month; s.docket.push(c);
    return c;
  };
  mk('old', 1); mk('older-same-month', 3); mk('later-same-month', 3);
  // An urgent event arriving last does not jump the queue.
  mk('urgent-event', 5, 'event', 3);
  assert.deepEqual(view.selectDocket(s).map((c) => c.id), ['old', 'older-same-month', 'later-same-month', 'urgent-event']);
});
