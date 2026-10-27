// The inspector's narrator: POST /api/narrate turns a fact sheet into a short note.
//
// Node-only (a Vite dev/preview plugin). Never import this module into the browser.
//
//   request   {facts, entityKind?}       facts: see src/narrative-schema.js
//   response  text/event-stream:
//               event: meta   data: {cached, model}
//               data: {"t": "<text delta>"}             (repeated)
//               event: done   data: {"text": "<whole note>"}
//               event: error  data: {"error", "fallback": true}   (after a partial stream)
//             or JSON {error, fallback} with 400/403/413/415/429/503 before any text.
//
// The prompt is built here from validated facts only. Identical facts hit an LRU
// cache; at most two completions run upstream at once, a short queue absorbs
// bursts and anything beyond gets 429. The API key comes from local.env through
// system1.js's loader and never reaches the browser or the logs.

import {createHash} from 'node:crypto';
import {loadLocalConfig, createConcurrencyGate} from './system1.js';
import {validateFacts, canonicalFacts, materialText, FactsError} from '../src/narrative-schema.js';
import {NOTE_SYSTEM, noteUser} from '../src/note-prompt.js';
import {validateProseFacts, cardLines, yearLines, endLines, CHECKS, FALLBACKS, llmFields, CARD_EXAMPLES} from '../src/narrative-prose.js';

export const NARRATE_TIMEOUT_MS = 6000;
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_NOTE_CHARS = 420;
export const MAX_NOTE_SENTENCES = 3;
export const MAX_NOTE_WORDS = 60;
export const PROMPT_VERSION = 3;

// The note prompt is shared with the hosted worker and the training labels (src/note-prompt.js).
export const SYSTEM_PROMPT = NOTE_SYSTEM;

// -> {system, user, messages}
export function buildPrompt(facts) {
  const user = noteUser(facts);
  return {system: SYSTEM_PROMPT, user, messages: [{role: 'system', content: SYSTEM_PROMPT}, {role: 'user', content: user}]};
}

// Entity notes are cached by their material facts (passing details do not count);
// card and chronicle prose by their whole sheet.
export const narrationKey = (facts) =>
  createHash('sha256').update(`${PROMPT_VERSION}\n${facts.type ? canonicalFacts(facts) : materialText(facts)}`).digest('base64url').slice(0, 32);

// {facts, entityKind?} -> clean facts, or throws FactsError.
export function validateNarrateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FactsError('Invalid request');
  if (Object.keys(body).some((k) => k !== 'facts' && k !== 'entityKind' && k !== 'kind')) throw new FactsError('Unknown request field');
  if (body.kind !== undefined && body.kind !== 'entity') throw new FactsError('Unknown narrate kind');
  const facts = validateFacts(body.facts);
  if (body.entityKind !== undefined && body.entityKind !== facts.kind) throw new FactsError('Kind does not match the facts');
  return facts;
}

