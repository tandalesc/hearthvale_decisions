// Executed only inside the hosted CPU container. /work is disposable, R2 is durable.
import {mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {hostedDecisions} from '../decision.js';
import {validProbabilities} from '../learning.js';
import {saveTrainingAsset} from './assets.js';
import {labelRows} from './label.js';
import {decisionOptions, FEATURES_VERSION} from '../../src/decision-features.js';
const root = '/work';
const origin = process.env.LEARNING_PUBLIC_ORIGIN;
const job = process.env.LEARNING_JOB_ID;
const token = process.env.LEARNING_JOB_TOKEN;
export function safePath(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe asset path');
  return resolve(root, path);
}
async function api(operation, init = {}, query = '') {
  const response = await fetch(`${origin}/api/learning/jobs/${job}/${operation}${query}`, {...init, headers: {...init.headers, authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`Coordinator ${operation}: HTTP ${response.status}`);
  return response;
}
async function put(name, data) { return api('upload', {method: 'PUT', body: data}, `?name=${name}`); }
function run(args) { return new Promise((resolveRun, reject) => { const child = spawn('node', args, {cwd: '/app', env: {...process.env, LEARNING_WORKDIR: root}, stdio: 'inherit'}); child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Training exited ${code}`))); }); }
export async function main() {
  let completed = false;
  try {
    if (!origin?.startsWith('https://') || !job || !token) throw new Error('Missing job credentials');
    const input = await (await api('input')).json(), assets = input.assets;
    if (input.teacher !== 'd1') throw new Error('Unexpected teacher');
    mkdirSync(root, {recursive: true});
    for (const asset of assets.files) {
      const path = safePath(asset.path); mkdirSync(dirname(path), {recursive: true});
      await saveTrainingAsset(await api('asset', {}, `?key=${encodeURIComponent(asset.key)}`), asset, path);
    }
    // Batched by state, a few requests at a time; no retries: each reserved question has at
    // most one paid attempt (label.js).
    const valid = (row, label) => validProbabilities(label?.probabilities, decisionOptions(row.kind, row.allowed));
    const ask = (state, questions) => {
      if (!process.env.LIQUID_API_KEY) throw new Error('Missing hosted Liquid API key');
      return hostedDecisions(process.env, [{state, questions}], async (r, max) => { const t = await r.text(); if (t.length > max) throw new Error('Oversized teacher response'); return t; });
    };
    if (!process.env.LIQUID_API_KEY && input.rows.some((row) => !(row.label?.model === input.teacher && row.label?.features === FEATURES_VERSION && valid(row, row.label)))) throw new Error('Missing hosted Liquid API key');
    const t0 = Date.now();
    const {rows, labels, requests} = await labelRows(input.rows, {teacher: input.teacher, ask, valid});
    console.log(`labelled ${labels.length}/${input.rows.length} rows in ${requests} teacher requests, ${Math.round((Date.now() - t0) / 1000)} s`);
    await put('labels.json', JSON.stringify(labels));
    if (rows.length < input.minRows) { await api('complete', {method: 'POST', body: JSON.stringify({state: 'skipped', error: 'Insufficient valid labels'})}); completed = true; return; }
    writeFileSync(safePath('novel.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(safePath('novel.jsonl.labels.jsonl'), labels.map(r => JSON.stringify(r)).join('\n') + '\n');
    const state = {...assets, twm: '/app/cloudflare/training/vendor', current: {...assets.current, version: input.base, run: safePath(assets.current.run), bundle: assets.current.bundle}, config: {...assets.config, teacher: input.teacher, novel: 'novel.jsonl', minRows: input.minRows}};
    writeFileSync(safePath('state.json'), JSON.stringify(state));
    await run(['cloudflare/training/loop.js', '--state', safePath('state.json')]);
    const out = safePath(`data/loop/v${input.base + 1}`), report = JSON.parse(readFileSync(`${out}/report.json`, 'utf8'));
    await put('report.json', readFileSync(`${out}/report.json`));
    if (!report.passed) { await api('complete', {method: 'POST', body: JSON.stringify({state: 'failed', error: report.steps.stop ?? 'Model gates rejected candidate'})}); completed = true; return; }
    const bundle = JSON.parse(readFileSync(report.steps.train.bundle, 'utf8'));
    const priorBundle = JSON.parse(readFileSync(safePath(assets.current.bundle), 'utf8'));
    bundle.teacherProvenance = {newLabels: input.teacher, previousBundleTeacher: priorBundle.teacher, migration: assets.teacherMigration ?? null, features: FEATURES_VERSION};
    bundle.teacher = input.teacher;
    bundle.fixture = bundle.fixture.slice(0, 8);
    await put('bundle.json', JSON.stringify(bundle));
    await put('model.pt', readFileSync(`${report.steps.train.run}/model.pt`));
    await put('novel-rows.jsonl', readFileSync(`${out}/novel-rows.jsonl`));
    await api('complete', {method: 'POST', body: JSON.stringify({state: 'succeeded'})}); completed = true;
  } catch (error) {
    if (!completed && origin && job && token) try { await api('complete', {method: 'POST', body: JSON.stringify({state: 'failed', error: String(error.message).slice(0, 1000)})}); } catch {}
    throw error;
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) main().catch(error => { console.error(error.message); process.exitCode = 1; });
