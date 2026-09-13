'use strict';

// Identity over a REAL HTTP request (#1420, ADR 0016 OQ2): `currentUser` and
// `authStatus` on `/api/server-info` come from TangleClaw's own session and gate
// state, and an inbound `X-Auth-User` header is never believed — on any ingress
// mode, including the caddy-mode shape where Caddy's gate used to set it.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');

const PASSWORD = 'correct-horse-battery';

/**
 * Make a request with optional extra headers and body.
 * @returns {Promise<{status:number, body:any, headers:object}>}
 */
function request(server, method, urlPath, extraHeaders = {}, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Patch the persisted config (merged into DEFAULT_CONFIG on load). */
function setConfig(patch) {
  const config = store.config.load();
  Object.assign(config, patch);
  store.config.save(config);
}

describe('/api/server-info identity comes from the session, never a header (#1420)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-authid-'));
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

  beforeEach(() => {
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    store.getDb().prepare('DELETE FROM users').run();
    setConfig({ ingressMode: 'direct', authEnabled: false });
  });

  /** Sign in and return browser headers carrying the session. */
  async function signIn() {
    const res = await request(server, 'POST', '/api/auth/login', {}, { username: 'rosie', password: PASSWORD });
    assert.equal(res.status, 200, 'precondition: signed in');
    return {
      Cookie: res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; '),
      'Sec-Fetch-Site': 'same-origin'
    };
  }

  it('ignores a forged X-Auth-User in the caddy-mode shape Caddy\'s gate used to populate', async () => {
    // Loopback, no browser markers: the fleet's shape, which the gate lets
    // through an open install — the header is the only claim of identity.
    setConfig({ ingressMode: 'caddy', authEnabled: false });
    const res = await request(server, 'GET', '/api/server-info', { 'X-Auth-User': 'attacker' });
    assert.equal(res.status, 200);
    assert.equal(res.body.currentUser, null);
    assert.equal(res.body.authStatus, 'off');
  });

  it('ignores it through a proxy too — even Caddy\'s own transitional value is not identity', async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: false });
    const res = await request(server, 'GET', '/api/server-info',
      { 'X-Auth-User': 'jason', 'X-Forwarded-For': '100.64.0.7' });
    assert.equal(res.body.currentUser, null);
  });

  it('reports the SESSION\'s user when signed in, whatever header rides along', async () => {
    store.users.create('rosie', PASSWORD);
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    const auth = await signIn();
    const res = await request(server, 'GET', '/api/server-info', { ...auth, 'X-Auth-User': 'attacker' });
    assert.equal(res.status, 200);
    assert.equal(res.body.currentUser, 'rosie');
    assert.equal(res.body.authStatus, 'live');
  });

  it('reports live in DIRECT mode for a signed-in session — the mode no longer decides', async () => {
    store.users.create('rosie', PASSWORD);
    setConfig({ ingressMode: 'direct', authEnabled: true });
    const auth = await signIn();
    const res = await request(server, 'GET', '/api/server-info', auth);
    assert.equal(res.body.authStatus, 'live');
    assert.equal(res.body.currentUser, 'rosie');
  });

  it('reports account-required to a local tool on an install with no account', async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    const res = await request(server, 'GET', '/api/server-info');
    assert.equal(res.status, 200, 'the fleet reads it through the carve-out');
    assert.equal(res.body.authStatus, 'account-required');
    assert.equal(res.body.currentUser, null);
  });

  it('refuses a proxied request on an install with no account, before any identity question', async () => {
    setConfig({ ingressMode: 'caddy', authEnabled: true });
    const res = await request(server, 'GET', '/api/server-info',
      { 'X-Forwarded-For': '100.64.0.7', 'X-Auth-User': 'jason' });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'ACCOUNT_REQUIRED');
  });

  it('stamps a launched session\'s owner from the session, never the header', async () => {
    // `POST /api/sessions/:project` reads the owner the same way; asserted on
    // the source because a launch needs a real engine and project.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf("route('POST', '/api/sessions/:project'");
    const body = src.slice(start, src.indexOf('const result = sessions.launchSession', start));
    assert.match(body, /const owner = \(_req\.tcSession && _req\.tcSession\.username\) \|\| null;/);
    assert.doesNotMatch(body, /x-auth-user|resolveRequestUser/i);
  });
});
