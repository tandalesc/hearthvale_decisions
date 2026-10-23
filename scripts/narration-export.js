// Pair collected narration sheets with prose, as training rows for a small
// model that writes narration from triples (src/narration-features.js).
//
//   node scripts/narration-export.js DIR [--out FILE=DIR/pairs.jsonl] [--labels FILE ...]
//
// Two sources of prose, told apart by `task` so the model can learn both and be
// asked for the voice it should use:
//   template   the game's own text for the sheet, written from the same facts.
//              Unlimited and free; teaches the model to copy names, places and
//              figures and keep the facts straight.
//                card.why       the card's reason (left out of the triples)
//                year.text      the chronicle's year line (left out)
//                entity.note    the inspector's fallback note
//   model      prose from the hosted narrator, from --labels files: one line per
//              text, {facts, field, text, model}, field 'why' for a card, 'text'
//              for a year or an entity. Only text that passes the narrator's own
//              checks is kept (a card's quote must be the one the game would show),
//              so the model never learns what the game would refuse.
//                card.quote     the asker's quote; the card's reason stays in the triples
//                year.prose     the chronicle line in the narrator's voice
//                entity.prose   the inspector's note
// End pages have no template text; their sheets wait for model labels.
//
// One line per row: {key, type, task, source, model?, triples, target, n, seeds}.
// Prints counts per task and the targets' vocabulary.
import {createReadStream, createWriteStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {narrationTriples, sheetType, NARRATION_FEATURES_VERSION} from '../src/narration-features.js';
import {validateFacts} from '../src/narrative-schema.js';
import {validateProseFacts, CHECKS} from '../src/narrative-prose.js';
import {fallbackNote} from '../src/narrator-client.js';
import {sheetKey} from './narration-collect.js';

const ENTITY = new Set(['person', 'household', 'building', 'body']);

// The game's own prose for a sheet -> [{task, target, drop}]
export function templateRows(facts) {
  const type = sheetType(facts);
  if (type === 'card') return facts.why ? [{task: 'card.why', target: facts.why, drop: ['card.why']}] : [];
  if (type === 'year') return facts.template ? [{task: 'year.text', target: facts.template, drop: ['year.template']}] : [];
  if (ENTITY.has(type)) return [{task: 'entity.note', target: fallbackNote(facts), drop: []}];
  return [];
}

// A hosted narrator's text for a sheet -> {task, target} | {reason}
export function modelRow(facts, field, text) {
  const type = sheetType(facts);
  if (type === 'card' && field === 'why') {
    const options = Object.fromEntries(facts.options.map((o) => [o.key, o.tradeoff ?? '']));
    const checked = CHECKS.card(facts, {why: text, options});
    return checked.used?.why === 'llm' ? {task: 'card.quote', target: checked.prose.why} : {reason: checked.reasons?.why ?? checked.reason};
  }
  if (type === 'year' && field === 'text') {
    const checked = CHECKS.year(facts, {text});
    return checked.ok ? {task: 'year.prose', target: checked.prose.text} : {reason: checked.reason};
  }
  if (ENTITY.has(type) && field === 'text') {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean || clean.length > 420 || clean.split(/\s+/).length > 60 || !/[.!?]$/.test(clean)) return {reason: 'not a note'};
    return {task: 'entity.prose', target: clean};
  }
  return {reason: `no task for ${type}.${field}`};
}

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(['--out', '--labels']);
  const [dir] = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  if (!dir) throw new Error('usage: node scripts/narration-export.js DIR [--out FILE] [--labels FILE ...]');
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(dir, 'pairs.jsonl');
  const labelFiles = args.flatMap((a, i) => (args[i - 1] === '--labels' ? [a] : []));

  const out = createWriteStream(outFile);
  const tasks = {}, refused = {};
  const vocab = new Set();
  const write = (row) => {
    out.write(`${JSON.stringify(row)}\n`);
    const t = (tasks[row.task] ??= {rows: 0, words: 0, triples: 0});
    t.rows++;
    t.words += row.target.split(/\s+/).length;
    t.triples += row.triples.length;
    for (const w of row.target.toLowerCase().match(/[a-z']+/g) ?? []) vocab.add(w);
  };

  for await (const sheet of readLines(join(dir, 'sheets.jsonl'))) {
    for (const {task, target, drop} of templateRows(sheet.facts)) {
      write({key: sheet.key, type: sheet.type, task, source: 'template', triples: narrationTriples(sheet.facts, {drop}), target, n: sheet.n, seeds: sheet.seeds});
    }
  }
  for (const file of labelFiles) {
    for await (const label of readLines(file)) {
      let facts;
      try {
        facts = label.facts?.type ? validateProseFacts(label.facts) : validateFacts(label.facts);
      } catch {
        refused['invalid facts'] = (refused['invalid facts'] ?? 0) + 1;
        continue;
      }
      const row = modelRow(facts, label.field, label.text);
      if (!row.task) {
        const reason = String(row.reason ?? 'refused').split(':')[0];
        refused[reason] = (refused[reason] ?? 0) + 1;
        continue;
      }
      write({key: sheetKey(facts), type: sheetType(facts), task: row.task, source: 'model', model: label.model ?? null,
        triples: narrationTriples(facts), target: row.target, n: 1, seeds: label.seeds ?? []});
    }
  }
  await new Promise((resolve) => out.end(resolve));

  console.log(`features v${NARRATION_FEATURES_VERSION} -> ${outFile}`);
  console.log('task           rows   words/row  triples/row');
  for (const [task, t] of Object.entries(tasks)) {
    console.log(`${task.padEnd(13)} ${String(t.rows).padStart(6)} ${(t.words / t.rows).toFixed(1).padStart(10)} ${(t.triples / t.rows).toFixed(1).padStart(12)}`);
  }
  console.log(`target vocabulary: ${vocab.size} words`);
  if (Object.keys(refused).length) console.log('labels refused:', refused);
}

if (process.argv[1]?.endsWith('narration-export.js')) await main();
