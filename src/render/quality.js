// Quality tiers, auto-detection and the persisted override (design-visual §4.7).
//
// Fidelity additions per tier (Low draws exactly what it drew before them):
//   groundCover  'none' | 'grass' (meadow grass, reeds, bracken) | 'full' (+ wildflowers)
//   woods        share of the denser-woods pass drawn (extra trees, understorey)
//   yards        woodpiles, washing lines, plots, barrels, carts, hay (decor)
//   mist         valley mist sheets (dawn, autumn, damp and cold nights)
//   weather      puddle sheen on wet ground, rain rings on water, wind on crops
//   microDetail  relief on close-up surfaces from their analytic height
//                patterns, as shading normals (docs/design/micro-detail.md)
//   specular     wet sheen on paving and roofs in the rain, glints on window
//                glass (docs/design/micro-detail.md §6)

export const TIERS = {
  low: {
    name: 'low', pixelRatio: 1.25, shadowMapSize: 1024, shadowType: 'pcf', shadowRadius: 1,
    water: 'low', reflection: false, cloudShadow: false, post: false,
    particles: 0.25, terrainDetail: 1, maxFps: 60,
    ao: 'baked',
    groundCover: 'none', woods: 0, yards: false, mist: false, weather: false, microDetail: false, specular: false,
  },
  medium: {
    name: 'medium', pixelRatio: 1.75, shadowMapSize: 2048, shadowType: 'pcf', shadowRadius: 1,
    water: 'medium', reflection: false, cloudShadow: false, post: false,
    particles: 0.6, terrainDetail: 1, maxFps: 60,
    ao: 'baked',
    groundCover: 'grass', woods: 0.3, yards: true, mist: false, weather: true, microDetail: false, specular: false,
  },
  high: {
    name: 'high', pixelRatio: 1.75, shadowMapSize: 2048, shadowType: 'pcfsoft', shadowRadius: 3,
    water: 'high', reflection: true, cloudShadow: true, post: true,
    particles: 1, terrainDetail: 1, maxFps: 60,
    ao: 'ssao', // screen-space AO in the post pass (ssao.js); 'baked' = ground field only (occlusion.js)
    groundCover: 'full', woods: 1, yards: true, mist: true, weather: true, microDetail: true, specular: true,
  },
};

const STORAGE_KEY = 'hearthvale-quality';

export function loadQualityOverride() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && TIERS[v] ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveQualityOverride(value) {
  try {
    if (value === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch { /* storage may be blocked; the choice lasts for this session */ }
}

const isMobileUA = () => {
  const ua = navigator.userAgent || '';
  // iPadOS reports a Mac UA; touch points give it away.
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
};

/**
 * The GPU's own name where the browser shares it (Chrome and Edge do; Safari
 * says "Apple GPU"; Firefox gives a coarse family name), else ''.
 */
export function gpuName(gl) {
  try {
    const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl?.getParameter?.(gl.RENDERER) || '');
  } catch {
    return '';
  }
}

// Software rasterisers draw the town at a few frames a second: Low from the start.
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render/i;
// Integrated and mobile GPUs: Medium first (the tuner may still go up or down).
// "Radeon(TM) Graphics" and Vega are the integrated parts of Ryzen laptops.
const INTEGRATED_GPU = /intel|mali|adreno|powervr|vivante|tegra|radeon\(tm\) graphics|radeon vega|vega \d+ graphics/i;

/** First guess before any frame is measured. */
export function guessTier(gl) {
  const maxTex = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) ?? 8192;
  if (maxTex < 8192) return 'low';
  const gpu = gpuName(gl);
  if (SOFTWARE_GPU.test(gpu)) return 'low';
  if (isMobileUA() || INTEGRATED_GPU.test(gpu)) return 'medium';
  return 'high';
}

const STEP_DOWN = { high: 'medium', medium: 'low' };

/**
 * Rolling frame-time monitor for 'auto'. Feed it full-rate animation-frame
 * intervals; it answers with a new tier name, or null to stay.
 *
 * - Settling: after the first 3 s (and 60 frames) it may step the tier down
 *   (median over 18 ms) or up (Medium to High at a median under 9 ms, desktop
 *   only). After a step down it settles again, so a slow machine reaches Low
 *   within seconds.
 * - Watching: once settled, it keeps measuring in 5 s windows and steps down
 *   one tier when two windows in a row have a median over 25 ms (under 40
 *   fps), as when a town grows into a city. It never steps up again on its
 *   own, so it cannot bounce between tiers; choosing Auto again in Settings
 *   starts over.
 */
export function createAutoTuner({ settleMs = 3000, watchMs = 5000, slowMs = 18, sustainedMs = 25, fastMs = 9 } = {}) {
  const SIZE = 360;
  const samples = new Float32Array(SIZE);
  const scratch = new Float32Array(SIZE);
  let count = 0, elapsed = 0, settled = false, slowWindows = 0;

  const median = () => {
    scratch.set(samples.subarray(0, count));
    const sorted = scratch.subarray(0, count).sort();
    return sorted[count >> 1];
  };
  const restart = () => { count = 0; elapsed = 0; };

  return {
    reset() { restart(); settled = false; slowWindows = 0; },
    /** Whether the first decision has been made (diagnostics and tests). */
    settled: () => settled,
    /** Feed a frame delta (ms). Returns a new tier name or null. */
    sample(ms, tier) {
      if (!(ms > 0) || ms > 250) return null;
      if (count < SIZE) samples[count++] = ms;
      elapsed += ms;
      if (!settled) {
        if (elapsed < settleMs || count < 60) return null;
        const m = median();
        restart();
        if (m > slowMs && STEP_DOWN[tier]) return STEP_DOWN[tier];   // settle again at the new tier
        settled = true;
        if (m < fastMs && tier === 'medium' && !isMobileUA()) return 'high';
        return null;
      }
      if (elapsed < watchMs || count < 60) return null;
      const m = median();
      restart();
      slowWindows = m > sustainedMs ? slowWindows + 1 : 0;
      if (slowWindows >= 2 && STEP_DOWN[tier]) {
        slowWindows = 0;
        return STEP_DOWN[tier];
      }
      return null;
    },
  };
}
