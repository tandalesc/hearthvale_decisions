// Leisure places beyond buildings: places on the shore of any water (the river, creeks,
// lakes, ponds, the sea), bridge decks, the woods' edge and the far ends of the tracks
// out of town. Each place has an id ('bank:-31,12',
// 'deck:356', 'wood:4', 'trail:7'), a point (x, z) people head for, and whatever its
// layouts need (gatherings.js LAYOUTS: bank, bankside, rail, woodedge, view).
//
// The index is a pure function of the state as it is (so a restored town finds the same
// places), and cheap to keep: banks, decks and woods depend only on the terrain, the
// bridges and the town's middle and size (bucketed), so they are found again only when
// those move; trail ends (on the road grid, past the houses) are found again whenever
// the footprints change, by a few rays out from the middle. Places say only where to
// head: their spots are checked against the walls of the moment by the layouts
// (gatherings.js, cached per footprint key). Nothing here is saved.

import {riverX, bankDistance, heightAt, waterAt, fordAt, FORDS, nearestWaterKind, waterKindAt, stillDistanceAt, stillBodyKind, terrainWaters, KIND, KIND_NAMES} from '../terrain.js';
import {coveAt} from '../waters.js';
import {alongBridge} from './bridges.js';
import {woodField, woodGradient, WOOD_IN, WOOD_OUT} from '../woodland.js';
import {hashUnit} from './rng.js';
import {footprints, footprintKey, cellCenter} from './roads.js';
import {cellIndex} from './state.js';
import {deckAt, bridgeDecks} from './people.js';

const BANK_SEG = 24;            // shore places stand this far apart
const SHORE_GRID = 5;           // the grid the shore is sought on
const FORD_CLEAR = 12;          // no shore place this near a river ford (fast, shallow, a crossing)
const BANK_SET = 1.2;           // anglers stand this far back from the water's edge
const WOOD_STEP = 10;           // grid the woods' edge is sought on
const APART = {wood: 26, trail: 30};
const REACH = 210;              // places are sought this far beyond the town's edge
const TRAIL_RAYS = 64, TRAIL_OUT = 120;

const cache = new WeakMap();

/** The town's middle and radius (as the renderer frames it: render/index.js townCentre). */
export function townFrame(state) {
  const list = state.buildings ?? [];
  if (!list.length) return {x: 0, z: 0, radius: 40};
  const xs = list.map((b) => b.x).sort((a, b) => a - b), zs = list.map((b) => b.z).sort((a, b) => a - b);
  const x = xs[xs.length >> 1], z = zs[zs.length >> 1];
  const ds = list.map((b) => Math.hypot(b.x - x, b.z - z)).sort((a, b) => a - b);
  return {x, z, radius: ds[Math.floor(ds.length * 0.8)] + 12};
}


/** The place index: {banks, decks, woods, trails, byId, town}. */
export function placeIndex(state) {
  // Finished bridges (people.js keeps the list): the same list object until a building
  // changes; then the ids say whether the bridges did.
  const decks = bridgeDecks(state);
  const hit = cache.get(state);
  const fp = footprintKey(state);
  if (hit && hit.deckRef === decks && hit.fp === fp) return hit;
  const bridges = decks.map((d) => d.bridge);
  const bridgeKey = bridges.map((b) => b.id).join(',');
  const key = `${fp}:${bridgeKey}`;
  if (hit && hit.key === key) {
    hit.deckRef = decks;
    return hit;
  }
  const town = townFrame(state);
  // The static places are laid out from the frame snapped to 20 units, so the same
  // snapped frame always gives the same places (however it was reached).
  const snap = {x: Math.round(town.x / 20) * 20, z: Math.round(town.z / 20) * 20, radius: Math.round(town.radius / 20) * 20};
  const frameKey = `${snap.x},${snap.z},${snap.radius}:${bridgeKey}`;
  const stat = hit && hit.frameKey === frameKey ? hit : staticPlaces(snap, bridges);
  const out = {key, fp, deckRef: decks, frameKey, town, banks: stat.banks, decks: stat.decks, woods: stat.woods, trails: trailEnds(state, town), byId: new Map()};
  for (const list of [out.banks, out.decks, out.woods, out.trails]) for (const p of list) out.byId.set(p.id, p);
  cache.set(state, out);
  return out;
}

