// The continual-update loop for decision students (docs/design/decision-distillation.md §7).
//
//   node scripts/distill-loop.js [--state data/loop/state.json] [--publish] [--dry] [--min-clients 1] [--fresh "TRAINER ARGS"] [--extra ROWS.jsonl]
//   node scripts/distill-loop-watch.js --every 60 -- --publish   (a cycle whenever enough is new)
//
// One run turns what players' students flagged into the next student version:
//   1. Read the novel-question log the proxy keeps (server/system1.js
//      fileNovelLog: data/novel/novel.jsonl) and the labels the proxy already
//      got from the teacher for it (novel.jsonl.labels.jsonl).
//   2. Input gates. Every question is validated again, and one already trained
//      on (its key is in a training file) is skipped. One report is enough
//      (--min-clients, default 1): labels come only from the teacher, so a
//      single player can at worst point the teacher at odd states, and the
//      model gates judge the result. What one player can do is bounded instead:
//      at most `maxPerClient` questions per client per cycle (clients are
//      salted hashes; nothing identifies a player), the rest deferred to later
//      cycles in the order they arrived. Each snapshot is checked against
//      everything the headless towns produced: a pair of categorical field
//      values no simulated town showed is "unseen". An ordinary state has 0-2;
//      an impossible one many. Questions with more than `maxUnseenPairs` are
//      "unusual" and make up at most `maxUnusualShare` of a cycle unless
//      `quarantineClients` players reported them; the rest wait. Labels count
//      only from the teacher model (`teacher` in the state's config; any model
//      the service reports when unset), with a full distribution.
//   3. Questions still without a label are sent to the teacher now, at `qps`.
//   4. The next version warm-starts from the current one (train_decision_student.py
//      --init-from: new vocabulary rows, no rebuild) on everything trained so far
//      plus the new rows; its confidence head is retrained; it is exported.
//      --fresh "ARGS" trains it from scratch instead, with those trainer arguments
//      (a new architecture, say "--arch set --state-layers 0 --epochs 20 ..."); the
//      gates and the rest of the cycle are the same. --extra adds training rows
//      gathered on purpose (scripts/distill-export.js output: teacher-labelled
//      questions from towns the student ran), treated like the cycle's new rows.
//   5. Model gates, against the current version on the same sets: real-play KL
//      (distinct and traffic-weighted), each busy kind's traffic-weighted KL,
//      the largest signed option bias overall and in young towns (hamlets and
//      villages, where a lean on staying or leaving slows growth), rare-option
//      ratios, KL on the held-out new rows, JS parity, bundle size and speed, and short canary towns played
//      by the simulated player, as the complete-town comparison is (they must all finish, and the routine
//      work share must stay near the current version's; their population is reported beside it).
//   6. With --publish and every gate passed: the bundle goes to
//      public/students/decisions.vN.json, manifest.json names it latest, and
//      the state file moves on. Otherwise the report says what failed.
// Everything a run did is written to data/loop/vN/report.json.
//
// The state file says where things are and which version is current; a
// published run advances it:
//   {"twm": "/path/to/triples_world_model", "envRoot": "/path/with/local.env",
//    "current": {"run": "<twm>/results/decision_student/...", "version": 1, "bundle": "public/students/decisions.v1.json"},
//    "train": ["data/distill/train-a.jsonl", ...],          // everything trained on so far
//    "realplay": "data/distill/realplay-test.jsonl",         // frozen, teacher-labelled, never trained on
//    "realplayQuestions": "data/distill/gate-teacher/questions.jsonl", "baseline": "data/distill/train-a.jsonl",
//    "reference": ["data/distill/onpolicy-1", ...],          // collection dirs whose states define "seen"
//    "config": {"maxPerClient": 400, "excludeKinds": [...], ...}}  // overrides of the defaults below;
//                                                            // excludeKinds: kinds left to the hosted model
import {spawn} from 'node:child_process';
import {createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, statSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateQuestion, validateState, stateKey, MAX_QUESTIONS_PER_REQUEST} from '../src/decision-kinds.js';
import {decisionTriples, decisionOptions, FEATURES_VERSION} from '../src/decision-features.js';
import {SNAPSHOTS, KIND_BY_ID} from '../src/sim/decisions/kinds.js';
import {loadLocalConfig, requestDecisions} from '../server/system1.js';
import {loadStudent} from '../src/decision-student.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const statePath = resolve(ROOT, flag('state', 'data/loop/state.json'));
if (!existsSync(statePath)) throw new Error(`No loop state at ${statePath}; the header of scripts/distill-loop.js shows its shape`);
const S = JSON.parse(readFileSync(statePath, 'utf8'));
const cfg = {
  novel: 'data/novel/novel.jsonl', teacher: null, minClients: 1, maxPerClient: 400, maxUnusualShare: 0.25, quarantineClients: 3, maxUnseenPairs: 2,
  minRows: 50, qps: 40,
  epochs: 6, lr: 1e-3, maxBundleKB: 450, maxCachedUs: 400, tolerance: 0.03, kindTolerance: 0.2, maxBias: 0.05, tail: [0.67, 1.5],
  workShareDelta: 3, canary: {seeds: 4, start: 65, years: 40}, publishDir: 'public/students', excludeKinds: [],
  ...S.config,
};
if (flag('min-clients', null)) cfg.minClients = Number(flag('min-clients'));
const publish = args.includes('--publish'), dry = args.includes('--dry'), fresh = flag('fresh', null), extra = flag('extra', null);
const next = S.current.version + 1;
const out = resolve(ROOT, 'data', 'loop', `v${next}`);
mkdirSync(out, {recursive: true});
const report = {version: next, from: S.current.version, at: new Date().toISOString(), config: cfg, steps: {}, gates: {}, published: false};
const save = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const log = (...a) => console.log(...a);
const p = (f) => resolve(ROOT, f);

