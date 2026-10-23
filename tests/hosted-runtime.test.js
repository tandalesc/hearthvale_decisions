import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';

// Uses workerd, SQLite and real DO RPC: mocks cannot catch missing runtime exports.
test('hosted Worker, SQLite budgets and learning RPC work in Cloudflare runtime', {timeout: 30000}, async () => {
  const compiled = await build({entryPoints:[fileURLToPath(new URL('../cloudflare/worker.js',import.meta.url))],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-23',
    bindings:{AUTH_SECRET:'runtime-test-secret-not-a-real-key-1234',LEARNING_ADMIN_SECRET:'runtime-admin',DECISIONS_TEACHER_MODEL:'d1'},
    durableObjects:{ACCOUNT_STATE:{className:'AccountState',useSQLite:true},LEARNING_COORDINATOR:{className:'LearningCoordinator',useSQLite:true},LEARNING_CONTAINER:{className:'LearningContainer',useSQLite:true}},
    r2Buckets:['STUDENT_ARTIFACTS'],serviceBindings:{ASSETS:()=>new Response('asset',{status:200})}}));
  try {
    const origin='https://game.test';
    let response=await mf.dispatchFetch(origin+'/api/session');
    assert.equal(response.status,200);
    const account=await response.json(); assert.equal(account.tier,'free');
    const cookie=response.headers.get('set-cookie').split(';')[0];
    const post=(path,body)=>mf.dispatchFetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify(body)});
    assert.equal((await post('/api/decisions',{})).status,402);
    assert.equal((await post('/api/narrate',{})).status,402);
    const q={kind:'strike_resolve',context:{wages:'low',hardship:'some',savings:'thin',mood:'angry'},reason:'kind',schemaVersion:1,studentVersion:2,
      state:{era:'town',season:'spring',archetype:'mill',food:'ok',coin:'ok',wellbeing:'fair',jobs:'balanced',homes:'scarce',health:'fair',unrest:'calm',faith:'mid',river:'busy',taxStep:2,rules:'',recent:'',bodies:'',looks:'plain'}};
    response=await post('/api/decisions/novel',{questions:[q]});
    assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).logged,1);
    response=await post('/api/decisions/novel',{questions:[q]});
    assert.equal(response.status,200);assert.equal((await response.json()).repeats,1);
    response=await mf.dispatchFetch(origin+'/students/manifest.json');
    assert.equal(response.status,200);assert.ok((await response.json()).latest>=2);
    response=await mf.dispatchFetch(origin+'/api/learning/trigger',{method:'POST',headers:{authorization:'Bearer runtime-admin'}});
    assert.equal(response.status,200);assert.equal((await response.json()).state,'skipped');
    assert.equal((await mf.dispatchFetch(origin+'/api/learning/status')).status,401);
    const ns=await mf.getDurableObjectNamespace('ACCOUNT_STATE');
    const stub=ns.get(ns.idFromName('test-budget'));
    const outcomes=await Promise.all(Array.from({length:12},async()=>{
      const result=await stub.fetch('https://state/',{method:'POST',body:JSON.stringify({op:'reserve',period:'test-month',kind:'teacher',amount:1,cap:3})});return result.json();
    }));
    assert.equal(outcomes.filter(Boolean).length,3);
  } finally {await mf.dispose();}
});

