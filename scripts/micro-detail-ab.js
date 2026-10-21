// In-page A/B of the micro-detail relief (docs/design/micro-detail.md): one
// loaded page per view, the terrain's MICRO_DETAIL define flipped between
// interleaved blocks of GPU-timed frames, so load and scene state are shared.
//
//   node scripts/micro-detail-ab.js [--tier high] [--blocks 8] [--frames 40]
//        [--only bridge,street40] [--dpr 1.25] [--out DIR]
//
// Prints, per view, median GPU ms of the whole frame with relief off and on,
// the median of the per-pair differences (on - off), and the same for the
// terrain drawn alone. Same server and browser setup as fidelity-shots.js.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const tier = args.tier ?? 'high';
const dpr = Number(args.dpr ?? 1.25);
const blocks = Number(args.blocks ?? 8);
const frames = Number(args.frames ?? 40);
const only = args.only ? new Set(args.only.split(',')) : null;
const out = resolve(args.out ?? 'test-results/micro-detail');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const VIEWS = {
  bridge: 'fixture=city&yearT=0.66&cx=9&cz=-105&dist=20&elev=30',
  street40: 'fixture=city&yearT=0.66&cx=5&cz=-28&dist=40&elev=30',
  'square-dawn': 'fixture=city&yearT=0.02&cx=5&cz=-28&dist=25&elev=25',
  // Worst case: paving fills most of the screen, seen from above at 16 m.
  'paving-top': 'fixture=city&yearT=0.66&cx=5&cz=-28&dist=16&elev=70',
  'city-close': 'fixture=city&yearT=0.66&cx=-20&cz=0&dist=60&elev=30',
  'city-autumn': 'fixture=city&yearT=0.7',
  'town-close': 'fixture=town&yearT=0.3&cx=-30&cz=10&dist=55&elev=28',
};

const server = await createServer({
  configFile: resolve('vite.config.js'), logLevel: 'error',
  server: { host: '127.0.0.1', port: Number(args.port ?? 5241), strictPort: false, hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.config.server.port}`;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const rows = [];
try {
  for (const [name, q] of Object.entries(VIEWS)) {
    if (only && !only.has(name)) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 200)); });
    await page.goto(`${url}/src/render/dev/render-dev.html?${q}&tier=${tier}&hud=0&freeze=1&speed=0`);
    await page.waitForFunction(() => window.__frames?.() > 30, null, { timeout: 60000 }).catch(() => {});
    // Wait until the scene stops growing (draw calls steady for 2 s).
    await page.evaluate(async () => {
      let last = -1, steady = 0;
      for (let i = 0; i < 60 && steady < 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const c = window.__world.stats().drawCalls;
        steady = c === last ? steady + 1 : 0;
        last = c;
      }
    });
    const stats = await page.evaluate(async ({ blocks, frames }) => {
      const w = window.__world, v = window.__view;
      const { renderer, terrain } = w.internals;
      const gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const px = new Uint8Array(4);
      const tierName = w.stats().tier;
      // terrain.applyQuality reads only these fields (cloud shadows are High's).
      const setMicro = (on) => terrain.applyQuality({ name: tierName, cloudShadow: tierName === 'high', microDetail: on });
      async function run(n) {
        const queries = [];
        for (let i = 0; i < n; i++) {
          w.requestFrame();
          const qq = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
          w.update(v, performance.now() / 1000, 1 / 60);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          queries.push(qq);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          await new Promise((r) => setTimeout(r, 0));
        }
        await new Promise((r) => setTimeout(r, 100));
        const ms = [];
        for (const qq of queries) {
          if (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(qq);
        }
        return ms;
      }
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
      // Warm both programs, then alternate blocks (off, on, on, off, ...).
      for (const on of [true, false]) { setMicro(on); await run(10); }
      const off = [], on = [], diffs = [];
      for (let b = 0; b < blocks; b++) {
        const order = b % 2 ? [true, false] : [false, true];
        const pair = {};
        for (const o of order) { setMicro(o); await run(5); pair[o] = med(await run(frames)); }
        off.push(pair.false); on.push(pair.true); diffs.push(pair.true - pair.false);
      }
      // Terrain alone: everything else hidden, straight to the canvas (no
      // post pass, no occluders, so every terrain pixel is shaded: an upper
      // bound on the relief's cost). One timer query over 10 renders.
      const s = w.stats();
      const { scene } = w.internals;
      const camera = w.camera.camera;
      const shown = new Map();
      for (const o of scene.children) { shown.set(o, o.visible); o.visible = o === terrain.group || o.isLight || o === camera; }
      async function terrainMs() {
        const qq = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
        for (let i = 0; i < 10; i++) renderer.render(scene, camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        await new Promise((r) => setTimeout(r, 30));
        const ok = gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ms = ok ? gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e7 : null;
        gl.deleteQuery(qq);
        return ms;
      }
      for (const o of [true, false]) { setMicro(o); await terrainMs(); }
      const tOff = [], tOn = [], tDiffs = [];
      for (let b = 0; b < blocks * 3; b++) {
        const order = b % 2 ? [true, false] : [false, true];
        const pair = {};
        for (const o of order) { setMicro(o); const a = []; for (let k = 0; k < 3; k++) a.push(await terrainMs()); pair[o] = med(a.filter((x) => x != null)); }
        tOff.push(pair.false); tOn.push(pair.true); tDiffs.push(pair.true - pair.false);
      }
      for (const [o, vis] of shown) o.visible = vis;
      setMicro(tierName === 'high');
      w.requestFrame();
      const r2 = (x) => Math.round(x * 1000) / 1000;
      return {
        gpuOff: r2(med(off)), gpuOn: r2(med(on)), delta: r2(med(diffs)), deltaMin: r2(Math.min(...diffs)), deltaMax: r2(Math.max(...diffs)),
        terrainOff: r2(med(tOff)), terrainOn: r2(med(tOn)), terrainDelta: r2(med(tDiffs)), tDeltaMin: r2(Math.min(...tDiffs)), tDeltaMax: r2(Math.max(...tDiffs)),
        drawCalls: s.drawCalls, tier: s.tier,
      };
    }, { blocks, frames });
    rows.push({ name, ...stats, errors: errors.slice(0, 3).join(' | ') });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.table(rows);
writeFileSync(`${out}/micro-ab-${tier}.json`, JSON.stringify(rows, null, 2));
