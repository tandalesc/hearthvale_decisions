import {MAX_QUESTIONS_PER_REQUEST,MAX_GROUPS_PER_REQUEST,validateQuestion,validateState,renderQuestion,normalizeAnswer,stateKey,canonicalJson} from '../src/decision-kinds.js';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

// Node-only. Never import this module into the browser bundle.

// Loopback, or a name only the LAN resolves: one label ("gpu-box") or a
// local-only suffix. Public names and IP literals are refused.
const LOCAL_SUFFIXES = ['.localdomain', '.local', '.lan', '.home.arpa', '.internal'];
function isLocalHost(hostname) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return true;
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith('[')) return false;
  return !hostname.includes('.') || LOCAL_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}
export async function loadLocalConfig(root, overrides = process.env) {
  let values = {};
  try { values = parseEnv(await readFile(join(root, 'local.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to read local.env'); }
  const key = overrides.API_KEY || values.API_KEY || '';
  const endpoint = overrides.DECISIONS_URL || values.DECISIONS_URL || 'http://127.0.0.1:4000/v1/decisions';
  const models = String(overrides.NARRATOR_MODELS || values.NARRATOR_MODELS || '').split(',').map(m => m.trim()).filter(Boolean);
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !isLocalHost(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/decisions') {
    throw new Error('Use a LAN service name or loopback HTTP /v1/decisions endpoint');
  }
  return { key, endpoint: url.href, models };
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

// Answers shared by every player: the same question over the same state gets
// the same distribution from the model, so a repeat never goes upstream.
// Least recently used entries go first once `size` is reached.
export function createAnswerCache(size = 50000) {
  const entries = new Map();
  let hits = 0, misses = 0;
  const keyOf = (state, q) => `${q.kind}|${stateKey(state ?? {})}|${canonicalJson([q.context, q.allowed ?? null])}`;
  return {
    get(state, q) {
      if (!(size > 0)) return null;
      const key = keyOf(state, q);
      const hit = entries.get(key);
      if (!hit) { misses++; return null; }
      entries.delete(key);
      entries.set(key, hit);
      hits++;
      return hit;
    },
    set(state, q, answer) {
      if (!(size > 0)) return;
      const key = keyOf(state, q);
      entries.delete(key);
      entries.set(key, answer);
      if (entries.size > size) entries.delete(entries.keys().next().value);
    },
    stats: () => ({size: entries.size, hits, misses}),
  };
}

// Limits on questions sent upstream (cache hits are free):
//   clientRate  per client (an address), questions a second, bursting to 4 s' worth; 0 = none
//   dailyCap    for the whole service per UTC day; 0 = none. Past it, every
//               player's town uses local rules until the next day.
// For a public deployment, set both. See local.env.example.
export function createLimits({clientRate = 0, dailyCap = 0, now = () => Date.now()} = {}) {
  const buckets = new Map();
  let day = null, used = 0;
  return {
    // -> null when allowed, else {status, retryAfterMs?, error}
    take(client, count) {
      const t = now();
      const today = new Date(t).toISOString().slice(0, 10);
      if (today !== day) { day = today; used = 0; }
      if (dailyCap > 0 && used + count > dailyCap) return {status: 503, error: 'Daily decision budget used'};
      if (clientRate > 0) {
        const burst = clientRate * 4;
        let b = buckets.get(client);
        if (!b) { b = {tokens: burst, at: t}; buckets.set(client, b); }
        b.tokens = Math.min(burst, b.tokens + (t - b.at) * clientRate / 1000);
        b.at = t;
        if (b.tokens < count) {
          const retryAfterMs = Math.max(250, Math.ceil((count - b.tokens) / clientRate * 1000));
          return {status: 429, retryAfterMs, error: 'Decision budget for this player used for now'};
        }
        b.tokens -= count;
        // Forget idle clients now and then.
        if (buckets.size > 10000) for (const [k, v] of buckets) if (t - v.at > 60000) buckets.delete(k);
      }
      used += count;
      return null;
    },
    stats: () => ({day, used, dailyCap, clientRate}),
  };
}

export function limitsFromEnv(env = process.env) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return {clientRate: n(env.DECISIONS_CLIENT_QPS), dailyCap: n(env.DECISIONS_DAILY_CAP), cacheSize: env.DECISIONS_CACHE_SIZE != null ? n(env.DECISIONS_CACHE_SIZE) : 50000};
}

// Transport-independent request handling: used by the Vite middleware and by
// scripts/benchmark-decisions.js. Returns {status, body, retryAfterMs?}.
export function createDecisionService({loadConfig, fetcher = fetch, gate = createConcurrencyGate(), cache = createAnswerCache(), limits = createLimits()} = {}) {
  let lastSuccess = 0, model = null, latestFailure = false;
  async function handle(body, {client = 'local'} = {}) {
    let groups;
    try { groups = validateDecisionRequest(body); } catch { return {status: 400, body: {error: 'Invalid decision request'}}; }
    // Answer what the cache knows; only the rest goes upstream.
    const answers = {};
    const misses = [];
    for (const group of groups) {
      const rest = group.questions.filter((q) => {
        const hit = cache.get(group.state, q);
        if (hit) answers[q.id] = hit;
        return !hit;
      });
      if (rest.length) misses.push({state: group.state, questions: rest});
    }
    const cached = Object.keys(answers).length;
    if (!misses.length) return {status: 200, body: {answers, model: model ?? 'local-decision-service', cached}};
    const wanted = misses.reduce((n, g) => n + g.questions.length, 0);
    const refused = limits.take(client, wanted);
    if (refused) {
      // Partial answers still help: send what the cache had.
      if (cached) return {status: 200, body: {answers, model: model ?? 'local-decision-service', cached}};
      return {status: refused.status, ...(refused.retryAfterMs ? {retryAfterMs: refused.retryAfterMs} : {}), body: {error: refused.error, fallback: true, ...(refused.retryAfterMs ? {retryAfterMs: refused.retryAfterMs} : {})}};
    }
    let release;
    try { release = await gate.acquire(); } catch {
      if (cached) return {status: 200, body: {answers, model: model ?? 'local-decision-service', cached}};
      return {status: 429, retryAfterMs: 250, body: {error: 'Decision service busy', retryAfterMs: 250, fallback: true}};
    }
    try {
      // Hard deadline so a stalled upstream can never pin a concurrency slot.
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream deadline')), UPSTREAM_TIMEOUT_MS + 500); });
      const result = await Promise.race([deadline, requestDecisions(await loadConfig(), misses, fetcher)]).finally(() => clearTimeout(timer));
      lastSuccess = Date.now(); latestFailure = false; model = result.model;
      for (const group of misses) {
        for (const q of group.questions) if (result.answers[q.id]) cache.set(group.state, q, result.answers[q.id]);
      }
      return {status: 200, body: {answers: {...answers, ...result.answers}, model: result.model, cached}};
    } catch {
      latestFailure = true;
      if (cached) return {status: 200, body: {answers, model: model ?? 'local-decision-service', cached}};
      return {status: 503, body: {error: 'Local decision service unavailable or invalid response', fallback: true}};
    } finally { release(); }
  }
  const health = () => {
    const {active, queued, limit} = gate.stats();
    return {connected: !latestFailure && Date.now() - lastSuccess < 90000, model, lastDecisionAt: lastSuccess || null, inFlight: active, queued, concurrency: limit, cache: cache.stats(), limits: limits.stats()};
  };
  return {handle, health};
}

async function readJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_REQUEST_BYTES)throw new Error('Request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function system1Plugin({concurrency = 4, maxQueue = 8} = {}) {
  let root, service, ready = null;
  // Limits come from the environment or local.env (the environment wins).
  const start = async () => {
    let file = {};
    try { file = parseEnv(await readFile(join(root, 'local.env'), 'utf8')); } catch { /* none */ }
    const {clientRate, dailyCap, cacheSize} = limitsFromEnv({...file, ...process.env});
    service = createDecisionService({loadConfig: () => loadLocalConfig(root), gate: createConcurrencyGate({limit: concurrency, maxQueue}),
      cache: createAnswerCache(cacheSize), limits: createLimits({clientRate, dailyCap})});
  };
  const attach = async server => {
    server.middlewares.use(async (req,res,next)=>{
      let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.statusCode=400;res.end('Invalid path');return;}
      if(/(?:^|\/)(?:local\.env|\.env[^/]*)(?:\/|$)/i.test(pathname)){res.statusCode=403;res.setHeader('Cache-Control','no-store');res.end('Private configuration');return;}
      if(!['/api/system1/status','/api/decisions'].includes(pathname))return next();
      await (ready??=start());
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
      if(pathname.endsWith('/status')){
        if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{error:'Method not allowed'});}
        try{const status=await checkConnection(await loadLocalConfig(root)),h=service.health(),active=status.state==='ready'&&h.connected;return send(200,{...status,engine:active?'local-model':'local-rules',modelConnected:active,model:active?h.model:null,lastDecisionAt:h.lastDecisionAt,inFlight:h.inFlight,queued:h.queued,concurrency:h.concurrency,cache:h.cache});}catch{return send(500,{state:'configuration-error',engine:'local-rules',modelConnected:false});}
      }
      if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{error:'Method not allowed'});}
      if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)return send(403,{error:'Origin not allowed'});}catch{return send(403,{error:'Origin not allowed'});}}
      if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
      let body;try{body=await readJson(req);}catch(error){return error.message==='Request too large'?send(413,{error:'Request too large'}):send(400,{error:'Invalid decision request'});}
      const result=await service.handle(body,{client:req.socket?.remoteAddress??'unknown'});if(result.retryAfterMs)res.setHeader('Retry-After',String(result.retryAfterMs/1000));send(result.status,result.body);
    });
  };
  return {name:'hearthvale-system1',configResolved(config){root=config.root;ready=start();return ready;},configureServer:attach,configurePreviewServer:attach};
}
