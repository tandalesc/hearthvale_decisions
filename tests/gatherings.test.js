// Gatherings arrange themselves by the place and the occasion (src/sim/gatherings.js):
// a fan facing the focus on its open side at a ceremony, conversation groups at a
// market or festival, visitors spread over a park by its appeal, a tight press at a
// protest. Family pull together; nobody stands on anyone; every spot is walkable; the
// same town plays out the same way, saved or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick, serialize, restore, cellIndex} from '../src/sim/index.js';
import {sendWalker, joinGathering, deckAt, crowdIndex, ACTION} from '../src/sim/people.js';
import {gatheringActivity, occasionFor, SPOT_STRIDE, parkTrees, pathDistance, ACTIVITIES, preference, lineSpots} from '../src/sim/gatherings.js';
import {parkCandidates, designatePark} from '../src/sim/parks.js';
import {parkPlanting} from '../src/render/trees.js';
import {footprints} from '../src/sim/roads.js';
import {waterAt, bankDistance} from '../src/terrain.js';
import {marketOf} from './town-helpers.js';

const standing = (p) => p.task && !p.task.waiting && p.task.seg >= p.task.route.length && !p.indoor;
const blockedAt = (s, x, z) => {
  const c = cellIndex(s.roads, x, z);
  return c < 0 || footprints(s).blocked[c] !== 0;
};
const walkable = (s, x, z) => !blockedAt(s, x, z) && !waterAt(x, z) && !deckAt(s, x, z);
const nearestTo = (s, x, z, n) => s.people.slice().sort((p, q) => Math.hypot(p.x - x, p.z - z) - Math.hypot(q.x - x, q.z - z) || p.id - q.id).slice(0, n);
const run = (s, ticks) => { for (let t = 0; t < ticks; t++) stepTick(s, 0.1, {}); };

// An occasion of the given kind at a building, with the n walkers nearest it sent there.
function eventAt(fixture, type, kind, n, {radius = 10, strength = 0.9} = {}) {
  const s = fixtureState(fixture);
  const b = type === 'market' ? marketOf(s) : s.buildings.find((c) => c.type === type && (c.built ?? 1) >= 1);
  assert.ok(b, `a ${type} in the ${fixture}`);
  const ev = {id: `test:${kind}`, kind, x: Math.round(b.x), z: Math.round(b.z), radius, strength, t0: 0, t1: 1e9};
  s.worldEvents.push(ev);
  const crowd = nearestTo(s, b.x, b.z, n);
  // The grown town's own claims go with the tasks they replace.
  for (const p of crowd) p.task = null;
  crowdIndex(s);
  for (const p of crowd) {
    joinGathering(s, p, ev);
    p.task.dwellFor = 1e6;
  }
  return {s, b, ev, ids: new Set(crowd.map((p) => p.id))};
}

// A finished park in the town, and the n walkers nearest it sent there for leisure.
function parkVisit(n) {
  const s = fixtureState('town');
  const [cand] = parkCandidates(s);
  assert.ok(cand, 'a park site');
  const {building: park, project} = designatePark(s, cand);
  park.built = 1;
  delete park.flags.scaffold;
  s.projects = s.projects.filter((p) => p !== project);
  s.buildingsRev = (s.buildingsRev ?? 0) + 1;
  const crowd = nearestTo(s, park.x, park.z, n);
  for (const p of crowd) p.task = null;
  crowdIndex(s);
  for (const p of crowd) {
    sendWalker(s, p, 'leisure', park);
    p.task.dwellFor = 1e6;
  }
  return {s, park, ids: new Set(crowd.map((p) => p.id))};
}

const there = (s, ids, targetId) => s.people.filter((p) => ids.has(p.id) && standing(p) && p.task.targetId === targetId && !p.task.relax);
const bearing = (f, p) => Math.atan2(p.z - f.z, p.x - f.x);

function assertApart(list, min, sameHouseholdMin = min) {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const p = list[i], q = list[j], d = Math.hypot(p.x - q.x, p.z - q.z);
      const lim = p.householdId === q.householdId ? sameHouseholdMin : min;
      assert.ok(d >= lim - 1e-6, `walkers ${p.id} and ${q.id} stand ${d.toFixed(2)} apart (min ${lim})`);
    }
}

