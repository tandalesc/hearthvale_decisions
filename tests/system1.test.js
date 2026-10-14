import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadLocalConfig,checkConnection,buildQuestions,parseAnswers,requestRoutines,validateRoutineRequest} from '../server/system1.js';
import {createState,applyRoutineIntents,stepAgents} from '../src/simulation.js';
const snapshot={day:1,happiness:78,food:200,tax:10,residents:[{id:35,wealth:110}]};
test('server configuration loads local.env; failed status contains no secret',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hearthvale-config-'));
 try{await writeFile(join(root,'local.env'),'API_KEY=unit-test-secret\n');const config=await loadLocalConfig(root,{});assert.equal(config.key,'unit-test-secret');assert.equal(config.endpoint,'http://rrh-llm-1:4000/v1/decisions');const status=await checkConnection(config,async()=>{throw new Error('unit-test-secret');});assert.equal(status.state,'service-unavailable');assert.ok(!JSON.stringify(status).includes(config.key));}finally{await rm(root,{recursive:true,force:true});}
});
test('configuration permits the supplied local hostname, rejects arbitrary external endpoints',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hearthvale-config-'));
 try{for(const host of ['rrh-llm-1','rrh-llm-1.localdomain','127.0.0.1','localhost'])assert.ok(await loadLocalConfig(root,{RRH_DECISIONS_URL:`http://${host}:4000/v1/decisions`}));for(const endpoint of ['https://example.com/v1/decisions','http://unknown-host:4000/v1/decisions','http://127.0.0.1:4000/other','http://secret@localhost:4000/v1/decisions','http://localhost:4000/v1/decisions?key=secret'])await assert.rejects(()=>loadLocalConfig(root,{RRH_DECISIONS_URL:endpoint}));}finally{await rm(root,{recursive:true,force:true});}
});
test('status authenticates via the observed header without returning it',async()=>{
 let options;const result=await checkConnection({key:'unit-test-secret',endpoint:'http://rrh-llm-1:4000/v1/decisions'},async(url,o)=>{assert.equal(String(url),'http://rrh-llm-1:4000/v1/models');options=o;return new Response('{}');});assert.equal(options.headers['x-litellm-api-key'],'unit-test-secret');assert.equal(result.state,'ready');assert.equal(result.modelConnected,false);assert.ok(!JSON.stringify(result).includes('unit-test-secret'));const failed=await checkConnection({key:'bad',endpoint:'http://rrh-llm-1:4000/v1/decisions'},async()=>new Response('{}',{status:401}));assert.equal(failed.state,'authentication-failed');
});
test('questions use the live-verified dictionary, instructions and criteria contract',()=>{
 const result=buildQuestions(snapshot);assert.ok(!Array.isArray(result.questions));assert.ok(result.questions.resident_35.instructions.includes('never change council decisions'));assert.deepEqual(Object.keys(result.questions.resident_35.criteria),['work','rest','shop','leisure']);assert.throws(()=>validateRoutineRequest({...snapshot,residents:Array(17).fill(snapshot.residents[0])}));assert.throws(()=>validateRoutineRequest({...snapshot,residents:[{id:35,wealth:NaN}]}));
});
test('answer parsing accepts only requested residents, valid activities and confidence',()=>{
 const data={model:'ramblerun/Decision-AI',answers:{resident_35:{type:'choice',choice:'work',confidence:.98},resident_999:{type:'choice',choice:'work',confidence:1}}};assert.deepEqual(parseAnswers(data,snapshot).intents,[{personId:35,activity:'work',confidence:.98}]);for(const answer of [{type:'choice',choice:'raise_taxes',confidence:1},{type:'choice',choice:'rest',confidence:.1},{type:'choice',choice:'work',confidence:4},null])assert.throws(()=>parseAnswers({answers:{resident_35:answer}},snapshot));
});
test('decision requests authenticate server-side and return normalized intents only',async()=>{
 const result=await requestRoutines({key:'unit-test-secret',endpoint:'http://rrh-llm-1:4000/v1/decisions'},snapshot,async(url,opts)=>{assert.equal(opts.method,'POST');assert.equal(opts.headers['x-litellm-api-key'],'unit-test-secret');assert.ok(JSON.parse(opts.body).questions.resident_35);return new Response(JSON.stringify({model:'ramblerun/Decision-AI',answers:{resident_35:{type:'choice',choice:'rest',confidence:.85}},ignored:'private'}));});assert.equal(result.intents[0].activity,'rest');assert.equal(result.ignored,undefined);assert.ok(!JSON.stringify(result).includes('unit-test-secret'));
});
test('timeout and malformed service responses reject for deterministic fallback',async()=>{
 const config={key:'unit-test-secret',endpoint:'http://rrh-llm-1:4000/v1/decisions'};for(const fetcher of [async()=>{throw new Error('timeout');},async()=>new Response('{}',{status:503}),async()=>new Response('not JSON'),async()=>new Response('{"answers":{}}')])await assert.rejects(()=>requestRoutines(config,snapshot,fetcher));
});
test('model routines change activities without changing leadership; stale intents are ignored',()=>{
 const s=createState();const p=s.people[0],before=JSON.stringify({policy:s.policy,decisions:s.decisions,treasury:s.treasury,buildings:s.buildings});assert.equal(applyRoutineIntents(s,[{personId:p.id,activity:'leisure',confidence:.9}],s.day),1);stepAgents(s,.1);assert.equal(p.task.kind,'leisure');assert.equal(JSON.stringify({policy:s.policy,decisions:s.decisions,treasury:s.treasury,buildings:s.buildings}),before);assert.equal(applyRoutineIntents(s,[{personId:p.id,activity:'rest',confidence:.9}],s.day-3),0);s.day=5;const trip=p.task;stepAgents(s,.1);assert.equal(p.task,trip);p.task=null;stepAgents(s,.1);assert.ok(!p.task.revision?.startsWith('ai:'));
});
