import * as THREE from 'three';
import { createPathField, PATH_RANGE, PATH_HALF } from './paths.js';
import { classifyStreets, STREET } from './streets.js';

// The road splat (design-visual §5): two textures over the road grid, sampled
// by the terrain shader.
//
// tRoad, RGBA8, one texel per cell:
//   R  wear, normalised: log1p(wear) / log1p(3000)
//   G  tier * 51 (0 grass .. 5 avenue)
//   B  bare-dirt trampling on untiered cells (wear before a trail forms)
//   A  building footprint coverage (0..1), so roads stop at doorsteps
// tPath, RG8, PATH_K texels per cell (paths.js): every tiered cell as a
// continuous strip, as a signed distance to the strip edge plus its tier.
// tStreet, RGBA8, one texel per cell (streets.js): R alley and G footway
// paving under everything (spread one cell under the road they meet), B paved
// (an alley's cobbles or setts rather than packed earth), A the alley itself
// (its surface replaces the lane's strip there, with a gutter), so
// lanes between buildings pave wall to wall and made roads get kerbed
// pavements by era. The path field is drawn from the tiers with footway
// cells' worn side paths left out (the pavement replaces them).
// Uploads are throttled to 2 Hz; the sim's dirty rect is cleared after upload.
// Each upload refills the whole tRoad grid, so the sim may overwrite `dirty`
// freely; tPath diffs the grid itself and redraws only changed tiles.

const LOG_WEAR_MAX = Math.log1p(3000);
// Path tiles redrawn per frame after the first build (each ~0.06 ms).
const PATH_TILES_PER_FRAME = 12;
// Above this many dirty texel rows, one whole upload beats many row uploads.
const PATH_FULL_UPLOAD_ROWS = 256;