function nearestNeighbour(list) {
  const out = [];
  for (const p of list) {
    let best = Infinity;
    for (const q of list) if (q !== p) best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
    out.push(best);
  }
  out.sort((a, b) => a - b);
  return out[out.length >> 1];
}

test('the activity follows the place and the occasion', () => {
  const s = fixtureState('city');
  const mon = s.buildings.find((b) => b.type === 'monument');
  s.worldEvents.push({id: 'e1', kind: 'procession', x: mon.x, z: mon.z, radius: 10, strength: 0.7, t0: 0, t1: 1e9});
  s.worldEvents.push({id: 'e2', kind: 'procession', x: mon.x, z: mon.z, radius: 24, strength: 1, t0: 0, t1: 1e9});
  const act = (kind, type, id, ev) => gatheringActivity(s, kind, type, id, ev);
  assert.equal(act('gather', 'event', 'e1', 'procession'), 'ceremony');
  assert.equal(act('gather', 'event', 'e2', 'procession'), 'crush', 'the whole town turning out is a crush');
  assert.equal(act('gather', 'event', 'x', 'wedding'), 'ceremony');
  assert.equal(act('gather', 'event', 'x', 'funeral'), 'ceremony');
  assert.equal(act('gather', 'event', 'x', 'market'), 'mingle');
  assert.equal(act('gather', 'event', 'x', 'festival'), 'mingle');
  assert.equal(act('gather', 'event', 'x', 'protest'), 'crush');
  assert.equal(act('gather', 'event', 'x', 'strike'), 'crush');
  assert.equal(act('leisure', 'building', mon.id), 'ceremony', 'admirers at a monument');
  const {s: t, park} = parkVisit(0);
  assert.equal(ACTIVITIES[gatheringActivity(t, 'leisure', 'building', park.id)].layout, 'lawn');
  const inn = t.buildings.find((b) => b.type === 'inn');
  assert.equal(gatheringActivity(t, 'leisure', 'building', inn.id), 'mingle');
  // Work, building sites and the rest keep the plain spot finder.
  assert.equal(gatheringActivity(t, 'work', 'building', inn.id), null);
  assert.equal(gatheringActivity(t, 'build', 'project', 1), null);
  // Every entry is complete: a layout, a picker, personal space, a known pose.
  for (const [id, a] of Object.entries(ACTIVITIES)) {
    assert.ok(a.layout && a.pick && Array.isArray(a.space) && a.space[0] >= 0.6, `activity ${id}`);
    assert.ok(a.action == null || ACTION[a.action] > 0, `pose of ${id}`);
  }
  // Preferences: a rest on the lawn is less wanted in winter and in the rain.
  const rest = ACTIVITIES['lawn-rest'];
  t.time.month = 4;
  t.weather = {...(t.weather ?? {}), rain: 0};
  const summer = preference(t, rest);
  t.time.month = 10;
  assert.ok(preference(t, rest) < summer, 'winter');
  t.time.month = 4;
  t.weather.rain = 1;
  assert.ok(preference(t, rest) < summer, 'rain');
});

test('every candidate spot of every style is walkable: open, dry, off decks', () => {
  const cases = [];
  const city = fixtureState('city');
  for (const b of city.buildings.filter((c) => ['monument', 'chapel', 'moot'].includes(c.type))) {
    for (const [kind, style] of [['procession', 'fan'], ['protest', 'crush'], ['festival', 'cluster']]) {
      const id = `w:${b.id}:${kind}`;
      city.worldEvents.push({id, kind, x: Math.round(b.x), z: Math.round(b.z), radius: 12, strength: 0.8, t0: 0, t1: 1e9});
      cases.push([city, style, 'event', id]);
    }
  }
  const {s: town, park} = parkVisit(0);
  cases.push([town, 'lawn', 'building', park.id]);
  for (const b of town.buildings.filter((c) => c.type === 'park')) cases.push([town, 'lawn', 'building', b.id]);
  // The bank line by a riverside park.
  for (const b of town.buildings.filter((c) => c.type === 'park')) cases.push([town, 'bank', 'building', b.id]);
  let n = 0;
  for (const [s, style, type, id] of cases) {
    const occ = occasionFor(s, style, type, id);
    assert.ok(occ && occ.spots.length > 0, `${style} spots at ${id}`);
    for (let k = 0; k < occ.spots.length; k += SPOT_STRIDE) {
      const x = occ.spots[k], z = occ.spots[k + 1];
      assert.ok(walkable(s, x, z), `${style} spot ${x.toFixed(2)}, ${z.toFixed(2)} at ${id} is not walkable`);
      n++;
    }
    // Pure and cached: the same list again.
    assert.equal(occasionFor(s, style, type, id), occ);
  }
  assert.ok(n > 1000, `spots checked (${n})`);
});

