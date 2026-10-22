import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/terrain.js';
import { ARCHETYPES, archetypeOf } from '../src/waters.js';
import { cellOf, terrainGrid } from '../src/sim/roads.js';
import { footprintBank, floodAt, FLOOD_BAR, FLOOD_TOLERANT } from '../src/sim/sites.js';

const seedFor = (archetype) => {
  for (let s = 1; s < 5000; s++) if (archetypeOf(s) === archetype) return s;
  throw new Error(archetype);
};

// Each archetype's valley grown for decades: no building stands in the water,
// water mills and quays keep to the river (windmills stand where the wind is), and no
// walker stands in deep water.
for (const archetype of ARCHETYPES) {
  test(`${archetype}: buildings keep out of the water, water mills keep to the river, walkers never in the deep`, async () => {
    const { createState, fastForward, stepTick } = await import('../src/sim/index.js');
    const { createRoutePlanner } = await import('../src/route-planner.js');
    const { deckHeightAt } = await import('../src/sim/bridges.js');
    const s = createState(seedFor(archetype));
    assert.equal(T.terrainArchetype(), archetype);
    fastForward(s, archetype === "river" ? 30 : 60);
    assert.ok(s.buildings.length > 20, `the town grew: ${s.buildings.length}`);
    for (const b of s.buildings) {
      if (b.type === 'bridge') continue;
      const fb = footprintBank(b, 0);
      assert.ok(fb.minBankCore > -0.5, `${b.type} ${b.id} stands out of the water (${fb.minBankCore.toFixed(2)})`);
      if ((b.type === 'mill' && b.variant !== 'windmill') || b.type === 'quay') {
        assert.equal(T.nearestWaterKind(fb.nearest.x, fb.nearest.z), T.KIND.RIVER, `${b.type} ${b.id} is on the river`);
      }
    }
    for (const b of s.buildings.filter((b) => b.type === 'bridge')) {
      assert.ok(T.riverOpenAt(b.z), `bridge ${b.id} spans open river`);
      // Cart bridges land clear of the floodplain (or reach as far as they may) and clear the flood.
      if (b.variant === 'footbridge' || !b.a) continue;
      for (const end of [b.a, b.b]) {
        const reach = Math.hypot(end.x - T.riverX(b.z), end.z - b.z);
        assert.ok(T.floodDepthAt(end.x, end.z) <= 0.05 || reach > 55, `bridge ${b.id} end on flood-free ground`);
      }
      assert.ok(b.deckY >= T.waterLevelAt(b.z) + T.FLOOD_RISE[T.KIND.RIVER], `bridge ${b.id} deck clears the flood`);
    }
    // The floodplain: no house where a great flood stands deep, few on it at all.
    const homes = s.buildings.filter((b) => !FLOOD_TOLERANT.has(b.type));
    for (const b of homes) assert.ok(floodAt(s, b.x, b.z) <= FLOOD_BAR, `${b.type} ${b.id} is off the deep floodplain (${floodAt(s, b.x, b.z).toFixed(2)})`);
    const wet = homes.filter((b) => floodAt(s, b.x, b.z) > 0).length;
    assert.ok(wet <= 0.25 * homes.length, `${wet} of ${homes.length} buildings on the floodplain`);

    const routes = createRoutePlanner({ worker: false, clock: () => 0 });
    const { water } = terrainGrid();
    const deep = [];
    for (let tick = 0; tick < 600; tick++) {
      routes.tick(s, 4);
      stepTick(s, 0.1, { routes });
      for (const p of s.people) {
        const i = cellOf(p.x, p.z);
        if (i < 0 || water[i] !== 1) continue;
        if ((s.roads.planned[i] & 2) || deckHeightAt(s, p.x, p.z) != null) continue;
        if (T.bankDistance(p.x, p.z) < -0.5 && deep.length < 3) deep.push({ tick, x: +p.x.toFixed(1), z: +p.z.toFixed(1), kind: T.waterKindAt(p.x, p.z) });
      }
    }
    routes.dispose();
    assert.deepEqual(deep, [], 'nobody stands in deep water');
  });
}

test('cart bridges reach over the flood meadow to dry ground and clear the flood; footbridges stay short', async () => {
  const { crossingAt, bridgeGeometry, deckProfile } = await import('../src/sim/bridges.js');
  const seed = seedFor('river');
  T.setTerrainSeed(seed, 2);
  let longer = 0, checked = 0;
  for (let z = -340; z <= 340; z += 10) {
    if (!T.riverOpenAt(z)) continue;
    const cart = crossingAt(z, 'timber'), foot = crossingAt(z, 'footbridge');
    assert.ok(foot.length <= cart.length + 1e-9, `at ${z} the footbridge is no longer than the cart bridge`);
    for (const end of [cart.a, cart.b]) {
      const reach = Math.hypot(end.x - T.riverX(z), end.z - z);
      assert.ok(T.floodDepthAt(end.x, end.z) <= 0.05 || reach > 55, `at ${z} the cart bridge lands clear of the flood`);
    }
    const g = bridgeGeometry(cart, 'timber');
    assert.ok(g.deckY >= T.waterLevelAt(z) + T.FLOOD_RISE[T.KIND.RIVER], `at ${z} the deck clears the flood`);
    // Ramps no steeper than about 1 in 2 where the span allows.
    const bridge = { ...g, variant: 'timber' };
    const len = cart.length;
    for (let t = 0; t < 0.25; t += 0.01) {
      const rise = Math.abs(deckProfile(bridge, t + 0.01) - deckProfile(bridge, t)) / (len * 0.01);
      if (len > 24) assert.ok(rise < 0.6, `at ${z} ramp slope ${rise.toFixed(2)}`);
    }
    if (cart.length > foot.length + 4) longer++;
    checked++;
  }
  assert.ok(checked > 30 && longer > 0, `${longer} of ${checked} crossings carried over a flood meadow`);
  // Version 1: bridges as they always were.
  T.setTerrainSeed(seed);
  for (let z = -300; z <= 300; z += 50) assert.deepEqual(crossingAt(z, 'timber'), crossingAt(z, 'footbridge'));
});
