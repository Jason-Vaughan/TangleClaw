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
const { DatabaseSync } = require('node:sqlite');
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
    // Driven by the cursor, not by a count: a revision that carries step 1 over
    // leaves fewer steps to acknowledge, and a fixed four would then run past
    // the end and ask the all-acknowledged envelope for a step it has not got.
    for (let guard = 0; guard <= store.LAUNCH_STEP_IDS.length * 2; guard++) {
      const seq = store.launchSequences.getByLaunchId(id.launchId);
      const steps = store.launchSequences.listSteps(seq.id, seq.revision);
      if (seq.cursor >= steps.length) return;
      const answer = ackCursorStep(id);
      assert.equal(answer.status, 200,
        `step ${seq.cursor} acknowledged: ${JSON.stringify(answer.body.error || '')}`);
    }
    assert.fail('the cursor never reached the end of the sequence');
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

    it('demands a reconciliation once a revision has replaced something the session read', () => {
      const { project, id } = launched('revise-then-ready');
      // The rule changes AFTER a step has been served and acknowledged: that is
      // the shape the requirement is about — content the session read has been
      // replaced under it. (A revision before anything was served replaces
      // nothing it saw; that case is its own test.)
      ackCursorStep(id);
      store.sessionRules.create({ projectId: project.id, content: 'A rule added after the first step was read.' });
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
      assert.equal(launchSequence.status(id).body.renderContext, 'recorded');
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
      // Visible where the plan says it is, rather than left for a reader to
      // infer from a thinner step 3.
      assert.equal(launchSequence.status({ launchId: sequence.launchId, projectId: project.id }).body.renderContext,
        'absent');
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

      // The other entry point to the same check. `next` after attesting is an
      // ordinary thing for an agent to do, and a revision here would leave
      // `ready: true` beside a cursor back at step 1 — a state the protocol
      // cannot otherwise produce, with the attestation bound to step rows that
      // no longer exist at the current revision.
      const served = launchSequence.next(id);
      assert.equal(served.status, 200);
      assert.equal(served.body.revision, 1, 'next does not revise an attested snapshot either');
      assert.equal(served.body.revised, undefined);
      const after = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(after.revision, 1);
      assert.equal(after.cursor, store.LAUNCH_STEP_IDS.length, 'and the cursor does not move back');
      assert.equal(after.readyAt, replay.body.readyAt);
      assert.equal(launchSequence.status(id).body.status.ready, true,
        'so ready and the cursor can never disagree');
      // The fourth surface that narrates the opening order (#1680), and the
      // one an agent reaches by pulling again AFTER attesting — the moment it
      // is most likely to read "there is nothing left" as "so begin". It has
      // to end where the other three end: at the proposal, stopped, with READY
      // named as a record rather than an approval. Asserted by ordering rather
      // than whole-string, so a rewrite that keeps the meaning passes and one
      // that drops the stop does not.
      const proposalIdx = served.body.content.indexOf('resume proposal');
      const stopIdx = served.body.content.indexOf('stop there for the operator');
      assert.ok(proposalIdx > -1 && stopIdx > proposalIdx,
        'the attested page sends the session to the proposal and stops it there');
      assert.match(served.body.content, /not that the work is approved/,
        'and says what READY did not do, since this page is read after it succeeded');
    });

    it('demands a reconciliation when the preflight verdict asks for one, without a revision', () => {
      // The CHANGELOG claims a `stale` or `workspace-unavailable` launch now
      // asks the session to reconcile in writing. The demand existed before
      // 21.8 and nothing could set it, so until the verdict was wired this
      // branch of `_reconciliationRequired` was unreachable — which is exactly
      // the shape of a guard that cannot fire. This pins the field the launch
      // record stores, not the engine predicate that produced it.
      const { id } = launched('preflight-demands-reconciliation');
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(sequence.revision, 1, 'no revision — the demand comes from the verdict alone');

      // Written directly, because what is under test is the demand the STORED
      // record produces — a launch that reached `stale` for real would need a
      // published handoff and a moved worktree, which is `launch-preflight`'s
      // own test, not this one's.
      store.getDb().prepare('UPDATE launch_sequences SET preflight = ? WHERE id = ?').run(
        JSON.stringify({
          verdict: 'stale',
          reason: 'HEAD is moved, the handoff recorded recorded-sha',
          requiresReconciliation: true
        }),
        sequence.id
      );
      const revised = store.launchSequences.getByLaunchId(id.launchId);
      const why = launchSequence._reconciliationRequired(revised);
      assert.ok(why, 'the verdict demands one');
      assert.match(why, /stale/);
      assert.match(why, /HEAD is moved/, 'and the reason travels with it');

      ackEverything(id);
      const current = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(launchSequence.ready({ ...id, artifact: artifactFor(current) }).body.code,
        'RECONCILIATION_REQUIRED');
      const reconciled = launchSequence.ready({
        ...id,
        artifact: artifactFor(current, {
          reconciliation: 'The worktree the previous handoff recorded has moved to a different commit; I checked the branch and nothing I had planned depends on the commit it recorded.'
        })
      });
      assert.equal(reconciled.status, 200, 'and a written reconciliation clears it');
    });

    it('stops reporting the reconciliation as owed once READY is attested, though its trigger stays (#2146)', () => {
      const { id } = launched('preflight-reconciled-status');
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      store.getDb().prepare('UPDATE launch_sequences SET preflight = ? WHERE id = ?').run(
        JSON.stringify({ verdict: 'stale', reason: 'HEAD is moved', requiresReconciliation: true }),
        sequence.id
      );
      ackEverything(id);
      const before = launchSequence.status(id).body;
      assert.equal(before.readiness.readyAt, null);
      assert.match(before.readiness.reconciliationRequired, /HEAD is moved/, 'unattested, the demand is reported');

      const current = store.launchSequences.getByLaunchId(id.launchId);
      const reconciled = launchSequence.ready({
        ...id,
        artifact: artifactFor(current, {
          reconciliation: 'The worktree the previous handoff recorded has moved; I checked the branch and nothing I had planned depends on the commit it recorded.'
        })
      });
      assert.equal(reconciled.status, 200);
      const attested = store.launchSequences.getByLaunchId(id.launchId);
      assert.ok(launchSequence._reconciliationRequired(attested), 'the trigger outlives READY');
      const after = launchSequence.status(id).body;
      assert.ok(after.readiness.readyAt);
      assert.equal(after.readiness.reconciliationRequired, null, 'READY answered it, so status owes nothing');
    });

    it('still demands a reconciliation when the revision preceded any serve, and says so accurately', () => {
      // Every revision demands one (§2.3's acceptance condition). What changes
      // with an unserved revision is the WORDING: telling an agent that part of
      // what it acknowledged was replaced, when it had been served nothing,
      // states a proxy as a fact.
      const { project, id } = launched('revise-before-any-serve');
      store.sessionRules.create({ projectId: project.id, content: 'A rule added before anything was served.' });
      launchSequence.next(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(sequence.revision, 2);
      const why = launchSequence._reconciliationRequired(sequence);
      assert.ok(why, 'a revision is a revision');
      assert.match(why, /before you were served any of it/);
      assert.doesNotMatch(why, /what you acknowledged/, 'it does not claim an acknowledgement that never happened');

      ackEverything(id);
      const current = store.launchSequences.getByLaunchId(id.launchId);
      assert.equal(launchSequence.ready({ ...id, artifact: artifactFor(current) }).body.code,
        'RECONCILIATION_REQUIRED');
      const reconciled = launchSequence.ready({
        ...id,
        artifact: artifactFor(current, {
          reconciliation: 'The rules changed before I was served any step, so I read the revised sequence from the start and nothing I had planned changes.'
        })
      });
      assert.equal(reconciled.status, 200);
    });

    it('attests with the verdict the served step-3 bytes actually state', () => {
      // The check exists to evidence that step 3 was READ, so the token it
      // demands has to be findable in the bytes the session was served. A test
      // that passes `sequence.preflight.verdict` from the row proves the
      // comparison, not the readability.
      const { id } = launched('ready-verdict-from-bytes');
      let stateContent = '';
      for (const stepId of store.LAUNCH_STEP_IDS) {
        let body = launchSequence.next(id).body;
        let content = body.content;
        while (!body.ack) {
          body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
          content += body.content;
        }
        if (stepId === 'state') stateContent = content;
        launchSequence.next({ ...id, ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest } });
      }
      const quoted = /Verdict: `([a-z-]+)`/.exec(stateContent);
      assert.ok(quoted, 'the state step names its verdict in a form an agent can quote');
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const answer = launchSequence.ready({
        ...id,
        artifact: artifactFor(sequence, { preflightVerdict: quoted[1] })
      });
      assert.equal(answer.status, 200, 'the verdict read off the page is the one the server accepts');
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
      assert.deepEqual(shown.pending.stages, [],
        'the recovery gate (#1587) was the last stage, so nothing is declared pending');
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

  describe('a post-READY reconciliation against live drift (#2191, Architect ruling A477-COSIGN-20261027T2307Z)', () => {
    /**
     * Add a real project rule after the launch already attested READY — the
     * one `_reconciliationRequired` trigger that can still be outstanding
     * after READY (every other trigger clears inside the READY transaction
     * itself, before this car). Deliberately a genuine governing-text change
     * through the normal write path, not a direct mutation of
     * `launch_sequences.source_manifest`: `_liveGoverningDrift` recomputes
     * the live manifest and diffs it against `sourceManifest.attestedManifest`,
     * so the drift this test exercises has to come from an actual change
     * `manifestFingerprints` can see, not from stamping a frozen field it no
     * longer reads.
     * @param {object} project - The launched project
     * @returns {void}
     */
    function addLiveRule(project) {
      store.sessionRules.create({
        projectId: project.id, content: 'a governing rule added after READY', createdBy: 'operator', approvedByOperator: true
      });
    }

    it('appends a reconciliation against live drift rather than refusing, and never rewrites the original attestation', () => {
      const { id, project } = launched('post-ready-append');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const artifact = artifactFor(sequence);
      const first = launchSequence.ready({ ...id, artifact });
      assert.equal(first.status, 200);
      const originalReadyAt = first.body.readyAt;
      const originalArtifact = store.launchSequences.getByLaunchId(id.launchId).readyArtifact;

      addLiveRule(project);
      const before = launchSequence.status(id).body;
      assert.match(before.readiness.reconciliationRequired, /the governing rules changed/,
        'status now reports the live drift, even though this launch is already attested');

      const text = 'A shared document was added after I attested; I read it and nothing I committed to depends on its content.';
      const appended = launchSequence.ready({ ...id, artifact: artifactFor(sequence, { reconciliation: text }) });
      assert.equal(appended.status, 200);
      assert.equal(appended.body.reconciled, true);
      assert.equal(appended.body.readyAt, originalReadyAt, 'the original attestation timestamp is untouched');

      const stored = store.launchSequences.getByLaunchId(id.launchId);
      assert.deepEqual(stored.readyArtifact, originalArtifact, 'ready_artifact is never rewritten by an appended reconciliation');
      assert.equal(stored.readyAt, originalReadyAt);

      const after = launchSequence.status(id).body;
      assert.equal(after.readiness.reconciliationRequired, null, 'recording it clears the line');

      const recorded = store.launchReconciliations.listForSequence(sequence.id);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].reconciliation, text);
    });

    it('is idempotent: appending the same drift twice records it once', () => {
      const { id, project } = launched('post-ready-append-idempotent');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      addLiveRule(project);
      const text = 'A reconciliation of at least forty characters about the drift stamped above.';
      const first = launchSequence.ready({ ...id, artifact: artifactFor(sequence, { reconciliation: text }) });
      assert.equal(first.status, 200);
      const second = launchSequence.ready({ ...id, artifact: artifactFor(sequence, { reconciliation: text }) });
      assert.equal(second.status, 200);
      assert.equal(store.launchReconciliations.listForSequence(sequence.id).length, 1,
        'the same (sequence, revision, drift digest) is not recorded twice');
    });

    it('falls through to the ordinary conflict check when there is no live drift to reconcile', () => {
      const { id } = launched('post-ready-no-drift');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      // Reconciliation text supplied, but no drift stamped: there is nothing
      // outstanding to append against, so this is read as re-attesting with a
      // different artifact — a genuine conflict, not a reconciliation.
      const replay = launchSequence.ready({
        ...id,
        artifact: artifactFor(sequence, { reconciliation: 'A reconciliation nobody asked for, forty-plus characters long.' })
      });
      assert.equal(replay.status, 409);
      assert.equal(replay.body.code, 'READY_CONFLICT');
      assert.equal(store.launchReconciliations.listForSequence(sequence.id).length, 0);
    });

    it('still refuses a conflicting artifact with no reconciliation once drift is live', () => {
      const { id, project } = launched('post-ready-conflict-baseline');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const artifact = artifactFor(sequence);
      assert.equal(launchSequence.ready({ ...id, artifact }).status, 200);
      addLiveRule(project);
      const conflict = launchSequence.ready({ ...id, artifact: { ...artifact, proposedFirstAction: 'something else entirely' } });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'READY_CONFLICT');
    });
  });

  describe('the durable readiness receipt (#1877, same ruling)', () => {
    it('emits exactly one receipt on a fresh READY, resolving the recipient from durable control_assignments/coordinator_roles data', () => {
      const pm = makeProject('pm-project-for-receipt');
      store.coordinatorRoles.grant({
        roleId: 'role-pm-receipt-1', projectId: pm.id, role: 'project-manager', note: null, now: new Date(0).toISOString()
      });
      const { id, project } = launched('receipt-fresh-ready');
      store.control.insertAssignment({
        assignment_id: 'asg-receipt-1', project_id: project.id,
        authority_json: JSON.stringify({ lifecycle: [`project:${pm.id}`] }),
        state: 'active', state_generation: 1, created_by_kind: 'operator'
      });
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const answer = launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      assert.equal(answer.status, 200);

      const receipts = store.launchReadinessReceipts.listForSequence(sequence.id);
      assert.equal(receipts.length, 1, 'exactly one receipt for this READY');
      assert.equal(receipts[0].assignmentId, 'asg-receipt-1');
      assert.equal(receipts[0].recipientProjectId, pm.id,
        'the recipient is resolved from the durable assignment/coordinator-role data, not a nickname');
      assert.equal(receipts[0].revision, sequence.revision);
      assert.equal(receipts[0].readyDigest, store.launchSequences.getByLaunchId(id.launchId).readyDigest);

      const status = launchSequence.status(id).body;
      assert.ok(status.readinessReceipt, 'the PM-visible surface this car exposes it on');
      assert.equal(status.readinessReceipt.recipientProjectId, pm.id);
    });

    it('does not emit a second receipt row when READY is answered again (replay or race)', () => {
      const { id } = launched('receipt-no-duplicate');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const artifact = artifactFor(sequence);
      assert.equal(launchSequence.ready({ ...id, artifact }).status, 200);
      assert.equal(launchSequence.ready({ ...id, artifact: { ...artifact } }).body.duplicate, true);
      assert.equal(store.launchReadinessReceipts.listForSequence(sequence.id).length, 1);
    });

    it('records a receipt with no recipient, rather than failing READY, when no coordinator role resolves', () => {
      const { id } = launched('receipt-no-recipient');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const answer = launchSequence.ready({ ...id, artifact: artifactFor(sequence) });
      assert.equal(answer.status, 200, 'READY succeeds whether or not a recipient can be resolved');
      const receipts = store.launchReadinessReceipts.listForSequence(sequence.id);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].recipientProjectId, null);
      assert.equal(receipts[0].projectionState, 'skipped', 'nothing to project with no recipient');
    });

    it('the store layer is idempotent on (sequenceId, revision, assignmentId), independent of the ready() call site', () => {
      const { id } = launched('receipt-store-idempotent');
      ackEverything(id);
      const sequence = store.launchSequences.getByLaunchId(id.launchId);
      const fields = {
        receiptId: 'receipt-idempotent-1', sequenceId: sequence.id, launchId: sequence.launchId,
        sessionId: sequence.sessionId, projectId: sequence.projectId, assignmentId: null,
        revision: sequence.revision, readyDigest: 'digest-a', recipientProjectId: null,
        recipientWorkspaceId: null, projectionState: 'skipped'
      };
      const first = store.launchReadinessReceipts.emit(fields);
      assert.equal(first.created, true);
      const second = store.launchReadinessReceipts.emit({ ...fields, receiptId: 'receipt-idempotent-2', readyDigest: 'digest-b' });
      assert.equal(second.created, false, 'the same (sequence, revision, assignment) key returns the existing row');
      assert.equal(second.row.receiptId, 'receipt-idempotent-1');
      assert.equal(second.row.readyDigest, 'digest-a', 'the existing row, not a second write');
    });
  });
});

