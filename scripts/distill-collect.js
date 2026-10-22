// Collect the decision questions headless towns ask, for distilling the
// decision model into a small student (docs/design/decision-distillation.md §3.2).
//
//   node scripts/distill-collect.js OUT_DIR [--seeds 40] [--years 150] [--start 1] [--workers 6] [--room 8] [--needs 2]
//        [--answer fallback|student|teacher] [--student BUNDLE.json] [--env ROOT] [--hybrid]
//        [--salts 1] [--salt-start 0] [--burst]
//
// Each seed grows a town with a stand-in council (styles and water archetypes
// rotate with the seed) and a recording decision bus: it validates every
// question exactly as the client does, records it under the client's cache key
// and answers at once with the game's own fallback distribution, so the town
// runs as an online one (routine sweeps, refinement, walker questions) without
// a model. People are not stepped (as in scripts/balance.js), so walkers' needs
// stand still; --needs adds that many copies of each walker question with
// random need bands (marked `aug`).
//
// Writes OUT_DIR/questions.jsonl ({key, kind, context, allowed, state, n,
// seeds, firstYear, aug}) and OUT_DIR/states.jsonl ({state, snapshot}), one
// line per distinct question or state across all seeds, then prints counts per
// kind. Nothing is sent anywhere: labelling is scripts/distill-label.js.
//
// --answer changes who answers, for the on-policy round and the town-outcome
// gate (§3.6–3.7): 'student' answers the kinds a student bundle knows with it
// (the rest with fallbacks); 'teacher' sends every question to the decision
// model (local.env in ROOT) and waits for the answers before the next game
// second, so latency cannot tell the runs apart. Each seed also records the
// town year by year and the routine answers' shares by time of day; the summary
// goes to OUT_DIR/towns.json and is printed. --hybrid (with --answer student)
// sends the kinds the student does not answer to the decision model, as the
// game does, instead of the fallbacks.
//
// --salts N grows each seed N times, re-seeding the town's main random stream
// right after it is created (salt 0 leaves it alone): the same map and start,
// different luck. The spread across salts is the noise floor a student has to
// stay within. --burst steps one tick at a time and records, per tick, how many
// questions the student answered and how long that took.
import {fork} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {mkdirSync, createWriteStream, createReadStream, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {STYLES} from './council-styles.js';

const NEEDS = ['low', 'ok', 'high'];

async function runChild() {
  const {createState, stepTick} = await import('../src/sim/index.js');
  const {standInCouncil} = await import('../src/sim/fixtures.js');
  const {fallbackFor} = await import('../src/sim/decisions/effects.js');
  const {validateQuestion, validateState, stateKey} = await import('../src/decision-kinds.js');
  const {ARCHETYPES} = await import('../src/waters.js');

  process.on('message', async ({seed, index, years, room, needs, dir, answer = 'fallback', student: bundleFile, env, hybrid = false, salt = 0, burst = false}) => {
    let student = null, config = null, requestDecisions = null;
    if (answer === 'student') {
      const {loadStudent} = await import('../src/decision-student.js');
      student = loadStudent(JSON.parse(readFileSync(bundleFile, 'utf8')));
    }
    if (answer === 'teacher' || (answer === 'student' && hybrid)) {
      const system1 = await import('../server/system1.js');
      config = await system1.loadLocalConfig(env);
      requestDecisions = system1.requestDecisions;
    }
    const archetype = ARCHETYPES[index % ARCHETYPES.length];
    const styleNames = Object.keys(STYLES);
    const style = styleNames[index % styleNames.length];
    const state = createState(seed, {archetype});
    if (salt) {
      // Same map and start, different luck from here on.
      let h = (state.rng.main ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
      state.rng.main = ((h ^ (h >>> 13)) >>> 0) || 1;
    }
    const council = standInCouncil({seed, ...STYLES[style]});
    // --burst: student answers and their time within the current tick.
    const tickLoad = {n: 0, ms: 0};
    const questions = new Map(), states = new Map();
    let rand = seed >>> 0;
    const random = () => ((rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0) / 4294967296);

    // Routine answers' shares by time of day, and the town year by year.
    const shares = {};
    const tally = (question, probabilities) => {
      if (question.kind !== 'resident_routine' || !probabilities) return;
      const row = (shares[question.context.timeOfDay] ??= {});
      for (const [o, p] of Object.entries(probabilities)) row[o] = (row[o] ?? 0) + p;
    };
    const town = [];
    // Teacher mode: questions wait here until the game second ends; exact repeats are cached.
    const pending = [], taught = new Map();

    const record = (question, cleanState, sKey, aug) => {
      const key = `${question.kind}|${sKey}|${JSON.stringify([question.context, question.allowed])}`;
      const seen = questions.get(key);
      if (seen) seen.n++;
      else questions.set(key, {key, kind: question.kind, context: question.context, allowed: question.allowed, state: sKey, n: 1, firstYear: state.time.year, aug});
      if (!states.has(sKey)) states.set(sKey, cleanState);
    };

    const bus = {
      ask(kind, id, context, {allowed, state: snapshot} = {}) {
        let question, cleanState;
        try {
          question = validateQuestion({kind, id, context, ...(allowed ? {allowed} : {})});
          cleanState = validateState(question.kind, snapshot);
        } catch {
          return null;
        }
        const sKey = stateKey(cleanState);
        record(question, cleanState, sKey, false);
        // Walkers' needs stand still without people stepping: add need variants.
        if (kind === 'resident_routine' && question.context.energy) {
          for (let k = 0; k < needs; k++) {
            const variant = {...question.context, energy: NEEDS[Math.floor(random() * 3)], fullness: NEEDS[Math.floor(random() * 3)],
              social: NEEDS[Math.floor(random() * 3)]};
            record({...question, context: variant}, cleanState, sKey, true);
          }
        }
        if (student?.kinds.has(kind)) {
          const t0 = burst ? performance.now() : 0;
          const a = student.answer(question.kind, cleanState, question.context, question.allowed);
          if (burst) { tickLoad.n++; tickLoad.ms += performance.now() - t0; }
          tally(question, a.probabilities);
          return a;
        }
        if (config) {
          const key = `${question.kind}|${sKey}|${JSON.stringify([question.context, question.allowed])}`;
          if (taught.has(key)) {
            tally(question, taught.get(key)?.probabilities);
            return taught.get(key);
          }
          return new Promise((resolve) => pending.push({key, question, cleanState, sKey, snapshot, resolve}));
        }
        const probabilities = fallbackFor(kind, context, snapshot, state, allowed ?? undefined);
        const choice = Object.keys(probabilities).reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
        tally(question, probabilities);
        return {kind, choice, confidence: probabilities[choice], probabilities};
      },
      stats: () => ({state: 'idle', room}),
    };

    // Sends the waiting questions (grouped by state, 64 a request, 4 in flight)
    // and resolves them; anything unanswered gets its fallback.
    async function teach() {
      const batch = pending.splice(0);
      const byState = new Map();
      for (const p of batch) {
        if (!byState.has(p.sKey)) byState.set(p.sKey, []);
        byState.get(p.sKey).push(p);
      }
      const requests = [];
      let cur = [], count = 0;
      for (const list of byState.values()) {
        for (let i = 0; i < list.length;) {
          if (count >= 64 || cur.length >= 64) { requests.push(cur); cur = []; count = 0; }
          const take = list.slice(i, i + 64 - count);
          cur.push(take);
          count += take.length;
          i += take.length;
        }
      }
      if (cur.length) requests.push(cur);
      let next = 0;
      const work = async () => {
        while (next < requests.length) {
          const groups = requests[next++];
          let answers = {};
          try {
            let n = 0;
            const wire = groups.map((g) => ({state: g[0].cleanState, questions: g.map((p) => ({...p.question, id: `q${n++}`}))}));
            ({answers} = await requestDecisions(config, wire));
          } catch { /* fallbacks below */ }
          let n = 0;
          for (const g of groups) {
            for (const p of g) {
              let a = answers[`q${n++}`] ?? null;
              if (!a) {
                const probabilities = fallbackFor(p.question.kind, p.question.context, p.snapshot, state, p.question.allowed ?? undefined);
                const choice = Object.keys(probabilities).reduce((x, y) => (probabilities[y] > probabilities[x] ? y : x));
                a = {kind: p.question.kind, choice, confidence: probabilities[choice], probabilities};
              } else taught.set(p.key, a);
              tally(p.question, a.probabilities);
              p.resolve(a);
            }
          }
        }
      };
      await Promise.all([work(), work(), work(), work()]);
    }

    const t0 = performance.now();
    let lastYear = state.time.year;
    const ticks = [];   // --burst: [year, month, answers, ms] for ticks with any student work
    while (state.time.year < years) {
      // One game second per call (one tick with --burst); answers resolve before the next one.
      tickLoad.n = 0;
      tickLoad.ms = 0;
      stepTick(state, burst ? 0.1 : 1, {decisions: bus}, {skipPeople: true});
      if (burst && tickLoad.n) ticks.push([state.time.year, state.time.month, tickLoad.n, tickLoad.ms]);
      council(state);
      if (pending.length) await teach();
      await null;
      if (state.time.year !== lastYear) {
        lastYear = state.time.year;
        const I = state.indicators;
        town.push({year: lastYear, pop: I.pop, era: state.era, treasury: Math.round(state.treasury), wellbeing: I.wellbeing,
          debt: state.treasury < 0, receivership: !!state.governance?.receivership});
      }
    }
    const qFile = join(dir, `q-${seed}-${salt}.jsonl`), sFile = join(dir, `s-${seed}-${salt}.jsonl`);
    await writeLines(qFile, questions.values());
    await writeLines(sFile, [...states].map(([key, snapshot]) => ({state: key, snapshot})));
    const kinds = {};
    for (const q of questions.values()) kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
    let burstStats = null;
    if (burst && ticks.length) {
      const ms = ticks.map((t) => t[3]).sort((a, b) => a - b), n = ticks.map((t) => t[2]).sort((a, b) => a - b);
      const q = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
      burstStats = {ticks: ticks.length, msMean: ms.reduce((a, b) => a + b, 0) / ms.length, msP99: q(ms, 0.99), msMax: ms.at(-1),
        answersP99: q(n, 0.99), answersMax: n.at(-1), worst: [...ticks].sort((a, b) => b[3] - a[3]).slice(0, 5)};
    }
    process.send({seed, salt, archetype, style, pop: state.indicators.pop, era: state.era, questions: questions.size, states: states.size, kinds,
      seconds: Math.round((performance.now() - t0) / 1000), town, shares, burst: burstStats});
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
  if (!dir) throw new Error('usage: node scripts/distill-collect.js OUT_DIR [--seeds 40] [--years 150] [--start 1] [--workers 6] [--room 8] [--needs 2]');
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const seeds = arg('seeds', 40), years = arg('years', 150), start = arg('start', 1);
  const room = arg('room', 8), needs = arg('needs', 2);
  const text = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const answer = text('answer', 'fallback'), student = text('student', null), env = text('env', join(fileURLToPath(import.meta.url), '..', '..'));
  const hybrid = process.argv.includes('--hybrid'), burst = process.argv.includes('--burst');
  const salts = arg('salts', 1), saltStart = arg('salt-start', 0);
  if (answer === 'student' && !student) throw new Error('--answer student needs --student BUNDLE.json');
  const workers = Math.max(1, arg('workers', Math.max(1, availableParallelism() - 2)));
  const parts = join(dir, 'parts');
  mkdirSync(parts, {recursive: true});
  const jobs = [];
  for (let k = 0; k < seeds; k++) {
    for (let salt = saltStart; salt < saltStart + salts; salt++) {
      jobs.push({seed: 1000 + (start + k) * 7919, index: start + k, years, room, needs, dir: parts, answer, student, env, hybrid, salt, burst});
    }
  }
  const results = await pool(jobs, workers);

  // Merge: one line per distinct question and state across seeds.
  const questions = new Map(), stateFiles = [];
  for (const r of results) {
    for await (const q of readLines(join(parts, `q-${r.seed}-${r.salt}.jsonl`))) {
      const seen = questions.get(q.key);
      if (seen) {
        seen.n += q.n;
        seen.seeds.push(r.seed);
        seen.firstYear = Math.min(seen.firstYear, q.firstYear);
        seen.aug &&= q.aug;
      } else questions.set(q.key, {...q, seeds: [r.seed]});
    }
    stateFiles.push(join(parts, `s-${r.seed}-${r.salt}.jsonl`));
  }
  await writeLines(join(dir, 'questions.jsonl'), questions.values());
  const states = new Map();
  for (const file of stateFiles) for await (const s of readLines(file)) if (!states.has(s.state)) states.set(s.state, s.snapshot);
  await writeLines(join(dir, 'states.jsonl'), [...states].map(([state, snapshot]) => ({state, snapshot})));
  rmSync(parts, {recursive: true, force: true});

  writeFileSync(join(dir, 'towns.json'), JSON.stringify({answer, student, hybrid, years,
    towns: results.map(({seed, salt, archetype, style, town, shares, burst: b, seconds}) => ({seed, salt, archetype, style, town, shares, burst: b, seconds}))}));
  for (const r of results.filter((x) => x.burst)) {
    console.log(`burst seed ${r.seed}/${r.salt}: ${r.burst.ticks} ticks with student work; per tick mean ${r.burst.msMean.toFixed(2)} ms, ` +
      `p99 ${r.burst.msP99.toFixed(2)} ms, max ${r.burst.msMax.toFixed(1)} ms; answers per tick p99 ${r.burst.answersP99}, max ${r.burst.answersMax}`);
  }
  reportTowns(answer, results);

  const byKind = {};
  for (const q of questions.values()) {
    const k = (byKind[q.kind] ??= {distinct: 0, asked: 0, aug: 0, states: new Set()});
    k.distinct++;
    k.asked += q.n;
    if (q.aug) k.aug++;
    k.states.add(q.state);
  }
  console.log(`\n${seeds} seeds to year ${years}: ${questions.size} distinct questions over ${states.size} distinct states`);
  console.log('kind                      distinct      asked   augmented  states');
  for (const [kind, k] of Object.entries(byKind).sort((a, b) => b[1].distinct - a[1].distinct)) {
    console.log(`${kind.padEnd(24)} ${String(k.distinct).padStart(9)} ${String(k.asked).padStart(10)} ${String(k.aug).padStart(11)} ${String(k.states.size).padStart(7)}`);
  }
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};

// Town outcomes across seeds (medians), and the routine answers' shares.
function reportTowns(answer, results) {
  console.log(`\ntowns answered by ${answer} (medians over ${results.length} seeds)`);
  console.log('year     pop  era  treasury  wellbeing  debt years so far  receivership years so far');
  const last = Math.max(...results.map((r) => r.town.at(-1)?.year ?? 0));
  for (const y of [10, 25, 50, 75, 100, 125, 150].filter((y) => y <= last)) {
    const rows = results.map((r) => r.town.find((t) => t.year === y)).filter(Boolean);
    const upTo = (r, key) => r.town.filter((t) => t.year <= y && t[key]).length;
    console.log(`${String(y).padStart(4)} ${String(median(rows.map((t) => t.pop))).padStart(7)} ${String(median(rows.map((t) => t.era))).padStart(4)} ` +
      `${String(median(rows.map((t) => t.treasury))).padStart(9)} ${String(median(rows.map((t) => t.wellbeing))).padStart(10)} ` +
      `${String(median(results.map((r) => upTo(r, 'debt')))).padStart(18)} ${String(median(results.map((r) => upTo(r, 'receivership')))).padStart(26)}`);
  }
  for (const time of ['morning', 'midday', 'evening']) {
    const total = {};
    for (const r of results) for (const [o, p] of Object.entries(r.shares?.[time] ?? {})) total[o] = (total[o] ?? 0) + p;
    const sum = Object.values(total).reduce((a, b) => a + b, 0);
    if (sum) console.log(`routine ${time.padEnd(8)} ${Object.entries(total).map(([o, p]) => `${o} ${(100 * p / sum).toFixed(1)}%`).join(', ')}`);
  }
}

function pool(jobs, size) {
  return new Promise((resolve, reject) => {
    const results = [];
    let next = 0;
    const self = fileURLToPath(import.meta.url);
    const launch = () => {
      if (next >= jobs.length) return;
      const job = jobs[next++];
      const child = fork(self, ['--child']);
      child.on('message', (r) => {
        results.push(r);
        child.kill();
        process.stderr.write(`seed ${r.seed}${r.salt ? `/${r.salt}` : ''} (${r.archetype}, ${r.style}): ${r.pop} people, era ${r.era}, ${r.questions} questions, ${r.states} states, ${r.seconds} s\n`);
        if (results.length === jobs.length) resolve(results);
        else launch();
      });
      child.on('exit', (code) => { if (code && !results.some((r) => r.seed === job.seed && r.salt === job.salt)) reject(new Error(`seed ${job.seed} exited with ${code}`)); });
      child.send(job);
    };
    for (let i = 0; i < size; i++) launch();
  });
}

if (process.argv[2] === '--child') runChild();
else await runParent();
