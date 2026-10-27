import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionTriples, decisionOptions, FEATURES_VERSION} from '../src/decision-features.js';
import {loadStudent, decodeWeight} from '../src/decision-student.js';
import {KINDS, SNAPSHOTS} from '../src/sim/decisions/kinds.js';

const town = {era: 'town', season: 'spring', archetype: 'mill', food: 'ok', coin: 'ok', wellbeing: 'fair', jobs: 'balanced', homes: 'scarce',
  health: 'fair', unrest: 'calm', faith: 'mid', river: 'busy', taxStep: 2, rules: 'property-tax,tithe 2', recent: 'flood', bodies: 'moot,parish', looks: 'plain'};
const district = {...town, districtName: 'Riverside', character: 'quays', rent: 'mid', roads: 'tracks', crowding: 'snug', nearRiver: 'yes', kin: 'some'};
const walker = {district: 'Riverside', lifeStage: 'young', trade: 'farm', timeOfDay: 'morning', energy: 'low', fullness: 'ok', social: 'high'};

// A schema-valid value for every field, to featurize every kind.
function sample(schema) {
  return Object.fromEntries(Object.entries(schema).map(([name, f]) => [name,
    f.type === 'enum' ? f.values[0] : f.type === 'int' ? f.min : f.type === 'number' ? Math.min(f.max, Math.max(f.min, 0.5)) : 'farm some, craft 2']));
}

test('decision triples: one per field, names dropped, lists split, every kind', () => {
  const t = decisionTriples('resident_routine', district, walker);
  assert.deepEqual(t[0], ['kind', 'kind', 'resident_routine', null]);
  assert.ok(t.some(([s, a, v]) => s === 'town' && a === 'food' && v === 'ok'));
  assert.ok(t.some(([s, a, v]) => s === 'district' && a === 'character' && v === 'quays'));
  assert.ok(t.some(([s, a, v]) => s === 'q' && a === 'energy' && v === 'low'));
  assert.deepEqual(t.filter(([, a]) => a === 'rules'), [['town', 'rules', 'property-tax', null], ['town', 'rules', 'tithe', Math.log1p(2)]]);
  assert.ok(!JSON.stringify(t).includes('Riverside'), 'district names never reach a student');
  // Optional fields left out give no triple.
  assert.ok(!decisionTriples('resident_routine', town, {timeOfDay: 'evening'}).some(([, a]) => a === 'energy' || a === 'character'));
  assert.deepEqual(decisionTriples('resident_routine', district, walker), t, 'deterministic');
  for (const kind of KINDS) {
    const triples = decisionTriples(kind.id, sample(SNAPSHOTS[kind.share] ?? {}), sample(kind.context));
    assert.ok(triples.every(([s, a, v, n]) => typeof s === 'string' && typeof a === 'string' && typeof v === 'string' && (n === null || Number.isFinite(n))), kind.id);
  }
  assert.deepEqual(decisionOptions('household_stay_move', ['emigrate', 'stay']), ['stay', 'emigrate']);
});

