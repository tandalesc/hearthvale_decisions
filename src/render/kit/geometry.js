import * as THREE from 'three';

// Kit geometry builder. Every kit piece is authored in a unit space
// (x, z in -0.5..0.5, y in 0..1) that the instance matrix scales to the lot,
// plus two kinds of offsets that stay in metres whatever the scale:
//   aMetric  constant metres (pole thickness, cap overhangs)
//   aShape   multipliers of per-instance shape values: xz * overhang, y * thickness
// The vertex shader adds (aMetric + aShape * shape) / scale before the instance
// transform, so eaves keep their overhang on a 5 m cottage and a 20 m hall.
//
// Geometry is non-indexed with one normal per face (flat shading, fixes the
// old averaged-normal shading seams). aPart picks the colour family:
export const PART = {
  WALL: 0, ROOF: 1, TRIM: 2, TIMBER: 3, SOFFIT: 4, ACCENT: 5, GLASS: 6, CROP: 7, STONE: 8,
};

// Typical instance scale used only to orient faces that are degenerate in
// unit space (metric-only poles and caps). Those faces are axis aligned, so
// the result is exact for any real scale.
const S0 = new THREE.Vector3(8, 6, 8);

export class KitBuilder {
  constructor() {
    this.pos = [];
    this.metric = [];
    this.shape = [];
    this.part = [];
    this.ao = [];
    this.normals = [];
  }

  /** v = [x, y, z, mx?, my?, mz?, sx?, sy?, sz?] */
  tri(a, b, c, part, ao = 1) {
    const vs = [a, b, c];
    const n = faceNormal(a, b, c);
    for (let i = 0; i < 3; i++) {
      const v = vs[i];
      this.pos.push(v[0], v[1], v[2]);
      this.metric.push(v[3] ?? 0, v[4] ?? 0, v[5] ?? 0);
      this.shape.push(v[6] ?? 0, v[7] ?? 0, v[8] ?? 0);
      this.part.push(part);
      this.ao.push(Array.isArray(ao) ? ao[i] : ao);
      this.normals.push(n.x, n.y, n.z);
    }
  }

  /** Quad a-b-c-d, counter-clockwise seen from the front. */
  quad(a, b, c, d, part, ao = 1) {
    const aoA = Array.isArray(ao) ? ao : [ao, ao, ao, ao];
    this.tri(a, b, c, part, [aoA[0], aoA[1], aoA[2]]);
    this.tri(a, c, d, part, [aoA[0], aoA[2], aoA[3]]);
  }

