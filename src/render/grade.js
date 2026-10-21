import * as THREE from 'three';
import {TOD_KEYS, YEAR_TO_PHASE, SUN_AZIMUTH_DEG, MOON_RISE, MOON_SPAN, MOON_AZ0_DEG, MOON_AZ1_DEG, piecewise} from '../daylight.js';

// Season and time-of-day grading (design-visual §1.2, contract §0.6).
//
// One shared set of uniforms drives every custom shader and every patched
// Three material. The grade is computed from a "phase" (0 midnight, 0.5 noon)
// and the season palette, then eased toward its target so speed changes or a
// jump in time never strobe the scene.

const hex = (h) => new THREE.Color(h); // sRGB hex -> linear working colour

// Season noon palettes, keyed by year fraction of the season's centre.
const SEASON_NOON = [
  { at: 0.125, name: 'spring', sun: hex('#fff1d6'), sky: hex('#dcefff'), ground: hex('#6e7d4a'), fog: hex('#c4d9cf'), tint: [1.0, 1.02, 0.98], exposure: 0.96, zenith: hex('#86b6dd'), horizon: hex('#d9eae4'), elevation: 48 },
  { at: 0.375, name: 'summer', sun: hex('#fff6e0'), sky: hex('#cfe8ff'), ground: hex('#7a8248'), fog: hex('#c9dccb'), tint: [1.03, 1.01, 0.95], exposure: 1.0, zenith: hex('#78acda'), horizon: hex('#d4e6e0'), elevation: 62 },
  { at: 0.625, name: 'autumn', sun: hex('#ffe3b8'), sky: hex('#e3ecf4'), ground: hex('#857646'), fog: hex('#d8d2c0'), tint: [1.06, 0.98, 0.88], exposure: 0.94, zenith: hex('#8eb0cf'), horizon: hex('#e6decb'), elevation: 44 },
  { at: 0.875, name: 'winter', sun: hex('#f2f0f4'), sky: hex('#dde6ee'), ground: hex('#9aa0a6'), fog: hex('#dfe3e6'), tint: [0.96, 0.98, 1.04], exposure: 0.92, zenith: hex('#a6bacb'), horizon: hex('#e2e6e8'), elevation: 30 },
];

// Time-of-day presets. 'noon' means "use the season palette".
const TOD = {
  night: { sun: hex('#9fb4e0'), sky: hex('#5f6f99'), ground: hex('#3a3e46'), fog: hex('#2e3744'), tint: [0.78, 0.82, 0.96], exposure: 0.8, zenith: hex('#0e1526'), horizon: hex('#2d3a54'), sunI: 0.95, hemiI: 1.35, elevation: 42, night: 1 },
  dawn: { sun: hex('#ffcfa0'), sky: hex('#e2e6f6'), ground: hex('#5f5f48'), fog: hex('#d8cfc4'), tint: [1.02, 0.97, 0.95], exposure: 0.88, zenith: hex('#7f9cc8'), horizon: hex('#f3d2b4'), sunI: 2.0, hemiI: 1.2, elevation: 16, night: 0.15 },
  golden: { sun: hex('#ffc98a'), sky: hex('#ffd8c0'), ground: hex('#6a5a3c'), fog: hex('#e4c4a6'), tint: [1.08, 0.96, 0.86], exposure: 0.9, zenith: hex('#87a2c6'), horizon: hex('#f5cc9c'), sunI: 2.5, hemiI: 1.25, elevation: 24, night: 0 },
  dusk: { sun: hex('#ffa77e'), sky: hex('#9a9cbc'), ground: hex('#55504a'), fog: hex('#a9a3b2'), tint: [0.95, 0.9, 0.96], exposure: 0.86, zenith: hex('#46527f'), horizon: hex('#e8a487'), sunI: 1.6, hemiI: 1.15, elevation: 11, night: 0.5 },
};

