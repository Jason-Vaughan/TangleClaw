'use strict';

// v6.2 (#3002, V6-32 / G2b, Car V62-W1-A): GitLab, Jira, Linear and Dolt
// adapters behind the G2a contract (lib/providers/contract.js). Signatures
// are computed here with node:crypto exactly as each provider documents,
// so a passing test means the adapter accepts a real delivery's shape and
// refuses a tampered, stale or unsigned one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const g2b = require('../lib/v6/g2b-provider-adapters');
const { validateProviderAdapter, CONTRACT_METHODS } = require('../lib/providers/contract');

const SECRET = 'a-webhook-secret-of-adequate-length';
const TEAM = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const DRAFT = { title: 'Flaky watchdog', body: 'line one\nline two', labels: ['bug'] };

describe('contract conformance (#3002)', () => {
  it('every adapter implements all six G2a methods and names itself', () => {
    const v = g2b.verifyContract();
    assert.equal(v.ok, true, JSON.stringify(v.results));
    for (const provider of g2b.PROVIDERS) {
      const adapter = g2b.createProviderAdapter(provider);
      assert.deepEqual(validateProviderAdapter(adapter), { ok: true }, provider);
      for (const m of CONTRACT_METHODS) assert.equal(typeof adapter[m], 'function', `${provider}.${m}`);
    }
  });

  it('an unknown provider (including prototype names) has no adapter', () => {
    for (const name of ['github', 'bitbucket', '__proto__', 'constructor']) assert.equal(g2b.createProviderAdapter(name), null, name);
  });

  it('capability negotiation names unsupported actions explicitly, never an empty success', () => {
    assert.deepEqual(g2b.negotiateCapability('gitlab', 'createMilestone'), { ok: true, tier: 3, permission: 'api' });
    assert.equal(g2b.negotiateCapability('jira', 'createMilestone').code, 'CAPABILITY_UNSUPPORTED');
    assert.equal(g2b.negotiateCapability('dolt', 'createIssue').code, 'CAPABILITY_UNSUPPORTED');
    assert.equal(g2b.negotiateCapability('linear', 'mergePullRequest').code, 'ACTION_NOT_ALLOWED');
    assert.equal(g2b.negotiateCapability('nope', 'createIssue').code, 'UNKNOWN_PROVIDER');
  });
});

describe('validateConfig and testConnection (#3002)', () => {
  it('validates each provider\'s own resource identifier and a vault token ref', () => {
    const gl = g2b.createGitlabProvider();
    assert.deepEqual(gl.validateConfig({ repo: 'group/sub/project', tokenRef: 'vault:gl' }), { ok: true });
    assert.equal(gl.validateConfig({ repo: 'noslash', tokenRef: 'vault:gl' }).code, 'REPO_INVALID');
    assert.equal(gl.validateConfig({ repo: 'g/p', baseUrl: 'http://gitlab.example.com', tokenRef: 'vault:gl' }).code, 'BASE_URL_INVALID');
    assert.equal(gl.validateConfig({ repo: 'g/p', tokenRef: 'plain-token' }).code, 'TOKEN_REF_INVALID');
    const jira = g2b.createJiraProvider();
    assert.deepEqual(jira.validateConfig({ repo: 'TC', site: 'https://acme.atlassian.net', tokenRef: 'vault:j' }), { ok: true });
    assert.equal(jira.validateConfig({ repo: 'tc', site: 'https://acme.atlassian.net', tokenRef: 'vault:j' }).code, 'REPO_INVALID');
    assert.equal(jira.validateConfig({ repo: 'TC', site: 'https://user:pw@acme.atlassian.net', tokenRef: 'vault:j' }).code, 'BASE_URL_INVALID');
    assert.deepEqual(g2b.createLinearProvider().validateConfig({ repo: TEAM, tokenRef: 'vault:l' }), { ok: true });
    assert.equal(g2b.createLinearProvider().validateConfig({ repo: 'ENG', tokenRef: 'vault:l' }).code, 'REPO_INVALID');
    assert.deepEqual(g2b.createDoltProvider().validateConfig({ repo: 'dolthub/us-jails', tokenRef: 'vault:d' }), { ok: true });
  });

  it('testConnection reports each drift kind, and no drift for a matching fresh probe', () => {
    const gl = g2b.createGitlabProvider();
    const connection = { identity: 'bot', repo: 'g/p', scopes: ['api'] };
    const probe = { identity: 'bot', scopes: ['api'], projects: ['g/p'], expiresAt: 200 };
    assert.equal(gl.testConnection({ connection, probe, now: 100 }), null);
    assert.equal(gl.testConnection({ connection, probe: null, now: 100 }), 'PROBE_UNAVAILABLE');
    assert.equal(gl.testConnection({ connection, probe: { ...probe, expiresAt: 100 }, now: 100 }), 'PROBE_EXPIRED');
    assert.equal(gl.testConnection({ connection, probe: { ...probe, identity: 'other' }, now: 100 }), 'IDENTITY_CHANGED');
    assert.equal(gl.testConnection({ connection, probe: { ...probe, projects: [] }, now: 100 }), 'REPOSITORY_ACCESS_LOST');
    assert.equal(gl.testConnection({ connection, probe: { ...probe, scopes: ['api', 'sudo'] }, now: 100 }), 'SCOPE_DRIFT');
    const lin = g2b.createLinearProvider();
    assert.equal(lin.testConnection({ connection: { identity: 'b', repo: TEAM, scopes: ['write'] }, probe: { identity: 'b', scopes: ['write'], teams: [TEAM], expiresAt: 9 }, now: 1 }), null);
  });
});

