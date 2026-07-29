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
      assert.deepEqual(cutover.parseArgs(['--to', 'caddy']), { target: 'caddy', dryRun: false, force: false, resultFile: null });
    });
    it('parses --to direct --dry-run', () => {
      assert.deepEqual(cutover.parseArgs(['--to', 'direct', '--dry-run']), { target: 'direct', dryRun: true, force: false, resultFile: null });
    });
    it('treats --rollback as --to direct', () => {
      assert.deepEqual(cutover.parseArgs(['--rollback']), { target: 'direct', dryRun: false, force: false, resultFile: null });
    });
    it('parses --force (#397 clobber-guard override)', () => {
      assert.deepEqual(cutover.parseArgs(['--to', 'caddy', '--force']), { target: 'caddy', dryRun: false, force: true, resultFile: null });
    });
    it('rejects an unknown target', () => {
      assert.equal(cutover.parseArgs(['--to', 'nginx']).target, null);
    });
    it('returns null target when none given', () => {
      assert.equal(cutover.parseArgs([]).target, null);
    });

    it('parses --result-file', () => {
      assert.equal(cutover.parseArgs(['--to', 'caddy', '--result-file', '/tmp/r.json']).resultFile, '/tmp/r.json');
    });
    // A trailing --result-file with no value must not swallow the flag as its own
    // path, nor yield undefined: the caller branches on null.
    it('treats a valueless --result-file as absent', () => {
      assert.equal(cutover.parseArgs(['--to', 'caddy', '--result-file']).resultFile, null);
    });
    // The reporting flag must not change what the cutover DOES.
    it('does not disturb target/dryRun/force', () => {
      assert.deepEqual(
        cutover.parseArgs(['--to', 'direct', '--result-file', '/tmp/r.json', '--force', '--dry-run']),
        { target: 'direct', dryRun: true, force: true, resultFile: '/tmp/r.json' }
      );
    });
  });

  describe('writeCutoverResult', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cutover-result-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('writes a parseable outcome with the fields a caller branches on', () => {
      const p = path.join(dir, 'ok.json');
      assert.equal(cutover.writeCutoverResult(p, {
        ok: true, code: cutover.CUTOVER_CODES.OK, target: 'caddy',
        healthUrl: 'https://localhost:8443/api/health', healthOk: true
      }), true);
      const r = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(r.ok, true);
      assert.equal(r.code, 'ok');
      assert.equal(r.target, 'caddy');
      assert.equal(r.healthOk, true);
      assert.equal(r.error, null);
      assert.ok(r.finishedAt, 'carries a timestamp so a stale file is detectable');
    });

    it('normalizes a failure outcome — error text present, healthOk null not false', () => {
      const p = path.join(dir, 'fail.json');
      cutover.writeCutoverResult(p, {
        ok: false, code: cutover.CUTOVER_CODES.HAND_EDITED, target: 'caddy', error: 'refusing to overwrite'
      });
      const r = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(r.ok, false);
      assert.equal(r.code, 'hand-edited');
      assert.equal(r.error, 'refusing to overwrite');
      // null, not false: "never got far enough to check" is not "checked and unhealthy".
      assert.equal(r.healthOk, null);
    });

    it('creates the parent directory rather than failing on it', () => {
      const p = path.join(dir, 'nested', 'deeper', 'r.json');
      assert.equal(cutover.writeCutoverResult(p, { ok: true, code: 'ok', target: 'direct' }), true);
      assert.ok(fs.existsSync(p));
    });

    it('writes 0600 — the outcome names paths on the operator\'s box', () => {
      const p = path.join(dir, 'mode.json');
      cutover.writeCutoverResult(p, { ok: true, code: 'ok', target: 'caddy' });
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    });

    it('does nothing, and reports so, when no result file was requested', () => {
      assert.equal(cutover.writeCutoverResult(null, { ok: true, code: 'ok', target: 'caddy' }), false);
    });

    // The whole point of the best-effort contract: a cutover that has already
    // touched launchd must not abort because its status file is unwritable.
    it('never throws when the path cannot be written', () => {
      const p = path.join(dir, 'blocked');
      fs.mkdirSync(p, { recursive: true }); // a directory where a file must go
      assert.doesNotThrow(() => {
        assert.equal(cutover.writeCutoverResult(p, { ok: true, code: 'ok', target: 'caddy' }), false);
      });
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
    it('ignores TANGLECLAW_PORT — out-of-process, so the env describes the shell, not the service (#654)', () => {
      // This script is run by an operator, often from a TangleClaw-spawned shell
      // that inherited TANGLECLAW_PORT from the server. Caddy must proxy to the
      // *installed service*, whose port only the plist (or config) can attest.
      // Pins the deliberate abstention from httpsSetup.effectiveServerPort so a
      // later unification onto the shared helper fails here instead of in
      // production, where it would only misfire for some operators' shells.
      const had = Object.prototype.hasOwnProperty.call(process.env, 'TANGLECLAW_PORT');
      const prev = process.env.TANGLECLAW_PORT;
      try {
        process.env.TANGLECLAW_PORT = '3999';
        assert.equal(
          cutover.resolveUpstreamPort(path.join(tmpDir, 'nope.plist'), { serverPort: 3201 }),
          3201,
          'config must win over an ambient TANGLECLAW_PORT'
        );
        const p = path.join(tmpDir, 'server-env.plist');
        fs.writeFileSync(p, '<dict><key>TANGLECLAW_PORT</key>\n<string>3102</string></dict>');
        assert.equal(
          cutover.resolveUpstreamPort(p, { serverPort: 3201 }),
          3102,
          'the plist must win over an ambient TANGLECLAW_PORT'
        );
      } finally {
        if (had) process.env.TANGLECLAW_PORT = prev;
        else delete process.env.TANGLECLAW_PORT;
      }
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

    it('returns true for a file that exists but cannot be read', (t) => {
      // Protected, not "absent". The executor additionally refuses this case
      // outright before taking a backup -- a file that cannot be read cannot be
      // copied, so --force has no safety net to offer here.
      const p = path.join(tmpDir, 'unreadable');
      fs.writeFileSync(p, 'localhost {\n\treverse_proxy 127.0.0.1:3102\n}\n');
      fs.chmodSync(p, 0o000);
      t.after(() => fs.chmodSync(p, 0o600));
      try {
        fs.readFileSync(p, 'utf8');
        t.skip('running privileged — cannot make a file unreadable');
        return;
      } catch { /* expected */ }

      assert.equal(cutover.caddyfileIsHandEdited(p), true);
      assert.equal(caddy.classifyIngressState(p).state, 'unreadable',
        'the executor keys its explicit refusal off this state, not off the boolean');
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
    it('points the attach script at the non-TCC ~/.tangleclaw path, never the repo (#500)', () => {
      const ttyd = plan.plists.find((f) => f.path.endsWith('com.tangleclaw.ttyd.plist'));
      assert.match(ttyd.content, /<string>\/Users\/test\/\.tangleclaw\/deploy\/ttyd-attach\.sh<\/string>/);
      assert.doesNotMatch(ttyd.content, /\/repo\/deploy\/ttyd-attach\.sh/, 'repo-resident attach path is the TCC hazard');
      assert.doesNotMatch(ttyd.content, /__TTYD_ATTACH__/);
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
      // Case-sensitive path_regexp gate (#472/#434) — see caddy.test.js for the full matcher contract.
      assert.match(plan.caddyfile.content, /@protected not path_regexp \^\(\/api\/health\|/);
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
    it('points the attach script at the non-TCC ~/.tangleclaw path in direct mode too (#500)', () => {
      const ttyd = plan.plists[0];
      assert.match(ttyd.content, /<string>\/Users\/test\/\.tangleclaw\/deploy\/ttyd-attach\.sh<\/string>/);
      assert.doesNotMatch(ttyd.content, /\/repo\/deploy\/ttyd-attach\.sh/);
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
