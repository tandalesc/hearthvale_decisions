import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {roleTriples, delex, relex, strayRoles} from '../src/narration-roles.js';
import {narrationTriples} from '../src/narration-features.js';
import {loadNarrationStudent, tokens, detok} from '../src/narration-student.js';
import {studentPath} from '../src/student-families.js';
import {createProseKeeper} from '../src/narrator-client.js';

const card = {
  v: 1, type: 'card', id: 'c1', kind: 'proposal', template: 'build:granary', category: 'food', title: 'A granary',
  year: 31, season: 'autumn', era: 'village', urgency: 0,
  asker: {name: 'Mara Mill', role: 'steward', traits: ['careful', 'fair-minded'], body: 'Agricultural Council'},
  why: 'One bad harvest could empty our stores. A granary would carry us through.',
  trigger: ['food in store is low', 'Cost: 1,654 coin'],
  options: [{key: 'do', label: 'Build a granary', cost: 1654, upkeep: 22, effects: [{act: 'build', what: 'a granary'}], tradeoff: 'Food keeps through a bad year.'},
    {key: 'not_now', label: 'Not now', cost: 0, upkeep: 0, effects: [{act: 'wait', what: 'they ask again later'}], tradeoff: 'The farmers will ask again.'}],
  stances: [{who: 'farmers', where: 'Old Ford', p: 0.75, lean: 'for'}],
};

test('role tokens stand in for names, places and numbers, and come back out', () => {
  const {triples, roles} = roleTriples(narrationTriples(card));
  assert.equal(roles['<asker.name>'], 'Mara Mill');
  assert.equal(roles['<asker.name:first>'], 'Mara');
  assert.equal(roles['<asker.body>'], 'Agricultural Council');
  assert.ok(triples.some(([s, a, v, , t]) => s === 'asker' && a === 'name' && v === '<asker.name>' && t === 'role'));
  const text = 'Mara asks again: the farmers in Old Ford need a granary, and it costs 1,654 coin, says the Agricultural Council.';
  const d = delex(text, roles);
  assert.match(d, /^<asker\.name:first> asks again/);
  assert.ok(!/Old Ford|1,654|Agricultural Council/.test(d), d);
  assert.equal(relex(d, roles), text);
  // A number never rewrites the inside of a role token.
  assert.ok(!/<[^>]*<|>[^<]*>/.test(d.replace(/<[^<>\s]+>/g, '')));
  assert.deepEqual(strayRoles('Ask <stances:9.where> too.', roles), ['<stances:9.where>']);
});

test('relex keeps sentence capitals and a/an right', () => {
  const roles = {'<x>': 'The town crier', '<y>': 'orchard'};
  assert.equal(relex('<x> asks. Now <x> waits for a <y>.', roles), 'The town crier asks. Now the town crier waits for an orchard.');
});

test('student tokens round-trip as the trainer splits them', () => {
  const text = "<asker.name:first>'s granary, at <options:do.cost> coin, isn't cheap.";
  assert.deepEqual(tokens('Croft\'s mill, 12.5 coin.'), ['Croft', "##'s", 'mill', '##,', '12.5', 'coin', '##.']);
  assert.equal(detok(tokens(text)), text);
});

test('student routes: decisions keep their paths, narration has its own directory', () => {
  assert.deepEqual(studentPath('/students/manifest.json'), {family: 'decisions', manifest: true, file: 'manifest.json'});
  assert.deepEqual(studentPath('/api/students/decisions.v7.json'), {family: 'decisions', version: 7, file: 'decisions.v7.json'});
  assert.deepEqual(studentPath('/api/students/narration/manifest'), {family: 'narration', manifest: true, file: 'narration/manifest.json'});
  assert.deepEqual(studentPath('/students/narration/narration.v1.json'), {family: 'narration', version: 1, file: 'narration/narration.v1.json'});
  assert.equal(studentPath('/students/narration.v1.json'), null);
  assert.equal(studentPath('/elsewhere/manifest.json'), null);
});

// The prose keeper's routing, on a real town's first card.
async function route({remote, quote, hosted}) {
  const {fixtureState} = await import('../src/sim/fixtures.js');
  const {cardsNeedingProse} = await import('../src/sim/narrative-facts.js');
  const st = fixtureState('town');
  const id = cardsNeedingProse(st)[0].id;
  const stored = [];
  let calls = 0;
  const k = createProseKeeper({
    remote: () => remote,
    local: async () => quote,
    fetcher: async () => { calls++; return hosted(); },
    actions: (name) => (name === 'setCardProse' ? (_s, cid, prose) => stored.push({id: cid, ...prose}) : null),
  });
  await k.requestCard(st, id);
  return {stored, calls, stats: k.stats()};
}
const confident = {why: 'We ask for this now, while there is time.', confident: true};
const refused = () => new Response('{}', {status: 503});

test('free players get the student\'s quote and never call the hosted narrator', async () => {
  const r = await route({remote: false, quote: confident, hosted: refused});
  assert.equal(r.calls, 0);
  assert.equal(r.stored[0].source, 'student');
  assert.equal(r.stored[0].why, confident.why);
  assert.ok(r.stored[0].options && Object.keys(r.stored[0].options).length, 'options keep the template lines');
});

test('an unsure student leaves template text', async () => {
  const r = await route({remote: false, quote: {...confident, confident: false}, hosted: refused});
  assert.equal(r.stored[0].source, 'template');
});

test('Plus players get the hosted quote, and the student when the hosted one cannot be had', async () => {
  const down = await route({remote: true, quote: confident, hosted: refused});
  assert.equal(down.calls, 1);
  assert.equal(down.stored[0]?.source, 'student', 'the student stands in for a narrator that is down');
  const generic = await route({remote: true, quote: confident, hosted: () => new Response(JSON.stringify({prose: {why: 'We ask this now.', options: {}}, source: 'llm'}))});
  assert.equal(generic.stored[0]?.source, 'student', 'and for a hosted quote the checks refuse');
});

const bundleFile = new URL('../public/students/narration/narration.v1.json', import.meta.url);
test('the shipped narration student reproduces its training run on the fixture', {skip: !existsSync(bundleFile)}, async () => {
  const bundle = JSON.parse(readFileSync(bundleFile, 'utf8'));
  const student = loadNarrationStudent(bundle);
  let same = 0;
  for (const f of bundle.fixture.slice(0, 8)) {
    const {triples, roles} = roleTriples(narrationTriples(f.facts));
    const cands = await student.beam(student.encode(triples, roles), 0);
    if (detok(cands[0].toks.map((i) => student.words[i])) === f.outputs[0]) same++;
  }
  assert.ok(same >= 7, `${same}/8 fixture cards quoted as the trainer did`);
  const q = await student.quote(bundle.fixture[0].facts);
  assert.ok(q === null || (typeof q.why === 'string' && q.quality >= 0 && q.quality <= 1));
});
