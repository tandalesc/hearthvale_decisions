// Fixed set of look-development screenshots (season, time of day, weather,
// close and far cameras) from the render dev page, plus the GPU-drained frame
// cost of each view. Used for the before/after shots in docs/media.
//
//   node scripts/fidelity-shots.js --out DIR [--prefix fidelity-after] [--tier high]
//        [--only town-summer,city-dusk] [--port 5231]
//
// Starts its own Vite server from the current directory (no HMR), so it can run
// against another checkout by running it from there.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const out = resolve(args.out ?? 'test-results/fidelity');
const prefix = args.prefix ?? 'shot';
const tier = args.tier ?? 'high';
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${url}/src/render/dev/render-dev.html?${q}&tier=${tier}&hud=0&freeze=1&speed=0`);
    await page.waitForFunction(() => window.__frames?.() > 30, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(Number(args.wait ?? 5000));
    const stats = await page.evaluate(() => {
      const w = window.__world, v = window.__view;
      const gl = w.internals.renderer.getContext();
      const px = new Uint8Array(4);
      const t = [];
      for (let i = 0; i < 40; i++) {
        w.requestFrame();
        const a = performance.now();
        w.update(v, performance.now() / 1000, 1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        t.push(performance.now() - a);
      }
      t.sort((a, b) => a - b);
      const s = w.stats();
      return { syncedMs: Math.round(t[20] * 100) / 100, drawCalls: s.drawCalls, triangles: s.triangles, tier: s.tier };
    });
    await page.screenshot({ path: `${out}/${prefix}-${name}.jpg`, type: 'jpeg', quality: 82 });
    rows.push({ name, ...stats, errors: errors.slice(0, 3).join(' | ') });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.table(rows);
writeFileSync(`${out}/${prefix}-stats.json`, JSON.stringify(rows, null, 2));
