// Hearthvale's service worker: the game keeps working offline once it has been played.
// Registered from index.html in production builds only (vite.config.js sets the flag);
// the Vite dev server never sees it. ?sw=0 unregisters it.
//
//   navigations, /, /index.html,      network first, the last good copy when offline
//   /manifest.webmanifest, student manifests
//   /assets/* (hashed), /icons/*,     cache first
//   /menu/*, /favicon.svg, student bundles
//   /api/*                            never cached; a student file fetched through
//                                     /api/students/ is kept under its /students/ path,
//                                     which is where the game looks when /api fails
//
// On install it also keeps every hashed file of the build (sw-assets.json, written by
// vite.config.js), so the first visit is enough to play offline; on activate it drops
// hashed files the new build no longer lists. Bump VERSION to drop every old copy.
const VERSION = '1';
const CACHE = `hearthvale-v${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon.svg', '/icons/icon-192.png'];

const isManifest = (path) => path === '/manifest.webmanifest' || /^\/students\/(.+\/)?manifest\.json$/.test(path);
// '/api/students/narration/manifest' -> '/students/narration/manifest.json'
function studentKey(path) {
  if (!path.startsWith('/api/students/')) return null;
  let key = path.slice(4);
  if (/\/manifest$/.test(key)) key += '.json';
  return key;
}
// 'network' | 'cache' | 'mirror' | null (leave the request alone).
function strategy(url, request) {
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('range')) return null;
  const path = url.pathname;
  if (path.startsWith('/api/')) return studentKey(path) ? 'mirror' : null;
  if (request.mode === 'navigate' || path === '/' || path === '/index.html' || isManifest(path)) return 'network';
  if (/^\/(assets|icons|menu|students)\//.test(path) || path === '/favicon.svg') return 'cache';
  return null;
}

async function put(key, response) {
  if (!response || !response.ok || response.redirected || response.type === 'opaque') return;
  const cache = await caches.open(CACHE);
  await cache.put(key, response);
}

async function networkFirst(request, key) {
  try {
    const response = await fetch(request);
    if (response.ok) put(key, response.clone());
    return response;
  } catch (error) {
    const hit = await caches.match(key, {ignoreSearch: true, ignoreVary: true});
    if (hit) return hit;
    throw error;
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request, {ignoreSearch: true, ignoreVary: true});
  if (hit) return hit;
  const response = await fetch(request);
  put(request, response.clone());
  return response;
}

async function mirror(request, key) {
  const response = await fetch(request);
  put(key, response.clone());
  return response;
}

async function buildAssets() {
  try {
    const response = await fetch('/sw-assets.json', {cache: 'no-store'});
    return response.ok ? (await response.json()).assets ?? null : null;
  } catch {
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const assets = (await buildAssets()) ?? [];
    await Promise.all([...SHELL, ...assets].map(async (path) => {
      if (path.startsWith('/assets/') && await cache.match(path, {ignoreVary: true})) return;
      await cache.add(path).catch(() => null);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('hearthvale-') && key !== CACHE).map((key) => caches.delete(key)));
    const assets = await buildAssets();
    if (assets) {
      const keep = new Set(assets), cache = await caches.open(CACHE);
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(request);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const how = strategy(url, event.request);
  if (!how) return;
  if (how === 'network') {
    // Every page is the one app shell, so navigations share the '/' copy.
    const key = event.request.mode === 'navigate' || url.pathname === '/index.html' ? '/' : url.pathname;
    event.respondWith(networkFirst(event.request, key));
  } else if (how === 'cache') {
    event.respondWith(cacheFirst(event.request));
  } else {
    event.respondWith(mirror(event.request, studentKey(url.pathname)));
  }
});

// The first visit loads the app before this worker controls the page; the page then
// posts what it already fetched so the next visit works offline too.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'warm' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const href of event.data.urls.slice(0, 400)) {
      let url;
      try { url = new URL(href, self.location.href); } catch { continue; }
      const how = strategy(url, new Request(url));
      if (how !== 'cache' && how !== 'mirror') continue;
      const key = how === 'mirror' ? studentKey(url.pathname) : url.pathname;
      if (await cache.match(key, {ignoreVary: true})) continue;
      try { await put(key, await fetch(url, {credentials: 'same-origin'})); } catch { /* next visit */ }
    }
  })());
});
