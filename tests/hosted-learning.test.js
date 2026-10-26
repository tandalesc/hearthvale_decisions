import test from 'node:test';
import assert from 'node:assert/strict';
import {LearningCoordinator, LearningContainer, digest, REQUIRED_GATES, validProbabilities} from '../cloudflare/learning.js';
import {KINDS, SNAPSHOTS} from '../src/sim/decisions/kinds.js';
import {FEATURES_VERSION, decisionOptions} from '../src/decision-features.js';
import {safePath} from '../cloudflare/training/runner.js';
function setup(vars = {}) {
  const map = new Map(), objects = new Map();
  const storage = {async get(k) { return structuredClone(map.get(k)); }, async put(k,v) { map.set(k,structuredClone(v)); }, async delete(k) {map.delete(k);}, async list({prefix='',limit=Infinity}={}) {return new Map([...map].filter(([k])=>k.startsWith(prefix)).slice(0,limit));}, async getAlarm() {return map.get('alarm') ?? null;}, async setAlarm(at) {map.set('alarm',at);}, async transaction(fn) {return fn(storage);}};
  const bucket = {async delete(key) {objects.delete(key);}, async put(key,body,options={}) {objects.set(key,{body:typeof body==='string'?body:new TextDecoder().decode(body),...options});},async get(key) {const v=objects.get(key);return v?{body:v.body,async json(){return JSON.parse(v.body);}}:null;},async head(key) {return objects.get(key)??null;}};
  let dispatched=0;
  const env={INITIAL_STUDENT_MANIFEST:{latest:2,versions:{1:'decisions.v1.json',2:'decisions.v2.json'}},AUTH_SECRET:'salt',DECISIONS_TEACHER_MODEL:'d1',LEARNING_PUBLIC_ORIGIN:'https://example.com',STUDENT_ARTIFACTS:bucket,LEARNING_CONTAINER:{getByName(){return {async startJob(){dispatched++;},async stopJob(){}};}},...vars};
  return {core:new LearningCoordinator({storage},env),storage,bucket,map,objects,get dispatched(){return dispatched;}};
}
function sample(schema) {return Object.fromEntries(Object.entries(schema).filter(([,f])=>!f.optional).map(([k,f])=>[k,f.type==='enum'?f.values[0]:f.type==='int'?f.min:f.type==='number'?f.min:f.type==='tags'?[]:'farm']));}
function question() {const k=KINDS.find(k=>k.id==='strike_resolve');return {kind:k.id,state:sample(SNAPSHOTS[k.share]),context:sample(k.context),reason:'kind',studentVersion:2};}
async function bootstrap(s) {await s.bucket.put('bootstrap/config.json',JSON.stringify({current:{version:2,run:'checkpoint',bundle:'current.json'},train:['train.jsonl'],files:[]}));}
test('free reports validate, deduplicate, retain provenance and never dispatch teacher', async()=>{const s=setup();const q=question();assert.deepEqual(await s.core.ingest({questions:[q,q,{...q,reason:'bad'}],client:'a'}),{logged:1,repeats:1,rejected:1});const rows=[...(await s.storage.list({prefix:'q:'})).values()];assert.equal(rows[0].features,FEATURES_VERSION);assert.equal(rows[0].teacher,'d1');assert.equal(rows[0].studentVersion,2);assert.notEqual(rows[0].client,'a');assert.equal(s.dispatched,0);});
test('paid labels arriving before novel report reused only with exact teacher/schema/full distribution',async()=>{const s=setup(),q=question(),options=decisionOptions(q.kind);const probabilities=Object.fromEntries(options.map(o=>[o,1/options.length]));const groups=[{state:q.state,questions:[{...q,id:'a'}]}];assert.equal((await s.core.labels({groups,answers:{a:{probabilities}},model:'wrong'})).stored,0);assert.equal((await s.core.labels({groups,answers:{a:{probabilities}},model:'d1'})).stored,1);await s.core.ingest({questions:[q],client:'a'});assert.ok([...(await s.storage.list({prefix:'q:'})).values()][0].label);});
test('insufficient data and teacher budget skip; concurrent triggers serialize one lease',async()=>{const s=setup({LEARNING_MIN_ROWS:1,LEARNING_DAILY_LABEL_CAP:1});await bootstrap(s);assert.equal((await s.core.trigger()).state,'skipped');await s.core.ingest({questions:[question()],client:'a'});const [a,b]=await Promise.all([s.core.trigger(),s.core.trigger()]);assert.equal(a.id,b.id);assert.equal(s.dispatched,1);assert.equal(await s.storage.get(`budget:${new Date().toISOString().slice(0,10)}`),1);await s.storage.put('job',{...(await s.storage.get('job')),state:'failed'});assert.equal((await s.core.trigger()).reason,'label budget');});
test('failed gates and stale completions preserve release; successful publication monotonically advances once',async()=>{const s=setup({LEARNING_MIN_ROWS:1});await bootstrap(s);await s.core.ingest({questions:[question()],client:'a'});const {id}=await s.core.trigger(),prefix=`jobs/${id}/outputs/`;
 const req=()=>new Request('https://example.com',{method:'POST',body:JSON.stringify({state:'succeeded'})});
 await s.bucket.put(prefix+'report.json',JSON.stringify({passed:false,gates:{}}));assert.equal((await s.core.complete(id,req())).status,422);assert.equal((await s.core.manifest()).latest,2);
 await s.bucket.put(prefix+'report.json',JSON.stringify({passed:true,gates:Object.fromEntries(REQUIRED_GATES.map(g=>[g,{pass:true}]))}));
 for(const name of ['model.pt','novel-rows.jsonl'])await s.bucket.put(prefix+name,'data');await s.bucket.put(prefix+'bundle.json',JSON.stringify({version:3,features:FEATURES_VERSION}));
 assert.equal((await s.core.complete(id,req())).status,200);assert.equal((await s.core.manifest()).latest,3);assert.equal((await s.core.complete(id,req())).status,409);assert.equal((await s.core.manifest()).latest,3);
});
test('expired job alarm fails lease without replacing latest; dispatch is once per container',async()=>{const s=setup();await s.storage.put('job',{id:'expired',state:'running',expires:1});await s.core.alarm();assert.equal((await s.core.status()).job.state,'failed');assert.equal((await s.core.manifest()).latest,2);let starts=0;const c=new LearningContainer({storage:s.storage,container:{running:false,images:{base:'image'},start(config){starts++;assert.equal(config.instance,'standard-4');assert.equal(config.enableInternet,true);}}},{LIQUID_API_KEY:'secret'});await c.startJob({id:'a',token:'b',origin:'https://example.com'});await c.startJob({id:'a',token:'b',origin:'https://example.com'});assert.equal(starts,1);});
test('container smoke: module loads, asset paths bounded, probability validation rejects partial labels',()=>{assert.equal(safePath('corpus/train.jsonl'),'/work/corpus/train.jsonl');assert.throws(()=>safePath('../secret'));assert.throws(()=>safePath('/secret'));assert.equal(validProbabilities({a:1},['a','b']),false);assert.equal(validProbabilities({a:.5,b:.5},['a','b']),true);});