test('a ceremony gathers in a fan on the open side, facing the focus, front first; never a full ring', () => {
  const {s, b, ev, ids} = eventAt('city', 'monument', 'procession', 60, {radius: 10, strength: 0.8});
  const occ = occasionFor(s, 'fan', 'event', ev.id);
  // The candidates: within the fan, the nearer ones first.
  const n = occ.spots.length / SPOT_STRIDE;
  const d = (k) => Math.hypot(occ.spots[k * SPOT_STRIDE] - b.x, occ.spots[k * SPOT_STRIDE + 1] - b.z);
  let front = 0, back = 0;
  for (let k = 0; k < 30; k++) { front += d(k) / 30; back += d(n - 1 - k) / 30; }
  assert.ok(front < back - 2, `front rows (${front.toFixed(2)}) fill before the back (${back.toFixed(2)})`);
  run(s, 600);
  const here = there(s, ids, ev.id);
  assert.ok(here.length >= 30, `a crowd at the ceremony (${here.length})`);
  assertApart(here, 0.6);
  const sectors = new Array(12).fill(0);
  let cx = 0, cz = 0;
  for (const p of here) {
    assert.ok(walkable(s, p.x, p.z), `walker ${p.id} stands on unwalkable ground`);
    const a = bearing(b, p);
    sectors[Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 12]++;
    cx += Math.cos(a) / here.length;
    cz += Math.sin(a) / here.length;
    // Facing the monument.
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const l = Math.hypot(b.x - p.x, b.z - p.z);
    assert.ok((fx * (b.x - p.x) + fz * (b.z - p.z)) / l > 0.5, `walker ${p.id} does not face the monument`);
  }
  const empty = sectors.filter((c) => c === 0).length;
  assert.ok(empty >= 3, `at least a quarter of the way round stays open (${empty} of 12 sectors empty: ${sectors})`);
  assert.ok(Math.hypot(cx, cz) > 0.35, `the crowd sits to one side, not all round (resultant ${Math.hypot(cx, cz).toFixed(2)})`);
  // Ragged, not a lattice: spacing varies.
  const gaps = here.map((p) => Math.min(...here.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.z - q.z))));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) > 0.25, 'spacing is jittered');
});

test('a protest packs in tighter and closer than a ceremony at the same place', () => {
  const measure = (kind) => {
    const {s, b, ev, ids} = eventAt('city', 'moot', kind, 60, {radius: 10, strength: 0.8});
    run(s, 600);
    const here = there(s, ids, ev.id);
    assert.ok(here.length >= 30, `${kind}: a crowd (${here.length})`);
    assertApart(here, 0.6);
    const wall = (p) => Math.hypot(Math.max(0, Math.abs(p.x - b.x) - b.w / 2), Math.max(0, Math.abs(p.z - b.z) - b.d / 2));
    return {nn: nearestNeighbour(here), wall: here.reduce((a, p) => a + wall(p), 0) / here.length};
  };
  const focal = measure('procession'), crowd = measure('protest');
  assert.ok(crowd.nn < focal.nn - 0.1, `protesters stand closer together (${crowd.nn.toFixed(2)} vs ${focal.nn.toFixed(2)})`);
  assert.ok(crowd.wall < focal.wall, `and press up to the building (${crowd.wall.toFixed(2)} vs ${focal.wall.toFixed(2)} from its walls)`);
});

