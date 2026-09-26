'use strict';

/*
 * #1912, ADR 0020 §1–§3: a session asserts its own workload through one write
 * surface, `tc workload set` -> POST /api/tc/workload. Only a verified project
 * launch writes, only for itself; every identity and time field is stamped by
 * the server; the body is validated against exact enums, consistency rules and
 * bounds; and the per-launch sequence is unique under concurrent writes.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const workload = require('../lib/workload');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

/** The headers `tc workload set` sends, on top of a launch binding. */
const TC = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'workload.set' };

/** A minimal valid body. */
const OK = Object.freeze({
  schema: 'tc.workload/1', state: 'complete', clearance: 'safe-to-clear', summary: 'Train 2 merged'
});

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

describe('workload body validation (ADR 0020 §3)', () => {
  const v = (patch) => workload.validate({ ...OK, ...patch });

  it('accepts a minimal valid body and every state with a consistent clearance', () => {
    assert.equal(v({}).ok, true);
    assert.equal(v({ state: 'working', clearance: 'do-not-clear' }).ok, true);
    assert.equal(v({ state: 'waiting-external', clearance: 'do-not-clear', wait: 'ci', waitDetail: 'PR 1909' }).ok, true);
    assert.equal(v({ state: 'blocked', clearance: 'unknown', summary: 'needs operator decision on R-1' }).ok, true);
  });

  for (const key of workload.SERVER_OWNED_KEYS) {
    it(`refuses the server-owned key "${key}"`, () => {
      const r = v({ [key]: 1 });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'WORKLOAD_FIELD_NOT_WRITABLE');
      assert.match(r.message, /stamped by the server/);
    });
  }

  it('refuses an unknown key rather than ignoring it', () => {
    const r = v({ priority: 'high' });
    assert.equal(r.code, 'WORKLOAD_FIELD_NOT_WRITABLE');
    assert.match(r.message, /not a workload field/);
  });

  it('refuses a missing or wrong schema, and a non-object body', () => {
    assert.equal(workload.validate({ ...OK, schema: 'tc.workload/2' }).code, 'WORKLOAD_BAD_BODY');
    const { schema, ...noSchema } = OK;
    assert.equal(workload.validate(noSchema).code, 'WORKLOAD_BAD_BODY');
    assert.equal(workload.validate(null).code, 'WORKLOAD_BAD_BODY');
    assert.equal(workload.validate([]).code, 'WORKLOAD_BAD_BODY');
    assert.ok(schema);
  });

  it('refuses values outside the exact enums', () => {
    assert.equal(v({ state: 'idle' }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ clearance: 'maybe' }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ state: 'waiting-external', clearance: 'unknown', wait: 'lunch' }).code, 'WORKLOAD_BAD_FIELD');
  });

  it('working requires do-not-clear', () => {
    assert.equal(v({ state: 'working', clearance: 'safe-to-clear' }).code, 'WORKLOAD_INCONSISTENT');
    assert.equal(v({ state: 'working', clearance: 'unknown' }).code, 'WORKLOAD_INCONSISTENT');
  });

  it('waiting-external requires wait, and wait belongs only to waiting-external', () => {
    assert.equal(v({ state: 'waiting-external', clearance: 'do-not-clear' }).code, 'WORKLOAD_INCONSISTENT');
    assert.equal(v({ wait: 'ci' }).code, 'WORKLOAD_INCONSISTENT');
    assert.equal(v({ state: 'waiting-external', clearance: 'do-not-clear', waitDetail: 'x' }).code, 'WORKLOAD_INCONSISTENT');
  });

  it('bounds the summary: 1–200 characters, one line, not blank', () => {
    assert.equal(v({ summary: '' }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ summary: '   ' }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ summary: 'a'.repeat(201) }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ summary: 'a'.repeat(200) }).ok, true);
    assert.equal(v({ summary: 'two\nlines' }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ summary: 'bell\u0007' }).code, 'WORKLOAD_BAD_FIELD');
  });

  it('bounds refs: at most 10 each, positive integers, task ids 1–64 characters', () => {
    assert.equal(v({ issues: Array.from({ length: 10 }, (_, i) => i + 1) }).ok, true);
    assert.equal(v({ issues: Array.from({ length: 11 }, (_, i) => i + 1) }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ prs: [0] }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ prs: [1.5] }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ prs: ['7'] }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ tasks: ['a'.repeat(64)] }).ok, true);
    assert.equal(v({ tasks: ['a'.repeat(65)] }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ tasks: [''] }).code, 'WORKLOAD_BAD_FIELD');
  });

  it('accepts only a full lowercase 40-character head SHA', () => {
    assert.equal(v({ head: 'a'.repeat(40) }).ok, true);
    assert.equal(v({ head: 'a'.repeat(39) }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ head: 'A'.repeat(40) }).code, 'WORKLOAD_BAD_FIELD');
    assert.equal(v({ head: 'g'.repeat(40) }).code, 'WORKLOAD_BAD_FIELD');
  });

  it('accepts only a valid git branch name', () => {
    for (const good of ['main', 'feat/1912-fleet-workload', 'fix/a.b']) {
      assert.equal(workload.isValidBranchName(good), true, good);
    }
    for (const bad of ['', 'a b', 'a..b', '-x', '/x', 'x/', 'x.', 'x.lock', 'a@{b', 'a~b', 'a:b', 'a//b', '@',
      'a'.repeat(256)]) {
      assert.equal(workload.isValidBranchName(bad), false, bad);
    }
  });
});

