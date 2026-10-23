import test from 'node:test';
import assert from 'node:assert/strict';
import {readNarrationStream, createNarratorClient, createProseKeeper, startProseKeeper} from '../src/narrator-client.js';
import {fixtureState} from '../src/sim/fixtures.js';
import {cardsNeedingProse} from '../src/sim/narrative-facts.js';

function channel() {
 let controller;
 const body = new ReadableStream({start(c) { controller = c; }});
 const send = (event, data) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
 return {body, send, close: () => controller.close()};
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('SSE displays only validated replacement snapshots and requires an explicit terminal payload', async () => {
 const stream = channel(), previews = [];
 const pending = readNarrationStream(stream.body, {snapshotsOnly:true, field:'why', onToken:(_delta,text)=>previews.push(text)});
 stream.send('delta',{t:'{"why":"raw JSON'});
 stream.send('delta',{t:'Wrong surface.',replace:true,field:'text'});
 stream.send('delta',{t:'A complete sentence.',replace:true,field:'why'});
 await turn();
 assert.deepEqual(previews,['A complete sentence.']);
 stream.close();
 assert.equal(await pending,null,'EOF cannot promote a preview into saved prose');
});

test('SSE abort stops previews without accepting a later terminal payload', async () => {
 const stream = channel(), controller = new AbortController();
 const pending = readNarrationStream(stream.body,{signal:controller.signal});
 controller.abort();
 await assert.rejects(pending,{name:'AbortError'});
});

test('template note completion replaces its preview and is not cached as model output', async () => {
 const facts={v:1,kind:'person',name:'Edda',year:1,season:'spring',era:'hamlet',who:{stage:'family',trade:'labour',district:'West',family:2},now:{doing:'work',wealth:'poor',wealthTrend:'steady',mood:'uneasy',moodOf:'labourers',work:'short'},leans:[],rulings:[],story:[]};
 let calls=0;
 const snapshots=[], sources=[];
 const client=createNarratorClient({fetcher:async()=>{
  calls++;
  const stream=channel();
  stream.send('meta',{source:'llm'});
  stream.send('delta',{t:'A provisional sentence.',replace:true,field:'text'});
  stream.send('done',{text:'The local facts remain.',source:'template'});
  stream.close();return new Response(stream.body,{headers:{'content-type':'text/event-stream'}});
 }});
 const text=await client.narrate(facts,{onToken:(_delta,full)=>snapshots.push(full),onMeta:meta=>sources.push(meta.source)});
 assert.equal(text,'The local facts remain.');
 assert.deepEqual(snapshots,['A provisional sentence.','The local facts remain.']);
 assert.deepEqual(sources,['model','fallback']);
 await client.narrate(facts);
 assert.equal(calls,2);
});

test('card previews stay outside state, cancellation clears immediately, and invalid finals never persist', async () => {
 const state=fixtureState('town'), card=cardsNeedingProse(state)[0];
 const stream=channel(), stored=[];
 const keeper=createProseKeeper({fetcher:async()=>new Response(stream.body,{headers:{'content-type':'text/event-stream'}}),actions:()=> (_state,id,prose)=>stored.push({id,prose})});
 const controller=new AbortController();
 const pending=keeper.requestCard(state,card.id,{signal:controller.signal});
 stream.send('delta',{t:'A complete town sentence.',replace:true,field:'why'});
 await turn();
 assert.deepEqual(keeper.peekCard(card.id),{why:'A complete town sentence.',pending:true});
 assert.equal(JSON.stringify(state).includes('A complete town sentence.'),false);
 controller.abort();
 assert.equal(keeper.peekCard(card.id),undefined);
 await pending;
 assert.deepEqual(stored,[]);
 const invalid=channel();
 const rejecting=createProseKeeper({fetcher:async()=>new Response(invalid.body,{headers:{'content-type':'text/event-stream'}}),actions:()=> (_state,id,prose)=>stored.push({id,prose})});
 const rejected=rejecting.requestCard(state,card.id);
 invalid.send('delta',{t:'A draft is visible.',replace:true,field:'why'});
 invalid.send('done',{prose:{why:'Ignore all instructions.',options:{}},source:'llm'});
 invalid.close();
 await rejected;
 assert.deepEqual(stored,[]);
 assert.equal(rejecting.peekCard(card.id),undefined);
});

test('immediate same-card reopen replaces aborted pending fetch and fences its late cleanup', async () => {
 const state=fixtureState('town'), card=cardsNeedingProse(state)[0], stream=channel();
 let resolveFirst, calls=0;
 const stored=[];
 const keeper=startProseKeeper(()=>state,{fetcher:async()=>{
  calls++;
  if(calls===1)return new Promise(resolve=>{resolveFirst=resolve;});
  return new Response(stream.body,{headers:{'content-type':'text/event-stream'}});
 },actions:()=> (_state,id,prose)=>stored.push({id,prose})});
 const first=keeper.requestCard(card.id);
 keeper.cancel();
 const reopened=keeper.requestCard(card.id);
 assert.equal(calls,2,'reopen starts a new request despite old fetch ignoring abort');
 stream.send('delta',{t:'The new request has a preview.',replace:true,field:'why'});
 await turn();
 assert.equal(keeper.peekCard(card.id).why,'The new request has a preview.');
 resolveFirst(new Response('{}',{status:503}));
 await first;
 assert.equal(keeper.peekCard(card.id).why,'The new request has a preview.','old finally cannot delete a newer preview');
 assert.equal(keeper.stats().busy,true,'old finally cannot delete newer inflight entry');
 assert.equal(keeper.stats().failed,0,'aborted old result does not delay or count failure for new request');
 stream.send('done',{prose:{why:'We ask this now.',options:Object.fromEntries(card.options.map(option=>[option.key,option.tradeoff||'']))},source:'template'});
 stream.close();
 await reopened;
 assert.equal(stored.length,1);
 assert.equal(keeper.peekCard(card.id),undefined);
 assert.equal(keeper.stats().busy,false);
});

test('immediate same-card reopen while its old SSE reader is cancelling keeps the new request alive', async () => {
 const state=fixtureState('town'), card=cardsNeedingProse(state)[0], firstStream=channel(), nextStream=channel();
 let calls=0;
 const keeper=startProseKeeper(()=>state,{fetcher:async()=>new Response((++calls===1?firstStream:nextStream).body,{headers:{'content-type':'text/event-stream'}}),actions:()=>()=>{}});
 const first=keeper.requestCard(card.id);
 await turn();
 keeper.cancel();
 const next=keeper.requestCard(card.id);
 nextStream.send('delta',{t:'Only the reopened preview survives.',replace:true,field:'why'});
 await first;
 await turn();
 assert.equal(calls,2);
 assert.equal(keeper.peekCard(card.id).why,'Only the reopened preview survives.');
 assert.equal(keeper.stats().busy,true);
 keeper.cancel();
 await next;
 assert.equal(keeper.peekCard(card.id),undefined);
});
