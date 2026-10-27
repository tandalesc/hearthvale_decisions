import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {LearningCoordinator, LearningContainer, digest, REQUIRED_GATES, validProbabilities, handleLearningRequest} from '../cloudflare/learning.js';
import {loadStudent} from '../src/decision-student.js';
import {KINDS, SNAPSHOTS} from '../src/sim/decisions/kinds.js';
import {FEATURES_VERSION, decisionOptions} from '../src/decision-features.js';
import {safePath} from '../cloudflare/training/runner.js';
function setup(vars = {}) {
  const map = new Map(), objects = new Map();
  const storage = {async get(k) { return structuredClone(map.get(k)); }, async put(k,v) { map.set(k,structuredClone(v)); }, async delete(k) {map.delete(k);}, async list({prefix='',limit=Infinity}={}) {return new Map([...map].filter(([k])=>k.startsWith(prefix)).slice(0,limit));}, async getAlarm() {return map.get('alarm') ?? null;}, async setAlarm(at) {map.set('alarm',at);}, async transaction(fn) {return fn(storage);}};
  const text = body => typeof body === 'string' ? body : new TextDecoder().decode(body);
  const bucket = {async delete(key) {objects.delete(key);}, async put(key,body,options={}) {objects.set(key,{body:typeof body==='string'?body:new Uint8Array(body),...options});},async get(key) {const v=objects.get(key);return v?{body:v.body,async json(){return JSON.parse(text(v.body));}}:null;},async head(key) {return objects.get(key)??null;}};
  let dispatched=0;
  const env={LEARNING_VERIFY_MIN_ROWS:1,LEARNING_ADMIN_SECRET:'admin',INITIAL_STUDENT_MANIFEST:{latest:2,versions:{1:'decisions.v1.json',2:'decisions.v2.json'}},AUTH_SECRET:'salt',DECISIONS_TEACHER_MODEL:'d1',LEARNING_PUBLIC_ORIGIN:'https://example.com',STUDENT_ARTIFACTS:bucket,LEARNING_CONTAINER:{getByName(){return {async startJob(){dispatched++;},async stopJob(){}};}},...vars};
  return {core:new LearningCoordinator({storage},env),storage,bucket,map,objects,get dispatched(){return dispatched;}};
}
function sample(schema) {return Object.fromEntries(Object.entries(schema).filter(([,f])=>!f.optional).map(([k,f])=>[k,f.type==='enum'?f.values[0]:f.type==='int'?f.min:f.type==='number'?f.min:f.type==='tags'?[]:'farm']));}
function question() {const k=KINDS.find(k=>k.id==='strike_resolve');return {kind:k.id,state:sample(SNAPSHOTS[k.share]),context:sample(k.context),reason:'kind',studentVersion:2};}
// Real bundles: the shipped latest, renumbered. The frozen real-play gate set is its own
// fixture, labelled with its own answers, so the current release's KL there is ~0.
const SHIPPED = JSON.parse(readFileSync(new URL(`../public/students/decisions.v${JSON.parse(readFileSync(new URL('../public/students/manifest.json', import.meta.url))).latest}.json`, import.meta.url)));
const realBundle = (version, extra = {}) => ({...structuredClone(SHIPPED), version, ...extra});
const REALPLAY = SHIPPED.fixture.map(r => ({kind: r.kind, triples: r.triples, options: r.options, target: r.probabilities, n: 1}));
async function bootstrap(s, {gzip = false} = {}) {
  await s.bucket.put('bootstrap/current.json', JSON.stringify(realBundle(2)));
  const lines = REALPLAY.map(r => JSON.stringify(r)).join('\n') + '\n';
  await s.bucket.put('bootstrap/realplay.jsonl', gzip ? gzipSync(lines) : lines);
  await s.bucket.put('bootstrap/config.json', JSON.stringify({current:{version:2,run:'checkpoint',bundle:'current.json'},train:['train.jsonl'],realplay:'data/realplay.jsonl',config:{maxBundleKB:450,tolerance:0.03},
    files:[{path:'current.json',key:'bootstrap/current.json'},{path:'data/realplay.jsonl',key:'bootstrap/realplay.jsonl',...(gzip?{encoding:'gzip'}:{})}]}));
}
// A trainer's successful upload for job `id`: a report passing every gate and a real bundle.
const passingGates = () => Object.fromEntries(REQUIRED_GATES.map(g=>[g,{pass:true}]));
async function upload(s, id, bundle, report = {passed:true,gates:passingGates()}) {
  const prefix=`jobs/${id}/outputs/`;
  await s.bucket.put(prefix+'report.json',JSON.stringify(report));
  for(const name of ['model.pt','novel-rows.jsonl'])await s.bucket.put(prefix+name,'data');
  await s.bucket.put(prefix+'bundle.json',JSON.stringify(bundle));
}
const succeeded = () => new Request('https://example.com',{method:'POST',body:JSON.stringify({state:'succeeded'})});
async function publishOnce(s, version) {
  await s.core.ingest({questions:[{...question(),studentVersion:version - 1}],client:`c${version}`});
  const t=await s.core.trigger();assert.ok(t.id,`trigger: ${JSON.stringify(t)}`);
  const job=await s.storage.get('job');await upload(s,t.id,realBundle(job.next));
  const r=await s.core.complete(t.id,succeeded());assert.equal(r.status,200,JSON.stringify(await r.clone().json()));return job.next;
}
test('free reports validate, deduplicate, retain provenance and never dispatch teacher', async()=>{const s=setup();const q=question();assert.deepEqual(await s.core.ingest({questions:[q,q,{...q,reason:'bad'}],client:'a'}),{logged:1,repeats:1,rejected:1});const rows=[...(await s.storage.list({prefix:'q:'})).values()];assert.equal(rows[0].features,FEATURES_VERSION);assert.equal(rows[0].teacher,'d1');assert.equal(rows[0].studentVersion,2);assert.notEqual(rows[0].client,'a');assert.equal(s.dispatched,0);});
test('paid labels arriving before novel report reused only with exact teacher/schema/full distribution',async()=>{const s=setup(),q=question(),options=decisionOptions(q.kind);const probabilities=Object.fromEntries(options.map(o=>[o,1/options.length]));const groups=[{state:q.state,questions:[{...q,id:'a'}]}];assert.equal((await s.core.labels({groups,answers:{a:{probabilities}},model:'wrong'})).stored,0);assert.equal((await s.core.labels({groups,answers:{a:{probabilities}},model:'d1'})).stored,1);await s.core.ingest({questions:[q],client:'a'});assert.ok([...(await s.storage.list({prefix:'q:'})).values()][0].label);});
test('insufficient data and teacher budget skip; concurrent triggers serialize one lease',async()=>{const s=setup({LEARNING_MIN_ROWS:1,LEARNING_DAILY_LABEL_CAP:1});await bootstrap(s);assert.equal((await s.core.trigger()).state,'skipped');await s.core.ingest({questions:[question()],client:'a'});const [a,b]=await Promise.all([s.core.trigger(),s.core.trigger()]);assert.equal(a.id,b.id);assert.equal(s.dispatched,1);assert.equal(await s.storage.get(`budget:${new Date().toISOString().slice(0,10)}`),1);await s.storage.put('job',{...(await s.storage.get('job')),state:'failed'});assert.equal((await s.core.trigger()).reason,'label budget');});
test('failed gates and stale completions preserve release; successful publication monotonically advances once',async()=>{const s=setup({LEARNING_MIN_ROWS:1});await bootstrap(s);await s.core.ingest({questions:[question()],client:'a'});const {id}=await s.core.trigger(),prefix=`jobs/${id}/outputs/`;
 const req=()=>new Request('https://example.com',{method:'POST',body:JSON.stringify({state:'succeeded'})});
 await s.bucket.put(prefix+'report.json',JSON.stringify({passed:false,gates:{}}));assert.equal((await s.core.complete(id,req())).status,422);assert.equal((await s.core.manifest()).latest,2);
 await upload(s,id,realBundle(3));
 assert.equal((await s.core.complete(id,req())).status,200);assert.equal((await s.core.manifest()).latest,3);assert.equal((await s.core.complete(id,req())).status,409);assert.equal((await s.core.manifest()).latest,3);
});
test('expired job alarm fails lease without replacing latest; dispatch is once per container',async()=>{const s=setup();await s.storage.put('job',{id:'expired',state:'running',expires:1});await s.core.alarm();assert.equal((await s.core.status()).job.state,'failed');assert.equal((await s.core.manifest()).latest,2);let starts=0;const c=new LearningContainer({storage:s.storage,container:{running:false,images:{base:'image'},start(config){starts++;assert.equal(config.instance,'standard-4');assert.equal(config.enableInternet,true);}}},{LIQUID_API_KEY:'secret'});await c.startJob({id:'a',token:'b',origin:'https://example.com'});await c.startJob({id:'a',token:'b',origin:'https://example.com'});assert.equal(starts,1);});
test('container smoke: module loads, asset paths bounded, probability validation rejects partial labels',()=>{assert.equal(safePath('corpus/train.jsonl'),'/work/corpus/train.jsonl');assert.throws(()=>safePath('../secret'));assert.throws(()=>safePath('/secret'));assert.equal(validProbabilities({a:1},['a','b']),false);assert.equal(validProbabilities({a:.5,b:.5},['a','b']),true);});