  /**
   * Axis-aligned box. `lo`/`hi` are unit corners; `mlo`/`mhi` metric offsets
   * of those corners. Faces: px nx py ny pz nz (set false to skip).
   */
  box(lo, hi, part, { mlo = [0, 0, 0], mhi = [0, 0, 0], faces = {}, ao = 1, bottomAo = ao } = {}) {
    const v = (ix, iy, iz) => [
      ix ? hi[0] : lo[0], iy ? hi[1] : lo[1], iz ? hi[2] : lo[2],
      ix ? mhi[0] : mlo[0], iy ? mhi[1] : mlo[1], iz ? mhi[2] : mlo[2],
    ];
    const f = { px: true, nx: true, py: true, ny: false, pz: true, nz: true, ...faces };
    const side = [bottomAo, bottomAo, ao, ao];
    if (f.pz) this.quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1), part, side);
    if (f.nz) this.quad(v(1, 0, 0), v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), part, side);
    if (f.px) this.quad(v(1, 0, 1), v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), part, side);
    if (f.nx) this.quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0), part, side);
    if (f.py) this.quad(v(0, 1, 1), v(1, 1, 1), v(1, 1, 0), v(0, 1, 0), part, ao);
    if (f.ny) this.quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1), part, bottomAo);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('aMetric', new THREE.Float32BufferAttribute(this.metric, 3));
    g.setAttribute('aShape', new THREE.Float32BufferAttribute(this.shape, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.ao, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
function faceNormal(a, b, c) {
  _a.set(a[0], a[1], a[2]);
  _b.set(b[0], b[1], b[2]).sub(_a);
  _c.set(c[0], c[1], c[2]).sub(_a);
  const n = new THREE.Vector3().crossVectors(_b, _c);
  if (n.lengthSq() > 1e-10) return n.normalize();
  // Degenerate in unit space: evaluate at a typical scale with metric offsets,
  // then map back to unit space (normals transform by the inverse transpose).
  // Typical shape values: 0.4 m overhang, 0.25 m slab thickness.
  const ev = (v, out) => out.set(
    v[0] * S0.x + (v[3] ?? 0) + (v[6] ?? 0) * 0.4,
    v[1] * S0.y + (v[4] ?? 0) + (v[7] ?? 0) * 0.25,
    v[2] * S0.z + (v[5] ?? 0) + (v[8] ?? 0) * 0.4,
  );
  ev(a, _a);
  ev(b, _b).sub(_a);
  ev(c, _c).sub(_a);
  n.crossVectors(_b, _c).normalize();
  return n.multiply(S0).normalize();
}

// ---------------------------------------------------------------------------
// Pieces

/** Walls: a unit box without a bottom (it is sunk into the ground). */
export function bodyPiece() {
  const k = new KitBuilder();
  k.box([-0.5, 0, -0.5], [0.5, 1, 0.5], PART.WALL, { faces: { py: true }, ao: 1, bottomAo: 0.82 });
  return k.build();
}

/**
 * Pitched roof with ridge along x, from a half-profile [[z, y], ...] that runs
 * from the eave (0.5, 0) to the ridge (0, 1). Builds the top surface, a
 * slab underside `thickness` below, fascia and verge edges, and wall-coloured
 * gable ends inset by the overhang so they sit flush with the walls.
 */
export function pitchedRoof(profile, { gableAo = 1 } = {}) {
  const k = new KitBuilder();
  // Full cross-section from front eave over the ridge to the back eave.
  const prof = [...profile.map(([z, y]) => [z, y]), ...profile.slice(0, -1).reverse().map(([z, y]) => [-z, y])];
  const T = (x, z, y, down = 0) => [x, y, z, 0, 0, 0, 0, -down, 0];
  for (let i = 0; i < prof.length - 1; i++) {
    const [z0, y0] = prof[i];
    const [z1, y1] = prof[i + 1];
    // Top surface: winding chosen so the normal points up/out.
    k.quad(T(-0.5, z0, y0), T(0.5, z0, y0), T(0.5, z1, y1), T(-0.5, z1, y1), PART.ROOF, 1);
    // Underside (soffit), facing down.
    k.quad(T(-0.5, z1, y1, 1), T(0.5, z1, y1, 1), T(0.5, z0, y0, 1), T(-0.5, z0, y0, 1), PART.SOFFIT, 0.7);
    // Verge edges at both ends.
    k.quad(T(0.5, z0, y0, 1), T(0.5, z1, y1, 1), T(0.5, z1, y1), T(0.5, z0, y0), PART.TRIM, 0.9);
    k.quad(T(-0.5, z1, y1, 1), T(-0.5, z0, y0, 1), T(-0.5, z0, y0), T(-0.5, z1, y1), PART.TRIM, 0.9);
  }
  // Fascia along both eaves.
  const [ez] = prof[0];
  k.quad(T(-0.5, ez, 0, 1), T(0.5, ez, 0, 1), T(0.5, ez, 0), T(-0.5, ez, 0), PART.TRIM, 0.85);
  k.quad(T(0.5, -ez, 0, 1), T(-0.5, -ez, 0, 1), T(-0.5, -ez, 0), T(0.5, -ez, 0), PART.TRIM, 0.85);
  // Gable ends: a fan under the profile, inset by the overhang in x and z.
  // aShape.x/z = -sign means "move inward by one overhang". The fan's foot
  // runs below the wall top (the eave line is lower), so it is set a further
  // GABLE_INSET metres inside the wall face: coplanar with the wall it
  // z-fights up close; recessed, the wall hides it and the verge covers the step.
  for (const sx of [1, -1]) {
    const g = (z, y) => [0.5 * sx, y, z, -GABLE_INSET * sx, 0, 0, -sx, 0, z === 0 ? 0 : -Math.sign(z)];
    for (let i = 0; i < prof.length - 1; i++) {
      const [z0, y0] = prof[i];
      const [z1, y1] = prof[i + 1];
      // Fan from the eave line (y = 0) up to the profile.
      const a = g(z0, 0), b = g(z1, 0), c = g(z1, y1), d = g(z0, y0);
      if (sx > 0) k.quad(a, b, c, d, PART.WALL, gableAo); else k.quad(b, a, d, c, PART.WALL, gableAo);
    }
  }
  return k.build();
}

/** How far gable ends sit behind the wall face (metres; see pitchedRoof). */
export const GABLE_INSET = 0.05;

export const PROFILES = {
  gable: [[0.5, 0], [0, 1]],
  // Thatch: steep lower slope rolling into a rounded ridge.
  thatch: [[0.5, 0], [0.3, 0.6], [0.14, 0.88], [0, 1]],
  // Mansard: steep lower slope, shallow upper.
  mansard: [[0.5, 0], [0.4, 0.72], [0, 1]],
};

/** Hip roof: four slopes to a short ridge, slab underside and fascia. */
export function hipRoof() {
  const k = new KitBuilder();
  const r = 0.22; // ridge half-length in unit x
  const T = (x, y, z, down = 0) => [x, y, z, 0, 0, 0, 0, -down, 0];
  const e = [T(-0.5, 0, 0.5), T(0.5, 0, 0.5), T(0.5, 0, -0.5), T(-0.5, 0, -0.5)];
  const ra = T(-r, 1, 0), rb = T(r, 1, 0);
  k.quad(e[0], e[1], rb, ra, PART.ROOF);
  k.quad(e[2], e[3], ra, rb, PART.ROOF);
  k.tri(e[1], e[2], rb, PART.ROOF);
  k.tri(e[3], e[0], ra, PART.ROOF);
  const d = [T(-0.5, 0, 0.5, 1), T(0.5, 0, 0.5, 1), T(0.5, 0, -0.5, 1), T(-0.5, 0, -0.5, 1)];
  k.quad(d[3], d[2], d[1], d[0], PART.SOFFIT, 0.7);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    k.quad(d[i], d[j], e[j], e[i], PART.TRIM, 0.85);
  }
  return k.build();
}

/** Flat roof slab with a coping band; the shader draws the parapet inset. */
export function flatRoof() {
  const k = new KitBuilder();
  k.box([-0.5, 0, -0.5], [0.5, 1, 0.5], PART.TRIM, { faces: { py: false }, ao: 1 });
  k.quad([-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5], PART.ROOF);
  return k.build();
}

/** Chimney stack with a projecting cap. */
export function chimneyPiece() {
  const k = new KitBuilder();
  k.box([-0.5, 0, -0.5], [0.5, 1, 0.5], PART.STONE, { faces: { py: false } });
  const c = 0.09;
  k.box([-0.5, 1, -0.5], [0.5, 1, 0.5], PART.TRIM, { mlo: [-c, -0.14, -c], mhi: [c, 0.02, c], faces: { ny: true } });
  // Dark flue opening on top.
  k.quad([-0.5, 1, 0.5, 0.06, 0.021, -0.06], [0.5, 1, 0.5, -0.06, 0.021, -0.06], [0.5, 1, -0.5, -0.06, 0.021, 0.06], [-0.5, 1, -0.5, 0.06, 0.021, 0.06], PART.SOFFIT, 0.2);
  return k.build();
}

/** Square spire (pyramid) with a small eave lip. */
export function spirePiece() {
  const k = new KitBuilder();
  const apex = [0, 1, 0];
  const c = [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5]];
  for (let i = 0; i < 4; i++) k.tri(c[i], c[(i + 1) % 4], apex, PART.ROOF);
  k.box([-0.5, 0, -0.5], [0.5, 0, 0.5], PART.TRIM, { mlo: [-0.12, -0.18, -0.12], mhi: [0.12, 0, 0.12], faces: { py: false, ny: true } });
  return k.build();
}