describe('mapOutboundEvent (#3002)', () => {
  it('GitLab: issues and milestones under the URL-encoded project path', () => {
    const gl = g2b.createGitlabProvider();
    const issue = gl.mapOutboundEvent({ action: 'createIssue', repo: 'group/sub/project', draft: DRAFT });
    assert.deepEqual(issue, { ok: true, method: 'POST', url: 'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/issues',
      body: { title: 'Flaky watchdog', description: 'line one\nline two', labels: 'bug' } });
    const ms = gl.mapOutboundEvent({ action: 'createMilestone', repo: 'g/p', draft: { title: 'v6.2.0' }, apiBase: 'https://gitlab.example.com' });
    assert.equal(ms.url, 'https://gitlab.example.com/api/v4/projects/g%2Fp/milestones');
    assert.equal(gl.mapOutboundEvent({ action: 'inspect', repo: 'g/p', draft: DRAFT }).code, 'ACTION_NOT_ALLOWED');
    assert.equal(gl.mapOutboundEvent({ action: 'createIssue', repo: 'g/p', draft: { title: '' } }).code, 'BAD_DRAFT');
    assert.equal(gl.mapOutboundEvent({ action: 'createIssue', repo: 'g/p', draft: DRAFT, apiBase: 'http://evil' }).code, 'BASE_URL_INVALID');
  });

  it('Jira: a v3 issue with an ADF description; milestones and spaced labels are refused, not rewritten', () => {
    const jira = g2b.createJiraProvider();
    const out = jira.mapOutboundEvent({ action: 'createIssue', repo: 'TC', draft: DRAFT, apiBase: 'https://acme.atlassian.net' });
    assert.equal(out.url, 'https://acme.atlassian.net/rest/api/3/issue');
    assert.deepEqual(out.body.fields.project, { key: 'TC' });
    assert.equal(out.body.fields.summary, 'Flaky watchdog');
    assert.deepEqual(out.body.fields.issuetype, { name: 'Task' });
    assert.equal(out.body.fields.description.type, 'doc');
    assert.equal(out.body.fields.description.content.length, 2);
    assert.deepEqual(out.body.fields.labels, ['bug']);
    assert.equal(jira.mapOutboundEvent({ action: 'createMilestone', repo: 'TC', draft: DRAFT, apiBase: 'https://acme.atlassian.net' }).code, 'CAPABILITY_UNSUPPORTED');
    assert.equal(jira.mapOutboundEvent({ action: 'createIssue', repo: 'TC', draft: { ...DRAFT, labels: ['two words'] }, apiBase: 'https://acme.atlassian.net' }).code, 'LABEL_INVALID');
    assert.equal(jira.mapOutboundEvent({ action: 'createIssue', repo: 'TC', draft: DRAFT }).code, 'BASE_URL_INVALID', 'a Jira site is never defaulted');
  });

  it('Linear: one GraphQL issueCreate; label names are refused rather than silently dropped', () => {
    const lin = g2b.createLinearProvider();
    const out = lin.mapOutboundEvent({ action: 'createIssue', repo: TEAM, draft: { title: 'T', body: 'B' } });
    assert.equal(out.url, 'https://api.linear.app/graphql');
    assert.match(out.body.query, /issueCreate\(input: \$input\)/);
    assert.deepEqual(out.body.variables.input, { teamId: TEAM, title: 'T', description: 'B' });
    assert.equal(lin.mapOutboundEvent({ action: 'createIssue', repo: TEAM, draft: DRAFT }).code, 'LABELS_UNSUPPORTED');
    assert.equal(lin.mapOutboundEvent({ action: 'createMilestone', repo: TEAM, draft: DRAFT }).code, 'CAPABILITY_UNSUPPORTED');
  });

  it('Dolt: every write is explicitly unsupported', () => {
    assert.equal(g2b.createDoltProvider().mapOutboundEvent({ action: 'createIssue', repo: 'o/d', draft: DRAFT }).code, 'CAPABILITY_UNSUPPORTED');
  });
});

