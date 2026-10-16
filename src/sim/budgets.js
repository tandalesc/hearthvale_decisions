// Budgets (docs/design/governance-budgets-advisors.md §3). From Borough with
// five or more sitting bodies (or at City), every body that has sat two years
// brings a budget card in the year's last session (month 9). You approve it,
// trim it, keep last year's figure or refuse it, and may strike plan lines
// first. The grant is paid at the year's turn; through the year the body pays
// its running costs monthly and funds its own approved plans and small things
// (under 15% of its grant) without asking. Rules, demolitions and what the
// town dislikes still come to you. An unanswered budget lapses to last year's
// figure. Unspent coin above a quarter of the grant goes back to the treasury.
//
// body.budget = {mode: 'share'|'annual', year, asked, granted, choice,
//   lines: [{id, kind: 'running'|'plan'|'reserve', label, cost, templateId?, workId?, need?, started?}],
//   spent: {running, plans, other}, history: [{y, asked, granted, spent, returned, choice}] (cap 30),
//   topUpYear, next: {year, asked, granted, lines, choice} | null}
// state.governance.budgets = {season: {year, openedMonth, cardIds} | null, seasons, unlockedYear}
//
// Every coin moves through pay / payBuilders with its own reason:
//   budget-grant (treasury -> body), budget-return (body -> treasury),
//   budget-topup (treasury -> body), body-running (body -> builders).
// No random numbers: a season opens, drafts and settles the same way every time.

import {monthIndex} from './clock.js';
import {pay, payBuilders, purseBase} from './economy.js';
import {delta} from './pressures.js';
import {costScale, fiscalBase} from './policies.js';
import {coin} from './text/voice.js';
import {addChronicle} from './chronicle.js';
import {factionGroup, nudgeMood} from './factions.js';
import {opinionOf} from './opinion.js';
import {INSTITUTIONS, TEMPLATES, METRICS, eligibleTemplates, notePatience, bodyOf} from './institutions.js';
import {makeCard, addCard, settleOpenFromBudget} from './docket.js';
import {localStances} from './decisions/scheduler.js';
import {adviseCard, planBoost} from './advisors.js';

export const BUDGET_ERA = 3;
export const BUDGET_MIN_BODIES = 5;
export const SEASON_MONTH = 9;
export const SAT_YEARS = 2;
export const SMALL_SHARE = 0.15;      // a "small thing" a body pays for unasked: under this share of its grant
export const RESERVE_SHARE = 0.1;
export const KEEP_SHARE = 0.25;       // kept at year end; the rest goes back to the treasury
export const BODY_CAP = 0.2;          // of the fiscal base, per body (the design said 12%: too small for any plan)
export const WARD_CAP = 0.12;
export const PLAN_NEED = 0.4;
export const MAX_PLANS = 3;
export const UNDERSPEND = 0.6;
export const RUNNING_BASE = 40;       // era-0 coin, scaled by costScale (about the old purse per body)
export const HISTORY_CAP = 30;
export const TRIMS = {trim90: 0.9, trim75: 0.75, trim50: 0.5};
export const BUDGET_CHOICES = ['approve', 'trim90', 'trim75', 'trim50', 'same', 'refuse'];
// Plans that pull down homes or change land use always ask you first.
export const ASK_FIRST = new Set(['slum-clearance', 'redevelop-centre', 'grid', 'ring-road', 'widen']);

const emptyBudget = () => ({
  mode: 'share', year: null, asked: 0, granted: 0, choice: null, lines: [],
  spent: {running: 0, plans: 0, other: 0}, history: [], topUpYear: null, next: null,
});

// Fill budget fields on a fresh or restored state (idempotent).
export function initBudgets(state) {
  const g = state.governance;
  g.budgets ??= {season: null, seasons: 0, unlockedYear: null};
  g.budgets.season ??= null;
  g.budgets.seasons ??= 0;
  g.budgets.unlockedYear ??= null;
  for (const b of state.institutions ?? []) {
    if (b.kind === 'moot') continue;
    b.budget ??= emptyBudget();
    for (const [k, v] of Object.entries(emptyBudget())) b.budget[k] ??= v;
  }
}

const sitting = (state) => (state.institutions ?? []).filter((b) => b.kind !== 'moot' && b.status === 'active');

// The town is ready for budgets: Borough with five sitting bodies, or City.
export function budgetsReady(state) {
  const era = state.era ?? 0;
  return (era >= BUDGET_ERA && sitting(state).length >= BUDGET_MIN_BODIES) || era >= BUDGET_ERA + 1;
}

