'use strict';

// #2352 (Architect Ruling A475-W2C-TRUST, confirmed A475-W2C-R1): the four
// HTTP routes over `lib/permission-requests.js`. The state machine itself
// (expiry, supersession, replay/conflict, Discord-bridge provenance) is
// covered by `test/permission-requests.test.js`; this file is the trust
// boundary each route adds on top — who may create, read, and decide.

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const master = require('../lib/master');
const { createServer } = require('../server');
const { bindProject, sendAs, operatorOf, operatorHeaders } = require('./_shared-docs-callers');

const MASTER_LAUNCH_ID = 'master-live-launch-id';

describe('permission-request routes (#2352)', () => {
  let tmpDir;
  let server;
  let project;
  let binding;
  let writeHeaders;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-permissions-'));
    store._setBasePath(tmpDir);
    store.init();

    const dir = path.join(tmpDir, 'proj-only-dir');
    fs.mkdirSync(dir);
    project = store.projects.create({ name: 'perm-route-project', path: dir, engine: 'claude' });
    binding = bindProject(project);

    mock.method(master, 'liveMasterLaunchId', () => ({ launchId: MASTER_LAUNCH_ID, answered: true, cause: null }));

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    writeHeaders = await operatorOf(server)();
    // On an OPEN install (no login configured, this scratch store's default)
    // `operatorOf` answers same-origin headers alone — a real write also
    // needs the dashboard's own open-install token, minted per `GET /api/auth/me`.
    const me = await sendAs(server, 'GET', '/api/auth/me', undefined, operatorHeaders(server));
    if (me.data && me.data.openInstallToken) writeHeaders = { ...writeHeaders, 'x-tc-open-token': me.data.openInstallToken };
  });

  after(async () => {
    mock.restoreAll();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a request as the bound project launch, with sane defaults.
   * @param {object} [body]
   * @returns {Promise<{status: number, data: object}>}
   */
  function createAs(headers, body = {}) {
    return sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(project.name)}/permissions`, {
      requestId: body.requestId || `req-${Math.random().toString(36).slice(2)}`,
      scope: 'repo-write', scopeTarget: 'origin/main', gate: 'test-gate', actionSummary: 'push a commit', ttlMs: 60000,
      ...body
    }, headers);
  }

  it('lets the bound project launch create a permission request', async () => {
    const res = await createAs(binding.headers);
    assert.equal(res.status, 201);
    assert.equal(res.data.request.state, 'pending');
    assert.equal(res.data.request.sessionId, binding.sessionId);
  });

  it('refuses creation from a caller that is not this project\'s own verified launch', async () => {
    const asOperator = await createAs(writeHeaders);
    assert.equal(asOperator.status, 403);
    const asNobody = await createAs({});
    assert.equal(asNobody.status, 403);
  });

  it('is idempotent on repeated requestId: same row, 200 not 201', async () => {
    const first = await createAs(binding.headers, { requestId: 'fixed-req-id' });
    const second = await createAs(binding.headers, { requestId: 'fixed-req-id' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.data.request.requestId, first.data.request.requestId);
  });

  it('lets the Operator, the Master, and the requesting project list pending requests; refuses anyone else', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-listing' });
    const listUrl = `/api/sessions/${encodeURIComponent(project.name)}/permissions?state=pending`;

    const asOperator = await sendAs(server, 'GET', listUrl, undefined, writeHeaders);
    assert.equal(asOperator.status, 200);
    assert.ok(asOperator.data.requests.some((r) => r.requestId === created.data.request.requestId));

    const asMaster = await sendAs(server, 'GET', listUrl, undefined, { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(asMaster.status, 200);

    const asProject = await sendAs(server, 'GET', listUrl, undefined, binding.headers);
    assert.equal(asProject.status, 200);

    const asNobody = await sendAs(server, 'GET', listUrl);
    assert.equal(asNobody.status, 403);
  });

  it('the GET receipt route marks receiptDeliveredAt only once decided, and only when the requesting launch reads it, not the Operator', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-receipt' });
    const requestId = created.data.request.requestId;
    const receiptUrl = `/api/permissions/requests/${encodeURIComponent(requestId)}`;

    // Still pending: neither reader's read marks a receipt — there is no
    // decision yet to receipt.
    const pendingProjectRead = await sendAs(server, 'GET', receiptUrl, undefined, binding.headers);
    assert.equal(pendingProjectRead.status, 200);
    assert.equal(pendingProjectRead.data.request.receiptDeliveredAt, null, 'a pending request has no receipt to deliver');

    const decide = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', expectedScope: 'repo-write' }, writeHeaders);
    assert.equal(decide.status, 201);

    const operatorRead = await sendAs(server, 'GET', receiptUrl, undefined, writeHeaders);
    assert.equal(operatorRead.status, 200);
    assert.equal(operatorRead.data.request.receiptDeliveredAt, null, 'an Operator read is not the requesting launch\'s delivery');

    const projectRead = await sendAs(server, 'GET', receiptUrl, undefined, binding.headers);
    assert.equal(projectRead.status, 200);
    assert.ok(projectRead.data.request.receiptDeliveredAt, 'the requesting launch\'s own read, after a decision exists, marks delivery');
  });

  it('404s a receipt read for an unknown request id, for every caller', async () => {
    const res = await sendAs(server, 'GET', '/api/permissions/requests/perm_does_not_exist', undefined, writeHeaders);
    assert.equal(res.status, 404);
    assert.equal(res.data.code, 'PERMISSION_REQUEST_NOT_FOUND');
  });

  it('the Operator can grant a pending request through the decide route', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-operator-decide' });
    const requestId = created.data.request.requestId;
    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', expectedScope: 'repo-write' }, writeHeaders);
    assert.equal(res.status, 201);
    assert.equal(res.data.request.state, 'granted');
    assert.equal(res.data.request.decidedBySurface, 'dashboard');
  });

  it('refuses a decide attempt from neither the Operator nor a verified Master relay', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-refused-decider' });
    const requestId = created.data.request.requestId;

    const asProjectLaunch = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant' }, binding.headers);
    assert.equal(asProjectLaunch.status, 403, 'a project launch may ask, but may not decide its own request');

    const asNobody = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`, { decision: 'grant' });
    assert.equal(asNobody.status, 403);
  });

  it('a verified Master relay carrying bridgeRouteId reaches the Discord-bridge decision path', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-bridge-decide' });
    const requestId = created.data.request.requestId;
    // No bridge_routes row exists for "no-such-route" — this proves the route
    // dispatched into `decideFromBridge` (which answers its own refusal) and
    // not into the dashboard path or a blanket 403; the state-machine side of
    // this path is exhaustively covered in test/permission-requests.test.js.
    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', bridgeRouteId: 'no-such-route', replyText: `grant ${requestId}` },
      { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'PERMISSION_REQUEST_INVALID');
  });

  /**
   * Insert a minimal, valid `bridge_routes` row plus its persisted inbound
   * `bridge_route_bodies` row — both tables are created by `store.init()`
   * itself (`lib/bridge-schema.js`), so this HTTP-layer test needs no bridge
   * module of its own. Mirrors `test/permission-requests.test.js`'s own
   * helper of the same shape.
   * @param {{routeId: string, authorId: string, externalId: string, inboundText: string}} fields
   * @returns {void}
   */
  function insertBridgeRoute({ routeId, authorId, externalId, inboundText }) {
    const now = new Date().toISOString();
    store.getDb().prepare(
      `INSERT INTO bridge_routes
         (route_id, external_id, author_id, space_id, channel_id, body_digest, state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'space-1', 'channel-1', ?, 'accepted', 1, ?, ?)`
    ).run(routeId, externalId, authorId, '0'.repeat(64), now, now);
    store.getDb().prepare(
      "INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES (?, 'inbound', ?, ?, ?)"
    ).run(routeId, inboundText, '0'.repeat(64), now);
  }

  it('409s PERMISSION_BRIDGE_DECISION_MISMATCH over HTTP: a persisted "refuse" message cannot be applied as a grant (PRR-B Round 2)', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-bridge-contradiction' });
    const requestId = created.data.request.requestId;
    insertBridgeRoute({ routeId: 'api-route-contradiction', authorId: 'api-author-1', externalId: 'api-ext-contradiction', inboundText: `refuse ${requestId}` });
    store.getDb().prepare(
      "INSERT OR REPLACE INTO bridge_settings (key, value, updated_by, updated_at) VALUES ('allow.author', ?, 'operator', ?)"
    ).run('api-author-1', new Date().toISOString());

    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', bridgeRouteId: 'api-route-contradiction', replyText: `refuse ${requestId}` },
      { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'PERMISSION_BRIDGE_DECISION_MISMATCH');
  });

  it('409s PERMISSION_BRIDGE_DECISION_AMBIGUOUS over HTTP: a persisted message naming no decision word cannot be applied either way (PRR-B Round 2)', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-bridge-no-decision' });
    const requestId = created.data.request.requestId;
    insertBridgeRoute({ routeId: 'api-route-no-decision', authorId: 'api-author-1', externalId: 'api-ext-no-decision', inboundText: `see ${requestId}` });
    store.getDb().prepare(
      "INSERT OR REPLACE INTO bridge_settings (key, value, updated_by, updated_at) VALUES ('allow.author', ?, 'operator', ?)"
    ).run('api-author-1', new Date().toISOString());

    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', bridgeRouteId: 'api-route-no-decision', replyText: `see ${requestId}` },
      { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'PERMISSION_BRIDGE_DECISION_AMBIGUOUS');
  });

  it('409s PERMISSION_BRIDGE_DECISION_AMBIGUOUS over HTTP: a negated decision word ("do not grant") is not read as a grant (PRR-B Round 3)', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-bridge-negated' });
    const requestId = created.data.request.requestId;
    insertBridgeRoute({ routeId: 'api-route-negated', authorId: 'api-author-1', externalId: 'api-ext-negated', inboundText: `do not grant ${requestId}` });
    store.getDb().prepare(
      "INSERT OR REPLACE INTO bridge_settings (key, value, updated_by, updated_at) VALUES ('allow.author', ?, 'operator', ?)"
    ).run('api-author-1', new Date().toISOString());

    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', bridgeRouteId: 'api-route-negated', replyText: `do not grant ${requestId}` },
      { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'PERMISSION_BRIDGE_DECISION_AMBIGUOUS');
  });

  it('409s PERMISSION_BRIDGE_DECISION_AMBIGUOUS over HTTP: an embedded word ("vagrant") is not read as naming "grant" (PRR-B Round 3)', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-bridge-embedded' });
    const requestId = created.data.request.requestId;
    insertBridgeRoute({ routeId: 'api-route-embedded', authorId: 'api-author-1', externalId: 'api-ext-embedded', inboundText: `vagrant ${requestId}` });
    store.getDb().prepare(
      "INSERT OR REPLACE INTO bridge_settings (key, value, updated_by, updated_at) VALUES ('allow.author', ?, 'operator', ?)"
    ).run('api-author-1', new Date().toISOString());

    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', bridgeRouteId: 'api-route-embedded', replyText: `vagrant ${requestId}` },
      { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'PERMISSION_BRIDGE_DECISION_AMBIGUOUS');
  });

  it('409s PERMISSION_BRIDGE_DECISION_AMBIGUOUS over HTTP: a persisted question ("Can you grant perm_X?") is not a command (PRR-B Round 5)', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-bridge-question' });
    const requestId = created.data.request.requestId;
    insertBridgeRoute({ routeId: 'api-route-question', authorId: 'api-author-1', externalId: 'api-ext-question', inboundText: `Can you grant ${requestId}?` });
    store.getDb().prepare(
      "INSERT OR REPLACE INTO bridge_settings (key, value, updated_by, updated_at) VALUES ('allow.author', ?, 'operator', ?)"
    ).run('api-author-1', new Date().toISOString());

    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', bridgeRouteId: 'api-route-question', replyText: `Can you grant ${requestId}?` },
      { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'PERMISSION_BRIDGE_DECISION_AMBIGUOUS');
  });

  it('409s PERMISSION_BRIDGE_DECISION_AMBIGUOUS over HTTP: a persisted conditional ("If you want to grant perm_X, ask me first") is not a command (PRR-B Round 5)', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-bridge-conditional' });
    const requestId = created.data.request.requestId;
    insertBridgeRoute({ routeId: 'api-route-conditional', authorId: 'api-author-1', externalId: 'api-ext-conditional', inboundText: `If you want to grant ${requestId}, ask me first` });
    store.getDb().prepare(
      "INSERT OR REPLACE INTO bridge_settings (key, value, updated_by, updated_at) VALUES ('allow.author', ?, 'operator', ?)"
    ).run('api-author-1', new Date().toISOString());

    const res = await sendAs(server, 'POST', `/api/permissions/requests/${encodeURIComponent(requestId)}/decide`,
      { decision: 'grant', bridgeRouteId: 'api-route-conditional', replyText: `If you want to grant ${requestId}, ask me first` },
      { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'PERMISSION_BRIDGE_DECISION_AMBIGUOUS');
  });
});
