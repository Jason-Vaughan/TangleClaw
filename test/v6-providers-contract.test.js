'use strict';

// v6 Train 3 Wave 1 (#2990, V6-19 / G2a, Car V60-T3-W1-A): the canonical
// provider adapter contract and its one concrete GitHub implementation.
// Pure functions, no sqlite, no network.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const contract = require('../lib/providers/contract');

describe('validateProviderAdapter (#2990 G2a)', () => {
  it('CONTRACT_METHODS has exactly the 6 named methods, and the real GitHub adapter implements every one', () => {
    assert.deepEqual(contract.CONTRACT_METHODS, [
      'validateConfig', 'testConnection', 'mapOutboundEvent', 'verifyWebhookSignature', 'normalizeInboundEvent', 'capabilities'
    ]);
    const adapter = contract.createGithubProvider();
    for (const method of contract.CONTRACT_METHODS) assert.equal(typeof adapter[method], 'function', `missing ${method}`);
    assert.deepEqual(contract.validateProviderAdapter(adapter), { ok: true });
  });

  it('refuses null/non-object input', () => {
    assert.equal(contract.validateProviderAdapter(null).ok, false);
    assert.equal(contract.validateProviderAdapter('x').ok, false);
  });

  it('reports every missing method by name, not just the first one', () => {
    const res = contract.validateProviderAdapter({ validateConfig: () => {} });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ADAPTER_INCOMPLETE');
    assert.deepEqual(res.missing.sort(), ['capabilities', 'mapOutboundEvent', 'normalizeInboundEvent', 'testConnection', 'verifyWebhookSignature'].sort());
  });
});

describe('createGithubProvider().validateConfig', () => {
  const gh = contract.createGithubProvider();

  it('accepts a well-formed config', () => {
    assert.deepEqual(gh.validateConfig({ repo: 'acme/widgets', installationId: 7, tokenRef: 'vault:gh-token' }), { ok: true });
  });

  it('refuses a repo not shaped like owner/name', () => {
    assert.equal(gh.validateConfig({ repo: 'not-owner-slash-name', installationId: 7, tokenRef: 'vault:gh-token' }).code, 'REPO_INVALID');
  });

  it('refuses a non-integer or non-positive installationId', () => {
    assert.equal(gh.validateConfig({ repo: 'a/b', installationId: 1.5, tokenRef: 'vault:x' }).code, 'INSTALLATION_ID_INVALID');
    assert.equal(gh.validateConfig({ repo: 'a/b', installationId: 0, tokenRef: 'vault:x' }).code, 'INSTALLATION_ID_INVALID');
  });

  it('refuses a tokenRef not shaped like vault:<ref>', () => {
    assert.equal(gh.validateConfig({ repo: 'a/b', installationId: 1, tokenRef: 'plaintext-secret' }).code, 'TOKEN_REF_INVALID');
  });
});

describe('createGithubProvider().testConnection (drift detection)', () => {
  const gh = contract.createGithubProvider();
  const now = 1_000_000;
  const basePermissions = ['issues:write'];
  const baseRepos = ['acme/widgets'];
  function fingerprint(permissions, repositories) {
    return JSON.stringify({ identity: 'app-1', kind: 'app', permissions: [...permissions].sort(), repositories: [...repositories].sort() });
  }
  const connection = { identity: 'app-1', repo: 'acme/widgets', expectedFingerprint: fingerprint(basePermissions, baseRepos) };

  it('returns null (no drift) when the probe matches the connection exactly', () => {
    const probe = { identity: 'app-1', kind: 'app', permissions: basePermissions, repositories: baseRepos, expiresAt: now + 1000 };
    assert.equal(gh.testConnection({ connection, probe, now }), null);
  });

  it('PROBE_UNAVAILABLE when the probe is missing required fields', () => {
    assert.equal(gh.testConnection({ connection, probe: null, now }), 'PROBE_UNAVAILABLE');
    assert.equal(gh.testConnection({ connection, probe: { identity: 'app-1' }, now }), 'PROBE_UNAVAILABLE');
  });

  it('PROBE_EXPIRED when the probe is past its own expiry', () => {
    const probe = { identity: 'app-1', kind: 'app', permissions: basePermissions, repositories: baseRepos, expiresAt: now - 1 };
    assert.equal(gh.testConnection({ connection, probe, now }), 'PROBE_EXPIRED');
  });

  it('IDENTITY_CHANGED when the probe reports a different identity', () => {
    const probe = { identity: 'app-DIFFERENT', kind: 'app', permissions: basePermissions, repositories: baseRepos, expiresAt: now + 1000 };
    assert.equal(gh.testConnection({ connection, probe, now }), 'IDENTITY_CHANGED');
  });

  it('REPOSITORY_ACCESS_LOST when the connection\'s repo is no longer in the probe\'s repo list', () => {
    const probe = { identity: 'app-1', kind: 'app', permissions: basePermissions, repositories: ['someone/else'], expiresAt: now + 1000 };
    assert.equal(gh.testConnection({ connection, probe, now }), 'REPOSITORY_ACCESS_LOST');
  });

  it('SCOPE_DRIFT when permissions changed from what the connection expects', () => {
    const probe = { identity: 'app-1', kind: 'app', permissions: ['contents:write'], repositories: baseRepos, expiresAt: now + 1000 };
    assert.equal(gh.testConnection({ connection, probe, now }), 'SCOPE_DRIFT');
  });
});

