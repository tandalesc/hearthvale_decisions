// Grid navigation shared by the navigation worker and the main-thread
// fallback. Pure: it knows nothing about game state, only a nav grid
// `{key, bucket, footprintsOnly, W, H, ox, oz, cell, cost: Float32Array,
// water: Uint8Array}` built by src/sim/roads.js (navGrid).
//
// water codes: 0 land, 1 deep water, 2 ford, 3 bridge.
import { riverX } from './terrain.js';

const SQRT2 = Math.SQRT2;
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [-1, 1, SQRT2], [1, -1, SQRT2], [-1, -1, SQRT2],
];
export const H_WEIGHT = 0.6;
export const ENDPOINT_COST = 1.2;
export const DETOUR_CELLS = 40;
export const BAND_CELLS = 8;
// Extra cost per step for climbing: GRADE_COST x grade^2 x step length, so
// paths take the contour and switch back rather than charge up a hill.
export const GRADE_COST = 5;
const SLICE = 512;

function climb(grid, a, b, len) {
  const h = grid.height;
  if (!h) return 0;
  const grade = (h[b] - h[a]) / (len * grid.cell);
  return GRADE_COST * grade * grade * len;
}

// ---------------------------------------------------------------- heap

class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.length = 0;
  }
  clear() { this.length = 0; }
  grow() {
    const keys = new Float64Array(this.keys.length * 2);
    const vals = new Int32Array(this.vals.length * 2);
    keys.set(this.keys);
    vals.set(this.vals);
    this.keys = keys;
    this.vals = vals;
  }
  push(key, val) {
    if (this.length === this.keys.length) this.grow();
    const { keys, vals } = this;
    let i = this.length++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  // Returns the value with the smallest key; `this.top` holds that key.
  pop() {
    const { keys, vals } = this;
    const val = vals[0];
    this.top = keys[0];
    const n = --this.length;
    if (n > 0) {
      const k = keys[n], v = vals[n];
      let i = 0;
      while (true) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return val;
  }
}

// ---------------------------------------------------------------- scratch

// One search at a time per scratch. Stamps avoid clearing arrays per search.
export function createScratch(size) {
  return {
    g: new Float32Array(size),
    parent: new Int32Array(size),
    seen: new Uint32Array(size),
    closed: new Uint32Array(size),
    stamp: 0,
    heap: new MinHeap(4096),
  };
}

function nextStamp(s) {
  s.stamp = (s.stamp + 1) >>> 0;
  if (s.stamp === 0) { s.seen.fill(0); s.closed.fill(0); s.stamp = 1; }
  return s.stamp;
}

function costOf(grid, i, from, to) {
  const c = grid.cost[i];
  if (i === from || i === to) return Number.isFinite(c) ? c : ENDPOINT_COST;
  return c;
}

function octile(dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);
  return Math.max(ax, az) + (SQRT2 - 1) * Math.min(ax, az);
}

// ---------------------------------------------------------------- components

// Connected regions of passable cells. Diagonal steps may not cut corners,
// so a diagonal is only possible when both side cells are open: 8-neighbour
// regions are exactly the 4-neighbour ones. Cached on the grid object. Lets
// unreachable requests fail at once instead of exploring the whole map.
export function components(grid) {
  if (grid.comp) return grid.comp;
  const { W, H, cost } = grid;
  const N = W * H;
  const open = new Uint8Array(N);
  for (let i = 0; i < N; i++) open[i] = cost[i] < Infinity ? 1 : 0;
  const comp = new Int32Array(N);
  const stack = new Int32Array(N);
  let label = 0;
  for (let i = 0; i < N; i++) {
    if (comp[i] || !open[i]) continue;
    label++;
    let top = 0;
    stack[top++] = i;
    comp[i] = label;
    while (top) {
      const cur = stack[--top];
      const cx = cur % W;
      if (cx > 0 && open[cur - 1] && !comp[cur - 1]) { comp[cur - 1] = label; stack[top++] = cur - 1; }
      if (cx < W - 1 && open[cur + 1] && !comp[cur + 1]) { comp[cur + 1] = label; stack[top++] = cur + 1; }
      if (cur >= W && open[cur - W] && !comp[cur - W]) { comp[cur - W] = label; stack[top++] = cur - W; }
      if (cur < N - W && open[cur + W] && !comp[cur + W]) { comp[cur + W] = label; stack[top++] = cur + W; }
    }
  }
  grid.comp = comp;
  return comp;
}

