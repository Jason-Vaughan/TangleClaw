'use strict';

/**
 * Browser executors for the release-candidate soak (#2020).
 *
 * They drive a real browser (Safari, through `safaridriver`) inside the soak
 * guest against the guest's own dashboard, so the soak covers what only a
 * browser does: the dashboard's scripts running against the API, and a
 * terminal attaching over the `/terminal/` WebSocket proxy to ttyd.
 *
 * A browser event needs the local context `lib/soak/local.js` admitted, with
 * a WebDriver (`ctx.local.webdriver`). Without it the event refuses
 * (`NO_LOCAL_CONTROL`) and does nothing. Each event opens one WebDriver
 * session and always ends it, whatever failed in between, because Safari
 * runs one session at a time.
 *
 * The guest's front-door gate must be off: a browser is not a machine
 * client, and the soak holds no login. With the gate on, the dashboard never
 * renders and every browser event is recorded as `NOT_RENDERED`.
 *
 * @module lib/soak/browser
 */

const ex = require('./executors');
const wd = require('./webdriver');

/** Closed set of browser outcome codes, beyond `executors.OUTCOME` and `webdriver.WD_OUTCOME`. */
const BROWSER_OUTCOME = Object.freeze({
  NO_LOCAL_CONTROL: 'NO_LOCAL_CONTROL',
  // The page loaded, but the element that shows its scripts ran never appeared.
  NOT_RENDERED: 'NOT_RENDERED',
  NOT_HARNESS_SESSION: 'NOT_HARNESS_SESSION',
  // The terminal rendered, but the server counted no new attach.
  NOT_ATTACHED: 'NOT_ATTACHED',
  // The server restarted during the event, so its attach counter was reset.
  SERVER_RESTARTED: 'SERVER_RESTARTED'
});

/**
 * How long each browser wait may take.
 * - `renderMs`: the page's own scripts filling in what the check reads.
 * - `attachMs`: the server counting the terminal's attach.
 */
const BROWSER_LIMITS = Object.freeze({
  renderMs: 30 * 1000,
  attachMs: 30 * 1000
});

/**
 * Reads the dashboard's uptime stat. The dashboard's script fills it from the
 * API, replacing its `--` placeholder, so a filled value shows the page's
 * scripts ran and reached the server.
 */
const DASHBOARD_PROBE = "const e = document.getElementById('statUptime'); return e ? e.textContent : null;";

/** The session page's terminal iframe (`public/session.html`). */
const TERMINAL_FRAME = '#terminalFrame';

/** The terminal ttyd renders inside the frame (xterm.js). */
const TERMINAL_ELEMENT = '.xterm';

/**
 * The limits in force: the defaults, with a test's overrides.
 * @param {object} ctx - Call context
 * @returns {object} Limits
 */
function _limits(ctx) {
  return { ...BROWSER_LIMITS, ...((ctx.local && ctx.local.limits) || {}) };
}

/**
 * Run `body` inside a WebDriver session that is always ended afterwards.
 * @param {object} ctx - Call context with `local.webdriver`
 * @param {(sessionId: string) => Promise<object>} body - The event's browser steps; resolves to an outcome
 * @returns {Promise<object>} The outcome, with `browserCleanupFailed` when the session could not be ended
 */
async function _withBrowser(ctx, body) {
  const s = await wd.newSession(ctx);
  if (!s.ok) return { ok: false, code: s.code, status: null, step: 'browser-session', ...(s.error ? { error: s.error } : {}) };
  let outcome;
  try {
    outcome = await body(s.sessionId);
  } finally {
    const end = await wd.deleteSession(ctx, s.sessionId);
    if (!end.ok) outcome = { ...(outcome || { ok: false, code: end.code, status: null, step: 'browser-end' }), browserCleanupFailed: true };
  }
  return outcome;
}

/**
 * A failed WebDriver command, as an outcome at `step`.
 * @param {object} r - The failed command result
 * @param {string} step - Where it failed
 * @returns {object} Outcome
 */
function _wdFail(r, step) {
  return { ok: false, code: r.code, status: null, step, ...(r.error ? { error: r.error } : {}) };
}

