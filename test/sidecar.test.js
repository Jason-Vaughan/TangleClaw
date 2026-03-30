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
});
