// Check a narration model's held-out samples with the narrator's own checks.
//
//   node scripts/narration-check.js SAMPLES.jsonl --sheets DIR/sheets.jsonl [--labels FILE ...]
//
// SAMPLES.jsonl comes from scripts/narration-train.py: {key, task, source, target, output}.
// Model-voice samples (card.quote, year.prose, entity.prose) go through the same gate the
// exporter uses for Haiku's text (modelRow), so a pass here means the game would show it.
// It must also be fluent (fluency below). With several candidates per card, it reports both
// the top one and the first that passes, which is what the game would show.
// Template samples are compared with the game's own text. Prints pass rates and reasons.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {validateFacts} from '../src/narrative-schema.js';
import {validateProseFacts} from '../src/narrative-prose.js';
import {sheetKey} from './narration-collect.js';
import {modelRow} from './narration-export.js';
import {fluency} from '../src/narration-fluency.js';

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

const args = process.argv.slice(2);
const [samplesFile] = args;
const listOf = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
const facts = new Map();
for (const file of listOf('--sheets')) for await (const s of readLines(file)) facts.set(s.key, s.facts);
for (const file of listOf('--labels')) {
  for await (const l of readLines(file)) {
    try {
      const clean = l.facts?.type ? validateProseFacts(l.facts) : validateFacts(l.facts);
      facts.set(sheetKey(clean), clean);
    } catch {}
  }
}

const FIELD = {'card.quote': 'why', 'year.prose': 'text', 'entity.prose': 'text'};
const tally = {};
const examples = {};
for await (const s of readLines(samplesFile)) {
  const t = (tally[s.task] ??= {n: 0, pass: 0, exact: 0, reasons: {}});
  t.n++;
  if (!FIELD[s.task]) {
    if (s.output === s.target) t.exact++;
    continue;
  }
  const f = facts.get(s.key);
  if (!f) { t.reasons['no facts'] = (t.reasons['no facts'] ?? 0) + 1; continue; }
  // The top candidate, and the first of the candidates that passes (as the game
  // would pick at runtime, falling back to template text when none does).
  const outputs = s.outputs?.length ? s.outputs : [s.output];
  const judge = (text) => (fluency(text) ? {reason: `not fluent: ${fluency(text)}`} : modelRow(f, FIELD[s.task], text));
  const top = judge(outputs[0]);
  if (top.task) t.pass++;
  else {
    const reason = String(top.reason ?? 'refused').split(':').slice(0, top.reason?.startsWith('not fluent') ? 2 : 1).join(':');
    t.reasons[reason] = (t.reasons[reason] ?? 0) + 1;
  }
  const chosen = outputs.find((o) => judge(o).task);
  if (chosen) {
    t.best = (t.best ?? 0) + 1;
    (examples[s.task] ??= []).length < 8 && examples[s.task].push(chosen);
  }
}
for (const [task, t] of Object.entries(tally)) {
  if (FIELD[task]) {
    console.log(`${task.padEnd(13)} top candidate: ${t.pass}/${t.n} pass (${(100 * t.pass / t.n).toFixed(1)}%)`, t.reasons);
    console.log(`${''.padEnd(13)} best of the candidates: ${t.best ?? 0}/${t.n} pass (${(100 * (t.best ?? 0) / t.n).toFixed(1)}%); the rest fall back to template text`);
  }
  else console.log(`${task.padEnd(13)} ${t.exact}/${t.n} match the game's text exactly (${(100 * t.exact / t.n).toFixed(1)}%)`);
}
for (const [task, xs] of Object.entries(examples)) for (const x of xs) console.log(`  ${task}: ${x}`);
