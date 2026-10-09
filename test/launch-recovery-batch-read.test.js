'use strict';

/**
 * Reading a batch recovery clear back by its id (#2049).
 *
 * `GET /api/launch/recovery-clear-batch/:batchId` answers with the batch as
 * recorded and, beside each item, what its launch says at the moment of the
 * read. This file holds that contract: who may read a batch, that the record
 * is the one the batch wrote, that an observation is a stored fact read now
 * and never a claim about work, and that "could not be read" and "no such
 * launch" never arrive as "not blocked".
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const batch = require('../lib/launch-recovery-batch');
const gateFallback = require('../lib/gate-fallback');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');

const CLEAR_URL = '/api/launch/recovery-clear-batch';

/**
 * The read's path for one batch.
 * @param {string} batchId - Batch id
 * @returns {string}
 */
const readUrl = (batchId) => `${CLEAR_URL}/${encodeURIComponent(batchId)}`;

/**
 * The item a request sends for a fixture launch.
 * @param {{project: object, binding: object}} held - A launch from the fixture
 * @param {object} [overrides] - Fields to replace
 * @returns {object}
 */
const itemFor = (held, overrides = {}) => ({ projectId: held.project.id, ...held.binding, ...overrides });

/**
 * The row counts of every table a batch writes to, and of the launches.
 * @returns {object}
 */
