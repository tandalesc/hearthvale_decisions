import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {session,signSession,cookie,hmac,digest} from '../cloudflare/auth.js';
import {webhook} from '../cloudflare/billing.js';
import {AccountState} from '../cloudflare/account.js';
globalThis.crypto ??= webcrypto;
const env={AUTH_SECRET:'s'.repeat(32),STRIPE_WEBHOOK_SECRET:'test-signing-secret'};
test('sessions authenticate signed cookies and reject tampering and expiry',async()=>{
 const account={id:'a'.repeat(64),email:'player@example.com',expires:Date.now()+10000};
 const signed=await signSession(env,account);
 const request=value=>new Request('https://game.example/api/session',{headers:{cookie:cookie(value)}});
 assert.deepEqual(await session(request(signed),env),account);
 assert.equal((await session(request(signed+'x'),env)).email,undefined);
 assert.equal((await session(request(await signSession(env,{...account,expires:1})),env)).email,undefined);
 assert.equal((await session(request('player@example.com'),env)).email,undefined);
});
test('webhook requires raw-body signature and timestamp tolerance',async()=>{
 const raw=JSON.stringify({id:'evt_1',livemode:false,created:123,type:'ignored',data:{object:{}}});
 const t=Math.floor(Date.now()/1000), signature=await hmac(env.STRIPE_WEBHOOK_SECRET,`${t}.${raw}`);
 const request=(text=raw,time=t,sig=signature)=>new Request('https://game.example/api/billing/webhook',{method:'POST',body:text,headers:{'stripe-signature':`t=${time},v1=${sig}`}});
 await webhook(request(),env,r=>r.text());
 await assert.rejects(webhook(request(raw+' '),env,r=>r.text()),/signature/);
 await assert.rejects(webhook(request(raw,t-301),env,r=>r.text()),/signature/);
});
// Small SQL fixture exercises actual Durable Object transaction logic.
function object(){const values=new Map();const sql={exec(query,...args){if(query.startsWith('SELECT'))return values.has(args[0])?[{value:values.get(args[0])}]:[];if(query.startsWith('INSERT'))values.set(args[0],args[1]);if(query.startsWith('DELETE'))values.delete(args[0]);return [];}};return new AccountState({storage:{sql,transactionSync:f=>f()}},{});}
const call=async(o,body)=>(await o.fetch(new Request('https://state/',{method:'POST',body:JSON.stringify(body)}))).json();
test('atomic reservations never exceed cap, including concurrent calls',async()=>{
 const o=object();const results=await Promise.all(Array.from({length:20},()=>call(o,{op:'reserve',period:'2026-10',kind:'narration',amount:1,cap:3})));
 assert.equal(results.filter(Boolean).length,3);assert.equal(await call(o,{op:'reserve',period:'2026-10',kind:'narration',amount:-1,cap:3}),false);
});
test('magic links are consumed once and billing events are idempotent',async()=>{
 const o=object(),key=await digest('token');await call(o,{op:'write',key,value:{expires:Date.now()+1000,id:'account'}});
 assert.equal((await call(o,{op:'consume',key})).id,'account');assert.equal(await call(o,{op:'consume',key}),null);
 assert.equal(await call(o,{op:'event',id:'evt1',value:{at:2,active:true}}),true);
 assert.equal(await call(o,{op:'event',id:'evt1',value:{at:3,active:false}}),false);
 await call(o,{op:'event',id:'evt2',value:{at:1,active:false}});
 assert.equal((await call(o,{op:'read',key:'billing'})).active,true);
});
import worker,{readText} from '../cloudflare/worker-handler.js';
test('free accounts cannot reach teachers or narration even with live header',async()=>{
 for(const path of ['/api/decisions','/api/narrate']) {
  const result=await worker.fetch(new Request('https://game.example'+path,{method:'POST',headers:{Origin:'https://game.example','Content-Type':'application/json','X-Hearthvale-Live':'1'},body:'{}'}),env,{waitUntil(){}});
  assert.equal(result.status,402);assert.equal((await result.json()).fallback,true);
 }
});
test('cross-origin mutations rejected before identity or upstream processing',async()=>{
 const result=await worker.fetch(new Request('https://game.example/api/billing/checkout',{method:'POST',headers:{Origin:'https://attacker.example'}}),{},{});
 assert.equal(result.status,403);
});
test('streamed request byte limits reject chunked oversized payloads',async()=>{
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(6));c.enqueue(new Uint8Array(6));c.close();}});
 await assert.rejects(readText(new Request('https://game.example',{method:'POST',body:stream,duplex:'half'}),10),/too large/);
});
function namespace(){const objects=new Map();return {idFromName:id=>id,get(id){if(!objects.has(id)){const instance=object();objects.set(id,{fetch:(input,init)=>instance.fetch(input instanceof Request?input:new Request(input,init))});}return objects.get(id);}};}
async function routeFixture(extra={}) {
 const bound={...env,STRIPE_SECRET_KEY:'sk_test',STRIPE_PRICE_MONTH:'price_month',STRIPE_PRICE_YEAR:'price_year',LIQUID_API_KEY:'liquid_test',ACCOUNT_STATE:namespace(),...extra};
 const account={id:'b'.repeat(64),email:'paid@example.com',expires:Date.now()+100000};
 const signed=await signSession(bound,account),tasks=[];
 const request=(path,body={},authenticated=true)=>new Request('https://game.example'+path,{method:'POST',headers:{Origin:'https://game.example','Content-Type':'application/json',...(authenticated?{cookie:cookie(signed)}:{})},body:JSON.stringify(body)});
 return {bound,account,request,ctx:{waitUntil:p=>tasks.push(p)},tasks};
}
test('customer portal uses the app configuration and authenticated customer',async()=>{
 const f=await routeFixture({STRIPE_PORTAL_CONFIGURATION:'bpc_hearthvale'});
 await f.bound.ACCOUNT_STATE.get(f.account.id).fetch(new Request('https://state/',{method:'POST',body:JSON.stringify({op:'write',key:'billing',value:{customer:'cus_existing'}})}));
 const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(url,'https://api.stripe.com/v1/billing_portal/sessions');const form=new URLSearchParams(init.body);assert.equal(form.get('customer'),'cus_existing');assert.equal(form.get('configuration'),'bpc_hearthvale');assert.equal(form.get('return_url'),'https://game.example/');return Response.json({url:'https://billing.stripe.com/session'});};
 try {const response=await worker.fetch(f.request('/api/billing/portal'),f.bound,f.ctx);assert.equal(response.status,200);assert.equal((await response.json()).url,'https://billing.stripe.com/session');}finally{globalThis.fetch=original;}
});
const townState={phase:'work',food:'ok',wellbeing:'good',taxStep:10};
const routineQuestion={kind:'routine',id:'q1',context:{slice:'district',label:'west',group:40,energy:'normal'}};
test('checkout authenticates, validates exact price, and serializes concurrent sessions',async()=>{
 const f=await routeFixture();const original=globalThis.fetch;let sessions=0,wrongAmount=false;
 globalThis.fetch=async(url,init)=>{
  if(String(url).includes('/prices/'))return Response.json({livemode:false,currency:'usd',unit_amount:wrongAmount?200:100,active:true,recurring:{interval:'month',interval_count:1}});
  if(String(url).endsWith('/customers'))return Response.json({id:'cus_account'});
  if(String(url).includes('/subscriptions?'))return Response.json({data:[]});
  assert.ok(String(url).endsWith('/checkout/sessions'));sessions++;const form=new URLSearchParams(init.body);assert.equal(form.get('line_items[0][price]'),'price_month');assert.equal(form.get('customer'),'cus_account');assert.ok(init.headers['Idempotency-Key']);return Response.json({id:'cs_month',url:'https://checkout.stripe.com/session'});
 };
 try {
  assert.equal((await worker.fetch(f.request('/api/billing/checkout',{interval:'month'},false),f.bound,f.ctx)).status,401);
  wrongAmount=true;assert.equal((await worker.fetch(f.request('/api/billing/checkout',{interval:'month'}),f.bound,f.ctx)).status,400);
  wrongAmount=false;const responses=await Promise.all([1,2].map(()=>worker.fetch(f.request('/api/billing/checkout',{interval:'month'}),f.bound,f.ctx)));
  assert.ok(responses.some(r=>r.status===200));assert.equal(sessions,1);
 } finally {globalThis.fetch=original;}
});
test('signed webhook enables paid route until paid-through deadline and survives old-subscription cancellation',async()=>{
 const f=await routeFixture();const original=globalThis.fetch;let teacherCalls=0;
 await call(f.bound.ACCOUNT_STATE.get(f.account.id),{op:'write',key:'billing',value:{customer:'cus_account',active:false,paidThrough:0,at:0}});
 globalThis.fetch=async(url,init)=>{
  if(String(url).includes('api.stripe.com'))return Response.json({data:[{id:'sub_new',status:'active',current_period_end:Math.floor(Date.now()/1000)+3600,items:{data:[{price:{id:'price_month'}}]}},{id:'sub_old',status:'canceled',current_period_end:Math.floor(Date.now()/1000)-1,items:{data:[{price:{id:'price_month'}}]}}]});
  teacherCalls++;assert.equal(String(url),'https://api.liquid.ai/decisions/v1/systemone');assert.equal(init.headers.Authorization,'Bearer liquid_test');const body=JSON.parse(init.body);assert.equal(body.model,'d1');assert.deepEqual(body.state,townState);assert.equal(body.questions.routine_0.type,'choice');return Response.json({answers:{routine_0:{type:'choice',choice:'work',confidence:.9}}});
 };
 f.bound.LEARNING_COORDINATOR={getByName:()=>({labels:async()=>({stored:0})})};
 try {
  const raw=JSON.stringify({id:'evt_live',livemode:false,created:Math.floor(Date.now()/1000),type:'customer.subscription.deleted',data:{object:{id:'sub_old',customer:'cus_account',metadata:{account:f.account.id}}}});const timestamp=Math.floor(Date.now()/1000);
  const signature=await hmac(f.bound.STRIPE_WEBHOOK_SECRET,`${timestamp}.${raw}`);
  const response=await worker.fetch(new Request('https://game.example/api/billing/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body:raw}),f.bound,f.ctx);assert.equal(response.status,200);
  const body={groups:[{state:townState,questions:[routineQuestion]}]};
  assert.equal((await worker.fetch(f.request('/api/decisions',body),f.bound,f.ctx)).status,200);assert.equal(teacherCalls,1);
  const billing=await call(f.bound.ACCOUNT_STATE.get(f.account.id),{op:'read',key:'billing'});assert.equal(billing.subscription,'sub_new');billing.paidThrough=Date.now()-1;
  await call(f.bound.ACCOUNT_STATE.get(f.account.id),{op:'write',key:'billing',value:billing});
  assert.equal((await worker.fetch(f.request('/api/decisions',body),f.bound,f.ctx)).status,402);assert.equal(teacherCalls,1);
  await Promise.all(f.tasks);
 } finally {globalThis.fetch=original;}
});
test('paid teacher allowance caps provider calls; invalid reports never enter learning',async()=>{
 const f=await routeFixture({PAID_TEACHER_MONTHLY:'1'});let providerCalls=0,reports=0;
 f.bound.LEARNING_COORDINATOR={getByName:()=>({labels:async()=>{},ingest:async()=>{reports++;return {logged:1};}})};
 await call(f.bound.ACCOUNT_STATE.get(f.account.id),{op:'write',key:'billing',value:{active:true,paidThrough:Date.now()+10000}});
 const original=globalThis.fetch;globalThis.fetch=async()=>{providerCalls++;return Response.json({answers:{routine_0:{type:'choice',choice:'work',confidence:.9}}});};
 try {
  const body={groups:[{state:townState,questions:[routineQuestion]}]};
  assert.equal((await worker.fetch(f.request('/api/decisions',body),f.bound,f.ctx)).status,200);
  assert.equal((await worker.fetch(f.request('/api/decisions',body),f.bound,f.ctx)).status,429);assert.equal(providerCalls,1);
  assert.equal((await worker.fetch(f.request('/api/decisions/novel',{questions:[{...routineQuestion,state:townState,reason:'confidence',label:{choice:'work'},schemaVersion:42}]}),f.bound,f.ctx)).status,400);assert.equal(reports,0);
  await Promise.all(f.tasks);
 } finally {globalThis.fetch=original;}
});
test('novel reports preserve bounded provenance but cannot supply trusted labels or trigger teacher',async()=>{
 const f=await routeFixture();let captured;f.bound.LEARNING_COORDINATOR={getByName:()=>({ingest:async report=>{captured=report;return {logged:1,repeats:0,rejected:0};}})};
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Free reports must not call a teacher');};
 try {
  const report={...routineQuestion,state:townState,reason:'confidence',schemaVersion:1,studentVersion:2,label:{probabilities:{work:1}},model:'attacker'};
  const response=await worker.fetch(f.request('/api/decisions/novel',{questions:[report]},false),f.bound,f.ctx);
  assert.equal(response.status,200);assert.equal(captured.questions[0].schemaVersion,1);assert.equal(captured.questions[0].studentVersion,2);assert.equal(captured.questions[0].label,undefined);assert.equal(captured.questions[0].model,undefined);
 } finally {globalThis.fetch=original;}
});

test('magic-link mail uses the native Cloudflare email binding and one-use stored token',async()=>{
 const {requestEmail}=await import('../cloudflare/auth.js');
 const authObject=object(), sent=[];
 const emailEnv={...env,EMAIL_FROM:'hello@game.example',EMAIL:{send:async message=>{sent.push(message);return {messageId:'test-message'};}},ACCOUNT_STATE:{idFromName:x=>x,get:()=>({fetch:(url,init)=>authObject.fetch(new Request(url,init))})}};
 await requestEmail(new Request('https://game.example/api/auth/email'),emailEnv,'Player@example.test');
 assert.equal(sent.length,1);assert.equal(sent[0].to,'player@example.test');assert.deepEqual(sent[0].from,{email:'hello@game.example',name:'Hearthvale'});
 const url=new URL(sent[0].text.match(/https:\/\/\S+/)[0]);assert.equal(url.origin,'https://game.example');
 const key=await digest(url.searchParams.get('token'));
 assert.equal((await call(authObject,{op:'consume',key})).email,'player@example.test');
 assert.equal(await call(authObject,{op:'consume',key}),null);
 await assert.rejects(requestEmail(new Request('https://game.example'),{...emailEnv,EMAIL:undefined},'a@example.test'),/not configured/);
});
test('bootstrap student API URLs fall through to bundled immutable asset paths',async()=>{
 let assetPath;const response=await worker.fetch(new Request('https://game.example/api/students/decisions.v2.json'),{
  LEARNING_COORDINATOR:{getByName:()=>({manifest:async()=>({artifacts:{}})})},
  ASSETS:{fetch:async request=>{assetPath=new URL(request.url).pathname;return Response.json({version:2});}},
 },{});
 assert.equal(response.status,200);assert.equal(assetPath,'/students/decisions.v2.json');assert.deepEqual(await response.json(),{version:2});
});

test('changing checkout interval expires the old session before creating one for the selected price', async () => {
 const f=await routeFixture(), original=globalThis.fetch;
 const events=[]; let sessions=0;
 globalThis.fetch=async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.includes('/prices/')) {const year=path.endsWith('price_year');return Response.json({livemode:false,currency:'usd',unit_amount:year?1000:100,active:true,recurring:{interval:year?'year':'month',interval_count:1}});}
  if(path.endsWith('/customers'))return Response.json({id:'cus_account'});
  if(path.endsWith('/subscriptions'))return Response.json({data:[]});
  if(path.endsWith('/expire')) {events.push('expire');assert.ok(path.endsWith('/cs_month/expire'));return Response.json({status:'expired'});}
  assert.ok(path.endsWith('/checkout/sessions'));
  const price=new URLSearchParams(init.body).get('line_items[0][price]');events.push(price);sessions++;
  return Response.json({id:price==='price_month'?'cs_month':'cs_year',url:`https://checkout.stripe.com/${price}`});
 };
 try {
  const request=interval=>worker.fetch(f.request('/api/billing/checkout',{interval}),f.bound,f.ctx);
  assert.equal((await (await request('month')).json()).url,'https://checkout.stripe.com/price_month');
  const results=await Promise.all([request('year'),request('year')]);
  assert.ok(results.some(response=>response.status===200));
  assert.equal((await (await request('year')).json()).url,'https://checkout.stripe.com/price_year');
  assert.deepEqual(events,['price_month','expire','price_year']);assert.equal(sessions,2);
 } finally {globalThis.fetch=original;}
});

