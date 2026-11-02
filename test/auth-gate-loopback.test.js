'use strict';

/*
 * `lib/auth-gate.js#isMachineClient`'s opt-in service-token requirement
 * (#1973, Ruling A491-W1D-R2).
 *
 * #1973 was filed assuming #1957 REQ2 (a Codex Full Auto permission profile
 * that grants a sandboxed agent every loopback port) had shipped; it never
 * did — built only on the orphaned branch `fix/1836-codex-fullauto-loopback`,
 * never merged to `main`. Ruling A483 (PR #2709) rejected that profile
 * outright instead ("declare it, don't silently fix it"). So the fleet
 * carve-out's four existing conditions (`test/auth-gate.test.js`) are
 * untouched; this file covers only the fifth, OPT-IN condition Ruling
 * A491-W1D-R2 scoped #1973 down to: `requireServiceToken` /
 * `serviceTokenValid`, inert by default (`MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN
 * === false`) so nothing already depending on the carve-out (`bin/tc`, hooks,
 * PortHub, the switchboard) breaks. Flipping the exported constant to `true`
 * is a `server.js` change, out of this car's file envelope.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const authGate = require('../lib/auth-gate');

const S = authGate.GATE_STATES;

// Same fixture shape as `test/auth-gate.test.js`'s own `local` — a loopback,
// unproxied, non-browser, cookieless request, the one shape the four
// existing conditions all pass.
const local = { loopback: true, proxied: false, browserShaped: false, hasSessionCookie: false };

describe('lib/auth-gate — isMachineClient\'s opt-in service-token requirement (#1973, Ruling A491-W1D-R2)', () => {
  it('MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN defaults to false', () => {
    assert.equal(authGate.MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN, false);
  });

  it('with requireServiceToken omitted, behavior is identical to before this option existed — the four existing conditions decide alone', () => {
    assert.equal(authGate.isMachineClient(local), true);
    assert.equal(authGate.isMachineClient({ ...local, loopback: false }), false);
    assert.equal(authGate.isMachineClient({ ...local, proxied: true }), false);
    assert.equal(authGate.isMachineClient({ ...local, browserShaped: true }), false);
    assert.equal(authGate.isMachineClient({ ...local, hasSessionCookie: true }), false);
  });

  it('with requireServiceToken explicitly false, behaves identically too — an explicit false is not a different code path from the default', () => {
    assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: false }), true);
    assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: false, serviceTokenValid: true }), true,
      'a valid token offered when none was required must not somehow refuse');
  });

  describe('requireServiceToken: true', () => {
    it('refuses an otherwise-qualifying loopback machine caller with no token proof', () => {
      assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true }), false);
    });

    it('refuses when serviceTokenValid is explicitly false', () => {
      assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: false }), false);
    });

    it('refuses a non-boolean serviceTokenValid — fails closed, never coerced to truthy', () => {
      for (const bad of ['true', 1, {}, [], 'yes']) {
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: bad }), false, JSON.stringify(bad));
      }
    });

    it('allows only when serviceTokenValid === true AND all four loopback/non-proxied/non-browser/no-cookie conditions hold', () => {
      assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: true }), true);
      // A valid token does not excuse any of the other four — the token adds
      // a requirement, it never substitutes for one.
      assert.equal(authGate.isMachineClient({ ...local, loopback: false, requireServiceToken: true, serviceTokenValid: true }), false);
      assert.equal(authGate.isMachineClient({ ...local, proxied: true, requireServiceToken: true, serviceTokenValid: true }), false);
      assert.equal(authGate.isMachineClient({ ...local, browserShaped: true, requireServiceToken: true, serviceTokenValid: true }), false);
      assert.equal(authGate.isMachineClient({ ...local, hasSessionCookie: true, requireServiceToken: true, serviceTokenValid: true }), false);
    });
  });

  describe('a malformed requireServiceToken — fails closed, same as an explicit true', () => {
    for (const malformed of ['no', 1, {}, [], 'false']) {
      it(`${JSON.stringify(malformed)} requires serviceTokenValid === true, exactly like true does`, () => {
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: malformed }), false);
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: malformed, serviceTokenValid: true }), true);
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: malformed, serviceTokenValid: false }), false);
      });
    }
  });

  describe('evaluate — the isMachineClient verdict flows through unchanged either way', () => {
    const base = {
      method: 'GET', rawUrl: '/api/ports', pathname: '/api/ports',
      gateState: S.ARMED, session: null, submittedCsrf: null
    };

    it('allows a loopback machine call when requireServiceToken is false (today\'s behavior, unchanged)', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: false });
      assert.deepEqual(authGate.evaluate({ ...base, machineClient }), { action: 'allow' });
    });

    it('challenges the same call when requireServiceToken is true and no token was presented', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: false });
      const result = authGate.evaluate({ ...base, machineClient });
      assert.equal(result.action, 'challenge');
    });

    it('allows the same call when requireServiceToken is true and the token validated', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: true });
      assert.deepEqual(authGate.evaluate({ ...base, machineClient }), { action: 'allow' });
    });
  });

  describe('evaluateUpgrade — the same verdict on the WebSocket handshake path', () => {
    const base = { gateState: S.ARMED, session: null };

    it('allows a loopback machine upgrade when requireServiceToken is false (today\'s behavior, unchanged)', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: false });
      assert.deepEqual(authGate.evaluateUpgrade({ ...base, machineClient }), { action: 'allow' });
    });

    it('refuses the same upgrade when requireServiceToken is true and no token was presented', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: false });
      assert.deepEqual(authGate.evaluateUpgrade({ ...base, machineClient }), { action: 'refuse' });
    });

    it('allows the same upgrade when requireServiceToken is true and the token validated', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: true });
      assert.deepEqual(authGate.evaluateUpgrade({ ...base, machineClient }), { action: 'allow' });
    });
  });
});

describe('server.js — _gateIdentity wires the opt-in end to end (#1973)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const http = require('node:http');
  const store = require('../lib/store');
  const serviceToken = require('../lib/service-token');
  const { createServer } = require('../server');

  let tmpDir;
  let server;

  function send(headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: '/api/master/status', method: 'GET', headers
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gate-1973-'));
    store._setBasePath(tmpDir);
    store.init();
    // Arm the login gate: a bare, cookieless, non-browser-shaped GET is the
    // exact shape the machine-client carve-out exists for — it would
    // otherwise be challenged like any other anonymous caller.
    store.users.create('gate-1973-operator', 'Fixture-Passphrase-2233');
    const armed = store.config.load();
    armed.authEnabled = true;
    store.config.save(armed);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a bare machine call is let through while machineClientRequiresServiceToken is unset (unchanged default)', async () => {
    const res = await send();
    assert.equal(res.status, 200);
  });

  it('the same bare call is challenged once the operator opts in and presents no token', async () => {
    const config = store.config.load();
    config.machineClientRequiresServiceToken = true;
    store.config.save(config);
    try {
      const res = await send();
      assert.equal(res.status, 401);
    } finally {
      config.machineClientRequiresServiceToken = false;
      store.config.save(config);
    }
  });

  it('passes once the opted-in caller presents a valid AUTH-4 service token', async () => {
    const config = store.config.load();
    config.machineClientRequiresServiceToken = true;
    config.serviceTokenEnabled = true;
    serviceToken.ensureTokenWhenEnabled(config);
    store.config.save(config);
    try {
      const res = await send({ Authorization: `Bearer ${config.serviceToken}` });
      assert.equal(res.status, 200);
    } finally {
      config.machineClientRequiresServiceToken = false;
      config.serviceTokenEnabled = false;
      store.config.save(config);
    }
  });

  it('fails CLOSED for the machine-client carve-out when config.json goes unreadable after opting in (PRR-A BLOCKING, round 1)', async () => {
    // Opt in first, as the prior tests do, then corrupt the file directly
    // (bypassing store.config.save, which would refuse or normalize bad
    // JSON) to reach the exact state _gateConfig()'s try/catch exists for.
    const configPath = store._getConfigPath();
    const goodJson = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(goodJson);
    config.machineClientRequiresServiceToken = true;
    store.config.save(config);
    // Warm _gateConfig()'s own last-known-good cache with the OPTED-IN
    // value before corrupting the file — the fix this test guards reads
    // that cache on a read failure, so the regression only reproduces when
    // the cache actually saw the opt-in, same as it would on a real
    // install that opted in and then later lost its config.
    await send();
    const optedInJson = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, '{ not valid json');
    try {
      const res = await send();
      // Refused, not silently waved through as a machine client: an
      // unreadable config is the UNREADABLE gate state, which is meant to
      // enforce, not to reopen the loopback carve-out this opt-in exists to
      // close.
      assert.notEqual(res.status, 200);
    } finally {
      fs.writeFileSync(configPath, optedInJson);
      const restored = store.config.load();
      restored.machineClientRequiresServiceToken = false;
      store.config.save(restored);
    }
  });

  it('keeps the pre-#1973 carve-out when config.json goes unreadable on an install that never opted in', async () => {
    // The regression the first version of the fail-closed fix introduced:
    // unconditionally requiring a token on ANY config-read failure broke
    // this exact scenario for the entire fleet, not just opted-in
    // installs — caught by test/launch-recovery-clear.test.js in CI, not
    // locally. An install that never set machineClientRequiresServiceToken
    // must keep today's behavior when its config breaks for an unrelated
    // reason: a bare machine-shaped request still reaches the route (and
    // whatever THAT route's own launch-binding floor decides), rather than
    // being challenged by the login gate as if it were a browser.
    const configPath = store._getConfigPath();
    const goodJson = fs.readFileSync(configPath, 'utf8');
    // Warm the cache with a config that has NEVER opted in.
    await send();
    fs.writeFileSync(configPath, '{ not valid json');
    try {
      const res = await send();
      // Not the login gate's 401 challenge: machineClient:true still
      // carries this request past `authGate.evaluate`, same as before
      // #1973 existed. Whatever happens after that is a separate concern —
      // GET /api/master/status reads config itself too, and genuinely
      // cannot serve a normal answer while it is unreadable (500), which
      // is not what this test is about.
      assert.notEqual(res.status, 401, JSON.stringify(res));
    } finally {
      fs.writeFileSync(configPath, goodJson);
    }
  });
});
