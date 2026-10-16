// Quality tiers, auto-detection and the persisted override (design-visual §4.7).

export const TIERS = {
  low: {
    name: 'low', pixelRatio: 1.25, shadowMapSize: 1024, shadowType: 'pcf', shadowRadius: 1,
    water: 'low', reflection: false, cloudShadow: false, post: false,
    particles: 0.25, terrainDetail: 1, maxFps: 60,
    ao: 'baked',
  },
  medium: {
    name: 'medium', pixelRatio: 1.75, shadowMapSize: 2048, shadowType: 'pcf', shadowRadius: 1,
    water: 'medium', reflection: false, cloudShadow: false, post: false,
    particles: 0.6, terrainDetail: 1, maxFps: 60,
    ao: 'baked',
  },
  high: {
    name: 'high', pixelRatio: 1.75, shadowMapSize: 2048, shadowType: 'pcfsoft', shadowRadius: 3,
    water: 'high', reflection: true, cloudShadow: true, post: true,
    particles: 1, terrainDetail: 1, maxFps: 60,
    ao: 'ssao', // screen-space AO in the post pass (ssao.js); 'baked' = ground field only (occlusion.js)
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

/** First guess before any frame is measured. */
export function guessTier(gl) {
  const maxTex = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) ?? 8192;
  if (maxTex < 8192) return 'low';
  if (isMobileUA()) return 'medium';
  return 'high';
}

/**
 * Rolling frame-time monitor for 'auto'. After a 3 s settle window it may
 * step the tier down (median > 18 ms) or up (median < 9 ms on desktop).
 */
export function createAutoTuner() {
  const samples = new Float32Array(180);
  let count = 0;
  let head = 0;
  let elapsed = 0;
  let decided = false;
  const scratch = new Float32Array(180);

  return {
    reset() { count = 0; head = 0; elapsed = 0; decided = false; },
    /** Feed a frame delta (ms). Returns a new tier name or null. */
    sample(ms, tier) {
      if (decided || !(ms > 0) || ms > 250) return null;
      samples[head] = ms; head = (head + 1) % samples.length;
      count = Math.min(count + 1, samples.length);
      elapsed += ms;
      if (elapsed < 3000 || count < 60) return null;
      decided = true;
      scratch.set(samples.subarray(0, count));
      const sorted = scratch.subarray(0, count).sort();
      const median = sorted[count >> 1];
      if (median > 18 && tier !== 'low') return tier === 'high' ? 'medium' : 'low';
      if (median < 9 && tier === 'medium' && !isMobileUA()) return 'high';
      return null;
    },
  };
}
