import test from 'node:test';
import assert from 'node:assert/strict';
import { setTerrainSeed, terrainSeed, riverX, heightAt, waterLevelAt, WATER_HALF, FORDS } from '../src/terrain.js';
import { riverInfo, riverBarLift, riverBedAt, rapidsAt, riverRocks, riverRapidsSites, rapidsSources } from '../src/river.js';
import { buildRiverRibbon } from '../src/render/water.js';
import { buildGeometry, KIND } from '../src/render/trees.js';

test('river character is deterministic, bounded and render-only', () => {
  const before = terrainSeed();
  try {
    setTerrainSeed(1888);
    const a = riverRocks().map((r) => [r.x, r.z, r.r]);
    setTerrainSeed(15);
    riverRocks();
    setTerrainSeed(1888);
    assert.deepEqual(riverRocks().map((r) => [r.x, r.z, r.r]), a, 'same seed, same boulders');
    let pools = 0, riffles = 0, bars = 0;
    for (let z = -900; z <= 900; z += 3) {
      const i = riverInfo(z);
      for (const k of ['rapids', 'riffle', 'cascade', 'pool']) assert.ok(i[k] >= 0 && i[k] <= 1, `${k} in 0..1 at ${z}`);
      assert.ok(i.speed > 0.3 && i.speed < 3, `speed ${i.speed}`);
      if (i.pool > 0.5) pools++;
      if (i.riffle > 0.3) riffles++;
      if (i.barWidth > 2) bars++;
      // The sim's terrain is untouched; bars only lift the render bed in the channel.
      const x = riverX(z) + Math.sin(z * 12.9898) * (WATER_HALF + 4);
      assert.ok(riverBarLift(x, z) >= 0);
      assert.ok(riverBedAt(x, z) >= heightAt(x, z));
      if (Math.abs(x - riverX(z)) > WATER_HALF + 1.7) assert.equal(riverBarLift(x, z), 0);
      assert.ok(rapidsAt(x, z) >= 0 && rapidsAt(x, z) <= 1);
    }
    assert.ok(pools > 20 && riffles > 10 && bars > 20, `pools ${pools}, riffles ${riffles}, bars ${bars}`);
    // Fords stay clear of bars and boulders.
    for (const f of FORDS) assert.ok(riverInfo(f.z).barWidth < 0.5, `bar at ford ${f.z}`);
    for (const r of riverRocks()) {
      assert.ok(Math.abs(r.x - riverX(r.z)) < WATER_HALF, 'boulders sit in the channel');
      assert.ok(FORDS.every((f) => Math.abs(r.z - f.z) > f.half), 'no boulders on a ford');
      assert.ok(Number.isFinite(r.y) && r.y < waterLevelAt(r.z) + r.r);
    }
    const sites = riverRapidsSites();
    assert.ok(sites.length > 0);
    for (let i = 1; i < sites.length; i++) assert.ok(sites[i].z > sites[i - 1].z);
    assert.ok(sites.some((s) => s.kind === 'cascade'), 'mountain reaches run as cascades');
    // Audio hook: plain, bounded sources that repeat for the seed.
    const src = rapidsSources();
    assert.ok(src.length > 3);
    assert.deepEqual(JSON.parse(JSON.stringify(src)), rapidsSources());
    for (const w of src) {
      assert.ok(w.intensity > 0 && w.intensity <= 1 && w.radius > WATER_HALF && w.radius < 60);
      assert.ok(Math.abs(w.x - riverX(w.z)) < 0.2, 'sources sit on the river');
    }
  } finally {
    setTerrainSeed(before);
  }
});

test('river ribbon depth sees the gravel bars; tree levels stay within budget', () => {
  const before = terrainSeed();
  try {
    setTerrainSeed(1888);
    const g = buildRiverRibbon({ zMin: -200, zMax: -100 });
    const d = g.attributes.aDepth, d0 = g.attributes.aDepth0;
    let shallower = 0;
    for (let i = 0; i < d.count; i++) {
      assert.ok(d.getX(i) <= d0.getX(i) + 1e-6, 'bars only ever make the water shallower');
      if (d.getX(i) < d0.getX(i) - 0.2) shallower++;
    }
    assert.ok(shallower > 0, 'some bars in a bendy reach');
  } finally {
    setTerrainSeed(before);
  }
  for (const k of Object.values(KIND)) {
    const far = buildGeometry(k, 0).attributes.position.count / 3;
    const near = buildGeometry(k, 1).attributes.position.count / 3;
    assert.ok(far <= 48, `far level of kind ${k}: ${far} triangles`);
    assert.ok(near <= 160, `near level of kind ${k}: ${near} triangles`);
    const n = buildGeometry(k, 1).attributes.normal;
    for (let i = 0; i < n.count; i++) assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-3);
  }
});
