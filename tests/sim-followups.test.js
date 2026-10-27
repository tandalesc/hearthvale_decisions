// Ruling follow-ups, receipts, the rulings ledger and the age's look back (E2).
import test from 'node:test';
import assert from 'node:assert/strict';

import {fixtureState, rule, stepTick, monthIndex, serialize, restore, TICK_SECONDS} from '../src/sim/index.js';
import {docketMonthly} from '../src/sim/docket.js';
import {FOLLOWUP_PHRASES, followupText, rulingReceipt} from '../src/sim/followups.js';
import {lintCatalogue, lintText} from '../src/sim/text/voice.js';
import * as view from '../src/sim/view.js';

const MINOR = new Set(['not_now', 'refuse', 'neither', 'negotiate', 'delegate']);

function runMonths(state, months) {
  const until = monthIndex(state.time) + months;
  while (monthIndex(state.time) < until) stepTick(state, 4, {}, {skipPeople: true});
  // Let the month's rollover jobs run (one a tick).
  for (let i = 0; i < 40; i++) stepTick(state, TICK_SECONDS, {}, {skipPeople: true});
}

// A town with a request on the table, approved: [state, card id].
function approvedTown() {
  const s = fixtureState('town');
  s.treasury = Math.max(s.treasury, 100000);
  const card = s.docket.find((c) => c.surfacedMonth != null && ['proposal', 'petition', 'debate', 'demand'].includes(c.kind));
  assert.ok(card, 'the fixture town has a request waiting');
  const option = card.options.find((o) => !MINOR.has(o.key));
  const result = rule(s, card.id, option.key);
  assert.equal(result.outcome, 'accepted');
  return [s, card.id, result];
}

const followupsOf = (s, id, years) => s.chronicle.entries.filter((e) => e.refs?.card === id && e.refs?.followup === years);

test('an approved request gets one follow-up line a year on and one five years on', () => {
  const [s, id, result] = approvedTown();
  assert.ok(result.receipt?.startsWith('Approved: '), result.receipt);
  assert.deepEqual(lintText(result.receipt), []);
  assert.equal(s.followups.filter((f) => f.card === id).length, 1);

  runMonths(s, 11);
  assert.equal(followupsOf(s, id, 1).length, 0, 'nothing before the year is out');
  runMonths(s, 2);
  const one = followupsOf(s, id, 1);
  assert.equal(one.length, 1);
  assert.match(one[0].text, /A year on, /);
  assert.deepEqual(lintText(one[0].text), []);

  runMonths(s, 48);
  assert.equal(followupsOf(s, id, 1).length, 1, 'still only one line a year on');
  const five = followupsOf(s, id, 5);
  assert.equal(five.length, 1);
  assert.match(five[0].text, /Five years on, /);
  assert.deepEqual(lintText(five[0].text), []);
  assert.ok(!s.followups.some((f) => f.card === id), 'done follow-ups leave the list');

  // The ledger shows the ruling with its follow-ups.
  const row = view.selectRulings(s).rows.find((r) => r.id === id && r.outcome === 'approved');
  assert.ok(row);
  assert.equal(row.followups.length, 2);
});

test('a town saved after a ruling continues exactly like the original, follow-ups and all', () => {
  const [s, id] = approvedTown();
  runMonths(s, 3);
  const r = restore(serialize(s));
  assert.deepEqual(r.followups, s.followups);
  runMonths(s, 58);
  runMonths(r, 58);
  assert.equal(followupsOf(r, id, 1).length, 1);
  assert.equal(followupsOf(r, id, 5).length, 1);
  assert.equal(serialize(r), serialize(s));
});

test('saves from before follow-ups open with none waiting, and round-trip unchanged', () => {
  const s = fixtureState('town');
  const old = JSON.parse(serialize(s));
  delete old.followups;
  const r = restore(JSON.stringify(old));
  assert.deepEqual(r.followups, []);
  const text = serialize(r);
  assert.equal(serialize(restore(text)), text);
});

test('follow-up and receipt text keeps to the house voice', () => {
  assert.deepEqual(lintCatalogue({lines: Object.values(FOLLOWUP_PHRASES).flatMap((p) => [p.up, p.down, p.flat])}), []);
  const s = fixtureState('town');
  for (const area of Object.keys(FOLLOWUP_PHRASES)) {
    for (const f of [{title: 'A summer fair', area, year: 4, base: 0}, {heard: 'the farmers and the makers', area, year: 4, base: 0}]) {
      for (const i of [0, 1]) assert.deepEqual(lintText(followupText(s, f, i)), [], followupText(s, f, i));
    }
  }
  const card = {kind: 'proposal', title: 'A summer fair', helps: ['farm'], hurts: ['trade'], options: [], data: {}};
  const text = rulingReceipt(s, card, {key: 'do', cost: 250}, 'accepted');
  assert.equal(text, 'Approved: a summer fair. −250 coin. Farmers are pleased. Merchants grumble.');
  assert.equal(rulingReceipt(s, card, {key: 'refuse'}, 'refused'), 'Refused: a summer fair. Farmers are let down.');
  assert.match(rulingReceipt(s, card, {key: 'not_now'}, 'deferred'), /^Put off: a summer fair\./);
  assert.equal(rulingReceipt(s, {...card, kind: 'report'}, null, 'noted'), null);
});

test('a lapsed request counts in the tally and shows as lapsed in the ledger', () => {
  const s = fixtureState('town');
  const before = view.selectTopBar(s).rulings.lapsed;
  const card = s.docket.find((c) => c.surfacedMonth != null && c.kind !== 'report' && c.kind !== 'budget');
  assert.ok(card);
  card.expiresMonth = monthIndex(s.time);
  docketMonthly(s);
  assert.ok(!s.docket.includes(card));
  assert.equal(view.selectTopBar(s).rulings.lapsed, before + 1);
  const row = view.selectRulings(s).rows.find((r) => r.id === card.id);
  assert.ok(['lapsed', 'enacted'].includes(row?.outcome), row?.outcome);
});

test('the age just ended has up to three changes and a tally line', () => {
  const s = fixtureState('town');
  const age = view.selectEraProgress(s).lastAge;
  assert.ok(age);
  assert.ok(age.items.length >= 1 && age.items.length <= 3);
  assert.match(age.line, /^Your rulings this age: \S+ approved, \S+ refused, \S+ lapsed\.$/);
  for (const t of [...age.items, age.line]) assert.deepEqual(lintText(t), [], t);
});
