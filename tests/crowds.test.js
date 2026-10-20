// Walkers pass through each other on the move, but never stand on top of each other:
// those who stop in sight take standing spots of their own, a full crowd sends the
// rest elsewhere, and on paths each walker keeps to its own side of the centre line.
// Choosing where to go, walkers who mind crowds pick the quieter place.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick, serialize, restore, cellIndex} from '../src/sim/index.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {sendWalker, laneOffset, alongDecks, accessPoint, deckAt, crowdIndex, crowdAt, crowdTolerance, pickQuiet} from '../src/sim/people.js';
import {densityAt} from '../src/sim/density.js';
import {laneFraction, laneReach, crowdPlan} from '../src/sim/people.js';
import {alongBridge} from '../src/sim/bridges.js';
import {halfWidth, wearBucket} from '../src/render/paths.js';

const cellCenterOf = (s, c) => ({x: s.roads.ox + ((c % s.roads.W) + 0.5) * s.roads.cell, z: s.roads.oz + (Math.floor(c / s.roads.W) + 0.5) * s.roads.cell});
import {footprints, walkerGrid, cellOf, routeStillValid} from '../src/sim/roads.js';
import {findRoute, cellsToWaypoints} from '../src/navigation.js';
import {waterAt} from '../src/terrain.js';
import {marketOf} from './town-helpers.js';

const blockedAt = (s, x, z) => {
  const c = cellIndex(s.roads, x, z);
  return c < 0 || footprints(s).blocked[c] !== 0;
};
const standing = (p) => p.task && !p.task.waiting && p.task.seg >= p.task.route.length && !p.indoor;

// A town with two markets: the fixture's own, and the nearest shop turned into one.
function twoMarkets() {
  const s = fixtureState('town');
  const a = marketOf(s);
  assert.ok(a, 'the town has a market');
  let b = null, best = Infinity;
  for (const c of s.buildings) {
    if (c.type !== 'shop' || c.built < 1) continue;
    const d = Math.hypot(c.x - a.x, c.z - a.z);
    if (d < best) { best = d; b = c; }
  }
  assert.ok(b && best < 60, `a shop near the market (${best.toFixed(1)})`);
  b.type = 'market';
  s.buildingsRev = (s.buildingsRev ?? 0) + 1;
  return {s, a, b};
}

// The n walkers nearest the market, all sent to work there (outdoor work: they stay in sight).
function sendCrowd(s, market, n, ctx) {
  const door = accessPoint(market);
  const crowd = s.people.slice().sort((p, q) => Math.hypot(p.x - door.x, p.z - door.z) - Math.hypot(q.x - door.x, q.z - door.z) || p.id - q.id).slice(0, n);
  for (const p of crowd) {
    sendWalker(s, p, 'work', market, ctx);
    p.task.dwellFor = 1e6;
  }
  return new Set(crowd.map((p) => p.id));
}

