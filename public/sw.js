// Minimal service worker: makes the app installable and shows the last-loaded
// page when offline. Network first, so a new deploy is never hidden by a stale
// cache. Only same-origin GET requests are cached; Supabase calls (another
// origin) and everything else are left alone, so no private data is stored.
const CACHE = 'campconnect-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); }
    return response;
  }).catch(() => caches.match(request).then(hit => hit || (request.mode === 'navigate' ? caches.match(self.registration.scope) : undefined))));
});