// One paragraph of plain prose: no thinking tags, markup, quotes or line breaks.
export function cleanNote(raw, {final = false} = {}) {
  let text = String(raw ?? '');
  text = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  text = text.replace(/[*_#`>|~]/g, '').replace(/^["'\s]+/, '').replace(/\s+/g, ' ');
  text = text.replace(/["“”]/g, '');
  if (text.length > MAX_NOTE_CHARS) text = cutAtSentence(text, MAX_NOTE_CHARS);
  if (final) {
    text = capSentences(text.trim());
    // Drop a trailing half sentence when the stream was cut short.
    if (text && !/[.!?]$/.test(text)) {
      const cut = cutAtSentence(text, text.length);
      text = cut.length >= 20 ? cut : `${text}.`;
    }
  }
  return text;
}

// At most three sentences and about sixty words, cut at a sentence end.
function capSentences(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  if (!sentences.length) return text;
  let out = '';
  let words = 0;
  for (const [i, s] of sentences.entries()) {
    const n = s.trim().split(/\s+/).length;
    if (i >= MAX_NOTE_SENTENCES || (i > 0 && words + n > MAX_NOTE_WORDS)) break;
    out += s;
    words += n;
  }
  const rest = text.slice(sentences.join('').length).trim();
  return (out.length >= text.length - rest.length ? `${out} ${rest}` : out).trim();
}

function cutAtSentence(text, max) {
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), /[.!?]$/.test(head) ? head.length - 1 : -1);
  return end > 0 ? head.slice(0, end + 1) : head;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function createLru(max = 500) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

export function completionsUrl(config) {
  const url = new URL('/v1/chat/completions', config.endpoint);
  if (url.origin !== new URL(config.endpoint).origin) throw new Error('Upstream path not allowed');
  return url.href;
}

export function completionBody(model, messages) {
  return {
    model, messages, stream: true, max_tokens: 120, temperature: 0.7, top_p: 0.9,
    // Reasoning models spend the whole budget thinking unless this is off.
    chat_template_kwargs: {enable_thinking: false},
  };
}

// Open a streamed completion, trying each model in turn. -> {response, model}
async function openStream(config, messages, fetcher, signal) {
  let lastError = new Error('No model available');
  for (const model of config.models ?? []) {
    try {
      const response = await fetcher(completionsUrl(config), {
        method: 'POST', redirect: 'error', signal,
        headers: {'x-litellm-api-key': config.key, 'Content-Type': 'application/json', Accept: 'text/event-stream'},
        body: JSON.stringify(completionBody(model, messages)),
      });
      if (response.ok && response.body) return {response, model};
      if (response.body) await response.body.cancel().catch(() => {});
      lastError = new Error(`Upstream status ${response.status}`);
      if ([401, 403].includes(response.status)) break;
    } catch (error) {
      lastError = error;
      if (signal.aborted) break;
    }
  }
  throw lastError;
}

// Yields content deltas from an OpenAI-style SSE body (or a whole JSON reply).
export async function* readDeltas(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let whole = '';
  for await (const chunk of body) {
    const text = decoder.decode(chunk, {stream: true});
    whole += whole.length < 65536 ? text : '';
    buffer += text;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      } catch {
        // A malformed event line: skip it.
      }
    }
  }
  // Some servers ignore stream: true and send one JSON body.
  if (!whole.includes('data:')) {
    try {
      const content = JSON.parse(whole)?.choices?.[0]?.message?.content;
      if (typeof content === 'string') yield content;
    } catch {
      // Not JSON either: nothing to yield.
    }
  }
}

// ---------------------------------------------------------------------------
// Service (transport-independent; the plugin and tests drive it)
// ---------------------------------------------------------------------------

// sink: {open(meta), token(text), done(text), fail(status, body)}; open is called
// at most once, before the first token. fail before open means a JSON error reply.
export function createNarrator({
  loadConfig, fetcher = fetch, gate = createConcurrencyGate({limit: 2, maxQueue: 4, maxWaitMs: 2500}),
  cache = createLru(500), timeoutMs = NARRATE_TIMEOUT_MS, prose: proseOptions = {},
} = {}) {
  const inflight = new Map();   // key -> Promise<text|null>, so identical taps share one completion

  const prose = createProseWriter({loadConfig, fetcher, ...proseOptions});

  async function handle(body, sink) {
    if (body?.kind === 'card' || body?.kind === 'chronicle') return prose.handle(body, sink);
    let facts;
    try { facts = validateNarrateRequest(body); } catch { return sink.fail(400, {error: 'Invalid facts', fallback: true}); }
    const key = narrationKey(facts);

    const hit = cache.get(key);
    if (hit) return replay(sink, hit, 'cache');
    if (inflight.has(key)) {
      const text = await inflight.get(key);
      return text ? replay(sink, text, 'shared') : sink.fail(503, {error: 'Narrator unavailable', fallback: true});
    }

    let release;
    try { release = await gate.acquire(); } catch { return sink.fail(429, {error: 'Narrator busy', retryAfterMs: 500, fallback: true}); }
    let settle;
    inflight.set(key, new Promise((resolve) => { settle = resolve; }));
    try {
      const text = await complete(facts, sink);
      if (text) cache.set(key, text);
      settle(text);
    } catch {
      settle(null);
    } finally {
      inflight.delete(key);
      release();
    }
  }

  function replay(sink, text, source) {
    sink.open({cached: true, source});
    sink.token(text);
    sink.done(text);
  }

  // Streams one completion to the sink. Returns the note, or null on failure.
  async function complete(facts, sink) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let opened = false, sent = '', raw = '';
    try {
      const config = await loadConfig();
      if (!config.key) throw new Error('Key missing');
      const {response, model} = await openStream(config, buildPrompt(facts).messages, fetcher, controller.signal);
      sink.open({cached: false, model});
      opened = true;
      for await (const delta of readDeltas(response.body)) {
        raw += delta;
        const text = cleanNote(raw);
        if (text.startsWith(sent) && text.length > sent.length) {
          sink.token(text.slice(sent.length));
          sent = text;
        }
        if (raw.length > MAX_NOTE_CHARS * 2 || sent.length >= MAX_NOTE_CHARS) break;
      }
    } catch {
      // Timeout or upstream failure: keep whatever arrived, if it is enough.
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    const note = cleanNote(raw, {final: true});
    if (note.length >= 20) {
      if (!opened) sink.open({cached: false});
      sink.done(note);
      return note;
    }
    if (opened) sink.fail(503, {error: 'Narrator stopped early', fallback: true});
    else sink.fail(503, {error: 'Narrator unavailable', fallback: true});
    return null;
  }

  return {handle, stats: () => ({...gate.stats(), cached: cache.size, inflight: inflight.size, prose: prose.stats()})};
}

// ---------------------------------------------------------------------------
// Prose for cards and the chronicle (JSON in, JSON out, never streamed)
//
//   request   {kind: 'card', facts}  or  {kind: 'chronicle', facts}   (facts.type 'card' | 'year' | 'end')
//   response  200 {prose, source: 'llm', model}          checked model prose
//             200 {prose, source: 'template', reason}    the model's text was refused: use this
//             400 / 429 / 503 {error, fallback: true}    nothing written: try again later
// ---------------------------------------------------------------------------

export const PROSE_TIMEOUT_MS = 15000;
const PROSE_TOKENS = {card: 420, year: 140, end: 1000};

const CARD_PROMPT = [
  'You write the words on a proposal card in a town-building game. The town leader reads the card; call the leader "you".',
  'Speak as the asker, with "we" or "I", in their own manner: let their two traits colour the words. A blunt farmer talks short and sharp; a careful steward weighs things.',
  'Return only a JSON object: {"why": "...", "options": {"<option key>": "..."}} with exactly the option keys listed.',
  '',
  'The why replaces the game explanation: preserve its problem, stakes, remedy and question. Name both plans when they compete, without choosing for the player.',
  'Use 2–4 short sentences, at most 80 words and 560 characters. Keep conditional risks conditional. Do not compress away meaning.',
  'Paraphrasing the template reason is welcome. Add context only when it serves the request; omit unrelated statistics and past rulings.',
  '',
  'Each option: the plain trade-off from the asker\'s side, never longer or vaguer than the template line. If you cannot make it better, return the template line unchanged.',
  'Give the main options a fresh line in the asker\'s voice. For "Not now" and "Refuse", say who will mind and how, as the asker would.',
  'Stay true to each option\'s effects; never say one does the opposite.',
  '',
  'House voice: plain, common words, short sentences, warm. No numbers. Do not count things the leader does not care about.',
  'Avoid officialese: "priority", "manage", "ensure", "address", "resent your refusal", "stakeholders", "tracking", "in order to".',
  'Past rulings were the leader\'s: say "you put off our barn", never "we approved". Keep it measured: no one starves, dies or riots unless the facts say so.',
  'Never invent names, places or events.',
  '',
  'Examples of the voice (facts, then a good card). Learn the voice; never copy their words:',
  ...CARD_EXAMPLES.flatMap((e) => ['', `Facts: ${e.facts}`, JSON.stringify(e.card)]),
].join('\n');

const YEAR_PROMPT = [
  'You write the line that closes a year in a town\'s chronicle, in a town-building game.',
  'Return only a JSON object: {"text": "..."}.',
  'The text: 1 or 2 short sentences, 35 words at most, plain and warm, like an old chronicler writing in the town book.',
  'Name the one or two things that mattered most that year, with their real names from the facts: the event, the place, the body, the rule.',
  'Call the town by the name the facts give it, or "the town", and the leader "you". Do not restate the template line.',
  'No numbers unless the facts give them. Do not invent names, places or events. No officialese.',
  '',
  'Examples:',
  'Facts: Ashford; the summer fair; you approved the festival fund, asked by the Festival Society; the Festival Society was founded; template: Year 12 ends. A new body sits.',
  '{"text": "The year the fiddlers got their way: a festival fund, a Society of their own, and the best summer fair Ashford had seen."}',
  'Facts: the river floods; you put off a wall against the floods, asked by the River Authority; the labourers are uneasy, falling; template: Year 30 ends. People grow angry.',
  '{"text": "The river came over the banks again, and you put the flood wall off once more. In the low streets, the labourers stopped smiling."}',
].join('\n');

const END_PROMPT = [
  'You write the closing page of a town\'s chronicle, in a town-building game, after 150 years. Call the town by the name the facts give it.',
  'Return only a JSON object: {"eras": {"<era number>": "..."}, "closing": ["...", "...", "..."]} with one entry for each era listed.',
  'Each era: 2 or 3 short sentences, 60 words at most, telling that era from its facts, in the past tense.',
  '"closing": exactly three sentences, 25 words at most each, saying what the town became, from the facts.',
  'Plain, warm words, like a town chronicler. The town leader is "you".',
  'Use only the facts. No numbers except years and counts that the facts give. Do not invent names, places or events.',
  'If towns are listed, add "centres": {"<town number>": "..."}: 1 or 2 short sentences, 40 words at most, about how each town ended.',
].join('\n');


export function buildProsePrompt(facts) {
  if (facts.type === 'card') {
    const user = `Card facts:\n${cardLines(facts).map((l) => `- ${l}`).join('\n')}\nOption keys: ${facts.options.map((o) => o.key).join(', ')}.\nReturn the JSON.`;
    return [{role: 'system', content: CARD_PROMPT}, {role: 'user', content: user}];
  }
  if (facts.type === 'year') {
    return [{role: 'system', content: YEAR_PROMPT}, {role: 'user', content: `Facts about the year:\n${yearLines(facts).map((l) => `- ${l}`).join('\n')}\nReturn the JSON.`}];
  }
  const keys = facts.eras.map((e) => e.era).join(', ');
  const towns = facts.centres?.length ? `\nTown numbers: ${facts.centres.map((c) => c.id).join(', ')}.` : '';
  return [{role: 'system', content: END_PROMPT}, {role: 'user', content: `Facts:\n${endLines(facts).map((l) => `- ${l}`).join('\n')}\nEra numbers: ${keys}.${towns}\nReturn the JSON.`}];
}

// {kind, facts} -> clean facts, or throws FactsError.
export function validateProseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FactsError('Invalid request');
  if (Object.keys(body).some((k) => k !== 'facts' && k !== 'kind')) throw new FactsError('Unknown request field');
  const facts = validateProseFacts(body.facts);
  const wants = body.kind === 'card' ? ['card'] : ['year', 'end'];
  if (!wants.includes(facts.type)) throw new FactsError('Kind does not match the facts');
  return facts;
}

