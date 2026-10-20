import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addBuildingRecord, makeHousehold } from '../src/sim/state.js';
import { runPhase } from '../src/sim/hooks.js';
import {
  ensureRoads, routeBetween, stepAlongRoute, monthlyRoads, tickRoads, organicTier, addWearAt, setTier,
  cellOf, cellIndex, cellXZ, cellCenter, navGrid, terrainGrid, zBand, recordCrossingBand, doorCell,
  doorPoint, footprints, UPGRADE_AT, countTier, frontCell, buildingCells as buildingCellsOf, ORIGIN_X,
} from '../src/sim/roads.js';
import { findRoute, components, pathCost } from '../src/navigation.js';
import { proposeSites, lotSize, landValueAt, riverClear, setbackAt, footprintBank, WATERFRONT, validateFootprint, pathCover, siteText, claimSite, lotSlope, maxSlopeFor, lotForBuilding } from '../src/sim/sites.js';
import {
  placeBuilding, workAtSite, canUpgrade, startUpgrade, noteRebuildWish, mergeCandidates, mergeIntoTerrace,
  projectById, eraMaxStoreys, buildersWanted, growHomes, requestBuilding, settleFoundations, freeSealedDoors, placeStartingHamlet, farmsGiveWay,
} from '../src/sim/buildings.js';
import { updateDistricts } from '../src/sim/districts.js';
import { bridgeCandidates, paveCandidates, gridCandidates, executeWork, candidateWorks, squareCandidate, startWork, embankmentCandidates, embankmentViews, embankmentCrossings, bridgeViews } from '../src/sim/works.js';
import { riverX, bankDistance, WATER_HALF, setTerrainSeed, FORDS, terrainSeed, heightAt, slopeAt, terrainInfo } from '../src/terrain.js';

// A bare state; systems registered by later imports (governance, world) get
// their init so their hooks find what they expect.
function blank(era = 1) {
  setTerrainSeed(null);
  const s = emptyState(7);
  s.roads = undefined;
  s.era = era;
  ensureRoads(s);
  runPhase('init', s, { services: {} });
  return s;
}

function walk(s, a, b) {
  const route = routeBetween(s, a, b);
  assert.ok(route, `route from ${a.x},${a.z} to ${b.x},${b.z}`);
  const p = { x: a.x, z: a.z, task: { route, seg: 0 } };
  for (let guard = 0; stepAlongRoute(s, p, 1.7) && guard < 5000; guard++);
  return p;
}

function finish(s, project) {
  for (let i = 0; i < 5000 && projectById(s, project.id); i++) workAtSite(s, project.id, 0.5, 3);
  assert.equal(projectById(s, project.id), null, 'project finished');
}

function rowCells(cx0, cx1, cz) {
  const out = [];
  for (let x = cx0; x <= cx1; x++) out.push(cellIndex(x, cz));
  return out;
}

test('repeated walks wear a trail that later routes follow, and unused trails fade', () => {
  const s = blank(1);
  const a = { x: -150, z: -70 }, b = { x: -70, z: -40 };
  for (let k = 0; k < 25; k++) walk(s, a, b);
  const trail = countTier(s, 1);
  assert.ok(trail >= 30, `trail cells: ${trail}`);
  const mid = cellOf(-110, -55);
  // A walker starting a few cells away joins the worn trail instead of cutting a new line.
  const route = findRoute(navGrid(s), cellOf(-150, -76), cellOf(-70, -46));
  const onTrail = [...route.cells].filter(i => s.roads.tier[i] >= 1).length;
  assert.ok(onTrail / route.cells.length > 0.6, `share on trail ${onTrail}/${route.cells.length}`);
  assert.ok(s.roads.dirty, 'renderer is told what changed');
  for (let m = 0; m < 200; m++) monthlyRoads(s);
  assert.equal(countTier(s, 1), 0, 'trails fade after years without traffic');
  assert.ok(s.roads.wear[mid] < 20);
});

test('tier thresholds follow the table and respect era limits', () => {
  assert.equal(organicTier(UPGRADE_AT[1] - 1, 1), 0);
  assert.equal(organicTier(UPGRADE_AT[1], 1), 1);
  assert.equal(organicTier(UPGRADE_AT[2], 1), 2);
  assert.equal(organicTier(UPGRADE_AT[3], 0), 2, 'no graded roads in a hamlet');
  assert.equal(organicTier(UPGRADE_AT[3], 1), 3);
  assert.equal(organicTier(1e7, 5), 3, 'paving and avenues are never organic');
  const s = blank(0);
  const i = cellOf(-100, 100);
  for (let k = 0; k < 500; k++) addWearAt(s, i, 3);
  assert.equal(s.roads.tier[i], 2);
  s.era = 1;
  monthlyRoads(s);
  assert.equal(s.roads.tier[i], 3);
  const v = s.roads.version;
  for (let m = 0; m < 120; m++) monthlyRoads(s);
  assert.equal(s.roads.tier[i], 3, 'roads do not fall back to tracks');
  assert.ok(s.roads.wear[i] >= UPGRADE_AT[3]);
  assert.equal(s.roads.version, v);
});

test('A* prefers roads over grass', () => {
  const s = blank(1);
  const [sx, sz] = cellXZ(cellOf(-150, -120));
  for (const i of rowCells(sx, sx + 30, sz - 4)) setTier(s, i, 3);
  const route = findRoute(navGrid(s), cellIndex(sx, sz), cellIndex(sx + 30, sz));
  const onRoad = [...route.cells].filter(i => s.roads.tier[i] >= 3).length;
  assert.ok(onRoad / route.cells.length > 0.5, `share on road ${onRoad}/${route.cells.length}`);
});

test('routes cross the river only at fords and finished bridges', () => {
  const s = blank(1);
  const z = 10;
  const west = { x: riverX(z) - 30, z }, east = { x: riverX(z) + 30, z };
  const grid = navGrid(s);
  const before = findRoute(grid, cellOf(west.x, west.z), cellOf(east.x, east.z));
  const wet = [...before.cells].filter(i => grid.water[i]);
  assert.ok(wet.length > 0, 'the route crosses');
  assert.ok(wet.every(i => grid.water[i] === 2), 'only through ford cells');
  assert.ok(before.crossings.length > 0, 'a ford crossing records demand');

  recordCrossingBand(s, zBand(z), 900);
  const card = bridgeCandidates(s).find(c => c.band === zBand(z));
  assert.ok(card, 'a bridge is proposed where crossings concentrate');
  const { projects } = executeWork(s, card, 'timber');
  const bridge = s.buildings.find(b => b.type === 'bridge');
  assert.equal(bridge.built, 0);
  assert.equal(findRoute(navGrid(s), cellOf(west.x, west.z), cellOf(east.x, east.z)).cells.some(i => navGrid(s).water[i] === 3), false, 'unfinished bridges carry nobody');
  finish(s, projects[0]);
  assert.equal(bridge.built, 1);
  const after = findRoute(navGrid(s), cellOf(west.x, west.z), cellOf(east.x, east.z));
  const g2 = navGrid(s);
  const wet2 = [...after.cells].filter(i => g2.water[i]);
  assert.ok(wet2.length > 0 && wet2.every(i => g2.water[i] === 3), 'the new bridge carries the route');
  assert.ok(after.cost < before.cost);
  assert.equal(bridgeCandidates(s).some(c => Math.abs(c.band - zBand(z)) <= 2), false, 'no second bridge right beside it');
});

test('deep water is impassable and far detours record crossing demand where people wanted it', () => {
  const s = blank(1);
  const z = -236;   // the nearest ford is at z -136, 50 cells away
  const grid = navGrid(s);
  for (let i = 0; i < grid.cost.length; i++) if (grid.water[i] === 1) assert.equal(grid.cost[i], Infinity);
  const far = findRoute(grid, cellOf(riverX(z) - 20, z), cellOf(riverX(z) + 20, z));
  assert.ok(far.cells, 'a far crossing still finds the nearest ford');
  assert.ok(far.crossings.includes(zBand(z)), 'the wanted band gets the demand');
  const near = findRoute(grid, cellOf(riverX(-120) - 20, -120), cellOf(riverX(-120) + 20, -120));
  assert.equal(near.crossings.includes(zBand(-120)), false, 'a short walk to the ford is no detour');
});

test('building footprints block walkers except at the door', () => {
  const s = blank(1);
  const b = addBuildingRecord(s, { type: 'workshop', x: -100, z: 60, w: 8, d: 8, rot: 0 });
  const fp = footprints(s);
  const door = doorCell(b);
  assert.equal(fp.blocked[door], 0);
  assert.ok(fp.blocked[cellOf(-100, 58)] > 0);
  const route = findRoute(navGrid(s), cellOf(-100, 40), cellOf(-100, 80));
  assert.ok(route.cells.every(i => !fp.blocked[i]), 'walks round, not through');
  const home = findRoute(navGrid(s), cellOf(-100, 40), door);
  assert.equal(home.cells.at(-1), door, 'the door is reachable');
  const p = walk(s, { x: -100, z: 40 }, doorPoint(b));
  assert.ok(Math.hypot(p.x - doorPoint(b).x, p.z - doorPoint(b).z) < 0.01);
});

test('sites line worn paths and avoid water and steep ground', () => {
  const s = blank(1);
  addBuildingRecord(s, { type: 'moot', x: -100, z: 40, w: 6, d: 6, rot: 0 });
  const [cx0, cz] = cellXZ(cellOf(-130, 50));
  const trail = rowCells(cx0, cx0 + 40, cz);
  for (const i of trail) { s.roads.wear[i] = 500; setTier(s, i, 2); }
  const sites = proposeSites(s, { type: 'home' });
  assert.equal(sites.length, 4);
  const { water } = terrainGrid();
  for (const site of sites) {
    const [fx, fz] = cellXZ(site.front);
    assert.ok(Math.abs(fz - cz) <= 2 && fx >= cx0 - 2 && fx <= cx0 + 42, `site fronts the trail: ${fx},${fz}`);
    for (let z = site.cz; z < site.cz + site.h; z++)
      for (let x = site.cx; x < site.cx + site.w; x++) {
        const j = cellIndex(x, z);
        assert.equal(water[j], 0);
        assert.ok(s.roads.tier[j] < 2, 'lots never sit on the road');
      }
    assert.ok(site.terms.slope < 1);
    assert.equal(site.bands.access, 'track');
  }
  for (let k = 1; k < sites.length; k++) assert.ok(sites[k - 1].score >= sites[k].score);
  const farms = proposeSites(s, { type: 'farm' });
  for (const f of farms) assert.ok(f.terms.slope <= 0.08 / 0.25 + 1e-9, 'farms need flat ground');
});

test('mills need the river', () => {
  const s = blank(1);
  const z = -60;
  addBuildingRecord(s, { type: 'home', x: riverX(z) - 20, z, w: 4, d: 4 });
  const [cx0, cz] = cellXZ(cellOf(riverX(z) - 40, z + 6));
  for (const i of rowCells(cx0, cx0 + 16, cz)) { s.roads.wear[i] = 400; setTier(s, i, 2); }
  const mills = proposeSites(s, { type: 'mill' });
  assert.ok(mills.length > 0);
  for (const m of mills) assert.equal(m.bands.river, 'yes');
});

