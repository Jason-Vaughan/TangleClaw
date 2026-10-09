'use strict';

// #2031 (ADR 0023 Decision 8): the candidate lane, over HTTP against the real
// server. Any verified session may offer the Master a milestone or an operator
// action, resting on its own workload receipts; only the Master can turn one
// into something the operator reads; and what a candidate rests on is checked
// when it is offered and again when it is approved.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const handoff = require('../lib/bridge-handoff');
const { pinMasterLiveness } = require('./_master-liveness');
const { bindProject } = require('./_shared-docs-callers');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');

let tmpDir;
let server;
let origin;
let masterCredential;
let masterGeneration;
let seq = 0;
let clockMs = Date.parse('2026-10-04T00:00:00.000Z');

/**
 * One JSON request to the test server.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Path.
 * @param {object} [options]
 * @param {object} [options.headers] - Extra headers.
 * @param {object} [options.body] - JSON body.
 * @returns {Promise<{status: number, body: object}>}
 */
async function call(method, apiPath, options = {}) {
  const res = await fetch(`${origin}${apiPath}`, {
    method, headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

/**
 * A project with a live, launch-bound session.
 * @returns {{project: object, sessionId: number, launchId: string, headers: object}}
 */
function liveSession() {
  const name = `Proj${++seq}`;
  const project = store.projects.create({ name, path: path.join(tmpDir, name) });
  return { project, ...bindProject(project) };
}

/**
 * The session reports its workload, as `tc workload set` records it.
 * @param {object} session - What {@link liveSession} returned.
 * @param {string} state - Workload state.
 * @returns {number} The receipt's sequence within the launch.
 */
function reports(session, state = 'complete') {
  clockMs += 5000;
  const result = store.workloadReceipts.append({
    project_id: session.project.id, session_id: session.sessionId, launch_id: session.launchId, assignment_id: null,
    state, clearance: 'safe-to-clear', summary: `work is ${state}`, wait_kind: null, wait_detail: null,
    refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
    received_at: new Date(clockMs).toISOString()
  }, { minIntervalMs: 0, nowMs: clockMs });
  return result.row.seq;
}

/**
 * The session offers a candidate.
 * @param {object} session - The session.
 * @param {object} [over] - Body overrides.
 * @returns {Promise<{status: number, body: object}>}
 */
function offers(session, over = {}) {
  return call('POST', '/api/bridge/session/candidates', {
    headers: session.headers,
    body: { requestId: `req-cand-${++seq}-00`, kind: 'milestone', text: 'PR 12 merged.', receipts: [{ kind: 'workload', seq: 1 }], ...over }
  });
}

/**
 * The Master decides a candidate.
 * @param {string} id - Candidate id.
 * @param {string} op - `approve`, `reject` or `merge`.
 * @param {object} [body] - Fields beyond the request id.
 * @returns {Promise<{status: number, body: object}>}
 */
function master(id, op, body = {}) {
  return call('POST', `/api/bridge/master/candidates/${id}/${op}`, {
    headers: { 'x-tangleclaw-bridge-credential': masterCredential },
    body: { requestId: `req-${op}-${++seq}-0000`, expectedVersion: 1, ...body }
  });
}

/**
 * Outbound candidate items, as the helper would be handed them.
 * @returns {object[]}
 */
function candidateItems() {
  return store.getDb().prepare("SELECT * FROM bridge_outbound WHERE kind = 'candidate' ORDER BY outbound_id").all();
}

let liveness;

describe('bridge candidates (#2031)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-candidates-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const minted = handoff.mintCredential();
    masterGeneration = bridgeStore.masterCredentials.mint(minted.hash);
    bridgeStore.masterCredentials.activate(masterGeneration, minted.hash);
    masterCredential = minted.credential;
    // tmux's answer about the Master is the test's to give, never the machine's: see _master-liveness.js.
    liveness = pinMasterLiveness();
  });

  after(async () => {
    liveness.restore();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    bridgeStore.settings.set('enabled', 'true');
  });

  it('a workload receipt can never be changed or removed, which is what its digest rests on', () => {
    const session = liveSession();
    reports(session);
    const db = store.getDb();
    assert.throws(() => db.exec("UPDATE workload_receipts SET summary = 'rewritten'"), /append-only|ABORT|constraint/i);
    assert.throws(() => db.exec('DELETE FROM workload_receipts'), /append-only|ABORT|constraint/i);
  });

  it('takes a candidate from a verified session, resting on its own receipt, and posts nothing', async () => {
    const session = liveSession();
    const receiptSeq = reports(session);
    const r = await offers(session, { receipts: [{ kind: 'workload', seq: receiptSeq }] });
    assert.deepEqual([r.status, r.body.state, r.body.replayed], [201, 'submitted', false]);
    assert.deepEqual(candidateItems(), [], 'a candidate never reaches the helper by itself');

    const read = await call('GET', `/api/bridge/master/candidates/${r.body.candidateId}`, { headers: { 'x-tangleclaw-bridge-credential': masterCredential } });
    assert.equal(read.body.authority, 'session-claim');
    assert.equal(read.body.candidate.sourceProjectName, session.project.name);
    assert.equal(read.body.candidate.receipts.length, 1);
    assert.equal(read.body.candidate.receipts[0].digest, bridgeStore.receipts.workloadForLaunch(session.launchId, receiptSeq).digest);
    const audit = store.getDb().prepare("SELECT * FROM bridge_audit WHERE op = 'candidate-submit' ORDER BY audit_seq DESC LIMIT 1").get();
    assert.deepEqual([audit.actor, audit.proof, audit.outcome], ['session', 'launch', 'accepted']);
  });

  it('refuses a caller that is not a verified launch, and anything while disabled', async () => {
    const session = liveSession();
    reports(session);
    // A caller that cannot be identified is refused by the server's
    // launch-binding floor before the bridge is asked (#2233). The bridge's own
    // refusal is for a caller the floor admits and who is still not a launch:
    // the operator's dashboard.
    for (const [headers, code] of [
      [{}, 'LAUNCH_BINDING_REQUIRED'],
      [{ 'x-tangleclaw-project-id': String(session.project.id) }, 'LAUNCH_BINDING_REQUIRED'],
      [{ ...session.headers, 'x-tangleclaw-launch-id': 'not-a-launch' }, 'LAUNCH_BINDING_INVALID'],
      [{ 'x-tangleclaw-bridge-credential': masterCredential }, 'LAUNCH_BINDING_REQUIRED'],
      [{ 'x-tangleclaw-client': 'dashboard' }, 'VERIFIED_LAUNCH_REQUIRED']
    ]) {
      const r = await call('POST', '/api/bridge/session/candidates', { headers, body: { requestId: 'req-none-0001', kind: 'milestone', text: 'x', receipts: [{ kind: 'workload', seq: 1 }] } });
      assert.deepEqual([r.status, r.body.code], [403, code], JSON.stringify(headers));
    }
    bridgeStore.settings.set('enabled', 'false');
    assert.equal((await offers(session)).body.code, 'BRIDGE_DISABLED');
  });

  it('a session can name only its own launch\'s receipts', async () => {
    const mine = liveSession();
    const other = liveSession();
    reports(other);
    reports(other);
    reports(mine);
    assert.equal((await offers(mine, { receipts: [{ kind: 'workload', seq: 2 }] })).body.code, 'RECEIPT_NOT_FOUND',
      'another launch has a receipt 2; this one does not');
    for (const receipts of [[], [{ kind: 'exchange', seq: 1 }], [{ kind: 'workload', seq: 0 }], [{ kind: 'workload', seq: '1' }], 'workload:1']) {
      const r = await offers(mine, { receipts });
      assert.ok(['RECEIPTS_REQUIRED', 'BAD_RECEIPT'].includes(r.body.code), JSON.stringify(receipts));
    }
    assert.equal((await offers(mine, { kind: 'announcement' })).body.code, 'UNKNOWN_CANDIDATE_KIND');
    assert.equal((await offers(mine, { text: '  ' })).body.code, 'CANDIDATE_TEXT_REQUIRED');
    assert.equal((await offers(mine, { text: 'a\u202Eb' })).body.code, 'CANDIDATE_NOT_DISPLAY_SAFE');
    assert.equal((await offers(mine, { text: 'x'.repeat(1801) })).body.code, 'CANDIDATE_TOO_LONG');
  });

  it('is idempotent on the request id within the launch, and refuses that id with a different payload', async () => {
    const session = liveSession();
    reports(session);
    const first = await offers(session, { requestId: 'req-same-0001' });
    const again = await offers(session, { requestId: 'req-same-0001' });
    assert.deepEqual([again.status, again.body.replayed, again.body.candidateId], [200, true, first.body.candidateId]);
    const changed = await offers(session, { requestId: 'req-same-0001', text: 'Something else entirely.' });
    assert.deepEqual([changed.status, changed.body.code], [409, 'REQUEST_ID_CONFLICT']);

    // The same request id from another launch is another candidate, not a replay.
    const other = liveSession();
    reports(other);
    const theirs = await offers(other, { requestId: 'req-same-0001' });
    assert.equal(theirs.status, 201);
    assert.notEqual(theirs.body.candidateId, first.body.candidateId);
  });

  it('caps how many undecided candidates one launch may have', async () => {
    const session = liveSession();
    reports(session);
    for (let i = 0; i < bridgeStore.MAX_OPEN_CANDIDATES_PER_LAUNCH; i++) assert.equal((await offers(session)).status, 201);
    const over = await offers(session);
    assert.deepEqual([over.status, over.body.code], [429, 'CANDIDATE_LIMIT']);
  });

  it('takes no more than twelve submissions a minute from one launch, whatever becomes of them', async () => {
    const api = require('../lib/bridge-api');
    api._resetRateLimits();
    try {
      const session = liveSession();
      reports(session);
      // Replays of one request: none of them is a new candidate, and each is still a request.
      const statuses = [];
      for (let i = 0; i < 13; i++) statuses.push((await offers(session, { requestId: 'req-rate-0001' })).status);
      assert.deepEqual(statuses, [201, ...Array(11).fill(200), 429]);
      const over = await offers(session, { requestId: 'req-rate-0001' });
      assert.deepEqual([over.status, over.body.code], [429, 'RATE_LIMITED']);
      // The bound is each launch's own.
      const other = liveSession();
      reports(other);
      assert.equal((await offers(other)).status, 201);
    } finally {
      api._resetRateLimits();
    }
  });

  it('the Master approves once: one item for the helper, in its words or the session\'s, with its generation', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session, { text: 'PR 12 merged.' })).body.candidateId;
    const body = { requestId: 'req-approve-fixed-1' };
    const first = await master(id, 'approve', body);
    assert.deepEqual([first.status, first.body.candidate.state, first.body.candidate.version], [200, 'approved', 2]);
    const again = await master(id, 'approve', body);
    assert.deepEqual([again.body.outcome, again.body.replayed], ['applied', true]);
    const second = await master(id, 'approve', { expectedVersion: 2 });
    assert.equal(second.body.code, 'ALREADY_DECIDED');

    const items = candidateItems().filter((i) => i.candidate_id === id);
    assert.equal(items.length, 1, 'one item, however often approval is asked for');
    assert.deepEqual([items[0].text, items[0].source_label, items[0].released_generation, items[0].state],
      ['PR 12 merged.', `Project Master, from ${session.project.name}`, masterGeneration, 'ready']);

    const reworded = (await offers(session, { text: 'done lol' })).body.candidateId;
    await master(reworded, 'approve', { text: 'The release branch is merged.' });
    assert.equal(candidateItems().find((i) => i.candidate_id === reworded).text, 'The release branch is merged.');
    const audit = store.getDb().prepare("SELECT * FROM bridge_audit WHERE op = 'candidate-approve' AND outcome = 'applied' ORDER BY audit_seq DESC LIMIT 1").get();
    assert.deepEqual([audit.actor, audit.master_generation, JSON.parse(audit.detail_json).wording], ['master', masterGeneration, 'master']);
  });

  it('a rejected candidate posts nothing and cannot be approved afterwards', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session)).body.candidateId;
    assert.equal((await master(id, 'reject')).body.candidate.state, 'rejected');
    assert.equal((await master(id, 'approve', { expectedVersion: 2 })).body.code, 'ALREADY_DECIDED');
    assert.equal(candidateItems().filter((i) => i.candidate_id === id).length, 0);
  });

  it('merging keeps every receipt on the survivor, and the folded candidate can never be released', async () => {
    const session = liveSession();
    const one = reports(session);
    const two = reports(session, 'working');
    const kept = (await offers(session, { receipts: [{ kind: 'workload', seq: one }] })).body.candidateId;
    const folded = (await offers(session, { receipts: [{ kind: 'workload', seq: two }] })).body.candidateId;

    assert.equal((await master(folded, 'merge', { into: folded })).body.code, 'MERGE_TARGET_REQUIRED');
    assert.equal((await master(folded, 'merge', { into: 'cd_none' })).body.code, 'MERGE_TARGET_NOT_OPEN');
    const merged = await master(folded, 'merge', { into: kept });
    assert.deepEqual([merged.status, merged.body.candidate.state], [200, 'merged']);

    assert.equal(bridgeStore.candidates.receipts(kept).length, 2, 'the survivor rests on both');
    assert.equal(bridgeStore.candidates.receipts(folded).length, 1, 'the folded one keeps its own record');
    assert.equal((await master(folded, 'approve', { expectedVersion: 2 })).body.code, 'ALREADY_DECIDED');
    assert.equal((await master(kept, 'approve', { expectedVersion: 2 })).status, 200);
    assert.equal(candidateItems().filter((i) => [kept, folded].includes(i.candidate_id)).length, 1, 'one release for the pair');
  });

  it('after a merge the survivor\'s version moves, and a faithful replay of either submission is still a replay', async () => {
    const session = liveSession();
    const one = reports(session);
    const two = reports(session, 'working');
    const keptBody = { requestId: 'req-merge-kept-1', receipts: [{ kind: 'workload', seq: one }] };
    const foldedBody = { requestId: 'req-merge-fold-1', receipts: [{ kind: 'workload', seq: two }] };
    const kept = (await offers(session, keptBody)).body.candidateId;
    const folded = (await offers(session, foldedBody)).body.candidateId;
    await master(folded, 'merge', { into: kept });

    assert.equal(bridgeStore.candidates.get(kept).version, 2, 'what it rests on changed');
    const stale = await master(kept, 'approve', { expectedVersion: 1 });
    assert.equal(stale.body.code, 'VERSION_CONFLICT', 'a decision made on the survivor as it was before the merge is stale');

    const again = await offers(session, keptBody);
    assert.deepEqual([again.status, again.body.replayed, again.body.candidateId], [200, true, kept]);
    const foldedAgain = await offers(session, foldedBody);
    assert.deepEqual([foldedAgain.status, foldedAgain.body.replayed, foldedAgain.body.state], [200, true, 'merged']);
    assert.equal((await master(kept, 'approve', { expectedVersion: 2 })).status, 200);
  });

  it('the receipt digest covers every column of the receipts table', () => {
    const columns = store.getDb().prepare('PRAGMA table_info(workload_receipts)').all().map((c) => c.name).sort();
    assert.deepEqual([...bridgeStore.WORKLOAD_RECEIPT_COLUMNS].sort(), columns);
  });

  it('refuses to approve a candidate whose receipt is no longer what it was', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session)).body.candidateId;
    // Only by removing the table's own protection can a receipt change at all.
    const db = store.getDb();
    const trigger = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'workload_receipts' AND sql LIKE '%UPDATE%'").get();
    db.exec(`DROP TRIGGER ${trigger.name}`);
    db.prepare("UPDATE workload_receipts SET summary = 'rewritten afterwards' WHERE launch_id = ?").run(session.launchId);
    db.exec(trigger.sql);

    const refused = await master(id, 'approve');
    assert.deepEqual([refused.status, refused.body.code], [409, 'RECEIPTS_DO_NOT_HOLD']);
    assert.equal(bridgeStore.candidates.get(id).state, 'submitted', 'the decision and the item land together or not at all');
    assert.equal(candidateItems().filter((i) => i.candidate_id === id).length, 0);
  });

  it('refuses a stale version and a malformed or unknown candidate id, and audits the decision it refused', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session)).body.candidateId;
    const stale = await master(id, 'approve', { requestId: 'req-stale-00001', expectedVersion: 9 });
    assert.deepEqual([stale.status, stale.body.code], [409, 'VERSION_CONFLICT']);
    assert.equal(bridgeStore.audit.findRequest('candidate-approve', 'req-stale-00001').outcome, 'version-conflict');
    assert.equal((await master('cd_unknown', 'reject')).status, 404);
    assert.equal((await master(encodeURIComponent('bad id!'), 'reject')).status, 404);
    assert.equal((await master(id, 'reject', { expectedVersion: undefined })).body.code, 'EXPECTED_VERSION_REQUIRED');
  });

  it('works end to end through the real tc, from a pane and from the Master', async () => {
    const session = liveSession();
    const receiptSeq = reports(session);
    const run = (args, env) => new Promise((resolve) => {
      const base = { PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_API: origin };
      execFile(TC_BIN, args, { env: { ...base, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    const pane = { TANGLECLAW_PROJECT_ID: String(session.project.id), TANGLECLAW_LAUNCH_ID: session.launchId };
    const masterPane = { TANGLECLAW_ROLE: 'master', [handoff.CREDENTIAL_ENV]: masterCredential };

    const submitted = await run(['candidate', 'submit', '--kind', 'operator-action-required', '--receipt', `workload:${receiptSeq}`, '--text', 'Needs your sign-off.'], pane);
    assert.equal(submitted.code, 0, submitted.stderr);
    assert.match(submitted.stdout, /is with the Project Master\. Nothing has been posted/);
    const id = /Candidate (\S+) /.exec(submitted.stdout)[1];

    assert.equal((await run(['candidate', 'submit', '--kind', 'milestone', '--text', 'x'], pane)).code, 1, 'no receipt named');
    assert.equal((await run(['candidate', 'submit', '--kind', 'milestone', '--receipt', 'pr:12', '--text', 'x'], pane)).code, 1);
    const refused = await run(['candidate', 'submit', '--kind', 'milestone', '--receipt', 'workload:99', '--text', 'x'], pane);
    assert.deepEqual([refused.code, /RECEIPT_NOT_FOUND/.test(refused.stderr)], [2, true]);

    const listed = await run(['bridge', 'candidates'], masterPane);
    assert.match(listed.stdout, new RegExp(`${id}  operator-action-required`));
    const shown = await run(['bridge', 'candidate', id], masterPane);
    assert.match(shown.stdout, /a session's CLAIM for you to judge/);
    assert.match(shown.stdout, /\[text\] Needs your sign-off\./);
    const approved = await run(['bridge', 'approve', id, '--version', '1', '--text', 'A session needs your sign-off.'], masterPane);
    assert.equal(approved.code, 0, approved.stderr);
    assert.match(approved.stdout, /is approved and released to the operator/);
    assert.equal(candidateItems().find((i) => i.candidate_id === id).text, 'A session needs your sign-off.');

    // A pane holds no bridge credential: it cannot decide its own candidate.
    const selfApprove = await run(['bridge', 'approve', id, '--version', '2'], pane);
    assert.deepEqual([selfApprove.code, /BRIDGE_CREDENTIAL_REQUIRED/.test(selfApprove.stderr)], [2, true]);
  });
  // What a rollback has to be able to clear. Closing routes withdraws what was
  // released for them; everything else queued belongs to no open route, waits
  // through a disabled bridge, and posts when it is next enabled.
  describe('everything queued that no open route owns', () => {
    const bridgeApi = require('../lib/bridge-api');
    const SIGNED_IN = { tcSession: { username: 'rosie' }, tcGateState: 'guarding', headers: {} };
    const AMBIENT = { tcGateActive: false, tcGateState: 'open', headers: { 'sec-fetch-site': 'same-origin' } };
    /**
     * Call an operator route as a given caller.
     * @param {object} req - The HTTP request as the server would have annotated it.
     * @param {string} method - HTTP method.
     * @param {string} declared - The declared path.
     * @param {object} [request] - `params`, `body`.
     * @returns {Promise<{status: number, body: object}>}
     */
    const operator = (req, method, declared, request = {}) => bridgeApi.handle(bridgeApi.routeFor(method, declared), { req, headers: req.headers, ...request });
    const inventory = async () => (await operator(SIGNED_IN, 'GET', '/api/bridge/operator/status')).body.routelessItems;
    const notice = (key, type) => {
      const text = `notice text ${key}`;
      return bridgeStore.outbound.enqueue({ idemKey: `notify:${type}:${key}`, kind: 'notification', notifyType: type, sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text) }).outboundId;
    };

    it('lists every class of it, by id, kind, state and age, and never its text; and nothing an open route owns', async () => {
      const db = store.getDb();
      db.exec('DELETE FROM bridge_outbound');
      db.exec("UPDATE bridge_candidates SET state = 'rejected', decided_at = '2026-10-04T00:00:00.000Z' WHERE state = 'submitted'");
      const session = liveSession();
      reports(session);
      // 1. A candidate nobody has decided.
      const undecided = (await offers(session, { text: 'SECRET-UNDECIDED text' })).body.candidateId;
      // 2. A candidate approved and not yet collected.
      const approvedId = (await offers(session, { text: 'SECRET-APPROVED text' })).body.candidateId;
      assert.equal((await master(approvedId, 'approve')).status, 200);
      const approvedItem = candidateItems().find((i) => i.candidate_id === approvedId).outbound_id;
      // 3. A typed notification waiting.
      const waiting = notice('inv-1', 'fleet-idle');
      // 4. An item set aside.
      const aside = notice('inv-2', 'operator-needed');
      db.prepare("UPDATE bridge_outbound SET state = 'blocked', block_code = 'rejected-by-chat' WHERE outbound_id = ?").run(aside);
      // 5. A notice left behind by a route that has since closed.
      bridgeStore.routes.accept({ routeId: 'rt_inv_closed', externalId: `inv-closed-${++seq}`, authorId: 'a', spaceId: 's', channelId: 'c', text: 'SECRET-ROUTE text', digest: bridgeStore.digest('x') });
      const ofClosed = bridgeStore.outbound.enqueue({ idemKey: 'route:rt_inv_closed:send-unconfirmed', kind: 'failure', routeId: 'rt_inv_closed', sourceLabel: 'TangleClaw', text: 'SECRET-FAILURE text', digest: bridgeStore.digest('f') }).outboundId;
      db.prepare("UPDATE bridge_routes SET state = 'closed', closed_by = 'master', closed_at = '2026-10-04T00:00:00.000Z' WHERE route_id = 'rt_inv_closed'").run();
      // An item cannot name a route that does not exist: the store refuses it.
      assert.throws(() => bridgeStore.outbound.enqueue({ idemKey: 'route:rt_inv_gone:send-unconfirmed', kind: 'failure', routeId: 'rt_inv_gone', sourceLabel: 'TangleClaw', text: 'gone', digest: bridgeStore.digest('g') }),
        /needs its route or candidate/);
      // NOT in it: what an open route owns, what is already delivered or let go, and a decided candidate.
      bridgeStore.routes.accept({ routeId: 'rt_inv_open', externalId: `inv-open-${++seq}`, authorId: 'a', spaceId: 's', channelId: 'c', text: 'x', digest: bridgeStore.digest('x') });
      const owned = bridgeStore.outbound.enqueue({ idemKey: 'route:rt_inv_open:send-unconfirmed', kind: 'failure', routeId: 'rt_inv_open', sourceLabel: 'TangleClaw', text: 'owned', digest: bridgeStore.digest('o') }).outboundId;
      const delivered = notice('inv-3', 'fleet-idle');
      db.prepare("UPDATE bridge_outbound SET state = 'delivered', delivered_ref = 'x', delivered_at = '2026-10-04T00:00:00.000Z', text = NULL WHERE outbound_id = ?").run(delivered);
      const dropped = notice('inv-4', 'fleet-idle');
      db.prepare("UPDATE bridge_outbound SET state = 'dropped', drop_code = 'withdrawn', text = NULL WHERE outbound_id = ?").run(dropped);
      const rejected = (await offers(session, { text: 'decided already' })).body.candidateId;
      assert.equal((await master(rejected, 'reject')).status, 200);

      const listed = await inventory();
      assert.deepEqual(listed.map((e) => [e.ref, e.id, e.kind, e.state]), [
        ['candidate', undecided, 'candidate:milestone', 'undecided'],
        ['item', approvedItem, 'candidate', 'waiting'],
        ['item', waiting, 'notification:fleet-idle', 'waiting'],
        ['item', aside, 'notification:operator-needed', 'set-aside:rejected-by-chat'],
        ['item', ofClosed, 'failure', 'waiting']
      ]);
      for (const entry of listed) {
        assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'id', 'kind', 'ref', 'state'], 'id, kind, state and age, and nothing else');
        assert.match(entry.createdAt, /^20\d\d-\d\d-\d\dT/);
      }
      assert.ok(!/SECRET|notice text|PR 12/.test(JSON.stringify(listed)), 'no word of anything anyone wrote');
      for (const absent of [owned, delivered, dropped]) assert.ok(!listed.some((e) => e.ref === 'item' && e.id === absent));
      assert.ok(!listed.some((e) => e.id === rejected));
      assert.deepEqual(bridgeStore.routelessInventory(), listed, 'status shows exactly the store\'s inventory');
    });

    it('the signed-in operator withdraws each one, once, with the bridge disabled; nobody else can', async () => {
      const db = store.getDb();
      db.exec('DELETE FROM bridge_outbound');
      db.exec("UPDATE bridge_candidates SET state = 'rejected', decided_at = '2026-10-04T00:00:00.000Z' WHERE state = 'submitted'");
      const session = liveSession();
      reports(session);
      const undecided = (await offers(session)).body.candidateId;
      const approvedId = (await offers(session, { text: 'Another.' })).body.candidateId;
      await master(approvedId, 'approve');
      const item = notice('wd-1', 'fleet-idle');
      const aside = notice('wd-2', 'operator-needed');
      db.prepare("UPDATE bridge_outbound SET state = 'blocked', block_code = 'rejected-by-chat' WHERE outbound_id = ?").run(aside);
      assert.equal((await inventory()).length, 4);

      // Disabling withdraws nothing by itself, and the Master's own decisions are refused from then on.
      bridgeStore.settings.set('enabled', 'false');
      assert.equal((await inventory()).length, 4);
      assert.deepEqual([(await master(undecided, 'reject')).status, (await master(undecided, 'reject')).body.code], [409, 'BRIDGE_DISABLED']);

      // Not the operator: an open gate and a dashboard-shaped request change nothing.
      const candidateRoute = '/api/bridge/operator/candidates/:candidateId/withdraw';
      const itemRoute = '/api/bridge/operator/outbound/:outboundId/withdraw';
      assert.equal((await operator(AMBIENT, 'POST', candidateRoute, { params: { candidateId: undecided }, body: { requestId: 'req-amb-cand-0001' } })).status, 403);
      assert.equal((await operator(AMBIENT, 'POST', itemRoute, { params: { outboundId: String(item) }, body: { requestId: 'req-amb-item-0001' } })).status, 403);
      // An unidentified caller never reaches the bridge (#2233). One the floor
      // admits, a live session or the dashboard on an open gate, gets the
      // bridge's own answer: neither is a signed-in operator.
      for (const [headers, code] of [
        [{}, 'LAUNCH_BINDING_REQUIRED'],
        [{ 'x-tangleclaw-bridge-credential': masterCredential }, 'LAUNCH_BINDING_REQUIRED'],
        [session.headers, 'OPERATOR_SESSION_REQUIRED'],
        [{ 'x-tangleclaw-client': 'dashboard' }, 'OPERATOR_SESSION_REQUIRED']
      ]) {
        const res = await call('POST', `/api/bridge/operator/candidates/${undecided}/withdraw`, { headers, body: { requestId: 'req-http-cand-0001' } });
        assert.deepEqual([res.status, res.body.code], [403, code], JSON.stringify(headers));
      }
      assert.equal((await inventory()).length, 4, 'none of that withdrew anything');

      // The candidate: once, audited with who did it, and a repeat of the request changes nothing.
      const first = await operator(SIGNED_IN, 'POST', candidateRoute, { params: { candidateId: undecided }, body: { requestId: 'req-op-cand-0001' } });
      assert.deepEqual([first.status, first.body.candidate.state, first.body.replayed], [200, 'rejected', false]);
      assert.ok(!JSON.stringify(first.body).includes('PR 12'), 'the answer carries no text');
      const again = await operator(SIGNED_IN, 'POST', candidateRoute, { params: { candidateId: undecided }, body: { requestId: 'req-op-cand-0001' } });
      assert.deepEqual([again.status, again.body.replayed], [200, true]);
      const other = await operator(SIGNED_IN, 'POST', candidateRoute, { params: { candidateId: undecided }, body: { requestId: 'req-op-cand-0002' } });
      assert.deepEqual([other.status, other.body.code], [409, 'NOT_WAITING'], 'a new request finds it already decided');
      const reused = await operator(SIGNED_IN, 'POST', candidateRoute, { params: { candidateId: approvedId }, body: { requestId: 'req-op-cand-0001' } });
      assert.deepEqual([reused.status, reused.body.code], [409, 'REQUEST_ID_REUSED']);
      assert.equal((await operator(SIGNED_IN, 'POST', candidateRoute, { params: { candidateId: 'cand_no_such' }, body: { requestId: 'req-op-cand-0003' } })).status, 404);
      assert.equal((await operator(SIGNED_IN, 'POST', candidateRoute, { params: { candidateId: 'not a candidate id' }, body: { requestId: 'req-op-cand-0004' } })).status, 404);
      assert.equal((await operator(SIGNED_IN, 'POST', candidateRoute, { params: { candidateId: undecided }, body: {} })).body.code, 'REQUEST_ID_REQUIRED');
      const audited = db.prepare("SELECT actor, proof, outcome, master_generation, detail_json FROM bridge_audit WHERE op = 'candidate-withdraw' AND request_id = 'req-op-cand-0001'").all();
      assert.deepEqual(audited.map((r) => [r.actor, r.proof, r.outcome, r.master_generation, JSON.parse(r.detail_json).user, JSON.parse(r.detail_json).candidateId]),
        [['operator', 'verified-session', 'applied', null, 'rosie', undecided]]);
      const row = db.prepare('SELECT state, decided_generation, decided_at FROM bridge_candidates WHERE candidate_id = ?').get(undecided);
      assert.deepEqual([row.state, row.decided_generation, typeof row.decided_at], ['rejected', null, 'string'], 'decided by the operator, not by a Master generation');
      // It can never be approved now.
      bridgeStore.settings.set('enabled', 'true');
      assert.equal((await master(undecided, 'approve', { expectedVersion: 2 })).status, 409);
      bridgeStore.settings.set('enabled', 'false');

      // Every item left, each by its own id, and the inventory is then empty.
      for (const entry of await inventory()) {
        assert.equal(entry.ref, 'item');
        const done = await operator(SIGNED_IN, 'POST', itemRoute, { params: { outboundId: String(entry.id) }, body: { requestId: `req-op-item-${entry.id}-0001` } });
        assert.deepEqual([done.status, done.body.item.state], [200, 'dropped'], `${entry.kind} ${entry.state}`);
      }
      assert.deepEqual(await inventory(), []);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE state IN ('ready','blocked')").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE text IS NOT NULL").get().n, 0, 'and no text of any of it is kept');
    });
  });
});