describe('createGithubProvider().mapOutboundEvent', () => {
  const gh = contract.createGithubProvider();

  it('maps createIssue to a POST against repos/<repo>/issues', () => {
    const mapped = gh.mapOutboundEvent({ action: 'createIssue', repo: 'acme/widgets', draft: { title: 't' } });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.method, 'POST');
    assert.equal(mapped.url, 'https://api.github.com/repos/acme/widgets/issues');
    assert.deepEqual(mapped.body, { title: 't' });
  });

  it('threads a caller-supplied apiBase through the mapped URL (PR #3019 Round 2 item 3)', () => {
    const mapped = gh.mapOutboundEvent({ action: 'createIssue', repo: 'acme/widgets', draft: { title: 't' }, apiBase: 'http://127.0.0.1:4000' });
    assert.equal(mapped.url, 'http://127.0.0.1:4000/repos/acme/widgets/issues');
  });

  it('maps createMilestone to repos/<repo>/milestones', () => {
    const mapped = gh.mapOutboundEvent({ action: 'createMilestone', repo: 'acme/widgets', draft: { title: 'M1' } });
    assert.equal(mapped.url, 'https://api.github.com/repos/acme/widgets/milestones');
  });

  it('refuses an unmapped action', () => {
    assert.equal(gh.mapOutboundEvent({ action: 'mergePullRequest', repo: 'acme/widgets', draft: {} }).code, 'ACTION_NOT_ALLOWED');
  });

  it('refuses a malformed repo', () => {
    assert.equal(gh.mapOutboundEvent({ action: 'createIssue', repo: 'not-a-repo', draft: {} }).code, 'REPO_INVALID');
  });
});

describe('createGithubProvider().verifyWebhookSignature', () => {
  const gh = contract.createGithubProvider();
  const secret = 'very-long-webhook-secret-p1';
  const rawBody = JSON.stringify({ action: 'opened' });
  const validSig = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  it('accepts a correctly-signed body', () => {
    assert.deepEqual(gh.verifyWebhookSignature({ secret, rawBody, signatureHeader: validSig }), { ok: true });
  });

  it('refuses a wrong signature', () => {
    assert.equal(gh.verifyWebhookSignature({ secret, rawBody, signatureHeader: 'sha256=0000000000000000000000000000000000000000000000000000000000000000' }).code, 'BAD_SIGNATURE');
  });

  it('refuses a signature computed with the wrong secret', () => {
    const wrongSig = `sha256=${crypto.createHmac('sha256', 'a-different-very-long-secret').update(rawBody).digest('hex')}`;
    assert.equal(gh.verifyWebhookSignature({ secret, rawBody, signatureHeader: wrongSig }).code, 'BAD_SIGNATURE');
  });

  it('refuses when the secret itself is unavailable (too short / missing)', () => {
    assert.equal(gh.verifyWebhookSignature({ secret: 'short', rawBody, signatureHeader: validSig }).code, 'SECRET_UNAVAILABLE');
    assert.equal(gh.verifyWebhookSignature({ secret: null, rawBody, signatureHeader: validSig }).code, 'SECRET_UNAVAILABLE');
  });

  it('refuses a missing signature header without throwing on the length comparison', () => {
    assert.equal(gh.verifyWebhookSignature({ secret, rawBody, signatureHeader: undefined }).code, 'BAD_SIGNATURE');
  });
});

describe('createGithubProvider().normalizeInboundEvent', () => {
  const gh = contract.createGithubProvider();

  it('extracts repo/installationId/deliveryId/eventType from a real-shaped payload', () => {
    const res = gh.normalizeInboundEvent({
      headers: { 'x-github-delivery': 'd1234', 'x-github-event': 'pull_request' },
      payload: { repository: { full_name: 'acme/widgets' }, installation: { id: 9 } }
    });
    assert.deepEqual(res, { ok: true, repo: 'acme/widgets', installationId: 9, deliveryId: 'd1234', eventType: 'pull_request' });
  });

  it('refuses a malformed delivery id', () => {
    const res = gh.normalizeInboundEvent({ headers: { 'x-github-delivery': 'has spaces!' }, payload: {} });
    assert.equal(res.code, 'BAD_DELIVERY_ID');
  });

  it('refuses a payload with no repository/installation identity', () => {
    const res = gh.normalizeInboundEvent({ headers: { 'x-github-delivery': 'd1' }, payload: {} });
    assert.equal(res.code, 'BAD_IDENTITY');
  });
});

describe('createGithubProvider().capabilities', () => {
  it('declares the github provider with its action/tier map', () => {
    const gh = contract.createGithubProvider();
    const caps = gh.capabilities();
    assert.equal(caps.provider, 'github');
    assert.equal(caps.actions, contract.GITHUB_ACTIONS);
    assert.equal(caps.actions.createIssue.tier, 2);
    assert.equal(caps.actions.createMilestone.tier, 3);
  });
});
