// Compare inspector notes on held-out entities: the narration student's, Haiku's (what Plus
// players get) and the template note (what free players get today).
//
//   node scripts/narration-note-judge.js --samples RUN/samples.jsonl --labels NOTES/labels.jsonl
//       --sheets SHEETS.jsonl [--n 300] [--out FILE] [--yes] [--key-file ~/.config/hearthvale/anthropic-key]
//
// Without --yes: the mechanical checks only (the game's own rules for a note: no role the
// sheet lacks, fluent, and cloudflare/narration.js noteOk), and a cost estimate. With --yes,
// Haiku grades up to --n entities' three notes, each graded alone and blind to its source:
//   grammar        clean | minor | broken
//   contradiction  does it contradict the facts or itself
//   specific       does it say something particular to this entity, not a line any of its kind would get
import {createReadStream, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {relex, strayRoles} from '../src/narration-roles.js';
import {fluency} from '../src/narration-fluency.js';
import {fallbackNote} from '../src/narrator-client.js';
import {noteOk, noteMessage, cleanNote} from '../cloudflare/narration.js';
import {validateFacts} from '../src/narrative-schema.js';
import {sheetKey} from './narration-collect.js';

const MODEL = 'claude-haiku-5-5';
const args = process.argv.slice(2);
const arg = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

// A student note as the game would take it: its first candidate that passes, else none.
export function studentNote(outputs, roles) {
  for (const out of outputs ?? []) {
    if (strayRoles(out, roles).length) continue;
    const text = relex(out, roles).trim();
    if (!fluency(text) && noteOk(text)) return text;
  }
  return null;
}

const SYSTEM = `You grade one short note from a town-building game. Tapping a person, household, building or town body shows a note about it, written from the facts below.
Grade only this note, not whether you would have written it differently.
Return only JSON: {"grammar": "clean" | "minor" | "broken", "contradiction": true | false, "specific": true | false}
- grammar: "clean" reads naturally; "minor" has a small slip a reader glides over; "broken" has a sentence a reader stumbles on.
- contradiction: true if the note says something the facts contradict, or contradicts itself.
- specific: true if it tells the reader something particular about this one (their situation, mood, work, what happened to them); false if it could be said of almost any of its kind.`;
const prompt = (facts, text) => `Facts:\n${noteMessage(facts)}\n\nNote: "${text}"\n\nReturn the JSON.`;

const want = new Set();
const student = new Map();
for await (const s of readLines(arg('--samples'))) {
  if (s.task !== 'entity.note' || s.split !== 'test') continue;
  student.set(s.key, s);
  want.add(s.key);
}
const haiku = new Map();
for await (const l of readLines(arg('--labels'))) {
  if (l.split !== 'test' || !l.facts) continue;
  let facts;
  try { facts = validateFacts(l.facts); } catch { continue; }
  // As the worker now shows it: a note wrapped whole in quotation marks is unwrapped.
  const text = cleanNote(l.text);
  haiku.set(sheetKey(facts), {facts, kind: l.kind, text, ok: noteOk(text)});
}
const rows = [];
for (const [key, h] of haiku) {
  const s = student.get(key);
  if (!s) continue;
  rows.push({key, kind: h.kind, facts: h.facts, haiku: h.ok ? h.text : null, template: fallbackNote(h.facts), student: studentNote(s.outputs, s.roles)});
}
const kinds = [...new Set(rows.map((r) => r.kind))];
console.log(`held-out entities with a student sample and a Haiku label: ${rows.length}`);
for (const k of ['all', ...kinds]) {
  const rs = k === 'all' ? rows : rows.filter((r) => r.kind === k);
  const pct = (f) => `${(100 * rs.filter(f).length / Math.max(1, rs.length)).toFixed(1)}%`;
  console.log(`  ${k.padEnd(9)} n=${String(rs.length).padStart(3)}  student note shown ${pct((r) => r.student)}, Haiku note shown ${pct((r) => r.haiku)}`);
}

// Up to --n entities, the same number of each kind, with all three notes.
const n = Number(arg('--n', 300));
const per = Math.ceil(n / Math.max(1, kinds.length));
const pick = kinds.flatMap((k) => rows.filter((r) => r.kind === k && r.student && r.haiku).slice(0, per)).slice(0, n);
const jobs = pick.flatMap((r) => ['student', 'haiku', 'template'].map((who) => ({who, kind: r.kind, key: r.key, facts: r.facts, text: r[who]})));
const inChars = jobs.reduce((a, j) => a + SYSTEM.length + prompt(j.facts, j.text).length, 0);
console.log(`judging ${pick.length} entities x 3 notes = ${jobs.length} grades; about $${((inChars / 3.1 * 0.10 + jobs.length * 30 * 0.50) / 1e6).toFixed(3)} at ${MODEL} prices`);
if (!args.includes('--yes')) process.exit(0);

let apiKey = process.env.ANTHROPIC_API_KEY;
const keyFile = arg('--key-file', join(homedir(), '.config', 'hearthvale', 'anthropic-key'));
if (!apiKey && existsSync(keyFile)) apiKey = readFileSync(keyFile, 'utf8').trim();
const {default: Anthropic} = await import('@anthropic-ai/sdk');
const client = new Anthropic({apiKey});
const results = [];
const usage = {input_tokens: 0, output_tokens: 0};
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    try {
      const msg = await client.messages.create({model: MODEL, max_tokens: 100, thinking: {type: 'disabled'},
        system: [{type: 'text', text: SYSTEM}], messages: [{role: 'user', content: prompt(j.facts, j.text)}]});
      usage.input_tokens += msg.usage.input_tokens;
      usage.output_tokens += msg.usage.output_tokens;
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      results.push({who: j.who, kind: j.kind, key: j.key, text: j.text, ...JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))});
    } catch (e) {
      results.push({who: j.who, kind: j.kind, key: j.key, text: j.text, error: String(e.message ?? e).slice(0, 80)});
    }
  }
}
await Promise.all(Array.from({length: 8}, worker));
if (arg('--out')) writeFileSync(arg('--out'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
for (const k of ['all', ...kinds]) {
  console.log(k);
  for (const who of ['student', 'haiku', 'template']) {
    const rs = results.filter((r) => r.who === who && !r.error && (k === 'all' || r.kind === k));
    if (!rs.length) continue;
    const pct = (f) => `${(100 * rs.filter(f).length / rs.length).toFixed(1)}%`;
    console.log(`  ${who.padEnd(8)} n=${String(rs.length).padStart(3)}  grammar clean ${pct((r) => r.grammar === 'clean')}, broken ${pct((r) => r.grammar === 'broken')}; contradiction ${pct((r) => r.contradiction)}; specific ${pct((r) => r.specific)}`);
  }
}
console.log('errors', results.filter((r) => r.error).length, 'usage', usage, `cost ~$${((usage.input_tokens * 0.10 + usage.output_tokens * 0.50) / 1e6).toFixed(3)}`);
