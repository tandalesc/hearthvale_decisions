import * as THREE from 'three';

// Valley mist (High tier): how misty the air is, and how it is lit. It is
// drawn by the shared fog (atmosphere.js hvMist): an exponential height fog
// over the valley floor, thickest at the water, with slow banks drifting with
// the wind, applied in every fogged material's own pass. It lies thickest at
// dawn, on autumn days, under rain cloud and on winter nights, and burns off
// by a summer noon. (It used to be three translucent 300 m sheets over the
// ground: a few full screens of overdraw, and hard lines where walls, trunks
// and slopes cut through them.)

export function createMist(ctx) {
  const { grade } = ctx;
  const u = grade.uniforms;
  let enabled = false;
  let amount = 0;
  const col = new THREE.Color();
  const sky = new THREE.Color();

  /** How misty the air is now: dawn, autumn, damp, cold nights. */
  function target() {
    const c = grade.current;
    const ph = c.phase ?? 0.5;
    const dawn = Math.max(0, 1 - Math.abs(ph - 0.27) / 0.09);
    const morning = Math.max(0, 1 - Math.abs(ph - 0.33) / 0.12);
    return Math.min(0.95,
      dawn * 0.85 + morning * 0.25
      + u.uAutumn.value * 0.4
      + u.uWet.value * 0.35
      + u.uNight.value * 0.3
      + u.uSnow.value * 0.15);
  }

  return {
    update(view, frame) {
      if (!enabled) {
        u.uMistAmt.value = 0;
        return;
      }
      const want = target();
      // Eased over ~2 s at 1x, faster at speed: eased in real time, at 20x it
      // never cleared between dawns and hung over the town all day.
      const ease = 2 / Math.max(1, frame.speed ?? 1);
      amount += (want - amount) * Math.min(1, (frame.dt ?? 0.016) / ease);
      // Mist is a close-up effect: thinned as the camera rises.
      const far = THREE.MathUtils.smoothstep(frame.distance ?? 100, 180, 320);
      u.uMistAmt.value = amount * (1 - far);
      // Banks drift with the wind.
      const t = u.uDecoTime.value;
      u.uMistDrift.value.set(u.uWind.value.x * t * 0.6, u.uWind.value.y * t * 0.6);
      // Lit by the low sun and the sky; dimmer at night.
      const night = u.uNight.value;
      col.copy(u.uFogTint.value).lerp(sky.copy(u.uSkyHorizon.value), 0.4);
      const sun = u.uSunColor.value, k = 0.12 * (1 - night);
      col.setRGB(col.r + sun.r * k, col.g + sun.g * k, col.b + sun.b * k);
      col.multiplyScalar(1 - 0.55 * night);
      u.uMistColor.value.copy(col);
    },
    applyQuality(q) {
      enabled = !!q.mist;
      if (!enabled) u.uMistAmt.value = 0;
    },
    dispose() {
      u.uMistAmt.value = 0;
    },
  };
}