test('new reports preserve earlier job watchdog alarm',async()=>{const s=setup();await s.storage.setAlarm(Date.now()+1000);const before=await s.storage.getAlarm();await s.core.ingest({questions:[question()],client:'a'});assert.equal(await s.storage.getAlarm(),before);});

test('promotion retains deferred reports and persists consumed tombstones',async()=>{const s=setup({LEARNING_MIN_ROWS:1});await bootstrap(s);await s.core.ingest({questions:[question()],client:'a'});const first=[...(await s.storage.list({prefix:'q:'})).values()][0];const deferred={...first,key:first.key+'deferred'};await s.storage.put('q:'+await digest(deferred.key),deferred);const {id}=await s.core.trigger(),prefix=`jobs/${id}/outputs/`;await s.bucket.put(prefix+'report.json',JSON.stringify({passed:true,consumedHashes:[await digest(first.key)],gates:Object.fromEntries(REQUIRED_GATES.map(g=>[g,{pass:true}]))}));await upload(s,id,realBundle(3),{passed:true,consumedHashes:[await digest(first.key)],gates:passingGates()});await s.core.complete(id,new Request('https://example.com',{method:'POST',body:JSON.stringify({state:'succeeded'})}));assert.equal((await s.storage.list({prefix:'q:'})).size,1);assert.equal(await s.storage.get('trained:'+await digest(first.key)),3);assert.equal((await s.core.ingest({questions:[question()],client:'a'})).repeats,1);});

