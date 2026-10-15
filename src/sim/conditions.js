// The condition DSL: JSON s-expressions evaluated against the town.
//
//   ["gte", "P.riverTrade", 0.35]     ["lte", "I.foodBalance", 2]    ["gt"|"lt"|"eq", a, b]
//   ["between", "T.industry", 0.2, 0.7]
//   ["tag", "mill-built"]             ["tag", "flood", 10]           ["notag", "refused:x", 20]
//   ["has", "institution", "agri-council"]   ["has", "policy", "tithe", 2]   ["has", "building", "farm", 6]
//   ["era", 3]                        ["and", ...] ["or", ...] ["not", x]
//   ["soft", 0.6, [w1, pred1], [w2, pred2], ...]   1 when Σ w·sat / Σ w >= 0.6, else 0
//   ["ramp", "I.housingPressure", 0.3, 0.8]        0..1 linear (use inside soft)
//   ["torn", kind, dim1, dim2, minD, minN]         a slice intersection disagrees
//
// Paths: T.<trait>, P.<pressure>, I.<indicator>, C.<count>, year, month, era.
// Counts (C.*): any building type (C.farm), plus enterprises, institutions, policies,
// households, roads3 (cells with tier >= 3), bigEnterprises (>= 20 jobs), bridges.
// Operands may be numbers or paths.
//
// evalCond returns a number in [0, 1]. Hard predicates give 0 or 1. holds() is the
// boolean test (value >= 1). Other modules add ops with defineOp().

const EPS = 1e-9;
const ops = new Map();
const ctxCache = new WeakMap();

export function defineOp(name, fn) {
  ops.set(name, fn);
}

export function evalCond(expr, ctx) {
  if (expr == null || expr === true) return 1;
  if (expr === false) return 0;
  if (typeof expr === 'number') return clamp01(expr);
  if (!Array.isArray(expr)) throw new Error(`Bad condition: ${JSON.stringify(expr)}`);
  const fn = ops.get(expr[0]);
  if (!fn) throw new Error(`Unknown condition op: ${expr[0]}`);
  return clamp01(fn(expr, ctx));
}

export const holds = (expr, ctx) => evalCond(expr, ctx) >= 1 - EPS;

// Raw weighted score of a soft expression (for progress bars), or evalCond otherwise.
export function softScore(expr, ctx) {
  if (!Array.isArray(expr) || expr[0] !== 'soft') return evalCond(expr, ctx);
  let total = 0, sum = 0;
  for (const [w, pred] of expr.slice(2)) {
    total += w;
    sum += w * evalCond(pred, ctx);
  }
  return total > 0 ? sum / total : 0;
}

// Break a condition into readable terms: {op, value, terms?: [...]}. The UI turns these
// into labels (selectEraProgress).
export function explainCond(expr, ctx) {
  const value = evalCond(expr, ctx);
  if (!Array.isArray(expr)) return {expr, value};
  const [op] = expr;
  if (op === 'and' || op === 'or') {
    return {expr, op, value, terms: expr.slice(1).map((e) => explainCond(e, ctx))};
  }
  if (op === 'soft') {
    return {
      expr, op, value, threshold: expr[1], score: softScore(expr, ctx),
      terms: expr.slice(2).map(([w, pred]) => ({...explainCond(pred, ctx), weight: w})),
    };
  }
  return {expr, op, value, progress: progressOf(expr, ctx)};
}

// How far a comparison is toward being met (0..1). Used for "the town needs 120 people".
function progressOf(expr, ctx) {
  const [op, a, b] = expr;
  const va = operand(a, ctx), vb = operand(b, ctx);
  if (op === 'gte' || op === 'gt') return vb > 0 ? clamp01(va / vb) : (va >= vb ? 1 : 0);
  if (op === 'lte' || op === 'lt') return va <= vb ? 1 : (va > 0 ? clamp01(vb / va) : 0);
  return evalCond(expr, ctx);
}

// The evaluation context. Cheap to build: indicators are already cached in state;
// counts are computed once per tick and reused.
export function makeCtx(state) {
  const cached = ctxCache.get(state);
  if (cached && cached.tick === state.time.tick && cached.buildingCount === state.buildings.length) return cached;
  const ctx = {
    state,
    tick: state.time.tick,
    buildingCount: state.buildings.length,
    T: state.traits,
    P: state.pressures,
    I: state.indicators,
    C: countsOf(state),
    tags: state.tags,
    tagCounts: state.tagCounts,
    year: state.time.year,
    month: state.time.month,
    era: state.era,
    institutions: state.institutions,
    policies: state.policies,
  };
  ctxCache.set(state, ctx);
  return ctx;
}

// Drop the cached context, e.g. after a test mutates state between evaluations.
export const invalidateCtx = (state) => ctxCache.delete(state);

