import {test, expect} from '@playwright/test';

// A same-origin blank page exercises IndexedDB and real workers without the game loop.
test.beforeEach(async ({page}) => {
  await page.route('**/save-test.html', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Save store test</title>',
  }));
  await page.goto('/save-test.html');
});

test('worker gzip keeps the exact city save bytes and restored state', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createSaveStore} = await import('/src/save-store.js');
    const sim = await import('/src/sim/index.js');
    const state = await sim.loadFixture('city');
    const raw = sim.serialize(state);
    const NativeWorker = window.Worker;
    let created = 0, terminated = 0;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); created++; }
      terminate() { terminated++; return super.terminate(); }
    };
    try {
      const store = createSaveStore({legacyKey: 'legacy-test'});
      const saved = await store.save(raw);
      const loaded = await store.load();
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('hearthvale', 1);
        request.onsuccess = () => resolve(request.result);
      });
      const blob = await new Promise((resolve) => {
        const request = db.transaction('saves').objectStore('saves').get('current');
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      const native = await new Response(new Blob([raw]).stream()
        .pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      const actual = new Uint8Array(await blob.arrayBuffer());
      const expected = new Uint8Array(native);
      return {
        saved, exactText: loaded === raw, type: blob.type, created, terminated,
        exactGzip: actual.length === expected.length && actual.every((v, i) => v === expected[i]),
        exactRestore: sim.serialize(sim.restore(loaded)) === sim.serialize(sim.restore(raw)),
      };
    } finally { window.Worker = NativeWorker; }
  });
  expect(result).toEqual({
    saved: true, exactText: true, type: 'application/gzip', created: 1, terminated: 1,
    exactGzip: true, exactRestore: true,
  });
});

test('delayed compression preserves queued save order and cleans up workers', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createSaveStore} = await import('/src/save-store.js');
    const NativeWorker = window.Worker;
    let created = 0, active = 0, maxActive = 0, terminated = 0;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.ordinal = ++created;
        active++;
        maxActive = Math.max(active, maxActive);
      }
      postMessage(source) {
        if (this.ordinal === 1) setTimeout(() => super.postMessage(source), 80);
        else super.postMessage(source);
      }
      terminate() { active--; terminated++; return super.terminate(); }
    };
    try {
      const store = createSaveStore({legacyKey: 'legacy-test'});
      const results = await Promise.all([store.save('first'), store.save('second'), store.save('last')]);
      return {results, latest: await store.load(), created, active, maxActive, terminated};
    } finally { window.Worker = NativeWorker; }
  });
  expect(result).toEqual({results: [true, true, true], latest: 'last', created: 3, active: 0, maxActive: 1, terminated: 3});
});

for (const failure of ['unavailable', 'constructor', 'runtime', 'message', 'worker', 'post']) {
  test(`save falls back after worker ${failure} failure and accepts the next save`, async ({page}) => {
    const result = await page.evaluate(async (failure) => {
      const {createSaveStore} = await import('/src/save-store.js');
      const NativeWorker = window.Worker;
      let created = 0, terminated = 0;
      window.Worker = failure === 'unavailable' ? undefined : class {
        constructor() { created++; if (failure === 'constructor') throw new Error('blocked worker'); }
        postMessage() {
          if (failure === 'post') throw new Error('could not send');
          setTimeout(() => {
            if (failure === 'runtime') this.onerror(new ErrorEvent('error', {cancelable: true, error: new Error('worker failed')}));
            else if (failure === 'message') this.onmessageerror(new MessageEvent('messageerror'));
            else this.onmessage(new MessageEvent('message', {data: {error: 'compression failed'}}));
          }, 0);
        }
        terminate() { terminated++; }
      };
      try {
        const store = createSaveStore({legacyKey: 'legacy-test'});
        const first = await store.save('fallback café 🌳');
        const loadedFirst = await store.load();
        window.Worker = NativeWorker;
        const next = await store.save('next');
        return {first, loadedFirst, next, latest: await store.load(), created, terminated};
      } finally { window.Worker = NativeWorker; }
    }, failure);
    expect(result).toEqual({
      first: true, loadedFirst: 'fallback café 🌳', next: true, latest: 'next',
      created: failure === 'unavailable' ? 0 : 1,
      terminated: ['unavailable', 'constructor'].includes(failure) ? 0 : 1,
    });
  });
}

for (const event of ['visibilitychange', 'pagehide']) {
  test(`${event} finishes pending and queued saves through the original compressor`, async ({page}) => {
    const result = await page.evaluate(async (event) => {
      const {createSaveStore} = await import('/src/save-store.js');
      const NativeWorker = window.Worker;
      let created = 0, terminated = 0, hidden = false;
      Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => hidden ? 'hidden' : 'visible'});
      window.Worker = class {
        constructor() { created++; }
        postMessage() {} // Hold the first compression job until the page leaves.
        terminate() { terminated++; }
      };
      try {
        const store = createSaveStore({legacyKey: 'legacy-test'});
        const first = store.save('first');
        const next = store.save('latest');
        await new Promise((resolve) => setTimeout(resolve, 0));
        hidden = true;
        (event === 'pagehide' ? window : document).dispatchEvent(new Event(event));
        const results = await Promise.all([first, next]);
        return {results, latest: await store.load(), created, terminated};
      } finally {
        window.Worker = NativeWorker;
        delete document.visibilityState;
      }
    }, event);
    expect(result).toEqual({results: [true, true], latest: 'latest', created: 1, terminated: 1});
  });
}

test('raw saves and failed legacy migration remain recoverable', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createSaveStore} = await import('/src/save-store.js');
    const nativeCompression = window.CompressionStream;
    const nativePut = IDBObjectStore.prototype.put;
    let fail = true;
    IDBObjectStore.prototype.put = function(...args) {
      if (fail) { fail = false; throw new DOMException('test full storage', 'QuotaExceededError'); }
      return nativePut.apply(this, args);
    };
    window.CompressionStream = undefined;
    try {
      localStorage.setItem('legacy-test', 'legacy raw town');
      const store = createSaveStore({legacyKey: 'legacy-test'});
      const first = await store.load();
      const retainedAfterFailure = localStorage.getItem('legacy-test');
      const retried = await store.load();
      const removedAfterSuccess = localStorage.getItem('legacy-test');
      window.CompressionStream = nativeCompression;
      const rawLoadedWithCompressionAvailable = await store.load();
      const next = await store.save('new compressed town');
      return {first, retainedAfterFailure, retried, removedAfterSuccess, rawLoadedWithCompressionAvailable, next, latest: await store.load()};
    } finally {
      window.CompressionStream = nativeCompression;
      IDBObjectStore.prototype.put = nativePut;
    }
  });
  expect(result).toEqual({
    first: 'legacy raw town', retainedAfterFailure: 'legacy raw town', retried: 'legacy raw town',
    removedAfterSuccess: null, rawLoadedWithCompressionAvailable: 'legacy raw town', next: true, latest: 'new compressed town',
  });
});
