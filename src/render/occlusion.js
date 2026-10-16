import * as THREE from 'three';

// Ambient occlusion shared by every tier (design-visual §3.3, "sitting on the
// table").
//
//  - Baked ground occlusion (all tiers): building footprints and their
//    heights, plus tree clumps, are rasterised into a small field over the
//    built-up area and blurred at two scales. Channel R is the contact term
//    (ground darkens toward a wall, more for a taller wall), channel G the
//    sky term (ground inside a dense block or a narrow alley sees less sky).
//    The terrain and the coloured ground decals multiply it in. Rebuilt only
//    when lots change; per frame it costs one bilinear fetch per ground pixel.
//  - Screen-space AO (high tier, ssao.js) darkens everything else: under
//    eaves, bridges, trees, between roofs. With SSAO on, it already covers the
//    wall-ground contact, so the baked field keeps only part of its sky term
//    and the two never double-darken.
//
// Both fade with the day grade (aoDayFactor): occlusion is a soft-light
// effect, so at night and under heavy rain cloud it eases off instead of
// leaving a grey film over the town.

const MARGIN = 10;      // metres of field around the outermost building
const MAX_DIM = 1024;    // texels per side at most (the step grows past this)
const NEAR_R = 1.6;     // contact blur radius (m)
const FAR_R = 5.5;      // sky-term blur radius (m)

/**
 * Day-grade fade for every AO term, 0..1: full in daylight, about a third at
 * night, about half under heavy rain, less still for both.
 */
export function aoDayFactor(grade) {
  const night = Math.min(1, Math.max(0, grade?.night ?? 0));
  const wet = Math.min(1, Math.max(0, grade?.wet ?? 0));
  return (1 - 0.68 * night) * (1 - 0.45 * wet);
}

/**
 * Weights of the baked field's two channels for a quality tier:
 * [contact, sky]. On 'ssao' the screen-space pass owns the contact term.
 */
export function bakedWeights(q) {
  if (q?.ao === 'baked') return [1, 1];
  if (q?.ao === 'ssao') return [0, 0.55];
  return [0, 0];
}

/** Running-sum box blur of `src` into `dst` along rows (w x h), radius r texels. */
function boxRows(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let j = 0; j < h; j++) {
    const row = j * w;
    let sum = 0;
    for (let i = 0; i <= Math.min(r, w - 1); i++) sum += src[row + i];
    for (let i = 0; i < w; i++) {
      dst[row + i] = sum * inv;
      const add = i + r + 1, sub = i - r;
      if (add < w) sum += src[row + add];
      if (sub >= 0) sum -= src[row + sub];
    }
  }
}

/** Same along columns. */
function boxCols(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let i = 0; i < w; i++) {
    let sum = 0;
    for (let j = 0; j <= Math.min(r, h - 1); j++) sum += src[j * w + i];
    for (let j = 0; j < h; j++) {
      dst[j * w + i] = sum * inv;
      const add = j + r + 1, sub = j - r;
      if (add < h) sum += src[add * w + i];
      if (sub >= 0) sum -= src[sub * w + i];
    }
  }
}

/** Two box passes per axis (a tent, close to a Gaussian), in place via `tmp`. */
function blur(a, tmp, w, h, r) {
  if (r < 1) return;
  boxRows(a, tmp, w, h, r); boxCols(tmp, a, w, h, r);
  boxRows(a, tmp, w, h, r); boxCols(tmp, a, w, h, r);
}

/**
 * Bake the ground occlusion field.
 *   blocks: [{x, z, hw, hd, h}]  axis-aligned building bodies (centre, half
 *           extents, height above ground in metres)
 *   trees:  [{x, z, r}]          crown centres and radii (optional)
 * Returns null without blocks, else {data: Uint8Array (RG), w, h, x0, z0, step}
 * where texel (i, j) is centred on (x0 + i * step, z0 + j * step).
 */
