import test from 'node:test';import assert from 'node:assert/strict';
import {AdaptiveRoutinePolicy,SlicedPopulation,normalizeProbabilities,routineWorld,routineFacts,routineState} from '../src/routine-policy.js';
import {createDecisionClient} from '../src/decision-client.js';
import {pool,jsDivergence,disagreement,refinementTargets,planRefinement,blendRefinement,membershipSignature,entropy} from '../src/decision-pool.js';
import {createState,applyRoutineIntents,stepAgents} from '../src/sim/legacy.js';
import {parseDecisionAnswers,validateDecisionRequest} from '../server/system1.js';
const uniform={work:.25,rest:.25,shop:.25,leisure:.25};
const town={phase:'work',food:'ok',wellbeing:'good',taxStep:10};
const ctx={slice:'town',group:10};
// Legacy-state crowd: identical geography, so only the fields a test sets vary.
function crowd(n){const s=createState(),seed=s.people.map(p=>({...p}));s.people=Array.from({length:n},(_,i)=>({...seed[i%seed.length],id:s.nextId++,task:null,routineStep:i%5}));s.policy.growth=false;return s;}
function homogeneous(n){const s=crowd(n),p=s.people[0];for(const person of s.people)Object.assign(person,{x:p.x,z:p.z,home:p.home,energy:80,fullness:80,social:80,wealth:100});return s;}
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
const questionsOf=call=>call.body.groups.flatMap(g=>g.questions);
// Deterministic harness: fake clock, fake timers and a fetch whose replies the test controls.
function harness(options={}){
 const h={t:0,timers:[],calls:[]};
 const timers={setTimeout(fn,ms){const timer={at:h.t+ms,fn};h.timers.push(timer);return timer;},clearTimeout(timer){const i=h.timers.indexOf(timer);if(i>=0)h.timers.splice(i,1);}};
 const fetch=(url,opts)=>new Promise(resolve=>h.calls.push({url,body:JSON.parse(opts.body),resolve,at:h.t}));
 h.client=createDecisionClient({fetch,now:()=>h.t,timers,...options});
 h.advance=async ms=>{const end=h.t+ms;for(;;){h.timers.sort((a,b)=>a.at-b.at);const next=h.timers[0];if(!next||next.at>end)break;h.timers.shift();h.t=next.at;next.fn();await settle();}h.t=end;await settle();};
 h.reply=async(call,{status=200,answer=()=>({kind:'routine',choice:'work',confidence:.25,probabilities:uniform}),latency=0}={})=>{h.t+=latency;const data=status===200?{model:'fixture',answers:Object.fromEntries(questionsOf(call).map(q=>[q.id,answer(q)]))}:{retryAfterMs:250};call.resolve({ok:status===200,status,json:async()=>data,headers:{get:()=>null}});await settle();};
 h.ask=(id,extra={},context=ctx)=>h.client.ask('routine',id,context,{state:town,...extra});
 return h;
}
// A stand-in client for policy tests: records asks, answers on demand.
function fakeClient(room=5000){const asks=[];return {asks,room,stats(){return {room:this.room,state:'idle',mode:'auto'};},ask(kind,id,context,opts){return new Promise(resolve=>asks.push({kind,id,context,opts,resolve}));},reset(){}};}
const answerAll=async(client,answer={kind:'routine',choice:'work',confidence:.25,probabilities:uniform},filter=()=>true)=>{const picked=client.asks.filter(filter);client.asks.splice(0,client.asks.length,...client.asks.filter(a=>!picked.includes(a)));for(const a of picked)a.resolve(typeof answer==='function'?answer(a):answer);await settle();};
const dist=(work,rest,shop,leisure)=>({work,rest,shop,leisure});

// ---------------------------------------------------------------------------
// Pooling
// ---------------------------------------------------------------------------

