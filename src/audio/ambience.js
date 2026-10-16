// Ambience: the valley's soundscape, all synthesised.
//
// Continuous beds (a few looping noise sources, filtered):
//   wind      half-speed pink noise, lowpassed; random gusts move level and
//             brightness together (no LFOs, so nothing cycles)
//   leaves    a soft rustle that follows the gusts and the foliage of the
//             season (bare in winter)
//   river     see river.js: louder and more detailed near the water
//   rain      only while it rains, kept dark
//   murmur    distant village voices: two formant bands with a syllable-rate
//             wobble, growing with population and nearness to a centre
//   hum       the low rumble of a city's streets, from the City era
//
// Event voices (voices.js), scheduled up to HORIZON seconds ahead with
// random gaps, never on a fixed beat:
//   birds     six perches, each with a bird that sings its own motif in bouts
//             and rests between them; species by season, hour and place;
//             dawn chorus at sunrise
//   crickets  five crickets that chirp in bouts on warm evenings and nights
//   frogs, owl, bee, rain drips, mallets, axes, dogs, livestock bells,
//             hooves
//
// update(env) runs about four times a second; all it does is arithmetic and
// a few setTargetAtTime calls, plus creating the nodes for due events.

import {createRiver} from './river.js';
import * as V from './voices.js';

const HORIZON = 0.6;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// 0 outside a..c, 1 at b, smooth in between.
const bump = (x, a, b, c) => (x <= b ? smoothstep(a, b, x) : 1 - smoothstep(b, c, x));
const num = (v, d) => (Number.isFinite(v) ? v : d);