/**
 * v70→71: `launch_reconciliations` (post-READY additive reconciliation
 * against live drift, #2191) and `launch_readiness_receipts` (idempotent
 * durable READY receipt, #1877), plus `last_unready_verdict` /
 * `last_unready_verdict_at` provisioned on `launch_sequences` for #1596
 * (Architect ruling A477-COSIGN-20261027T2307Z).
 *
 * The property under test is the same one `launch-recovery-migration.test.js`
 * checks for the v42→43 columns: a store upgraded today and a store created
 * today must be indistinguishable afterwards, and the postcondition has to
 * actually look at the DDL — `PRAGMA table_info` cannot see a CHECK, a
 * UNIQUE constraint or a trigger, so a half-applied upgrade that merely adds
 * the column/table names would otherwise pass silently.
 */

const migrationTmpDirs = [];

/** `launch_sequences` as v70 shipped it — before the two unready-verdict columns. */
const V70_LAUNCH_SEQUENCES_DDL = `
  CREATE TABLE launch_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT, launch_id TEXT NOT NULL UNIQUE, session_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL, engine_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    cursor INTEGER NOT NULL DEFAULT 0, page_budget INTEGER NOT NULL,
    applicability TEXT NOT NULL CHECK (applicability IN ('applicable','not-applicable')),
    not_applicable_reason TEXT, preflight TEXT NOT NULL, source_manifest TEXT NOT NULL,
    ready_at TEXT, ready_artifact TEXT, ready_digest TEXT, unready_at TEXT,
    nudge_count INTEGER NOT NULL DEFAULT 0, last_nudged_at TEXT,
    recovery TEXT NOT NULL DEFAULT 'none' CHECK (recovery IN ('none','required','cleared')),
    recovery_mode TEXT NOT NULL DEFAULT 'operator' CHECK (recovery_mode IN ('operator','advisory')),
    recovery_revision INTEGER NOT NULL DEFAULT 1,
    recovery_cleared_at TEXT, recovery_cleared_by TEXT,
    recovery_clearance TEXT CHECK (recovery_clearance IN ('operator-verified','open-install-unverified','agent-reconciled')),
    startup_delivery TEXT NOT NULL DEFAULT 'legacy' CHECK (startup_delivery IN ('legacy','native')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (applicability = 'applicable' OR not_applicable_reason IS NOT NULL)
  );
  CREATE UNIQUE INDEX idx_launch_sequences_session ON launch_sequences(session_id);`;

