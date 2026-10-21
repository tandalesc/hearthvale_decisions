import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStreets, STREET, FOOTWAY_ERA } from '../src/render/streets.js';

// A small grid: '#' built ground, digits road tiers, '.' open ground.
function grid(rows) {
  const H = rows.length, W = rows[0].length;
  const tier = new Uint8Array(W * H), foot = new Uint8Array(W * H);
  rows.forEach((r, z) => [...r].forEach((ch, x) => {
    if (ch === '#') foot[z * W + x] = 255;
    else if (ch !== '.') tier[z * W + x] = Number(ch);
  }));
  return { W, H, tier, foot };
}
const classes = (g, era) => classifyStreets(g.W, g.H, g.tier, g.foot, era, new Uint8Array(g.W * g.H));
const at = (g, out, x, z) => out[z * g.W + x];

test('a worn lane squeezed between buildings becomes an alley, earth then paved', () => {
  const g = grid([
    '..........',
    '..###.....',
    '..###.....',
    '.11111111.',
    '..###.....',
    '..###.....',
    '..........',
  ]);
  const early = classes(g, 1);
  for (const x of [2, 3, 4]) assert.equal(at(g, early, x, 3), STREET.ALLEY, `cell ${x}`);
  // Out in the open the lane is just a lane.
  assert.equal(at(g, early, 8, 3), STREET.NONE);
  const later = classes(g, FOOTWAY_ERA);
  assert.equal(at(g, later, 3, 3), STREET.PAVED_ALLEY);
});

test('a gap between houses that runs through to two streets becomes a passage', () => {
  const g = grid([
    '3333333',
    '.##.##.',
    '.##.##.',
    '.##.##.',
    '3333333',
  ]);
  assert.equal(at(g, classes(g, 1), 3, 2), STREET.NONE, 'not before the town era');
  const out = classes(g, 2);
  for (const z of [1, 2, 3]) assert.equal(at(g, out, 3, z), STREET.ALLEY, `gap cell ${z}`);
  // A dead-end gap (one street only) stays open ground.
  const blind = grid([
    '3333333',
    '.##.##.',
    '.##.##.',
    '.#####.',
    '.......',
  ]);
  assert.equal(at(blind, classes(blind, 2), 3, 1), STREET.NONE);
});

test('made roads get footways along building fronts from the borough era', () => {
  const g = grid([
    '..........',
    '.########.',
    '..........',
    '3333333333',
    '..........',
    '..........',
    '..........',
  ]);
  assert.equal(at(g, classes(g, FOOTWAY_ERA - 1), 4, 2), STREET.NONE);
  const out = classes(g, FOOTWAY_ERA);
  for (let x = 1; x <= 8; x++) assert.equal(at(g, out, x, 2), STREET.FOOTWAY, `front ${x}`);
  // The far side fronts nothing within reach: a verge, not a pavement.
  assert.equal(at(g, out, 4, 5), STREET.NONE);
});

test('fragments are dropped: a lone enclosed cell, a scrap of pavement', () => {
  const g = grid([
    '.....',
    '..#..',
    '.....',
    '.111.',
    '.....',
    '..#..',
    '.....',
  ]);
  const out = classes(g, 2);
  assert.ok(out.every((k) => k === STREET.NONE));
});
