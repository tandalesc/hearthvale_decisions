// Join collected questions, their states and their labels into training rows
// for the student models (docs/design/decision-distillation.md §3.4).
//
//   node scripts/distill-export.js DIR [DIR2 ...] [--out FILE=DIR/train.jsonl] [--labels FILE=DIR/labels.jsonl]
//        [--unlabelled resident_routine=400000,*=40000]
//
// Labels come from the first DIR's labels.jsonl (or --labels); questions and states from
// every DIR (a question collected in several runs is one row, with the seeds
// of all of them, so the trainer's split by town stays clean).
// One line per labelled question: {key, kind, triples, options, target, n,
// seeds, aug, model}. `triples` come from src/decision-features.js, so the
// trainer sees exactly what the game's student will; `target` is the teacher's
// distribution over `options` (questions answered without one are skipped).
//
// --unlabelled instead writes a sample of the questions the labels do NOT
// cover (up to N per kind, by a hash of the key; '*' for every other kind),
// with `target: null`, for a trained student to label (the trainer's
// relabel_decision_student.py): far more rows than the decision model can
// afford to answer.
import {createReadStream, createWriteStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {decisionTriples, decisionOptions, FEATURES_VERSION} from '../src/decision-features.js';

const args = process.argv.slice(2);
const dirs = args.filter((a, i) => !a.startsWith('--') && !['--out', '--labels', '--unlabelled'].includes(args[i - 1]));
if (!dirs.length) throw new Error('usage: node scripts/distill-export.js DIR [DIR2 ...] [--out FILE]');
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(dirs[0], 'train.jsonl');
const labelsFile = args.includes('--labels') ? args[args.indexOf('--labels') + 1] : join(dirs[0], 'labels.jsonl');

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

const labels = new Map();
for await (const l of readLines(labelsFile)) if (l.probabilities) labels.set(l.key, l);

const unlabelled = args.includes('--unlabelled')
  ? Object.fromEntries(args[args.indexOf('--unlabelled') + 1].split(',').map((p) => p.split('=')).map(([k, n]) => [k, Number(n)]))
  : null;
const capOf = (kind) => unlabelled[kind] ?? unlabelled['*'] ?? 0;
function rank(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// The share of each kind's unlabelled questions to keep (counted first).
const rate = {};
if (unlabelled) {
  const counts = {};
  for (const dir of dirs) for await (const q of readLines(join(dir, 'questions.jsonl'))) if (!labels.has(q.key)) counts[q.kind] = (counts[q.kind] ?? 0) + 1;
  for (const [kind, n] of Object.entries(counts)) rate[kind] = Math.min(1, capOf(kind) / n);
}
const wanted = (q) => (unlabelled ? !labels.has(q.key) && rank(q.key) < (rate[q.kind] ?? 0) : labels.has(q.key));

const byKey = new Map(), needed = new Set();
for (const dir of dirs) {
  for await (const q of readLines(join(dir, 'questions.jsonl'))) {
    if (!wanted(q)) continue;
    const seen = byKey.get(q.key);
    if (seen) {
      seen.n += q.n;
      seen.seeds = [...new Set([...seen.seeds, ...q.seeds])];
      seen.aug &&= q.aug;
    } else byKey.set(q.key, q);
    needed.add(q.state);
  }
}
const questions = [...byKey.values()];
const states = new Map();
for (const dir of dirs) for await (const s of readLines(join(dir, 'states.jsonl'))) if (needed.has(s.state)) states.set(s.state, s.snapshot);

const out = createWriteStream(outFile);
const kinds = {};
for (const q of questions) {
  const l = labels.get(q.key);
  const options = decisionOptions(q.kind, q.allowed);
  const target = l ? options.map((o) => l.probabilities[o] ?? 0) : null;
  out.write(`${JSON.stringify({key: q.key, kind: q.kind, triples: decisionTriples(q.kind, states.get(q.state), q.context), options, target,
    n: q.n, seeds: q.seeds, aug: q.aug, model: l?.model ?? null, features: FEATURES_VERSION})}\n`);
  kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
}
await new Promise((r) => out.end(r));
console.log(`${outFile}: ${questions.length} rows (${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')})`);
