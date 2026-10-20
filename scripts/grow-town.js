// Grow a late-game town headless and write it as a fixture save, for benchmarks that
// need more than the cached city (year 92). About 70 s for year 165.
//
//   node scripts/grow-town.js /tmp/metro.json            # seed 1888 to year 165
//   node scripts/grow-town.js /tmp/metro.json --year=140 --seed=2024
// (It stops at the year asked for once the town is in era 5 with 6,000 people, else
// up to five years later: the recipe the release benchmarks used.)
//
// The file loads anywhere a cached fixture does: scripts/benchmark-city.js --save=FILE,
// scripts/benchmark-desktop.js --save=FILE (served in place of ?fixture=city).
import {writeFileSync} from 'node:fs';
import {growFixture, fixtureText, FIXTURE_PROFILES} from '../src/sim/fixtures.js';

const [out, ...rest] = process.argv.slice(2);
if (!out) throw new Error('usage: node scripts/grow-town.js OUT.json [--year=165] [--seed=1888]');
const opts = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
const year = Number(opts.year ?? 165);
FIXTURE_PROFILES.grown = {seed: Number(opts.seed ?? 1888), cached: false, pop: 6000, era: 5, minYear: year, maxYear: year + 5, boost: 0.06, accept: 0.35, acceptBodies: 0.85};
const t0 = performance.now();
const state = growFixture('grown', {onYear: (s) => { if (s.time.year % 10 === 0) console.log(`year ${s.time.year}, era ${s.era}, ${s.indicators.pop} people, ${s.buildings.length} buildings`); }});
state.fixture.name = 'city';   // loads where the city fixture does
const text = fixtureText(state);
writeFileSync(out, text);
console.log(`${out}: year ${state.time.year}, ${state.indicators.pop} people, ${state.buildings.length} buildings, ${(text.length / 1048576).toFixed(1)} MB, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
