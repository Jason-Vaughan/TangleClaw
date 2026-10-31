'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { runStoreMode, runDisableMode, parseArgs } = require('../scripts/reset-admin');

// `reset-admin.js --store` — the break-glass tool for TangleClaw's OWN door
// (#1418; moved here from #1417 because a recovery path for a door that was not
// installed yet could not be verified end to end).
//
// Driven through `runStoreMode` with real store writes, not through a source
// probe: the Caddy half of this file is source-probed and that probe has
// already had to be re-anchored once. Behaviour is what this is for.

const PASSWORD = 'correct-horse-battery';

describe('reset-admin --store (#1418)', () => {
  let tempDir;
  let prevBase;
  let out;
  let err;
  let writeOut;
  let writeErr;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reset-store-test-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    writeOut = process.stdout.write.bind(process.stdout);
    writeErr = process.stderr.write.bind(process.stderr);
  });

  after(() => {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    for (const u of store.users.list()) {
      store.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
    }
    setAuthEnabled(false);
    setOptOut(null);
    out = '';
    err = '';
    // Non-string chunks pass straight through to the real writer rather than
    // being coerced into `out`/`err` (#2742): Node's own test-runner output
    // capture relies on calling through the previous process.stdout/stderr
    // writer for anything that isn't the test file's own string output, and
    // swallowing those chunks here is what corrupted the parent junit
    // reporter's event stream into `<undefined name="root">` -- verified by
    // tracing the raw node:test reporter event stream (test:start for the
    // earliest tests never arrived) and confirming 0 occurrences of
    // `<undefined` after this fix, both locally and on the Testament pool.
    process.stdout.write = (s, ...rest) => (typeof s === 'string' ? (out += s, true) : writeOut(s, ...rest));
    process.stderr.write = (s, ...rest) => (typeof s === 'string' ? (err += s, true) : writeErr(s, ...rest));
  });

  /**
   * Write `authEnabled` into the config the tool reads back.
   * @param {boolean} on
   */
  function setAuthEnabled(on) {
    const cfg = store.config.load();
    cfg.authEnabled = on;
    store.config.save(cfg);
  }

  /**
   * Write `loginOptOutAt`, the record that setup finished without a login.
   * @param {string|null} at
   */
  function setOptOut(at) {
    const cfg = store.config.load();
    cfg.loginOptOutAt = at;
    store.config.save(cfg);
  }

  // Two helpers, because `--password-stdin` is a real branch and the dry-run
  // cases are about what happens WITHOUT it. `run` never reads stdin; a test
  // that needs a password uses `runWithPassword`, which pipes one.
  const run = (opts) => runStoreMode({
    store, dryRun: false, passwordStdin: false, ...opts
  });

  /**
   * Run the store mode with `password` piped in, as `--password-stdin` reads it.
   * @param {string} password
   * @param {object} opts - Passed to runStoreMode
   * @returns {Promise<number>} exit code
   */
  const runWithPassword = (password, opts) =>
    stubStdin(password, () => run({ ...opts, passwordStdin: true }));

  describe('the flag itself', () => {
    it('is off unless asked for', () => {
      assert.equal(parseArgs([]).store, false);
      assert.equal(parseArgs(['--store']).store, true);
    });
  });

  describe('refusals', () => {
    it('needs a username, and says how to give one', async () => {
      const code = await run({ user: null });
      assert.equal(code, 1);
      assert.match(err, /--store needs a username/);
      assert.match(err, /--user <name>/, 'the refusal must name the fix');
    });

    it('writes nothing when it refuses', async () => {
      await run({ user: null });
      assert.equal(store.users.list().length, 0);
    });
  });

  describe('create', () => {
    it('creates an account that did not exist', async () => {
      const code = await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.equal(code, 0);
      assert.ok(store.users.getByName('rosie'));
      assert.match(out, /created/);
    });

    it('makes the new account able to log in', async () => {
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.ok(store.users.verify('rosie', PASSWORD));
    });

    it('arms the gate — the predicate flips from false to true', async () => {
      // Creating the first account from a terminal is one of the two ways an
      // `account-required` install gets its key (the other is the account page).
      assert.equal(store.authSessions.accountPresence().loginable, false);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.equal(store.authSessions.accountPresence().loginable, true);
    });

    it('ANSWERS whether a login is now enforced, rather than stating the condition', async () => {
      // The gate needs authEnabled AND an account; this command supplies the
      // account. Printing "…when authEnabled is on" left the operator holding a
      // conditional they cannot evaluate — on the tool they are running
      // precisely because they cannot reach the dashboard to look.
      setAuthEnabled(true);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /login gate is now LIVE/);
      assert.doesNotMatch(out, /authEnabled is OFF/);
    });

    it('WARNS when authEnabled is off, because the account then enforces nothing', async () => {
      // The population this mode exists for is the one most likely to be here:
      // a direct-mode install that finished the wizard ungated under #803's
      // ruling carries authEnabled:false, so without this the operator creates
      // an account, reads a success message, and still has no login.
      setAuthEnabled(false);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /authEnabled is OFF/);
      assert.match(out, /NO login is enforced/);
      assert.doesNotMatch(out, /now LIVE/);
    });

    it('names the settings control that turns the login on, which exists', async () => {
      setAuthEnabled(false);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /"Add a login" in global settings/);
    });

    it('keeps that record when the account it makes turns nothing on', async () => {
      setAuthEnabled(false);
      setOptOut('2026-09-10T12:00:00.000Z');
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.equal(store.config.load().loginOptOutAt, '2026-09-10T12:00:00.000Z');
      assert.doesNotMatch(out, /was cleared/);
    });

    it('still reports the account was created when the status read fails', async () => {
      // Never fatal: the account IS created, and refusing to report that
      // because a status read failed is the worse outcome for someone locked
      // out.
      const realLoad = store.config.load;
      store.config.load = () => { throw new Error('config unreadable'); };
      try {
        const code = await runWithPassword(PASSWORD, { user: 'rosie' });
        assert.equal(code, 0);
        assert.match(out, /created/);
        assert.match(out, /could not read config to report gate status/);
      } finally {
        store.config.load = realLoad;
      }
      assert.ok(store.users.getByName('rosie'), 'the account must exist regardless');
    });
  });

  describe('reset', () => {
    it('resets an existing account rather than refusing it', async () => {
      // Create and reset are one command on purpose: the operator running this
      // is recovering access and does not necessarily know whether a row
      // exists. Making them find out first is a puzzle set for someone already
      // locked out.
      store.users.create('rosie', PASSWORD);
      const code = await runWithPassword('a-different-password', { user: 'rosie' });
      assert.equal(code, 0);
      assert.match(out, /reset/);
      assert.ok(store.users.verify('rosie', 'a-different-password'));
      assert.equal(store.users.verify('rosie', PASSWORD), null, 'the old password stops working');
    });

    it('destroys live sessions, so a compromised credential loses its sessions', async () => {
      const u = store.users.create('rosie', PASSWORD);
      const s = store.authSessions.create(u);
      await runWithPassword('a-different-password', { user: 'rosie' });
      assert.equal(store.authSessions.resolve(s.token), null);
    });

    it('re-enables a disabled account, AFTER changing the password', async () => {
      // Ordering matters: re-enabling first would open a window in which the
      // account is live under the OLD password.
      store.users.create('rosie', PASSWORD);
      store.users.disable('rosie');
      await runWithPassword('a-different-password', { user: 'rosie' });
      assert.equal(store.users.getByName('rosie').disabled_at, null);
      assert.ok(store.users.verify('rosie', 'a-different-password'));
      assert.match(out, /re-enabled/);
    });

    it('leaves other accounts alone', async () => {
      store.users.create('rosie', PASSWORD);
      store.users.create('other', PASSWORD);
      await runWithPassword('a-different-password', { user: 'rosie' });
      assert.ok(store.users.verify('other', PASSWORD));
    });

    it('revokes the account\'s recovery codes, so a copied code cannot reset it again', async () => {
      const u = store.users.create('rosie', PASSWORD);
      const other = store.users.create('other', PASSWORD);
      const codes = store.recoveryCodes.replaceForUser(u.id);
      store.recoveryCodes.replaceForUser(other.id);
      await runWithPassword('a-different-password', { user: 'rosie' });
      assert.equal(store.recoveryCodes.peek(codes[0]), null);
      assert.equal(store.recoveryCodes.status(u.id).total, 0);
      assert.ok(store.recoveryCodes.status(other.id).remaining > 0, 'only this account\'s set');
      assert.match(out, /recovery code\(s\) no longer work — generate a new set in Settings/);
    });

    it('says nothing about codes when the account had none', async () => {
      store.users.create('rosie', PASSWORD);
      await runWithPassword('a-different-password', { user: 'rosie' });
      assert.doesNotMatch(out, /recovery code/);
    });
  });

  describe('the gate report reads the state a request meets', () => {
    const caddy = require('../lib/caddy');
    const drift = require('../lib/caddy-drift');
    const gateFallback = require('../lib/gate-fallback');
    const { FIXTURE_CADDYFILES, adaptFromFixtures } = require('./_caddy-drift-fixtures');
    let realAdapt;

    /** @param {object} patch - Config fields to set */
    function setConfig(patch) {
      store.config.save({ ...store.config.load(), ...patch });
    }

    beforeEach(() => {
      // The report reads the door through `caddy adapt`; answered from the
      // committed fixtures so it does not depend on the host having Caddy.
      realAdapt = drift.adaptCaddyfileContent;
      drift.adaptCaddyfileContent = adaptFromFixtures;
      fs.rmSync(caddy.getCaddyfilePath(), { force: true });
      fs.rmSync(gateFallback.markerPath(), { force: true });
      setConfig({ ingressMode: 'direct' });
    });

    afterEach(() => {
      drift.adaptCaddyfileContent = realAdapt;
    });

    after(() => {
      fs.rmSync(caddy.getCaddyfilePath(), { force: true });
      fs.rmSync(gateFallback.markerPath(), { force: true });
      setConfig({ ingressMode: 'direct' });
    });

    it('does not say "NO login" when a caddy-mode door keeps the accounts deciding with authEnabled off', async () => {
      // A Caddyfile written for an armed install serves remote sites with no
      // basic_auth; `authEnabled: false` does not open that install, so telling
      // the operator nothing is enforced would be false.
      setConfig({ ingressMode: 'caddy', authEnabled: false });
      fs.writeFileSync(caddy.getCaddyfilePath(), FIXTURE_CADDYFILES.armed);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /login gate is now LIVE/);
      assert.match(out, /accounts decide anyway/);
      assert.doesNotMatch(out, /NO login is enforced/);
    });

    it('clears the record that setup finished without a login when its account arms a door authEnabled does not show', async () => {
      // A login that asks is incompatible with a record saying the operator chose
      // none (#803). `authEnabled` stays off here, so the config save does not
      // clear it; the account arming the gate is what makes the record false.
      setConfig({ ingressMode: 'caddy', authEnabled: false, loginOptOutAt: '2026-09-10T12:00:00.000Z' });
      fs.writeFileSync(caddy.getCaddyfilePath(), FIXTURE_CADDYFILES.armed);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /login gate is now LIVE/, 'precondition: the account arms the gate');
      assert.equal(store.config.load().loginOptOutAt, null);
      assert.match(out, /setup finished without a login was cleared/);
      setConfig({ loginOptOutAt: null });
    });

    it('drops the old "until the cutover" line, and names Caddy\'s password only when the file carries one', async () => {
      setConfig({ ingressMode: 'caddy', authEnabled: true });
      fs.writeFileSync(caddy.getCaddyfilePath(), 'box.ts.net {\n  reverse_proxy 127.0.0.1:3102\n}\n');
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.doesNotMatch(out, /until the cutover/);
      assert.doesNotMatch(out, /basic_auth\) still stands in front/);

      out = '';
      fs.writeFileSync(caddy.getCaddyfilePath(),
        `box.ts.net {\n  basic_auth {\n    jason $2a$14$${'a'.repeat(53)}\n  }\n  reverse_proxy 127.0.0.1:3102\n}\n`);
      await runWithPassword('a-different-password', { user: 'rosie' });
      assert.match(out, /Caddy's password \(basic_auth\) still stands in front of this login/);
    });

    it('names Caddy\'s password as the login when authEnabled is off but the Caddyfile carries basic_auth', async () => {
      setConfig({ ingressMode: 'caddy', authEnabled: false });
      fs.writeFileSync(caddy.getCaddyfilePath(), FIXTURE_CADDYFILES.generated);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /Caddy's password \(basic_auth\) is the only login in front of this install/);
      assert.doesNotMatch(out, /NO login is enforced/);
    });

    it('says it could not check for Caddy\'s password when the Caddyfile exists but cannot be read', async () => {
      // With authEnabled on the gate state never reads the file, so without this
      // the report printed LIVE and nothing about the door in front of it.
      setConfig({ ingressMode: 'caddy', authEnabled: true });
      fs.mkdirSync(caddy.getCaddyfilePath());
      try {
        await runWithPassword(PASSWORD, { user: 'rosie' });
        assert.match(out, /login gate is now LIVE/);
        assert.match(out, /could not read the Caddyfile to check for Caddy's password/);
      } finally {
        fs.rmSync(caddy.getCaddyfilePath(), { recursive: true, force: true });
      }
    });

    it('says nothing about the Caddyfile when caddy mode has none', async () => {
      setConfig({ ingressMode: 'caddy', authEnabled: true });
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.doesNotMatch(out, /could not read the Caddyfile/);
    });

    it('reports a fallback marker and the command that ends it', async () => {
      setAuthEnabled(true);
      fs.writeFileSync(gateFallback.markerPath(), '{}\n');
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /fallback marker is present/);
      assert.match(out, /gate-fallback\.js --undo/);
    });

    it('previews the state the run would leave, through the same report', async () => {
      setConfig({ ingressMode: 'caddy', authEnabled: false });
      fs.writeFileSync(caddy.getCaddyfilePath(), 'box.ts.net {\n  reverse_proxy 127.0.0.1:3102\n}\n');
      await run({ user: 'rosie', dryRun: true });
      assert.match(out, /login gate would be LIVE/);
      assert.equal(store.users.getByName('rosie'), null, 'still writes nothing');
    });
  });

  describe('password policy', () => {
    // The store enforces only non-empty — the right call for a store layer and
    // the wrong one for a credential surface. Without this, TangleClaw's new
    // door would accept a one-character password where the Caddy door it
    // replaces demanded twelve, and nobody would have decided that (ADR 0016).
    const REFUSED = [
      ['too short', 'short'],
      ['a known-weak password', 'password1234'],
      ['one containing the username', 'rosie-rosie-rosie'],
      ['one with a control character', 'abcdefghijkl\tmn'],
      ['empty', '']
    ];

    for (const [label, bad] of REFUSED) {
      it(`refuses ${label}, and writes nothing`, async () => {
        const code = await runWithPassword(bad, { user: 'rosie' });
        assert.equal(code, 1, `'${bad}' must be refused`);
        assert.equal(store.users.getByName('rosie'), null, 'no account may be created');
      });
    }

    it('leaves an existing password untouched when the new one is refused', async () => {
      store.users.create('rosie', PASSWORD);
      await runWithPassword('short', { user: 'rosie' });
      assert.ok(store.users.verify('rosie', PASSWORD), 'the old password must still work');
    });

    it('applies the SAME validator the Caddy door uses', async () => {
      // Not a second copy of the rules that happens to agree today.
      const caddy = require('../lib/caddy');
      for (const [, bad] of REFUSED) {
        const viaCaddy = caddy.validateAdminPassword(bad, 'rosie').ok;
        assert.equal(viaCaddy, false, `precondition: caddy refuses '${bad}'`);
      }
      assert.equal(caddy.validateAdminPassword(PASSWORD, 'rosie').ok, true);
    });
  });

  describe('--dry-run', () => {
    it('touches nothing and says what it would do', async () => {
      const code = await run({ user: 'rosie', dryRun: true });
      assert.equal(code, 0);
      assert.equal(store.users.getByName('rosie'), null, 'a preview must write nothing');
      assert.match(out, /\[dry-run\]/);
      assert.match(out, /create TangleClaw account/);
    });

    it('names a reset, not a create, when the account exists', async () => {
      store.users.create('rosie', PASSWORD);
      await run({ user: 'rosie', dryRun: true });
      assert.match(out, /reset TangleClaw account/);
      assert.match(out, /destroy every live session/);
      assert.match(out, /delete this account's recovery codes/);
    });

    it('reports a disabled account, and that it would be re-enabled', async () => {
      store.users.create('rosie', PASSWORD);
      store.users.disable('rosie');
      await run({ user: 'rosie', dryRun: true });
      assert.match(out, /currently DISABLED/);
      assert.match(out, /re-enable the account/);
    });

    it('says it touches no Caddyfile', async () => {
      // The distinction that matters to someone choosing between the two
      // modes during a lockout.
      await run({ user: 'rosie', dryRun: true });
      assert.match(out, /no Caddyfile touched/);
    });

    it('REFUSES a piped password the real run would refuse, with the same code', async () => {
      // #929's lesson, applied to the new mode: a preview that prints a full
      // plan and exits 0 for a password the real run rejects is read during a
      // lockout, which is the only time anyone runs this.
      const code = await runWithPassword('short', { user: 'rosie', dryRun: true });
      assert.equal(code, 1);
      assert.equal(store.users.getByName('rosie'), null);
    });

    it('does not invent a password to judge when none is piped', async () => {
      // A dry run must not prompt, so with no --password-stdin there is
      // nothing to validate and the preview says so rather than pretending.
      const code = await run({ user: 'rosie', dryRun: true });
      assert.equal(code, 0);
      assert.match(out, /prompt new password/);
    });

    it('still needs a username', async () => {
      const code = await run({ user: null, dryRun: true });
      assert.equal(code, 1);
    });
  });
});

