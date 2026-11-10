'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { handleRequest } = require('../server');

// v6 Stage 1 (BRIDGE-2, Car V60-T1-W2-ROUTES): the first live HTTP wiring for
// lib/v6/c1-logical-projects.js (#2118), lib/v6/e5-kaizen-ledger.js (#2980),
// and lib/v6/sprint-report-validator-v3.js (#2979). Driven through the REAL
// request handler (server.js#handleRequest), same harness as
// test/api-add-login.test.js, so the launch-binding floor and
// operatorProjectCaller gate this PR actually wires are what the test
// exercises — not a re-implementation of them.
//
// Routes for lib/v6/authority-service.js, lib/v6/transition-ledger.js, and
// lib/v6/incident-registry.js are deferred (see server.js's own comment at
// the "V6 Stage 1 Routes" section) and have no tests here.

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
  const get = (url, opts) => send('GET', url, opts);
  const json = (res) => JSON.parse(res.body);

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
});