// Regions an endpoint can start in: its own, or (inside a footprint, where
// endpoints are allowed) those of its passable neighbours.
function regionsOf(grid, comp, i) {
  if (comp[i]) return [comp[i]];
  const { W, H } = grid;
  const cx = i % W, cz = (i - cx) / W;
  const out = [];
  for (const [dx, dz] of DIRS) {
    const nx = cx + dx, nz = cz + dz;
    if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
    const c = comp[nz * W + nx];
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export function reachable(grid, from, to) {
  if (from === to) return true;
  const comp = components(grid);
  const a = regionsOf(grid, comp, from), b = regionsOf(grid, comp, to);
  if (a.some(c => b.includes(c))) return true;
  // Two neighbouring endpoints inside one footprint can still step directly.
  const dx = Math.abs(from % grid.W - to % grid.W), dz = Math.abs(Math.floor(from / grid.W) - Math.floor(to / grid.W));
  return Math.max(dx, dz) <= 1;
}

// ---------------------------------------------------------------- A*

// ---------------------------------------------------------------- long trips

// Trips longer than LONG_TRIP cells search in two steps: a coarse path over
// BLOCK x BLOCK cell blocks, then the fine search kept to a corridor of blocks
// around it. Falls back to the full search if the corridor is a dead end.
export const LONG_TRIP = 96;
export const BLOCK = 8;

function coarseOf(grid) {
  if (grid.coarse) return grid.coarse;
  const { W, H, cost } = grid;
  const CW = Math.ceil(W / BLOCK), CH = Math.ceil(H / BLOCK);
  const ccost = new Float32Array(CW * CH);
  for (let bz = 0; bz < CH; bz++)
    for (let bx = 0; bx < CW; bx++) {
      let sum = 0, open = 0, all = 0;
      for (let z = bz * BLOCK; z < Math.min(H, (bz + 1) * BLOCK); z++)
        for (let x = bx * BLOCK; x < Math.min(W, (bx + 1) * BLOCK); x++) {
          all++;
          const c = cost[z * W + x];
          if (Number.isFinite(c)) { sum += c; open++; }
        }
      ccost[bz * CW + bx] = open >= all * 0.25 ? sum / open : Infinity;
    }
  grid.coarse = { CW, CH, cost: ccost };
  return grid.coarse;
}

function corridorMask(grid, from, to) {
  const { W } = grid;
  const { CW, CH, cost } = coarseOf(grid);
  const block = i => Math.floor((i % W) / BLOCK) + Math.floor(Math.floor(i / W) / BLOCK) * CW;
  const a = block(from), b = block(to);
  const g = new Float32Array(CW * CH).fill(Infinity), parent = new Int32Array(CW * CH).fill(-1);
  const heap = new MinHeap(256);
  const closed = new Uint8Array(CW * CH);
  const bxOf = i => i % CW, bzOf = i => Math.floor(i / CW);
  g[a] = 0;
  heap.push(0, a);
  while (heap.length) {
    const cur = heap.pop();
    if (cur === b) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    for (const [dx, dz, len] of DIRS) {
      const nx = bxOf(cur) + dx, nz = bzOf(cur) + dz;
      if (nx < 0 || nz < 0 || nx >= CW || nz >= CH) continue;
      const n = nz * CW + nx;
      const c = n === b ? 1 : cost[n];
      if (!Number.isFinite(c)) continue;
      const ng = g[cur] + len * c;
      if (ng >= g[n]) continue;
      g[n] = ng;
      parent[n] = cur;
      heap.push(ng + octile(nx - bxOf(b), nz - bzOf(b)) * 0.4, n);
    }
  }
  if (!Number.isFinite(g[b])) return null;
  const mask = new Uint8Array(CW * CH);
  for (let i = b; i !== -1; i = parent[i]) {
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = bxOf(i) + dx, z = bzOf(i) + dz;
        if (x >= 0 && z >= 0 && x < CW && z < CH) mask[z * CW + x] = 1;
      }
    if (i === a) break;
  }
  return { mask, CW };
}

// Generator: yields every SLICE expansions so callers can spread work over
// frames. Returns {cells: Int32Array, cost, expanded} or null.
export function* searchJob(grid, scratch, from, to, opts = {}) {
  const { W, H } = grid;
  if (from < 0 || to < 0 || from >= W * H || to >= W * H) return null;
  if (from === to) return { cells: Int32Array.of(from), cost: 0, expanded: 0 };
  if (!reachable(grid, from, to)) return null;
  const far = octile(from % W - to % W, Math.floor(from / W) - Math.floor(to / W)) > LONG_TRIP;
  if (far && !opts.corridor && opts.corridor !== false) {
    const corridor = corridorMask(grid, from, to);
    if (corridor) {
      const found = yield* searchJob(grid, scratch, from, to, { ...opts, corridor });
      if (found) return found;
    }
    return yield* searchJob(grid, scratch, from, to, { ...opts, corridor: false });
  }
  const maxNodes = opts.maxNodes ?? 120000;
  const hw = opts.hWeight ?? H_WEIGHT;
  const corridor = opts.corridor || null;
  const s = scratch;
  const stamp = nextStamp(s);
  const { g, parent, seen, closed, heap } = s;
  const tx = to % W, tz = (to - tx) / W;
  heap.clear();
  g[from] = 0;
  parent[from] = -1;
  seen[from] = stamp;
  heap.push(octile(from % W - tx, Math.floor(from / W) - tz) * hw, from);
  let expanded = 0;
  while (heap.length) {
    const cur = heap.pop();
    if (closed[cur] === stamp) continue;
    closed[cur] = stamp;
    if (cur === to) return { cells: tracePath(parent, to), cost: g[to], expanded };
    if (++expanded > maxNodes) return null;
    if (expanded % SLICE === 0) yield expanded;
    const cx = cur % W, cz = (cur - cx) / W;
    const cc = costOf(grid, cur, from, to);
    for (let d = 0; d < 8; d++) {
      const [dx, dz, len] = DIRS[d];
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const n = nz * W + nx;
      if (closed[n] === stamp) continue;
      if (corridor && !corridor.mask[Math.floor(nx / BLOCK) + Math.floor(nz / BLOCK) * corridor.CW]) continue;
      const nc = costOf(grid, n, from, to);
      if (!Number.isFinite(nc)) continue;
      if (dx && dz && (!Number.isFinite(costOf(grid, cz * W + nx, from, to)) || !Number.isFinite(costOf(grid, nz * W + cx, from, to)))) continue;
      const ng = g[cur] + len * (cc + nc) * 0.5 + climb(grid, cur, n, len);
      if (seen[n] === stamp && ng >= g[n]) continue;
      seen[n] = stamp;
      g[n] = ng;
      parent[n] = cur;
      heap.push(ng + octile(nx - tx, nz - tz) * hw, n);
    }
  }
  return null;
}

function tracePath(parent, to) {
  const out = [];
  for (let i = to; i !== -1; i = parent[i]) out.push(i);
  out.reverse();
  return Int32Array.from(out);
}

// The cost of a cell path, exactly as the searches count it.
export function pathCost(grid, cells) {
  const W = grid.W;
  let c = 0;
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1], b = cells[k];
    const len = Math.hypot((a % W) - (b % W), Math.floor(a / W) - Math.floor(b / W));
    c += len * (grid.cost[a] + grid.cost[b]) * 0.5 + climb(grid, a, b, len);
  }
  return c;
}

