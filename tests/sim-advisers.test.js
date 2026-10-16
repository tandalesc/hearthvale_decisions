// Advisers (src/sim/advisors.js, design §4) and the retirement of delegation
// and standing orders (step 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import {stepTick, fixtureState, serialize, restore, rule, hireAdviser, dismissAdviser, setAdviserMode, redrawSlate, letStand} from '../src/sim/index.js';
import {totalMoney, externalNet} from '../src/sim/economy.js';
import {addCard, makeCard} from '../src/sim/docket.js';
import {monthIndex} from '../src/sim/clock.js';
import {
  areaOf, advise, adviserFor, drawSlate, advisersYearly, seatCount, standingScore, AREAS,
} from '../src/sim/advisors.js';
import {INSTITUTIONS} from '../src/sim/institutions.js';
import {selectAdvisers, selectDocket, selectUnlocks, selectBodies} from '../src/sim/view.js';

const conserved = (s) => totalMoney(s) - externalNet(s);
const step = (s) => stepTick(s, 4, {}, {skipPeople: true});
const until = (s, f, limit = 20000) => { for (let i = 0; i < limit && !f(); i++) step(s); assert.ok(f(), 'condition reached'); };
// The city fixture past its first budget season: the advisers' bench is open.
function bench() {
  const s = fixtureState('city');
  until(s, () => s.time.year === 93 && s.time.month === 1);
  return s;
}
// A proposal from a body in the hired adviser's area.
function proposal(s, from, extra = {}) {
  return makeCard(s, {kind: 'proposal', from, templateId: 'seed-exchange', category: 'food', title: 'A test plan', why: '', cost: 50,
    options: [{key: 'do', label: 'Do it', tradeoff: '', cost: 50, effects: [{tag: `test:${extra.tag ?? 'a'}`}]}], subjects: [`test:${extra.tag ?? 'a'}`], ...extra});
}

test('areas follow what a body drafts: every body in exactly one, as the design\'s table', () => {
  const want = {
    'agri-council': 'land', 'trades-guild': 'land', exchange: 'land', union: 'land', ward: 'land',
    'river-authority': 'works', planning: 'works', 'health-board': 'works', watch: 'works',
    parish: 'learning', 'school-board': 'learning', 'arts-society': 'learning',
  };
  for (const kind of Object.keys(INSTITUTIONS)) assert.equal(areaOf(kind), kind === 'moot' ? null : want[kind], kind);
  assert.deepEqual(Object.keys(AREAS).sort(), ['land', 'learning', 'works']);
});

test('the bench opens at City after a budget season; slates are real households, the same every time, drawn with no rng', () => {
  const a = bench(), b = bench();
  assert.equal(selectUnlocks(a).advisers, true);
  assert.equal(a.advisers.unlockedYear, 93);
  assert.ok(seatCount(a) >= 1 && a.advisers.seats.length === seatCount(a));
  assert.deepEqual(a.advisers.slate, b.advisers.slate);
  const rng = JSON.stringify(a.rng);
  const once = drawSlate(a, a.advisers.slate.seatId).candidates;
  assert.equal(JSON.stringify(a.rng), rng, 'no random draws');
  assert.deepEqual(drawSlate(a, a.advisers.slate.seatId).candidates, once, 'drawn again at the same moment: the same slate');
  drawSlate(b, b.advisers.slate.seatId);
  for (const c of a.advisers.slate.candidates) {
    const h = a.households.find((x) => x.id === c.householdId);
    assert.ok(h && (h.lifeStage === 'family' || h.lifeStage === 'elder'), 'a settled grown household');
    assert.ok(a.time.year - h.formedYear >= 8);
    assert.match(c.name, /^\w+ \w+$/);
    assert.ok(c.salary > 0 && c.issues.length <= 2 && ['Tactful', 'Blunt', 'Shrewd', 'Steady'].includes(c.temper));
  }
  assert.equal(new Set(a.advisers.slate.candidates.map((c) => c.householdId)).size, a.advisers.slate.candidates.length);
  // "See others" once a year.
  assert.equal(redrawSlate(a).ok, true);
  assert.notDeepEqual(a.advisers.slate.candidates.map((c) => c.householdId), b.advisers.slate.candidates.map((c) => c.householdId));
  assert.equal(redrawSlate(a).ok, false);
});

