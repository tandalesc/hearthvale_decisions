// Browser client for the inspector's narrator (POST /api/narrate, server/narrator.js).
//
//   const text = await narrate(facts, {signal, onToken, onMeta})
//
// facts come from narrativeFacts(state, {...}) in src/sim/narrative-facts.js.
// onToken(delta, textSoFar) fires as the note streams in; the resolved string is
// the final note and replaces whatever was streamed. When the service is down,
// busy or slow, narrate() resolves with a plain sentence built from the facts, so
// the inspector always has something to say. onMeta({source}) reports where the
// text came from: 'model', 'cache' or 'fallback'. An aborted signal rejects with
// an AbortError.
//
// whyLines(facts, {limit}) gives the plain fact lines for the "Why?" disclosure, most telling first.

import {validateFacts, materialText, whyOrder, whenText, optionPhrase, chanceWord, TRADE_WORDS, SEASONS} from './narrative-schema.js';
import {validateProseFacts, FALLBACKS, CHECKS} from './narrative-prose.js';
import {
  narrativeFacts, materialKey, entityRef, cardFacts, chronicleFacts, cardsNeedingProse, yearEntriesNeedingProse, summaryNeedsProse,
} from './sim/narrative-facts.js';
import {findAction} from './sim/hooks.js';
import * as sim from './sim/index.js';

// The "Why?" list, most telling first: your rulings, what happened to them,
// where they are torn, hardship; identity and the date last.
export const whyLines = (facts, {limit} = {}) => whyOrder(facts, {limit});

const DOWN_COOLDOWN_MS = 30000;

export function createNarratorClient({endpoint = '/api/narrate', fetcher = (...a) => globalThis.fetch(...a), cacheSize = 200, now = () => Date.now()} = {}) {
  const cache = new Map();      // material facts -> note (model text only)
  const inflight = new Map();   // canonical facts -> Promise<{text, source}>
  let downUntil = 0;

  const remember = (key, text) => {
    cache.delete(key);
    cache.set(key, text);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  };

  async function narrate(facts, {signal, onToken, onMeta} = {}) {
    let clean;
    try { clean = validateFacts(facts); } catch { return deliver(fallbackNote(facts), 'fallback', {onToken, onMeta}); }
    const key = materialText(clean);
    if (cache.has(key)) {
      const text = cache.get(key);
      remember(key, text);
      return deliver(text, 'cache', {onToken, onMeta});
    }
    if (now() < downUntil) return deliver(fallbackNote(clean), 'fallback', {onToken, onMeta});
    if (inflight.has(key)) {
      const {text, source} = await inflight.get(key);
      return deliver(text, source === 'model' ? 'cache' : source, {onToken, onMeta});
    }
    const job = request(clean, {signal, onToken, onMeta});
    inflight.set(key, job);
    try {
      const {text, source} = await job;
      if (source === 'model') remember(key, text);
      return text;
    } finally {
      inflight.delete(key);
    }
  }

  // -> {text, source}; streams tokens to onToken on the way.
  async function request(facts, {signal, onToken, onMeta}, retried = false) {
    let response, announcedSource = null, previewText = null;
    const emitMeta = (meta) => {
      const source = noteSource(meta.source);
      if (source !== announcedSource) { announcedSource = source; onMeta?.({...meta, source}); }
    };
    const emitToken = (delta, text) => { previewText = text; onToken?.(delta, text); };
    try {
      response = await fetcher(endpoint, {
        method: 'POST', signal,
        headers: {'Content-Type': 'application/json', Accept: 'text/event-stream'},
        body: JSON.stringify({facts, entityKind: facts.kind}),
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      downUntil = now() + DOWN_COOLDOWN_MS;
      return fallback(facts, {onToken, onMeta});
    }
    if (response.status === 429 && !retried) {
      await sleep(Math.min(1000, Number(response.headers?.get?.('Retry-After') ?? 0.5) * 1000), signal);
      return request(facts, {signal, onToken, onMeta}, true);
    }
    if (!response.ok || !response.body) {
      if (response.status >= 500) downUntil = now() + DOWN_COOLDOWN_MS;
      return fallback(facts, {onToken, onMeta});
    }
    try {
      const result = response.headers?.get?.('content-type')?.includes('application/json')
        ? await response.json()
        : await readNarrationStream(response.body, {onToken: emitToken, onMeta: emitMeta, signal, snapshotsOnly: true, field: 'text'});
      if (typeof result?.text === 'string' && result.text) {
        const source = noteSource(result.source ?? 'model');
        emitMeta({source});
        if (result.text !== previewText) emitToken(result.text, result.text);
        return {text: result.text, source};
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
    }
    return fallback(facts, {onToken, onMeta});
  }

  return {narrate, clear: () => cache.clear(), stats: () => ({cached: cache.size, inflight: inflight.size, down: now() < downUntil})};
}

function fallback(facts, {onToken, onMeta}) {
  const text = fallbackNote(facts);
  deliver(text, 'fallback', {onToken, onMeta});
  return {text, source: 'fallback'};
}

function deliver(text, source, {onToken, onMeta}) {
  onMeta?.({source});
  onToken?.(text, text);
  return text;
}

const noteSource = (source) => source === 'template' ? 'fallback' : source === 'llm' ? 'model' : source;

// Preview snapshots are display-only. Only a terminal payload can be cached or
// persisted; a truncated or failed stream never promotes its draft to a result.
export async function readNarrationStream(body, {onToken, onMeta, signal, snapshotsOnly = false, field = null} = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', soFar = '', source = 'model', bytes = 0;
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const {value, done} = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) return null;
      bytes += value.byteLength;
      if (bytes > 262144) return null;
      buffer = (buffer + decoder.decode(value, {stream: true})).replace(/\r\n/g, '\n');
      if (buffer.length > 65536) return null;
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const name = /^event: ?(.+)$/m.exec(block)?.[1] ?? 'message';
        const raw = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        if (name === 'meta') {
          source = data?.source ?? (data?.cached ? 'cache' : 'model');
          onMeta?.({...data, source});
        } else if ((name === 'delta' || name === 'message') && typeof data?.t === 'string') {
          if (snapshotsOnly && data.replace !== true) continue;
          if (field && data.field !== field) continue;
          const next = data.replace === true ? data.t : soFar + data.t;
          if (next.length > 16000) return null;
          soFar = next;
          onToken?.(data.t, soFar);
        } else if (name === 'done' || name === 'fallback') {
          if (!data || (typeof data.text !== 'string' && !data.prose)) return null;
          return {...data, source: data.source ?? source};
        } else if (name === 'error') return null;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, {once: true});
  });
}

