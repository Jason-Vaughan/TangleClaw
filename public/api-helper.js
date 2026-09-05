'use strict';
/* ── TangleClaw v3 — Shared frontend helpers and components ── */
/* Loaded as a plain script before any page script, exposing everything it */
/* publishes on `window`. Two kinds of thing live here: */
/*                                                                        */
/*   1. The `api()` / `apiMutate()` factories used by landing.js,          */
/*      session.js and openclaw-view.js.                                   */
/*   2. Browser COMPONENTS a page mounts — the Medusa control, the Master  */
/*      settings and control bar, the settings-warnings banner, the chime  */
/*      control. They live here for two reasons that keep proving          */
/*      themselves: a component rendered on more than one page must have   */
/*      one implementation or the surfaces drift, and a page script cannot */
/*      be require()d, so anything only reachable from `session.js` can be */
/*      tested by grepping its source and no other way.                    */
/*                                                                        */
/* Tests lift this file into a sandbox (`test/_api-helper-globals.js`) and */
/* RUN what it publishes against the mini DOM. That is the point: a source */
/* probe once proved a branch existed while the real `api()` made it       */
/* unreachable (#928 R-1). */

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
   *   hook called with `true` on a successful response and `false` whenever
   *   the server did not answer, in any of its shapes: a network-level
   *   failure (TypeError / "Failed to fetch"), a service-worker cache
   *   fallback or synthetic 503 (#709), or a gateway 502/503/504 with a
   *   non-JSON body (#924). Pages without a connection banner (e.g.
   *   openclaw-view) omit this and the helper no-ops the connection-state
   *   plumbing while still surfacing the "Connection lost." message via
   *   `api.lastError`.
   * @returns {Function & { lastError: string|null, lastErrorCode: string|null }}
   */
  function tcCreateApi(opts) {
    const setConnected = (opts && opts.setConnected) || function () {};

    async function api(url, fetchOpts) {
      try {
        const res = await fetch(url, fetchOpts);
        // On a service-worker-controlled page a dead server never rejects this
        // fetch (#709): sw.js resolves it as either a cache-served stand-in
        // (marked with this header) or a synthetic 503. Both mean THE SERVER
        // DID NOT ANSWER — a cached 200 here is stale data, and counting it as
        // connected rendered a dead backend as a healthy dashboard.
        if (res.headers && res.headers.get && res.headers.get('X-TC-Cache-Fallback')) {
          setConnected(false);
          api.lastError = 'Connection lost.';
          api.lastErrorCode = null;
          return null;
        }
        // Behind an ingress the backend's death is not a failed fetch either
        // (#924): Caddy answers FOR the dead upstream with a 502/503/504 whose
        // body is empty or HTML. The JSON test is the discriminator that keeps
        // the server's own meaningful 5xxs — health 503, tmux-dependency 503,
        // Medusa-hub 502, all `{error, code}` JSON — surfacing as route errors
        // rather than outages. A gateway page is not the server speaking.
        if ((res.status === 502 || res.status === 503 || res.status === 504)
            && !(((res.headers && res.headers.get && res.headers.get('content-type')) || '')
              .includes('json'))) {
          setConnected(false);
          api.lastError = 'Connection lost.';
          api.lastErrorCode = null;
          return null;
        }
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 503 && data.error === 'network-unreachable') {
            setConnected(false);
            api.lastError = 'Connection lost.';
            api.lastErrorCode = null;
            return null;
          }
          api.lastError = data.error || `HTTP ${res.status}`;
          api.lastErrorCode = data.code || null;
          // The whole refusal body, for callers whose refusal carries more
          // than a sentence (#711: dirty-tree's structured file lists). The
          // null return stays the contract; this is the side channel beside
          // lastError/lastErrorCode, cleared on every success below.
          api.lastBody = data;
          console.error(`API ${url}: ${api.lastError}${api.lastErrorCode ? ` (${api.lastErrorCode})` : ''}`);
          return null;
        }
        api.lastError = null;
        api.lastErrorCode = null;
        api.lastBody = null;
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
    api.lastBody = null;
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
   * @param {Document} [targetDoc] - Document to perform the copy IN. Safari
   *   scopes user-gesture permission to the FRAME that received the gesture
   *   (#445 iteration 4: a touchend inside the terminal iframe cannot
   *   authorize a copy in the parent document), so gestures originating in
   *   an iframe must pass that iframe's document. Defaults to the parent
   *   document — existing button callers are unchanged.
   * @returns {Promise<boolean>} `true` on success, `false` if both paths fail.
   */
  async function tcCopyToClipboard(text, targetDoc) {
    const doc = targetDoc || global.document;
    const view = doc.defaultView || global;
    if (view.navigator && view.navigator.clipboard && view.isSecureContext) {
      try {
        await view.navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // Secure-context API present but rejected (permissions, focus, …) —
        // fall through to the legacy path rather than failing outright.
      }
    }
    try {
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
      const sel = typeof view.getSelection === 'function' ? view.getSelection() : null;
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (typeof ta.setSelectionRange === 'function') {
        ta.setSelectionRange(0, text.length);
      }
      const ok = doc.execCommand('copy');
      // Deselect before removal — a dangling range over a removed node left
      // iOS's native selection machinery in a confused state on the next
      // gesture (#445 iteration 4's "unbounded" re-selections).
      if (sel) sel.removeAllRanges();
      doc.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  /**
   * What a Copy button should tell the operator, as one decision (#438).
   *
   * Pure so the toast wording is tested rather than eyeballed: the three
   * honest outcomes — copied N characters, nothing to copy yet, and a named
   * failure — must never collapse into one "Copied" that lies. Both Copy
   * buttons on the session page (toolbar → tmux buffer, Peek → its own DOM
   * text) route through here, so they read the same.
   *
   * @param {object} outcome - What happened
   * @param {string|null} [outcome.text] - The text that was (or would be)
   *   copied; `''`/null means there was nothing to copy.
   * @param {boolean} [outcome.copied] - Whether `tcCopyToClipboard` reported
   *   success. Ignored when there was no text.
   * @param {string} [outcome.error] - The server's reason when the fetch
   *   refused (`api.lastError`); named in the toast.
   * @param {string} [outcome.errorCode] - The server's code (`api.lastErrorCode`).
   *   `NO_BUFFER` is the "nothing to copy yet" state, not a failure.
   * @returns {{ msg: string, cls: 'toast-ok'|'toast-warn' }} Toast text and tone.
   */
  function tcCopyOutcome(outcome) {
    const o = outcome || {};
    if (o.errorCode === 'NO_BUFFER') {
      // No "select text first": on the phone this button exists for, the
      // terminal cannot be selected at all — Peek → Copy is that device's path.
      return { msg: 'Nothing to copy yet — on a phone use Peek → Copy', cls: 'toast-warn' };
    }
    if (o.error) {
      return { msg: `Could not read the terminal selection: ${o.error}`, cls: 'toast-warn' };
    }
    const text = typeof o.text === 'string' ? o.text : '';
    if (text.length === 0) {
      return { msg: 'Nothing to copy yet', cls: 'toast-warn' };
    }
    if (!o.copied) {
      return { msg: 'Could not copy — the browser refused the clipboard write', cls: 'toast-warn' };
    }
    const n = text.length;
    return { msg: `Copied ${n.toLocaleString()} character${n === 1 ? '' : 's'}`, cls: 'toast-ok' };
  }

  /**
   * Which clipboard write a fetch-then-copy button should use (#438).
   *
   * The text arrives from the server AFTER an `await`, and iOS Safari drops
   * the tap's user activation across that await — `writeText` and
   * `execCommand('copy')` then refuse. The one write Safari keeps activation
   * for is `navigator.clipboard.write([new ClipboardItem({'text/plain':
   * <Promise<Blob>>})])` issued synchronously inside the gesture, with the
   * fetch as the promise. That needs the async Clipboard API's `write`, the
   * `ClipboardItem` constructor, and a secure context (the API is undefined
   * outside one). Anything less falls back to the `tcCopyToClipboard` path,
   * which on plain-HTTP iOS may lose the gesture — stated, not hidden.
   *
   * Pure (TST-6L2P lift pattern) so the decision is tested; the browser
   * behaviour it encodes is documented Safari behaviour, not yet verified on a
   * device from this page.
   *
   * @param {object} caps - Capabilities of the current window
   * @param {boolean} caps.hasWrite - `navigator.clipboard.write` is a function
   * @param {boolean} caps.hasClipboardItem - `window.ClipboardItem` is a constructor
   * @param {boolean} caps.secure - `window.isSecureContext`
   * @returns {'item'|'legacy'} `item` = promise-valued ClipboardItem write inside
   *   the gesture; `legacy` = fetch, then `tcCopyToClipboard`.
   */
  function tcClipboardWritePath(caps) {
    const c = caps || {};
    return (c.hasWrite && c.hasClipboardItem && c.secure) ? 'item' : 'legacy';
  }

  /**
   * xterm.js theme palettes keyed by TangleClaw theme name — the single
   * source of truth for terminal colors (UI-4C7R). Every terminal iframe
   * (session terminal, landing Master pane, in-session Master drawer) pulls
   * from this map; per-page palette copies drifted before and are banned.
   * @type {Object<string, Object>}
   */
  const TC_XTERM_THEMES = {
    dark: {
      background: '#000000',
      foreground: '#E8E8E8',
      cursor: '#E8E8E8',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(139,195,74,0.3)'
    },
    light: {
      background: '#F5F5F5',
      foreground: '#1A1A1A',
      cursor: '#1A1A1A',
      cursorAccent: '#F5F5F5',
      selectionBackground: 'rgba(139,195,74,0.3)'
    },
    'high-contrast': {
      background: '#000000',
      foreground: '#FFFFFF',
      cursor: '#FFFFFF',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(164,214,94,0.4)'
    }
  };

  /**
   * Push a TangleClaw color theme into an xterm.js instance. Unknown theme
   * names fall back to dark. Null-safe: a missing/not-ready term is a no-op.
   * @param {object} term - The xterm.js Terminal instance inside the iframe
   * @param {string} theme - Theme key ('dark', 'light', 'high-contrast')
   * @returns {boolean} true when the theme was applied
   */
  function tcApplyTerminalTheme(term, theme) {
    if (!term || !term.options) return false;
    term.options.theme = TC_XTERM_THEMES[theme] || TC_XTERM_THEMES.dark;
    return true;
  }

  /**
   * Restore a "copy to MY device" selection gesture in a ttyd terminal
   * iframe (#431).
   *
   * Modern TUIs (Claude Code) enable xterm mouse tracking, so a plain drag
   * never reaches xterm's own selection engine — the app consumes it,
   * renders its own highlight, and copies the text on the HOST machine
   * (pbcopy on the TC server + a tmux buffer). Nothing ever lands on the
   * clipboard of the device the browser runs on, and ttyd's bundled xterm
   * has no OSC 52 handler that could carry it across. Remote operators
   * therefore had NO working copy path.
   *
   * xterm's escape hatch is a modifier that forces a local selection despite
   * app mouse capture. On non-mac platforms that is Shift+drag and always
   * works; on macOS it is Option(⌥)+drag gated behind
   * `macOptionClickForcesSelection`, which defaults to FALSE — so on a Mac
   * no gesture works at all out of the box. Flipping the option makes
   * ⌥+drag produce a native xterm selection, which ttyd's copy-on-select
   * then writes to the BROWSER's clipboard via `document.execCommand('copy')`
   * — spaces intact, and it works over plain HTTP (no secure-context
   * requirement).
   *
   * ttyd's own copy-on-select calls `execCommand('copy')` from xterm's async
   * selection-change emit — real Chrome can refuse that (the transient user
   * activation is already spent), leaving selection working but auto-copy
   * silently dead (Cmd+C still works: xterm's copy handler feeds the real
   * buffer text). So this also re-runs the copy inside an actual `mouseup`
   * gesture, where activation is guaranteed. No-op when there is no xterm
   * selection (a plain drag consumed by the TUI), so Claude Code's own
   * drag-to-select behavior is untouched.
   *
   * @param {object} term - the xterm.js Terminal instance inside the iframe
   * @param {Document} doc - the terminal iframe's document (same-origin)
   */
  function tcEnableLocalSelectionOverride(term, doc) {
    if (term && term.options) term.options.macOptionClickForcesSelection = true;
    if (doc && !doc.tcCopyOnMouseUp) {
      doc.tcCopyOnMouseUp = true;
      doc.addEventListener('mouseup', () => {
        try {
          if (term.getSelection()) doc.execCommand('copy');
        } catch (_) { /* clipboard refused — Cmd+C still available */ }
      });
    }
  }

  /**
   * Quantize an accumulated touch-drag distance into whole scroll lines
   * (#443 math, pure — UI-9J3F). Carries the sub-line remainder between
   * calls so slow drags still scroll: callers feed `remainder` back in as
   * the next call's `accum`. `Math.trunc` keeps the sign symmetric (drag up
   * = negative lines = scroll up) and never rounds a partial line into a
   * phantom scroll.
   * @param {number} accum - Carried sub-line remainder from the last call (px)
   * @param {number} deltaY - This move's drag distance (px; positive = scroll down)
   * @param {number} lineHeight - Pixels per terminal line
   * @returns {{lines: number, remainder: number}} whole lines to scroll now
   *   (0 while the running total is still sub-line) + the leftover px to carry
   */
  function tcQuantizeScrollDelta(accum, deltaY, lineHeight) {
    const total = accum + deltaY;
    // `|| 0` normalizes Math.trunc's -0 (sub-line upward totals) so callers
    // comparing with Object.is semantics never see a negative zero.
    const lines = Math.trunc(total / lineHeight) || 0;
    return { lines, remainder: total - lines * lineHeight };
  }

  /**
   * Map a client point to xterm BUFFER coordinates (#445 math, pure —
   * UI-9J3F). Clamps to the grid so touches at the edges select the nearest
   * cell instead of walking off the buffer, and adds the viewport's scroll
   * offset so the row is a BUFFER row (what `term.select()` wants), not a
   * screen row.
   * @param {{clientX: number, clientY: number}} point - The touch point
   * @param {{left: number, top: number, width: number, height: number}} rect -
   *   The `.xterm-screen` bounding rect
   * @param {number} cols - Terminal column count
   * @param {number} rows - Terminal (viewport) row count
   * @param {number} viewportY - Buffer row of the first visible line
   * @returns {{col: number, row: number}} buffer coordinates
   */
  function tcCellFromPoint(point, rect, cols, rows, viewportY) {
    const col = Math.max(0, Math.min(cols - 1,
      Math.floor((point.clientX - rect.left) / (rect.width / cols))));
    const row = Math.max(0, Math.min(rows - 1,
      Math.floor((point.clientY - rect.top) / (rect.height / rows))));
    return { col, row: viewportY + row };
  }

  /**
   * Normalize two buffer cells into the (start, length) span xterm's
   * `select(col, row, length)` API wants (#445 math, pure — UI-9J3F). Swaps
   * the anchor when the drag runs backward (either direction selects); the
   * length counts cells left-to-right across intervening full rows,
   * inclusive of both endpoints.
   * @param {{col: number, row: number}} from - The selection anchor
   * @param {{col: number, row: number}} to - The cell under the finger
   * @param {number} cols - Terminal column count
   * @returns {{col: number, row: number, length: number}} `select()` args
   */
  function tcSelectionSpan(from, to, cols) {
    let a = from;
    let b = to;
    if (b.row < a.row || (b.row === a.row && b.col < a.col)) {
      a = to;
      b = from;
    }
    return { col: a.col, row: a.row, length: (b.row - a.row) * cols + (b.col - a.col) + 1 };
  }

  /**
   * Parse the connection form's Bridge Port field into the API's
   * `bridgePort` request value (#489, OUI-2F8K). Three valid shapes: blank
   * means no bridge port (null — the #160 contract: never fabricate a
   * phantom bind), the literal `auto` opts into server-side free-port
   * allocation (#352 on create; idempotent on update, #483), and a whole
   * port number is sent verbatim. Anything else is rejected rather than
   * coerced — the field is a text input so `auto` can be typed, and
   * silently mapping a typo to null would CLEAR an existing bridge port on
   * edit (releasing its lease, #483).
   * @param {string} raw - The field value, untrimmed
   * @returns {{ok: true, value: (null|string|number)}|{ok: false, error: string}}
   *   On success `value` is null, the lowercase literal 'auto', or the port
   *   number; on failure `error` is the message to show on the form.
   */
  function tcParseBridgePort(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return { ok: true, value: null };
    if (s.toLowerCase() === 'auto') return { ok: true, value: 'auto' };
    if (/^\d+$/.test(s)) {
      const port = parseInt(s, 10);
      if (port >= 1 && port <= 65535) return { ok: true, value: port };
      return { ok: false, error: `Bridge Port must be between 1 and 65535 (got ${port})` };
    }
    return { ok: false, error: 'Bridge Port must be a port number, "auto", or blank' };
  }

  /**
   * Decide the /api/tmux/mouse body select mode should POST (#574 RC2 +
   * #579, pure). Entering keeps the legacy platform split: mobile turns
   * mouse ON (frees native text selection), desktop turns it OFF (a plain
   * drag reaches xterm's local selection engine). Exiting must restore the
   * pre-select CONFIGURATION, not just its value (#579): when the
   * pre-select state was inherited from the global, restoring by SETTING
   * the value strands a session-level override that pins the session
   * against future global changes — the benign-valued sibling of the #574
   * stranded-`off` bug. Inherited state is restored by unsetting.
   * @param {{entering: boolean, isMobile: boolean, mouseOn: boolean,
   *   mouseExplicit: boolean}} opts - `entering` = toggling INTO select
   *   mode; `mouseOn`/`mouseExplicit` = the pre-select effective mouse
   *   state and whether it was a session-level override (from
   *   GET /api/tmux/mouse's `explicit`)
   * @returns {{on: boolean}|{unset: true}} the /api/tmux/mouse body fields
   */
  function tcSelectModeMouse(opts) {
    if (opts.entering) return { on: !!opts.isMobile };
    if (opts.mouseExplicit) return { on: !!opts.mouseOn };
    return { unset: true };
  }

  /**
   * Parse and validate a persisted select-mode intent marker (UI-8W3D, pure).
   *
   * Entering select mode stores the pre-select mouse state in localStorage
   * BEFORE flipping tmux; a clean exit removes it. A marker found at page
   * load therefore means the previous visit died mid-select (reload, tab
   * close, crash) and its restore never ran — the stranded-override
   * abandonment window that the #580 unset-on-exit fix could not close
   * (no exit event fires on a reload). The reader must not trust raw
   * storage: it validates shape and types, returning null for anything
   * malformed so a corrupt value can never drive a tmux write.
   * @param {string|null} raw - The raw localStorage value (or null)
   * @returns {{on: boolean, explicit: boolean}|null} the recorded
   *   pre-select state, or null when absent/malformed
   */
  function tcParseSelectMarker(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.on !== 'boolean' || typeof parsed.explicit !== 'boolean') return null;
      return { on: parsed.on, explicit: parsed.explicit };
    } catch (_) {
      return null;
    }
  }

  /**
   * Decide which paste path the Paste affordance should take (#402, pure).
   *
   * iOS Safari offers no native route into xterm (no Cmd-V; the long-press
   * Paste callout cannot target xterm's hidden textarea), so TC ships its
   * own affordance with two paths: read the clipboard directly when the
   * Clipboard API is usable, else surface a real textarea the native Paste
   * callout CAN service. `navigator.clipboard` only exists in a secure
   * context (#427 precedent: the copy path), so the plain-HTTP-over-
   * Tailscale setup takes the catcher by design, not as an error.
   * @param {{hasClipboardRead: boolean, secure: boolean}} env -
   *   `hasClipboardRead` = navigator.clipboard.readText is callable;
   *   `secure` = window.isSecureContext
   * @returns {'clipboard'|'catcher'}
   */
  function tcPastePath(env) {
    return (env.hasClipboardRead && env.secure) ? 'clipboard' : 'catcher';
  }

  /**
   * Classify whether a completed touch gesture was a clean TAP that should
   * focus the terminal (#574 RC4, pure).
   *
   * On a touch-only device every mouse event is one Safari synthesizes
   * right after a touch, so the #445 ghost-mouse suppression (which
   * swallows all mouse events within 1s of touch activity to protect the
   * copy path) also swallows the synthesized mousedown that used to give
   * xterm's hidden textarea focus — the soft keyboard could never appear.
   * Invisible on hybrid devices, where a real mouse works 1s after the
   * last touch. The fix is a deliberate `term.focus()` on a clean tap's
   * touchend (inside the gesture, so iOS honors it); this predicate is the
   * "clean tap" decision, lifted out so it executes under test (TST-6L2P).
   *
   * @param {{multiTouch: boolean, wasPill: boolean, selectActivated: boolean,
   *   movedPastSlop: boolean}} g - Gesture history: a second finger ever
   *   landed; the touch started on the Copy pill (its tap must stay a
   *   click); long-press select mode activated; the finger moved past the
   *   long-press slop (a scroll, not a tap)
   * @returns {boolean} true when the gesture is a clean tap
   */
  function tcIsFocusTap(g) {
    return !g.multiTouch && !g.wasPill && !g.selectActivated && !g.movedPastSlop;
  }

  /**
   * Wire one-finger touch scrolling for a ttyd terminal iframe (#443).
   *
   * The previous per-page shims listened on `.xterm-viewport` — but xterm's
   * screen layer (`.xterm-screen`, later in DOM order, positioned) paints
   * ABOVE the viewport, so touches never reached those listeners. And the
   * listeners were passive, so even when they fired iOS's native pan kept
   * gesture ownership and scrolled the OUTER page instead (the landing
   * page's `.main-scroll` under the Master pane; rubber-band on the session
   * page). Net effect: terminal touch-scroll was dead on iOS on both
   * surfaces.
   *
   * Fix: listen on the element touches actually hit (`.xterm-screen`,
   * falling back to the `.xterm` container, then `body`), make touchmove
   * NON-passive and `preventDefault()` it so the page pan never claims the
   * gesture, and inject `touch-action: none` on the terminal layers as
   * belt-and-braces. Scrolling translates the drag into synthetic WHEEL
   * events dispatched at the terminal — the exact pipeline desktop scrolling
   * uses, so it inherits xterm's own mode handling: with tmux `mouse on`
   * (always, per deploy/tmux.conf) xterm reports the wheel to tmux, which
   * scrolls its server-side history via copy-mode; with mouse tracking off
   * xterm scrolls its local scrollback. The first on-device iteration used
   * `term.scrollLines()` (xterm's local buffer only) and moved nothing —
   * the wheel path is the one proven daily on desktop. Two-finger gestures
   * are left to the browser (the single-touch guard runs before
   * preventDefault, so pinch-zoom is unaffected).
   *
   * Idempotent per iframe document (each reload is a fresh document).
   *
   * @param {Window} win - The PARENT window (feature-detects touch support).
   * @param {object} term - The xterm.js Terminal instance inside the iframe.
   * @param {Document} doc - The terminal iframe's document (same-origin).
   * @returns {boolean} true when wired (or already wired), false when
   *   skipped (no touch support, missing args, or no terminal DOM yet).
   */
  function tcWireTerminalTouchScroll(win, term, doc) {
    if (!win || !('ontouchstart' in win)) return false; // desktop doesn't need this
    if (!term || !doc) return false;
    if (doc.tcTouchScrollWired) return true;

    const target = doc.querySelector('.xterm-screen')
      || doc.querySelector('.xterm')
      || doc.body;
    if (!target) return false;
    doc.tcTouchScrollWired = true;

    // Stop iOS granting the gesture to native pan/zoom on any terminal layer.
    const style = doc.createElement('style');
    style.textContent = '.xterm, .xterm-screen, .xterm-viewport { touch-action: none; }';
    doc.head.appendChild(style);

    let lastTouchY = 0;
    let scrollAccum = 0;
    const LINE_HEIGHT = 18; // approximate xterm line height in px

    target.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      lastTouchY = e.touches[0].clientY;
      scrollAccum = 0;
    }, { passive: true });

    // NON-passive: preventDefault() keeps the browser's native pan from
    // scrolling the outer page while the finger is on the terminal (#443).
    target.addEventListener('touchmove', (e) => {
      if (doc.tcTouchSelectActive) return; // select mode owns the finger (#445)
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const deltaY = lastTouchY - touch.clientY; // positive = scroll down
      lastTouchY = touch.clientY;

      // Emit synthetic wheel events in line-sized batches. Constructed in
      // the IFRAME's realm and dispatched at the touch target so they bubble
      // into xterm's own 'wheel' listener exactly like a desktop wheel.
      // Quantization math is the pure tcQuantizeScrollDelta (UI-9J3F).
      const quantized = tcQuantizeScrollDelta(scrollAccum, deltaY, LINE_HEIGHT);
      scrollAccum = quantized.remainder;
      const linesToScroll = quantized.lines;
      if (linesToScroll !== 0) {
        const iframeWin = doc.defaultView || win;
        const wheel = new iframeWin.WheelEvent('wheel', {
          deltaY: linesToScroll * LINE_HEIGHT,
          deltaMode: 0, // pixels, like a trackpad
          bubbles: true,
          cancelable: true,
          clientX: touch.clientX,
          clientY: touch.clientY
        });
        (e.target || target).dispatchEvent(wheel);
      }
    }, { passive: false });
    return true;
  }

  /**
   * Make a PLAIN drag copy terminal text to the CLIENT clipboard (#445) —
   * and give touch devices a selection gesture (long-press) for the first
   * time.
   *
   * TC operators are mostly remote: a drag-selection must land on the
   * clipboard of the device the browser runs on, not the host. #432 built
   * that transport (modifier+drag forces a LOCAL xterm selection → ttyd
   * copy-on-select ✂ → client clipboard, plus the mouseup re-copy), but the
   * modifier is undiscoverable and touch devices have no modifier at all.
   *
   * This helper funnels the natural gestures into that same verified path:
   *
   * - DESKTOP: a capture-phase rewriter intercepts plain button-0 drags
   *   while the terminal app owns the mouse (`term.modes.mouseTrackingMode`
   *   !== 'none'), and re-dispatches them with BOTH force-selection
   *   modifiers set — xterm's own platform check picks the one it honors
   *   (`shouldForceSelection` is `altKey && macOptionClickForcesSelection`
   *   on Mac and `shiftKey` everywhere else; it classifies iOS as
   *   NOT-Mac). xterm then runs its own local-selection machinery, so
   *   highlight, ✂ copy-on-select, and the #431 mouseup re-copy all come
   *   free. Real modifier gestures pass through untouched; so does
   *   right-click (context-menu copy) and everything when the app is NOT
   *   tracking the mouse (plain drag already selects locally there).
   *   Trade-off (documented in #445): while tracking, plain clicks/drags no
   *   longer reach the TUI — selection wins. `altClickMovesCursor` is
   *   forced off so rewritten clicks can't become arrow-key spam, and a
   *   post-touch ghost-mouse window swallows iOS's synthesized mice.
   *
   * - TOUCH: long-press (450ms, <12px slop) enters select mode — the
   *   finger position maps to buffer cells and drives xterm's public
   *   `select(col, row, length)` API directly (NO synthetic mouse events:
   *   iOS's touch→mouse translation proved unreliable on-device).
   *   Releasing surfaces a native-iOS-style Copy pill; the pill's TAP —
   *   a real click in THIS document — performs the clipboard write, since
   *   Safari refused every touchend-time write and scopes gesture
   *   permission to the touched frame. The touch-scroll shim (#443)
   *   yields while select mode is active (`doc.tcTouchSelectActive`).
   *
   * Synthetic mouse events (desktop rewriter only) are tagged
   * (`tcSynthetic`) and skipped by the rewriter, so they can't loop.
   * Idempotent per iframe document.
   *
   * @param {Window} win - The PARENT window (platform + touch detection).
   * @param {object} term - The xterm.js Terminal instance inside the iframe.
   * @param {Document} doc - The terminal iframe's document (same-origin).
   * @returns {boolean} true when wired (or already wired), false when skipped.
   */
  function tcWireTerminalDragCopy(win, term, doc) {
    if (!win || !term || !doc) return false;
    if (doc.tcDragCopyWired) return true;
    doc.tcDragCopyWired = true;

    // Rewritten clicks carry the modifier — without this, xterm's default
    // altClickMovesCursor=true would turn every plain click into a burst of
    // synthetic arrow keys aimed at the TUI.
    if (term.options) term.options.altClickMovesCursor = false;

    const iframeWin = doc.defaultView || win;

    // Stop iOS's long-press callout/magnifier from fighting select mode.
    const style = doc.createElement('style');
    style.textContent = '.xterm, .xterm-screen { -webkit-touch-callout: none; }';
    doc.head.appendChild(style);

    /**
     * Clone a mouse event with both force-selection modifiers applied
     * (desktop rewriter only — the touch path never synthesizes mice).
     * @param {string} type - Mouse event type to create.
     * @param {MouseEvent} src - Source event.
     * @param {number} [detail] - Click count (clones carry theirs).
     * @returns {MouseEvent}
     */
    function forcedMouseEvent(type, src, detail) {
      const evt = new iframeWin.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: iframeWin,
        detail: detail !== undefined ? detail : (src.detail || 0),
        screenX: src.screenX,
        screenY: src.screenY,
        clientX: src.clientX,
        clientY: src.clientY,
        ctrlKey: !!src.ctrlKey,
        metaKey: !!src.metaKey,
        // BOTH force-selection modifiers, and xterm's own platform check
        // picks the one it honors: its shouldForceSelection wants altKey on
        // a Mac (with macOptionClickForcesSelection armed) and shiftKey
        // everywhere else — and it classifies iOS as NOT-Mac, which is why
        // an alt-only synthetic did nothing on iPhone (found on-device).
        altKey: true,
        shiftKey: true,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1
      });
      evt.tcSynthetic = true;
      return evt;
    }

    // ── Desktop: capture-phase plain-drag rewriter ──

    let rewriting = false;
    // Ghost-mouse suppression (#445 iteration 5): after a touch sequence,
    // iOS synthesizes mouse events at the lift point. Left alone they fell
    // into the rewriter, force-selected ONE cell where the finger lifted,
    // and copy-on-select overwrote the just-copied drag selection with that
    // single character. Any touch activity opens a window during which real
    // mouse events are swallowed outright. Real mice (no touch) never set
    // the timestamp; a hybrid device's mouse works again 1s after touching.
    const GHOST_MOUSE_MS = 1000;
    let lastTouchTs = 0;

    /**
     * Rewrite eligibility for a REAL mousedown: plain left button while the
     * terminal app owns the mouse. Modifier-carrying gestures and non-left
     * buttons pass through; when the app is not tracking, plain drags
     * already produce a local selection natively.
     * @param {MouseEvent} e
     * @returns {boolean}
     */
    function shouldRewrite(e) {
      if (e.button !== 0 || e.altKey || e.shiftKey) return false;
      try {
        const mode = term.modes && term.modes.mouseTrackingMode;
        return mode !== undefined && mode !== 'none';
      } catch (_) {
        return false;
      }
    }

    /**
     * Capture-phase handler: swallow the real event and re-dispatch it with
     * the force-selection modifier for the duration of one button-0 drag.
     * @param {MouseEvent} e
     */
    function rewrite(e) {
      if (e.tcSynthetic) return;
      if (lastTouchTs && Date.now() - lastTouchTs < GHOST_MOUSE_MS) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.type === 'mousedown') {
        if (!shouldRewrite(e)) return;
        rewriting = true;
      } else {
        if (!rewriting) return;
        if (e.type === 'mouseup') rewriting = false;
        // Stuck-drag guard: if the button was released OUTSIDE this iframe
        // document, no mouseup ever arrives here — the next real hover move
        // reports buttons===0. Disarm and pass it through instead of
        // extending a phantom selection.
        if (e.type === 'mousemove' && e.buttons === 0) {
          rewriting = false;
          return;
        }
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      e.target.dispatchEvent(forcedMouseEvent(e.type, e));
    }

    doc.addEventListener('mousedown', rewrite, { capture: true });
    doc.addEventListener('mousemove', rewrite, { capture: true });
    doc.addEventListener('mouseup', rewrite, { capture: true });

    // ── Touch: long-press enters select mode (direct xterm selection) ──
    //
    // Touch does NOT go through synthetic mouse events: iOS Safari's
    // touch→mouse translation proved unreliable on-device (2 iterations —
    // events dropped or re-routed to the app). Instead the finger position
    // maps straight to buffer cells and drives xterm's public
    // `select(col, row, length)` API — deterministic, no modifier
    // semantics, and the highlight itself is the feedback.

    const LONG_PRESS_MS = 450;
    const SLOP_PX = 12;
    let pressTimer = null;
    let pressPoint = null;
    let selectAnchor = null;
    let lastPoint = null;
    let pendingCopyText = '';

    // Tap-to-focus gesture history (#574 RC4) — reset on each fresh
    // single-finger touchstart, classified by tcIsFocusTap at touchend.
    let gestureMultiTouch = false;
    let gestureWasPill = false;
    let gestureSelectActivated = false;
    let gestureMovedPastSlop = false;

    // The copy itself happens from a TAP on a visible Copy pill — the same
    // click-in-same-document flow as the #435-proven upload copy buttons.
    // Copying directly in touchend never satisfied Safari's gesture rules
    // on-device (iterations 4-6), and a pill matches native iOS selection
    // UX anyway. State-driven show/hide only — no timers (#98/#268).
    const pill = doc.createElement('button');
    pill.textContent = 'Copy';
    pill.setAttribute('style',
      'display:none;position:fixed;z-index:2147483647;min-width:64px;' +
      'min-height:44px;padding:10px 18px;border:none;border-radius:22px;' +
      'background:#2e7d32;color:#fff;font:600 16px -apple-system,sans-serif;' +
      'box-shadow:0 2px 10px rgba(0,0,0,0.5);');
    doc.body.appendChild(pill);

    /** Hide the Copy pill and forget the pending text. */
    function hidePill() {
      pill.style.display = 'none';
      pendingCopyText = '';
    }

    /**
     * Show the Copy pill near a viewport point (clamped on-screen, offset
     * above the finger so it isn't covered).
     * @param {{clientX: number, clientY: number}} pt
     */
    function showPill(pt) {
      const vw = doc.documentElement.clientWidth || 320;
      const left = Math.max(8, Math.min(vw - 88, pt.clientX - 40));
      const top = Math.max(8, pt.clientY - 64);
      pill.style.left = left + 'px';
      pill.style.top = top + 'px';
      pill.style.display = 'block';
    }

    pill.addEventListener('click', () => {
      const text = pendingCopyText || term.getSelection();
      if (text) tcCopyToClipboard(text, doc);
      hidePill();
    });

    /**
     * Map a touch point to xterm BUFFER coordinates (viewport-adjusted).
     * @param {Touch} t - A Touch point (clientX/clientY).
     * @returns {{col: number, row: number}|null} null when the terminal DOM
     *   or geometry is unavailable.
     */
    function cellFromTouch(t) {
      const screen = doc.querySelector('.xterm-screen');
      if (!screen || !term.cols || !term.rows) return null;
      const rect = screen.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const viewportY = (term.buffer && term.buffer.active) ? term.buffer.active.viewportY : 0;
      // Clamp + viewport mapping is the pure tcCellFromPoint (UI-9J3F).
      return tcCellFromPoint(t, rect, term.cols, term.rows, viewportY);
    }

    /**
     * Select from anchor to the current cell (either direction).
     * @param {{col: number, row: number}} from
     * @param {{col: number, row: number}} to
     */
    function applySelection(from, to) {
      // Anchor swap + length math is the pure tcSelectionSpan (UI-9J3F).
      const span = tcSelectionSpan(from, to, term.cols);
      try {
        term.select(span.col, span.row, span.length);
      } catch (_) { /* geometry raced a resize — next move re-selects */ }
    }

    /** Cancel a pending long-press timer. */
    function cancelPress() {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      pressPoint = null;
    }

    doc.addEventListener('touchstart', (e) => {
      lastTouchTs = Date.now();
      if (e.touches.length === 1) {
        // Fresh gesture — reset the tap classification (#574 RC4)
        gestureMultiTouch = false;
        gestureWasPill = e.target === pill;
        gestureSelectActivated = false;
        gestureMovedPastSlop = false;
      } else {
        gestureMultiTouch = true;
      }
      if (e.target === pill) return; // the pill's own tap must stay a click
      hidePill(); // any new terminal touch dismisses a pending pill
      if (e.touches.length !== 1) {
        cancelPress();
        return;
      }
      const t = e.touches[0];
      pressPoint = { clientX: t.clientX, clientY: t.clientY };
      // Fresh gesture — drop the previous gesture's pill anchor so a
      // no-drag long-press can't surface a stale-positioned pill.
      lastPoint = null;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (!pressPoint) return;
        const cell = cellFromTouch(pressPoint);
        if (!cell) return;
        // Enter select mode: anchor + a one-cell selection as the visual cue.
        // gestureSelectActivated deliberately shadows tcTouchSelectActive for
        // the tap classifier: endSelect clears the live flag BEFORE touchend
        // classifies the gesture, so only this sticky copy can veto the focus.
        doc.tcTouchSelectActive = true;
        gestureSelectActivated = true;
        selectAnchor = cell;
        lastPoint = pressPoint; // pill anchor even if the finger never moves
        applySelection(cell, cell);
      }, LONG_PRESS_MS);
    }, { passive: true });

    // NON-passive: in select mode the finger drives the selection, so the
    // terminal/page must not also scroll.
    doc.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (doc.tcTouchSelectActive && selectAnchor) {
        e.preventDefault();
        lastPoint = { clientX: t.clientX, clientY: t.clientY };
        const cell = cellFromTouch(t);
        if (cell) applySelection(selectAnchor, cell);
        return;
      }
      // Still waiting on the long-press: real movement means a scroll intent.
      if (pressPoint &&
          (Math.abs(t.clientX - pressPoint.clientX) > SLOP_PX ||
           Math.abs(t.clientY - pressPoint.clientY) > SLOP_PX)) {
        gestureMovedPastSlop = true; // a scroll, not a tap (#574 RC4)
        cancelPress();
      }
    }, { passive: false });

    const endSelect = () => {
      lastTouchTs = Date.now();
      cancelPress();
      if (!doc.tcTouchSelectActive) return;
      doc.tcTouchSelectActive = false;
      selectAnchor = null;
      // No direct clipboard write here — Safari's gesture rules refused
      // every touchend-time attempt on-device (iterations 4-6). Instead,
      // stage the text and surface the Copy pill; its tap is a real click
      // in this same document, the one flow Safari always honors (#435).
      try {
        pendingCopyText = term.getSelection() || '';
      } catch (_) {
        pendingCopyText = '';
      }
      if (pendingCopyText && lastPoint) {
        showPill(lastPoint);
      }
    };
    doc.addEventListener('touchend', () => {
      endSelect();
      // Tap-to-focus (#574 RC4): the ghost-mouse suppression above swallows
      // the synthesized mousedown that used to focus xterm's textarea, so a
      // clean tap must focus it deliberately — here, inside the touchend
      // gesture window, where iOS raises the soft keyboard. touchcancel
      // never focuses (the system took the gesture back).
      if (tcIsFocusTap({
        multiTouch: gestureMultiTouch,
        wasPill: gestureWasPill,
        selectActivated: gestureSelectActivated,
        movedPastSlop: gestureMovedPastSlop
      })) {
        try {
          term.focus();
        } catch (err) {
          // Terminal disposed mid-gesture — nothing to focus. Logged so a
          // remote Web Inspector can tell a throw from a predicate rejection.
          if (iframeWin.console) iframeWin.console.debug('tc tap-to-focus skipped:', err);
        }
      }
    }, { passive: true });
    doc.addEventListener('touchcancel', endSelect, { passive: true });

    return true;
  }

  /**
   * Wire a ttyd terminal iframe with the full TangleClaw terminal stack:
   * theme, the #431 ⌥+drag local-selection override, the #443 touch-scroll
   * shim, and the #445 plain-drag/long-press copy path. One readiness retry
   * loop shared by every terminal surface (session terminal, landing Master
   * pane, in-session Master drawer) — the per-page copies of this loop are
   * what let #443's dead shim ship twice.
   *
   * Registers a one-shot `load` listener that polls for the xterm instance
   * (ttyd initializes it asynchronously after iframe load — the old
   * load-time wiring raced xterm init, #443) and wires everything once
   * `term.options` exists. Call BEFORE setting `frame.src`. Cross-origin
   * frames (OpenClaw webui sessions) throw on `contentWindow` access — the
   * loop swallows that and gives up after its retry budget.
   *
   * @param {Window} win - The PARENT window (touch/platform detection + timers).
   * @param {HTMLIFrameElement} frame - The terminal iframe (same-origin ttyd).
   * @param {() => string} getTheme - Returns the operator theme key at wire
   *   time ('dark', 'light', 'high-contrast'); read lazily so config loaded
   *   after the call still wins.
   * @returns {boolean} true when the load listener was registered.
   */
  function tcWireTerminalFrame(win, frame, getTheme) {
    if (!win || !frame) return false;
    frame.addEventListener('load', () => {
      let attempts = 0;
      const tryApply = () => {
        try {
          const iframeWin = frame.contentWindow;
          const term = iframeWin && (iframeWin.term || iframeWin.terminal);
          if (term && term.options) {
            tcApplyTerminalTheme(term, getTheme ? getTheme() : 'dark');
            const doc = frame.contentDocument;
            tcEnableLocalSelectionOverride(term, doc);
            if (doc) {
              tcWireTerminalTouchScroll(win, term, doc);
              tcWireTerminalDragCopy(win, term, doc);
            }
            return;
          }
        } catch (_) { /* not ready or cross-origin (webui) — retry below */ }
        if (++attempts < 20) win.setTimeout(tryApply, 250);
      };
      tryApply();
    }, { once: true });
    return true;
  }

  /**
   * Create the restart plumbing a page needs to put the server through a
   * restart and come back onto it.
   *
   * Lives here, not beside either caller, because it has two of them that are
   * not on the same page: the dashboard's stale-server restart (#235) and the
   * update beacon's apply-and-restart (#229), which the session page also runs
   * since #931 put one beacon on both surfaces. A copy per caller is how the
   * update pill and the session badge drifted apart before #931 replaced
   * them with one beacon.
   *
   * @param {object} deps
   * @param {Function} deps.api - The page's `api()` from `tcCreateApi`.
   * @param {Function} deps.apiMutate - The page's `apiMutate()`.
   * @param {Window} deps.win - The window, for its dialogs, timers and
   *   `location`. Injected so the flow runs under test without a browser.
   * @returns {{postServerRestart: Function, pollServerBackAndReload: Function}}
   */
  function tcCreateRestartFlow(deps) {
    const api = deps.api;
    const apiMutate = deps.apiMutate;
    const win = deps.win;

    /**
     * POST the restart, honoring the wrap-in-progress guard (#602). A wrap
     * holds state in the server process, so restarting mid-wrap kills it and
     * orphans its AI content steps (the 2026-07-16 incident). On that
     * refusal, ask the operator explicitly and retry with `{force:true}` only
     * on a yes.
     *
     * @returns {Promise<object|null>} The restart response, or null when the
     *   POST failed / the operator declined to force.
     */
    async function postServerRestart() {
      let resp = await apiMutate('/api/server/restart', 'POST', {});
      if (!resp && api.lastErrorCode === 'WRAP_RESTART_BLOCKED') {
        const proceed = win.confirm(
          `${api.lastError}\n\nForce the restart anyway? The running wrap will be killed mid-pipeline.`
        );
        if (!proceed) return null;
        resp = await apiMutate('/api/server/restart', 'POST', { force: true });
      }
      return resp;
    }

    /**
     * Poll `/api/server-info` until the process reports a `startedAt`
     * different from `oldStartedAt` (the new process is up), then full-reload
     * so the browser picks up any fresh static assets.
     *
     * **No timer-driven blind reload** (the no-UI-timers rule, #98/#268):
     * without a baseline `startedAt` we cannot detect when the new process is
     * actually up, so we abort honestly — let the operator refresh — rather
     * than reload onto a possibly-dead server. The reload that does happen
     * fires on an OBSERVED state change, never on elapsed time alone.
     *
     * 30 polls at 500ms = 15s of patience; the restart itself typically takes
     * ~3s. Each poll tolerates a failed fetch (the in-between window when the
     * old process is dead but the new one hasn't bound the port yet).
     *
     * @param {string|null} oldStartedAt - Pre-restart `startedAt` baseline.
     * @param {() => void} restore - Clears the caller's in-flight latch and
     *   restores its button on any give-up path.
     * @returns {void}
     */
    function pollServerBackAndReload(oldStartedAt, restore) {
      if (!oldStartedAt) {
        restore();
        win.alert('Could not read server state to confirm the restart. The server may still be coming back — refresh the page in a moment to check.');
        return;
      }
      const POLL_INTERVAL_MS = 500;
      const POLL_MAX_ATTEMPTS = 30;
      let attempt = 0;
      const poll = win.setInterval(async () => {
        attempt++;
        try {
          const info = await api('/api/server-info');
          if (info && info.startedAt && info.startedAt !== oldStartedAt) {
            win.clearInterval(poll);
            win.location.reload();
            return;
          }
        } catch { /* expected during the dead window */ }
        if (attempt >= POLL_MAX_ATTEMPTS) {
          win.clearInterval(poll);
          restore();
          win.alert('Restart did not complete within 15 seconds. The server may still be coming back — refresh in a moment.');
        }
      }, POLL_INTERVAL_MS);
    }

    return { postServerRestart, pollServerBackAndReload };
  }

  global.tcCreateApi = tcCreateApi;
  global.tcCreateApiMutate = tcCreateApiMutate;
  global.tcCreateRestartFlow = tcCreateRestartFlow;
  global.tcCopyToClipboard = tcCopyToClipboard;
  global.tcCopyOutcome = tcCopyOutcome;
  global.tcClipboardWritePath = tcClipboardWritePath;
  global.TC_XTERM_THEMES = TC_XTERM_THEMES;
  global.tcApplyTerminalTheme = tcApplyTerminalTheme;
  global.tcQuantizeScrollDelta = tcQuantizeScrollDelta;
  global.tcCellFromPoint = tcCellFromPoint;
  global.tcSelectionSpan = tcSelectionSpan;
  global.tcParseBridgePort = tcParseBridgePort;
  global.tcSelectModeMouse = tcSelectModeMouse;
  global.tcParseSelectMarker = tcParseSelectMarker;
  global.tcPastePath = tcPastePath;
  global.tcIsFocusTap = tcIsFocusTap;
  /**
   * Build <option> HTML for an engine dropdown — the ONE implementation.
   *
   * Lived as separate near-copies in `ui.js` and `session.js`, plus hand-rolled
   * variants in the Master settings body and the setup wizard. #707 gated some
   * of them; the `session.js` copy was missed precisely because it was a copy,
   * and it is on the operator's primary surface — two taps there bound a project
   * to an engine the machine does not have. api-helper is loaded by both
   * `index.html` and `session.html`, so this is the only place both can share.
   *
   * `esc` is a parameter because each page defines its own; passing it keeps
   * this file free of a DOM/page dependency.
   *
   * @param {object[]} engineList - Engines carrying `available`
   * @param {string} selectedId - Currently selected engine id
   * @param {function} esc - The page's HTML escaper
   * @returns {string} <option> markup
   */
  function tcBuildEngineOptions(engineList, selectedId, esc) {
    const list = Array.isArray(engineList) ? engineList : [];
    let html = list.map((e) => {
      // Uninstalled engines stay listed — someone who installs one later should
      // not have to hunt for it — but are not selectable. The engine currently
      // in use is exempt: disabling it would make the control display a value
      // it refuses to keep.
      const unavailable = e.available === false && e.id !== selectedId;
      // `typeof` rather than `||`: a truthy non-string passes `||` and is then
      // dropped by `esc`, leaving a blank, unidentifiable option. Only `id` is
      // validated when a profile is saved.
      const label = typeof e.name === 'string' && e.name ? e.name : e.id;
      return `<option value="${esc(e.id)}" ${e.id === selectedId ? 'selected' : ''}`
        + `${unavailable ? ' disabled' : ''}>`
        + `${esc(label)}${e.available === false ? ' (not installed)' : ''}</option>`;
    }).join('');

    if (selectedId && !list.some((e) => e.id === selectedId)) {
      html += `<option value="${esc(selectedId)}" selected>${esc(selectedId)} (unavailable)</option>`;
    }
    return html;
  }

  /**
   * The engine a picker should open on: the configured one when installed,
   * else the first installed by sorted id, else ''.
   *
   * Sorted for the same reason `engines.resolveDefaultEngine` sorts — the list
   * arrives in engine-profile directory order and this value gets POSTed and
   * persisted onto a project, so an unsorted pick binds projects to a
   * filesystem-dependent engine.
   *
   * @param {object[]} engineList - Engines carrying `available`
   * @param {string} configured - `config.defaultEngine`
   * @returns {string}
   */
  function tcResolvePickerEngine(engineList, configured) {
    const list = Array.isArray(engineList) ? engineList : [];
    const available = list.filter((e) => e && e.available);
    if (configured && available.some((e) => e.id === configured)) return configured;
    return available.map((e) => e.id).sort()[0] || '';
  }

  // ── Degraded reads: one internal shape for every "we could not establish it" ──
  //
  // The projects payload carries SIX representations of a read that did not
  // answer, each shaped for its own question: `session.active: null` with
  // `incomplete`/`cause`, `git.dirty: null` with `incomplete`/`cause`, a
  // project's `unreadable`/`unreadableHint`/`unreadableCode` trio, and the
  // list-level `scan` block. They differ in the payload because they answer
  // different questions, and flattening them there would lose that.
  //
  // Here the job is the opposite. Everything below reduces to ONE record —
  // `{known, why, remedy}` — so the dashboard speaks about a wedged tmux server
  // and an unreadable folder in the same voice, and a seventh source added later
  // joins in one place instead of growing a seventh render path.
  //
  // TWO RETURN CONVENTIONS, deliberately. `tcSessionRead` and `tcGitRead` always
  // return a record, because their caller is already rendering that thing and
  // only needs to know whether to qualify it. `tcScanNotice` and
  // `tcUnreadableNotice` return NULL when nothing is wrong, because their caller
  // renders nothing at all in that case — a notice row and a badge that do not
  // exist. Hence `if (!read.known)` at two render sites and `if (notice)` at the
  // other two. Sources that extend the record spread it rather than re-listing
  // its fields, so a field added here reaches all four.

  /**
   * Build the one internal degraded-read record.
   *
   * A constructor rather than an object literal at each site, so the shape
   * cannot drift between the four sources that produce it.
   *
   * @param {boolean} known - Whether the read established its answer.
   * @param {string|null} [why] - One sentence for a human, or null when known.
   * @param {string|null} [remedy] - What the operator can do, where anything
   *   honest can be said. Null is a legitimate answer: a truncated walk has no
   *   remedy because nothing is wrong.
   * @returns {{known: boolean, why: string|null, remedy: string|null}}
   */
  function tcDegradedRead(known, why, remedy) {
    return { known: !!known, why: why || null, remedy: remedy || null };
  }

  // Prose for the causes the SERVER does not already write a sentence for.
  // `scan` and the per-project trio arrive with their own `reason`/`hint`
  // authored at the failure site, which is more specific than anything a
  // renderer could infer — those are used verbatim. Only session liveness and
  // git carry a bare `cause` token, so only those are translated here.
  // Null-prototype, here and in the three tables below: every one of them is
  // keyed by a value that arrives in a JSON payload, and a plain object would
  // answer `constructor` or `toString` with an inherited member — which then
  // gets interpolated into a sentence an operator reads.
  const TC_CAUSE_TEXT = Object.assign(Object.create(null), {
    'read-timed-out': 'the read was stopped by TangleClaw after it stopped responding',
    'git-refused-to-read-repository': 'git refused to read this repository',
    'git-status-unparsed': 'git answered in a form TangleClaw could not read'
  });

  /**
   * Turn a bare `cause` token into a sentence.
   *
   * Unknown tokens degrade to a generic sentence rather than being echoed raw:
   * a token is an internal vocabulary item and reads as a defect when it
   * reaches an operator. Returning null instead would be worse — it would drop
   * the only signal that anything went short.
   *
   * @param {string|null} cause - `session.cause` or `git.cause`.
   * @returns {string} A sentence, never empty.
   */
  function tcCauseText(cause) {
    return TC_CAUSE_TEXT[cause] || 'the read did not complete';
  }

  // What each unestablished git field is, in words. `incomplete` carries the
  // payload's own field names — `dirty`, `latestTag` — and printing those at an
  // operator is the same defect as printing a cause token: it reads as a leak,
  // and "dirty" in particular means nothing to someone who did not write it.
  // Every name `lib/git.js` can push is covered here.
  const TC_GIT_FIELD_TEXT = Object.assign(Object.create(null), {
    dirty: 'whether there are uncommitted changes',
    branch: 'the current branch',
    lastCommit: 'the last commit',
    lastCommitAge: 'how long ago the last commit was',
    latestTag: 'the latest tag'
  });

  /**
   * Name the unestablished git fields in words, as a readable list.
   *
   * An unrecognised field falls back to its raw name rather than being dropped:
   * a field TangleClaw could not read must still be reported, and a new name
   * appearing here is a prompt to add it above, not a reason to say nothing.
   *
   * @param {string[]} fields - `git.incomplete`.
   * @returns {string} e.g. "whether there are uncommitted changes and the latest tag".
   */
  function tcGitFieldText(fields) {
    const words = fields.map((f) => TC_GIT_FIELD_TEXT[f] || f);
    if (words.length <= 1) return words[0] || 'part of this repository';
    return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  }

  /**
   * Capitalise a sentence for display.
   *
   * The server authors its hints to follow a label in a log line, so they begin
   * lower-case. Rendered as a standalone remedy — the one sentence a stranded
   * operator reads — that looks like a truncated message. Only the first letter
   * is touched; the wording is the server's and stays exactly as written.
   *
   * @param {string|null} text - Sentence to present.
   * @returns {string|null} The same text, first letter capitalised.
   */
  function tcSentence(text) {
    if (!text) return null;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /**
   * Classify a project's session liveness.
   *
   * Three outcomes where the card used to draw two. `active === null` is the
   * unknown — it mirrors `git.dirty: null`, and it is falsy so every consumer
   * that has not learned about this state behaves exactly as before.
   *
   * An ABSENT session row is `'none'`, not `'unknown'`: nothing was read and
   * nothing failed, the project simply has no session. Collapsing that into
   * unknown would mark every idle project on the dashboard as degraded.
   *
   * @param {object|null} project - An enriched project from `GET /api/projects`.
   * @returns {'live'|'none'|'unknown'}
   */
  function tcSessionLiveness(project) {
    const session = project && project.session;
    if (!session) return 'none';
    if (session.active === true) return 'live';
    if (session.active === null) return 'unknown';
    return 'none';
  }

  /**
   * The degraded-read record for a project's session liveness.
   *
   * The remedy is specific to tmux and is NOT taken from any shared table: a
   * `read-timed-out` here means the tmux server stopped answering (the PTY
   * exhaustion this dashboard has hit repeatedly), which has nothing to do with
   * the filesystem permission that the same token means for a directory scan.
   * One vocabulary of causes, deliberately not one vocabulary of remedies.
   *
   * @param {object|null} project - An enriched project.
   * @returns {{known: boolean, why: string|null, remedy: string|null}}
   */
  function tcSessionRead(project) {
    if (tcSessionLiveness(project) !== 'unknown') return tcDegradedRead(true);
    const session = project.session;
    return tcDegradedRead(
      false,
      `Whether this session is still running could not be established — ${tcCauseText(session.cause)}.`,
      'The tmux server is not answering. Once it responds this clears on its own; '
        + '`tmux kill-server` clears a wedged one, ending every session on this machine.'
    );
  }

  /**
   * The degraded-read record for the Project Master's liveness.
   *
   * A fifth source rather than a fifth render path, which is the whole point of
   * this module: the master row and a project card meet the SAME wedge, and
   * before this the card named a cause and a remedy while the master row two
   * elements away named neither.
   *
   * The remedy is tmux's, so it is the same sentence `tcSessionRead` supplies
   * and for the same reason — one vocabulary of causes, deliberately not one
   * vocabulary of remedies. It is repeated rather than hoisted because the two
   * are only equal today by coincidence of both being tmux; a master that moved
   * behind a different transport would need its own, and a shared constant
   * would make that a refactor instead of an edit.
   *
   * @param {object|null} status - `GET /api/master/status`, or null if it failed.
   * @returns {{known: boolean, why: string|null, remedy: string|null}}
   */
  function tcMasterRead(status) {
    if (!status || status.exists !== null) return tcDegradedRead(true);
    return tcDegradedRead(
      false,
      `Whether the Project Master is running could not be established — ${tcCauseText(status.cause)}.`,
      'The tmux server is not answering. Once it responds this clears on its own; '
        + '`tmux kill-server` clears a wedged one, ending every session on this machine.'
    );
  }

  /**
   * Classify a repository's dirty state.
   *
   * Returns null when there is no repository at all, so a plain directory never
   * renders as an unknown. (The build plan named three values; the null is a
   * deliberate addition — without it every non-repo card would grow a `?`.)
   *
   * @param {object|null} git - `project.git`, or null when not a repository.
   * @returns {'clean'|'dirty'|'unknown'|null}
   */
  function tcGitDirtyState(git) {
    if (!git) return null;
    if (git.dirty === null || git.dirty === undefined) return 'unknown';
    return git.dirty ? 'dirty' : 'clean';
  }

  /**
   * The degraded-read record for a repository reading.
   *
   * Reports unknown when the read went short in ANY field, not only `dirty` —
   * `incomplete` is the authoritative list and a branch or tag that could not be
   * read is just as unestablished as a working-tree state.
   *
   * @param {object|null} git - `project.git`.
   * @returns {{known: boolean, why: string|null, remedy: string|null}}
   */
  function tcGitRead(git) {
    const incomplete = (git && Array.isArray(git.incomplete)) ? git.incomplete : [];
    if (!git || incomplete.length === 0) return tcDegradedRead(true);
    return tcDegradedRead(
      false,
      `Could not establish ${tcGitFieldText(incomplete)} — ${tcCauseText(git.cause)}.`,
      git.cause === 'read-timed-out'
        ? 'A large or slow repository can exceed the time TangleClaw allows one reading. '
          + 'It retries on the next poll.'
        : null
    );
  }

  // What a renderer can honestly advise when the server supplied no hint.
  // Deliberately sparse. The server attaches the Full Disk Access remedy only to
  // the failure shape it fits, and inventing one for the rest would reintroduce
  // exactly the misdiagnosis this whole area exists to remove — telling someone
  // to change a permission for a directory that answered perfectly well.
  const TC_CODE_REMEDY = Object.assign(Object.create(null), {
    DIR_MISSING: 'Create the directory, or point TangleClaw at a different one in Settings.',
    // The directory is there and this server may not read it. It is the one
    // failure whose cause IS known and whose remedy is concrete, so leaving it
    // without advice — while the vaguer catch-all below gets some — was exactly
    // backwards. `lib/dir-scanner-child.js` reports it for a project's own
    // directory and attaches no hint of its own.
    EACCES: 'TangleClaw is not allowed to read this folder. Check its permissions, or grant '
      + 'node Full Disk Access if it sits under ~/Documents, ~/Desktop or ~/Downloads.',
    // The catch-all: ENOTDIR, EIO and anything else. Names no specific cause,
    // because asserting one here would be a guess.
    SCAN_FAILED: 'Check that the directory still exists and that TangleClaw can read it.'
  });

  // Codes whose meaning includes "and nothing is retrying it right now". Kept
  // separate from the remedy above ON PURPOSE: a remembered refusal still earns
  // the Full Disk Access advice the server attached, because the condition it
  // describes is unchanged — the backoff is an additional fact, not a
  // replacement for the remedy, and deriving either from the other is the defect
  // three reviewers found independently.
  const TC_CODE_NOT_RETRYING = Object.assign(Object.create(null), {
    SCAN_CACHED: 'This is a remembered result — the directory is not being retried right now.'
  });

  /**
   * The notice the ROOT panel shows when the projects list is short.
   *
   * Returns null when the list is complete, so the caller renders nothing
   * without testing fields itself.
   *
   * `kind` separates the two opposite reasons a list can be short. A truncated
   * walk is `'info'`: the directory answered fine and is merely bigger than one
   * scan's budget, so drawing it as a fault — and especially attaching a
   * permissions remedy to it — is the misdiagnosis this work exists to remove.
   * Everything else is `'warn'`.
   *
   * @param {object|null} scan - The `scan` block from `GET /api/projects`.
   * @returns {{known: false, why: string, remedy: string|null, kind: 'warn'|'info',
   *   listed: number|null}|null} Null when the list is complete.
   */
  function tcScanNotice(scan) {
    if (!scan || scan.complete !== false) return null;
    const code = scan.code || null;
    const notRetrying = TC_CODE_NOT_RETRYING[code] || null;
    const why = [
      scan.reason || 'The projects directory could not be fully read, so this list may be short.',
      notRetrying
    ].filter(Boolean).join(' ');
    // Spread rather than re-listing the fields: a field added to the shared
    // record must reach this source too, and copying `known`/`why`/`remedy` by
    // hand is exactly how it would silently not.
    return {
      ...tcDegradedRead(false, why, tcSentence(scan.hint) || TC_CODE_REMEDY[code] || null),
      kind: code === 'SCAN_TRUNCATED' ? 'info' : 'warn',
      listed: Number.isFinite(scan.listed) ? scan.listed : null
    };
  }

  /**
   * The degraded-read record for a project whose own directory did not answer.
   *
   * Returns null for a readable project so the caller renders no badge.
   *
   * @param {object|null} project - An enriched project carrying the
   *   `unreadable` / `unreadableHint` / `unreadableCode` trio.
   * @returns {{known: false, why: string, remedy: string|null}|null}
   */
  function tcUnreadableNotice(project) {
    if (!project || !project.unreadable) return null;
    const code = project.unreadableCode || null;
    const notRetrying = TC_CODE_NOT_RETRYING[code] || null;
    const why = [
      `This project's folder could not be read — ${project.unreadable}.`,
      'Its git, engine and version detail are missing rather than absent.',
      notRetrying
    ].filter(Boolean).join(' ');
    return tcDegradedRead(false, why,
      tcSentence(project.unreadableHint) || TC_CODE_REMEDY[code] || null);
  }

  /**
   * The settings-warnings banner's markup — the ids and the classes together,
   * so a page hosting it cannot declare two of the three and lose the styling.
   *
   * The session page originally hand-copied this and reached for its nearest
   * neighbour, `.engine-error-banner`, which is danger-red with a red left
   * border — so a sentence whose entire point is that the save SUCCEEDED
   * rendered as an engine failure, and a second warning ran onto one line for
   * want of `pre-line`. Single-sourced for the same reason
   * `tcMedusaControlMarkup` is.
   *
   * @returns {string} The banner, hidden.
   */
  function tcSettingsWarningsMarkup() {
    return '<div id="settingsWarningsBanner" class="settings-warnings-banner hidden" role="alert">'
      + '<span class="settings-warnings-text" id="settingsWarningsText"></span>'
      + '<button type="button" class="settings-warnings-dismiss" id="settingsWarningsDismissBtn">Dismiss</button>'
      + '</div>';
  }

  /**
   * Show the warnings a SUCCESSFUL settings save came back with, or hide the
   * banner when there are none.
   *
   * Shared by the dashboard and the session page (#758). The session page needs
   * it because its own engine picker changes a launch-time-only setting from
   * inside a running session — the exact case the warning exists for — and it
   * used to discard the PATCH response entirely.
   *
   * No timer. Every warning here names something the operator must go and do
   * (edit a LaunchAgent, relaunch a session), so it stays until dismissed.
   *
   * @param {Document} doc - Owning document.
   * @param {string[]|undefined} warnings - `warnings` from PATCH /api/projects/:name.
   */
  function tcRenderSettingsWarnings(doc, warnings) {
    const banner = doc.getElementById('settingsWarningsBanner');
    const text = doc.getElementById('settingsWarningsText');
    if (!banner || !text) return;
    const list = Array.isArray(warnings)
      ? warnings.filter(w => typeof w === 'string' && w.length > 0)
      : [];
    if (list.length === 0) {
      text.textContent = '';
      banner.classList.add('hidden');
      return;
    }
    text.textContent = list.join('\n');
    banner.classList.remove('hidden');
    const dismiss = doc.getElementById('settingsWarningsDismissBtn');
    if (dismiss && !dismiss.dataset.wired) {
      dismiss.dataset.wired = '1';
      dismiss.addEventListener('click', () => tcRenderSettingsWarnings(doc, []));
    }
  }

  /**
   * The live session banner's chime control (#1181).
   *
   * The per-session chime used to be reachable only from inside the Session
   * Settings modal, so arming it before stepping away cost three interactions.
   * It lives here rather than in `session.js` for the reason the Medusa control
   * does: browser code in that file cannot be require()d, so its only available
   * test is a source pin, and a pin proves a branch exists rather than that it
   * runs.
   *
   * The indicator this replaces painted onto the Cmd button and only ever ADDED
   * its `active` class — so switching the chime off left the button lit until
   * reload, on a pixel that also meant "the command bar is open". Painting both
   * directions onto a control of its own is the fix, and `render` is the single
   * place that does it.
   *
   * Whether a chime is actually AUDIBLE is a separate question this control
   * does not answer: the install-wide mute is honoured inside `playChime`, so a
   * muted install shows an armed control that stays silent. That split is
   * deliberate — this toggle is the session's intent, not the speaker's state.
   *
   * @param {object} opts
   * @param {Document} opts.doc - Owning document.
   * @param {string} [opts.buttonId] - The control's element id.
   * @param {Function} opts.onToggle - Called with the NEXT enabled state when
   *   the operator clicks. The caller owns persistence; this component owns
   *   only what the control looks like.
   * @returns {{mount: Function, render: Function}}
   */
  function tcCreateChimeControl({ doc, buttonId = 'chimeBtn', onToggle }) {
    /**
     * Paint the control for a given state — both directions, always.
     * @param {boolean} enabled - Whether the session's chime is armed.
     */
    function render(enabled) {
      const btn = doc.getElementById(buttonId);
      if (!btn) return;
      const on = Boolean(enabled);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      // The label carries the state as well as the action, because `aria-pressed`
      // alone is announced inconsistently across the mobile screen readers this
      // banner is used from.
      btn.setAttribute('aria-label', on
        ? 'Chime when this session goes idle: on. Activate to turn it off.'
        : 'Chime when this session goes idle: off. Activate to turn it on.');
      btn.title = on ? 'Chime on idle: on' : 'Chime on idle: off';
    }

    /**
     * Bind the click once. Idempotent: a second call is a no-op, so a re-render
     * of the banner cannot stack handlers and double-toggle.
     * @param {boolean} enabled - The state to paint on first mount.
     */
    function mount(enabled) {
      const btn = doc.getElementById(buttonId);
      if (!btn) return;
      if (!btn.dataset.chimeBound) {
        btn.dataset.chimeBound = '1';
        btn.addEventListener('click', () => {
          const next = btn.getAttribute('aria-pressed') !== 'true';
          render(next);
          if (onToggle) onToggle(next);
        });
      }
      render(enabled);
    }

    return { mount, render };
  }

  /**
   * Transient status message in a rules section — used by the Project Rules
   * surface and by the Master settings component below, which is why it lives
   * here rather than in either page's script.
   * @param {Document} doc - Owning document.
   * @param {string} elementId - The status element's id.
   * @param {string} text
   * @param {boolean} ok
   */
  function tcSetRulesStatus(doc, elementId, text, ok) {
    const status = doc.getElementById(elementId);
    if (!status) return;
    status.textContent = text;
    status.className = `rules-status ${ok ? 'rules-status-ok' : 'rules-status-err'}`;
    status.classList.remove('hidden');
    setTimeout(() => { status.classList.add('hidden'); }, 3000);
  }

  /**
   * Markup for a rules surface whose read FAILED (#948). A `null` from `api()`
   * is not an empty list; rendering it as one told the operator "the shipped
   * baseline applies" on evidence that did not exist. Every rules surface —
   * the Master's Hard rules, its version history, the Project Rules lists —
   * renders its unknown through THIS one function, so the alert role, the
   * class pair and the sentence shape cannot drift between copies. Takes the
   * shared degraded-read record so the cause and remedy speak in the same
   * vocabulary as the dashboard's other unknowns.
   * @param {string} label - What could not be read, e.g. 'Rules', 'History'.
   * @param {{known: boolean, why: string|null, remedy: string|null}} read -
   *   A `tcDegradedRead(false, why, remedy)` record.
   * @returns {string} HTML for the list/panel body.
   */
  function tcRulesUnknownHtml(label, read) {
    const why = read.why ? ` — ${tcEscapeHtml(read.why)}` : '';
    const remedy = read.remedy ? ` ${tcEscapeHtml(read.remedy)}` : '';
    return `<p class="session-rules-empty session-rules-unknown" role="alert"><strong>${tcEscapeHtml(label)} unknown:</strong> the read failed${why}.${remedy}</p>`;
  }

  // ── Master settings component ──
  // Access level (read-only enforced; higher tiers disabled until each ships
  // with real structural enforcement), engine, scope, availability, and the
  // editable Hard-rules block backed by /api/session-rules?kind=master with
  // full version history + restore.
  //
  // This lives in the shared helper, not on the dashboard, because the Master's
  // settings must be reachable from inside a session too — from the dashboard
  // the operator had to leave the session to change the single most
  // consequential fact about the Master, what it is allowed to do. Both
  // surfaces mount THIS component; neither owns a copy of the markup or the
  // Hard-rules editor.

  /**
   * The modal's shell markup. The body is rendered on open, so this is the
   * only static markup either page needs — and it is emitted here rather than
   * written into both index.html and session.html, so the two cannot drift.
   * @returns {string} Modal HTML, ready to append to a document.
   */
  function tcMasterSettingsMarkup() {
    return `
    <div class="modal-backdrop" id="masterSettingsModal">
      <div class="modal-content" role="dialog" aria-label="Master settings" aria-modal="true" style="max-width:540px;max-height:85vh;overflow-y:auto">
        <h3 class="modal-title">Master Settings</h3>
        <div id="masterSettingsBody"></div>
        <div class="modal-actions">
          <button class="btn" id="masterSettingsCloseBtn">Close</button>
          <button class="btn btn-primary" id="masterSettingsSaveBtn">Save</button>
        </div>
      </div>
    </div>`;
  }

  /**
   * Build a mountable Master settings modal.
   *
   * Every page-specific capability arrives through `deps` rather than being
   * reached as a global, because the two mount sites genuinely differ: the
   * dashboard has master status dots to paint a failure onto and the session
   * page has none, and the engine list lives on a different state object on
   * each page.
   *
   * @param {object} deps
   * @param {Function} deps.api - GET helper returning parsed JSON or null.
   * @param {Function} deps.apiMutate - Mutating helper (url, method, body).
   * @param {Function} [deps.onSaved] - Called after a SUCCESSFUL settings save,
   *   so the surface can repaint anything else showing the same facts.
   * @param {Function} deps.esc - HTML-escaping function.
   * @param {Function} deps.buildEngineOptions - (engineList, selectedId) => options HTML.
   * @param {object} [deps.state] - Carries `engines` for the engine picker.
   * @param {Function} [deps.onOpenError] - Called with a message when the
   *   status fetch fails, so each surface reports it where its own affordance
   *   lives instead of the modal silently no-oping.
   * @param {Document} [deps.document] - Owning document (defaults to global).
   * @param {Function} [deps.confirm] - Confirmation prompt, injectable for tests.
   * @returns {{mount: Function, open: Function, close: Function, save: Function, renderBody: Function}}
   */
  function tcCreateMasterSettings(deps) {
    const api = deps.api;
    const apiMutate = deps.apiMutate;
    const esc = deps.esc;
    const buildEngineOptions = deps.buildEngineOptions;
    const state = deps.state || { engines: [] };
    const onOpenError = deps.onOpenError || function () {};
    // Hoisted to a bare local, and defaulted to a no-op, for the reason every
    // dep above it is: `saveMasterSettings` is LIFTED OUT of this closure and
    // evaluated alone in a vm sandbox by `test/master-launch-mode.test.js`, so a
    // `deps.` reference inside it is a ReferenceError there. The first shape of
    // this reached for `deps.onSaved` directly and turned three passing tests
    // red — the file's uniform hoisting is a contract, not a style.
    const onSaved = deps.onSaved || function () {};
    const doc = deps.document || global.document;
    // Named `confirm` so the moved call sites below read exactly as they did on
    // the dashboard; injectable so a test can drive the eyes-open paths.
    const confirm = deps.confirm || ((msg) => global.confirm(msg));
    // The moved bodies below look this up as a bare `document`, exactly as they
    // did on the dashboard. Binding the name here keeps them verbatim.
    const document = doc;

    /**
     * Open the Master settings modal: fetch status (settings live inside it) and
     * groups for the scope select, render the form, then load the Hard rules.
     */
    async function openMasterSettings() {
      const [status, groupsData] = await Promise.all([
        api('/api/master/status'),
        api('/api/groups')
      ]);
      if (!status || !status.settings) {
        // Surface the failure where the opening affordance lives instead of
        // silently no-oping.
        onOpenError(api.lastError || 'Master settings unavailable');
        return;
      }
      renderMasterSettingsBody(status.settings, (groupsData && groupsData.groups) || []);
      document.getElementById('masterSettingsModal').classList.add('open');
      loadMasterRules();
    }

    /**
     * Render the settings form into #masterSettingsBody.
     * @param {object} s - status.settings from GET /api/master/status
     * @param {object[]} groups - Project groups for the scope select
     */
    function renderMasterSettingsBody(s, groups) {
      const body = document.getElementById('masterSettingsBody');
      // WHEN a change binds, read from the server rather than asserted. Both
      // hints used to promise "its next tool call" on every engine; that is the
      // structural answer, and on an instructional master the level travels in
      // the regenerated identity, so it arrives with the next ensure (#755).
      // Falls back to the cautious sentence when the field is absent — an older
      // server, or a payload shape that changed — because over-promising
      // immediacy is the direction that misleads.
      // Three states, not two. The fallback used to share a sentence with the
      // instructional case, which states WHY as well as WHEN — and on a Claude
      // master hitting payload skew (older server, field moved) that "why" is
      // false: there IS a write guard. An absent field must never ship as a
      // claim about the engine, so the unknown case says only the cautious WHEN.
      const bindsAt = s.levelAppliesAt === 'next-tool-call'
        ? 'The write guard applies it on the master’s next tool call. The running master keeps the instructions it started with until it restarts, so restart it for the master itself to act on the change.'
        : s.levelAppliesAt === 'next-ensure'
          ? 'Takes effect the next time the master session starts, since this engine carries the level in its instructions rather than a write guard.'
          : 'Takes effect the next time the master session starts.';
      const tierHints = {
        'read-only': 'Structurally enforced on the Claude engine: writes are hard-denied outside the master’s memory/ directory. Whether anything else asks first is the Launch mode setting below — this tier bounds what the master may touch, not how often it prompts.',
        // The bypassPermissions sentence is PROBED, not reasoned. Both the first
        // draft of this hint and the plan's own caveat guessed — in opposite
        // directions — at what that launch mode does to a hook decision. Measured
        // against Claude Code 2.1.233 with this guard: under
        // --dangerously-skip-permissions a hook `deny` still blocks, a hook `ask`
        // still gates, and only a hook `allow` writes. The launch mode skips the
        // permission-RULES gate; a hook decision is evaluated separately and
        // outranks it. Do not soften this to a guess again.
        'suggest': 'The master may attempt writes anywhere, and each one outside its own memory directory stops for your confirmation in the master’s terminal. ' + bindsAt + ' The confirmation still stands under the bypassPermissions launch mode: a hook decision outranks it.',
        // Deliberately NOT the phrase "no confirmation at any layer": that
        // wording belongs to the conditional write + bypassPermissions warning
        // below, which only renders for that combination. Tier hints render at
        // every tier, so borrowing the sentinel made a read-only master display
        // the dangerous-combination text — caught by the #756 guard that asserts
        // exactly that.
        'write': 'The master may write anywhere it can reach, across every project, without asking you first. ' + bindsAt
      };
      const accessRadios = s.accessLevels.map((level) => {
        const enabled = s.enabledAccessLevels.includes(level);
        return `
      <label class="master-access-option${enabled ? '' : ' master-access-disabled'}">
        <input type="radio" name="masterAccessLevel" value="${esc(level)}"
               ${level === s.accessLevel ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
        <span class="master-access-name">${esc(level)}</span>
        <span class="form-hint">${esc(tierHints[level] || '')}</span>
      </label>`;
      }).join('');

      // Shares `buildEngineOptions` (#707). This was a fourth copy of that template
      // and the one that drifted — neither labelling nor disabling uninstalled
      // engines, on the surface where that fails hardest since the master launches
      // its engine immediately. The empty option is prepended because only this
      // picker has a "no pin" state.
      const engineOpts = '<option value="">(follow default engine)</option>'
        + buildEngineOptions(state.engines, s.engine || '');

      // Launch mode (#756). Rendered from what the SERVER says this engine offers
      // (`s.launchModes`) rather than re-derived here — a third source of truth for
      // which flags exist is exactly what #768 warns against.
      //
      // A stored mode the resolved engine cannot honor is shown, selected, and
      // labelled as unavailable rather than dropped: it is still the operator's
      // saved preference and comes back if they switch the engine back, so silently
      // showing 'default' would misreport what is stored (the silent-ignore failure
      // #741 documents). `resolvedLaunchMode` says what will actually run.
      const offered = Array.isArray(s.launchModes) ? s.launchModes : [];
      // "Stranded" means this engine offers modes but not the stored one. With NO
      // modes offered there is no engine to strand it against, and claiming
      // otherwise renders "no modes to choose from" directly above "saved as
      // default, which this engine cannot honor" — two sentences that cannot both
      // be true. `offered.length` is the guard that keeps them exclusive.
      const stranded = Boolean(offered.length && s.launchMode
        && !offered.some((m) => m.id === s.launchMode));
      const modeOpts = offered
        .map((m) => `<option value="${esc(m.id)}" ${m.id === s.launchMode ? 'selected' : ''}>${esc(m.label)}${m.warning ? ' ⚠' : ''}</option>`)
        .concat(stranded
          ? [`<option value="${esc(s.launchMode)}" selected>${esc(s.launchMode)} — not available on this engine</option>`]
          : [])
        .join('');

      const scopeIsGroup = s.scope && s.scope !== 'all';
      const groupOpts = ['<option value="">All projects</option>']
        .concat(groups.map((g) =>
          `<option value="${esc(g.id)}" ${scopeIsGroup && s.scope.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`))
        .join('');

      body.innerHTML = `
    <div class="form-hint master-enforcement-badge${s.guardDegraded ? ' master-enforcement-degraded' : ''}">
      Enforcement: <strong>${esc(s.enforcement)}</strong>
      ${s.enforcement === 'instructional'
        ? ' — the selected engine cannot be structurally bounded; the boundary is rules-only'
        : ' — write guard + permission rules regenerate on every master start'}
      ${s.guardDegraded
        ? `<div class="master-enforcement-degraded-why"><strong>${esc(TC_MASTER_GUARD_DEGRADED[s.guardDegradedCode] || 'DEGRADED')}:</strong> ${esc(s.guardDegradedReason || '')}${s.guardLevel ? ` The guard is applying <strong>${esc(s.guardLevel)}</strong>.` : ''}</div>`
        : ''}
    </div>
    <div class="form-group">
      <div class="form-label">Access level</div>
      <div class="master-access-grid">${accessRadios}</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="masterEngineSelect">Engine</label>
      <select id="masterEngineSelect" class="form-select">${engineOpts}</select>
      <div class="form-hint">Applies the next time the master session starts (restart via tmux: <code>tmux kill-session -t tangleclaw-master</code>, then reopen).</div>
    </div>
    <div class="form-group">
      <label class="form-label" for="masterLaunchModeSelect">Launch mode</label>
      ${offered.length
        ? `<select id="masterLaunchModeSelect" class="form-select">${modeOpts}</select>`
        : '<div class="form-hint">No engine is resolved, so there are no launch modes to choose from.</div>'}
      <div class="form-hint">
        How the master's own session prompts — enforced by the engine, and separate from
        Access level, which is what the master may do to the fleet.
        Applies the next time the master session starts.
        ${stranded
          ? `<strong>Saved as <code>${esc(s.launchMode)}</code>, which this engine cannot honor — it will start in <code>${esc(s.resolvedLaunchMode || 'default')}</code>.</strong> Your choice is kept and applies again if you switch back.`
          : ''}
        ${s.accessLevel === 'write' && s.resolvedLaunchMode === 'bypassPermissions'
          ? '<strong>This combination lets the master act on the fleet with no confirmation at any layer.</strong>'
          : ''}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="masterScopeSelect">Scope</label>
      <select id="masterScopeSelect" class="form-select">${groupOpts}</select>
      <div class="form-hint">A focus setting rendered into the master's identity — not a security boundary.</div>
    </div>
    <div class="form-group">
      <label class="gs-toggle-label">
        <span>Start with server</span>
        <input type="checkbox" id="masterAutoStart" ${s.autoStart ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <div class="form-hint">Launch the master session at TangleClaw boot instead of on first open.</div>
    </div>
    <div class="form-group master-rules-section">
      <div class="form-label">Hard rules</div>
      <div class="form-hint">The master's boundary, rendered into its identity on every start. Shipped baseline rules need an extra confirm to edit, disable, or delete; Restore defaults always recovers them.</div>
      <div class="session-rules-list" id="masterRulesList" aria-live="polite"></div>
      <div class="session-rules-add">
        <textarea class="rules-editor" id="masterRuleInput" rows="2" placeholder="Add a Hard rule…" spellcheck="false"></textarea>
        <button class="btn btn-small btn-primary" data-action="master-add-rule">Add</button>
      </div>
      <button class="btn btn-small" data-action="master-restore-defaults">Restore defaults</button>
      <div id="masterRulesStatus" class="rules-status hidden" role="status"></div>
    </div>`;
    }

    /**
     * Fetch and render the master Hard rules list.
     *
     * Three states, not two (#948). `api()` answers `null` when the read did
     * not happen; that is NOT an empty ruleset, and rendering it as one told
     * the operator "the shipped baseline applies" about the fleet's most
     * privileged agent on evidence that did not exist. The unknown gets its
     * own sentence in the degraded-read voice the dashboard already speaks.
     */
    async function loadMasterRules() {
      const data = await api('/api/session-rules?kind=master&status=active');
      if (!data) {
        renderMasterRulesUnknown(api.lastError);
        return;
      }
      renderMasterRulesList(data.rules || []);
    }

    /**
     * Render the Hard-rules list as UNKNOWN: the read failed, so neither "these
     * rules apply" nor "the baseline applies" can be claimed.
     * @param {string|null} why - `api.lastError`, when the transport left one.
     */
    function renderMasterRulesUnknown(why) {
      const list = document.getElementById('masterRulesList');
      if (!list) return;
      list.innerHTML = tcRulesUnknownHtml('Rules', tcDegradedRead(false, why,
        'Whether the shipped baseline or operator rules are in force cannot be shown. Close and reopen to retry.'));
    }

    /**
     * Render the Hard-rules list, newest last (creation order — the order they
     * render in the identity). System-authored rows carry a baseline badge.
     * @param {object[]} rules
     */
    function renderMasterRulesList(rules) {
      const list = document.getElementById('masterRulesList');
      if (!list) return;
      if (rules.length === 0) {
        list.innerHTML = '<p class="session-rules-empty">No rules — the shipped baseline applies until rules exist.</p>';
        return;
      }
      const ordered = rules.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
      list.innerHTML = ordered.map((rule) => `
    <div class="session-rule-item${rule.enabled ? '' : ' session-rule-disabled'}" data-rule-id="${rule.id}">
      <label class="session-rule-toggle">
        <input type="checkbox" data-action="master-toggle-rule" data-rule-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
      </label>
      <span class="session-rule-content">${rule.createdBy === 'system' ? '<span class="session-rule-badge" title="Shipped baseline rule">baseline</span> ' : ''}${rule.createdBy === 'ai' ? '<span class="session-rule-badge" title="AI-authored">AI</span> ' : ''}${esc(rule.content)}</span>
      <button class="btn btn-small session-rule-history" data-action="master-rule-history" data-rule-id="${rule.id}" aria-label="Version history" title="Version history">&#8635;</button>
      <button class="btn btn-small btn-danger session-rule-delete" data-action="master-delete-rule" data-rule-id="${rule.id}" aria-label="Delete rule">&times;</button>
    </div>
    <div class="master-rule-history hidden" id="masterRuleHistory-${rule.id}"></div>
  `).join('');
    }

    /**
     * Find a rendered rule's record from the last fetch (for system-rule
     * confirmation). Re-fetches to avoid stale provenance.
     * @param {number} id - Rule id
     * @returns {Promise<object|null>}
     */
    async function _getMasterRule(id) {
      const data = await api('/api/session-rules?kind=master&status=active');
      return data && data.rules ? data.rules.find((r) => r.id === id) || null : null;
    }

    /** Add a Hard rule from the textarea. */
    async function addMasterRule() {
      const input = document.getElementById('masterRuleInput');
      const content = input ? input.value.trim() : '';
      if (!content) return;
      const data = await apiMutate('/api/session-rules', 'POST', { content, kind: 'master' });
      if (data) {
        if (input) input.value = '';
        _setMasterRulesStatus('Added', true);
        loadMasterRules();
      } else {
        _setMasterRulesStatus('Add failed', false);
      }
    }

    /**
     * Toggle a Hard rule. Disabling a shipped baseline rule is an eyes-open
     * action: the server refuses without the confirm flag, the UI asks first.
     * @param {number} id - Rule id
     * @param {boolean} enabled - New state
     */
    async function toggleMasterRule(id, enabled) {
      const body = { enabled };
      if (!enabled) {
        const rule = await _getMasterRule(id);
        if (rule && rule.createdBy === 'system') {
          if (!confirm('This is a shipped boundary rule. Disable it anyway? Restore defaults can always bring it back.')) {
            loadMasterRules();
            return;
          }
          body.confirmBaselineEdit = true;
        }
      }
      const data = await apiMutate(`/api/session-rules/${id}`, 'PUT', body);
      if (!data) { _setMasterRulesStatus('Update failed', false); }
      loadMasterRules();
    }

    /**
     * Delete a Hard rule (eyes-open confirm for shipped baseline rules — the
     * server refuses without ?confirm=true).
     * @param {number} id - Rule id
     */
    async function deleteMasterRule(id) {
      const rule = await _getMasterRule(id);
      const isBaseline = rule && rule.createdBy === 'system';
      const msg = isBaseline
        ? 'This is a shipped boundary rule. Delete it anyway? Restore defaults can always bring it back.'
        : 'Delete this Hard rule?';
      if (!confirm(msg)) return;
      const url = `/api/session-rules/${id}${isBaseline ? '?confirm=true' : ''}`;
      const data = await apiMutate(url, 'DELETE', {});
      if (data) _setMasterRulesStatus('Deleted', true);
      else _setMasterRulesStatus('Delete failed', false);
      loadMasterRules();
    }

    /** Replace all Hard rules with the shipped baseline. */
    async function restoreMasterDefaults() {
      if (!confirm('Replace ALL Hard rules with the shipped baseline? Version history is preserved.')) return;
      const data = await apiMutate('/api/master/rules/restore-defaults', 'POST', {});
      if (data) _setMasterRulesStatus('Baseline restored', true);
      else _setMasterRulesStatus('Restore failed', false);
      loadMasterRules();
    }

    /**
     * Toggle a rule's version-history panel: fetch versions and render each with
     * a Restore button (rollback records its own history entry).
     * @param {number} id - Rule id
     */
    async function toggleMasterRuleHistory(id) {
      const panel = document.getElementById(`masterRuleHistory-${id}`);
      if (!panel) return;
      if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        return;
      }
      const data = await api(`/api/session-rules/${id}/versions`);
      if (!data) {
        // Same flatten as the rules list, same lie (#948): a failed read is
        // not "No history." — it is a history nobody fetched.
        panel.innerHTML = tcRulesUnknownHtml('History',
          tcDegradedRead(false, api.lastError, 'Toggle again to retry.'));
        panel.classList.remove('hidden');
        return;
      }
      const versions = data.versions || [];
      panel.innerHTML = versions.length === 0
        ? '<p class="session-rules-empty">No history.</p>'
        : versions.map((v) => `
      <div class="master-rule-version">
        <span class="master-rule-version-meta">v${v.versionNo} · ${esc(v.op)} · ${esc(v.changedBy)} · ${esc(v.createdAt)}${v.enabled ? '' : ' · disabled'}</span>
        <span class="master-rule-version-content">${esc(v.content)}</span>
        <button class="btn btn-small" data-action="master-restore-version" data-rule-id="${id}" data-version-no="${v.versionNo}">Restore</button>
      </div>`).join('');
      panel.classList.remove('hidden');
    }

    /**
     * Roll a rule back to a prior version. Restoring a shipped baseline rule to
     * different/disabled content is a weakening mutation like edit/disable, so it
     * carries the same eyes-open confirm (the server refuses it without the flag).
     * @param {number} id - Rule id
     * @param {number} versionNo - Target version
     */
    async function restoreMasterRuleVersion(id, versionNo) {
      const body = { versionNo };
      const rule = await _getMasterRule(id);
      if (rule && rule.createdBy === 'system') {
        if (!confirm(`Restore this shipped boundary rule to v${versionNo}? If the version differs from the current text, this changes the boundary.`)) return;
        body.confirmBaselineEdit = true;
      }
      const data = await apiMutate(`/api/session-rules/${id}/restore`, 'POST', body);
      if (data) _setMasterRulesStatus(`Restored v${versionNo}`, true);
      else _setMasterRulesStatus('Restore failed', false);
      loadMasterRules();
    }

    /**
     * Delegated click/change handler for the master settings body.
     * @param {Event} e
     */
    function handleMasterSettingsEvent(e) {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      const id = Number(target.getAttribute('data-rule-id'));
      if (action === 'master-add-rule' && e.type === 'click') addMasterRule();
      else if (action === 'master-toggle-rule' && e.type === 'change') toggleMasterRule(id, target.checked);
      else if (action === 'master-delete-rule' && e.type === 'click') deleteMasterRule(id);
      else if (action === 'master-rule-history' && e.type === 'click') toggleMasterRuleHistory(id);
      else if (action === 'master-restore-defaults' && e.type === 'click') restoreMasterDefaults();
      else if (action === 'master-restore-version' && e.type === 'click') restoreMasterRuleVersion(id, Number(target.getAttribute('data-version-no')));
    }

    /** Persist the settings form via PATCH /api/config { master }. */
    async function saveMasterSettings() {
      const checked = document.querySelector('input[name="masterAccessLevel"]:checked');
      const engineSel = document.getElementById('masterEngineSelect');
      const scopeSel = document.getElementById('masterScopeSelect');
      const autoStartEl = document.getElementById('masterAutoStart');
      const modeSel = document.getElementById('masterLaunchModeSelect');
      const masterPatch = {
        accessLevel: checked ? checked.value : 'read-only',
        engine: engineSel && engineSel.value ? engineSel.value : null,
        // Absent select → the engine offered no modes, so send nothing rather than
        // a guess; PATCH merges over the stored block and leaves the choice intact.
        ...(modeSel && modeSel.value ? { launchMode: modeSel.value } : {}),
        scope: scopeSel && scopeSel.value ? { type: 'group', groupId: scopeSel.value } : 'all',
        autoStart: !!(autoStartEl && autoStartEl.checked)
      };
      const data = await apiMutate('/api/config', 'PATCH', { master: masterPatch });
      if (data) {
        _setMasterRulesStatus('Settings saved — engine, launch mode and scope apply on next master start', true);
        // Tell the surface the level may have moved (#755 chunk 3). The bar and
        // this modal are two controls for ONE setting, often visible at the same
        // moment on the same screen — the gear sits IN the bar. Without this the
        // operator saves `write` here and watches the toggle two inches away go
        // on saying READ, which reads as the save having failed.
        //
        // A callback rather than this component reaching for the bar: the modal
        // is mounted by both pages and must not know what else they render. It
        // is also why the bar re-fetches instead of being handed the level —
        // one source of truth for what is in force stays the server.
        //
        // Inside the success branch on purpose: a save that failed changed
        // nothing, and repainting there would make a failed save look like it
        // had done something.
        onSaved();
      } else {
        _setMasterRulesStatus(api.lastError || 'Save failed', false);
      }
    }

    /** Close the master settings modal. */
    function closeMasterSettings() {
      document.getElementById('masterSettingsModal').classList.remove('open');
    }

    /**
     * Transient status line in the master settings modal.
     * @param {string} text
     * @param {boolean} ok
     */
    function _setMasterRulesStatus(text, ok) {
      tcSetRulesStatus(document, 'masterRulesStatus', text, ok);
    }

    /**
     * Ensure the modal exists in the page and its listeners are bound.
     *
     * Idempotent: it injects the modal only when the page has none, and adopts
     * one that is already present rather than appending a second. Neither page
     * ships the markup any more — this function emits it — so the adoption path
     * exists for the repeat call, not for static HTML: the control bar mounts
     * on demand while page load has already mounted once, and a blind append
     * would leave two `#masterSettingsModal` elements with `getElementById`
     * rendering into the one the operator cannot see.
     *
     * @param {HTMLElement} [container] - Where to inject when absent; defaults
     *   to the document body.
     * @returns {HTMLElement|null} The modal element.
     */
    function mount(container) {
      let modal = document.getElementById('masterSettingsModal');
      if (!modal) {
        const host = container || document.body;
        const holder = document.createElement('div');
        holder.innerHTML = tcMasterSettingsMarkup();
        modal = holder.firstElementChild;
        host.appendChild(modal);
      }
      if (modal.dataset.tcMasterSettingsBound === '1') return modal;
      modal.dataset.tcMasterSettingsBound = '1';
      const closeBtn = document.getElementById('masterSettingsCloseBtn');
      const saveBtn = document.getElementById('masterSettingsSaveBtn');
      const body = document.getElementById('masterSettingsBody');
      if (closeBtn) closeBtn.addEventListener('click', closeMasterSettings);
      if (saveBtn) saveBtn.addEventListener('click', saveMasterSettings);
      modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMasterSettings(); });
      if (body) {
        body.addEventListener('click', handleMasterSettingsEvent);
        body.addEventListener('change', handleMasterSettingsEvent);
      }
      return modal;
    }

    return {
      mount,
      open: openMasterSettings,
      close: closeMasterSettings,
      save: saveMasterSettings,
      renderBody: renderMasterSettingsBody,
      // The two reads that render a three-state answer (#948). Exposed so the
      // states can be driven through the component rather than by matching
      // source strings; the delegated click handler calls the same functions.
      loadRules: loadMasterRules,
      toggleRuleHistory: toggleMasterRuleHistory
    };
  }

  // Only the classifiers the render sites actually call are exported.
  // Two non-classifiers join them because a page script calls each: the record
  // builder `tcDegradedRead` (ui.js builds the Project Rules unknown from it)
  // and `tcRulesUnknownHtml`. `tcCauseText`, `tcGitFieldText` and `tcSentence`
  // are internal to the classifiers and reached by closure — exporting them
  // would enlarge the global surface that every page carries for no consumer.
  global.tcSessionLiveness = tcSessionLiveness;
  global.tcSessionRead = tcSessionRead;
  global.tcMasterRead = tcMasterRead;
  global.tcRulesUnknownHtml = tcRulesUnknownHtml;
  global.tcDegradedRead = tcDegradedRead;
  global.tcGitDirtyState = tcGitDirtyState;
  global.tcGitRead = tcGitRead;
  global.tcScanNotice = tcScanNotice;
  global.tcUnreadableNotice = tcUnreadableNotice;
  global.tcBuildEngineOptions = tcBuildEngineOptions;
  global.tcResolvePickerEngine = tcResolvePickerEngine;
  global.tcEnableLocalSelectionOverride = tcEnableLocalSelectionOverride;
  global.tcWireTerminalTouchScroll = tcWireTerminalTouchScroll;
  global.tcWireTerminalDragCopy = tcWireTerminalDragCopy;
  global.tcWireTerminalFrame = tcWireTerminalFrame;
  /*
   * ── The Master control bar (#768 chunk 2) ────────────────────────────────
   *
   * The session banner's control set, reused for the Master. Not a status row:
   * from inside a session there was no route to the Master's settings at all,
   * and the dashboard's own row carried a gear the drawer's did not.
   *
   * CONTINUITY IS THE POINT, and it is delivered in two layers that land at
   * different times:
   *
   *   Look — shared NOW. Every control here reuses the SESSION'S OWN classes
   *   (`banner-btn`, `medusa-control`, the engine pill), never new ones. A
   *   restyle of the session banner moves this bar with it, dim placeholders
   *   included. That is the whole "change it once" property, and it costs
   *   nothing beyond choosing not to invent class names.
   *
   *   Behaviour — shared WHEN each backend lands. Making one implementation
   *   serve both surfaces means parameterising each control by target and
   *   having the session banner adopt the shared version too. That is real
   *   work and it is wasted while the Master has no route to drive.
   *
   * THE TRAP THIS ENCODES. The dim placeholder is exactly where a fork sneaks
   * in, because a placeholder feels too small to be an architecture decision.
   * A hand-rolled Medusa that merely LOOKS like the session's is identical on
   * day one and drifted by the third restyle. The split above is safe ONLY
   * because the placeholder is inert — the moment a control goes live on the
   * Master it must be the extracted component, not a copy that happens to
   * share a stylesheet.
   */

  /**
   * Why each control cannot work yet, in the operator's words.
   *
   * ONE table, consulted by both surfaces, because the failure mode for
   * absent-with-a-reason is two surfaces giving different reasons for the same
   * absence — which reads as one of them being wrong. Rendered into `title` and
   * `aria-describedby` so the reason is reachable by pointer and by screen
   * reader, not just by hover.
   *
   * The rule these serve (#755, #741): a control with no backend is visibly
   * absent WITH ITS REASON, never present-and-inert. A disabled control that
   * carries its own reason is the honest form of that — the operator can see
   * the bar's final shape without being able to press something that would
   * silently do nothing.
   */
  const TC_MASTER_PENDING = {
    // `medusa` LEFT this table with #996: `/api/master/medusa/*` exists and the
    // bar mounts the shared control (`tcCreateMedusaControl`) — the same
    // removal-is-the-proof rule `access` and `kill` set below.
    // `access` is GONE from this table on purpose. It named the last reason the
    // toggle was inert ("isn't wired up yet"), and the toggle is wired now — the
    // entry's own removal is what proves the pending treatment came off rather
    // than being left beside a live control, which is the worst of both (a
    // reason for an absence that is not absent).
    upload: 'Uploads resolve through a registered project, and the Master is not one.',
    // `kill` left this table when `POST /api/master/kill` landed (#968), for the
    // same reason `access` did: a reason rendered beside a working control is its
    // own falsehood, and the entry's REMOVAL is what proves the pending treatment
    // came off WITH the backend rather than beside it.
    wrap: "Wrap is a git pipeline and the Master has no checkout — what it should mean here isn't decided yet."
  };

  /**
   * Short labels for the guard-degradation codes `/api/master/status` reports.
   *
   * ONE table, for the same reason the pending-control reasons are one table:
   * the bar and the gear both render this, and two surfaces naming the same
   * condition differently reads as one of them being wrong.
   *
   * It is also what gives `guardDegradedCode` a consumer. The field exists so
   * neither surface has to regex the reason sentence to tell "the guard is gone"
   * from "the level disagrees" — a machine-readable discriminator that nothing
   * reads is just a longer payload.
   *
   * @type {Object<string, string>}
   */
  const TC_MASTER_GUARD_DEGRADED = {
    'guard-missing': 'NOT ENFORCED',
    'guard-unwired': 'NOT ENFORCED',
    'guard-tampered': 'UNKNOWN',
    'level-unreadable': 'READ-ONLY',
    'level-mismatch': 'MISMATCH'
  };

  /**
   * A short, local date for a timestamp the operator has to act on.
   *
   * Full ISO in a one-line warning is noise; the day is the part that makes
   * "started before these instructions" concrete. Falls back to the raw value
   * rather than throwing, because a warning that cannot render is worse than one
   * that renders awkwardly.
   *
   * @param {string} iso - ISO timestamp.
   * @returns {string} e.g. `17 Jul`.
   */
  function _tcShortDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    } catch (err) {
      return String(iso);
    }
  }

  /**
   * The access toggle's segments — the ONE place a segment and the level it
   * stands for are related.
   *
   * The markup, the click binding and the pressed-state paint all read this,
   * rather than the markup emitting a `data-access` attribute the other two
   * read back. An attribute round-trip looks like single-sourcing and is not:
   * it puts the relationship in the DOM, where a renderer that stops emitting
   * the attribute leaves a control that renders fine and does nothing.
   *
   * `suggest` is deliberately absent — #768 ratified a two-segment bar with the
   * gear as the complete control. `setAccess` renders it as a readout instead.
   *
   * @type {{suffix: string, level: string, label: string}[]}
   */
  const TC_MASTER_ACCESS_SEGMENTS = [
    { suffix: 'AccessRead', level: 'read-only', label: 'READ' },
    { suffix: 'AccessWrite', level: 'write', label: 'WRITE' }
  ];

  // ── Medusa switchboard control (MED-2K9P, shared since #996) ──
  //
  // One control, two hosts. The session banner mounted the original (singleton
  // ids, module-global project name); the Master control bar needs the SAME
  // control pointed at `/api/master/medusa`. The #768 rule for the bar is
  // reuse-don't-fork — a hand-rolled Medusa that merely looked like the
  // session's would be identical on day one and drifted by the third restyle —
  // so the control is parameterised by target: an API base, an id set, and
  // the word it uses for its host ("this session" / "the Master").
  //
  // What it deliberately does NOT own: the loop modal, the loops chip and the
  // loops panel. Those stay in `session.js` behind the `hooks` seam (the
  // session passes its chip renderer and modal closer), because fleet-command
  // loops from the Master are a design question (#961), not a mount.

  /**
   * Element ids for one Medusa control.
   *
   * The session banner keeps its historical unprefixed ids (`medusaControl`…)
   * so its static markup, stylesheet hooks and the loop controls that share
   * the root keep working untouched. Any prefixed host — the Master bar on the
   * dashboard AND in the session drawer, which share a page with the banner —
   * gets `${prefix}Medusa*`, so two controls can never claim one id. Loop ids
   * are null for a prefixed host: the control renders no loop affordances
   * there, and a null id makes `el()` answer null rather than find the
   * banner's.
   * @param {string} [prefix] - Host prefix; empty/omitted = the session banner.
   * @returns {{control: string, heads: string, badge: string, loop: (string|null),
   *   loopsChip: (string|null), peers: string, panel: string,
   *   loopsPanel: (string|null), live: string}}
   */
  function tcMedusaIds(prefix) {
    if (!prefix) {
      return {
        control: 'medusaControl', heads: 'medusaHeads', badge: 'medusaBadge',
        loop: 'medusaLoop', loopsChip: 'medusaLoopsChip', peers: 'medusaPeers',
        panel: 'medusaPanel', loopsPanel: 'medusaLoopsPanel', live: 'medusaLive'
      };
    }
    return {
      control: `${prefix}Medusa`, heads: `${prefix}MedusaHeads`, badge: `${prefix}MedusaBadge`,
      loop: null, loopsChip: null, peers: `${prefix}MedusaPeers`,
      panel: `${prefix}MedusaPanel`, loopsPanel: null, live: `${prefix}MedusaLive`
    };
  }

  /**
   * Markup for a Medusa control without loop affordances — the two facing
   * heads flanking the emblem, the "!" error glyph, the unread badge, the
   * peers popover, the inbox panel and the aria-live region. Same classes the
   * session banner's static markup uses, so `shared-controls.css` styles both.
   * Hidden until a status answers, exactly as the banner's is.
   * @param {ReturnType<typeof tcMedusaIds>} ids - The host's id set.
   * @returns {string} HTML.
   */
  function tcMedusaControlMarkup(ids) {
    return `<span class="medusa-control is-off" id="${ids.control}" hidden>`
      + `<button class="medusa-heads" id="${ids.heads}" type="button" aria-pressed="false"`
      + ` aria-label="Medusa session comms: off. Click to enable.">`
      + '<span class="medusa-mark" aria-hidden="true">'
      + '<img class="medusa-head medusa-head--in" src="/medusa-head-left.webp" alt="" width="24" height="29">'
      + '<img class="medusa-emblem" src="/medusa-wordmark.webp" alt="" width="50" height="23">'
      + '<img class="medusa-head medusa-head--out" src="/medusa-head-right.webp" alt="" width="24" height="29">'
      + '</span><span class="medusa-warn" aria-hidden="true">!</span></button>'
      + `<button class="medusa-badge" id="${ids.badge}" type="button" hidden aria-label="Open Medusa inbox">0</button>`
      + `<span class="medusa-peers group-popover" id="${ids.peers}" role="tooltip" hidden></span>`
      + `<div class="medusa-panel group-popover" id="${ids.panel}" role="dialog" aria-label="Medusa inbox" hidden></div>`
      + `<span class="sr-only" id="${ids.live}" aria-live="polite"></span>`
      + '</span>';
  }

  /**
   * Escape HTML special characters — the fallback when a host passes no `esc`.
   * Inbound switchboard text is untrusted cross-session data and every byte of
   * it goes through this before it reaches `innerHTML`.
   * @param {*} str - Value to escape.
   * @returns {string}
   */
  function tcEscapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Create a Medusa switchboard control bound to one participant.
   *
   * Rides its host's existing poll — `poll()` is called by the session's status
   * tick and by the Master bar's status load — and starts no timer of its own
   * (this project's no-UI-timers rule, #98/#268).
   *
   * @param {object} deps
   * @param {string} deps.apiBase - The participant's switchboard API base, e.g.
   *   `/api/sessions/<project>/medusa` or `/api/master/medusa`.
   * @param {(url: string, opts?: object) => Promise<object|null>} deps.api - The
   *   page's `api()` (null on failure).
   * @param {object} [deps.doc] - Document (tests).
   * @param {ReturnType<typeof tcMedusaIds>} [deps.ids] - Id set; defaults to the
   *   session banner's.
   * @param {(s: *) => string} [deps.esc] - HTML escaper; defaults to `tcEscapeHtml`.
   * @param {string} [deps.subject] - How the help text names the host:
   *   `'this session'` (default) or `'the Master'`.
   * @param {object} [deps.state] - The state object to drive. The session passes
   *   `sessionState.medusa` so its loop code keeps reading the object it always
   *   read; omitted → a private one.
   * @param {object} [deps.hooks]
   * @param {(m: object) => void} [deps.hooks.onRender] - After each render, with
   *   the state (the session paints its loop button + loops chip here).
   * @param {() => void} [deps.hooks.onOpenInbox] - Before the inbox opens (the
   *   session closes its loop modal).
   * @returns {{state: object, mount: () => boolean, render: () => void,
   *   poll: () => Promise<void>, applyStatus: (data: object|null) => void,
   *   toggle: () => Promise<void>, openInbox: () => Promise<void>,
   *   closeInbox: () => void, showPeers: () => Promise<void>, hidePeers: () => void,
   *   flowInbound: (n: number) => void, flowOutbound: (label: string, status: string) => void,
   *   stateLabel: (m: object) => string, helpText: (m: object) => string,
   *   renderMessages: (messages: object[]) => string}}
   */
  function tcCreateMedusaControl(deps) {
    const doc = deps.doc || global.document;
    const ids = deps.ids || tcMedusaIds('');
    const subject = deps.subject || 'this session';
    const esc = deps.esc || tcEscapeHtml;
    const hooks = deps.hooks || {};
    const m = deps.state || {};
    // Fill rather than replace: the session's state object already carries
    // these keys and its loop code holds a reference to it.
    if (m.state === undefined) m.state = 'off';
    if (m.unread === undefined) m.unread = 0;
    if (m.prevUnread === undefined) m.prevUnread = 0;
    if (m.workspaceId === undefined) m.workspaceId = null;
    if (m.lastError === undefined) m.lastError = null;
    if (m.shown === undefined) m.shown = false;
    if (m.loops === undefined) m.loops = [];
    if (m.loopsError === undefined) m.loopsError = null;
    if (m.outbound === undefined) m.outbound = { allowed: true, reason: null };
    let bound = false;

    const el = (key) => (ids[key] ? doc.getElementById(ids[key]) : null);

    /**
     * Whether the participant's level lets it SEND (#996). A project session
     * always may; a `read-only` Master may not, and the status payload says so.
     * @param {object} st - State.
     * @returns {boolean}
     */
    function sendBlocked(st) {
      return !!(st.outbound && st.outbound.allowed === false);
    }

    /**
     * Human-readable status text for the control's accessible label + tooltip.
     * This is the never-color-only source of truth for the listener state.
     * @param {{state: string, unread: number, lastError: (string|null)}} st - State.
     * @returns {string}
     */
    function stateLabel(st) {
      const unread = st.unread > 0 ? `, ${st.unread} unread` : '';
      const blocked = sendBlocked(st) ? ', receive-only at this access level' : '';
      switch (st.state) {
        case 'listening': return `Medusa session comms: on, listening${unread}${blocked}. Click to disable.`;
        case 'connecting': return `Medusa session comms: connecting${unread}${blocked}. Click to disable.`;
        // The listener auto-reconnects with backoff while enabled, so "retry" is
        // automatic; a click here DISABLES it (toggle → off). Label the real action.
        case 'error': return `Medusa session comms: error — ${st.lastError || 'cannot reach the bridge'}${unread}. Click to disable.`;
        default: return `Medusa session comms: off${unread}. Click to enable.`;
      }
    }

    /**
     * Richer hover-tooltip help (the `title`), distinct from the concise
     * aria-label: explains what Medusa *is* and what this host is *doing* in the
     * current state — and, when its level blocks sending, says so with the
     * server's reason rather than letting the operator find out on a 403.
     * @param {{state: string, unread: number, lastError: (string|null)}} st - State.
     * @returns {string}
     */
    function helpText(st) {
      const doing = {
        listening: 'On — listening for messages from your other TangleClaw sessions'
          + (st.unread > 0 ? ` (${st.unread} unread — click the badge to read)` : ''),
        connecting: 'Connecting to the message bridge…',
        error: `Enabled but can't reach the bridge — ${st.lastError || 'auto-retrying'}`
      }[st.state] || `Off — ${subject} can't send or receive session messages`;
      const action = st.state === 'off' ? `connect ${subject}` : 'disconnect';
      const blocked = sendBlocked(st) && st.state !== 'off'
        ? ` Sending is disabled: ${st.outbound.reason || 'the access level does not allow it'}`
        : '';
      return 'Medusa: session-to-session comms (the switchboard) — message your other '
        + `TangleClaw sessions from the banner. ${doing}. Click the heads to ${action}.${blocked}`;
    }

    /**
     * Sync the control to the state: status class, unread badge, error glyph
     * and accessible label; reveal on first render. When unread rose since the
     * last render (a fresh inbound), fire the inbound-head flow + an aria-live
     * announcement — the non-color/-motion cue.
     * @returns {void}
     */
    function render() {
      const control = el('control');
      if (!control) return;
      // The durable opt-in gates the SURFACE, not just the autostart (#820).
      // Without this the control appeared on every session page regardless of
      // the project's setting, rendering `is-off` — and one click on it started
      // the listener. A feature the operator has not turned on must not be one
      // idle click away from running.
      //
      // Strictly `=== false`, never falsy: an absent `enabled` means the gate
      // was not computed (an older payload, a toggle response), and hiding a
      // control because a field is missing is its own dishonesty.
      if (m.enabled === false) {
        control.hidden = true;
        return;
      }
      if (control.hidden) control.hidden = false;

      // First render seeds prevUnread from the current count so a listener that
      // was already running (or auto-started) with a pre-existing backlog does
      // NOT flash the inbound head + announce "new message" for messages that
      // predate this page view. Only unread that rises *after* the first paint
      // is a fresh arrival.
      if (!m.shown) {
        m.shown = true;
        m.prevUnread = m.unread;
      }

      const STATE_CLASSES = ['is-off', 'is-connecting', 'is-listening', 'is-error'];
      STATE_CLASSES.forEach((c) => control.classList.remove(c));
      control.classList.add(STATE_CLASSES.includes(`is-${m.state}`) ? `is-${m.state}` : 'is-off');

      const heads = el('heads');
      if (heads) {
        const label = stateLabel(m);
        heads.setAttribute('aria-pressed', m.state !== 'off' ? 'true' : 'false');
        heads.setAttribute('aria-label', label);
        heads.title = helpText(m);
      }

      const badge = el('badge');
      if (badge) {
        if (m.unread > 0) {
          badge.textContent = String(m.unread);
          badge.hidden = false;
          badge.setAttribute('aria-label', `Open Medusa inbox (${m.unread} unread)`);
        } else {
          badge.hidden = true;
        }
      }

      if (typeof hooks.onRender === 'function') hooks.onRender(m);

      if (m.unread > m.prevUnread) flowInbound(m.unread - m.prevUnread);
      m.prevUnread = m.unread;
    }

    /**
     * Fire the transient inbound-head flow animation and announce arrival on
     * the aria-live region (the animation self-suppresses under reduced-motion).
     * @param {number} n - Count of new messages this poll.
     * @returns {void}
     */
    function flowInbound(n) {
      const control = el('control');
      if (control) {
        control.classList.remove('flow-in');
        void control.offsetWidth; // reflow so re-adding restarts the animation
        control.classList.add('flow-in');
      }
      const live = el('live');
      if (live) live.textContent = n === 1 ? 'New Medusa message received' : `${n} new Medusa messages received`;
    }

    /**
     * Fire the transient outbound-head flow on a successful send and announce
     * it, mirroring `flowInbound`.
     * @param {string} label - Human label for the target (name or id).
     * @param {string} status - The honest send status ('received' | 'queued'),
     *   or 'invited' for a loop open (the Bridge delivers the invite itself and
     *   does not report live-vs-queued, so the announcement claims neither).
     * @returns {void}
     */
    function flowOutbound(label, status) {
      const control = el('control');
      if (control) {
        control.classList.remove('flow-out');
        void control.offsetWidth; // reflow so re-adding restarts the animation
        control.classList.add('flow-out');
      }
      const live = el('live');
      if (live) {
        live.textContent = status === 'queued'
          ? `Message queued for ${label} (offline)`
          : status === 'invited'
            ? `Loop invite sent to ${label}`
            : `Message delivered to ${label}`;
      }
    }

    /**
     * Fold a status payload (`GET <apiBase>/status`, a toggle response, or the
     * `medusa` field of `/api/master/status`) into the state and re-render.
     * Loop fields are taken only when present — a toggle response carries none
     * and must not blank the loops the last poll painted.
     * @param {object|null} data - Status payload, or null on a failed fetch.
     * @returns {void}
     */
    function applyStatus(data) {
      if (!data) return;
      m.state = data.state;
      m.unread = data.unread || 0;
      m.workspaceId = data.workspaceId || null;
      m.lastError = data.lastError || null;
      if ('loops' in data) m.loops = data.loops || [];
      if ('loopsError' in data) m.loopsError = data.loopsError || null;
      if ('outbound' in data) m.outbound = data.outbound || { allowed: true, reason: null };
      // Taken only when present, like the loop fields: a toggle response carries
      // no `enabled`, and blanking it there would hide the control the operator
      // just switched on.
      if ('enabled' in data) m.enabled = data.enabled === true;
      render();
    }

    /**
     * Poll the listener status on the host's cadence (no timer here).
     * @returns {Promise<void>}
     */
    async function poll() {
      applyStatus(await deps.api(`${deps.apiBase}/status`));
    }

    /**
     * Toggle the listener (the heads click). Reflects the returned status at
     * once; the next poll reconciles.
     * @returns {Promise<void>}
     */
    async function toggle() {
      applyStatus(await deps.api(`${deps.apiBase}/toggle`, { method: 'POST' }));
    }

    /**
     * Build the read-panel markup from the inbox (newest first). All message
     * content is escaped — inbound text is untrusted cross-session data.
     * @param {Array<{from?: string, message?: string}>} messages - Inbox, oldest first.
     * @returns {string} HTML.
     */
    function renderMessages(messages) {
      // Header carries an explicit ✕ close: the badge that opens the panel
      // self-hides on read (unread → 0), so it can't be the only dismiss control
      // (mobile trap).
      const head = '<div class="group-popover-title medusa-panel-head"><span>Medusa inbox</span>'
        + '<button type="button" class="medusa-panel-close" aria-label="Close inbox">✕</button></div>';
      if (!messages.length) {
        return `${head}<div class="medusa-msg-empty">No messages yet.</div>`;
      }
      const rows = messages.slice().reverse().map((msg) => {
        const from = esc(msg.from || 'unknown');
        const body = esc(msg.message || '');
        return `<div class="medusa-msg"><div class="medusa-msg-from">${from}</div><div class="medusa-msg-body">${body}</div></div>`;
      }).join('');
      return `${head}${rows}`;
    }

    /**
     * Open the inbox read panel (the badge click): fetch received messages,
     * render them, and report exactly those messages handled. Toggles closed if
     * already open.
     *
     * Reporting by id rather than sending a bare badge clear is what makes the
     * panel honest: a handled message leaves the inbox and is ACKed to the Hub,
     * and anything that arrived after this fetch is untouched, so it cannot be
     * discarded unseen (#784, #785).
     * @returns {Promise<void>}
     */
    async function openInbox() {
      const panel = el('panel');
      if (!panel) return;
      if (!panel.hidden) { panel.hidden = true; return; }
      hidePeers();
      if (typeof hooks.onOpenInbox === 'function') hooks.onOpenInbox();

      const data = await deps.api(`${deps.apiBase}/messages`);
      const messages = (data && data.messages) || [];
      panel.innerHTML = renderMessages(messages);
      panel.hidden = false;

      const handled = messages.map((msg) => msg && msg.id).filter((id) => id != null);
      const status = handled.length
        ? await deps.api(`${deps.apiBase}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: handled })
        })
        : await deps.api(`${deps.apiBase}/read`, { method: 'POST' });
      if (status) {
        m.unread = status.unread || 0;
        render();
      }
    }

    /**
     * Close the inbox read panel (the ✕, Escape, outside click). Safe when
     * already closed — the badge self-hides on read, so it is never the only
     * path to dismiss the panel it opened.
     * @returns {void}
     */
    function closeInbox() {
      const panel = el('panel');
      if (panel) panel.hidden = true;
    }

    /**
     * Show the recent-inbound-peers popover on hover (desktop affordance)
     * listing the distinct senders in the inbox. No-op when empty or the read
     * panel is open.
     * @returns {Promise<void>}
     */
    async function showPeers() {
      const peers = el('peers');
      const panel = el('panel');
      if (!peers || (panel && !panel.hidden)) return;
      const data = await deps.api(`${deps.apiBase}/messages`);
      const froms = [...new Set(((data && data.messages) || []).map((msg) => msg.from || 'unknown'))];
      if (!froms.length) return;
      peers.innerHTML = '<div class="group-popover-title">Recent inbound</div>'
        + froms.map((f) => `<div class="group-popover-member">${esc(f)}</div>`).join('');
      peers.hidden = false;
    }

    /**
     * Hide the peers hover popover.
     * @returns {void}
     */
    function hidePeers() {
      const peers = el('peers');
      if (peers) peers.hidden = true;
    }

    /**
     * Whether an event happened inside this control's root. Composed path
     * first (correct through re-rendered inner nodes, #566), then an ancestor
     * walk for environments without it.
     * @param {object} e - DOM event.
     * @returns {boolean}
     */
    function insideControl(e) {
      const control = el('control');
      if (!control) return false;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
      if (path && path.length) return path.includes(control);
      let node = e.target;
      while (node) {
        if (node === control) return true;
        node = node.parentNode;
      }
      return false;
    }

    /**
     * Bind the control's handlers once: heads = toggle, hover = peers, badge =
     * inbox, the panel's delegated ✕ (its innerHTML re-renders on each open),
     * Escape, and outside-click dismissal. Idempotent on BINDING, like the
     * Master bar's mount: a page may mount at load and again when a surface
     * opens, and a second bind would double every handler.
     * @returns {boolean} True when the control is present in the document.
     */
    function mount() {
      const control = el('control');
      if (!control) return false;
      if (bound) return true;
      bound = true;
      const heads = el('heads');
      if (heads) {
        heads.addEventListener('click', toggle);
        heads.addEventListener('mouseenter', showPeers);
        heads.addEventListener('mouseleave', hidePeers);
      }
      const badge = el('badge');
      if (badge) badge.addEventListener('click', openInbox);
      const panel = el('panel');
      if (panel) {
        panel.addEventListener('click', (e) => {
          const t = e.target;
          if (t && typeof t.closest === 'function' && t.closest('.medusa-panel-close')) closeInbox();
        });
      }
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          const p = el('panel');
          if (p && !p.hidden) closeInbox();
        });
        doc.addEventListener('click', (e) => {
          if (insideControl(e)) return;
          closeInbox();
          hidePeers();
        });
      }
      return true;
    }

    return {
      state: m, mount, render, poll, applyStatus, toggle, openInbox, closeInbox,
      showPeers, hidePeers, flowInbound, flowOutbound, stateLabel, helpText, renderMessages
    };
  }


  /**
   * Markup for one Master control bar.
   *
   * Pure, so a test can assert the shape without a DOM, and so both surfaces
   * provably render the same string for the same inputs.
   *
   * Every id is prefixed. Both surfaces can be present in one document — the
   * dashboard panel and, on the session page, the drawer — and an unprefixed id
   * would mean `getElementById` returning the one the operator cannot see,
   * which presents as "the control does nothing".
   *
   * Takes no label: `mount()` writes the resting status line, so a `title` here
   * would be a second place the same string could come from — and it was already
   * dead, computed and never interpolated.
   *
   * @param {string} p - Id prefix, unique per surface.
   * @returns {string} The bar's inner HTML.
   */
  function tcMasterControlBarMarkup(p) {
    // The access toggle is REAL BUTTONS, not spans with a click handler.
    // Buttons are keyboard-operable, focusable and announced as pressable for
    // free; a span pretending to be a control has to re-implement all three and
    // usually re-implements two. `aria-pressed` rather than a radio group
    // because these are two states of one setting the operator toggles between,
    // and the pressed state is what a screen reader reads out.
    //
    // The segments are ≥44px per the mobile Direction in
    // `nonfunctional-requirements.md`, which binds and carries no exception for
    // this surface. That makes the row carrying them taller, and #768's chunk 3
    // owns the collapse rule that answers it for the bar's other eight controls
    // — this control does not get to ship under the minimum while waiting for
    // that decision.
    //
    // The segments are joined with `''` and the surrounding tags close tight
    // against them. They are inline-flex children of a bordered group, so any
    // whitespace between them renders as a visible gap inside the control's own
    // border.
    //
    // `disabled` AND `aria-disabled` — the first stops the press, the second is
    // what assistive tech announces. A hint element carries the reason so it is
    // not locked inside a `title` tooltip that touch devices never show.
    const pend = (key, cls, label) =>
      `<button type="button" class="${cls} master-bar-pending" id="${p}${key}Btn" disabled`
      + ` aria-disabled="true" aria-describedby="${p}${key}Why" title="${TC_MASTER_PENDING[key.toLowerCase()]}"`
      + `>${label}</button><span class="sr-only" id="${p}${key}Why">${TC_MASTER_PENDING[key.toLowerCase()]}</span>`;

    return `
      <span class="master-dot" id="${p}Dot" aria-hidden="true"></span>
      <span class="master-status-text" id="${p}StatusText"></span>
      <span class="master-bar-model" id="${p}Model" hidden></span>
      ${tcMedusaControlMarkup(tcMedusaIds(p))}
      <button class="btn btn-small hidden" id="${p}RetryBtn">Retry</button>
      <span class="master-bar-spacer"></span>
      <span class="master-bar-enforcement" id="${p}Enforce" hidden></span>
      <span class="master-access-toggle" id="${p}Access" role="group"
            aria-label="Master access level">${TC_MASTER_ACCESS_SEGMENTS.map((seg) =>
    `<button type="button" class="master-access-seg" id="${p}${seg.suffix}" aria-pressed="false">${seg.label}</button>`).join('')}<span class="master-access-other" id="${p}AccessOther" hidden></span>
      </span>
      ${pend('Upload', 'banner-btn', 'Upload')}
      <button class="banner-btn" id="${p}SettingsBtn"
              aria-label="Master settings" title="Master settings">&#9881;</button>
      ${pend('Wrap', 'banner-btn btn-wrap', 'Wrap')}
      <button type="button" class="banner-btn btn-launch hidden" id="${p}LaunchBtn"
              title="Start a fresh Master session. Its memory/ files survive; the conversation does not.">Launch</button>
      <button type="button" class="banner-btn btn-kill" id="${p}KillBtn"
              title="Stop the Master session. Its memory/ files survive; the conversation does not.">Kill</button>
      <span class="master-bar-error" id="${p}Error" role="status" hidden></span>
      <span class="master-bar-warn" id="${p}Warn" role="status" hidden></span>`;
  }

  /**
   * Create a Master control bar bound to one surface.
   *
   * @param {object} deps
   * @param {Document} deps.doc - The page document.
   * @param {string} deps.rootId - Id of the element to render into.
   * @param {string} deps.prefix - Id prefix for this surface's controls.
   * @param {string} [deps.title] - Label beside the status dot.
   * @param {Function} [deps.onRetry] - Called when Retry is pressed.
   * @param {Function} [deps.onOpenSettings] - Called when the gear is pressed.
   * @param {Function} [deps.apiMutate] - `(path, method, body)` — required for
   *   the access toggle; without it the segments are inert rather than pretending.
   * @param {Function} [deps.confirm] - Confirmation prompt; defaults to the
   *   window's. Injected so the READ→WRITE warning is assertable without a
   *   browser dialog, which would block the whole page.
   * @returns {{mount: Function, setStatus: Function, setModel: Function, setError: Function,
   *            setWarning: Function, setAccess: Function, loadAccess: Function, loadModel: Function}}
   */
  function tcCreateMasterControlBar(deps) {
    const doc = deps.doc || global.document;
    const p = deps.prefix;
    let bound = false;
    // The last SERVER state the access controls were painted from. Held so
    // `setBusy` can re-derive whether the segments should be pressable instead
    // of blanket-enabling them when a request finishes — a bar whose status
    // could not be read must stay inert.
    let access = null;
    let busy = false;

    const el = (suffix) => doc.getElementById(p + suffix);

    // The Master's Medusa control (#996) — the SAME component the session
    // banner mounts, pointed at the Master's API base and prefixed ids. It
    // paints from the `medusa` field of `/api/master/status` (see `setMedusa`)
    // so the bar's one status fetch feeds it; its own poll is never started
    // here — this bar has no tick of its own, and the drawer's host poll calls
    // `loadAccess()` while the drawer is open.
    const medusa = tcCreateMedusaControl({
      doc,
      api: deps.api,
      esc: deps.esc,
      apiBase: '/api/master/medusa',
      ids: tcMedusaIds(p),
      subject: 'the Master'
    });

    /**
     * Render into the root, and bind once.
     *
     * Idempotent by the same rule as the settings modal: a page may mount at
     * load and again when something opens the surface, and a second render
     * would orphan the first's listeners. Re-mounting refreshes nothing because
     * nothing here is stateful between mounts — the guard is on BINDING, which
     * is what would double.
     *
     * @returns {boolean} True when the bar is present after this call.
     */
    function mount() {
      const root = doc.getElementById(deps.rootId);
      if (!root) return false;
      if (!el('SettingsBtn')) root.innerHTML = tcMasterControlBarMarkup(p);
      if (bound) return true;
      bound = true;
      const gear = el('SettingsBtn');
      if (gear && deps.onOpenSettings) gear.addEventListener('click', deps.onOpenSettings);
      const retry = el('RetryBtn');
      if (retry && deps.onRetry) retry.addEventListener('click', deps.onRetry);
      // The segment table is the single declaration: the id comes from
      // `spec.suffix` and the level it stands for from `spec.level`, so the two
      // cannot come apart. Deliberately NOT a `data-access` attribute read back
      // off the DOM — that round-trip looks like single-sourcing and instead
      // leaves a control that renders fine and does nothing the moment the
      // renderer stops emitting the attribute. (An earlier draft of this comment
      // described the attribute design that was rejected, which read as an
      // instruction to go looking for a contract that does not exist.)
      for (const spec of TC_MASTER_ACCESS_SEGMENTS) {
        const seg = el(spec.suffix);
        if (seg) seg.addEventListener('click', () => flip(spec.level));
      }
      const launch = el('LaunchBtn');
      if (launch && deps.onRetry) launch.addEventListener('click', deps.onRetry);
      const kill = el('KillBtn');
      if (kill) kill.addEventListener('click', killMaster);
      medusa.mount();
      // Establish the resting state in CODE rather than leaning on the markup's
      // attributes. The component then owns its own initial appearance, which
      // means one source for "what does this say before anything answers"
      // instead of a string in the template and a second in the first paint.
      setStatus('', (deps.title || 'Project Master') + ' · checking…', false);
      setError('');
      setWarning('');
      setModel(null, null);
      // Inert until a status answers. The alternative is a control that looks
      // like it is telling you the level before anything has said what it is.
      setAccess(null);
      return true;
    }

    /**
     * Paint the status dot, its text, and the Retry affordance.
     *
     * @param {string} status - 'live' | 'pending' | 'down' | '' (unknown).
     * @param {string} [text] - Status line.
     * @param {boolean} [showRetry] - Reveal Retry.
     * @returns {void}
     */
    function setStatus(status, text, showRetry) {
      const dot = el('Dot');
      if (dot) {
        dot.classList.remove('live', 'pending', 'down');
        if (status) dot.classList.add(status);
      }
      const t = el('StatusText');
      if (t && text !== undefined) t.textContent = text;
      const retry = el('RetryBtn');
      if (retry) retry.classList.toggle('hidden', !showRetry);

      const kill = el('KillBtn');
      const launch = el('LaunchBtn');
      if (kill && launch) {
        if (status === 'down') {
          kill.classList.add('hidden');
          launch.classList.remove('hidden');
        } else if (status === 'live' || status === '') {
          kill.classList.remove('hidden');
          launch.classList.add('hidden');
        }
      }
    }

    /**
     * Paint the model pill from a `/api/models/status` entry.
     *
     * Mirrors the session banner: a status dot AND a pill-level class for
     * non-operational states, because a 6px dot alone is not a signal an
     * operator catches in passing, and colour alone is not one every operator
     * can catch at all. Hidden entirely when the model is unknown — an empty
     * pill would assert a model we cannot name.
     *
     * @param {{status?: string, message?: string, error?: string}|null} st - Status entry.
     * @param {string} [label] - Model name to show.
     * @returns {void}
     */
    function setModel(st, label) {
      const pill = el('Model');
      if (!pill) return;
      if (!label) { pill.hidden = true; return; }
      pill.hidden = false;
      pill.className = pill.className.replace(/\bengine-pill-\S+/g, '').trim();
      const state = (st && st.status) || 'unknown';
      if (state !== 'operational') pill.classList.add('engine-pill-' + state);
      pill.textContent = label;
      const d = doc.createElement('span');
      d.className = 'engine-status-dot engine-status-' + state;
      pill.prepend(d);
      pill.title = (st && st.error) ? `Status unknown: ${st.error}`
        : ((st && st.message) || state).replace(/_/g, ' ');
    }

    /**
     * Show or clear a failure the operator would otherwise not see.
     *
     * This is what chunk 1's review asked for. The session page mounted the
     * settings modal with an `onOpenError` that only reached the console —
     * honest, but invisible, so a Master whose status fetch failed looked
     * exactly like a gear that does nothing.
     *
     * @param {string} [message] - The failure; omit or pass empty to clear.
     * @returns {void}
     */
    function setError(message) {
      const box = el('Error');
      if (!box) return;
      box.textContent = message || '';
      box.hidden = !message;
    }

    /**
     * Show or clear a STANDING condition — as opposed to `setError`, which
     * reports something that just failed.
     *
     * Two elements rather than one because they have different lifetimes. The
     * error line is cleared whenever the operator does something that could
     * have fixed it (opening the gear clears it), and a degraded write guard is
     * not fixed by opening the gear — folding it into `setError` would make the
     * boundary warning disappear on the next unrelated click. It takes its own
     * wrapped line for the same reason the error does: squeezed onto the end of
     * a nine-control row it would be effectively invisible.
     *
     * @param {string} [message] - The condition; omit or pass empty to clear.
     * @returns {void}
     */
    function setWarning(message) {
      const box = el('Warn');
      if (!box) return;
      box.textContent = message || '';
      box.hidden = !message;
    }

    /**
     * Paint the access toggle, the enforcement badge and the degraded warning
     * from a `/api/master/status` settings payload.
     *
     * SERVER STATE ONLY. There is exactly one Master — `MASTER_TMUX_SESSION` is
     * a single reserved tmux session and every drawer attaches the same iframe —
     * so a bar that painted from its own click would show one operator a level
     * another surface had already changed. Nothing here reads the click; `flip`
     * calls this with what the server said, both before and after.
     *
     * The `suggest` tier has no segment, and that is deliberate: #768 ratified a
     * two-segment bar as the fast path with the gear as the complete control.
     * So at `suggest` NEITHER segment is pressed and a non-interactive readout
     * names the level. An unpressed pair on its own would leave a touch operator
     * with no visible reason — `title` never appears on touch, and this install
     * is driven from a phone.
     *
     * @param {object|null} settings - `settings` from `/api/master/status`, or
     *   null when the status could not be read.
     * @returns {void}
     */
    function setAccess(settings) {
      const group = el('Access');
      const other = el('AccessOther');
      const badge = el('Enforce');
      if (!group) return;

      const level = settings ? settings.accessLevel : null;
      access = settings || null;

      for (const spec of TC_MASTER_ACCESS_SEGMENTS) {
        const btn = el(spec.suffix);
        if (!btn) continue;
        const on = spec.level === level;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('is-on', on);
        // Unknown level → nothing to flip TO that we can describe honestly, so
        // the control is inert rather than guessing. A status we could not read
        // is not the same as a level of read-only.
        btn.disabled = !level || busy;
      }
      // PENDING, not in force. On an instructional master the level travels in
      // the regenerated identity, so a flip does not bind until the next ensure —
      // and the toggle would otherwise paint the new level as though it already
      // had. Returning to read-only is where that bites: the operator sees READ
      // pressed while the master's identity still grants write, and nothing on
      // the surface says so. State-based rather than fired after a flip, because
      // on those engines the toggle NEVER binds immediately; a permanent honest
      // note beats a control that quietly overstates.
      const pending = Boolean(settings) && settings.levelAppliesAt !== 'next-tool-call';
      group.classList.toggle('is-write', level === 'write');
      group.classList.toggle('is-pending', pending);
      group.classList.toggle('is-degraded', Boolean(settings && settings.guardDegraded));
      // The accessible name carries the LEVEL, not just the control's purpose.
      // Without it a screen-reader user at `suggest` hears two unpressed buttons
      // and no way to learn which tier is in force — and on an instructional
      // master, no way to learn that the level shown is not yet the one running.
      group.setAttribute('aria-label', level
        ? `Master access level: ${level}${pending ? ', applies when the master next starts' : ''}`
        : 'Master access level: unknown');

      if (other) {
        // "A level no segment stands for" — read off the table rather than
        // re-listing the two, so adding a segment later cannot leave the readout
        // announcing a tier the bar now has a button for.
        const named = Boolean(level) && !TC_MASTER_ACCESS_SEGMENTS.some((seg) => seg.level === level);
        other.hidden = !named;
        other.textContent = named ? String(level).toUpperCase() : '';
      }

      if (badge) {
        const tier = settings && settings.enforcement;
        badge.hidden = !tier;
        badge.textContent = tier || '';
        // The gap this closes predates #755: the badge vocabulary existed in the
        // modal only, so a Gemini Master and a Claude Master looked identical on
        // the bar — and read-only is already unenforced on the instructional
        // one. The class carries the distinction too, because colour alone is
        // not a signal every operator can catch.
        badge.classList.toggle('is-instructional', tier === 'instructional');
        badge.title = tier === 'instructional'
          ? 'This engine cannot be structurally bounded — the boundary is rules-only, carried in the master’s identity.'
          : 'A write guard reads the level on every tool call, plus permission rules regenerated on every master start.';
      }

      // Worst-first, one line. A degraded guard outranks a pending one — "nothing
      // is enforcing" is not softened by "and it would arrive at the next start"
      // — and an unreadable status outranks nothing because there is no posture
      // to describe at all. The bare dimmed pair with no sentence was its own
      // small version of the defect this chunk is about: a control saying
      // nothing, where an operator reads "broken" or "read-only" at random.
      if (!settings) {
        setWarning('The Master’s status could not be read, so its access level is unknown — the toggle is inactive until it answers.');
      } else if (settings.identityStale === true) {
        // Ranked ABOVE the guard posture on purpose. A degraded guard is a
        // boundary that is not holding; a stale identity is the Master not
        // acting on the level at all — which is the state an operator hits
        // first, and the one that reads as "the toggle did nothing" (#968).
        // The date is what makes it actionable rather than a shrug: a session
        // started weeks ago has missed every rule and scope change since.
        setWarning('NOT IN EFFECT — the running Master started before these instructions were written'
          + (settings.identityWrittenAt ? ` (${_tcShortDate(settings.identityWrittenAt)})` : '')
          + ', and reads them only at launch. Restart it to apply.');
      } else if (settings.guardDegraded) {
        const tag = TC_MASTER_GUARD_DEGRADED[settings.guardDegradedCode];
        setWarning((tag ? tag + ' — ' : '') + settings.guardDegradedReason);
      } else if (settings.identityStale === null) {
        // BELOW `guardDegraded`, deliberately. An UNKNOWN must never suppress a
        // CONFIRMED "nothing is enforcing" — the first ordering here put this
        // branch above it, so a tmux that would not answer hid a boundary that
        // was measurably absent. Unknown outranks only the healthy states.
        setWarning('Could not confirm the running Master has picked up its current instructions — tmux did not answer.');
      } else if (pending) {
        // THREE states, not two — the same split `bindsAt` and `writeWarningText`
        // make, and for the same reason. `pending` is true both when the server
        // SAID `next-ensure` and when the field is absent (payload skew), and
        // only the first of those licenses naming the mechanism. Printing the
        // instructional sentence on an absent field tells a Claude master it has
        // no write guard, which is the false claim R-6 removed from the other two
        // call sites — and this branch reintroduced it two functions away, which
        // is what "one call site is not the family" looks like in practice.
        setWarning(settings.levelAppliesAt === 'next-ensure'
          ? 'This engine carries the access level in the master’s instructions rather than a write guard, so a change here applies the next time the master session starts.'
          : 'A change here applies the next time the master session starts.');
      } else {
        setWarning('');
      }
    }

    /**
     * The confirmation shown on the way IN to `write`.
     *
     * Built from the SERVER's `levelAppliesAt` rather than asserting "its next
     * tool call": that promise is the structural answer, and on an instructional
     * master the level travels in the regenerated identity, so it arrives with
     * the next ensure. The settings modal already learned this the hard way
     * (#755 chunk 2 / R-4) and reads the same field.
     *
     * Says GLOBAL, which the blast-radius wording it grew out of did not: that
     * sentence was right about reach ("every project it can reach") and silent
     * about scope, and scope is the half an operator flipping from one session's
     * drawer would guess wrong.
     *
     * @param {object} settings - `settings` from `/api/master/status`.
     * @returns {string} The confirmation text.
     */
    function writeWarningText(settings) {
      // Same three states as the modal's hint, and for the same reason: the
      // unknown case must not assert a mechanism. See `bindsAt` above.
      const binds = settings && settings.levelAppliesAt === 'next-tool-call'
        ? 'The write guard binds on the Master’s next tool call. The RUNNING Master keeps the instructions it started with, so restart it or it will go on refusing writes it is now allowed to make.'
        : settings && settings.levelAppliesAt === 'next-ensure'
          ? 'It arrives the next time the master session starts, since this engine carries the level in its instructions rather than a write guard.'
          : 'It arrives the next time the master session starts.';
      return 'Give the Project Master WRITE access?\n\n'
        + 'There is exactly one Master, so this changes it EVERYWHERE — every session drawer '
        + 'and the dashboard, not just this one.\n\n'
        + 'It will be able to modify files across every project it can reach, without asking you first. '
        + binds;
    }

    /**
     * Move the Master to a level, from a press on one of the segments.
     *
     * The order is the contract, and every step of it answers a way this went
     * wrong before:
     *
     * 1. **Re-fetch first.** A flip must never act on a value another surface
     *    changed. This is the dangerous half of staleness and it is closed here
     *    rather than with a poll — the dashboard has no timer and is not getting
     *    one (#98/#268 governs timer-driven lifecycle, and a repaint-on-open
     *    page needs no clock).
     * 2. **Repaint from that fetch before deciding anything.** If the bar was
     *    stale, the operator now sees the truth, and a press that has become a
     *    no-op stops there instead of re-asserting a level nobody asked for.
     * 3. **Warn only on the way IN.** Returning to read-only is always the safe
     *    direction; warning there trains the operator to click through.
     * 4. **PATCH, then read the status back.** Painting from the click is what
     *    this whole control is forbidden to do. Reading back is stronger than
     *    painting from the PATCH response: it is the only thing that can tell
     *    the operator the guard actually took the change, which is exactly the
     *    invisibility R-15 exists to remove.
     *
     * @param {string} level - The level the pressed segment stands for.
     * @returns {Promise<void>}
     */
    async function flip(level) {
      // A second press while the first is in flight would send a second PATCH
      // and paint whichever status answered last — a race whose visible symptom
      // is the toggle settling on a level nobody chose.
      if (busy || !deps.api || !deps.apiMutate) return;
      busy = true;
      setBusy(true);
      try {
        setError('');
        const fresh = await deps.api('/api/master/status');
        if (!fresh || !fresh.settings) {
          setError('Could not read the Master’s current access level, so nothing was changed.');
          return;
        }
        setAccess(fresh.settings);
        if (fresh.settings.accessLevel === level) return;

        if (level === 'write') {
          const ask = deps.confirm || global.confirm;
          // NO CONFIRMATION AVAILABLE MEANS NO WRITE. The obvious spelling of
          // this — `if (typeof ask === 'function' && !ask(...)) return;` — reads
          // as "warn before granting write" and does the opposite when there is
          // nothing to warn with: the check evaluates false and the flip carries
          // straight on to fleet-wide write access, unconfirmed.
          //
          // That is this issue's recurring defect in a new costume: a bound that
          // fails OPEN while reading as though it fails closed. Chunk 2 found
          // five of them. The test for any guard here is what happens when the
          // GUARD fails, and "it proceeds with the value it was computing" is an
          // allow.
          if (typeof ask !== 'function') {
            setError('The Master’s access level was not changed: this page cannot show the confirmation that granting write access requires.');
            return;
          }
          if (!ask(writeWarningText(fresh.settings))) return;
        }

        const saved = await deps.apiMutate('/api/config', 'PATCH', { master: { accessLevel: level } });
        if (!saved) {
          // The toggle is already sitting on the re-fetched truth, which is where
          // a failed change must leave it — the level did not move, so neither
          // does the control.
          setError((deps.api && deps.api.lastError) || 'The access level could not be changed.');
          return;
        }

        const after = await deps.api('/api/master/status');
        if (after && after.settings) {
          setAccess(after.settings);
        } else {
          // Saved, but unreadable. Painting the new level would be the optimistic
          // paint this control exists to avoid, and painting the old one would be
          // false — so say what is actually known and leave the control alone.
          setError('The change was saved, but the Master’s state could not be read back — reopen to confirm it.');
        }
      } finally {
        busy = false;
        setBusy(false);
      }
    }

    /**
     * Disable or re-enable the segments while a flip is in flight.
     *
     * Re-derives from the last painted server state rather than blanket-enabling,
     * so a bar whose status could not be read stays inert after a failed flip
     * instead of becoming pressable because a request finished.
     *
     * @param {boolean} on - True while a flip is running.
     * @returns {void}
     */
    function setBusy(on) {
      const group = el('Access');
      if (group) group.classList.toggle('is-busy', on);
      for (const spec of TC_MASTER_ACCESS_SEGMENTS) {
        const btn = el(spec.suffix);
        if (btn) btn.disabled = on || !access || !access.accessLevel;
      }
      // Kill too. It shares the same in-flight latch, so leaving it pressable
      // meant the latch silently did the work a disabled control should be
      // doing — and the operator got no feedback that the first press was
      // still running. Unlike the segments it does not depend on a known level:
      // stopping a Master whose status could not be read is still meaningful.
      const kill = el('KillBtn');
      if (kill) kill.disabled = on;
      const launch = el('LaunchBtn');
      if (launch) launch.disabled = on;
    }

    /**
     * Stop the Master session.
     *
     * The remedy the access toggle needs: a level change binds on the guard at
     * once, but the running Master reads its instructions only at launch, so it
     * has to restart before it will ACT on the new level (#968). The bar says
     * when that is true; this is the control that fixes it.
     *
     * Confirmed, because it is destructive and GLOBAL — there is exactly one
     * Master, so this stops it for every session drawer and the dashboard, not
     * just this surface. The confirmation names what is lost and what is not:
     * the Master's durable notes under `memory/` are a data directory and
     * survive; the conversation does not, which is the point of restarting.
     *
     * Repaints the ACCESS controls from server state afterwards, never from the
     * click — the same rule the toggle follows. The status line and dot are
     * painted here directly, because `loadAccess` only reaches `setAccess`; an
     * earlier version of this sentence claimed the whole bar repainted, which
     * was not true of either.
     *
     * @returns {Promise<void>}
     */
    async function killMaster() {
      if (busy || !deps.apiMutate) return;
      busy = true;
      setBusy(true);
      try {
        setError('');
        const ask = deps.confirm || global.confirm;
        // NO CONFIRMATION MEANS NO KILL. The same fail-closed shape the write
        // grant uses: a check written as `typeof ask === 'function' && !ask(...)`
        // reads as "confirm before stopping it" and stops it silently when there
        // is nothing to confirm with.
        if (typeof ask !== 'function') {
          setError('The Master was not stopped: this page cannot show the confirmation that requires.');
          return;
        }
        if (!ask('Stop the Project Master?\n\n'
          + 'There is exactly one Master, so this stops it EVERYWHERE — every session drawer and '
          + 'the dashboard.\n\n'
          + 'Its durable notes under memory/ survive. The conversation it is holding does not — '
          + 'which is what restarting it is for. Reopening the drawer starts it again.')) return;

        const result = await deps.apiMutate('/api/master/kill', 'POST', {});
        if (!result) {
          setError((deps.api && deps.api.lastError) || 'The Master could not be stopped.');
          return;
        }
        // Worded from `killed`, not `wasRunning`, and this is DEFENSIVE rather than
        // load-bearing — said plainly because a comment claiming otherwise would
        // be the kind of false confidence this issue is about. Under the route's
        // current contract the two cannot differ in a 200: a confirmed kill is
        // `{killed: true, wasRunning: true}`, an absent master is both false, and
        // the case where they diverge — running, but tmux would not confirm — is
        // a 500 that lands in the error branch above and never reaches here.
        // Mutating this line therefore changes nothing observable, which was
        // measured, not assumed. It reads from `killed` anyway because that is
        // the field that MEANS "this call stopped it", so a future 200 carrying
        // an unconfirmed kill would word itself correctly instead of quietly.
        // The property that IS testable — a refusal never reading as a stop — is
        // pinned by 'an UNCONFIRMED kill is not reported as "Master stopped"'.
        setStatus('', result.killed ? 'Master stopped' : 'Master was not running', true);
        // From the server, not from the fact that a kill returned 200 — the same
        // discipline as the toggle. A repaint is also how the stale-identity
        // warning clears, since a fresh session reads the current instructions.
        await loadAccess();
      } finally {
        busy = false;
        setBusy(false);
      }
    }

    /**
     * Fetch the Master's status and paint the access controls from it.
     *
     * The surfaces call this at the moments they have: the dashboard on open and
     * on ensure, the session page on its existing poll tick. Neither gets a new
     * timer.
     *
     * @returns {Promise<void>}
     */
    async function loadAccess() {
      if (!deps.api) return;
      const status = await deps.api('/api/master/status');
      setAccess(status && status.settings ? status.settings : null);
      setMedusa(status && status.medusa ? status.medusa : null);
    }

    /**
     * Paint the Medusa control from the `medusa` field of `/api/master/status`
     * (#996). Null — the status could not be read — leaves the control as it
     * was rather than painting an `off` nobody measured, the same rule
     * `setAccess(null)` follows for the segments.
     * @param {object|null} status - `medusa` from `/api/master/status`, or null.
     * @returns {void}
     */
    function setMedusa(status) {
      if (!status) return;
      medusa.applyStatus(status);
    }

    /**
     * Fetch the model's health and paint the pill.
     *
     * The bar owns this rather than each page fetching and calling `setModel`,
     * because two callers is how the dashboard and the session came to disagree
     * about everything else this chunk had to reunify. `engineId` comes from the
     * Master's own status — the Master runs one engine, and which one is a fact
     * about the Master, not about the page looking at it.
     *
     * @param {string|null} engineId - The Master's engine, or null if unknown.
     * @returns {Promise<void>}
     */
    async function loadModel(engineId) {
      if (!engineId || !deps.api) { setModel(null, null); return; }
      const data = await deps.api('/api/models/status');
      // A failed fetch is not "operational" — paint the label with an unknown
      // state rather than implying health nobody measured.
      const st = (data && data.status && data.status[engineId]) || null;
      setModel(st, engineId);
    }

    return { mount, setStatus, setModel, setError, setWarning, setAccess, setMedusa, loadAccess, loadModel, killMaster, medusa };
  }

  /**
   * CSS class for one startup-rule delivery outcome in the deliveries panel.
   *
   * A named function rather than a ternary inline in the panel's template so a
   * test can drive it over the ledger's whole vocabulary: this map went a full
   * release with `unverified` handled and every other value falling through to
   * an unstyled string, and a value it has not been taught renders as text that
   * reads like a pass.
   *
   * The default is therefore `warn`, not blank. The ledger's only worth is that
   * its rows can be trusted as evidence; a row nobody classified is not
   * evidence of success, and `written` (#1063) — shards on disk, engine hook
   * never confirmed — is precisely the row that used to render green.
   *
   * @param {string} outcome - A `session_rule_deliveries.outcome` value.
   * @returns {string} A `rules-status-*` class, or '' for the one outcome that
   *   is genuinely neutral (`no-rules`: nothing was owed).
   */
  function tcDeliveryOutcomeClass(outcome) {
    if (outcome === 'delivered') return 'rules-status-ok';
    if (outcome === 'skipped') return 'rules-status-err';
    if (outcome === 'no-rules') return '';
    return 'rules-status-warn';
  }

  /**
   * The launch modes an engine will actually run, in declaration order.
   *
   * Every browser surface that offers a launch mode reads this: the landing
   * page's per-launch picker and the gate that decides to open it, the settings
   * modal's default-mode dropdown, and the create flow's Launch Posture. They
   * are one question, and a surface that answers it differently offers the
   * operator a mode another surface will not accept.
   *
   * `disabled !== true` rather than `!disabled`, matching the server's
   * `honorsLaunchMode` (`lib/engines.js`): the two are the same predicate on
   * either side of a process boundary that cannot be bridged — `public/` runs
   * in a browser, `lib/` is CommonJS, and this project has no build step.
   * `test/launch-mode-picker.test.js` asserts the two agree over every bundled
   * profile, so the copy stays a boundary instead of drifting into a variant.
   *
   * @param {object|null} engine - Engine object or profile with `launchModes`
   * @returns {Array<[string, object]>} Honored `[key, mode]` pairs
   */
  function tcHonoredLaunchModes(engine) {
    const modes = engine && engine.launchModes;
    if (!modes) return [];
    return Object.entries(modes).filter(([, mode]) => mode && mode.disabled !== true);
  }

  /**
   * The shipped defaults the disposition compares a stored value against.
   *
   * Restated from `lib/project-config.js` (`DEFAULT_PROJECT_CONFIG`) for the
   * same reason the predicate below is restated: `public/` runs in a browser
   * and this project has no build step. `test/setting-disposition.test.js`
   * asserts each entry equals the shipped default it names, so a changed
   * default fails rather than silently making the browser call a real choice a
   * default (or the reverse).
   */
  const TC_SETTING_DEFAULTS = {
    silentPrime: true,
    defaultLaunchMode: 'default',
    evalAuditMode: false
  };

  /**
   * How a setting's value is read out of a project config, where it is not
   * simply `config[setting]`. `evalAuditMode` holds its flag inside an object
   * of tunables, and provenance is a scalar comparison — an object is never
   * `!==`-equal to its own default. Mirrors the server table's `read`.
   */
  const TC_SETTING_READERS = {
    evalAuditMode: (cfg) => (cfg && cfg.evalAuditMode ? cfg.evalAuditMode.enabled : undefined)
  };

  /**
   * Whether an engine-conditional setting applies to a project, and what to
   * say when it does not (ADR 0013).
   *
   * The browser half of `engines.settingDisposition` (`lib/engines.js`). Every
   * surface that offers one of these settings needs the same two answers — is
   * this control live here, and what does the operator read when it is not —
   * and a surface that answers differently tells the operator something the
   * server does not believe. The reason text is as much of that boundary as
   * the boolean: `test/setting-disposition.test.js` asserts the two agree,
   * field for field, over every bundled profile.
   *
   * @param {string} setting - `silentPrime` or `defaultLaunchMode`.
   * @param {object|null} projConfig - Project config or record carrying the value.
   * @param {object|null} engine - Engine object or profile.
   * @returns {{setting: string, value: *, applies: boolean, chosen: boolean,
   *   reason: string|null, evidence: string|null, level: string|null}}
   */
  function tcSettingDisposition(setting, projConfig, engine) {
    const name = tcEngineDisplayName(engine);
    const reader = TC_SETTING_READERS[setting];
    const has = projConfig && Object.prototype.hasOwnProperty.call(projConfig, setting);
    const stored = reader ? reader(projConfig) : (has ? projConfig[setting] : undefined);
    const shipped = TC_SETTING_DEFAULTS[setting];
    const chosen = stored !== undefined && stored !== shipped;
    const value = stored === undefined ? shipped : stored;
    let applies;
    let reason = null;
    let evidence = null;

    // No profile is not evidence that a capability is absent. Mirrors the
    // server: an engine TangleClaw holds no profile for gets "cannot say",
    // never a stated fact about a flag nobody read.
    if (!engine) {
      return {
        setting,
        value,
        applies: false,
        chosen,
        reason: 'TangleClaw has no profile for this engine, so it cannot say whether this setting applies here.',
        evidence: 'no engine profile',
        level: chosen ? 'warn' : 'info'
      };
    }

    if (setting === 'silentPrime') {
      applies = Boolean(engine && engine.capabilities
        && engine.capabilities.supportsSilentPrime === true);
      if (!applies) {
        reason = name + ' does not deliver a hidden prime, so this setting has no effect on this project.';
        evidence = 'capabilities.supportsSilentPrime is not true';
      }
    } else if (setting === 'evalAuditMode') {
      // Scored exchanges arrive over an OpenClaw connection bound to this
      // project — the only write path there is. Mirrors the server.
      applies = Boolean(engine && typeof engine.id === 'string' && engine.id.indexOf('openclaw:') === 0);
      if (!applies) {
        reason = name + ' does not feed Eval Audit — scored exchanges arrive over an OpenClaw connection bound to this project, so nothing would be scored here.';
        evidence = 'audit ingestion authenticates an OpenClaw connection and resolves the project by openclaw:<connectionId>';
      }
    } else if (setting === 'defaultLaunchMode') {
      // `'default'` is the absence of a mode, not one an engine must declare —
      // mirrors the server, where asking the honored-modes predicate about it
      // produced a reason that contradicted itself.
      applies = value === 'default'
        || tcHonoredLaunchModes(engine).some(([key]) => key === value);
      if (!applies) {
        // Declared AND switched off. A key holding nothing usable was never
        // offered, so calling it "disabled" would send the operator looking
        // for a switch that does not exist. Mirrors `_modeDisabledHere`.
        const modes = engine && engine.launchModes;
        const declared = Boolean(modes && typeof value === 'string'
          && Object.prototype.hasOwnProperty.call(modes, value)
          && modes[value] && modes[value].disabled === true);
        const label = typeof value === 'string' && value ? '"' + value + '"' : 'that launch mode';
        reason = declared
          ? name + ' has disabled the launch mode ' + label + ', so this project launches in its engine default instead.'
          : name + ' does not offer the launch mode ' + label + ', so this project launches in its engine default instead.';
        evidence = declared ? 'mode is disabled' : 'engine does not define this mode';
      }
    } else {
      // Unknown key: the server throws rather than answering "it applies",
      // because a silent yes is the no-op this mechanism exists to end. The
      // browser cannot afford to break a render, so it fails closed the other
      // way — the control is inert and says it could not be judged.
      return {
        setting, value: stored, applies: false, chosen: false,
        reason: 'TangleClaw could not determine whether this setting applies to ' + name + '.',
        evidence: 'no engine gate declared for "' + setting + '"',
        level: 'info'
      };
    }

    return {
      setting,
      value,
      applies,
      chosen,
      reason,
      evidence,
      level: applies ? null : (chosen ? 'warn' : 'info')
    };
  }

  /**
   * How an engine is named to the operator — the profile's own `name` where it
   * has one, so a reason reads "Codex" rather than "codex". Restated from the
   * server's own display-name helper in `lib/engines.js`, which is internal to
   * that module.
   * @param {object|null} engine - Engine object or profile.
   * @returns {string}
   */
  function tcEngineDisplayName(engine) {
    if (!engine) return 'This engine';
    return engine.name || engine.id || 'This engine';
  }

  global.tcHonoredLaunchModes = tcHonoredLaunchModes;
  global.tcSettingDisposition = tcSettingDisposition;
  global.tcSettingDefaults = TC_SETTING_DEFAULTS;
  global.tcMedusaIds = tcMedusaIds;
  global.tcMedusaControlMarkup = tcMedusaControlMarkup;
  global.tcEscapeHtml = tcEscapeHtml;
  global.tcCreateMedusaControl = tcCreateMedusaControl;
  global.tcCreateChimeControl = tcCreateChimeControl;
  global.tcSettingsWarningsMarkup = tcSettingsWarningsMarkup;
  global.tcRenderSettingsWarnings = tcRenderSettingsWarnings;
  global.tcSetRulesStatus = tcSetRulesStatus;
  global.tcDeliveryOutcomeClass = tcDeliveryOutcomeClass;
  global.tcCreateMasterSettings = tcCreateMasterSettings;
  global.tcMasterPendingReasons = TC_MASTER_PENDING;
  global.tcMasterAccessSegments = TC_MASTER_ACCESS_SEGMENTS;
  global.tcMasterGuardDegradedLabels = TC_MASTER_GUARD_DEGRADED;
  global.tcMasterControlBarMarkup = tcMasterControlBarMarkup;
  global.tcCreateMasterControlBar = tcCreateMasterControlBar;
})(typeof window !== 'undefined' ? window : globalThis);