export function runToEnd(job) {
  let r;
  do { r = job.next(); } while (!r.done);
  return r.value;
}

let sharedScratch = null;

// Synchronous route with crossing analysis. Used by tests and by the monthly
// group routes; walkers go through the scheduler instead.
export function findRoute(grid, from, to, opts = {}) {
  const size = grid.W * grid.H;
  if (!sharedScratch || sharedScratch.g.length !== size) sharedScratch = createScratch(size);
  const found = runToEnd(searchJob(grid, sharedScratch, from, to, opts));
  return { cells: found?.cells ?? null, cost: found?.cost ?? Infinity, crossings: crossingsFor(grid, found?.cells ?? null, from, to) };
}

// ---------------------------------------------------------------- flow fields

// Dijkstra outward from a goal. next[i] is the neighbour of i one step closer
// to the goal; -1 where unreached. Edge costs are symmetric, so following
// next from any cell gives a shortest route to the goal.
export function* flowFieldJob(grid, scratch, goal, opts = {}) {
  const { W, H } = grid;
  const maxNodes = opts.maxNodes ?? W * H;
  const s = scratch;
  const stamp = nextStamp(s);
  const { g, seen, closed, heap } = s;
  const next = new Int32Array(W * H).fill(-1);
  heap.clear();
  g[goal] = 0;
  seen[goal] = stamp;
  next[goal] = goal;
  heap.push(0, goal);
  let expanded = 0;
  while (heap.length) {
    const cur = heap.pop();
    if (closed[cur] === stamp) continue;
    closed[cur] = stamp;
    if (++expanded > maxNodes) break;
    if (expanded % SLICE === 0) yield expanded;
    const cx = cur % W, cz = (cur - cx) / W;
    const cc = costOf(grid, cur, goal, goal);
    for (let d = 0; d < 8; d++) {
      const [dx, dz, len] = DIRS[d];
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const n = nz * W + nx;
      if (closed[n] === stamp) continue;
      const nc = grid.cost[n];
      if (!Number.isFinite(nc)) continue;
      if (dx && dz && (!Number.isFinite(grid.cost[cz * W + nx]) || !Number.isFinite(grid.cost[nz * W + cx]))) continue;
      const ng = g[cur] + len * (cc + nc) * 0.5 + climb(grid, n, cur, len);
      if (seen[n] === stamp && ng >= g[n]) continue;
      seen[n] = stamp;
      g[n] = ng;
      next[n] = cur;
      heap.push(ng, n);
    }
  }
  return { goal, next, expanded };
}

