import {MAX_QUESTIONS_PER_REQUEST,MAX_GROUPS_PER_REQUEST,validateQuestion,validateState,renderQuestion,normalizeAnswer} from '../src/decision-kinds.js';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

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

// Budgets: 64 questions over up to 64 distinct states per request.
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 15000;
const UPSTREAM_PATHS = ['/v1/decisions', '/v1/decisions/batch'];

// {groups:[{state?, questions:[{kind,id,context,allowed?}]}]}: 1..64 groups,
// 1..64 questions in total, ids unique across the request. Every question's
// kind must accept its group's state. -> [{state, questions}]
export function validateDecisionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'groups')) throw new Error('Invalid decision request');
  const {groups} = body;
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_GROUPS_PER_REQUEST) throw new Error('Invalid group count');
  const ids = new Set();
  let total = 0;
  const clean = groups.map(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || Object.keys(group).some(k => k !== 'state' && k !== 'questions')) throw new Error('Invalid group');
    if (!Array.isArray(group.questions) || group.questions.length < 1) throw new Error('Invalid group questions');
    total += group.questions.length;
    if (total > MAX_QUESTIONS_PER_REQUEST) throw new Error('Too many questions');
    const questions = group.questions.map(q => {
      const question = validateQuestion(q);
      if (ids.has(question.id)) throw new Error('Duplicate question id');
      ids.add(question.id);
      return question;
    });
    let state;
    for (const kind of new Set(questions.map(q => q.kind))) state = validateState(kind, group.state);
    return {state, questions};
  });
  return clean;
}

// Upstream keys are positional so client ids never reach the model.
const upstreamKey = (q, index) => `${q.kind}_${index}`;

function upstreamGroup({state, questions}) {
  const body = {questions: Object.fromEntries(questions.map((q, i) => [upstreamKey(q, i), renderQuestion(q, state)]))};
  // Always send a state: the service now answers 413 ("state too large") when
  // the field is missing or null, even for tiny requests. An empty {} is fine.
  body.state = state && typeof state === 'object' ? state : {};
  return body;
}

// One state -> the /v1/decisions body; several -> the /v1/decisions/batch body.
export function buildDecisionPayload(groups) {
  return groups.length === 1 ? upstreamGroup(groups[0]) : {requests: groups.map(upstreamGroup)};
}

export function upstreamUrl(config, path) {
  const url = new URL(path, config.endpoint);
  if (!UPSTREAM_PATHS.includes(url.pathname) || url.origin !== new URL(config.endpoint).origin) throw new Error('Upstream path not allowed');
  return url.href;
}

const modelName = data => typeof data?.model === 'string' && /^[a-zA-Z0-9_./-]{1,100}$/.test(data.model) ? data.model : 'local-decision-service';

// Normalize one group's raw answers into `into` (keyed by client id).
function collect(group, rawAnswers, into) {
  let count = 0;
  if (!rawAnswers || typeof rawAnswers !== 'object') return 0;
  group.questions.forEach((q, i) => {
    const answer = normalizeAnswer(q, rawAnswers[upstreamKey(q, i)]);
    if (answer) { into[q.id] = answer; count++; }
  });
  return count;
}

export function parseDecisionAnswers(data, groups) {
  if (!data || typeof data !== 'object') throw new Error('Invalid answer envelope');
  const answers = {};
  if (groups.length === 1) {
    if (typeof data.answers !== 'object' || data.answers === null) throw new Error('Invalid answer envelope');
    collect(groups[0], data.answers, answers);
  } else {
    if (!Array.isArray(data.results) || data.results.length !== groups.length) throw new Error('Invalid batch envelope');
    groups.forEach((group, i) => collect(group, data.results[i]?.answers, answers));
  }
  if (!Object.keys(answers).length) throw new Error('No valid answers');
  return {answers, model: modelName(data)};
}

class PayloadTooLarge extends Error {}

async function postUpstream(config, groups, fetcher, timeoutMs) {
  const url = upstreamUrl(config, groups.length === 1 ? '/v1/decisions' : '/v1/decisions/batch');
  const response = await fetcher(url, {method: 'POST', headers: {'x-litellm-api-key': config.key, 'Content-Type': 'application/json'}, body: JSON.stringify(buildDecisionPayload(groups)), signal: AbortSignal.timeout(timeoutMs), redirect: 'error'});
  if (!response.ok) {
    if (response.body) await response.body.cancel();
    if (response.status === 413) throw new PayloadTooLarge('Upstream payload too large');
    throw new Error('Decision service rejected request');
  }
  const text = await response.text();
  if (text.length > MAX_ANSWER_BYTES) throw new Error('Oversized answer');
  return parseDecisionAnswers(JSON.parse(text), groups);
}

// Split a request in half (by groups, else by questions) for a retry.
function halves(groups) {
  if (groups.length > 1) {
    const mid = Math.ceil(groups.length / 2);
    return [groups.slice(0, mid), groups.slice(mid)];
  }
  const [{state, questions}] = groups;
  const mid = Math.ceil(questions.length / 2);
  return [[{state, questions: questions.slice(0, mid)}], [{state, questions: questions.slice(mid)}]];
}

