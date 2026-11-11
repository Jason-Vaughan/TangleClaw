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
const vm = require('node:vm');
const a2b = require('../lib/v6/a2b-self-healing-remediator');

/**
 * Load the real shipped public/v6-shell.js into a fresh sandbox, the same
 * way test/v6-b1-ui-shell.test.js does.
 * @returns {object} The sandbox, carrying every `tcV6*` global.
 */
function loadV6Shell() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8'), sandbox);
  return sandbox;
}

// v6.1.0 Wave 2 (Car V61-W2-ROUTES): live HTTP wiring for the eleven Wave 1
// modules (#1886, #2991..#3000), driven through the REAL request handler
// (server.js#handleRequest) with the same harness the v6-t1/t2/t3 route
// integration tests use.

describe('v6.1.0 Wave 2 server routes (#1886, #2991..#3000)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-v610-routes-'));
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

  /** @returns {object} A minimal response double. */
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
   * unless `operator: false`.
   * @param {string} method
   * @param {string} url
   * @param {{body?: object, headers?: object, cookie?: string, operator?: boolean}} [opts]
   * @returns {Promise<object>}
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
  const put = (url, body, opts) => send('PUT', url, Object.assign({ body: body || {} }, opts));
  const get = (url, opts) => send('GET', url, opts);
  const json = (res) => JSON.parse(res.body);

  /**
   * @param {string} name
   * @returns {number} The new project's id.
   */
  function seedProject(name) {
    return store.getDb().prepare('INSERT INTO projects (name, path, archived) VALUES (?, ?, 0)')
      .run(name, path.join(tempDir, name)).lastInsertRowid;
  }

  /**
   * A REAL signed-in operator session.
   * @param {string} username
   * @returns {{cookie: string, headers: Record<string, string>}}
   */
  function signInOperator(username) {
    const user = store.users.create(username, 'correct-horse-battery');
    const { token, csrfToken } = store.authSessions.create(user);
    return { cookie: `tc_session=${token}`, headers: { [authSession.CSRF_HEADER]: csrfToken } };
  }

  describe('every route refuses a caller that is not the operator', () => {
    for (const [method, url] of [
      ['GET', '/api/v6/projects/1/recovery-console'],
      ['GET', '/api/v6/operating-profiles'],
      ['POST', '/api/v6/placement/recommend'],
      ['POST', '/api/v6/wave-scheduler/topological-waves'],
      ['GET', '/api/v6/settings/catalog'],
      ['GET', '/api/v6/kb/search?q=x'],
      ['POST', '/api/v6/support/preview-issue'],
      ['GET', '/api/v6/walkthroughs']
    ]) {
      it(`${method} ${url}`, async () => {
        const res = await send(method, url, { operator: false, body: method === 'GET' ? undefined : {} });
        assert.ok([401, 403].includes(res.statusCode), `${res.statusCode} ${res.body}`);
      });
    }
  });

  describe('A2b recovery routes (#2991)', () => {
    it('400s a malformed id and 404s an unknown project', async () => {
      assert.equal((await get('/api/v6/projects/abc/recovery-console')).statusCode, 400);
      const res = await get('/api/v6/projects/999999/recovery/circuit');
      assert.equal(res.statusCode, 404);
      assert.equal(json(res).code, 'PROJECT_NOT_FOUND');
    });

    it('reads a closed circuit and an empty console for a healthy project', async () => {
      const projectId = seedProject('a2b-healthy');
      assert.equal(json(await get(`/api/v6/projects/${projectId}/recovery/circuit`)).state, 'closed');
      const view = json(await get(`/api/v6/projects/${projectId}/recovery-console?limit=5`));
      assert.deepEqual([view.circuit.state, view.openIncidents.length, view.recentAttempts.length], ['closed', 0, 0]);
    });

    it('operator-reset needs a signed-in operator and a reason, then clears the latch recording who acted', async () => {
      const projectId = seedProject('a2b-latched');
      const db = store.getDb();
      a2b.ensureSchema(db);
      const incidentId = crypto.randomUUID();
      db.prepare("INSERT INTO runtime_incidents (id, project_id, fingerprint, state, generation, created_at) VALUES (?,?,?,'open',1,?)")
        .run(incidentId, projectId, 'fp', new Date().toISOString());
      db.prepare('INSERT INTO v6_a2b_recovery_latches (project_id, incident_id, reason, latched_at) VALUES (?,?,?,?)')
        .run(projectId, incidentId, 'MAX_ATTEMPTS', new Date().toISOString());

      const anon = await post(`/api/v6/projects/${projectId}/recovery/operator-reset`, { reason: 'x' });
      assert.equal(json(anon).code, 'SIGNED_IN_OPERATOR_REQUIRED');
      const session = signInOperator('latch-clearer');
      const noReason = await post(`/api/v6/projects/${projectId}/recovery/operator-reset`, { reason: ' ' }, session);
      assert.equal(json(noReason).code, 'REASON_REQUIRED');

      const ok = await post(`/api/v6/projects/${projectId}/recovery/operator-reset`, { reason: 'verified by hand', operatorId: 'someone-else' }, session);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(json(ok).circuit.state, 'closed');
      const row = db.prepare('SELECT clear_reason FROM v6_a2b_recovery_latches WHERE project_id = ?').get(projectId);
      assert.equal(row.clear_reason, 'latch-clearer: verified by hand', 'the actor comes from the session, never body.operatorId');

      const again = await post(`/api/v6/projects/${projectId}/recovery/operator-reset`, { reason: 'again' }, session);
      assert.deepEqual([again.statusCode, json(again).code], [409, 'NOT_LATCHED']);
    });
  });

  describe('A3 operating-profile routes (#2992)', () => {
    it('lists the three profiles with the safety floor', async () => {
      const body = json(await get('/api/v6/operating-profiles'));
      assert.deepEqual(body.profiles, ['Full', 'Lean', 'Minimal']);
      assert.ok(body.safetyFloor.includes('secretScanning'));
      assert.equal(body.resolved.length, 3);
    });

    it('resolves a profile and refuses disabling the floor', async () => {
      assert.equal(json(await post('/api/v6/operating-profiles/resolve', { profile: 'Lean' })).name, 'Lean');
      const refused = await post('/api/v6/operating-profiles/resolve', { profile: 'Full', overrides: { disable: ['audit'] } });
      assert.deepEqual([refused.statusCode, json(refused).code], [403, 'SAFETY_FLOOR_IMMUTABLE']);
      assert.equal(json(await post('/api/v6/operating-profiles/resolve', { profile: 'Zero' })).code, 'UNKNOWN_PROFILE');
    });

    it('aggregates measured samples and 400s an invalid one', async () => {
      const samples = [{ runId: 'r1', profile: 'Full', seats: 1, promptTokens: 10, serviceMs: 4 }, { runId: 'r2', profile: 'Lean', seats: 1, promptTokens: 6, serviceMs: 2 }];
      const body = json(await post('/api/v6/operating-profiles/overhead', { samples }));
      assert.equal(body.rows.length, 2);
      assert.equal(body.deltas.find((d) => d.profile === 'Lean').promptTokensP50Delta, -4);
      const bad = await post('/api/v6/operating-profiles/overhead', { samples: [{ runId: 'r', profile: 'Full', seats: 2, promptTokens: 1, serviceMs: 1 }] });
      assert.deepEqual([bad.statusCode, json(bad).code], [400, 'INVALID_SAMPLES']);
    });
  });

  describe('C4+D2 failover and placement routes (#2993)', () => {
    const policy = {
      mode: 'standing-policy',
      allowedAutoPlacements: [{ engine: 'b', model: 'mb' }]
    };
    const placementBody = (projectId, extra = {}) => ({
      projectId, mode: 'auto', strategy: 'maximize-useful-allowance',
      job: { id: 'job-1', approved: true },
      candidates: [{ engineId: 'b', modelId: 'mb', accountId: 'one', selectable: true, quality: 0.9, capabilities: [] }],
      catalog: [{ id: 'b', available: true }],
      quota: [{ accountId: 'one', engineId: 'b', confidence: 'measured', remaining: 9, capacity: 10, resetAt: Date.now() + 3_600_000 }],
      ...extra
    });

    it('reads the confirm posture before any ratification', async () => {
      const projectId = seedProject('c4-unratified');
      const body = json(await get(`/api/v6/projects/${projectId}/failover-policy`));
      assert.deepEqual([body.policy, body.posture], [null, 'confirm']);
    });

    it('ratifies a project policy with version CAS, and refuses a stale version', async () => {
      const projectId = seedProject('c4-ratify');
      const first = await put(`/api/v6/projects/${projectId}/failover-policy`, { policy, expectedVersion: 0 });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(json(first).version, 1);
      const stale = await put(`/api/v6/projects/${projectId}/failover-policy`, { policy, expectedVersion: 0 });
      assert.deepEqual([stale.statusCode, json(stale).code], [409, 'VERSION_CONFLICT']);
      const read = json(await get(`/api/v6/projects/${projectId}/failover-policy`));
      assert.deepEqual([read.scopeKind, read.posture, read.version], ['project', 'standing-policy', 1]);
      const bad = await put(`/api/v6/projects/${projectId}/failover-policy`, { policy: { mode: 'yolo' }, expectedVersion: 1 });
      assert.equal(json(bad).code, 'POLICY_MODE_INVALID');
    });

    it('auto placement applies only under the RATIFIED policy; a body-supplied policy is ignored', async () => {
      const projectId = seedProject('c4-placement');
      const forged = await post('/api/v6/placement/recommend', placementBody(projectId, { policy }));
      assert.equal(forged.statusCode, 200, forged.body);
      assert.deepEqual([json(forged).code, json(forged).autoApply], ['AUTO_NOT_PERMITTED', false], 'body.policy must not grant auto-apply');

      await put(`/api/v6/projects/${projectId}/failover-policy`, { policy, expectedVersion: 0 });
      const real = json(await post('/api/v6/placement/recommend', placementBody(projectId)));
      assert.deepEqual([real.code, real.autoApply], ['AUTO_APPLIED', true]);
    });

    it('recommend mode needs no project; auto mode without a projectId is refused', async () => {
      const rec = json(await post('/api/v6/placement/recommend', placementBody(undefined, { mode: 'recommend' })));
      assert.equal(rec.code, 'RECOMMENDED');
      assert.equal((await post('/api/v6/placement/recommend', placementBody(undefined))).statusCode, 400);
    });

    it('a fleet policy is ratified over every member and reaches only members', async () => {
      const projectId = seedProject('c4-fleet-member');
      const outsider = seedProject('c4-fleet-outsider');
      const db = store.getDb();
      const fleet = `fleet-${crypto.randomUUID()}`;
      db.prepare('INSERT INTO v6_fleets (id, logical_project_id, display_name) VALUES (?,?,?)').run(fleet, `lp-${projectId}`, fleet);
      db.prepare('UPDATE v6_resources SET fleet_id = ? WHERE legacy_project_id = ?').run(fleet, projectId);
      const res = await put(`/api/v6/fleets/${fleet}/failover-policy`, { policy, expectedVersion: 0 });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(await get(`/api/v6/projects/${projectId}/failover-policy?fleetId=${fleet}`)).scopeKind, 'fleet');
      assert.equal(json(await get(`/api/v6/projects/${outsider}/failover-policy?fleetId=${fleet}`)).posture, 'confirm');
      const empty = await put('/api/v6/fleets/no-such-fleet/failover-policy', { policy, expectedVersion: 0 });
      assert.deepEqual([empty.statusCode, json(empty).code], [409, 'FLEET_HAS_NO_MEMBER_PROJECTS']);
    });

    it('lists receipts (empty by default)', async () => {
      const projectId = seedProject('c4-receipts');
      assert.deepEqual(json(await get(`/api/v6/projects/${projectId}/failover-receipts`)).receipts, []);
    });
  });

  describe('C3 wave-scheduler routes (#1886)', () => {
    const cars = [{ id: 'a', fileScope: ['lib/a.js'] }, { id: 'b', dependsOn: ['a'], fileScope: ['lib/b.js'] }];

    it('plans topological waves and refuses a cycle with the library code', async () => {
      const ok = json(await post('/api/v6/wave-scheduler/topological-waves', { cars }));
      assert.equal(ok.waves.length, 2);
      const cyc = await post('/api/v6/wave-scheduler/topological-waves', { cars: [{ id: 'a', dependsOn: ['b'], fileScope: ['x'] }, { id: 'b', dependsOn: ['a'], fileScope: ['y'] }] });
      assert.ok(cyc.statusCode >= 400 && cyc.statusCode < 500, cyc.body);
      assert.ok(json(cyc).code);
    });

    it('creates a run scoped to its project and reads it back only from that project', async () => {
      const projectId = seedProject('c3-run');
      const other = seedProject('c3-other');
      const created = await post(`/api/v6/projects/${projectId}/wave-runs`, { id: 'run-1', fleetId: 'fleet-x', cars });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(json(await get(`/api/v6/projects/${projectId}/wave-runs/run-1`)).id, 'run-1');
      const cross = await get(`/api/v6/projects/${other}/wave-runs/run-1`);
      assert.deepEqual([cross.statusCode, json(cross).code], [404, 'RUN_NOT_IN_PROJECT']);
      const missing = await get(`/api/v6/projects/${projectId}/wave-runs/nope`);
      assert.deepEqual([missing.statusCode, json(missing).code], [404, 'RUN_NOT_FOUND']);
    });
  });

  describe('D3, B3, F2 and H2 catalog routes (#2994, #2995, #2998, #3000)', () => {
    it('serves the open-weight catalog', async () => {
      assert.ok(json(await get('/api/v6/openweight/catalog')).roles.includes('Builder'));
    });

    it('explains a known setting and 404s an unknown one', async () => {
      const catalog = json(await get('/api/v6/settings/catalog'));
      const key = Object.keys(catalog.catalog)[0];
      assert.equal(json(await get(`/api/v6/settings/explain/${encodeURIComponent(key)}`)).key, key);
      const unknown = await get('/api/v6/settings/explain/notARealSetting');
      assert.deepEqual([unknown.statusCode, json(unknown).code], [404, 'UNKNOWN_SETTING']);
      const bad = await post('/api/v6/settings/validate-patch', { kind: 'project', patch: 'nope' });
      assert.equal(bad.statusCode, 400);
      assert.ok(json(bad).code);
    });

    it('serves the doc-parity families', async () => {
      assert.ok(json(await get('/api/v6/doc-parity/families')).families);
    });

    it('lists walkthroughs, reads one, and 404s an unknown walkthrough or term', async () => {
      const list = json(await get('/api/v6/walkthroughs'));
      const id = list.walkthroughs[0].id;
      assert.equal(json(await get(`/api/v6/walkthroughs/${id}`)).id, id);
      assert.equal((await get('/api/v6/walkthroughs/no-such')).statusCode, 404);
      assert.equal((await get(`/api/v6/glossary/${encodeURIComponent('Fleet')}`)).statusCode, 200);
      assert.equal((await get('/api/v6/glossary/NotATerm')).statusCode, 404);
    });
  });

  describe('F1 knowledge base and E6b ask routes (#2997, #2996)', () => {
    it('searches the shipped manual and answers contextual help', async () => {
      const res = await get('/api/v6/kb/search?q=project&budgetTokens=512');
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(json(res).results.length > 0, 'the shipped manual must yield at least one hit for "project"');
      const help = await get('/api/v6/kb/contextual-help?surface=public%2Findex.html');
      assert.equal(help.statusCode, 200, help.body);
    });

    it('refuses a malformed version with the library code', async () => {
      const res = await get('/api/v6/kb/search?q=project&version=not-semver');
      assert.deepEqual([res.statusCode, json(res).code], [400, 'VERSION_INVALID']);
    });

    it('refuses a malformed ask without calling any model', async () => {
      const res = await post('/api/v6/reports/ask', { reports: 'nope', question: '' });
      assert.equal(res.statusCode, 400, res.body);
      assert.ok(json(res).code);
    });
  });

  describe('F3 support routes (#2999)', () => {
    it('builds a scrubbed bundle', async () => {
      const res = await post('/api/v6/support/diagnostic-bundle', { input: { errorCodes: ['E_TEST'] } });
      assert.equal(res.statusCode, 200, res.body);
    });

    it('preview always rebuilds the bundle server-side: a client-supplied bundle is never rendered', async () => {
      const secret = 'ghp_' + 'A'.repeat(36);
      const res = await post('/api/v6/support/preview-issue', { bundle: { errorCodes: [secret] }, input: { errorCodes: ['E_TEST'] } });
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(!res.body.includes(secret), 'an unscrubbed client bundle must never reach the preview');
      assert.equal((await post('/api/v6/support/preview-issue', { repo: 'not a repo' })).statusCode, 400);
    });
  });

  describe('v6-shell Settings & Profiles bindings', () => {
    const XSS = '<img src=x onerror=alert(1)>';

    it('escapes every server-supplied value in the four new views', () => {
      const shell = loadV6Shell();
      const html = [
        shell.tcV6SettingsViewMarkup({
          profiles: { resolved: [{ ok: true, name: XSS, services: ['a'], telemetryCadenceMs: 60000 }], safetyFloor: [XSS] },
          catalog: { catalog: { [XSS]: { description: XSS } } },
          walkthroughs: { walkthroughs: [{ id: 'w', title: XSS, summary: XSS, stepCount: 1, verification: XSS }] },
          projects: [{ id: 1, name: XSS }]
        }),
        shell.tcV6RecoveryConsoleMarkup({ projectId: XSS, console: { circuit: { state: XSS, failures: 1, latch: { reason: XSS } },
          openIncidents: [{ fingerprint: XSS }], recentAttempts: [{ action: XSS, outcome: XSS }] } }),
        shell.tcV6KnowledgeBaseMarkup({ results: [{ heading: XSS, text: XSS, citation: XSS }] }),
        shell.tcV6WalkthroughsMarkup({ walkthroughs: [{ title: XSS }] })
      ].join('');
      assert.ok(!html.includes('<img'), 'no unescaped markup may reach the DOM');
      assert.ok(html.includes('&lt;img'));
    });

    it('renders an honest error for each view when its data failed to load', () => {
      const shell = loadV6Shell();
      assert.match(shell.tcV6SettingsViewMarkup({}), /Could not load the operating profiles/);
      assert.match(shell.tcV6RecoveryConsoleMarkup({ projectId: 3, console: null }), /Could not load the recovery console/);
      assert.match(shell.tcV6KnowledgeBaseMarkup(null), /Could not load help/);
      assert.match(shell.tcV6RecoveryConsoleMarkup({ projectId: 3, console: { circuit: { state: 'latched', failures: 2, latch: { reason: 'MAX_ATTEMPTS' } } } }), /Latched/);
    });

    /**
     * Drive the live controller through one settings route with a fake API.
     * @param {string} hash
     * @returns {Promise<{details: Array<object>, calls: string[]}>}
     */
    async function driveSettings(hash) {
      const shell = loadV6Shell();
      const details = [];
      const calls = [];
      const fakeShell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail(d) { details.push(JSON.parse(JSON.stringify(d))); } };
      const api = async (url) => {
        calls.push(url);
        if (url === '/api/projects') return { projects: [{ id: 7, name: 'demo' }] };
        if (url === '/api/v6/operating-profiles') return { resolved: [], safetyFloor: [] };
        if (url === '/api/v6/settings/catalog') return { catalog: {} };
        if (url === '/api/v6/walkthroughs') return { walkthroughs: [] };
        if (url.startsWith('/api/v6/kb/contextual-help')) return { results: [] };
        if (url.startsWith('/api/v6/projects/7/recovery-console')) return { circuit: { state: 'closed', failures: 0 }, openIncidents: [], recentAttempts: [] };
        return null;
      };
      const controller = shell.tcV6CreateLiveController({ getShell: () => fakeShell, api, apiMutate: async () => null });
      await controller.handleRoute(shell.tcV6ParseRoute(hash));
      return { details, calls };
    }

    it('#/settings/ loads profiles, catalog and walkthroughs into a settings detail', async () => {
      const { details, calls } = await driveSettings('#/settings/');
      assert.ok(['/api/v6/operating-profiles', '/api/v6/settings/catalog', '/api/v6/walkthroughs'].every((u) => calls.includes(u)));
      const last = details[details.length - 1];
      assert.equal(last.kind, 'settings');
      assert.equal(last.view.projects[0].name, 'demo');
    });

    it('#/settings/help loads contextual help for the shell itself', async () => {
      const { details, calls } = await driveSettings('#/settings/help');
      assert.ok(calls.includes('/api/v6/kb/contextual-help?surface=public%2Fv6-shell.js'));
      assert.equal(details[details.length - 1].kind, 'knowledge');
    });

    it('#/settings/recovery/<id> loads that project\'s recovery console', async () => {
      const { details } = await driveSettings('#/settings/recovery%2F7');
      const last = details[details.length - 1];
      assert.deepEqual([last.kind, last.view.projectId, last.view.console.circuit.state], ['recovery', '7', 'closed']);
    });
  });
});