// A student with random weights in the trainer's layout (twm/decision/model.py).
function randomBundle(arch, d = 8, heads = 2) {
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.6;
  const f32 = (shape) => ({shape, f32: Buffer.from(Float32Array.from({length: shape.reduce((a, b) => a * b, 1)}, rand).buffer).toString('base64')});
  const index = (list) => Object.fromEntries(['<pad>', '<unk>', ...list].map((t, i) => [t, i]));
  const triples = decisionTriples('resident_routine', district, walker);
  const vocab = {
    scopes: index(['kind', 'town', 'district', 'q']), attrs: index([...new Set(triples.map((t) => t[1]))]),
    values: index([...new Set(triples.map((t) => t[2]))]), kind_options: index(decisionOptions('resident_routine').map((o) => `resident_routine:${o}`)),
    options: index(decisionOptions('resident_routine')), state_scopes: ['town', 'district', 'proposal', 'body'],
  };
  const n = (m) => Object.keys(m).length;
  const w = {};
  for (const [name, m] of [['scope', vocab.scopes], ['attr', vocab.attrs], ['value', vocab.values], ['num_dir', vocab.attrs],
    ['kind_opt', vocab.kind_options], ['opt', vocab.options]]) w[`embed.${name}.weight`] = f32([n(m), d]);
  const norm = (p) => { w[`${p}.weight`] = f32([d]); w[`${p}.bias`] = f32([d]); };
  const lin = (p, o, i) => { w[`${p}.weight`] = f32([o, i]); w[`${p}.bias`] = f32([o]); };
  const mha = (p) => { w[`${p}.in_proj_weight`] = f32([3 * d, d]); w[`${p}.in_proj_bias`] = f32([3 * d]); lin(`${p}.out_proj`, d, d); };
  if (arch === 'set') {
    w.option_flag = f32([d]);
    for (let l = 0; l < 2; l++) {
      const p = `state_encoder.layers.${l}`;
      mha(`${p}.self_attn`); norm(`${p}.norm1`); norm(`${p}.norm2`); lin(`${p}.linear1`, 2 * d, d); lin(`${p}.linear2`, d, 2 * d);
      const q = `question.layers.${l}`;
      mha(`${q}.self_attn`); mha(`${q}.multihead_attn`); norm(`${q}.norm1`); norm(`${q}.norm2`); norm(`${q}.norm3`);
      lin(`${q}.linear1`, 2 * d, d); lin(`${q}.linear2`, d, 2 * d);
    }
    norm('state_norm'); norm('out_norm'); lin('score', 1, d);
  } else {
    norm('mlp.0'); lin('mlp.1', 16, d); lin('mlp.4', 16, 16); lin('mlp.7', d, 16);
  }
  return {format: 'hearthvale-decision-student', version: 1, features: FEATURES_VERSION, kinds: ['resident_routine'],
    config: {arch, d_model: d, n_heads: heads, state_layers: 2, question_layers: 2, d_ff: 2 * d, mlp_hidden: 16}, vocab, weights: w};
}

for (const arch of ['set', 'mlp']) {
  test(`decision student (${arch}): the client's answer shape, offered options only, same question same answer`, () => {
    const student = loadStudent(randomBundle(arch));
    assert.ok(student.kinds.has('resident_routine'));
    const a = student.answer('resident_routine', district, walker);
    assert.deepEqual(Object.keys(a).sort(), ['choice', 'confidence', 'kind', 'model', 'probabilities', 'unknown']);
    assert.equal(a.unknown, 0);
    assert.equal(a.model, 'student:resident_routine@v1');
    const total = Object.values(a.probabilities).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(total - 1) < 1e-6);
    assert.equal(a.confidence, Math.max(...Object.values(a.probabilities)));
    // Asked again (state memory now cached), the answer is identical.
    assert.deepEqual(student.answer('resident_routine', district, walker), a);
    const narrowed = student.answer('resident_routine', district, walker, ['rest', 'work']);
    assert.deepEqual(Object.keys(narrowed.probabilities), ['work', 'rest']);
    // A town snapshot without district fields and unknown values still answer.
    assert.ok(student.answer('resident_routine', {...town, food: 'plenty'}, {timeOfDay: 'evening'}).choice);
    assert.throws(() => loadStudent({...randomBundle(arch), features: FEATURES_VERSION + 1}), /features/);
  });
}

test('local answerer: student kinds answer locally within a per-turn budget; the rest pass through', async () => {
  const {createLocalAnswerer} = await import('../src/decision-local.js');
  const student = loadStudent(randomBundle('mlp'));
  let clock = 0;
  const turns = [];
  const passed = [];
  const client = {ask: (...a) => { passed.push(a[0]); return Promise.resolve(null); }, stats: () => ({state: 'idle'}), configure() {}, reset() {}, flush() {}};
  // Each answer "costs" 1 ms on the fake clock; the budget is 3 ms a turn.
  const realAnswer = student.answer;
  student.answer = (...a) => { clock += 1; return realAnswer(...a); };
  const bus = createLocalAnswerer({client, students: [student], budgetMs: 3, now: () => clock, defer: (fn) => turns.push(fn)});
  const asks = Array.from({length: 7}, (_, i) => bus.ask('resident_routine', `p${i}`, walker, {state: district}));
  await bus.ask('choose_trade', 'x', {}, {state: town});
  assert.deepEqual(passed, [], 'free missing kinds use local rules');
  const settled = new Set();
  asks.forEach((p, i) => p.then(() => settled.add(i)));
  await Promise.resolve();
  assert.equal(settled.size, 3, 'three answers fit the first turn');
  for (let turn = 0; turns.length && turn < 10; turn++) {
    turns.shift()();
    await Promise.resolve();
  }
  assert.equal(settled.size, 7, 'the rest land on later turns');
  const answers = await Promise.all(asks);
  assert.ok(answers.every((a) => a.model === 'student:resident_routine@v1'));
  assert.deepEqual(answers[6], answers[0], 'deferral changes when, not what');
  assert.equal(bus.stats().local.deferred, 4);
});

