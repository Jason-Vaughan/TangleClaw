'use strict';

/*
 * #1912, ADR 0020 §6, §7, §10: the composed workload on the real routes.
 * GET /api/tc/sessions carries engine / workload / composed per lane and runs
 * no tmux; GET /api/tc/workload gives a lane its own composed verdict; the
 * operator alone narrows, and a narrowing only lowers.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const serverMod = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

const TC = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'workload.set' };

/**
 * Send a JSON request to the test server.
 * @param {http.Server} server - Listening server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path
 * @param {object|null} body - JSON body
 * @param {Record<string, string>} [headers] - Extra headers
 * @returns {Promise<{status: number, data: object}>}
 */
function send(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

describe('composed workload on the routes (ADR 0020 §6, §7, §10)', () => {
  let tmpDir;
  let server;
  let op;
  const observer = serverMod._activityObserver;
  const realGet = observer.get;
  const engineBySession = new Map();

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };
  const lane = async (sessionId) => {
    const r = await send(server, 'GET', '/api/tc/sessions', null, {});
    assert.equal(r.status, 200);
    return r.data.sessions.find((s) => s.id === sessionId);
  };
  const assertReceipt = (b, body) => send(server, 'POST', '/api/tc/workload', body, { ...b.headers, ...TC });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workload-fleet-'));
    store._setBasePath(tmpDir);
    store.init();
    server = serverMod.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
    // The observer is not started in tests; its answers are set per session.
    observer.get = (sessionId) => ({
      activity: engineBySession.get(sessionId) || 'unknown',
      reason: 'test', observedAt: new Date().toISOString(), ageSeconds: 0, provenance: 'engine-observed'
    });
  });

  beforeEach(() => engineBySession.clear());

  after(async () => {
    observer.get = realGet;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a lane with no receipt reads UNKNOWN, with the engine and workload blocks kept separate', async () => {
    const b = bindProject(mkProject('silent'));
    engineBySession.set(b.sessionId, 'at-rest');
    const l = await lane(b.sessionId);
    assert.equal(l.composed.availability, 'UNKNOWN');
    assert.equal(l.engine.activity, 'at-rest', 'observed rest is reported, and upgrades nothing');
    assert.equal(l.engine.provenance, 'engine-observed');
    assert.equal(l.workload.provenance, 'none');
    assert.equal(l.workload.receipt, null);
  });

  it('complete + safe-to-clear with the engine at rest is AVAILABLE; the same receipt with the engine busy is WORKING', async () => {
    const b = bindProject(mkProject('free'));
    assert.equal((await assertReceipt(b, { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'done' })).status, 201);
    engineBySession.set(b.sessionId, 'at-rest');
    let l = await lane(b.sessionId);
    assert.equal(l.composed.availability, 'AVAILABLE');
    assert.equal(l.workload.provenance, 'explicit-receipt');
    assert.equal(l.workload.receipt.summary, 'done');
    engineBySession.set(b.sessionId, 'busy');
    l = await lane(b.sessionId);
    assert.equal(l.composed.availability, 'WORKING');
    assert.equal(l.composed.clearance, 'do-not-clear');
  });

  it('waiting on CI reads WAITING even with the pane at its prompt', async () => {
    const b = bindProject(mkProject('ci-wait'));
    await assertReceipt(b, { schema: 'tc.workload/1', state: 'waiting-external', clearance: 'do-not-clear', summary: 'CI on PR 1', wait: 'ci' });
    engineBySession.set(b.sessionId, 'at-rest');
    assert.equal((await lane(b.sessionId)).composed.availability, 'WAITING');
  });

  it('a held lane reads HELD; a control release after the receipt makes it stale', async () => {
    const proj = mkProject('held-lane');
    const b = bindProject(proj);
    await assertReceipt(b, { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'done' });
    engineBySession.set(b.sessionId, 'at-rest');
    store.control.insertAssignment({
      assignment_id: 'asg-held', project_id: proj.id, issue_ref: null, authority_json: '{}',
      bound_session_id: b.sessionId, bound_launch_id: b.launchId, state: 'held', state_generation: 2,
      created_by_kind: 'operator'
    });
    let l = await lane(b.sessionId);
    assert.equal(l.composed.availability, 'HELD');
    assert.equal(l.composed.clearance, 'do-not-clear');

    store.control.setAssignmentState('asg-held', { state: 'active', state_generation: 3 });
    // Recorded after the receipt, to the second: the receipt no longer counts.
    await new Promise((r) => setTimeout(r, 1100));
    store.control.insertEvent({
      event_id: 'ev-release', assignment_id: 'asg-held', kind: 'release', state_generation: 3,
      issuer_principal: 'operator', operator_proof: 'verified-session', reason_code: 'test', request_id: 'rq-1'
    });
    l = await lane(b.sessionId);
    assert.equal(l.workload.provenance, 'stale');
    assert.equal(l.workload.staleReason, 'control-release');
    assert.equal(l.composed.availability, 'UNKNOWN');
  });

  it('a stopped project reads STOPPED even when the assignment is bound to another launch', async () => {
    const proj = mkProject('stale-binding');
    const b = bindProject(proj);
    await assertReceipt(b, { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'done' });
    engineBySession.set(b.sessionId, 'at-rest');
    store.control.insertAssignment({
      assignment_id: 'asg-stale', project_id: proj.id, issue_ref: null, authority_json: '{}',
      bound_session_id: null, bound_launch_id: 'an-older-launch', state: 'stopped', state_generation: 2,
      created_by_kind: 'operator'
    });
    assert.equal((await lane(b.sessionId)).composed.availability, 'STOPPED');
  });

  it('a held project reads HELD even when its assignment has no bound launch at all', async () => {
    const proj = mkProject('unbound-assignment');
    const b = bindProject(proj);
    await assertReceipt(b, { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'done' });
    engineBySession.set(b.sessionId, 'at-rest');
    store.control.insertAssignment({
      assignment_id: 'asg-unbound', project_id: proj.id, issue_ref: null, authority_json: '{}',
      bound_session_id: null, bound_launch_id: null, state: 'held', state_generation: 2, created_by_kind: 'operator'
    });
    assert.equal((await lane(b.sessionId)).composed.availability, 'HELD');
  });

  it('GET /api/tc/workload gives a lane the same composed verdict coordinators see', async () => {
    const b = bindProject(mkProject('own-view'));
    await assertReceipt(b, { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'done' });
    engineBySession.set(b.sessionId, 'at-rest');
    const own = await send(server, 'GET', '/api/tc/workload', null, b.headers);
    assert.equal(own.status, 200);
    assert.deepEqual(own.data.composed, (await lane(b.sessionId)).composed);
    assert.equal(own.data.receipt.summary, 'done');
  });

  it('the operator can narrow an AVAILABLE lane to UNKNOWN, and clear it; the reasons keep both verdicts', async () => {
    const b = bindProject(mkProject('narrowed'));
    await assertReceipt(b, { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'done' });
    engineBySession.set(b.sessionId, 'at-rest');
    const n = await send(server, 'POST', '/api/tc/workload/narrowing',
      { sessionId: b.sessionId, forceUnknown: true, reason: 'operator is reviewing this lane' }, op);
    assert.equal(n.status, 201, JSON.stringify(n.data));
    let l = await lane(b.sessionId);
    assert.equal(l.composed.availability, 'UNKNOWN');
    assert.ok(l.composed.reasons.includes('base:AVAILABLE/safe-to-clear'));
    assert.equal(l.workload.narrowing.reason, 'operator is reviewing this lane');

    const c = await send(server, 'POST', '/api/tc/workload/narrowing',
      { sessionId: b.sessionId, clear: true, reason: 'done reviewing' }, op);
    assert.equal(c.status, 201);
    l = await lane(b.sessionId);
    assert.equal(l.composed.availability, 'AVAILABLE');
  });

  it('a narrowing cannot hide a working lane', async () => {
    const b = bindProject(mkProject('busy-narrowed'));
    engineBySession.set(b.sessionId, 'busy');
    await send(server, 'POST', '/api/tc/workload/narrowing', { sessionId: b.sessionId, forceUnknown: true, reason: 'x' }, op);
    assert.equal((await lane(b.sessionId)).composed.availability, 'WORKING');
  });

  it('no session or unbound caller can narrow, and a bad body is refused', async () => {
    const b = bindProject(mkProject('not-op'));
    const asLane = await send(server, 'POST', '/api/tc/workload/narrowing', { sessionId: b.sessionId, forceUnknown: true, reason: 'x' }, b.headers);
    assert.equal(asLane.status, 403);
    assert.equal(asLane.data.code, 'OPERATOR_ONLY');
    const unbound = await send(server, 'POST', '/api/tc/workload/narrowing', { sessionId: b.sessionId, forceUnknown: true, reason: 'x' }, {});
    assert.equal(unbound.status, 403);
    for (const body of [
      { sessionId: b.sessionId, reason: 'nothing to narrow' },
      { sessionId: b.sessionId, clear: true, forceUnknown: true, reason: 'both' },
      { sessionId: b.sessionId, forceUnknown: true },
      { sessionId: b.sessionId, forceUnknown: true, reason: 'x', raise: true },
      { sessionId: 'one', forceUnknown: true, reason: 'x' }
    ]) {
      assert.equal((await send(server, 'POST', '/api/tc/workload/narrowing', body, op)).status, 400, JSON.stringify(body));
    }
    assert.equal((await send(server, 'POST', '/api/tc/workload/narrowing', { sessionId: 999999, forceUnknown: true, reason: 'x' }, op)).status, 404);
  });

  it('the narrowing reason refuses control, format, invisible and line-separator characters, and accepts other scripts (A29, A30)', async () => {
    const b = bindProject(mkProject('reason-safety'));
    for (const ch of ['\n', '\u0085', '\u202e', '\u2066', '\u200f', '\u2028', '\u2029', '\u200b', '\ufeff', '\u00ad', '\u{E0041}', '\ufe0f']) {
      const r = await send(server, 'POST', '/api/tc/workload/narrowing', { sessionId: b.sessionId, forceUnknown: true, reason: `hold${ch}this` }, op);
      assert.equal(r.status, 400, `U+${ch.codePointAt(0).toString(16)} must be refused`);
    }
    const ok = await send(server, 'POST', '/api/tc/workload/narrowing', { sessionId: b.sessionId, forceUnknown: true, reason: 'בדיקה — 検証' }, op);
    assert.equal(ok.status, 201);
  });

  it('the fleet read runs no tmux and never ticks the observer (no synchronous scan)', async () => {
    const b = bindProject(mkProject('no-scan'));
    await assertReceipt(b, { schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'done' });
    const calls = [];
    const saved = {};
    for (const [name, fn] of Object.entries(tmux)) {
      if (typeof fn !== 'function') continue;
      saved[name] = fn;
      tmux[name] = (...args) => { calls.push(name); return fn(...args); };
    }
    const realTick = observer.tick;
    observer.tick = async () => { calls.push('observer.tick'); return { observed: [], skipped: [] }; };
    try {
      const r = await send(server, 'GET', '/api/tc/sessions', null, {});
      assert.equal(r.status, 200);
      assert.ok(r.data.sessions.length >= 1);
      await send(server, 'GET', '/api/tc/workload', null, b.headers);
    } finally {
      Object.assign(tmux, saved);
      observer.tick = realTick;
    }
    assert.deepEqual(calls, []);
  });

  describe('the nudge block (#2262)', () => {
    const HOUR = 3_600_000;
    /**
     * A receipt written directly, so its time can be in the past: the route
     * stamps the server's clock and could not produce an expired one.
     * @param {object} b - A bound project session
     * @param {object} project - Its project
     * @param {number} atMs - When it was received
     * @returns {object} The stored row
     */
    const pastReceipt = (b, project, atMs) => store.workloadReceipts.append({
      project_id: project.id, session_id: b.sessionId, launch_id: b.launchId, assignment_id: null,
      state: 'working', clearance: 'do-not-clear', summary: 'old work', wait_kind: null, wait_detail: null,
      refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
      received_at: new Date(atMs).toISOString()
    }, { minIntervalMs: 0, nowMs: atMs }).row;
    const nudgedFact = (b, project, row, atMs) => store.workloadNudgeFacts.record({
      project_id: project.id, session_id: b.sessionId, launch_id: b.launchId, receipt_id: row.receipt_id,
      kind: 'nudged', code: 'nudged', created_at: new Date(atMs).toISOString()
    });

    const fact = (b, project, row, fields, atMs) => store.workloadNudgeFacts.record({
      project_id: project.id, session_id: b.sessionId, launch_id: b.launchId, receipt_id: row.receipt_id,
      created_at: new Date(atMs).toISOString(), ...fields
    });

    it('is null on a lane with no receipt, and on a stale lane nobody nudged', async () => {
      const quiet = bindProject(mkProject('nudge-none'));
      assert.equal((await lane(quiet.sessionId)).nudge, null);
      const project = mkProject('nudge-unnoticed');
      const b = bindProject(project);
      pastReceipt(b, project, Date.now() - 2 * HOUR);
      const l = await lane(b.sessionId);
      assert.equal(l.workload.staleReason, 'expired');
      assert.equal(l.nudge, null);
    });

    it('says when the lane\'s expired receipt was nudged, and for which receipt', async () => {
      const project = mkProject('nudge-told');
      const b = bindProject(project);
      const row = pastReceipt(b, project, Date.now() - 2 * HOUR);
      const nudgedAt = Date.now() - 14 * 60_000;
      nudgedFact(b, project, row, nudgedAt);
      const l = await lane(b.sessionId);
      assert.equal(l.nudge.nudgedAt, new Date(nudgedAt).toISOString());
      assert.equal(l.nudge.receiptSeq, row.seq);
      assert.ok(Math.abs(l.nudge.ageSeconds - 14 * 60) <= 5, `ageSeconds ${l.nudge.ageSeconds}`);
      assert.deepEqual(Object.keys(l.nudge).sort(), ['ageSeconds', 'escalatedAgeSeconds', 'escalatedAt', 'escalatedTo',
        'escalationRoute', 'notNudgedReason', 'nudgedAt', 'receiptSeq']);
      assert.deepEqual([l.nudge.escalatedAt, l.nudge.escalatedAgeSeconds, l.nudge.escalatedTo, l.nudge.escalationRoute,
        l.nudge.notNudgedReason], [null, null, null, null, null], 'nudged and not escalated');
    });

    it('says when the silence was escalated, and names the coordinator it went to', async () => {
      const coordinator = mkProject('nudge-coordinator');
      const project = mkProject('nudge-escalated');
      const b = bindProject(project);
      const row = pastReceipt(b, project, Date.now() - 2 * HOUR);
      nudgedFact(b, project, row, Date.now() - 14 * 60_000);
      const escalatedAt = Date.now() - 4 * 60_000;
      fact(b, project, row, { kind: 'escalated', route: 'coordinator', target_project_id: coordinator.id, code: 'escalated' }, escalatedAt);
      const l = await lane(b.sessionId);
      assert.equal(l.nudge.escalatedAt, new Date(escalatedAt).toISOString());
      assert.ok(Math.abs(l.nudge.escalatedAgeSeconds - 4 * 60) <= 5, `escalatedAgeSeconds ${l.nudge.escalatedAgeSeconds}`);
      assert.equal(l.nudge.escalationRoute, 'coordinator');
      assert.equal(l.nudge.escalatedTo, 'nudge-coordinator');
      assert.equal(l.nudge.notNudgedReason, null);
      assert.ok(Math.abs(l.nudge.ageSeconds - 14 * 60) <= 5);
    });

    it('shows a lane escalated without a nudge, with the reason it was not nudged', async () => {
      const coordinator = mkProject('nudge-coordinator-2');
      const project = mkProject('nudge-untyped');
      const b = bindProject(project);
      const row = pastReceipt(b, project, Date.now() - 2 * HOUR);
      fact(b, project, row, { kind: 'not-nudged', code: 'startup-dialog' }, Date.now() - 5 * 60_000);
      fact(b, project, row, { kind: 'escalated', route: 'coordinator', target_project_id: coordinator.id, code: 'escalated' }, Date.now() - 5 * 60_000);
      const l = await lane(b.sessionId);
      assert.equal(l.nudge.nudgedAt, null);
      assert.equal(l.nudge.ageSeconds, null);
      assert.equal(l.nudge.notNudgedReason, 'startup-dialog');
      assert.equal(l.nudge.escalatedTo, 'nudge-coordinator-2');
    });

    it('an escalation with nobody to send to is on the operator route and names no project', async () => {
      const coordinator = mkProject('nudge-coordinator-3');
      const project = mkProject('nudge-operator-route');
      const b = bindProject(project);
      const row = pastReceipt(b, project, Date.now() - 2 * HOUR);
      nudgedFact(b, project, row, Date.now() - 14 * 60_000);
      fact(b, project, row, {
        kind: 'escalation-undeliverable', route: 'coordinator', target_project_id: coordinator.id, code: 'coordinator-no-live-session'
      }, Date.now() - 4 * 60_000);
      const undelivered = await lane(b.sessionId);
      assert.equal(undelivered.nudge.escalatedAt, null, 'a coordinator who could not be reached was not told');
      fact(b, project, row, { kind: 'escalated', route: 'operator', code: 'coordinator-no-live-session' }, Date.now() - 4 * 60_000);
      const l = await lane(b.sessionId);
      assert.equal(l.nudge.escalationRoute, 'operator');
      assert.equal(l.nudge.escalatedTo, null);
      assert.ok(l.nudge.escalatedAt);
    });

    it('goes when the session reports again, and does not return for the answered receipt', async () => {
      const project = mkProject('nudge-answered');
      const b = bindProject(project);
      const row = pastReceipt(b, project, Date.now() - 2 * HOUR);
      nudgedFact(b, project, row, Date.now() - 60 * 60_000);
      assert.ok((await lane(b.sessionId)).nudge);
      // The answer, itself now expired and not nudged: the block is about the
      // lane's newest receipt only.
      pastReceipt(b, project, Date.now() - 50 * 60_000);
      const stale = await lane(b.sessionId);
      assert.equal(stale.workload.staleReason, 'expired');
      assert.equal(stale.nudge, null);
      const r = await assertReceipt(b, { schema: 'tc.workload/1', state: 'working', clearance: 'do-not-clear', summary: 'back at it' });
      assert.equal(r.status, 201);
      const current = await lane(b.sessionId);
      assert.equal(current.workload.provenance, 'explicit-receipt');
      assert.equal(current.nudge, null);
    });

    it('a reason for not nudging, with no escalation yet, is not a block', async () => {
      const project = mkProject('nudge-other-kind');
      const b = bindProject(project);
      const row = pastReceipt(b, project, Date.now() - 2 * HOUR);
      store.workloadNudgeFacts.record({
        project_id: project.id, session_id: b.sessionId, launch_id: b.launchId, receipt_id: row.receipt_id,
        kind: 'not-nudged', code: 'startup-dialog', created_at: new Date().toISOString()
      });
      assert.equal((await lane(b.sessionId)).nudge, null);
    });
  });
});

