import {normalizeProbabilities} from '../src/routine-policy.js';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

const ACTIVITIES = ['work', 'rest', 'shop', 'leisure'];
// Node-only. Never import this module into the browser bundle.
export async function loadLocalConfig(root, overrides = process.env) {
  let values = {};
  try { values = parseEnv(await readFile(join(root, 'local.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to read local.env'); }
  const key = overrides.API_KEY || values.API_KEY || '';
  const endpoint = overrides.RRH_DECISIONS_URL || values.RRH_DECISIONS_URL || 'http://rrh-llm-1:4000/v1/decisions';
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['rrh-llm-1', 'rrh-llm-1.localdomain', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/decisions') {
    throw new Error('Use the named local rrh-llm-1 service or loopback HTTP /v1/decisions endpoint');
  }
  return { key, endpoint: url.href };
}
export async function checkConnection(config, fetcher = fetch) {
  const base = { keyConfigured: Boolean(config.key), endpoint: config.endpoint, engine: 'local-rules', modelConnected: false, contractAvailable: true };
  if (!config.key) return { ...base, reachable: false, state: 'key-missing' };
  try {
    const response = await fetcher(new URL('/v1/models', config.endpoint), { headers: { 'x-litellm-api-key': config.key }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (response.body) await response.body.cancel();
    return { ...base, reachable: true, authenticated: response.ok, state: response.ok ? 'ready' : [401,403].includes(response.status) ? 'authentication-failed' : 'service-error' };
  } catch { return { ...base, reachable: false, authenticated: false, state: 'service-unavailable' }; }
}
const finite = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
export function validateRoutineRequest(body) {
  if (!body || !Number.isSafeInteger(body.day) || body.day < 1 || !finite(body.happiness,0,100) || !finite(body.food,0,1e12) || !finite(body.tax,0,25) || !Array.isArray(body.residents) || body.residents.length < 1 || body.residents.length > 16) throw new Error('Invalid routine snapshot');
  const ids=new Set();
  for(const p of body.residents){if(!p||!Number.isSafeInteger(p.id)||p.id<1||ids.has(p.id)||!finite(p.wealth,0,1e12))throw new Error('Invalid resident');ids.add(p.id);if(p.allowed&&(!Array.isArray(p.allowed)||!p.allowed.length||p.allowed.length>4||new Set(p.allowed).size!==p.allowed.length||p.allowed.some(a=>!ACTIVITIES.includes(a))))throw new Error('Invalid constraints');if(p.context){const c=p.context;if(!['energyBand','fullnessBand','socialBand','wealthBand','bank','districtX','districtZ','phase','foodBand','wellbeingBand','tax'].every(k=>Number.isInteger(c[k])&&Math.abs(c[k])<=100000)||typeof c.access!=='string'||c.access.length>30)throw new Error('Invalid context');}}
  return body;
}
export function buildQuestions(snapshot) {
  validateRoutineRequest(snapshot);
  const phase=['rest','work','shop','leisure'][snapshot.day%4];const questions={};
  for(const p of snapshot.residents)questions[`resident_${p.id}`]={
    instructions:`Choose the next everyday activity for resident ${p.id} in Hearthvale. Day ${snapshot.day}; normal routine phase ${phase}. Savings ${Math.round(p.wealth)}; town wellbeing ${snapshot.happiness}/100; food reserve ${Math.round(snapshot.food)}; household tax ${snapshot.tax}%. Needs bands (0 critical, 1 low, 2 normal, 3 high): energy ${p.context?.energyBand??'unknown'}, fullness ${p.context?.fullnessBand??'unknown'}, social ${p.context?.socialBand??'unknown'}. Accessible activities: ${(p.allowed??ACTIVITIES).join(', ')}. Respect player policy. This is a routine choice only: never change council decisions, buildings, money or policies.`,
    criteria:{work:'Go to the farm or workshop to work; especially during the work phase.',rest:'Rest at home; especially during the rest phase or when wellbeing is low.',shop:'Visit the market for household needs; especially during the shopping phase.',leisure:'Visit a garden for recreation; especially during the leisure phase.'}
  };
  return {questions};
}
export function parseAnswers(data, snapshot) {
  if(!data||!data.answers||typeof data.answers!=='object')throw new Error('Invalid answer envelope');
  const intents=[];
  for(const p of snapshot.residents){const answer=data.answers[`resident_${p.id}`];if(answer?.type!=='choice'||!ACTIVITIES.includes(answer.choice))continue;const probabilities=normalizeProbabilities(answer.probabilities);if(probabilities&&probabilities[answer.choice]>0)intents.push({personId:p.id,activity:answer.choice,confidence:probabilities[answer.choice],probabilities});else if(finite(answer.confidence,.45,1)&&answer.probabilities===undefined)intents.push({personId:p.id,activity:answer.choice,confidence:answer.confidence});}
  if(!intents.length)throw new Error('No valid routine intents');
  return {day:snapshot.day,intents,model:typeof data.model==='string'&&/^[a-zA-Z0-9_./-]{1,100}$/.test(data.model)?data.model:'local-decision-service'};
}
export async function requestRoutines(config,snapshot,fetcher=fetch){
  if(!config.key)throw new Error('Key missing');
  const response=await fetcher(config.endpoint,{method:'POST',headers:{'x-litellm-api-key':config.key,'Content-Type':'application/json'},body:JSON.stringify(buildQuestions(snapshot)),signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!response.ok){if(response.body)await response.body.cancel();throw new Error('Decision service rejected request');}
  const text=await response.text();if(text.length>128000)throw new Error('Oversized answer');return parseAnswers(JSON.parse(text),snapshot);
}
async function readJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>48000)throw new Error('Request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function system1Plugin() {
  let root,busy=false,lastSuccess=0,model=null,latestFailure=false;
  const attach = async server => {
    server.middlewares.use(async (req,res,next)=>{
      let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.statusCode=400;res.end('Invalid path');return;}
      if(/(?:^|\/)(?:local\.env|\.env[^/]*)(?:\/|$)/i.test(pathname)){res.statusCode=403;res.setHeader('Cache-Control','no-store');res.end('Private configuration');return;}
      if(!['/api/system1/status','/api/system1/decisions'].includes(pathname))return next();
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
      if(pathname.endsWith('/status')){
        if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{error:'Method not allowed'});}
        try{const status=await checkConnection(await loadLocalConfig(root));const active=status.state==='ready'&&!latestFailure&&Date.now()-lastSuccess<90000;return send(200,{...status,engine:active?'local-model':'local-rules',modelConnected:active,model:active?model:null,lastDecisionAt:lastSuccess||null});}catch{return send(500,{state:'configuration-error',engine:'local-rules',modelConnected:false});}
      }
      if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{error:'Method not allowed'});}
      if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)return send(403,{error:'Origin not allowed'});}catch{return send(403,{error:'Origin not allowed'});}}
      if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
      let snapshot;try{snapshot=validateRoutineRequest(await readJson(req));}catch{return send(400,{error:'Invalid routine snapshot'});}
      // Bound concurrency and request size, rather than imposing an arbitrary QPS.
      if(busy){res.setHeader('Retry-After','0.25');return send(429,{error:'Decision service busy',retryAfterMs:250,fallback:true});}
      busy=true;
      try{const result=await requestRoutines(await loadLocalConfig(root),snapshot);lastSuccess=Date.now();latestFailure=false;model=result.model;send(200,result);}catch{latestFailure=true;send(503,{error:'Local decision service unavailable or invalid response',fallback:true});}finally{busy=false;}
    });
  };
  return {name:'hearthvale-system1',configResolved(config){root=config.root;},configureServer:attach,configurePreviewServer:attach};
}
