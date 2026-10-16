// Landscaping, aesthetics and parks: the lived-in town.
import test from 'node:test';
import assert from 'node:assert/strict';

import {createState, stepTick, fastForward, serialize, restore, fixtureState} from '../src/sim/index.js';
import {addBuildingRecord} from '../src/sim/state.js';
import {yearlyLandscape, stageOf, lotLevel, landAt, landscapeCounts, ensureLandscape} from '../src/sim/landscape.js';
import {yearlyAesthetics, aestheticComplaints, aestheticPraise, townLooks, looksBand} from '../src/sim/aesthetics.js';
import {parkCandidates, designatePark, yearlyParkReserve, reserveTarget} from '../src/sim/parks.js';
import {validateContext, validateSnapshot, GRIEVANCES} from '../src/sim/decisions/kinds.js';
import {previewQuestions} from '../src/sim/decisions/scheduler.js';
import {TEMPLATES} from '../src/sim/institutions.js';
import {lintText} from '../src/sim/text/voice.js';

test('landscaping stages run forwards with care and backwards with neglect', () => {
  assert.equal(stageOf(-0.5), 'overgrown');
  assert.equal(stageOf(0), 'rough');
  assert.equal(stageOf(0.3), 'mown');
  assert.equal(stageOf(0.6), 'planted');
  assert.equal(stageOf(0.9, 2), 'planted');
  assert.equal(stageOf(0.9, 3), 'formal');

  const s = createState(11);
  const home = s.buildings.find((b) => b.type === 'home');
  home.occupied = true;
  home.wealth = 0.8;
  home.tend = 0;
  home.wild = 0;
  const seen = [];
  for (let y = 0; y < 12; y++) { yearlyLandscape(s); seen.push(lotLevel(home)); }
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), 'a kept garden only grows');
  assert.ok(seen.at(-1) >= 0.4, `planted within twelve years (${seen.at(-1)})`);
  // The family leaves: beds go to grass, then the yard runs wild.
  home.occupied = false;
  for (let y = 0; y < 8; y++) yearlyLandscape(s);
  assert.ok(lotLevel(home) < -0.3, `overgrown after eight empty years (${lotLevel(home)})`);
  assert.ok(home.tend === 0 && home.wild > 0, 'one signed level: tend or wild, never both');
});

test('verges and public land carry a grid level that follows the lots around them', () => {
  const s = fixtureState('town');
  const L = ensureLandscape(s);
  assert.equal(L.level.length, L.W * L.H);
  const counts = landscapeCounts(s);
  assert.ok(counts.mown + counts.planted > 0, `some tended land in a grown town: ${JSON.stringify(counts)}`);
  // A cluster of homes empties: the verge around them slides with the lots.
  const c = s.buildings.find((b) => b.type === 'home' && (b.tend ?? 0) > 0.3);
  const before = landAt(s, c.x, c.z);
  for (const b of s.buildings) if (b.type === 'home' && Math.hypot(b.x - c.x, b.z - c.z) < 20) { b.occupied = false; b.flags.derelict = 1; }
  for (let y = 0; y < 8; y++) yearlyLandscape(s);
  assert.ok(landAt(s, c.x, c.z) < before, `the verge declines with its street (${before} -> ${landAt(s, c.x, c.z)})`);
});

test('eyesores lower a home\'s looks and show up as complaints with the residents affected', () => {
  const s = fixtureState('town');
  yearlyAesthetics(s);
  const home = s.buildings.find((b) => b.type === 'home' && s.households.some((h) => h.homeId === b.id) && (b.looks ?? 0) > 0.4);
  const was = home.looks;
  // A derelict mill next door.
  const ruin = addBuildingRecord(s, {type: 'mill', variant: 'water-mill', x: home.x + 9, z: home.z, w: 8, d: 8, rot: 0, built: 1,
    tier: 1, condition: 0.1, occupied: false, wealth: 0.1, flags: {derelict: 1}, districtId: home.districtId});
  yearlyAesthetics(s, {landscape: false});
  assert.ok(home.looks < was, `looks fall next to a ruin (${was} -> ${home.looks})`);
  const mine = aestheticComplaints(s, {districtId: home.districtId, limit: 20});
  const hit = mine.find((e) => e.what === 'derelict' && e.ref === `b${ruin.id}`);
  assert.ok(hit, 'the ruin is on the district record');
  assert.ok(hit.residents > 0 && hit.severity > 0 && hit.label, JSON.stringify(hit));
  // The record remembers since when.
  s.time.year += 3;
  yearlyAesthetics(s, {landscape: false});
  const again = aestheticComplaints(s, {districtId: home.districtId, limit: 20}).find((e) => e.ref === `b${ruin.id}`);
  assert.equal(again.years, 3);
  assert.ok(Array.isArray(aestheticPraise(s)));
  assert.ok(['shabby', 'plain', 'pleasant'].includes(looksBand(townLooks(s))));
});