// Real workerd constructs every provider Request before the outbound mock sees it.
// Node's fetch accepts redirect:'error'; workerd rejects it before any I/O.
test('provider fetches work in workerd and reject redirects without forwarding credentials', {timeout:30000}, async()=>{
  const compiled=await build({stdin:{resolveDir:fileURLToPath(new URL('..',import.meta.url)),contents:`
    import {stripe} from './cloudflare/billing.js';
    import {hostedDecisions,validateDecisionRequest} from './cloudflare/decision.js';
    import {narrateAnthropic} from './cloudflare/narration.js';
    import {narrationStream} from './cloudflare/narration-stream.js';
    import {readText} from './cloudflare/worker-handler.js';
    export default {async fetch(request,env,ctx) {
      try {
        const path=new URL(request.url).pathname;
        if(path==='/stripe') return Response.json(await stripe(env,'prices/runtime_test',{},'GET'));
        if(path==='/decision') return Response.json(await hostedDecisions(env,validateDecisionRequest({groups:[{state:{phase:'work',food:'ok',wellbeing:'good',taxStep:10},questions:[{kind:'routine',id:'q1',context:{slice:'district',label:'west',group:40,energy:'normal'}}]}]}),readText));
        if(path==='/narration-stream')return narrationStream({request,ctx,run:options=>narrateAnthropic({v:1,kind:'person',name:'Ada',year:1},env,options)});
        return Response.json(await narrateAnthropic({v:1,kind:'person',name:'Ada',year:1},env));
      } catch(error) {return Response.json({error:error.message},{status:502});}
    }};
  `},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
  let redirect=false;const calls=[];
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-23',bindings:{STRIPE_SECRET_KEY:'test-stripe',LIQUID_API_KEY:'test-liquid',ANTHROPIC_API_KEY:'test-anthropic'},outboundService:async request=>{
    const url=new URL(request.url);calls.push(url.hostname);
    assert.ok(['api.stripe.com','api.liquid.ai','api.anthropic.com'].includes(url.hostname),'No redirect target or external service can receive credentials');
    if(redirect) return new Response('Redirect body is deliberately not JSON',{status:302,headers:{location:'https://credential-sink.invalid/'}});
    if(url.hostname==='api.stripe.com'){assert.equal(request.headers.get('authorization'),'Bearer test-stripe');return Response.json({id:'price_runtime',unit_amount:100});}
    if(url.hostname==='api.liquid.ai'){assert.equal(request.headers.get('authorization'),'Bearer test-liquid');assert.equal((await request.json()).model,'d1');return Response.json({answers:{routine_0:{type:'choice',choice:'work',confidence:.9}}});}
    assert.equal(request.headers.get('x-api-key'),'test-anthropic');assert.equal((await request.json()).stream,true);
    return new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ada rests."}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});
  }}));
  try {
    let response=await mf.dispatchFetch('https://game.test/stripe');assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).unit_amount,100);
    response=await mf.dispatchFetch('https://game.test/decision');assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).answers.q1.choice,'work');
    response=await mf.dispatchFetch('https://game.test/narration');assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).text,'Ada rests.');
    response=await mf.dispatchFetch('https://game.test/narration-stream');const streamed=await response.text();assert.match(streamed,/event: delta/);assert.match(streamed,/"t":"Ada rests\.","replace":true,"field":"text"/);assert.match(streamed,/event: done/);
    redirect=true;
    for(const [path,error] of [['stripe','Billing unavailable'],['decision','Decision provider unavailable'],['narration','Narration provider 302']]) {
      response=await mf.dispatchFetch('https://game.test/'+path);assert.equal(response.status,502);assert.equal((await response.json()).error,error);
    }
    assert.deepEqual(calls,['api.stripe.com','api.liquid.ai','api.anthropic.com','api.anthropic.com','api.stripe.com','api.liquid.ai','api.anthropic.com']);
  } finally {await mf.dispose();}
});

