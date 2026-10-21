// Offline desktop long-frame capture. Example:
// node scripts/benchmark-longframes.js --label=current --out=/tmp/hearthvale-longframes
// Add --baseline-ref=fd6e048 to replay the two pre-optimization modules.
// Requires installed Chrome (CHROME_PATH overrides its location). Raw traces are large.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
const opts=Object.fromEntries(process.argv.slice(2).map(x=>x.replace(/^--/,'').split('=')));
const out=resolve(opts.out??`${tmpdir()}/hearthvale-longframes`),label=opts.label??'current',duration=Number(opts.duration??70000);
const chrome=process.env.CHROME_PATH??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
if(chrome&&!existsSync(chrome))throw new Error('Chrome not found; set CHROME_PATH.');
mkdirSync(out,{recursive:true});
const replacements=[];
function once(code,needle,replacement,file){if(!code.includes(needle))throw new Error(`Instrumentation target missing in ${file}: ${needle}`);replacements.push(`${file}:${needle.slice(0,45)}`);return code.replace(needle,replacement);}
function timed(code,statement,name,file){return once(code,statement,`{ const __lpStart=performance.now(); ${statement} globalThis.__lp?.record('${name}',__lpStart,performance.now()); }`,file);}
function instrument(code,file){
 if(file==='src/main.js'){
  code=timed(code,'routes?.tick?.(state);','routes',file);
  code=once(code,'sim.stepTick(state, simOwed * speed * PACE, services);',`{ const __lpStart=performance.now(); const __meta={tickBefore:state.time.tick,jobsBefore:[...(state.time.jobs??[])],simOwed,speed}; const __ticks=sim.stepTick(state, simOwed * speed * PACE, services); globalThis.__lp?.record('simulation',__lpStart,performance.now(),{...__meta,ticks:__ticks,tickAfter:state.time.tick}); }`,file);
  code=timed(code,'view?.sync(state, {now: now / 1000, speed: speed * PACE});','view.sync',file);
 }
 if(file==='src/render/index.js')code=once(code,'cpu[key] = cpu[key] * 0.9 + (now - mark) * 0.1;',`globalThis.__lp?.record('render.'+key,mark,now); cpu[key] = cpu[key] * 0.9 + (now - mark) * 0.1;`,file);
 if(file==='src/sim/index.js'){
  code=once(code,'if (job) runJob(state, ctx, job);',`if (job) { const __lpStart=performance.now(); runJob(state,ctx,job); globalThis.__lp?.record('rollover.'+job,__lpStart,performance.now(),{tick:state.time.tick}); }`,file);
  code=once(code,'if (!ctx.skipPeople) stepPeople(state, ctx, TICK_SECONDS);',`if (!ctx.skipPeople) { const __lpStart=performance.now(); stepPeople(state,ctx,TICK_SECONDS); globalThis.__lp?.record('simulation.people',__lpStart,performance.now(),{tick:state.time.tick}); }`,file);
 }
 if(file==='src/sim/hooks.js')code=once(code,"if (typeof s[phase] === 'function') s[phase](state, ctx);",`if (typeof s[phase] === 'function') { const __lpStart=performance.now(); s[phase](state,ctx); globalThis.__lp?.record('system.'+phase+'.'+s.id,__lpStart,performance.now(),{tick:state.time?.tick}); }`,file);
 if(file==='src/route-planner.js')code=once(code,'const g = navGrid(state, { fresh });',`const __lpStart=performance.now(); const g=navGrid(state,{fresh}); globalThis.__lp?.record('routes.navGrid',__lpStart,performance.now(),{changed:g!==grid,footprintsOnly:g.footprintsOnly,tick:state.time.tick});`,file);
 if(file==='src/sim/serialize.js'){
  code=once(code,'return JSON.stringify(state, (key, value) => {','const __lpStart=performance.now(); const __raw=JSON.stringify(state, (key, value) => {',file);
  code=once(code,'    return value;\n  });\n}',`    return value;\n  });\n globalThis.__lp?.record('save.serialize',__lpStart,performance.now(),{chars:__raw.length,tick:state.time.tick});\n return __raw;\n}`,file);
 }
 if(file==='src/save-store.js'){
  if(code.includes("const stream = new Blob([text]).stream()")) {
  code=once(code,"const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));\n  return new Blob([await new Response(stream).arrayBuffer()], {type: 'application/gzip'});",`const __lpStart=performance.now(); const source=new Blob([text]); const stream=source.stream().pipeThrough(new CompressionStream('gzip')); globalThis.__lp?.record('save.gzip.setup',__lpStart,performance.now(),{sourceBytes:source.size}); const bytes=await new Response(stream).arrayBuffer(); globalThis.__lp?.record('save.gzip.async',__lpStart,performance.now(),{compressedBytes:bytes.byteLength}); return new Blob([bytes],{type:'application/gzip'});`,file);
  } else {
   code=once(code,'const source = new Blob([text]);',`const __lpStart=performance.now(); const source=new Blob([text]); globalThis.__lp?.record('save.gzip.setup',__lpStart,performance.now(),{sourceBytes:source.size});`,file);
   code=once(code,'try { return await gzipInWorker(source); }',`try { const __lpWorkerStart=performance.now(); const blob=await gzipInWorker(source); globalThis.__lp?.record('save.gzip.worker.async',__lpWorkerStart,performance.now(),{compressedBytes:blob.size}); return blob; }`,file);
   code=once(code,'worker.postMessage(source);',`const __lpDispatchStart=performance.now(); worker.postMessage(source); globalThis.__lp?.record('save.worker.dispatch',__lpDispatchStart,performance.now());`,file);
  }

  code=once(code,"await tx(await db(), 'readwrite', (s) => s.put(blob, KEY));",`const __lpStart=performance.now(); await tx(await db(),'readwrite',s=>s.put(blob,KEY)); globalThis.__lp?.record('save.indexedDB.async',__lpStart,performance.now());`,file);
 }
 return code;
}
const targets=new Set(['src/main.js','src/render/index.js','src/sim/index.js','src/sim/hooks.js','src/route-planner.js','src/sim/serialize.js','src/save-store.js']);
const originals={};
if(opts['baseline-ref'])for(const file of ['src/sim/roads.js','src/save-store.js'])originals[file]=execFileSync('git',['show',`${opts['baseline-ref']}:${file}`],{encoding:'utf8'});
const server=await createServer({configFile:resolve('vite.config.js'),logLevel:'error',plugins:[{name:'long-frame-instrumentation',enforce:'pre',load(id){const relative=id.split('?')[0].slice(resolve('.').length+1);return originals[relative]?originals[relative]:null;},transform(code,id){const relative=id.split('?')[0].slice(resolve('.').length+1);return targets.has(relative)?{code:instrument(code,relative),map:null}:null;}}],server:{host:'127.0.0.1',port:5221,strictPort:false,hmr:false,watch:null}});await server.listen();
const base=`http://127.0.0.1:${server.config.server.port}`;
const browser=await chromium.launch({executablePath:chrome,headless:true,args:[...(process.platform==='darwin'?['--use-angle=metal']:[]),'--enable-gpu','--ignore-gpu-blocklist','--enable-webgl','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2});const page=await context.newPage();const errors=[],consoleMessages=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))consoleMessages.push({type:m.type(),text:m.text()});});await page.route('**/api/**',r=>r.fulfill({status:503,body:'{}'}));
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'getBattery',{configurable:true,value:async()=>({charging:true,level:1,addEventListener(){},removeEventListener(){}})});
  localStorage.setItem('hearthvale-model-enabled','false');localStorage.setItem('hearthvale-ui',JSON.stringify({quality:'high',batterySaver:'off',motion:'full',dayCycle:'seasonal',moments:'never',muted:true,peopleShadows:'blob'}));localStorage.setItem('hearthvale-ui-seen',JSON.stringify(['explain:docket','explain:rules','explain:people','explain:chronicle','explain:tensions','explain:overlays','explain:council']));
  const p=window.__lp={active:false,frames:[],events:[],longTasks:[],longAnimationFrames:[],stats:[],current:null,id:0,previousRaf:null,record(name,start,end,meta){if(this.active)this.events.push({name,start,end,duration:end-start,frame:this.current?.id??null,meta});}};
  for(const type of ['longtask','long-animation-frame'])try{new PerformanceObserver(list=>{for(const e of list.getEntries())if(p.active&&e.startTime>=p.started)(type==='longtask'?p.longTasks:p.longAnimationFrames).push(e.toJSON());}).observe({type,buffered:true});}catch{}
  const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>raf(time=>{if(callback.name!=='frame')return callback(time);const start=performance.now();if(p.active)p.current={id:++p.id,start,rafTime:time,rafGap:p.previousRaf===null?null:time-p.previousRaf,tickBefore:window.hearthvale?.state().time.tick};p.previousRaf=time;const value=callback(time);if(p.active){p.current.end=performance.now();p.current.duration=p.current.end-start;p.current.tickAfter=window.hearthvale?.state().time.tick;p.frames.push(p.current);p.current=null;}return value;});
 });
 await page.goto(`${base}/?fixture=city&save=1`);await page.waitForFunction(()=>window.hearthvale?.renderer==='real',null,{timeout:60000});
 await page.evaluate(()=>{const h=window.hearthvale,p=window.__lp;h.world.setQuality('high');h.world.setBatterySaver('off');h.setSpeed(1);const center=h.world.camera.controls.target.clone(),due=h.world.frameDue;let t0=null;h.world.frameDue=(time,dt)=>{t0??=time;h.world.camera.home(center.x+10*Math.sin((time-t0)*.25),center.z+6*Math.sin((time-t0)*.17),120);return due(time,dt);};for(const [object,key,name]of [[h.world,'update','world'],[h.app,'update','ui']]){const fn=object[key];object[key]=function(...args){const t=performance.now();const value=fn.apply(this,args);p.record(name,t,performance.now());return value;};}});
 await page.waitForTimeout(8000);const cdp=await context.newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,blink.user_timing,toplevel,disabled-by-default-v8.gc',transferMode:'ReturnAsStream'});await cdp.send('Profiler.start');
 const initial=await page.evaluate(async()=>{const town=(fn)=>{const h=window.hearthvale;return h.host?.inSim?h.host.inSim(fn):Promise.resolve(fn(h.state()));};const p=window.__lp,s=await town((s)=>({tick:s.time.tick,pop:s.indicators.pop,people:s.people.length,buildings:s.buildings.length}));p.started=performance.now();p.active=true;performance.mark('hearthvale-longframes-start');p.timer=setInterval(async()=>{const v=window.hearthvale.view(),speed=window.hearthvale.speed();p.stats.push({...v,tick:await town((s)=>s.time.tick),speed});},250);return {started:p.started,timeOrigin:performance.timeOrigin,...s,power:window.hearthvale.world.power(),view:window.hearthvale.view()};});
 const snapshot=()=>page.evaluate(()=>{const p=window.__lp;return {initialTime:p.started,frames:p.frames,events:p.events,longTasks:p.longTasks,longAnimationFrames:p.longAnimationFrames,stats:p.stats};});
 await page.waitForTimeout(duration/2);const midway=await page.evaluate(()=>{const p=window.__lp;return {midpointFrames:p.frames.length,longestFrames:[...p.frames].sort((a,b)=>b.duration-a.duration).slice(0,6).map(f=>({...f,stages:p.events.filter(e=>e.frame===f.id&&e.duration>1).map(e=>({name:e.name,duration:e.duration}))})),saveEvents:p.events.filter(e=>e.name.startsWith('save.'))};});writeFileSync(`${out}/${label}-midpoint.json`,JSON.stringify(midway));console.log(JSON.stringify(midway,null,2));
 await page.waitForTimeout(duration/2);await page.evaluate(()=>{window.__lp.active=false;clearInterval(window.__lp.timer);performance.mark('hearthvale-longframes-end');});const data=await snapshot();const {profile}=await cdp.send('Profiler.stop');writeFileSync(`${out}/${label}.cpuprofile`,JSON.stringify(profile));
 const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;let trace='';for(;;){const chunk=await cdp.send('IO.read',{handle:stream});trace+=chunk.data;if(chunk.eof)break;}await cdp.send('IO.close',{handle:stream});writeFileSync(`${out}/${label}.trace.json`,trace);
 const final=await page.evaluate(async()=>{const town=(fn)=>{const h=window.hearthvale;return h.host?.inSim?h.host.inSim(fn):Promise.resolve(fn(h.state()));};return {view:window.hearthvale.view(),power:window.hearthvale.world.power(),tick:await town((s)=>s.time.tick)};});const report={label,duration,baselineRef:opts['baseline-ref']??null,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),initial,final,...data,errors,consoleMessages,instrumentation:replacements};if(data.stats.some(s=>s.saving||s.tier!=='high'||s.pixelRatio!==1.75||s.speed!==1))throw new Error('Unstable benchmark settings');writeFileSync(`${out}/${label}.json`,JSON.stringify(report));console.log(JSON.stringify({complete:true,frames:data.frames.length,events:data.events.length,errors,consoleMessages,initial,final},null,2));await page.screenshot({path:`${out}/${label}.png`});const saved=await page.evaluate(async()=>{const {createSaveStore}=await import('/src/save-store.js');return createSaveStore({legacyKey:'hearthvale-save'}).load();});writeFileSync(`${out}/${label}-saved.json`,saved??'');
}finally{await browser.close();await server.close();}
