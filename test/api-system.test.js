'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('../server');
const store = require('../lib/store');

describe('API — system, engines, tmux', () => {
  let server;
  let port;
  let tempDir;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-api-system-test-'));
    store._setBasePath(tempDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Make an HTTP request to the test server.
   * @param {string} method - HTTP method
   * @param {string} urlPath - URL path
   * @param {object} [body] - Request body
   * @returns {Promise<{ status: number, data: object }>}
   */
  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' }
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode, data });
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  describe('GET /api/system', () => {
    it('should return system stats', async () => {
      const { status, data } = await request('GET', '/api/system');
      assert.equal(status, 200);
      assert.ok(data.cpu);
      assert.ok(typeof data.cpu.model === 'string');
      assert.ok(typeof data.cpu.cores === 'number');
      assert.ok(typeof data.cpu.usage === 'number');
      assert.ok(data.memory);
      assert.ok(typeof data.memory.total === 'number');
      assert.ok(typeof data.memory.percent === 'number');
      assert.ok(data.disk);
      assert.ok(typeof data.uptime === 'number');
      assert.ok(typeof data.uptimeFormatted === 'string');
      assert.ok(typeof data.nodeVersion === 'string');
      assert.ok(typeof data.platform === 'string');
      assert.ok(typeof data.arch === 'string');
    });
  });

  describe('GET /api/engines', () => {
    it('should return engines list', async () => {
      const { status, data } = await request('GET', '/api/engines');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.engines));
      assert.ok(data.engines.length > 0, 'Should have bundled engine profiles');

      const claude = data.engines.find((e) => e.id === 'claude');
      assert.ok(claude, 'Should include claude profile');
      assert.equal(claude.name, 'Claude Code');
      assert.equal(claude.interactionModel, 'session');
      assert.ok(typeof claude.available === 'boolean');
      assert.ok(typeof claude.capabilities === 'object');
      assert.ok(Array.isArray(claude.commands));
    });

    it('should include all bundled engines', async () => {
      const { data } = await request('GET', '/api/engines');
      const ids = data.engines.map((e) => e.id);
      assert.ok(ids.includes('claude'));
      assert.ok(ids.includes('codex'));
      assert.ok(ids.includes('aider'));
      assert.ok(ids.includes('antigravity'));
      assert.ok(!ids.includes('gemini'), 'gemini retired (#457)');
      assert.ok(!ids.includes('genesis'), 'genesis retired (#458)');
    });
  });

  describe('GET /api/engines/:id', () => {
    it('should return a single engine profile', async () => {
      const { status, data } = await request('GET', '/api/engines/claude');
      assert.equal(status, 200);
      assert.equal(data.id, 'claude');
      assert.equal(data.name, 'Claude Code');
      assert.ok(typeof data.available === 'boolean');
      assert.ok(data.configFormat);
      assert.ok(data.detection);
      assert.ok(data.launch);
      assert.ok(data.capabilities);
    });

    it('should return 404 for non-existent engine', async () => {
      const { status, data } = await request('GET', '/api/engines/__nonexistent__');
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });
  });

  describe('POST /api/tmux/mouse', () => {
    it('should return 400 if session is missing', async () => {
      const { status, data } = await request('POST', '/api/tmux/mouse', { on: true });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should return 400 if on is not a boolean', async () => {
      const { status, data } = await request('POST', '/api/tmux/mouse', { session: 'test', on: 'yes' });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should return 404 for non-existent session', async () => {
      const { status, data } = await request('POST', '/api/tmux/mouse', {
        session: '__nonexistent_session__',
        on: true
      });
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('should normalize session name with spaces (fixes #12)', async () => {
      const { status, data } = await request('POST', '/api/tmux/mouse', {
        session: 'No Such Project v99',
        on: true
      });
      // 404 because no tmux session named "No-Such-Project-v99" exists
      assert.equal(status, 404);
      assert.ok(data.error.includes('No-Such-Project-v99'), 'should reference normalized tmux name');
    });
  });

  describe('GET /api/tmux/mouse/:session', () => {
    it('should return 404 for non-existent session', async () => {
      const { status, data } = await request('GET', '/api/tmux/mouse/__nonexistent_session__');
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('should normalize session name with spaces (fixes #12)', async () => {
      const { status, data } = await request('GET', `/api/tmux/mouse/${encodeURIComponent('No Such Project v99')}`);
      assert.equal(status, 404);
      assert.ok(data.error.includes('No-Such-Project-v99'), 'should reference normalized tmux name');
    });
  });

  describe('POST /api/server/restart (#235)', () => {
    // Override the serverInfo module's exported functions to keep the
    // restart route's setTimeout-based exec from actually killing the
    // test process. The route reads `detectRestartMechanism` and
    // `buildRestartCommand` via the module import; reassigning on the
    // module object intercepts both. Restored in each test's finally.
    const serverInfo = require('../lib/server-info');

    it('returns 501 with a descriptive error when no restart mechanism is available', async () => {
      const origDetect = serverInfo.detectRestartMechanism;
      serverInfo.detectRestartMechanism = () => null;
      try {
        const { status, data } = await request('POST', '/api/server/restart');
        assert.equal(status, 501);
        assert.equal(data.ok, false);
        assert.match(data.error, /no restart mechanism available/i,
          'error must signal that the mechanism is absent so the frontend can hide the button cleanly');
      } finally {
        serverInfo.detectRestartMechanism = origDetect;
      }
    });

    it('returns 202 + mechanism in the body when a mechanism is available', async () => {
      const origDetect = serverInfo.detectRestartMechanism;
      const origBuild = serverInfo.buildRestartCommand;
      serverInfo.detectRestartMechanism = () => 'launchctl';
      // `true` is the POSIX shell builtin that exits 0. Using it as
      // the restart command means the route's setTimeout-fired exec
      // is a no-op that completes instantly — no chance of killing
      // the test process; no orphan handles to clean up.
      serverInfo.buildRestartCommand = () => 'true';
      try {
        const { status, data } = await request('POST', '/api/server/restart');
        assert.equal(status, 202,
          '202 Accepted because the actual restart happens asynchronously after the response flushes');
        assert.equal(data.ok, true);
        assert.equal(data.mechanism, 'launchctl');
        assert.ok(typeof data.detail === 'string' && data.detail.length > 0,
          'detail must explain the polling contract for the frontend');
        // Wait past the route's 300ms exec-delay timeout so the
        // (no-op) exec completes before the test's after() tears down
        // the server. (Delay was bumped from 80ms → 300ms on the #235
        // PR Critic to cover Cloudflare-tunnel RTT for remote operators.)
        await new Promise((resolve) => setTimeout(resolve, 400));
      } finally {
        serverInfo.detectRestartMechanism = origDetect;
        serverInfo.buildRestartCommand = origBuild;
      }
    });

    it('returns 500 when detectRestartMechanism returns non-null but buildRestartCommand returns null (internal inconsistency)', async () => {
      // Defensive path — never reachable through normal flow, but
      // pinned so a future refactor that adds a mechanism token
      // without updating buildRestartCommand fails loudly here
      // rather than silently no-op-ing in production.
      const origDetect = serverInfo.detectRestartMechanism;
      const origBuild = serverInfo.buildRestartCommand;
      serverInfo.detectRestartMechanism = () => 'systemctl';
      serverInfo.buildRestartCommand = () => null;
      try {
        const { status, data } = await request('POST', '/api/server/restart');
        assert.equal(status, 500);
        assert.equal(data.ok, false);
        assert.match(data.error, /no command builder for mechanism "systemctl"/);
      } finally {
        serverInfo.detectRestartMechanism = origDetect;
        serverInfo.buildRestartCommand = origBuild;
      }
    });
  });
});
