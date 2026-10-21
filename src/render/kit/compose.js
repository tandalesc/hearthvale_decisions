import * as THREE from 'three';
import { heightAt, riverX } from '../../terrain.js';
import { hashId } from '../shaderlib.js';
import { PALETTE, TRIM_LIGHT, TRIM_WARM, WINDOW, ROOF, DETAIL, styleFor } from './styles.js';
import { fieldKind } from './crops.js';

// Lot composer: turns one building record (contract §3) into 3-12 kit piece
// instances. Silhouette says era, colour says wealth, props say function
// (design-visual §1). Pure function of the record plus an animation state, so
// the same save always draws the same town.

export const PIECES = [
  'body', 'gable', 'thatch', 'mansard', 'hip', 'flat', 'chimney', 'spire', 'dome',
  'sawtooth', 'stack', 'posts', 'scaffold', 'portico', 'awning', 'sails', 'field', 'banner',
  'band', 'piles', 'balcony',
];

const STONE_BASE = new THREE.Color('#8f8a7e');
const TRIM_DARK_SIGN = [new THREE.Color('#2f4a3a'), new THREE.Color('#5a2c24'), new THREE.Color('#2c3a52')];
const TIMBER_BASE = new THREE.Color('#6e5338');

const DEG = Math.PI / 180;
const GRID9 = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0], [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]];
const tmpColor = new THREE.Color();
const grey = new THREE.Color();

/** A pool of reusable piece specs. */
export function createSpecPool() {
  const pool = [];
  let used = 0;
  return {
    reset() { used = 0; },
    next() {
      if (used === pool.length) {
        pool.push({
          piece: '', x: 0, y: 0, z: 0, yaw: 0, sx: 1, sy: 1, sz: 1,
          wall: new THREE.Color(), roof: new THREE.Color(), trim: new THREE.Color(),
          params: [1, 0, 0, 0], style: [3, 0, 0, 0], shape: [0, 0, 0, 0],
        });
      }
      return pool[used++];
    },
    list() { return pool.slice(0, used); },
    count: () => used,
    at: (i) => pool[i],
  };
}

function pick(family, i, seed, out) {
  const f = PALETTE[family] ?? PALETTE.limewash;
  out.copy(f[i % f.length]);
  // +-8% value jitter from the id hash (design-visual §1 rule 2).
  out.multiplyScalar(0.92 + seed * 0.16);
  return out;
}

/** Apply wealth and condition cues to a wall colour. */
function weather(color, family, wealth, condition) {
  const clean = PALETTE[family]?.[0];
  if (clean) color.lerp(clean, wealth * 0.45);
  const l = color.r * 0.3 + color.g * 0.55 + color.b * 0.15;
  grey.setRGB(l, l, l);
  color.lerp(grey, (1 - condition) * 0.3);
  color.multiplyScalar(0.84 + 0.16 * condition);
  return color;
}

/**
 * Compose a lot. `anim` = {grow: 0..1 vertical reveal, settle: scale factor,
 * scaffold: 0..1, demolish: 0..1}; `selected` brightens the lot. Returns the
 * lot summary used by other systems (chimney tops, smoke, height, ridge, and
 * the ground pads to flatten under its walls) and fills `pool` with specs.
 * Heights come from the natural terrain (heightAt), never from padded ground,
 * so a building's own pad never feeds back into its foundation.
 */
