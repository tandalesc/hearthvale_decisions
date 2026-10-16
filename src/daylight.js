// Time of day, shared by the renderer's grade (render/grade.js) and the sim (leisure
// choices, "face the sunset"), so what people do agrees with the light that is drawn.
//
// The default ("seasonal") day-cycle mode lets the year carry the day: spring
// morning -> summer noon -> autumn golden hour -> winter dusk -> a short night beat at
// the year's end -> dawn. A phase is 0 at midnight, 0.5 at noon. The sim always uses
// the seasonal phase (it is a pure function of the clock, so saves replay exactly);
// the renderer's other modes ('slow': a day per real minute, 'off': always noon) are a
// viewing preference that changes only the drawn light.
//
// Pure: no Three.js, no state.

import {TICKS_PER_MONTH, MONTHS_PER_YEAR} from './sim/clock.js';

// Phase keyframes (0 = midnight) of the drawn light presets. The list wraps at 1.
export const TOD_KEYS = [
  [0.0, 'night'], [0.19, 'night'], [0.26, 'dawn'], [0.36, 'noon'],
  [0.6, 'noon'], [0.69, 'golden'], [0.77, 'dusk'], [0.845, 'night'], [1.0, 'night'],
];

// Seasonal mode: year fraction -> phase (may run past 1: wrap it).
export const YEAR_TO_PHASE = [
  [0.0, 0.24], [0.06, 0.34], [0.25, 0.44], [0.5, 0.56], [0.7, 0.665],
  [0.84, 0.705], [0.91, 0.765], [0.94, 0.86], [0.975, 1.12], [1.0, 1.24],
];

// The sun's compass bearing (degrees; the grade's light direction is
// (cos el * sin az, sin el, cos el * cos az)), and the moon's path at night: it rises
// at MOON_RISE (phase) and crosses from MOON_AZ0 to MOON_AZ1 over MOON_SPAN.
export const SUN_AZIMUTH_DEG = 215;
export const MOON_RISE = 0.8;
export const MOON_SPAN = 0.43;
export const MOON_AZ0_DEG = 105;
export const MOON_AZ1_DEG = 255;

const smooth = (t) => t * t * (3 - 2 * t);

export function piecewise(keys, x) {
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [x0, y0] = keys[i - 1];
      const [x1, y1] = keys[i];
      return y0 + (y1 - y0) * smooth((x - x0) / (x1 - x0 || 1));
    }
  }
  return keys[keys.length - 1][1];
}

/** Seasonal-mode phase of day (0..1, 0 midnight) for a year fraction. */
export function seasonalPhase(yearT) {
  const p = piecewise(YEAR_TO_PHASE, yearT);
  return ((p % 1) + 1) % 1;
}

/** The light preset in force at a phase: 'night', 'dawn', 'noon', 'golden' or 'dusk'. */
export function lightAt(phase) {
  const p = ((phase % 1) + 1) % 1;
  let i = 1;
  while (i < TOD_KEYS.length - 1 && TOD_KEYS[i][0] < p) i++;
  const [p0, a] = TOD_KEYS[i - 1], [p1, b] = TOD_KEYS[i];
  return p - p0 < p1 - p ? a : b;
}

/** Low warm light worth looking at: dawn, the golden hour and dusk. */
export const lowSun = (phase) => {
  const p = ((phase % 1) + 1) % 1;
  return (p > 0.21 && p < 0.32) || (p > 0.64 && p < 0.82);
};
export const isNight = (phase) => {
  const p = ((phase % 1) + 1) % 1;
  return p < 0.21 || p > 0.83;
};
export const isEvening = (phase) => {
  const p = ((phase % 1) + 1) % 1;
  return p > 0.64 && p < 0.86;
};
export const isMorning = (phase) => {
  const p = ((phase % 1) + 1) % 1;
  return p > 0.21 && p < 0.38;
};

/** A walker heading (atan2(dx, dz), as people.js) that faces the sun. */
export const SUN_HEADING = (SUN_AZIMUTH_DEG * Math.PI) / 180;
/** Unit (x, z) toward the sun on the ground. */
export const SUN_DIR = [Math.sin(SUN_HEADING), Math.cos(SUN_HEADING)];

/** The sim's phase of day: the seasonal phase of its clock at the current tick (not the
 * frame's sub-tick remainder, which depends on the frame rate). */
export function simPhase(time) {
  return seasonalPhase((time.month + (time.tick % TICKS_PER_MONTH) / TICKS_PER_MONTH) / MONTHS_PER_YEAR);
}
