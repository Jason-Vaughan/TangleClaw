'use strict';

// The first-run login, server side, end to end: /api/setup/complete and the
// PATCH /api/config "Skip" path both refuse to finish setup with neither a login
// nor the operator's explicit choice of none (#804, #803); a valid credential is
// validated, becomes TangleClaw's account, and gets a bcrypt Caddy copy where
// `caddy hash-password` answers.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const caddy = require('../lib/caddy');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');
const { writeCaddyStub } = require('./_caddy-stub');
const { installAlwaysAvailableEngine } = require('./_engine-fixture');

setLevel('error');

/**
 * Make a JSON HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: any }>}
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
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('forced first-run admin credential', () => {
  let tmpDir;
  let server;
  let origPath;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-auth2-'));
    const stubDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    // answersVersion:false ON PURPOSE — most of this suite runs as "caddy not
    // installed", the population the old Caddy-keyed rule let finish with no login.
    // The shared helper defaults to TRUE, so this must stay explicit: dropping it
    // silently flips the suite to caddy-present and stops testing that population.
    writeCaddyStub(stubDir, { answersVersion: false });
    origPath = process.env.PATH;
    process.env.PATH = stubDir + path.delimiter + (origPath || '');

    store._setBasePath(tmpDir);
    // Setup refuses to finish with no engine installed, and the bundled
    // profiles detect real CLIs — so without this the result depends on
    // what the host has, passing on a dev Mac and failing on CI.
    installAlwaysAvailableEngine(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Reset config to a fresh, incomplete state with the given ingress mode. */
  function resetConfig(ingressMode) {
    const config = store.config.load();
    config.setupComplete = false;
    config.ingressMode = ingressMode;
    config.authEnabled = false;
    config.basicAuthUser = null;
    config.basicAuthHash = null;
    config.loginOptOutAt = null;
    config.bindAllInterfaces = false;
    store.config.save(config);
    // An account from an earlier case would change which state the gate is in.
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    store.getDb().prepare('DELETE FROM recovery_codes').run();
    store.getDb().prepare('DELETE FROM users').run();
  }

  describe('POST /api/setup/complete', () => {
    beforeEach(() => resetConfig('caddy'));

    it('rejects completion in caddy mode with no admin configured', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 400);
      assert.equal(data.code, 'ADMIN_REQUIRED');
      assert.equal(store.config.load().setupComplete, false);
    });

    it('rejects a too-short admin password (no hashing attempted)', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'short' });
      assert.equal(status, 400);
      assert.match(data.error, /at least 12/);
      assert.equal(store.config.load().setupComplete, false);
    });

    it('rejects a missing adminUser when a password is given', async () => {
      const { status } = await request(server, 'POST', '/api/setup/complete',
        { adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 400);
    });

    it('rejects a password containing the username', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'jason', adminPassword: 'jasons-long-password' });
      assert.equal(status, 400);
      assert.match(data.error, /username/);
    });

    it('validates, hashes, and persists a valid admin credential', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 200);
      assert.equal(data.setupComplete, true);
      // The account setup creates is TangleClaw's own login, and it guards the door
      // whether or not the Caddy config was touched. Reported as in force — the old
      // "cannot confirm anything is enforcing this login" warning described Caddy,
      // and is false of an install whose own login is armed.
      assert.equal(data.ingress.protection, 'account');
      assert.equal(data.ingress.confirmedProtection, true);
      assert.equal(data.ingress.user, 'admin');
      assert.ok(!data.warnings.some((w) => /cannot confirm anything is enforcing/.test(w)),
        'an armed login must not be reported as unenforced');

      const config = store.config.load();
      assert.equal(config.authEnabled, true);
      assert.equal(config.basicAuthUser, 'admin');
      assert.match(config.basicAuthHash, /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
      assert.equal(config.setupComplete, true);
    });

    it('creates the TangleClaw account from the same credential and signs the wizard in (#1420)', async () => {
      // Without this, setting authEnabled leaves the install `account-required`
      // before the response returns, and the wizard's own follow-up requests —
      // the provisioning poll, the dashboard load — meet a login challenge.
      const { status, data, headers } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 200);
      assert.equal(data.account.created, true);
      assert.equal(data.account.required, false);
      assert.equal(data.account.username, 'admin');
      assert.ok(store.users.verify('admin', 'a-strong-passphrase-42'),
        'the password the wizard set is the one that signs in');
      const cookies = headers['set-cookie'] || [];
      assert.ok(cookies.some((c) => c.startsWith('tc_session=')), 'the wizard gets a session');

      // The wizard's follow-up, as its browser sends it: browser-shaped, with the
      // cookie it was just given.
      const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
      const follow = await new Promise((resolve, reject) => {
        const r = http.request({
          hostname: '127.0.0.1', port: server.address().port, path: '/api/setup/provision-status',
          method: 'GET', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' }
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        r.on('error', reject);
        r.end();
      });
      assert.notEqual(follow, 401, 'the wizard\'s poll must not meet the login gate');
    });

    it('returns the new account\'s recovery codes once, and they redeem', async () => {
      // The wizard shows these before anything else: a cutover started by the same
      // response restarts the server, so nothing can be fetched afterwards.
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 200);
      const codes = data.account.recoveryCodes;
      assert.ok(Array.isArray(codes) && codes.length === 8, 'a full set is returned');
      assert.equal(new Set(codes).size, codes.length, 'codes are distinct');
      const user = store.users.getByName('admin');
      assert.equal(store.recoveryCodes.status(user.id).remaining, 8, 'the set is stored for the account');
      // The codes returned are the ones stored — each names this account.
      for (const code of codes) {
        assert.equal(store.recoveryCodes.peek(code).username, 'admin');
      }
    });

    it('still finishes, with no codes, when minting them fails', async () => {
      const real = store.recoveryCodes.replaceForUser;
      store.recoveryCodes.replaceForUser = () => { throw new Error('disk full'); };
      let res;
      try {
        res = await request(server, 'POST', '/api/setup/complete',
          { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      } finally {
        store.recoveryCodes.replaceForUser = real;
      }
      assert.equal(res.status, 200);
      assert.equal(res.data.account.created, true, 'the account is not undone');
      assert.equal(res.data.account.recoveryCodes, null);
    });

    it('keeps an existing TangleClaw account rather than creating a second one', async () => {
      store.users.create('rosie', 'rosies-long-passphrase');
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 200);
      assert.deepEqual(data.account, { created: false, required: false, username: null, recoveryCodes: null });
      assert.equal(store.users.getByName('admin'), null);
      // The account that signs in is rosie's, not the name just typed — so the
      // verdict names no one rather than a user the gate does not know.
      assert.equal(data.ingress.protection, 'account');
      assert.equal(data.ingress.user, null);
    });

    it('reports account.required when setup ends with the gate on and no account', async () => {
      // The adopt shape: a credential already in config, none typed, so there is
      // no plaintext to create an account from. Reached here through a
      // pre-configured credential, which is what the adopt path leaves behind.
      const config = store.config.load();
      config.authEnabled = true;
      config.basicAuthUser = 'jason';
      config.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
      store.config.save(config);
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 200);
      assert.deepEqual(data.account, { created: false, required: true, username: null, recoveryCodes: null });
    });

    it('refuses to finish, without saving, when the gate cannot read its account store (#1420)', async () => {
      // "No account required" would send the wizard into a dashboard that
      // refuses it; the fault must reach the operator, and setup must stay
      // retryable. The request itself is a machine client, so the enforcing
      // `unreadable` gate lets it reach the route.
      const config = store.config.load();
      config.authEnabled = true;
      config.basicAuthUser = 'jason';
      config.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
      store.config.save(config);
      const realPresence = store.authSessions.accountPresence;
      store.authSessions.accountPresence = () => { throw new Error('database is locked'); };
      let res;
      try {
        res = await request(server, 'POST', '/api/setup/complete', {});
      } finally {
        store.authSessions.accountPresence = realPresence;
      }
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'GATE_UNREADABLE');
      assert.equal(store.config.load().setupComplete, false, 'nothing is saved');
    });

    it('accepts completion when an admin is already configured (no new credential)', async () => {
      const config = store.config.load();
      config.authEnabled = true;
      config.basicAuthUser = 'admin';
      config.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
      store.config.save(config);

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 200);
      assert.equal(data.setupComplete, true);
    });
  });

  describe('POST /api/setup/complete — direct mode, with no Caddy installed', () => {
    beforeEach(() => resetConfig('direct'));

    // TangleClaw's login is its own account and needs no Caddy, so a machine with
    // no Caddy is no longer a reason to finish ungated (#804). This suite's caddy
    // stub fails `version`, so detection reports Caddy absent — which is exactly
    // the case the old rule exempted. A login is still demanded; the only way to
    // finish without one is the operator's recorded choice (#803).
    it('refuses to finish with neither a login nor the choice of none', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 400);
      assert.equal(data.code, 'ADMIN_REQUIRED');
      assert.equal(store.config.load().setupComplete, false);
    });

    it('creates the account and arms the login with no Caddy copy when Caddy cannot hash', async () => {
      // A stub that answers nothing: no `version` (Caddy absent) and no
      // `hash-password`. The account must not depend on either.
      const deadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-caddy-dead-'));
      fs.writeFileSync(path.join(deadDir, 'caddy'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
      const origPath = process.env.PATH;
      process.env.PATH = deadDir + path.delimiter + (origPath || '');
      let res;
      try {
        assert.equal(caddy.detectCaddy().available, false, 'the stub must read as no caddy');
        res = await request(server, 'POST', '/api/setup/complete',
          { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      } finally {
        process.env.PATH = origPath;
        fs.rmSync(deadDir, { recursive: true, force: true });
      }
      assert.equal(res.status, 200, JSON.stringify(res.data));
      const config = store.config.load();
      assert.equal(config.authEnabled, true);
      assert.equal(config.basicAuthHash, null, 'no Caddy copy could be made');
      assert.equal(config.basicAuthUser, null, 'the pair is written together or not at all');
      assert.ok(store.users.verify('admin', 'a-strong-passphrase-42'), 'the account signs in');
      assert.equal(res.data.ingress.protection, 'account', 'and it is reported as in force');
      assert.equal(res.data.ingress.reason, null, 'the refusing plan\'s Caddy sentence is not the install\'s story');
    });

    it('finishes without a login when the operator chooses it, and records the choice', async () => {
      const before = Date.now();
      const { status, data } = await request(server, 'POST', '/api/setup/complete', { noLogin: true });
      assert.equal(status, 200, JSON.stringify(data));
      const config = store.config.load();
      assert.equal(config.setupComplete, true);
      assert.equal(config.authEnabled, false);
      assert.ok(Date.parse(config.loginOptOutAt) >= before - 1000, 'the choice is recorded with its time');
      assert.equal(data.ingress.protection, 'none');
      assert.equal(data.ingress.confirmedProtection, false);
      assert.match(data.ingress.reason, /as you chose/);
      assert.ok(data.warnings.some((w) => /as you chose/.test(w)),
        'a warnings-only client still learns the install has no login');
      assert.equal(store.users.getByName('admin'), null);
    });

    it('refuses the choice of no login on a wide bind — never ungated AND reachable', async () => {
      const config = store.config.load();
      config.bindAllInterfaces = true;
      store.config.save(config);
      const { status, data } = await request(server, 'POST', '/api/setup/complete', { noLogin: true });
      assert.equal(status, 400);
      assert.equal(data.code, 'OPT_OUT_REFUSED');
      assert.match(data.error, /every network interface/);
      const after = store.config.load();
      assert.equal(after.setupComplete, false, 'nothing is saved');
      assert.equal(after.loginOptOutAt, null, 'no choice is recorded');
    });

    it('refuses the choice of no login where a login is already in hand, rather than ignoring it', async () => {
      // An install that already has its login (reset-admin --store before setup, say)
      // cannot truthfully finish "without a login". Finishing protected while the
      // response says nothing about the dropped choice would be a quiet false report.
      const config = store.config.load();
      config.authEnabled = true;
      store.config.save(config);
      const { status, data } = await request(server, 'POST', '/api/setup/complete', { noLogin: true });
      assert.equal(status, 400);
      assert.equal(data.code, 'OPT_OUT_REFUSED');
      assert.match(data.error, /already in front of TangleClaw/);
      assert.equal(store.config.load().setupComplete, false);
      assert.equal(store.config.load().loginOptOutAt, null);
    });

    it('rejects a non-boolean noLogin rather than guessing', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete', { noLogin: 'yes' });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.equal(store.config.load().setupComplete, false);
    });

    it('rejects a login and the choice of none sent together', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { noLogin: true, adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.equal(store.config.load().setupComplete, false);
      assert.equal(store.users.getByName('admin'), null, 'no account is created from a contradictory request');
    });

    it('refuses the choice of no login on a completed install', async () => {
      const config = store.config.load();
      config.setupComplete = true;
      store.config.save(config);
      const { status, data } = await request(server, 'POST', '/api/setup/complete', { noLogin: true });
      assert.equal(status, 409);
      assert.equal(data.code, 'SETUP_ALREADY_COMPLETE');
      assert.equal(store.config.load().loginOptOutAt, null);
    });

    it('clears an earlier recorded choice when a login is set', async () => {
      const config = store.config.load();
      config.loginOptOutAt = '2026-01-01T00:00:00.000Z';
      store.config.save(config);
      const { status } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 200);
      assert.equal(store.config.load().loginOptOutAt, null);
    });
  });

  describe('PATCH /api/config — Skip path', () => {
    it('refuses setupComplete=true in caddy mode without an admin', async () => {
      resetConfig('caddy');
      const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 400);
      assert.equal(data.code, 'ADMIN_REQUIRED');
      assert.equal(store.config.load().setupComplete, false);
    });

    it('refuses Skip with no Caddy installed too — the login does not need Caddy', async () => {
      // This case used to ALLOW Skip here, because no Caddy meant nothing could
      // enforce a login. TangleClaw's own login needs no Caddy, so the exemption is
      // gone; Skip never carries the choice of no login, so it is refused into the
      // login step, where that choice is made.
      resetConfig('direct');
      assert.equal(caddy.detectCaddy().available, false, 'this suite\'s stub reads as no caddy');
      const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 400);
      assert.equal(data.code, 'ADMIN_REQUIRED');
      assert.equal(store.config.load().setupComplete, false);
    });

    it('does not refuse a finished install re-sending setupComplete', async () => {
      // An install that finished without a login, by choice, and saves settings
      // with the flag it already has must not be told it needs a login to do so.
      resetConfig('direct');
      const config = store.config.load();
      config.setupComplete = true;
      config.loginOptOutAt = '2026-09-14T00:00:00.000Z';
      store.config.save(config);
      const { status } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 200);
    });

    it('lets Skip finish once a login is in hand', async () => {
      resetConfig('direct');
      const config = store.config.load();
      config.authEnabled = true;
      store.config.save(config);
      const { status } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 200);
      assert.equal(store.config.load().setupComplete, true);
    });

    it('refuses Skip on a direct-mode install that CAN run a gate', async () => {
      // The default fresh install: direct mode, caddy installed. Skip is the other
      // route that can finish setup, so it has to answer to the same rule as
      // /api/setup/complete or it is a way past the login gate.
      //
      // Depends on a stub that answers `version`, NOT on finding a real caddy in
      // /opt/homebrew or /usr/local: CI runs ubuntu-latest with no Caddy, so a
      // real-binary lookup made the regression guard for the most important fix in
      // this chunk skip exactly where it needed to run. The guard has to be
      // deterministic on every machine, or it is not a guard.
      resetConfig('direct');
      const presentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-caddy-present-'));
      writeCaddyStub(presentDir, { answersVersion: true });
      const origPath = process.env.PATH;
      process.env.PATH = presentDir + path.delimiter + (origPath || '');
      try {
        assert.equal(caddy.detectCaddy().available, true, 'the stub must read as an installed caddy');
        const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
        assert.equal(status, 400);
        assert.equal(data.code, 'ADMIN_REQUIRED');
        assert.equal(store.config.load().setupComplete, false, 'a refused Skip must not finish setup');
      } finally {
        process.env.PATH = origPath;
        fs.rmSync(presentDir, { recursive: true, force: true });
      }
    });

    it('allows an unrelated PATCH in caddy mode without an admin (only blocks the complete transition)', async () => {
      resetConfig('caddy');
      const { status } = await request(server, 'PATCH', '/api/config', { chimeEnabled: false });
      assert.equal(status, 200);
    });
  });
});
