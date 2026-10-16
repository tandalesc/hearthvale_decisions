import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGrade } from '../src/render/grade.js';
import { createAutoTuner, guessTier, TIERS } from '../src/render/quality.js';
import { composeLot, createSpecPool, PIECES } from '../src/render/kit/compose.js';
import * as G from '../src/render/kit/geometry.js';
import { buildRiverRibbon, buildNormalTile } from '../src/render/water.js';
import { createRoadSplat } from '../src/render/roads.js';
import { raycastTerrain } from '../src/render/terrain.js';
import { hashId } from '../src/render/shaderlib.js';
import { heightAt, riverX, WATER_HALF } from '../src/terrain.js';

const view = (yearT, weather = {}) => ({ time: { yearT }, weather: { rain: 0, snow: 0, wind: [0.5, 0.2], ...weather } });

test('grade sweeps the whole year without NaN, jumps or strobing', () => {
  const grade = createGrade();
  const u = grade.uniforms;
  let prev = null;
  let maxStep = 0;
  // 8x speed: one year in 7.5 s, frames at 60 Hz.
  const frames = 450;
  for (let i = 0; i <= frames * 2; i++) {
    const yearT = (i / frames) % 1;
    grade.update(view(yearT), i / 60, 1 / 60);
    const sample = [u.uSunColor.value.r, u.uSunColor.value.g, u.uNight.value, u.uSnow.value, ...u.uSunDir.value.toArray()];
    for (const v of sample) assert.ok(Number.isFinite(v), `finite at yearT ${yearT}`);
    if (prev) maxStep = Math.max(maxStep, ...sample.map((v, k) => Math.abs(v - prev[k])));
    prev = sample;
  }
  // Even across the year-end wrap no value moves more than 3% in one frame.
  assert.ok(maxStep < 0.03, `largest per-frame change ${maxStep}`);
});

test('seasonal grade: summer noon is bright, snow only in winter, night only at year end', () => {
  const settle = (yearT) => {
    const g = createGrade();
    g.update(view(yearT), 0, 1);
    return g.uniforms;
  };
  const summer = settle(0.4);
  assert.equal(summer.uSnow.value, 0);
  assert.ok(summer.uNight.value < 0.01);
  assert.ok(summer.uSunDir.value.y > 0.7, 'high summer sun');
  assert.ok(settle(0.95).uNight.value > 0.6, 'year-end night beat');
  assert.ok(settle(0.92).uSnow.value > 0.9, 'midwinter snow');
  for (const t of [0, 0.01, 0.05, 0.2]) assert.equal(settle(t).uSnow.value, 0, `no snow in spring at ${t}`);
  assert.ok(settle(0.66).uAutumn.value > 0.8, 'autumn colour');
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.85]) assert.ok(settle(t).uNight.value < 0.5, `no night at ${t}`);
});

test('day cycle off stays at noon; rain dims the sun', () => {
  const g = createGrade();
  g.setMode('off');
  g.update(view(0.96), 0, 1);
  assert.equal(g.uniforms.uNight.value, 0);
  const dry = createGrade();
  dry.update(view(0.4), 0, 1);
  const wet = createGrade();
  wet.update(view(0.4, { rain: 1 }), 0, 1);
  assert.ok(wet.current.sunI < dry.current.sunI * 0.6);
  assert.equal(wet.uniforms.uWet.value, 1);
});

test('auto quality tuner steps down on slow frames and leaves good frames alone', () => {
  const slow = createAutoTuner();
  let result = null;
  for (let i = 0; i < 200 && !result; i++) result = slow.sample(24, 'medium');
  assert.equal(result, 'low');
  const fine = createAutoTuner();
  let none = null;
  for (let i = 0; i < 400; i++) none = none ?? fine.sample(14, 'medium');
  assert.equal(none, null);
  assert.equal(guessTier({ MAX_TEXTURE_SIZE: 1, getParameter: () => 4096 }), 'low');
  for (const t of Object.values(TIERS)) assert.ok(t.shadowMapSize >= 1024 && t.pixelRatio <= 2);
});

const record = (over = {}) => ({
  id: 7, type: 'home', variant: 0, tier: 2, storeys: 2, x: -30, z: 12, rot: 0, w: 7, d: 8,
  styleEra: 1, wealth: 0.6, condition: 0.9, age: 12, built: 1, occupied: true, lit: true,
  chimney: true, smoke: 0.2, banner: null, extensions: [], flags: {}, ...over,
});

