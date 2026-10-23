// Nearest-first searches over points (buildings, walkers) by a coarse grid, for the
// sim's "nearest of" choices (people.js nearestOf, assignBuilders). The searches give
// exactly the answers of a scan over every point: callers either keep the scan's
// tie-break (assignBuilders) or fall back to the scan when a tie could matter (nearestOf).

// A grid of points 0..n-1 at (xs[i], zs[i]), `cell` units a side, as buckets in a flat
// list (start[b]..start[b + 1] in items): within a bucket, points keep their order.
export function pointGrid(xs, zs, n, cell) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < x0) x0 = xs[i];
    if (xs[i] > x1) x1 = xs[i];
    if (zs[i] < z0) z0 = zs[i];
    if (zs[i] > z1) z1 = zs[i];
  }
  if (!n) x0 = z0 = x1 = z1 = 0;
  const W = Math.max(1, Math.floor((x1 - x0) / cell) + 1), H = Math.max(1, Math.floor((z1 - z0) / cell) + 1);
  const bucketOf = new Int32Array(n);
  const start = new Int32Array(W * H + 1);
  for (let i = 0; i < n; i++) {
    const b = Math.min(H - 1, Math.floor((zs[i] - z0) / cell)) * W + Math.min(W - 1, Math.floor((xs[i] - x0) / cell));
    bucketOf[i] = b;
    start[b + 1]++;
  }
  for (let b = 0; b < W * H; b++) start[b + 1] += start[b];
  const fill = start.slice(0, W * H);
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) items[fill[bucketOf[i]]++] = i;
  return {x0, z0, cell, W, H, start, items, n};
}

// Visits the grid's points ring by ring outward from (x, z): every point of the buckets
// in ring r (Chebyshev distance r from the bucket (x, z) falls in, clamped to the grid)
// goes to visit(i), then enough(bound2) is asked with the squared distance from (x, z)
// within which every point not yet visited lies further off (it is at least bound away).
// Stops when enough says so or the grid is covered.
export function ringSearch(grid, x, z, visit, enough) {
  const {x0, z0, cell, W, H, start, items} = grid;
  const bx = Math.floor((x - x0) / cell), bz = Math.floor((z - z0) / cell);
  // Rings that can hold a bucket of the grid at all.
  const rMin = Math.max(0, bx - (W - 1), -bx, bz - (H - 1), -bz);
  const rMax = Math.max(bx, W - 1 - bx, bz, H - 1 - bz);
  for (let r = rMin; r <= rMax; r++) {
    for (let j = bz - r; j <= bz + r; j++) {
      if (j < 0 || j >= H) continue;
      const edge = j === bz - r || j === bz + r;
      for (let i = bx - r; i <= bx + r; i += edge ? 1 : 2 * r || 1) {
        if (i < 0 || i >= W) continue;
        const b = j * W + i;
        for (let k = start[b]; k < start[b + 1]; k++) visit(items[k]);
      }
    }
    if (r === rMax) return;
    // The square searched so far, and how far (x, z) is from leaving it.
    const sx0 = x0 + (bx - r) * cell, sx1 = x0 + (bx + r + 1) * cell;
    const sz0 = z0 + (bz - r) * cell, sz1 = z0 + (bz + r + 1) * cell;
    // (A hair inside it, so rounding in a caller's squared distances can never put an
    // unvisited point within it.)
    const bound = Math.min(x - sx0, sx1 - x, z - sz0, sz1 - z);
    if (bound > 0 && enough(bound * bound * (1 - 1e-9))) return;
  }
}
