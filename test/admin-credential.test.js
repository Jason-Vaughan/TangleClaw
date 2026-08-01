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

  it('names the job from one place, so a rename cannot reload nothing', () => {
    // Two writers restart this job by label — the settings surface and the cutover.
    // A second copy of the literal is a rename away from kickstarting a job that no
    // longer exists, which exits 0 and changes nothing: a reload that reports
    // success and leaves the old password in force.
    const caddy = require('../lib/caddy');
    assert.equal(caddy.CADDY_LABEL, 'com.tangleclaw.caddy');
    const cutover = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ingress-cutover.js'), 'utf8');
    assert.doesNotMatch(cutover, /CADDY_LABEL = 'com\.tangleclaw\.caddy'/,
      'the cutover must take the label from lib/caddy, not re-declare it');
    assert.match(cutover, /CADDY_LABEL = caddy\.CADDY_LABEL/);
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

  it('refuses a request that did not arrive on a loopback connection', () => {
    // The path this closes, which none of the other conditions can see: in caddy
    // mode the listener is loopback-only, but that bind is chosen at LISTEN time
    // while `ingressMode` is read per request. An install running direct-and-wide
    // (the legacy grace state) has an unauthenticated `PATCH /api/config` that
    // accepts `ingressMode` — so a caller on the network can flip config to caddy
    // and reach this route over the still-wide socket, with every other condition
    // satisfied on a machine whose Caddyfile really does carry a gate.
    const r = cred.canChangeCredential(configured, gated, true, false);
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'remote-connection');
    assert.match(r.remedy, /reset-admin/, 'and names a way that proves physical control');
  });

  it('refuses a remote connection FIRST, before any answer about the machine', () => {
    // Order is the assertion. Every other refusal describes the install — which
    // ingress mode it is in, whether a gate is live — and answering those to a
    // caller who should not be talking to this route at all discloses the shape
    // of the machine to exactly the party the check exists to turn away.
    const r = cred.canChangeCredential(
      { ...configured, ingressMode: 'direct' }, { state: 'ungated', user: null }, false, false);
    assert.equal(r.code, 'remote-connection',
      'the connection is refused before not-caddy-mode, no-gate, or no-caddy-binary');
  });

  it('treats every spelling of loopback as local', () => {
    // Node reports IPv4 loopback as 127.0.0.1, IPv6 as ::1, and an IPv4 client on
    // a dual-stack socket as ::ffff:127.0.0.1. A check that knew only the first
    // would refuse a legitimate local caller.
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53', '::FFFF:127.0.0.1']) {
      assert.equal(cred.isLoopbackRemote(addr), true, `${addr} is the same machine`);
    }
    for (const addr of ['192.168.1.10', '10.0.0.4', '100.64.0.1', '::ffff:192.168.1.10', '', undefined, null]) {
      assert.equal(cred.isLoopbackRemote(addr), false, `${addr} is not loopback`);
    }
  });

  it('refuses when the caddy binary is gone, because nothing can hash the new password', () => {
    // `caddy hash-password` is the only hasher this codebase has. Asked here so
    // the form is never drawn for an install that would fail at submit with a 500
    // from a shell-out — the sibling ingress-state endpoint checks the same thing.
    const r = cred.canChangeCredential(configured, gated, false);
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'no-caddy-binary');
    assert.match(r.remedy, /install caddy/i);
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

  it('says "more than one login" rather than "no login" when the file has several', () => {
    // A multi-user file reaches this branch the same way an ungated one does —
    // classifyIngressState reports no single user for both. Telling someone
    // looking at three credentials that there are none reads as a bug in
    // TangleClaw, and sends them to the wrong command.
    const r = cred.canChangeCredential(configured,
      { state: 'ambiguous', user: null, users: ['jason', 'ops', 'backup'] });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'no-gate');
    assert.match(r.reason, /more than one login/);
    assert.match(r.remedy, /--user <name>/, 'the disambiguating flag is the actual way out');
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
    assert.ok(fs.existsSync(`${caddyfilePath}.FIRST.credential.bak`));
    assert.ok(fs.existsSync(`${caddyfilePath}.SECOND.credential.bak`));
  });

  it('prunes old backups as it writes, so credential copies do not accumulate', () => {
    // The retention has to be ON the write path, not merely available: a helper
    // nobody calls leaves the pile growing exactly as before.
    for (let i = 0; i < cred.BACKUP_RETENTION + 2; i++) {
      cred.applyCredentialChange({
        caddyfilePath,
        user: 'jason',
        hash: i % 2 ? HASH_NEW : HASH_OLD,
        uid: 501,
        // Stamp-shaped and ascending, which is what the pruner orders by.
        stamp: `2026-01-0${i + 1}T00-00-00-000Z`,
        execFn: () => {},
        validateFn: () => ({ ok: true })
      });
    }
    const backups = fs.readdirSync(path.dirname(caddyfilePath))
      .filter((n) => n.startsWith('Caddyfile.') && n.endsWith('.credential.bak'));
    assert.equal(backups.length, cred.BACKUP_RETENTION,
      `every change leaves a hash-bearing backup; only ${cred.BACKUP_RETENTION} may survive`);
  });

  it('writes the backup 0600, because it carries the hash that was in force', () => {
    // copyFileSync carries the SOURCE's mode across, and the live file on this
    // machine is hand-edited — so an inherited 0644 would leave a credential
    // readable by every account on the box.
    fs.chmodSync(caddyfilePath, 0o644);
    cred.applyCredentialChange({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'MODE',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    const mode = fs.statSync(`${caddyfilePath}.MODE.credential.bak`).mode & 0o777;
    assert.equal(mode, 0o600, `the backup must not be world- or group-readable (got ${mode.toString(8)})`);
  });

  it('restores the gate when the WRITE itself fails, not only when validation does', () => {
    // A mid-write ENOSPC truncates the live Caddyfile and throws before the
    // validator ever runs — so the fail-closed restore that makes this function
    // safe would be skipped entirely. This is the one path that could leave a
    // broken ingress behind, which is the failure the whole sequence exists to
    // prevent.
    const realWrite = fs.writeFileSync;
    const original = fs.readFileSync(caddyfilePath, 'utf8');
    let validated = false;
    fs.writeFileSync = (p, ...rest) => {
      if (p === caddyfilePath) {
        realWrite(p, 'localhost:8443 {\n  basic_'); // truncated, as a real short write would be
        throw new Error('ENOSPC: no space left on device');
      }
      return realWrite(p, ...rest);
    };
    let r;
    try {
      r = cred.writeValidatedCaddyfile(caddyfilePath, 'irrelevant', () => { validated = true; return { ok: true }; }, 'STAMP');
    } finally {
      fs.writeFileSync = realWrite;
    }

    assert.equal(r.ok, false);
    assert.match(r.error, /ENOSPC/);
    assert.equal(validated, false, 'the validator never ran, so it cannot be what restores');
    assert.equal(fs.readFileSync(caddyfilePath, 'utf8'), original,
      'the live gate must be exactly what it was — a truncated Caddyfile is a broken ingress');
  });

  it('reports a broken gate distinctly from a rejected one', () => {
    // Both are "the credential did not change", so an earlier version returned
    // one code for both. They are not the same fact: after a rejected write the
    // live file is exactly what it was, and after an unrestorable one it is
    // whatever a failed write left behind — possibly a Caddyfile that will not
    // load. Telling the operator "nothing was changed" is true about the password
    // and misleading about the ingress, on the one path where they are about to
    // lose the dashboard entirely.
    const realWrite = fs.writeFileSync;
    const realCopy = fs.copyFileSync;
    fs.writeFileSync = (p, ...rest) => {
      if (p === caddyfilePath) throw new Error('ENOSPC: no space left on device');
      return realWrite(p, ...rest);
    };
    let r;
    try {
      // The backup copy succeeds; only the RESTORE copy fails, which is what
      // leaves the file unrecoverable.
      let copies = 0;
      fs.copyFileSync = (from, to) => {
        if (++copies > 1) throw new Error('EROFS: read-only file system');
        return realCopy(from, to);
      };
      r = cred.applyCredentialChange({
        caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
        execFn: () => {}, validateFn: () => ({ ok: true })
      });
    } finally {
      fs.writeFileSync = realWrite;
      fs.copyFileSync = realCopy;
    }

    assert.equal(r.ok, false);
    assert.equal(r.code, 'gate-broken', 'not validate-failed — the file was not merely rejected');
    assert.ok(r.backup, 'the operator needs the path to the copy they can restore by hand');
    assert.equal(store.config.load().basicAuthHash, HASH_OLD, 'the credential still did not change');
  });

  it('reports a broken gate when the VALIDATE-failure restore cannot run either', () => {
    // The more reachable of the two restore sites: a `caddy validate` rejection is
    // an ordinary outcome, and at that moment the live file holds the invalid
    // content. An unguarded restore there threw out of the function entirely, so
    // it surfaced as a generic 500 with no backup path and no log line — on
    // exactly the path this distinction exists to make legible.
    const realCopy = fs.copyFileSync;
    let copies = 0;
    let r;
    try {
      fs.copyFileSync = (from, to) => {
        if (++copies > 1) throw new Error('EROFS: read-only file system');
        return realCopy(from, to);
      };
      r = cred.applyCredentialChange({
        caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
        execFn: () => {}, validateFn: () => ({ ok: false, error: 'bad directive' })
      });
    } finally {
      fs.copyFileSync = realCopy;
    }

    assert.equal(r.ok, false);
    assert.equal(r.code, 'gate-broken', 'a restore that could not run is not a plain rejection');
    assert.match(r.error, /bad directive/, 'the original cause survives');
    assert.match(r.error, /EROFS/, 'and so does the reason it could not be undone');
  });

  it('says a WRITE failed differently from a REJECTED file', () => {
    // Same outcome, different place to look: a full disk is not a syntax error,
    // and "rejected by Caddy" sends the operator to audit a Caddyfile that is
    // fine.
    const realWrite = fs.writeFileSync;
    let r;
    try {
      fs.writeFileSync = (p, ...rest) => {
        if (p === caddyfilePath) throw new Error('ENOSPC: no space left on device');
        return realWrite(p, ...rest);
      };
      r = cred.applyCredentialChange({
        caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
        execFn: () => {}, validateFn: () => ({ ok: true })
      });
    } finally {
      fs.writeFileSync = realWrite;
    }

    assert.equal(r.code, 'write-failed');
    assert.notEqual(r.code, 'validate-failed', 'the parser is not what failed');
  });

  it('does not reload when the caller says it will do it later', () => {
    // An HTTP caller answers THROUGH this Caddy, so restarting it before the
    // response is out kills the connection carrying the response: the change
    // succeeds and the browser is told the network failed.
    let reloadAttempted = false;
    const r = cred.applyCredentialChange({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      reload: false,
      execFn: () => { reloadAttempted = true; },
      validateFn: () => ({ ok: true })
    });

    assert.equal(r.ok, true);
    assert.equal(reloadAttempted, false, 'the reload must not happen inside the call');
    assert.equal(r.reloaded, false, 'and must not be reported as having happened');
    assert.equal(r.reloadPending, true, 'the caller is told it still owes the reload');
    assert.equal(store.config.load().basicAuthHash, HASH_NEW,
      'everything up to the reload still happened');
  });

  it('puts the gate back when the credential cannot be recorded', () => {
    // The write can fail — a full disk, a permission change — and by then the LIVE
    // gate already carries the new password. Reporting a plain failure there would
    // send the operator to sign in with a password the door no longer takes, so
    // the file goes back to what the message says it is.
    const realSave = store.config.save;
    store.config.save = () => { throw new Error('ENOSPC: no space left on device'); };
    let r;
    try {
      r = cred.applyCredentialChange({
        caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
        execFn: () => {}, validateFn: () => ({ ok: true })
      });
    } finally {
      store.config.save = realSave;
    }

    assert.equal(r.ok, false);
    assert.equal(r.code, 'config-write-failed');
    assert.match(fs.readFileSync(caddyfilePath, 'utf8'), new RegExp(HASH_OLD.replace(/\$/g, '\\$')),
      'the live gate must carry the OLD hash again');
    assert.equal(store.config.load().basicAuthHash, HASH_OLD, 'and config must agree with it');
  });

  it('says which password is live when it cannot put the gate back either', () => {
    // Both writes failed, so the halves disagree and only a terminal settles it.
    // Reported as its own state because the operator's next password differs from
    // the case above — there it is the old one, here the new.
    const realSave = store.config.save;
    const realCopy = fs.copyFileSync;
    store.config.save = () => { throw new Error('ENOSPC'); };
    let r;
    try {
      r = cred.applyCredentialChange({
        caddyfilePath,
        user: 'jason',
        hash: HASH_NEW,
        uid: 501,
        stamp: 'STAMP',
        execFn: () => {},
        validateFn: () => {
          // Only the RESTORE copy fails; the backup taken before the write must
          // still succeed or the write never happens and the case is unreachable.
          fs.copyFileSync = () => { throw new Error('EROFS: read-only file system'); };
          return { ok: true };
        }
      });
    } finally {
      store.config.save = realSave;
      fs.copyFileSync = realCopy;
    }

    assert.equal(r.ok, false);
    assert.equal(r.code, 'diverged');
    assert.match(r.error, /ENOSPC/);
    assert.match(r.error, /EROFS/, 'both failures must be named — they have different remedies');
    assert.match(fs.readFileSync(caddyfilePath, 'utf8'), new RegExp(HASH_NEW.replace(/\$/g, '\\$')),
      'the NEW hash is what the gate is enforcing, which is what the message claims');
  });
});

