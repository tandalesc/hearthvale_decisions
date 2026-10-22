// Answers decision questions locally with a student model where one exists,
// and passes the rest to the decision client (docs/design/decision-distillation.md §4).
//
//   const bus = createLocalAnswerer({client});
//   await bus.load('/students/decisions.v1.json');   // optional; until then everything passes through
//   bus.ask(kind, id, context, {allowed, state, ...}) // the client's ask
//
// Same interface as the client (ask, stats, configure, reset, flush), so the
// scheduler and the session do not change. A question for a kind a student
// knows is validated as the client would and answered locally; its answer has
// the client's shape with `model: 'student:...'`. The order stays student,
// then service, then local rules (the scheduler's fallbacks).
//
// Student work is held to `budgetMs` per turn of the event loop: a month-start
// sweep can ask 50+ questions in one tick (and encode a new snapshot for each
// district), so past the budget questions wait in a queue and are answered on
// the next turns, as network answers would arrive. Answers are unchanged; only
// when they land moves.
//
// Unfamiliar questions are logged for the batch loop (design §7), never
// answered differently: an answer whose expected KL (the bundle's confidence
// head) is at or above the bundle's 95th-percentile threshold, one with input
// values the student does not know, and every question of a kind no student
// answers. They are deduplicated per session and posted in batches (game state
// only, no ids) to `report.endpoint`; a failed post is dropped.
//
// The live teacher. When the service is up (the client's state is not backoff
// or offline), some questions go to the decision model instead of the student:
//   - every question with input values the student does not know, first;
//   - the questions the student is least sure of: those whose expected KL is in
//     the top `live.share` (default 10%) by the bundle's quantiles. The share
//     tapers as the game asks faster, so that live questions stay near
//     `live.maxRate` a second (default 1): at 10 student questions a second
//     the top 10% go live, at 100 the top 1%, always the least sure first;
//   - a token bucket at `live.maxRate` (two seconds of burst) caps all of them.
// Live questions go straight to `live.endpoint` marked X-Hearthvale-Live, where
// the proxy holds a budget shared by every player (server/system1.js
// liveLimits). When it is spent the proxy answers 429; the student's answer is
// used and live questions pause for the time it gives. The student answers
// every question anyway, so whenever the teacher returns nothing its answer is
// used. The weights never change within a save.
import {validateQuestion, validateState, stateKey} from './decision-kinds.js';
import {loadStudent} from './decision-student.js';

const BUDGET_MS = 4;