test('a crowd sent to one market stands apart, off footprints and water; the overflow goes to the other stall or home', () => {
  const {s, a, b} = twoMarkets();
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  const ctx = {services: {routes}};
  const ids = sendCrowd(s, a, 130, ctx);
  const door = accessPoint(a);
  const toB = new Set(), home = new Set(), edge = new Set();
  let checks = 0, maxAtA = 0;
  for (let t = 0; t < 700; t++) {
    routes.tick?.(s);
    stepTick(s, 0.1, {routes});
    for (const p of s.people) {
      if (!ids.has(p.id) || !p.task?.relax) continue;
      if (p.task.kind === 'rest') home.add(p.id);
      else if (p.task.targetId === b.id) toB.add(p.id);
      else if (p.task.targetId === a.id) edge.add(p.id);
    }
    if (t % 25) continue;
    const here = s.people.filter((p) => ids.has(p.id) && standing(p) && p.task.kind === 'work');
    maxAtA = Math.max(maxAtA, here.filter((p) => p.task.targetId === a.id).length);
    for (let i = 0; i < here.length; i++) {
      const p = here[i];
      assert.ok(!blockedAt(s, p.x, p.z), `walker ${p.id} stands in a footprint`);
      assert.ok(!waterAt(p.x, p.z), `walker ${p.id} stands in the water`);
      for (let j = i + 1; j < here.length; j++) {
        const q = here[j], d = Math.hypot(p.x - q.x, p.z - q.z);
        checks++;
        assert.ok(d >= 0.6, `walkers ${p.id} and ${q.id} stand ${d.toFixed(2)} apart`);
      }
    }
  }
  assert.ok(checks > 100, `enough pairs checked (${checks})`);
  assert.ok(maxAtA >= 10, `a crowd formed at the market (${maxAtA})`);
  // The crowd round the first market stays close round its walls (ringSpots' inner reach, 4).
  const plan = crowdPlan(s, 'building', a.id, null, door.x, door.z);
  assert.ok(plan.ring && plan.ring.spots.length > 0);
  for (const p of s.people) {
    if (!(ids.has(p.id) && standing(p) && p.task.targetId === a.id && !p.task.relax)) continue;
    const wall = Math.hypot(Math.max(0, Math.abs(p.x - a.x) - a.w / 2), Math.max(0, Math.abs(p.z - a.z) - a.d / 2));
    assert.ok(wall > 0.3 && wall <= 4 + 1e-6, `walker ${p.id} ${wall.toFixed(2)} from the market's walls`);
  }
  assert.ok(toB.size > 0, `some of the overflow went to the other stall (${toB.size}, edge ${edge.size}, home ${home.size})`);
  assert.ok(toB.size + home.size + edge.size >= 20, `the overflow was relaxed, not squeezed in (${toB.size + home.size + edge.size})`);
});

test('a crowd stands round the attraction itself, facing it, not in a disc round its doorstep', () => {
  const s = fixtureState('town');
  // A monument in the town: the market's footprint turned into one (same
  // walls), in its open square. This needs the fixture's market square: a
  // shop or mill hemmed in by its neighbours gives the crowd nowhere to go round.
  const m = s.buildings.find((b) => b.type === 'market' && (b.built ?? 1) >= 1);
  assert.ok(m, 'the town fixture has a market square (regrow it with one: node src/sim/fixtures/build.js town)');
  m.type = 'monument';
  s.buildingsRev = (s.buildingsRev ?? 0) + 1;
  const door = accessPoint(m);
  const ids = new Set();
  const near = s.people.slice().sort((p, q) => Math.hypot(p.x - door.x, p.z - door.z) - Math.hypot(q.x - door.x, q.z - door.z) || p.id - q.id).slice(0, 30);
  for (const p of near) {
    sendWalker(s, p, 'leisure', m);
    p.task.dwellFor = 1e6;
    p.task.seat = null;   // a crowd at the monument, not on its benches
    ids.add(p.id);
  }
  for (let t = 0; t < 500; t++) stepTick(s, 0.1, {});
  const here = s.people.filter((p) => ids.has(p.id) && standing(p) && p.task.targetId === m.id && !p.task.relax);
  assert.ok(here.length >= 12, `a crowd at the monument (${here.length})`);
  let mx = 0, mz = 0;
  for (const p of here) {
    mx += p.x / here.length;
    mz += p.z / here.length;
    assert.ok(!(Math.abs(p.x - m.x) < m.w / 2 && Math.abs(p.z - m.z) < m.d / 2), `walker ${p.id} inside the monument`);
    assert.ok(!blockedAt(s, p.x, p.z), `walker ${p.id} in a footprint`);
    // Facing the monument.
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    assert.ok(fx * (m.x - p.x) + fz * (m.z - p.z) > 0, `walker ${p.id} faces away from the monument`);
  }
  // Pulled toward the monument, not gathered on the doorstep: the crowd's middle is
  // nearer the monument than the doorstep. (It may lie well to one side, where the
  // ceremony's fan opens onto the square: a fan round the monument's open side, not a
  // disc round its door.)
  const toMonument = Math.hypot(mx - m.x, mz - m.z), toDoor = Math.hypot(mx - door.x, mz - door.z);
  assert.ok(toMonument < toDoor, `crowd middle ${toMonument.toFixed(2)} from the monument, ${toDoor.toFixed(2)} from the doorstep`);
});

