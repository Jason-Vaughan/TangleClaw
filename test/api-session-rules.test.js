'use strict';

/*
 * HTTP route tests for the session-rules REST API (#347/D1a):
 * GET/POST/PUT/DELETE /api/session-rules. Rules are always project-scoped
 * (the hidden global tier was retired with the Phase A settings cleanup).
 * Mirrors the harness in test/api-actions.test.js (real server on an
 * ephemeral port).
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

describe('api/session-rules (#347/D1a)', () => {
  let server;
  let port;
  let tmpDir;
  let projectId;

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-session-rules-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    const projPath = path.join(tmpDir, 'rules-proj');
    fs.mkdirSync(projPath, { recursive: true });
    projectId = store.projects.create({ name: 'rules-proj', path: projPath, engine: 'claude' }).id;
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

  it('full lifecycle: create → list → update → delete', async () => {
    // Create
    const created = await request('POST', '/api/session-rules', { content: 'Prefer small commits', projectId });
    assert.equal(created.status, 201);
    assert.equal(created.data.content, 'Prefer small commits');
    assert.equal(created.data.projectId, projectId);
    assert.equal(created.data.createdBy, 'operator');
    const id = created.data.id;

    // List (project scope)
    const listed = await request('GET', `/api/session-rules?projectId=${projectId}`);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.rules.some((r) => r.id === id));

    // Update (disable)
    const updated = await request('PUT', `/api/session-rules/${id}`, { enabled: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.enabled, false);

    // Delete
    const deleted = await request('DELETE', `/api/session-rules/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.ok, true);

    const afterDelete = await request('GET', `/api/session-rules?projectId=${projectId}`);
    assert.ok(!afterDelete.data.rules.some((r) => r.id === id));
  });

  it('rejects a projectId-less create with 400 (global tier retired)', async () => {
    const res = await request('POST', '/api/session-rules', { content: 'global?' });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'BAD_REQUEST');
    assert.match(res.data.error, /projectId is required/);
  });

  it('rejects empty content with 400', async () => {
    const res = await request('POST', '/api/session-rules', { content: '   ', projectId });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'BAD_REQUEST');
  });

  it('returns 404 updating a missing rule', async () => {
    const res = await request('PUT', '/api/session-rules/99999', { enabled: false });
    assert.equal(res.status, 404);
  });

  it('returns 404 deleting a missing rule', async () => {
    const res = await request('DELETE', '/api/session-rules/99999');
    assert.equal(res.status, 404);
  });

  // CC-6 (#381): kind passthrough on create + list filtering.
  it('creates with a kind and lists filtered by kind', async () => {
    const wrap = await request('POST', '/api/session-rules', { content: 'wrap the session deeply', kind: 'wrap', projectId });
    assert.equal(wrap.status, 201);
    assert.equal(wrap.data.kind, 'wrap');

    const startup = await request('POST', '/api/session-rules', { content: 'prime with project context', kind: 'startup', projectId });
    assert.equal(startup.status, 201);

    const wraps = await request('GET', `/api/session-rules?projectId=${projectId}&kind=wrap`);
    assert.equal(wraps.status, 200);
    assert.ok(wraps.data.rules.some((r) => r.id === wrap.data.id));
    assert.ok(!wraps.data.rules.some((r) => r.id === startup.data.id));
  });

  it('defaults kind to startup when omitted', async () => {
    const res = await request('POST', '/api/session-rules', { content: 'no kind here', projectId });
    assert.equal(res.status, 201);
    assert.equal(res.data.kind, 'startup');
  });

  it('rejects an invalid kind with 400', async () => {
    const res = await request('POST', '/api/session-rules', { content: 'bad kind', kind: 'nope', projectId });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'BAD_REQUEST');
  });

  // Master Hard rules — singleton-scoped kind + the eyes-open baseline guard.
  describe('master kind', () => {
    it('creates without a projectId and rejects one when provided', async () => {
      const ok = await request('POST', '/api/session-rules', { content: 'master boundary rule', kind: 'master' });
      assert.equal(ok.status, 201);
      assert.equal(ok.data.kind, 'master');
      assert.equal(ok.data.projectId, null);

      const bad = await request('POST', '/api/session-rules', { content: 'scoped master?', kind: 'master', projectId });
      assert.equal(bad.status, 400);
      assert.match(bad.data.error, /singleton-scoped/);
    });

    it('still requires projectId for non-master kinds', async () => {
      const res = await request('POST', '/api/session-rules', { content: 'needs a project', kind: 'startup' });
      assert.equal(res.status, 400);
    });

    it('guards system (baseline) rules: edit/disable/delete need the confirm flag; operator rules do not', async () => {
      const system = store.sessionRules.create({ content: 'shipped boundary', kind: 'master', createdBy: 'system' });

      const editNoConfirm = await request('PUT', `/api/session-rules/${system.id}`, { content: 'weakened' });
      assert.equal(editNoConfirm.status, 400);
      assert.equal(editNoConfirm.data.code, 'CONFIRM_REQUIRED');

      const disableNoConfirm = await request('PUT', `/api/session-rules/${system.id}`, { enabled: false });
      assert.equal(disableNoConfirm.status, 400);
      assert.equal(disableNoConfirm.data.code, 'CONFIRM_REQUIRED');

      // Re-enabling and no-op updates never need the confirm.
      const reEnable = await request('PUT', `/api/session-rules/${system.id}`, { enabled: true });
      assert.equal(reEnable.status, 200);

      const disableConfirmed = await request('PUT', `/api/session-rules/${system.id}`, { enabled: false, confirmBaselineEdit: true });
      assert.equal(disableConfirmed.status, 200);
      assert.equal(disableConfirmed.data.enabled, false);

      const deleteNoConfirm = await request('DELETE', `/api/session-rules/${system.id}`);
      assert.equal(deleteNoConfirm.status, 400);
      assert.equal(deleteNoConfirm.data.code, 'CONFIRM_REQUIRED');

      const deleteConfirmed = await request('DELETE', `/api/session-rules/${system.id}?confirm=true`);
      assert.equal(deleteConfirmed.status, 200);

      // Operator-authored master rules mutate freely — the guard is provenance-scoped.
      const mine = await request('POST', '/api/session-rules', { content: 'my own rule', kind: 'master' });
      const editMine = await request('PUT', `/api/session-rules/${mine.data.id}`, { content: 'my edited rule' });
      assert.equal(editMine.status, 200);
      const deleteMine = await request('DELETE', `/api/session-rules/${mine.data.id}`);
      assert.equal(deleteMine.status, 200);
    });

    it('version restore carries the same baseline gate as PUT/DELETE (no bypass through history)', async () => {
      const system = store.sessionRules.create({ content: 'boundary v1', kind: 'master', createdBy: 'system' });
      // Build history: v1 (create) → v2 (confirmed content edit).
      await request('PUT', `/api/session-rules/${system.id}`, { content: 'boundary v2', confirmBaselineEdit: true });

      // Restoring v1 changes content → gate fires without the flag.
      const noConfirm = await request('POST', `/api/session-rules/${system.id}/restore`, { versionNo: 1 });
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.data.code, 'CONFIRM_REQUIRED');

      // Restoring the identical current state weakens nothing → no confirm needed.
      const noop = await request('POST', `/api/session-rules/${system.id}/restore`, { versionNo: 2 });
      assert.equal(noop.status, 200);

      const confirmed = await request('POST', `/api/session-rules/${system.id}/restore`, { versionNo: 1, confirmBaselineEdit: true });
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.data.content, 'boundary v1');

      await request('DELETE', `/api/session-rules/${system.id}?confirm=true`);
    });

    it('POST /api/master/rules/restore-defaults replaces everything with the shipped baseline', async () => {
      const master = require('../lib/master');
      await request('POST', '/api/session-rules', { content: 'stray custom rule', kind: 'master' });
      const res = await request('POST', '/api/master/rules/restore-defaults');
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.equal(res.data.rules.length, master.MASTER_BASELINE_RULES.length);
      assert.ok(res.data.rules.every((r) => r.createdBy === 'system'));
      assert.ok(!res.data.rules.some((r) => r.content === 'stray custom rule'));
    });
  });

  describe('GET /api/session-rules/deliveries (#595)', () => {
    it('returns a session\'s deliveries, including the undelivered attempts', async () => {
      store.sessionRuleDeliveries.record({ sessionId: 9001, projectId, engineId: 'openclaw', channel: 'none', outcome: 'skipped', skipReason: 'engine declares no prime channel', ruleIds: [1], digest: 'sha-x' });
      store.sessionRuleDeliveries.record({ sessionId: 9001, projectId, engineId: 'claude', channel: 'prime-file', outcome: 'delivered', ruleIds: [1], digest: 'sha-x' });

      const res = await request('GET', '/api/session-rules/deliveries?sessionId=9001');
      assert.equal(res.status, 200);
      assert.equal(res.data.deliveries.length, 2);
      // A ledger that hid failures could not distinguish "no rules" from
      // "rules never arrived" — the whole point of #595.
      assert.ok(res.data.deliveries.some((d) => d.delivered === false && /no prime channel/.test(d.skipReason)));
      assert.ok(res.data.deliveries.some((d) => d.delivered === true && d.digest === 'sha-x'));
    });

    it('returns a project\'s delivery history newest-first', async () => {
      store.sessionRuleDeliveries.record({ sessionId: 9002, projectId, engineId: 'claude', channel: 'prime-paste', outcome: 'delivered', digest: 'newest' });
      const res = await request('GET', `/api/session-rules/deliveries?projectId=${projectId}&limit=1`);
      assert.equal(res.status, 200);
      assert.equal(res.data.deliveries.length, 1);
      assert.equal(res.data.deliveries[0].digest, 'newest');
    });

    it('with no scope, answers the fleet question: rules configured but never delivered', async () => {
      // A dedicated project — `rules-proj` already has a delivered row from the
      // case above, so it is correctly NOT a finding.
      const strandedPath = path.join(tmpDir, 'stranded-proj');
      fs.mkdirSync(strandedPath, { recursive: true });
      const stranded = store.projects.create({ name: 'stranded-proj', path: strandedPath, engine: 'claude' });
      store.sessionRules.create({ content: 'configured but never delivered', projectId: stranded.id });
      store.sessionRuleDeliveries.record({ projectId: stranded.id, engineId: 'openclaw', channel: 'none', outcome: 'skipped', skipReason: 'no prime channel', ruleIds: [1] });

      try {
        const res = await request('GET', '/api/session-rules/deliveries');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.data.undelivered));
        assert.ok(res.data.undelivered.some((r) => r.projectId === stranded.id), 'the stranded project must be flagged');
        assert.ok(!res.data.undelivered.some((r) => r.projectId === projectId), 'a project with a delivered row must not be');
      } finally {
        for (const rule of store.sessionRules.list({ projectId: stranded.id })) store.sessionRules.delete(rule.id);
        store.projects.delete(stranded.id);
      }
    });
  });
});
