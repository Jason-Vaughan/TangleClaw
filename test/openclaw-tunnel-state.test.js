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
    // Budget injected, not waited out: the assertion is that the timeout
    // BRANCH runs and reports honestly, and spending the real 8s budget to
    // prove it made this one test the slowest thing in the suite. The
    // hang-guard is cleared so a settled probe does not hold the process open.
    let guard;
    const settled = await Promise.race([
      probeProxy('abc-123', { fetchImpl: neverAnswers(), AbortControllerImpl: makeAC(), timeoutMs: 25 }),
      new Promise((r) => { guard = setTimeout(() => r('HUNG'), 5000); })
    ]);
    clearTimeout(guard);
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

/*
 * #1012, second half — the indicator must not claim more than was measured.
 *
 * The reported symptom was a green dot on a connection that could not serve a
 * byte. Three things produced it: `.status-dot.dead` and `.status-dot.live`
 * had no CSS rule at all (so the base green survived every outcome), the
 * "Connected" title was set on the strength of an HTML 200 from the proxy,
 * and the auto-approve answer — which knows devices are pending, or that we
 * could not ask — reached the toasts and nothing else.
 */

const { probeGateway, deriveConnectionState, applyConnectionState, createConnectionIndicator,
  CONNECTION_STATE_CLASSES, PAIRING_UNCHECKABLE_CODES } = require('../public/openclaw-tunnel-state.js');

/** Minimal Response double: only what probeGateway reads. */
function jsonRes(status, body, throwOnJson) {
  return {
    status,
    json: async () => {
      if (throwOnJson) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    }
  };
}

describe('#1012 probeGateway — a 200 is not an answer', () => {
  it('reports ok on a JSON body carrying ok:true', async () => {
    const res = await probeGateway('c1', { fetchImpl: async () => jsonRes(200, { ok: true, status: 'live' }) });
    assert.deepEqual(res, { answered: true, ok: true, reason: null });
  });

  it('does NOT accept the SPA fallback — 200 text/html is not a health answer', async () => {
    // The live gateway serves index.html with 200 for every unmatched path.
    // A status-only check here would pass against a gateway that has no
    // health endpoint at all, which is the guard-that-scores-nothing shape.
    const res = await probeGateway('c1', { fetchImpl: async () => jsonRes(200, null, true) });
    assert.equal(res.answered, false);
    assert.equal(res.ok, false);
    assert.match(res.reason, /did not answer/);
  });

  it('reports not-ok when the gateway answers ok:false, and quotes its status', async () => {
    const res = await probeGateway('c1', { fetchImpl: async () => jsonRes(200, { ok: false, status: 'degraded' }) });
    assert.equal(res.answered, true);
    assert.equal(res.ok, false);
    assert.match(res.reason, /degraded/);
  });

  it('reports the status code when the gateway refuses', async () => {
    const res = await probeGateway('c1', { fetchImpl: async () => jsonRes(502, null) });
    assert.equal(res.ok, false);
    assert.match(res.reason, /502/);
  });

  it('never throws when the probe itself fails', async () => {
    const res = await probeGateway('c1', { fetchImpl: async () => { throw new Error('boom'); } });
    assert.equal(res.ok, false);
    assert.equal(res.answered, false);
  });

  it('URL-encodes the connection id', async () => {
    let seen = null;
    await probeGateway('a/b c', { fetchImpl: async (url) => { seen = url; return jsonRes(200, { ok: true }); } });
    assert.ok(!seen.includes('a/b c'), 'raw id must not be interpolated');
    assert.ok(seen.includes(encodeURIComponent('a/b c')));
  });
});

