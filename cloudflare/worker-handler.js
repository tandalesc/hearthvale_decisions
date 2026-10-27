import {AccountState,state,reserve} from './account.js';
import {session,signSession,cookie,digest,hmac,constantEqual,requestEmail,randomToken,codeHash} from './auth.js';
import {billingEnabled,checkout,stripe,webhook,isPaid,billingState} from './billing.js';
import {validateDecisionRequest,hostedDecisions} from './decision.js';
import {validateQuestion,validateState} from '../src/decision-kinds.js';
import {recordLearningReport,recordLearningLabels,handleLearningRequest} from './learning.js';
import {observeNarration,logNarrationOutcome} from './narration-outcome.js';
import {narrationStream} from './narration-stream.js';
import {narrateAnthropic,validateNarrationFacts,narrationKey} from './narration.js';
import {createTownPage,townPage} from './town-pages.js';

export async function readText(request,max) {
 const declared=Number(request.headers.get('content-length')); if(declared>max) throw Object.assign(new Error('Request too large'),{status:413});
 const reader=request.body?.getReader(); if(!reader) return ''; let size=0; const chunks=[];
 try { for(;;) {const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>max) {await reader.cancel();throw Object.assign(new Error('Request too large'),{status:413});} chunks.push(value);} } finally {reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;} return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
