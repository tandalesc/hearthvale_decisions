// Hearthvale bootstrap (contract §7). Opens the town in the sim host (src/sim-host.js:
// in the sim worker, or on this thread), wires the renderer and the UI to it, then runs
// the frame loop. Dev URL params:
//   ?fixture=hamlet|town|city   load a fixture town (no autosave unless &save=1)
//   ?play=1                     skip the main menu: continue the last town, or start one
//   ?paused=1                   start paused
//   ?stub=1 / ?renderer=stub    force the development stubs
//   ?simWorker=0                run the sim on the main thread (as before the worker)
//   ?student=0                  turn off the decision students (public/students/), which
//                               otherwise answer the kinds they know in the browser
import {createDecisionClient} from './decision-client.js';
import {createLocalAnswerer, createStudentVersions} from './decision-local.js';
import {loadNarrator, loadRenderer, loadSim} from './ui/bridge.js';
import {createInlineHost, createWorkerHost} from './sim-host.js';
import {useTerrain} from './terrain.js';
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
// Time the sim may take per step. Past it, no new tick starts in that step; at a
// speed the device cannot keep up with, the town runs slower (shown as the speed it
// really reaches) rather than stuttering. On the main thread a step shares the frame;
// in the worker it does not, so it may run longer.
const SIM_BUDGET_MS = 10;
const WORKER_BUDGET_MS = 30;
const TICK_SECONDS = 0.1;
const ROW_FLOATS = 20;

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

  // ---------- decisions (settings; the client lives with the town) ----------
  let modelEnabled = store.get(MODEL_KEY) !== 'false';
  let decisionSettings = {mode: 'auto', cap: 100};
  try {
    const saved = JSON.parse(store.get(DECISION_KEY));
    if (saved?.mode === 'auto' || saved?.mode === 'manual') {
      decisionSettings = {mode: saved.mode, cap: Number.isFinite(saved.cap) ? Math.max(1, Math.min(5000, Math.round(saved.cap))) : 100};
    }
  } catch { /* defaults */ }

  // ---------- the sim host ----------
  // The town runs in the sim worker unless asked not to, or the sim is the stub. A
  // worker that cannot start leaves the town on this thread, through the same host.
  let host = null;
  let sim, renderer;
  // Decision students answer the kinds they know in the browser unless ?student=0.
  const student = params.get('student') !== '0' ? new URL('students/', document.baseURI).href : null;
  const pace = (s) => (Number(params.get('pace')) > 0 ? Number(params.get('pace')) : s.pace ?? 1);
  async function inlineHost() {
    let routes = null;
    try {
      const {createRoutePlanner} = await import('./route-planner.js');
      routes = createRoutePlanner();
    } catch (err) {
      console.warn('[hearthvale] route planner unavailable', err);
    }
    let client = createDecisionClient({now: () => performance.now()}), students = null;
    if (student) {
      client = createLocalAnswerer({client, report: {}});
      students = createStudentVersions({answerer: client, base: student});
      await students.start();
    }
    const h = createInlineHost({sim, routes, decisions: client, students, pace: pace(sim), budgetMs: SIM_BUDGET_MS, rowFloats: ROW_FLOATS});
    h.decisions.configure(decisionSettings);
    h.decisions.setEnabled(modelEnabled);
    return h;
  }
  async function getHost() {
    if (host) return host;
    [sim, renderer] = await loading;
    if (sim.kind === 'real' && params.get('simWorker') !== '0' && typeof Worker !== 'undefined') {
      try {
        const h = createWorkerHost({pace: pace(sim), budgetMs: WORKER_BUDGET_MS, rowFloats: ROW_FLOATS, model: modelEnabled, decisionSettings, student});
        await h.ready;
        return (host = h);
      } catch (err) {
        console.warn('[hearthvale] the sim worker could not start; running the sim on the main thread', err);
      }
    }
    return (host = await inlineHost());
  }

  // Builds the town a choice asks for. Throws with a line for the player.
  let info = null;
  async function openChoice(choice) {
    const h = await getHost();
    if (choice.kind === 'new') {
      const r = await h.init({...choice, kind: 'new', name: choice.name || suggestName(choice.archetype)}, performance.now());
      if (r.error) throw new Error('A new town could not be founded.');
      return {info: r.info, slot: newSlotId()};
    }
    const raw = choice.kind === 'import' ? choice.raw : await saves.load(choice.id);
    if (!raw) throw new Error('That town is no longer on this device.');
    const r = await h.init({kind: 'raw', raw}, performance.now());
    if (r.error) {
      throw new Error(r.error === 'old-version'
        ? 'That town was made with an earlier version of Hearthvale and cannot be opened.'
        : 'That town could not be opened. The save may be damaged.');
    }
    if (choice.kind === 'import') {
      const slot = newSlotId();
      await saves.save(slot, raw, metaFromSave(raw));
      return {info: r.info, slot};
    }
    return {info: r.info, slot: choice.id};
  }

  let notice = null;
  let slotId = null;
  if (menu) {
    for (;;) {
      const choice = await menu.choose();
      const name = choice.kind === 'new' ? choice.name : choice.name ?? (await saves.list()).find((t) => t.id === choice.id)?.name;
      menu.busy(choice.kind === 'new' ? `Founding ${name}…` : `Opening ${name || 'your town'}…`);
      try {
        ({info, slot: slotId} = await openChoice(choice));
        break;
      } catch (err) {
        console.warn('[hearthvale] could not open the town', err);
        await menu.fail(err.message);
      }
    }
  } else {
    const h = await getHost();
    if (fixture) {
      const r = await h.init({kind: 'fixture', name: fixture}, performance.now());
      if (r.info) info = r.info;
    }
    if (!info && intent?.kind === 'load') {
      try {
        ({info, slot: slotId} = await openChoice(intent));
      } catch (err) {
        notice = err.message;
      }
    }
    if (!info && intent?.kind !== 'new') {
      const latest = await saves.latest();
      if (latest) {
        try {
          ({info, slot: slotId} = await openChoice({kind: 'load', id: latest.id}));
        } catch {
          notice = 'Your old town was made with an earlier version. A new town begins.';
          await saves.remove(latest.id);
        }
      }
    }
    if (!info) {
      // "Start a new town from seed…" in Settings leaves the seed in the intent.
      ({info, slot: slotId} = await openChoice({kind: 'new', seed: intent?.seed ?? null}));
    }
    if (fixture && persist && !slotId) slotId = newSlotId();
  }
  // This thread's valley: the renderer, picking, the camera and the water sounds read it.
  useTerrain(info.terrain.seed, info.terrain.version, info.terrain.archetype);
  const narrator = await loadNarrator(sim.kind);
  // The inline host keeps notes and card prose through this thread's narrator.
  host.useNarrator(narrator && {facts: narrator.facts, peekNote: narrator.peekNote, keepNote: narrator.keepNote, touchNote: narrator.touchNote}, narrator?.startProseKeeper ?? null);
  const audio = createAudio(prefs);
  // The town's terrain seed is set now: riffles and cascades get their own water sound.
  audio.setWaterSources(rapidsSources());

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
  // The render view: the live one (inline host) or the worker's mirror. 20 floats per
  // walker: the extra slots carry waypoint arrival times so the villager shader stops
  // at the waypoint instead of overshooting at 3×/5×.
  let view = null;

  // ---------- speed ----------
  // Sim seconds per real second at 1x (sim/clock.js PACE). Try others with ?pace=.
  const PACE = pace(sim);
  let speed = params.get('paused') === '1' ? 0 : 1;
  let lastSpeed = 1;
  world.setSimSpeed?.(speed);

  // The speed the town really reaches (a multiple of 1×), measured over about
  // a second; below the chosen speed when the sim's frame budget runs out.
  let reached = null, reachedSim = 0, reachedReal = 0;
  const setSpeed = (s) => {
    if (s === speed) return;
    if (s > 0) lastSpeed = s;
    speed = s;
    reached = null; reachedSim = 0; reachedReal = 0;
    world?.setSimSpeed?.(s);
    app?.refresh();
  };

  // ---------- persistence ----------
  let lastSave = performance.now();
  // Set when we navigate away on purpose (new town, import, the menu) so the
  // pagehide autosave can't write the outgoing town over anything.
  let leaving = false;
  // Set when the sim worker dies: nothing is left to save or step.
  let failed = false;
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

  async function save(manual, {picture = true} = {}) {
    if (leaving || !writer || failed) return;
    if (!persist && !manual) return;
    slotId ??= newSlotId();
    try {
      // The text comes from wherever the town runs (in the worker: off this thread).
      const [{text, meta}, thumb] = await Promise.all([host.save(), picture && document.visibilityState === 'visible' ? nextThumb() : null]);
      const ok = await saves.save(slotId, text, {...meta, ...(thumb ? {thumb} : {})});
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
  async function exportSave() {
    const {text, meta} = await host.save();
    const blob = new Blob([text], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const name = String(meta?.name || 'hearthvale').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    a.download = `${name}-year-${meta?.year ?? 0}.json`;
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
      if (!(await host.check(raw))) throw new Error('not a town');
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
  // An action's result comes back from the host (a Promise from the worker).
  const afterAct = (result) => {
    if (result?.ok !== false) saveSoon();
    return result;
  };
  const app = createApp({
    sim, world, prefs, audio, narrator,
    ui: (req) => host.ui(req),
    inspect: (target) => host.inspect(target),
    notes: host.notes,
    speed: () => speed,
    reachedSpeed: () => (speed > 0 ? reached : null),
    lastSpeed: () => lastSpeed,
    setSpeed,
    simMs: () => simMs,
    seedCode: () => (sim.seedCode && Number.isFinite(info.seed) ? sim.seedCode(info.seed) : null),
    act(name, ...args) {
      const result = host.act(name, ...args);
      return typeof result?.then === 'function' ? result.then(afterAct) : afterAct(result);
    },
    setIndividualCap(v) {
      host.setIndividualCap(v);
      saveSoon();
    },
    save, exportSave, importSave, newTown, toMenu,
    decisions: {
      stats: () => host.decisions.stats(),
      settings: () => ({...decisionSettings}),
      configure(next) {
        decisionSettings = {...decisionSettings, ...next};
        host.decisions.configure(decisionSettings);
        store.set(DECISION_KEY, JSON.stringify(decisionSettings));
      },
      enabled: () => modelEnabled,
      setEnabled(on) {
        modelEnabled = on;
        store.set(MODEL_KEY, String(on));
        host.decisions.setEnabled(on);
      },
    },
  });
  if (notice) app.notices.toast(notice, 6000);
  else if (!persist) app.notices.toast(`Test town (${fixture}): progress is not saved.`, 8000);
  // A new town is listed on the menu right away, picture and all.
  if (persist && slotId && !(await saves.list()).some((t) => t.id === slotId)) setTimeout(() => save(false), 1500);
  document.title = info.townName ? `${info.townName} · Hearthvale` : 'Hearthvale';

  // ---------- loop ----------
  let last = performance.now();
  let worldErrors = 0, simErrors = 0;
  // Real seconds not yet given to the sim: on frames the world will not draw
  // (Battery saver, 60 Hz cap on a 120 Hz screen, paused) the sim waits and
  // catches up on the next drawn frame. Its fixed 0.1 s tick makes the
  // outcome the same, and walkers are extrapolated to each drawn frame.
  let simOwed = 0;
  // Steps never run in the frame. In the worker, each drawn frame posts one when the
  // last has been answered and draws the view the last answer left. On the inline host
  // the step runs in a task of its own, posted as the drawn frame is handed to the GPU,
  // so the GPU draws that frame while the sim works out the next. Either way walkers are
  // carried on to each frame's time.
  host.onStep((r, owed) => {
    if (r.error) {
      if (simErrors++ === 0) console.error('[hearthvale] sim step failed', r.error);
    } else simErrors = 0;
    if (owed > 0) {
      reachedSim += r.ticks * TICK_SECONDS;
      reachedReal += owed;
      if (reachedReal >= 1) {
        // Smoothed over a few seconds, so a heavy month-end does not flicker the label.
        const w = reachedSim / reachedReal / PACE;
        reached = reached == null ? w : reached * 0.6 + w * 0.4;
        reachedSim = 0;
        reachedReal = 0;
      }
    }
    simMs = simMs * 0.9 + r.ms * 0.1;
  });
  // The worker died: its town is gone. Stop, say so, and offer the last save.
  host.onFail((message) => {
    failed = true;
    console.error('[hearthvale] the sim worker stopped:', message);
    app.notices.nudge('The town stopped working. Reopen it from its last save.', {icon: 'refresh', onClick: () => {
      leaving = true;
      if (slotId && persist) setIntent({kind: 'load', id: slotId});
      location.replace(location.pathname + (persist ? '' : location.search));
    }});
  });
  function frame(now) {
    if (failed) return;
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    simOwed = speed > 0 ? Math.min(simOwed + dt, 0.25) : 0;
    let draw = true;
    try {
      draw = world.frameDue?.(now / 1000, dt) ?? true;
    } catch (err) {
      if (worldErrors++ === 0) console.error('[hearthvale] render failed', err);
    }
    if (draw) {
      const owed = speed > 0 ? simOwed : 0;
      simOwed = 0;
      try {
        view = host.frame(now, speed, owed);
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
    app.update(null, now, view);
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
  // The town may be in the worker: hooks that reach it return Promises (page.evaluate
  // awaits them), and inSim runs a function there with (state, sim, ...args). The
  // function travels as source text, so it must not close over anything on this page.
  const refreshed = (p) => Promise.resolve(p).then(async (v) => { await app.refresh(); return v; });
  const devAction = (name) => (...args) => refreshed(host.dev(name, ...args));
  window.hearthvale = {
    sim: sim.kind,
    simHost: host.kind,
    // The host itself, for benchmarks (host.onStep: each step's reply; host.mirror).
    host,
    renderer: renderer.kind,
    fixture,
    slot: () => slotId,
    toMenu,
    // The live state, only while the sim runs on this thread (?simWorker=0, the stub).
    state: () => host.state ?? null,
    snapshot: () => Promise.resolve(host.snapshot()),
    inSim: (fn, ...args) => refreshed(host.inSim(fn, ...args)),
    speed: () => speed,
    reachedSpeed: () => (speed > 0 ? reached : null),
    setSpeed,
    app,
    world,
    // stepMs: the last sim step alone (in the worker, or in a task of its own after the frame).
    view: () => ({...(world.stats?.() ?? {}), simMs, stepMs: host.stepMs, syncMs: host.syncMs ?? null, simHost: host.kind, layout: app.layout}),
    decisions: () => host.decisions.stats(),
    screenPoint: (x, z) => world.projectPoint?.(x, z),
    dev: {
      advanceEra: devAction('advanceEra'),
      foundBody: devAction('foundBody'),
      addCard: devAction('addCard'),
    },
  };
}