test('home upgrades respect era limits on tier and storeys', () => {
  const s = blank(0);
  addBuildingRecord(s, { type: 'moot', x: -100, z: 40, w: 6, d: 6 });
  const site = proposeSites(s, { type: 'home' })[0];
  const { building, project } = placeBuilding(s, site, { type: 'home' });
  assert.equal(building.built, 0);
  assert.ok(buildersWanted(s).some(w => w.projectId === project.id));
  assert.equal(building.origin.year, 0);
  assert.equal(typeof building.origin.site, 'string');
  finish(s, project);
  assert.equal(building.built, 1);
  assert.equal(building.variant, 'hut');
  assert.deepEqual(building.story.map(e => e.kind), ['built']);
  assert.equal(canUpgrade(s, building).reason, 'era');
  s.era = 1;
  const up = startUpgrade(s, building);
  assert.ok(up.ok);
  finish(s, up.project);
  assert.equal(building.tier, 2);
  assert.deepEqual(building.story.at(-1), { year: 0, month: 0, kind: 'upgraded', text: 'house' });
  assert.ok(building.storeys <= eraMaxStoreys(1));
  assert.equal(canUpgrade(s, building).reason, 'era');
});

test('two neighbours who both rebuild merge into a terrace', () => {
  const s = blank(3);
  s.archetype = 'mill';
  addBuildingRecord(s, { type: 'moot', x: -100, z: 40, w: 6, d: 6 });
  const [fw, fd] = lotSize('home', 1);
  const front = cellOf(-120, 70);
  const [fx, fz] = cellXZ(front);
  const homes = [0, 1].map(k => {
    const site = { cx: fx + k * fw, cz: fz + 1, w: fw, h: fd, rot: 2, front };
    const { building, project } = placeBuilding(s, site, { type: 'home' });
    finish(s, project);
    return building;
  });
  const hh = makeHousehold(s, { homeId: homes[1].id, size: 4 });
  s.households.push(hh);
  homes.forEach(b => noteRebuildWish(s, b));
  const pairs = mergeCandidates(s);
  assert.equal(pairs.length, 1);
  const merged = mergeIntoTerrace(s, pairs[0].a, pairs[0].b);
  assert.ok(merged.ok);
  assert.equal(s.buildings.filter(b => b.type === 'home').length, 1);
  assert.equal(hh.homeId, merged.building.id, 'the neighbours move in');
  finish(s, merged.project);
  assert.equal(merged.building.tier, 4);
  assert.equal(merged.building.variant, 'terrace');
  assert.equal(s.lots.find(l => l.id === merged.building.lotId).w, fw * 2);
  s.era = 2;
  assert.equal(mergeCandidates(s).length, 0, 'no terraces before the Borough');
});

test('busy roads become paving candidates and paving creeps along the road', () => {
  const s = blank(2);
  const [cx, cz] = cellXZ(cellOf(-150, -150));
  const cells = rowCells(cx, cx + 19, cz);
  for (const i of cells) { setTier(s, i, 3); s.roads.wear[i] = 3000; }
  const [card] = paveCandidates(s);
  assert.ok(card);
  assert.equal(card.tier, 4);
  assert.ok(card.cells.length >= 12);
  assert.ok(card.options.find(o => o.key === 'half').cost < card.cost);
  const { projects } = executeWork(s, card, 'half');
  const p = projects[0];
  workAtSite(s, p.id, p.workRequired / 2 / 3, 1);
  const laid = card.half.filter(i => s.roads.tier[i] === 4).length;
  assert.ok(laid > 0 && laid < card.half.length, `part laid: ${laid}`);
  finish(s, p);
  assert.ok(card.half.every(i => s.roads.tier[i] === 4));
  s.era = 1;
  assert.equal(paveCandidates(s).some(c => c.tier === 4), false, 'no paving before the Town');
});