// Dijkstra from several sources at once: label[i] is the index of the source
// nearest to i by travel cost (-1 where unreachable), dist[i] that cost.
export function multiSourceField(grid, sources) {
  const { W, H, cost } = grid;
  const N = W * H;
  const dist = new Float32Array(N).fill(Infinity);
  const label = new Int16Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new MinHeap(4096);
  sources.forEach((s, k) => {
    if (s < 0 || s >= N) return;
    dist[s] = 0;
    label[s] = k;
    heap.push(0, s);
  });
  while (heap.length) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    const cx = cur % W, cz = (cur - cx) / W;
    const cc = Number.isFinite(cost[cur]) ? cost[cur] : ENDPOINT_COST;
    for (let d = 0; d < 8; d++) {
      const [dx, dz, len] = DIRS[d];
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const n = nz * W + nx;
      if (done[n] || !Number.isFinite(cost[n])) continue;
      if (dx && dz && (!Number.isFinite(cost[cz * W + nx]) || !Number.isFinite(cost[nz * W + cx]))) continue;
      const nd = dist[cur] + len * (cc + cost[n]) * 0.5 + climb(grid, cur, n, len);
      if (nd >= dist[n]) continue;
      dist[n] = nd;
      label[n] = label[cur];
      heap.push(nd, n);
    }
  }
  return { dist, label };
}