test('new reports preserve earlier job watchdog alarm',async()=>{const s=setup();await s.storage.setAlarm(Date.now()+1000);const before=await s.storage.getAlarm();await s.core.ingest({questions:[question()],client:'a'});assert.equal(await s.storage.getAlarm(),before);});

test('promotion retains deferred reports and persists consumed tombstones',async()=>{const s=setup({LEARNING_MIN_ROWS:1});await bootstrap(s);await s.core.ingest({questions:[question()],client:'a'});const first=[...(await s.storage.list({prefix:'q:'})).values()][0];const deferred={...first,key:first.key+'deferred'};await s.storage.put('q:'+await digest(deferred.key),deferred);const {id}=await s.core.trigger(),prefix=`jobs/${id}/outputs/`;await s.bucket.put(prefix+'report.json',JSON.stringify({passed:true,consumedHashes:[await digest(first.key)],gates:Object.fromEntries(REQUIRED_GATES.map(g=>[g,{pass:true}]))}));for(const name of ['model.pt','novel-rows.jsonl'])await s.bucket.put(prefix+name,'data');await s.bucket.put(prefix+'bundle.json',JSON.stringify({version:3,features:FEATURES_VERSION}));await s.core.complete(id,new Request('https://example.com',{method:'POST',body:JSON.stringify({state:'succeeded'})}));assert.equal((await s.storage.list({prefix:'q:'})).size,1);assert.equal(await s.storage.get('trained:'+await digest(first.key)),3);assert.equal((await s.core.ingest({questions:[question()],client:'a'})).repeats,1);});

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
