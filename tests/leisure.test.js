// Leisure outings (src/sim/leisure.js, places.js, gatherings.js ACTIVITIES): fishing a
// calm reach or from a bridge rail, gazing from a bridge (at the sun when it is low),
// walks along the woods' edge and out along the tracks, berries, birds, a picnic by the
// river, sunbathing, the chapel steps, the inn on a summer evening, children's games.
// Each puts people on walkable ground (or a bridge deck), in its pose, facing what it is
// about; the choice follows season, weather, day phase, who the walker is and habit; and
// the town replays the same, saved or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixtureState, stepTick, serialize, restore, cellIndex, createRenderView, createState, fastForward} from '../src/sim/index.js';
import {archetypeOf, RIVERLESS} from '../src/waters.js';
import {goOut, ACTION, deckAt, walkerY, crowdIndex} from '../src/sim/people.js';
import {ACTIVITIES, deckSpot, occasionFor, occasionSpot, SPOT_STRIDE, railCap, deckHalf, railInner, railStyle, RAIL_TOP, towardSun} from '../src/sim/gatherings.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {alongBridge} from '../src/sim/bridges.js';
import {OUTINGS, outingFor, outingWeight, traitsOf, favourites, frozen} from '../src/sim/leisure.js';
import {placeIndex, townFrame} from '../src/sim/places.js';
import {seasonalPhase, simPhase, lightAt, lowSun, SUN_HEADING, SUN_AZIMUTH_DEG, SUN_DIR, YEAR_TO_PHASE, TOD_KEYS} from '../src/daylight.js';
import {woodField} from '../src/woodland.js';
import {generateForest} from '../src/render/trees.js';
import {footprints} from '../src/sim/roads.js';
import {deckHeightAt} from '../src/sim/bridges.js';
import {waterAt, bankDistance, riverX, surfaceLevelAt} from '../src/terrain.js';
import {rodTip, fishLineWater} from '../src/render/people.js';
import {PERSON_STRIDE_EXTENDED} from '../src/sim/render-view.js';
import {parkCandidates, designatePark} from '../src/sim/parks.js';

const standing = (p) => p.task && !p.task.waiting && p.task.seg >= p.task.route.length && !p.indoor;
const walkable = (s, x, z) => {
  const c = cellIndex(s.roads, x, z);
  return c >= 0 && !footprints(s).blocked[c] && !waterAt(x, z) && !deckAt(s, x, z);
};
const run = (s, ticks) => { for (let t = 0; t < ticks; t++) stepTick(s, 0.1, {}); };
const facing = (p) => [Math.sin(p.heading), Math.cos(p.heading)];
// Set the clock to a month and tick within it (for season and day phase).
const setTime = (s, month, tick = 0) => { s.time.month = month; s.time.tick = Math.floor(s.time.tick / 600) * 600 + month * 50 + tick; };

// The town as grown (fixtures run the sim, outings and all), with everyone free to choose.
const freshTown = () => {
  const s = fixtureState('town');
  for (const p of s.people) p.task = null;
  crowdIndex(s);   // forget the grown town's claims before sending anyone
  return s;
};

// The n walkers nearest a target, all sent on the outing there (staying put).
function sendAll(s, activity, n, from = null) {
  // From the first walker with such a place in reach (decks are few).
  let target = null;
  for (const probe of from ? [from] : s.people) if ((target = outingFor(s, probe, activity))) break;
  assert.ok(target, `a place for ${activity}`);
  const near = s.people.slice().sort((p, q) => Math.hypot(p.x - target.x, p.z - target.z) - Math.hypot(q.x - target.x, q.z - target.z) || p.id - q.id).slice(0, n);
  for (const p of near) {
    goOut(s, p, {...target});
    p.task.dwellFor = 1e6;
  }
  return {target, ids: new Set(near.map((p) => p.id))};
}
const there = (s, ids, target) => s.people.filter((p) => ids.has(p.id) && standing(p) && p.task.targetId === target.id && !p.task.relax);
// Those of ids out on the activity, wherever (a full place sends the rest to the next).
const out = (s, ids, activity) => s.people.filter((p) => ids.has(p.id) && standing(p) && p.task.activity === activity && p.task.spot);

