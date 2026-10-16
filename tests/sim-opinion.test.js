// Town opinion on docket cards: faction stances weighted by faction size,
// a verdict, and the readout on every card kind the factions are asked about.
import test from 'node:test';
import assert from 'node:assert/strict';

import {fixtureState} from '../src/sim/index.js';
import {opinionOf, verdictOf} from '../src/sim/opinion.js';
import {addCard, makeCard} from '../src/sim/docket.js';
import {formBody} from '../src/sim/institutions.js';
import {POLICIES} from '../src/sim/policies.js';
import * as view from '../src/sim/view.js';

const town = (sizes) => ({factions: Object.entries(sizes).map(([id, size]) => ({id, name: id, size}))});
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

test('opinion weights each faction by its share of the people', () => {
  const s = town({farmers: 300, merchants: 100});
  const o = opinionOf(s, {
    farmers: {stance: 'for', p: 0.8, probs: {for: 0.8, against: 0.1, split: 0, indifferent: 0.1}},
    merchants: {stance: 'against', p: 0.8, probs: {for: 0.1, against: 0.8, split: 0, indifferent: 0.1}},
  });
  assert.ok(near(o.for, 0.75 * 0.8 + 0.25 * 0.1), `for ${o.for}`);
  assert.ok(near(o.against, 0.75 * 0.1 + 0.25 * 0.8), `against ${o.against}`);
  assert.ok(near(o.for + o.against + o.indifferent, 1));
  assert.equal(o.verdict, 'popular');
  assert.equal(o.heard, 1);
  assert.deepEqual(o.factions.map((r) => [r.faction, r.share, r.stance]), [['farmers', 0.75, 'for'], ['merchants', 0.25, 'against']]);
});

test('verdicts: popular, unpopular, divisive, indifferent', () => {
  assert.equal(verdictOf({for: 0.55, against: 0.2, indifferent: 0.25}), 'popular');
  assert.equal(verdictOf({for: 0.2, against: 0.34, indifferent: 0.46}), 'unpopular');
  assert.equal(verdictOf({for: 0.27, against: 0.25, indifferent: 0.48}), 'divisive', 'two camps of a size');
  assert.equal(verdictOf({for: 0.55, against: 0.35, indifferent: 0.1}), 'divisive', 'a big camp on each side');
  assert.equal(verdictOf({for: 0.3, against: 0.15, indifferent: 0.3, split: 0.3}), 'divisive', 'factions torn within');
  assert.equal(verdictOf({for: 0.2, against: 0.2, indifferent: 0.6}), 'indifferent');
});

test('a split faction counts half each way, and a torn town reads divisive', () => {
  const s = town({labourers: 100});
  const o = opinionOf(s, {labourers: {stance: 'split', p: 0.9, probs: {for: 0.05, against: 0.05, split: 0.9, indifferent: 0}}});
  assert.ok(near(o.for, 0.5) && near(o.against, 0.5));
  assert.equal(o.verdict, 'divisive');
  assert.ok(o.controversy >= 0.9);
});

test('opinion reads back / oppose, old stances without probabilities, and factions that split later', () => {
  const s = town({gentry: 50, clergy: 50});
  const forms = opinionOf(s, {gentry: {stance: 'back', p: 0.8, probs: {back: 0.8, oppose: 0.05, indifferent: 0.15}},
    clergy: {stance: 'oppose', p: 0.55, probs: {back: 0.1, oppose: 0.55, indifferent: 0.35}}});
  assert.ok(forms.for > 0.4 && forms.against > 0.25);
  const old = opinionOf(s, {gentry: {stance: 'for', p: 0.7}, clergy: {stance: 'indifferent', p: 0.6}});
  assert.ok(old.for > old.against);
  // The farmers split after the card was drawn up: both halves inherit the parent's stance.
  const split = {factions: [{id: 'farmers', size: 0, splitInto: ['farmers:a', 'farmers:b']},
    {id: 'farmers:a', parent: 'farmers', name: 'Poor farmers', size: 60}, {id: 'farmers:b', parent: 'farmers', name: 'Better-off farmers', size: 40}]};
  const o = opinionOf(split, {farmers: {stance: 'for', p: 0.8, probs: {for: 0.8, against: 0.1, indifferent: 0.1}}});
  assert.equal(o.heard, 1);
  assert.equal(o.factions.length, 2);
  assert.equal(o.verdict, 'popular');
});

test('opinion is forming until most of the town has a stance on record', () => {
  const s = town({farmers: 100, merchants: 300});
  assert.equal(opinionOf(s, {}).verdict, 'forming');
  assert.equal(opinionOf(s, {farmers: {stance: 'for', p: 0.9}}).verdict, 'forming');
  assert.notEqual(opinionOf(s, {merchants: {stance: 'for', p: 0.9}}).verdict, 'forming');
});

test('every card the factions are asked about carries a town readout; events and reports do not', () => {
  for (const name of ['hamlet', 'town', 'city']) {
    const s = fixtureState(name);
    for (const card of s.docket) {
      const o = view.cardView(s, card).opinion;
      if (card.kind === 'report' || card.kind === 'event') {
        assert.equal(o, null, `${name} ${card.kind}`);
        continue;
      }
      assert.ok(o, `${name} ${card.kind} ${card.title}`);
      assert.notEqual(o.verdict, 'forming', `${name}: ${card.title} has stances`);
      assert.ok(['popular', 'divisive', 'unpopular', 'indifferent'].includes(o.verdict));
      assert.ok(near(o.for + o.against + o.indifferent, 1, 0.02));
      assert.ok(o.factions.every((r) => typeof r.name === 'string' && r.share >= 0 && r.share <= 1));
    }
  }
});

test('a fresh card reads at once from local stances and says when the factions are still being asked', () => {
  const s = fixtureState('town');
  s.docket = [];
  const card = addCard(s, makeCard(s, {kind: 'proposal', from: 'moot', templateId: 'adopt:commons', title: POLICIES.commons.title, why: 'Test.',
    helps: POLICIES.commons.helps, hurts: POLICIES.commons.hurts, data: {policy: 'commons'},
    options: [{key: 'do', label: 'Do it', tradeoff: 'Test.', effects: [{policy: 'commons', level: 1}]}]}));
  const o = view.cardView(s, card).opinion;
  assert.notEqual(o.verdict, 'forming', 'local stances are there at once (offline too)');
  assert.equal(o.pending, true, 'the stance question is still queued');
});

test('a debate reads each side on its own', () => {
  const s = fixtureState('town');
  s.docket = [];
  for (const kind of ['union', 'exchange']) formBody(s, kind);
  const plan = (from, policy) => makeCard(s, {kind: 'proposal', from, templateId: `adopt:${policy}`, title: POLICIES[policy].title,
    why: 'Test.', helps: POLICIES[policy].helps, hurts: POLICIES[policy].hurts, data: {policy},
    options: [{key: 'do', label: 'Do it', tradeoff: 'Test.', effects: [{policy, level: 1}]}]});
  addCard(s, plan('union', 'hours-cap'));
  const debate = addCard(s, plan('exchange', 'free-trade'));
  assert.equal(debate.kind, 'debate');
  const o = view.cardView(s, debate).opinion;
  assert.equal(o.sides.length, 2);
  assert.deepEqual(o.sides.map((x) => x.side), ['union', 'exchange']);
  assert.deepEqual(o.sides.map((x) => x.option), ['a', 'b']);
  const labourers = (side) => o.sides[side].factions.find((r) => r.faction === 'labourers');
  assert.ok(labourers(0).for > labourers(1).for, 'the workers lean to the union side');
});
