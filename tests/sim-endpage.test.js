// The end page (E9): selectEndPage's summary at year 150, sent only while open.
import test from 'node:test';
import assert from 'node:assert/strict';

import {fixtureState, serialize, restore} from '../src/sim/index.js';
import {chronicleYearly, END_YEAR} from '../src/sim/chronicle.js';
import {lintText} from '../src/sim/text/voice.js';
import * as view from '../src/sim/view.js';
import {uiSnapshot} from '../src/sim-snapshot.js';
import {SELECTORS} from '../src/sim-api.js';

// The city fixture, carried to the end of year 150 (the chronicle closes).
function endedTown() {
  const s = fixtureState('city');
  s.time.year = END_YEAR;
  chronicleYearly(s);
  assert.ok(s.chronicle.summary, 'the chronicle closed');
  return s;
}

test('selectEndPage is null until the chronicle closes, then a compact summary', () => {
  const s = fixtureState('city');
  assert.equal(view.selectEndPage(s), null);
  assert.equal(view.selectUnlocks(s).endPage, false);
  const e = endedTown();
  assert.equal(view.selectUnlocks(e).endPage, true);
  const p = view.selectEndPage(e);
  assert.equal(p.year, END_YEAR);
  assert.equal(typeof p.townName, 'string');
  assert.ok(p.townName.length > 0);
  assert.ok(p.arc.length >= 1 && p.arc.every((a) => Number.isFinite(a.year) && typeof a.name === 'string'));
  assert.ok(p.lead.startsWith('It '));
  assert.ok(p.sentences.length >= 3);
  assert.ok(p.highlights.length > 0 && p.highlights.length <= 12);
  for (const h of p.highlights) assert.ok(Number.isFinite(h.year) && typeof h.text === 'string' && h.text);
  // The compass: four axes, each a thinned path of [year, value] in −1..1.
  assert.equal(p.compass.axes.length, 4);
  for (const a of p.compass.axes) {
    assert.ok(a.low && a.high);
    assert.ok(a.points.length >= 2 && a.points.length <= 51);
    for (const [year, v] of a.points) assert.ok(Number.isFinite(year) && v >= -1 && v <= 1);
  }
  assert.ok(p.compass.from <= p.compass.to);
  // The bodies' roll and the ruling tally.
  assert.ok(Array.isArray(p.bodies.founded) && p.bodies.founded.length > 0, 'the city founded bodies');
  assert.ok(p.bodies.founded.every((b) => typeof b.name === 'string' && Number.isFinite(b.year)));
  assert.ok(Array.isArray(p.bodies.dissolved) && Array.isArray(p.bodies.refused));
  for (const k of ['approved', 'refused', 'lapsed', 'total']) assert.ok(Number.isInteger(p.rulings[k]));
  assert.ok(p.rulings.total >= p.rulings.approved + p.rulings.refused);
  // Serialisable, and small enough to post.
  assert.deepEqual(structuredClone(p), p);
  assert.ok(JSON.stringify(p).length < 40_000, `${JSON.stringify(p).length} chars`);
});

test('the end page reads in the house voice', () => {
  const p = view.selectEndPage(endedTown());
  const lines = [p.lead, ...p.sentences, ...p.centres.map((c) => c.line)];
  for (const a of p.compass.axes) lines.push(a.low, a.high);
  for (const text of lines) assert.deepEqual(lintText(text), [], text);
  // The arc line for one, two and many archetypes.
  const s = endedTown();
  s.chronicle.summary.arc = [{year: 0, archetype: 'market-town', name: 'a market town'}];
  assert.equal(view.selectEndPage(s).lead, 'It was a market town from first to last.');
  s.chronicle.summary.arc.push({year: 60, archetype: 'mill', name: 'a mill town'}, {year: 90, archetype: 'port', name: 'a river port'});
  const lead = view.selectEndPage(s).lead;
  assert.equal(lead, 'It began as a market town. Then it became a mill town, then a river port.');
  assert.deepEqual(lintText(lead), []);
  // Long names: as many changes as one short sentence holds.
  s.chronicle.summary.arc = ['a market town', 'a town of scholars', 'a town of commons', 'a town of scholars', 'a town of commons']
    .map((name, i) => ({year: i * 20, name}));
  const long = view.selectEndPage(s).lead;
  assert.deepEqual(lintText(long), [], long);
  assert.match(long, /^It began as a market town\. Then it became .*a town of commons\.$/);
});

test('the end page is sent only while open, and a save keeps it unchanged', () => {
  const s = endedTown();
  const sim = {view: Object.fromEntries(SELECTORS.map((n) => [n, view[n]]))};
  assert.ok(SELECTORS.includes('selectEndPage'));
  assert.equal(uiSnapshot(sim, s, {want: ['chronicle']}).panels.endPage, undefined);
  const open = uiSnapshot(sim, s, {want: ['endpage']}).panels.endPage;
  assert.deepEqual(open, view.selectEndPage(s));
  // Before year 150 the page has nothing to send, open or not.
  assert.equal(uiSnapshot(sim, fixtureState('city'), {want: ['endpage']}).panels.endPage, undefined);
  const back = restore(serialize(s));
  assert.deepEqual(view.selectEndPage(back), view.selectEndPage(s));
});