test('failed or completed previous checkout cannot create a replacement subscription', async () => {
 for(const previousStatus of ['open','complete']) {
  const f=await routeFixture(), original=globalThis.fetch;let sessions=0;
  globalThis.fetch=async(url,init)=>{
   const path=new URL(url).pathname;
   if(path.includes('/prices/')) {const year=path.endsWith('price_year');return Response.json({livemode:false,currency:'usd',unit_amount:year?1000:100,active:true,recurring:{interval:year?'year':'month',interval_count:1}});}
   if(path.endsWith('/customers'))return Response.json({id:'cus_account'});
   if(path.endsWith('/subscriptions'))return Response.json({data:[]});
   if(path.endsWith('/expire'))return Response.json({error:'Cannot expire'}, {status:400});
   if(path.endsWith('/cs_month'))return Response.json({status:previousStatus});
   sessions++;return Response.json({id:'cs_month',url:'https://checkout.stripe.com/month'});
  };
  try {
   const request=interval=>worker.fetch(f.request('/api/billing/checkout',{interval}),f.bound,f.ctx);
   assert.equal((await request('month')).status,200);
   assert.equal((await request('year')).status,409);
   assert.equal((await request('year')).status,409);
   assert.equal(sessions,1);
  } finally {globalThis.fetch=original;}
 }
});

