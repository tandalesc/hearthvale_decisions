// Runs grid route searches and flow fields off the main thread.
// Messages in:  {type: 'grid', grid (with terrainSeed; keep / costPatch: see below)} | {type: 'route', id, key, from, to}
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

// The last grid: a grid message leaves out the arrays it shares with it (keep) and may
// send its costs as the cells that changed (costPatch); see route-planner.js gridMessage.
let last = null;

self.onmessage = ({ data }) => {
  if (data.type === 'grid') {
    const grid = data.grid;
    for (const k of grid.keep ?? []) grid[k] = last[k];
    if (grid.costPatch) {
      const cost = last.cost.slice(), { idx, val } = grid.costPatch;
      for (let k = 0; k < idx.length; k++) cost[idx[k]] = val[k];
      grid.cost = cost;
      grid.costPatch = undefined;
    }
    last = grid;
    useTerrain(grid.terrainSeed ?? null, grid.terrainVersion ?? 1, grid.terrainArchetype ?? null);
    scheduler.setGrid(grid);
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
