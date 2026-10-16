// Short event voices for the ambience: birds, crickets, frogs, an owl, a bee,
// water bubbles, rain drips and village life (mallets, axes, dogs, bells,
// hooves). Each voice is a handful of nodes that lives for a few seconds and
// disconnects itself when it ends. All tones are sines or band-limited
// through filters; nothing reaches far above 4 kHz.
//
// Every voice takes `ax` ({ctx, out, space, white, brown}), a start time, and
// options: level (peak gain), pan (−1..1) and dist (0 near .. 1 far). Distance
// darkens the sound and sends more of it into the valley echo.

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// [distance lowpass] → panner → out, with a send into the echo.
function outlet(ax, {pan = 0, dist = 0.5, space = 0.3, cutoff} = {}) {
  const {ctx} = ax;
  const nodes = [];
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  p.connect(ax.out);
  nodes.push(p);
  let head = p;
  const fc = Math.min(cutoff ?? 20000, 11000 * Math.pow(0.22, clamp(dist, 0, 1)));
  if (fc < 10000) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = fc;
    f.Q.value = 0.5;
    f.connect(head);
    head = f;
    nodes.push(f);
  }
  if (space > 0 && ax.space) {
    const s = ctx.createGain();
    s.gain.value = space * (0.25 + 0.75 * dist);
    head.connect(s);
    s.connect(ax.space);
    nodes.push(s);
  }
  return {input: head, nodes};
}

// Disconnect a voice's nodes once its last source has stopped.
function cleanup(src, nodes) {
  src.onended = () => {
    for (const n of nodes) n.disconnect();
  };
}

function gainNode(ctx, v = 0) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

// A note envelope on a gain param: attack, a slight sag, release to silence.
function note(param, s, dur, peak, attack = 0.01, rel = 0.03) {
  const a = Math.min(attack, dur * 0.3), r = Math.min(rel, dur * 0.4);
  param.setValueAtTime(0, s);
  param.linearRampToValueAtTime(peak, s + a);
  param.linearRampToValueAtTime(peak * 0.75, s + dur - r);
  param.linearRampToValueAtTime(0, s + dur);
}

// ------------------------------------------------------------------ birds

// A bird keeps one motif (a list of notes) and sings it with small changes
// each time, the way a real bird repeats its song from the same perch.
// Notes: {at, dur, f1, f2, amp}.
export const BIRD_KINDS = ['warbler', 'thrush', 'tit', 'sparrow', 'wren', 'dove', 'cuckoo'];

export function makeBird(kind) {
  const notes = [];
  let at = 0;
  const push = (dur, f1, f2, gap, amp = 1) => {
    notes.push({at, dur, f1, f2, amp});
    at += dur + gap;
  };
  if (kind === 'warbler') {
    const base = rand(2300, 3300);
    for (let i = 0, n = randInt(6, 10); i < n; i++) {
      const f = base * rand(0.85, 1.2);
      push(rand(0.04, 0.09), f, f * rand(0.82, 1.2), rand(0.015, 0.05), rand(0.6, 1));
    }
  } else if (kind === 'thrush') {
    // Fluty, lower phrases with slides; sometimes a quick twitter to finish.
    const base = rand(1500, 2400);
    for (let i = 0, n = randInt(3, 6); i < n; i++) {
      const f = base * rand(0.85, 1.25);
      push(rand(0.1, 0.26), f, f * rand(0.85, 1.18), rand(0.04, 0.12), rand(0.7, 1));
    }
    if (Math.random() < 0.5) for (let i = 0; i < 3; i++) push(0.035, base * 1.6, base * 1.45, 0.025, 0.5);
  } else if (kind === 'tit') {
    // "Tea-cher, tea-cher": a high and a lower note, repeated.
    const hi = rand(3200, 3700), lo = hi * rand(0.74, 0.82);
    for (let i = 0, n = randInt(3, 5); i < n; i++) {
      push(0.08, hi, hi * 0.98, 0.05, 0.9);
      push(0.1, lo, lo * 0.97, 0.1, 1);
    }
  } else if (kind === 'sparrow') {
    const base = rand(2500, 3300);
    for (let i = 0, n = randInt(3, 6); i < n; i++) {
      const f = base * rand(0.9, 1.1);
      push(rand(0.05, 0.08), f, f * 0.75, rand(0.08, 0.2), rand(0.7, 1));
    }
  } else if (kind === 'wren') {
    // Two lead-in notes then a fast falling trill.
    const top = rand(3300, 3900);
    push(0.06, top * 0.8, top * 0.85, 0.06);
    push(0.06, top * 0.9, top * 0.88, 0.05);
    const n = randInt(14, 22);
    for (let i = 0; i < n; i++) {
      const f = top * (1 - 0.22 * i / n);
      push(0.03, f, f * 0.93, 0.022, 0.8);
    }
  } else if (kind === 'dove') {
    // Wood pigeon: "coo-COO-coo, coo-coo", low and soft.
    const f = rand(430, 540);
    push(0.3, f * 0.97, f, 0.12, 0.7);
    push(0.5, f * 1.02, f * 0.96, 0.14, 1);
    push(0.28, f * 0.98, f * 0.94, 0.45, 0.75);
    push(0.3, f, f * 0.95, 0.1, 0.8);
    push(0.34, f * 0.99, f * 0.93, 0, 0.7);
  } else if (kind === 'cuckoo') {
    const f = rand(640, 720);
    for (let i = 0, n = randInt(3, 6); i < n; i++) {
      push(0.18, f, f * 0.98, 0.08, 1);
      push(0.3, f * 0.81, f * 0.79, rand(0.42, 0.55), 0.85);
    }
  }
  return {kind, notes, length: at};
}

