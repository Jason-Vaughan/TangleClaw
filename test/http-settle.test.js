'use strict';

/*
 * Unit tests for lib/http-settle.js (#1026).
 *
 * The load-bearing property is that `requestOnce` settles on EVERY path. The
 * defect it exists to prevent (#1024, #1026) is a promise that never settles
 * when a socket dies after response headers but before the body completes —
 * `res.'end'` never fires, the error lands on the response rather than the
 * request, and the socket-inactivity timeout dies with the socket.
 *
 * Every test here races the call against a wall-clock timer and asserts the
 * call won. A test that only asserted the resolved shape would pass trivially
 * on a hang by never completing at all, so the race IS the assertion.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { requestOnce, ABORT_REASONS } = require('../lib/http-settle');

/**
 * Start a stub server on a loopback ephemeral port.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
async function stub(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r))
  };
}

/**
 * Resolve to the promise's settlement, or the string 'HUNG' if it does not
 * settle within `ms`. Distinguishes "settled as a rejection" from "never
 * settled" — the whole point of this module.
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<{outcome: 'resolved'|'rejected', value: any}|'HUNG'>}
 */
function settlesWithin(promise, ms) {
  let timer = null;
  return Promise.race([
    promise.then(
      (value) => ({ outcome: 'resolved', value }),
      (value) => ({ outcome: 'rejected', value })
    ),
    new Promise((r) => { timer = setTimeout(() => r('HUNG'), ms); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

describe('http-settle.requestOnce — normal completion', () => {
  it('resolves status and the full body', async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    try {
      const r = await requestOnce({ host: '127.0.0.1', port: s.port, path: '/x' }, { timeoutMs: 2000 });
      assert.equal(r.status, 200);
      assert.equal(r.body.toString('utf8'), '{"hello":"world"}');
    } finally {
      await s.close();
    }
  });

  it('accepts a URL string target and an http.Agent', async () => {
    const s = await stub((_req, res) => { res.writeHead(204); res.end(); });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const r = await requestOnce(`http://127.0.0.1:${s.port}/y`, { agent, timeoutMs: 2000 });
      assert.equal(r.status, 204);
      assert.equal(r.body.length, 0);
    } finally {
      agent.destroy();
      await s.close();
    }
  });

  it('sends the method, headers and body it was given', async () => {
    let seen = null;
    const s = await stub((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen = { method: req.method, path: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') };
        res.writeHead(200); res.end('ok');
      });
    });
    try {
      await requestOnce(
        { host: '127.0.0.1', port: s.port, path: '/z?a=1' },
        { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{"n":1}', timeoutMs: 2000 }
      );
      assert.deepEqual(seen, { method: 'POST', path: '/z?a=1', auth: 'Bearer t', body: '{"n":1}' });
    } finally {
      await s.close();
    }
  });

  it('does not hold the process open after it settles', async () => {
    // Two mechanisms keep the backstop timer from outliving the request: the
    // one-shot `settle` clears it, and it is unref'd. They are redundant WITH
    // EACH OTHER — mutation-checked, this guard only reds when BOTH are removed,
    // so neither is individually pinned and neither should be dropped as "already
    // covered". What is pinned is the property: a settled request leaves nothing
    // holding the loop open. Asserted by actually exiting a child rather than by
    // counting live handles in this process, which other tests also populate.
    // NOTE: must be `spawn`, not `spawnSync` — a synchronous spawn blocks this
    // process's event loop, so the stub server below could never answer the
    // child and the test would measure its own deadlock.
    const s = await stub((_req, res) => { res.writeHead(200); res.end('x'); });
    try {
      const child = `
        const { requestOnce } = require(${JSON.stringify(require.resolve('../lib/http-settle'))});
        requestOnce({ host: '127.0.0.1', port: ${s.port}, path: '/' }, { timeoutMs: 60000 })
          .then(() => process.stdout.write('done'));
      `;
      const started = Date.now();
      const proc = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (c) => { out += c; });
      const exitCode = await Promise.race([
        new Promise((r) => proc.on('exit', r)),
        // A ref'd backstop would pin the loop for 120s. 15s is far beyond what a
        // loopback request needs on a loaded CI box, and far below that 120s.
        new Promise((r) => setTimeout(() => { proc.kill('SIGKILL'); r('NEVER_EXITED'); }, 15000))
      ]);
      assert.equal(out, 'done', 'the child request should have settled');
      assert.equal(exitCode, 0, `child did not exit cleanly after ${Date.now() - started}ms — the backstop timer is holding the loop open`);
    } finally {
      await s.close();
    }
  });
});

describe('http-settle.requestOnce — a socket that dies mid-response', () => {
  // A socket can die mid-body two ways, and they are NOT interchangeable —
  // measured on node v22 against the pre-fix settle logic:
  //
  //   res.socket.destroy()  RST  -> fires req.'error'(ECONNRESET). The pre-fix
  //                                 code ALREADY settled on this.
  //   res.socket.end()      FIN  -> fires res.'aborted' + res.'error' +
  //                                 res.'close', and NOTHING on the request.
  //                                 This is the one that hangs.
  //
  // So FIN is the fixture that can fail. RST is kept because it is a real
  // truncation a peer produces, not because it discriminates.

  it('settles when a graceful close truncates the body (FIN — the hanging case)', async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' });
      res.write('{"active":');
      res.socket.end(); // FIN: no request-level error will ever arrive
    });
    try {
      const settled = await settlesWithin(
        requestOnce({ host: '127.0.0.1', port: s.port, path: '/' }, { timeoutMs: 400 }),
        3000
      );
      assert.notEqual(settled, 'HUNG', 'a FIN-truncated response must settle, not hang');
      assert.equal(settled.outcome, 'rejected');
      assert.equal(settled.value.name, 'AbortError');
      assert.ok(
        [ABORT_REASONS.ABORTED, ABORT_REASONS.CLOSED].includes(settled.value.reason),
        `expected an aborted/closed reason, got ${settled.value.reason}`
      );
    } finally {
      await s.close();
    }
  });

  it('settles when the socket is destroyed mid-body (RST)', async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' });
      res.write('{"active":');
      res.socket.destroy();
    });
    try {
      const settled = await settlesWithin(
        requestOnce({ host: '127.0.0.1', port: s.port, path: '/' }, { timeoutMs: 400 }),
        3000
      );
      assert.notEqual(settled, 'HUNG');
      assert.equal(settled.outcome, 'rejected');
      // Node's own ECONNRESET reaches the request first here; it is passed
      // through unwrapped rather than restated as a synthesized abort.
      assert.ok(settled.value.message, 'carries the underlying message');
    } finally {
      await s.close();
    }
  });

  it('settles a FIN truncation promptly, long before the inactivity timeout could', async () => {
    // Guards the reasoning that wrongly cleared clawbridge in an earlier review:
    // "req.on('timeout') resolves it anyway". That timer is socket-inactivity
    // based and dies with the socket. With a 60s budget and a 5s race, only the
    // response-side listeners can produce a pass.
    const s = await stub((_req, res) => {
      res.writeHead(200, { 'Content-Length': '999' });
      res.write('partial');
      res.socket.end();
    });
    try {
      const started = process.hrtime.bigint();
      const settled = await settlesWithin(
        requestOnce({ host: '127.0.0.1', port: s.port, path: '/' }, { timeoutMs: 60000 }),
        5000
      );
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.notEqual(settled, 'HUNG', 'the inactivity timeout cannot rescue a dead socket');
      assert.equal(settled.outcome, 'rejected');
      assert.ok(elapsedMs < 4000, `settled in ${Math.round(elapsedMs)}ms; a timeout-driven settle would have taken 60000ms`);
    } finally {
      await s.close();
    }
  });
});