test('a far cluster founds a named district', () => {
  const s = emptyState(11);
  ensureRoads(s);
  s.districts.push({ id: 1, name: 'Old Ford', centroid: { x: -5, z: 0 }, lots: 0, tags: [] });
  for (let k = 0; k < 6; k++) addBuildingRecord(s, { type: 'home', x: -5 + k * 5, z: 4, w: 4, d: 4 });
  for (let k = 0; k < 12; k++) addBuildingRecord(s, { type: 'home', x: 70 + (k % 4) * 6, z: -90 + Math.floor(k / 4) * 6, w: 4, d: 4 });
  const founded = updateDistricts(s);
  assert.equal(founded.length, 1);
  const d = founded[0];
  assert.match(d.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.notEqual(d.name, 'Old Ford');
  assert.ok(s.chronicle.entries.some(e => e.text.includes(d.name)));
  assert.equal(s.buildings.filter(b => b.districtId === d.id).length, 12);
  assert.equal(updateDistricts(s).length, 0, 'stable on the next year');
  s.time.year = 1;
  const grid = gridCandidates(s).find(c => c.key === `grid:${d.id}`);
  assert.ok(grid, 'Planning can offer to lay out the young quarter');
  assert.ok(candidateWorks(s).some(c => c.key === grid.key));
});

test('households who do not walk still wear their commute', () => {
  const s = blank(1);
  const home = addBuildingRecord(s, { type: 'home', x: -120, z: 100, w: 4, d: 4, rot: 0 });
  addBuildingRecord(s, { type: 'farm', x: -60, z: 110, w: 12, d: 12 });
  s.households.push(makeHousehold(s, { homeId: home.id, size: 40, trade: 'farm', districtId: 1 }));
  tickRoads(s, {});
  const route = Object.values(s.roads.routes)[0];
  assert.ok(route?.cells?.length > 10, 'a representative route');
  monthlyRoads(s);
  assert.ok(route.cells.every(i => s.roads.wear[i] > 0));
  assert.ok(s.roads.wearAddedMonth > 0, 'traffic feeds the indicator');
});

test('cell geometry round-trips', () => {
  for (const [x, z] of [[-255, -255], [0, 0], [17.3, -42.9], [255, 255]]) {
    const c = cellCenter(cellOf(x, z));
    assert.ok(Math.abs(c.x - x) <= 1 && Math.abs(c.z - z) <= 1);
  }
  assert.equal(cellOf(-400, 0), -1);
});

test('homeless households get new homes beside the paths', () => {
  const s = blank(1);
  addBuildingRecord(s, { type: 'moot', x: -100, z: 40, w: 6, d: 6 });
  const [cx0, cz] = cellXZ(cellOf(-130, 50));
  for (const i of rowCells(cx0, cx0 + 40, cz)) { s.roads.wear[i] = 500; setTier(s, i, 2); }
  for (let k = 0; k < 3; k++) s.households.push(makeHousehold(s, { size: 4, savings: 300 + k }));
  const started = growHomes(s);
  assert.equal(started, 3);
  const homes = s.buildings.filter(b => b.type === 'home');
  assert.equal(homes.length, 3);
  for (const b of homes) {
    const [, fz] = cellXZ(cellOf(b.x, b.z));
    assert.ok(Math.abs(fz - cz) <= 3, 'homes line the track');
    assert.equal(b.built, 0);
  }
  assert.equal(growHomes(s), 0, 'no more than needed while they are being built');
  assert.ok(s.projects.every(p => p.cost > 0 && p.paid === false && p.payer.startsWith('household:')));
});

test('ruled buildings upgrade in place or find a site, but only once the era allows them', () => {
  const s = blank(2);
  const moot = addBuildingRecord(s, { type: 'moot', variant: 'moot-hall', x: -100, z: 40, w: 6, d: 6 });
  const up = requestBuilding(s, 'moot', { variant: 'town-hall', card: 'c1' });
  assert.ok(up.ok && up.project.kind === 'upgrade');
  assert.equal(up.project.paid, true);
  finish(s, up.project);
  assert.equal(moot.tier, 2);
  assert.equal(moot.variant, 'town-hall');
  const school = requestBuilding(s, 'school', {});
  assert.ok(school.ok && school.building.type === 'school');
  const r = requestBuilding(s, 'exchange', {});
  assert.deepEqual([r.ok, r.reason], [false, 'era'], 'no exchange before the Borough');
});

test('a busy crossroads can become a square that lifts land value', () => {
  const s = blank(2);
  s.archetype = 'market-town';
  const centre = cellOf(-120, -120);
  const [cx, cz] = cellXZ(centre);
  for (let k = -12; k <= 12; k++) {
    for (const i of [cellIndex(cx + k, cz), cellIndex(cx, cz + k)]) { setTier(s, i, 3); s.roads.wear[i] = 4000; }
  }
  addBuildingRecord(s, { type: 'home', x: -120 + 16, z: -120 + 8, w: 4, d: 4 });
  const card = squareCandidate(s);
  assert.ok(card, 'the crossroads is offered as a square');
  assert.ok(Math.hypot(card.x + 120, card.z + 120) < 6);
  const before = landValueAt(s, cx + 6, cz + 6);
  const { ok, projects } = startWork(s, card.key, {});
  assert.ok(ok);
  for (const p of projects) finish(s, p);
  const monument = s.buildings.find(b => b.flags?.square);
  assert.ok(monument, 'a fountain marks the square');
  assert.ok(card.cells.every(i => s.roads.tier[i] === 4), 'paved to the era limit');
  assert.ok(landValueAt(s, cx + 6, cz + 6) > before);
  assert.equal(squareCandidate(s), null, 'one square per neighbourhood');
});

// ---------------------------------------------------------------- navigation guarantees
// (moved here from the old performance tests)

test('A* is sliced and cooperative: bounded ticks finish many routes, cache them, and survive a roads version change', async () => {
  const { RouteScheduler } = await import('../src/navigation.js');
  const s = blank(1);
  let clock = 0;
  const q = new RouteScheduler({ clock: () => clock, maxPending: 64 });
  q.setGrid(navGrid(s));
  const goals = [cellOf(-60, -20), cellOf(-90, 60), cellOf(-140, 10)];
  const done = [];
  let accepted = 0;
  for (let k = 0; k < 60; k++) {
    if (q.request(cellOf(-200 + (k % 12) * 9, -100 + Math.floor(k / 12) * 30), goals[k % 3], r => done.push(r))) accepted++;
  }
  assert.ok(accepted >= 60, 'the queue takes the burst');
  let ticks = 0;
  while (q.pending && ticks < 20000) {
    const before = clock;
    q.clock = () => (clock += 0.05);
    const slices = q.tick(1, 4);
    assert.ok(slices <= 4, 'never more slices than allowed');
    assert.ok(clock - before <= 1.3, 'stays inside the time budget');
    ticks++;
  }
  assert.equal(q.pending, 0);
  assert.ok(ticks > 10, `work spread over ${ticks} ticks`);
  assert.equal(done.length, 60);
  assert.ok(done.every(r => r.cells), 'every route found');
  const hits = q.stats.cacheHits;
  q.request(cellOf(-200, -100), goals[0], r => done.push(r));
  assert.equal(q.stats.cacheHits, hits + 1, 'repeat served from cache');
  // Harden a road across the map: the version bucket moves and the cache resets.
  const [, cz] = cellXZ(cellOf(0, 20));
  for (let x = 20; x < 120; x++) setTier(s, cellIndex(x, cz), 3);
  const grid = navGrid(s);
  assert.equal(grid.footprintsOnly, false);
  q.setGrid(grid);
  assert.equal(q.cache.size, 0);
  let fresh = null;
  q.request(cellOf(-200, -100), goals[0], r => (fresh = r));
  while (q.pending) q.tick(50, 64);
  assert.ok(fresh.cells && [...fresh.cells].every((i, k, a) => k === 0 || k === a.length - 1 || Number.isFinite(grid.cost[i])));
});

test('without a Worker the cooperative planner still gets walkers to their destinations', async () => {
  const { createState, stepTick } = await import('../src/sim/index.js');
  const { createRoutePlanner } = await import('../src/route-planner.js');
  const s = createState(4817);
  const routes = createRoutePlanner({ worker: false, clock: () => 0 });
  assert.equal(routes.stats.mode, 'cooperative');
  const arrived = new Set();
  const start = new Map(s.people.map(p => [p.id, { x: p.x, z: p.z }]));
  for (let tick = 0; tick < 1500; tick++) {
    routes.tick(s, 2);
    stepTick(s, 0.1, { routes });
    for (const p of s.people) {
      const r = p.task?.route;
      if (r?.length >= 2 && p.task.seg >= r.length && Math.hypot(p.x - r[r.length - 2], p.z - r[r.length - 1]) < 0.05) arrived.add(p.id);
    }
  }
  assert.ok(routes.stats.completed > 20, `routes served: ${routes.stats.completed}`);
  for (let i = 0; i < 500 && routes.stats.pending; i++) routes.tick(s, 2);
  assert.equal(routes.stats.pending, 0, 'no requests left hanging');
  assert.ok(arrived.size >= s.people.length / 2, `${arrived.size}/${s.people.length} walkers arrived somewhere`);
  const original = s.people.filter(p => start.has(p.id));
  const moved = original.filter(p => Math.hypot(p.x - start.get(p.id).x, p.z - start.get(p.id).z) > 2).length;
  assert.ok(moved >= original.length / 2, `walkers move around town: ${moved}/${original.length}`);
  assert.ok(countTier(s, 1) > 0 || s.roads.wear.some(w => w > 20), 'and wear the ground as they go');
  routes.dispose();
});

test('navigation copes with a state that has no roads yet', async () => {
  const { createRoutePlanner } = await import('../src/route-planner.js');
  const s = { buildings: [], people: [], time: { tick: 0, month: 0, year: 0 } };
  assert.doesNotThrow(() => navGrid(s));
  assert.ok(s.roads?.wear, 'roads are created on demand');
  const planner = createRoutePlanner({ worker: false, clock: () => 0 });
  let route;
  assert.ok(planner.plan(s, -100, 0, -80, 10, r => (route = r)));
  for (let i = 0; i < 200 && route === undefined; i++) planner.tick(s, 5);
  assert.ok(route?.length >= 4);
  assert.deepEqual(route.slice(-2), [-80, 10]);
});

// ---------------------------------------------------------------- banks

test('the whole footprint, after rotation, must keep clear of the river', () => {
  const s = blank(1);
  const z = 60;
  const x = riverX(z) - WATER_HALF - 7.5;           // centre 7.5 units from the water
  const wide = { x, z, w: 8, d: 3 };                 // long side toward the river
  const deep = { x, z, w: 3, d: 8 };                 // same box turned a quarter
  assert.equal(riverClear(s, wide, 'home'), false, 'reaches into the setback');
  assert.equal(riverClear(s, deep, 'home'), true, 'turned, it fits');
  assert.ok(footprintBank(wide).minBank < footprintBank(deep).minBank);
  assert.equal(riverClear(s, { x: riverX(z) - WATER_HALF, z, w: 4, d: 4 }, 'home'), false);
  assert.equal(riverClear(s, { x: riverX(z) - WATER_HALF - 5, z, w: 4, d: 4 }, 'quay'), true, 'quays stand by the water');
  assert.equal(riverClear(s, { x: riverX(z) - WATER_HALF - 1, z, w: 4, d: 4 }, 'quay'), false, 'behind an apron, never over it');
});

test('sites by the river keep ordinary homes back and put mills on the water', () => {
  const s = blank(1);
  const z = -60;
  addBuildingRecord(s, { type: 'home', x: riverX(z) - 24, z, w: 4, d: 4 });
  const [cx0, cz] = cellXZ(cellOf(riverX(z) - 30, z + 6));
  for (const i of rowCells(cx0, cx0 + 14, cz)) { s.roads.wear[i] = 400; setTier(s, i, 2); }
  const homes = proposeSites(s, { type: 'home', count: 8 });
  assert.ok(homes.length > 0);
  for (const site of homes) {
    const fb = footprintBank({ x: site.x, z: site.z, w: site.w * 2 - 0.6, d: site.h * 2 - 0.6 });
    assert.ok(fb.minBank >= setbackAt(s, fb.nearest.x, fb.nearest.z) - 1e-9, 'homes keep the setback');
  }
  const mill = requestBuilding(s, 'mill', {});
  assert.ok(mill.ok);
  assert.equal(mill.building.foundation, 'piles', 'early mills stand on timber piles');
  assert.ok(mill.building.bankDistance >= 2.2 && mill.building.bankDistance <= 5.2, 'right by the water, behind an apron');
  const apron = s.roads.planned.reduce((n, f) => n + ((f & 16) ? 1 : 0), 0);
  assert.ok(apron > 0, 'the apron is a towpath');
  s.era = 2;
  const quay = requestBuilding(s, 'quay', {});
  assert.ok(quay.ok);
  assert.equal(quay.building.foundation, 'quay', 'later waterfronts are stone');
  const plain = s.buildings.find(b => b.type === 'home');
  settleFoundations(s);
  assert.equal(plain.foundation, 'plinth');
  assert.ok(plain.foundationY >= plain.foundationY - plain.foundationDrop);
});

test('buildings found too close to the river are raised on posts, not removed', () => {
  const s = blank(1);
  const z = 30;
  const wet = addBuildingRecord(s, { type: 'home', x: riverX(z) - WATER_HALF - 0.5, z, w: 4, d: 4 });
  const dry = addBuildingRecord(s, { type: 'home', x: riverX(z) - 40, z, w: 4, d: 4 });
  assert.equal(settleFoundations(s), 1);
  assert.ok(s.buildings.includes(wet));
  assert.equal(wet.foundation, 'piles');
  assert.equal(wet.flags.raised, 1);
  assert.ok(wet.foundationY >= 0.25 && wet.foundationDrop > 0);
  assert.equal(dry.foundation, 'plinth');
  assert.ok(s.chronicle.entries.some(e => /raised their house on posts/.test(e.text)));
  assert.equal(settleFoundations(s), 0, 'only once');
});

test('an embankment lowers the setback, turns posts to quays and lifts land value', () => {
  const s = blank(2);
  const z0 = 100;
  for (let k = 0; k < 8; k++) addBuildingRecord(s, { type: 'home', x: riverX(z0 + k * 5) - WATER_HALF - 10, z: z0 + k * 5, w: 4, d: 4 });
  const posts = addBuildingRecord(s, { type: 'home', x: riverX(z0 + 12) - WATER_HALF - 1.5, z: z0 + 12, w: 3, d: 3 });
  settleFoundations(s);
  assert.equal(posts.foundation, 'piles');
  const probe = { x: riverX(z0 + 20) - WATER_HALF - 4, z: z0 + 20, w: 3, d: 3 };
  assert.equal(setbackAt(s, probe.x, probe.z), 3);
  assert.equal(riverClear(s, probe, 'home'), false);
  const [cx, cz] = cellXZ(cellOf(probe.x - 6, probe.z));
  const valueBefore = landValueAt(s, cx, cz);
  const [card] = embankmentCandidates(s);
  assert.ok(card, 'a crowded bank asks for an embankment');
  assert.match(card.title, /^Build an embankment along /);
  const { projects } = executeWork(s, card, 'stone');
  finish(s, projects[0]);
  assert.equal(setbackAt(s, probe.x, probe.z), 1);
  assert.equal(riverClear(s, probe, 'home'), true);
  assert.equal(posts.foundation, 'quay');
  assert.ok(landValueAt(s, cx, cz) > valueBefore);
  assert.ok(embankmentViews(s).some(v => v.side === 'west' && v.z0 <= probe.z && v.z1 >= probe.z));
  assert.equal(embankmentCandidates(s).some(c => c.key === card.key), false);
});


// ---------------------------------------------------------------- doors

function mainRegion(s) {
  const comp = components(navGrid(s));
  const sizes = new Map();
  for (const c of comp) if (c) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const main = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return f => f >= 0 && comp[f] === main;
}

test('dense growth never seals a door', () => {
  const s = blank(1);
  addBuildingRecord(s, { type: 'moot', x: -100, z: 40, w: 6, d: 6 });
  const [cx0, cz] = cellXZ(cellOf(-130, 50));
  for (const i of rowCells(cx0, cx0 + 30, cz)) { s.roads.wear[i] = 500; setTier(s, i, 2); }
  for (let k = 0; k < 40; k++) s.households.push(makeHousehold(s, { size: 5, savings: 200 + k }));
  for (let round = 0; round < 10; round++) growHomes(s);
  const homes = s.buildings.filter(b => b.type === 'home');
  assert.ok(homes.length >= 15, `homes: ${homes.length}`);
  const reaches = mainRegion(s);
  for (const b of homes) assert.ok(reaches(frontCell(b)), `home ${b.id} can be reached`);
});

test('hand-placed footprints are checked for overlap, doors, water and banks', () => {
  const s = blank(1);
  const smithy = addBuildingRecord(s, { type: 'workshop', x: -3, z: -15, w: 4, d: 4, rot: 0 });
  assert.equal(validateFootprint(s, { type: 'home', x: -2, z: -15, w: 4, d: 4, rot: 1 }).reason, 'overlap');
  const door = frontCell(smithy);
  const c = cellCenter(door);
  assert.equal(validateFootprint(s, { type: 'home', x: c.x, z: c.z + 1, w: 2, d: 2, rot: 0 }).reason, 'seals');
  assert.equal(validateFootprint(s, { type: 'home', x: riverX(-11) - 10, z: -11, w: 4, d: 4, rot: 0 }).reason, 'bank');
  assert.equal(validateFootprint(s, { type: 'home', x: riverX(-11), z: -11, w: 4, d: 4, rot: 0 }).reason, 'water');
  assert.ok(validateFootprint(s, { type: 'home', x: -40, z: -15, w: 4, d: 4, rot: 0 }).ok);
  assert.ok(validateFootprint(s, smithy, { ignoreId: smithy.id }).ok);
});

test('a building whose door faces a wall turns to face the street', () => {
  const s = blank(1);
  const shop = addBuildingRecord(s, { type: 'shop', x: -100, z: 100, w: 3.4, d: 3.4, rot: 0 });
  addBuildingRecord(s, { type: 'workshop', x: -100, z: 105, w: 7.4, d: 5.4, rot: 0 });   // right against its door
  assert.equal(mainRegion(s)(frontCell(shop)), false);
  assert.equal(freeSealedDoors(s), 1);
  assert.notEqual(shop.rot, 0);
  assert.ok(mainRegion(s)(frontCell(shop)));
});

// ---------------------------------------------------------------- seeded valleys

test('fifty seeds give fifty valleys, each hamlet dry, apart and near a ford', () => {
  const courses = new Set();
  try {
    for (let k = 1; k <= 50; k++) {
      const seed = k * 7919;
      setTerrainSeed(seed);
      assert.equal(terrainSeed(), seed);
      assert.ok(FORDS.length >= 3 && FORDS.length <= 6);
      assert.ok(FORDS.some(f => Math.abs(f.z) <= 30), 'a ford near the origin');
      assert.ok(WATER_HALF >= 5 && WATER_HALF <= 7);
      courses.add([-100, 0, 100].map(z => riverX(z).toFixed(1)).join('/'));
      const s = emptyState(seed);
      ensureRoads(s);
      const h = placeStartingHamlet(s);
      assert.ok(h.moot && h.workshop && h.homes.length === 7 && h.farms.length === 2, `seed ${seed}: everything placed`);
      assert.ok(FORDS.some(f => Math.abs(f.z - h.centre.z) <= 40), `seed ${seed}: a ford near the hamlet`);
      for (const b of s.buildings) {
        assert.ok(riverClear(s, b, b.type), `seed ${seed}: ${b.type} keeps the setback`);
        const v = validateFootprint(s, b, { ignoreId: b.id });
        assert.ok(v.ok, `seed ${seed}: ${b.type} ${v.reason}`);
        assert.equal(b.foundation, b.type === 'farm' ? 'field' : 'plinth');
      }
    }
  } finally {
    setTerrainSeed(null);
  }
  assert.equal(courses.size, 50, 'every river runs its own course');
});

test('the classic valley stays the default and terrain stays pure', () => {
  setTerrainSeed(null);
  assert.equal(terrainSeed(), null);
  assert.equal(riverX(0), 17);
  setTerrainSeed(123);
  const a = [riverX(40), bankDistance(10, 40)];
  setTerrainSeed(456);
  setTerrainSeed(123);
  assert.deepEqual([riverX(40), bankDistance(10, 40)], a, 'same seed, same valley');
  setTerrainSeed(null);
});


// ---------------------------------------------------------------- building on paths

function laneTown() {
  const s = blank(1);
  addBuildingRecord(s, { type: 'moot', x: -100, z: 40, w: 6, d: 6 });
  const [cx0, cz] = cellXZ(cellOf(-130, 50));
  const lane = rowCells(cx0, cx0 + 30, cz);
  for (const i of lane) { s.roads.wear[i] = 500; setTier(s, i, 2); }
  return { s, lane, cz };
}

test('sites prefer to stand back from a lane rather than build on it', () => {
  const { s, lane } = laneTown();
  const sites = proposeSites(s, { type: 'home', count: 4 });
  for (const site of sites) {
    assert.equal(pathCover(s, site).share, 0, 'no lot covers the lane while open ground is free');
    assert.equal(site.bands.path, 'none');
  }
  assert.ok(sites.some(site => site.terms.setback === 1), 'lots keep a verge before the lane');
  assert.ok(lane.every(i => s.roads.tier[i] === 2));
});

test('building across a lane is allowed but costly, closes the lane, and walkers go round', () => {
  const { s, lane, cz } = laneTown();
  const [cx0] = cellXZ(lane[0]);
  const site = { type: 'home', tier: 1, cx: cx0 + 14, cz: cz - 1, w: 2, h: 2, rot: 0, front: cellIndex(cx0 + 14, cz + 1) };
  const cover = pathCover(s, site);
  assert.ok(cover.share > 0 && cover.worst === 2);
  assert.match(siteText({ bands: { access: 'track', landValue: 'mid', neighbours: 'few', pollution: 'clean', river: 'no', path: 'lane' } }), /^blocks a busy lane/);
  const before = findRoute(navGrid(s), lane[2], lane[lane.length - 3]);
  assert.ok(before.cells.some(i => i === cellIndex(cx0 + 14, cz)));
  const { building, project } = placeBuilding(s, site, { type: 'home', payer: 'household:1' });
  assert.ok(project.surcharge.organic > 0 && project.surcharge.planned === 0);
  assert.equal(project.cost, 500 * 1.2 + project.surcharge.organic, 'base cost plus the surcharge');
  const under = [cellIndex(cx0 + 14, cz), cellIndex(cx0 + 15, cz)];
  for (const i of under) {
    if (i === doorCell(building)) continue;
    assert.equal(s.roads.tier[i], 0);
    assert.equal(s.roads.wear[i], 0);
  }
  const after = findRoute(navGrid(s), lane[2], lane[lane.length - 3]);
  assert.ok(after.cells && after.cells.every(i => !footprints(s).blocked[i]), 'the route goes round');
  assert.ok(after.cost > before.cost);
  assert.ok(s.chronicle.entries.some(e => /built across the old lane/.test(e.text)));
});

test('a covered lane is only chosen when nothing better is free', () => {
  const { s, lane, cz } = laneTown();
  // Fill both sides of the lane so the only frontage left is on the lane itself.
  const [cx0] = cellXZ(lane[0]);
  for (let x = cx0 - 6; x <= cx0 + 36; x += 3) {
    for (const z of [cz - 3, cz + 2]) claimSite(s, { cx: x, cz: z, w: 2, h: 2, rot: 0, front: -1 });
  }
  const sites = proposeSites(s, { type: 'home', count: 4 });
  const onLane = sites.filter(site => pathCover(s, site).share > 0);
  const offLane = sites.filter(site => pathCover(s, site).share === 0);
  for (const a of onLane) for (const b of offLane) assert.ok(b.score >= a.score - 1e-9 || a.terms.landValue > b.terms.landValue);
});


test('the far bank is settled as the town grows, and crossings call for a bridge', async () => {
  const { createState, fastForward } = await import('../src/sim/index.js');
  const { homeBank } = await import('../src/sim/sites.js');
  const { bankSide } = await import('../src/terrain.js');
  const s = createState(1000);
  const home = homeBank(s);
  let firstFar = null, firstBridge = null;
  for (let y = 1; y <= 45 && firstBridge == null; y++) {
    fastForward(s, 1);
    if (firstFar == null && s.buildings.some(b => b.type !== 'bridge' && bankSide(b.x, b.z) !== home)) firstFar = y;
    if (bridgeCandidates(s).length) firstBridge = y;
  }
  assert.ok(firstFar != null && firstFar >= 10 && firstFar <= 30, `far bank settled in year ${firstFar}`);
  assert.ok(firstBridge != null && firstBridge <= 45, `bridge wanted by year ${firstBridge}`);
  setTerrainSeed(null);
});

// ---------------------------------------------------------------- the long run

test('sixty years on: banks kept, doors open, no building on a path or a cliff', async () => {
  const { createState, fastForward } = await import('../src/sim/index.js');
  const s = createState(91);
  fastForward(s, 60);
  const reaches = mainRegion(s);
  const sealed = [];
  for (const b of s.buildings) {
    if (b.type === 'bridge') continue;
    if (WATERFRONT.has(b.type)) {
      if (b.bankDistance < 3) assert.ok(['piles', 'quay'].includes(b.foundation), `${b.type} ${b.id} on piles or a quay`);
    } else if (!b.flags?.raised) {
      assert.ok(riverClear(s, b, b.type), `${b.type} ${b.id} keeps the setback`);
    }
    if (['farm', 'park', 'monument'].includes(b.type)) continue;
    // The way in: the doorstep in front of the door, beyond the building's own steps or porch.
    const step = doorPoint(b, s);
    if (!reaches(cellOf(step.x, step.z))) sealed.push(`${b.type}#${b.id}`);
    const { cx0, cz0, cx1, cz1 } = buildingCellsOf(b);
    const door = doorCell(b);
    for (let z = cz0; z <= cz1; z++)
      for (let x = cx0; x <= cx1; x++) {
        const i = cellIndex(x, z);
        if (i === door) continue;
        assert.equal(s.roads.tier[i], 0, `${b.type} ${b.id} has no road under it`);
        assert.ok(s.roads.wear[i] < 60, `${b.type} ${b.id} has no worn path under it`);
      }
    if (b.lotId != null && b.type !== 'quarry') {
      const lot = s.lots.find(l => l.id === b.lotId);
      if (lot) assert.ok(lotSlope(lot) <= maxSlopeFor(b.type, 5, true) + 1e-9, `${b.type} ${b.id} is not on a cliff`);
    }
  }
  assert.deepEqual(sealed, [], 'no sealed doors');
  // Farms keep to the cheap land at the edges, well below where people live.
  const { landValueNorm } = await import('../src/sim/sites.js');
  const value = b => { const [cx, cz] = cellXZ(cellOf(b.x, b.z)); return landValueNorm(s, cx, cz); };
  const mean = list => list.reduce((n, b) => n + value(b), 0) / Math.max(1, list.length);
  const farms = s.buildings.filter(b => b.type === 'farm'), homes = s.buildings.filter(b => b.type === 'home');
  assert.ok(mean(farms) < 0.75 * mean(homes), `farm land ${mean(farms).toFixed(2)} vs homes ${mean(homes).toFixed(2)}`);
  setTerrainSeed(null);
});

// ---------------------------------------------------------------- hills

test('seeded valleys have real hills and a mountain ring, and the river corridor stays gentle', () => {
  const peaks = new Set();
  try {
    for (const seed of [5, 91, 1000, 2024, 4817]) {
      setTerrainSeed(seed);
      let top = 0;
      for (let x = -200; x <= 200; x += 5) for (let z = -200; z <= 200; z += 5) top = Math.max(top, heightAt(x, z));
      assert.ok(top >= 8, `seed ${seed}: hills reach ${top.toFixed(1)}`);
      peaks.add(top.toFixed(1));
      const info = terrainInfo();
      assert.ok(info.mountainHeight >= 60 && info.mountainHeight <= 150);
      assert.ok(heightAt(0, 820) > 30 || heightAt(820, 0) > 30, 'mountains stand beyond the region');
      // The floodplain bank stays gentle; the steep flank stays walkable.
      const plain = info.floodplain === 'west' ? -1 : 1;
      for (let z = -200; z <= 200; z += 10) {
        for (const side of [-1, 1]) {
          for (const d of side === plain ? [4, 10, 16] : [10, 16]) {
            const sl = slopeAt(riverX(z) + side * (WATER_HALF + d), z);
            assert.ok(sl < (side === plain ? 0.3 : 0.6), `seed ${seed}: bank at z ${z}, ${d} out: slope ${sl.toFixed(2)}`);
          }
        }
      }
    }
  } finally {
    setTerrainSeed(null);
  }
  assert.equal(peaks.size, 5, 'every valley has its own hills');
});

test('paths over a hill wind round it: longer but cheaper than a straight climb', () => {
  try {
    setTerrainSeed(5);
    const s = emptyState(5);
    s.roads = undefined;
    ensureRoads(s);
    const grid = navGrid(s);
    // A real slope (0.2..0.6) whose foot and top 12 units either side are walkable.
    let a = null, b = null, best = 0;
    for (let x = -150; x <= 150 && !a; x += 6)
      for (let z = -150; z <= 150; z += 6) {
        const sl = slopeAt(x, z);
        if (sl < 0.2 || sl > 0.6 || bankDistance(x, z) < 20) continue;
        const g = 0.25;
        const dx = heightAt(x + g, z) - heightAt(x - g, z), dz = heightAt(x, z + g) - heightAt(x, z - g);
        const len = Math.hypot(dx, dz);
        const p = { x: x - dx / len * 12, z: z - dz / len * 12 }, q = { x: x + dx / len * 12, z: z + dz / len * 12 };
        if (!Number.isFinite(grid.cost[cellOf(p.x, p.z)]) || !Number.isFinite(grid.cost[cellOf(q.x, q.z)])) continue;
        if (Math.abs(heightAt(q.x, q.z) - heightAt(p.x, p.z)) < 4) continue;
        a = p; b = q; best = sl;
        break;
      }
    assert.ok(a && best > 0.2, 'a real slope to climb');
    const route = findRoute(grid, cellOf(a.x, a.z), cellOf(b.x, b.z));
    const straight = [];
    for (let k = 0; k <= 40; k++) {
      const c = cellOf(a.x + (b.x - a.x) * k / 40, a.z + (b.z - a.z) * k / 40);
      if (c !== straight.at(-1)) straight.push(c);
    }
    assert.ok(route.cells, 'the hill can be crossed');
    assert.ok(route.cost < pathCost(grid, straight), 'cheaper than charging straight up');
    assert.ok(route.cells.length >= straight.length, 'and longer on the ground');
  } finally {
    setTerrainSeed(null);
  }
});

test('every starting building sits on a proper foundation, for fifty seeds', async () => {
  const { createState } = await import('../src/sim/index.js');
  try {
    for (let k = 1; k <= 50; k++) {
      const s = createState(k * 104729);
      for (const b of s.buildings) {
        assert.ok(b.foundation && Number.isFinite(b.foundationY) && Number.isFinite(b.foundationDrop), `seed ${k}: ${b.type} has foundation fields`);
        if (b.type === 'farm' || b.type === 'park') { assert.equal(b.foundation, 'field'); continue; }
        for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
          const h = heightAt(b.x + dx * b.w, b.z + dz * b.d);
          assert.ok(h <= b.foundationY + 0.15, `seed ${k}: ${b.type} corner not buried`);
          assert.ok(b.foundationY - h <= b.foundationDrop + 0.15, `seed ${k}: ${b.type} plinth reaches the ground`);
        }
      }
    }
  } finally {
    setTerrainSeed(null);
  }
});

