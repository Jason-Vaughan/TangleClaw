'use strict';

/**
 * The explicit operator wake (#2250, Architect Ruling A2250).
 *
 * `POST /api/launch/recovery-wake-batch` takes a list of launches, each named
 * by the exact binding the operator read, and re-nudges every one that has
 * passed its recovery gate and is still waiting to attest READY. This file
 * holds the operator proof and request-shape contract (mirroring the batch
 * clear's, since both are the same larger grant), and the per-item decision
 * tree: every pre-send gate, the shared pane-busy safeguard, and the
 * three-facts-apart response shape.
 *
 * The pane itself is stubbed throughout — capturing tmux and typing into it
 * are the two things a test must not do for real, same discipline as
 * `test/launch-unready.test.js`, whose safeguards this module reuses.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchRecoveryWake = require('../lib/launch-recovery-wake');
const launchRecoveryClear = require('../lib/launch-recovery-clear');
const gateFallback = require('../lib/gate-fallback');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');

const URL = '/api/launch/recovery-wake-batch';

/**
 * The `{projectId, sessionId, sequenceId, recoveryRevision}` a wake item names.
 * @param {{project: object, binding: object}} held - A launch from the fixture
 * @param {object} [overrides]
 * @returns {object}
 */
function itemFor(held, overrides = {}) {
  return { projectId: held.project.id, ...held.binding, ...overrides };
}

/**
 * A launch past its recovery gate: held, then cleared directly (bypassing
 * HTTP — the clear itself is `test/launch-recovery-clear-batch.test.js`'s
 * contract, not this file's), with its session still active.
 * @param {object} env - From {@link fixture.openTempStore}
 * @returns {{project: object, sequence: object, binding: object}}
 */
function clearedActiveLaunch(env) {
  const held = fixture.launchInRecovery(env);
  const result = launchRecoveryClear.clearOneLaunch({
    project: held.project, sessionId: held.binding.sessionId, sequenceId: held.binding.sequenceId,
    recoveryRevision: held.binding.recoveryRevision, clearance: 'operator-verified', clearedBy: 'test'
  });
  assert.equal(result.outcome, launchRecoveryClear.OUTCOMES.CLEARED, 'the fixture must actually be past the gate');
  const sequence = store.launchSequences.getBySession(held.binding.sessionId);
  return {
    project: held.project,
    sequence,
    binding: { sessionId: sequence.sessionId, sequenceId: sequence.id, recoveryRevision: sequence.recoveryRevision }
  };
}

