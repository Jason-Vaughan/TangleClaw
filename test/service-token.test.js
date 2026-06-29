'use strict';

// AUTH-4 — unit tests for the pure service-token gate module. The HTTP wiring
// (dispatch gate, config redaction, auto-generate) is covered in
// test/api-service-token.test.js against a real server.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { generateToken, requiresServiceToken, validateRequest, TOKEN_PREFIX } =
  require('../lib/service-token');

describe('service-token.generateToken', () => {
  it('produces a tcsk_-prefixed token', () => {
    assert.ok(generateToken().startsWith(TOKEN_PREFIX));
  });

  it('produces a distinct token each call', () => {
    assert.notEqual(generateToken(), generateToken());
  });

  it('carries 32 bytes of entropy (base64url body)', () => {
    const body = generateToken().slice(TOKEN_PREFIX.length);
    assert.equal(Buffer.from(body, 'base64url').length, 32);
  });
});

describe('service-token.requiresServiceToken', () => {
  it('gates the PortHub surface (exact + sub-paths)', () => {
    assert.equal(requiresServiceToken('/api/ports'), true);
    assert.equal(requiresServiceToken('/api/ports/lease'), true);
    assert.equal(requiresServiceToken('/api/ports/release'), true);
    assert.equal(requiresServiceToken('/api/ports/heartbeat'), true);
  });

  it('gates the shared-docs surface (exact + sub-paths)', () => {
    assert.equal(requiresServiceToken('/api/shared-docs'), true);
    assert.equal(requiresServiceToken('/api/shared-docs/abc'), true);
    assert.equal(requiresServiceToken('/api/shared-docs/abc/lock'), true);
  });

  it('gates only a group /sync among the groups routes', () => {
    assert.equal(requiresServiceToken('/api/groups/g1/sync'), true);
    assert.equal(requiresServiceToken('/api/groups'), false);
    assert.equal(requiresServiceToken('/api/groups/g1'), false);
    assert.equal(requiresServiceToken('/api/groups/g1/members'), false);
  });

  it('leaves unrelated and malformed paths open', () => {
    assert.equal(requiresServiceToken('/api/projects'), false);
    assert.equal(requiresServiceToken('/api/health'), false);
    assert.equal(requiresServiceToken(null), false);
    assert.equal(requiresServiceToken(undefined), false);
  });
});

describe('service-token.validateRequest', () => {
  const TOKEN = 'tcsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
  const enabled = { serviceTokenEnabled: true, serviceToken: TOKEN };
  const bearer = (t) => ({ authorization: `Bearer ${t}` });

  it('allows when config is missing (fail-open only on default-off)', () => {
    assert.deepEqual(validateRequest({}, null), { ok: true });
  });

  it('allows when the gate is disabled, even with no header', () => {
    assert.deepEqual(validateRequest({}, { serviceTokenEnabled: false }), { ok: true });
  });

  it('500s when enabled but no token is configured (fail-closed, no silent open)', () => {
    const r = validateRequest(bearer(TOKEN), { serviceTokenEnabled: true, serviceToken: null });
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
    assert.equal(r.code, 'SERVICE_TOKEN_MISCONFIGURED');
  });

  it('401s when the Authorization header is missing', () => {
    const r = validateRequest({}, enabled);
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.equal(r.code, 'UNAUTHORIZED');
  });

  it('401s when headers are null', () => {
    const r = validateRequest(null, enabled);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNAUTHORIZED');
  });

  it('401s on a malformed (non-Bearer) Authorization header', () => {
    const r = validateRequest({ authorization: TOKEN }, enabled);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNAUTHORIZED');
  });

  it('401s on a wrong token of equal length', () => {
    const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith('F') ? 'G' : 'F');
    assert.equal(wrong.length, TOKEN.length);
    assert.notEqual(wrong, TOKEN);
    const r = validateRequest(bearer(wrong), enabled);
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.equal(r.code, 'INVALID_SERVICE_TOKEN');
  });

  it('401s on a wrong token of different length (length-safe compare)', () => {
    const r = validateRequest(bearer('tcsk_short'), enabled);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_SERVICE_TOKEN');
  });

  it('allows the correct token', () => {
    assert.deepEqual(validateRequest(bearer(TOKEN), enabled), { ok: true });
  });
});
