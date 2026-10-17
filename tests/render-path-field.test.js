import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPathField} from '../src/render/paths.js';
import {setTerrainSeed} from '../src/terrain.js';

function snapshots(createPathField) {
  setTerrainSeed(null);
  const W = 32, H = 32;
  const roads = {
    W, H, cell: 2, ox: -32, oz: -32,
    tier: new Uint8Array(W * H),
    wear: new Float32Array(W * H),
    planned: new Uint8Array(W * H),
  };
  const tierWear = [0, 65, 310, 1210, 2500, 3000];
  for (let i = 0; i < W * H; i++) {
    roads.tier[i] = (i * 7 + Math.floor(i / W) * 11) % 6;
    roads.wear[i] = tierWear[roads.tier[i]] * (1 + (i % 3) * 0.4);
    roads.planned[i] = i % 5 === 0 ? 17 : i % 3 === 0 ? 1 : 0;
  }
  const field = createPathField(roads);
  const hashes = [];
  const capture = (budget) => {
    const rects = field.update(roads, budget);
    hashes.push(createHash('sha256')
      .update(field.data)
      .update(JSON.stringify([rects, field.pending()]))
      .digest('hex'));
  };
  capture(Infinity);
  for (let j = 0; j < 48; j++) {
    const i = j * 53 % (W * H);
    roads.tier[i] = (roads.tier[i] + 1) % 6;
    roads.wear[i] = j % 2 ? 2999 : 62;
    roads.planned[i] ^= j % 3 ? 1 : 17;
  }
  for (const budget of [1, 3, 7, Infinity, Infinity, Infinity]) capture(budget);
  roads.tier = roads.tier.slice();
  capture(2);
  capture(Infinity);
  return hashes;
}

// Immutable pre-optimization main (4bf9a75) output: texture bytes, dirty rects,
// and pending queue order across mixed tiers, wear, paving/towpaths, budgeted
// redraws, unchanged updates, and replacement of the tier array.
const EXPECTED = [
  'fbf78f2567bd61a45aa0a750b23c1a021c41e7436d8c77cebf6f71e4e076907f',
  '880edafd179054333dd4cd32908cffde31a53b3c8ec3b66acde5d056f3b4d4ac',
  '648d901a7f4101801fb9fc2779d337fad4e969d565177ab9c98f8e79016aadd6',
  '8441303cbbf449e20bb0929ebc3e75689c9a3b1f465d2c893764bc6aeaa657c5',
  '5530aa603744cbbd597c979b34c26e3bc035b2edf027a22dfc5fe818fcabdc54',
  'dab0434db5fe2ea8ff1f530ccee28baa1cb837f1efbed11853b8079d29ecaddd',
  'dab0434db5fe2ea8ff1f530ccee28baa1cb837f1efbed11853b8079d29ecaddd',
  '5ec4e9c74bf46ab88d3c823e524bad0a3219a3e1e7509a07632a808e0a9398cd',
  '29aff630aad1b4ba2591bb1e74778909321f1e8801d9e8fbcb0cefb599a87c69'
];

test('path field keeps the original pixels and incremental updates', () => {
  assert.deepEqual(snapshots(createPathField), EXPECTED);
});