describe('#1012 deriveConnectionState — green means verified', () => {
  const up = { reachable: true, reason: null };
  const healthy = { answered: true, ok: true, reason: null };

  it('is CHECKING before any probe has been attempted — not dead', () => {
    // A connection whose tunnel is still starting has not failed. Reporting
    // `dead` here paints a healthy load red for the whole tunnel budget, and
    // is the same "state a fact you did not measure" defect as the green dot,
    // pointing the other way.
    assert.equal(deriveConnectionState({}).level, 'checking');
    assert.equal(deriveConnectionState({ connName: 'Kobold' }).level, 'checking');
    assert.equal(deriveConnectionState({ probe: null, health: healthy }).level, 'checking');
  });

  it('recording anything BEFORE the probe leaves the dot on checking', () => {
    // init() records connName before the tunnel POST is even sent.
    const ind = createConnectionIndicator(null);
    assert.equal(ind.record('connName', 'Kobold').level, 'checking');
  });

  it('is dead when the proxy could not serve', () => {
    const s = deriveConnectionState({ probe: { reachable: false, reason: 'proxy returned 502' }, health: healthy });
    assert.equal(s.level, 'dead');
    assert.match(s.label, /502/);
  });

  it('is unverified when the gateway did not answer, even though the proxy did', () => {
    const s = deriveConnectionState({ probe: up, health: { answered: false, ok: false, reason: 'gateway did not answer its health check' } });
    assert.equal(s.level, 'unverified');
  });

  it('is unverified while pairing has not been checked yet', () => {
    const s = deriveConnectionState({ probe: up, health: healthy, approve: null });
    assert.equal(s.level, 'unverified');
    assert.match(s.label, /not checked yet/);
  });

  it('is unverified when devices are awaiting approval, and says how many', () => {
    const s = deriveConnectionState({ probe: up, health: healthy, connName: 'Kobold',
      approve: { approved: false, code: 'MISSING_REQUEST_ID', count: 2, reason: 'x' } });
    assert.equal(s.level, 'unverified');
    assert.match(s.label, /2 devices/);
    assert.match(s.label, /Kobold/);
  });

  it('is unverified for every outcome that means "could not ask the host"', () => {
    // Kobold and Volta run OpenClaw natively; the docker-based approve path
    // cannot reach them at all. "Could not check" must not look like "fine".
    // Named explicitly rather than looped over the constant under test —
    // iterating the list to check the list passes vacuously when it is empty.
    const mustDowngrade = ['SSH_FAILED', 'DOCKER_NOT_FOUND', 'NO_CONTAINER', 'APPROVE_FAILED', 'LIST_FAILED'];
    for (const code of mustDowngrade) {
      assert.ok(PAIRING_UNCHECKABLE_CODES.includes(code), `${code} missing from the downgrade list`);
      const s = deriveConnectionState({ probe: up, health: healthy, approve: { approved: false, code, count: 0, reason: code } });
      assert.equal(s.level, 'unverified', `${code} must not reach live`);
      assert.match(s.label, /could not check pairing/);
    }
  });

  it('covers the WHOLE server-side code family — a new code cannot arrive unmapped', () => {
    // The list is a client-side copy of server outcomes. The failure that
    // matters is not a typo in what we have, it is a code the server starts
    // returning that this reduction has never heard of quietly landing on
    // green. Enumerate from the server's own constants, not from ours.
    const { CODES } = require('../lib/openclaw-approve.js');
    const serverCodes = Object.values(CODES);
    assert.ok(serverCodes.length >= 8, 'server code family looks truncated');
    const mayBeLive = ['APPROVED', 'NO_PENDING'];
    for (const code of serverCodes) {
      const s = deriveConnectionState({
        probe: up, health: healthy,
        approve: { approved: code === 'APPROVED', code, count: 0, reason: code }
      });
      if (!mayBeLive.includes(code)) {
        assert.notEqual(s.level, 'live', `${code} must not render as a verified connection`);
      }
    }
    // And every code this client calls uncheckable must be a real server code.
    for (const code of PAIRING_UNCHECKABLE_CODES) {
      assert.ok(serverCodes.includes(code), `${code} is not a code the server can return`);
    }
  });

  it('is live only when reachable, answering, and nothing pending', () => {
    const s = deriveConnectionState({ probe: up, health: healthy, approve: { approved: false, code: 'NO_PENDING', count: 0, reason: 'no pending pairing requests' } });
    assert.equal(s.level, 'live');
  });

  it('is live right after a successful approval', () => {
    const s = deriveConnectionState({ probe: up, health: healthy, approve: { approved: true, code: 'APPROVED', count: 1, reason: 'approved' } });
    assert.equal(s.level, 'live');
  });

  it('DOWNGRADE-ONLY: no combination of missing evidence can produce live', () => {
    // The property, not a tell: absent inputs must never manufacture green.
    const probes = [undefined, null, {}, { reachable: false }, { reachable: true }];
    const healths = [undefined, null, {}, { ok: false }, { ok: true }];
    const approves = [undefined, null, {}, { code: 'NO_PENDING', count: 0 }];
    for (const probe of probes) {
      for (const health of healths) {
        for (const approve of approves) {
          const s = deriveConnectionState({ probe, health, approve });
          assert.ok(['checking', 'dead', 'unverified', 'live'].includes(s.level));
          if (s.level === 'live') {
            assert.ok(probe && probe.reachable === true, 'live requires a reachable probe');
            assert.ok(health && health.ok === true, 'live requires an answering gateway');
            assert.ok(approve && (approve.approved === true || approve.code === 'NO_PENDING'),
              'live requires positive pairing evidence');
          }
        }
      }
    }
  });

  it('degrades without a connection name rather than printing undefined', () => {
    const s = deriveConnectionState({ probe: up, health: healthy,
      approve: { approved: false, code: 'X', count: 3, reason: null } });
    assert.ok(!s.label.includes('undefined'));
  });
});

