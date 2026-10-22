// Main-thread route planner. Keeps a route cache in front of a navigation
// worker (or a cooperative scheduler when workers are unavailable), writes
// finished routes into walker tasks, and records river-crossing demand.
import { RouteScheduler, cellsToWaypoints } from './navigation.js';
import { terrainSeed, terrainVersion, terrainWaters } from './terrain.js';
import { countDeckTrips } from './sim/bridges.js';
import { navGrid, cellOf, cellCenter, nearestOpen, recordCrossingBand, WALKER_SCALE, footprints } from './sim/roads.js';

// clock: what the cooperative fallback times its slices by (default
// performance.now). Tests pass a clock that never advances, so each tick runs
// its full slice cap and a run plans the same routes on a busy machine.
export function createRoutePlanner({ worker = true, maxPending = 1024, maxCache = 8192, clock } = {}) {
  const fallback = new RouteScheduler({ maxPending, maxCache: 1, ...(clock ? { clock } : {}) });
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
    if (engine) engine.postMessage({ type: 'grid', grid: gridMessage(g, footprintsOnly) });
    else fallback.setGrid({ ...g, footprintsOnly });
    return g;
  }

  // The grid for the worker, without the arrays it already has: those the last grid
  // sent shared (heights, path nodes, often the water codes) are named in `keep`, and a
  // cost array that differs from the last in few cells goes as those cells (`costPatch`).
  // The worker puts back the same arrays (navigation-worker.js).
  let sent = null;
  function gridMessage(g, footprintsOnly) {
    const msg = { ...g, fp: undefined, footprintsOnly, terrainSeed: terrainSeed(), terrainVersion: terrainVersion(), terrainArchetype: terrainWaters()?.forced ?? null, keep: [] };
    if (sent) {
      for (const k of GRID_ARRAYS) if (g[k] && g[k] === sent[k]) { msg[k] = undefined; msg.keep.push(k); }
      if (!msg.keep.includes('cost')) msg.costPatch = costPatch(sent.cost, g.cost);
      if (msg.costPatch) msg.cost = undefined;
    }
    sent = Object.fromEntries(GRID_ARRAYS.map(k => [k, g[k]]));
    return msg;
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
    // Start where the walker stands. A walker mid-ford or on a bridge deck starts
    // there too: nearestOpen only gives dry land, which can be across the deep
    // channel, and the first leg (from the walker to that cell) would wade it.
    // A walker in a ford that has just closed (a bridge opened nearby) wades
    // back out the way the ford goes, never across the deep channel.
    const here = cellOf(x0, z0);
    const wet = here >= 0 && g.water[here] > 0;
    let from = wet && (g.water[here] === 2 || g.water[here] === 3) && Number.isFinite(g.cost[here]) ? here : -1;
    if (from < 0 && wet) from = wadeOut(g, x0, z0, here);
    if (from < 0) from = nearestOpen(state, here, 6, true);
    // Goals in the water or inside a wall move to the nearest open ground.
    let to = cellOf(goal.x, goal.z);
    let target = { x: goal.x, z: goal.z };
    if (to >= 0 && (!Number.isFinite(g.cost[to]) || g.water[to] === 1)) {
      const open = nearestOpen(state, to, 6, true);
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

const GRID_ARRAYS = ['cost', 'water', 'height', 'nodeX', 'nodeZ', 'nodeLinks'];

// From a walker standing in water at (x0, z0), cell `here`: the nearest passable
// cell it can wade to, searching through shallow water only (fords, decks), and
// whose straight leg from the walker crosses no deep water. -1 if none is near.
const WADE_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function wadeOut(g, x0, z0, here, radius = 12) {
  const { W, H, water, cost } = g;
  const seen = new Set([here]);
  let frontier = [here];
  for (let step = 0; step < radius && frontier.length; step++) {
    const next = [];
    for (const i of frontier) {
      const x = i % W, z = (i - x) / W;
      for (const [dx, dz] of WADE_STEPS) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        const j = nz * W + nx;
        if (seen.has(j)) continue;
        seen.add(j);
        // Deep water is never waded; dry ground that is walled off is not a way through.
        if (water[j] === 1 || (!water[j] && !Number.isFinite(cost[j]))) continue;
        if (Number.isFinite(cost[j]) && shallowLeg(g, x0, z0, j)) return j;
        next.push(j);
      }
    }
    frontier = next;
  }
  return -1;
}

// Does the straight leg from (x0, z0) to cell j's centre keep out of deep water?
function shallowLeg(g, x0, z0, j) {
  const { W, ox, oz, cell, water } = g;
  const x1 = ox + (j % W + 0.5) * cell, z1 = oz + (Math.floor(j / W) + 0.5) * cell;
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (cell * 0.25));
  for (let k = 0; k <= steps; k++) {
    const t = steps ? k / steps : 0;
    const i = Math.floor((z0 + (z1 - z0) * t - oz) / cell) * W + Math.floor((x0 + (x1 - x0) * t - ox) / cell);
    if (water[i] === 1) return false;
  }
  return true;
}

// The cells where cost b differs from a (by their bits) and b's values there, or null
// when there are many (sending the whole array is then as cheap).
function costPatch(a, b) {
  if (!(a instanceof Float32Array) || !(b instanceof Float32Array) || a.length !== b.length) return null;
  const wa = new Uint32Array(a.buffer, a.byteOffset, a.length), wb = new Uint32Array(b.buffer, b.byteOffset, b.length);
  const limit = b.length >> 4;
  const idx = [];
  for (let i = 0; i < wb.length; i++) {
    if (wa[i] === wb[i]) continue;
    if (idx.length >= limit) return null;
    idx.push(i);
  }
  const at = Int32Array.from(idx), val = new Float32Array(at.length);
  for (let k = 0; k < at.length; k++) val[k] = b[at[k]];
  return { idx: at, val };
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