function specs(b) {
  const pool = createSpecPool();
  const summary = composeLot(b, pool);
  return { summary, list: pool.list().map((s) => ({ ...s, wall: s.wall.getHex(), roof: s.roof.getHex(), params: [...s.params], style: [...s.style], shape: [...s.shape] })) };
}

test('lot composer is deterministic and only emits known, finite pieces', () => {
  const types = ['home', 'shop', 'inn', 'workshop', 'farm', 'market', 'chapel', 'mill', 'factory', 'warehouse', 'quay', 'watch',
    'monument', 'moot', 'school', 'infirmary', 'library', 'theatre', 'exchange', 'union-hall', 'bathhouse', 'park', 'quarry'];
  for (const type of types) {
    for (let era = 0; era <= 5; era++) {
      for (const rot of [0, 1, 2, 3]) {
        const b = record({ type, styleEra: era, rot, id: era * 10 + rot });
        const a = specs(b);
        assert.deepEqual(a, specs(b), `${type} era ${era} deterministic`);
        for (const s of a.list) {
          assert.ok(PIECES.includes(s.piece), `${s.piece} is a kit piece`);
          for (const v of [s.x, s.y, s.z, s.yaw, s.sx, s.sy, s.sz]) assert.ok(Number.isFinite(v));
          assert.ok(s.sx > 0 && s.sy > 0 && s.sz > 0, `${type}/${s.piece} positive scale`);
        }
        if (type !== 'park') assert.ok(a.list.length >= 1, `${type} draws something`);
      }
    }
  }
});

test('square monuments vary by variant and era; quays stay at grade', () => {
  const kinds = new Set();
  for (const [variant, era, archetype] of [['cross', 1, 'cathedral'], ['fountain', 1, 'market-town'], ['fountain', 4, 'mill'], ['fountain', 4, 'garden']]) {
    const list = specs(record({ type: 'monument', variant, styleEra: era, archetype, flags: { square: 1 }, w: 2.4, d: 2.4 })).list.map((s) => s.piece);
    kinds.add(list.join(','));
  }
  assert.equal(kinds.size, 4, 'four distinct centrepieces');
  const q = specs(record({ type: 'quay', styleEra: 3, w: 10, d: 8 }));
  const apron = q.list.find((s) => s.piece === 'band');
  assert.ok(apron.y + apron.sy < q.summary.top + 0.3, 'apron is walkable, not a raised block');
});

test('silhouette follows the era: thatch early, flat roofs in the glass era', () => {
  const pieces = (era) => specs(record({ styleEra: era })).list.map((s) => s.piece);
  assert.ok(pieces(0).includes('thatch'));
  assert.ok(pieces(5).includes('flat'));
  assert.ok(!pieces(5).includes('thatch'));
});

test('construction shows a scaffold and no roof until late; completion removes the scaffold', () => {
  const early = specs(record({ built: 0.4 })).list.map((s) => s.piece);
  assert.ok(early.includes('scaffold'));
  assert.ok(!early.some((p) => ['gable', 'thatch', 'hip', 'flat', 'mansard'].includes(p)));
  const done = specs(record({ built: 1 })).list.map((s) => s.piece);
  assert.ok(!done.includes('scaffold'));
  const bodyH = (b) => specs(b).list.find((s) => s.piece === 'body').sy;
  assert.ok(bodyH(record({ built: 0.3 })) < bodyH(record({ built: 1 })));
});

test('kit pieces are flat-shaded with unit normals and valid parts', () => {
  const builders = [G.bodyPiece, () => G.pitchedRoof(G.PROFILES.gable), () => G.pitchedRoof(G.PROFILES.thatch), G.hipRoof, G.flatRoof,
    G.chimneyPiece, G.spirePiece, G.domePiece, G.sawtoothPiece, G.stackPiece, G.postsPiece, () => G.postsPiece({ planks: true }),
    G.porticoPiece, G.awningPiece, G.sailsPiece, G.fieldPiece, G.bannerPiece];
  for (const build of builders) {
    const g = build();
    assert.equal(g.index, null, 'non-indexed');
    const n = g.attributes.normal;
    const part = g.attributes.aPart;
    for (let i = 0; i < n.count; i++) {
      const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      assert.ok(Math.abs(len - 1) < 1e-3 || len === 0, 'unit normal');
      assert.ok(part.getX(i) >= 0 && part.getX(i) <= 8);
    }
    // One normal per triangle: all three corners share it.
    for (let t = 0; t < n.count; t += 3) {
      assert.ok(Math.abs(n.getY(t) - n.getY(t + 2)) < 1e-6);
    }
  }
  // Body walls face outward.
  const body = G.bodyPiece();
  const p = body.attributes.position, n = body.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const out = (p.getX(i) * n.getX(i) + (p.getY(i) - 0.5) * n.getY(i) + p.getZ(i) * n.getZ(i));
    assert.ok(out > 0, 'outward normal');
  }
});

