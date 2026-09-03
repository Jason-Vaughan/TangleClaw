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
   * The wall-clock budget for a probe.
   *
   * Overridable only through the test seam. A test proving the timeout path
   * fires should not have to spend the production budget in real time — the
   * assertion is about which branch runs, not how long it waits.
   *
   * @param {object} [deps] - Injection seam; `timeoutMs` overrides the default.
   * @returns {number}
   */
  function probeBudget(deps) {
    return deps && typeof deps.timeoutMs === 'number' ? deps.timeoutMs : PROBE_TIMEOUT_MS;
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
   * @param {object} [deps] - Injection seam for tests (`fetchImpl`, `AbortControllerImpl`, `timeoutMs`).
   * @returns {Promise<{reachable: boolean, status: number|null, reason: string|null}>}
   */
  async function probeProxy(connId, deps) {
    const url = `/openclaw-direct/${encodeURIComponent(connId)}/`;
    try {
      const res = await fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, probeBudget(deps), deps);
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

  /**
   * Terminal auto-approve outcomes: the gateway host could not be asked at all.
   *
   * These are not "nothing is pending" — they are TangleClaw failing to find
   * out. #1076 was filed because the distinction was being thrown away, and the
   * whole point of surfacing it on the indicator is that "could not check" must
   * never look like "checked, and fine".
   *
   * @type {string[]}
   */
  const PAIRING_UNCHECKABLE_CODES = ['SSH_FAILED', 'DOCKER_NOT_FOUND', 'NO_CONTAINER', 'APPROVE_FAILED', 'LIST_FAILED'];

  /**
   * Ask the OpenClaw gateway's own health endpoint whether it is answering.
   *
   * This is the one step past HTTP reachability that the gateway actually
   * exposes. Measured against the live fleet: the gateway serves its SPA shell
   * with `200 text/html` for EVERY unmatched path, and 404s everything under
   * `/api/`. So a 200 alone proves nothing — only a JSON body carrying `ok`
   * distinguishes "the gateway answered" from "the static server handed back
   * index.html". That is why the content is parsed rather than the status
   * trusted; a status-only check here would be a guard that scores nothing.
   *
   * What this does NOT prove: that the gateway can serve a session. The
   * endpoint reports process liveness only — a gateway with a malformed
   * database answers `{"ok":true,"status":"live"}` and then fails every real
   * request. The state this feeds is named for what it measured.
   *
   * Never throws, for the same reason `probeProxy` does not: a caller handling
   * a sick gateway should not also have to handle a sick probe.
   *
   * @param {string} connId - OpenClaw connection id.
   * @param {object} [deps] - Injection seam for tests (`fetchImpl`, `AbortControllerImpl`, `timeoutMs`).
   * @returns {Promise<{answered: boolean, ok: boolean, reason: string|null}>}
   */
  async function probeGateway(connId, deps) {
    const url = `/openclaw-direct/${encodeURIComponent(connId)}/health`;
    try {
      const res = await fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, probeBudget(deps), deps);
      const status = typeof res.status === 'number' ? res.status : 0;
      if (status < 200 || status >= 300) {
        return { answered: false, ok: false, reason: `gateway health returned ${status}` };
      }
      let body = null;
      try {
        body = await res.json();
      } catch (err) {
        // The SPA fallback lands here: 200, but HTML. Not an answer.
        return { answered: false, ok: false, reason: 'gateway did not answer its health check' };
      }
      if (!body || typeof body !== 'object') {
        return { answered: false, ok: false, reason: 'gateway health answer was not an object' };
      }
      if (body.ok === true) return { answered: true, ok: true, reason: null };
      return {
        answered: true,
        ok: false,
        reason: `gateway reports ${body.status ? String(body.status) : 'not ok'}`
      };
    } catch (err) {
      return {
        answered: false,
        ok: false,
        reason: err && err.name === 'TimeoutError' ? 'the gateway did not answer' : ((err && err.message) || 'health probe failed')
      };
    }
  }

  /**
   * Reduce what was actually measured to one indicator state.
   *
   * Three levels, and the middle one is the honest default. `live` is reserved
   * for "every check we can run came back clean" — so evidence that is missing,
   * unreadable, or says "could not tell" yields `unverified`, never `live`.
   * The reduction ONLY EVER DOWNGRADES: no combination of absent inputs can
   * manufacture a green indicator, which is the property that makes this an
   * honest surface rather than a prettier version of the bug it fixes.
   *
   * `live` does not mean "known good" — it means nothing we can check is wrong.
   * Whether THIS browser is paired with the gateway is not observable from
   * here at all (it is a WebSocket-level fact held in the frame's own storage),
   * so the labels never claim it.
   *
   * @param {object} [evidence]
   * @param {{reachable: boolean, reason: string|null}|null} [evidence.probe] - `probeProxy` result.
   * @param {{ok: boolean, reason: string|null}|null} [evidence.health] - `probeGateway` result.
   * @param {{approved: boolean, code: string, reason: string, count: number}|null} [evidence.approve] - Latest `approve-pending` answer.
   * @param {string} [evidence.connName] - Human name of the connection, for the label.
   * @returns {{level: 'dead'|'unverified'|'live', label: string, detail: string|null}}
   */
  function deriveConnectionState(evidence) {
    const e = evidence || {};
    const who = e.connName ? `“${e.connName}”` : 'this connection';

    const probe = e.probe;
    // Not yet probed is not the same as probed and failed. Collapsing the two
    // painted a normally-starting connection red for the whole tunnel budget —
    // a measured failure reported before any measurement, which is the exact
    // defect class this indicator exists to remove, pointing the other way.
    if (probe === null || probe === undefined) {
      return { level: 'checking', label: `Checking ${who}\u2026`, detail: null };
    }
    if (probe.reachable !== true) {
      const why = probe.reason || 'the tunnel could not be probed';
      return { level: 'dead', label: `Not connected — ${why}`, detail: why };
    }

    const health = e.health;
    if (!health || health.ok !== true) {
      const why = (health && health.reason) || 'the gateway was not checked';
      return {
        level: 'unverified',
        label: `Tunnel up, gateway unverified — ${why}`,
        detail: why
      };
    }

    const approve = e.approve;
    if (!approve || typeof approve !== 'object') {
      return {
        level: 'unverified',
        label: 'Tunnel up, gateway answering — pairing not checked yet',
        detail: null
      };
    }
    if (typeof approve.count === 'number' && approve.count > 0 && approve.approved !== true) {
      const n = approve.count;
      return {
        level: 'unverified',
        label: `Tunnel up — ${n} device${n === 1 ? '' : 's'} awaiting approval on ${who}`,
        detail: approve.reason || null
      };
    }
    if (PAIRING_UNCHECKABLE_CODES.indexOf(approve.code) !== -1) {
      return {
        level: 'unverified',
        label: `Tunnel up — TangleClaw could not check pairing (${approve.code})`,
        detail: approve.reason || null
      };
    }
    if (approve.approved === true || approve.code === 'NO_PENDING') {
      return { level: 'live', label: 'Connected — gateway answering, nothing pending', detail: null };
    }
    return {
      level: 'unverified',
      label: 'Tunnel up, gateway answering — pairing state unknown',
      detail: approve.reason || null
    };
  }

  /**
   * Every level class the indicator can carry.
   *
   * Exported so the caller clears the set rather than adding to it: the
   * reported bug was an indicator that ACCUMULATED classes, and a `.dead`
   * added on top of a still-present green class is invisible. Callers must
   * remove all of these before adding one.
   *
   * @type {string[]}
   */
  const CONNECTION_STATE_CLASSES = ['checking', 'dead', 'unverified', 'live'];

  /**
   * Put a derived state onto the indicator element.
   *
   * Clears every level class before applying one, so states replace rather
   * than stack, and writes the label to `title` AND `aria-label` — a colour
   * alone is not an accessible status, and on a touch device there is no
   * hover to reveal a tooltip.
   *
   * @param {Element|null} el - The indicator element.
   * @param {{level: string, label: string}} state - A `deriveConnectionState` result.
   * @returns {void}
   */
  function applyConnectionState(el, state) {
    if (!el || !state) return;
    for (const cls of CONNECTION_STATE_CLASSES) el.classList.remove(cls);
    el.classList.add(state.level);
    el.title = state.label;
    el.setAttribute('aria-label', `Connection status: ${state.label}`);
  }

  /**
   * An indicator that accumulates measurements and re-renders on every one.
   *
   * This lives here, rather than in the page, so that "recording a measurement
   * re-renders the dot" is a property a test can EXECUTE. The same reduction
   * spelled inline in the view could only ever be checked by pattern-matching
   * its source, and a source match is satisfied by any call site — including
   * one that skips the case you care about.
   *
   * @param {Element|(() => Element|null)} target - The indicator element, or a getter for it.
   * @returns {{record: (key: string, value: *) => object, state: () => object, evidence: object}}
   */
  function createConnectionIndicator(target) {
    const evidence = { probe: null, health: null, approve: null, connName: null };
    const resolve = () => (typeof target === 'function' ? target() : target);
    return {
      /**
       * Record one measurement, then re-render from ALL of them.
       * @param {'probe'|'health'|'approve'|'connName'} key - Which measurement landed.
       * @param {*} value - The measurement.
       * @returns {object} The state now showing.
       */
      /**
       * Render a terminal failure whose reason the caller already phrased.
       * Routed through the same applier so it cannot stack classes.
       * @param {string} label - Operator-facing sentence.
       * @returns {object}
       */
      fail(label) {
        const state = { level: 'dead', label, detail: null };
        applyConnectionState(resolve(), state);
        return state;
      },
      record(key, value) {
        evidence[key] = value;
        const state = deriveConnectionState(evidence);
        applyConnectionState(resolve(), state);
        return state;
      },
      /**
       * The state the current evidence reduces to, without re-rendering.
       * @returns {object}
       */
      state() { return deriveConnectionState(evidence); },
      /**
       * A COPY of the evidence, for inspection. Deliberately not the record
       * itself: handing back the live object lets a caller write to it without
       * re-rendering, which is the invariant this factory exists to hold.
       * @returns {object}
       */
      snapshot() { return Object.assign({}, evidence); }
    };
  }

  const apiSurface = {
    fetchWithTimeout,
    callWithTimeout,
    probeProxy,
    probeGateway,
    deriveConnectionState,
    applyConnectionState,
    createConnectionIndicator,
    describeTunnelFailure,
    PAIRING_UNCHECKABLE_CODES,
    CONNECTION_STATE_CLASSES,
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
