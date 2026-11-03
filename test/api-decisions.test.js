'use strict';

// #2037 (v5.57.0 Wave 1 Car 57-D): the four HTTP routes over
// `lib/decision-routing.js`. The state machine itself (digest binding,
// expiry, supersession, replay/conflict) is covered by
// `test/decision-routing.test.js`; this file is the trust boundary each
// route adds on top — who may create, read, and answer. Mirrors
// `test/api-permissions.test.js`.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const { bindProject, sendAs, operatorOf, operatorHeaders } = require('./_shared-docs-callers');

describe('decision-request routes (#2037)', () => {
  let tmpDir;
  let server;
  let project;
  let projectDir;
  let binding;
  let writeHeaders;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-decisions-'));
    store._setBasePath(tmpDir);
    store.init();

    projectDir = path.join(tmpDir, 'decision-route-project-dir');
    fs.mkdirSync(projectDir);
    project = store.projects.create({ name: 'decision-route-project', path: projectDir, engine: 'claude' });
    binding = bindProject(project);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    writeHeaders = await operatorOf(server)();
    const me = await sendAs(server, 'GET', '/api/auth/me', undefined, operatorHeaders(server));
    if (me.data && me.data.openInstallToken) writeHeaders = { ...writeHeaders, 'x-tc-open-token': me.data.openInstallToken };
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a decision request as the bound project launch, with sane defaults.
   * @param {Record<string, string>} headers
   * @param {object} [body]
   * @returns {Promise<{status: number, data: object}>}
   */
  function createAs(headers, body = {}) {
    return sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(project.name)}/decisions`, {
      requestId: body.requestId || `req-${Math.random().toString(36).slice(2)}`,
      prompt: 'Proceed with the deploy?', choices: ['yes', 'no'], requiredAuthority: 'human',
      gate: 'test-gate', ttlMs: 60000,
      ...body
    }, headers);
  }

  it('lets the bound project launch create a decision request', async () => {
    const res = await createAs(binding.headers);
    assert.equal(res.status, 201);
    assert.equal(res.data.request.state, 'waiting_decision');
    assert.equal(res.data.request.sessionId, binding.sessionId);
    assert.equal(res.data.request.promptDigest.length, 64);
  });

  it('refuses creation from a caller that is not this project\'s own verified launch', async () => {
    const asOperator = await createAs(writeHeaders);
    assert.equal(asOperator.status, 403);
    const asNobody = await createAs({});
    assert.equal(asNobody.status, 403);
  });

  it('is idempotent on repeated requestId: same row, 200 not 201', async () => {
    const first = await createAs(binding.headers, { requestId: 'fixed-decision-req-id' });
    const second = await createAs(binding.headers, { requestId: 'fixed-decision-req-id' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.data.request.decisionId, first.data.request.decisionId);
  });

  it('refuses a malformed body (fewer than two choices) with 400', async () => {
    const res = await createAs(binding.headers, { requestId: 'req-bad-choices', choices: ['only-one'] });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'DECISION_REQUEST_INVALID');
  });

  it('lets the Operator and the requesting project list the session\'s decisions; refuses anyone else', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-listing' });
    const listUrl = `/api/sessions/${encodeURIComponent(project.name)}/decisions`;

    const asOperator = await sendAs(server, 'GET', listUrl, undefined, writeHeaders);
    assert.equal(asOperator.status, 200);
    assert.ok(asOperator.data.requests.some((r) => r.decisionId === created.data.request.decisionId));

    const asProject = await sendAs(server, 'GET', listUrl, undefined, binding.headers);
    assert.equal(asProject.status, 200);

    const asNobody = await sendAs(server, 'GET', listUrl);
    assert.equal(asNobody.status, 403);
  });

  it('404s a single read for an unknown decision id', async () => {
    const res = await sendAs(server, 'GET', '/api/decisions/dec_does_not_exist', undefined, writeHeaders);
    assert.equal(res.status, 404);
    assert.equal(res.data.code, 'DECISION_REQUEST_NOT_FOUND');
  });

  it('reads a single decision as the Operator or the requesting project; refuses anyone else', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-single-read' });
    const readUrl = `/api/decisions/${encodeURIComponent(created.data.request.decisionId)}`;

    const asOperator = await sendAs(server, 'GET', readUrl, undefined, writeHeaders);
    assert.equal(asOperator.status, 200);

    const asProject = await sendAs(server, 'GET', readUrl, undefined, binding.headers);
    assert.equal(asProject.status, 200);

    const asNobody = await sendAs(server, 'GET', readUrl);
    assert.equal(asNobody.status, 403);
  });

  it('the Operator can answer a human-authority decision; the requesting launch alone cannot', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-operator-answer' });
    const decisionId = created.data.request.decisionId;
    const promptDigest = created.data.request.promptDigest;

    const asProjectLaunch = await sendAs(server, 'POST', `/api/decisions/${encodeURIComponent(decisionId)}/answer`,
      { answer: 'yes', expectedPromptDigest: promptDigest }, binding.headers);
    assert.equal(asProjectLaunch.status, 403, 'a human-authority decision is Operator-only');

    const res = await sendAs(server, 'POST', `/api/decisions/${encodeURIComponent(decisionId)}/answer`,
      { answer: 'yes', expectedPromptDigest: promptDigest }, writeHeaders);
    assert.equal(res.status, 201);
    assert.equal(res.data.request.state, 'answered');
    assert.equal(res.data.request.answeredBySurface, 'operator');
  });

  it('refuses an answer attempt from nobody', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-nobody-answer' });
    const res = await sendAs(server, 'POST', `/api/decisions/${encodeURIComponent(created.data.request.decisionId)}/answer`,
      { answer: 'yes', expectedPromptDigest: created.data.request.promptDigest });
    assert.equal(res.status, 403);
  });

  it('409s DECISION_PROMPT_MISMATCH over HTTP when the supplied digest is stale', async () => {
    const created = await createAs(binding.headers, { requestId: 'req-for-stale-digest' });
    const res = await sendAs(server, 'POST', `/api/decisions/${encodeURIComponent(created.data.request.decisionId)}/answer`,
      { answer: 'yes', expectedPromptDigest: 'a-stale-digest-from-an-earlier-prompt' }, writeHeaders);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DECISION_PROMPT_MISMATCH');
  });

  it('refuses an autonomous-within-lease answer from the requesting launch when the gate is not allowlisted', async () => {
    const created = await createAs(binding.headers, {
      requestId: 'req-for-unlisted-gate', requiredAuthority: 'autonomous-within-lease', reversible: true, gate: 'not-on-the-list'
    });
    const res = await sendAs(server, 'POST', `/api/decisions/${encodeURIComponent(created.data.request.decisionId)}/answer`,
      { answer: 'yes', expectedPromptDigest: created.data.request.promptDigest }, binding.headers);
    assert.equal(res.status, 403);
  });

  it('lets the requesting launch answer its own autonomous-within-lease, reversible, allowlisted decision', async () => {
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'),
      JSON.stringify({ decisionAutonomousAllowlist: ['re-run-ci'] }));

    const created = await createAs(binding.headers, {
      requestId: 'req-for-allowlisted-gate', requiredAuthority: 'autonomous-within-lease', reversible: true, gate: 're-run-ci'
    });
    const res = await sendAs(server, 'POST', `/api/decisions/${encodeURIComponent(created.data.request.decisionId)}/answer`,
      { answer: 'yes', expectedPromptDigest: created.data.request.promptDigest }, binding.headers);
    assert.equal(res.status, 201);
    assert.equal(res.data.request.state, 'answered');
    assert.equal(res.data.request.answeredBySurface, 'autonomous-lease');

    fs.rmSync(path.join(projectDir, '.tangleclaw'), { recursive: true, force: true });
  });

  it('the Operator may still answer an autonomous-within-lease decision directly (the ceiling)', async () => {
    const created = await createAs(binding.headers, {
      requestId: 'req-for-operator-over-autonomous', requiredAuthority: 'autonomous-within-lease', reversible: true, gate: 'whatever-gate'
    });
    const res = await sendAs(server, 'POST', `/api/decisions/${encodeURIComponent(created.data.request.decisionId)}/answer`,
      { answer: 'no', expectedPromptDigest: created.data.request.promptDigest }, writeHeaders);
    assert.equal(res.status, 201);
    assert.equal(res.data.request.answeredBySurface, 'operator');
  });
});
