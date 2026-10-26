'use strict';

/**
 * W2-C session-page UI fixes: the wrapping pinwheel (#1317), removing
 * `#selectBtn` (#960), the mouse-mode toggle rollback on rejection (#1237),
 * and the mobile on-screen modifier key bar (#1638).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { liftDeclaration } = require('./helpers/lift');

const SESSION_CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.css'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
const SESSION_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
const API_HELPER_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

describe('#1317 the session header\'s wrapping dot is the same pinwheel the dashboard uses', () => {
  it('session.css defines .status-dot.wrapping with the pinwheel blades', () => {
    assert.match(SESSION_CSS, /\.status-dot\.wrapping\s*\{/, 'the wrapping dot needs a rule');
    const rule = SESSION_CSS.slice(SESSION_CSS.indexOf('.status-dot.wrapping {'));
    assert.match(rule.slice(0, 500), /conic-gradient/, 'the blades are what make it a pinwheel');
    assert.match(rule.slice(0, 500), /animation:\s*spin/, 'and it spins');
  });

  it('is no longer the old solid breathing dot', () => {
    const rule = SESSION_CSS.slice(SESSION_CSS.indexOf('.status-dot.wrapping {'));
    assert.doesNotMatch(rule.slice(0, 500), /breathe-slow/,
      'the old amber breathing animation must be gone, not just unreferenced');
  });

  it('the keyframes the pinwheel animates with actually exist', () => {
    // `animation: spin` naming a keyframes block that no longer exists is a
    // silent no-op: the dot renders, and simply never turns.
    assert.match(SESSION_CSS, /@keyframes\s+spin\s*\{/, 'the spin keyframes must exist');
  });

  it('every animation is disabled under prefers-reduced-motion, so the pinwheel is covered too', () => {
    assert.match(SESSION_CSS,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none\s*!important/,
      'a global reduced-motion rule must still cover the pinwheel');
  });
});

describe('#960 #selectBtn and its select-mode machinery are gone (Operator Decision A2)', () => {
  it('session.html no longer renders a select button', () => {
    assert.doesNotMatch(SESSION_HTML, /id="selectBtn"/);
  });

  it('session.js no longer defines toggleSelect or wires selectBtn', () => {
    assert.doesNotMatch(SESSION_JS, /function toggleSelect\(/);
    assert.doesNotMatch(SESSION_JS, /selectBtn/);
  });

  it('the #580 stranded select-mode override recovery and its localStorage marker are gone', () => {
    // That recovery path and marker existed only to serve Select mode (per
    // #960's own triage comment); leaving them in place after the button is
    // gone would be dead code with no caller.
    assert.doesNotMatch(SESSION_JS, /function repairAbandonedSelect\(/);
    assert.doesNotMatch(SESSION_JS, /function writeSelectMarker\(/);
    assert.doesNotMatch(SESSION_JS, /function clearSelectMarker\(/);
    assert.doesNotMatch(SESSION_JS, /selectModeActive/);
  });

  it('tcSelectModeMouse/tcParseSelectMarker are gone from api-helper.js too (A474-W2-R4)', () => {
    // Orphaned by this same removal, but living in a file outside #960's
    // original file scope — W2-B owned it until its own PR merged. Removed
    // here once the Architect's A474-W2-R4 explicitly authorized W2-C to
    // touch public/api-helper.js, rather than left as a permanent orphan.
    assert.doesNotMatch(API_HELPER_JS, /function tcSelectModeMouse\(/);
    assert.doesNotMatch(API_HELPER_JS, /function tcParseSelectMarker\(/);
    assert.doesNotMatch(API_HELPER_JS, /global\.tcSelectModeMouse/);
    assert.doesNotMatch(API_HELPER_JS, /global\.tcParseSelectMarker/);
  });
});

describe('#1237 a rejected mouse-mode toggle never asserts a state tmux never reached', () => {
  /**
   * Run the real, lifted `closeSettings()` against a stub DOM and a
   * controllable `apiMutate`. Isolates the mouse-toggle branch: the poll
   * interval and engine stubs are set to already match state, so only the
   * mouse-toggle logic under test actually does anything.
   * @param {object} opts
   * @param {boolean} opts.toggledTo - What the operator set the checkbox to.
   * @param {object|null} opts.mutateResult - What apiMutate resolves to.
   * @returns {Promise<{sessionState: object, warnings: Array<string[]>, mouseToggleChecked: boolean}>}
   */
  async function runCloseSettings({ toggledTo, mutateResult }) {
    const warnings = [];
    const sessionState = { pollInterval: 5000, project: null, mouseOn: false, mouseExplicit: false, ended: true };
    const mouseToggleEl = { checked: toggledTo };
    const els = {
      settingsModal: { classList: { remove: () => {} } },
      pollInterval: { value: String(sessionState.pollInterval) },
      settingsEngine: { value: '' },
      mouseToggle: mouseToggleEl
    };
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || null },
      sessionState,
      projectName: 'demo',
      saveSetting: () => {},
      startPolling: () => {},
      api: Object.assign(async () => null, { lastError: 'tmux not reachable' }),
      apiMutate: async () => mutateResult,
      window: { tcRenderSettingsWarnings: (_doc, msgs) => warnings.push(msgs) }
    });
    vm.runInContext(`${liftDeclaration(SESSION_JS, 'async function closeSettings(')}\nthis.closeSettings = closeSettings;`, ctx);
    await ctx.closeSettings();
    return { sessionState, warnings, mouseToggleChecked: mouseToggleEl.checked };
  }

  it('sets mouseOn/mouseExplicit from the SERVER response, not the optimistic client value', async () => {
    const { sessionState, warnings } = await runCloseSettings({
      toggledTo: true,
      mutateResult: { mouse: true, explicit: true, session: 'demo' }
    });
    assert.equal(sessionState.mouseOn, true);
    assert.equal(sessionState.mouseExplicit, true);
    assert.deepEqual(warnings, [], 'a successful save must not warn');
  });

  it('leaves mouseOn/mouseExplicit untouched and rolls the checkbox back when the POST is rejected', async () => {
    const { sessionState, mouseToggleChecked, warnings } = await runCloseSettings({
      toggledTo: true,
      mutateResult: null // apiMutate returns null on any failure
    });
    assert.equal(sessionState.mouseOn, false, 'must not assert a state tmux never reached');
    assert.equal(sessionState.mouseExplicit, false,
      'must not seed a false "operator explicitly chose this" marker (#1237\'s own stated risk)');
    assert.equal(mouseToggleChecked, false, 'the toggle control must roll back to the prior committed state');
  });

  it('surfaces the failure through the #758 settings-warnings banner, naming api.lastError', async () => {
    const { warnings } = await runCloseSettings({ toggledTo: true, mutateResult: null });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /Mouse mode not saved/);
    assert.match(warnings[0][0], /tmux not reachable/, 'must carry api.lastError, not a generic message');
  });

  it('does nothing when the toggle was not actually changed', async () => {
    const { warnings } = await runCloseSettings({ toggledTo: false, mutateResult: null });
    assert.deepEqual(warnings, [], 'no-op toggle must not even attempt a POST');
  });
});

