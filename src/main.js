// Hearthvale bootstrap (contract §7). Wires state, the sim step, the
// decision client, the route planner, the renderer and the UI, then runs
// the frame loop. Dev URL params:
//   ?fixture=hamlet|town|city   load a fixture town (no autosave unless &save=1)
//   ?play=1                     skip the main menu: continue the last town, or start one
//   ?paused=1                   start paused
//   ?stub=1 / ?renderer=stub    force the development stubs
import {createDecisionClient} from './decision-client.js';
import {loadNarrator, loadRenderer, loadSim} from './ui/bridge.js';
import {createApp} from './ui/app.js';
import {createPrefs} from './ui/prefs.js';
import {createAudio} from './audio/index.js';
import {rapidsSources} from './river.js';
import {createSaveStore, metaFromSave, newSlotId} from './save-store.js';
import {suggestName} from './ui/menu/names.js';
import {version} from '../package.json';

const SAVE_KEY = 'hearthvale-save';
// Town saves go to IndexedDB (gzip), one slot per town; SAVE_KEY is only the legacy localStorage key.
const saves = createSaveStore({legacyKey: SAVE_KEY});
const MODEL_KEY = 'hearthvale-model-enabled';
const DECISION_KEY = 'hearthvale-decision-settings';
// What to do after a deliberate reload (a new town, an import, the menu's New
// town screen), so the page skips the main menu and does it.
const BOOT_KEY = 'hearthvale-boot';
const AUTOSAVE_MS = 30000;
const THUMB_W = 1280;
// Main-thread time the sim may take per drawn frame. Past it, no new tick
// starts this frame; at a speed the device cannot keep up with, the town runs
// slower (shown as the speed it really reaches) rather than stuttering.
const SIM_BUDGET_MS = 10;
const TICK_SECONDS = 0.1;

const params = new URLSearchParams(location.search);
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', '<p style="position:fixed;inset:auto 16px 16px;padding:12px 16px;border-radius:12px;background:#fafbf2;color:#2f3f2f;font:15px system-ui">Hearthvale could not start. Reload the page to try again.</p>');
});

