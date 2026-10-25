// Training rows for the narration student (scripts/narration-student.py): card
// triples and texts with names, places and numbers as role tokens (src/narration-roles.js).
//
//   node scripts/narration-student-export.js SHEETS.jsonl --labels LABELS.jsonl [--labels ...] --out FILE
//
// LABELS are hosted-narrator replies for cards, as scripts/narration-label-batch.js
// fetch writes them ({facts, field: 'why', text, reply, model, seeds}).
// One JSON row per line: {key, task, source, seeds, triples, target, roles}.
//   card.quote  model     a quote that passes the narrator's checks: the voice to learn
//   card.quote  pretrain  every quote, passing or not: more of the hosted model's English
//   card.option pretrain  each option line of every reply, with an ["ask", "option", key] triple
//   card.quote  prompt    every card sheet, with no target: the cards to quote when testing
import {createReadStream, createWriteStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {narrationTriples} from '../src/narration-features.js';
import {roleTriples, delex} from '../src/narration-roles.js';
import {validateProseFacts} from '../src/narrative-prose.js';
import {parseJsonReply} from '../server/narrator.js';
import {sheetKey} from './narration-collect.js';
import {modelRow} from './narration-export.js';
import {factProblem} from '../src/narration-consistency.js';

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

const args = process.argv.slice(2);
const [sheetsFile] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const labelFiles = args.flatMap((a, i) => (args[i - 1] === '--labels' ? [a] : []));
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

for await (const s of readLines(sheetsFile)) {
  if (s.type !== 'card') continue;
  const {triples, roles} = cardRows(s.facts);
  write({key: s.key, task: 'card.quote', source: 'prompt', seeds: s.seeds, triples, target: '', roles});
}
for (const file of labelFiles) {
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
await new Promise((resolve) => out.end(resolve));
console.log(outFile, counts);
