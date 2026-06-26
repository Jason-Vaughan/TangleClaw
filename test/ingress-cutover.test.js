'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cutover = require('../scripts/ingress-cutover');

const DEPLOY_DIR = path.join(__dirname, '..', 'deploy');
const TTYD_TEMPLATE = fs.readFileSync(path.join(DEPLOY_DIR, 'com.tangleclaw.ttyd.plist'), 'utf8');
const CADDY_TEMPLATE = fs.readFileSync(path.join(DEPLOY_DIR, 'com.tangleclaw.caddy.plist'), 'utf8');

/** Build a representative ctx for planCutover. */
function makeCtx(overrides = {}) {
  return {
    config: {
      serverPort: 3101, ttydPort: 3100,
      caddyHttpsPort: 8443, caddyHttpPort: 8080,
      publicDomain: null, httpsEnabled: true,
      httpsCertPath: '/c/cert.pem', httpsKeyPath: '/c/key.pem',
      ...(overrides.config || {})
    },
    env: {
      caddyPath: '/opt/homebrew/bin/caddy', ttydPath: '/opt/homebrew/bin/ttyd',
      home: '/Users/test', repoDir: '/repo',
      launchdPath: '/usr/bin:/bin', launchAgentsDir: '/Users/test/Library/LaunchAgents',
      uid: 501,
      ...(overrides.env || {})
    },
    upstreamPort: overrides.upstreamPort || 3102,
    certPath: '/c/cert.pem', keyPath: '/c/key.pem',
    caddyfilePath: '/Users/test/.tangleclaw/Caddyfile',
    socketPath: '/Users/test/.tangleclaw/run/ttyd.sock',
    ttydTemplate: TTYD_TEMPLATE,
    caddyTemplate: CADDY_TEMPLATE
  };
}

