'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, resolveTargetUser, reloadCaddyArgs, writeValidatedCaddyfile } = require('../scripts/reset-admin');

describe('reset-admin', () => {
  describe('parseArgs', () => {
    it('defaults: no user, no flags', () => {
      assert.deepEqual(parseArgs([]), { user: null, dryRun: false, passwordStdin: false, help: false });
    });

    it('parses --user <name>', () => {
      assert.equal(parseArgs(['--user', 'jason']).user, 'jason');
    });

    it('parses --dry-run, --password-stdin, --help/-h', () => {
      assert.equal(parseArgs(['--dry-run']).dryRun, true);
      assert.equal(parseArgs(['--password-stdin']).passwordStdin, true);
      assert.equal(parseArgs(['--help']).help, true);
      assert.equal(parseArgs(['-h']).help, true);
    });

    it('treats a trailing --user with no value as null (not a crash)', () => {
      assert.equal(parseArgs(['--user']).user, null);
    });
  });

  describe('resolveTargetUser', () => {
    it('returns the sole user when no selector is given', () => {
      assert.equal(resolveTargetUser(['jason'], null), 'jason');
    });

    it('returns the requested user when present', () => {
      assert.equal(resolveTargetUser(['alice', 'bob'], 'bob'), 'bob');
    });

    it('throws (with the available list) when the requested user is absent', () => {
      assert.throws(() => resolveTargetUser(['alice'], 'bob'), /no credential for user 'bob'.*alice/s);
    });

    it('throws when there is no gate at all', () => {
      assert.throws(() => resolveTargetUser([], null), /nothing to reset/);
    });

    it('throws (asking for --user) when multiple users exist and none requested', () => {
      assert.throws(() => resolveTargetUser(['alice', 'bob'], null), /multiple admin users.*--user/s);
    });
  });

  describe('reloadCaddyArgs', () => {
    it('builds the launchctl kickstart argv for the user domain', () => {
      assert.deepEqual(reloadCaddyArgs(501), ['kickstart', '-k', 'gui/501/com.tangleclaw.caddy']);
    });
  });

  describe('writeValidatedCaddyfile (fail-closed guard)', () => {
    /** @returns {{dir:string, file:string}} */
    function tmpCaddyfile(contents) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reset-'));
      const file = path.join(dir, 'Caddyfile');
      fs.writeFileSync(file, contents);
      return { dir, file };
    }

    it('persists the new content when validation passes', () => {
      const { dir, file } = tmpCaddyfile('OLD\n');
      try {
        const r = writeValidatedCaddyfile(file, 'NEW\n', () => ({ ok: true }), 'STAMP');
        assert.equal(r.ok, true);
        assert.equal(fs.readFileSync(file, 'utf8'), 'NEW\n');
        assert.equal(fs.existsSync(r.backup), true); // backup retained
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('RESTORES the original when validation fails (ingress never left broken)', () => {
      const { dir, file } = tmpCaddyfile('OLD\n');
      try {
        const r = writeValidatedCaddyfile(file, 'BROKEN\n', () => ({ ok: false, error: 'bad directive' }), 'STAMP');
        assert.equal(r.ok, false);
        assert.match(r.error, /bad directive/);
        // the live file is back to its pre-patch content
        assert.equal(fs.readFileSync(file, 'utf8'), 'OLD\n');
        // the backup of the original is kept for the operator
        assert.equal(fs.readFileSync(r.backup, 'utf8'), 'OLD\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('what the operator is told when it fails', () => {
  // The script's main() is a CLI that exits, so its reporting is pinned
  // structurally — the established pattern in this repo for code that cannot be
  // called directly. What matters is not the wording but WHAT IT BRANCHES ON.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reset-admin.js'), 'utf8');
  // Comments stripped before matching. A structural test that greps source is one
  // comment away from asserting the prose instead of the program — a future
  // comment naming GATE_BROKEN above the generic arm would satisfy the ordering
  // pin below with the arm itself deleted. Its sibling in
  // test/settings-credential.test.js had exactly that hole.
  const failure = src
    .slice(src.indexOf('if (!result.ok) {'), src.indexOf('if (!result.reloaded)'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  it('branches on the CODE before it ever branches on "a backup exists"', () => {
    // Every failure carries a backup path, including the two that mean the
    // restore did NOT happen. A `result.backup` arm reached first prints "the
    // original was restored (ingress untouched)" for exactly the cases where it
    // was not — in the break-glass tool, read by someone already locked out.
    // The CONDITION, not any mention: the DIVERGED message interpolates
    // `${result.backup}` itself, so searching for the bare symbol finds the
    // message rather than the arm and measures nothing.
    const firstBackupArm = failure.indexOf('else if (result.backup)');
    assert.ok(firstBackupArm > -1, 'the generic backup arm must still exist');
    for (const code of ['DIVERGED', 'GATE_BROKEN']) {
      const at = failure.indexOf(code);
      assert.ok(at > -1, `${code} must have its own arm`);
      assert.ok(at < firstBackupArm,
        `${code} must be handled BEFORE the generic "a backup exists" arm`);
    }
  });

  it('never claims the ingress is untouched on a code that means it is not', () => {
    const reassurance = 'The original was restored';
    const gateBrokenArm = failure.slice(failure.indexOf('GATE_BROKEN'),
      failure.indexOf('else if (result.backup)'));
    assert.ok(!gateBrokenArm.includes(reassurance),
      'the arm for an unrestorable write must not say the original was restored');
    assert.match(gateBrokenArm, /may now be broken/,
      'it must say what is actually true of the machine');
  });
});
