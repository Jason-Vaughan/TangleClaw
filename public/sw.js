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
const CACHE_NAME = 'tangleclaw-v3-59';
const STATIC_ASSETS = [
  '/',
  '/style.css',
  // shared-controls.css carries the base look for every control the session
  // banner and the Master control bar SHARE (#768). A page that renders the bar
  // without it shows unstyled controls, not a cosmetic skew — so it is precached
  // here and network-first below, never surfaced by a CACHE_NAME bump (#710).
  '/shared-controls.css',
  '/landing.js',
  '/ui.js',
  // history-drawer.js is the dashboard-shell sibling of ui.js (CC-5): cache-first
  // ui.js card buttons call into it (openHistory), so it must be precached in the
  // same generation to avoid the cache-first version skew #271 describes for
  // ui.js feature changes. The CACHE_NAME bump above is what surfaces it (and the
  // new index.html + ui.js) to operators with an active SW.
  '/history-drawer.js',
  // sw-register.js owns SW registration + update propagation (#380). Like
  // landing.js it is dual-listed (precached here for offline coherence of
  // '/', network-first below because it is cache-bust-critical).
  '/sw-register.js',
  // reconnect-policy.js is dual-listed for the same reason, with a sharper
  // failure mode: a network-first MISS while the network is down returns the
  // synthetic JSON 503, and a `<script src>` served a 503 leaves both pages
  // throwing `tcCreateReconnectPolicy is not defined` at parse time — rendering
  // nothing at all, which is strictly worse than the "Retrying… forever" this
  // module exists to fix. Precaching closes that window for fresh installs.
  // (It takes effect on the next worker install; existing workers are already
  // covered because the network-first branch caches what it fetches.)
  '/reconnect-policy.js',
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
  // api-helper.js is the shared frontend base (api()/apiMutate()/copy helper)
  // loaded before every page script on both the dashboard and session pages.
  // A stale copy hides shared-helper changes from operators the same way #271
  // describes for session.js (#427: the clipboard fix lived here) — keep it
  // network-first so a plain reload always gets the current helper.
  '/shared-controls.css',
  '/api-helper.js',
  '/session.js',
  // wrap-drawer.js is the pure-helper sibling of session.js: session.js
  // (network-first) calls its helpers directly, so a stale wrap-drawer.js
  // served from cache against a fresh session.js is a version skew that
  // throws on a missing helper (e.g. shouldStartEndedCountdown, #268). Keep
  // the two in lockstep by making both network-first.
  '/wrap-drawer.js',
  '/session.css',
  // The dashboard shell's core UI assets (category 2). ui.js builds every
  // dashboard view + the settings modal, and style.css skins them — exactly the
  // "stale-serve hides feature changes" pattern #271 cites for session.js. They
  // were cache-first, so every UI tweak stayed invisible behind an active worker
  // until a CACHE_NAME bump (a Settings-modal layout change burned a whole
  // debugging round on this). Network-first keeps them lockstep-fresh with the
  // network-first index.html; both stay precached above for offline coherence.
  '/ui.js',
  '/style.css',
  // setup.js runs the first-run wizard, including the terminal screens that tell an
  // operator whether a login is in force. It was cache-first with no carve-out, so a
  // browser with an active worker kept serving whatever copy it fetched first and any
  // change to those screens stayed invisible — the same #271 stale-serve pattern
  // called out for session.js and ui.js above, on the one screen whose whole job is to
  // not be wrong about protection (#861). Network-first rather than a CACHE_NAME bump:
  // a bump tears down and reinstalls the worker for every browser, which behind the
  // basic_auth gate is what produced the repeating credential prompt in #710.
  '/setup.js',
  '/landing.js',
  // sw-register.js is cache-bust-critical (category 1): its entire purpose is
  // service-worker lifecycle. Serving a stale copy would re-strand operators
  // on an old worker — exactly the #380 failure it exists to prevent — so it
  // must always come from the network when reachable.
  '/sw-register.js',
  // The update beacon (#931), on both pages. Category 2, and the sharpest case
  // of it: this is the surface that TELLS an operator a release exists and is
  // the only one that can apply it. A stale copy served behind an active worker
  // would hide update announcements — including announcements of the release
  // that fixes it — from the field installs that learn about releases no other
  // way. Network-first rather than a CACHE_NAME bump, which tears down and
  // reinstalls the worker for every browser and behind the basic_auth gate is
  // what produced the repeating credential prompt in #710.
  '/update-beacon.js',
  '/beacon.css',
  // reconnect-policy.js is a shared frontend base like api-helper.js: both page
  // scripts call `tcCreateReconnectPolicy` at load, so a stale copy served
  // against a fresh landing.js or session.js is not a cosmetic skew but a
  // ReferenceError that takes the whole page down. It also owns how long an
  // outage must last before the page stops calling it a blip — a rule that
  // must not be able to differ between two open tabs of the same install.
  // Network-first rather than a CACHE_NAME bump, which tears down and
  // reinstalls the worker for every browser and behind the basic_auth gate is
  // what produced the repeating credential prompt in #710.
  '/reconnect-policy.js'
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

// A real Response for a failed network-first fetch. `respondWith` THROWS
// "Returned response is null" if its promise resolves to `undefined` — which is
// exactly what `caches.match()` yields for an uncacheable POST (e.g. a session
// launch). Returning this 503 instead surfaces the real failure to the UI (#380:
// "Launch failed: FetchEvent.respondWith received an error: Returned response is
// null" was a slow tailnet launch timing out, masked as a null).
function _swErrorResponse(err) {
  return new Response(
    JSON.stringify({ error: 'network-unreachable', detail: String((err && err.message) || err || 'fetch failed') }),
    { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'application/json' } }
  );
}

// A cache-served stand-in for a network-first request whose network leg FAILED.
// The marker header is the whole point (#709): without it, a dead server hands
// the page a healthy-looking 200 and the client counts it as CONNECTED —
// rendering stale data as live and never escalating to the unreachable state.
// `api-helper.js` treats the marker as "the server did not answer". Navigations
// keep the cached shell usable either way; this only makes the failure legible.
function _withCacheFallbackMarker(cached) {
  const headers = new Headers(cached.headers);
  headers.set('X-TC-Cache-Fallback', '1');
  return cached.body !== undefined
    ? new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers })
    : cached;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isGet = event.request.method === 'GET';

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
        // Only GET responses are cacheable — `cache.put` THROWS on POST/PUT/…,
        // and a cached non-GET could never be matched back anyway.
        if (response.ok && isGet) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch((err) => {
        // Never resolve to `undefined`. A GET can fall back to cache; anything
        // else (and a GET cache miss) returns a real 503 so the failure is
        // legible instead of the opaque "Returned response is null" (#380).
        if (isGet) {
          return caches.match(event.request).then(
            (cached) => (cached ? _withCacheFallbackMarker(cached) : _swErrorResponse(err))
          );
        }
        return _swErrorResponse(err);
      })
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