test('linear pooling: one slice passes through, identical slices are unchanged, never more confident than the most confident slice',()=>{
 const a=dist(.6,.2,.1,.1),b=dist(.1,.7,.1,.1);
 assert.deepEqual(pool([a]),a);for(const [k,v] of Object.entries(pool([a,a,a])))assert.ok(Math.abs(v-a[k])<1e-12);
 const mixed=pool([a,b]);assert.ok(Math.abs(mixed.work-.35)<1e-12&&Math.abs(mixed.rest-.45)<1e-12);
 const weighted=pool([a,b],{weights:[3,1]});assert.ok(Math.abs(weighted.work-(.6*3+.1)/4)<1e-12);
 // Property: max_a p(a|x) <= max_i max_a p_i(a), over random slice sets.
 let seed=7;const rand=()=>(seed=(seed*16807)%2147483647)/2147483647;
 for(let t=0;t<500;t++){const k=1+Math.floor(rand()*5),dists=Array.from({length:k},()=>{const w=[rand(),rand(),rand(),rand()],n=w.reduce((x,y)=>x+y);return dist(...w.map(x=>x/n));});const p=pool(dists,{weights:dists.map(()=>rand()+.01)});assert.ok(Math.max(...Object.values(p))<=Math.max(...dists.flatMap(d=>Object.values(d)))+1e-12);}
 assert.equal(pool([]),null);assert.equal(pool([null,undefined]),null);
 assert.deepEqual(pool({sliceDists:[a,b],weights:[3,1],allowed:['work','rest']}),pool([a,b],{weights:[3,1],allowed:['work','rest']}),'object form is the same call');
});

test('min pooling is conservative per option but can come out sharper after renormalizing; epsilon prevents vetoes',()=>{
 const p=pool([{a:.6,b:.4},{a:.9,b:.1}],{combine:'min'});assert.ok(Math.abs(p.a-.6/.7)<1e-12,'documented: sharper than both inputs');
 const veto=pool([{a:1,b:0},{a:0,b:1}],{combine:'min'});assert.ok(veto.a>0&&veto.b>0,'no single slice can zero an option');
});

test('local terms shift the pooled distribution and masks renormalize over allowed options',()=>{
 const base=pool([dist(.4,.3,.2,.1)]);const hungry=pool([base],{localTerms:{shop:8}});assert.ok(hungry.shop>.6);assert.ok(Math.abs(Object.values(hungry).reduce((x,y)=>x+y)-1)<1e-12);
 const masked=pool([base],{allowed:['rest','leisure']});assert.deepEqual(Object.keys(masked),['rest','leisure']);assert.ok(Math.abs(masked.rest-.75)<1e-12);
 assert.deepEqual(pool([base],{allowed:['shop'],localTerms:{shop:0}}),{shop:1},'all mass masked: the only allowed option');
 const both=pool([base],{localTerms:[{rest:2},{rest:2}],allowed:['work','rest']});assert.ok(Math.abs(both.rest-1.2/1.6)<1e-12,'several terms multiply');
});

test('disagreement is zero for identical slices, positive for conflicting ones, and drives refinement order',()=>{
 const a=dist(.7,.1,.1,.1),b=dist(.1,.7,.1,.1);assert.equal(jsDivergence([a,a,a]),0);assert.ok(jsDivergence([a,b])>.2);assert.ok(jsDivergence([{x:1},{y:1}])-Math.log(2)<1e-12);assert.equal(jsDivergence([a]),0);
 const targets=refinementTargets([
  {signature:'calm',size:500,dists:[a,a]},
  {signature:'small-split',size:40,dists:[a,b]},
  {signature:'big-split',size:400,dists:[a,b]},
  {signature:'tiny',size:2,dists:[a,b]},
 ]);
 assert.deepEqual(targets.map(t=>t.signature),['big-split','small-split','tiny']);assert.equal(targets[0].mode,'intersection');assert.equal(targets[2].mode,'individual','tiny groups are asked individually');
 assert.equal(refinementTargets([{signature:'x',size:50,dists:[a,b]}],{highStakes:true})[0].mode,'individual');assert.equal(refinementTargets([{signature:'x',size:50,dists:[a,b]}],{budget:0}).length,0);
 assert.equal(disagreement([a,b]),jsDivergence([a,b]));assert.deepEqual(planRefinement([{signature:'x',size:9,dists:[a,b]}]),refinementTargets([{signature:'x',size:9,dists:[a,b]}]));
 assert.equal(membershipSignature({wealth:'poor',district:'river',none:null}),'district=river|wealth=poor');
 assert.deepEqual(blendRefinement(a,b),b);const agree=blendRefinement(a,b,'agree');assert.ok(agree.work<a.work&&agree.work>b.work);assert.ok(entropy(a)>0);
});

// ---------------------------------------------------------------------------
// Population slicing and refinement
// ---------------------------------------------------------------------------

