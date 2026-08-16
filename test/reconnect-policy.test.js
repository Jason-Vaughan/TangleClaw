'use strict';

/*
 * #941 — the shared reconnect policy.
 *
 * Two defects live here. The first is that the dashboard and the session page
 * each carried their own retry loop, so the #709 escalation was built on one
 * and not the other and a session tab looped "Connection lost. Retrying…"
 * against a server that was never coming back. The fix is that there is now
 * exactly one policy, which is what the sibling suites lift.
 *
 * The second is measured here: the ceiling used to be a COUNT OF ATTEMPTS.
 * Browsers clamp timers in a backgrounded tab to roughly one per minute, so
 * four attempts meant about twenty seconds in a foreground tab and about four
 * minutes in a background one — the same outage, two verdicts, on a page whose
 * whole purpose is to stop being wrong about whether the server is up. The
 * operator keeps several dashboards and several session tabs open, so they saw
 * both at once. The ceiling is now elapsed time, and these tests pin the
 * difference in both directions: many fast attempts must NOT escalate, and one
 * slow attempt MUST.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'reconnect-policy.js'), 'utf8');

/**
 * Load the real module into a fresh sandbox.
 * @returns {object} The sandbox, carrying `tcCreateReconnectPolicy`.
 */
function loadModule() {
  const sandbox = { console, Math, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

/**
 * Build a policy whose clock and timer the test drives.
 *
 * @param {object} [opts] - Overrides merged over the harness defaults.
 * @returns {object} `{ policy, advance, fire, pending, escalations, recoveries, probes, defaults }`
 */
function makeHarness(opts = {}) {
  const mod = loadModule();
  const state = {
    clock: 0,
    pending: [],
    escalations: 0,
    recoveries: 0,
    probes: 0,
    serverUp: false
  };
  const policy = mod.tcCreateReconnectPolicy({
    probe: async () => {
      state.probes++;
      if (state.serverUp) policy.end();
    },
    onEscalate: () => { state.escalations++; },
    onRecover: () => { state.recoveries++; },
    now: () => state.clock,
    schedule: (fn, ms) => { state.pending.push({ fn, ms }); return state.pending.length; },
    cancel: () => { state.pending.length = 0; },
    ...opts
  });
  return {
    policy,
    state,
    defaults: mod.TC_RECONNECT_DEFAULTS,
    advance: (ms) => { state.clock += ms; },
    /** Fire the oldest scheduled callback, as a timer would. */
    async fire() {
      const next = state.pending.shift();
      assert.ok(next, 'a probe must be scheduled');
      await next.fn();
      return next.ms;
    }
  };
}

describe('the ceiling is elapsed time, not a count of attempts (#941)', () => {
  it('does not escalate on many fast attempts inside the ceiling', async () => {
    const h = makeHarness();
    h.policy.begin();

    // Ten attempts across two seconds — far past the old four-attempt ceiling,
    // nowhere near twenty seconds of provable outage.
    for (let i = 0; i < 10; i++) {
      h.advance(200);
      await h.policy.retryNow();
    }
    assert.equal(h.state.probes, 10, 'the attempts really happened');
    assert.equal(h.state.escalations, 0,
      'two seconds of outage is a blip however many times the page asked');
  });

  it('escalates on a SINGLE attempt once the outage outlives the ceiling', async () => {
    const h = makeHarness();
    h.policy.begin();

    // The backgrounded tab: its timer was clamped, so it wakes once, a minute in.
    h.advance(60000);
    await h.policy.retryNow();
    assert.equal(h.state.probes, 1, 'a throttled tab gets one attempt, not four');
    assert.equal(h.state.escalations, 1,
      'one attempt is enough when the outage is provably past the ceiling');
  });

  it('two tabs on different cadences reach the same verdict', async () => {
    const foreground = makeHarness();
    const background = makeHarness();
    foreground.policy.begin();
    background.policy.begin();

    // Same 30 seconds of wall clock; the foreground tab probes six times, the
    // throttled one probes twice. Under the old attempt count the foreground
    // tab escalated and the background tab did not.
    for (let i = 0; i < 6; i++) {
      foreground.advance(5000);
      await foreground.policy.retryNow();
    }
    for (let i = 0; i < 2; i++) {
      background.advance(15000);
      await background.policy.retryNow();
    }

    assert.equal(foreground.policy.hasEscalated(), true);
    assert.equal(background.policy.hasEscalated(), true,
      'the same outage must not read as "up" in one tab and "down" in another');
  });

  it('the ceiling is measured from the outage start, not from page load', async () => {
    const h = makeHarness();
    // A page that has been open for hours before anything goes wrong.
    h.advance(6 * 60 * 60 * 1000);
    h.policy.begin();
    h.advance(1000);
    await h.policy.retryNow();
    assert.equal(h.state.escalations, 0,
      'a long-lived page must not escalate instantly on its first hiccup');
  });
});

describe('the scheduled loop escalates too, not only the explicit retry', () => {
  it('reaches the ceiling through the timer path', async () => {
    const h = makeHarness();
    h.policy.begin();

    let guard = 0;
    while (!h.policy.hasEscalated() && guard++ < 20) {
      h.advance(5000);
      await h.fire();
    }
    assert.equal(h.policy.hasEscalated(), true,
      'the background loop must reach the same ceiling the button does');
    assert.ok(guard <= 6, `escalated in ${guard} scheduled probes, not an unbounded number`);
  });

  it('keeps probing after escalating — recovery stays automatic', async () => {
    const h = makeHarness();
    h.policy.begin();
    h.advance(25000);
    await h.fire();
    assert.equal(h.policy.hasEscalated(), true);

    const before = h.state.probes;
    h.state.serverUp = true;
    h.advance(5000);
    await h.fire();
    assert.ok(h.state.probes > before, 'the loop must not stop once it has escalated');
    assert.equal(h.state.recoveries, 1, 'the server coming back dismisses without operator action');
    assert.equal(h.policy.isOutage(), false);
  });
});

describe('escalation fires once, and re-arms only after a real recovery', () => {
  it('does not re-fire on every subsequent failed probe', async () => {
    const h = makeHarness();
    h.policy.begin();
    for (let i = 0; i < 5; i++) {
      h.advance(30000);
      await h.policy.retryNow();
    }
    assert.equal(h.state.escalations, 1, 'the operator is told once, not five times');
  });

  it('a fresh outage after recovery gets a fresh ceiling', async () => {
    const h = makeHarness();
    h.policy.begin();
    h.advance(30000);
    await h.policy.retryNow();
    assert.equal(h.state.escalations, 1);

    h.state.serverUp = true;
    await h.policy.retryNow();
    assert.equal(h.policy.isOutage(), false);

    h.state.serverUp = false;
    h.policy.begin();
    h.advance(1000);
    await h.policy.retryNow();
    assert.equal(h.state.escalations, 1,
      'one failure after a recovery is a blip again, not an instant escalation');
  });

  it('a probe that recovers mid-flight does not then escalate', async () => {
    // The re-entrancy case: probe() flips the page connected, which calls
    // end() and clears the outage clock. Escalating after that would paint a
    // dead-server message over a server that just answered.
    //
    // Held below the ceiling deliberately. Past it the outage has genuinely
    // lasted long enough to deserve announcing, and the pre-probe check says
    // so before the probe runs — that is the point of checking on both sides,
    // not a leak. What must never happen is the POST-probe check firing on an
    // outage the probe just closed.
    const h = makeHarness();
    h.policy.begin();
    h.advance(5000);
    h.state.serverUp = true;
    await h.policy.retryNow();
    assert.equal(h.state.escalations, 0,
      'a probe that succeeded must not escalate on the way out');
    assert.equal(h.state.recoveries, 1);
    assert.equal(h.policy.isOutage(), false);
  });

  it('an already-escalated outage that recovers does not escalate again', async () => {
    const h = makeHarness();
    h.policy.begin();
    h.advance(30000);
    await h.policy.retryNow();
    assert.equal(h.state.escalations, 1);

    h.state.serverUp = true;
    await h.policy.retryNow();
    assert.equal(h.state.escalations, 1, 'recovery announces nothing new');
    assert.equal(h.state.recoveries, 1);
  });
});

describe('begin() is idempotent so the ceiling cannot be pushed out of reach', () => {
  it('a repeated disconnect signal does not restamp the outage clock', async () => {
    const h = makeHarness();
    h.policy.begin();
    h.advance(15000);
    h.policy.begin(); // a second "connection lost" while already down
    h.advance(10000);
    await h.policy.retryNow();
    assert.equal(h.state.escalations, 1,
      'twenty-five seconds of outage is twenty-five seconds, however often it was reported');
  });

  it('does not stack a second scheduled loop', () => {
    const h = makeHarness();
    h.policy.begin();
    h.policy.begin();
    h.policy.begin();
    assert.equal(h.state.pending.length, 1,
      'three disconnect signals must not triple the probe rate');
  });

  it('a flap during an in-flight probe does not orphan a second chain', async () => {
    // Each page runs its own status poller calling the same `setConnected`, so
    // a restarting server can produce recover-then-drop inside one probe
    // window. If the resuming loop and the one `begin()` started both re-arm,
    // the orphan permanently doubles the probe rate against a booting server —
    // the exact herd the jitter exists to prevent.
    let releaseProbe;
    const h = makeHarness({
      probe: () => new Promise((resolve) => { releaseProbe = resolve; })
    });
    h.policy.begin();
    const inFlight = h.fire();              // a probe is now awaiting
    await new Promise((r) => setImmediate(r));

    h.policy.end();                          // server answered on another path
    h.policy.begin();                        // ...and dropped again
    const armedByBegin = h.state.pending.length;

    releaseProbe();
    await inFlight;                          // the old probe resolves and re-arms

    assert.equal(h.state.pending.length, armedByBegin,
      'the superseded chain must not add a second timer');
  });
});

describe('probes are jittered so open tabs do not converge into a burst', () => {
  it('spreads delays around the base without ever going negative', async () => {
    const seen = new Set();
    // Sweep the randomness source across its whole range, so the bounds are
    // asserted at the extremes rather than wherever Math.random happened to land.
    for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      const h = makeHarness({ random: () => r });
      h.policy.begin();
      const ms = h.state.pending[0].ms;
      seen.add(ms);
      const base = h.defaults.baseDelayMs;
      const spread = base * h.defaults.jitterRatio;
      assert.ok(ms >= 0, 'a delay must never be negative');
      assert.ok(ms >= base - spread - 1 && ms <= base + spread + 1,
        `delay ${ms} must stay within ±${spread}ms of ${base}`);
    }
    assert.ok(seen.size > 1, 'the delay must actually vary — a fixed delay is not jitter');
  });

  it('two tabs starting together do not schedule the same delay', () => {
    // The herd: without jitter, N tabs opened at once probe in lockstep forever
    // and hit a booting server simultaneously.
    const a = makeHarness({ random: () => 0.1 });
    const b = makeHarness({ random: () => 0.9 });
    a.policy.begin();
    b.policy.begin();
    assert.notEqual(a.state.pending[0].ms, b.state.pending[0].ms);
  });
});

describe('the ceiling holds even when the probe itself is the slow part', () => {
  it('escalates before a stalled probe returns, not after', async () => {
    // `fetch` has no deadline. Against a refusing server a probe fails at once,
    // but against a black-holed host — a sleeping machine, a tailnet route that
    // went away — the connect stalls for the browser's own multi-minute
    // timeout. Checking the ceiling only after the probe would withhold the
    // honest verdict exactly when the network is at its least honest.
    let releaseProbe;
    const h = makeHarness({
      probe: () => new Promise((resolve) => { releaseProbe = resolve; })
    });
    h.policy.begin();

    h.advance(30000);            // the outage is provably past the ceiling
    const inFlight = h.policy.retryNow();   // ...and the probe hangs
    await new Promise((r) => setImmediate(r));

    assert.equal(h.policy.hasEscalated(), true,
      'a hung probe must not hold the escalation hostage');
    releaseProbe();
    await inFlight;
  });

  it('does not escalate before the ceiling just because a probe is slow', async () => {
    let releaseProbe;
    const h = makeHarness({
      probe: () => new Promise((resolve) => { releaseProbe = resolve; })
    });
    h.policy.begin();
    h.advance(2000);
    const inFlight = h.policy.retryNow();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.policy.hasEscalated(), false,
      'the pre-probe check must respect the ceiling, not bypass it');
    releaseProbe();
    await inFlight;
  });
});

