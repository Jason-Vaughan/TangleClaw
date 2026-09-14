'use strict';

// #804 — "a credential is mandatory here" is derived once and consumed three
// times: GET /api/setup/ingress-state (what the wizard shows), POST
// /api/setup/complete, and PATCH /api/config { setupComplete: true } (Skip).
// When each spelled the rule out itself, it was changed at one route and not
// the other and Skip became a way past the login.
//
// Two checks. The scenario table asks all three the same question on the same
// machine and requires the same answer. The swap check replaces the one
// derivation and requires all three to follow it — which a route still carrying
// its own copy of the rule would not.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const setupCredential = require('../lib/setup-credential');
const { createServer, _setRestartScheduler, _setCutoverSpawner } = require('../server');
const { installCaddyStub, withoutCaddy } = require('./_caddy-stub');
const { installAlwaysAvailableEngine } = require('./_engine-fixture');

setLevel('error');

/**
 * Make a JSON request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: any }>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('the credential rule has one owner (#804)', () => {
  let caddyStub;
  let tmpDir;
  let server;

  before(async () => {
    caddyStub = installCaddyStub();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cred-uniform-'));
    store._setBasePath(tmpDir);
    installAlwaysAvailableEngine(tmpDir);
    store.init();
    _setRestartScheduler(() => {});
    _setCutoverSpawner(() => ({ ok: true, pid: 1, error: null }));
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    caddyStub.restore();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A fresh, unfinished install with the given overrides.
   * @param {object} overrides
   */
  function freshInstall(overrides) {
    const c = store.config.load();
    Object.assign(c, {
      setupComplete: false, ingressMode: 'direct', authEnabled: false,
      basicAuthUser: null, basicAuthHash: null, bindAllInterfaces: false, loginOptOutAt: null
    }, overrides);
    store.config.save(c);
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    store.getDb().prepare('DELETE FROM recovery_codes').run();
    store.getDb().prepare('DELETE FROM users').run();
    const p = require('../lib/caddy').getCaddyfilePath();
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  /**
   * Ask all three consumers, each on its own fresh install, and return their answers.
   * @param {object} overrides - Config for the scenario.
   * @returns {Promise<{ probe: object, completeRequired: boolean, skipRequired: boolean,
   *   optOutHonoured: boolean }>}
   */
  async function askAll(overrides) {
    freshInstall(overrides);
    const probe = (await request(server, 'GET', '/api/setup/ingress-state')).data.credential;

    freshInstall(overrides);
    const complete = await request(server, 'POST', '/api/setup/complete', {});

    freshInstall(overrides);
    const skip = await request(server, 'PATCH', '/api/config', { setupComplete: true });

    freshInstall(overrides);
    const optOut = await request(server, 'POST', '/api/setup/complete', { noLogin: true });

    return {
      probe,
      completeRequired: complete.data.code === 'ADMIN_REQUIRED',
      skipRequired: skip.data.code === 'ADMIN_REQUIRED',
      optOutHonoured: optOut.status === 200
    };
  }

  const SCENARIOS = [
    { name: 'direct mode, Caddy present, loopback', overrides: {} },
    { name: 'direct mode, wide bind', overrides: { bindAllInterfaces: true } },
    { name: 'caddy mode, no Caddyfile yet', overrides: { ingressMode: 'caddy' } },
    { name: 'a login already in hand', overrides: { authEnabled: true } }
  ];

  for (const scenario of SCENARIOS) {
    it(`agrees across the probe, Finish and Skip: ${scenario.name}`, async () => {
      const a = await askAll(scenario.overrides);
      assert.equal(typeof a.probe.required, 'boolean', 'the probe ships the answer');
      assert.equal(a.completeRequired, a.probe.required, 'Finish enforces what the probe showed');
      assert.equal(a.skipRequired, a.probe.required, 'Skip enforces what the probe showed');
      // A satisfied install finishes either way; otherwise the choice of none is
      // honoured exactly when the probe offered it.
      if (a.probe.required) {
        assert.equal(a.optOutHonoured, a.probe.optOutAllowed, 'the choice of none is honoured where offered');
      }
    });
  }

  it('agrees with no Caddy installed at all', async () => {
    const a = await withoutCaddy(() => askAll({}));
    assert.equal(a.probe.required, true, 'the login needs no Caddy');
    assert.equal(a.completeRequired, true);
    assert.equal(a.skipRequired, true);
    assert.equal(a.optOutHonoured, a.probe.optOutAllowed);
  });

  it('all three follow the one derivation when it changes', async () => {
    // Swap the decision for one that never requires a login and never allows the
    // choice of none. A consumer still spelling the rule out itself keeps its old
    // answer and fails here.
    const real = setupCredential.decideCredential;
    setupCredential.decideCredential = () => ({
      satisfied: false, required: false, optOutAllowed: false,
      optOutRefusal: { code: 'SWAPPED', reason: 'swapped for the test' }
    });
    let a;
    try {
      a = await askAll({});
    } finally {
      setupCredential.decideCredential = real;
    }
    assert.equal(a.probe.required, false);
    assert.equal(a.probe.optOutRefusal.code, 'SWAPPED');
    assert.equal(a.completeRequired, false, 'Finish asks the derivation');
    assert.equal(a.skipRequired, false, 'Skip asks the derivation');
    assert.equal(a.optOutHonoured, false, 'the choice of none is refused where the derivation refuses it');
  });
});
