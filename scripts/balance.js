// Balance harness: grows towns headless for 150 years under three play styles and
// prints how they develop. Each run is a child process, so the cores share the work.
//
//   node scripts/balance.js [--seeds 10] [--years 150] [--styles frugal,balanced,generous] [--json out.json]
//
// A run uses the real systems with fallback answers (no decision service) and a
// stand-in council (src/sim/fixtures.js) that rules every card once.
import {fork} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {STYLES} from './council-styles.js';

const SAMPLE_YEARS = [10, 25, 35, 60, 65, 100, 140, 150];
const DEFAULT_STYLES = Object.keys(STYLES).join(',');

async function runChild() {
  const {createState, stepTick} = await import('../src/sim/index.js');
  const {standInCouncil} = await import('../src/sim/fixtures.js');
  process.on('message', ({seed, style, years}) => {
    const state = createState(seed);
    const council = standInCouncil({seed, ...STYLES[style]});
    const rows = [], mix = [];
    let receivership = 0;
    while (state.time.year < years) {
      const y = state.time.year;
      while (state.time.year === y) {
        stepTick(state, 4, {}, {skipPeople: true});
        council(state);
      }
      const I = state.indicators;
      if (state.governance?.receivership) receivership++;
      if (state.time.year % 40 === 0) mix.push(enterpriseMix(state));
      rows.push({year: state.time.year, archetype: state.archetype, pop: I.pop, tier: +I.avgHomeTier.toFixed(2), tYears: +treasuryYears(state).toFixed(2),
        treasury: Math.round(state.treasury), era: state.era, wellbeing: I.wellbeing, buildings: state.buildings.length});
    }
    const eras = state.eraEntered.map((year, n) => ({n, year, late: !!state.tags[`era-late:${n}`]})).slice(1);
    const centres = (state.centres ?? []).map((c) => ({id: c.id, pop: c.pop, rank: c.rank, founded: c.founded, merged: c.mergedInto != null, character: c.character}));
    const overtook = Object.keys(state.tags).some((t) => t.startsWith('centre-overtook:'));
    process.send({seed, style, rows, mix, eras, archetype: state.archetype, receivership, centres, overtook, policies: Object.values(state.policies).filter((p) => p.level > 0).length,
      bodies: state.institutions.filter((i) => i.status === 'active').length});
  });
}

// Bid-rent check: the share of farms and workshops among enterprises on the dearest
// third of land, against the cheapest third; and shops and inns likewise.
function enterpriseMix(state) {
  const ents = state.enterprises.filter((e) => !e.public && Number.isFinite(e.landValue)).sort((a, b) => a.landValue - b.landValue);
  const third = Math.floor(ents.length / 3);
  const share = (list, types) => (list.length ? list.filter((e) => types.includes(e.type)).length / list.length : 0);
  const cheap = ents.slice(0, third), dear = ents.slice(ents.length - third);
  const land = ['farm', 'workshop', 'mill', 'warehouse'], trade = ['shop', 'inn', 'market', 'exchange'];
  return {year: state.time.year, dearLand: share(dear, land), cheapLand: share(cheap, land), dearTrade: share(dear, trade), cheapTrade: share(cheap, trade)};
}

// Treasury in years of the last year's spending (negative when in debt).
function treasuryYears(state) {
  const spend = state.economy.lastYear.treasurySpend ?? 0;
  return spend > 0 ? state.treasury / spend : 0;
}

async function runParent() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const seeds = Number(arg('seeds', 10)), years = Number(arg('years', 150));
  const styles = arg('styles', DEFAULT_STYLES).split(',');
  const jobs = [];
  for (const style of styles) for (let k = 0; k < seeds; k++) jobs.push({seed: 1000 + k * 7919, style, years});
  // Three workers by default: the machine is shared (pass --workers to change it).
  const workers = Number(arg('workers', Math.min(3, availableParallelism())));
  const results = await pool(jobs, Math.max(1, workers));
  for (const style of styles) report(style, results.filter((r) => r.style === style));
  const at100 = new Set(results.map((r) => r.rows.find((row) => row.year === 100)?.archetype).filter(Boolean));
  console.log(`\ndistinct archetypes by year 100 across all runs: ${at100.size} (${[...at100].join(', ')})`);
  const out = arg('json', null);
  if (out) writeFileSync(out, JSON.stringify(results));
}

