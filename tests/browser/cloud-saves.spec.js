import {test, expect} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.route('**/cloud-test.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Cloud save tests</title>'}));
  await page.goto('/cloud-test.html');
});

test('IndexedDB download CAS preserves concurrent local progress and cloud links',async({page})=>{
  const result=await page.evaluate(async()=>{
    const {createSaveStore}=await import('/src/save-store.js');
    const store=createSaveStore({legacyKey:'cloud-test'});
    await store.save('town','first',{name:'First'});
    const before=await store.read('town');
    await Promise.all([store.updateCloud('town','account',{id:'remote',revision:1}),store.save('town','new progress',{name:'New'})]);
    const current=await store.read('town');
    const rejected=await store.installCloud('town',before.blob,{name:'Cloud'},'account',{id:'remote',revision:2},before.meta.localRevision);
    const kept=await store.load('town');
    const accepted=await store.installCloud('town',before.blob,{name:'Cloud'},'account',{id:'remote',revision:2},current.meta.localRevision);
    const installed=await store.read('town');
    return {rejected,kept,accepted,cloudLink:current.meta.cloud.account.revision,installed:await store.load('town'),clean:installed.meta.localRevision===installed.meta.cloud.account.cleanRevision};
  });
  expect(result).toEqual({rejected:false,kept:'new progress',accepted:true,cloudLink:1,installed:'first',clean:true});
});

test('real gzip and IndexedDB sync, conflict controls and deleted-town recovery listing',async({page})=>{
  await page.evaluate(async()=>{
    const {createSaveStore,metaFromSave}=await import('/src/save-store.js');
    const {createCloudSaves}=await import('/src/cloud-saves.js');
    const {createCloudTowns}=await import('/src/ui/menu/cloud-towns.js');
    const store=createSaveStore({legacyKey:'cloud-test'});
    const raw=JSON.stringify({version:1,townName:'Oakstead',time:{year:2,month:3},people:[]});
    await store.save('local',raw,metaFromSave(raw));
    const remote=new Map();let recoverable=[];
    const cloud=createCloudSaves({saves:store,session:()=>({authenticated:true,cloudAccountId:'scope'}),fetcher:async(path,options)=>{
      if(options.headers['X-Cloud-Account']!=='scope')throw new Error('Missing scope');
      const id=path.split('/')[4],method=options.method||'GET';
      if(method==='PUT') {const old=remote.get(id);if(Number(options.headers['If-Match'])!==(old?.meta.revision||0))return Response.json({code:'conflict',error:'Town changed'},{status:409});const meta={...JSON.parse(decodeURIComponent(options.headers['X-Town-Meta'])),id,revision:(old?.meta.revision||0)+1,saveId:options.headers['X-Save-Id'],savedAt:new Date().toISOString()};remote.set(id,{meta,blob:options.body});return Response.json({town:meta});}
      if(method==='DELETE'){const old=remote.get(id);recoverable=[{...old.meta,revision:old.meta.revision+1}];remote.delete(id);return Response.json({deleted:true});}
      if(id){const row=remote.get(id);return new Response(row.blob,{headers:{'X-Town-Meta':encodeURIComponent(JSON.stringify(row.meta))}});}
      return Response.json({towns:[...remote.values()].map(v=>v.meta),recoverable,limit:1,maxBytes:16*1024*1024});
    }});
    await cloud.flush('local');
    const id=(await store.read('local')).meta.cloud.scope.id;
    const row=remote.get(id);row.meta.revision++;row.meta.name='Cloud Oakstead';
    row.blob=new Blob([await new Response(new Blob([raw.replace('Oakstead','Cloud Oakstead')]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()]);
    await store.save('local',raw.replace('Oakstead','Device Oakstead'),{...metaFromSave(raw),name:'Device Oakstead'});
    try{await cloud.flush('local');}catch{}
    const panel=createCloudTowns({cloud,saves:store,selected:()=>({id:'local'}),play:()=>{},changed:async()=>{},openAccount:()=>{}});
    document.body.append(panel.el);
    window.testCloud={cloud,store,id};
  });
  await expect(page.getByRole('button',{name:'Use cloud copy',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Use cloud copy',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('earlier copy was kept');
  const copies=await page.evaluate(async()=>{const {store}=window.testCloud;const rows=await store.list();return Promise.all(rows.map(async row=>({name:row.name,raw:await store.load(row.id)})));});
  expect(copies).toHaveLength(2);
  expect(copies.find(x=>x.name.endsWith('(device copy)')).raw).toContain('Device Oakstead');
  expect(copies.find(x=>x.name==='Cloud Oakstead').raw).toContain('Cloud Oakstead');
  await page.getByRole('button',{name:'Remove cloud copy',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await expect(page.getByText('Recently removed',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Recovery history',exact:true})).toBeVisible();
  expect(await page.evaluate(async()=> (await window.testCloud.store.list()).length)).toBe(2);
});

test('authenticated Manage Towns shows cloud recovery on a phone without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/session',route=>route.fulfill({json:{authenticated:true,tier:'free',email:'player@example.test',cloudAccountId:'scope',billingEnabled:false}}));
  await page.route('**/api/cloud/towns',route=>route.fulfill({json:{towns:[{id:'11111111-1111-4111-8111-111111111111',name:'Oakstead',year:8,people:85,savedAt:new Date().toISOString(),revision:2}],recoverable:[{id:'22222222-2222-4222-8222-222222222222',name:'Old Birchstead',revision:3}],limit:1,maxBytes:16*1024*1024}}));
  await page.goto('/?renderer=stub');
  await page.locator('[data-go="play"]').click();
  await page.locator('[data-go="towns"]').click();
  await expect(page.locator('.mm-cloud-town')).toHaveCount(2);
  await expect(page.locator('.mm-cloud h3')).toContainText('1 / 1 towns');
  await expect(page.getByRole('button',{name:'Recovery history',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/hearthvale-cloud-menu-phone.png',fullPage:true});
});
