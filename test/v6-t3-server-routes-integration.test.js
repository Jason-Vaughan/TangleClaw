'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const { handleRequest } = require('../server');

// v6 Train 3 (BRIDGE-2c, Car V60-T3-W2-ROUTES): live HTTP wiring for
// lib/v6/e1-project-charter-lifecycle.js (#2126),
// lib/v6/e4-rich-report-presentation.js (#2988),
// lib/v6/e6a-report-search-indexer.js (#2989), and
// lib/v6/g1-github-integration.js / lib/providers/contract.js (#2990).
// Driven through the REAL request handler (server.js#handleRequest), the
// same harness test/v6-t1-server-routes-integration.test.js and
// test/v6-t2-server-routes-integration.test.js use.

describe('v6 Train 3 server routes (#2126, #2988, #2989, #2990, BRIDGE-2c)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-t3-w2-routes-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const cfg = store.config.load();
    cfg.setupComplete = true;
    cfg.ingressMode = 'direct';
    cfg.authEnabled = false;
    store.config.save(cfg);
  });

  function mockRes() {
    return {
      statusCode: 0,
      body: '',
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
      },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
  }

  /**
   * Drive one JSON-body request through the real handler, as the
   * dashboard operator by default. Pass `operator: false` for a caller
   * the launch-binding floor must refuse before any route-specific check
   * runs; `cookie`/`headers` for a real signed-in operator session (see
   * {@link signInOperator}).
   * @param {string} method
   * @param {string} url
   * @param {{body?: object, headers?: object, cookie?: string, operator?: boolean}} [opts]
   * @returns {Promise<object>} The mock response
   */
  async function send(method, url, opts = {}) {
    const raw = opts.body === undefined ? null : JSON.stringify(opts.body);
    const operatorHeaders = opts.operator === false ? {} : { 'x-tangleclaw-client': 'dashboard' };
    const headers = Object.assign({ host: 'localhost:3102' }, operatorHeaders, opts.headers);
    if (opts.cookie) headers.cookie = opts.cookie;
    if (raw !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(raw));
    }
    const req = {
      url, method, headers,
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'data' && raw !== null) cb(Buffer.from(raw));
        if (event === 'end') cb();
      }
    };
    const res = mockRes();
    await handleRequest(req, res);
    return res;
  }

  /**
   * Drive the raw-byte webhook ingress path specifically — it reads
   * `for await (const chunk of req)`, not the `.on('data', cb)` shape
   * {@link send}'s mock req uses, since `_handleGithubWebhook` is handled
   * OUTSIDE the generic parseBody()/route() dispatch on purpose (exact
   * HMAC bytes, strict UTF-8).
   * @param {Buffer} rawBodyBuf
   * @param {Record<string, string>} [headers]
   * @returns {Promise<object>}
   */
  async function sendWebhook(rawBodyBuf, headers = {}, { remoteAddress = '127.0.0.1' } = {}) {
    const req = {
      url: '/api/v6/webhooks/github', method: 'POST',
      headers: Object.assign({ host: 'localhost:3102' }, headers),
      socket: { remoteAddress },
      [Symbol.asyncIterator]: async function* () { yield rawBodyBuf; }
    };
    const res = mockRes();
    await handleRequest(req, res);
    return res;
  }

  /**
   * Stub `globalThis.fetch` for the duration of `fn`, so a route's own
   * server-side GitHub probe (`_v6ProbeGithubConnection`) or outbound
   * write (`g1-github-integration.js#execute`) never reaches the real
   * network. Always restores the original, even if `fn` throws.
   * @param {Function} impl
   * @param {() => Promise<*>} fn
   * @returns {Promise<*>}
   */
  async function withStubbedFetch(impl, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  /** A `GET /repos/{repo}` stub reporting push+pull (never admin) access, the shape `_v6ProbeGithubConnection` reads. */
  function githubRepoProbeStub(repo, perms = { pull: true, push: true, admin: false }, { scopes = 'repo', isPrivate = true, hasIssues = true, expirationHeader = null } = {}) {
    return async () => ({
      status: 200,
      // PRR-B 04561f29 (Round 4 item 1): the real route now requires
      // authoritative scope evidence before granting issues/PR/contents
      // write from `perms.push` alone — a classic `x-oauth-scopes: repo`
      // header is exactly that evidence, so the default stub carries one.
      headers: {
        get: (name) => {
          const n = name.toLowerCase();
          if (n === 'x-oauth-scopes') return scopes;
          if (n === 'github-authentication-token-expiration') return expirationHeader;
          return null;
        }
      },
      json: async () => ({ full_name: repo, private: isPrivate, has_issues: hasIssues, permissions: perms })
    });
  }

  /**
   * A paired `GET /repos/{repo}` + `GET /app/installations/{id}` stub for
   * the no-`X-OAuth-Scopes` ("app"-kind token) probe path -- GitHub's
   * documented installation-permission strings live only on the second
   * endpoint (Architect Ruling A613 item 2 / PRR-B b9633ffb).
   */
  function githubAppProbeStub(repo, instPerms, { repoPerms = { pull: true, push: false, admin: false }, hasIssues = true, instStatus = 200 } = {}) {
    return async (url) => {
      if (typeof url === 'string' && url.includes('/app/installations/')) {
        return { status: instStatus, headers: { get: () => null }, json: async () => ({ permissions: instPerms }) };
      }
      // No `x-oauth-scopes` header at all -- this is what identifies the
      // app-kind path rather than a classic PAT.
      return {
        status: 200, headers: { get: () => null },
        json: async () => ({ full_name: repo, private: true, has_issues: hasIssues, permissions: repoPerms })
      };
    };
  }

  const post = (url, body, opts) => send('POST', url, Object.assign({ body: body || {} }, opts));
  const get = (url, opts) => send('GET', url, opts);
  const del = (url, opts) => send('DELETE', url, opts);
  const json = (res) => JSON.parse(res.body);

  async function seedProject(name) {
    store.getDb().exec(`INSERT INTO projects (name, path, archived) VALUES ('${name}', '${path.join(tempDir, name)}', 0)`);
    return store.getDb().prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
  }

  /**
   * A REAL signed-in operator session (a user row + an auth_sessions row),
   * the same pattern test/v6-t1-server-routes-integration.test.js
   * established for g1-approvals/g1-leases' own session resolution.
   * @param {string} username
   * @returns {{cookie: string, headers: Record<string, string>}}
   */
  function signInOperator(username) {
    const user = store.users.create(username, 'correct-horse-battery');
    const { token, csrfToken } = store.authSessions.create(user);
    return { cookie: `tc_session=${token}`, headers: { [authSession.CSRF_HEADER]: csrfToken } };
  }

  describe('launch-binding floor: every mutating route here refuses a non-operator caller', () => {
    it('refuses POST charter with no bound caller', async () => {
      const res = await post('/api/v6/projects/1/charter', { content: { title: 't' } }, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });

    it('refuses POST github/binding with no bound caller', async () => {
      const res = await post('/api/v6/projects/1/github/binding', { repo: 'a/b' }, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });
  });

  describe('E1: Native Project Charter Lifecycle routes (#2126)', () => {
    it('404s every charter route for a project that does not exist', async () => {
      const res = await post('/api/v6/projects/999999/charter', { content: { title: 't' } }, signInOperator('charter-404-test'));
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(json(res).code, 'PROJECT_NOT_FOUND');
    });

    it('refuses to create a charter with no signed-in operator session', async () => {
      const projectId = await seedProject('charter-no-session');
      const res = await post(`/api/v6/projects/${projectId}/charter`, { content: { title: 't' } });
      assert.ok([401, 403].includes(res.statusCode), res.body);
      assert.equal(json(res).code, 'SIGNED_IN_OPERATOR_REQUIRED');
    });

    it('full lifecycle: create -> active is null -> approve from 2 distinct sessions -> activate -> export -> drift-check -> supersede', async () => {
      const projectId = await seedProject('charter-lifecycle');
      const creator = signInOperator('charter-creator');

      const created = await post(`/api/v6/projects/${projectId}/charter`,
        { content: { title: 'Alpha Charter', purposeAndBusinessCase: 'Ship it', coreTeam: ['alice'] } }, creator);
      assert.equal(created.statusCode, 201, created.body);
      const { versionId } = json(created);

      const createdRow = store.getDb().prepare('SELECT created_by FROM v6_project_charter_versions WHERE id = ?').get(versionId);
      assert.equal(createdRow.created_by, 'charter-creator', 'actor is the real signed-in session, never a body claim');

      const active1 = await get(`/api/v6/projects/${projectId}/charter/active`);
      assert.equal(active1.statusCode, 404, 'nothing is active until activateCharter runs');

      const sponsor = signInOperator('charter-sponsor');
      const pm = signInOperator('charter-pm');
      const approve1 = await post(`/api/v6/projects/${projectId}/charter/versions/${versionId}/approvals`, { approverRole: 'sponsor' }, sponsor);
      assert.equal(approve1.statusCode, 201, approve1.body);
      const approve2 = await post(`/api/v6/projects/${projectId}/charter/versions/${versionId}/approvals`, { approverRole: 'pm' }, pm);
      assert.equal(approve2.statusCode, 201, approve2.body);

      const approvalRow = store.getDb().prepare('SELECT approver_actor FROM v6_project_charter_approvals WHERE version_id = ? AND approver_role = ?').get(versionId, 'sponsor');
      assert.equal(approvalRow.approver_actor, 'charter-sponsor', 'approverActor is the real signed-in session, never a body claim');

      const complete = await get(`/api/v6/projects/${projectId}/charter/versions/${versionId}/approvals/complete`);
      assert.equal(complete.statusCode, 200, complete.body);
      assert.equal(json(complete).complete, true);

      const activated = await post(`/api/v6/projects/${projectId}/charter/versions/${versionId}/activate`, {});
      assert.equal(activated.statusCode, 200, activated.body);

      const active2 = await get(`/api/v6/projects/${projectId}/charter/active`);
      assert.equal(active2.statusCode, 200, active2.body);
      assert.equal(json(active2).content.title, 'Alpha Charter');

      const summary = await get(`/api/v6/projects/${projectId}/charter/startup-summary`);
      assert.equal(summary.statusCode, 200, summary.body);
      assert.equal(json(summary).title, 'Alpha Charter');

      const exported = await get(`/api/v6/projects/${projectId}/charter/export`);
      assert.equal(exported.statusCode, 200, exported.body);
      assert.match(json(exported).markdown, /# Alpha Charter/);

      const drift = await post(`/api/v6/projects/${projectId}/charter/drift-check`, { actual: { coreTeam: ['bob'] } });
      assert.equal(drift.statusCode, 200, drift.body);
      assert.equal(json(drift).drift, true);
      assert.ok(json(drift).missing.includes('alice'));

      const revoke = await del(`/api/v6/projects/${projectId}/charter/versions/${versionId}/approvals/pm`, pm);
      assert.equal(revoke.statusCode, 200, revoke.body);
      const activeAfterRevoke = await get(`/api/v6/projects/${projectId}/charter/active`);
      assert.equal(activeAfterRevoke.statusCode, 404, 'revoking the active version\'s own sign-off deactivates it immediately');

      const supersede = await post(`/api/v6/projects/${projectId}/charter/supersede`, {});
      assert.equal(supersede.statusCode, 200, supersede.body);

      const afterSupersede = await get(`/api/v6/projects/${projectId}/charter`);
      assert.equal(json(afterSupersede).charter.status, 'superseded');
    });

    it('400s approvals/complete for an unknown requiredRoles entry, rather than serving INVALID_REQUIRED_ROLES as a 200 (Ruling A609-PR3020-R1-HOLD item 2)', async () => {
      const projectId = await seedProject('charter-complete-bad-roles');
      const creator = signInOperator('charter-complete-bad-roles-op');
      const created = await post(`/api/v6/projects/${projectId}/charter`, { content: { title: 't' } }, creator);
      const { versionId } = json(created);
      const res = await get(`/api/v6/projects/${projectId}/charter/versions/${versionId}/approvals/complete?requiredRoles=auditor`);
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUIRED_ROLES');
    });

    it('404s approvals/complete for a versionId that belongs to a DIFFERENT project\'s charter (Ruling A609-PR3020-R1-HOLD item 2)', async () => {
      const projectA = await seedProject('charter-complete-cross-a');
      const projectB = await seedProject('charter-complete-cross-b');
      const opA = signInOperator('charter-complete-cross-op-a');
      const opB = signInOperator('charter-complete-cross-op-b');
      const createdA = await post(`/api/v6/projects/${projectA}/charter`, { content: { title: 'a' } }, opA);
      await post(`/api/v6/projects/${projectB}/charter`, { content: { title: 'b' } }, opB);
      const { versionId: versionIdFromA } = json(createdA);

      // Ask project B's route about project A's own version id.
      const res = await get(`/api/v6/projects/${projectB}/charter/versions/${versionIdFromA}/approvals/complete`);
      assert.equal(res.statusCode, 404, res.body);
    });
  });

  describe('E4/E6a: Rich Report Presentation & Search Indexer routes (#2988, #2989)', () => {
    const sampleHtml = (() => {
      let html = '<html><body>';
      for (const id of ['overview', 'architecture', 'velocity', 'deliverables', 'telemetry', 'postmortem',
        'waves', 'next-sprint', 'plain-english', 'retro', 'longitudinal', 'governance']) {
        html += `<section id="${id}">Narrative text for ${id}, mentioning PR #3016 and KR-01.</section>`;
      }
      return `${html}</body></html>`;
    })();

    it('builds a presentation view-model with 12 sections grouped into 3 pillars', async () => {
      const res = await post('/api/v6/reports/present', { html: sampleHtml });
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      assert.equal(body.sections.length, 12);
      assert.equal(Object.keys(body.pillars).length, 3);
    });

    it('400s present/print-view/search-index when html is not a string', async () => {
      assert.equal((await post('/api/v6/reports/present', {})).statusCode, 400);
      assert.equal((await post('/api/v6/reports/print-view', {})).statusCode, 400);
      assert.equal((await post('/api/v6/reports/search-index', {})).statusCode, 400);
    });

    it('reads the static popover catalog', async () => {
      const res = await get('/api/v6/reports/popovers');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(Object.keys(json(res).popovers).length, 12);
    });

    it('builds a print view carrying the print stylesheet', async () => {
      const res = await post('/api/v6/reports/print-view', { html: sampleHtml });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(json(res).html, /data-e4-print/);
    });

    it('builds a search index and cites a PR number with a typed hit', async () => {
      const indexRes = await post('/api/v6/reports/search-index', { html: sampleHtml, version: 'v1.0.0' });
      assert.equal(indexRes.statusCode, 200, indexRes.body);
      const index = json(indexRes);
      assert.equal(index.sections.length, 12);

      const citeRes = await post('/api/v6/reports/cite', { index, query: '3016' });
      assert.equal(citeRes.statusCode, 200, citeRes.body);
      const results = json(citeRes).results;
      assert.ok(results.some((r) => r.type === 'pr' && r.badge === '[PR #3016]'));
    });
  });

  describe('G1/G2a: GitHub Integration, Outbox & Provider Contract routes (#2990)', () => {
    it('reads the GitHub provider capabilities', async () => {
      const res = await get('/api/v6/providers/github/capabilities');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).provider, 'github');
      assert.equal(json(res).actions.createIssue.tier, 2);
    });

    it('binds a project to a repo, then reads it back with secret_ref (never a secret value) exposed', async () => {
      const projectId = await seedProject('g1-binding');
      const bind = await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets', installationId: 42, secretRef: 'vault:gh-token' });
      assert.equal(bind.statusCode, 201, bind.body);
      const read = await get(`/api/v6/projects/${projectId}/github/binding`);
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(json(read).secret_ref, 'vault:gh-token');
    });

    it('400s a binding with a malformed repo before any db write', async () => {
      const projectId = await seedProject('g1-bad-binding');
      const res = await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'not-a-repo', installationId: 1, secretRef: 'vault:x' });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(store.getDb().prepare('SELECT 1 FROM v6_bindings WHERE project_id = ?').get(projectId), undefined);
    });

    it('sets a connection using the BINDING\'s own installationId/secretRef and a SERVER-PROBED identity/fingerprint, ignoring any caller-supplied ones', async () => {
      const projectId = await seedProject('g1-connection');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-conn', installationId: 42, secretRef: 'vault:gh-token' });
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        const conn = await withStubbedFetch(githubRepoProbeStub('acme/widgets-conn'), () => post(`/api/v6/projects/${projectId}/github/connection`, {
          epoch: 1, approvedTiers: [2],
          // Forged claims: a real admin grant, a spoofed identity, and a
          // caller-chosen fingerprint — none of this may reach storage.
          identity: 'spoofed-identity', expectedFingerprint: 'spoofed-fingerprint',
          probe: { identity: 'spoofed-identity', kind: 'app', permissions: ['administration:write'], repositories: ['acme/widgets-conn'], expiresAt: Date.now() + 99999 }
        }));
        assert.equal(conn.statusCode, 201, conn.body);
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
      const read = await get(`/api/v6/projects/${projectId}/github/connection`);
      assert.equal(json(read).connection.installationId, 42);
      assert.equal(json(read).connection.tokenRef, 'vault:gh-token');
      assert.equal(json(read).connection.identity, 'acme/widgets-conn', 'identity is the SERVER-probed repo full_name, never the caller\'s claim');
      assert.notEqual(json(read).connection.expectedFingerprint, 'spoofed-fingerprint');
      assert.ok(!json(read).probe.permissions.includes('administration:write'), 'a caller-claimed admin grant the real probe (pull+push only) never reported must never reach storage');
    });

    it('perms.push: true ALONE, with no x-oauth-scopes: repo and no explicit fine-grained write field, never grants issues:write/pull_requests:write/contents:write (PRR-B 04561f29 Round 4 item 1)', async () => {
      const projectId = await seedProject('g1-connection-push-only');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-pushonly', installationId: 42, secretRef: 'vault:gh-token' });
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        // push: true, but NO x-oauth-scopes header and no explicit
        // issues/pull_requests/contents field -- a fine-grained token
        // shape with an unrelated `push` grant, not classic repo scope.
        const noScopeStub = async () => ({
          status: 200, headers: { get: () => null },
          json: async () => ({ full_name: 'acme/widgets-pushonly', private: true, permissions: { pull: true, push: true, admin: false } })
        });
        const conn = await withStubbedFetch(noScopeStub, () =>
          post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }));
        assert.equal(conn.statusCode, 201, conn.body);
        const read = await get(`/api/v6/projects/${projectId}/github/connection`);
        assert.ok(!json(read).probe.permissions.includes('issues:write'), 'push alone, with no scope evidence, must not imply issues:write');
        assert.ok(!json(read).probe.permissions.includes('pull_requests:write'));
        assert.ok(!json(read).probe.permissions.includes('contents:write'));
        assert.ok(json(read).probe.permissions.includes('contents:read'), 'pull: true still grants read');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('classic push+repo-scope never grants issues:write when the repo has its issue tracker disabled (Architect Ruling A612 item 1)', async () => {
      const projectId = await seedProject('g1-connection-no-issue-tracker');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-noissues', installationId: 42, secretRef: 'vault:gh-token' });
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        // Full classic write evidence (push: true, x-oauth-scopes: repo)
        // -- but has_issues: false means there is no tracker to write to.
        const conn = await withStubbedFetch(githubRepoProbeStub('acme/widgets-noissues', { pull: true, push: true, admin: false }, { hasIssues: false }), () =>
          post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }));
        assert.equal(conn.statusCode, 201, conn.body);
        const read = await get(`/api/v6/projects/${projectId}/github/connection`);
        assert.ok(!json(read).probe.permissions.includes('issues:write'), 'has_issues: false must veto issues:write even with full classic push+scope evidence');
        assert.ok(json(read).probe.permissions.includes('pull_requests:write'), 'pull_requests:write is unaffected by the issue-tracker toggle');
        assert.ok(json(read).probe.permissions.includes('contents:write'));
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('derives write permissions from GitHub App installation permissions when no X-OAuth-Scopes header is present (Architect Ruling A613 item 2)', async () => {
      const projectId = await seedProject('g1-connection-app-kind');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-app', installationId: 777, secretRef: 'vault:gh-token' });
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        const conn = await withStubbedFetch(
          githubAppProbeStub('acme/widgets-app', { contents: 'write', issues: 'write', pull_requests: 'write', administration: 'admin' }),
          () => post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2, 3] }));
        assert.equal(conn.statusCode, 201, conn.body);
        const read = await get(`/api/v6/projects/${projectId}/github/connection`);
        assert.equal(json(read).probe.kind, 'app');
        assert.ok(json(read).probe.permissions.includes('contents:write'));
        assert.ok(json(read).probe.permissions.includes('issues:write'));
        assert.ok(json(read).probe.permissions.includes('pull_requests:write'));
        assert.ok(json(read).probe.permissions.includes('administration:write'));
        assert.ok(json(read).probe.permissions.includes('contents:read'), 'perms.pull on the repo response still grants read');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('fails closed (PROBE_UNAVAILABLE) when no X-OAuth-Scopes header is present and GET /app/installations/:id does not return a usable permissions object (Architect Ruling A613 item 2)', async () => {
      const projectId = await seedProject('g1-connection-app-kind-fails');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-app-fail', installationId: 778, secretRef: 'vault:gh-token' });
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        // perms.push: true but no x-oauth-scopes header, and the
        // installation endpoint itself 404s -- there is no authoritative
        // source left, so this must fail closed rather than fall back to
        // perms.push alone.
        const conn = await withStubbedFetch(
          githubAppProbeStub('acme/widgets-app-fail', {}, { repoPerms: { pull: true, push: true, admin: false }, instStatus: 404 }),
          () => post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }));
        assert.equal(conn.statusCode, 503, conn.body);
        assert.equal(json(conn).code, 'PROBE_UNAVAILABLE');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('caps probe.expiresAt at 5 minutes even when github-authentication-token-expiration reports a token valid for days (Architect Ruling A613 item 1)', async () => {
      const projectId = await seedProject('g1-connection-ttl-cap');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-ttlcap', installationId: 42, secretRef: 'vault:gh-token' });
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
        const conn = await withStubbedFetch(
          githubRepoProbeStub('acme/widgets-ttlcap', { pull: true, push: true, admin: false }, { expirationHeader: sevenDaysOut }),
          () => post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }));
        assert.equal(conn.statusCode, 201, conn.body);
        const read = await get(`/api/v6/projects/${projectId}/github/connection`);
        assert.ok(json(read).probe.expiresAt <= Date.now() + 5 * 60 * 1000, 'a 5-minute probe TTL cap applies regardless of how long the token itself is valid for');
        assert.ok(json(read).probe.expiresAt > Date.now(), 'the capped expiry is still in the future, not already expired');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('re-probes once the capped 5-minute probe window elapses even though the token itself still reports days of life left, and still detects permission drift (Architect Ruling A613 item 1)', async () => {
      const projectId = await seedProject('g1-connection-ttl-cap-drift');
      const operator = signInOperator('g1-ttl-cap-drift-operator');
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
        await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-ttlcap-drift', installationId: 42, secretRef: 'vault:gh-token' }, operator);
        const connRes = await withStubbedFetch(
          githubRepoProbeStub('acme/widgets-ttlcap-drift', { pull: true, push: true, admin: false }, { expirationHeader: sevenDaysOut }),
          () => post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }, operator));
        assert.equal(connRes.statusCode, 201, connRes.body);
        const lease = await post(`/api/v6/projects/${projectId}/g1-leases`,
          { repo: 'acme/widgets-ttlcap-drift', connectionEpoch: 1, actions: ['createIssue'], ttlMs: 99999 }, operator);
        const leaseId = json(lease).id;

        // The token's own 7-day life is irrelevant here: the probe's
        // capped 5-minute TTL is what elapsed, as if admission is
        // attempted several minutes later.
        const row = store.getDb().prepare('SELECT probe_json FROM v6_github_connections WHERE project_id = ?').get(projectId);
        const staleProbe = { ...JSON.parse(row.probe_json), expiresAt: Date.now() - 1000 };
        store.getDb().prepare('UPDATE v6_github_connections SET probe_json = ? WHERE project_id = ?')
          .run(JSON.stringify(staleProbe), projectId);

        // GitHub's own access was revoked since the original probe, but
        // the token itself still reports the same far-future expiration
        // header.
        const admit = await withStubbedFetch(
          githubRepoProbeStub('acme/widgets-ttlcap-drift', { pull: true, push: false, admin: false }, { expirationHeader: sevenDaysOut }),
          () => post(`/api/v6/projects/${projectId}/github/outbox/admit`,
            { action: 'createIssue', idempotencyKey: 'k-ttlcap-drift', leaseId, draft: { title: 'hello', body: 'world' } }, operator));
        assert.equal(admit.statusCode, 403, admit.body);
        assert.equal(json(admit).code, 'SCOPE_DRIFT', 'the capped TTL forced a re-probe despite the token-reported expiry still being days away, and the re-probe caught the real permission downgrade');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('refuses CONNECTION_INVALID when epoch/approvedTiers are missing or malformed, before any probe or write (Ruling A609/A610 item 3)', async () => {
      const projectId = await seedProject('g1-connection-bad-payload');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-badpayload', installationId: 42, secretRef: 'vault:gh-token' });
      let fetchCalls = 0;
      await withStubbedFetch(async (...args) => { fetchCalls++; return githubRepoProbeStub('acme/widgets-badpayload')(...args); }, async () => {
        const missingEpoch = await post(`/api/v6/projects/${projectId}/github/connection`, { approvedTiers: [2] });
        assert.equal(missingEpoch.statusCode, 400, missingEpoch.body);
        assert.equal(json(missingEpoch).code, 'CONNECTION_INVALID');

        const zeroEpoch = await post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 0, approvedTiers: [2] });
        assert.equal(zeroEpoch.statusCode, 400, zeroEpoch.body);

        const missingTiers = await post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1 });
        assert.equal(missingTiers.statusCode, 400, missingTiers.body);

        const badTier = await post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [4] });
        assert.equal(badTier.statusCode, 400, badTier.body);
      });
      assert.equal(fetchCalls, 0, 'validation must refuse before the server-side probe ever runs');
      assert.equal(store.getDb().prepare('SELECT 1 FROM v6_github_connections WHERE project_id = ?').get(projectId), undefined, 'nothing was ever stored');
    });

    it('refuses CREDENTIAL_UNAVAILABLE when the bound secret_ref has no real secret, before any probe runs', async () => {
      const projectId = await seedProject('g1-connection-no-secret');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-nosecret', installationId: 42, secretRef: 'vault:does-not-exist' });
      let fetchCalls = 0;
      const res = await withStubbedFetch(async () => { fetchCalls++; return { status: 200, json: async () => ({}) }; }, () =>
        post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }));
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(json(res).code, 'CREDENTIAL_UNAVAILABLE');
      assert.equal(fetchCalls, 0);
    });

    it('refuses PROBE_UNAVAILABLE when the GitHub API itself denies the bound credential', async () => {
      const projectId = await seedProject('g1-connection-probe-fails');
      await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-probefail', installationId: 42, secretRef: 'vault:gh-token' });
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        const res = await withStubbedFetch(async () => ({ status: 401, json: async () => ({ message: 'Bad credentials' }) }), () =>
          post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }));
        assert.equal(res.statusCode, 503, res.body);
        assert.equal(json(res).code, 'PROBE_UNAVAILABLE');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('refuses a connection when no binding exists yet', async () => {
      const projectId = await seedProject('g1-connection-no-binding');
      const res = await post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] });
      assert.equal(res.statusCode, 404, res.body);
    });

    it('lists an empty milestone set for a project with none bound', async () => {
      const projectId = await seedProject('g1-no-milestones');
      const res = await get(`/api/v6/projects/${projectId}/github/milestones`);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res).milestones, []);
    });

    it('refuses an outbox admit with no signed-in operator session', async () => {
      const projectId = await seedProject('g1-outbox-no-session');
      const res = await post(`/api/v6/projects/${projectId}/github/outbox/admit`, { action: 'createIssue', idempotencyKey: 'k', draft: { title: 't' } });
      assert.ok([401, 403].includes(res.statusCode), res.body);
      assert.equal(json(res).code, 'SIGNED_IN_OPERATOR_REQUIRED');
    });

    it('previews an admission without writing an outbox row, then executes it for real with a stubbed fetch', async () => {
      const projectId = await seedProject('g1-outbox-full');
      const operator = signInOperator('g1-outbox-operator');
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-outbox', installationId: 42, secretRef: 'vault:gh-token' }, operator);
        const connRes = await withStubbedFetch(githubRepoProbeStub('acme/widgets-outbox'), () =>
          post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }, operator));
        assert.equal(connRes.statusCode, 201, connRes.body);
        const lease = await post(`/api/v6/projects/${projectId}/g1-leases`,
          { repo: 'acme/widgets-outbox', connectionEpoch: 1, actions: ['createIssue'], ttlMs: 99999 }, operator);
        assert.equal(lease.statusCode, 201, lease.body);
        const leaseId = json(lease).id;

        const admit = await post(`/api/v6/projects/${projectId}/github/outbox/admit`,
          { action: 'createIssue', idempotencyKey: 'k1', leaseId, draft: { title: 'hello', body: 'world' } }, operator);
        assert.equal(admit.statusCode, 200, admit.body);
        assert.equal(json(admit).ok, true);
        assert.equal('token' in json(admit), false, 'the resolved plaintext credential must never reach the response body (Ruling A609-PR3020-R1-HOLD item 1)');
        assert.equal(store.getDb().prepare('SELECT 1 FROM v6_g1_outbox WHERE project_id = ?').get(projectId), undefined, 'admit writes nothing');

        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ status: 201, json: async () => ({ number: 9, html_url: 'https://github.com/acme/widgets-outbox/issues/9' }) });
        try {
          const executed = await post(`/api/v6/projects/${projectId}/github/outbox`,
            { action: 'createIssue', idempotencyKey: 'k1', leaseId, draft: { title: 'hello', body: 'world' } }, operator);
          assert.equal(executed.statusCode, 201, executed.body);
          assert.equal(json(executed).code, 'CREATED');
        } finally {
          globalThis.fetch = realFetch;
        }

        const row = await get(`/api/v6/projects/${projectId}/github/outbox/k1`);
        assert.equal(row.statusCode, 200, row.body);
        assert.equal(json(row).state, 'succeeded');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('re-probes and persists a fresh connection probe when the stored one has expired, before admitting (PRR-B 04561f29 Round 4 item 2)', async () => {
      const projectId = await seedProject('g1-outbox-probe-refresh');
      const operator = signInOperator('g1-probe-refresh-operator');
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-refresh', installationId: 42, secretRef: 'vault:gh-token' }, operator);
        const connRes = await withStubbedFetch(githubRepoProbeStub('acme/widgets-refresh'), () =>
          post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }, operator));
        assert.equal(connRes.statusCode, 201, connRes.body);
        const lease = await post(`/api/v6/projects/${projectId}/g1-leases`,
          { repo: 'acme/widgets-refresh', connectionEpoch: 1, actions: ['createIssue'], ttlMs: 99999 }, operator);
        const leaseId = json(lease).id;

        // Force the stored probe to read as expired, as if >5 minutes had
        // genuinely passed since it was last probed.
        const row = store.getDb().prepare('SELECT probe_json FROM v6_github_connections WHERE project_id = ?').get(projectId);
        const staleProbe = { ...JSON.parse(row.probe_json), expiresAt: Date.now() - 1000 };
        store.getDb().prepare('UPDATE v6_github_connections SET probe_json = ? WHERE project_id = ?')
          .run(JSON.stringify(staleProbe), projectId);

        let fetchCalls = 0;
        const admit = await withStubbedFetch(async (...args) => { fetchCalls++; return githubRepoProbeStub('acme/widgets-refresh')(...args); }, () =>
          post(`/api/v6/projects/${projectId}/github/outbox/admit`,
            { action: 'createIssue', idempotencyKey: 'k-refresh', leaseId, draft: { title: 'hello', body: 'world' } }, operator));
        assert.equal(admit.statusCode, 200, admit.body);
        assert.equal(json(admit).ok, true, 'admission succeeds because the expired probe was refreshed first');
        assert.equal(fetchCalls, 1, 'exactly one re-probe call was made');

        const refreshedRow = store.getDb().prepare('SELECT probe_json FROM v6_github_connections WHERE project_id = ?').get(projectId);
        assert.ok(JSON.parse(refreshedRow.probe_json).expiresAt > Date.now(), 'the stale probe was persisted as refreshed, not left stale');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('fails closed (stale PROBE_EXPIRED) when the stored probe is expired AND the re-probe attempt itself fails', async () => {
      const projectId = await seedProject('g1-outbox-probe-refresh-fails');
      const operator = signInOperator('g1-probe-refresh-fail-operator');
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-refresh-fail', installationId: 42, secretRef: 'vault:gh-token' }, operator);
        await withStubbedFetch(githubRepoProbeStub('acme/widgets-refresh-fail'), () =>
          post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }, operator));
        const lease = await post(`/api/v6/projects/${projectId}/g1-leases`,
          { repo: 'acme/widgets-refresh-fail', connectionEpoch: 1, actions: ['createIssue'], ttlMs: 99999 }, operator);
        const leaseId = json(lease).id;

        const row = store.getDb().prepare('SELECT probe_json FROM v6_github_connections WHERE project_id = ?').get(projectId);
        const staleProbe = { ...JSON.parse(row.probe_json), expiresAt: Date.now() - 1000 };
        store.getDb().prepare('UPDATE v6_github_connections SET probe_json = ? WHERE project_id = ?')
          .run(JSON.stringify(staleProbe), projectId);

        // The re-probe attempt itself fails (GitHub unreachable/rejects).
        const admit = await withStubbedFetch(async () => { throw new Error('network down'); }, () =>
          post(`/api/v6/projects/${projectId}/github/outbox/admit`,
            { action: 'createIssue', idempotencyKey: 'k-refresh-fail', leaseId, draft: { title: 'hello', body: 'world' } }, operator));
        assert.equal(admit.statusCode, 403, admit.body);
        assert.equal(json(admit).code, 'PROBE_EXPIRED', 'fails closed on the still-stale probe rather than fabricating a fresh one');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });

    it('detects SCOPE_DRIFT when a re-probe of an expired connection comes back with fewer permissions than were approved (Architect Ruling A612 item 2)', async () => {
      const projectId = await seedProject('g1-outbox-probe-refresh-drift');
      const operator = signInOperator('g1-probe-refresh-drift-operator');
      process.env.TC_VAULT_GH_TOKEN = 'x'.repeat(20);
      try {
        await post(`/api/v6/projects/${projectId}/github/binding`, { repo: 'acme/widgets-drift', installationId: 42, secretRef: 'vault:gh-token' }, operator);
        const connRes = await withStubbedFetch(githubRepoProbeStub('acme/widgets-drift'), () =>
          post(`/api/v6/projects/${projectId}/github/connection`, { epoch: 1, approvedTiers: [2] }, operator));
        assert.equal(connRes.statusCode, 201, connRes.body);
        const lease = await post(`/api/v6/projects/${projectId}/g1-leases`,
          { repo: 'acme/widgets-drift', connectionEpoch: 1, actions: ['createIssue'], ttlMs: 99999 }, operator);
        const leaseId = json(lease).id;

        const row = store.getDb().prepare('SELECT probe_json FROM v6_github_connections WHERE project_id = ?').get(projectId);
        const staleProbe = { ...JSON.parse(row.probe_json), expiresAt: Date.now() - 1000 };
        store.getDb().prepare('UPDATE v6_github_connections SET probe_json = ? WHERE project_id = ?')
          .run(JSON.stringify(staleProbe), projectId);

        // GitHub's own access was revoked/downgraded since the original
        // probe (push: false now) -- the re-probe succeeds (fresh
        // expiresAt), so this must surface as SCOPE_DRIFT, not PROBE_EXPIRED.
        const admit = await withStubbedFetch(githubRepoProbeStub('acme/widgets-drift', { pull: true, push: false, admin: false }), () =>
          post(`/api/v6/projects/${projectId}/github/outbox/admit`,
            { action: 'createIssue', idempotencyKey: 'k-refresh-drift', leaseId, draft: { title: 'hello', body: 'world' } }, operator));
        assert.equal(admit.statusCode, 403, admit.body);
        assert.equal(json(admit).code, 'SCOPE_DRIFT', 'a refreshed probe with fewer permissions than connection.expectedFingerprint recorded must fail closed, not silently re-approve itself');

        const refreshedRow = store.getDb().prepare('SELECT probe_json FROM v6_github_connections WHERE project_id = ?').get(projectId);
        assert.ok(JSON.parse(refreshedRow.probe_json).expiresAt > Date.now(), 'probe_json was still refreshed even though it then fails the drift check');
      } finally {
        delete process.env.TC_VAULT_GH_TOKEN;
      }
    });
  });

  describe('POST /api/v6/webhooks/github (#2990 webhook ingress, PRR-A f6ad8229 UTF-8 guard)', () => {
    it('verifies signature and records a new delivery', async () => {
      const projectId = await seedProject('g1-webhook-project');
      store.getDb().prepare('INSERT INTO v6_bindings (project_id, repo, installation_id, secret_ref) VALUES (?, ?, ?, ?)')
        .run(projectId, 'acme/widgets-wh', 777, 'vault:webhook-secret');
      process.env.TC_VAULT_WEBHOOK_SECRET = 'y'.repeat(20);
      try {
        const payload = JSON.stringify({ repository: { full_name: 'acme/widgets-wh' }, installation: { id: 777 } });
        const sig = `sha256=${crypto.createHmac('sha256', 'y'.repeat(20)).update(payload).digest('hex')}`;
        const res = await sendWebhook(Buffer.from(payload), {
          'content-type': 'application/json', 'x-github-delivery': 'd-1', 'x-github-event': 'pull_request', 'x-hub-signature-256': sig
        });
        assert.equal(res.statusCode, 202, res.body);
        assert.equal(JSON.parse(res.body).duplicate, false);
      } finally {
        delete process.env.TC_VAULT_WEBHOOK_SECRET;
      }
    });

    it('400s INVALID_UTF8 for an invalid byte sequence, before ever reading v6_bindings', async () => {
      const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x7d]); // {"a":<invalid bytes>}
      const res = await sendWebhook(invalidUtf8, {
        'x-github-delivery': 'd-2', 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=irrelevant'
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(JSON.parse(res.body).code, 'INVALID_UTF8');
    });

    it('refuses an unbound repo/installation with REPO_NOT_BOUND', async () => {
      const payload = JSON.stringify({ repository: { full_name: 'nobody/here' }, installation: { id: 1 } });
      const res = await sendWebhook(Buffer.from(payload), {
        'x-github-delivery': 'd-3', 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=irrelevant'
      });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(JSON.parse(res.body).code, 'REPO_NOT_BOUND');
    });

    it('refuses a bad signature for an otherwise-bound repo', async () => {
      const projectId = await seedProject('g1-webhook-bad-sig');
      store.getDb().prepare('INSERT INTO v6_bindings (project_id, repo, installation_id, secret_ref) VALUES (?, ?, ?, ?)')
        .run(projectId, 'acme/badsig', 888, 'vault:badsig-secret');
      process.env.TC_VAULT_BADSIG_SECRET = 'z'.repeat(20);
      try {
        const payload = JSON.stringify({ repository: { full_name: 'acme/badsig' }, installation: { id: 888 } });
        const res = await sendWebhook(Buffer.from(payload), {
          'x-github-delivery': 'd-4', 'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000'
        });
        assert.equal(res.statusCode, 403, res.body);
        assert.equal(JSON.parse(res.body).code, 'BAD_SIGNATURE');
      } finally {
        delete process.env.TC_VAULT_BADSIG_SECRET;
      }
    });

    it('reaches the webhook handler from a remote, proxied, signed-out caller even while the auth gate is ARMED (PRR-A 5039bb93, Ruling A610 item 2)', async () => {
      store.users.create('webhook-armed-gate-user', 'correct-horse-battery');
      const cfg = store.config.load();
      cfg.authEnabled = true;
      cfg.basicAuthUser = null;
      cfg.basicAuthHash = null;
      store.config.save(cfg);

      const projectId = await seedProject('g1-webhook-armed');
      store.getDb().prepare('INSERT INTO v6_bindings (project_id, repo, installation_id, secret_ref) VALUES (?, ?, ?, ?)')
        .run(projectId, 'acme/widgets-armed', 999, 'vault:armed-secret');
      process.env.TC_VAULT_ARMED_SECRET = 'q'.repeat(20);
      try {
        const payload = JSON.stringify({ repository: { full_name: 'acme/widgets-armed' }, installation: { id: 999 } });
        const sig = `sha256=${crypto.createHmac('sha256', 'q'.repeat(20)).update(payload).digest('hex')}`;
        // A real GitHub delivery: no tc_session cookie, a non-loopback
        // remote address (behind the real reverse proxy), and the
        // X-Forwarded-For header a proxy adds -- none of which carry any
        // TangleClaw identity, since HMAC is this request's ENTIRE
        // authentication.
        const res = await sendWebhook(Buffer.from(payload), {
          'content-type': 'application/json', 'x-github-delivery': 'd-armed-1', 'x-github-event': 'pull_request',
          'x-hub-signature-256': sig, 'x-forwarded-for': '203.0.113.7'
        }, { remoteAddress: '203.0.113.7' });
        assert.equal(res.statusCode, 202, res.body);
        assert.equal(JSON.parse(res.body).ok, true);
      } finally {
        delete process.env.TC_VAULT_ARMED_SECRET;
      }
    });

    it('preserves a leading UTF-8 BOM through decode so HMAC verifies against the exact bytes received (PRR-A 5039bb93)', async () => {
      const projectId = await seedProject('g1-webhook-bom');
      store.getDb().prepare('INSERT INTO v6_bindings (project_id, repo, installation_id, secret_ref) VALUES (?, ?, ?, ?)')
        .run(projectId, 'acme/widgets-bom', 1000, 'vault:bom-secret');
      process.env.TC_VAULT_BOM_SECRET = 'b'.repeat(20);
      try {
        const payloadText = JSON.stringify({ repository: { full_name: 'acme/widgets-bom' }, installation: { id: 1000 } });
        const rawWithBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payloadText)]);
        // Signed over the EXACT bytes GitHub would have sent, BOM included.
        const sig = `sha256=${crypto.createHmac('sha256', 'b'.repeat(20)).update(rawWithBom).digest('hex')}`;
        const res = await sendWebhook(rawWithBom, {
          'content-type': 'application/json', 'x-github-delivery': 'd-bom-1', 'x-github-event': 'pull_request', 'x-hub-signature-256': sig
        });
        // The BOM is stripped for JSON parsing only; the signature is
        // verified against `rawText` BOM intact -- the exact bytes
        // actually signed. A BOM genuinely dropped before hashing (the
        // bug this test exists to catch) would make this signature
        // verification fail instead, since it was computed over 3 MORE
        // bytes than a BOM-stripped hash would cover.
        assert.equal(res.statusCode, 202, res.body);
        assert.equal(JSON.parse(res.body).ok, true);
      } finally {
        delete process.env.TC_VAULT_BOM_SECRET;
      }
    });

    it('challenges with 401 when the gate is LOCKED, unlike an ARMED gate which admits the same signed delivery (PRR-B 04561f29 Round 4 item 3)', async () => {
      // This test runs last in the file: every earlier test's signed-in
      // operator left a live, enabled account behind, so disabling only a
      // freshly-created one would leave the install still ARMED. Disable
      // every account that exists so far instead, so `loginable` is
      // actually false -- the one fact that distinguishes LOCKED from ARMED.
      store.users.create('webhook-locked-gate-user', 'correct-horse-battery');
      for (const user of store.users.list()) {
        store.users.disable(user.username);
      }
      const cfg = store.config.load();
      cfg.authEnabled = true;
      cfg.basicAuthUser = null;
      cfg.basicAuthHash = null;
      store.config.save(cfg);

      assert.equal(store.authSessions.accountPresence().loginable, false, 'every account is disabled, so the gate reads LOCKED, not ARMED');

      const projectId = await seedProject('g1-webhook-locked');
      store.getDb().prepare('INSERT INTO v6_bindings (project_id, repo, installation_id, secret_ref) VALUES (?, ?, ?, ?)')
        .run(projectId, 'acme/widgets-locked', 1001, 'vault:locked-secret');
      process.env.TC_VAULT_LOCKED_SECRET = 'l'.repeat(20);
      try {
        const payload = JSON.stringify({ repository: { full_name: 'acme/widgets-locked' }, installation: { id: 1001 } });
        const sig = `sha256=${crypto.createHmac('sha256', 'l'.repeat(20)).update(payload).digest('hex')}`;
        // Same well-formed, correctly-HMAC-signed, remote, non-browser
        // delivery shape that admits under ARMED above -- the only
        // difference is gate state, which must be the sole reason this
        // one is refused before ever reaching the webhook handler.
        const res = await sendWebhook(Buffer.from(payload), {
          'content-type': 'application/json', 'x-github-delivery': 'd-locked-1', 'x-github-event': 'pull_request',
          'x-hub-signature-256': sig, 'x-forwarded-for': '203.0.113.7'
        }, { remoteAddress: '203.0.113.7' });
        assert.equal(res.statusCode, 401, res.body);
      } finally {
        delete process.env.TC_VAULT_LOCKED_SECRET;
      }
    });
  });
});
