// Shortcuts from the release performance pass must give exactly the answers of the
// work they skip (PERFORMANCE.md, "Release tuning pass").
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick} from '../src/sim/index.js';
import {footprints, outlineClear, skirtOutlines, skirtMemo, skirtStillClear, wallMemo, wallsStillClear, routeClearFrom, bumpWorld, PERSON_MARGIN} from '../src/sim/roads.js';
import {addBuildingRecord, removeBuildingRecord} from '../src/sim/state.js';
import {buildingOutline, inRect} from '../src/sim/outline.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {shadowCertificates} from '../src/sim/people.js';
import {cellIndex} from '../src/sim/state.js';
import {createAutoTuner, guessTier} from '../src/render/quality.js';

let seed = 99;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

test('outline tests from the per-cell piece lists agree with every piece of every building', () => {
  const s = fixtureState('town');
  const pieces = s.buildings.filter((b) => b.type !== 'bridge' && b.type !== 'park').flatMap((b) => buildingOutline(b));
  const brute = (x, z) => !pieces.some((r) => inRect(r, x, z, PERSON_MARGIN));
  let blocked = 0;
  for (let k = 0; k < 20000; k++) {
    // Mostly around pieces (their edges and corners), some anywhere in town.
    const r = pieces[Math.floor(rand() * pieces.length)];
    const x = k % 4 ? r.x + (rand() * 2 - 1) * (r.hx + r.hz + 1.5) : r.x + (rand() * 2 - 1) * 60;
    const z = k % 4 ? r.z + (rand() * 2 - 1) * (r.hx + r.hz + 1.5) : r.z + (rand() * 2 - 1) * 60;
    if (Math.abs(x) > 380 || Math.abs(z) > 380) continue;   // off the walkers' grid: never clear there
    const want = brute(x, z);
    assert.equal(outlineClear(s, x, z), want, `(${x}, ${z})`);
    if (!want) blocked++;
  }
  assert.ok(blocked > 1000, 'the samples reach into pieces');
});

// Walks under way in a town that has run a while, each with a skirt memo and a walls
// memo taken now; then buildings beside some walks come down and new ones go up across
// others (from further along, so only legs ahead change).
function memoWalks() {
  const s = fixtureState('town');
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  for (let i = 0; i < 300; i++) {
    routes.tick(s, 1e9);
    stepTick(s, 0.1, {routes});
  }
  const walks = [];
  for (const p of s.people) {
    const t = p.task;
    if (!t?.route || t.waiting || t.seg + 3 >= t.route.length) continue;
    const rest = [p.x, p.z, ...t.route.slice(t.seg)];
    const report = {near: false};
    if (skirtOutlines(s, rest, null, report) !== rest || report.near) continue;
    if (!routeClearFrom(s, p.x, p.z, t.route, t.seg)) continue;
    walks.push({p, route: t.route, seg: t.seg, memo: skirtMemo(s, t.route, t.seg), walls: wallMemo(s, t.route, t.seg)});
  }
  assert.ok(walks.length > 30, `walks under way: ${walks.length}`);
  const near = (b) => walks.some(({route}) => Math.hypot(route.at(-2) - b.x, route.at(-1) - b.z) < 30);
  for (const b of s.buildings.filter((b) => b.type !== 'bridge' && near(b)).slice(0, 6)) removeBuildingRecord(s, b.id);
  // A small house on the middle of a leg well ahead, on every twentieth walk.
  for (const w of walks.filter((_, i) => i % 20 === 0)) {
    const k = w.seg + 4;
    if (k + 3 >= w.route.length) continue;
    addBuildingRecord(s, {type: 'home', x: (w.route[k] + w.route[k + 2]) / 2, z: (w.route[k + 1] + w.route[k + 3]) / 2, w: 3, d: 3});
  }
  bumpWorld(s);
  return {s, walks};
}

// Each walk asked again from where it is now and from a point along the next leg.
function* askAgain(walks) {
  for (const w of walks) {
    for (const ahead of [0, 2]) {
      const seg = w.seg + ahead;
      if (seg + 1 >= w.route.length) continue;
      const x = ahead ? (w.route[seg - 2] + w.route[seg]) / 2 : w.p.x, z = ahead ? (w.route[seg - 1] + w.route[seg + 1]) / 2 : w.p.z;
      yield {w, seg, x, z};
    }
  }
}