const json=(status,body,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const cap=(env,name,fallback)=>{const n=Number(env[name]??fallback);return Number.isSafeInteger(n)&&n>=0?n:0;};
async function allowance(env,id,kind,amount,personal,global) {
 // Reservations are never refunded on errors, preventing retry-driven overspend.
 const period=new Date().toISOString().slice(0,7);
 if(!await state(env,id,'reserve',{kind,amount,cap:personal,period})) return false;
 return state(env,'global','reserve',{kind,amount,cap:global,period});
}
export default {
 async fetch(request,env,ctx) {
 const url=new URL(request.url),path=url.pathname;
 // A shared town's read-only page (cloudflare/town-pages.js).
 if(/^\/t\/[^/]*$/.test(path)) { try { return await townPage(request,env,path.slice(3)); } catch { return new Response('Service unavailable',{status:503,headers:{'Cache-Control':'no-store'}}); } }
 if(!path.startsWith('/api/')&&!path.startsWith('/students/')) return env.ASSETS.fetch(request);
 try {
  if(path==='/api/billing/webhook') { if(request.method!=='POST') return json(405,{error:'Method not allowed'}); await webhook(request,env,readText);return json(200,{received:true}); }
  if(path.startsWith('/api/learning/')||path.startsWith('/api/students/')||path.startsWith('/students/')) { const response=await handleLearningRequest(request,env);if(response) return response;const assetUrl=new URL(request.url);assetUrl.pathname=assetUrl.pathname.replace(/^\/api\/students\//,'/students/');return env.ASSETS.fetch(new Request(assetUrl,request)); }
  if(['POST','PUT','PATCH','DELETE'].includes(request.method) && (request.headers.get('origin')!==url.origin || request.headers.get('sec-fetch-site')==='cross-site')) return json(403,{error:'Origin not allowed'});
  // Share a finished town: free and paid alike, limited per IP (cloudflare/town-pages.js).
  if(path==='/api/towns') return await createTownPage(request,env,readText);
  const account=await session(request,env);
  const respond=async(status,body,headers={})=>json(status,body,{'Set-Cookie':cookie(await signSession(env,account)),...headers});
  const billing=account.email?await billingState(env,account.id,'read',{key:'billing'}):null;
  const paid=Boolean(account.email&&isPaid(billing));
  if(path==='/api/session'&&request.method==='GET') return respond(200,{tier:paid?'paid':'free',authenticated:Boolean(account.email),...(account.email?{email:account.email,cloudAccountId:await hmac(env.AUTH_SECRET,`cloud-scope:${account.id}`)}:{}),billingEnabled:billingEnabled(env),limits:{narrationsPerMonth:cap(env,'PAID_NARRATIONS_MONTHLY',2000),teacherQuestionsPerMonth:cap(env,'PAID_TEACHER_MONTHLY',1000),cloudTowns:paid?10:1,cloudSaveBytes:16*1024*1024}});
  if(path==='/api/cloud/recover'||path==='/api/cloud/towns'||path.startsWith('/api/cloud/towns/')) {
   if(!account.email) return respond(401,{error:'Sign in first'});
   const cloudAccountId=await hmac(env.AUTH_SECRET,`cloud-scope:${account.id}`);
   if(!constantEqual(request.headers.get('x-cloud-account')||'',cloudAccountId)) return respond(409,{error:'Account changed. Please try again.',code:'account_changed'});
   const recover=path==='/api/cloud/recover';
   const suffix=recover?'/recover':path.slice('/api/cloud/towns'.length);
   if(!recover && !/^$|^\/[0-9a-f-]{36}(?:\/(?:history|restore))?$/i.test(suffix)) return json(404,{error:'Not found'});
   const method=request.method;
   if(!['GET','PUT','DELETE','POST'].includes(method)) return json(405,{error:'Method not allowed'});
   const internal=new URL(`https://state.internal/cloud${suffix || '/'}`);
   internal.searchParams.set('account',account.id);
   internal.searchParams.set('limit',paid?'10':'1');
   const headers=new Headers();
   for(const name of ['content-type','content-length','if-match','x-save-id','x-town-meta']) {const value=request.headers.get(name);if(value)headers.set(name,value);}
   headers.set('x-cloud-limit',paid?'10':'1');
   const stub=env.ACCOUNT_STATE.get(env.ACCOUNT_STATE.idFromName(account.id));
   return await stub.fetch(internal,{method,headers,...(['PUT','POST'].includes(method)?{body:request.body,duplex:'half'}:{})});
  }
  if(path==='/api/auth/verify'&&request.method==='GET') {
   const token=url.searchParams.get('token'); if(!/^[a-f0-9]{64}$/.test(token||'')) return json(400,{error:'Invalid or expired link'});
   const value=await state(env,'auth','consume',{key:await digest(token)}); if(!value) return json(400,{error:'Invalid or expired link'});
   return new Response(null,{status:303,headers:{Location:'/?signin=success', 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':cookie(await signSession(env,{id:value.id,email:value.email,expires:Date.now()+2592000000}))}});
  }
  if(request.method!=='POST' && path!=='/api/system1/status') return json(405,{error:'Method not allowed'});
  if(path==='/api/system1/status') return respond(200,{state:paid&&env.LIQUID_API_KEY?'ready':'student-only',engine:paid?'hosted-teacher':'local-student',modelConnected:paid&&Boolean(env.LIQUID_API_KEY),model:paid?'d1':null});
  if(path==='/api/logout') return json(200,{ok:true},{'Set-Cookie':cookie('',0)});
  if(!request.headers.get('content-type')?.startsWith('application/json')) return json(415,{error:'JSON required'});
  const body=JSON.parse(await readText(request,65536));
  if(path==='/api/auth/email') {
   const challenge=randomToken();
   const ip=request.headers.get('CF-Connecting-IP')||'unknown';
   if(await reserve(env,'auth-rate:'+await digest(ip),'email',1,10) && await reserve(env,'auth','email',1,cap(env,'AUTH_EMAIL_DAILY_CAP',1000))) {
    try { await requestEmail(request,env,body.email,challenge); } catch {} // Identical response prevents account enumeration.
   }
   return respond(200,{ok:true,challenge,message:'If email delivery is available, a sign-in code and link are on their way.'});
  }
  if(path==='/api/auth/code') {
   const code=typeof body.code==='string'?body.code.replace(/[\s-]/g,''):'';
   const error={error:'Invalid or expired code. Check the code or request a new email.'};
   const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
   if(!/^\d{6}$/.test(code) || (body.challenge ? !/^[a-f0-9]{64}$/.test(body.challenge) : email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return json(400,error);
   const ip=request.headers.get('CF-Connecting-IP')||'unknown';
   if(!await reserve(env,'auth-rate:'+await digest(ip),'code',1,100)) return json(429,{error:'Too many attempts. Please try again later.'});
   // A known request can be resumed directly. Email lookup also lets a player
   // enter the newest code after changing browsers or reopening the installed app.
   const pending=body.challenge?{challenge:body.challenge,codeKey:'code:'+await digest(body.challenge)}:await state(env,'auth','read',{key:'email:'+await digest(email)});
   if(!pending) return json(400,error);
   const value=await state(env,'auth','auth-code',{key:pending.codeKey,hash:await codeHash(env,pending.challenge,code)});
   if(!value) return json(400,{error:'Invalid or expired code. Check the code or request a new email.'});
   return json(200,{ok:true},{'Set-Cookie':cookie(await signSession(env,{id:value.id,email:value.email,expires:Date.now()+2592000000}))});
  }
  if(path==='/api/billing/checkout'||path==='/api/billing/portal') {
   if(!account.email) return respond(401,{error:'Sign in first'});if(!billingEnabled(env)) return respond(503,{error:'Billing unavailable'});
   if(!await reserve(env,account.id,'billing',1,20)) return respond(429,{error:'Try again later'});
   if(path.endsWith('checkout')) return respond(200,await checkout(env,account,url.origin,body.interval));
   if(!billing?.customer) return respond(409,{error:'No billing account'});
   const portal=await stripe(env,'billing_portal/sessions',{customer:billing.customer,return_url:url.origin+'/',...(env.STRIPE_PORTAL_CONFIGURATION?{configuration:env.STRIPE_PORTAL_CONFIGURATION}:{})});return respond(200,{url:portal.url});
  }
  if(path==='/api/decisions/novel') {
   if(!Array.isArray(body.questions)||body.questions.length<1||body.questions.length>32) return respond(400,{error:'Invalid reports'});
   const questions=body.questions.map(q=>{if(!['confidence','unknown','kind'].includes(q.reason)) throw new Error('Invalid reason');if(q.schemaVersion!==undefined&&q.schemaVersion!==1) throw new Error('Invalid schemaVersion');if(q.studentVersion!==undefined&&q.studentVersion!==null&&(!Number.isSafeInteger(q.studentVersion)||q.studentVersion<1)) throw new Error('Invalid studentVersion');const clean=validateQuestion({id:'novel',kind:q.kind,context:q.context,...(q.allowed?{allowed:q.allowed}:{})});return {...clean,state:validateState(q.kind,q.state),reason:q.reason,...(q.schemaVersion!==undefined?{schemaVersion:q.schemaVersion}:{}),...(q.studentVersion!==undefined?{studentVersion:q.studentVersion}:{}),...(Number.isFinite(q.expectedKL)&&q.expectedKL>=0&&q.expectedKL<=100?{expectedKL:q.expectedKL}:{})};});
   const ip=await digest(request.headers.get('CF-Connecting-IP')||'unknown');
   if(!await reserve(env,'reports:'+ip,'reports',questions.length,256)||!await reserve(env,'global','reports',questions.length,cap(env,'NOVEL_DAILY_CAP',10000))) return respond(429,{error:'Report budget used',fallback:true});
   const result=await recordLearningReport(env,{questions,client:await digest(account.id)});return respond(200,result);
  }
  if(path==='/api/decisions'||path==='/api/narrate') {
   if(!paid) return respond(402,{error:'Paid account required',fallback:true});
   if(path==='/api/decisions') {
    const groups=validateDecisionRequest(body);if(groups.length>4) return respond(400,{error:'At most four states per hosted request'});
    const amount=groups.reduce((n,g)=>n+g.questions.length,0);
    if(!env.LIQUID_API_KEY) return respond(503,{error:'Teacher unavailable',fallback:true});
    if(!await allowance(env,account.id,'teacher',amount,cap(env,'PAID_TEACHER_MONTHLY',1000),cap(env,'GLOBAL_TEACHER_MONTHLY',100000))) return respond(429,{error:'Teacher budget used',fallback:true});
    const result=await hostedDecisions(env,groups,readText);
    ctx.waitUntil(recordLearningLabels(env,{groups,answers:result.answers,model:result.model}).catch(()=>{}));
    return respond(200,result);
   }
   const facts=validateNarrationFacts(body), fingerprint=await digest(narrationKey(facts));
   const cached=await state(env,account.id,'read',{key:'narration-cache'});
   const wantsStream=request.headers.get('accept')?.split(',').some(type=>type.trim().split(';')[0]==='text/event-stream');
   const streamHeaders=wantsStream?{'Set-Cookie':cookie(await signSession(env,account))}:null;
   if(cached?.fingerprint===fingerprint&&cached.expires>Date.now()) {logNarrationOutcome('cache',Date.now());return wantsStream?narrationStream({request,ctx,headers:streamHeaders,cached:cached.value}):respond(200,cached.value);}
   if(!env.ANTHROPIC_API_KEY) return respond(503,{error:'Narration unavailable',fallback:true});
   if(!await allowance(env,account.id,'narration',1,cap(env,'PAID_NARRATIONS_MONTHLY',2000),cap(env,'GLOBAL_NARRATIONS_MONTHLY',200000))) return respond(429,{error:'Narration budget used',fallback:true});
   const save=value=>state(env,account.id,'write',{key:'narration-cache',value:{fingerprint,value,expires:Date.now()+86400000}});
   const run=options=>observeNarration({run:callbacks=>narrateAnthropic(facts,env,callbacks),...options});
   if(wantsStream) return narrationStream({request,ctx,headers:streamHeaders,run,onComplete:save});
   const value=await run({signal:request.signal});
   await save(value);
   return respond(200,value);
  }
  return json(404,{error:'Not found'});
 } catch(error) {
  // Log only known categories, never request bodies, credentials, or sign-in tokens.
  const known=['Invalid configured price','Invalid interval','State unavailable','Billing unavailable','Invalid checkout session','Invalid signature'];
  console.error(JSON.stringify({event:'request_failed',path:new URL(request.url).pathname,reason:known.includes(error.message)?error.message:'unclassified',name:error.name}));
  return json(error.status||(/Invalid|Unexpected|JSON|question|state|context|field/i.test(error.message)?400:503),{error:error.status===413?'Request too large':'Service request could not be completed',fallback:true});}
 },
 async scheduled(event,env,ctx) { const stub=env.LEARNING_COORDINATOR.get(env.LEARNING_COORDINATOR.idFromName('global'));ctx.waitUntil(stub.scheduled()); }
};
