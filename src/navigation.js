// Grid navigation shared by the navigation worker and the main-thread
// fallback. Pure: it knows nothing about game state, only a nav grid
// `{key, bucket, footprintsOnly, W, H, ox, oz, cell, cost: Float32Array,
// water: Uint8Array}` built by src/sim/roads.js (navGrid).
//
// water codes: 0 land, 1 deep water, 2 ford, 3 bridge.
import { riverX, WATER_HALF, hasRiver } from './terrain.js';

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
  // A cell at the grid's passCap (a door inside walls) is open ground here: its price
  // only keeps the fine search from cutting through a building by it.
  const cap = grid.passCap ?? Infinity, open = grid.passOpen ?? 1;
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
          sum += c < cap ? c : c < Infinity ? open : blocked;
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

// The cells passable on grid a and closed on grid b (same size), as the box they span
// (cells, inclusive) and how many: {n, x0, z0, x1, z1}. Paths that keep out of that
// box (and a cell round it, for corners) can be walked on b as on a.
export function newlyClosed(a, b) {
  const ca = a.cost, cb = b.cost, W = b.W;
  let n = 0, x0 = Infinity, z0 = Infinity, x1 = -1, z1 = -1;
  for (let i = 0; i < cb.length; i++) {
    if (cb[i] !== Infinity || ca[i] === Infinity) continue;
    n++;
    const x = i % W, z = (i - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { n, x0, z0, x1, z1 };
}

// A cell path's box (cells, inclusive), kept on the path array.
const pathBoxes = new WeakMap();
export function pathBox(cells, W) {
  let box = pathBoxes.get(cells);
  if (box) return box;
  let x0 = Infinity, z0 = Infinity, x1 = -1, z1 = -1;
  for (let k = 0; k < cells.length; k++) {
    const x = cells[k] % W, z = (cells[k] - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  box = { x0, z0, x1, z1 };
  pathBoxes.set(cells, box);
  return box;
}

// Might a path with this box meet the closed cells (a cell of margin for corners)?
export const boxMeets = (b, c) => c.n > 0 && b.x1 >= c.x0 - 1 && b.x0 <= c.x1 + 1 && b.z1 >= c.z0 - 1 && b.z0 <= c.z1 + 1;

// Can a cell path still be walked on this grid: every cell after the first and before
// the last passable, and no diagonal step past a blocked corner (searchJob's rules)?
export function pathOpen(grid, cells) {
  const { cost, W } = grid;
  const n = cells.length;
  for (let k = 1; k < n - 1; k++) if (!Number.isFinite(cost[cells[k]])) return false;
  for (let k = 1; k < n; k++) {
    const a = cells[k - 1], b = cells[k];
    const ax = a % W, bx = b % W;
    if (ax === bx || b - a === bx - ax) continue;
    const az = (a - ax) / W, bz = (b - bx) / W;
    if (!Number.isFinite(cost[az * W + bx]) || !Number.isFinite(cost[bz * W + ax])) return false;
  }
  return true;
}
const FIELD_AGE = 4;
const DEMAND_HALF = 4096;

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
  if (!hasRiver()) return 1;
  const cx = i % grid.W, cz = (i - cx) / grid.W;
  const x = grid.ox + (cx + 0.5) * grid.cell, z = grid.oz + (cz + 0.5) * grid.cell;
  return Math.sign(x - riverX(z));
}

function onRiver(grid, i) {
  const cx = i % grid.W, cz = (i - cx) / grid.W;
  const x = grid.ox + (cx + 0.5) * grid.cell, z = grid.oz + (cz + 0.5) * grid.cell;
  return Math.abs(x - riverX(z)) < WATER_HALF + grid.cell;
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
      // River fords only: wading a delta's creek is no call for a bridge.
      if (w === 2 && onRiver(grid, i)) bands.push(Math.floor(row / BAND_CELLS));
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
// `start` and ends at `goal`. A pure function of the grid and the cells.
//
// Between the ends the path is walked three ways, by the kind of cell:
//  - path cells (grid.nodeX finite, from path-nodes.js): their relaxed nodes,
//    the centreline the renderer draws, along its links (a diagonal step the
//    drawn path takes by a corner cell goes by that cell's node), dropping
//    nodes that turn the line by less than NODE_TURN from the last one kept
//    and junction nodes (the walk turns from arm to arm across a junction),
//    and walking each remaining corner as a short curve (CORNER_CUT); none of
//    that beside water, and nodes by a bridge deck are kept as they are;
//  - open ground: pulled straight. From each kept point the walk goes to the
//    farthest of the next LOOKAHEAD cells it can reach in a straight line that
//    crosses only passable dry cells no dearer than the dearest open cell it
//    skips, so a shortcut never crosses worse ground, never cuts across grass
//    where the path keeps to a road, and stops at the first road node;
//  - water (fords and bridge decks): cell centres, never skipped or smoothed,
//    kept where the crossing starts, ends or turns (as alongDecks expects).
// Any leg between kept points that is not clear (legOk: legClear's test, and
// no water but the path's own) falls back to cell centres.
//
// The first and last legs: `start` is where the walker stands when the route
// arrives (it may have been planned from a neighbouring open cell, or served
// from the cache), and `goal` is any point in the last cell. Those two legs are
// walked cell by cell; one that would leave walkable ground (cut through deep
// water beside a ford, or the corner of a wall) goes by the end cell's centre
// instead, and a goal in deep water is not entered at all.
export const LOOKAHEAD = 24;
export const NODE_TURN = 6;   // degrees
// A shortcut may cross cells this much dearer than the dearest it skips: the
// grain of the slope term in cell costs (0.03 is a grade of 0.1), well below the
// step between tiers (grass 1.2, trail 0.95), so it never trades a path for grass.
export const COST_SLACK = 0.03;
const COS_TURN = Math.cos(NODE_TURN * Math.PI / 180);
// A path corner turning more than CORNER_TURN degrees is cut CORNER_CUT units
// back along each leg (never more than a third of the shorter one).
export const CORNER_TURN = 15;
export const CORNER_CUT = 0.9;
const COS_ROUND = Math.cos(CORNER_TURN * Math.PI / 180);
const OPEN = 0, PATH = 1, WATER = 2;
// Per-call scratch (the function is not re-entrant), grown as routes grow.
let kindBuf = new Uint8Array(256), pxBuf = new Float64Array(256), pzBuf = new Float64Array(256), wetBuf = new Uint8Array(256);

export function cellsToWaypoints(grid, cells, start, goal) {
  const { W, ox, oz, cell, cost } = grid;
  const water = grid.water, nodeX = grid.nodeX, nodeZ = grid.nodeZ, links = grid.nodeLinks;
  cells = alongLinks(grid, cells);
  const n = cells.length;
  const first = cells[0], last = cells[n - 1];
  const cxOf = i => ox + (i % W + 0.5) * cell, czOf = i => oz + (Math.floor(i / W) + 0.5) * cell;

  // Kind and point per cell; the ends stand for start and goal.
  if (kindBuf.length < n) {
    const size = Math.max(n, kindBuf.length * 2);
    kindBuf = new Uint8Array(size); pxBuf = new Float64Array(size); pzBuf = new Float64Array(size); wetBuf = new Uint8Array(size);
  }
  const kind = kindBuf, px = pxBuf, pz = pzBuf;
  // Water about cell k (waterNear), worked out once: 0 not yet, else 1 + its bits.
  wetBuf.fill(0, 0, n);
  const wet = (k) => (wetBuf[k] || (wetBuf[k] = 1 + waterNear(grid, cells[k]))) - 1;
  for (let k = 0; k < n; k++) {
    const i = cells[k];
    kind[k] = water && water[i] ? WATER : nodeX && nodeX[i] === nodeX[i] ? PATH : OPEN;
    if (kind[k] === PATH) { px[k] = nodeX[i]; pz[k] = nodeZ[i]; }
    else { px[k] = cxOf(i); pz[k] = czOf(i); }
  }
  px[0] = start.x; pz[0] = start.z;
  if (n > 1) { px[n - 1] = goal.x; pz[n - 1] = goal.z; }

  // Kept interior points: cell index along the path, position, at its centre?,
  // and is the leg into it from the point before known to be clear?
  const kk = [], kx = [], kz = [], kc = [], kv = [];
  let a = 0, ax = start.x, az = start.z;
  const keep = (k, checked) => {
    let x = px[k], z = pz[k], clear = true;
    if (!checked && !legOk(grid, cells, a, k, ax, az, x, z, Infinity)) { x = cxOf(cells[k]); z = czOf(cells[k]); clear = false; }
    kk.push(k); kx.push(x); kz.push(z); kc.push(x === cxOf(cells[k]) && z === czOf(cells[k])); kv.push(clear && kk.length > 1);
    a = k; ax = x; az = z;
  };
  let k = 1;
  while (k < n - 1) {
    const t = kind[k];
    if (t === WATER) {
      if (kind[k - 1] !== WATER || kind[k + 1] !== WATER || turnsAt(W, cells, k)) keep(k, false);
      k++;
      continue;
    }
    if (t === PATH) {
      // Drop a node that hardly turns the line, or a junction's (the walk turns
      // from arm to arm across it, not out to its meeting point and back), if
      // the straightened leg is clear.
      if (kind[k + 1] === PATH && k + 1 < n - 1 && k + 1 - a <= LOOKAHEAD &&
          (straightOn(ax, az, px[k], pz[k], px[k + 1], pz[k + 1]) || (links && junction(links[cells[k]]) && !(wet(k) & WET))) &&
          !(wet(k) & DECK) &&
          legOk(grid, cells, a, k + 1, ax, az, px[k + 1], pz[k + 1], Infinity)) { k++; continue; }
      keep(k, k - 1 !== a);
      k++;
      continue;
    }
    // Open ground: the farthest point a straight leg reaches over no worse ground.
    let best = k, dearest = cost[cells[k]];
    for (let j = k + 1; j <= n - 1 && j - a <= LOOKAHEAD; j++) {
      if (kind[j - 1] !== OPEN) break;
      if (cost[cells[j - 1]] > dearest) dearest = cost[cells[j - 1]];
      if (!legOk(grid, cells, a, j, ax, az, px[j], pz[j], dearest)) break;
      best = j;
    }
    if (best === n - 1) break;
    keep(best, best > k);
    k = best + 1;
  }

  const pts = { kk, kx, kz, kc, kv };
  repair(grid, cells, pts);
  // First leg: from where the walker stands to the first kept point (or the goal).
  if (n > 1 && !legOk(grid, cells, 0, kk.length ? kk[0] : n - 1, start.x, start.z, kk.length ? kx[0] : goal.x, kk.length ? kz[0] : goal.z, Infinity)) {
    kk.unshift(0); kx.unshift(cxOf(first)); kz.unshift(czOf(first)); kc.unshift(true); kv.unshift(false);
    if (kv.length > 1) kv[1] = false;
    repair(grid, cells, pts);
  }

  // Last leg: from the last kept point (or the start) to the goal.
  let lx0 = kk.length ? kx[kk.length - 1] : start.x, lz0 = kk.length ? kz[kk.length - 1] : start.z;
  let tail = false;
  if (deepAt(grid, last) || (n > 1 && !legClear(grid, lx0, lz0, goal.x, goal.z, first, last))) {
    const lx = cxOf(last), lz = czOf(last);
    if (lx0 !== lx || lz0 !== lz) {
      kk.push(n - 1); kx.push(lx); kz.push(lz); kc.push(true); kv.push(false);
      repair(grid, cells, pts);
    }
    tail = !deepAt(grid, last) && legClear(grid, lx, lz, goal.x, goal.z, first, last);
  } else {
    tail = true;
  }

  const out = [start.x, start.z];
  for (let q = 0; q < kk.length; q++) {
    const x = kx[q], z = kz[q];
    if (x === out[out.length - 2] && z === out[out.length - 1]) continue;
    // A corner on a path is walked as a short curve: from CORNER_CUT back along
    // the leg in, by the midpoint of the curve that bends round the node, to
    // CORNER_CUT along the leg out, where those legs are clear.
    const k = kk[q], nxq = q + 1 < kk.length ? kx[q + 1] : tail ? goal.x : NaN, nzq = q + 1 < kk.length ? kz[q + 1] : tail ? goal.z : NaN;
    if (kind[k] === PATH && k > 0 && k < n - 1 && nxq === nxq && !wet(k)) {
      const px0 = out[out.length - 2], pz0 = out[out.length - 1];
      const la = Math.hypot(x - px0, z - pz0), lb = Math.hypot(nxq - x, nzq - z);
      if (la > 1e-6 && lb > 1e-6 && !straightOn(px0, pz0, x, z, nxq, nzq, COS_ROUND)) {
        const c = Math.min(CORNER_CUT, 0.35 * Math.min(la, lb));
        const qx = x + (px0 - x) * c / la, qz = z + (pz0 - z) * c / la, rx = x + (nxq - x) * c / lb, rz = z + (nzq - z) * c / lb;
        const k0 = q > 0 ? kk[q - 1] : 0, k1 = q + 1 < kk.length ? kk[q + 1] : n - 1;
        const mx = 0.25 * qx + 0.5 * x + 0.25 * rx, mz = 0.25 * qz + 0.5 * z + 0.25 * rz;
        // (In to q and r on are parts of legs already found clear.)
        if (legOk(grid, cells, k0, k1, qx, qz, mx, mz, Infinity) && legOk(grid, cells, k0, k1, mx, mz, rx, rz, Infinity)) {
          out.push(qx, qz, mx, mz, rx, rz);
          continue;
        }
      }
    }
    out.push(x, z);
  }
  if (tail) out.push(goal.x, goal.z);
  return out;
}

// The search may step diagonally between two path cells that the drawn path
// (path-nodes.js links) joins through the cell at their corner. Such a step
// goes by that corner cell, so the walk follows the drawn links; elsewhere the
// cells are returned as they are.
function alongLinks(grid, cells) {
  const links = grid.nodeLinks;
  if (!links) return cells;
  const { W, cost, water } = grid;
  let out = null;
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1], b = cells[k];
    const dx = (b % W) - (a % W), dz = Math.floor(b / W) - Math.floor(a / W);
    let corner = -1;
    if (dx && dz && links[a] && links[b] && !(water && (water[a] || water[b]))) {
      const d = linkDir(dx, dz);
      if (!(links[a] & (1 << d))) {
        for (const c of [a + dx, a + dz * W]) {
          const dc = linkDir(c % W - a % W, Math.floor(c / W) - Math.floor(a / W));
          const db = linkDir(b % W - c % W, Math.floor(b / W) - Math.floor(c / W));
          if (!(links[a] & (1 << dc)) || !(links[c] & (1 << db)) || !(cost[c] < Infinity) || (water && water[c])) continue;
          // Only a corner node near the step (a towpath-lane node can sit cells away).
          if (offChord(grid, a, b, c) > grid.cell * 0.5) continue;
          corner = c;
          break;
        }
      }
    }
    if (corner >= 0 && !out) out = Array.from(cells.subarray ? cells.subarray(0, k) : cells.slice(0, k));
    if (out) { if (corner >= 0) out.push(corner); out.push(b); }
  }
  return out ?? cells;
}
// Water about cell i: WET for any water in the cells beside it, DECK for a
// bridge deck within DECK_KEEP cells. By a deck the walk keeps its path nodes
// as they are (not dropped, not rounded) for alongDecks to line up on; beside
// any water it cuts no corner and no junction (a shore cell can be partly wet).
const DECK_KEEP = 2;
const WET = 1, DECK = 2;
function waterNear(grid, i) {
  const { W, H, water } = grid;
  if (!water) return 0;
  const x = i % W, z = (i - x) / W;
  let bits = 0;
  for (let dz = -DECK_KEEP; dz <= DECK_KEEP; dz++) {
    const zz = z + dz;
    if (zz < 0 || zz >= H) continue;
    for (let dx = -DECK_KEEP; dx <= DECK_KEEP; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      const w = water[zz * W + xx];
      if (!w) continue;
      if (w === 3) bits |= DECK;
      if (dx >= -1 && dx <= 1 && dz >= -1 && dz <= 1) bits |= WET;
    }
  }
  return bits;
}

// Distance of c's node from the segment between a's and b's nodes.
function offChord(grid, a, b, c) {
  const { nodeX, nodeZ } = grid;
  const ax = nodeX[a], az = nodeZ[a], dx = nodeX[b] - ax, dz = nodeZ[b] - az;
  const L = dx * dx + dz * dz;
  let t = L > 0 ? ((nodeX[c] - ax) * dx + (nodeZ[c] - az) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(nodeX[c] - ax - dx * t, nodeZ[c] - az - dz * t);
}

// Three or more links: a junction (or a knot) of the path graph.
function junction(mask) { return popcount8(mask) >= 3; }
function popcount8(m) { let n = 0; for (; m; m &= m - 1) n++; return n; }
// path-nodes.js link bit for the step (dx, dz): LINK_DX/LINK_DZ order.
function linkDir(dx, dz) { return (dz + 1) * 3 + (dx + 1) - (dz > 0 || (dz === 0 && dx > 0) ? 1 : 0); }

// Does the cell path change direction at k?
function turnsAt(W, cells, k) {
  const a = cells[k - 1], b = cells[k], c = cells[k + 1];
  return (b % W) - (a % W) !== (c % W) - (b % W) ||
    Math.floor(b / W) - Math.floor(a / W) !== Math.floor(c / W) - Math.floor(b / W);
}

// Does a -> b -> c turn by less than NODE_TURN at b? (Coincident points count as straight.)
function straightOn(ax, az, bx, bz, cx, cz, cosLimit = COS_TURN) {
  const ux = bx - ax, uz = bz - az, vx = cx - bx, vz = cz - bz;
  const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
  if (lu < 1e-6 || lv < 1e-6) return true;
  return (ux * vx + uz * vz) >= cosLimit * lu * lv;
}

// Every leg between kept points must be clear (legOk); one that is not
// goes back to the cell centres along the path between its two ends, and its
// ends move to their own centres (which can unsettle the leg before, so that
// is checked again). Centre to centre along consecutive path cells is always
// clear: the search never steps diagonally past a blocked corner.
function repair(grid, cells, pts) {
  const { kk, kx, kz, kc, kv } = pts;
  const { W, ox, oz, cell } = grid;
  const cxOf = i => ox + (i % W + 0.5) * cell, czOf = i => oz + (Math.floor(i / W) + 0.5) * cell;
  let q = 1;
  while (q < kk.length) {
    const k0 = kk[q - 1], k1 = kk[q];
    if (kv[q] || legOk(grid, cells, k0, k1, kx[q - 1], kz[q - 1], kx[q], kz[q], Infinity)) { kv[q] = true; q++; continue; }
    if (kc[q - 1] && kc[q] && k1 - k0 <= 1) { kv[q] = true; q++; continue; }   // nothing left to fall back to
    const moved = !kc[q - 1];
    if (moved) kv[q - 1] = false;
    kx[q - 1] = cxOf(cells[k0]); kz[q - 1] = czOf(cells[k0]); kc[q - 1] = true;
    kx[q] = cxOf(cells[k1]); kz[q] = czOf(cells[k1]); kc[q] = true;
    const gap = [], gx = [], gz = [], gc = [], gv = [];
    for (let k = k0 + 1; k < k1; k++) { gap.push(k); gx.push(cxOf(cells[k])); gz.push(czOf(cells[k])); gc.push(true); gv.push(false); }
    kk.splice(q, 0, ...gap); kx.splice(q, 0, ...gx); kz.splice(q, 0, ...gz); kc.splice(q, 0, ...gc); kv.splice(q, 0, ...gv);
    q = moved && q > 1 ? q - 1 : q;
  }
}

// Is the straight leg a -> b, between path cells k0 and k1, fit to walk? Every
// cell it passes through (legClear's traversal, plus the other side cell where
// it goes exactly through a corner) must be passable, and unless it is one of
// the path's own cells from k0 to k1, dry and no dearer than `dearest` (give or
// take COST_SLACK), so a shortcut over open ground never crosses worse ground
// or water. The path's end cells are treated as legClear treats them.
function legOk(grid, cells, k0, k1, ax, az, bx, bz, dearest) {
  const { W, ox, oz, cell } = grid;
  const limit = dearest + COST_SLACK;
  const ok = cellOk;
  let x = Math.floor((ax - ox) / cell), z = Math.floor((az - oz) / cell);
  const ex = Math.floor((bx - ox) / cell), ez = Math.floor((bz - oz) / cell);
  const dx = bx - ax, dz = bz - az;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(cell / dx) : Infinity, tdz = dz !== 0 ? Math.abs(cell / dz) : Infinity;
  let tx = dx !== 0 ? (((sx > 0 ? x + 1 : x) * cell + ox) - ax) / dx : Infinity;
  let tz = dz !== 0 ? (((sz > 0 ? z + 1 : z) * cell + oz) - az) / dz : Infinity;
  const n = Math.abs(ex - x) + Math.abs(ez - z);
  for (let k = 0; ; k++) {
    if (!ok(grid, cells, k0, k1, limit, x, z)) return false;
    if (k >= n) return true;
    if (tx < tz) {
      if (tz - tx < 1e-9 && !ok(grid, cells, k0, k1, limit, x, z + sz)) return false;
      x += sx; tx += tdx;
    } else {
      if (tx - tz < 1e-9 && !ok(grid, cells, k0, k1, limit, x + sx, z)) return false;
      z += sz; tz += tdz;
    }
  }
}

function cellOk(grid, cells, k0, k1, limit, x, z) {
  const { W, H, cost, water } = grid;
  if (x < 0 || z < 0 || x >= W || z >= H) return false;
  const i = z * W + x;
  if (i === cells[0] || i === cells[cells.length - 1]) return !deepAt(grid, i);
  const c = cost[i];
  if (!(c < Infinity)) return false;
  // (A cell at the grid's passCap, a door inside walls, only where the path goes.)
  if (!(water && water[i]) && c <= limit && !(c >= grid.passCap)) return true;
  for (let k = k0; k <= k1; k++) if (cells[k] === i) return true;
  return false;
}

// Deep water (not a ford, not a deck): never a place to stand.
function deepAt(grid, i) { return grid.water ? grid.water[i] === 1 : false; }

// Does the straight leg a -> b stay on walkable cells? Every cell the segment
// passes through (a grid traversal, so no cell is skipped) must be passable;
// the path's own end cells may be impassable (a door inside a footprint),
// unless they are deep water.
function legClear(grid, ax, az, bx, bz, okA, okB) {
  const { W, H, ox, oz, cell, cost } = grid;
  let x = Math.floor((ax - ox) / cell), z = Math.floor((az - oz) / cell);
  const ex = Math.floor((bx - ox) / cell), ez = Math.floor((bz - oz) / cell);
  const dx = bx - ax, dz = bz - az;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(cell / dx) : Infinity, tdz = dz !== 0 ? Math.abs(cell / dz) : Infinity;
  let tx = dx !== 0 ? (((sx > 0 ? x + 1 : x) * cell + ox) - ax) / dx : Infinity;
  let tz = dz !== 0 ? (((sz > 0 ? z + 1 : z) * cell + oz) - az) / dz : Infinity;
  const n = Math.abs(ex - x) + Math.abs(ez - z);
  for (let k = 0; ; k++) {
    if (x < 0 || z < 0 || x >= W || z >= H) return false;
    const i = z * W + x;
    if (!(i === okA || i === okB ? !deepAt(grid, i) : Number.isFinite(cost[i]))) return false;
    if (k >= n) return true;
    if (tx < tz) { x += sx; tx += tdx; } else { z += sz; tz += tdz; }
  }
}

// ---------------------------------------------------------------- scheduler

// Shared by the worker and the cooperative fallback. Routes are deduplicated,
// cached per grid bucket, and served from flow fields once a destination is
// popular. Only one search runs at a time per queue, sliced by time budget.
export class RouteScheduler {
  constructor({ clock = () => performance.now(), maxPending = 2048, maxCache = 4096, maxFields = 24, fieldThreshold = 32, maxNodes = 60000 } = {}) {
    Object.assign(this, { clock, maxPending, maxCache, maxFields, fieldThreshold, maxNodes });
    this.grid = null;
    this.cache = new Map();
    this.fields = new Map();
    this.demand = new Map();
    this.requests = 0;
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
    // Routes and flow fields outlive a grid change (docs/design/crowd-scale.md §4.1):
    // a cached route is kept while its cells stay passable, and a field's routes are
    // checked so as they are followed. Their costs may be a few months stale; whether
    // they can be walked is always the new grid's. A field being worked out goes on
    // (on the grid it started with) and is checked like an old one. (Fields age by
    // requests: noteDemand.)
    if (prev && prev.W === grid.W && prev.H === grid.H) {
      this.pruneBlocked(newlyClosed(prev, grid));
      if (this.currentField) this.currentFieldStale = true;
      for (const f of this.fields.values()) f.stale = true;
    } else {
      this.cache.clear();
      this.demand.clear();
      this.fields.clear();
      this.fieldQueue = [];
      this.currentField = null;
    }
    this.restartJobs();
  }

  // Drops cached routes that now pass through a blocked cell (only those near a cell
  // that closed are looked at).
  pruneBlocked(closed = null) {
    if (closed && !closed.n) return;
    for (const [key, result] of this.cache) {
      if (!result.cells) { this.cache.delete(key); continue; }
      if (closed && !boxMeets(pathBox(result.cells, this.grid.W), closed)) continue;
      if (!pathOpen(this.grid, result.cells)) this.cache.delete(key);
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
      if (cells && (!field.stale || pathOpen(this.grid, cells))) {
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

  // A goal asked for fieldThreshold times (since demand last halved) gets a field: a
  // whole-grid search, worth a few hundred routes. With the fields full, only a goal
  // in more demand than the least asked-for field's displaces it.
  noteDemand(to) {
    // Every DEMAND_HALF requests, demand halves (fields follow where people go now) and
    // the fields age: the oldest past FIELD_AGE is worked out again on today's costs.
    if (++this.requests % DEMAND_HALF === 0) {
      for (const [goal, n] of this.demand) if (n < 2) this.demand.delete(goal); else this.demand.set(goal, n >> 1);
      let oldest = null;
      for (const f of this.fields.values()) {
        f.age = (f.age ?? 0) + 1;
        if (f.age >= FIELD_AGE && (!oldest || f.age > oldest.age)) oldest = f;
      }
      if (oldest && !this.fieldQueue.includes(oldest.goal)) this.fieldQueue.push(oldest.goal);
    }
    const n = (this.demand.get(to) ?? 0) + 1;
    this.demand.set(to, n);
    if (n < this.fieldThreshold || this.fields.has(to) || this.fieldQueue.includes(to)) return;
    if (this.fields.size + this.fieldQueue.length >= this.maxFields) {
      const weakest = this.weakestField();
      if (!weakest || (this.demand.get(weakest.goal) ?? 0) * 2 >= n) return;
    }
    this.fieldQueue.push(to);
  }

  weakestField() {
    let w = null, wn = Infinity;
    for (const f of this.fields.values()) {
      const n = this.demand.get(f.goal) ?? 0;
      if (n < wn) { w = f; wn = n; }
    }
    return w;
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
      if (!cells || (field.stale && !pathOpen(this.grid, cells))) continue;
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
      this.currentFieldStale = false;
    }
    const r = this.currentField.next();
    if (r.done) {
      this.currentField = null;
      const field = r.value;
      if (this.currentFieldStale) field.stale = true;
      field.demand = this.demand.get(field.goal) ?? 0;
      this.fields.set(field.goal, field);
      while (this.fields.size > this.maxFields) this.fields.delete(this.weakestField().goal);
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
