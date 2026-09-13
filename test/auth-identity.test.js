'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  refuseInboundIdentity, cameThroughProxy, resolveAuthStatus, isProxyHeaderTrusted,
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

describe('auth-identity.cameThroughProxy — the one spelling of "forwarded"', () => {
  it('is true when X-Forwarded-For is present, whatever its value', () => {
    for (const v of ['100.64.0.7', '', '   ', ['1.2.3.4']]) {
      assert.equal(cameThroughProxy({ [PROXY_EVIDENCE_HEADER]: v }), true, JSON.stringify(v));
    }
  });

  it('is false when it is absent, or there are no headers', () => {
    for (const h of [{}, { host: 'x' }, null, undefined, 'x']) {
      assert.equal(cameThroughProxy(h), false, JSON.stringify(h));
    }
  });

  it('is what every caller asks — no hand-spelled X-Forwarded-For check remains', () => {
    for (const rel of ['server.js', 'lib/auth-gate.js']) {
      const code = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', rel), 'utf8');
      assert.doesNotMatch(code, /headers\s*\[\s*['"]x-forwarded-for['"]\s*\]/i, rel);
    }
  });
});

describe('auth-identity.resolveAuthStatus — the gate state, reported as-is', () => {
  const { GATE_STATES } = require('../lib/auth-gate');

  it('reports every gate state unchanged — one vocabulary, no rename map', () => {
    for (const state of Object.values(GATE_STATES)) {
      assert.equal(resolveAuthStatus(state), state);
    }
  });

  it('AUTH_STATUSES is exactly the gate\'s states, so a new state needs no second edit', () => {
    assert.deepEqual([...AUTH_STATUSES].sort(), Object.values(GATE_STATES).sort());
  });

  it('answers anything that is not a gate state as unreadable — never as open', () => {
    // A status that fails toward "no login required" would tell the operator
    // the door is open when the code cannot say so.
    for (const v of [undefined, null, '', 'OPEN', 'off', 'live', 'bogus', true]) {
      assert.equal(resolveAuthStatus(v), 'unreadable', JSON.stringify(v));
    }
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
