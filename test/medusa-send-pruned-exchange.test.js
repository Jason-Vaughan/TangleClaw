'use strict';

// #1879 regression (Critic finding, round 2): sendTracked()'s binding-failure
// catch block re-fetches the exchange row by id and hands it straight to
// exchanges.view() -- which throws on null. Before #1879 that row could never
// be gone (nothing pruned medusa_exchanges rows); the new retention sweep can
// now prune an untracked row between its insert and this catch running, so
// the re-fetch must tolerate a missing row rather than crash the response
// that is deliberately forced to succeed (the message is already on the Hub).

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

describe('medusa-send: binding-failure catch survives a pruned exchange (#1879)', () => {
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
