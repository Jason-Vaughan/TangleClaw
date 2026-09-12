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
    // the two are distinguishable by response time on a login route. This
    // pins the equalisation: remove the ABSENT_USER_HASH comparison and the
    // unknown-user case gets dramatically cheaper than the wrong-password one.
    it('spends comparable work on unknown, disabled and wrong-password', () => {
      store.users.create('disabled-one', 'pw');
      store.users.disable('disabled-one');

      /**
       * Median elapsed ms over several calls, so one scheduling hiccup does not
       * decide the assertion.
       * @param {() => unknown} fn - The call to time
       * @returns {number} Median milliseconds
       */
      function medianMs(fn) {
        const runs = [];
        for (let i = 0; i < 7; i += 1) {
          const t0 = process.hrtime.bigint();
          fn();
          runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        return runs.sort((a, b) => a - b)[3];
      }

      const wrongPassword = medianMs(() => store.users.verify('rosie', 'nope'));
      const unknownUser = medianMs(() => store.users.verify('nobody-at-all', 'nope'));
      const disabledUser = medianMs(() => store.users.verify('disabled-one', 'nope'));

      // A loose band on purpose: this asserts "the scrypt cost is paid on every
      // path", not a constant-time guarantee, which a GC pause would flake.
      // Before the fix the unknown-user path was ~0ms against tens of ms.
      assert.ok(unknownUser > wrongPassword / 4,
        `unknown-user ${unknownUser.toFixed(1)}ms must not be trivially faster `
        + `than wrong-password ${wrongPassword.toFixed(1)}ms`);
      assert.ok(disabledUser > wrongPassword / 4,
        `disabled ${disabledUser.toFixed(1)}ms must not be trivially faster `
        + `than wrong-password ${wrongPassword.toFixed(1)}ms`);
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
