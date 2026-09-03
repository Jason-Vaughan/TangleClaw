'use strict';

/**
 * Tests for the #902 tmux guard itself.
 *
 * The guard in `test/_tmux-guard.js` protects the session suite, but once every
 * block stubs `createSession` correctly the guard has nothing left to catch —
 * so neutering it leaves the session suite fully green. Verified by mutation:
 * replacing the poison with `() => true` passed 180/180.
 *
 * That is the same shape as the defect #902 is about: a protection whose absence
 * is silent. These tests exercise the guard directly, so deleting or weakening it
 * fails here even when every caller happens to be well-behaved.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tmux = require('../lib/tmux');
const { installTmuxGuard, removeTmuxGuard, reapFixtureSessions } = require('./_tmux-guard');

describe('tmux guard (#902)', () => {
  afterEach(() => {
    removeTmuxGuard();
  });

  it('poisons tmux.createSession so a real engine process cannot be spawned', () => {
    const real = tmux.createSession;
    installTmuxGuard();

    assert.notEqual(tmux.createSession, real, 'createSession must be replaced while the guard is installed');
    assert.throws(
      () => tmux.createSession('some-fixture'),
      /#902 guard/,
      'the replacement must throw, not silently succeed'
    );
  });

  it('names the offending session and the fix in the error', () => {
    // The message is the whole value of the guard: it fires on someone else's
    // branch, months from now, and has to be actionable without this context.
    installTmuxGuard();

    let err;
    try {
      tmux.createSession('orphan-test');
    } catch (e) {
      err = e;
    }

    assert.ok(err, 'must throw');
    assert.match(err.message, /orphan-test/, 'names which session was about to be created');
    assert.match(err.message, /beforeEach/, 'names where to put the stub');
    assert.match(err.message, /unconditionally/, 'states why stubbing hasSession is not enough');
  });

  it('restores the real implementation on removal', () => {
    const real = tmux.createSession;

    installTmuxGuard();
    assert.notEqual(tmux.createSession, real);

    removeTmuxGuard();
    assert.equal(tmux.createSession, real, 'the real implementation must come back');
  });

  it('is idempotent — a second install does not capture the poison as the original', () => {
    // If install captured its own poison, a later remove would leave the poison
    // in place and every subsequent suite in the same process would break.
    const real = tmux.createSession;

    installTmuxGuard();
    installTmuxGuard();
    removeTmuxGuard();

    assert.equal(tmux.createSession, real);
  });

  it('reapFixtureSessions kills only the exact names it is given', () => {
    const probed = [];
    const killed = [];
    const originalHas = tmux.hasSession;
    const originalKill = tmux.killSession;

    try {
      // Only 'mine' exists. A prefix-matching implementation would also reap
      // 'mine-operator-session', which is how a cleanup helper eats a real
      // session someone was using.
      tmux.hasSession = (name) => { probed.push(name); return name === 'mine'; };
      tmux.killSession = (name) => { killed.push(name); };

      const result = reapFixtureSessions(['mine', 'absent']);

      assert.deepEqual(killed, ['mine'], 'kills only what exists');
      assert.deepEqual(result, ['mine'], 'reports what it killed');
      assert.deepEqual(probed, ['mine', 'absent'], 'probes exactly the names given, no prefixes');
    } finally {
      tmux.hasSession = originalHas;
      tmux.killSession = originalKill;
    }
  });

  it('reapFixtureSessions never throws when tmux is unavailable', () => {
    // A teardown helper must not fail the run it is cleaning up after.
    const originalHas = tmux.hasSession;
    try {
      tmux.hasSession = () => { throw new Error('tmux: command not found'); };
      assert.doesNotThrow(() => reapFixtureSessions(['anything']));
      assert.deepEqual(reapFixtureSessions(['anything']), []);
    } finally {
      tmux.hasSession = originalHas;
    }
  });
});