function curve(keys, x) {
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [x0, y0] = keys[i - 1], [x1, y1] = keys[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return keys[keys.length - 1][1];
}

// Over the year (0 = start of spring, 0.25 summer, 0.5 autumn, 0.75 winter).
const WARMTH = [[0, 0.1], [0.12, 0.35], [0.22, 0.75], [0.3, 1], [0.48, 1], [0.58, 0.75], [0.68, 0.3], [0.75, 0], [0.97, 0], [1, 0.1]];
const FOLIAGE = [[0, 0.35], [0.1, 0.7], [0.2, 1], [0.5, 0.9], [0.65, 0.55], [0.75, 0.15], [0.95, 0.15], [1, 0.35]];
const BIRDSONG = [[0, 1.2], [0.15, 1.35], [0.3, 1], [0.45, 0.8], [0.6, 0.55], [0.75, 0.3], [0.92, 0.35], [1, 1.2]];

// A biquad whose frequency is automated (setTargetAtTime never quite ends)
// recomputes its coefficients every sample at a-rate; once per 128-sample
// block is plenty for slow sweeps and much cheaper.
export function kRate(filter) {
  try {
    filter.frequency.automationRate = 'k-rate';
    filter.Q.automationRate = 'k-rate';
  } catch { /* older engines: a-rate it is */ }
  return filter;
}

export function createAmbience(bus) {
  const {ctx} = bus;
  const out = bus.ambience;
  // ------------------------------------------------------------ helpers
  let solo = null; // dev only: hear one layer by itself
  const wobbles = [];
  function runWobbles(t) {
    for (const w of wobbles) {
      if (w.bed && !w.bed.on) continue;
      if (w.until < t) {
        w.until = t + 0.02;
        w.param.cancelScheduledValues(t);
        w.param.setValueAtTime(w.last, w.until);
      }
      while (w.until < t + HORIZON + 0.3) {
        w.until += w.step * rand(0.6, 1.4);
        w.last = w.base * (1 + w.depth * (Math.random() * 2 - 1));
        w.param.linearRampToValueAtTime(w.last, w.until);
      }
    }
  }
  const h = {
    loop(buffer, rate = 1, stereo = false) {
      const make = () => {
        const s = ctx.createBufferSource();
        s.buffer = buffer;
        s.loop = true;
        if (rate !== 1) s.playbackRate.value = rate;
        s.start(0, Math.random() * buffer.duration);
        return s;
      };
      if (!stereo) return make();
      // Two copies at random offsets, one per side, for a wide bed.
      const m = ctx.createChannelMerger(2);
      make().connect(m, 0, 0);
      make().connect(m, 0, 1);
      return m;
    },
    filter(type, f, q = 0.7) {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      kRate(n);
      return n;
    },
    gain(v = 0) {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    },
    // Connect nodes in a row; returns the last.
    chain(...nodes) {
      for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
      return nodes[nodes.length - 1];
    },
    // Random motion on a param (an AM gain, usually): short linear segments
    // to random values around base, scheduled ahead by update(). Cheaper than
    // an audio-rate modulator and it never repeats. Skipped while its bed is
    // off, so no automation piles up on a node nobody is pulling.
    wobble(param, base, depth, hz, bed) {
      param.value = base;
      wobbles.push({param, base, depth, step: 1 / hz, bed, until: 0, last: base});
    },
    // Ease a param toward v (time constant tc seconds); skip repeats.
    glide(param, v, tc) {
      if (param._target !== undefined && Math.abs(param._target - v) < 1e-5) return;
      param._target = v;
      param.setTargetAtTime(v, ctx.currentTime, tc);
    },
    // glide() for a param inside a bed, only while the bed is playing.
    tune(bed, param, v, tc) {
      if (bed.on) h.glide(param, v, tc);
    },
    // A bed is a chain ending in a level gain. When its level has been zero
    // for a while it is disconnected, so the audio thread stops pulling its
    // sources and filters; it reconnects (from silence) when needed again.
    bed(node, dest, name) {
      const level = ctx.createGain();
      level.gain.value = 0;
      node.connect(level);
      return {level, dest, name, on: false, offAt: Infinity};
    },
    muted: (name) => !!solo && solo !== name,
    setBed(b, v, tc) {
      if (h.muted(b.name)) v = 0;
      const t = ctx.currentTime;
      if (v > 1e-4) {
        b.offAt = Infinity;
        if (!b.on) {
          b.level.connect(b.dest);
          b.on = true;
        }
      } else {
        v = 0;
        if (b.on && b.offAt === Infinity) b.offAt = t + 5 * tc + 0.5;
        else if (b.on && t > b.offAt) {
          b.level.disconnect();
          b.on = false;
        }
      }
      h.glide(b.level.gain, v, tc);
    },
    // A stream of events at `rate` per second, with gaps spread between a
    // quarter and one and three quarters of the mean: uneven, never a beat.
    stream(fire) {
      let next = -1;
      return (t, rate) => {
        if (!(rate > 1e-4)) {
          next = -1;
          return;
        }
        const mean = 1 / rate;
        if (next < 0 || next > t + 3 * mean + HORIZON) next = t + mean * rand(0.2, 1.2);
        if (next < t) next = t + rand(0.02, 0.15);
        while (next < t + HORIZON) {
          fire(next);
          next += mean * rand(0.25, 1.75);
        }
      };
    },
  };

  // Event voices share one gain so they can be soloed and levelled together.
  const events = h.gain(1);
  events.connect(out);
  const ax = {ctx, out: events, space: bus.space, white: bus.white, brown: bus.brown};

  // ------------------------------------------------------------ beds
  // Filters are few on purpose: each stereo biquad costs as much as several
  // noise sources. The bus highpass removes rumble below 55 Hz for all.

  // Wind: pink noise under a lowpass that opens with each gust.
  const windLp = h.filter('lowpass', 450, 0.4);
  const wind = h.bed(h.chain(h.loop(bus.pink, 1, true), windLp), out, 'wind');

  // Leaves: a soft rustle (one wide band, ~0.8-5 kHz) with a fast, uneven
  // wobble; its level follows the gusts.
  const leafBp = h.filter('bandpass', 2000, 0.45);
  const leafAm = h.gain(1);
  const leaves = h.bed(h.chain(h.loop(bus.pink, 1, true), leafBp, leafAm), out, 'leaves');
  h.wobble(leafAm.gain, 1, 0.6, 9, leaves);

  // Rain: a dark, wide hush (one broad band around 1 kHz) plus drips.
  const rainBed = h.bed(h.chain(h.loop(bus.pink, 1, true), h.filter('bandpass', 1000, 0.35)), out, 'rain');

  // Murmur: two formant bands of one mono source, each with its own
  // syllable-rate wobble so the crowd never pulses in step; panned toward
  // the nearest centre.
  const murmurSrc = h.loop(bus.pink);
  const murmurPan = ctx.createStereoPanner();
  const murmur = h.bed(murmurPan, out, 'murmur');
  for (const [f, q, hz, level] of [[380, 0.9, 7, 1], [850, 1.3, 9, 0.55]]) {
    const am = h.gain(level);
    h.chain(murmurSrc, h.filter('bandpass', f, q), am, murmurPan);
    h.wobble(am.gain, level, 0.7, hz, murmur);
  }

  const hum = h.bed(h.chain(h.loop(bus.brown), h.filter('lowpass', 240, 0.5)), out, 'hum');

  const river = createRiver(bus, out, h);

  // ------------------------------------------------------------ slow random state
  // Gusts and "liveliness" are random walks with random step times.
  const walk = (lo, hi, minS, maxS) => ({lo, hi, minS, maxS, value: rand(lo, hi), next: 0, tc: 2});
  const gust = walk(0.3, 1, 2.5, 9);
  const birdMood = walk(0.55, 1.35, 15, 45);
  const townMood = walk(0.75, 1.2, 8, 25);
  function step(w, t, skew = 1) {
    if (t < w.next) return false;
    w.value = w.lo + (w.hi - w.lo) * Math.random() ** skew;
    w.tc = rand(w.minS * 0.3, w.maxS * 0.35);
    w.next = t + rand(w.minS, w.maxS);
    return true;
  }

  // ------------------------------------------------------------ birds
  function birdWeights(f) {
    return {
      warbler: 0.9 * smoothstep(0.1, 0.5, f.warmth),
      thrush: 0.8 + 1.5 * f.dawn + 1.2 * f.dusk,
      tit: 0.6 + 0.8 * (1 - f.warmth),
      sparrow: 0.3 + 1.6 * f.townHere,
      wren: 0.45,
      dove: (0.5 + 0.5 * f.townHere) * smoothstep(0.1, 0.6, f.warmth),
      cuckoo: perches.some((p) => p.bird?.kind === 'cuckoo') ? 0 : 0.4 * f.spring,
    };
  }
  function pickKind(weights) {
    let total = 0;
    for (const k in weights) total += weights[k];
    let r = Math.random() * total;
    for (const k in weights) if ((r -= weights[k]) <= 0) return k;
    return 'sparrow';
  }
  const LOUD = {warbler: 0.65, thrush: 0.9, tit: 0.7, sparrow: 0.6, wren: 0.5, dove: 1, cuckoo: 0.55};
  const SONG_GAP = {warbler: [3, 8], thrush: [4, 10], tit: [3, 8], sparrow: [3, 9], wren: [5, 12], dove: [6, 14], cuckoo: [1.5, 3]};
  const BOUT = {warbler: [3, 8], thrush: [3, 8], tit: [3, 7], sparrow: [2, 5], wren: [2, 5], dove: [1, 3], cuckoo: [1, 2]};

  const perches = Array.from({length: 6}, () => ({bird: null, pan: 0, dist: 0.5, next: rand(0, 6), left: 0}));
  function newBird(p, f) {
    const kind = pickKind(birdWeights(f));
    p.bird = V.makeBird(kind);
    p.pan = rand(-0.85, 0.85);
    p.dist = kind === 'cuckoo' ? rand(0.7, 1) : 0.1 + 0.9 * Math.sqrt(Math.random());
  }
  function updateBirds(t, f) {
    const level = f.birds;
    for (const p of perches) {
      let guard = 0;
      while (p.next < t + HORIZON && guard++ < 4) {
        if (p.left > 0 && p.bird && level > 0.02) {
          const at = Math.max(p.next, t + 0.02);
          const dist = clamp01(p.dist + 0.6 * f.zoom);
          const len = V.birdSong(ax, at, p.bird, {level: 0.08 * LOUD[p.bird.kind] * (1 - 0.75 * dist), pan: p.pan, dist});
          p.left--;
          const [a, b] = SONG_GAP[p.bird.kind];
          p.next = at + len + rand(a, b) / Math.min(1.6, Math.max(0.6, level));
        } else if (level > 0.02 && Math.random() < Math.min(0.85, level * 0.8)) {
          // Start a bout; often a different bird takes the perch.
          if (!p.bird || Math.random() < 0.4) newBird(p, f);
          p.left = randInt(...BOUT[p.bird.kind]);
          p.next = Math.max(p.next, t + 0.02);
        } else {
          p.left = 0;
          p.next = Math.max(p.next, t) + rand(6, 28) / Math.max(0.35, level);
        }
      }
    }
  }

  // ------------------------------------------------------------ crickets
  const crickets = Array.from({length: 5}, () => ({pitch: rand(0.78, 1.15), period: 0.7, pan: rand(-0.9, 0.9), dist: rand(0.2, 1), next: rand(0, 4), left: 0}));
  function updateCrickets(t, f) {
    const level = f.insects;
    for (const c of crickets) {
      let guard = 0;
      while (c.next < t + HORIZON && guard++ < 6) {
        if (c.left > 0 && level > 0.02) {
          const at = Math.max(c.next, t + 0.02);
          const dist = clamp01(c.dist + 0.5 * f.zoom);
          V.cricket(ax, at, {level: 0.03 * (1 - 0.7 * dist) * Math.min(1, level * 1.5) * rand(0.75, 1), pan: c.pan, dist, pitch: c.pitch});
          c.left--;
          c.period *= rand(0.985, 1.015); // a cricket drifts a little as it sings
          c.next = at + c.period * rand(0.93, 1.07);
        } else if (level > 0.02 && Math.random() < Math.min(0.9, level)) {
          // A new cricket (or the same one again) takes up its song.
          if (Math.random() < 0.5) {
            c.pitch = rand(0.78, 1.15);
            c.pan = rand(-0.9, 0.9);
            c.dist = rand(0.2, 1);
          }
          c.period = (1.05 - 0.45 * f.warmth) * rand(0.85, 1.15);
          c.left = randInt(5, 20);
          c.next = Math.max(c.next, t + 0.02);
        } else {
          c.left = 0;
          c.next = Math.max(c.next, t) + rand(2, 10) / Math.max(0.3, level);
        }
      }
    }
  }

  // ------------------------------------------------------------ other streams
  let F = null; // the latest factors, for the stream callbacks
  const owlStream = h.stream((t) => V.owl(ax, t, {level: 0.035 * (1 - 0.5 * F.zoom), pan: rand(-0.8, 0.8), dist: rand(0.5, 1)}));
  const frogStream = h.stream((t) => V.frog(ax, t, {level: 0.02 * (0.4 + 0.6 * F.riverNear), pan: rand(-0.7, 0.7), dist: clamp01(rand(0.2, 0.8) + 0.4 * F.zoom), f: rand(150, 260)}));
  const beeStream = h.stream((t) => V.bee(ax, t, {level: 0.01, seconds: rand(2.5, 4.5)}));
  const dripStream = h.stream((t) => V.drip(ax, t, {level: 0.006 * rand(0.4, 1), pan: rand(-0.9, 0.9)}));
  const hammerStream = h.stream((t) => {
    const dist = clamp01(rand(0.3, 0.9) + 0.4 * F.zoom);
    V.hammering(ax, t, {level: 0.06 * (1 - 0.6 * dist), pan: rand(-0.8, 0.8), dist, strikes: randInt(3, 9)});
  });
  const axeStream = h.stream((t) => {
    const dist = clamp01(rand(0.5, 1) + 0.3 * F.zoom);
    V.hammering(ax, t, {level: 0.05 * (1 - 0.6 * dist), pan: rand(-0.9, 0.9), dist, strikes: randInt(3, 6), axe: true});
  });
  const dogStream = h.stream((t) => V.bark(ax, t, {level: 0.03, pan: rand(-0.9, 0.9), dist: clamp01(rand(0.55, 1) + 0.3 * F.zoom)}));
  const bellStream = h.stream((t) => V.tinkle(ax, t, {level: 0.012, pan: rand(-0.9, 0.9), dist: clamp01(rand(0.5, 1) + 0.3 * F.zoom)}));
  const hoofStream = h.stream((t) => V.hooves(ax, t, {level: 0.03, dist: clamp01(rand(0.35, 0.85) + 0.3 * F.zoom), seconds: rand(4, 7)}));

  // ------------------------------------------------------------ the scene
  const DEFAULT_LISTENER = {x: -20, z: 4, distance: 110, rightX: 1, rightZ: 0};

  function factors(e) {
    const yearT = num(e.yearT, ((num(e.season, 0) + 0.5) / 4) % 1);
    const night = clamp01(num(e.night, 0));
    const phase = num(e.phase, night > 0.5 ? 0 : 0.5);
    const L = e.listener && Number.isFinite(e.listener.x) ? e.listener : DEFAULT_LISTENER;
    const distance = num(L.distance, 110);
    const pop = Math.max(0, num(e.population, 0));
    const activity = clamp01((Math.log10(pop + 1) - 1) / 2.6);

    // How much town is around the listener: each centre spreads with its size.
    let townNear = null, townPan = 0;
    if (Array.isArray(e.centres) && e.centres.length) {
      townNear = 0;
      for (const c of e.centres) {
        if (!Number.isFinite(c?.x)) continue;
        const cp = Math.max(1, num(c.pop, pop / e.centres.length));
        const r = 18 + 2.4 * Math.sqrt(cp);
        const dx = c.x - L.x, dz = c.z - L.z, dc = Math.hypot(dx, dz);
        const near = 1 / (1 + (Math.max(0, dc - r * 0.4) / r) ** 2) * clamp01(Math.log10(cp + 1) / 3);
        if (near > townNear) {
          townNear = near;
          // Toward the centre when it is off to one side; centred inside it.
          townPan = dc > 1 ? 0.6 * (dx * num(L.rightX, 1) + dz * num(L.rightZ, 0)) / dc * smoothstep(r * 0.3, r * 1.2, dc) : 0;
        }
      }
    }
    const zoom = smoothstep(40, 380, distance);
    // From high up the whole town blends into one distant sound.
    const townHere = clamp01(townNear == null ? activity * 0.6 : townNear * (1 - 0.5 * zoom) + activity * 0.45 * zoom);
    const daylight = 1 - night;
    return {
      yearT, night, phase, daylight, L, distance, zoom, pop, activity, townHere, townPan,
      dawn: bump(phase, 0.19, 0.27, 0.38),
      dusk: bump(phase, 0.64, 0.75, 0.88),
      evening: clamp01(Math.max(bump(phase, 0.62, 0.8, 0.95), night)),
      warmth: curve(WARMTH, yearT),
      foliage: curve(FOLIAGE, yearT),
      spring: bump(yearT, -0.05, 0.1, 0.3),
      autumn: bump(yearT, 0.45, 0.62, 0.8),
      wind: clamp01(num(e.wind, 0.4)),
      rain: clamp01(num(e.rain, 0)),
      snow: clamp01(num(e.snow, 0)),
      era: num(e.era, 0),
      wild: 1 - 0.7 * townHere * activity,
      running: e.running !== false,
      festival: !!e.festival,
      building: Math.max(0, num(e.building, 0)),
      riverNear: 0,
    };
  }

  return {
    setWaterSources(list) {
      river.setSources(list);
    },

    // Dev only: hear one layer ('wind', 'leaves', 'rain', 'murmur', 'hum',
    // 'river', 'events') by itself; null restores the mix.
    solo(name) {
      solo = name ?? null;
      events.gain.value = !solo || solo === 'events' ? 1 : 0;
    },

    // env: {season, yearT, phase (0 midnight .. 0.5 noon), night 0..1, wind,
    // rain, snow, population, era, festival, building, running,
    // listener: {x, z, distance, rightX, rightZ}, centres: [{x, z, pop}]}
    update(e) {
      const t = ctx.currentTime;
      runWobbles(t);
      const f = factors(e);
      F = f;
      const {daylight, zoom, rain, snow, wild} = f;

      // Wind, with gusts.
      if (step(gust, t, 0.8 + (1 - f.wind))) gust.tc = rand(0.8, 3.5);
      const windBase = (0.018 + 0.055 * f.wind) * (1 + 1.1 * zoom) * (1 + 0.3 * snow + 0.2 * rain) * (1 - 0.25 * f.night);
      h.setBed(wind, windBase * (0.4 + 0.6 * gust.value), gust.tc);
      h.tune(wind, windLp.frequency, 260 + 520 * gust.value * (0.5 + 0.6 * f.wind) + 150 * zoom, gust.tc);

      // Leaves follow the gusts more strongly than the wind bed does.
      const leafy = f.foliage * (1 - 0.6 * snow) * (1 - 0.5 * zoom) * (1 - 0.5 * f.townHere * f.activity);
      h.setBed(leaves, 0.05 * leafy * (0.25 + f.wind) * gust.value ** 1.6, gust.tc * 0.7);
      h.tune(leaves, leafBp.frequency, (1900 + 700 * f.autumn) * (1 - 0.35 * snow), 2); // drier in autumn

      h.setBed(rainBed, 0.05 * rain ** 1.2, 2.5);

      // Snow muffles the valley; height softens the detail a little.
      h.glide(bus.air.frequency, 13000 * (1 - 0.55 * snow) * (1 - 0.2 * zoom), 2);


      // The river.
      f.riverNear = river.update(t, f.L, f);

      // Village life.
      step(townMood, t);
      const busy = f.townHere * f.activity ** 0.7 * townMood.value * (0.25 + 0.75 * daylight) * (f.running ? 1 : 0.55)
        * (1 + 0.5 * f.festival) * (1 - 0.35 * rain) * (1 - 0.3 * snow);
      h.setBed(murmur, 0.07 * busy, 2);
      h.tune(murmur, murmurPan.pan, f.townPan, 2);
      h.setBed(hum, 0.022 * smoothstep(0.55, 1, f.activity) * smoothstep(3, 5, f.era) * (0.3 + 0.7 * f.townHere) * (0.4 + 0.6 * daylight), 3);

      if (h.muted('events')) return;

      // Birds: dawn chorus, quieter afternoons, nothing at night.
      step(birdMood, t);
      f.birds = curve(BIRDSONG, f.yearT) * daylight ** 1.5 * (0.95 + 2 * f.dawn + 0.5 * f.dusk)
        * (1 - 0.85 * rain) * (1 - 0.4 * snow) * wild * birdMood.value;
      updateBirds(t, f);

      // Insects on warm evenings; a few in the summer day too.
      f.insects = f.warmth * (0.12 + 0.88 * f.evening) * (1 - rain) * (0.3 + 0.7 * wild);
      updateCrickets(t, f);

      const warmEve = smoothstep(0.2, 0.7, f.warmth) * (1 - 0.6 * f.autumn) * f.evening;
      frogStream(t, (1 / 7) * warmEve * (0.25 + 0.75 * river.presence) * (1 - 0.5 * rain) * wild);
      owlStream(t, (1 / 40) * smoothstep(0.55, 0.9, f.night) * (1.3 - 0.6 * f.warmth) * (1 - rain) * (0.4 + 0.6 * wild));
      beeStream(t, (1 / 35) * smoothstep(0.4, 0.8, f.warmth) * daylight * (1 - zoom) * (1 - rain) * wild);
      dripStream(t, 7 * rain * (1 - 0.6 * zoom));

      const work = f.running ? 1 : 0;
      hammerStream(t, work * daylight * Math.min(1, f.building / 3) * (1 / 9) * (0.4 + 0.6 * f.townHere));
      axeStream(t, work * daylight * (f.era <= 2 ? 1 : 0.3) * (1 / 40) * (0.6 + 0.8 * (f.autumn + (1 - f.warmth) * 0.5)) * Math.min(1, f.activity * 4));
      dogStream(t, (1 / 60) * smoothstep(0.05, 0.3, f.activity) * (0.5 + f.townHere) * (1 - 0.5 * f.night) * (1 - 0.6 * rain));
      bellStream(t, (1 / 30) * (f.era <= 2 ? 1 : 0.15) * daylight * (1 - f.townHere) * Math.min(1, f.activity * 3 + 0.2) * (1 - snow) * (1 - 0.7 * rain));
      hoofStream(t, work * (1 / 28) * (f.era >= 1 ? 1 : 0.3) * daylight * f.townHere * f.activity * townMood.value * (1 - 0.5 * rain));
    },
  };
}
