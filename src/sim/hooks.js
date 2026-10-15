// System registry: how sim-world and sim-governance plug into the tick.
//
// A system is a plain object. Every hook is optional:
//
//   {
//     id: 'world' | 'governance' | ...,
//     order: number,                 // lower runs first inside each phase (governance 10, world 20)
//     init(state, ctx),              // after createState() has laid out the hamlet
//     restore(state, ctx),           // after restore(): rebuild transient indexes
//     tick(state, ctx),              // every 100 ms tick, before people move
//     month(state, ctx),             // month rollover, before pressures.applyDeltas
//     quarter(state, ctx),           // quarter rollover, after indicators are fresh
//     year(state, ctx),              // year rollover, after households and enterprises
//     yearEnd(state, ctx),           // after the era check (chronicle summaries)
//     fixture(state, name, ctx),     // enrich fixtureState(name) after the base synthesis
//     distribution(state, kind, subject, ctx) -> {[option]: p} | null,
//                                    // pooled decision answers (sim-governance's scheduler)
//     optionWeights(state, kind) -> {[option]: multiplier} | null,   // rules in force
//     addWear(state, x, z, amount),  // sim-world: wear accounting (falls back to raw wear +=)
//     actions: {name: fn},           // player actions (rule, setDelegated, ...)
//   }
//
// ctx = {services, rng: (stream) => number, monthIndex, flags, now}
// `services` is whatever main.js passed to stepTick ({decisions, routes, now}) or {}.

const systems = [];

export function registerSystem(system) {
  if (!system || typeof system.id !== 'string') throw new Error('registerSystem needs an object with an id.');
  const at = systems.findIndex((s) => s.id === system.id);
  if (at >= 0) systems.splice(at, 1);
  systems.push(system);
  systems.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return () => unregisterSystem(system.id);
}

export function unregisterSystem(id) {
  const at = systems.findIndex((s) => s.id === id);
  if (at >= 0) systems.splice(at, 1);
}

export const listSystems = () => systems;

export function runPhase(phase, state, ctx) {
  for (const s of systems) {
    if (typeof s[phase] === 'function') s[phase](state, ctx);
  }
}

// First system that answers wins.
export function firstAnswer(method, ...args) {
  for (const s of systems) {
    if (typeof s[method] !== 'function') continue;
    const value = s[method](...args);
    if (value != null) return value;
  }
  return null;
}

export function findAction(name) {
  for (const s of systems) {
    const fn = s.actions?.[name];
    if (typeof fn === 'function') return fn;
  }
  return null;
}

export function findHook(name) {
  for (const s of systems) {
    if (typeof s[name] === 'function') return s[name];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Actor choices. An actor's options get a distribution from the decision layer
// (sim-governance's pooled slice answers) or, when there is none, from a local prior.
// Local hard facts then scale options, masks remove them, and one draw picks the
// winner. Option keys are snake_case, as the decision service requires.
//
//   decide(state, 'household_stay_move', {type: 'household', record: h}, {
//     prior: {stay: 0.9, emigrate: 0.05, ...},   // used when no pooled answer exists
//     facts: {emigrate: 0.2},                    // multipliers (exp(λ·f) precomputed)
//     mask: ['stay', 'emigrate'],                // allowed options (default: all keys)
//     rng: () => number,
//   })

export function decisionDistribution(state, kind, subject) {
  return firstAnswer('distribution', state, kind, subject);
}

// Rule weights change only when rules do; cache them per tick.
let weightCache = {state: null, tick: -1, byKind: new Map()};
function optionWeightsFor(state, kind) {
  if (weightCache.state !== state || weightCache.tick !== state.time.tick) {
    weightCache = {state, tick: state.time.tick, byKind: new Map()};
  }
  const cache = weightCache.byKind;
  if (!cache.has(kind)) cache.set(kind, firstAnswer('optionWeights', state, kind));
  return cache.get(kind);
}

export function decide(state, kind, subject, {prior, facts = null, mask = null, rng}) {
  const pooled = decisionDistribution(state, kind, subject);
  const base = pooled ?? prior;
  // Rules in force scale option scores (e.g. commons: household_stay_move.stay x1.1).
  const ruleWeights = optionWeightsFor(state, kind);
  const options = mask ?? Object.keys(prior);
  const keys = [...options].sort();
  let total = 0;
  const weights = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let w = base[k] ?? 0;
    if (facts && facts[k] != null) w *= facts[k];
    if (ruleWeights && ruleWeights[k] != null) w *= ruleWeights[k];
    weights[i] = w > 0 && Number.isFinite(w) ? w : 0;
    total += weights[i];
  }
  if (total <= 0) return keys[0] ?? null;
  let x = rng() * total, last = null;
  for (let i = 0; i < keys.length; i++) {
    if (!(weights[i] > 0)) continue;
    last = keys[i];
    if ((x -= weights[i]) < 0) return last;
  }
  return last;
}

// Ids of registered systems that implement `phase`, in run order.
export const systemsWith = (phase) => systems.filter((s) => typeof s[phase] === 'function').map((s) => s.id);

export function runSystem(id, phase, state, ctx) {
  const s = systems.find((x) => x.id === id);
  if (s && typeof s[phase] === 'function') s[phase](state, ctx);
}
