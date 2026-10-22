// Bridge geometry: every bridge (and footbridge) spans the river at right
// angles to its flow, from dry ground on one bank to dry ground on the other.
// Records carry a {x, z} and b {x, z} (the abutments), width and deckY; the
// deck's nav cells follow the a -> b line.
import { riverX, waterAt, heightAt, waterLevelAt, bankDistance, floodDepthAt, terrainVersion, FLOOD_RISE, KIND } from '../terrain.js';
import { CELL, cellOf, cellIndex, cellXZ } from './roads.js';

export const BRIDGE_WIDTH = { footbridge: 2, timber: 4, stone: 5, iron: 6 };
// Deck tier by style: the A* cost and walking speed follow it
// (footbridge = track, timber = graded road, stone and iron = paved).
export const DECK_TIER = { footbridge: 2, timber: 3, stone: 4, iron: 4 };
const DRY = 1.5;            // units past the water's edge where an abutment stands
// Deck above the water surface: planks sit low over the ford; cart bridges
// stand higher, clear of floods.
const DECK_CLEARANCE = { footbridge: 0.6, timber: 1.4, stone: 1.6, iron: 1.8 };

// Unit vector across the river at z (perpendicular to its flow, pointing east).
export function acrossAt(z) {
  const e = 0.5;
  const slope = (riverX(z + e) - riverX(z - e)) / (2 * e);   // dx/dz of the centre line
  const len = Math.hypot(1, slope);
  return { x: 1 / len, z: -slope / len };
}

// The crossing at z: abutments a (west) and b (east) on dry ground, along the
// line through the river centre perpendicular to the flow.
//
// In valleys with a floodplain (version 2), a cart bridge carries on over the
// flood meadow to ground a great flood leaves dry, so its road never floods:
// up to FLOOD_SPAN out from the river, else the first dry bank. A footbridge
// is the cheap crossing a flood may take: it stays short and low.
//
// Where the town already stands on the meadow (built(x, z) says so for a lot),
// a causeway would run on through its streets, so the bridge lands on the
// first dry bank instead; such a crossing is `cut`, and its deck need not
// clear the great flood (the town beside it floods anyway).
const FLOOD_SPAN = 60;
const FLOOD_CLEAR = 0.05;
export function crossingAt(z, style = 'timber', { built = null } = {}) {
  const c = { x: riverX(z), z };
  const n = acrossAt(z);
  const overFlood = style !== 'footbridge' && terrainVersion() >= 2;
  let cut = false;
  const end = dir => {
    let bank = null;
    for (let t = 2; t < (overFlood ? FLOOD_SPAN : 40); t += 0.5) {
      const p = { x: c.x + dir * n.x * t, z: c.z + dir * n.z * t };
      if (waterAt(p.x, p.z) || bankDistance(p.x, p.z) < DRY) continue;
      bank ??= p;
      if (!overFlood || floodDepthAt(p.x, p.z) <= FLOOD_CLEAR) return p;
      if (built?.(p.x, p.z)) { cut = true; return bank; }
    }
    return bank ?? { x: c.x + dir * n.x * 40, z: c.z + dir * n.z * 40 };
  };
  const a = end(-1), b = end(1);
  return { a, b, centre: c, length: Math.hypot(b.x - a.x, b.z - a.z), ...(cut ? { cut } : {}) };
}

// Deck cells: a supercover walk of the a -> b centre line (so the deck is
// 4-connected), widened to the deck's width. Ordered from a to b.
export function deckCells(a, b, width) {
  const out = [];
  const seen = new Set();
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / (CELL * 0.25)));
  const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
  const half = Math.max(0, width / 2 - CELL / 2);
  const lanes = half > 0 ? Math.ceil(half / (CELL * 0.5)) : 0;
  let last = -1;
  for (let k = 0; k <= steps; k++) {
    const x = a.x + (b.x - a.x) * k / steps, z = a.z + (b.z - a.z) * k / steps;
    for (let l = -lanes; l <= lanes; l++) {
      const off = lanes ? (l / lanes) * half : 0;
      const i = cellOf(x + nx * off, z + nz * off);
      if (i < 0 || seen.has(i)) continue;
      // Supercover: a diagonal step on the centre line gets the corner cell too.
      if (l === 0 && last >= 0) bridgeCorner(last, i, seen, out);
      seen.add(i);
      out.push(i);
      if (l === 0) last = i;
    }
  }
  return out;
}

