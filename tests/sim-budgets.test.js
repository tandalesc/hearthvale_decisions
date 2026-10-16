// Budgets (src/sim/budgets.js, design §3): the season at month 9 from Borough
// with five sitting bodies, the answers, working within the budget, the
// year's turn, lapses, trims to fit, receivership and old saves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {stepTick, fixtureState, serialize, restore, rule, strikeBudgetLine, trimAllToFit, approveAllBudgets} from '../src/sim/index.js';
import {totalMoney, externalNet} from '../src/sim/economy.js';
import {addCard, makeCard} from '../src/sim/docket.js';
import {
  initBudgets, budgetsReady, openSeason, seasonRoom, askOf, grantFor, budgetCovers, SMALL_SHARE, KEEP_SHARE, SEASON_MONTH,
} from '../src/sim/budgets.js';
import {selectBudgetSeason, selectDocket, selectUnlocks, selectBodies} from '../src/sim/view.js';

const conserved = (s) => totalMoney(s) - externalNet(s);
const step = (s) => stepTick(s, 4, {}, {skipPeople: true});
const until = (s, f, limit = 20000) => { for (let i = 0; i < limit && !f(); i++) step(s); assert.ok(f(), 'condition reached'); };
const budgetCards = (s) => s.docket.filter((c) => c.kind === 'budget');
// The city fixture (era 4), run on to its first budget season.
function season() {
  const s = fixtureState('city');
  until(s, () => s.time.month === SEASON_MONTH && budgetCards(s).length > 0);
  return s;
}
const turn = (s) => { const y = s.time.year; until(s, () => s.time.year === y + 1 && s.time.month === 1); };

test('an old save gains budget fields on restore; the season opens at month 9 with a card per sitting body', () => {
  const s = fixtureState('city');
  // The cached fixture predates budgets: every body now has one, in share mode.
  for (const b of s.institutions.filter((x) => x.kind !== 'moot')) assert.equal(b.budget.mode, 'share');
  assert.deepEqual(Object.keys(s.governance.budgets).sort(), ['season', 'seasons', 'unlockedYear']);
  assert.equal(selectUnlocks(s).budgets, false);
  assert.ok(budgetsReady(s));
  until(s, () => s.time.month === SEASON_MONTH && budgetCards(s).length > 0);
  const sitting = s.institutions.filter((b) => b.kind !== 'moot' && b.status === 'active' && s.time.year - b.foundedYear >= 2);
  assert.equal(budgetCards(s).length, sitting.length);
  for (const c of budgetCards(s)) {
    assert.ok(c.surfacedMonth != null, 'surfaces at once');
    assert.equal(c.expiresMonth, (s.time.year + 1) * 12, 'until the year turns');
    const b = c.data.budget;
    assert.equal(b.year, s.time.year + 1);
    assert.ok(b.lines.some((l) => l.kind === 'running') && b.lines.some((l) => l.kind === 'reserve'));
    assert.equal(b.asked, askOf(b));
    assert.ok(b.asked <= 0.12 * 1.0001 * (s.economy.lastYear.treasuryIncome ?? 0) + 2 || b.asked <= 0.12 * 3000 * 50);
    assert.ok(b.last.granted >= 0);
  }
  assert.equal(selectUnlocks(s).budgets, true);
  assert.equal(selectUnlocks(s).budgetSeason, true);
  // Budget cards never take a session's place, and the Town Council's list keeps them apart by kind.
  assert.ok(selectDocket(s).filter((c) => c.kind === 'budget').every((c) => c.budget && c.budget.grants.approve === c.budget.asked));
  const v = selectBudgetSeason(s);
  assert.equal(v.open, budgetCards(s).length);
  assert.equal(v.room, seasonRoom(s));
  assert.ok(s.chronicle.entries.some((e) => e.refs?.budgetSeason === s.time.year + 1));
});

test('not before Borough with five sitting bodies', () => {
  const s = fixtureState('city');
  s.era = 2;
  assert.equal(budgetsReady(s), false);
  s.era = 3;
  const live = s.institutions.filter((b) => b.kind !== 'moot' && b.status === 'active');
  for (const b of live.slice(4)) b.status = 'waning';
  assert.equal(budgetsReady(s), false, 'four bodies at Borough');
  live[4].status = 'active';
  assert.equal(budgetsReady(s), true, 'five');
});