test('with one stall only, the overflow stays briefly at the edge or goes home', () => {
  const s = fixtureState('town');
  const a = marketOf(s);
  const ids = sendCrowd(s, a, 120, {});
  let home = 0, edge = 0;
  const seen = new Set();
  for (let t = 0; t < 900; t++) {
    stepTick(s, 0.1, {});
    for (const p of s.people) {
      if (!ids.has(p.id) || !p.task?.relax || seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.task.kind === 'rest') home++;
      else if (p.task.targetId === a.id) { edge++; assert.ok(p.task.dwellFor <= 3); }
      else assert.fail(`walker ${p.id} relaxed to ${p.task.kind} ${p.task.targetId}`);
    }
  }
  assert.ok(home > 0, `some went home (${home}, edge ${edge})`);
});

// Planned routes across the town, both banks, so some cross bridges.
function sampleRoutes(s) {
  // The grid walkers plan on (people.js syncRoute): the structural one with the drawn
  // plinths, steps and wings closed.
  const grid = walkerGrid(s);
  const homes = s.buildings.filter((b) => b.type === 'home' && b.built >= 1);
  const out = [];
  for (let i = 0; i < homes.length && out.length < 40; i += 3) {
    const from = accessPoint(homes[i]), to = accessPoint(homes[(i * 7 + 11) % homes.length]);
    const result = findRoute(grid, cellOf(from.x, from.z), cellOf(to.x, to.z), {maxNodes: 20000});
    if (!result.cells) continue;
    const route = cellsToWaypoints(grid, result.cells, from, to);
    if (route.length >= 6) out.push(Array.from(route));
  }
  return out;
}

test('the side offset keeps walkers off walls, water and bridge decks, and leaves the ends alone', () => {
  const s = fixtureState('town');
  const routes = sampleRoutes(s);
  assert.ok(routes.length >= 20, `routes to test (${routes.length})`);
  let moved = 0, total = 0, onDeckKept = 0, crossing = 0;
  for (const route of routes) {
    const base = alongDecks(s, route.slice());
    if (base.some((v, k) => k % 2 === 0 && deckAt(s, v, base[k + 1]))) crossing++;
    for (let id = 1; id <= 30; id++) {
      const lane = laneOffset(s, id, base.slice());
      assert.equal(lane.length, base.length);
      assert.deepEqual(lane.slice(0, 2), base.slice(0, 2), 'first point kept');
      assert.deepEqual(lane.slice(-2), base.slice(-2), 'last point kept');
      assert.ok(routeStillValid(s, lane, 0), 'no leg through a footprint');
      for (let k = 2; k + 2 < lane.length; k += 2) {
        const x = lane[k], z = lane[k + 1], d = Math.hypot(x - base[k], z - base[k + 1]);
        total++;
        if (deckAt(s, base[k], base[k + 1])) {
          assert.equal(d, 0, 'deck waypoints stay on the deck line');
          onDeckKept++;
        }
        if (d === 0) continue;
        moved++;
        // At most the widest drawn half-width (avenue 1.55) less 0.3, times the corner miter.
        assert.ok(d <= (1.55 - 0.3) * 1.4 + 1e-9, `offset ${d}`);
        assert.ok(!blockedAt(s, x, z), 'offset point in a footprint');
        assert.ok(!waterAt(x, z), 'offset point in the water');
        assert.equal(deckAt(s, x, z), null, 'offset point on a deck');
      }
    }
  }
  assert.ok(moved > total * 0.3, `most interior waypoints are offset (${moved}/${total})`);
  assert.ok(crossing > 0 && onDeckKept > 0, `routes over bridges kept their deck line (${crossing} routes, ${onDeckKept} points)`);
  // Two walkers on one route take different lines.
  const r = routes[0];
  const a = laneOffset(s, 3, alongDecks(s, r.slice())), b = laneOffset(s, 4, alongDecks(s, r.slice()));
  assert.notDeepEqual(a, b);
});