const BANDS=['critical','low','normal','high'],WEALTH=['poor','middling','wealthy'];
function synthetic(n,{districts=8}={}){return {people:Array.from({length:n},(_,i)=>({id:i+1,district:`d${i%districts}`,wealth:WEALTH[Math.floor(i/districts)%3],energy:BANDS[Math.floor(i/(districts*3))%4]}))};}
function sliced(client,clock,opts={}){return new SlicedPopulation({client,kind:'routine',now:()=>clock.t,
 dimensions:{district:p=>p.district,wealth:p=>p.wealth,energy:p=>p.energy},
 describe:s=>({world:null,state:s.state??town,people:s.people}),facts:p=>p.facts??{allowed:['work','rest','shop','leisure']},
 sliceContext:(dim,value,members)=>({slice:dim,label:value,group:members.length}),
 intersectionContext:(m,members)=>({slice:'intersection',label:[m.district,m.wealth,m.energy].join(' '),group:members.length}),
 individualContext:p=>({slice:'individual',label:`p${p.id}`}),...opts});}
const analysisOf=(policy,s,t)=>{const a=policy.analyze(s,t);return {a,people:a.persons.map(x=>({id:x.p.id,...policy.distributionFor(x,a,t)}))};};

test('a 2,000-person town needs only the sum of slice counts per sweep, all on one shared state',async()=>{
 const clock={t:0},client=fakeClient(),policy=sliced(client,clock),s=synthetic(2000);
 assert.equal(policy.pump(s,0),1+8+3+4,'baseline + districts + wealth bands + energy bands, not their product (96)');
 assert.ok(client.asks.every(a=>a.opts.tag==='slice'&&a.opts.state===town&&a.kind==='routine'));assert.equal(new Set(client.asks.map(a=>a.id)).size,16);
 assert.equal(policy.stats.slices,16);assert.equal(policy.stats.signatures,96);
 const big=synthetic(20000);const other=sliced(fakeClient(),clock);assert.equal(other.pump(big,0),16,'question count is independent of population');
 await answerAll(client);const before=policy.stats.pooledComputations;clock.t=10;const {people}=analysisOf(policy,s,10);assert.equal(people.length,2000);assert.ok(people.every(p=>p.source==='pool'&&Math.abs(p.dist.work-.25)<1e-12));
 assert.equal(policy.stats.pooledComputations-before,96,'people with identical memberships share one pooled computation');
 assert.equal(policy.pump(s,30),0,'fresh slices are not asked again; nothing disagrees');
});

test('refinement targets the most disagreeing signature first and its answer serves members until a member slice refreshes',async()=>{
 const clock={t:0},client=fakeClient(),policy=sliced(client,clock,{ttlMs:6000}),s=synthetic(960);
 policy.pump(s,0);
 // District d0 works hard, the poor rest: people who are both are torn.
 await answerAll(client,a=>({kind:'routine',choice:'work',confidence:.25,probabilities:a.context.label==='d0'?dist(.85,.05,.05,.05):a.context.label==='poor'?dist(.05,.85,.05,.05):uniform}));
 clock.t=100;const asked=policy.pump(s,100);assert.ok(asked>0);const refine=client.asks.filter(a=>a.opts.tag==='refine');assert.ok(refine.length>0);
 assert.match(refine[0].context.label,/^d0 poor /,'highest disagreement x size first');assert.equal(refine[0].context.slice,'intersection');assert.equal(refine[0].opts.state,town);
 assert.ok(policy.stats.meanDisagreement>0);assert.equal(policy.stats.refinementsAsked,refine.length);
 const target=refine[0],label=target.context.label;await answerAll(client,{kind:'routine',choice:'shop',confidence:.7,probabilities:dist(.1,.1,.7,.1)},a=>a===target);
 clock.t=200;let {people}=analysisOf(policy,s,200);const members=s.people.filter(p=>`${p.district} ${p.wealth} ${p.energy}`===label).map(p=>p.id);
 for(const id of members){const p=people.find(x=>x.id===id);assert.equal(p.source,'refined');assert.ok(Math.abs(p.dist.shop-.7)<1e-12);}
 assert.ok(policy.stats.refinedShare>=0);
 const custom=sliced(fakeClient(),clock,{intersectionState:(m,members,w,st)=>({...st,taxStep:members.length%26})});custom.pump(s,0);await answerAll(custom.client,a=>({kind:'routine',choice:'work',confidence:.25,probabilities:a.context.label==='d0'?dist(.85,.05,.05,.05):a.context.label==='poor'?dist(.05,.85,.05,.05):uniform}));custom.pump(s,100);const r0=custom.client.asks.find(a=>a.opts.tag==='refine');assert.equal(r0.opts.state.taxStep,r0.context.group%26,'refinements can carry an intersection state');
 // District d0 refreshes (its answer ages out and comes back): the refinement is invalid.
 client.asks.length=0;clock.t=20000;policy.nextPumpAt=0;policy.pump(s,20000);const d0=client.asks.find(a=>a.opts.tag==='slice'&&a.context.label==='d0');assert.ok(d0);
 await answerAll(client,{kind:'routine',choice:'work',confidence:.8,probabilities:dist(.8,.1,.05,.05)},a=>a===d0);
 ({people}=analysisOf(policy,s,20001));for(const id of members)assert.notEqual(people.find(x=>x.id===id).source,'refined');
});

