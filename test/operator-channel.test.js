'use strict';

// The operator channel's delivery decisions, driven through its send seam: what
// each answer from the send path does to a waiting message, and in particular
// that nothing whose Hub outcome is unknown is ever sent a second time.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const logger = require('../lib/logger');
const { setLevel } = logger;

setLevel('error');

const store = require('../lib/store');
const operatorChannel = require('../lib/operator-channel');

describe('operator channel: delivery outcomes', () => {
  let tmpDir;
  let calls;
  let answers;
  let seq = 0;
  const saved = {};

  /**
   * Queue a pending message for project 1.
   * @returns {object} The inbound row
   */
  const queue = () => {
    seq += 1;
    return store.operatorChannel.insertInbound({
      external_id: `m${seq}`, author_id: 'u', space_id: 'g', channel_id: 'c', target_project_id: 1,
      text: 'hello', created_at: new Date().toISOString()
    }).row;
  };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-unit-'));
    store._setBasePath(tmpDir);
    store.init();
    const config = store.config.load();
    config.operatorChannel = { enabled: true };
    store.config.save(config);
    Object.assign(saved, operatorChannel._internal);
    operatorChannel._internal.liveTargetWorkspace = () => 'architect-0000abcd';
    operatorChannel._internal.sendTracked = async (input) => {
      calls.push(input);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    };
  });

  beforeEach(() => {
    calls = [];
    answers = [];
    for (const row of store.operatorChannel.listPendingInbound(500)) {
      store.operatorChannel.settleInbound(row.id, { state: 'failed', error: 'reset', at: new Date().toISOString() });
    }
  });

  after(() => {
    Object.assign(operatorChannel._internal, saved);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends as an unbound caller, normal priority, stamped, to the live target', async () => {
    const row = queue();
    answers.push({ status: 200, body: { id: 'hub-1', exchange: { exchangeId: 'mx_1' } } });
    await operatorChannel.pump();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].caller, { kind: 'unbound' });
    assert.equal(calls[0].senderProjectId, null);
    assert.equal(calls[0].body.to, 'architect-0000abcd');
    assert.equal(calls[0].body.priority, undefined, 'the channel never asks for a priority');
    assert.equal(calls[0].body.inReplyTo, undefined);
    assert.equal(calls[0].body.message, `${operatorChannel.STAMP} hello`);
    assert.equal(store.operatorChannel.getInbound(row.id).state, 'sent');
  });

  it('a send that throws keeps the message and its request id, and the retry meets the duplicate guard', async () => {
    const row = queue();
    answers.push(new Error('socket hang up'));
    await operatorChannel.pump();
    const after = store.operatorChannel.getInbound(row.id);
    assert.equal(after.state, 'pending');
    assert.equal(after.attempts, 0, 'an unknown outcome does not spend an attempt');

    answers.push({ status: 409, body: { code: 'SEND_ALREADY_ATTEMPTED', details: { exchangeId: 'mx_2' } } });
    await operatorChannel.pump();
    assert.equal(calls[1].body.requestId, calls[0].body.requestId, 'the retry reuses the request id');
    const settled = store.operatorChannel.getInbound(row.id);
    assert.equal(settled.state, 'send_unknown');
    assert.equal(settled.exchange_id, 'mx_2');
    assert.equal(settled.text, null);

    await operatorChannel.pump();
    assert.equal(calls.length, 2, 'a send_unknown message is never tried again');
  });

  it('a refusal on the message itself fails it', async () => {
    const row = queue();
    answers.push({ status: 400, body: { code: 'EXCHANGE_MALFORMED', error: 'to must be a workspace id' } });
    await operatorChannel.pump();
    const after = store.operatorChannel.getInbound(row.id);
    assert.equal(after.state, 'failed');
    assert.match(after.last_error, /EXCHANGE_MALFORMED/);
  });

  /**
   * The undelivered-message notices recorded for one inbound row.
   * @param {number} inboundId - Inbound row id
   * @returns {object[]}
   */
  const undeliveredNotices = (inboundId) => store.getDb().prepare(
    "SELECT * FROM operator_channel_outbound WHERE kind = 'notification' AND notify_type = 'message-undelivered' AND reply_to_inbound_id = ?"
  ).all(inboundId);

  it('tells the operator once, tied to their message, when a message fails', async () => {
    const row = queue();
    answers.push({ status: 400, body: { code: 'EXCHANGE_MALFORMED', error: 'to must be a workspace id' } });
    await operatorChannel.pump();
    const notices = undeliveredNotices(row.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].state, 'relayable');
    assert.equal(notices[0].idem_key, `message-undelivered:${row.id}`);
    assert.match(notices[0].text, /could not be delivered/);
    const listed = operatorChannel.listRelayable().find((i) => i.id === notices[0].id);
    assert.deepEqual(listed.inReplyTo, { messageId: row.external_id }, 'the helper can post it as a reply to the operator\'s message');
    assert.equal(listed.type, 'message-undelivered');
    await operatorChannel.pump();
    assert.equal(undeliveredNotices(row.id).length, 1, 'a failed message is reported once');
  });

  it('tells the operator when a message\'s Hub outcome is unknown, and not while it is only retrying', async () => {
    const row = queue();
    answers.push({ status: 502, body: { code: 'SEND_REJECTED', error: 'not found' } });
    await operatorChannel.pump();
    assert.equal(store.operatorChannel.getInbound(row.id).state, 'pending');
    assert.equal(undeliveredNotices(row.id).length, 0, 'a refusal that will be retried is not reported');
    answers.push({ status: 409, body: { code: 'SEND_ALREADY_ATTEMPTED', details: { exchangeId: 'mx_u' } } });
    await operatorChannel.pump();
    const notices = undeliveredNotices(row.id);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /may not have reached it/);
  });

  it('logs a settings change with its non-secret values, and never the token', () => {
    const lines = [];
    logger.setLevel('info');
    logger.setConsoleStream({ write: (line) => lines.push(line) });
    // Turned off, so the change starts no listener; the suite's own setting is put back after.
    try {
      operatorChannel.updateSettings({ enabled: false, allowlist: { authorId: 'u1', spaceId: 'g1', channelId: 'c1' } });
      operatorChannel.rotateToken();
    } finally {
      logger.setConsoleStream(null);
      logger.setLevel('error');
      const config = store.config.load();
      config.operatorChannel = { enabled: true };
      store.config.save(config);
    }
    const changed = lines.filter((l) => l.includes('Operator channel settings changed'));
    assert.equal(changed.length, 1);
    assert.match(changed[0], /enabled=false/);
    assert.match(changed[0], /"authorId":"u1"/);
    assert.match(changed[0], /"channelId":"c1"/);
    assert.doesNotMatch(changed[0], /targetProject/, 'only the fields the request set are named');
    assert.ok(!lines.some((l) => /ocsk_|tokenHash/.test(l)), 'no token or hash reaches the log');
  });

  it('waits without spending an attempt while the channel listener is down', async () => {
    const row = queue();
    answers.push({ status: 409, body: { code: 'NOT_LISTENING' } });
    await operatorChannel.pump();
    const after = store.operatorChannel.getInbound(row.id);
    assert.equal(after.state, 'pending');
    assert.equal(after.attempts, 0);
  });

  it('gives up on a message the Hub keeps refusing', async () => {
    const row = queue();
    for (let i = 0; i < operatorChannel.MAX_SEND_ATTEMPTS; i += 1) {
      answers.push({ status: 502, body: { code: 'SEND_REJECTED', error: 'not found', exchange: { exchangeId: `mx_r${i}`, state: 'undeliverable' } } });
      await operatorChannel.pump();
    }
    assert.equal(store.operatorChannel.getInbound(row.id).state, 'failed');
    assert.equal(new Set(calls.map((c) => c.body.requestId)).size, operatorChannel.MAX_SEND_ATTEMPTS, 'each refused attempt used its own request id');
  });

  it('recognises any channel token by its prefix, valid or not', () => {
    const req = (auth) => ({ headers: auth ? { authorization: auth } : {} });
    assert.equal(operatorChannel.presentsChannelToken(req('Bearer ocsk_anything')), true);
    assert.equal(operatorChannel.presentsChannelToken(req('Bearer tcsk_service')), false);
    assert.equal(operatorChannel.presentsChannelToken(req(null)), false);
  });

  it('applies the workload display-safety rule to chat text, with line breaks and tabs allowed', () => {
    assert.equal(operatorChannel.isSafeChannelText('line one\nline two\n\tindented'), true);
    for (const bad of ['ma\u200bin', 'a\u202Eb', 'a\u2028b', 'x\r\ny', 'a\u0007b', '\n\t\n', 'e\uFE0F']) {
      assert.equal(operatorChannel.isSafeChannelText(bad), false, JSON.stringify(bad));
    }
  });

  it('reads malformed settings as unset', () => {
    const s = operatorChannel.settings({ operatorChannel: { enabled: 'yes', targetProject: '  ', allowlist: { authorId: 'has space' }, tokenHash: 'short' } });
    assert.equal(s.enabled, false);
    assert.equal(s.targetProject, null);
    assert.equal(s.allowlist.authorId, null);
    assert.equal(s.tokenHash, null);
  });
});