/**
 * Wait for a script to return a value `accept` takes.
 * @param {object} ctx - Call context
 * @param {string} sessionId - Session id
 * @param {string} script - Script body
 * @param {(v: *) => boolean} accept - When the value is ready
 * @param {number} budgetMs - How long it may take
 * @returns {Promise<{ok: true, value: *}|{ok: false, fail?: object, last?: *}>} The value, or the last command failure or value
 */
async function _awaitScript(ctx, sessionId, script, accept, budgetMs) {
  let value;
  let fail = null;
  const r = await ex.poll(ctx, budgetMs, async () => {
    const v = await wd.execute(ctx, sessionId, script);
    if (!v.ok) { fail = v; return { done: false }; }
    fail = null;
    value = v.value;
    return { done: accept(v.value) };
  });
  if (r.timedOut) return { ok: false, fail, last: value };
  return { ok: true, value };
}

/**
 * Load the dashboard in the browser and wait for its scripts to fill in the
 * uptime stat from the API.
 * @param {object} ctx - Call context with `local`
 * @returns {Promise<object>} Outcome, with the `uptime` text the page showed
 */
async function dashboardLoad(ctx) {
  const lim = _limits(ctx);
  return _withBrowser(ctx, async (sid) => {
    const nav = await wd.navigate(ctx, sid, new URL('/', ctx.apiBase).href);
    if (!nav.ok) return _wdFail(nav, 'navigate');
    const shown = await _awaitScript(ctx, sid, DASHBOARD_PROBE, (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '--', lim.renderMs);
    if (!shown.ok) return shown.fail ? _wdFail(shown.fail, 'render') : { ok: false, code: BROWSER_OUTCOME.NOT_RENDERED, status: null, step: 'render' };
    return { ok: true, code: ex.OUTCOME.OK, status: null, step: null, uptime: shown.value.trim() };
  });
}

/**
 * The server's attach counter, with the process instance it belongs to.
 * @param {object} ctx - Call context
 * @returns {Promise<{ok: true, instance: string, attaches: number}|{ok: false, code: string, status: number|null}>} The counter, or why not
 */
async function _attaches(ctx) {
  const r = await ex.call(ctx, 'GET', '/api/system/pty-activity');
  if (!r.ok) return { ok: false, code: r.code, status: r.status };
  if (!r.body || typeof r.body.instance !== 'string' || !Number.isInteger(r.body.attaches)) return { ok: false, code: ex.OUTCOME.BAD_BODY, status: r.status };
  return { ok: true, instance: r.body.instance, attaches: r.body.attaches };
}

/**
 * Open a harness session's page in the browser, and check that its terminal
 * renders and that the server counted the attach.
 *
 * The project passes the same leftover check as every engine cycle, and the
 * event launches its own stub session, which is killed at the end whatever
 * failed. The server's `pty-activity` counter is the proof the attach reached
 * ttyd through the proxy: a rendered page alone could be a cached shell. A
 * counter from a different server instance means the server restarted
 * during the event, which says nothing about this attach.
 * @param {object} ctx - Call context with `local`
 * @param {{project: string}} params - Event params
 * @returns {Promise<object>} Outcome, with how many `attaches` the server counted during it
 */
async function terminalAttach(ctx, params) {
  const lim = _limits(ctx);
  const base = ex.sessionBase(params.project);
  const guard = await ex.clearLeftover(ctx, params.project);
  if (!guard.ok) return guard;
  const preNote = guard.preKilled ? { preKilled: true } : {};
  const launch = await ex.call(ctx, 'POST', base, { engineOverride: ex.STUB_ENGINE_ID, primePrompt: false });
  if (!launch.ok) return { ok: false, code: launch.code, status: launch.status, step: 'launch', ...preNote };

  let outcome;
  try {
    if (!launch.body || launch.body.engine !== ex.STUB_ENGINE_ID) {
      outcome = { ok: false, code: BROWSER_OUTCOME.NOT_HARNESS_SESSION, status: null, step: 'launch' };
    } else {
      outcome = await _attachInBrowser(ctx, params.project, lim);
    }
  } finally {
    const kill = await ex.call(ctx, 'DELETE', base, { reason: 'soak browser: terminal attach' });
    outcome = { ...outcome, cleanupFailed: !kill.ok, ...preNote };
  }
  return outcome;
}

/**
 * The browser half of `terminalAttach`, once the harness session is up.
 * @param {object} ctx - Call context with `local`
 * @param {string} project - Project name
 * @param {object} lim - Limits
 * @returns {Promise<object>} Outcome
 */
async function _attachInBrowser(ctx, project, lim) {
  const before = await _attaches(ctx);
  if (!before.ok) return { ok: false, code: before.code, status: before.status, step: 'pty-before' };
  return _withBrowser(ctx, async (sid) => {
    const nav = await wd.navigate(ctx, sid, new URL(`/session/${encodeURIComponent(project)}`, ctx.apiBase).href);
    if (!nav.ok) return _wdFail(nav, 'navigate');
    // The page sets the frame's src on the next animation frame, so wait for it.
    const framed = await _awaitScript(ctx, sid, `const f = document.querySelector('${TERMINAL_FRAME}'); return f ? f.getAttribute('src') : null;`,
      (v) => typeof v === 'string' && v.startsWith('/terminal/'), lim.renderMs);
    if (!framed.ok) return framed.fail ? _wdFail(framed.fail, 'frame') : { ok: false, code: BROWSER_OUTCOME.NOT_RENDERED, status: null, step: 'frame' };
    const frame = await wd.findElement(ctx, sid, TERMINAL_FRAME);
    if (!frame.ok) return _wdFail(frame, 'frame');
    const into = await wd.switchToFrame(ctx, sid, frame.element);
    if (!into.ok) return _wdFail(into, 'frame');
    const term = await _awaitScript(ctx, sid, `return document.querySelector('${TERMINAL_ELEMENT}') !== null;`, (v) => v === true, lim.renderMs);
    if (!term.ok) return term.fail ? _wdFail(term.fail, 'terminal') : { ok: false, code: BROWSER_OUTCOME.NOT_RENDERED, status: null, step: 'terminal' };

    let now = null;
    let failure = null;
    const counted = await ex.poll(ctx, lim.attachMs, async () => {
      const a = await _attaches(ctx);
      if (!a.ok) { failure = a; return { done: false }; }
      failure = null;
      now = a;
      return { done: a.instance !== before.instance || a.attaches > before.attaches };
    });
    if (now && now.instance !== before.instance) return { ok: false, code: BROWSER_OUTCOME.SERVER_RESTARTED, status: null, step: 'attach' };
    if (counted.timedOut) {
      return failure ? { ok: false, code: failure.code, status: failure.status, step: 'attach' } : { ok: false, code: BROWSER_OUTCOME.NOT_ATTACHED, status: null, step: 'attach' };
    }
    return { ok: true, code: ex.OUTCOME.OK, status: null, step: null, attaches: now.attaches - before.attaches };
  });
}

/**
 * Wrap a browser event so it refuses without a WebDriver, touching nothing.
 * @param {(ctx: object, params: object) => Promise<object>} fn - The event
 * @returns {(ctx: object, params: object) => Promise<object>} Executor
 */
function _local(fn) {
  return async (ctx, params) => {
    if (!ctx.local || !ctx.local.webdriver) return { ok: false, code: BROWSER_OUTCOME.NO_LOCAL_CONTROL, status: null, step: 'local' };
    return fn(ctx, params);
  };
}

/**
 * The browser executors by event kind. Each takes `(ctx, params)`.
 * @type {Object<string, (ctx: object, params: object) => Promise<object>>}
 */
const BROWSER_EXECUTORS = Object.freeze({
  'browser.dashboard.load': _local(dashboardLoad),
  'browser.terminal.attach': _local(terminalAttach)
});

module.exports = { BROWSER_EXECUTORS, BROWSER_OUTCOME, BROWSER_LIMITS, DASHBOARD_PROBE, TERMINAL_FRAME, TERMINAL_ELEMENT };
