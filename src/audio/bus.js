// One AudioContext, created on the first user gesture. Master gain feeds a
// compressor (−18 dB, ratio 3). Two buses: ambience and ui. Shared noise
// buffers are generated once; there are no audio files.

export function createBus() {
  let ctx = null;
  const bus = {ctx: null, master: null, ambience: null, ui: null, white: null, brown: null};

  function noise(seconds, brown) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else data[i] = white;
    }
    // Cross-fade the loop seam so it never clicks.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[length - fade + i] = data[length - fade + i] * (1 - t) + data[i] * t;
    }
    return buffer;
  }

  bus.ensure = () => {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({latencyHint: 'playback'});
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    bus.master = ctx.createGain();
    bus.master.gain.value = 0;
    bus.master.connect(comp);
    comp.connect(ctx.destination);
    bus.ambience = ctx.createGain();
    bus.ui = ctx.createGain();
    bus.ambience.connect(bus.master);
    bus.ui.connect(bus.master);
    bus.white = noise(2, false);
    bus.brown = noise(4, true);
    bus.ctx = ctx;
    return ctx;
  };

  bus.ramp = (param, value, seconds = 0.4) => {
    if (!ctx) return;
    param.setTargetAtTime(value, ctx.currentTime, seconds / 3);
  };

  return bus;
}
