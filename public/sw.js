// Minimal service worker — delegates caching to Netlify CDN.
// Exists only to support any installed PWA shells.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  // Clean up any caches from the old aggressive SW
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});
// No fetch handler — all requests go to network (Netlify CDN handles caching)