export function createLocalAnswerer({client, students = [], budgetMs = BUDGET_MS, now = () => performance.now(),
  defer = (fn) => setTimeout(fn, 0), report = null, live = {}} = {}) {
  const liveCfg = {share: 0.1, maxRate: 1, endpoint: '/api/decisions', fetcher: (...a) => globalThis.fetch(...a), ...live};
  let livePausedUntil = 0;
  // One live question to the proxy; -> the answer, or null (the student's is used).
  async function teach(kind, context, allowed, state) {
    try {
      const r = await liveCfg.fetcher(liveCfg.endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Hearthvale-Live': '1'},
        body: JSON.stringify({groups: [{...(Object.keys(state).length ? {state} : {}), questions: [{kind, id: '0', context, ...(allowed ? {allowed} : {})}]}]})});
      if (r.status === 429 || r.status === 503) {
        const data = await r.json().catch(() => ({}));
        livePausedUntil = now() + (Number.isFinite(data?.retryAfterMs) ? data.retryAfterMs : 1000);
        counters.liveRefused++;
        return null;
      }
      if (!r.ok) return null;
      const a = (await r.json())?.answers?.['0'];
      return a && a.kind === kind && a.probabilities ? a : null;
    } catch {
      return null;
    }
  }
  // Live budget: a token bucket (maxRate a second, two seconds' burst) and the
  // student's question rate over the last few seconds.
  const bucket = {tokens: liveCfg.maxRate * 2, at: now()};
  const rate = {count: 0, since: now(), perSecond: 0};
  function takeToken() {
    const t = now();
    if (t < livePausedUntil) return false;
    bucket.tokens = Math.min(liveCfg.maxRate * 2, bucket.tokens + (t - bucket.at) * liveCfg.maxRate / 1000);
    bucket.at = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  function noteQuestion() {
    const t = now();
    rate.count++;
    if (t - rate.since >= 2000) {
      const r = rate.count * 1000 / (t - rate.since);
      rate.perSecond = rate.perSecond ? 0.5 * rate.perSecond + 0.5 * r : r;
      rate.count = 0;
      rate.since = t;
    }
  }
  // The expected-KL threshold that sends the top `share` of questions live, from
  // the bundle's quantile ladder [[q, value], ...] (linear between rungs).
  function liveThreshold(student) {
    const ladder = student.quantiles;
    if (!ladder?.length || liveCfg.share <= 0) return Infinity;
    const share = Math.min(liveCfg.share, rate.perSecond > 0 ? liveCfg.maxRate / rate.perSecond : liveCfg.share);
    const q = 1 - share;
    if (q <= ladder[0][0]) return ladder[0][1];
    for (let i = 1; i < ladder.length; i++) {
      if (q <= ladder[i][0]) {
        const [q0, v0] = ladder[i - 1], [q1, v1] = ladder[i];
        return v0 + (v1 - v0) * (q - q0) / (q1 - q0);
      }
    }
    return ladder.at(-1)[1];
  }
  const byKind = new Map();
  const counters = {answered: 0, invalid: 0, deferred: 0, flagged: 0, reported: 0, taught: 0, taughtUnsure: 0, teacherEmpty: 0, liveRefused: 0};
  const serviceUp = () => {
    const st = client.stats?.();
    return !!st && st.state !== 'backoff' && st.network !== 'offline';
  };
  const rep = report && {endpoint: '/api/decisions/novel', flushMs: 30000, maxBatch: 64, perSession: 5000,
    fetcher: (...a) => globalThis.fetch(...a), timer: (fn, ms) => setTimeout(fn, ms), ...report};
  const flaggedKeys = new Set(), outbox = [];
  const invalidBy = {};   // kind -> {count, last error}: questions the checks refused
  let flushTimer = null;
  function flag(kind, state, context, allowed, reason, expectedKL) {
    if (!rep || flaggedKeys.size >= rep.perSession) return;
    const key = `${kind}|${stateKey(state)}|${JSON.stringify([context, allowed])}`;
    if (flaggedKeys.has(key)) return;
    flaggedKeys.add(key);
    counters.flagged++;
    outbox.push({kind, context, ...(allowed ? {allowed} : {}), state, reason, ...(expectedKL != null ? {expectedKL: Math.round(expectedKL * 1e5) / 1e5} : {})});
    if (outbox.length >= rep.maxBatch) flush();
    else if (!flushTimer) flushTimer = rep.timer(flush, rep.flushMs);
  }
  function flush() {
    flushTimer = null;
    if (!outbox.length) return;
    const questions = outbox.splice(0, rep.maxBatch);
    counters.reported += questions.length;
    Promise.resolve().then(() => rep.fetcher(rep.endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({questions})}))
      .catch(() => {});
    if (outbox.length) flushTimer = rep.timer(flush, rep.flushMs);
  }
  const add = (student) => { for (const kind of student.kinds) byKind.set(kind, student); };
  students.forEach(add);

  // The current turn's student time; reset (and the queue drained) on the next turn.
  let slice = null;
  const queue = [];
  function currentSlice() {
    if (!slice) {
      slice = {used: 0};
      // Only a waiting queue opens the next turn's budget, so an idle answerer
      // leaves no timer running.
      defer(() => { slice = null; if (queue.length) drain(); });
    }
    return slice;
  }
  function run(job) {
    const s = currentSlice(), t0 = now();
    const answer = job.student.answer(job.kind, job.state, job.context, job.allowed);
    s.used += now() - t0;
    counters.answered++;
    const threshold = job.student.thresholds?.threshold_p95 ?? Infinity;
    if (answer.unknown > 0) flag(job.kind, job.state, job.context, job.allowed, 'unknown', answer.expectedKL);
    else if (answer.expectedKL != null && answer.expectedKL >= threshold) flag(job.kind, job.state, job.context, job.allowed, 'confidence', answer.expectedKL);
    return answer;
  }
  // The student's answer, or the teacher's when the student is among the least sure.
  function answerOrTeach(job) {
    const answer = run(job);
    if (answer.expectedKL != null && answer.expectedKL >= liveThreshold(job.student) && serviceUp() && takeToken()) {
      counters.taughtUnsure++;
      return teach(job.kind, job.context, job.allowed, job.state).then((a) => {
        if (a) return a;
        counters.teacherEmpty++;
        return answer;
      });
    }
    return answer;
  }
  function drain() {
    const s = currentSlice();
    while (queue.length && s.used < budgetMs) {
      const job = queue.shift();
      job.resolve(answerOrTeach(job));
    }
  }

  function ask(kind, id, context, opts = {}) {
    const student = byKind.get(kind);
    if (!student) {
      // No student for this kind: the service answers; log it so a later student can.
      if (rep) {
        try {
          const q = validateQuestion({kind, id, context, ...(opts.allowed ? {allowed: opts.allowed} : {})});
          flag(q.kind, validateState(q.kind, opts.state), q.context, q.allowed, 'kind');
        } catch { /* invalid: the client rejects it too */ }
      }
      return client.ask(kind, id, context, opts);
    }
    let question, state;
    try {
      question = validateQuestion({kind, id, context, ...(opts.allowed ? {allowed: opts.allowed} : {})});
      state = validateState(question.kind, opts.state);
    } catch (err) {
      counters.invalid++;
      invalidBy[kind] = {count: (invalidBy[kind]?.count ?? 0) + 1, last: String(err?.message ?? err)};
      return Promise.resolve(null);
    }
    const job = {student, kind: question.kind, state, context: question.context, allowed: question.allowed, ask: [kind, id, context, opts]};
    noteQuestion();
    if (student.unknownIn && student.unknownIn(question.kind, state, question.context) > 0) {
      flag(question.kind, state, question.context, question.allowed, 'unknown');
      if (serviceUp() && takeToken()) {
        counters.taught++;
        // The teacher's answer, or else the student's (computed only if needed).
        return teach(job.kind, job.context, job.allowed, job.state).then((a) => a ?? (counters.teacherEmpty++, run(job)));
      }
    }
    if (!queue.length && currentSlice().used < budgetMs) return Promise.resolve(answerOrTeach(job));
    counters.deferred++;
    return new Promise((resolve) => queue.push({...job, resolve}));
  }

  // Fetches a bundle and starts answering its kinds. Returns the kinds, or null
  // (and keeps passing through) when it cannot load.
  async function load(url, fetcher = (...a) => globalThis.fetch(...a)) {
    try {
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const student = loadStudent(await response.json());
      add(student);
      return [...student.kinds];
    } catch (err) {
      console.warn(`[hearthvale] decision student ${url} not loaded; asking the service`, err);
      return null;
    }
  }

  // Replaces every loaded student with this bundle's (a different version).
  async function use(url, fetcher) {
    const previous = new Map(byKind);
    byKind.clear();
    const kinds = await load(url, fetcher);
    if (!kinds) for (const [k, v] of previous) byKind.set(k, v);
    return kinds;
  }

  return {
    ask,
    load,
    use,
    stats: () => ({...client.stats(), local: {...counters, queued: queue.length, kinds: [...byKind.keys()], invalidBy: {...invalidBy},
      students: [...new Set(byKind.values())].map((st) => ({model: st.model, version: st.version, id: st.id})),
      studentRate: Math.round(rate.perSecond), liveShare: rate.perSecond > 0 ? Math.min(liveCfg.share, liveCfg.maxRate / rate.perSecond) : liveCfg.share}}),
    configure: (settings) => client.configure(settings),
    reset: () => client.reset(),
    flush: () => { client.flush(); if (rep) flush(); },
  };
}

