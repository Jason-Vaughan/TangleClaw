'use strict';

/**
 * The recovery gate (Train 21, #1587): what a launch does when its preflight
 * says the project's handoff state needs recovering.
 *
 * The cases that matter are the ones a healthy launch never reaches. A launch
 * in `operator` recovery must not be able to read the task step or attest, by
 * any route including waiting the unready window out; a launch in `advisory`
 * recovery must be able to read it and must not be able to attest without
 * writing a reconciliation; and the two clearing paths must never cross.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const lockfile = require('../lib/handoff-lockfile');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

describe('launch recovery gate (Train 21, #1587)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  let counter = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-gate-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => { counter += 1; });

  /**
   * Launch with tmux and engine detection stubbed, so no pane is ever started.
   * @param {string} name - Project name
   * @param {object} [launchOptions] - Passed through to `launchSession`
   * @returns {object} The launch result
   */
  function launch(name, launchOptions = {}) {
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      return sessions.launchSession(name, launchOptions);
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  /**
   * A launched project whose preflight demanded recovery.
   *
   * Recovery is driven through the real path rather than written into the row:
   * a `current.json` this build cannot read is preflight row 1
   * (`handoff-corrupt`), which is a recovery verdict whatever else is true of
   * the project — so the gate under test is reached by the mechanism that will
   * reach it in production, not by a fixture asserting its own premise.
   * @param {'operator'|'advisory'|null} [recoveryMode] - The project's setting, or null to leave it default
   * @returns {{project: object, session: object, sequence: object, id: object}}
   */
  function launchInRecovery(recoveryMode = null) {
    const name = `recovery-${counter}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    if (recoveryMode) {
      const conf = store.projectConfig.load(dir) || {};
      conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode };
      store.projectConfig.save(dir, conf);
    }
    fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
    fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
    const session = launch(name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    return { project, session, sequence, id: { launchId: sequence.launchId, projectId: project.id } };
  }

  /**
   * A launched project with a sound handoff state, for the control cases.
   * @returns {{project: object, session: object, sequence: object, id: object}}
   */
  function launchClean() {
    const name = `clean-${counter}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    const session = launch(name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    return { project, session, sequence, id: { launchId: sequence.launchId, projectId: project.id } };
  }

  /**
   * Serve every page of the cursor step and acknowledge it.
   * @param {object} id - The pane's identity
   * @returns {{status: number, body: object}} The answer to the ack
   */
  function ackCursorStep(id) {
    let body = launchSequence.next(id).body;
    while (!body.ack) {
      body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
    }
    return launchSequence.next({
      ...id,
      ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest }
    });
  }

  /**
   * Acknowledge the first three steps, leaving the cursor on the task step.
   * @param {object} id - The pane's identity
   * @returns {void}
   */
  function ackThroughState(id) {
    for (let i = 0; i < 3; i++) ackCursorStep(id);
  }

  describe('recording recovery at launch', () => {
    it('records the preflight\'s recovery demand, and the mode it was told', () => {
      const { sequence } = launchInRecovery('operator');
      assert.equal(sequence.preflight.verdict, 'handoff-corrupt');
      assert.equal(sequence.preflight.requiresRecovery, true);
      assert.equal(sequence.recovery, 'required');
      assert.equal(sequence.recoveryMode, 'operator');
      assert.equal(sequence.recoveryRevision, 1);
      assert.equal(sequence.recoveryClearance, null, 'nothing has cleared it');
    });

    it('records no recovery for a launch whose preflight asked for none', () => {
      const { sequence } = launchClean();
      assert.equal(sequence.preflight.requiresRecovery, false);
      assert.equal(sequence.recovery, 'none');
    });

    it('freezes the project\'s advisory setting with the launch', () => {
      const { sequence } = launchInRecovery('advisory');
      assert.equal(sequence.recoveryMode, 'advisory');
    });

    it('defaults an unset setting to operator, the blocking side', () => {
      const { sequence } = launchInRecovery(null);
      assert.equal(sequence.recoveryMode, 'operator');
    });

    it('records no recovery on a launch that has no steps to withhold', () => {
      // A not-applicable launch gates nothing: `_serve` has no step to withhold
      // and `ready` refuses it with SEQUENCE_NOT_APPLICABLE before any recovery
      // check. Recording `required` would be a demand nothing enforces and no
      // panel renders — and the clear route would then write a clearance for a
      // launch that blocked nobody. The verdict still rides `preflight`, which
      // is where the handoff's soundness is actually recorded.
      const name = `no-sequence-${counter}`;
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name, path: dir, engine: 'claude' });
      fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
      fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
      // `primePrompt: false` is the supported way to reach a not-applicable
      // launch on an engine that DOES support sequences: a launch that asked
      // for no startup context gets none by pull either.
      const session = launch(name, { primePrompt: false }).session;
      const sequence = store.launchSequences.getBySession(session.id);
      assert.equal(sequence.applicability, 'not-applicable', 'the fixture must actually have no sequence');
      assert.equal(sequence.preflight.requiresRecovery, true,
        'the preflight still found the damaged handoff');
      assert.equal(sequence.recovery, 'none',
        'and the launch records no demand, because nothing here can enforce one');
    });
  });

  describe('the step-4 gate in operator mode', () => {
    it('withholds the task step and marks nothing served', () => {
      const { id, sequence } = launchInRecovery('operator');
      ackThroughState(id);
      const answer = launchSequence.next(id);
      assert.equal(answer.status, 200, 'withheld, not refused: the request was fine');
      assert.equal(answer.body.withheld, true);
      assert.equal(answer.body.step, null);
      assert.equal(answer.body.verdict, 'handoff-corrupt');
      assert.equal(answer.body.recoveryRevision, 1);
      assert.equal(answer.body.next, 'recovery-clear');
      assert.match(answer.body.content, /Launch readiness panel/);
      const task = store.launchSequences.listSteps(sequence.id, 1)[3];
      assert.deepEqual(task.pagesServed, [], 'a withheld step was not served');
      assert.equal(task.servedAt, null);
    });

    it('serves the first three steps normally — only the task step is gated', () => {
      const { id } = launchInRecovery('operator');
      for (const expected of ['identity', 'governance', 'state']) {
        const body = launchSequence.next(id).body;
        assert.equal(body.step.id, expected);
        assert.equal(body.withheld, undefined);
        ackCursorStep(id);
      }
    });

    it('an expired unready window does not unlock the task step', () => {
      // The window is an observation, never a gate (§2.3). A launch that sat
      // too long must not become a launch that may skip its recovery.
      const { id, sequence } = launchInRecovery('operator');
      ackThroughState(id);
      store.launchSequences.markUnready(sequence.id);
      store.launchSequences.recordNudge(sequence.id);
      const answer = launchSequence.next(id);
      assert.equal(answer.body.withheld, true);
      assert.equal(answer.body.status.unready, true, 'the window did pass; it just decides nothing here');
    });

    it('serves the task step once recovery is cleared', () => {
      const { id, sequence } = launchInRecovery('operator');
      ackThroughState(id);
      assert.equal(launchSequence.next(id).body.withheld, true);
      store.launchSequences.clearRecovery(sequence.id, {
        sessionId: sequence.sessionId, recoveryRevision: 1, clearance: 'operator-verified', clearedBy: 'jason'
      });
      const body = launchSequence.next(id).body;
      assert.equal(body.withheld, undefined);
      assert.equal(body.step.id, 'task');
      assert.equal(body.status.recovery, 'cleared');
    });
  });

  describe('the step-4 gate in advisory mode', () => {
    it('serves the task step with a recovery notice, and the frozen digest', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackThroughState(id);
      const body = launchSequence.next(id).body;
      assert.equal(body.withheld, undefined);
      assert.equal(body.step.id, 'task');
      assert.equal(body.recovery.verdict, 'handoff-corrupt');
      assert.equal(body.recovery.recoveryRevision, 1);
      const task = store.launchSequences.listSteps(sequence.id, 1)[3];
      const page = body.page.of === 1 ? body : null;
      if (page) {
        assert.equal(body.ack.digest, task.digest,
          'the warning is framing around the snapshot, so the ack is still the snapshot\'s');
      }
      assert.equal(body.content, task.content.slice(...task.pageOffsets[body.page.index]),
        'the served content is the frozen content, byte for byte');
    });

    it('leaves recovery required until READY clears it', () => {
      const { id } = launchInRecovery('advisory');
      ackThroughState(id);
      launchSequence.next(id);
      assert.equal(launchSequence.status(id).body.status.recovery, 'required');
    });
  });

  describe('the READY guard', () => {
    /**
     * Acknowledge every step, clearing an operator-mode recovery first so the
     * task step can be read at all.
     * @param {object} sequence - The sequence
     * @param {object} id - The pane's identity
     * @returns {void}
     */
    function ackEverything(sequence, id) {
      ackThroughState(id);
      ackCursorStep(id);
    }

    it('refuses an operator-mode launch whose recovery is uncleared', () => {
      const { id, sequence } = launchInRecovery('operator');
      ackThroughState(id);
      // The task step is withheld, so the cursor cannot reach 4 — but the
      // refusal under test must be the recovery one and not "steps unacked",
      // because an agent told to acknowledge more steps would loop forever on a
      // step nothing will serve it.
      const answer = launchSequence.ready({
        ...id,
        artifact: {
          schema: 'tc.ready/1', preflightVerdict: 'handoff-corrupt', proposedFirstAction: 'start the chunk',
          reconciliation: 'x'.repeat(60)
        }
      });
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, 'RECOVERY_UNCLEARED');
      assert.equal(answer.body.recoveryMode, 'operator');
      assert.match(answer.body.error, /cannot stand in for that clear/);
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).readyAt, null);
    });

    it('accepts an operator-mode launch once a person has cleared it', () => {
      const { id, sequence } = launchInRecovery('operator');
      ackThroughState(id);
      store.launchSequences.clearRecovery(sequence.id, {
        sessionId: sequence.sessionId, recoveryRevision: 1, clearance: 'operator-verified', clearedBy: 'jason'
      });
      ackCursorStep(id);
      const answer = launchSequence.ready({
        ...id,
        artifact: { schema: 'tc.ready/1', preflightVerdict: 'handoff-corrupt', proposedFirstAction: 'start the chunk' }
      });
      assert.equal(answer.status, 200, answer.body.error);
      assert.equal(answer.body.accepted, true);
      const after = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(after.recoveryClearance, 'operator-verified');
      assert.equal(after.recoveryClearedBy, 'jason');
    });

    it('refuses an advisory launch with no reconciliation, and names the verdict', () => {
      const { id } = launchInRecovery('advisory');
      ackEverything(null, id);
      const answer = launchSequence.ready({
        ...id,
        artifact: { schema: 'tc.ready/1', preflightVerdict: 'handoff-corrupt', proposedFirstAction: 'start the chunk' }
      });
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, 'RECONCILIATION_REQUIRED');
      assert.match(answer.body.reason, /handoff-corrupt/);
    });

    it('accepts an advisory launch with a reconciliation and clears recovery in the same breath', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackEverything(null, id);
      const answer = launchSequence.ready({
        ...id,
        artifact: {
          schema: 'tc.ready/1',
          preflightVerdict: 'handoff-corrupt',
          proposedFirstAction: 'start the chunk',
          reconciliation: 'The previous handoff document is unreadable; I am rebuilding context from the plan and git log.'
        }
      });
      assert.equal(answer.status, 200, answer.body.error);
      assert.equal(answer.body.accepted, true);
      const after = store.launchSequences.getBySession(sequence.sessionId);
      assert.ok(after.readyAt, 'the attestation was recorded');
      assert.equal(after.recovery, 'cleared');
      assert.equal(after.recoveryClearance, 'agent-reconciled');
      assert.equal(after.recoveryClearedBy, null,
        'no operator was involved, and the row must not imply one');
      assert.equal(answer.body.status.recovery, 'cleared');
      // The activity row, not just the column. One event type is named for
      // clearances, so it has to cover all three of them — an operator reading
      // the log for `launch.recovery-cleared` would otherwise see a history
      // missing every clear an advisory session gave itself.
      const events = store.activity.list
        ? store.activity.list({ projectId: sequence.projectId, limit: 50 })
        : store.getDb().prepare(
          'SELECT event_type AS eventType, detail FROM activity_log WHERE project_id = ? ORDER BY id DESC LIMIT 50'
        ).all(sequence.projectId).map((r) => ({ eventType: r.eventType, detail: JSON.parse(r.detail || '{}') }));
      const cleared = events.find((e) => e.eventType === 'launch.recovery-cleared');
      assert.ok(cleared, 'an advisory clear writes the same event the operator path writes');
      assert.equal(cleared.detail.clearance, 'agent-reconciled');
      assert.equal(cleared.detail.clearedBy, null);
      assert.equal(cleared.detail.sequenceId, sequence.id);
    });

    it('writes no clearance event for a launch that owed no recovery', () => {
      const { id, sequence } = launchClean();
      ackThroughState(id);
      ackCursorStep(id);
      launchSequence.ready({
        ...id,
        artifact: {
          schema: 'tc.ready/1',
          preflightVerdict: sequence.preflight.verdict,
          proposedFirstAction: 'start the chunk'
        }
      });
      const rows = store.getDb().prepare(
        "SELECT COUNT(*) AS n FROM activity_log WHERE project_id = ? AND event_type = 'launch.recovery-cleared'"
      ).get(sequence.projectId);
      assert.equal(rows.n, 0, 'nothing was cleared, so nothing claims a clearance');
    });

    it('a launch with no recovery attests without any of this', () => {
      const { id, sequence } = launchClean();
      ackThroughState(id);
      ackCursorStep(id);
      const answer = launchSequence.ready({
        ...id,
        artifact: {
          schema: 'tc.ready/1',
          preflightVerdict: sequence.preflight.verdict,
          proposedFirstAction: 'start the chunk'
        }
      });
      assert.equal(answer.status, 200, answer.body.error);
      assert.equal(answer.body.status.recovery, 'none');
    });
  });

  describe('the clear binding', () => {
    it('refuses a clear for a recovery revision that has moved on', () => {
      const { sequence } = launchInRecovery('operator');
      assert.equal(store.launchSequences.clearRecovery(sequence.id, {
        sessionId: sequence.sessionId, recoveryRevision: 2, clearance: 'operator-verified', clearedBy: 'jason'
      }), null);
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required');
    });

    it('refuses a clear naming a different session', () => {
      const { sequence } = launchInRecovery('operator');
      assert.equal(store.launchSequences.clearRecovery(sequence.id, {
        sessionId: sequence.sessionId + 1000, recoveryRevision: 1, clearance: 'operator-verified', clearedBy: 'jason'
      }), null);
    });

    it('refuses a second clear of an already cleared recovery', () => {
      const { sequence } = launchInRecovery('operator');
      const args = {
        sessionId: sequence.sessionId, recoveryRevision: 1, clearance: 'operator-verified', clearedBy: 'jason'
      };
      assert.ok(store.launchSequences.clearRecovery(sequence.id, args));
      assert.equal(store.launchSequences.clearRecovery(sequence.id, { ...args, clearedBy: 'someone-else' }), null,
        'the first clearance stands; a second call does not re-attribute it');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recoveryClearedBy, 'jason');
    });
  });
});