test('walkers on one road spread across most of its drawn width, evenly', () => {
  const s = fixtureState('town');
  const r = s.roads, {blocked} = footprints(s);
  const half = (c) => halfWidth(r.tier[c], wearBucket(r.tier[c], r.wear[c]));
  // A road cell (tier 2+) on a straight run along x or z, open and dry across
  // its width: the widest such road in town (a narrow lane leaves little room).
  let pick = -1, axis = 0;
  for (let c = 0; c < r.tier.length; c++) {
    if (pick >= 0 && half(c) <= half(pick)) continue;
    if (r.tier[c] < 2 || (r.planned[c] & 16)) continue;
    const {x, z} = cellCenterOf(s, c);
    for (const ax of [0, 1]) {
      let ok = true;
      for (const u of [-2, 0, 2]) {
        const [ux, uz] = ax ? [0, u] : [u, 0];
        const e = cellIndex(r, x + ux, z + uz);
        if (e < 0 || r.tier[e] !== r.tier[c]) { ok = false; break; }
        for (const v of [-1.6, -0.8, 0, 0.8, 1.6]) {
          const [vx, vz] = ax ? [v, 0] : [0, v];
          const f = cellIndex(r, x + ux + vx, z + uz + vz);
          if (f < 0 || blocked[f] || waterAt(x + ux + vx, z + uz + vz)) ok = false;
        }
      }
      if (ok) { pick = c; axis = ax; break; }
    }
  }
  assert.ok(pick >= 0, 'a straight open path in town');
  const {x, z} = cellCenterOf(s, pick);
  const reach = laneReach(s, pick, x, z);
  assert.ok(Math.abs(reach - (half(pick) - 0.3)) < 1e-9);
  const shifts = [];
  for (let id = 1; id <= 400; id++) {
    const lane = laneOffset(s, id, axis ? [x, z - 4, x, z, x, z + 4] : [x - 4, z, x, z, x + 4, z]);
    shifts.push(axis ? lane[2] - x : lane[3] - z);
  }
  const lo = Math.min(...shifts), hi = Math.max(...shifts);
  const width = 2 * half(pick);
  assert.ok(hi - lo >= 0.6 * width, `spread ${(hi - lo).toFixed(2)} of a road ${width.toFixed(2)} wide`);
  assert.ok(hi <= half(pick) && lo >= -half(pick), 'everyone stays on the drawn road');
  const outer = shifts.filter((d) => Math.abs(d) > reach / 2).length;
  assert.ok(outer > 400 * 0.4, `the lane fills evenly, not mostly at the centre (${outer} of 400 in the outer half)`);
});

