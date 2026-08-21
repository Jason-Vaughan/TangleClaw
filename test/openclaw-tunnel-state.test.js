'use strict';

/*
 * #1012 — a tunnel that is not usable must say so, as a TangleClaw fact.
 *
 * The reported failure: TC's banner read "Tunnel established" while the iframe
 * rendered OpenClaw's own error card blaming "a browser extension or early
 * content script". Two silences produced that. The tunnel-start POST went
 * through a bare `fetch` with no abort, so a start that never answered left a
 * deliberately-persistent "Starting tunnel…" toast up forever; and nothing
 * checked the proxy could serve before the frame was pointed at it, so a drop
 * between the 200 and the bundle request surfaced as somebody else's bug.
 *
 * Behavioural tests against injected fetch/AbortController stubs, plus
 * source-level assertions that openclaw-view.js actually routes through these
 * helpers (a helper nothing calls is the failure mode this file exists under).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  fetchWithTimeout, callWithTimeout, probeProxy, describeTunnelFailure,
  TUNNEL_START_TIMEOUT_MS, PROBE_TIMEOUT_MS
} = require('../public/openclaw-tunnel-state.js');

/** Minimal AbortController stand-in so tests never depend on the host's. */
function makeAC() {
  return class {
    constructor() {
      this.signal = { aborted: false, _fns: [] };
      this.signal.addEventListener = (_t, fn) => this.signal._fns.push(fn);
    }
    abort() {
      this.signal.aborted = true;
      for (const fn of this.signal._fns) fn();
    }
  };
}

/** A fetch that never settles until the signal aborts, then rejects like the real one. */
function neverAnswers() {
  return (_url, opts) => new Promise((_resolve, reject) => {
    const signal = opts && opts.signal;
    if (!signal) return; // hangs forever, which is the pre-fix behaviour
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    });
  });
}