describe('ingress-cutover', () => {
  describe('parseArgs', () => {
    it('parses --to caddy', () => {
      assert.deepEqual(cutover.parseArgs(['--to', 'caddy']), { target: 'caddy', dryRun: false, force: false });
    });
    it('parses --to direct --dry-run', () => {
      assert.deepEqual(cutover.parseArgs(['--to', 'direct', '--dry-run']), { target: 'direct', dryRun: true, force: false });
    });
    it('treats --rollback as --to direct', () => {
      assert.deepEqual(cutover.parseArgs(['--rollback']), { target: 'direct', dryRun: false, force: false });
    });
    it('parses --force (#397 clobber-guard override)', () => {
      assert.deepEqual(cutover.parseArgs(['--to', 'caddy', '--force']), { target: 'caddy', dryRun: false, force: true });
    });
    it('rejects an unknown target', () => {
      assert.equal(cutover.parseArgs(['--to', 'nginx']).target, null);
    });
    it('returns null target when none given', () => {
      assert.equal(cutover.parseArgs([]).target, null);
    });
  });

  describe('fillTemplate', () => {
    it('replaces all occurrences of a token', () => {
      assert.equal(cutover.fillTemplate('__A__ x __A__ __B__', { A: '1', B: '2' }), '1 x 1 2');
    });
  });

  describe('resolveUpstreamPort', () => {
    let tmpDir;
    before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cutover-')); });
    after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('reads TANGLECLAW_PORT from the installed server plist', () => {
      const p = path.join(tmpDir, 'server.plist');
      fs.writeFileSync(p, '<dict><key>TANGLECLAW_PORT</key>\n<string>3102</string></dict>');
      assert.equal(cutover.resolveUpstreamPort(p, { serverPort: 3101 }), 3102);
    });
    it('falls back to config.serverPort when the plist is absent', () => {
      assert.equal(cutover.resolveUpstreamPort(path.join(tmpDir, 'nope.plist'), { serverPort: 3201 }), 3201);
    });
    it('falls back to 3101 when neither is available', () => {
      assert.equal(cutover.resolveUpstreamPort(path.join(tmpDir, 'nope.plist'), {}), 3101);
    });
  });

  describe('caddyfileIsHandEdited (#397 clobber-guard, shared by dry-run + executor)', () => {
    let tmpDir;
    before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cutover-he-')); });
    after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const caddy = require('../lib/caddy');

    it('returns false when the file does not exist (first cutover)', () => {
      assert.equal(cutover.caddyfileIsHandEdited(path.join(tmpDir, 'absent')), false);
    });
    it('returns false for a pristine generated Caddyfile (safe to overwrite)', () => {
      const p = path.join(tmpDir, 'gen');
      fs.writeFileSync(p, caddy.buildCaddyfileContent({ serverPort: 3101, certPath: '/c/cert.pem', keyPath: '/c/key.pem' }));
      assert.equal(cutover.caddyfileIsHandEdited(p), false);
    });
    it('returns true for a hand-edited Caddyfile (header kept, body changed)', () => {
      const p = path.join(tmpDir, 'edited');
      const tampered = caddy.buildCaddyfileContent({ serverPort: 3101, certPath: '/c/cert.pem', keyPath: '/c/key.pem' })
        .replace(/\}\n$/, '\tbasic_auth { jason $2a$hash }\n}\n');
      fs.writeFileSync(p, tampered);
      assert.equal(cutover.caddyfileIsHandEdited(p), true);
    });
  });

  describe('planCutover → caddy', () => {
    const plan = cutover.planCutover('caddy', makeCtx());

    it('writes a Caddyfile proxying to the real upstream port', () => {
      assert.ok(plan.caddyfile);
      assert.match(plan.caddyfile.content, /reverse_proxy 127\.0\.0\.1:3102/);
      assert.match(plan.caddyfile.content, /https_port 8443/);
      assert.match(plan.caddyfile.content, /tls \/c\/cert\.pem \/c\/key\.pem/);
    });
    it('binds ttyd to the Unix socket via --interface', () => {
      const ttyd = plan.plists.find((f) => f.path.endsWith('com.tangleclaw.ttyd.plist'));
      assert.match(ttyd.content, /<string>--interface<\/string>/);
      assert.match(ttyd.content, /<string>\/Users\/test\/\.tangleclaw\/run\/ttyd\.sock<\/string>/);
      assert.doesNotMatch(ttyd.content, /__TTYD_BIND_KEY__/);
    });
    it('runs ttyd via the inline /bin/bash launcher and sets TTYD_SOCKET for stale-socket unlink (#397 bug 2)', () => {
      const ttyd = plan.plists.find((f) => f.path.endsWith('com.tangleclaw.ttyd.plist'));
      // Launchd program is the non-TCC system bash, not a repo-resident script.
      assert.match(ttyd.content, /<string>\/bin\/bash<\/string>/);
      assert.doesNotMatch(ttyd.content, /\/repo\/deploy\/ttyd-launch\.sh/);
      // TTYD_SOCKET env filled with the socket path; placeholder fully resolved.
      assert.match(ttyd.content, /<key>TTYD_SOCKET<\/key>\s*<string>\/Users\/test\/\.tangleclaw\/run\/ttyd\.sock<\/string>/);
      assert.doesNotMatch(ttyd.content, /__TTYD_SOCKET__/);
    });
    it('emits a caddy plist pointing at the binary and Caddyfile', () => {
      const cad = plan.plists.find((f) => f.path.endsWith('com.tangleclaw.caddy.plist'));
      assert.match(cad.content, /<string>\/opt\/homebrew\/bin\/caddy<\/string>/);
      assert.match(cad.content, /<string>\/Users\/test\/\.tangleclaw\/Caddyfile<\/string>/);
      assert.doesNotMatch(cad.content, /__CADDY_PATH__/);
    });
    it('patches ingressMode to caddy and restarts the server', () => {
      assert.deepEqual(plan.configPatch, { ingressMode: 'caddy' });
      assert.ok(plan.launchctl.some((c) => c[0] === 'kickstart' && c[2] === 'gui/501/com.tangleclaw.server'));
    });
    it('health-checks via the caddy HTTPS port', () => {
      assert.equal(plan.healthUrl, 'https://localhost:8443/api/health');
    });
  });

  describe('planCutover → caddy basic_auth gate (AUTH-2)', () => {
    const BCRYPT = '$2a$14$0Eq3PY/I86yjD0yXuZNv3eKbNXqSyeO911yQE8qvUKFVE/f0SjEWW';

    it('leaves the Caddyfile ungated when authEnabled is false (flag gates the wiring)', () => {
      // Creds present but the flag is off ⇒ they are NOT passed through ⇒ open site.
      const plan = cutover.planCutover('caddy', makeCtx({ config: { authEnabled: false, basicAuthUser: 'jason', basicAuthHash: BCRYPT } }));
      assert.doesNotMatch(plan.caddyfile.content, /basic_auth/);
    });

    it('gates the Caddyfile when authEnabled with a user + hash', () => {
      const plan = cutover.planCutover('caddy', makeCtx({ config: { authEnabled: true, basicAuthUser: 'jason', basicAuthHash: BCRYPT } }));
      assert.match(plan.caddyfile.content, /@protected not path \/api\/health/);
      assert.match(plan.caddyfile.content, /basic_auth @protected \{/);
      assert.match(plan.caddyfile.content, /jason \$2a\$14\$/);
    });

    it('throws on a half-set auth config — the generator both-or-neither backstop (defends a hand-edited config.json)', () => {
      assert.throws(
        () => cutover.planCutover('caddy', makeCtx({ config: { authEnabled: true, basicAuthUser: 'jason', basicAuthHash: null } })),
        /must be set together/
      );
    });
  });

  describe('planCutover → direct', () => {
    const plan = cutover.planCutover('direct', makeCtx());

    it('writes no Caddyfile', () => {
      assert.equal(plan.caddyfile, null);
    });
    it('rebinds ttyd to the TCP port via --port', () => {
      const ttyd = plan.plists[0];
      assert.match(ttyd.content, /<string>--port<\/string>/);
      assert.match(ttyd.content, /<string>3100<\/string>/);
    });
    it('leaves TTYD_SOCKET empty in direct mode (TCP bind — nothing to unlink)', () => {
      const ttyd = plan.plists[0];
      assert.match(ttyd.content, /<key>TTYD_SOCKET<\/key>\s*<string><\/string>/);
      assert.doesNotMatch(ttyd.content, /__TTYD_SOCKET__/);
    });
    it('unloads caddy and patches ingressMode to direct', () => {
      assert.deepEqual(plan.configPatch, { ingressMode: 'direct' });
      assert.ok(plan.launchctl.some((c) => c[0] === 'unload' && c[1].endsWith('com.tangleclaw.caddy.plist')));
    });
    it('health-checks direct on the upstream port with the configured protocol', () => {
      assert.equal(plan.healthUrl, 'https://localhost:3102/api/health');
    });
    it('uses http in the health URL when HTTPS is not fully configured', () => {
      const p = cutover.planCutover('direct', makeCtx({ config: { httpsCertPath: null, httpsKeyPath: null } }));
      assert.equal(p.healthUrl, 'http://localhost:3102/api/health');
    });
  });
});