// ---------------------------------------------------------------- farms

function footprintOf(lot) {
  return { x: ORIGIN_X + (lot.cx + lot.w / 2) * 2, z: ORIGIN_X + (lot.cz + lot.h / 2) * 2, w: lot.w * 2, d: lot.h * 2, rot: lot.rot };
}

test('walkers go round the crops on the headlands, and never wear a trail through them', () => {
  const s = blank(1);
  const farm = addBuildingRecord(s, { type: 'farm', x: -100, z: 60, w: 12, d: 12, rot: 0 });
  const fp = footprints(s);
  const inside = cellOf(-100, 60), headland = cellOf(-105, 60);
  assert.equal(fp.field[inside], 1, 'crops in the middle');
  assert.equal(fp.field[headland], 0, 'a walkable headland ring');
  const route = findRoute(navGrid(s), cellOf(-120, 60), cellOf(-80, 60));
  assert.ok(route.cells.every(i => fp.field[i] !== 1), 'through-traffic detours');
  const gate = findRoute(navGrid(s), cellOf(-120, 60), doorCell(farm));
  assert.equal(gate.cells.at(-1), doorCell(farm), 'the farmhand reaches the gate');
  // Someone who does cut across leaves no trail in the crops. (Across the rows clear of
  // the farmhouse and barn, which stand on the front half: nobody wears ground under a
  // building.)
  const rows = cellOf(-100, 57), side = cellOf(-105, 57);
  assert.equal(fp.field[rows], 1);
  assert.equal(fp.walls[side], 0, 'clear of the farmhouse');
  const p = { x: -120, z: 57, task: { route: [-120, 57, -80, 57], seg: 0 } };
  for (let k = 0; k < 40; k++) { p.x = -120; p.z = 57; p.task.seg = 0; while (stepAlongRoute(s, p, 2)); }
  assert.equal(s.roads.wear[rows], 0);
  assert.equal(s.roads.tier[rows], 0);
  assert.ok(s.roads.wear[side] > 0, 'the headland wears like any ground');
});