test('tiny or high-stakes groups get individual questions with their own allowed options',async()=>{
 const clock={t:0},client=fakeClient(),policy=sliced(client,clock),s={people:[
  {id:1,district:'d0',wealth:'poor',energy:'critical',facts:{allowed:['rest','shop']}},{id:2,district:'d1',wealth:'wealthy',energy:'normal'},
  ...Array.from({length:40},(_,i)=>({id:10+i,district:i%2?'d0':'d1',wealth:i%2?'poor':'wealthy',energy:i%2?'low':'high'}))]};
 policy.pump(s,0);await answerAll(client,a=>({kind:'routine',choice:'work',confidence:.4,probabilities:a.context.label==='d0'?dist(.85,.05,.05,.05):a.context.label==='poor'?dist(.05,.85,.05,.05):uniform}));
 client.asks.length=0;policy.pump(s,100);const solo=client.asks.filter(a=>a.opts.tag==='individual');assert.ok(solo.some(a=>a.context.label==='p1'));
 assert.deepEqual(solo.find(a=>a.context.label==='p1').opts.allowed,['rest','shop']);
 const high=sliced(fakeClient(),clock,{refine:{highStakes:true}});high.pump(s,0);await answerAll(high.client,a=>({kind:'routine',choice:'work',confidence:.4,probabilities:a.context.label==='d0'?dist(.85,.05,.05,.05):uniform}));high.pump(s,100);assert.ok(high.client.asks.every(a=>a.opts.tag!=='refine'),'high stakes: individuals instead of intersections');
 await answerAll(client,{kind:'routine',choice:'shop',confidence:.9,probabilities:{rest:.1,shop:.9}},a=>a.context.label==='p1');const {people}=analysisOf(policy,s,200);const p1=people.find(p=>p.id===1);assert.equal(p1.source,'individual');assert.deepEqual(Object.keys(p1.dist),['rest','shop']);assert.ok(Math.abs(p1.dist.shop-.9)<1e-9);
});

test('routine slices on the legacy town: one sweep serves a 1,000-resident crowd with independent samples',async()=>{
 let t=0;const client=fakeClient(),policy=new AdaptiveRoutinePolicy({client,now:()=>t}),s=homogeneous(1000);
 assert.equal(policy.pump(s,0),7,'baseline + one value in each of six dimensions');assert.deepEqual(client.asks[0].opts.state,routineState(s));
 t=40;await answerAll(client);assert.ok(policy.dirty);const intents=policy.sample(s,41);assert.equal(intents.length,1000);const counts={};for(const i of intents)counts[i.activity]=(counts[i.activity]??0)+1;assert.equal(Object.keys(counts).length,4);for(const n of Object.values(counts))assert.ok(n>150&&n<350);
 assert.ok(intents.every(i=>normalizeProbabilities(i.probabilities)));assert.equal(policy.sample(s,42).length,0,'assigned once per day and source');assert.equal(applyRoutineIntents(s,intents,1),1000);
});

test('routine hard facts: builders sit out, hunger and exhaustion boost options, missing access masks them',async()=>{
 let t=0;const client=fakeClient(),policy=new AdaptiveRoutinePolicy({client,now:()=>t}),s=homogeneous(200);s.people[0].fullness=5;s.people[1].energy=5;s.projects=[{workers:[s.people[2].id]}];
 const w=routineWorld(s);assert.equal(routineFacts(s,s.people[2],w),null);assert.equal(routineFacts(s,s.people[0],w).terms.shop,8);
 policy.pump(s,0);t=40;await answerAll(client);const intents=policy.sample(s,41),byId=new Map(intents.map(i=>[i.personId,i]));
 assert.equal(intents.length,199);assert.ok(!byId.has(s.people[2].id));assert.ok(byId.get(s.people[0].id).probabilities.shop>.7);assert.ok(byId.get(s.people[1].id).probabilities.rest>.7);
 s.buildings=s.buildings.filter(b=>b.type!=='market');s.people.pop();policy.assigned.clear();const later=policy.sample(s,42);assert.ok(later.every(i=>i.activity!=='shop'&&i.probabilities.shop===0));assert.equal(policy.stats.eligible,198);
});

