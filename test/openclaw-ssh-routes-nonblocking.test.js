'use strict';

/*
 * #1529 — the OpenClaw routes that reach a remote host must not hold the event
 * loop while the host is slow or unreachable. After a network move, every
 * synchronous ssh the server ran froze it for the whole connect timeout, which
 * dropped WebSockets and kept the dashboard reloading.
 *
 * Each route is driven through the real request handler with the remote runner
 * stubbed to a promise the test controls. The property pinned is ORDER: a timer
 * must run while the route's command is still pending. A route that went back
 * to a synchronous call could not let that timer run first.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const remote = require('../lib/openclaw-remote');
const { handleRequest } = require('../server');

setLevel('error');

const SSH_TARGET = { host: '10.0.0.9', sshUser: 'admin', sshKeyPath: '~/.ssh/id_rsa' };

/**
 * Drive a JSON request through the real handler without awaiting it.
 * @param {string} method
 * @param {string} url
 * @param {object} [body]
 * @returns {{done: Promise<void>, res: object}} The in-flight request and its response double.
 */
function send(method, url, body) {
  const req = new PassThrough();
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost:3102', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    setHeader() {},
    getHeader() { return undefined; },
    end(chunk) { if (chunk != null) this.body += String(chunk); }
  };
  const done = handleRequest(req, res);
  req.end(body === undefined ? '' : JSON.stringify(body));
  return { done, res };
}

/**
 * A controllable stand-in for a remote command: `calls` records each command,
 * and `release(i, outcome)` settles the i-th call.
 * @returns {{fn: Function, calls: Array, release: Function}}
 */
function heldRunner() {
  const calls = [];
  const fn = (...args) => new Promise((resolve, reject) => { calls.push({ args, resolve, reject }); });
  const release = (i, outcome) => {
    if (outcome instanceof Error) calls[i].reject(outcome);
    else calls[i].resolve(outcome);
  };
  return { fn, calls, release };
}

/**
 * Wait until `n` commands have been started, yielding to the event loop between checks.
 * @param {{calls: Array}} runner
 * @param {number} n
 * @returns {Promise<void>}
 */
async function untilCalls(runner, n) {
  for (let i = 0; i < 200 && runner.calls.length < n; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runner.calls.length, n, `expected ${n} pending command(s)`);
}

/**
 * True when a timer fires while `inFlight` has not yet settled.
 * @param {Promise<void>} inFlight
 * @returns {Promise<boolean>}
 */
async function timerRanWhilePending(inFlight) {
  let settled = false;
  inFlight.then(() => { settled = true; });
  return new Promise((resolve) => setTimeout(() => resolve(!settled), 5));
}

/**
 * An error shaped like the one async `exec`/`execFile` hand back.
 * @param {object} fields
 * @returns {Error}
 */
function childError(fields) {
  return Object.assign(new Error(fields.message || 'Command failed'), { stdout: '', stderr: '', ...fields });
}

