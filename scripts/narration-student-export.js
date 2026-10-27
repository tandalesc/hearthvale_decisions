// Training rows for the narration student (scripts/narration-student.py): card
// triples and texts with names, places and numbers as role tokens (src/narration-roles.js).
//
//   node scripts/narration-student-export.js SHEETS.jsonl --labels LABELS.jsonl [--labels ...] --out FILE
//       [--notes NOTES.jsonl ...] [--note-fraction 1] [--only-notes] [--roles 2]
//       [--note-templates N --held-out 1,2,3] [--trim-notes] [--drop season]
//
// LABELS are hosted-narrator replies for cards, as scripts/narration-label-batch.js
// fetch writes them ({facts, field: 'why', text, reply, model, seeds}).
// One JSON row per line: {key, task, source, seeds, triples, target, roles}.
//   card.quote  model     a quote that passes the narrator's checks: the voice to learn
//   card.quote  pretrain  every quote, passing or not: more of the hosted model's English
//   card.option pretrain  each option line of every reply, with an ["ask", "option", key] triple
//   card.quote  prompt    every card sheet, with no target: the cards to quote when testing
// NOTES are inspector notes from scripts/narration-label-batch.js build --notes ({facts, field:
// 'text', kind, text, ok, seeds, split}); ok: the worker would show it (cloudflare/narration.js).
//   entity.note model     a note the worker would show
//   entity.note pretrain  every note
//   entity.note prompt    every labelled entity sheet, with no target: the notes to write when testing
// A note wrapped whole in quotation marks is unwrapped first (Haiku often quotes the speaker;
// the worker then refuses it for not ending a sentence), and kept as model text if noteOk.
// --note-fraction keeps that share of training-town notes (by a hash of the key), for data-size
// runs; held-out towns keep all theirs. --only-notes writes note rows alone (to join with card rows).
// --roles 2: note rows use role tokens version 2 (src/narration-roles.js); card rows keep 1.
// --note-templates N: up to N template notes (fallbackNote) of training-town entity sheets as
// pretraining rows, an even share per kind: always true to the facts, so they teach copying.
import {createReadStream, createWriteStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {narrationTriples} from '../src/narration-features.js';
import {roleTriples, delex} from '../src/narration-roles.js';
import {validateProseFacts} from '../src/narrative-prose.js';
import {parseJsonReply} from '../server/narrator.js';
import {sheetKey} from './narration-collect.js';
import {modelRow} from './narration-export.js';
import {factProblem} from '../src/narration-consistency.js';
import {validateFacts} from '../src/narrative-schema.js';
import {createHash} from 'node:crypto';
import {noteOk, cleanNote} from '../cloudflare/narration.js';
import {fallbackNote} from '../src/narrator-client.js';

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

const args = process.argv.slice(2);
const [sheetsFile] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const labelFiles = args.flatMap((a, i) => (args[i - 1] === '--labels' ? [a] : []));
const noteFiles = args.flatMap((a, i) => (args[i - 1] === '--notes' ? [a] : []));
const noteFraction = args.includes('--note-fraction') ? Number(args[args.indexOf('--note-fraction') + 1]) : 1;
const onlyNotes = args.includes('--only-notes');
const rolesVersion = args.includes('--roles') ? Number(args[args.indexOf('--roles') + 1]) : 1;
const noteTemplates = args.includes('--note-templates') ? Number(args[args.indexOf('--note-templates') + 1]) : 0;
const trimNotes = args.includes('--trim-notes');   // keep a long note's first two sentences (see below)
const heldOut = new Set(String(args.includes('--held-out') ? args[args.indexOf('--held-out') + 1] : '').split(',').filter(Boolean).map(Number));
if (noteTemplates && !heldOut.size) throw new Error('--note-templates needs --held-out');
// --drop season: leave a fact out of the note triples (the bundle records it as config.drop, and
// the runtime drops it too). Notes are kept past the season they were written in.
const dropPaths = String(args.includes('--drop') ? args[args.indexOf('--drop') + 1] : '').split(',').filter(Boolean);
const noteRows = (facts) => roleTriples(narrationTriples(facts, {drop: dropPaths}), {version: rolesVersion});
const outFile = args[args.indexOf('--out') + 1];
if (!sheetsFile || !outFile) throw new Error('usage: narration-student-export.js SHEETS.jsonl --labels FILE --out FILE');

const out = createWriteStream(outFile);
const counts = {};
const write = (row) => {
  out.write(`${JSON.stringify(row)}\n`);
  const k = `${row.task} ${row.source}`;
  counts[k] = (counts[k] ?? 0) + 1;
};
const cardRows = (facts) => roleTriples(narrationTriples(facts));

for await (const s of (onlyNotes ? [] : readLines(sheetsFile))) {
  if (s.type !== 'card') continue;
  const {triples, roles} = cardRows(s.facts);
  write({key: s.key, task: 'card.quote', source: 'prompt', seeds: s.seeds, triples, target: '', roles});
}
for (const file of onlyNotes ? [] : labelFiles) {
  for await (const l of readLines(file)) {
    if (!l.facts || l.field !== 'why') continue;
    let facts;
    try { facts = validateProseFacts(l.facts); } catch { continue; }
    const key = sheetKey(facts);
    const {triples, roles} = cardRows(facts);
    const base = {key, seeds: l.seeds ?? [], triples, roles};
    if (typeof l.text === 'string' && l.text.trim()) {
      write({...base, task: 'card.quote', source: 'pretrain', target: delex(l.text.trim(), roles)});
      const passing = modelRow(facts, 'why', l.text);
      // Fine-tune only on quotes that are also true to the facts (Haiku slips too).
      if (passing.task && !factProblem(passing.target, facts)) write({...base, task: 'card.quote', source: 'model', target: delex(l.text.trim(), roles)});
    }
    const options = parseJsonReply(l.reply ?? '')?.options ?? {};
    for (const [optKey, line] of Object.entries(options)) {
      if (typeof line !== 'string' || !line.trim() || !facts.options.some((o) => o.key === optKey)) continue;
      write({...base, triples: [...triples, ['ask', 'option', optKey, null, 'enum']], task: 'card.option', source: 'pretrain', target: delex(line.trim(), roles)});
    }
  }
}
// Inspector notes: one task for people, households, buildings and bodies.
// Salted: narration-label-batch.js picks sheets by the unsalted hash, so the picked ones all hash low.
const share = (key) => parseInt(createHash('sha256').update(`note-fraction:${key}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
const firstTwo = (text) => {
  const two = (text.match(/[^.!?]+[.!?]+/g) ?? []).slice(0, 2).join('').trim();
  return two && two.split(/\s+/).length >= 18 && noteOk(two) ? two : null;
};
for (const file of noteFiles) {
  for await (const l of readLines(file)) {
    if (!l.facts || l.field !== 'text') continue;
    let facts;
    try { facts = validateFacts(l.facts); } catch { continue; }
    const key = sheetKey(facts);
    const {triples, roles} = noteRows(facts);
    const base = {key, seeds: l.seeds ?? [], triples, roles, task: 'entity.note'};
    write({...base, source: 'prompt', target: ''});
    if (l.split === 'train' && share(key) >= noteFraction) continue;
    if (typeof l.text !== 'string' || !l.text.trim()) continue;
    const text = cleanNote(l.text);
    write({...base, source: 'pretrain', target: delex(text, roles)});
    // A note one sentence too long (Haiku often writes three): its first two sentences, when
    // they pass on their own and say enough. Only for --trim-notes runs.
    const kept = noteOk(text) ? text : trimNotes ? firstTwo(text) : null;
    if (kept) write({...base, source: 'model', target: delex(kept, roles)});
  }
}
// Template notes of training-town entity sheets, round-robin by kind.
if (noteTemplates) {
  const kinds = ['person', 'household', 'building', 'body'], per = Math.ceil(noteTemplates / kinds.length), taken = Object.fromEntries(kinds.map((k) => [k, 0]));
  for await (const s of readLines(sheetsFile)) {
    if (!kinds.includes(s.type) || taken[s.type] >= per) continue;
    if (!s.seeds?.length || s.seeds.some((x) => heldOut.has(x))) continue;
    let facts;
    try { facts = validateFacts(s.facts); } catch { continue; }
    const {triples, roles} = noteRows(facts);
    write({key: sheetKey(facts), task: 'entity.note', source: 'pretrain', seeds: s.seeds, triples, roles, target: delex(fallbackNote(facts), roles)});
    taken[s.type]++;
    if (kinds.every((k) => taken[k] >= per)) break;
  }
}
await new Promise((resolve) => out.end(resolve));
console.log(outFile, counts);