// Phase keyframes, the seasonal year -> phase mapping, the sun's bearing and the
// moon's path at night live in ../daylight.js, shared with the sim (so "sunset" and
// "face the sun" there agree with the light drawn here).
const SUN_AZIMUTH = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
const MOON_AZ0 = THREE.MathUtils.degToRad(MOON_AZ0_DEG);
const MOON_AZ1 = THREE.MathUtils.degToRad(MOON_AZ1_DEG);
const scratchMoon = new THREE.Vector3();

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (a, b, x) => clamp01((x - a) / (b - a));

// A grade "frame": all the values we blend. Kept as plain objects with
// preallocated colours so per-frame work allocates nothing.
function makeFrame() {
  return {
    sun: new THREE.Color(), sky: new THREE.Color(), ground: new THREE.Color(), fog: new THREE.Color(),
    zenith: new THREE.Color(), horizon: new THREE.Color(), tint: new THREE.Vector3(1, 1, 1),
    exposure: 1, sunI: 2.8, hemiI: 1.4, elevation: 50, night: 0,
    snow: 0, autumn: 0, bare: 0, blossom: 0, wet: 0, fogNear: 150, fogFar: 430,
  };
}

function copyPalette(dst, src) {
  dst.sun.copy(src.sun); dst.sky.copy(src.sky); dst.ground.copy(src.ground); dst.fog.copy(src.fog);
  dst.zenith.copy(src.zenith); dst.horizon.copy(src.horizon);
  dst.tint.set(src.tint[0] ?? src.tint.x, src.tint[1] ?? src.tint.y, src.tint[2] ?? src.tint.z);
  dst.exposure = src.exposure;
}

function lerpPalette(dst, a, b, t) {
  dst.sun.copy(a.sun).lerp(b.sun, t); dst.sky.copy(a.sky).lerp(b.sky, t);
  dst.ground.copy(a.ground).lerp(b.ground, t); dst.fog.copy(a.fog).lerp(b.fog, t);
  dst.zenith.copy(a.zenith).lerp(b.zenith, t); dst.horizon.copy(a.horizon).lerp(b.horizon, t);
  const ta = a.tint, tb = b.tint;
  dst.tint.set(
    (ta[0] ?? ta.x) + ((tb[0] ?? tb.x) - (ta[0] ?? ta.x)) * t,
    (ta[1] ?? ta.y) + ((tb[1] ?? tb.y) - (ta[1] ?? ta.y)) * t,
    (ta[2] ?? ta.z) + ((tb[2] ?? tb.z) - (ta[2] ?? ta.z)) * t,
  );
  dst.exposure = a.exposure + (b.exposure - a.exposure) * t;
}

/** Season-noon palette for a year fraction, blended between neighbours. */
function seasonNoon(dst, yearT) {
  const n = SEASON_NOON.length;
  let i = 0;
  while (i < n && SEASON_NOON[i].at <= yearT) i++;
  const a = SEASON_NOON[(i - 1 + n) % n];
  const b = SEASON_NOON[i % n];
  let span = b.at - a.at; if (span <= 0) span += 1;
  let t = yearT - a.at; if (t < 0) t += 1;
  const k = smooth(clamp01(t / span));
  lerpPalette(dst, a, b, k);
  dst.elevation = a.elevation + (b.elevation - a.elevation) * k;
  dst.sunI = 2.35; dst.hemiI = 1.2; dst.night = 0;
}

const scratchNoon = makeFrame();
const scratchFogRain = new THREE.Color('#b7bec0');
const scratchRainTint = new THREE.Vector3(0.9, 0.94, 0.98);
const scratchA = makeFrame();
const scratchB = makeFrame();

function todPreset(dst, name, noon) {
  if (name === 'noon') {
    copyPalette(dst, noon);
    dst.sunI = noon.sunI; dst.hemiI = noon.hemiI; dst.elevation = noon.elevation; dst.night = 0;
    return;
  }
  const p = TOD[name];
  copyPalette(dst, p);
  dst.sunI = p.sunI; dst.hemiI = p.hemiI; dst.elevation = p.elevation; dst.night = p.night;
}