// Banks, decks and woods: terrain, bridges and the town frame only.
function staticPlaces(town, bridges) {
  const out = {banks: [], decks: [], woods: []};
  // Shore places, by any water (the river, creeks, lakes, ponds, the sea): where the
  // shore BANK_SET back from the water crosses a SHORE_GRID round the town, moved onto
  // it, nearest the town first and BANK_SEG apart; off bridge ends; each facing its
  // water, with its kind and how calm the water is. A dry valley has none.
  const R = town.radius + REACH * 0.6, n0 = Math.ceil(R / SHORE_GRID), cands = [];
  for (let j = -n0; j <= n0; j++)
    for (let i = -n0; i <= n0; i++) {
      const gx = town.x + i * SHORE_GRID, gz = town.z + j * SHORE_GRID;
      if (Math.hypot(gx - town.x, gz - town.z) > R) continue;
      const d = bankDistance(gx, gz);
      if (!Number.isFinite(d) || Math.abs(d - BANK_SET) > SHORE_GRID * 0.75) continue;
      const q = toShore(gx, gz, BANK_SET);
      if (!q || waterAt(q[0], q[1])) continue;
      cands.push({x: q[0], z: q[1], d: Math.hypot(q[0] - town.x, q[1] - town.z)});
    }
  cands.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);
  for (const c of cands) {
    if (out.banks.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < BANK_SEG)) continue;
    if (bridges.some((b) => { const {t, off} = alongBridge(b, c.x, c.z); return t > -0.3 && t < 1.3 && off < (b.width ?? 3) / 2 + 6; })) continue;
    const g = shoreGradient(c.x, c.z);
    if (!g || riverFordNear(c.x, c.z, -g[0], -g[1], FORD_CLEAR)) continue;
    const {kind, calm} = calmAt(c.x, c.z, -g[0], -g[1], bridges);
    out.banks.push({id: `bank:${Math.round(c.x)},${Math.round(c.z)}`, kind: 'bank', water: kind, x: c.x, z: c.z, fx: -g[0], fz: -g[1], calm});
  }
  // Bridge decks: the point people head for is on the bank just off an end (a walk
  // planned from, or to, the middle of a deck could step on or off it by its side;
  // the spots at the rail are walked to from here, along the deck).
  for (const b of bridges) {
    const L = Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z) || 1;
    let end = null;
    for (const [e, o] of [[b.a, b.b], [b.b, b.a]]) {
      const x = e.x + ((e.x - o.x) / L) * 2, z = e.z + ((e.z - o.z) / L) * 2;
      if (!waterAt(x, z)) { end = {x, z}; break; }
    }
    if (end) out.decks.push({id: `deck:${b.id}`, kind: 'deck', x: end.x, z: end.z, bridge: b});
  }
  // The woods' edge: grassy points just outside a wood (woodField between WOOD_OUT and
  // WOOD_IN, rising toward it), dry, below the treeline, on gentle ground, well apart.
  const r0 = town.radius * 0.6, r1 = town.radius + REACH;
  // On a world-aligned jittered grid, so the same points (and ids) come back however the
  // town's frame moves.
  const i0 = Math.floor((town.x - r1) / WOOD_STEP), i1 = Math.ceil((town.x + r1) / WOOD_STEP);
  const j0 = Math.floor((town.z - r1) / WOOD_STEP), j1 = Math.ceil((town.z + r1) / WOOD_STEP);
  const found = [];
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const x = (i + hashUnit((i + 4096) * 7919 + j + 4096)) * WOOD_STEP;
      const z = (j + hashUnit((j + 4096) * 6007 + i + 4096)) * WOOD_STEP;
      const d = Math.hypot(x - town.x, z - town.z);
      if (d < r0 || d > r1) continue;
      const w = woodField(x, z);
      if (w < WOOD_OUT + 0.02 || w > WOOD_IN - 0.03) continue;
      const [gx, gz] = woodGradient(x, z);
      const g = Math.hypot(gx, gz);
      if (g < 0.004) continue;
      if (bankDistance(x, z) < 6 || heightAt(x, z) > 28) continue;
      const slope = Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1));
      if (slope > 0.8) continue;
      found.push({x, z, gx: gx / g, gz: gz / g, d});
    }
  found.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);
  for (const f of found) {
    if (out.woods.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < APART.wood)) continue;
    out.woods.push({id: `wood:${Math.round(f.x)},${Math.round(f.z)}`, kind: 'wood', x: f.x, z: f.z, gx: f.gx, gz: f.gz});
  }
  return out;
}

// Trail ends: along TRAIL_RAYS rays out from the town's middle, the furthest track or lane
// cell (tier 1-2, open, dry, off decks) between the houses' edge (85% of homes are
// nearer the middle) and TRAIL_OUT beyond it, with no home within 12; well apart;
// facing away from town.
function trailEnds(state, town) {
  const r = state.roads, {blocked} = footprints(state);
  const homes = (state.buildings ?? []).filter((b) => b.type === 'home');
  const homeD = homes.map((b) => Math.hypot(b.x - town.x, b.z - town.z)).sort((a, b) => a - b);
  const edge = homeD.length ? homeD[Math.floor(homeD.length * 0.85)] : town.radius * 0.55;
  const out = [];
  for (let k = 0; k < TRAIL_RAYS; k++) {
    const a = (k / TRAIL_RAYS) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
    let best = null;
    for (let d = edge; d <= edge + TRAIL_OUT; d += 2) {
      const c = cellIndex(r, town.x + ux * d, town.z + uz * d);
      if (c < 0 || !r.tier[c] || r.tier[c] > 2 || blocked[c]) continue;
      best = c;
    }
    if (best == null) continue;
    const {x, z} = cellCenter(best);
    if (waterAt(x, z) || deckAt(state, x, z)) continue;
    if (homes.some((b) => Math.abs(b.x - x) < 12 && Math.abs(b.z - z) < 12)) continue;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < APART.trail)) continue;
    const l = Math.hypot(x - town.x, z - town.z) || 1;
    out.push({id: `trail:${best}`, kind: 'trail', x, z, ox: (x - town.x) / l, oz: (z - town.z) / l});
  }
  return out;
}