function bridgeCorner(prev, next, seen, out) {
  const [px, pz] = cellXZ(prev), [qx, qz] = cellXZ(next);
  if (px === qx || pz === qz) return;
  const corner = cellIndex(qx, pz);
  if (corner >= 0 && !seen.has(corner)) { seen.add(corner); out.push(corner); }
}

export function deckYFor(a, b, z, style = 'timber', { cut = false } = {}) {
  let water = waterLevelAt(z) + (DECK_CLEARANCE[style] ?? 1.4);
  // A cart deck over a floodplain clears the great flood too (not one cut
  // short at the town's edge).
  if (style !== 'footbridge' && terrainVersion() >= 2 && !cut) water = Math.max(water, waterLevelAt(z) + FLOOD_RISE[KIND.RIVER] + 0.4);
  // A footbridge keeps low even where the banks are high; cart decks never dip below the banks.
  return style === 'footbridge' ? water : Math.max(heightAt(a.x, a.z), heightAt(b.x, b.z), water);
}

// Building-record fields for a bridge at a crossing.
export function bridgeGeometry(crossing, style, { width: wide = null } = {}) {
  const width = wide ?? BRIDGE_WIDTH[style] ?? 4;
  const { a, b, centre, length } = crossing;
  return {
    a, b, width, style, deckY: Math.round(deckYFor(a, b, centre.z, style, { cut: !!crossing.cut }) * 100) / 100,
    ...(crossing.cut ? { cut: true } : {}),
    x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: length, d: width, rot: 1,
    cells: deckCells(a, b, width),
  };
}

// ---------------------------------------------------------------- deck surface

// The one deck surface everyone uses (walkers in sim-core, the mesh in
// artisan-render): y at t in 0..1 along a -> b. Ramps rise from the bank
// ground at each end to deckY over RAMP units; stone and iron decks also
// hump over the arch by ARCH_RISE at mid-span.
export const RAMP = 3;
export const ARCH_RISE = { footbridge: 0, timber: 0, stone: 0.5, iron: 0.25 };

export function deckProfile(bridge, t) {
  const tt = Math.max(0, Math.min(1, t));
  const len = Math.hypot(bridge.b.x - bridge.a.x, bridge.b.z - bridge.a.z);
  const ga = heightAt(bridge.a.x, bridge.a.z), gb = heightAt(bridge.b.x, bridge.b.z);
  // A high deck over a floodplain comes down on longer ramps (about 1 in 3).
  const climb = terrainVersion() >= 2 ? Math.max(bridge.deckY - ga, bridge.deckY - gb) * 3 : 0;
  const ramp = Math.min(Math.max(RAMP, climb), len / 4) / Math.max(len, 1e-6);
  const rise = (ARCH_RISE[bridge.style ?? bridge.variant] ?? 0) * Math.sin(Math.PI * tt);
  const deck = bridge.deckY + rise;
  if (tt < ramp) return ga + (deck - ga) * smooth(tt / ramp);
  if (tt > 1 - ramp) return gb + (deck - gb) * smooth((1 - tt) / ramp);
  return deck;
}

function smooth(u) { return u * u * (3 - 2 * u); }

// Where a point lies along a bridge (t), and how far off its centre line.
export function alongBridge(bridge, x, z) {
  const dx = bridge.b.x - bridge.a.x, dz = bridge.b.z - bridge.a.z;
  const len2 = dx * dx + dz * dz;
  const t = ((x - bridge.a.x) * dx + (z - bridge.a.z) * dz) / len2;
  const px = bridge.a.x + t * dx, pz = bridge.a.z + t * dz;
  return { t, off: Math.hypot(x - px, z - pz) };
}

// Height of the deck surface under a point, or null off every finished deck. Beside the
// deck, a verge of DECK_VERGE units slopes from the deck's edge down to the ground, so
// a passer-by brushing a ramp climbs it a little instead of meeting a step.
export const DECK_VERGE = 0.6;