describe('#1012 applyConnectionState — states replace, they do not stack', () => {
  /** Minimal element double with a real class set. */
  function fakeEl() {
    const classes = new Set(['checking']);
    return {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
      title: '',
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      classes
    };
  }

  it('clears the previous level before adding the new one', () => {
    const el = fakeEl();
    applyConnectionState(el, { level: 'dead', label: 'Not connected' });
    assert.ok(el.classes.has('dead'));
    assert.ok(!el.classes.has('checking'), 'a stale level class leaves the old colour showing — the reported bug');
    assert.equal(el.classes.size, 1);
  });

  it('carries the label to title AND aria-label — colour alone is not a status', () => {
    const el = fakeEl();
    applyConnectionState(el, { level: 'unverified', label: 'Tunnel up, gateway unverified' });
    assert.equal(el.title, 'Tunnel up, gateway unverified');
    assert.match(el.attrs['aria-label'], /Tunnel up, gateway unverified/);
  });

  it('the indicator never hands back its live evidence record', () => {
    const ind = createConnectionIndicator(null);
    ind.record('probe', { reachable: true });
    const snap = ind.snapshot();
    snap.probe = { reachable: false };
    assert.equal(ind.state().level, 'unverified', 'mutating a snapshot must not reach the indicator');
    assert.equal(ind.evidence, undefined, 'the mutable record must not be exported');
  });

  it('a hand-phrased failure still goes through the applier', () => {
    const el = { classList: { add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, s: new Set(['checking']) },
      title: '', setAttribute() {} };
    el.classList.s = new Set(['checking']);
    const ind = createConnectionIndicator(el);
    ind.fail('Tunnel for “Kobold” failed to start');
    assert.ok(el.classList.s.has('dead'));
    assert.ok(!el.classList.s.has('checking'), 'fail() must clear, not stack');
  });

  it('does not throw on a missing element', () => {
    assert.doesNotThrow(() => applyConnectionState(null, { level: 'dead', label: 'x' }));
  });
});

describe('#1012 the indicator states the code sets must actually be styled', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'openclaw-view.html'), 'utf8');

  it('every level class has a CSS rule', () => {
    // The whole bug: the code set `.dead`, no rule existed, and the base
    // `.status-dot` green survived. A level the code can set and CSS cannot
    // render is a silent lie.
    for (const cls of CONNECTION_STATE_CLASSES) {
      assert.match(css, new RegExp(`\\.status-dot\\.${cls}\\s*\\{`), `.status-dot.${cls} has no rule`);
    }
  });

  it('dead is visually distinct from live', () => {
    const dead = css.match(/\.status-dot\.dead\s*\{([^}]*)\}/)[1];
    const live = css.match(/\.status-dot\.live\s*\{([^}]*)\}/)[1];
    assert.notEqual(dead.match(/background:\s*([^;]+)/)[1].trim(),
      live.match(/background:\s*([^;]+)/)[1].trim());
  });

  it('the dot does not start green — nothing is measured at page load', () => {
    const tag = html.match(/<span[^>]*id="statusDot"[^>]*>/)[0];
    assert.match(tag, /class="status-dot checking"/,
      'the initial markup must carry a non-green level, or the page opens on a claim it has not checked');
  });
});

describe('#1012 wiring — the view actually reduces over the evidence', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'openclaw-view.js'), 'utf8');

  it('never sets a level class directly — everything goes through the applier', () => {
    // A direct classList.add on the dot bypasses the clear-then-set contract.
    assert.ok(!/statusDot'\)\.classList\.add/.test(view),
      'the dot must be driven through applyConnectionState, not mutated in place');
  });

  it('probes the gateway, not just the proxy, before claiming a connection', () => {
    assert.match(view, /probeGateway\(/);
  });

  it('feeds the auto-approve answer into the indicator', () => {
    assert.match(view, /connectionIndicator\.record\('approve',\s*result\)/);
  });

  it('records every measurement through the one call that also re-derives', () => {
    // Recording and re-deriving are deliberately inseparable: a bare
    // assignment is a site that can forget, and a dot left on an earlier,
    // more optimistic answer is the bug this car exists for. Asserting the
    // absence of the bare form is the property; asserting that some call
    // exists somewhere is only a tell, and a tell is satisfied by any other
    // call site in the file.
    assert.ok(!/connectionEvidence\s*[.[]/.test(view),
      'evidence must not be touched directly — route it through the indicator');
    for (const key of ['probe', 'health', 'approve', 'connName']) {
      assert.match(view, new RegExp(`connectionIndicator\\.record\\('${key}'`), `${key} is never recorded`);
    }
  });
});

