// Collect the narrator's fact sheets from headless towns, for a small model
// that writes narration from triples (src/narration-features.js).
//
//   node scripts/narration-collect.js OUT_DIR [--seeds 40] [--years 150] [--start 1] [--workers N] [--entities 8]
//
// A stopped run picks up where it left off: seeds already in OUT_DIR/parts are not rerun.
//
// Each seed grows a town as scripts/distill-collect.js does (water archetype and
// council style rotate with the seed; decisions get the game's own fallback
// answers; people are not stepped) and records, as the game would ask for them:
//   card     every docket card when it first surfaces, before the council rules
//   year     each year's chronicle sheet, once the year's line is written
//   person, household, building, body
//            --entities sheets of each kind a year, picked by a hash of the seed
//            and year (all bodies, which are few)
//   end      the end page's sheet, once, at the last year
// Every sheet is validated as the narrator validates it; refused ones are counted.
//
// Writes OUT_DIR/sheets.jsonl ({key, type, facts, n, seeds, firstYear}), one line
// per distinct sheet across seeds, and prints counts per type. Nothing is sent
// anywhere: scripts/narration-export.js pairs the sheets with prose.
import {fork} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {createHash} from 'node:crypto';
import {mkdirSync, createWriteStream, createReadStream, rmSync, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {STYLES} from './council-styles.js';

export const sheetKey = (facts) => createHash('sha256').update(JSON.stringify(facts)).digest('base64url').slice(0, 24);

async function runChild() {
  const {createState, stepTick} = await import('../src/sim/index.js');
  const {standInCouncil} = await import('../src/sim/fixtures.js');
  const {fallbackFor} = await import('../src/sim/decisions/effects.js');
  const {ARCHETYPES} = await import('../src/waters.js');
  const {hash32} = await import('../src/sim/rng.js');
  const {cardFacts, cardsNeedingProse, narrativeFacts, chronicleFacts} = await import('../src/sim/narrative-facts.js');
  const {validateFacts} = await import('../src/narrative-schema.js');
  const {validateProseFacts} = await import('../src/narrative-prose.js');

  process.on('message', async ({seed, index, years, entities, dir}) => {
    const archetype = ARCHETYPES[index % ARCHETYPES.length];
    const styleNames = Object.keys(STYLES);
    const style = styleNames[index % styleNames.length];
    const state = createState(seed, {archetype});
    const council = standInCouncil({seed, ...STYLES[style]});
    const sheets = new Map();
    const counts = {}, refused = {};

    const keep = (facts) => {
      if (!facts) return;
      const type = facts.type ?? facts.kind;
      let clean;
      try {
        clean = facts.type ? validateProseFacts(facts) : validateFacts(facts);
      } catch {
        refused[type] = (refused[type] ?? 0) + 1;
        return;
      }
      const key = sheetKey(clean);
      const seen = sheets.get(key);
      if (seen) seen.n++;
      else sheets.set(key, {key, type, facts: clean, n: 1, firstYear: state.time.year});
      counts[type] = (counts[type] ?? 0) + 1;
    };

    // The same deterministic sample of a list for a given seed, year and kind.
    const sample = (list, k, salt) => {
      if (list.length <= k) return list;
      return [...list].map((x, i) => [hash32((seed * 31 + state.time.year) * 7919 + salt * 104729 + i), x])
        .sort((a, b) => a[0] - b[0]).slice(0, k).map(([, x]) => x);
    };

    const bus = {
      ask(kind, id, context, {allowed, state: snapshot} = {}) {
        const probabilities = fallbackFor(kind, context, snapshot, state, allowed ?? undefined);
        const choice = Object.keys(probabilities).reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
        return {kind, choice, confidence: probabilities[choice], probabilities};
      },
      stats: () => ({state: 'idle', room: 8}),
    };

    const t0 = performance.now();
    const seenCards = new Set();
    let lastYear = state.time.year, yearDue = null;
    while (state.time.year < years) {
      stepTick(state, 1, {decisions: bus}, {skipPeople: true});
      // Cards as the narrator sees them: before the council rules on them.
      // Only the cards the game would narrate (cardsNeedingProse: no budget cards).
      for (const card of cardsNeedingProse(state)) {
        const id = `${card.id}:${card.proseRevision ?? 0}`;
        if (seenCards.has(id)) continue;
        seenCards.add(id);
        keep(cardFacts(state, card.id));
      }
      council(state);
      await null;
      // The year's chronicle line is written a tick after the year turns.
      if (yearDue != null && (state.chronicle?.entries ?? []).some((e) => e.kind === 'year' && e.year === yearDue + 1)) {
        keep(chronicleFacts(state, {year: yearDue}));
        yearDue = null;
      }
      if (state.time.year !== lastYear) {
        lastYear = state.time.year;
        yearDue = lastYear - 1;
        for (const p of sample(state.people ?? [], entities, 1)) keep(narrativeFacts(state, {personId: p.id}));
        for (const h of sample(state.households ?? [], entities, 2)) keep(narrativeFacts(state, {householdId: h.id}));
        for (const b of sample(state.buildings ?? [], entities, 3)) keep(narrativeFacts(state, {buildingId: b.id}));
        for (const b of state.institutions ?? []) keep(narrativeFacts(state, {bodyId: b.id}));
      }
    }
    keep(chronicleFacts(state, {end: true}));
    await writeLines(join(dir, `sheets-${seed}.jsonl`), sheets.values());
    process.send({seed, archetype, style, pop: state.indicators.pop, era: state.era, sheets: sheets.size, counts, refused,
      seconds: Math.round((performance.now() - t0) / 1000)});
  });
}

function writeLines(file, rows) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    out.on('error', reject);
    for (const row of rows) out.write(`${JSON.stringify(row)}\n`);
    out.end(resolve);
  });
}

