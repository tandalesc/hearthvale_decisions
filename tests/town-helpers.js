// Helpers for tests that read a grown fixture town. A grown town's layout is
// incidental (an economic change regrows it differently), so a test that needs
// a market, a chapel or a business that can move takes one this way rather than
// assuming the fixture happens to have it.

// The town's market, or (none built) the built shop nearest the town's middle
// turned into one, as the two-market crowd tests do for their second stall.
export function marketOf(s, type = 'market') {
  const have = s.buildings.find((b) => b.type === type && (b.built ?? 1) >= 1);
  if (have) return have;
  const mid = middleOf(s);
  let best = null, dist = Infinity;
  for (const b of s.buildings) {
    if (b.type !== 'shop' || (b.built ?? 1) < 1) continue;
    const d = Math.hypot(b.x - mid.x, b.z - mid.z);
    if (d < dist || (d === dist && b.id < best.id)) { best = b; dist = d; }
  }
  if (!best) return null;
  best.type = type;
  s.buildingsRev = (s.buildingsRev ?? 0) + 1;
  return best;
}

// The town's middle: its moot hall, else the mean of its buildings.
export function middleOf(s) {
  const moot = s.buildings.find((b) => b.type === 'moot');
  if (moot) return {x: moot.x, z: moot.z};
  const n = s.buildings.length || 1;
  return {x: s.buildings.reduce((a, b) => a + b.x, 0) / n, z: s.buildings.reduce((a, b) => a + b.z, 0) / n};
}