export function composeLot(b, pool, anim = null, selected = false) {
  pool.reset();
  const id = b.id | 0;
  const h1 = hashId(id, 1), h2 = hashId(id, 2), h3 = hashId(id, 3), h4 = hashId(id, 4), h5 = hashId(id, 5);
  const era = Math.max(0, Math.min(5, b.styleEra ?? 0));
  const style = styleFor(era);
  const variant = Math.floor(h1 * 3) % 3;
  const rot = ((b.rot ?? 0) % 4 + 4) % 4;
  const lw = rot % 2 ? b.d : b.w;
  const ld = rot % 2 ? b.w : b.d;
  const wealth = b.wealth ?? 0.5;
  const condition = b.condition ?? 1;
  const ageN = Math.min(1, (b.age ?? 0) / 100);
  const built = b.built ?? 1;
  const lit = b.lit === false || b.occupied === false ? 0 : 1;

  // Foundations (sim-world fields, else derived from the natural ground under
  // the footprint): the base top sits at the highest ground, the skirt reaches
  // below the lowest. Piles and quays stand in or by the water.
  let lo = Infinity, hi = -Infinity;
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0], [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]]) {
    const g = heightAt(b.x + dx * b.w, b.z + dz * b.d);
    lo = Math.min(lo, g); hi = Math.max(hi, g);
  }
  const foundation = b.foundation ?? (lo < 0.02 ? 'piles' : 'plinth');
  const wet = foundation === 'piles' || foundation === 'quay';
  const baseTop = b.foundationY ?? (wet ? Math.max(hi, 0.25) : Math.max(hi, 0.05));
  const baseDrop = b.foundationDrop ?? Math.max(0, baseTop - lo);
  const floorY = baseTop + (wet ? 0.3 : 0.15);
  const y0 = floorY - 0.2; // walls start just below the floor; the pad meets them
  const sink = floorY - y0;
  const footY = baseTop - baseDrop - 0.4; // below the lowest ground or the river bed

  // Colours.
  const wallFam = style.walls[variant];
  const [roofFam, roofKind] = style.roofs[variant];
  const details = style.details[variant];
  const wall = weather(pick(wallFam, Math.floor(h2 * 3), h3, new THREE.Color()), wallFam, wealth, condition);
  const roof = pick(roofFam, Math.floor(h4 * 3), h5, new THREE.Color());
  roof.multiplyScalar(0.9 + 0.1 * condition);
  const trim = (wealth > 0.55 ? TRIM_LIGHT : TRIM_WARM).clone().multiplyScalar(0.9 + 0.1 * condition);
  if (b.flags?.heritage) trim.lerp(new THREE.Color('#e8d39a'), 0.4);
  const chimneyCol = pick(style.chimney, Math.floor(h3 * 3), h1, new THREE.Color());
  const chimneyCap = chimneyCol.clone().multiplyScalar(0.72);

  const summary = {
    id, x: b.x, z: b.z, w: b.w, d: b.d, rot, type: b.type, base: lo, top: floorY, era,
    chimneys: [], smoke: b.smoke ?? 0, built, bodyH: 0, ridge: floorY, foundation, pads: [],
  };

  // Local -> world for a lot-local point (front of the lot faces local +z).
  const angle = rot * Math.PI / 2;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const wx = (x, z) => b.x + x * ca + z * sa;
  const wz = (x, z) => b.z - x * sa + z * ca;

  const grow = anim?.grow ?? 1;
  const settle = anim?.settle ?? 1;
  const constructing = built < 1;
  const progress = constructing ? Math.max(0.05, Math.min(1, built / 0.85)) : 1;
  const roofIn = constructing ? Math.max(0, (built - 0.85) / 0.15) : 1;
  const detailsIn = !constructing || built > 0.95;
  let baseCount = 0;

  function add(piece, x, y, z, yaw, sx, sy, sz, opts = {}) {
    const s = pool.next();
    s.piece = piece;
    s.x = wx(x, z); s.z = wz(x, z);
    s.y = y; s.yaw = angle + yaw;
    s.sx = sx * settle; s.sy = sy * grow * settle; s.sz = sz * settle;
    if (s.y > y0) s.y = y0 + (s.y - y0) * grow * settle;
    s.wall.copy(opts.wall ?? wall);
    s.roof.copy(opts.roof ?? roof);
    s.trim.copy(opts.trim ?? trim);
    // params.y carries lit (0/1) plus 2 when the lot is selected.
    s.params[0] = condition; s.params[1] = (opts.lit ?? lit) + (selected ? 2 : 0); s.params[2] = ageN; s.params[3] = opts.seed ?? h1;
    s.style[0] = opts.floorH ?? style.floorH; s.style[1] = opts.window ?? 0; s.style[2] = opts.roofKind ?? roofKind; s.style[3] = opts.details ?? 0;
    s.shape[0] = opts.sink ?? 0; s.shape[1] = opts.overhang ?? style.overhang; s.shape[2] = opts.thickness ?? style.thickness; s.shape[3] = wealth;
    return s;
  }

  // Attachments that stand outside the walls (posts, porticos, bays, poles)
  // read their own ground: the lowest natural ground under their lot-local
  // footprint, never above the lot's pad height (pads blend toward baseTop).
  function groundUnder(x, z, w, d) {
    let g = baseTop;
    for (const [u, v] of GRID9) {
      const px = x + u * w, pz = z + v * d;
      g = Math.min(g, heightAt(wx(px, pz), wz(px, pz)));
    }
    return g;
  }

  /** The highest natural ground under a lot-local footprint. */
  function groundOver(x, z, w, d) {
    let g = -Infinity;
    for (const [u, v] of GRID9) {
      const px = x + u * w, pz = z + v * d;
      g = Math.max(g, heightAt(wx(px, pz), wz(px, pz)));
    }
    return g;
  }

  /** A plinth under an attachment, from below its ground up to `top`. */
  function skirt(x, z, w, d, top, color) {
    const g = groundUnder(x, z, w + 0.36, d + 0.36) - 0.3;
    if (top - g > 0.32) add('band', x, g, z, 0, w, top - g, d, { wall: color });
    return g + 0.3;
  }

  /**
   * Steps from a raised floor at `top` down to the ground, leaving the edge
   * at lot-local (x, z) in direction (dx, dz) (one of the four axes), `w` wide.
   * At most three treads; none when the floor is within a step of the ground.
   */
  function stepsDown(x, z, dx, dz, w, top, color) {
    const T = 0.42; // visible tread depth (the band adds 0.18 m a side)
    const g = groundUnder(x + dx * T * 1.5, z + dz * T * 1.5, dx ? T * 3 : w, dz ? T * 3 : w);
    const n = Math.min(3, Math.floor((top - g) / 0.2) - 1);
    let prev = top;
    for (let i = 1; i <= n; i++) {
      const sx = x + dx * (i - 0.5) * T, sz = z + dz * (i - 0.5) * T;
      const tw = dx ? T - 0.36 : w, td = dz ? T - 0.36 : w;
      // The flight runs down to the lowest ground across its width; each
      // tread still clears the highest ground under it (6 cm, over a pad
      // blend's last lean), so on a cross slope the stair levels off instead
      // of running into the hill. A tread the ground has come up to is left out.
      const h = Math.max(top - (i * (top - g)) / (n + 1), groundOver(sx, sz, tw + 0.36, td + 0.36) + 0.06);
      if (h > prev - 0.1) continue;
      const base = g - 0.3;
      add('band', sx, base, sz, 0, tw, h - base, td, { wall: color });
      prev = h;
    }
  }

  /** Foundation under a block: plinth skirt, timber piles or a stone quay. */
  function base(x, z, bw, bd) {
    // Each further block's plinth sits 2 cm lower, so overlapping plinths
    // (extensions, towers, bays) never share a coplanar top or bottom face.
    const dy = 0.02 * baseCount++;
    if (foundation === 'piles') {
      add('piles', x, footY - dy, z, 0, bw - 0.3, floorY - 0.3 - footY, bd - 0.3, { wall: TIMBER_BASE });
      add('band', x, floorY - 0.32 - dy, z, 0, bw, 0.3, bd, { wall: TIMBER_BASE });
      return;
    }
    const stone = foundation === 'quay' ? STONE_BASE : (era === 0 ? TIMBER_BASE : STONE_BASE);
    add('band', x, footY - dy, z, 0, bw, floorY - footY, bd, { wall: stone });
    // Pad the ground flat under dry foundations (quays and piles stand in water).
    if (foundation === 'plinth' || foundation === 'field') {
      const ww = rot % 2 ? bd : bw, dd = rot % 2 ? bw : bd;
      summary.pads.push({ x: wx(x, z), z: wz(x, z), w: ww + 0.6, d: dd + 0.6, y: baseTop });
    }
  }

  /** Walls of a block. Returns its wall-top height. */
  function body(x, z, bw, bd, storeys, opts = {}) {
    // Later eras vary storey height a little from building to building.
    const F = (opts.floorH ?? style.floorH) * (era >= 3 && !opts.floorH ? 0.94 + 0.12 * h2 : 1);
    const full = sink + storeys * F + (era === 0 ? 0.25 : 0);
    const h = constructing && !opts.noBuild ? sink + (full - sink) * progress : full;
    if (!opts.raised) base(x, z, bw, bd);
    add('body', x, opts.y ?? y0, z, 0, bw, h, bd, {
      window: opts.window ?? style.window, details: opts.details ?? details, sink, floorH: F, ...opts,
    });
    return (opts.y ?? y0) + h;
  }

  /** Roof on a block whose walls end at `top`. Ridge along local x unless alongZ. */
  function roofOn(form, x, z, bw, bd, top, opts = {}) {
    if (roofIn <= 0) return top;
    const ov = opts.overhang ?? style.overhang;
    const alongZ = opts.alongZ ?? false;
    const span = alongZ ? bw : bd; // across the ridge
    const len = alongZ ? bd : bw;
    const yaw = alongZ ? Math.PI / 2 : 0;
    if (form === 'flat') {
      add('flat', x, top - 0.05, z, 0, bw + 0.08, 0.55 * roofIn, bd + 0.08, { roofKind: opts.roofKind ?? (roofKind >= ROOF.FLAT ? roofKind : ROOF.FLAT), ...opts });
      return top + 0.5;
    }
    const pitch = (opts.pitch ?? style.pitch) * DEG;
    const t = Math.tan(pitch);
    const rh = (span / 2 + ov) * t;
    const pieceName = form === 'hip' ? 'hip' : form === 'thatch' ? 'thatch' : form === 'mansard' ? 'mansard' : 'gable';
    add(pieceName, x, top - ov * t, z, yaw, len + 2 * ov, rh * roofIn, span + 2 * ov, { overhang: ov, ...opts });
    return top - ov * t + rh * roofIn;
  }

  function chimney(x, z, top, ridgeTop, size = 0.7) {
    if (!detailsIn) return;
    const h = Math.max(1.0, ridgeTop - top + 0.6);
    add('chimney', x, top - 0.3, z, 0, size, h + 0.3, size * (era >= 3 ? 0.75 : 1), { wall: chimneyCol, trim: chimneyCap, window: 0 });
    summary.chimneys.push([wx(x, z), top + h + 0.1, wz(x, z)]);
  }

  function roofForm() {
    if (era === 5) return 'flat';
    if (era === 4) return h2 < (style.flatChance ?? 0) ? 'flat' : 'hip';
    if (era === 3 && h3 < (style.mansard ?? 0)) return 'mansard';
    return style.roofForm;
  }

  /** A house-like block: body, roof, chimneys, optional extensions. */
  function house(x, z, bw, bd, storeys, opts = {}) {
    const top = body(x, z, bw, bd, storeys, opts);
    const form = opts.form ?? roofForm();
    const alongZ = opts.alongZ ?? (style.gableToStreet && h4 < 0.65 ? true : bd > bw * 1.25);
    const ridge = roofOn(form, x, z, bw, bd, top, { alongZ, ...opts.roofOpts });
    summary.bodyH = Math.max(summary.bodyH, ridge - lo);
    summary.ridge = Math.max(summary.ridge, ridge);
    if (detailsIn && roofIn > 0) lateDetails(x, z, bw, bd, storeys, top, form, opts);
    // About a fifth of plain houses share a neighbour's flue and show none.
    const skip = opts.chimneys === undefined && h5 > 0.8;
    if (b.chimney !== false && opts.chimneys !== 0 && !skip) {
      const n = opts.chimneys ?? (storeys > 3 || bw > 10 ? 2 : 1);
      const along = alongZ ? bd : bw;
      for (let i = 0; i < n; i++) {
        const off = (n === 1 ? (h5 < 0.5 ? -1 : 1) : i ? 1 : -1) * Math.max(0.4, along / 2 - 0.9);
        const cx = alongZ ? x + (h3 - 0.5) * 0.6 : x + off;
        const cz = alongZ ? z + off : z - 0.4 + (h3 - 0.5) * 0.4;
        chimney(cx, cz, top, form === 'flat' ? top + 0.6 : ridge, era >= 3 ? 0.75 : 0.62);
      }
    }
    return { top, ridge };
  }

  /**
   * Character for later eras (terrace, civic, glass): cornices, bays,
   * balconies, water tanks and rooftop terraces. All deterministic per id.
   */
  function lateDetails(x, z, bw, bd, storeys, top, form, opts) {
    if (era < 3 || opts.plain) return;
    const F = opts.floorH ?? style.floorH;
    const front = z + bd / 2;
    // Cornice under flat and low hipped roofs.
    // Kept 2 cm under the wall top and 2 cm inside its usual line, so its top
    // and sides are never coplanar with the walls, eave fascia or sign board.
    if (form === 'flat' || form === 'hip') add('band', x, top - 0.42, z, 0, bw - 0.04, 0.4, bd - 0.04, { wall: trim });
    // Bay windows on terrace houses: a two-storey box on the front, on its
    // own plinth down to the ground in front of the house. Not behind a
    // civic portico (tall windows) or inside a front extension.
    const frontExt = (b.extensions ?? []).some((e) => (e.side ?? 1) === 0);
    if (era === 3 && h4 < 0.45 && storeys >= 2 && bw > 4.5 && opts.window !== WINDOW.SHOP && opts.window !== WINDOW.TALL && !frontExt) {
      const bx = x + (h2 < 0.5 ? -1 : 1) * Math.min(bw / 4, 1.6);
      const bayTop = y0 + sink + F * 2 - 0.25;
      // 3 cm under the floor: never level with a block plinth (0, 2, 4 cm).
      skirt(bx, front + 0.35, 1.9, 0.7, floorY - 0.03, STONE_BASE);
      add('body', bx, y0, front + 0.35, 0, 1.9, bayTop - y0, 0.7, { window: WINDOW.SASH, details: DETAIL.NO_DOOR | DETAIL.STRING, sink, floorH: F });
      add('flat', bx, bayTop - 0.05, front + 0.35, 0, 2.0, 0.3, 0.8, { roofKind: ROOF.FLAT });
    }
    // Balconies on civic and glass blocks, one per upper floor.
    if (era >= 4 && storeys >= 3 && h5 < 0.55) {
      const bwid = Math.min(bw * (era === 5 ? 0.8 : 0.45), 6);
      for (let f = 1; f < Math.min(storeys, 8); f++) {
        add('balcony', x, y0 + sink + f * F - 0.02, front, 0, bwid, 1, era === 5 ? 1.2 : 0.8, { lit: 0, trim: era === 5 ? TRIM_LIGHT : trim });
      }
    }
    // Flat roofs: a timber water tank on legs, or a planted terrace.
    if (form === 'flat' && era >= 4 && h5 > 0.72) {
      const tx = x + (bw / 2 - 1.6) * (h3 < 0.5 ? -1 : 1), tz = z - bd / 4;
      add('posts', tx, top + 0.4, tz, 0, 1.8, 1.4, 1.8, {});
      add('stack', tx, top + 1.8, tz, 0, 2.1, 2.2, 2.1, { wall: TIMBER_BASE, trim: TIMBER_BASE });
    }
  }

  function extensions(x, z, bw, bd) {
    if (!detailsIn) return;
    for (const e of b.extensions ?? []) {
      const ew = Math.min(e.w ?? 3, bw * 0.8), ed = Math.min(e.d ?? 3, bd * 0.8);
      const side = e.side ?? 1;
      let ex = x, ez = z;
      if (side === 1) ex = x + bw / 2 + ew / 2 - 0.1;
      else if (side === 3) ex = x - bw / 2 - ew / 2 + 0.1;
      else if (side === 2) ez = z - bd / 2 - ed / 2 + 0.1;
      else ez = z + bd / 2 + ed / 2 - 0.1;
      const top = body(ex, ez, ew, ed, 1, { window: WINDOW.COTTAGE, floorH: Math.min(style.floorH, 2.6) });
      roofOn(era >= 4 ? 'flat' : 'gable', ex, ez, ew, ed, top, { pitch: Math.min(style.pitch, 32), overhang: 0.2, alongZ: side % 2 === 0 });
    }
  }

  function scaffold(x, z, bw, bd, top) {
    const s = anim?.scaffold ?? (constructing ? 1 : 0);
    if (s <= 0) return;
    // Poles stand on the ground around the plinth, not at floor level.
    const g = Math.min(y0 + sink - 0.1, groundUnder(x, z, bw + 1.4, bd + 1.4) - 0.1);
    add('scaffold', x, g, z, 0, (bw + 1.4) * s, Math.max(1.5, top - g + 1) * s, (bd + 1.4) * s, { roof: wall });
  }

  /**
   * Square centrepieces (sim-world's monument, flags.square) by variant, era
   * and archetype: a market cross, a fountain, a statue or a bandstand; a
   * plain obelisk elsewhere.
   */
  function monument() {
    const stone = pick('stoneHoney', 0, h2, new THREE.Color());
    const grey = pick('stoneGrey', 2, h3, new THREE.Color());
    const g = baseTop;
    const square = !!b.flags?.square;
    const kind = !square ? 'obelisk'
      : b.variant === 'cross' ? 'cross'
      : b.variant === 'fountain' && era < 4 ? 'fountain'
      : era >= 4 && (b.archetype === 'garden' || b.archetype === 'scholar') ? 'bandstand'
      : era >= 4 ? 'statue' : 'fountain';
    // Bottom of a base block of size s: the lowest ground under it on a slope.
    const foot = (s) => Math.min(g - 0.2, groundUnder(0, 0, s, s) - 0.15);
    if (kind === 'fountain') {
      // A square stone step under the basin where the ground falls away.
      skirt(0, 0, 4.04, 4.04, g - 0.1, stone);
      add('stack', 0, g - 0.2, 0, 0, 4.4, 0.85, 4.4, { wall: stone, trim: stone });
      add('flat', 0, g + 0.45, 0, 0, 3.1, 0.12, 3.1, { roof: new THREE.Color('#5f8f98'), roofKind: ROOF.FLAT, trim: stone, lit: 0 });
      add('stack', 0, g + 0.4, 0, 0, 0.5, 2.0, 0.5, { wall: grey, trim: grey });
      add('dome', 0, g + 2.25, 0, 0, 1.4, 0.6, 1.4, { roof: grey, trim: grey });
      summary.bodyH = 3;
    } else if (kind === 'cross') {
      add('band', 0, foot(3), 0, 0, 2.6, g + 0.35 - foot(3), 2.6, { wall: stone });
      add('band', 0, g + 0.35, 0, 0, 1.6, 0.45, 1.6, { wall: stone });
      add('band', 0, g + 0.8, 0, 0, 0.12, 4.0, 0.12, { wall: grey });
      add('band', 0, g + 3.6, 0, 0, 1.1, 0.18, 0.1, { wall: grey });
      summary.bodyH = 5;
    } else if (kind === 'statue') {
      const bronze = new THREE.Color('#58705f');
      add('band', 0, foot(2.6), 0, 0, 2.2, g + 1.7 - foot(2.6), 2.2, { wall: stone });
      add('stack', 0, g + 1.7, 0, 0, 0.9, 1.8, 0.9, { wall: bronze, trim: bronze });
      add('dome', 0, g + 3.4, 0, 0, 0.55, 0.5, 0.55, { roof: bronze, trim: bronze });
      summary.bodyH = 4.5;
    } else if (kind === 'bandstand') {
      add('band', 0, foot(5), 0, 0, 4.6, g + 0.5 - foot(5), 4.6, { wall: stone });
      add('posts', 0, g + 0.5, 0, 0, 3.8, 2.6, 3.8, {});
      add('hip', 0, g + 3.0, 0, 0, 4.8, 1.4, 4.8, { roof: new THREE.Color('#6f8a7c'), roofKind: ROOF.METAL, overhang: 0.2 });
      summary.bodyH = 4.5;
    } else {
      const top = body(0, 0, 2.2, 2.2, 1, { floorH: 1.6, window: WINDOW.NONE, wall: stone, details: DETAIL.PLINTH });
      if (detailsIn) add('spire', 0, top, 0, 0, 1.3, 8, 1.3, { roof: grey });
      summary.bodyH = top - lo + 8;
    }
    summary.ridge = g + summary.bodyH;
  }

  /**
   * A quay: a stone apron at grade (walkable, no raised block), bollards on
   * the water side, crates, and a timber crane from era 3.
   */
  function quay() {
    const stone = era >= 2 ? STONE_BASE : TIMBER_BASE;
    const g = baseTop;
    add('band', 0, g - 0.6, 0, 0, lw - 0.2, 0.75, ld - 0.2, { wall: stone });
    // Which local side faces the river: the lot-local direction of the water.
    const toWater = riverX(b.z) - b.x;
    // World offset (toWater, 0) in lot-local axes (inverse of wx/wz above).
    const lx = toWater * Math.cos(angle);
    const lz = toWater * Math.sin(angle);
    const alongX = Math.abs(lx) >= Math.abs(lz);
    const edge = alongX ? Math.sign(lx) * (lw / 2 - 0.5) : Math.sign(lz) * (ld / 2 - 0.5);
    const span = alongX ? ld : lw;
    if (detailsIn) {
      for (let i = 0; i < 4; i++) {
        const t = -span / 2 + 1 + (i * (span - 2)) / 3;
        const [bx, bz] = alongX ? [edge, t] : [t, edge];
        add('chimney', bx, g + 0.1, bz, 0, 0.35, 0.6, 0.35, { wall: new THREE.Color('#3d3a36'), trim: new THREE.Color('#3d3a36') });
      }
      for (let i = 0; i < 3; i++) {
        const [cx, cz] = alongX ? [-edge * 0.3, -span / 4 + i * 0.95] : [-span / 4 + i * 0.95, -edge * 0.3];
        add('band', cx, g + 0.12, cz, 0, 0.7, 0.62 + 0.2 * (i % 2), 0.7, { wall: TIMBER_BASE.clone().multiplyScalar(1.15) });
      }
      if (era >= 3) {
        const [kx, kz] = alongX ? [edge * 0.6, span / 4] : [span / 4, edge * 0.6];
        add('posts', kx, g + 0.1, kz, 0, 1.2, 6, 1.2, {});
        // The jib reaches out over the water.
        add('band', kx + (alongX ? Math.sign(lx) * 1.8 : 0), g + 5.8, kz + (alongX ? 0 : Math.sign(lz) * 1.8), 0, alongX ? 4 : 0.3, 0.3, alongX ? 0.3 : 4, { wall: TIMBER_BASE });
      }
    }
    summary.bodyH = era >= 3 ? 6.5 : 1.5;
  }

  const storeys = Math.max(1, Math.min(style.maxStoreys + 2, b.storeys ?? 1));
  const fill = style.fill;
  const bw = Math.max(3.4, lw * fill);
  const bd = Math.max(3.4, ld * fill);
  const frontZ = (ld - bd) / 2 * 0.35; // nudge toward the street, garden behind

  switch (b.type) {
    case 'park':
    case 'bridge':
      break;

    case 'farm': {
      // Farmhouse front-left, barn behind, the field fills the rest.
      const hw = Math.min(6, lw * 0.42), hd = Math.min(5.5, ld * 0.32);
      const hx = -lw / 2 + hw / 2 + 0.6, hz = ld / 2 - hd / 2 - 0.6;
      const { top } = house(hx, hz, hw, hd, 1, { chimneys: 1 });
      scaffold(hx, hz, hw, hd, top);
      if (detailsIn) {
        const bwid = Math.min(7, lw * 0.45), bdep = Math.min(5.5, ld * 0.3);
        // The barn stands 0.15 m further back than the farmhouse, so equal
        // depths never put their walls and fascias in one plane.
        const bx = lw / 2 - bwid / 2 - 0.6, bz = ld / 2 - bdep / 2 - 0.75;
        const barnWall = pick('timber', Math.floor(h4 * 3), h2, new THREE.Color());
        const barnRoof = era >= 1 ? pick('slate', 0, h3, new THREE.Color()) : pick('thatch', 1, h3, new THREE.Color());
        const btop = body(bx, bz, bwid, bdep, 1, { wall: barnWall, window: WINDOW.NONE, details: DETAIL.PLANKS, floorH: 3.6 });
        roofOn(era === 0 ? 'thatch' : 'gable', bx, bz, bwid, bdep, btop, { roof: barnRoof, wall: barnWall, roofKind: era === 0 ? ROOF.THATCH : ROOF.SLATE, pitch: 40 });
        // Crops stop one cell (2 m) short of the lot edge: the outer ring is
        // the headland track people walk. The field drapes in the shader.
        const fd = Math.max(2, ld - hd - 2.2 - 2);
        // What it grows follows the farm's kind, era and the season (crops.js);
        // an orchard's trees come from trees.js, on the field's rectangle.
        const fw = Math.max(2, lw - 4), fz = -ld / 2 + 2 + fd / 2;
        add('field', 0, Math.max(lo, 0), fz, 0, fw, 1, fd, { wall: new THREE.Color('#9c8460'), seed: h5, roofKind: fieldKind(b.variant), floorH: era });
        summary.field = { x: wx(0, fz), z: wz(0, fz), w: fw, d: fd, yaw: angle, kind: fieldKind(b.variant) };
      }
      break;
    }

    case 'market': {
      // Open market hall: posts under a broad roof. Stalls come from props.
      const top = y0 + sink + 3.4;
      // No plinth (people walk through): the posts reach the lowest ground.
      const gp = groundUnder(0, 0, bw, bd) - 0.15;
      if (roofIn > 0) add('posts', 0, gp, 0, 0, bw, top + 0.1 - gp, bd, {});
      roofOn(era >= 2 ? 'hip' : era === 0 ? 'thatch' : 'gable', 0, 0, bw, bd, top, { pitch: Math.min(style.pitch, 38) });
      summary.bodyH = top - lo + 3;
      break;
    }

    case 'chapel': {
      // Nave along z with a tower at the front; bigger and taller with tier.
      const tier = b.tier ?? 1;
      const nw = Math.min(lw * 0.6, 5 + tier * 1.2), nd = Math.min(ld * 0.72, 8 + tier * 2.2);
      const nz = -ld / 2 + nd / 2 + 0.8;
      const ntop = body(0, nz, nw, nd, 1, { window: WINDOW.LANCET, floorH: 4.2 + tier * 0.9, details: DETAIL.PLINTH | (era >= 1 ? DETAIL.QUOINS : 0) });
      const nridge = roofOn(era === 0 ? 'thatch' : 'gable', 0, nz, nw, nd, ntop, { alongZ: true, pitch: 50 });
      const ts = Math.min(nw * 0.7, 3 + tier * 0.4);
      const tz = nz + nd / 2 + ts / 2 - 0.2;
      const ttop = body(0, tz, ts, ts, 1, { window: WINDOW.LANCET, floorH: (nridge - y0 - sink) + 2.5 + tier * 1.2, details: DETAIL.PLINTH | DETAIL.QUOINS });
      if (roofIn > 0 && detailsIn) add('spire', 0, ttop, tz, Math.PI / 4 * 0, ts + 0.2, (era === 0 ? 3 : 5 + tier * 2.2) * roofIn, ts + 0.2, {});
      scaffold(0, nz, nw, nd, ntop);
      summary.bodyH = ttop - lo + 5;
      break;
    }

    case 'mill': {
      if (era < 3) {
        // Windmill: tapered tower body, cap and turning sails.
        const ts = Math.min(bw, 4.6);
        const top = body(0, 0, ts, ts, 1, { window: WINDOW.COTTAGE, floorH: 7.5, details: era === 0 ? DETAIL.PLANKS : DETAIL.QUOINS });
        roofOn('hip', 0, 0, ts, ts, top, { pitch: 48, overhang: 0.35 });
        if (detailsIn) add('sails', 0, top - 0.6, ts / 2 + 0.45, 0, 10, 10, 10, { trim: new THREE.Color('#ece3c9'), seed: h2 });
        scaffold(0, 0, ts, ts, top);
        summary.bodyH = top - lo + 5;
      } else {
        const { top } = house(0, frontZ, bw, bd, Math.max(3, storeys), { window: WINDOW.INDUSTRIAL, chimneys: 0, form: 'gable', roofOpts: { pitch: 30 } });
        if (detailsIn) {
          const sh = 16 + storeys * 2;
          add('stack', bw / 2 - 1.2, y0, frontZ - bd / 2 + 1.2, 0, 1.8, sh, 1.8, { wall: pick('brick', 1, h3, new THREE.Color()) });
          summary.chimneys.push([wx(bw / 2 - 1.2, frontZ - bd / 2 + 1.2), y0 + sh, wz(bw / 2 - 1.2, frontZ - bd / 2 + 1.2)]);
        }
        scaffold(0, frontZ, bw, bd, top);
      }
      break;
    }

    case 'factory': {
      const fh = Math.max(2, storeys);
      const top = body(0, 0, bw, bd, fh, { window: WINDOW.INDUSTRIAL, floorH: 3.8, wall: pick('brick', Math.floor(h2 * 3), h3, new THREE.Color()) });
      if (roofIn > 0) add('sawtooth', 0, top, 0, 0, bw, 1.6 * roofIn, bd, { roof: pick('slate', 0, h4, new THREE.Color()) });
      if (detailsIn) {
        const sh = 18 + fh * 2.5;
        add('stack', -bw / 2 + 1.4, y0, -bd / 2 + 1.4, 0, 2, sh, 2, { wall: pick('brick', 0, h1, new THREE.Color()) });
        summary.chimneys.push([wx(-bw / 2 + 1.4, -bd / 2 + 1.4), y0 + sh, wz(-bw / 2 + 1.4, -bd / 2 + 1.4)]);
      }
      scaffold(0, 0, bw, bd, top);
      summary.bodyH = top - lo + 2;
      break;
    }

    case 'quay': {
      quay();
      break;
    }

    case 'warehouse': {
      const low = b.type === 'quay';
      const top = body(0, 0, bw, bd, low ? 1 : Math.max(2, storeys), { window: low ? WINDOW.NONE : WINDOW.INDUSTRIAL, floorH: low ? 1.2 : 3.4, details: DETAIL.PLINTH | (era < 2 ? DETAIL.PLANKS : 0) });
      if (!low) roofOn(era >= 4 ? 'flat' : 'gable', 0, 0, bw, bd, top, { pitch: 28, alongZ: bd > bw });
      scaffold(0, 0, bw, bd, top);
      summary.bodyH = top - lo + 3;
      break;
    }

    case 'watch': {
      const ts = Math.min(bw, 4.4);
      const top = body(0, 0, ts, ts, 1, { floorH: 8 + era, window: WINDOW.COTTAGE, details: DETAIL.QUOINS | DETAIL.PLINTH });
      roofOn(era >= 4 ? 'flat' : 'hip', 0, 0, ts, ts, top, { pitch: 40 });
      body(0, -ts / 2 - bd * 0.2, bw * 0.8, bd * 0.45, 1, { window: WINDOW.COTTAGE });
      summary.bodyH = top - lo + 3;
      break;
    }

    case 'monument': {
      monument();
      break;
    }

    case 'quarry': {
      // A cut stone face: stepped blocks of the seed's stone, a spoil heap,
      // a few dressed blocks and (era 2+) a timber derrick.
      const rock = pick(PALETTE.stoneHoney && h2 < 0.5 ? 'stoneHoney' : 'stoneGrey', 0, h3, new THREE.Color());
      const g = Math.max(lo, 0) - 0.2;
      add('band', -lw * 0.15, g, -ld * 0.2, 0, lw * 0.6, 2.4, ld * 0.35, { wall: rock });
      add('band', lw * 0.2, g - 0.03, -ld * 0.25, 0, lw * 0.35, 1.5, ld * 0.3, { wall: rock.clone().multiplyScalar(0.9) });
      add('spire', lw * 0.25, g, ld * 0.22, Math.PI / 4, lw * 0.4, 1.4, ld * 0.4, { roof: rock.clone().multiplyScalar(0.8) });
      // Staggered by a few centimetres so touching blocks never share a face.
      for (let i = 0; i < 3; i++) add('band', -lw * 0.25 + i * 1.1, g + 0.2 + i * 0.03, ld * 0.3 + i * 0.04, 0, 0.8, 0.6, 0.7, { wall: rock.clone().multiplyScalar(1.05) });
      if (era >= 2 && detailsIn) {
        add('posts', -lw * 0.3, g, 0, 0, 0.8, 5, 0.8, {});
        add('band', -lw * 0.3 + 1.4, g + 4.8, 0, 0, 3.2, 0.25, 0.25, { wall: TIMBER_BASE });
      }
      summary.bodyH = 5;
      break;
    }

    case 'moot':
    case 'school':
    case 'infirmary':
    case 'library':
    case 'theatre':
    case 'exchange':
    case 'union-hall':
    case 'bathhouse': {
      const civic = era >= 3 || ['exchange', 'theatre', 'library'].includes(b.type);
      const st = Math.max(2, Math.min(storeys, 4));
      const F = civic ? style.floorH + 0.6 : style.floorH;
      const z0 = frontZ - (civic ? 1.2 : 0);
      const bd2 = civic ? bd - 2.4 : bd;
      const { top, ridge } = house(0, z0, bw, bd2, st, {
        window: civic ? WINDOW.TALL : WINDOW.SASH, floorH: F, chimneys: civic ? 0 : 2,
        details: details | DETAIL.STRING | DETAIL.PLINTH, form: civic && era >= 4 ? 'flat' : 'hip',
        roofOpts: { pitch: Math.min(style.pitch, 30) }, alongZ: false,
      });
      if (detailsIn && civic) {
        const pw = Math.min(bw * 0.62, 10);
        const ph = Math.min(F * 1.7, top - y0 - sink);
        // The portico floor sits on a stone podium down to the ground in
        // front, with steps down from its front edge.
        const pz = z0 + bd2 / 2 + 1.25;
        skirt(0, pz + 0.05, pw - 0.16, 2.6 - 0.36, y0 + sink - 0.1, STONE_BASE);
        stepsDown(0, pz + 1.35, 0, 1, pw * 0.7 - 0.36, y0 + sink - 0.1, STONE_BASE);
        add('portico', 0, y0 + sink - 0.1, pz, 0, pw, ph, 2.5, { trim: TRIM_LIGHT });
        add('gable', 0, y0 + sink + ph - 0.25, z0 + bd2 / 2 + 1.25, Math.PI / 2, 3.1, 1.6, pw + 0.4, { roofKind: ROOF.SLATE, overhang: 0.15, wall: TRIM_LIGHT });
      }
      // A round corner turret with a spire on some later civic buildings.
      if (detailsIn && civic && era >= 3 && h3 < 0.5 && bw > 7) {
        const cx = (h4 < 0.5 ? -1 : 1) * (bw / 2 - 0.6), cz = z0 + bd2 / 2 - 0.6;
        const th = top - y0 + 2.6;
        // It stands 0.8 m proud of the corner: its foot reaches that ground.
        const ty = Math.min(y0, groundUnder(cx, cz, 2.8, 2.8) - 0.1);
        add('stack', cx, ty, cz, 0, 2.8, th + y0 - ty, 2.8, { wall, trim });
        add('spire', cx, y0 + th - 0.1, cz, Math.PI / 4, 2.2, 2.6, 2.2, {});
      }
      if (detailsIn && (b.type === 'exchange' || b.type === 'bathhouse' || (b.type === 'library' && h2 < 0.5))) {
        const ds = Math.min(bw, bd2) * 0.45;
        add('dome', 0, top - 0.1, z0, 0, ds, ds * 0.75, ds, { roof: era >= 4 ? new THREE.Color('#7f9c94') : roof, roofKind: ROOF.METAL });
      } else if (detailsIn && (b.type === 'moot' || b.type === 'school')) {
        // Clock or bell tower on the ridge.
        const ts = b.type === 'moot' ? 2.6 : 1.6;
        // Rises from inside the hall, so it needs no plinth of its own.
        const ttop = body(0, z0, ts, ts, 1, { floorH: (ridge - y0 - sink) + (b.type === 'moot' ? 3.2 : 1.4), window: WINDOW.NONE, noBuild: true, raised: true, details: DETAIL.QUOINS });
        add('spire', 0, ttop, z0, 0, ts + 0.3, b.type === 'moot' ? 3.6 : 2.2, ts + 0.3, {});
        summary.bodyH = Math.max(summary.bodyH, ttop - lo + 3);
      }
      scaffold(0, z0, bw, bd2, top);
      break;
    }

    default: {
      // Homes, shops, inns and workshops share the house composer.
      const isShop = b.type === 'shop';
      const isInn = b.type === 'inn';
      const isWork = b.type === 'workshop';
      const st = isInn ? Math.max(2, storeys) : storeys;
      let window = style.window;
      // Terraces and town blocks often trade from the ground floor.
      const shopfront = isShop || (era >= 3 && b.type === 'home' && st >= 3 && h3 < 0.3);
      if (shopfront && era >= 1) window = WINDOW.SHOP;
      if (isWork && era >= 3) window = WINDOW.INDUSTRIAL;
      const { top } = house(0, frontZ, bw, bd, st, { window, chimneys: isInn ? 2 : undefined });
      extensions(0, frontZ, bw, bd);
      if (detailsIn && shopfront && (era >= 1 || wealth > 0.35) && era < 5) {
        add('awning', 0, y0 + sink + 1.95, frontZ + bd / 2 + 0.02, 0, bw * 0.84, 0.95, 1.3, { window: Math.floor(h4 * 7) });
        // Painted sign board above the awning.
        if (era >= 2) add('band', 0, y0 + sink + 2.95, frontZ + bd / 2 - 0.1, 0, bw * 0.6, 0.45, 0.12, { wall: TRIM_DARK_SIGN[Math.floor(h5 * 3)] });
      }
      if (detailsIn && isInn) {
        // Hanging sign: its pole against the front wall, the board standing
        // out from it (piece +x turned to face the street).
        add('banner', bw / 2 - 0.4, y0 + sink + 2.0, frontZ + bd / 2 + 0.05, -Math.PI / 2, 1, 1.2, 1, { window: 3, details: 1 });
      }
      if (detailsIn && isWork && era < 3) {
        // Open-sided lean-to workshop with a timber frame, on a side free of
        // extensions; its posts reach the lowest ground beside the house
        // (the roof stays at eave height).
        const taken = new Set((b.extensions ?? []).map((e) => e.side ?? 1));
        const lean = !taken.has(3) ? -1 : !taken.has(1) ? 1 : 0;
        if (lean) {
          const sx = lean * (bw / 2 + 1.4);
          const gp = Math.min(y0 + sink - 0.1, groundUnder(sx, frontZ, 2.6, bd * 0.7) - 0.15);
          add('posts', sx, gp, frontZ, 0, 2.6, y0 + sink + 2.3 - gp, bd * 0.7, {});
          roofOn('gable', sx, frontZ, 2.6, bd * 0.7, y0 + sink + 2.3, { pitch: 25, alongZ: true, overhang: 0.2 });
        }
      }
      scaffold(0, frontZ, bw, bd, top);
    }
  }

  // Event banners hang from the front of any building.
  if (b.banner && detailsIn && b.type !== 'park') {
    const accent = b.banner === 'protest' ? 0 : b.banner === 'festival' ? 3 : 5;
    // The pole stands on the ground at the lot front, not at floor level.
    const gb = groundUnder(-lw * 0.3, ld / 2 + 0.4, 0.1, 0.1) - 0.1;
    add('banner', -lw * 0.3, gb, ld / 2 + 0.4, 0, 1.4, 3.5, 1, { window: accent, details: 1 });
  }

  summary.top = y0 + sink + (summary.bodyH || 4);
  return summary;
}
