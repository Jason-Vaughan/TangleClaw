'use strict';
/* ── TangleClaw v3 — OpenClaw tunnel start: bounded waits, honest states ── */
/*                                                                          */
/* #1012. Two silences made a broken tunnel look like a slow one, and then  */
/* like somebody else's bug.                                                */
/*                                                                          */
/* 1. `POST /tunnel` was awaited through the shared `api()` helper, which    */
/*    uses bare `fetch` with no abort. A tunnel that never comes up leaves   */
/*    the request pending forever, under a "Starting tunnel…" toast that is  */
/*    deliberately persistent (duration 0). There is no state in which the   */
/*    UI says the attempt ended.                                            */
/*                                                                          */
/* 2. Even on a 200, nothing checked that the proxy could actually serve     */
/*    before the iframe was pointed at it. When the tunnel dropped between   */
/*    the 200 and the bundle request, the frame rendered OPENCLAW'S OWN      */
/*    error card — which blames "a browser extension or early content        */
/*    script" — while TangleClaw's banner still read "Tunnel established".   */
/*    The operator was handed a wrong diagnosis from a different repo while  */
/*    our own proxy had already logged ECONNRESET/ECONNREFUSED.             */
/*                                                                          */
/* Deliberately NOT a UI-lifecycle timer. This project bans timer-driven UI  */
/* lifecycle (auto-dismiss/redirect/close — #98, #268), and "give up on the  */
/* spinner after N seconds" is that shape. What is bounded here is the       */
/* REQUEST (an AbortController on one fetch) and what replaces the unknown   */
/* is a PRE-FLIGHT PROBE — a single real request to the proxy path, whose    */
/* answer is a fact rather than an elapsed time. Nothing is scheduled and    */
/* nothing dismisses itself.                                                */
/*                                                                          */
/* Same UMD-ish factory pattern as api-helper.js / openclaw-cache.js.        */

