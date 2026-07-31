'use strict';

// Changing the admin credential after setup. The gate is the Caddyfile, so the
// tests that matter here are about ORDER and REFUSAL, not about hashing: what
// must never happen is config recording a credential the live ingress is not
// enforcing, or a remote surface reaching a credential nothing is authenticating.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const cred = require('../lib/admin-credential');

const HASH_OLD = '$2a$14$' + 'o'.repeat(53);
const HASH_NEW = '$2b$12$' + 'n'.repeat(53);

/** A minimal generated-shaped Caddyfile carrying one basic_auth credential. */
function gatedCaddyfile(user = 'jason', hash = HASH_OLD) {
  return [
    'localhost:8443 {',
    '  basic_auth {',
    `    ${user} ${hash}`,
    '  }',
    '  reverse_proxy 127.0.0.1:3102',
    '}',
    ''
  ].join('\n');
}

describe('reloadCaddyArgs', () => {
  it('targets the Caddy LaunchAgent for the given uid', () => {
    assert.deepEqual(cred.reloadCaddyArgs(501), ['kickstart', '-k', 'gui/501/com.tangleclaw.caddy']);
  });
});

describe('canChangeCredential — the one predicate that guards this surface', () => {
  const gated = { state: 'generated', user: 'jason' };
  const configured = { ingressMode: 'caddy', basicAuthUser: 'jason', basicAuthHash: HASH_OLD };

  it('allows a change when a gate is live and a credential exists', () => {
    const r = cred.canChangeCredential(configured, gated);
    assert.equal(r.allowed, true);
    assert.equal(r.code, 'ok');
  });

  it('refuses when nothing is enforcing a login, and says so without blaming the operator', () => {
    // The important half is WHY: with no gate in force there is no perimeter, so
    // this request is unauthenticated. Allowing it would let whoever reaches an
    // ungated install claim it.
    const r = cred.canChangeCredential({ ...configured, ingressMode: 'direct' }, gated);
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'not-caddy-mode');
    assert.match(r.remedy, /ingress-cutover/, 'the operator needs the command that puts a login in place');
  });

  it('refuses when the live Caddyfile carries no gate, even though config records one', () => {
    // The stored-unconfirmed state: config holds a credential no ingress applies.
    // Changing it here would report a password change nothing enforces — which is
    // the false-report class this whole plan exists to eliminate.
    const r = cred.canChangeCredential(configured, { state: 'ungated', user: null });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'no-gate');
    assert.match(r.remedy, /reset-admin/, 'recovery is the terminal tool, not this surface');
  });

  it('refuses when there is no credential to change — that is RECOVERY, not settings', () => {
    // A dashboard route that sets a FIRST credential is the second remote door the
    // Direction forbids: a reset behind the gate cannot help someone the gate has
    // locked out, and an ungated install could be claimed by whoever reaches it.
    const r = cred.canChangeCredential(
      { ...configured, basicAuthUser: null, basicAuthHash: null }, gated);
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'no-credential');
    assert.match(r.remedy, /reset-admin/);
  });

  it('refuses on an unreadable Caddyfile rather than guessing the gate is absent', () => {
    // Absent and unreadable are different facts. Treating unreadable as "no gate"
    // would route an operator whose file merely has bad permissions toward the
    // wrong remedy entirely.
    const r = cred.canChangeCredential(configured, { state: 'unreadable', user: null });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'unreadable');
  });

  it('never returns allowed for any state that lacks a live gated user', () => {
    // Sweep rather than sample: the guard exists to be exhaustive, and a new
    // ingress state added later must not default into "allowed".
    for (const state of ['absent', 'generated', 'adoptable', 'ambiguous', 'ungated', 'unreadable']) {
      const r = cred.canChangeCredential(configured, { state, user: null });
      assert.equal(r.allowed, false, `state '${state}' with no live user must not be changeable`);
    }
  });
});

