// Runs grid route searches and flow fields off the main thread.
// Messages in:  {type: 'grid', grid (with terrainSeed)} | {type: 'route', id, key, from, to}
// Messages out: {id, key, cells: Int32Array | null, crossings: number[]}
import { RouteScheduler } from './navigation.js';
import { useTerrain } from './terrain.js';

const scheduler = new RouteScheduler({ maxCache: 2048 });
let running = false;

function pump() {
  scheduler.tick(8, 1024);
  if (scheduler.pending) setTimeout(pump, 0);
  else running = false;
}

self.onmessage = ({ data }) => {
  if (data.type === 'grid') {
    useTerrain(data.grid.terrainSeed ?? null, data.grid.terrainVersion ?? 1, data.grid.terrainArchetype ?? null);
    scheduler.setGrid(data.grid);
    return;
  }
  if (data.type !== 'route') return;
  const reply = result => postMessage({ id: data.id, key: data.key, cells: result.cells, crossings: result.crossings, stats: scheduler.stats });
  if (!scheduler.request(data.from, data.to, reply)) {
    postMessage({ id: data.id, key: data.key, cells: null, crossings: [], rejected: true });
  }
  if (!running) {
    running = true;
    setTimeout(pump, 0);
  }
};