test('river ribbon follows the channel with sane depth; normal tile is seamless', () => {
  const g = buildRiverRibbon({ zMin: -40, zMax: 40 });
  const pos = g.attributes.position, depth = g.attributes.aDepth;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    assert.ok(Math.abs(x - riverX(z)) <= WATER_HALF + 0.41);
    assert.ok(depth.getX(i) >= 0 && depth.getX(i) < 1);
  }
  const tile = buildNormalTile(64);
  const d = tile.image.data;
  // Tileable: the last column continues into the first.
  let seam = 0, inner = 0;
  for (let y = 0; y < 64; y++) {
    seam += Math.abs(d[(y * 64 + 63) * 4] - d[(y * 64) * 4]);
    inner += Math.abs(d[(y * 64 + 31) * 4] - d[(y * 64 + 32) * 4]);
  }
  assert.ok(seam < inner * 2 + 64, `seam ${seam} vs inner ${inner}`);
});

test('road splat encodes wear, tier and presence and refills on version change', () => {
  const W = 8, H = 8;
  const roads = { cell: 2, W, H, ox: 0, oz: 0, wear: new Float32Array(W * H), tier: new Uint8Array(W * H), planned: new Uint8Array(W * H), version: 1, dirty: null };
  roads.wear[9] = 3000; roads.tier[9] = 3;
  const splat = createRoadSplat();
  assert.ok(splat.update(roads, 0));
  const data = splat.uniforms.tRoad.value.image.data;
  assert.equal(data[9 * 4], 255);
  assert.equal(data[9 * 4 + 1], 153);
  assert.equal(data[9 * 4 + 2], 0, 'tiered cells are drawn by the path field, not as trampling');
  assert.equal(splat.tierAt(3, 3), 3);
  roads.tier[10] = 4; roads.version = 2;
  assert.equal(splat.update(roads, 0.1), false, 'throttled to 2 Hz');
  assert.ok(splat.update(roads, 0.7));
  assert.equal(data[10 * 4 + 1], 204);
  assert.equal(roads.dirty, null);
});

test('a grid of grass holes inside a trampled yard is filled; a path edge stays sharp', () => {
  // The pattern villagers leave: every other cell trodden, the rest untouched.
  const W = 12, H = 12;
  const roads = { cell: 2, W, H, ox: 0, oz: 0, wear: new Float32Array(W * H), tier: new Uint8Array(W * H), planned: new Uint8Array(W * H), version: 1, dirty: null };
  for (let z = 2; z < 8; z++) for (let x = 2; x < 8; x++) if ((x + z) % 2 === 0 || x % 2 === 0) roads.wear[z * W + x] = 400;
  // A plain worn path along row 10: its grass edge must not be filled.
  for (let x = 0; x < W; x++) roads.wear[10 * W + x] = 400;
  const splat = createRoadSplat();
  splat.update(roads, 0);
  const data = splat.uniforms.tRoad.value.image.data;
  const trampled = (x, z) => data[(z * W + x) * 4 + 2];
  // Inner holes (x odd, z odd, inside the yard) now read as trampled ground.
  for (const [x, z] of [[3, 4], [5, 4], [3, 6], [5, 6]]) {
    assert.equal(roads.wear[z * W + x], 0, 'a hole in the sim');
    assert.ok(trampled(x, z) > 60, `hole (${x}, ${z}) filled: ${trampled(x, z)}`);
  }
  // Grass beside the path keeps its edge.
  assert.equal(trampled(5, 9), 0);
  assert.equal(trampled(5, 11), 0);
});

test('terrain ray hits the ground under a downward ray', () => {
  const ray = new THREE.Ray(new THREE.Vector3(-40, 80, 30), new THREE.Vector3(0.2, -1, -0.1).normalize());
  const hit = new THREE.Vector3();
  assert.ok(raycastTerrain(ray, hit));
  assert.ok(Math.abs(hit.y - Math.max(heightAt(hit.x, hit.z), 0.025)) < 0.05);
  assert.ok(hashId(5) >= 0 && hashId(5) < 1 && hashId(5) === hashId(5));
});