test('bridge crossings keep to the deck and spread across it', () => {
  const s = fixtureState('town');
  const routes = sampleRoutes(s);
  const bridges = s.buildings.filter((b) => b.type === 'bridge' && b.a && b.b && (b.built ?? 1) >= 1);
  let crossings = 0;
  const offs = new Map(bridges.map((b) => [b.id, []]));
  for (const route of routes) {
    for (let id = 1; id <= 60; id++) {
      const lane = alongDecks(s, route.slice(), laneFraction(id));
      for (let k = 0; k + 3 < lane.length; k += 2) {
        const x0 = lane[k], z0 = lane[k + 1], x1 = lane[k + 2], z1 = lane[k + 3];
        for (const b of bridges) {
          const s0 = alongBridge(b, x0, z0), s1 = alongBridge(b, x1, z1);
          // A leg from one end of this deck to the other (allowing for float error at the ends).
          if (!(Math.min(s0.t, s1.t) < 0.02 && Math.max(s0.t, s1.t) > 0.98 && s0.off < 3.5 && s1.off < 3.5)) continue;
          crossings++;
          for (let i = 1; i < 20; i++) {
            const x = x0 + ((x1 - x0) * i) / 20, z = z0 + ((z1 - z0) * i) / 20;
            assert.ok(deckAt(s, x, z), `walker ${id} leaves deck ${b.id} at ${x.toFixed(2)}, ${z.toFixed(2)}`);
          }
          // Parallel to the parapets: the same offset at both ends.
          assert.ok(Math.abs(s0.off - s1.off) < 1e-6, 'a straight line parallel to the deck');
          const dx = b.b.x - b.a.x, dz = b.b.z - b.a.z, L = Math.hypot(dx, dz);
          offs.get(b.id).push(((x0 - b.a.x) * dz - (z0 - b.a.z) * dx) / L);
        }
      }
    }
  }
  assert.ok(crossings > 100, `deck crossings tested (${crossings})`);
  for (const b of bridges) {
    const v = offs.get(b.id);
    if (v.length < 20) continue;
    // The drawn deck's half-width (footbridges are drawn 1.3 wide) less 0.4.
    const half = ((b.style ?? b.variant) === 'footbridge' ? 0.65 : Math.min(3, Math.max(1.2, (b.width ?? b.d ?? 3) / 2))) - 0.4;
    const spread = Math.max(...v) - Math.min(...v);
    assert.ok(spread >= 0.6 * 2 * half, `bridge ${b.id}: crossings spread ${spread.toFixed(2)} of ${(2 * half).toFixed(2)}`);
    assert.ok(Math.max(...v.map(Math.abs)) <= half + 1e-9, `bridge ${b.id}: inside the parapets`);
  }
});

test('a crowded town saved mid-crowd continues exactly like the original', () => {
  const {s, a} = twoMarkets();
  sendCrowd(s, a, 70, {});
  // Save while someone is on the last step to a spot.
  const stepping = () => s.people.some((p) => p.task?.spot && !p.task.waiting && p.task.seg < p.task.route.length);
  for (let t = 0; t < 600 && !(t >= 100 && stepping()); t++) stepTick(s, 0.1, {});
  assert.ok(stepping(), 'a walker stepping to its spot at the save');
  const r = restore(serialize(s));
  for (let t = 0; t < 240; t++) stepTick(s, 0.1, {});
  for (let t = 0; t < 240; t++) stepTick(r, 0.1, {});
  assert.equal(serialize(r), serialize(s));
});

// ---------------------------------------------------------------------------
// Choosing where to go: the quiet one, by taste (crowdTolerance); gatherings exempt.

test('density reads a busy block higher than a quiet one, smoothed over its neighbours', () => {
  const s = fixtureState('town');
  for (const p of s.people) p.indoor = true;
  for (const p of s.people.slice(0, 20)) { p.indoor = false; p.x = 4.5; p.z = 4.5; }
  s.time.tick += 1;   // a new tick: the grid is rebuilt from the state
  assert.equal(densityAt(s, 4, 4), 20 / 4);
  assert.equal(densityAt(s, 12, 4), (20 * 0.5) / 4, 'a neighbouring block reads half');
  assert.equal(densityAt(s, 100, 100), 0);
});

