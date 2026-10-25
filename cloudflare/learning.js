// The single coordinator owns ingestion, job leases, label budgets and the release pointer.
// R2 contains immutable private inputs/outputs; only manifest-referenced bundles are public.
import initialManifest from '../public/students/manifest.json' with {type: 'json'};
import {validateQuestion, validateState, stateKey} from '../src/decision-kinds.js';
import {decisionOptions, FEATURES_VERSION} from '../src/decision-features.js';
import {STUDENT_FAMILIES, studentPath} from '../src/student-families.js';
const json = (body, status = 200) => Response.json(body, {status});
const textEncoder = new TextEncoder();
export const REQUIRED_GATES = ['real-play KL', 'real-play KL by traffic', 'no busy kind worse', 'largest option bias', 'young-town bias', 'rare options', 'JS parity', 'size and speed', 'canary towns', 'canary population', 'active kind coverage', 'held-out new rows'];
export const learningKey = (q, state) => `${q.kind}|${stateKey(state)}|${JSON.stringify([q.context, q.allowed])}`;
export async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? textEncoder.encode(value) : value))].map(x => x.toString(16).padStart(2, '0')).join(''); }
const coordinator = env => env.LEARNING_COORDINATOR.getByName('global');
export async function recordLearningReport(env, report) { return coordinator(env).ingest(report); }
export async function recordLearningLabels(env, report) { return coordinator(env).labels(report); }
export async function handleLearningRequest(request, env) {
  const url = new URL(request.url), path = url.pathname.replace(/^\/api\/students\//, '/students/');
  const student = studentPath(path);
  if (student && !STUDENT_FAMILIES[student.family].coordinated) {
    // Static families: the manifest and bundles are assets ('/students/narration/manifest' included).
    return env.ASSETS ? env.ASSETS.fetch(new Request(new URL(`/students/${student.file}`, url), request)) : null;
  }
  if (student?.manifest) return json(await coordinator(env).manifest());
  if (student) {
    const manifest = await coordinator(env).manifest(), key = manifest.artifacts?.[student.version];
    if (!key) return null; // Existing bundled versions can fall through to ASSETS.
    const object = await env.STUDENT_ARTIFACTS.get(key);
    return object ? new Response(object.body, {headers: {'content-type': 'application/json', 'cache-control': 'public,max-age=31536000,immutable'}}) : json({error: 'Bundle unavailable'}, 503);
  }
  if (!path.startsWith('/api/learning/')) return null;
  if (path.startsWith('/api/learning/jobs/')) return coordinator(env).fetch(request);
  if (!env.LEARNING_ADMIN_SECRET || request.headers.get('authorization') !== `Bearer ${env.LEARNING_ADMIN_SECRET}`) return json({error: 'Unauthorized'}, 401);
  if (path === '/api/learning/trigger' && request.method === 'POST') return json(await coordinator(env).trigger());
  if (path === '/api/learning/status') return json(await coordinator(env).status());
  return json({error: 'Not found'}, 404);
}
export class LearningCoordinator {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  exclusive(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async manifest() { return await this.ctx.storage.get('manifest') ?? {...structuredClone(this.env.INITIAL_STUDENT_MANIFEST ?? initialManifest), artifacts: {}}; }
  async scheduleAlarm(at) { const existing = await this.ctx.storage.getAlarm(); if (existing === null || existing > at) await this.ctx.storage.setAlarm(at); }
  async status() { const job = await this.ctx.storage.get('job'); return {manifest: await this.manifest(), job: job ? {...job, token: undefined} : null}; }
  ingest({questions, client}) { return this.exclusive(async () => {
    if (!Array.isArray(questions) || questions.length > 64 || !client) throw new Error('Invalid report');
    const who = await digest(`${this.env.AUTH_SECRET}|learning|${client}`), now = Date.now();
    let count = (await this.ctx.storage.list({prefix: 'q:'})).size, logged = 0, repeats = 0, rejected = 0;
    const day = new Date().toISOString().slice(0, 10), clientKey = `client:${day}:${who}`;
    let clientCount = await this.ctx.storage.get(clientKey) ?? 0;
    for (const input of questions) {
      try {
        if (!['confidence', 'unknown', 'kind'].includes(input.reason)) throw new Error('reason');
        const q = validateQuestion({kind: input.kind, id: 'n', context: input.context, ...(input.allowed ? {allowed: input.allowed} : {})});
        const state = validateState(q.kind, input.state), key = learningKey(q, state), id = `q:${await digest(key)}`;
        const old = await this.ctx.storage.get(id);
        if (old || await this.ctx.storage.get(id.replace('q:', 'trained:'))) { repeats++; continue; }
        if (count >= Number(this.env.LEARNING_MAX_REPORTS ?? 20000) || clientCount >= 400) { rejected++; continue; }
        await this.ctx.storage.put(id, {key, ...q, state, client: who, reason: input.reason, at: new Date(now).toISOString(), features: FEATURES_VERSION, schemaVersion: input.schemaVersion ?? 1, studentVersion: Number.isInteger(input.studentVersion) ? input.studentVersion : null, teacher: this.env.DECISIONS_TEACHER_MODEL, label: await this.ctx.storage.get(`l:${await digest(key)}`)});
        count++; clientCount++; logged++;
      } catch { rejected++; }
    }
    await this.ctx.storage.put(clientKey, clientCount);
    await this.scheduleAlarm(now + 60000);
    return {logged, repeats, rejected};
  }); }
  labels({groups, answers, model}) { return this.exclusive(async () => {
    if (model !== this.env.DECISIONS_TEACHER_MODEL) return {stored: 0};
    let stored = 0;
    for (const {state, questions} of groups) for (const q of questions) {
      const key = learningKey(q, state), id = `q:${await digest(key)}`, row = await this.ctx.storage.get(id);
      const probabilities = answers[q.id]?.probabilities, options = decisionOptions(q.kind, q.allowed);
      if (!validProbabilities(probabilities, options)) continue;
      const label = {key, kind: q.kind, probabilities, model, features: FEATURES_VERSION, at: new Date().toISOString()};
      if (row) await this.ctx.storage.put(id, {...row, label});
      else if ((await this.ctx.storage.list({prefix: 'l:', limit: Number(this.env.LEARNING_MAX_REPORTS ?? 20000)})).size >= Number(this.env.LEARNING_MAX_REPORTS ?? 20000)) continue;
      await this.ctx.storage.put(`l:${await digest(key)}`, label); stored++;
    }
    return {stored};
  }); }
  scheduled() { return this.trigger(); }
  trigger() { return this.exclusive(async () => {
    const active = await this.ctx.storage.get('job');
    if (active && ['dispatching', 'running'].includes(active.state)) return {id: active.id, state: active.state};
    const rows = [...(await this.ctx.storage.list({prefix: 'q:'})).values()];
    const minRows = Number(this.env.LEARNING_MIN_ROWS ?? 50);
    if (rows.length < minRows) return {state: 'skipped', reason: 'insufficient reports', rows: rows.length};
    if (!this.env.LEARNING_PUBLIC_ORIGIN || !this.env.DECISIONS_TEACHER_MODEL) return {state: 'blocked', reason: 'missing origin or teacher model'};
    const bootstrap = await this.env.STUDENT_ARTIFACTS.get('bootstrap/config.json');
    const assets = await this.ctx.storage.get('assets') ?? (bootstrap ? await bootstrap.json() : null);
    if (!assets) return {state: 'blocked', reason: 'bootstrap assets unavailable'};
    const manifest = await this.manifest();
    if (assets.current?.version !== manifest.latest) return {state: 'blocked', reason: 'Bootstrap checkpoint version must match latest release'};
    const day = new Date().toISOString().slice(0, 10), budgetKey = `budget:${day}`;
    const used = await this.ctx.storage.get(budgetKey) ?? 0, remaining = Math.max(0, Number(this.env.LEARNING_DAILY_LABEL_CAP ?? 10000) - used);
    const labelled = rows.filter(r => r.label?.model === this.env.DECISIONS_TEACHER_MODEL && r.label?.features === FEATURES_VERSION);
    const missing = rows.filter(r => !labelled.includes(r)).slice(0, remaining);
    const selected = [...labelled, ...missing].slice(0, Number(this.env.LEARNING_MAX_JOB_ROWS ?? 10000));
    if (selected.length < minRows) return {state: 'skipped', reason: 'label budget', rows: selected.length};
    const reserved = selected.filter(r => !labelled.includes(r)).length;
    const id = crypto.randomUUID(), token = crypto.randomUUID() + crypto.randomUUID();
    const job = {id, token, base: manifest.latest, state: 'dispatching', attempts: 0, started: Date.now(), expires: Date.now() + 90 * 60000, reserved, day};
    // Reserve before dispatch: ambiguous crashes/retries never exceed today's cap.
    await this.ctx.storage.put(budgetKey, used + reserved);
    await this.env.STUDENT_ARTIFACTS.put(`jobs/${id}/input.json`, JSON.stringify({rows: selected, assets, teacher: this.env.DECISIONS_TEACHER_MODEL, base: job.base, minRows}));
    await this.ctx.storage.put('job', job);
    await this.dispatch(job);
    return {id, state: job.state};
  }); }
  async cleanupJob(id) {
    const keys = [`jobs/${id}/input.json`, ...['bundle.json', 'model.pt', 'novel-rows.jsonl', 'labels.json', 'report.json'].map(name => `jobs/${id}/outputs/${name}`)];
    for (const key of keys) await this.env.STUDENT_ARTIFACTS.delete(key);
  }
  async dispatch(job) {
    job.attempts++;
    await this.ctx.storage.put('job', job);
    await this.scheduleAlarm(Date.now() + 60000);
    try {
      await this.env.LEARNING_CONTAINER.getByName(job.id).startJob({id: job.id, token: job.token, origin: this.env.LEARNING_PUBLIC_ORIGIN});
      job.state = 'running'; await this.ctx.storage.put('job', job);
    } catch (error) { job.error = String(error.message).slice(0, 300); await this.ctx.storage.put('job', job); }
  }
  alarm() { return this.exclusive(async () => {
    const now = Date.now(), job = await this.ctx.storage.get('job');
    // Bound retained reports and per-client accounting independently of job success.
    for (const [key, label] of await this.ctx.storage.list({prefix: 'l:'})) if (Date.parse(label.at) < now - 30 * 86400000) await this.ctx.storage.delete(key);
    for (const [key, row] of await this.ctx.storage.list({prefix: 'q:'})) if (Date.parse(row.at) < now - 30 * 86400000) await this.ctx.storage.delete(key);
    for (const [key] of await this.ctx.storage.list({prefix: 'client:'})) if (key.slice(7, 17) !== new Date().toISOString().slice(0, 10)) await this.ctx.storage.delete(key);
    for (const [key] of await this.ctx.storage.list({prefix: 'budget:'})) if (key.slice(7) !== new Date().toISOString().slice(0, 10)) await this.ctx.storage.delete(key);
    if (!job || !['dispatching', 'running'].includes(job.state)) return;
    if (now > job.expires) { job.state = 'failed'; job.error = 'Job lease expired'; await this.ctx.storage.put('job', job); try { await this.env.LEARNING_CONTAINER.getByName(job.id).stopJob(); } catch {} await this.cleanupJob(job.id); return; }
    if (job.state === 'dispatching' && job.attempts < 3) await this.dispatch(job);
    else if (job.state === 'dispatching') { job.state = 'failed'; await this.ctx.storage.put('job', job); await this.cleanupJob(job.id); }
    await this.scheduleAlarm(now + 60000);
  }); }
  async fetch(request) {
    const job = await this.ctx.storage.get('job'), url = new URL(request.url);
    const match = /^\/api\/learning\/jobs\/([^/]+)\/(input|asset|upload|complete)$/.exec(url.pathname);
    if (!job || !match || match[1] !== job.id || request.headers.get('authorization') !== `Bearer ${job.token}` || Date.now() > job.expires || !['dispatching', 'running'].includes(job.state)) return json({error: 'Invalid job lease'}, 403);
    if (match[2] === 'input' && request.method === 'GET') { const object = await this.env.STUDENT_ARTIFACTS.get(`jobs/${job.id}/input.json`); return new Response(object.body); }
    if (match[2] === 'asset' && request.method === 'GET') {
      const input = await (await this.env.STUDENT_ARTIFACTS.get(`jobs/${job.id}/input.json`)).json(), key = url.searchParams.get('key');
      if (!input.assets.files?.some(file => file.key === key)) return json({error: 'Unknown asset'}, 403);
      const object = await this.env.STUDENT_ARTIFACTS.get(key); return object ? new Response(object.body) : json({error: 'Missing asset'}, 404);
    }
    if (match[2] === 'upload' && request.method === 'PUT') {
      const name = url.searchParams.get('name');
      if (!['bundle.json', 'model.pt', 'novel-rows.jsonl', 'labels.json', 'report.json'].includes(name)) return json({error: 'Invalid artifact'}, 400);
      const length = Number(request.headers.get('content-length'));
      if (!length || length > 16 * 1024 * 1024) return json({error: 'Artifact size required and limited to 16 MiB'}, 413);
      const reader = request.body.getReader(), chunks = []; let size = 0;
      while (true) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 16 * 1024 * 1024) { await reader.cancel(); return json({error: 'Artifact too large'}, 413); } chunks.push(value); }
      const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      if (body.byteLength > 16 * 1024 * 1024) return json({error: 'Artifact too large'}, 413);
      const sha256 = await digest(body), key = `jobs/${job.id}/outputs/${name}`;
      const existing = await this.env.STUDENT_ARTIFACTS.head(key);
      if (existing && existing.customMetadata?.sha256 !== sha256) return json({error: 'Immutable artifact conflict'}, 409);
      if (!existing) await this.env.STUDENT_ARTIFACTS.put(key, body, {customMetadata: {sha256}});
      return json({key, sha256});
    }
    if (match[2] === 'complete' && request.method === 'POST') return this.exclusive(() => this.complete(job.id, request));
    return json({error: 'Unsupported operation'}, 405);
  }
  async complete(id, request) {
    // Re-read inside serialization: an old completion cannot publish over a newer lease.
    const job = await this.ctx.storage.get('job');
    if (job?.id !== id || !['dispatching', 'running'].includes(job.state)) return json({error: 'Stale job'}, 409);
    const result = await request.json();
    const labelObject = await this.env.STUDENT_ARTIFACTS.get(`jobs/${id}/outputs/labels.json`);
    if (labelObject) for (const label of await labelObject.json()) {
      const key = `q:${await digest(label.key)}`, row = await this.ctx.storage.get(key);
      if (row && label.model === this.env.DECISIONS_TEACHER_MODEL && label.features === FEATURES_VERSION && validProbabilities(label.probabilities, decisionOptions(row.kind, row.allowed))) await this.ctx.storage.put(key, {...row, label});
    }
    if (result.state !== 'succeeded') { job.state = result.state === 'skipped' ? 'skipped' : 'failed'; job.error = String(result.error ?? '').slice(0, 1000); await this.ctx.storage.put('job', job); await this.cleanupJob(job.id); return json({state: job.state}); }
    const input = await (await this.env.STUDENT_ARTIFACTS.get(`jobs/${id}/input.json`)).json();
    const reportObject = await this.env.STUDENT_ARTIFACTS.get(`jobs/${id}/outputs/report.json`);
    const report = reportObject && await reportObject.json();
    if (!report?.passed || !REQUIRED_GATES.every(g => report.gates?.[g]?.pass === true) || report.gates?.['held-out new rows']?.pass === false) return json({error: 'Candidate failed gates'}, 422);
    const manifest = await this.manifest();
    if (manifest.latest !== job.base) return json({error: 'Stale base version'}, 409);
    const version = manifest.latest + 1, prefix = `jobs/${id}/outputs/`;
    for (const name of ['bundle.json', 'model.pt', 'novel-rows.jsonl']) if (!await this.env.STUDENT_ARTIFACTS.head(prefix + name)) return json({error: `Missing ${name}`}, 422);
    const bundle = await (await this.env.STUDENT_ARTIFACTS.get(prefix + 'bundle.json')).json();
    if (bundle.version !== version || bundle.features !== FEATURES_VERSION) return json({error: 'Bundle provenance mismatch'}, 422);
    const assets = {...input.assets, current: {...input.assets.current, version, run: 'checkpoint', bundle: 'current.json'}, train: [...input.assets.train, `corpus/${id}.jsonl`]};
    assets.files = input.assets.files.filter(f => !['checkpoint/model.pt', 'current.json'].includes(f.path)).concat([
      {path: 'checkpoint/model.pt', key: prefix + 'model.pt'}, {path: 'current.json', key: prefix + 'bundle.json'}, {path: `corpus/${id}.jsonl`, key: prefix + 'novel-rows.jsonl'},
    ]);
    manifest.latest = version; manifest.versions[version] = `decisions.v${version}.json`; manifest.artifacts ??= {}; manifest.artifacts[version] = prefix + 'bundle.json';
    job.state = 'published'; job.version = version; job.token = null;
    const consumed = new Set(Array.isArray(report.consumedHashes) ? report.consumedHashes : []);
    const consumedKeys = []; for (const row of input.rows) { const hash = await digest(row.key); if (consumed.has(hash)) consumedKeys.push(hash); }
    await this.ctx.storage.transaction(async storage => { await storage.put('manifest', manifest); await storage.put('assets', assets); await storage.put('job', job); for (const hash of consumedKeys) { await storage.delete(`q:${hash}`); await storage.put(`trained:${hash}`, version); } });
    return json({state: 'published', version});
  }
}
export function validProbabilities(probabilities, options) { return !!probabilities && options.every(o => Number.isFinite(probabilities[o]) && probabilities[o] >= 0 && probabilities[o] <= 1) && Object.keys(probabilities).length === options.length && Math.abs(options.reduce((s, o) => s + probabilities[o], 0) - 1) < 0.001; }
export class LearningContainer {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async startJob({id, token, origin}) {
    if (await this.ctx.storage.get('dispatched')) return {started: true};
    await this.ctx.storage.put('dispatched', true);
    if (!this.ctx.container.running) this.ctx.container.start({image: this.ctx.container.images.base, instance: 'standard-4', enableInternet: true, env: {
      LEARNING_JOB_ID: id, LEARNING_JOB_TOKEN: token, LEARNING_PUBLIC_ORIGIN: origin,
      LIQUID_API_KEY: this.env.LIQUID_API_KEY ?? '', DECISIONS_TEACHER_MODEL: this.env.DECISIONS_TEACHER_MODEL ?? '',
      OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', CUDA_VISIBLE_DEVICES: '',
    }});
    // Do not await monitor(): cron must return before the 15 minute CPU/wall limit.
    return {started: true};
  }
  async stopJob() { this.ctx.container.destroy(); }
}
