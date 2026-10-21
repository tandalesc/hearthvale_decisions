import test from 'node:test';
import assert from 'node:assert/strict';
import { Geo, buildFoot, buildEmbankment, buildCrossing, createProps } from '../src/render/props.js';
import * as THREE from 'three';
import {createGrade} from '../src/render/grade.js';
import { riverX, heightAt, WATER_HALF, riverLift, setTerrainSeed, terrainSeed } from '../src/terrain.js';
import { ARCHETYPES } from '../src/waters.js';
import { GRID_H, ORIGIN_Z, CELL } from '../src/sim/roads.js';
import { BRIDGE_DECK } from '../src/sim/people.js';

const ys = (g) => g.p.filter((_, i) => i % 3 === 1);

test('street furniture rebuilds after the one-second boundary and ground changes', () => {
  const scene = new THREE.Scene();
  let groundVersion = 1;
  const props = createProps({scene, grade: createGrade(), heightAt, ground: {version: () => groundVersion}});
  const view = {era: 0, roads: {version: 1}, buildings: [], bridges: [], lamps: [], projects: []};
  const mesh = scene.getObjectByName('props').children[0];
  const update = (time) => props.update(view, {time, target: new THREE.Vector3()});
  try {
    update(0);
    const first = mesh.geometry;
    view.roads.version++;
    update(0.5);
    update(1);
    assert.equal(mesh.geometry, first, 'the exact boundary remains throttled');
    update(1.001);
    const second = mesh.geometry;
    assert.notEqual(second, first, 'a pending road change is rendered after the boundary');
    update(2.002);
    assert.equal(mesh.geometry, second, 'unchanged furniture keeps its geometry');
    groundVersion++;
    update(2.003);
    assert.notEqual(mesh.geometry, second, 'new ground pads re-seat the same furniture');
  } finally {
    props.dispose();
  }
});

// Bridge beds, pier feet and quay-wall feet (props.js) are set for the town
// reaches, where the water stands at 0.025 and the bed at -0.8 or the ford's
// -0.22: they hide under the drawn bed there. They would show (or bury the
// arches) where the river comes down from the mountains, which only happens
// well outside the land the sim builds on. This pins that down.
test('the river is never raised where bridges and quays can stand', () => {
  const before = terrainSeed();
  try {
    const z0 = ORIGIN_Z, z1 = ORIGIN_Z + GRID_H * CELL;
    let beyond = 0;
    for (let seed = 1; seed <= 24; seed++) {
      setTerrainSeed(seed, 2, ARCHETYPES[seed % ARCHETYPES.length]);
      for (let z = z0; z <= z1; z += 4) assert.ok(riverLift(z) < 0.01, `seed ${seed} (${ARCHETYPES[seed % ARCHETYPES.length]}): river raised ${riverLift(z).toFixed(2)} at z ${z}`);
      for (const z of [-900, 900]) beyond = Math.max(beyond, riverLift(z));
    }
    assert.ok(beyond > 1, 'the river does come down from the mountains further out');
  } finally {
    setTerrainSeed(before);
  }
});

test('footbridge: a narrow plank walkway at the walkers deck height', () => {
  const g = new Geo();
  const z = 10, x = riverX(z);
  buildFoot(g, { id: 1, z, x0: x - WATER_HALF - 3, x1: x + WATER_HALF + 3, style: 'footbridge', built: 1 }, heightAt);
  assert.ok(g.p.length > 300, 'has geometry');
  const deckTops = ys(g).filter((y) => Math.abs(y - BRIDGE_DECK) < 0.08);
  assert.ok(deckTops.length > 20, 'planks sit at the deck height walkers use');
  for (let i = 2; i < g.p.length; i += 3) assert.ok(Math.abs(g.p[i] - z) < 1.2, 'narrow: within 1.2 of the centreline');
});

test('embankment: walkable top flush with the ground, nothing proud on the land side early on', () => {
  const g = new Geo();
  const run = { side: 'west', z0: 0, z1: 20, crossings: [] };
  buildEmbankment(g, run, heightAt, 1, []);
  const top = Math.max(...ys(g));
  const ground = Math.max(...[0, 5, 10, 15, 20].map((z) => heightAt(riverX(z) - WATER_HALF - 0.7, z)));
  // Bollards (0.56 m) are the only things above the coping before era 3.
  assert.ok(top < ground + 0.03 + 0.6, `top ${top} vs ground ${ground}`);
  const civic = new Geo();
  buildEmbankment(civic, run, heightAt, 3, []);
  assert.ok(Math.max(...ys(civic)) > top - 0.1, 'era 3 adds a parapet');
});

test('crossings: steps, ramps and slipways all build oriented geometry', () => {
  for (const kind of ['steps', 'ramp', 'slipway']) {
    const g = new Geo();
    buildCrossing(g, { x: riverX(40) - WATER_HALF, z: 40, side: 'west', kind, dir: [1, 0] }, heightAt, 2, []);
    assert.ok(g.p.length > 50, `${kind} has geometry`);
    for (const v of g.p) assert.ok(Number.isFinite(v));
  }
  // A ramp follows the ground: no vertex hovers more than 0.3 above it.
  const g = new Geo();
  buildCrossing(g, { x: riverX(40) - WATER_HALF, z: 40, side: 'west', kind: 'ramp', dir: [1, 0] }, heightAt, 2, []);
  for (let i = 0; i < g.p.length; i += 3) {
    const gy = Math.max(heightAt(g.p[i], g.p[i + 2]), -0.3);
    assert.ok(g.p[i + 1] - gy < 0.35, 'draped');
  }
});
