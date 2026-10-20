// Browser-side decision bus. Every actor in the game asks through one client:
//
//   const client = createDecisionClient({fetch, now});
//   const answer = await client.ask('resident_routine', 'slice:district=riverside',
//     context, {priority: 50, allowed, state: townSnapshot, tag: 'slice'});
//   // answer: {kind, choice, confidence, probabilities?} or null (use local rules)
//
// Questions are coalesced into one priority-ordered queue. A flush takes up
// to a request budget (questions, bytes, distinct states) and groups the
// questions by their shared `state`: the server sends one state group as a
// single /v1/decisions call (the state is read once) and several as one
// /v1/decisions/batch call. Several requests may be in flight; the target
// concurrency adapts to measured throughput. Failures back off and resolve to
// null so the simulation never waits on the network.
//
// Answers are cached by (kind, state, context, allowed). The model reads one
// question in one forward pass and returns a distribution the game samples
// itself, so the same question over the same state always gets the same
// answer: a repeat is answered at once, without the network. Many walkers and
// many months ask byte-identical questions, so this removes most traffic.
import {MAX_QUESTIONS_PER_REQUEST, MAX_GROUPS_PER_REQUEST, validateQuestion, validateState, stateKey, normalizeAnswer} from './decision-kinds.js';

const WINDOW_MS = 5000;
const STATE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULTS = {
  endpoint: '/api/decisions',
  maxQuestions: 64,           // per request (the service's batch limit)
  maxBytes: 200 * 1024,       // per request, estimated JSON size
  maxGroups: MAX_GROUPS_PER_REQUEST,
  flushMs: 30,
  initialConcurrency: 2,
  minConcurrency: 1,
  maxConcurrency: 4,
  timeoutMs: 16000,
  maxQueue: 8192,
  maxQueueAgeMs: 5000,
  cacheSize: 8192,            // answers kept for exact repeats (0 turns the cache off)
};

