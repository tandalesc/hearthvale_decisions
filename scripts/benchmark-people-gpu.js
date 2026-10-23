// GPU cost of drawing the people (docs/design/crowd-scale.md §1, gpu-ab): the city
// fixture with every household k times its size (the render dev page's &crowd=k), in
// headless Chrome, with the people's draws (figures, impostors, blob shadows, ripples,
// lamp shadows) shown and hidden in interleaved blocks of GPU-timed frames, so load and
// scene state are shared. The sim keeps running (speed 1), so walkers move.
//
//   node scripts/benchmark-people-gpu.js [--k=1,2,4] [--views=overview,close] [--tier=high]
//        [--dpr=1.75] [--blocks=8] [--frames=40] [--root=DIR] [--shots=DIR]
//
// Prints per k and view: median GPU ms per frame with people on and off, the median
// per-pair difference (the people), the main thread's people.update time, the
// triangles drawn and the walkers. --root serves another checkout (its dev page must
// know &crowd).
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const ks = (args.k ?? '1,2,4').split(',').map(Number);
const tier = args.tier ?? 'high';
const dpr = Number(args.dpr ?? 1.75);
const blocks = Number(args.blocks ?? 8);
const frames = Number(args.frames ?? 40);
const root = resolve(args.root ?? '.');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWS = {
  overview: '',
  close: '&cx=-20&cz=0&dist=60&elev=30',
  // Most walkers between the near and far distances (impostors, or the far LOD).
  mid: '&cx=-20&cz=0&dist=190&elev=22',
};
const views = (args.views ?? 'overview,close').split(',');

const server = await createServer({
  root, configFile: resolve(root, 'vite.config.js'), logLevel: 'error',
  server: { host: '127.0.0.1', port: Number(args.port ?? 5251), strictPort: false, hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.config.server.port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const rows = [];
try {
  for (const k of ks) {
    for (const name of views) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${url}/src/render/dev/render-dev.html?fixture=city&crowd=${k}&yearT=0.66&tier=${tier}&hud=0&speed=1${VIEWS[name]}`);
      await page.waitForFunction(() => window.__frames?.() > 30, null, { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(8000);
      const stats = await page.evaluate(async ({ blocks, frames }) => {
        const w = window.__world, v = window.__view;
        // The page's own loop keeps stepping the sim but no longer draws: only the
        // timed frames below do.
        const draw = w.update.bind(w);
        let mine = false;
        w.update = (...a) => (mine ? draw(...a) : undefined);
        const frame = (...a) => { mine = true; try { return draw(...a); } finally { mine = false; } };
        const { renderer, scene, shadowSurface, people } = w.internals;
        // The people's main-thread update, timed.
        let upMs = 0, upN = 0;
        const update = people.update;
        people.update = (...a) => { const t = performance.now(); try { return update(...a); } finally { upMs += performance.now() - t; upN++; } };
        const gl = renderer.getContext();
        const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const px = new Uint8Array(4);
        const meshes = [];
        for (const sc of [scene, shadowSurface?.scene]) sc?.traverse((o) => { if (o.isMesh && o.name.startsWith('people') && o.name !== 'people-marker') meshes.push(o); });
        const show = (on) => { for (const m of meshes) m.material.visible = on; };
        let tris = [];
        async function run(n, record) {
          const queries = [];
          for (let i = 0; i < n; i++) {
            const t = performance.now() / 1000;
            window.__sync?.(t, 1 / 60);
            w.requestFrame();
            const qq = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
            frame(v, t, 1 / 60);
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            queries.push(qq);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            tris.push(w.stats().triangles);
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
        for (const on of [true, false]) { show(on); await run(10, false); }
        const off = [], on = [], diffs = [];
        let trisOn = [], trisOff = [];
        for (let b = 0; b < blocks; b++) {
          const order = b % 2 ? [true, false] : [false, true];
          const pair = {};
          for (const o of order) {
            show(o);
            await run(4, false);
            tris = [];
            pair[o] = med(await run(frames, o));
            (o ? trisOn : trisOff).push(med(tris));
          }
          off.push(pair.false); on.push(pair.true); diffs.push(pair.true - pair.false);
        }
        show(true);
        w.update = draw;
        const r2 = (x) => Math.round(x * 100) / 100;
        const s = w.stats();
        return {
          walkers: v.peopleCount, gpuOn: r2(med(on)), gpuOff: r2(med(off)), people: r2(med(diffs)), pMin: r2(Math.min(...diffs)), pMax: r2(Math.max(...diffs)),
          cpuUpdate: Math.round(upMs / Math.max(1, upN) * 1000) / 1000, trisOn: Math.round(med(trisOn) / 1000) + 'k', trisOff: Math.round(med(trisOff) / 1000) + 'k',
          drawn: people.drawn ? JSON.stringify(people.drawn()) : null, tier: s.tier,
        };
      }, { blocks, frames });
      if (args.shots) {
        await page.evaluate(async () => { for (let i = 0; i < 4; i++) { window.__world.requestFrame(); await new Promise((r) => requestAnimationFrame(r)); } });
        await page.screenshot({ path: resolve(args.shots, `people-k${k}-${name}.png`) });
      }
      rows.push({ k, view: name, ...stats, errors: errors.slice(0, 2).join(' | ') });
      console.log(JSON.stringify(rows.at(-1)));
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.table(rows);