describe('reset-admin --disable (#1458)', () => {
  // Real store writes, for the same reason reset-admin --store is tested this
  // way rather than through a source probe: whether an account can actually
  // sign in afterward is the thing that matters.
  let tempDir;
  let prevBase;
  let out;
  let err;
  let writeOut;
  let writeErr;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reset-disable-test-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    writeOut = process.stdout.write.bind(process.stdout);
    writeErr = process.stderr.write.bind(process.stderr);
  });

  after(() => {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    for (const u of store.users.list()) {
      store.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
    }
    const cfg = store.config.load();
    cfg.authEnabled = false;
    store.config.save(cfg);
    out = '';
    err = '';
    // Non-string chunks pass straight through to the real writer rather than
    // being coerced into `out`/`err` (#2742): Node's own test-runner output
    // capture relies on calling through the previous process.stdout/stderr
    // writer for anything that isn't the test file's own string output, and
    // swallowing those chunks here is what corrupted the parent junit
    // reporter's event stream into `<undefined name="root">` -- verified by
    // tracing the raw node:test reporter event stream (test:start for the
    // earliest tests never arrived) and confirming 0 occurrences of
    // `<undefined` after this fix, both locally and on the Testament pool.
    process.stdout.write = (s, ...rest) => (typeof s === 'string' ? (out += s, true) : writeOut(s, ...rest));
    process.stderr.write = (s, ...rest) => (typeof s === 'string' ? (err += s, true) : writeErr(s, ...rest));
  });

  const run = (opts) => runDisableMode({ store, dryRun: false, force: false, ...opts });

  it('disables an enabled account that is not the only one', async () => {
    const rosie = store.users.create('rosie', PASSWORD);
    store.users.create('other', PASSWORD);
    const code = await run({ user: 'rosie' });
    assert.equal(code, 0);
    assert.ok(store.users.getByName('rosie').disabled_at, 'rosie must now be disabled');
    assert.equal(store.users.verify('rosie', PASSWORD), null);
    assert.ok(store.users.verify('other', PASSWORD), 'the other account is untouched');
    assert.equal(rosie.id, store.users.getByName('rosie').id);
  });

  it('destroys live sessions and recovery codes for the disabled account', async () => {
    const rosie = store.users.create('rosie', PASSWORD);
    store.users.create('other', PASSWORD);
    const s = store.authSessions.create(rosie);
    const codes = store.recoveryCodes.replaceForUser(rosie.id);
    await run({ user: 'rosie' });
    assert.equal(store.authSessions.resolve(s.token), null);
    assert.equal(store.recoveryCodes.peek(codes[0]), null);
  });

  it('refuses to disable the only enabled account without --force', async () => {
    store.users.create('rosie', PASSWORD);
    const code = await run({ user: 'rosie' });
    assert.equal(code, 1);
    assert.match(err, /only enabled TangleClaw account/);
    assert.match(err, /--force/);
    assert.equal(store.users.getByName('rosie').disabled_at, null, 'nothing must change on refusal');
  });

  it('disables the only enabled account when --force is passed', async () => {
    store.users.create('rosie', PASSWORD);
    const code = await run({ user: 'rosie', force: true });
    assert.equal(code, 0);
    assert.ok(store.users.getByName('rosie').disabled_at);
  });

  it('does not count an already-disabled account as the enabled one it is protecting', async () => {
    store.users.create('rosie', PASSWORD);
    const other = store.users.create('other', PASSWORD);
    store.users.disable('other');
    // Only 'rosie' is enabled; disabling it is the real "last enabled" case
    // even though two accounts exist.
    const code = await run({ user: 'rosie' });
    assert.equal(code, 1);
    assert.equal(store.users.getByName('other').id, other.id);
  });

  it('opens one transaction spanning the enabledCount read and the disable write (R-Gate R1, PR #2666)', async () => {
    // The defect: `runDisableMode` used to read enabledCount and call
    // store.users.disable(user) as two independent, unguarded statements.
    // Two concurrent unforced `--disable` runs against two DIFFERENT enabled
    // accounts could each read enabledCount BEFORE either wrote, both see
    // more than one enabled account, and both proceed -- leaving the gate
    // LOCKED with neither operator passing --force.
    //
    // A real two-process race can't be reproduced deterministically here:
    // node:sqlite's calls and this fix's own transaction body are fully
    // synchronous, with no `await` between the read and the write, so two
    // logical `runDisableMode` invocations in one Node process can never
    // actually interleave -- the second one's entire body runs only after
    // the first's synchronous body (and its own real BEGIN IMMEDIATE/COMMIT)
    // has already returned. An externally-held rival lock doesn't
    // discriminate either: it was tried and found to make EITHER version
    // throw identically (the unfixed write statement is itself blocked by
    // any other connection's open write lock, same as the fix's BEGIN
    // IMMEDIATE would be) -- just at a different point inside the call,
    // which isn't something a black-box assertion on the outcome can see.
    //
    // What IS directly, deterministically verifiable is the mechanism that
    // closes the race: the enabledCount read and the disable write happen
    // inside ONE transaction, so nothing else can commit a change to the
    // users table between them. Spy on the real store's `getDb`/`users.list`/
    // `users.disable` (same temporary-monkey-patch style as the config-load
    // failure test above) to record call order against the REAL sqlite
    // connection -- this runs the real BEGIN IMMEDIATE/COMMIT, it only also
    // logs when.
    store.users.create('rosie', PASSWORD);
    store.users.create('other', PASSWORD);

    const calls = [];
    const realGetDb = store.getDb;
    const realDb = store.getDb();
    const realExec = realDb.exec.bind(realDb);
    const realList = store.users.list.bind(store.users);
    const realDisable = store.users.disable.bind(store.users);

    store.getDb = () => ({
      ...realDb,
      exec: (sql) => { calls.push(sql); return realExec(sql); }
    });
    store.users.list = (...args) => { calls.push('list'); return realList(...args); };
    store.users.disable = (...args) => { calls.push('disable'); return realDisable(...args); };

    let code;
    try {
      code = await run({ user: 'other' });
    } finally {
      store.getDb = realGetDb;
      store.users.list = realList;
      store.users.disable = realDisable;
    }

    assert.equal(code, 0);
    assert.ok(store.users.getByName('other').disabled_at, 'the write still actually happened');

    const beginAt = calls.indexOf('BEGIN IMMEDIATE');
    const listAt = calls.indexOf('list');
    const disableAt = calls.indexOf('disable');
    const commitAt = calls.indexOf('COMMIT');
    assert.ok(beginAt > -1, 'a real run opens an explicit transaction');
    assert.ok(beginAt < listAt, 'the transaction opens BEFORE the enabledCount read');
    assert.ok(listAt < disableAt, 'the read precedes the write, inside that same transaction');
    assert.ok(disableAt < commitAt, 'the transaction stays open through the write, and only then commits');
  });

  it('rolls back rather than committing when the last-enabled refusal fires on a real run', async () => {
    // The transaction must not leave a half-open state on the refusal path:
    // nothing was written, so the ROLLBACK (not a COMMIT) is what ends it.
    store.users.create('rosie', PASSWORD);

    const calls = [];
    const realDb = store.getDb();
    const realExec = realDb.exec.bind(realDb);
    const realGetDb = store.getDb;
    store.getDb = () => ({ ...realDb, exec: (sql) => { calls.push(sql); return realExec(sql); } });

    let code;
    try {
      code = await run({ user: 'rosie' });
    } finally {
      store.getDb = realGetDb;
    }

    assert.equal(code, 1);
    assert.deepEqual(calls, ['BEGIN IMMEDIATE', 'ROLLBACK']);
    assert.equal(store.users.getByName('rosie').disabled_at, null);
  });

  it('is a no-op, exit 0, when the account is already disabled', async () => {
    store.users.create('rosie', PASSWORD);
    store.users.create('other', PASSWORD);
    store.users.disable('rosie');
    out = '';
    const code = await run({ user: 'rosie' });
    assert.equal(code, 0);
    assert.match(out, /already disabled; nothing changed/);
  });

  it('refuses an unknown account, writing nothing', async () => {
    const code = await run({ user: 'ghost' });
    assert.equal(code, 1);
    assert.match(err, /no TangleClaw account 'ghost'/);
  });

  it('needs a username', async () => {
    const code = await run({ user: null });
    assert.equal(code, 1);
    assert.match(err, /--disable needs a username/);
  });

  it('reports the gate transitioning to LOCKED when disabling leaves no account enabled', async () => {
    store.users.create('rosie', PASSWORD);
    const cfg = store.config.load();
    cfg.authEnabled = true;
    store.config.save(cfg);
    const code = await run({ user: 'rosie', force: true });
    assert.equal(code, 0);
    assert.match(out, /LOCKED/);
    assert.match(out, /--store --user <name>/);
  });

  describe('--dry-run', () => {
    it('touches nothing and says what it would do', async () => {
      store.users.create('rosie', PASSWORD);
      store.users.create('other', PASSWORD);
      const code = await run({ user: 'rosie', dryRun: true });
      assert.equal(code, 0);
      assert.equal(store.users.getByName('rosie').disabled_at, null, 'a preview must write nothing');
      assert.match(out, /\[dry-run\]/);
      assert.match(out, /disable TangleClaw account/);
    });

    it('predicts the last-enabled refusal and exits 1, per the #1286 ratified reading', async () => {
      store.users.create('rosie', PASSWORD);
      const code = await run({ user: 'rosie', dryRun: true });
      assert.equal(code, 1);
      assert.match(out, /would REFUSE/);
      assert.match(out, /only enabled TangleClaw account/);
      assert.equal(store.users.getByName('rosie').disabled_at, null);
    });

    it('previews --force overriding the last-enabled refusal, and still writes nothing', async () => {
      store.users.create('rosie', PASSWORD);
      const code = await run({ user: 'rosie', dryRun: true, force: true });
      assert.equal(code, 0);
      assert.doesNotMatch(out, /would REFUSE/);
      assert.equal(store.users.getByName('rosie').disabled_at, null);
    });

    it('reports an already-disabled account as a no-op preview', async () => {
      store.users.create('rosie', PASSWORD);
      store.users.create('other', PASSWORD);
      store.users.disable('rosie');
      const code = await run({ user: 'rosie', dryRun: true });
      assert.equal(code, 0);
      assert.match(out, /already DISABLED/);
    });

    it('still needs a username', async () => {
      const code = await run({ user: null, dryRun: true });
      assert.equal(code, 1);
    });
  });
});

/**
 * Run `fn` with `process.stdin` piped to `password`, as `--password-stdin` reads it.
 *
 * Feeds the real `readPipedPassword` rather than stubbing `acquirePassword`, so
 * the password travels the path a real run puts it through — including
 * `caddy.validateAdminPassword`, which is the line under test in half of these
 * cases. Stubbing the acquirer would have made every policy assertion vacuous.
 *
 * @param {string} password - What the operator pipes in
 * @param {() => Promise<number>} fn - The run to perform
 * @returns {Promise<number>} The run's exit code
 */
async function stubStdin(password, fn) {
  const { Readable } = require('node:stream');
  const real = Object.getOwnPropertyDescriptor(process, 'stdin');
  const fake = Readable.from([password + '\n']);
  fake.isTTY = false;
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', real);
  }
}