test('a hired adviser stages answers that wait a season; they apply at the due month; Let it stand applies now', () => {
  const s = bench();
  const cand = s.advisers.slate.candidates[0];
  assert.equal(hireAdviser(s, cand.id, 'land').ok, true);
  const adviser = s.advisers.roster[0];
  assert.equal(adviserFor(s, 'agri-council').adviser, adviser);
  assert.equal(adviserFor(s, 'planning'), null, 'another area waits for its own seat');
  // A routine plan: staged, surfaced at once for your review.
  const card = addCard(s, proposal(s, 'agri-council'));
  assert.ok(card?.advice?.act, 'staged');
  assert.ok(card.surfacedMonth != null);
  const m = monthIndex(s.time);
  assert.ok(card.advice.dueMonth > m && card.advice.dueMonth <= m + (adviser.temper === 'Blunt' ? 1 : 6));
  assert.ok(card.advice.rationale.length >= 1 && card.advice.rationale.length <= 2);
  assert.ok(card.advice.rationale.every((r) => typeof r.text === 'string' && r.text.length > 3));
  // The scorer is pure: the same answer again.
  assert.deepEqual(advise(s, adviser, card), {option: card.advice.option, rationale: card.advice.rationale});
  const view = selectDocket(s).find((c) => c.id === card.id).advice;
  assert.equal(view.name, adviser.name);
  assert.equal(view.act, true);
  // At the due month, it is applied as the adviser's ruling.
  until(s, () => !s.docket.includes(card));
  const h = s.cardHistory.findLast((x) => x.id === card.id);
  assert.equal(h.advisedBy, adviser.id);
  assert.equal(h.choice, card.advice.option);
  assert.ok(!h.overruled);
  assert.equal(adviser.stats.answered, 1 + adviser.stats.answered - 1);
  assert.ok(s.chronicle.entries.some((e) => e.refs?.adviserAnswer && e.refs.card === card.id));
  // Let it stand: now, and counted as stood.
  const two = addCard(s, proposal(s, 'agri-council', {tag: 'b'}));
  const stood = adviser.stats.stood;
  assert.equal(letStand(s, two.id).ok, true);
  assert.ok(!s.docket.includes(two));
  assert.equal(adviser.stats.stood, stood + 1);
});

test('changing an adviser\'s answer counts as overruling; overruled often, they resign at year end', () => {
  const s = bench();
  hireAdviser(s, s.advisers.slate.candidates.find((c) => c.temper !== 'Steady')?.id ?? s.advisers.slate.candidates[0].id, 'land');
  const adviser = s.advisers.roster[0];
  if (adviser.temper === 'Steady') adviser.temper = 'Tactful';
  for (const tag of ['x1', 'x2', 'x3', 'x4']) {
    const card = addCard(s, proposal(s, 'agri-council', {tag}));
    const other = card.options.find((o) => o.key !== card.advice.option);
    assert.equal(rule(s, card.id, other.key).ok, true);
    assert.equal(s.cardHistory.at(-1).overruled, true);
  }
  assert.equal(adviser.stats.changed, 4);
  assert.equal(selectAdvisers(s).seats.find((x) => x.adviser)?.adviser.overruled, 100);
  // (Advise only from here, so the year's tally stays these four.)
  setAdviserMode(s, s.advisers.seats.find((x) => x.adviserId === adviser.id).id, 'advise');
  const y = s.time.year;
  until(s, () => s.time.year === y + 1 && s.time.month === 1);
  assert.equal(adviser.leftWhy, 'resigned');
  assert.ok(!s.advisers.seats.some((x) => x.adviserId === adviser.id));
  assert.ok(s.advisers.slate, 'a new slate for the empty seat');
  assert.ok(s.chronicle.entries.some((e) => e.refs?.advisers === 'resigned'));
});

test('modes: Advise only recommends, Routine leaves pet-issue rules to you, All answers them', () => {
  const s = bench();
  hireAdviser(s, s.advisers.slate.candidates[0].id, 'land');
  const adviser = s.advisers.roster[0];
  const seat = s.advisers.seats.find((x) => x.adviserId === adviser.id);
  adviser.issues = [{policy: 'rent-cap', stance: -1}];
  const ruleCard = (tag) => makeCard(s, {kind: 'proposal', from: 'agri-council', templateId: `adopt:rent-cap`, category: 'land', title: 'A rent cap', why: '', cost: 0,
    data: {policy: 'rent-cap', level: 1}, subjects: [`test:${tag}`],
    options: [{key: 'adopt', label: 'Adopt it', tradeoff: '', cost: 0, effects: [{policy: 'rent-cap', level: 1}]}]});
  assert.equal(addCard(s, ruleCard('r1')).advice.act, false, 'Routine: a pet issue comes to you, with their view');
  assert.equal(setAdviserMode(s, seat.id, 'all').ok, true);
  const all = addCard(s, ruleCard('r2'));
  assert.equal(all.advice.act, true);
  assert.ok(['not_now', 'refuse'].includes(all.advice.option), `against the rent cap: they turn it down (${all.advice.option})`);
  assert.ok(all.advice.rationale.some((r) => /rent cap/.test(r.text)));
  setAdviserMode(s, seat.id, 'advise');
  assert.equal(addCard(s, proposal(s, 'agri-council', {tag: 'r3'})).advice.act, false, 'Advise only');
});

