// Live throughput benchmark for the decision pipeline.
//
//   node scripts/benchmark-decisions.js [secondsPerWorkload=8]
//
// Runs the browser decision client in Node, wired straight to the server
// module's request handler (no browser, no Vite), against the real service
// configured in local.env. Requires LAN access to that service. The API key is
// loaded server-side and never printed.
//
// Workloads (every question is new; only states repeat):
//   per-question (old)   the original prompt: town context repeated in every
//                        question (~180 tokens), no shared state
//   one state, warm      all questions share one state the service has cached
//   one state, cold      a new state every 256 questions
//   many states, warm    questions spread over 64 states that repeat
//   many states, cold    every question has its own new state (via /batch)
//   before               the old pipeline and old prompt: one request of 16 at a time, 80% utilization
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {loadLocalConfig, createDecisionService, createConcurrencyGate, requestDecisions, validateDecisionRequest} from '../server/system1.js';
import {createDecisionClient} from '../src/decision-client.js';
import {defineDecisionKind, field} from '../src/decision-kinds.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seconds = Number(process.argv[2]) || 8;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();
const run = Math.random().toString(36).slice(2, 7); // keeps "cold" states new across runs

const config = await loadLocalConfig(root);
if (!config.key) {
  console.error('API_KEY is missing from local.env; nothing to benchmark.');
  process.exit(1);
}

const BANDS = ['critical', 'low', 'normal', 'high'];
const PHASES = ['rest', 'work', 'shop', 'leisure'];
let serial = 0;

const context = (i) => ({slice: 'intersection', label: `in the west district ${i % 50}, with poor savings`, group: 5 + (i % 90),
  energy: BANDS[i % 4], fullness: BANDS[(i >> 2) % 4], social: BANDS[(i >> 4) % 4]});
// District snapshot of the simulation's resident_routine kind; districtName
// makes a state unique when the workload needs cold states.
const districtState = (name) => ({era: 'town', season: 'summer', archetype: 'mill', food: 'ok', coin: 'ok', wellbeing: 'fair',
  jobs: 'balanced', homes: 'scarce', health: 'fair', unrest: 'calm', faith: 'mid', river: 'busy', taxStep: 2,
  rules: 'tithe 2, market charter', recent: 'flood', bodies: 'moot', districtName: name, character: 'quays', rent: 'mid'});
const residentContext = (i) => ({timeOfDay: ['morning', 'midday', 'evening'][i % 3], district: 'riverside', group: 5 + (i % 90),
  energy: ['low', 'ok', 'high'][i % 3], fullness: ['low', 'ok', 'high'][(i >> 1) % 3]});

// The original routine question, for comparison only (registered in this
// process; the server module validates against the same registry).
defineDecisionKind({
  id: 'bench_routine_per_question',
  criteria: {
    work: 'Go to the farm or workshop to work; especially during the work phase.',
    rest: 'Rest at home; especially during the rest phase or when wellbeing is low.',
    shop: 'Visit the market for household needs; especially during the shopping phase.',
    leisure: 'Visit a garden for recreation; especially during the leisure phase.',
  },
  context: {resident: field.int(0, 1e9), day: field.int(1, 1e9), happiness: field.int(0, 100), food: field.int(0, 1e9), tax: field.int(0, 25),
    wealth: field.int(0, 1e9), energyBand: field.int(0, 3), fullnessBand: field.int(0, 3), socialBand: field.int(0, 3)},
  instructions: (c) => `Choose the next everyday activity for resident ${c.resident} in Hearthvale. Day ${c.day}; normal routine phase ${PHASES[c.day % 4]}. ` +
    `Savings ${c.wealth}; town wellbeing ${c.happiness}/100; food reserve ${c.food}; household tax ${c.tax}%. Needs bands (0 critical, 1 low, 2 normal, 3 high): ` +
    `energy ${c.energyBand}, fullness ${c.fullnessBand}, social ${c.socialBand}. Accessible activities: work, rest, shop, leisure. Respect player policy. ` +
    'This is a routine choice only: never change council decisions, buildings, money or policies.',
});
const offset = Math.floor(Math.random() * 1e8); // fresh questions on every run (the service caches repeats)
const oldContext = (i) => ({resident: offset + i, day: 3 + (i % 40), happiness: 78, food: 200, tax: 10, wealth: 20 + (i % 300), energyBand: i % 4, fullnessBand: (i >> 2) % 4, socialBand: (i >> 4) % 4});

