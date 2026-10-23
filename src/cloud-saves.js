import {newSlotId, metaFromSave} from './save-store.js';

const INTERVAL = 120000;
const MAX_RAW = 30 * 1024 * 1024;
const hash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
const problem = (code, message) => Object.assign(new Error(message), {code});
const emptyCatalog = (limit=1) => ({towns:[],recoverable:[],limit,maxBytes:5*1024*1024});

export async function unpackCloudSave(blob) {
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let length = 0; const chunks = [];
  try {
    for (;;) { const {done,value}=await reader.read(); if(done)break; length+=value.byteLength; if(length>MAX_RAW)throw problem('size','This cloud save is too large to open.'); chunks.push(value); }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  const raw = await new Blob(chunks).text();
  const data = JSON.parse(raw);
  if (!data || !Number.isInteger(data.version) || !data.time || !Array.isArray(data.people)) throw problem('invalid','This cloud save could not be read. Your local town is unchanged.');
  return raw;
}

// Local writes always finish first. Each operation is bound to the account that
// started it, including timers, network requests and local link updates.
export function createCloudSaves({saves, session, fetcher = (...a)=>fetch(...a), now = Date.now, onStatus = ()=>{}, operations = {getItem:key=>globalThis.localStorage.getItem(key),setItem:(key,value)=>globalThis.localStorage.setItem(key,value),removeItem:key=>globalThis.localStorage.removeItem(key)}}) {
  const listeners = new Set(), states = new Map(), timers = new Map(), attempts = new Map();
  let catalog = emptyCatalog(), catalogAccount = null, chain = Promise.resolve();
  const account = () => session()?.authenticated ? session().cloudAccountId ?? null : null;
  const link = (meta, scope=account()) => meta?.cloud?.[scope] ?? null;
  const guard = scope => { if(!scope || scope!==account())throw problem('account_changed','Your account changed. Please try again.'); };
  const emit = () => { for(const fn of listeners)fn(); };
  const status = (id, state, message, scope) => { guard(scope); states.set(scope+':'+id,{state,message});onStatus({id,state,message});emit(); };
  const serial = fn => { const scope=account();const run=chain.then(()=>{guard(scope);return fn(scope);});chain=run.catch(()=>{});return run; };
  const update = (id,scope,patch) => {guard(scope);return saves.updateCloud(id,scope,patch);};
  async function request(path, options = {}, scope) {
    guard(scope);
    const response=await fetcher('/api/cloud/towns'+path,{credentials:'same-origin',cache:'no-store',...options,headers:{...options.headers,'X-Cloud-Account':scope},signal:AbortSignal.timeout(20000)});
    guard(scope);
    if(!response.ok){const body=await response.json().catch(()=>({}));throw Object.assign(problem(body.code||String(response.status),body.error||'Cloud saves are unavailable. Your local town is safe.'),{town:body.town,httpStatus:response.status});}
    return response;
  }
  async function refresh(scope=account()) {
    if(!scope){catalog=emptyCatalog();catalogAccount=null;return catalog;}
    const result=await (await request('',{},scope)).json();guard(scope);
    catalog=result;catalogAccount=scope;emit();return result;
  }
  async function download(id,scope) {
    const response=await request('/'+encodeURIComponent(id),{},scope);
    const meta=JSON.parse(decodeURIComponent(response.headers.get('X-Town-Meta')||''));
    const blob=await response.blob();
    if(blob.size>5*1024*1024)throw problem('size','This cloud save is too large to open.');
    const raw=await unpackCloudSave(blob), digest=await hash(blob);guard(scope);
    return {blob,raw,meta,hash:digest};
  }
  async function install(id, remote, scope, expectedRevision=null) {
    guard(scope);const localId=id||newSlotId();
    const meta={...metaFromSave(remote.raw),name:remote.meta.name};
    const ok=await saves.installCloud(localId,remote.blob,meta,scope,{id:remote.meta.id,revision:remote.meta.revision,saveId:remote.meta.saveId,hash:remote.hash,name:meta.name,pending:null,restorePending:null,paused:false},expectedRevision);
    guard(scope);
    if(!ok)throw problem('storage','The local town changed or this device could not save the download. Your local town has been kept; try again.');
    status(localId,'synced','Saved to cloud.',scope);return localId;
  }
  async function recoverLink(id, current, remote, scope) {
    let binding=link(current.meta,scope);
    if(remote && binding?.pending?.saveId===remote.saveId) {
      await update(id,scope,{revision:remote.revision,saveId:remote.saveId,hash:binding.pending.hash,name:binding.pending.name,cleanRevision:binding.pending.localRevision,pending:null});
      current=await saves.read(id);guard(scope);binding=link(current?.meta,scope);
    }
    return {current,binding};
  }
  async function sync(id,scope) {
    guard(scope);attempts.set(scope+':'+id,now());
    let current=await saves.read(id);guard(scope);if(!current)return;
    let binding=link(current.meta,scope);if(binding?.paused)return;
    try {
      status(id,'syncing','Saving to cloud…',scope);
      const listing=await refresh(scope);
      if(!binding?.id){
        binding={id:crypto.randomUUID(),revision:0};
        await update(id,scope,binding);current=await saves.read(id);guard(scope);
      }
      if(!current)return;
      const remote=listing.towns.find(t=>t.id===binding.id);
      ({current,binding}=await recoverLink(id,current,remote,scope));
      if(!current || !binding)return;
      if((remote?.revision??0)!==binding.revision)throw problem('conflict','This town changed on another device. Resolve it in Play → Manage Towns.');
      const payloadHash=await hash(current.blob);guard(scope);
      if(remote&&payloadHash===binding.hash&&current.meta.name===binding.name){await update(id,scope,{cleanRevision:current.meta.localRevision});status(id,'synced','Saved to cloud.',scope);return;}
      if(current.blob.size>listing.maxBytes)throw problem('size','This town exceeds the cloud-save size limit. Its local save is safe.');
      const saveId=binding.pending?.hash===payloadHash&&binding.pending.name===current.meta.name?binding.pending.saveId:crypto.randomUUID();
      const pending={saveId,hash:payloadHash,name:current.meta.name,localRevision:current.meta.localRevision};
      await update(id,scope,{pending});
      const meta={};for(const key of ['name','year','month','people','era','seed','terrain','archetype'])if(current.meta[key]!=null)meta[key]=['era','seed','terrain','archetype'].includes(key)?String(current.meta[key]):current.meta[key];
      const result=await (await request('/'+binding.id,{method:'PUT',headers:{'Content-Type':'application/gzip','If-Match':String(binding.revision),'X-Save-Id':saveId,'X-Town-Meta':encodeURIComponent(JSON.stringify(meta))},body:current.blob},scope)).json();
      await update(id,scope,{revision:result.town.revision,saveId,hash:payloadHash,name:current.meta.name,cleanRevision:current.meta.localRevision,pending:null});guard(scope);
      catalog.towns=[...catalog.towns.filter(t=>t.id!==binding.id),result.town];
      status(id,'synced','Saved to cloud.',scope);return result.town;
    }catch(error){if(scope===account())status(id,error.code==='conflict'?'conflict':error.code==='limit'?'limit':'offline',error.message||'Cloud saves are unavailable. Your local town is safe.',scope);throw error;}
  }
  async function prepare(id,scope) {
    const current=await saves.read(id);guard(scope);const binding=link(current?.meta,scope);
    if(!binding?.revision||binding.paused)return id;
    let listing;
    try{listing=await refresh(scope);}catch(error){guard(scope);return id;} // Offline play retains its original CAS revision.
    const remote=listing.towns.find(t=>t.id===binding.id);
    const recovered=await recoverLink(id,current,remote,scope);
    if(!remote){status(id,'offline','This cloud copy was removed. The local town is safe.',scope);return id;}
    if(remote.revision===recovered.binding.revision)return id;
    if(await hash(recovered.current.blob)!==recovered.binding.hash || recovered.current.meta.name!==recovered.binding.name){status(id,'conflict','This town changed on both devices. Choose a copy in Manage Towns.',scope);throw problem('conflict','This town changed on both devices. Open Play → Manage Towns to choose a copy.');}
    return install(id,await download(remote.id,scope),scope,recovered.current.meta.localRevision??null);
  }
  async function preserveLocal(id,scope) {
    const current=await saves.read(id);guard(scope);if(!current)return null;
    const copy=newSlotId();const raw=await unpackCloudSave(current.blob);guard(scope);
    const ok=await saves.save(copy,raw,{...metaFromSave(raw),name:(current.meta.name||'Hearthvale')+' (device copy)'});
    if(!ok)throw problem('storage','Could not preserve this device’s copy. Export it before replacing it.');
    await update(copy,scope,{paused:true});return current.meta.localRevision??null;
  }
  const api={
    enabled:()=>Boolean(account()),link,refresh,
    snapshot:()=>catalogAccount===account()?catalog:emptyCatalog(session()?.tier==='paid'?10:1),
    status:id=>states.get(account()+':'+id),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    queue(id){const scope=account();if(!scope)return;const key=scope+':'+id;if(timers.has(key))return;const delay=Math.max(0,INTERVAL-(now()-(attempts.get(key)||0)));timers.set(key,setTimeout(()=>{timers.delete(key);if(account()===scope)serial(s=>sync(id,s)).catch(()=>{});},delay));},
    flush(id){if(!account())return Promise.resolve();const key=account()+':'+id;clearTimeout(timers.get(key));timers.delete(key);return serial(scope=>sync(id,scope));},
    prepare:id=>account()?serial(scope=>prepare(id,scope)):Promise.resolve(id),
    open:cloudId=>serial(async scope=>{const existing=(await saves.list()).find(t=>link(t,scope)?.id===cloudId);guard(scope);return existing?prepare(existing.id,scope):install(null,await download(cloudId,scope),scope);}),
    useCloud:id=>serial(async scope=>{const current=await saves.read(id),binding=link(current?.meta,scope);guard(scope);if(!binding?.id)throw problem('missing','No cloud copy is linked.');const remote=await download(binding.id,scope);const revision=await preserveLocal(id,scope);return install(id,remote,scope,revision);}),
    keepLocal:id=>serial(async scope=>{const listing=await refresh(scope);const current=await saves.read(id),binding=link(current?.meta,scope);const remote=listing.towns.find(t=>t.id===binding?.id);if(!remote)throw problem('missing','The cloud copy is no longer available.');await update(id,scope,{revision:remote.revision,hash:null,pending:null,paused:false});return sync(id,scope);}),
    resume:id=>serial(async scope=>{const current=await saves.read(id),binding=link(current?.meta,scope);if(binding?.paused&&binding.id){const listing=await refresh(scope);if(!listing.towns.some(t=>t.id===binding.id))await update(id,scope,{id:crypto.randomUUID(),revision:0,hash:null,pending:null});}await update(id,scope,{paused:false});return sync(id,scope);}),
    history:id=>serial(async scope=>(await (await request('/'+id+'/history',{},scope)).json()).backups),
    restore:(id,backupId)=>serial(async scope=>{
      const listing=await refresh(scope), remote=[...listing.towns,...(listing.recoverable||[])].find(t=>t.id===id);
      if(!remote)throw problem('missing','Cloud town not found.');
      const local=(await saves.list()).find(t=>link(t,scope)?.id===id);guard(scope);
      // A stable persisted ID makes retrying a lost response safe, including
      // the moving "previous" target. This journal contains no town data.
      const key='hearthvale-cloud-restore:'+scope+':'+id;
      let pending;
      try {
        pending=JSON.parse(operations?.getItem(key)||'null')||{backupId,baseRevision:remote.revision,saveId:crypto.randomUUID()};
        if(pending.backupId!==backupId)throw problem('pending','Finish the pending restore before choosing another backup.');
        if(!operations)throw new Error('No operation storage');
        operations.setItem(key,JSON.stringify(pending));
      }catch(error){if(error.code==='pending')throw error;throw problem('storage','This device could not safely start recovery. Allow local storage and try again.');}
      const revision=local?await preserveLocal(local.id,scope):null;
      try { await request('/'+id+'/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending)},scope); }
      catch(error){if([400,404,409,413,429].includes(error.httpStatus))operations.removeItem(key);throw error;}
      await refresh(scope);
      const installed=await install(local?.id,await download(id,scope),scope,revision);
      operations.removeItem(key);return installed;
    }),
    remove:id=>serial(async scope=>{const listing=await refresh(scope);const remote=listing.towns.find(t=>t.id===id);if(!remote)return;await request('/'+id,{method:'DELETE',headers:{'If-Match':String(remote.revision)}},scope);for(const local of await saves.list())if(link(local,scope)?.id===id)await update(local.id,scope,{paused:true});await refresh(scope);}),
  };
  return api;
}
