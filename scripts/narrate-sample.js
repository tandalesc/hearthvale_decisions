// Generate inspector notes for a handful of diverse entities against the live
// narrator service and print them with their facts.
//
//   node scripts/narrate-sample.js [--facts] [--count 6] [--cards 4] [--chronicle]
//
// Uses the same server code as /api/narrate (server/narrator.js) and the key in
// local.env. Picks entities from the town and city fixtures that have something
// to tell: hardship, torn slices, rulings that touched them, odd buildings.

import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {fixtureState} from '../src/sim/fixtures.js';
import {narrativeFacts, cardFacts, chronicleFacts} from '../src/sim/narrative-facts.js';
import {factLines} from '../src/narrative-schema.js';
import {cardLines, yearLines, endLines} from '../src/narrative-prose.js';
import {createNarrator} from '../server/narrator.js';
import {loadLocalConfig} from '../server/system1.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const showFacts = args.includes('--facts');
const numberArg = (name, fallback) => {
  const n = args.includes(name) ? Number(args[args.indexOf(name) + 1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const count = numberArg('--count', 6);
const cardCount = numberArg('--cards', 4);
const withChronicle = args.includes('--chronicle');

// How much a fact sheet has to tell (higher is more interesting).
function interest(f) {
  let n = 0;
  n += (f.rulings ?? []).filter((r) => r.fx === 'hurt' || r.fx === 'helped').length * 2;
  n += (f.torn ?? []).length * 2;
  n += (f.story ?? []).filter((s) => ['protest', 'strike', 'hungry', 'lost-job', 'closed', 'loan', 'moved', 'trade', 'derelict', 'damaged'].includes(s.kind)).length * 2;
  if (f.now?.mood === 'angry' || f.now?.mood === 'uneasy') n += 3;
  if (f.now?.moodTrend === 'falling' || f.now?.wealthTrend === 'falling') n += 2;
  if (f.now?.work === 'idle' || f.now?.work === 'short') n += 2;
  if (f.now?.hungry) n += 3;
  if (f.business?.profit === 'losing') n += 3;
  if (f.building?.flags?.length) n += 2;
  if (f.who?.newcomer) n += 1;
  return n;
}

// The most interesting entity of each wanted shape, never the same trade twice.
function pick(state, fixture) {
  const people = state.people.map((p) => narrativeFacts(state, {personId: p.id}));
  const buildings = state.buildings.map((b) => narrativeFacts(state, {buildingId: b.id}));
  const best = (list, test, used = new Set()) => list
    .filter((f) => f && test(f) && !used.has(f.who?.trade))
    .sort((a, b) => interest(b) - interest(a))[0];
  const usedTrades = new Set();
  const out = [];
  const take = (f) => { if (f) { out.push({fixture, facts: f}); usedTrades.add(f.who?.trade); } };
  take(best(people, (f) => f.now?.wealth === 'poor', usedTrades));
  take(best(people, (f) => f.now?.wealth !== 'poor', usedTrades));
  take(best(buildings, (f) => !!f.business));
  take(best(buildings, (f) => f.building.type === 'home' && !!f.residents));
  return out;
}

const config = await loadLocalConfig(root);
if (!config.key) {
  console.error('No API_KEY in local.env; the narrator needs the local service.');
  process.exit(1);
}
const narrator = createNarrator({loadConfig: async () => config});

const town = fixtureState('town');
const city = fixtureState('city');
const samples = [...pick(town, 'town'), ...pick(city, 'city')];
const body = city.institutions.find((b) => b.status === 'active' && b.kind !== 'moot');
if (body) samples.push({fixture: 'city', facts: narrativeFacts(city, {bodyId: body.id})});

for (const {fixture, facts} of samples.slice(0, count)) {
  const t0 = performance.now();
  let first = null, note = '', meta = null, failure = null;
  await narrator.handle({facts, entityKind: facts.kind}, {
    open(m) { meta = m; },
    token() { first ??= performance.now() - t0; },
    done(text) { note = text; },
    fail(status, b) { failure = `${status} ${b.error}`; },
  });
  const ms = Math.round(performance.now() - t0);
  console.log(`\n=== ${fixture} ${facts.kind}: ${facts.name}  (${JSON.stringify(facts).length} B facts, ${ms} ms, first text ${Math.round(first ?? 0)} ms, ${meta?.model ?? 'n/a'})`);
  if (showFacts) console.log(factLines(facts).map((l) => `  · ${l}`).join('\n'));
  console.log(failure ? `  FAILED: ${failure}` : `  ${note}  [${note.split(/\s+/).length} words]`);
}

// ---------------------------------------------------------------------------
// Cards and the chronicle: template text beside the model's

async function prose(kind, facts) {
  const t0 = performance.now();
  let out = null, failure = null;
  await narrator.handle({kind, facts}, {
    result(body) { out = body; },
    fail(status, body) { failure = `${status} ${body.error}`; },
    open() {}, token() {}, done() {},
  });
  return {out, failure, ms: Math.round(performance.now() - t0)};
}

const wrap = (label, text) => `  ${label.padEnd(10)} ${text}`;

const cards = [...town.docket.map((c) => [town, c]), ...city.docket.map((c) => [city, c])].slice(0, cardCount);
for (const [state, card] of cards) {
  const facts = cardFacts(state, card.id);
  const {out, failure, ms} = await prose('card', facts);
  console.log(`\n=== card ${card.id}: ${card.title}  (${facts.asker.name}, ${facts.asker.role ?? ''}; ${JSON.stringify(facts).length} B facts, ${ms} ms, ${out?.source ?? 'failed'}${out?.reason ? `: ${out.reason}` : ''})`);
  if (showFacts) console.log(cardLines(facts).map((l) => `  · ${l}`).join('\n'));
  if (failure) { console.log(`  FAILED: ${failure}`); continue; }
  console.log(wrap('template', card.why));
  const tag = (field) => (field === 'template' ? '(template kept) ' : '');
  console.log(wrap('llm', `${tag(out.used?.why ?? (out.source === 'template' ? 'template' : 'llm'))}${out.prose.why}${out.reasons?.why ? `   [why refused: ${out.reasons.why}]` : ''}`));
  for (const o of card.options) {
    console.log(wrap(`[${o.key}]`, `${o.label}`));
    console.log(wrap('  template', o.tradeoff));
    const used = out.used?.options?.[o.key] ?? (out.source === 'template' ? 'template' : 'llm');
    console.log(wrap('  llm', `${tag(used)}${out.prose.options[o.key]}${out.reasons?.[o.key] ? `   [refused: ${out.reasons[o.key]}]` : ''}`));
  }
}

if (withChronicle) {
  for (const state of [town, city]) {
    const facts = chronicleFacts(state, {});
    const {out, failure, ms} = await prose('chronicle', facts);
    console.log(`\n=== year ${facts.year} (${ms} ms, ${out?.source ?? 'failed'}${out?.reason ? `: ${out.reason}` : ''})`);
    if (showFacts) console.log(yearLines(facts).map((l) => `  · ${l}`).join('\n'));
    console.log(wrap('template', facts.template ?? ''));
    console.log(wrap('llm', failure ?? out.prose.text));
  }
  const end = chronicleFacts(city, {end: true});
  const {out, failure, ms} = await prose('chronicle', end);
  console.log(`\n=== end of chronicle (${JSON.stringify(end).length} B facts, ${ms} ms, ${out?.source ?? 'failed'}${out?.reason ? `: ${out.reason}` : ''})`);
  if (showFacts) console.log(endLines(end).map((l) => `  · ${l}`).join('\n'));
  if (failure) console.log(`  FAILED: ${failure}`);
  else {
    for (const e of out.prose.eras) console.log(wrap(`era ${e.era}`, e.text));
    for (const c of out.prose.closing) console.log(wrap('closing', c));
  }
}
