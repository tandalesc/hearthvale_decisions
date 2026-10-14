import test from 'node:test';import assert from 'node:assert/strict';
import {AdaptiveRoutinePolicy,normalizeProbabilities,residentContext,routineWorld} from '../src/routine-policy.js';
import {crowdFixture} from '../scripts/load-fixture.js';
import {RouteScheduler} from '../src/navigation.js';import {createRoutePlanner} from '../src/route-planner.js';
import {spatialContext,invalidateSpatial} from '../src/spatial.js';
import {applyRoutineIntents,stepAgents,restore,serialize} from '../src/simulation.js';
import {parseAnswers} from '../server/system1.js';
const uniform={work:.25,rest:.25,shop:.25,leisure:.25};
function homogeneous(n){const s=crowdFixture(n),p=s.people[0];for(const person of s.people)Object.assign(person,{x:p.x,z:p.z,home:p.home,energy:80,fullness:80,social:80,wealth:100});return s;}
const response=(b,probabilities=uniform)=>({day:b.day,model:'fixture',intents:b.residents.map(p=>({personId:p.id,activity:'work',confidence:probabilities.work,probabilities}))});
test('probability validation accepts uncertain distributions, rejects invented or malformed mass',()=>{assert.deepEqual(normalizeProbabilities(uniform),uniform);for(const value of [{work:-.1,rest:1.1},{work:.2},{work:NaN,rest:1},{work:1,raise_taxes:0},{},[]])assert.equal(normalizeProbabilities(value),null);const s={day:1,residents:[{id:1}]};assert.equal(parseAnswers({answers:{resident_1:{type:'choice',choice:'work',confidence:.25,probabilities:uniform}}},s).intents[0].confidence,.25);});
test('small villages request individual decisions, large compatible crowds share independent samples',()=>{
 const small=new AdaptiveRoutinePolicy(),s=homogeneous(28);assert.equal(small.groups(s).size,28);
 const policy=new AdaptiveRoutinePolicy(),town=homogeneous(1000),b=policy.prepare(town,0);assert.equal(b.residents.length,1);assert.equal(policy.accept(b,response(b),town,40),1);const intents=policy.sample(town,41);assert.equal(intents.length,1000);const counts={};for(const i of intents)counts[i.activity]=(counts[i.activity]??0)+1;assert.equal(Object.keys(counts).length,4);for(const n of Object.values(counts))assert.ok(n>150&&n<350);assert.equal(policy.stats.questions,1);assert.equal(policy.stats.cacheSamples,999);assert.equal(policy.sample(town,42).length,0);assert.equal(applyRoutineIntents(town,intents,1),1000);
});
test('critical needs and builders bypass model work and cohorts separate constraints and location',()=>{
 const s=homogeneous(200),w=routineWorld(s),p=s.people[0],a=residentContext(s,p,w);p.energy=10;const b=residentContext(s,p,w);assert.notEqual(a.key,b.key);assert.deepEqual(b.allowed,['rest']);p.energy=80;p.x-=40;assert.notEqual(a.key,residentContext(s,p,w).key);s.projects=[{workers:[p.id]}];assert.equal(residentContext(s,p,routineWorld(s)),null);
 const policy=new AdaptiveRoutinePolicy();for(const p of s.people)p.fullness=5;s.projects=[];assert.equal(policy.sample(s,0).length,200);assert.equal(policy.prepare(s,0),null);
});
test('manual ceiling is rolling, adjustable, independent of cohort identity and one-flight',()=>{
 const policy=new AdaptiveRoutinePolicy({maxQuestions:10,utilization:1}),s=homogeneous(100);policy.latencyPerQuestion=1;const keys=[...policy.groups(s).keys()];const b=policy.prepare(s,0);assert.equal(b.residents.length,10);assert.equal(policy.prepare(s,1),null);policy.finish(b,40);assert.equal(policy.prepare(s,999),null);assert.ok(policy.prepare(s,1001));policy.configure({maxQuestions:1});assert.deepEqual([...policy.groups(s).keys()],keys);policy.reset();assert.equal(policy.prepare(s,1002).residents.length,1);
});
test('automatic pacing learns fast and slow throughput without the old 100/s ceiling',()=>{
 const policy=new AdaptiveRoutinePolicy({utilization:.8}),s=homogeneous(100);const sizes=[];let now=0;for(let i=0;i<30;i++){const b=policy.prepare(s,now);assert.ok(b);sizes.push(b.residents.length);policy.finish(b,now+10);assert.equal(policy.prepare(s,now+11),null);now+=13;}assert.equal(Math.max(...sizes),16);assert.ok(policy.stats.capacity>100);const fast=policy.stats.capacity;for(let i=0;i<8;i++){const b=policy.prepare(s,now);policy.finish(b,now+1000);now+=1251;}assert.ok(policy.stats.capacity<fast/4);assert.equal(policy.prepare(s,now,50).residents.length,1);
});
test('busy and failed requests release the slot without poisoning measured capacity',()=>{const p=new AdaptiveRoutinePolicy(),s=homogeneous(28),b=p.prepare(s,0);p.finish(b,40,{busy:true});assert.equal(p.stats.observedRate,0);assert.equal(p.prepare(s,289),null);const next=p.prepare(s,290);assert.ok(next);p.finish(next,300,{failed:true});assert.equal(p.prepare(s,1299),null);assert.ok(p.prepare(s,1300));});
test('high uncertainty refreshes before stable cohorts when spare budget is available',()=>{
 const p=new AdaptiveRoutinePolicy(),s=homogeneous(200);for(let i=100;i<200;i++)s.people[i].x-=40;const groups=[...p.groups(s).values()];for(let i=0;i<2;i++){const g=groups[i];p.cache.set(g.key,{probabilities:i?uniform:{work:1,rest:0,shop:0,leisure:0},at:0,day:1,entropy:i,drift:0,samples:1,uses:0});}p.sample(s,1);const b=p.prepare(s,2500);assert.equal(b.residents.length,1);assert.equal(b.residents[0].key,groups[1].key);
});
test('policy changes, stale replies, disabling and cache bounds cannot leak old cohort choices',()=>{
 const p=new AdaptiveRoutinePolicy({maxCache:2}),s=homogeneous(28),b=p.prepare(s,0);s.policy.tax=15;assert.equal(p.accept(b,response(b),s,40),6);assert.equal(p.sample(s,41).length,0);assert.equal(p.cache.size,2);p.reset();assert.equal(p.accept(b,response(b),s,50),0);const next=p.prepare(s,1000);s.day+=3;assert.equal(p.accept(next,response(next),s,1040),0);
});
test('legacy winner-only replies are never fabricated into shared distributions',()=>{
 const p=new AdaptiveRoutinePolicy(),s=homogeneous(200),b=p.prepare(s,0);p.accept(b,{day:1,intents:[{personId:b.residents[0].id,activity:'work',confidence:.9}]},s,40);assert.equal(p.sample(s,41).length,1);
});
test('newly unavailable activities and dead residents cannot receive cached decisions',()=>{
 const p=new AdaptiveRoutinePolicy(),s=homogeneous(200),b=p.prepare(s,0);p.accept(b,response(b),s,40);s.buildings=s.buildings.filter(b=>b.type!=='market');s.people.pop();const intents=p.sample(s,41);assert.equal(intents.length,0);assert.equal(p.stats.eligible,199);
});
test('cooperative A* is sliced, cached, bounded and safe after topology invalidation',()=>{
 const s=homogeneous(28);let clock=0;const q=new RouteScheduler({clock:()=>clock++,maxPending:1,maxCache:1});let route;assert.ok(q.request(s,{x:-70,z:20},{x:-20,z:30},r=>route=r));assert.equal(q.request(s,{x:-80,z:20},{x:-20,z:30},()=>{}),false);assert.ok(q.tick(2,1)<=1);for(let i=0;i<10000&&q.pending;i++)q.tick(100,32);assert.ok(route?.length);const surface=spatialContext(s);for(let i=1;i<route.length;i++)assert.ok(surface.segmentClear(route[i-1],route[i]));q.request(s,{x:-70,z:20},{x:-20,z:30},()=>{});assert.equal(q.stats.cacheHits,1);invalidateSpatial(s);q.reset(s);assert.equal(q.cache.size,0);
});
test('bounded fallback eventually moves residents and unfinished worker tasks survive save/reload safely',()=>{
 const s=homogeneous(40),planner=createRoutePlanner({worker:false});stepAgents(s,.1,planner);assert.ok(s.people.some(p=>p.task.pending));const saved=restore(serialize(s));assert.ok(saved.people.every(p=>!p.task?.pending));for(let i=0;i<500;i++){planner.tick();stepAgents(s,.1,planner);}assert.ok(s.people.some(p=>p.activity==='Working'||p.activity==='Shopping at the market'));assert.ok(s.people.every(p=>spatialContext(s).walkable(p.x,p.z)));planner.dispose();
});
test('malformed probability replies never downgrade to a trusted shared winner',()=>{const p=new AdaptiveRoutinePolicy(),s=homogeneous(200),b=p.prepare(s,0);for(const intent of [{personId:b.residents[0].id,activity:'work',confidence:.99,probabilities:{work:.3}},{personId:b.residents[0].id,activity:'change_policy',confidence:1,probabilities:uniform}]){assert.equal(p.accept(b,{day:1,intents:[intent]},s,40),0);assert.equal(p.sample(s,41).length,0);}assert.equal(p.accept(b,{day:1,intents:{}},s,40),0);});
test('the server bounds concurrent batches and accepts measured throughput above 100/s',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{Readable}=await import('node:stream'),{system1Plugin}=await import('../server/system1.js');
 const root=await mkdtemp(join(tmpdir(),'hearthvale-budget-')),originalFetch=globalThis.fetch,originalNow=Date.now;let clock=10000,handler,release;
 try{await writeFile(join(root,'local.env'),'API_KEY=budget-unit-secret\n');Date.now=()=>clock;globalThis.fetch=async(url,opts)=>{if(release)await new Promise(resolve=>release(resolve));const questions=JSON.parse(opts.body).questions;return new Response(JSON.stringify({answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'choice',choice:'work',confidence:.25,probabilities:uniform}]))}));};const plugin=system1Plugin();plugin.configResolved({root});await plugin.configureServer({middlewares:{use(fn){handler=fn;}}});
 async function call(n){const req=Readable.from([Buffer.from(JSON.stringify({day:1,happiness:80,food:200,tax:10,residents:Array.from({length:n},(_,i)=>({id:i+1,wealth:100}))}))]);req.url='/api/system1/decisions';req.method='POST';req.headers={'content-type':'application/json',host:'localhost'};const result={};const res={statusCode:200,setHeader(){},end(body){result.status=this.statusCode;result.body=JSON.parse(body);}};await handler(req,res,()=>assert.fail('unexpected middleware fallthrough'));return result;}
 let unblock;release=resolve=>{unblock=resolve;};const pending=call(16);while(!unblock)await new Promise(resolve=>setTimeout(resolve,1));assert.equal((await call(1)).status,429);release=null;unblock();assert.equal((await pending).status,200);for(let i=0;i<10;i++)assert.equal((await call(16)).status,200);assert.equal((await call(1)).status,200);
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow;await rm(root,{recursive:true,force:true});}
});

