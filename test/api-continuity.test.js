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

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-cc5-'));
    store._setBasePath(tmpDir);
    store.init();

    projDir = path.join(tmpDir, projectName);
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({
      name: projectName, path: projDir, engine: 'claude', methodology: 'prawduct', tags: [], ports: {}
    });

    // Seed the continuity store: two sessions + a cold transcript for 42.
    continuity.appendChangelogEntry(projDir, {
      date: '2026-06-17', sid: 42, line: 'auth redirect fix', tags: 'auth, redirect', refs: '#344', type: 'fix', files: ['lib/auth.js']
    });
    continuity.appendChangelogEntry(projDir, {
      date: '2026-06-10', sid: 41, line: 'added widget', tags: 'widget', type: 'feat', files: ['lib/widget.js']
    });
    continuity.writeWrapSummary(projDir, 42, {
      meta: { session: 42, date: '2026-06-17', tags: 'auth, redirect', type: 'fix', files: ['lib/auth.js'] },
      sections: { 'Where we are': 'fixed the auth redirect bug', 'Next action': 'ship it' }
    });
    const sd = continuity.sessionDir(projDir, 42);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'transcript.jsonl'),
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T10:00:00Z', message: { role: 'user', content: 'the auth redirect keeps looping' } }) + '\n');
    fs.writeFileSync(path.join(sd, 'transcript.meta.json'),
      JSON.stringify({ harness: 'claude', secretsFlagged: false, secretTypes: [], bytes: 90, lineCount: 1, capturedAt: '2026-06-17T10:05:00Z', source: '/Users/secret/.claude/x.jsonl' }));

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
    assert.deepEqual(res.data.sessions.map((s) => s.sid), ['42']);
    assert.equal(res.data.meta.matched, 1);
  });

  it('GET /search honors filters (type=feat browse)', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/search?type=feat`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.sessions.map((s) => s.sid), ['41']);
  });

  it('GET /sessions lists the whole store, newest first', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.sessions.map((s) => s.sid), ['42', '41']);
  });

  it('GET /sessions/:sid returns summary + transcript meta (no source leak) + uploads', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions/42`);
    assert.equal(res.status, 200);
    assert.equal(res.data.summary.sections['Next action'], 'ship it');
    assert.equal(res.data.transcript.harness, 'claude');
    assert.equal(res.data.transcript.secretsFlagged, false);
    assert.equal(res.data.transcript.source, undefined, 'absolute ~/.claude path is not leaked');
    assert.ok(Array.isArray(res.data.uploads));
  });

  it('GET /sessions/:sid/transcript/search finds cold-tier excerpts', async () => {
    const res = await request(server, 'GET', `/api/continuity/${projectName}/sessions/42/transcript/search?q=redirect`);
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