describe('applyCredentialChange', () => {
  let tmpBase; let prevBase; let caddyfilePath;

  before(() => {
    prevBase = store._getBasePath();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cred-'));
    store._setBasePath(tmpBase);
    store.init();
  });

  after(() => {
    store._setBasePath(prevBase);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  beforeEach(() => {
    caddyfilePath = path.join(tmpBase, 'Caddyfile');
    fs.writeFileSync(caddyfilePath, gatedCaddyfile(), { mode: 0o600 });
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.authEnabled = true;
    config.basicAuthUser = 'jason';
    config.basicAuthHash = HASH_OLD;
    store.config.save(config);
  });

  it('patches the gate, records the credential, and reloads Caddy', () => {
    const calls = [];
    const r = cred.applyCredentialChange({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: (cmd, argv) => { calls.push({ cmd, argv }); },
      validateFn: () => ({ ok: true })
    });

    assert.equal(r.ok, true);
    assert.equal(r.reloaded, true);
    assert.match(fs.readFileSync(caddyfilePath, 'utf8'), new RegExp(HASH_NEW.replace(/\$/g, '\\$')),
      'the LIVE gate must carry the new hash — config alone is not a credential change');
    assert.equal(store.config.load().basicAuthHash, HASH_NEW);
    assert.deepEqual(calls[0].argv, ['kickstart', '-k', 'gui/501/com.tangleclaw.caddy']);
  });

  it('leaves BOTH the gate and the recorded credential untouched when validation fails', () => {
    // Order is the whole point: the Caddyfile is patched and validated before
    // config moves, so a rejected file cannot leave config claiming a password the
    // ingress never accepted. Config disagreeing with the live gate is the state
    // every part of this chunk exists to prevent.
    let reloadAttempted = false;
    const r = cred.applyCredentialChange({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => { reloadAttempted = true; },
      validateFn: () => ({ ok: false, error: 'bad directive' })
    });

    assert.equal(r.ok, false);
    assert.equal(r.code, 'validate-failed');
    assert.match(r.error, /bad directive/);
    assert.equal(store.config.load().basicAuthHash, HASH_OLD, 'config must not have moved');
    assert.match(fs.readFileSync(caddyfilePath, 'utf8'), new RegExp(HASH_OLD.replace(/\$/g, '\\$')),
      'the original gate must be restored');
    assert.equal(reloadAttempted, false, 'a rejected change must never reach the reload');
  });

  it('reports a failed reload without calling the change a failure', () => {
    // By the time the reload runs the file is patched and validated, so the
    // credential HAS changed. Reporting failure would send the operator to undo a
    // change that already took, and hide the one command still to run.
    const r = cred.applyCredentialChange({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => { throw new Error('launchctl: no such process'); },
      validateFn: () => ({ ok: true })
    });

    assert.equal(r.ok, true, 'the credential did change');
    assert.equal(r.reloaded, false);
    assert.match(r.reloadCommand, /launchctl kickstart -k gui\/501\//,
      'the operator must be given the command that finishes it');
    assert.equal(store.config.load().basicAuthHash, HASH_NEW);
  });

  it('keeps a timestamped backup so a repeat run cannot clobber the previous one', () => {
    cred.applyCredentialChange({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'FIRST',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    cred.applyCredentialChange({
      caddyfilePath, user: 'jason', hash: HASH_OLD, uid: 501, stamp: 'SECOND',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    assert.ok(fs.existsSync(`${caddyfilePath}.FIRST.bak`));
    assert.ok(fs.existsSync(`${caddyfilePath}.SECOND.bak`));
  });
});

describe('one implementation, not two', () => {
  it('reset-admin.js consumes the shared helpers instead of re-declaring them', () => {
    // A hand-maintained mirror of the Caddyfile-adoption logic drifted from its
    // original and produced a real defect, which is why adoption was collapsed to
    // one shared computation. This is the same shape: two places patch the live
    // Caddyfile, and only one may define how.
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reset-admin.js'), 'utf8');
    assert.doesNotMatch(src, /^function reloadCaddyArgs\(/m,
      'the reload argv must come from lib/admin-credential, not a second copy');
    assert.doesNotMatch(src, /^function writeValidatedCaddyfile\(/m,
      'the fail-closed write must come from lib/admin-credential, not a second copy');
    assert.match(src, /require\(path\.join\(REPO_DIR, 'lib', 'admin-credential'\)\)/);
  });

  it('still exports them, so its own callers and tests are unaffected', () => {
    const resetAdmin = require('../scripts/reset-admin');
    assert.equal(resetAdmin.reloadCaddyArgs, cred.reloadCaddyArgs);
    assert.equal(resetAdmin.writeValidatedCaddyfile, cred.writeValidatedCaddyfile);
  });
});