test('a park is a natural spot near homes, kept green, and residents value it', () => {
  const s = fixtureState('town');
  yearlyAesthetics(s);
  const [spot] = parkCandidates(s, {limit: 1});
  assert.ok(spot, 'a grown town has a spot worth keeping');
  assert.ok(lintText(spot.title).length === 0 && lintText(spot.why).length === 0, `${spot.title} / ${spot.why}`);
  const near = s.buildings.filter((b) => b.type === 'home' && Math.hypot(b.x - spot.x, b.z - spot.z) < 30 && s.households.some((h) => h.homeId === b.id));
  const before = near.map((b) => b.looks);
  const {building} = designatePark(s, spot, {paid: true});
  assert.equal(building.type, 'park');
  assert.equal(building.flags.wild, 1);
  assert.ok(building.parkName);
  building.built = 1;
  yearlyAesthetics(s);
  const after = near.map((b) => b.looks);
  assert.ok(after.some((v, i) => v > before[i]), 'homes near the park look better');
  assert.ok(!parkCandidates(s, {limit: 4}).some((c) => Math.hypot(c.x - spot.x, c.z - spot.z) < 40), 'not offered again next door');
});

test('Green reserves sets parks aside through the land system', () => {
  const s = fixtureState('town');
  delete s.policies['park-reserve'];
  assert.equal(reserveTarget(s), 0);
  s.policies['park-reserve'] = {level: 3, since: s.time.year};
  const parks = s.buildings.filter((b) => b.type === 'park').length;
  assert.ok(reserveTarget(s) > parks, `the rule asks for more parks (${reserveTarget(s)} > ${parks})`);
  const r = yearlyParkReserve(s);
  assert.ok(r?.ok, 'one spot set aside this year');
  assert.ok(s.chronicle.entries.at(-1).text.includes('green'));
});

test('the green-space template and the eyesores grievance pass the voice and schema checks', () => {
  const t = TEMPLATES['green-space'];
  assert.equal(t.work, 'park');
  for (const text of [t.title, t.why, ...t.options.map((o) => o.tradeoff)]) assert.deepEqual(lintText(text.replace(/\{\w+\}/g, 'the meadow')), []);
  assert.ok(GRIEVANCES.includes('eyesores'));
  assert.equal(validateContext('petition', {faction: 'gentry', mood: 'angry', grievance: 'eyesores', hasBody: 'no'}), null);
  const s = fixtureState('town');
  yearlyAesthetics(s);
  // Every question the scheduler would ask now carries a valid snapshot (looks included).
  for (const q of previewQuestions(s)) {
    assert.equal(validateSnapshot(q.kind, q.snapshot ?? q.state), null, q.kind);
  }
});

test('landscape and looks survive save and restore exactly; older saves get them on load', () => {
  const s = createState(21);
  fastForward(s, 12);
  assert.ok(s.landscape && s.aesthetics, 'kept from the first year');
  const text = serialize(s);
  const r = restore(text);
  assert.equal(serialize(r), text);
  stepTick(s, 60);
  stepTick(r, 60);
  assert.equal(serialize(r), serialize(s));
  // The cached city was saved before landscaping existed.
  const city = fixtureState('city');
  assert.ok(city.landscape?.level?.length > 0 && city.aesthetics?.town > 0);
});