/** Full target grade for a phase of day within the season palette. */
function gradeAt(dst, yearT, phase) {
  seasonNoon(scratchNoon, yearT);
  phase = ((phase % 1) + 1) % 1;
  let i = 1;
  while (i < TOD_KEYS.length - 1 && TOD_KEYS[i][0] < phase) i++;
  const [p0, n0] = TOD_KEYS[i - 1];
  const [p1, n1] = TOD_KEYS[i];
  const t = smooth(clamp01((phase - p0) / (p1 - p0 || 1)));
  todPreset(scratchA, n0, scratchNoon);
  todPreset(scratchB, n1, scratchNoon);
  lerpPalette(dst, scratchA, scratchB, t);
  dst.sunI = scratchA.sunI + (scratchB.sunI - scratchA.sunI) * t;
  dst.hemiI = scratchA.hemiI + (scratchB.hemiI - scratchA.hemiI) * t;
  dst.elevation = scratchA.elevation + (scratchB.elevation - scratchA.elevation) * t;
  dst.night = scratchA.night + (scratchB.night - scratchA.night) * t;
  // Season overlays on the year, independent of time of day.
  // The year opens in spring (yearT 0): snow settles in late autumn, lies
  // through winter and melts during the year-end night, never into spring.
  dst.snow = ramp(0.8, 0.86, yearT) * (1 - ramp(0.95, 0.995, yearT));
  dst.autumn = ramp(0.55, 0.68, yearT) * (1 - ramp(0.84, 0.9, yearT));
  // Bare branches from late autumn until the spring leaves return.
  dst.bare = yearT >= 0.5 ? ramp(0.76, 0.85, yearT) : 1 - ramp(0.04, 0.12, yearT);
  dst.blossom = ramp(0.06, 0.1, yearT) * (1 - ramp(0.15, 0.22, yearT));
}

function easeFrame(cur, tgt, a) {
  lerpPalette(cur, cur, tgt, a);
  for (const k of ['exposure', 'sunI', 'hemiI', 'elevation', 'night', 'snow', 'autumn', 'bare', 'blossom', 'wet', 'fogNear', 'fogFar']) {
    cur[k] += (tgt[k] - cur[k]) * a;
  }
}

/**
 * Creates the grade controller. `uniforms` is shared by reference with every
 * shader; `apply()` pushes the current grade into lights, fog and exposure.
 */
