'use strict';

/*
 * #931 — a session re-reads update status on a cadence, not once at page load.
 *
 * The beacon exists because operators live on the session page rather than the
 * dashboard. Sessions here run for days, so a surface that reads update status
 * exactly once — at page load — never fires for the population it was built
 * for: an operator working in a session simply would not learn that a release
 * had landed. That made the feature technically present and practically absent,
 * which is the shape of the original bug, not its fix.
 *
 * The read rides the existing session-status chain rather than starting a
 * second timer, so these tests drive that chain: the cadence predicate
 * directly, and then the tick that consumes it, with the clock and the two
 * reads under test control.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSION_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 *
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function lift(decl) {
  const start = SESSION_SRC.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist in session.js`);
  const bodyStart = SESSION_SRC.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < SESSION_SRC.length; i++) {
    if (SESSION_SRC[i] === '{') depth++;
    else if (SESSION_SRC[i] === '}' && --depth === 0) return SESSION_SRC.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/** The real `UPDATE_CHECK_INTERVAL_MS`, read rather than restated. */
function realInterval() {
  const m = /const UPDATE_CHECK_INTERVAL_MS = (\d+);/.exec(SESSION_SRC);
  assert.ok(m, 'UPDATE_CHECK_INTERVAL_MS must be declared');
  return Number(m[1]);
}

/**
 * Run the real `pollTick` with the clock and both reads under test control.
 *
 * @param {{lastAt: number, now: number}} clock - Seeded stamp and fake now.
 * @returns {object} The vm context, with `calls` attached.
 */
function loadTick(clock) {
  const calls = { status: 0, update: 0, urls: [] };
  const sandbox = {
    console,
    Date: { now: () => clock.now },
    pollStatus: async () => { calls.status++; },
    // The REAL loadUpdateStatus is lifted below — stubbing it would stub the
    // clock stamping, which is exactly what the re-arm case is about. Only its
    // two collaborators stand in.
    api: async (url) => { calls.update++; calls.urls.push(url); return null; },
    updateBeacon: { render: () => {} }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    `const UPDATE_CHECK_INTERVAL_MS = ${realInterval()};`,
    `let _lastUpdateCheckAt = ${clock.lastAt};`,
    lift('function updateCheckDue(lastAt, now)'),
    lift('async function loadUpdateStatus()'),
    lift('async function pollTick()'),
    'globalThis.pollTick = pollTick;',
    'globalThis.updateCheckDue = updateCheckDue;',
    'globalThis.readStamp = () => _lastUpdateCheckAt;'
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
    assert.equal(ctx.calls.update, 1, 'and update status once it is due');
    // THE MUTATION THIS CATCHES: dropping the update read from the tick — which
    // is what shipped before this, and it meant an operator in a long session
    // never learned about a release at all.
  });

  it('does NOT read it on every tick', async () => {
    // The session chain fires every 5s; an update read on each would be sixty
    // times the traffic for an answer that changes at most every four hours.
    const clock = { lastAt: 0, now: 1000 };
    const ctx = loadTick(clock);
    await ctx.pollTick();

    assert.equal(ctx.calls.status, 1, 'the status poll is unaffected');
    assert.equal(ctx.calls.update, 0, 'the update read waits its turn');
    // THE MUTATION THIS CATCHES: removing the elapsed gate, or inverting it.
  });

  it('re-arms: a second read happens one interval after the first, not sooner', async () => {
    const iv = realInterval();
    const clock = { lastAt: 0, now: iv };
    const ctx = loadTick(clock);

    await ctx.pollTick();
    assert.equal(ctx.calls.update, 1);

    clock.now = iv + 1000;
    await ctx.pollTick();
    assert.equal(ctx.calls.update, 1, 'not again a second later');

    clock.now = iv * 2;
    await ctx.pollTick();
    assert.equal(ctx.calls.update, 2, 'again once another interval has passed');
    // THE MUTATION THIS CATCHES: not stamping the clock on a read. Every
    // subsequent tick would then look overdue and the page would read update
    // status every five seconds forever — the multi-hop behavior a single
    // "does it fire?" assertion cannot see.
  });

  it('the first tick after page load does not re-read — init already did', async () => {
    // `loadUpdateStatus` runs at init and stamps the clock, so a page that has
    // just loaded must not immediately ask again.
    const iv = realInterval();
    const clock = { lastAt: iv, now: iv + 5000 };
    const ctx = loadTick(clock);
    await ctx.pollTick();
    assert.equal(ctx.calls.update, 0);
  });

  describe('the cadence predicate', () => {
    it('is exclusive below the interval and inclusive at it', () => {
      const iv = realInterval();
      const ctx = loadTick({ lastAt: 0, now: 0 });
      assert.equal(ctx.updateCheckDue(0, iv - 1), false);
      assert.equal(ctx.updateCheckDue(0, iv), true, 'the boundary counts as due');
      assert.equal(ctx.updateCheckDue(0, iv + 1), true);
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

  it('the read is a cached GET, never a re-measurement', () => {
    const body = lift('async function loadUpdateStatus()');
    assert.match(body, /api\('\/api\/update-status'\)/);
    assert.doesNotMatch(body, /update\/check/,
      'a POST here would mean a git ls-remote against origin every five minutes '
      + 'for the life of every open session');
  });
});
