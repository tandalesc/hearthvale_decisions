// Hearthvale on Cloudflare: a sketch of the Worker. It has not been run or deployed.
//
// Static files never reach this code (wrangler.toml: run_worker_first = ["/api/*"]).
// It assumes step 5 of the checklist: the transport-free parts of server/system1.js and
// server/narrator.js moved into server/decision-service.js and server/narrator-service.js,
// with no node:fs / node:util imports.

import {DurableObject} from 'cloudflare:workers';
import {createDecisionService, createAnswerCache, MAX_REQUEST_BYTES} from '../server/decision-service.js';
import {createNarrator, MAX_BODY_BYTES} from '../server/narrator-service.js';

// Isolate-wide state. Each isolate has its own; nothing here is global.
let decisions = null, narrator = null;
const daily = {day: null, total: 0, pending: 0, flushedAt: 0};

// The service calls limits.take() synchronously, so the daily cap checks a local copy
// of the day's total and sends its own count to the DailyCap object every few seconds.
function dailyLimits(env) {
  const cap = Number(env.DECISIONS_DAILY_CAP) || 0;
  return {
    take(client, count) {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== daily.day) Object.assign(daily, {day: today, total: 0, pending: 0});
      if (cap > 0 && daily.total + daily.pending + count > cap) return {status: 503, error: 'Daily decision budget used'};
      daily.pending += count;
      return null;
    },
    stats: () => ({day: daily.day, used: daily.total + daily.pending, dailyCap: cap}),
  };
}

async function flushDaily(env) {
  if (!daily.pending || Date.now() - daily.flushedAt < 5000) return;
  const count = daily.pending;
  daily.pending = 0;
  daily.flushedAt = Date.now();
  const stub = env.DAILY_CAP.get(env.DAILY_CAP.idFromName('global'));
  daily.total = await stub.add(daily.day, count);
}

function services(env) {
  decisions ??= createDecisionService({
    // The VPC binding routes by its own config; the URL host only fills the Host header.
    loadConfig: async () => ({key: env.API_KEY, endpoint: 'http://decisions.internal/v1/decisions'}),
    fetcher: (url, init) => env.DECISIONS.fetch(url, init),
    cache: createAnswerCache(5000),          // TODO: back it with caches.default (section 7)
    limits: dailyLimits(env),
  });
  narrator ??= createNarrator({
    loadConfig: async () => ({key: 'workers-ai', endpoint: 'https://workers-ai.internal/', models: [env.NARRATOR_MODEL]}),
    fetcher: workersAiFetcher(env),
  });
  return {decisions, narrator};
}

// Answers the narrator's OpenAI-style POST /v1/chat/completions with Workers AI, through AI Gateway.
// TODO: confirm the stream's event format; readDeltas reads choices[0].delta.content today.
function workersAiFetcher(env) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const {messages, stream, max_tokens, temperature, top_p, response_format} = body;
    const result = await env.AI.run(env.NARRATOR_MODEL, {messages, stream, max_tokens, temperature, top_p, ...(response_format ? {response_format} : {})},
      {gateway: {id: env.AI_GATEWAY_ID}});
    if (stream) return new Response(result, {headers: {'content-type': 'text/event-stream'}});
    const content = typeof result?.response === 'string' ? result.response : JSON.stringify(result?.response ?? '');
    return Response.json({choices: [{message: {content}}]});
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {status, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}});

async function readJson(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('Request too large');
  return JSON.parse(text);
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

// TODO: an HMAC-signed session cookie (SESSION_SECRET); the IP is only a placeholder key.
const playerKey = (request) => request.headers.get('CF-Connecting-IP') ?? 'unknown';

export default {
  async fetch(request, env, ctx) {
    const {pathname} = new URL(request.url);
    const {decisions, narrator} = services(env);

    if (pathname === '/api/system1/status') {
      if (request.method !== 'GET') return json(405, {error: 'Method not allowed'}, {Allow: 'GET'});
      let state = 'service-unavailable';
      try {
        const res = await env.DECISIONS.fetch('http://decisions.internal/v1/models', {headers: {'x-litellm-api-key': env.API_KEY}, signal: AbortSignal.timeout(3000)});
        state = res.ok ? 'ready' : [401, 403].includes(res.status) ? 'authentication-failed' : 'service-error';
      } catch { /* unreachable */ }
      const h = decisions.health();
      const active = state === 'ready' && h.connected;
      return json(200, {state, engine: active ? 'local-model' : 'local-rules', modelConnected: active, model: active ? h.model : null, lastDecisionAt: h.lastDecisionAt});
    }

    if (pathname === '/api/decisions') {
      if (request.method !== 'POST') return json(405, {error: 'Method not allowed'}, {Allow: 'POST'});
      if (!sameOrigin(request)) return json(403, {error: 'Origin not allowed'});
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json(415, {error: 'JSON required'});
      let body;
      try { body = await readJson(request, MAX_REQUEST_BYTES); }
      catch (error) { return error.message === 'Request too large' ? json(413, {error: 'Request too large'}) : json(400, {error: 'Invalid decision request'}); }
      const {success} = await env.PLAYER_LIMIT.limit({key: playerKey(request)});
      if (!success) return json(429, {error: 'Decision budget for this player used for now', fallback: true, retryAfterMs: 2000}, {'Retry-After': '2'});
      const result = await decisions.handle(body, {client: playerKey(request)});
      ctx.waitUntil(flushDaily(env).catch(() => {}));
      return json(result.status, result.body, result.retryAfterMs ? {'Retry-After': String(result.retryAfterMs / 1000)} : {});
    }

    if (pathname === '/api/narrate') {
      if (request.method !== 'POST') return json(405, {error: 'Method not allowed'}, {Allow: 'POST'});
      if (!sameOrigin(request)) return json(403, {error: 'Origin not allowed'});
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json(415, {error: 'JSON required'});
      let body;
      try { body = await readJson(request, MAX_BODY_BYTES); }
      catch (error) { return error.message === 'Request too large' ? json(413, {error: 'Request too large'}) : json(400, {error: 'Invalid request'}); }
      return streamFromSink((sink) => narrator.handle(body, sink), ctx);
    }

    return json(404, {error: 'Not found'});
  },
};

// Runs a narrator handler against a sink and returns its Response as soon as it is known.
function streamFromSink(run, ctx) {
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const event = (name, data) => writer.write(encoder.encode(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`));
  return new Promise((resolve) => {
    let streaming = false;
    const sink = {
      open(meta) {
        streaming = true;
        resolve(new Response(readable, {headers: {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}}));
        event('meta', meta);
      },
      token(text) { event(null, {t: text}); },
      done(text) { event('done', {text}); writer.close(); },
      result(body) { resolve(json(200, body)); writer.close(); },
      fail(status, body) {
        if (streaming) { event('error', body); writer.close(); return; }
        resolve(json(status, body, status === 429 ? {'Retry-After': '1'} : {}));
        writer.close();
      },
    };
    ctx.waitUntil(Promise.resolve(run(sink)).catch(() => sink.fail(503, {error: 'Narrator unavailable', fallback: true})));
  });
}

// The day's upstream question count for the whole service.
export class DailyCap extends DurableObject {
  async add(day, count) {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, used INTEGER NOT NULL)');
    sql.exec('INSERT INTO days (day, used) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET used = used + excluded.used', day, count);
    return sql.exec('SELECT used FROM days WHERE day = ?', day).one().used;
  }
}
