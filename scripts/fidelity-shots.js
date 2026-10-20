// Fixed set of look-development screenshots (season, time of day, weather,
// close and far cameras) from the render dev page, plus the GPU-drained frame
// cost of each view. Used for the before/after shots in docs/media.
//
//   node scripts/fidelity-shots.js --out DIR [--prefix fidelity-after] [--tier high]
//        [--only town-summer,city-dusk] [--port 5231] [--dpr 1.25] [--noshot]
//
// Starts its own Vite server from the current directory (no HMR), so it can run
// against another checkout by running it from there.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const out = resolve(args.out ?? 'test-results/fidelity');
const prefix = args.prefix ?? 'shot';
const tier = args.tier ?? 'high';
const dpr = Number(args.dpr ?? 1.25);
const only = args.only ? new Set(args.only.split(',')) : null;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// name: dev-page query (fixture, season, camera, weather).
const SHOTS = {
  'town-summer': 'fixture=town&yearT=0.38',
  'town-close': 'fixture=town&yearT=0.3&cx=-30&cz=10&dist=55&elev=28',
  'town-rain': 'fixture=town&yearT=0.45&weather=rain&cx=-30&cz=10&dist=75&elev=32',
  'town-dawn': 'fixture=town&yearT=0.02&cx=-10&cz=0&dist=90&elev=24',
  'forest-edge': 'fixture=town&yearT=0.32&cx=60&cz=-90&dist=80&elev=26',
  'city-autumn': 'fixture=city&yearT=0.7',
  'city-close': 'fixture=city&yearT=0.66&cx=-20&cz=0&dist=60&elev=30',
  'city-winter-dusk': 'fixture=city&yearT=0.9&cx=-20&cz=0&dist=90&elev=30',
};

// --query="fixture=town&..." shoots that one view (named 'custom') instead.
if (args.query) { for (const k of Object.keys(SHOTS)) delete SHOTS[k]; SHOTS.custom = args.query; }

const server = await createServer({
  configFile: resolve('vite.config.js'), logLevel: 'error',
  server: { host: '127.0.0.1', port: Number(args.port ?? 5231), strictPort: false, hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.config.server.port}`;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const rows = [];
try {
  for (const [name, q] of Object.entries(SHOTS)) {
    if (only && !only.has(name)) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 200)); });
    await page.goto(`${url}/src/render/dev/render-dev.html?${q}&tier=${tier}&hud=0&freeze=1&speed=0`);
    await page.waitForFunction(() => window.__frames?.() > 30, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(Number(args.wait ?? 5000));
    // GPU time per drawn frame (EXT_disjoint_timer_query_webgl2), and the
    // frame's CPU time, over 90 forced frames; medians.
    const stats = await page.evaluate(async () => {
      const w = window.__world, v = window.__view;
      const gl = w.internals.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const px = new Uint8Array(4);
      const cpu = [], queries = [];
      for (let i = 0; i < 90; i++) {
        w.requestFrame();
        const q = ext ? gl.createQuery() : null;
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        const a = performance.now();
        w.update(v, performance.now() / 1000, 1 / 60);
        cpu.push(performance.now() - a);
        if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push(q); }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        await new Promise((r) => setTimeout(r, 0));
      }
      await new Promise((r) => setTimeout(r, 200));
      const gpu = [];
      for (const q of queries) {
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[s.length >> 1] * 100) / 100 : null; };
      const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length * 0.95)] * 100) / 100 : null; };
      const s = w.stats();
      return { gpuMs: med(gpu), gpuP95: p95(gpu), cpuMs: med(cpu), drawCalls: s.drawCalls, triangles: s.triangles, tier: s.tier };
    });
    if (!args.noshot) await page.screenshot({ path: `${out}/${prefix}-${name}.jpg`, type: 'jpeg', quality: 82 });
    rows.push({ name, ...stats, errors: errors.slice(0, 3).join(' | ') });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.table(rows);
writeFileSync(`${out}/${prefix}-stats.json`, JSON.stringify(rows, null, 2));
