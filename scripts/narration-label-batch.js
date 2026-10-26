// Haiku labels for the narration student, through the Message Batches API (half price).
//
//   node scripts/narration-label-batch.js build SHEETS.jsonl --out DIR [--train 4000] [--test 300] --held-out 1,2,3 [--notes]
//   node scripts/narration-label-batch.js send DIR --yes [--key-file ~/.config/hearthvale/anthropic-key]
//   node scripts/narration-label-batch.js fetch DIR [--key-file ...]
//
// build   picks cards and writes DIR/requests.jsonl and DIR/manifest.jsonl, and prints a
//         cost estimate. Nothing leaves the machine.
//           train  cards from seeds the student trains on, spread evenly over card templates
//           test   cards from the held-out seeds (--held-out, from the trainer's metrics.json):
//                  Haiku's own pass rate there is the bar the student has to reach
//         Each request is the narrator's own card prompt (buildProsePrompt in
//         server/narrator.js), one attempt, thinking off as production runs it. The system
//         prompt is the same for every card, so it is marked for caching.
// --notes labels inspector notes instead (people, households, buildings, bodies, an even share
//         each): the worker's own note request (cloudflare/narration.js narrationSystem and
//         noteMessage, max 180 tokens, thinking off, low effort), as Plus players get it.
//         fetch keeps a note's text and whether the worker would show it (noteOk).
// send    submits the batch (needs --yes) and writes DIR/batch.json.
// fetch   when the batch has ended, writes DIR/labels.jsonl ({facts, field: 'why', text,
//         model, seeds, split}) for scripts/narration-export.js --labels, and prints how many
//         pass the narrator's checks.
//
// The key is read from ANTHROPIC_API_KEY, or from --key-file (default
// ~/.config/hearthvale/anthropic-key). It is never printed or written anywhere.
import {createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {buildProsePrompt} from '../server/narrator.js';
import {modelRow} from './narration-export.js';
import {parseJsonReply} from '../server/narrator.js';
import {narrationSystem, noteMessage, noteOk, NOTE_MAX_TOKENS, validateNarrationFacts} from '../cloudflare/narration.js';

export const NOTE_KINDS = ['person', 'household', 'building', 'body'];

export const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 420;               // PROSE_TOKENS.card in server/narrator.js
// $ per million tokens: Haiku 5.5 (prompts up to 100K tokens), Batch API at 50%.
const PRICE = {input: 0.10 * 0.5, output: 0.50 * 0.5, cacheWrite: 0.10 * 0.5 * 1.25, cacheRead: 0.10 * 0.5 * 0.1};
const CHARS_PER_TOKEN = 3.1;          // rough, for the Haiku 5.5 tokenizer; the batch reports real usage
const OUTPUT_TOKENS = {typical: 150, worst: MAX_TOKENS};

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}
const writeLines = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const rank = (s) => createHash('sha256').update(s).digest('hex');
const arg = (args, name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

// Cards grouped by template, taken round-robin so rare templates are not crowded out.
function spread(cards, n) {
  const groups = new Map();
  for (const c of cards.sort((a, b) => (rank(a.key) < rank(b.key) ? -1 : 1))) {
    const t = c.facts.template ?? '?';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(c);
  }
  const out = [];
  const lists = [...groups.values()];
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
  }
  return {picked: out, templates: groups.size};
}

export function request(key, facts) {
  const [system, user] = buildProsePrompt(facts);
  return {
    custom_id: key,
    params: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: {type: 'disabled'},
      system: [{type: 'text', text: system.content, cache_control: {type: 'ephemeral'}}],
      messages: [{role: 'user', content: user.content}],
    },
  };
}

// An inspector note, asked for as the worker asks (cloudflare/narration.js narrateAnthropic).
export function noteRequest(key, facts) {
  const clean = validateNarrationFacts({facts});
  return {
    custom_id: key,
    params: {
      model: MODEL,
      max_tokens: NOTE_MAX_TOKENS,
      thinking: {type: 'disabled'},
      output_config: {effort: 'low'},
      system: [{type: 'text', text: narrationSystem(clean), cache_control: {type: 'ephemeral'}}],
      messages: [{role: 'user', content: noteMessage(clean)}],
    },
  };
}