// The first JSON object in a reply (models sometimes wrap it in a fence or a sentence).
export function parseJsonReply(text) {
  const raw = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// One non-streamed completion; tries each model, and drops response_format if a server refuses it.
async function completeText(config, messages, fetcher, signal, maxTokens, temperature) {
  let lastError = new Error('No model available');
  for (const model of config.models ?? []) {
    for (const json of [true, false]) {
      const body = {...completionBody(model, messages), stream: false, max_tokens: maxTokens, temperature};
      if (json) body.response_format = {type: 'json_object'};
      try {
        const response = await fetcher(completionsUrl(config), {
          method: 'POST', redirect: 'error', signal,
          headers: {'x-litellm-api-key': config.key, 'Content-Type': 'application/json'},
          body: JSON.stringify(body),
        });
        if (response.ok) {
          const text = await response.text();
          if (text.length > 65536) throw new Error('Oversized reply');
          const content = JSON.parse(text)?.choices?.[0]?.message?.content;
          if (typeof content === 'string') return {content, model};
          throw new Error('No content');
        }
        if (response.body) await response.body.cancel().catch(() => {});
        lastError = new Error(`Upstream status ${response.status}`);
        if ([401, 403].includes(response.status)) throw lastError;
        if (!(json && response.status === 400)) break;   // only a 400 is worth retrying without response_format
      } catch (error) {
        lastError = error;
        if (signal.aborted || /status 40[13]/.test(error.message)) throw error;
        break;
      }
    }
  }
  throw lastError;
}

const TEMPERATURES = [0.75, 0.6, 0.6];

function retryHint(reason) {
  if (/copies an example/.test(reason)) return 'the why copies the example cards; write about this card only';
  if (/speaks of themselves/.test(reason)) return 'the asker is speaking: say "I" or "we", not their own name';
  if (/claims your rulings/.test(reason)) return 'the rulings were the leader\'s: say "you put off", not "we put off"';
  if (/copies a template sentence/.test(reason)) return 'the why copies a sentence of the template reason; say it in your own words';
  if (/restates the template/.test(reason)) return 'the why repeats the template reason; tell it fresh, in the asker\'s voice';
  if (/no concrete detail/.test(reason)) return 'the why needs one concrete detail from the facts that the template lacks: the place, a recent event, the faction most at stake and where they live, or what you did with their last asks';
  if (/stiff phrasing/.test(reason)) return `avoid the word "${reason.split(': ').pop()}"; use plain words`;
  if (/number not in facts/.test(reason)) return `it used ${reason.split(': ').pop()}, a number the facts do not give; use no numbers`;
  if (/option keys/.test(reason)) return 'the option keys must be exactly the ones listed';
  if (/says|free|cost/.test(reason)) return `an option trade-off went against its effects: ${reason}`;
  if (/long|words|sentences/.test(reason)) return `${reason}; keep to the length limits`;
  if (/overstates/.test(reason)) return `it said "${reason.split(': ').pop()}", which the facts do not support; keep it measured`;
  return reason;
}

// Background prose: one upstream call at a time so taps on people stay quick.
export function createProseWriter({
  loadConfig, fetcher = fetch, gate = createConcurrencyGate({limit: 1, maxQueue: 16, maxWaitMs: 20000}),
  cache = createLru(300), timeoutMs = PROSE_TIMEOUT_MS, attempts = 2,
} = {}) {
  async function handle(body, sink) {
    let facts;
    try { facts = validateProseRequest(body); } catch { return sink.fail(400, {error: 'Invalid facts', fallback: true}); }
    const key = `${facts.type}:${narrationKey(facts)}`;
    const hit = cache.get(key);
    if (hit) return sink.result({...hit, cached: true});

    let release;
    try { release = await gate.acquire(); } catch { return sink.fail(429, {error: 'Narrator busy', retryAfterMs: 2000, fallback: true}); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const config = await loadConfig();
      if (!config.key) throw new Error('Key missing');
      const messages = buildProsePrompt(facts);
      let reason = 'no reply';
      let best = null;   // cards: the attempt with the most fields the model got right
      for (let i = 0; i < attempts; i++) {
        const {content, model} = await completeText(config, messages, fetcher, controller.signal, PROSE_TOKENS[facts.type], TEMPERATURES[i] ?? 0.6);
        const parsed = parseJsonReply(content);
        const checked = parsed ? CHECKS[facts.type](facts, parsed) : {ok: false, reason: 'not JSON'};
        if (checked.ok && facts.type !== 'card') {
          const result = {prose: checked.prose, source: 'llm', model};
          cache.set(key, result);
          return sink.result(result);
        }
        if (checked.ok) {
          if (!best || llmFields(checked) > llmFields(best.checked)) best = {checked, model};
          if (checked.used.why === 'llm') break;
          reason = `why: ${checked.reasons.why}`;
        } else reason = checked.reason;
        // Next try: say what was wrong (the reason is our own text, never the model's).
        messages.push({role: 'assistant', content: String(content).slice(0, 2000)},
          {role: 'user', content: `That reply broke a rule (${retryHint(reason)}). Write it again and return only the JSON.`});
      }
      // Cards keep each field the model got right; the rest stays template text.
      const result = best && llmFields(best.checked)
        ? {prose: best.checked.prose, source: 'llm', model: best.model, used: best.checked.used,
          ...(Object.keys(best.checked.reasons).length ? {reasons: best.checked.reasons} : {})}
        : {prose: FALLBACKS[facts.type](facts), source: 'template', reason: String(reason).slice(0, 80)};
      cache.set(key, result);
      return sink.result(result);
    } catch {
      return sink.fail(503, {error: 'Narrator unavailable', fallback: true});
    } finally {
      clearTimeout(timer);
      release();
    }
  }
  return {handle, stats: () => ({...gate.stats(), cached: cache.size})};
}

// ---------------------------------------------------------------------------
// Vite plugin
// ---------------------------------------------------------------------------

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// An HTTP response as a narrator sink: JSON for early errors, SSE once text flows.
export function responseSink(res) {
  let streaming = false;
  const event = (name, data) => res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  return {
    open(meta) {
      streaming = true;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      event('meta', meta);
    },
    token(text) { event(null, {t: text}); },
    result(body) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    },
    done(text) { event('done', {text}); res.end(); },
    fail(status, body) {
      if (streaming) { event('error', body); res.end(); return; }
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (status === 429) res.setHeader('Retry-After', '1');
      res.end(JSON.stringify(body));
    },
  };
}

export function narratorPlugin(options = {}) {
  let root;
  const narrator = createNarrator({loadConfig: () => loadLocalConfig(root), ...options});
  const attach = (server) => {
    server.middlewares.use(async (req, res, next) => {
      let pathname;
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return next(); }
      if (pathname !== '/api/narrate') return next();
      const json = (status, body) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(405, {error: 'Method not allowed'}); }
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return json(403, {error: 'Origin not allowed'}); }
        catch { return json(403, {error: 'Origin not allowed'}); }
      }
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, {error: 'JSON required'});
      let body;
      try { body = await readBody(req); }
      catch (error) { return error.message === 'Request too large' ? json(413, {error: 'Request too large'}) : json(400, {error: 'Invalid request'}); }
      await narrator.handle(body, responseSink(res));
    });
  };
  return {name: 'hearthvale-narrator', configResolved(config) { root = config.root; }, configureServer: attach, configurePreviewServer: attach};
}
