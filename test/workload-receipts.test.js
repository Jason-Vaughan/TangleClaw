'use strict';

/*
 * #1912, ADR 0020 §1–§3: a session asserts its own workload through one write
 * surface, `tc workload set` -> POST /api/tc/workload. Only a verified project
 * launch writes, only for itself; every identity and time field is stamped by
 * the server; the body is validated against exact enums, consistency rules and
 * bounds; and the per-launch sequence is unique under concurrent writes.
 */

const { describe, it, before, after, afterEach } = require('node:test');
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

describe('text safety across every free-text field (Architect ruling A29)', () => {
  // One representative per refused class, with its name for the message.
  const UNSAFE = [
    ['C0 NUL', '\u0000'], ['C0 TAB', '\t'], ['C0 LF', '\n'], ['C0 ESC', '\u001b'], ['DEL', '\u007f'],
    ['C1 PAD', '\u0080'], ['C1 NEL', '\u0085'], ['C1 CSI', '\u009b'], ['C1 APC', '\u009f'],
    ['bidi ALM', '\u061c'], ['bidi LRM', '\u200e'], ['bidi RLM', '\u200f'],
    ['bidi LRE', '\u202a'], ['bidi RLE', '\u202b'], ['bidi PDF', '\u202c'], ['bidi LRO', '\u202d'], ['bidi RLO', '\u202e'],
    ['bidi LRI', '\u2066'], ['bidi RLI', '\u2067'], ['bidi FSI', '\u2068'], ['bidi PDI', '\u2069'],
    ['LINE SEPARATOR', '\u2028'], ['PARAGRAPH SEPARATOR', '\u2029']
  ];
  // Text a lane may legitimately write: other scripts, right-to-left letters
  // included, accents, symbols and emoji.
  const SAFE = ['Train 2 merged', 'עבודה הושלמה', 'تم الدمج', '日本語のテスト', 'Café — naïve', 'CI ✓ 🙂', 'a b'];

  const bodyWith = (field, value) => {
    const base = { ...OK };
    if (field === 'summary') return { ...base, summary: `before${value}after` };
    if (field === 'waitDetail') return { ...base, state: 'waiting-external', clearance: 'do-not-clear', wait: 'ci', waitDetail: `pr${value}1921` };
    if (field === 'tasks') return { ...base, tasks: [`A${value}1`] };
    throw new Error(field);
  };

  for (const field of ['summary', 'waitDetail', 'tasks']) {
    it(`refuses every unsafe class in ${field}`, () => {
      for (const [name, ch] of UNSAFE) {
        const r = workload.validate(bodyWith(field, ch));
        assert.equal(r.ok, false, `${field} must refuse ${name}`);
        assert.equal(r.code, 'WORKLOAD_BAD_FIELD', `${field}/${name}`);
      }
    });
  }

  it('refuses every unsafe class in branch', () => {
    for (const [name, ch] of UNSAFE) {
      assert.equal(workload.isValidBranchName(`feat/x${ch}y`), false, `branch must refuse ${name}`);
      assert.equal(workload.validate({ ...OK, branch: `feat/x${ch}y` }).ok, false, `branch body must refuse ${name}`);
    }
  });

  it('accepts ordinary text in every script, right-to-left included, in each text field', () => {
    for (const text of SAFE) {
      assert.equal(workload.validate({ ...OK, summary: text }).ok, true, `summary: ${text}`);
      assert.equal(workload.validate({ ...OK, state: 'waiting-external', clearance: 'do-not-clear', wait: 'ci', waitDetail: text }).ok, true, `waitDetail: ${text}`);
      assert.equal(workload.isSafeText(text), true, text);
    }
    assert.equal(workload.validate({ ...OK, tasks: ['日本-1', 'עבודה'] }).ok, true, 'task ids in other scripts');
    assert.equal(workload.isValidBranchName('feat/日本-1912'), true, 'a branch name in another script');
  });

  it('isSafeText refuses every A29 class, and allows the visible code points just outside A29\'s ranges', () => {
    for (const [name, ch] of UNSAFE) assert.equal(workload.isSafeText(`x${ch}y`), false, name);
    // Boundaries: the visible code points just outside A29's ranges are allowed. U+200D, U+2065 and
    // U+206A were outside A29's ranges too; A30 refuses them (format / default-ignorable).
    for (const ch of ['\u00a0', '\u061b', '\u061d', '\u2010', '\u2027', '\u202f']) {
      assert.equal(workload.isSafeText(`x${ch}y`), true, `U+${ch.codePointAt(0).toString(16).toUpperCase()} is outside the refused ranges`);
    }
    assert.equal(workload.isSafeText(42), false, 'a non-string is never safe text');
  });
});