describe('verifyWebhookSignature (#3002)', () => {
  const body = JSON.stringify({ object_kind: 'issue', project: { id: 7, path_with_namespace: 'g/p' } });

  it('GitLab token mode: a timing-safe match of X-Gitlab-Token', () => {
    const gl = g2b.createGitlabProvider();
    assert.deepEqual(gl.verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: SECRET }), { ok: true });
    assert.equal(gl.verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: `${SECRET}x` }).code, 'BAD_SIGNATURE');
    assert.equal(gl.verifyWebhookSignature({ secret: SECRET, rawBody: body }).code, 'BAD_SIGNATURE');
    assert.equal(gl.verifyWebhookSignature({ secret: 'short', rawBody: body, signatureHeader: 'short' }).code, 'SECRET_UNAVAILABLE');
  });

  it('GitLab signing-token mode: v1 HMAC over id.timestamp.body, any listed signature, within 5 minutes', () => {
    const gl = g2b.createGitlabProvider();
    const keyBytes = crypto.randomBytes(32);
    const secret = `whsec_${keyBytes.toString('base64')}`;
    const now = 1_800_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const sig = crypto.createHmac('sha256', keyBytes).update(`msg_1.${ts}.${body}`).digest('base64');
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,AAAA v1,${sig}` };
    assert.deepEqual(gl.verifyWebhookSignature({ secret, rawBody: body, headers, now }), { ok: true });
    assert.equal(gl.verifyWebhookSignature({ secret, rawBody: `${body} `, headers, now }).code, 'BAD_SIGNATURE', 'tampered body');
    assert.equal(gl.verifyWebhookSignature({ secret, rawBody: body, headers: { ...headers, 'webhook-id': 'msg_2' }, now }).code, 'BAD_SIGNATURE', 'id is signed');
    assert.equal(gl.verifyWebhookSignature({ secret, rawBody: body, headers, now: now + 301_000 }).code, 'STALE_DELIVERY');
    assert.equal(gl.verifyWebhookSignature({ secret, rawBody: body, headers: { ...headers, 'webhook-signature': `v2,${sig}` }, now }).code, 'BAD_SIGNATURE', 'only v1 is accepted');
  });

  it('Jira: sha256=<hex> over the raw body', () => {
    const jira = g2b.createJiraProvider();
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
    assert.deepEqual(jira.verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sig }), { ok: true });
    assert.equal(jira.verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sig.replace('sha256=', '') }).code, 'BAD_SIGNATURE');
    assert.equal(jira.verifyWebhookSignature({ secret: SECRET, rawBody: Buffer.from(`${body}x`), signatureHeader: sig }).code, 'BAD_SIGNATURE');
  });

  it('Linear: bare hex HMAC, then a webhookTimestamp within one minute', () => {
    const lin = g2b.createLinearProvider();
    const now = 1_800_000_000_000;
    const raw = JSON.stringify({ action: 'create', type: 'Issue', data: { teamId: TEAM }, webhookTimestamp: now - 1000 });
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    assert.deepEqual(lin.verifyWebhookSignature({ secret: SECRET, rawBody: raw, signatureHeader: sig, now }), { ok: true });
    assert.equal(lin.verifyWebhookSignature({ secret: SECRET, rawBody: raw, signatureHeader: `sha256=${sig}`, now }).code, 'BAD_SIGNATURE', 'no prefix');
    assert.equal(lin.verifyWebhookSignature({ secret: SECRET, rawBody: raw, signatureHeader: sig, now: now + 61_000 }).code, 'STALE_DELIVERY', 'replay window');
  });

  it('Dolt: every delivery fails closed, signed or not', () => {
    const dolt = g2b.createDoltProvider();
    assert.equal(dolt.verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: SECRET }).code, 'SIGNATURE_UNSUPPORTED');
    assert.equal(dolt.normalizeInboundEvent({ headers: {}, payload: { event_name: 'on_push' } }).code, 'SIGNATURE_UNSUPPORTED');
  });
});

describe('normalizeInboundEvent (#3002)', () => {
  it('extracts each provider\'s own delivery id, resource and event type, case-insensitively', () => {
    const gl = g2b.createGitlabProvider().normalizeInboundEvent({
      headers: { 'Idempotency-Key': 'abc-123', 'X-Gitlab-Event': 'Issue Hook' },
      payload: { project: { id: 7, path_with_namespace: 'g/p' } }
    });
    assert.deepEqual(gl, { ok: true, repo: 'g/p', providerProjectId: 7, deliveryId: 'abc-123', eventType: 'Issue Hook' });
    const jira = g2b.createJiraProvider().normalizeInboundEvent({
      headers: { 'x-atlassian-webhook-identifier': '12345' },
      payload: { webhookEvent: 'jira:issue_created', issue: { fields: { project: { key: 'TC' } } } }
    });
    assert.deepEqual(jira, { ok: true, repo: 'TC', deliveryId: '12345', eventType: 'jira:issue_created' });
    const lin = g2b.createLinearProvider().normalizeInboundEvent({
      headers: { 'linear-delivery': '0f0e0d0c-1111-2222-3333-444455556666', 'linear-event': 'Issue' },
      payload: { data: { teamId: TEAM } }
    });
    assert.equal(lin.repo, TEAM);
    assert.equal(lin.eventType, 'Issue');
  });

  it('refuses a missing or malformed delivery id or identity', () => {
    assert.equal(g2b.createGitlabProvider().normalizeInboundEvent({ headers: {}, payload: {} }).code, 'BAD_DELIVERY_ID');
    assert.equal(g2b.createGitlabProvider().normalizeInboundEvent({ headers: { 'idempotency-key': 'k' }, payload: { project: { path_with_namespace: 'g/p' } } }).code, 'BAD_IDENTITY');
    assert.equal(g2b.createJiraProvider().normalizeInboundEvent({ headers: { 'x-atlassian-webhook-identifier': 'bad id!' }, payload: {} }).code, 'BAD_DELIVERY_ID');
    assert.equal(g2b.createLinearProvider().normalizeInboundEvent({ headers: { 'linear-delivery': 'd' }, payload: { data: { teamId: 'ENG' } } }).code, 'BAD_IDENTITY');
  });
});
