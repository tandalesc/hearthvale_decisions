// Compare compression of one immutable saved-city JSON string, without simulation
// or stringify work. Capture the input with benchmark-longframes.js first.
// node scripts/benchmark-save-compression.js --input=/tmp/hearthvale-longframes/current-saved.json --baseline-ref=fd6e048
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
if (!options.input) throw new Error('Pass --input=<saved-city.json>.');
const ref = options['baseline-ref'] ?? 'fd6e048';
const original = execFileSync('git', ['show', `${ref}:src/save-store.js`], {encoding: 'utf8'});
const server = await createServer({logLevel: 'error', server: {host: '127.0.0.1', port: 5223, hmr: false, watch: null}});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  headless: true,
  args: ['--disable-background-timer-throttling'],
});
try {
  const page = await browser.newPage();
  await page.route('**/blank.html', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Frozen save control</title>'}));
  await page.route('**/original-save-store.js', route => route.fulfill({contentType: 'text/javascript', body: original}));
  await page.goto(`http://127.0.0.1:${server.config.server.port}/blank.html`);
  await page.evaluate(raw => { window.raw = raw; }, readFileSync(options.input, 'utf8'));
  const result = await page.evaluate(async () => {
    const before = (await import('/original-save-store.js')).createSaveStore({legacyKey: 'none'});
    const after = (await import('/src/save-store.js')).createSaveStore({legacyKey: 'none'});
    const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    const stored = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('hearthvale', 1);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('saves').objectStore('saves').get('current');
        read.onsuccess = () => { resolve(read.result); db.close(); };
        read.onerror = reject;
      };
      request.onerror = reject;
    });
    const results = [];
    for (const [label, store] of [['native', before], ['worker', after]]) {
      const tasks = [], gaps = [];
      let active = true, previous = null;
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => ({start: entry.startTime, duration: entry.duration}))));
      observer.observe({type: 'longtask'});
      const frame = time => {
        if (previous !== null) gaps.push(time - previous);
        previous = time;
        if (active) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      await new Promise(resolve => setTimeout(resolve, 100));
      const start = performance.now(), ok = await store.save(window.raw), end = performance.now();
      await new Promise(resolve => setTimeout(resolve, 100));
      active = false;
      observer.disconnect();
      const blob = await stored();
      const restored = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
      results.push({label, ok, wallMs: end - start, sourceChars: window.raw.length,
        compressedBytes: blob.size, type: blob.type, sha256: await digest(blob),
        restoredEqual: restored === window.raw,
        longTasks: tasks.filter(task => task.start + task.duration >= start && task.start <= end),
        maxRafGapMs: Math.max(...gaps)});
    }
    return {results, compressedBytesEqual: results[0].sha256 === results[1].sha256};
  });
  result.baselineRef = ref;
  if (options.out) writeFileSync(options.out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.compressedBytesEqual || result.results.some(run => !run.ok || !run.restoredEqual)) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