// The same, over BLOCK x BLOCK cell blocks: cheap enough for a yearly pass.
// A block costs the mean of its cells, with impassable cells (deep water,
// walls) counted at `blocked` each, so a river block is dear unless a ford or
// a deck crosses it. label[block] is the index of the nearest source.
// Mean cell cost per BLOCK x BLOCK block (blocked cells count as `blocked`),
// kept on the grid: it changes only when the grid does.
export function blockCosts(grid, blocked = 20) {
  if (grid.blockCost?.blocked === blocked) return grid.blockCost.cost;
  const { W, H, cost } = grid;
  const CW = Math.ceil(W / BLOCK), CH = Math.ceil(H / BLOCK);
  const bcost = new Float32Array(CW * CH);
  for (let bz = 0; bz < CH; bz++) {
    const z1 = Math.min(H, (bz + 1) * BLOCK);
    for (let bx = 0; bx < CW; bx++) {
      const x1 = Math.min(W, (bx + 1) * BLOCK);
      let sum = 0, n = 0;
      for (let z = bz * BLOCK; z < z1; z++)
        for (let x = bx * BLOCK; x < x1; x++) {
          const c = cost[z * W + x];
          sum += c < Infinity ? c : blocked;
          n++;
        }
      bcost[bz * CW + bx] = sum / n;
    }
  }
  grid.blockCost = { blocked, cost: bcost };
  return bcost;
}

export function coarseTravelField(grid, sources, { blocked = 20 } = {}) {
  const { W, H } = grid;
  const CW = Math.ceil(W / BLOCK), CH = Math.ceil(H / BLOCK), N = CW * CH;
  const bcost = blockCosts(grid, blocked);
  const dist = new Float32Array(N).fill(Infinity);
  const label = new Int16Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new MinHeap(256);
  sources.forEach((cell, k) => {
    if (cell < 0) return;
    const b = Math.floor((cell % W) / BLOCK) + Math.floor(Math.floor(cell / W) / BLOCK) * CW;
    if (dist[b] === 0) return;
    dist[b] = 0;
    label[b] = k;
    heap.push(0, b);
  });
  while (heap.length) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    const cx = cur % CW, cz = (cur - cx) / CW;
    for (const [dx, dz, len] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= CW || nz >= CH) continue;
      const n = nz * CW + nx;
      if (done[n]) continue;
      const nd = dist[cur] + len * (bcost[cur] + bcost[n]) * 0.5;
      if (nd >= dist[n]) continue;
      dist[n] = nd;
      label[n] = label[cur];
      heap.push(nd, n);
    }
  }
  const labelOf = cell => cell < 0 ? -1 : label[Math.floor((cell % W) / BLOCK) + Math.floor(Math.floor(cell / W) / BLOCK) * CW];
  return { label, dist, CW, labelOf };
}

export function followField(field, from) {
  const { next, goal } = field;
  if (from === goal) return Int32Array.of(goal);
  if (next[from] < 0) return null;
  const out = [from];
  let i = from;
  for (let guard = 0; i !== goal && guard < next.length; guard++) {
    i = next[i];
    if (i < 0) return null;
    out.push(i);
  }
  return i === goal ? Int32Array.from(out) : null;
}

// ---------------------------------------------------------------- crossings

function sideOfRiver(grid, i) {
  const cx = i % grid.W, cz = (i - cx) / grid.W;
  const x = grid.ox + (cx + 0.5) * grid.cell, z = grid.oz + (cz + 0.5) * grid.cell;
  return Math.sign(x - riverX(z));
}

