// Interface sounds (design-visual §9): paper slide, decision chime, tab tick,
// era fanfare, and the year-end bell. Each is a few short-lived nodes.

function env(ctx, gain, t, attack, peak, release) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
}

export function slide(bus) {
  const {ctx} = bus;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = bus.white;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1200;
  const g = ctx.createGain();
  env(ctx, g, t, 0.02, 0.09, 0.12);
  src.connect(hp).connect(g).connect(bus.ui);
  src.start(t, Math.random());
  src.stop(t + 0.16);
}

export function chime(bus) {
  const {ctx} = bus;
  const t = ctx.currentTime;
  [660, 880].forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    env(ctx, g, t + i * 0.09, 0.008, 0.2, 0.4);
    o.connect(g).connect(bus.ui);
    o.start(t + i * 0.09);
    o.stop(t + i * 0.09 + 0.45);
  });
}

export function tick(bus) {
  const {ctx} = bus;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = bus.white;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3200;
  const g = ctx.createGain();
  env(ctx, g, t, 0.0005, 0.12, 0.003);
  src.connect(bp).connect(g).connect(bus.ui);
  src.start(t);
  src.stop(t + 0.01);
}

// A bell: triangle at 440 Hz plus partials at 2.4× and 3.9×, 2.5 s decay.
export function bell(bus, count = 1, out = bus.ui) {
  const {ctx} = bus;
  for (let n = 0; n < Math.max(1, Math.min(6, count)); n++) {
    const t = ctx.currentTime + n * 1.1;
    [[1, 0.16], [2.4, 0.06], [3.9, 0.03]].forEach(([mult, peak]) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 440 * mult;
      const g = ctx.createGain();
      env(ctx, g, t, 0.004, peak, 2.5);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 2.6);
    });
  }
}

// Era fanfare: C4–G4–C5 stacked triangles, with a minor third on hard ages.
export function fanfare(bus, {hard = false} = {}) {
  const {ctx} = bus;
  const t = ctx.currentTime;
  const notes = [261.63, 392, 523.25];
  if (hard) notes.push(311.13);
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    const start = t + i * 0.16;
    env(ctx, g, start, 0.02, 0.09, 1.6 - i * 0.16);
    o.connect(g).connect(bus.ui);
    o.start(start);
    o.stop(start + 1.7);
  });
  bell(bus, 1);
}
