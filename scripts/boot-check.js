// Boot smoke check: loads the live game page (and the renderer dev page) in
// Chrome with Metal, fails on any page error, any 'renderer failed' console
// error, or a fallback to the 2D stub map. Run after every edit batch.
//
//   node scripts/boot-check.js [--fixture town] [--wait 6000]
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return acc;
}, []));
const fixture = args.fixture ?? 'town';
const wait = Number(args.wait ?? 6000);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const server = await createServer({
  configFile: resolve('vite.config.js'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: Number(args.port ?? 5189), strictPort: false, hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.config.server.port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
let failed = false;
try {
  for (const [name, url] of [['game', `${base}/?fixture=${fixture}`], ['dev', `${base}/src/render/dev/render-dev.html?fixture=${fixture}&tier=medium`]]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !t.includes('404') && !t.includes('Failed to load resource')) problems.push(`console: ${t.slice(0, 240)}`);
    });
    await page.goto(url);
    await page.waitForTimeout(wait);
    const info = await page.evaluate(() => ({
      renderer: window.hearthvale?.renderer ?? (window.__world ? 'dev' : null),
      stats: (window.hearthvale?.world ?? window.__world)?.stats?.() ?? null,
    }));
    if (name === 'game' && info.renderer !== 'real') problems.push(`renderer is '${info.renderer}', expected 'real'`);
    if (!info.stats || !(info.stats.drawCalls > 0)) problems.push('no frames drawn');
    console.log(`${name}: ${problems.length ? 'FAIL' : 'ok'} · renderer ${info.renderer} · ${info.stats ? `${info.stats.drawCalls} calls, ${info.stats.fps} fps` : 'no stats'}`);
    for (const p of problems.slice(0, 8)) console.log('   ', p);
    if (problems.length) failed = true;
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
