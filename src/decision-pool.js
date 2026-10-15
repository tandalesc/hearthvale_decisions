// Population pooling: combine per-slice answer distributions into one
// distribution per person, and find where the pooled picture is weakest.
//
// Pure functions over plain {option: probability} maps; shared by the browser
// policies and the simulation. Missing options count as probability 0.
//
//   pool(dists, {weights, combine, localTerms, allowed}) -> dist | null
//   pool({sliceDists, weights, combine, localTerms, allowed}) is the same call.
//     Weighted linear opinion pool (default): p(a) = sum_i w_i p_i(a) / sum_i w_i.
//     Never more confident than the most confident input (a mean of
//     distributions cannot exceed its largest element anywhere).
//     combine: 'min' takes the elementwise minimum and renormalizes. That is
//     conservative per option, but renormalizing can make the result SHARPER
//     than every input (e.g. min of {a:.6,b:.4} and {a:.9,b:.1} -> {a:.86,b:.14}),
//     so 'mean' stays the default. 'min' floors inputs at epsilon so one
//     slice cannot veto an option outright.
//     Then local terms (hard personal facts) multiply in, options outside
//     `allowed` are masked, and the result is renormalized.
//
//   jsDivergence(dists, weights) -> generalized Jensen-Shannon divergence in
//     nats: H(mean) - mean(H(p_i)). 0 when all slices agree.
//
//   refinementTargets(groups, opts) -> the membership groups most worth a
//     refinement question, highest disagreement x size first.

export const DEFAULT_EPSILON = 1e-3;

export function optionsOf(dists, allowed) {
  if (allowed) return [...allowed];
  const seen = new Set();
  for (const d of dists) for (const k of Object.keys(d ?? {})) seen.add(k);
  return [...seen];
}

// Scale a map to sum 1 over `options`; uniform when there is no mass at all.
export function normalize(dist, options = Object.keys(dist)) {
  let sum = 0;
  for (const o of options) sum += Math.max(0, dist[o] ?? 0);
  const out = {};
  for (const o of options) out[o] = sum > 0 ? Math.max(0, dist[o] ?? 0) / sum : 1 / options.length;
  return out;
}

export function pool(dists, settings = {}) {
  if (!Array.isArray(dists)) ({sliceDists: dists, ...settings} = dists ?? {});
  const {weights, combine = 'mean', localTerms, allowed, epsilon = DEFAULT_EPSILON} = settings;
  if (!Array.isArray(dists)) return null;
  const inputs = dists.map((d, i) => ({d, w: weights?.[i] ?? 1})).filter(({d, w}) => d && w > 0);
  if (!inputs.length) return null;
  const options = optionsOf(inputs.map((x) => x.d), allowed);
  if (!options.length) return null;
  const universe = [...new Set([...optionsOf(inputs.map((x) => x.d)), ...options])];
  let combined;
  if (combine === 'min') {
    combined = {};
    for (const o of universe) combined[o] = Math.min(...inputs.map(({d}) => Math.max(epsilon, d[o] ?? 0)));
  } else {
    const total = inputs.reduce((n, x) => n + x.w, 0);
    combined = {};
    for (const o of universe) combined[o] = inputs.reduce((n, {d, w}) => n + w * (d[o] ?? 0), 0) / total;
  }
  combined = normalize(combined, universe);
  for (const terms of [].concat(localTerms ?? [])) {
    for (const [o, m] of Object.entries(terms ?? {})) if (o in combined) combined[o] *= Math.max(0, m);
  }
  return normalize(combined, options);
}

export function entropy(dist) {
  let h = 0;
  for (const p of Object.values(dist ?? {})) if (p > 0) h -= p * Math.log(p);
  return h;
}

// 0 for a certain answer, 1 for uniform over `n` options.
export const normalizedEntropy = (dist, n = Object.keys(dist ?? {}).length) => (n > 1 ? entropy(dist) / Math.log(n) : 0);
export const confidence = (dist, n) => 1 - normalizedEntropy(dist, n);

export function jsDivergence(dists, weights) {
  const inputs = dists.map((d, i) => ({d, w: weights?.[i] ?? 1})).filter(({d, w}) => d && w > 0);
  if (inputs.length < 2) return 0;
  const total = inputs.reduce((n, x) => n + x.w, 0);
  const options = optionsOf(inputs.map((x) => x.d));
  const mean = {};
  for (const o of options) mean[o] = inputs.reduce((n, {d, w}) => n + w * (d[o] ?? 0), 0) / total;
  const meanH = inputs.reduce((n, {d, w}) => n + w * entropy(d), 0) / total;
  const d = entropy(mean) - meanH;
  return d > 1e-12 ? d : 0; // identical inputs: exactly 0, not rounding noise
}

export const disagreement = jsDivergence;

// Total-variation distance, for drift and refinement agreement.
export function tvDistance(a, b) {
  const options = optionsOf([a, b]);
  return options.reduce((n, o) => n + Math.abs((a[o] ?? 0) - (b[o] ?? 0)), 0) / 2;
}

// Canonical key for a person's slice memberships: 'dim=value|dim=value'.
export function membershipSignature(memberships) {
  return Object.entries(memberships)
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

// groups: [{signature, size, dists, weights?, importance?, highStakes?}]
// -> [{signature, score, disagreement, entropy, mode}] best first, at most
// `budget`. mode is 'individual' for tiny or high-stakes groups, else
// 'intersection' (one question for the whole group).
export function refinementTargets(groups, {budget = Infinity, threshold = 0.01, smallGroup = 3, highStakes = false} = {}) {
  const scored = [];
  for (const g of groups) {
    const disagreement = jsDivergence(g.dists, g.weights);
    if (disagreement < threshold || !g.size) continue;
    const pooled = pool(g.dists, {weights: g.weights});
    const score = disagreement * g.size * (g.importance ?? 1);
    const individual = highStakes || g.highStakes || g.size <= smallGroup;
    scored.push({signature: g.signature, score, disagreement, entropy: pooled ? entropy(pooled) : 0, size: g.size, mode: individual ? 'individual' : 'intersection'});
  }
  scored.sort((a, b) => b.score - a.score || (a.signature < b.signature ? -1 : 1));
  return scored.slice(0, budget);
}

export const planRefinement = (...args) => refinementTargets(...args);

// Use a refinement answer in place of the pool ('replace'), or blend it in
// with weight equal to its agreement with the pool, 1 - TV ('agree'), so a
// wildly different refinement moves the pool less.
export function blendRefinement(pooled, refined, mode = 'replace') {
  if (!refined) return pooled;
  if (!pooled || mode === 'replace') return refined;
  const alpha = 1 - tvDistance(pooled, refined);
  const options = optionsOf([pooled, refined]);
  const out = {};
  for (const o of options) out[o] = alpha * (refined[o] ?? 0) + (1 - alpha) * (pooled[o] ?? 0);
  return normalize(out, options);
}
