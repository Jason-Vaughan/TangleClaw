'use strict';

/*
 * #2032: the coordinator rotation routes are bound to the caller's own
 * verified launch (abandon to the operator), so no other pane, peer or
 * unbound caller can prepare, read, advance or resume a coordinator's
 * rotation. The transition rules themselves are pinned in
 * test/coordinator-rotation.test.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');

describe('API — coordinator rotation routes (#2032)', () => {
  let tempDir;
  let server;
  let port;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-api-'));
    store._setBasePath(tempDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path.
   * @param {string} method - Method.
   * @param {object} [body] - JSON body.
   * @param {object} [headers] - Extra headers.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  const LAUNCH_BOUND = [
    ['POST', '/api/tc/rotation/prepare', { attemptKey: 'attempt-0001', checkpoint: {} }],
    ['GET', '/api/tc/rotation', null],
    ['POST', '/api/tc/rotation/advance', {}],
    ['POST', '/api/tc/rotation/resume', { rotationId: 'rot_x' }]
  ];

  for (const [method, url, body] of LAUNCH_BOUND) {
    it(`${method} ${url} refuses a caller with no verified launch`, async () => {
      const { status, data } = await req(url, method, body);
      assert.equal(status, 403);
      assert.equal(data.code, 'ROTATION_BINDING_REQUIRED');
    });

    it(`${method} ${url} refuses a launch id nobody holds`, async () => {
      const { status, data } = await req(url, method, body, { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'forged' });
      assert.equal(status, 403);
      assert.equal(data.code, 'ROTATION_BINDING_REQUIRED');
    });
  }

  it('abandon refuses a project caller: it is the operator\'s exit', async () => {
    const { status, data } = await req('/api/tc/rotation/abandon', 'POST', { rotationId: 'rot_x', reason: 'x' },
      { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'forged' });
    assert.equal(status, 403);
    assert.equal(data.code, 'OPERATOR_ONLY');
  });
});
