// The running town behind one interface, wherever it runs (docs/design/sim-worker.md §4.1).
//
//   createWorkerHost(opts)   the sim in src/sim-worker.js; its render view is mirrored here
//                            (sim/render-mirror.js) and the UI reads snapshots
//   createInlineHost(opts)   the sim on the main thread: ?simWorker=0, the stub sim, or a
//                            worker that failed to start
//
// Both give:
//   ready                      resolves when the host can take a town (rejects: no worker)
//   init(choice, now)          -> {info} | {error}  (sim-session.js init; then the view is primed)
//   frame(now, speed, owed)    -> the render view to draw this frame. owed: real seconds the
//                                sim is owed (0 when paused). Steps run after the frame (inline)
//                                or in the worker, one at a time; a frame never waits.
//   act(name, ...args)         -> the action's result
//   ui(req) / inspect(target)  -> a UI snapshot (sim-snapshot.js) / the inspector's bundle
//   save()                     -> {text, meta};  check(raw) -> can this version open it?
//   setIndividualCap(v), decisions.{configure, setEnabled, stats}, notes.{set, touch}
//   dev(name, ...args), inSim(fn, ...args), snapshot()   dev and test hooks
//   onStep(fn)                 fn({ticks, ms, error}, owed) after each step
//   onFail(fn)                 fn(message) when the worker dies (the town in it is gone)
//   stepMs                     the last step's sim time;  kind: 'worker' | 'inline'
//
// The inline host answers at once; the worker host answers with Promises (ready, init,
// act, ui, inspect, save, check, dev, inSim and snapshot). Callers handle both.
import {createSimSession} from './sim-session.js';
import {createRenderMirror} from './sim/render-mirror.js';

// The inline host: sim-session.js on this thread, stepping in a task of its own posted as
// each drawn frame is handed to the GPU (the GPU draws that frame while the sim works out
// the next). The renderer reads the live render view.
export function createInlineHost({sim, routes = null, decisions = null, students = null, entitlement, pace = 1, budgetMs = 10, rowFloats = 20} = {}) {
  const session = createSimSession({sim, routes, decisions, students, entitlement, pace, budgetMs, rowFloats});
  let stepOwed = 0, posted = false, lastNow = 0, lastSpeed = 0, lib = null;
  const listeners = {step: [], fail: []};
  const host = {
    kind: 'inline',
    ready: Promise.resolve(),
    stepMs: 0,
    session,
    get state() { return session.state; },
    init: (choice) => session.init(choice),
    frame(now, speed, owed) {
      lastNow = now;
      lastSpeed = speed;
      if (speed > 0) {
        stepOwed = Math.min(stepOwed + owed, 0.25);
        if (!posted) {
          posted = true;
          channel.port2.postMessage(0);
        }
      }
      return session.sync(now, speed);
    },
    act: (name, ...args) => session.act(name, args),
    ui: (req) => session.ui(req),
    inspect: (target) => session.inspect(target),
    save: () => session.save(),
    check: (raw) => session.check(raw),
    setIndividualCap: (v) => session.setIndividualCap(v),
    decisions: session.decisions,
    notes: session.notes,
    cancelCardProse: () => session.cancelCardProse(),
    requestCardProse: (id) => session.requestCardProse(id),
    useNarrator: (n, prose) => session.useNarrator(n, prose),
    dev: (name, ...args) => session.dev(name, args),
    async inSim(fn, ...args) {
      lib ??= sim.kind === 'real' ? {...(await import('./sim/index.js')), docket: await import('./sim/docket.js')} : sim;
      const f = typeof fn === 'string' ? new Function(`return (${fn});`)() : fn;
      // As in the worker: the result is what would survive the trip there and back.
      const out = await f(session.state, lib, ...args);
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    },
    snapshot: () => structuredClone(session.state),
    onStep: (fn) => listeners.step.push(fn),
    onFail: (fn) => listeners.fail.push(fn),
    dispose: () => session.dispose(),
  };
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    posted = false;
    const owed = stepOwed;
    stepOwed = 0;
    if (!(lastSpeed > 0 && owed > 0)) return;
    const r = session.step(owed, lastNow, lastSpeed);
    host.stepMs = r.ms;
    for (const fn of listeners.step) fn(r, owed);
  };
  return host;
}

// How long a worker may take to load before the inline host takes over.
const START_MS = 20000;
// A worker that has said nothing for this long while steps wait is asked if it is
// alive, and given PROBE_MS to answer. Calls that may run long on purpose (opening a
// town, a save, test hooks) hold the watchdog off.
const SILENT_MS = 15000;
const PROBE_MS = 5000;
const LONG_OPS = new Set(['setup', 'init', 'save', 'check', 'dev', 'inSim', 'snapshot', 'serialize']);

