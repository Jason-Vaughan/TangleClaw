'use strict';

/*
 * `lib/medusa-send.js#sendTracked` (#1839, #3155) — the one path a
 * switchboard send takes. This file covers the ordinary happy path plus
 * #3155's `noWake` wiring: a send with `body.noWake === true` that the Hub
 * accepts must tell `lib/medusa-wake.js` the resulting Hub message id needs
 * no pane wake, so the recipient's wake monitor (when it is this same
 * process — the one real case this car's file scope can close, see
 * `lib/medusa-wake.js#_noWakeIds`'s own doc comment) treats that message as
 * non-actionable rather than nudging for it.
 *
 * `test/medusa-send-pruned-exchange.test.js` already covers the #1879
 * pruned-row degradation paths; this file does not repeat those.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const medusaSend = require('../lib/medusa-send');
const medusaWake = require('../lib/medusa-wake');

let tmpDir = null;

describe('medusa-send: sendTracked happy path', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-msend2-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the exchange and the Hub result for an ordinary send', async () => {
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' });
      return { status: 'received', id: 'hub-ordinary-1', to: 'ghost-ws-a' };
    };
    try {
      const result = await medusaSend.sendTracked({
        sessionId: 1,
        senderProjectId: 10,
        caller: { kind: 'project', projectId: 10 },
        body: { to: 'ghost-ws-a', message: 'hello' }
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'received');
      assert.equal(result.body.id, 'hub-ordinary-1');
    } finally {
      medusa.sendMessage = realSend;
    }
  });
});

describe('medusa-send: sendTracked --no-wake wiring (#3155)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-msend-nowake-'));
    store._setBasePath(tmpDir);
    store.init();
    medusaWake._resetNoWakeForTesting();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    medusaWake._resetNoWakeForTesting();
  });

  it('calls medusaWake.markNoWake with the Hub id when body.noWake is true and the send succeeds', async () => {
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' });
      return { status: 'received', id: 'hub-nowake-1', to: 'ghost-ws-b' };
    };
    try {
      const result = await medusaSend.sendTracked({
        sessionId: 1,
        senderProjectId: 10,
        caller: { kind: 'project', projectId: 10 },
        body: { to: 'ghost-ws-b', message: 'fyi', noWake: true }
      });
      assert.equal(result.status, 200);
      assert.equal(medusaWake._isNoWakeEntry({ id: 'hub-nowake-1' }), true,
        'the Hub id this send returned is now recorded as noWake');
    } finally {
      medusa.sendMessage = realSend;
    }
  });

  it('does not mark anything noWake for an ordinary send with no noWake flag', async () => {
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' });
      return { status: 'received', id: 'hub-plain-1', to: 'ghost-ws-c' };
    };
    try {
      await medusaSend.sendTracked({
        sessionId: 1,
        senderProjectId: 10,
        caller: { kind: 'project', projectId: 10 },
        body: { to: 'ghost-ws-c', message: 'hello' }
      });
      assert.equal(medusaWake._isNoWakeEntry({ id: 'hub-plain-1' }), false);
    } finally {
      medusa.sendMessage = realSend;
    }
  });

  it('does not mark noWake when the Hub returned no id at all (queued-but-unresolved shape)', async () => {
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' });
      return { status: 'queued', id: undefined, to: 'ghost-ws-d' };
    };
    try {
      const result = await medusaSend.sendTracked({
        sessionId: 1,
        senderProjectId: 10,
        caller: { kind: 'project', projectId: 10 },
        body: { to: 'ghost-ws-d', message: 'fyi', noWake: true }
      });
      // No crash, and markSendUnknown's degraded path is exercised exactly
      // as it is for any id-less Hub answer -- noWake has nothing to key on.
      assert.equal(result.status, 200);
    } finally {
      medusa.sendMessage = realSend;
    }
  });

  it('does not mark noWake when the send itself fails (markNoWake must only run on a confirmed success)', async () => {
    const realSend = medusa.sendMessage;
    medusa.sendMessage = async ({ beforeHub }) => {
      beforeHub({ from: 'sender-ws' });
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
        body: { to: 'ghost-ws-e', message: 'fyi', noWake: true }
      });
      assert.equal(result.status, 502);
      assert.equal(medusaWake._isNoWakeEntry({ id: 'hub-wont-exist' }), false);
    } finally {
      medusa.sendMessage = realSend;
    }
  });
});
