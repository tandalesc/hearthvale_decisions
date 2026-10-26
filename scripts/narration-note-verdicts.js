// Verdicts for the notes student's confidence head (scripts/narration-quality.py): every
// candidate note of one split, good or not. A candidate is good when it passes the game's
// rules for a note (no role the sheet lacks, fluent, noteOk, noteProblem) and Haiku finds
// no contradiction and no broken sentence in it (scripts/narration-note-grade.js).
//
//   node scripts/narration-note-verdicts.js RUN/samples.jsonl --sheets SHEETS.jsonl --split val
//       --out RUN/verdicts.jsonl [--eval] [--rubric facts|quality] [--rules-only] [--yes] [--key-file ...]
//
// --rubric quality grades how good a note each is (1-5, narration-note-grade.js QUALITY_SYSTEM)
// and counts 4 or 5 as good; facts (the default) counts no contradiction and no broken
// sentence as good. --rules-only writes the rule checks alone, ungraded. --resume keeps the
// grades an earlier run of the same command wrote to --out and grades only the rest.
//
// Writes {key, split, pass: [per candidate], texts: [...]} lines, as narration-quality.py reads
// them. Without --yes: the rule checks only, and a cost estimate. Judge the validation towns,
// never the test towns the notes are compared on.
import {createReadStream, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {relex, strayRoles} from '../src/narration-roles.js';
import {fluency} from '../src/narration-fluency.js';
import {noteOk, cleanNote, noteProblem} from '../src/narration-notes.js';
import {validateFacts} from '../src/narrative-schema.js';
import {SYSTEM, prompt, grade, MODEL, QUALITY_SYSTEM, qualityPrompt, gradeQuality} from './narration-note-grade.js';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}
const split = arg('--split', 'val');
const rubric = arg('--rubric', 'facts');
// The head learns on validation towns; test-town verdicts (--eval) only score it and set its thresholds.
if (split === 'test' && !args.includes('--eval')) throw new Error('the head learns on validation towns; grade test towns only with --eval, to score it');
const samples = [];
for await (const s of readLines(args[0])) if (s.task === 'entity.note' && s.split === split) samples.push(s);
const want = new Set(samples.map((s) => s.key));
const facts = new Map();
for await (const s of readLines(arg('--sheets'))) if (want.has(s.key)) { try { facts.set(s.key, validateFacts(s.facts)); } catch {} }

// The rules first: a candidate that fails them is bad without a grade.
const jobs = [];
const verdicts = samples.filter((s) => facts.has(s.key)).map((s) => {
  const f = facts.get(s.key);
  const texts = s.outputs.map((o) => (strayRoles(o, s.roles).length ? null : cleanNote(relex(o, s.roles))));
  const pass = texts.map((t) => !!t && !fluency(t) && noteOk(t) && !noteProblem(t, f));
  const v = {key: s.key, split, pass, rules: [...pass], texts, ...(rubric === 'quality' ? {scores: pass.map(() => null)} : {})};
  pass.forEach((ok, i) => { if (ok) jobs.push({v, i, facts: f, text: texts[i]}); });
  return v;
});
if (args.includes('--rules-only')) {
  writeFileSync(arg('--out'), verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');
  console.log(`${verdicts.length} ${split} entities: rule checks only -> ${arg('--out')}`);
  process.exit(0);
}
const sys = rubric === 'quality' ? QUALITY_SYSTEM : SYSTEM, ask = rubric === 'quality' ? qualityPrompt : prompt;
if (args.includes('--resume') && existsSync(arg('--out'))) {
  const done = new Map(readFileSync(arg('--out'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((v) => [v.key, v]));
  for (let n = jobs.length - 1; n >= 0; n--) {
    const j = jobs[n], old = done.get(j.v.key);
    const s = old?.texts?.[j.i] === j.text ? old.scores?.[j.i] : null;
    if (rubric === 'quality' && s != null) { j.v.scores[j.i] = s; j.v.pass[j.i] = s >= 4; jobs.splice(n, 1); }
  }
}
const inChars = jobs.reduce((a, j) => a + sys.length + ask(j.facts, j.text).length, 0);
console.log(`${verdicts.length} ${split} entities, ${verdicts.reduce((a, v) => a + v.pass.length, 0)} candidates, ${jobs.length} pass the rules; grading them costs about $${((inChars / 3.1 * 0.10 + jobs.length * 30 * 0.50) / 1e6).toFixed(3)} at ${MODEL} prices`);
if (!args.includes('--yes')) process.exit(0);

let apiKey = process.env.ANTHROPIC_API_KEY;
const keyFile = arg('--key-file', join(homedir(), '.config', 'hearthvale', 'anthropic-key'));
if (!apiKey && existsSync(keyFile)) apiKey = readFileSync(keyFile, 'utf8').trim();
const {default: Anthropic} = await import('@anthropic-ai/sdk');
const client = new Anthropic({apiKey});
let next = 0, failed = 0;
const usage = {input: 0, output: 0};
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    try {
      const g = rubric === 'quality' ? await gradeQuality(client, j.facts, j.text) : await grade(client, j.facts, j.text);
      usage.input += g.tokens.input; usage.output += g.tokens.output;
      if (rubric === 'quality') { j.v.scores[j.i] = g.score; j.v.pass[j.i] = g.score >= 4; }
      else j.v.pass[j.i] = !g.contradiction && g.grammar !== 'broken';
    } catch {
      failed++;
      j.v.pass[j.i] = false;   // no grade, not trusted
    }
  }
}
await Promise.all(Array.from({length: 8}, worker));
writeFileSync(arg('--out'), verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n');
const good = verdicts.reduce((a, v) => a + v.pass.filter(Boolean).length, 0);
console.log(`good candidates ${good}/${verdicts.reduce((a, v) => a + v.pass.length, 0)}; entities with a good one ${verdicts.filter((v) => v.pass.some(Boolean)).length}/${verdicts.length}; ungraded ${failed}; cost ~$${((usage.input * 0.10 + usage.output * 0.50) / 1e6).toFixed(3)}`);