/** Low-poly dome: 8 segments, 4 rings, on a short drum. */
export function domePiece() {
  const k = new KitBuilder();
  const seg = 8, rings = 4;
  const p = (i, j) => {
    const a = (i / seg) * Math.PI * 2;
    const t = (j / rings) * (Math.PI / 2);
    return [Math.cos(a) * Math.cos(t) * 0.5, 0.18 + Math.sin(t) * 0.82, Math.sin(a) * Math.cos(t) * 0.5];
  };
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    // Drum.
    k.quad([Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5], [Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5], [Math.cos(a0) * 0.5, 0.18, Math.sin(a0) * 0.5], [Math.cos(a1) * 0.5, 0.18, Math.sin(a1) * 0.5], PART.TRIM);
    for (let j = 0; j < rings; j++) {
      if (j === rings - 1) k.tri(p(i + 1, j), p(i, j), p(i, j + 1), PART.ROOF);
      else k.quad(p(i + 1, j), p(i, j), p(i, j + 1), p(i + 1, j + 1), PART.ROOF);
    }
  }
  return k.build();
}

/** Factory sawtooth roof: four teeth with glazed north lights. */
export function sawtoothPiece() {
  const k = new KitBuilder();
  const n = 4;
  for (let i = 0; i < n; i++) {
    const z0 = -0.5 + i / n, z1 = -0.5 + (i + 1) / n;
    k.quad([-0.5, 0, z1], [0.5, 0, z1], [0.5, 1, z0], [-0.5, 1, z0], PART.ROOF);
    k.quad([0.5, 0, z0], [-0.5, 0, z0], [-0.5, 1, z0], [0.5, 1, z0], PART.GLASS, 0.9);
    k.tri([0.5, 0, z0], [0.5, 1, z0], [0.5, 0, z1], PART.WALL);
    k.tri([-0.5, 0, z1], [-0.5, 1, z0], [-0.5, 0, z0], PART.WALL);
  }
  return k.build();
}