// Bands (8 cell rows each) where this route shows crossing demand: any ford
// it wades, plus the band it wanted when it had to detour more than 40 cells
// to cross, or when no crossing could be found at all.
export function crossingsFor(grid, cells, from, to) {
  if (from < 0 || to < 0) return [];
  const W = grid.W;
  const bands = [];
  const opposite = sideOfRiver(grid, from) * sideOfRiver(grid, to) < 0;
  const wantRow = (Math.floor(from / W) + Math.floor(to / W)) / 2;
  if (!cells) return opposite ? [Math.floor(wantRow / BAND_CELLS)] : [];
  let inWater = false, crossRow = -1;
  for (const i of cells) {
    const w = grid.water[i];
    if (w && !inWater) {
      const row = Math.floor(i / W);
      if (crossRow < 0) crossRow = row;
      if (w === 2) bands.push(Math.floor(row / BAND_CELLS));
    }
    inWater = w !== 0;
  }
  if (opposite && crossRow >= 0 && Math.abs(crossRow - wantRow) > DETOUR_CELLS) {
    bands.push(Math.floor(wantRow / BAND_CELLS));
  }
  return bands;
}

// ---------------------------------------------------------------- routes to waypoints

// Converts a cell path into a flat [x, z, ...] waypoint list that starts at
// `start` and ends at `goal`, keeping only the cells where direction changes.
export function cellsToWaypoints(grid, cells, start, goal) {
  const { W, ox, oz, cell } = grid;
  const out = [start.x, start.z];
  for (let k = 1; k < cells.length - 1; k++) {
    const a = cells[k - 1], b = cells[k], c = cells[k + 1];
    const dx1 = (b % W) - (a % W), dz1 = Math.floor(b / W) - Math.floor(a / W);
    const dx2 = (c % W) - (b % W), dz2 = Math.floor(c / W) - Math.floor(b / W);
    if (dx1 === dx2 && dz1 === dz2) continue;
    out.push(ox + (b % W + 0.5) * cell, oz + (Math.floor(b / W) + 0.5) * cell);
  }
  out.push(goal.x, goal.z);
  return out;
}

// ---------------------------------------------------------------- scheduler

// Shared by the worker and the cooperative fallback. Routes are deduplicated,
// cached per grid bucket, and served from flow fields once a destination is
// popular. Only one search runs at a time per queue, sliced by time budget.
export class RouteScheduler {
  constructor({ clock = () => performance.now(), maxPending = 2048, maxCache = 4096, maxFields = 12, fieldThreshold = 16, maxNodes = 60000 } = {}) {
    Object.assign(this, { clock, maxPending, maxCache, maxFields, fieldThreshold, maxNodes });
    this.grid = null;
    this.cache = new Map();
    this.fields = new Map();
    this.demand = new Map();
    this.jobs = new Map();
    this.queue = [];
    this.fieldQueue = [];
    this.scratch = null;
    this.fieldScratch = null;
    this.current = null;
    this.currentField = null;
    this.stats = { completed: 0, cacheHits: 0, fieldHits: 0, slices: 0, fields: 0, expanded: 0 };
  }

  setGrid(grid) {
    const prev = this.grid;
    this.grid = grid;
    const size = grid.W * grid.H;
    if (!this.scratch || this.scratch.g.length !== size) {
      this.scratch = createScratch(size);
      this.fieldScratch = createScratch(size);
    }
    this.fields.clear();
    this.fieldQueue = [];
    this.currentField = null;
    if (prev && grid.footprintsOnly && prev.bucket === grid.bucket) this.pruneBlocked();
    else { this.cache.clear(); this.demand.clear(); }
    this.restartJobs();
  }

  // Drops cached routes that now pass through a blocked cell.
  pruneBlocked() {
    const cost = this.grid.cost;
    for (const [key, result] of this.cache) {
      const cells = result.cells;
      if (!cells) { this.cache.delete(key); continue; }
      for (let k = 1; k < cells.length - 1; k++) {
        if (!Number.isFinite(cost[cells[k]])) { this.cache.delete(key); break; }
      }
    }
  }