export function deckSurfaceY(bridge, t, off, x, z) {
  const y = deckProfile(bridge, t);
  const edge = (bridge.width ?? 3) / 2;
  if (off <= edge) return y;
  const k = Math.min(1, (off - edge) / DECK_VERGE);
  return y + (heightAt(x, z) - y) * k;
}

export function deckHeightAt(state, x, z) {
  for (const b of state.buildings ?? []) {
    if (b.type !== 'bridge' || !b.a || (b.built ?? 1) < 1) continue;
    const { t, off } = alongBridge(b, x, z);
    if (t < 0 || t > 1 || off > b.width / 2 + DECK_VERGE) continue;
    return deckSurfaceY(b, t, off, x, z);
  }
  return null;
}

// ---------------------------------------------------------------- traffic and wear

// Capacity: a bridge is built for the crossing it serves. Its design traffic
// is the most it carried in its first DESIGN_YEARS (or, on a replacement, the
// traffic it took over), and it carries HEADROOM times that comfortably,
// more for stone and for a wider deck (iron: no limit). Traffic is counted in
// whatever units the counters use (route-planner walks, tie trips), so the
// load is the same reading headless and in play.
export const DESIGN_YEARS = 3;
export const HEADROOM = 2.2;
const DESIGN_FLOOR = 400;
const STRENGTH = { footbridge: 0.5, timber: 1, stone: 2, iron: Infinity };

// Trips a year this bridge carries comfortably.
export function bridgeCapacity(b) {
  const style = b.variant ?? b.style;
  const strength = STRENGTH[style] ?? 1;
  if (!Number.isFinite(strength)) return Infinity;
  const wide = (b.width ?? BRIDGE_WIDTH[style] ?? 4) / (BRIDGE_WIDTH[style] ?? 4);
  return HEADROOM * strength * wide * Math.max(DESIGN_FLOOR, b.designTraffic ?? b.traffic ?? 0);
}

// Yearly, after the bridge ages: the design traffic follows the traffic in
// the first years, then stays. Older bridges from saves before this rule take
// today's traffic.
export function settleDesignTraffic(b) {
  if (b.designTraffic != null && (b.age ?? 0) > DESIGN_YEARS) return;
  b.designTraffic = Math.round(Math.max(b.designTraffic ?? 0, b.traffic ?? 0));
}

// traffic (trips a year, decaying like crossing demand) over capacity.
export function bridgeLoad(state, b) {
  const cap = bridgeCapacity(b);
  return Number.isFinite(cap) ? (b.traffic ?? 0) / cap : 0;
}

// Yearly chance a bridge gives way: worn bridges are at risk, overloaded ones
// (up to twice their capacity) more so.
export function bridgeCollapseRisk(state, b) {
  if (b.variant === 'footbridge' || (b.built ?? 1) < 1) return 0;
  return 0.08 * (1 - (b.condition ?? 1)) * Math.min(2, Math.max(1, bridgeLoad(state, b)));
}

// Finished decks by cell: Map cell -> bridge id. Cached on the bridge list.
const deckCache = new WeakMap();

export function deckIndex(state) {
  const bridges = (state.buildings ?? []).filter(b => b.type === 'bridge' && b.a && (b.built ?? 1) >= 1);
  const key = bridges.map(b => b.id).join(',');
  const hit = deckCache.get(state);
  if (hit && hit.key === key) return hit.map;
  const map = new Map();
  for (const b of bridges) for (const i of deckCells(b.a, b.b, b.width)) map.set(i, b.id);
  deckCache.set(state, { key, map });
  return map;
}

// A walker's route crossed these decks: count the trips.
export function countDeckTrips(state, cells, weight = 1) {
  if (!cells) return;
  const index = deckIndex(state);
  if (!index.size) return;
  const seen = new Set();
  for (const i of cells) {
    const id = index.get(i);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    const b = (state.buildings ?? []).find(x => x.id === id);
    if (b) b.traffic = (b.traffic ?? 0) + weight;
  }
}