test('state changes, resets, winner-only and mismatched answers never leak into shared distributions',async()=>{
 let t=0;const client=fakeClient(),p=new AdaptiveRoutinePolicy({client,now:()=>t}),s=homogeneous(500);p.pump(s,0);t=40;await answerAll(client);assert.equal(p.sample(s,41).length,500);
 s.day+=1;assert.equal(p.sample(s,42).length,0,'a new phase is a new state: old answers wait for the next sweep');p.nextPumpAt=0;assert.equal(p.pump(s,43),7);
 p.reset();await answerAll(client);assert.equal(p.slices.size,0,'answers that land after reset are ignored');
 for(const answer of [{kind:'routine',choice:'work',confidence:.9},{kind:'household_stay_move',choice:'stay',confidence:1,probabilities:{stay:1}},null]){p.nextPumpAt=0;p.pump(s,100);await answerAll(client,answer);assert.equal(p.sample(s,101).length,0);}
 assert.ok(p.stats.rejected>=21);assert.equal(p.slices.size,0);
});

test('the full pipeline asks every routine slice of a 2,000-resident town in one request with one shared state',async()=>{
 const h=harness(),p=new AdaptiveRoutinePolicy({client:h.client,now:()=>h.t}),s=crowd(2000);s.people.forEach((x,i)=>Object.assign(x,{energy:(i*37)%100,fullness:(i*53)%100,social:(i*71)%100,wealth:(i*13)%300}));
 const asked=p.pump(s,0);assert.ok(asked>5&&asked<60,`${asked} slice questions`);await h.advance(30);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.groups.length,1);assert.deepEqual(h.calls[0].body.groups[0].state,routineState(s));assert.equal(questionsOf(h.calls[0]).length,asked);
 await h.reply(h.calls[0]);assert.equal(p.stats.answered,asked);const intents=p.sample(s,h.t);assert.equal(intents.length,p.stats.eligible);
 p.nextPumpAt=0;assert.equal(p.pump(s,h.t),0,'identical slice answers: nothing to refine');assert.equal(h.client.stats().tags.slice.answered,asked);
});

// ---------------------------------------------------------------------------
// Decision client
// ---------------------------------------------------------------------------

test('client coalesces questions from many callers and groups them by shared state',async()=>{
 const h=harness({flushMs:30,maxQuestions:64,initialConcurrency:3});const answers=[];for(let i=0;i<10;i++)answers.push(h.ask(`a${i}`));await settle();assert.equal(h.calls.length,0,'waits briefly to coalesce');
 await h.advance(29);assert.equal(h.calls.length,0);await h.advance(1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.groups.length,1);assert.deepEqual(h.calls[0].body.groups[0].state,town);assert.equal(questionsOf(h.calls[0]).length,10);assert.equal(h.calls[0].url,'/api/decisions');
 assert.deepEqual(questionsOf(h.calls[0]).map(q=>q.id),[...Array(10).keys()].map(String),'wire ids are request positions');
 await h.reply(h.calls[0]);const resolved=await Promise.all(answers);assert.ok(resolved.every(a=>a.choice==='work'&&a.kind==='routine'&&a.probabilities.rest===.25));
 for(let i=0;i<130;i++)h.ask(`b${i}`);await settle();assert.deepEqual(h.calls.slice(1).map(c=>questionsOf(c).length),[64,64],'full requests go immediately');await h.advance(30);assert.deepEqual(h.calls.slice(1).map(c=>questionsOf(c).length),[64,64,2]);
 for(const c of h.calls.slice(1))await h.reply(c);
 const snap={era:'town',season:'spring',archetype:'mill',food:'ok',coin:'ok',wellbeing:'fair',jobs:'balanced',homes:'scarce',health:'fair',unrest:'calm',faith:'mid',river:'busy',taxStep:2,rules:'',recent:'',bodies:''};
 const other=h.client.ask('resident_routine','r1',{timeOfDay:'morning',district:'riverside'},{state:snap});const reordered=Object.fromEntries(Object.entries(town).reverse());h.ask('r1');h.ask('r2',{state:reordered});h.ask('r3',{state:{...town,phase:'rest'}});await h.advance(30);
 const call=h.calls.at(-1);assert.equal(call.body.groups.length,3,'three distinct states in one request; key order does not split a state');assert.deepEqual(call.body.groups.map(g=>g.questions.length).sort(),[1,1,2]);
 await h.reply(call,{answer:q=>call.body.groups.find(g=>g.questions.includes(q)).state.era?{kind:'resident_routine',choice:'gather',confidence:.8}:{kind:'routine',choice:'rest',confidence:.9}});assert.equal((await other).choice,'gather');
 assert.equal(h.client.stats().states.distinctLastHour,3);assert.ok(h.client.stats().groupsPerRequest>1);
});

