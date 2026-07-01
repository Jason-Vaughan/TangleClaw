'use strict';
/* ── TangleClaw v3 — Shared frontend API helper ── */
/* Single source of truth for the `api()` / `apiMutate()` helpers used by */
/* landing.js, session.js, and openclaw-view.js. Loaded as a plain script */
/* before any page script, exposing two factories on `window`. */

(function (global) {
  /**
   * Create an `api()` function for a page. The returned function fetches a
   * JSON endpoint and returns parsed data, or `null` on any error. Errors
   * are surfaced via two function properties (`api.lastError` and
   * `api.lastErrorCode`) so call sites can render the real server message
   * instead of falling back to "Check server logs". See PR #84 / issue #80
   * for the side-channel rationale.
   *
   * @param {object} [opts]
   * @param {(connected: boolean) => void} [opts.setConnected] - Optional
   *   hook called with `true` on a successful response and `false` on a
   *   network-level failure (TypeError / "Failed to fetch"). Pages without
   *   a connection banner (e.g. openclaw-view) omit this and the helper
   *   no-ops the connection-state plumbing while still surfacing the
   *   "Connection lost." message via `api.lastError`.
   * @returns {Function & { lastError: string|null, lastErrorCode: string|null }}
   */
  function tcCreateApi(opts) {
    const setConnected = (opts && opts.setConnected) || function () {};

    async function api(url, fetchOpts) {
      try {
        const res = await fetch(url, fetchOpts);
        const data = await res.json();
        if (!res.ok) {
          api.lastError = data.error || `HTTP ${res.status}`;
          api.lastErrorCode = data.code || null;
          console.error(`API ${url}: ${api.lastError}${api.lastErrorCode ? ` (${api.lastErrorCode})` : ''}`);
          return null;
        }
        api.lastError = null;
        api.lastErrorCode = null;
        setConnected(true);
        return data;
      } catch (err) {
        if (err.name === 'TypeError' || err.message === 'Failed to fetch') {
          setConnected(false);
          api.lastError = 'Connection lost.';
        } else {
          api.lastError = err.message || 'Unknown error';
        }
        api.lastErrorCode = null;
        console.error(`API ${url}:`, err.message);
        return null;
      }
    }
    api.lastError = null;
    api.lastErrorCode = null;
    return api;
  }

  /**
   * Create an `apiMutate()` wrapper around a previously created `api()`.
   * Sends `method` with a JSON body via the supplied `api()` so the
   * lastError side-channel and connection plumbing apply uniformly.
   *
   * @param {Function} api - The page's `api()` instance from `tcCreateApi`.
   * @returns {(url: string, method: string, body: object) => Promise<object|null>}
   */
  function tcCreateApiMutate(api) {
    return function apiMutate(url, method, body) {
      return api(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    };
  }

  /**
   * Copy `text` to the clipboard, working in BOTH secure (HTTPS / localhost)
   * and insecure (plain-HTTP) contexts. The async Clipboard API
   * (`navigator.clipboard`) is only defined in a secure context, so over plain
   * HTTP on a non-localhost origin (e.g. `http://host:8080` over Tailscale) it
   * is `undefined` and every copy button silently failed (#427). Falls back to
   * a hidden-`<textarea>` + `document.execCommand('copy')`, which works on HTTP.
   * The fallback selects via a `Range` + `setSelectionRange` on a non-readonly
   * element rather than `readonly` + `.select()`, because the latter copies
   * nothing on iOS Safari (#435).
   *
   * @param {string} text - The text to copy.
   * @returns {Promise<boolean>} `true` on success, `false` if both paths fail.
   */
  async function tcCopyToClipboard(text) {
    if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
      try {
        await global.navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // Secure-context API present but rejected (permissions, focus, …) —
        // fall through to the legacy path rather than failing outright.
      }
    }
    try {
      const doc = global.document;
      const ta = doc.createElement('textarea');
      ta.value = text;
      // iOS Safari: a `readonly` textarea + `.select()` yields no copyable
      // selection, so execCommand('copy') no-ops (#435). Make the element
      // editable and select it via a Range + setSelectionRange, which copies
      // on iOS AND desktop.
      ta.contentEditable = 'true';
      ta.readOnly = false;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      doc.body.appendChild(ta);
      const range = doc.createRange();
      range.selectNodeContents(ta);
      const sel = typeof global.getSelection === 'function' ? global.getSelection() : null;
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (typeof ta.setSelectionRange === 'function') {
        ta.setSelectionRange(0, text.length);
      }
      const ok = doc.execCommand('copy');
      doc.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  global.tcCreateApi = tcCreateApi;
  global.tcCreateApiMutate = tcCreateApiMutate;
  global.tcCopyToClipboard = tcCopyToClipboard;
})(typeof window !== 'undefined' ? window : globalThis);
