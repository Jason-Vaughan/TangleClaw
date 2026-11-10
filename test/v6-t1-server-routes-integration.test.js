'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const { handleRequest } = require('../server');

// v6 Stage 1 (BRIDGE-2, Car V60-T1-W2-ROUTES): the first live HTTP wiring for
// lib/v6/c1-logical-projects.js (#2118), lib/v6/e5-kaizen-ledger.js (#2980),
// lib/v6/sprint-report-validator-v3.js (#2979), lib/v6/authority-service.js
// (#1149), lib/v6/transition-ledger.js (#2977), and
// lib/v6/incident-registry.js (#2978). Driven through the REAL request
// handler (server.js#handleRequest), same harness as
// test/api-add-login.test.js, so the launch-binding floor and
// operatorProjectCaller gate this PR actually wires are what the test
// exercises — not a re-implementation of them.

describe('v6 Stage 1 server routes (#2118, #2980, #2979, BRIDGE-2)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-t1-w2-routes-'));
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
   * Drive one request through the real handler, as the dashboard operator
   * by default (`x-tangleclaw-client: dashboard`, the gate stood down by
   * `authEnabled: false` above) — every route this file covers is
   * operator-only. Pass `operator: false` for a caller the floor itself
   * must refuse before any route-specific check runs.
   * @param {string} method
   * @param {string} url
   * @param {{body?: object, headers?: object, operator?: boolean}} [opts]
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

  const post = (url, body, opts) => send('POST', url, Object.assign({ body: body || {} }, opts));
  const patch = (url, body, opts) => send('PATCH', url, Object.assign({ body: body || {} }, opts));
  const put = (url, body, opts) => send('PUT', url, Object.assign({ body: body || {} }, opts));
  const get = (url, opts) => send('GET', url, opts);
  const json = (res) => JSON.parse(res.body);