test('client respects the per-request question, byte and state-group budgets and halves them after a 413',async()=>{
 const h=harness({maxGroups:2,flushMs:5});for(let g=0;g<3;g++)for(let i=0;i<5;i++)h.ask(`g${g}q${i}`,{state:{...town,taxStep:g}});await h.advance(5);
 assert.equal(h.calls.length,2);assert.deepEqual(h.calls.map(c=>c.body.groups.length),[2,1]);for(const c of h.calls)await h.reply(c);
 const bytes=harness({maxBytes:8192,flushMs:5});for(let i=0;i<200;i++)bytes.ask(`b${i}`,{},{slice:'district',label:'x'.repeat(60),group:5});await bytes.advance(5);assert.ok(bytes.calls.length>=2);assert.ok(bytes.calls.every(c=>JSON.stringify(c.body).length<9000));
 const big=harness({maxQuestions:64,flushMs:5});const asks=[];for(let i=0;i<64;i++)asks.push(big.ask(`z${i}`));await settle();assert.equal(big.calls.length,1);
 await big.reply(big.calls[0],{status:413});assert.equal(big.client.stats().splits,1);assert.equal(big.client.stats().maxQuestions,32);assert.equal(big.client.stats().failures,0,'a 413 is not an outage');
 await big.advance(5);assert.deepEqual(big.calls.slice(1).map(c=>questionsOf(c).length),[32,32],'the same questions are resent in smaller requests');for(const c of big.calls.slice(1))await big.reply(c);assert.ok((await Promise.all(asks)).every(Boolean));
});

test('client keeps several requests in flight up to the concurrency target',async()=>{
 const h=harness({initialConcurrency:3,maxConcurrency:4,maxQuestions:64});for(let i=0;i<64*6;i++)h.ask(`q${i}`);await settle();assert.equal(h.calls.length,3);assert.ok(h.calls.every(c=>questionsOf(c).length===64));
 const s=h.client.stats();assert.equal(s.inFlight,3);assert.equal(s.inFlightQuestions,192);assert.equal(s.queueDepth,192);assert.equal(s.state,'saturated');assert.equal(s.concurrency,3);assert.equal(s.minConcurrency,1);assert.equal(createDecisionClient({fetch:()=>{}}).stats().concurrency,2,'default target starts at 2');
 await h.reply(h.calls[0],{latency:150});assert.equal(h.calls.length,4,'a completion immediately refills the pipeline');assert.equal(h.client.stats().answered,64);
});

test('adaptive concurrency grows while throughput rises and shrinks on busy replies or latency without gain',async()=>{
 // Simulated service: serving n requests at once takes latencyFor(n). Rounds of 512 questions keep demand above the pipeline.
 const run=async(h,latencyFor,rounds)=>{const targets=[];for(let r=0;r<rounds;r++){for(let i=0;i<64*8;i++)h.ask(`r${r}-${i}`);await settle();while(h.calls.some(c=>!c.done)){const flying=h.calls.filter(c=>!c.done);const c=flying[0];c.done=true;await h.reply(c,{latency:latencyFor(flying.length)/flying.length});}targets.push(h.client.stats().concurrency);}return targets;};
 const fast=await run(harness({initialConcurrency:2,minConcurrency:1,maxConcurrency:4,maxQuestions:64}),n=>100+20*n,16);assert.equal(fast.at(-1),4);assert.ok(fast.filter(n=>n===4).length>=10,`fast ${fast}`);
 // Token-bound service: throughput flat, latency proportional to concurrency. Fewer slots win.
 const flat=await run(harness({initialConcurrency:4,minConcurrency:1,maxConcurrency:4,maxQuestions:64}),n=>n*150,16);assert.equal(flat.at(-1),1,`flat ${flat}`);assert.ok(flat.filter(n=>n===1).length>=8,`flat ${flat}`);
 const busy=harness({initialConcurrency:4,maxQuestions:64});for(let i=0;i<64*4;i++)busy.ask(`b${i}`);await settle();await busy.reply(busy.calls[0],{status:429});assert.equal(busy.client.stats().concurrency,3);assert.equal(busy.client.stats().state,'backoff');
 await busy.reply(busy.calls[1],{status:503});assert.equal(busy.client.stats().concurrency,1);await busy.reply(busy.calls[2],{status:503});assert.equal(busy.client.stats().concurrency,1,'never below the minimum');
});

