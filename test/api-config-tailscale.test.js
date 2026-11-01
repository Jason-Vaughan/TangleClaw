'use strict';

/*
 * `tailscaleMode` on `PATCH`/`GET /api/config` (#1380): the config key
 * persists, is boolean-typed, and `GET /api/config` carries the
 * server-resolved `tailscaleStatus` — `lib/tailscale-ingress.js`'s own
 * resolution, reached through the port `_activeListenPort` picks for the
 * install's current `ingressMode`. `lib/tailscale-ingress.js#resolveAdvertisedOrigin`
 * itself is unit-tested in test/tailscale-ingress.test.js; this file is the
 * wiring: the right `enabled`/`port` reach it, and its answer reaches the
 * client under `tailscaleStatus`.
 *
 * `tailscaleIngress.resolveAdvertisedOrigin` is monkeypatched for every test
 * here rather than exercising the real `tailscale` CLI: `lib/routes/config.js`
 * calls it as `tailscaleIngress.resolveAdvertisedOrigin(...)` (a property
 * read at call time, not a destructured reference), so reassigning the
 * property on the same required module object this test and `config.js`
 * both hold is enough to intercept the call — no HTTP-level test seam is
 * needed, and no test in this file starts a real subprocess.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const tailscaleIngress = require('../lib/tailscale-ingress');
const { createServer } = require('../server');
const { operatorHeaders } = require('./_shared-docs-callers');

setLevel('error');

/**
 * Make an HTTP request to the test server, sending the operator's dashboard
 * identity on every write (#2233).
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{status: number, data: object}>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') Object.assign(headers, operatorHeaders(server));
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
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

describe('tailscaleMode on /api/config (#1380)', () => {
  let tmpDir;
  let server;
  let originalResolve;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-tailscale-'));
    store._setBasePath(tmpDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    originalResolve = tailscaleIngress.resolveAdvertisedOrigin;
    // Defense in depth, not just tidiness: `enabled: true` left over from a
    // prior test (every test here PATCHes config, and `store` persists
    // across the whole suite) would otherwise reach the REAL `tailscale`
    // binary on the very next test that forgets to monkeypatch — exactly
    // the subprocess spawn this file's "medium" tier (`test/tiers.json`)
    // declares it never starts. Reset before every test, never after: an
    // assertion failure must not skip the reset and poison the next test.
    await request(server, 'PATCH', '/api/config', { tailscaleMode: false });
  });

  afterEach(() => {
    tailscaleIngress.resolveAdvertisedOrigin = originalResolve;
  });

  it('defaults to disabled, with no reach into tailscale at all', async () => {
    let called = false;
    tailscaleIngress.resolveAdvertisedOrigin = async (opts) => {
      called = true;
      return originalResolve(opts);
    };
    const { status, data } = await request(server, 'GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(called, true, 'the GET route must call through to resolve a status');
    assert.deepEqual(data.tailscaleStatus, { ok: false, reason: 'disabled', detail: tailscaleIngress.FAILURE_MESSAGES.disabled });
  });

  it('PATCH persists tailscaleMode as a boolean', async () => {
    tailscaleIngress.resolveAdvertisedOrigin = async () => ({ ok: false, reason: 'no-dns-name', detail: 'x' });
    const { status, data } = await request(server, 'PATCH', '/api/config', { tailscaleMode: true });
    assert.equal(status, 200);
    assert.equal(data.config.tailscaleMode, true);

    const get = await request(server, 'GET', '/api/config');
    assert.equal(get.data.tailscaleMode, true);
  });

  it('refuses a non-boolean tailscaleMode', async () => {
    const { status, data } = await request(server, 'PATCH', '/api/config', { tailscaleMode: 'yes' });
    assert.equal(status, 400);
    assert.match(data.error, /tailscaleMode must be a boolean/);
  });

  it('passes enabled:true and the direct-mode server port when tailscaleMode is on', async () => {
    // `effectiveServerPort` prefers `TANGLECLAW_PORT` over `config.serverPort`
    // by design (a launched pane's own env) — cleared here so this test
    // exercises the config fallback it is actually about, not the launch env.
    const savedEnvPort = process.env.TANGLECLAW_PORT;
    delete process.env.TANGLECLAW_PORT;
    try {
      // Monkeypatched BEFORE the PATCH that turns tailscaleMode on: that
      // PATCH's own response already resolves `tailscaleStatus` (`_withBindState`
      // runs on every save, not only every GET), so patching afterward would
      // leave that one call hitting the real `tailscale` binary.
      let seen = null;
      tailscaleIngress.resolveAdvertisedOrigin = async (opts) => { seen = opts; return { ok: true, origin: 'https://fake:1', host: 'fake' }; };
      await request(server, 'PATCH', '/api/config', { tailscaleMode: true, ingressMode: 'direct', serverPort: 4455 });

      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.equal(seen.enabled, true);
      assert.equal(seen.port, 4455);
      assert.deepEqual(data.tailscaleStatus, { ok: true, origin: 'https://fake:1', host: 'fake' });
    } finally {
      if (savedEnvPort === undefined) delete process.env.TANGLECLAW_PORT;
      else process.env.TANGLECLAW_PORT = savedEnvPort;
    }
  });

  it('passes the caddy front-door port, not the server-bound one, in caddy mode', async () => {
    let seen = null;
    tailscaleIngress.resolveAdvertisedOrigin = async (opts) => { seen = opts; return { ok: false, reason: 'no-dns-name', detail: 'x' }; };
    await request(server, 'PATCH', '/api/config', { tailscaleMode: true, ingressMode: 'caddy', caddyHttpsPort: 9443, serverPort: 4455 });

    await request(server, 'GET', '/api/config');
    assert.equal(seen.port, 9443);
  });

  it('passes enabled:false and still resolves a port when tailscaleMode is off', async () => {
    await request(server, 'PATCH', '/api/config', { tailscaleMode: false });
    let seen = null;
    tailscaleIngress.resolveAdvertisedOrigin = async (opts) => { seen = opts; return originalResolve(opts); };

    const { data } = await request(server, 'GET', '/api/config');
    assert.equal(seen.enabled, false);
    assert.equal(data.tailscaleStatus.reason, 'disabled');
  });

  it('PATCH response also carries tailscaleStatus, so the control re-renders from the server', async () => {
    const { data } = await request(server, 'PATCH', '/api/config', { chimeMuted: false });
    assert.ok('tailscaleStatus' in data.config, 'the PATCH response must carry it as well');
  });
});
