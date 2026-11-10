'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { handleRequest } = require('../server');

// v6 Train 2 (BRIDGE-2b, Car V60-T2-W2-ROUTES): live HTTP wiring for
// lib/v6/b2-conversation-layer.js (#2982), lib/v6/b4-telemetry-header.js
// (#2983), lib/v6/c2-fleet-templates.js (#2984),
// lib/v6/d1-model-attestation.js (#2985),
// lib/v6/e1-doc-planes-context-compiler.js (#1151),
// lib/v6/g3-medusa-isolation.js (#2986), and
// lib/v6/h1-branding-policy.js (#2987). Driven through the REAL request
// handler (server.js#handleRequest), the same harness
// test/v6-t1-server-routes-integration.test.js uses.

describe('v6 Train 2 server routes (#2982, #2983, #2984, #2985, #1151, #2986, #2987, BRIDGE-2b)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-t2-w2-routes-'));
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
   * by default. Pass `operator: false` for a caller the launch-binding
   * floor must refuse before any route-specific check runs.
   * @param {string} method
   * @param {string} url
   * @param {{body?: object, operator?: boolean}} [opts]
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
  const get = (url, opts) => send('GET', url, opts);
  const del = (url, opts) => send('DELETE', url, opts);
  const json = (res) => JSON.parse(res.body);

  async function seedProject(name) {
    store.getDb().exec(`INSERT INTO projects (name, path, archived) VALUES ('${name}', '${path.join(tempDir, name)}', 0)`);
    return store.getDb().prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
  }

  async function seedSession(projectId, engineId = 'claude') {
    store.getDb().prepare('INSERT INTO sessions (project_id, engine_id) VALUES (?, ?)').run(projectId, engineId);
    return Number(store.getDb().prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  describe('launch-binding floor: every mutating route here refuses a non-operator caller', () => {
    it('refuses POST conversation/events with no bound caller', async () => {
      const res = await post('/api/v6/projects/1/sessions/1/conversation/events', { seq: 1 }, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });

    it('refuses POST fleet-templates plan with no bound caller', async () => {
      const res = await post('/api/v6/fleet-templates/small-4-seat/plan', {}, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });
  });

  describe('B2: Native Conversation Layer routes (#2982)', () => {
    it('appends a Tier-A event, replays it, and soft-deletes it', async () => {
      const projectId = await seedProject('b2-route-project');
      const sessionId = await seedSession(projectId, 'claude');
      const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'hello'
      });
      assert.equal(append.statusCode, 201, append.body);
      const { id } = json(append);

      const replay = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(json(replay).events.length, 1);

      const del1 = await del(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events/${id}`);
      assert.equal(del1.statusCode, 200, del1.body);

      const replayAfterDelete = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`);
      assert.equal(json(replayAfterDelete).events.length, 0);
    });

    it('refuses a Tier B event with a tier/adapter mismatch', async () => {
      const projectId = await seedProject('b2-route-mismatch');
      const sessionId = await seedSession(projectId, 'aider');
      const res = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'A', adapter: 'aider', role: 'assistant', content: 'x'
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUEST');
    });

    it('checks interrupt support, failing closed for an engine with no interruptContract', async () => {
      const projectId = await seedProject('b2-route-interrupt');
      const res = await post(`/api/v6/projects/${projectId}/conversation/interrupt`, { engineProfile: { id: 'aider' } });
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(json(res).code, 'INTERRUPT_UNSUPPORTED_BY_ENGINE');
    });

    it('classifies an adapter tier', async () => {
      const res = await get('/api/v6/conversation/adapter-tier/claude');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).tier, 'A');
    });
  });

  describe('B4: Telemetry Header routes (#2983)', () => {
    it('assembles a telemetry bar with every metric unavailable (no real collector wiring in this car)', async () => {
      const projectId = await seedProject('b4-route-project');
      const res = await get(`/api/v6/projects/${projectId}/telemetry`);
      assert.equal(res.statusCode, 200, res.body);
      const bar = json(res);
      assert.equal(bar.scope, 'global');
      assert.equal(bar.metrics.tokens.confidence, 'unavailable');
    });
  });

  describe('C2: Fleet Template Catalog routes (#2984)', () => {
    it('lists, reads, plans, and admits a seat for a template', async () => {
      const list = await get('/api/v6/fleet-templates');
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(json(list).templates.length, 3);

      const read = await get('/api/v6/fleet-templates/small-4-seat');
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(json(read).id, 'small-4-seat');

      const plan = await post('/api/v6/fleet-templates/small-4-seat/plan', {});
      assert.equal(plan.statusCode, 200, plan.body);
      const planBody = json(plan);
      assert.equal(planBody.immediateSeats.length, 1);

      const admit = await post('/api/v6/fleet-templates/small-4-seat/admit', { plan: planBody, seatId: 'architect' });
      assert.equal(admit.statusCode, 200, admit.body);
      assert.equal(json(admit).admitted, true);
    });

    it('404s a read for an unknown template', async () => {
      const res = await get('/api/v6/fleet-templates/not-a-real-template');
      assert.equal(res.statusCode, 404, res.body);
    });
  });

  describe('D1: Model Attestation routes (#2985)', () => {
    it('records an attestation and reads it back, then across history', async () => {
      const projectId = await seedProject('d1-route-project');
      const sessionId = await seedSession(projectId);
      const record = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/attestations`, {
        generation: 1, engineId: 'claude', requestedModel: 'claude-sonnet-5', source: 'unavailable', confidence: 'unavailable'
      });
      assert.equal(record.statusCode, 201, record.body);

      const one = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/attestations/1`);
      assert.equal(one.statusCode, 200, one.body);
      assert.equal(json(one).requested_model, 'claude-sonnet-5');

      const history = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/attestations`);
      assert.equal(history.statusCode, 200, history.body);
      assert.equal(json(history).attestations.length, 1);
    });

    it('404s a read for a generation with no recorded attestation', async () => {
      const projectId = await seedProject('d1-route-missing');
      const sessionId = await seedSession(projectId);
      const res = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/attestations/1`);
      assert.equal(res.statusCode, 404, res.body);
    });
  });

  describe('E1: 4-Plane Documentation Model routes (#1151)', () => {
    it('classifies a path', async () => {
      const res = await get('/api/v6/doc-planes/classify?path=README.md');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).plane, 'product');
    });

    it('checks the write boundary, refusing without a grant', async () => {
      const res = await post('/api/v6/doc-planes/write-boundary', { path: 'README.md' });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, 'DOC_AUTHORING_GRANT_REQUIRED');
    });

    it('compiles a context bundle, excluding historical-archive by default', async () => {
      const res = await post('/api/v6/doc-planes/context-bundle', { paths: ['CLAUDE.md', 'archive/x.md'] });
      assert.equal(res.statusCode, 200, res.body);
      const result = json(res);
      assert.equal(result.included.length, 1);
      assert.equal(result.included[0].path, 'CLAUDE.md');
    });

    it('syncs and validates the SSOT index against this server\'s own checkout', async () => {
      const sync = await post('/api/v6/doc-planes/ssot-index/sync', {});
      assert.equal(sync.statusCode, 201, sync.body);
      const validate = await get('/api/v6/doc-planes/ssot-index/validate');
      assert.equal(validate.statusCode, 200, validate.body);
      assert.equal(json(validate).ok, true);
    });

    it('checks car dependency admission', async () => {
      const res = await post('/api/v6/doc-planes/car-dependency-admission', {
        car: { id: 'x', dependsOn: ['a'] }, completedCarIds: ['a']
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).admitted, true);
    });

    it('evaluates a webhook state advance', async () => {
      const res = await post('/api/v6/doc-planes/webhook-state-advance', { event: { type: 'car.dispatched' }, currentState: 'queued' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).nextState, 'dispatched');
    });
  });

  describe('G3: Medusa Switchboard Isolation routes (#2986)', () => {
    it('allows a project to reach its own switchboard', async () => {
      const projectId = await seedProject('g3-route-project');
      const res = await post(`/api/v6/projects/${projectId}/medusa-access-check`, { targetProjectId: projectId });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).allowed, true);
    });

    it('refuses a different project with MEDUSA_CROSS_PROJECT_DENIED when no link exists', async () => {
      const projectId = await seedProject('g3-route-denied');
      const res = await post(`/api/v6/projects/${projectId}/medusa-access-check`, { targetProjectId: projectId + 999 });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, 'MEDUSA_CROSS_PROJECT_DENIED');
    });
  });

  describe('H1: Branding & Attribution Policy routes (#2987)', () => {
    it('reads the default branding policy', async () => {
      const res = await get('/api/v6/branding/default-policy');
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res), {
        'branding.uiWatermark': true, 'branding.gitCommitTrailer': false, 'branding.generatedDocAttribution': true
      });
    });

    it('classifies an attribution target path', async () => {
      const res = await get('/api/v6/branding/classify?path=server.js');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).classification, 'application');
    });

    it('computes the effective gitCommitTrailer, hard-locked false on a client/external repo', async () => {
      const res = await post('/api/v6/branding/effective', {
        key: 'branding.gitCommitTrailer', storedValue: true, repoClassification: 'client-external'
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).value, false);
    });

    it('validates a branding policy change, refusing gitCommitTrailer: true on a client/external repo', async () => {
      const res = await post('/api/v6/branding/validate-change', {
        key: 'branding.gitCommitTrailer', value: true, repoClassification: 'client-external'
      });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, 'GIT_COMMIT_TRAILER_LOCKED_CLIENT_EXTERNAL');
    });

    it('refuses an unknown branding key', async () => {
      const res = await post('/api/v6/branding/effective', { key: 'branding.notReal', storedValue: true });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'UNKNOWN_BRANDING_KEY');
    });
  });
});
