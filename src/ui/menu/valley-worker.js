// Samples a valley's terrain for the main menu's map, off the main thread.
// The terrain module keeps its seed as module state, so sampling here also
// leaves the page's own terrain untouched.
import {setTerrainSeed, heightAt, waterKindAt, bankDistance, riverX, hasRiver, terrainInfo, FORDS} from '../../terrain.js';

self.onmessage = (e) => {
  const {id, seed, version, archetype, size, extent} = e.data;
  setTerrainSeed(seed, version, archetype);
  const heights = new Float32Array(size * size);
  const kinds = new Uint8Array(size * size);
  // Distance to the water's edge (negative over water), clamped so it blends.
  const banks = new Float32Array(size * size);
  const step = (extent * 2) / (size - 1);
  for (let j = 0; j < size; j++) {
    const z = -extent + j * step;
    for (let i = 0; i < size; i++) {
      const x = -extent + i * step;
      const k = j * size + i;
      heights[k] = heightAt(x, z);
      kinds[k] = waterKindAt(x, z);
      banks[k] = Math.max(-40, Math.min(40, bankDistance(x, z)));
    }
  }
  const river = hasRiver();
  // The first huts go up near the crossing closest to the middle of the valley.
  const ford = river ? FORDS.reduce((a, f) => (Math.abs(f.z) < Math.abs(a.z) ? f : a), FORDS[0]) : null;
  const info = terrainInfo();
  self.postMessage({
    id, size, extent, heights, kinds, banks,
    archetype: info.archetype ?? 'river',
    river,
    fords: river ? FORDS.map((f) => ({x: riverX(f.z), z: f.z})) : [],
    hamlet: ford ? {x: riverX(ford.z), z: ford.z} : {x: 0, z: 0},
  }, [heights.buffer, kinds.buffer, banks.buffer]);
};
