'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const store = require('../lib/store');
const password = require('../lib/password');

describe('store.users — the tier-1 principal (ADR 0015, #1417)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-users-test-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const u of store.users.list()) {
      // No public delete — this API deliberately has none, because revoking a
      // person is `disable`, not a row removal. Tests need a clean table, so
      // they reach past the API rather than the API growing a verb only tests
      // would call.
      store.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
    }
  });

  describe('create', () => {
    it('creates a user and returns its id and name', () => {
      const u = store.users.create('rosie', 'correct-horse');
      assert.equal(typeof u.id, 'number');
      assert.equal(u.username, 'rosie');
    });

    it('never stores the plaintext password', () => {
      store.users.create('rosie', 'correct-horse');
      const row = store.users.getByName('rosie');
      assert.notEqual(row.password_hash, 'correct-horse');
      assert.ok(!row.password_hash.includes('correct-horse'));
      assert.match(row.password_hash, /^[0-9a-f]+:[0-9a-f]+$/);
    });

    it('rejects a duplicate username with a message naming it', () => {
      store.users.create('rosie', 'pw1');
      assert.throws(() => store.users.create('rosie', 'pw2'), /already exists: rosie/);
    });

    it('rejects a duplicate that differs only by surrounding whitespace', () => {
      store.users.create('rosie', 'pw1');
      assert.throws(() => store.users.create('  rosie  ', 'pw2'), /already exists/);
    });

    it('requires a non-empty username and password', () => {
      assert.throws(() => store.users.create('', 'pw'), /username is required/);
      assert.throws(() => store.users.create('   ', 'pw'), /username is required/);
      assert.throws(() => store.users.create('someone', ''), /password is required/);
      assert.throws(() => store.users.create('someone', null), /password is required/);
    });
  });

  describe('verify', () => {
    beforeEach(() => { store.users.create('rosie', 'correct-horse'); });

    it('returns the user for the right password', () => {
      const u = store.users.verify('rosie', 'correct-horse');
      assert.equal(u.username, 'rosie');
      assert.equal(typeof u.id, 'number');
    });

    it('never returns the password hash', () => {
      const u = store.users.verify('rosie', 'correct-horse');
      assert.equal(u.password_hash, undefined);
    });

    // A caller that can tell "no such user" from "wrong password" is a
    // username oracle. All three failures answer identically on purpose.
    it('answers null identically for wrong password, unknown user, and disabled', () => {
      assert.equal(store.users.verify('rosie', 'wrong'), null);
      assert.equal(store.users.verify('nobody', 'correct-horse'), null);
      store.users.disable('rosie');
      assert.equal(store.users.verify('rosie', 'correct-horse'), null);
    });

    // The return value was never the whole oracle. An early return on the
    // no-row path costs nothing while a wrong password pays a full scrypt, so
    // the two are distinguishable by response time on a login route.
    //
    // COUNTED, not timed. An earlier version of this test compared elapsed
    // medians, which scores the CI runner's scheduler rather than the code and
    // is the shape that has already reddened this repo's main three times. The
    // thing actually meant is countable: a scrypt comparison is PERFORMED on
    // every failure path. Spying the `lib/password.js` seam reds on exactly the
    // same mutation with no dependence on wall clock.
    it('performs a scrypt comparison on unknown, disabled and wrong-password alike', () => {
      store.users.create('disabled-one', 'pw');
      store.users.disable('disabled-one');

      const passwordLib = require('../lib/password');
      const real = passwordLib.verifyPassword;
      /**
       * Count verifyPassword calls made by one store.users.verify call.
       * @param {string} user - Username to attempt
       * @returns {number} How many comparisons were performed
       */
      function comparisonsFor(user) {
        let calls = 0;
        passwordLib.verifyPassword = (...args) => { calls += 1; return real(...args); };
        try {
          store.users.verify(user, 'definitely-wrong');
        } finally {
          passwordLib.verifyPassword = real;
        }
        return calls;
      }

      assert.equal(comparisonsFor('rosie'), 1, 'baseline: a wrong password pays one comparison');
      assert.equal(comparisonsFor('nobody-at-all'), 1,
        'an unknown account must pay the same comparison, or the miss is free and the timing leaks');
      assert.equal(comparisonsFor('disabled-one'), 1,
        'a disabled account must pay it too');
    });

    it('treats usernames as case-sensitive, matching the credential it replaces', () => {
      assert.equal(store.users.verify('Rosie', 'correct-horse'), null);
      assert.ok(store.users.verify('rosie', 'correct-horse'));
    });

    it('does not throw when the stored hash is corrupt', () => {
      store.getDb().prepare('UPDATE users SET password_hash = ? WHERE username = ?')
        .run('deadbeef:short', 'rosie');
      assert.doesNotThrow(() => store.users.verify('rosie', 'correct-horse'));
      assert.equal(store.users.verify('rosie', 'correct-horse'), null);
    });
  });

  describe('the failure log is itself a contract', () => {
    const logger = require('../lib/logger');

    /**
     * Capture the log lines one call produces, at the default info level.
     * @param {() => unknown} fn - The call to run
     * @returns {string[]} Captured lines
     */
    function linesFrom(fn) {
      const lines = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('info');
      logger.setConsoleStream({ write: (line) => lines.push(line) });
      try {
        fn();
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      }
      return lines;
    }

    // Flip warn to debug and a default install records nothing at all, while
    // the JSDoc, the CHANGELOG and FEATURES.md all still promise the operator
    // can see repeated failures. The level is the claim.
    it('records a failed check at a level a default install actually keeps', () => {
      store.users.create('rosie', 'correct-horse');
      const lines = linesFrom(() => store.users.verify('rosie', 'wrong'));
      assert.ok(lines.some((l) => /User verify failed/.test(l)),
        'a failed credential check must reach a default-level log');
      assert.ok(lines.some((l) => /WARN/i.test(l) && /User verify failed/.test(l)),
        'and at warn — at debug the remote operator reading the log file sees nothing');
    });

    // The sharper mutation: swap `null` for the caller's string and the
    // credential log becomes a password sink, because the unknown-account
    // branch is exactly where someone typed their password into the name field.
    it('never writes the attempted name for an unknown account', () => {
      const typedByMistake = 'hunter2-this-is-actually-my-password';
      const lines = linesFrom(() => store.users.verify(typedByMistake, 'x'));
      assert.ok(lines.some((l) => /no such user/.test(l)), 'the reason is still recorded');
      for (const line of lines) {
        assert.ok(!line.includes(typedByMistake),
          'an unrecognised name is attacker- or typo-supplied and must not be logged');
      }
    });
  });

  describe('setPassword', () => {
    beforeEach(() => { store.users.create('rosie', 'old-pw'); });

    it('replaces the password so the old one stops working', () => {
      assert.equal(store.users.setPassword('rosie', 'new-pw'), true);
      assert.equal(store.users.verify('rosie', 'old-pw'), null);
      assert.ok(store.users.verify('rosie', 'new-pw'));
    });

    it('rehashes rather than reusing the old salt', () => {
      const before = store.users.getByName('rosie').password_hash;
      store.users.setPassword('rosie', 'old-pw'); // same password, deliberately
      const after = store.users.getByName('rosie').password_hash;
      assert.notEqual(before, after, 'the salt must be fresh even for an unchanged password');
      assert.ok(password.verifyPassword('old-pw', after));
    });

    it('returns false for an unknown user and requires a password', () => {
      assert.equal(store.users.setPassword('nobody', 'pw'), false);
      assert.throws(() => store.users.setPassword('rosie', ''), /password is required/);
    });
  });

  describe('disable and enable', () => {
    beforeEach(() => { store.users.create('rosie', 'pw'); });

    it('disable stamps a time and blocks login; enable restores it', () => {
      assert.equal(store.users.disable('rosie'), true);
      assert.ok(store.users.getByName('rosie').disabled_at);
      assert.equal(store.users.verify('rosie', 'pw'), null);

      assert.equal(store.users.enable('rosie'), true);
      assert.equal(store.users.getByName('rosie').disabled_at, null);
      assert.ok(store.users.verify('rosie', 'pw'));
    });

    it('keeps the account rather than deleting it', () => {
      store.users.disable('rosie');
      assert.ok(store.users.getByName('rosie'), 'a revoked account stays explicable');
      assert.throws(() => store.users.create('rosie', 'pw'), /already exists/,
        'and the name stays taken, so it cannot be silently re-registered');
    });

    it('is idempotent — a second call reports no change', () => {
      assert.equal(store.users.disable('rosie'), true);
      assert.equal(store.users.disable('rosie'), false);
      assert.equal(store.users.enable('rosie'), true);
      assert.equal(store.users.enable('rosie'), false);
    });

    it('returns false for an unknown user', () => {
      assert.equal(store.users.disable('nobody'), false);
      assert.equal(store.users.enable('nobody'), false);
    });
  });

  describe('list', () => {
    it('never exposes password hashes', () => {
      store.users.create('rosie', 'pw');
      store.users.create('jason', 'pw');
      const rows = store.users.list();
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.equal(r.password_hash, undefined,
          'a listing is the surface most likely to reach a log or an API response');
      }
    });

    it('includes disabled accounts', () => {
      store.users.create('rosie', 'pw');
      store.users.disable('rosie');
      const rows = store.users.list();
      assert.equal(rows.length, 1);
      assert.ok(rows[0].disabled_at);
    });
  });
});