test('day phase: one shared table for the drawn light and the sim', () => {
  // The grade imports these, and keeps no copy of its own.
  const grade = readFileSync(new URL('../src/render/grade.js', import.meta.url), 'utf8');
  assert.match(grade, /from '\.\.\/daylight\.js'/);
  assert.doesNotMatch(grade, /const YEAR_TO_PHASE|const TOD_KEYS/);
  assert.ok(YEAR_TO_PHASE.length > 5 && TOD_KEYS.length > 5);
  // Spring morning, summer noon, autumn golden hour, winter dusk, a night at the year's end.
  assert.equal(lightAt(seasonalPhase(0.03)), 'dawn');
  assert.equal(lightAt(seasonalPhase(0.4)), 'noon');
  assert.equal(lightAt(seasonalPhase(0.8)), 'golden');
  assert.equal(lightAt(seasonalPhase(0.91)), 'dusk');
  assert.equal(lightAt(seasonalPhase(0.95)), 'night');
  assert.ok(lowSun(seasonalPhase(0.8)) && !lowSun(seasonalPhase(0.4)));
  // The sim's phase is its clock's (ticks, not the frame's remainder).
  const s = fixtureState('town');
  setTime(s, 9, 30);
  assert.equal(simPhase(s.time), seasonalPhase((9 + 30 / 50) / 12));
  s.time.acc = 0.05;
  assert.equal(simPhase(s.time), seasonalPhase((9 + 30 / 50) / 12));
  // Facing the sun is the grade's sun bearing.
  assert.ok(Math.abs(SUN_HEADING - (SUN_AZIMUTH_DEG * Math.PI) / 180) < 1e-12);
});

test('the woods the sim walks beside are the woods the renderer draws', () => {
  const s = fixtureState('town');
  const town = townFrame(s);
  const forest = generateForest([town.x, town.z]);
  const idx = placeIndex(s);
  assert.ok(idx.woods.length >= 10, `wood edge places (${idx.woods.length})`);
  const count = (x, z, r) => {
    let n = 0;
    for (let i = 0; i < forest.count; i++) if (Math.abs(forest.x[i] - x) < r && Math.abs(forest.z[i] - z) < r && Math.hypot(forest.x[i] - x, forest.z[i] - z) < r) n++;
    return n;
  };
  let inside = 0, outside = 0;
  for (const w of idx.woods) {
    assert.ok(woodField(w.x, w.z) < 0.62, 'outside the wood');
    inside += count(w.x + w.gx * 9, w.z + w.gz * 9, 7);
    outside += count(w.x - w.gx * 9, w.z - w.gz * 9, 7);
  }
  assert.ok(inside > outside * 1.8 && inside > idx.woods.length, `drawn trees on the wood side (${inside}) vs the open side (${outside})`);
});

test('anglers line a calm reach, spaced out, facing the water with rods out; pairs stand together', () => {
  const s = freshTown();
  setTime(s, 4);
  const {target, ids} = sendAll(s, 'fishing', 8);
  run(s, 500);
  const here = out(s, ids, 'fishing');
  assert.ok(here.length >= 4, `anglers on the bank (${here.length})`);
  for (const p of here) {
    assert.ok(walkable(s, p.x, p.z), `angler ${p.id} on walkable ground`);
    const bank = bankDistance(p.x, p.z);
    assert.ok(bank > 0 && bank < 1.6, `angler ${p.id} at the water's edge (${bank.toFixed(2)})`);
    const [fx, fz] = facing(p);
    assert.ok(waterAt(p.x + fx * 3, p.z + fz * 3), `angler ${p.id} faces the water`);
    assert.equal(p.action, ACTION.fish);
  }
  for (let i = 0; i < here.length; i++)
    for (let j = i + 1; j < here.length; j++) {
      if (here[i].task.targetId !== here[j].task.targetId) continue;
      const d = Math.hypot(here[i].x - here[j].x, here[i].z - here[j].z);
      assert.ok(d >= (here[i].householdId === here[j].householdId ? 0.7 : 2.5), `anglers ${here[i].id}, ${here[j].id} ${d.toFixed(2)} apart`);
    }
  // The reach chosen is among the calmer ones near the walker.
  const idx = placeIndex(s);
  const reach = idx.byId.get(target.id);
  assert.ok(reach.calm >= 0.3, `a calm reach (${reach.calm.toFixed(2)})`);
});

