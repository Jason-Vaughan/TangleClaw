'use strict';

// Finishing setup now puts a login in force by default, and says plainly when it
// cannot. Two routes carry that: POST /api/setup/complete acts, and
// GET /api/setup/provision-status reports how the detached cutover ended.
//
// The property every case here defends: setup must never end with a credential
// collected and nothing enforcing it, reported as success. That is strictly worse
// than today's honest absence — an operator who knows they have no login behaves
// accordingly, one who believes they have one does not.
//
// The cutover spawner is stubbed throughout. A real one rewrites launchd plists
// and restarts the machine's TangleClaw server, which on a developer's box is the
// live install; lib/ingress-provision.js refuses a real spawn from a test
// process, so a missed stub fails rather than causing an outage.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const caddy = require('../lib/caddy');
const provision = require('../lib/ingress-provision');
const { createServer, _setRestartScheduler, _setCutoverSpawner } = require('../server');

setLevel('error');

// Exactly 53 chars of [./A-Za-z0-9] after `$2a$14$` — the real bcrypt shape.
const BCRYPT_A = '$2a$14$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0';
const BCRYPT_B = '$2a$14$zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA9';

/**
 * Make a request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: any, raw: string }>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * POST /api/setup/complete with an explicit Host header.
 * @param {http.Server} server
 * @param {string} host - Raw Host header value.
 * @param {object} body
 * @returns {Promise<{ status: number, data: any, raw: string }>}
 */
function requestWithHost(server, host, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: '/api/setup/complete', method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: host }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** A hand-edited Caddyfile (no integrity stamp) carrying the given credential lines. */
function handEdited(credentialLines) {
  return [
    '# maintained by hand',
    'localhost {',
    '\tbasic_auth {',
    ...credentialLines.map((l) => `\t\t${l}`),
    '\t}',
    '\treverse_proxy 127.0.0.1:3102',
    '}',
    ''
  ].join('\n');
}

