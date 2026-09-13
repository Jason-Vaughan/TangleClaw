'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const store = require('../lib/store');
const rc = require('../lib/recovery-codes');
const passwordHashing = require('../lib/password');

const PASSWORD = 'correct-horse-battery';

describe('store.recoveryCodes — one password reset per code (#1420)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-test-'));
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
    const db = store.getDb();
    db.prepare('DELETE FROM recovery_codes').run();
    db.prepare('DELETE FROM auth_sessions').run();
    db.prepare('DELETE FROM users').run();
  });

  const mkUser = (name = 'rosie') => store.users.create(name, PASSWORD);
  const newHash = () => passwordHashing.hashPassword('a-brand-new-password');

  describe('the schema', () => {
    it('makes code_hash UNIQUE — a lookup must never match two rows', () => {
      const ddl = store.getDb().prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='recovery_codes'"
      ).get().sql;
      assert.ok(/code_hash[^,]*UNIQUE/i.test(ddl) || /UNIQUE\s*\(\s*code_hash\s*\)/i.test(ddl));
    });
  });

  describe('replaceForUser', () => {
    it('returns a full set and stores only digests', () => {
      const user = mkUser();
      const codes = store.recoveryCodes.replaceForUser(user.id);
      assert.equal(codes.length, rc.CODES_PER_SET);
      const rows = store.getDb().prepare('SELECT * FROM recovery_codes').all();
      assert.equal(rows.length, codes.length);
      const dump = JSON.stringify(rows);
      for (const code of codes) {
        assert.ok(!dump.includes(code), 'the raw code never reaches the table');
        assert.ok(rows.some((r) => r.code_hash === rc.hashCode(code)));
      }
    });

    it('invalidates the previous set, used codes included', () => {
      const user = mkUser();
      const first = store.recoveryCodes.replaceForUser(user.id);
      assert.ok(store.recoveryCodes.redeem(first[0], newHash(), 'test'));
      const second = store.recoveryCodes.replaceForUser(user.id);
      for (const code of first) assert.equal(store.recoveryCodes.peek(code), null, 'old code is dead');
      assert.ok(store.recoveryCodes.peek(second[0]));
      assert.equal(store.getDb().prepare('SELECT COUNT(*) n FROM recovery_codes').get().n, rc.CODES_PER_SET);
      assert.equal(store.recoveryCodes.pendingNotice(user.id), null, 'regenerating clears the notice');
    });

    it('leaves another account\'s codes alone', () => {
      const a = mkUser('a');
      const b = mkUser('b');
      const bCodes = store.recoveryCodes.replaceForUser(b.id);
      store.recoveryCodes.replaceForUser(a.id);
      assert.equal(store.recoveryCodes.peek(bCodes[0]).username, 'b');
    });

    it('refuses an unknown or disabled account, and writes nothing', () => {
      const user = mkUser();
      store.users.disable('rosie');
      assert.throws(() => store.recoveryCodes.replaceForUser(user.id), (e) => e.code === 'NO_SUCH_ACCOUNT');
      assert.throws(() => store.recoveryCodes.replaceForUser(9999), (e) => e.code === 'NO_SUCH_ACCOUNT');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) n FROM recovery_codes').get().n, 0);
      // The write lock was released by the refusal.
      store.users.create('next', PASSWORD);
    });
  });

  describe('peek', () => {
    it('names the account for an unused code, in any typed form, without using it', () => {
      const user = mkUser();
      const [code] = store.recoveryCodes.replaceForUser(user.id);
      assert.deepEqual(store.recoveryCodes.peek(rc.formatCode(code).toLowerCase()),
        { userId: user.id, username: 'rosie' });
      assert.equal(store.recoveryCodes.status(user.id).remaining, rc.CODES_PER_SET);
    });

    it('answers null for a wrong, malformed, used, or disabled-account code — all alike', () => {
      const user = mkUser();
      const codes = store.recoveryCodes.replaceForUser(user.id);
      assert.equal(store.recoveryCodes.peek(rc.generateCode()), null, 'wrong');
      assert.equal(store.recoveryCodes.peek('nope'), null, 'malformed');
      store.recoveryCodes.redeem(codes[0], newHash(), 'test');
      assert.equal(store.recoveryCodes.peek(codes[0]), null, 'used');
      store.users.disable('rosie');
      assert.equal(store.recoveryCodes.peek(codes[1]), null, 'disabled account');
    });
  });

  describe('redeem', () => {
    it('replaces the password, marks the code used, and reports what is left', async () => {
      const user = mkUser();
      const [code] = store.recoveryCodes.replaceForUser(user.id, 1000);
      const result = store.recoveryCodes.redeem(code, newHash(), '100.64.0.9 (via proxy)', 5000);
      assert.deepEqual(result, { id: user.id, username: 'rosie', remaining: rc.CODES_PER_SET - 1 });
      assert.equal(store.users.verify('rosie', PASSWORD), null, 'the old password is gone');
      assert.ok(await store.users.verifyAsync('rosie', 'a-brand-new-password'));
      const row = store.getDb().prepare('SELECT used_at, used_from FROM recovery_codes WHERE code_hash = ?')
        .get(rc.hashCode(code));
      assert.equal(row.used_at, 5000);
      assert.equal(row.used_from, '100.64.0.9 (via proxy)');
    });

    it('is single-use: the second redemption of a code answers null and changes nothing', () => {
      const user = mkUser();
      const [code] = store.recoveryCodes.replaceForUser(user.id);
      assert.ok(store.recoveryCodes.redeem(code, newHash(), 'first'));
      const hashAfterFirst = store.users.getByName('rosie').password_hash;
      assert.equal(store.recoveryCodes.redeem(code, passwordHashing.hashPassword('attacker-password-x'), 'second'), null);
      assert.equal(store.users.getByName('rosie').password_hash, hashAfterFirst);
    });

    it('ends every session the account holds', () => {
      const user = mkUser();
      store.authSessions.create(user);
      store.authSessions.create(user);
      const other = mkUser('other');
      store.authSessions.create(other);
      const [code] = store.recoveryCodes.replaceForUser(user.id);
      store.recoveryCodes.redeem(code, newHash(), 'test');
      const left = store.getDb().prepare('SELECT username FROM auth_sessions').all().map((r) => r.username);
      assert.deepEqual(left, ['other']);
    });

    it('never re-enables or resets a disabled account — revocation holds', () => {
      const user = mkUser();
      const [code] = store.recoveryCodes.replaceForUser(user.id);
      store.users.disable('rosie');
      const before = store.users.getByName('rosie');
      assert.equal(store.recoveryCodes.redeem(code, newHash(), 'test'), null);
      const afterRow = store.users.getByName('rosie');
      assert.equal(afterRow.password_hash, before.password_hash);
      assert.ok(afterRow.disabled_at, 'still disabled');
    });

    it('answers null for a malformed code without opening a transaction', () => {
      mkUser();
      assert.equal(store.recoveryCodes.redeem('', newHash(), 'x'), null);
      store.users.create('lock-free', PASSWORD);
    });

    it('releases the write lock after a refusal', () => {
      mkUser();
      assert.equal(store.recoveryCodes.redeem(rc.generateCode(), newHash(), 'x'), null);
      store.users.create('lock-free', PASSWORD);
    });
  });

  describe('revocation with the account', () => {
    const countFor = (userId) => store.getDb()
      .prepare('SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ?').get(userId).n;

    it('disable deletes the account\'s codes, so re-enabling it does not revive them', () => {
      // Without this, a code the revoked person kept redeems again the day the
      // operator re-enables the account at the terminal.
      const user = mkUser();
      const other = mkUser('other');
      const codes = store.recoveryCodes.replaceForUser(user.id);
      store.recoveryCodes.replaceForUser(other.id);
      store.recoveryCodes.redeem(codes[0], newHash(), 'test');
      assert.equal(store.users.disable('rosie'), true);
      assert.equal(countFor(user.id), 0, 'used rows go too');
      assert.equal(countFor(other.id), rc.CODES_PER_SET, 'another account\'s set is untouched');
      store.users.enable('rosie');
      assert.equal(store.recoveryCodes.peek(codes[1]), null, 'a revoked code stays dead after enable');
    });

    it('enable deletes codes left on a row disabled by any other means', () => {
      const user = mkUser();
      const codes = store.recoveryCodes.replaceForUser(user.id);
      store.getDb().prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").run(user.id);
      assert.equal(countFor(user.id), rc.CODES_PER_SET, 'precondition: a hand-disabled row kept its set');
      assert.equal(store.users.enable('rosie'), true);
      assert.equal(countFor(user.id), 0);
      assert.equal(store.recoveryCodes.peek(codes[0]), null);
    });

    it('a no-op disable or enable deletes nothing', () => {
      const user = mkUser();
      store.recoveryCodes.replaceForUser(user.id);
      assert.equal(store.users.enable('rosie'), false, 'already enabled');
      assert.equal(countFor(user.id), rc.CODES_PER_SET);
      assert.equal(store.users.disable('nobody'), false);
      assert.equal(countFor(user.id), rc.CODES_PER_SET);
    });

    it('deleteForUsername counts what it removed and answers 0 for an unknown account', () => {
      const user = mkUser();
      store.recoveryCodes.replaceForUser(user.id);
      assert.equal(store.recoveryCodes.deleteForUsername('nobody'), 0);
      assert.equal(store.recoveryCodes.deleteForUsername(''), 0);
      assert.equal(store.recoveryCodes.deleteForUsername('rosie'), rc.CODES_PER_SET);
      assert.equal(countFor(user.id), 0);
    });
  });

  describe('status, pendingNotice, clearNotice', () => {
    it('reports no codes for an account that never generated any', () => {
      const user = mkUser();
      assert.deepEqual(store.recoveryCodes.status(user.id), { remaining: 0, total: 0, generatedAt: null });
      assert.equal(store.recoveryCodes.pendingNotice(user.id), null);
    });

    it('raises a notice per redemption, newest first, until the account acknowledges it', () => {
      const user = mkUser();
      const codes = store.recoveryCodes.replaceForUser(user.id, 10);
      store.recoveryCodes.redeem(codes[0], newHash(), 'phone', 100);
      store.recoveryCodes.redeem(codes[1], newHash(), 'laptop', 200);
      assert.deepEqual(store.recoveryCodes.pendingNotice(user.id), {
        redemptions: [{ usedAt: 200, from: 'laptop' }, { usedAt: 100, from: 'phone' }],
        remaining: rc.CODES_PER_SET - 2
      });
      assert.deepEqual(store.recoveryCodes.status(user.id),
        { remaining: rc.CODES_PER_SET - 2, total: rc.CODES_PER_SET, generatedAt: 10 });
      assert.equal(store.recoveryCodes.clearNotice(user.id), 2);
      assert.equal(store.recoveryCodes.pendingNotice(user.id), null);
      store.recoveryCodes.redeem(codes[2], newHash(), 'again', 300);
      assert.equal(store.recoveryCodes.pendingNotice(user.id).redemptions.length, 1, 'a later use raises it again');
    });

    it('keeps notices per account', () => {
      const a = mkUser('a');
      const b = mkUser('b');
      const [code] = store.recoveryCodes.replaceForUser(a.id);
      store.recoveryCodes.replaceForUser(b.id);
      store.recoveryCodes.redeem(code, newHash(), 'x');
      assert.ok(store.recoveryCodes.pendingNotice(a.id));
      assert.equal(store.recoveryCodes.pendingNotice(b.id), null);
    });
  });
});

