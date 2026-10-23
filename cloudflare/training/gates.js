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