/**
   * Create a REAL signed-in operator session (a user row + an auth_sessions
   * row, same facts a real login would mint — `session.token_hash`/
   * `username`/`csrfToken`), for g1-approvals' own in-handler session
   * resolution (`req.tcSession || _gateIdentity(...).session`, Ruling
   * A550-R2-SUPPLEMENT-PRRA-P08-COSIGN). Deliberately does NOT arm the
   * gate: `_gateIdentity` resolves a valid cookie regardless of
   * `authEnabled`, so this proves the fallback itself, under the same
   * `authEnabled: false` every other test here runs under.
   * @param {string} username
   * @returns {{cookie: string, headers: Record<string, string>}} `opts` fields for {@link send}.
   */
  function signInOperator(username) {
    const user = store.users.create(username, 'correct-horse-battery');
    const { token, csrfToken } = store.authSessions.create(user);
    return { cookie: `tc_session=${token}`, headers: { [authSession.CSRF_HEADER]: csrfToken } };
  }

  describe('launch-binding floor: every mutating route here refuses a non-operator caller', () => {
    it('refuses POST /api/v6/logical-projects with no bound caller', async () => {
      const res = await post('/api/v6/logical-projects', { displayName: 'X', origin: 'native' }, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });

    it('refuses PATCH /api/v6/kaizen/items/:id/state with no bound caller', async () => {
      const res = await patch('/api/v6/kaizen/items/does-not-matter/state', { nextState: 'Classified' }, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });
  });

  describe('C1 logical-project hierarchy routes', () => {
    it('creates a logical project, reads it back, and changes its state', async () => {
      const create = await post('/api/v6/logical-projects', { displayName: 'Native Project', origin: 'native' });
      assert.equal(create.statusCode, 201, create.body);
      const { id } = json(create);
      assert.ok(id);

      const read = await get(`/api/v6/logical-projects/${id}`);
      assert.equal(read.statusCode, 200);
      assert.equal(json(read).display_name, 'Native Project');

      const archive = await patch(`/api/v6/logical-projects/${id}/state`, { nextState: 'archived' });
      assert.equal(archive.statusCode, 200, archive.body);
      assert.equal(json(await get(`/api/v6/logical-projects/${id}`)).state, 'archived');
    });

    it('404s reading an unknown logical project', async () => {
      const res = await get('/api/v6/logical-projects/lp-missing');
      assert.equal(res.statusCode, 404);
    });

    it('400s an invalid create (bad origin)', async () => {
      const res = await post('/api/v6/logical-projects', { displayName: 'X', origin: 'bogus' });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUEST');
    });

    it('creates a fleet, reads it, and walks its CAS-guarded state', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Fleet Owner', origin: 'native' }));
      const create = await post('/api/v6/fleets', { logicalProjectId: projectId, displayName: 'Fleet One' });
      assert.equal(create.statusCode, 201, create.body);
      const { id: fleetId } = json(create);

      assert.equal(json(await get(`/api/v6/fleets/${fleetId}`)).state, 'draft');

      const activate = await patch(`/api/v6/fleets/${fleetId}/state`, { logicalProjectId: projectId, nextState: 'active', expectedPolicyRevision: 1 });
      assert.equal(activate.statusCode, 200, activate.body);
      assert.equal(json(activate).policyRevision, 2);

      const staleRetry = await patch(`/api/v6/fleets/${fleetId}/state`, { logicalProjectId: projectId, nextState: 'paused', expectedPolicyRevision: 1 });
      assert.equal(staleRetry.statusCode, 409, staleRetry.body);
      assert.equal(json(staleRetry).code, 'STALE_POLICY_REVISION');
    });

    it('refuses a duplicate fleet display name within one project with 409', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Dup Owner', origin: 'native' }));
      assert.equal((await post('/api/v6/fleets', { logicalProjectId: projectId, displayName: 'Dup' })).statusCode, 201);
      const dup = await post('/api/v6/fleets', { logicalProjectId: projectId, displayName: 'Dup' });
      assert.equal(dup.statusCode, 409, dup.body);
      assert.equal(json(dup).code, 'DISPLAY_NAME_TAKEN');
    });

    it('creates a resource, reads it, and walks its CAS-guarded desired_state', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Resource Owner', origin: 'native' }));
      const create = await post('/api/v6/resources', { logicalProjectId: projectId, kind: 'harness', displayName: 'Res One' });
      assert.equal(create.statusCode, 201, create.body);
      const { id: resourceId } = json(create);
      assert.equal(json(await get(`/api/v6/resources/${resourceId}`)).desired_state, 'available');

      const reserve = await patch(`/api/v6/resources/${resourceId}/state`, { logicalProjectId: projectId, nextState: 'reserved', expectedRowVersion: 1 });
      assert.equal(reserve.statusCode, 200, reserve.body);

      const invalid = await patch(`/api/v6/resources/${resourceId}/state`, { logicalProjectId: projectId, nextState: 'retired', expectedRowVersion: 2 });
      assert.equal(invalid.statusCode, 409, invalid.body);
      assert.equal(json(invalid).code, 'INVALID_TRANSITION');
    });

    it('creates a checkout and changes its state', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Checkout Owner', origin: 'native' }));
      const create = await post('/api/v6/checkouts', { logicalProjectId: projectId, absolutePath: '/tmp/v6-route-checkout', kind: 'worktree' });
      assert.equal(create.statusCode, 201, create.body);
      const { id: checkoutId } = json(create);
      const retire = await patch(`/api/v6/checkouts/${checkoutId}/state`, { logicalProjectId: projectId, nextState: 'retired' });
      assert.equal(retire.statusCode, 200, retire.body);
    });

    it('refuses a duplicate absolute_path with 409', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Dup Path Owner', origin: 'native' }));
      assert.equal((await post('/api/v6/checkouts', { logicalProjectId: projectId, absolutePath: '/tmp/v6-dup-path', kind: 'clone' })).statusCode, 201);
      const dup = await post('/api/v6/checkouts', { logicalProjectId: projectId, absolutePath: '/tmp/v6-dup-path', kind: 'clone' });
      assert.equal(dup.statusCode, 409, dup.body);
      assert.equal(json(dup).code, 'ABSOLUTE_PATH_TAKEN');
    });

    it('proposes a role lease and closes it', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Lease Owner', origin: 'native' }));
      const { id: resourceId } = json(await post('/api/v6/resources', { logicalProjectId: projectId, kind: 'harness', displayName: 'R' }));
      const create = await post('/api/v6/role-leases', {
        resourceId, logicalProjectId: projectId, roleKey: 'builder', domainKey: 'lib/**', issuedByPrincipal: 'operator'
      });
      assert.equal(create.statusCode, 201, create.body);
      const { id: leaseId } = json(create);
      const close = await post(`/api/v6/role-leases/${leaseId}/close`, { resourceId, outcome: 'ended' });
      assert.equal(close.statusCode, 200, close.body);
    });

    it('refuses a second live lease on the same resource with 409 ROLE_CONFLICT', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Conflict Owner', origin: 'native' }));
      const { id: resourceId } = json(await post('/api/v6/resources', { logicalProjectId: projectId, kind: 'harness', displayName: 'R' }));
      await post('/api/v6/role-leases', { resourceId, logicalProjectId: projectId, roleKey: 'builder', domainKey: 'lib/**', issuedByPrincipal: 'operator' });
      const second = await post('/api/v6/role-leases', { resourceId, logicalProjectId: projectId, roleKey: 'reviewer', domainKey: 'lib/**', issuedByPrincipal: 'operator' });
      assert.equal(second.statusCode, 409, second.body);
      assert.equal(json(second).code, 'ROLE_CONFLICT');
    });

    it('creates a shared asset, grants access, and revokes it', async () => {
      const { id: owner } = json(await post('/api/v6/logical-projects', { displayName: 'Asset Owner', origin: 'native' }));
      const { id: grantee } = json(await post('/api/v6/logical-projects', { displayName: 'Asset Grantee', origin: 'native' }));
      const asset = await post('/api/v6/shared-assets', { ownerProjectId: owner, kind: 'plan', displayName: 'Plan', canonicalRef: 'plan.md' });
      assert.equal(asset.statusCode, 201, asset.body);
      const { id: assetId } = json(asset);
      const grant = await post('/api/v6/asset-grants', { assetId, granteeProjectId: grantee, access: 'read', grantedByPrincipal: 'operator' });
      assert.equal(grant.statusCode, 201, grant.body);
      const revoke = await post(`/api/v6/asset-grants/${json(grant).id}/revoke`, { assetId });
      assert.equal(revoke.statusCode, 200, revoke.body);
    });

    it('mints and revokes an authority grant', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Grant Owner', origin: 'native' }));
      const mint = await post('/api/v6/authority-grants', {
        principal: 'tc-lane-d', logicalProjectId: projectId, operation: 'settings.write',
        expectedPolicyRevision: 1, issuedByPrincipal: 'operator'
      });
      assert.equal(mint.statusCode, 201, mint.body);
      const revoke = await post(`/api/v6/authority-grants/${json(mint).id}/revoke`, { logicalProjectId: projectId });
      assert.equal(revoke.statusCode, 200, revoke.body);
    });

    it('reads the full hierarchy for a logical project', async () => {
      const { id: projectId } = json(await post('/api/v6/logical-projects', { displayName: 'Hierarchy Owner', origin: 'native' }));
      await post('/api/v6/fleets', { logicalProjectId: projectId, displayName: 'F' });
      const res = await get(`/api/v6/logical-projects/${projectId}/hierarchy`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).fleets.length, 1);
    });

    it('reads a legacy project\'s v6 mapping', async () => {
      store.getDb().exec(`INSERT INTO projects (name, path, archived) VALUES ('legacy-route-test', '${path.join(tempDir, 'legacy-route-test')}', 0)`);
      const legacyId = store.getDb().prepare("SELECT id FROM projects WHERE name = 'legacy-route-test'").get().id;
      const res = await get(`/api/v6/legacy-projects/${legacyId}`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).legacy_name, 'legacy-route-test');
    });
  });

  describe('E5 Kaizen Ledger routes', () => {
    /** Create an item and advance it to Implemented, returning its id. */
    async function implementedItem(verificationClass = 'A_DETERMINISTIC') {
      const create = await post('/api/v6/kaizen/items', {
        originSprint: 'v1', findingId: `f-${Date.now()}-${Math.random()}`, defectCategory: 'test-gap',
        rootCause: 'r', correctiveActionSpec: 'a', ownerRole: 'builder', verificationClass, targetMetric: 'm'
      });
      assert.equal(create.statusCode, 201, create.body);
      const { id } = json(create);
      for (const nextState of ['Classified', 'Proposed', 'Approved', 'Assigned', 'Implemented']) {
        const r = await patch(`/api/v6/kaizen/items/${id}/state`, { nextState });
        assert.equal(r.statusCode, 200, `${nextState}: ${r.body}`);
      }
      return id;
    }

    it('detects an item and reads it back', async () => {
      const create = await post('/api/v6/kaizen/items', {
        originSprint: 'v1', findingId: 'f-detect', defectCategory: 'c', rootCause: 'r',
        correctiveActionSpec: 'a', ownerRole: 'builder', verificationClass: 'A_DETERMINISTIC', targetMetric: 'm'
      });
      assert.equal(create.statusCode, 201, create.body);
      const { id } = json(create);
      const read = await get(`/api/v6/kaizen/items/${id}`);
      assert.equal(json(read).lifecycle_state, 'Detected');
    });

    it('refuses recording a measurement before the item is Implemented', async () => {
      const create = await post('/api/v6/kaizen/items', {
        originSprint: 'v1', findingId: 'f-pre-impl', defectCategory: 'c', rootCause: 'r',
        correctiveActionSpec: 'a', ownerRole: 'builder', verificationClass: 'A_DETERMINISTIC', targetMetric: 'm'
      });
      const { id } = json(create);
      const res = await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(json(res).code, 'PRE_IMPLEMENTATION_MEASUREMENT');
    });

    it('records a measurement once Implemented, and lists it back', async () => {
      const id = await implementedItem();
      const record = await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
      assert.equal(record.statusCode, 201, record.body);
      const list = await get(`/api/v6/kaizen/items/${id}/measurements`);
      assert.equal(json(list).length, 1);
    });

    it('evaluate-effectiveness dry-runs without mutating, PATCH .../state commits via markProvenEffective (Charter A512 checklist g)', async () => {
      const id = await implementedItem();
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Verified' });

      const before = await post(`/api/v6/kaizen/items/${id}/evaluate-effectiveness`);
      assert.equal(before.statusCode, 409, before.body);
      assert.equal(json(before).code, 'INSUFFICIENT_EVIDENCE');
      assert.equal(json(await get(`/api/v6/kaizen/items/${id}`)).lifecycle_state, 'Verified', 'dry-run must not mutate');

      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'regression_test', passed: true, evidenceRef: 'test/x.test.js' });
      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });

      const after = await post(`/api/v6/kaizen/items/${id}/evaluate-effectiveness`);
      assert.equal(after.statusCode, 200, after.body);

      // CRITICAL: PATCH .../state with nextState 'Effectiveness Measured' must
      // dispatch to markProvenEffective, not bypass the proof rules.
      const commit = await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Effectiveness Measured' });
      assert.equal(commit.statusCode, 200, commit.body);
      const item = json(await get(`/api/v6/kaizen/items/${id}`));
      assert.equal(item.lifecycle_state, 'Effectiveness Measured');
      assert.equal(item.effectiveness_status, 'PROVEN_EFFECTIVE');
    });

    it('PATCH .../state with nextState Effectiveness Measured refuses (via markProvenEffective) when the proof rules are not yet met', async () => {
      const id = await implementedItem();
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Verified' });
      const res = await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Effectiveness Measured' });
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(json(res).code, 'INSUFFICIENT_EVIDENCE');
    });

    it('PATCH .../state with nextState Closed dispatches to closeItem', async () => {
      const id = await implementedItem();
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Verified' });
      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'regression_test', passed: true, evidenceRef: 'x' });
      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Effectiveness Measured' });
      const close = await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Closed' });
      assert.equal(close.statusCode, 200, close.body);
      assert.equal(json(await get(`/api/v6/kaizen/items/${id}`)).lifecycle_state, 'Closed');
    });

    it('marks a proven item regressed', async () => {
      const id = await implementedItem();
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Verified' });
      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'regression_test', passed: true, evidenceRef: 'x' });
      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Effectiveness Measured' });
      const regress = await post(`/api/v6/kaizen/items/${id}/mark-regressed`);
      assert.equal(regress.statusCode, 200, regress.body);
      assert.equal(json(await get(`/api/v6/kaizen/items/${id}`)).effectiveness_status, 'REGRESSED');
    });

    it('refuses marking a CLOSED item regressed with 409 (PRR-B R1): it must never become invisible to gate0-feed', async () => {
      const id = await implementedItem();
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Verified' });
      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'regression_test', passed: true, evidenceRef: 'x' });
      await post(`/api/v6/kaizen/items/${id}/measurements`, { sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Effectiveness Measured' });
      await patch(`/api/v6/kaizen/items/${id}/state`, { nextState: 'Closed' });
      const regress = await post(`/api/v6/kaizen/items/${id}/mark-regressed`);
      assert.equal(regress.statusCode, 409, regress.body);
      assert.equal(json(regress).code, 'INVALID_TRANSITION');
      assert.equal(json(await get(`/api/v6/kaizen/items/${id}`)).effectiveness_status, 'PROVEN_EFFECTIVE', 'a refused mark-regressed must not have mutated anything');
    });

    it('sets a Gate 0 disposition, requiring a rationale for deferred_with_rationale', async () => {
      const create = await post('/api/v6/kaizen/items', {
        originSprint: 'v1', findingId: 'f-gate0', defectCategory: 'c', rootCause: 'r',
        correctiveActionSpec: 'a', ownerRole: 'builder', verificationClass: 'A_DETERMINISTIC', targetMetric: 'm'
      });
      const { id } = json(create);
      const missingRationale = await post(`/api/v6/kaizen/items/${id}/gate0-disposition`, { disposition: 'deferred_with_rationale' });
      assert.equal(missingRationale.statusCode, 400, missingRationale.body);
      const ok = await post(`/api/v6/kaizen/items/${id}/gate0-disposition`, { disposition: 'deferred_with_rationale', rationale: 'blocked on #123' });
      assert.equal(ok.statusCode, 200, ok.body);
    });

    it('feeds every open item through gate0-feed, and excludes a Closed one', async () => {
      const openCreate = await post('/api/v6/kaizen/items', {
        originSprint: 'v1', findingId: 'f-feed-open', defectCategory: 'c', rootCause: 'r',
        correctiveActionSpec: 'a', ownerRole: 'builder', verificationClass: 'A_DETERMINISTIC', targetMetric: 'm'
      });
      const { id: openId } = json(openCreate);
      const feed = await get('/api/v6/kaizen/gate0-feed');
      assert.equal(feed.statusCode, 200, feed.body);
      assert.ok(json(feed).some((item) => item.id === openId));
    });
  });

  describe('Sprint Report Validator v3 route', () => {
    function reportHtml(metrics) {
      return `<!doctype html><html><body>
        <script type="application/json" id="tc-canonical-metrics">${JSON.stringify(metrics)}</script>
      </body></html>`;
    }

    it('validates a clean report and returns ok: true', async () => {
      const html = reportHtml({
        schema_version: '3.0.0', version: 'v1',
        diff: { feature_prs_merged: 1, release_prs_merged: 0, total_repo_prs_merged: 1 },
        durations: { total_run_time_display: '1h 00m 00s' },
        scope_taxonomy: { github_feature_issues_closed: 1, chartered_execution_cars_completed: 1, milestone_issues_deferred_external_gated: 0 },
        release_state: ['code_merged_on_main'],
        economics: { measured_tokens: 1, estimated_tokens: 1, subscription_allocated_cost_usd: 1, api_shadow_cost_usd: 1 },
        provenance: { generated_at: 'x', verified_at: 'x', canonical_source_sha256: 'x', git_main_head_sha: 'x', validator_version: '3.0.0' }
      });
      const res = await post('/api/v6/sprint-reports/validate', { html });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).ok, true);
    });

    it('refuses a missing html field with 400', async () => {
      const res = await post('/api/v6/sprint-reports/validate', {});
      assert.equal(res.statusCode, 400, res.body);
    });

    it('answers ok: false (still HTTP 200) for a report missing its canonical-metrics anchor', async () => {
      const res = await post('/api/v6/sprint-reports/validate', { html: '<html><body>nothing</body></html>' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).ok, false);
      assert.ok(json(res).findings.some((f) => f.code === 'CANONICAL_METRICS_MISSING'));
    });
  });

  describe('Authority Service routes (#1149) — via the lazy service-principal bootstrap', () => {
    /** @returns {Promise<number>} A fresh legacy project id. */
    async function seedProject(name) {
      store.getDb().exec(`INSERT INTO projects (name, path, archived) VALUES ('${name}', '${path.join(tempDir, name)}', 0)`);
      return store.getDb().prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
    }

    it('backfills, reads, and writes a policy, CAS-guarded', async () => {
      const projectId = await seedProject('auth-route-project');
      const backfill = await post(`/api/v6/projects/${projectId}/authority/backfill`);
      assert.equal(backfill.statusCode, 201, backfill.body);
      assert.equal(json(backfill).code, 'IMPORTED');

      const read = await get(`/api/v6/projects/${projectId}/authority/fleetCoordinator`);
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(json(read).value, false);

      const write = await put(`/api/v6/projects/${projectId}/authority/fleetCoordinator`, { value: true, expectedVersion: 1 });
      assert.equal(write.statusCode, 200, write.body);
      assert.equal(json(write).rowVersion, 2);

      const stale = await put(`/api/v6/projects/${projectId}/authority/fleetCoordinator`, { value: false, expectedVersion: 1 });
      assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(json(stale).code, 'STALE_POLICY');
    });

    it('404s a policy read against an unbackfilled key, and 400s an unregistered setting', async () => {
      const projectId = await seedProject('auth-no-backfill');
      const res = await get(`/api/v6/projects/${projectId}/authority/fleetCoordinator`);
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(json(res).code, 'POLICY_MISSING');

      const bogus = await get(`/api/v6/projects/${projectId}/authority/not-a-real-setting`);
      assert.equal(bogus.statusCode, 400, bogus.body);
      assert.equal(json(bogus).code, 'UNREGISTERED_SETTING');
    });

    it('reads authority drift as an empty array for a project with no legacy file', async () => {
      const projectId = await seedProject('auth-drift-project');
      await post(`/api/v6/projects/${projectId}/authority/backfill`);
      const res = await get(`/api/v6/projects/${projectId}/authority-drift`);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res).drift, []);
    });

    it('mints and revokes a G1 lease', async () => {
      const projectId = await seedProject('g1-lease-project');
      const mint = await post(`/api/v6/projects/${projectId}/g1-leases`, { actor: 'tc-lane-c', repo: 'TangleClaw', connectionEpoch: 1, actions: ['read'], ttlMs: 60000 });
      assert.equal(mint.statusCode, 201, mint.body);
      const { id } = json(mint);
      const revoke = await post(`/api/v6/projects/${projectId}/g1-leases/${id}/revoke`);
      assert.equal(revoke.statusCode, 200, revoke.body);
      const revokeAgain = await post(`/api/v6/projects/${projectId}/g1-leases/${id}/revoke`);
      assert.equal(revokeAgain.statusCode, 404, revokeAgain.body);
    });

    it('mints and revokes a G1 approval from a DISTINCT operator, recording the REAL signed-in operator as operatorActor, never the body claim (PRR-A R1)', async () => {
      const projectId = await seedProject('g1-approval-project');
      const lease = await post(`/api/v6/projects/${projectId}/g1-leases`,
        { actor: 'tc-lane-c', repo: 'TangleClaw', connectionEpoch: 1, actions: ['read'], ttlMs: 60000 });
      assert.equal(lease.statusCode, 201, lease.body);
      const signedIn = signInOperator('rosie-g1-test');
      const mint = await post(`/api/v6/projects/${projectId}/g1-approvals`,
        { operatorActor: 'someone-else-entirely', action: 'merge', repo: 'TangleClaw', targetDigest: 'abc123', ttlMs: 60000 },
        signedIn);
      assert.equal(mint.statusCode, 201, mint.body);
      const row = store.getDb().prepare('SELECT operator_actor FROM v6_g1_approvals WHERE id = ?').get(json(mint).id);
      assert.equal(row.operator_actor, 'rosie-g1-test', 'the real signed-in session, not the body claim, must be recorded');
      const revoke = await post(`/api/v6/projects/${projectId}/g1-approvals/${json(mint).id}/revoke`, {}, signedIn);
      assert.equal(revoke.statusCode, 200, revoke.body);
    });

    it('refuses a G1 approval mint with no signed-in operator session, even from an otherwise-admitted gate-stood-down caller', async () => {
      const projectId = await seedProject('g1-approval-no-session');
      const res = await post(`/api/v6/projects/${projectId}/g1-approvals`, { operatorActor: 'x', action: 'merge', repo: 'r', targetDigest: 'd', ttlMs: 1000 });
      assert.ok([401, 403].includes(res.statusCode), res.body);
      assert.equal(json(res).code, 'SIGNED_IN_OPERATOR_REQUIRED');
    });

    it('refuses a G1 approval mint by the SAME operator who minted the underlying lease (P08 distinct-operator, Ruling A550-R2-SUPPLEMENT-PRRA-P08-COSIGN)', async () => {
      const projectId = await seedProject('g1-approval-p08-same-operator');
      const signedIn = signInOperator('same-operator-x');
      const lease = await post(`/api/v6/projects/${projectId}/g1-leases`,
        { actor: 'same-operator-x', repo: 'TangleClaw', connectionEpoch: 1, actions: ['read'], ttlMs: 60000 });
      assert.equal(lease.statusCode, 201, lease.body);
      const mint = await post(`/api/v6/projects/${projectId}/g1-approvals`,
        { action: 'merge', repo: 'TangleClaw', targetDigest: 'abc123', ttlMs: 60000 },
        signedIn);
      assert.equal(mint.statusCode, 403, mint.body);
      assert.equal(json(mint).code, 'DISTINCT_OPERATOR_REQUIRED');
    });

    it('refuses a G1 approval mint when a SECOND active lease for the same project/repo shares the signed-in actor, even though it is not the first one minted (PRR-A R3 HOLD counterexample)', async () => {
      const projectId = await seedProject('g1-approval-p08-second-lease');
      const first = await post(`/api/v6/projects/${projectId}/g1-leases`,
        { actor: 'other-operator', repo: 'TangleClaw', connectionEpoch: 1, actions: ['read'], ttlMs: 60000 });
      assert.equal(first.statusCode, 201, first.body);
      const second = await post(`/api/v6/projects/${projectId}/g1-leases`,
        { actor: 'rosie-g1-test-2', repo: 'TangleClaw', connectionEpoch: 1, actions: ['read'], ttlMs: 60000 });
      assert.equal(second.statusCode, 201, second.body);
      const signedIn = signInOperator('rosie-g1-test-2');
      const mint = await post(`/api/v6/projects/${projectId}/g1-approvals`,
        { action: 'merge', repo: 'TangleClaw', targetDigest: 'abc123', ttlMs: 60000 },
        signedIn);
      assert.equal(mint.statusCode, 403, mint.body);
      assert.equal(json(mint).code, 'DISTINCT_OPERATOR_REQUIRED');
    });

    it('404s an authority route against a project that does not exist, rather than throwing on the trust-bootstrap FK (PRR-A R1 / Ruling A549)', async () => {
      const res = await put('/api/v6/projects/999999/authority/fleetCoordinator', { value: true, expectedVersion: 1 });
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(json(res).code, 'PROJECT_NOT_FOUND');
    });

    it('refuses the launch-binding floor and the operator gate for a non-operator caller', async () => {
      const projectId = await seedProject('auth-refuse-project');
      const res = await put(`/api/v6/projects/${projectId}/authority/fleetCoordinator`, { value: true, expectedVersion: 1 }, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });
  });

  describe('Transition Ledger & Reconciler routes (#2977)', () => {
    async function seedProjectAndResource(projectName, resourceId) {
      store.getDb().exec(`INSERT INTO projects (name, path, archived) VALUES ('${projectName}', '${path.join(tempDir, projectName)}', 0)`);
      const projectId = store.getDb().prepare('SELECT id FROM projects WHERE name = ?').get(projectName).id;
      store.getDb().prepare('INSERT INTO runtime_resources (id, project_id, generation) VALUES (?,?,0)').run(resourceId, projectId);
      return projectId;
    }

    it('begins and settles a transition (committed)', async () => {
      const projectId = await seedProjectAndResource('transition-project', 'res-t1');
      const begin = await post(`/api/v6/projects/${projectId}/transitions`, { resourceId: 'res-t1', action: 'start', expectedGeneration: 0, key: 'k1' });
      assert.equal(begin.statusCode, 201, begin.body);
      const { id } = json(begin);
      const settle = await post(`/api/v6/projects/${projectId}/transitions/${id}/settle`, {
        state: 'committed', evidence: { source: 'test', observedAt: new Date().toISOString() }
      });
      assert.equal(settle.statusCode, 200, settle.body);
      assert.equal(json(settle).code, 'COMMITTED');
    });

    it('refuses settling without evidence with 400', async () => {
      const projectId = await seedProjectAndResource('transition-no-evidence', 'res-t2');
      const begin = await post(`/api/v6/projects/${projectId}/transitions`, { resourceId: 'res-t2', action: 'start', expectedGeneration: 0, key: 'k1' });
      const settle = await post(`/api/v6/projects/${projectId}/transitions/${json(begin).id}/settle`, { state: 'committed' });
      assert.equal(settle.statusCode, 400, settle.body);
      assert.equal(json(settle).code, 'EVIDENCE_REQUIRED');
    });

    it('refuses a second begin against an in-flight transition with 409', async () => {
      const projectId = await seedProjectAndResource('transition-in-flight', 'res-t3');
      await post(`/api/v6/projects/${projectId}/transitions`, { resourceId: 'res-t3', action: 'start', expectedGeneration: 0, key: 'k1' });
      const second = await post(`/api/v6/projects/${projectId}/transitions`, { resourceId: 'res-t3', action: 'start', expectedGeneration: 0, key: 'k2' });
      assert.equal(second.statusCode, 409, second.body);
      assert.equal(json(second).code, 'IN_FLIGHT');
    });

    it('reconciles from caller-submitted observations and persists findings', async () => {
      const projectId = await seedProjectAndResource('reconcile-project', 'res-r1');
      const res = await post(`/api/v6/projects/${projectId}/reconcile`, {
        resource: { id: 'res-r1' },
        observations: { sqlite: { status: 'ok', active: false } }
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      assert.equal(body.safe, false); // tmux/git/ports/medusa all unknown — not a clean reconciliation
      assert.ok(body.findings.length > 0);
      assert.equal(body.written, body.findings.length);
    });

    it('400s a reconcile request missing resource.id', async () => {
      const projectId = await seedProjectAndResource('reconcile-bad-request', 'res-r2');
      const res = await post(`/api/v6/projects/${projectId}/reconcile`, {});
      assert.equal(res.statusCode, 400, res.body);
    });
  });

  describe('Incident & Recovery Registry routes (#2978)', () => {
    async function seedProject(name) {
      store.getDb().exec(`INSERT INTO projects (name, path, archived) VALUES ('${name}', '${path.join(tempDir, name)}', 0)`);
      return store.getDb().prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
    }

    it('a healthy report against a fingerprint with no prior incident creates nothing', async () => {
      const projectId = await seedProject('incident-healthy-project');
      const res = await post(`/api/v6/projects/${projectId}/incidents`, { fingerprint: 'fp-healthy', generation: 1, action: 'noop', health: 'healthy' });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(json(res).code, 'HEALTHY_NO_ACTION');
      assert.equal(json(res).id, null);
    });

    it('an unhealthy report opens an incident and records an unverified attempt', async () => {
      const projectId = await seedProject('incident-unhealthy-project');
      const res = await post(`/api/v6/projects/${projectId}/incidents`, { fingerprint: 'fp-unhealthy', generation: 1, action: 'restart', health: 'unhealthy' });
      // step() returns ok: false for an unverified attempt (no `verification`
      // was submitted) -- the write itself succeeded (an incident now exists),
      // so _v6Respond's non-2xx response must still carry that incident's id,
      // not just {error, code}.
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(json(res).code, 'ATTEMPT_FAILED');
      assert.ok(json(res).id, 'the incident id must survive a non-2xx v6 response');
    });

    it('refuses a RESERVED action outright with 403', async () => {
      const projectId = await seedProject('incident-reserved-project');
      const res = await post(`/api/v6/projects/${projectId}/incidents`, { fingerprint: 'fp-reserved', generation: 1, action: 'kill', health: 'unhealthy' });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, 'RESERVED_ACTION');
    });
  });
});
