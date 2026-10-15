// Growth regression guard: balanced play must not starve while farms exist, and towns
// at year 60 (the mean of the seeds) must not fall more than 25% below the balance pass's table (1,597
// people, the median of scripts/balance.js, balanced style, 5 seeds). Faster growth is
// allowed up to twice the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, stepTick} from '../src/sim/index.js';
import {standInCouncil} from '../src/sim/fixtures.js';

const BALANCED = {accept: 0.35, acceptBodies: 0.85, spendShare: 0.3};
const TABLE_POP_60 = 1597;
const SEEDS = [1000, 24757];

function grow(seed, years) {
  const state = createState(seed);
  const council = standInCouncil({seed, ...BALANCED});
  const yearly = [];
  while (state.time.year < years) {
    const year = state.time.year;
    while (state.time.year === year) {
      stepTick(state, 4, {}, {skipPeople: true});
      council(state);
    }
    const hunger = state.households.reduce((n, h) => n + (h.hunger ?? 0) * h.size, 0) / Math.max(1, state.indicators.pop);
    yearly.push({year: state.time.year, pop: state.indicators.pop, hunger, farms: state.enterprises.filter((e) => e.type === 'farm').length});
  }
  return yearly;
}

test('balanced towns never starve before year 100 while they have farms, and keep their size at year 60', {timeout: 240000}, () => {
  const at60 = [];
  for (const seed of SEEDS) {
    const rows = grow(seed, 100);
    let peak = 0;
    for (const r of rows) {
      peak = Math.max(peak, r.pop);
      if (r.farms === 0) continue;
      assert.ok(r.hunger < 0.25, `seed ${seed} year ${r.year}: hunger ${r.hunger.toFixed(2)} with ${r.farms} farms`);
      if (r.year >= 20) assert.ok(r.pop >= 0.6 * peak, `seed ${seed} year ${r.year}: ${r.pop} people, down from ${peak}`);
    }
    at60.push(rows.find((r) => r.year === 60).pop);
  }
  const mean = at60.reduce((n, p) => n + p, 0) / at60.length;
  assert.ok(mean >= 0.75 * TABLE_POP_60 && mean <= 2 * TABLE_POP_60, `population at year 60: ${at60.join(', ')} (table ${TABLE_POP_60})`);
});
