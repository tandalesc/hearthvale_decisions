// Frame pacing and the Battery saver (design-visual §4.8). Pure logic, no
// Three.js, so node:test can cover it; render/index.js applies the result.

export const SAVER_MODES = ['off', 'battery', 'always'];
export const SAVER_FPS = 30;
export const SAVER_PIXEL_RATIO = 1.25;
/** Seconds after the last camera input that the saver keeps the full rate. */
export const INTERACT_GRACE = 1;
/** Paused with no input for this long: draw once a second (ambient smoke). */
export const PAUSED_IDLE = 2;
const LOW_BATTERY = 0.2;

/**
 * Seconds that must pass since the last drawn frame to draw at `fps` on a
 * display refreshing at `refreshHz`. Drawing lands on every n-th refresh
 * (n whole, so the rate never exceeds `fps`), and the threshold sits half a
 * refresh early so timestamp jitter never pushes a frame to the next one.
 * Unknown refresh rates fall back to the plain interval less 2 ms.
 */
export function frameInterval(fps, refreshHz) {
  if (!(refreshHz > 0)) return 1 / fps - 0.002;
  const n = Math.max(1, Math.ceil(refreshHz / fps - 0.1));
  return (n - 0.5) / refreshHz;
}

/**
 * How this animation frame is paced: the least time since the last drawn
 * frame before drawing, and whether that is below the full rate (the auto
 * tuner only measures full-rate frames).
 */
export function pace({ forced = false, paused = false, idleFor = 0, saving = false, maxFps = 60, refreshHz = 0 }) {
  if (forced) return { interval: 0, paced: false };
  if (paused && idleFor > PAUSED_IDLE) return { interval: 1 - 0.5 / (refreshHz || 60), paced: true };
  if (saving && idleFor > INTERACT_GRACE) return { interval: frameInterval(Math.min(SAVER_FPS, maxFps), refreshHz), paced: true };
  return { interval: frameInterval(maxFps, refreshHz), paced: false };
}

/**
 * Power state from the Battery saver setting and the battery (null where the
 * Battery API is missing: Safari, Firefox). `saving` lowers the frame rate
 * and pixel ratio; `lowBattery` (unplugged below 20 %) always does, whatever
 * the setting, and also forces the Low tier in Auto detail.
 */
export function powerState(mode, battery) {
  const unplugged = !!battery && battery.charging === false;
  const lowBattery = unplugged && battery.level < LOW_BATTERY;
  const chosen = mode === 'always' || (mode === 'battery' && unplugged);
  return { saving: chosen || lowBattery, chosen, lowBattery, unplugged, batteryKnown: !!battery };
}

const DOWN = { high: 'medium', medium: 'low', low: 'low' };

/** The tier to draw: a manual choice stands; Auto steps down when saving. */
export function effectiveTier(qualityMode, autoTier, power) {
  if (qualityMode !== 'auto') return qualityMode;
  if (power.lowBattery) return 'low';
  return power.saving ? DOWN[autoTier] ?? autoTier : autoTier;
}

/** Device pixel ratio to draw at: the tier's cap, lower while saving. */
export function pixelRatioFor(devicePixelRatio, tier, power) {
  const cap = power.saving ? Math.min(tier.pixelRatio, SAVER_PIXEL_RATIO) : tier.pixelRatio;
  return Math.min(devicePixelRatio || 1, cap);
}

const COMMON_HZ = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];

/**
 * The display's refresh rate from animation-frame deltas (every frame, drawn
 * or not): the median of the last 90, snapped to a common rate within 4 %.
 * 0 until 30 samples are in. Throttled browsers (iOS Low Power Mode holds
 * frames to 30 Hz) simply measure as the slower rate.
 */
export function createRefreshMeter(size = 90) {
  const samples = new Float32Array(size);
  const scratch = new Float32Array(size);
  let count = 0, head = 0, hz = 0, dirty = false;
  return {
    sample(ms) {
      if (!(ms > 2) || ms > 100) return;
      samples[head] = ms; head = (head + 1) % size;
      count = Math.min(count + 1, size);
      dirty = true;
    },
    hz() {
      if (!dirty) return hz;
      dirty = false;
      if (count < 30) return (hz = 0);
      scratch.set(samples.subarray(0, count));
      const median = scratch.subarray(0, count).sort()[count >> 1];
      const raw = 1000 / median;
      const near = COMMON_HZ.find((r) => Math.abs(raw - r) / r < 0.04);
      return (hz = near ?? Math.round(raw));
    },
    reset() { count = 0; head = 0; hz = 0; dirty = false; },
  };
}