describe('display safety by Unicode property (ADR 0020 §3, Architect ruling A30)', () => {
  // One or more representatives per refused class. The predicate is shared,
  // so the classes are proven here once; the wiring tests below prove each
  // field uses it.
  const REFUSED = {
    'Cc control (C0, DEL, C1)': ['\u0000', '\t', '\u007f', '\u0085', '\u009f'],
    'Cf format: bidi': ['\u061c', '\u200e', '\u202e', '\u2067'],
    'Cf format: zero-width and word joiner': ['\u200b', '\u200c', '\u200d', '\u2060'],
    'Cf format: byte-order mark': ['\ufeff'],
    'Cf format: soft hyphen': ['\u00ad'],
    'Cf format: tag characters': ['\u{E0001}', '\u{E0041}', '\u{E007F}'],
    'Zl line separator': ['\u2028'],
    'Zp paragraph separator': ['\u2029'],
    'default-ignorable: variation selectors': ['\ufe00', '\ufe0f', '\u{E0100}', '\u{E01EF}'],
    'default-ignorable: other invisibles': ['\u034f', '\u115f', '\u3164', '\u2065']
  };

  for (const [cls, chars] of Object.entries(REFUSED)) {
    it(`refuses ${cls}`, () => {
      for (const ch of chars) {
        const cp = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
        assert.equal(workload.isSafeText(`a${ch}b`), false, `${cp} inside text`);
        assert.equal(workload.isSafeText(ch), false, `${cp} alone`);
      }
    });
  }

  it('refuses text with no visible character: only spaces, or only combining marks', () => {
    for (const t of [' ', '  ', '́', '́̈', ' ́ ']) {
      assert.equal(workload.isSafeText(t), false, JSON.stringify(t));
    }
  });

  it('keeps ordinary visible Unicode: accents, non-Latin scripts (right-to-left included), symbols, emoji', () => {
    for (const t of ['Café naïve', 'é composed by a mark', 'עבודה', 'تم الدمج', '日本語', 'Ελληνικά', '✓ ★ € §', '\u{1F642}', 'a b']) {
      assert.equal(workload.isSafeText(t), true, JSON.stringify(t));
    }
  });

  it('refuses emoji written with a variation selector or zero-width joiner (an accepted consequence, ADR 0020 §3)', () => {
    assert.equal(workload.isSafeText('❤\ufe0f'), false, 'heart with VS16');
    assert.equal(workload.isSafeText('\u{1F468}\u200d\u{1F469}'), false, 'ZWJ sequence');
  });

  describe('each free-text field is wired to the predicate', () => {
    const bodies = {
      summary: (t) => ({ ...OK, summary: t }),
      waitDetail: (t) => ({ ...OK, state: 'waiting-external', clearance: 'do-not-clear', wait: 'ci', waitDetail: t }),
      'task ids': (t) => ({ ...OK, tasks: [t] }),
      branch: (t) => ({ ...OK, branch: t })
    };
    for (const [field, body] of Object.entries(bodies)) {
      it(`${field} refuses a zero-width character and invisible-only text, and accepts visible text`, () => {
        const safe = field === 'branch' ? 'feat/日本-1' : 'visible 日本';
        const withInvisible = field === 'branch' ? 'ma\u200bin' : 'ok\u200bok';
        assert.equal(workload.validate(body(withInvisible)).ok, false, `${field}: zero-width`);
        if (field !== 'branch') assert.equal(workload.validate(body('́')).ok, false, `${field}: marks only`);
        assert.equal(workload.validate(body(safe)).ok, true, `${field}: visible`);
      });
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
    // Refused by the server's launch-binding floor, before the route (#2233).
    assert.equal(unbound.data.code, 'LAUNCH_BINDING_REQUIRED');
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
    assert.equal(r.data.code, 'LAUNCH_BINDING_INVALID');
    assert.notEqual(r.data.reason, 'project', 'a Master claim never becomes a project caller');
  });

  it('answers 503 WORKLOAD_BUSY, storing nothing, when the store reports busy', async () => {
    const lane = bindProject(mkProject('busy-lane'));
    const realAppend = store.workloadReceipts.append;
    store.workloadReceipts.append = () => ({ busy: true });
    try {
      const r = await send(server, 'POST', '/api/tc/workload', OK, { ...lane.headers, ...TC });
      assert.equal(r.status, 503);
      assert.equal(r.data.code, 'WORKLOAD_BUSY');
    } finally {
      store.workloadReceipts.append = realAppend;
    }
    assert.equal(store.workloadReceipts.listForLaunch(lane.launchId).length, 0);
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

  describe('the retry-once (ADR 0020 §2), driven deterministically', () => {
    const api = store.workloadReceipts;
    const real = api._appendOnce;
    const locked = () => new Error('database is locked');
    const collided = () => new Error('UNIQUE constraint failed: workload_receipts.launch_id, workload_receipts.seq');
    const script = (steps) => {
      let n = 0;
      api._appendOnce = function (...args) {
        const step = steps[n++];
        if (step === 'real') return real.apply(this, args);
        throw step();
      };
      return () => n;
    };
    const restore = () => { api._appendOnce = real; };

    it('a lock on the first attempt is retried once and the second attempt stores the row', () => {
      const calls = script([locked, 'real']);
      try {
        const r = api.append(row('R1', new Date().toISOString()), { minIntervalMs: 0, nowMs: Date.now() });
        assert.ok(r.row);
        assert.equal(calls(), 2);
      } finally { restore(); }
    });

    it('a seq collision on the first attempt is retried the same way', () => {
      const calls = script([collided, 'real']);
      try {
        assert.ok(api.append(row('R2', new Date().toISOString()), { minIntervalMs: 0, nowMs: Date.now() }).row);
        assert.equal(calls(), 2);
      } finally { restore(); }
    });

    it('two retryable failures report busy and store nothing, with no third attempt', () => {
      const calls = script([locked, collided]);
      try {
        assert.deepEqual(api.append(row('R3', new Date().toISOString()), { minIntervalMs: 0, nowMs: Date.now() }), { busy: true });
        assert.equal(calls(), 2);
        assert.equal(api.listForLaunch('R3').length, 0);
      } finally { restore(); }
    });

    it('a non-retryable failure is thrown at once, never retried', () => {
      const calls = script([() => new Error('disk I/O error')]);
      try {
        assert.throws(() => api.append(row('R4', new Date().toISOString()), { minIntervalMs: 0, nowMs: Date.now() }), /disk I\/O/);
        assert.equal(calls(), 1);
      } finally { restore(); }
    });
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

describe('ended-launch retention for workload_receipts/workload_narrowings (Architect Ruling A485-1918)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workload-retention-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => workload._setRetention());

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  const receiptRow = (projectId, sessionId, launchId, seq, receivedAt) => ({
    project_id: projectId, session_id: sessionId, launch_id: launchId, assignment_id: null,
    state: 'working', clearance: 'do-not-clear', summary: 's', wait_kind: null, wait_detail: null,
    refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
    received_at: receivedAt
  });

  const countRows = (table, launchId) =>
    store.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE launch_id = ?`).get(launchId).n;

  describe('the append-only trigger', () => {
    it('still aborts a delete for a live-session row (unchanged behavior)', () => {
      const proj = mkProject('retention-live');
      const lane = bindProject(proj);
      const t = Date.parse('2026-10-30T00:00:00Z');
      const r = store.workloadReceipts.append(
        receiptRow(proj.id, lane.sessionId, lane.launchId, 1, new Date(t).toISOString()),
        { minIntervalMs: 0, nowMs: t }
      );
      const db = store.getDb();
      workload.ensureWorkloadRetentionTriggers(db);
      assert.throws(() => db.prepare('DELETE FROM workload_receipts WHERE receipt_id = ?').run(r.row.receipt_id), /append-only/);
    });

    it('allows a delete once the row\'s session has ended and nothing references it', () => {
      const proj = mkProject('retention-ended');
      const lane = bindProject(proj);
      const t = Date.parse('2026-10-30T00:00:00Z');
      const r = store.workloadReceipts.append(
        receiptRow(proj.id, lane.sessionId, lane.launchId, 1, new Date(t).toISOString()),
        { minIntervalMs: 0, nowMs: t }
      );
      store.sessions.kill(lane.sessionId);
      const db = store.getDb();
      workload.ensureWorkloadRetentionTriggers(db);
      db.prepare('DELETE FROM workload_receipts WHERE receipt_id = ?').run(r.row.receipt_id);
      assert.equal(store.workloadReceipts.listForLaunch(lane.launchId).length, 0);
    });

    it('still aborts a delete for an ended-session row referenced by workload_nudge_facts', () => {
      const proj = mkProject('retention-nudged');
      const lane = bindProject(proj);
      const t = Date.parse('2026-10-30T00:00:00Z');
      const r = store.workloadReceipts.append(
        receiptRow(proj.id, lane.sessionId, lane.launchId, 1, new Date(t).toISOString()),
        { minIntervalMs: 0, nowMs: t }
      );
      store.workloadNudgeFacts.record({
        project_id: proj.id, session_id: lane.sessionId, launch_id: lane.launchId, receipt_id: r.row.receipt_id,
        kind: 'nudged', code: 'x', created_at: new Date(t).toISOString()
      });
      store.sessions.kill(lane.sessionId);
      const db = store.getDb();
      workload.ensureWorkloadRetentionTriggers(db);
      assert.throws(() => db.prepare('DELETE FROM workload_receipts WHERE receipt_id = ?').run(r.row.receipt_id), /append-only/);
    });

    it('still aborts a delete for an ended-session row referenced by bridge_candidate_receipts', () => {
      const proj = mkProject('retention-bridged');
      const lane = bindProject(proj);
      const t = Date.parse('2026-10-30T00:00:00Z');
      const r = store.workloadReceipts.append(
        receiptRow(proj.id, lane.sessionId, lane.launchId, 1, new Date(t).toISOString()),
        { minIntervalMs: 0, nowMs: t }
      );
      const db = store.getDb();
      db.prepare(
        `INSERT INTO bridge_candidates
           (candidate_id, idem_key, kind, source_project_id, source_launch_id, digest, state, created_at)
         VALUES ('cand-1', 'idem-1', 'milestone', ?, ?, ?, 'submitted', ?)`
      ).run(proj.id, lane.launchId, 'd'.repeat(64), new Date(t).toISOString());
      db.prepare(
        `INSERT INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest)
         VALUES ('cand-1', 'workload', ?, ?)`
      ).run(String(r.row.receipt_id), 'e'.repeat(64));
      store.sessions.kill(lane.sessionId);
      workload.ensureWorkloadRetentionTriggers(db);
      assert.throws(() => db.prepare('DELETE FROM workload_receipts WHERE receipt_id = ?').run(r.row.receipt_id), /append-only/);
    });

    it('still aborts a delete for a live-session workload_narrowings row (unchanged behavior)', () => {
      const proj = mkProject('retention-narrowing-live');
      const lane = bindProject(proj);
      const t = Date.parse('2026-10-30T00:00:00Z');
      const n = store.workloadReceipts.appendNarrowing({
        project_id: proj.id, session_id: lane.sessionId, launch_id: lane.launchId, action: 'narrow',
        cap_clearance: 1, force_unknown: 0, reason: 'r', operator_proof: 'verified-session',
        created_at: new Date(t).toISOString()
      });
      const db = store.getDb();
      workload.ensureWorkloadRetentionTriggers(db);
      assert.throws(() => db.prepare('DELETE FROM workload_narrowings WHERE narrowing_id = ?').run(n.narrowing_id), /append-only/);
    });

    it('allows deleting a workload_narrowings row once its session has ended', () => {
      const proj = mkProject('retention-narrowing-ended');
      const lane = bindProject(proj);
      const t = Date.parse('2026-10-30T00:00:00Z');
      const n = store.workloadReceipts.appendNarrowing({
        project_id: proj.id, session_id: lane.sessionId, launch_id: lane.launchId, action: 'narrow',
        cap_clearance: 1, force_unknown: 0, reason: 'r', operator_proof: 'verified-session',
        created_at: new Date(t).toISOString()
      });
      store.sessions.kill(lane.sessionId);
      const db = store.getDb();
      workload.ensureWorkloadRetentionTriggers(db);
      db.prepare('DELETE FROM workload_narrowings WHERE narrowing_id = ?').run(n.narrowing_id);
      assert.equal(countRows('workload_narrowings', lane.launchId), 0);
    });
  });

  describe('pruneWorkloadHistory', () => {
    it('keeps the newest launches\' newest rows, drops older launches\' unreferenced rows, and never drops a referenced one', () => {
      workload._setRetention({ endedLaunchesPerProject: 2, receiptsPerEndedLaunch: 2, narrowingsPerEndedLaunch: 1 });
      const proj = mkProject('retention-prune');
      const t = Date.parse('2026-10-30T00:00:00Z');
      const lanes = [];
      let referencedReceiptId;
      for (let i = 0; i < 4; i++) {
        const lane = bindProject(proj);
        lanes.push(lane);
        for (let s = 0; s < 3; s++) {
          const at = t + i * 60000 + s * 1000;
          const result = store.workloadReceipts.append(
            receiptRow(proj.id, lane.sessionId, lane.launchId, s + 1, new Date(at).toISOString()),
            { minIntervalMs: 0, nowMs: at }
          );
          // The oldest launch's oldest receipt is referenced: it must survive
          // pruning even though its launch ranks beyond the kept quota.
          if (i === 0 && s === 0) referencedReceiptId = result.row.receipt_id;
        }
        store.workloadReceipts.appendNarrowing({
          project_id: proj.id, session_id: lane.sessionId, launch_id: lane.launchId, action: 'narrow',
          cap_clearance: 1, force_unknown: 0, reason: 'first', operator_proof: 'verified-session',
          created_at: new Date(t + i * 60000).toISOString()
        });
        store.workloadReceipts.appendNarrowing({
          project_id: proj.id, session_id: lane.sessionId, launch_id: lane.launchId, action: 'narrow',
          cap_clearance: 1, force_unknown: 0, reason: 'second', operator_proof: 'verified-session',
          created_at: new Date(t + i * 60000 + 500).toISOString()
        });
        store.sessions.kill(lane.sessionId);
      }
      store.workloadNudgeFacts.record({
        project_id: proj.id, session_id: lanes[0].sessionId, launch_id: lanes[0].launchId,
        receipt_id: referencedReceiptId, kind: 'nudged', code: 'x', created_at: new Date(t).toISOString()
      });

      workload.pruneWorkloadHistory({ projectId: proj.id });

      // Launches 0 and 1 rank beyond the quota of 2: all unreferenced rows
      // are gone, but launch 0's referenced receipt survives regardless.
      assert.equal(countRows('workload_receipts', lanes[0].launchId), 1, 'only the referenced receipt survives');
      assert.equal(countRows('workload_narrowings', lanes[0].launchId), 0);
      assert.equal(countRows('workload_receipts', lanes[1].launchId), 0);
      assert.equal(countRows('workload_narrowings', lanes[1].launchId), 0);
      // Launches 2 and 3 are the newest 2: keep their newest 2 of 3 receipts
      // and newest 1 of 2 narrowings each.
      assert.equal(countRows('workload_receipts', lanes[2].launchId), 2);
      assert.equal(countRows('workload_narrowings', lanes[2].launchId), 1);
      assert.equal(countRows('workload_receipts', lanes[3].launchId), 2);
      assert.equal(countRows('workload_narrowings', lanes[3].launchId), 1);
      assert.equal(store.workloadReceipts.activeNarrowing(lanes[3].launchId).reason, 'second', 'the newest narrowing is the one kept');
    });

    it('is a no-op with no projectId, and a no-op for a project with no ended launches', () => {
      assert.doesNotThrow(() => workload.pruneWorkloadHistory());
      assert.doesNotThrow(() => workload.pruneWorkloadHistory({}));
      const proj = mkProject('retention-noop');
      const lane = bindProject(proj); // still active — nothing ended
      store.workloadReceipts.append(
        receiptRow(proj.id, lane.sessionId, lane.launchId, 1, new Date(Date.parse('2026-10-30T00:00:00Z')).toISOString()),
        { minIntervalMs: 0, nowMs: Date.parse('2026-10-30T00:00:00Z') }
      );
      workload.pruneWorkloadHistory({ projectId: proj.id });
      assert.equal(countRows('workload_receipts', lane.launchId), 1, 'an active-session launch is never touched');
    });

    it('an active session keeps every row even when the per-launch quota would otherwise prune most of them', () => {
      workload._setRetention({ endedLaunchesPerProject: 50, receiptsPerEndedLaunch: 2, narrowingsPerEndedLaunch: 1 });
      const proj = mkProject('retention-active-over-quota');
      const lane = bindProject(proj); // stays active — never killed
      const t = Date.parse('2026-10-30T00:00:00Z');
      for (let i = 0; i < 5; i++) {
        store.workloadReceipts.append(
          receiptRow(proj.id, lane.sessionId, lane.launchId, i + 1, new Date(t + i * 1000).toISOString()),
          { minIntervalMs: 0, nowMs: t + i * 1000 }
        );
      }
      for (let i = 0; i < 3; i++) {
        store.workloadReceipts.appendNarrowing({
          project_id: proj.id, session_id: lane.sessionId, launch_id: lane.launchId, action: 'narrow',
          cap_clearance: 1, force_unknown: 0, reason: `n${i}`, operator_proof: 'verified-session',
          created_at: new Date(t + i * 1000).toISOString()
        });
      }
      workload.pruneWorkloadHistory({ projectId: proj.id });
      assert.equal(countRows('workload_receipts', lane.launchId), 5, 'all 5 receipts survive though the quota is 2 — the session is still active');
      assert.equal(countRows('workload_narrowings', lane.launchId), 3, 'all 3 narrowings survive though the quota is 1 — the session is still active');
    });

    it('ranks ended launches by timestamp, never by raw receipt_id vs narrowing_id — those are independent sequences on different tables', () => {
      workload._setRetention({ endedLaunchesPerProject: 1, receiptsPerEndedLaunch: 5, narrowingsPerEndedLaunch: 5 });
      const proj = mkProject('retention-rank-by-time');
      const db = store.getDb();

      // Push workload_receipts' sequence comfortably past workload_narrowings'
      // current high-water mark, so a numeric-id comparison (the bug this test
      // guards against) would rank the receipt-heavy launch "newer" than it
      // really is.
      const narrowingHigh = db.prepare('SELECT COALESCE(MAX(narrowing_id), 0) AS n FROM workload_narrowings').get().n;
      const laneOld = bindProject(proj);
      const oldT = Date.parse('2020-01-01T00:00:00Z');
      let lastReceiptId = 0;
      for (let i = 0; i <= narrowingHigh + 10; i++) {
        const r = store.workloadReceipts.append(
          receiptRow(proj.id, laneOld.sessionId, laneOld.launchId, i + 1, new Date(oldT + i * 1000).toISOString()),
          { minIntervalMs: 0, nowMs: oldT + i * 1000 }
        );
        lastReceiptId = r.row.receipt_id;
      }
      assert.ok(lastReceiptId > narrowingHigh, 'the receipt-heavy launch\'s id now exceeds every existing narrowing id');
      store.sessions.kill(laneOld.sessionId);

      const laneNew = bindProject(proj);
      const newT = Date.parse('2026-10-30T00:00:00Z'); // chronologically much newer than laneOld
      store.workloadReceipts.appendNarrowing({
        project_id: proj.id, session_id: laneNew.sessionId, launch_id: laneNew.launchId, action: 'narrow',
        cap_clearance: 1, force_unknown: 0, reason: 'newer launch, narrowing only', operator_proof: 'verified-session',
        created_at: new Date(newT).toISOString()
      });
      store.sessions.kill(laneNew.sessionId);

      workload.pruneWorkloadHistory({ projectId: proj.id });

      // The chronologically NEWER launch (narrowing-only, low narrowing_id) is
      // the one quota=1 keeps — not the older, receipt-heavy launch whose raw
      // receipt_id happens to be numerically larger.
      assert.ok(countRows('workload_narrowings', laneNew.launchId) > 0, 'the newer launch\'s narrowing survives');
      assert.equal(countRows('workload_receipts', laneOld.launchId), 0, 'the older, receipt-heavy launch is pruned despite its higher raw id');
    });
  });

  describe('record()/recordNarrowing() prune on their success path', () => {
    it('record() runs pruneWorkloadHistory for the writing project after a successful append', async () => {
      const proj = mkProject('retention-hook-record');
      const lane = bindProject(proj);
      const real = workload.pruneWorkloadHistory;
      let calledWith = null;
      workload.pruneWorkloadHistory = (arg) => { calledWith = arg; };
      try {
        const r = workload.record({ req: { headers: { ...lane.headers, ...TC } }, body: OK });
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.deepEqual(calledWith, { projectId: proj.id });
      } finally {
        workload.pruneWorkloadHistory = real;
      }
    });

    it('a prune failure after record() is logged, not thrown — the receipt write still succeeds', () => {
      const proj = mkProject('retention-hook-record-fails');
      const lane = bindProject(proj);
      const real = workload.pruneWorkloadHistory;
      workload.pruneWorkloadHistory = () => { throw new Error('boom'); };
      try {
        const r = workload.record({ req: { headers: { ...lane.headers, ...TC } }, body: OK });
        assert.equal(r.status, 201, 'a prune failure never fails the write that already succeeded');
      } finally {
        workload.pruneWorkloadHistory = real;
      }
    });

    it('recordNarrowing() runs pruneWorkloadHistory for the narrowed session\'s project', () => {
      const proj = mkProject('retention-hook-narrowing');
      const lane = bindProject(proj);
      const real = workload.pruneWorkloadHistory;
      let calledWith = null;
      workload.pruneWorkloadHistory = (arg) => { calledWith = arg; };
      try {
        const r = workload.recordNarrowing({
          caller: { kind: 'operator', actor: { operatorProof: 'verified-session' } },
          body: { sessionId: lane.sessionId, capClearance: true, reason: 'test narrowing' }
        });
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.deepEqual(calledWith, { projectId: proj.id });
      } finally {
        workload.pruneWorkloadHistory = real;
      }
    });
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
      db.exec('DROP TRIGGER workload_narrowings_append_only_update');
      db.exec('DROP TRIGGER workload_narrowings_append_only_delete');
      db.exec('DROP TABLE workload_narrowings');
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
        assert.equal(after.prepare('SELECT MAX(version) v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
        const sql = after.prepare("SELECT sql FROM sqlite_master WHERE name = 'workload_receipts'").get().sql;
        assert.match(sql, /UNIQUE \(launch_id, seq\)/);
        const triggers = after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workload_receipts%'")
          .all().map((r) => r.name).sort();
        assert.deepEqual(triggers, ['workload_receipts_append_only_delete', 'workload_receipts_append_only_update']);
        assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workload_narrowings'").get(),
          'the narrowings table arrives with the same migration');
      } finally {
        after.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