describe('setup provisions a login by default', () => {
  let tmpDir;
  let server;
  let cutovers;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-provisioning-'));
    store._setBasePath(tmpDir);
    store.init();
    _setRestartScheduler(() => {});
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const p = caddy.getCaddyfilePath();
    if (fs.existsSync(p)) fs.rmSync(p);
    fs.rmSync(provision.resultPath(), { force: true });
    cutovers = [];
    _setCutoverSpawner((opts) => { cutovers.push(opts); return { ok: true, pid: 321, error: null }; });
    // Fresh-install shape: setup not finished, no credential anywhere. Every
    // field any case in this suite mutates is restored here — a leaked
    // caddyHttpsPort or bindAllInterfaces makes a later case assert against the
    // previous one's state, which reads as a product bug.
    const config = store.config.load();
    config.setupComplete = false;
    config.ingressMode = 'direct';
    config.authEnabled = false;
    config.basicAuthUser = null;
    config.basicAuthHash = null;
    config.caddyHttpsPort = 8443;
    config.bindAllInterfaces = false;
    store.config.save(config);
  });

  /** Write a Caddyfile at the live path. */
  function writeLive(content) {
    const p = caddy.getCaddyfilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  /** Make caddy undetectable for the duration of `fn`. */
  async function withoutCaddy(fn) {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nocaddy-'));
    const origPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      return await fn();
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  }

  describe('the credential is required, not optional', () => {
    it('refuses to finish setup with no credential on a machine that can run a gate', async () => {
      // The flip: this install is still in DIRECT mode, and it is refused anyway.
      // Before, only an already-caddy install demanded one — which is how a fresh
      // install finished wide open.
      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'ADMIN_REQUIRED');
      assert.equal(cutovers.length, 0, 'nothing may be provisioned without a credential');
      assert.equal(store.config.load().setupComplete, false, 'a refused setup must not mark itself done');
    });

    it('does NOT demand a credential when no gate can be put up', async () => {
      // Refusing here would strand the operator: there is nothing to protect
      // them with, so demanding a password would block setup for no benefit.
      writeLive('# my own proxy\nlocalhost {\n\treverse_proxy 127.0.0.1:3102\n}\n');
      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.action, 'refuse');
      assert.equal(cutovers.length, 0);
    });
  });

  describe('provision — absent or generated Caddyfile', () => {
    it('persists the credential, starts a detached cutover, and reports pending', async () => {
      const res = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: tmpDir, adminUser: 'jason', adminPassword: 'correct-horse-battery'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.action, 'provision');
      assert.equal(res.data.ingress.provisioning, true);
      assert.equal(res.data.ingress.protection, 'pending');
      assert.equal(res.data.ingress.user, 'jason');
      assert.equal(cutovers.length, 1);
      assert.equal(cutovers[0].target, 'caddy');

      const config = store.config.load();
      assert.equal(config.authEnabled, true);
      assert.equal(config.basicAuthUser, 'jason');
      assert.ok(config.basicAuthHash, 'the credential must be persisted before the cutover runs');
      assert.equal(config.setupComplete, true);
    });

    it('names the address the gate will listen on, built from the host the operator used', async () => {
      // `localhost` is what a fresh Caddyfile's local site says, and it is not
      // where a remote operator is standing.
      const config = store.config.load();
      config.caddyHttpsPort = 9443;
      store.config.save(config);
      const res = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: tmpDir, adminUser: 'jason', adminPassword: 'correct-horse-battery'
      });
      assert.equal(res.data.ingress.url, 'https://127.0.0.1:9443');
    });

    it('discards a Host header that is not a hostname rather than echoing it into the URL', async () => {
      // The URL goes back to the browser and is rendered into markup, including
      // an inline event handler. `Host` is caller-supplied, so anything outside a
      // hostname's alphabet is dropped — escaping would not do: an HTML-entity
      // quote decodes back to a quote before the script sees it.
      const res = await requestWithHost(server, "evil'+alert(1)+'.example", {
        projectsDir: tmpDir, adminUser: 'jason', adminPassword: 'correct-horse-battery'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.url, 'https://localhost:8443',
        'a malformed Host must fall back, not round-trip');
      assert.ok(!/alert\(1\)/.test(res.raw), 'the response echoed script-shaped text back');
    });

    it('keeps a legitimate hostname, so a remote operator gets their own address', async () => {
      const res = await requestWithHost(server, 'cursatory.tail123678.ts.net:8443', {
        projectsDir: tmpDir, adminUser: 'jason', adminPassword: 'correct-horse-battery'
      });
      assert.equal(res.data.ingress.url, 'https://cursatory.tail123678.ts.net:8443');
    });

    it('clears a previous run\'s outcome before starting, so a stale ok cannot be read as this one', async () => {
      fs.writeFileSync(provision.resultPath(), JSON.stringify({ ok: true, code: 'ok', target: 'caddy' }));
      await request(server, 'POST', '/api/setup/complete', {
        projectsDir: tmpDir, adminUser: 'jason', adminPassword: 'correct-horse-battery'
      });
      const status = await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(status.data.state, 'pending', 'the poll read a previous run as this one');
    });

    it('says plainly that nothing is enforcing the login when the cutover cannot start', async () => {
      // The failure this whole path exists to make unmistakable.
      _setCutoverSpawner(() => ({ ok: false, pid: null, error: 'EPERM' }));
      const res = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: tmpDir, adminUser: 'jason', adminPassword: 'correct-horse-battery'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.provisioning, false);
      assert.equal(res.data.ingress.protection, 'none');
      assert.match(res.data.ingress.reason, /nothing is enforcing it/);
      assert.ok(res.data.ingress.remedy, 'the operator needs the command that fixes it');
      assert.ok(
        res.data.warnings.some((w) => /nothing is enforcing it/.test(w)),
        'a client that only reads warnings must still learn it is ungated'
      );
    });
  });

  describe('adopt — a working hand-rolled gate is already there', () => {
    it('keeps the existing login instead of collecting or provisioning a second one', async () => {
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.action, 'adopt');
      assert.equal(res.data.ingress.protection, 'existing');
      assert.equal(res.data.ingress.user, 'jason');
      assert.equal(cutovers.length, 0, 'adopting must never regenerate the file');

      const config = store.config.load();
      assert.equal(config.authEnabled, true);
      assert.equal(config.basicAuthUser, 'jason');
    });

    it('leaves the operator\'s Caddyfile byte-for-byte untouched', async () => {
      const content = handEdited([`jason ${BCRYPT_A}`]);
      writeLive(content);
      await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(fs.readFileSync(caddy.getCaddyfilePath(), 'utf8'), content);
    });
  });

  describe('refuse — nothing may be written', () => {
    it('finishes ungated, and says so, for a config with several logins', async () => {
      writeLive(handEdited([`jason ${BCRYPT_A}`, `alex ${BCRYPT_B}`]));
      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.action, 'refuse');
      assert.equal(res.data.ingress.protection, 'none');
      assert.ok(res.data.ingress.reason);
      assert.ok(res.data.ingress.remedy);
      assert.equal(cutovers.length, 0);
      assert.equal(store.config.load().authEnabled, false, 'refusing must not claim protection');
    });

    it('reports network exposure from the bind classification, not from a guess', async () => {
      // "Ungated but loopback-only" and "ungated and reachable" are different
      // situations, and the second is the one an operator must be told about. A
      // legacy install is held on a wide binding on purpose (lib/bind-policy.js),
      // so the wizard cannot assume loopback.
      writeLive(handEdited([`jason ${BCRYPT_A}`, `alex ${BCRYPT_B}`]));
      const config = store.config.load();
      config.bindAllInterfaces = true;
      store.config.save(config);
      const wide = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(wide.data.ingress.networkExposed, true);

      const c2 = store.config.load();
      c2.bindAllInterfaces = false;
      c2.setupComplete = false;
      store.config.save(c2);
      const narrow = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(narrow.data.ingress.networkExposed, false);
    });

    it('finishes ungated when caddy is not installed, and names the fix', async () => {
      const res = await withoutCaddy(() =>
        request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir }));
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.action, 'refuse');
      assert.equal(res.data.ingress.protection, 'none');
      assert.match(res.data.ingress.reason, /not installed/);
      assert.match(res.data.ingress.remedy, /install/i);
      assert.equal(cutovers.length, 0);
    });

    it('does not adopt a credential from a config nothing is running', async () => {
      // An adoptable Caddyfile plus no caddy binary. Adopting would flip
      // authEnabled on an install with no gate in front of it.
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      const res = await withoutCaddy(() =>
        request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir }));
      assert.equal(res.data.ingress.action, 'refuse');
      assert.equal(store.config.load().authEnabled, false);
    });

    it('warns when a credential is stored but the ingress was left untouched', async () => {
      // An operator who already has a credential and a hand-maintained config:
      // the credential is saved, and activating the gate belongs at a terminal
      // where the cutover's backup and rollback exist.
      const config = store.config.load();
      config.authEnabled = true;
      config.basicAuthUser = 'admin';
      config.basicAuthHash = BCRYPT_A;
      store.config.save(config);
      writeLive('# my own proxy\nlocalhost {\n\treverse_proxy 127.0.0.1:3102\n}\n');

      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.data.ingress.protection, 'unchanged');
      assert.ok(res.data.warnings.some((w) => /ingress-cutover/.test(w)));
      assert.equal(cutovers.length, 0);
    });
  });

  describe('provisioning is a first-run action only', () => {
    it('does not start a cutover when setup is already complete', async () => {
      // This route never required setup to be unfinished, and it can now rewrite
      // launchd plists and restart the server. On an install that is ungated AND
      // network-reachable (the legacy grace state) a re-POST would otherwise hand
      // an unauthenticated caller a service restart.
      const config = store.config.load();
      config.setupComplete = true;
      store.config.save(config);

      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.action, 'refuse');
      assert.match(res.data.ingress.reason, /already complete/);
      assert.equal(cutovers.length, 0, 'a completed install must not be cut over by this route');
    });

    it('does not demand a credential from a completed install either', async () => {
      // The demand exists to stop a FIRST run finishing unprotected. Applying it
      // to a re-POST would make an unrelated field update impossible instead.
      const config = store.config.load();
      config.setupComplete = true;
      store.config.save(config);

      const res = await request(server, 'POST', '/api/setup/complete', { chimeEnabled: false });
      assert.equal(res.status, 200);
      assert.equal(store.config.load().chimeEnabled, false, 'the update still applied');
    });
  });

  describe('GET /api/setup/provision-status', () => {
    it('reports pending — not failed — while no outcome has been written', async () => {
      const res = await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(res.status, 200);
      assert.equal(res.data.state, 'pending');
      assert.equal(res.data.ok, null);
      assert.equal(res.data.code, null);
    });

    it('reports the outcome and its code once the child has finished', async () => {
      fs.writeFileSync(provision.resultPath(), JSON.stringify({
        ok: true, code: 'ok', target: 'caddy', healthOk: true,
        finishedAt: '2026-07-29T12:00:00.000Z'
      }));
      const res = await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(res.data.state, 'done');
      assert.equal(res.data.ok, true);
      assert.equal(res.data.code, 'ok');
      assert.equal(res.data.healthOk, true);
      assert.equal(res.data.finishedAt, '2026-07-29T12:00:00.000Z');
    });

    it('passes a refusal code through unchanged, so the wizard can explain it', async () => {
      fs.writeFileSync(provision.resultPath(), JSON.stringify({
        ok: false, code: 'ungate-refused', target: 'caddy', error: 'no credential in config'
      }));
      const res = await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(res.data.state, 'done');
      assert.equal(res.data.ok, false);
      assert.equal(res.data.code, 'ungate-refused');
      assert.match(res.data.error, /no credential/);
    });

    it('reports a corrupt outcome file as unreadable rather than as still pending', async () => {
      fs.writeFileSync(provision.resultPath(), '{ not json');
      const res = await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(res.data.state, 'unreadable');
      assert.equal(res.data.ok, null);
      assert.ok(res.data.error);
    });

    it('discloses no paths, usernames or hashes', async () => {
      fs.writeFileSync(provision.resultPath(), JSON.stringify({
        ok: true, code: 'ok', target: 'caddy',
        healthUrl: 'https://localhost:8443/api/health',
        caddyfilePath: '/Users/someone/.tangleclaw/Caddyfile',
        basicAuthUser: 'jason', basicAuthHash: BCRYPT_A
      }));
      const res = await request(server, 'GET', '/api/setup/provision-status');
      assert.ok(!res.raw.includes('jason'), 'response leaked a username');
      assert.ok(!/\$2[aby]\$/.test(res.raw), 'response carried something bcrypt-shaped');
      assert.ok(!res.raw.includes('/Users/'), 'response leaked a filesystem path');
    });

    it('never writes or creates the outcome file as a side effect of polling', async () => {
      assert.equal(fs.existsSync(provision.resultPath()), false);
      await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(fs.existsSync(provision.resultPath()), false);
    });
  });
});
