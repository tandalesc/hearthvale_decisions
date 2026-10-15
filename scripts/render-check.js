// Renderer check: renders each fixture at desktop and phone sizes with the
// installed Chrome (Metal ANGLE), saves screenshots and prints world.stats().
//
//   node scripts/render-check.js [--out DIR] [--fixtures hamlet,town,city]
//        [--tiers medium,high] [--sizes desktop,phone] [--query "yearT=0.6"]
//        [--url http://127.0.0.1:5173] [--wait 4000] [--headed] [--cpu]
//
// Starts its own Vite server (port 5199, no HMR, no file watching) so edits by
// other agents never reload the page mid-measurement. --url uses another server.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return acc;
}, []));
const out = resolve(args.out ?? 'test-results/render');
const fixtures = (args.fixtures ?? 'hamlet,town,city').split(',');
const tiers = (args.tiers ?? 'medium').split(',');
const sizes = (args.sizes ?? 'desktop,phone').split(',');
const wait = Number(args.wait ?? 4000);
// Screenshots pin the season unless --live is given.
const query = (args.query ?? '') + (args.live ? '' : '&freeze=1');
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function reachable(url) {
  try {
    const r = await fetch(url + '/src/render/dev/render-dev.html');
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(out, { recursive: true });
  let url = args.url;
  let server = null;
  if (!url || !(await reachable(url))) {
    const port = Number(args.port ?? 5199);
    server = await createServer({
      configFile: resolve('vite.config.js'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port, strictPort: false, hmr: false, watch: null },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.config.server.port}`;
  }
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !args.headed,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const rows = [];
  try {
    for (const fixture of fixtures) {
      for (const tier of tiers) {
        for (const size of sizes) {
          const page = await browser.newPage(SIZES[size]);
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
          const q = `fixture=${fixture}&tier=${tier}&hud=0${query ? '&' + query : ''}`;
          await page.goto(`${url}/src/render/dev/render-dev.html?${q}`);
          await page.waitForFunction(() => window.__frames?.() > 30, null, { timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(wait);
          const stats = await page.evaluate(() => window.__world?.stats());
          // Full frame cost with the GPU drained (readPixels forces a sync):
          // median of 30 forced frames, so pacing never hides real cost.
          const gpu = await page.evaluate(() => {
            const w = window.__world, v = window.__view;
            if (!w) return null;
            const gl = w.internals.renderer.getContext();
            const px = new Uint8Array(4);
            const t = [];
            for (let i = 0; i < 32; i++) {
              w.requestFrame();
              const a = performance.now();
              w.update(v, performance.now() / 1000, 1 / 60);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
              t.push(performance.now() - a);
            }
            t.sort((a, b) => a - b);
            return Math.round(t[16] * 100) / 100;
          });
          if (stats) stats.syncedMs = gpu;
          const name = `${fixture}-${tier}-${size}${args.tag ? '-' + args.tag : ''}.png`;
          await page.screenshot({ path: `${out}/${name}` });
          rows.push({ fixture, tier, size, ...stats, shot: name, errors: errors.filter((e) => !e.includes('404')).slice(0, 6).join(' | ') });
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    await server?.close();
  }
  console.table(rows.map(({ errors, cpu, ...r }) => r));
  if (args.cpu) for (const r of rows) console.log(`${r.fixture}/${r.tier}/${r.size} cpu ms:`, JSON.stringify(r.cpu));
  for (const r of rows) if (r.errors) console.log(`${r.fixture}/${r.tier}/${r.size}: ${r.errors}`);
  console.log(`screenshots: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
