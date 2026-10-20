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

// Golden output: texture bytes, dirty rects, and pending queue order across
// mixed tiers, wear, paving/towpaths, budgeted redraws, unchanged updates, and
// replacement of the tier array. Regenerated when the busy-yard fill stopped
// filling inside corners and towpath bands (tests/paths.test.js covers both).
const EXPECTED = [
  'd5804a8086a57105d77a2cc2302ce3be9d0bcc1b661580a1c019ad808220e3f7',
  '121eb3d74992684308b1af42e9ee1328f014628f3c9301e4b4e136517b91c5c7',
  '77821a910fc7f253b3985b9a9b4717e5277592a58b4ec398f67f22d70c7698d5',
  'fe7625c57ca155cdad44e779d55aa62aa73688ee7b7a11debff8c814a1fb213b',
  'bc587a269340a5b3dad3fc65eee09aa76f37806460b31d1ef351a024da590812',
  '7513b8496cb91b374bfc4f78edb635eaaea1d97a8403f988979d5b085f451f6b',
  '7513b8496cb91b374bfc4f78edb635eaaea1d97a8403f988979d5b085f451f6b',
  'cca16ed79407d73d7c2015d2a9d3e84053a0507ee01cb730ffb7ed891224d228',
  'cc33638efc91f0aa45a89d555d887f0ad83f12e9ee22f387f9a47f670322058e'
];

test('path field keeps the original pixels and incremental updates', () => {
  assert.deepEqual(snapshots(createPathField), EXPECTED);
});