// Entity sheets, an even share of each kind (round-robin by kind, ranked by key).
function spreadKinds(sheets, n) {
  const by = new Map(NOTE_KINDS.map((k) => [k, []]));
  for (const s of sheets.sort((a, b) => (rank(a.key) < rank(b.key) ? -1 : 1))) by.get(s.type)?.push(s);
  const out = [], lists = [...by.values()];
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
  return {picked: out, templates: [...by.values()].filter((l) => l.length).length};
}

async function build(args) {
  const [sheetsFile] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const dir = arg(args, '--out');
  const heldOut = new Set(String(arg(args, '--held-out', '')).split(',').filter(Boolean).map(Number));
  if (!sheetsFile || !dir || !heldOut.size) throw new Error('usage: build SHEETS.jsonl --out DIR --held-out 1,2,3 [--train 4000] [--test 300]');
  const nTrain = Number(arg(args, '--train', 4000)), nTest = Number(arg(args, '--test', 300));
  const notes = args.includes('--notes');

  const train = [], test = [];
  for await (const s of readLines(sheetsFile)) {
    if (notes ? !NOTE_KINDS.includes(s.type) : s.type !== 'card') continue;
    if (s.seeds.every((x) => heldOut.has(x))) test.push(s);
    else if (!s.seeds.some((x) => heldOut.has(x))) train.push(s);
  }
  const pick = notes ? spreadKinds : spread;
  const a = pick(train, nTrain), b = pick(test, nTest);
  const picked = [...a.picked.map((s) => ({s, split: 'train'})), ...b.picked.map((s) => ({s, split: 'test'}))];
  mkdirSync(dir, {recursive: true});
  const requests = picked.map(({s}) => (notes ? noteRequest : request)(s.key, s.facts));
  writeLines(join(dir, 'requests.jsonl'), requests);
  writeLines(join(dir, 'manifest.jsonl'), picked.map(({s, split}) => ({custom_id: s.key, split, seeds: s.seeds, ...(notes ? {note: true, kind: s.type} : {template: s.facts.template})})));

  const sysTokens = requests[0].params.system[0].text.length / CHARS_PER_TOKEN;
  const userTokens = requests.reduce((n, r) => n + r.params.messages[0].content.length, 0) / CHARS_PER_TOKEN;
  const n = requests.length;
  const cost = (out, cached) => {
    const sys = cached ? sysTokens * PRICE.cacheWrite + sysTokens * (n - 1) * PRICE.cacheRead : sysTokens * n * PRICE.input;
    return (sys + userTokens * PRICE.input + n * out * PRICE.output) / 1e6;
  };
  const typical = notes ? 45 : OUTPUT_TOKENS.typical, worst = notes ? NOTE_MAX_TOKENS : OUTPUT_TOKENS.worst;
  console.log(`${notes ? 'entity sheets' : 'cards'}: ${train.length} on training seeds, ${test.length} on held-out seeds`);
  console.log(`picked: ${a.picked.length} train over ${a.templates} templates, ${b.picked.length} test over ${b.templates} templates -> ${dir}`);
  console.log(`tokens (estimated): system prompt ${Math.round(sysTokens)}, user ${Math.round(userTokens / n)} per card on average`);
  console.log(`input, all requests: ${(n * sysTokens / 1e6).toFixed(2)}M system + ${(userTokens / 1e6).toFixed(2)}M user`);
  console.log(`cost at batch prices (${MODEL}):`);
  console.log(`  ~${typical} output tokens a reply, no cache hits:   $${cost(typical, false).toFixed(2)}`);
  console.log(`  ~${typical} output tokens a reply, system prompt cached: $${cost(typical, true).toFixed(2)}`);
  console.log(`  worst case (every reply hits ${worst} tokens, no cache):  $${cost(worst, false).toFixed(2)}`);
}

