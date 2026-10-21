// Town saves live in IndexedDB, gzip-compressed. localStorage is too small
// (~5 MB per origin, shared with anything else on the same host:port) for a
// growing town, and a failed write there is silent. Old localStorage saves are
// moved here once and then removed from localStorage to free the space.
//
// A device keeps several towns ("slots"). Each slot has the town itself in
// `saves` and a small record in `meta` (name, year, people, a picture) so the
// main menu can list towns without opening them. The single save from before
// slots lives on under the key 'current' and is given a record the first time
// the towns are listed.

const DB_NAME = 'hearthvale';
const SAVES = 'saves';
const META = 'meta';
const LEGACY_SLOT = 'current';
const LAST_KEY = 'hearthvale-last-town';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Another tab still has version 1 open: it is told to close (below), so wait.
    req.onblocked = () => {};
  });
}

// fn(stores) returns a request (or an array of them); resolves with its result.
function tx(db, names, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries([names].flat().map((n) => [n, t.objectStore(n)]));
    const result = fn(stores);
    t.oncomplete = () => resolve(Array.isArray(result) ? result.map((r) => r.result) : result?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function gzipInWorker(source) {
  return new Promise((resolve, reject) => {
    // Each immutable snapshot gets its own worker. It is stopped on every
    // completion or failure, so no pending reply can belong to another save.
    const worker = new Worker(new URL('./save-worker.js', import.meta.url), {type: 'module'});
    let settled = false;
    const onHide = () => finish(new Error('Finish this save on the page thread.'));
    const onVisibility = () => { if (globalThis.document?.visibilityState === 'hidden') onHide(); };
    const finish = (error, blob) => {
      if (settled) return;
      settled = true;
      globalThis.removeEventListener?.('pagehide', onHide);
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else resolve(blob);
    };
    worker.onmessage = ({data}) => {
      if (data?.blob instanceof Blob) finish(null, data.blob);
      else finish(new Error(data?.error ?? 'Save compression returned no data.'));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(event.error ?? new Error('Save compression worker failed.'));
    };
    worker.onmessageerror = () => finish(new Error('Save compression reply could not be read.'));
    globalThis.addEventListener?.('pagehide', onHide);
    globalThis.document?.addEventListener('visibilitychange', onVisibility);
    try { worker.postMessage(source); } catch (error) { finish(error); }
  });
}

async function gzip(text) {
  if (typeof CompressionStream === 'undefined') return text;
  const source = new Blob([text]);
  // Hidden/unloading pages keep the original local compressor. An in-flight
  // foreground worker also falls back there when the page is hidden.
  if (typeof Worker === 'function' && globalThis.document?.visibilityState !== 'hidden') {
    try { return await gzipInWorker(source); } catch { /* use the local compressor below */ }
  }
  const stream = source.stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], {type: 'application/gzip'});
}

async function gunzip(value) {
  if (typeof value === 'string') return value;
  const stream = value.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* blocked */ } },
};

/** A new slot id: time-ordered and unique enough for one device. */
export function newSlotId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// The menu's record of a town (its own module, so the sim worker can use it).
export {metaFromSave} from './save-meta.js';

export function createSaveStore({legacyKey}) {
  let dbPromise = null;
  const db = () => (dbPromise ??= openDb().then((d) => {
    // A newer tab wants to upgrade: let it.
    d.onversionchange = () => { d.close(); dbPromise = null; };
    return d;
  }));
  let writing = Promise.resolve();
  let migrated = null;

  // The single save from before slots, and the localStorage save before that,
  // become ordinary towns in the list. Runs once per page.
  function migrate() {
    return (migrated ??= (async () => {
      try {
        const d = await db();
        const [blob, meta] = await tx(d, [SAVES, META], 'readonly', (s) => [s[SAVES].get(LEGACY_SLOT), s[META].get(LEGACY_SLOT)]);
        if (blob != null && meta == null) {
          let info = {};
          try { info = metaFromSave(await gunzip(blob)); } catch { /* unreadable: still listed */ }
          await tx(d, META, 'readwrite', (s) => s[META].put({...info, id: LEGACY_SLOT, savedAt: Date.now(), createdAt: Date.now()}, LEGACY_SLOT));
          if (!storage.get(LAST_KEY)) storage.set(LAST_KEY, LEGACY_SLOT);
        }
      } catch (err) {
        console.warn('[hearthvale] reading the saves failed', err);
      }
      const legacy = storage.get(legacyKey);
      if (legacy) {
        const id = newSlotId();
        let info = {};
        try { info = metaFromSave(legacy); } catch { /* listed anyway */ }
        if (await writeSlot(id, legacy, info)) {
          storage.remove(legacyKey);
          storage.set(LAST_KEY, id);
        } else {
          // Storage full or blocked: the old save stays where it is, and the
          // next listing tries again.
          migrated = null;
        }
      }
    })());
  }

  function writeSlot(id, text, meta = {}) {
    const run = writing.then(async () => {
      try {
        const blob = await gzip(text);
        const d = await db();
        const old = await tx(d, META, 'readonly', (s) => s[META].get(id));
        const now = Date.now();
        // Keep the old picture unless a new one came with this save.
        const record = {...old, ...meta, id, savedAt: now, createdAt: old?.createdAt ?? now, thumb: meta.thumb ?? old?.thumb ?? null};
        await tx(d, [SAVES, META], 'readwrite', (s) => [s[SAVES].put(blob, id), s[META].put(record, id)]);
        storage.set(LAST_KEY, id);
        return true;
      } catch (err) {
        console.warn('[hearthvale] save failed', err);
        return false;
      }
    });
    writing = run.catch(() => false);
    return run;
  }

  return {
    /** Every town on this device, most recently played first. */
    async list() {
      await migrate();
      try {
        const metas = await tx(await db(), META, 'readonly', (s) => s[META].getAll());
        return (metas ?? []).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
      } catch (err) {
        console.warn('[hearthvale] listing the saves failed', err);
        return [];
      }
    },

    /** The town played last, or null. */
    async latest() {
      const towns = await this.list();
      const last = storage.get(LAST_KEY);
      return towns.find((t) => t.id === last) ?? towns[0] ?? null;
    },

    /** One town's save as a JSON string, or null. */
    async load(id) {
      await migrate();
      try {
        const stored = await tx(await db(), SAVES, 'readonly', (s) => s[SAVES].get(id));
        return stored != null ? await gunzip(stored) : null;
      } catch (err) {
        console.warn('[hearthvale] reading the save failed', err);
        return null;
      }
    },

    /** Writes are serialised so a slow write can't land after a newer one. */
    save(id, text, meta) {
      return writeSlot(id, text, meta);
    },

    async rename(id, name) {
      try {
        const d = await db();
        const old = await tx(d, META, 'readonly', (s) => s[META].get(id));
        if (old) await tx(d, META, 'readwrite', (s) => s[META].put({...old, name}, id));
      } catch { /* ignore */ }
    },

    async remove(id) {
      await writing;
      try { await tx(await db(), [SAVES, META], 'readwrite', (s) => [s[SAVES].delete(id), s[META].delete(id)]); } catch { /* ignore */ }
      if (storage.get(LAST_KEY) === id) storage.remove(LAST_KEY);
    },

    lastId: () => storage.get(LAST_KEY),
  };
}