test('fishing follows the season, the hour and the ice', () => {
  const s = fixtureState('town');
  const p = s.people.find((q) => traitsOf(s, q, s.households.find((h) => h.id === q.householdId)).age === 'adult');
  const h = s.households.find((x) => x.id === p.householdId);
  const t = traitsOf(s, p, h), fav = [-1, -1];
  const i = OUTINGS.findIndex((o) => o.activity === 'fishing');
  const w = (month, tick = 25, snow = 0) => { setTime(s, month, tick); s.weather = {...s.weather, rain: 0, snow}; return outingWeight(s, OUTINGS[i], t, fav, i); };
  // (The year carries the day: early spring is morning, high summer noon, autumn evening.)
  assert.ok(w(4) > w(2), 'more in summer than late spring');
  assert.equal(w(10, 25, 0.8), 0, 'none on frozen water');
  assert.ok(frozen(s));
  // Mornings (early spring) and evenings (autumn) beat midday (high summer) at the same season weight.
  const noon = w(4) / OUTINGS[i].seasons[1], evening = w(8) / OUTINGS[i].seasons[2];
  assert.ok(evening > noon, `evening ${evening.toFixed(2)} vs noon ${noon.toFixed(2)}`);
  // Habit: a favourite counts three times over.
  assert.equal(outingWeight(s, OUTINGS[i], t, [i, -1], i), 3 * outingWeight(s, OUTINGS[i], t, [-1, -1], i));
  assert.deepEqual(favourites(p), favourites(p));
  // Angling is a habit of a few: those who fish want it far more than the rest.
  const angler = outingWeight(s, OUTINGS[i], {...t, angler: true}, fav, i), other = outingWeight(s, OUTINGS[i], {...t, angler: false}, fav, i);
  assert.ok(other > 0 && other < angler * 0.05, `anglers ${angler.toFixed(3)}, others ${other.toFixed(3)}`);
  // A pastime of hamlets more than cities.
  const was = s.indicators.pop;
  s.indicators.pop = 60;
  const hamlet = outingWeight(s, OUTINGS[i], {...t, angler: true}, fav, i);
  s.indicators.pop = 5000;
  const city = outingWeight(s, OUTINGS[i], {...t, angler: true}, fav, i);
  s.indicators.pop = was;
  assert.ok(hamlet > city * 5, `hamlet ${hamlet.toFixed(2)} vs city ${city.toFixed(2)}`);
});

test('a city has only a handful of anglers at once, a hamlet still has some', () => {
  for (const [f, ticks] of [['city', 900], ['hamlet', 3600]]) {
    const s = fixtureState(f);
    const shore = placeIndex(s).banks.length * 24;   // metres of shore within reach (places are 24 m apart)
    let most = 0;
    const anglers = new Set();
    for (let t = 0; t < ticks; t++) {
      stepTick(s, 0.1, {});
      if (t % 10) continue;
      let now = 0;
      for (const p of s.people) if (p.task?.activity === 'fishing' || p.task?.activity === 'bridge-fish') { now++; anglers.add(p.id); }
      most = Math.max(most, now);
    }
    const pop = s.indicators.pop;
    if (f === 'city') {
      assert.ok(most <= pop * 0.003, `city: ${most} anglers at once for ${pop} people`);
      assert.ok(most <= Math.max(1, shore / 100) * 2, `city: ${most} anglers along ${shore} m of shore`);
    } else assert.ok(anglers.size >= 1, `${f}: someone goes fishing (${anglers.size})`);
  }
});

test('bridge gazers lean on the rail on the deck, at deck height, facing the water; at sunset, the sun', () => {
  for (const [month, sunset] of [[4, false], [9, true]]) {
    const s = freshTown();
    setTime(s, month, 30);
    assert.equal(lowSun(simPhase(s.time)), sunset);
    const {ids} = sendAll(s, 'bridge-gaze', 8);
    const view = createRenderView(s, {rowFloats: PERSON_STRIDE_EXTENDED});
    for (let k = 0; k < 400; k++) stepTick(s, 0.1, {});
    view.sync(s, {now: 1, speed: 1});
    const here = out(s, ids, 'bridge-gaze');
    assert.ok(here.length >= 3, `gazers on the bridges (${here.length})`);
    for (const p of here) {
      const bridge = placeIndex(s).byId.get(p.task.targetId).bridge;
      const ax = bridge.b.x - bridge.a.x, az = bridge.b.z - bridge.a.z, al = Math.hypot(ax, az);
      assert.ok(deckSpot(s, p.x, p.z), `gazer ${p.id} on the deck`);
      assert.ok(Math.abs(walkerY(s, p.x, p.z) - deckHeightAt(s, p.x, p.z)) < 0.05, 'at deck height');
      const i = s.people.indexOf(p), o = i * PERSON_STRIDE_EXTENDED;
      assert.equal(view.people[o + 19], 1, 'drawn on the deck');
      assert.ok(Math.abs(view.people[o + 1] - deckHeightAt(s, p.x, p.z)) < 0.05, 'drawn at deck height');
      assert.equal(p.action, ACTION.lean);
      const [fx, fz] = facing(p);
      if (sunset) assert.ok(Math.abs(Math.atan2(Math.sin(p.heading - SUN_HEADING), Math.cos(p.heading - SUN_HEADING))) < 0.05, `gazer ${p.id} faces the sun`);
      else {
        assert.ok(Math.abs((fx * ax + fz * az) / al) < 0.2, `gazer ${p.id} faces across the deck, out over the water`);
        assert.ok(waterAt(p.x + fx * 3, p.z + fz * 3), 'toward the water');
      }
    }
  }
});

