'use strict';

/*
 * TangleClaw v3 — Service Worker registration & update propagation (#380).
 *
 * Extracted from the inline block that used to live at the bottom of
 * landing.js so the update-propagation logic is unit-testable (mirrors the
 * openclaw-cache.js IIFE pattern: a browser global + a CommonJS export).
 *
 * Why this exists — the iOS stranding bug (#380, layer 2):
 *   The opaque "FetchEvent.respondWith received an error: Returned response
 *   is null" was served by an OLD service worker that iOS Safari refused to
 *   replace. `updateViaCache: 'none'` (#258), `skipWaiting()`, and
 *   `clients.claim()` (sw.js) were all already present — the missing piece
 *   was that nothing ever asked the browser to CHECK for a new /sw.js after
 *   the initial load. iOS only auto-checks on a full navigation (and at most
 *   ~every 24h), so a long-lived tab / home-screen PWA strands the operator
 *   on the previously installed worker until they manually clear website
 *   data. Explicit reg.update() polling + a guarded controllerchange reload
 *   close that gap.
 */
(function (global) {
  /**
   * Register /sw.js and aggressively propagate new worker versions to this
   * client without requiring a manual website-data clear.
   *
   * @param {{serviceWorker?: ServiceWorkerContainer}} nav - host exposing
   *   `.serviceWorker` (the real `navigator`, or a mock in tests).
   * @param {Object} [opts]
   * @param {Function} [opts.reload] - called (at most once) when an existing
   *   controller is replaced by a new worker. Injected for testability;
   *   defaults to a no-op.
   * @param {Function} [opts.addVisibilityListener] - registers a callback to
   *   run when the tab regains visibility. Injected for testability; defaults
   *   to a `visibilitychange` listener on `document`.
   * @returns {Promise<ServiceWorkerRegistration|null>} the registration, or
   *   null when service workers are unavailable / registration failed.
   */
  function registerServiceWorker(nav, opts) {
    opts = opts || {};
    const reload = typeof opts.reload === 'function' ? opts.reload : function () {};
    if (!nav || !nav.serviceWorker) return Promise.resolve(null);
    const sw = nav.serviceWorker;

    // controllerchange fires on the FIRST registration too (controller goes
    // null -> new via clients.claim). Reloading then would spuriously refresh
    // a first-time visitor mid-load. Capture whether a worker ALREADY
    // controls this page: only an existing controller being replaced
    // (old -> new) is a real update that warrants a reload.
    const hadController = !!sw.controller;
    let reloading = false;
    sw.addEventListener('controllerchange', function () {
      if (!hadController || reloading) return;
      reloading = true; // guard: reload at most once, never loop
      reload();
    });

    return sw.register('/sw.js', { updateViaCache: 'none' }).then(function (reg) {
      if (!reg) return null;

      // The actual #380 fix: poll for a fresh /sw.js on load and whenever the
      // tab regains visibility, so skipWaiting + clients.claim can hand
      // control to a new worker even on a long-lived iOS tab that never
      // triggers the browser's own update check. A failed poll is swallowed
      // (same posture as the original register().catch()) — it simply retries
      // on the next visibility change.
      const checkForUpdate = function () { reg.update().catch(function () {}); };
      checkForUpdate();

      const addVisibilityListener = opts.addVisibilityListener || (
        global && global.document
          ? function (cb) { global.document.addEventListener('visibilitychange', cb); }
          : null
      );
      if (addVisibilityListener) {
        addVisibilityListener(function () {
          // No document (or visible) -> check. Hidden -> skip; the next
          // foreground transition will fire this again.
          if (!global || !global.document || global.document.visibilityState === 'visible') {
            checkForUpdate();
          }
        });
      }
      return reg;
    }).catch(function () { return null; });
  }

  // Browser: register immediately on load. Same trigger point as the old
  // inline landing.js block, now hardened against the iOS stranding bug.
  if (global && global.navigator && global.navigator.serviceWorker) {
    registerServiceWorker(global.navigator, {
      reload: function () { if (global.location) global.location.reload(); }
    });
  }

  // Node (test): expose via CommonJS too.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { registerServiceWorker };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