export function createRoadSplat() {
  let texture = null;
  let data = null;
  let W = 0;
  let H = 0;
  let lastVersion = -1;
  let lastUpload = -1;
  let pending = false;
  let forceFill = false;
  let roadsRef = null;
  let foot = null; // Uint8 coverage per cell under building walls
  let wearN = null; // normalised wear per cell (fill)
  let field = null; // paths.js strip field
  let pathTex = null;
  let street = null;     // STREET class per cell (streets.js)
  let streetData = null; // tStreet texels
  let streetTex = null;
  let fieldTier = null;  // the tiers the path field draws (footways' side paths left out)
  let fieldRoads = null;
  let era = 0;
  let streetEra = -1;
  let streetVersion = -1;
  let streetFoot = true;

  const uniforms = {
    tRoad: { value: null },
    tPath: { value: null },
    uRoadOrigin: { value: new THREE.Vector2(-256, -256) },
    uRoadSize: { value: new THREE.Vector2(512, 512) },
    tStreet: { value: null },
    uStreetEra: { value: 0 },
  };

  // 1x1 placeholders so the terrain shader always has valid samplers.
  const empty = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  empty.needsUpdate = true;
  uniforms.tRoad.value = empty;
  const emptyPath = new THREE.DataTexture(new Uint8Array(2), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
  emptyPath.needsUpdate = true;
  uniforms.tPath.value = emptyPath;
  const emptyStreet = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  emptyStreet.needsUpdate = true;
  uniforms.tStreet.value = emptyStreet;

  function allocate(roads) {
    W = roads.W; H = roads.H;
    data = new Uint8Array(W * H * 4);
    foot = new Uint8Array(W * H);
    wearN = new Float32Array(W * H);
    texture?.dispose();
    texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    uniforms.tRoad.value = texture;
    uniforms.uRoadOrigin.value.set(roads.ox, roads.oz);
    uniforms.uRoadSize.value.set(W * roads.cell, H * roads.cell);
    field = createPathField({ W, H, cell: roads.cell, ox: roads.ox, oz: roads.oz });
    pathTex?.dispose();
    pathTex = new THREE.DataTexture(field.data, field.TW, field.TH, THREE.RGFormat, THREE.UnsignedByteType);
    pathTex.magFilter = THREE.LinearFilter;
    pathTex.minFilter = THREE.LinearFilter;
    pathTex.generateMipmaps = false;
    pathTex.wrapS = pathTex.wrapT = THREE.ClampToEdgeWrapping;
    pathTex.colorSpace = THREE.NoColorSpace;
    pathTex.unpackAlignment = 1;
    // Row ranges are safe once Three has really uploaded the whole texture.
    pathTex.onUpdate = () => { pathFull = false; };
    uniforms.tPath.value = pathTex;
    street = new Uint8Array(W * H);
    streetData = new Uint8Array(W * H * 4);
    streetTex?.dispose();
    streetTex = new THREE.DataTexture(streetData, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    streetTex.magFilter = THREE.LinearFilter;
    streetTex.minFilter = THREE.LinearFilter;
    streetTex.generateMipmaps = false;
    streetTex.wrapS = streetTex.wrapT = THREE.ClampToEdgeWrapping;
    streetTex.colorSpace = THREE.NoColorSpace;
    uniforms.tStreet.value = streetTex;
    fieldTier = new Uint8Array(W * H);
    fieldRoads = Object.create(roads);
    fieldRoads.tier = fieldTier;
    streetVersion = -1;
  }

  // Street classes (streets.js) and the tiers the path field draws, when the
  // tiers, the footprints or the era changed. ~2 ms in a city.
  function syncStreets(roads) {
    const v = roads.version ?? 0;
    if (v === streetVersion && era === streetEra && !streetFoot) return false;
    streetVersion = v;
    streetEra = era;
    streetFoot = false;
    const { tier } = roads;
    classifyStreets(W, H, tier, foot, era, street);
    streetData.fill(0);
    const alleyish = (k) => k === STREET.ALLEY || k === STREET.PAVED_ALLEY;
    for (let i = 0; i < W * H; i++) {
      const k = street[i];
      const o = i * 4;
      fieldTier[i] = k === STREET.FOOTWAY && tier[i] < 3 ? 0 : tier[i];
      if (!k) continue;
      // The paving fills its own cell and, under the road it meets, the
      // neighbouring road cell too, so no grass shows between the road
      // strip's edge and the paving (the strip draws over it).
      const fills = [i];
      for (const n of [i - 1, i + 1, i - W, i + W]) {
        if (n >= 0 && n < W * H && !street[n] && tier[n] >= (k === STREET.FOOTWAY ? 3 : 1)) fills.push(n);
      }
      for (const f of fills) {
        const q = f * 4;
        if (alleyish(k)) {
          streetData[q] = 255;
          if (k === STREET.PAVED_ALLEY) streetData[q + 2] = 255;
        } else streetData[q + 1] = 255;
      }
      if (alleyish(k)) streetData[o + 3] = 255;
    }
    streetTex.needsUpdate = true;
    uniforms.uStreetEra.value = era;
    return true;
  }

  // Redraw changed path tiles (all of them on the first build) and queue
  // their rows for upload. pathFull: a whole-texture upload is queued and has
  // not reached the GPU yet, so row ranges must not ride on it (Three would
  // upload only them). It clears when Three uploads (pathTex.onUpdate), not
  // on the next update: frames can update without drawing (the first frame
  // waits while materials compile), and nothing uploads until a draw.
  let pathFull = true;
  function updatePaths(roads, budget, rescan = true) {
    const rects = field.update(roads, budget, rescan);
    if (!rects.length) return false;
    if (pathFull) {
      pathTex.needsUpdate = true;
      return true;
    }
    let rows = 0;
    for (const r of rects) rows += r.z1 - r.z0;
    if (rows > PATH_FULL_UPLOAD_ROWS) {
      pathTex.clearUpdateRanges();
      pathFull = true;
      pathTex.needsUpdate = true;
      return true;
    }
    // Three counts update ranges in 4 components per pixel, whatever the format.
    for (const r of rects)
      for (let z = r.z0; z < r.z1; z++) pathTex.addUpdateRange((z * field.TW + r.x0) * 4, (r.x1 - r.x0) * 4);
    pathTex.needsUpdate = true;
    return true;
  }

  // Normalised wear per cell, then the texture. A grass cell (or a pair) that
  // walkers stepped round, mostly ringed by trodden ground, takes most of its
  // neighbours' wear: drawn only, so a busy patch reads as one worn yard rather
  // than a grid of green squares (the sim's wear is untouched).
  const HOLE_TRODDEN = 0.3;   // normalised wear that counts as trodden
  const HOLE_RING = 5;        // of the 8 neighbours, at least this many trodden
  function fill(roads, x0, z0, x1, z1) {
    const { wear, tier } = roads;
    // One cell of margin so the hole test sees the rect's neighbours.
    const ax0 = Math.max(0, x0 - 1), ax1 = Math.min(W - 1, x1 + 1);
    const az0 = Math.max(0, z0 - 1), az1 = Math.min(H - 1, z1 + 1);
    for (let z = az0; z <= az1; z++) {
      let i = z * W + ax0;
      for (let x = ax0; x <= ax1; x++, i++) wearN[i] = wear ? Math.min(1, Math.log1p(Math.max(0, wear[i])) / LOG_WEAR_MAX) : 0;
    }
    for (let z = z0; z <= z1; z++) {
      let i = z * W + x0;
      for (let x = x0; x <= x1; x++, i++) {
        let w = wearN[i];
        if (w < HOLE_TRODDEN && x > 0 && z > 0 && x < W - 1 && z < H - 1) {
          let ring = 0, sum = 0;
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dz) continue;
              const n = wearN[i + dz * W + dx];
              sum += n;
              if (n >= HOLE_TRODDEN) ring++;
            }
          if (ring >= HOLE_RING) w = Math.max(w, (sum / 8) * 0.9);
        }
        const t = tier ? tier[i] : 0;
        const o = i * 4;
        data[o] = w * 255;
        data[o + 1] = t * 51;
        // Trampled grass begins to show around wear ~20 and reads as bare
        // dirt by ~60. Tiered cells are drawn by the path field instead.
        data[o + 2] = t > 0 ? 0 : Math.max(0, Math.min(1, (w - 0.3) / 0.25)) * 150;
        data[o + 3] = foot[i];
      }
    }
  }

  /** Call once per frame; uploads at most twice a second. */
  function update(roads, time) {
    if (!roads || !roads.W) return false;
    if (roads !== roadsRef || roads.W !== W || roads.H !== H) {
      roadsRef = roads;
      allocate(roads);
      fill(roads, 0, 0, W - 1, H - 1);
      texture.needsUpdate = true;
      syncStreets(roads);
      pathFull = true;
      updatePaths(fieldRoads, Infinity);
      lastVersion = roads.version ?? 0;
      roads.dirty = null;
      lastUpload = time;
      return true;
    }
    // Finish path tiles left over from the last scan, a few per frame; the
    // grid is scanned again with the next upload.
    let drew = false;
    if (field.pending()) drew = updatePaths(fieldRoads, PATH_TILES_PER_FRAME, false);
    if (roads.dirty || (roads.version ?? 0) !== lastVersion || forceFill || era !== streetEra) pending = true;
    forceFill = false;
    if (!pending || time - lastUpload < 0.5) return drew;
    // A full refill is ~65k cells (~0.3 ms) and never misses a rect the sim
    // replaced between throttled uploads.
    fill(roads, 0, 0, W - 1, H - 1);
    texture.needsUpdate = true;
    syncStreets(roads);
    updatePaths(fieldRoads, PATH_TILES_PER_FRAME);
    roads.dirty = null;
    lastVersion = roads.version ?? 0;
    lastUpload = time;
    pending = false;
    return true;
  }

  /**
   * Rasterise building footprints (lot summaries' pads) into the coverage
   * channel. Called when the set of lots changes; the next upload carries it.
   */
  function setFootprints(lots) {
    const r = roadsRef;
    if (!r || !foot) return false;
    foot.fill(0);
    const c = r.cell;
    for (const lot of lots.values()) {
      for (const p of lot.summary?.pads ?? []) {
        const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, z0 = p.z - p.d / 2, z1 = p.z + p.d / 2;
        const i0 = Math.max(0, Math.floor((x0 - r.ox) / c)), i1 = Math.min(r.W - 1, Math.floor((x1 - r.ox) / c));
        const j0 = Math.max(0, Math.floor((z0 - r.oz) / c)), j1 = Math.min(r.H - 1, Math.floor((z1 - r.oz) / c));
        for (let j = j0; j <= j1; j++) {
          const cz0 = r.oz + j * c;
          const fz = Math.max(0, Math.min(cz0 + c, z1) - Math.max(cz0, z0)) / c;
          for (let i = i0; i <= i1; i++) {
            const cx0 = r.ox + i * c;
            const fx = Math.max(0, Math.min(cx0 + c, x1) - Math.max(cx0, x0)) / c;
            const k = j * r.W + i;
            foot[k] = Math.max(foot[k], Math.round(fx * fz * 255));
          }
        }
      }
    }
    pending = true;
    forceFill = true;
    streetFoot = true;
    return true;
  }

  /** The town's era (sim/eras.js), for the street fabric's paving. */
  function setEra(e) {
    era = e | 0;
  }

  /** STREET class at a world point (decor keeps its verge planting off paving). */
  function streetAt(x, z) {
    const r = roadsRef;
    if (!r || !street) return 0;
    const cx = Math.floor((x - r.ox) / r.cell);
    const cz = Math.floor((z - r.oz) / r.cell);
    if (cx < 0 || cz < 0 || cx >= r.W || cz >= r.H) return 0;
    return street[cz * r.W + cx];
  }

  /** Tier at a world point (used by props and picking). */
  function tierAt(x, z) {
    const r = roadsRef;
    if (!r) return 0;
    const cx = Math.floor((x - r.ox) / r.cell);
    const cz = Math.floor((z - r.oz) / r.cell);
    if (cx < 0 || cz < 0 || cx >= r.W || cz >= r.H) return 0;
    return r.tier[cz * r.W + cx];
  }

  return { uniforms, update, tierAt, setFootprints, setEra, streetAt };
}