test('a bridge holds only a few at its rails, its middle stays clear and traffic flows past; the rest go elsewhere', () => {
  const s = freshTown();
  setTime(s, 9, 30);
  const idx = placeIndex(s);
  const deck = idx.decks.find((d) => deckHalf(d.bridge) >= 1.2);
  assert.ok(deck, 'a deck wide enough to stop on');
  const bridge = deck.bridge, cap = railCap(bridge);
  const L = Math.hypot(bridge.b.x - bridge.a.x, bridge.b.z - bridge.a.z);
  assert.ok(cap >= 1 && cap <= Math.ceil(L / 3), `cap ${cap} for a ${L.toFixed(1)} m deck`);
  // Footbridges are too narrow to stop on.
  for (const d of idx.decks) if (deckHalf(d.bridge) < 1.2) assert.equal(occasionFor(s, 'rail', 'place', d.id).spots.length, 0);
  // Fifteen set off to gaze from it at once.
  const target = {type: 'place', id: deck.id, x: deck.x, z: deck.z, activity: 'bridge-gaze', outing: true};
  const sent = s.people.slice().sort((p, q) => Math.hypot(p.x - deck.x, p.z - deck.z) - Math.hypot(q.x - deck.x, q.z - deck.z)).slice(0, 15);
  for (const p of sent) { goOut(s, p, {...target}); p.task.dwellFor = 1e6; }
  const ids = new Set(sent.map((p) => p.id));
  const routes = createRoutePlanner({worker: false});
  const crossers = new Set(), elsewhere = new Map();
  let most = 0, closest = Infinity, samples = 0;
  const onDeck = (p) => deckAt(s, p.x, p.z)?.bridge === bridge;
  for (let t = 0; t < 900; t++) {
    s.time.month = 9;     // the golden hour throughout (the clock itself runs on)
    routes.tick(s, 30);   // a generous planning budget: everyone in town has just chosen anew
    stepTick(s, 0.1, {routes});
    // The overflow, sent on to another rail or the bank.
    for (const p of s.people) if (ids.has(p.id) && p.task?.outing && p.task.targetId !== deck.id && (p.task.avoid ?? []).includes(deck.id)) elsewhere.set(p.id, p.task.activity);
    if (t % 5) continue;
    const standers = s.people.filter((p) => onDeck(p) && p.speed === 0 && p.task?.spot && ACTIVITIES[p.task.activity]?.layout === 'rail');
    const claims = s.people.filter((p) => p.task?.spot && p.task.targetId === deck.id).length;
    assert.ok(claims <= cap, `claims at the rails ${claims} (cap ${cap})`);
    most = Math.max(most, standers.length);
    for (const p of s.people) {
      if (!onDeck(p) || p.speed === 0 || ACTIVITIES[p.task?.activity]?.layout === 'rail') continue;
      crossers.add(p.id);
      const {t: u} = alongBridge(bridge, p.x, p.z);
      if (u < 0.2 || u > 0.8) continue;
      for (const q of standers) { closest = Math.min(closest, Math.hypot(p.x - q.x, p.z - q.z)); samples++; }
    }
  }
  assert.ok(most >= 1 && most <= cap, `gazers at the rails at once: ${most} (cap ${cap})`);
  assert.ok(crossers.size >= 5, `traffic still crossing (${crossers.size} walkers)`);
  assert.ok(samples > 20 && closest >= 0.36, `through-walkers pass the gazers (closest ${closest.toFixed(2)} over ${samples} samples)`);
  assert.ok(elsewhere.size >= 3, `the overflow went elsewhere (${elsewhere.size}: ${[...new Set(elsewhere.values())]})`);
});

