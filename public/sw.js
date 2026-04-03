const CACHE_NAME = 'edia-stratmap-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
];

// Install: precache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for same-origin, skip tiles
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip tile requests — let them fail gracefully when offline
  if (url.hostname.includes('tile.openstreetmap.org')) return;

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Same-origin: cache-first, falling back to network, then cache the response
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  }
});