describe('backup retention', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cred-bak-'));
  });

  it('keeps the newest backups and deletes the rest', () => {
    // Each backup holds the bcrypt hash that was live when it was taken, so an
    // unbounded pile is a growing set of credential-bearing files nobody prunes.
    const caddyfilePath = path.join(dir, 'Caddyfile');
    fs.writeFileSync(caddyfilePath, gatedCaddyfile());
    // Stamps are ISO timestamps with `:` and `.` swapped for `-`, so they sort in
    // time order. Written out of order deliberately: retention must follow the
    // stamp, not the order the files happened to be created in.
    const stamps = ['2026-01-03T00-00-00-000Z', '2026-01-01T00-00-00-000Z',
      '2026-01-05T00-00-00-000Z', '2026-01-02T00-00-00-000Z', '2026-01-04T00-00-00-000Z'];
    for (const s of stamps) fs.writeFileSync(`${caddyfilePath}.${s}.credential.bak`, 'x');

    const removed = cred.pruneCaddyfileBackups(caddyfilePath, 2);

    assert.equal(removed.length, 3);
    const left = fs.readdirSync(dir).filter((n) => n.endsWith('.bak')).sort();
    assert.deepEqual(left, [
      'Caddyfile.2026-01-04T00-00-00-000Z.credential.bak',
      'Caddyfile.2026-01-05T00-00-00-000Z.credential.bak'
    ], 'the two newest by stamp survive');
  });

  it('leaves other files in the directory alone', () => {
    // The Caddyfile sits beside certs and the ttyd socket on a real install.
    const caddyfilePath = path.join(dir, 'Caddyfile');
    fs.writeFileSync(caddyfilePath, gatedCaddyfile());
    fs.writeFileSync(path.join(dir, 'Caddyfile.other'), 'x');
    fs.writeFileSync(path.join(dir, 'unrelated.credential.bak'), 'x');
    fs.writeFileSync(`${caddyfilePath}.STAMP.credential.bak`, 'x');

    cred.pruneCaddyfileBackups(caddyfilePath, 0);

    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ['Caddyfile', 'Caddyfile.other', 'unrelated.credential.bak']);
  });

  it('leaves the ingress cutover\'s backups alone', () => {
    // Both tools back the same file up into the same directory. The cutover's
    // `--force` safety depends on its backup still being there, so five password
    // changes must not be able to delete it — which is why credential backups
    // carry their own suffix and retention only ever matches that one.
    const caddyfilePath = path.join(dir, 'Caddyfile');
    fs.writeFileSync(caddyfilePath, gatedCaddyfile());
    const cutoverBackup = `${caddyfilePath}.2026-01-01T00-00-00-000Z.bak`;
    fs.writeFileSync(cutoverBackup, 'the cutover needs this');
    for (const s of ['2026-01-02', '2026-01-03', '2026-01-04']) {
      fs.writeFileSync(`${caddyfilePath}.${s}T00-00-00-000Z.credential.bak`, 'x');
    }

    cred.pruneCaddyfileBackups(caddyfilePath, 1);

    assert.ok(fs.existsSync(cutoverBackup), 'another tool\'s backup must survive');
    const left = fs.readdirSync(dir).filter((n) => n.endsWith('.credential.bak'));
    assert.deepEqual(left, ['Caddyfile.2026-01-04T00-00-00-000Z.credential.bak']);
  });

  it('does not throw when the directory cannot be read', () => {
    // A credential change that worked must never be reported as failed because a
    // stale backup could not be listed or unlinked.
    assert.deepEqual(cred.pruneCaddyfileBackups(path.join(dir, 'nope', 'Caddyfile')), []);
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

  it('reset-admin.js runs the SHARED apply sequence, not its own copy of it', () => {
    // The earlier version of this test pinned only that two HELPERS were not
    // re-declared, while the sequence they belong to — patch, validated write,
    // config sync, reload — still existed twice. So the test passed while the drift
    // it was named for was present, and the CHANGELOG claimed a single-sourcing
    // that had not shipped. This pins the sequence itself.
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reset-admin.js'), 'utf8');
    assert.match(src, /adminCredential\.applyCredentialChange\(/,
      'the script must call the shared sequence');
    assert.doesNotMatch(src, /caddy\.replaceBasicAuthCredential\(/,
      'patching the gate belongs to the shared sequence');
    assert.doesNotMatch(src, /writeValidatedCaddyfile\(caddyfilePath/,
      'so does the fail-closed write');
    assert.doesNotMatch(src, /execFileSync\('launchctl'/,
      'and so does the reload');
  });

  it('refuses a rename rather than throwing, and touches nothing', () => {
    // `user` is a SELECTOR. A name absent from the file used to reach
    // replaceBasicAuthCredential and throw, surfacing as a 500 on a deliberate
    // operator action.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rename-'));
    const file = path.join(dir, 'Caddyfile');
    fs.writeFileSync(file, gatedCaddyfile('jason', HASH_OLD));
    try {
      const r = cred.applyCredentialChange({
        caddyfilePath: file, user: 'someone-new', hash: HASH_NEW, uid: 501, stamp: 'S',
        execFn: () => {}, validateFn: () => ({ ok: true })
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'rename-unsupported');
      assert.match(r.error, /jason/, 'it must name the login actually in force');
      assert.equal(r.user, 'jason');
      assert.equal(fs.readFileSync(file, 'utf8'), gatedCaddyfile('jason', HASH_OLD),
        'the file must be byte-identical — nothing was attempted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still exports them, so its own callers and tests are unaffected', () => {
    const resetAdmin = require('../scripts/reset-admin');
    assert.equal(resetAdmin.reloadCaddyArgs, cred.reloadCaddyArgs);
    assert.equal(resetAdmin.writeValidatedCaddyfile, cred.writeValidatedCaddyfile);
  });
});

describe('createGate — an install that completed setup with no login', () => {
  // The #806 state: `setupComplete` reached in caddy mode carrying no credential.
  // Every other route out refuses it, so this is the only way to put a login on
  // such a machine — and it must do that without reshaping anything else.
  const caddy = require('../lib/caddy');
  let tmpBase; let prevBase; let caddyfilePath; let certPath; let keyPath;

  /**
   * An UNGATED Caddyfile in exactly the shape the generator emits.
   *
   * Deliberately on NON-DEFAULT ports. With 8443/8080 a rebuild that silently
   * fell back to `buildCaddyfileContent`'s defaults would produce a
   * byte-identical file, so the test that exists to catch exactly that drift
   * could not fail. The fixture has to carry the values that distinguish
   * "recovered from the file" from "guessed".
   */
  function ungenerated() {
    return caddy.buildCaddyfileContent({
      serverPort: 3102, certPath, keyPath, httpsPort: 9443, httpPort: 9080
    });
  }

  before(() => {
    prevBase = store._getBasePath();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-creategate-'));
    store._setBasePath(tmpBase);
    store.init();
    certPath = path.join(tmpBase, 'cert.pem');
    keyPath = path.join(tmpBase, 'key.pem');
  });

  after(() => {
    store._setBasePath(prevBase);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  beforeEach(() => {
    caddyfilePath = path.join(tmpBase, 'Caddyfile');
    fs.writeFileSync(caddyfilePath, ungenerated(), { mode: 0o600 });
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.authEnabled = false;
    config.basicAuthUser = null;
    config.basicAuthHash = null;
    store.config.save(config);
  });

  it('puts a working gate on the file and records it', () => {
    const calls = [];
    const r = cred.createGate({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: (cmd, argv) => { calls.push({ cmd, argv }); },
      validateFn: () => ({ ok: true })
    });

    assert.equal(r.ok, true, r.error || '');
    assert.equal(r.user, 'jason');
    assert.ok(r.replaced >= 1, 'at least one credential line must have been written');
    const live = fs.readFileSync(caddyfilePath, 'utf8');
    assert.deepEqual(caddy.listBasicAuthUsers(live), ['jason'],
      'the LIVE file is the gate — config alone is not a login');
    const config = store.config.load();
    assert.equal(config.authEnabled, true);
    assert.equal(config.basicAuthUser, 'jason');
    assert.equal(config.basicAuthHash, HASH_NEW);
    assert.deepEqual(calls[0].argv, ['kickstart', '-k', 'gui/501/com.tangleclaw.caddy']);
  });

  it('changes NOTHING but the gate', () => {
    // The promise this tool makes. Rebuilding from `config` instead of from the
    // file would fold in every field that has since drifted — a moved port, a
    // different certificate, a tailnet site the file never carried — and the
    // operator asked for a login, not a reshaped ingress. Compared line-wise so
    // a regression names the setting it moved.
    const before = fs.readFileSync(caddyfilePath, 'utf8');
    cred.createGate({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    const after = fs.readFileSync(caddyfilePath, 'utf8');

    // The stamped header vouches for the body, so it legitimately differs; every
    // other removed or altered line is a setting that moved.
    const body = (s) => s.split('\n').slice(1);
    // One line legitimately changes shape rather than surviving verbatim: gating
    // turns `reverse_proxy <upstream>` into `reverse_proxy <upstream> {` so the
    // authenticated username can be forwarded to TangleClaw. That is part of the
    // gate. Anything else that disappears is a setting this rebuild dropped.
    const survives = (l, out) => out.includes(l) || out.includes(`${l} {`);
    const gone = body(before).filter((l) => !survives(l, body(after)));
    assert.deepEqual(gone, [], `these settings were dropped or altered: ${JSON.stringify(gone)}`);

    // Same transformation seen from the other side: the opened `reverse_proxy`
    // line is not new content, it is a surviving line that grew a brace.
    const opened = new Set(body(before).map((l) => `${l} {`));
    const added = body(after).filter((l) => !body(before).includes(l) && !opened.has(l));
    assert.ok(added.length > 0, 'a gate must actually have been added');
    assert.ok(added.every((l) => /basic_auth|@protected|X-Auth-User|^\s*[}{]\s*$|jason/.test(l)),
      `only gate lines may be added, got: ${JSON.stringify(added)}`);
  });

  it('stays fail-closed: a rejected file leaves no gate and no recorded credential', () => {
    const r = cred.createGate({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => { throw new Error('reload must not be reached'); },
      validateFn: () => ({ ok: false, error: 'bad directive' })
    });

    assert.equal(r.ok, false);
    assert.equal(r.code, 'validate-failed');
    assert.deepEqual(caddy.listBasicAuthUsers(fs.readFileSync(caddyfilePath, 'utf8')), [],
      'the original ungated file must be restored');
    const config = store.config.load();
    assert.equal(config.basicAuthHash, null, 'config must not claim a credential the gate lacks');
    assert.notEqual(config.authEnabled, true);
  });

  it('refuses a file that already has a login, naming who holds it', () => {
    fs.writeFileSync(caddyfilePath, gatedCaddyfile('alice'));
    const r = cred.createGate({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'gate-exists');
    assert.match(r.error, /alice/);
  });

  it('refuses to reshape a hand-maintained file rather than guessing where a gate goes', () => {
    // The invariant the whole credential surface rests on: a file a human
    // maintains is never rewritten by this code. Guessing wrong either drops
    // their configuration or leaves an opening that looks closed.
    const handEdited = ungenerated().split('\n').slice(1).join('\n') + '\n# operator note\n';
    fs.writeFileSync(caddyfilePath, handEdited);
    const r = cred.createGate({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-generated');
    assert.equal(fs.readFileSync(caddyfilePath, 'utf8'), handEdited, 'the file must be byte-identical');
  });

  it('requires a username, because there is no existing line to read one from', () => {
    const r = cred.createGate({
      caddyfilePath, hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-credential');
  });

  it('refuses a missing file instead of provisioning one from nothing', () => {
    fs.rmSync(caddyfilePath);
    const r = cred.createGate({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unreadable');
  });

  it('treats a body edit as hand-maintained, because editing breaks the stamp first', () => {
    // Worth pinning as its own fact: removing a setting from a generated file
    // cannot produce a "generated but unreadable" file, because the sha256 header
    // stops matching the moment the body changes. The unrecognized-shape guard is
    // therefore forward-looking — it answers a FUTURE generator emitting a shape
    // this extractor cannot read back — and today every edited file lands on the
    // hand-maintained refusal instead. Both refuse without writing, which is the
    // property that matters.
    const noTls = ungenerated().split('\n').filter((l) => !/^\s*tls\s/.test(l)).join('\n');
    fs.writeFileSync(caddyfilePath, noTls);
    const r = cred.createGate({
      caddyfilePath, user: 'jason', hash: HASH_NEW, uid: 501, stamp: 'STAMP',
      execFn: () => {}, validateFn: () => ({ ok: true })
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-generated');
    assert.equal(fs.readFileSync(caddyfilePath, 'utf8'), noTls, 'nothing may be written');
  });
});