test('rail standers face out over their own rail (toward the sun only on that side) and stand clear of the rail as drawn, on every style', () => {
  const LEAN = 0.34, HIP = 0.72, BODY = 0.25;
  for (const style of ['timber', 'stone', 'iron']) {
    for (const [month, label] of [[4, 'day'], [9, 'sunset']]) {
      const s = freshTown();
      setTime(s, month, 30);
      const deck = placeIndex(s).decks.find((d) => deckHalf(d.bridge) >= 1.2);
      const b = deck.bridge;
      b.style = style;
      b.width = style === 'stone' ? 5 : style === 'iron' ? 6 : 4;
      const target = {type: 'place', id: deck.id, x: deck.x, z: deck.z, activity: 'bridge-gaze', outing: true};
      const sent = s.people.slice().sort((p, q) => Math.hypot(p.x - deck.x, p.z - deck.z) - Math.hypot(q.x - deck.x, q.z - deck.z)).slice(0, 8);
      for (const p of sent) { goOut(s, p, {...target}); p.task.dwellFor = 1e6; }
      run(s, 450);
      const L = Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z), ux = (b.b.x - b.a.x) / L, uz = (b.b.z - b.a.z) / L;
      // Every spot of the layout, both sides: facing straight out, and (at sunset) never
      // more than 60 degrees off that; clear of the rail.
      const occ = occasionFor(s, 'rail', 'place', deck.id), spotSides = new Set();
      assert.ok(occ.spots.length > 0, `${style}: rail spots`);
      for (let k = 0; k < occ.spots.length; k += SPOT_STRIDE) {
        const x = occ.spots[k], z = occ.spots[k + 1];
        const off = (x - b.a.x) * uz - (z - b.a.z) * ux, side = Math.sign(off), nx = uz * side, nz = -ux * side;
        spotSides.add(side);
        for (const [fx, fz] of [[occ.spots[k + 2], occ.spots[k + 3]], towardSun(x, z, occ.spots[k + 2], occ.spots[k + 3])]) {
          const l = Math.hypot(fx - x, fz - z);
          assert.ok(((fx - x) * nx + (fz - z) * nz) / l >= 0.5 - 1e-9, `${style}: spot faces off its rail`);
        }
        assert.ok(Math.abs(off) + BODY + (RAIL_TOP[railStyle(b)] - HIP) * Math.sin(LEAN) <= railInner(b) + 1e-9, `${style}: spot clear of the rail`);
      }
      assert.equal(spotSides.size, 2, `${style}: spots along both rails`);
      const here = sent.filter((p) => standing(p) && p.task.targetId === deck.id && p.task.spot);
      assert.ok(here.length >= 2, `${style} ${label}: standers at the rails (${here.length})`);
      const sides = new Set();
      for (const p of here) {
        // Signed offset across the deck (right of a -> b positive) and the outward normal.
        const off = (p.x - b.a.x) * uz - (p.z - b.a.z) * ux, side = Math.sign(off);
        sides.add(side);
        const nx = uz * side, nz = -ux * side;
        const [fx, fz] = facing(p);
        const cos = fx * nx + fz * nz;
        assert.ok(cos >= Math.cos(Math.PI / 3) - 1e-9, `${style} ${label}: walker ${p.id} faces ${(Math.acos(Math.min(1, cos)) * 180 / Math.PI).toFixed(0)} deg off its rail's outward normal`);
        // The body: a capsule 0.25 round from the feet up, its upper part leant forward
        // over the rail; up to the rail's top it must stay inside the rail's inner face.
        const inner = railInner(b), top = RAIL_TOP[railStyle(b)];
        for (const y of [0, HIP, (HIP + top) / 2, top]) {
          const lean = Math.max(0, y - HIP) * Math.sin(LEAN) * cos;
          assert.ok(Math.abs(off) + BODY + lean <= inner + 1e-9, `${style} ${label}: walker ${p.id} reaches ${(Math.abs(off) + BODY + lean).toFixed(2)} at ${y.toFixed(2)} m, rail face at ${inner.toFixed(2)}`);
        }
        assert.equal(p.action, ACTION.lean);
      }
    }
  }
});