test('at a market people stand in small groups facing each other, and drift between them', () => {
  const {s, ev, ids} = eventAt('town', 'market', 'market', 60, {radius: 10, strength: 0.8});
  let grouped = 0, total = 0, hops = 0;
  const groupOf = new Map();
  for (let t = 0; t < 900; t++) {
    stepTick(s, 0.1, {});
    for (const p of s.people) {
      if (!ids.has(p.id) || p.task?.group == null) continue;
      const g = groupOf.get(p.id);
      if (g != null && g !== p.task.group) hops++;
      groupOf.set(p.id, p.task.group);
    }
    if (t < 400 || t % 100) continue;
    const here = there(s, ids, ev.id);
    assertApart(here, 0.6);
    for (const p of here) {
      if (p.task.activity !== 'mingle') continue;
      total++;
      // Mates: those facing the same group middle.
      const mates = here.filter((q) => q !== p && q.task.face && p.task.face && Math.hypot(q.task.face[0] - p.task.face[0], q.task.face[1] - p.task.face[1]) < 1e-6);
      if (!mates.length) continue;
      grouped++;
      // Facing the group's middle: toward the others.
      let mx = 0, mz = 0;
      for (const q of mates) { mx += (q.x - p.x) / mates.length; mz += (q.z - p.z) / mates.length; }
      const l = Math.hypot(mx, mz);
      assert.ok(l < 1.6, `group mates within conversation range (${l.toFixed(2)})`);
      assert.ok((Math.sin(p.heading) * mx + Math.cos(p.heading) * mz) / l > 0.5, `walker ${p.id} faces its group`);
    }
  }
  assert.ok(total > 40, `market-goers sampled (${total})`);
  assert.ok(grouped > total * 0.4, `many stand in groups (${grouped} of ${total})`);
  assert.ok(hops > 3, `some drift to another group (${hops})`);
});

test('park visitors spread out over the lawn, prefer appealing spots and keep off the paths', () => {
  const {s, park, ids} = parkVisit(40);
  const occ = occasionFor(s, 'lawn', 'building', park.id);
  let mean = 0;
  const n = occ.spots.length / SPOT_STRIDE;
  for (let k = 0; k < n; k++) mean += occ.spots[k * SPOT_STRIDE + 6] / n;
  const acts = new Set();
  let looped = 0, moved = 0;
  for (let t = 0; t < 900; t++) {
    stepTick(s, 0.1, {});
    for (const p of s.people) if (ids.has(p.id) && p.task?.activity === 'lawn-play' && p.task.seg < p.task.route.length && p.task.dwell > 0) looped++;
    if (t < 400 || t % 100) continue;
    const here = there(s, ids, park.id).filter((p) => !p.task.seat);
    assert.ok(here.length >= 8, `visitors on the lawn (${here.length})`);
    // Well apart from strangers (family may sit close, and picnic a little nearer the neighbours).
    assertApart(here, 1.55, 0.7);
    let chosen = 0;
    for (const p of here) {
      assert.ok(walkable(s, p.x, p.z));
      assert.ok(Math.abs(p.x - park.x) < park.w / 2 && Math.abs(p.z - park.z) < park.d / 2, `walker ${p.id} in the park`);
      if (p.task.activity === 'lawn-play' || p.task.activity === 'lawn-stroll') { moved++; continue; }
      assert.ok(pathDistance(park, p.x, p.z) >= 1.0, `walker ${p.id} rests on a path`);
      // The appeal of where it rests.
      let best = -Infinity;
      for (let k = 0; k < n; k++) if (Math.hypot(occ.spots[k * SPOT_STRIDE] - p.x, occ.spots[k * SPOT_STRIDE + 1] - p.z) < 0.05) best = occ.spots[k * SPOT_STRIDE + 6];
      if (best > -Infinity) chosen += best;
      acts.add(p.task.activity);
    }
    const rest = here.filter((p) => p.task.activity !== 'lawn-play' && p.task.activity !== 'lawn-stroll' && p.task.activity !== 'picnic');
    if (rest.length) assert.ok(chosen / rest.length >= mean, `chosen spots (${(chosen / rest.length).toFixed(2)}) beat the park's average (${mean.toFixed(2)})`);
  }
  assert.ok(acts.size >= 2, `different things to do (${[...acts]})`);
  assert.ok(looped > 0, 'someone plays about in loops');
});

test('the park model of trees and paths matches what the renderer draws', () => {
  const {park} = parkVisit(0);
  // parkPlanting lists the trees first, then the bushes along the hedge.
  const mine = parkTrees(park);
  const trees = parkPlanting(park).slice(0, mine.length / 2);
  assert.ok(trees.length >= 3);
  trees.forEach((t, i) => {
    assert.ok(Math.abs(t.x - mine[i * 2]) < 1e-9 && Math.abs(t.z - mine[i * 2 + 1]) < 1e-9, `tree ${i}`);
  });
  assert.equal(pathDistance(park, park.x, park.z + 3), 0, 'the cross path runs through the middle');
});

