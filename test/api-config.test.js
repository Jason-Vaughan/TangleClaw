'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const master = require('../lib/master');
const portScanner = require('../lib/port-scanner');
const { createServer, _setInstallPriorUse } = require('../server');
const { operatorHeaders, signInOperator, attemptUnidentified, bindProject } = require('./_shared-docs-callers');
const openInstallToken = require('../lib/open-install-token');

/**
 * The methods a caller must be identified for (#2233). The request helper below
 * sends the operator's dashboard headers on these and leaves reads exactly as
 * they were, because a read asks nothing about who is calling.
 * @type {ReadonlySet<string>}
 */
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

setLevel('error');

/**
 * Make an HTTP request to the test server. A write goes as the operator's
 * dashboard: every write in this file stands for the config page or the landing
 * page, and a route that changes state refuses a caller it cannot identify (#2233).
 * @param {http.Server} server
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @param {Record<string, string>} [as] - Headers to send instead of the
 *   dashboard's, for a case where the operator is a signed-in account
 * @returns {Promise<{ status: number, data: object }>}
 */
function request(server, method, urlPath, body, as) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(as || (WRITES.has(method) ? { ...operatorHeaders(server), 'x-tc-open-token': openInstallToken.mint() } : {}))
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
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

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('API endpoints', () => {
  let tmpDir;
  let server;
  let liveMasterFingerprint;

  /** Snapshot of the OPERATOR's real master home — the one thing in this file
   *  that `store._setBasePath(tmpDir)` does NOT redirect. `masterHome()`
   *  resolves to `~/.tangleclaw/master` unconditionally, so any route that
   *  reaches the real applier re-postures the live master while the suite runs.
   *  That has now happened twice; this turns it from something a reviewer has
   *  to notice into something the suite reports. */
  function liveMasterState() {
    const home = path.join(os.homedir(), '.tangleclaw', 'master');
    return ['.access-level', path.join('.claude', 'settings.json'), path.join('.claude', 'hooks', 'guard-writes.js')]
      .map((rel) => {
        const f = path.join(home, rel);
        try {
          return `${rel}:${fs.statSync(f).mtimeMs}:${fs.readFileSync(f, 'utf8').length}`;
        } catch {
          return `${rel}:absent`;
        }
      }).join('|');
  }

  before(async () => {
    liveMasterFingerprint = liveMasterState();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-'));
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


  // #710 — the server owns the network-binding classification and ships it as
  // `bindState`. The frontend renders that and derives nothing. These are live
  // HTTP assertions on purpose: the frontend guards are source-greps, so
  // reverting the two server call sites left every one of them green while the
  // settings modal fell back to `{}` — rendering a grace install's switch OFF
  // over a wide-open socket, with the keep-open button gone. That is the exact
  // defect the chunk exists to prevent, reachable by deleting one expression.
  describe('bindState on the config API (#710)', () => {
    it('GET /api/config carries the server-resolved bind state', async () => {
      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.ok(data.bindState, 'the classification must reach the client');
      assert.equal(data.bindState.setting, 'bindAllInterfaces');
      assert.equal(typeof data.bindState.wide, 'boolean');
      assert.equal(typeof data.bindState.lockedByCaddy, 'boolean');
      assert.ok(['opted-in', 'closed', 'unchosen'].includes(data.bindState.choice));
    });

    it('PATCH /api/config returns it too, so the control re-renders from the server', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', { chimeMuted: false });
      assert.equal(status, 200);
      assert.ok(data.config.bindState, 'the PATCH response must carry it as well');
    });
  });

  // The wizard warns an operator BEFORE they point the product at a directory it
  // may not be able to read (#859). Which directories those are is a fact about
  // the machine TangleClaw runs on, and the browser cannot answer it: the browser
  // may be a phone, where `navigator.platform` would report iOS about a Mac and
  // the one warning that matters would never appear. So the server ships it,
  // exactly as it ships `bindState` above.
  describe('protectedRoots on the config API (#859)', () => {
    it('GET /api/config carries the roots this machine protects', async () => {
      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.protectedRoots),
        'always an array, so the client never special-cases a missing field');

      if (process.platform === 'darwin') {
        // Both forms: the `~` an operator types and the absolute path it
        // resolves to. Shipping only one leaves the other silently unmatched.
        assert.ok(data.protectedRoots.includes('~/Documents'));
        assert.ok(data.protectedRoots.includes('~/Desktop'));
        assert.ok(data.protectedRoots.includes('~/Downloads'));
        assert.ok(data.protectedRoots.some(r => r.startsWith('/') && r.endsWith('/Documents')),
          'the absolute form must be there too');
      } else {
        assert.deepEqual(data.protectedRoots, [],
          'no other platform has this behaviour, and a caution that fires where it '
          + 'does not apply is one people learn to ignore');
      }
    });
  });

  describe('bindState edge cases (#710)', () => {
    /**
     * Rewrite this suite's config as one whose file lacks the binding key, run
     * `fn`, then restore the file exactly.
     * @param {object} overrides - Fields to set on the rewritten file.
     * @param {Function} fn - Async body run while the file is rewritten.
     */
    async function withKeylessConfig(overrides, fn) {
      const file = path.join(tmpDir, 'config.json');
      const original = fs.readFileSync(file, 'utf8');
      const raw = JSON.parse(original);
      delete raw.bindAllInterfaces;
      Object.assign(raw, { ingressMode: 'direct' }, overrides);
      fs.writeFileSync(file, JSON.stringify(raw));
      try {
        await fn();
      } finally {
        fs.writeFileSync(file, original);
      }
    }

    it('reports wide + unchosen for an install that predates the setting', async () => {
      // The population this whole mechanism exists for. If the API reports
      // `closed` here, the settings modal draws a shut door over an open one.
      // A legacy install is one that was USED (#1484): its file has no
      // setupComplete (which load() reads as true) and it has a project.
      const legacy = store.projects.create({ name: 'legacy-bind-probe', path: path.join(tmpDir, 'legacy-bind-probe') });
      _setInstallPriorUse(undefined); // ask the store afresh, as boot would
      try {
        await withKeylessConfig({ setupComplete: undefined }, async () => {
          const { data } = await request(server, 'GET', '/api/config');
          assert.equal(data.bindState.choice, 'unchosen');
          assert.equal(data.bindState.wide, true, 'a legacy install is still bound wide, deliberately');
          assert.equal(data.bindState.grace, true);
        });
      } finally {
        store.projects.delete(legacy.id);
        _setInstallPriorUse(undefined);
      }
    });

    it('keeps boot\'s fresh-install answer when a project appears after a failed save (#1484)', async () => {
      // Boot decided "fresh, loopback", but its save of `false` failed, so the
      // file still lacks the key. A project created afterwards must not flip
      // GET to grace, and PATCH must not persist grace for the next restart.
      _setInstallPriorUse(false);
      const later = store.projects.create({ name: 'after-boot-probe', path: path.join(tmpDir, 'after-boot-probe') });
      try {
        await withKeylessConfig({ setupComplete: undefined }, async () => {
          const { data } = await request(server, 'GET', '/api/config');
          assert.equal(data.bindState.choice, 'closed');
          assert.equal(data.bindState.wide, false);
          await request(server, 'PATCH', '/api/config', { chimeEnabled: true });
          const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
          assert.equal(onDisk.bindAllInterfaces, false,
            'an unrelated save must record boot\'s closed answer, not grace');
        });
      } finally {
        store.projects.delete(later.id);
        _setInstallPriorUse(undefined);
      }
    });

    it('reports closed for a keyless config whose file says setup never finished (#1484)', async () => {
      // A config written by hand before the first boot. Reporting it wide would
      // describe a socket boot never opens, and invite the operator to keep it.
      await withKeylessConfig({ setupComplete: false }, async () => {
        const { data } = await request(server, 'GET', '/api/config');
        assert.equal(data.bindState.choice, 'closed');
        assert.equal(data.bindState.wide, false);
        assert.equal(data.bindState.grace, false);
      });
    });

    it('reports closed once the operator has chosen', async () => {
      await request(server, 'PATCH', '/api/config', { bindAllInterfaces: false });
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.bindState.choice, 'closed');
      assert.equal(data.bindState.wide, false);
      assert.equal(data.bindState.grace, false);
    });
  });

  describe('GET /api/health', () => {
    it('should return 200 with service status', async () => {
      const { status, data } = await request(server, 'GET', '/api/health');
      assert.equal(status, 200);
      assert.ok(data.status, 'Should have status field');
      assert.ok(data.version, 'Should have version field');
      assert.equal(typeof data.uptime, 'number');
      assert.ok(data.services, 'Should have services object');
      assert.equal(data.services.database, 'ok');
    });

    it('should include tmux status', async () => {
      const { data } = await request(server, 'GET', '/api/health');
      assert.ok(['ok', 'unavailable'].includes(data.services.tmux));
    });
  });

  describe('GET /api/version', () => {
    it('should return version', async () => {
      const { status, data } = await request(server, 'GET', '/api/version');
      assert.equal(status, 200);
      const expected = require('../version.json').version;
      assert.equal(data.version, expected);
    });
  });

  describe('GET /api/config', () => {
    it('should return config with password redacted', async () => {
      // Set a password first
      const config = store.config.load();
      config.deletePassword = 'secret';
      store.config.save(config);

      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.equal(data.serverPort, 3101);
      assert.equal(data.deleteProtected, true);
      assert.equal(data.deletePassword, undefined, 'Password should not be exposed');
    });

    it('should return deleteProtected false when no password', async () => {
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.deleteProtected, false);
    });

    it('should include all expected fields', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(typeof data.serverPort, 'number');
      assert.equal(typeof data.ttydPort, 'number');
      assert.equal(typeof data.defaultEngine, 'string');
      assert.ok(Array.isArray(data.quickCommands));
      assert.equal(typeof data.theme, 'string');
      assert.equal(typeof data.chimeEnabled, 'boolean');
      assert.equal(typeof data.chimeMuted, 'boolean');
      assert.equal(typeof data.portScannerEnabled, 'boolean');
      assert.equal(typeof data.portScannerIntervalMs, 'number');
    });
  });

  describe('PATCH /api/config', () => {
    it('should update config fields', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        theme: 'light',
        chimeEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.config.theme, 'light');
      assert.equal(data.config.chimeEnabled, false);
    });

    it('should set requiresRestart when port changes', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', {
        serverPort: 9999
      });
      assert.equal(data.requiresRestart, true);

      // Reset port
      await request(server, 'PATCH', '/api/config', { serverPort: 3101 });
    });

    it('should reject invalid theme', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        theme: 'neon'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject invalid peekMode', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        peekMode: 'popup'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject non-numeric port', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        serverPort: 'abc'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should redact password in response', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', {
        deletePassword: 'newsecret'
      });
      assert.equal(data.config.deleteProtected, true);
      assert.equal(data.config.deletePassword, undefined);
    });

    it('should hash password before persisting', async () => {
      await request(server, 'PATCH', '/api/config', {
        deletePassword: 'hashme'
      });
      const config = store.config.load();
      assert.ok(config.deletePassword.includes(':'), 'Password should be stored as salt:hash');
      assert.notEqual(config.deletePassword, 'hashme', 'Password should not be stored in plaintext');
    });

    it('should allow clearing password with null', async () => {
      await request(server, 'PATCH', '/api/config', {
        deletePassword: null
      });
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.deleteProtected, false);
    });

    it('should reject empty body', async () => {
      const { status } = await request(server, 'PATCH', '/api/config');
      assert.equal(status, 400);
    });

    // #247 — stripAiCoauthors field. Boolean validation + persistence.
    it('should accept stripAiCoauthors boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        stripAiCoauthors: false
      });
      assert.equal(status, 200);
      assert.equal(data.config.stripAiCoauthors, false);
      // Restore default
      await request(server, 'PATCH', '/api/config', { stripAiCoauthors: true });
    });

    it('should reject non-boolean stripAiCoauthors', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        stripAiCoauthors: 'yes'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /stripAiCoauthors must be a boolean/);
    });

    it('should default stripAiCoauthors to true on GET when unset', async () => {
      // The DEFAULT_CONFIG sets stripAiCoauthors: true; a fresh config
      // (or any patched config that doesn't explicitly include the field)
      // must surface as true.
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.stripAiCoauthors, true,
        'default ON — Critic-driven default to make the security default safe');
    });

    it('should accept chimeMuted boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        chimeMuted: true
      });
      assert.equal(status, 200);
      assert.equal(data.config.chimeMuted, true);
    });

    it('should reject non-boolean chimeMuted', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        chimeMuted: 'yes'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('defaults ignoredLeaseProjects to an empty array (#1382)', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.deepEqual(data.ignoredLeaseProjects, []);
    });

    it('should accept and persist an ignoredLeaseProjects list (#1382)', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        ignoredLeaseProjects: ['Homebrew', 'legacy-db']
      });
      assert.equal(status, 200);
      assert.deepEqual(data.config.ignoredLeaseProjects, ['Homebrew', 'legacy-db']);
      // Persisted to disk, not just echoed back in the response — the point
      // of moving this off localStorage is that it survives a reload from a
      // different browser/device.
      const reloaded = store.config.load();
      assert.deepEqual(reloaded.ignoredLeaseProjects, ['Homebrew', 'legacy-db']);
      await request(server, 'PATCH', '/api/config', { ignoredLeaseProjects: [] });
    });

    it('should reject a non-array ignoredLeaseProjects', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        ignoredLeaseProjects: 'Homebrew'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject an ignoredLeaseProjects array with a non-string element', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        ignoredLeaseProjects: ['Homebrew', 42]
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept a valid quickCommands list (#1339)', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        quickCommands: [{ label: 'Build', command: 'npm run build' }]
      });
      assert.equal(status, 200);
      assert.deepEqual(data.config.quickCommands, [{ label: 'Build', command: 'npm run build' }]);
      const reloaded = store.config.load();
      assert.deepEqual(reloaded.quickCommands, [{ label: 'Build', command: 'npm run build' }]);
      await request(server, 'PATCH', '/api/config', { quickCommands: [] });
    });

    it('should reject a string quickCommands (#1339)', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        quickCommands: 'npm run build'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject a number quickCommands (#1339)', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        quickCommands: 42
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject a bare object quickCommands, not wrapped in an array (#1339)', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        quickCommands: { label: 'Build', command: 'npm run build' }
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject a quickCommands array containing null (#1339)', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        quickCommands: [null]
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject a quickCommands element missing label or command (#1339)', async () => {
      const missingLabel = await request(server, 'PATCH', '/api/config', {
        quickCommands: [{ command: 'npm run build' }]
      });
      assert.equal(missingLabel.status, 400);
      assert.equal(missingLabel.data.code, 'BAD_REQUEST');

      const missingCommand = await request(server, 'PATCH', '/api/config', {
        quickCommands: [{ label: 'Build' }]
      });
      assert.equal(missingCommand.status, 400);
      assert.equal(missingCommand.data.code, 'BAD_REQUEST');
    });

    it('should accept portScannerEnabled boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.config.portScannerEnabled, false);
    });

    it('should reject non-boolean portScannerEnabled', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerEnabled: 1
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept valid portScannerIntervalMs', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 30000
      });
      assert.equal(status, 200);
      assert.equal(data.config.portScannerIntervalMs, 30000);
    });

    it('should reject portScannerIntervalMs below minimum', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 5000
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject portScannerIntervalMs above maximum', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 999999
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject non-numeric portScannerIntervalMs', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 'fast'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    // AUTH-1 (#395) — ingress topology flag
    it('should default ingressMode to direct', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.ingressMode, 'direct');
    });

    it('should accept ingressMode=caddy', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        ingressMode: 'caddy'
      });
      assert.equal(status, 200);
      assert.equal(data.config.ingressMode, 'caddy');
      // restore default for later tests
      await request(server, 'PATCH', '/api/config', { ingressMode: 'direct' });
    });

    it('should reject an unknown ingressMode', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        ingressMode: 'nginx'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept a string publicDomain and normalize empty string to null', async () => {
      let res = await request(server, 'PATCH', '/api/config', { publicDomain: 'tc.example.com' });
      assert.equal(res.status, 200);
      assert.equal(res.data.config.publicDomain, 'tc.example.com');
      res = await request(server, 'PATCH', '/api/config', { publicDomain: '' });
      assert.equal(res.status, 200);
      assert.equal(res.data.config.publicDomain, null);
    });

    it('should reject a non-string, non-null publicDomain', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        publicDomain: 42
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept valid caddy ports and default them to 8443/8080', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.caddyHttpsPort, 8443);
      assert.equal(data.caddyHttpPort, 8080);
      const res = await request(server, 'PATCH', '/api/config', { caddyHttpsPort: 443, caddyHttpPort: 80 });
      assert.equal(res.status, 200);
      assert.equal(res.data.config.caddyHttpsPort, 443);
      assert.equal(res.data.config.caddyHttpPort, 80);
      await request(server, 'PATCH', '/api/config', { caddyHttpsPort: 8443, caddyHttpPort: 8080 });
    });

    it('should reject a non-integer caddy port', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', { caddyHttpsPort: 8443.5 });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject a caddy port out of range', async () => {
      for (const bad of [0, 70000, 'eighty']) {
        const { status } = await request(server, 'PATCH', '/api/config', { caddyHttpPort: bad });
        assert.equal(status, 400, `port ${bad} should be rejected`);
      }
    });

    // AUTH-2 (Path A) — basic_auth gate config. A real bcrypt hash fixture
    // (caddy hash-password output) so the bcrypt-shape guard is exercised honestly.
    const BCRYPT = '$2a$14$0Eq3PY/I86yjD0yXuZNv3eKbNXqSyeO911yQE8qvUKFVE/f0SjEWW';

    it('should default authEnabled false, basicAuthUser null, and never expose the hash', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.authEnabled, false);
      assert.equal(data.basicAuthUser, null);
      assert.equal(data.basicAuthConfigured, false);
      assert.equal('basicAuthHash' in data, false); // redacted — credential hash never leaves the server
    });

    // These six previously pinned PATCH /api/config WRITING the credential. That
    // capability is gone, so the contract is replaced rather than deleted — and
    // the replacement is strictly stronger: it asserted which writes were allowed,
    // this asserts that none are. The route authenticates nobody and had no
    // lifecycle gate, so on an ungated, network-reachable install an
    // unauthenticated caller could set an admin credential and lock the owner out.

    it('refuses every credential field, individually', async () => {
      for (const body of [
        { authEnabled: true },
        { basicAuthUser: 'attacker' },
        { basicAuthHash: BCRYPT }
      ]) {
        const { status, data } = await request(server, 'PATCH', '/api/config', body);
        assert.equal(status, 409, `${Object.keys(body)[0]} must be refused here`);
        assert.equal(data.code, 'CREDENTIAL_ROUTE_MOVED');
      }
    });

    it('refuses a WELL-FORMED bcrypt hash too — the objection is the route, not the shape', async () => {
      // The old guard rejected plaintext and accepted a real hash. That is exactly
      // backwards for this defect: a valid hash from an unauthenticated caller is
      // the attack, not the mistake.
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        basicAuthUser: 'attacker', basicAuthHash: BCRYPT, authEnabled: true
      });
      assert.equal(status, 409);
      assert.equal(data.code, 'CREDENTIAL_ROUTE_MOVED');
      assert.equal(store.config.load().basicAuthHash, null, 'nothing may be persisted');
      assert.equal(store.config.load().basicAuthUser, null);
      assert.equal(store.config.load().authEnabled, false);
    });

    it('names both ways to actually change it, since refusing without one is a dead end', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', { basicAuthUser: 'jason' });
      assert.match(data.error, /\/api\/auth\/credential/, 'the settings route');
      assert.match(data.error, /reset-admin/, 'and the terminal recovery tool');
    });

    it('refuses the WHOLE patch, so an unrelated field does not slip through beside it', async () => {
      // Atomicity matters here: applying the harmless half of a rejected body would
      // report partial success as success, and the caller has no way to tell which
      // half took.
      const before = store.config.load().theme;
      const nextTheme = before === 'light' ? 'dark' : 'light';
      const { status } = await request(server, 'PATCH', '/api/config',
        { theme: nextTheme, basicAuthUser: 'attacker' });
      assert.equal(status, 409);
      assert.equal(store.config.load().theme, before, 'the unrelated field must not have applied');
    });

    it('still refuses when a credential field is explicitly null or empty', async () => {
      // The blanking route. `null` reads as "clear it", which the Direction forbids
      // from a settings surface: it would be a second way to reach "no password".
      for (const body of [{ basicAuthUser: null }, { basicAuthHash: '' }, { authEnabled: false }]) {
        const { status } = await request(server, 'PATCH', '/api/config', body);
        assert.equal(status, 409, `${JSON.stringify(body)} must not be a way to blank the login`);
      }
    });

    it('leaves the config API redacting the hash exactly as before', async () => {
      // Asserted with a hash ACTUALLY PRESENT. Both surviving versions of this
      // check ran against a null one, where `'basicAuthHash' in data` is false
      // and `basicAuthConfigured` is false whether or not the redaction line
      // exists — so deleting the redaction would have leaked a real hash past a
      // green suite. The fixture has to contain the thing being redacted.
      const stored = store.config.load();
      const had = stored.basicAuthHash;
      stored.basicAuthHash = BCRYPT;
      store.config.save(stored);
      try {
        const { data } = await request(server, 'GET', '/api/config');
        assert.equal('basicAuthHash' in data, false, 'the hash must not be a field');
        assert.ok(!JSON.stringify(data).includes(BCRYPT),
          'and must not appear anywhere in the response, under any key');
        assert.equal(data.basicAuthConfigured, true, 'only the boolean crosses the boundary');
      } finally {
        const back = store.config.load();
        back.basicAuthHash = had;
        store.config.save(back);
      }
    });

    it('still saves an unrelated field when the stored config is half-credentialed', async () => {
      // A both-or-neither check used to run here and reject the whole request when
      // config held authEnabled=true with no credential. Once the credential fields
      // left this route, no request could CREATE that state — the check could only
      // fire on a config that arrived broken, and there it rejected a theme change
      // with an instruction to send credential fields this same route refuses. An
      // error with no exit. The invariant now lives where the fields are written.
      const stored = store.config.load();
      const restore = {
        authEnabled: stored.authEnabled,
        basicAuthUser: stored.basicAuthUser,
        basicAuthHash: stored.basicAuthHash
      };
      stored.authEnabled = true;
      stored.basicAuthUser = null;
      stored.basicAuthHash = null;
      store.config.save(stored);

      try {
        const before = store.config.load().theme;
        const nextTheme = before === 'light' ? 'dark' : 'light';

        // `authEnabled` switches TangleClaw's own login on, so this install now
        // asks who is writing. Until it has an account nobody is its operator,
        // and the write is refused before the route with the theme untouched
        // (#2233).
        const { browser, machine } = await attemptUnidentified(server, 'PATCH', '/api/config', { theme: nextTheme });
        assert.equal(browser.status, 401);
        assert.equal(browser.data.code, 'ACCOUNT_REQUIRED');
        assert.equal(machine.status, 403);
        assert.equal(machine.data.code, 'LAUNCH_BINDING_REQUIRED');
        assert.equal(store.config.load().theme, before, 'neither refusal changed the theme');

        // The operator creates the account and signs in. The half-credentialed
        // config is still half-credentialed, and the unrelated write goes through.
        const session = await signInOperator(server);
        const after = store.config.load();
        assert.equal(after.authEnabled, true);
        assert.equal(after.basicAuthUser, null, 'precondition: the stored config is still half-credentialed');
        const { status } = await request(server, 'PATCH', '/api/config', { theme: nextTheme }, session);
        assert.equal(status, 200, 'an unrelated write must not be held hostage by a state it cannot fix');
        assert.equal(store.config.load().theme, nextTheme);
      } finally {
        store.config.save({ ...store.config.load(), ...restore });
        // The account this case made would leave a login on the rest of the file.
        store.getDb().prepare('DELETE FROM auth_sessions').run();
        store.getDb().prepare('DELETE FROM recovery_codes').run();
        store.getDb().prepare('DELETE FROM users').run();
      }
    });
  });

  describe('PATCH /api/config HTTPS cert validation', () => {
    const { execSync } = require('node:child_process');
    let fixtureDir;
    let certPath;
    let keyPath;
    let hasOpenssl;

    before(() => {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-patch-https-'));
      certPath = path.join(fixtureDir, 'cert.pem');
      keyPath = path.join(fixtureDir, 'key.pem');
      try {
        execSync(
          `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 30 -nodes -subj "/CN=localhost"`,
          { stdio: 'ignore', timeout: 10000 }
        );
        hasOpenssl = true;
      } catch {
        hasOpenssl = false;
      }
    });

    after(() => {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      // Reset HTTPS fields so later tests start clean
      const config = store.config.load();
      config.httpsEnabled = false;
      config.httpsCertPath = null;
      config.httpsKeyPath = null;
      store.config.save(config);
    });

    it('should reject enabling HTTPS with a missing cert file', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: '/tmp/tc-no-such-cert-' + Date.now() + '.pem',
        httpsKeyPath: '/tmp/tc-no-such-key-' + Date.now() + '.pem'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /HTTPS cert validation failed/);
    });

    it('should reject enabling HTTPS with only one cert path set', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: certPath,
        httpsKeyPath: ''
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /Both httpsCertPath and httpsKeyPath are required/);
    });

    it('should accept enabling HTTPS with a valid cert pair', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: certPath,
        httpsKeyPath: keyPath
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.config.httpsEnabled, true);
      assert.equal(data.requiresRestart, true);
    });

    it('should allow enabling HTTPS with no cert paths (graceful HTTP fallback)', async () => {
      // Existing installs upgrading to DEFAULT_CONFIG.httpsEnabled=true without certs
      // must not be blocked here — createServer() logs and falls back to HTTP.
      // Clear cert fields first so the validator sees the "no paths" case.
      const config = store.config.load();
      config.httpsCertPath = null;
      config.httpsKeyPath = null;
      store.config.save(config);

      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: '',
        httpsKeyPath: ''
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
    });

    it('should normalize empty-string cert paths to null (shape parity with /api/setup/complete)', async () => {
      const config = store.config.load();
      config.httpsCertPath = null;
      config.httpsKeyPath = null;
      store.config.save(config);

      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false,
        httpsCertPath: '',
        httpsKeyPath: ''
      });
      const saved = store.config.load();
      assert.equal(saved.httpsCertPath, null);
      assert.equal(saved.httpsKeyPath, null);
    });

    it('should accept null for httpsCertPath/httpsKeyPath to clear them', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false,
        httpsCertPath: null,
        httpsKeyPath: null
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      const saved = store.config.load();
      assert.equal(saved.httpsCertPath, null);
      assert.equal(saved.httpsKeyPath, null);
    });

    it('should allow disabling HTTPS even when cert paths remain set', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      // Simulate user turning HTTPS off without clearing paths — validator must not run.
      const config = store.config.load();
      config.httpsEnabled = true;
      config.httpsCertPath = certPath;
      config.httpsKeyPath = keyPath;
      store.config.save(config);

      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.config.httpsEnabled, false);
    });

    it('should reject enabling HTTPS when cert exists but key is missing (asymmetric failure)', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: certPath,
        httpsKeyPath: '/tmp/tc-no-such-key-' + Date.now() + '.pem'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /HTTPS cert validation failed/);
    });
  });

  describe('config migration defaults', () => {
    it('should default chimeMuted to false for existing configs', async () => {
      const config = store.config.load();
      delete config.chimeMuted;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.chimeMuted, false);
    });

    it('should default portScannerEnabled to true for existing configs', async () => {
      const config = store.config.load();
      delete config.portScannerEnabled;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.portScannerEnabled, true);
    });

    it('should default portScannerIntervalMs to 60000 for existing configs', async () => {
      const config = store.config.load();
      delete config.portScannerIntervalMs;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.portScannerIntervalMs, 60000);
    });
  });

  describe('error handling', () => {
    it('should return 404 for unknown API routes', async () => {
      const { status, data } = await request(server, 'GET', '/api/nonexistent');
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('should return standard error format', async () => {
      const { data } = await request(server, 'GET', '/api/nonexistent');
      assert.equal(typeof data.error, 'string');
      assert.equal(typeof data.code, 'string');
    });

    it('should reject oversized bodies', async () => {
      const largeBody = { data: 'x'.repeat(11 * 1024) };
      const { status, data } = await request(server, 'PATCH', '/api/config', largeBody);
      assert.equal(status, 413);
      assert.equal(data.code, 'BODY_TOO_LARGE');
    });
  });

  // Project Master settings — merge-then-validate whole-object semantics.
  describe('PATCH /api/config { master }', () => {
    it('accepts a valid patch and stores the full normalized shape', async () => {
      const { status } = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
      assert.equal(status, 200);
      assert.deepEqual(store.config.load().master, {
        // #756 added launchMode to the normalized shape. It is stored on every
        // write, not only when patched, so the block never carries a missing
        // field for `_buildLaunchCommand` to receive as undefined.
        accessLevel: 'read-only', engine: null, launchMode: 'default',
        // #2197 added the engine a mode was chosen for, stored on every write
        // for the same reason. `null` beside `default`, which belongs to no engine.
        launchModeEngine: null,
        scope: 'all', autoStart: true,
        // #996 added the two switchboard opt-ins, stored on every write for the
        // same reason — a Master block must never carry a missing field.
        medusaEnabled: false, medusaWake: false
      });
    });

    it('a partial patch merges onto current settings instead of wiping fields', async () => {
      await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
      const { status } = await request(server, 'PATCH', '/api/config', { master: { engine: 'claude' } });
      assert.equal(status, 200);
      const saved = store.config.load().master;
      assert.equal(saved.engine, 'claude');
      assert.equal(saved.autoStart, true, 'earlier field must survive the second patch');
    });

    it('ships launchMode in the DEFAULT master block, before any PATCH (#756)', async () => {
      // The whole point of the DEFAULT_CONFIG entry: `GET /api/config` and
      // `GET /api/master/status` must agree on an install nobody has PATCHed.
      // Every other assertion here reads the block AFTER a patch, and
      // `validateMasterPatch` sources the field from `masterSettings()`, which
      // defaults it independently — so deleting the default would leave all of
      // them green while the two endpoints disagreed.
      assert.equal(store.DEFAULT_CONFIG.master.launchMode, 'default',
        'a never-PATCHed install must carry launchMode, not omit it');
      // The invariant the default exists for, asserted as an agreement rather
      // than as the constant's shape: what `GET /api/config` would report and
      // what `masterSettings` (behind `GET /api/master/status`) reports must be
      // the same value on an install nobody has touched.
      assert.equal(
        store.DEFAULT_CONFIG.master.launchMode,
        master.masterSettings({}).launchMode,
        'config default and master-status default must not disagree'
      );
    });

    it('stores a launch mode (#756)', async () => {
      const { status } = await request(server, 'PATCH', '/api/config', { master: { launchMode: 'acceptEdits' } });
      assert.equal(status, 200);
      assert.equal(store.config.load().master.launchMode, 'acceptEdits');
    });

    it('refuses a mode chosen in the same save as an engine that does not define it (#2197)', async () => {
      // Reversed by #2197. This case used to assert the opposite: the save was
      // accepted and `acceptEdits` stayed stored for Aider, so that switching
      // back would restore it (#756). A launch mode is now a choice about one
      // engine, and a mode named beside a new engine is a choice for that
      // engine, which Aider cannot be given.
      const before = store.config.load().master;
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        master: { engine: 'aider', launchMode: 'acceptEdits' }
      });
      assert.equal(status, 400);
      assert.match(data.error, /"acceptEdits" is not a launch mode of Aider/);
      assert.deepEqual(store.config.load().master, before, 'a refused save stores nothing');
    });

    it('rejects a launch mode no engine defines, naming the valid set', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        master: { launchMode: 'ludicrous-speed' }
      });
      assert.equal(status, 400);
      assert.match(data.error, /master\.launchMode must be one of/);
      assert.match(data.error, /default/, 'the honest set must name at least the universal mode');
    });

    it('does not reject an unrelated patch over a stored mode gone unhonorable', async () => {
      // `knownLaunchModes()` is the union across INSTALLED engines, so
      // uninstalling one shrinks it. Validating the MERGED value would then
      // 400 every master PATCH on the install — including ones that only
      // toggle autoStart — over a stored mode the operator never touched.
      const config = store.config.load();
      config.master = { ...config.master, launchMode: 'mode-from-a-since-removed-engine' };
      store.config.save(config);
      const { status } = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
      assert.equal(status, 200, 'a patch that does not touch launchMode must not be judged on it');
      assert.equal(store.config.load().master.autoStart, true);
    });

    it('rejects a non-string launch mode', async () => {
      const { status } = await request(server, 'PATCH', '/api/config', { master: { launchMode: 7 } });
      assert.equal(status, 400);
    });

    // #2197 — the mode a save leaves the Master with, over the real route. The
    // rule itself is exercised case by case in `test/master-launch-mode.test.js`;
    // these hold what only the route can show: the stored block, the response's
    // `warnings`, and a request that carries the engine in either of its fields.
    describe('an engine change does not carry the Master\'s launch mode (#2197)', () => {
      let savedConfig;

      /**
       * Store a Master block and default engine directly, as the starting
       * point of a case. Not through the route: the route is what is under test.
       * @param {object} masterBlock - Fields over a read-only, unpinned Master.
       * @param {string} [defaultEngine] - The install's default engine.
       */
      function given(masterBlock, defaultEngine = 'claude') {
        const config = store.config.load();
        config.defaultEngine = defaultEngine;
        config.master = {
          accessLevel: 'read-only', engine: null, launchMode: 'default', scope: 'all', autoStart: false,
          medusaEnabled: false, medusaWake: false, ...masterBlock
        };
        store.config.save(config);
      }

      beforeEach(() => { savedConfig = store.config.load(); });
      afterEach(() => { store.config.save(savedConfig); });

      const BYPASS_ON_CLAUDE = { engine: 'claude', launchMode: 'bypassPermissions', launchModeEngine: 'claude' };

      it('resets the mode to default and says so, naming both engines and both modes', async () => {
        given(BYPASS_ON_CLAUDE);
        const { status, data } = await request(server, 'PATCH', '/api/config', { master: { engine: 'codex' } });
        assert.equal(status, 200);
        const stored = store.config.load().master;
        assert.equal(stored.engine, 'codex');
        assert.equal(stored.launchMode, 'default', 'Bypass was chosen for Claude Code and must not start Codex');
        assert.equal(stored.launchModeEngine, null);
        assert.equal(data.warnings.length, 1);
        assert.match(data.warnings[0], /reset to Interactive/);
        assert.match(data.warnings[0], /Bypass was chosen for Claude Code/);
        assert.match(data.warnings[0], /does not carry to Codex/);
        assert.equal(data.config.master.launchMode, 'default', 'the response\'s config is what was stored');
      });

      it('keeps a mode the same save chooses for the new engine, and reports nothing', async () => {
        given(BYPASS_ON_CLAUDE);
        const { status, data } = await request(server, 'PATCH', '/api/config', {
          master: { engine: 'codex', launchMode: 'fullAuto' }
        });
        assert.equal(status, 200);
        const stored = store.config.load().master;
        assert.equal(stored.launchMode, 'fullAuto');
        assert.equal(stored.launchModeEngine, 'codex');
        assert.deepEqual(data.warnings, []);
      });

      it('leaves the mode alone on a save that does not change the engine, with an empty warnings list', async () => {
        given(BYPASS_ON_CLAUDE);
        const first = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
        assert.equal(first.status, 200);
        assert.deepEqual(first.data.warnings, [], 'present and empty, not absent');
        const again = await request(server, 'PATCH', '/api/config', { master: { engine: 'claude' } });
        assert.equal(again.status, 200);
        assert.deepEqual(again.data.warnings, []);
        const stored = store.config.load().master;
        assert.equal(stored.launchMode, 'bypassPermissions');
        assert.equal(stored.launchModeEngine, 'claude');
        assert.equal(stored.autoStart, true);
      });

      it('records the engine with a mode chosen on its own', async () => {
        given({ engine: 'codex' });
        const { status } = await request(server, 'PATCH', '/api/config', { master: { launchMode: 'fullAuto' } });
        assert.equal(status, 200);
        const stored = store.config.load().master;
        assert.equal(stored.launchMode, 'fullAuto');
        assert.equal(stored.launchModeEngine, 'codex');
      });

      it('resets a Master that follows the default engine when the default engine changes', async () => {
        given({ engine: null, launchMode: 'bypassPermissions', launchModeEngine: 'claude' }, 'claude');
        const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: 'codex' });
        assert.equal(status, 200);
        const config = store.config.load();
        assert.equal(config.defaultEngine, 'codex');
        assert.equal(config.master.launchMode, 'default');
        assert.equal(config.master.launchModeEngine, null);
        assert.match(data.warnings[0], /Bypass was chosen for Claude Code and does not carry to Codex/);
      });

      it('does not touch a pinned Master when the default engine changes', async () => {
        given(BYPASS_ON_CLAUDE, 'claude');
        const { status, data } = await request(server, 'PATCH', '/api/config', { defaultEngine: 'codex' });
        assert.equal(status, 200);
        const stored = store.config.load().master;
        assert.equal(stored.launchMode, 'bypassPermissions');
        assert.equal(stored.launchModeEngine, 'claude');
        assert.deepEqual(data.warnings, []);
      });

      it('reads the engine from both fields of one request, in either order', async () => {
        // The pin is removed and the default engine changes in the same save.
        // The Master ends on Codex whichever key the body lists first.
        for (const body of [
          { master: { engine: null }, defaultEngine: 'codex' },
          { defaultEngine: 'codex', master: { engine: null } }
        ]) {
          given(BYPASS_ON_CLAUDE, 'claude');
          const { status, data } = await request(server, 'PATCH', '/api/config', body);
          assert.equal(status, 200);
          assert.equal(store.config.load().master.launchMode, 'default', JSON.stringify(Object.keys(body)));
          assert.equal(data.warnings.length, 1);
        }
        // And a pin that takes over the engine the default just left is no change.
        given({ engine: null, launchMode: 'acceptEdits', launchModeEngine: 'claude' }, 'claude');
        const kept = await request(server, 'PATCH', '/api/config', { defaultEngine: 'codex', master: { engine: 'claude' } });
        assert.equal(kept.status, 200);
        assert.equal(store.config.load().master.launchMode, 'acceptEdits');
        assert.deepEqual(kept.data.warnings, []);
      });

      it('says so when a save sends back a mode that belongs to another engine, and does not move it', async () => {
        // Recorded for Claude Code while the Master is set to Codex, which
        // defines the same key. A form resends the mode on any save.
        given({ engine: 'codex', launchMode: 'bypassPermissions', launchModeEngine: 'claude' });
        const { status, data } = await request(server, 'PATCH', '/api/config', {
          master: { launchMode: 'bypassPermissions', autoStart: true }
        });
        assert.equal(status, 200);
        const stored = store.config.load().master;
        assert.equal(stored.launchModeEngine, 'claude');
        assert.equal(stored.autoStart, true, 'the rest of the save still applies');
        assert.equal(data.warnings.length, 1);
        assert.match(data.warnings[0], /still Bypass, chosen for Claude Code, and is not used on Codex/);
      });

      it('refuses launchModeEngine from a caller, and stores nothing', async () => {
        given(BYPASS_ON_CLAUDE);
        const before = store.config.load().master;
        const { status, data } = await request(server, 'PATCH', '/api/config', {
          master: { engine: 'codex', launchMode: 'bypassPermissions', launchModeEngine: 'claude' }
        });
        assert.equal(status, 400);
        assert.match(data.error, /master\.launchModeEngine is not a settable field/);
        assert.deepEqual(store.config.load().master, before);
      });

      it('records the engine of a mode stored before the field existed, on the next save', async () => {
        given({ engine: 'claude', launchMode: 'acceptEdits' });
        const { status, data } = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
        assert.equal(status, 200);
        const stored = store.config.load().master;
        assert.equal(stored.launchMode, 'acceptEdits', 'an upgrade changes nothing about the mode');
        assert.equal(stored.launchModeEngine, 'claude');
        assert.deepEqual(data.warnings, []);
      });

      it('an access-level-only save still succeeds and changes nothing else (the Master bar\'s toggle, #2128)', async () => {
        given(BYPASS_ON_CLAUDE);
        const realApply = master.applyMasterAccessLevel;
        // Stubbed for the reason the #755 case above gives: the real applier
        // writes the operator's own Master home.
        master.applyMasterAccessLevel = () => ({ applied: true, home: '/stub' });
        try {
          const before = store.config.load().master;
          const { status, data } = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } });
          assert.equal(status, 200);
          // #2132, Ruling A491-W2A-R4 — a PATCH that moves accessLevel is an
          // Operator-authorized transition too, so it now ALSO persists the
          // same audit fields POST /api/master/authority records
          // (lifecycleGeneration/lifecycleUpdatedAt/lifecycleUpdatedBy) — the
          // exact regression assertion that this save, not just the response,
          // carries the new generation to disk.
          const stored = store.config.load().master;
          assert.deepEqual(stored, {
            ...before, accessLevel: 'write',
            lifecycleGeneration: 1, lifecycleUpdatedAt: stored.lifecycleUpdatedAt, lifecycleUpdatedBy: 'operator'
          });
          assert.match(stored.lifecycleUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
          assert.deepEqual(data.warnings, []);
        } finally {
          master.applyMasterAccessLevel = realApply;
        }
      });

      describe('an accessLevel transition requires real operator proof (PRR-A BLOCKING, rounds 2 and 2-HOLD)', () => {
        let project;
        let bound;
        let before;

        beforeEach(() => {
          given(BYPASS_ON_CLAUDE);
          before = store.config.load().master;
          const projDir = path.join(tmpDir, `authz-escalation-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
          fs.mkdirSync(projDir, { recursive: true });
          project = store.projects.create({ name: path.basename(projDir), path: projDir, engine: 'claude' });
          bound = bindProject(project);
        });

        afterEach(() => {
          store.sessions.kill(bound.sessionId, 'test cleanup');
        });

        it('refuses a project-bound caller changing accessLevel — only the operator may (round 2)', async () => {
          // The exact gap PRR-A's round-2 pre-inspection named: a verified
          // project session is admitted by the generic launch-binding floor
          // to PATCH /api/config at all (every OTHER field on this route is
          // reachable that way), but an accessLevel transition grants the
          // Master standing write authority over the fleet API — the same
          // authority POST /api/master/authority already requires operator
          // proof for. Without this check, a project session could grant
          // that authority to itself via a PATCH the audit trail would
          // misrecord as the operator's own action.
          const { status, data } = await request(server, 'PATCH', '/api/config',
            { master: { accessLevel: 'write' } }, bound.headers);
          assert.equal(status, 403);
          assert.equal(data.code, 'OPERATOR_ONLY');
          assert.deepEqual(store.config.load().master, before, 'nothing was granted — not accessLevel, not a generation bump');
        });

        it('still refuses a project-bound caller that ALSO forges the dashboard-shaped headers (round 2-HOLD, Ruling A491-W2A-R8)', async () => {
          // sharedDocsAccess._isOperator reads ANY dashboard- or
          // browser-shaped request as the operator on an open install —
          // before resolving any project binding at all. A project session
          // could add `x-tangleclaw-client: dashboard` (or an Origin
          // header) to its own request and be read as the operator by the
          // simpler check this route used in round 2. The caller still
          // carries its own launch-binding headers, which is what this
          // route must refuse on regardless of what else it also sends.
          const forged = {
            ...bound.headers,
            ...operatorHeaders(server),
            'x-tangleclaw-client': 'dashboard',
            'x-tc-open-token': openInstallToken.mint()
          };
          const { status, data } = await request(server, 'PATCH', '/api/config',
            { master: { accessLevel: 'write' } }, forged);
          assert.equal(status, 403);
          assert.equal(data.code, 'OPERATOR_ONLY');
          assert.deepEqual(store.config.load().master, before, 'nothing was granted — not accessLevel, not a generation bump');
        });

        it('refuses a dashboard-shaped caller with no launch binding that lacks the open-install token (round 2-HOLD)', async () => {
          // The flip side: a caller with NO launch-binding headers, shaped
          // like the dashboard, but missing the one thing that actually
          // proves it fetched that shape from this server — the
          // open-install token `_requireOperatorWrite` itself checks. This
          // is the proof POST /api/master/authority already requires, and
          // this route must now ask for the same thing.
          const noToken = { ...operatorHeaders(server), 'x-tangleclaw-client': 'dashboard' };
          const { status, data } = await request(server, 'PATCH', '/api/config',
            { master: { accessLevel: 'write' } }, noToken);
          assert.equal(status, 403);
          assert.equal(data.code, 'OPEN_INSTALL_TOKEN_INVALID');
          assert.deepEqual(store.config.load().master, before, 'nothing was granted — not accessLevel, not a generation bump');
        });
      });

      it('persists the authority transition to disk even when the LATER write-guard apply fails (#2132, R4)', async () => {
        // The regression PRR-A's BLOCKING finding named directly: a prior
        // version of this route called store.config.save(config) BEFORE
        // applyOperatorAuthorityChange mutated config.master, so the audit
        // fields never reached disk even though the HTTP response reported
        // them. This specifically exercises the ordering: the save (now
        // carrying the audit fields) happens BEFORE the write-guard apply
        // below ever runs, so a failure there must not un-persist it.
        given(BYPASS_ON_CLAUDE);
        const realApply = master.applyMasterAccessLevel;
        master.applyMasterAccessLevel = () => { throw new Error('disk on fire'); };
        try {
          const { status } = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } });
          assert.equal(status, 500, 'the write-guard failure still surfaces as an error');
          const reloaded = store.config.load().master;
          assert.equal(reloaded.accessLevel, 'write');
          assert.equal(reloaded.lifecycleGeneration, 1);
          assert.equal(reloaded.lifecycleUpdatedBy, 'operator');
          assert.ok(typeof reloaded.lifecycleUpdatedAt === 'string' && reloaded.lifecycleUpdatedAt.length > 0);
        } finally {
          master.applyMasterAccessLevel = realApply;
        }
      });

      it('says a reset in the error too, when the same save could not apply an access level', async () => {
        given(BYPASS_ON_CLAUDE);
        const realApply = master.applyMasterAccessLevel;
        master.applyMasterAccessLevel = () => { throw new Error('disk on fire'); };
        try {
          const { status, data } = await request(server, 'PATCH', '/api/config', {
            master: { engine: 'codex', accessLevel: 'suggest' }
          });
          assert.equal(status, 500);
          assert.equal(data.code, 'MASTER_LEVEL_NOT_APPLIED');
          assert.match(data.error, /launch mode is reset to Interactive/,
            'the save stood, so the mode it reset must not go unsaid');
          assert.equal(store.config.load().master.launchMode, 'default');
        } finally {
          master.applyMasterAccessLevel = realApply;
        }
      });

      it('a save that names neither engine field does not rewrite the stored Master block', async () => {
        // A block as a hand edit or an older version left it: no recorded
        // engine. A theme save has no business normalizing it.
        const config = store.config.load();
        config.defaultEngine = 'claude';
        config.master = { accessLevel: 'read-only', launchMode: 'acceptEdits' };
        store.config.save(config);
        const { status, data } = await request(server, 'PATCH', '/api/config', { theme: 'dark' });
        assert.equal(status, 200);
        assert.deepEqual(store.config.load().master, { accessLevel: 'read-only', launchMode: 'acceptEdits' });
        assert.deepEqual(data.warnings, []);
      });
    });

    it('pushes a changed access level to the live master, and only when it changed (#755)', async () => {
      // Stubbed, NOT allowed to run: the real applier resolves `masterHome()`,
      // so an unstubbed run here rewrites the operator's own
      // `~/.tangleclaw/master/.access-level` — a route test silently re-posturing
      // the live master, which is the defect class that once let a route test
      // overwrite the real FLEET.md.
      const realApply = master.applyMasterAccessLevel;
      const calls = [];
      master.applyMasterAccessLevel = (level) => { calls.push(level); return { applied: true, home: '/stub' }; };
      try {
        await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } });
        assert.deepEqual(calls, ['write'], 'a changed level must be pushed to the guard');

        // Re-saving the same level must not push again — the settings modal
        // POSTs the whole master block on every Save, so an ungated push would
        // rewrite the level file on saves that never touched it.
        await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } });
        assert.deepEqual(calls, ['write'], 'an unchanged level must not be pushed');

        // A partial patch that omits accessLevel must not push either.
        await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
        assert.deepEqual(calls, ['write'], 'a patch that does not touch the level must not push');

        await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'read-only' } });
        assert.deepEqual(calls, ['write', 'read-only'], 'flipping back must push too');
      } finally {
        master.applyMasterAccessLevel = realApply;
      }
    });

    it('reports a failed apply instead of returning 200 on a revocation that did not happen (#755)', async () => {
      // The dangerous direction: on write -> read-only, a failed apply leaves the
      // config saying `read-only` while the guard still reads `write` and keeps
      // allowing. A 200 there is a revocation that reports success and did not
      // occur, and the operator cannot see the difference.
      const realApply = master.applyMasterAccessLevel;
      master.applyMasterAccessLevel = () => { throw new Error('disk on fire'); };
      try {
        const { status, data } = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'suggest' } });
        assert.equal(status, 500);
        assert.equal(data.code, 'MASTER_LEVEL_NOT_APPLIED');
        assert.match(data.error, /still enforcing "read-only"/,
          'a failure before the level was written must say the OLD level is in force');

        // The other failure class must NOT claim that. Once the level file is
        // written the guard reads it per tool call, so the new level IS in
        // force and only the refresh that follows is in doubt — saying "still
        // enforcing read-only" there would be the false-reassurance direction.
        //
        // The message stopped naming the write guard specifically when
        // `levelApplied` widened (#968): the flag now covers the identity write
        // and the memory scaffold too, and a failure at either is far likelier
        // than at the guard. A message that named only the guard would send the
        // operator looking at the one artifact that is probably fine.
        const late = new Error('identity write failed');
        late.levelApplied = true;
        master.applyMasterAccessLevel = () => { throw late; };
        const second = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } });
        assert.equal(second.status, 500);
        assert.doesNotMatch(second.data.error, /still enforcing/);
        assert.match(second.data.error, /is now "write"/);
        assert.match(second.data.error, /refresh that should have followed it did not finish/);
        // A `doesNotMatch(/^[^]*only[^]*write guard/)` sat here and was VACUOUS:
        // it required a literal "only" before "write guard", which the old
        // message never contained, so it passed against the exact wording it
        // claimed to ban. Removed rather than repaired — the positive assertion
        // above already fails on a revert, and a guard that looks like a second
        // check while testing nothing is worse than one fewer check.
        assert.match(second.data.error, /Restart the master session/,
          'and it must say what to do about it');
      } finally {
        // Order matters, and getting it wrong is what the neighbouring comment
        // warns about: the cleanup PATCH still carries a CHANGED level, so with
        // the real applier restored first it takes the changed-level branch into
        // `masterHome()` — the operator's own `~/.tangleclaw/master`, which
        // `store._setBasePath(tmpDir)` does not redirect. Reset the config while
        // still stubbed, THEN restore.
        master.applyMasterAccessLevel = () => ({ applied: true, home: '/stub' });
        await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'read-only' } });
        master.applyMasterAccessLevel = realApply;
      }
    });

    it('a level tightened without knowing the engine is not reported as done, and says which half holds (#2128)', async () => {
      // `applyMasterAccessLevel` writes the level and the Claude guard when it
      // cannot work out what the Master runs on. That is a partial change: the
      // instructions were not rewritten. The route must not answer 200, and must
      // not say "still enforcing write" either — the guard is already tighter.
      const realApply = master.applyMasterAccessLevel;
      const blind = (guardBinds) => Object.assign(new Error('Unexpected token SECRET-FRAGMENT in JSON'), {
        runtimeUnknown: true, levelApplied: true, guardBinds
      });
      try {
        master.applyMasterAccessLevel = () => ({ applied: true, home: '/stub' });
        assert.equal((await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } })).status, 200);

        master.applyMasterAccessLevel = () => { throw blind(true); };
        const bound = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'read-only' } });
        assert.equal(bound.status, 500);
        assert.equal(bound.data.code, 'MASTER_LEVEL_NOT_APPLIED');
        assert.equal(store.config.load().master.accessLevel, 'read-only', 'the stored intent stands');
        assert.match(bound.data.error, /is now "read-only" and its write guard is in place/);
        assert.match(bound.data.error, /instructions and memory files were not refreshed/);
        assert.match(bound.data.error, /A master on another engine has no write guard/);
        assert.doesNotMatch(bound.data.error, /still enforcing/);
        assert.doesNotMatch(bound.data.error, /SECRET-FRAGMENT|Unexpected token/, 'the parser message stays in the log');

        master.applyMasterAccessLevel = () => ({ applied: true, home: '/stub' });
        assert.equal((await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } })).status, 200);
        master.applyMasterAccessLevel = () => { throw blind(false); };
        const unbound = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'read-only' } });
        assert.equal(unbound.status, 500);
        assert.match(unbound.data.error, /was written as "read-only", but the level file and the write guard did not both read back/);
        assert.match(unbound.data.error, /do not rely on this change having taken effect/);
        assert.doesNotMatch(unbound.data.error, /write guard is in place/);
        assert.doesNotMatch(unbound.data.error, /SECRET-FRAGMENT|Unexpected token/);

        // The engine resolved and the refresh finished, and the guard did not
        // read back. That is known, so it gets its own sentence: not the
        // engine one, and not "may be a step behind".
        master.applyMasterAccessLevel = () => ({ applied: true, home: '/stub' });
        assert.equal((await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } })).status, 200);
        master.applyMasterAccessLevel = () => { throw Object.assign(new Error('guard did not read back'), { levelApplied: true, guardBinds: false }); };
        const noGuard = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'read-only' } });
        assert.equal(noGuard.status, 500);
        assert.equal(noGuard.data.code, 'MASTER_LEVEL_NOT_APPLIED');
        assert.match(noGuard.data.error, /was written as "read-only" and its instructions were refreshed, but the level file and the write guard did not both read back/);
        assert.match(noGuard.data.error, /Repair the master's home directory and the `\.claude` directory inside it so they are writable, then restart the master session: a master that resolves as Claude Code has its write guard regenerated at start\. Check the guard status in Master settings afterwards\. Do not change the access level to retry\.$/);
        assert.doesNotMatch(noGuard.data.error, /change it back/, 'the remedy must never ask for a temporary grant');
        assert.match(noGuard.data.error, /do not rely on this change having taken effect for a master running Claude Code/);
        assert.doesNotMatch(noGuard.data.error, /could not determine which engine|may be a step behind|still enforcing/);

        // A grant that met the same fault was not applied at all: the applier
        // rethrows it with neither flag, and the old sentence is the true one.
        master.applyMasterAccessLevel = () => { throw new Error('Unexpected token SECRET-FRAGMENT in JSON'); };
        const grant = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'write' } });
        assert.equal(grant.status, 500);
        assert.match(grant.data.error, /still enforcing "read-only"/);
        assert.match(grant.data.error, /goes through once it is detected again; set `master\.engine` to another engine only if that is the engine the running master actually uses/);
        assert.doesNotMatch(grant.data.error, /SECRET-FRAGMENT|Unexpected token/);
      } finally {
        // Back through the store, never the route: see the engine block below.
        const config = store.config.load();
        if (config.master) config.master.accessLevel = 'read-only';
        store.config.save(config);
        master.applyMasterAccessLevel = realApply;
      }
    });

    it('a failed master level does not cancel the rest of the same save (#755)', async () => {
      // Co-submission is the REAL shape: the settings modal POSTs the whole form,
      // so a master-level failure arrives alongside unrelated settings. Returning
      // the 500 from inside the catch skipped the port-scanner restart and the
      // stripAiCoauthors walk below it — unrelated settings in the same save
      // silently not taking effect, a second failure bolted onto the first.
      // Without this case, putting `return errorResponse(...)` back inside the
      // catch leaves the suite green.
      const realApply = master.applyMasterAccessLevel;
      const realStop = portScanner.stopScanner;
      const realStart = portScanner.startScanner;
      const scannerCalls = [];
      master.applyMasterAccessLevel = () => { throw new Error('disk on fire'); };
      portScanner.stopScanner = () => { scannerCalls.push('stop'); };
      portScanner.startScanner = () => { scannerCalls.push('start'); };
      try {
        const { status, data } = await request(server, 'PATCH', '/api/config', {
          master: { accessLevel: 'suggest' },
          portScannerEnabled: true,
          chimeMuted: true
        });
        assert.equal(status, 500, 'the master failure is still reported');
        assert.equal(data.code, 'MASTER_LEVEL_NOT_APPLIED');

        // Assert the POST-SAVE WORK ran — not that the values persisted.
        // `store.config.save()` happens BEFORE the master block, so persistence
        // survives the mutation this test exists to catch and would report a
        // pass either way. What the deferral actually protects is the work
        // BELOW the catch: the port-scanner restart and the hook-sync walk.
        assert.ok(scannerCalls.includes('stop'),
          'the port-scanner restart below the catch must still run');
        assert.ok(scannerCalls.includes('start'),
          'and must restart it, since portScannerEnabled was saved as true');

        // And the contract the catch's comment makes: the config save is left
        // STANDING rather than rolled back, because the stored intent is right
        // and the next ensure reconciles the guard to it. This assertion is
        // mutation-immune on its own — the save happens before the master block
        // either way — so it rides alongside the side-effect checks above
        // rather than standing in for them.
        const after = await request(server, 'GET', '/api/config');
        assert.equal(after.data.chimeMuted, true,
          'the save is left standing, not rolled back');
      } finally {
        master.applyMasterAccessLevel = () => ({ applied: true, home: '/stub' });
        await request(server, 'PATCH', '/api/config', {
          master: { accessLevel: 'read-only' }, portScannerEnabled: false
        });
        master.applyMasterAccessLevel = realApply;
        portScanner.stopScanner = realStop;
        portScanner.startScanner = realStart;
      }
    });

    it('accepts every enforced access level, and still refuses one it does not know (#755)', async () => {
      const realApply = master.applyMasterAccessLevel;
      master.applyMasterAccessLevel = () => ({ applied: false, home: '/stub' });
      try {
      // All three carry real enforcement since the write guard reads the level
      // per tool call. The refusal that remains is for a level NOBODY has taught
      // the guard — which is a typo, or a tier someone enabled ahead of its
      // enforcement, and both must fail rather than silently mean read-only.
      for (const level of ['suggest', 'write', 'read-only']) {
        const { status } = await request(server, 'PATCH', '/api/config', { master: { accessLevel: level } });
        assert.equal(status, 200, `${level} must be settable`);
        const after = await request(server, 'GET', '/api/config');
        assert.equal(after.data.master.accessLevel, level, `${level} must persist`);
      }
      const unknown = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'root' } });
        assert.equal(unknown.status, 400);
        assert.match(unknown.data.error, /must be one of/);
      } finally {
        master.applyMasterAccessLevel = realApply;
      }
    });

    describe('master.engine must name a profile that says it is that engine (#2128, A160 R16)', () => {
      // `store.engines.get` is truthy for any file that parses. On a
      // case-insensitive disk `Claude` finds `claude.json`; a hand-placed file
      // may carry no id at all. Neither is the profile that was asked for.
      const realGet = store.engines.get;
      // EVERY test here goes through the settings route, and several send
      // `accessLevel`. The route applies a changed level to the Master's home
      // directory, which in this process is the OPERATOR'S REAL one. It is
      // stubbed for the whole block, as the accessLevel tests above do. The
      // guard test at the end of this file fingerprints the real home.
      const realApply = master.applyMasterAccessLevel;
      let applied;
      let masterBefore;
      beforeEach(() => {
        applied = [];
        master.applyMasterAccessLevel = (level) => { applied.push(level); return { applied: true, home: '/stub' }; };
        masterBefore = JSON.stringify(store.config.load().master);
      });
      afterEach(() => {
        store.engines.get = realGet;
        // The stored Master settings go back through the STORE, not the route:
        // cleanup that sends `accessLevel` through the route is one more caller
        // of the applier, and cleanup is where a missing stub goes unnoticed.
        const config = store.config.load();
        if (masterBefore === undefined) delete config.master;
        else config.master = JSON.parse(masterBefore);
        store.config.save(config);
        master.applyMasterAccessLevel = realApply;
      });
      // Read when a test runs: the test store is not initialised when this block is declared.
      const real = () => realGet.call(store.engines, 'claude');

      const UNIDENTIFIED = {
        'a file found under another letter case': ['Claude', () => real()],
        'a profile with no id': ['hand-placed', () => { const { id: _dropped, ...rest } = real(); return rest; }],
        'an empty object': ['hand-placed', () => ({})],
        'another profile\'s id': ['hand-placed', () => ({ ...real(), id: 'codex' })],
        'a number for an id': ['hand-placed', () => ({ ...real(), id: 7 })],
        'a list': ['hand-placed', () => [real()]]
      };

      for (const [what, [engineId, make]] of Object.entries(UNIDENTIFIED)) {
        it(`${what}: 400, the reason says what the file must carry, and nothing is saved`, async () => {
          const profile = make();
          const before = JSON.stringify(store.config.load().master);
          store.engines.get = (id) => (id === engineId ? profile : realGet.call(store.engines, id));
          const { status, data } = await request(server, 'PATCH', '/api/config', { master: { engine: engineId } });
          assert.equal(status, 400);
          assert.match(data.error, new RegExp(`master\\.engine "${engineId}" cannot be selected: its engine profile is not usable \\(what the store returned `));
          assert.match(data.error, new RegExp(`must be a JSON object whose "id" is exactly "${engineId}"`));
          assert.equal(JSON.stringify(store.config.load().master), before);
        });
      }

      describe('an engine ALREADY stored whose profile has gone bad does not block other Master settings (R17)', () => {
        // The check runs when a patch NAMES the engine. Run on the merged
        // settings it would refuse every partial patch over a stored engine
        // whose profile had lost its id, and the access toggle sends
        // `accessLevel` alone. What is pinned here is that the downgrade is
        // SAVED and handed to the applier; whether the applier can enforce it
        // without the engine is `test/master.test.js`'s to show.
        const stored = 'my-claude';
        beforeEach(async () => {
          const good = { ...real(), id: stored };
          store.engines.get = (id) => (id === stored ? good : realGet.call(store.engines, id));
          // The Master holds WRITE access when the profile goes bad: a downgrade
          // from read-only to read-only changes nothing and reaches no applier,
          // so it would pass whether or not revocation works.
          const set = await request(server, 'PATCH', '/api/config', { master: { engine: stored, accessLevel: 'write' } });
          assert.equal(set.status, 200, 'precondition: the engine was selectable when it was chosen');
          assert.equal(store.config.load().master.accessLevel, 'write', 'precondition: write access is what is stored');
          // Now its profile file loses its id.
          const { id: _dropped, ...identityless } = good;
          store.engines.get = (id) => (id === stored ? identityless : realGet.call(store.engines, id));
        });

        it('accessLevel alone, as the Master bar sends it, saves the downgrade and hands it to the applier', async () => {
          const before = applied.length;
          const { status } = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'read-only' } });
          assert.equal(status, 200);
          assert.equal(store.config.load().master.accessLevel, 'read-only');
          assert.deepEqual(applied.slice(before), ['read-only'], 'the route applied the new level once, and nothing else');
          assert.equal(store.config.load().master.engine, stored, 'and the stored engine is left as it was');
        });

        it('autoStart alone still saves', async () => {
          const { status } = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
          assert.equal(status, 200);
          assert.equal(store.config.load().master.autoStart, true);
        });

        it('naming that same engine in a patch is refused: it cannot be chosen again while its profile is bad', async () => {
          const { status, data } = await request(server, 'PATCH', '/api/config', { master: { engine: stored, autoStart: true } });
          assert.equal(status, 400);
          assert.match(data.error, /master\.engine "my-claude" cannot be selected: its engine profile is not usable \(what the store returned does not carry an `id`\)/);
        });

        it('the way out works: engine null, or another engine', async () => {
          assert.equal((await request(server, 'PATCH', '/api/config', { master: { engine: null } })).status, 200);
          assert.equal(store.config.load().master.engine, null);
          assert.equal((await request(server, 'PATCH', '/api/config', { master: { engine: 'claude' } })).status, 200);
        });
      });

      describe('an engine ALREADY stored whose profile is missing or unreadable does not block other Master settings either (R19)', () => {
        // The existence check follows the same rule as the identity test:
        // nothing about the engine is looked at unless the patch names it, so a
        // stored engine whose profile file is gone does not refuse a partial
        // patch.
        const stored = 'my-claude';
        // Real files in the test store's engines directory, so each case is the
        // case it is named for. A stub cannot tell a missing file from one that
        // holds `null` (the store answers null for both), and a stubbed throw
        // carries a parser message somebody typed.
        const profileFile = () => path.join(tmpDir, 'engines', `${stored}.json`);
        const TRUNCATED = '{"id": "my-claude", "name": "SECRET-FRAGMENT';
        const GONE = {
          'the profile file is missing': () => fs.rmSync(profileFile()),
          'the profile file holds null': () => fs.writeFileSync(profileFile(), 'null\n'),
          'the profile file does not parse': () => fs.writeFileSync(profileFile(), TRUNCATED)
        };

        for (const [what, spoil] of Object.entries(GONE)) {
          describe(what, () => {
            beforeEach(async () => {
              fs.writeFileSync(profileFile(), JSON.stringify({ ...real(), id: stored }));
              const set = await request(server, 'PATCH', '/api/config', { master: { engine: stored, accessLevel: 'write' } });
              assert.equal(set.status, 200, 'precondition: the engine was selectable when it was chosen');
              assert.equal(store.config.load().master.accessLevel, 'write', 'precondition: write access is what is stored');
              spoil();
            });

            afterEach(() => {
              fs.rmSync(profileFile(), { force: true });
            });

            it('accessLevel alone saves the downgrade and hands it to the applier: the engine is not consulted', async () => {
              const before = applied.length;
              const down = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'read-only' } });
              assert.equal(down.status, 200);
              assert.equal(store.config.load().master.accessLevel, 'read-only');
              assert.deepEqual(applied.slice(before), ['read-only'], 'the route applied the new level once, and nothing else');
              assert.equal(store.config.load().master.engine, stored, 'the stored engine is left as it was');
            });

            it('autoStart alone still saves', async () => {
              const { status } = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
              assert.equal(status, 200);
              assert.equal(store.config.load().master.autoStart, true);
            });

            it('naming that engine in a patch is refused with a 400, never a 500', async () => {
              const { status, data } = await request(server, 'PATCH', '/api/config', { master: { engine: stored, autoStart: true } });
              assert.equal(status, 400);
              assert.match(data.error, /master\.engine "my-claude" (is not a configured engine|cannot be selected: its engine profile file could not be read as JSON\. Repair or restore the file\.)$/);
              // The parser quotes the bytes it stopped at. None of that belongs
              // in a response.
              assert.doesNotMatch(data.error, /SECRET-FRAGMENT|Unexpected|Unterminated|position \d|JSON input/);
            });

            it('the way out works: engine null, or another engine', async () => {
              assert.equal((await request(server, 'PATCH', '/api/config', { master: { engine: null } })).status, 200);
              assert.equal((await request(server, 'PATCH', '/api/config', { master: { engine: 'claude' } })).status, 200);
            });
          });
        }
      });

      it('control: a custom profile carrying its own id can be selected', async () => {
        const custom = { ...real(), id: 'my-claude' };
        store.engines.get = (id) => (id === 'my-claude' ? custom : realGet.call(store.engines, id));
        const { status } = await request(server, 'PATCH', '/api/config', { master: { engine: 'my-claude' } });
        assert.equal(status, 200);
        assert.equal(store.config.load().master.engine, 'my-claude');
      });

      it('an engine with no profile at all keeps the answer it always had', async () => {
        const { status, data } = await request(server, 'PATCH', '/api/config', { master: { engine: 'no-such-engine' } });
        assert.equal(status, 400);
        assert.match(data.error, /is not a configured engine/);
      });
    });

    it('rejects unknown fields, unconfigured engines, missing groups, and bad shapes', async () => {
      const cases = [
        { master: { sneaky: true } },
        { master: { engine: 'no-such-engine' } },
        { master: { scope: { type: 'group', groupId: 'no-such-group' } } },
        { master: { scope: 'some-string' } },
        { master: { autoStart: 'yes' } },
        { master: 'read-only' },
        { master: ['read-only'] }
      ];
      for (const body of cases) {
        const { status } = await request(server, 'PATCH', '/api/config', body);
        assert.equal(status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
    });

    it('accepts a group scope for a real group', async () => {
      const group = store.projectGroups.create({ name: 'master-scope-group' });
      const { status } = await request(server, 'PATCH', '/api/config', {
        master: { scope: { type: 'group', groupId: group.id } }
      });
      assert.equal(status, 200);
      assert.deepEqual(store.config.load().master.scope, { type: 'group', groupId: group.id });
    });
  });
  // A TEST, not an `after` hook: a failing assertion inside `after` prints
  // `not ok` and still exits 0, so node --test would report it while CI passed.
  // Verified before relying on it. Runs last within this describe, which is what
  // makes it a whole-file check.
  it('did not touch the operator\'s real master home (#755)', () => {
    assert.equal(liveMasterState(), liveMasterFingerprint,
      'this suite rewrote the operator\'s real ~/.tangleclaw/master — a route test reached '
      + 'master.applyMasterAccessLevel without stubbing it (see the accessLevel tests)');
  });

});