test('at golden hour a gazer on the rail away from the sun (beside family there) still faces out over that rail', () => {
  const s = freshTown();
  setTime(s, 9, 30);
  assert.ok(lowSun(simPhase(s.time)));
  const deck = placeIndex(s).decks.find((d) => deckHalf(d.bridge) >= 1.2);
  const b = deck.bridge, L = Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z), ux = (b.b.x - b.a.x) / L, uz = (b.b.z - b.a.z) / L;
  const occ = occasionFor(s, 'rail', 'place', deck.id);
  const sideOf = (x, z) => Math.sign((x - b.a.x) * uz - (z - b.a.z) * ux);
  const sunwardSide = (side) => (uz * side) * SUN_DIR[0] + (-ux * side) * SUN_DIR[1] > 0;
  // A household of two: one already at a spot on the rail facing away from the sun.
  const byHouse = new Map();
  for (const q of s.people) byHouse.set(q.householdId, [...(byHouse.get(q.householdId) ?? []), q]);
  const [kin, p] = [...byHouse.values()].find((list) => list.length >= 2);
  let away = -1;
  for (let k = 0; k < occ.spots.length; k += SPOT_STRIDE) if (!sunwardSide(sideOf(occ.spots[k], occ.spots[k + 1]))) { away = k; break; }
  assert.ok(away >= 0, 'a rail facing away from the sun');
  kin.indoor = false;
  kin.task = {kind: 'leisure', activity: 'bridge-gaze', outing: 1, targetType: 'place', targetId: deck.id, spot: [occ.spots[away], occ.spots[away + 1]], route: [], seg: 0, waiting: false};
  crowdIndex(s);
  const spot = occasionSpot(s, p, {kind: 'leisure', activity: 'bridge-gaze', outing: 1, targetType: 'place', targetId: deck.id}, occ, p.x, p.z);
  assert.ok(spot, 'a spot beside them');
  const side = sideOf(spot.x, spot.z);
  assert.ok(!sunwardSide(side), 'on the rail away from the sun, beside family');
  const nx = uz * side, nz = -ux * side, l = Math.hypot(spot.fx - spot.x, spot.fz - spot.z);
  assert.ok(((spot.fx - spot.x) * nx + (spot.fz - spot.z) * nz) / l >= 0.5, 'facing out over that rail, not across the deck at the sun');
  // And a gazer on a sunward rail does turn toward the sun, within 60 degrees of out.
  for (let k = 0; k < occ.spots.length; k += SPOT_STRIDE) {
    const x = occ.spots[k], z = occ.spots[k + 1], sd = sideOf(x, z);
    if (!sunwardSide(sd)) continue;
    const [fx, fz] = towardSun(x, z, occ.spots[k + 2], occ.spots[k + 3]);
    const fl = Math.hypot(fx - x, fz - z);
    assert.ok(((fx - x) * uz * sd + (fz - z) * -ux * sd) / fl >= 0.5 - 1e-9);
    assert.ok(((fx - x) * SUN_DIR[0] + (fz - z) * SUN_DIR[1]) / fl > ((occ.spots[k + 2] - x) * SUN_DIR[0] + (occ.spots[k + 3] - z) * SUN_DIR[1]) / 6 - 1e-9, 'turned toward the sun');
  }
});

test('an angler\'s line hangs from the rod tip to the water, from a bank and from a bridge deck', () => {
  for (const activity of ['fishing', 'bridge-fish']) {
    const s = freshTown();
    setTime(s, 4);
    const {ids} = sendAll(s, activity, 4);
    const view = createRenderView(s, {rowFloats: PERSON_STRIDE_EXTENDED});
    run(s, 450);
    view.sync(s, {now: 1, speed: 1});
    const here = out(s, ids, activity);
    assert.ok(here.length >= 1, `${activity}: anglers out`);
    const tip = rodTip(), figure = 1.1;   // render/people.js uFigureScale
    for (const p of here) {
      const o = s.people.indexOf(p) * PERSON_STRIDE_EXTENDED, rows = view.people;
      assert.equal(rows[o + 9], ACTION.fish);
      const scale = rows[o + 14] * figure, heading = rows[o + 15], baseY = rows[o + 1];
      // Where the tip is (the shader's held rod): over the water, well above it.
      const tx = rows[o] + Math.sin(heading) * tip.forward * scale, tz = rows[o + 2] + Math.cos(heading) * tip.forward * scale;
      assert.ok(waterAt(tx, tz), `${activity}: rod tip over the water`);
      const water = fishLineWater(rows[o], rows[o + 2], heading, scale);
      assert.ok(Math.abs(water - surfaceLevelAt(tx, tz)) < 1e-9);
      assert.ok(baseY + tip.up * scale > water + 0.5, `${activity}: the tip well above the water`);
      // The shader: the line's bottom, in the figure's units, put back in the world.
      const bottomModel = (water - baseY) / scale, bob = 0.012;
      const lineEnd = baseY + (bottomModel + bob) * scale;
      assert.ok(Math.abs(lineEnd - water) <= 0.05, `${activity}: the line ends ${(lineEnd - water).toFixed(3)} from the surface`);
    }
  }
});

