// Private R2 cloud saves. All entry points run inside one account's Durable Object.
const DAY = 86400000;
export const MAX_CLOUD_BYTES = 5 * 1024 * 1024;
const MAX_INFLATED_BYTES = 30 * 1024 * 1024;
const MAX_SAVES_PER_DAY = 800;
const MAX_UPLOAD_BYTES_PER_DAY = 512 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PREFIX = 'cloud-saves/v1/';
const response = (status, value) => Response.json(value, {status, headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const fail = (status, code, error) => response(status, {error, code});
const keyFor = (account, town, revision, saveId) => `${PREFIX}${account}/towns/${town}/${revision}-${saveId}.gz`;
const catalogKey = (account, date) => `${PREFIX}${account}/catalog/${date}.json`;
const publicTown = town => { if (!town) return null; const {key, previous, deleted, ...safe} = town; return safe; };
const today = now => new Date(now).toISOString().slice(0,10);
const nextAlarm = now => Math.floor((now - 3 * 3600000) / DAY + 1) * DAY + 3 * 3600000;
const validMeta = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const {name, year, month, people, era, seed, terrain, archetype} = input;
  if (typeof name !== 'string' || name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  if (![year, month, people].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000000)) return null;
  if (month > 12) return null;
  const result = {name, year, month, people};
  for (const [key, value] of Object.entries({era, seed, terrain, archetype})) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    result[key] = value;
  }
  return result;
};
function parseMetadata(header) {
  if (!header || header.length > 2048) return null;
  try { return validMeta(JSON.parse(decodeURIComponent(header))); } catch { return null; }
}
function revision(header) {
  if (!/^(0|[1-9]\d{0,9})$/.test(header || '')) return null;
  const n = Number(header); return Number.isSafeInteger(n) ? n : null;
}
function saveId(header) { return ID.test(header || '') ? header.toLowerCase() : null; }
async function boundedBytes(request, max) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) return null;
  const reader = request.body?.getReader(); if (!reader) return null;
  const chunks=[]; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size); let at=0;
  for (const chunk of chunks) { bytes.set(chunk,at); at+=chunk.byteLength; }
  return bytes;
}
async function validGzip(bytes) {
  if (bytes.length < 18 || bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8) return false;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader=stream.getReader(); let size=0;
    try { for (;;) { const {done,value}=await reader.read(); if (done) break; size+=value.byteLength; if(size>MAX_INFLATED_BYTES) {await reader.cancel();return false;} } }
    finally {reader.releaseLock();}
    return true;
  } catch { return false; }
}
function catalog(object) { return object.get('cloud:catalog') || {towns:{}, receipts:{}, writes:{}, uploadBytes:{}}; }
function snapshots(object) { return object.get('cloud:snapshots') || []; }
async function schedule(object) {
  if (!object.get('cloud:account')) object.put('cloud:account',object.accountId);
  const at=nextAlarm(Date.now());
  const current=await object.ctx.storage.getAlarm();
  if (current === null || current > at) await object.ctx.storage.setAlarm(at);
}
function receipt(cat, townId, token) { return cat.receipts[townId]?.find(item=>item.saveId===token)?.town; }
function addReceipt(cat, townId, town) {
  cat.receipts[townId] = [{saveId:town.saveId,town:publicTown(town)},...(cat.receipts[townId] || []).filter(item=>item.saveId!==town.saveId)].slice(0,32);
}
function rate(cat, now, bytes=0) {
  const day=today(now), count=cat.writes[day] || 0, uploaded=cat.uploadBytes?.[day] || 0;
  if(count>=MAX_SAVES_PER_DAY || uploaded+bytes>MAX_UPLOAD_BYTES_PER_DAY) return false;
  cat.writes={[day]:count+1};cat.uploadBytes={[day]:uploaded+bytes};return true;
}
async function store(object, cat) { await schedule(object); object.put('cloud:catalog',cat); }
async function ensureObject(object, town) {
  const blob=await object.env.STUDENT_ARTIFACTS.get(town.key);
  return blob;
}
async function listHistory(object, id) {
  const cat=catalog(object), town=cat.towns[id], backups=[];
  if (town?.previous) backups.push({...publicTown(town.previous),id:'previous',townId:id,createdAt:town.previous.savedAt});
  for(const snapshot of snapshots(object).slice().reverse()) {
    const value=snapshot.towns[id];
    if(value) backups.push({...publicTown(value),id:snapshot.date,townId:id,createdAt:snapshot.createdAt});
  }
  return response(200,{backups});
}
async function recover(object) {
  const existing=catalog(object);
  if(Object.keys(existing.towns).length) return fail(409,'not_empty','Cloud catalog already exists');
  const bucket=object.env.STUDENT_ARTIFACTS, prefix=`${PREFIX}${object.accountId}/catalog/`;
  const page=await bucket.list({prefix,limit:1000});
  const keys=page.objects.map(item=>item.key).filter(key=>DATE.test(key.slice(prefix.length,-5)) && key.endsWith('.json')).sort().reverse().slice(0,7);
  const entries=[];
  for(const key of keys) {
    const blob=await bucket.get(key);if(!blob) continue;
    let entry;try {entry=await blob.json();}catch{continue;}
    if(entry?.date!==key.slice(prefix.length,-5)||!entry.towns||typeof entry.towns!=='object'||Array.isArray(entry.towns)) continue;
    let valid=true;
    for(const [id,town] of Object.entries(entry.towns)) {
      if(!ID.test(id)||town?.id!==id||!town.key?.startsWith(`${PREFIX}${object.accountId}/towns/${id}/`)||!await bucket.head(town.key)) {valid=false;break;}
      if(town.previous) {
        if(!town.previous.key?.startsWith(`${PREFIX}${object.accountId}/towns/${id}/`)||!await bucket.head(town.previous.key)) delete town.previous;
      }
    }
    if(valid) entries.push(entry);
  }
  if(!entries.length) return fail(404,'not_found','No verified backup catalog found');
  const latest=entries[0], recovered={towns:latest.towns,receipts:{},writes:{},uploadBytes:{}};
  await schedule(object);
  object.put('cloud:catalog',recovered);
  object.put('cloud:snapshots',entries.reverse());
  return response(200,{recovered:Object.keys(latest.towns).length,from:latest.date});
}
async function backup(object) {
  const now=Date.now(), date=today(now), cat=catalog(object), prior=snapshots(object);
  if(prior.some(entry=>entry.date===date)) {await object.ctx.storage.setAlarm(nextAlarm(now));return;}
  const towns={};
  for(const [id,town] of Object.entries(cat.towns)) if(!town.deleted) towns[id]=town;
  let entry={date,createdAt:new Date(now).toISOString(),towns};
  // The first successful R2 write fixes this day's recovery point, even if
  // SQLite bookkeeping fails and the alarm retries after new town progress.
  const key=catalogKey(object.accountId,date);
  const created=await object.env.STUDENT_ARTIFACTS.put(key, JSON.stringify(entry), {
    onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}
  });
  if(!created) {
    const existing=await object.env.STUDENT_ARTIFACTS.get(key);
    if(!existing) throw new Error('Cloud backup catalog unavailable');
    entry=await existing.json();
    if(entry?.date!==date || !entry.towns || typeof entry.towns!=='object' || Array.isArray(entry.towns)) throw new Error('Cloud backup catalog invalid');
  }
  const keep=[...prior,entry].slice(-7);
  object.put('cloud:snapshots',keep);
  let pruned=false;
  for(const [id,town] of Object.entries(cat.towns)) {
    if(town.deleted && Date.parse(town.savedAt)+7*DAY<=now) {
      delete cat.towns[id];delete cat.receipts[id];pruned=true;
    }
  }
  if(pruned) object.put('cloud:catalog',cat);
  await object.ctx.storage.setAlarm(nextAlarm(now));
  const protectedKeys=new Set(keep.map(s=>catalogKey(object.accountId,s.date)));
  for(const town of Object.values(cat.towns)) {
    if(town.key) protectedKeys.add(town.key);
    if(town.previous?.key) protectedKeys.add(town.previous.key);
  }
  for(const snapshot of keep) for(const town of Object.values(snapshot.towns)) {
    if(town.key) protectedKeys.add(town.key);
    if(town.previous?.key) protectedKeys.add(town.previous.key);
  }
  // Bound R2 growth without relying on the browser. A failed sweep is retried tomorrow.
  try {
    let cursor;
    do {
      const page=await object.env.STUDENT_ARTIFACTS.list({prefix:`${PREFIX}${object.accountId}/`,cursor,limit:1000});
      const stale=page.objects.map(item=>item.key).filter(key=>!protectedKeys.has(key));
      if(stale.length) await object.env.STUDENT_ARTIFACTS.delete(stale);
      cursor=page.truncated?page.cursor:undefined;
    } while(cursor);
  } catch {
    console.warn(JSON.stringify({event:'cloud_backup_cleanup_failed',reason:'r2_cleanup_unavailable'}));
  }
}
export async function cloudAlarm(object) {
  object.accountId ||= object.get('cloud:account');
  if (!object.accountId) return;
  try { await backup(object); }
  catch { await object.ctx.storage.setAlarm(Date.now()+3600000); throw new Error('Cloud backup failed'); }
}
export async function handleCloudState(object, request) {
  const url=new URL(request.url), account=url.searchParams.get('account');
  if (!/^[a-f0-9]{64}$/.test(account || '')) return fail(400,'invalid','Invalid account');
  // The Worker selects the Durable Object by signed session ID; never accept an ID from a browser route.
  if (object.accountId && object.accountId !== account) return fail(403,'forbidden','Account mismatch');
  object.accountId=account;
  const part=url.pathname.split('/').filter(Boolean), id=part[1];
  const cat=catalog(object), bucket=object.env.STUDENT_ARTIFACTS;
  if(!bucket) return fail(503,'unavailable','Cloud storage unavailable');
  if(part.length===2 && part[1]==='recover' && request.method==='POST') return recover(object);
  if(part.length===1 && request.method==='GET') {
    return response(200,{towns:Object.values(cat.towns).filter(t=>!t.deleted).map(publicTown).sort((a,b)=>b.savedAt.localeCompare(a.savedAt)),recoverable:Object.values(cat.towns).filter(t=>t.deleted&&t.previous).map(t=>({...publicTown(t),deletedAt:t.savedAt})).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt)),limit:Number(url.searchParams.get('limit'))===10?10:1,maxBytes:MAX_CLOUD_BYTES});
  }
  if(!ID.test(id || '') || part.length>3) return fail(404,'not_found','Town not found');
  const current=cat.towns[id];
  if(part[2]==='history' && part.length===3 && request.method==='GET') return listHistory(object,id);
  if(part[2]==='restore' && part.length===3 && request.method==='POST') {
    const raw=await boundedBytes(request,2048); if(!raw) return fail(413,'size','Request too large');
    let body;try {body=JSON.parse(new TextDecoder().decode(raw));}catch{return fail(400,'invalid','Invalid restore request');}
    if(!body || typeof body!=='object' || Array.isArray(body)) return fail(400,'invalid','Invalid restore request');
    const base=body.baseRevision, token=saveId(body.saveId);
    if(!Number.isSafeInteger(base)||base<0||!token) return fail(400,'invalid','Invalid restore request');
    const seen=receipt(cat,id,token); if(seen) return response(200,{town:seen});
    if((current?.revision || 0)!==base) return response(409,{error:'Town has changed',code:'conflict',town:current&&!current.deleted?publicTown(current):null});
    let source;
    if(body.backupId==='previous') source=current?.previous;
    else if(DATE.test(body.backupId || '')) source=snapshots(object).find(s=>s.date===body.backupId)?.towns[id];
    if(!source) return fail(404,'not_found','Backup not found');
    if(!await ensureObject(object,source)) return fail(503,'unavailable','Backup data unavailable');
    const limit=request.headers.get('x-cloud-limit')==='10'?10:1;
    if((!current||current.deleted) && Object.values(cat.towns).filter(t=>!t.deleted).length>=limit) return fail(409,'limit','Cloud town limit reached');
    const now=Date.now(); if(!rate(cat,now)) return fail(429,'rate','Daily save limit reached');
    const town={...source,revision:base+1,saveId:token,savedAt:new Date(now).toISOString(),previous:current&&!current.deleted?{...current,previous:undefined}:undefined,deleted:false};
    // Immutable source blob remains valid; a restore advances metadata revision.
    cat.towns[id]=town;addReceipt(cat,id,town);await store(object,cat);
    return response(200,{town:publicTown(town)});
  }
  if(part.length!==2) return fail(404,'not_found','Town not found');
  if(request.method==='GET') {
    if(!current || current.deleted) return fail(404,'not_found','Town not found');
    const blob=await ensureObject(object,current);
    if(!blob) return fail(503,'unavailable','Save data unavailable');
    return new Response(blob.body,{headers:{'Content-Type':'application/gzip','Content-Length':String(current.bytes),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Town-Meta':encodeURIComponent(JSON.stringify(publicTown(current)))}});
  }
  if(request.method==='PUT') {
    const base=revision(request.headers.get('if-match')), token=saveId(request.headers.get('x-save-id')), meta=parseMetadata(request.headers.get('x-town-meta'));
    if(base===null||!token||!meta||request.headers.get('content-type')?.split(';')[0]!=='application/gzip') return fail(400,'invalid','Invalid save request');
    const seen=receipt(cat,id,token); if(seen) return response(200,{town:seen});
    if((current?.revision || 0)!==base) return response(409,{error:'Town has changed',code:'conflict',town:current&&!current.deleted?publicTown(current):null});
    const count=Object.values(cat.towns).filter(t=>!t.deleted).length;
    const limit=request.headers.get('x-cloud-limit')==='10'?10:1;
    if((!current || current.deleted) && count>=limit) return fail(409,'limit','Cloud town limit reached');
    const bytes=await boundedBytes(request,MAX_CLOUD_BYTES);
    if(!bytes) return fail(413,'size','Save exceeds 5 MiB compressed');
    if(!await validGzip(bytes)) return fail(400,'invalid','Invalid or oversized gzip save');
    const now=Date.now(); if(!rate(cat,now,bytes.length)) return fail(429,'rate','Daily save limit reached');
    const rev=base+1, key=keyFor(account,id,rev,token);
    try {await bucket.put(key,bytes,{httpMetadata:{contentType:'application/gzip'}});} catch {return fail(503,'unavailable','Save storage unavailable');}
    const town={id,revision:rev,saveId:token,...meta,savedAt:new Date(now).toISOString(),bytes:bytes.length,key,previous:current&&!current.deleted?{...current,previous:undefined}:undefined};
    cat.towns[id]=town;addReceipt(cat,id,town);
    try {await store(object,cat);} catch {try {await bucket.delete(key);}catch{} throw new Error('Cloud catalog unavailable');}
    return response(200,{town:publicTown(town)});
  }
  if(request.method==='DELETE') {
    const base=revision(request.headers.get('if-match'));
    if(base===null) return fail(400,'invalid','If-Match revision required');
    if(!current || current.deleted) return fail(404,'not_found','Town not found');
    if(current.revision!==base) return response(409,{error:'Town has changed',code:'conflict',town:publicTown(current)});
    cat.towns[id]={...current,revision:base+1,deleted:true,previous:{...current,previous:undefined},savedAt:new Date().toISOString()};
    await store(object,cat);
    return response(200,{deleted:true,revision:base+1});
  }
  return fail(405,'method','Method not allowed');
}
