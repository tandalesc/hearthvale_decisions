import test from 'node:test';
import assert from 'node:assert/strict';
import {narrationStream} from '../cloudflare/narration-stream.js';
const decode=new TextDecoder();
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('SSE backpressure delays provider and validated snapshots precede authoritative fallback',async()=>{
 const tasks=[];let started=false,saved;
 const response=narrationStream({request:new Request('https://game.test/api/narrate'),ctx:{waitUntil:p=>tasks.push(p)},run:async({onPreview})=>{started=true;await onPreview({text:'We need grain.',field:'why'});return {prose:{why:'The canonical reason.'},source:'template'};},onComplete:value=>{saved=value;}});
 await tick();assert.equal(started,false,'Provider waits for downstream demand instead of buffering output');
 const reader=response.body.getReader();assert.match(decode.decode((await reader.read()).value),/event: meta/);
 assert.match(decode.decode((await reader.read()).value),/"replace":true/);
 const last=decode.decode((await reader.read()).value);assert.match(last,/event: done/);assert.match(last,/"source":"template"/);
 assert.equal((await reader.read()).done,true);await Promise.all(tasks);assert.equal(saved.source,'template');
});
test('cancelling SSE body aborts pending provider immediately',async()=>{
 const tasks=[];let aborted=false;
 const response=narrationStream({request:new Request('https://game.test/api/narrate'),ctx:{waitUntil:p=>tasks.push(p)},run:({signal})=>new Promise(resolve=>{signal.addEventListener('abort',()=>{aborted=true;resolve({text:'Unused.'});},{once:true});})});
 const reader=response.body.getReader();await reader.read();await tick();await reader.cancel();await Promise.all(tasks);assert.equal(aborted,true);
});
test('provider failure clears drafts through terminal error and never caches incomplete text',async()=>{
 const tasks=[];let saved=false;
 const response=narrationStream({request:new Request('https://game.test/api/narrate'),ctx:{waitUntil:p=>tasks.push(p)},run:async({onPreview})=>{await onPreview({text:'We need grain.',field:'why'});throw new Error('Provider failed');},onComplete:()=>{saved=true;}});
 const text=await response.text();await Promise.all(tasks);assert.match(text,/event: delta/);assert.match(text,/event: error/);assert.doesNotMatch(text,/event: done/);assert.equal(saved,false);
});
test('cached SSE emits final result without invoking provider or cache write',async()=>{
 const tasks=[];const cached={text:'Ada rests.',source:'llm'};
 const response=narrationStream({request:new Request('https://game.test/api/narrate'),ctx:{waitUntil:p=>tasks.push(p)},cached,run:()=>{throw new Error('Unexpected provider');}});
 const text=await response.text();await Promise.all(tasks);assert.match(text,/"source":"cache"/);assert.match(text,/event: done/);assert.doesNotMatch(text,/event: delta/);
});

import {observeNarration} from '../cloudflare/narration-outcome.js';
test('narration outcome logs whitelist categories and never include generated text or facts',async()=>{
 const records=[],original=console.info;console.info=value=>records.push(JSON.parse(value));
 try {
  await observeNarration({run:async({onPreview,onDiagnostic})=>{onDiagnostic({raw:'private raw prose',normalized:'private normalized',checked:{reasons:{why:'name not in facts: PrivateName'}}});await onPreview({text:'Private preview.',field:'why'});return {prose:{why:'Private result.'},source:'template'};}});
  assert.equal(records[0].category,'unsupported_name');assert.equal(records[0].source,'template');assert.ok(records[0].firstPreviewMs>=0);
  assert.deepEqual(Object.keys(records[0]).sort(),['event','source','durationMs','firstPreviewMs','category'].sort());assert.doesNotMatch(JSON.stringify(records),/Private|private/);
  await assert.rejects(observeNarration({run:async()=>{throw new Error('Secret provider response');}}));assert.equal(records[1].category,'provider');assert.doesNotMatch(JSON.stringify(records),/Secret/);
 } finally {console.info=original;}
});