describe('the credential database is owner-only (#1417)', () => {
  it('init narrows tangleclaw.db to 0600 even under a permissive umask', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dbmode-'));
    const prevBase = store._getBasePath();
    const prevUmask = process.umask(0o000);
    try {
      store.close();
      store._setBasePath(tmpDir);
      store.init();

      const mode = fs.statSync(path.join(tmpDir, 'tangleclaw.db')).mode & 0o777;
      assert.equal(mode, 0o600,
        'the file holds password hashes — group/world read means an offline attack');
    } finally {
      process.umask(prevUmask);
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('re-narrows a database that already exists too open', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dbmode-existing-'));
    const prevBase = store._getBasePath();
    try {
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      store.close();

      // An install that predates the chmod. Widen it, then boot again.
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      fs.chmodSync(dbPath, 0o644);
      assert.equal(fs.statSync(dbPath).mode & 0o777, 0o644, 'fixture precondition');

      store.init();
      assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600,
        'narrowing must run on every init, not only on create');
    } finally {
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('#1417 — schema v35→v36 on a REAL old DB', () => {
  /**
   * Seed a database at schema v35 with one table this migration does not touch,
   * so "existing data survives" is a claim about a real row.
   *
   * The witness table is deliberately NOT one of TangleClaw's: `_createTables`
   * runs before migrations and would rebuild indexes against a real table's
   * current shape, so a hand-written copy of one would fail for reasons that
   * have nothing to do with what this test is asking.
   * @param {string} dir - Directory to create tangleclaw.db in
   * @param {string} usersDdl - DDL for a pre-existing users table, or '' for none
   * @returns {void}
   */
  function seedV35(dir, usersDdl) {
    const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    seed.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (35);
      CREATE TABLE fixture_untouched (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL
      );
      INSERT INTO fixture_untouched (content) VALUES ('a pre-migration row');
      ${usersDdl}
    `);
    seed.close();
  }

  it('advances to HEAD and leaves pre-existing rows untouched', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v36-mig-'));
    const prevBase = store._getBasePath();
    try {
      seedV35(tmpDir, '');

      // Fixture precondition. Without this the assertion below could pass on a
      // database that was never at v35 in the first place.
      const pre = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      assert.equal(pre.prepare('SELECT MAX(version) v FROM schema_version').get().v, 35);
      assert.throws(() => pre.prepare('SELECT 1 FROM users').get(), /no such table/,
        'fixture precondition: v35 really has no users table');
      pre.close();

      store.close();
      store._setBasePath(tmpDir);
      store.init();

      assert.equal(store.getDb().prepare('SELECT MAX(version) v FROM schema_version').get().v,
        store.CURRENT_SCHEMA_VERSION);
      assert.equal(
        store.getDb().prepare('SELECT content FROM fixture_untouched').get().content,
        'a pre-migration row');
      assert.deepEqual(store.users.list(), [], 'the new table arrives empty');
    } finally {
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // The postcondition is the whole point of the v35→v36 block: `_createTables`
  // runs BEFORE migrations and its `CREATE TABLE IF NOT EXISTS users` is what
  // actually materialises the table on every normal path, so the migration's
  // own CREATE is always a no-op. What it still buys is a refusal to advance
  // schema_version over a users table whose shape is wrong — which is reachable
  // exactly when the table already exists and is missing the UNIQUE, since both
  // CREATEs then no-op and the shape check is the only thing left looking.
  it('refuses to advance the version over a users table with no UNIQUE username', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v36-bad-'));
    const prevBase = store._getBasePath();
    try {
      seedV35(tmpDir, `
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          disabled_at   TEXT
        );
        INSERT INTO users (username, password_hash) VALUES ('dup', 'x'), ('dup', 'y');
      `);

      const pre = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      assert.equal(pre.prepare("SELECT COUNT(*) c FROM users WHERE username='dup'").get().c, 2,
        'fixture precondition: this table really does accept duplicate usernames');
      pre.close();

      store.close();
      store._setBasePath(tmpDir);
      assert.throws(() => store.init(), /UNIQUE username/,
        'a login table that accepts duplicates must fail the upgrade, not be adopted');

      // And the version must not have moved — a refused migration that still
      // stamped HEAD would be worse than no check at all.
      const after = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      assert.equal(after.prepare('SELECT MAX(version) v FROM schema_version').get().v, 35);
      after.close();
    } finally {
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
