'use strict';

// #1839: the Medusa delivery watchdog's exchange state. Facts are append-only
// and the exchange row is their projection, so these tests drive the state
// through facts in the orders the real system produces them (including out of
// order), and check both the row and a replay of its facts.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const mx = require('../lib/medusa-exchanges');

const UNBOUND = { kind: 'unbound' };
const OPERATOR = { kind: 'operator', proof: 'verified-session' };
const AMBIENT = { kind: 'operator', proof: 'ambient-open' };
const SYSTEM = { kind: 'system' };
const PM = { kind: 'project', projectId: 10 };
const BUILDER = { kind: 'project', projectId: 20 };

let tmpDir = null;
let clock = 0;

/**
 * Move the fake clock forward.
 * @param {number} ms - Milliseconds
 * @returns {void}
 */
function advance(ms) {
  clock += ms;
}

/**
 * Record a send from the PM to the Builder and bind its Hub id.
 * @param {object} [body] - Send body
 * @param {string} [hubId] - Hub id to bind
 * @returns {object} The exchange row
 */
function sendPmToBuilder(body = {}, hubId = 'hub-1') {
  const meta = mx.validateSendMeta(body, PM, 10);
  const x = mx.createSendIntent({
    meta,
    sender: { projectId: 10, sessionId: 1, workspaceId: 'pm-ws' },
    recipient: { workspaceId: 'builder-ws', projectId: 20, sessionId: 2 }
  });
  return hubId ? mx.bindHubId(x.exchange_id, hubId, { hubStatus: 'received' }) : x;
}

/**
 * Assert a row's projection equals a fresh replay of its facts.
 * @param {string} exchangeId - Exchange id
 * @returns {void}
 */
function assertReplayMatches(exchangeId) {
  const row = store.medusaExchanges.get(exchangeId);
  const replayed = mx.replay(exchangeId);
  for (const [k, v] of Object.entries(replayed)) assert.deepEqual(row[k], v, `projection column ${k} differs from replay`);
}

