// Coarse crowd density: visible walkers (standing or walking, not indoors) counted in
// DENSITY_BLOCK-unit blocks over the road grid's region, read smoothed over the
// 3 x 3 blocks round a point. A busy centre reads higher than a side street; it is
// not an occupancy count. Walkers' destination choice uses it (people.js pickQuiet);
// a route cost can too.
//
// The grid is a pure function of the state at the moment it is built. people.js
// rebuilds it at the start of every walker step (a single pass over the walkers,
// a few microseconds); reading it for another state, or a later tick, rebuilds it
// from that state. Nothing is saved: a restored town rebuilds the same grid on its
// first step. (A slower cadence, or decay over time, would make the grid history
// that a save would have to carry.)

export const DENSITY_BLOCK = 8;

const grids = new WeakMap();   // state -> {tick, W, H, ox, oz, counts}

export function rebuildDensity(state) {
  const r = state.roads;
  const W = Math.ceil((r.W * r.cell) / DENSITY_BLOCK), H = Math.ceil((r.H * r.cell) / DENSITY_BLOCK);
  let g = grids.get(state);
  if (!g || g.W !== W || g.H !== H) {
    g = {tick: -1, W, H, ox: r.ox, oz: r.oz, counts: new Uint16Array(W * H)};
    grids.set(state, g);
  } else g.counts.fill(0);
  g.ox = r.ox;
  g.oz = r.oz;
  g.tick = state.time.tick;
  const counts = g.counts;
  for (const p of state.people) {
    if (p.indoor) continue;
    const i = Math.floor((p.x - g.ox) / DENSITY_BLOCK), j = Math.floor((p.z - g.oz) / DENSITY_BLOCK);
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    const k = j * W + i;
    if (counts[k] < 65535) counts[k]++;
  }
  return g;
}

function gridOf(state) {
  const g = grids.get(state);
  return g && g.tick === state.time.tick ? g : rebuildDensity(state);
}

// Walkers per block round (x, z): the block itself, its edge neighbours at half and
// its corner neighbours at a quarter weight, over the weights' sum (4).
export function densityAt(state, x, z) {
  const g = gridOf(state);
  const ci = Math.floor((x - g.ox) / DENSITY_BLOCK), cj = Math.floor((z - g.oz) / DENSITY_BLOCK);
  let sum = 0;
  for (let dj = -1; dj <= 1; dj++) {
    const j = cj + dj;
    if (j < 0 || j >= g.H) continue;
    for (let di = -1; di <= 1; di++) {
      const i = ci + di;
      if (i < 0 || i >= g.W) continue;
      const n = g.counts[j * g.W + i];
      if (n) sum += n * (di === 0 ? 1 : 0.5) * (dj === 0 ? 1 : 0.5);
    }
  }
  return sum / 4;
}
