// One AudioContext, created on the first user gesture. There are no audio
// files: every sound is synthesised from a few shared noise buffers.
//
//   ambience ─ tone (highpass 55 Hz, "air" lowpass) ─┐
//   space (echo send) ───┤
//   ui ──────────────────┴─ master ─ peak compressor ─ out
//
// `space` is a cheap valley echo: a darkened ping-pong delay (two DelayNodes,
// one lowpass), far cheaper than a ConvolverNode. Distant event voices send
// a little into it so they sit back in the landscape.

export function createBus() {
  let ctx = null;
  const bus = {ctx: null, master: null, ambience: null, ui: null, space: null, air: null, white: null, pink: null, brown: null};

  // A seamless loop: render seconds + a fade's worth of samples and fold the
  // overhang over the start with an equal-power crossfade, so the last sample
  // runs straight into the first. Normalised to a known RMS so layer gains
  // mean the same thing for every kind.
  function loopBuffer(seconds, rate, gen, rms) {
    const length = Math.floor(rate * seconds);
    const fade = Math.floor(rate * Math.min(0.25, seconds / 8));
    const raw = new Float32Array(length + fade);
    for (let i = 0; i < raw.length; i++) raw[i] = gen();
    const buffer = ctx.createBuffer(1, length, rate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) d[i] = raw[i];
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = raw[i] * Math.sqrt(t) + raw[length + i] * Math.sqrt(1 - t);
    }
    let sum = 0;
    for (let i = 0; i < length; i++) sum += d[i] * d[i];
    const k = rms / Math.sqrt(sum / length || 1);
    for (let i = 0; i < length; i++) d[i] *= k;
    return buffer;
  }

  const white = () => Math.random() * 2 - 1;

  // Pink (−3 dB/octave): Paul Kellet's filter.
  function pinkGen() {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    return () => {
      const w = white();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      return out;
    };
  }

  // Brown (−6 dB/octave above ~150 Hz): a leaky integrator.
  function brownGen() {
    let last = 0;
    return () => (last = (last + 0.02 * white()) / 1.02);
  }

  bus.ensure = () => {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    // iOS Safari treats WebAudio as "ambient" audio: silenced by the mute
    // switch and other apps' audio. Declare playback so the town is heard.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older Safari */ }
    ctx = new AC({latencyHint: 'playback'});
    const rate = ctx.sampleRate;

    // Master: one soft-knee compressor that only acts on peaks (the
    // ambience sits well below it), so a loud moment never clips.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    bus.master = ctx.createGain();
    bus.master.gain.value = 0;
    bus.master.connect(comp).connect(ctx.destination);

    // Ambience tone: no rumble, softened highs, and an "air" lowpass that
    // snow and distance pull down.
    bus.ambience = ctx.createGain();
    bus.ambience.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 55;
    hp.Q.value = 0.7;
    bus.air = ctx.createBiquadFilter();
    bus.air.type = 'lowpass';
    bus.air.frequency.value = 13000;
    bus.air.Q.value = 0.5;
    try {
      bus.air.frequency.automationRate = 'k-rate';
    } catch { /* fine at a-rate */ }
    bus.ambience.connect(hp).connect(bus.air).connect(bus.master);

    // Valley echo, fed by the event voices; it returns into the ambience bus
    // so the user's ambience level covers it.
    bus.space = ctx.createGain();
    const dl = ctx.createDelay(1), dr = ctx.createDelay(1);
    dl.delayTime.value = 0.23;
    dr.delayTime.value = 0.31;
    // One lowpass in the loop darkens every repeat.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const merge = ctx.createChannelMerger(2);
    bus.space.connect(lp);
    dr.connect(lp);
    lp.connect(dl);
    dl.connect(fb).connect(dr);
    dl.connect(merge, 0, 0);
    dr.connect(merge, 0, 1);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    merge.connect(wet).connect(bus.ambience);

    bus.ui = ctx.createGain();
    bus.ui.connect(bus.master);

    // Loop lengths differ so layers sharing a kind never line up. White keeps
    // the RMS of uniform noise (1/√3), which the UI sounds are tuned to.
    bus.white = loopBuffer(3.7, rate, white, 0.577);
    bus.pink = loopBuffer(9.3, rate, pinkGen(), 0.3);
    bus.brown = loopBuffer(7.9, rate, brownGen(), 0.3);
    bus.ctx = ctx;
    return ctx;
  };

  bus.ramp = (param, value, seconds = 0.4) => {
    if (!ctx) return;
    param.setTargetAtTime(value, ctx.currentTime, seconds / 3);
  };

  return bus;
}