test('workerd streams validated SSE snapshots and cancels pending narration on disconnect', {timeout:30000}, async()=>{
 const compiled=await build({stdin:{resolveDir:fileURLToPath(new URL('..',import.meta.url)),contents:`
  import {narrationStream} from './cloudflare/narration-stream.js';
  let cancelled=false;
  export default {fetch(request,env,ctx){
   const path=new URL(request.url).pathname;
   if(path==='/state')return Response.json({cancelled});
   return narrationStream({request,ctx,run:async({signal,onPreview})=>{
    await onPreview({text:'We need grain.',field:'why'});
    if(path==='/cancel')await new Promise(resolve=>{if(signal.aborted){cancelled=true;resolve();}else signal.addEventListener('abort',()=>{cancelled=true;resolve();},{once:true});});
    return {prose:{why:'The canonical reason.'},source:'template'};
   }});
  }};
 `},bundle:true,format:'esm',platform:'browser',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-23'}));
 try {
  let response=await mf.dispatchFetch('https://game.test/stream');assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const text=await response.text();assert.ok(text.indexOf('event: delta')<text.indexOf('event: done'));assert.match(text,/"replace":true/);assert.match(text,/"source":"template"/);
  response=await mf.dispatchFetch('https://game.test/cancel');const reader=response.body.getReader();let preview='';while(!preview.includes('event: delta')){const chunk=await reader.read();assert.equal(chunk.done,false);preview+=new TextDecoder().decode(chunk.value);}await reader.cancel();
  let cancelled=false;
  for(let attempt=0;attempt<200&&!cancelled;attempt++){cancelled=(await (await mf.dispatchFetch('https://game.test/state')).json()).cancelled;if(!cancelled)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(cancelled,true,'A disconnected response must stop a pending provider rather than consuming its full timeout');
 } finally {await mf.dispose();}
});

test('paid narration SSE preserves SQLite caps, cached results and JSON compatibility in workerd', {timeout:30000}, async()=>{
 const {signSession}=await import('../cloudflare/auth.js');
 const secret='runtime-test-secret-not-a-real-key-1234';
 const compiled=await build({entryPoints:[fileURLToPath(new URL('../cloudflare/worker.js',import.meta.url))],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 let providerCalls=0;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-23',bindings:{AUTH_SECRET:secret,ANTHROPIC_API_KEY:'test-anthropic',PAID_NARRATIONS_MONTHLY:'1'},durableObjects:{ACCOUNT_STATE:{className:'AccountState',useSQLite:true}},outboundService:async request=>{
  providerCalls++;assert.equal(new URL(request.url).hostname,'api.anthropic.com');
  return new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ada rests."}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
 }}));
 try {
  const id='d'.repeat(64),ns=await mf.getDurableObjectNamespace('ACCOUNT_STATE');
  await ns.get(ns.idFromName(id)).fetch('https://state/',{method:'POST',body:JSON.stringify({op:'write',key:'billing',value:{active:true,paidThrough:Date.now()+3600000}})});
  const signed=await signSession({AUTH_SECRET:secret},{id,email:'runtime@example.com',expires:Date.now()+3600000});
  const post=(name='Ada',accept='text/event-stream')=>mf.dispatchFetch('https://game.test/api/narrate',{method:'POST',headers:{origin:'https://game.test','content-type':'application/json',cookie:'__Host-hearthvale='+signed,accept},body:JSON.stringify({facts:{v:1,kind:'person',name,year:1}})});
  let response=await post();assert.equal(response.status,200);let body=await response.text();assert.match(body,/event: delta/);assert.match(body,/event: done/);assert.equal(providerCalls,1);
  response=await post();body=await response.text();assert.match(body,/"source":"cache"/);assert.match(body,/event: done/);assert.equal(providerCalls,1);
  response=await post('Ada','application/json');assert.equal(response.status,200);assert.deepEqual(await response.json(),{text:'Ada rests.'});assert.equal(providerCalls,1);
  response=await post('Edda');assert.equal(response.status,429);assert.equal((await response.json()).fallback,true);assert.equal(providerCalls,1);
 }finally{await mf.dispose();}
});

test('email codes authenticate in workerd and SQLite permits only one code/link redemption', {timeout:30000}, async()=>{
  const compiled=await build({stdin:{resolveDir:fileURLToPath(new URL('..',import.meta.url)),contents:`
    import worker from './cloudflare/worker-handler.js';
    export {AccountState} from './cloudflare/account.js';
    let mail;
    export default {async fetch(request,env,ctx) {
      if(new URL(request.url).pathname==='/test-mail')return Response.json(mail);
      return worker.fetch(request,{...env,EMAIL:{send:async value=>{mail=value;}}},ctx);
    }};
  `},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-23',bindings:{AUTH_SECRET:'runtime-auth-secret-not-a-real-key-1234',EMAIL_FROM:'hello@game.test'},durableObjects:{ACCOUNT_STATE:{className:'AccountState',useSQLite:true}}}));
  try {
    const origin='https://game.test';
    const post=(path,body)=>mf.dispatchFetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
    const response=await post('/api/auth/email',{email:'Player@example.test'});assert.equal(response.status,200);
    const {challenge}=await response.json();
    const mail=await (await mf.dispatchFetch(origin+'/test-mail')).json();
    const code=mail.text.match(/sign-in code: (\d{6})/)[1];
    const link=mail.text.match(/https:\/\/\S+/)[0];
    const responses=await Promise.all([post('/api/auth/code',{challenge,code}),post('/api/auth/code',{challenge,code})]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
    const cookie=responses.find(r=>r.status===200).headers.get('set-cookie').split(';')[0];
    const session=await (await mf.dispatchFetch(origin+'/api/session',{headers:{cookie}})).json();
    assert.equal(session.authenticated,true);assert.equal(session.email,'player@example.test');
    assert.equal((await mf.dispatchFetch(link)).status,400);
    assert.equal((await mf.dispatchFetch(origin+'/api/session')).status,200);
    assert.equal((await (await mf.dispatchFetch(origin+'/api/session')).json()).authenticated,false);
  } finally {await mf.dispose();}
});