test('a skirt memo that holds means skirtOutlines would leave the walk as it is', () => {
  const {s, walks} = memoWalks();
  let held = 0, dropped = 0;
  for (const {w, seg, x, z} of askAgain(walks)) {
    const memo = {...w.memo};
    if (!skirtStillClear(s, memo, w.route, seg, x, z)) { dropped++; continue; }
    held++;
    const rest = [x, z, ...w.route.slice(seg)];
    assert.equal(skirtOutlines(s, rest), rest, `walker ${w.p.id} from segment ${seg}`);
  }
  assert.ok(held > 0 && dropped > 0, `held ${held}, dropped ${dropped}`);
});

test('a walls memo gives routeClearFrom\'s answer whenever it gives one', () => {
  const {s, walks} = memoWalks();
  let held = 0, dropped = 0, blocked = 0;
  for (const {w, seg, x, z} of askAgain(walks)) {
    const known = wallsStillClear(s, {...w.walls}, x, z, w.route, seg);
    const full = routeClearFrom(s, x, z, w.route, seg);
    if (!full) blocked++;
    if (known === undefined) { dropped++; continue; }
    held++;
    assert.equal(known, full, `walker ${w.p.id} from segment ${seg}`);
  }
  assert.ok(held > 0 && dropped > 0 && blocked > 0, `held ${held}, dropped ${dropped}, blocked ${blocked}`);
});

test('a walker a footprint certificate lets off would get nothing from the full checks', () => {
  // The town as it grows (buildings go up and change every few ticks), with every walker
  // the certificates let off checked in full: on open ground clear of every piece, its
  // route still clear of walls, and skirtOutlines leaving the rest of its walk as it is.
  const s = fixtureState('town');
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  let skipped = 0, checks = 0;
  const seen = new Set();
  shadowCertificates((state, p, keep) => {
    skipped++;
    const t = p.task;
    const c = cellIndex(state.roads, p.x, p.z);
    assert.ok(c >= 0 && !footprints(state).walls[c], `walker ${p.id} in a wall cell`);
    if (!p.indoor && !t.seat) assert.ok(outlineClear(state, p.x, p.z), `walker ${p.id} on a drawn piece`);
    assert.ok(routeClearFrom(state, p.x, p.z, t.route, t.seg), `walker ${p.id}: route through a wall`);
    const rest = [p.x, p.z, ...t.route.slice(t.seg)];
    assert.equal(skirtOutlines(state, rest, keep), rest, `walker ${p.id}: the walk would be skirted`);
    seen.add(state.worldVersion);
  });
  try {
    for (let i = 0; i < 1500; i++) {
      routes.tick(s, 1e9);
      stepTick(s, 0.1, {routes});
      checks++;
    }
  } finally {
    shadowCertificates(null);
  }
  assert.ok(skipped > 2000 && seen.size > 10, `walkers let off: ${skipped} over ${seen.size} footprint changes`);
});

test('auto quality keeps watching: a town that grows slow steps down again, and never back up', () => {
  const tuner = createAutoTuner();
  let tier = 'high';
  const steps = [];
  const feed = (ms, frames) => { for (let i = 0; i < frames; i++) { const next = tuner.sample(ms, tier); if (next) { steps.push(next); tier = next; } } };
  feed(14, 400);                       // settles at High
  assert.deepEqual(steps, []);
  assert.ok(tuner.settled());
  feed(40, 120);                       // one slow window is not enough
  assert.deepEqual(steps, []);
  feed(40, 300);
  assert.deepEqual(steps, ['medium']);
  feed(8, 2000);                       // fast again: stays at Medium
  assert.deepEqual(steps, ['medium']);
  const slow = createAutoTuner();
  let t = 'high';
  for (let i = 0; i < 400; i++) t = slow.sample(30, t) ?? t;
  assert.equal(t, 'low', 'a slow machine settles again after each step down');
});

test('the first quality guess reads the GPU: software is Low, integrated is Medium', () => {
  const gl = (name) => ({MAX_TEXTURE_SIZE: 1, RENDERER: 2, getParameter: (p) => (p === 1 ? 16384 : p === 3 ? name : 'WebKit WebGL'), getExtension: () => ({UNMASKED_RENDERER_WEBGL: 3})});
  assert.equal(guessTier(gl('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')), 'low');
  assert.equal(guessTier(gl('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')), 'medium');
  assert.equal(guessTier(gl('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')), 'medium');
  assert.equal(guessTier(gl('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)')), 'high');
  assert.equal(guessTier(gl('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')), 'high');
  assert.equal(guessTier({MAX_TEXTURE_SIZE: 1, getParameter: () => 4096}), 'low');
});
