'use strict';

// #2888 (Architect Scope Ruling A501-W1C-R1): the HTTP mounting of
// `lib/chunk-boundary-http.js`'s handlers in `lib/routes/sessions.js`. The
// handlers themselves and the state machine underneath are already
// thoroughly covered (test/chunk-boundary-http.test.js, test/chunk-boundary.
// test.js); this file's only job is the HTTP wiring: project-scoping (a
// receipt id must not be reachable across projects, same discipline as the
// merge-gate and governed-wrap routes), access control, and that the real
// server answers what the handlers themselves already return.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const cb = require('../lib/chunk-boundary');
const { createServer } = require('../server');
const { bindProject, sendAs, operatorOf } = require('./_shared-docs-callers');

describe('#2888: /api/sessions/:project/chunk-boundary/* routes (lib/routes/sessions.js)', () => {
  let tmpDir;
  let server;
  let project;
  let binding;
  let writeHeaders;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-chunk-boundary-'));
    store._setBasePath(tmpDir);
    store.init();

    const dir = path.join(tmpDir, 'proj-dir');
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: 'chunk-boundary-route-project', path: dir, engine: 'claude' });
    binding = bindProject(project);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    writeHeaders = await operatorOf(server)();
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const base = () => `/api/sessions/${encodeURIComponent(project.name)}/chunk-boundary`;

  /** @see test/chunk-boundary-http.test.js#validInput, minus projectId -- the route derives it from the URL. */
  function body(overrides = {}) {
    return {
      train: 'v5.67.0', lane: 'TC-Lane-D', planRef: '.tangleclaw/plans/v5670-sprint-charter.md#car-67-b',
      builder: 'TC-Lane-D', assignmentId: 'asg-1', chunkNumber: 1, commitSha: 'a'.repeat(40),
      verificationReceipt: { suite: 'testament-small', passed: 100 }, planCheckpoint: { step: 1 },
      reflectionComplete: true, childAccountingComplete: true, builderAcknowledged: true,
      ...overrides
    };
  }

  it('404s for an unknown project', async () => {
    const r = await sendAs(server, 'GET', '/api/sessions/does-not-exist/chunk-boundary/does-not-exist', undefined, writeHeaders);
    assert.equal(r.status, 404);
  });

  it('creates a receipt with projectId forced from the URL, ignoring a spoofed body value', async () => {
    const r = await sendAs(server, 'POST', `${base()}`, { ...body(), projectId: 999999 }, binding.headers);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.receipt.projectId, project.id);
    assert.equal(r.data.statusSurface.status, 'prepare_clear');
  });

  it('a replay of the same (project, assignment, chunk) answers 200 with the existing receipt', async () => {
    const first = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-replay' }), binding.headers);
    assert.equal(first.status, 201);
    const replay = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-replay' }), binding.headers);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replay, true);
    assert.equal(replay.data.receipt.receiptId, first.data.receipt.receiptId);
  });

  it('a read with no verified access at all is refused on a write, but reads are open to anyone who can name the project', async () => {
    const refused = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-noauth' }), {});
    assert.ok([401, 403].includes(refused.status));
  });

  it('get-by-id -> ready-to-clear -> clear-intent -> clear-outcome -> ready-after-clear, through the real HTTP routes', async () => {
    const created = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-lifecycle' }), binding.headers);
    const receiptId = created.data.receipt.receiptId;

    const got = await sendAs(server, 'GET', `${base()}/${receiptId}`, undefined, writeHeaders);
    assert.equal(got.status, 200);
    assert.equal(got.data.receipt.receiptId, receiptId);

    const ready = await sendAs(server, 'POST', `${base()}/${receiptId}/ready-to-clear`, {}, binding.headers);
    assert.equal(ready.status, 200, JSON.stringify(ready.data));
    assert.equal(ready.data.receipt.state, 'ready_to_clear');

    const intent = await sendAs(server, 'POST', `${base()}/${receiptId}/clear-intent`, { targetSessionId: binding.sessionId }, binding.headers);
    assert.equal(intent.status, 200, JSON.stringify(intent.data));
    assert.equal(intent.data.receipt.state, 'clear_intent_sent');

    const outcome = await sendAs(server, 'POST', `${base()}/${receiptId}/clear-outcome`, { outcome: 'success' }, binding.headers);
    assert.equal(outcome.status, 200, JSON.stringify(outcome.data));

    const acked = await sendAs(server, 'POST', `${base()}/${receiptId}/ready-after-clear`, {}, binding.headers);
    assert.equal(acked.status, 200, JSON.stringify(acked.data));
    assert.equal(acked.data.receipt.state, 'ready_after_clear');
    assert.equal(acked.data.statusSurface.status, 'ready_after_clear');
  });

  it('supersede answers the superseded receipt, and a second call replays idempotently', async () => {
    const created = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-supersede' }), binding.headers);
    const receiptId = created.data.receipt.receiptId;
    const first = await sendAs(server, 'POST', `${base()}/${receiptId}/supersede`, { reason: 're-planned' }, binding.headers);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.ok(first.data.receipt.supersededAt);
    const second = await sendAs(server, 'POST', `${base()}/${receiptId}/supersede`, { reason: 're-planned again' }, binding.headers);
    assert.equal(second.status, 200);
    assert.equal(second.data.replay, true);
  });

  it('an invalid transition answers 409 with the handler\'s own code', async () => {
    const created = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-bad-transition' }), binding.headers);
    const receiptId = created.data.receipt.receiptId;
    // Still prepare_clear -- clear-intent is only valid from ready_to_clear/clear_intent_sent.
    const r = await sendAs(server, 'POST', `${base()}/${receiptId}/clear-intent`, { targetSessionId: binding.sessionId }, binding.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'CHUNK_BOUNDARY_TRANSITION_INVALID');
  });

  it('get-by-chunk reads the receipt on record for (assignment, chunkNumber), and 400s on a missing/invalid chunkNumber', async () => {
    const created = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-by-chunk', chunkNumber: 3 }), binding.headers);
    const byChunk = await sendAs(server, 'GET', `${base()}?assignmentId=asg-by-chunk&chunkNumber=3`, undefined, writeHeaders);
    assert.equal(byChunk.status, 200, JSON.stringify(byChunk.data));
    assert.equal(byChunk.data.receipt.receiptId, created.data.receipt.receiptId);

    const missing = await sendAs(server, 'GET', `${base()}?assignmentId=asg-by-chunk`, undefined, writeHeaders);
    assert.equal(missing.status, 400);

    const bad = await sendAs(server, 'GET', `${base()}?assignmentId=asg-by-chunk&chunkNumber=not-a-number`, undefined, writeHeaders);
    assert.equal(bad.status, 400);
  });

  it('validate-next-dispatch admits Chunk 2 once Chunk 1\'s receipt reached ready_after_clear, and holds otherwise', async () => {
    const assignmentId = 'asg-dispatch';
    const created = await sendAs(server, 'POST', `${base()}`, body({ assignmentId, chunkNumber: 1 }), binding.headers);
    const receiptId = created.data.receipt.receiptId;

    const holdBeforeReady = await sendAs(server, 'POST', `${base()}/validate-next-dispatch`, {
      candidate: { train: 'v5.67.0', lane: 'TC-Lane-D', builder: 'TC-Lane-D', assignmentId, nextChunkNumber: 2 }
    }, writeHeaders);
    assert.equal(holdBeforeReady.status, 200);
    assert.equal(holdBeforeReady.data.hold, true);

    cb.markReadyToClear(receiptId);
    cb.recordClearIntent(receiptId, { targetSessionId: binding.sessionId });
    cb.recordClearOutcome(receiptId, { outcome: 'success' });
    cb.acknowledgeReadyAfterClear(receiptId);

    const admitted = await sendAs(server, 'POST', `${base()}/validate-next-dispatch`, {
      candidate: { train: 'v5.67.0', lane: 'TC-Lane-D', builder: 'TC-Lane-D', assignmentId, nextChunkNumber: 2 }
    }, writeHeaders);
    assert.equal(admitted.status, 200, JSON.stringify(admitted.data));
    assert.equal(admitted.data.ok, true);
    assert.equal(admitted.data.admission.status, 'admitted');
  });

  it('a project launch bound to a DIFFERENT project may not reach a receipt id through its own :project URL', async () => {
    const otherDir = path.join(tmpDir, 'other-proj-dir');
    fs.mkdirSync(otherDir, { recursive: true });
    const otherProject = store.projects.create({ name: 'other-chunk-boundary-project', path: otherDir, engine: 'claude' });
    const otherBinding = bindProject(otherProject);

    const created = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-cross-project' }), binding.headers);
    const receiptId = created.data.receipt.receiptId;

    const otherBase = `/api/sessions/${encodeURIComponent(otherProject.name)}/chunk-boundary`;
    const read = await sendAs(server, 'GET', `${otherBase}/${receiptId}`, undefined, writeHeaders);
    assert.equal(read.status, 404, JSON.stringify(read.data));
    assert.equal(read.data.code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');

    const mutate = await sendAs(server, 'POST', `${otherBase}/${receiptId}/ready-to-clear`, {}, otherBinding.headers);
    assert.equal(mutate.status, 404, JSON.stringify(mutate.data));
    assert.equal(mutate.data.code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');

    const stillPrepareClear = await sendAs(server, 'GET', `${base()}/${receiptId}`, undefined, writeHeaders);
    assert.equal(stillPrepareClear.data.receipt.state, 'prepare_clear', 'the cross-project attempt changed nothing');
  });

  it('a project launch bound to a DIFFERENT project may not write to THIS project\'s own :project URL by naming it directly (I-Gate R1)', async () => {
    // The exact shape the reviewer reproduced: the attacker names the
    // VICTIM's own URL directly (not its own, as the sibling test above
    // does with a victim receipt id) -- the URL target and the caller's
    // verified project must match, or the create route alone would let any
    // bound launch assert builderAcknowledged:true onto another project's
    // durable chunk-boundary evidence.
    const otherDir = fs.mkdtempSync(path.join(tmpDir, 'attacker-proj-dir-'));
    const attackerProject = store.projects.create({ name: 'chunk-boundary-attacker-project', path: otherDir, engine: 'claude' });
    const attackerBinding = bindProject(attackerProject);

    const forgedCreate = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-forged-create' }), attackerBinding.headers);
    assert.equal(forgedCreate.status, 403, JSON.stringify(forgedCreate.data));
    assert.equal(forgedCreate.data.code, 'FORBIDDEN');

    const byChunk = await sendAs(server, 'GET', `${base()}?assignmentId=asg-forged-create&chunkNumber=1`, undefined, writeHeaders);
    assert.equal(byChunk.data.receipt, null, 'the forged create never happened -- no receipt exists under this project for that chunk');

    // And at least one transition on an EXISTING, legitimately-created
    // receipt of THIS project, attempted through this project's own URL by
    // the same foreign binding.
    const legit = await sendAs(server, 'POST', `${base()}`, body({ assignmentId: 'asg-forged-transition' }), binding.headers);
    const receiptId = legit.data.receipt.receiptId;
    const forgedTransition = await sendAs(server, 'POST', `${base()}/${receiptId}/ready-to-clear`, {}, attackerBinding.headers);
    assert.equal(forgedTransition.status, 403, JSON.stringify(forgedTransition.data));
    assert.equal(forgedTransition.data.code, 'FORBIDDEN');

    const stillPrepareClear = await sendAs(server, 'GET', `${base()}/${receiptId}`, undefined, writeHeaders);
    assert.equal(stillPrepareClear.data.receipt.state, 'prepare_clear', 'the forged transition attempt changed nothing');
  });

  it('answers 404 for an unknown receipt id on every mutation route, before any transition check', async () => {
    for (const path of ['ready-to-clear', 'clear-intent', 'clear-outcome', 'ready-after-clear', 'supersede']) {
      const r = await sendAs(server, 'POST', `${base()}/does-not-exist/${path}`, {}, binding.headers);
      assert.equal(r.status, 404, `${path}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');
    }
  });
});