let harmonicWave = null;
function hollow(ctx) {
  if (!harmonicWave || harmonicWave.ctx !== ctx) {
    harmonicWave = {ctx, wave: ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.12, 0.03]))};
  }
  return harmonicWave.wave;
}

// Sing a bird's motif with small variations: pitch, tempo, a dropped ending.
export function birdSong(ax, t, bird, {level = 0.05, pan = 0, dist = 0.5} = {}) {
  const {ctx} = ax;
  const out = outlet(ax, {pan, dist, space: 0.35});
  const o = ctx.createOscillator();
  const low = bird.kind === 'dove' || bird.kind === 'cuckoo';
  if (low) o.setPeriodicWave(hollow(ctx));
  const g = gainNode(ctx);
  o.connect(g).connect(out.input);
  const pitch = rand(0.97, 1.03), tempo = rand(0.92, 1.08);
  const keep = Math.random() < 0.25 ? Math.max(1, Math.ceil(bird.notes.length * rand(0.5, 0.9))) : bird.notes.length;
  const attack = low ? 0.06 : 0.01;
  const rel = low ? 0.08 : 0.025;
  let end = t;
  for (let i = 0; i < keep; i++) {
    const n = bird.notes[i];
    const s = t + n.at * tempo, d = n.dur * tempo;
    o.frequency.setValueAtTime(n.f1 * pitch, s);
    o.frequency.exponentialRampToValueAtTime(n.f2 * pitch, s + d);
    note(g.gain, s, d, level * n.amp * rand(0.85, 1), attack, rel);
    end = s + d;
  }
  o.start(t);
  o.stop(end + 0.05);
  cleanup(o, [g, ...out.nodes]);
  return end - t;
}

// Tawny owl: a long "hoo", a pause, then "hu-hu-hoooo" with a quaver.
export function owl(ax, t, {level = 0.04, pan = 0, dist = 0.6} = {}) {
  const {ctx} = ax;
  const out = outlet(ax, {pan, dist, space: 0.6});
  const o = ctx.createOscillator();
  o.setPeriodicWave(hollow(ctx));
  const vib = ctx.createOscillator();
  vib.frequency.value = rand(6, 8);
  const vibDepth = gainNode(ctx, 0);
  vib.connect(vibDepth).connect(o.frequency);
  const g = gainNode(ctx);
  o.connect(g).connect(out.input);
  const f = rand(360, 420);
  o.frequency.setValueAtTime(f * 0.96, t);
  o.frequency.linearRampToValueAtTime(f * 1.02, t + 0.2);
  o.frequency.linearRampToValueAtTime(f * 0.92, t + 0.6);
  note(g.gain, t, 0.6, level, 0.08, 0.15);
  let s = t + rand(2.2, 3.4);
  const tail = Math.random() < 0.8;
  if (tail) {
    for (const d of [0.1, 0.14]) {
      o.frequency.setValueAtTime(f * 0.95, s);
      note(g.gain, s, d, level * 0.6, 0.03, 0.04);
      s += d + 0.18;
    }
    o.frequency.setValueAtTime(f, s);
    o.frequency.linearRampToValueAtTime(f * 0.94, s + 1.1);
    vibDepth.gain.setValueAtTime(f * 0.025, s + 0.25);
    note(g.gain, s, 1.1, level * 0.85, 0.06, 0.35);
    s += 1.1;
  }
  o.start(t);
  vib.start(t);
  o.stop(s + 0.05);
  vib.stop(s + 0.05);
  cleanup(o, [g, vibDepth, vib, ...out.nodes]);
}