function takeIntent() {
  try {
    const raw = sessionStorage.getItem(BOOT_KEY);
    sessionStorage.removeItem(BOOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setIntent(intent) {
  try { sessionStorage.setItem(BOOT_KEY, JSON.stringify(intent)); } catch { /* storage blocked: the menu shows instead */ }
}

async function boot() {
  // The sim and the renderer load while the player looks at the menu.
  const loading = Promise.all([loadSim(params), loadRenderer(params)]);
  const prefs = createPrefs();

  // ---------- the main menu ----------
  const fixture = params.get('fixture');
  const persist = !fixture || params.get('save') === '1';
  const intent = takeIntent();
  let menu = null;
  if (!fixture && (intent?.kind === 'menu' || (!intent && params.get('play') !== '1'))) {
    try {
      const {createMainMenu} = await import('./ui/menu/menu.js');
      menu = createMainMenu({saves, prefs, version, start: intent?.screen});
    } catch (err) {
      console.error('[hearthvale] the main menu failed; continuing the last town', err);
    }
  }

  // Builds the town a choice asks for. Throws with a line for the player.
  async function openChoice(sim, choice) {
    if (choice.kind === 'new') {
      const s = sim.createState(choice.seed ?? undefined, {
        archetype: choice.archetype ?? undefined,
        terrainVersion: choice.terrainVersion ?? undefined,
        ...(choice.individualCap ? {settings: {individualCap: choice.individualCap}} : {}),
      });
      s.townName = choice.name || suggestName(choice.archetype);
      return {state: s, slot: newSlotId()};
    }
    const raw = choice.kind === 'import' ? choice.raw : await saves.load(choice.id);
    if (!raw) throw new Error('That town is no longer on this device.');
    let s;
    try {
      s = sim.restore(raw);
    } catch (err) {
      throw new Error(err?.code === 'old-version'
        ? 'That town was made with an earlier version of Hearthvale and cannot be opened.'
        : 'That town could not be opened. The save may be damaged.');
    }
    if (choice.kind === 'import') {
      const slot = newSlotId();
      await saves.save(slot, raw, metaFromSave(raw));
      return {state: s, slot};
    }
    return {state: s, slot: choice.id};
  }

  let notice = null;
  let state = null;
  let slotId = null;
  let sim, renderer;
  if (menu) {
    for (;;) {
      const choice = await menu.choose();
      const name = choice.kind === 'new' ? choice.name : choice.name ?? (await saves.list()).find((t) => t.id === choice.id)?.name;
      menu.busy(choice.kind === 'new' ? `Founding ${name}…` : `Opening ${name || 'your town'}…`);
      [sim, renderer] = await loading;
      try {
        ({state, slot: slotId} = await openChoice(sim, choice));
        break;
      } catch (err) {
        console.warn('[hearthvale] could not open the town', err);
        await menu.fail(err.message);
      }
    }
  } else {
    [sim, renderer] = await loading;
    if (fixture) {
      try {
        state = sim.loadFixture ? await sim.loadFixture(fixture) : sim.fixtureState?.(fixture);
      } catch (err) {
        console.warn('[hearthvale] fixture failed to load', err);
      }
    }
    if (!state && intent?.kind === 'load') {
      try {
        ({state, slot: slotId} = await openChoice(sim, intent));
      } catch (err) {
        notice = err.message;
      }
    }
    if (!state && intent?.kind !== 'new') {
      const latest = await saves.latest();
      if (latest) {
        try {
          ({state, slot: slotId} = await openChoice(sim, {kind: 'load', id: latest.id}));
        } catch {
          notice = 'Your old town was made with an earlier version. A new town begins.';
          await saves.remove(latest.id);
        }
      }
    }
    if (!state) {
      // "Start a new town from seed…" in Settings leaves the seed in the intent.
      ({state, slot: slotId} = await openChoice(sim, {kind: 'new', seed: intent?.seed ?? null}));
    }
    if (fixture && persist && !slotId) slotId = newSlotId();
  }
  const narrator = await loadNarrator(sim.kind);
  const audio = createAudio(prefs);
  // The town's terrain seed is set now: riffles and cascades get their own water sound.
  audio.setWaterSources(rapidsSources());

  // ---------- decisions ----------
  let modelEnabled = store.get(MODEL_KEY) !== 'false';
  let decisionSettings = {mode: 'auto', cap: 100};
  try {
    const saved = JSON.parse(store.get(DECISION_KEY));
    if (saved?.mode === 'auto' || saved?.mode === 'manual') {
      decisionSettings = {mode: saved.mode, cap: Number.isFinite(saved.cap) ? Math.max(1, Math.min(5000, Math.round(saved.cap))) : 100};
    }
  } catch { /* defaults */ }
  const client = createDecisionClient({now: () => performance.now()});
  client.configure(decisionSettings);
  // With the model off every ask resolves to null, so actors use local rules.
  const decisions = new Proxy(client, {
    get(target, key) {
      if (key === 'ask' && !modelEnabled) return () => Promise.resolve(null);
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  // ---------- routes ----------
  let routes = null;
  try {
    const {createRoutePlanner} = await import('./route-planner.js');
    routes = createRoutePlanner();
  } catch (err) {
    console.warn('[hearthvale] route planner unavailable', err);
  }

  // ---------- renderer ----------
  const makeCanvas = () => {
    document.getElementById('world')?.remove();
    const canvas = document.createElement('canvas');
    canvas.id = 'world';
    canvas.setAttribute('aria-label', 'The town of Hearthvale');
    document.body.prepend(canvas);
    return canvas;
  };
  let world;
  try {
    world = renderer.createWorld(makeCanvas(), {quality: prefs.get('quality'), batterySaver: prefs.get('batterySaver')});
  } catch (err) {
    // A canvas keeps its first context type, so the fallback gets a new one.
    console.error('[hearthvale] renderer failed; using the simple map', err);
    const {createWorld} = await import('./ui/dev/stub-world.js');
    world = createWorld(makeCanvas(), {quality: prefs.get('quality'), batterySaver: prefs.get('batterySaver')});
    renderer.kind = 'stub-fallback';
  }
  // The in-game Motion setting also calms the 3D world (weather, birds, sway).
  const applyWorldMotion = () => world?.setReducedMotion?.(prefs.get('motion') === 'reduced');
  applyWorldMotion();
  prefs.onChange(applyWorldMotion);
  // 20 floats per walker: the extra slots carry waypoint arrival times so the
  // villager shader stops at the waypoint instead of overshooting at 3×/5×.
  let view = sim.createRenderView ? sim.createRenderView(state, {rowFloats: 20}) : null;

  // ---------- speed ----------
  // Sim seconds per real second at 1x (sim/clock.js PACE). Try others with ?pace=.
  const PACE = Number(params.get('pace')) > 0 ? Number(params.get('pace')) : sim.pace ?? 1;
  let speed = params.get('paused') === '1' ? 0 : 1;
  let lastSpeed = 1;
  world.setSimSpeed?.(speed);
  // rate: sim seconds per real second, so the decision scheduler can keep
  // its waits in game time at high speed.
  const services = {decisions, routes, now: 0, rate: speed * PACE};

  // The speed the town really reaches (a multiple of 1×), measured over about
  // a second; below the chosen speed when the sim's frame budget runs out.
  let reached = null, reachedSim = 0, reachedReal = 0;
  const setSpeed = (s) => {
    if (s === speed) return;
    if (s > 0) lastSpeed = s;
    speed = s;
    reached = null; reachedSim = 0; reachedReal = 0;
    services.rate = s * PACE;
    world?.setSimSpeed?.(s);
    app?.refresh();
  };

  // ---------- persistence ----------
  let lastSave = performance.now();
  // Set when we navigate away on purpose (new town, import, the menu) so the
  // pagehide autosave can't write the outgoing town over anything.
  let leaving = false;
  function reloadFresh() {
    leaving = true;
    location.replace(location.pathname);
  }
  // One writer per town: the newest tab playing it owns its save. An older tab
  // that kept autosaving would write its stale town over the new one.
  let writer = true;
  let warnedFull = false;
  const tabId = Math.random().toString(36).slice(2);
  try {
    const channel = new BroadcastChannel('hearthvale-save');
    channel.onmessage = (e) => {
      if (e.data?.type !== 'claim' || e.data.id === tabId || e.data.slot !== slotId || !writer) return;
      writer = false;
      // `app` may not exist yet if the claim lands during boot.
      try { app.notices.toast('This town is open in another tab. This tab will not save. Reload it to play here.', 12000); } catch { /* booting */ }
    };
    if (slotId) channel.postMessage({type: 'claim', id: tabId, slot: slotId});
  } catch { /* no BroadcastChannel: single-tab behaviour */ }

  // A picture of the town for the main menu, taken right after a frame is
  // drawn (a WebGL canvas is only readable then). Resolves null if no frame
  // comes soon, e.g. in a hidden tab.
  let thumbWaiters = [];
  function nextThumb(timeout = 600) {
    return new Promise((resolve) => {
      const waiter = {resolve, timer: setTimeout(() => { thumbWaiters = thumbWaiters.filter((w) => w !== waiter); resolve(null); }, timeout)};
      thumbWaiters.push(waiter);
    });
  }
  function takeThumb() {
    const waiters = thumbWaiters;
    thumbWaiters = [];
    for (const w of waiters) clearTimeout(w.timer);
    let blob = Promise.resolve(null);
    try {
      const src = document.getElementById('world');
      if (src?.width && src.height) {
        const w = Math.min(THUMB_W, src.width), h = Math.round(w * src.height / src.width);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(src, 0, 0, w, h);
        blob = new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      }
    } catch { /* a tainted or lost canvas: no picture this time */ }
    blob.then((b) => { for (const w of waiters) w.resolve(b); }, () => { for (const w of waiters) w.resolve(null); });
  }

  function townMeta() {
    try { return metaFromSave(state); } catch { return {}; }
  }
  async function save(manual, {picture = true} = {}) {
    if (leaving || !writer) return;
    if (!persist && !manual) return;
    slotId ??= newSlotId();
    try {
      const text = sim.serialize(state);
      const thumb = picture && document.visibilityState === 'visible' ? await nextThumb() : null;
      const ok = await saves.save(slotId, text, {...townMeta(), ...(thumb ? {thumb} : {})});
      if (manual) app.notices.toast(ok ? 'Town saved on this device.' : 'Storage is full. Export your town instead.');
      else if (!ok && !warnedFull) {
        warnedFull = true;
        app.notices.toast('Your town could not be saved. Storage is full. Export it from Settings.', 10000);
      }
      return ok;
    } catch (err) {
      console.warn('[hearthvale] save failed', err);
      if (manual) app.notices.toast('The town could not be saved.');
      return false;
    }
  }
  // Rulings and other player actions save shortly after, debounced so a burst
  // of choices writes once. This also resets the regular autosave clock.
  let actionSaveTimer = 0;
  function saveSoon() {
    clearTimeout(actionSaveTimer);
    actionSaveTimer = setTimeout(() => {
      save(false);
      lastSave = performance.now();
    }, 400);
  }
  function exportSave() {
    const blob = new Blob([sim.serialize(state)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const name = String(state.townName || 'hearthvale').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    a.download = `${name}-year-${state.time?.year ?? 0}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Leaves this town, saved, for another page load.
  async function leave(intent) {
    clearTimeout(actionSaveTimer);
    await save(false, {picture: true});
    if (intent) setIntent(intent);
    reloadFresh();
  }
  async function importSave(file) {
    try {
      const raw = await file.text();
      sim.restore(raw);
      const slot = newSlotId();
      if (!(await saves.save(slot, raw, metaFromSave(raw)))) throw new Error('save failed');
      await leave({kind: 'load', id: slot});
    } catch {
      app.notices.toast('That file is not a Hearthvale town this version can open.');
    }
  }
  // The app asks first (a styled modal); this only does the deed. The old
  // town stays in Your towns.
  async function newTown({seed, choose} = {}) {
    await leave(choose ? {kind: 'menu', screen: 'new'} : {kind: 'new', seed: seed ?? null});
  }
  const toMenu = () => leave(null);

  // ---------- app ----------
  let simMs = 0;
  const app = createApp({
    sim, world, prefs, audio, narrator,
    state: () => state,
    speed: () => speed,
    reachedSpeed: () => (speed > 0 ? reached : null),
    lastSpeed: () => lastSpeed,
    setSpeed,
    simMs: () => simMs,
    seedCode: () => (sim.seedCode && Number.isFinite(state.seed) ? sim.seedCode(state.seed) : null),
    act(name, ...args) {
      const fn = sim.actions[name];
      if (!fn) return {ok: false, text: 'That is not ready yet.'};
      const result = fn(state, ...args);
      if (result?.ok !== false) saveSoon();
      return result;
    },
    setIndividualCap(v) {
      if (sim.actions.setIndividualCap) sim.actions.setIndividualCap(state, v);
      else if (state.settings) state.settings.individualCap = v;
      saveSoon();
    },
    save, exportSave, importSave, newTown, toMenu,
    decisions: {
      stats: () => client.stats(),
      settings: () => ({...decisionSettings}),
      configure(next) {
        decisionSettings = {...decisionSettings, ...next};
        client.configure(decisionSettings);
        store.set(DECISION_KEY, JSON.stringify(decisionSettings));
      },
      enabled: () => modelEnabled,
      setEnabled(on) {
        modelEnabled = on;
        store.set(MODEL_KEY, String(on));
        if (!on) client.reset();
        syncProse();
      },
    },
  });
  if (notice) app.notices.toast(notice, 6000);
  else if (!persist) app.notices.toast(`Test town (${fixture}): progress is not saved.`, 8000);
  // A new town is listed on the menu right away, picture and all.
  if (persist && slotId && !(await saves.list()).some((t) => t.id === slotId)) setTimeout(() => save(false), 1500);
  document.title = state.townName ? `${state.townName} · Hearthvale` : 'Hearthvale';

  // LLM prose for docket cards and chronicle lines, only with the model on.
  let proseKeeper = null;
  const syncProse = () => {
    if (modelEnabled && !proseKeeper && narrator?.startProseKeeper) proseKeeper = narrator.startProseKeeper(() => state);
    else if (!modelEnabled && proseKeeper) { proseKeeper.stop(); proseKeeper = null; }
  };
  syncProse();

  // ---------- loop ----------
  let last = performance.now();
  let worldErrors = 0, simErrors = 0;
  // Real seconds not yet given to the sim: on frames the world will not draw
  // (Battery saver, 60 Hz cap on a 120 Hz screen, paused) the sim waits and
  // catches up on the next drawn frame. Its fixed 0.1 s tick makes the
  // outcome the same, and walkers are extrapolated to each drawn frame.
  let simOwed = 0;
  // The sim steps in a task of its own, posted as each drawn frame is handed to the
  // GPU: the GPU draws that frame while the sim works out the next, instead of
  // waiting for it. (Run first in the frame, a heavy tick - a building going up, the
  // year's turn - plus the frame's own GPU time missed the display's deadline.)
  // Each frame draws the state the last step left, with walkers carried on to the
  // frame's time as before.
  let stepOwed = 0, stepPosted = false, stepMs = 0;
  const stepChannel = new MessageChannel();
  stepChannel.port1.onmessage = () => {
    stepPosted = false;
    const owed = stepOwed;
    stepOwed = 0;
    if (speed > 0 && owed > 0) step(owed);
  };
  function step(owed) {
    const t0 = performance.now();
    try {
      routes?.tick?.(state);
      const ticks = sim.stepTick(state, owed * speed * PACE, services, {until: t0 + SIM_BUDGET_MS});
      if (Number.isFinite(ticks)) {
        reachedSim += ticks * TICK_SECONDS;
        reachedReal += owed;
        if (reachedReal >= 1) {
          // Smoothed over a few seconds, so a heavy month-end does not flicker the label.
          const w = reachedSim / reachedReal / PACE;
          reached = reached == null ? w : reached * 0.6 + w * 0.4;
          reachedSim = 0;
          reachedReal = 0;
        }
      }
      simErrors = 0;
    } catch (err) {
      if (simErrors++ === 0) console.error('[hearthvale] sim step failed', err);
    }
    stepMs = performance.now() - t0;
    simMs = simMs * 0.9 + stepMs * 0.1;
  }
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    services.now = now;
    simOwed = speed > 0 ? Math.min(simOwed + dt, 0.25) : 0;
    let draw = true;
    try {
      draw = world.frameDue?.(now / 1000, dt) ?? true;
    } catch (err) {
      if (worldErrors++ === 0) console.error('[hearthvale] render failed', err);
    }
    if (draw && speed > 0) {
      stepOwed = Math.min(stepOwed + simOwed, 0.25);
      if (!stepPosted) {
        stepPosted = true;
        stepChannel.port2.postMessage(0);
      }
    }
    if (draw) {
      simOwed = 0;
      try {
        view?.sync(state, {now: now / 1000, speed: speed * PACE});
        world.update(view, now / 1000, dt);
        worldErrors = 0;
        if (thumbWaiters.length) takeThumb();
        // The menu fades out once the town is on screen behind it.
        if (menu) { menu.close(); menu = null; }
      } catch (err) {
        if (worldErrors++ === 0) console.error('[hearthvale] render failed', err);
        if (worldErrors === 30) swapToStubWorld();
      }
    }
    app.update(state, now, view);
    if (now - lastSave > AUTOSAVE_MS) {
      lastSave = now;
      const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 0));
      idle(() => save(false));
    }
  }
  requestAnimationFrame(frame);
  addEventListener('pagehide', () => save(false, {picture: false}));
  // IndexedDB writes are async, so also save as soon as the tab is hidden and
  // right before Vite's dev full reload, not only on pagehide.
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(false, {picture: false}); });
  import.meta.hot?.on('vite:beforeFullReload', () => save(false, {picture: false}));

  async function swapToStubWorld() {
    const {createWorld} = await import('./ui/dev/stub-world.js');
    try { world.dispose?.(); } catch { /* already broken */ }
    world = createWorld(makeCanvas(), {quality: prefs.get('quality'), batterySaver: prefs.get('batterySaver')});
    renderer.kind = 'stub-fallback';
    window.hearthvale.world = world;
    app.setWorld(world);
  }

  // ---------- test and dev hooks ----------
  const devAction = (fn) => (...args) => { fn?.(state, ...args); app.refresh(); };
  window.hearthvale = {
    sim: sim.kind,
    renderer: renderer.kind,
    fixture,
    slot: () => slotId,
    toMenu,
    state: () => state,
    snapshot: () => structuredClone(state),
    speed: () => speed,
    reachedSpeed: () => (speed > 0 ? reached : null),
    setSpeed,
    app,
    world,
    // stepMs: the last sim step alone (it runs in a task of its own, after the frame).
    view: () => ({...(world.stats?.() ?? {}), simMs, stepMs, layout: app.layout}),
    decisions: () => client.stats(),
    screenPoint: (x, z) => world.projectPoint?.(x, z),
    dev: {
      advanceEra: devAction(sim.dev.advanceEra),
      foundBody: devAction(sim.dev.foundBody),
      addCard: devAction(sim.dev.addCard),
    },
  };
}