test('a line layout lines the river bank facing the water, nearest first (for anglers and gazers to come)', () => {
  const {s} = parkVisit(0);
  const park = s.buildings.filter((b) => b.type === 'park').sort((a, b) => bankDistance(a.x, a.z) - bankDistance(b.x, b.z))[0];
  const occ = occasionFor(s, 'bank', 'building', park.id);
  const n = occ.spots.length / SPOT_STRIDE;
  assert.ok(n >= 10, `bank spots (${n})`);
  let last = -1;
  for (let k = 0; k < n; k++) {
    const o = k * SPOT_STRIDE, x = occ.spots[o], z = occ.spots[o + 1];
    assert.ok(walkable(s, x, z), 'on the dry bank');
    assert.ok(bankDistance(x, z) > 0 && bankDistance(x, z) < 1.5, `by the water's edge (${bankDistance(x, z).toFixed(2)})`);
    // Facing the water: the faced point is over the river.
    assert.ok(waterAt(occ.spots[o + 2], occ.spots[o + 3]), 'faces the water');
    const d = Math.hypot(x - park.x, z - park.z);
    assert.ok(d >= last - 1e-9, 'nearest the place first');
    last = d;
  }
  // The same picker for one walker as for a crowd: lineSpots on any polyline.
  const line = lineSpots(s, [park.x - 3, park.z, park.x + 3, park.z], {step: 1, side: 1, face: 4});
  assert.ok(line.length > 0);
  for (const spot of line) assert.ok(Math.abs(spot.fx - spot.x) < 1e-9 && Math.abs(spot.fz - (spot.z - 4)) < 1e-9, 'all face the same side of the line');
});

test('household members at a gathering end up near each other', () => {
  // A ceremony and a park visit, with every walker of a few big households among the crowd.
  for (const where of ['focal', 'leisure']) {
    const ctx = where === 'focal' ? eventAt('city', 'monument', 'procession', 50, {radius: 10, strength: 0.8}) : parkVisit(30);
    const {s, ids} = ctx;
    const targetId = where === 'focal' ? ctx.ev.id : ctx.park.id;
    const households = new Map();
    for (const p of s.people) {
      if (!ids.has(p.id)) continue;
      households.set(p.householdId, [...(households.get(p.householdId) ?? []), p]);
    }
    run(s, 700);
    const here = there(s, ids, targetId).filter((p) => !p.task.seat);
    let kin = 0, kinPairs = 0, strangers = 0, strangerPairs = 0;
    for (let i = 0; i < here.length; i++)
      for (let j = i + 1; j < here.length; j++) {
        const d = Math.hypot(here[i].x - here[j].x, here[i].z - here[j].z);
        if (here[i].householdId === here[j].householdId) { kin += d; kinPairs++; } else { strangers += d; strangerPairs++; }
      }
    assert.ok(kinPairs >= 2, `${where}: family pairs at the gathering (${kinPairs})`);
    assert.ok(kin / kinPairs < 2.0 && kin / kinPairs < (strangers / strangerPairs) * 0.5,
      `${where}: family stand together (${(kin / kinPairs).toFixed(2)} apart, strangers ${(strangers / strangerPairs).toFixed(2)})`);
  }
});

test('gatherings replay exactly: twice from the same start, and saved mid-gathering', () => {
  const make = () => {
    const {s} = parkVisit(30);
    const mon = marketOf(s);
    const ev = {id: 'test:market', kind: 'market', x: Math.round(mon.x), z: Math.round(mon.z), radius: 10, strength: 0.8, t0: 0, t1: 1e9};
    s.worldEvents.push(ev);
    for (const p of nearestTo(s, mon.x, mon.z, 40)) if (!p.task || p.task.kind !== 'leisure') joinGathering(s, p, ev);
    return s;
  };
  const a = make(), b = make();
  run(a, 300);
  run(b, 300);
  assert.equal(serialize(a), serialize(b), 'the same start plays out the same');
  // Someone mid-wander at the save.
  const wandering = () => a.people.some((p) => p.task?.activity && !p.task.waiting && p.task.seg < p.task.route.length && p.task.dwell > 0);
  for (let t = 0; t < 400 && !wandering(); t++) stepTick(a, 0.1, {});
  assert.ok(wandering(), 'a walker moving on within its gathering at the save');
  const r = restore(serialize(a));
  run(a, 250);
  run(r, 250);
  assert.equal(serialize(r), serialize(a));
});