describe('#1638 the mobile keybar sends real terminal input, and sticky Ctrl never double-sends', () => {
  it('session.html renders all seven keys, hidden by default', () => {
    assert.match(SESSION_HTML, /id="mobileKeybar"[^>]*hidden/);
    for (const id of ['keybarEsc', 'keybarCtrl', 'keybarTab', 'keybarUp', 'keybarDown', 'keybarLeft', 'keybarRight']) {
      assert.match(SESSION_HTML, new RegExp(`id="${id}"`), id);
    }
  });

  it('session.css defines the bar and a 44px touch target', () => {
    assert.match(SESSION_CSS, /\.mobile-keybar\s*\{/);
    const rule = SESSION_CSS.slice(SESSION_CSS.indexOf('.keybar-key {'));
    assert.match(rule.slice(0, 200), /min-width:\s*44px/);
    assert.match(rule.slice(0, 200), /min-height:\s*44px/);
  });

  it('[hidden] wins over .mobile-keybar\'s own display:flex (PRR-A B2)', () => {
    // `.mobile-keybar { display: flex }` is an author rule, so it beats the
    // UA stylesheet's `[hidden] { display: none }` on a specificity tie —
    // without an explicit override, `hidden` does nothing and the bar shows
    // on desktop/webui despite initSession() setting the attribute.
    assert.match(SESSION_CSS, /\.mobile-keybar\[hidden\]\s*\{\s*display:\s*none/);
  });

  it('session.js does not call xterm\'s attachCustomKeyEventHandler', () => {
    // That API allows only one handler per Terminal; calling it here would
    // silently replace whatever ttyd's own built-in client already relies
    // on. The whole point of the capture-phase-DOM design is to avoid it.
    // (The name may still appear in prose explaining the choice — only an
    // actual call is checked for.)
    assert.doesNotMatch(SESSION_JS, /\.attachCustomKeyEventHandler\(/);
  });

  /**
   * Lift the real keybar functions and run them against a stub terminal
   * iframe/document — captured listeners are invoked directly, the same
   * way a real keydown/beforeinput dispatch would call them.
   * @returns {object}
   */
  function load() {
    const inputCalls = [];
    let focusCalls = 0;
    const term = { input: (data) => inputCalls.push(data), focus: () => { focusCalls++; } };
    const listeners = { keydown: [], beforeinput: [] };
    const doc = {
      addEventListener: (type, fn, capture) => {
        assert.equal(capture, true, `${type} must be capture-phase`);
        listeners[type].push(fn);
      }
    };
    const frame = { contentWindow: { term, document: doc } };
    const keybarCtrl = {
      attrs: {},
      classes: new Set(),
      setAttribute(k, v) { this.attrs[k] = v; },
      classList: { toggle: (c, on) => (on ? keybarCtrl.classes.add(c) : keybarCtrl.classes.delete(c)) }
    };
    const els = { terminalFrame: frame, keybarCtrl };
    const toasts = [];
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || null },
      showBannerActionToast: (msg) => toasts.push(msg)
    });
    const decls = ['function _sessionTerm(', 'function sendTerminalInput(', 'function _terminalDoc(',
      'function paintCtrlKey(', 'function wireMobileCtrlSticky(', 'function toggleCtrlArmed('];
    const names = decls.map((d) => d.match(/function (\w+)\(/)[1]);
    vm.runInContext(
      `let ctrlArmed = false;\n${decls.map((d) => liftDeclaration(SESSION_JS, d)).join('\n')}\n`
        + names.map((n) => `this.${n} = ${n};`).join('\n')
        + '\nthis.getCtrlArmed = () => ctrlArmed;',
      ctx
    );
    return { ctx, inputCalls, listeners, keybarCtrl, toasts, getFocusCalls: () => focusCalls };
  }

  /** A minimal stand-in for a real keydown/beforeinput DOM event. */
  function fakeEvent(fields) {
    const calls = { prevented: 0, stopped: 0 };
    return {
      ...fields,
      calls,
      preventDefault: () => { calls.prevented++; },
      stopImmediatePropagation: () => { calls.stopped++; }
    };
  }

  it('Esc/Tab/arrows send their real escape sequence through term.input', () => {
    const { ctx, inputCalls } = load();
    ctx.sendTerminalInput('\x1b');
    ctx.sendTerminalInput('\t');
    ctx.sendTerminalInput('\x1b[A');
    ctx.sendTerminalInput('\x1b[B');
    ctx.sendTerminalInput('\x1b[D');
    ctx.sendTerminalInput('\x1b[C');
    assert.deepEqual(inputCalls, ['\x1b', '\t', '\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
  });

  it('tapping Ctrl arms the sticky modifier and paints aria-pressed', () => {
    const { ctx, keybarCtrl } = load();
    ctx.toggleCtrlArmed();
    assert.equal(ctx.getCtrlArmed(), true);
    assert.equal(keybarCtrl.attrs['aria-pressed'], 'true');
    assert.ok(keybarCtrl.classes.has('active'));
  });

  it('refocuses the terminal on arm, so tapping the keybar button does not steal the soft keyboard (PRR-A C2)', () => {
    // Tapping Ctrl moves DOM focus to that button, off the terminal's own
    // input element — on a phone that can close the soft keyboard, so the
    // very keystroke this arms for never reaches the listener at all.
    const { ctx, getFocusCalls } = load();
    ctx.toggleCtrlArmed();
    assert.equal(getFocusCalls(), 1, 'the terminal must be refocused once armed');
  });

  it('tapping Ctrl again cancels the armed state rather than sending it', () => {
    const { ctx, keybarCtrl, inputCalls } = load();
    ctx.toggleCtrlArmed();
    ctx.toggleCtrlArmed();
    assert.equal(ctx.getCtrlArmed(), false);
    assert.equal(keybarCtrl.attrs['aria-pressed'], 'false');
    assert.deepEqual(inputCalls, []);
  });

  it('while armed, a keydown with a single-char key sends the masked control byte and disarms', () => {
    const { ctx, listeners, inputCalls } = load();
    ctx.toggleCtrlArmed();
    const ev = fakeEvent({ key: 'c', isComposing: false });
    listeners.keydown[0](ev);
    assert.deepEqual(inputCalls, ['\x03'], 'Ctrl+C must be \\x03');
    assert.equal(ev.calls.prevented, 1);
    assert.equal(ev.calls.stopped, 1);
    assert.equal(ctx.getCtrlArmed(), false, 'one keystroke must disarm it');
  });

  it('keydown and beforeinput for the SAME keystroke must not double-send', () => {
    // Both events fire for an ordinary keystroke; the first handler to run
    // disarms before the second one checks `ctrlArmed`.
    const { ctx, listeners, inputCalls } = load();
    ctx.toggleCtrlArmed();
    listeners.keydown[0](fakeEvent({ key: 'c', isComposing: false }));
    listeners.beforeinput[0](fakeEvent({ data: 'c' }));
    assert.equal(inputCalls.length, 1, 'exactly one send for one physical keystroke');
  });

  it('a mobile IME delivers keydown with key:"Unidentified" — beforeinput carries the real character', () => {
    const { ctx, listeners, inputCalls } = load();
    ctx.toggleCtrlArmed();
    listeners.keydown[0](fakeEvent({ key: 'Unidentified', isComposing: false }));
    assert.equal(ctx.getCtrlArmed(), true, 'the unidentified keydown must not consume the arm');
    listeners.beforeinput[0](fakeEvent({ data: 'c' }));
    assert.deepEqual(inputCalls, ['\x03']);
  });

  it('ignores bare modifier keys and composing input while armed — must not disarm or send', () => {
    const { ctx, listeners, inputCalls } = load();
    ctx.toggleCtrlArmed();
    for (const key of ['Control', 'Shift', 'Alt', 'Meta']) {
      listeners.keydown[0](fakeEvent({ key, isComposing: false }));
    }
    listeners.keydown[0](fakeEvent({ key: 'c', isComposing: true }));
    assert.equal(ctx.getCtrlArmed(), true, 'none of these are the real keystroke');
    assert.deepEqual(inputCalls, []);
  });

  it('normal typing is completely untouched while Ctrl is unarmed', () => {
    const { ctx, listeners, inputCalls } = load();
    ctx.toggleCtrlArmed(); // arm once, to wire the listeners
    ctx.toggleCtrlArmed(); // then cancel — this is the common case: unarmed
    const ev = fakeEvent({ key: 'c', isComposing: false });
    listeners.keydown[0](ev);
    assert.deepEqual(inputCalls, []);
    assert.equal(ev.calls.prevented, 0, 'must not preventDefault when unarmed — real typing must pass through');
    assert.equal(ev.calls.stopped, 0);
  });

  it('reports unavailable rather than arming when the terminal iframe cannot be reached', () => {
    const inputCalls = [];
    const els = { terminalFrame: { get contentWindow() { throw new Error('cross-origin'); } }, keybarCtrl: { attrs: {}, setAttribute() {}, classList: { toggle: () => {} } } };
    const toasts = [];
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || null },
      showBannerActionToast: (msg) => toasts.push(msg)
    });
    const decls = ['function _terminalDoc(', 'function paintCtrlKey(', 'function wireMobileCtrlSticky(', 'function toggleCtrlArmed('];
    const names = decls.map((d) => d.match(/function (\w+)\(/)[1]);
    vm.runInContext(`let ctrlArmed = false;\n${decls.map((d) => liftDeclaration(SESSION_JS, d)).join('\n')}\n`
      + names.map((n) => `this.${n} = ${n};`).join('\n') + '\nthis.getCtrlArmed = () => ctrlArmed;', ctx);
    ctx.toggleCtrlArmed();
    assert.equal(ctx.getCtrlArmed(), false, 'must not claim to be armed when it cannot intercept anything');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /not available/);
  });
});