// ---------------------------------------------------------------- insects

let cricketCache = null;
// One cricket chirp: three soft pulses of a pure 3.4 kHz tone (playback rate
// sets each cricket's pitch). Rendered once per context.
function cricketBuffer(ctx) {
  if (cricketCache?.ctx === ctx) return cricketCache.buffer;
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * 0.12);
  const buffer = ctx.createBuffer(1, len, rate);
  const d = buffer.getChannelData(0);
  const pulses = [0, 0.036, 0.072];
  for (const p0 of pulses) {
    const a = Math.floor(p0 * rate), n = Math.floor(0.024 * rate);
    for (let i = 0; i < n && a + i < len; i++) {
      const env = Math.sin(Math.PI * i / n) ** 2;
      d[a + i] = env * Math.sin(2 * Math.PI * 3400 * (a + i) / rate);
    }
  }
  cricketCache = {ctx, buffer};
  return buffer;
}

export function cricket(ax, t, {level = 0.015, pan = 0, dist = 0.5, pitch = 1} = {}) {
  const {ctx} = ax;
  const out = outlet(ax, {pan, dist, space: 0.15});
  const src = ctx.createBufferSource();
  src.buffer = cricketBuffer(ctx);
  src.playbackRate.value = pitch;
  const g = gainNode(ctx, level);
  src.connect(g).connect(out.input);
  src.start(t);
  cleanup(src, [g, ...out.nodes]);
}

// A bumblebee drifting past: a buzzing sawtooth, darkened, with a little
// Doppler and a pan sweep.
export function bee(ax, t, {level = 0.012, seconds = 3} = {}) {
  const {ctx} = ax;
  const from = rand(-0.9, 0.9), to = clamp(-from + rand(-0.3, 0.3), -0.9, 0.9);
  const out = outlet(ax, {pan: from, dist: 0.2, space: 0, cutoff: 700});
  const panner = out.nodes[0];
  panner.pan.setValueAtTime(from, t);
  panner.pan.linearRampToValueAtTime(to, t + seconds);
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  const f = rand(180, 230);
  o.frequency.setValueAtTime(f * 1.04, t);
  o.frequency.linearRampToValueAtTime(f * 0.96, t + seconds);
  const vib = ctx.createOscillator();
  vib.frequency.value = rand(5, 9);
  const vd = gainNode(ctx, f * 0.03);
  vib.connect(vd).connect(o.frequency);
  const g = gainNode(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + seconds * 0.5);
  g.gain.linearRampToValueAtTime(0, t + seconds);
  o.connect(g).connect(out.input);
  o.start(t);
  vib.start(t);
  o.stop(t + seconds + 0.05);
  vib.stop(t + seconds + 0.05);
  cleanup(o, [g, vd, vib, ...out.nodes]);
}

// ---------------------------------------------------------------- water

// One bubble: a sine whose pitch rises as it decays (the Minnaert chirp).
export function bubble(ax, t, {level = 0.01, pan = 0, f = 600} = {}) {
  if (!(level > 1e-5)) return;
  const {ctx} = ax;
  const dur = clamp(18 / f, 0.018, 0.06);
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * rand(1.4, 2.1), t + dur);
  const g = gainNode(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.003);
  g.gain.exponentialRampToValueAtTime(level * 0.01, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.005);
  o.connect(g).connect(p).connect(ax.out);
  o.start(t);
  o.stop(t + dur + 0.01);
  cleanup(o, [g, p]);
}

