// Approval (src/sim/approval.js): recorded yearly from year 0, from data the
// sim already keeps; deterministic, rng-free, and filled in on old saves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, stepTick, fastForward, fixtureState, serialize, restore, rule, SAVE_VERSION, TICKS_PER_YEAR} from '../src/sim/index.js';
import {approvalYearly, foldReaction, initApproval, reactionNet, APPROVAL_DIMS} from '../src/sim/approval.js';
import {selectApproval, selectTopBar, selectUnlocks, selectFactions} from '../src/sim/view.js';

const years = (s, n) => {
  for (let i = 0; i < n * TICKS_PER_YEAR; i++) stepTick(s, 0.1, {}, {skipPeople: true});
  return s;
};
// The state as the rest of the sim sees it: approval and its bookkeeping left out.
const strip = (s) => {
  const o = JSON.parse(serialize(s));
  delete o.approval;
  for (const f of o.factions) { delete f.moodLog; delete f.moodParts; }
  o.chronicle.entries = o.chronicle.entries.filter((e) => e.refs?.approval == null);
  return JSON.stringify(o);
};

test('a new hamlet records approval silently from year 0, one history entry a year', () => {
  const s = createState(41);
  assert.ok(s.approval.overall > 0 && s.approval.overall < 1, 'a figure from the start');
  assert.equal(s.approval.history.length, 0, 'no year has ended yet');
  years(s, 3);
  // The year's jobs run one per tick after the rollover.
  for (let i = 0; i < 40; i++) stepTick(s, 0.1, {}, {skipPeople: true});
  assert.deepEqual(s.approval.history.map((h) => h.y), [0, 1, 2]);
  for (const h of s.approval.history) assert.ok(h.all > 0 && h.all < 1 && Object.keys(h.f).length >= 1);
  assert.equal(s.approval.year, 2);
  for (const d of APPROVAL_DIMS) assert.ok(s.approval.rows[d], `rows by ${d}`);
  const people = Object.values(s.approval.rows.faction).reduce((n, r) => n + r.n, 0);
  assert.equal(people, s.households.reduce((n, h) => n + h.size, 0));
  // Silent: no chronicle line and nothing shown before Borough.
  assert.ok(!s.chronicle.entries.some((e) => e.refs?.approval != null));
  assert.equal(selectUnlocks(s).approval, false);
});

test('approval is deterministic and draws no random numbers', () => {
  const a = years(createState(77), 4), b = years(createState(77), 4);
  assert.deepEqual(a.approval, b.approval);
  assert.equal(serialize(a), serialize(b));
  // The pass itself reads the state and leaves the rest of it (and the rng) alone.
  const rngBefore = JSON.stringify(a.rng);
  const rest = strip(a);
  a.time.year += 1;
  approvalYearly(a);
  a.time.year -= 1;
  assert.equal(JSON.stringify(a.rng), rngBefore);
  assert.equal(strip(a), rest);
});

test('an old save without approval gains it on restore, keeps version 2, and its history grows', () => {
  // The cached city fixture was saved before approval existed.
  const s = fixtureState('city');
  assert.equal(s.version, SAVE_VERSION);
  assert.equal(SAVE_VERSION, 2);
  const a = s.approval;
  assert.ok(a.overall > 0.05 && a.overall < 0.95, `overall ${a.overall}`);
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].y, s.time.year - 1);
  assert.ok(Object.keys(a.ledger).length > 5, 'the reaction ledger starts from the saved slice answers');
  assert.deepEqual(a.drivers, [], 'no reasons until a year can be compared');
  // A save made without the field restores to the same figure, every time.
  const text = JSON.parse(serialize(s));
  delete text.approval;
  for (const f of text.factions) { delete f.moodParts; delete f.moodLog; }
  const r = restore(JSON.stringify(text));
  assert.deepEqual(r.approval, restore(JSON.stringify(text)).approval);
  assert.ok(Math.abs(r.approval.overall - a.overall) < 0.02);
  // A year on: two entries, a change, and named reasons.
  fastForward(s, 1);
  assert.equal(s.approval.history.length, 2);
  assert.ok(s.approval.drivers.length >= 1, 'it says why it moved');
  for (const d of s.approval.drivers) {
    assert.equal(typeof d.text, 'string');
    assert.ok(d.text.length > 3 && !/undefined|null|NaN/.test(d.text), d.text);
    assert.ok(Number.isFinite(d.points) && Math.abs(d.points) >= 0.5);
  }
  assert.ok(s.approval.drivers.filter((d) => d.points > 0).length <= 3 && s.approval.drivers.filter((d) => d.points < 0).length <= 3);
  // A round trip keeps every number.
  const back = restore(serialize(s));
  assert.deepEqual(back.approval, s.approval);
});

