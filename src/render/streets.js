// Street fabric: what the ground between and beside buildings becomes as a
// town grows (render-only; the sim's road grid is untouched). One class per
// road cell, worked out from the cell tiers and the building footprints:
//
//   ALLEY    a worn lane squeezed between buildings (built ground within two
//            cells on both sides), and, from the town era, a gap between
//            houses that runs through from one street to another (a ginnel).
//            Surfaced wall to wall: packed earth until the borough era, then
//            cobbles or setts with a centre gutter (PAVED_ALLEY); earlier only
//            where the passage opens onto a paved road (towns pave their main
//            streets first). A lone cell, or a scrap of footway, is left out.
//   FOOTWAY  from the borough era, open ground between a made road (tier 3+)
//            and the building fronts it serves: a flagstone pavement, kerbed
//            along the carriageway (roads.js ROAD_GLSL). Worn side paths on a
//            footway are drawn as the pavement, not as a dirt strip.
//
// The terrain reads the classes as a texture (tStreet, roads.js); groundcover
// keeps grass off them and decor keeps verge planting off them.

export const STREET = { NONE: 0, ALLEY: 1, FOOTWAY: 2, PAVED_ALLEY: 3 };

// Footprint coverage (0..255, max over pads) that counts as built ground. A
// one-cell gap between two pads (footprint + 0.6 m) is covered ~0.3: open.
const BUILT = 140;
// Era (sim/eras.js) from which each class appears.
export const ALLEY_GAPS_ERA = 2;  // through gaps between houses become ginnels
export const FOOTWAY_ERA = 3;     // made roads get kerbed pavements
const MAX_PASSAGE = 40;           // cells in a gap component worth paving through

/**
 * Classify every cell. `foot` is the footprint coverage per cell, `tier` the
 * road tiers; writes STREET classes into `out` (Uint8Array W*H).
 */
export function classifyStreets(W, H, tier, foot, era, out) {
  out.fill(0);
  const built = (x, z) => x >= 0 && z >= 0 && x < W && z < H && foot[z * W + x] >= BUILT;
  const near = (x, z, dx, dz) => built(x + dx, z + dz) || built(x + 2 * dx, z + 2 * dz);
  const enclosed = (x, z) =>
    (near(x, z, -1, 0) && near(x, z, 1, 0)) || (near(x, z, 0, -1) && near(x, z, 0, 1));

  // 1. Lanes between buildings: worn or tracked cells hemmed in on both sides.
  //    A made road (tier 3) counts until kerbed pavements arrive; after that it
  //    is a street with footways, and paved roads (4+) always are.
  const laneMax = era >= FOOTWAY_ERA ? 2 : 3;
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const t = tier[i];
      if (t < 1 || t > laneMax || foot[i] >= BUILT) continue;
      if (enclosed(x, z)) out[i] = STREET.ALLEY;
    }
  }

  // 2. From the town era: gaps between houses that run through to two
  //    different streets (contacts at least three cells apart) are paved as
  //    passages. Flood each enclosed open component once.
  if (era >= ALLEY_GAPS_ERA) {
    const seen = new Uint8Array(W * H);
    const stack = [];
    const comp = [];
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const i0 = z * W + x;
        if (seen[i0] || tier[i0] || foot[i0] >= BUILT || !enclosed(x, z)) continue;
        comp.length = 0;
        stack.push(i0);
        seen[i0] = 1;
        let cx0 = Infinity, cx1 = -Infinity, cz0 = Infinity, cz1 = -Infinity;
        while (stack.length) {
          const i = stack.pop();
          comp.push(i);
          const ix = i % W, iz = (i / W) | 0;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = ix + dx, nz = iz + dz;
            if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
            const n = nz * W + nx;
            if (tier[n]) {
              // A street or lane touches the gap here.
              cx0 = Math.min(cx0, nx); cx1 = Math.max(cx1, nx);
              cz0 = Math.min(cz0, nz); cz1 = Math.max(cz1, nz);
              continue;
            }
            if (seen[n] || foot[n] >= BUILT || !enclosed(nx, nz)) continue;
            seen[n] = 1;
            stack.push(n);
          }
        }
        const through = Math.max(cx1 - cx0, cz1 - cz0) >= 3;
        if (through && comp.length <= MAX_PASSAGE) for (const i of comp) out[i] = STREET.ALLEY;
      }
    }
  }

  // 3. From the borough era: pavements along made roads where they front
  //    buildings (built ground within two cells of the pavement).
  if (era >= FOOTWAY_ERA) {
    const reach = era >= 4 ? 3 : 2;
    for (let z = 1; z < H - 1; z++) {
      for (let x = 1; x < W - 1; x++) {
        const i = z * W + x;
        if (tier[i] >= 3 || out[i] || foot[i] >= BUILT) continue;
        if (tier[i - 1] < 3 && tier[i + 1] < 3 && tier[i - W] < 3 && tier[i + W] < 3) continue;
        let fronts = false;
        for (let dz = -reach; dz <= reach && !fronts; dz++)
          for (let dx = -reach; dx <= reach; dx++) if (built(x + dx, z + dz)) { fronts = true; break; }
        if (fronts) out[i] = STREET.FOOTWAY;
      }
    }
  }
  // 4. Tidy: drop fragments (a lone enclosed cell on a long dirt path, a
  //    scrap of pavement), and pave the alleys that are paved.
  tidy(W, H, tier, era, out);
  return out;
}

const MIN_ALLEY = 2;
const MIN_FOOTWAY = 3;

function tidy(W, H, tier, era, out) {
  const seen = new Uint8Array(W * H);
  const stack = [];
  const comp = [];
  for (let i0 = 0; i0 < W * H; i0++) {
    const kind = out[i0];
    if (!kind || seen[i0]) continue;
    comp.length = 0;
    stack.push(i0);
    seen[i0] = 1;
    let paved = false;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const ix = i % W, iz = (i / W) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        const n = nz * W + nx;
        if (tier[n] >= 4) paved = true;
        if (seen[n] || out[n] !== kind) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const min = kind === STREET.FOOTWAY ? MIN_FOOTWAY : MIN_ALLEY;
    if (comp.length < min) { for (const i of comp) out[i] = STREET.NONE; continue; }
    if (kind === STREET.ALLEY && (paved || era >= FOOTWAY_ERA)) for (const i of comp) out[i] = STREET.PAVED_ALLEY;
  }
}