function abortError() {
  try { return new DOMException('Aborted', 'AbortError'); } catch { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }
}

// ---------------------------------------------------------------------------
// The local note: two plain sentences from the facts, no service needed
// ---------------------------------------------------------------------------

const CONDITION = {good: 'well kept', worn: 'a little worn', shabby: 'shabby', failing: 'falling down'};
const ACT = {approved: 'you approved', refused: 'you refused', deferred: 'you put off', delegated: 'you let others decide on', lapsed: 'you let lapse', heard: 'you heard'};
const CALM = new Set(['stay', 'accept', 'support', 'honest', 'give_alms', 'keep', 'wait', 'join', 'watch', 'assimilate', 'hold', 'help', 'work', 'indifferent']);

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function situation(f) {
  const n = f.now ?? {};
  if (n.hungry) return 'is going hungry';
  if (n.work === 'idle') return 'is out of work';
  if (n.wealth === 'poor' && n.wealthTrend === 'falling') return 'is growing poorer';
  if (n.mood === 'angry' || n.mood === 'uneasy') return `is uneasy, like many ${n.moodOf ?? 'neighbours'}`;
  if (n.work === 'short') return 'could use more work';
  if (n.wealth === 'wealthy') return 'is doing well';
  if (n.wealth === 'poor') return 'gets by on little';
  return 'is getting by';
}

function rulingSentence(f) {
  const r = (f.rulings ?? []).find((x) => x.fx === 'helped' || x.fx === 'hurt' || x.fx === 'mixed') ?? (f.rulings ?? [])[0];
  if (!r) return '';
  const done = r.act === 'approved' || r.act === 'heard';
  const effect = r.fx === 'helped' ? (done ? ' It helped them.' : ' It would have helped them.')
    : r.fx === 'hurt' ? (done ? ' It hurt them.' : ' It would have hurt them.') : '';
  return `${whenText(r.year, f.year)}, ${ACT[r.act]} ${r.what}.${effect}`;
}

function leanSentence(f) {
  for (const lean of f.leans ?? []) {
    const drama = lean.top.find((x) => !CALM.has(x.o) && x.p >= 0.15);
    if (drama) return `They ${chanceWord(drama.p).replace(/^unlikely to/, 'are unlikely to').replace(/^some chance to/, 'might')} ${optionPhrase(lean.k, drama.o)}.`;
  }
  return '';
}