// A rain drop on a leaf or a puddle: a tiny, high, soft plink.
export function drip(ax, t, {level = 0.006, pan = 0} = {}) {
  bubble(ax, t, {level, pan, f: rand(1300, 2600)});
}

// A frog: a few croaks, each a buzz of 30-ish pulses through a formant.
export function frog(ax, t, {level = 0.02, pan = 0, dist = 0.5, f = 200} = {}) {
  const {ctx} = ax;
  const out = outlet(ax, {pan, dist, space: 0.4});
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = f;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = f * rand(3.2, 4.5);
  bp.Q.value = 2.5;
  const g = gainNode(ctx);
  o.connect(bp).connect(g).connect(out.input);
  let s = t;
  const rateHz = rand(26, 38), period = 1 / rateHz;
  for (let c = 0, croaks = randInt(1, 3); c < croaks; c++) {
    const pulses = Math.round(rand(0.16, 0.3) * rateHz);
    for (let i = 0; i < pulses; i++) {
      const p = s + i * period;
      g.gain.setValueAtTime(0, p);
      g.gain.linearRampToValueAtTime(level * (0.6 + 0.4 * Math.sin(Math.PI * i / pulses)), p + 0.004);
      g.gain.linearRampToValueAtTime(0, p + period * 0.8);
    }
    s += pulses * period + rand(0.3, 0.6);
  }
  o.start(t);
  o.stop(s);
  cleanup(o, [bp, g, ...out.nodes]);
}

// ---------------------------------------------------------- village life

// A noise burst through a resonant band plus a low thump: a mallet on
// timber (f ≈ 900), an axe in a log (f ≈ 500, longer), a hoof on stone.
function knockInto(ax, input, s, {level, f = 900, q = 3, decay = 0.06, thump = 140, thumpLevel = 0.7}) {
  if (!(level > 1e-5)) return;
  const {ctx} = ax;
  const src = ctx.createBufferSource();
  src.buffer = ax.white;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = f * rand(0.92, 1.08);
  bp.Q.value = q;
  const g = gainNode(ctx);
  g.gain.setValueAtTime(0, s);
  g.gain.linearRampToValueAtTime(level, s + 0.002);
  g.gain.exponentialRampToValueAtTime(level * 0.01, s + decay);
  g.gain.linearRampToValueAtTime(0, s + decay + 0.005);
  src.connect(bp).connect(g).connect(input);
  src.start(s, Math.random() * 3);
  src.stop(s + decay + 0.01);
  const nodes = [bp, g];
  if (thump > 0) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(thump * 1.3, s);
    o.frequency.exponentialRampToValueAtTime(thump, s + 0.03);
    const tg = gainNode(ctx);
    tg.gain.setValueAtTime(0, s);
    tg.gain.linearRampToValueAtTime(level * thumpLevel, s + 0.003);
    tg.gain.exponentialRampToValueAtTime(level * 0.01, s + decay * 1.4);
    tg.gain.linearRampToValueAtTime(0, s + decay * 1.4 + 0.005);
    o.connect(tg).connect(input);
    o.start(s);
    o.stop(s + decay * 1.4 + 0.01);
    cleanup(o, [tg]);
  }
  cleanup(src, nodes);
}

// A carpenter at work: a run of mallet strikes, unevenly spaced.
export function hammering(ax, t, {level = 0.04, pan = 0, dist = 0.6, strikes = 5, axe = false} = {}) {
  const out = outlet(ax, {pan, dist, space: 0.5});
  let s = t;
  for (let i = 0; i < strikes; i++) {
    const lv = level * rand(0.7, 1);
    if (axe) knockInto(ax, out.input, s, {level: lv, f: rand(420, 560), q: 2, decay: 0.12, thump: 95, thumpLevel: 0.9});
    else knockInto(ax, out.input, s, {level: lv, f: rand(850, 1250), q: 3.5, decay: 0.06, thump: 150});
    s += axe ? rand(1.3, 2.2) : rand(0.42, 0.78);
  }
  // A silent source keeps the outlet until the last strike has rung out.
  const keep = ax.ctx.createConstantSource();
  keep.offset.value = 0;
  keep.connect(out.input);
  keep.start(t);
  keep.stop(s + 0.5);
  cleanup(keep, out.nodes);
  return s - t;
}

