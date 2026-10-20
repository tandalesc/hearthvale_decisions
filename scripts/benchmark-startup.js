// Startup cost of the production build: navigation to a booted game and to its first
// drawn frame, for a fresh town and the cached city fixture. Serves dist/ with
// `vite preview` (run `npm run build` first), blocks the model API, and uses a fresh
// browser context per run (no HTTP cache, no saved town).
//
//   node scripts/benchmark-startup.js                    # 5 runs each of fresh and city
//   node scripts/benchmark-startup.js --runs=3 --scenarios=fresh --profile=/tmp/startup
//
// Prints JSON: per scenario, median and each run's milestones in ms since navigation
// start (booted: window.hearthvale exists; firstFrame: the world has drawn), the longest
// main-thread task and the sum of tasks over 50 ms before that frame, plus the
// bytes of script fetched before the first frame. --profile=DIR saves one CPU profile
// per scenario.
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const opts = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const runs = Number(opts.runs ?? 5);
const scenarios = (opts.scenarios ?? 'fresh,city').split(',');
if (!existsSync('dist/index.html')) throw new Error('No dist/: run npm run build first.');
const server = await preview({configFile: resolve('vite.config.js'), logLevel: 'error', preview: {host: '127.0.0.1', port: Number(opts.port ?? 5214), strictPort: false}});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = opts.chrome ?? process.env.CHROME_PATH ?? (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({executablePath: chrome, headless: true, args: [...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl']});
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const results = {};
try {
  for (const scenario of scenarios) {
    const rows = [];
    for (let i = 0; i < runs; i++) {
      const ctx = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 2});
      const page = await ctx.newPage();
      await page.route('**/api/**', (r) => r.fulfill({status: 503, body: '{}'}));
      await page.addInitScript(() => {
        // Main-thread tasks over 50 ms until the first drawn frame (the page cannot respond during them).
        window.__long = [];
        try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({type: 'longtask', buffered: true}); } catch { /* no longtask API */ }
        localStorage.setItem('hearthvale-model-enabled', 'false');
        localStorage.setItem('hearthvale-ui', JSON.stringify({quality: 'high', muted: true, moments: 'never'}));
        localStorage.setItem('hearthvale-ui-seen', JSON.stringify(['explain:docket', 'explain:rules', 'explain:people', 'explain:chronicle', 'explain:tensions', 'explain:overlays', 'explain:council']));
      });
      let scriptBytes = 0, done = false;
      page.on('response', async (res) => {
        if (done || res.request().resourceType() !== 'script') return;
        try { scriptBytes += Number(res.headers()['content-length'] ?? (await res.body()).length); } catch { /* gone */ }
      });
      const cdp = opts.profile && i === 0 ? await ctx.newCDPSession(page) : null;
      if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {interval: 500}); await cdp.send('Profiler.start'); }
      await page.goto(`${base}/${scenario === 'fresh' ? '?play=1' : `?fixture=${scenario}`}`, {waitUntil: 'commit'});
      const m = await page.evaluate(() => new Promise((resolveRun) => {
        let booted = null;
        const poll = () => {
          const h = window.hearthvale;
          if (h && booted == null) booted = performance.now();
          if (h?.renderer === 'real' && (h.world?.stats?.().drawCalls ?? 0) > 0) {
            const nav = performance.getEntriesByType('navigation')[0];
            const long = window.__long ?? [];
            resolveRun({domContentLoaded: nav?.domContentLoadedEventEnd ?? null, booted, firstFrame: performance.now(), longestTask: Math.round(Math.max(0, ...long)), longTasksMs: Math.round(long.reduce((a, b) => a + b, 0)), people: h.state().people.length, buildings: h.state().buildings.length});
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      }));
      done = true;
      if (cdp) {
        const {profile} = await cdp.send('Profiler.stop');
        mkdirSync(opts.profile, {recursive: true});
        writeFileSync(resolve(opts.profile, `startup-${scenario}.cpuprofile`), JSON.stringify(profile));
      }
      rows.push({...m, scriptKB: Math.round(scriptBytes / 1024)});
      await ctx.close();
    }
    results[scenario] = {
      median: {booted: +median(rows.map((r) => r.booted)).toFixed(0), firstFrame: +median(rows.map((r) => r.firstFrame)).toFixed(0), longestTask: median(rows.map((r) => r.longestTask)), longTasksMs: median(rows.map((r) => r.longTasksMs))},
      runs: rows.map((r) => ({...r, booted: +r.booted.toFixed(0), firstFrame: +r.firstFrame.toFixed(0), domContentLoaded: r.domContentLoaded && +r.domContentLoaded.toFixed(0)})),
    };
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
process.stdout.write(JSON.stringify({browser: browser.version(), url: base, results}, null, 2) + '\n');
