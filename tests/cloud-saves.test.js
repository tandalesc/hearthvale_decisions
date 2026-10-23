import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {signSession,hmac} from '../cloudflare/auth.js';

const origin='https://game.test', secret='runtime-cloud-secret-not-a-real-key-1234';
const ids={town:'11111111-1111-4111-8111-111111111111',second:'22222222-2222-4222-8222-222222222222',one:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',two:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',three:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
const meta=encodeURIComponent(JSON.stringify({name:'First Town',year:1,month:2,people:30,era:'village'}));
const bytes=gzipSync(JSON.stringify({year:1,people:30}));
const newerBytes=gzipSync(JSON.stringify({year:2,people:35}));
async function setup() {
 const compiled=await build({stdin:{resolveDir:fileURLToPath(new URL('..',import.meta.url)),contents:`
  import worker from './cloudflare/worker-handler.js';
  import {AccountState as Base} from './cloudflare/account.js';
  export class AccountState extends Base { async fetch(request) { const path=new URL(request.url).pathname;if(path==='/test-alarm') {await this.alarm();return Response.json({ok:true});} if(path==='/test-clear') {this.sql.exec("DELETE FROM kv WHERE key IN ('cloud:catalog','cloud:snapshots')");return Response.json({ok:true});} if(path==='/test-fill-rate') {const value=this.get('cloud:catalog');value.writes={[new Date().toISOString().slice(0,10)]:800};this.put('cloud:catalog',value);return Response.json({ok:true});} return super.fetch(request); } }
  export default worker;
 `},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-23',bindings:{AUTH_SECRET:secret},durableObjects:{ACCOUNT_STATE:{className:'AccountState',useSQLite:true}},r2Buckets:['STUDENT_ARTIFACTS']}));
 const auth=async id=>'__Host-hearthvale='+await signSession({AUTH_SECRET:secret},{id,email:`${id.slice(0,4)}@example.test`,expires:Date.now()+3600000});
 const cookieA=await auth('a'.repeat(64)),cookieB=await auth('b'.repeat(64));
 const scopeA=await hmac(secret,`cloud-scope:${'a'.repeat(64)}`),scopeB=await hmac(secret,`cloud-scope:${'b'.repeat(64)}`);
 const request=(cookie,path,method='GET',extra={})=>mf.dispatchFetch(origin+path,{method,headers:{cookie,'x-cloud-account':cookie===cookieA?scopeA:scopeB,...(method!=='GET'?{origin}:{}),...extra.headers},...(extra.body?{body:extra.body}:{})});
 const save=(cookie,id,base,saveId,payload=bytes)=>request(cookie,`/api/cloud/towns/${id}`,'PUT',{headers:{'content-type':'application/gzip','if-match':String(base),'x-save-id':saveId,'x-town-meta':meta},body:payload});
 const bucket=await mf.getR2Bucket('STUDENT_ARTIFACTS');
 return {mf,cookieA,cookieB,scopeA,scopeB,request,save,bucket};
}
test('cloud saves enforce account isolation, CAS, retry idempotency, quota, and restore', {timeout:30000},async()=>{
 const f=await setup();try {
  const {request,save,cookieA,cookieB}=f;
  assert.equal((await request('', '/api/cloud/towns')).status,401);
  assert.equal((await request(cookieA,'/api/cloud/towns','GET',{headers:{'x-cloud-account':''}})).status,409);
  assert.equal((await request(cookieA,'/api/cloud/towns','GET',{headers:{'x-cloud-account':f.scopeB}})).status,409);
  assert.equal((await request(cookieA,`/api/cloud/towns/${ids.town}`,'PUT',{headers:{origin:'https://attacker.test','content-type':'application/gzip','if-match':'0','x-save-id':ids.one,'x-town-meta':meta},body:bytes})).status,403);
  const concurrent=await Promise.all([save(cookieA,ids.town,0,ids.one),save(cookieA,ids.town,0,ids.two)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  const accepted=concurrent.find(r=>r.status===200), acceptedTown=(await accepted.json()).town;
  assert.equal(acceptedTown.revision,1);
  const stale=await concurrent.find(r=>r.status===409).json();assert.equal(stale.code,'conflict');assert.equal(stale.town.revision,1);
  assert.equal((await save(cookieA,ids.town,0,acceptedTown.saveId)).status,200,'lost response retry must be idempotent');
  const download=await request(cookieA,`/api/cloud/towns/${ids.town}`);assert.equal(download.status,200);assert.equal(download.headers.get('content-encoding'),null);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  assert.equal((await request(cookieB,`/api/cloud/towns/${ids.town}`)).status,404);
  assert.equal((await request(cookieB,'/api/cloud/towns')).status,200);
  assert.equal((await save(cookieB,ids.town,0,ids.one,newerBytes)).status,200,'another account can use the same town ID independently');
  assert.deepEqual(Buffer.from(await (await request(cookieB,`/api/cloud/towns/${ids.town}`)).arrayBuffer()),newerBytes);
  assert.equal((await save(cookieA,ids.second,0,ids.three)).status,409,'free tier only creates one active town');
  const second=await save(cookieA,ids.town,1,ids.three,newerBytes);assert.equal(second.status,200);assert.equal((await second.json()).town.revision,2);
  const history=await (await request(cookieA,`/api/cloud/towns/${ids.town}/history`)).json();assert.equal(history.backups[0].id,'previous');
  const restore=await request(cookieA,`/api/cloud/towns/${ids.town}/restore`,'POST',{headers:{'content-type':'application/json'},body:JSON.stringify({backupId:'previous',baseRevision:2,saveId:ids.two})});
  assert.equal(restore.status,200,await restore.clone().text());assert.equal((await restore.json()).town.revision,3);
  const restored=await request(cookieA,`/api/cloud/towns/${ids.town}`);assert.deepEqual(Buffer.from(await restored.arrayBuffer()),bytes,'restore serves prior gzip bytes');
  assert.equal((await request(cookieB,`/api/cloud/towns/${ids.town}/restore`,'POST',{headers:{'content-type':'application/json'},body:JSON.stringify({backupId:'previous',baseRevision:1,saveId:ids.two})})).status,404,'another account cannot restore the first account’s history');
  const deleted=await request(cookieA,`/api/cloud/towns/${ids.town}`,'DELETE',{headers:{'if-match':'3'}});assert.equal(deleted.status,200);
  assert.equal((await request(cookieA,`/api/cloud/towns/${ids.town}`)).status,404);
  const listed=await (await request(cookieA,'/api/cloud/towns')).json();
  assert.equal(listed.towns.length,0);assert.equal(listed.recoverable[0].id,ids.town);assert.equal(listed.recoverable[0].revision,4);
  assert.equal((await (await request(cookieA,`/api/cloud/towns/${ids.town}/history`)).json()).backups[0].id,'previous');
 }finally{await f.mf.dispose();}
});
test('cloud save rejects oversized and invalid streamed gzip, daily alarm writes recoverable catalog', {timeout:30000},async()=>{
 const f=await setup();try {
  const {request,save,cookieA,bucket,mf}=f;
  assert.equal((await save(cookieA,ids.town,0,ids.one,new Uint8Array(5*1024*1024+1))).status,413);
  assert.equal((await save(cookieA,ids.town,0,ids.one,new Uint8Array([1,2,3]))).status,400);
  assert.equal((await save(cookieA,ids.town,0,ids.one)).status,200);
  const ns=await mf.getDurableObjectNamespace('ACCOUNT_STATE');
  const stub=ns.get(ns.idFromName('a'.repeat(64)));
  assert.equal((await stub.fetch('https://state.internal/test-alarm')).status,200);
  const snapshots=await bucket.list({prefix:'cloud-saves/v1/'});
  const catalog=snapshots.objects.find(o=>o.key.includes('/catalog/'));
  assert.ok(catalog,'daily recovery catalog exists in private R2');
  const record=await (await bucket.get(catalog.key)).json();
  assert.equal(record.towns[ids.town].revision,1);
  assert.equal((await stub.fetch('https://state.internal/test-alarm')).status,200);
  const after=await bucket.list({prefix:'cloud-saves/v1/'});
  assert.equal(after.objects.filter(o=>o.key.includes('/catalog/')).length,1,'same-day alarm does not grow backups');
  assert.equal((await request(cookieA,`/api/cloud/towns/${ids.town}/history`)).status,200);
  assert.equal((await stub.fetch('https://state.internal/test-clear')).status,200);
  assert.equal((await (await request(cookieA,'/api/cloud/towns')).json()).towns.length,0);
  const recovered=await request(cookieA,'/api/cloud/recover','POST');
  assert.equal(recovered.status,200,await recovered.clone().text());assert.equal((await recovered.json()).recovered,1);
  assert.equal((await request(cookieA,'/api/cloud/recover','POST')).status,409);
  assert.deepEqual(Buffer.from(await (await request(cookieA,`/api/cloud/towns/${ids.town}`)).arrayBuffer()),bytes);
  assert.equal((await stub.fetch('https://state.internal/test-fill-rate')).status,200);
  assert.equal((await save(cookieA,ids.town,1,ids.two)).status,429,'daily account cap is enforced in SQLite');
  assert.equal((await stub.fetch('https://state.internal/test-clear')).status,200);
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  await bucket.put(catalog.key.replace(/\d{4}-\d{2}-\d{2}\.json$/,`${tomorrow}.json`),JSON.stringify({date:tomorrow,createdAt:new Date().toISOString(),towns:{}}));
  const newest=await request(cookieA,'/api/cloud/recover','POST');assert.equal(newest.status,200);assert.equal((await newest.json()).recovered,0,'latest valid empty catalog must not resurrect a deleted town');
 }finally{await f.mf.dispose();}
});