describe('a wrap of this session started after the receipt supersedes it (ADR 0020 §4)', () => {
  const workloadFleet = require('../lib/workload-fleet');

  it('laneFor passes the wrap run through, so an older receipt reads stale', () => {
    const observer = { get: () => ({ activity: 'at-rest', reason: 'x', observedAt: null, ageSeconds: 0, provenance: 'engine-observed' }) };
    const receiptAt = Date.parse('2026-09-26T22:00:00Z');
    const realGetBySession = store.launchSequences.getBySession;
    const realLatest = store.workloadReceipts.latestForLaunch;
    const realOpen = store.control.getOpenForProject;
    const realNarrow = store.workloadReceipts.activeNarrowing;
    store.launchSequences.getBySession = () => ({ launchId: 'L-wrap' });
    store.workloadReceipts.latestForLaunch = () => ({
      project_id: 1, session_id: 9, launch_id: 'L-wrap', assignment_id: null, seq: 1, state: 'complete',
      clearance: 'safe-to-clear', summary: 's', wait_kind: null, wait_detail: null, refs_json: '{}', branch: null,
      head_sha: null, source: 'tc-cli', received_at: new Date(receiptAt).toISOString()
    });
    store.control.getOpenForProject = () => null;
    store.workloadReceipts.activeNarrowing = () => null;
    try {
      const session = { id: 9, projectId: 1, status: 'active' };
      // A wrap run of THIS session started after the receipt supersedes it;
      // a run of another session, or one that started before, does not.
      const run = (sessionId, startedAt) => ({ wrapRun: () => ({ sessionId, startedAt }) });
      const started = workloadFleet.laneFor(session, { observer, projectName: 'p', nowMs: receiptAt + 60000, wrap: run(9, receiptAt + 1000) });
      assert.equal(started.workload.staleReason, 'wrap-started');
      assert.equal(workloadFleet.laneFor(session, { observer, projectName: 'p', nowMs: receiptAt + 60000, wrap: run(10, receiptAt + 1000) }).composed.availability, 'AVAILABLE', 'another session\'s wrap does not');
      assert.equal(workloadFleet.laneFor(session, { observer, projectName: 'p', nowMs: receiptAt + 60000, wrap: run(9, receiptAt - 1000) }).composed.availability, 'AVAILABLE', 'an earlier wrap does not');
    } finally {
      store.launchSequences.getBySession = realGetBySession;
      store.workloadReceipts.latestForLaunch = realLatest;
      store.control.getOpenForProject = realOpen;
      store.workloadReceipts.activeNarrowing = realNarrow;
    }
  });
});
