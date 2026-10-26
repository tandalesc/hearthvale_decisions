// Resolves the simulation and renderer modules. Other agents build src/sim
// and src/render in parallel; import.meta.glob resolves to an empty object
// for files that do not exist yet, so the app builds and runs either way.
// URL params: ?stub=1 forces the stub sim, ?renderer=stub the stub renderer.

import {realSim, SELECTORS, ACTIONS} from '../sim-api.js';

const simIndex = import.meta.glob('../sim/index.js');
const simView = import.meta.glob('../sim/view.js');
const simFixtures = import.meta.glob('../sim/fixtures.js');
const simSerialize = import.meta.glob('../sim/serialize.js');
const simRenderView = import.meta.glob('../sim/render-view.js');
const renderMods = import.meta.glob(['../render/index.js', '../render/world.js', '../render/renderer.js']);
const factsMods = import.meta.glob('../sim/narrative-facts.js');
const narratorMods = import.meta.glob('../narrator-client.js');

async function first(globs) {
  for (const load of Object.values(globs)) {
    try { return await load(); } catch (err) { console.warn('[hearthvale] module failed to load', err); }
  }
  return null;
}

export async function loadSim(params) {
  const wantStub = params.get('stub') === '1';
  const [index, view] = wantStub ? [null, null] : await Promise.all([first(simIndex), first(simView)]);
  if (index?.stepTick && index?.createState && view?.selectDocket) {
    const [fixtures, ser, rv] = await Promise.all([first(simFixtures), first(simSerialize), first(simRenderView)]);
    return realSim({index, view, fixtures, ser, rv});
  }
  const [stub, stubView] = await Promise.all([import('./dev/stub-sim.js'), import('./dev/stub-view.js')]);
  return {
    kind: 'stub',
    createState: stub.createState,
    stepTick: stub.stepTick,
    serialize: stub.serialize,
    restore: stub.restore,
    fixtureState: stub.fixtureState,
    createRenderView: stub.createRenderView,
    view: Object.fromEntries(SELECTORS.map((n) => [n, stubView[n]])),
    actions: Object.fromEntries(ACTIONS.map((n) => [n, stub[n]])),
    dev: {advanceEra: stub.devAdvanceEra, foundBody: stub.devFoundBody, addCard: stub.devAddCard},
  };
}

export async function loadRenderer(params) {
  if (params.get('renderer') !== 'stub') {
    const mod = await first(renderMods);
    if (typeof mod?.createWorld === 'function') return {kind: 'real', createWorld: mod.createWorld};
  }
  const stub = await import('./dev/stub-world.js');
  return {kind: 'stub', createWorld: stub.createWorld};
}

// The narrator (inspector notes). Optional: without it the inspector shows
// the selector's rows only.
export async function loadNarrator(simKind) {
  if (simKind !== 'real') return null;
  const [facts, client] = await Promise.all([first(factsMods), first(narratorMods)]);
  if (!facts?.narrativeFacts || !client?.narrate) return null;
  const factsKey = facts.factsKey ?? ((f) => JSON.stringify(f));
  return {
    facts: facts.narrativeFacts,
    factsKey,
    // Stable across needs, activity and month: only meaningful changes move it.
    materialKey: facts.materialKey ?? factsKey,
    narrate: client.narrate,
    whyLines: client.whyLines ?? (() => []),
    // Kept notes (saved in the town) and background prose for cards.
    peekNote: client.peekNote ?? null,
    noteFor: client.noteFor ?? null,
    configureNotes: client.configureNotes ?? null,
    keepNote: client.keepNote ?? null,
    touchNote: client.touchNote ?? null,
    startProseKeeper: client.startProseKeeper ?? null,
  };
}
