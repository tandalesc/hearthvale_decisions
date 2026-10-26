import test from 'node:test';
import assert from 'node:assert/strict';
import {narrationTriples} from '../src/narration-features.js';
import {fixtureState} from '../src/sim/fixtures.js';
import {cardFacts, narrativeFacts, chronicleFacts} from '../src/sim/narrative-facts.js';
import {templateRows, modelRow} from '../scripts/narration-export.js';

const state = fixtureState('town');
const card = cardFacts(state, state.docket[0].id);
const person = narrativeFacts(state, {personId: state.people[3].id});
const valid = ([s, a, v, n, type]) => typeof s === 'string' && typeof a === 'string' && typeof v === 'string' &&
  (n === null || Number.isFinite(n)) && ['enum', 'num', 'text'].includes(type);

test('narration triples: every sheet type, schema order, deterministic', () => {
  for (const facts of [card, person, chronicleFacts(state, {year: state.time.year - 1}), chronicleFacts(state, {end: true})]) {
    const t = narrationTriples(facts);
    assert.ok(t.length > 5 && t.every(valid), facts.type ?? facts.kind);
    assert.deepEqual(narrationTriples(facts), t);
    assert.ok(!t.some(([s, a]) => s === (facts.type ?? facts.kind) && (a === 'v' || a === 'id')), 'version and card id are left out');
  }
});

test('narration triples: names stay copyable, lists keyed, years as offsets', () => {
  const t = narrationTriples(card);
  assert.ok(t.some(([s, a, v, , type]) => s === 'asker' && a === 'name' && v === card.asker.name && type === 'text'));
  const option = card.options[0];
  assert.ok(t.some(([s, a, v]) => s === `options:${option.key}` && a === 'label' && v === option.label));
  const past = t.find(([s, a]) => s === 'past:0' && a === 'year');
  if (past) assert.equal(past[3] <= 0, true, 'a past year is at or before the card');
  assert.ok(!narrationTriples(card, {drop: ['card.why']}).some(([s, a]) => s === 'card' && a === 'why'));
});

test('narration export: template rows hide their target, model rows pass the checks', () => {
  const [why] = templateRows(card);
  assert.equal(why.task, 'card.why');
  assert.equal(why.target, card.why);
  assert.ok(!narrationTriples(card, {drop: why.drop}).some(([, , v]) => v === card.why));
  assert.equal(templateRows(person)[0].task, 'entity.note');
  assert.equal(modelRow(card, 'why', card.why).reason, 'unchanged game explanation');
  assert.equal(modelRow(card, 'why', 'We need 999 more carts by spring.').reason.split(':')[0], 'number not in facts');
});
