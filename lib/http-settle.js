'use strict';

/**
 * One HTTP request that is guaranteed to settle, on every path.
 *
 * **Why this module exists rather than a `http.request` call per site.** Settling
 * a request promise on `res.'end'` plus `req.'error'` looks exhaustive and is
 * not. When a socket dies *after* response headers but *before* the body
 * completes, Node destroys the response instead of pushing EOF: `end` never
 * fires, and the error surfaces on the **response** object, so the request's own
 * `error` never fires either. A `req.setTimeout` does not rescue it — that timer
 * is socket-inactivity based, so it dies with the socket it was measuring.
 * The promise then hangs forever and takes its caller with it.
 *
 * That defect shipped twice independently (#1024 in `lib/sidecar.js`, #1026 in
 * `lib/clawbridge.js`) and a review round explicitly *cleared* the second site
 * on the timeout reasoning above before a later round caught it. Two sites and
 * one wrong exoneration is the argument for one implementation instead of a
 * shape each call site is trusted to re-derive.
 *
 * Callers differ in how they settle, and that is deliberate: `lib/sidecar.js`
 * lets the rejection propagate, while `lib/clawbridge.js` resolves-never-rejects
 * into a structured result. So this module owns *termination* and hands back a
 * plain `{status, body}` or a tagged `Error`; it does not impose a result shape.
 *
 * Synthesized failures carry `name: 'AbortError'` (several callers already branch
 * on that to render "timeout") and a machine-readable `reason` from
 * `ABORT_REASONS` for callers that need to tell them apart. Errors raised by Node
 * itself pass through untouched.
 *
 * Not every HTTP client here needs this: `lib/tunnel.js` probes via `fetch` with
 * an `AbortController`, which rejects on a truncated body and whose timeout is
 * wall-clock rather than socket-inactivity. It is not affected.
 */

const http = require('node:http');

/**
 * Why a request was terminated by this module rather than by the peer.
 * @type {{TIMEOUT: string, ABORTED: string, CLOSED: string}}
 */
const ABORT_REASONS = {
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  CLOSED: 'closed'
};

/**
 * Issue one HTTP request and resolve its status and full body.
 *
 * The returned promise settles exactly once, whichever terminal event arrives
 * first — including the ones a socket death produces instead of `end`.
 *
 * @param {string|object} target - Absolute `http://` URL, or `node:http` request options (`host`/`port`/`path`).
 * @param {object} [opts] - Request options.
 * @param {string} [opts.method='GET'] - HTTP method.
 * @param {object} [opts.headers={}] - Request headers.
 * @param {import('node:http').Agent} [opts.agent] - Connection pool to dial through; omit for Node's default.
 * @param {string|Buffer|null} [opts.body=null] - Request body, written before `end()`.
 * @param {number} [opts.timeoutMs=5000] - Socket-inactivity budget; a wall-clock backstop fires at twice this.
 * @returns {Promise<{status: number, body: Buffer}>} Rejects with an `Error`; synthesized ones carry `name:'AbortError'` and a `reason` from `ABORT_REASONS`.
 */
function requestOnce(target, opts = {}) {
  const { method = 'GET', headers = {}, agent = null, body = null, timeoutMs = 5000 } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn(arg);
    };
    const fail = (reason, message) => settle(reject, Object.assign(
      new Error(message),
      { name: 'AbortError', reason }
    ));

    const overrides = { method, headers };
    if (agent) overrides.agent = agent;
    // A string target keeps `http.request`'s (url, options) form; an options
    // object is merged so the caller's host/port/path survive the overrides.
    const args = typeof target === 'string'
      ? [target, overrides]
      : [{ ...target, ...overrides }];

    const req = http.request(...args, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => settle(resolve, { status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      // The two events a mid-body socket death actually produces. Without them
      // the promise hangs, because `end` and `req.'error'` both stay silent.
      res.on('aborted', () => fail(ABORT_REASONS.ABORTED, 'response aborted'));
      res.on('error', (err) => settle(reject, err));
      // NOTE: `close` also fires on the normal path, immediately after `end`.
      // That is harmless only because `settle` is one-shot and `end` already
      // won the race — do not "tidy" this by dropping the listener, and do not
      // reorder it above `end`.
      res.on('close', () => fail(ABORT_REASONS.CLOSED, 'connection closed before response completed'));
    });

    req.setTimeout(timeoutMs, () => { req.destroy(); fail(ABORT_REASONS.TIMEOUT, 'timeout'); });
    req.on('error', (err) => settle(reject, err));
    // Backstop for any terminal state not enumerated above — notably a socket
    // that dies before the inactivity timer measuring it can ever fire. Unref'd
    // so a pending request never holds the process open on its own.
    deadline = setTimeout(() => { req.destroy(); fail(ABORT_REASONS.TIMEOUT, 'timeout'); }, timeoutMs * 2);
    if (typeof deadline.unref === 'function') deadline.unref();

    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { requestOnce, ABORT_REASONS };
