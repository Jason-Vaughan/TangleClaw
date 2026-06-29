'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRequestUser, IDENTITY_HEADER } = require('../lib/auth-identity');

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
