// The river: a soft, low wash you hear from anywhere in the valley, and,
// close to the water, a gurgle (noise through three narrow bands whose levels
// hop at random, like water over stones) and scattered bubbles. Fords are shallow riffles, so
// they babble more. The level follows the listener's distance to the bank and
// the camera height, and pans toward the side the water is on.
//
// Lakes, ponds and the sea: waves lapping on the shore, a soft low wash
// that swells and breaks every few seconds; slow and deep on the open sea,
// small and quick on a lake.
//
// Hook for rapids or weirs: setSources([{x, z, intensity 0..1, radius}]) adds
// a brighter rush, more gurgle and more bubbles near each point. Optional.

import {riverX, WATER_HALF, FORDS, hasRiver, stillDistanceAt, stillBodyKind, KIND} from '../terrain.js';
import {bubble} from './voices.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Seasonal flow: spring melt runs fuller, late summer runs low.
const FLOW = [[0, 1.1], [0.12, 1.2], [0.3, 1], [0.55, 0.85], [0.75, 0.95], [0.9, 1], [1, 1.1]];
function curve(keys, x) {
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [x0, y0] = keys[i - 1], [x1, y1] = keys[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return keys[keys.length - 1][1];
}

export function createRiver(bus, out, h) {
  const {ctx} = bus;
  const pan = ctx.createStereoPanner();
  pan.connect(out);
  const ax = {ctx, out: pan};

  // Wash: pink noise under a cutoff that distance pulls down.
  const washLp = h.filter('lowpass', 600, 0.5);
  const wash = h.bed(h.chain(h.loop(bus.pink, 1, true), washLp), pan, 'river');

  // Gurgle: three narrow bands of one source, each swelling on its own
  // ~10 times a second, so the energy hops between them like water over
  // stones. Fixed filters keep it cheap; only gains move.
  const src = h.loop(bus.pink);
  const gsum = h.gain(1);
  const gurgle = h.bed(gsum, pan, 'river');
  for (const [f, q, hz, lv] of [[430, 3, 9, 1], [780, 3.5, 11, 0.75], [1300, 4, 14, 0.5]]) {
    const am = h.gain(lv);
    h.chain(src, h.filter('bandpass', f, q), am, gsum);
    h.wobble(am.gain, lv, 0.9, hz, gurgle);
  }

  // Shore: low wash in surges (one per wave), deeper for the sea.
  const shoreLp = h.filter('lowpass', 520, 0.6);
  const shore = h.bed(h.chain(h.loop(bus.pink, 1, true), shoreLp), out, 'river');
  const wave = {at: 0, peak: 0, up: 1, down: 3};

  // Rush: only near rapids. Kept under 3.5 kHz so it never hisses.
  const rush = h.bed(h.chain(src, h.filter('bandpass', 1400, 0.7), h.filter('lowpass', 3200, 0.5)), pan, 'river');

  const state = {near: 0, presence: 0, bubbleLevel: 0, swell: 1, swellAt: 0};
  let sources = [];
  const bubbles = h.stream((t) => {
    const f = 280 + 900 * Math.random() ** 1.6;
    bubble(ax, t, {level: state.bubbleLevel * (0.4 + 0.6 * Math.random()), pan: Math.random() * 1.2 - 0.6, f});
  });

  return {
    setSources(list) {
      sources = (Array.isArray(list) ? list : [])
        .filter((s) => Number.isFinite(s?.x) && Number.isFinite(s?.z))
        .map((s) => ({x: s.x, z: s.z, intensity: clamp01(s.intensity ?? 1), radius: Math.max(5, s.radius ?? 30)}));
    },
    // L: {x, z, distance, rightX}; f: {yearT, rain}.
    update(t, L, f) {
      const height = L.distance * 0.5;
      const dx = riverX(L.z) - L.x;
      // A valley without a river: the river voice falls silent.
      const bank = hasRiver() ? Math.max(0, Math.abs(dx) - WATER_HALF) : 1e4;
      const eff = Math.hypot(bank, height * 0.5);
      const near = 1 / (1 + (eff / 18) ** 2);
      const presence = 1 / (1 + eff / 40);
      let riffle = 0, rapids = 0;
      for (const fd of FORDS) {
        const d = Math.hypot(L.x - riverX(fd.z), L.z - fd.z, height * 0.5);
        riffle += 0.6 / (1 + (d / 24) ** 2);
      }
      for (const s of sources) {
        const d = Math.hypot(L.x - s.x, L.z - s.z, height * 0.5);
        rapids += s.intensity / (1 + (d / s.radius) ** 2);
      }
      riffle = Math.min(1, riffle);
      rapids = Math.min(1.5, rapids);
      // A slow, irregular swell in the flow.
      if (t >= state.swellAt) {
        state.swell = 0.8 + 0.35 * Math.random();
        state.swellAt = t + 3 + Math.random() * 9;
      }
      const flow = curve(FLOW, f.yearT) * (1 + 0.25 * f.rain) * state.swell;
      state.near = near;
      state.presence = presence;

      h.setBed(wash, 0.05 * flow * (0.3 * presence + 0.7 * near) * (1 + 0.4 * rapids), 2.5);
      h.tune(wash, washLp.frequency, 320 + 700 * near + 500 * rapids, 1);
      h.setBed(gurgle, 0.09 * flow * near ** 1.3 * (0.5 + 0.6 * riffle + 0.8 * rapids), 1.5);
      h.setBed(rush, 0.05 * rapids * (0.3 + 0.7 * near), 1.5);
      const side = Math.sign(dx) * (L.rightX ?? 1);
      h.glide(pan.pan, side * 0.6 * smoothstep(3, 30, bank), 1);

      // Waves on a still shore: distance to the water (and camera height),
      // and how exposed the water is (the sea most, a pond hardly at all).
      const sd = stillDistanceAt(L.x, L.z);
      const kind = stillBodyKind();
      const exposure = kind === KIND.SEA ? 1 : kind === -KIND.LAKE ? 0.6 : kind === KIND.LAKE ? 0.35 : 0.12;
      const shoreEff = Math.hypot(Math.max(0, sd), height * 0.5);
      const shoreNear = Number.isFinite(sd) ? exposure / (1 + (shoreEff / 26) ** 2) : 0;
      if (t >= wave.at) {
        // The next wave: the sea's come long and heavy, a lake's short and light.
        const gap = (kind === KIND.SEA ? 5 : 2.6) * (0.7 + 0.6 * Math.random());
        wave.at = t + gap;
        wave.peak = 0.55 + 0.45 * Math.random();
        wave.up = gap * 0.35;
        wave.down = gap * 0.6;
        h.setBed(shore, 0.07 * shoreNear * wave.peak, wave.up);
        wave.fallAt = t + wave.up;
      } else if (wave.fallAt && t >= wave.fallAt) {
        wave.fallAt = 0;
        h.setBed(shore, 0.07 * shoreNear * 0.25, wave.down);
      }
      h.tune(shore, shoreLp.frequency, (kind === KIND.SEA ? 380 : 620) + 500 * shoreNear, 1);

      state.bubbleLevel = h.muted('river') ? 0 : 0.012 * near * flow;
      bubbles(t, (1.5 + 8 * riffle + 12 * rapids) * near ** 1.5);
      return near;
    },
    get near() { return state.near; },
    get presence() { return state.presence; },
  };
}