export function createGrade() {
  const uniforms = {
    uTime: { value: 0 },
    uDecoTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSkyZenith: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uSkyGround: { value: new THREE.Color() },
    uFogTint: { value: new THREE.Color() },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uSnow: { value: 0 },
    uAutumn: { value: 0 },
    uBare: { value: 0 },
    uBlossom: { value: 0 },
    uNight: { value: 0 },
    uWind: { value: new THREE.Vector2(0.6, 0.3) },
    uWet: { value: 0 },
    uYearT: { value: 0 },
    uYear: { value: 0 }, // whole years since the founding (crop rotations)
    uOverlay: { value: 0 }, // 0 none, 1 value, 2 roads, 3 health
    uWeatherDetail: { value: 0 }, // set from the tier's `weather` flag (index.js)
  };

  const current = makeFrame();
  const target = makeFrame();
  let mode = 'seasonal';
  let primed = false;
  let lastYearT = 0;
  // Weather eases on its own slow clock: rain sets in over ~8 s and clears
  // over ~4 s; snowfall both ways over ~6 s. Never toggled.
  const weather = { rain: 0, snow: 0 };
  const easeTo = (cur, tgt, dt, up, down) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tgt > cur ? up : down)));
  let dayStart = 0;

  function setMode(next) {
    mode = next;
  }

  /** Recompute the target from the view's time and weather, then ease. */
  function update(view, time, dt) {
    const yearT = view?.time?.yearT ?? lastYearT;
    lastYearT = yearT;
    let phase;
    if (mode === 'off') phase = 0.5;
    else if (mode === 'slow') phase = (((time - dayStart) / 60) + 0.45) % 1; // one day per real minute
    else phase = piecewise(YEAR_TO_PHASE, yearT);
    gradeAt(target, yearT, phase);
    current.phase = phase % 1; // time of day for the ambience (0 midnight, 0.5 noon)
    if (mode === 'off') target.night = 0;

    // Weather: rain greys the light and pulls the fog in; snow weather adds cover.
    const w = view?.weather;
    const step = primed ? Math.min(dt, 0.25) : 1e3;
    weather.rain = easeTo(weather.rain, w?.rain ?? 0, step, 8, 4);
    weather.snow = easeTo(weather.snow, w?.snow ?? 0, step, 6, 6);
    // The wet grade carries most of the rain: duller sun, darker ground,
    // more sheen on roads and water, a little more fog.
    const rain = weather.rain;
    target.wet = rain;
    target.snow = Math.max(target.snow, weather.snow * 0.9);
    target.sunI *= 1 - 0.62 * rain;
    target.hemiI *= 1 - 0.06 * rain;
    // A cooler, greyer cast under rain cloud.
    target.tint.lerp(scratchRainTint, rain * 0.7);
    target.exposure *= 1 - 0.06 * rain;
    target.fog.lerp(scratchFogRain, rain * 0.4);
    target.fogNear = 150 - 50 * rain;
    target.fogFar = 560 - 140 * rain - 80 * target.night;

    // Ease toward the target; ~1.2 s time constant keeps fast speeds calm.
    const a = primed ? 1 - Math.exp(-dt / 1.2) : 1;
    primed = true;
    easeFrame(current, target, a);

    const u = uniforms;
    u.uTime.value = time;
    u.uYearT.value = yearT;
    u.uYear.value = view?.time?.year ?? 0;
    const el = THREE.MathUtils.degToRad(current.elevation);
    u.uSunDir.value.set(Math.cos(el) * Math.sin(SUN_AZIMUTH), Math.sin(el), Math.cos(el) * Math.cos(SUN_AZIMUTH));
    const moonly = THREE.MathUtils.smoothstep(current.night, 0.3, 0.9);
    if (moonly > 0) {
      const m = clamp01((((current.phase - MOON_RISE) % 1) + 1) % 1 / MOON_SPAN);
      const az = MOON_AZ0 + (MOON_AZ1 - MOON_AZ0) * m;
      const mel = THREE.MathUtils.degToRad(14 + 38 * Math.sin(Math.PI * m));
      scratchMoon.set(Math.cos(mel) * Math.sin(az), Math.sin(mel), Math.cos(mel) * Math.cos(az));
      u.uSunDir.value.lerp(scratchMoon, moonly).normalize();
    }
    u.uSunColor.value.copy(current.sun);
    u.uSkyZenith.value.copy(current.zenith);
    u.uSkyHorizon.value.copy(current.horizon);
    u.uSkyGround.value.copy(current.ground);
    // The atmosphere colour leans toward the horizon so far land, far towns
    // and the sky's horizon band all fade to the same air.
    u.uFogTint.value.copy(current.fog).lerp(current.horizon, 0.3);
    u.uTint.value.copy(current.tint);
    u.uSnow.value = current.snow;
    u.uAutumn.value = current.autumn;
    u.uBare.value = current.bare;
    u.uBlossom.value = current.blossom;
    u.uNight.value = current.night;
    u.uWet.value = current.wet;
    if (w?.wind) u.uWind.value.set(w.wind[0] ?? 0.6, w.wind[1] ?? 0.3);
  }

  /** Push the current grade into Three objects (lights, fog, exposure). */
  function apply({ renderer, scene, hemi, sun }) {
    renderer.toneMappingExposure = current.exposure;
    hemi.color.copy(current.sky);
    hemi.groundColor.copy(current.ground);
    hemi.intensity = current.hemiI;
    sun.color.copy(current.sun);
    sun.intensity = current.sunI;
    if (scene.fog) {
      scene.fog.color.copy(uniforms.uFogTint.value);
      scene.fog.near = current.fogNear;
      scene.fog.far = current.fogFar;
    }
  }

  return {
    uniforms,
    current,
    /** Eased weather intensities (0..1) for particles: {rain, snow}. */
    weather,
    update,
    apply,
    setMode,
    mode: () => mode,
    resetDay: (time) => { dayStart = time; },
    isNight: () => current.night > 0.5,
  };
}
