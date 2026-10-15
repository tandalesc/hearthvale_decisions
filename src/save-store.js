// Town saves live in IndexedDB, gzip-compressed. localStorage is too small
// (~5 MB per origin, shared with anything else on the same host:port) for a
// growing town, and a failed write there is silent. Old localStorage saves are
// moved here once and then removed from localStorage to free the space.

const DB_NAME = 'hearthvale';
const STORE = 'saves';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function gzip(text) {
  if (typeof CompressionStream === 'undefined') return text;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], {type: 'application/gzip'});
}

async function gunzip(value) {
  if (typeof value === 'string') return value;
  const stream = value.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function createSaveStore({legacyKey}) {
  let dbPromise = null;
  const db = () => (dbPromise ??= openDb());
  let writing = Promise.resolve();

  return {
    /** The saved town as a JSON string, or null. Migrates a legacy save once. */
    async load() {
      try {
        const stored = await tx(await db(), 'readonly', (s) => s.get(KEY));
        if (stored != null) return await gunzip(stored);
      } catch (err) {
        console.warn('[hearthvale] reading the save failed', err);
      }
      let legacy = null;
      try { legacy = localStorage.getItem(legacyKey); } catch { /* blocked */ }
      if (legacy) {
        const ok = await this.save(legacy);
        if (ok) try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
      }
      return legacy;
    },

    /** Writes are serialised so a slow write can't land after a newer one. */
    save(text) {
      const run = writing.then(async () => {
        try {
          const blob = await gzip(text);
          await tx(await db(), 'readwrite', (s) => s.put(blob, KEY));
          return true;
        } catch (err) {
          console.warn('[hearthvale] save failed', err);
          return false;
        }
      });
      writing = run.catch(() => false);
      return run;
    },

    async remove() {
      try { await tx(await db(), 'readwrite', (s) => s.delete(KEY)); } catch { /* ignore */ }
      try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
    },
  };
}