export function fallbackNote(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const name = typeof f.name === 'string' && f.name ? f.name : 'This place';
  const parts = [];
  if (f.kind === 'building') {
    const b = f.building ?? {};
    const state = b.built != null && b.built < 1 ? 'is still being built' : `is ${CONDITION[b.condition] ?? 'standing'}`;
    parts.push(`${name} ${state}.`);
    if (f.business) parts.push(`The ${f.business.type} has ${f.business.filled ?? 0} of ${f.business.jobs ?? 0} jobs filled and is ${{losing: 'losing money', even: 'breaking even', making: 'making money'}[f.business.profit] ?? 'open'}.`);
    else if (f.residents?.people) parts.push(`${f.residents.people === 1 ? 'One person lives' : `${f.residents.people} people live`} here.`);
    else if (b.origin) parts.push(`It was ${b.origin}.`);
  } else if (f.kind === 'body') {
    parts.push(`The ${name} ${f.body?.status === 'waning' ? 'is losing its grip' : 'sits and does its work'}.`);
    if (f.body?.patience === 'low') parts.push('Its patience with you is wearing thin.');
  } else {
    const trade = f.who?.trade && f.who.trade !== 'none' ? `, one of the ${TRADE_WORDS[f.who.trade]},` : '';
    parts.push(`${name}${trade} ${situation(f)}.`);
  }
  const ruling = f.kind === 'body' ? '' : rulingSentence(f);
  parts.push(ruling || leanSentence(f));
  return cap(parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
}

// ---------------------------------------------------------------------------
// Kept notes: a note is stored in the save and shown again until something
// material about the entity changes (see materialKey in src/sim/narrative-facts.js)
//
//   const peek = peekNote(state, {personId})   // sync: facts, saved note, status
//     peek.status: 'current', 'changed' (the note is stale) or 'none'
//   const note = await noteFor(state, {personId}, {signal, onToken, onMeta, peek, regenerate})
//     -> {text, source: 'saved'|'model'|'cache'|'fallback', stale, when?, ref, key}
//
// A saved note is returned as it is, current or stale, with no request; stale
// says something material has changed since (the inspector lights a refresh
// icon). Only `regenerate: true` (the player clicked refresh) or having no note
// at all starts a stream.
//
// Notes live in state.notes through sim-core's setEntityNote / touchEntityNote.
// Until those exist, they are kept in memory for the session. Only model text is
// kept; a fallback sentence is never stored.
// ---------------------------------------------------------------------------

const memoryNotes = new WeakMap();   // state -> Map(ref -> note), while the sim has no notes store

// sim-core's notes actions, looked up by name so a build without them still links.
const simAction = (name) => (typeof sim[name] === 'function' ? sim[name] : null);
const savesNotes = (state) => !!simAction('setEntityNote') && state && typeof state.notes === 'object' && state.notes !== null;

function savedNote(state, ref) {
  return (savesNotes(state) ? state.notes[ref] : memoryNotes.get(state)?.get(ref)) ?? null;
}

export function keepNote(state, ref, key, text) {
  if (savesNotes(state)) { simAction('setEntityNote')(state, ref, {key, text}); return; }
  if (!memoryNotes.has(state)) memoryNotes.set(state, new Map());
  const notes = memoryNotes.get(state);
  notes.delete(ref);
  notes.set(ref, {key, text, year: state.time?.year ?? 0, month: state.time?.month ?? 0});
  while (notes.size > 300) notes.delete(notes.keys().next().value);
}

export function touchNote(state, ref) {
  if (savesNotes(state)) simAction('touchEntityNote')?.(state, ref);
  else {
    const notes = memoryNotes.get(state);
    const note = notes?.get(ref);
    if (note) { notes.delete(ref); notes.set(ref, note); }
  }
}

// 'noted in spring, year 41'
export const notedWhen = (note) => `noted in ${SEASONS[Math.floor((note.month ?? 0) / 3) % 4]}, year ${note.year}`;

export function peekNote(state, query) {
  const facts = narrativeFacts(state, query);
  const ref = entityRef(query);
  if (!facts || !ref) return null;
  const key = materialKey(facts);
  const saved = savedNote(state, ref);
  return {
    ref, facts, key,
    status: !saved ? 'none' : saved.key === key ? 'current' : 'changed',
    saved: saved ? {text: saved.text, year: saved.year, month: saved.month, when: notedWhen(saved)} : null,
  };
}

// notes: {set(ref, key, text), touch(ref)} to keep notes somewhere else than `state`
// (the inspector's host, when the town runs in the sim worker; then state is null and
// peek is required).
export async function noteFor(state, query, {signal, onToken, onMeta, peek = null, client = null, regenerate = false, notes = null} = {}) {
  const p = peek ?? peekNote(state, query);
  if (!p) return null;
  if (p.saved && !regenerate) {
    if (notes) notes.touch(p.ref);
    else touchNote(state, p.ref);
    onMeta?.({source: 'saved'});
    return {text: p.saved.text, source: 'saved', stale: p.status === 'changed', when: p.saved.when, ref: p.ref, key: p.key};
  }
  let source = 'model';
  const text = await (client ?? {narrate}).narrate(p.facts, {signal, onToken, onMeta: (m) => { source = m.source; onMeta?.(m); }});
  if (source === 'model' || source === 'cache') {
    if (notes) notes.set(p.ref, p.key, text);
    else keepNote(state, p.ref, p.key, text);
  }
  return {text, source, stale: false, ref: p.ref, key: p.key};
}

// ---------------------------------------------------------------------------
// Demand-driven card flavour. Ticks never generate prose; a visible selected
// card requests its own note and stores it through the simulation save action.
// ---------------------------------------------------------------------------

const PROSE_RETRY_MS = 30000;

export function createProseKeeper({endpoint = '/api/narrate', fetcher = (...a) => globalThis.fetch(...a), now = () => Date.now(), actions = findAction} = {}) {
  let pausedUntil = 0;
  const retryAt = new Map();   // item key -> time
  const counts = {llm: 0, template: 0, failed: 0};

  const ready = (key) => (retryAt.get(key) ?? 0) <= now();

  async function run(job, signal, onToken) {
    let facts;
    try {
      facts = validateProseFacts(job.facts());
    } catch {
      return null;   // facts that cannot be sent: nothing to store, try again much later
    }
    let response;
    try {
      response = await fetcher(endpoint, {method: 'POST', signal, headers: {'Content-Type': 'application/json', Accept: 'text/event-stream'}, body: JSON.stringify({kind: job.kind, facts})});
    } catch {
      if (signal?.aborted) return null;
      pausedUntil = now() + PROSE_RETRY_MS;
      return false;
    }
    if (response.status === 400) return {prose: FALLBACKS[facts.type](facts), source: 'template'};
    if (!response.ok) return false;
    try {
      const body = response.headers?.get?.('content-type')?.includes('text/event-stream')
        ? await readNarrationStream(response.body, {signal, onToken, snapshotsOnly: true, field: 'why'})
        : await response.json();
      if (body?.prose && (body.source === 'llm' || body.source === 'template')) {
        const checked = CHECKS[facts.type](facts, body.prose);
        if (checked.ok) return {prose: checked.prose, source: facts.type === 'card' && checked.used?.why !== 'llm' ? 'template' : body.source};
      }
    } catch {
      // A broken reply: treat as a failure and retry later.
    }
    return false;
  }

  const inflight = new Map();
  const previews = new Map();
  const previewOwners = new Map();
  // No clock-driven work. The open view explicitly requests one card.
  async function requestCard(state, id, {signal} = {}) {
    const card = cardsNeedingProse(state).find((c) => c.id === id);
    const store = actions('setCardProse');
    const key = `card:${id}`;
    if (!card || !store || !ready(key) || now() < pausedUntil || signal?.aborted) return;
    const previous = inflight.get(key);
    if (previous && !previous.signal?.aborted) return previous.promise;
    const job = {kind: 'card', facts: () => cardFacts(state, id)};
    const entry = {signal, promise: null};
    inflight.set(key, entry);
    previews.set(id, {why: '', pending: true});
    previewOwners.set(id, entry);
    const clearPreview = () => {
      if (previewOwners.get(id) !== entry) return;
      previews.delete(id);
      previewOwners.delete(id);
    };
    signal?.addEventListener('abort', clearPreview, {once: true});
    const pending = run(job, signal, (_delta, text) => {
      if (!signal?.aborted && previewOwners.get(id) === entry) previews.set(id, {why: text, pending: true});
    }).then((result) => {
      if (signal?.aborted || inflight.get(key) !== entry) return;
      if (result) { store(state, id, {...result.prose, source: result.source}); counts[result.source]++; }
      else { counts.failed++; retryAt.set(key, now() + PROSE_RETRY_MS); }
    }).finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
      clearPreview();
      signal?.removeEventListener('abort', clearPreview);
    });
    entry.promise = pending;
    return pending;
  }
  return {tick: async () => {}, requestCard, peekCard: (id) => previews.get(id), stats: () => ({...counts, busy: inflight.size > 0, paused: now() < pausedUntil})};
}

export function startProseKeeper(getState, options = {}) {
  const keeper = createProseKeeper(options);
  let controller = null, selected = null, pending = null;
  const cancel = () => { controller?.abort(); controller = null; selected = null; pending = null; };
  return {...keeper,
    requestCard(id) {
      if (id === selected && pending) return pending;
      cancel();
      selected = id;
      controller = new AbortController();
      pending = keeper.requestCard(getState(), id, {signal: controller.signal});
      return pending;
    },
    cancel, stop: cancel,
  };
}

// The shared client the inspector uses.
const shared = typeof window !== 'undefined' ? createNarratorClient() : null;

export function narrate(facts, options) {
  return (shared ?? createNarratorClient()).narrate(facts, options);
}