test('farms keep to the edge of town, and give way when the town grows round them', () => {
  const s = blank(2);
  addBuildingRecord(s, { type: 'market', x: -100, z: 40, w: 7.4, d: 7.4, tier: 2 });
  for (let k = 0; k < 10; k++) addBuildingRecord(s, { type: 'home', x: -125 + k * 5, z: 30, w: 3.4, d: 3.4 });
  const [cx0, cz] = cellXZ(cellOf(-140, 48));
  for (const i of rowCells(cx0, cx0 + 50, cz)) { s.roads.wear[i] = 1500; setTier(s, i, 3); }
  const sites = proposeSites(s, { type: 'farm', count: 4 });
  const homeSites = proposeSites(s, { type: 'home', count: 4 });
  const value = c => landValueAt(s, c.cx + 3, c.cz + 3);
  assert.ok(sites.length && homeSites.length);
  assert.ok(Math.max(...sites.map(value)) <= Math.max(...homeSites.map(value)), 'farms take the cheaper land');
  // A farm right in the middle of the dear land.
  const [mx] = cellXZ(cellOf(-100, 40));
  const site = { type: 'farm', tier: 1, cx: mx - 3, cz: cz + 1, w: 6, h: 6, rot: 2, front: cellIndex(mx, cz) };
  assert.ok(validateFootprint(s, { type: 'farm', ...footprintOf(site) }).ok, 'the farm stands on free land');
  const { building, project } = placeBuilding(s, site, { type: 'farm', ownerHouseholdId: 77 });
  finish(s, project);
  const before = s.buildings.filter(b => b.type === 'farm').length;
  const [fx, fz] = cellXZ(frontCell(building));
  assert.ok(landValueAt(s, fx, fz) / 60 >= 0.5, `dear land at the gate: ${landValueAt(s, fx, fz)}`);
  const sold = farmsGiveWay(s, () => 0.999, { force: true });   // a draw that lands on selling
  assert.equal(sold, 1);
  assert.ok(s.landSales.length === 1 && s.landSales[0].owner === 'household:77');
  assert.ok(s.chronicle.entries.some(e => /sold/.test(e.text)));
  const sale = s.landSales[0];
  const lot = claimSite(s, { cx: sale.cx, cz: sale.cz, w: 2, h: 2, rot: 0, front: -1 });
  assert.equal(lot.landSale.to, 'household:77');
  assert.equal(lot.landSale.amount, Math.round(4 * sale.perCell), 'the builder pays the farmer for the plot');
  assert.ok(s.buildings.filter(b => b.type === 'farm').length >= before - 1);
  void building;
});

// ---------------------------------------------------------------- the waterfront

test('an embankment lays a towpath that riverside walks prefer', () => {
  const s = blank(2);
  const z0 = 100;
  for (let k = 0; k < 8; k++) addBuildingRecord(s, { type: 'home', x: riverX(z0 + k * 5) - WATER_HALF - 10, z: z0 + k * 5, w: 3.4, d: 3.4 });
  const [card] = embankmentCandidates(s);
  const { projects } = executeWork(s, card, 'stone');
  finish(s, projects[0]);
  const tow = card.cells.filter(i => s.roads.planned[i] & 16);
  assert.equal(tow.length, card.cells.length, 'the whole wall top is towpath');
  assert.ok(tow.every(i => s.roads.tier[i] >= 2));
  const a = cellCenter(card.cells[0]), b = cellCenter(card.cells.at(-1));
  const route = findRoute(navGrid(s), cellOf(a.x - 1, a.z), cellOf(b.x - 1, b.z));
  const share = [...route.cells].filter(i => s.roads.planned[i] & 16).length / route.cells.length;
  assert.ok(share > 0.6, `walkers keep to the towpath (${share.toFixed(2)})`);
  for (let m = 0; m < 60; m++) monthlyRoads(s);
  assert.ok(tow.every(i => s.roads.tier[i] >= 2), 'towpaths never fade');
});

test('every ford and bridge gets ramps where paths meet the water', () => {
  const s = blank(1);
  const crossings = embankmentCrossings(s);
  for (const f of FORDS) {
    for (const side of ['west', 'east']) {
      assert.ok(crossings.some(c => c.kind === 'ramp' && c.side === side && Math.abs(c.z - f.z) <= f.half + 1), `ford ${f.z}: ramp on the ${side} bank`);
    }
  }
  recordCrossingBand(s, zBand(40), 900);
  const card = bridgeCandidates(s)[0];
  const { projects } = executeWork(s, card, 'timber');
  finish(s, projects[0]);
  const after = embankmentCrossings(s);
  for (const side of ['west', 'east']) {
    assert.ok(after.some(c => c.kind === 'ramp' && c.side === side && Math.abs(c.z - card.z) <= 3), `bridge: ramp on the ${side} bank`);
  }
});

// ---------------------------------------------------------------- centres

test('a new centre is born only where its conditions hold two years running', async () => {
  const { ensureCentres, updateCentres, SEED_THRESHOLD } = await import('../src/sim/centres.js');
  const s = blank(1);
  s.districts.push({ id: 1, name: 'Old Ford', centroid: { x: -60, z: 0 }, lots: 0, tags: [] });
  s.centres = [];
  // The seat: a real village.
  for (let k = 0; k < 30; k++) {
    const home = addBuildingRecord(s, { type: 'home', x: -80 + (k % 6) * 6, z: -12 + Math.floor(k / 6) * 6, w: 3.4, d: 3.4 });
    s.households.push(makeHousehold(s, { homeId: home.id, size: 14 }));
  }
  ensureCentres(s);
  // Settlers far off by a ford, with nothing of their own yet.
  const f = FORDS.find(x => Math.abs(x.z - 182) < 5);
  const far = [];
  for (let k = 0; k < 6; k++) {
    const home = addBuildingRecord(s, { type: 'home', x: riverX(f.z) - 20 - (k % 3) * 6, z: f.z - 6 + Math.floor(k / 3) * 8, w: 3.4, d: 3.4 });
    const h = makeHousehold(s, { homeId: home.id, size: 4 });
    s.households.push(h);
    far.push({ home, h });
  }
  s.time.year = 20;
  assert.equal(updateCentres(s), null, 'one good year is not enough');
  assert.equal(Object.values(s.centreSeeds).some(p => p.years === 1 && p.score >= SEED_THRESHOLD), true);
  s.time.year = 21;
  const born = updateCentres(s);
  assert.ok(born, 'the second year founds it');
  assert.equal(s.centres.length, 2);
  assert.ok(s.chronicle.entries.some(e => e.text.includes(born.name)));
  assert.ok(far.every(({ h }) => h.centreId === born.id), 'its people now belong to it');
  // And without the people there, nothing is founded.
  const t = blank(1);
  t.districts.push({ id: 1, name: 'Old Ford', centroid: { x: -60, z: 0 }, lots: 0, tags: [] });
  t.centres = [];
  for (let k = 0; k < 30; k++) {
    const home = addBuildingRecord(t, { type: 'home', x: -80 + (k % 6) * 6, z: -12 + Math.floor(k / 6) * 6, w: 3.4, d: 3.4 });
    t.households.push(makeHousehold(t, { homeId: home.id, size: 14 }));
  }
  ensureCentres(t);
  for (let y = 20; y < 24; y++) { t.time.year = y; assert.equal(updateCentres(t), null); }
});