function pool(jobs, size) {
  return new Promise((resolve) => {
    const results = [];
    let next = 0, running = 0;
    const self = fileURLToPath(import.meta.url);
    const launch = () => {
      while (running < size && next < jobs.length) {
        const job = jobs[next++];
        running++;
        const child = fork(self, ['--child']);
        child.on('message', (r) => {
          results.push(r);
          child.kill();
          running--;
          process.stderr.write(`.`);
          if (results.length === jobs.length) { process.stderr.write('\n'); resolve(results); } else launch();
        });
        child.send(job);
      }
    };
    launch();
  });
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};

function report(style, runs) {
  console.log(`\n== ${style} (${runs.length} seeds; medians, [min..max] for treasury years)`);
  console.log('year   pop    tier  tYears           era  wellbeing  buildings');
  for (const y of SAMPLE_YEARS) {
    const rows = runs.map((r) => r.rows.find((row) => row.year === y)).filter(Boolean);
    if (!rows.length) continue;
    const ty = rows.map((r) => r.tYears);
    console.log(`${String(y).padStart(4)} ${String(median(rows.map((r) => r.pop))).padStart(6)} ${median(rows.map((r) => r.tier)).toFixed(2).padStart(6)} ` +
      `${median(ty).toFixed(2).padStart(6)} [${Math.min(...ty).toFixed(1)}..${Math.max(...ty).toFixed(1)}]`.padEnd(24) +
      `${String(median(rows.map((r) => r.era))).padStart(3)} ${String(median(rows.map((r) => r.wellbeing))).padStart(9)} ${String(median(rows.map((r) => r.buildings))).padStart(10)}`);
  }
  const entries = runs.flatMap((r) => r.eras);
  const byEra = {};
  for (const e of entries) (byEra[e.n] ??= []).push(e);
  const eraLine = Object.entries(byEra).map(([n, list]) => `era ${n}: median year ${median(list.map((e) => e.year))}, merit ${Math.round((100 * list.filter((e) => !e.late).length) / list.length)}% (${list.length}/${runs.length})`);
  console.log(eraLine.join('; '));
  const healthy = runs.flatMap((r) => r.rows.filter((row) => row.year >= 10)).map((row) => row.tYears);
  console.log(`treasury 0.5-5 yrs: ${Math.round((100 * healthy.filter((t) => t >= 0.5 && t <= 5).length) / healthy.length)}% of years; in debt: ${Math.round((100 * healthy.filter((t) => t < 0).length) / healthy.length)}%; receivership years (median): ${median(runs.map((r) => r.receivership))}`);
  const arch = {}, arch100 = {};
  for (const r of runs) {
    arch[r.archetype] = (arch[r.archetype] ?? 0) + 1;
    const at = r.rows.find((row) => row.year === 100)?.archetype;
    if (at) arch100[at] = (arch100[at] ?? 0) + 1;
  }
  const list = (m) => Object.entries(m).map(([a, n]) => `${a} ${n}`).join(', ');
  console.log(`archetypes at 100: ${list(arch100)}; at the end: ${list(arch)}; rules ${median(runs.map((r) => r.policies))}, bodies ${median(runs.map((r) => r.bodies))}`);
  // Bid-rent sorting: land-hungry work should leave the dearest land over time.
  const mixAt = (y) => runs.map((r) => (r.mix ?? []).find((m) => m.year === y)).filter(Boolean);
  const pct = (xs) => `${Math.round(100 * median(xs))}%`;
  console.log('enterprise mix (dear land vs cheap land): ' + [40, 80, 120].map((y) => {
    const m = mixAt(y);
    return m.length ? `y${y} farms/workshops ${pct(m.map((x) => x.dearLand))} vs ${pct(m.map((x) => x.cheapLand))}, shops/inns ${pct(m.map((x) => x.dearTrade))} vs ${pct(m.map((x) => x.cheapTrade))}` : '';
  }).filter(Boolean).join('; '));
  // Centres (design-centres.md §9): runs with two or more centres above 800 people,
  // runs that stay monocentric, and runs where a second centre overtook the seat or merged.
  const big = runs.map((r) => (r.centres ?? []).filter((c) => !c.merged && c.pop >= 800).length);
  const founded = runs.map((r) => (r.centres ?? []).length);
  console.log(`centres: ≥2 above 800 people in ${big.filter((n) => n >= 2).length}/${runs.length} runs; monocentric ${big.filter((n) => n <= 1).length}/${runs.length}; ` +
    `centres founded (median) ${median(founded)}; overtook the seat in ${runs.filter((r) => r.overtook).length}; merged in ${runs.filter((r) => (r.centres ?? []).some((c) => c.merged)).length}`);
}

if (process.argv[2] === '--child') runChild();
else await runParent();