test('renewed, changed and expired AI advice preserve pending trips at accelerated speeds',()=>{
 const s=homogeneous(28),jobs=[],planner={request(state,p,goal,task){task.pending=true;jobs.push({p,task,goal});return true;}};
 const advise=activity=>applyRoutineIntents(s,s.people.map(p=>({personId:p.id,activity,confidence:1})),s.day);
 advise('work');stepAgents(s,.1,planner);const tasks=s.people.map(p=>p.task);assert.equal(jobs.length,28);
 for(let day=2;day<=8;day++){s.day=day;advise(day%2?'rest':'work');stepAgents(s,.8,planner);assert.ok(s.people.every((p,i)=>p.task===tasks[i]));}
 s.day+=4;stepAgents(s,.8,planner);assert.equal(jobs.length,28);for(const {task}of jobs){task.pending=false;task.route=[];}stepAgents(s,12,planner);stepAgents(s,.1,planner);assert.ok(s.people.every((p,i)=>p.task!==tasks[i]));
});
test('AI advice never prevents local critical-needs interruption',()=>{const s=homogeneous(28);applyRoutineIntents(s,s.people.map(p=>({personId:p.id,activity:'work',confidence:1})),1);stepAgents(s,.1);s.people[0].energy=5;stepAgents(s,.1);assert.equal(s.people[0].task.kind,'rest');});
