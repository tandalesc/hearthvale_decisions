// Building standards (docs/design/graphics-review.md P3, P2b): foundations on a slope
// cost money and the land has to pay for them, so towns keep to the flat and climb
// only where the land is dear; windmills stand where the wind is, water mills on the river.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, fastForward } from '../src/sim/index.js';
import { proposeSites, lotSlope, scoreLot, siteContext, foundationCost, FREE_DROP, LAND_COIN, WIND_MIN, FOUNDATION_ERA } from '../src/sim/sites.js';
import { placeBuilding, foundationCharge, ERA_COST } from '../src/sim/buildings.js';
import { jobsFor } from '../src/sim/state.js';
import { bankDistance, setTerrainSeed } from '../src/terrain.js';

test('raised foundations cost money: past the free plinth, by drop, cells and era', () => {
  assert.equal(foundationCost(FREE_DROP, 4, 0), 0);
  assert.ok(foundationCost(FREE_DROP + 2, 4, 0) > 1.9 * foundationCost(FREE_DROP + 1, 4, 0));
  assert.ok(foundationCost(2, 9, 0) > foundationCost(2, 4, 0));
  assert.ok(foundationCost(2, 4, 4) < foundationCost(2, 4, 0), 'later builders are better at hillsides');
  const lot = { w: 2, h: 2 };
  const home = { type: 'home', foundation: 'plinth', foundationDrop: 2 };
  assert.equal(foundationCharge(home, lot, 2), Math.round(foundationCost(2, 4, 2) * ERA_COST[2]));
  for (const b of [{ ...home, type: 'farm' }, { ...home, type: 'quarry' }, { ...home, type: 'workshop', variant: 'kiln' }, { ...home, foundation: 'piles' }])
    assert.equal(foundationCharge(b, lot, 2), 0, `${b.type} ${b.variant ?? b.foundation} pays nothing`);
});

test('a hillside is built only where the land pays for its foundations, and the charge is on the project', () => {
  const s = createState(16);
  fastForward(s, 30);
  s.era = 3;
  const sites = proposeSites(s, { type: 'home', count: 40 });
  assert.ok(sites.length > 10);
  const ctx = { ...siteContext(s), target: 0.5, farPull: 0, homeBank: 0 };
  for (const site of sites) {
    const cells = site.w * site.h;
    const cost = foundationCost(lotSlope(site) * Math.max(site.w, site.h) * 2, cells, s.era);
    assert.ok(cost <= site.terms.landValue * LAND_COIN * cells + 1e-6, 'the land covers the foundations');
  }
  // The dearest hillside candidate, scored again as a hamlet would (dearer hillside
  // work): its foundation share grows by the era factor, and past 1 the lot is refused.
  const dear = [...sites].sort((a, b) => b.terms.foundation - a.terms.foundation)[0];
  assert.ok(dear.terms.foundation > 0, 'some candidate stands on a slope');
  s.era = 0;
  const early = scoreLot(s, dear, { type: 'home' }, ctx);
  const share = dear.terms.foundation * FOUNDATION_ERA[0] / FOUNDATION_ERA[3];
  if (share > 1) assert.equal(early, null, 'too dear for a hamlet');
  else assert.ok(Math.abs(early.terms.foundation - share) < 1e-9);
  assert.equal(scoreLot(s, { ...dear }, { type: 'home' }, ctx)?.terms.foundation, early?.terms.foundation, 'pure');
  s.era = 3;
  // Place the steepest candidate: its raised base is charged and recorded.
  const steep = [...sites].sort((a, b) => lotSlope(b) - lotSlope(a))[0];
  const { building, lot, project } = placeBuilding(s, steep, { type: 'home' });
  const charge = foundationCharge(building, lot, s.era);
  if (charge > 0) {
    assert.deepEqual(project.foundation, { cost: charge, drop: building.foundationDrop });
    assert.ok(project.cost >= charge);
  } else assert.equal(project.foundation, undefined);
});

test('a windmill employs a few hands, draws no smoke and stays off the river', () => {
  assert.ok(jobsFor('mill', 1, 'windmill') < jobsFor('mill', 1, 'water-mill'));
  const s = createState(16);    // a valley without a river: every mill is a windmill
  fastForward(s, 60);
  const mills = s.buildings.filter(b => b.type === 'mill');
  for (const b of mills.filter(b => b.variant === 'windmill')) {
    assert.ok(b.wind >= WIND_MIN - 0.05, `exposure ${b.wind}`);
    assert.equal(b.chimney, false);
    assert.ok(!(b.smoke > 0));
    assert.equal(b.foundation, 'plinth');
  }
  for (const b of mills.filter(b => b.variant === 'water-mill')) assert.ok(bankDistance(b.x, b.z) < 14, 'water mills stand by the water');
  setTerrainSeed(null);
});
