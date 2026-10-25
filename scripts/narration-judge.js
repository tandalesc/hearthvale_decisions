// Grade card quotes for grammar and sense with Haiku, the narrator's checks' blind spot.
//
//   node scripts/narration-judge.js --verdicts VERDICTS.jsonl --sheets SHEETS.jsonl [--labels LABELS.jsonl]
//       [--student 300] [--haiku 100] --out FILE [--key-file ~/.config/hearthvale/anthropic-key] [--yes]
//
// Student quotes: the first passing candidate of each test card in VERDICTS (from
// scripts/narration-student-check.js). Haiku quotes (the control): passing quotes of held-out
// cards in LABELS (split 'test'). Each quote is graded on the card's facts:
//   grammar   clean | minor slips | broken
//   point     does a reader get what is asked and why (yes/no)
//   contradiction  does it contradict itself or the facts (yes/no)
// Without --yes it only counts the requests and prints a cost estimate.
import {createReadStream, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {cardLines} from '../src/narrative-prose.js';
import {modelRow} from './narration-export.js';

const MODEL = 'claude-haiku-5-5';
const args = process.argv.slice(2);
const arg = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

const SYSTEM = `You grade one short quote from a town-building game. A town official speaks it to the town's leader ("you") about a proposal card. You get the card's facts and the quote.
Grade only the quote's language and sense, not its style or whether you would have written it differently.
Return only JSON: {"grammar": "clean" | "minor" | "broken", "point": true | false, "contradiction": true | false}
- grammar: "clean" reads naturally; "minor" has a small slip a reader glides over; "broken" has a sentence a reader stumbles on or cannot parse.
- point: true if a reader understands what is being asked for and roughly why.
- contradiction: true if the quote contradicts itself or the facts (for example "most are for it" then "they are against it").`;

const quotes = [];
const facts = new Map();
const want = new Set();
const verdicts = [];
for await (const v of readLines(arg('--verdicts'))) if (v.split === 'test') { verdicts.push(v); want.add(v.key); }
for await (const s of readLines(arg('--sheets'))) if (want.has(s.key)) facts.set(s.key, s.facts);
for (const v of verdicts) {
  const i = v.pass.findIndex(Boolean);
  if (i >= 0 && facts.has(v.key) && quotes.filter((q) => q.who === 'student').length < Number(arg('--student', 300))) {
    quotes.push({who: 'student', key: v.key, facts: facts.get(v.key), text: v.texts[i]});
  }
}
if (arg('--labels')) {
  for await (const l of readLines(arg('--labels'))) {
    if (l.split !== 'test' || !l.facts || quotes.filter((q) => q.who === 'haiku').length >= Number(arg('--haiku', 100))) continue;
    if (modelRow(l.facts, 'why', l.text).task) quotes.push({who: 'haiku', key: null, facts: l.facts, text: l.text});
  }
}
const prompt = (q) => `Card facts:\n${cardLines(q.facts).map((x) => `- ${x}`).join('\n')}\n\nQuote: "${q.text}"\n\nReturn the JSON.`;
const inChars = quotes.reduce((n, q) => n + SYSTEM.length + prompt(q).length, 0);
const estimate = (inChars / 3.1 * 0.10 + quotes.length * 40 * 0.50) / 1e6;
console.log(`${quotes.filter((q) => q.who === 'student').length} student quotes, ${quotes.filter((q) => q.who === 'haiku').length} Haiku quotes; about $${estimate.toFixed(3)} at ${MODEL} prices`);
if (!args.includes('--yes')) process.exit(0);

let apiKey = process.env.ANTHROPIC_API_KEY;
const keyFile = arg('--key-file', join(homedir(), '.config', 'hearthvale', 'anthropic-key'));
if (!apiKey && existsSync(keyFile)) apiKey = readFileSync(keyFile, 'utf8').trim();
const {default: Anthropic} = await import('@anthropic-ai/sdk');
const client = new Anthropic({apiKey});
const results = [];
let next = 0;
const usage = {input_tokens: 0, output_tokens: 0};
async function worker() {
  while (next < quotes.length) {
    const q = quotes[next++];
    try {
      const msg = await client.messages.create({model: MODEL, max_tokens: 100, thinking: {type: 'disabled'},
        system: [{type: 'text', text: SYSTEM, cache_control: {type: 'ephemeral'}}], messages: [{role: 'user', content: prompt(q)}]});
      usage.input_tokens += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
      usage.output_tokens += msg.usage.output_tokens;
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const grade = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      results.push({who: q.who, text: q.text, ...grade});
    } catch (e) {
      results.push({who: q.who, text: q.text, error: String(e.message ?? e).slice(0, 80)});
    }
  }
}
await Promise.all(Array.from({length: 8}, worker));
writeFileSync(arg('--out'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
for (const who of ['student', 'haiku']) {
  const rs = results.filter((r) => r.who === who && !r.error);
  if (!rs.length) continue;
  const pct = (f) => `${(100 * rs.filter(f).length / rs.length).toFixed(1)}%`;
  console.log(`${who.padEnd(8)} n=${rs.length}  grammar clean ${pct((r) => r.grammar === 'clean')}, minor ${pct((r) => r.grammar === 'minor')}, broken ${pct((r) => r.grammar === 'broken')}; point conveyed ${pct((r) => r.point)}; contradiction ${pct((r) => r.contradiction)}`);
}
console.log('errors', results.filter((r) => r.error).length, 'usage', usage, `cost ~$${((usage.input_tokens * 0.10 + usage.output_tokens * 0.50) / 1e6).toFixed(3)}`);