describe('http-settle.requestOnce — other terminal paths', () => {
  it('rejects with reason=timeout when the server never responds', async () => {
    const s = await stub(() => { /* hang */ });
    try {
      const settled = await settlesWithin(
        requestOnce({ host: '127.0.0.1', port: s.port, path: '/' }, { timeoutMs: 60 }),
        3000
      );
      assert.notEqual(settled, 'HUNG');
      assert.equal(settled.outcome, 'rejected');
      assert.equal(settled.value.reason, ABORT_REASONS.TIMEOUT);
      assert.equal(settled.value.name, 'AbortError');
    } finally {
      await s.close();
    }
  });

  it('rejects with the underlying error when the connection is refused', async () => {
    const settled = await settlesWithin(
      // Port 1 is privileged; nothing this process can reach is listening there.
      requestOnce({ host: '127.0.0.1', port: 1, path: '/' }, { timeoutMs: 2000 }),
      5000
    );
    assert.notEqual(settled, 'HUNG');
    assert.equal(settled.outcome, 'rejected');
    assert.notEqual(settled.value.name, 'AbortError', 'a refused connect is Node’s error, not a synthesized one');
    assert.ok(settled.value.message, 'carries the underlying message');
  });

  it('settles once — a normal completion is not overwritten by the close that follows it', async () => {
    // `res.'close'` fires on the happy path too, right after `end`. If `settle`
    // stopped being one-shot, this would resolve and THEN reject, surfacing as
    // an unhandled rejection rather than a wrong value.
    const s = await stub((_req, res) => { res.writeHead(200); res.end('done'); });
    const rejections = [];
    const onUnhandled = (err) => rejections.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const r = await requestOnce({ host: '127.0.0.1', port: s.port, path: '/' }, { timeoutMs: 2000 });
      assert.equal(r.body.toString('utf8'), 'done');
      await new Promise((res2) => setImmediate(res2));
      assert.deepEqual(rejections, [], 'the post-end close must not settle a second time');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await s.close();
    }
  });
});