async function* readLines(file) {
  if (!existsSync(file)) return;
  for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) if (line) yield JSON.parse(line);
}
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, cmdArgs, {cwd: opts.cwd ?? ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let text = '';
    child.stdout.on('data', (d) => { text += d; if (opts.echo) process.stdout.write(d); });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', (code) => (code === 0 || opts.allowFail ? ok({code, text}) : fail(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}\n${text.slice(-2000)}`))));
  });
}
const hash32 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; };
const writeJsonl = (file, rows) => new Promise((ok) => { const w = createWriteStream(file); for (const r of rows) w.write(JSON.stringify(r) + '\n'); w.end(ok); });

// Field-value pairs of a snapshot, categorical fields only (enums and small
// integer ranges): names, ids and free text are unique by nature, so they say
// nothing about whether a state is plausible.
const CATEGORICAL = new Set(Object.values(SNAPSHOTS).flatMap((schema) => Object.entries(schema)
  .filter(([, f]) => f.type === 'enum' || (f.type === 'int' && f.max - f.min <= 12)).map(([name]) => name)));
function pairs(snapshot) {
  const keys = Object.keys(snapshot ?? {}).filter((k) => CATEGORICAL.has(k)).sort();
  const outPairs = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) outPairs.push(`${keys[i]}=${snapshot[keys[i]]}|${keys[j]}=${snapshot[keys[j]]}`);
  return outPairs;
}

// ---------------------------------------------------------------- 1. read
const byKey = new Map();
for await (const l of readLines(p(cfg.novel))) {
  let e = byKey.get(l.key);
  if (!e) byKey.set(l.key, (e = {q: {kind: l.kind, context: l.context, allowed: l.allowed, state: l.state}, first: l.client, clients: new Set(), reasons: new Set()}));
  e.clients.add(l.client);
  e.reasons.add(l.reason);
}
const labels = new Map();
for await (const l of readLines(p(`${cfg.novel}.labels.jsonl`))) labels.set(l.key, l);
report.steps.read = {questions: byKey.size, proxyLabels: labels.size};
log(`novel log: ${byKey.size} distinct questions, ${labels.size} already labelled by the proxy`);