test('answers: approve, trims, same as last year and refuse grant what they say; struck plans wait; money is conserved', () => {
  const s = season();
  const start = conserved(s);
  const cards = budgetCards(s);
  // A plan line to strike, on the first card.
  const first = cards[0];
  first.data.budget.lines.splice(1, 0, {id: 'plan:seed-exchange', kind: 'plan', label: 'A seed exchange', cost: 300, templateId: 'seed-exchange', need: 0.6});
  const patience = s.institutions.find((b) => b.id === first.from).patience;
  assert.equal(strikeBudgetLine(s, first.id, 'plan:seed-exchange', true).ok, true);
  assert.equal(strikeBudgetLine(s, first.id, 'running', true).ok, false, 'only plan lines can be struck');
  const choices = ['approve', 'trim90', 'trim75', 'trim50', 'same', 'refuse'];
  const want = {};
  cards.forEach((c, i) => {
    const choice = choices[i % choices.length];
    want[c.from] = {choice, granted: grantFor(c.data.budget, choice).granted};
    assert.equal(rule(s, c.id, choice).ok, true);
  });
  assert.equal(budgetCards(s).length, 0);
  const firstBody = s.institutions.find((b) => b.id === first.from);
  assert.ok(firstBody.patience <= patience + 0.05 - 0.02 + 1e-9, 'a struck line costs patience');
  const struck = s.cardHistory.findLast((h) => h.templateId === 'seed-exchange' && h.from === first.from);
  assert.equal(struck?.choice, 'not_now', 'a struck plan waits like Not now');
  const answer = s.cardHistory.filter((h) => h.kind === 'budget').at(-1);
  assert.ok(Number.isFinite(answer.asked) && Number.isFinite(answer.granted));
  turn(s);
  for (const b of s.institutions.filter((x) => want[x.id])) {
    assert.equal(b.budget.mode, 'annual');
    assert.equal(b.budget.year, s.time.year);
    assert.equal(b.budget.choice, want[b.id].choice);
    assert.ok(Math.abs(b.budget.granted - want[b.id].granted) <= 1, `${b.id}: ${b.budget.granted} vs ${want[b.id].granted}`);
  }
  const refused = s.institutions.find((b) => want[b.id]?.choice === 'refuse');
  assert.equal(refused.budget.granted, 0);
  // The year's purse share is gone for budget bodies.
  for (const id of Object.keys(want)) assert.ok(!(s.economy.lastYear.bodies?.[id] > 0), `${id} got a purse as well`);
  assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.abs(start));
});

test('an unanswered budget keeps last year\'s figure; at year end the unspent rest goes back', () => {
  const s = season();
  const last = Object.fromEntries(budgetCards(s).map((c) => [c.from, c.data.budget.last.granted]));
  turn(s);
  for (const [id, granted] of Object.entries(last)) {
    const b = s.institutions.find((x) => x.id === id);
    assert.equal(b.budget.choice, 'lapsed');
    assert.ok(Math.abs(b.budget.granted - granted) <= 1);
  }
  assert.ok(s.cardHistory.some((h) => h.kind === 'budget' && h.outcome === 'expired'));
  // A year on, running costs were paid monthly and the rest above a quarter of the grant returned.
  const body = s.institutions.find((x) => last[x.id] > 0);
  const treasuryBefore = s.treasury;
  turn(s);
  const h = body.budget.history.at(-1);
  assert.equal(h.y, s.time.year - 1);
  assert.ok(h.spent > 0, 'it spent on its running line');
  assert.ok(body.funds <= KEEP_SHARE * h.granted + body.budget.granted + 1, 'kept at most a quarter, plus the new grant');
  assert.ok(Number.isFinite(treasuryBefore));
});

test('trim all to fit scales every ask alike to the season\'s room', () => {
  const s = season();
  const room = seasonRoom(s);
  const asked = budgetCards(s).reduce((n, c) => n + askOf(c.data.budget), 0);
  const r = trimAllToFit(s);
  assert.equal(r.ok, true);
  assert.equal(budgetCards(s).length, 0);
  const granted = s.institutions.reduce((n, b) => n + (b.budget?.next?.granted ?? 0), 0);
  if (asked > room) {
    assert.ok(Math.abs(granted - room) <= s.institutions.length, `granted ${granted}, room ${room}`);
    assert.ok(s.institutions.filter((b) => b.budget?.next).every((b) => b.budget.next.choice === 'trim'));
  } else assert.ok(Math.abs(granted - asked) <= 1);
  // "Approve the rest" with nothing left does nothing.
  assert.equal(approveAllBudgets(s).answered, 0);
});

