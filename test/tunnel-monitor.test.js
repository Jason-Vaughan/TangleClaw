'use strict';

// #294 — periodic tunnel liveness + auto-recreate. Exercised through the
// `_internal` seam (injected roundTrip/ensure/listTunnels/getConn) and an
// injected `now`, so it's deterministic with no real timers, ssh, or sockets.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const mon = require('../lib/tunnel-monitor');

const conn = (over = {}) => ({
  id: 'c1', host: 'h', port: 18789, localPort: 18789, sshUser: 'u', sshKeyPath: '~/.ssh/k', bridgePort: null, ...over
});

describe('tunnel-monitor (#294)', () => {
  let saved;
  beforeEach(() => { saved = { ...mon._internal }; mon._backoff.clear(); });
  afterEach(() => { Object.assign(mon._internal, saved); mon._backoff.clear(); mon.stop(); });

  describe('_connIdFromKey', () => {
    it('extracts the connId from an oc-direct- key', () => {
      assert.equal(mon._connIdFromKey('oc-direct-abc-123'), 'abc-123');
    });
    it('returns null for non-oc-direct keys', () => {
      assert.equal(mon._connIdFromKey('some-project'), null);
      assert.equal(mon._connIdFromKey(null), null);
    });
  });

  describe('_checkOne', () => {
    it('healthy tunnel → no recreate, backoff cleared', async () => {
      let ensured = false;
      mon._internal.roundTrip = async () => true;
      mon._internal.ensure = async () => { ensured = true; return { ok: true }; };
      const r = await mon._checkOne(conn(), 1000);
      assert.equal(r.outcome, 'healthy');
      assert.equal(ensured, false, 'a healthy tunnel is never rebuilt');
    });

    it('dead tunnel → recreates with force + the bridge forward', async () => {
      let calledWith = null;
      mon._internal.roundTrip = async () => false;
      mon._internal.ensure = async (name, cfg) => { calledWith = { name, cfg }; return { ok: true, forwardTarget: '127.0.0.1' }; };
      const r = await mon._checkOne(conn({ bridgePort: 3201 }), 1000);
      assert.equal(r.outcome, 'recreated');
      assert.equal(calledWith.name, 'oc-direct-c1');
      assert.equal(calledWith.cfg.force, true);
      assert.deepEqual(calledWith.cfg.extraForwards, [{ localPort: 3201, remotePort: 3201 }]);
      assert.equal(mon._backoff.has('c1'), false);
    });

    it('dead + recreate fails → backs off, then skips inside the window', async () => {
      mon._internal.roundTrip = async () => false;
      mon._internal.ensure = async () => ({ ok: false, error: 'ssh failed' });
      const r1 = await mon._checkOne(conn(), 1000);
      assert.equal(r1.outcome, 'failed');
      const bo = mon._backoff.get('c1');
      assert.equal(bo.failures, 1);
      assert.ok(bo.nextAttemptAt > 1000);

      let touched = false;
      mon._internal.roundTrip = async () => { touched = true; return false; };
      const r2 = await mon._checkOne(conn(), 1001); // still inside backoff window
      assert.equal(r2.outcome, 'skip:backoff');
      assert.equal(touched, false, 'no probe/ensure while backing off');
    });

    it('backoff escalates and is capped at MAX_BACKOFF_MS', async () => {
      mon._internal.roundTrip = async () => false;
      mon._internal.ensure = async () => ({ ok: false, error: 'down' });
      let now = 0;
      const delays = [];
      for (let i = 0; i < 12; i++) {
        await mon._checkOne(conn(), now);
        const bo = mon._backoff.get('c1');
        delays.push(bo.nextAttemptAt - now);
        now = bo.nextAttemptAt; // advance past the window for the next attempt
      }
      assert.ok(delays[1] > delays[0], 'delay escalates');
      assert.ok(delays[delays.length - 1] <= mon.MAX_BACKOFF_MS, 'capped');
    });

    it('recovery after failures clears backoff', async () => {
      mon._internal.roundTrip = async () => false;
      mon._internal.ensure = async () => ({ ok: false });
      await mon._checkOne(conn(), 0);
      assert.ok(mon._backoff.has('c1'));
      mon._internal.roundTrip = async () => true; // gateway back
      const r = await mon._checkOne(conn(), mon._backoff.get('c1').nextAttemptAt);
      assert.equal(r.outcome, 'healthy');
      assert.equal(mon._backoff.has('c1'), false);
    });
  });

  describe('tick', () => {
    it('checks only oc-direct tunnels backed by a known connection', async () => {
      mon._internal.listTunnels = () => [
        { projectName: 'oc-direct-c1', localPort: 18789 },
        { projectName: 'some-project', localPort: 4000 },    // not oc-direct → skip
        { projectName: 'oc-direct-gone', localPort: 18800 }  // unknown conn → skip
      ];
      mon._internal.getConn = (id) => (id === 'c1' ? conn() : null);
      const probed = [];
      mon._internal.roundTrip = async (p) => { probed.push(p); return true; };
      const results = await mon.tick(1000);
      assert.deepEqual(probed, [18789], 'only the known oc-direct connection is probed');
      assert.equal(results.length, 1);
      assert.equal(results[0].connId, 'c1');
    });
  });

  describe('start/stop', () => {
    it('start is idempotent and stop clears state', () => {
      mon._internal.listTunnels = () => [];
      mon.start(10000);
      mon.start(10000); // no-op (already running)
      mon.stop();
      assert.equal(mon._backoff.size, 0);
    });
  });
});