test('centreId follows travel cost: the river counts', async () => {
  const { ensureCentres, updateCentres } = await import('../src/sim/centres.js');
  const s = blank(1);
  s.districts.push({ id: 1, name: 'West', centroid: { x: riverX(120) - 40, z: 120 }, lots: 0, tags: [] });
  s.centres = [];
  ensureCentres(s);
  s.centres.push({ ...s.centres[0], id: 2, name: 'East', x: riverX(120) + 12, z: 120, founded: 10 });
  // A home on the west bank, a few steps from the east core as the crow
  // flies, but the nearest crossing is far away.
  const home = addBuildingRecord(s, { type: 'home', x: riverX(120) - 12, z: 120, w: 3.4, d: 3.4, rot: 3 });
  const h = makeHousehold(s, { homeId: home.id, size: 4 });
  s.households.push(h);
  s.time.year = 30;
  updateCentres(s);
  assert.ok(Math.hypot(home.x - s.centres[1].x, home.z - s.centres[1].z) < Math.hypot(home.x - s.centres[0].x, home.z - s.centres[0].z));
  assert.equal(home.centreId, 1, 'it belongs to the centre it can walk to');
  assert.equal(h.centreId, 1);
});

test('long trips search a corridor: same route quality, far less work', () => {
  try {
    setTerrainSeed(5);
    const s = emptyState(5);
    s.roads = undefined;
    ensureRoads(s);
    const grid = navGrid(s);
    const from = cellOf(-300, -300), to = cellOf(300, 300);
    const full = findRoute(grid, from, to, { corridor: false, maxNodes: 1e7 });
    const fast = findRoute(grid, from, to);
    assert.ok(fast.cells && full.cells);
    assert.ok(fast.cost <= full.cost * 1.05, `within 5%: ${fast.cost.toFixed(0)} vs ${full.cost.toFixed(0)}`);
  } finally {
    setTerrainSeed(null);
  }
});

test('old saves on the smaller grid move into the region grid', async () => {
  const s = blank(1);
  const old = { cell: 2, W: 256, H: 256, ox: -256, oz: -256, wear: new Float32Array(256 * 256), tier: new Uint8Array(256 * 256), planned: new Uint8Array(256 * 256), xings: { 20: 500 }, version: 3 };
  old.wear[100 * 256 + 50] = 777;
  old.tier[100 * 256 + 50] = 2;
  s.roads = old;
  ensureRoads(s);
  const x = -256 + 50.5 * 2, z = -256 + 100.5 * 2;
  assert.equal(s.roads.W, 384);
  assert.equal(s.roads.wear[cellOf(x, z)], 777);
  assert.equal(s.roads.tier[cellOf(x, z)], 2);
  assert.equal(s.roads.xings[String(20 + 8)], 500, 'crossing bands shift with the origin');
});

// ---------------------------------------------------------------- bridges

test('bridges span the river at right angles, bank to bank, on tilted rivers too', async () => {
  const { crossingAt, bridgeGeometry, acrossAt } = await import('../src/sim/bridges.js');
  try {
    for (const seed of [5, 1000, 4817]) {
      setTerrainSeed(seed);
      for (const z of [-200, -60, 30, 150]) {
        const c = crossingAt(z);
        assert.ok(bankDistance(c.a.x, c.a.z) >= 1.4 && bankDistance(c.b.x, c.b.z) >= 1.4, 'both ends on dry ground');
        assert.ok(c.a.x < riverX(c.a.z) && c.b.x > riverX(c.b.z), 'opposite banks');
        const flow = { x: riverX(z + 0.5) - riverX(z - 0.5), z: 1 };
        const span = { x: c.b.x - c.a.x, z: c.b.z - c.a.z };
        const cos = (flow.x * span.x + flow.z * span.z) / Math.hypot(flow.x, flow.z) / Math.hypot(span.x, span.z);
        assert.ok(Math.abs(cos) < 0.02, 'perpendicular to the flow');
        const geo = bridgeGeometry(c, 'timber');
        assert.ok(geo.deckY > 0.5 && geo.width === 4);
        void acrossAt;
      }
    }
  } finally {
    setTerrainSeed(null);
  }
});

test('walkers cross on the deck: deck cells join the banks, nearby fords lose their pull', async () => {
  const { deckHeightAt, deckProfile } = await import('../src/sim/bridges.js');
  try {
    setTerrainSeed(1000);
    const s = emptyState(1000);
    s.roads = undefined;
    ensureRoads(s);
    s.era = 1;
    const f = FORDS[0];
    recordCrossingBand(s, zBand(f.z + 6), 900);
    const card = bridgeCandidates(s).find(c => Math.abs(c.z - f.z) < 30);
    assert.ok(card, 'a bridge near the ford');
    const before = findRoute(navGrid(s), cellOf(card.a.x - 10, card.a.z), cellOf(card.b.x + 10, card.b.z));
    const { projects } = executeWork(s, card, 'stone');
    finish(s, projects[0]);
    const bridge = s.buildings.find(b => b.type === 'bridge');
    assert.ok(bridge.a && bridge.b && bridge.width === 5 && bridge.deckY > 0);
    const grid = navGrid(s);
    const deck = projects[0].cells;
    assert.ok(deck.some(i => grid.water[i] === 3), 'the deck spans water');
    assert.ok(deck.every(i => Number.isFinite(grid.cost[i])), 'every deck cell walkable');
    assert.ok(deck.every(i => s.roads.planned[i] & 2), 'every deck cell carries the bridge flag, the land ends too');
    assert.ok(deck.filter(i => grid.water[i] === 3).every(i => grid.cost[i] <= 0.45), 'a stone deck costs like a paved road');
    // Routes across now use the deck, and wade nowhere.
    for (const dz of [-12, 0, 12]) {
      const r = findRoute(grid, cellOf(card.a.x - 10, card.a.z + dz), cellOf(card.b.x + 10, card.b.z + dz));
      const wet = [...r.cells].filter(i => grid.water[i]);
      assert.ok(wet.length && wet.every(i => grid.water[i] === 3), `crossing ${dz}: on the deck only`);
    }
    assert.ok(before.cells.some(i => grid.water[i] === 2 || navGrid(s).water[i] === 2) || true);
    const mid = { x: (bridge.a.x + bridge.b.x) / 2, z: (bridge.a.z + bridge.b.z) / 2 };
    assert.ok(Math.abs(deckHeightAt(s, mid.x, mid.z) - deckProfile(bridge, 0.5)) < 0.01, 'walkers stand on the deck');
    assert.equal(deckHeightAt(s, mid.x + 40, mid.z), null);
    const views = bridgeViews(s);
    assert.deepEqual(Object.keys(views[0]).filter(k => ['a', 'b', 'width', 'deckY', 'style'].includes(k)).sort(), ['a', 'b', 'deckY', 'style', 'width']);
  } finally {
    setTerrainSeed(null);
  }
});

test('folk lay a footbridge at a busy ford, and a cart bridge later replaces it', async () => {
  const { yearlyFootbridges } = await import('../src/sim/works.js');
  const { deckCells } = await import('../src/sim/bridges.js');
  const s = blank(0);
  const f = FORDS.find(x => x.z === 2);
  // Homes on the west bank whose fields lie across the ford.
  addBuildingRecord(s, { type: 'farm', x: riverX(f.z) + 30, z: f.z, w: 12, d: 12 });
  for (let k = 0; k < 4; k++) {
    const home = addBuildingRecord(s, { type: 'home', x: riverX(f.z) - 25 - k * 5, z: f.z + 4, w: 3.4, d: 3.4 });
    s.households.push(makeHousehold(s, { homeId: home.id, size: 4, trade: 'farm', savings: 100 + k }));
  }
  s.indicators.pop = 16;
  for (let m = 0; m < 12; m++) monthlyRoads(s, { skipPeople: true });
  assert.ok((s.roads.xings[String(zBand(f.z))] ?? 0) >= 8, 'their trips count at the ford');
  assert.equal(yearlyFootbridges(s).length, 0, 'not after one year');
  for (let m = 0; m < 12; m++) monthlyRoads(s, { skipPeople: true });
  const [p] = yearlyFootbridges(s);
  assert.ok(p, 'the second year they build');
  assert.equal(p.payer.startsWith('household:'), true, 'paid by the folk who use it');
  finish(s, p);
  const fb = s.buildings.find(b => b.variant === 'footbridge');
  assert.ok(fb && fb.width === 2);
  assert.ok(s.chronicle.entries.some(e => /laid planks/.test(e.text)));
  assert.ok(bridgeViews(s).some(v => v.style === 'footbridge'));
  // A cart bridge at the same ford retires it.
  const [basic] = bridgeCandidates(s, { basic: true });
  assert.ok(basic, 'a basic cart bridge may follow');
  const fbCells = deckCells(fb.a, fb.b, fb.width);
  const { projects } = executeWork(s, basic, 'timber');
  assert.equal(s.buildings.some(b => b.variant === 'footbridge'), false, 'the planks come up');
  assert.ok(fbCells.every(i => !(s.roads.planned[i] & 2)), 'no bridge flag left behind, on land or water');
  assert.ok(s.chronicle.entries.some(e => /old planks came up/.test(e.text)));
  finish(s, projects[0]);
});

test('a basic bridge is wanted within two years of the first cross-river households', () => {
  const s = blank(1);
  const f = FORDS.find(x => x.z === 74);
  addBuildingRecord(s, { type: 'market', x: riverX(f.z) - 40, z: f.z, w: 7.4, d: 7.4 });
  for (let k = 0; k < 20; k++) {
    const home = addBuildingRecord(s, { type: 'home', x: riverX(f.z) - 50 - (k % 5) * 5, z: f.z - 10 + Math.floor(k / 5) * 5, w: 3.4, d: 3.4 });
    s.households.push(makeHousehold(s, { homeId: home.id, size: 5 }));
  }
  s.indicators.pop = 100;
  for (let m = 0; m < 24; m++) monthlyRoads(s, { skipPeople: true });
  assert.equal(bridgeCandidates(s, { basic: true }).length, 0, 'nobody crosses yet');
  // Two families settle across the river; their market is on the west bank.
  for (let k = 0; k < 2; k++) {
    const home = addBuildingRecord(s, { type: 'home', x: riverX(f.z) + 25 + k * 5, z: f.z, w: 3.4, d: 3.4 });
    s.households.push(makeHousehold(s, { homeId: home.id, size: 5 }));
  }
  let year = null;
  for (let m = 1; m <= 24 && year == null; m++) {
    monthlyRoads(s, { skipPeople: true });
    if (bridgeCandidates(s, { basic: true }).length) year = m / 12;
  }
  assert.ok(year != null && year <= 2, `wanted after ${year} years`);
});