export const budgetsUnlocked = (state) => state.governance?.budgets?.unlockedYear != null;

// A body brings a budget once it has sat two years (the Moot is the treasury).
export const budgeting = (state, body) => body.kind !== 'moot' && body.status === 'active' && state.time.year - (body.foundedYear ?? 0) >= SAT_YEARS;
export const isAnnual = (body) => body?.budget?.mode === 'annual';
const activeBudget = (state, body) => isAnnual(body) && body.budget.year === state.time.year;

const r = (x) => Math.round(x);
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// What the purse paid last year, for a body's first budget.
function purseIncome(state, body) {
  return r((body.budgetShare ?? 0) * purseBase(state.economy?.lastYear ?? {}));
}

// ---------------------------------------------------------------------------
// The season
// ---------------------------------------------------------------------------

// Monthly, from governance month(): running costs, and the season at month 9.
export function budgetsMonthly(state) {
  initBudgets(state);
  payRunning(state);
  const g = state.governance.budgets;
  const year = state.time.year + 1;
  if (state.time.month === SEASON_MONTH && !state.governance.receivership && budgetsReady(state) && g.season?.year !== year) openSeason(state);
}

// Running costs (clerks, tools, small repairs), a twelfth a month, to the builders.
function payRunning(state) {
  for (const body of state.institutions) {
    if (!activeBudget(state, body) || body.status === 'dissolved') continue;
    const line = body.budget.lines.find((l) => l.kind === 'running');
    if (!line?.cost) continue;
    const paid = payBuilders(state, `body:${body.id}`, line.cost / 12, 'body-running');
    body.budget.spent.running += paid;
  }
}

// Every budgeting body brings its card for next year. Returns the cards.
export function openSeason(state) {
  initBudgets(state);
  const g = state.governance.budgets;
  const year = state.time.year + 1;
  const cards = [];
  for (const body of state.institutions) {
    if (!budgeting(state, body)) continue;
    const card = addCard(state, budgetCard(state, body, year));
    if (!card) continue;
    card.expiresMonth = year * 12;   // the year's turn: unanswered, it keeps last year's figure
    cards.push(card);
  }
  if (!cards.length) return cards;
  // The area advisers answer the season once it is all on the table.
  for (const card of cards) adviseCard(state, card);
  g.unlockedYear ??= state.time.year;
  g.season = {year, openedMonth: monthIndex(state.time), cardIds: cards.map((c) => c.id)};
  addChronicle(state, `Budget season: ${cards.length === 1 ? 'one body brings its budget' : `${cards.length} bodies bring their budgets`} for year ${year}.`, 'line', {budgetSeason: year});
  return cards;
}

// The town's room this season: last year's income less what it must pay.
export function seasonRoom(state) {
  const ly = state.economy?.lastYear ?? {};
  return Math.max(0, r((ly.treasuryIncome ?? 0) - (ly.policies ?? 0) - (ly.publicServices ?? 0) - (ly.loanService ?? 0)));
}

// ---------------------------------------------------------------------------
// Drafting a budget
// ---------------------------------------------------------------------------

function planCost(state, t, work) {
  return r(work?.cost ?? (t.costFn ? t.costFn(state) : (t.cost ?? 0) * costScale(state)));
}