describe('who may write workload (ADR 0020 §1)', () => {
  const { KINDS } = require('../lib/shared-docs-access');

  it('refuses every caller kind but a verified project launch, naming what it was', () => {
    assert.equal(workload.bindingRefusal({ kind: KINDS.PROJECT, reason: null }), null);
    for (const kind of [KINDS.OPERATOR, KINDS.MASTER, KINDS.UNBOUND]) {
      const r = workload.bindingRefusal({ kind, reason: null });
      assert.equal(r.status, 403, kind);
      assert.equal(r.body.code, 'WORKLOAD_BINDING_REQUIRED', kind);
      assert.equal(r.body.reason, kind);
    }
    const invalid = workload.bindingRefusal({ kind: KINDS.INVALID, reason: 'unknown-launch' });
    assert.equal(invalid.status, 403);
    assert.equal(invalid.body.reason, 'unknown-launch');
  });
});

describe('POST/GET /api/tc/workload (ADR 0020 §1–§2)', () => {
  let tmpDir;
  let server;
  let builder;
  let other;
  let bBuilder;
  let bOther;

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workload-'));
    store._setBasePath(tmpDir);
    store.init();
    builder = mkProject('builder-b2');
    other = mkProject('builder-b1');
    bBuilder = bindProject(builder);
    bOther = bindProject(other);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a verified launch writes its own receipt, and the server stamps every identity and time field', async () => {
    const before = Date.now();
    const r = await send(server, 'POST', '/api/tc/workload',
      { ...OK, issues: [1912], prs: [1916], tasks: ['A1'], branch: 'feat/1912-fleet-workload', head: 'b'.repeat(40) },
      { ...bBuilder.headers, ...TC });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const rc = r.data.receipt;
    assert.equal(rc.projectId, builder.id);
    assert.equal(rc.sessionId, bBuilder.sessionId);
    assert.equal(rc.seq, 1);
    assert.equal(rc.source, 'tc-cli');
    assert.equal(rc.assignmentId, null, 'no control assignment is bound to this launch');
    assert.ok(Date.parse(rc.receivedAt) >= before - 1000 && Date.parse(rc.receivedAt) <= Date.now() + 1000);
    assert.deepEqual(rc.refs, { issues: [1912], prs: [1916], tasks: ['A1'] });

    const row = store.workloadReceipts.latestForLaunch(bBuilder.launchId);
    assert.equal(row.launch_id, bBuilder.launchId, 'the launch id comes from the verified binding');
  });

  it('refuses a caller-supplied identity field before anything is stored', async () => {
    const count = store.workloadReceipts.listForLaunch(bBuilder.launchId).length;
    const r = await send(server, 'POST', '/api/tc/workload',
      { ...OK, sessionId: 999 }, { ...bBuilder.headers, ...TC });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'WORKLOAD_FIELD_NOT_WRITABLE');
    assert.equal(store.workloadReceipts.listForLaunch(bBuilder.launchId).length, count);
  });

  it('refuses an unbound caller, the operator, and a mismatched project claim', async () => {
    const unbound = await send(server, 'POST', '/api/tc/workload', OK, TC);
    assert.equal(unbound.status, 403);
    assert.equal(unbound.data.code, 'WORKLOAD_BINDING_REQUIRED');
    assert.equal(unbound.data.reason, 'unbound');

    const op = await send(server, 'POST', '/api/tc/workload', OK, { ...operatorHeaders(server), ...TC });
    assert.equal(op.status, 403);
    assert.equal(op.data.reason, 'operator');

    // Another project's launch presented under this project's id.
    const spoofed = await send(server, 'POST', '/api/tc/workload', OK, {
      'x-tangleclaw-project-id': String(builder.id), 'x-tangleclaw-launch-id': bOther.launchId, ...TC
    });
    assert.equal(spoofed.status, 403);
    assert.equal(spoofed.data.reason, 'project-mismatch');
  });

  it('another project cannot write this lane: its write lands on its own launch only', async () => {
    const r = await send(server, 'POST', '/api/tc/workload', OK, { ...bOther.headers, ...TC });
    assert.equal(r.status, 201);
    assert.equal(r.data.receipt.projectId, other.id);
    assert.equal(store.workloadReceipts.latestForLaunch(bBuilder.launchId).project_id, builder.id);
  });

  it('refuses a Project Master claim: a master-role launch id no project owns is never a project lane', async () => {
    const r = await send(server, 'POST', '/api/tc/workload', OK, {
      'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'not-a-project-launch', ...TC
    });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'WORKLOAD_BINDING_REQUIRED');
    assert.notEqual(r.data.reason, 'project', 'a Master claim never becomes a project caller');
  });

  it('refuses a verified launch that did not come through the tc client', async () => {
    const r = await send(server, 'POST', '/api/tc/workload', OK, bBuilder.headers);
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'tc-client-required');
  });

  it('refuses a launch whose session has ended', async () => {
    const ended = bindProject(mkProject('ended-lane'));
    store.sessions.kill(ended.sessionId);
    const r = await send(server, 'POST', '/api/tc/workload', OK, { ...ended.headers, ...TC });
    assert.equal(r.status, 403);
    assert.equal(r.data.reason, 'session-not-active');
  });

  it('rate-limits a lane to one receipt per second', async () => {
    const lane = bindProject(mkProject('rate-lane'));
    const first = await send(server, 'POST', '/api/tc/workload', OK, { ...lane.headers, ...TC });
    assert.equal(first.status, 201);
    const second = await send(server, 'POST', '/api/tc/workload', OK, { ...lane.headers, ...TC });
    assert.equal(second.status, 429);
    assert.equal(second.data.code, 'WORKLOAD_RATE');
    assert.ok(second.data.retryAfterMs > 0 && second.data.retryAfterMs <= workload.MIN_INTERVAL_MS);
  });

  it('stamps assignment_id only from an open control assignment bound to this launch', async () => {
    const proj = mkProject('assigned-lane');
    const lane = bindProject(proj);
    store.control.insertAssignment({
      assignment_id: 'asg-1', project_id: proj.id, issue_ref: '1912', authority_json: '{}',
      bound_session_id: lane.sessionId, bound_launch_id: lane.launchId, state: 'active',
      state_generation: 1, created_by_kind: 'operator'
    });
    const r = await send(server, 'POST', '/api/tc/workload', OK, { ...lane.headers, ...TC });
    assert.equal(r.data.receipt.assignmentId, 'asg-1');

    // An assignment bound to a different launch of the same project is not this lane's.
    const proj2 = mkProject('rebound-lane');
    const lane2 = bindProject(proj2);
    store.control.insertAssignment({
      assignment_id: 'asg-2', project_id: proj2.id, issue_ref: null, authority_json: '{}',
      bound_session_id: lane2.sessionId, bound_launch_id: 'some-older-launch', state: 'active',
      state_generation: 1, created_by_kind: 'operator'
    });
    const r2 = await send(server, 'POST', '/api/tc/workload', OK, { ...lane2.headers, ...TC });
    assert.equal(r2.data.receipt.assignmentId, null);
  });

  it('GET returns only the caller\'s own newest receipt, and refuses an unbound caller', async () => {
    const own = await send(server, 'GET', '/api/tc/workload', null, bBuilder.headers);
    assert.equal(own.status, 200);
    assert.equal(own.data.receipt.projectId, builder.id);
    const unbound = await send(server, 'GET', '/api/tc/workload', null, {});
    assert.equal(unbound.status, 403);
  });

  it('GET answers a null receipt for a lane that has written none', async () => {
    const lane = bindProject(mkProject('silent-lane'));
    const r = await send(server, 'GET', '/api/tc/workload', null, lane.headers);
    assert.equal(r.status, 200);
    assert.equal(r.data.receipt, null);
  });
});

