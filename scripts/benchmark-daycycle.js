// Per-frame cost across the drawn day at high speed. In seasonal mode the year
// carries the day (daylight.js): at 20x a year, and so a whole day, passes in
// about 6 s, so a few minutes covers dozens of dawns. Every drawn frame is
// recorded with its phase of day, its animation-frame interval (raf; over 25 ms
// is a missed frame), the frame callback's CPU split into view sync / world /
// UI, the sim step, the renderer's per-stage CPU, GPU time
// (EXT_disjoint_timer_query_webgl2), whether the shadow map re-rendered and how
// much mist was drawn. The summary buckets frames by phase and compares dawn and
// early morning (phase 0.2-0.4) with the rest of the day, and a CPU profile is
// split the same way (main-thread work between frames counts toward the next).
//
// The sim step: with the sim worker (hearthvale.simHost 'worker') it is off this
// thread, read from each step's reply (host.onStep: the worker's step and view-sync
// time), and the main thread's share is applying the reply to the render mirror
// (apply). On the main thread (?simWorker=0) it runs in a task of its own after the
// frame (host.onStep too; on a build without a host, hearthvale.view().stepMs, and
// before that the rest of the frame callback).
// --inline runs the town with ?simWorker=0.
//
// node scripts/benchmark-daycycle.js --speed=20 --duration=30000 --dpr=2
// Options: --quality=high --save=PATH (in place of the city fixture)
// --distance=120 (close camera) --out=DIR --chrome=PATH --port=5214.
// --ab=mist|shadow alternates that feature off and on every 30 drawn frames
// and reports GPU time for each half (same run, so machine load hits both alike).
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {writeFileSync, mkdirSync, readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';

const opts = Object.fromEntries(process.argv.slice(2).map((x) => x.replace(/^--/, '').split('=')));
const out = resolve(opts.out ?? resolve(tmpdir(), 'hearthvale-daycycle'));
const duration = Number(opts.duration ?? 30000), warmup = Number(opts.warmup ?? 6000);
const speed = Number(opts.speed ?? 20), dpr = Number(opts.dpr ?? 2), quality = opts.quality ?? 'high';
const label = opts.label ?? `daycycle-${quality}-${speed}x`;
mkdirSync(out, {recursive: true});
const saveText = opts.save ? readFileSync(resolve(opts.save), 'utf8') : null;

const server = await createServer({
  plugins: [{name: 'benchmark-save', configureServer(srv) {
    if (saveText) srv.middlewares.use((req, res, next) => {
      if (req.url !== '/src/sim/fixtures/city.json') return next();
      res.setHeader('content-type', 'application/json');
      res.end(saveText);
    });
  }}],
  configFile: resolve('vite.config.js'), logLevel: 'error',
  server: {host: '127.0.0.1', port: Number(opts.port ?? 5214), strictPort: false, hmr: false, watch: null},
});
await server.listen();
const base = `http://127.0.0.1:${server.config.server.port}`;
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = opts.chrome ?? process.env.CHROME_PATH ?? (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({executablePath: chrome, headless: true, args: [
  ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--enable-gpu', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
]});

try {
  const ctx = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: dpr});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (r) => r.fulfill({status: 503, body: '{}'}));
  await page.addInitScript((q) => {
    Object.defineProperty(navigator, 'getBattery', {configurable: true, value: async () => ({charging: true, level: 1, addEventListener() {}, removeEventListener() {}})});
    localStorage.setItem('hearthvale-model-enabled', 'false');
    localStorage.setItem('hearthvale-ui', JSON.stringify({quality: q, batterySaver: 'off', dayCycle: 'seasonal', motion: 'full', moments: 'never', muted: true, peopleShadows: 'blob'}));
    localStorage.setItem('hearthvale-ui-seen', JSON.stringify(['explain:docket', 'explain:rules', 'explain:people', 'explain:chronicle', 'explain:tensions', 'explain:overlays', 'explain:council']));
    // Time the whole animation-frame callback.
    const raf = window.requestAnimationFrame.bind(window);
    window.__day = {active: false, frames: [], last: null, cur: null};
    window.requestAnimationFrame = (fn) => raf((time) => {
      if (fn.name !== 'frame') return fn(time);
      const d = window.__day, start = performance.now();
      d.cur = d.active ? {raf: d.last === null ? 0 : time - d.last, t0: start, sync: 0, ui: 0} : null;
      d.last = time;
      const r = fn(time);
      if (d.cur?.world !== undefined) { d.cur.cpu = performance.now() - start; d.frames.push(d.cur); }
      d.cur = null;
      return r;
    });
  }, quality);
  await page.goto(`${base}/?fixture=city${opts.inline ? '&simWorker=0' : ''}`);
  await page.waitForFunction(() => window.hearthvale?.renderer === 'real', null, {timeout: 60000});
  const initial = await page.evaluate(async ({quality, speed, distance}) => {
    const h = window.hearthvale, w = h.world, d = window.__day;
    // Steps answered and mirror applies since the last drawn frame count toward it.
    d.steps = [];
    d.applyMs = 0;
    h.host?.onStep?.((r) => d.steps.push({ms: r.ms, syncMs: r.syncMs ?? 0}));
    const mirror = h.host?.mirror;
    if (mirror) {
      const apply = mirror.apply;
      mirror.apply = function (...a) { const t = performance.now(); const r = apply.apply(this, a); d.applyMs += performance.now() - t; return r; };
    }
    w.setQuality(quality);
    w.setBatterySaver('off');
    h.setSpeed(speed);
    if (distance) { const c = w.camera.controls.target.clone(); w.camera.home(c.x, c.z, distance); }
    const {renderer, grade, lights, scene} = w.internals;
    const gl = renderer.getContext(), tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const mist = scene.getObjectByName('mist');
    const pending = [];
    let shadowThisFrame = false;
    const lu = lights.update;
    lights.update = function (...a) { const r = lu.apply(this, a); shadowThisFrame = renderer.shadowMap.needsUpdate; return r; };
    const ui = h.app.update;
    h.app.update = function (...a) { const t = performance.now(); const r = ui.apply(this, a); if (d.cur) d.cur.ui = performance.now() - t; return r; };
    const update = w.update;
    let wrappedView = null;
    w.update = function (...args) {
      const c = d.cur;
      const v = args[0];
      if (v && v !== wrappedView && typeof v.sync === 'function') {
        wrappedView = v;
        const sync = v.sync;
        v.sync = function (...a) { const t = performance.now(); const r = sync.apply(this, a); if (d.cur) d.cur.sync = performance.now() - t; return r; };
      }
      shadowThisFrame = false;
      const before = renderer.info.render.frame;
      const t = performance.now();
      let q = null;
      if (c && tq) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
      const r = update.apply(this, args);
      if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pending.push([q, c]); }
      for (let i = 0; i < pending.length;) {
        const [qq, f] = pending[i];
        if (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) f.gpu = gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6;
          gl.deleteQuery(qq); pending.splice(i, 1);
        } else i++;
      }
      if (c && renderer.info.render.frame !== before) {
        c.world = performance.now() - t;
        c.phase = grade.current.phase;
        c.yearT = grade.uniforms.uYearT.value;
        c.shadow = shadowThisFrame;
        c.mist = mist?.visible ? mist.material.uniforms.uMist.value : 0;
        c.calls = renderer.info.render.calls;
        c.tris = renderer.info.render.triangles;
        const st = h.view();
        c.stages = st.cpu;
        if (h.host?.onStep) {
          c.step = d.steps.reduce((x, y) => x + y.ms, 0);
          c.workerSync = d.steps.reduce((x, y) => x + y.syncMs, 0);
          c.apply = d.applyMs;
          c.steps = d.steps.length;
        } else c.step = st.stepMs;
        d.steps = [];
        d.applyMs = 0;
      }
      return r;
    };
    // (A build from before the worker has no inSim: same numbers from its live state.)
    const town = h.inSim ? await h.inSim((s) => ({people: s.people.length, buildings: s.buildings.length})) : {people: h.state().people.length, buildings: h.state().buildings.length};
    return {renderer: gl.getParameter(gl.RENDERER), timer: !!tq, simHost: h.simHost ?? 'inline', ...town, tier: w.quality()};
  }, {quality, speed, distance: Number(opts.distance ?? 0)});
  if (opts.ab) await page.evaluate((ab) => {
    const w = window.hearthvale.world, {renderer, lights, scene} = w.internals, d = window.__day;
    let n = 0;
    const off = () => Math.floor(n / 30) % 2 === 1;
    const mist = scene.getObjectByName('mist');
    const lu = lights.update;
    lights.update = function (...a) { const r = lu.apply(this, a); if (ab === 'shadow' && off()) renderer.shadowMap.needsUpdate = false; return r; };
    const update = w.update;
    w.update = function (...a) {
      n++;
      if (ab === 'mist' && mist) mist.material.visible = !off();
      if (d.cur) d.cur.off = off();
      return update.apply(this, a);
    };
  }, opts.ab);
  console.log('initial', initial);
  await page.waitForTimeout(warmup);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', {interval: 500});
  await cdp.send('Profiler.start');
  const profStart = await page.evaluate(() => { window.__day.active = true; return performance.now(); });
  await page.waitForTimeout(duration);
  const frames = await page.evaluate(() => { const d = window.__day; d.active = false; return d.frames; });
  const {profile} = await cdp.send('Profiler.stop');
  writeFileSync(`${out}/${label}.cpuprofile`, JSON.stringify(profile));
  const final = await page.evaluate(() => ({tier: window.hearthvale.world.quality(), reached: window.hearthvale.reachedSpeed()}));

  // The sim step's time: its own task or the worker (step), else what the frame
  // callback spent outside sync, world and UI. main: all main-thread time for the
  // frame (with the worker: the frame callback and the mirror applies, not the step).
  const inWorker = initial.simHost === 'worker';
  for (const f of frames) {
    f.sim = f.step ?? f.cpu - f.world - f.sync - f.ui;
    f.main = f.cpu + (inWorker ? f.apply ?? 0 : f.step ?? 0);
  }
  // Bucket by phase of day (0 midnight, 0.5 noon).
  const BUCKETS = 20;
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const r2 = (v) => v == null ? null : Math.round(v * 100) / 100;
  const rows = [];
  for (let b = 0; b < BUCKETS; b++) {
    const fs = frames.filter((f) => Math.floor(((f.phase % 1) + 1) % 1 * BUCKETS) === b);
    if (!fs.length) continue;
    const gpu = fs.map((f) => f.gpu).filter((v) => v > 0);
    rows.push({
      phase: (b / BUCKETS).toFixed(2), n: fs.length,
      rafP95: r2(q(fs.map((f) => f.raf), 0.95)), mainMean: r2(mean(fs.map((f) => f.main))), mainP95: r2(q(fs.map((f) => f.main), 0.95)),
      simMean: r2(mean(fs.map((f) => f.sim))), syncMean: r2(mean(fs.map((f) => f.sync))), uiMean: r2(mean(fs.map((f) => f.ui))), applyMean: r2(mean(fs.map((f) => f.apply ?? 0))),
      worldMean: r2(mean(fs.map((f) => f.world))), gpuMean: r2(mean(gpu)), gpuP95: r2(q(gpu, 0.95)),
      shadow: r2(fs.filter((f) => f.shadow).length / fs.length), mist: r2(fs.filter((f) => f.mist).length / fs.length), mistAmount: r2(mean(fs.map((f) => f.mist))),
      calls: Math.round(mean(fs.map((f) => f.calls))),
    });
  }
  const all = frames.map((f) => f.main), gpuAll = frames.map((f) => f.gpu).filter((v) => v > 0);
  const summary = {
    label, initial, final, frames: frames.length, errors,
    rafP95: r2(q(frames.map((f) => f.raf), 0.95)), rafMax: r2(Math.max(...frames.map((f) => f.raf))),
    mainMean: r2(mean(all)), mainP95: r2(q(all, 0.95)), gpuMean: r2(mean(gpuAll)), gpuP95: r2(q(gpuAll, 0.95)),
    shadowShare: r2(frames.filter((f) => f.shadow).length / frames.length),
    longFrames: frames.filter((f) => f.raf > 25).length,
  };
  // Dawn and early morning (phase 0.2-0.4) against the rest of the day.
  for (const [name, fs] of [['dawn', frames.filter((f) => f.phase >= 0.2 && f.phase < 0.4)], ['rest', frames.filter((f) => !(f.phase >= 0.2 && f.phase < 0.4))]]) {
    summary[name] = {frames: fs.length, mainMean: r2(mean(fs.map((f) => f.main))), mainP95: r2(q(fs.map((f) => f.main), 0.95)),
      simMean: r2(mean(fs.map((f) => f.sim))), simP95: r2(q(fs.map((f) => f.sim), 0.95)), worldMean: r2(mean(fs.map((f) => f.world))),
      applyMean: r2(mean(fs.map((f) => f.apply ?? 0))), applyP95: r2(q(fs.map((f) => f.apply ?? 0), 0.95)), uiMean: r2(mean(fs.map((f) => f.ui))),
      missed: r2(fs.filter((f) => f.raf > 25).length / (fs.length || 1))};
  }
  if (opts.ab) {
    for (const v of [false, true]) {
      const g = frames.filter((f) => !!f.off === v).map((f) => f.gpu).filter((x) => x > 0);
      summary[`gpu_${opts.ab}_${v ? 'off' : 'on'}`] = {mean: r2(mean(g)), p50: r2(q(g, 0.5)), p95: r2(q(g, 0.95)), n: g.length};
    }
  }
  // Time per function (self, and inclusive) at dawn and early morning (phase
  // 0.2-0.4) against the rest of the day, per frame. Profile timestamps are
  // aligned to performance.now() at the moment sampling started. Samples
  // between two frames count toward the later one, so work run outside the
  // animation frame (the sim step, worker messages, timers, GC) shows too.
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = (id) => { const n = nodes.get(id).callFrame; return `${n.functionName || '(anon)'} ${n.url.split('/').slice(-2).join('/')}:${n.lineNumber + 1}`; };
  const spans = frames.map((f) => [f.t0, f.t0 + f.cpu, f.phase >= 0.2 && f.phase < 0.4]).sort((a, b) => a[0] - b[0]);
  const self = {dawn: new Map(), rest: new Map()};
  const total = {dawn: new Map(), rest: new Map()};
  let ts = 0, k = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    ts += profile.timeDeltas[i] / 1000;
    const at = profStart + ts;
    while (k < spans.length && spans[k][1] < at) k++;
    if (k >= spans.length || (k === 0 && spans[k][0] > at)) continue;
    const which = spans[k][2] ? 'dawn' : 'rest';
    const ms = profile.timeDeltas[i] / 1000;
    const m = self[which];
    const key = keyOf(profile.samples[i]);
    if (key.startsWith('(idle)')) continue;
    m.set(key, (m.get(key) ?? 0) + ms);
    const seen = new Set();
    for (let id = profile.samples[i]; id != null; id = parent.get(id)) {
      const kk = keyOf(id);
      if (seen.has(kk)) continue;
      seen.add(kk);
      total[which].set(kk, (total[which].get(kk) ?? 0) + ms);
    }
  }
  const nDawn = spans.filter((s) => s[2]).length || 1, nRest = spans.length - nDawn || 1;
  const keys = new Set([...self.dawn.keys(), ...self.rest.keys()]);
  const diff = [...keys].map((key) => ({fn: key.slice(0, 90), dawnPerFrame: r2((self.dawn.get(key) ?? 0) / nDawn), restPerFrame: r2((self.rest.get(key) ?? 0) / nRest)}))
    .map((x) => ({...x, extra: r2(x.dawnPerFrame - x.restPerFrame)})).sort((a, b) => b.extra - a.extra).slice(0, 25);
  const tkeys = new Set([...total.dawn.keys(), ...total.rest.keys()]);
  const diffTotal = [...tkeys].map((key) => ({fn: key.slice(0, 90), dawnPerFrame: r2((total.dawn.get(key) ?? 0) / nDawn), restPerFrame: r2((total.rest.get(key) ?? 0) / nRest)}))
    .map((x) => ({...x, extra: r2(x.dawnPerFrame - x.restPerFrame)})).sort((a, b) => b.extra - a.extra).slice(0, 40);
  writeFileSync(`${out}/${label}.json`, JSON.stringify({summary, rows, diff, diffTotal, profStart, frames}, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  console.table(rows);
  console.table(diff);
  console.table(diffTotal);
  // The worst frames, with what they were doing.
  console.table([...frames].sort((a, b) => b.raf - a.raf).slice(0, 12).map((f) => ({
    raf: r2(f.raf), main: r2(f.main), sim: r2(f.sim), sync: r2(f.sync), apply: r2(f.apply), ui: r2(f.ui), world: r2(f.world), gpu: r2(f.gpu), phase: r2(f.phase), yearT: r2(f.yearT), shadow: f.shadow, mist: f.mist,
  })));
} finally {
  await browser.close();
  await server.close();
}