// Which student version answers, per design §7: a new town starts on the latest
// published version; a save keeps the version it started with (pinned in its
// governance state), so a town never changes temper mid-game. `base` is the
// students directory, holding manifest.json {latest, versions: {n: file}}.
export function createStudentVersions({answerer, base, fetcher = (...a) => globalThis.fetch(...a)}) {
  let manifest = null, current = null;
  const urlOf = (v) => new URL(manifest.versions[v], base).href;
  async function switchTo(v) {
    if (v === current) return true;
    const kinds = await answerer.use(urlOf(v), fetcher);
    if (kinds) current = v;
    return !!kinds;
  }
  return {
    async start() {
      try {
        const r = await fetcher(new URL('manifest.json', base).href);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        manifest = await r.json();
      } catch (err) {
        console.warn('[hearthvale] no decision students published; asking the service', err);
        return null;
      }
      await switchTo(String(manifest.latest));
      return current;
    },
    // Called when a town opens: new towns take the latest version, saves their own.
    async pin(state, isNew) {
      if (!manifest) return null;
      const gov = (state.governance ??= {});
      const want = isNew || gov.studentVersion == null ? String(manifest.latest) : String(gov.studentVersion);
      if (!manifest.versions[want]) {
        console.warn(`[hearthvale] decision student v${want} is no longer published; using v${manifest.latest}`);
        await switchTo(String(manifest.latest));
      } else {
        await switchTo(want);
      }
      gov.studentVersion = current;
      return current;
    },
    get version() { return current; },
  };
}
