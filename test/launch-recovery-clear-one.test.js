'use strict';

/**
 * `lib/launch-recovery-clear.js#clearOneLaunch`: the one decision every route
 * that clears a launch's recovery shares.
 *
 * The route test (`launch-recovery-clear.test.js`) holds what a caller is told
 * over HTTP. This file holds the function's own contract: which outcome each
 * state produces, that only `cleared` writes anything, and that a launch is
 * cleared only through the project it belongs to.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { clearOneLaunch, OUTCOMES } = require('../lib/launch-recovery-clear');
const fixture = require('./_recovery-fixture');

describe('clearOneLaunch', () => {
  let env;

  before(() => { env = fixture.openTempStore('tc-clear-one-'); });
  after(() => { env.restore(); });

  const OPERATOR = { clearance: 'operator-verified', clearedBy: 'rosie' };

  /**
   * The `launch.recovery-cleared` activity rows of a project.
   * @param {object} project - Project record
   * @returns {object[]}
   */
  const clearedRows = (project) =>
    store.activity.query({ projectId: project.id, eventType: 'launch.recovery-cleared', limit: 50 });

  /**
   * The stored recovery word of a launch.
   * @param {object} sequence - Sequence as launched
   * @returns {string}
   */
  const storedRecovery = (sequence) => store.launchSequences.getBySession(sequence.sessionId).recovery;

  it('clears a required operator-mode launch and records who and how', () => {
    const { project, sequence, binding } = fixture.launchInRecovery(env);
    const result = clearOneLaunch({ project, ...binding, ...OPERATOR });
    assert.equal(result.outcome, OUTCOMES.CLEARED);
    assert.equal(result.sequence.id, sequence.id);
    assert.equal(result.sequence.recovery, 'cleared');
    assert.equal(result.sequence.recoveryClearance, 'operator-verified');
    assert.equal(result.sequence.recoveryClearedBy, 'rosie');
    assert.equal(storedRecovery(sequence), 'cleared');
    const rows = clearedRows(project);
    assert.equal(rows.length, 1, 'one clear writes one activity row');
    assert.deepEqual(rows[0].detail, {
      sequenceId: sequence.id, clearance: 'operator-verified', clearedBy: 'rosie',
      recoveryRevision: binding.recoveryRevision
    });
  });

  it('records an unproven clear as unverified, naming nobody', () => {
    const { project, binding } = fixture.launchInRecovery(env);
    const result = clearOneLaunch({ project, ...binding, clearance: 'open-install-unverified', clearedBy: null });
    assert.equal(result.outcome, OUTCOMES.CLEARED);
    assert.equal(result.sequence.recoveryClearance, 'open-install-unverified');
    assert.equal(result.sequence.recoveryClearedBy, null);
  });

  it('does not clear a launch through a project it does not belong to', () => {
    const mine = fixture.launchInRecovery(env);
    const theirs = fixture.launchInRecovery(env);
    const result = clearOneLaunch({ project: mine.project, ...theirs.binding, ...OPERATOR });
    assert.deepEqual(result, { outcome: OUTCOMES.NOT_FOUND, sequence: null });
    assert.equal(storedRecovery(theirs.sequence), 'required');
    assert.deepEqual(clearedRows(mine.project), []);
    assert.deepEqual(clearedRows(theirs.project), []);
  });

  it('answers not-found for a session with no launch, and for a sequence id that is not that session\'s', () => {
    const { project, sequence, binding } = fixture.launchInRecovery(env);
    assert.equal(
      clearOneLaunch({ project, ...binding, sessionId: binding.sessionId + 100000, ...OPERATOR }).outcome,
      OUTCOMES.NOT_FOUND);
    assert.equal(
      clearOneLaunch({ project, ...binding, sequenceId: binding.sequenceId + 100000, ...OPERATOR }).outcome,
      OUTCOMES.NOT_FOUND);
    assert.equal(storedRecovery(sequence), 'required');
  });

  it('refuses an advisory launch and changes nothing', () => {
    const { project, sequence, binding } = fixture.launchInRecovery(env, 'advisory');
    const result = clearOneLaunch({ project, ...binding, ...OPERATOR });
    assert.equal(result.outcome, OUTCOMES.ADVISORY);
    assert.equal(result.sequence.id, sequence.id);
    assert.equal(storedRecovery(sequence), 'required');
    assert.deepEqual(clearedRows(project), []);
  });

  it('refuses a recovery revision that has moved, and reports the revision the launch is at', () => {
    const { project, sequence, binding } = fixture.launchInRecovery(env);
    const result = clearOneLaunch({
      project, ...binding, recoveryRevision: binding.recoveryRevision + 1, ...OPERATOR
    });
    assert.equal(result.outcome, OUTCOMES.BINDING_MOVED);
    assert.equal(result.sequence.recoveryRevision, sequence.recoveryRevision);
    assert.equal(storedRecovery(sequence), 'required');
    assert.deepEqual(clearedRows(project), []);
  });

  describe('a launch whose session has ended', () => {
    /**
     * End a launch's session the way a kill, a crash or a wrap does.
     * @param {'killed'|'crashed'|'wrapped'} how - The status to end it at
     * @param {object} sequence - The launch
     * @returns {void}
     */
    function end(how, sequence) {
      if (how === 'killed') store.sessions.kill(sequence.sessionId, 'test');
      else if (how === 'crashed') store.sessions.markCrashed(sequence.sessionId, 'test');
      else store.sessions.wrap(sequence.sessionId, 'test');
      assert.equal(store.sessions.get(sequence.sessionId).status, how, 'the fixture must actually have ended it');
    }

    for (const how of ['killed', 'crashed', 'wrapped']) {
      it(`refuses a ${how} session's launch, names the status and changes nothing`, () => {
        const { project, sequence, binding } = fixture.launchInRecovery(env);
        end(how, sequence);
        const result = clearOneLaunch({ project, ...binding, ...OPERATOR });
        assert.equal(result.outcome, OUTCOMES.SESSION_ENDED);
        assert.equal(result.sessionStatus, how);
        assert.equal(result.sequence.id, sequence.id);
        assert.equal(storedRecovery(sequence), 'required');
        assert.deepEqual(clearedRows(project), []);
      });
    }

    it('treats a launch whose session row is gone as ended', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      const real = store.sessions.get;
      store.sessions.get = () => null;
      try {
        const result = clearOneLaunch({ project, ...binding, ...OPERATOR });
        assert.equal(result.outcome, OUTCOMES.SESSION_ENDED);
        assert.equal(result.sessionStatus, null);
      } finally {
        store.sessions.get = real;
      }
      assert.equal(storedRecovery(sequence), 'required');
    });

    it('still answers a moved revision as moved: stale is decided before ended', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      end('killed', sequence);
      const result = clearOneLaunch({
        project, ...binding, recoveryRevision: binding.recoveryRevision + 1, ...OPERATOR
      });
      assert.equal(result.outcome, OUTCOMES.BINDING_MOVED);
      assert.equal(storedRecovery(sequence), 'required');
    });

    it('still answers an already-cleared launch as not-required after its session ends', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      assert.equal(clearOneLaunch({ project, ...binding, ...OPERATOR }).outcome, OUTCOMES.CLEARED);
      end('killed', sequence);
      assert.equal(clearOneLaunch({ project, ...binding, ...OPERATOR }).outcome, OUTCOMES.NOT_REQUIRED);
    });

    it('still refuses an advisory launch as advisory after its session ends', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env, 'advisory');
      end('crashed', sequence);
      assert.equal(clearOneLaunch({ project, ...binding, ...OPERATOR }).outcome, OUTCOMES.ADVISORY);
    });
  });

  it('answers not-required for a second clear, and writes no second activity row', () => {
    const { project, binding } = fixture.launchInRecovery(env);
    assert.equal(clearOneLaunch({ project, ...binding, ...OPERATOR }).outcome, OUTCOMES.CLEARED);
    const again = clearOneLaunch({ project, ...binding, clearance: 'operator-verified', clearedBy: 'someone-else' });
    assert.equal(again.outcome, OUTCOMES.NOT_REQUIRED);
    assert.equal(again.sequence.recovery, 'cleared');
    assert.equal(again.sequence.recoveryClearedBy, 'rosie', 'the first clear stands');
    assert.equal(clearedRows(project).length, 1);
  });
});
