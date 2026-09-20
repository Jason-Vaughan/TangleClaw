'use strict';

/**
 * A mandatory preflight that could NOT BE EVALUATED (#1650).
 *
 * Distinct from every case `launch-recovery-gate.test.js` covers. Those all
 * reach a DECIDED verdict that happens to demand recovery — the evaluator ran,
 * looked, and found damage. Here the evaluator could not run at all, and the
 * old behaviour was to record both requirement flags false and let the launch
 * proceed to an ungated READY. Failing to establish current continuity is not
 * evidence that continuity is sound.
 *
 * Two shapes owe recovery and must stay distinguishable, because they send a
 * reader to different places:
 *   - ATTEMPTED AND FAILED (`evaluationFailed`) — something threw; a server log
 *     on this machine names it.
 *   - NEVER ARRIVED (`evaluationMissing`) — no result reached the snapshot at
 *     all; there is no log, because there was no call.
 *
 * Every induced failure here goes through the REAL evaluator, the REAL stored
 * preflight and the REAL gate. A hand-built `requiresRecovery: true` fixture
 * would assert its own premise and could not tell whether the production
 * composition agrees.
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
const launchPreflight = require('../lib/launch-preflight');
const preflightContext = require('../lib/launch-preflight-context');
const lockfile = require('../lib/handoff-lockfile');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

describe('a preflight that could not be evaluated (#1650)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  let counter = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-preflight-evalfail-'));
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
   * @param {object} [launchOptions] - Passed through
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
   * A project whose preflight THROWS when evaluated.
   *
   * The induction is real, not a stub: the handoff directory is replaced by a
   * regular FILE, so the directory reads inside the evaluator raise ENOTDIR.
   * Nothing here mocks `evaluate`, so the failure enters the system exactly
   * where a real one would.
   * @param {string} name - Project name
   * @returns {object} The project record
   */
  function projectThatCannotBeEvaluated(name) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    const handoffDir = lockfile.handoffDir(project);
    fs.mkdirSync(path.dirname(handoffDir), { recursive: true });
    fs.writeFileSync(handoffDir, 'a file where a directory belongs', 'utf8');
    return project;
  }

  /**
   * Launch a project whose evaluation fails, in a chosen recovery mode.
   * @param {'operator'|'advisory'|null} [recoveryMode] - Project setting
   * @returns {{project: object, sequence: object, id: object}}
   */
  function launchUnevaluable(recoveryMode = null) {
    const name = `evalfail-${counter}`;
    const project = projectThatCannotBeEvaluated(name);
    if (recoveryMode) {
      const conf = store.projectConfig.load(project.path) || {};
      conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode };
      store.projectConfig.save(project.path, conf);
    }
    const session = launch(name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    return { project, sequence, id: { launchId: sequence.launchId, projectId: project.id } };
  }

  /** @param {object} id - Pane identity @returns {object} The ack answer */
  function ackCursorStep(id) {
    let body = launchSequence.next(id).body;
    while (!body.ack) body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
    return launchSequence.next({
      ...id, ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest }
    });
  }

  /** @param {object} id - Pane identity @returns {void} */
  function ackThroughState(id) {
    for (let i = 0; i < 3; i++) ackCursorStep(id);
  }

  describe('the evaluator itself', () => {
    it('owes recovery when it could not run, and says it TRIED', () => {
      const project = projectThatCannotBeEvaluated(`unit-${counter}`);
      const result = preflightContext.evaluate(project, { workspaceId: null });
      assert.equal(result.verdict, 'not-evaluated');
      assert.equal(result.requiresRecovery, true,
        'a check that could not be performed is not a check that passed');
      assert.equal(result.evaluationFailed, true);
      assert.equal(result.evaluationMissing, false, 'it was attempted — the evidence did not merely fail to arrive');
    });

    it('classifies not-evaluated as a recovery verdict', () => {
      assert.equal(launchPreflight.RECOVERY_VERDICTS.has('not-evaluated'), true);
    });

    it('owes recovery when handed nothing at all, rather than answering "fine"', () => {
      // The predicate must not be usable as an open gate by supplying nothing.
      assert.equal(launchPreflight.needsRecovery(undefined), true);
      assert.equal(launchPreflight.needsRecovery(null), true);
      assert.equal(launchPreflight.needsRecovery({}), true);
      assert.equal(launchPreflight.needsRecovery({ verdict: 42 }), true);
    });
  });

  describe('missing evidence at the snapshot boundary', () => {
    // The ruling's "must not regain an open gate through an absent/malformed
    // result or a default constructor". One default, not a permissive
    // constructor case beside a restrictive fallback case.
    it('the not-evaluated default owes recovery and says nothing ever ran', () => {
      assert.equal(launchSequence.PREFLIGHT_NOT_EVALUATED.requiresRecovery, true);
      assert.equal(launchSequence.PREFLIGHT_NOT_EVALUATED.evaluationMissing, true);
      assert.equal(launchSequence.PREFLIGHT_NOT_EVALUATED.evaluationFailed, false,
        'nothing was attempted, so nothing failed — a reader sent to a log would find none');
    });

    it('omitting preflight entirely gates the launch', () => {
      const name = `omitted-${counter}`;
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name, path: dir, engine: 'claude' });
      const engine = store.engines.get('claude');
      const rendered = sessions.renderLaunchSteps(project, engine, {});
      const snapshot = launchSequence.buildSnapshot({
        launchId: launchSequence.mintLaunchId(),
        project,
        engineProfile: engine,
        applicability: { applicable: true, reason: null },
        rendered,
        rules: []
        // preflight deliberately omitted — this is the case under test
      });
      assert.equal(snapshot.recovery, 'required',
        'an omitted argument must not be a way to obtain an open gate');
    });

    it('a null or malformed result gates it too', () => {
      const shapes = [
        ['null', null],
        ['undefined', undefined],
        ['empty object', {}],
        ['non-string verdict', { verdict: 7 }],
        ['a bare string', 'not-an-object']
      ];
      for (const [label, bad] of shapes) {
        const name = `bad-${counter}-${label.replace(/[^a-z0-9]/gi, '')}`;
        const dir = path.join(projectsDir, name);
        fs.mkdirSync(dir, { recursive: true });
        const project = store.projects.create({ name, path: dir, engine: 'claude' });
        const engine = store.engines.get('claude');
        const snapshot = launchSequence.buildSnapshot({
          launchId: launchSequence.mintLaunchId(),
          project,
          engineProfile: engine,
          applicability: { applicable: true, reason: null },
          rendered: sessions.renderLaunchSteps(project, engine, {}),
          rules: [],
          preflight: bad === undefined ? undefined : bad
        });
        assert.equal(snapshot.recovery, 'required', `a preflight of ${label} must gate`);
      }
    });
  });

  describe('operator mode refuses, through the real launch path', () => {
    it('records the demand from a failure nobody decided', () => {
      const { sequence } = launchUnevaluable('operator');
      assert.equal(sequence.preflight.verdict, 'not-evaluated');
      assert.equal(sequence.preflight.requiresRecovery, true);
      assert.equal(sequence.preflight.evaluationFailed, true,
        'provenance survives storage — the row still says it was attempted');
      assert.equal(sequence.recovery, 'required');
      assert.equal(sequence.recoveryMode, 'operator');
    });

    it('withholds the task step', () => {
      const { id } = launchUnevaluable('operator');
      ackThroughState(id);
      const answer = launchSequence.next(id);
      assert.equal(answer.body.withheld, true);
      assert.equal(answer.body.step, null);
      assert.equal(answer.body.verdict, 'not-evaluated');
      assert.equal(answer.body.next, 'recovery-clear');
    });

    it('refuses READY', () => {
      const { id, sequence } = launchUnevaluable('operator');
      ackThroughState(id);
      launchSequence.next(id);
      const answer = launchSequence.ready({
        ...id,
        artifact: {
          schema: 'tc.ready/1',
          preflightVerdict: sequence.preflight.verdict,
          proposedFirstAction: 'carry on regardless'
        }
      });
      assert.equal(answer.body.code, 'RECOVERY_UNCLEARED');
    });
  });

  describe('clearance is permission, not a successful evaluation', () => {
    it('a bound clear permits READY, and the failure provenance SURVIVES it', () => {
      const { id, sequence } = launchUnevaluable('operator');
      ackThroughState(id);
      launchSequence.next(id);
      store.launchSequences.clearRecovery(sequence.id, {
        sessionId: sequence.sessionId,
        recoveryRevision: sequence.recoveryRevision,
        clearance: 'operator-verified',
        clearedBy: 'jason'
      });
      const after = store.launchSequences.getByLaunchId(sequence.launchId);
      assert.equal(after.recoveryClearance, 'operator-verified');
      // The whole point of the ruling's last clause: a clearance does not
      // rewrite what happened. The verdict and its provenance are still here.
      assert.equal(after.preflight.verdict, 'not-evaluated');
      assert.equal(after.preflight.evaluationFailed, true,
        'a cleared launch must still be able to say the evaluation failed');
    });

    it('a clearance bound to the WRONG revision does not clear it', () => {
      const { sequence } = launchUnevaluable('operator');
      const stale = sequence.recoveryRevision + 1;
      const written = store.launchSequences.clearRecovery(sequence.id, {
        sessionId: sequence.sessionId,
        recoveryRevision: stale,
        clearance: 'operator-verified',
        clearedBy: 'jason'
      });
      assert.equal(written, null, 'a clearance bound to the wrong revision writes nothing');
      const after = store.launchSequences.getByLaunchId(sequence.launchId);
      assert.equal(after.recoveryClearance, null, 'nothing cleared it');
      assert.equal(after.recovery, 'required', 'and the demand still stands');
    });
  });

  describe('advisory mode warns rather than withholding', () => {
    it('serves the task step but still records the demand', () => {
      const { id, sequence } = launchUnevaluable('advisory');
      assert.equal(sequence.recoveryMode, 'advisory');
      assert.equal(sequence.recovery, 'required');
      ackThroughState(id);
      const answer = launchSequence.next(id);
      assert.notEqual(answer.body.withheld, true, 'advisory serves the step');
      assert.equal(answer.body.step === null, false);
    });
  });

  describe('controls — what must NOT regress', () => {
    it('a legitimate first launch is EVALUATED, benign, and proceeds', () => {
      // The case the naive fix breaks. First launch is not an absence of
      // evaluation: the evaluator reaches it only after establishing no
      // sessions, no publications, no continuity index and an absent handoff.
      const name = `first-${counter}`;
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name, path: dir, engine: 'claude' });
      const result = preflightContext.evaluate(project, { workspaceId: null });
      assert.equal(result.verdict, 'first-launch');
      assert.equal(result.evaluationFailed, false);
      assert.equal(result.evaluationMissing, false);
      assert.equal(result.requiresRecovery, false,
        'a positively evaluated first launch owes nothing');

      const session = launch(name).session;
      const sequence = store.launchSequences.getBySession(session.id);
      assert.equal(sequence.recovery, 'none', 'end to end, through the real launch path');
    });

    it('a DECIDED corrupt handoff is still its own verdict, not an evaluation failure', () => {
      // Both owe recovery; they are not the same fact, and the row must not
      // blur them — one has a log to read, the other has a document to inspect.
      const name = `corrupt-${counter}`;
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name, path: dir, engine: 'claude' });
      fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
      fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
      const result = preflightContext.evaluate(project, { workspaceId: null });
      assert.equal(result.verdict, 'handoff-corrupt');
      assert.equal(result.requiresRecovery, true);
      assert.equal(result.evaluationFailed, false, 'the evaluator ran and decided — it did not fail');
    });
  });
});