/** Tall tapered stack (mill and factory chimneys), six-sided. */
export function stackPiece() {
  const k = new KitBuilder();
  const seg = 6;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const b = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
    k.quad(b(a1, 0.5, 0), b(a0, 0.5, 0), b(a0, 0.34, 0.94), b(a1, 0.34, 0.94), PART.STONE);
    k.quad(b(a1, 0.34, 0.94), b(a0, 0.34, 0.94), b(a0, 0.4, 1), b(a1, 0.4, 1), PART.TRIM);
    k.tri(b(a1, 0.4, 1), b(a0, 0.4, 1), [0, 1, 0], PART.SOFFIT, 0.2);
  }
  return k.build();
}

/** Open frame: corner and mid posts (market halls, porches, scaffolds). */
export function postsPiece({ planks = false } = {}) {
  const k = new KitBuilder();
  const t = 0.11;
  const spots = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]];
  for (const [x, z] of spots) {
    k.box([x, 0, z], [x, 1, z], PART.TIMBER, { mlo: [-t, 0, -t], mhi: [t, planks ? 0.6 : 0, t], faces: { py: true } });
  }
  if (planks) {
    // Walkway planks every third of the height, around the outside.
    for (const y of [0.34, 0.67, 1]) {
      const w = 0.45;
      k.box([-0.5, y, 0.5], [0.5, y, 0.5], PART.TIMBER, { mlo: [-w, -0.06, 0], mhi: [w, 0.04, w], faces: { ny: true } });
      k.box([-0.5, y, -0.5], [0.5, y, -0.5], PART.TIMBER, { mlo: [-w, -0.06, -w], mhi: [w, 0.04, 0], faces: { ny: true } });
      k.box([0.5, y, -0.5], [0.5, y, 0.5], PART.TIMBER, { mlo: [0, -0.06, 0], mhi: [w, 0.04, 0], faces: { ny: true } });
      k.box([-0.5, y, -0.5], [-0.5, y, 0.5], PART.TIMBER, { mlo: [-w, -0.06, 0], mhi: [0, 0.04, 0], faces: { ny: true } });
      // Diagonal-ish rails read as bracing from the game camera.
      k.box([-0.5, y - 0.17, 0.5], [0.5, y - 0.17, 0.5], PART.TRIM, { mlo: [0, -0.05, 0.02], mhi: [0, 0.05, 0.08] });
    }
  }
  return k.build();
}

