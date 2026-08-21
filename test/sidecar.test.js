'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const sidecar = require('../lib/sidecar');

/**
 * Helper: create an OpenClaw connection and return its auto-generated ID.
 * @param {string} name - Connection name
 * @param {number} [localPort=19999] - Local port
 * @returns {string} - Connection ID
 */
function createConn(name, localPort = 19999) {
  const conn = store.openclawConnections.create({
    name,
    host: '198.51.100.10',
    port: 18789,
    sshUser: 'test',
    sshKeyPath: '~/.ssh/id_rsa',
    localPort
  });
  return conn.id;
}

describe('sidecar', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sidecar-'));
    store._setBasePath(tmpDir);
    store.init();
    sidecar._cache.clear();
    sidecar.stopAllPolling();
  });

  afterEach(() => {
    sidecar.stopAllPolling();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveConnectionId', () => {
    it('should resolve project name to connection ID', () => {
      const connId = createConn('TestClaw');
      store.projects.create({
        name: 'TestProject',
        path: '/tmp/test-project',
        engine: `openclaw:${connId}`
      });

      const result = sidecar.resolveConnectionId('TestProject');
      assert.equal(result, connId);
    });

    it('should return null for non-OpenClaw project', () => {
      store.projects.create({
        name: 'RegularProject',
        path: '/tmp/regular',
        engine: 'claude'
      });

      assert.equal(sidecar.resolveConnectionId('RegularProject'), null);
    });

    it('should return null for unknown project', () => {
      assert.equal(sidecar.resolveConnectionId('NonExistent'), null);
    });
  });

  describe('getProcesses', () => {
    it('should return empty state for unknown connection', () => {
      const result = sidecar.getProcesses('unknown-id');
      assert.equal(result.processes, null);
      assert.equal(result.lastPollAt, null);
      assert.equal(result.stale, false);
    });

    it('should return cached state', () => {
      sidecar._cache.set('some-conn', {
        processes: { active: [{ id: 'proc-1', status: 'running' }], recent: [] },
        lastPollAt: new Date().toISOString(),
        error: null,
        stale: false
      });

      const result = sidecar.getProcesses('some-conn');
      assert.equal(result.processes.active.length, 1);
      assert.equal(result.processes.active[0].id, 'proc-1');
      assert.equal(result.stale, false);
    });

    it('should mark stale if last poll was too long ago', () => {
      const oldTime = new Date(Date.now() - sidecar.STALE_THRESHOLD_MS - 1000).toISOString();
      sidecar._cache.set('some-conn', {
        processes: { active: [], recent: [] },
        lastPollAt: oldTime,
        error: null,
        stale: false
      });

      const result = sidecar.getProcesses('some-conn');
      assert.equal(result.stale, true);
    });

    it('should not mark stale if recent', () => {
      sidecar._cache.set('some-conn', {
        processes: { active: [], recent: [] },
        lastPollAt: new Date().toISOString(),
        error: null,
        stale: false
      });

      assert.equal(sidecar.getProcesses('some-conn').stale, false);
    });
  });

  describe('getProcessesForProject', () => {
    it('should resolve project and return cached state', () => {
      const connId = createConn('TestClaw');
      store.projects.create({
        name: 'TestProject',
        path: '/tmp/test-project',
        engine: `openclaw:${connId}`
      });
      sidecar._cache.set(connId, {
        processes: { active: [{ id: 'proc-1' }], recent: [] },
        lastPollAt: new Date().toISOString(),
        error: null,
        stale: false
      });

      const result = sidecar.getProcessesForProject('TestProject');
      assert.equal(result.connectionId, connId);
      assert.equal(result.processes.active.length, 1);
    });

    it('should return null connectionId for non-OpenClaw project', () => {
      store.projects.create({
        name: 'RegularProject',
        path: '/tmp/regular',
        engine: 'claude'
      });

      const result = sidecar.getProcessesForProject('RegularProject');
      assert.equal(result.connectionId, null);
      assert.equal(result.processes, null);
    });
  });

  describe('pollProcesses', () => {
    it('should return error for unknown connection', async () => {
      const result = await sidecar.pollProcesses('nonexistent');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should handle connection failure gracefully', async () => {
      const connId = createConn('TestClaw', 19999);

      const result = await sidecar.pollProcesses(connId, { timeoutMs: 500 });
      assert.equal(result.ok, false);
      assert.ok(result.error);

      const cached = sidecar._cache.get(connId);
      assert.ok(cached);
      assert.equal(cached.stale, true);
    });

    it('should preserve stale cache on failure', async () => {
      const connId = createConn('TestClaw', 19999);

      const oldProcesses = { active: [{ id: 'old-proc' }], recent: [] };
      sidecar._cache.set(connId, {
        processes: oldProcesses,
        lastPollAt: new Date().toISOString(),
        error: null,
        stale: false
      });

      const result = await sidecar.pollProcesses(connId, { timeoutMs: 500 });
      assert.equal(result.ok, false);

      const cached = sidecar._cache.get(connId);
      assert.deepEqual(cached.processes, oldProcesses);
      assert.equal(cached.stale, true);
    });
  });

  describe('startPolling / stopPolling', () => {
    it('should start and track polling', () => {
      const connId = createConn('TestClaw');
      sidecar.startPolling(connId, 60000);
      assert.ok(sidecar._pollers.has(connId));
      sidecar.stopPolling(connId);
      assert.ok(!sidecar._pollers.has(connId));
    });

    it('should not duplicate polling', () => {
      const connId = createConn('TestClaw');
      sidecar.startPolling(connId, 60000);
      const firstId = sidecar._pollers.get(connId);
      sidecar.startPolling(connId, 60000);
      assert.equal(sidecar._pollers.get(connId), firstId);
    });

    it('should stop all polling', () => {
      const id1 = createConn('Claw1');
      const id2 = createConn('Claw2', 19998);
      sidecar.startPolling(id1, 60000);
      sidecar.startPolling(id2, 60000);
      assert.equal(sidecar._pollers.size, 2);
      sidecar.stopAllPolling();
      assert.equal(sidecar._pollers.size, 0);
    });
  });

  describe('syncPolling', () => {
    it('should start polling for connections with active sessions', () => {
      const connId = createConn('TestClaw');
      const project = store.projects.create({
        name: 'TestProject',
        path: '/tmp/test-project',
        engine: `openclaw:${connId}`
      });
      store.sessions.start({
        projectId: project.id,
        engineId: `openclaw:${connId}`,
        tmuxSession: 'test-tmux',
        sessionMode: 'tmux'
      });

      sidecar.syncPolling();
      assert.ok(sidecar._pollers.has(connId));
    });

    it('should not start polling when no active sessions', () => {
      const connId = createConn('TestClaw');
      store.projects.create({
        name: 'TestProject',
        path: '/tmp/test-project',
        engine: `openclaw:${connId}`
      });

      sidecar.syncPolling();
      assert.ok(!sidecar._pollers.has(connId));
    });
  });

  // ── #1024: connection churn against a failing gateway ──
  //
  // The poller used to `fetch` with an AbortController and re-dial on a fixed
  // 10s cadence. An aborted request destroys its socket, so against a slow or
  // unreachable gateway EVERY poll left a socket in TIME_WAIT — one per tick,
  // forever, with no reuse and no slowdown.
  describe('poll connection churn (#1024)', () => {
    it('reuses one pooled connection instead of dialling per poll', () => {
      const agent = sidecar._agent;
      assert.ok(agent, 'a shared agent must exist — global fetch cannot be pooled without undici');
      assert.equal(agent.keepAlive, true, 'keepAlive is what makes a poll reuse the previous socket');
      assert.equal(agent.maxSockets, 1,
        'polls for one connection are serial, so a second socket would only duplicate the pooled one');
      assert.ok(agent.options.keepAliveMsecs > 0, 'a pooled socket must be kept warm between ticks');
    });

    it('backs off exponentially while a gateway keeps failing', () => {
      const id = 'conn-backoff';
      const base = 10000;
      sidecar._failures.delete(id);

      assert.equal(sidecar._backoffMs(id, base), base, 'a healthy connection polls at its base interval');

      sidecar._failures.set(id, 1);
      assert.equal(sidecar._backoffMs(id, base), base * 2);
      sidecar._failures.set(id, 3);
      assert.equal(sidecar._backoffMs(id, base), base * 8);

      sidecar._failures.delete(id);
    });

    it('caps the backoff so a dead gateway is still probed occasionally', () => {
      const id = 'conn-cap';
      sidecar._failures.set(id, 99);
      const delay = sidecar._backoffMs(id, 10000);
      assert.equal(delay, sidecar.MAX_POLL_INTERVAL_MS,
        'an unbounded doubling would eventually stop probing a recoverable gateway altogether');
      assert.ok(delay > 10000, 'the cap must still be slower than the base interval, or backoff does nothing');
      sidecar._failures.delete(id);
    });

    it('counts a failed poll and clears the count on success', async () => {
      const connId = createConn('ChurnClaw', 59999); // nothing listening
      assert.equal(sidecar._failures.get(connId) || 0, 0);

      const r1 = await sidecar.pollProcesses(connId, { timeoutMs: 300 });
      assert.equal(r1.ok, false, 'poll against a closed port must fail');
      assert.equal(sidecar._failures.get(connId), 1, 'a failure must be counted, or backoff never engages');

      const r2 = await sidecar.pollProcesses(connId, { timeoutMs: 300 });
      assert.equal(r2.ok, false);
      assert.equal(sidecar._failures.get(connId), 2, 'consecutive failures must accumulate');
    });

    it('stopPolling clears the failure count so a restart is not born backed off', () => {
      const connId = createConn('ResetClaw');
      sidecar._failures.set(connId, 5);
      sidecar.stopPolling(connId);
      assert.equal(sidecar._failures.get(connId), undefined,
        'a stopped poller keeping its failure count would resume at a 5-minute delay');
    });
  });

  // ── #1024 follow-up: findings the Critic raised on the fix itself ──
  describe('poll loop liveness (#1024 R-1/R-2)', () => {
    const http = require('node:http');

    it('re-arms the loop after every tick, including a failing one', async () => {
      // R-2: without `.finally(scheduleNext)` the loop runs exactly once and the
      // whole suite still passes, because _pollers is populated before tick one.
      const connId = createConn('LoopClaw', 59998); // nothing listening -> every tick fails
      sidecar.startPolling(connId, 20);
      await new Promise(r => setTimeout(r, 220));
      const failures = sidecar._failures.get(connId) || 0;
      sidecar.stopPolling(connId);
      assert.ok(failures >= 2,
        `expected the loop to re-arm and poll repeatedly, saw ${failures} failure(s) — ` +
        'one means it ran once and never rescheduled');
    });

    it('settles even when the socket dies after headers but before the body', async () => {
      // R-1: the original only settled on res.'end' or req.'error'. A socket
      // closing mid-body fires neither, so the promise hung — and because the
      // next poll is scheduled from .finally(), one hang killed polling forever.
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' });
        res.write('{"active":');
        res.socket.destroy(); // truncate: headers sent, body never completes
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const connId = createConn('TruncClaw', port);

      const result = await Promise.race([
        sidecar.pollProcesses(connId, { timeoutMs: 400 }),
        new Promise(r => setTimeout(() => r('HUNG'), 3000))
      ]);
      server.close();
      assert.notEqual(result, 'HUNG', 'the poll promise must settle on a truncated response, not hang');
      assert.equal(result.ok, false);
    });

    it('clears the failure count on a genuinely successful poll', async () => {
      // R-3: the earlier test named the success path but never exercised it,
      // leaving `_failures.delete` on success unmutated.
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: [], recent: [] }));
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const connId = createConn('OkClaw', port);

      sidecar._failures.set(connId, 4);
      const res = await sidecar.pollProcesses(connId, { timeoutMs: 1000 });
      server.close();
      assert.equal(res.ok, true, 'poll against a live server must succeed');
      assert.equal(sidecar._failures.get(connId), undefined,
        'a success must reset backoff, or a recovered gateway stays polled at 5-minute intervals');
    });

    it('stopAllPolling protects a HEALTHY connection in flight, not just a failing one', async () => {
      // "One call site is not the family" (learnings.md). stopPolling bumps the
      // epoch for its connection; stopAllPolling keyed off _failures, so a
      // connection with no failures yet — the healthy case — kept a matching
      // epoch and wrote a count back after the clear.
      const connId = createConn('AllStopClaw', 59996); // nothing listening
      sidecar.startPolling(connId, 50);
      assert.equal(sidecar._failures.get(connId) || 0, 0, 'must start with no failures, or the guard is not exercised');

      const inflight = sidecar.pollProcesses(connId, { timeoutMs: 400 });
      sidecar.stopAllPolling();
      await inflight;
      assert.equal(sidecar._failures.get(connId), undefined,
        'a healthy connection stopped mid-poll must not be left carrying a failure count');
    });

    it('a poll in flight when polling stops cannot re-set the cleared count', async () => {
      // R-5: stopPolling does not abort an in-flight request. Its result lands
      // afterwards and, without the epoch guard, re-sets the count it just saw
      // cleared — so the next startPolling opens already backed off.
      const connId = createConn('RaceClaw', 59997); // nothing listening
      const inflight = sidecar.pollProcesses(connId, { timeoutMs: 400 });
      sidecar.stopPolling(connId);
      await inflight;
      assert.equal(sidecar._failures.get(connId), undefined,
        'a request that outlived stopPolling must not write its failure back');
    });
  });
});
