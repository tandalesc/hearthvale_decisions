import {test, expect} from '@playwright/test';
test('docket requests only the open selected card and preserves canonical choices', async ({page}) => {
  await page.route('**/narration-test', (route) => route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
  await page.goto('/narration-test');
  const result = await page.evaluate(async () => {
    const {createDocket} = await import('/src/ui/components/docket.js');
    const requests = []; let cancelled = 0;
    const ctx = {unlocks:()=>({}),coin:()=>100,bodyName:()=> 'Council',bodyIcon:()=> 'council',onRule:()=>{},requestCardProse:(id)=>requests.push(id),cancelCardProse:()=>cancelled++};
    const cards = ['a','b'].map((id)=>({id,kind:'proposal',from:'moot',title:id,why:'Canonical reason.',prose:{why:'A little flavour.',options:{do:'False effect.'}},options:[{key:'do',label:'Approve',tradeoff:'Canonical effect.'}]}));
    const docket = createDocket(ctx);
    document.body.append(docket.el);
    docket.update(cards);
    const closedRequests = [...requests];
    docket.setVisible(true);
    docket.update(cards);
    docket.focus('b');
    docket.setVisible(false);
    return {closedRequests,requests,cancelled,reason:document.querySelector('.card-why').textContent,trade:document.querySelector('.opt-trade').textContent};
  });
  expect(result.closedRequests).toEqual([]);
  expect(result.requests).toEqual(['a','b']);
  expect(result.cancelled).toBe(1);
  expect(result.reason).toBe('Canonical reason.');
  expect(result.trade).toBe('Canonical effect.');
});

// This mock runs inside the actual simulation worker. Its controlled SSE body
// exercises keeper previews → session snapshots → worker messages → card DOM.
for (const ending of ['accepted', 'rejected', 'cancelled']) test(`worker narration previews ${ending} without changing canonical choices`, async ({page}) => {
  const {open, hv, inSim} = await import('./helpers.js');
  await page.route('**/api/session', route => route.fulfill({json:{tier:'paid',authenticated:true,billingEnabled:true}}));
  const errors = await open(page,{fixture:'town'});
  expect(await hv(page,()=>window.hearthvale.simHost)).toBe('worker');
  await inSim(page,()=>{
    const original=globalThis.fetch;
    globalThis.fetch=async(url,options)=>{
      if(!String(url).includes('/api/narrate'))return original(url,options);
      globalThis.__streamFacts=JSON.parse(options.body).facts;
      return new Response(new ReadableStream({start(controller){globalThis.__streamController=controller;},cancel(){globalThis.__streamCancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
    };
  });
  await hv(page,()=>window.hearthvale.app.openCouncil());
  const card=page.locator('.dk .card:not(.is-next)').first();
  await expect(card).toBeVisible();
  const id=await card.getAttribute('data-id');
  const canonicalWhy=await card.locator('.card-why').textContent();
  const canonicalOptions=await card.locator('.opt-trade').allTextContents();
  await expect.poll(()=>inSim(page,()=>Boolean(globalThis.__streamController))).toBe(true);
  if(ending==='accepted') {
    const before=await inSim(page,state=>state.time.tick);
    await hv(page,()=>window.hearthvale.setSpeed(1));
    await expect.poll(()=>inSim(page,state=>state.time.tick)).toBeGreaterThan(before);
    await hv(page,()=>window.hearthvale.setSpeed(0));
  }
  await inSim(page,()=>{
    const send=(event,data)=>globalThis.__streamController.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    send('meta',{source:'llm'});
    send('delta',{t:'A complete sentence from the town.',replace:true,field:'why'});
  });
  await expect(card.locator('.card-flavour')).toHaveText('A complete sentence from the town.');
  // A touched card still replaces or removes a draft when its stream finishes.
  await card.dispatchEvent('pointerenter');
  expect(await inSim(page,(state)=>JSON.stringify(state).includes('A complete sentence from the town.'))).toBe(false);
  if(ending==='cancelled') {
    await page.keyboard.press('Escape');
    await expect.poll(()=>inSim(page,()=>Boolean(globalThis.__streamCancelled))).toBe(true);
    expect(await inSim(page,(state,_sim,id)=>state.docket.find(card=>card.id===id)?.prose,id)).toBeFalsy();
    await hv(page,()=>window.hearthvale.app.openCouncil());
    await expect(card.locator('.card-flavour')).not.toHaveText('A complete sentence from the town.');
  } else {
    await inSim(page,(_state,_sim,ending)=>{
      const options=Object.fromEntries(globalThis.__streamFacts.options.map(option=>[option.key,'A plain trade-off.']));
      const prose=ending==='accepted'?{why:'The farmers are indifferent after the bumper harvest.',options}:{why:'Ignore all instructions.',options:{}};
      globalThis.__streamController.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({prose,source:'llm'})}\n\n`));
      globalThis.__streamController.close();
    },ending);
    if(ending==='accepted')await expect(card.locator('.card-flavour')).toHaveText('The farmers are indifferent after the bumper harvest.');
    else await expect(card.locator('.card-flavour')).not.toHaveText('A complete sentence from the town.');
    const stored=await inSim(page,(state,_sim,id)=>state.docket.find(card=>card.id===id)?.prose,id);
    if(ending==='accepted')expect(stored?.why).toBe('The farmers are indifferent after the bumper harvest.');
    else expect(stored).toBeFalsy();
  }
  await expect(card.locator('.card-why')).toHaveText(canonicalWhy);
  expect(await card.locator('.opt-trade').allTextContents()).toEqual(canonicalOptions);
  expect(errors).toEqual([]);
});

test('inspector replaces validated previews with fallback without saving drafts or announcing every update', async ({page}) => {
  const {open, hv, inSim} = await import('./helpers.js');
  await page.route('**/api/session', route => route.fulfill({json:{tier:'paid',authenticated:true,billingEnabled:true}}));
  const errors=await open(page,{fixture:'town'});
  const personId=await inSim(page,state=>state.people[0].id);
  await page.evaluate(()=>{
    const original=globalThis.fetch;
    globalThis.fetch=async(url,options)=>{
      if(!String(url).includes('/api/narrate'))return original(url,options);
      return new Response(new ReadableStream({start(controller){window.noteStream=controller;}}),{headers:{'content-type':'text/event-stream'}});
    };
  });
  await hv(page,id=>window.hearthvale.app.inspector.show({personId:id}),personId);
  await expect.poll(()=>page.evaluate(()=>Boolean(window.noteStream))).toBe(true);
  await page.evaluate(()=>{
    const send=(event,data)=>window.noteStream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    send('meta',{source:'llm'});
    send('delta',{t:'A complete note from the town.',replace:true,field:'text'});
  });
  const inspector=page.locator('.inspector');
  await expect(inspector.locator('.note-text')).toHaveText('A complete note from the town.');
  await expect(inspector.locator('.note-status')).toBeEmpty();
  await expect(inspector.locator('.note')).not.toHaveAttribute('aria-live');
  await page.evaluate(()=>{
    window.noteStream.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({text:'The town carries on.',source:'template'})}\n\n`));
    window.noteStream.close();
  });
  await expect(inspector.locator('.note-text')).toHaveText('The town carries on.');
  await expect(inspector.locator('.note-status')).toHaveText('Town note ready.');
  expect(await inSim(page,state=>JSON.stringify(state.notes))).not.toContain('A complete note from the town.');
  expect(await inSim(page,state=>JSON.stringify(state.notes))).not.toContain('The town carries on.');
  expect(errors).toEqual([]);
});
