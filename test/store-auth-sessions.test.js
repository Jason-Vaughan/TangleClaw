'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');

describe('store.authSessions — the browser session (#1418, ADR 0016)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-authsess-test-'));
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
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    for (const u of store.users.list()) {
      store.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
    }
  });

  const mkUser = (name) => store.users.create(name || 'rosie', 'correct-horse-battery');

  describe('the schema', () => {
    it('is a table named auth_sessions, NOT sessions', () => {
      // `sessions` is already TangleClaw's core domain table — the tmux/AI
      // sessions the whole product is about. Two unrelated concepts under one
      // word in one schema is how a later reader deletes the wrong rows.
      const names = store.getDb().prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','auth_sessions')"
      ).all().map((r) => r.name).sort();
      assert.deepEqual(names, ['auth_sessions', 'sessions']);
    });

    it('makes token_hash UNIQUE', () => {
      // Without it two rows can share a token and a lookup answers with
      // whichever SQLite reaches first. On the session path that is an
      // authentication bug, not a data-tidiness one.
      const ddl = store.getDb().prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_sessions'"
      ).get().sql;
      assert.ok(
        /token_hash[^,]*UNIQUE/i.test(ddl) || /UNIQUE\s*\(\s*token_hash\s*\)/i.test(ddl),
        'token_hash must be UNIQUE'
      );
    });
  });

  describe('create', () => {
    it('returns a raw token, a csrf token and an expiry', () => {
      const s = store.authSessions.create(mkUser());
      assert.match(s.token, /^[0-9a-f]{64}$/);
      assert.match(s.csrfToken, /^[0-9a-f]{64}$/);
      assert.ok(s.expiresAt > Date.now());
    });

    it('gives the session a DIFFERENT csrf token from its session token', () => {
      const s = store.authSessions.create(mkUser());
      assert.notEqual(s.token, s.csrfToken);
    });

    it('never stores the raw token', () => {
      // The property the whole storage design rests on: a database read — a
      // backup, a .dump pasted into an issue — must not hand anyone a live
      // session.
      const s = store.authSessions.create(mkUser());
      const row = store.getDb().prepare('SELECT * FROM auth_sessions').get();
      assert.notEqual(row.token_hash, s.token);
      assert.equal(row.token_hash, authSession.hashToken(s.token));
      assert.equal(JSON.stringify(row).includes(s.token), false,
        'no column may contain the raw token');
    });

    it('mints a fresh token every time — there is no way to supply one', () => {
      // Session fixation is closed BY CONSTRUCTION here: no verb adopts a
      // caller-supplied id, so it cannot be forgotten at a call site.
      const u = mkUser();
      const a = store.authSessions.create(u);
      const b = store.authSessions.create(u);
      assert.notEqual(a.token, b.token);
    });

    it('refuses anything that is not a verified user', () => {
      for (const bad of [null, undefined, {}, { id: 'x', username: 'y' }, { id: 1 }]) {
        assert.throws(() => store.authSessions.create(bad), /verified user/);
      }
    });
  });

  describe('resolve', () => {
    it('returns the session for a live token', () => {
      const u = mkUser();
      const s = store.authSessions.create(u);
      const got = store.authSessions.resolve(s.token);
      assert.equal(got.username, 'rosie');
      assert.equal(got.userId, u.id);
      assert.equal(got.csrfToken, s.csrfToken);
    });

    it('returns null for an unknown, empty or non-string token', () => {
      store.authSessions.create(mkUser());
      for (const bad of ['a'.repeat(64), '', null, undefined, 42, {}]) {
        assert.equal(store.authSessions.resolve(bad), null,
          `${JSON.stringify(bad)} must not resolve`);
      }
    });

    it('refuses an expired session AND deletes the row', () => {
      const s = store.authSessions.create(mkUser());
      const after = s.expiresAt + 1;
      assert.equal(store.authSessions.resolve(s.token, after), null);
      assert.equal(
        store.getDb().prepare('SELECT COUNT(*) c FROM auth_sessions').get().c, 0,
        'an expired row is cleaned up as it is found'
      );
    });

    it('treats the expiry boundary as expired, not as live', () => {
      const s = store.authSessions.create(mkUser());
      assert.equal(store.authSessions.resolve(s.token, s.expiresAt), null);
    });

    it('refuses a session whose account was disabled, even if the row survives', () => {
      // The guard that makes revocation impossible to FORGET. `disable` also
      // deletes sessions, which makes it immediate; this catches a direct
      // database edit, or a future disable path that forgets.
      const u = mkUser();
      const s = store.authSessions.create(u);
      store.getDb().prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?")
        .run(u.id);
      assert.equal(store.authSessions.resolve(s.token), null);
    });

    it('refuses a session whose user row is gone', () => {
      // The JOIN is what does this. SQLite leaves foreign keys unenforced by
      // default, so ON DELETE CASCADE cannot be relied on to have removed it.
      const u = mkUser();
      const s = store.authSessions.create(u);
      store.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
      assert.equal(store.authSessions.resolve(s.token), null);
    });
  });

  describe('destroy', () => {
    it('removes the session the token names, and only that one', () => {
      const u = mkUser();
      const a = store.authSessions.create(u);
      const b = store.authSessions.create(u);
      assert.equal(store.authSessions.destroy(a.token), true);
      assert.equal(store.authSessions.resolve(a.token), null);
      assert.ok(store.authSessions.resolve(b.token), 'the other session survives');
    });

    it('answers false for a token it does not know', () => {
      assert.equal(store.authSessions.destroy('a'.repeat(64)), false);
      assert.equal(store.authSessions.destroy(''), false);
      assert.equal(store.authSessions.destroy(null), false);
    });
  });

  describe('destroyForUser', () => {
    it('removes every session for that account and reports how many', () => {
      const u = mkUser();
      store.authSessions.create(u);
      store.authSessions.create(u);
      const other = store.users.create('other', 'correct-horse-battery');
      const keep = store.authSessions.create(other);
      assert.equal(store.authSessions.destroyForUser('rosie'), 2);
      assert.ok(store.authSessions.resolve(keep.token), "another account's session survives");
    });

    it('answers 0 for an unknown or empty name', () => {
      assert.equal(store.authSessions.destroyForUser('nobody'), 0);
      assert.equal(store.authSessions.destroyForUser(''), 0);
      assert.equal(store.authSessions.destroyForUser(null), 0);
    });
  });

  describe('sweepExpired', () => {
    it('removes expired rows and leaves live ones', () => {
      const u = mkUser();
      const live = store.authSessions.create(u);
      const dead = store.authSessions.create(u);
      store.getDb().prepare('UPDATE auth_sessions SET expires_at = 1 WHERE token_hash = ?')
        .run(authSession.hashToken(dead.token));
      assert.equal(store.authSessions.sweepExpired(), 1);
      assert.ok(store.authSessions.resolve(live.token));
    });

    it('answers 0 when there is nothing to do', () => {
      assert.equal(store.authSessions.sweepExpired(), 0);
    });
  });

  describe('anyLoginableUser — the predicate the gate activates on', () => {
    it('is false with no accounts at all', () => {
      assert.equal(store.authSessions.anyLoginableUser(), false);
    });

    it('is true with one enabled account', () => {
      mkUser();
      assert.equal(store.authSessions.anyLoginableUser(), true);
    });

    it('is FALSE when the only account is disabled', () => {
      // An install whose only account is disabled has no key to its own door,
      // so treating it as gated would lock the operator out with no route back
      // that does not need a shell on the machine.
      mkUser();
      store.users.disable('rosie');
      assert.equal(store.authSessions.anyLoginableUser(), false);
    });

    it('is true again once a disabled account is re-enabled', () => {
      mkUser();
      store.users.disable('rosie');
      store.users.enable('rosie');
      assert.equal(store.authSessions.anyLoginableUser(), true);
    });
  });

  describe('revocation reaches live sessions', () => {
    it('disable destroys the account\'s sessions immediately', () => {
      // Without this, "revoke one person" — the capability ADR 0015 exists to
      // provide — would not take effect until the cookie expired up to 30 days
      // later, because an issued session never calls `verify` again.
      const u = mkUser();
      const s = store.authSessions.create(u);
      store.users.disable('rosie');
      assert.equal(
        store.getDb().prepare('SELECT COUNT(*) c FROM auth_sessions').get().c, 0,
        'the row is gone, not merely refused'
      );
      assert.equal(store.authSessions.resolve(s.token), null);
    });

    it('setPassword destroys the account\'s sessions', () => {
      // What makes reset-admin recovery rather than a password change: someone
      // running it because they believe the credential is compromised must not
      // leave the attacker's session valid for another 30 days.
      const u = mkUser();
      const s = store.authSessions.create(u);
      store.users.setPassword('rosie', 'a-brand-new-password');
      assert.equal(store.authSessions.resolve(s.token), null);
    });

    it('setPassword on an unknown account destroys nothing', () => {
      const u = mkUser();
      const s = store.authSessions.create(u);
      assert.equal(store.users.setPassword('nobody', 'a-brand-new-password'), false);
      assert.ok(store.authSessions.resolve(s.token), 'an unrelated session is untouched');
    });
  });

  describe('users.verifyAsync — the login route\'s verifier', () => {
    it('returns the user for a correct credential', async () => {
      mkUser();
      const got = await store.users.verifyAsync('rosie', 'correct-horse-battery');
      assert.equal(got.username, 'rosie');
    });

    it('returns null for a wrong password, an unknown name, and a disabled account', async () => {
      mkUser();
      assert.equal(await store.users.verifyAsync('rosie', 'wrong'), null);
      assert.equal(await store.users.verifyAsync('nobody', 'correct-horse-battery'), null);
      store.users.disable('rosie');
      assert.equal(await store.users.verifyAsync('rosie', 'correct-horse-battery'), null);
    });

    it('agrees with the synchronous verify on every one of those', async () => {
      // The async sibling must be the SAME decision, not a second
      // implementation that happens to agree today.
      mkUser();
      const cases = [
        ['rosie', 'correct-horse-battery'],
        ['rosie', 'wrong'],
        ['nobody', 'correct-horse-battery'],
        ['', ''],
        [null, null]
      ];
      for (const [u, p] of cases) {
        const sync = store.users.verify(u, p);
        const async_ = await store.users.verifyAsync(u, p);
        assert.deepEqual(async_, sync, `disagreement on ${JSON.stringify([u, p])}`);
      }
    });

    it('still spends scrypt work on the no-account path', async () => {
      // The equal cost IS the anti-timing-oracle fix, so the answer to blocking
      // was async scrypt, never skipping the comparison. Asserted by COUNTING
      // derivations rather than by timing them — a timing assertion on a
      // threadpool is a flake, and counting is what actually states the rule.
      const passwordLib = require('../lib/password');
      const real = passwordLib.verifyPasswordAsync;
      let calls = 0;
      passwordLib.verifyPasswordAsync = function (...args) {
        calls++;
        return real.apply(this, args);
      };
      try {
        mkUser();
        calls = 0;
        await store.users.verifyAsync('nobody-at-all', 'some-password');
        assert.equal(calls, 1, 'the unknown-account path must still pay the scrypt cost');
        calls = 0;
        await store.users.verifyAsync('rosie', 'wrong');
        assert.equal(calls, 1, 'and so must the wrong-password path');
      } finally {
        passwordLib.verifyPasswordAsync = real;
      }
    });
  });
});
