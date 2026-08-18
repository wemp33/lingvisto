// Service worker: keep the app openable with no signal.
//
// Only the shell is cached. API calls are never cached — a stale glossary or a
// replayed sync response would be worse than an honest failure, and the app
// already holds its own copy of everything in IndexedDB.

const VERSION = 'glossa-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/main.js',
  './js/api.js',
  './js/store.js',
  './js/i18n.js',
  './js/lang.js',
  './js/ui.js',
  './js/srs.js',
  './js/keyboard.js',
  './js/ink.js',
  './js/talk.js',
  './js/glossary.js',
  './js/write.js',
  './js/review.js',
  './icons/favicon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Bypass the HTTP cache so an install always fetches the current files;
    // otherwise a stale intermediary can pin an old build into the SW cache.
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first so an update lands immediately, falling back to
  // the cached shell when there is no signal.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Assets: cache first, then refresh in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request)
      .then(async (res) => {
        if (res.ok) (await caches.open(VERSION)).put(request, res.clone());
        return res;
      })
      .catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
