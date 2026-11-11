'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
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
});
