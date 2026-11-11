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
  function githubRepoProbeStub(repo, perms = { pull: true, push: true, admin: false }) {
    return async () => ({ status: 200, json: async () => ({ full_name: repo, permissions: perms }) });
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
  });
});