// The worker host. opts go to the worker's setup: {pace, budgetMs, rowFloats, model,
// decisionSettings, routes: {worker, fixedClock}, decisions, prose, student, studentPin, entitlement}.
export function createWorkerHost(opts = {}) {
  const mirror = createRenderMirror({rowFloats: opts.rowFloats ?? 20});
  const pending = new Map();
  const listeners = {step: [], fail: []};
  let nextId = 1, dead = null, started = false;
  let inFlight = false, stepOwed = 0;
  let stats = null;
  let lastHeard = performance.now(), probing = false;

  const worker = new Worker(new URL('./sim-worker.js', import.meta.url), {type: 'module'});
  worker.onmessage = ({data}) => {
    lastHeard = performance.now();
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(Object.assign(new Error(data.error.message), {stack: data.error.stack, code: data.error.code}));
    else p.resolve(data.value);
  };
  worker.onmessageerror = () => fail('A message from the town could not be read.');
  worker.onerror = (e) => {
    e.preventDefault?.();
    if (!started) return fail(e.message || 'The sim worker failed to load.');
    // An error the worker did not catch. It may still be alive: the watchdog asks it.
    console.error('[hearthvale] sim worker error', e.message ?? e);
    lastHeard = -Infinity;
  };

  function call(op, args = [], transfer = []) {
    if (dead) return Promise.reject(new Error(dead));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject, op});
      worker.postMessage({id, op, args}, transfer);
    });
  }

  // A worker can stop without an error event (closed, or killed for memory).
  const watchdog = setInterval(() => {
    if (dead || !started || probing || !pending.size) return;
    if (performance.now() - lastHeard < SILENT_MS) return;
    for (const p of pending.values()) if (LONG_OPS.has(p.op)) return;
    probing = true;
    const timer = setTimeout(() => fail('The town stopped responding.'), PROBE_MS);
    call('ping').then(() => { clearTimeout(timer); probing = false; }, () => {});
  }, 2500);

  function fail(message) {
    if (dead) return;
    dead = message || 'The town stopped.';
    clearInterval(watchdog);
    try { worker.terminate(); } catch { /* gone */ }
    for (const p of pending.values()) p.reject(new Error(dead));
    pending.clear();
    if (started) for (const fn of listeners.fail) fn(dead);
  }

  const {routes, decisions, prose, model, decisionSettings, pace, budgetMs, rowFloats, student, studentPin, entitlement} = opts;
  const ready = Promise.race([
    call('setup', [{routes, decisions, prose, model, decisionSettings, pace, budgetMs, rowFloats, student, studentPin, entitlement}]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('The sim worker took too long to start.')), START_MS)),
  ]).then(() => { started = true; }, (err) => { fail(err.message); throw err; });

  const host = {
    kind: 'worker',
    ready,
    stepMs: 0,
    syncMs: 0,
    mirror,
    get dead() { return dead; },
    async init(choice, now = performance.now()) {
      const r = await call('init', [choice, now]);
      if (r.info) {
        // A new town: a fresh mirror for its first full delta.
        Object.assign(mirror, createRenderMirror({rowFloats: rowFloats ?? 20}));
        mirror.apply(r.delta);
      }
      return r.error ? {error: r.error} : {info: r.info};
    },
    frame(now, speed, owed) {
      stepOwed = speed > 0 ? Math.min(stepOwed + owed, 0.25) : 0;
      if (!inFlight && !dead) {
        inFlight = true;
        const sent = stepOwed;
        stepOwed = 0;
        call('step', [sent, now, speed]).then((r) => {
          inFlight = false;
          mirror.apply(r.delta);
          host.stepMs = r.ms;
          host.syncMs = r.syncMs;
          for (const fn of listeners.step) fn(r, sent);
        }, () => { inFlight = false; });
      }
      return mirror.view;
    },
    act: (name, ...args) => call('act', [name, args]),
    async ui(req) {
      const snap = await call('ui', [req]);
      if (snap?.decisionStats) stats = snap.decisionStats;
      return snap;
    },
    inspect: (target) => call('inspect', [target]),
    save: () => call('save'),
    check: (raw) => call('check', [raw]),
    setIndividualCap: (v) => { call('setIndividualCap', [v]).catch(() => {}); },
    decisions: {
      stats: () => stats,
      configure: (s) => { call('decisions.configure', [s]).catch(() => {}); },
      setEnabled: (on) => { call('decisions.setEnabled', [on]).catch(() => {}); },
    },
    cancelCardProse: () => call('cancelCardProse'),
    requestCardProse: (id) => call('requestCardProse', [id]),
    notes: {
      set: (ref, key, text) => { call('notes.set', [ref, key, text]).catch(() => {}); },
      touch: (ref) => { call('notes.touch', [ref]).catch(() => {}); },
    },
    useNarrator() { /* the worker has its own */ },
    dev: (name, ...args) => call('dev', [name, args]),
    inSim: (fn, ...args) => call('inSim', [String(fn), args]),
    snapshot: () => call('snapshot'),
    onStep: (fn) => listeners.step.push(fn),
    onFail: (fn) => listeners.fail.push(fn),
    dispose() {
      clearInterval(watchdog);
      try { worker.terminate(); } catch { /* gone */ }
    },
  };
  return host;
}