// ---------------------------------------------------------------- 2. input gates
// The pairs every simulated town produced, cached (reading every state is slow).
const refCache = p(join('data', 'loop', 'reference-pairs.json'));
let reference;
const cached = existsSync(refCache) ? JSON.parse(readFileSync(refCache, 'utf8')) : null;
if (cached && JSON.stringify(cached.dirs) === JSON.stringify(S.reference ?? [])) reference = new Set(cached.pairs);
else {
  reference = new Set();
  for (const dir of S.reference ?? []) for await (const s of readLines(p(join(dir, 'states.jsonl')))) for (const pr of pairs(s.snapshot)) reference.add(pr);
  writeFileSync(refCache, JSON.stringify({dirs: S.reference ?? [], pairs: [...reference]}));
}
// Keys already trained on, from every training file.
const trained = new Set();
for (const f of S.train) for await (const r of readLines(p(f))) if (r.key) trained.add(r.key);
const verdicts = {invalid: 0, trained: 0, fewClients: 0, deferredClient: 0, deferredUnusual: 0, accepted: 0};
const usual = [], unusual = [];
for (const [key, e] of byKey) {
  if (trained.has(key)) { verdicts.trained++; continue; }
  let question, state;
  try {
    question = validateQuestion({kind: e.q.kind, id: 'n', context: e.q.context, ...(e.q.allowed ? {allowed: e.q.allowed} : {})});
    state = validateState(question.kind, e.q.state);
    if (`${question.kind}|${stateKey(state)}|${JSON.stringify([question.context, question.allowed])}` !== key) throw new Error('key');
  } catch { verdicts.invalid++; continue; }
  if (e.clients.size < cfg.minClients) { verdicts.fewClients++; continue; }
  const unseen = reference.size ? pairs(state).filter((pr) => !reference.has(pr)).length : 0;
  const q = {key, question, state, unseen, client: e.first, reasons: [...e.reasons]};
  (unseen > cfg.maxUnseenPairs && e.clients.size < cfg.quarantineClients ? unusual : usual).push(q);
}
// Per-client cap, in arrival order; unusual states up to their share of the cycle.
const perClient = new Map(), accepted = [];
const take = (q) => {
  const n = perClient.get(q.client) ?? 0;
  if (n >= cfg.maxPerClient) return false;
  perClient.set(q.client, n + 1);
  accepted.push(q);
  return true;
};
for (const q of usual) if (!take(q)) verdicts.deferredClient++;
let unusualLeft = Math.ceil(cfg.maxUnusualShare * (usual.length + unusual.length));
for (const q of unusual) {
  if (unusualLeft <= 0) { verdicts.deferredUnusual++; continue; }
  if (take(q)) unusualLeft--; else verdicts.deferredClient++;
}
verdicts.accepted = accepted.length;
report.steps.inputGates = {...verdicts, referencePairs: reference.size};
log(`input gates: ${JSON.stringify(verdicts)} (reference pairs ${reference.size})`);
save();
if (dry) { log(`--dry: stopping after the input gates (report in ${out})`); process.exit(0); }

