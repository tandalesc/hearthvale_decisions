// Check the narration student's quotes with the narrator's own checks.
//
//   node scripts/narration-student-check.js SAMPLES.jsonl --sheets SHEETS.jsonl [--verdicts OUT.jsonl]
//
// SAMPLES.jsonl comes from scripts/narration-student.py: candidates per card with role
// tokens. Each is put back into the card's words (relex) and judged as the game would
// judge a hosted quote (modelRow), plus the fluency check. Prints, per split, how many
// cards' top candidate passes and how many have any passing candidate, and writes one
// verdict line per card for scripts/narration-quality.py.
import {createReadStream, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {relex, strayRoles} from '../src/narration-roles.js';
import {modelRow} from './narration-export.js';
import {fluency} from '../src/narration-fluency.js';

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}
const args = process.argv.slice(2);
const [samplesFile] = args;
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const samples = [];
for await (const s of readLines(samplesFile)) samples.push(s);
const keys = new Set(samples.map((s) => s.key));
const facts = new Map();
for await (const s of readLines(arg('--sheets'))) if (keys.has(s.key)) facts.set(s.key, s.facts);

export function judge(text, f, roles) {
  if (strayRoles(text, roles).length) return {reason: 'role the card lacks'};
  const words = relex(text, roles);
  const flu = fluency(words);
  if (flu) return {reason: `not fluent: ${flu}`, text: words};
  const row = modelRow(f, 'why', words);
  return row.task ? {ok: true, text: row.target} : {reason: String(row.reason).split(':')[0], text: words};
}

const tally = {};
const verdicts = [];
const examples = [];
for (const s of samples) {
  const f = facts.get(s.key);
  if (!f) continue;
  const js = s.outputs.map((o) => judge(o, f, s.roles));
  verdicts.push({key: s.key, split: s.split, pass: js.map((j) => !!j.ok), texts: js.map((j) => j.text ?? null)});
  const t = (tally[s.split] ??= {n: 0, top: 0, any: 0, reasons: {}});
  t.n++;
  if (js[0].ok) t.top++;
  else t.reasons[js[0].reason] = (t.reasons[js[0].reason] ?? 0) + 1;
  const first = js.find((j) => j.ok);
  if (first) {
    t.any++;
    if (s.split === 'test' && examples.length < 12) examples.push(first.text);
  }
}
for (const [split, t] of Object.entries(tally)) {
  console.log(`${split}: top candidate passes ${t.top}/${t.n} (${(100 * t.top / t.n).toFixed(1)}%), some candidate passes ${t.any}/${t.n} (${(100 * t.any / t.n).toFixed(1)}%)`, t.reasons);
}
for (const e of examples) console.log('  -', e);
if (arg('--verdicts')) writeFileSync(arg('--verdicts'), verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');
