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

    it('should accept unset: true in place of on (#579)', async () => {
      // 404 (session lookup), NOT 400 — proves unset passed validation.
      const { status, data } = await request('POST', '/api/tmux/mouse', {
        session: '__nonexistent_session__',
        unset: true
      });
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('should reject on + unset together (#579 — mutually exclusive)', async () => {
      const { status, data } = await request('POST', '/api/tmux/mouse', {
        session: 'test',
        on: true,
        unset: true
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });
  });

  describe('POST /api/sessions/:project/wrap — operator kill switch (2026-07-16 wrap-retry incident)', () => {
    it('refuses every wrap with 503 WRAP_DISABLED while config.wrapDisabled is set', async () => {
      const patched = await request('PATCH', '/api/config', { wrapDisabled: true });
      assert.equal(patched.status, 200);
      // No password sent on purpose: the kill switch must fire BEFORE the
      // password gate — disabled means disabled, regardless of caller.
      const { status, data } = await request('POST', '/api/sessions/AnyProject/wrap', {});
      assert.equal(status, 503);
      assert.equal(data.code, 'WRAP_DISABLED');
      assert.ok(data.error.includes('wrapDisabled'),
        'the refusal must name the flag so the operator knows how to re-enable');
    });

    it('clearing the flag restores normal wrap handling', async () => {
      const patched = await request('PATCH', '/api/config', { wrapDisabled: false });
      assert.equal(patched.status, 200);
      const { data } = await request('POST', '/api/sessions/__no_such_project__/wrap', {});
      assert.notEqual(data.code, 'WRAP_DISABLED',
        'with the flag off the route must fall through to normal handling');
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

  describe('GET /api/server-info carries the behind-origin answer (#227)', () => {
    const behindOrigin = require('../lib/behind-origin');

    it('reports the cached count with the check enabled, without waiting on git', async () => {
      const orig = { ...behindOrigin._internal };
      let fetches = 0;
      // HEAD on a branch, then a fetch that never completes: the route must
      // answer anyway, from cache — a hung remote must not hang the poll.
      behindOrigin._internal.gitSymbolicRef = (cb) => cb(null, 'refs/heads/main\n');
      behindOrigin._internal.gitFetch = () => { fetches++; };
      behindOrigin._internal.gitRevList = () => {};
      behindOrigin._reset();
      try {
        const { status, data } = await request('GET', '/api/server-info');
        assert.equal(status, 200);
        assert.deepEqual(data.behindOrigin, { enabled: true, commitsAhead: 0, skipped: null, checkedAt: null, state: 'pending', reason: 'not measured yet' },
          'unmeasured yet: enabled, nothing to say, and honest about not having measured');
        assert.equal(fetches, 1, 'an expired cache starts exactly one background fetch');
      } finally {
        Object.assign(behindOrigin._internal, orig);
        behindOrigin._reset();
      }
    });

    it('reports enabled:false and starts no fetch when the operator turned the check off', async () => {
      const orig = { ...behindOrigin._internal };
      let fetches = 0;
      behindOrigin._internal.gitSymbolicRef = (cb) => cb(null, 'refs/heads/main\n');
      behindOrigin._internal.gitFetch = () => { fetches++; };
      behindOrigin._reset();
      try {
        const patched = await request('PATCH', '/api/config', { behindOriginCheckEnabled: false });
        assert.equal(patched.status, 200);
        const { data } = await request('GET', '/api/server-info');
        assert.deepEqual(data.behindOrigin, { enabled: false, commitsAhead: 0, skipped: null, checkedAt: null, state: 'disabled', reason: 'check turned off' });
        assert.equal(fetches, 0, 'the flag is the operator\'s word that this machine must not call out');
      } finally {
        await request('PATCH', '/api/config', { behindOriginCheckEnabled: true });
        Object.assign(behindOrigin._internal, orig);
        behindOrigin._reset();
      }
    });

    it('carries liveCheckout and restartImpact (#993, #1678) without running git on the request', async () => {
      const checkoutState = require('../lib/checkout-state');
      const orig = { ...checkoutState._internal };
      let spawns = 0;
      checkoutState._internal.execFile = () => { spawns++; }; // never calls back: the route must not wait
      checkoutState._reset();
      try {
        const { status, data } = await request('GET', '/api/server-info');
        assert.equal(status, 200);
        assert.ok(data.liveCheckout, 'liveCheckout is present');
        assert.equal(data.liveCheckout.state, 'pending', 'the first poll reports the probe, never a clean checkout');
        assert.equal(data.liveCheckout.branch, null);
        assert.equal(data.liveCheckout.upstream.observation, 'unknown');
        assert.equal(spawns, 1, 'one background measurement was started');
      } finally {
        Object.assign(checkoutState._internal, orig);
        checkoutState._reset();
      }
    });

    it('restartImpact classifies startupSha..currentDiskSha when stale, and is null when not', async () => {
      const serverInfo = require('../lib/server-info');
      const checkoutState = require('../lib/checkout-state');
      const origGet = serverInfo.getServerInfo;
      const origInternal = { ...checkoutState._internal };
      const START = '1'.repeat(40);
      const DISK = '2'.repeat(40);
      const diffs = [];
      checkoutState._internal.execFile = (file, args, _o, cb) => {
        if (args[1] === 'diff') diffs.push(args.slice(1));
        setImmediate(() => cb(null, args[1] === 'diff' ? 'M\0docs/a.md\0' : ''));
      };
      checkoutState._reset();
      try {
        let stale = true;
        serverInfo.getServerInfo = (opts) => ({ ...origGet(opts), isStale: stale, startupSha: START, currentDiskSha: DISK });
        let { data } = await request('GET', '/api/server-info');
        assert.equal(data.restartImpact.impact, 'pending');
        assert.equal(data.restartImpact.fromSha, START, 'the range starts at what the process loaded');
        assert.equal(data.restartImpact.toSha, DISK, 'and ends at what is on disk');
        await new Promise((r) => setTimeout(r, 20));
        ({ data } = await request('GET', '/api/server-info'));
        assert.equal(data.restartImpact.impact, 'records-only');
        assert.deepEqual(diffs[0].slice(-3), [START, DISK, '--'], 'git diff is asked for exactly that range');
        stale = false;
        ({ data } = await request('GET', '/api/server-info'));
        assert.equal(data.restartImpact, null, 'only asked when disk is ahead');
      } finally {
        serverInfo.getServerInfo = origGet;
        Object.assign(checkoutState._internal, origInternal);
        checkoutState._reset();
      }
    });

    it('refuses a non-boolean behindOriginCheckEnabled', async () => {
      const { status, data } = await request('PATCH', '/api/config', { behindOriginCheckEnabled: 'no' });
      assert.equal(status, 400);
      assert.match(data.error, /behindOriginCheckEnabled must be a boolean/);
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
        assert.match(data.error, /systemd user unit tangleclaw\.service that runs this server with KillMode=process/,
          'a Linux operator must be told what enables the restart, not that Linux is unsupported');
        assert.doesNotMatch(data.error, /follow-up/i);
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

    it('refuses with 409 and runs nothing when the re-check says the unit is no longer safe', async () => {
      const origDetect = serverInfo.detectRestartMechanism;
      const origConfirm = serverInfo.confirmRestartMechanism;
      const origBuild = serverInfo.buildRestartCommand;
      let built = false;
      serverInfo.detectRestartMechanism = () => 'systemctl';
      serverInfo.confirmRestartMechanism = (mechanism) => {
        assert.equal(mechanism, 'systemctl', 'the re-check must be asked about the detected mechanism');
        return { ok: false, reason: 'tangleclaw.service changed on disk since systemd loaded it — run systemctl --user daemon-reload' };
      };
      serverInfo.buildRestartCommand = () => { built = true; return 'true'; };
      try {
        const { status, data } = await request('POST', '/api/server/restart');
        assert.equal(status, 409);
        assert.equal(data.code, 'RESTART_NOT_SAFE');
        assert.match(data.error, /daemon-reload/, 'the operator must see why');
        assert.equal(built, false, 'no restart command may be built after a failed re-check');
      } finally {
        serverInfo.detectRestartMechanism = origDetect;
        serverInfo.confirmRestartMechanism = origConfirm;
        serverInfo.buildRestartCommand = origBuild;
      }
    });

    it("logs the restart command's own error output when the exec fails", async () => {
      // A failed restart leaves this process running, so the log line is the
      // only record of why — it must carry the command's stderr, not just its
      // exit status.
      const origDetect = serverInfo.detectRestartMechanism;
      const origBuild = serverInfo.buildRestartCommand;
      const origConfirm = serverInfo.confirmRestartMechanism;
      const origError = console.error;
      const logged = [];
      serverInfo.detectRestartMechanism = () => 'systemctl';
      serverInfo.confirmRestartMechanism = () => ({ ok: true, reason: null });
      // The message is assembled by printf so the expected text appears only
      // on stderr — execSync's err.message already quotes the command line.
      serverInfo.buildRestartCommand = () => "printf 'Unit %s not found.\\n' tangleclaw.service 1>&2; exit 5";
      console.error = (...args) => { logged.push(args.join(' ')); };
      try {
        const { status } = await request('POST', '/api/server/restart');
        assert.equal(status, 202);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const line = logged.find((l) => l.includes('[server-restart] exec failed'));
        assert.ok(line, `expected an exec-failed log line, got: ${JSON.stringify(logged)}`);
        assert.match(line, /Unit tangleclaw\.service not found\./);
      } finally {
        console.error = origError;
        serverInfo.confirmRestartMechanism = origConfirm;
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
      const origConfirm = serverInfo.confirmRestartMechanism;
      serverInfo.detectRestartMechanism = () => 'systemctl';
      serverInfo.confirmRestartMechanism = () => ({ ok: true, reason: null });
      serverInfo.buildRestartCommand = () => null;
      try {
        const { status, data } = await request('POST', '/api/server/restart');
        assert.equal(status, 500);
        assert.equal(data.ok, false);
        assert.match(data.error, /no command builder for mechanism "systemctl"/);
      } finally {
        serverInfo.confirmRestartMechanism = origConfirm;
        serverInfo.detectRestartMechanism = origDetect;
        serverInfo.buildRestartCommand = origBuild;
      }
    });
  });
});