/** One in-flight launch, recorded before this gate existed. */
const MIGRATION_IN_FLIGHT_ROW = `
  INSERT INTO launch_sequences (launch_id, session_id, project_id, engine_id, page_budget,
    applicability, preflight, source_manifest)
  VALUES ('pre-v71-launch', 7, 1, 'claude', 8000, 'applicable', '{"verdict":"ok"}', '{}');`;

/**
 * Seed a database at v70 with the pre-v71 `launch_sequences` table.
 * @param {string} [extraSql] - Further DDL/rows for the case under test
 * @returns {string} The store's base directory
 */
function seedV70(extraSql = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-mig-'));
  migrationTmpDirs.push(dir);
  const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (70);
    ${V70_LAUNCH_SEQUENCES_DDL}
    ${extraSql}
  `);
  seed.close();
  return dir;
}

/**
 * Open a seeded directory as the live store.
 * @param {string} dir - Base directory
 * @returns {void}
 */
function openMigrationStore(dir) {
  store._setBasePath(dir);
  store.init();
}

/**
 * A table or index's DDL as SQLite stores it — the only place a CHECK,
 * UNIQUE or trigger body is visible.
 * @param {string} name - sqlite_master name
 * @returns {string}
 */
function ddl(name) {
  const row = store.getDb().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
  return (row && row.sql) || '';
}

/**
 * The column names `launch_sequences` carries right now.
 * @returns {Set<string>}
 */
function launchSequenceColumns() {
  return new Set(store.getDb().prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
}

describe('v70→71 launch_reconciliations, launch_readiness_receipts, unready-verdict columns', () => {
  after(() => {
    store.close();
    for (const dir of migrationTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds both unready-verdict columns and both new tables to a store upgrading from v70', () => {
    openMigrationStore(seedV70(MIGRATION_IN_FLIGHT_ROW));
    const cols = launchSequenceColumns();
    assert.ok(cols.has('last_unready_verdict'), 'v70→71 did not add last_unready_verdict');
    assert.ok(cols.has('last_unready_verdict_at'), 'v70→71 did not add last_unready_verdict_at');
    assert.ok(ddl('launch_reconciliations'), 'v70→71 did not create launch_reconciliations');
    assert.ok(ddl('launch_readiness_receipts'), 'v70→71 did not create launch_readiness_receipts');
  });

  it('leaves a pre-existing launch with no unready verdict recorded', () => {
    openMigrationStore(seedV70(MIGRATION_IN_FLIGHT_ROW));
    const row = store.getDb().prepare("SELECT * FROM launch_sequences WHERE launch_id = 'pre-v71-launch'").get();
    assert.equal(row.last_unready_verdict, null);
    assert.equal(row.last_unready_verdict_at, null);
  });

  it('gives an upgraded store the same shape as a fresh one', () => {
    openMigrationStore(seedV70(MIGRATION_IN_FLIGHT_ROW));
    const upgraded = {
      cols: [...launchSequenceColumns()].sort(),
      reconciliations: ddl('launch_reconciliations').replace(/\s+/g, ' '),
      receipts: ddl('launch_readiness_receipts').replace(/\s+/g, ' ')
    };
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-fresh-'));
    migrationTmpDirs.push(fresh);
    openMigrationStore(fresh);
    assert.deepEqual({
      cols: [...launchSequenceColumns()].sort(),
      reconciliations: ddl('launch_reconciliations').replace(/\s+/g, ' '),
      receipts: ddl('launch_readiness_receipts').replace(/\s+/g, ' ')
    }, upgraded);
  });

  it('keeps the CHECK that admits only a recognized unready verdict', () => {
    openMigrationStore(seedV70(MIGRATION_IN_FLIGHT_ROW));
    assert.match(ddl('launch_sequences'), /last_unready_verdict[^,]*CHECK/);
    assert.throws(
      () => store.getDb().exec("UPDATE launch_sequences SET last_unready_verdict = 'made-up-verdict' WHERE launch_id = 'pre-v71-launch'"),
      /CHECK constraint failed/,
      'an unready verdict that means nothing is refused by the database'
    );
    store.getDb().exec("UPDATE launch_sequences SET last_unready_verdict = 'nudged' WHERE launch_id = 'pre-v71-launch'");
  });

  it('keeps launch_reconciliations append-only and idempotent on (sequence_id, revision, drift_digest)', () => {
    openMigrationStore(seedV70(MIGRATION_IN_FLIGHT_ROW));
    const db = store.getDb();
    db.exec(`
      INSERT INTO launch_reconciliations (sequence_id, session_id, project_id, revision, drift_digest, reconciliation)
      VALUES (1, 7, 1, 1, 'abc123', 'A reconciliation of at least forty characters, honestly.');
    `);
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_reconciliations (sequence_id, session_id, project_id, revision, drift_digest, reconciliation)
        VALUES (1, 7, 1, 1, 'abc123', 'A second, different reconciliation text of forty-plus chars.');
      `),
      /UNIQUE constraint failed/,
      'a second row for the same (sequence, revision, drift) is refused by the database'
    );
    assert.throws(
      () => db.exec("UPDATE launch_reconciliations SET reconciliation = 'edited' WHERE sequence_id = 1"),
      /append-only/
    );
    assert.throws(
      () => db.exec('DELETE FROM launch_reconciliations WHERE sequence_id = 1'),
      /append-only/
    );
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_reconciliations (sequence_id, session_id, project_id, revision, drift_digest, reconciliation)
        VALUES (1, 7, 1, 1, 'xyz789', 'too short')
      `),
      /CHECK constraint failed/,
      'a reconciliation under 40 characters is refused by the database, not merely by a caller'
    );
  });

  it('keeps launch_readiness_receipts idempotent on (sequence_id, revision, assignment_id)', () => {
    openMigrationStore(seedV70(MIGRATION_IN_FLIGHT_ROW));
    const db = store.getDb();
    db.exec(`
      INSERT INTO launch_readiness_receipts
        (receipt_id, sequence_id, launch_id, session_id, project_id, revision, ready_digest)
      VALUES ('receipt-one', 1, 'pre-v71-launch', 7, 1, 1, 'digest-one');
    `);
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_readiness_receipts
          (receipt_id, sequence_id, launch_id, session_id, project_id, revision, ready_digest)
        VALUES ('receipt-two', 1, 'pre-v71-launch', 7, 1, 1, 'digest-two');
      `),
      /UNIQUE constraint failed/,
      'a second receipt for the same (sequence, revision, no assignment) is refused by the database'
    );
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_readiness_receipts
          (receipt_id, sequence_id, launch_id, session_id, project_id, revision, ready_digest, projection_state)
        VALUES ('receipt-bad', 2, 'pre-v71-launch', 7, 1, 1, 'digest-three', 'bogus-state');
      `),
      /CHECK constraint failed/,
      'an unrecognised projection_state is refused by the database'
    );
  });

  it('stamps the current version and nothing between', () => {
    openMigrationStore(seedV70(MIGRATION_IN_FLIGHT_ROW));
    const stamped = store.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all()
      .map((r) => r.version);
    assert.deepEqual(stamped, [70, store.CURRENT_SCHEMA_VERSION]);
  });

  it('is a no-op on a store that already took it', () => {
    const dir = seedV70(MIGRATION_IN_FLIGHT_ROW);
    openMigrationStore(dir);
    const before = { seq: ddl('launch_sequences'), rec: ddl('launch_reconciliations'), rcp: ddl('launch_readiness_receipts') };
    store.close();
    openMigrationStore(dir);
    assert.deepEqual(
      { seq: ddl('launch_sequences'), rec: ddl('launch_reconciliations'), rcp: ddl('launch_readiness_receipts') },
      before
    );
    assert.equal(
      store.getDb().prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = ?')
        .get(store.CURRENT_SCHEMA_VERSION).n, 1,
      'a re-run does not stamp the current version twice'
    );
  });

  it('refuses to advance over an unready-verdict column that carries no CHECK', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-refuse-'));
    migrationTmpDirs.push(dir);
    const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    seed.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO schema_version (version) VALUES (70);
      ${V70_LAUNCH_SEQUENCES_DDL}
      ALTER TABLE launch_sequences ADD COLUMN last_unready_verdict TEXT;
    `);
    seed.close();
    assert.throws(() => openMigrationStore(dir), /last_unready_verdict without its CHECK.*Refusing to advance schema_version/);
    const after = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    const stamped = after.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
    after.close();
    assert.ok(!stamped.includes(71), 'a failed migration advertises no v71');
  });
});
