'use strict';

/*
 * HTTP route tests for #569's self-improvement endpoints:
 * GET /api/learnings, PUT /api/learnings/:id/tier, PUT /api/session-rules/:id/status.
 *
 * These exist because the store-level safety property — AI authorship cannot
 * produce a governing rule on its own say-so — was defeated at the HTTP boundary
 * in review: the promote route asserted operator authority merely because it had
 * been reached, and the status route trusted a caller-supplied `changedBy`.
 * Authority now comes from the operator-password gate, and these tests pin that
 * at the door rather than only in the store.
 *
 * Mirrors the harness in test/api-session-rules-selfimprove.test.js.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { createServer } = require('../server');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('api self-improvement loop (#569)', () => {
  let server;
  let port;
  let tmpDir;
  let pid;

  /**
   * Issue a JSON request against the test server.
   * @param {string} method - HTTP method
   * @param {string} urlPath - Path with query string
   * @param {object} [body] - JSON body
   * @returns {Promise<{status: number, data: *}>}
   */
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

  /**
   * Set or clear the operator password used by the approval gate.
   * @param {string|null} plaintext - Password to hash and store, or null to clear
   */
  function setOperatorPassword(plaintext) {
    const cfg = store.config.load();
    cfg.deletePassword = plaintext;
    store.config.save(cfg);
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-selfimprove-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    const projPath = path.join(tmpDir, 'proj');
    fs.mkdirSync(projPath, { recursive: true });
    pid = store.projects.create({ name: 'proj', path: projPath, engine: 'claude', methodology: 'minimal' }).id;
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

  beforeEach(() => {
    setOperatorPassword(null);
  });

  describe('GET /api/learnings', () => {
    it('lists a project\'s learnings and filters by tier', async () => {
      const l = store.learnings.create({ projectId: pid, content: `listable ${Date.now()}` });
      const all = await request('GET', `/api/learnings?projectId=${pid}`);
      assert.equal(all.status, 200);
      assert.ok(all.data.learnings.some((x) => x.id === l.id));

      const active = await request('GET', `/api/learnings?projectId=${pid}&tier=active`);
      assert.equal(active.status, 200);
      assert.ok(!active.data.learnings.some((x) => x.id === l.id), 'a provisional row must not list as active');
    });

    it('requires projectId', async () => {
      const res = await request('GET', '/api/learnings');
      assert.equal(res.status, 400);
    });
  });

  describe('PUT /api/learnings/:id/tier', () => {
    it('lets the operator correct a tier', async () => {
      const l = store.learnings.create({ projectId: pid, content: `tierable ${Date.now()}` });
      const res = await request('PUT', `/api/learnings/${l.id}/tier`, { tier: 'active' });
      assert.equal(res.status, 200);
      assert.equal(res.data.tier, 'active');
    });

    it('rejects an unknown tier and a missing one', async () => {
      const l = store.learnings.create({ projectId: pid, content: `bad tier ${Date.now()}` });
      assert.equal((await request('PUT', `/api/learnings/${l.id}/tier`, { tier: 'nonsense' })).status, 400);
      assert.equal((await request('PUT', `/api/learnings/${l.id}/tier`, {})).status, 400);
    });

    it('404s for a learning that does not exist', async () => {
      assert.equal((await request('PUT', '/api/learnings/999999/tier', { tier: 'active' })).status, 404);
    });
  });

  describe('PUT /api/session-rules/:id/status', () => {
    /**
     * Create a proposed rule to act on.
     * @returns {object} The created rule
     */
    function proposal() {
      return store.sessionRules.create({
        content: `proposal ${Date.now()}-${Math.random()}`, projectId: pid, createdBy: 'ai'
      });
    }

    it('approves a proposal into a governing rule', async () => {
      const rule = proposal();
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'active' });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'active');
    });

    it('records a rejection rather than deleting it', async () => {
      const rule = proposal();
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'rejected' });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'rejected');
      assert.ok(store.sessionRules.get(rule.id), 'the row must survive so it is never re-proposed');
    });

    it('REFUSES to approve without the operator password when one is set', async () => {
      // The property that failed review: authority must come from the gate, not
      // from the request describing itself as the operator.
      const rule = proposal();
      setOperatorPassword('hunter2');
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'active' });
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(rule.id).status, 'proposed', 'a refused approval must not mutate');
    });

    it('cannot be bypassed by claiming to be the operator in the body', async () => {
      const rule = proposal();
      setOperatorPassword('hunter2');
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
        { status: 'active', changedBy: 'operator' });
      assert.equal(res.status, 403);
    });

    it('approves once the password is supplied', async () => {
      const rule = proposal();
      setOperatorPassword('hunter2');
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
        { status: 'active', password: 'hunter2' });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'active');
    });

    it('does not gate a rejection — declining grants nothing', async () => {
      const rule = proposal();
      setOperatorPassword('hunter2');
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'rejected' });
      assert.equal(res.status, 200);
    });

    it('rejects an unknown status, a missing one, and an unknown rule', async () => {
      const rule = proposal();
      assert.equal((await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'maybe' })).status, 400);
      assert.equal((await request('PUT', `/api/session-rules/${rule.id}/status`, {})).status, 400);
      assert.equal((await request('PUT', '/api/session-rules/999999/status', { status: 'active' })).status, 404);
    });
  });

  describe('POST /api/session-rules/promote carries the same gate', () => {
    it('refuses to mint a live rule without the operator password when one is set', async () => {
      const l = store.learnings.create({ projectId: pid, content: `promote guard ${Date.now()}` });
      setOperatorPassword('hunter2');
      const res = await request('POST', '/api/session-rules/promote', { learningId: l.id });
      assert.equal(res.status, 403);
    });

    it('mints a live rule once the password is supplied, keeping AI provenance', async () => {
      const l = store.learnings.create({ projectId: pid, content: `promote ok ${Date.now()}` });
      setOperatorPassword('hunter2');
      const res = await request('POST', '/api/session-rules/promote',
        { learningId: l.id, password: 'hunter2' });
      assert.equal(res.status, 201);
      assert.equal(res.data.status, 'active', 'an operator decision produces a governing rule');
      assert.equal(res.data.createdBy, 'ai', 'provenance survives the approval');
    });
  });

  describe('GET /api/session-rules status filter', () => {
    it('lets a caller ask for active rules only, so proposals are not shown as live', async () => {
      const live = store.sessionRules.create({ content: `live ${Date.now()}`, projectId: pid });
      const prop = store.sessionRules.create({ content: `prop ${Date.now()}`, projectId: pid, createdBy: 'ai' });
      const res = await request('GET', `/api/session-rules?projectId=${pid}&status=active`);
      assert.equal(res.status, 200);
      const ids = res.data.rules.map((r) => r.id);
      assert.ok(ids.includes(live.id));
      assert.ok(!ids.includes(prop.id), 'a proposal must not appear in the governing-rules list');
    });
  });
});
