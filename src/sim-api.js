// The sim's API as the rest of the game uses it, built from its modules: the selectors
// and actions by name, saves, fixtures and the render view. ui/bridge.js builds it on
// the main thread and src/sim-worker.js in the worker, so both see the same shape.

export const SELECTORS = ['selectTopBar', 'selectDocket', 'selectBodies', 'selectRuleBook', 'selectTensions', 'selectFactions',
  'selectChronicle', 'selectEraProgress', 'selectUnlocks', 'selectInspect',
  // Optional: later-era surfaces and disasters.
  'selectEvents', 'selectBudget', 'selectCompass', 'selectEndPreview', 'selectCentres', 'selectApproval', 'selectBudgetSeason', 'selectAdvisers'];
export const ACTIONS = ['rule', 'dissolveBody', 'setIndividualCap', 'strikeBudgetLine', 'approveAllBudgets', 'trimAllToFit', 'hireAdviser', 'dismissAdviser', 'setAdviserMode', 'redrawSlate', 'letStand'];

export function realSim({index, view, fixtures = null, ser = null, rv = null}) {
  const pick = (name, ...mods) => mods.find((m) => typeof m?.[name] === 'function')?.[name];
  return {
    kind: 'real',
    pace: index.PACE ?? 1,
    createState: index.createState,
    stepTick: index.stepTick,
    serialize: pick('serialize', index, ser),
    restore: pick('restore', index, ser),
    fixtureState: pick('fixtureState', fixtures, index),
    loadFixture: pick('loadFixture', index, fixtures),
    seedCode: pick('seedCode', index),
    parseSeed: pick('parseSeed', index),
    useTerrainOf: pick('useTerrainOf', index),
    createRenderView: pick('createRenderView', rv, index),
    view: Object.fromEntries(SELECTORS.map((n) => [n, pick(n, view, index)])),
    actions: Object.fromEntries(ACTIONS.map((n) => [n, pick(n, index, view)])),
    dev: {},
  };
}