async function* readLines(file) {
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}

async function runParent() {
  const [dir] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  if (!dir) throw new Error('usage: node scripts/narration-collect.js OUT_DIR [--seeds 40] [--years 150] [--start 1] [--workers N] [--entities 8]');
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const seeds = arg('seeds', 40), years = arg('years', 150), start = arg('start', 1), entities = arg('entities', 8);
  const workers = Math.max(1, arg('workers', Math.max(1, availableParallelism() - 2)));
  const parts = join(dir, 'parts');
  mkdirSync(parts, {recursive: true});
  const jobs = [];
  for (let k = 0; k < seeds; k++) jobs.push({seed: 1000 + (start + k) * 7919, index: start + k, years, entities, dir: parts});
  // A stopped run resumes: seeds whose file is already in OUT_DIR/parts are kept as they are.
  const todo = jobs.filter((j) => !existsSync(join(parts, `sheets-${j.seed}.jsonl`)));
  if (todo.length < jobs.length) process.stderr.write(`resuming: ${jobs.length - todo.length} of ${jobs.length} seeds already collected\n`);
  const results = await pool(todo, workers);

  // Merge: one line per distinct sheet across seeds.
  const sheets = new Map();
  for (const r of jobs) {
    for await (const s of readLines(join(parts, `sheets-${r.seed}.jsonl`))) {
      const seen = sheets.get(s.key);
      if (seen) {
        seen.n += s.n;
        seen.seeds.push(r.seed);
        seen.firstYear = Math.min(seen.firstYear, s.firstYear);
      } else sheets.set(s.key, {...s, seeds: [r.seed]});
    }
  }
  await writeLines(join(dir, 'sheets.jsonl'), sheets.values());
  rmSync(parts, {recursive: true, force: true});

  const byType = {};
  for (const s of sheets.values()) {
    const t = (byType[s.type] ??= {distinct: 0, seen: 0, refused: 0});
    t.distinct++;
    t.seen += s.n;
  }
  for (const r of results) for (const [type, n] of Object.entries(r.refused)) (byType[type] ??= {distinct: 0, seen: 0, refused: 0}).refused += n;
  console.log(`\n${seeds} seeds to year ${years}: ${sheets.size} distinct sheets`);
  console.log('type         distinct      seen  refused');
  for (const [type, t] of Object.entries(byType).sort((a, b) => b[1].distinct - a[1].distinct)) {
    console.log(`${type.padEnd(10)} ${String(t.distinct).padStart(10)} ${String(t.seen).padStart(9)} ${String(t.refused).padStart(8)}`);
  }
}

function pool(jobs, size) {
  return new Promise((resolve, reject) => {
    const results = [];
    if (!jobs.length) return resolve(results);
    let next = 0;
    const self = fileURLToPath(import.meta.url);
    const launch = () => {
      if (next >= jobs.length) return;
      const job = jobs[next++];
      const child = fork(self, ['--child']);
      child.on('message', (r) => {
        results.push(r);
        child.kill();
        process.stderr.write(`seed ${r.seed} (${r.archetype}, ${r.style}): ${r.pop} people, era ${r.era}, ${r.sheets} sheets, ${r.seconds} s\n`);
        if (results.length === jobs.length) resolve(results);
        else launch();
      });
      child.on('exit', (code) => { if (code && !results.some((r) => r.seed === job.seed)) reject(new Error(`seed ${job.seed} exited with ${code}`)); });
      child.send(job);
    };
    for (let i = 0; i < Math.min(size, jobs.length); i++) launch();
  });
}

if (process.argv[2] === '--child') runChild();
else if (process.argv[1] === fileURLToPath(import.meta.url)) await runParent();
