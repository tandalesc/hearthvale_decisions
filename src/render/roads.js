import * as THREE from 'three';

// The road splat (design-visual §5): one RGBA8 DataTexture over the road grid,
// sampled by the terrain shader. Channels:
//   R  wear, normalised: log1p(wear) / log1p(3000)
//   G  tier * 51 (0 grass .. 5 avenue)
//   B  presence: 1 on any road cell, a faint value on trampled grass
//   A  building footprint coverage (0..1), so roads stop at doorsteps
// Uploads are throttled to 2 Hz; the sim's dirty rect is cleared after upload.
// Each upload refills the whole grid, so the sim may overwrite `dirty` freely.

const LOG_WEAR_MAX = Math.log1p(3000);

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

  const uniforms = {
    tRoad: { value: null },
    uRoadOrigin: { value: new THREE.Vector2(-256, -256) },
    uRoadSize: { value: new THREE.Vector2(512, 512) },
  };

  // A 1x1 placeholder so the terrain shader always has a valid sampler.
  const empty = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  empty.needsUpdate = true;
  uniforms.tRoad.value = empty;

  function allocate(roads) {
    W = roads.W; H = roads.H;
    data = new Uint8Array(W * H * 4);
    foot = new Uint8Array(W * H);
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
  }

  function fill(roads, x0, z0, x1, z1) {
    const { wear, tier } = roads;
    for (let z = z0; z <= z1; z++) {
      let i = z * W + x0;
      for (let x = x0; x <= x1; x++, i++) {
        const w = wear ? Math.min(1, Math.log1p(Math.max(0, wear[i])) / LOG_WEAR_MAX) : 0;
        const t = tier ? tier[i] : 0;
        const o = i * 4;
        data[o] = w * 255;
        data[o + 1] = t * 51;
        // Trampled grass begins to show around wear ~20 and reads as a path by ~60.
        data[o + 2] = t > 0 ? 255 : Math.max(0, Math.min(1, (w - 0.3) / 0.25)) * 150;
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
      lastVersion = roads.version ?? 0;
      roads.dirty = null;
      lastUpload = time;
      return true;
    }
    if (roads.dirty || (roads.version ?? 0) !== lastVersion || forceFill) pending = true;
    forceFill = false;
    if (!pending || time - lastUpload < 0.5) return false;
    // A full refill is ~65k cells (~0.3 ms) and never misses a rect the sim
    // replaced between throttled uploads.
    fill(roads, 0, 0, W - 1, H - 1);
    texture.needsUpdate = true;
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
    return true;
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

  return { uniforms, update, tierAt, setFootprints };
}

// GLSL for the terrain: road look per tier with organic, ragged edges.
export const ROAD_GLSL = /* glsl */ `
uniform sampler2D tRoad;
uniform vec2 uRoadOrigin;
uniform vec2 uRoadSize;

// Cobbles: rounded stones on a 0.55 m staggered grid, dark joints between.
float cobbles(vec2 p) {
  p *= 1.8;
  p.x += step(1.0, mod(floor(p.y), 2.0)) * 0.5;
  vec2 f = fract(p) - 0.5;
  float d = max(abs(f.x) * 1.1, abs(f.y));
  return smoothstep(0.5, 0.36, d) * (0.9 + 0.2 * hash12(floor(p)));
}

// Returns road colour in rgb and coverage in a.
vec4 roadSurface(vec3 world, vec3 grass, float detail) {
  vec2 ruv = (world.xz - uRoadOrigin) / uRoadSize;
  if (ruv.x <= 0.0 || ruv.y <= 0.0 || ruv.x >= 1.0 || ruv.y >= 1.0) return vec4(grass, 0.0);
  vec4 r = texture2D(tRoad, ruv);
  float presence = r.b;
  if (presence < 0.01) return vec4(grass, 0.0);
  // Tier of the nearest road cell, recovered from the filtered sum.
  float tier = clamp(r.g * 5.0 / max(presence, 0.2), 0.0, 5.0);
  float wear = r.r;

  // Ragged edge: threshold presence against two octaves of noise. Planned
  // tiers (4-5) get a much tighter, straighter edge.
  float n = vnoise(world.xz * 0.7) * 0.6 + vnoise(world.xz * 2.1) * 0.4 - 0.5;
  float planned = smoothstep(3.4, 4.0, tier);
  float jag = mix(0.32, 0.06, planned);
  float lo = 0.3 + n * jag;
  float cover = smoothstep(lo, lo + mix(0.16, 0.05, planned), presence);
  // Roads end at doorsteps: no cover under building walls.
  cover *= 1.0 - smoothstep(0.25, 0.75, r.a);

  // Linear-space albedos: worn earth, packed dirt, pale gravel.
  vec3 dirt = vec3(0.30, 0.21, 0.12);
  vec3 trail = mix(grass, vec3(0.38, 0.29, 0.17), 0.82);
  vec3 track = dirt * (0.92 + 0.16 * vnoise(world.xz * 3.0));
  float grit = hash12(floor(world.xz * 6.0));
  vec3 gravel = vec3(0.55, 0.48, 0.36) * (0.9 + 0.16 * grit);
  vec3 cobble = mix(vec3(0.38, 0.36, 0.33), vec3(0.62, 0.60, 0.56), cobbles(world.xz));
  vec3 setts = mix(vec3(0.30, 0.30, 0.31), vec3(0.50, 0.50, 0.51), cobbles(world.xz * 1.35));

  vec3 c = trail;
  c = mix(c, track, smoothstep(1.4, 2.0, tier));
  c = mix(c, gravel, smoothstep(2.4, 3.0, tier));
  c = mix(c, mix(gravel, cobble, detail), smoothstep(3.4, 4.0, tier));
  c = mix(c, mix(cobble, setts, detail), smoothstep(4.4, 5.0, tier));
  // Busier lanes are paler and more compacted.
  c *= 0.94 + 0.1 * wear;
  // Kerb: a pale stone band where an avenue meets the verge.
  float kerb = smoothstep(4.4, 5.0, tier) * (1.0 - smoothstep(0.0, 0.18, abs(cover - 0.5)));
  c = mix(c, vec3(0.78, 0.76, 0.70), kerb * 0.85);
  // Faint trampling before a trail forms (presence below the cover threshold).
  // Worn edge: a darker rim of trodden earth where the lane meets the grass,
  // strongest on the organic tiers (1-3).
  float rim = smoothstep(0.0, 0.25, cover) * (1.0 - smoothstep(0.35, 0.8, cover)) * (1.0 - planned);
  c *= 1.0 - 0.12 * rim;
  vec3 col = mix(grass, c, cover);
  col = mix(col, mix(grass, trail, 0.5), (1.0 - cover) * smoothstep(0.08, 0.35, presence) * 0.35 * (1.0 - planned));
  // Worn verge: grass darkens a touch beside any road.
  col *= 1.0 - 0.07 * smoothstep(0.1, 0.4, presence) * (1.0 - cover);
  return vec4(col, cover);
}
`;