// ---------------------------------------------------------------- 3. labels
// With `teacher` set, only that model's answers count (one teacher only).
const goodLabel = (l) => l && l.probabilities && l.model && (!cfg.teacher || l.model === cfg.teacher);
const missing = accepted.filter((a) => !goodLabel(labels.get(a.key)));
if (missing.length) {
  log(`labelling ${missing.length} questions with the teacher at ${cfg.qps} q/s`);
  const config = await loadLocalConfig(p(S.envRoot ?? '.'));
  for (let i = 0; i < missing.length; i += MAX_QUESTIONS_PER_REQUEST) {
    const part = missing.slice(i, i + MAX_QUESTIONS_PER_REQUEST), groups = new Map();
    part.forEach((a, j) => {
      const sk = stateKey(a.state);
      if (!groups.has(sk)) groups.set(sk, {state: a.state, questions: []});
      groups.get(sk).questions.push({...a.question, id: `q${j}`});
    });
    const t0 = Date.now();
    try {
      const {answers, model} = await requestDecisions(config, [...groups.values()]);
      part.forEach((a, j) => { const ans = answers[`q${j}`]; if (ans) labels.set(a.key, {key: a.key, kind: a.question.kind, probabilities: ans.probabilities, model}); });
    } catch (err) { log(`  a labelling request failed: ${err.message}`); }
    const wait = (part.length / cfg.qps) * 1000 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
const labelled = accepted.filter((a) => goodLabel(labels.get(a.key)));
report.steps.labels = {accepted: accepted.length, labelled: labelled.length, droppedWrongTeacher: accepted.length - labelled.length};
log(`labels: ${labelled.length} of ${accepted.length} accepted questions have a teacher label`);
save();
const extraRows = [];
if (extra) for await (const r of readLines(p(extra))) if (r.target && !trained.has(r.key)) extraRows.push(r);
if (extra) log(`extra rows: ${extraRows.length} from ${extra}`);
report.steps.extra = extra ? {file: extra, rows: extraRows.length} : undefined;
if (labelled.length + extraRows.length < cfg.minRows) {
  report.steps.stop = `fewer than ${cfg.minRows} new labelled questions: nothing to learn yet`;
  save();
  log(report.steps.stop);
  process.exit(0);
}

// ---------------------------------------------------------------- 4. train the next version
// Pseudo-seeds from the key put about a fifth of the new rows in the held-out split.
const rows = labelled.map((a) => {
  const options = decisionOptions(a.question.kind, a.question.allowed), l = labels.get(a.key);
  return {key: a.key, kind: a.question.kind, triples: decisionTriples(a.question.kind, a.state, a.question.context), options,
    target: options.map((o) => l.probabilities[o] ?? 0), n: 1, seeds: [hash32(a.key) % 2147483647], aug: false, model: l.model, features: FEATURES_VERSION};
}).concat(extraRows);
const newRows = join(out, 'novel-rows.jsonl');
await writeJsonl(newRows, rows);
const py = S.python ?? join(S.twm, '.venv', 'bin', 'python');
const runDir = join(S.twm, 'results', 'decision_student', 'loop', `v${next}`);
const trainFiles = [...S.train.map(p), newRows];
log(`training v${next}: ${fresh ? `from scratch (${fresh})` : `warm start from ${S.current.run}`} on ${trainFiles.length} files (${rows.length} new rows)`);
const trainArgs = fresh ? fresh.split(/\s+/).filter(Boolean) : ['--init-from', S.current.run, '--epochs', String(cfg.epochs), '--lr', String(cfg.lr)];
await run(py, ['-u', 'scripts/train_decision_student.py', ...trainFiles, ...trainArgs, '--batch-size', '1024', '--out', runDir], {cwd: S.twm});
report.steps.trainArgs = trainArgs;
await run(py, ['-u', 'scripts/train_error_head.py', runDir, '--data', ...trainFiles, '--eval', p(S.realplay)], {cwd: S.twm});
const bundle = join(out, `decisions.v${next}.json`);
await run(py, ['scripts/export_decision_student.py', runDir, bundle, '--data', p(S.realplay), '--fixture', '64', '--version', String(next),
  '--exclude-kinds', cfg.excludeKinds.join(',')], {cwd: S.twm});
report.steps.train = {run: runDir, bundle};
save();

// ---------------------------------------------------------------- 5. model gates
const evalJson = async (runs, data, name) => {
  const file = join(out, `${name}.json`);
  await run(py, ['scripts/eval_decision_student.py', data, '--runs', ...runs, '--questions', p(S.realplayQuestions), '--baseline', p(S.baseline), '--out', file], {cwd: S.twm});
  return JSON.parse(readFileSync(file, 'utf8'));
};
const gate = (name, pass, detail) => { report.gates[name] = {pass, ...detail}; log(`  ${pass ? 'pass' : 'FAIL'}  ${name} ${JSON.stringify(detail)}`); };
log('model gates:');
const rp = await evalJson([S.current.run, runDir], p(S.realplay), 'realplay-eval');
const [oldName, newName] = Object.keys(rp.runs);
const o = rp.runs[oldName], n = rp.runs[newName];
gate('real-play KL', n.kl <= o.kl * (1 + cfg.tolerance), {current: o.kl, next: n.kl});
gate('real-play KL by traffic', n.kl_traffic <= o.kl_traffic * (1 + cfg.tolerance), {current: o.kl_traffic, next: n.kl_traffic});
const worseKinds = Object.entries(n.per_kind).filter(([k, v]) => !cfg.excludeKinds.includes(k) && v.share >= 0.01 && o.per_kind[k]
  && v.kl_traffic > o.per_kind[k].kl_traffic * (1 + cfg.kindTolerance) + 0.002).map(([k, v]) => [k, o.per_kind[k].kl_traffic, v.kl_traffic]);
gate('no busy kind worse', worseKinds.length === 0, {worse: worseKinds});
const busy = (b) => !cfg.excludeKinds.includes(b.kind) && b.share >= 0.01;
const maxBias = (r) => Math.max(0, ...r.bias.filter(busy).map((b) => Math.abs(b.bias)));
gate('largest option bias', maxBias(n) <= Math.max(cfg.maxBias, maxBias(o) + 0.01), {current: maxBias(o), next: maxBias(n)});
// The same bias, in young towns only: the answers of the current and the next
// bundle against the teacher on hamlet and village questions of the real-play set.
const youngBias = (() => {
  const young = [];
  return async (file) => {
    if (!young.length) for await (const r of readLines(p(S.realplay))) {
      const era = r.triples.find((t) => t[0] === 'town' && t[1] === 'era')?.[2];
      if (era === 'hamlet' || era === 'village') young.push(r);
    }
    const st = loadStudent(JSON.parse(readFileSync(file, 'utf8'))), agg = new Map();
    let total = 0;
    for (const r of young) {
      if (cfg.excludeKinds.includes(r.kind) || !st.kinds.has(r.kind)) continue;
      const q = st.fromTriples(r.kind, r.triples, r.options), w = r.n ?? 1;
      total += w;
      const k = agg.get(r.kind) ?? {w: 0, opt: new Map()};
      k.w += w;
      r.options.forEach((o, i) => { const e = k.opt.get(o) ?? [0, 0]; e[0] += w * r.target[i]; e[1] += w * q[i]; k.opt.set(o, e); });
      agg.set(r.kind, k);
    }
    let worst = {bias: 0};
    for (const [kind, k] of agg) {
      if (k.w < 0.01 * total) continue;
      for (const [option, [t, q]] of k.opt) if (Math.abs((q - t) / k.w) > Math.abs(worst.bias)) worst = {kind, option, bias: (q - t) / k.w};
    }
    return worst;
  };
})();
const yo = S.current.bundle ? await youngBias(p(S.current.bundle)) : {bias: 0};
const yn = await youngBias(bundle);
gate('young-town bias', Math.abs(yn.bias) <= Math.max(cfg.maxBias, Math.abs(yo.bias) + 0.01),
  {current: Number(yo.bias.toFixed(4)), currentAt: yo.kind && `${yo.kind}:${yo.option}`, next: Number(yn.bias.toFixed(4)), nextAt: yn.kind && `${yn.kind}:${yn.option}`});
const badTails = n.tails.filter((t) => !cfg.excludeKinds.includes(t.kind) && (t.ratio < cfg.tail[0] || t.ratio > cfg.tail[1]));
gate('rare options', badTails.length === 0, {outside: badTails.map((t) => [t.kind, t.option, Number(t.ratio.toFixed(2))])});
// New rows the next version did not train on (the held-out pseudo-seeds).
const heldFile = join(out, 'novel-held.jsonl');
// The trainer's split_by_seed, exactly: (seed * 2654435761) mod 2^32 below a fifth.
const heldRows = rows.filter((r) => (Math.imul(r.seeds[0], 2654435761) >>> 0) / 2 ** 32 < 0.2);
if (heldRows.length >= 10) {
  await writeJsonl(heldFile, heldRows);
  const nv = await evalJson([S.current.run, runDir], heldFile, 'novel-eval');
  const [a, b] = Object.values(nv.runs);
  gate('held-out new rows', b.kl <= a.kl, {rows: heldRows.length, current: a.kl, next: b.kl});
}
const check = await run('node', ['scripts/distill-check-student.js', bundle], {allowFail: true});
const us = Number((/(\d+) µs with its state cached/.exec(check.text) ?? [])[1]);
gate('JS parity', check.code === 0, {output: check.text.trim().split('\n').at(-1)});
const b = JSON.parse(readFileSync(bundle, 'utf8'));
const kb = (JSON.stringify(b.weights).length + JSON.stringify(b.vocab).length) / 1024;
gate('size and speed', kb <= cfg.maxBundleKB && us <= cfg.maxCachedUs, {kb: Math.round(kb), cachedUs: us});
// Canary towns: the same seeds under the current and the next version, played
// by the simulated player (the complete-town comparison's setting).
const canary = async (name, file) => {
  const dir = join(out, `canary-${name}`);
  const r = await run('node', ['--max-old-space-size=8000', 'scripts/distill-collect.js', dir, '--seeds', String(cfg.canary.seeds), '--start', String(cfg.canary.start),
    '--years', String(cfg.canary.years), '--workers', String(cfg.canary.seeds), '--answer', 'student', '--student', file, '--player', '--no-record'], {allowFail: true});
  const towns = existsSync(join(dir, 'towns.json')) ? JSON.parse(readFileSync(join(dir, 'towns.json'), 'utf8')).towns : [];
  const work = towns.map((t) => { const m = t.shares?.morning ?? {}; const s = Object.values(m).reduce((x, y) => x + y, 0); return s ? 100 * (m.work ?? 0) / s : NaN; });
  // Geometric mean of the final population.
  const pops = towns.map((t) => t.town?.at(-1)?.pop).filter((v) => v > 0);
  const pop = pops.length ? Math.round(Math.exp(pops.reduce((x, v) => x + Math.log(v), 0) / pops.length)) : null;
  return {ok: r.code === 0 && towns.length === cfg.canary.seeds, work: work.reduce((x, y) => x + y, 0) / work.length, pop};
};
const currentBundle = S.current.bundle ? p(S.current.bundle) : null;
const cNew = await canary('next', bundle);
const cOld = currentBundle ? await canary('current', currentBundle) : null;
gate('canary towns', cNew.ok && (!cOld || Math.abs(cNew.work - cOld.work) <= cfg.workShareDelta),
  {finished: cNew.ok, workShareNext: Number(cNew.work.toFixed(1)), workShareCurrent: cOld ? Number(cOld.work.toFixed(1)) : null,
    popNext: cNew.pop, popCurrent: cOld?.pop ?? null});
const passed = Object.values(report.gates).every((g) => g.pass);
report.passed = passed;
save();

// ---------------------------------------------------------------- 6. publish
if (passed && publish) {
  const dir = p(cfg.publishDir);
  mkdirSync(dir, {recursive: true});
  const shipped = {...b, fixture: b.fixture.slice(0, 8)};
  writeFileSync(join(dir, `decisions.v${next}.json`), JSON.stringify(shipped));
  const manifestFile = join(dir, 'manifest.json');
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {latest: null, versions: {}};
  manifest.versions[next] = `decisions.v${next}.json`;
  manifest.latest = next;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  S.current = {run: runDir, version: next, bundle: join(cfg.publishDir, `decisions.v${next}.json`)};
  S.train = [...S.train, newRows.replace(ROOT + '/', '')];
  writeFileSync(statePath, JSON.stringify(S, null, 2) + '\n');
  report.published = true;
  save();
  log(`published v${next}: ${join(cfg.publishDir, `decisions.v${next}.json`)} (${Math.round(statSync(join(dir, `decisions.v${next}.json`)).size / 1024)} KB); manifest latest = ${next}`);
} else {
  log(passed ? `all gates passed; run with --publish to ship v${next}` : `held: v${next} failed a gate (report: ${join(out, 'report.json')})`);
}