/** Columns with base and entablature (porticoes). */
export function porticoPiece() {
  const k = new KitBuilder();
  const n = 6, r = 0.2;
  k.box([-0.5, 0, -0.5], [0.5, 0.08, 0.5], PART.TRIM, { faces: { py: true } });
  for (let i = 0; i < n; i++) {
    const x = -0.42 + (i / (n - 1)) * 0.84;
    k.box([x, 0.08, 0.2], [x, 0.86, 0.2], PART.TRIM, { mlo: [-r, 0, -r], mhi: [r, 0, r], faces: { py: false } });
  }
  k.box([-0.5, 0.86, -0.5], [0.5, 1, 0.5], PART.TRIM, { faces: { ny: true } });
  return k.build();
}

/** Shop awning: sloping canvas with a short valance; striped in the shader. */
export function awningPiece() {
  const k = new KitBuilder();
  k.quad([-0.5, 0.35, 1], [0.5, 0.35, 1], [0.5, 1, 0], [-0.5, 1, 0], PART.ACCENT);
  k.quad([0.5, 0.35, 1], [-0.5, 0.35, 1], [-0.5, 0.35, 1, 0, -0.22, 0], [0.5, 0.35, 1, 0, -0.22, 0], PART.ACCENT);
  k.quad([-0.5, 1, 0], [0.5, 1, 0], [0.5, 0.35, 1], [-0.5, 0.35, 1], PART.SOFFIT, 0.7);
  return k.build();
}

/** Windmill sails: four lattice blades around a hub (rotated in the shader). */
export function sailsPiece() {
  const k = new KitBuilder();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const P = (r, w, z) => [ca * r - sa * w, sa * r + ca * w, z];
    // Stock (spar) and sail cloth.
    k.quad(P(0, -0.025, 0.02), P(0.5, -0.025, 0.02), P(0.5, 0.025, 0.02), P(0, 0.025, 0.02), PART.TIMBER);
    k.quad(P(0.12, 0.03, 0.03), P(0.48, 0.03, 0.03), P(0.48, 0.13, 0.03), P(0.12, 0.13, 0.03), PART.TRIM);
    k.quad(P(0.48, 0.03, 0.03), P(0.12, 0.03, 0.03), P(0.12, 0.13, 0.03), P(0.48, 0.13, 0.03), PART.TRIM);
  }
  return k.build();
}

/**
 * Crop field: ridged rows along x on a soil bed, both subdivided so the
 * shader can drape them on the ground (y comes from the ground texture).
 */