async function client(args) {
  let apiKey = process.env.ANTHROPIC_API_KEY;
  const file = arg(args, '--key-file', join(homedir(), '.config', 'hearthvale', 'anthropic-key'));
  if (!apiKey && existsSync(file)) apiKey = readFileSync(file, 'utf8').trim();
  if (!apiKey) throw new Error(`No key: set ANTHROPIC_API_KEY or write it to ${file}`);
  let Anthropic;
  try {
    ({default: Anthropic} = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('Install the SDK first: npm install --save-dev @anthropic-ai/sdk');
  }
  return new Anthropic({apiKey});
}

async function send(args) {
  const dir = args[0];
  if (!args.includes('--yes')) throw new Error('send submits a paid batch: add --yes to go ahead');
  if (existsSync(join(dir, 'batch.json'))) throw new Error(`${dir}/batch.json exists: this batch was already sent`);
  const requests = [];
  for await (const r of readLines(join(dir, 'requests.jsonl'))) requests.push(r);
  const api = await client(args);
  const batch = await api.messages.batches.create({requests});
  writeFileSync(join(dir, 'batch.json'), JSON.stringify({id: batch.id, requests: requests.length, created: batch.created_at}, null, 1));
  console.log(`sent ${requests.length} requests: batch ${batch.id}, ${batch.processing_status}`);
}

async function fetchResults(args) {
  const dir = args[0];
  const {id} = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8'));
  const api = await client(args);
  const batch = await api.messages.batches.retrieve(id);
  if (batch.processing_status !== 'ended') {
    console.log(`batch ${id}: ${batch.processing_status}`, batch.request_counts);
    return;
  }
  const facts = new Map();
  for await (const r of readLines(join(dir, 'requests.jsonl'))) facts.set(r.custom_id, r);
  const manifest = new Map();
  for await (const m of readLines(join(dir, 'manifest.jsonl'))) manifest.set(m.custom_id, m);
  const sheets = arg(args, '--sheets');
  const sheetFacts = new Map();
  if (sheets) for await (const s of readLines(sheets)) if (manifest.has(s.key)) sheetFacts.set(s.key, s.facts);

  const labels = [], tally = {train: {n: 0, pass: 0}, test: {n: 0, pass: 0}}, failed = {};
  const usage = {input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0};
  for await (const r of await api.messages.batches.results(id)) {
    const m = manifest.get(r.custom_id);
    if (r.result.type !== 'succeeded') { failed[r.result.type] = (failed[r.result.type] ?? 0) + 1; continue; }
    const msg = r.result.message;
    for (const k of Object.keys(usage)) usage[k] += msg.usage?.[k] ?? 0;
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const f = sheetFacts.get(r.custom_id);
    const t = tally[m.split];
    t.n++;
    if (m.note) {
      // Plain text, as the worker streams it; ok: whether the worker would show it.
      const note = text.trim(), ok = noteOk(note);
      if (ok) t.pass++;
      labels.push({facts: f ?? null, field: 'text', kind: m.kind, text: note, ok, model: MODEL, seeds: m.seeds, split: m.split});
      continue;
    }
    const why = parseJsonReply(text)?.why;
    if (typeof why !== 'string') continue;
    if (f && modelRow(f, 'why', why).task) t.pass++;
    labels.push({facts: f ?? null, field: 'why', text: why, model: MODEL, seeds: m.seeds, split: m.split, reply: text});
  }
  writeLines(join(dir, 'labels.jsonl'), labels);
  const cost = (usage.input_tokens * PRICE.input + usage.output_tokens * PRICE.output
    + usage.cache_creation_input_tokens * PRICE.cacheWrite + usage.cache_read_input_tokens * PRICE.cacheRead) / 1e6;
  console.log(`labels: ${labels.length} -> ${dir}/labels.jsonl`, Object.keys(failed).length ? failed : '');
  if (sheets) for (const [split, t] of Object.entries(tally)) console.log(`${split}: ${t.pass}/${t.n} pass the narrator's checks`);
  console.log('usage', usage, `cost $${cost.toFixed(2)}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (process.argv[1]?.endsWith('narration-label-batch.js')) {
  const run = {build, send, fetch: fetchResults}[cmd];
  if (!run) throw new Error('usage: narration-label-batch.js build|send|fetch ...');
  await run(rest);
}