test('novel-question log: validates, dedupes per client, limits rate, hashes clients', async () => {
  const {createNovelLog} = await import('../server/system1.js');
  const written = [];
  const log = createNovelLog({append: async (text) => written.push(...text.trim().split('\n').map((l) => JSON.parse(l))), salt: 'test', perMinute: 3, now: () => 0});
  const q = {kind: 'resident_routine', context: {timeOfDay: 'evening'}, state: town, reason: 'confidence', expectedKL: 0.09};
  let r = await log.record({questions: [q, q, {...q, reason: 'because'}, {...q, context: {timeOfDay: 'midnight'}}, {...q, kind: 'nope'}]}, '10.0.0.1');
  assert.deepEqual(r.body, {logged: 1, repeats: 1, rejected: 3}, 'bad reason, bad value and unknown kind are rejected');
  r = await log.record({questions: [q]}, '10.0.0.2');
  assert.equal(r.body.logged, 1, 'another client may log the same question');
  assert.notEqual(written[0].client, written[1].client);
  assert.ok(!JSON.stringify(written).includes('10.0.0'), 'addresses are never stored');
  assert.equal(written[0].key, written[1].key);
  const many = ['morning', 'midday', 'evening'].map((t) => ({...q, context: {timeOfDay: t, energy: 'low'}}));
  r = await log.record({questions: many}, '10.0.0.1');
  assert.equal(r.body.logged, 2, 'the per-minute budget holds (3, one already used)');
  assert.equal((await log.record({questions: []}, 'x')).status, 400);
});

test('local answerer reports unfamiliar questions in batches and nothing else', async () => {
  const {createLocalAnswerer} = await import('../src/decision-local.js');
  const student = loadStudent(randomBundle('mlp'));
  const posts = [], timers = [];
  const client = {ask: () => Promise.resolve(null), stats: () => ({}), configure() {}, reset() {}, flush() {}};
  const bus = createLocalAnswerer({client, students: [student], report: {fetcher: async (url, init) => posts.push([url, JSON.parse(init.body)]), timer: (fn) => timers.push(fn)}});
  await bus.ask('resident_routine', 'p1', walker, {state: district});                               // familiar: no report
  await bus.ask('resident_routine', 'p2', walker, {state: {...district, character: 'farms'}});   // 'farms' is unknown to this tiny vocabulary
  await bus.ask('choose_trade', 'c1', {trade: 'farm'}, {state: town});                            // no student for this kind
  await bus.ask('choose_trade', 'c2', {trade: 'farm'}, {state: town});                            // same question again: deduplicated
  assert.equal(bus.stats().local.flagged, 2);
  timers.shift()();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], '/api/decisions/novel');
  assert.deepEqual(posts[0][1].questions.map((q) => q.reason).sort(), ['kind', 'unknown']);
  assert.ok(posts[0][1].questions.every((q) => !('id' in q)), 'no ids leave the game');
});