export function fieldPiece() {
  const k = new KitBuilder();
  const rows = 9;
  const seg = 8;
  // Soil bed: an 8x8 grid.
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const x0 = -0.5 + i / seg, x1 = -0.5 + (i + 1) / seg;
      const z0 = -0.5 + j / seg, z1 = -0.5 + (j + 1) / seg;
      k.quad([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0], PART.SOFFIT, 0.9);
    }
  }
  for (let r = 0; r < rows; r++) {
    const z = -0.5 + (r + 0.5) / rows;
    const h = 0.42, w = 0.36;
    for (let i = 0; i < seg; i++) {
      const xa = -0.47 + (0.94 * i) / seg, xb = -0.47 + (0.94 * (i + 1)) / seg;
      const L = [xa, 0, z, 0, 0, -w], R = [xb, 0, z, 0, 0, -w];
      const L2 = [xa, 0, z, 0, 0, w], R2 = [xb, 0, z, 0, 0, w];
      const TL = [xa, 0, z, 0, h, 0], TR = [xb, 0, z, 0, h, 0];
      k.quad(L2, R2, TR, TL, PART.CROP);
      k.quad(R, L, TL, TR, PART.CROP);
    }
  }
  return k.build();
}

/** Banner on a pole (protest, festival, plague); cloth is a thin box. */
export function bannerPiece() {
  const k = new KitBuilder();
  k.box([0, 0, 0], [0, 1, 0], PART.TIMBER, { mlo: [-0.05, 0, -0.05], mhi: [0.05, 0, 0.05] });
  k.box([0, 0.62, 0], [0.5, 0.98, 0], PART.ACCENT, { mlo: [0, 0, -0.03], mhi: [0, 0, 0.03], faces: { ny: true } });
  return k.build();
}

/** Low far-LOD block: walls plus a roof-coloured top in one 10-triangle box. */
export function blockPiece() {
  const k = new KitBuilder();
  k.box([-0.5, 0, -0.5], [0.5, 1, 0.5], PART.WALL, { faces: { py: false } });
  k.quad([-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5], PART.ROOF);
  return k.build();
}

/**
 * A box that projects 0.18 m beyond its footprint on every side: plinth
 * skirts under walls, cornices at the wall top, sign boards. Coloured by the
 * instance's wall colour.
 */
export function bandPiece() {
  const k = new KitBuilder();
  const p = 0.18;
  k.box([-0.5, 0, -0.5], [0.5, 1, 0.5], PART.STONE, { mlo: [-p, 0, -p], mhi: [p, 0, p], faces: { py: true, ny: true } });
  return k.build();
}

/** Timber piles on a 3x3 grid with two rings of braces (waterfront buildings). */
export function pilesPiece() {
  const k = new KitBuilder();
  const t = 0.13;
  for (const x of [-0.5, 0, 0.5]) {
    for (const z of [-0.5, 0, 0.5]) {
      k.box([x, 0, z], [x, 1, z], PART.TIMBER, { mlo: [-t, 0, -t], mhi: [t, 0, t] });
    }
  }
  const b = 0.06;
  for (const y of [0.4, 0.85]) {
    for (const z of [-0.5, 0.5]) k.box([-0.5, y, z], [0.5, y, z], PART.TIMBER, { mlo: [0, -b, -b], mhi: [0, b, b], faces: { ny: true } });
    for (const x of [-0.5, 0.5]) k.box([x, y, -0.5], [x, y, 0.5], PART.TIMBER, { mlo: [-b, -b, 0], mhi: [b, b, 0], faces: { ny: true } });
  }
  return k.build();
}

/**
 * Balcony: a slab projecting along +z from the wall (z 0 at the wall, 1 at
 * the edge) with a glazed or iron rail. Scale x = width, y = 1 (metres),
 * z = depth.
 */
export function balconyPiece() {
  const k = new KitBuilder();
  k.box([-0.5, 0, 0], [0.5, 0.12, 1], PART.TRIM, { faces: { ny: true } });
  k.box([-0.5, 0.12, 1], [0.5, 1.0, 1], PART.GLASS, { mlo: [0, 0, -0.05], mhi: [0, 0, 0], faces: { ny: false } });
  k.box([-0.5, 1.0, 1], [0.5, 1.0, 1], PART.TRIM, { mlo: [0, 0, -0.08], mhi: [0, 0.06, 0.02] });
  return k.build();
}