test('checkout preparation retry retains idempotency identity and fences competing intervals', async () => {
 const account=object();
 const first=await call(account,{op:'checkout',key:'first',interval:'month'});
 assert.equal(first.fresh,true);
 assert.equal((await call(account,{op:'checkout',key:'other',interval:'year'})).fresh,false);
 assert.equal((await call(account,{op:'checkout',key:'other',interval:'month'})).fresh,false);
 await call(account,{op:'write',key:'checkout',value:{...first,busyUntil:0}});
 const retry=await call(account,{op:'checkout',key:'different',interval:'month'});
 assert.equal(retry.fresh,true);assert.equal(retry.key,'first');
 assert.equal(await call(account,{op:'checkout-result',key:'different',sessionId:'cs_stale',url:'stale'}),false);
 assert.equal(await call(account,{op:'checkout-result',key:'first',sessionId:'cs_month',url:'month'}),true);
 const change=await call(account,{op:'checkout',key:'year',interval:'year'});
 assert.equal(change.fresh,true);assert.equal(change.previousSessionId,'cs_month');
});

test('checkout retry after its preparation lease sends identical Stripe parameters and expiry', async () => {
 const f=await routeFixture(), originalFetch=globalThis.fetch, originalNow=Date.now;
 let now=originalNow(), attempts=0;
 const sent=[];
 Date.now=()=>now;
 globalThis.fetch=async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.includes('/prices/'))return Response.json({livemode:false,currency:'usd',unit_amount:100,active:true,recurring:{interval:'month',interval_count:1}});
  if(path.endsWith('/customers'))return Response.json({id:'cus_account'});
  if(path.endsWith('/subscriptions'))return Response.json({data:[]});
  assert.ok(path.endsWith('/checkout/sessions'));
  sent.push({body:String(init.body),key:init.headers['Idempotency-Key']});
  if(attempts++===0)throw new Error('Response lost after Stripe accepted the checkout');
  return Response.json({id:'cs_month',url:'https://checkout.stripe.com/month'});
 };
 try {
  const request=()=>worker.fetch(f.request('/api/billing/checkout',{interval:'month'}),f.bound,f.ctx);
  assert.equal((await request()).status,503);
  now+=61000;
  assert.equal((await request()).status,200);
  assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);
  const expiry=Number(new URLSearchParams(sent[1].body).get('expires_at'));
  assert.ok(expiry-Math.floor(now/1000)>1800,'retry still meets Stripe minimum expiration');
 } finally {globalThis.fetch=originalFetch;Date.now=originalNow;}
});