export function draftBudget(state, body, year = state.time.year + 1) {
  const last = body.budget ?? emptyBudget();
  const first = !isAnnual(body);
  const lastGranted = first ? purseIncome(state, body) : last.granted;
  const lastSpent = (last.spent?.running ?? 0) + (last.spent?.plans ?? 0) + (last.spent?.other ?? 0);
  // A body that spent under 60% of last year's grant asks 15% less to run.
  const lean = !first && last.granted > 0 && lastSpent < UNDERSPEND * last.granted ? 0.85 : 1;
  const cap = (body.kind === 'ward' ? WARD_CAP : BODY_CAP) * fiscalBase(state);
  const running = Math.max(1, r(RUNNING_BASE * costScale(state) * (0.8 + 0.4 * (body.power ?? 0.4)) * lean));
  const lines = [{id: 'running', kind: 'running', label: 'Clerks, tools and small repairs', cost: running}];
  // Its keenest affordable plans (the need already counts how full the chest
  // is), its own plans already waiting for you among them: approving the
  // budget approves those too.
  const choices = eligibleTemplates(state, body, {cachedOnly: true});
  const waiting = state.docket.filter((c) => c.from === body.id && c.kind === 'proposal' && !c.data?.batch && !c.data?.policy && !c.data?.topUp && TEMPLATES[c.templateId])
    .map((c) => ({template: c.templateId, need: c.data?.need ?? PLAN_NEED, title: c.title, workId: c.data?.workId ?? null, cost: c.cost, waiting: true}));
  let total = running;
  for (const c of [...waiting, ...choices]) {
    if (lines.length - 1 >= MAX_PLANS || c.policy) continue;
    const t = TEMPLATES[c.template];
    if (!t || !((t.cost ?? 0) > 0 || t.work || t.costFn)) continue;
    const work = c.workId ? {id: c.workId, cost: c.work?.cost} : null;
    const cost = c.waiting ? Math.round(c.cost ?? 0) : planCost(state, t, c.work ?? work);
    if (lines.some((l) => l.templateId === c.template && (l.workId ?? null) === (c.workId ?? null))) continue;
    if (!(cost > 0) || (total + cost) * (1 + RESERVE_SHARE) > cap) continue;
    // The area's adviser lifts the plans it would back (advisors.planBoost).
    if (c.need + planBoost(state, body, cost) < PLAN_NEED) continue;
    lines.push({id: `plan:${c.template}${c.workId ? `@${c.workId}` : ''}`, kind: 'plan', label: c.title ?? t.title, cost,
      templateId: c.template, ...(c.workId ? {workId: c.workId} : {}), need: Math.round(c.need * 100) / 100, ...(c.waiting ? {waiting: true} : {}),
      ...(ASK_FIRST.has(c.template) ? {askFirst: true} : {})});
    total += cost;
  }
  lines.push({id: 'reserve', kind: 'reserve', label: 'Reserve for small things', cost: Math.max(1, r(RESERVE_SHARE * total * lean))});
  const asked = lines.reduce((n, l) => n + l.cost, 0);
  // What its dashboard did over the year (quarterly samples: four back).
  const outcomes = (INSTITUTIONS[body.kind]?.metrics ?? []).slice(0, 3).map((mid) => {
    const s = body.metrics?.[mid] ?? [];
    return s.length >= 2 ? {metric: mid, label: METRICS[mid]?.label ?? mid, unit: METRICS[mid]?.unit ?? '', from: s[Math.max(0, s.length - 5)], to: s.at(-1)} : null;
  }).filter(Boolean);
  const done = (state.cardHistory ?? []).filter((h) => h.from === body.id && h.outcome === 'budget' && h.year === state.time.year).map((h) => h.title).slice(0, 3);
  const rules = choices.filter((c) => c.policy && c.need >= 0.3).slice(0, 2).map((c) => ({policy: c.policy, title: c.title}));
  return {
    year, lines, asked,
    last: {granted: lastGranted, spent: r(lastSpent), returned: r(last.history?.at(-1)?.returned ?? 0), first},
    outcomes, done, rules,
  };
}

const CHOICE_LABEL = {approve: 'Approve', trim90: 'Trim to 90%', trim75: 'Trim to 75%', trim50: 'Trim to half', same: 'Same as last year', refuse: 'Refuse'};

export function budgetCard(state, body, year) {
  const b = draftBudget(state, body, year);
  const name = body.name;
  return makeCard(state, {
    kind: 'budget', from: body.id, templateId: 'budget', category: 'budget',
    title: `${name}: budget for year ${year}`,
    why: `The ${name} asks ${coin(b.asked)} for next year${b.last.granted ? `; last year it had ${coin(b.last.granted)}` : ''}.`,
    asker: body.asker, urgency: 1, cost: 0, helps: [], hurts: [],
    subjects: [`budget:${body.id}:${year}`],
    data: {budget: b},
    options: BUDGET_CHOICES.map((key) => ({key, label: CHOICE_LABEL[key], tradeoff: '', cost: 0, effects: []})),
  });
}

// The card's ask as it stands (struck lines left out).
export const askOf = (b) => b.lines.reduce((n, l) => n + (l.struck ? 0 : l.cost), 0);

// The grant and the lines a choice gives. Trims (and "same") drop plan lines,
// least needed first, until the rest fits; then running and reserve shrink.
export function grantFor(b, choice, factor = null) {
  const asked = askOf(b);
  const kept = b.lines.filter((l) => !l.struck);
  if (choice === 'approve') return {granted: asked, lines: kept.map((l) => ({...l}))};
  if (choice === 'refuse') return {granted: 0, lines: []};
  const target = choice === 'same' ? b.last.granted : r(asked * (factor ?? TRIMS[choice] ?? 1));
  return fitLines(kept, Math.max(0, target));
}

