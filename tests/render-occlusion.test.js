// Ambient occlusion (render/occlusion.js): the baked ground field darkens at
// wall feet and inside tight blocks, fades with distance, and every AO term
// eases off at night and under rain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeOcclusionField, aoDayFactor, bakedWeights } from '../src/render/occlusion.js';
import { TIERS } from '../src/render/quality.js';

/** Field value (contact, sky) 0..1 at world (x, z), nearest texel. */
function at(f, x, z) {
  const i = Math.round((x - f.x0) / f.step), j = Math.round((z - f.z0) / f.step);
  const k = (j * f.w + i) * 2;
  return [f.data[k] / 255, f.data[k + 1] / 255];
}

test('no buildings, no field', () => {
  assert.equal(bakeOcclusionField([]), null);
  assert.equal(bakeOcclusionField(null), null);
});

test('contact darkens at a wall foot and fades to nothing a few metres out', () => {
  const f = bakeOcclusionField([{ x: 0, z: 0, hw: 3, hd: 3, h: 6 }]);
  assert.ok(f.w > 0 && f.h > 0 && f.data.length === f.w * f.h * 2);
  const foot = at(f, 3.5, 0)[0];
  const mid = at(f, 5, 0)[0];
  const far = at(f, 9, 0)[0];
  assert.ok(foot > 0.5, `wall foot ${foot}`);
  assert.ok(mid < foot && mid > far, `falls off (${foot} > ${mid} > ${far})`);
  assert.equal(far, 0);
  // A lone house hides little sky.
  assert.ok(at(f, 3.5, 0)[1] < 0.15);
});

test('a taller wall throws more contact than a low one', () => {
  const low = bakeOcclusionField([{ x: 0, z: 0, hw: 3, hd: 3, h: 1 }]);
  const tall = bakeOcclusionField([{ x: 0, z: 0, hw: 3, hd: 3, h: 9 }]);
  assert.ok(at(tall, 4, 0)[0] > at(low, 4, 0)[0]);
});

test('a narrow alley between terraces is darker than open ground beside one', () => {
  const blocks = [];
  for (let k = 0; k < 6; k++) {
    blocks.push({ x: -5, z: k * 7, hw: 3.5, hd: 3.5, h: 10 });
    blocks.push({ x: 5, z: k * 7, hw: 3.5, hd: 3.5, h: 10 });
  }
  const f = bakeOcclusionField(blocks);
  const alley = at(f, 0, 17.5);       // 3 m wide alley between the rows
  const open = at(f, -10, 17.5);      // 1.5 m off the outer wall
  assert.ok(alley[1] > open[1] + 0.1, `sky term alley ${alley[1]} vs open ${open[1]}`);
  assert.ok(alley[0] >= open[0] - 0.02, `contact alley ${alley[0]} vs open ${open[0]}`);
});

test('tree clumps hide sky but never add contact', () => {
  const trees = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) trees.push({ x: 20 + i * 2.5, z: j * 2.5, r: 2 });
  // The field spans the built-up area: a second house frames the wood.
  const f = bakeOcclusionField([{ x: 0, z: 0, hw: 2, hd: 2, h: 4 }, { x: 55, z: 20, hw: 2, hd: 2, h: 4 }], trees);
  const [c, s] = at(f, 28, 9);
  assert.equal(c, 0);
  assert.ok(s > 0.05, `wood sky term ${s}`);
});

test('large towns coarsen the step instead of growing past the cap', () => {
  const f = bakeOcclusionField([{ x: -600, z: 0, hw: 2, hd: 2, h: 4 }, { x: 600, z: 0, hw: 2, hd: 2, h: 4 }], [], { maxDim: 256 });
  assert.ok(f.w <= 257 && f.step >= 5);
});

test('day factor: full by day, eased at night and under rain', () => {
  assert.equal(aoDayFactor({ night: 0, wet: 0 }), 1);
  assert.equal(aoDayFactor(undefined), 1);
  const night = aoDayFactor({ night: 1, wet: 0 });
  const rain = aoDayFactor({ night: 0, wet: 1 });
  const both = aoDayFactor({ night: 1, wet: 1 });
  assert.ok(night > 0.2 && night < 0.45);
  assert.ok(rain > 0.45 && rain < 0.65);
  assert.ok(both < Math.min(night, rain) && both > 0);
});

test('tiers: baked ground AO on low and medium, SSAO on high without double contact', () => {
  assert.equal(TIERS.low.ao, 'baked');
  assert.equal(TIERS.medium.ao, 'baked');
  assert.equal(TIERS.high.ao, 'ssao');
  assert.deepEqual(bakedWeights(TIERS.medium), [1, 1]);
  const [contact, sky] = bakedWeights(TIERS.high);
  assert.equal(contact, 0);
  assert.ok(sky > 0 && sky < 1);
  assert.deepEqual(bakedWeights({}), [0, 0]);
});