test('bootstrap gzip streams roundtrip, hash compressed bytes, and reject corruption before overwrite',async()=>{
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {packBootstrapAsset,saveTrainingAsset}=await import('../cloudflare/training/assets.js');
  const dir=await mkdtemp(join(tmpdir(),'hearthvale-assets-'));
  try {const source=join(dir,'rows.jsonl'),content='{"kind":"strike_resolve","n":1}\n'.repeat(10000);await writeFile(source,content);
    const packed=await packBootstrapAsset(source,join(dir,'assets'));assert.equal(packed.encoding,'gzip');assert.ok(packed.bytes<content.length/10);
    const bytes=await readFile(join(dir,'assets',packed.sha256));assert.equal(await digest(bytes),packed.sha256);
    const destination=join(dir,'decoded.jsonl');await saveTrainingAsset(new Response(bytes),packed,destination);assert.equal(await readFile(destination,'utf8'),content);
    await assert.rejects(saveTrainingAsset(new Response(bytes),{...packed,sha256:'0'.repeat(64)},destination),/checksum mismatch/);assert.equal(await readFile(destination,'utf8'),content);
    const raw=await packBootstrapAsset(source,join(dir,'assets'),{gzip:false});await saveTrainingAsset(new Response(await readFile(join(dir,'assets',raw.sha256))),raw,join(dir,'raw.jsonl'));assert.equal(await readFile(join(dir,'raw.jsonl'),'utf8'),content);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('population guard holds a candidate despite passing prior model/work-share gates, and accepts stable populations',async()=>{
 const {evaluateCanaryPopulation}=await import('../cloudflare/training/gates.js');
 const seeds=[1001,1002],run=pop=>({ok:true,towns:seeds.map(seed=>({seed,town:[{pop}]}))});
 const bad=evaluateCanaryPopulation(run(464),run(357),seeds);assert.equal(bad.pass,false);assert.ok(bad.ratio<.9);
 assert.equal(evaluateCanaryPopulation(run(464),run(464),seeds).pass,true);
 assert.equal(evaluateCanaryPopulation(run(100),run(90),seeds).pass,true);
 assert.equal(evaluateCanaryPopulation(run(100),run(89),seeds).pass,false);
 const s=setup({LEARNING_MIN_ROWS:1});await bootstrap(s);await s.core.ingest({questions:[question()],client:'a'});const {id}=await s.core.trigger();
 const gates=Object.fromEntries(REQUIRED_GATES.map(name=>[name,{pass:true}]));gates['canary population']=bad;
 await s.bucket.put(`jobs/${id}/outputs/report.json`,JSON.stringify({passed:true,gates}));
 const result=await s.core.complete(id,new Request('https://example.com',{method:'POST',body:JSON.stringify({state:'succeeded'})}));
 assert.equal(result.status,422);assert.equal((await s.core.manifest()).latest,2);
});
test('population guard rejects incomplete, missing, nonpositive, duplicate and mismatched seed measurements',async()=>{
 const {evaluateCanaryPopulation}=await import('../cloudflare/training/gates.js');const seeds=[1,2],valid={ok:true,towns:[{seed:1,town:[{pop:100}]},{seed:2,town:[{pop:100}]}]};
 const invalid=[null,{...valid,ok:false},{...valid,towns:valid.towns.slice(0,1)},{...valid,towns:[valid.towns[0],{seed:2,town:[{pop:0}]}]},{...valid,towns:[valid.towns[0],{seed:2,town:[{pop:NaN}]}]},{...valid,towns:[valid.towns[0],{seed:2,town:[]}]},{...valid,towns:[valid.towns[0],valid.towns[0]]},{...valid,towns:[valid.towns[0],{seed:3,town:[{pop:100}]}]}];
 for(const bad of invalid){assert.equal(evaluateCanaryPopulation(valid,bad,seeds).pass,false);assert.equal(evaluateCanaryPopulation(bad,valid,seeds).pass,false);}
});

test('job labelling batches questions by state, 64 a request, a few in flight, each asked once', async () => {
  const {labelRows} = await import('../cloudflare/training/label.js');
  const row = (i, s, label) => ({key: `k${i}`, kind: 'petition', context: {i}, state: {town: s}, ...(label ? {label} : {})});
  const done = {model: 'd1', features: FEATURES_VERSION, probabilities: {a: 1}};
  const rows = [...Array.from({length: 100}, (_, i) => row(i, 'A')), ...Array.from({length: 40}, (_, i) => row(100 + i, 'B')),
    ...Array.from({length: 10}, (_, i) => row(140 + i, 'C')), ...Array.from({length: 5}, (_, i) => row(150 + i, 'A', done))];
  const asked = [], seen = new Set();
  let inFlight = 0, peak = 0;
  const ask = async (state, questions) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    asked.push({state: state.town, n: questions.length});
    for (const q of questions) { assert.ok(!seen.has(q.context.i), 'asked twice'); seen.add(q.context.i); }
    if (state.town === 'C') throw new Error('provider down');
    return {model: 'd1', answers: Object.fromEntries(questions.map((q) => [q.id, {probabilities: {a: 1}}]))};
  };
  const valid = (r, l) => l?.probabilities?.a === 1;
  const out = await labelRows(rows, {teacher: 'd1', ask, valid, concurrency: 3});
  assert.equal(out.requests, 4);                                   // A: 64 + 36, B: 40, C: 10
  assert.ok(asked.every((a) => a.n <= 64));
  assert.ok(peak <= 3 && peak > 1, `peak ${peak}`);
  assert.equal(seen.size, 150);                                    // the 5 labelled rows are not asked
  assert.equal(out.rows.length, 145);                              // C's request failed: its 10 rows drop
  assert.deepEqual(out.rows.map((r) => r.key), rows.filter((r) => r.state.town !== 'C').map((r) => r.key));
  assert.ok(out.labels.every((l, i) => l.model === 'd1' && (l === done || l.key === out.rows[i].key)));   // earlier labels kept as they were
});

// ---- Rollback and kill switch (review C4)
const admin = (core, path, body, secret = 'admin') => handleLearningRequest(new Request(`https://example.com${path}`, {method: path.endsWith('/manifest') ? 'GET' : 'POST', headers: secret ? {authorization: `Bearer ${secret}`} : {}, ...(body ? {body: JSON.stringify(body)} : {})}),
  {LEARNING_ADMIN_SECRET: 'admin', LEARNING_COORDINATOR: {getByName: () => core}});
test('publish, revert, reload: the previous release comes back atomically, the reverted version is blocked and its number never reused', async () => {
  const s = setup({LEARNING_MIN_ROWS: 1}); await bootstrap(s);
  assert.equal(await publishOnce(s, 3), 3);
  const published = await s.core.manifest();
  assert.equal(published.latest, 3);
  assert.equal((await s.core.status()).previous.latest, 2, 'publication keeps a previous pointer');
  assert.equal((await admin(s.core, '/api/learning/revert', null, null)).status, 401, 'revert is admin-only');
  assert.equal((await admin(s.core, '/api/learning/revert', null, 'wrong')).status, 401);
  assert.equal((await s.core.fetch(new Request('https://example.com/api/learning/revert', {method: 'POST'}))).status, 401, 'the coordinator checks the secret itself');
  const reverted = await admin(s.core, '/api/learning/revert');
  assert.equal(reverted.status, 200);
  assert.deepEqual(await reverted.json(), {state: 'reverted', from: 3, latest: 2, blocked: [3]});
  const manifest = await s.core.manifest();
  assert.equal(manifest.latest, 2);
  assert.deepEqual(manifest.versions, {1: 'decisions.v1.json', 2: 'decisions.v2.json'});
  assert.equal(manifest.artifacts[3], undefined, 'the reverted bundle is no longer served');
  assert.deepEqual(manifest.blocked, [3]);
  assert.equal(await s.storage.get('assets'), undefined, 'the training assets are restored too (here: back to the bootstrap)');
  assert.equal((await admin(s.core, '/api/learning/revert')).status, 409, 'one level: nothing further to revert');
  // Reload: a client session opening on the served manifest gets v2.
  const {createLocalAnswerer, createStudentVersions} = await import('../src/decision-local.js');
  const client = {ask: () => Promise.resolve(null), stats: () => ({state: 'idle'}), configure() {}, reset() {}, flush() {}};
  const fetcher = async (url) => url.endsWith('/manifest') ? admin(s.core, '/api/students/manifest') : {ok: true, status: 200, json: async () => realBundle(Number(/v(\d+)/.exec(url)[1]))};
  const versions = createStudentVersions({answerer: createLocalAnswerer({client}), base: 'https://example.com/students/', manifestURL: 'https://example.com/api/students/manifest', fetcher});
  assert.equal(await versions.start(), '2');
  // The next cycle trains on v2 again but is numbered 4: v3's immutable URL is never reused.
  await s.core.ingest({questions: [{...question(), reason: 'unknown'}], client: 'z'});
  const {id} = await s.core.trigger(), job = await s.storage.get('job');
  assert.deepEqual([job.base, job.next], [2, 4]);
  assert.equal((await (await s.bucket.get(`jobs/${id}/input.json`)).json()).assets.nextVersion, 4, 'the loop is told the version to build');
  await upload(s, id, realBundle(3));
  assert.equal((await s.core.complete(id, succeeded())).status, 422, 'a bundle numbered 3 is refused');
  await upload(s, id, realBundle(4));
  assert.equal((await s.core.complete(id, succeeded())).status, 200);
  const after = await s.core.manifest();
  assert.equal(after.latest, 4);
  assert.deepEqual(after.blocked, [3]);
  assert.equal((await s.storage.get('assets')).nextVersion, undefined, 'the version hint is not carried into the release assets');
  assert.equal((await s.storage.get('assets')).current.version, 4);
});
test('kill switch: blocking a version is admin-only, clients skip it, and training will not build on a blocked latest', async () => {
  const s = setup({LEARNING_MIN_ROWS: 1}); await bootstrap(s);
  await publishOnce(s, 3);
  assert.equal((await admin(s.core, '/api/learning/block', {version: 3}, null)).status, 401);
  assert.equal((await admin(s.core, '/api/learning/block', {version: 9})).status, 400, 'only a published version');
  assert.deepEqual(await (await admin(s.core, '/api/learning/block', {version: 3})).json(), {latest: 3, blocked: [3]});
  const served = await (await admin(s.core, '/api/students/manifest')).json();
  assert.deepEqual([served.latest, served.blocked], [3, [3]]);
  const {chooseStudentVersion} = await import('../src/decision-local.js');
  assert.equal(chooseStudentVersion(served), '2');
  await s.core.ingest({questions: [{...question(), reason: 'unknown'}], client: 'y'});
  assert.match((await s.core.trigger()).reason, /blocked/);
  assert.deepEqual(await (await admin(s.core, '/api/learning/block', {version: 3, blocked: false})).json(), {latest: 3, blocked: []});
  assert.ok((await s.core.trigger()).id, 'unblocked: training resumes');
});

// ---- Independent verification in complete() (review C3)
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
function refixture(bundle) {
  // What a trainer that lies would do: recompute the fixture from its own weights, so parity passes.
  const st = loadStudent(bundle);
  bundle.fixture = bundle.fixture.map(r => ({...r, probabilities: st.fromTriples(r.kind, r.triples, r.options), expected_kl: st.expectedFromTriples(r.kind, r.triples, r.options)}));
  return bundle;
}
async function verdict(bundle, {gzip = false, vars = {}, mutateInput} = {}) {
  const s = setup({LEARNING_MIN_ROWS: 1, ...vars}); await bootstrap(s, {gzip});
  await s.core.ingest({questions: [question()], client: 'a'});
  const {id} = await s.core.trigger();
  if (mutateInput) { const key = `jobs/${id}/input.json`, input = await (await s.bucket.get(key)).json(); mutateInput(input); await s.bucket.put(key, JSON.stringify(input)); }
  await upload(s, id, bundle);
  const r = await s.core.complete(id, succeeded());
  return {status: r.status, body: await r.json(), latest: (await s.core.manifest()).latest};
}
test('the worker re-checks the uploaded bundle itself: parity, size, kinds and real-play KL, whatever the report says', async () => {
  const good = await verdict(realBundle(3), {gzip: true});
  assert.equal(good.status, 200, JSON.stringify(good.body));
  // Weights changed and the fixture recomputed to match: parity passes, real-play KL catches it.
  const tampered = realBundle(3), {decodeWeight} = await import('../src/decision-student.js');
  const w = tampered.weights['embed.opt.weight'], data = decodeWeight(w).map(x => x * 3);
  tampered.weights['embed.opt.weight'] = {shape: w.shape, f32: b64(data)};
  const lying = await verdict(refixture(tampered));
  assert.equal(lying.status, 422);
  assert.equal(lying.body.verification.checks['JS parity'].pass, true);
  assert.equal(lying.body.verification.checks['real-play KL'].pass, false);
  assert.ok(lying.body.verification.checks['real-play KL'].next > lying.body.verification.checks['real-play KL'].current);
  assert.equal(lying.latest, 2);
  // A fixture the weights do not reproduce.
  const drift = realBundle(3); drift.fixture[0] = {...drift.fixture[0], probabilities: drift.fixture[0].probabilities.map((p, i) => i === 0 ? p + 0.01 : p)};
  assert.match((await verdict(drift)).body.verification.reason, /differs/);
  // Too few fixture rows to check anything.
  assert.match((await verdict(realBundle(3, {fixture: SHIPPED.fixture.slice(0, 2)}))).body.verification.reason, /at least 8/);
  // Over the size limit.
  assert.match((await verdict(realBundle(3), {mutateInput: i => { i.assets.config.maxBundleKB = 10; }})).body.verification.reason, /size/);
  // A dropped kind.
  const dropped = realBundle(3, {kinds: SHIPPED.kinds.filter(k => k !== 'strike_resolve'), fixture: SHIPPED.fixture.filter(r => r.kind !== 'strike_resolve')});
  const dv = await verdict(dropped, {vars: {LEARNING_VERIFY_MIN_FIXTURE: 1}});
  assert.equal(dv.status, 422); assert.deepEqual(dv.body.verification.checks.kinds.missing, ['strike_resolve']);
  // No gate set: fail closed.
  assert.match((await verdict(realBundle(3), {mutateInput: i => { i.assets.files = i.assets.files.filter(f => f.path !== 'data/realplay.jsonl'); }})).body.verification.reason, /unavailable/);
  assert.match((await verdict(realBundle(3), {vars: {LEARNING_VERIFY_MIN_ROWS: 200}})).body.verification.reason, /Fewer than 200/);
  // Not a bundle at all.
  assert.match((await verdict({version: 3, features: FEATURES_VERSION})).body.verification.reason, /does not load/);
});

// ---- Gate parity between the loops (review C6, A7)
test('active kind coverage needs every active kind in the bundle and asked in the canary towns', async () => {
  const {evaluateKindCoverage, askedKinds} = await import('../cloudflare/training/gates.js');
  const previousKinds = ['petition', 'enterprise_type_for_site', 'strike_resolve'];
  const all = ['petition', 'strike_resolve'];
  assert.deepEqual(await askedKinds([{kind: 'petition', n: 3}, {kind: 'petition', n: 2}, {kind: 'resident_routine', n: 5, aug: true}, {kind: 'strike_resolve'}]), {petition: 5, strike_resolve: 1});
  assert.equal(evaluateKindCoverage({previousKinds, bundleKinds: all, asked: {petition: 4, strike_resolve: 1}}).pass, true, 'the retired kind is not required');
  // Today's canaries: no strike asked. By default that is reported, not a failure (the loop must not brick).
  const today = evaluateKindCoverage({previousKinds, bundleKinds: all, asked: {petition: 4}});
  assert.equal(today.pass, true);
  assert.deepEqual(today.untested, ['strike_resolve']);
  // Asked but not present fails.
  const dropped = evaluateKindCoverage({previousKinds, bundleKinds: ['strike_resolve'], asked: {petition: 4}});
  assert.equal(dropped.pass, false); assert.deepEqual(dropped.missing, ['petition']);
  assert.equal(evaluateKindCoverage({previousKinds, bundleKinds: ['petition'], asked: {petition: 4}}).pass, true, 'an unasked kind is not checked for presence');
  // coverageRequireKinds: once a canary forces strikes, strike_resolve must be present AND asked.
  const required = evaluateKindCoverage({previousKinds, bundleKinds: all, asked: {petition: 4}, requireKinds: ['strike_resolve']});
  assert.equal(required.pass, false); assert.deepEqual(required.notAsked, ['strike_resolve']);
  assert.deepEqual(evaluateKindCoverage({previousKinds, bundleKinds: ['petition'], asked: {petition: 4, strike_resolve: 1}, requireKinds: ['strike_resolve']}).missing, ['strike_resolve']);
  assert.equal(evaluateKindCoverage({previousKinds, bundleKinds: all, asked: {petition: 4, strike_resolve: 1}, requireKinds: ['strike_resolve']}).pass, true);
  assert.equal(evaluateKindCoverage({previousKinds, bundleKinds: all, asked: null}).pass, false, 'no counts: fail');
  assert.equal(evaluateKindCoverage({previousKinds, bundleKinds: ['strike_resolve'], asked: {petition: 1}, minAsked: 2}).pass, true, 'below minAsked counts as not asked');
  assert.equal(evaluateKindCoverage({previousKinds, bundleKinds: ['strike_resolve'], asked: {petition: 2}, minAsked: 2}).pass, false);
  assert.equal(evaluateKindCoverage({previousKinds: ['petition'], bundleKinds: [], asked: {petition: 3}, excludeKinds: ['petition']}).pass, true, 'kinds left to the hosted model are not required');
});
test('the local and cloud loops run the same gates the coordinator requires; the local loop fails thin held-out sets and exports int4', () => {
  const local = readFileSync(new URL('../scripts/distill-loop.js', import.meta.url), 'utf8'), cloud = readFileSync(new URL('../cloudflare/training/loop.js', import.meta.url), 'utf8');
  const gates = src => new Set([...src.matchAll(/\bgate\('([^']+)'/g)].map(m => m[1]));
  for (const [name, src] of [['scripts/distill-loop.js', local], ['cloudflare/training/loop.js', cloud]]) {
    assert.deepEqual([...gates(src)].sort(), [...REQUIRED_GATES].sort(), `${name} gates`);
    assert.match(src, /'--bits', String\(cfg\.exportBits\)/, `${name} exports with --bits`);
    assert.match(src, /exportBits: 4/, `${name} defaults to int4`);
    assert.match(src, /evaluateKindCoverage\(\{[^}]*asked: cNew\.asked[^}]*requireKinds: cfg\.coverageRequireKinds/, `${name} counts asked kinds`);
    assert.match(src, /coverageRequireKinds: \[\]/, `${name} requires no extra kind by default`);
    assert.match(src, /evaluateCanaryPopulation\(cOld, cNew/, `${name} runs the population guard`);
  }
  assert.match(local, /gate\('held-out new rows', false/, 'thin held-out sets fail locally');
  assert.match(local, /allowNoNovel = args\.includes\('--allow-no-novel'\)/);
});