test('working within the budget: a planned plan self-funds, rules and ask-first plans still come to you, a short purse asks for a top-up', () => {
  const s = season();
  turn(s);
  const body = s.institutions.find((b) => b.budget?.mode === 'annual' && b.kind !== 'ward' && b.budget.granted > 0);
  initBudgets(s);
  body.funds = 1000;
  body.budget.granted = 2000;
  body.budget.lines.push({id: 'plan:test', kind: 'plan', label: 'A test plan', cost: 600, templateId: 'tithe-barn'});
  const card = (tid, cost, extra = {}) => makeCard(s, {kind: 'proposal', from: body.id, templateId: tid, category: 'food', title: `Plan ${tid}`, why: '', cost,
    options: [{key: 'do', label: 'Do it', tradeoff: '', cost, effects: [{tag: `t:${tid}`}]}], ...extra});
  const before = conserved(s);
  assert.equal(addCard(s, card('tithe-barn', 600)), null, 'planned: no card');
  assert.ok(Math.abs(conserved(s) - before) < 1e-6 * Math.abs(before), 'paid from its purse, not made');
  assert.equal(body.budget.lines.at(-1).started, true);
  assert.ok(s.chronicle.entries.at(-1).text.startsWith(`The ${body.name} began:`));
  // Small things: under 15% of the grant.
  assert.equal(budgetCovers(s, body, card('quality-mark', Math.floor(SMALL_SHARE * 2000))) != null, true);
  assert.equal(budgetCovers(s, body, card('quality-mark', Math.ceil(SMALL_SHARE * 2000) + 1)), null);
  // Rule cards and ask-first plans always come to you.
  assert.equal(budgetCovers(s, body, card('adopt:wage-floor', 10, {data: {policy: 'wage-floor'}})), null);
  assert.equal(budgetCovers(s, body, card('slum-clearance', 10)), null);
  // A planned plan the purse cannot cover: one top-up card.
  body.budget.lines.push({id: 'plan:big', kind: 'plan', label: 'A big plan', cost: 5000, templateId: 'guild-hall'});
  const top = addCard(s, card('guild-hall', 5000));
  assert.ok(top && top.data.topUp, 'a top-up card');
  assert.equal(top.data.topUp.amount, Math.ceil(5000 - body.funds));
  const again = addCard(s, card('guild-hall', 5000, {subjects: ['other']}));
  assert.ok(again && !again.data.topUp, 'one top-up a year; the next plan just asks');
  s.docket.splice(s.docket.indexOf(again), 1);
  top.surfacedMonth ??= 0;
  const chest = s.treasury;
  assert.ok(chest >= top.data.topUp.amount);
  assert.equal(rule(s, top.id, 'grant').ok, true);
  assert.equal(body.budget.lines.find((l) => l.id === 'plan:big').started, true, 'granted, the plan goes ahead');
  assert.ok(Math.abs(chest - s.treasury - top.data.topUp.amount) < 1e-6, 'the top-up came from the chest');
});

test('receivership: no season; the steward pays each budget body half its last grant', () => {
  const s = season();
  trimAllToFit(s);
  turn(s);
  const grants = Object.fromEntries(s.institutions.filter((b) => b.budget?.mode === 'annual').map((b) => [b.id, b.budget.granted]));
  s.governance.receivership = {since: s.time.year};
  until(s, () => s.time.month === SEASON_MONTH + 1);
  assert.equal(budgetCards(s).length, 0, 'no season under the steward');
  // In debt, the steward stays through the year's turn.
  s.treasury = -1e6;
  turn(s);
  assert.ok(s.governance.receivership);
  for (const [id, g] of Object.entries(grants)) {
    const b = s.institutions.find((x) => x.id === id);
    if (b.status !== 'active') continue;
    assert.ok(Math.abs(b.budget.granted - 0.5 * g) <= 1, `${id}: ${b.budget.granted} of ${g}`);
  }
});

test('a save mid-season continues exactly like the original', () => {
  const s = season();
  const card = budgetCards(s)[0];
  rule(s, card.id, 'trim75');
  const r = restore(serialize(s));
  turn(s);
  turn(r);
  assert.equal(serialize(r), serialize(s));
  const v = selectBodies(r).find((b) => b.id === card.from);
  assert.equal(v.budget.choice, 'trim75');
});

test('opening a season again in the same year adds nothing twice', () => {
  const s = season();
  const n = budgetCards(s).length;
  openSeason(s);
  assert.equal(budgetCards(s).length, n);
});