describe('#1012 callWithTimeout — the tunnel start is bounded', () => {
  it('reports timedOut when the call never answers, instead of hanging', async () => {
    const settled = await Promise.race([
      callWithTimeout(
        (signal) => new Promise((_r, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
        40,
        { AbortControllerImpl: makeAC() }
      ),
      new Promise((r) => setTimeout(() => r('HUNG'), 3000))
    ]);
    assert.notEqual(settled, 'HUNG', 'an unanswered tunnel start must end, not hang');
    assert.equal(settled.timedOut, true);
    assert.equal(settled.value, null);
  });

  it('passes the signal to the runner so api() can carry it through to fetch', async () => {
    let seen = null;
    const r = await callWithTimeout((signal) => { seen = signal; return Promise.resolve({ ok: true }); },
      1000, { AbortControllerImpl: makeAC() });
    assert.ok(seen, 'runner must receive a signal — without it api() cannot be aborted');
    assert.equal(r.timedOut, false);
    assert.deepEqual(r.value, { ok: true });
  });

  it('returns the answer unchanged when the call is simply refused (not a timeout)', async () => {
    // api() returns null for every refusal; that must NOT be reported as a timeout,
    // because the two produce different sentences to the operator.
    const r = await callWithTimeout(() => Promise.resolve(null), 1000, { AbortControllerImpl: makeAC() });
    assert.equal(r.timedOut, false);
    assert.equal(r.value, null);
  });

  it('still runs the call when the environment has no AbortController', async () => {
    const r = await callWithTimeout(() => Promise.resolve({ ok: true }), 10, { AbortControllerImpl: null });
    assert.deepEqual(r.value, { ok: true }, 'degrade to unbounded rather than fail closed');
  });

  it('rethrows a genuine error rather than disguising it as a timeout', async () => {
    await assert.rejects(
      () => callWithTimeout(() => Promise.reject(new Error('boom')), 1000, { AbortControllerImpl: makeAC() }),
      /boom/
    );
  });
});

describe('#1012 probeProxy — the tunnel is verified before the frame loads', () => {
  it('reports reachable on a 200 from the connection proxy path', async () => {
    let calledUrl = null;
    const r = await probeProxy('abc-123', {
      fetchImpl: (url) => { calledUrl = url; return Promise.resolve({ status: 200 }); },
      AbortControllerImpl: makeAC()
    });
    assert.deepEqual(r, { reachable: true, status: 200, reason: null });
    assert.equal(calledUrl, '/openclaw-direct/abc-123/',
      'must probe the same proxy base the frame is about to load');
  });

  it('reports NOT reachable on a 502 — the proxy saying its upstream is gone', async () => {
    // THE regression guard. This is the state the reported failure was in when
    // TC said "Tunnel established" and OpenClaw blamed a browser extension.
    const r = await probeProxy('abc-123', {
      fetchImpl: () => Promise.resolve({ status: 502 }),
      AbortControllerImpl: makeAC()
    });
    assert.equal(r.reachable, false);
    assert.equal(r.status, 502);
    assert.match(r.reason, /502/);
  });

  it('reports NOT reachable when the proxy never answers, rather than hanging', async () => {
    const settled = await Promise.race([
      probeProxy('abc-123', { fetchImpl: neverAnswers(), AbortControllerImpl: makeAC() }),
      new Promise((r) => setTimeout(() => r('HUNG'), 12000))
    ]);
    assert.notEqual(settled, 'HUNG');
    assert.equal(settled.reachable, false);
    assert.equal(settled.reason, 'the proxy did not answer');
  });

  it('never throws, even when the probe itself fails', async () => {
    const r = await probeProxy('abc-123', {
      fetchImpl: () => Promise.reject(new Error('network down')),
      AbortControllerImpl: makeAC()
    });
    assert.equal(r.reachable, false);
    assert.equal(r.reason, 'network down');
  });

  it('URL-encodes the connection id', async () => {
    let calledUrl = null;
    await probeProxy('a/b c', {
      fetchImpl: (url) => { calledUrl = url; return Promise.resolve({ status: 200 }); },
      AbortControllerImpl: makeAC()
    });
    assert.equal(calledUrl, '/openclaw-direct/a%2Fb%20c/');
  });
});

describe('#1012 describeTunnelFailure — names the connection, and owns the blame', () => {
  it('names the connection in every failure kind', () => {
    for (const kind of ['timeout', 'probe', 'refused', 'anything-else']) {
      const msg = describeTunnelFailure(kind, 'TiLT Claw');
      assert.match(msg, /TiLT Claw/,
        `"${kind}" must name the connection — with four gateways on one host, which one failed IS the information`);
    }
  });

  it('says the mid-load drop is OURS, not the browser\'s', () => {
    // The whole point of the issue: the operator was handed another repo's
    // "a browser extension may be blocking module execution" for a TC tunnel drop.
    const msg = describeTunnelFailure('probe', 'TiLT Claw', 'proxy returned 502');
    assert.match(msg, /TangleClaw tunnel problem/);
    assert.match(msg, /not a browser or extension problem/);
    assert.match(msg, /502/, 'carries the specific reason');
  });

  it('distinguishes a timeout from a refusal', () => {
    const t = describeTunnelFailure('timeout', 'RentalClaw');
    const r = describeTunnelFailure('refused', 'RentalClaw');
    assert.notEqual(t, r, 'never-answered and answered-no are different facts');
    assert.match(t, /did not come up in time/);
    assert.match(r, /failed to start/);
  });

  it('degrades without a connection name rather than printing undefined', () => {
    const msg = describeTunnelFailure('timeout', '');
    assert.doesNotMatch(msg, /undefined|null/);
    assert.match(msg, /this connection/);
  });
});

describe('#1012 wiring — openclaw-view.js actually uses the helpers', () => {
  const viewSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'openclaw-view.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'openclaw-view.html'), 'utf8');

  it('loads the helper script before the view script', () => {
    const helper = htmlSrc.indexOf('openclaw-tunnel-state.js');
    const view = htmlSrc.indexOf('openclaw-view.js');
    assert.ok(helper !== -1, 'openclaw-view.html must load openclaw-tunnel-state.js');
    assert.ok(helper < view, 'the helper must load before the view that calls it');
  });

  it('bounds the tunnel-start call', () => {
    assert.match(viewSrc, /tcTunnelState\.callWithTimeout/);
    assert.match(viewSrc, /TUNNEL_START_TIMEOUT_MS/);
  });

  it('probes the proxy BEFORE pointing the frame at it', () => {
    const probeAt = viewSrc.indexOf('tcTunnelState.probeProxy');
    // The CALL SITE, not `function setFrameSrc(frame, url)` — that definition
    // sits above everything and would make this assertion pass on any ordering.
    const frameAt = viewSrc.indexOf('setFrameSrc(frame, `/openclaw-direct/');
    assert.ok(probeAt !== -1, 'the pre-flight probe must be called');
    assert.ok(frameAt !== -1, 'the initial frame load must still happen');
    assert.ok(probeAt < frameAt,
      'probing after the frame loads defeats the point — the bad page is already rendered');
  });

  it('still routes the tunnel start through api(), not raw fetch', () => {
    // Bypassing api() would drop the service-worker (#709) and ingress (#924)
    // checks, rendering a dead backend as a healthy tunnel — the same class of
    // lie this issue is about.
    assert.match(viewSrc, /api\(`\/api\/openclaw\/connections\/\$\{encodeURIComponent\(connId\)\}\/tunnel`/);
  });

  it('renders every tunnel failure through one persistent terminal state', () => {
    assert.match(viewSrc, /function failTunnel/);
    // showToast(..., 'warn', 0) — 0 is "do not auto-dismiss" (#98/#268: no timer-driven UI lifecycle).
    assert.match(viewSrc, /showToast\(message, 'warn', 0\)/);
  });
});