describe('medusa-exchanges (#1839)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mx-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = Date.parse('2026-09-25T12:00:00.000Z');
    mx._internal.now = () => new Date(clock);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mx._internal.now = () => new Date();
  });

  describe('validateSendMeta', () => {
    it('defaults to normal, no reply required, and records an unbound sender as unverified', () => {
      const m = mx.validateSendMeta({}, UNBOUND, 10);
      assert.equal(m.priority, 'normal');
      assert.equal(m.replyRequired, false);
      assert.equal(m.verified, false);
      assert.equal(m.proof, null);
      assert.match(m.requestId, /^send:/);
    });

    it('rejects an unknown priority', () => {
      assert.throws(() => mx.validateSendMeta({ priority: 'urgent' }, PM, 10), { code: 'PRIORITY_INVALID', status: 400 });
    });

    it('requires a verified launch of the sending project for blocking, and never downgrades', () => {
      assert.throws(() => mx.validateSendMeta({ priority: 'blocking' }, UNBOUND, 10), { code: 'PRIORITY_BINDING_REQUIRED', status: 403 });
      assert.throws(() => mx.validateSendMeta({ priority: 'blocking' }, BUILDER, 10), { code: 'PRIORITY_BINDING_REQUIRED' });
      const m = mx.validateSendMeta({ priority: 'blocking' }, PM, 10);
      assert.equal(m.priority, 'blocking');
      assert.equal(m.replyRequired, true);
      assert.equal(m.verified, true);
      assert.equal(m.proof, 'launch');
    });

    it('reserves critical to operator proof and in-process system calls', () => {
      assert.throws(() => mx.validateSendMeta({ priority: 'critical' }, PM, 10), { code: 'PRIORITY_RESERVED', status: 403 });
      assert.throws(() => mx.validateSendMeta({ priority: 'critical' }, UNBOUND, 10), { code: 'PRIORITY_RESERVED' });
      assert.equal(mx.validateSendMeta({ priority: 'critical' }, OPERATOR, null).proof, 'verified-session');
      assert.equal(mx.validateSendMeta({ priority: 'critical' }, AMBIENT, null).proof, 'ambient-open');
      assert.equal(mx.validateSendMeta({ priority: 'critical' }, SYSTEM, null).proof, 'system');
    });

    it('lets a sender only shorten the escalation deadline, within bounds', () => {
      assert.equal(mx.validateSendMeta({ priority: 'blocking', escalateAfterMinutes: 10 }, PM, 10).escalateAfterMs, 600000);
      assert.throws(() => mx.validateSendMeta({ priority: 'blocking', escalateAfterMinutes: 1 }, PM, 10), { code: 'DEADLINE_OUT_OF_RANGE' });
      assert.throws(() => mx.validateSendMeta({ priority: 'blocking', escalateAfterMinutes: 16 }, PM, 10), { code: 'DEADLINE_OUT_OF_RANGE' });
      assert.throws(() => mx.validateSendMeta({ priority: 'critical', escalateAfterMinutes: 3 }, OPERATOR, null), { code: 'DEADLINE_OUT_OF_RANGE' });
      assert.throws(() => mx.validateSendMeta({ escalateAfterMinutes: 'soon' }, PM, 10), { code: 'DEADLINE_OUT_OF_RANGE' });
    });

    it('accepts only enumerated reasons and a boolean replyRequired', () => {
      assert.equal(mx.validateSendMeta({ reason: 'awaiting-ruling' }, PM, 10).reasonCode, 'awaiting-ruling');
      assert.throws(() => mx.validateSendMeta({ reason: 'please hurry' }, PM, 10), { code: 'REASON_INVALID' });
      assert.throws(() => mx.validateSendMeta({ replyRequired: 'yes' }, PM, 10), { code: 'EXCHANGE_MALFORMED' });
      assert.equal(mx.validateSendMeta({ priority: 'blocking', replyRequired: false }, PM, 10).replyRequired, false);
    });

    it('requires a verified caller to reply to an existing exchange', () => {
      assert.throws(() => mx.validateSendMeta({ inReplyTo: 'hub-1' }, UNBOUND, 20), { code: 'EXCHANGE_BINDING_REQUIRED', status: 403 });
      assert.equal(mx.validateSendMeta({ inReplyTo: 'hub-1' }, BUILDER, 20).inReplyTo, 'hub-1');
    });
  });

  describe('send intent and Hub binding', () => {
    it('records the intent before the Hub answers, then binds the Hub id', () => {
      const intent = sendPmToBuilder({}, null);
      assert.equal(intent.state, 'send_pending');
      assert.equal(intent.hub_id, null);
      const bound = mx.bindHubId(intent.exchange_id, 'hub-1', { hubStatus: 'queued' });
      assert.equal(bound.state, 'stored');
      assert.equal(bound.hub_id, 'hub-1');
      assertReplayMatches(bound.exchange_id);
    });

    it('refuses to record a reused requestId, so a retry never reaches the Hub twice', () => {
      const meta = mx.validateSendMeta({ requestId: 'req-a' }, PM, 10);
      const args = { meta, sender: { projectId: 10 }, recipient: { workspaceId: 'builder-ws', projectId: 20 } };
      const a = mx.createSendIntent(args);
      assert.throws(() => mx.createSendIntent(args), (err) => err.code === 'SEND_ALREADY_ATTEMPTED' && err.status === 409
        && err.details.exchangeId === a.exchange_id);
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM medusa_exchanges').get().n, 1);
    });

    it('keeps an unknown Hub outcome as send_unknown and does not retry it', () => {
      const intent = sendPmToBuilder({}, null);
      const x = mx.markSendUnknown(intent.exchange_id, 'hub-timeout');
      assert.equal(x.state, 'send_unknown');
      assert.deepEqual(store.medusaExchanges.facts(x.exchange_id).map((f) => f.fact), ['send_pending', 'send_unknown']);
      // A late answer still binds; the exchange then knows its message exists.
      assert.equal(mx.bindHubId(x.exchange_id, 'hub-late').state, 'stored');
    });

    it('ends an explicit Hub refusal as undeliverable', () => {
      const x = mx.markSendRefused(sendPmToBuilder({}, null).exchange_id, 'hub-refused');
      assert.equal(x.state, 'undeliverable');
      assert.ok(x.terminal_at);
    });

    it('refuses a sixth open blocking message from one sender', () => {
      for (let i = 0; i < mx.MAX_OPEN_BLOCKING_PER_SENDER; i++) sendPmToBuilder({ priority: 'blocking' }, `hub-b${i}`);
      assert.throws(() => sendPmToBuilder({ priority: 'blocking' }, 'hub-b6'), { code: 'BLOCKING_LIMIT', status: 429 });
    });

    it('refuses a protected priority to a recipient this host cannot supervise, but tracks nothing for normal', () => {
      const recipient = { workspaceId: 'remote-ws' };
      const blocking = mx.validateSendMeta({ priority: 'blocking' }, PM, 10);
      assert.throws(() => mx.createSendIntent({ meta: blocking, sender: { projectId: 10 }, recipient, tracking: 'untracked' }),
        { code: 'WATCHDOG_UNAVAILABLE_REMOTE', status: 422 });
      const normal = mx.createSendIntent({ meta: mx.validateSendMeta({}, PM, 10), sender: { projectId: 10 }, recipient, tracking: 'untracked' });
      assert.equal(normal.state, 'untracked');
      assert.equal(store.medusaExchanges.listOpen().length, 0);
    });
  });

  describe('recipient facts', () => {
    it('walks a normal message from arrival to an automatic close on acknowledgement', () => {
      const x = sendPmToBuilder();
      assert.equal(mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' }).state, 'delivered');
      assert.equal(mx.recordRead(['hub-1']), 1);
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'read');
      assert.equal(mx.recordAcknowledged(['hub-1'], BUILDER), 1);
      const done = store.medusaExchanges.get(x.exchange_id);
      assert.equal(done.state, 'closed');
      assert.equal(done.terminal_code, 'acknowledged');
      assertReplayMatches(x.exchange_id);
    });

    it('advances the same exchange idempotently across redelivery, reconnect and repeated reads', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      mx.recordRead(['hub-1']);
      assert.equal(mx.recordRead(['hub-1']), 0);
      const kinds = store.medusaExchanges.facts(x.exchange_id).map((f) => f.fact);
      assert.equal(kinds.filter((k) => k === 'arrived').length, 1);
      assert.equal(kinds.filter((k) => k === 'read').length, 1);
    });

    it('projects out-of-order facts by kind: a reply before the ack, a read before the arrival', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      const reply = mx.createSendIntent({
        meta: mx.validateSendMeta({ inReplyTo: 'hub-1' }, BUILDER, 20),
        sender: { projectId: 20 }, recipient: { workspaceId: 'pm-ws', projectId: 10 }
      });
      mx.bindHubId(reply.exchange_id, 'hub-reply');
      mx.recordRead(['hub-1']);
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      mx.recordAcknowledged(['hub-1'], BUILDER);
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'replied');
      assert.equal(mx.view(row).label, 'satisfied, awaiting initiator close');
      assert.equal(row.terminal_at, null, 'a reply-required exchange stays open for its initiator to close');
      assertReplayMatches(x.exchange_id);
    });

    it('records the dashboard auto-ack as operator-ui and leaves a reply-required exchange unsatisfied', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordAcknowledged(['hub-1'], { kind: 'operator-ui' });
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'acknowledged');
      assert.equal(row.terminal_at, null);
      const ack = store.medusaExchanges.facts(x.exchange_id).find((f) => f.fact === 'acknowledged');
      assert.equal(ack.actor, 'operator-ui');
    });

    it('still records the agent acknowledging after the dashboard did', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordAcknowledged(['hub-1'], { kind: 'operator-ui' });
      assert.equal(mx.recordAcknowledged(['hub-1'], BUILDER), 1);
      assert.equal(mx.recordAcknowledged(['hub-1'], BUILDER), 0, 'the same actor twice adds nothing');
      const actors = store.medusaExchanges.facts(x.exchange_id).filter((f) => f.fact === 'acknowledged').map((f) => f.actor);
      assert.deepEqual(actors, ['operator-ui', 'recipient']);
    });

    it('records an unproven reader as unverified, never as the recipient', () => {
      const x = sendPmToBuilder();
      mx.recordRead(['hub-1'], UNBOUND);
      assert.equal(store.medusaExchanges.facts(x.exchange_id).find((f) => f.fact === 'read').actor, 'unverified-reader');
    });

    it('follows a send the Hub delivered to a refreshed handle', () => {
      const intent = sendPmToBuilder({}, null);
      const bound = mx.bindHubId(intent.exchange_id, 'hub-1', { deliveredTo: 'builder-ws-new' });
      assert.equal(bound.recipient_workspace_id, 'builder-ws-new');
      assertReplayMatches(intent.exchange_id);
    });

    it('marks a no-reply message acknowledged in the dashboard as closed by the dashboard, not by the agent', () => {
      const x = sendPmToBuilder();
      mx.recordAcknowledged(['hub-1'], { kind: 'operator-ui' });
      assert.equal(store.medusaExchanges.get(x.exchange_id).terminal_code, 'acknowledged-in-dashboard');
    });

    it('refuses a reply to a message that was not addressed to the replier', () => {
      sendPmToBuilder();
      const other = { kind: 'project', projectId: 30 };
      assert.throws(() => mx.createSendIntent({
        meta: mx.validateSendMeta({ inReplyTo: 'hub-1' }, other, 30),
        sender: { projectId: 30 }, recipient: { workspaceId: 'pm-ws' }
      }), { code: 'REPLY_TARGET_UNKNOWN', status: 404 });
    });
  });

  describe('arrivals no send on this host recorded', () => {
    it('records an unmatched arrival as untracked, never guessing a match', () => {
      const a = mx.recordArrival({ hubId: 'hub-x', recipientWorkspaceId: 'builder-ws', senderWorkspaceId: 'remote-ws' });
      assert.equal(a.origin, 'arrival');
      assert.equal(a.state, 'untracked');
      assert.equal(store.medusaExchanges.listOpen().length, 0, 'untracked arrivals are never watched');
    });

    it('lets a send adopt an arrival that beat the Hub answer back', () => {
      const intent = sendPmToBuilder({ priority: 'blocking' }, null);
      const arrival = mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws', senderWorkspaceId: 'pm-ws' });
      mx.recordRead(['hub-1']);
      const bound = mx.bindHubId(intent.exchange_id, 'hub-1');
      assert.equal(bound.state, 'read');
      const adopted = store.medusaExchanges.get(arrival.exchange_id);
      assert.equal(adopted.terminal_code, 'adopted-by-send');
      assertReplayMatches(intent.exchange_id);
      // Later recipient facts land on the send.
      mx.recordAcknowledged(['hub-1'], BUILDER);
      assert.equal(store.medusaExchanges.get(intent.exchange_id).state, 'acknowledged');
    });

    it('never gives a control notice or a system message a row', () => {
      store.control.insertReceipt({ event_id: 'evt_1', fact: 'notify_attempted', outcome_code: 'sent', actor_principal: 'system', notice_ref: 'hub-ctl' });
      assert.equal(mx.recordArrival({ hubId: 'hub-ctl', recipientWorkspaceId: 'builder-ws' }), null);
      assert.equal(mx.recordArrival({ hubId: 'hub-sys', recipientWorkspaceId: 'builder-ws', senderWorkspaceId: 'system' }), null);
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM medusa_exchanges').get().n, 0);
    });
  });

  describe('close', () => {
    it('lets only the verified initiator or the operator close', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      assert.throws(() => mx.close(x.exchange_id, UNBOUND), { code: 'EXCHANGE_BINDING_REQUIRED', status: 403 });
      assert.throws(() => mx.close(x.exchange_id, BUILDER), { code: 'NOT_INITIATOR', status: 403 });
      const closed = mx.close(x.exchange_id, PM);
      assert.equal(closed.state, 'closed');
      assert.equal(closed.terminal_by, 'project:10');
      assert.equal(mx.close(x.exchange_id, PM).exchange_id, x.exchange_id, 'closing twice is idempotent');
      const y = sendPmToBuilder({ priority: 'blocking' }, 'hub-2');
      assert.equal(mx.close(y.exchange_id, AMBIENT).terminal_by, 'operator');
    });
  });

  describe('retract (R19; the route belongs to #1873)', () => {
    it('retracts an unread message as a durable tombstone', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      const r = mx.retract('hub-1', PM, { reason: 'superseded', replacementHubId: 'hub-2' });
      assert.equal(r.state, 'retracted');
      assert.equal(r.replacement_hub_id, 'hub-2');
      assert.equal(r.terminal_code, 'superseded');
      assert.ok(store.medusaExchanges.get(x.exchange_id), 'the row stays');
      assert.equal(mx.retract('hub-1', PM, { reason: 'superseded' }).state, 'retracted', 'a duplicate retract is idempotent');
    });

    it('refuses once the message has been read, acknowledged or closed', () => {
      sendPmToBuilder();
      mx.recordRead(['hub-1']);
      assert.throws(() => mx.retract('hub-1', PM, { reason: 'superseded' }), { code: 'NOT_RETRACTABLE', status: 409 });
      sendPmToBuilder({}, 'hub-2');
      mx.recordAcknowledged(['hub-2'], BUILDER);
      assert.throws(() => mx.retract('hub-2', PM, { reason: 'superseded' }), { code: 'NOT_RETRACTABLE' });
    });

    it('lets exactly one of a racing read and retract win, and keeps a late read as audit only', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.retract('hub-1', PM, { reason: 'sent-in-error' });
      mx.recordRead(['hub-1']);
      mx.recordAcknowledged(['hub-1'], BUILDER);
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'retracted');
      const kinds = store.medusaExchanges.facts(x.exchange_id).map((f) => f.fact);
      assert.ok(kinds.includes('read') && kinds.includes('acknowledged'), 'late facts are kept for audit');
      assertReplayMatches(x.exchange_id);
    });

    it('refuses a non-initiator, an unknown reason, and any control notice', () => {
      sendPmToBuilder();
      assert.throws(() => mx.retract('hub-1', BUILDER, { reason: 'superseded' }), { code: 'NOT_INITIATOR' });
      assert.throws(() => mx.retract('hub-1', PM, { reason: 'because' }), { code: 'REASON_INVALID' });
      store.control.insertReceipt({ event_id: 'evt_1', fact: 'notify_attempted', outcome_code: 'sent', actor_principal: 'system', notice_ref: 'hub-ctl' });
      assert.throws(() => mx.retract('hub-ctl', OPERATOR, { reason: 'superseded' }), { code: 'CONTROL_NOT_RETRACTABLE', status: 409 });
    });
  });

  describe('retired recipients', () => {
    it('ends every open exchange to a retired workspace and leaves ended ones alone', () => {
      const open = sendPmToBuilder({ priority: 'blocking' });
      const done = sendPmToBuilder({}, 'hub-2');
      mx.recordAcknowledged(['hub-2'], BUILDER);
      const ended = mx.markRecipientRetired('builder-ws');
      assert.deepEqual(ended.map((r) => r.exchange_id), [open.exchange_id]);
      assert.equal(store.medusaExchanges.get(open.exchange_id).state, 'recipient_retired');
      assert.equal(store.medusaExchanges.get(done.exchange_id).state, 'closed');
    });
  });

  describe('wake and escalation facts', () => {
    it('takes the wake state from the newest wake fact and carries the persisted next-eligible time', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      mx.recordWakeFact('hub-1', 'wake_blocked', { code: 'pane-composer-has-input' });
      advance(1000);
      mx.recordWakeFact('hub-1', 'wake_attempted', { detail: { nonce: 'n1', nextEligibleAt: '2026-09-25T12:03:00.000Z' } });
      mx.recordWakeFact('hub-1', 'rearmed', { detail: { nextEligibleAt: '2026-09-25T12:05:00.000Z' } });
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'wake_attempted');
      assert.equal(row.rearm_count, 1);
      assert.equal(row.next_eligible_at, '2026-09-25T12:05:00.000Z');
      mx.recordEscalationFact(x.exchange_id, 'escalation_queued', { code: 'blocking-unread' });
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'escalated');
      assertReplayMatches(x.exchange_id);
    });
  });

  describe('storage', () => {
    it('refuses to update or delete a fact', () => {
      const x = sendPmToBuilder();
      const db = store.getDb();
      assert.throws(() => db.prepare("UPDATE medusa_exchange_facts SET fact = 'closed' WHERE exchange_id = ?").run(x.exchange_id), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM medusa_exchange_facts WHERE exchange_id = ?').run(x.exchange_id), /append-only/);
    });

    it('stamps timestamps from server time', () => {
      const x = sendPmToBuilder();
      assert.equal(x.created_at, '2026-09-25T12:00:00.000Z');
    });
  });
});
