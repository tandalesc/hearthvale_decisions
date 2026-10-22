// Label collected decision questions with the decision model
// (docs/design/decision-distillation.md §3.3).
//
//   node scripts/distill-label.js DIR [DIR2 ...] [--per-kind 20000] [--kinds resident_routine,crime_charity]
//        [--per-state 8] [--qps 50] [--concurrency 1] [--env ROOT] [--dry]
//
// Reads questions.jsonl and states.jsonl in each DIR (scripts/distill-collect.js;
// a question collected in several runs counts once),
// draws a fixed sample per kind (by a hash of the question's key, so a rerun or
// a bigger --per-kind keeps the same questions first), skips questions already
// in the first DIR's labels.jsonl, and sends the rest through server/system1.js
// requestDecisions, so prompts are byte-identical to play. Questions sharing a
// state travel together (up to 64 per request) to use the service's state cache;
// --per-state K samples states instead (by a hash of the state) and takes up to
// K questions from each, so far fewer states are sent for the same count.
// Up to 4 requests may be in flight (--concurrency): the service batches them.
// Answers append to that labels.jsonl as {key, kind, probabilities, choice,
// confidence, model}. The local.env with the service key is read from ROOT
// (default: this checkout); the key is never printed.
//
// --dry prints what would be sent and stops. Stop it any time: a rerun resumes.
import {createReadStream, createWriteStream, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadLocalConfig, requestDecisions} from '../server/system1.js';
import {validateQuestion, MAX_QUESTIONS_PER_REQUEST, MAX_GROUPS_PER_REQUEST} from '../src/decision-kinds.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!dirs.length) throw new Error('usage: node scripts/distill-label.js DIR [DIR2 ...] [--per-kind N] [--kinds a,b] [--qps N] [--concurrency N] [--env ROOT] [--dry]');
const perKind = Number(flag('per-kind', 20000));
const perState = Number(flag('per-state', 0));
const kinds = flag('kinds', null)?.split(',') ?? null;
const qps = Number(flag('qps', 0));
const concurrency = Math.max(1, Math.min(4, Number(flag('concurrency', 1))));
const dry = args.includes('--dry');
const root = flag('env', join(dirname(fileURLToPath(import.meta.url)), '..'));

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

