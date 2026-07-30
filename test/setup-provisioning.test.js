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
const { installCaddyStub } = require('./_caddy-stub');

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

/** Call the real module spawner — reaches its test-process interlock, never a cutover. */
function provisionModuleSpawn(opts) {
  return provision.spawnCutover(opts);
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
  let caddyStub;
  let tmpDir;
  let server;
  let cutovers;

  before(async () => {
    // Caddy must be PRESENT deterministically. detectCaddy() shells out to
    // `caddy version`, so without this the suite inherits the host's answer —
    // green on a dev Mac that has Caddy, 17 failures on CI that does not.
    caddyStub = installCaddyStub();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-provisioning-'));
    store._setBasePath(tmpDir);
    store.init();
    _setRestartScheduler(() => {});
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    caddyStub.restore();
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

    it('provisions through the real module, so the module\'s own guards apply', async () => {
      // Clearing a previous outcome before the child starts is now spawnCutover's
      // job rather than this route's (pinned in test/ingress-provision.test.js), so
      // it cannot be asserted through a stubbed spawner. What this route is
      // responsible for is going through that module at all — proved here by
      // removing the stub and observing the module's test-process interlock, which
      // only exists inside lib/ingress-provision.js.
      _setCutoverSpawner((opts) => provisionModuleSpawn(opts));
      const res = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: tmpDir, adminUser: 'jason', adminPassword: 'correct-horse-battery'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.provisioning, false,
        'the interlock refused a real cutover, which is the module speaking');
      assert.match(res.data.ingress.reason, /nothing is enforcing it/);
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
    /** Put the install behind Caddy — adoption only claims protection when it is live. */
    function caddyIsLive() {
      const c = store.config.load();
      c.ingressMode = 'caddy';
      store.config.save(c);
    }

    it('keeps the existing login instead of collecting or provisioning a second one', async () => {
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      caddyIsLive();
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

    it('does not restate a login that IS in force as a warning', async () => {
      // `reason` on the adopt-success path describes a working gate — "will be kept
      // rather than replaced". The post-chain push is scoped to the ungated protection
      // states precisely so a protected outcome cannot manufacture a problem to report.
      // Verified by mutation: widening that condition to include 'existing' left every
      // other assertion in this file, and the whole frontend suite, green.
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      caddyIsLive();
      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.data.ingress.protection, 'existing');
      assert.match(res.data.ingress.reason, /kept rather than replaced/);
      assert.ok(!res.data.warnings.some((w) => /kept rather than replaced/.test(w)),
        'a login that is in force must not be restated as a warning');
    });

    it('leaves the operator\'s Caddyfile byte-for-byte untouched', async () => {
      const content = handEdited([`jason ${BCRYPT_A}`]);
      writeLive(content);
      caddyIsLive();
      await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(fs.readFileSync(caddy.getCaddyfilePath(), 'utf8'), content);
    });

    it('will not call an on-disk login "kept" when Caddy is not the active ingress', async () => {
      // `ingress-cutover.js --rollback` leaves exactly this shape behind: a gated
      // Caddyfile with Caddy unloaded and ingressMode back to direct. Adopting
      // there would set authEnabled on an install with nothing in front of it.
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.data.ingress.action, 'refuse');
      assert.equal(res.data.ingress.protection, 'none');
      assert.equal(store.config.load().authEnabled, false);
    });

    it('names the mismatch when a credential is typed on a machine that would adopt', async () => {
      // Reachable through the wizard: the Skip route refuses in caddy mode without a
      // configured credential, so the wizard forces the admin step and sends one on an
      // adopt plan. Adoption runs first, then the typed credential overwrites it in
      // config — while the hand-maintained Caddyfile still enforces the adopted hash.
      // The operator's new password will not work and their old one will, so reporting
      // "existing login kept" (and naming the ADOPTED user) is the wrong answer twice.
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      caddyIsLive();
      const res = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: tmpDir, adminUser: 'newadmin', adminPassword: 'correct-horse-battery'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.protection, 'existing-unverified',
        'must not report the existing login as simply kept');
      assert.equal(res.data.ingress.user, 'newadmin', 'must name the account THEY set, not the adopted one');
      assert.equal(store.config.load().basicAuthUser, 'newadmin',
        'config holds the typed credential — which is precisely why the mismatch must be reported');
      assert.match(res.data.ingress.reason, /still enforcing the credential it already had/);
      assert.match(res.data.ingress.remedy, /reset-admin/);
      // In `warnings` as well as `reason`, like every other ungated outcome: a client
      // that reads only `warnings` must still learn the saved credential is not the one
      // being enforced. The wizard shows it once because `_warningsBlock` de-duplicates
      // against what the screen already printed — the API does not narrow itself for it.
      assert.ok(res.data.warnings.some((w) => /still enforcing/.test(w)),
        'a client that reads only warnings must still learn the credential is not enforced');
      assert.equal(cutovers.length, 0, 'the hand-maintained file must still not be regenerated');
      assert.equal(fs.readFileSync(caddy.getCaddyfilePath(), 'utf8'), handEdited([`jason ${BCRYPT_A}`]),
        'the operator\'s Caddyfile must be untouched');
    });

    it('does not claim an existing login was kept when adoption no-opped', async () => {
      // computeCaddyfileAdoption never overwrites a credential already in config,
      // so on an install that has one, adoption is a no-op while the live
      // hand-maintained file may enforce a DIFFERENT credential. Reporting
      // "existing" from a config predicate is how that drift goes unseen.
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      caddyIsLive();
      const c = store.config.load();
      c.authEnabled = true;
      c.basicAuthUser = 'someone-else';
      c.basicAuthHash = BCRYPT_B;
      store.config.save(c);

      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.data.ingress.protection, 'existing-unverified');
      assert.match(res.data.ingress.reason, /cannot tell whether they carry the same/);
      assert.ok(res.data.warnings.some((w) => /cannot tell/.test(w)));
    });

    it('still offers a next step when a completed install re-POSTs', async () => {
      // The eighth path, and the one the seven-state table never covered: when setup is
      // already complete the plan is built WITHOUT decideProvisioning, so its `remedy` is
      // null. Removing the command from the warning left this path with the situation
      // described and nothing to do about it — strictly worse than the wrong command.
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      const c = store.config.load();
      c.setupComplete = true;
      c.authEnabled = true;
      c.basicAuthUser = 'admin';
      c.basicAuthHash = BCRYPT_A;
      store.config.save(c);

      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.status, 200);
      assert.equal(res.data.ingress.protection, 'unchanged');
      assert.ok(res.data.warnings.some((w) => /cannot confirm anything is enforcing/.test(w)));
      assert.ok(res.data.ingress.remedy && res.data.ingress.remedy.trim().length > 0,
        'a completed install must not be left with a warning and no next step');
      assert.match(res.data.ingress.remedy, /--dry-run/,
        'the fallback must be the one instruction that writes nothing and is honest in every state');
      assert.equal(cutovers.length, 0, 'reporting must never act');
    });

    it('refuses outright when adoption declines and no credential is configured', async () => {
      // Why the "could not be adopted" answer in the adopt block is unreachable, pinned
      // as behavior rather than left as a comment someone can quietly invalidate.
      //
      // A config carrying basicAuthUser with no hash — an interrupted reset-admin, or a
      // hand-edited config.json — makes adoption decline with 'config-already-has-credential'
      // while the complete-credential branch does not match either. That is the only way to
      // reach the final arm. But an `adopt` plan exists only in caddy mode, and the caddy-mode
      // credential gate refuses BEFORE the ingress answer is composed, so the request never
      // gets there: setup is refused instead of finishing ungated, which is the stronger
      // behavior. If the gate is ever reordered, this goes red and that arm becomes live code.
      writeLive(handEdited([`jason ${BCRYPT_A}`]));
      caddyIsLive();
      const c = store.config.load();
      c.basicAuthUser = 'half-written';
      c.basicAuthHash = null;
      c.authEnabled = false;
      store.config.save(c);

      const res = await request(server, 'POST', '/api/setup/complete', { projectsDir: tmpDir });
      assert.equal(res.status, 400, 'an install that cannot confirm a login must not finish setup');
      assert.equal(res.data.code, 'ADMIN_REQUIRED');
      assert.equal(store.config.load().setupComplete !== true, true, 'setup must not be marked complete');
      assert.equal(cutovers.length, 0, 'the hand-maintained file must not be regenerated');
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
      // The case that reaches NO arm of the ingress answer: `reason` comes from the
      // plan and nothing below sets it. Pushing per-arm left the plainest ungated
      // install of all — no Caddy, no credential anywhere — telling a client that
      // reads only `warnings` nothing at all. The single post-chain push covers it.
      assert.ok(res.data.warnings.some((w) => /not installed/.test(w)),
        'a warnings-only client must learn an install with no gate at all is ungated');
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
      assert.ok(res.data.warnings.some((w) => /cannot confirm anything is enforcing/.test(w)),
        'the operator must still be told nothing is known to be enforcing the login');
      // The warning states the situation and names NO command. A bare `--to caddy` is
      // the form the cutover refuses on a hand-edited Caddyfile — which every path to
      // this state has — so recommending it here put the failing form on the same
      // screen as `remedy`'s working one.
      assert.ok(!res.data.warnings.some((w) => /ingress-cutover/.test(w)),
        'the warning must not name a command the cutover would refuse');
      // It also must not name the Caddyfile as what governs protection: two states
      // reaching this arm have nothing serving that file at all.
      assert.ok(!res.data.warnings.some((w) => /that file already makes it/.test(w)),
        'the warning must not claim the Caddyfile determines whether the login is active');
      assert.match(res.data.ingress.remedy, /--force/,
        'the state-specific command belongs in remedy, and on a hand-edited file it needs --force');
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
      // The code is the contract; the free-text reason is not returned (see the
      // disclosure case below). The wizard is told there IS one and where to read it.
      assert.equal(res.data.hasError, true);
      assert.equal(res.data.error, undefined);
      assert.ok(res.data.logLocation, 'the operator needs somewhere to read the reason');
    });

    it('reports a corrupt outcome file as unparseable rather than as still pending', async () => {
      fs.writeFileSync(provision.resultPath(), '{ not json');
      const res = await request(server, 'GET', '/api/setup/provision-status');
      // Deliberately NOT `unreadable`: that word already means "the Caddyfile
      // could not be read" on this endpoint family, and one name for two unrelated
      // conditions is how a caller answers the wrong one.
      assert.equal(res.data.state, 'unparseable-result');
      assert.notEqual(res.data.state, 'unreadable');
      assert.equal(res.data.ok, null);
      assert.equal(res.data.hasError, true);
      assert.ok(res.data.logLocation, 'the operator needs somewhere to read what was in it');
    });

    it('discloses no paths, usernames or hashes — including through `error`', async () => {
      // The earlier version of this test put the path in a `caddyfilePath` key the
      // route's allow-list drops, and left `error` empty: it exercised the field
      // that cannot leak and skipped the one that can. The producer fills `error`
      // with absolute paths on codes the wizard can actually reach —
      // "Caddyfile cannot be read: <path>", `caddy validate` stderr, a backup path
      // — and this route has no setupComplete gate in front of it.
      fs.writeFileSync(provision.resultPath(), JSON.stringify({
        ok: false, code: 'validate-failed', target: 'caddy',
        error: 'generated Caddyfile failed validation: /Users/jason/.tangleclaw/Caddyfile:12 '
          + `basic_auth jason ${BCRYPT_A}`,
        healthUrl: 'https://localhost:8443/api/health',
        caddyfilePath: '/Users/someone/.tangleclaw/Caddyfile',
        basicAuthUser: 'jason', basicAuthHash: BCRYPT_A
      }));
      const res = await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(res.data.code, 'validate-failed', 'the code still crosses');
      assert.equal(res.data.hasError, true, 'and the fact that there was a reason');
      assert.ok(!res.raw.includes('jason'), 'response leaked a username');
      assert.ok(!/\$2[aby]\$/.test(res.raw), 'response carried something bcrypt-shaped');
      assert.ok(!res.raw.includes('failed validation'), 'response forwarded the raw error text');
      // `/Users/` alone is blind here by construction: this suite's base path is a
      // tmpdir, so an absolute path the ROUTE builds would sail past it. Assert
      // against the paths this install actually resolves to.
      assert.ok(!res.raw.includes(tmpDir), 'response leaked the install base path');
      assert.ok(!res.raw.includes(provision.cutoverLogPath()), 'response leaked the log path');
      assert.ok(!res.raw.includes(provision.resultPath()), 'response leaked the result path');
      assert.ok(!res.raw.includes('/Users/'), 'response leaked a home-directory path');
    });

    it('names the log by a RELATIVE location, so the OS account name never crosses', async () => {
      // The absolute path contains the account name, and this route answers with no
      // setupComplete gate in front of it. Fixing the `error` leak by returning
      // `cutoverLogPath()` would have re-introduced the same disclosure.
      fs.writeFileSync(provision.resultPath(), JSON.stringify({ ok: false, code: 'failed', error: 'x' }));
      const res = await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(res.data.logLocation, provision.CUTOVER_LOG_RELATIVE);
      assert.match(res.data.logLocation, /^~\//, 'must be relative to home, not resolved');
      assert.equal(res.data.logPath, undefined, 'the resolved path must not be returned');
      assert.ok(!res.raw.includes(tmpDir), 'the resolved base path leaked anyway');
    });

    it('never writes or creates the outcome file as a side effect of polling', async () => {
      assert.equal(fs.existsSync(provision.resultPath()), false);
      await request(server, 'GET', '/api/setup/provision-status');
      assert.equal(fs.existsSync(provision.resultPath()), false);
    });
  });
});