// Sends validated groups upstream; an upstream 413 splits the request and retries.
export async function requestDecisions(config, groups, fetcher = fetch, {timeoutMs = UPSTREAM_TIMEOUT_MS, depth = 0} = {}) {
  if (!config.key) throw new Error('Key missing');
  try {
    return await postUpstream(config, groups, fetcher, timeoutMs);
  } catch (error) {
    const splittable = groups.length > 1 || groups[0].questions.length > 1;
    if (!(error instanceof PayloadTooLarge) || !splittable || depth >= 6) throw error;
    const parts = await Promise.allSettled(halves(groups).map(part => requestDecisions(config, part, fetcher, {timeoutMs, depth: depth + 1})));
    const ok = parts.filter(p => p.status === 'fulfilled').map(p => p.value);
    if (!ok.length) throw parts[0].reason;
    return {answers: Object.assign({}, ...ok.map(r => r.answers)), model: ok[0].model};
  }
}

// A few requests run upstream at once (the GPU batches across them); a short
// queue absorbs bursts, and only a full queue or a long wait returns busy.
export function createConcurrencyGate({limit = 4, maxQueue = 8, maxWaitMs = 1000} = {}) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); active++; next.resolve(release); }
  };
  return {
    acquire() {
      if (active < limit) { active++; return Promise.resolve(release); }
      if (waiting.length >= maxQueue) return Promise.reject(new Error('busy'));
      return new Promise((resolve, reject) => {
        const entry = {resolve, timer: setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(new Error('busy'));
        }, maxWaitMs)};
        waiting.push(entry);
      });
    },
    stats: () => ({active, queued: waiting.length, limit}),
  };
}

// Transport-independent request handling: used by the Vite middleware and by
// scripts/benchmark-decisions.js. Returns {status, body, retryAfterMs?}.
export function createDecisionService({loadConfig, fetcher = fetch, gate = createConcurrencyGate()} = {}) {
  let lastSuccess = 0, model = null, latestFailure = false;
  async function handle(body) {
    let groups;
    try { groups = validateDecisionRequest(body); } catch { return {status: 400, body: {error: 'Invalid decision request'}}; }
    let release;
    try { release = await gate.acquire(); } catch { return {status: 429, retryAfterMs: 250, body: {error: 'Decision service busy', retryAfterMs: 250, fallback: true}}; }
    try {
      // Hard deadline so a stalled upstream can never pin a concurrency slot.
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream deadline')), UPSTREAM_TIMEOUT_MS + 500); });
      const result = await Promise.race([deadline, requestDecisions(await loadConfig(), groups, fetcher)]).finally(() => clearTimeout(timer));
      lastSuccess = Date.now(); latestFailure = false; model = result.model;
      return {status: 200, body: result};
    } catch {
      latestFailure = true;
      return {status: 503, body: {error: 'Local decision service unavailable or invalid response', fallback: true}};
    } finally { release(); }
  }
  const health = () => {
    const {active, queued, limit} = gate.stats();
    return {connected: !latestFailure && Date.now() - lastSuccess < 90000, model, lastDecisionAt: lastSuccess || null, inFlight: active, queued, concurrency: limit};
  };
  return {handle, health};
}

async function readJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_REQUEST_BYTES)throw new Error('Request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function system1Plugin({concurrency = 4, maxQueue = 8} = {}) {
  let root;
  const service = createDecisionService({loadConfig: () => loadLocalConfig(root), gate: createConcurrencyGate({limit: concurrency, maxQueue})});
  const attach = async server => {
    server.middlewares.use(async (req,res,next)=>{
      let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.statusCode=400;res.end('Invalid path');return;}
      if(/(?:^|\/)(?:local\.env|\.env[^/]*)(?:\/|$)/i.test(pathname)){res.statusCode=403;res.setHeader('Cache-Control','no-store');res.end('Private configuration');return;}
      if(!['/api/system1/status','/api/decisions'].includes(pathname))return next();
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
      if(pathname.endsWith('/status')){
        if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{error:'Method not allowed'});}
        try{const status=await checkConnection(await loadLocalConfig(root)),h=service.health(),active=status.state==='ready'&&h.connected;return send(200,{...status,engine:active?'local-model':'local-rules',modelConnected:active,model:active?h.model:null,lastDecisionAt:h.lastDecisionAt,inFlight:h.inFlight,queued:h.queued,concurrency:h.concurrency});}catch{return send(500,{state:'configuration-error',engine:'local-rules',modelConnected:false});}
      }
      if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{error:'Method not allowed'});}
      if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)return send(403,{error:'Origin not allowed'});}catch{return send(403,{error:'Origin not allowed'});}}
      if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
      let body;try{body=await readJson(req);}catch(error){return error.message==='Request too large'?send(413,{error:'Request too large'}):send(400,{error:'Invalid decision request'});}
      const result=await service.handle(body);if(result.retryAfterMs)res.setHeader('Retry-After',String(result.retryAfterMs/1000));send(result.status,result.body);
    });
  };
  return {name:'hearthvale-system1',configResolved(config){root=config.root;},configureServer:attach,configurePreviewServer:attach};
}