function fitLines(kept, target) {
  let lines = kept.map((l) => ({...l}));
  const sum = () => lines.reduce((n, l) => n + l.cost, 0);
  const plans = lines.filter((l) => l.kind === 'plan').sort((a, b) => (a.need ?? 0) - (b.need ?? 0) || (a.id < b.id ? -1 : 1));
  for (const p of plans) {
    if (sum() <= target) break;
    lines = lines.filter((l) => l !== p);
  }
  const fixed = lines.filter((l) => l.kind !== 'plan');
  const planSum = lines.filter((l) => l.kind === 'plan').reduce((n, l) => n + l.cost, 0);
  const fixedSum = fixed.reduce((n, l) => n + l.cost, 0);
  const room = target - planSum;
  if (fixedSum > 0) {
    // Running and reserve take what is left (more reserve when it is more than they asked).
    const k = Math.max(0, room) / fixedSum;
    for (const l of fixed) l.cost = r(l.cost * k);
  }
  return {granted: Math.max(0, target), lines: lines.filter((l) => l.kind === 'plan' || l.cost > 0)};
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

// Strike (or restore) a plan line before answering.
export function strikeBudgetLine(state, cardId, lineId, struck = true) {
  const card = state.docket.find((c) => c.id === cardId && c.kind === 'budget');
  const line = card?.data?.budget?.lines.find((l) => l.id === lineId);
  if (!line) return {ok: false, reason: 'no-card'};
  if (line.kind !== 'plan') return {ok: false, reason: 'no-option'};
  line.struck = !!struck;
  return {ok: true, asked: askOf(card.data.budget)};
}

// Settle a budget card (docket.settle calls this). Returns the outcome.
// opts: {factor} for a trim to fit, {lapsed} when it ran out unanswered.
export function settleBudget(state, card, choice, {factor = null, lapsed = false, record} = {}) {
  const body = bodyOf(state, card.from);
  const b = card.data.budget;
  if (!body) return 'expired';
  initBudgets(state);
  const asked = askOf(b);
  const pick = lapsed ? 'same' : choice;
  const {granted, lines} = grantFor(b, pick, factor);
  body.budget.next = {year: b.year, asked, granted, lines, choice: lapsed ? 'lapsed' : choice};
  // Struck plans wait like a "Not now" (the usual three-year cooldown).
  const struck = lapsed ? [] : b.lines.filter((l) => l.struck && l.kind === 'plan');
  for (const l of struck) {
    record?.({id: `${card.id}:${l.id}`, from: body.id, kind: 'proposal', templateId: l.templateId, title: l.label, category: card.category,
      data: l.workId ? {workId: l.workId} : {}, options: [], subjects: []}, 'not_now', 'deferred');
  }
  if (!lapsed) standing(state, body, pick, factor, asked, struck.length);
  const words = {approve: 'approved', trim90: 'trimmed', trim75: 'trimmed', trim50: 'cut', same: 'kept at last year\'s figure', refuse: 'refused'};
  const what = lapsed ? 'kept at last year\'s figure' : factor != null ? 'trimmed to fit' : words[choice] ?? 'answered';
  addChronicle(state, `The ${body.name}'s budget for year ${b.year}: ${what}, ${coin(granted)}.`, lapsed ? 'line' : 'decision', {card: card.id, budget: body.id, ...(lapsed ? {lapsed: true} : {})});
  return lapsed ? 'expired' : choice === 'refuse' ? 'refused' : 'accepted';
}

// Patience and mood from an answer (design §3.4).
function standing(state, body, choice, factor, asked, struck) {
  const faction = INSTITUTIONS[body.kind]?.faction;
  const mood = (amount) => { for (const f of factionGroup(state, faction)) nudgeMood(f, Math.max(0, Math.min(1, f.mood + amount)), 'rulings'); };
  const share = factor ?? TRIMS[choice];
  if (choice === 'approve') { notePatience(state, body.id, 0.05); mood(0.02); }
  else if (share != null) {
    if (share < 0.6) { notePatience(state, body.id, -0.12); mood(-0.03); }
    else if (share < 0.85) { notePatience(state, body.id, -0.05); mood(-0.01); }
  } else if (choice === 'same') notePatience(state, body.id, asked > (body.budget.next?.granted ?? 0) ? -0.03 : 0.02);
  else if (choice === 'refuse') {
    body.refused = (body.refused ?? 0) + 1;
    notePatience(state, body.id, -0.2);
    mood(-0.05);
    delta(state, 'unrest', 0.01, `budget-refused:${body.id}`);
  }
  if (struck) notePatience(state, body.id, -0.02 * struck);
}

const openBudgetCards = (state) => state.docket.filter((c) => c.kind === 'budget');

// "Approve the rest as asked."
export function approveAllBudgets(state, rule) {
  let n = 0;
  for (const c of openBudgetCards(state)) if (rule(state, c.id, 'approve')?.ok) n++;
  return {ok: true, answered: n};
}

// "Trim all to fit": every unanswered budget scaled alike to the season's room.
export function trimAllToFit(state, settleWith) {
  const cards = openBudgetCards(state);
  const asked = cards.reduce((n, c) => n + askOf(c.data.budget), 0);
  const room = Math.max(0, seasonRoom(state) - grantedThisSeason(state));
  const factor = asked > room && asked > 0 ? room / asked : 1;
  for (const c of cards) settleWith(c, factor < 1 ? 'trim' : 'approve', factor < 1 ? {factor} : {});
  return {ok: true, answered: cards.length, factor: Math.round(factor * 1000) / 1000};
}

// What this season's answered budgets already took.
export function grantedThisSeason(state) {
  const year = state.governance?.budgets?.season?.year;
  return (state.institutions ?? []).reduce((n, b) => n + (b.budget?.next?.year === year && year != null ? b.budget.next.granted : 0), 0);
}

// ---------------------------------------------------------------------------
// The year's turn: close the old budgets, pay the new grants
// ---------------------------------------------------------------------------

export function budgetsYearly(state) {
  initBudgets(state);
  closeYear(state);
  payBudgets(state);
  // A season whose year has come is done (the advisers' unlock counts them).
  const g = state.governance.budgets;
  if (g.season && g.season.year === state.time.year && !g.season.done) {
    g.season.done = true;
    g.seasons++;
  }
}

function closeYear(state) {
  const y = state.time.year - 1;
  for (const body of state.institutions) {
    if (!isAnnual(body) || body.budget.year !== y) continue;
    const bud = body.budget;
    const keep = KEEP_SHARE * bud.granted;
    const extra = (body.funds ?? 0) - keep;
    const returned = extra > 0.5 ? pay(state, `body:${body.id}`, 'treasury', extra, 'budget-return') : 0;
    const spent = bud.spent.running + bud.spent.plans + bud.spent.other;
    bud.history.push({y, asked: r(bud.asked), granted: r(bud.granted), spent: r(spent), returned: r(returned), choice: bud.choice});
    if (bud.history.length > HISTORY_CAP) bud.history.splice(0, bud.history.length - HISTORY_CAP);
  }
}

function payBudgets(state) {
  const year = state.time.year;
  const steward = !!state.governance.receivership;
  const due = [];
  for (const body of state.institutions) {
    if (body.kind === 'moot' || body.status !== 'active') continue;
    const next = body.budget.next?.year === year ? body.budget.next : null;
    // An annual body with no answer this year (receivership, or no season):
    // the steward pays half of last year's grant; otherwise last year's figure.
    if (!next && !isAnnual(body)) continue;
    const plan = next ?? {year, asked: body.budget.granted, granted: body.budget.granted, lines: keepRunning(body.budget.lines), choice: 'kept'};
    const granted = steward ? Math.min(plan.granted, 0.5 * (isAnnual(body) ? body.budget.granted : plan.granted)) : plan.granted;
    due.push({body, plan, granted});
  }
  if (!due.length) return;
  const total = due.reduce((n, d) => n + d.granted, 0);
  // Grants are capped by the chest, scaled alike; the steward pays his halves regardless.
  const scale = !steward && total > Math.max(0, state.treasury) ? Math.max(0, state.treasury) / total : 1;
  if (scale < 1) addChronicle(state, `The chest could not pay every budget in full. Each body gets ${Math.round(scale * 100)} in 100 of its grant.`, 'line', {budgetShort: year});
  for (const {body, plan, granted} of due) {
    const paid = pay(state, 'treasury', `body:${body.id}`, granted * scale, 'budget-grant');
    const k = plan.granted > 0 ? paid / plan.granted : 0;
    Object.assign(body.budget, {
      mode: 'annual', year, asked: plan.asked, granted: r(paid), choice: plan.choice,
      lines: plan.lines.map((l) => (l.kind === 'plan' ? {...l} : {...l, cost: r(l.cost * Math.min(1, k))})),
      spent: {running: 0, plans: 0, other: 0}, topUpYear: null, next: null,
    });
    // Its plans already waiting as requests go ahead now, from the grant.
    settleOpenFromBudget(state, body);
  }
}

const keepRunning = (lines = []) => lines.filter((l) => l.kind !== 'plan').map((l) => ({...l}));

// A {budget: x} card effect on an annual body: x × the fiscal base, paid now.
export function raiseGrant(state, body, share) {
  const paid = pay(state, 'treasury', `body:${body.id}`, share * fiscalBase(state), 'budget-grant');
  body.budget.granted = r(body.budget.granted + paid);
  return paid;
}

// ---------------------------------------------------------------------------
// Working within the budget (docket.addCard asks this)
// ---------------------------------------------------------------------------

const MINOR = new Set(['not_now', 'refuse', 'negotiate', 'neither']);

// Whether a body may settle this card from its own budget, and how:
// {option, line} to pay for it now, {topUp, line} when its plan is short of coin, or null.
export function budgetCovers(state, body, card) {
  if (!body || !activeBudget(state, body) || body.status !== 'active') return null;
  if (card.kind !== 'proposal' || card.data?.escalated || card.data?.policy || card.data?.forms || card.data?.topUp) return null;
  if (String(card.templateId ?? '').startsWith('topup:') || ASK_FIRST.has(card.templateId)) return null;
  const choices = card.options.filter((o) => !MINOR.has(o.key) && !(o.effects ?? []).some((e) => e.policy || e.form || e.refuseBody));
  if (!choices.length) return null;
  const bud = body.budget;
  const planFor = (tid, workId) => bud.lines.find((l) => l.kind === 'plan' && !l.started && l.templateId === tid && (!l.workId || l.workId === workId));
  // A "Which first?" card: the option whose plan is in the budget.
  let option = null, line = null;
  for (const o of choices) {
    const tid = card.data?.batch ? o.sub : card.templateId;
    const l = planFor(tid, card.data?.batch ? card.data.batch.find((x) => x.templateId === tid)?.data?.workId : card.data?.workId);
    if (l) { option = o; line = l; break; }
  }
  if (!option) {
    if (card.data?.batch) return null;
    option = choices[0];
    if (!((option.cost ?? 0) <= SMALL_SHARE * bud.granted)) return null;
  }
  // Not what the town dislikes, nor what splits it.
  const op = opinionOf(state, localStances(state, card));
  if (op.verdict === 'unpopular' || op.controversy >= 0.5) return null;
  if ((option.cost ?? 0) > (body.funds ?? 0)) {
    if (line && bud.topUpYear !== state.time.year) return {topUp: Math.ceil((option.cost ?? 0) - (body.funds ?? 0)), line, option};
    return null;
  }
  return {option, line};
}

// The body has spent its purse and a plan in its budget comes up: one top-up a year.
export function topUpCard(state, body, card, cover) {
  body.budget.topUpYear = state.time.year;
  const amount = cover.topUp;
  const what = lowerFirst(planTitle(card, cover.option));
  return makeCard(state, {
    kind: 'proposal', from: body.id, templateId: `topup:${card.templateId}`, category: card.category,
    title: `The ${body.name} has spent its purse`,
    why: `It needs ${coin(amount)} more for a plan in its budget: ${what}.`,
    asker: body.asker, urgency: 1, cost: amount, helps: card.helps, hurts: card.hurts,
    subjects: card.subjects,
    data: {topUp: {body: body.id, amount, lineId: cover.line?.id ?? null}, plan: {...card, data: {...card.data}}},
    options: [{key: 'grant', label: `Grant ${coin(amount)} more`, tradeoff: `From the chest. The ${body.name} goes ahead with ${what}.`, cost: amount, effects: [{topUp: true}]}],
  });
}

// A plain name for what a card asks: a "Which first?" card by the plan chosen.
export function planTitle(card, option) {
  if (card.data?.batch && option?.sub) return card.data.batch.find((x) => x.templateId === option.sub)?.title ?? option.label ?? card.title;
  return card.title;
}

// After a body paid for something from its budget: the books and the line.
export function noteBudgetSpend(state, body, line, cost) {
  const bud = body.budget;
  if (line) {
    const l = bud.lines.find((x) => x.id === line.id);
    if (l) l.started = true;
    bud.spent.plans += cost;
  } else bud.spent.other += cost;
}
