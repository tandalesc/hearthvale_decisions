// Ambience (design-visual §9): wind, river, birds by day, crickets by night,
// market bustle with population, and hammer ticks while building. A handful
// of long-lived nodes; gains follow the town through setTargetAtTime.

export function createAmbience(bus) {
  const {ctx} = bus;
  const out = bus.ambience;

  // Wind: white noise → lowpass 400 Hz with a slow cutoff LFO and gain LFO.
  const wind = loop(bus.white);
  const windLp = ctx.createBiquadFilter();
  windLp.type = 'lowpass';
  windLp.frequency.value = 400;
  const windLfo = lfo(0.07, 150, windLp.frequency);
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  const windSwell = ctx.createGain();
  windSwell.gain.value = 1;
  lfo(0.05, 0.3, windSwell.gain);
  wind.connect(windLp).connect(windSwell).connect(windGain).connect(out);

  // River: noise → bandpass 900 Hz (Q 0.7) plus a quieter 2.4 kHz band.
  const river = loop(bus.white);
  const rb1 = band(900, 0.7);
  const rb2 = band(2400, 0.7);
  const rb2Gain = ctx.createGain();
  rb2Gain.gain.value = 0.32;
  const riverGain = ctx.createGain();
  riverGain.gain.value = 0;
  river.connect(rb1).connect(riverGain);
  river.connect(rb2).connect(rb2Gain).connect(riverGain);
  riverGain.connect(out);

  // Crickets: square 4.3 kHz through a bandpass, gated at 28 Hz.
  const cricket = ctx.createOscillator();
  cricket.type = 'square';
  cricket.frequency.value = 4300;
  const cb = band(4300, 8);
  const gate = ctx.createGain();
  gate.gain.value = 0.5;
  lfo(28, 0.5, gate.gain, 'square');
  const cricketGain = ctx.createGain();
  cricketGain.gain.value = 0;
  cricket.connect(cb).connect(gate).connect(cricketGain).connect(out);
  cricket.start();

  // Market bustle: brown noise through lowpass 250 Hz and bandpass 1.1 kHz.
  const market = loop(bus.brown);
  const mlp = ctx.createBiquadFilter();
  mlp.type = 'lowpass';
  mlp.frequency.value = 250;
  const mbp = band(1100, 1.2);
  const marketGain = ctx.createGain();
  marketGain.gain.value = 0;
  market.connect(mlp).connect(marketGain);
  market.connect(mbp).connect(marketGain);
  marketGain.connect(out);

  let nextBird = ctx.currentTime + 2, nextHammer = 0;

  function loop(buffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(0, Math.random() * buffer.duration);
    return src;
  }

  function band(freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  function lfo(rate, depth, param, type = 'sine') {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(param);
    o.start();
    return o;
  }

  function chirp(t) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    const base = 2800 + Math.random() * 1400;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const repeats = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < repeats; i++) {
      const s = t + i * 0.11;
      o.frequency.setValueAtTime(base, s);
      o.frequency.linearRampToValueAtTime(base - 400, s + 0.06);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.05, s + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.085);
    }
    o.connect(g);
    (pan ? g.connect(pan) : g).connect(out);
    o.start(t);
    o.stop(t + repeats * 0.11 + 0.1);
  }

  function hammer(t) {
    const src = ctx.createBufferSource();
    src.buffer = bus.white;
    const f = band(1800, 2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + 0.1);
  }

  const smooth = (x) => Math.max(0, Math.min(1, x));
  const smoothstep = (a, b, x) => { const t = smooth((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  return {
    // env: {season 0..3, night 0..1, wind 0..1, population, festival, building, running}
    update(e) {
      const t = ctx.currentTime;
      const night = smooth(e.night ?? 0);
      bus.ramp(windGain.gain, 0.05 + 0.18 * smooth(e.wind ?? 0.3), 1.2);
      bus.ramp(riverGain.gain, 0.09, 1.2);
      bus.ramp(cricketGain.gain, (e.season === 1 || e.season === 2 ? 0.035 : 0.012) * night, 1.5);
      const bustle = smoothstep(20, 400, e.population ?? 0) * 0.25 + (e.festival ? 0.2 : 0);
      bus.ramp(marketGain.gain, bustle * (1 - night * 0.7) * (e.running ? 1 : 0.5), 1);
      const density = [1.5, 1, 0.7, 0.3][e.season ?? 0] * (1 - night);
      if (t >= nextBird) {
        if (density > 0.05 && Math.random() < density) chirp(t + 0.05);
        nextBird = t + 3 + Math.random() * 6;
      }
      if (e.building > 0 && e.running && t >= nextHammer) {
        hammer(t + 0.02);
        if (e.building > 1) hammer(t + 0.35);
        nextHammer = t + 2;
      }
    },
  };
}
