// Compare town outcomes between who answered the decisions, against a noise floor
// (docs/design/decision-distillation.md §3.6).
//
//   node scripts/distill-towns.js --ref d1=DIR,DIR --cand student=DIR [--cand other=DIR] [--extra fallback=DIR] [--json OUT]
//
// Each DIR is a scripts/distill-collect.js output (towns.json). Runs of the same
// seed share a map and start; salts give them different luck. For every metric:
//   noise floor   the typical difference between two reference runs of the same
//                 seed (mean |a − b| over all same-seed pairs);
//   cand vs ref   the typical difference between a candidate run and a
//                 reference run of the same seed;
//   ratio         cand vs ref over the noise floor: about 1 when the candidate
//                 is as close to the reference as the reference is to itself;
//   shift         the mean signed difference (candidate − reference) over seeds,
//                 with a bootstrap 90% interval over runs.
// Population is compared on a log scale (so a ratio of towns, not people).
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const args = process.argv.slice(2);
const groups = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : [])).map((spec) => {
  const [name, dirs] = spec.split('=');
  return {name, dirs: dirs.split(',')};
});
const ref = groups('--ref')[0], cands = groups('--cand'), extras = groups('--extra');
if (!ref || !cands.length) throw new Error('usage: node scripts/distill-towns.js --ref d1=DIR[,DIR] --cand student=DIR [--extra name=DIR] [--json OUT]');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

const METRICS = {
  'log pop y50': (t) => logPop(t, 50),
  'log pop y100': (t) => logPop(t, 100),
  'log pop y150': (t) => logPop(t, 150),
  'work share, morning %': (t) => share(t, 'morning', 'work'),
  'work share, evening %': (t) => share(t, 'evening', 'work'),
  'wellbeing y150': (t) => t.town.find((r) => r.year === 150)?.wellbeing ?? NaN,
};
function logPop(t, year) {
  const r = t.town.find((x) => x.year === year);
  return r ? Math.log(Math.max(1, r.pop)) : NaN;
}
function share(t, time, option) {
  const row = t.shares?.[time];
  if (!row) return NaN;
  const sum = Object.values(row).reduce((a, b) => a + b, 0);
  return sum ? 100 * (row[option] ?? 0) / sum : NaN;
}

function load({name, dirs}) {
  const towns = dirs.flatMap((d) => JSON.parse(readFileSync(join(d, 'towns.json'), 'utf8')).towns.map((t) => ({...t, salt: t.salt ?? 0})));
  const bySeed = new Map();
  for (const t of towns) {
    if (!bySeed.has(t.seed)) bySeed.set(t.seed, []);
    bySeed.get(t.seed).push(t);
  }
  return {name, bySeed};
}

const R = load(ref), C = cands.map(load), E = extras.map(load);
const seeds = [...R.bySeed.keys()].filter((s) => C.every((c) => c.bySeed.has(s))).sort((a, b) => a - b);
let rand = 12345;
const random = () => ((rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0) / 4294967296);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function compare(cand, metric) {
  const f = METRICS[metric];
  const floor = [], across = [], shifts = [];
  for (const s of seeds) {
    const r = R.bySeed.get(s).map(f).filter(Number.isFinite), c = cand.bySeed.get(s).map(f).filter(Number.isFinite);
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) floor.push(Math.abs(r[i] - r[j]));
    for (const a of c) for (const b of r) across.push(Math.abs(a - b));
    if (r.length && c.length) shifts.push({r, c});
  }
  const shift = mean(shifts.map(({r, c}) => mean(c) - mean(r)));
  // Bootstrap: resample runs within each seed.
  const boots = [];
  for (let k = 0; k < 2000; k++) {
    boots.push(mean(shifts.map(({r, c}) => {
      const rr = r.map(() => r[Math.floor(random() * r.length)]), cc = c.map(() => c[Math.floor(random() * c.length)]);
      return mean(cc) - mean(rr);
    })));
  }
  boots.sort((a, b) => a - b);
  return {noiseFloor: floor.length ? mean(floor) : NaN, candVsRef: mean(across), ratio: mean(across) / mean(floor), shift,
    lo: boots[Math.floor(0.05 * boots.length)], hi: boots[Math.floor(0.95 * boots.length)], refRuns: floor.length ? undefined : 'one run per seed'};
}

const report = {seeds, ref: ref.name, runs: {}, metrics: {}};
for (const g of [R, ...C, ...E]) report.runs[g.name] = Object.fromEntries(seeds.map((s) => [s, (g.bySeed.get(s) ?? []).map((t) => ({salt: t.salt,
  pop150: t.town.find((r) => r.year === 150)?.pop ?? null, work: share(t, 'morning', 'work')}))]));
console.log(`${seeds.length} seeds; reference ${ref.name}: ${seeds.map((s) => R.bySeed.get(s).length).join('/')} runs per seed; ` +
  C.map((c) => `${c.name}: ${seeds.map((s) => c.bySeed.get(s).length).join('/')}`).join('; '));
for (const metric of Object.keys(METRICS)) {
  report.metrics[metric] = {};
  console.log(`\n${metric}`);
  for (const g of [...C, ...E]) {
    const r = compare(g, metric);
    report.metrics[metric][g.name] = r;
    console.log(`  ${g.name.padEnd(12)} noise floor ${r.noiseFloor.toFixed(3)}  vs ${ref.name} ${r.candVsRef.toFixed(3)}  ratio ${r.ratio.toFixed(2)}  ` +
      `shift ${r.shift >= 0 ? '+' : ''}${r.shift.toFixed(3)} [${r.lo.toFixed(3)}, ${r.hi.toFixed(3)}]`);
  }
}
console.log('\npopulation at year 150, per seed:');
for (const s of seeds) {
  console.log(`  ${s}: ` + [R, ...C, ...E].map((g) => `${g.name} ${(g.bySeed.get(s) ?? []).map((t) => t.town.find((r) => r.year === 150)?.pop ?? '?').join(',')}`).join(' | '));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
