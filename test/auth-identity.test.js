'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRequestUser, resolveAuthStatus, IDENTITY_HEADER, AUTH_STATUSES } = require('../lib/auth-identity');

const CADDY_AUTH = { ingressMode: 'caddy', authEnabled: true };

describe('auth-identity.resolveRequestUser', () => {
  it('returns the username when the gate is live and the header is present', () => {
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: 'jason' }, CADDY_AUTH), 'jason');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: '  jason  ' }, CADDY_AUTH), 'jason');
  });

  it('ignores the header in direct mode (no authenticating proxy) — spoof defense', () => {
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: 'attacker' }, { ingressMode: 'direct', authEnabled: true }), null);
  });

  it('ignores the header when authEnabled is false even in caddy mode', () => {
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: 'attacker' }, { ingressMode: 'caddy', authEnabled: false }), null);
  });

  it('returns null when the header is absent', () => {
    assert.equal(resolveRequestUser({}, CADDY_AUTH), null);
  });

  it('returns null for an empty / whitespace-only header value', () => {
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: '' }, CADDY_AUTH), null);
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: '   ' }, CADDY_AUTH), null);
  });

  it('fails closed on an ambiguous array/duplicate header', () => {
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: ['jason', 'attacker'] }, CADDY_AUTH), null);
  });

  it('tolerates missing headers / config without throwing', () => {
    assert.equal(resolveRequestUser(null, CADDY_AUTH), null);
    assert.equal(resolveRequestUser({ [IDENTITY_HEADER]: 'jason' }, null), null);
    assert.equal(resolveRequestUser(undefined, undefined), null);
  });

  it('only reads the lower-cased x-auth-user key (Node normalizes header case)', () => {
    assert.equal(IDENTITY_HEADER, 'x-auth-user');
  });
});

describe('auth-identity.resolveAuthStatus (AUTH-2K9D)', () => {
  it("returns 'off' when authEnabled is falsy, regardless of ingress mode", () => {
    assert.equal(resolveAuthStatus({}, { ingressMode: 'direct', authEnabled: false }), 'off');
    assert.equal(resolveAuthStatus({}, { ingressMode: 'caddy', authEnabled: false }), 'off');
    assert.equal(resolveAuthStatus({}, { ingressMode: 'direct' }), 'off');
  });

  it("returns 'configured-inert' when authEnabled is true in direct mode (AUTH-2)", () => {
    // The flag is settable-but-inert: no in-process gate enforces it.
    assert.equal(resolveAuthStatus({}, { ingressMode: 'direct', authEnabled: true }), 'configured-inert');
    // A header present in direct mode does not change the verdict (and is never trusted).
    assert.equal(resolveAuthStatus({ [IDENTITY_HEADER]: 'attacker' }, { ingressMode: 'direct', authEnabled: true }), 'configured-inert');
  });

  it("treats any non-caddy ingress as inert when authEnabled is true", () => {
    // Defensive: a future/unknown ingress mode is not caddy, so no gate is installed.
    assert.equal(resolveAuthStatus({}, { ingressMode: 'future-proxy', authEnabled: true }), 'configured-inert');
  });

  it("returns 'live' when the caddy gate is up and identity is arriving", () => {
    assert.equal(resolveAuthStatus({ [IDENTITY_HEADER]: 'jason' }, CADDY_AUTH), 'live');
  });

  it("returns 'configured-no-identity' when caddy+authEnabled but no identity arrives (AUTH-3)", () => {
    assert.equal(resolveAuthStatus({}, CADDY_AUTH), 'configured-no-identity');
    assert.equal(resolveAuthStatus({ [IDENTITY_HEADER]: '' }, CADDY_AUTH), 'configured-no-identity');
    // Ambiguous duplicate header fails closed in resolveRequestUser → still no identity.
    assert.equal(resolveAuthStatus({ [IDENTITY_HEADER]: ['jason', 'attacker'] }, CADDY_AUTH), 'configured-no-identity');
  });

  it('tolerates missing headers / config without throwing', () => {
    assert.equal(resolveAuthStatus(null, null), 'off');
    assert.equal(resolveAuthStatus(undefined, undefined), 'off');
    assert.equal(resolveAuthStatus(null, CADDY_AUTH), 'configured-no-identity');
  });

  it('only ever returns a value from the AUTH_STATUSES enum', () => {
    const cases = [
      [{}, { authEnabled: false }],
      [{}, { ingressMode: 'direct', authEnabled: true }],
      [{ [IDENTITY_HEADER]: 'jason' }, CADDY_AUTH],
      [{}, CADDY_AUTH]
    ];
    for (const [h, c] of cases) {
      assert.ok(AUTH_STATUSES.includes(resolveAuthStatus(h, c)), `${resolveAuthStatus(h, c)} in enum`);
    }
  });
});
