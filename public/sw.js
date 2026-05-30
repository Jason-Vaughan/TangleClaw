/* ── TangleClaw v3 — Service Worker ── */
/* Cache-first for static assets, network-first for API + HTML +       */
/* cache-bust-critical scripts (#246).                                  */

// Bump this on every TC release to force every active SW to install a
// fresh cache + the `activate` handler to evict the old one. #246
// surfaced what happens when a cache-bust-critical script
// (openclaw-cache.js) gets stuck behind the cache-first fetch handler:
// new releases of the file can't reach operators with an active SW,
// even after they hit Cmd+Shift+R. The network-first carve-out below
// is the structural fix; this bump is the one-time unblock for
// existing installs.
const CACHE_NAME = 'tangleclaw-v3-13';
const STATIC_ASSETS = [
  '/',
  '/style.css',
  '/landing.js',
  '/ui.js',
  '/manifest.json'
];

// Files in this set get network-first treatment, same as API/navigation.
// Two categories accepted today:
//   1. Scripts whose ENTIRE PURPOSE is cache invalidation (#246). Serving
//      a stale copy from the SW cache is by definition wrong, since the
//      operator just shipped a new version precisely because the old one
//      had a cache-related bug.
//   2. Core UI assets where stale-serve has historically hidden feature
//      changes from operators (#271). The #267 verification pass surfaced
//      that the new findings panel didn't render until `Cmd+Shift+R`
//      because the SW served a stale `session.js`. This pattern recurs
//      every time a feature PR ships UI changes; the ~50ms latency tax
//      per asset is preferred over operators concluding "the feature is
//      broken" when in fact the new code never reached their browser.
// Keep this set small and audited — every entry pays the latency cost of
// a network fetch on every page load.
const NETWORK_FIRST_PATHS = new Set([
  '/openclaw-cache.js',
  '/session.js',
  '/session.css',
  '/landing.js'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for API calls, HTML pages, and cache-bust-critical
  // scripts (#246). The script-level carve-out is what prevents the
  // cache-first branch below from stranding a fix to any file in
  // NETWORK_FIRST_PATHS on operators with an active SW.
  if (
    url.pathname.startsWith('/api/') ||
    event.request.mode === 'navigate' ||
    NETWORK_FIRST_PATHS.has(url.pathname)
  ) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets
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
});
