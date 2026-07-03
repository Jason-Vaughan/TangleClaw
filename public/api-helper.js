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
      scrollAccum += deltaY;

      // Emit synthetic wheel events in line-sized batches. Constructed in
      // the IFRAME's realm and dispatched at the touch target so they bubble
      // into xterm's own 'wheel' listener exactly like a desktop wheel.
      const linesToScroll = Math.trunc(scrollAccum / LINE_HEIGHT);
      if (linesToScroll !== 0) {
        scrollAccum -= linesToScroll * LINE_HEIGHT;
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
   *   !== 'none'), and re-dispatches them with the platform's
   *   force-selection modifier — xterm's `shouldForceSelection` is
   *   `altKey && macOptionClickForcesSelection` on Mac and `shiftKey`
   *   everywhere else. xterm then runs its own local-selection machinery,
   *   so highlight, ✂ copy-on-select, and the #431 mouseup re-copy all
   *   come free. Real modifier gestures pass through untouched; so does
   *   right-click (context-menu copy) and everything when the app is NOT
   *   tracking the mouse (plain drag already selects locally there).
   *   Trade-off (documented in #445): while tracking, plain clicks/drags no
   *   longer reach the TUI — selection wins. `altClickMovesCursor` is
   *   forced off so rewritten clicks can't become arrow-key spam.
   *
   * - TOUCH: long-press (450ms, <12px slop) enters select mode — the
   *   finger drag is translated into the SAME synthetic modified mouse
   *   events, driving a real xterm selection; releasing dispatches the
   *   synthetic mouseup inside the touchend activation window, so the
   *   client-clipboard write is permitted. The touch-scroll shim (#443)
   *   yields while select mode is active (`doc.tcTouchSelectActive`).
   *
   * Synthetic events are tagged (`tcSynthetic`) and skipped by the
   * rewriter, so they can't loop. Idempotent per iframe document.
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
     * Clone a mouse event (or fabricate one from a touch point) with the
     * platform's force-selection modifier applied.
     * @param {string} type - Mouse event type to create.
     * @param {MouseEvent|Touch} src - Source event or touch point.
     * @param {number} [detail] - Click count (mouse clones carry theirs).
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
      const col = Math.max(0, Math.min(term.cols - 1,
        Math.floor((t.clientX - rect.left) / (rect.width / term.cols))));
      const row = Math.max(0, Math.min(term.rows - 1,
        Math.floor((t.clientY - rect.top) / (rect.height / term.rows))));
      const viewportY = (term.buffer && term.buffer.active) ? term.buffer.active.viewportY : 0;
      return { col, row: viewportY + row };
    }

    /**
     * Select from anchor to the current cell (either direction).
     * @param {{col: number, row: number}} from
     * @param {{col: number, row: number}} to
     */
    function applySelection(from, to) {
      let a = from;
      let b = to;
      if (b.row < a.row || (b.row === a.row && b.col < a.col)) {
        a = to;
        b = from;
      }
      const length = (b.row - a.row) * term.cols + (b.col - a.col) + 1;
      try {
        term.select(a.col, a.row, length);
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
      if (e.target === pill) return; // the pill's own tap must stay a click
      hidePill(); // any new terminal touch dismisses a pending pill
      if (e.touches.length !== 1) {
        cancelPress();
        return;
      }
      const t = e.touches[0];
      pressPoint = { clientX: t.clientX, clientY: t.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (!pressPoint) return;
        const cell = cellFromTouch(pressPoint);
        if (!cell) return;
        // Enter select mode: anchor + a one-cell selection as the visual cue.
        doc.tcTouchSelectActive = true;
        selectAnchor = cell;
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
    doc.addEventListener('touchend', endSelect, { passive: true });
    doc.addEventListener('touchcancel', endSelect, { passive: true });

    return true;
  }

  global.tcCreateApi = tcCreateApi;
  global.tcCreateApiMutate = tcCreateApiMutate;
  global.tcCopyToClipboard = tcCopyToClipboard;
  global.tcWireTerminalTouchScroll = tcWireTerminalTouchScroll;
  global.tcWireTerminalDragCopy = tcWireTerminalDragCopy;
})(typeof window !== 'undefined' ? window : globalThis);