describe('a probe that throws must not take the retry loop down with it', () => {
  it('keeps probing and still escalates after a rejecting probe', async () => {
    // Neither page can trigger this today (both route through `api()`, which
    // catches), but `probe` is this module's extension point, and an unhandled
    // rejection would stop the re-arm for the life of the page — silently
    // restoring the exact bug the module exists to remove.
    let calls = 0;
    const h = makeHarness({
      probe: async () => { calls++; throw new Error('probe blew up'); }
    });
    h.policy.begin();

    h.advance(5000);
    await h.fire();
    assert.equal(calls, 1);
    assert.equal(h.state.pending.length, 1, 'the loop must have re-armed after the throw');

    h.advance(30000);
    await h.fire();
    assert.equal(calls, 2, 'and must keep probing');
    assert.equal(h.policy.hasEscalated(), true,
      'a throwing probe must not suppress the honest verdict either');
  });
});

describe('end() stops the outage cleanly', () => {
  it('cancels the pending probe and clears the outage', () => {
    const h = makeHarness();
    h.policy.begin();
    assert.equal(h.policy.isOutage(), true);
    h.policy.end();
    assert.equal(h.policy.isOutage(), false);
    assert.equal(h.state.pending.length, 0, 'the scheduled probe must be cancelled');
    assert.equal(h.state.recoveries, 1);
  });

  it('retryNow() is inert when there is no outage', async () => {
    const h = makeHarness();
    await h.policy.retryNow();
    assert.equal(h.state.probes, 0,
      'the Retry button must not probe a server the page believes is up');
  });

  it('elapsedMs reports zero while connected', () => {
    const h = makeHarness();
    assert.equal(h.policy.elapsedMs(), 0);
    h.policy.begin();
    h.advance(4000);
    assert.equal(h.policy.elapsedMs(), 4000);
  });
});

