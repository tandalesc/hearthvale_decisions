import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createState} from '../src/sim/state.js';
import {serialize, restore} from '../src/sim/serialize.js';

const root = resolve('legacy-migration');
const source = serialize(createState(4817));
assert.equal(restore(source).version, 2);
const legacy = JSON.stringify({version: 1, townName: 'Old valley', time: {year: 4}});

const server = createServer(async (req, res) => {
  const file = req.url?.startsWith('/migration.js') ? 'migration.js' : 'index.html';
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(await readFile(resolve(root, file)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
  const context = await browser.newContext({acceptDownloads: true});
  const page = await context.newPage();
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  await page.evaluate(async ({source, legacy}) => {
    localStorage.setItem('hearthvale-save', legacy);
    const request = indexedDB.open('hearthvale', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('saves');
      request.result.createObjectStore('meta');
    };
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const bytes = new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Blob([await new Response(bytes).arrayBuffer()], {type: 'application/gzip'});
    const tx = db.transaction(['saves', 'meta'], 'readwrite');
    tx.objectStore('saves').put(compressed, 'current');
    tx.objectStore('meta').put({name: 'Test valley', year: 0}, 'current');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, {source, legacy});
  const before = await page.evaluate(async () => {
    const req = indexedDB.open('hearthvale');
    const db = await new Promise((resolve) => { req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('saves', 'readonly');
    const blob = await new Promise((resolve) => { const get = tx.objectStore('saves').get('current'); get.onsuccess = () => resolve(get.result); });
    const bytes = [...new Uint8Array(await blob.arrayBuffer())];
    db.close();
    return {bytes, legacy: localStorage.getItem('hearthvale-save')};
  });
  await page.reload();
  await page.getByRole('heading', {name: 'Your towns on this device'}).waitFor();
  await page.locator('.town').first().waitFor();
  console.log('Found towns:', await page.locator('.town').allTextContents());
  const townButton = page.locator('.town').first().getByRole('button');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    townButton.click(),
  ]);
  const exported = await readFile(await download.path(), 'utf8');
  assert.equal(exported, source);
  assert.equal(restore(exported).version, 2);
  await page.getByText('Save version 1 is unsupported').waitFor();
  await page.screenshot({path: resolve(root, 'migration-desktop.png'), fullPage: true});
  const phone = await context.newPage();
  await phone.setViewportSize({width: 390, height: 844});
  await phone.goto(url);
  await phone.locator('.town').first().waitFor();
  await phone.screenshot({path: resolve(root, 'migration-phone.png'), fullPage: true});
  const after = await page.evaluate(async () => {
    const req = indexedDB.open('hearthvale');
    const db = await new Promise((resolve) => { req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('saves', 'readonly');
    const blob = await new Promise((resolve) => { const get = tx.objectStore('saves').get('current'); get.onsuccess = () => resolve(get.result); });
    const bytes = [...new Uint8Array(await blob.arrayBuffer())];
    db.close();
    return {bytes, legacy: localStorage.getItem('hearthvale-save')};
  });
  assert.deepEqual(after, before);
  assert.equal(await page.locator('script[src="/migration.js"]').count(), 1);
  console.log('Migration test passed: gzip v2 exported byte-for-byte, current restore accepted it, v1 warned, browser stores unchanged.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
