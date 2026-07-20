'use strict';

/*
 * HTTP route tests for the D1b session-rules self-improvement endpoints:
 * POST /promote, POST /conflicts, GET /:id/versions, POST /:id/restore.
 * Mirrors the harness in test/api-session-rules.test.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { createServer } = require('../server');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('api/session-rules self-improvement (D1b)', () => {
  let server;
  let port;
  let tmpDir;
  let learningId;
  let pid;

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1', port, path: urlPath, method,
        headers: { 'Content-Type': 'application/json' }
      };
      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-sr-si-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    const projPath = path.join(tmpDir, 'proj');
    fs.mkdirSync(projPath, { recursive: true });
    pid = store.projects.create({ name: 'proj', path: projPath, engine: 'claude' }).id;
    learningId = store.learnings.create({ projectId: pid, content: 'Prefer dependency injection' }).id;
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('promotes a learning into a rule', async () => {
    const res = await request('POST', '/api/session-rules/promote', { learningId });
    assert.equal(res.status, 201);
    assert.equal(res.data.createdBy, 'ai');
    assert.equal(res.data.sourceLearningId, learningId);
    assert.equal(res.data.content, 'Prefer dependency injection');
  });

  it('returns 404 promoting a missing learning, 400 without learningId', async () => {
    assert.equal((await request('POST', '/api/session-rules/promote', { learningId: 99999 })).status, 404);
    assert.equal((await request('POST', '/api/session-rules/promote', {})).status, 400);
  });

  it('surfaces conflict candidates', async () => {
    await request('POST', '/api/session-rules', { content: 'Always run the full test suite before commit', projectId: pid });
    const res = await request('POST', '/api/session-rules/conflicts', { content: 'skip the test suite for tiny commit', projectId: pid });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.candidates));
    assert.ok(res.data.candidates.some((c) => /test suite/.test(c.rule.content)));
  });

  it('400 on conflicts without content', async () => {
    assert.equal((await request('POST', '/api/session-rules/conflicts', {})).status, 400);
  });

  it('lists versions and restores a prior version', async () => {
    const created = (await request('POST', '/api/session-rules', { content: 'rev one', projectId: pid })).data;
    await request('PUT', `/api/session-rules/${created.id}`, { content: 'rev two' });

    const versions = (await request('GET', `/api/session-rules/${created.id}/versions`)).data.versions;
    assert.equal(versions.length, 2);
    assert.equal(versions[0].versionNo, 2);

    const restored = await request('POST', `/api/session-rules/${created.id}/restore`, { versionNo: 1 });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.content, 'rev one');
  });

  it('404 versions for a missing rule; 400 restore without versionNo', async () => {
    assert.equal((await request('GET', '/api/session-rules/99999/versions')).status, 404);
    const created = (await request('POST', '/api/session-rules', { content: 'z', projectId: pid })).data;
    assert.equal((await request('POST', `/api/session-rules/${created.id}/restore`, {})).status, 400);
  });

  it('records the critic_gate attestation through the apply paths and surfaces it on versions (SR-7K2P)', async () => {
    // Operator create with no attestation → derived 'not-required'.
    const created = (await request('POST', '/api/session-rules', { content: 'gate one', projectId: pid })).data;
    let versions = (await request('GET', `/api/session-rules/${created.id}/versions`)).data.versions;
    assert.equal(versions[0].criticGate, 'not-required');

    // Explicit attestation on an AI update flows through.
    await request('PUT', `/api/session-rules/${created.id}`, { content: 'gate two', createdBy: 'ai', changedBy: 'ai', criticGate: 'passed' });
    versions = (await request('GET', `/api/session-rules/${created.id}/versions`)).data.versions;
    assert.equal(versions[0].criticGate, 'passed');

    // Attestation flows through restore too.
    const restored = await request('POST', `/api/session-rules/${created.id}/restore`, { versionNo: 1, changedBy: 'ai', criticGate: 'passed' });
    assert.equal(restored.status, 200);
    versions = (await request('GET', `/api/session-rules/${created.id}/versions`)).data.versions;
    assert.equal(versions[0].criticGate, 'passed');
  });

  it('400s an out-of-enum criticGate on create, update, promote, and restore (SR-7K2P)', async () => {
    assert.equal((await request('POST', '/api/session-rules', { content: 'x', projectId: pid, criticGate: 'maybe' })).status, 400);
    assert.equal((await request('POST', '/api/session-rules/promote', { learningId, criticGate: 'maybe' })).status, 400);
    const created = (await request('POST', '/api/session-rules', { content: 'valid', projectId: pid })).data;
    assert.equal((await request('PUT', `/api/session-rules/${created.id}`, { content: 'y', criticGate: 'nope' })).status, 400);
    assert.equal((await request('POST', `/api/session-rules/${created.id}/restore`, { versionNo: 1, criticGate: 'nope' })).status, 400);
  });
});