test('a walk along the woods\' edge keeps to the edge, every leg on walkable ground, and comes back', () => {
  const s = freshTown();
  setTime(s, 6);
  const {target, ids} = sendAll(s, 'wood-walk', 3);
  const wood = placeIndex(s).byId.get(target.id);   // (the index moves on as the town grows)
  const start = new Map();
  const legs = [];
  let walked = 0;
  for (let t = 0; t < 900; t++) {
    stepTick(s, 0.1, {});
    for (const p of s.people) {
      if (!ids.has(p.id) || !p.task?.spot || p.task.targetId !== target.id) continue;
      if (p.task.dwell > 0 && p.task.seg < p.task.route.length) {
        walked++;
        assert.ok(walkable(s, p.x, p.z), `walker ${p.id} off walkable ground at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
        const level = start.get(p.id) ?? woodField(p.task.spot[0], p.task.spot[1]);
        start.set(p.id, level);
        legs.push(Math.abs(woodField(p.x, p.z) - level));
      }
    }
  }
  assert.ok(walked > 50, `walked along the edge (${walked} samples)`);
  legs.sort((a, b) => a - b);
  assert.ok(legs[Math.floor(legs.length * 0.9)] < 0.08, `close to the edge's contour (90th pct ${legs[Math.floor(legs.length * 0.9)].toFixed(3)})`);
  // Back at the start, facing into the woods.
  const back = there(s, ids, target);
  for (const p of back) {
    const [fx, fz] = facing(p);
    assert.ok(fx * wood.gx + fz * wood.gz > 0.5, 'facing the wood');
  }
});

test('every outing places its walkers on walkable ground (or a deck) in its pose', () => {
  const s = freshTown();
  for (const c of parkCandidates(s)) {
    const {building, project} = designatePark(s, c);
    building.built = 1;
    delete building.flags.scaffold;
    s.projects = s.projects.filter((pr) => pr !== project);
  }
  s.buildingsRev = (s.buildingsRev ?? 0) + 1;
  setTime(s, 7, 20);
  const sent = [];
  const used = new Set();
  for (const o of OUTINGS) {
    // A walker near the town for each, the child of a family for tag.
    let p = null, target = null;
    for (const q of s.people) {
      if (used.has(q.id) || (o.activity === 'tag' && traitsOf(s, q, s.households.find((h) => h.id === q.householdId)).age !== 'child')) continue;
      if ((target = outingFor(s, q, o.activity))) { p = q; break; }
    }
    if (!p) continue;
    used.add(p.id);
    goOut(s, p, target);
    p.task.dwellFor = 1e6;
    sent.push({p, o, target});
  }
  assert.ok(sent.length >= OUTINGS.length - 1, `outings with a place (${sent.length} of ${OUTINGS.length}: ${sent.map((x) => x.o.activity)})`);
  run(s, 1200);
  let ok = 0;
  for (const {p, o} of sent) {
    if (!standing(p) || !p.task?.spot || p.task.activity !== o.activity) continue;
    ok++;
    const a = ACTIVITIES[o.activity];
    if (a.layout === 'rail') assert.ok(deckSpot(s, p.x, p.z), `${o.activity}: on the deck`);
    else assert.ok(walkable(s, p.x, p.z), `${o.activity}: walkable`);
    if (!a.wander) assert.equal(p.action, ACTION[a.action] ?? ACTION.none, `${o.activity}: pose`);
    if (a.face === 'water') {
      // Out over the water from a rail; toward the river from a bank.
      const [fx, fz] = facing(p);
      assert.ok(waterAt(p.x + fx * 5, p.z + fz * 5), `${o.activity}: facing the water`);
    }
  }
  assert.ok(ok >= sent.length - 3, `outings under way (${ok} of ${sent.length})`);
});

test('in a town left to itself, outings are varied, a modest share of leisure, and stay in season', () => {
  const s = fixtureState('town');
  setTime(s, 3);
  const seen = new Map();
  let leisure = 0, outings = 0, fishingWinter = 0;
  for (let t = 0; t < 2400; t++) {
    // Frozen all through the tick (the weather rolls at the month's turn, mid-tick).
    const iceBefore = frozen(s);
    stepTick(s, 0.1, {});
    const ice = iceBefore && frozen(s);
    for (const p of s.people) {
      const task = p.task;
      if (!task || task.kind !== 'leisure' || task._seen) continue;
      task._seen = 1;
      leisure++;
      if (!task.outing) continue;
      outings++;
      seen.set(task.activity, (seen.get(task.activity) ?? 0) + 1);
      if (task.activity === 'fishing' && ice) fishingWinter++;
    }
  }
  assert.ok(seen.size >= 7, `varied (${[...seen].map(([k, v]) => `${k} ${v}`).join(', ')})`);
  assert.ok(outings / leisure < 0.5 && outings / leisure > 0.1, `outings ${outings} of ${leisure} leisure trips`);
  assert.equal(fishingWinter, 0, 'nobody sets off fishing on frozen water');
});

test('outings replay exactly: twice from the same start, and saved mid-outing', () => {
  const make = () => {
    const s = freshTown();
    setTime(s, 8, 10);
    for (const a of ['fishing', 'bridge-gaze', 'wood-walk', 'river-picnic', 'trail-walk']) sendAll(s, a, 4);
    return s;
  };
  const a = make(), b = make();
  run(a, 300);
  run(b, 300);
  assert.equal(serialize(a), serialize(b));
  const out = () => a.people.some((p) => p.task?.outing && !p.task.waiting && p.task.seg < p.task.route.length && p.task.dwell > 0);
  for (let t = 0; t < 400 && !out(); t++) stepTick(a, 0.1, {});
  const r = restore(serialize(a));
  run(a, 300);
  run(r, 300);
  assert.equal(serialize(r), serialize(a));
});

test('rail and bank layouts are walkable spots facing the water', () => {
  const s = fixtureState('town');
  const idx = placeIndex(s);
  let n = 0;
  for (const d of idx.decks) {
    const occ = occasionFor(s, 'rail', 'place', d.id);
    for (let k = 0; k < occ.spots.length; k += SPOT_STRIDE) {
      const x = occ.spots[k], z = occ.spots[k + 1];
      assert.ok(deckSpot(s, x, z), 'on the deck');
      assert.ok(waterAt(occ.spots[k + 2], occ.spots[k + 3]), 'facing the water');
      n++;
    }
  }
  for (const b of idx.banks.slice(0, 20)) {
    const occ = occasionFor(s, 'bank', 'place', b.id);
    for (let k = 0; k < occ.spots.length; k += SPOT_STRIDE) {
      assert.ok(walkable(s, occ.spots[k], occ.spots[k + 1]));
      n++;
    }
  }
  assert.ok(n > 100, `spots (${n})`);
});

// Last in the file: it grows towns in other valleys (the terrain is global).
test('water places sit on real shores in every kind of valley: river, lake, great lake, delta, coast, shore, dry', () => {
  const seeds = new Map();
  for (let seed = 1; seed < 4000 && seeds.size < 7; seed++) if (!seeds.has(archetypeOf(seed))) seeds.set(archetypeOf(seed), seed);
  assert.equal(seeds.size, 7);
  for (const [arch, seed] of seeds) {
    const s = createState(seed);
    fastForward(s, 12);
    const idx = placeIndex(s);
    const kinds = new Set(idx.banks.map((p) => p.water));
    for (const p of idx.banks) {
      assert.ok(walkable(s, p.x, p.z), `${arch}: place ${p.id} on dry, open ground`);
      assert.ok(waterAt(p.x + p.fx * 3, p.z + p.fz * 3), `${arch}: place ${p.id} has its water within 3 in front`);
      assert.ok(p.calm >= 0 && p.calm <= 1);
      for (const layout of ['bank', 'bankside']) {
        const occ = occasionFor(s, layout, 'place', p.id);
        for (let k = 0; k < occ.spots.length; k += SPOT_STRIDE) {
          const x = occ.spots[k], z = occ.spots[k + 1], fx = occ.spots[k + 2] - x, fz = occ.spots[k + 3] - z, l = Math.hypot(fx, fz);
          assert.ok(walkable(s, x, z), `${arch}: ${layout} spot walkable`);
          assert.ok(waterAt(x + (fx / l) * (layout === 'bank' ? 3 : 5), z + (fz / l) * (layout === 'bank' ? 3 : 5)), `${arch}: ${layout} spot faces its water`);
        }
      }
    }
    if (arch === 'lake') assert.ok(kinds.has('lake'), `a lake town fishes its lake (${[...kinds]})`);
    if (arch === 'coast' || arch === 'shore') assert.ok(kinds.has('sea'), `${arch}: the sea shore (${[...kinds]})`);
    if (RIVERLESS.has(arch)) assert.ok(!kinds.has('river') && !kinds.has('creek'), `${arch}: no phantom river banks (${[...kinds]})`);
    if (arch === 'dry') {
      assert.equal(idx.banks.length, 0, 'a dry valley has no shore');
      // Outings fall back: no water outings, and the town carries on.
      assert.equal(outingFor(s, s.people[0], 'fishing'), null);
      for (let t = 0; t < 200; t++) stepTick(s, 0.1, {});
      assert.ok(!s.people.some((p) => p.task?.activity === 'fishing' || p.task?.activity === 'bank-gaze'));
    }
    // Calmer water where it should be: lakes and ponds calm, the open sea rougher.
    for (const p of idx.banks) {
      if (p.water === 'lake' || p.water === 'pond') assert.ok(p.calm >= 0.8);
      if (p.water === 'sea') assert.ok(p.calm <= 0.85);
      if (p.water === 'creek') assert.ok(p.calm <= 0.3);
    }
  }
  fixtureState('town');   // the classic valley back for whatever runs next
});
