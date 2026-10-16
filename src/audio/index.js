// Procedural WebAudio for Hearthvale. Nothing plays until the first user
// gesture. The context suspends while the tab is hidden.
import {createBus} from './bus.js';
import {createAmbience} from './ambience.js';
import * as ui from './ui-sounds.js';

// Seconds for the ambience to fade in when sound first starts.
const FADE_IN = 4;

export function createAudio(prefs) {
  const bus = createBus();
  let ambience = null, started = false, waterSources = null, warned = false;

  function levels(fade = 0.3) {
    if (!bus.ctx) return;
    const muted = prefs.get('muted');
    bus.ramp(bus.master.gain, muted ? 0 : Number(prefs.get('master') ?? 0.8), 0.3);
    bus.ramp(bus.ambience.gain, Number(prefs.get('ambience') ?? 0.6), fade);
    bus.ramp(bus.ui.gain, Number(prefs.get('ui') ?? 0.7), 0.1);
  }

  function start() {
    if (started) return;
    if (!bus.ensure()) return;
    started = true;
    try {
      ambience = createAmbience(bus);
      if (waterSources) ambience.setWaterSources(waterSources);
    } catch (err) {
      console.warn('[hearthvale] ambience unavailable', err);
    }
    levels(FADE_IN);
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
    // env: see ambience.js. With `world` (the renderer) it also reads the
    // camera (listener), the grade's time of day, and the eased weather.
    update(env) {
      if (!ready() || !ambience) return;
      try {
        ambience.update(env.world ? withWorld(env, env.world) : env);
      } catch (err) {
        // The ambience must never break the frame; say so once.
        if (!warned) console.warn('[hearthvale] ambience update failed', err);
        warned = true;
      }
    },
    // Optional hook for louder water (rapids, weirs, mill races): a list of
    // {x, z, intensity 0..1, radius}. Replaces the previous list.
    setWaterSources(list) {
      waterSources = list;
      ambience?.setWaterSources(list);
    },
    get started() { return started; },
  };
}

const listener = {x: 0, z: 0, distance: 110, rightX: 1, rightZ: 0};

// Fill in what the renderer knows: where the camera looks and from how far,
// its right-hand direction (for panning), the time of day (phase, night) and
// the eased rain and snow. Everything falls back to what env already has.
function withWorld(env, world) {
  const e = {...env};
  const rig = world.camera;
  const target = rig?.controls?.target, cam = rig?.camera?.position;
  if (target && cam) {
    const fx = target.x - cam.x, fz = target.z - cam.z;
    const len = Math.hypot(fx, fz) || 1;
    listener.x = target.x;
    listener.z = target.z;
    listener.distance = Math.hypot(fx, target.y - cam.y, fz);
    // right = forward × up
    listener.rightX = -fz / len;
    listener.rightZ = fx / len;
    e.listener = listener;
  }
  const grade = world.internals?.grade;
  if (grade) {
    if (Number.isFinite(grade.current?.night)) e.night = grade.current.night;
    if (Number.isFinite(grade.current?.phase)) e.phase = grade.current.phase;
    if (Number.isFinite(grade.weather?.rain)) e.rain = grade.weather.rain;
    if (Number.isFinite(grade.weather?.snow)) e.snow = grade.weather.snow;
  }
  delete e.world;
  return e;
}