(function (global) {
  /** @type {number} Budget for the tunnel-start POST. Generous: the issue records a legitimate 6044ms start. */
  const TUNNEL_START_TIMEOUT_MS = 30000;
  /** @type {number} Budget for the pre-flight probe, which is a loopback request through an already-open tunnel. */
  const PROBE_TIMEOUT_MS = 8000;

  /**
   * Run one fetch under a hard wall-clock budget, so a request that never
   * answers cannot hold the caller open.
   *
   * Resolves the `Response`. Throws on network failure, and on timeout throws
   * an `Error` carrying `name: 'TimeoutError'` so the caller can tell "the
   * tunnel refused" from "the tunnel never answered" — different sentences to
   * the operator, and the distinction is the whole point of the issue.
   *
   * @param {string} url - Request URL.
   * @param {object} [opts] - `fetch` options; a caller-supplied `signal` is respected alongside the budget.
   * @param {number} [timeoutMs] - Milliseconds before the request is abandoned.
   * @param {object} [deps] - Injection seam for tests.
   * @param {typeof fetch} [deps.fetchImpl] - `fetch` replacement.
   * @param {typeof AbortController} [deps.AbortControllerImpl] - `AbortController` replacement.
   * @returns {Promise<Response>}
   */
  async function fetchWithTimeout(url, opts, timeoutMs, deps) {
    const d = deps || {};
    const f = d.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const AC = d.AbortControllerImpl || (typeof AbortController !== 'undefined' ? AbortController : null);
    if (!f) throw new Error('no fetch implementation available');

    const budget = typeof timeoutMs === 'number' ? timeoutMs : TUNNEL_START_TIMEOUT_MS;
    // No AbortController (very old browser, or a test stub that omits it):
    // still issue the request rather than failing closed. The caller loses the
    // bound, which is the pre-#1012 behaviour — degraded, not broken.
    if (!AC) return f(url, opts || {});

    const controller = new AC();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
    try {
      return await f(url, Object.assign({}, opts, { signal: controller.signal }));
    } catch (err) {
      if (timedOut) {
        throw Object.assign(new Error(`timed out after ${budget}ms`), { name: 'TimeoutError', timeoutMs: budget });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run one abortable async call under a hard wall-clock budget.
   *
   * Takes a `runner(signal)` rather than a URL so the call can go through the
   * page's own `api()` helper, which must NOT be bypassed: it carries the
   * service-worker cache-fallback check (#709) and the ingress 502/503/504
   * discrimination (#924), and a tunnel start that skipped those would render a
   * dead backend as a healthy tunnel — the very class of lie this issue is about.
   *
   * @param {(signal: AbortSignal|undefined) => Promise<any>} runner - Performs the call with the supplied signal.
   * @param {number} timeoutMs - Milliseconds before the call is abandoned.
   * @param {object} [deps] - Injection seam for tests (`AbortControllerImpl`).
   * @returns {Promise<{timedOut: boolean, value: any}>} `timedOut` distinguishes "never answered" from "answered no".
   */
  async function callWithTimeout(runner, timeoutMs, deps) {
    const d = deps || {};
    const AC = d.AbortControllerImpl || (typeof AbortController !== 'undefined' ? AbortController : null);
    // No AbortController: run unbounded rather than fail closed — degraded to
    // the pre-#1012 behaviour, not broken.
    if (!AC) return { timedOut: false, value: await runner(undefined) };

    const controller = new AC();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const value = await runner(controller.signal);
      return { timedOut, value };
    } catch (err) {
      if (timedOut) return { timedOut: true, value: null };
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask the proxy, once, whether it can actually serve this connection before
   * the iframe is pointed at it.
   *
   * This is the check whose absence let a dead tunnel render as an OpenClaw
   * extension warning. It requests the connection's proxy base — the same path
   * the frame is about to load — and reports what came back. A 5xx here is the
   * proxy telling us the upstream is gone; that is a TangleClaw fact, and it
   * belongs in a TangleClaw message.
   *
   * Never throws: a probe that itself fails is reported as `reachable: false`
   * with a reason, because a caller that must handle a dead tunnel should not
   * also have to handle a dead probe.
   *
   * Uses raw `fetch` rather than the page's `api()` on purpose — unlike the
   * tunnel-start call, this path serves HTML, and `api()` parses every response
   * as JSON. Its status code is the entire signal here.
   *
   * @param {string} connId - OpenClaw connection id.
   * @param {object} [deps] - Injection seam for tests (`fetchImpl`, `AbortControllerImpl`).
   * @returns {Promise<{reachable: boolean, status: number|null, reason: string|null}>}
   */
  async function probeProxy(connId, deps) {
    const url = `/openclaw-direct/${encodeURIComponent(connId)}/`;
    try {
      const res = await fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, PROBE_TIMEOUT_MS, deps);
      const status = typeof res.status === 'number' ? res.status : 0;
      if (status >= 200 && status < 400) return { reachable: true, status, reason: null };
      // 502/503/504 is the proxy reporting a dead upstream; anything else is
      // still a refusal to serve the page the frame needs.
      return { reachable: false, status, reason: `proxy returned ${status}` };
    } catch (err) {
      return {
        reachable: false,
        status: null,
        reason: err && err.name === 'TimeoutError' ? 'the proxy did not answer' : ((err && err.message) || 'probe failed')
      };
    }
  }

  /**
   * The operator-facing sentence for a tunnel that did not come up.
   *
   * Always names the connection. The #1012 report is a case of the operator
   * reading a message about browser extensions, from another repo, for a
   * TangleClaw tunnel drop — so an anonymous "Tunnel failed" is not enough:
   * with four connections on one host, which one failed IS the information.
   *
   * @param {string} kind - `timeout` · `refused` · `unreachable` · `probe`.
   * @param {string} connName - Human name of the connection.
   * @param {string} [detail] - Optional specific reason to append.
   * @returns {string}
   */
  function describeTunnelFailure(kind, connName, detail) {
    const who = connName ? `“${connName}”` : 'this connection';
    const tail = detail ? ` (${detail})` : '';
    switch (kind) {
      case 'timeout':
        return `Tunnel for ${who} did not come up in time — it may still be starting. Check SSH connectivity, then retry.${tail}`;
      case 'probe':
        return `Tunnel for ${who} came up but dropped before the page could load${tail}. This is a TangleClaw tunnel problem, not a browser or extension problem.`;
      case 'refused':
        return `Tunnel for ${who} failed to start — check SSH connectivity.${tail}`;
      default:
        return `Tunnel for ${who} is not usable${tail}.`;
    }
  }

  const apiSurface = {
    fetchWithTimeout,
    callWithTimeout,
    probeProxy,
    describeTunnelFailure,
    TUNNEL_START_TIMEOUT_MS,
    PROBE_TIMEOUT_MS
  };

  // Browser: expose on window so /openclaw-view.js can call it.
  if (global) {
    global.tcTunnelState = apiSurface;
  }
  // Node (test): expose via CommonJS module.exports too.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = apiSurface;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
