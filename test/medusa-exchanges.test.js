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
const MASTER = { kind: 'master' };

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
 * Record a send from the Builder to the Master and bind its Hub id. The
 * Master has no project, so its recipient facts are `projectId: null` (#1988).
 * `sessionId: null` matches `localParticipant`'s real resolution for the
 * Master (its registry candidate carries no session record), so the reply
 * match in `createSendIntent` is proven against what production actually
 * writes, not a session id the Master happens to share with itself.
 * @param {object} [body] - Send body
 * @param {string} [hubId] - Hub id to bind
 * @returns {object} The exchange row
 */
function sendBuilderToMaster(body = {}, hubId = 'hub-to-master') {
  const meta = mx.validateSendMeta(body, BUILDER, 20);
  const x = mx.createSendIntent({
    meta,
    sender: { projectId: 20, sessionId: 2, workspaceId: 'builder-ws' },
    recipient: { workspaceId: 'master-ws', projectId: null, sessionId: null }
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
    mx._setRetention();
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

    it("lets the Project Master's own verified launch reply, without granting it blocking priority (#1988)", () => {
      // The Master has no project, so it can never be a `boundSender` — the
      // REPLY_TARGET_UNKNOWN fix needed its own narrow recognition
      // (`_isVerifiedMaster`), kept separate so it does not also unlock the
      // elevated priorities `boundSender` gates.
      const m = mx.validateSendMeta({ inReplyTo: 'hub-1' }, MASTER, null);
      assert.equal(m.inReplyTo, 'hub-1');
      assert.equal(m.verified, true);
      assert.equal(m.proof, 'launch');
      assert.throws(() => mx.validateSendMeta({ priority: 'blocking' }, MASTER, null), { code: 'PRIORITY_BINDING_REQUIRED', status: 403 });
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

    it('keeps a declared component\'s request id prefix for that component alone', () => {
      mx.declareSystemOwner('test-component', { requestIdPrefix: 'testc:' });
      const recipient = { workspaceId: 'builder-ws', projectId: 20 };
      const count = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM medusa_exchanges').get().n;
      const reserved = (err) => err.code === 'REQUEST_ID_RESERVED' && err.status === 400;
      // A project session, verified or not, cannot make an exchange under it.
      assert.throws(() => mx.createSendIntent({ meta: mx.validateSendMeta({ requestId: 'testc:route-1:send1' }, PM, 10), sender: { projectId: 10, sessionId: 1 }, recipient }), reserved);
      assert.throws(() => mx.createSendIntent({ meta: mx.validateSendMeta({ requestId: 'testc:' }, PM, 10), sender: { projectId: 10 }, recipient }), reserved);
      // Nor can TangleClaw itself from another listener, nor a session whose number is written like the name.
      const system = mx.validateSendMeta({ requestId: 'testc:route-1:send1' }, { kind: 'system' }, null);
      assert.throws(() => mx.createSendIntent({ meta: system, sender: { projectId: null, sessionId: 'another-component' }, recipient }), reserved);
      assert.throws(() => mx.createSendIntent({ meta: system, sender: { projectId: 10, sessionId: 'test-component' }, recipient }), reserved);
      assert.equal(count(), 0, 'none of those was recorded');
      // The component itself can, and what it makes is its own.
      const own = mx.createSendIntent({ meta: system, sender: { projectId: null, sessionId: 'test-component' }, recipient });
      assert.equal(mx.systemOwnerOf(own), 'test-component');
      assert.equal(mx.reservedOwnerOf('testc:anything'), 'test-component');
      // An id that merely contains the prefix, or shares its first letters, is anybody's.
      assert.equal(mx.reservedOwnerOf('x-testc:1'), null);
      assert.equal(mx.reservedOwnerOf('testcase-7'), null);
      mx.createSendIntent({ meta: mx.validateSendMeta({ requestId: 'testcase-7' }, PM, 10), sender: { projectId: 10 }, recipient });
      assert.equal(count(), 2);
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
      assert.equal(mx.recordRead(['hub-1'], 'builder-ws'), 1);
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'read');
      assert.equal(mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER), 1);
      const done = store.medusaExchanges.get(x.exchange_id);
      assert.equal(done.state, 'closed');
      assert.equal(done.terminal_code, 'acknowledged');
      assertReplayMatches(x.exchange_id);
    });

    it('advances the same exchange idempotently across redelivery, reconnect and repeated reads', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      mx.recordRead(['hub-1'], 'builder-ws');
      assert.equal(mx.recordRead(['hub-1'], 'builder-ws'), 0);
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
      mx.recordRead(['hub-1'], 'builder-ws');
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER);
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'replied');
      assert.equal(mx.view(row).label, 'satisfied, awaiting initiator close');
      assert.equal(row.terminal_at, null, 'a reply-required exchange stays open for its initiator to close');
      assertReplayMatches(x.exchange_id);
    });

    it('records an operator-ui acknowledgement as such and leaves a reply-required exchange unsatisfied', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordAcknowledged(['hub-1'], 'builder-ws', { kind: 'operator-ui' });
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'acknowledged');
      assert.equal(row.terminal_at, null);
      const ack = store.medusaExchanges.facts(x.exchange_id).find((f) => f.fact === 'acknowledged');
      assert.equal(ack.actor, 'operator-ui');
    });

    it('still records the agent acknowledging after the dashboard did', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordAcknowledged(['hub-1'], 'builder-ws', { kind: 'operator-ui' });
      assert.equal(mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER), 1);
      assert.equal(mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER), 0, 'the same actor twice adds nothing');
      const actors = store.medusaExchanges.facts(x.exchange_id).filter((f) => f.fact === 'acknowledged').map((f) => f.actor);
      assert.deepEqual(actors, ['operator-ui', 'recipient']);
    });

    it('records an unproven reader as unverified, never as the recipient', () => {
      const x = sendPmToBuilder();
      mx.recordRead(['hub-1'], 'builder-ws', UNBOUND);
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
      mx.recordAcknowledged(['hub-1'], 'builder-ws', { kind: 'operator-ui' });
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

    it("lets the Master's verified launch reply to a message addressed to it (#1988)", () => {
      // Before the fix, `recipient_project_id == null` (the Master's shape)
      // threw unconditionally, regardless of who the sender actually was.
      const original = sendBuilderToMaster();
      const reply = mx.createSendIntent({
        meta: mx.validateSendMeta({ inReplyTo: 'hub-to-master' }, MASTER, null),
        sender: { projectId: null, sessionId: 'master', workspaceId: 'master-ws' },
        recipient: { workspaceId: 'builder-ws', projectId: 20 }
      });
      assert.equal(reply.in_reply_to, original.exchange_id);
    });

    it("records the Master's own reply as actor 'master' on both the send and the original's replied fact", () => {
      const original = sendBuilderToMaster();
      const reply = mx.createSendIntent({
        meta: mx.validateSendMeta({ inReplyTo: 'hub-to-master' }, MASTER, null),
        sender: { projectId: null, sessionId: 'master', workspaceId: 'master-ws' },
        recipient: { workspaceId: 'builder-ws', projectId: 20 }
      });
      const sendFact = store.medusaExchanges.facts(reply.exchange_id).find((f) => f.fact === 'send_pending');
      assert.equal(sendFact.actor, 'master');
      mx.bindHubId(reply.exchange_id, 'hub-master-reply', { hubStatus: 'received' });
      const repliedFact = store.medusaExchanges.facts(original.exchange_id).find((f) => f.fact === 'replied');
      assert.equal(repliedFact.actor, 'master');
    });

    it('refuses the Master a reply to a message that was not addressed to it (#1988)', () => {
      sendPmToBuilder(); // addressed to the Builder's project, not the Master
      assert.throws(() => mx.createSendIntent({
        meta: mx.validateSendMeta({ inReplyTo: 'hub-1' }, MASTER, null),
        sender: { projectId: null, sessionId: 'master' }, recipient: { workspaceId: 'pm-ws' }
      }), { code: 'REPLY_TARGET_UNKNOWN', status: 404 });
    });

    it('still refuses a forged null-project reply that was never verified (#1988 defense in depth)', () => {
      // `validateSendMeta` is the only path that can set `meta.verified: true`
      // for a null-project sender (operator-on-the-Master's-mount or the
      // Master itself), so this bypasses it to prove the null==null match in
      // `createSendIntent` is not a blanket allowance for any unverified caller
      // that merely claims a null project id.
      sendBuilderToMaster();
      assert.throws(() => mx.createSendIntent({
        meta: {
          priority: 'normal', replyRequired: false, escalateAfterMs: null, reasonCode: null,
          inReplyTo: 'hub-to-master', requestId: 'send:forged', verified: false, proof: null
        },
        sender: { projectId: null, sessionId: 'not-the-master', workspaceId: 'impostor-ws' },
        recipient: { workspaceId: 'builder-ws', projectId: 20 }
      }), { code: 'REPLY_TARGET_UNKNOWN', status: 404 });
    });
  });

  describe('recipient facts are scoped to the recipient', () => {
    it('records nothing when a participant reports mail addressed to someone else', () => {
      const x = sendPmToBuilder();
      assert.equal(mx.recordRead(['hub-1'], 'pm-ws', PM), 0);
      assert.equal(mx.recordAcknowledged(['hub-1'], 'pm-ws', PM), 0);
      assert.equal(mx.recordAcknowledged(['hub-1'], null, UNBOUND), 0);
      assert.equal(mx.recordWakeForRecipient('pm-ws', 'wake_attempted', { code: 'tmux' }), 0);
      assert.deepEqual(store.medusaExchanges.facts(x.exchange_id).map((f) => f.fact), ['send_pending', 'hub_accepted']);
    });
  });

  describe('untracked exchanges still show what is known', () => {
    const remote = () => mx.createSendIntent({
      meta: mx.validateSendMeta({}, PM, 10), sender: { projectId: 10 }, recipient: { workspaceId: 'remote-ws' }, tracking: 'untracked'
    });

    it('shows a lost Hub answer as send_unknown, and a refusal as undeliverable, idempotently', () => {
      assert.equal(mx.markSendUnknown(remote().exchange_id, 'bridge-unreachable').state, 'send_unknown');
      const r = remote();
      assert.equal(mx.markSendRefused(r.exchange_id, 'hub-refused').state, 'undeliverable');
      assert.equal(mx.markSendRefused(r.exchange_id, 'hub-refused').state, 'undeliverable');
      assertReplayMatches(r.exchange_id);
    });

    it('reads as untracked once the Hub has it', () => {
      const r = remote();
      assert.equal(mx.bindHubId(r.exchange_id, 'hub-r').state, 'untracked');
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
      mx.recordRead(['hub-1'], 'builder-ws');
      const bound = mx.bindHubId(intent.exchange_id, 'hub-1');
      assert.equal(bound.state, 'read');
      const adopted = store.medusaExchanges.get(arrival.exchange_id);
      assert.equal(adopted.terminal_code, 'adopted-by-send');
      assertReplayMatches(intent.exchange_id);
      // Later recipient facts land on the send.
      mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER);
      assert.equal(store.medusaExchanges.get(intent.exchange_id).state, 'acknowledged');
    });

    it('closes a no-reply send whose early arrival was already acknowledged when it adopts it', () => {
      const intent = sendPmToBuilder({ priority: 'blocking', replyRequired: false }, null);
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws', senderWorkspaceId: 'pm-ws' });
      mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER);
      const bound = mx.bindHubId(intent.exchange_id, 'hub-1');
      assert.equal(bound.state, 'closed');
      assert.equal(bound.terminal_code, 'acknowledged');
      assert.equal(store.medusaExchanges.countOpenBlockingForSender(10), 0, 'it no longer counts toward the blocking limit');
      assertReplayMatches(intent.exchange_id);
    });

    it('marks a send send_unknown when the Hub id cannot be stored', () => {
      const intent = sendPmToBuilder({}, null);
      assert.equal(mx.bindHubId(intent.exchange_id, 'not a valid id!').state, 'send_unknown');
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

    /**
     * Record a send from the Project Master to the Builder: no sending project,
     * from the Master's listener key, as its unbound send route records it.
     * @param {object} [opts]
     * @param {string|null} [opts.hubId] - Hub id to bind, or null to leave it unbound
     * @param {object} [opts.caller] - The send's caller (SYSTEM makes it TangleClaw's own)
     * @returns {object} The exchange row
     */
    function sendMasterToBuilder({ hubId = 'hub-m1', caller = UNBOUND } = {}) {
      const x = mx.createSendIntent({
        meta: mx.validateSendMeta({}, caller, null),
        sender: { projectId: null, sessionId: 'master', workspaceId: 'master-ws' },
        recipient: { workspaceId: 'builder-ws', projectId: 20, sessionId: 2 }
      });
      return hubId ? mx.bindHubId(x.exchange_id, hubId, { hubStatus: 'received' }) : x;
    }

    it('lets the verified Master close what it sent, an orphaned send_unknown row included, as the initiator', () => {
      const orphan = mx.markSendUnknown(sendMasterToBuilder({ hubId: null }).exchange_id, 'bridge-unreachable');
      assert.equal(orphan.hub_id, null);
      const closed = mx.close(orphan.exchange_id, MASTER);
      assert.equal(closed.state, 'closed');
      assert.equal(closed.terminal_by, 'master');
      assert.equal(closed.terminal_code, 'initiator-closed');
      const fact = store.medusaExchanges.facts(orphan.exchange_id).find((f) => f.fact === 'closed');
      assert.equal(fact.actor, 'master');
      assert.equal(fact.proof, 'launch');
      assert.equal(mx.close(sendMasterToBuilder().exchange_id, MASTER).state, 'closed', 'a Hub-bound Master send closes too');
      assertReplayMatches(orphan.exchange_id);
    });

    it('refuses the Master a project\'s exchange and TangleClaw\'s own system send', () => {
      const projects = sendPmToBuilder();
      assert.throws(() => mx.close(projects.exchange_id, MASTER), { code: 'NOT_INITIATOR', status: 403 });
      const system = sendMasterToBuilder({ hubId: 'hub-sys-1', caller: SYSTEM });
      assert.ok(mx.isSystemOrigin(system), 'the fixture is a system send');
      assert.throws(() => mx.close(system.exchange_id, MASTER), { code: 'NOT_INITIATOR', status: 403 });
    });

    it('still refuses an unbound caller and a project the close of a Master send', () => {
      const x = sendMasterToBuilder();
      assert.throws(() => mx.close(x.exchange_id, UNBOUND), { code: 'EXCHANGE_BINDING_REQUIRED', status: 403 });
      assert.throws(() => mx.close(x.exchange_id, PM), { code: 'NOT_INITIATOR', status: 403 });
      assert.equal(store.medusaExchanges.get(x.exchange_id).terminal_at, null);
    });
  });

  describe('listOpenForRecipient hubBoundOnly', () => {
    it('leaves out a send that never bound a Hub id only when asked, so the retired-recipient sweep still sees it', () => {
      const unbound = mx.markSendUnknown(sendPmToBuilder({}, null).exchange_id, 'hub-timeout');
      const bound = sendPmToBuilder({}, 'hub-2');
      const all = store.medusaExchanges.listOpenForRecipient('builder-ws').map((x) => x.exchange_id);
      assert.deepEqual(all.sort(), [unbound.exchange_id, bound.exchange_id].sort());
      const owed = store.medusaExchanges.listOpenForRecipient('builder-ws', { hubBoundOnly: true }).map((x) => x.exchange_id);
      assert.deepEqual(owed, [bound.exchange_id]);
      const ended = mx.markRecipientRetired('builder-ws').map((x) => x.exchange_id);
      assert.ok(ended.includes(unbound.exchange_id), 'the sweep still ends the unbound row');
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
      mx.recordRead(['hub-1'], 'builder-ws');
      assert.throws(() => mx.retract('hub-1', PM, { reason: 'superseded' }), { code: 'NOT_RETRACTABLE', status: 409 });
      sendPmToBuilder({}, 'hub-2');
      mx.recordAcknowledged(['hub-2'], 'builder-ws', BUILDER);
      assert.throws(() => mx.retract('hub-2', PM, { reason: 'superseded' }), { code: 'NOT_RETRACTABLE' });
    });

    it('lets exactly one of a racing read and retract win, and keeps a late read as audit only', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.retract('hub-1', PM, { reason: 'sent-in-error' });
      mx.recordRead(['hub-1'], 'builder-ws');
      mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER);
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
      mx.recordAcknowledged(['hub-2'], 'builder-ws', BUILDER);
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
      mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-composer-has-input' });
      advance(1000);
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { detail: { nonce: 'n1', nextEligibleAt: '2026-09-25T12:03:00.000Z' } });
      assert.throws(() => mx.recordWakeForRecipient('builder-ws', 'rearmed'), /not a wake fact/, 're-arms go only through rearm()');
      assert.equal(mx.rearm(x.exchange_id, { expectRearmCount: 0, nextEligibleAt: '2026-09-25T12:05:00.000Z' }), null,
        'no trigger, no re-arm: elapsed time is never one');
      mx.recordWakeForRecipient('builder-ws', 'wake_not_accepted', { code: 'nonce-in-composer', attemptNonce: 'n1' });
      assert.ok(mx.rearm(x.exchange_id, { expectRearmCount: 0, nextEligibleAt: '2026-09-25T12:05:00.000Z' }));
      assert.equal(mx.rearm(x.exchange_id, { expectRearmCount: 0, nextEligibleAt: '2026-09-25T12:05:00.000Z' }), null,
        'a second re-arm before the next attempt is refused');
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'wake_pending', 'a re-arm leaves the message waiting on the next wake');
      assert.equal(row.wake_code, 'rearmed');
      assert.equal(row.rearm_count, 1);
      assert.equal(row.next_eligible_at, '2026-09-25T12:05:00.000Z');
      mx.recordEscalationFact(x.exchange_id, 'escalation_queued', { code: 'blocking-unread' });
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'none', 'a notice fact does not move the ladder');
      mx.recordEscalationFact(x.exchange_id, 'escalated', { code: 'blocking-unread' });
      assert.equal(store.medusaExchanges.get(x.exchange_id).esc_level, 'escalated');
      assertReplayMatches(x.exchange_id);
    });
  });

  describe('recipient-wide wake facts', () => {
    it('records an unchanged blocked verdict once, however often it is reported, and every attempt', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      assert.equal(mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-turn-in-flight' }), 1);
      assert.equal(mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-turn-in-flight' }), 0);
      assert.equal(mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-composer-has-input' }), 1, 'a new reason is a change');
      assert.equal(mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux' }), 1);
      assert.equal(mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux' }), 1, 'each attempt is its own fact');
      assert.equal(store.medusaExchanges.facts(x.exchange_id).filter((f) => f.fact.startsWith('wake_')).length, 4);
    });

    it('concerns only unread mail to that workspace', () => {
      sendPmToBuilder({}, 'hub-1');
      mx.recordRead(['hub-1'], 'builder-ws', BUILDER);
      assert.equal(mx.pendingWakeCount('builder-ws'), 0);
      assert.equal(mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux' }), 0);
      assert.equal(mx.recordWakeForRecipient('pm-ws', 'wake_attempted', { code: 'tmux' }), 0);
    });
  });

  describe('a re-arm is taken once per count (#2086)', () => {
    it('a caller holding a stale count re-arms nothing, though the trigger is valid', () => {
      const x = sendPmToBuilder({}, 'hub-1');
      mx.recordArrival({ hubId: 'hub-1', recipientWorkspaceId: 'builder-ws' });
      const miss = (nonce) => {
        mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce } });
        mx.recordWakeForRecipient('builder-ws', 'wake_not_accepted', { code: 'nonce-in-composer', detail: { nonce }, attemptNonce: nonce });
      };
      miss('n1');
      assert.equal(mx.rearm(x.exchange_id, { expectRearmCount: 1, nextEligibleAt: '2026-09-25T12:05:00.000Z' }), null, 'a count it has not reached');
      assert.ok(mx.rearm(x.exchange_id, { expectRearmCount: 0, nextEligibleAt: '2026-09-25T12:05:00.000Z' }));
      miss('n2');
      // A second pass that read the row before the first re-arm still holds count 0.
      assert.equal(mx.rearm(x.exchange_id, { expectRearmCount: 0, nextEligibleAt: '2026-09-25T12:09:00.000Z' }), null);
      assert.equal(store.medusaExchanges.get(x.exchange_id).rearm_count, 1);
      assert.ok(mx.rearm(x.exchange_id, { expectRearmCount: 1, nextEligibleAt: '2026-09-25T12:09:00.000Z' }));
      assert.equal(store.medusaExchanges.get(x.exchange_id).rearm_count, 2);
    });
  });

  describe('whether an inbox has been nudged already, by each message\'s own id (#2086)', () => {
    /** A delivered message to the Builder, optionally nudged. */
    const delivered = (hubId, { nudged = true } = {}) => {
      const x = sendPmToBuilder({}, hubId);
      mx.recordArrival({ hubId, recipientWorkspaceId: 'builder-ws' });
      if (nudged) mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce: `n-${hubId}` } });
      return x;
    };

    it('a nudged message is owned, and stays owned once it has been fetched', () => {
      delivered('hub-1');
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), true);
      mx.recordRead(['hub-1'], 'builder-ws', BUILDER);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), true, 'reading it is not a reason to nudge again');
      mx.recordAcknowledged(['hub-1'], 'builder-ws', BUILDER);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), true, 'nor is a redelivery of mail already handled');
    });

    it('a message the recipient fetched or handled is owned though it was never nudged', () => {
      delivered('hub-1', { nudged: false });
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), false, 'neither nudged nor read');
      mx.recordRead(['hub-1'], 'builder-ws', BUILDER);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), true, 'a read on record is enough');
      assert.equal(store.medusaExchanges.facts(store.medusaExchanges.getByHubId('hub-1', 'send').exchange_id)
        .filter((f) => f.fact === 'wake_attempted').length, 0);

      delivered('hub-2', { nudged: false });
      mx.recordAcknowledged(['hub-2'], 'builder-ws', BUILDER);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-2']), true, 'so is an acknowledgement with no read before it');
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1', 'hub-2']), true);
    });

    it('a look from the dashboard is not a read, so it owns nothing', () => {
      delivered('hub-1', { nudged: false });
      assert.equal(mx.recordRead(['hub-1'], 'builder-ws', { kind: 'operator-ui' }), 0);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), false);
    });

    it('a read of one message vouches for that message only', () => {
      delivered('hub-1', { nudged: false });
      delivered('hub-2', { nudged: false });
      mx.recordRead(['hub-1'], 'builder-ws', BUILDER);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1', 'hub-2']), false);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-2']), false);
    });

    it('new mail is never hidden behind old: one message never nudged makes the answer no', () => {
      delivered('hub-1');
      mx.recordRead(['hub-1'], 'builder-ws', BUILDER);
      delivered('hub-2', { nudged: false });
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1', 'hub-2']), false);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-2']), false);
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce: 'n-2' } });
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1', 'hub-2']), true);
    });

    it('owned mail elsewhere does not vouch for a message: handled or replied rows are not counted in', () => {
      delivered('hub-1');
      delivered('hub-2');
      mx.recordAcknowledged(['hub-1', 'hub-2'], 'builder-ws', BUILDER);
      delivered('hub-3', { nudged: false });
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-3']), false, 'two handled rows do not account for one new message');
    });

    it('a re-armed message is not owned: the monitor is meant to try again', () => {
      const x = delivered('hub-1');
      mx.recordWakeForRecipient('builder-ws', 'wake_not_accepted', { code: 'nonce-in-composer', detail: { nonce: 'n-hub-1' }, attemptNonce: 'n-hub-1' });
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), true, 'a miss alone waits for the watchdog');
      assert.ok(mx.rearm(x.exchange_id, { expectRearmCount: 0, nextEligibleAt: '2026-09-25T12:05:00.000Z' }));
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1']), false);
    });

    it('fails conservative on anything it cannot vouch for', () => {
      delivered('hub-1');
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1', 'hub-unknown']), false, 'a message with no exchange');
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-1', null]), false, 'a message with no id');
      assert.equal(mx.alreadyAttempted('builder-ws', []), false, 'an empty inbox proves nothing');
      assert.equal(mx.alreadyAttempted('builder-ws', undefined), false);
      assert.equal(mx.alreadyAttempted('builder-ws', 1), false, 'a count is not an identity');
      assert.equal(mx.alreadyAttempted('someone-else-ws', ['hub-1']), false, 'mail addressed to another workspace');
      assert.equal(mx.alreadyAttempted(null, ['hub-1']), false);
    });

    it('an untracked exchange is never owned: no nudge is ever recorded on it', () => {
      const x = mx.createSendIntent({
        meta: mx.validateSendMeta({}, PM, 10),
        sender: { projectId: 10, sessionId: 1, workspaceId: 'pm-ws' },
        recipient: { workspaceId: 'builder-ws' },
        tracking: 'untracked'
      });
      mx.bindHubId(x.exchange_id, 'hub-u', { hubStatus: 'received' });
      // A nudge of the workspace is recorded on tracked exchanges only, so an
      // untracked one never has an attempt to be owned by.
      assert.equal(mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce: 'n-u' } }), 0);
      assert.equal(mx.alreadyAttempted('builder-ws', ['hub-u']), false);
    });
  });

  describe('retention (#1879)', () => {
    it('never prunes an open exchange, however old', () => {
      const x = sendPmToBuilder({ priority: 'blocking' });
      advance(400 * 86400000);
      mx.pruneExchangeHistory();
      assert.ok(store.medusaExchanges.get(x.exchange_id), 'the open exchange survives');
      assert.ok(store.medusaExchanges.facts(x.exchange_id).length > 0, 'its facts survive too');
    });

    describe('untracked bucket', () => {
      it('keeps an untracked row that is young and within rank', () => {
        const a = mx.recordArrival({ hubId: 'hub-u1', recipientWorkspaceId: 'ghost-ws', senderWorkspaceId: 'remote-ws' });
        assert.ok(store.medusaExchanges.get(a.exchange_id));
      });

      it('prunes an untracked row once older than the age cap', () => {
        mx._setRetention({ untrackedMaxAgeMs: 1000 });
        const a = mx.recordArrival({ hubId: 'hub-u1', recipientWorkspaceId: 'ghost-ws', senderWorkspaceId: 'remote-ws' });
        advance(2000);
        mx.pruneExchangeHistory();
        assert.equal(store.medusaExchanges.get(a.exchange_id), null);
      });

      it('prunes the oldest untracked row once there are more than the rank cap, keeping the newest', () => {
        mx._setRetention({ untrackedMaxRows: 1 });
        const a = mx.recordArrival({ hubId: 'hub-u1', recipientWorkspaceId: 'ghost-ws', senderWorkspaceId: 'remote-ws' });
        advance(1000);
        const b = mx.recordArrival({ hubId: 'hub-u2', recipientWorkspaceId: 'ghost-ws', senderWorkspaceId: 'remote-ws' });
        assert.equal(store.medusaExchanges.get(a.exchange_id), null, 'the older row was pruned on the newer arrival');
        assert.ok(store.medusaExchanges.get(b.exchange_id), 'the newest row survives');
      });
    });

    describe('closed bucket', () => {
      it('prunes a closed exchange once older than the age cap', () => {
        mx._setRetention({ closedMaxAgeMs: 1000 });
        const x = sendPmToBuilder({}, 'hub-c1');
        mx.close(x.exchange_id, PM);
        advance(2000);
        mx.pruneExchangeHistory();
        assert.equal(store.medusaExchanges.get(x.exchange_id), null);
      });

      it('prunes past the per-project rank cap, independently of other recipient projects', () => {
        mx._setRetention({ closedMaxPerProject: 1 });
        const a = sendPmToBuilder({}, 'hub-c1');
        mx.close(a.exchange_id, PM);
        advance(1000);
        const b = sendPmToBuilder({}, 'hub-c2');
        mx.close(b.exchange_id, PM);
        assert.equal(store.medusaExchanges.get(a.exchange_id), null, 'the older closed row in the same project was pruned');
        assert.ok(store.medusaExchanges.get(b.exchange_id), 'the newest closed row in that project survives');

        // A different recipient project's own closed exchange is unaffected --
        // the rank cap is per `recipient_project_id`, never global.
        const meta = mx.validateSendMeta({}, PM, 10);
        const other = mx.createSendIntent({
          meta, sender: { projectId: 10, sessionId: 1, workspaceId: 'pm-ws' },
          recipient: { workspaceId: 'other-ws', projectId: 99, sessionId: 9 }
        });
        mx.bindHubId(other.exchange_id, 'hub-c3', { hubStatus: 'received' });
        mx.close(other.exchange_id, PM);
        assert.ok(store.medusaExchanges.get(other.exchange_id), 'a different project keeps its own newest closed row');
        assert.ok(store.medusaExchanges.get(b.exchange_id), 'closing the other project\'s exchange did not touch this one');
      });

      it('an escalated-then-closed exchange is a tombstone, not a closed row -- the closed cap never reaches it', () => {
        mx._setRetention({ closedMaxPerProject: 0 });
        const x = sendPmToBuilder({ priority: 'blocking' }, 'hub-esc');
        mx.recordEscalationFact(x.exchange_id, 'escalated', { code: 'blocking-unread' });
        mx.close(x.exchange_id, PM);
        assert.ok(store.medusaExchanges.get(x.exchange_id), 'an escalated-but-closed row survives a closedMaxPerProject of 0');
      });
    });

    describe('tombstone bucket', () => {
      it('outlives the closed bucket\'s much shorter age cap', () => {
        mx._setRetention({ closedMaxAgeMs: 1000 });
        const x = sendPmToBuilder({}, 'hub-r1');
        const r = mx.retract(x.hub_id, PM, { reason: 'superseded' });
        advance(2000);
        mx.pruneExchangeHistory();
        assert.ok(store.medusaExchanges.get(r.exchange_id), 'a tombstone is not subject to the closed bucket\'s cap');
      });

      it('prunes a retracted exchange once older than its own age cap', () => {
        mx._setRetention({ tombstoneMaxAgeMs: 1000 });
        const x = sendPmToBuilder({}, 'hub-r1');
        const r = mx.retract(x.hub_id, PM, { reason: 'superseded' });
        advance(2000);
        mx.pruneExchangeHistory();
        assert.equal(store.medusaExchanges.get(r.exchange_id), null);
      });

      it('prunes past the per-project tombstone rank cap, keeping the newest', () => {
        mx._setRetention({ tombstoneMaxPerProject: 1 });
        const a = sendPmToBuilder({}, 'hub-r1');
        mx.retract(a.hub_id, PM, { reason: 'superseded' });
        advance(1000);
        const b = sendPmToBuilder({}, 'hub-r2');
        const rb = mx.retract(b.hub_id, PM, { reason: 'superseded' });
        assert.equal(store.medusaExchanges.get(a.exchange_id), null, 'the older tombstone was pruned on the newer retraction');
        assert.ok(store.medusaExchanges.get(rb.exchange_id), 'the newest tombstone survives');
      });
    });

    describe('fact compaction', () => {
      it('leaves a small retained exchange\'s facts untouched', () => {
        const x = sendPmToBuilder({}, 'hub-small');
        mx.close(x.exchange_id, PM);
        assert.ok(store.medusaExchanges.facts(x.exchange_id).length <= 10, 'fixture sanity: at or under the compaction threshold');
        assert.ok(store.medusaExchanges.facts(x.exchange_id).some((f) => f.fact === 'send_pending'), 'nothing was compacted away');
      });

      it('thins a large exchange\'s intermediate wake facts, keeping first, last, escalation and the most recent wake fact', () => {
        const x = sendPmToBuilder({ priority: 'blocking' }, 'hub-w1');
        mx.recordArrival({ hubId: 'hub-w1', recipientWorkspaceId: 'builder-ws' });
        for (let i = 0; i < 8; i += 1) {
          advance(1000);
          mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: `attempt-${i}` });
        }
        mx.recordEscalationFact(x.exchange_id, 'escalated', { code: 'blocking-unread' });
        const before = store.medusaExchanges.facts(x.exchange_id);
        assert.ok(before.length > 10, 'fixture sanity: over the compaction threshold before closing');

        mx.close(x.exchange_id, PM); // _terminal() runs the sweep, including compaction, right after this

        const after = store.medusaExchanges.facts(x.exchange_id);
        const kinds = after.map((f) => f.fact);
        assert.equal(kinds[0], 'send_pending', 'the first fact survives');
        assert.equal(kinds.at(-1), 'closed', 'the last fact survives');
        assert.ok(kinds.includes('escalated'), 'the escalation fact survives');
        assert.equal(kinds.filter((k) => k === 'wake_attempted').length, 1, 'every wake fact but the most recent was dropped');
        assert.equal(after.find((f) => f.fact === 'wake_attempted').code, 'attempt-7', 'the SURVIVING wake fact is the most recent one');
        assert.ok(after.length < before.length, 'the exchange actually shrank');
        assertReplayMatches(x.exchange_id);

        const again = store.medusaExchanges.facts(x.exchange_id).length;
        mx.pruneExchangeHistory();
        assert.equal(store.medusaExchanges.facts(x.exchange_id).length, again, 'a second pass compacts nothing further');
      });
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