// A dog somewhere in the village: one to three barks.
export function bark(ax, t, {level = 0.03, pan = 0, dist = 0.7} = {}) {
  const {ctx} = ax;
  const out = outlet(ax, {pan, dist, space: 0.6, cutoff: 2000});
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = rand(750, 1000);
  bp.Q.value = 1.1;
  const g = gainNode(ctx);
  o.connect(bp).connect(g).connect(out.input);
  const f = rand(260, 380);
  let s = t;
  for (let i = 0, n = randInt(1, 3); i < n; i++) {
    o.frequency.setValueAtTime(f * 1.05, s);
    o.frequency.linearRampToValueAtTime(f * 1.3, s + 0.03);
    o.frequency.exponentialRampToValueAtTime(f * 0.78, s + 0.15);
    note(g.gain, s, 0.16, level * rand(0.8, 1), 0.008, 0.06);
    s += rand(0.28, 0.5);
  }
  o.start(t);
  o.stop(s);
  cleanup(o, [bp, g, ...out.nodes]);
}

// A bell on a grazing animal: a few soft, inharmonic tinkles.
export function tinkle(ax, t, {level = 0.012, pan = 0, dist = 0.7} = {}) {
  const {ctx} = ax;
  const out = outlet(ax, {pan, dist, space: 0.4});
  const f = rand(560, 760);
  const partials = [[1, 1, 0.7], [2.76, 0.45, 0.4], [5.1, 0.18, 0.2]];
  const hits = [];
  let s = t;
  for (let i = 0, n = randInt(2, 5); i < n; i++) {
    hits.push([s, rand(0.5, 1)]);
    s += rand(0.25, 0.8);
  }
  const end = s + 0.8;
  const nodes = [];
  let first = null;
  for (const [mult, amp, decay] of partials) {
    const o = ctx.createOscillator();
    o.frequency.value = f * mult;
    const g = gainNode(ctx);
    for (const [h, a] of hits) {
      g.gain.setValueAtTime(0, h);
      g.gain.linearRampToValueAtTime(level * amp * a, h + 0.003);
      g.gain.setTargetAtTime(0, h + 0.003, decay / 4);
    }
    o.connect(g).connect(out.input);
    o.start(t);
    o.stop(end);
    nodes.push(g);
    first ??= o;
  }
  cleanup(first, [...nodes, ...out.nodes]);
}

// A horse and cart passing along a street: hoof clops that swell and fade
// while the sound drifts across, over a soft wheel rumble.
export function hooves(ax, t, {level = 0.02, dist = 0.6, seconds = 5} = {}) {
  const {ctx} = ax;
  const from = rand(-0.8, 0.8), to = clamp(-from * rand(0.5, 1), -0.8, 0.8);
  const out = outlet(ax, {pan: from, dist, space: 0.3});
  out.nodes[0].pan.setValueAtTime(from, t);
  out.nodes[0].pan.linearRampToValueAtTime(to, t + seconds);
  const step = rand(0.24, 0.3);
  for (let s = t, i = 0; s < t + seconds; i++) {
    const x = (s - t) / seconds;
    const swell = Math.sin(Math.PI * x);
    knockInto(ax, out.input, s, {level: level * swell * (i % 2 ? 0.7 : 1), f: rand(1100, 1500), q: 2.5, decay: 0.035, thump: 0});
    s += step * (i % 2 ? 1.25 : 0.75) * rand(0.95, 1.05);
  }
  const rumble = ctx.createBufferSource();
  rumble.buffer = ax.brown;
  rumble.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 220;
  const g = gainNode(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level * 0.5, t + seconds / 2);
  g.gain.linearRampToValueAtTime(0, t + seconds);
  rumble.connect(lp).connect(g).connect(out.input);
  rumble.start(t, Math.random() * 5);
  rumble.stop(t + seconds + 0.6);
  cleanup(rumble, [lp, g, ...out.nodes]);
}
