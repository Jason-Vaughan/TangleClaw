'use strict';

/**
 * Clearing several launches in one operator request (#2049, schema v60).
 *
 * `POST /api/launch/recovery-clear-batch` takes a list of launches, each named
 * by the exact binding the operator read, and gives every one its own outcome.
 * This file holds that contract: who may send a batch, what a request must
 * look like before anything is applied, what each outcome means and when it is
 * given, that the batch and every outcome in it are on durable record, and
 * that an operator's clear cannot be written without its record by any path.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const batch = require('../lib/launch-recovery-batch');
const gateFallback = require('../lib/gate-fallback');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');

const URL = '/api/launch/recovery-clear-batch';

const OBJECTS = [
  'launch_recovery_clear_batches', 'launch_recovery_clear_batch_items',
  'idx_launch_recovery_clear_batch_items_item', 'launch_recovery_clear_batch_items_need_batch',
  'launch_recovery_clear_batches_append_only_update', 'launch_recovery_clear_batches_append_only_delete',
  'launch_recovery_clear_batch_items_append_only_update', 'launch_recovery_clear_batch_items_append_only_delete'
];

/**
 * How many rows a table of the open store holds.
 * @param {string} table - Table name
 * @returns {number}
 */
const rowCount = (table) => store.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/**
 * The row counts of the three tables a batch can write to.
 * @returns {{batches: number, items: number, clearances: number}}
 */
const recordCounts = () => ({
  batches: rowCount('launch_recovery_clear_batches'),
  items: rowCount('launch_recovery_clear_batch_items'),
  clearances: rowCount('launch_recovery_clearances')
});

/**
 * The item a request sends for a fixture launch.
 * @param {{project: object, binding: object}} held - A launch from the fixture
 * @param {object} [overrides] - Fields to replace
 * @returns {object}
 */
const itemFor = (held, overrides = {}) => ({ projectId: held.project.id, ...held.binding, ...overrides });

/**
 * A launch's stored recovery word.
 * @param {{sequence: object}} held - A launch from the fixture
 * @returns {string}
 */
const recoveryOf = (held) => store.launchSequences.getBySession(held.sequence.sessionId).recovery;