test('local answerer: unknown values go to the live teacher when it is up, else the student answers', async () => {
  const {createLocalAnswerer} = await import('../src/decision-local.js');
  const student = loadStudent(randomBundle('mlp'));
  let state = 'idle';
  const asked = [];
  const client = {ask: () => Promise.resolve(null), stats: () => ({state}), configure() {}, reset() {}, flush() {}};
  const fetcher = async (url, init) => {
    asked.push(JSON.parse(init.body).groups[0].questions[0].kind);
    assert.equal(init.headers['X-Hearthvale-Live'], '1');
    return {ok: true, status: 200, json: async () => ({answers: {0: {kind: 'resident_routine', choice: 'work', confidence: 1, probabilities: {work: 1}}}})};
  };
  const bus = createLocalAnswerer({client, students: [student], entitlement: {tier: 'paid'}, live: {fetcher}});
  const odd = {...district, character: 'farms'};   // unknown to this tiny vocabulary
  assert.equal((await bus.ask('resident_routine', 'a', walker, {state: odd})).choice, 'work');
  assert.deepEqual(asked, ['resident_routine'], 'the teacher answered it');
  state = 'backoff';
  const a = await bus.ask('resident_routine', 'b', walker, {state: odd});
  assert.equal(a.model, 'student:resident_routine@v1', 'service down: the student answers');
  assert.equal(asked.length, 1);
  assert.equal((await bus.ask('resident_routine', 'c', walker, {state: district})).model, 'student:resident_routine@v1', 'familiar questions stay local');
  assert.equal(bus.stats().local.taught, 1);
});

test('novel teacher labels flagged questions once, keeps only the expected teacher, waits for idle', async () => {
  const {createNovelTeacher} = await import('../server/system1.js');
  const timers = [], out = [];
  let idle = false, model = 'example/Decision-AI', calls = 0;
  const request = async (config, groups) => {
    calls++;
    const answers = {};
    for (const g of groups) for (const q of g.questions) answers[q.id] = {choice: 'work', confidence: 0.6, probabilities: {work: 0.6, rest: 0.4}};
    return {answers, model};
  };
  const t = createNovelTeacher({loadConfig: async () => ({key: 'k'}), appendLabel: async (text) => out.push(...text.trim().split('\n').map((l) => JSON.parse(l))),
    idle: () => idle, request, teacher: 'example/Decision-AI', timer: (fn) => timers.push(fn)});
  const item = (k) => ({key: `k${k}`, kind: 'resident_routine', context: {timeOfDay: 'morning'}, state: town});
  t.enqueue([item(1), item(2), item(1)]);
  await timers.shift()();
  assert.equal(calls, 0, 'busy proxy: no request yet');
  idle = true;
  await timers.shift()();
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.key), ['k1', 'k2']);
  t.enqueue([item(1)]);
  assert.equal(t.stats().queued, 0, 'already labelled keys are not queued again');
  model = 'example/fallback';
  t.enqueue([item(3)]);
  while (timers.length) await timers.shift()();
  assert.equal(out.length, 2, 'an answer from another model is never a label');
  assert.equal(t.stats().dropped, 1);
});

test('student versions: every town opens on the latest version; ?student=N pins one', async () => {
  const {createLocalAnswerer, createStudentVersions} = await import('../src/decision-local.js');
  const bundles = {'v1.json': {...randomBundle('mlp'), version: 1}, 'v2.json': {...randomBundle('mlp'), version: 2}};
  const manifest = {latest: 2, versions: {1: 'v1.json', 2: 'v2.json'}};
  const fetcher = async (url) => {
    const name = url.split('/').pop();
    const body = name === 'manifest.json' ? manifest : bundles[name];
    return {ok: !!body, status: body ? 200 : 404, json: async () => body};
  };
  const client = {ask: () => Promise.resolve(null), stats: () => ({state: 'idle'}), configure() {}, reset() {}, flush() {}};
  const bus = createLocalAnswerer({client});
  const versions = createStudentVersions({answerer: bus, base: 'https://game.test/students/', fetcher});
  assert.equal(await versions.start(), '2');
  const town = {}, save = {governance: {studentVersion: 1}};
  assert.equal(await versions.pin(town), '2');
  assert.equal(town.governance.studentVersion, '2');
  assert.equal(await versions.pin(save), '2', 'a new session refreshes a save to its published student version');
  assert.equal(save.governance.studentVersion, '2', 'and records it');
  const pinned = createStudentVersions({answerer: bus, base: 'https://game.test/students/', pinned: '1', fetcher});
  await pinned.start();
  assert.equal(await pinned.pin({}), '1', '?student=1 holds a town on version 1');
  assert.equal((await bus.ask('resident_routine', 'a', walker, {state: district})).model, 'student:resident_routine@v1');
  const missing = createStudentVersions({answerer: bus, base: 'https://game.test/students/', pinned: '7', fetcher});
  await missing.start();
  assert.equal(await missing.pin({}), '2', 'a pinned version that is not published falls back to the latest');
});

