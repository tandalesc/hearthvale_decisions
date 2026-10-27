// Automatic publication is deliberately conservative: a population regression
// holds a candidate for investigation even when model and work-share gates pass.
export function evaluateCanaryPopulation(current, candidate, expectedSeeds) {
  const result = {pass: false, maxDecline: 0.1, expectedSeeds, current: null, next: null, ratio: null, measurements: []};
  if (!current?.ok || !candidate?.ok || !Array.isArray(expectedSeeds) || !expectedSeeds.length || new Set(expectedSeeds).size !== expectedSeeds.length) return {...result, reason: 'Both canary runs must finish with a nonempty unique seed schedule'};
  const collect = run => {
    if (!Array.isArray(run.towns) || run.towns.length !== expectedSeeds.length) return null;
    const values = new Map();
    for (const town of run.towns) {
      const pop = town.town?.at(-1)?.pop;
      if (!expectedSeeds.includes(town.seed) || values.has(town.seed) || !Number.isFinite(pop) || pop <= 0) return null;
      values.set(town.seed, pop);
    }
    return values.size === expectedSeeds.length ? values : null;
  };
  const old = collect(current), next = collect(candidate);
  if (!old || !next) return {...result, reason: 'Missing, nonpositive, nonfinite, duplicate, or mismatched population measurements'};
  const geometricMean = values => Math.exp([...values.values()].reduce((sum, value) => sum + Math.log(value), 0) / values.size);
  result.current = geometricMean(old); result.next = geometricMean(next); result.ratio = result.next / result.current;
  result.measurements = expectedSeeds.map(seed => ({seed, current: old.get(seed), next: next.get(seed)}));
  result.pass = result.ratio + 1e-12 >= 1 - result.maxDecline;
  if (!result.pass) result.reason = 'Candidate population geometric mean declined more than 10%; investigate before publication';
  return result;
}

// Active kind coverage, by what the candidate's canary towns asked (review A7).
// A kind the current bundle answers and the canaries asked at least `minAsked`
// times must be in the candidate: asked but not present fails. A kind the current
// bundle answers that no canary asked is reported as `untested` and does not fail,
// since the town gates say nothing about it either way. `requireKinds` must be in
// the bundle AND asked; it defaults to none. strike_resolve belongs there once a
// canary forces a strike: today no canary asks one (review A7), so requiring it
// would hold every candidate. `asked` is {kind: count}; null (counts missing) fails.
export const RETIRED_KINDS = ['enterprise_type_for_site'];
export function evaluateKindCoverage({previousKinds = [], bundleKinds = [], asked = null, requireKinds = [], retired = RETIRED_KINDS, excludeKinds = [], minAsked = 1} = {}) {
  const keep = kind => !retired.includes(kind) && !excludeKinds.includes(kind);
  const active = [...new Set(previousKinds)].filter(keep), required = [...new Set(requireKinds)].filter(keep);
  if (!asked || typeof asked !== 'object') return {pass: false, active, required, missing: [], notAsked: required, untested: active, minAsked, reason: 'Canary asked-kind counts unavailable'};
  const wasAsked = kind => (asked[kind] ?? 0) >= minAsked;
  const checked = [...new Set([...active.filter(wasAsked), ...required])];
  const missing = checked.filter(kind => !bundleKinds.includes(kind));
  const notAsked = required.filter(kind => !wasAsked(kind));
  const untested = active.filter(kind => !wasAsked(kind) && !required.includes(kind));
  const result = {pass: !missing.length && !notAsked.length, active, required, missing, notAsked, untested, minAsked,
    asked: Object.fromEntries([...new Set([...active, ...required])].map(kind => [kind, asked[kind] ?? 0]))};
  if (!result.pass) result.reason = missing.length ? 'Candidate bundle lacks a kind the canary towns asked' : 'A required kind was never asked in the canary towns';
  return result;
}
// Asked counts by kind from a distill-collect.js questions.jsonl (rows {kind, n, aug}):
// need-variant copies (aug) are not questions the town asked.
// Takes an array or an async iterable (streamed lines); resolves to {kind: count}.
export async function askedKinds(rows) {
  const asked = {};
  for await (const row of rows) if (!row.aug) asked[row.kind] = (asked[row.kind] ?? 0) + (Number.isFinite(row.n) ? row.n : 1);
  return asked;
}

// Independent checks on a candidate bundle, with the student code the browser runs
// (src/decision-student.js). The worker runs these on the uploaded bundle itself
// rather than trusting the trainer's report (review C3); the loops run the same
// parity through scripts/distill-check-student.js.
//   parity: every embedded fixture row's probabilities (and expected KL, when the
//           bundle has a confidence head) match what the trainer recorded;
//   size:   weights + vocabulary as JSON within maxBundleKB, the loops' measure.
export function bundleKB(bundle) { return (JSON.stringify(bundle.weights).length + JSON.stringify(bundle.vocab).length) / 1024; }
export function checkBundleParity(student, {minRows = 8, tolerance = 1e-4, confTolerance = 1e-3} = {}) {
  const rows = student.fixture ?? [];
  let worst = 0, worstConf = 0, checked = 0;
  for (const row of rows) {
    if (!student.kinds.has(row.kind) || !Array.isArray(row.options) || !Array.isArray(row.probabilities) || row.probabilities.length !== row.options.length) return {pass: false, rows: rows.length, reason: 'Malformed fixture row'};
    const p = student.fromTriples(row.kind, row.triples, row.options);
    for (let i = 0; i < p.length; i++) worst = Math.max(worst, Number.isFinite(p[i]) ? Math.abs(p[i] - row.probabilities[i]) : Infinity);
    if (student.hasConfidence && row.expected_kl != null) {
      const e = student.expectedFromTriples(row.kind, row.triples, row.options);
      worstConf = Math.max(worstConf, Number.isFinite(e) ? Math.abs(e - row.expected_kl) / Math.max(1e-3, row.expected_kl) : Infinity);
    }
    checked++;
  }
  const pass = checked >= minRows && worst < tolerance && worstConf < confTolerance;
  return {pass, rows: checked, worst, worstConf, ...(pass ? {} : {reason: checked < minRows ? `Fixture needs at least ${minRows} rows` : 'JS forward pass differs from the trainer\'s fixture'})};
}
// Mean KL(teacher ‖ student) over teacher-labelled rows {kind, triples, options, target},
// for each student, on the rows every student answers (paired: one sample, all models).
export function realplayKL(students, rows, {excludeKinds = []} = {}) {
  const usable = rows.filter(r => !excludeKinds.includes(r.kind) && students.every(s => s.kinds.has(r.kind)) && Array.isArray(r.target) && r.target.length === r.options?.length);
  const kl = students.map(s => {
    let sum = 0;
    for (const r of usable) {
      const q = s.fromTriples(r.kind, r.triples, r.options);
      for (let i = 0; i < q.length; i++) if (r.target[i] > 0) sum += r.target[i] * Math.log(r.target[i] / Math.max(1e-9, Number.isFinite(q[i]) ? q[i] : 0));
    }
    return usable.length ? sum / usable.length : NaN;
  });
  return {rows: usable.length, kl};
}