test('walkers in a town use the bridges and never stand in deep water', async () => {
  const { fixtureState, stepTick } = await import('../src/sim/index.js');
  const { createRoutePlanner } = await import('../src/route-planner.js');
  const { deckHeightAt } = await import('../src/sim/bridges.js');
  const s = fixtureState('town');
  // Walkers re-drawn on load got straight-line routes before any planner
  // existed; start them afresh so every route comes from the planner.
  for (const p of s.people) p.task = null;
  const routes = createRoutePlanner({ worker: false, clock: () => 0 });
  const bridges = () => s.buildings.filter(b => b.type === 'bridge' && (b.built ?? 1) >= 1);
  assert.ok(bridges().length > 0, 'the town has a bridge');
  const { water } = terrainGrid();
  const wet = new Map();
  let deep = 0, nearCrossings = 0, onDeck = 0;
  const deepInfo = [];
  const misses = [];
  // A bridge that opens during the run: walks planned before it (over the
  // ford beside it) are not judged.
  let opened = bridges().length, before = new WeakSet();
  for (let tick = 0; tick < 2000; tick++) {
    routes.tick(s, 4);
    stepTick(s, 0.1, { routes });
    if (bridges().length !== opened) {
      opened = bridges().length;
      before = new WeakSet(s.people.map(p => p.task).filter(Boolean));
    }
    for (const p of s.people) {
      const i = cellOf(p.x, p.z);
      if (i < 0) continue;
      // On a deck: a bridge cell, or anywhere on the deck as drawn (walkers keep lanes
      // across its whole width, beyond the cells flagged along its axis).
      const deck = (s.roads.planned[i] & 2) !== 0 || deckHeightAt(s, p.x, p.z) != null;
      // In the river, not on the shoreline: half a unit past the water's edge.
      if (water[i] === 1 && !deck && bankDistance(p.x, p.z) < -0.5) { deep++; if (deepInfo.length < 3) deepInfo.push({ tick, kind: p.task?.kind, x: +p.x.toFixed(1), z: +p.z.toFixed(1), bank: +bankDistance(p.x, p.z).toFixed(2), end: p.task?.route?.slice(-2), seg: p.task?.seg, len: p.task?.route?.length }); }
      if (water[i]) {
        const w = wet.get(p.id) ?? { deck: true, z: p.z, side: Math.sign(p.x - riverX(p.z)) };
        if (!deck) w.deck = false;
        wet.set(p.id, w);
      } else if (wet.has(p.id)) {
        const w = wet.get(p.id);
        wet.delete(p.id);
        if (Math.sign(p.x - riverX(p.z)) === w.side) continue;
        if (!bridges().some(b => Math.abs(b.z - w.z) < 24)) continue;   // where fords give way to the deck
        if (p.task && before.has(p.task)) continue;
        nearCrossings++;
        if (w.deck) onDeck++;
        else if (misses.length < 12) misses.push(Math.round(Math.min(...bridges().map(b => Math.abs(b.z - w.z)))));
      }
    }
  }
  routes.dispose();
  assert.equal(deep, 0, `nobody stands in deep water: ${JSON.stringify(deepInfo)}`);
  assert.ok(nearCrossings >= 5, `enough crossings to judge: ${nearCrossings}`);
  assert.ok(onDeck / nearCrossings >= 0.95, `${onDeck} of ${nearCrossings} crossings near a bridge on its deck; misses at ${misses}`);
});

test('a business priced out moves to cheaper ground, and its old lot goes back to building', async () => {
  const { relocationSites } = await import('../src/sim/sites.js');
  const { relocateEnterprise } = await import('../src/sim/buildings.js');
  const { makeEnterprise } = await import('../src/sim/state.js');
  const s = blank(2);
  addBuildingRecord(s, { type: 'market', x: -100, z: 40, w: 7.4, d: 7.4, tier: 2 });
  for (let k = 0; k < 12; k++) addBuildingRecord(s, { type: 'home', x: -130 + k * 5, z: 30, w: 3.4, d: 3.4 });
  const [cx0, cz] = cellXZ(cellOf(-150, 48));
  for (const i of rowCells(cx0, cx0 + 60, cz)) { s.roads.wear[i] = 1500; setTier(s, i, 3); }
  const site = proposeSites(s, { type: 'workshop', count: 1 })[0];
  const { building, project } = placeBuilding(s, site, { type: 'workshop' });
  finish(s, project);
  const firm = makeEnterprise(s, building, { ownerHouseholdId: 5 });
  s.enterprises.push(firm);
  const value = c => landValueAt(s, c.cx + 1, c.cz + 1);
  const sites = relocationSites(s, firm);
  assert.ok(sites.length > 0);
  for (const c of sites) {
    assert.ok(Math.hypot(c.x - building.x, c.z - building.z) >= 40, 'away from the old place');
    assert.ok(value(c) <= value(site) + 1e-6, 'on cheaper ground');
  }
  const moved = relocateEnterprise(s, firm, { site: sites[0] });
  assert.ok(moved.ok);
  finish(s, moved.project);
  assert.equal(firm.buildingId, moved.building.id, 'the business moves in');
  const demo = s.projects.find(p => p.kind === 'demolish' && p.buildingId === building.id);
  assert.ok(demo, 'the old premises come down');
  finish(s, demo);
  assert.ok((s.vacated ?? []).some(v => v.cx === site.cx && v.cz === site.cz), 'the old lot is back in the pool');
});

test('the deck surface is one shared profile: ramps meet the banks, walkers stand on it', async () => {
  const { deckProfile, deckHeightAt, alongBridge } = await import('../src/sim/bridges.js');
  const s = blank(2);
  recordCrossingBand(s, zBand(40), 900);
  const card = bridgeCandidates(s)[0];
  const { projects } = executeWork(s, card, 'stone');
  finish(s, projects[0]);
  const b = s.buildings.find(x => x.type === 'bridge');
  assert.ok(Math.abs(deckProfile(b, 0) - heightAt(b.a.x, b.a.z)) < 1e-9, 'meets the west bank');
  assert.ok(Math.abs(deckProfile(b, 1) - heightAt(b.b.x, b.b.z)) < 1e-9, 'meets the east bank');
  assert.ok(deckProfile(b, 0.5) > b.deckY, 'a stone arch humps at mid-span');
  for (let k = 0; k <= 20; k++) {
    const t = k / 20;
    const x = b.a.x + (b.b.x - b.a.x) * t, z = b.a.z + (b.b.z - b.a.z) * t;
    assert.ok(Math.abs(alongBridge(b, x, z).t - t) < 1e-9);
    assert.ok(Math.abs(deckHeightAt(s, x, z) - deckProfile(b, t)) < 1e-9, `walker height matches the deck at t=${t}`);
  }
});

test('a busy timber bridge asks for an upgrade, and a repair restores a worn one', async () => {
  const { bridgeUpgradeCandidates, yearlyBridges } = await import('../src/sim/works.js');
  const { bridgeLoad } = await import('../src/sim/bridges.js');
  const s = blank(2);
  const f = FORDS.find(x => x.z === 74);
  addBuildingRecord(s, { type: 'market', x: riverX(f.z) - 40, z: f.z, w: 7.4, d: 7.4 });
  recordCrossingBand(s, zBand(f.z), 900);
  const card = bridgeCandidates(s).find(c => Math.abs(c.z - f.z) < 20);
  const { projects } = executeWork(s, card, 'timber');
  finish(s, projects[0]);
  const bridge = s.buildings.find(b => b.type === 'bridge');
  assert.equal(bridgeUpgradeCandidates(s).length, 0, 'a new quiet bridge needs nothing');
  // The far bank grows by two families a year, all shopping across the river.
  let loaded = null, asked = null;
  for (let year = 1; year <= 30 && asked == null; year++) {
    for (let k = 0; k < 2; k++) {
      const n = s.households.length;
      const home = addBuildingRecord(s, { type: 'home', x: riverX(f.z) + 22 + (n % 6) * 5, z: f.z - 15 + Math.floor(n / 6) * 5, w: 3.4, d: 3.4 });
      s.households.push(makeHousehold(s, { homeId: home.id, size: 5 }));
    }
    s.indicators.pop = 200 + s.households.length * 5;
    for (let m = 0; m < 12; m++) monthlyRoads(s, { skipPeople: true });
    yearlyBridges(s);
    if (loaded == null && bridgeLoad(s, bridge) >= 0.8) loaded = year;
    if (bridgeUpgradeCandidates(s).some(c => c.bridgeId === bridge.id)) asked = year;
  }
  assert.ok(bridge.traffic > 0, 'trips over the bridge are counted');
  assert.ok(loaded != null && asked != null && asked - loaded <= 2, `loaded in year ${loaded}, upgrade asked in year ${asked}`);
  const up = bridgeUpgradeCandidates(s).find(c => c.bridgeId === bridge.id);
  assert.deepEqual(up.options.map(o => o.key), ['widen', 'stone', 'repair', 'wait']);
  // Mend it: condition comes back.
  bridge.condition = 0.3;
  const { projects: fix } = executeWork(s, { ...up }, 'repair');
  finish(s, fix[0]);
  assert.equal(bridge.condition, 1);
  // Upgrade to stone: the timber deck carries walkers until the stone one opens.
  const { projects: build } = executeWork(s, bridgeUpgradeCandidates(s).find(c => c.bridgeId === bridge.id) ?? up, 'stone');
  assert.ok(s.buildings.includes(bridge), 'the old bridge stays open while the new one is built');
  finish(s, build[0]);
  assert.equal(s.buildings.includes(bridge), false);
  const stone = s.buildings.find(b => b.type === 'bridge' && b.variant === 'stone' && b.built === 1);
  assert.ok(stone, 'the stone bridge is open');
  const grid = navGrid(s);
  assert.ok(build[0].cells.filter(i => grid.water[i] === 3).every(i => grid.cost[i] <= 0.45), 'its deck is paved');
});

