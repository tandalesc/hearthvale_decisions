import test from 'node:test';
import assert from 'node:assert/strict';

import {createState, registerSystem} from '../src/sim/index.js';
import {governanceSystem} from '../src/sim/governance.js';
import {EFFECTS} from '../src/sim/decisions/effects.js';
import {addCard, coalesceGrievancePetitions, docketMonthly, makeCard, rule, setCardProse} from '../src/sim/docket.js';
import {subjectBlocked, timesAsked} from '../src/sim/subjects.js';

registerSystem(governanceSystem);
const subject = (faction, grievance = 'roads') => `petition:${faction}:${grievance}`;
const factions = ['farmers', 'crafters', 'merchants'];
function town() { const s = createState(45); s.docket = []; return s; }
function petition(s, faction, grievance = 'roads') {
  EFFECTS.petition.apply(s, [{subject: {faction}, context: {grievance}, probs: {petition_moot: 0.8}}]);
}
function grouped() {
  const s = town();
  for (const faction of factions) petition(s, faction);
  return [s, s.docket.find((c) => c.data?.grievance === 'roads')];
}

for (const choice of ['hear', 'not_now']) {
  test(`three groups receive one ${choice} ruling and independent petition cooldowns`, () => {
    const [s, card] = grouped();
    assert.equal(s.docket.length, 1);
    assert.equal(card.data.petitioners.length, 3);
    assert.match(card.title, /farmers.*makers.*merchants.*petition the council/i);
    assert.deepEqual(card.subjects, factions.map((f) => subject(f)));
    assert.equal(card.proseRevision, 2, 'each added group invalidates the shared narration');
    assert.deepEqual(card.options.map((o) => o.key), ['hear', 'not_now']);
    const moodsBefore = Object.fromEntries(s.factions.filter((f) => factions.includes(f.id)).map((f) => [f.id, f.mood]));
    const result = rule(s, card.id, choice);
    assert.equal(result.ok, true);
    assert.equal(s.docket.length, 0);
    assert.equal(s.cardHistory.length, 1, 'one council ruling');
    for (const faction of factions) {
      const mood = s.factions.find((f) => f.id === faction).mood;
      const change = choice === 'hear' ? 0.04 : choice === 'refuse' ? -0.05 : 0;
      assert.ok(Math.abs(mood - moodsBefore[faction] - change) < 1e-10, `${faction} receives its ruling effect`);
    }
    const history = s.cardHistory[0];
    assert.deepEqual(history.subjects, factions.map((f) => subject(f)));
    for (const faction of factions) {
      assert.equal(timesAsked(s, subject(faction)), 1);
      assert.ok(subjectBlocked(s, [subject(faction)], {mood: 0.5}), `${faction} waits after ${choice}`);
    }
    if (choice === 'hear') {
      assert.deepEqual(s.deltaLog.filter((d) => d.source === 'card:grievance:roads' && d.key === 'unrest').map((d) => d.amount), [-0.02], 'shared unrest effect is applied once');
    }
    const cooldown = {hear: 8, not_now: 4, refuse: 6}[choice];
    s.time.year += cooldown;
    for (const faction of factions) assert.equal(subjectBlocked(s, [subject(faction)], {mood: 0.5}), null);
    petition(s, 'farmers');
    assert.match(s.docket[0].title, /again$/);
  });
}

test('separate grievances and institution-formation petitions stay separate', () => {
  const s = town();
  petition(s, 'farmers', 'roads');
  petition(s, 'crafters', 'food');
  const forms = makeCard(s, {kind: 'petition', from: 'moot', templateId: 'form:agri-council',
    title: 'Form a council', data: {forms: 'agri-council'}, options: [{key: 'not_now', label: 'Not now'}]});
  addCard(s, forms);
  petition(s, 'merchants', 'roads');
  assert.equal(s.docket.length, 3);
  assert.equal(s.docket.find((c) => c.data?.grievance === 'roads').data.petitioners.length, 2);
  assert.ok(s.docket.some((c) => c.data?.grievance === 'food'));
  assert.ok(s.docket.some((c) => c.data?.forms === 'agri-council'));
});

test('old pending same-grievance cards coalesce on monthly pass and invalidate prose', () => {
  const s = town();
  for (const faction of factions) {
    const card = makeCard(s, {kind: 'petition', from: 'moot', templateId: 'grievance:roads',
      title: `The ${faction} petition the council`, why: `The ${faction} say the lanes are mud. They want to be heard.`,
      data: {faction, grievance: 'roads', mood: faction === 'farmers' ? 0.5 : 0.3},
      helps: [s.factions.find((f) => f.id === faction).trades[0]], options: [
        {key: 'hear', label: 'Hear them', effects: [{deltas: {unrest: -0.02}}]},
        {key: 'not_now', label: 'Not now', effects: []},
      ]});
    card.surfacedMonth = 0; card.expiresMonth = 24;
    s.docket.push(card);
  }
  const keptId = s.docket[0].id;
  setCardProse(s, keptId, {why: 'An old quote.', source: 'llm'});
  docketMonthly(s);
  assert.equal(s.docket.length, 1);
  const card = s.docket[0];
  assert.equal(card.id, keptId);
  assert.equal(card.prose, null);
  assert.equal(card.needsProse, true);
  assert.equal(card.proseRevision, 2);
  assert.equal(card.surfacedMonth, 0);
  assert.deepEqual(card.subjects, factions.map((f) => subject(f)));
  coalesceGrievancePetitions(s);
  assert.equal(card.proseRevision, 2, 'coalescing is idempotent');
  rule(s, card.id, 'not_now');
  assert.deepEqual(s.cardHistory[0].moods, { [subject('farmers')]: 0.5,
    [subject('crafters')]: 0.3, [subject('merchants')]: 0.3 });
  assert.equal(subjectBlocked(s, [subject('farmers')], {mood: 0.25}), null,
    'a petitioner whose mood fell sharply may return early');
  assert.ok(subjectBlocked(s, [subject('crafters')], {mood: 0.25}),
    'another petitioner retains their own mood threshold');
});

test('restoring a saved town coalesces pending petitions before any simulation time passes', () => {
  const s = town();
  const cards = factions.map(faction => {
    const separate = town();
    petition(separate, faction);
    return {...separate.docket[0], id: `saved-${faction}`};
  });
  s.docket = cards;
  governanceSystem.restore(s);
  assert.equal(s.docket.length, 1);
  assert.equal(s.docket[0].id, 'saved-farmers');
  assert.deepEqual(s.docket[0].subjects, factions.map(faction => subject(faction)));
});