test('live teacher: the least sure 10% go to the teacher, tapering to 50 a second, capped by a token bucket', async () => {
  const {createLocalAnswerer} = await import('../src/decision-local.js');
  let kl = 0, clock = 0, teacherAnswer = {kind: 'resident_routine', choice: 'rest', confidence: 1, probabilities: {rest: 1}, model: 'd1'};
  const student = {kinds: new Set(['resident_routine']), unknownIn: () => 0, thresholds: {threshold_p95: 1},
    quantiles: [[0.5, 0.01], [0.9, 0.05], [0.95, 0.08], [0.99, 0.12]],
    answer: (kind) => ({kind, choice: 'work', confidence: 1, probabilities: {work: 1}, model: 'student', unknown: 0, expectedKL: kl})};
  const asked = [];
  let refuse = false;
  const client = {ask: () => Promise.resolve(null), stats: () => ({state: 'idle'}), configure() {}, reset() {}, flush() {}};
  const fetcher = async () => {
    asked.push(1);
    if (refuse) return {ok: false, status: 429, json: async () => ({retryAfterMs: 5000})};
    return {ok: true, status: 200, json: async () => ({answers: {0: teacherAnswer}})};
  };
  const bus = createLocalAnswerer({client, students: [student], entitlement: {tier: 'paid'}, now: () => clock, budgetMs: Infinity, defer: () => {}, live: {maxRate: 50, fetcher}});
  const ask = (i) => bus.ask('resident_routine', `q${i}`, walker, {state: district});

  kl = 0.06;   // above the 90th-percentile rung (0.05): live at the start
  assert.equal((await ask(1)).model, 'd1');
  kl = 0.03;
  assert.equal((await ask(2)).model, 'student');

  // A thousand questions a second: the share tapers to 50/1000 = 5% (threshold 0.08).
  for (let i = 0; i < 2000; i++) { clock += 1; kl = 0; await ask(100 + i); }
  clock += 1;
  await ask(9999);
  assert.ok(Math.abs(bus.stats().local.liveShare - 0.05) < 0.01, `share ${bus.stats().local.liveShare}`);
  kl = 0.06;
  assert.equal((await ask(3)).model, 'student', 'no longer in the top 5%');
  kl = 0.1;
  assert.equal((await ask(4)).model, 'd1', 'still in the top 5%');

  // The bucket: at most two seconds' worth (100) in a burst, whatever the share.
  kl = 1;
  const before = asked.length;
  const burst = await Promise.all(Array.from({length: 150}, (_, i) => ask(20000 + i)));
  assert.ok(asked.length - before <= 100, `${asked.length - before} live in one burst`);
  assert.ok(burst.some((a) => a.model === 'student'));

  // An empty teacher answer falls back to the student's, not to the local rules.
  clock += 10000;
  teacherAnswer = null;
  assert.equal((await ask(5)).model, 'student');
  assert.ok(bus.stats().local.teacherEmpty >= 1);

  // The shared budget is spent (429): the student answers, and live questions pause for the time given.
  clock += 10000;
  refuse = true;
  assert.equal((await ask(6)).model, 'student');
  const n = asked.length;
  clock += 1000;
  await ask(7);
  assert.equal(asked.length, n, 'paused: nothing sent');
  clock += 5000;
  refuse = false;
  teacherAnswer = {kind: 'resident_routine', choice: 'rest', confidence: 1, probabilities: {rest: 1}, model: 'd1'};
  assert.equal((await ask(8)).model, 'd1', 'resumes after the pause');
});

test('live budget at the proxy is shared by every player', async () => {
  const {createLimits} = await import('../server/system1.js');
  let t = 0;
  const live = createLimits({globalRate: 3, globalBurst: 1, clientRate: 2, now: () => t});
  assert.equal(live.take('a', 1), null);
  assert.equal(live.take('b', 1), null);
  assert.equal(live.take('c', 1), null);
  assert.equal(live.take('d', 1).status, 429, 'the fourth player in the same second waits');
  t += 1000;
  assert.equal(live.take('d', 1), null, 'the budget refills');
  // A roomy shared budget: one player still stops at its own cap (2 a second, 4 seconds of burst).
  const roomy = createLimits({globalRate: 100, clientRate: 2, now: () => t});
  for (let i = 0; i < 8; i++) assert.equal(roomy.take('a', 1), null);
  assert.equal(roomy.take('a', 1).status, 429, 'one player cannot take the whole budget');
  assert.equal(roomy.take('b', 1), null);
});

