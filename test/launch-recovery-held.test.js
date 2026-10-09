'use strict';

/**
 * `GET /api/launch/recovery-held` (#2049): the signed-in operator's read of
 * every launch waiting on their clear.
 *
 * Two properties are held here. Who may read it: the login gate `armed` and an
 * operator's session, with every other gate state answered by its own refusal
 * and no launch in any refusal's body. And what it says: only launches an
 * operator can still act on, with the evidence about queued or in-flight work
 * reported as separately sourced parts in which "the source holds nothing",
 * "the source could not be read" and "there is no source" stay three different
 * answers all the way to the response.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const gateFallback = require('../lib/gate-fallback');
const strandedWraps = require('../lib/stranded-wraps');
const launchRecoveryHeld = require('../lib/launch-recovery-held');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');

const URL = '/api/launch/recovery-held';

describe('the fleet recovery read (#2049)', () => {
  let env;
  const client = fixture.makeClient(handleRequest);
  const realInternal = { ...launchRecoveryHeld._internal };

  before(() => { env = fixture.openTempStore('tc-recovery-held-'); });
  after(() => { env.restore(); });
  beforeEach(() => { fixture.resetLogin(); });
  afterEach(() => { Object.assign(launchRecoveryHeld._internal, realInternal); });

  /**
   * Arm the login, sign in and read the fleet list.
   * @returns {Promise<object>} The parsed 200 body
   */
  async function readAsOperator() {
    client.arm();
    const { cookie } = await client.signIn();
    const res = await client.send('GET', URL, { headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return client.json(res);
  }

  /**
   * The entry for one launch in a fleet answer.
   * @param {object} answer - Parsed body
   * @param {object} held - A launch from the fixture
   * @returns {object|undefined}
   */
  const entryFor = (answer, held) => answer.launches.find((l) => l.sequenceId === held.sequence.id);

  /**
   * One part of a launch's `uncertainWork`.
   * @param {object} entry - A launch entry
   * @param {string} kind - The part's kind
   * @returns {object}
   */
  const part = (entry, kind) => entry.uncertainWork.find((p) => p.kind === kind);

  /**
   * End a held launch's session and launch the project again, so the new
   * launch has a prior session. The handoff file is still unreadable, so the
   * new launch is held too.
   * @param {object} held - A launch from the fixture
   * @param {'killed'|'crashed'} how - How the first session ends
   * @returns {{project: object, sequence: object, binding: object, priorSessionId: number}}
   */
  function relaunchAfter(held, how) {
    if (how === 'killed') store.sessions.kill(held.sequence.sessionId, 'test');
    else store.sessions.markCrashed(held.sequence.sessionId, 'test');
    const session = fixture.launchStubbed(env.sessions, held.project.name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    assert.equal(sequence.recovery, 'required', 'the relaunch must be held too');
    assert.equal(sequence.recoveryMode, 'operator');
    return {
      project: held.project,
      sequence,
      binding: { sessionId: session.id, sequenceId: sequence.id, recoveryRevision: sequence.recoveryRevision },
      priorSessionId: held.sequence.sessionId
    };
  }

  describe('who may read it', () => {
    /**
     * Assert a refusal carries its code and no launch.
     * @param {object} res - The response
     * @param {number} status - Expected status
     * @param {string} code - Expected error code
     * @param {object} held - A launch that must not appear in the body
     * @returns {void}
     */
    function assertRefused(res, status, code, held) {
      assert.equal(res.statusCode, status, res.body);
      const body = client.json(res);
      assert.equal(body.code, code);
      assert.equal(body.launches, undefined, 'a refusal lists nothing');
      assert.ok(!res.body.includes(held.project.name), 'a refusal names no held project');
    }

    it('serves a signed-in operator on an armed install, with no CSRF token', async () => {
      const held = fixture.launchInRecovery(env);
      const answer = await readAsOperator();
      assert.equal(answer.gateState, 'armed');
      assert.ok(entryFor(answer, held), 'the held launch is listed');
    });

    it('refuses an install with no login, with or without the dashboard\'s page token', async () => {
      const held = fixture.launchInRecovery(env);
      assertRefused(await client.send('GET', URL), 403, 'LOGIN_GATE_REQUIRED', held);
      const token = await client.pageToken();
      assertRefused(
        await client.send('GET', URL, { headers: { 'x-tc-open-token': token } }), 403, 'LOGIN_GATE_REQUIRED', held);
    });

    it('answers "this needs a login" as the reconciliation read does, so a client handles it once', async () => {
      const held = fixture.launchInRecovery(env);
      const token = await client.pageToken();
      const sibling = await client.send(
        'POST', `/api/sessions/${encodeURIComponent(held.project.name)}/launch/reconciliation`,
        { body: { sessionId: held.binding.sessionId, sequenceId: held.binding.sequenceId },
          headers: { 'x-tc-open-token': token } });
      const mine = await client.send('GET', URL);
      assert.equal(mine.statusCode, sibling.statusCode);
      assert.equal(client.json(mine).code, client.json(sibling).code);
    });

    it('refuses an armed install\'s caller who is not signed in, browser or local process', async () => {
      const held = fixture.launchInRecovery(env);
      client.arm();
      assertRefused(await client.send('GET', URL), 401, 'UNAUTHENTICATED', held);
      // A local process is waved past the perimeter on an armed install, so
      // the route's own check is the one that answers it.
      assertRefused(await client.send('GET', URL, { browser: false }), 401, 'UNAUTHENTICATED', held);
    });

    it('refuses a cookie that names no session', async () => {
      const held = fixture.launchInRecovery(env);
      client.arm();
      const res = await client.send('GET', URL, { headers: { cookie: 'tc_session=not-a-session' } });
      assertRefused(res, 401, 'UNAUTHENTICATED', held);
    });

    it('refuses in fallback, even for a caller who signed in before it began', async () => {
      const held = fixture.launchInRecovery(env);
      client.arm();
      const { cookie } = await client.signIn();
      gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      assertRefused(await client.send('GET', URL, { headers: { cookie } }), 409, 'GATE_FALLBACK', held);
    });

    it('refuses a gate state that is neither armed, open nor fallback by its own branch', async () => {
      // `account-required`: the login is on and no account exists. A local
      // process is the caller that reaches the route in this state.
      const held = fixture.launchInRecovery(env);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      assertRefused(await client.send('GET', URL, { browser: false }), 409, 'GATE_STATE_UNSUPPORTED', held);
    });
  });

  describe('which launches it lists', () => {
    it('lists a held launch with the exact binding a clear needs, and its preflight evidence', async () => {
      const held = fixture.launchInRecovery(env);
      const entry = entryFor(await readAsOperator(), held);
      assert.equal(entry.projectId, held.project.id);
      assert.equal(entry.projectName, held.project.name);
      assert.equal(entry.sessionId, held.binding.sessionId);
      assert.equal(entry.sequenceId, held.binding.sequenceId);
      assert.equal(entry.recoveryRevision, held.binding.recoveryRevision);
      assert.equal(entry.revision, held.sequence.revision);
      assert.equal(entry.recovery, 'required');
      assert.equal(entry.recoveryMode, 'operator');
      assert.deepEqual(entry.sessionStatus, { value: 'active', basis: 'stored-session-status' });
      assert.ok(held.sequence.preflight.verdict, 'the fixture has a verdict to show');
      assert.deepEqual(entry.preflight, held.sequence.preflight, 'the preflight record as the launch stored it');
    });

    describe('the preflight evidence is the stored record, unchanged', () => {
      /**
       * Overwrite a launch's stored preflight record.
       * @param {object} held - A launch from the fixture
       * @param {string} json - The column's new text
       * @returns {void}
       */
      function storePreflight(held, json) {
        store.getDb().prepare('UPDATE launch_sequences SET preflight = ? WHERE id = ?').run(json, held.sequence.id);
      }

      it('carries the predicates the gate obeyed, which the verdict alone does not give', async () => {
        const held = fixture.launchInRecovery(env);
        const stored = store.launchSequences.getBySession(held.sequence.sessionId).preflight;
        assert.equal(typeof stored.requiresRecovery, 'boolean', 'the launch path stores the predicate');
        assert.equal(typeof stored.requiresReconciliation, 'boolean');
        assert.ok('worktreeDirty' in stored);
        const entry = entryFor(await readAsOperator(), held);
        assert.equal(entry.preflight.requiresRecovery, stored.requiresRecovery);
        assert.equal(entry.preflight.requiresReconciliation, stored.requiresReconciliation);
        assert.ok('worktreeDirty' in entry.preflight, 'the field is sent even when it is null');
        assert.equal(entry.preflight.worktreeDirty, stored.worktreeDirty);
      });

      for (const worktreeDirty of [null, true, false]) {
        it(`sends worktreeDirty ${worktreeDirty} as ${worktreeDirty}: never measured, dirty and clean stay three answers`, async () => {
          const held = fixture.launchInRecovery(env);
          const record = {
            verdict: 'workspace-unavailable', reason: 'the recorded worktree is gone',
            requiresRecovery: worktreeDirty !== false, requiresReconciliation: true,
            worktreeDirty, evaluationFailed: false, evaluationMissing: false
          };
          storePreflight(held, JSON.stringify(record));
          const entry = entryFor(await readAsOperator(), held);
          assert.deepEqual(entry.preflight, record);
          assert.strictEqual(entry.preflight.worktreeDirty, worktreeDirty);
        });
      }

      it('sends a field this read has never heard of, because nothing is picked out', async () => {
        const held = fixture.launchInRecovery(env);
        const record = { ...held.sequence.preflight, addedLater: { nested: null } };
        storePreflight(held, JSON.stringify(record));
        assert.deepEqual(entryFor(await readAsOperator(), held).preflight, record);
      });

      it('sends null for a record the store cannot parse, and invents no verdict or flags', async () => {
        // The column is NOT NULL, so a launch always stored something. What the
        // store hands back for text it cannot parse is null, and that is what
        // is sent: not a null verdict beside two false flags.
        const held = fixture.launchInRecovery(env);
        storePreflight(held, '{not json');
        assert.strictEqual(store.launchSequences.getBySession(held.sequence.sessionId).preflight, null);
        const entry = entryFor(await readAsOperator(), held);
        assert.strictEqual(entry.preflight, null);
      });
    });

    it('leaves out an advisory launch, a cleared launch, an ended session and an archived project', async () => {
      const kept = fixture.launchInRecovery(env);
      const advisory = fixture.launchInRecovery(env, 'advisory');
      const cleared = fixture.launchInRecovery(env);
      store.launchSequences.clearRecoveryAsOperator(cleared.sequence.id, {
        sessionId: cleared.binding.sessionId, recoveryRevision: cleared.binding.recoveryRevision,
        clearance: 'operator-verified', clearedBy: 'rosie'
      });
      const ended = fixture.launchInRecovery(env);
      store.sessions.kill(ended.sequence.sessionId, 'test');
      const archived = fixture.launchInRecovery(env);
      store.projects.archive(archived.project.id);

      const answer = await readAsOperator();
      assert.ok(entryFor(answer, kept));
      for (const [name, gone] of Object.entries({ advisory, cleared, ended, archived })) {
        assert.equal(entryFor(answer, gone), undefined, `${name} must not be listed`);
      }
    });

    it('changes nothing it reads', async () => {
      const held = fixture.launchInRecovery(env);
      const before = store.launchSequences.getBySession(held.sequence.sessionId);
      await readAsOperator();
      assert.deepEqual(store.launchSequences.getBySession(held.sequence.sessionId), before);
    });
  });

  describe('the prior session', () => {
    for (const how of ['killed', 'crashed']) {
      it(`reports a ${how} prior session by its stored status`, async () => {
        const relaunched = relaunchAfter(fixture.launchInRecovery(env), how);
        const entry = entryFor(await readAsOperator(), relaunched);
        assert.equal(entry.priorSession.state, 'recorded');
        assert.equal(entry.priorSession.source, 'sessions');
        assert.equal(entry.priorSession.sessionId, relaunched.priorSessionId);
        assert.equal(entry.priorSession.status, how);
        assert.ok(entry.priorSession.endedAt);
      });
    }

    it('says none is recorded for a project\'s first session, and does not invent a status', async () => {
      const held = fixture.launchInRecovery(env);
      const entry = entryFor(await readAsOperator(), held);
      assert.deepEqual(entry.priorSession, { source: 'sessions', state: 'none-recorded' });
    });

    it('says unavailable when the session read fails, and the staged-handoff part follows it', async () => {
      const held = fixture.launchInRecovery(env);
      launchRecoveryHeld._internal.previousSession = () => { throw new Error('SQLITE_IOERR at /secret/path'); };
      const entry = entryFor(await readAsOperator(), held);
      assert.deepEqual(entry.priorSession,
        { source: 'sessions', state: 'unavailable', reasonCode: 'SOURCE_READ_FAILED' });
      assert.equal(part(entry, 'stagedHandoff').state, 'unavailable',
        'a part looked up by the prior session must not read as empty when that session is unknown');
    });
  });

  describe('uncertain queued work', () => {
    it('reports five separately sourced parts in a fixed order, each with a state and a source', async () => {
      const held = fixture.launchInRecovery(env);
      const entry = entryFor(await readAsOperator(), held);
      assert.deepEqual(entry.uncertainWork.map((p) => p.kind),
        ['strandedWraps', 'stagedHandoff', 'startupPromptFire', 'launchNudge', 'paneInput']);
      for (const p of entry.uncertainWork) {
        assert.ok(['recorded', 'none-recorded', 'unavailable'].includes(p.state), `${p.kind}: ${p.state}`);
        assert.equal(typeof p.source, 'string');
      }
    });

    it('never calls an empty stranded-wrap read complete', async () => {
      const held = fixture.launchInRecovery(env);
      const stranded = part(entryFor(await readAsOperator(), held), 'strandedWraps');
      assert.equal(stranded.state, 'none-recorded');
      assert.equal(stranded.completeness, 'incomplete-history');
      assert.match(stranded.note, /not proof/);
      assert.deepEqual(stranded.items, []);
    });

    it('lists a recorded stranded wrap by branch, head and time, without its remote', async () => {
      const held = fixture.launchInRecovery(env);
      const headSha = 'a'.repeat(40);
      strandedWraps.record({
        projectId: held.project.id, sessionId: held.sequence.sessionId,
        remote: 'https://token@example.test/repo.git', branch: 'wrap/held', headSha
      });
      const stranded = part(entryFor(await readAsOperator(), held), 'strandedWraps');
      assert.equal(stranded.state, 'recorded');
      assert.equal(stranded.items.length, 1);
      assert.deepEqual(Object.keys(stranded.items[0]).sort(),
        ['acknowledged', 'branch', 'grandfathered', 'headSha', 'recordedAt', 'sessionId']);
      assert.equal(stranded.items[0].branch, 'wrap/held');
      assert.equal(stranded.items[0].headSha, headSha);
    });

    it('reports a source that throws as unavailable, with a code and none of the error', async () => {
      const held = fixture.launchInRecovery(env);
      const other = fixture.launchInRecovery(env);
      launchRecoveryHeld._internal.listStrandedWraps = (project) => {
        if (project.id === held.project.id) throw new Error('SQLITE_CORRUPT in /Users/someone/.tangleclaw/db');
        return realInternal.listStrandedWraps(project);
      };
      client.arm();
      const { cookie } = await client.signIn();
      const res = await client.send('GET', URL, { headers: { cookie } });
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(!res.body.includes('SQLITE_CORRUPT'), 'the error text is not sent');
      assert.ok(!res.body.includes('/Users/someone'), 'no path is sent');
      const answer = client.json(res);
      assert.deepEqual(part(entryFor(answer, held), 'strandedWraps'), {
        kind: 'strandedWraps', source: 'activity_log (wrap.stranded), project-wide',
        state: 'unavailable', reasonCode: 'SOURCE_READ_FAILED'
      });
      assert.equal(part(entryFor(answer, other), 'strandedWraps').state, 'none-recorded',
        'one project\'s unreadable source does not change another\'s answer');
      assert.equal(part(entryFor(answer, held), 'launchNudge').state, 'none-recorded',
        'the same launch\'s other parts are still read');
    });

    it('lists a handoff the prior session staged and never finished', async () => {
      const first = fixture.launchInRecovery(env);
      store.handoffs.stage({
        publicationId: 'pub-held-1', projectId: first.project.id, sessionId: first.sequence.sessionId,
        wrapRunId: 'run-1', kind: 'final', fileDigest: 'd'.repeat(64), stagedAt: '2026-10-07T00:00:00.000Z'
      });
      const relaunched = relaunchAfter(first, 'killed');
      const staged = part(entryFor(await readAsOperator(), relaunched), 'stagedHandoff');
      assert.equal(staged.state, 'recorded');
      assert.deepEqual(staged.items, [{
        publicationId: 'pub-held-1', kind: 'final', wrapRunId: 'run-1',
        stagedAt: '2026-10-07T00:00:00.000Z', eligibleAt: null
      }]);
      assert.match(staged.note, /staged handoffs\s+only/);
    });

    it('says no staged handoff is recorded when the prior session staged none, and when there is no prior session', async () => {
      const relaunched = relaunchAfter(fixture.launchInRecovery(env), 'crashed');
      const first = fixture.launchInRecovery(env);
      const answer = await readAsOperator();
      assert.equal(part(entryFor(answer, relaunched), 'stagedHandoff').state, 'none-recorded');
      assert.equal(part(entryFor(answer, first), 'stagedHandoff').state, 'none-recorded');
    });

    it('reports an in-flight startup prompt dispatch by id, outcome and times, with no payload', async () => {
      const held = fixture.launchInRecovery(env);
      launchRecoveryHeld._internal.activeStartupFire = (sequenceId) => (sequenceId === held.sequence.id ? {
        id: 7, outcome: 'indeterminate', payload: { text: 'the startup prompt' }, reason: 'free text',
        createdAt: '2026-10-07 00:00:00', dispatchedAt: '2026-10-07 00:00:01', acceptedAt: null,
        updatedAt: '2026-10-07 00:00:02'
      } : null);
      const fire = part(entryFor(await readAsOperator(), held), 'startupPromptFire');
      assert.equal(fire.state, 'recorded');
      assert.equal(fire.completeness, 'complete-while-session-active');
      assert.deepEqual(fire.items, [{
        fireId: 7, outcome: 'indeterminate', createdAt: '2026-10-07 00:00:00',
        dispatchedAt: '2026-10-07 00:00:01', acceptedAt: null, updatedAt: '2026-10-07 00:00:02'
      }]);
    });

    it('reads the startup fire from the store, and reports none for a launch that has none', async () => {
      const held = fixture.launchInRecovery(env);
      const fire = part(entryFor(await readAsOperator(), held), 'startupPromptFire');
      assert.equal(fire.state, 'none-recorded');
      assert.deepEqual(fire.items, []);
    });

    it('reports a nudge as a send attempt, not as received', async () => {
      const held = fixture.launchInRecovery(env);
      store.launchSequences.recordNudge(held.sequence.id);
      const nudge = part(entryFor(await readAsOperator(), held), 'launchNudge');
      assert.equal(nudge.state, 'recorded');
      assert.equal(nudge.nudgeCount, 1);
      assert.ok(nudge.lastNudgedAt);
      assert.match(nudge.note, /not proof it was\s+received/);
    });

    it('always says pane input is unavailable, because nothing records it', async () => {
      const held = fixture.launchInRecovery(env);
      const pane = part(entryFor(await readAsOperator(), held), 'paneInput');
      assert.equal(pane.state, 'unavailable');
      assert.equal(pane.reasonCode, 'NO_DURABLE_SOURCE');
    });
  });

  it('claims nothing about readiness, resumed work or what a clear would do', async () => {
    const held = fixture.launchInRecovery(env);
    const entry = entryFor(await readAsOperator(), held);
    for (const key of ['readyAt', 'cursor', 'ready', 'resumed', 'recoveryClearance', 'recoveryClearedAt']) {
      assert.equal(key in entry, false, `${key} is not part of this read`);
    }
  });
});