describe('workload_receipts storage (ADR 0020 §2)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workload-store-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const row = (launchId, receivedAt) => ({
    project_id: 1, session_id: 1, launch_id: launchId, assignment_id: null, state: 'working',
    clearance: 'do-not-clear', summary: 's', wait_kind: null, wait_detail: null,
    refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
    received_at: receivedAt
  });

  it('allocates seq 1, 2, 3 per launch, independently per launch', () => {
    const t = Date.parse('2026-09-26T00:00:00Z');
    const lim = (ms) => ({ minIntervalMs: 0, nowMs: ms });
    assert.equal(store.workloadReceipts.append(row('L1', new Date(t).toISOString()), lim(t)).row.seq, 1);
    assert.equal(store.workloadReceipts.append(row('L1', new Date(t + 1).toISOString()), lim(t + 1)).row.seq, 2);
    assert.equal(store.workloadReceipts.append(row('L2', new Date(t + 2).toISOString()), lim(t + 2)).row.seq, 1);
    assert.equal(store.workloadReceipts.append(row('L1', new Date(t + 3).toISOString()), lim(t + 3)).row.seq, 3);
  });

  it('rejects a duplicate (launch_id, seq) at the database, whatever the caller does', () => {
    const db = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    try {
      assert.throws(() => db.prepare(
        "INSERT INTO workload_receipts (project_id, session_id, launch_id, seq, state, clearance, summary, refs_json, source, received_at) "
        + "VALUES (1, 1, 'L1', 1, 'working', 'do-not-clear', 's', '{}', 'tc-cli', '2026-09-26T00:00:00Z')"
      ).run(), /UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('is append-only: an update or delete aborts', () => {
    const db = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    try {
      assert.throws(() => db.prepare("UPDATE workload_receipts SET clearance = 'safe-to-clear'").run(), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM workload_receipts').run(), /append-only/);
    } finally {
      db.close();
    }
  });

  it('two processes appending to one lane through the real store never share or skip a seq', async () => {
    // Each child is a separate process with its own connection, as two server
    // processes would have. Contention is real: the store sets no busy
    // timeout, so a writer that loses the lock takes the one retry and, if it
    // loses again, reports busy rather than guessing a number.
    const { spawn } = require('node:child_process');
    const child = (tag) => new Promise((resolve, reject) => {
      const code = `
        require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'logger'))}).setLevel('error');
        const store = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store'))});
        store._setBasePath(${JSON.stringify(tmpDir)});
        // Both children open the store at once, and init writes; that race is
        // the harness's, not the subject's, so init alone retries on a lock.
        for (let n = 0; ; n++) {
          try { store.init(); break; } catch (e) {
            if (n > 50 || !/database is locked/.test(e.message)) throw e;
            try { store.close(); } catch {}
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          }
        }
        const out = { ok: 0, busy: 0 };
        for (let i = 0; i < 25; i++) {
          const r = store.workloadReceipts.append({
            project_id: 1, session_id: 1, launch_id: 'LX', assignment_id: null, state: 'working',
            clearance: 'do-not-clear', summary: ${JSON.stringify(tag)}, wait_kind: null, wait_detail: null,
            refs_json: '{}', branch: null, head_sha: null, source: 'tc-cli', received_at: new Date().toISOString()
          }, { minIntervalMs: 0, nowMs: Date.now() });
          if (r.row) out.ok++; else if (r.busy) out.busy++; else throw new Error('unexpected ' + JSON.stringify(r));
        }
        store.close();
        process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n');
      `;
      const p = spawn(process.execPath, ['--no-warnings', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (c) => {
        const line = out.split('\n').find((l) => l.startsWith('RESULT '));
        if (c === 0 && line) resolve(JSON.parse(line.slice(7)));
        else reject(new Error(`child ${tag} exited ${c}: ${err}${out}`));
      });
    });
    const [a, b] = await Promise.all([child('A'), child('B')]);
    const rows = store.workloadReceipts.listForLaunch('LX');
    assert.equal(rows.length, a.ok + b.ok, 'every append that reported a row stored exactly one');
    assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i + 1), 'seqs are 1..n with no gap or duplicate');
    assert.ok(rows.some((r) => r.summary === 'A') && rows.some((r) => r.summary === 'B'), 'both processes wrote');
  });

  it('a receipt dated ahead of the clock (the clock stepped back) does not lock the lane out', () => {
    const t = Date.parse('2026-09-26T02:00:00Z');
    store.workloadReceipts.append(row('L5', new Date(t + 60000).toISOString()), { minIntervalMs: 1000, nowMs: t + 60000 });
    const r = store.workloadReceipts.append(row('L5', new Date(t).toISOString()), { minIntervalMs: 1000, nowMs: t });
    assert.ok(r.row, 'the write after a backward clock step is accepted');
    assert.equal(r.row.seq, 2, 'and still takes the next number');
  });

  it('enforces the per-lane rate limit inside the append transaction', () => {
    const t = Date.parse('2026-09-26T01:00:00Z');
    store.workloadReceipts.append(row('L4', new Date(t).toISOString()), { minIntervalMs: 1000, nowMs: t });
    const r = store.workloadReceipts.append(row('L4', new Date(t + 400).toISOString()), { minIntervalMs: 1000, nowMs: t + 400 });
    assert.equal(r.rateLimited, true);
    assert.equal(r.retryAfterMs, 600);
    assert.equal(store.workloadReceipts.listForLaunch('L4').length, 1);
  });
});

describe('schema v50 migration (ADR 0020 §2)', () => {
  it('upgrades a v49 store: the table, its uniqueness and both triggers appear, and the version advances', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workload-mig-'));
    try {
      store._setBasePath(tmpDir);
      store.init();
      store.close();

      // Roll the fresh store back to v49 as a pre-upgrade install would look.
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const db = new DatabaseSync(dbPath);
      db.exec('DROP TRIGGER workload_receipts_append_only_update');
      db.exec('DROP TRIGGER workload_receipts_append_only_delete');
      db.exec('DROP TABLE workload_receipts');
      db.exec('DELETE FROM schema_version WHERE version >= 50');
      // A fresh install stamps only the current version; an upgraded one has 49 on record.
      db.exec('INSERT INTO schema_version (version) VALUES (49)');
      assert.equal(db.prepare('SELECT MAX(version) v FROM schema_version').get().v, 49);
      db.close();

      store._setBasePath(tmpDir);
      store.init();
      store.close();

      const after = new DatabaseSync(dbPath);
      try {
        assert.equal(after.prepare('SELECT MAX(version) v FROM schema_version').get().v, 50);
        const sql = after.prepare("SELECT sql FROM sqlite_master WHERE name = 'workload_receipts'").get().sql;
        assert.match(sql, /UNIQUE \(launch_id, seq\)/);
        const triggers = after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workload_receipts%'")
          .all().map((r) => r.name).sort();
        assert.deepEqual(triggers, ['workload_receipts_append_only_delete', 'workload_receipts_append_only_update']);
      } finally {
        after.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
