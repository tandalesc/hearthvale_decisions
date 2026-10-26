// The sim worker (docs/design/sim-worker.md §4). It owns the town's state and runs
// everything that writes to it: stepTick, the route planner (whose navigation worker it
// starts from here), the decision client, the prose keeper and player actions. The main
// thread draws a mirrored render view and UI snapshots, so no tick can delay a frame.
//
// Messages in: {id, op, args}; replies: {id, value} or {id, error: {message, stack}}.
// Messages are handled one at a time, in order, each between ticks. The ops are
// src/sim-host.js's (createWorkerHost), plus 'setup' first and 'ping'.
//
// Tests drive this module in Node through worker_threads (tests/sim-worker-node.js
// gives it `self`).
import * as simIndex from './sim/index.js';
import * as simView from './sim/view.js';
import * as docket from './sim/docket.js';
import {narrativeFacts} from './sim/narrative-facts.js';
import {peekNote, keepNote, touchNote, startProseKeeper} from './narrator-client.js';
import {createLocalNarration} from './narration-student.js';
import {createDecisionClient} from './decision-client.js';
import {createLocalAnswerer, createStudentVersions} from './decision-local.js';
// Static, never import(): a chunk split off this worker imports its shared code back
// from the worker's own file, and Safari then runs that file a second time in the same
// worker, whose second copy (session null) takes over the messages.
import {createRoutePlanner} from './route-planner.js';
import {realSim} from './sim-api.js';
import {createSimSession} from './sim-session.js';
import {createMirrorSource} from './sim/render-mirror.js';
import {activeWearBox} from './sim/roads.js';

const sim = realSim({index: simIndex, view: simView});
const lib = {...simIndex, docket};
let session = null;
let source = null;

const ops = {
  ping: () => true,

  // opts: {pace, budgetMs, rowFloats, model, decisionSettings, decisions (false: none),
  //        prose (false: none), routes: {worker (false: cooperative), fixedClock},
  //        student (the decision students directory URL: its kinds answer locally),
  //        studentPin (hold every town on that version)}
  async setup(opts = {}) {
    let routes = null;
    try {
      routes = createRoutePlanner({
        worker: opts.routes?.worker ?? true,
        // A clock that never advances: each tick runs its full slice cap (tests).
        ...(opts.routes?.fixedClock ? {clock: () => 0} : {}),
      });
    } catch (err) {
      console.warn('[hearthvale] route planner unavailable', err);
    }
    let decisions = opts.decisions === false ? null : createDecisionClient({now: () => performance.now()});
    // opts.student: the decision students directory (manifest.json and bundles);
    // their kinds are answered here, one version per town.
    let students = null;
    if (decisions) decisions = createLocalAnswerer({client: decisions, entitlement: opts.entitlement, report: {}});
    if (decisions && opts.student) {
      students = createStudentVersions({answerer: decisions, base: opts.student, manifestURL: new URL('/api/students/manifest', self.location.href).href, fallbackBase: new URL('/students/', self.location.href).href, pinned: opts.studentPin ?? null});
      await students.start();
    }
    session = createSimSession({
      sim, lib, routes, decisions, students, entitlement: opts.entitlement,
      narrator: {facts: narrativeFacts, peekNote, keepNote, touchNote},
      startProse: opts.prose === false ? null : startProseKeeper,
      localProse: opts.prose === false || opts.narrationStudent === false ? null : createLocalNarration({base: new URL('/api/students/', self.location.href).href, fallbackBase: new URL('/students/', self.location.href).href}),
      pace: opts.pace ?? sim.pace ?? 1,
      budgetMs: opts.budgetMs ?? 30,
      rowFloats: opts.rowFloats ?? 20,
    });
    if (opts.decisionSettings) session.decisions.configure(opts.decisionSettings);
    session.decisions.setEnabled(opts.model !== false);
    return true;
  },

  // Opens a town, then sends the whole render view for the mirror to start from.
  async init(choice, now = 0) {
    const r = await session.init(choice);
    if (r.error) return r;
    source = createMirrorSource({wearBox: activeWearBox});
    const view = session.sync(now, 0);
    const {delta, transfer} = source.delta(view, session.state);
    return [{info: r.info, delta}, transfer];
  },

  step(owed, now, speed) {
    const r = session.step(owed, now, speed);
    if (r.error) reportStepError(r.error);
    const t0 = performance.now();
    const view = session.sync(now, speed);
    const {delta, transfer} = source.delta(view, session.state);
    return [{ticks: r.ticks, ms: r.ms, syncMs: performance.now() - t0, error: r.error ? String(r.error) : null, delta}, transfer];
  },

  // A result is plain data (a reason, a line of text); JSON drops anything that is not.
  act: (name, args) => plain(session.act(name, args)),
  ui: (req) => session.ui(req),
  inspect: (target) => session.inspect(target),
  save: () => session.save(),
  check: (raw) => session.check(raw),
  setIndividualCap: (v) => session.setIndividualCap(v),
  'decisions.configure': (s) => session.decisions.configure(s),
  'narration.stats': () => session.narration.stats(),
  'narration.refresh': () => session.narration.refresh(),
  'narration.configure': (s) => session.narration.configure(s),
  'decisions.setEnabled': (on) => session.decisions.setEnabled(on),
  'decisions.stats': () => session.decisions.stats(),
  prefetchCardProse: (ids) => session.prefetchCardProse(ids),
  cancelCardProse: () => session.cancelCardProse(),
  // Provider I/O must not occupy the serial simulation-message queue: snapshots,
  // ticks and cancellation need to keep running while narration arrives.
  requestCardProse: (id) => {
    session.requestCardProse(id).catch(() => {});
    return true;
  },
  'notes.set': (ref, key, text) => session.notes.set(ref, key, text),
  'notes.touch': (ref) => session.notes.touch(ref),
  dev: (name, args) => plain(session.dev(name, args)),
  inSim: async (source, args) => plain(await session.inSim(source, args)),
  snapshot: () => session.state,
  // Tests: the state's hash input, without the cost of sending the state.
  serialize: () => sim.serialize(session.state),
};

let stepErrors = 0;
function reportStepError(err) {
  if (stepErrors++ === 0) console.error('[hearthvale] sim step failed', err);
}

function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

let queue = Promise.resolve();
self.onmessage = ({data}) => {
  queue = queue.then(() => handle(data));
};

async function handle({id, op, args = []}) {
  let value, transfer = [];
  try {
    const fn = ops[op];
    if (!fn) throw new Error(`Unknown op ${op}`);
    const out = await fn(...args);
    // A handler may return [value, transfer list].
    if (Array.isArray(out) && out.length === 2 && Array.isArray(out[1]) && (op === 'init' || op === 'step')) [value, transfer] = out;
    else value = out;
  } catch (err) {
    self.postMessage({id, error: {message: String(err?.message ?? err), stack: err?.stack ?? null, code: err?.code ?? null}});
    return;
  }
  try {
    self.postMessage({id, value}, transfer);
  } catch (err) {
    self.postMessage({id, error: {message: `The reply could not be sent: ${err?.message ?? err}`, stack: err?.stack ?? null}});
  }
}