describe('both pages are wired to the one policy (#941 root cause)', () => {
  // The defect was not that the escalation was wrong; it was that only one of
  // the two pages had one. A test that only exercises the module would keep
  // passing if a page quietly went back to its own loop.
  const PAGES = ['landing.js', 'session.js'];

  for (const page of PAGES) {
    it(`${page} builds its reconnect policy from the shared module`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
      assert.match(src, /tcCreateReconnectPolicy\(/,
        `${page} must use the shared policy, not a private retry loop`);
      assert.doesNotMatch(src, /function reconnectLoop\s*\(/,
        `${page} must not carry its own reconnect loop again`);
      for (const hook of ['probe', 'onEscalate', 'onRecover']) {
        assert.match(src, new RegExp(`${hook}\\s*:`),
          `${page} must wire ${hook} — an unwired escalation is exactly the #941 defect`);
      }
    });

    it(`${page} is served the shared module before its own script`, () => {
      const html = fs.readFileSync(
        path.join(__dirname, '..', 'public', page === 'landing.js' ? 'index.html' : 'session.html'),
        'utf8');
      const policyAt = html.indexOf('/reconnect-policy.js');
      const pageAt = html.indexOf(`/${page}`);
      assert.ok(policyAt !== -1, 'the page must load the shared policy');
      assert.ok(policyAt < pageAt,
        'the policy must load first — the page calls the factory at parse time');
    });
  }

  it('the shared module is network-first in the service worker', () => {
    // A cache-first copy would be served stale against a fresh page script,
    // and the page calls tcCreateReconnectPolicy at load: a stale miss is a
    // ReferenceError that takes the whole page down, not a cosmetic skew.
    const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    const set = sw.slice(sw.indexOf('NETWORK_FIRST_PATHS'), sw.indexOf('addEventListener'));
    assert.match(set, /'\/reconnect-policy\.js'/,
      'reconnect-policy.js must be network-first like the other shared frontend bases');
  });
});
