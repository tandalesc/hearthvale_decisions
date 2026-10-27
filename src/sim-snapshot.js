// What the UI draws, read from the state in one go: the UI snapshot of
// docs/design/sim-worker.md §4.4. It runs wherever the state is (the sim worker, or the
// main thread with the inline host); app.js draws the result and never reads state.
//
//   uiSnapshot(sim, state, {recent, factions, want, chronicleLimit, inspect}, narrator)
//
// Selector outputs are raw (app.js maps them through ui/model.js); a selector that
// throws gives null, as app.js's safe() did. `want` names the views on screen: 'rules',
// 'people', 'chronicle', 'tensions', 'moot' (the Town Council's purse), 'rulings'
// (the Council's "Your rulings" ledger) and 'endpage' (the town's story at year 150). Everything
// in it must survive structuredClone.

export function uiSnapshot(sim, state, req = {}, narrator = null) {
  const V = sim.view;
  const want = new Set(req.want ?? []);
  const out = {
    want: [...want],
    townName: state.townName ?? null,
    seed: Number.isFinite(state.seed) ? state.seed : null,
    individualCap: state.settings?.individualCap ?? null,
    top: run(() => V.selectTopBar(state)),
    unlocks: run(() => V.selectUnlocks(state)),
    docket: run(() => V.selectDocket(state)),
    bodies: run(() => V.selectBodies(state)),
    eraProgress: run(() => V.selectEraProgress(state)),
    chronicle: run(() => V.selectChronicle(state, {limit: req.recent ?? 40})),
    events: run(() => V.selectEvents?.(state)),
    centres: run(() => V.selectCentres?.(state)),
  };
  if (req.factions) out.factions = run(() => V.selectFactions(state));
  const u = out.unlocks ?? {};
  out.season = u.budgets ? run(() => V.selectBudgetSeason?.(state)) : null;
  out.advisers = u.advisers ? run(() => V.selectAdvisers?.(state)) : null;

  const panels = {};
  if (want.has('rules')) panels.ruleBook = run(() => V.selectRuleBook(state));
  if (want.has('people')) {
    panels.factions = run(() => V.selectFactions(state));
    if (u.compass) panels.compass = run(() => V.selectCompass?.(state));
    if (u.approval) panels.approval = run(() => V.selectApproval?.(state));
  }
  if (want.has('chronicle')) {
    panels.chronicle = run(() => V.selectChronicle(state, {limit: req.chronicleLimit}));
    panels.chronicleTotal = state.chronicle?.entries?.length ?? null;
    if (u.endPreview) panels.endPreview = run(() => V.selectEndPreview?.(state));
  }
  if (want.has('tensions')) panels.tensions = run(() => V.selectTensions(state));
  if (want.has('moot') && u.budget) panels.budget = run(() => V.selectBudget?.(state));
  if (want.has('rulings')) panels.rulings = run(() => V.selectRulings?.(state));
  if (want.has('endpage') && u.endPage) panels.endPage = run(() => V.selectEndPage?.(state));
  out.panels = panels;

  // The ambience reads a few raw fields.
  out.audio = {
    wind: state.weather?.wind ?? null,
    rain: state.weather?.rain,
    snow: state.weather?.snow,
    festival: (state.worldEvents ?? []).some((e) => e.kind === 'festival' || e.kind === 'market'),
    building: (state.projects ?? []).length,
  };
  if (req.inspect) out.inspect = inspectBundle(sim, state, req.inspect, narrator);
  return out;
}

// The inspector's view of one thing ({personId} or {buildingId}): the selector's model,
// the narrator's fact sheet and the kept note (peekNote), all null when it is gone.
export function inspectBundle(sim, state, target, narrator = null) {
  return {
    target,
    model: run(() => sim.view.selectInspect?.(state, target)),
    facts: narrator?.facts ? run(() => narrator.facts(state, target)) : null,
    peek: narrator?.peekNote ? run(() => narrator.peekNote(state, target)) : null,
  };
}

let warned = false;
function run(fn) {
  try {
    return fn() ?? null;
  } catch (err) {
    if (!warned) { warned = true; console.warn('[hearthvale] selector failed', err); }
    return null;
  }
}
