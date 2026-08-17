'use strict';

/*
 * #931 — a session re-reads update status on a cadence, not once at page load.
 * #954 — and that read is a real measurement, not a read of a 30-minute cache.
 * #955 — and a non-answer costs seconds, not a full interval.
 *
 * The beacon exists because operators live on the session page rather than the
 * dashboard. Sessions here run for days, so a surface that reads update status
 * exactly once — at page load — never fires for the population it was built
 * for. #931 gave it a cadence. #954 and #955 are what that cadence was still
 * missing: it asked the server to recite a cached answer, and it treated "I
 * don't know yet" as worth waiting a full interval to re-ask.
 *
 * The read rides the existing session-status chain rather than starting a
 * second timer, so these tests drive that chain: the cadence predicate
 * directly, and then the tick that consumes it, with the clock and the reads
 * under test control.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSION_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
const BEACON_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'update-beacon.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 *
 * @param {string} decl - Declaration to find.
 * @param {string} [src=SESSION_SRC] - Source to slice from.
 * @returns {string} The declaration plus its balanced body.
 */
function lift(decl, src) {
  const text = src || SESSION_SRC;
  const start = text.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = text.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Read a numeric constant out of session.js rather than restating it.
 *
 * @param {string} name - The constant's name.
 * @returns {number}
 */
function realConst(name) {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(SESSION_SRC);
  assert.ok(m, `${name} must be declared`);
  return Number(m[1]);
}

const realInterval = () => realConst('UPDATE_CHECK_INTERVAL_MS');
const realRetry = () => realConst('UPDATE_RETRY_INTERVAL_MS');

/** A payload that IS an answer: measured, and the measurement worked. */
const ANSWER = { checkedAt: '2026-08-16T00:00:00.000Z', checkOk: true, updateAvailable: false };

/**
 * Run the real `pollTick` with the clock and both transports under test
 * control.
 *
 * @param {{lastAt: number, now: number}} clock - Seeded stamp and fake now.
 * @param {{post?: *, get?: *, postErrorCode?: string}} [replies] - What each
 *   transport returns; `post` defaults to a real answer, and may be a function
 *   of the call count so one sandbox can be driven across several hops.
 * @returns {object} The vm context, with `calls` attached.
 */
function loadTick(clock, replies) {
  const r = replies || {};
  const post = Object.prototype.hasOwnProperty.call(r, 'post') ? r.post : ANSWER;
  const calls = { status: 0, post: 0, get: 0, urls: [], bodies: [], rendered: [] };

  const api = async (url) => { calls.get++; calls.urls.push(url); return r.get === undefined ? null : r.get; };
  api.lastErrorCode = r.postErrorCode || null;

  const sandbox = {
    console,
    Date: { now: () => clock.now },
    pollStatus: async () => { calls.status++; },
    // The REAL loadUpdateStatus is lifted below — stubbing it would stub the
    // clock stamping and the cadence selection, which is what most of this file
    // is about. Only its transports stand in.
    api,
    apiMutate: async (url, method, body) => {
      calls.post++; calls.urls.push(url); calls.bodies.push(body);
      return typeof post === 'function' ? post(calls.post) : post;
    },
    updateBeacon: { render: (d) => { calls.rendered.push(d); } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    `const UPDATE_CHECK_INTERVAL_MS = ${realInterval()};`,
    `const UPDATE_RETRY_INTERVAL_MS = ${realRetry()};`,
    `let _lastUpdateCheckAt = ${clock.lastAt};`,
    'let _updateIntervalMs = UPDATE_CHECK_INTERVAL_MS;',
    // The REAL predicate, lifted from the beacon rather than restated here —
    // the whole point of sharing it is that one rule governs both surfaces, and
    // a restated copy in the test would hide the day they diverge.
    lift('function tcIsUpdateAnswer(data)', BEACON_SRC),
    'window.tcIsUpdateAnswer = tcIsUpdateAnswer;',
    lift('function updateCheckDue(lastAt, now, intervalMs)'),
    lift('async function loadUpdateStatus()'),
    lift('async function pollTick()'),
    'globalThis.pollTick = pollTick;',
    'globalThis.updateCheckDue = updateCheckDue;',
    'globalThis.tcIsUpdateAnswer = tcIsUpdateAnswer;',
    'globalThis.readStamp = () => _lastUpdateCheckAt;',
    'globalThis.readInterval = () => _updateIntervalMs;'
  ].join('\n'), sandbox);
  sandbox.calls = calls;
  return sandbox;
}

describe('#931 a session keeps asking, so a release that lands mid-session is seen', () => {
  it('reads update status once the interval has elapsed', async () => {
    const clock = { lastAt: 0, now: realInterval() };
    const ctx = loadTick(clock);
    await ctx.pollTick();

    assert.equal(ctx.calls.status, 1, 'session status is read every tick');
    assert.equal(ctx.calls.post + ctx.calls.get, 1, 'and update status once it is due');
    // THE MUTATION THIS CATCHES: dropping the update read from the tick — which
    // is what shipped before this, and it meant an operator in a long session
    // never learned about a release at all.
  });

  it('does NOT read it on every tick', async () => {
    // The session chain fires every 5s; an update read on each would be sixty
    // times the traffic for an answer that changes far more slowly.
    const clock = { lastAt: 0, now: 1000 };
    const ctx = loadTick(clock);
    await ctx.pollTick();

    assert.equal(ctx.calls.status, 1, 'the status poll is unaffected');
    assert.equal(ctx.calls.post + ctx.calls.get, 0, 'the update read waits its turn');
    // THE MUTATION THIS CATCHES: removing the elapsed gate, or inverting it.
  });

  it('re-arms: a second read happens one interval after the first, not sooner', async () => {
    const iv = realInterval();
    const clock = { lastAt: 0, now: iv };
    const ctx = loadTick(clock);

    await ctx.pollTick();
    assert.equal(ctx.calls.post, 1);

    clock.now = iv + 1000;
    await ctx.pollTick();
    assert.equal(ctx.calls.post, 1, 'not again a second later');

    clock.now = iv * 2;
    await ctx.pollTick();
    assert.equal(ctx.calls.post, 2, 'again once another interval has passed');
    // THE MUTATION THIS CATCHES: not stamping the clock on a read. Every
    // subsequent tick would then look overdue and the page would ask every five
    // seconds forever — the multi-hop behavior a single "does it fire?"
    // assertion cannot see.
  });

  it('the first tick after page load does not re-read — init already did', async () => {
    const iv = realInterval();
    const clock = { lastAt: iv, now: iv + 5000 };
    const ctx = loadTick(clock);
    await ctx.pollTick();
    assert.equal(ctx.calls.post + ctx.calls.get, 0);
  });

  describe('the cadence predicate', () => {
    it('is exclusive below the interval and inclusive at it', () => {
      const iv = realInterval();
      const ctx = loadTick({ lastAt: 0, now: 0 });
      assert.equal(ctx.updateCheckDue(0, iv - 1, iv), false);
      assert.equal(ctx.updateCheckDue(0, iv, iv), true, 'the boundary counts as due');
      assert.equal(ctx.updateCheckDue(0, iv + 1, iv), true);
    });

    it('matches the dashboard cadence rather than inventing its own', () => {
      const landing = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
      const dash = /loop\(loadUpdateStatus, (\d+)\)/.exec(landing);
      assert.ok(dash, 'the dashboard must still poll update status');
      assert.equal(realInterval(), Number(dash[1]),
        'one product, one answer to "how often do we ask" — two cadences would '
        + 'be the pill-and-badge divergence again, in timing');
    });
  });
});

describe('#954 the session asks for a measurement, not a recital of the cache', () => {
  it('asks the server to measure', async () => {
    // THIS REVERSES A DELIBERATE PRIOR CONTRACT, so it records why rather than
    // quietly dropping it. The old assertion was `doesNotMatch(/update\/check/)`
    // and its stated fear was "a git ls-remote against origin every five minutes
    // for the life of every open session".
    //
    // That fear mis-read the mechanism it was protecting. `POST /api/update/check`
    // does not mean "measure"; it means "measure IF the cache is older than the
    // refresh floor", and `refreshIfStale` also single-flights concurrent
    // askers. So the ceiling is one `git ls-remote` per floor per SERVER, not
    // per session — identical whether one session is open or twenty, and
    // identical to what the dashboard has always cost, since it has asked this
    // way on load and on refocus all along.
    //
    // What the old contract did cost was correctness: the server's periodic
    // check became the only floor on freshness, so a release could exist for
    // most of that interval while this page polled and recited a stale answer.
    const ctx = loadTick({ lastAt: 0, now: realInterval() });
    await ctx.pollTick();

    assert.equal(ctx.calls.post, 1, 'the read measures');
    assert.deepEqual(ctx.calls.urls, ['/api/update/check']);
    // Field-wise, not deepEqual: the body is constructed inside the vm realm, so
    // its prototype is that realm's Object.prototype and a strict deep compare
    // fails on prototype identity while every value matches.
    assert.equal(ctx.calls.bodies.length, 1);
    assert.equal(ctx.calls.bodies[0].manual, false,
      'not operator-initiated: this must earn the lazy refresh floor, not the '
      + 'aggressive one an operator tapping "check now" gets');
  });

  it('falls back to the cached read when the server is older than these assets', async () => {
    // Not hypothetical: this repo IS the live install, so a merge or a
    // self-update puts new client files on disk while the running process keeps
    // serving the old routes until it restarts. Reading that 404 as a failed
    // check would hold a stale beacon until the restart — a false alarm from the
    // feature built to stop misreporting update state.
    const ctx = loadTick({ lastAt: 0, now: realInterval() },
      { post: null, postErrorCode: 'NOT_FOUND', get: ANSWER });
    await ctx.pollTick();

    assert.deepEqual(ctx.calls.urls, ['/api/update/check', '/api/update-status']);
    assert.deepEqual(ctx.calls.rendered, [ANSWER], 'the cached answer still reaches the beacon');
  });

  it('does NOT fall back on any other failure', async () => {
    // A 500, a network drop or an auth failure are not "this route is missing".
    // Retrying them against a different route would turn one failed check into
    // two, and could render a stale cached answer as if it were a fresh one.
    const ctx = loadTick({ lastAt: 0, now: realInterval() },
      { post: null, postErrorCode: 'INTERNAL', get: ANSWER });
    await ctx.pollTick();

    assert.deepEqual(ctx.calls.urls, ['/api/update/check'], 'one attempt, not two');
    assert.deepEqual(ctx.calls.rendered, [null], 'the failure reaches the beacon as a failure');
  });
});

describe('#955 a non-answer costs seconds, not a full interval', () => {
  // The bug this closes, observed live updating 5.5.0 → 5.6.0: an update applied
  // from one surface left every OTHER open session still offering it. The
  // restart empties the server's in-process cache, so the next poll got "never
  // measured"; the beacon correctly refused to act on an unknown; and nothing
  // asked again until the full interval expired. The offer only cleared on a
  // manual page refresh — which is the workaround this removes.

  const NON_ANSWERS = [
    ['the request itself failed', null],
    ['the server has not measured yet', { checkedAt: null, checkOk: false, updateAvailable: false }],
    ['the measurement ran and failed', { checkedAt: '2026-08-16T00:00:00.000Z', checkOk: false, updateAvailable: false }]
  ];

  for (const [label, payload] of NON_ANSWERS) {
    it(`retries soon when ${label}`, async () => {
      const iv = realInterval();
      const ctx = loadTick({ lastAt: 0, now: iv }, { post: payload });
      await ctx.pollTick();

      assert.equal(ctx.calls.post, 1);
      assert.equal(ctx.readInterval(), realRetry(),
        'the next poll is a retry away, not a full interval away');
    });
  }

  it('a real answer restores the full interval', async () => {
    const iv = realInterval();
    const ctx = loadTick({ lastAt: 0, now: iv }, { post: ANSWER });
    await ctx.pollTick();
    assert.equal(ctx.readInterval(), iv, 'no retry needed');
  });

  it('recovers rather than latching: retry, then answer, then back to the full interval', async () => {
    // The multi-hop property, driven through ONE sandbox so the cadence really
    // carries in module state rather than being re-seeded between hops. A page
    // that dropped into retry and never climbed out would ask every 30s for the
    // life of the session, and every single-tick assertion above would still
    // pass.
    const iv = realInterval();
    const retry = realRetry();
    const clock = { lastAt: 0, now: iv };
    const ctx = loadTick(clock, { post: (n) => (n === 1 ? null : ANSWER) });

    await ctx.pollTick();
    assert.equal(ctx.calls.post, 1, 'hop 1: due at the full interval');
    assert.equal(ctx.readInterval(), retry, 'hop 1: the non-answer drops it to retry');

    clock.now = iv + retry - 1;
    await ctx.pollTick();
    assert.equal(ctx.calls.post, 1, 'hop 2: the retry is not due one tick early');

    clock.now = iv + retry;
    await ctx.pollTick();
    assert.equal(ctx.calls.post, 2, 'hop 3: it fires at the SHORT interval, not the full one');
    assert.equal(ctx.readInterval(), iv, 'hop 3: and the answer restores the full cadence');

    clock.now = iv + retry * 2;
    await ctx.pollTick();
    assert.equal(ctx.calls.post, 2,
      'hop 4: no longer retrying — this would fire again if the cadence had latched');
  });

  it('the retry interval is shorter than the normal one, and not zero', async () => {
    // A retry at or above the normal cadence is not a retry; a retry of zero is
    // a spin. Both are plausible edits that every test above survives.
    assert.ok(realRetry() > 0, 'a zero retry would poll the server continuously');
    assert.ok(realRetry() < realInterval(), 'a retry must actually be sooner');
  });
});

describe('#955 one rule decides what counts as an answer', () => {
  it('the session poll uses the beacon\'s predicate, not its own copy', () => {
    // Two copies of "is this an answer?" would drift, and the drift would be
    // invisible: both render plausibly, and only the reachable-but-rare states
    // disagree — which is exactly the #716 class of bug. So the session must
    // CALL it, not restate it.
    const body = lift('async function loadUpdateStatus()');
    assert.match(body, /window\.tcIsUpdateAnswer\(/,
      'the shared predicate is the one consulted');
    assert.doesNotMatch(body, /checkOk/,
      'no second copy of the rule may live here');
    assert.match(BEACON_SRC, /global\.tcIsUpdateAnswer = tcIsUpdateAnswer;/,
      'and the beacon must still publish it');
  });

  it('the beacon renders through the same predicate it publishes', () => {
    const render = lift('function render(data)', BEACON_SRC);
    assert.match(render, /if \(!tcIsUpdateAnswer\(data\)\) return;/,
      'the beacon may not keep an inlined copy of the rule it exports');
  });

  it('rejects all three non-answers and accepts a measured one', () => {
    const ctx = loadTick({ lastAt: 0, now: 0 });
    assert.equal(ctx.tcIsUpdateAnswer(null), false);
    assert.equal(ctx.tcIsUpdateAnswer({ checkedAt: null, checkOk: true }), false);
    assert.equal(ctx.tcIsUpdateAnswer({ checkedAt: 'x', checkOk: false }), false,
      'a check that RAN and could not measure is not "you are up to date"');
    assert.equal(ctx.tcIsUpdateAnswer({ checkedAt: 'x', checkOk: true }), true);
  });
});

describe('#954 a failed check cannot take the page down with it', () => {
  it('the init call is catch-guarded', () => {
    // Structural, because what matters is the SHAPE of the call site rather
    // than the body already exercised above: `loadUpdateStatus` sits in an
    // `await Promise.all([...])` at init, so a rejection there abandons
    // everything after it — `loadVersion`, the not-found banner, and
    // `startPolling`, which would leave the session never polling at all. The
    // dashboard learned this and guards the same call; the session page did not,
    // and gained a new throw path when it started consulting a shared predicate.
    const src = SESSION_SRC;
    const m = /Promise\.all\(\[[\s\S]{0,900}?\]\);/.exec(src);
    assert.ok(m, 'the init Promise.all must still exist');
    assert.match(m[0], /loadUpdateStatus\(\)\.catch\(/,
      'the update check must not be able to abandon the rest of init');
  });
});

describe('#931 the update read inherits the status chain, not a second timer', () => {
  it('startPolling drives pollTick', () => {
    // Structural, and it says so: the tick body is executed above, but WHICH
    // chain calls it cannot be. A second `setTimeout` chain here would lose the
    // visibility skip and the burst protection this file exists to preserve —
    // and would look correct in every behavioral test.
    const body = lift('function startPolling()');
    assert.match(body, /await pollTick\(\);/,
      'the existing chain must be the one that ticks');
    assert.doesNotMatch(body, /await pollStatus\(\);/,
      'the chain calls the tick, not the status read directly');
    const ticks = (SESSION_SRC.match(/pollTick\(\)/g) || []).length;
    assert.equal(ticks, 2, 'exactly the declaration and the one call site');
  });
});