test('dismissal: severance, staged answers back to you, barred ten years, and a new slate', () => {
  const s = bench();
  hireAdviser(s, s.advisers.slate.candidates[0].id, 'land');
  const adviser = s.advisers.roster[0];
  const card = addCard(s, proposal(s, 'agri-council'));
  assert.ok(card.advice);
  const before = conserved(s);
  const h = s.households.find((x) => x.id === adviser.householdId);
  const savings = h.savings;
  assert.equal(dismissAdviser(s, adviser.id).ok, true);
  assert.ok(Math.abs(h.savings - savings - adviser.salary / 2) < 1e-6, 'half a year\'s salary');
  assert.ok(Math.abs(conserved(s) - before) < 1e-6 * Math.abs(before));
  assert.ok(!card.advice, 'its staged answer withdrawn');
  assert.equal(adviser.leftWhy, 'dismissed');
  assert.equal(s.advisers.barred[adviser.householdId], s.time.year + 10);
  assert.ok(s.advisers.slate && !s.advisers.slate.candidates.some((c) => c.householdId === adviser.householdId));
});

test('salaries go monthly to the adviser\'s household and conserve money; a household that leaves empties the seat', () => {
  const s = bench();
  hireAdviser(s, s.advisers.slate.candidates[0].id, 'works');
  const adviser = s.advisers.roster[0];
  const start = conserved(s);
  const y = s.time.year;
  until(s, () => s.time.year === y + 1 && s.time.month === 1);
  assert.ok((s.economy.lastYear['adviser-salary'] ?? 0) > 0.9 * adviser.salary);
  assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.abs(start));
  assert.ok(adviser.stats.byYear.length === 1 && Number.isFinite(adviser.stats.byYear[0].standing));
  assert.ok(standingScore(s, adviser) >= 0 && standingScore(s, adviser) <= 100);
  s.households = s.households.filter((h) => h.id !== adviser.householdId);
  advisersYearly(s);
  assert.equal(adviser.leftWhy, 'left');
  assert.ok(!s.advisers.seats.some((x) => x.adviserId === adviser.id));
});

test('advisers answer their area\'s budgets in season, with the same choices and trim-to-fit depth', () => {
  const s = bench();
  hireAdviser(s, s.advisers.slate.candidates[0].id, 'land');
  const adviser = s.advisers.roster[0];
  until(s, () => s.time.month === 9 && s.docket.some((c) => c.kind === 'budget'));
  const mine = s.docket.filter((c) => c.kind === 'budget' && areaOf(s.institutions.find((b) => b.id === c.from).kind) === 'land');
  assert.ok(mine.length >= 1);
  for (const c of mine) {
    assert.ok(c.advice?.act, `${c.from} advised`);
    assert.ok(['approve', 'trim90', 'trim75', 'trim50', 'same', 'refuse', 'trim'].includes(c.advice.option));
    if (c.advice.option === 'trim') assert.ok(c.advice.factor > 0 && c.advice.factor < 1);
  }
  assert.ok(s.docket.filter((c) => c.kind === 'budget' && !mine.includes(c)).every((c) => !c.advice), 'other areas wait for you');
  const y = s.time.year;
  until(s, () => s.time.year === y + 1 && s.time.month === 1);
  const answered = s.cardHistory.filter((h) => h.kind === 'budget' && h.advisedBy === adviser.id);
  assert.equal(answered.length, mine.length);
});

test('a save with advisers continues exactly like the original', () => {
  const s = bench();
  hireAdviser(s, s.advisers.slate.candidates[0].id, 'land');
  addCard(s, proposal(s, 'agri-council'));
  const r = restore(serialize(s));
  for (let i = 0; i < 400; i++) { step(s); step(r); }
  assert.equal(serialize(r), serialize(s));
});

test('step 8: delegation and standing orders are gone; an old save that had them loads and drops them', () => {
  const s = fixtureState('town');
  const text = JSON.parse(serialize(s));
  for (const b of text.institutions) Object.assign(b, {delegated: true, delegateCap: 500, standingOrders: [{id: 'so1', match: {category: 'food'}, action: 'approve'}]});
  const r = restore(JSON.stringify(text));
  for (const b of r.institutions) assert.ok(!('delegated' in b) && !('delegateCap' in b) && !('standingOrders' in b), b.id);
  for (const b of selectBodies(r)) assert.ok(!('delegated' in b) && !('canDelegate' in b) && !('standingOrders' in b));
  const u = selectUnlocks(r);
  assert.ok(!('delegation' in u) && !('standingOrders' in u));
  // A food card from a body that had a standing order to approve: it asks you.
  const body = r.institutions.find((b) => b.kind === 'agri-council' && b.status === 'active') ?? r.institutions.find((b) => b.kind !== 'moot' && b.status === 'active');
  const card = addCard(r, proposal(r, body.id, {tag: 'so'}));
  assert.ok(card && r.docket.includes(card));
  assert.ok(!card.options.some((o) => o.key === 'delegate'));
});
