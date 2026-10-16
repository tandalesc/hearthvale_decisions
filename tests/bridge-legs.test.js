// Routes over a bridge join and leave the deck at its ends (people.alongDecks), and
// the legs it adds never cut through a building: a long leg from the street to a
// deck end once ran through the front of the houses beside the approach.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState} from '../src/sim/index.js';
import {alongDecks} from '../src/sim/people.js';
import {footprints, structuralGrid, cellCenter} from '../src/sim/roads.js';
import {findRoute, cellsToWaypoints} from '../src/navigation.js';
import {riverX} from '../src/terrain.js';
import {hashUnit} from '../src/sim/rng.js';

test('bridge legs keep clear of walls across the city', () => {
  const s = fixtureState('city');
  const grid = structuralGrid(s);
  const {blocked} = footprints(s);
  // Trodden open cells on each bank, to route between.
  const banks = [[], []];
  for (let c = 0; c < s.roads.tier.length; c++) {
    if (!s.roads.tier[c] || blocked[c] || !Number.isFinite(grid.cost[c]) || grid.water[c]) continue;
    const {x, z} = cellCenter(c);
    banks[x < riverX(z) ? 0 : 1].push(c);
  }
  assert.ok(banks[0].length && banks[1].length);
  const inWall = (x, z) => {
    const c = Math.floor((z - s.roads.oz) / s.roads.cell) * s.roads.W + Math.floor((x - s.roads.ox) / s.roads.cell);
    return c >= 0 && blocked[c] !== 0;
  };
  let routes = 0;
  for (let k = 0; k < 160; k++) {
    const a = banks[0][Math.floor(hashUnit(k * 2 + 1) * banks[0].length)], b = banks[1][Math.floor(hashUnit(k * 2 + 2) * banks[1].length)];
    const r = findRoute(grid, a, b, {maxNodes: 40000});
    if (!r.cells) continue;
    routes++;
    const route = alongDecks(s, cellsToWaypoints(grid, r.cells, cellCenter(a), cellCenter(b)));
    for (let i = 0; i + 3 < route.length; i += 2) {
      const [x0, z0, x1, z1] = route.slice(i, i + 4);
      const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 10);
      for (let j = 1; j < steps; j++) {
        const x = x0 + ((x1 - x0) * j) / steps, z = z0 + ((z1 - z0) * j) / steps;
        assert.ok(!inWall(x, z), `route ${k}: leg (${x0.toFixed(1)},${z0.toFixed(1)})-(${x1.toFixed(1)},${z1.toFixed(1)}) enters a footprint at (${x.toFixed(2)},${z.toFixed(2)})`);
      }
    }
  }
  assert.ok(routes > 40, `routes planned (${routes})`);
});