export function resolvePath(path, ctx) {
  if (path === 'year') return ctx.year;
  if (path === 'month') return ctx.month;
  if (path === 'era') return ctx.era;
  const dot = path.indexOf('.');
  if (dot < 0) throw new Error(`Bad condition path: ${path}`);
  const ns = path.slice(0, dot), key = path.slice(dot + 1);
  const table = ns === 'T' ? ctx.T : ns === 'P' ? ctx.P : ns === 'I' ? ctx.I : ns === 'C' ? ctx.C : null;
  if (!table) throw new Error(`Bad condition namespace: ${path}`);
  const value = ns === 'C' ? (table[key] ?? lazyCount(ctx, key)) : table[key];
  return Number.isFinite(value) ? value : 0;
}

const operand = (v, ctx) => (typeof v === 'string' ? resolvePath(v, ctx) : Number(v) || 0);
const clamp01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Number.isFinite(x) ? x : 0);
const bool = (b) => (b ? 1 : 0);

function countsOf(state) {
  const c = {
    enterprises: state.enterprises.length,
    households: state.households.length,
    institutions: 0,
    policies: 0,
    bigEnterprises: 0,
  };
  for (const b of state.buildings) {
    if (b.built < 1) continue;
    c[b.type] = (c[b.type] ?? 0) + 1;
  }
  c.bridges = c.bridge ?? 0;
  for (const inst of state.institutions) if (inst.status === 'active') c.institutions++;
  for (const id in state.policies) if (state.policies[id].level > 0) c.policies++;
  for (const e of state.enterprises) if (e.jobs >= 20) c.bigEnterprises++;
  return c;
}

function lazyCount(ctx, key) {
  if (key === 'roads3') {
    ctx.C.roads3 = roadCellsAtLeast(ctx.state, 3);
    return ctx.C.roads3;
  }
  return 0;
}

export function roadCellsAtLeast(state, tier) {
  const tiers = state.roads?.tier;
  if (!tiers) return 0;
  let n = 0;
  for (let i = 0; i < tiers.length; i++) if (tiers[i] >= tier) n++;
  return n;
}

const compare = (test) => (e, ctx) => bool(test(operand(e[1], ctx), operand(e[2], ctx)));

defineOp('gte', compare((a, b) => a >= b));
defineOp('lte', compare((a, b) => a <= b));
defineOp('gt', compare((a, b) => a > b));
defineOp('lt', compare((a, b) => a < b));
defineOp('eq', compare((a, b) => a === b));
defineOp('between', (e, ctx) => {
  const v = operand(e[1], ctx);
  return bool(v >= operand(e[2], ctx) && v <= operand(e[3], ctx));
});

defineOp('tag', (e, ctx) => {
  const year = ctx.tags[e[1]];
  if (year == null) return 0;
  return bool(e[2] == null || ctx.year - year <= e[2]);
});
defineOp('notag', (e, ctx) => 1 - ops.get('tag')(e, ctx));

defineOp('has', (e, ctx) => {
  const [, what, id, min = 1] = e;
  if (what === 'institution') return bool(ctx.institutions.some((i) => i.kind === id && i.status === 'active'));
  if (what === 'policy') return bool((ctx.policies[id]?.level ?? 0) >= min);
  if (what === 'building') return bool((ctx.C[id] ?? 0) >= min);
  throw new Error(`Unknown "has" target: ${what}`);
});

defineOp('era', (e, ctx) => bool(ctx.era >= e[1]));

defineOp('and', (e, ctx) => {
  let v = 1;
  for (let i = 1; i < e.length && v > 0; i++) v = Math.min(v, evalCond(e[i], ctx));
  return v;
});
defineOp('or', (e, ctx) => {
  let v = 0;
  for (let i = 1; i < e.length && v < 1; i++) v = Math.max(v, evalCond(e[i], ctx));
  return v;
});
defineOp('not', (e, ctx) => 1 - evalCond(e[1], ctx));

defineOp('soft', (e, ctx) => bool(softScore(e, ctx) >= e[1] - EPS));

defineOp('ramp', (e, ctx) => {
  const v = operand(e[1], ctx), lo = operand(e[2], ctx), hi = operand(e[3], ctx);
  if (hi === lo) return bool(v >= hi);
  return (v - lo) / (hi - lo);
});

// state.disagreement[kind][key] = {D, n, year}; key = "dim=value|dim=value" (sorted dims).
defineOp('torn', (e, ctx) => {
  const [, kind, dim1, dim2, minD = 0.25, minN = 12] = e;
  const table = ctx.state.disagreement?.[kind];
  if (!table) return 0;
  for (const key in table) {
    const row = table[key];
    if (row.D < minD || row.n < minN) continue;
    const dims = key.split('|').map((part) => part.split('=')[0]);
    if (dims.length === 2 && dims.includes(dim1) && dims.includes(dim2)) return 1;
  }
  return 0;
});
