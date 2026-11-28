'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const store = require('../lib/store');
const { handleRequest, _v6PinnedLookup } = require('../server');
const { bindProject } = require('./_shared-docs-callers');

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

    it('404s append/replay/delete when sessionId does not belong to the named project (Ruling A581)', async () => {
      const projectId = await seedProject('b2-wrong-project');
      const otherProjectId = await seedProject('b2-other-project');
      const sessionId = await seedSession(otherProjectId, 'claude');
      const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'x'
      });
      assert.equal(append.statusCode, 404, append.body);
      const replay = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`);
      assert.equal(replay.statusCode, 404, replay.body);
      const del1 = await del(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events/1`);
      assert.equal(del1.statusCode, 404, del1.body);
    });

    it('404s deleting an event that belongs to a DIFFERENT session on the same project (Ruling A581)', async () => {
      const projectId = await seedProject('b2-cross-session-delete');
      const sessionA = await seedSession(projectId, 'claude');
      const sessionB = await seedSession(projectId, 'claude');
      const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionA}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'x'
      });
      const { id } = json(append);
      const del1 = await del(`/api/v6/projects/${projectId}/sessions/${sessionB}/conversation/events/${id}`);
      assert.equal(del1.statusCode, 404, del1.body);
    });

    it('redacts a secret-shaped content server-side, ignoring a caller-supplied redacted: false (Ruling A581)', async () => {
      const projectId = await seedProject('b2-redaction');
      const sessionId = await seedSession(projectId, 'claude');
      const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant',
        content: 'here is my token: Bearer abc123XYZ.def-456', redacted: false
      });
      assert.equal(append.statusCode, 201, append.body);
      const replay = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`);
      const event = json(replay).events[0];
      assert.doesNotMatch(event.content, /abc123XYZ/);
      assert.match(event.content, /\[REDACTED\]/);
      assert.equal(event.redacted, 1);
    });

    it('redacts quoted secret-shaped content (password=, password:, api_key:) and a Basic auth token (Ruling A585-PR3016-R2-HOLD-RECONCILED)', async () => {
      const projectId = await seedProject('b2-redaction-quoted');
      const sessionId = await seedSession(projectId, 'claude');
      const cases = [
        { content: 'config: password="supersecret" end', secret: 'supersecret' },
        { content: 'note password: "hunter2-synthetic" stored', secret: 'hunter2-synthetic' },
        { content: 'header api_key: "sensitive-value" sent', secret: 'sensitive-value' },
        { content: 'auth header Basic dXNlcjpwYXNz used', secret: 'dXNlcjpwYXNz' }
      ];
      for (let i = 0; i < cases.length; i++) {
        const { content, secret } = cases[i];
        const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
          launchId: 'l1', seq: i + 1, tier: 'A', adapter: 'claude', role: 'assistant', content
        });
        assert.equal(append.statusCode, 201, append.body);
        const { id } = json(append);
        const row = store.getDb().prepare('SELECT content, redacted FROM conversation_events WHERE id = ?').get(id);
        assert.doesNotMatch(row.content, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `case ${i}: ${content}`);
        assert.match(row.content, /\[REDACTED\]/, `case ${i}: ${content}`);
        assert.equal(row.redacted, 1, `case ${i}: ${content}`);
      }
    });

    it('does not mark ordinary content redacted', async () => {
      const projectId = await seedProject('b2-no-redaction');
      const sessionId = await seedSession(projectId, 'claude');
      const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'just a normal message'
      });
      const replay = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`);
      assert.equal(json(replay).events[0].redacted, 0);
    });

    it('overwrites the stored content and clears rolling_line_sha256 on delete, rather than merely soft-deleting (Ruling A581)', async () => {
      const projectId = await seedProject('b2-secure-overwrite');
      const sessionId = await seedSession(projectId, 'aider');
      const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'B', adapter: 'aider', role: 'assistant', content: 'sensitive pane text',
        paneCursorWatermark: 0, rollingLineSha256: 'a'.repeat(64)
      });
      const { id } = json(append);
      const del1 = await del(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events/${id}`);
      assert.equal(del1.statusCode, 200, del1.body);
      const row = store.getDb().prepare('SELECT content, rolling_line_sha256 FROM conversation_events WHERE id = ?').get(id);
      assert.equal(row.content, '[DELETED]');
      assert.equal(row.rolling_line_sha256, null);
      assert.deepEqual(json(del1).residual_locations, [], 'TRUNCATE checkpoint leaves nothing to report as residual');
    });

    it('reports walCheckpointPending and a WAL residual while a concurrent reader blocks the TRUNCATE checkpoint, then the server\'s OWN background retry truncates it after the reader releases -- without this test ever calling wal_checkpoint itself (Ruling A589-PR3016-R4-HOLD-RECONCILED)', async () => {
      // This repo's real database runs in SQLite's default rollback-journal
      // mode (nothing anywhere sets journal_mode=WAL), where wal_checkpoint
      // is a harmless always-non-busy no-op -- so this test opts the shared
      // fixture db INTO WAL mode itself, to prove the retry mechanism works
      // correctly if the database is ever run in WAL mode, not because
      // today's real deployment hits this path.
      const db = store.getDb();
      db.exec('PRAGMA journal_mode=WAL');
      const dbPath = path.join(tempDir, 'tangleclaw.db');
      const walPath = `${dbPath}-wal`;
      const secretPayload = 'synthetic-original-private-payload-r5';
      try {
        const projectId = await seedProject('b2-wal-pending');
        const sessionId = await seedSession(projectId, 'claude');
        const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
          launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: secretPayload
        });
        const { id } = json(append);

        const reader = new DatabaseSync(dbPath);
        reader.exec('BEGIN');
        reader.prepare('SELECT COUNT(*) AS n FROM conversation_events').get();

        const del1 = await del(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events/${id}`);
        assert.equal(del1.statusCode, 200, del1.body);
        const body = json(del1);
        assert.equal(body.walCheckpointPending, true);
        assert.ok(body.residual_locations.includes('sqlite:tangleclaw.db-wal'), JSON.stringify(body.residual_locations));

        // Hold the reader open well past the retry's own tick interval, so
        // the FIRST few retries are proven to still see busy=1 before we
        // ever release it -- never calling wal_checkpoint ourselves here.
        await new Promise((r) => setTimeout(r, 500));
        reader.exec('COMMIT');
        reader.close();

        // Give the server's own unref'd background retry (server.js
        // #_v6WalCheckpointTruncate) a chance to tick again and succeed --
        // still no wal_checkpoint call from the test itself.
        await new Promise((r) => setTimeout(r, 200));

        assert.ok(!fs.existsSync(walPath) || fs.statSync(walPath).size === 0,
          `tangleclaw.db-wal must be truncated once the reader releases (size=${fs.existsSync(walPath) ? fs.statSync(walPath).size : 'missing'})`);
        if (fs.existsSync(walPath)) {
          assert.doesNotMatch(fs.readFileSync(walPath, 'latin1'), new RegExp(secretPayload));
        }
      } finally {
        db.exec('PRAGMA journal_mode=DELETE');
      }
    });

    it('enumerates an existing .aider.chat.history.md as a residual location, with walCheckpointPending false when no reader is open (ADR 0026 §3.4.4 item 3)', async () => {
      const projectName = 'b2-aider-transcript';
      const projectId = await seedProject(projectName);
      const projectPath = path.join(tempDir, projectName);
      fs.mkdirSync(projectPath, { recursive: true });
      const transcriptPath = path.join(projectPath, '.aider.chat.history.md');
      fs.writeFileSync(transcriptPath, '# aider chat history\n');
      const sessionId = await seedSession(projectId, 'aider');
      const append = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        launchId: 'l1', seq: 1, tier: 'B', adapter: 'aider', role: 'assistant', content: 'x',
        paneCursorWatermark: 0, rollingLineSha256: 'b'.repeat(64)
      });
      const { id } = json(append);
      const del1 = await del(`/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events/${id}`);
      assert.equal(del1.statusCode, 200, del1.body);
      const body = json(del1);
      assert.equal(body.walCheckpointPending, false);
      assert.ok(body.residual_locations.includes(transcriptPath), JSON.stringify(body.residual_locations));
    });
  });

  describe('B4: Telemetry Header routes (#2983)', () => {
    it('assembles a telemetry bar from the live readings the server holds, leaving uncollected metrics unavailable (#3022)', async () => {
      const projectId = await seedProject('b4-route-project');
      const res = await get(`/api/v6/projects/${projectId}/telemetry`);
      assert.equal(res.statusCode, 200, res.body);
      const bar = json(res);
      assert.equal(bar.scope, 'global');
      // Each supplied reading must carry one of B4's own confidence levels;
      // any other word would silently normalize it to unavailable.
      assert.equal(bar.metrics.activeSessions.confidence, 'observed');
      assert.equal(typeof bar.metrics.activeSessions.value, 'number');
      assert.equal(bar.metrics.versionDrift.confidence, 'observed');
      assert.equal(typeof bar.metrics.versionDrift.value, 'string');
      assert.ok(bar.metrics.versionDrift.value.length > 0);
      assert.deepEqual(bar.metrics.health, { value: 'healthy', confidence: 'estimated' });
      for (const key of ['tokens', 'quotaWindow', 'contextUtilization', 'pendingMedusaMessages']) {
        assert.deepEqual(bar.metrics[key], { value: null, confidence: 'unavailable' }, key);
      }
    });

    it('counts live sessions from the store, not a constant (#3022)', async () => {
      const before = json(await get('/api/v6/projects/1/telemetry')).metrics.activeSessions.value;
      const projectId = await seedProject('b4-live-count-project');
      await seedSession(projectId);
      const after = json(await get(`/api/v6/projects/${projectId}/telemetry`)).metrics.activeSessions.value;
      assert.equal(after, before + 1);
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

    it('404s admit for an unknown template, before checking the plan shape (Ruling A581)', async () => {
      const res = await post('/api/v6/fleet-templates/not-a-real-template/admit', { plan: {}, seatId: 'x' });
      assert.equal(res.statusCode, 404, res.body);
    });

    it('400s admit for a malformed plan (missing immediateSeats/deferredSeats arrays)', async () => {
      const res = await post('/api/v6/fleet-templates/small-4-seat/admit', { plan: { immediateSeats: [] }, seatId: 'x' });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUEST');
    });

    it('400s admit when plan.templateId does not match the template named in the URL', async () => {
      const plan = json(await post('/api/v6/fleet-templates/small-4-seat/plan', {}));
      const res = await post('/api/v6/fleet-templates/recommended-10-role/admit', { plan, seatId: 'architect' });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUEST');
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

    it('404s record/read when sessionId does not belong to the named project (Ruling A581)', async () => {
      const projectId = await seedProject('d1-wrong-project');
      const otherProjectId = await seedProject('d1-other-project');
      const sessionId = await seedSession(otherProjectId);
      const record = await post(`/api/v6/projects/${projectId}/sessions/${sessionId}/attestations`, {
        generation: 1, engineId: 'claude', source: 'unavailable', confidence: 'unavailable'
      });
      assert.equal(record.statusCode, 404, record.body);
      const history = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/attestations`);
      assert.equal(history.statusCode, 404, history.body);
      const one = await get(`/api/v6/projects/${projectId}/sessions/${sessionId}/attestations/1`);
      assert.equal(one.statusCode, 404, one.body);
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

    it('ignores a caller-supplied grant -- it is a claim, not proof, with no real issuance mechanism behind this route (Ruling A581)', async () => {
      const res = await post('/api/v6/doc-planes/write-boundary', { path: 'README.md', grant: { path: 'README.md', grantedBy: 'self-asserted' } });
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

    it('400s a context bundle whose paths include an absolute path, rather than reading it from the real filesystem (Ruling A581)', async () => {
      const res = await post('/api/v6/doc-planes/context-bundle', { paths: ['/etc/passwd'] });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUEST');
    });

    it('400s a context bundle whose paths escape the project root via ".."', async () => {
      const res = await post('/api/v6/doc-planes/context-bundle', { paths: ['../../../../../etc/passwd'] });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUEST');
    });

    it('400s a context bundle whose path is a symlink escaping the project root, not merely lexically-contained (Ruling A585-PR3016-R2-HOLD-RECONCILED)', async () => {
      const projectRoot = path.join(__dirname, '..');
      const externalTarget = path.join(tempDir, 'symlink-target-outside-repo.md');
      fs.writeFileSync(externalTarget, 'external content the route must never read');
      const linkName = '.tc-test-symlink-escape-tmp.md';
      const linkPath = path.join(projectRoot, linkName);
      fs.symlinkSync(externalTarget, linkPath);
      try {
        const res = await post('/api/v6/doc-planes/context-bundle', { paths: [linkName] });
        assert.equal(res.statusCode, 400, res.body);
        assert.equal(json(res).code, 'INVALID_REQUEST');
      } finally {
        fs.unlinkSync(linkPath);
      }
    });

    it('400s a context bundle whose paths array contains a non-string entry', async () => {
      const res = await post('/api/v6/doc-planes/context-bundle', { paths: [42] });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'INVALID_REQUEST');
    });

    it('syncs and validates the SSOT index into store._getBasePath(), never the real checkout (Ruling A581)', async () => {
      const indexPath = path.join(tempDir, 'ssot-index.json');
      assert.equal(fs.existsSync(indexPath), false, 'precondition: nothing there yet');
      const sync = await post('/api/v6/doc-planes/ssot-index/sync', {});
      assert.equal(sync.statusCode, 201, sync.body);
      assert.equal(fs.existsSync(indexPath), true, 'the index must land inside store._getBasePath()');
      assert.equal(fs.existsSync(path.join(__dirname, '..', '.tangleclaw', 'ssot-index.json')), false,
        'the real checkout must never be mutated by a route test');
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

    it('ignores a caller-supplied crossProjectLinks -- it is a claim, not proof, with no real link table behind this route (Ruling A581)', async () => {
      const projectId = await seedProject('g3-forged-link');
      const targetProjectId = projectId + 999;
      const res = await post(`/api/v6/projects/${projectId}/medusa-access-check`, {
        targetProjectId,
        crossProjectLinks: [{ fromProjectId: projectId, toProjectId: targetProjectId, bidirectional: true }]
      });
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

  describe('GET /api/v6/unfurl (#3107)', () => {
    // node:dns/node:http/node:https are built-ins: require() returns the
    // SAME cached singleton object server.js's own top-level requires hold,
    // so mutating a method here reaches server.js's calls too — the same
    // "monkey-patch the shared global" technique this file already uses
    // for globalThis.fetch (see the GitHub connection-probe tests above),
    // just on a different pair of shared objects, since _v6SafeUnfurlFetch
    // needs node:dns's own lookup (to validate the RESOLVED address, not
    // just the literal host) and so cannot be written against fetch alone.
    const dns = require('node:dns');
    const http = require('node:http');
    const https = require('node:https');
    let origLookup;
    let origHttpRequest;
    let origHttpsRequest;

    beforeEach(() => {
      origLookup = dns.promises.lookup;
      origHttpRequest = http.request;
      origHttpsRequest = https.request;
    });

    afterEach(() => {
      dns.promises.lookup = origLookup;
      http.request = origHttpRequest;
      https.request = origHttpsRequest;
    });

    /** A fake `http.request`/`https.request` answering with a fixed status + body, never touching the network. */
    function stubRequest(client, { statusCode = 200, body = '', headers = {} } = {}) {
      client.request = (_opts, cb) => {
        const chunks = body ? [Buffer.from(body)] : [];
        const fres = {
          statusCode,
          // A real `http.IncomingMessage` always carries `.headers` (even
          // when empty) — `lib/v6/b2-conversation-layer.js#_fetchOneUnfurlHop`
          // (wired into `GET /api/v6/unfurl` for #3139 Wave 2) reads
          // `fres.headers['content-type']` unconditionally on every 2xx
          // response, which this stub omitted before that wiring existed.
          headers,
          resume() {},
          on(event, fn) {
            if (event === 'data') chunks.forEach((c) => fn(c));
            if (event === 'end') fn();
            return fres;
          }
        };
        cb(fres);
        return { on() {}, end() {}, destroy() {} };
      };
    }

    it('_v6PinnedLookup answers the array form when asked opts.all, and the plain form otherwise (PRR-A R1 WARNING)', () => {
      // Confirmed live (not just from the Node docs) before writing this
      // test: Node 20+'s net.autoSelectFamily defaults to true, and an
      // http(s).request's own socket connection calls a custom `lookup`
      // with {all: true} by default — the plain 3-arg callback form threw
      // ERR_INVALID_IP_ADDRESS on every single real request on this exact
      // runtime (verified with a standalone https.request before fixing).
      const lookup = _v6PinnedLookup({ address: '93.184.216.34', family: 4 });
      let got;
      lookup('irrelevant.example', { all: true, hints: 1024 }, (err, result) => { got = { err, result }; });
      assert.equal(got.err, null);
      assert.deepEqual(got.result, [{ address: '93.184.216.34', family: 4 }]);
      let got2;
      lookup('irrelevant.example', {}, (err, address, family) => { got2 = { err, address, family }; });
      assert.deepEqual(got2, { err: null, address: '93.184.216.34', family: 4 });
    });

    it('refuses with no url query param, before any DNS lookup', async () => {
      const res = await get('/api/v6/unfurl');
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'BAD_REQUEST');
    });

    it('refuses a non-operator caller', async () => {
      const res = await get('/api/v6/unfurl?url=https%3A%2F%2Fexample.com', { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });

    it('builds a GitHub card straight from the URL, with no DNS lookup or fetch at all', async () => {
      let lookupCalled = false;
      dns.promises.lookup = async () => { lookupCalled = true; return []; };
      const res = await get('/api/v6/unfurl?url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets%2Fpull%2F42');
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res).preview, { kind: 'github', url: 'https://github.com/acme/widgets/pull/42', owner: 'acme', repo: 'widgets', entityKind: 'pull', number: 42 });
      assert.equal(lookupCalled, false, 'a GitHub URL never needs a DNS lookup');
    });

    it('refuses a literal loopback target before any DNS lookup (the fast, host-string check)', async () => {
      let lookupCalled = false;
      dns.promises.lookup = async () => { lookupCalled = true; return []; };
      const res = await get('/api/v6/unfurl?url=http%3A%2F%2F127.0.0.1%2Fsecret');
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'UNFURL_TARGET_UNSAFE');
      assert.equal(lookupCalled, false);
    });

    it('refuses a public-looking hostname whose DNS answer rebinds to a private address — the fetch-time check the literal-host check cannot see', async () => {
      dns.promises.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const res = await get('/api/v6/unfurl?url=https%3A%2F%2Ftotally-public-looking.example%2Fpage');
      assert.equal(res.statusCode, 502, res.body);
      assert.equal(json(res).code, 'UNFURL_FETCH_FAILED');
      assert.match(json(res).error, /RESOLVED_LOOPBACK/);
    });

    it('fetches, parses Open Graph tags, and caches the result for the next identical request', async () => {
      dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      stubRequest(https, {
        statusCode: 200,
        body: '<html><head><meta property="og:title" content="A Real Page"><meta property="og:description" content="Nice."></head></html>'
      });
      let requestCalls = 0;
      const stubbed = https.request;
      https.request = (opts, cb) => { requestCalls += 1; return stubbed(opts, cb); };
      const url = 'https://totally-public-looking.example/page';
      const first = await get(`/api/v6/unfurl?url=${encodeURIComponent(url)}`);
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(json(first).preview, { kind: 'link-unfurl', url, title: 'A Real Page', description: 'Nice.' });
      assert.equal(json(first).cached, undefined);

      const second = await get(`/api/v6/unfurl?url=${encodeURIComponent(url)}`);
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(json(second).cached, true);
      assert.equal(requestCalls, 1, 'the second request answered from cache, never re-fetched');
    });

    it('answers 502 when the fetch itself errors (no og: tags to parse either way)', async () => {
      dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      https.request = (_opts, _cb) => ({ on(event, fn) { if (event === 'error') fn(new Error('boom')); }, end() {}, destroy() {} });
      const res = await get(`/api/v6/unfurl?url=${encodeURIComponent('https://some-other-public-host.example/')}`);
      assert.equal(res.statusCode, 502, res.body);
      assert.equal(json(res).code, 'UNFURL_FETCH_FAILED');
    });
  });

  describe('Portable Fleet Template Spec routes (#3115)', () => {
    it('GET /api/v6/fleet-templates/bundled-specs lists both reference specs and the ecosystem directory link', async () => {
      const res = await get('/api/v6/fleet-templates/bundled-specs');
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      assert.deepEqual(Object.keys(body.specs).sort(), ['ai-design-agency', 'software-factory-10-role']);
      assert.equal(body.specs['software-factory-10-role'].seats.length, 10);
      assert.equal(body.ecosystemDirectory.marketplaceUrl, 'https://tangleclaw.com/marketplace');
    });

    it('GET /api/v6/projects/:id/fleet-spec exports a single project as a valid, importable spec', async () => {
      const pid = await seedProject('TangleClaw');
      const res = await get(`/api/v6/projects/${pid}/fleet-spec`);
      assert.equal(res.statusCode, 200, res.body);
      const { spec } = json(res);
      assert.equal(spec.metadata.name, 'TangleClaw');
      // supervisory: true even though the inferred role isn't 'PM' — a
      // 1-seat export's only seat stands in as the fleet's launch trigger
      // (validateFleetSpec requires at least one).
      assert.deepEqual(spec.seats, [{ seatId: 'TangleClaw', displayNameSuffix: 'TangleClaw', role: 'Builder', supervisory: true, launchPolicy: 'immediate', recommendedEngine: 'claude', fallbackEngines: [] }]);
      // A deliberate scope reduction (documented in the route's own doc
      // comment): this car has no route into rules/charter/shared-docs, so
      // these export empty/null, not fabricated.
      assert.deepEqual(spec.rules, []);
      assert.equal(spec.charterTemplate, null);
      assert.deepEqual(spec.sharedDocuments, []);
      // Round-trips through the module's own validator cleanly.
      const preview = await post('/api/v6/fleet-templates/validate-spec', { spec });
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(json(preview).preview.seatCount, 1);
    });

    it('GET .../fleet-spec?members=... exports a multi-seat fleet, inferring each seat\'s role from its name', async () => {
      const pmId = await seedProject('Monad-PM');
      await seedProject('Monad-Builder-a');
      const res = await get(`/api/v6/projects/${pmId}/fleet-spec?members=${encodeURIComponent('Monad-PM,Monad-Builder-a')}`);
      assert.equal(res.statusCode, 200, res.body);
      const { spec } = json(res);
      assert.equal(spec.metadata.name, 'Monad');
      assert.deepEqual(spec.seats.map((s) => [s.seatId, s.role, s.supervisory]), [['Monad-PM', 'PM', true], ['Monad-Builder-a', 'Builder', false]]);
    });

    it('GET .../fleet-spec 404s for an unknown project id', async () => {
      const res = await get('/api/v6/projects/999999/fleet-spec');
      assert.equal(res.statusCode, 404, res.body);
    });

    it('POST /api/v6/fleet-templates/validate-spec previews a bundled spec without creating anything', async () => {
      const bundled = await get('/api/v6/fleet-templates/bundled-specs');
      const spec = json(bundled).specs['ai-design-agency'];
      const res = await post('/api/v6/fleet-templates/validate-spec', { spec });
      assert.equal(res.statusCode, 200, res.body);
      const { preview } = json(res);
      assert.equal(preview.seatCount, 8);
      assert.equal(preview.metadata.name, 'AI Design & Creative Agency');
    });

    it('POST /api/v6/fleet-templates/validate-spec refuses an invalid spec with the real validator\'s errors', async () => {
      const res = await post('/api/v6/fleet-templates/validate-spec', { spec: { not: 'a spec' } });
      assert.equal(res.statusCode, 400, res.body);
      assert.ok(Array.isArray(json(res).errors) && json(res).errors.length > 0);
    });

    it('POST /api/v6/fleet-templates/apply-spec provisions a real project per seat, named <fleetName>-<seat>', async () => {
      // createProject scaffolds a REAL directory via config.projectsDir —
      // independent of store._setBasePath(tempDir) above (#2604's own
      // "config.projectsDir does not scope with the store redirect"
      // finding) — so this MUST point projectsDir at tempDir itself, or
      // it scaffolds real directories under the operator's actual
      // ~/Projects. Restored in this same test, not just left to the
      // outer afterEach, since nothing else here needs the real default.
      const cfg = store.config.load();
      const realProjectsDir = cfg.projectsDir;
      cfg.projectsDir = tempDir;
      store.config.save(cfg);
      try {
        const bundled = await get('/api/v6/fleet-templates/bundled-specs');
        const spec = json(bundled).specs['ai-design-agency'];
        const res = await post('/api/v6/fleet-templates/apply-spec', { spec, fleetName: 'Zenith' });
        assert.equal(res.statusCode, 200, res.body);
        const { created, failed } = json(res);
        assert.deepEqual(failed, []);
        assert.deepEqual(created.map((c) => c.name).sort(), [
          'Zenith-Art Director', 'Zenith-Critic', 'Zenith-Integrator', 'Zenith-Lane A', 'Zenith-Lane B', 'Zenith-Lane C', 'Zenith-Observer', 'Zenith-PM'
        ].sort());
        for (const c of created) {
          assert.ok(store.getDb().prepare('SELECT id FROM projects WHERE id = ?').get(c.id), `${c.name} is a real row`);
          assert.ok(fs.existsSync(path.join(tempDir, c.name)), `${c.name}'s directory landed under tempDir, never the real projects dir`);
        }
      } finally {
        const restoreCfg = store.config.load();
        restoreCfg.projectsDir = realProjectsDir;
        store.config.save(restoreCfg);
      }
    });

    it('POST /api/v6/fleet-templates/apply-spec refuses an invalid spec, creating nothing', async () => {
      const res = await post('/api/v6/fleet-templates/apply-spec', { spec: { not: 'a spec' }, fleetName: 'X' });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).created, undefined);
    });
  });

  // #3175 (Car V654-W1-D, Gate 4 settled sprint report enforcement): these
  // two routes are mounted live by server.js (#2644 router, Ruling A774).
  // `getSyncStatus`/`getReportsHubHtml` are wired there only when THIS
  // MACHINE happens to have the real `TangleClaw-Shared` checkout on disk
  // (server.js's own `fs.existsSync` mount-time guard) -- true on this
  // operator's own machine, not guaranteed elsewhere (CI, a fresh clone),
  // so `roadmapSyncStatus`'s presence/content is never asserted here.
  // `getSprintReportHtml` has NO server.js wiring at all yet (#3175's known
  // follow-up, outside this car's file envelope -- flagged to the PM) and
  // so `settled`/`postMortem` cannot be exercised end-to-end from any
  // machine. These tests instead pin the open-read wiring these routes
  // already have through the real `handleRequest` path, as a regression
  // net for #3175's `lib/native-sprint-tracker.js` and
  // `lib/routes/sprint-wave-routes.js` changes.
  describe('Sprint Waves & Reports routes (#2644, #3175)', () => {
    it('GET /api/sprint-waves answers 200 with no live wave runs yet, open to any caller', async () => {
      // roadmapSyncStatus itself is NOT asserted either way here: whether it
      // appears depends on whether THIS machine happens to have the real
      // `TangleClaw-Shared` checkout on disk (server.js's own
      // `fs.existsSync` mount-time guard, same operator-machine-only
      // dependency `test/native-sprint-tracker.test.js`'s #3166/#3175 suites
      // already document) -- never something this sandboxed temp-dir test
      // controls or should assume either way.
      const res = await get('/api/sprint-waves', { operator: false });
      assert.equal(res.statusCode, 200, res.body);
      const body = json(res);
      assert.equal(body.ok, true);
      assert.deepEqual(body.waves, []);
    });

    it('GET /api/sprint-reports/:version 404s an unknown version through the real handler', async () => {
      const res = await get('/api/sprint-reports/v0.0.1', { operator: false });
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(json(res).code, 'NOT_FOUND');
    });

    it('GET /api/sprint-reports/:version refuses a malformed version 400 (#3087)', async () => {
      const res = await get('/api/sprint-reports/not-a-version', { operator: false });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(json(res).code, 'BAD_REQUEST');
    });

    it('POST /api/sprint-waves/sync requires operator/Master authorization', async () => {
      const res = await post('/api/sprint-waves/sync', {}, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });
  });

  // #3325 (PRR-A R-Gate Round 1, BLOCKING 1): `?projectId=` must not let a
  // caller read a DIFFERENT project's docs/releases -- the exact
  // cross-project document disclosure this guards against. Each project
  // gets a real `docs/releases/vX.Y.Z.md` under its own path, with a
  // version only that project's own checkout carries, so a leaked read is
  // directly observable in `snapshot.reports`.
  describe('GET /api/sprint-waves ?projectId= authorization (#3325, PRR-A R-Gate Round 1 BLOCKING 1)', () => {
    let projectA;
    let projectB;
    let boundA;

    before(() => {
      projectA = store.projects.create({ name: `scope-proj-a-${Date.now()}`, path: path.join(tempDir, 'scope-proj-a') });
      projectB = store.projects.create({ name: `scope-proj-b-${Date.now()}`, path: path.join(tempDir, 'scope-proj-b') });
      for (const [project, version, title] of [[projectA, 'v1.1.1', 'Project A Release'], [projectB, 'v2.2.2', 'Project B Release']]) {
        const releasesDir = path.join(project.path, 'docs', 'releases');
        fs.mkdirSync(releasesDir, { recursive: true });
        fs.writeFileSync(path.join(releasesDir, `${version}.md`), `# ${title}\n`);
      }
      boundA = bindProject(projectA);
    });

    function reportIds(res) {
      return json(res).snapshot.reports.map((r) => r.id);
    }

    it('a project session naming its OWN projectId reads its own reports, unaffected', async () => {
      const res = await get(`/api/sprint-waves?projectId=${projectA.id}`, { operator: false, headers: boundA.headers });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(reportIds(res), ['v1.1.1']);
    });

    it('a project session naming ANOTHER project\'s id is refused the disclosure, falling back to its own reports instead', async () => {
      const res = await get(`/api/sprint-waves?projectId=${projectB.id}`, { operator: false, headers: boundA.headers });
      assert.equal(res.statusCode, 200, res.body);
      const ids = reportIds(res);
      assert.ok(!ids.includes('v2.2.2'), `must not disclose project B's report; got ${JSON.stringify(ids)}`);
      assert.deepEqual(ids, ['v1.1.1'], 'falls back to the caller\'s own bound project, not an empty/unconfigured read');
    });

    it('an unbound caller naming a project id gets no disclosure either, falling back to this server\'s own default', async () => {
      const res = await get(`/api/sprint-waves?projectId=${projectB.id}`, { operator: false });
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(!reportIds(res).includes('v2.2.2'), 'an unbound caller must not be able to read project B\'s reports by naming its id');
    });

    it('the operator naming a project id IS honoured -- unrestricted, consistent with how the operator is treated everywhere else', async () => {
      const res = await get(`/api/sprint-waves?projectId=${projectB.id}`);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(reportIds(res), ['v2.2.2']);
    });
  });

  // #3345 (#3325 fast-follow, outside this car's originally-declared file
  // scope -- flagged to PM; this is the one place `_v6ResolveSprintScope`'s
  // real groupId/sharedDir/memberProjectIds resolution is end-to-end tested
  // against a real store.projectGroups DB, not a fake `resolveScope` dep
  // (that's `test/sprint-wave-routes.test.js`'s own job, and it can't reach
  // this function at all): a train launched from one fleet seat must still
  // show its cars when a SIBLING seat of the same fleet is the one clicked.
  describe('GET /api/sprint-waves fleet-wide member-seat resolution (#3345)', () => {
    let seatPm;
    let seatBuilder;
    let seatOutsideFleet;
    let fleetGroup;
    let boundBuilder;

    before(() => {
      seatPm = store.projects.create({ name: `fleet-pm-${Date.now()}`, path: path.join(tempDir, 'fleet-pm') });
      seatBuilder = store.projects.create({ name: `fleet-builder-${Date.now()}`, path: path.join(tempDir, 'fleet-builder') });
      seatOutsideFleet = store.projects.create({ name: `fleet-outsider-${Date.now()}`, path: path.join(tempDir, 'fleet-outsider') });
      fleetGroup = store.projectGroups.create({ name: `test-fleet-${Date.now()}`, sharedDir: path.join(tempDir, 'fleet-shared') });
      store.projectGroups.addMember(fleetGroup.id, seatPm.id);
      store.projectGroups.addMember(fleetGroup.id, seatBuilder.id);
      boundBuilder = bindProject(seatBuilder);
    });

    it('clicking a sibling seat with no run of its own still sees the fleet\'s run, recorded under a DIFFERENT seat', async () => {
      const created = await post(`/api/v6/projects/${seatPm.id}/wave-runs`, {
        fleetId: 'test-fleet', cars: [{ id: 'carFromPmSeat', fileScope: ['lib/example.js'] }]
      });
      assert.equal(created.statusCode, 201, created.body);
      const res = await get(`/api/sprint-waves?projectId=${seatBuilder.id}`, { operator: false, headers: boundBuilder.headers });
      assert.equal(res.statusCode, 200, res.body);
      // Not asserting the full list (THIS SERVER'S own real `docs/releases/`
      // versions also synthesize fallback train rows alongside it, same as
      // every project this group's fake sharedDir leaves unresolved) -- the
      // one thing #3345 exists to prove is that the REAL car, recorded
      // under the OTHER seat, is actually present rather than replaced by a
      // generic fallback placeholder for its own version.
      assert.ok(json(res).snapshot.cars.some((c) => c.id === 'carFromPmSeat'), 'the sibling seat\'s real car must be visible');
    });

    it('a project outside the fleet group never sees that fleet\'s car, even by exact id guess', async () => {
      const res = await get(`/api/sprint-waves?projectId=${seatOutsideFleet.id}`);
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(!json(res).snapshot.cars.some((c) => c.id === 'carFromPmSeat'), 'an unrelated project must never see this fleet\'s car');
    });
  });

  // #3345 addendum (#3347, outside this car's originally-declared scope --
  // flagged to and explicitly requested by PM, with TC-Lane-Arc Ruling
  // A1273 pre-ratifying the file list): `_v6LogicalProjectIdsForLegacyProject`
  // now also grants every logical project belonging to a FLEET PEER (same
  // `project_group_members` group), so a bound Fleet PM/Observer session
  // can read/disposition the whole fleet's Kaizen items, not only the ones
  // auto-provisioned under its own single project -- while a project
  // outside every one of its groups still gets nothing.
  describe('Kaizen item read scope widens to fleet peers in the same project group (#3345 addendum, #3347)', () => {
    let seatA;
    let seatB;
    let seatOutsider;
    let group;
    let boundB;
    let boundOutsider;
    let itemId;

    before(async () => {
      seatA = store.projects.create({ name: `kaizen-fleet-a-${Date.now()}`, path: path.join(tempDir, 'kaizen-fleet-a') });
      seatB = store.projects.create({ name: `kaizen-fleet-b-${Date.now()}`, path: path.join(tempDir, 'kaizen-fleet-b') });
      seatOutsider = store.projects.create({ name: `kaizen-outsider-${Date.now()}`, path: path.join(tempDir, 'kaizen-outsider') });
      group = store.projectGroups.create({ name: `kaizen-fleet-${Date.now()}` });
      store.projectGroups.addMember(group.id, seatA.id);
      store.projectGroups.addMember(group.id, seatB.id);
      boundB = bindProject(seatB);
      boundOutsider = bindProject(seatOutsider);

      // Detected AS seat A, scoped to seat A's own auto-provisioned logical
      // project (the `v6_legacy_project_insert` trigger provisions one for
      // every project on creation) -- the operator creates it since only
      // the real caller identity matters for the READ assertions below.
      const created = await post('/api/v6/kaizen/items', {
        originSprint: 'v6.6.8', findingId: `F-${Date.now()}`, defectCategory: 'test', rootCause: 'test root cause',
        correctiveActionSpec: 'test corrective action', ownerRole: 'Builder', verificationClass: 'A_DETERMINISTIC',
        targetMetric: 'test metric', logicalProjectId: `lp-${seatA.id}`
      });
      assert.equal(created.statusCode, 201, created.body);
      itemId = json(created).id;
    });

    it('a fleet PEER (same group, different project) can read the item', async () => {
      const res = await get(`/api/v6/kaizen/items/${itemId}`, { operator: false, headers: boundB.headers });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).id, itemId);
    });

    it('a project outside every one of seat A\'s groups still cannot read it', async () => {
      const res = await get(`/api/v6/kaizen/items/${itemId}`, { operator: false, headers: boundOutsider.headers });
      assert.equal(res.statusCode, 404, res.body);
    });
  });
});
