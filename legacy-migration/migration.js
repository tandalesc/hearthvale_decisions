// Read the old origin's saves without importing, migrating, deleting, or writing any data.
// The current Hearthvale import flow accepts the original version-2 JSON text.
(function () {
  'use strict';
  const status = document.getElementById('status');
  const list = document.getElementById('towns');
  const saves = [];

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('The browser could not read a saved town.'));
    });
  }

  async function openExistingDb() {
    if (!('indexedDB' in window)) return null;
    if (typeof indexedDB.databases === 'function') {
      const known = await indexedDB.databases();
      if (!known.some((entry) => entry.name === 'hearthvale')) return null;
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('hearthvale');
      // On older browsers without indexedDB.databases(), abort creation of an
      // empty database. Opening an existing database without a version is read-only.
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        if (request.error?.name === 'AbortError') resolve(null);
        else reject(request.error || new Error('The save database could not be opened.'));
      };
      request.onblocked = () => reject(new Error('Another tab is keeping the save database busy. Close other Hearthvale tabs, then reload this page.'));
    });
  }

  async function readSavedSlots() {
    const db = await openExistingDb();
    if (!db) return [];
    try {
      if (!db.objectStoreNames.contains('saves')) return [];
      const names = db.objectStoreNames.contains('meta') ? ['saves', 'meta'] : ['saves'];
      const transaction = db.transaction(names, 'readonly');
      const keysRequest = transaction.objectStore('saves').getAllKeys();
      const valuesRequest = transaction.objectStore('saves').getAll();
      const metasRequest = names.includes('meta') ? transaction.objectStore('meta').getAll() : null;
      const metaKeysRequest = metasRequest ? transaction.objectStore('meta').getAllKeys() : null;
      const [keys, values, metaKeys, metas] = await Promise.all([
        requestResult(keysRequest), requestResult(valuesRequest),
        metaKeysRequest ? requestResult(metaKeysRequest) : [],
        metasRequest ? requestResult(metasRequest) : [],
      ]);
      const byKey = new Map(metaKeys.map((key, index) => [String(key), metas[index]]));
      return keys.map((key, index) => ({key: String(key), stored: values[index], meta: byKey.get(String(key)) || {}}));
    } finally {
      db.close();
    }
  }

  async function storedText(stored) {
    if (typeof stored === 'string') return stored;
    if (stored instanceof Blob) {
      const header = new Uint8Array(await stored.slice(0, 2).arrayBuffer());
      if (header[0] === 0x1f && header[1] === 0x8b) {
        if (!('DecompressionStream' in window)) throw new Error('This browser cannot unpack the compressed save.');
        return new Response(stored.stream().pipeThrough(new DecompressionStream('gzip'))).text();
      }
      return stored.text();
    }
    if (stored != null && typeof stored === 'object') return JSON.stringify(stored);
    throw new Error('The saved town is empty.');
  }

  function details(text, fallback) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('The saved town is not a JSON object.');
    return {
      name: String(data.townName || fallback?.name || 'Hearthvale'),
      year: data.time?.year ?? fallback?.year ?? null,
      people: data.indicators?.pop ?? data.stats?.people ?? data.people?.length ?? fallback?.people ?? null,
      version: data.version ?? 1,
    };
  }

  function filename(name, year) {
    const safe = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'hearthvale';
    return `${safe}-year-${Number.isFinite(Number(year)) ? year : 'unknown'}.json`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function render() {
    status.hidden = saves.length > 0;
    list.hidden = saves.length === 0;
    list.replaceChildren();
    for (const save of saves) {
      const item = document.createElement('li');
      item.className = 'town';
      const info = document.createElement('div');
      info.className = 'town-info';
      const name = document.createElement('h3');
      name.className = 'town-name';
      name.textContent = save.info?.name || save.meta?.name || 'Saved town';
      const meta = document.createElement('div');
      meta.className = 'town-meta';
      const facts = [];
      if (save.info?.year != null) facts.push(`Year ${save.info.year}`);
      if (save.info?.people != null) facts.push(`${save.info.people} people`);
      facts.push(save.source);
      meta.textContent = facts.join(' · ');
      info.append(name, meta);
      if (save.error || save.info?.version !== 2) {
        const warning = document.createElement('div');
        warning.className = 'town-warning';
        warning.textContent = save.error
          ? `Could not read this save: ${save.error.message}. Download the original file for recovery.`
          : `Save version ${save.info.version} is unsupported by the new site's importer. Keep this export for recovery.`;
        info.append(warning);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = save.error ? 'Download original' : 'Download town';
      button.setAttribute('aria-label', `${button.textContent}: ${name.textContent}`);
      button.addEventListener('click', () => {
        const original = save.stored;
        const isRaw = !!save.error;
        const blob = isRaw && original instanceof Blob ? original : new Blob([isRaw ? String(original) : save.text], {type: isRaw ? 'application/octet-stream' : 'application/json'});
        const file = filename(name.textContent, save.info?.year);
        download(blob, isRaw ? `${file}.recovery` : file);
      });
      item.append(info, button);
      list.append(item);
    }
  }

  async function run() {
    let dbError = null;
    try {
      const slots = await readSavedSlots();
      for (const slot of slots) {
        const save = {...slot, source: 'Saved in this browser'};
        try { save.text = await storedText(slot.stored); save.info = details(save.text, slot.meta); }
        catch (error) { save.error = error; }
        saves.push(save);
      }
    } catch (error) { dbError = error; }
    // This old key predates IndexedDB slots. Read it directly so an IndexedDB
    // problem never conceals the last localStorage copy; do not remove it.
    try {
      const legacy = localStorage.getItem('hearthvale-save');
      if (legacy) {
        const save = {key: 'hearthvale-save', stored: legacy, text: legacy, source: 'Older browser save'};
        try { save.info = details(legacy); } catch (error) { save.error = error; }
        saves.push(save);
      }
    } catch (error) {
      dbError ??= new Error('Browser storage is blocked. Allow storage for this site, then reload.');
    }
    if (saves.length) render();
    else {
      status.textContent = dbError ? dbError.message : 'No towns were found in this browser on this old site.';
      status.classList.toggle('error', !!dbError);
    }
    if (dbError && saves.length) {
      const note = document.createElement('p');
      note.className = 'town-warning';
      note.textContent = `Some saves could not be checked: ${dbError.message}`;
      list.after(note);
    }
  }
  run();
})();
