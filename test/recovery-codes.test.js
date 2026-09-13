'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const rc = require('../lib/recovery-codes');

describe('lib/recovery-codes — the pure half (#1420)', () => {
  describe('generateCode / generateSet', () => {
    it('produces 25 characters from the Crockford alphabet only', () => {
      for (let i = 0; i < 200; i++) {
        const code = rc.generateCode();
        assert.equal(code.length, rc.CODE_LENGTH);
        assert.match(code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/);
      }
    });

    it('carries at least 120 bits — the property that makes guessing not an attack', () => {
      assert.ok(rc.CODE_LENGTH * Math.log2(rc.ALPHABET.length) >= 120);
      assert.equal(rc.ALPHABET.length, 32, 'a 32-symbol alphabet keeps byte & 31 uniform');
    });

    it('uses every symbol — no character is dropped from the mapping', () => {
      const seen = new Set();
      for (let i = 0; i < 400; i++) for (const ch of rc.generateCode()) seen.add(ch);
      assert.equal(seen.size, 32);
    });

    it('generates a set of distinct codes, eight by default', () => {
      const set = rc.generateSet();
      assert.equal(set.length, rc.CODES_PER_SET);
      assert.equal(rc.CODES_PER_SET, 8);
      assert.equal(new Set(set).size, set.length);
    });
  });

  describe('normalizeCode', () => {
    const code = 'ABCDE0123456789FGHJKMNPQR';

    it('accepts the canonical form unchanged', () => {
      assert.equal(rc.normalizeCode(code), code);
    });

    it('accepts the displayed form, lower case, and spaces a phone inserts', () => {
      assert.equal(rc.normalizeCode(rc.formatCode(code)), code);
      assert.equal(rc.normalizeCode(rc.formatCode(code).toLowerCase()), code);
      assert.equal(rc.normalizeCode(' abcde 01234 56789-fghjk\tmnpqr '), code);
    });

    it('maps Crockford look-alikes: O to 0, I and L to 1', () => {
      assert.equal(rc.normalizeCode('ABCDEO123456789FGHJKMNPQR'), code);
      assert.equal(rc.normalizeCode('ABCDE0I23456789FGHJKMNPQR'), code);
      assert.equal(rc.normalizeCode('abcde0l23456789fghjkmnpqr'), code);
    });

    it('refuses anything that cannot be a code', () => {
      for (const bad of [undefined, null, 42, {}, '', 'ABCDE', code + 'A', code.slice(1),
        'ABCDEU123456789FGHJKMNPQR', 'ABCDE!123456789FGHJKMNPQR', 'A'.repeat(500)]) {
        assert.equal(rc.normalizeCode(bad), null, `refused: ${String(bad).slice(0, 30)}`);
      }
    });
  });

  describe('formatCode / hashCode', () => {
    it('groups in fives', () => {
      assert.equal(rc.formatCode('ABCDE0123456789FGHJKMNPQR'), 'ABCDE-01234-56789-FGHJK-MNPQR');
    });

    it('hashes to a stable SHA-256 hex digest that is not the code', () => {
      const code = rc.generateCode();
      const h = rc.hashCode(code);
      assert.match(h, /^[0-9a-f]{64}$/);
      assert.equal(rc.hashCode(code), h);
      assert.ok(!h.includes(code.toLowerCase()));
      assert.notEqual(rc.hashCode(rc.generateCode()), h);
    });
  });

  describe('clientKey', () => {
    const loop = (a) => a === '127.0.0.1' || a === '::1';

    it('uses the socket address for a direct request', () => {
      assert.equal(rc.clientKey({ remoteAddress: '100.64.0.9' }, {}, loop), 'sock:100.64.0.9');
    });

    it('uses the proxy\'s X-Forwarded-For when the socket is loopback', () => {
      assert.equal(rc.clientKey({ remoteAddress: '127.0.0.1' }, { 'x-forwarded-for': '100.64.0.9' }, loop),
        'xff:100.64.0.9');
    });

    it('takes the LAST forwarded entry — the one the proxy appended', () => {
      assert.equal(rc.clientKey({ remoteAddress: '::1' }, { 'x-forwarded-for': '6.6.6.6, 100.64.0.9' }, loop),
        'xff:100.64.0.9');
    });

    it('ignores a forwarded header on a NON-loopback socket — that is the client\'s own claim', () => {
      assert.equal(rc.clientKey({ remoteAddress: '192.168.1.5' }, { 'x-forwarded-for': '1.2.3.4' }, loop),
        'sock:192.168.1.5');
    });

    it('falls back to the socket for an empty forwarded header', () => {
      assert.equal(rc.clientKey({ remoteAddress: '127.0.0.1' }, { 'x-forwarded-for': ' ' }, loop),
        'sock:127.0.0.1');
    });
  });

  describe('createFailureLimiter', () => {
    it('limits a client after maxFailures, and only that client', () => {
      const lim = rc.createFailureLimiter({ maxFailures: 3 });
      for (let i = 0; i < 3; i++) {
        assert.equal(lim.isLimited('a'), false);
        lim.recordFailure('a');
      }
      assert.equal(lim.isLimited('a'), true);
      assert.equal(lim.isLimited('b'), false);
    });

    it('forgets a client once its window has passed', () => {
      let t = 1000;
      const lim = rc.createFailureLimiter({ maxFailures: 1, windowMs: 100, now: () => t });
      lim.recordFailure('a');
      assert.equal(lim.isLimited('a'), true);
      t += 99;
      assert.equal(lim.isLimited('a'), true);
      t += 1;
      assert.equal(lim.isLimited('a'), false);
    });

    it('stays bounded, evicting the oldest client when full', () => {
      const lim = rc.createFailureLimiter({ maxFailures: 1, maxClients: 3 });
      for (const k of ['a', 'b', 'c', 'd']) lim.recordFailure(k);
      assert.equal(lim.size(), 3);
      assert.equal(lim.isLimited('a'), false, 'the oldest was evicted');
      assert.equal(lim.isLimited('d'), true);
    });

    it('prunes expired windows before evicting a live one', () => {
      let t = 0;
      const lim = rc.createFailureLimiter({ maxFailures: 1, windowMs: 10, maxClients: 2, now: () => t });
      lim.recordFailure('old');
      t = 5;
      lim.recordFailure('live');
      t = 12;
      lim.recordFailure('new');
      assert.equal(lim.isLimited('live'), true, 'the live window survived; the expired one made room');
      assert.equal(lim.isLimited('new'), true);
    });
  });
});