test('client backs off after 429, 503 and timeouts, resolving to null so local fallbacks continue',async()=>{
 const h=harness();const first=h.ask('a');await h.advance(30);await h.reply(h.calls[0],{status:429});assert.equal(await first,null);assert.equal(h.client.stats().room,0,'no new work is solicited during backoff');
 const next=h.ask('b');await h.advance(200);assert.equal(h.calls.length,1,'nothing sent during the 250ms retry window');await h.advance(60);assert.equal(h.calls.length,2);
 await h.reply(h.calls[1],{status:503});assert.equal(await next,null);const s=h.client.stats();assert.equal(s.failures,2);assert.equal(s.consecutiveFailures,2);assert.ok(s.backoffMs>=1900,`exponential backoff, got ${s.backoffMs}`);
 h.ask('c');await h.advance(1900);assert.equal(h.calls.length,2);await h.advance(200);assert.equal(h.calls.length,3);await h.reply(h.calls[2]);assert.equal(h.client.stats().consecutiveFailures,0);assert.equal(h.client.stats().backoffMs,0);
 let calls=0;const timeout=createDecisionClient({fetch:async(url,opts)=>{calls++;await new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason)));},timeoutMs:20,flushMs:1});assert.equal(await timeout.ask('routine','t',ctx,{state:town}),null);assert.equal(calls,1);assert.equal(timeout.stats().state,'backoff');
 const deaf=createDecisionClient({fetch:()=>new Promise(()=>{}),timeoutMs:20,flushMs:1});assert.equal(await deaf.ask('routine','d',ctx,{state:town}),null,'a fetch that ignores the abort signal still times out');assert.equal(deaf.stats().inFlight,0);
});

test('client orders by priority, dedupes identical questions and rejects stale answers',async()=>{
 const h=harness({initialConcurrency:2,minConcurrency:1});h.ask('blocker');h.ask('blocker2',{priority:-1});await h.advance(30);assert.equal(h.calls.length,1);h.ask('blocker3');await h.advance(30);assert.equal(h.calls.length,2);
 h.client.configure({mode:'manual',cap:5});const low=h.ask('low',{priority:1}),high=h.ask('high',{priority:9}),mid=h.ask('mid',{priority:5});await settle();
 await h.reply(h.calls[0]);assert.equal(questionsOf(h.calls[2]).length,2,'manual ceiling leaves room for 2 this second');await h.reply(h.calls[2],{answer:q=>({kind:'routine',choice:q.id==='0'?'rest':'shop',confidence:.9})});assert.equal((await high).choice,'rest');assert.equal((await mid).choice,'shop');
 await h.reply(h.calls[1]);await h.advance(969);assert.equal(h.calls.length,3,'manual ceiling is a rolling second');await h.advance(1);assert.equal(h.calls.length,4);await h.reply(h.calls[3]);assert.equal((await low).choice,'work');
 h.client.configure({mode:'auto'});const a=h.ask('same',{tag:'slice'}),b=h.ask('same',{priority:4,tag:'slice'});await h.advance(30);assert.equal(questionsOf(h.calls[4]).length,1);await h.reply(h.calls[4]);assert.equal(await a,await b);assert.ok(await a);assert.equal(h.client.stats().deduped,1);assert.deepEqual(h.client.stats().tags.slice,{asked:2,answered:2,nulls:0});
 // A newer context or state for the same actor supersedes the queued one ...
 const old=h.ask('mover',{},{...ctx,group:5}),fresh=h.ask('mover',{state:{...town,phase:'rest'}},{...ctx,group:5});assert.equal(await old,null);await h.advance(30);assert.equal(h.calls[5].body.groups[0].state.phase,'rest');await h.reply(h.calls[5]);assert.ok(await fresh);
 // ... and one asked while the old question is in flight makes the old answer stale.
 const flying=h.ask('walker',{},{...ctx,group:5});await h.advance(30);const newer=h.ask('walker',{},{...ctx,group:9});await h.reply(h.calls[6]);assert.equal(await flying,null);await h.advance(30);await h.reply(h.calls[7]);assert.ok(await newer);
 const dropped=h.ask('gone');await h.advance(30);h.client.reset();await h.reply(h.calls[8]);assert.equal(await dropped,null);
 assert.equal(await h.client.ask('raise_taxes','x',{}),null);assert.equal(await h.ask('bad',{},{...ctx,group:0}),null);assert.equal(await h.ask('nostate',{state:undefined}),null);assert.equal(await h.ask('badstate',{state:{...town,phase:'party'}}),null);assert.equal(h.client.stats().invalid,4);
});