export function bakeOcclusionField(blocks, trees = [], opts = {}) {
  const steps = bakeOcclusionSteps(blocks, trees, opts);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/**
 * The same bake as a generator that yields between its passes (each ~1 ms on
 * a city), so a caller can spread it over a few frames. Its return value is
 * bakeOcclusionField's result.
 */
export function* bakeOcclusionSteps(blocks, trees = [], { maxDim = MAX_DIM } = {}) {
  if (!blocks?.length) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const b of blocks) {
    minX = Math.min(minX, b.x - b.hw); maxX = Math.max(maxX, b.x + b.hw);
    minZ = Math.min(minZ, b.z - b.hd); maxZ = Math.max(maxZ, b.z + b.hd);
  }
  minX -= MARGIN; minZ -= MARGIN; maxX += MARGIN; maxZ += MARGIN;
  const step = Math.max(1, Math.ceil(Math.max(maxX - minX, maxZ - minZ) / maxDim));
  const w = Math.ceil((maxX - minX) / step) + 1;
  const h = Math.ceil((maxZ - minZ) / step) + 1;
  const n = w * h;
  const near = new Float32Array(n);
  const far = new Float32Array(n);
  const tmp = new Float32Array(n);
  const toI = (x) => (x - minX) / step;
  const toJ = (z) => (z - minZ) / step;

  // Coverage: texels whose centre lies inside a body. A taller wall throws a
  // wider, darker contact (saturating at ~3 m) and hides more sky (~12 m).
  for (const b of blocks) {
    const hgt = Math.max(0, b.h ?? 3);
    const cn = Math.min(1, 0.35 + hgt / 4.5);
    const cf = Math.min(1, hgt / 12);
    const i0 = Math.max(0, Math.ceil(toI(b.x - b.hw))), i1 = Math.min(w - 1, Math.floor(toI(b.x + b.hw)));
    const j0 = Math.max(0, Math.ceil(toJ(b.z - b.hd))), j1 = Math.min(h - 1, Math.floor(toJ(b.z + b.hd)));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * w + i;
        if (cn > near[k]) near[k] = cn;
        if (cf > far[k]) far[k] = cf;
      }
    }
  }
  // Tree clumps hide sky too, more softly (crowns stand off the ground).
  for (const t of trees) {
    const r = t.r;
    if (t.x + r < minX || t.x - r > maxX || t.z + r < minZ || t.z - r > maxZ) continue;
    const i0 = Math.max(0, Math.ceil(toI(t.x - r))), i1 = Math.min(w - 1, Math.floor(toI(t.x + r)));
    const j0 = Math.max(0, Math.ceil(toJ(t.z - r))), j1 = Math.min(h - 1, Math.floor(toJ(t.z + r)));
    for (let j = j0; j <= j1; j++) {
      const dz = minZ + j * step - t.z;
      for (let i = i0; i <= i1; i++) {
        const dx = minX + i * step - t.x;
        if (dx * dx + dz * dz > r * r) continue;
        const k = j * w + i;
        if (far[k] < 0.4) far[k] = 0.4;
      }
    }
  }

  yield;
  for (const [a, r] of [[near, Math.round(NEAR_R / step)], [far, Math.round(FAR_R / step)]]) {
    if (r < 1) continue;
    // blur(), a pass at a time.
    boxRows(a, tmp, w, h, r); yield;
    boxCols(tmp, a, w, h, r); yield;
    boxRows(a, tmp, w, h, r); yield;
    boxCols(tmp, a, w, h, r); yield;
  }

  const data = new Uint8Array(n * 2);
  for (let k = 0; k < n; k++) {
    // Contact rises fast off a lone wall (ease-out, no kink at the rim), the
    // sky term only where cover is dense on several sides (squared above a floor).
    const e = 1 - Math.min(1, near[k] * 1.6);
    const c = 1 - e * e;
    const s = Math.max(0, Math.min(1, (far[k] - 0.08) * 1.5));
    data[k * 2] = Math.round(c * 255);
    data[k * 2 + 1] = Math.round(s * s * 255);
  }
  return { data, w, h, x0: minX, z0: minZ, step };
}

// ---------------------------------------------------------------------------
// GPU side: one shared uniform set (like terrain's WOODLAND), filled by the
// decals system, read by the terrain and the coloured ground decals.

const emptyField = new THREE.DataTexture(new Uint8Array(2), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
emptyField.needsUpdate = true;

export const GROUND_AO = {
  tGroundAO: { value: emptyField },
  // (x0 - step/2, z0 - step/2, 1 / (w * step), 1 / (h * step))
  uGroundAORect: { value: new THREE.Vector4(0, 0, 0, 0) },
  // (contact weight, sky weight), day fade included; zero = off
  uGroundAO: { value: new THREE.Vector2(0, 0) },
};

// Darkening at full weight: contact up to 22 %, sky term up to 18 % (kept subtle).
export const GROUND_AO_GLSL = /* glsl */ `
uniform sampler2D tGroundAO;
uniform vec4 uGroundAORect;
uniform vec2 uGroundAO;
float groundOcclusion(vec2 xz) {
  if (uGroundAO.x + uGroundAO.y <= 0.0) return 1.0;
  vec2 uv = (xz - uGroundAORect.xy) * uGroundAORect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  vec2 o = texture2D(tGroundAO, uv).rg;
  return (1.0 - 0.22 * uGroundAO.x * o.r) * (1.0 - 0.18 * uGroundAO.y * o.g);
}
`;

/** Upload a baked field (or clear with null) into GROUND_AO. */
export function setGroundField(field) {
  const old = GROUND_AO.tGroundAO.value;
  if (!field) {
    if (old !== emptyField) old.dispose();
    GROUND_AO.tGroundAO.value = emptyField;
    GROUND_AO.uGroundAORect.value.set(0, 0, 0, 0);
    return;
  }
  let tex = old;
  if (tex === emptyField || tex.image.width !== field.w || tex.image.height !== field.h) {
    if (old !== emptyField) old.dispose();
    tex = new THREE.DataTexture(field.data, field.w, field.h, THREE.RGFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.unpackAlignment = 1;
    GROUND_AO.tGroundAO.value = tex;
  } else {
    tex.image.data = field.data;
  }
  tex.needsUpdate = true;
  const s = field.step;
  GROUND_AO.uGroundAORect.value.set(field.x0 - s / 2, field.z0 - s / 2, 1 / (field.w * s), 1 / (field.h * s));
}
