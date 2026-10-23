// Explicit, bounded live evaluation. Prints simulation prose and rejection reasons only.
// node scripts/evaluate-hosted-narration.js --live --limit=6
import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {fixtureState} from '../src/sim/fixtures.js';
import {stepTick} from '../src/sim/index.js';
import {cardFacts} from '../src/sim/narrative-facts.js';
import {narrateAnthropic} from '../cloudflare/narration.js';
const limit=Math.max(1,Math.min(20,Number(process.argv.find(a=>a.startsWith('--limit='))?.split('=')[1]||6)));
const corpus=[];
const seen=new Set();
for(const profile of ['town','city']){
 const state=fixtureState(profile);
 for(let round=0;round<3;round++){
  for(const card of state.docket){
   const facts=cardFacts(state,card.id);
   if(!facts||seen.has(facts.template))continue;
   seen.add(facts.template);corpus.push({profile,round,facts});
  }
  for(let tick=0;tick<80;tick++)stepTick(state,4,{}, {skipPeople:true});
 }
}
// Spread across profiles and kinds rather than taking the first docket only.
const selected=[];
for(const profile of ['town','city'])for(const item of corpus.filter(x=>x.profile===profile)){
 if(selected.filter(x=>x.profile===profile).length>=3)break;
 if(!selected.some(x=>x.facts.kind===item.facts.kind&&x.profile===profile))selected.push(item);
}
for(const item of corpus)if(selected.length<limit&&!selected.includes(item))selected.push(item);
if(!process.argv.includes('--live')){console.log(JSON.stringify({available:corpus.length,selected:selected.slice(0,limit).map(x=>({profile:x.profile,round:x.round,kind:x.facts.kind,title:x.facts.title}))},null,2));process.exit();}
const excluded = corpus.filter(item => !selected.slice(0,6).includes(item));
const fresh = process.argv.includes('--fresh');
const cases = process.argv.includes('--heldout') ? excluded.slice(fresh ? 6 : 0, (fresh ? 6 : 0) + limit) : selected.slice(0,limit);
const env=parseEnv(await readFile(new URL('../cloudflare/.dev.vars',import.meta.url),'utf8'));
const rows=[];
for(const item of cases){
 const start=performance.now();let diagnostic,firstPreviewMs=null,firstTextMs=null,wire='';
 const fetcher=async(...args)=>{
  const response=await fetch(...args);
  if(!response.body)return response;
  const decoder=new TextDecoder();
  const stream=response.body.pipeThrough(new TransformStream({transform(chunk,controller){const part=decoder.decode(chunk,{stream:true});wire+=part;if(firstTextMs===null&&wire.includes('text_delta'))firstTextMs=Math.round(performance.now()-start);controller.enqueue(chunk);}}));
  return new Response(stream,{status:response.status,headers:response.headers});
 };
 try{const result=await narrateAnthropic(item.facts,env,{fetcher,onDiagnostic:value=>diagnostic=value,onPreview:async()=>{firstPreviewMs??=Math.round(performance.now()-start);}});
 let inputTokens=0,outputTokens=0;
 for(const block of wire.split('\n\n')){try{const event=JSON.parse(block.split('\n').find(line=>line.startsWith('data:'))?.slice(5)||'null');inputTokens=Math.max(inputTokens,event?.message?.usage?.input_tokens||0);outputTokens=Math.max(outputTokens,event?.usage?.output_tokens||0);}catch{}}
 rows.push({inputTokens,outputTokens,firstPreviewMs,firstTextMs,profile:item.profile,round:item.round,kind:item.facts.kind,title:item.facts.title,source:result.source,reason:diagnostic?.checked?.reasons?.why||diagnostic?.checked?.reason|| (result.source==='template'?'prevalidation':''),raw:diagnostic?.raw,ms:Math.round(performance.now()-start),facts:item.facts});
 }catch(error){rows.push({title:item.facts.title,error:error.message});}
 console.log(JSON.stringify({...rows.at(-1),facts:undefined}));
}
const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
if(output)await writeFile(output,JSON.stringify(rows,null,2));
console.log(JSON.stringify({calls:rows.length,accepted:rows.filter(r=>r.source==='llm').length,reasons:rows.reduce((a,r)=>(a[r.reason||r.error||'accepted']=(a[r.reason||r.error||'accepted']||0)+1,a),{})}));