test('client stats expose pipeline diagnostics and a bounded backlog',async()=>{
 const h=harness({maxQueue:100,maxQueueAgeMs:500,maxQuestions:64,initialConcurrency:3});const s0=h.client.stats();for(const k of ['state','inFlight','concurrency','batchSize','groupsPerRequest','observedRate','latencyMs','queueDepth','failures','room','capacity','mode','cap','tags','states','splits'])assert.ok(k in s0,k);assert.equal(s0.state,'idle');assert.equal(s0.room,4*64,'before measurement: every slot (3) plus one ready request');
 for(let i=0;i<64*3;i++)h.ask(`x${i}`);await settle();for(const c of h.calls)await h.reply(c,{latency:50});const s=h.client.stats();assert.equal(s.observedRate,192/5);assert.equal(s.batchSize,64);assert.ok(s.latencyMs>0);assert.ok(s.capacity>0);assert.ok(s.room<=4*64);
 const overflow=[];for(let i=0;i<64*3+150;i++)overflow.push(h.ask(`y${i}`,{priority:i<64*3+100?0:1}));await settle();assert.equal(h.client.stats().queueDepth,100);assert.equal(h.client.stats().dropped,50,'higher-priority newcomers evict the lowest-priority backlog');assert.equal(await overflow[200],null);
 await h.advance(501);assert.equal(h.client.stats().queueDepth,0,'questions older than maxQueueAgeMs are dropped');
});

test('probability validation accepts uncertain distributions, rejects invented or malformed mass',()=>{assert.deepEqual(normalizeProbabilities(uniform),uniform);for(const value of [{work:-.1,rest:1.1},{work:.2},{work:NaN,rest:1},{work:1,raise_taxes:0},{},[]])assert.equal(normalizeProbabilities(value),null);const groups=validateDecisionRequest({groups:[{state:town,questions:[{kind:'routine',id:'1',context:ctx}]}]});assert.equal(parseDecisionAnswers({answers:{routine_0:{type:'choice',choice:'work',confidence:.25,probabilities:uniform}}},groups).answers['1'].confidence,.25);});

// ---------------------------------------------------------------------------
// Legacy simulation behaviour that routine advice must respect
// ---------------------------------------------------------------------------

test('renewed, changed and expired AI advice preserve pending trips at accelerated speeds',()=>{
 const s=homogeneous(28),jobs=[],planner={request(state,p,goal,task){task.pending=true;jobs.push({p,task,goal});return true;}};
 const advise=activity=>applyRoutineIntents(s,s.people.map(p=>({personId:p.id,activity,confidence:1})),s.day);
 advise('work');stepAgents(s,.1,planner);const tasks=s.people.map(p=>p.task);assert.equal(jobs.length,28);
 for(let day=2;day<=8;day++){s.day=day;advise(day%2?'rest':'work');stepAgents(s,.8,planner);assert.ok(s.people.every((p,i)=>p.task===tasks[i]));}
 s.day+=4;stepAgents(s,.8,planner);assert.equal(jobs.length,28);for(const {task}of jobs){task.pending=false;task.route=[];}stepAgents(s,12,planner);stepAgents(s,.1,planner);assert.ok(s.people.every((p,i)=>p.task!==tasks[i]));
});
test('AI advice never prevents local critical-needs interruption',()=>{const s=homogeneous(28);applyRoutineIntents(s,s.people.map(p=>({personId:p.id,activity:'work',confidence:1})),1);stepAgents(s,.1);s.people[0].energy=5;stepAgents(s,.1);assert.equal(s.people[0].task.kind,'rest');});
