'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { handleRequest } = require('../server');

// #923 — HEAD must answer with whatever GET would (status, headers, no
// body), on static files, pages, and read-only API routes alike, driven
// through the REAL request handler rather than a reimplementation of its
// dispatch logic.

describe('HEAD requests (#923)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-head-requests-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const cfg = store.config.load();
    cfg.authEnabled = false;
    store.config.save(cfg);
  });

  function mockRes() {
    return {
      statusCode: 0,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
      },
      end(chunk) { if (chunk != null) this.body = chunk; }
    };
  }

  /**
   * One request through the real handler.
   * @param {string} method
   * @param {string} url
   * @returns {Promise<object>}
   */
  async function send(method, url) {
    const req = {
      url, method,
      headers: { host: 'localhost:3102' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) { if (event === 'end') cb(); }
    };
    const res = mockRes();
    await handleRequest(req, res);
    return res;
  }

  it('HEAD / answers exactly what GET answers, minus the body', async () => {
    const get = await send('GET', '/');
    const head = await send('HEAD', '/');
    assert.equal(head.statusCode, get.statusCode);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.body, null, 'HEAD must carry no body');
    assert.ok(get.body, 'precondition: GET actually served a body to compare against');
  });

  it('HEAD on a static asset matches GET, body suppressed', async () => {
    const get = await send('GET', '/manifest.json');
    const head = await send('HEAD', '/manifest.json');
    assert.equal(get.statusCode, 200, 'precondition: the asset exists');
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.body, null);
  });

  it('HEAD on a JSON API route matches GET, body suppressed', async () => {
    const get = await send('GET', '/api/health');
    const head = await send('HEAD', '/api/health');
    assert.equal(get.statusCode, 200);
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.body, null);
  });

  it('HEAD on the login page matches GET, body suppressed', async () => {
    const get = await send('GET', '/login');
    const head = await send('HEAD', '/login');
    assert.equal(get.statusCode, 200);
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, null);
  });

  it('HEAD on a path that 404s under GET also 404s under HEAD, not silently 200', async () => {
    const get = await send('GET', '/api/this-route-does-not-exist');
    const head = await send('HEAD', '/api/this-route-does-not-exist');
    assert.equal(get.statusCode, 404);
    assert.equal(head.statusCode, 404);
    assert.equal(head.body, null);
  });

  it('HEAD never dispatches a mutating route registered only under POST', async () => {
    // /api/auth/login exists and answers POST; nothing registers it (or any
    // other route) under HEAD, so matchRoute(dispatchMethod='GET', ...) must
    // still miss it — confirms HEAD borrows GET's routes, never a method a
    // route was never registered under.
    const head = await send('HEAD', '/api/auth/login');
    assert.equal(head.statusCode, 404);
  });

  it('a real GET request is completely unaffected by the HEAD body-suppression wrapper', async () => {
    // res.end is reassigned only when the REAL method is HEAD (see
    // handleRequest) — this pins that a GET's own res.end is never touched.
    const res = await send('GET', '/api/health');
    assert.equal(res.statusCode, 200);
    assert.ok(res.body, 'a GET must still carry its body');
  });
});