const WORKLOADS = {
  'per-question (old)': () => ({kind: 'bench_routine_per_question', context: oldContext(serial)}),
  'one state, warm': () => ({kind: 'routine', context: context(serial), state: {phase: 'work', food: 'ok', wellbeing: 'good', taxStep: 10}}),
  'one state, cold': () => ({kind: 'resident_routine', context: residentContext(serial), state: districtState(`c${run}${Math.floor(serial / 256)}`)}),
  'many states, warm': () => ({kind: 'routine', context: context(serial), state: {phase: PHASES[serial % 4], food: ['low', 'ok', 'plenty'][(serial >> 2) % 3], wellbeing: 'good', taxStep: (serial >> 4) % 6}}),
  'many states, cold': () => ({kind: 'resident_routine', context: residentContext(serial), state: districtState(`u${run}${serial}`)}),
};

// One long-lived client (as in the game), wired to the server module.
const service = createDecisionService({loadConfig: async () => config, gate: createConcurrencyGate({limit: 4, maxQueue: 8})});
const client = createDecisionClient({
  now,
  fetch: async (url, opts) => {
    const result = await service.handle(JSON.parse(opts.body));
    return new Response(JSON.stringify(result.body), {status: result.status});
  },
});

// Keep the client's room full, the way the simulation's schedulers do.
async function drive(make, durationMs, onAnswer = () => {}) {
  const start = now();
  const pending = [];
  while (now() - start < durationMs) {
    for (let n = client.stats().room; n > 0; n--) {
      const q = make();
      pending.push(client.ask(q.kind, `q${serial++}`, q.context, {state: q.state, tag: 'bench'}).then(onAnswer));
    }
    await sleep(5);
  }
  return pending;
}

async function measure(label, make) {
  await Promise.all(await drive(make, 3000)); // settle concurrency and warm states
  const before = client.stats();
  let answered = 0, nulls = 0;
  const start = now();
  const pending = await drive(make, seconds * 1000, (answer) => { if (answer) answered++; else nulls++; });
  const elapsed = (now() - start) / 1000;
  const stats = client.stats();
  await Promise.all(pending);
  return {label, rate: answered / elapsed, latency: stats.latencyMs, batch: stats.batchSize, groups: stats.groupsPerRequest,
    concurrency: stats.concurrency, nulls, failures: stats.failures - before.failures};
}

// Before: one request in flight, 16 questions, 25% idle after each (80% utilization).
async function legacyPipeline() {
  const start = now();
  let answered = 0, requests = 0, latency = 0, failures = 0;
  while (now() - start < seconds * 1000) {
    const groups = validateDecisionRequest({groups: [{questions: Array.from({length: 16}, (_, i) => ({kind: 'bench_routine_per_question', id: String(i), context: oldContext(serial++)}))}]});
    const t = now();
    try {
      answered += Object.keys((await requestDecisions(config, groups)).answers).length;
    } catch { failures++; }
    const duration = now() - t;
    latency += duration;
    requests++;
    await sleep(duration * 0.25);
  }
  return {label: 'before: 1 x 16, 80% util', rate: answered / ((now() - start) / 1000), latency: latency / requests, batch: 16, groups: 1, concurrency: 1, nulls: 0, failures};
}

const rows = [];
for (const [label, make] of Object.entries(WORKLOADS)) rows.push(await measure(label, make));
rows.push(await legacyPipeline());

console.log(`Decision pipeline throughput (${seconds}s per workload, ${config.endpoint})`);
console.log('workload'.padEnd(26), 'answered q/s'.padStart(13), 'latency ms'.padStart(11), 'q/request'.padStart(10), 'states/req'.padStart(11), 'conc'.padStart(5), 'nulls'.padStart(6), 'failed'.padStart(7));
for (const r of rows) {
  console.log(r.label.padEnd(26), r.rate.toFixed(1).padStart(13), r.latency.toFixed(0).padStart(11), r.batch.toFixed(1).padStart(10),
    r.groups.toFixed(1).padStart(11), String(r.concurrency).padStart(5), String(r.nulls).padStart(6), String(r.failures).padStart(7));
}
console.log(`Distinct states used: ${client.stats().states.distinctLastHour}`);