export function createDecisionClient(options = {}) {
  const opts = {...DEFAULTS, ...options};
  const fetcher = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.timers?.clearTimeout ?? ((handle) => clearTimeout(handle));
  const budget = {
    questions: clamp(opts.maxQuestions, 1, MAX_QUESTIONS_PER_REQUEST),
    bytes: Math.max(8 * 1024, opts.maxBytes),
    groups: clamp(opts.maxGroups, 1, MAX_GROUPS_PER_REQUEST),
  };

  const queue = new Map();         // key -> entry waiting to be sent
  const inFlightByKey = new Map(); // key -> entry currently being answered
  const latest = new Map();        // key -> newest ask sequence, for stale rejection
  const answers = new Map();       // kind|signature -> answer, least recently used first
  let sequence = 0, generation = 0, forceFlush = false, pumpQueued = false;
  let timer = null, timerDue = Infinity;

  let mode = 'auto', cap = 100;
  const sentLog = [];              // {at, count} for the manual rolling ceiling
  const completions = [];          // {at, count} for observed q/s
  const statesSeen = new Map();    // stateKey -> last used (diagnostics only)
  let lastStateKey = null;

  let inFlight = 0, inFlightQuestions = 0;
  let latencyEma = 0, lastLatencyMs = 0, batchEma = 0, groupsEma = 0, lastBatch = 0;
  let failures = 0, consecutiveFailures = 0, backoffUntil = 0, model = null;
  const counters = {asked: 0, sent: 0, answered: 0, unanswered: 0, dropped: 0, stale: 0, invalid: 0, deduped: 0, splits: 0, cached: 0};
  const tags = {};

  // Adaptive concurrency. An "epoch" is a run of completions at one target.
  let target = clamp(opts.initialConcurrency, opts.minConcurrency, opts.maxConcurrency);
  let epoch = newEpoch(), probe = null, stableEpochs = 0, probeEvery = 2, nextDirection = +1;

  function newEpoch() {
    return {start: now(), firstAt: 0, firstCount: 0, questions: 0, completions: 0, latency: 0, limited: false};
  }

  const tagStats = (tag) => (tags[tag] ??= {asked: 0, answered: 0, nulls: 0});

  const settle = (entry, answer) => {
    for (const w of entry.waiters) {
      if (w.tag) tagStats(w.tag)[answer ? 'answered' : 'nulls']++;
      w.resolve(answer);
    }
    entry.waiters = [];
    if (latest.get(entry.key) === entry.seq) latest.delete(entry.key);
  };

  function ask(kind, id, context, {priority = 0, allowed, state, tag} = {}) {
    counters.asked++;
    tag = typeof tag === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(tag) ? tag : null;
    if (tag) tagStats(tag).asked++;
    let question, cleanState;
    try {
      question = validateQuestion({kind, id, context, ...(allowed ? {allowed} : {})});
      cleanState = validateState(question.kind, state);
    } catch {
      counters.invalid++;
      if (tag) tagStats(tag).nulls++;
      return Promise.resolve(null);
    }
    const key = `${question.kind}:${question.id}`;
    const sKey = stateKey(cleanState);
    const signature = `${sKey}|${JSON.stringify([question.context, question.allowed])}`;
    priority = Number.isFinite(priority) ? priority : 0;
    const hit = answers.get(`${question.kind}|${signature}`);
    if (hit) {
      // Refresh its place in the LRU order.
      answers.delete(`${question.kind}|${signature}`);
      answers.set(`${question.kind}|${signature}`, hit);
      counters.cached++;
      if (tag) tagStats(tag).answered++;
      // Same actor, older question still waiting: this newer one supersedes it.
      const queued = queue.get(key);
      if (queued && queued.signature !== signature) {
        queue.delete(key);
        settle(queued, null);
        counters.stale++;
      }
      // An older, different question for this actor in flight is now stale.
      const flying = inFlightByKey.get(key);
      if (flying && flying.signature !== signature) latest.set(key, ++sequence);
      return Promise.resolve({...hit});
    }
    return new Promise((resolve) => {
      const waiter = {resolve, tag};
      const t = now();
      // Identical question already pending (and not superseded): share its answer.
      const queued = queue.get(key);
      const flying = inFlightByKey.get(key);
      for (const existing of [queued, flying]) {
        if (existing?.signature === signature && latest.get(key) === existing.seq) {
          existing.waiters.push(waiter);
          if (existing === queued) existing.priority = Math.max(existing.priority, priority);
          counters.deduped++;
          return;
        }
      }
      const seq = ++sequence;
      latest.set(key, seq);
      const fields = {context: question.context, allowed: question.allowed, state: cleanState, stateKey: sKey, signature, seq,
        askedAt: t, bytes: estimateBytes(question), stateBytes: JSON.stringify(cleanState).length};
      if (queued) {
        // Same actor, new context or state: the queued question is superseded.
        settle(queued, null);
        counters.stale++;
        Object.assign(queued, fields, {priority: Math.max(queued.priority, priority), waiters: [waiter]});
      } else {
        if (queue.size >= opts.maxQueue && !evictFor(priority)) {
          counters.dropped++;
          if (tag) tagStats(tag).nulls++;
          resolve(null);
          return;
        }
        queue.set(key, {key, kind: question.kind, id: question.id, ...fields, priority, enqueuedAt: t, waiters: [waiter]});
      }
      // A full request with a free slot goes now; otherwise one pump per tick
      // handles every question asked synchronously in this frame.
      if (queue.size >= budget.questions && inFlight < target && t >= backoffUntil) pump();
      else requestPump();
    });
  }

  function estimateBytes(q) {
    return 48 + q.kind.length + JSON.stringify(q.context).length + (q.allowed ? 12 * q.allowed.length : 0);
  }

  function requestPump() {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => { pumpQueued = false; pump(); });
  }

  // Make room by dropping the lowest-priority queued question, if it ranks
  // below the newcomer.
  function evictFor(priority) {
    let lowest = null;
    for (const entry of queue.values()) if (!lowest || entry.priority < lowest.priority) lowest = entry;
    if (!lowest || lowest.priority >= priority) return false;
    queue.delete(lowest.key);
    settle(lowest, null);
    counters.dropped++;
    return true;
  }

  function sentInWindow(t) {
    while (sentLog.length && t - sentLog[0].at >= 1000) sentLog.shift();
    return sentLog.reduce((n, s) => n + s.count, 0);
  }

  function observedRate(t) {
    while (completions.length && t - completions[0].at >= WINDOW_MS) completions.shift();
    return completions.reduce((n, c) => n + c.count, 0) / (WINDOW_MS / 1000);
  }

  function schedule(ms) {
    const due = now() + Math.max(0, ms);
    if (timer !== null && timerDue <= due) return;
    if (timer !== null) clearTimer(timer);
    timerDue = due;
    timer = setTimer(() => { timer = null; timerDue = Infinity; pump(); }, Math.max(0, ms));
  }

  function expire(t) {
    for (const entry of queue.values()) {
      if (t - entry.askedAt > opts.maxQueueAgeMs) {
        queue.delete(entry.key);
        settle(entry, null);
        counters.dropped++;
      }
    }
  }

  function pump() {
    const t = now();
    const force = forceFlush;
    forceFlush = false;
    expire(t);
    while (queue.size) {
      if (t < backoffUntil) return schedule(backoffUntil - t);
      let room = budget.questions;
      if (mode === 'manual') {
        room = Math.min(room, cap - sentInWindow(t));
        if (room <= 0) return schedule(sentLog.length ? sentLog[0].at + 1000 - t : 50);
      }
      let oldest = Infinity, bytes = 0;
      for (const entry of queue.values()) {
        oldest = Math.min(oldest, entry.enqueuedAt);
        bytes += entry.bytes;
      }
      const full = queue.size >= room || bytes >= budget.bytes;
      if (!force && !full && t - oldest < opts.flushMs) return schedule(oldest + opts.flushMs - t);
      if (inFlight >= target) {
        epoch.limited = true; // a ready request is waiting on concurrency
        // The next completion pumps again; meanwhile still expire old questions.
        let oldestAsk = Infinity;
        for (const entry of queue.values()) oldestAsk = Math.min(oldestAsk, entry.askedAt);
        return schedule(oldestAsk + opts.maxQueueAgeMs + 1 - t);
      }
      dispatch(take(room), t);
    }
  }

  // Highest priority first, within the question, byte and state-group budgets.
  function take(maxQuestions) {
    const ordered = [...queue.values()].sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    const groups = new Map();
    let bytes = 0, count = 0;
    for (const entry of ordered) {
      if (count >= maxQuestions) break;
      const isNew = !groups.has(entry.stateKey);
      if (isNew && groups.size >= budget.groups) continue;
      const cost = entry.bytes + (isNew ? entry.stateBytes + 16 : 0);
      if (count && bytes + cost > budget.bytes) continue;
      if (isNew) groups.set(entry.stateKey, []);
      groups.get(entry.stateKey).push(entry);
      bytes += cost;
      count++;
    }
    const batch = [...groups.values()];
    for (const entry of batch.flat()) queue.delete(entry.key);
    return batch;
  }

  function dispatch(groups, t) {
    const batch = groups.flat();
    const gen = generation;
    inFlight++;
    inFlightQuestions += batch.length;
    counters.sent += batch.length;
    sentInWindow(t);   // drop entries over a second old (only the manual ceiling reads them)
    sentLog.push({at: t, count: batch.length});
    for (const entry of batch) inFlightByKey.set(entry.key, entry);
    for (const group of groups) noteState(group[0].stateKey, t);
    // Wire ids are positions in the request, so actor ids never collide across kinds.
    let wire = 0;
    const body = {groups: groups.map((group) => ({
      ...(Object.keys(group[0].state).length ? {state: group[0].state} : {}),
      questions: group.map((e) => ({kind: e.kind, id: String(wire++), context: e.context, ...(e.allowed ? {allowed: e.allowed} : {})})),
    }))};
    send(body)
      .then((result) => complete(groups, batch, result, t, gen))
      .catch(() => complete(groups, batch, {outcome: 'unavailable'}, t, gen));
  }

  function noteState(key, t) {
    statesSeen.delete(key);
    statesSeen.set(key, t);
    lastStateKey = key;
    for (const [k, at] of statesSeen) {
      if (t - at < STATE_WINDOW_MS) break; // insertion order = last use
      statesSeen.delete(k);
    }
  }

  async function send(body) {
    const signal = AbortSignal.timeout(opts.timeoutMs);
    // Enforce the deadline even if a fetch implementation ignores the signal.
    const deadline = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    deadline.catch(() => {});
    const response = await Promise.race([deadline, fetcher(opts.endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal,
    })]);
    if (response.status === 429) {
      const data = await Promise.race([deadline, response.json()]).catch(() => ({}));
      const header = response.headers?.get?.('Retry-After');
      const headerMs = header ? Number(header) * 1000 : NaN;
      return {outcome: 'busy', retryAfterMs: Number.isFinite(data?.retryAfterMs) ? data.retryAfterMs : Number.isFinite(headerMs) ? headerMs : 250};
    }
    if (response.status === 413) return {outcome: 'too-large'};
    if (!response.ok) return {outcome: 'unavailable'};
    const data = await Promise.race([deadline, response.json()]);
    if (!data || typeof data.answers !== 'object' || data.answers === null) return {outcome: 'unavailable'};
    return {outcome: 'ok', data};
  }

  function complete(groups, batch, result, startedAt, gen) {
    const t = now();
    inFlight--;
    inFlightQuestions -= batch.length;
    for (const entry of batch) if (inFlightByKey.get(entry.key) === entry) inFlightByKey.delete(entry.key);
    if (result.outcome === 'ok') succeeded(groups, batch, result.data, t - startedAt, t, gen);
    else if (result.outcome === 'too-large') shrink(batch, gen);
    else failed(batch, result, t, gen);
    pump();
  }

  // The request was too big: halve the budget and send the questions again.
  function shrink(batch, gen) {
    counters.splits++;
    budget.questions = Math.max(1, Math.floor(budget.questions / 2));
    budget.bytes = Math.max(8 * 1024, Math.floor(budget.bytes / 2));
    for (const entry of batch) {
      if (gen !== generation || latest.get(entry.key) !== entry.seq || queue.has(entry.key) || batch.length === 1) settle(entry, null);
      else queue.set(entry.key, entry);
    }
  }

  function succeeded(groups, batch, data, latency, t, gen) {
    consecutiveFailures = 0;
    backoffUntil = 0;
    if (typeof data.model === 'string') model = data.model;
    lastLatencyMs = latency;
    latencyEma = latencyEma ? latencyEma * 0.8 + latency * 0.2 : latency;
    lastBatch = batch.length;
    batchEma = batchEma ? batchEma * 0.8 + batch.length * 0.2 : batch.length;
    groupsEma = groupsEma ? groupsEma * 0.8 + groups.length * 0.2 : groups.length;
    while (completions.length && t - completions[0].at >= WINDOW_MS) completions.shift();
    completions.push({at: t, count: batch.length});
    batch.forEach((entry, i) => {
      if (gen !== generation || latest.has(entry.key) && latest.get(entry.key) !== entry.seq) {
        counters.stale++;
        return settle(entry, null);
      }
      const raw = data.answers[String(i)];
      const answer = raw && raw.kind === entry.kind ? normalizeAnswer(entry, {...raw, type: 'choice'}) : null;
      counters[answer ? 'answered' : 'unanswered']++;
      if (answer) remember(entry, answer);
      settle(entry, answer);
    });
    // Requests dispatched before the epoch began ran at the old target.
    if (t - latency >= epoch.start) {
      if (!epoch.completions) { epoch.firstAt = t; epoch.firstCount = batch.length; }
      epoch.questions += batch.length;
      epoch.completions++;
      epoch.latency += latency;
      adapt(t);
    }
  }

  function remember(entry, answer) {
    if (!(opts.cacheSize > 0)) return;
    const key = `${entry.kind}|${entry.signature}`;
    answers.delete(key);
    answers.set(key, answer);
    if (answers.size > opts.cacheSize) answers.delete(answers.keys().next().value);
  }

  function failed(batch, result, t, gen) {
    failures++;
    consecutiveFailures++;
    for (const entry of batch) settle(entry, null);
    if (gen !== generation) return;
    const busy = result.outcome === 'busy';
    const base = busy ? Math.max(50, result.retryAfterMs) : 1000;
    const delay = Math.min(busy ? 4000 : 15000, base * 2 ** Math.min(6, consecutiveFailures - 1));
    backoffUntil = Math.max(backoffUntil, t + delay);
    // Multiplicative decrease: shed one slot when busy, half on outages.
    probe = null;
    setTarget(busy ? target - 1 : Math.floor(target / 2));
  }

  function setTarget(value) {
    target = clamp(value, opts.minConcurrency, opts.maxConcurrency);
    stableEpochs = 0;
    epoch = newEpoch();
  }

  // Hill-climb the concurrency target in both directions. After a few stable
  // epochs, probe one slot up or down and compare with the baseline epoch:
  //   up   is kept only if throughput rises by more than 5%;
  //   down is kept if throughput holds (>= 95%) and latency falls.
  // Rejected probes are reverted and the next one waits twice as long, so a
  // settled pipeline is disturbed rarely. Only epochs where a ready request
  // was waiting on concurrency are informative; demand-bound ones are skipped.
  function adapt(t) {
    if (epoch.completions < Math.max(4, target * 2) || t - epoch.firstAt < 500) return;
    const rate = (epoch.questions - epoch.firstCount) / ((t - epoch.firstAt) / 1000);
    const latency = epoch.latency / epoch.completions;
    const limited = epoch.limited;
    epoch = newEpoch();
    if (!limited) return;
    if (probe) {
      const base = probe;
      probe = null;
      const kept = base.direction > 0
        ? rate > base.rate * 1.05
        : rate >= base.rate * 0.95 && latency < base.latency;
      if (kept) {
        probeEvery = 2;
        nextDirection = base.direction; // keep climbing the same way
      } else {
        probeEvery = Math.min(32, probeEvery * 2);
        setTarget(base.target);
      }
      return;
    }
    if (++stableEpochs < probeEvery) return;
    let direction = nextDirection;
    if (target + direction > opts.maxConcurrency || target + direction < opts.minConcurrency) direction = -direction;
    if (target + direction > opts.maxConcurrency || target + direction < opts.minConcurrency) return;
    nextDirection = -direction;
    probe = {target, rate, latency, direction};
    setTarget(target + direction);
  }

  function capacityEstimate(t) {
    const theoretical = latencyEma ? target * Math.max(1, batchEma) * 1000 / latencyEma : 0;
    return Math.max(observedRate(t), theoretical);
  }

  function state(t) {
    if (t < backoffUntil) return 'backoff';
    if (mode === 'manual' && sentInWindow(t) >= cap && queue.size) return 'capped';
    if (inFlight >= target && queue.size) return 'saturated';
    if (inFlight) return 'sending';
    if (queue.size) return 'batching';
    return 'idle';
  }

  // How many more questions are worth submitting right now: enough to keep
  // every slot busy plus one ready request, but no more than ~2 s of measured
  // throughput, so callers fill the pipeline without building a backlog.
  function room(t) {
    if (t < backoffUntil) return 0;
    let depth = (target + 1) * budget.questions;
    if (latencyEma) depth = Math.min(depth, Math.max(budget.questions, Math.ceil(2 * capacityEstimate(t))));
    let free = depth - queue.size - inFlightQuestions;
    if (mode === 'manual') free = Math.min(free, cap - sentInWindow(t) - queue.size);
    return Math.max(0, free);
  }

  function stats() {
    const t = now();
    return {
      state: state(t), mode, cap,
      inFlight, inFlightQuestions, queueDepth: queue.size, room: room(t),
      concurrency: target, minConcurrency: opts.minConcurrency, maxConcurrency: opts.maxConcurrency,
      batchSize: batchEma, groupsPerRequest: groupsEma, lastBatch,
      maxQuestions: budget.questions, maxBytes: budget.bytes, maxGroups: budget.groups,
      observedRate: observedRate(t), capacity: capacityEstimate(t),
      latencyMs: latencyEma, lastLatencyMs,
      failures, consecutiveFailures, backoffMs: Math.max(0, backoffUntil - t),
      model, ...counters, cacheSize: answers.size,
      tags: Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, {...v}])),
      states: {distinctLastHour: statesSeen.size, lastKey: lastStateKey},
    };
  }

  function configure({mode: nextMode = mode, cap: nextCap = cap} = {}) {
    mode = nextMode === 'manual' ? 'manual' : 'auto';
    cap = Number.isFinite(nextCap) ? clamp(Math.round(nextCap), 1, 5000) : cap;
    pump();
    return stats();
  }

  // Drop everything pending; in-flight replies are ignored when they land.
  // Cached answers go too: a model switched off and on again may be another model.
  function reset() {
    generation++;
    answers.clear();
    for (const entry of queue.values()) settle(entry, null);
    for (const entry of inFlightByKey.values()) settle(entry, null);
    queue.clear();
    inFlightByKey.clear();
    latest.clear();
    backoffUntil = 0;
    consecutiveFailures = 0;
  }

  // Send whatever is queued without waiting for the coalescing deadline.
  function flush() {
    forceFlush = true;
    pump();
  }

  return {ask, stats, configure, reset, flush};
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