test('unresolved checkout cannot retry once its fixed expiry is too close to Stripe minimum', async () => {
 const account=object(), first=await call(account,{op:'checkout',key:'first',interval:'month'});
 await call(account,{op:'write',key:'checkout',value:{...first,busyUntil:0,stripeExpiresAt:Math.floor(Date.now()/1000)+1800}});
 assert.equal((await call(account,{op:'checkout',key:'retry',interval:'month'})).fresh,false);
 assert.equal((await call(account,{op:'checkout',key:'year',interval:'year'})).fresh,false);
});

test('verified email returns to account flow and cannot reuse its sign-in link',async()=>{
 const f=await routeFixture(), token='c'.repeat(64);
 await f.bound.ACCOUNT_STATE.get('auth').fetch(new Request('https://state/',{method:'POST',body:JSON.stringify({op:'write',key:await digest(token),value:{id:f.account.id,email:f.account.email,expires:Date.now()+10000}})}));
 const request=()=>new Request('https://game.example/api/auth/verify?token='+token);
 const response=await worker.fetch(request(),f.bound,f.ctx);
 assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/?signin=success');
 const signed=response.headers.get('set-cookie');
 assert.equal((await session(new Request('https://game.example',{headers:{cookie:signed}}),f.bound)).id,f.account.id);
 assert.equal((await worker.fetch(request(),f.bound,f.ctx)).status,400);
});

