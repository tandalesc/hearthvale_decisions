// One running town: the state and everything that writes to it (the sim step, the route
// planner, the decision client, the prose keeper, player actions, saves). Both hosts use
// it (src/sim-host.js): the inline host calls it on the main thread, and the sim worker
// (src/sim-worker.js) calls it for each message. Every call here is synchronous except
// init and narration requests; state writes run between ticks, never inside one.
import {entitledSpeed, isPaid} from './entitlements.js';
import {uiSnapshot, inspectBundle} from './sim-snapshot.js';
import {metaFromSave} from './save-meta.js';

// sim:       the sim API (ui/bridge.js loadSim, or sim-worker.js's own)
// narrator:  {facts, peekNote, keepNote, touchNote} for inspector bundles and notes, or null
// routes:    the route planner (or null)
// decisions: the decision client (or null: actors use local rules)
// students:  decision-student versions (src/decision-local.js createStudentVersions): each town takes the latest when it opens
// startProse: narrator-client's startProseKeeper, run while the model is on
// budgetMs:  real time a step may take before no new tick starts (Infinity: none)
export function createSimSession({sim, narrator = null, routes = null, decisions: client = null, startProse = null, budgetMs = 10, pace = 1, rowFloats = 20, lib = null,
  students = null, entitlement = {tier: 'free'}, localProse = null} = {}) {
  // Card quotes: Plus players through the hosted narrator, everyone through the local
  // narration student when there is one (localProse, see narration-student.js).
  const canProse = () => isPaid(entitlement) || !!localProse;
  let state = null;
  let view = null;
  let modelEnabled = true;
  let proseKeeper = null;
  let narrationPrefer = 'auto';   // Plus: 'auto' (not chosen: hosted first for cards), 'fast' (student first) or 'quality' (hosted first)
  // With the model off every ask resolves to null, so actors use local rules.
  const decisions = client && new Proxy(client, {
    get(target, key) {
      if (key === 'ask' && !modelEnabled) return () => Promise.resolve(null);
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const services = {decisions, routes, now: 0, rate: 0};

  function syncProse() {
    if (modelEnabled && state && !proseKeeper && startProse) proseKeeper = startProse(() => state, {local: localProse, remote: () => isPaid(entitlement), prefer: () => narrationPrefer});
    else if (!modelEnabled && proseKeeper) { proseKeeper.stop(); proseKeeper = null; }
  }

  function info() {
    return {
      townName: state.townName ?? null,
      seed: Number.isFinite(state.seed) ? state.seed : null,
      terrain: {seed: state.terrainSeed ?? null, version: state.terrainVersion ?? 1, archetype: state.terrainArchetype ?? null},
      meta: meta(),
    };
  }

  function meta() {
    try { return metaFromSave(state); } catch { return {}; }
  }

  return {
    get state() { return state; },
    get view() { return view; },

    // choice: {kind: 'new', seed, archetype, terrainVersion, individualCap, name}
    //       | {kind: 'raw', raw}          a save's text (a town on this device, or an import)
    //       | {kind: 'fixture', name}
    // Resolves {info} or {error: 'old-version' | 'invalid' | 'fixture'}; on an error the
    // town that was open (if any) stays open.
    async init(choice) {
      let s = null;
      if (choice.kind === 'new') {
        s = sim.createState(choice.seed ?? undefined, {
          archetype: choice.archetype ?? undefined,
          terrainVersion: choice.terrainVersion ?? undefined,
          ...(choice.individualCap ? {settings: {individualCap: choice.individualCap}} : {}),
        });
        if (choice.name) s.townName = choice.name;
      } else if (choice.kind === 'raw') {
        try {
          s = sim.restore(choice.raw);
        } catch (err) {
          if (state) sim.useTerrainOf?.(state);
          return {error: err?.code === 'old-version' ? 'old-version' : 'invalid'};
        }
      } else if (choice.kind === 'fixture') {
        try {
          s = sim.loadFixture ? await sim.loadFixture(choice.name) : sim.fixtureState?.(choice.name);
        } catch (err) {
          console.warn('[hearthvale] fixture failed to load', err);
        }
        if (!s) return {error: 'fixture'};
      }
      // A new town may reuse card IDs; cancel the old town's drafts and requests.
      proseKeeper?.stop();
      proseKeeper = null;
      state = s;
      // Every town records this play session's published student version.
      await students?.pin(state);
      view = sim.createRenderView ? sim.createRenderView(state, {rowFloats}) : null;
      syncProse();
      return {info: info()};
    },

    // Is raw a save this version can open? Leaves the open town's valley in place.
    check(raw) {
      try {
        sim.restore(raw);
        return true;
      } catch {
        return false;
      } finally {
        if (state) sim.useTerrainOf?.(state);
      }
    },

    // Real seconds owed to the sim at `speed`; `now` is the main thread's frame clock (ms).
    step(owed, now, speed) {
      speed = entitledSpeed(speed, entitlement);
      services.now = now;
      services.rate = speed * pace;
      if (!(speed > 0 && owed > 0) || !state) return {ticks: 0, ms: 0};
      const t0 = performance.now();
      let ticks = 0, error = null;
      try {
        routes?.tick?.(state);
        ticks = sim.stepTick(state, owed * speed * pace, services, {until: t0 + budgetMs});
      } catch (err) {
        error = err;
      }
      return {ticks: Number.isFinite(ticks) ? ticks : 0, ms: performance.now() - t0, error};
    },

    // The render view, synced to the main thread's frame time (ms).
    sync(now, speed) {
      services.now = now;
      view?.sync(state, {now: now / 1000, speed: speed * pace});
      return view;
    },

    act(name, args = []) {
      const fn = sim.actions[name];
      if (!fn) return {ok: false, text: 'That is not ready yet.'};
      return fn(state, ...args);
    },

    setIndividualCap(v) {
      if (sim.actions.setIndividualCap) sim.actions.setIndividualCap(state, v);
      else if (state.settings) state.settings.individualCap = v;
    },

    ui(req) {
      if (!state) return null;
      const snap = uiSnapshot(sim, state, req, narrator);
      // Narration previews belong only to the UI snapshot, never the saved town.
      if (canProse() && proseKeeper?.peekCard && Array.isArray(snap.docket)) {
        snap.docket = snap.docket.map(card => {
          const preview = proseKeeper.peekCard(card.id);
          return preview ? {...card, streamingProse: preview} : card;
        });
      }
      if (client) snap.decisionStats = client.stats();
      snap.narrationStats = proseKeeper?.stats?.() ?? null;
      return snap;
    },

    inspect(target) {
      return state ? inspectBundle(sim, state, target, narrator) : null;
    },

    save() {
      return {text: sim.serialize(state), meta: meta()};
    },

    narration: {
      stats: () => proseKeeper?.stats?.() ?? null,
      // Settings: load the student if it has not been needed yet, and report.
      refresh() { localProse?.preload?.(); return proseKeeper?.stats?.() ?? null; },
      configure({prefer} = {}) { if (prefer === 'auto' || prefer === 'fast' || prefer === 'quality') narrationPrefer = prefer; },
    },

    decisions: {
      stats: () => client?.stats() ?? null,
      configure: (settings) => { client?.configure(settings); },
      setEnabled(on) {
        modelEnabled = on;
        if (!on) client?.reset();
        syncProse();
      },
    },

    prefetchCardProse: (ids) => { if (canProse()) proseKeeper?.prefetchCards?.(ids); },
    cancelCardProse: () => proseKeeper?.cancel?.(),
    requestCardProse: (id) => (canProse() ? proseKeeper?.requestCard?.(id) : null) ?? Promise.resolve(null),

    notes: {
      set: (ref, key, text) => { if (state) narrator?.keepNote?.(state, ref, key, text); },
      touch: (ref) => { if (state) narrator?.touchNote?.(state, ref); },
    },

    // For the inline host, which loads the narrator after the town opens.
    useNarrator(n, prose = null) {
      narrator = n;
      startProse = prose;
      syncProse();
    },

    dev(name, args = []) {
      return sim.dev?.[name]?.(state, ...args);
    },

    // Dev and test hook: runs a function's source here with (state, sim, ...args).
    // Its result must be structured-cloneable; a promise is awaited.
    inSim(source, args = []) {
      const fn = new Function(`return (${source});`)();
      return fn(state, lib ?? sim, ...args);
    },

    dispose() {
      proseKeeper?.stop();
      proseKeeper = null;
    },
  };
}