export const placeById = (state, id) => placeIndex(state).byId.get(id) ?? null;

// ---------------------------------------------------------------------------
// Shores: of any water (terrain.js bankDistance measures to the nearest river, creek,
// lake, pond or sea). A shore at `level` is the line `level` back from the water's
// edge; its gradient points inland, so the water lies along -gradient.

/** Unit gradient of the distance to water at (x, z) (pointing inland), or null. */
export function shoreGradient(x, z) {
  const h = 0.5;
  const gx = (bankDistance(x + h, z) - bankDistance(x - h, z)) / (2 * h);
  const gz = (bankDistance(x, z + h) - bankDistance(x, z - h)) / (2 * h);
  const l = Math.hypot(gx, gz);
  return Number.isFinite(l) && l > 0.3 ? [gx / l, gz / l] : null;
}

/** (x, z) moved onto the shore at `level` (Newton steps down the distance field), or null. */
export function toShore(x, z, level) {
  for (let i = 0; i < 6; i++) {
    const e = bankDistance(x, z) - level;
    if (!Number.isFinite(e)) return null;
    if (Math.abs(e) < 0.02) return [x, z];
    const g = shoreGradient(x, z);
    if (!g) return null;
    x -= g[0] * e;
    z -= g[1] * e;
  }
  return Math.abs(bankDistance(x, z) - level) < 0.1 ? [x, z] : null;
}

/**
 * Points along the shore at `level` through (x0, z0), `step` apart, out to `reach`
 * along it each way: [{x, z, s, fx, fz}] with s the distance along the shore (signed)
 * and (fx, fz) the unit direction to the water. Stops where the shore runs out (into
 * another body's field, or off a creek's end).
 */
export function traceShore(x0, z0, level, step, reach) {
  const start = toShore(x0, z0, level);
  if (!start) return [];
  const out = [];
  for (const dir of [1, -1]) {
    let [x, z] = start;
    for (let s = dir > 0 ? 0 : step; s <= reach; s += step) {
      if (s > 0) {
        const g = shoreGradient(x, z);
        if (!g) break;
        const p = toShore(x - g[1] * dir * step, z + g[0] * dir * step, level);
        if (!p || Math.hypot(p[0] - x, p[1] - z) > step * 1.6) break;
        [x, z] = p;
      }
      const g = shoreGradient(x, z);
      if (!g) break;
      out.push({x, z, s: s * dir, fx: -g[0], fz: -g[1]});
    }
  }
  return out;
}

/**
 * A river ford (fast, shallow water people wade across) within `reach` along the shore
 * of (x, z), which faces (fx, fz): sampled 3 out into the water. Creeks (wadeable all
 * along) do not count: their shores are shallow channels, not crossings.
 */
export function riverFordNear(x, z, fx, fz, reach) {
  for (let d = -reach; d <= reach; d += 4) {
    const wx = x + fx * 3 - fz * d, wz = z + fz * 3 + fx * d;
    if (fordAt(wx, wz) && waterKindAt(wx, wz) !== KIND.CREEK) return true;
  }
  return false;
}

// How calm the water off a shore point is (0..1): lakes and ponds are calm, a great
// lake a little less, the sea rougher (its coves calmer); a river by its straightness
// and its distance from fords and bridges; creeks are wadeable fords, and any ford
// close by is avoided.
function calmAt(x, z, fx, fz, bridges) {
  const wx = x + fx * 3, wz = z + fz * 3;
  const kind = nearestWaterKind(x, z);
  let calm;
  if (kind === KIND.LAKE) {
    stillDistanceAt(x, z);
    calm = stillBodyKind() === -KIND.LAKE ? 0.85 : 1;
  } else if (kind === KIND.POND) calm = 1;
  else if (kind === KIND.SEA) {
    const W = terrainWaters();
    calm = 0.4 + (W?.sea ? 0.4 * coveAt(W.sea, x) : 0);
  } else if (kind === KIND.CREEK) calm = 0.25;
  else {
    let flow = Infinity;
    if (!terrainWaters()) for (const f of FORDS) flow = Math.min(flow, Math.abs(f.z - z));
    for (const b of bridges) flow = Math.min(flow, Math.hypot((b.a.x + b.b.x) / 2 - x, (b.a.z + b.b.z) / 2 - z));
    const bend = Math.abs(riverX(z + 10) - 2 * riverX(z) + riverX(z - 10));
    calm = Math.max(0, Math.min(1, flow / 40)) * Math.max(0, 1 - bend / 3);
  }
  if (fordAt(wx, wz) && kind !== KIND.CREEK) calm *= 0.3;
  return {kind: KIND_NAMES[kind] ?? 'river', calm};
}
