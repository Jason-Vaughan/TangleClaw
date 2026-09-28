'use strict';

/*
 * Caller gate and truthful attribution for session-rule mutations (#2013).
 *
 * A startup rule governs every future session of its project, so who may
 * create, change, disable, delete, demote, restore or approve one is the whole
 * security property of the proposal model. These tests drive the real server
 * as each caller class the routes tell apart — the operator's dashboard, a
 * launch-bound session of the rule's own project, one bound to another
 * project, an unbound local caller, and a caller presenting a launch id nobody
 * owns — and assert both the answer and that a refused request changed
 * nothing in the store.
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
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

setLevel('error');

describe('api/session-rules caller gate (#2013)', () => {
  let server;
  let tmpDir;
  let own;
  let other;
  let asOwn;
  let asOther;
  let asOperator;
  const UNBOUND = {};
  const INVALID = { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'no-such-launch' };

  /**
   * Send one request to the test server.
   * @param {string} method - HTTP method
   * @param {string} urlPath - Path and query
   * @param {object} [body] - JSON body
   * @param {Record<string, string>} [headers] - Caller headers
   * @returns {Promise<{status: number, data: any}>}
   */
  function request(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : null;
      const options = {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json', ...headers }
      };
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
   * An operator-approved, governing rule on a project, made the way the
   * dashboard makes one.
   * @param {number} projectId - Owning project
   * @param {string} content - Rule text
   * @returns {object} The stored rule
   */
  function activeRule(projectId, content) {
    return store.sessionRules.create({ content, projectId, createdBy: 'operator' });
  }

  /**
   * An AI proposal on a project, as a bound session or the wrap leaves one.
   * @param {number} projectId - Owning project
   * @param {string} content - Rule text
   * @returns {object} The stored rule
   */
  function proposedRule(projectId, content) {
    return store.sessionRules.create({ content, projectId, createdBy: 'ai' });
  }

  /**
   * Every rule on a project, for asserting a refusal changed nothing.
   * @param {number} projectId - Project to read
   * @returns {object[]}
   */
  function rulesOf(projectId) {
    return store.sessionRules.list({ projectId });
  }

  /**
   * The newest version-history entry of a rule.
   * @param {number} id - Rule id
   * @returns {object}
   */
  function newestVersion(id) {
    return store.sessionRules.listVersions(id)[0];
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-session-rules-authz-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    for (const name of ['own-proj', 'other-proj']) fs.mkdirSync(path.join(tmpDir, name), { recursive: true });
    own = store.projects.create({ name: 'own-proj', path: path.join(tmpDir, 'own-proj'), engine: 'claude' });
    other = store.projects.create({ name: 'other-proj', path: path.join(tmpDir, 'other-proj'), engine: 'claude' });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    asOperator = operatorHeaders(server);
    asOwn = bindProject(own).headers;
    asOther = bindProject(other).headers;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/session-rules', () => {
    it('an unbound caller that omits createdBy creates nothing — no active rule appears', async () => {
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules', { content: 'unbound, no author', projectId: own.id }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'PROJECT_BINDING_REQUIRED');
      assert.equal(rulesOf(own.id).length, before);
    });

    it('an unbound caller claiming createdBy operator is refused the same way', async () => {
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules',
        { content: 'unbound, claims operator', projectId: own.id, createdBy: 'operator' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'PROJECT_BINDING_REQUIRED');
      assert.equal(rulesOf(own.id).length, before);
    });

    it('a caller presenting a launch id nobody owns is refused as an invalid binding', async () => {
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules', { content: 'forged binding', projectId: own.id }, INVALID);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'PROJECT_BINDING_INVALID');
      assert.equal(rulesOf(own.id).length, before);
    });

    it('a bound session claiming createdBy operator gets a PROPOSAL attributed to ai', async () => {
      const res = await request('POST', '/api/session-rules',
        { content: 'bound, claims operator', projectId: own.id, createdBy: 'operator' }, asOwn);
      assert.equal(res.status, 201);
      assert.equal(res.data.status, 'proposed');
      assert.equal(res.data.createdBy, 'ai');
      assert.equal(store.sessionRules.get(res.data.id).status, 'proposed');
    });

    it('a bound session that omits createdBy also gets a proposal, never an active rule', async () => {
      const res = await request('POST', '/api/session-rules', { content: 'bound, no author', projectId: own.id }, asOwn);
      assert.equal(res.status, 201);
      assert.equal(res.data.status, 'proposed');
      assert.equal(res.data.createdBy, 'ai');
    });

    it('a bound session cannot propose into another project', async () => {
      const before = rulesOf(other.id).length;
      const res = await request('POST', '/api/session-rules', { content: 'cross-project', projectId: other.id }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OTHER_PROJECT');
      assert.equal(rulesOf(other.id).length, before);
    });

    it('a bound session cannot create a Project Master rule', async () => {
      const before = store.sessionRules.list({ kind: 'master' }).length;
      const res = await request('POST', '/api/session-rules', { content: 'master from a pane', kind: 'master' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.list({ kind: 'master' }).length, before);
    });

    it('the operator still creates an active rule, attributed to the operator', async () => {
      const res = await request('POST', '/api/session-rules', { content: 'operator rule', projectId: own.id }, asOperator);
      assert.equal(res.status, 201);
      assert.equal(res.data.status, 'active');
      assert.equal(res.data.createdBy, 'operator');
    });
  });

  describe('PUT /api/session-rules/:id (content / enabled)', () => {
    let governing;
    beforeEach(() => { governing = activeRule(own.id, `governing ${Date.now()}-${Math.random()}`); });

    it('after approval, a bound session of the SAME project cannot rewrite the text', async () => {
      const res = await request('PUT', `/api/session-rules/${governing.id}`, { content: 'swapped text' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      const now = store.sessionRules.get(governing.id);
      assert.equal(now.content, governing.content);
      assert.equal(now.status, 'active');
    });

    it('after approval, a bound session cannot disable the rule', async () => {
      const res = await request('PUT', `/api/session-rules/${governing.id}`, { enabled: false }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(governing.id).enabled, true);
    });

    it('an unbound caller cannot rewrite an active rule', async () => {
      const res = await request('PUT', `/api/session-rules/${governing.id}`, { content: 'swapped', changedBy: 'operator' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'PROJECT_BINDING_REQUIRED');
      assert.equal(store.sessionRules.get(governing.id).content, governing.content);
    });

    it('the operator can still edit it, and the history records the operator', async () => {
      const res = await request('PUT', `/api/session-rules/${governing.id}`, { content: 'operator edit' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(governing.id).content, 'operator edit');
      assert.equal(newestVersion(governing.id).changedBy, 'operator');
    });

    it('a bound session may revise its own project\'s AI proposal; history says ai even when the body claims operator', async () => {
      const proposal = proposedRule(own.id, 'draft proposal');
      const res = await request('PUT', `/api/session-rules/${proposal.id}`,
        { content: 'revised proposal', changedBy: 'operator' }, asOwn);
      assert.equal(res.status, 200);
      const now = store.sessionRules.get(proposal.id);
      assert.equal(now.content, 'revised proposal');
      assert.equal(now.status, 'proposed');
      assert.equal(newestVersion(proposal.id).changedBy, 'ai');
    });

    it('a bound session may not toggle enabled even on its own proposal', async () => {
      const proposal = proposedRule(own.id, 'toggle me');
      const res = await request('PUT', `/api/session-rules/${proposal.id}`, { enabled: false }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(proposal.id).enabled, true);
    });

    it('a bound session cannot revise a proposal the OPERATOR authored — only its own AI proposals', async () => {
      const operatorDraft = store.sessionRules.create({ content: 'operator draft', projectId: own.id, createdBy: 'operator', status: 'proposed' });
      const res = await request('PUT', `/api/session-rules/${operatorDraft.id}`, { content: 'rewritten by a pane' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(operatorDraft.id).content, 'operator draft');
    });

    it('a bound session cannot revise another project\'s proposal', async () => {
      const proposal = proposedRule(other.id, 'their proposal');
      const res = await request('PUT', `/api/session-rules/${proposal.id}`, { content: 'hijacked' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OTHER_PROJECT');
      assert.equal(store.sessionRules.get(proposal.id).content, 'their proposal');
    });

    it('a missing rule is 404 for a bound caller, and the binding is still checked first', async () => {
      assert.equal((await request('PUT', '/api/session-rules/999999', { content: 'x' }, asOwn)).status, 404);
      const unbound = await request('PUT', '/api/session-rules/999999', { content: 'x' }, UNBOUND);
      assert.equal(unbound.status, 403);
      assert.equal(unbound.data.code, 'PROJECT_BINDING_REQUIRED');
    });
  });

  describe('DELETE /api/session-rules/:id', () => {
    it('after approval, a bound session cannot delete the rule', async () => {
      const governing = activeRule(own.id, 'do not delete me');
      const res = await request('DELETE', `/api/session-rules/${governing.id}`, null, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.ok(store.sessionRules.get(governing.id));
    });

    it('an unbound caller cannot delete anything', async () => {
      const governing = activeRule(own.id, 'unbound delete target');
      const res = await request('DELETE', `/api/session-rules/${governing.id}`, null, UNBOUND);
      assert.equal(res.status, 403);
      assert.ok(store.sessionRules.get(governing.id));
    });

    it('a bound session may withdraw its own project\'s AI proposal', async () => {
      const proposal = proposedRule(own.id, 'withdraw me');
      const res = await request('DELETE', `/api/session-rules/${proposal.id}`, null, asOwn);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(proposal.id), null);
      assert.equal(newestVersion(proposal.id).op, 'delete');
      assert.equal(newestVersion(proposal.id).changedBy, 'ai', 'the withdrawal is recorded as the session\'s, not the operator\'s');
    });

    it('a bound session cannot withdraw another project\'s proposal', async () => {
      const proposal = proposedRule(other.id, 'not yours');
      const res = await request('DELETE', `/api/session-rules/${proposal.id}`, null, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OTHER_PROJECT');
      assert.ok(store.sessionRules.get(proposal.id));
    });

    it('the operator can still delete an active rule', async () => {
      const governing = activeRule(own.id, 'operator deletes');
      const res = await request('DELETE', `/api/session-rules/${governing.id}`, null, asOperator);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(governing.id), null);
    });
  });

  describe('PUT /api/session-rules/:id/status', () => {
    it('after approval, a bound session cannot demote the rule to rejected', async () => {
      const governing = activeRule(own.id, 'do not reject me');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'rejected' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(governing.id).status, 'active');
    });

    it('after approval, a bound session cannot demote the rule back to proposed', async () => {
      const governing = activeRule(own.id, 'do not un-approve me');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'proposed' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(governing.id).status, 'active');
    });

    it('an unbound caller cannot demote an active rule', async () => {
      const governing = activeRule(own.id, 'unbound demote target');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`,
        { status: 'rejected', changedBy: 'operator' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(governing.id).status, 'active');
    });

    it('a bound session cannot approve its own proposal, even with no delete password configured', async () => {
      const proposal = proposedRule(own.id, 'self-approve attempt');
      const res = await request('PUT', `/api/session-rules/${proposal.id}/status`,
        { status: 'active', expectedContent: 'self-approve attempt' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(proposal.id).status, 'proposed');
    });

    it('the operator approves a proposal, recorded as the operator', async () => {
      const proposal = proposedRule(own.id, 'operator approves this');
      const res = await request('PUT', `/api/session-rules/${proposal.id}/status`,
        { status: 'active', expectedContent: 'operator approves this' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(proposal.id).status, 'active');
      assert.equal(newestVersion(proposal.id).changedBy, 'operator');
    });

    it('a bound session may decline its own project\'s proposal; history says ai even when the body claims operator', async () => {
      const proposal = proposedRule(own.id, 'decline me');
      const res = await request('PUT', `/api/session-rules/${proposal.id}/status`,
        { status: 'rejected', changedBy: 'operator' }, asOwn);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(proposal.id).status, 'rejected');
      assert.equal(newestVersion(proposal.id).changedBy, 'ai');
    });

    it('a bound session cannot decline another project\'s proposal', async () => {
      const proposal = proposedRule(other.id, 'their proposal to decline');
      const res = await request('PUT', `/api/session-rules/${proposal.id}/status`, { status: 'rejected' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OTHER_PROJECT');
      assert.equal(store.sessionRules.get(proposal.id).status, 'proposed');
    });

    it('the operator can still reject an active rule', async () => {
      const governing = activeRule(own.id, 'operator rejects');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'rejected' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(governing.id).status, 'rejected');
      assert.equal(newestVersion(governing.id).changedBy, 'operator');
    });
  });

  describe('an AI proposal the operator has approved', () => {
    // An approved AI proposal keeps createdBy 'ai' and becomes active. The
    // session that proposed it must lose every right over it at approval —
    // this is the case where authorship alone would still say "its own".
    let approved;
    beforeEach(async () => {
      const proposal = proposedRule(own.id, `approved ai rule ${Date.now()}-${Math.random()}`);
      const res = await request('PUT', `/api/session-rules/${proposal.id}/status`,
        { status: 'active', expectedContent: proposal.content }, asOperator);
      assert.equal(res.status, 200);
      approved = store.sessionRules.get(proposal.id);
      assert.equal(approved.createdBy, 'ai');
      assert.equal(approved.status, 'active');
    });

    it('its proposing session cannot rewrite it', async () => {
      const res = await request('PUT', `/api/session-rules/${approved.id}`, { content: 'swapped after approval' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(approved.id).content, approved.content);
    });

    it('its proposing session cannot delete it', async () => {
      const res = await request('DELETE', `/api/session-rules/${approved.id}`, null, asOwn);
      assert.equal(res.status, 403);
      assert.ok(store.sessionRules.get(approved.id));
    });

    it('its proposing session cannot demote it', async () => {
      const res = await request('PUT', `/api/session-rules/${approved.id}/status`, { status: 'rejected' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(approved.id).status, 'active');
    });
  });

  describe('POST /api/session-rules/:id/restore', () => {
    it('after approval, a bound session cannot restore an older text', async () => {
      const governing = activeRule(own.id, 'original text');
      store.sessionRules.update(governing.id, { content: 'approved text', changedBy: 'operator' });
      const firstVersion = store.sessionRules.listVersions(governing.id).at(-1).versionNo;
      const res = await request('POST', `/api/session-rules/${governing.id}/restore`, { versionNo: firstVersion }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(governing.id).content, 'approved text');
    });

    it('an unbound caller cannot restore', async () => {
      const governing = activeRule(own.id, 'restore v1');
      store.sessionRules.update(governing.id, { content: 'restore v2', changedBy: 'operator' });
      const firstVersion = store.sessionRules.listVersions(governing.id).at(-1).versionNo;
      const res = await request('POST', `/api/session-rules/${governing.id}/restore`,
        { versionNo: firstVersion, changedBy: 'operator' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(governing.id).content, 'restore v2');
    });

    it('a bound session cannot restore even its own still-proposed rule — restore is the operator\'s', async () => {
      const proposal = proposedRule(own.id, 'proposal v1');
      const revised = await request('PUT', `/api/session-rules/${proposal.id}`, { content: 'proposal v2' }, asOwn);
      assert.equal(revised.status, 200);
      const firstVersion = store.sessionRules.listVersions(proposal.id).at(-1).versionNo;
      const res = await request('POST', `/api/session-rules/${proposal.id}/restore`, { versionNo: firstVersion }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(proposal.id).content, 'proposal v2');
    });

    it('the operator can restore, recorded as the operator even when the body says otherwise', async () => {
      const governing = activeRule(own.id, 'op restore v1');
      store.sessionRules.update(governing.id, { content: 'op restore v2', changedBy: 'operator' });
      const firstVersion = store.sessionRules.listVersions(governing.id).at(-1).versionNo;
      const res = await request('POST', `/api/session-rules/${governing.id}/restore`,
        { versionNo: firstVersion, changedBy: 'ai' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(governing.id).content, 'op restore v1');
      assert.equal(newestVersion(governing.id).changedBy, 'operator');
    });
  });
});