describe('#1012 createConnectionIndicator — recording re-renders, for every signal', () => {
  /** Minimal element double with a real class set. */
  function fakeEl() {
    const classes = new Set(['checking']);
    return {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      title: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, classes
    };
  }
  const up = { reachable: true, reason: null };
  const healthy = { answered: true, ok: true, reason: null };

  it('re-renders on EVERY key — not just the ones the happy path happens to set', () => {
    // The mutation this exists for: a recorder that skips the re-render for
    // one key leaves the dot on an earlier, more optimistic answer. Source
    // matching cannot see that; executing it can.
    for (const key of ['probe', 'health', 'approve', 'connName']) {
      const el = fakeEl();
      const ind = createConnectionIndicator(el);
      const before = el.title;
      ind.record(key, key === 'connName' ? 'X' : {});
      assert.notEqual(el.title, before, `recording ${key} did not re-render the indicator`);
    }
  });

  it('walks a real connection from checking to live as evidence lands', () => {
    const el = fakeEl();
    const ind = createConnectionIndicator(el);
    assert.equal(ind.record('probe', up).level, 'unverified');
    assert.equal(ind.record('health', healthy).level, 'unverified');
    assert.equal(ind.record('approve', { approved: false, code: 'NO_PENDING', count: 0 }).level, 'live');
    assert.ok(el.classes.has('live'));
    assert.equal(el.classes.size, 1, 'levels must replace, not accumulate');
  });

  it('a later measurement can take the dot OFF green', () => {
    const el = fakeEl();
    const ind = createConnectionIndicator(el);
    ind.record('probe', up);
    ind.record('health', healthy);
    assert.equal(ind.record('approve', { approved: false, code: 'NO_PENDING', count: 0 }).level, 'live');
    // A later poll finds a device waiting: the dot must come off green.
    assert.equal(ind.record('approve', { approved: false, code: 'MISSING_REQUEST_ID', count: 1 }).level, 'unverified');
    assert.ok(el.classes.has('unverified'));
    assert.ok(!el.classes.has('live'));
  });

  it('accepts a getter so the page can bind before the element exists', () => {
    let el = null;
    const ind = createConnectionIndicator(() => el);
    assert.doesNotThrow(() => ind.record('probe', up));
    el = fakeEl();
    ind.record('health', healthy);
    assert.match(el.title, /pairing not checked yet/);
  });
});

describe('#1012 the view and its helper must not skew across the service worker', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

  it('both halves of the pair are network-first', () => {
    // The view calls tcTunnelState at module top level, so a cached OLD helper
    // against a fresh view throws at eval and the page renders nothing. Same
    // lockstep the file already documents for session.js/wrap-drawer.js.
    const block = sw.slice(sw.indexOf('NETWORK_FIRST_PATHS'), sw.indexOf('])', sw.indexOf('NETWORK_FIRST_PATHS')));
    for (const p of ['/openclaw-view.js', '/openclaw-tunnel-state.js']) {
      assert.ok(block.includes(`'${p}'`), `${p} must be network-first or it can be served stale`);
    }
  });
});

describe('#1012 the production probe budget is real', () => {
  it('uses PROBE_TIMEOUT_MS when no test budget is injected', async () => {
    // The tests inject a 25ms budget; without this the shipped default is
    // never exercised and could be anything.
    const { PROBE_TIMEOUT_MS } = require('../public/openclaw-tunnel-state.js');
    let seenBudget = null;
    await probeGateway('c1', {
      fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true }) }),
      AbortControllerImpl: class { constructor() { this.signal = {}; } abort() {} }
    });
    // Budget is observed through the timer the helper schedules.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => { seenBudget = ms; return realSetTimeout(fn, ms); };
    try {
      await probeGateway('c1', { fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true }) }) });
    } finally {
      global.setTimeout = realSetTimeout;
    }
    assert.equal(seenBudget, PROBE_TIMEOUT_MS);
    assert.ok(PROBE_TIMEOUT_MS >= 1000, 'a sub-second production budget would fail healthy tunnels');
  });
});