const recordCounts = () => Object.fromEntries([
  'launch_recovery_clear_batches', 'launch_recovery_clear_batch_items', 'launch_recovery_clearances'
].map((table) => [table, store.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));

describe('reading a batch recovery clear back (#2049)', () => {
  let env;
  const client = fixture.makeClient(handleRequest);
  const realInternal = { ...batch._internal };

  before(() => { env = fixture.openTempStore('tc-batch-read-'); });
  after(() => { fixture.resetLogin(); env.restore(); });
  beforeEach(() => { fixture.resetLogin(); });
  afterEach(() => { Object.assign(batch._internal, realInternal); });

  /**
   * Arm the login, sign in, and clear a batch as the operator.
   * @param {object[]} items - The items to send
   * @returns {Promise<{cookie: string, answer: object}>} The operator's cookie and the clear's answer
   */
  async function clearAsOperator(items) {
    client.arm();
    const { cookie, csrf } = await client.signIn();
    const res = await client.send('POST', CLEAR_URL, { body: { items }, headers: { cookie, 'x-csrf-token': csrf } });
    assert.equal(res.statusCode, 200, res.body);
    return { cookie, answer: client.json(res) };
  }

  /**
   * Read a batch as a signed-in operator and return the accepted answer.
   * @param {string} cookie - The operator's cookie
   * @param {string} batchId - Batch id
   * @returns {Promise<object>} The parsed 200 body
   */
  async function read(cookie, batchId) {
    const res = await client.send('GET', readUrl(batchId), { headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return client.json(res);
  }

  describe('who may read one', () => {
    /**
     * Assert a refusal carries its code and nothing of the batch.
     * @param {object} res - The response
     * @param {number} status - Expected status
     * @param {string} code - Expected error code
     * @returns {void}
     */
    function assertRefused(res, status, code) {
      assert.equal(res.statusCode, status, res.body);
      const body = client.json(res);
      assert.equal(body.code, code);
      assert.equal(body.items, undefined, 'a refusal carries no item');
      assert.equal(body.requestedBy, undefined, 'and does not say who sent the batch');
    }

    /**
     * A recorded batch on an install whose login has been put back to none.
     * @returns {Promise<string>} Its id
     */
    async function batchThenNoLogin() {
      const { answer } = await clearAsOperator([itemFor(fixture.launchInRecovery(env))]);
      fixture.resetLogin();
      return answer.batchId;
    }

    it('serves a signed-in operator on an armed install, with no CSRF token', async () => {
      const { cookie, answer } = await clearAsOperator([itemFor(fixture.launchInRecovery(env))]);
      const got = await read(cookie, answer.batchId);
      assert.equal(got.batchId, answer.batchId);
      assert.equal(got.requestedBy, 'rosie');
    });

    it('refuses an install with no login, with or without the dashboard\'s page token', async () => {
      const batchId = await batchThenNoLogin();
      assertRefused(await client.send('GET', readUrl(batchId)), 403, 'LOGIN_GATE_REQUIRED');
      const token = await client.pageToken();
      assertRefused(
        await client.send('GET', readUrl(batchId), { headers: { 'x-tc-open-token': token } }), 403, 'LOGIN_GATE_REQUIRED');
    });

    it('refuses an armed install\'s caller who is not signed in, browser or local process', async () => {
      const { answer } = await clearAsOperator([itemFor(fixture.launchInRecovery(env))]);
      assertRefused(await client.send('GET', readUrl(answer.batchId)), 401, 'UNAUTHENTICATED');
      assertRefused(await client.send('GET', readUrl(answer.batchId), { browser: false }), 401, 'UNAUTHENTICATED');
      assertRefused(
        await client.send('GET', readUrl(answer.batchId), { headers: { cookie: 'tc_session=not-a-session' } }),
        401, 'UNAUTHENTICATED');
    });

    it('refuses in fallback, even for a caller who signed in before it began', async () => {
      const { cookie, answer } = await clearAsOperator([itemFor(fixture.launchInRecovery(env))]);
      gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      assertRefused(await client.send('GET', readUrl(answer.batchId), { headers: { cookie } }), 409, 'GATE_FALLBACK');
    });

    it('refuses a gate state that is neither armed, open nor fallback by its own branch', async () => {
      // `account-required`: the login is on and no account exists.
      const batchId = await batchThenNoLogin();
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      assertRefused(await client.send('GET', readUrl(batchId), { browser: false }), 409, 'GATE_STATE_UNSUPPORTED');
    });

    it('answers an id no batch has with 404, to a signed-in operator only', async () => {
      const { cookie } = await clearAsOperator([itemFor(fixture.launchInRecovery(env))]);
      const res = await client.send('GET', readUrl('no-such-batch'), { headers: { cookie } });
      assertRefused(res, 404, 'BATCH_NOT_FOUND');
      // A caller nobody proved is not told whether an id exists.
      assertRefused(await client.send('GET', readUrl('no-such-batch')), 401, 'UNAUTHENTICATED');
    });
  });

  describe('the record it returns', () => {
    it('is the header and every item the batch wrote, in request order', async () => {
      const cleared = fixture.launchInRecovery(env);
      const moved = fixture.launchInRecovery(env);
      const items = [
        itemFor(cleared),
        itemFor(moved, { recoveryRevision: moved.binding.recoveryRevision + 1 }),
        { projectId: 999999, sessionId: 999999, sequenceId: 999999, recoveryRevision: 1 }
      ];
      const { cookie, answer } = await clearAsOperator(items);
      const got = await read(cookie, answer.batchId);

      assert.equal(got.requestedBy, answer.requestedBy);
      assert.equal(got.requestedAt, answer.requestedAt);
      assert.equal(got.itemCount, 3);
      assert.equal(got.recordedItemCount, 3);
      assert.deepEqual(got.unrecordedIndexes, []);
      assert.deepEqual(got.items.map((item) => item.index), [0, 1, 2]);
      assert.deepEqual(got.items.map((item) => item.outcome), ['cleared', 'stale', 'not-found']);
      assert.deepEqual(got.items.map((item) => item.outcome), answer.items.map((item) => item.outcome));
      for (const [index, sent] of items.entries()) {
        const { projectId, sessionId, sequenceId, recoveryRevision } = got.items[index];
        assert.deepEqual({ projectId, sessionId, sequenceId, recoveryRevision }, sent, 'the ids are the ones sent');
        assert.ok(got.items[index].recordedAt);
      }
    });

    it('names the clearance recorded for a cleared item, and none for any other', async () => {
      const cleared = fixture.launchInRecovery(env);
      const moved = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([
        itemFor(cleared), itemFor(moved, { recoveryRevision: moved.binding.recoveryRevision + 1 })
      ]);
      const got = await read(cookie, answer.batchId);
      const recorded = store.recoveryClearances.getForSequence(cleared.sequence.id);
      assert.deepEqual(got.items[0].clearance, {
        clearance: 'operator-verified', clearedBy: 'rosie', clearedAt: recorded.clearedAt
      });
      assert.equal(got.items[1].clearance, null);
    });

    it('reports a batch that stopped part-way by position, and guesses at nothing', async () => {
      const { cookie } = await clearAsOperator([itemFor(fixture.launchInRecovery(env))]);
      const held = fixture.launchInRecovery(env);
      store.recoveryClearBatches.create({ batchId: 'stopped-part-way', requestedBy: 'rosie', itemCount: 3 });
      store.recoveryClearBatches.recordItem({
        batchId: 'stopped-part-way', itemIndex: 1, ...itemFor(held), outcome: 'failed'
      });
      const got = await read(cookie, 'stopped-part-way');
      assert.equal(got.itemCount, 3);
      assert.equal(got.recordedItemCount, 1);
      assert.deepEqual(got.unrecordedIndexes, [0, 2]);
      assert.deepEqual(got.items.map((item) => item.index), [1]);
    });

    it('changes nothing it reads', async () => {
      const held = fixture.launchInRecovery(env);
      const moved = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([
        itemFor(held), itemFor(moved, { recoveryRevision: moved.binding.recoveryRevision + 1 })
      ]);
      const counts = recordCounts();
      const before = [held, moved].map((launch) => store.launchSequences.getBySession(launch.sequence.sessionId));
      await read(cookie, answer.batchId);
      await read(cookie, answer.batchId);
      assert.deepEqual(recordCounts(), counts);
      assert.deepEqual(
        [held, moved].map((launch) => store.launchSequences.getBySession(launch.sequence.sessionId)), before);
    });
  });

  describe('what it observes of each launch', () => {
    it('reads a cleared launch as stored: not blocked, no READY recorded, session active', async () => {
      const held = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([itemFor(held)]);
      const got = await read(cookie, answer.batchId);
      const stored = store.launchSequences.getBySession(held.sequence.sessionId);
      assert.ok(!Number.isNaN(Date.parse(got.observedAt)), 'the read says when it looked');
      assert.deepEqual(got.items[0].observation, {
        state: 'recorded',
        source: 'launch_sequences and sessions, as stored',
        recovery: 'cleared',
        recoveryRevision: stored.recoveryRevision,
        stillBlocked: false,
        cursor: stored.cursor,
        readyAt: null,
        attestedReady: false,
        sessionStatus: { state: 'recorded', value: 'active', endedAt: null, basis: 'stored-session-status' }
      });
    });

    it('reads a refused item\'s launch too, so a launch still blocked is said to be', async () => {
      const moved = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([
        itemFor(moved, { recoveryRevision: moved.binding.recoveryRevision + 1 })
      ]);
      const { observation } = (await read(cookie, answer.batchId)).items[0];
      assert.equal(observation.state, 'recorded');
      assert.equal(observation.recovery, 'required');
      assert.equal(observation.stillBlocked, true);
      assert.equal(observation.recoveryRevision, moved.binding.recoveryRevision, 'the revision stored now, not the one sent');
    });

    it('reads again each time: the record stays, the observation follows the launch', async () => {
      const held = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([itemFor(held)]);
      const first = await read(cookie, answer.batchId);

      const sequence = store.launchSequences.getBySession(held.sequence.sessionId);
      assert.equal(store.launchSequences.markReady(sequence.id, sequence.revision, { schema: 'tc.ready/1' }, 'digest'), true);
      const ready = (await read(cookie, answer.batchId)).items[0];
      assert.equal(ready.observation.attestedReady, true);
      assert.equal(ready.observation.readyAt, store.launchSequences.getBySession(held.sequence.sessionId).readyAt);
      assert.equal(ready.observation.sessionStatus.value, 'active');

      store.sessions.kill(held.sequence.sessionId, 'test');
      const ended = (await read(cookie, answer.batchId)).items[0];
      assert.equal(ended.observation.sessionStatus.value, 'killed');
      assert.ok(ended.observation.sessionStatus.endedAt, 'an ended session carries when it ended');
      // Still what the launch row says: an ended session's launch keeps its attestation.
      assert.equal(ended.observation.attestedReady, true);

      for (const later of [ready, ended]) {
        const { observation, ...record } = later;
        const { observation: firstObservation, ...firstRecord } = first.items[0];
        assert.deepEqual(record, firstRecord, 'the recorded item does not change between reads');
        assert.notDeepEqual(observation, firstObservation);
      }
    });

    it('says none is recorded for a launch that cannot be found as named, never "not blocked"', async () => {
      const held = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([
        { projectId: 999999, sessionId: 999999, sequenceId: 999999, recoveryRevision: 1 },
        // A real session, named with a launch that is not its own.
        itemFor(held, { sequenceId: held.binding.sequenceId + 100000 })
      ]);
      const got = await read(cookie, answer.batchId);
      for (const item of got.items) {
        assert.deepEqual(item.observation, {
          state: 'none-recorded', source: 'launch_sequences and sessions, as stored'
        });
      }
    });

    it('says unavailable when the launch cannot be read, with a code and none of the error', async () => {
      const held = fixture.launchInRecovery(env);
      const other = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([itemFor(held), itemFor(other)]);
      const real = batch._internal.launchAsNamed;
      batch._internal.launchAsNamed = (item) => {
        if (item.sequenceId === held.sequence.id) throw new Error('SQLITE_IOERR at /secret/path');
        return real(item);
      };
      const res = await client.send('GET', readUrl(answer.batchId), { headers: { cookie } });
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(!res.body.includes('SQLITE_IOERR') && !res.body.includes('/secret/path'));
      const got = client.json(res);
      assert.deepEqual(got.items[0].observation, {
        state: 'unavailable', source: 'launch_sequences and sessions, as stored', reasonCode: 'SOURCE_READ_FAILED'
      });
      assert.equal(got.items[0].outcome, 'cleared', 'the record is still served');
      assert.equal(got.items[1].observation.state, 'recorded', 'and one unreadable launch does not hide the next');
    });

    it('keeps the launch\'s own facts when only its session cannot be read, or has no row', async () => {
      const held = fixture.launchInRecovery(env);
      const { cookie, answer } = await clearAsOperator([itemFor(held)]);

      batch._internal.session = () => { throw new Error('SQLITE_IOERR at /secret/path'); };
      const res = await client.send('GET', readUrl(answer.batchId), { headers: { cookie } });
      assert.ok(!res.body.includes('SQLITE_IOERR') && !res.body.includes('/secret/path'));
      const unreadable = client.json(res).items[0].observation;
      assert.equal(unreadable.state, 'recorded');
      assert.equal(unreadable.recovery, 'cleared');
      assert.deepEqual(unreadable.sessionStatus, { state: 'unavailable', reasonCode: 'SOURCE_READ_FAILED' });

      batch._internal.session = () => null;
      const missing = (await read(cookie, answer.batchId)).items[0].observation;
      assert.equal(missing.state, 'recorded');
      assert.deepEqual(missing.sessionStatus, { state: 'none-recorded' });
    });

    it('answers 500 with a stable code when the batch\'s own record cannot be read', async () => {
      const { cookie, answer } = await clearAsOperator([itemFor(fixture.launchInRecovery(env))]);
      const realList = store.recoveryClearBatches.listItems;
      store.recoveryClearBatches.listItems = () => { throw new Error('SQLITE_IOERR at /secret/path'); };
      try {
        const res = await client.send('GET', readUrl(answer.batchId), { headers: { cookie } });
        assert.equal(res.statusCode, 500, res.body);
        assert.equal(client.json(res).code, 'BATCH_NOT_READ');
        assert.ok(!res.body.includes('SQLITE_IOERR') && !res.body.includes('/secret/path'));
      } finally {
        store.recoveryClearBatches.listItems = realList;
      }
    });
  });

  it('claims nothing about task acknowledgement, a prompt or resumed work', async () => {
    const held = fixture.launchInRecovery(env);
    const { cookie, answer } = await clearAsOperator([itemFor(held)]);
    const sequence = store.launchSequences.getBySession(held.sequence.sessionId);
    store.launchSequences.markReady(sequence.id, sequence.revision, { schema: 'tc.ready/1' }, 'digest');
    const res = await client.send('GET', readUrl(answer.batchId), { headers: { cookie } });
    const item = client.json(res).items[0];
    assert.deepEqual(Object.keys(item).sort(), [
      'clearance', 'index', 'observation', 'outcome', 'projectId', 'recordedAt', 'recoveryRevision',
      'sequenceId', 'sessionId'
    ]);
    assert.deepEqual(Object.keys(item.observation).sort(), [
      'attestedReady', 'cursor', 'readyAt', 'recovery', 'recoveryRevision', 'sessionStatus', 'source', 'state',
      'stillBlocked'
    ]);
    for (const word of ['acknowledged', 'working', 'resumed', 'prompt', 'woken']) {
      assert.ok(!res.body.toLowerCase().includes(word), `the answer does not say "${word}"`);
    }
  });
});