test('a restored game goes on exactly like the original, approval included', () => {
  const s = years(createState(19), 2);
  const r = restore(serialize(s));
  years(s, 2);
  years(r, 2);
  assert.deepEqual(r.approval, s.approval);
  assert.equal(serialize(r), serialize(s));
});

test('going against a faction lowers its approval, and the ruling is named as a reason', () => {
  const s = fixtureState('town');
  approvalYearly(s);
  const y = s.time.year - 1;
  const base = JSON.parse(JSON.stringify(s.approval));
  // A year passes in which you approved what the merchants opposed, twice.
  const target = s.factions.filter((f) => f.size > 0 && !f.parent).sort((a, b) => b.size - a.size)[0].id;
  for (const id of ['t1', 't2']) {
    s.cardHistory.push({id, kind: 'proposal', from: 'moot', title: 'A toll on the bridge', choice: 'do', outcome: 'accepted', year: y + 1, month: 3, stances: {[target]: 'against'}, helps: [], hurts: []});
  }
  s.time.year += 1;
  approvalYearly(s);
  s.time.year -= 1;
  assert.ok(s.approval.rows.faction[target].v < base.rows.faction[target].v, `${target} ${base.rows.faction[target].v} -> ${s.approval.rows.faction[target].v}`);
  assert.ok(s.approval.parts.rulings < base.parts.rulings);
  const why = s.approval.drivers.find((d) => d.key === 'ruling:t1' || d.key === 'ruling:t2');
  assert.ok(why, `drivers: ${JSON.stringify(s.approval.drivers)}`);
  assert.ok(why.points < 0);
  assert.equal(why.text, 'You approved: a toll on the bridge');
});

test('rule reactions fold into the ledger, and their net reads welcome against protest', () => {
  const s = createState(5);
  assert.equal(reactionNet({support: 1}), 1);
  assert.equal(reactionNet({protest: 0.5, grumble: 0.5}), -0.75);
  const answers = [
    {subject: {dim: 'trade', value: 'farm'}, probs: {support: 0, accept: 0, grumble: 0, protest: 1, strike: 0, leave: 0}},
    {subject: {dim: 'trade', value: 'craft'}, probs: {support: 1, accept: 0, grumble: 0, protest: 0, strike: 0, leave: 0}},
  ];
  s.approval.ledger = {};
  foldReaction(s, answers, {policy: 'rent-cap', change: 'adopted'}, {support: 0.5, protest: 0.5});
  assert.deepEqual(s.approval.ledger, {'trade=farm': -1, 'trade=craft': 1});
  foldReaction(s, [{subject: {dim: 'trade', value: 'farm'}, probs: {support: 1}}], {});
  assert.equal(s.approval.ledger['trade=farm'], -0.4);
  assert.deepEqual(s.approval.reactions.at(-1), {y: s.time.year, policy: 'rent-cap', change: 'adopted', net: 0, worst: 'trade=farm', best: 'trade=craft'});
});

test('the view shows approval from Borough: the figure, its change, the groups and the reasons', () => {
  const town = fixtureState('town');
  assert.ok(town.era < 3);
  assert.equal(selectUnlocks(town).approval, false);
  const s = fixtureState('city');
  fastForward(s, 1);
  assert.equal(selectUnlocks(s).approval, true);
  const v = selectApproval(s);
  assert.equal(v.value, Math.round(s.approval.overall * 100));
  assert.equal(v.history.length, 2);
  assert.equal(v.change, v.history[1].v - v.history[0].v);
  const top = selectTopBar(s);
  assert.equal(top.approval, v.value);
  assert.equal(top.approvalChange, v.change);
  assert.deepEqual(v.tabs.map((t) => t.id).slice(0, 3), ['faction', 'wealthBand', 'district']);
  const groups = v.tabs[0];
  assert.ok(groups.rows.length >= 3 && groups.rows.every((r) => r.name && Number.isInteger(r.value) && r.share > 0));
  assert.ok(v.tabs.find((t) => t.id === 'district').rows.length <= 8);
  assert.ok(v.drivers.every((d) => Number.isInteger(d.points) && d.points !== 0));
  const factions = selectFactions(s);
  assert.ok(factions.every((f) => f.approval == null || Number.isInteger(f.approval)));
  assert.ok(factions.some((f) => Number.isInteger(f.approval)));
});

test('a big swing at Borough or later writes one chronicle line naming the main reason', () => {
  const s = fixtureState('city');
  initApproval(s);
  const before = s.chronicle.entries.length;
  // Everyone sours by a third in a year.
  for (const f of s.factions) f.mood = Math.max(0, f.mood - 0.35);
  s.time.year += 1;
  approvalYearly(s);
  s.time.year -= 1;
  const lines = s.chronicle.entries.slice(before).filter((e) => e.refs?.approval != null);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Your standing fell to \d+%(, chiefly over .+)?\.$/);
});