test('with two equal shops and one crowded, low-tolerance walkers pick the quiet one; high-tolerance ones either', () => {
  const s = fixtureState('town');
  const shops = s.buildings.filter((b) => b.type === 'shop' && b.built >= 1);
  let pair = null;
  for (let i = 0; i < shops.length && !pair; i++)
    for (let j = i + 1; j < shops.length && !pair; j++) {
      const d = Math.hypot(shops[i].x - shops[j].x, shops[i].z - shops[j].z);
      if (d > 30 && d < 90) pair = [shops[i], shops[j]];
    }
  assert.ok(pair, 'two shops 30-90 apart');
  const [busy, quiet] = pair;
  // Everyone indoors but a crowd of 30 in the street at the busy shop's door.
  for (const p of s.people) p.indoor = true;
  const door = accessPoint(busy);
  s.people.slice(0, 30).forEach((p, k) => {
    p.indoor = false;
    p.x = door.x + (k % 6) * 0.7 - 1.75;
    p.z = door.z + Math.floor(k / 6) * 0.7 - 1.4;
  });
  crowdIndex(s);
  assert.ok(crowdAt(s, busy) > 5 && crowdAt(s, quiet) < 0.5, `crowds ${crowdAt(s, busy)}, ${crowdAt(s, quiet)}`);
  // A walker halfway between: the same distance to both.
  const mx = (busy.x + quiet.x) / 2, mz = (busy.z + quiet.z) / 2;
  const cands = [busy, quiet].map((b) => ({b, d: (b.x - mx) ** 2 + (b.z - mz) ** 2}));
  const picks = {low: {busy: 0, quiet: 0}, high: {busy: 0, quiet: 0}};
  for (let id = 1; id <= 3000; id++) {
    const p = {id, rev: 1, x: mx, z: mz};
    const tol = crowdTolerance(p, null);
    const band = tol < 0.15 ? 'low' : tol > 0.85 ? 'high' : null;
    if (!band) continue;
    picks[band][pickQuiet(s, p, cands, tol) === busy ? 'busy' : 'quiet']++;
  }
  assert.ok(picks.low.quiet > 100 && picks.low.busy === 0, `low tolerance: ${JSON.stringify(picks.low)}`);
  assert.ok(picks.high.busy > 50 && picks.high.quiet > 50, `high tolerance: ${JSON.stringify(picks.high)}`);
  // Tolerance is stable per walker and nudged by trade.
  const p = {id: 77};
  assert.equal(crowdTolerance(p, null), crowdTolerance(p, null));
  assert.ok(crowdTolerance(p, {trade: 'gentry'}) <= crowdTolerance(p, {trade: 'trade'}));
});

// A festival at the market's door; everyone free to choose.
function festivalTown(strength) {
  const s = fixtureState('town');
  const a = marketOf(s);
  const at = accessPoint(a);
  s.worldEvents.push({id: 'test:festival', kind: 'festival', x: Math.round(at.x), z: Math.round(at.z), radius: 6, strength, t0: 0, t1: 1e9});
  for (const p of s.people) p.task = null;
  return {s, at};
}

test('gatherings still draw a crowd, standing apart', () => {
  const {s, at} = festivalTown(0.95);
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  let most = 0;
  for (let t = 0; t < 500; t++) {
    routes.tick?.(s);
    stepTick(s, 0.1, {routes});
    if (t % 50) continue;
    const here = s.people.filter((p) => standing(p) && p.task.kind === 'gather');
    most = Math.max(most, here.length);
    for (let i = 0; i < here.length; i++)
      for (let j = i + 1; j < here.length; j++) assert.ok(Math.hypot(here[i].x - here[j].x, here[i].z - here[j].z) >= 0.6);
  }
  assert.ok(most >= 30, `a festival crowd (${most} standing at once)`);
  assert.ok(densityAt(s, at.x, at.z) > 3, `the festival is the busy place (${densityAt(s, at.x, at.z)})`);
});

test('a town choosing by crowds, saved mid-festival, continues exactly like the original', () => {
  const {s} = festivalTown(0.8);
  for (let t = 0; t < 137; t++) stepTick(s, 0.1, {});
  const r = restore(serialize(s));
  for (let t = 0; t < 230; t++) stepTick(s, 0.1, {});
  for (let t = 0; t < 230; t++) stepTick(r, 0.1, {});
  assert.equal(serialize(r), serialize(s));
});