describe('OpenClaw ssh routes do not block the event loop (#1529)', () => {
  let tmpDir;
  let connId;
  const real = { ...remote._internal };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-ssh-routes-'));
    store._setBasePath(tmpDir);
    store.init();
    connId = store.openclawConnections.create({
      name: 'SshRoutes', ...SSH_TARGET, port: 18789, gatewayToken: 'super-secret-token'
    }).id;
  });

  afterEach(() => { Object.assign(remote._internal, real); });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/openclaw/detect-instance-dir', () => {
    it('answers after the discovery command, and lets a timer run while it waits', async () => {
      const runner = heldRunner();
      remote._internal.runShell = runner.fn;
      const { done, res } = send('POST', '/api/openclaw/detect-instance-dir', SSH_TARGET);
      await untilCalls(runner, 1);
      assert.equal(await timerRanWhilePending(done), true);
      assert.match(runner.calls[0].args[0], /ssh -T .*admin@10\.0\.0\.9 sh$/);
      assert.ok(runner.calls[0].args[1].input.length > 0, 'the discovery script goes over stdin');
      runner.release(0, { stdout: '/home/admin/openclaw\n', stderr: '' });
      await done;
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), { dirs: ['/home/admin/openclaw'], error: null });
    });

    it('reports an ssh failure with the remote stderr', async () => {
      const runner = heldRunner();
      remote._internal.runShell = runner.fn;
      const { done, res } = send('POST', '/api/openclaw/detect-instance-dir', SSH_TARGET);
      await untilCalls(runner, 1);
      runner.release(0, childError({ code: 255, stderr: 'ssh: connect to host 10.0.0.9 port 22: Operation timed out' }));
      await done;
      const json = JSON.parse(res.body);
      assert.deepEqual(json.dirs, []);
      assert.match(json.error, /^ssh detect failed: ssh: connect to host 10\.0\.0\.9 port 22: Operation timed out/);
    });
  });

  describe('POST /api/openclaw/test', () => {
    it('runs both probes off the loop and reports each result', async () => {
      const runner = heldRunner();
      remote._internal.runShell = runner.fn;
      const { done, res } = send('POST', '/api/openclaw/test', { ...SSH_TARGET, port: 18789 });
      await untilCalls(runner, 1);
      assert.equal(await timerRanWhilePending(done), true, 'the ssh probe must not block');
      assert.match(runner.calls[0].args[0], /^ssh .*admin@10\.0\.0\.9 "echo ok"$/);
      runner.release(0, { stdout: 'ok\n', stderr: '' });
      await untilCalls(runner, 2);
      assert.equal(await timerRanWhilePending(done), true, 'the gateway probe must not block');
      assert.equal(runner.calls[1].args[0], 'curl -s -m 5 http://localhost:18789/healthz');
      runner.release(1, { stdout: '{"ok":true}', stderr: '' });
      await done;
      assert.deepEqual(JSON.parse(res.body), { ssh: true, gateway: true, errors: [] });
    });

    it('reports an unreachable host and a refused gateway as errors, not a crash', async () => {
      const runner = heldRunner();
      remote._internal.runShell = runner.fn;
      const { done, res } = send('POST', '/api/openclaw/test', { ...SSH_TARGET, port: 18789 });
      await untilCalls(runner, 1);
      runner.release(0, childError({ code: 255, stderr: 'Operation timed out' }));
      await untilCalls(runner, 2);
      runner.release(1, childError({ code: 7, message: 'Command failed: curl' }));
      await done;
      assert.deepEqual(JSON.parse(res.body), {
        ssh: false, gateway: false, errors: ['SSH: Operation timed out', 'Gateway: Command failed: curl']
      });
    });

    it('still refuses an unsafe target without running anything', async () => {
      const runner = heldRunner();
      remote._internal.runShell = runner.fn;
      const { done, res } = send('POST', '/api/openclaw/test', { ...SSH_TARGET, host: '10.0.0.9;id' });
      await done;
      assert.equal(res.statusCode, 400);
      assert.equal(runner.calls.length, 0);
    });
  });

  describe('POST /api/openclaw/connections/:id/approve-pending', () => {
    it('awaits each gateway command without blocking, and approves the newest request', async () => {
      const runner = heldRunner();
      remote._internal.runFile = runner.fn;
      const { done, res } = send('POST', `/api/openclaw/connections/${connId}/approve-pending`);
      const answers = [
        { stdout: '/usr/bin/docker\n', stderr: '' },
        { stdout: 'openclaw-gateway-1\n', stderr: '' },
        { stdout: JSON.stringify({ pending: [{ requestId: 'r-1', ts: 1 }] }), stderr: '' },
        { stdout: '{"ok":true}', stderr: '' }
      ];
      for (let i = 0; i < answers.length; i++) {
        await untilCalls(runner, i + 1);
        assert.equal(await timerRanWhilePending(done), true, `command ${i + 1} must not block`);
        assert.equal(runner.calls[i].args[0], 'ssh');
        runner.release(i, answers[i]);
      }
      await done;
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), { approved: true, code: 'APPROVED', reason: 'approved', count: 1 });
    });

    it('maps an ssh exit status to SSH_FAILED with the remote stderr', async () => {
      const runner = heldRunner();
      remote._internal.runFile = runner.fn;
      const { done, res } = send('POST', `/api/openclaw/connections/${connId}/approve-pending`);
      await untilCalls(runner, 1);
      runner.release(0, childError({ code: 255, stderr: 'Permission denied (publickey)' }));
      await done;
      const json = JSON.parse(res.body);
      assert.equal(json.code, 'SSH_FAILED');
      assert.equal(json.reason, 'Permission denied (publickey)');
    });

    it('reports a timeout through the real runner, by name, on every route', async () => {
      // No stub: a real child that outlives a short timeout, so the message is
      // the one the runner writes, not one this test invented.
      const slow = (opts) => remote._runShell('sleep 5', { ...opts, timeout: 150 });
      remote._internal.runFile = (_file, _args, opts) => slow(opts);
      remote._internal.runShell = (_cmd, opts) => slow(opts);

      let r = send('POST', `/api/openclaw/connections/${connId}/approve-pending`);
      await r.done;
      assert.deepEqual(
        (({ code, reason }) => ({ code, reason }))(JSON.parse(r.res.body)),
        { code: 'SSH_FAILED', reason: 'timed out after 150ms' }
      );

      r = send('POST', '/api/openclaw/detect-instance-dir', SSH_TARGET);
      await r.done;
      assert.equal(JSON.parse(r.res.body).error, 'ssh detect failed: timed out after 150ms');

      r = send('POST', '/api/openclaw/test', { ...SSH_TARGET, port: 18789 });
      await r.done;
      assert.deepEqual(JSON.parse(r.res.body).errors, ['SSH: timed out after 150ms', 'Gateway: timed out after 150ms']);
    });

    it('never lets the gateway token reach the response', async () => {
      const runner = heldRunner();
      remote._internal.runFile = runner.fn;
      const { done, res } = send('POST', `/api/openclaw/connections/${connId}/approve-pending`);
      const answers = [
        { stdout: '/usr/bin/docker\n', stderr: '' },
        { stdout: 'openclaw-gateway-1\n', stderr: '' },
        { stdout: JSON.stringify({ pending: [{ requestId: 'r-1', ts: 1 }] }), stderr: '' }
      ];
      for (let i = 0; i < answers.length; i++) {
        await untilCalls(runner, i + 1);
        runner.release(i, answers[i]);
      }
      await untilCalls(runner, 4);
      runner.release(3, childError({ code: 1, stderr: 'rejected token super-secret-token' }));
      await done;
      const json = JSON.parse(res.body);
      assert.equal(json.code, 'APPROVE_FAILED');
      assert.equal(json.reason, 'rejected token «token»');
      assert.doesNotMatch(res.body, /super-secret-token/);
    });
  });
});
