'use strict';
/* ── TangleClaw v3 — OpenClaw localStorage cache-bust helper ── */
/*                                                                  */
/* OpenClaw's dashboard JS caches its derived WebSocket URL in       */
/* localStorage. When TC proxies multiple OpenClaw connections       */
/* through the same TC origin, the first-loaded dashboard's WS URL   */
/* gets re-used by subsequent loads — sending traffic to the wrong   */
/* connection's tunnel (#162). Clear stale entries that reference a  */
/* different connection's id before navigating the iframe.           */
/*                                                                   */
/* Same UMD-ish factory pattern as api-helper.js: a single function  */
/* exposed on `window` for the browser, and also `module.exports`'d  */
/* so test files can `require` it directly.                          */

(function (global) {
  // UUID-shape sanity check for currentConnId. The server route at
  // `/openclaw-view/:connId` accepts any non-empty path segment, but the
  // canonical OpenClaw connection id is a UUID. Refuse to touch storage when
  // the input looks malformed — defense against an unbound future route
  // surface (e.g. a typo URL accidentally nuking arbitrary localStorage keys).
  // Hex chars + dashes, length 16-64 covers UUIDs and the 24-char "short id"
  // variant some legacy openclaw builds use.
  const CONN_ID_SHAPE = /^[0-9a-fA-F-]{16,64}$/;

  // Pattern for extracting connection ids embedded in cached values. UUIDs
  // are case-insensitive per RFC 4122 §3 — both extraction and comparison
  // are normalized to lowercase below so a value emitted with mixed case
  // doesn't get misclassified as stale.
  const OPENCLAW_DIRECT_REF = /\/openclaw-direct\/([0-9a-fA-F-]+)/g;

  /**
   * Walk `storage` and remove every entry whose value references one or more
   * `/openclaw-direct/<connId>/` paths AND none of those references match
   * `currentConnId` (case-insensitive). Entries whose values reference both
   * the current connection AND a stale one are PRESERVED — composite blobs
   * shouldn't lose legitimate current-connection state just because they
   * also mention an old id.
   *
   * Behaviour notes:
   *   - Idempotent — calling twice with the same connId does nothing the
   *     second time.
   *   - Same-connection cache stays intact — the dashboard's prior session
   *     state survives navigation away and back, including across UUID case
   *     differences (canonical lowercase vs uppercase emission).
   *   - Composite-value safe — `matchAll` is used so a value with multiple
   *     openclaw-direct references is classified by the union, not the first
   *     match (Critic MAJOR-2).
   *   - Tolerant of storage unavailability (incognito modes, file://, etc.) —
   *     returns 0 on any thrown access.
   *   - Walks backwards so live mutation via `removeItem` doesn't skip keys.
   *   - UUID-shape validation on `currentConnId` — defensive against an
   *     accidental empty / malformed connId nuking unrelated keys.
   *
   * @param {string} currentConnId - The connection id being navigated to.
   * @param {Storage} [storage] - The storage to walk. Defaults to
   *   `window.localStorage` in the browser, otherwise required.
   * @returns {number} Number of keys removed.
   */
  function clearStaleOpenclawCache(currentConnId, storage) {
    if (typeof currentConnId !== 'string' || !currentConnId) return 0;
    if (!CONN_ID_SHAPE.test(currentConnId)) return 0;
    if (!storage) {
      storage = (typeof window !== 'undefined' && window.localStorage)
        ? window.localStorage
        : null;
    }
    if (!storage) return 0;

    const currentLc = currentConnId.toLowerCase();
    let removed = 0;
    try {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (!key) continue;
        const val = storage.getItem(key);
        if (typeof val !== 'string') continue;
        // #162-followup: OpenClaw's dashboard (`openclaw.control.settings.v1*`
        // and friends) serializes its gateway URL with escape forms the raw
        // regex misses — JSON-escaped slashes (`\/`), URL-encoded slashes
        // (`%2F`), unicode-escaped slashes (`/`). Normalize before
        // matching so cached `wss://h/openclaw-direct/<staleId>` survives any
        // of those encodings and still gets caught.
        const normalized = val
          .replace(/\\\//g, '/')
          .replace(/%2[Ff]/g, '/')
          .replace(/\\u002[Ff]/g, '/');
        const matches = [...normalized.matchAll(OPENCLAW_DIRECT_REF)];
        if (matches.length === 0) continue;
        let hasStale = false;
        let hasCurrent = false;
        for (const m of matches) {
          if (m[1].toLowerCase() === currentLc) hasCurrent = true;
          else hasStale = true;
        }
        // Only delete when EVERY reference is stale. Mixed composites stay.
        if (hasStale && !hasCurrent) {
          storage.removeItem(key);
          removed++;
        }
      }
    } catch (_err) {
      // Storage may be unavailable (incognito / disabled) — fail open.
    }
    // #246 — surface the removed-count in the browser console when
    // non-zero. Operators debugging "stale cache wasn't cleared" can
    // now see at a glance whether this function fired (and how many
    // entries it touched) vs. silently failed. Quiet on the common
    // case (count=0) so normal page loads don't spam the console. The
    // log itself is the breadcrumb the #246 next-investigation-step
    // asked for: if removed > 0 yet stale data persists, the SW is no
    // longer the suspect — look at the dashboard's restore-from-
    // sibling-storage path.
    if (removed > 0 && typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[oc-cache] removed', removed, 'stale entries for connId', currentConnId);
    }
    return removed;
  }

  // Browser: expose on window so /openclaw-view.js can call it.
  if (global) {
    global.tcClearStaleOpenclawCache = clearStaleOpenclawCache;
  }
  // Node (test): expose via CommonJS module.exports too.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { clearStaleOpenclawCache };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
