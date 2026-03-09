// GambleCodez Web Lab — Service Worker
const CACHE = 'gcz-lab-v1';
const OFFLINE_URLS = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Don't intercept API or proxy calls
  if (e.request.url.includes('/api/') || e.request.url.includes('/proxy')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
