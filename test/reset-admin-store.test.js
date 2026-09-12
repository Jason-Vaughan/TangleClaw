'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { runStoreMode, parseArgs } = require('../scripts/reset-admin');

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
    out = '';
    err = '';
    process.stdout.write = (s) => { out += s; return true; };
    process.stderr.write = (s) => { err += s; return true; };
  });

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
      // This command IS how TangleClaw's door gets closed for the first time:
      // the gate is dormant until an enabled account exists.
      assert.equal(store.authSessions.anyLoginableUser(), false);
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.equal(store.authSessions.anyLoginableUser(), true);
    });

    it('says plainly that a login is now enforced', async () => {
      // The surprising half: an operator who ran this to recover a login has,
      // on an install with no account before, also just closed an open door.
      await runWithPassword(PASSWORD, { user: 'rosie' });
      assert.match(out, /enforces its own login/);
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
