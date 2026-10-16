// A building's outline at walking height, as it is drawn: walls, the plinth or skirt
// under them (the kit's bands stand 0.18 m proud of the walls), steps, side wings and
// lean-tos, bay windows, porticos, piles. render/kit/compose.js composeLot lays these
// out from the building record; the sim takes its ground-level pieces so walkers'
// footprints (roads.js footprints) cover everything a walker could visibly walk into,
// not just the lot's w x d.
//
// A piece counts when it stands at body height above the ground beside it (from 0.12 to
// 1.6 m above it): high bands (cornices, sign boards), balconies, awnings, roofs, a
// market hall's posts and scaffolds (which people walk among) do not. A lean-to's
// frame does: nobody walks through a workshop.
//
// Pure for a given building record and terrain: cached on the record by the fields the
// shape depends on (keyOf), so a restored town stamps the same cells.

import {composeLot, createSpecPool} from '../render/kit/compose.js';
import {heightAt} from '../terrain.js';

const SOLID = new Set(['body', 'band', 'piles', 'portico', 'posts']);
const pool = createSpecPool();
const cache = new WeakMap();

// Everything composeLot reads that shapes the pieces (not colours, lights or smoke).
// The outline is the finished building's: a site under construction keeps clear of
// what it will be. Each of these changes with a world bump (roads.js bumpWorld), so a
// footprint built at any moment between bumps agrees with one built at the last.
const keyOf = (b) => `${b.id},${b.x},${b.z},${b.w},${b.d},${b.rot},${b.type},${b.tier},${b.variant},${b.archetype},${b.styleEra},${b.storeys},` +
  `${b.foundation},${b.foundationY},${b.foundationDrop},${b.flags?.square ? 1 : 0},${b.extensions?.length ? JSON.stringify(b.extensions) : ''}`;

/**
 * The building's solid pieces at walking height: [{x, z, c, s, hx, hz}], each an
 * oriented rectangle (centre, cos and sin of its yaw, half extents), the kit's own
 * margins included (bands 0.18 m, piles 0.13 m).
 */
export function buildingOutline(b) {
  const key = keyOf(b);
  const hit = cache.get(b);
  if (hit && hit.key === key) return hit.rects;
  const rects = [];
  if (b.type !== 'bridge' && b.type !== 'park') {
    composeLot({...b, built: 1}, pool);
    for (let i = 0; i < pool.count(); i++) {
      const sp = pool.at(i);
      if (!SOLID.has(sp.piece) || (sp.piece === 'posts' && b.type === 'market')) continue;
      const g = heightAt(sp.x, sp.z);
      if (sp.y + sp.sy < g + 0.12 || sp.y > g + 1.6) continue;
      const pad = sp.piece === 'band' ? 0.18 : sp.piece === 'piles' ? 0.13 : sp.piece === 'posts' ? 0.11 : 0;
      rects.push({x: sp.x, z: sp.z, c: Math.cos(sp.yaw), s: Math.sin(sp.yaw), hx: Math.abs(sp.sx) / 2 + pad, hz: Math.abs(sp.sz) / 2 + pad});
    }
  }
  cache.set(b, {key, rects});
  return rects;
}

/** Is (x, z) within `m` of the rectangle r? */
export function inRect(r, x, z, m = 0) {
  const dx = x - r.x, dz = z - r.z;
  // The kit turns local (x, z) to world as (x c + z s, -x s + z c).
  const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
  return Math.abs(lx) < r.hx + m && Math.abs(lz) < r.hz + m;
}

/** The rectangle's world bounding box grown by m: [x0, z0, x1, z1]. */
export function rectBounds(r, m = 0) {
  const ex = Math.abs(r.c) * (r.hx + m) + Math.abs(r.s) * (r.hz + m);
  const ez = Math.abs(r.s) * (r.hx + m) + Math.abs(r.c) * (r.hz + m);
  return [r.x - ex, r.z - ez, r.x + ex, r.z + ez];
}
