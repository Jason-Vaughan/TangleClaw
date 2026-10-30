'use strict';

// #1879 regression (Critic findings, rounds 2 and 3): sendTracked() has two
// catch blocks that touch the exchange row after an async gap -- the
// binding-failure catch (re-fetches by id, then exchanges.view()) and the
// Hub-failure catch (calls markSendUnknown/markSendRefused, which throw
// EXCHANGE_NOT_FOUND if the row is gone). Before #1879 neither row could ever
// be gone (nothing pruned medusa_exchanges rows); the new retention sweep can
// now prune an untracked row between its insert and either catch running --
// an untracked intent's own prune runs synchronously inside
// createSendIntent's beforeHub, before the Hub is even reached. Both catches
// must tolerate a missing row rather than crash the response that is
// deliberately forced to succeed (the message is already on the Hub, or the
// Hub's own answer is already final).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const exchanges = require('../lib/medusa-exchanges');
const medusaSend = require('../lib/medusa-send');

let tmpDir = null;

describe('medusa-send: a catch block survives a pruned exchange (#1879)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-msend-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    exchanges._setRetention();
  });

  it('degrades gracefully, omitting `exchange`, when retention prunes the row before the bind attempt', async () => {
    // An untracked row's own rank is always 1 right after insert, so a cap of
    // 0 prunes it immediately, inside createSendIntent's own hook -- before
    // this flow ever reaches the bind step below.
    exchanges._setRetention({ untrackedMaxRows: 0 });
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' });
      return { status: 'received', id: 'hub-pruned-1', to: 'ghost-ws' };
    };
    try {
      const result = await medusaSend.sendTracked({
        sessionId: 1,
        senderProjectId: 10,
        caller: { kind: 'project', projectId: 10 },
        body: { to: 'ghost-ws', message: 'hello' }
      });
      assert.equal(result.status, 200, 'the response still succeeds -- the message is already on the Hub');
      assert.equal(result.body.exchangeError, 'binding-failed');
      assert.equal('exchange' in result.body, false, 'nothing to report once the row is gone, but no crash either');
      assert.equal(result.body.id, 'hub-pruned-1', 'the Hub result itself still reaches the caller');
    } finally {
      medusa.sendMessage = realSend;
    }
  });

  it('a Hub-unknown outcome survives a pruned exchange too, omitting `exchange`', async () => {
    exchanges._setRetention({ untrackedMaxRows: 0 });
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' }); // creates + immediately prunes the untracked intent row
      const err = new Error('Message bridge unreachable: timeout');
      err.httpStatus = 502;
      err.code = 'BRIDGE_UNREACHABLE';
      err.hubOutcome = 'unknown';
      throw err;
    };
    try {
      const result = await medusaSend.sendTracked({
        sessionId: 1,
        senderProjectId: 10,
        caller: { kind: 'project', projectId: 10 },
        body: { to: 'ghost-ws-3', message: 'hello' }
      });
      assert.equal(result.status, 502);
      assert.equal(result.body.code, 'BRIDGE_UNREACHABLE');
      assert.equal('exchange' in result.body, false, 'nothing to report once the row is gone, but no crash either');
    } finally {
      medusa.sendMessage = realSend;
    }
  });

  it('still reports the exchange normally when retention leaves the row alone', async () => {
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' });
      return { status: 'received', id: 'hub-kept-1', to: 'ghost-ws-2' };
    };
    try {
      const result = await medusaSend.sendTracked({
        sessionId: 1,
        senderProjectId: 10,
        caller: { kind: 'project', projectId: 10 },
        body: { to: 'ghost-ws-2', message: 'hello' }
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.exchange.hubId, 'hub-kept-1', 'the exchange still reports normally when it was not pruned');
      assert.equal(result.body.exchangeError, undefined);
    } finally {
      medusa.sendMessage = realSend;
    }
  });
});