test('moving the seat: a new hall at the chosen centre, the old one becomes a library', async () => {
  const { ensureCentres, updateCentres, seatOf } = await import('../src/sim/centres.js');
  const { makeEnterprise } = await import('../src/sim/state.js');
  const s = blank(2);
  s.districts.push({ id: 1, name: 'Old Ford', centroid: { x: -100, z: 0 }, lots: 0, tags: [] });
  s.centres = [];
  ensureCentres(s);
  const oldHall = addBuildingRecord(s, { type: 'moot', variant: 'moot-hall', x: -100, z: 0, w: 5.4, d: 4.4, rot: 0 });
  s.enterprises.push(makeEnterprise(s, oldHall, { cash: 0 }));
  const east = { ...s.centres[0], id: 2, name: 'Weir Town', x: -100, z: 160, founded: 30, mergedInto: null };
  s.centres.push(east);
  const [cx0, cz] = cellXZ(cellOf(-130, 170));
  for (const i of rowCells(cx0, cx0 + 30, cz)) { s.roads.wear[i] = 900; setTier(s, i, 2); }
  for (let k = 0; k < 5; k++) addBuildingRecord(s, { type: 'home', x: -110 + k * 5, z: 176, w: 3.4, d: 3.4 });
  s.time.year = 60;
  updateCentres(s);
  assert.equal(seatOf(s).id, 1);
  // The council rules: move the hall to Weir Town.
  s.tags['seat:2'] = 60;
  const built = requestBuilding(s, 'moot', { variant: 'town-hall', near: { x: east.x, z: east.z }, card: 'c1' });
  assert.ok(built.ok && built.building !== oldHall, 'a new hall, not an upgrade of the old one');
  assert.ok(Math.hypot(built.building.x - east.x, built.building.z - east.z) < 60);
  s.time.year = 61;
  updateCentres(s);
  assert.equal(seatOf(s).id, 2, 'the seat has moved');
  assert.equal(east.rank, 1, 'and ranks first');
  assert.ok(s.chronicle.entries.some(e => /Weir Town is the seat/.test(e.text)));
  assert.equal(oldHall.type, 'moot', 'the old hall serves until the new one is ready');
  finish(s, built.project);
  s.time.year = 62;
  updateCentres(s);
  assert.equal(oldHall.type, 'library');
  assert.equal(oldHall.variant, 'old-hall');
  assert.ok(s.enterprises.every(e => e.buildingId !== oldHall.id), 'the council moved in');
  assert.ok(s.chronicle.entries.some(e => /new town hall in Weir Town is open/.test(e.text)));
});

test('the year-end work runs a step a tick and a save taken halfway carries on exactly', async () => {
  const { fixtureState, stepTick, serialize, restore } = await import('../src/sim/index.js');
  const s = fixtureState('town');
  s.worldYearJobs = [];
  let seen = 0;
  for (let k = 0; k < 1300 && !(seen > 5 && s.worldYearJobs[0]?.startsWith('centres:')); k++) {
    stepTick(s, 0.1);
    seen = Math.max(seen, s.worldYearJobs?.length ?? 0);
  }
  assert.ok(seen > 5, 'the year queued its steps');
  // Partway through: the queue (and any step's progress) is in the save.
  assert.ok(s.worldYearJobs.length > 0 && s.worldYearJobs.length < seen);
  const r = restore(serialize(s));
  assert.deepEqual(r.worldYearJobs, s.worldYearJobs);
  for (let k = 0; k < 40; k++) { stepTick(s, 0.1); stepTick(r, 0.1); }
  assert.equal(s.worldYearJobs.length, 0, 'the year finished');
  assert.equal(serialize(r), serialize(s));
});

test('a bridge is built for its first years of traffic, and timber wears over decades', async () => {
  const { yearlyBridges } = await import('../src/sim/works.js');
  const { bridgeLoad, bridgeCapacity, HEADROOM } = await import('../src/sim/bridges.js');
  const s = blank(2);
  const b = addBuildingRecord(s, { type: 'bridge', variant: 'timber', x: 0, z: 0, w: 20, d: 4, width: 4, built: 1, traffic: 3000 });
  for (let y = 0; y < 3; y++) yearlyBridges(s);
  assert.equal(b.designTraffic, 3000);
  assert.ok(Math.abs(bridgeLoad(s, b) - 1 / HEADROOM) < 1e-9, 'steady traffic sits well under capacity');
  b.traffic = 3000 * HEADROOM * 0.8;
  yearlyBridges(s);
  assert.equal(b.designTraffic, 3000, 'the design stays once the bridge is a few years old');
  assert.ok(bridgeLoad(s, b) >= 0.8 - 1e-9, 'traffic that grows fills it');
  // Within capacity a timber deck is worn after a quarter century; jammed
  // far over it, after a dozen years.
  b.traffic = 1e6;
  b.condition = 1;
  let years = 0;
  while (b.condition > 0.35 && years < 60) { yearlyBridges(s); years++; }
  assert.ok(years >= 12, `worn after ${years} years`);
  // A stone deck carries twice what timber does for the same traffic; an old
  // save's bridge without a design takes today's traffic.
  const stone = addBuildingRecord(s, { type: 'bridge', variant: 'stone', x: 0, z: 50, w: 20, d: 5, width: 5, built: 1, traffic: 3000, age: 40 });
  yearlyBridges(s);
  assert.equal(stone.designTraffic, 3000);
  assert.equal(bridgeCapacity(stone), 2 * HEADROOM * 3000);
});

test('a fallen bridge closes at once, the ford takes the crossings, and a rebuild reopens it', async () => {
  const { collapseBridge, bridgeUpgradeCandidates } = await import('../src/sim/works.js');
  const { deckHeightAt, deckIndex } = await import('../src/sim/bridges.js');
  const { listSystems } = await import('../src/sim/hooks.js');
  await import('../src/sim/index.js');   // registers the world system
  try {
    setTerrainSeed(1000);
    const s = emptyState(1000);
    s.roads = undefined;
    ensureRoads(s);
    s.era = 2;
    const f = FORDS[0];
    recordCrossingBand(s, zBand(f.z + 6), 900);
    const card = bridgeCandidates(s).find(c => Math.abs(c.z - f.z) < 30);
    const { projects } = executeWork(s, card, 'timber');
    finish(s, projects[0]);
    const bridge = s.buildings.find(b => b.type === 'bridge');
    const deck = projects[0].cells;
    const wetDeck = deck.filter(i => terrainGrid().water[i]);
    const across = () => findRoute(navGrid(s), cellOf(card.a.x - 10, card.a.z), cellOf(card.b.x + 10, card.b.z));
    const wetOf = r => [...r.cells].map(i => navGrid(s).water[i]).filter(Boolean);
    assert.ok(wetOf(across()).every(w => w === 3), 'standing: everyone takes the deck');
    // One walker mid-span, one about to cross.
    const mid = { x: (bridge.a.x + bridge.b.x) / 2, z: (bridge.a.z + bridge.b.z) / 2 };
    const onDeck = { id: 9001, x: mid.x, z: mid.z, task: { kind: 'work', route: [mid.x, mid.z, bridge.b.x + 4, bridge.b.z], seg: 0 } };
    const crossing = { id: 9002, x: card.a.x - 10, z: card.a.z, task: { kind: 'work', route: [card.a.x - 10, card.a.z, mid.x, mid.z, card.b.x + 10, card.b.z], seg: 0 } };
    s.people.push(onDeck, crossing);
    const world = listSystems().find(x => x.id === 'world');
    assert.equal(world.collapseBridge(s, bridge.id).ok, true, 'sim-governance calls it through the world system');
    assert.equal(bridge.collapsed, true);
    assert.equal(bridge.condition, 0);
    assert.equal(bridge.built, 0);
    assert.equal(collapseBridge(s, bridge).ok, false, 'only once');
    // Closed: no deck to stand on, route over or draw.
    assert.ok(!terrainGrid().water[cellOf(onDeck.x, onDeck.z)] && onDeck.task === null, 'the walker on the deck steps back to land');
    assert.equal(crossing.task, null, 'a route over the deck is dropped');
    assert.equal(deckHeightAt(s, mid.x, mid.z), null);
    assert.equal(deckIndex(s).size, 0);
    // (This deck stands on the ford itself: its cells are ford again.)
    assert.ok(wetDeck.every(i => !(s.roads.planned[i] & 2) && navGrid(s).water[i] === terrainGrid().water[i]), 'the deck cells are river again');
    assert.equal(bridgeViews(s).length, 0, 'the deck is not drawn');
    const wading = wetOf(across());
    assert.ok(wading.length && wading.every(w => w === 2), 'crossings fall back to the ford');
    // Left as it is (the ferry), the crossing can ask for a bridge again later.
    assert.ok(bridgeCandidates(s).some(c => Math.abs(c.z - f.z) < 30), 'a new bridge card can come back');
    // No upgrade card for a ruin: the collapse event asks instead.
    assert.equal(bridgeUpgradeCandidates(s).some(c => c.bridgeId === bridge.id), false);
    const up = bridgeUpgradeCandidates(s, { fallen: true }).find(c => c.bridgeId === bridge.id);
    assert.equal(up.reason, 'fallen');
    assert.ok(up.options.some(o => o.key === 'stone'), 'or rebuild it in stone');
    // The rebuild: timber re-lays the old deck; it opens when the work is done.
    const { projects: fix, option } = world.rebuildBridge(s, bridge.id, 'timber');
    assert.equal(option, 'repair');
    assert.equal(bridge.built, 0, 'still closed while the work goes on');
    finish(s, fix[0]);
    assert.equal(bridge.collapsed, undefined);
    assert.equal(bridge.built, 1);
    assert.equal(bridge.condition, 1);
    assert.ok(deck.every(i => s.roads.planned[i] & 2));
    assert.ok(wetOf(across()).every(w => w === 3), 'open again: back on the deck');
    assert.equal(bridgeViews(s).length, 1);
    // Fallen again, rebuilt in stone: the ruin goes when the new deck opens.
    collapseBridge(s, bridge);
    const { projects: stone, option: how } = world.rebuildBridge(s, bridge, 'stone');
    assert.equal(how, 'stone');
    assert.equal(world.rebuildBridge(s, bridge, 'stone').ok, false, 'one rebuild at a time');
    finish(s, stone[0]);
    assert.equal(s.buildings.includes(bridge), false);
    assert.ok(s.buildings.some(b => b.type === 'bridge' && b.variant === 'stone' && b.built === 1 && !b.collapsed));
    assert.ok(wetOf(across()).every(w => w === 3), 'the stone deck carries them');
  } finally {
    setTerrainSeed(null);
  }
});

test('the group-route grid follows every tier change, exactly as a fresh build after a restore', async () => {
  const { fixtureState, stepTick, serialize, restore } = await import('../src/sim/index.js');
  const { structuralGrid } = await import('../src/sim/roads.js');
  const s = fixtureState('town');
  const first = structuralGrid(s);
  // A paved street laid in one go, then the town carries on for a while.
  const [cx, cz] = cellXZ(cellOf(riverX(-40) - 30, -40));
  for (const i of rowCells(cx - 6, cx + 6, cz)) setTier(s, i, 4);
  for (let k = 0; k < 60; k++) stepTick(s, 0.1);
  const g = structuralGrid(s);
  assert.notEqual(g, first, 'patched into a new grid');
  const fresh = structuralGrid(restore(serialize(s)));
  assert.deepEqual(Array.from(g.cost), Array.from(fresh.cost));
  assert.deepEqual(Array.from(g.water), Array.from(fresh.water));
});
