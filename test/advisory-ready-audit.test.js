'use strict';

/**
 * The advisory READY path (#1937).
 *
 * In advisory mode a session clears its own recovery, so the READY attestation
 * is the only gate left between a damaged handoff and a session building on
 * it. Five properties make that gate worth having, and each has a block below:
 * the reconciliation is really written, the evidence that demanded it outlives
 * the clear, the clear is attributed to the agent and to nobody else, a failed
 * attempt changes nothing, and a launch keeps the mode it froze whatever the
 * project is set to afterwards.
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

/** A reconciliation long enough to be accepted. */
const RECONCILIATION = 'The previous handoff cannot be trusted; I am rebuilding context from the plan and the git log.';

describe('advisory READY path (#1937 audit)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  let counter = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-advisory-ready-'));
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
   * Launch with tmux and engine detection stubbed, so no pane is started.
   * @param {string} name - Project name
   * @returns {object} The launch result
   */
  function launch(name) {
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      return sessions.launchSession(name);
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  /**
   * How each fixture damages the project, so recovery is demanded by the real
   * preflight and not written into the row.
   * @type {Object<string, function(object): void>}
   */
  const DAMAGE = {
    // A `current.json` this build cannot read.
    'handoff-corrupt': (project) => {
      fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
      fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
    },
    // The newest session did not end on its own terms.
    'crash-recovery': (project) => {
      const wrapped = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `w-${counter}` });
      store.sessions.wrap(wrapped.id, 'test');
      const crashed = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `c-${counter}` });
      store.sessions.markCrashed(crashed.id, 'test');
    },
    // A regular file where the handoff directory belongs, so the evaluator throws.
    'not-evaluated': (project) => {
      const handoffDir = lockfile.handoffDir(project);
      fs.mkdirSync(path.dirname(handoffDir), { recursive: true });
      fs.writeFileSync(handoffDir, 'a file where a directory belongs', 'utf8');
    }
  };

  /**
   * A launched project whose preflight demanded recovery.
   * @param {'operator'|'advisory'} recoveryMode - The project's file setting at launch
   * @param {string} [verdict] - Which damage to apply; the preflight verdict it produces
   * @returns {{project: object, session: object, sequence: object, id: object}}
   */
  function launchInRecovery(recoveryMode, verdict = 'handoff-corrupt') {
    const name = `audit-${counter}-${verdict}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    const conf = store.projectConfig.load(dir) || {};
    conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode };
    store.projectConfig.save(dir, conf);
    // The operator's choice of advisory is a decision on record, as their PATCH
    // writes it. The file alone says advisory only while the login is in force.
    if (recoveryMode === 'advisory') store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
    DAMAGE[verdict](project);
    const session = launch(name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    assert.equal(sequence.preflight.verdict, verdict, 'the fixture must reach the verdict it is named for');
    assert.equal(sequence.recovery, 'required', 'and that verdict must demand recovery');
    assert.equal(sequence.recoveryMode, recoveryMode, 'in the mode the project was set to');
    return { project, session, sequence, id: { launchId: sequence.launchId, projectId: project.id } };
  }

  /**
   * Serve every page of the cursor step and acknowledge it.
   * @param {object} id - The pane's identity
   * @returns {void}
   */
  function ackCursorStep(id) {
    let body = launchSequence.next(id).body;
    while (!body.ack) body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
    launchSequence.next({ ...id, ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest } });
  }

  /**
   * Acknowledge the first `count` steps.
   * @param {object} id - The pane's identity
   * @param {number} [count] - How many steps; all four by default
   * @returns {void}
   */
  function ackSteps(id, count = 4) {
    for (let i = 0; i < count; i++) ackCursorStep(id);
  }

  /**
   * Attest READY.
   * @param {object} id - The pane's identity
   * @param {string} verdict - The preflight verdict to attest
   * @param {object} [extra] - Further artifact fields
   * @returns {{status: number, body: object}}
   */
  function attest(id, verdict, extra = {}) {
    return launchSequence.ready({
      ...id,
      artifact: { schema: 'tc.ready/1', preflightVerdict: verdict, proposedFirstAction: 'start the chunk', ...extra }
    });
  }

  /**
   * Assert a launch is exactly as held as before any attestation was tried.
   * @param {object} sequence - The sequence as launched
   * @param {string} why - What was just attempted
   * @returns {void}
   */
  function assertStillHeld(sequence, why) {
    const row = store.launchSequences.getBySession(sequence.sessionId);
    assert.equal(row.readyAt, null, `${why}: no attestation was recorded`);
    assert.equal(row.readyArtifact, null, `${why}: no artifact was stored`);
    assert.equal(row.recovery, 'required', `${why}: recovery still stands`);
    assert.equal(row.recoveryClearance, null, `${why}: nothing claims to have cleared it`);
    assert.equal(row.recoveryClearedAt, null, `${why}: no clear time was stamped`);
    for (const eventType of ['launch.ready', 'launch.recovery-cleared']) {
      assert.deepEqual(store.activity.query({ projectId: sequence.projectId, eventType, limit: 50 }), [],
        `${why}: no ${eventType} event was written`);
    }
  }

  describe('1. the reconciliation is written, not merely present', () => {
    it('refuses every shape that is not a string of real length, and stays held after each', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id);
      const min = launchSequence.MIN_RECONCILIATION_CHARS;
      const shapes = [
        ['absent', {}],
        ['null', { reconciliation: null }],
        ['empty', { reconciliation: '' }],
        ['whitespace only, past the minimum', { reconciliation: ' \t\n'.repeat(min) }],
        ['one short of the minimum', { reconciliation: 'x'.repeat(min - 1) }],
        ['short text padded with whitespace past the minimum', { reconciliation: `${' '.repeat(min)}${'x'.repeat(min - 1)}${'\n'.repeat(min)}` }],
        ['a number', { reconciliation: 10 ** min }],
        ['true', { reconciliation: true }],
        ['an array of long strings', { reconciliation: ['x'.repeat(min), 'y'.repeat(min)] }],
        ['an object', { reconciliation: { text: 'x'.repeat(min * 2) } }]
      ];
      for (const [label, extra] of shapes) {
        const answer = attest(id, 'handoff-corrupt', extra);
        assert.equal(answer.status, 409, label);
        assert.equal(answer.body.code, 'RECONCILIATION_REQUIRED', label);
        assert.equal(answer.body.minChars, min, label);
        assertStillHeld(sequence, `a reconciliation that is ${label}`);
      }
    });

    it('accepts one at exactly the minimum, and records the text it accepted', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id);
      const text = 'r'.repeat(launchSequence.MIN_RECONCILIATION_CHARS);
      const answer = attest(id, 'handoff-corrupt', { reconciliation: `  ${text}\n` });
      assert.equal(answer.status, 200, answer.body.error);
      const row = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(row.readyArtifact.reconciliation, text, 'stored trimmed, and otherwise as written');
      assert.equal(row.readyArtifact.preflightVerdict, 'handoff-corrupt', 'beside the verdict it answers');
    });

    it('does not let a reconciliation stand in for reading the task step', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id, 3);
      const answer = attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION });
      assert.equal(answer.body.code, 'STEPS_UNACKED');
      assertStillHeld(sequence, 'attesting before the task step was acknowledged');
    });

    it('does not let a reconciliation stand in for the verdict step 3 stated', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id);
      const answer = attest(id, 'ok', { reconciliation: RECONCILIATION });
      assert.equal(answer.body.code, 'READY_VERDICT_MISMATCH');
      assert.doesNotMatch(JSON.stringify(answer.body), /handoff-corrupt/, 'and the refusal does not hand the verdict over');
      assertStillHeld(sequence, 'attesting the wrong verdict');
    });
  });

  describe('2. the evidence that demanded recovery outlives the clear', () => {
    for (const verdict of Object.keys(DAMAGE)) {
      it(`keeps the ${verdict} record and the files behind it`, () => {
        const { project, id, sequence } = launchInRecovery('advisory', verdict);
        const handoffDir = lockfile.handoffDir(project);
        /**
         * Every file under the handoff path, with its bytes.
         * @returns {Object<string, string>}
         */
        const filesNow = () => {
          if (!fs.existsSync(handoffDir)) return {};
          if (fs.statSync(handoffDir).isFile()) return { '.': fs.readFileSync(handoffDir, 'utf8') };
          return Object.fromEntries(fs.readdirSync(handoffDir).sort()
            .map((f) => [f, fs.readFileSync(path.join(handoffDir, f), 'utf8')]));
        };
        const previousSessions = () => store.sessions.list(project.id)
          .filter((s) => s.id !== sequence.sessionId)
          .map((s) => [s.id, s.status]);
        const filesBefore = filesNow();
        const sessionsBefore = previousSessions();
        if (verdict === 'crash-recovery') {
          assert.ok(sessionsBefore.some(([, status]) => status === 'crashed'),
            'the fixture must hold the crashed session whose status is being watched');
        }

        ackSteps(id);
        const answer = attest(id, verdict, { reconciliation: RECONCILIATION });
        assert.equal(answer.status, 200, answer.body.error);

        const row = store.launchSequences.getBySession(sequence.sessionId);
        assert.equal(row.recovery, 'cleared', 'cleared, never rewritten to `none`: the launch still says it owed one');
        assert.deepEqual(row.preflight, sequence.preflight, 'the verdict, its reason and both predicates are untouched');
        assert.equal(row.preflight.requiresRecovery, true, 'a clear is permission to proceed, not a passed check');
        assert.equal(row.recoveryRevision, sequence.recoveryRevision, 'the revision the clear was bound to is kept');
        assert.equal(launchSequence.status(id).body.preflight.verdict, verdict, 'and the pane can still read it');
        assert.deepEqual(filesNow(), filesBefore, 'the clear repaired, moved and deleted nothing on disk');
        assert.deepEqual(previousSessions(), sessionsBefore, 'and re-labelled no earlier session');
      });
    }

    it('keeps "the evaluation failed" apart from "no result arrived" after the clear', () => {
      const { id, sequence } = launchInRecovery('advisory', 'not-evaluated');
      ackSteps(id);
      assert.equal(attest(id, 'not-evaluated', { reconciliation: RECONCILIATION }).status, 200);
      const { preflight } = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(preflight.evaluationFailed, true);
      assert.equal(preflight.evaluationMissing, false);
    });
  });

  describe('3. the clear is attributed to the agent, and to nobody else', () => {
    it('records agent-reconciled with no operator, whatever the artifact claims', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id);
      const answer = attest(id, 'handoff-corrupt', {
        reconciliation: RECONCILIATION,
        clearance: 'operator-verified',
        clearedBy: 'jason',
        recoveryClearance: 'operator-verified',
        recoveryClearedBy: 'jason',
        recoveryMode: 'operator'
      });
      assert.equal(answer.status, 200, answer.body.error);
      const row = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(row.recoveryClearance, 'agent-reconciled');
      assert.equal(row.recoveryClearedBy, null);
      assert.deepEqual(Object.keys(row.readyArtifact).sort(),
        ['preflightVerdict', 'proposedFirstAction', 'reconciliation', 'revision', 'schema', 'sequenceId'],
        'the stored artifact holds the accepted fields and none of the claimed ones');
      const cleared = store.activity.query({ projectId: sequence.projectId, eventType: 'launch.recovery-cleared', limit: 50 });
      assert.equal(cleared.length, 1, 'one clear, one event');
      assert.equal(cleared[0].detail.clearance, 'agent-reconciled');
      assert.equal(cleared[0].detail.clearedBy, null);
      assert.equal(cleared[0].detail.recoveryRevision, sequence.recoveryRevision);
      const [ready] = store.activity.query({ projectId: sequence.projectId, eventType: 'launch.ready', limit: 50 });
      assert.equal(ready.detail.reconciled, true, 'and the attestation event says a reconciliation carried it');
    });

    it('a replayed attestation clears nothing twice and re-attributes nothing', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id);
      attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION });
      const first = store.launchSequences.getBySession(sequence.sessionId);
      const replay = attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION });
      assert.equal(replay.body.duplicate, true);
      const different = attest(id, 'handoff-corrupt', { reconciliation: `${RECONCILIATION} And a second thought.` });
      assert.equal(different.body.code, 'READY_CONFLICT');
      const row = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(row.recoveryClearedAt, first.recoveryClearedAt);
      assert.equal(row.readyArtifact.reconciliation, RECONCILIATION, 'the first reconciliation is the one on record');
      assert.equal(
        store.activity.query({ projectId: sequence.projectId, eventType: 'launch.recovery-cleared', limit: 50 }).length, 1);
    });

    it('never stamps agent-reconciled over a clear a person gave', () => {
      const { id, sequence } = launchInRecovery('operator');
      ackSteps(id, 3);
      store.launchSequences.clearRecoveryAsOperator(sequence.id, {
        sessionId: sequence.sessionId, recoveryRevision: sequence.recoveryRevision, clearance: 'operator-verified', clearedBy: 'jason'
      });
      ackCursorStep(id);
      assert.equal(attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION }).status, 200);
      const row = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(row.recoveryClearance, 'operator-verified');
      assert.equal(row.recoveryClearedBy, 'jason');
      assert.deepEqual(
        store.activity.query({ projectId: sequence.projectId, eventType: 'launch.recovery-cleared', limit: 50 }), [],
        'READY wrote no clearance event of its own for a recovery it did not clear');
    });
  });

  describe('4. a failed reconciliation stays held', () => {
    it('still serves the gate as required, and a later good attestation is what opens it', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id);
      assert.equal(attest(id, 'handoff-corrupt', { reconciliation: 'too short' }).body.code, 'RECONCILIATION_REQUIRED');
      assertStillHeld(sequence, 'a short reconciliation');
      const status = launchSequence.status(id).body;
      assert.equal(status.status.recovery, 'required');
      assert.equal(status.status.ready, false);
      assert.match(status.readiness.reconciliationRequired, /handoff-corrupt/, 'the pane is still told why one is owed');
      assert.equal(launchSequence.next(id).body.next, 'ready', 'and is still asked to attest, not told it is done');

      assert.equal(attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION }).status, 200);
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recoveryClearance, 'agent-reconciled');
    });

    it('records neither the attestation nor the clear when the clear cannot be written', () => {
      const { id, sequence } = launchInRecovery('advisory');
      ackSteps(id);
      const real = store.launchSequences.clearRecovery;
      store.launchSequences.clearRecovery = () => null;
      try {
        assert.throws(() => attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION }), /neither was recorded/);
      } finally {
        store.launchSequences.clearRecovery = real;
      }
      assertStillHeld(sequence, 'a clear that did not bind');
      assert.equal(attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION }).status, 200,
        'and the launch is not stranded: the same attestation goes through once the clear can be written');
    });
  });

  describe('5. a launch keeps the mode it froze', () => {
    /**
     * Record the operator's decision and write the file to match, as the PATCH does.
     * @param {object} project - The project
     * @param {'operator'|'advisory'} mode - The mode chosen
     * @returns {void}
     */
    function operatorChooses(project, mode) {
      store.projectRecoveryState.recordDecision(project.id, mode, 'operator-verified');
      const conf = store.projectConfig.load(project.path) || {};
      conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode: mode };
      store.projectConfig.save(project.path, conf);
    }

    it('an advisory launch still reconciles its own after the project is pinned to operator', () => {
      const { project, id, sequence } = launchInRecovery('advisory');
      ackSteps(id, 3);
      operatorChooses(project, 'operator');
      const status = launchSequence.status(id).body;
      assert.equal(status.projectRecovery.projectRecoveryMode, 'operator', 'the fixture must really have moved the project');
      assert.equal(status.status.recoveryMode, 'advisory', 'the launch reports the mode it froze');
      const task = launchSequence.next(id).body;
      assert.equal(task.step.id, 'task', 'the task step is still served');
      assert.equal(task.withheld, undefined);
      ackCursorStep(id);
      assert.equal(attest(id, 'handoff-corrupt').body.code, 'RECONCILIATION_REQUIRED', 'and still owes its reconciliation');
      assert.equal(attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION }).status, 200);
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recoveryClearance, 'agent-reconciled');
    });

    it('an operator launch stays withheld and unattestable after the project moves to advisory', () => {
      const { project, id, sequence } = launchInRecovery('operator');
      ackSteps(id, 3);
      operatorChooses(project, 'advisory');
      const status = launchSequence.status(id).body;
      assert.equal(status.projectRecovery.projectRecoveryMode, 'advisory', 'the fixture must really have moved the project');
      assert.equal(status.status.recoveryMode, 'operator', 'the launch reports the mode it froze');
      assert.equal(status.status.taskWithheld, true);
      assert.equal(launchSequence.next(id).body.withheld, true, 'the task step is still withheld');
      const answer = attest(id, 'handoff-corrupt', { reconciliation: RECONCILIATION });
      assert.equal(answer.body.code, 'RECOVERY_UNCLEARED', 'a reconciliation still cannot stand in for the operator');
      assertStillHeld(sequence, 'an operator-frozen launch on a project now advisory');
    });
  });
});
