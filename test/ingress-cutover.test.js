'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cutover = require('../scripts/ingress-cutover');

const DEPLOY_DIR = path.join(__dirname, '..', 'deploy');
const TTYD_TEMPLATE = fs.readFileSync(path.join(DEPLOY_DIR, 'com.tangleclaw.ttyd.plist'), 'utf8');
const CADDY_TEMPLATE = fs.readFileSync(path.join(DEPLOY_DIR, 'com.tangleclaw.caddy.plist'), 'utf8');

// Read for the call sites that live inside `main()` as closures: `main()` runs
// only under `require.main === module`, so nothing importable reaches them and a
// behavioural test cannot pin them. Source assertion is this repo's answer —
// see the ttyd bind pair in test/bind-policy-wiring.test.js and the adoption
// delegation in test/auth-credential-durability.test.js.
const CUTOVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ingress-cutover.js'), 'utf8');

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
    caddyTemplate: CADDY_TEMPLATE,
    // #863 — resolved by main() from os.hostname() once a cert covers it. Named
    // here so a test can override it; left undefined the forwarding below could
    // be deleted and every test would still pass.
    lanHost: overrides.lanHost === undefined ? null : overrides.lanHost
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

  // The executor's clobber guard reads `safeToWrite` from classifyIngressState —
  // so that is what these assert. They previously went through a thin wrapper in
  // this script; the wrapper is gone, and testing it would have meant the suite's
  // only clobber-guard coverage exercised a function the executor never calls.
  describe('clobber guard — safeToWrite is what the executor branches on (#397/#710)', () => {
    let tmpDir;
    before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cutover-he-')); });
    after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const caddy = require('../lib/caddy');

    it('absent → safe to write (the ordinary first cutover)', () => {
      assert.equal(caddy.classifyIngressState(path.join(tmpDir, 'absent')).safeToWrite, true);
    });
    it('pristine generated → safe to write (regenerating reproduces it)', () => {
      const p = path.join(tmpDir, 'gen');
      fs.writeFileSync(p, caddy.buildCaddyfileContent({ serverPort: 3101, certPath: '/c/cert.pem', keyPath: '/c/key.pem' }));
      assert.equal(caddy.classifyIngressState(p).safeToWrite, true);
    });
    it('hand-edited (header kept, body changed) → NOT safe to write', () => {
      const p = path.join(tmpDir, 'edited');
      const tampered = caddy.buildCaddyfileContent({ serverPort: 3101, certPath: '/c/cert.pem', keyPath: '/c/key.pem' })
        .replace(/\}\n$/, '\tbasic_auth { jason $2a$hash }\n}\n');
      fs.writeFileSync(p, tampered);
      assert.equal(caddy.classifyIngressState(p).safeToWrite, false);
    });

    it('present but unreadable → NOT safe to write, and reported as its own state', (t) => {
      // Protected, not "absent". The executor refuses this case outright BEFORE
      // building its context -- an unreadable file cannot be copied, so --force
      // has no safety net to offer here.
      const p = path.join(tmpDir, 'unreadable');
      fs.writeFileSync(p, 'localhost {\n\treverse_proxy 127.0.0.1:3102\n}\n');
      fs.chmodSync(p, 0o000);
      t.after(() => fs.chmodSync(p, 0o600));
      try {
        fs.readFileSync(p, 'utf8');
        t.skip('running privileged — cannot make a file unreadable');
        return;
      } catch { /* expected */ }

      const state = caddy.classifyIngressState(p);
      assert.equal(state.safeToWrite, false);
      assert.equal(state.state, 'unreadable',
        'the executor keys its explicit refusal off this state, not off a boolean alone');
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

  // #863 — the generator's half is covered in test/caddy.test.js. This covers
  // the WIRE: planCutover must forward ctx.lanHost into buildCaddyfileContent.
  // Without these, deleting `lanHost: ctx.lanHost` left the whole suite green
  // while a default install went back to being unreachable by name.
  // Regeneration is DESTRUCTIVE to names nothing else records — no config field
  // stores the host list a cert was minted with, so the cert is its own only
  // record. Two attempts at this shipped broken before a clean-room run caught
  // it, both for the same reason: the union read only its argument, and the
  // branch that actually regenerates calls it BEFORE ctx.certPath is assigned.
  describe('certHostUnion — regeneration must never shrink the SAN (#863)', () => {
    const os3 = require('node:os');

    it('always includes the base names and the machine mDNS name', () => {
      const hosts = cutover.certHostUnion(null, {});
      for (const base of ['localhost', '127.0.0.1', '::1']) {
        assert.ok(hosts.includes(base), `${base} must always be present`);
      }
      const mdns = require('../lib/https-setup').mdnsHostFor(os3.hostname());
      if (mdns) assert.ok(hosts.includes(mdns), 'the mDNS name must be carried');
    });

    it('carries the sites config says we are about to emit', () => {
      const hosts = cutover.certHostUnion(null, {
        caddyTailnetHost: 'box.tail1234.ts.net', publicDomain: 'tc.example.com'
      });
      assert.ok(hosts.includes('box.tail1234.ts.net'),
        'the tailnet site reuses this cert — dropping its name un-covers that site');
      assert.ok(hosts.includes('tc.example.com'));
    });

    it('tolerates a null certPath — the branch that regenerates passes exactly that', () => {
      // The bug: ctx.certPath is null in the "no valid cert configured" branch,
      // so reading only the argument carried nothing and the union silently
      // degraded to the defaults.
      assert.doesNotThrow(() => cutover.certHostUnion(null, null));
      assert.ok(cutover.certHostUnion(null, null).includes('localhost'));
    });

    it('never returns duplicates', () => {
      const hosts = cutover.certHostUnion(null, { caddyTailnetHost: 'localhost' });
      assert.equal(hosts.length, new Set(hosts).size);
    });

    // THE assertion the others were missing: that a name already in the cert is
    // actually carried forward. Without this, deleting the SAN read leaves every
    // other case in this block green — which is the exact gap that let the
    // carry-forward ship broken twice. Hermetic: the base path is redirected to
    // a temp dir, so it reads a cert this test minted rather than the
    // developer's real ~/.tangleclaw, which would pass locally and prove nothing
    // in CI.
    it('carries a name FORWARD out of the existing certificate', () => {
      const store2 = require('../lib/store');
      const fsx = require('node:fs');
      const pathx = require('node:path');
      const osx = require('node:os');
      const { execSync: execX } = require('node:child_process');

      const base = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'tc-union-'));
      fsx.mkdirSync(pathx.join(base, 'certs'), { recursive: true });
      try {
        execX(
          `openssl req -x509 -newkey rsa:2048 -keyout "${pathx.join(base, 'certs', 'key.pem')}" `
          + `-out "${pathx.join(base, 'certs', 'cert.pem')}" -days 2 -nodes -subj "/CN=localhost" `
          + '-addext "subjectAltName=DNS:localhost,DNS:carried.tail9999.ts.net"',
          { stdio: 'ignore', timeout: 20000 }
        );
      } catch {
        return; // openssl unavailable; the hermetic cases above still ran
      }

      const prev = store2._getBasePath();
      store2._setBasePath(base);
      try {
        // certPath null on purpose — this is exactly how the regenerating branch
        // calls it (ctx.certPath is not assigned yet), and reading only the
        // argument is what made the union silently degrade to the defaults.
        const hosts = cutover.certHostUnion(null, {});
        assert.ok(hosts.includes('carried.tail9999.ts.net'),
          `existing SAN must be carried forward, got ${JSON.stringify(hosts)}`);
      } finally {
        store2._setBasePath(prev);
        fsx.rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('planCutover → caddy LAN hostname forwarding (#863)', () => {
    const gated = { authEnabled: true, basicAuthUser: 'admin', basicAuthHash: '$2a$14$abcdefghijklmnopqrstuv' };

    it('forwards ctx.lanHost into the generated Caddyfile', () => {
      const plan = cutover.planCutover('caddy', makeCtx({ config: gated, lanHost: 'studio.local' }));
      assert.match(plan.caddyfile.content, /^localhost, studio\.local \{$/m,
        'the resolved LAN name must reach the generator');
    });

    it('emits localhost only when no LAN name was resolved', () => {
      const plan = cutover.planCutover('caddy', makeCtx({ config: gated, lanHost: null }));
      assert.match(plan.caddyfile.content, /^localhost \{$/m);
    });

    it('does not advertise the LAN name on an ungated install', () => {
      // The end-to-end statement of the invariant: even when main() resolved a
      // name, an install with no credential must stay loopback-only.
      const plan = cutover.planCutover('caddy', makeCtx({ lanHost: 'studio.local' }));
      assert.ok(!plan.caddyfile.content.includes('studio.local'));
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

    // That the refusal FIRES is already covered, in
    // `test/auth-credential-durability.test.js` → "planCutover — refuse-to-ungate
    // guard". Do NOT delete that as redundant with this: the test below asserts a
    // different property and deliberately does not re-assert the throw.
    //
    // What is covered here is that the refusal stays DISTINGUISHABLE from the five
    // unrelated validation errors `buildCaddyfileContent` raises. Untagged, they
    // all collapse into one code, and a caller would answer a missing-certificate
    // fault by telling the operator to reset their password.
    /** ctx whose LIVE Caddyfile is gated while config carries no credential. */
    function gatedFileCtx() {
      const ctx = makeCtx({ config: { authEnabled: false } });
      ctx.existingCaddyfileText = `localhost {\n\tbasic_auth {\n\t\tjason ${BCRYPT}\n\t}\n}\n`;
      return ctx;
    }

    it('tags ONLY the ungate refusal, so it can be told apart from a build failure', () => {
      let refusal = null;
      try { cutover.planCutover('caddy', gatedFileCtx()); } catch (e) { refusal = e; }
      assert.ok(refusal, 'the ungate refusal must throw');
      assert.equal(refusal.cutoverCode, 'ungate-refused');

      // A generator validation error is a different problem with a different
      // operator remedy, and must NOT carry the credential-flavoured code —
      // untagged errors route to `failed`.
      let buildError = null;
      try {
        cutover.planCutover('caddy', makeCtx({ config: { authEnabled: true, basicAuthUser: 'jason', basicAuthHash: null } }));
      } catch (e) { buildError = e; }
      assert.ok(buildError, 'the half-set auth config must throw');
      assert.equal(buildError.cutoverCode, undefined,
        'an untagged error must not be reported as a credential problem');
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

  describe('pollHealth picks its client from the URL scheme (#789)', () => {
    // The rollback regression. `pollHealth` used https.get unconditionally, so
    // `--to caddy` (https://localhost:8443) worked and `--to direct`
    // (http://localhost:3102) threw ERR_INVALID_PROTOCOL — AFTER the ingress had
    // already switched. The operator saw a stack trace following a successful
    // rollback, the exit code said failure, and no result file was written. This
    // is the break-glass path, so it gets pinned in both directions.

    it('resolves rather than throwing for an http:// URL', async () => {
      // Mutation this catches: reverting to `https.get`. That throws
      // synchronously here, and a throw inside the promise executor rejects —
      // so `await` re-raises and this test fails rather than timing out.
      const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        const url = `http://127.0.0.1:${server.address().port}/api/health`;
        assert.equal(await cutover.pollHealth(url, 2), true,
          'a reachable http health endpoint must report healthy');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('reports unhealthy instead of crashing when the URL cannot be requested', async () => {
      // A scheme `get()` refuses throws synchronously rather than emitting
      // 'error', so it escaped the promise's handlers entirely. A health poll
      // must never take down a run whose actual work already completed.
      assert.equal(await cutover.pollHealth('ftp://localhost/api/health', 1), false);
      assert.equal(await cutover.pollHealth('not a url at all', 1), false);
    });

    it('reports unhealthy for a well-formed URL nothing is serving', async () => {
      // The honest-negative case: distinguishes "cannot build a request" from
      // "built it and nobody answered". Both are false; only the first was a crash.
      assert.equal(await cutover.pollHealth('http://127.0.0.1:1/api/health', 1), false);
    });
  });

  describe('an unbuildable health URL must not invert the outcome (#789 follow-up)', () => {
    // The trap this pins: `finish` derives BOTH `ok` and the exit code from `error`
    // (`ok: !error`, `process.exit(error ? 1 : 0)`). Routing a health-probe reason
    // through `error` therefore makes a fully-applied cutover report
    // {ok:false, code:'ok'} and exit 1 — which server.js forwards and the wizard
    // maps to phase:'failed', rendering "No login is in force" on an install that
    // IS gated. That is the exact false-negative this whole chunk exists to prevent,
    // reached through the fix for it.

    it('never hands the health reason to finish() as its `error`', () => {
      // The tests below exercise `writeCutoverResult` and `pollHealth` directly,
      // which is everything EXCEPT the line that carried the defect: the call site
      // is `finish(...)` inside `main()`, a closure no test can invoke. Reverting
      // it to `finish(CUTOVER_CODES.OK, healthError, …)` leaves every other
      // assertion in this block green while restoring the inversion verbatim.
      assert.doesNotMatch(CUTOVER_SRC, /finish\(CUTOVER_CODES\.OK,\s*healthError/,
        'passing a health-probe reason as finish()\'s `error` flips `ok` to false and exits 1');
      assert.match(CUTOVER_SRC, /finish\(CUTOVER_CODES\.OK,\s*null,\s*\{[^}]*\bhealthError\b[^}]*\}\)/,
        'the reason must still reach the result file, as its own field in `extra`');
    });

    it('reports the reason without saying the cutover failed', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cutover-res-'));
      const file = path.join(dir, 'result.json');
      try {
        cutover.writeCutoverResult(file, {
          ok: true, code: cutover.CUTOVER_CODES.OK, target: 'direct', error: null,
          healthUrl: 'http://localhost:3102/api/health', healthOk: false,
          healthError: 'Protocol "ftp:" not supported'
        });
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(d.ok, true, 'the plan was applied — the run did not fail');
        assert.equal(d.code, 'ok');
        assert.equal(d.error, null, 'a health-probe reason must never land in `error`');
        assert.equal(d.healthOk, false);
        assert.equal(d.healthError, 'Protocol "ftp:" not supported',
          'the reason must survive into the result file — the detached child has no stdout');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('carries healthError as its own key, since the builder drops unnamed fields', () => {
      // writeCutoverResult assembles the JSON key-by-key, so a field that is not
      // named explicitly is silently discarded. That is why the reason was first
      // (wrongly) routed through `error`. If someone removes the key, this goes red
      // rather than the reason quietly vanishing again.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cutover-key-'));
      const file = path.join(dir, 'r.json');
      try {
        cutover.writeCutoverResult(file, { ok: true, code: 'ok', target: 'caddy', healthError: 'boom' });
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok('healthError' in d, 'healthError must be an explicit key in the result contract');
        assert.equal(d.healthError, 'boom');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('invokes onUnbuildable with the cause, and only from the failure path', async () => {
      const seen = [];
      assert.equal(await cutover.pollHealth('ftp://localhost/api/health', 1, (e) => seen.push(e.message)), false);
      assert.equal(seen.length, 1, 'the caller must learn WHY, not just that it failed');
      assert.match(seen[0], /.+/);

      // Success path must never reach it.
      const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        const before = seen.length;
        await cutover.pollHealth(`http://127.0.0.1:${server.address().port}/h`, 2, (e) => seen.push(e.message));
        assert.equal(seen.length, before, 'onUnbuildable must not fire on a healthy probe');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});
