'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const password = require('../lib/password');
const projects = require('../lib/projects');

describe('lib/password — scrypt hash and verify (ADR 0015)', () => {
  describe('hashPassword', () => {
    // Literals, not `password.SALT_BYTES * 2`. Deriving the expectation from the
    // constant under test means changing the constant changes the assertion with
    // it, and the stored format — already persisted on every live install for
    // `config.deletePassword` — silently stops being pinned by anything.
    it('produces salt:hash in hex, 16-byte salt and 64-byte key', () => {
      const hashed = password.hashPassword('test123');
      const [salt, hash] = hashed.split(':');
      assert.equal(salt.length, 32, '16-byte salt, hex');
      assert.equal(hash.length, 128, '64-byte key, hex');
      assert.match(hashed, /^[0-9a-f]+:[0-9a-f]+$/);
    });

    it('salts per call, so the same password never hashes to the same value', () => {
      assert.notEqual(password.hashPassword('same'), password.hashPassword('same'));
    });
  });

  describe('verifyPassword', () => {
    it('accepts the right password and rejects the wrong one', () => {
      const hashed = password.hashPassword('mysecret');
      assert.equal(password.verifyPassword('mysecret', hashed), true);
      assert.equal(password.verifyPassword('wrong', hashed), false);
    });

    it('rejects empty and non-string inputs without throwing', () => {
      const hashed = password.hashPassword('mysecret');
      assert.equal(password.verifyPassword(null, null), false);
      assert.equal(password.verifyPassword('test', null), false);
      assert.equal(password.verifyPassword(null, hashed), false);
      assert.equal(password.verifyPassword('', hashed), false);
      assert.equal(password.verifyPassword(42, hashed), false);
      assert.equal(password.verifyPassword('test', 42), false);
    });

    it('rejects a stored value with no salt separator', () => {
      assert.equal(password.verifyPassword('test', 'nocolon'), false);
      assert.equal(password.verifyPassword('test', ':'), false);
      assert.equal(password.verifyPassword('test', 'saltonly:'), false);
    });

    // The regression this module was extracted to fix.
    //
    // `crypto.timingSafeEqual` THROWS on unequal buffer lengths, and
    // `Buffer.from(str, 'hex')` truncates silently at the first invalid pair.
    // Before the length guard, every case below raised
    // `RangeError: Input buffers must have the same byte length` instead of
    // answering false — a 500 on the delete-confirmation path, and a crash
    // serving a malformed row once this is the login path.
    //
    // Each case is a DIFFERENT way to reach a short buffer, because the guard
    // has to hold for all of them and not just the tidy one: a hash that is
    // genuinely short, one whose hex is odd-length, and one that is not hex at
    // all.
    describe('a malformed stored hash answers false, never throws', () => {
      const validSalt = 'a'.repeat(password.SALT_BYTES * 2);

      const cases = {
        'hash too short (32 hex chars, not 128)': `${validSalt}:${'ab'.repeat(16)}`,
        'hash hex is odd-length': `${validSalt}:abc`,
        'hash is not hex at all': `${validSalt}:${'zz'.repeat(64)}`,
        'hash is a single character': `${validSalt}:f`,
        'hash is longer than the derived key': `${validSalt}:${'ab'.repeat(80)}`
      };

      for (const [name, stored] of Object.entries(cases)) {
        it(name, () => {
          assert.doesNotThrow(() => password.verifyPassword('pw', stored));
          assert.equal(password.verifyPassword('pw', stored), false);
        });
      }
    });
  });

  describe('lib/projects re-exports the same functions', () => {
    // projects.hashPassword is the name every existing caller uses
    // (server.js config writes, the delete guard). The extraction must not
    // change that contract — this asserts identity, not merely equivalence,
    // so a future copy-paste back into projects.js fails here.
    it('projects.hashPassword IS password.hashPassword', () => {
      assert.equal(projects.hashPassword, password.hashPassword);
    });

    it('projects.verifyPassword IS password.verifyPassword', () => {
      assert.equal(projects.verifyPassword, password.verifyPassword);
    });

    it('a hash made through projects verifies through password and back', () => {
      const viaProjects = projects.hashPassword('round-trip');
      assert.equal(password.verifyPassword('round-trip', viaProjects), true);
      const viaPassword = password.hashPassword('round-trip');
      assert.equal(projects.verifyPassword('round-trip', viaPassword), true);
    });
  });
});
