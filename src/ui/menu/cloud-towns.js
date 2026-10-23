import {esc} from '../dom.js';

export function createCloudTowns({cloud, saves, selected, play, changed, openAccount}) {
  const el=document.createElement('section');el.className='mm-cloud';el.setAttribute('aria-label','Cloud saves');
  let disposed=false, ticket=0, busy=false, message='', history=null, confirm=null;
  const button=(act,text,attrs='')=>`<button type="button" class="btn btn-secondary" data-cloud-act="${act}" ${attrs}${busy?' disabled':''}>${text}</button>`;
  async function render() {
    if(disposed)return;
    const mine=++ticket;
    if(!cloud.enabled()) {el.innerHTML='<h3>Cloud saves</h3><p class="mm-small">Sign in for one cloud town, or keep up to ten with Plus. Local towns stay on this device.</p>'+button('signin','Sign in');return;}
    const locals=await saves.list();if(disposed||mine!==ticket)return;
    const {towns,limit,recoverable=[]}=cloud.snapshot();
    const current=locals.find(t=>t.id===selected()?.id), binding=cloud.link(current), state=cloud.status(current?.id);
    const conflict=state?.state==='conflict';
    el.innerHTML=`<h3>Cloud saves <small>${towns.length} / ${limit} towns</small></h3>
      <p class="mm-small">Automatic saves while you play. Previous saves and seven daily recovery points do not use extra town slots.</p>
      ${current?`<div class="mm-cloud-local"><p>${esc(current.name||'Hearthvale')}: ${esc(state?.message||(binding?.revision?'Linked to your cloud save.':'Saved on this device. A free cloud slot will be used when you play.'))}</p><div class="btn-row">${conflict?button('use-cloud','Use cloud copy')+button('keep-local','Keep this device’s copy'):button('sync','Sync this town now')}</div>${conflict?'<p class="mm-small">Using the cloud copy keeps this device’s progress as a separate local town.</p>':''}</div>`:''}
      <div class="mm-cloud-list">${towns.map(t=>`<article class="mm-cloud-town"><div><b>${esc(t.name)}</b><p class="mm-small">Year ${Number(t.year)||0} · ${Number(t.people)||0} people · Saved ${esc(new Date(t.savedAt).toLocaleString())}</p></div><div class="btn-row">${button('play','Play',`data-cloud-id="${esc(t.id)}" `)}${button('history','Backups',`data-cloud-id="${esc(t.id)}" `)}${button('remove','Remove cloud copy',`data-cloud-id="${esc(t.id)}" `)}</div></article>`).join('')||'<p class="mm-small">No cloud towns yet.</p>'}</div>
      ${recoverable.length?`<div class="mm-cloud-deleted"><h4>Recently removed</h4><p class="mm-small">Recovery copies are retained for up to seven days. Restoring a town uses a cloud slot.</p>${recoverable.map(t=>`<article class="mm-cloud-town"><b>${esc(t.name)}</b>${button('history','Recovery history',`data-cloud-id="${esc(t.id)}" `)}</article>`).join('')}</div>`:''}
      ${history?`<div class="mm-cloud-history"><h4>Recovery history</h4>${history.rows.length?history.rows.map(b=>button('restore',esc(b.id==='previous'?'Previous save':b.id),`data-cloud-id="${esc(history.id)}" data-backup="${esc(b.id)}" `)).join(' '):'<p>No earlier saves yet. Daily recovery points appear after the first scheduled backup.</p>'}${button('close-history','Close history')}</div>`:''}
      ${confirm?`<div class="mm-cloud-confirm" role="alert"><p>${confirm.type==='remove'?'Remove this cloud copy? Local copies stay on their devices.':confirm.type==='restore'?'Restore this backup? Any linked local town will first be preserved as a separate device copy.':'Replace the current cloud save with this device’s progress? The previous cloud save remains in recovery history.'}</p><div class="btn-row">${button('confirm','Confirm')}${button('cancel','Cancel')}</div></div>`:''}
      <p class="mm-small" role="status">${esc(message)}</p>`;
    el.setAttribute('aria-busy',String(busy));
  }
  async function run(fn) {
    if(busy)return;busy=true;message='';await render();
    try{await fn();await changed();}catch(error){message=error.message||'Cloud saves are unavailable. Your local towns are safe.';}
    finally{busy=false;await render();}
  }
  el.addEventListener('click',async event=>{
    const btn=event.target.closest('[data-cloud-act]');if(!btn||busy)return;
    const act=btn.dataset.cloudAct,id=btn.dataset.cloudId,local=selected()?.id;
    if(act==='signin')return openAccount?.();
    if(act==='play')return play(id);
    if(act==='sync')return run(async()=>{await cloud.resume(local);message='Town saved to cloud.';});
    if(act==='use-cloud')return run(async()=>{await cloud.useCloud(local);message='Cloud copy downloaded. This device’s earlier copy was kept.';});
    if(act==='keep-local'){confirm={type:'keep',local};return render();}
    if(act==='history')return run(async()=>{history={id,rows:await cloud.history(id)};});
    if(act==='close-history'){history=null;return render();}
    if(act==='remove'||act==='restore'){confirm={type:act,id,backup:btn.dataset.backup};return render();}
    if(act==='cancel'){confirm=null;return render();}
    if(act==='confirm') {const action=confirm;confirm=null;return run(async()=>{if(action.type==='remove'){await cloud.remove(action.id);history=null;message='Cloud copy removed. Local copies are unchanged.';}else if(action.type==='restore'){await cloud.restore(action.id,action.backup);history=null;message='Backup restored. Your previous local copy was kept.';}else {await cloud.keepLocal(action.local);message='This device’s progress is now saved in the cloud.';}});}
  });
  const unsubscribe=cloud.subscribe(()=>render());
  render();
  cloud.refresh().catch(error=>{message=error.message;render();});
  return {el,render,destroy(){disposed=true;unsubscribe();}};
}
