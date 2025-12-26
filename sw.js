// Bump cache name on each release so GitHub Pages updates don't get stuck
// behind an old Service Worker cache.
const CACHE = 'paver-webar-v6.1.5';

const ASSETS = [
  './',
  './index.html',
  './unsupported.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './assets/logo.png',
  './catalog/catalog.json',
  './catalog/tiles/demo_antika_neapol/base.png',
  './catalog/tiles/demo_antika_neapol/normal.png',
  './catalog/tiles/demo_antika_neapol/roughness.png',
  './catalog/tiles/demo_antika_neapol/thumb.jpg',
  './catalog/tiles/demo_khersones/base.png',
  './catalog/tiles/demo_khersones/normal.png',
  './catalog/tiles/demo_khersones/roughness.png',
  './catalog/tiles/demo_khersones/thumb.jpg',
  './admin.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache cross-origin (three.js from unpkg etc.)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return resp;
      }).catch(() => caches.match('./unsupported.html'));
    })
  );
});