describe('#1420 — schema v37→v38 on a REAL old DB', () => {
  /**
   * Seed a v37 database with an untouched witness row and, optionally, a
   * pre-existing recovery_codes table.
   * @param {string} dir
   * @param {string} extraDdl
   */
  function seedV37(dir, extraDdl) {
    const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    seed.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (37);
      CREATE TABLE fixture_untouched (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL);
      INSERT INTO fixture_untouched (content) VALUES ('a pre-migration row');
      ${extraDdl}
    `);
    seed.close();
  }

  it('advances to HEAD with an empty recovery_codes table', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v38-mig-'));
    const prevBase = store._getBasePath();
    try {
      seedV37(tmpDir, '');
      const pre = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      assert.throws(() => pre.prepare('SELECT 1 FROM recovery_codes').get(), /no such table/,
        'fixture precondition: v37 has no recovery_codes table');
      pre.close();

      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.equal(store.getDb().prepare('SELECT MAX(version) v FROM schema_version').get().v,
        store.CURRENT_SCHEMA_VERSION);
      assert.equal(store.CURRENT_SCHEMA_VERSION, 38);
      assert.equal(store.getDb().prepare('SELECT content FROM fixture_untouched').get().content,
        'a pre-migration row');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) n FROM recovery_codes').get().n, 0);
    } finally {
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses to advance over a recovery_codes table with no UNIQUE code_hash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v38-bad-'));
    const prevBase = store._getBasePath();
    try {
      seedV37(tmpDir, `
        CREATE TABLE recovery_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          code_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          used_at INTEGER,
          used_from TEXT,
          notice_cleared_at INTEGER
        );
      `);
      store.close();
      store._setBasePath(tmpDir);
      assert.throws(() => store.init(), /UNIQUE code_hash/);
      const after = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      assert.equal(after.prepare('SELECT MAX(version) v FROM schema_version').get().v, 37);
      after.close();
    } finally {
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