describe('the batch recovery clear (#2049)', () => {
  let env;
  const client = fixture.makeClient(handleRequest);

  before(() => { env = fixture.openTempStore('tc-clear-batch-'); });
  after(() => { fixture.resetLogin(); env.restore(); });
  beforeEach(() => { fixture.resetLogin(); });

  /**
   * Arm the login, sign in and send a batch as the operator.
   * @param {*} body - The request body
   * @returns {Promise<object>} The response
   */
  async function sendAsOperator(body) {
    client.arm();
    const { cookie, csrf } = await client.signIn();
    return client.send('POST', URL, { body, headers: { cookie, 'x-csrf-token': csrf } });
  }

  /**
   * Send a batch as the operator and return the accepted answer.
   * @param {object[]} items - The items to send
   * @returns {Promise<object>} The parsed 200 body
   */
  async function clearAsOperator(items) {
    const res = await sendAsOperator({ items });
    assert.equal(res.statusCode, 200, res.body);
    return client.json(res);
  }

  describe('who may send one', () => {
    /**
     * Assert a refusal carries its code, cleared nothing and recorded nothing.
     * @param {object} res - The response
     * @param {number} status - Expected status
     * @param {string} code - Expected error code
     * @param {object} held - The launch the request named
     * @param {object} counts - {@link recordCounts} from before the request
     * @returns {void}
     */
    function assertRefused(res, status, code, held, counts) {
      assert.equal(res.statusCode, status, res.body);
      assert.equal(client.json(res).code, code);
      assert.equal(recoveryOf(held), 'required', 'a refused batch clears nothing');
      assert.deepEqual(recordCounts(), counts, 'and records nothing');
    }

    it('takes a batch from a signed-in operator carrying their CSRF token', async () => {
      const held = fixture.launchInRecovery(env);
      const answer = await clearAsOperator([itemFor(held)]);
      assert.equal(answer.requestedBy, 'rosie');
      assert.equal(answer.items[0].outcome, 'cleared');
      assert.equal(recoveryOf(held), 'cleared');
    });

    it('refuses an install with no login, even with the dashboard\'s page token', async () => {
      const held = fixture.launchInRecovery(env);
      const counts = recordCounts();
      const token = await client.pageToken();
      const res = await client.send('POST', URL, { body: { items: [itemFor(held)] }, headers: { 'x-tc-open-token': token } });
      assertRefused(res, 403, 'LOGIN_GATE_REQUIRED', held, counts);
    });

    it('refuses a local process on an install with no login', async () => {
      const held = fixture.launchInRecovery(env);
      const counts = recordCounts();
      const res = await client.send('POST', URL, { body: { items: [itemFor(held)] }, browser: false });
      assertRefused(res, 403, 'OPERATOR_REQUIRED', held, counts);
    });

    it('refuses an armed install\'s caller who is not signed in, browser or local process', async () => {
      const held = fixture.launchInRecovery(env);
      const counts = recordCounts();
      client.arm();
      const body = { items: [itemFor(held)] };
      assertRefused(await client.send('POST', URL, { body }), 401, 'UNAUTHENTICATED', held, counts);
      assertRefused(await client.send('POST', URL, { body, browser: false }), 401, 'UNAUTHENTICATED', held, counts);
    });

    it('refuses a signed-in operator\'s request that carries no CSRF token, or a wrong one', async () => {
      const held = fixture.launchInRecovery(env);
      const counts = recordCounts();
      client.arm();
      const { cookie } = await client.signIn();
      const body = { items: [itemFor(held)] };
      assertRefused(await client.send('POST', URL, { body, headers: { cookie } }), 403, 'CSRF_TOKEN_INVALID', held, counts);
      assertRefused(await client.send('POST', URL, { body, headers: { cookie, 'x-csrf-token': 'not-the-token' } }),
        403, 'CSRF_TOKEN_INVALID', held, counts);
    });

    it('refuses in fallback, even for an operator who signed in before it began', async () => {
      const held = fixture.launchInRecovery(env);
      const counts = recordCounts();
      client.arm();
      const { cookie, csrf } = await client.signIn();
      gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      const res = await client.send('POST', URL, {
        body: { items: [itemFor(held)] }, headers: { cookie, 'x-csrf-token': csrf }
      });
      assertRefused(res, 409, 'GATE_FALLBACK', held, counts);
    });

    it('refuses a gate state that is neither armed, open nor fallback by its own branch', async () => {
      // `account-required`: the login is on and no account exists. A local
      // process is the caller that reaches the route in this state.
      const held = fixture.launchInRecovery(env);
      const counts = recordCounts();
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const res = await client.send('POST', URL, { body: { items: [itemFor(held)] }, browser: false });
      assertRefused(res, 409, 'GATE_STATE_UNSUPPORTED', held, counts);
    });
  });

  describe('what a request must look like', () => {
    const good = { projectId: 1, sessionId: 2, sequenceId: 3, recoveryRevision: 1 };
    const refused = [
      ['a body that is a list', () => [good], 'BAD_REQUEST'],
      ['a body with no items', () => ({}), 'BAD_REQUEST'],
      ['an empty list', () => ({ items: [] }), 'BAD_REQUEST'],
      ['items that are not a list', () => ({ items: good }), 'BAD_REQUEST'],
      ['a wildcard beside the items', (item) => ({ items: [item], all: true }), 'BAD_REQUEST'],
      ['an item that is not an object', (item) => ({ items: [item, 7] }), 'BAD_REQUEST'],
      ['an item that is null', (item) => ({ items: [item, null] }), 'BAD_REQUEST'],
      ['an item missing its revision', (item) => ({ items: [item, { projectId: 1, sessionId: 2, sequenceId: 3 }] }), 'BAD_REQUEST'],
      ['an id sent as text', (item) => ({ items: [item, { ...good, sequenceId: '3' }] }), 'BAD_REQUEST'],
      ['an id of zero', (item) => ({ items: [item, { ...good, sessionId: 0 }] }), 'BAD_REQUEST'],
      ['a negative revision', (item) => ({ items: [item, { ...good, recoveryRevision: -1 }] }), 'BAD_REQUEST'],
      ['a fractional id', (item) => ({ items: [item, { ...good, projectId: 1.5 }] }), 'BAD_REQUEST'],
      ['an item carrying a field nobody defined', (item) => ({ items: [item, { ...good, force: true }] }), 'BAD_REQUEST'],
      ['the same launch named twice', (item) => ({ items: [item, { ...item }] }), 'DUPLICATE_ITEM'],
      ['one launch named at two revisions', (item) => ({ items: [item, { ...item, recoveryRevision: item.recoveryRevision + 1 }] }), 'DUPLICATE_ITEM'],
      ['one session named with two launches', (item) => ({ items: [item, { ...item, sequenceId: item.sequenceId + 100000 }] }), 'DUPLICATE_ITEM'],
      ['more launches than a batch takes', (item) => ({
        items: [item, ...Array.from({ length: batch.MAX_ITEMS }, (_, i) => ({
          projectId: 1, sessionId: 800000 + i, sequenceId: 800000 + i, recoveryRevision: 1
        }))]
      }), 'TOO_MANY_ITEMS']
    ];

    for (const [what, build, code] of refused) {
      it(`refuses ${what}, and applies none of it`, async () => {
        const held = fixture.launchInRecovery(env);
        const counts = recordCounts();
        const res = await sendAsOperator(build(itemFor(held)));
        assert.equal(res.statusCode, 400, res.body);
        assert.equal(client.json(res).code, code);
        assert.equal(recoveryOf(held), 'required', 'the well-formed item beside it was not cleared');
        assert.deepEqual(recordCounts(), counts, 'and nothing was recorded');
      });
    }

    it('takes a batch of exactly the most it allows', async () => {
      const held = fixture.launchInRecovery(env);
      const filler = Array.from({ length: batch.MAX_ITEMS - 1 }, (_, i) => ({
        projectId: held.project.id, sessionId: 700000 + i, sequenceId: 700000 + i, recoveryRevision: 1
      }));
      const answer = await clearAsOperator([...filler, itemFor(held)]);
      assert.equal(answer.items.length, batch.MAX_ITEMS);
      assert.equal(answer.items.at(-1).outcome, 'cleared');
      assert.equal(store.recoveryClearBatches.get(answer.batchId).itemCount, batch.MAX_ITEMS);
    });
  });

  describe('what each item is told', () => {
    it('gives every item its own outcome, in request order, and one item does not stop the next', async () => {
      const clears = fixture.launchInRecovery(env);
      const moved = fixture.launchInRecovery(env);
      const advisory = fixture.launchInRecovery(env, 'advisory');
      const ended = fixture.launchInRecovery(env);
      store.sessions.kill(ended.sequence.sessionId, 'test');
      const archived = fixture.launchInRecovery(env);
      store.projects.archive(archived.project.id);
      const alreadyClear = fixture.launchInRecovery(env);
      await clearAsOperator([itemFor(alreadyClear)]);
      fixture.resetLogin();
      const alsoClears = fixture.launchInRecovery(env);

      const sent = [
        itemFor(clears),
        itemFor(moved, { recoveryRevision: moved.binding.recoveryRevision + 1 }),
        itemFor(advisory),
        itemFor(ended),
        itemFor(archived),
        itemFor(alreadyClear),
        { projectId: clears.project.id, sessionId: 600001, sequenceId: 600001, recoveryRevision: 1 },
        itemFor(alsoClears)
      ];
      const answer = await clearAsOperator(sent);

      assert.deepEqual(answer.items.map((item) => item.outcome), [
        'cleared', 'stale', 'advisory', 'session-ended', 'archived', 'already-clear', 'not-found', 'cleared'
      ]);
      answer.items.forEach((item, index) => {
        assert.equal(item.index, index);
        const { projectId, sessionId, sequenceId, recoveryRevision } = item;
        assert.deepEqual({ projectId, sessionId, sequenceId, recoveryRevision }, sent[index], 'the ids come back as sent');
        assert.equal(item.recorded, true);
      });

      assert.equal(recoveryOf(clears), 'cleared');
      assert.equal(recoveryOf(alsoClears), 'cleared');
      for (const untouched of [moved, advisory, ended, archived]) assert.equal(recoveryOf(untouched), 'required');
    });

    it('says whether each launch is still blocked, from a read made after the item was decided', async () => {
      const clears = fixture.launchInRecovery(env);
      const moved = fixture.launchInRecovery(env);
      const answer = await clearAsOperator([
        itemFor(clears),
        itemFor(moved, { recoveryRevision: moved.binding.recoveryRevision + 1 }),
        { projectId: clears.project.id, sessionId: 600002, sequenceId: 600002, recoveryRevision: 1 }
      ]);
      const [cleared, stale, missing] = answer.items;
      assert.deepEqual(
        { recoveryNow: cleared.recoveryNow, stillBlocked: cleared.stillBlocked }, { recoveryNow: 'cleared', stillBlocked: false });
      assert.deepEqual(
        { recoveryNow: stale.recoveryNow, stillBlocked: stale.stillBlocked }, { recoveryNow: 'required', stillBlocked: true });
      assert.equal(stale.recoveryRevisionNow, moved.binding.recoveryRevision,
        'a stale item is told the revision the launch is at, so it can be read again');
      assert.deepEqual(
        { recoveryNow: missing.recoveryNow, recoveryRevisionNow: missing.recoveryRevisionNow, stillBlocked: missing.stillBlocked },
        { recoveryNow: null, recoveryRevisionNow: null, stillBlocked: null },
        'a launch that cannot be read is unknown, never "not blocked"');
    });

    it('answers nothing about readiness, acknowledgement or resumed work', async () => {
      const held = fixture.launchInRecovery(env);
      const answer = await clearAsOperator([itemFor(held)]);
      assert.deepEqual(Object.keys(answer).sort(), ['batchId', 'items', 'requestedAt', 'requestedBy']);
      assert.deepEqual(Object.keys(answer.items[0]).sort(), [
        'index', 'outcome', 'projectId', 'recorded', 'recoveryNow', 'recoveryRevision', 'recoveryRevisionNow',
        'sequenceId', 'sessionId', 'stillBlocked'
      ]);
    });

    it('calls a launch already clear only at the revision the operator read', async () => {
      const held = fixture.launchInRecovery(env);
      await clearAsOperator([itemFor(held)]);
      fixture.resetLogin();
      const answer = await clearAsOperator([itemFor(held, { recoveryRevision: held.binding.recoveryRevision + 1 })]);
      assert.equal(answer.items[0].outcome, 'stale', 'a clear at another revision is a different decision');
      assert.equal(answer.items[0].stillBlocked, false);
    });

    it('calls a launch that never needed a clear stale, not already clear', async () => {
      const held = fixture.launchInRecovery(env);
      // Nothing in the product moves a required recovery back to none; the row
      // is set by hand to stand for a launch that was never held.
      store.getDb().prepare("UPDATE launch_sequences SET recovery = 'none' WHERE id = ?").run(held.sequence.id);
      const answer = await clearAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].outcome, 'stale');
      assert.equal(answer.items[0].stillBlocked, false);
    });

    it('decides stale before session-ended, and already-clear before session-ended', async () => {
      const endedAndMoved = fixture.launchInRecovery(env);
      store.sessions.kill(endedAndMoved.sequence.sessionId, 'test');
      const clearedThenEnded = fixture.launchInRecovery(env);
      await clearAsOperator([itemFor(clearedThenEnded)]);
      fixture.resetLogin();
      store.sessions.kill(clearedThenEnded.sequence.sessionId, 'test');
      const answer = await clearAsOperator([
        itemFor(endedAndMoved, { recoveryRevision: endedAndMoved.binding.recoveryRevision + 1 }),
        itemFor(clearedThenEnded)
      ]);
      assert.deepEqual(answer.items.map((item) => item.outcome), ['stale', 'already-clear']);
    });

    it('does not find a launch named under another project, and says nothing of it', async () => {
      const mine = fixture.launchInRecovery(env);
      const theirs = fixture.launchInRecovery(env);
      const answer = await clearAsOperator([itemFor(theirs, { projectId: mine.project.id })]);
      assert.equal(answer.items[0].outcome, 'not-found');
      assert.equal(answer.items[0].stillBlocked, null);
      assert.equal(recoveryOf(theirs), 'required');
    });

    it('does not find a project that does not exist', async () => {
      const held = fixture.launchInRecovery(env);
      const answer = await clearAsOperator([itemFor(held, { projectId: 900001 })]);
      assert.equal(answer.items[0].outcome, 'not-found');
      assert.equal(recoveryOf(held), 'required');
    });

    it('answers 200 when nothing in the batch was cleared', async () => {
      const ended = fixture.launchInRecovery(env);
      store.sessions.kill(ended.sequence.sessionId, 'test');
      const answer = await clearAsOperator([itemFor(ended)]);
      assert.deepEqual(answer.items.map((item) => item.outcome), ['session-ended']);
    });

    it('is safe to send twice: the second batch clears nothing and writes no second clearance', async () => {
      const first = fixture.launchInRecovery(env);
      const second = fixture.launchInRecovery(env);
      const items = [itemFor(first), itemFor(second)];
      const one = await clearAsOperator(items);
      const clearances = rowCount('launch_recovery_clearances');
      fixture.resetLogin();
      const two = await clearAsOperator(items);
      assert.notEqual(two.batchId, one.batchId, 'each request is its own batch');
      assert.deepEqual(two.items.map((item) => item.outcome), ['already-clear', 'already-clear']);
      assert.equal(rowCount('launch_recovery_clearances'), clearances);
      assert.equal(store.recoveryClearances.getForSequence(first.sequence.id).batchId, one.batchId,
        'the clearance still belongs to the batch that made it');
    });
  });

  describe('what is kept on record', () => {
    it('records the batch, every outcome in it and each clearance under one batch id and the operator', async () => {
      const clears = fixture.launchInRecovery(env);
      const ended = fixture.launchInRecovery(env);
      store.sessions.kill(ended.sequence.sessionId, 'test');
      const alsoClears = fixture.launchInRecovery(env);
      const sent = [itemFor(clears), itemFor(ended), itemFor(alsoClears)];
      const answer = await clearAsOperator(sent);

      const header = store.recoveryClearBatches.get(answer.batchId);
      assert.deepEqual(header, {
        batchId: answer.batchId, requestedBy: 'rosie', itemCount: sent.length, requestedAt: answer.requestedAt
      });
      assert.ok(header.requestedAt);

      const items = store.recoveryClearBatches.listItems(answer.batchId);
      assert.deepEqual(items.map(({ recordedAt, ...rest }) => rest), sent.map((item, itemIndex) => ({
        batchId: answer.batchId, itemIndex, ...item, outcome: ['cleared', 'session-ended', 'cleared'][itemIndex]
      })));
      for (const item of items) assert.ok(item.recordedAt);

      const clearances = store.recoveryClearances.listForBatch(answer.batchId);
      assert.deepEqual(clearances.map((c) => c.sequenceId), [clears.sequence.id, alsoClears.sequence.id]);
      for (const clearance of clearances) {
        assert.equal(clearance.clearance, 'operator-verified');
        assert.equal(clearance.clearedBy, 'rosie');
      }
      assert.deepEqual(clearances[0].preflight, clears.sequence.preflight, 'with the evidence the launch was cleared on');
      assert.equal(store.recoveryClearances.getForSequence(ended.sequence.id), null, 'a refused item has no clearance');
    });

    it('names the batch on the activity row of each clear it made', async () => {
      const held = fixture.launchInRecovery(env);
      const answer = await clearAsOperator([itemFor(held)]);
      const [row] = store.activity.query({ projectId: held.project.id, eventType: 'launch.recovery-cleared', limit: 5 });
      assert.equal(row.detail.batchId, answer.batchId);
      assert.equal(row.detail.clearedBy, 'rosie');
    });

    /**
     * Run `fn` with a trigger in place, and remove the trigger afterwards.
     * @param {string} name - Trigger name
     * @param {string} body - Everything after `CREATE TRIGGER <name>`
     * @param {() => Promise<*>} fn - The work
     * @returns {Promise<*>} Whatever `fn` returns
     */
    async function withTrigger(name, body, fn) {
      store.getDb().exec(`CREATE TRIGGER ${name} ${body}`);
      try {
        return await fn();
      } finally {
        store.getDb().exec(`DROP TRIGGER ${name}`);
      }
    }

    it('reports an item whose clearance cannot be written as failed, leaves it required and carries on', async () => {
      const first = fixture.launchInRecovery(env);
      const broken = fixture.launchInRecovery(env);
      const last = fixture.launchInRecovery(env);
      const answer = await withTrigger('test_refuse_one_clearance',
        `BEFORE INSERT ON launch_recovery_clearances WHEN NEW.sequence_id = ${broken.sequence.id}
         BEGIN SELECT RAISE(ABORT, 'the record cannot be written'); END`,
        () => clearAsOperator([itemFor(first), itemFor(broken), itemFor(last)]));

      assert.deepEqual(answer.items.map((item) => item.outcome), ['cleared', 'failed', 'cleared']);
      assert.equal(answer.items[1].stillBlocked, true);
      assert.equal(answer.items[1].recorded, true, 'the failure itself is on record');
      assert.ok(!JSON.stringify(answer).includes('the record cannot be written'), 'the store\'s error is not sent');
      assert.equal(recoveryOf(broken), 'required');
      assert.equal(store.recoveryClearances.getForSequence(broken.sequence.id), null);
      assert.deepEqual(store.recoveryClearBatches.listItems(answer.batchId).map((item) => item.outcome),
        ['cleared', 'failed', 'cleared']);

      // The failed launch clears in a later batch: nothing was left half-done.
      fixture.resetLogin();
      assert.equal((await clearAsOperator([itemFor(broken)])).items[0].outcome, 'cleared');
    });

    it('does not clear a launch whose cleared outcome cannot be written with it', async () => {
      const held = fixture.launchInRecovery(env);
      const answer = await withTrigger('test_refuse_cleared_outcome',
        `BEFORE INSERT ON launch_recovery_clear_batch_items WHEN NEW.outcome = 'cleared'
         BEGIN SELECT RAISE(ABORT, 'the outcome cannot be written'); END`,
        () => clearAsOperator([itemFor(held)]));
      assert.equal(answer.items[0].outcome, 'failed');
      assert.equal(answer.items[0].stillBlocked, true);
      assert.equal(recoveryOf(held), 'required', 'the clear was rolled back with its outcome');
      assert.equal(store.recoveryClearances.getForSequence(held.sequence.id), null, 'and so was its clearance');
      assert.deepEqual(store.recoveryClearBatches.listItems(answer.batchId).map((item) => item.outcome), ['failed']);
    });

    it('says so on the item when an outcome could not be recorded, and still gives the outcome', async () => {
      const held = fixture.launchInRecovery(env);
      const ended = fixture.launchInRecovery(env);
      store.sessions.kill(ended.sequence.sessionId, 'test');
      const answer = await withTrigger('test_refuse_every_outcome',
        `BEFORE INSERT ON launch_recovery_clear_batch_items
         BEGIN SELECT RAISE(ABORT, 'the outcome cannot be written'); END`,
        () => clearAsOperator([itemFor(held), itemFor(ended)]));
      assert.deepEqual(answer.items.map(({ outcome, recorded }) => ({ outcome, recorded })), [
        { outcome: 'failed', recorded: false },
        { outcome: 'session-ended', recorded: false }
      ]);
      assert.equal(recoveryOf(held), 'required');
      const header = store.recoveryClearBatches.get(answer.batchId);
      assert.equal(header.itemCount, 2);
      assert.deepEqual(store.recoveryClearBatches.listItems(answer.batchId), [],
        'the header names more items than have rows, which is the record that they were not written');
    });

    it('starts nothing when the batch itself cannot be recorded', async () => {
      const held = fixture.launchInRecovery(env);
      const counts = recordCounts();
      const res = await withTrigger('test_refuse_batch_header',
        `BEFORE INSERT ON launch_recovery_clear_batches
         BEGIN SELECT RAISE(ABORT, 'the header cannot be written'); END`,
        () => sendAsOperator({ items: [itemFor(held)] }));
      assert.equal(res.statusCode, 500, res.body);
      assert.equal(client.json(res).code, 'BATCH_NOT_RECORDED');
      assert.ok(!res.body.includes('the header cannot be written'), 'the store\'s error is not sent');
      assert.equal(recoveryOf(held), 'required');
      assert.deepEqual(recordCounts(), counts);
    });
  });

  describe('the record cannot be rewritten or forged', () => {
    /**
     * Record a batch header directly.
     * @returns {string} Its batch id
     */
    function header() {
      const batchId = `test-${Math.random().toString(36).slice(2, 12)}`;
      store.recoveryClearBatches.create({ batchId, requestedBy: 'rosie', itemCount: 3 });
      return batchId;
    }
    const item = { projectId: 1, sessionId: 2, sequenceId: 3, recoveryRevision: 1 };

    it('refuses an update and a delete of a batch and of an item', () => {
      const batchId = header();
      store.recoveryClearBatches.recordItem({ batchId, itemIndex: 0, ...item, outcome: 'stale' });
      const db = store.getDb();
      assert.throws(() => db.prepare("UPDATE launch_recovery_clear_batches SET requested_by = 'mallory' WHERE batch_id = ?").run(batchId), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM launch_recovery_clear_batches WHERE batch_id = ?').run(batchId), /append-only/);
      assert.throws(() => db.prepare("UPDATE launch_recovery_clear_batch_items SET outcome = 'cleared' WHERE batch_id = ?").run(batchId), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM launch_recovery_clear_batch_items WHERE batch_id = ?').run(batchId), /append-only/);
      assert.equal(store.recoveryClearBatches.get(batchId).requestedBy, 'rosie');
      assert.equal(store.recoveryClearBatches.getItem(batchId, 0).outcome, 'stale');
    });

    it('refuses an item for a batch that has no header', () => {
      assert.throws(
        () => store.recoveryClearBatches.recordItem({ batchId: 'no-such-batch', itemIndex: 0, ...item, outcome: 'stale' }),
        /needs its batch header first/);
    });

    it('refuses a second outcome for one item', () => {
      const batchId = header();
      store.recoveryClearBatches.recordItem({ batchId, itemIndex: 1, ...item, outcome: 'stale' });
      assert.throws(
        () => store.recoveryClearBatches.recordItem({ batchId, itemIndex: 1, ...item, outcome: 'failed' }), /UNIQUE/);
      assert.equal(store.recoveryClearBatches.getItem(batchId, 1).outcome, 'stale');
    });

    it('refuses an outcome word nobody defined', () => {
      const batchId = header();
      assert.throws(
        () => store.recoveryClearBatches.recordItem({ batchId, itemIndex: 0, ...item, outcome: 'probably-fine' }), /CHECK/);
    });

    it('refuses a cleared outcome written without a clear', () => {
      const batchId = header();
      assert.throws(
        () => store.recoveryClearBatches.recordItem({ batchId, itemIndex: 0, ...item, outcome: 'cleared' }),
        /recorded with its clear/);
      assert.equal(store.recoveryClearBatches.getItem(batchId, 0), null);
    });

    it('refuses a batch that names nobody', () => {
      assert.throws(() => store.recoveryClearBatches.create({ batchId: 'nobody', requestedBy: null, itemCount: 1 }), /NOT NULL/);
      assert.throws(() => store.recoveryClearBatches.create({ batchId: 'nobody', requestedBy: '', itemCount: 1 }), /CHECK/);
      assert.equal(store.recoveryClearBatches.get('nobody'), null);
    });

    it('keeps one vocabulary of outcomes between the batch and the table that records them', () => {
      assert.deepEqual(Object.values(batch.ITEM_OUTCOMES).sort(), [...store.RECOVERY_BATCH_OUTCOMES].sort());
    });
  });

  describe('an operator\'s clear cannot be written without its record', () => {
    it('refuses both operator words on the unrecorded clear, and clears nothing', () => {
      for (const clearance of ['operator-verified', 'open-install-unverified']) {
        const held = fixture.launchInRecovery(env);
        assert.throws(() => store.launchSequences.clearRecovery(held.sequence.id, {
          sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision, clearance, clearedBy: 'rosie'
        }), /clears by reconciliation only/);
        assert.equal(recoveryOf(held), 'required');
        assert.equal(store.recoveryClearances.getForSequence(held.sequence.id), null);
      }
    });

    it('still clears by a session\'s reconciliation, naming nobody and writing no clearance', () => {
      const held = fixture.launchInRecovery(env, 'advisory');
      const cleared = store.launchSequences.clearRecovery(held.sequence.id, {
        sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision,
        clearance: 'agent-reconciled', clearedBy: 'someone'
      });
      assert.equal(cleared.recovery, 'cleared');
      assert.equal(cleared.recoveryClearance, 'agent-reconciled');
      assert.equal(cleared.recoveryClearedBy, null, 'a name handed to a reconciliation is not recorded as its clearer');
      assert.equal(store.recoveryClearances.getForSequence(held.sequence.id), null);
    });

    it('refuses a word that is not an operator\'s on the recorded clear', () => {
      const held = fixture.launchInRecovery(env);
      assert.throws(() => store.launchSequences.clearRecoveryAsOperator(held.sequence.id, {
        sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision, clearance: 'agent-reconciled'
      }), /records an operator's clearance/);
      assert.equal(recoveryOf(held), 'required');
    });

    it('refuses a clear that names a batch and no item in it', () => {
      const held = fixture.launchInRecovery(env);
      assert.throws(() => store.launchSequences.clearRecoveryAsOperator(held.sequence.id, {
        sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision,
        clearance: 'operator-verified', clearedBy: 'rosie', batchId: 'some-batch'
      }), /must name its item/);
      assert.equal(recoveryOf(held), 'required');
    });

    it('refuses a clear under a batch that has no header', () => {
      const held = fixture.launchInRecovery(env);
      assert.throws(() => store.launchSequences.clearRecoveryAsOperator(held.sequence.id, {
        sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision,
        clearance: 'operator-verified', clearedBy: 'rosie', batchId: 'never-recorded', batchItemIndex: 0
      }), /needs its batch header first/);
      assert.equal(recoveryOf(held), 'required', 'the clear was rolled back');
      assert.equal(store.recoveryClearances.getForSequence(held.sequence.id), null);
    });
  });
});

describe('store: the batch recovery clear schema (v60, #2049)', () => {
  const dirs = [];
  const prevBase = store._getBasePath();

  /**
   * A new temp directory, removed after the suite.
   * @param {string} label - Directory label
   * @returns {string}
   */
  function tmp(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-clear-batch-v60-${label}-`));
    dirs.push(dir);
    return dir;
  }

  /**
   * The stored DDL of each batch object, by name.
   * @param {object} db - An open database
   * @returns {object}
   */
  function ddlOf(db) {
    const out = {};
    for (const name of OBJECTS) {
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
      out[name] = row ? row.sql : null;
    }
    return out;
  }

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A store as a v59 server left it: no batch objects, stamped 59, with a
   * project already in it.
   * @returns {string} Its directory
   */
  function seedV59() {
    const dir = tmp('v59');
    store.close();
    store._setBasePath(dir);
    store.init();
    store.projects.create({ name: 'carried', path: path.join(dir, 'carried'), engine: 'claude' });
    store.close();
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    // Dropping a table drops its triggers and indexes with it.
    db.exec('DROP TABLE launch_recovery_clear_batch_items');
    db.exec('DROP TABLE launch_recovery_clear_batches');
    db.exec('DELETE FROM schema_version');
    db.exec('INSERT INTO schema_version (version) VALUES (59)');
    db.close();
    return dir;
  }

  it('is at least the schema version these tables arrived in', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 60);
  });

  it('gives an upgraded store the same tables, index and triggers as a fresh one', () => {
    const freshDir = tmp('fresh');
    store.close();
    store._setBasePath(freshDir);
    store.init();
    const fresh = ddlOf(store.getDb());
    for (const name of OBJECTS) assert.ok(fresh[name], `a fresh store has ${name}`);
    store.close();

    const dir = seedV59();
    const probe = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    assert.deepEqual(Object.values(ddlOf(probe)).filter(Boolean), [], 'precondition: the v59 store has none of them');
    probe.close();

    store._setBasePath(dir);
    store.init();
    assert.deepEqual(ddlOf(store.getDb()), fresh);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.ok(store.projects.getByName('carried'), 'the upgrade keeps the projects it found');
    assert.ok(store.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name = 'launch_recovery_clearances'").get(),
      'and the clearance record it already had');
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM launch_recovery_clear_batches').get().n, 0,
      'and invents no batch');
  });

  it('refuses to advance over an item table that cannot keep the record', () => {
    const dir = seedV59();
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    // A table of the right name whose outcome column admits any word.
    db.exec(`CREATE TABLE launch_recovery_clear_batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, item_index INTEGER NOT NULL,
      project_id INTEGER NOT NULL, session_id INTEGER NOT NULL, sequence_id INTEGER NOT NULL,
      recovery_revision INTEGER NOT NULL, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
    db.close();
    store._setBasePath(dir);
    assert.throws(() => store.init(), /v59→v60 left launch_recovery_clear_batch_items without the outcome/);
    store.close();
    const after = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 59,
      'the version stays where it was');
    after.close();
  });

  it('is unharmed by a second boot', () => {
    const dir = seedV59();
    store._setBasePath(dir);
    store.init();
    const first = ddlOf(store.getDb());
    store.close();
    store.init();
    assert.deepEqual(ddlOf(store.getDb()), first);
    assert.equal(
      store.getDb().prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = ?').get(store.CURRENT_SCHEMA_VERSION).n,
      1, 'the version is stamped once');
  });
});