describe('the recovery wake (#2250)', () => {
  let env;
  const client = fixture.makeClient(handleRequest);
  let realSeams;

  before(() => {
    env = fixture.openTempStore('tc-recovery-wake-');
    realSeams = { ...launchRecoveryWake._internal };
  });
  after(() => { fixture.resetLogin(); env.restore(); });
  beforeEach(() => {
    fixture.resetLogin();
    Object.assign(launchRecoveryWake._internal, realSeams);
    // A pane at rest, safe to type into, without touching tmux.
    launchRecoveryWake._internal.wakeProfiles = () => ({ claude: { busyMarker: 'esc to interrupt', promptRe: /^> / } });
    launchRecoveryWake._internal.capturePane = () => ({ lines: ['> '], alternateScreen: false });
    launchRecoveryWake._internal.cursorInfo = () => null;
    launchRecoveryWake._internal.assessIdle = () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 1 });
    launchRecoveryWake._internal.inject = () => ({ ok: true, error: null });
  });

  /**
   * Arm the login, sign in and send a wake as the operator.
   * @param {*} body - The request body
   * @returns {Promise<object>} The response
   */
  async function sendAsOperator(body) {
    client.arm();
    const { cookie, csrf } = await client.signIn();
    return client.send('POST', URL, { body, headers: { cookie, 'x-csrf-token': csrf } });
  }

  /**
   * Send a wake as the operator and return the accepted answer.
   * @param {object[]} items - The items to send
   * @returns {Promise<object>} The parsed 200 body
   */
  async function wakeAsOperator(items) {
    const res = await sendAsOperator({ items });
    assert.equal(res.statusCode, 200, res.body);
    return client.json(res);
  }

  describe('who may send one', () => {
    /**
     * Assert a refusal carries its code and sent nothing.
     * @param {object} res - The response
     * @param {number} status - Expected status
     * @param {string} code - Expected error code
     * @returns {void}
     */
    function assertRefused(res, status, code) {
      assert.equal(res.statusCode, status, res.body);
      assert.equal(client.json(res).code, code);
    }

    it('takes a wake from a signed-in operator carrying their CSRF token', async () => {
      const held = clearedActiveLaunch(env);
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.requestedBy, 'rosie');
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.SENT);
    });

    it('refuses an install with no login, even with the dashboard\'s page token', async () => {
      const held = clearedActiveLaunch(env);
      const token = await client.pageToken();
      const res = await client.send('POST', URL, { body: { items: [itemFor(held)] }, headers: { 'x-tc-open-token': token } });
      assertRefused(res, 403, 'LOGIN_GATE_REQUIRED');
    });

    it('refuses an armed install\'s caller who is not signed in', async () => {
      const held = clearedActiveLaunch(env);
      client.arm();
      const res = await client.send('POST', URL, { body: { items: [itemFor(held)] } });
      assertRefused(res, 401, 'UNAUTHENTICATED');
    });

    it('refuses a signed-in operator\'s request that carries no CSRF token, or a wrong one', async () => {
      const held = clearedActiveLaunch(env);
      client.arm();
      const { cookie } = await client.signIn();
      const body = { items: [itemFor(held)] };
      assertRefused(await client.send('POST', URL, { body, headers: { cookie } }), 403, 'CSRF_TOKEN_INVALID');
      assertRefused(await client.send('POST', URL, { body, headers: { cookie, 'x-csrf-token': 'not-the-token' } }),
        403, 'CSRF_TOKEN_INVALID');
    });

    it('refuses in fallback, even for an operator who signed in before it began', async () => {
      const held = clearedActiveLaunch(env);
      client.arm();
      const { cookie, csrf } = await client.signIn();
      gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      const res = await client.send('POST', URL, { body: { items: [itemFor(held)] }, headers: { cookie, 'x-csrf-token': csrf } });
      assertRefused(res, 409, 'GATE_FALLBACK');
    });
  });

  describe('what a request must look like', () => {
    const good = { projectId: 1, sessionId: 2, sequenceId: 3, recoveryRevision: 1 };
    const refused = [
      ['a body that is a list', () => [good], 'BAD_REQUEST'],
      ['a body with no items', () => ({}), 'BAD_REQUEST'],
      ['an empty list', () => ({ items: [] }), 'BAD_REQUEST'],
      ['a wildcard beside the items', (item) => ({ items: [item], all: true }), 'BAD_REQUEST'],
      ['an item missing its revision', (item) => ({ items: [item, { projectId: 1, sessionId: 2, sequenceId: 3 }] }), 'BAD_REQUEST'],
      ['an id sent as text', (item) => ({ items: [item, { ...good, sequenceId: '3' }] }), 'BAD_REQUEST'],
      ['an item carrying a field nobody defined', (item) => ({ items: [item, { ...good, force: true }] }), 'BAD_REQUEST'],
      ['the same launch named twice', (item) => ({ items: [item, { ...item }] }), 'DUPLICATE_ITEM'],
      ['more launches than a wake takes', (item) => ({
        items: [item, ...Array.from({ length: launchRecoveryWake.MAX_ITEMS }, (_, i) => ({
          projectId: 1, sessionId: 800000 + i, sequenceId: 800000 + i, recoveryRevision: 1
        }))]
      }), 'TOO_MANY_ITEMS']
    ];

    for (const [what, build, code] of refused) {
      it(`refuses ${what}`, async () => {
        const held = clearedActiveLaunch(env);
        const res = await sendAsOperator(build(itemFor(held)));
        assert.equal(res.statusCode, 400, res.body);
        assert.equal(client.json(res).code, code);
      });
    }
  });

  describe('what each item is told', () => {
    it('does not find a project that does not exist', async () => {
      const answer = await wakeAsOperator([{ projectId: 999999, sessionId: 1, sequenceId: 1, recoveryRevision: 1 }]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.NOT_FOUND);
      assert.equal(answer.items[0].send.attempted, false);
    });

    it('does not wake an archived project\'s launch', async () => {
      const held = clearedActiveLaunch(env);
      store.projects.archive(held.project.id);
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.ARCHIVED);
    });

    it('refuses a launch whose recovery is still required', async () => {
      const held = fixture.launchInRecovery(env);
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.STILL_BLOCKED);
      assert.equal(answer.items[0].send.attempted, false);
    });

    it('refuses a revision the launch has moved past', async () => {
      const held = clearedActiveLaunch(env);
      const answer = await wakeAsOperator([itemFor(held, { recoveryRevision: held.binding.recoveryRevision + 1 })]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.STALE);
    });

    it('refuses a launch that has already attested READY', async () => {
      const held = clearedActiveLaunch(env);
      store.launchSequences.markReady(held.sequence.id, held.sequence.revision, { verdict: 'ok' }, 'd');
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.ALREADY_READY);
    });

    it('refuses a launch whose session has ended', async () => {
      const held = clearedActiveLaunch(env);
      store.sessions.kill(held.binding.sessionId, 'test');
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.SESSION_ENDED);
    });

    it('sends, and reports stepAcknowledgement and readyAttestation separately from the send', async () => {
      const held = clearedActiveLaunch(env);
      const answer = await wakeAsOperator([itemFor(held)]);
      const item = answer.items[0];
      assert.equal(item.send.attempted, true);
      assert.equal(item.send.sent, true);
      assert.equal(item.send.outcome, launchRecoveryWake.SEND_OUTCOMES.SENT);
      assert.equal(item.stepAcknowledgement.state, 'recorded');
      assert.equal(typeof item.stepAcknowledgement.cursor, 'number');
      assert.equal(item.readyAttestation.state, 'recorded');
      assert.equal(item.readyAttestation.attestedReady, false);
      assert.equal(item.readyAttestation.readyAt, null);
      assert.equal(store.launchSequences.getBySession(held.binding.sessionId).nudgeCount, 1);
    });

    it('does not consume the one wake per revision twice', async () => {
      const held = clearedActiveLaunch(env);
      const first = await wakeAsOperator([itemFor(held)]);
      assert.equal(first.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.SENT);
      fixture.resetLogin();
      const second = await wakeAsOperator([itemFor(held)]);
      assert.equal(second.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.ALREADY_WOKEN);
      assert.equal(store.launchSequences.getBySession(held.binding.sessionId).nudgeCount, 1, 'only the first wake typed anything');
    });

    it('fails closed on a busy pane, and does not consume the wake slot', async () => {
      const held = clearedActiveLaunch(env);
      launchRecoveryWake._internal.assessIdle = () => ({ idle: false, reason: 'turn-running', digest: 'd', idleTicks: 0 });
      const first = await wakeAsOperator([itemFor(held)]);
      assert.equal(first.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.PANE_BUSY);
      assert.equal(first.items[0].send.reason, 'turn-running');
      // The slot was not consumed: retrying once the pane is idle still sends.
      launchRecoveryWake._internal.assessIdle = () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 1 });
      fixture.resetLogin();
      const second = await wakeAsOperator([itemFor(held)]);
      assert.equal(second.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.SENT);
    });

    it('fails closed when the pane cannot be captured', async () => {
      const held = clearedActiveLaunch(env);
      launchRecoveryWake._internal.capturePane = () => { throw new Error('pane vanished'); };
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.PANE_CAPTURE_FAILED);
    });

    it('refuses an engine with no probed pane signature', async () => {
      const held = clearedActiveLaunch(env);
      launchRecoveryWake._internal.wakeProfiles = () => ({});
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.UNPROFILED_ENGINE);
    });

    it('reports a failed injection without sending, and without consuming the wake slot', async () => {
      const held = clearedActiveLaunch(env);
      launchRecoveryWake._internal.inject = () => ({ ok: false, error: 'tmux session not found' });
      const first = await wakeAsOperator([itemFor(held)]);
      assert.equal(first.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.INJECT_FAILED);
      assert.equal(first.items[0].send.reason, 'tmux session not found');
      launchRecoveryWake._internal.inject = () => ({ ok: true, error: null });
      fixture.resetLogin();
      const second = await wakeAsOperator([itemFor(held)]);
      assert.equal(second.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.SENT);
    });

    it('reports a held control lane without sending', async () => {
      const held = clearedActiveLaunch(env);
      launchRecoveryWake._internal.inject = () => ({ ok: false, controlRefusal: { code: 'held' } });
      const answer = await wakeAsOperator([itemFor(held)]);
      assert.equal(answer.items[0].send.outcome, launchRecoveryWake.SEND_OUTCOMES.CONTROL_HELD);
    });

    it('gives every item its own outcome, in request order, and one item does not stop the next', async () => {
      const sends = clearedActiveLaunch(env);
      const blocked = fixture.launchInRecovery(env);
      const ended = clearedActiveLaunch(env);
      store.sessions.kill(ended.binding.sessionId, 'test');

      const answer = await wakeAsOperator([itemFor(sends), itemFor(blocked), itemFor(ended)]);
      const { SENT, STILL_BLOCKED, SESSION_ENDED } = launchRecoveryWake.SEND_OUTCOMES;
      assert.deepEqual(answer.items.map((item) => item.send.outcome), [SENT, STILL_BLOCKED, SESSION_ENDED]);
      assert.deepEqual(answer.items.map((item) => item.index), [0, 1, 2]);
    });

    it('never merges send, step acknowledgement and READY attestation into one verdict', async () => {
      // The three facts stay apart even on the happy path: a sent nudge is not
      // proof of acknowledgement, and neither claims the launch is READY.
      const held = clearedActiveLaunch(env);
      const answer = await wakeAsOperator([itemFor(held)]);
      const item = answer.items[0];
      assert.ok('send' in item && 'stepAcknowledgement' in item && 'readyAttestation' in item);
      assert.equal(Object.keys(item.send).sort().join(','), 'attempted,outcome,reason,sent');
      assert.ok(!('attestedReady' in item.send) && !('cursor' in item.send),
        'the send fact must not absorb the other two facts\' own fields');
    });
  });
});
