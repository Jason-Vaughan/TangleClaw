'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  refuseInboundIdentity, resolveAuthStatus, isProxyHeaderTrusted,
  IDENTITY_HEADER, PROXY_EVIDENCE_HEADER, AUTH_STATUSES
} = require('../lib/auth-identity');

describe('auth-identity.refuseInboundIdentity — identity is the session\'s (#1420, ADR 0016 OQ2)', () => {
  it('deletes the header and reports it was present', () => {
    const headers = { [IDENTITY_HEADER]: 'attacker', host: 'x' };
    assert.deepEqual(refuseInboundIdentity(headers), { present: true, proxied: false });
    assert.equal(IDENTITY_HEADER in headers, false, 'deleted, not merely ignored');
    assert.equal(headers.host, 'x', 'nothing else is touched');
  });

  it('deletes it on every mode — there is no config under which it is trusted', () => {
    // The function takes no config at all: no mode can make the header believed.
    assert.equal(refuseInboundIdentity.length, 1);
  });

  it('reports a header that came through a proxy as proxied — Caddy\'s transitional header_up', () => {
    const headers = { [IDENTITY_HEADER]: 'jason', [PROXY_EVIDENCE_HEADER]: '100.64.0.7' };
    assert.deepEqual(refuseInboundIdentity(headers), { present: true, proxied: true });
    assert.equal(IDENTITY_HEADER in headers, false, 'Caddy\'s own value is deleted too');
  });

  it('deletes an empty, whitespace or duplicated header as well', () => {
    for (const v of ['', '   ', ['jason', 'attacker']]) {
      const headers = { [IDENTITY_HEADER]: v };
      assert.equal(refuseInboundIdentity(headers).present, true, JSON.stringify(v));
      assert.equal(IDENTITY_HEADER in headers, false);
    }
  });

  it('reports nothing present when the header is absent', () => {
    assert.deepEqual(refuseInboundIdentity({ host: 'x' }), { present: false, proxied: false });
  });

  it('does not treat an inherited property as a header', () => {
    const headers = Object.create({ [IDENTITY_HEADER]: 'inherited' });
    assert.deepEqual(refuseInboundIdentity(headers), { present: false, proxied: false });
  });

  it('tolerates missing headers without throwing', () => {
    for (const h of [null, undefined, 'x', 7]) {
      assert.deepEqual(refuseInboundIdentity(h), { present: false, proxied: false });
    }
  });

  it('reads only the lower-cased key (Node normalizes header case)', () => {
    assert.equal(IDENTITY_HEADER, 'x-auth-user');
  });
});

describe('auth-identity.resolveAuthStatus — derived from the gate state', () => {
  const MAPPING = {
    open: 'off',
    armed: 'live',
    'account-required': 'account-required',
    locked: 'locked',
    unreadable: 'unreadable'
  };

  for (const [gateState, status] of Object.entries(MAPPING)) {
    it(`maps gate state ${gateState} → ${status}`, () => {
      assert.equal(resolveAuthStatus(gateState), status);
    });
  }

  it('answers an unknown or missing gate state as unreadable — never as off', () => {
    // A status that fails toward "no login required" would tell the operator
    // the door is open when the code cannot say so.
    for (const v of [undefined, null, '', 'OPEN', 'bogus', true]) {
      assert.equal(resolveAuthStatus(v), 'unreadable', JSON.stringify(v));
    }
  });

  it('covers every gate state the gate can produce', () => {
    const { GATE_STATES } = require('../lib/auth-gate');
    for (const state of Object.values(GATE_STATES)) {
      assert.ok(state in MAPPING, `gate state ${state} has a mapping in this test`);
      assert.equal(resolveAuthStatus(state), MAPPING[state]);
    }
  });

  it('only ever returns a value from the AUTH_STATUSES enum, and uses all of it', () => {
    const produced = new Set(Object.keys(MAPPING).map(resolveAuthStatus));
    assert.deepEqual([...produced].sort(), [...AUTH_STATUSES].sort());
  });
});

describe('auth-identity.isProxyHeaderTrusted — still the forwarded-host gate', () => {
  it('is true only in caddy mode with authEnabled', () => {
    assert.equal(isProxyHeaderTrusted({ ingressMode: 'caddy', authEnabled: true }), true);
    assert.equal(isProxyHeaderTrusted({ ingressMode: 'caddy', authEnabled: false }), false);
    assert.equal(isProxyHeaderTrusted({ ingressMode: 'direct', authEnabled: true }), false);
    assert.equal(isProxyHeaderTrusted(null), false);
  });
});
