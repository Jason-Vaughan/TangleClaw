'use strict';

/*
 * #1012 — `/openclaw-direct/<connId>` with no trailing slash served the Control
 * UI index directly. That index's script tag is RELATIVE:
 *
 *     <script type="module" crossorigin src="./assets/index-DUOiCYMK.js">
 *
 * From a base with no trailing slash the browser resolves that to
 * `/openclaw-direct/assets/index-*.js`, where the proxy reads path segment 2 as
 * the connection id — so it looks up a connection literally named "assets",
 * misses, and 404s the bundle. The page renders, the `openclaw-app` web
 * component never registers, and OpenClaw's own error card blames a browser
 * extension: a misdiagnosis three layers from the cause.
 *
 * The fix redirects the bare form to the canonical slashed one. The guard below
 * pins the redirect AND the reason it exists — that the unslashed asset path is
 * genuinely broken — so deleting the redirect fails a test that explains itself.
 *
 * Verified by mutation: dropping the `parts.length === 3` branch from server.js
 * turns the redirect assertions red rather than leaving them vacuously green.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { handleRequest } = require('../server');

setLevel('error');

/**
 * Minimal res double that captures status and headers.
 * @returns {{statusCode:number, headers:object, body:string, writeHead:Function, end:Function}}
 */
function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
    },
    end(chunk) { if (chunk != null) this.body = String(chunk); },
    // The sub-path case pipes a real proxy response into this double, so it has
    // to be writable-shaped. No-ops are enough — the assertions read statusCode.
    on() { return this; },
    once() { return this; },
    emit() { return false; },
    write() { return true; },
    setHeader() {},
    getHeader() { return undefined; }
  };
}

/**
 * Drive a GET through the real request handler.
 * @param {string} url - Raw request target.
 * @returns {Promise<object>} The mock res after handling.
 */
async function get(url) {
  const req = { url, method: 'GET', headers: { host: 'localhost:3102' }, on() {} };
  const res = mockRes();
  await handleRequest(req, res);
  return res;
}

describe('/openclaw-direct/<connId> redirects to the slashed form (#1012)', () => {
  let tmpDir;
  let connId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-slash-'));
    store._setBasePath(tmpDir);
    store.init();
    const conn = store.openclawConnections.create({
      name: 'SlashTest',
      host: '10.0.0.9',
      sshUser: 'admin',
      sshKeyPath: '~/.ssh/id_rsa'
    });
    connId = conn.id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('301s the bare form to the canonical trailing-slash URL', async () => {
    const res = await get(`/openclaw-direct/${connId}`);
    assert.equal(res.statusCode, 301, 'bare form must redirect, not serve the index');
    assert.equal(
      res.headers.Location, `/openclaw-direct/${connId}/`,
      'must point at the slashed form so relative ./assets/* resolve under the connId'
    );
  });

  it('preserves the query string across the redirect', async () => {
    const res = await get(`/openclaw-direct/${connId}?session=main&x=1`);
    assert.equal(res.statusCode, 301);
    assert.equal(
      res.headers.Location, `/openclaw-direct/${connId}/?session=main&x=1`,
      'a dropped query would silently change which session the UI opens'
    );
  });

  it('does NOT redirect a sub-path — those proxy through untouched', async () => {
    // A sub-path reaches the real proxy, which pipes the request body, so this
    // one needs a stream-shaped req. The tunnel port is dead in test, so the
    // proxy errors out to 502 — which is the point: it PROXIED rather than
    // redirected. Redirecting `/chat` would loop the UI's own frame src.
    const req = new PassThrough();
    req.url = `/openclaw-direct/${connId}/chat?session=main`;
    req.method = 'GET';
    req.headers = { host: 'localhost:3102' };
    const res = mockRes();
    await handleRequest(req, res);
    req.end();
    for (let i = 0; i < 100 && res.statusCode === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.notEqual(res.statusCode, 0, 'the proxy must answer, otherwise this asserts nothing');
    assert.notEqual(res.statusCode, 301, '/chat is the path the UI actually uses; redirecting it would loop');
  });

  it('an unknown connection still 404s rather than redirecting into a dead end', async () => {
    const res = await get('/openclaw-direct/no-such-connection');
    assert.equal(res.statusCode, 404, 'redirect must not outrank the connection check');
    assert.match(res.body, /NOT_FOUND/);
  });

  it('the unslashed asset path a bare base produces is genuinely broken — the reason this redirect exists', async () => {
    const res = await get('/openclaw-direct/assets/index-DUOiCYMK.js');
    assert.equal(
      res.statusCode, 404,
      'if this ever stops 404ing, the resolve-by-segment-2 hazard changed and this guard needs rereading'
    );
  });
});