describe('#2011 the terminal reattaches on a new session and recovers from an ordinary disconnect', () => {
  /**
   * A fake xterm buffer: an array of lines, each line objects answering
   * `translateToString`.
   * @param {string[]} lines
   * @returns {object}
   */
  function fakeBuffer(lines) {
    return {
      length: lines.length,
      getLine: (i) => (i >= 0 && i < lines.length ? { translateToString: () => lines[i] } : null)
    };
  }

  /**
   * Lift the real reconnect/reattach functions against stub timers, DOM and
   * API, so backoff can be driven step by step instead of waiting real
   * seconds.
   * @param {object} [opts]
   * @returns {object}
   */
  function load(opts = {}) {
    let bufferLines = opts.bufferLines || [];
    const frame = { src: '', contentWindow: { term: { get buffer() { return { active: fakeBuffer(bufferLines) }; } } } };
    const statusDot = { classes: new Set(), classList: { add: (c) => statusDot.classes.add(c), remove: (c) => statusDot.classes.delete(c) } };
    const statusPill = { attrs: {}, setAttribute: (k, v) => { statusPill.attrs[k] = v; }, getAttribute: (k) => statusPill.attrs[k] ?? null, querySelector: () => null };
    const sessionEnded = { classes: new Set(['hidden']), classList: { add: (c) => sessionEnded.classes.add(c), remove: (c) => sessionEnded.classes.delete(c) } };
    /** A generic stub for any element id applyWebuiMode touches that this harness doesn't name directly. */
    const genericEl = () => ({
      disabled: false, title: '',
      classList: { add: () => {}, remove: () => {}, contains: () => false },
      setAttribute: () => {}
    });
    const buttons = ['wrapBtn', 'killBtn', 'cmdBtn', 'commandSend']
      .reduce((m, id) => { m[id] = { ...genericEl(), disabled: true }; return m; }, {});
    const mobileKeybar = { hidden: false };
    const els = { terminalFrame: frame, statusDot, statusPill, sessionEnded, mobileKeybar, ...buttons };
    const pendingTimeouts = [];
    const intervals = [];
    const apiCalls = [];
    const sessionState = { ended: false, wrapping: false, session: null, terminalAttachedSessionId: null };
    const ctx = vm.createContext({
      document: { getElementById: (id) => { if (!els[id]) els[id] = genericEl(); return els[id]; } },
      sessionState,
      projectName: 'demo',
      setPillDetail: (pill, detail) => { pill.setAttribute('data-pill-detail', detail); },
      api: async (url) => { apiCalls.push(url); return opts.apiAnswer !== undefined ? opts.apiAnswer : null; },
      startPolling: () => {},
      // 1-based ids: real browsers never return 0 from setTimeout/setInterval,
      // and this module's cancel checks (`if (reconnectTimer)`) rely on that —
      // a 0-based stub id would make the very first timer untruthy and silently
      // break every cancel-path assertion below.
      setTimeout: (fn, ms) => { const id = pendingTimeouts.length + 1; pendingTimeouts.push({ id, fn, ms }); return id; },
      clearTimeout: (id) => { const i = pendingTimeouts.findIndex((t) => t.id === id); if (i !== -1) pendingTimeouts.splice(i, 1); },
      setInterval: (fn, ms) => { const id = intervals.length + 1; intervals.push({ id, fn, ms, active: true }); return id; },
      clearInterval: (id) => { const t = intervals.find((t) => t.id === id); if (t) t.active = false; },
      // opts.touch adds `ontouchstart` so `'ontouchstart' in window` reads true,
      // matching applyWebuiMode/reattachTerminalForStatus's own check.
      window: opts.touch ? { tcWireTerminalFrame: () => {}, ontouchstart: null } : { tcWireTerminalFrame: () => {} },
      requestAnimationFrame: (fn) => fn() // run synchronously so frame.src is observable immediately
    });
    const decls = ['function _sessionTerm(', 'function terminalDisconnectStatus(', 'function clearReconnectingStatus(',
      'function cancelReconnectEpisode(', 'function runReconnectAttempt(', 'function setupTerminalKeepingEpisode(',
      'function beginReconnectEpisode(', 'function checkOrdinaryDisconnect(', 'function setupTerminal(',
      'function reattachTerminalForStatus(', 'function applyWebuiMode(', 'function startEndedWatch(', 'function stopEndedWatch('];
    const names = decls.map((d) => d.match(/function (\w+)\(/)[1]);
    vm.runInContext(
      `const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 4000];\n`
        + `let reconnectAttempt = 0;\nlet reconnectTimer = null;\nlet reconnectExhausted = false;\nlet endedWatchTimer = null;\n`
        + `let terminalSetupStarted = false;\nlet countdownTimer = null;\n`
        + `${decls.map((d) => liftDeclaration(SESSION_JS, d)).join('\n')}\n`
        + names.map((n) => `this.${n} = ${n};`).join('\n')
        + '\nthis.getReconnectAttempt = () => reconnectAttempt;\nthis.getReconnectTimer = () => reconnectTimer;'
        + '\nthis.getReconnectExhausted = () => reconnectExhausted;',
      ctx
    );
    return {
      ctx, frame, statusDot, statusPill, sessionEnded, buttons, mobileKeybar, pendingTimeouts, intervals, apiCalls, sessionState,
      setBuffer: (lines) => { bufferLines = lines; }
    };
  }

  it('setupTerminal records which session the iframe is now attached to', () => {
    const h = load();
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.setupTerminal();
    assert.equal(h.sessionState.terminalAttachedSessionId, 'sess-1');
    assert.match(h.frame.src, /\/terminal\/\?arg=demo/);
  });

  it('terminalDisconnectStatus reads the real ttyd text, and nothing else', () => {
    const h = load({ bufferLines: ['$ some normal output', 'another line'] });
    assert.equal(h.ctx.terminalDisconnectStatus(), 'healthy');
    h.setBuffer(['[exited]', 'Press Enter to Reconnect']);
    assert.equal(h.ctx.terminalDisconnectStatus(), 'unhealthy');
  });

  it('an unreadable or not-yet-loaded terminal is UNKNOWN — never healthy, never unhealthy', () => {
    const h = load();
    h.frame.contentWindow = null; // not loaded yet / cross-origin — _sessionTerm() returns null either way
    assert.equal(h.ctx.terminalDisconnectStatus(), 'unknown');
  });

  it('a blank or whitespace-only buffer is UNKNOWN, not healthy — nothing confirmed yet (PRR-A B4)', () => {
    // A freshly (re)initialized xterm buffer reads exactly like this for
    // the brief window before the pty's first prompt arrives — "nothing
    // rendered yet" must not be read as "confirmed healthy".
    for (const lines of [[], [''], ['   ', '\t'], ['', '  ', '']]) {
      const h = load({ bufferLines: lines });
      assert.equal(h.ctx.terminalDisconnectStatus(), 'unknown', JSON.stringify(lines));
    }
  });

  it('checkOrdinaryDisconnect starts a bounded 1s/2s/4s/4s backoff episode on positive evidence', () => {
    const h = load({ bufferLines: ['[exited]', 'Press Enter to Reconnect'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    assert.equal(h.ctx.getReconnectAttempt(), 1, 'the first attempt fires immediately');
    assert.equal(h.statusPill.attrs['data-pill-detail'], 'Reconnecting…');
    assert.ok(h.statusDot.classes.has('reconnecting'));
    assert.deepEqual(h.pendingTimeouts.map((t) => t.ms), [1000]);

    h.pendingTimeouts.shift().fn(); // the terminal still shows the prompt — attempt 2
    assert.equal(h.ctx.getReconnectAttempt(), 2);
    assert.deepEqual(h.pendingTimeouts.map((t) => t.ms), [2000]);

    h.pendingTimeouts.shift().fn(); // attempt 3
    assert.deepEqual(h.pendingTimeouts.map((t) => t.ms), [4000]);

    h.pendingTimeouts.shift().fn(); // attempt 4 — the last one
    assert.equal(h.ctx.getReconnectAttempt(), 4);
    assert.equal(h.pendingTimeouts.length, 0, 'attempts are exhausted — no fifth wait is scheduled');
    assert.equal(h.ctx.getReconnectExhausted(), true);
  });

  it('a persistent disconnect does NOT restart a fresh unbounded episode once exhausted (INT finding)', () => {
    const h = load({ bufferLines: ['[exited]', 'Press Enter to Reconnect'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    h.pendingTimeouts.shift().fn(); // 2
    h.pendingTimeouts.shift().fn(); // 3
    h.pendingTimeouts.shift().fn(); // 4 — exhausted
    assert.equal(h.ctx.getReconnectExhausted(), true);
    assert.equal(h.pendingTimeouts.length, 0);

    // The NEXT poll tick still sees the same unhealthy prompt. The old bug:
    // beginReconnectEpisode unconditionally reset reconnectAttempt to 0,
    // so this would silently start ANOTHER full 1s/2s/4s/4s episode —
    // forever, for as long as the disconnect persists.
    h.ctx.checkOrdinaryDisconnect();
    assert.equal(h.ctx.getReconnectAttempt(), 4, 'must stay latched, not restart from attempt 1');
    assert.equal(h.pendingTimeouts.length, 0, 'must not schedule a new wait once exhausted');
  });

  it('a reload-in-progress (unknown) mid-backoff is NOT treated as healed (INT finding)', () => {
    const h = load({ bufferLines: ['[exited]', 'Press Enter to Reconnect'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    // The scheduled recheck lands while the just-reattached frame is still
    // loading — _sessionTerm() can't read it yet. The old bug: that read the
    // same as "no prompt" = healed, clearing the episode on nothing more
    // than "we don't know yet".
    h.frame.contentWindow = null;
    h.pendingTimeouts.shift().fn();
    assert.equal(h.ctx.getReconnectAttempt(), 2, 'an unknown read must consume a budgeted retry, not declare victory');
    assert.equal(h.statusPill.attrs['data-pill-detail'], 'Reconnecting…', 'must not have been marked Active');
  });

  it('resets and clears the reconnecting status once the connection is DEFINITIVELY healthy', () => {
    const h = load({ bufferLines: ['[exited]', 'Press Enter to Reconnect'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    h.setBuffer(['a normal prompt again']); // healed before the next scheduled check
    h.pendingTimeouts.shift().fn();
    assert.equal(h.ctx.getReconnectAttempt(), 0);
    assert.equal(h.ctx.getReconnectExhausted(), false);
    assert.equal(h.pendingTimeouts.length, 0);
    assert.equal(h.statusPill.attrs['data-pill-detail'], 'Active');
    assert.ok(!h.statusDot.classes.has('reconnecting'));
  });

  it('checkOrdinaryDisconnect is a no-op while an episode is already running', () => {
    const h = load({ bufferLines: ['[exited]'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    const attemptsAfterFirst = h.ctx.getReconnectAttempt();
    h.ctx.checkOrdinaryDisconnect();
    assert.equal(h.ctx.getReconnectAttempt(), attemptsAfterFirst, 'must not restart or double-fire mid-episode');
  });

  it('a fresh setupTerminal() call cancels a MID-episode (not yet exhausted) reconnect attempt', () => {
    const h = load({ bufferLines: ['[exited]', 'Press Enter to Reconnect'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    assert.ok(h.ctx.getReconnectTimer() !== null);
    h.ctx.setupTerminal();
    assert.equal(h.ctx.getReconnectAttempt(), 0);
    assert.equal(h.pendingTimeouts.length, 0, 'the pending backoff wait must be cancelled, not just forgotten');
  });

  it('a fresh setupTerminal() call cancels whatever episode was running, including the exhaustion latch', () => {
    const h = load({ bufferLines: ['[exited]', 'Press Enter to Reconnect'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    h.pendingTimeouts.shift().fn();
    h.pendingTimeouts.shift().fn();
    h.pendingTimeouts.shift().fn(); // exhausted
    assert.equal(h.ctx.getReconnectExhausted(), true);
    h.ctx.setupTerminal();
    assert.equal(h.ctx.getReconnectAttempt(), 0);
    assert.equal(h.ctx.getReconnectExhausted(), false, 'a fresh attach earns a clean slate');
    assert.equal(h.pendingTimeouts.length, 0, 'the pending backoff wait must be cancelled, not just forgotten');
  });

  it('startEndedWatch polls /status and reattaches + resumes polling once active again, never re-POSTing', () => {
    const h = load({ apiAnswer: { active: true, sessionId: 'sess-2' } });
    h.sessionState.ended = true;
    h.sessionState.session = { sessionId: 'sess-1' };
    h.statusPill.setAttribute('data-pill-detail', 'Session ended'); // what handleSessionEnded left behind
    h.ctx.startEndedWatch();
    assert.equal(h.intervals.length, 1);
    return h.intervals[0].fn().then(() => {
      assert.deepEqual(h.apiCalls, ['/api/sessions/demo/status'], 'only a GET, never a launch POST');
      assert.equal(h.sessionState.ended, false);
      assert.equal(h.sessionState.terminalAttachedSessionId, 'sess-2', 'reattached to the NEW session');
      assert.ok(!h.statusDot.classes.has('ended'));
      assert.ok(h.sessionEnded.classes.has('hidden'));
      assert.equal(h.buttons.wrapBtn.disabled, false);
      assert.equal(h.intervals[0].active, false, 'the watch stops itself once it has done its job');
      // PRR-A C1: the dot/bar/buttons all flip back, but the pill text was
      // left stuck at "Session ended" (or "Session wrapped") forever —
      // nothing else on this path ever repaints it.
      assert.equal(h.statusPill.attrs['data-pill-detail'], 'Active');
    });
  });

  it('startEndedWatch does nothing while the session is still genuinely ended', () => {
    const h = load({ apiAnswer: { active: false } });
    h.sessionState.ended = true;
    h.ctx.startEndedWatch();
    return h.intervals[0].fn().then(() => {
      assert.equal(h.sessionState.ended, true);
      assert.equal(h.intervals[0].active, true, 'the watch keeps running — the session has not returned yet');
    });
  });

  it('handleSessionEnded starts the ended-state watch — wired, not just defined', () => {
    assert.match(liftDeclaration(SESSION_JS, 'function handleSessionEnded('), /startEndedWatch\(\)/);
  });

  it('pollStatus reattaches (mode-aware) on a new active session id, and checks for an ordinary disconnect only on tmux', () => {
    const body = liftDeclaration(SESSION_JS, 'async function pollStatus(');
    assert.match(body, /terminalSetupStarted/, 'must not race initSession\'s own first setupTerminal() call');
    assert.match(body, /reattachTerminalForStatus\(data\)/, 'reattach must be mode-aware (PRR-A B3), not a raw setupTerminal()');
    assert.match(body, /checkOrdinaryDisconnect\(\)/);
    assert.match(body, /data\.sessionMode\s*!==\s*'webui'/, 'the ttyd-buffer disconnect check is tmux-only — webui has no xterm instance');
  });

  it('reattachTerminalForStatus picks the webui path (iframeUrl + applyWebuiMode) vs. the tmux path, mode-aware', () => {
    const h = load({ touch: true });
    h.ctx.reattachTerminalForStatus({ sessionMode: 'webui', iframeUrl: '/openclaw/foo' });
    assert.equal(h.frame.src, '/openclaw/foo');
    assert.equal(h.mobileKeybar.hidden, true, 'a webui session has no xterm instance for the keybar to send keys into');

    h.ctx.reattachTerminalForStatus({ sessionMode: 'tmux' });
    assert.match(h.frame.src, /\/terminal\/\?arg=demo/);
    assert.equal(h.mobileKeybar.hidden, false, 'switching back to tmux on a touch device reveals the keybar again');
  });

  it('handleSessionEnded and handleWrapCompleted both cancel any in-flight reconnect episode (PRR-A B1)', () => {
    assert.match(liftDeclaration(SESSION_JS, 'function handleSessionEnded('), /cancelReconnectEpisode\(\)/);
    assert.match(liftDeclaration(SESSION_JS, 'function handleWrapCompleted('), /cancelReconnectEpisode\(\)/);
  });

  it('runReconnectAttempt refuses to reattach once the session has ended or wrapped (PRR-A B1 defense in depth)', () => {
    const h = load({ bufferLines: ['[exited]', 'Press Enter to Reconnect'] });
    h.sessionState.session = { sessionId: 'sess-1' };
    h.ctx.checkOrdinaryDisconnect();
    assert.ok(h.ctx.getReconnectTimer() !== null, 'an episode is running');
    // The session ends out from under the pending retry, WITHOUT going
    // through cancelReconnectEpisode (the real callers always do; this
    // proves the guard holds even if a future caller forgot to).
    h.sessionState.ended = true;
    const before = h.frame.src;
    h.pendingTimeouts.shift().fn();
    assert.equal(h.frame.src, before, 'must not reattach a session the page has already declared over');
  });
});
