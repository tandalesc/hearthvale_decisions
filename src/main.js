// Hearthvale bootstrap (contract §7). Wires state, the sim step, the
// decision client, the route planner, the renderer and the UI, then runs
// the frame loop. Dev URL params:
//   ?fixture=hamlet|town|city   load a fixture town (no autosave unless &save=1)
//   ?paused=1                   start paused
//   ?stub=1 / ?renderer=stub    force the development stubs
import {createDecisionClient} from './decision-client.js';
import {loadNarrator, loadRenderer, loadSim} from './ui/bridge.js';
import {createApp} from './ui/app.js';
import {createPrefs} from './ui/prefs.js';
import {createAudio} from './audio/index.js';
import {rapidsSources} from './river.js';
import {createSaveStore} from './save-store.js';

const SAVE_KEY = 'hearthvale-save';
// Town saves go to IndexedDB (gzip); SAVE_KEY is only the legacy localStorage key.
const saves = createSaveStore({legacyKey: SAVE_KEY});
const MODEL_KEY = 'hearthvale-model-enabled';
const DECISION_KEY = 'hearthvale-decision-settings';
const NEW_SEED_KEY = 'hearthvale-new-seed';
const AUTOSAVE_MS = 30000;

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

async function boot() {
  const [sim, renderer] = await Promise.all([loadSim(params), loadRenderer(params)]);
  const narrator = await loadNarrator(sim.kind);
  const prefs = createPrefs();
  const audio = createAudio(prefs);

  // ---------- state ----------
  const fixture = params.get('fixture');
  const persist = !fixture || params.get('save') === '1';
  let notice = null;
  let state = null;
  if (fixture) {
    try {
      state = sim.loadFixture ? await sim.loadFixture(fixture) : sim.fixtureState?.(fixture);
    } catch (err) {
      console.warn('[hearthvale] fixture failed to load', err);
    }
  }
  if (!state) {
    const raw = await saves.load();
    if (raw) {
      try {
        state = sim.restore(raw);
      } catch {
        notice = 'Your old town was made with an earlier version. A new town begins.';
        await saves.remove();
      }
    }
  }
  if (!state) {
    // "Start a new town from seed…" leaves the seed here across the reload.
    let seed = null;
    try {
      seed = sessionStorage.getItem(NEW_SEED_KEY);
      sessionStorage.removeItem(NEW_SEED_KEY);
    } catch { /* storage blocked */ }
    state = seed ? sim.createState(seed) : sim.createState();
  }
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
  const setSpeed = (s) => {
    if (s === speed) return;
    if (s > 0) lastSpeed = s;
    speed = s;
    world?.setSimSpeed?.(s);
    app?.refresh();
  };

  // ---------- persistence ----------
  let lastSave = performance.now();
  // Set when we navigate away on purpose (new town, import) so the pagehide
  // autosave can't write the outgoing town back over the new save.
  let leaving = false;
  function reloadFresh() {
    leaving = true;
    location.replace(location.pathname);
  }
  // One writer per browser: the newest tab owns the save. An older tab that
  // kept autosaving would write its stale town over the new one.
  let writer = true;
  let warnedFull = false;
  const tabId = Math.random().toString(36).slice(2);
  try {
    const channel = new BroadcastChannel('hearthvale-save');
    channel.onmessage = (e) => {
      if (e.data?.type !== 'claim' || e.data.id === tabId || !writer) return;
      writer = false;
      // `app` may not exist yet if the claim lands during boot.
      try { app.notices.toast('This town is open in another tab. This tab will not save. Reload it to play here.', 12000); } catch { /* booting */ }
    };
    channel.postMessage({type: 'claim', id: tabId});
  } catch { /* no BroadcastChannel: single-tab behaviour */ }
  async function save(manual) {
    if (leaving || !writer) return;
    if (!persist && !manual) return;
    try {
      const ok = await saves.save(sim.serialize(state));
      if (manual) app.notices.toast(ok ? 'Town saved on this device.' : 'Storage is full. Export your town instead.');
      else if (!ok && !warnedFull) {
        warnedFull = true;
        app.notices.toast('Your town could not be saved. Storage is full. Export it from Settings.', 10000);
      }
    } catch (err) {
      console.warn('[hearthvale] save failed', err);
      if (manual) app.notices.toast('The town could not be saved.');
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
    a.download = `hearthvale-year-${state.time?.year ?? 0}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function importSave(file) {
    try {
      const raw = await file.text();
      sim.restore(raw);
      if (!(await saves.save(raw))) throw new Error('save failed');
      reloadFresh();
    } catch {
      app.notices.toast('That file is not a Hearthvale town this version can open.');
    }
  }
  // The app asks first (a styled modal); this only does the deed.
  async function newTown({seed} = {}) {
    await saves.remove();
    try {
      if (seed) sessionStorage.setItem(NEW_SEED_KEY, String(seed));
    } catch { /* storage blocked: a random valley it is */ }
    reloadFresh();
  }

  // ---------- app ----------
  let simMs = 0;
  const app = createApp({
    sim, world, prefs, audio, narrator,
    state: () => state,
    speed: () => speed,
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
    save, exportSave, importSave, newTown,
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

  // LLM prose for docket cards and chronicle lines, only with the model on.
  let proseKeeper = null;
  const syncProse = () => {
    if (modelEnabled && !proseKeeper && narrator?.startProseKeeper) proseKeeper = narrator.startProseKeeper(() => state);
    else if (!modelEnabled && proseKeeper) { proseKeeper.stop(); proseKeeper = null; }
  };
  syncProse();

  // ---------- loop ----------
  let last = performance.now();
  const services = {decisions, routes, now: 0};
  let worldErrors = 0, simErrors = 0;
  // Real seconds not yet given to the sim: on frames the world will not draw
  // (Battery saver, 60 Hz cap on a 120 Hz screen, paused) the sim waits and
  // catches up on the next drawn frame. Its fixed 0.1 s tick makes the
  // outcome the same, and walkers are extrapolated to each drawn frame.
  let simOwed = 0;
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
      const t0 = performance.now();
      try {
        routes?.tick?.(state);
        sim.stepTick(state, simOwed * speed * PACE, services);
        simErrors = 0;
      } catch (err) {
        if (simErrors++ === 0) console.error('[hearthvale] sim step failed', err);
      }
      simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
    }
    if (draw) {
      simOwed = 0;
      try {
        view?.sync(state, {now: now / 1000, speed: speed * PACE});
        world.update(view, now / 1000, dt);
        worldErrors = 0;
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
  addEventListener('pagehide', () => save(false));
  // IndexedDB writes are async, so also save as soon as the tab is hidden and
  // right before Vite's dev full reload, not only on pagehide.
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(false); });
  import.meta.hot?.on('vite:beforeFullReload', () => save(false));

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
    state: () => state,
    snapshot: () => structuredClone(state),
    speed: () => speed,
    setSpeed,
    app,
    world,
    view: () => ({...(world.stats?.() ?? {}), simMs, layout: app.layout}),
    decisions: () => client.stats(),
    screenPoint: (x, z) => world.projectPoint?.(x, z),
    dev: {
      advanceEra: devAction(sim.dev.advanceEra),
      foundBody: devAction(sim.dev.foundBody),
      addCard: devAction(sim.dev.addCard),
    },
  };
}
