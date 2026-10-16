// Main-thread route planner. Keeps a route cache in front of a navigation
// worker (or a cooperative scheduler when workers are unavailable), writes
// finished routes into walker tasks, and records river-crossing demand.
import { RouteScheduler, cellsToWaypoints } from './navigation.js';
import { terrainSeed, terrainVersion, terrainWaters } from './terrain.js';
import { countDeckTrips } from './sim/bridges.js';
import { navGrid, cellOf, cellCenter, nearestOpen, recordCrossingBand, WALKER_SCALE, footprints } from './sim/roads.js';

export function createRoutePlanner({ worker = true, maxPending = 1024, maxCache = 8192 } = {}) {
  const fallback = new RouteScheduler({ maxPending, maxCache: 1 });
  const cache = new Map();
  const waiting = new Map();
  const stats = { mode: 'cooperative', pending: 0, completed: 0, cacheHits: 0, requests: 0, rejected: 0 };
  let engine = null, grid = null, lastState = null, nextId = 0;
  let ticked = false; // tick() keeps the grid current (see enqueue)

  try {
    if (worker && typeof Worker !== 'undefined') {
      engine = new Worker(new URL('./navigation-worker.js', import.meta.url), { type: 'module' });
      stats.mode = 'worker';
      engine.onmessage = ({ data }) => finish(data.id, data.key, data);
      engine.onerror = () => {
        engine.terminate();
        engine = null;
        stats.mode = 'cooperative';
        for (const id of [...waiting.keys()]) finish(id, null, { cells: null, crossings: [] });
        if (grid) fallback.setGrid(grid);
      };
    }
  } catch {
    engine = null;
  }

  function sync(state, fresh = false) {
    lastState = state;
    const g = navGrid(state, { fresh });
    if (grid && g.key === grid.key) return g;
    const footprintsOnly = !!grid && g.bucket === grid.bucket;
    if (footprintsOnly) prune(cache, g.cost);
    else cache.clear();
    grid = g;
    // The worker's crossing analysis needs this town's river (terrain seed).
    if (engine) engine.postMessage({ type: 'grid', grid: { ...g, footprintsOnly, terrainSeed: terrainSeed(), terrainVersion: terrainVersion(), terrainArchetype: terrainWaters()?.forced ?? null } });
    else fallback.setGrid({ ...g, footprintsOnly });
    return g;
  }

  // Turns a cell path into waypoints and hands it to the job's consumer.
  function apply(job, result) {
    // A visible walk stands for several real trips (see WALKER_SCALE).
    if (lastState) {
      for (const band of result.crossings ?? []) recordCrossingBand(lastState, band, WALKER_SCALE);
      if (result.cells && grid) countDeckTrips(lastState, [...result.cells].filter(i => grid.water[i] === 3), WALKER_SCALE);
    }
    const start = job.start();
    job.deliver(result.cells ? cellsToWaypoints(grid, result.cells, start, job.goal) : null);
  }

  function finish(id, key, data) {
    const job = waiting.get(id);
    if (!job) return;
    waiting.delete(id);
    stats.completed++;
    stats.pending = waiting.size;
    if (data.rejected) {
      stats.rejected++;
      job.retry();
      return;
    }
    const result = { cells: data.cells ?? null, crossings: data.crossings ?? [] };
    if (grid && key === grid.key) remember(cache, job.cacheKey, result, maxCache);
    apply(job, result);
  }

  // Core request. Returns true if the route was delivered or queued. While
  // tick() runs every frame, a request uses the grid as it was at the start
  // of the frame: a road change mid-tick is picked up by the next tick, so the
  // rebuild lands in a frame of its own instead of on top of the sim's.
  function enqueue(state, x0, z0, goal, job) {
    const g = ticked && grid && state === lastState ? grid : sync(state);
    stats.requests++;
    const from = nearestOpen(state, cellOf(x0, z0));
    // Goals in the water or inside a wall move to the nearest open ground.
    let to = cellOf(goal.x, goal.z);
    let target = { x: goal.x, z: goal.z };
    if (to >= 0 && (!Number.isFinite(g.cost[to]) || g.water[to] === 1)) {
      const open = nearestOpen(state, to);
      if (open >= 0) { to = open; target = cellCenter(open); }
    }
    if (job.replanned) job.id = ++nextId;
    job.id ??= ++nextId;
    job.goal = target;
    job.cacheKey = `${from}>${to}`;
    const cached = cache.get(job.cacheKey);
    if (cached) {
      stats.cacheHits++;
      cache.delete(job.cacheKey);
      cache.set(job.cacheKey, cached);
      apply(job, cached);
      return true;
    }
    if (waiting.size >= maxPending) {
      stats.rejected++;
      return false;
    }
    waiting.set(job.id, job);
    stats.pending = waiting.size;
    if (engine) {
      engine.postMessage({ type: 'route', id: job.id, key: g.key, from, to });
      return true;
    }
    const key = g.key;
    const id = job.id;
    if (fallback.request(from, to, result => finish(id, key, result))) return true;
    waiting.delete(id);
    stats.pending = waiting.size;
    stats.rejected++;
    return false;
  }

  return {
    stats,
    sync,
    // people.js interface: onRoute(flat [x, z, ...] | null), maybe synchronously.
    // Returns false when busy; ask again later.
    plan(state, x0, z0, x1, z1, onRoute) {
      return enqueue(state, x0, z0, { x: x1, z: z1 }, {
        start: () => ({ x: x0, z: z0 }),
        deliver: onRoute,
        retry: () => {},
      });
    },
    // Task interface: the route lands in task.route (flat [x, z, ...], seg 0),
    // now or when ready; task.pending / task.blocked / task.needsRoute track it.
    request(state, person, goal, task) {
      const id = ++nextId;
      const live = () => person.task === task && task.routeRequest === id;
      task.routeRequest = id;
      task.needsRoute = false;
      task.pending = true;
      const ok = enqueue(state, person.x, person.z, goal, {
        id,
        start: () => ({ x: person.x, z: person.z }),
        deliver(route) {
          if (!live()) return;
          task.pending = false;
          task.seg = 0;
          task.route = route ?? [];
          task.blocked = !route;
          if (!route) task.retryAt = (task.elapsed ?? 0) + 3;
        },
        retry() {
          if (!live()) return;
          task.pending = false;
          task.needsRoute = true;
        },
      });
      if (!ok && live()) {
        task.pending = false;
        task.needsRoute = true;
      }
      return ok;
    },
    tick(state, budgetMs = 2) {
      if (state) {
        sync(state);
        ticked = true;
      }
      if (!engine) fallback.tick(budgetMs, 128);
      stats.pending = waiting.size;
    },
    dispose() {
      engine?.terminate();
      waiting.clear();
      cache.clear();
    },
  };
}

function remember(cache, key, value, max) {
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

function prune(cache, cost) {
  for (const [key, result] of cache) {
    const cells = result.cells;
    if (!cells) { cache.delete(key); continue; }
    for (let k = 1; k < cells.length - 1; k++) {
      if (!Number.isFinite(cost[cells[k]])) { cache.delete(key); break; }
    }
  }
}
