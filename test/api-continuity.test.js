'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const continuity = require('../lib/continuity');
const transcript = require('../lib/transcript');
const { createServer } = require('../server');

setLevel('error');

function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('API /api/continuity (CC-5 operator search)', () => {
  let tmpDir;
  let server;
  const projectName = 'cc5-api-proj';
  let projDir;
  /** The real store.sessions id standing in for this suite's old literal `42` sid. */
  let sid42;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-cc5-'));
    store._setBasePath(tmpDir);
    store.init();

    projDir = path.join(tmpDir, projectName);
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({
      name: projectName, path: projDir, engine: 'claude', tags: [], ports: {}
    });
    // #2881: the drill-down route's transcript field now resolves through a
    // REAL store.sessions row (lib/session-history-backfill.js#
    // ensureSessionTranscript needs .engineId/.startedAt, which continuity's
    // own session object never carries) -- sid42 IS that row's real id, used
    // everywhere below a literal `42` previously stood in for it.
    sid42 = String(store.sessions.start({ projectId: project.id, engineId: 'claude' }).id);

    // Seed the continuity store: two sessions + a cold transcript for sid42.
    continuity.appendChangelogEntry(projDir, {
      date: '2026-06-17', sid: sid42, line: 'auth redirect fix', tags: 'auth, redirect', refs: '#344', type: 'fix', files: ['lib/auth.js']
    });
    continuity.appendChangelogEntry(projDir, {
      date: '2026-06-10', sid: 41, line: 'added widget', tags: 'widget', type: 'feat', files: ['lib/widget.js']
    });
    continuity.writeWrapSummary(projDir, sid42, {
      meta: { session: sid42, date: '2026-06-17', tags: 'auth, redirect', type: 'fix', files: ['lib/auth.js'] },
      sections: { 'Where we are': 'fixed the auth redirect bug', 'Next action': 'ship it' }
    });
    const sd = continuity.sessionDir(projDir, sid42);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'transcript.jsonl'),
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T10:00:00Z', message: { role: 'user', content: 'the auth redirect keeps looping' } }) + '\n');
    fs.writeFileSync(path.join(sd, 'transcript.meta.json'),
      JSON.stringify({ harness: 'claude', secretsFlagged: false, secretTypes: [], bytes: 90, lineCount: 1, capturedAt: '2026-06-17T10:05:00Z', source: '/Users/secret/.claude/x.jsonl' }));
    // A session-linked upload so the drill-down uploads list is exercised.
    const ud = continuity.sessionUploadsDir(projDir, sid42);
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'shot.png'), 'png-bytes');

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /search returns ranked sessions + meta', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/search?q=auth`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.sessions.map((s) => s.sid), [sid42]);
    assert.equal(res.data.meta.matched, 1);
  });

  it('GET /search honors filters (type=feat browse)', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/search?type=feat`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.sessions.map((s) => s.sid), ['41']);
  });

  it('GET /search?scope=transcripts greps the captured transcripts directly', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/search?scope=transcripts&q=redirect`);
    assert.equal(res.status, 200);
    assert.equal(res.data.meta.scope, 'transcripts');
    assert.deepEqual(res.data.sessions.map((s) => s.sid), [sid42], 'only the session whose transcript matches');
    assert.equal(res.data.sessions[0].hits[0].source, 'transcript');
  });

  it('GET /sessions lists the whole store, newest first', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.sessions.map((s) => s.sid), [sid42, '41']);
  });

  it('GET /sessions/:sid returns summary + transcript meta (no source leak) + uploads', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions/${sid42}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.summary.sections['Next action'], 'ship it');
    assert.equal(res.data.transcript.harness, 'claude');
    assert.equal(res.data.transcript.secretsFlagged, false);
    // #2881: the enum provenance TAG is fine to expose now (it is never a
    // path) -- this meta fixture predates `capturedVia`, so the honest
    // answer is null (unknown provenance), not the removed `undefined`.
    assert.equal(res.data.transcript.source, null, 'a provenance TAG is fine; the absolute ~/.claude PATH is still never leaked');
    // The session's uploads surface (filtered on `session`, the listUploads field).
    assert.ok(res.data.uploads.some((u) => (u.name || '').includes('shot.png')), 'per-session upload listed');
  });

  it('rejects a path-traversal session id with 400 (no store escape)', async () => {
    const evil = encodeURIComponent('../../etc'); // %2E%2E%2F… → decoded after the route regex
    const drill = await request(server, 'GET', `/api/continuity/${projectName}/sessions/${evil}`);
    assert.equal(drill.status, 400);
    const cold = await request(server, 'GET', `/api/continuity/${projectName}/sessions/${evil}/transcript/search?q=x`);
    assert.equal(cold.status, 400);
  });

  it('GET /sessions/:sid/transcript/search finds cold-tier excerpts', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions/${sid42}/transcript/search?q=redirect`);
    assert.equal(res.status, 200);
    assert.equal(res.data.available, true);
    assert.ok(res.data.excerpts.length >= 1);
    assert.equal(res.data.excerpts[0].role, 'user');
  });

  it('404s for an unknown project', async () => {
    const res = await request(server, 'GET', '/api/continuity/no-such-project/sessions');
    assert.equal(res.status, 404);
  });
});

// #2881 (#2074 Slice 3): the drill-down route now wires
// lib/session-history-backfill.js#ensureSessionTranscript, for real -- not
// just a bare continuity.readTranscriptMeta read. This describe block
// proves the actual backfill path (no pre-existing transcript.meta.json),
// which the suite above never exercises since its fixture writes one
// directly. Isolated from that suite's own store/server, same convention
// test/session-history-backfill-ui.test.js uses for a real (unmocked)
// backfillTranscript.
describe('API /api/continuity GET /sessions/:sid -- live transcript backfill (#2881)', () => {
  let tmpDir;
  let server;
  let projDir;
  let claudeHome;
  let realClaudeHome;
  const projectName = 'cc5-backfill-proj';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-cc5-backfill-'));
    store._setBasePath(tmpDir);
    store.init();
    projDir = path.join(tmpDir, projectName);
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({ name: projectName, path: projDir, engine: 'claude', tags: [], ports: {} });

    claudeHome = path.join(tmpDir, 'claude-home');
    realClaudeHome = transcript._internal.claudeHome;
    transcript._internal.claudeHome = () => claudeHome;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    transcript._internal.claudeHome = realClaudeHome;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills from the harness\'s native log and reports native-log-backfill, with no absolute path leaked', async () => {
    const project = store.projects.getByName(projectName);
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude' });
    const sid = String(session.id);

    // A resolvable real .claude transcript for this project path -- same
    // fixture shape test/session-history-backfill-ui.test.js#
    // writeRealClaudeTranscript writes, against the REAL (unmocked)
    // backfillTranscript/_claudeResolve.
    const enc = transcript._encodeDir(projDir);
    const dir = path.join(claudeHome, 'projects', enc);
    fs.mkdirSync(dir, { recursive: true });
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), [
      JSON.stringify({ type: 'summary', mode: 'x', sessionId: uuid }),
      JSON.stringify({ type: 'message', role: 'user', cwd: projDir, content: 'hello' })
    ].join('\n') + '\n');

    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions/${sid}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.transcript.harness, 'claude');
    assert.equal(res.data.transcript.source, 'native-log-backfill');
    assert.ok(res.data.transcript.capturedAt, 'backfilledAt surfaces as capturedAt');
    assert.doesNotMatch(JSON.stringify(res.data.transcript), /claude-home/, 'no absolute path is leaked');

    // Idempotent: a second read sees the now-persisted capture, not a second backfill.
    const second = await request(server, 'GET', `/api/continuity/${projectName}/sessions/${sid}`);
    assert.equal(second.data.transcript.source, 'native-log-backfill');
  });

  it('a session with no store.sessions row at all (legacy/cross-project) reads as no transcript, never a crash', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions/999999`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.transcript, null);
  });

  it('a session row that belongs to a DIFFERENT project never resolves through this project\'s URL', async () => {
    const otherDir = fs.mkdtempSync(path.join(tmpDir, 'other-'));
    const otherProject = store.projects.create({ name: 'cc5-backfill-other', path: otherDir, engine: 'claude', tags: [], ports: {} });
    const otherSession = store.sessions.start({ projectId: otherProject.id, engineId: 'claude' });

    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions/${otherSession.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.transcript, null, 'a different project\'s session id resolves no transcript through this project\'s URL');
  });
});