async function emailChallenge() {
 const sent=[];
 const f=await routeFixture({EMAIL_FROM:'hello@game.example',EMAIL:{send:async message=>sent.push(message)}});
 const response=await worker.fetch(f.request('/api/auth/email',{email:'Player@example.test'},false),f.bound,f.ctx);
 assert.equal(response.status,200);
 const body=await response.json();
 assert.match(body.challenge,/^[a-f0-9]{64}$/);
 const code=sent[0].text.match(/sign-in code: (\d{6})/)[1];
 const link=new URL(sent[0].text.match(/https:\/\/\S+/)[0]);
 assert.notEqual(body.challenge,link.searchParams.get('token'));
 const verify=(challenge=body.challenge,value=code)=>worker.fetch(f.request('/api/auth/code',{challenge,code:value},false),f.bound,f.ctx);
 return {...f,challenge:body.challenge,code,link,verify};
}

test('email code signs into requesting app and consumes the matching link, including concurrent reuse',async()=>{
 const f=await emailChallenge();
 const results=await Promise.all([f.verify(f.challenge,f.code.slice(0,3)+' '+f.code.slice(3)),f.verify()]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
 const success=results.find(r=>r.status===200);
 const signed=success.headers.get('set-cookie');assert.match(signed,/HttpOnly; Secure; SameSite=Lax/);
 const account=await session(new Request('https://game.example',{headers:{cookie:signed}}),f.bound);
 assert.equal(account.email,'player@example.test');assert.equal(account.id,await digest('player@example.test'));
 assert.equal((await worker.fetch(new Request(f.link),f.bound,f.ctx)).status,400);
});

test('link consumption invalidates code and code cannot be used with another challenge',async()=>{
 const f=await emailChallenge();
 assert.equal((await f.verify('0'.repeat(64))).status,400);
 assert.equal((await worker.fetch(new Request(f.link),f.bound,f.ctx)).status,303);
 assert.equal((await f.verify()).status,400);
});

test('five incorrect code attempts lock the code; expiry denies both methods',async()=>{
 const f=await emailChallenge();
 const wrong=f.code==='000000'?'111111':'000000';
 const failures=await Promise.all(Array.from({length:5},()=>f.verify(f.challenge,wrong)));
 assert.ok(failures.every(r=>r.status===400));
 assert.equal((await f.verify()).status,400);
 // The emailed long token remains a recovery path after code lockout.
 assert.equal((await worker.fetch(new Request(f.link),f.bound,f.ctx)).status,303);
 const expired=await emailChallenge();
 const key=await digest(expired.link.searchParams.get('token'));
 const stub=expired.bound.ACCOUNT_STATE.get('auth');
 const invoke=async body=>(await stub.fetch('https://state/',{method:'POST',body:JSON.stringify(body)})).json();
 const value=await invoke({op:'read',key});
 assert.equal(value.code,undefined);assert.match(value.codeHash,/^[a-f0-9]{64}$/);
 await invoke({op:'write',key,value:{...value,expires:Date.now()-1}});
 assert.equal((await expired.verify()).status,400);
 assert.equal((await worker.fetch(new Request(expired.link),expired.bound,expired.ctx)).status,400);
});

test('email responses disclose no delivery state and code endpoint enforces origin and IP cap',async()=>{
 const f=await routeFixture({EMAIL_FROM:'hello@game.example',EMAIL:{send:async()=>{throw new Error('Delivery failed');}}});
 for(const email of ['not-an-email','player@example.test']) {
  const response=await worker.fetch(f.request('/api/auth/email',{email},false),f.bound,f.ctx);
  assert.equal(response.status,200);const body=await response.json();assert.match(body.challenge,/^[a-f0-9]{64}$/);assert.equal(body.ok,true);
 }
 const request=f.request('/api/auth/code',{challenge:'a'.repeat(64),code:'123456'},false);
 request.headers.set('origin','https://other.example');
 assert.equal((await worker.fetch(request,f.bound,f.ctx)).status,403);
 const stub=f.bound.ACCOUNT_STATE.get('auth-rate:'+await digest('unknown'));
 await stub.fetch('https://state/',{method:'POST',body:JSON.stringify({op:'reserve',kind:'code',period:new Date().toISOString().slice(0,10),amount:100,cap:100})});
 assert.equal((await worker.fetch(f.request('/api/auth/code',{challenge:'a'.repeat(64),code:'123456'},false),f.bound,f.ctx)).status,429);
});

test('email plus code works in a separate app context without the original challenge',async()=>{
 const f=await emailChallenge();
 const response=await worker.fetch(f.request('/api/auth/code',{email:' Player@example.test ',code:f.code},false),f.bound,f.ctx);
 assert.equal(response.status,200);
 assert.equal((await session(new Request('https://game.example',{headers:{cookie:response.headers.get('set-cookie')}}),f.bound)).email,'player@example.test');
 assert.equal((await f.verify()).status,400);
 assert.equal((await worker.fetch(new Request(f.link),f.bound,f.ctx)).status,400);
});

test('live billing never inherits test subscription access or customer records',async()=>{
 const f=await routeFixture();
 await f.bound.ACCOUNT_STATE.get(f.account.id).fetch('https://state/',{method:'POST',body:JSON.stringify({op:'write',key:'billing',value:{active:true,paidThrough:Date.now()+100000,customer:'cus_test'}})});
 const read=bound=>worker.fetch(new Request('https://game.example/api/session',{headers:{cookie:f.request('/').headers.get('cookie')}}),bound,f.ctx);
 assert.equal((await (await read(f.bound)).json()).tier,'paid');
 const live={...f.bound,STRIPE_SECRET_KEY:'sk_live_fixture'};
 assert.equal((await (await read(live)).json()).tier,'free');
 const {billingState}=await import('../cloudflare/billing.js');
 await billingState(live,f.account.id,'write',{key:'billing',value:{active:true,paidThrough:Date.now()+100000,customer:'cus_live'}});
 assert.equal((await (await read(live)).json()).tier,'paid');
 assert.equal((await billingState(f.bound,f.account.id,'read',{key:'billing'})).customer,'cus_test');
 assert.equal((await billingState(live,f.account.id,'read',{key:'billing'})).customer,'cus_live');
 const raw=JSON.stringify({id:'evt_wrong_mode',livemode:false,created:Math.floor(Date.now()/1000),type:'ignored'}),timestamp=Math.floor(Date.now()/1000);
 const signature=await hmac(live.STRIPE_WEBHOOK_SECRET,`${timestamp}.${raw}`);
 await assert.rejects(webhook(new Request('https://game.example/api/billing/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body:raw}),live,r=>r.text()),/Invalid event/);
});
// Shared town pages (E9): POST /api/towns keeps a cleaned summary in R2; GET /t/<id> draws it read-only.
function bucket(){const items=new Map();return {items,async head(k){return items.has(k)?{key:k}:null;},async put(k,v){items.set(k,String(v));},async get(k){return items.has(k)?{text:async()=>items.get(k)}:null;}};}
const townSummary={townName:'Oak <Ford>',year:150,eraName:'City',archetypeName:'a mill town',lead:'It began as a market town. Then it became a mill town.',
 arc:[{year:0,name:'a market town'},{year:60,name:'a mill town'}],sentences:['Hearthvale became a mill town.','<script>alert(1)</script>'],
 highlights:Array.from({length:20},(_,i)=>({year:i*7,text:`Moment ${i} & more`})),
 compass:{from:1,to:150,axes:[{id:'industry',low:'Fields',high:'Industry',points:[[1,0],[75,0.4],[150,9]]}]},
 bodies:{founded:[{name:'Craft Guild',year:12}],dissolved:[],refused:[{name:'Union',year:90}]},rulings:{approved:10,refused:3,lapsed:2,total:15},people:3200,rules:12,centres:[],extra:'dropped'};
const townRequest=(body,headers={})=>new Request('https://game.example/api/towns',{method:'POST',headers:{Origin:'https://game.example','Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9',...headers},body:JSON.stringify(body)});
test('a finished town is shared to R2 and drawn read-only at /t/<id>, escaped and script-free',async()=>{
 const f=await routeFixture({STUDENT_ARTIFACTS:bucket()});
 const response=await worker.fetch(townRequest({page:townSummary}),f.bound,f.ctx);
 assert.equal(response.status,201);
 const {id,url}=await response.json();
 assert.match(id,/^[a-z2-9]{10}$/);assert.equal(url,`/t/${id}`);
 const stored=JSON.parse(f.bound.STUDENT_ARTIFACTS.items.get(`town-pages/v1/${id}.json`));
 assert.equal(stored.v,1);assert.equal(stored.page.highlights.length,12);assert.equal(stored.page.extra,undefined);
 assert.equal(stored.page.compass.axes[0].points[2][1],1,'trait values are clamped');
 // Free players get it too: no sign-in was sent.
 const page=await worker.fetch(new Request('https://game.example'+url),f.bound,f.ctx);
 assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
 assert.match(page.headers.get('content-security-policy'),/default-src 'none'/);
 const html=await page.text();
 assert.match(html,/Oak &lt;Ford&gt;/);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
 assert.doesNotMatch(html,/<script/i);assert.match(html,/href="\/"/);assert.match(html,/Hearthvale/);
 assert.match(html,/Moment 0 &amp; more/);assert.match(html,/Craft Guild/);assert.match(html,/15 requests were ruled on/);
 const missing=await worker.fetch(new Request('https://game.example/t/zzzzzzzzzz'),f.bound,f.ctx);assert.equal(missing.status,404);
 const odd=await worker.fetch(new Request('https://game.example/t/..%2Fsecret'),f.bound,f.ctx);assert.equal(odd.status,404);
});
test('town sharing checks origin, shape and a 20-a-day IP limit',async()=>{
 const f=await routeFixture({STUDENT_ARTIFACTS:bucket()});
 const cross=await worker.fetch(townRequest({page:townSummary},{Origin:'https://attacker.example'}),f.bound,f.ctx);
 assert.equal(cross.status,403);assert.equal(f.bound.STUDENT_ARTIFACTS.items.size,0);
 assert.equal((await worker.fetch(townRequest({page:{townName:'Empty'}}),f.bound,f.ctx)).status,400);
 assert.equal((await worker.fetch(townRequest({page:'nope'}),f.bound,f.ctx)).status,400);
 // A picture comes along only as a small image data URL.
 const withImage=await worker.fetch(townRequest({page:townSummary,image:'data:image/jpeg;base64,AAAA'},{'CF-Connecting-IP':'198.51.100.1'}),f.bound,f.ctx);
 const kept=JSON.parse(f.bound.STUDENT_ARTIFACTS.items.get(`town-pages/v1/${(await withImage.json()).id}.json`));assert.equal(kept.image,'data:image/jpeg;base64,AAAA');
 const badImage=await worker.fetch(townRequest({page:townSummary,image:'javascript:alert(1)'},{'CF-Connecting-IP':'198.51.100.1'}),f.bound,f.ctx);
 assert.equal(JSON.parse(f.bound.STUDENT_ARTIFACTS.items.get(`town-pages/v1/${(await badImage.json()).id}.json`)).image,undefined);
 // The two invalid posts above already counted against this IP's day.
 const statuses=[];for(let i=0;i<20;i++) statuses.push((await worker.fetch(townRequest({page:townSummary}),f.bound,f.ctx)).status);
 assert.equal(statuses.filter((s)=>s===201).length,18);assert.equal(statuses.at(-1),429);
 assert.equal((await worker.fetch(townRequest({page:townSummary},{'CF-Connecting-IP':'192.0.2.7'}),f.bound,f.ctx)).status,201,'another IP still can');
 assert.equal((await worker.fetch(new Request('https://game.example/api/towns',{method:'GET'}),f.bound,f.ctx)).status,405);
});