  restartJobs() {
    this.current = null;
    for (const job of this.jobs.values()) job.iterator = null;
  }

  request(from, to, callback) {
    if (!this.grid) return false;
    const key = `${from}>${to}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.stats.cacheHits++;
      callback(cached);
      return true;
    }
    const field = this.fields.get(to);
    if (field) {
      const cells = followField(field, from);
      if (cells) {
        this.stats.fieldHits++;
        callback(this.store(key, from, to, cells));
        return true;
      }
    }
    const existing = this.jobs.get(key);
    if (existing) { existing.callbacks.push(callback); return true; }
    if (this.jobs.size >= this.maxPending) return false;
    const job = { key, from, to, iterator: null, callbacks: [callback] };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.noteDemand(to);
    return true;
  }

  noteDemand(to) {
    const n = (this.demand.get(to) ?? 0) + 1;
    this.demand.set(to, n);
    if (n === this.fieldThreshold && !this.fields.has(to)) this.fieldQueue.push(to);
  }

  store(key, from, to, cells) {
    const result = { cells, crossings: crossingsFor(this.grid, cells, from, to) };
    this.cache.set(key, result);
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  finish(job, cells) {
    this.jobs.delete(job.key);
    const result = this.store(job.key, job.from, job.to, cells);
    this.stats.completed++;
    for (const cb of job.callbacks) cb(result);
  }

  // Serves queued jobs whose destination now has a flow field.
  drainWithField(field) {
    for (let k = this.queue.length - 1; k >= 0; k--) {
      const job = this.queue[k];
      if (job.to !== field.goal || job === this.current) continue;
      const cells = followField(field, job.from);
      if (!cells) continue;
      this.queue.splice(k, 1);
      this.stats.fieldHits++;
      this.finish(job, cells);
    }
  }

  stepRoute() {
    if (!this.current) {
      this.current = this.queue.shift() ?? null;
      if (!this.current) return false;
      this.current.iterator = searchJob(this.grid, this.scratch, this.current.from, this.current.to, { maxNodes: this.maxNodes });
    }
    const r = this.current.iterator.next();
    if (r.done) {
      const job = this.current;
      this.current = null;
      if (r.value) this.stats.expanded += r.value.expanded;
      this.finish(job, r.value?.cells ?? null);
    }
    return true;
  }

  stepField() {
    if (!this.currentField) {
      const goal = this.fieldQueue.shift();
      if (goal === undefined) return false;
      this.currentField = flowFieldJob(this.grid, this.fieldScratch, goal);
    }
    const r = this.currentField.next();
    if (r.done) {
      this.currentField = null;
      const field = r.value;
      this.fields.set(field.goal, field);
      while (this.fields.size > this.maxFields) this.fields.delete(this.fields.keys().next().value);
      this.stats.fields++;
      this.drainWithField(field);
    }
    return true;
  }

  tick(budgetMs = 2, maxSlices = 256) {
    if (!this.grid) return 0;
    const deadline = this.clock() + budgetMs;
    let slices = 0, turn = 0;
    while (slices < maxSlices && this.clock() < deadline) {
      const worked = (turn++ & 1) ? this.stepField() || this.stepRoute() : this.stepRoute() || this.stepField();
      if (!worked) break;
      slices++;
      this.stats.slices++;
    }
    return slices;
  }

  get pending() { return this.jobs.size + this.fieldQueue.length + (this.currentField ? 1 : 0); }
}

// ---------------------------------------------------------------- legacy

// The pre-v2 simulation still imports these. They go away with src/spatial.js
// once src/simulation.js becomes a facade over src/sim/.
export { findPath, accessPoint, nearestWalkable, moveOnRoute } from './spatial.js';
