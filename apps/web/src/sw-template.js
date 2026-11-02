/* FeltCircle service worker (generated at build time). */
const VERSION = '__VERSION__';
const CACHE = `feltcircle-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('feltcircle-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the multiplayer API or WebSocket endpoints.
  if (url.pathname.includes('/api/')) return;

  const scope = new URL(self.registration.scope);
  const isNavigation = req.mode === 'navigate';
  const isConfig = url.pathname === new URL('config.json', scope).pathname;

  if (isNavigation || isConfig) {
    // Network first so updates and runtime config apply; fall back to cache offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(isNavigation ? './' : req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(isNavigation ? './' : req, { ignoreSearch: true })) || (await caches.match('./')) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
