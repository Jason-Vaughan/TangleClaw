'use strict';

/**
 * The launch sequence's attestation half (Train 21, Chunk 02): `tc start ready`,
 * the snapshot revision a mid-launch rule change forces, and the unready window.
 *
 * The acceptance cases come from the plan's Chunk 02 list. The ones a happy path
 * never reaches are the point: a rule edit between the first step and the
 * attestation, a step-1 acknowledgement carried onto content that is only
 * BYTE-EQUAL, a second attestation with a different artifact, and an attestation
 * whose verdict is not the one the server recorded.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

describe('launch sequence attestation (Train 21, Chunk 02)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-ready-'));
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

  /**
   * Create a project with its own directory.
   * @param {string} name - Project and directory name
   * @param {string} [engine] - Engine id
   * @returns {object} The project record
   */
  function makeProject(name, engine = 'claude') {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return store.projects.create({ name, path: dir, engine });
  }

  /**
   * Launch with tmux and engine detection stubbed, so no pane is ever started.
   * @param {string} name - Project name
   * @param {object} [opts]
   * @param {object} [opts.launchOptions] - Passed through to `launchSession`
   * @returns {object} The launch result
   */
  function launch(name, opts = {}) {
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      return sessions.launchSession(name, opts.launchOptions || {});
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  /**
   * A launched project with its sequence, ready to drive.
   * @param {string} name - Project name
   * @returns {{project: object, session: object, sequence: object, id: {launchId: string, projectId: number}}}
   */
  function launched(name) {
    const project = makeProject(name);
    const session = launch(name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    return { project, session, sequence, id: { launchId: sequence.launchId, projectId: project.id } };
  }

  /**
   * Serve every page of the cursor step and acknowledge it.
   * @param {{launchId: string, projectId: number}} id - The pane's identity
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
   * Acknowledge all four steps.
   * @param {{launchId: string, projectId: number}} id - The pane's identity
   * @returns {void}
   */
  function ackEverything(id) {
    for (let i = 0; i < store.LAUNCH_STEP_IDS.length; i++) {
      const answer = ackCursorStep(id);
      assert.equal(answer.status, 200, `step ${i} acknowledged: ${JSON.stringify(answer.body.error || '')}`);
    }
    const seq = store.launchSequences.getByLaunchId(id.launchId);
    assert.equal(seq.cursor, store.LAUNCH_STEP_IDS.length, 'every step is acknowledged');
  }

  /**
   * A valid attestation for a sequence at its current state.
   * @param {object} sequence - The sequence row
   * @param {object} [overrides] - Fields to replace
   * @returns {object} A `tc.ready/1` artifact
   */
  function artifactFor(sequence, overrides = {}) {
    return {
      schema: 'tc.ready/1',
      sequenceId: sequence.id,
      revision: sequence.revision,
      preflightVerdict: sequence.preflight.verdict,
      proposedFirstAction: 'read the build plan and confirm the next chunk with the operator',
      ...overrides
    };
  }

  describe('READY', () => {
    it('accepts an attestation once every step is acknowledged', () => {
      const { id, launchId } = (() => {
        const l = launched('ready-happy');
        return { id: l.id, launchId: l.sequence.launchId };
      })();
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(launchId);
      const answer = launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.accepted, true);
      assert.equal(answer.body.duplicate, false);
      assert.equal(answer.body.status.ready, true);
      const stored = store.launchSequences.getByLaunchId(launchId);
      assert.ok(stored.readyAt, 'the attestation is recorded on the sequence');
      assert.ok(stored.readyDigest, 'with a digest, so a duplicate can be recognised');
      assert.equal(stored.readyArtifact.proposedFirstAction,
        'read the build plan and confirm the next chunk with the operator');
    });

    it('refuses an attestation while steps are unacknowledged', () => {
      const { id, sequence } = launched('ready-too-early');
      const answer = launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, 'STEPS_UNACKED');
      assert.equal(answer.body.cursor, 0);
      assert.equal(answer.body.of, store.LAUNCH_STEP_IDS.length);
    });

    it('refuses a verdict that is not the one the server recorded, without echoing the right one', () => {
      const { id, sequence } = launched('ready-wrong-verdict');
      ackEverything(id);
      const answer = launchSequence.ready({
        ...id,
        artifact: artifactFor(sequence, { preflightVerdict: 'ok' })
      });
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, 'READY_VERDICT_MISMATCH');
      // The refusal must not hand back the answer: the field exists to evidence
      // that step 3 was read, and a retry that copies the refusal has read nothing.
      assert.ok(!JSON.stringify(answer.body).includes(sequence.preflight.verdict),
        'the stored verdict is not disclosed in the refusal');
      assert.equal(store.launchSequences.getByLaunchId(id.launchId).readyAt, null);
    });

    it('requires a first action, and says it is a proposal rather than an authorization', () => {
      const { id, sequence } = launched('ready-no-action');
      ackEverything(id);
      const answer = launchSequence.ready({
        ...id,
        artifact: artifactFor(sequence, { proposedFirstAction: '   ' })
      });
      assert.equal(answer.status, 400);
      assert.equal(answer.body.code, 'BAD_READY');
      assert.match(answer.body.error, /proposal, not an authorization/);
    });

    it('is idempotent for the same artifact and a conflict for a different one', () => {
      const { id, launchId } = (() => {
        const l = launched('ready-duplicate');
        return { id: l.id, launchId: l.sequence.launchId };
      })();
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(launchId);
      const artifact = artifactFor(sequence);
      const first = launchSequence.ready({ ...id, artifact });
      assert.equal(first.status, 200);

      const replay = launchSequence.ready({ ...id, artifact: { ...artifact } });
      assert.equal(replay.status, 200, 'a replayed attestation is idempotent');
      assert.equal(replay.body.duplicate, true);
      assert.equal(replay.body.readyAt, first.body.readyAt, 'and does not re-date the record');

      const conflict = launchSequence.ready({
        ...id,
        artifact: { ...artifact, proposedFirstAction: 'something else entirely, decided later' }
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'READY_CONFLICT');
      assert.equal(store.launchSequences.getByLaunchId(launchId).readyArtifact.proposedFirstAction,
        artifact.proposedFirstAction, 'the attestation on record is unchanged');
    });

    it('refuses an attestation once the session has ended', () => {
      const { id, session, sequence } = launched('ready-session-ended');
      ackEverything(id);
      store.sessions.kill(session.id);
      const answer = launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, 'SESSION_ENDED');
    });

    it('refuses an artifact that is not a tc.ready/1 object', () => {
      const { id } = launched('ready-bad-schema');
      ackEverything(id);
      for (const artifact of [null, 'ready', { schema: 'tc.launch/1' }]) {
        const answer = launchSequence.ready({ ...id, artifact });
        assert.equal(answer.status, 400, `refused: ${JSON.stringify(artifact)}`);
        assert.equal(answer.body.code, 'BAD_READY');
      }
    });
  });

  describe('a rule change under a live snapshot', () => {
    it('revises the snapshot, voids old-revision acks, and carries step 1 over unchanged', () => {
      const { project, id, sequence } = launched('revise-on-rule-change');
      const firstAnswer = ackCursorStep(id);
      assert.equal(firstAnswer.status, 200);
      const identity = store.launchSequences.listSteps(sequence.id, 1)[0];
      assert.ok(identity.ackedAt, 'step 1 is acknowledged at revision 1');
      const governanceDigest = store.launchSequences.listSteps(sequence.id, 1)[1].digest;

      store.sessionRules.create({ projectId: project.id, content: 'A rule the launch never saw.' });

      const served = launchSequence.next(id);
      assert.equal(served.status, 200);
      assert.equal(served.body.revision, 2, 'the snapshot is re-rendered at a new revision');
      assert.deepEqual(served.body.revised, { code: 'SNAPSHOT_REVISED', reason: 'rules changed', revision: 2 });
      assert.equal(served.body.step.id, 'governance', 'the cursor is back at the first re-rendered step');

      const revisedSteps = store.launchSequences.listSteps(sequence.id, 2);
      assert.equal(revisedSteps[0].carriedFromRevision, 1, 'step 1 carried over');
      assert.ok(revisedSteps[0].ackedAt, 'keeping its acknowledgement');
      assert.equal(revisedSteps[0].content, identity.content, 'which is sound only because the bytes are equal');
      assert.notEqual(revisedSteps[1].digest, governanceDigest, 'the governance step is genuinely different');
      assert.equal(revisedSteps[1].ackedAt, null, 'and is unacknowledged');

      // The old revision's rows are untouched: evidence recorded against
      // content is never re-pointed at different content.
      assert.ok(store.launchSequences.listSteps(sequence.id, 1)[0].ackedAt);

      const staleAck = launchSequence.next({
        ...id,
        ack: { step: 'governance', revision: 1, digest: governanceDigest }
      });
      assert.equal(staleAck.status, 409);
      assert.equal(staleAck.body.code, 'SNAPSHOT_REVISED');
      assert.equal(staleAck.body.revision, 2);
    });

    it('re-renders step 1 unacked when the global rules changed with it', () => {
      const { project, id, sequence } = launched('revise-global-rules');
      ackCursorStep(id);
      const before = store.launchSequences.listSteps(sequence.id, 1)[0];

      const globalsBefore = store.globalRules.load();
      try {
        store.globalRules.save(`${globalsBefore || ''}\n- A global rule added mid-launch.\n`);
        store.sessionRules.create({ projectId: project.id, content: 'A project rule added at the same time.' });
        const served = launchSequence.next(id);
        assert.equal(served.body.revision, 2);
        const revised = store.launchSequences.listSteps(sequence.id, 2)[0];
        assert.equal(revised.carriedFromRevision, null, 'step 1 is not carried');
        assert.equal(revised.ackedAt, null, 'and its acknowledgement does not survive');
        assert.notEqual(revised.content, before.content);
        assert.equal(served.body.step.id, 'identity', 'the cursor is back at step 1');
      } finally {
        store.globalRules.save(globalsBefore || '');
      }
    });

    it('demands a reconciliation once a snapshot has been revised', () => {
      const { project, id } = launched('revise-then-ready');
      store.sessionRules.create({ projectId: project.id, content: 'A rule added before the first step was pulled.' });
      // The first `next` revises; from here the launch runs at revision 2.
      launchSequence.next(id);
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(sequence.revision, 2);

      const bare = launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      assert.equal(bare.status, 409);
      assert.equal(bare.body.code, 'RECONCILIATION_REQUIRED');
      assert.equal(bare.body.minChars, launchSequence.MIN_RECONCILIATION_CHARS);

      const tooShort = launchSequence.ready({
        ...id,
        artifact: artifactFor(sequence, { reconciliation: 'rules changed' })
      });
      assert.equal(tooShort.body.code, 'RECONCILIATION_REQUIRED', 'a four-word field is not an account');

      const reconciled = launchSequence.ready({
        ...id,
        artifact: artifactFor(sequence, {
          reconciliation: 'The project rules gained a rule after I read the governance step; I re-read it at revision 2 and nothing I had planned changes.'
        })
      });
      assert.equal(reconciled.status, 200);
      assert.equal(reconciled.body.artifact.reconciliation.length >= launchSequence.MIN_RECONCILIATION_CHARS, true);
    });

    it('re-renders with the launch-time facts only the launch had', () => {
      // The reason the snapshot records a render context at all: the heal
      // report, the operator host and the workspace id are launch-time facts,
      // and a revision that dropped them would quietly serve a thinner step 3
      // than the one the session first read.
      const project = makeProject('revise-render-context');
      const session = launch('revise-render-context', {
        launchOptions: { operatorHost: 'operator.example.test' }
      }).session;
      const sequence = store.launchSequences.getBySession(session.id);
      const id = { launchId: sequence.launchId, projectId: project.id };
      const context = sequence.sourceManifest.renderContext;
      assert.equal(context.operatorHost, 'operator.example.test',
        'the launch records what only it knows');

      store.sessionRules.create({ projectId: project.id, content: 'A rule added after the launch.' });
      launchSequence.next(id);
      const revised = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(revised.revision, 2);
      assert.equal(revised.sourceManifest.renderContext.operatorHost, 'operator.example.test',
        'and the new revision was built from the same context');
      const before = store.launchSequences.listSteps(sequence.id, 1);
      const after = store.launchSequences.listSteps(sequence.id, 2);
      const hostLine = (steps) => steps.map((st) => st.content).join('\n').includes('operator.example.test');
      assert.equal(hostLine(before), hostLine(after),
        'so the re-rendered steps still carry the launch-time facts');
    });

    it('revises a sequence that carries no render context, and says so in the manifest', () => {
      // Sequences created before render contexts were recorded. They re-render
      // from what is knowable now; the gap is visible in the manifest rather
      // than silent.
      const project = makeProject('revise-legacy-context');
      const session = launch('revise-legacy-context').session;
      const sequence = store.launchSequences.getBySession(session.id);
      const stripped = { ...sequence.sourceManifest };
      delete stripped.renderContext;
      store.getDb().prepare('UPDATE launch_sequences SET source_manifest = ? WHERE id = ?')
        .run(JSON.stringify(stripped), sequence.id);

      store.sessionRules.create({ projectId: project.id, content: 'A rule added under a legacy sequence.' });
      const served = launchSequence.next({ launchId: sequence.launchId, projectId: project.id });
      assert.equal(served.status, 200);
      assert.equal(served.body.revision, 2, 'the revision still happens');
      const revised = store.launchSequences.getByLaunchId(sequence.launchId);
      assert.equal(revised.sourceManifest.renderContext, null,
        'and the absent context is recorded as absent');
      assert.equal(store.launchSequences.listSteps(sequence.id, 2).length, store.LAUNCH_STEP_IDS.length);
    });

    it('refuses an attestation that arrives after the revision it was written against', () => {
      const { project, id, sequence } = launched('ready-then-revised');
      ackEverything(id);
      store.sessionRules.create({ projectId: project.id, content: 'A rule added after every step was acknowledged.' });
      const answer = launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      assert.equal(answer.status, 409);
      assert.equal(answer.body.code, 'SNAPSHOT_REVISED');
      assert.equal(answer.body.revision, 2);
      assert.equal(store.launchSequences.getByLaunchId(id.launchId).readyAt, null,
        'nothing is attested against a snapshot that moved');
    });

    it('leaves an already-attested launch alone when the rules change afterwards', () => {
      const { project, id } = launched('ready-before-rule-change');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const artifact = artifactFor(sequence);
      assert.equal(launchSequence.ready({ ...id, artifact }).status, 200);

      store.sessionRules.create({ projectId: project.id, content: 'A rule added after the attestation.' });
      const replay = launchSequence.ready({ ...id, artifact });
      assert.equal(replay.status, 200, 'the duplicate is still idempotent');
      assert.equal(replay.body.duplicate, true);
      // §2.5: after READY a rule change does not invalidate readiness —
      // delivering it is the rules channel's job, not the sequence's.
      assert.equal(store.launchSequences.getByLaunchId(id.launchId).revision, 1,
        'and an attested sequence is not re-rendered underneath it');
    });
  });

  describe('the unready window', () => {
    it('stamps once, counts nudges sent, and changes no gate', () => {
      const { id, sequence } = launched('unready-window');
      assert.equal(store.launchSequences.markUnready(sequence.id), true);
      assert.equal(store.launchSequences.markUnready(sequence.id), false, 'the first stamp stands');
      const stamped = store.launchSequences.getByLaunchId(id.launchId);
      assert.ok(stamped.unreadyAt);
      assert.equal(stamped.cursor, 0, 'the cursor is untouched');

      store.launchSequences.recordNudge(sequence.id);
      const nudged = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(nudged.nudgeCount, 1);
      assert.ok(nudged.lastNudgedAt);

      // A later attestation is exactly as valid as it would have been.
      ackEverything(id);
      const current = store.launchSequences.getByLaunchId(id.launchId);
      const answer = launchSequence.ready({ ...id, artifact: artifactFor(current) });
      assert.equal(answer.status, 200, 'an unready window never invalidates a later READY');
      assert.equal(answer.body.status.unready, true, 'and the window is still reported');
    });

    it('lists only the unready sequences of live sessions', () => {
      const live = launched('unready-live');
      const ended = launched('unready-ended');
      const attested = launched('unready-attested');
      ackEverything(attested.id);
      const seq = store.launchSequences.getByLaunchId(attested.id.launchId);
      launchSequence.ready({ ...attested.id, artifact: artifactFor(seq) });
      store.sessions.kill(ended.session.id);

      const listed = store.launchSequences.listUnreadyOfActiveSessions().map((s) => s.sessionId);
      assert.ok(listed.includes(live.session.id), 'a live session that has not attested is listed');
      assert.ok(!listed.includes(ended.session.id), 'a session that ended is not');
      assert.ok(!listed.includes(attested.session.id), 'nor is one that attested');
    });

    it('reports readiness and nudge evidence in status', () => {
      const { id, sequence } = launched('unready-status');
      store.launchSequences.markUnready(sequence.id);
      store.launchSequences.recordNudge(sequence.id);
      const shown = launchSequence.status(id).body;
      assert.equal(shown.readiness.readyAt, null);
      assert.ok(shown.readiness.unreadyAt);
      assert.equal(shown.readiness.nudgeCount, 1);
      assert.equal(shown.readiness.reconciliationRequired, null);
      assert.deepEqual(shown.pending.stages, ['recovery'],
        'READY and the window are built, so only recovery is still declared pending');
    });
  });

  describe("a project's sequences, for the readiness panel", () => {
    it('answers newest first and only for that project', () => {
      const mine = launched('panel-mine');
      const theirs = launched('panel-theirs');
      const listed = store.launchSequences.listForProject(mine.project.id, 5);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].sessionId, mine.session.id);
      assert.ok(!listed.some((s) => s.sessionId === theirs.session.id));
    });
  });
});