test('int4 weights decode as the exporter packs them: low nibble first, an fp16 scale per group of a row', () => {
  // 3 x 3 with groups of 2: two scales a row, the second group one value wide, an odd count (padded nibble).
  const q = [[-7, 3, 7], [0, -1, 5], [2, -4, -7]];
  const scales = [[0.5, 0.25], [2, 1.5], [0.125, 3]];   // exact in fp16
  const flat = q.flat(), nib = flat.map((v) => v & 15);
  if (nib.length % 2) nib.push(0);
  const packed = Uint8Array.from({length: nib.length / 2}, (_, i) => nib[2 * i] | (nib[2 * i + 1] << 4));
  const half = (x) => { const f = new Float32Array([x]), u = new Uint32Array(f.buffer)[0];
    return ((u >> 16) & 0x8000) | ((((u >> 23) & 0xff) - 112) << 10) | ((u >> 13) & 0x3ff); };
  const scale16 = new Uint16Array(scales.flat().map(half));
  const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
  const out = decodeWeight({shape: [3, 3], i4: b64(packed), scale16: b64(scale16), group: 2});
  const want = q.flatMap((row, r) => row.map((v, c) => v * scales[r][Math.floor(c / 2)]));
  assert.deepEqual([...out], want);
});

// The bundle players download: the one public/students/manifest.json names latest (review C8).
test('the shipped decision student is the manifest\'s latest, matches its trainer on the embedded fixture, and has the shape the game reads', async () => {
  const {readFileSync, existsSync} = await import('node:fs');
  const {checkBundleParity, bundleKB} = await import('../cloudflare/training/gates.js');
  const dir = new URL('../public/students/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  assert.ok(Number.isInteger(manifest.latest) && manifest.versions[manifest.latest] === `decisions.v${manifest.latest}.json`);
  for (const [v, file] of Object.entries(manifest.versions)) assert.ok(existsSync(new URL(file, dir)), `v${v}: ${file} is shipped`);
  assert.ok(!(manifest.blocked ?? []).includes(manifest.latest), 'the shipped latest is not blocked');
  const bundle = JSON.parse(readFileSync(new URL(manifest.versions[manifest.latest], dir), 'utf8'));
  assert.equal(bundle.format, 'hearthvale-decision-student');
  assert.equal(bundle.version, manifest.latest);
  assert.equal(bundle.features, FEATURES_VERSION);
  // Config and vocabulary as src/decision-student.js reads them.
  assert.equal(bundle.config.arch, 'set');
  for (const k of ['d_model', 'n_heads', 'question_layers', 'd_ff', 'max_triples']) assert.ok(Number.isInteger(bundle.config[k]) && bundle.config[k] > 0, `config.${k}`);
  assert.equal(bundle.config.d_model % bundle.config.n_heads, 0);
  assert.deepEqual(Object.keys(bundle.vocab).sort(), ['attrs', 'kind_options', 'options', 'scopes', 'state_scopes', 'values']);
  for (const k of ['scopes', 'attrs', 'values', 'kind_options', 'options']) assert.deepEqual([bundle.vocab[k]['<pad>'], bundle.vocab[k]['<unk>']], [0, 1], `vocab.${k} reserves pad and unk`);
  assert.deepEqual(bundle.vocab.state_scopes, ['town', 'district', 'proposal', 'body']);
  const known = new Set(KINDS.map((k) => k.id));
  assert.ok(bundle.kinds.includes('strike_resolve'), 'strike_resolve is answered');
  for (const kind of bundle.kinds) {
    assert.ok(known.has(kind), `${kind} is a game kind`);
    for (const o of decisionOptions(kind)) assert.ok(`${kind}:${o}` in bundle.vocab.kind_options, `${kind}:${o} has an option embedding`);
  }
  assert.ok(bundleKB(bundle) <= 450, `${Math.round(bundleKB(bundle))} KB of weights and vocabulary`);
  assert.ok(bundle.confidence?.thresholds?.threshold_p95 > 0, 'the confidence head\'s flag threshold');
  // The trainer's own answers on the embedded fixture, as scripts/distill-check-student.js checks them.
  const student = loadStudent(bundle);
  assert.equal(student.hasConfidence, true);
  const parity = checkBundleParity(student, {minRows: 8});
  assert.ok(parity.pass, `parity: ${JSON.stringify(parity)}`);
  assert.ok(parity.worst < 1e-4 && parity.worstConf < 1e-3);
});

test('student versions: a blocked latest falls back to the highest unblocked version, then to the shipped manifest', async () => {
  const {createLocalAnswerer, createStudentVersions, chooseStudentVersion} = await import('../src/decision-local.js');
  assert.equal(chooseStudentVersion({latest: 3, versions: {1: 'a', 2: 'b', 3: 'c'}, blocked: [3]}), '2');
  assert.equal(chooseStudentVersion({latest: 3, versions: {1: 'a', 2: 'b', 3: 'c'}, blocked: [3, 2]}), '1');
  assert.equal(chooseStudentVersion({latest: 3, versions: {1: 'a', 2: 'b', 3: 'c', 4: 'd'}, blocked: [3]}), '2', 'never a version above latest');
  assert.equal(chooseStudentVersion({latest: 2, versions: {1: 'a', 2: 'b'}, blocked: [1, 2]}), null);
  assert.equal(chooseStudentVersion({latest: 2, versions: {1: 'a', 2: 'b'}}, {pinned: '1', blocked: [1]}), '2', 'a blocked pin is not honoured');
  assert.equal(chooseStudentVersion({latest: 2, versions: {1: 'a', 2: 'b'}}, {pinned: '1'}), '1');
  const bundles = {'v1.json': {...randomBundle('mlp'), version: 1}, 'v2.json': {...randomBundle('mlp'), version: 2}, 'v3.json': {...randomBundle('mlp'), version: 3}};
  const serve = (manifests) => async (url) => {
    const {host, pathname} = new URL(url), name = pathname.split('/').pop();
    const body = name === 'manifest.json' ? manifests[host] : bundles[name];
    return {ok: !!body, status: body ? 200 : 404, json: async () => body};
  };
  const client = {ask: () => Promise.resolve(null), stats: () => ({state: 'idle'}), configure() {}, reset() {}, flush() {}};
  const open = async (manifests, opts = {}) => {
    const bus = createLocalAnswerer({client});
    const versions = createStudentVersions({answerer: bus, base: 'https://hosted.test/students/', fallbackBase: 'https://shipped.test/students/', fetcher: serve(manifests), ...opts});
    return [await versions.start(), bus];
  };
  const shipped = {latest: 2, versions: {1: 'v1.json', 2: 'v2.json'}};
  const [v, bus] = await open({'hosted.test': {latest: 3, versions: {1: 'v1.json', 2: 'v2.json', 3: 'v3.json'}, blocked: [3]}, 'shipped.test': shipped});
  assert.equal(v, '2', 'latest is blocked: the highest unblocked version');
  assert.equal((await bus.ask('resident_routine', 'a', walker, {state: district})).model, 'student:resident_routine@v2');
  assert.equal((await open({'hosted.test': {latest: 3, versions: {3: 'v3.json'}, blocked: [3]}, 'shipped.test': shipped}))[0], '2', 'nothing hosted is left: the shipped manifest');
  assert.equal((await open({'hosted.test': {latest: 3, versions: {2: 'v2.json', 3: 'v3.json'}, blocked: [2, 3]}, 'shipped.test': shipped}))[0], '1', 'the shipped manifest skips what the hosted one blocks');
  assert.equal((await open({'hosted.test': {latest: 2, versions: {1: 'v1.json', 2: 'v2.json'}, blocked: [1, 2]}, 'shipped.test': shipped}))[0], null, 'every version blocked: no student, local rules');
  assert.equal((await open({'hosted.test': {latest: 3, versions: {1: 'v1.json', 2: 'v2.json', 3: 'v3.json'}, blocked: [1]}, 'shipped.test': shipped}, {pinned: '1'}))[0], '3', 'a blocked pin opens on latest');
});
