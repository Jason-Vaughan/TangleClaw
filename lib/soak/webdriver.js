'use strict';

/**
 * The few W3C WebDriver commands the soak's browser events need, over
 * `fetch`, so the project stays free of dependencies (#2020).
 *
 * The WebDriver is `safaridriver` inside the soak guest, reached on loopback
 * (`--webdriver`, admitted by `lib/soak/local.js`). Every command resolves to
 * `{ok, value}` or `{ok: false, code, error}` and never throws, so a browser
 * event can always close its session and record what happened.
 *
 * @module lib/soak/webdriver
 */

/** Per-command budget. A page load can take a while in a loaded guest, but never forever. */
const COMMAND_TIMEOUT_MS = 60 * 1000;

/** Closed set of WebDriver failure codes. */
const WD_OUTCOME = Object.freeze({
  WD_NETWORK: 'WD_NETWORK',
  WD_TIMEOUT: 'WD_TIMEOUT',
  WD_BAD_BODY: 'WD_BAD_BODY',
  // The WebDriver answered with a W3C error; `error` carries its name.
  WD_ERROR: 'WD_ERROR'
});

/**
 * The W3C key under which an element reference is returned.
 * @see https://www.w3.org/TR/webdriver2/#elements
 */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/**
 * Send one WebDriver command.
 * @param {object} ctx - `{fetch}` and `local.webdriver`, the WebDriver origin
 * @param {string} method - HTTP method
 * @param {string} path - Command path, beginning with `/session`
 * @param {object} [body] - JSON body
 * @returns {Promise<{ok: true, value: *}|{ok: false, code: string, error: string|null}>} The command's value, or why not
 */
async function command(ctx, method, path, body) {
  let res;
  try {
    res = await ctx.fetch(new URL(path, ctx.local.webdriver), {
      method,
      redirect: 'manual',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.webdriverTimeoutMs || COMMAND_TIMEOUT_MS)
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: a WebDriver that cannot be reached is a recorded outcome
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, code: timedOut ? WD_OUTCOME.WD_TIMEOUT : WD_OUTCOME.WD_NETWORK, error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(await res.text());
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: a cut-off or non-JSON body is a recorded outcome
    return { ok: false, code: WD_OUTCOME.WD_BAD_BODY, error: null };
  }
  if (!parsed || typeof parsed !== 'object' || !('value' in parsed)) return { ok: false, code: WD_OUTCOME.WD_BAD_BODY, error: null };
  if (res.status < 200 || res.status > 299) {
    const error = parsed.value && typeof parsed.value.error === 'string' ? parsed.value.error : `http-${res.status}`;
    return { ok: false, code: WD_OUTCOME.WD_ERROR, error };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Start a browser session.
 * @param {object} ctx - Call context with `local.webdriver`
 * @returns {Promise<{ok: true, sessionId: string}|{ok: false, code: string, error: string|null}>} The session id, or why not
 */
async function newSession(ctx) {
  const r = await command(ctx, 'POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  if (!r.ok) return r;
  if (!r.value || typeof r.value.sessionId !== 'string') return { ok: false, code: WD_OUTCOME.WD_BAD_BODY, error: null };
  return { ok: true, sessionId: r.value.sessionId };
}

/**
 * A session's command path.
 * @param {string} sessionId - Session id
 * @param {string} [rest] - Command suffix
 * @returns {string} `/session/<id><rest>`
 */
function _s(sessionId, rest = '') {
  return `/session/${encodeURIComponent(sessionId)}${rest}`;
}

/**
 * Navigate the session to a URL and wait for the load.
 * @param {object} ctx - Call context
 * @param {string} sessionId - Session id
 * @param {string} url - Absolute URL
 * @returns {Promise<object>} Command result
 */
function navigate(ctx, sessionId, url) {
  return command(ctx, 'POST', _s(sessionId, '/url'), { url });
}

/**
 * Run a script in the page and return its result.
 * @param {object} ctx - Call context
 * @param {string} sessionId - Session id
 * @param {string} script - Function body; its `return` value comes back
 * @returns {Promise<object>} Command result
 */
function execute(ctx, sessionId, script) {
  return command(ctx, 'POST', _s(sessionId, '/execute/sync'), { script, args: [] });
}

/**
 * Find one element by CSS selector.
 * @param {object} ctx - Call context
 * @param {string} sessionId - Session id
 * @param {string} selector - CSS selector
 * @returns {Promise<{ok: true, element: object}|{ok: false, code: string, error: string|null}>} The element reference, or why not
 */
async function findElement(ctx, sessionId, selector) {
  const r = await command(ctx, 'POST', _s(sessionId, '/element'), { using: 'css selector', value: selector });
  if (!r.ok) return r;
  if (!r.value || typeof r.value[ELEMENT_KEY] !== 'string') return { ok: false, code: WD_OUTCOME.WD_BAD_BODY, error: null };
  return { ok: true, element: r.value };
}

/**
 * Switch the session into a frame, by its element reference.
 * @param {object} ctx - Call context
 * @param {string} sessionId - Session id
 * @param {object} element - Reference from `findElement`
 * @returns {Promise<object>} Command result
 */
function switchToFrame(ctx, sessionId, element) {
  return command(ctx, 'POST', _s(sessionId, '/frame'), { id: element });
}

/**
 * End a browser session. Safari allows one session at a time, so every
 * event ends its own whatever else failed.
 * @param {object} ctx - Call context
 * @param {string} sessionId - Session id
 * @returns {Promise<object>} Command result
 */
function deleteSession(ctx, sessionId) {
  return command(ctx, 'DELETE', _s(sessionId));
}

module.exports = { WD_OUTCOME, ELEMENT_KEY, COMMAND_TIMEOUT_MS, command, newSession, navigate, execute, findElement, switchToFrame, deleteSession };