// Uniform in [0, 1) from the key: the sample order.
function rank(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const done = new Set();
const labelsFile = join(dirs[0], 'labels.jsonl');
if (existsSync(labelsFile)) for await (const l of readLines(labelsFile)) done.add(l.key);

async function* allQuestions() {
  for (const dir of dirs) yield* readLines(join(dir, 'questions.jsonl'));
}

// Pass 1: counts per kind (repeats across runs count twice: only a rate), so
// pass 2 can keep each kind's lowest ranks.
const counts = {}, statesOf = {};
for await (const q of allQuestions()) {
  if (kinds && !kinds.includes(q.kind)) continue;
  counts[q.kind] = (counts[q.kind] ?? 0) + 1;
  if (perState) (statesOf[q.kind] ??= new Set()).add(q.state);
}
// The share of questions (or, with --per-state, of states) pass 2 keeps:
// a little over what perKind needs, cut to exactly perKind after sorting.
const rate = {};
for (const [kind, n] of Object.entries(counts)) {
  if (!perState) rate[kind] = Math.min(1, (perKind / n) * 1.2 + 1e-3);
  else {
    const states = statesOf[kind].size, perStateHere = Math.min(perState, n / states);
    rate[kind] = Math.min(1, (perKind / perStateHere / states) * 1.5 + 1e-3);
  }
}
const keep = {};
for await (const q of allQuestions()) {
  if (!counts[q.kind]) continue;
  const r = perState ? rank(q.state) : rank(q.key);
  if (r > rate[q.kind]) continue;
  (keep[q.kind] ??= new Map()).set(q.key, {r, r2: rank(q.key), q});
}
const chosen = [];
for (const list of Object.values(keep)) {
  const ranked = [...list.values()].sort((a, b) => a.r - b.r || a.r2 - b.r2);
  const taken = [], perStateCount = new Map();
  for (const item of ranked) {
    if (taken.length >= perKind) break;
    if (perState) {
      const c = perStateCount.get(item.q.state) ?? 0;
      if (c >= perState) continue;
      perStateCount.set(item.q.state, c + 1);
    }
    taken.push(item.q);
  }
  for (const q of taken) if (!done.has(q.key)) chosen.push(q);
}

const neededStates = new Set(chosen.map((q) => q.state));
const states = new Map();
for (const dir of dirs) for await (const s of readLines(join(dir, 'states.jsonl'))) if (neededStates.has(s.state)) states.set(s.state, s.snapshot);

// Pack: questions grouped by state, up to 64 questions and 64 states per request.
const byState = new Map();
for (const q of chosen) {
  if (!byState.has(q.state)) byState.set(q.state, []);
  byState.get(q.state).push(q);
}
const requests = [];
let current = [], count = 0;
for (const [stateId, list] of byState) {
  for (let i = 0; i < list.length;) {
    if (count >= MAX_QUESTIONS_PER_REQUEST || current.length >= MAX_GROUPS_PER_REQUEST) {
      requests.push(current);
      current = [];
      count = 0;
    }
    const take = list.slice(i, i + MAX_QUESTIONS_PER_REQUEST - count);
    current.push({stateId, questions: take});
    count += take.length;
    i += take.length;
  }
}
if (current.length) requests.push(current);

console.log(`already labelled: ${done.size}; to label now: ${chosen.length} questions over ${byState.size} states in ${requests.length} requests`);
for (const [kind, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  const now = chosen.filter((q) => q.kind === kind).length;
  console.log(`  ${kind.padEnd(24)} ${String(n).padStart(9)} distinct, ${String(Math.min(n, perKind)).padStart(7)} in sample, ${String(now).padStart(7)} to send`);
}
if (dry || !chosen.length) process.exit(0);

const config = await loadLocalConfig(root);
if (!config.key) throw new Error(`No API_KEY in ${join(root, 'local.env')}`);
const out = createWriteStream(labelsFile, {flags: 'a'});
const t0 = performance.now();
let sent = 0, answered = 0, failed = 0, next = 0;

async function send(request) {
  const groups = [], keys = new Map();
  let id = 0;
  for (const {stateId, questions} of request) {
    groups.push({state: states.get(stateId), questions: questions.map((q) => {
      const wire = `q${id++}`;
      keys.set(wire, q);
      return validateQuestion({kind: q.kind, id: wire, context: q.context, ...(q.allowed ? {allowed: q.allowed} : {})});
    })});
  }
  try {
    const {answers, model} = await requestDecisions(config, groups);
    for (const [wire, q] of keys) {
      const a = answers[wire];
      if (!a) continue;
      out.write(`${JSON.stringify({key: q.key, kind: q.kind, probabilities: a.probabilities ?? null, choice: a.choice, confidence: a.confidence, model})}\n`);
      answered++;
    }
  } catch (error) {
    failed += keys.size;
    if (failed <= 64 * 3) console.error(`request failed: ${error.message}`);
  }
  sent += keys.size;
}

async function worker() {
  while (next < requests.length) {
    const request = requests[next++];
    const started = performance.now();
    await send(request);
    const size = request.reduce((n, g) => n + g.questions.length, 0);
    // Rate cap across workers: each request takes at least size / (qps / workers) seconds.
    if (qps > 0) {
      const minMs = (size / (qps / concurrency)) * 1000;
      const wait = minMs - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    if (next % 20 === 0) {
      const s = (performance.now() - t0) / 1000;
      const rate = sent / s;
      process.stderr.write(`${sent}/${chosen.length} sent, ${answered} answered, ${failed} failed, ${rate.toFixed(0)} q/s, ETA ${((chosen.length - sent) / Math.max(rate, 1) / 60).toFixed(1)} min\n`);
    }
  }
}

await Promise.all(Array.from({length: concurrency}, worker));
await new Promise((r) => out.end(r));
console.log(`${answered} answered, ${failed} failed, ${sent - answered - failed} without an answer, in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