// Piecewise-linear PATH_HALF in GLSL: the nominal half-width at a tier.
const HALF_GLSL = PATH_HALF.slice(1).map((h, k) =>
  `  if (t < ${(k + 1).toFixed(1)}) return mix(${PATH_HALF[k].toFixed(3)}, ${h.toFixed(3)}, t - ${k.toFixed(1)});`).join('\n');

// GLSL for the terrain: bare dirt from the cell splat, then each tier as a
// continuous strip from the path field, with a clean edge that wanders a
// little on the organic tiers and not at all on planned ones.
export const ROAD_GLSL = /* glsl */ `
uniform sampler2D tRoad;
uniform sampler2D tPath;
uniform vec2 uRoadOrigin;
uniform vec2 uRoadSize;
uniform sampler2D tStreet;
uniform float uStreetEra;

// Cobbles: rounded stones on a 0.55 m staggered grid, dark joints between.
float cobbles(vec2 p) {
  p *= 1.8;
  p.x += step(1.0, mod(floor(p.y), 2.0)) * 0.5;
  vec2 f = fract(p) - 0.5;
  float d = max(abs(f.x) * 1.1, abs(f.y));
  return smoothstep(0.5, 0.36, d) * (0.9 + 0.2 * hash12(floor(p)));
}

// Flagstones: slabs of \`size\` metres on a staggered grid, thin dark joints.
float flagstones(vec2 p, float size) {
  p /= size;
  p.x += step(1.0, mod(floor(p.y), 2.0)) * 0.5;
  vec2 f = abs(fract(p) - 0.5);
  return smoothstep(0.5, 0.465, max(f.x, f.y)) * (0.93 + 0.12 * hash12(floor(p)));
}

#ifdef MICRO_DETAIL
// Micro-detail: the world-space slope (dH/dx, dH/dz) of the same stones as
// cobbles(p * scale), drawn as relief by the normal (shaderlib MICRO_NORMAL).
// Each stone is a rounded square (superellipse, no crease along its
// diagonals) with a chamfered edge, a crown (round: 1 domed cobbles, 0
// flat-topped setts) and a small tilt of its own, as if bedded by hand.
// pxM is the pixel footprint in metres: the chamfer never gets narrower than
// 1.5 pixels, which band-limits the relief instead of letting it shimmer.
vec2 stoneSlope(vec2 w, float scale, float amp, float edge, float round, float pxM) {
  float k = 1.8 * scale;
  vec2 p = w * k;
  p.x += step(1.0, mod(floor(p.y), 2.0)) * 0.5;
  vec2 f = fract(p) - 0.5;
  vec2 a = abs(f) * vec2(1.1, 1.0);
  vec2 a2 = a * a;
  float d4 = a2.x * a2.x + a2.y * a2.y;
  float d = sqrt(sqrt(d4));
  // d(d)/df = sign(f) * stretch * a^3 / d^3.
  vec2 dd = sign(f) * vec2(1.1, 1.0) * a2 * a / max(d4 / max(d, 1e-4), 1e-6);
  float e1 = 0.5 - max(0.5 - edge, pxM * k * 1.5);
  float t = clamp((0.5 - d) / (0.5 - e1), 0.0, 1.0);
  float S = t * t * (3.0 - 2.0 * t);
  float dS = -6.0 * t * (1.0 - t) / (0.5 - e1);
  float crown = 1.0 - round * 4.0 * d * d;
  float dhdd = dS * crown - S * round * 8.0 * d;
  float hs = hash12(floor(p) + vec2(7.0, 3.0));
  vec2 tilt = (vec2(hs, fract(hs * 13.7)) - 0.5) * 0.12 * S;
  return (dhdd * dd) * amp * k + tilt;
}
#endif

#ifdef GROUND_RELIEF
// Ground relief (docs/design/graphics-review.md P1): the slope of trodden
// soil (bare dirt, trails, tracks, gravel), which the terrain adds to gBumpW
// once it knows where puddles and snow flatten it.
vec3 gSoil = vec3(0.0);

// 1 while a noise cell of \`size\` metres spans 6 pixels or more, 0 under 3:
// the relief fades out before it can shimmer (and is skipped beyond).
float reliefFade(float size, float pxM) {
  return smoothstep(3.0, 6.0, size / max(pxM, 1e-4));
}

// Pebbles: rounded stones where value noise at \`freq\` per metre peaks. x is
// the stone (0..1, for colour), yz the world slope of \`amp\` metres of it.
// Two octaves on grids turned against each other: one alone thresholds into
// blobs that line up with its grid (they read as pixel art).
vec3 pebbles(vec2 p, float freq, float amp) {
  mat2 r1 = mat2(0.8, 0.6, -0.6, 0.8), r2 = mat2(0.28, -0.96, 0.96, 0.28);
  vec3 a = vnoised(r1 * p * freq), b = vnoised(r2 * p * (freq * 1.7) + 3.1);
  float v = a.x * 0.6 + b.x * 0.4;
  vec2 g = (transpose(r1) * a.yz * 0.6 + transpose(r2) * b.yz * (0.4 * 1.7)) * freq;
  float t = clamp((v - 0.55) / 0.2, 0.0, 1.0);
  return vec3(t * t * (3.0 - 2.0 * t), g * (6.0 * t * (1.0 - t) / 0.2 * amp));
}
#endif

#ifdef SPECULAR
// Wet sheen (docs/design/micro-detail.md §6): gloss (x) and roughness (y) of
// wet laid stone, cobbles (sett 0) or setts (1), from the same stones as
// cobbles(): tops glossy, joints matte. sharp fades the mask to its average
// once a stone is a few pixels across, so the gloss cannot alias.
vec2 wetStone(vec2 w, float sett, float sharp) {
  float top = mix(0.7, smoothstep(0.3, 0.75, cobbles(w * mix(1.0, 1.35, sett))), sharp);
  return mix(vec2(0.3, 0.6), vec2(1.0, mix(0.22, 0.16, sett)), top);
}
#endif

// Cubic B-spline filtering from four bilinear taps (Sigg & Hadwiger, GPU
// Gems 2 ch. 20). The cell splat is one texel per 2 m cell: plain bilinear
// showed that grid as diamonds and stairs along the edges of trampled dirt
// and of the snow that thins over it.
vec4 textureBSpline(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 p = uv * size - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size;
  vec2 h1 = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * texture2D(t, h0) + g1.x * texture2D(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture2D(t, vec2(h0.x, h1.y)) + g1.x * texture2D(t, h1));
}

float pathHalf(float t) {
${HALF_GLSL}
  return ${PATH_HALF[5].toFixed(3)};
}

// Returns road colour in rgb and coverage in a.
vec4 roadSurface(vec3 world, vec3 grass, float detail) {
  // Metres per pixel here, taken before any branch (derivatives need
  // uniform control flow): the edge is antialiased over about one pixel.
  float px = length(fwidth(world.xz));
  vec2 ruv = (world.xz - uRoadOrigin) / uRoadSize;
  if (ruv.x <= 0.0 || ruv.y <= 0.0 || ruv.x >= 1.0 || ruv.y >= 1.0) return vec4(grass, 0.0);
  vec2 pth = texture2D(tPath, ruv).rg;
  vec4 r = texture2D(tRoad, ruv);
  vec4 fabric = texture2D(tStreet, ruv);
  float dirt = r.b;
  if (pth.r < 0.004 && dirt < 0.01 && fabric.r + fabric.g < 0.004) return vec4(grass, 0.0);
  // Only where there is trampling (the B-spline's wider reach adds nothing
  // visible beyond it: the threshold below starts at 0.14).
  if (dirt > 0.002) dirt = textureBSpline(tRoad, ruv).b;
  // Signed distance inside the nearest strip's edge, in metres (< 0 outside),
  // and that strip's tier (exact on and near the strip).
  float sd = (pth.r - 0.5) * ${(2 * PATH_RANGE).toFixed(3)};
  float tier = pth.g * 5.0;
  float wear = r.r;
  float planned = smoothstep(3.4, 4.0, tier);
  float walls = 1.0 - smoothstep(0.25, 0.75, r.a);
  float n = vnoise(world.xz * 0.9) * 0.6 + vnoise(world.xz * 2.7) * 0.4 - 0.5;
  #ifdef GROUND_RELIEF
    // Trodden soil up close: soft lumps of packed earth, no sharp features
    // (pebbles and cracks read as flaking plaster rather than dirt).
    // soilShade tints the earth colours below; soilSl is the slope.
    float soilShade = 1.0;
    vec3 soilSl = vec3(0.0);
    float lumpK = reliefFade(0.5, px);
    if (lumpK > 0.0 && (tier < 3.0 || dirt > 0.01)) {
      vec3 lump = vnoised(world.xz * 2.0 + 13.0);
      soilSl.xz += lump.yz * (2.0 * 0.01 * lumpK);
      soilShade *= 1.0 - 0.06 * (lump.x - 0.5) * lumpK;
    }
  #endif
  // Mud: broad, soft damp patches that darken worn earth (all tiers).
  float mudN = vnoise(world.xz * 0.55 + 3.0) * 0.65 + vnoise(world.xz * 1.6 + 7.0) * 0.35;
  float damp = smoothstep(0.5, 0.78, mudN) * (0.6 + 0.4 * uWet);

  // Bare dirt: wear on ground that is not yet a trail, ragged and patchy.
  float lo = 0.3 + n * 0.32;
  float bareCover = smoothstep(lo, lo + 0.16, dirt) * walls;
  vec3 bare = mix(grass, vec3(0.38, 0.29, 0.17), 0.82) * (1.0 - 0.22 * damp);
  #ifdef GROUND_RELIEF
    bare *= soilShade;
  #endif
  vec3 col = mix(grass, bare, bareCover);
  col = mix(col, mix(grass, bare, 0.5), (1.0 - bareCover) * smoothstep(0.08, 0.35, dirt) * 0.35);

  // The strip: a clean edge, wandering a little on trails, less on tracks
  // and roads, not at all on planned paving.
  float jag = mix(mix(0.3, 0.16, smoothstep(1.0, 3.0, tier)), 0.03, planned);
  float e = sd + n * jag;
  float aa = clamp(px * 0.6, 0.05, 0.6);
  float cover = smoothstep(-aa, aa, e) * walls;
  // Distance from the strip's centreline (0 centre .. 1 edge).
  float hw = pathHalf(tier);
  float dc = clamp((hw - sd) / max(hw, 0.1), 0.0, 1.0);
  // Deep inside a wide worn area (a yard, a square) there is no lane to rut.
  float lane = 1.0 - smoothstep(hw * 0.95, hw * 1.4, sd);

  // Linear-space albedos: trodden earth, packed dirt, pale gravel.
  vec3 earth = vec3(0.38, 0.29, 0.17);
  vec3 trail = mix(mix(grass, earth, 0.62), earth * 0.94, (1.0 - dc) * 0.55 * lane) * (1.0 - 0.22 * damp);
  vec3 dirtC = vec3(0.30, 0.21, 0.12) * (0.94 + 0.1 * vnoise(world.xz * 1.2)) * (1.0 - 0.25 * damp);
  #ifdef GROUND_RELIEF
    trail *= soilShade;
    dirtC *= soilShade;
  #endif
  // Tracks: packed mud, with grass breaking through here and there along the
  // crown (in patches, so it never reads as a stripe).
  float crownK = smoothstep(0.5, 0.75, vnoise(world.xz * 0.7 + 21.0));
  vec3 track = mix(dirtC, mix(dirtC, grass, 0.45), (1.0 - smoothstep(0.0, 0.18, dc)) * 0.3 * lane * crownK);
  // Grit: soft two-octave noise (a hash per 16 cm square read as pixels up
  // close), flattened to its average once it is under a few pixels.
  #ifdef GROUND_RELIEF
    // The same grit, its first octave with a slope: stones 1 cm proud.
    vec3 gr = vnoised(world.xz * 7.0);
    float grit = mix(0.5, gr.x * 0.6 + vnoise(world.xz * 19.0 + 5.0) * 0.4, smoothstep(0.06, 0.02, px));
    vec2 gritSl = gr.yz * (7.0 * 0.6 * 0.004 * reliefFade(1.0 / 7.0, px));
  #else
  float grit = mix(0.5, vnoise(world.xz * 7.0) * 0.6 + vnoise(world.xz * 19.0 + 5.0) * 0.4, smoothstep(0.06, 0.02, px));
  #endif
  // Packed earthen gravel: the dirt it is laid on shows through, and it darkens with the damp.
  vec3 gravel = vec3(0.44, 0.37, 0.27) * (0.93 + 0.1 * grit) * (1.0 - 0.15 * damp);
  gravel *= 1.0 - 0.08 * smoothstep(0.7, 1.0, dc);
  vec3 cobble = mix(vec3(0.38, 0.36, 0.33), vec3(0.62, 0.60, 0.56), cobbles(world.xz));
  vec3 setts = mix(vec3(0.30, 0.30, 0.31), vec3(0.50, 0.50, 0.51), cobbles(world.xz * 1.35));

  vec3 c = trail;
  c = mix(c, track, smoothstep(1.4, 2.0, tier));
  c = mix(c, gravel, smoothstep(2.4, 3.0, tier));
  c = mix(c, mix(gravel, cobble, detail), smoothstep(3.4, 4.0, tier));
  c = mix(c, mix(cobble, setts, detail), smoothstep(4.4, 5.0, tier));
  // Busier lanes are paler and more compacted.
  c *= 0.94 + 0.1 * wear;
  // Kerb: a pale stone band along an avenue's edge (where no pavement does it).
  float era = uStreetEra;
  float footK = smoothstep(0.4, 0.6, fabric.g);
  float kerb = smoothstep(4.4, 5.0, tier) * (1.0 - smoothstep(0.18, 0.32, e)) * (1.0 - footK);
  c = mix(c, vec3(0.78, 0.76, 0.70), kerb * 0.85);
  // Worn edge: a darker rim of trodden earth where an organic lane meets the grass.
  float rim = (1.0 - smoothstep(0.0, 0.35, e)) * (1.0 - planned);
  c *= 1.0 - 0.1 * rim;
  #ifdef SPECULAR
    // Wet sheen: gS is the strip's surface, gC what lies under it (bare
    // dirt, alley, footway), composed below as c and col are. Mud and
    // gravel get a dull sheen; stone is evaluated only in the rain.
    bool sWet = uWet > 0.02;
    float sSharp = smoothstep(0.1, 0.04, px);
    vec2 sMud = vec2(0.35, 0.55);
    vec2 gC = sMud * bareCover;
    vec2 gS = mix(sMud, vec2(0.3, 0.5), smoothstep(2.4, 3.0, tier));
    if (sWet && tier > 3.4) gS = mix(gS, wetStone(world.xz, step(4.7, tier), sSharp), smoothstep(3.4, 4.0, tier) * detail);
    gS = mix(gS, vec2(0.8, 0.28), kerb * 0.85);
  #endif

  // Street fabric (streets.js). Alleys: the lane between two buildings is
  // surfaced wall to wall, whatever its strip's width: trodden earth, then
  // cobbles, then setts, with a stone gutter down the middle of a one-cell
  // passage (the texel's peak) and grime at the wall feet.
  float alleyK = smoothstep(0.4, 0.6, fabric.r);
  float alleyOwn = smoothstep(0.4, 0.6, fabric.a);
  if (alleyK > 0.0) {
    vec3 packed = mix(earth, dirtC, 0.5) * (0.9 + 0.1 * vnoise(world.xz * 4.0));
    float pavedK = smoothstep(0.4, 0.6, fabric.b);
    vec3 alleyC = mix(packed, mix(packed, mix(cobble, setts, step(3.5, era)), detail), pavedK);
    float gutter = smoothstep(0.9, 0.95, fabric.a) * (1.0 - smoothstep(0.985, 0.998, fabric.a)) * pavedK;
    alleyC = mix(alleyC, vec3(0.24, 0.24, 0.25), gutter * 0.7);
    alleyC *= 1.0 - 0.18 * smoothstep(0.15, 0.6, r.a);
    c = mix(c, alleyC, alleyOwn);
    col = mix(col, alleyC, alleyK);
    #ifdef SPECULAR
      vec2 gA = sMud;
      if (sWet && pavedK > 0.0) gA = mix(gA, wetStone(world.xz, step(3.5, era), sSharp), pavedK * detail);
      // The gutter runs with water.
      gA = mix(gA, vec2(1.0, 0.1), gutter * 0.8);
      gS = mix(gS, gA, alleyOwn);
      gC = mix(gC, gA, alleyK);
    #endif
  }
  // Footways: flagstones from the road's edge to the building fronts, a
  // granite kerb along the carriageway's own (smooth) edge with its face in
  // shadow, and from the city era a dark channel on the road side.
  if (footK > 0.0) {
    float size = era < 3.5 ? 0.9 : era < 4.5 ? 0.6 : 0.75;
    vec3 slab = era < 3.5 ? vec3(0.58, 0.54, 0.47) : era < 4.5 ? vec3(0.52, 0.51, 0.49) : vec3(0.60, 0.60, 0.58);
    vec3 joint = slab * 0.62;
    vec3 fw = mix(joint, slab, mix(1.0, flagstones(world.xz, size), detail));
    fw *= 0.94 + 0.08 * vnoise(world.xz * 1.7);
    fw *= 1.0 - 0.12 * smoothstep(0.2, 0.7, r.a);
    col = mix(col, fw, footK);
    // Along a made road only (the strip under this point is tier 3+).
    float made = smoothstep(2.6, 3.0, tier);
    float kerbBand = smoothstep(-0.3, -0.25, sd) * (1.0 - smoothstep(-0.03, 0.0, sd));
    vec3 kerbC = vec3(0.70, 0.69, 0.66) * (0.94 + 0.1 * hash12(floor(world.xz * 1.1)));
    col = mix(col, kerbC, kerbBand * made * footK);
    #ifdef SPECULAR
      // Flags: slab tops glossy, joints matte (the joints are thin, so the
      // mask gives way to its average sooner than the stones' does).
      float fTop = 0.85;
      if (sWet) fTop = mix(0.85, smoothstep(0.6, 0.95, flagstones(world.xz, size)), smoothstep(0.06, 0.025, px) * detail);
      vec2 gF = mix(vec2(0.3, 0.6), vec2(0.85, 0.22), fTop);
      gF = mix(gF, vec2(0.85, 0.25), kerbBand * made);
      gC = mix(gC, gF, footK);
    #endif
    // The kerb's face, a hand's height of shadow where it drops to the road.
    float face = smoothstep(-0.05, -0.01, sd) * (1.0 - smoothstep(0.01, 0.06, sd));
    c *= 1.0 - 0.45 * face * made * footK;
    col *= 1.0 - 0.45 * face * made * footK * (1.0 - cover);
    // The channel: a darker strip of setts just inside the road's edge.
    float channel = smoothstep(0.0, 0.03, sd) * (1.0 - smoothstep(0.2, 0.26, sd)) * step(3.5, era);
    c = mix(c, vec3(0.22, 0.22, 0.23), channel * made * footK * 0.6);
  }

  // Worn verge: grass darkens a touch for half a metre beside a strip.
  col *= 1.0 - 0.08 * smoothstep(-0.7, 0.0, sd) * (1.0 - cover) * step(0.004, pth.r) * (1.0 - max(alleyK, footK));
  col = mix(col, c, cover);
  #ifdef SPECULAR
    vec2 gG = mix(gC, gS, cover);
    gSpecK = gG.x;
    gSpecRough = gG.y;
  #endif
  #ifdef MICRO_DETAIL
    // Relief on cobbles and setts, faded out once a stone is a few pixels
    // across (and skipped entirely there, which is most of a far view).
    float paved = smoothstep(3.4, 4.0, tier) * cover * (1.0 - kerb * 0.85) * detail;
    float reliefK = paved * smoothstep(0.12, 0.06, px);
    if (reliefK > 0.0) {
      float setK = smoothstep(4.4, 5.0, tier);
      vec2 sl = vec2(0.0);
      if (setK < 1.0) sl += stoneSlope(world.xz, 1.0, 0.035, 0.34, 1.0, px) * (1.0 - setK);
      if (setK > 0.0) sl += stoneSlope(world.xz, 1.35, 0.02, 0.42, 0.25, px) * setK;
      gBumpW.xz += sl * reliefK;
    }
  #endif
  #ifdef GROUND_RELIEF
    // Soil relief where earth shows (bare dirt, trails, tracks), grit on
    // gravel; none on alleys and footways, which are surfaced.
    float gravelK = smoothstep(2.4, 3.0, tier);
    float unpaved = 1.0 - max(alleyK, footK);
    gSoil = soilSl * mix(bareCover, 1.0 - gravelK, cover) * unpaved;
    gSoil.xz += gritSl * cover * gravelK * (1.0 - smoothstep(3.4, 4.0, tier)) * unpaved;
  #endif
  return vec4(col, max(max(cover, bareCover * 0.8), max(alleyK, footK)));
}
`;
