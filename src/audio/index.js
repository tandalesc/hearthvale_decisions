// Procedural WebAudio for Hearthvale. Nothing plays until the first user
// gesture. The context suspends while the tab is hidden.
import {createBus} from './bus.js';
import {createAmbience} from './ambience.js';
import * as ui from './ui-sounds.js';

export function createAudio(prefs) {
  const bus = createBus();
  let ambience = null, started = false;

  function levels() {
    if (!bus.ctx) return;
    const muted = prefs.get('muted');
    bus.ramp(bus.master.gain, muted ? 0 : Number(prefs.get('master') ?? 0.8), 0.3);
    bus.ramp(bus.ambience.gain, Number(prefs.get('ambience') ?? 0.6), 0.3);
    bus.ramp(bus.ui.gain, Number(prefs.get('ui') ?? 0.7), 0.1);
  }

  function start() {
    if (started) return;
    if (!bus.ensure()) return;
    started = true;
    try {
      ambience = createAmbience(bus);
    } catch (err) {
      console.warn('[hearthvale] ambience unavailable', err);
    }
    levels();
    bus.ctx.resume?.();
  }

  // The first pointer or key press unlocks audio (browser autoplay rules).
  const unlock = () => {
    start();
    removeEventListener('pointerdown', unlock, true);
    removeEventListener('keydown', unlock, true);
  };
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', unlock, true);

  document.addEventListener('visibilitychange', () => {
    if (!bus.ctx) return;
    if (document.hidden) bus.ctx.suspend?.();
    else bus.ctx.resume?.();
  });

  prefs.onChange((key) => {
    if (['muted', 'master', 'ambience', 'ui'].includes(key)) levels();
  });

  const ready = () => started && bus.ctx?.state === 'running' && !prefs.get('muted');

  return {
    play(name, arg) {
      if (!ready()) return;
      try {
        if (name === 'slide') ui.slide(bus);
        else if (name === 'chime') ui.chime(bus);
        else if (name === 'tick') ui.tick(bus);
        else if (name === 'bell') ui.bell(bus, arg);
        else if (name === 'fanfare') ui.fanfare(bus, arg);
      } catch { /* a missed sound is not worth an error */ }
    },
    update(env) {
      if (ready() && ambience) ambience.update(env);
    },
    get started() { return started; },
  };
}
