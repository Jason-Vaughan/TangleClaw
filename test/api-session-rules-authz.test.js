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
const projects = require('../lib/projects');
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
    // The global-rules document is a tracked repo file by default; a test that
    // could write it (a regressed gate would) must point it somewhere else.
    store.globalRules._setBundledGlobalRulesPath(path.join(tmpDir, 'global-rules.md'));
    fs.writeFileSync(path.join(tmpDir, 'global-rules.md'), '# Global rules under test\n');
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
    store.globalRules._resetBundledGlobalRulesPath();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/session-rules', () => {
    it('an unbound caller that omits createdBy creates nothing — no active rule appears', async () => {
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules', { content: 'unbound, no author', projectId: own.id }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(rulesOf(own.id).length, before);
    });

    it('an unbound caller claiming createdBy operator is refused the same way', async () => {
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules',
        { content: 'unbound, claims operator', projectId: own.id, createdBy: 'operator' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(rulesOf(own.id).length, before);
    });

    it('a caller presenting a launch id nobody owns is refused as an invalid binding', async () => {
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules', { content: 'forged binding', projectId: own.id }, INVALID);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_INVALID');
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
      assert.doesNotMatch(res.data.error, /Rule #/, 'a create has no rule to name yet');
      assert.equal(store.sessionRules.list({ kind: 'master' }).length, before);
    });

    it('the operator still creates an active rule, attributed to the operator', async () => {
      const res = await request('POST', '/api/session-rules', { content: 'operator rule', projectId: own.id }, asOperator);
      assert.equal(res.status, 201);
      assert.equal(res.data.status, 'active');
      assert.equal(res.data.createdBy, 'operator');
    });

    it('proposing a second replacement of a rule with one already pending is refused 400 INVALID_REPLACES', async () => {
      const governing = activeRule(own.id, 'http create pending-replace target');
      const firstPending = (await request('POST', '/api/session-rules',
        { content: 'first pending', projectId: own.id, replacesRuleId: governing.id }, asOwn)).data;
      assert.equal(firstPending.status, 'proposed');
      const res = await request('POST', '/api/session-rules',
        { content: 'second pending', projectId: own.id, replacesRuleId: governing.id }, asOwn);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_REPLACES');
      assert.equal(store.sessionRules.get(governing.id).status, 'active');
    });
  });

  describe('PUT /api/session-rules/:id (content / enabled)', () => {
    let governing;
    beforeEach(() => { governing = activeRule(own.id, `governing ${Date.now()}-${Math.random()}`); });

    it('after approval, a bound session of the SAME project cannot rewrite the text', async () => {
      const res = await request('PUT', `/api/session-rules/${governing.id}`, { content: 'swapped text' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      // #2029: the refusal names the rule it refused, by DB id.
      assert.match(res.data.error, new RegExp(`\\(Rule #${governing.id}\\)\\.`));
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
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(store.sessionRules.get(governing.id).content, governing.content);
    });

    // #1696 (Architect ruling): a text change to an ACTIVE project rule goes
    // through approval regardless of who makes it — even the operator's own
    // edit files a replacement proposal rather than rewriting the rule in
    // place, so the rule keeps governing its approved text until that
    // proposal is approved. This test moved from asserting the old in-place
    // rewrite to asserting the new proposal contract (202, not a weakening).
    it('even the operator\'s edit files a replacement proposal instead of rewriting the rule', async () => {
      const res = await request('PUT', `/api/session-rules/${governing.id}`, { content: 'operator edit' }, asOperator);
      assert.equal(res.status, 202);
      assert.ok(res.data.replacementProposed);
      assert.equal(res.data.replacementProposed.content, 'operator edit');
      assert.equal(res.data.replacementProposed.replacesRuleId, governing.id);
      assert.equal(res.data.replacementProposed.replacementOrigin, 'edit');
      assert.equal(newestVersion(res.data.replacementProposed.id).changedBy, 'operator');
      // The original rule is untouched — still governing its approved text.
      assert.equal(store.sessionRules.get(governing.id).content, governing.content);
    });

    it('editing an active rule that already has a pending replacement is refused REPLACEMENT_PENDING, not filed a second time', async () => {
      const pending = store.sessionRules.create({
        content: 'already-pending replacement text', projectId: own.id, createdBy: 'ai', replacesRuleId: governing.id
      });
      const res = await request('PUT', `/api/session-rules/${governing.id}`, { content: 'second edit attempt' }, asOperator);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'REPLACEMENT_PENDING');
      assert.equal(res.data.pendingReplacementId, pending.id);
      assert.equal(store.sessionRules.get(governing.id).content, governing.content);
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
      assert.equal(unbound.data.code, 'LAUNCH_BINDING_REQUIRED');
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

    // #1709 (Architect ruling): an active rule is never rejected — that move
    // used to make a governing rule vanish from the list and the Graveyard
    // alike with no password. Retire is the only way a governing rule
    // leaves force now; this test moved from asserting the old reject-while-
    // active path to asserting it is refused, even for the operator.
    it('even the operator cannot reject an active rule — retire is the only way out of force', async () => {
      const governing = activeRule(own.id, 'operator tries to reject');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'rejected' }, asOperator);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_TRANSITION');
      assert.equal(store.sessionRules.get(governing.id).status, 'active');
    });
  });

  describe('PUT /api/session-rules/:id/status — retire and restore (#1709)', () => {
    it('an unbound caller cannot retire — refused before any password or rule lookup', async () => {
      const governing = activeRule(own.id, 'unbound retire target');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`,
        { status: 'retired', changedBy: 'operator' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(governing.id).status, 'active');
    });

    it('a bound session cannot retire its project\'s own governing rule', async () => {
      const governing = activeRule(own.id, 'bound retire target');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(governing.id).status, 'active');
    });

    it('the operator retires a governing rule, with no delete password configured', async () => {
      const governing = activeRule(own.id, 'operator retires this');
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'retired');
      assert.equal(store.sessionRules.get(governing.id).status, 'retired');
    });

    // The ordering fix from the Architect's review of the first draft: the
    // retirement password is checked BEFORE the rule is read at all, so a
    // wrong/absent password against a rule id that does not even exist
    // still answers 403 — never 404, which would mean the lookup ran first
    // and leaked the rule's non-existence to a caller the password already
    // should have stopped.
    //
    // A second Architect finding on the first attempt at this proof: using
    // UNBOUND with no delete password configured never actually exercises
    // `checkDeletePassword` — `projects.checkDeletePassword` always answers
    // `allowed: true` with no password set, so the 403 it observed came from
    // `sessionRuleCaller`'s binding refusal instead, before the password gate
    // ever ran. Reordering the route back to lookup-first would have left
    // that test green. This block configures a REAL hashed password so the
    // password check itself is what is on trial, as the OPERATOR — the one
    // caller class that reaches the password gate at all.
    describe('a real delete password gates retirement before the rule lookup, independent of sessionRuleCaller', () => {
      const REAL_PASSWORD = 'retire-this-rule-for-real';
      let savedPassword;

      before(() => {
        const config = store.config.load();
        savedPassword = config.deletePassword;
        config.deletePassword = projects.hashPassword(REAL_PASSWORD);
        store.config.save(config);
      });

      after(() => {
        const config = store.config.load();
        config.deletePassword = savedPassword;
        store.config.save(config);
      });

      it('a wrong or absent password answers IDENTICALLY for a nonexistent rule and an existing one — no existence leak', async () => {
        const governing = activeRule(own.id, 'password-gated retire target (wrong/absent password)');

        const wrongNonexistent = await request('PUT', '/api/session-rules/999999/status', { status: 'retired', password: 'wrong' }, asOperator);
        const wrongExisting = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired', password: 'wrong' }, asOperator);
        assert.equal(wrongNonexistent.status, 403);
        assert.equal(wrongExisting.status, 403);
        assert.deepEqual(wrongNonexistent.data, wrongExisting.data,
          'a wrong password must answer identically whether or not the rule exists');
        assert.equal(store.sessionRules.get(governing.id).status, 'active', 'a wrong-password attempt must not touch the rule');

        const absentNonexistent = await request('PUT', '/api/session-rules/999998/status', { status: 'retired' }, asOperator);
        const absentExisting = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired' }, asOperator);
        assert.equal(absentNonexistent.status, 403);
        assert.equal(absentExisting.status, 403);
        assert.deepEqual(absentNonexistent.data, absentExisting.data,
          'an absent password must answer identically whether or not the rule exists');
        assert.equal(store.sessionRules.get(governing.id).status, 'active', 'an absent-password attempt must not touch the rule');
      });

      it('the correct password reaches the real outcome: 404 for a nonexistent rule, retirement for an existing one', async () => {
        const governing = activeRule(own.id, 'password-gated retire target (correct password)');

        const notFound = await request('PUT', '/api/session-rules/999999/status', { status: 'retired', password: REAL_PASSWORD }, asOperator);
        assert.equal(notFound.status, 404);

        const retired = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired', password: REAL_PASSWORD }, asOperator);
        assert.equal(retired.status, 200);
        assert.equal(retired.data.status, 'retired');
        assert.equal(store.sessionRules.get(governing.id).status, 'retired');
      });

      it('sessionRuleCaller still independently refuses bound callers even once the password gate passes', async () => {
        const sameProjectTarget = activeRule(own.id, 'password-gated, bound same-project caller');
        const sameProjectRes = await request('PUT', `/api/session-rules/${sameProjectTarget.id}/status`,
          { status: 'retired', password: REAL_PASSWORD }, asOwn);
        assert.equal(sameProjectRes.status, 403);
        assert.equal(sameProjectRes.data.code, 'OPERATOR_ONLY');
        assert.equal(store.sessionRules.get(sameProjectTarget.id).status, 'active');

        const otherProjectTarget = activeRule(own.id, 'password-gated, bound other-project caller');
        const otherProjectRes = await request('PUT', `/api/session-rules/${otherProjectTarget.id}/status`,
          { status: 'retired', password: REAL_PASSWORD }, asOther);
        assert.equal(otherProjectRes.status, 403);
        assert.equal(otherProjectRes.data.code, 'OTHER_PROJECT');
        assert.equal(store.sessionRules.get(otherProjectTarget.id).status, 'active');
      });

      // #1053/#2013: approval has carried this same password gate since
      // before #1971 — caught with no HTTP-level test covering it when a
      // mutation audit for this chunk flagged the gate as never actually
      // exercised at the route.
      it('approving a proposal with a wrong or absent password is refused FORBIDDEN, and nothing is approved', async () => {
        const wrongPwProposal = proposedRule(own.id, 'approval password-gated (wrong password)');
        const wrong = await request('PUT', `/api/session-rules/${wrongPwProposal.id}/status`,
          { status: 'active', expectedContent: wrongPwProposal.content, password: 'wrong' }, asOperator);
        assert.equal(wrong.status, 403);
        assert.equal(wrong.data.code, 'FORBIDDEN');
        assert.equal(store.sessionRules.get(wrongPwProposal.id).status, 'proposed');

        const absentPwProposal = proposedRule(own.id, 'approval password-gated (absent password)');
        const absent = await request('PUT', `/api/session-rules/${absentPwProposal.id}/status`,
          { status: 'active', expectedContent: absentPwProposal.content }, asOperator);
        assert.equal(absent.status, 403);
        assert.equal(absent.data.code, 'FORBIDDEN');
        assert.equal(store.sessionRules.get(absentPwProposal.id).status, 'proposed');
      });

      it('approving a proposal with the correct password succeeds', async () => {
        const proposal = proposedRule(own.id, 'approval password-gated (correct password)');
        const res = await request('PUT', `/api/session-rules/${proposal.id}/status`,
          { status: 'active', expectedContent: proposal.content, password: REAL_PASSWORD }, asOperator);
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'active');
        assert.equal(store.sessionRules.get(proposal.id).status, 'active');
      });

      // Architect ruling A88: an operator-authored POST /api/session-rules
      // with replacesRuleId lands active by default (this route never
      // requests another status) and retires its target in the SAME
      // transaction as creation — a retirement that bypassed the password
      // gate entirely until this fix, even though PUT .../status requires it
      // for the exact same effect reached the other way.
      it('creating an operator replacement with a wrong or absent password cannot retire the target', async () => {
        const wrongPwTarget = activeRule(own.id, 'create-replace password-gated (wrong password)');
        const wrong = await request('POST', '/api/session-rules',
          { content: 'wrong-password amendment', projectId: own.id, replacesRuleId: wrongPwTarget.id, password: 'wrong' }, asOperator);
        assert.equal(wrong.status, 403);
        assert.equal(wrong.data.code, 'FORBIDDEN');
        assert.equal(store.sessionRules.get(wrongPwTarget.id).status, 'active', 'the target must not be retired');
        assert.equal(rulesOf(own.id).filter((r) => r.content === 'wrong-password amendment').length, 0, 'no replacement must have been created');

        const absentPwTarget = activeRule(own.id, 'create-replace password-gated (absent password)');
        const absent = await request('POST', '/api/session-rules',
          { content: 'absent-password amendment', projectId: own.id, replacesRuleId: absentPwTarget.id }, asOperator);
        assert.equal(absent.status, 403);
        assert.equal(absent.data.code, 'FORBIDDEN');
        assert.equal(store.sessionRules.get(absentPwTarget.id).status, 'active', 'the target must not be retired');
      });

      it('creating an operator replacement with the correct password retires the target', async () => {
        const target = activeRule(own.id, 'create-replace password-gated (correct password)');
        const res = await request('POST', '/api/session-rules',
          { content: 'correct-password amendment', projectId: own.id, replacesRuleId: target.id, password: REAL_PASSWORD }, asOperator);
        assert.equal(res.status, 201);
        assert.equal(res.data.status, 'active');
        assert.equal(store.sessionRules.get(target.id).status, 'retired');
        assert.equal(store.sessionRules.get(target.id).supersededBy, res.data.id);
      });

      it('creating an operator rule with NO replacesRuleId still needs no password — only the retirement side effect is gated', async () => {
        const res = await request('POST', '/api/session-rules',
          { content: 'plain operator rule, no replacement', projectId: own.id }, asOperator);
        assert.equal(res.status, 201);
        assert.equal(res.data.status, 'active');
      });
    });

    it('the operator restores a retired rule, with no password, and it comes back disabled', async () => {
      const governing = activeRule(own.id, 'restore target');
      await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired' }, asOperator);
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'active' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'active');
      assert.equal(res.data.enabled, false);
      assert.equal(store.sessionRules.get(governing.id).enabled, false);
    });

    it('a bound session cannot restore a retired rule', async () => {
      const governing = activeRule(own.id, 'bound restore target');
      await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired' }, asOperator);
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'active' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(governing.id).status, 'retired');
    });

    it('an unbound caller cannot restore a retired rule', async () => {
      const governing = activeRule(own.id, 'unbound restore target');
      await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'retired' }, asOperator);
      const res = await request('PUT', `/api/session-rules/${governing.id}/status`, { status: 'active' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(store.sessionRules.get(governing.id).status, 'retired');
    });

    it('a Master rule cannot be retired through this route', async () => {
      const masterRule = store.sessionRules.create({ content: 'a master hard rule', kind: 'master', createdBy: 'system' });
      const res = await request('PUT', `/api/session-rules/${masterRule.id}/status`, { status: 'retired' }, asOperator);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_TRANSITION');
    });

    it('a proposed rule cannot be retired — only an active one has anything to retire', async () => {
      const proposal = proposedRule(own.id, 'never approved, cannot retire');
      const res = await request('PUT', `/api/session-rules/${proposal.id}/status`, { status: 'retired' }, asOperator);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_TRANSITION');
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

  describe('POST /api/session-rules/promote', () => {
    it('an unbound caller cannot promote a learning into a live rule, even with no delete password set', async () => {
      const learning = store.learnings.create({ projectId: own.id, content: `promote unbound ${Date.now()}` });
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules/promote',
        { learningId: learning.id, content: 'any text I like' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(rulesOf(own.id).length, before);
    });

    it('a bound session cannot promote either — promotion mints a governing rule', async () => {
      const learning = store.learnings.create({ projectId: own.id, content: `promote bound ${Date.now()}` });
      const before = rulesOf(own.id).length;
      const res = await request('POST', '/api/session-rules/promote', { learningId: learning.id }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(rulesOf(own.id).length, before);
    });

    it('the operator still promotes, and the rule is live', async () => {
      const learning = store.learnings.create({ projectId: own.id, content: `promote operator ${Date.now()}` });
      const res = await request('POST', '/api/session-rules/promote', { learningId: learning.id }, asOperator);
      assert.equal(res.status, 201);
      assert.equal(res.data.status, 'active');
    });
  });

  describe('PUT /api/learnings/:id/tier (#2018)', () => {
    // An active learning is rendered into its project's session primes, so
    // forcing a tier is as much a governance act as approving a rule.
    it('a bound session cannot force a learning into the injected tier', async () => {
      const learning = store.learnings.create({ projectId: own.id, content: `tier bound ${Math.random()}` });
      const res = await request('PUT', `/api/learnings/${learning.id}/tier`, { tier: 'active' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.learnings.list(own.id).find((l) => l.id === learning.id).tier, 'provisional');
    });

    it('an unbound caller cannot either', async () => {
      const learning = store.learnings.create({ projectId: own.id, content: `tier unbound ${Math.random()}` });
      const res = await request('PUT', `/api/learnings/${learning.id}/tier`, { tier: 'active' }, UNBOUND);
      assert.equal(res.status, 403);
      assert.equal(store.learnings.list(own.id).find((l) => l.id === learning.id).tier, 'provisional');
    });

    it('the operator still sets it', async () => {
      const learning = store.learnings.create({ projectId: own.id, content: `tier operator ${Math.random()}` });
      const res = await request('PUT', `/api/learnings/${learning.id}/tier`, { tier: 'active' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(store.learnings.list(own.id).find((l) => l.id === learning.id).tier, 'active');
    });
  });

  describe('the global rules document', () => {
    it('a bound session cannot change it — a Builder proposes text, the operator applies it', async () => {
      const before = store.globalRules.load();
      const res = await request('PUT', '/api/rules/global', { content: '# replaced by a pane' }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.globalRules.load(), before);
    });

    it('an unbound caller cannot change it', async () => {
      const before = store.globalRules.load();
      const res = await request('PUT', '/api/rules/global', { content: '# replaced unbound' }, UNBOUND);
      assert.equal(res.status, 403);
      // An operator-only route names what is missing — the operator — to every
      // other caller, bound or not (the #1752 contract).
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(store.globalRules.load(), before);
    });

    it('reset is the operator\'s too, for a bound and an unbound caller', async () => {
      for (const [caller, code] of [[asOwn, 'OPERATOR_ONLY'], [UNBOUND, 'LAUNCH_BINDING_REQUIRED']]) {
        const res = await request('POST', '/api/rules/global/reset', null, caller);
        assert.equal(res.status, 403);
        assert.equal(res.data.code, code);
      }
    });

    it('the operator still changes and resets it', async () => {
      const put = await request('PUT', '/api/rules/global', { content: '# operator edit\n' }, asOperator);
      assert.equal(put.status, 200);
      assert.equal(store.globalRules.load(), '# operator edit\n');
      const reset = await request('POST', '/api/rules/global/reset', null, asOperator);
      assert.equal(reset.status, 200);
    });
  });

  describe('every rule- or learning-mutating route refuses an unbound caller', () => {
    // The roster is read from the route registrations in server.js — the one
    // place a route's verb and path are both written — so a mutation route
    // added later is swept in without anyone remembering to list it here.
    const NOT_A_MUTATION = {
      'POST /api/session-rules/conflicts': 'a read-only candidate signal; it writes nothing'
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const registered = [...source.matchAll(/route\('(POST|PUT|PATCH|DELETE)', '(\/api\/(?:session-rules|master\/rules|learnings|rules\/global)[^']*)'/g)]
      .map(([, method, urlPath]) => `${method} ${urlPath}`);

    it('the roster is non-trivial and its exemptions still exist', () => {
      assert.ok(registered.length >= 7, `expected the rule mutation routes, found ${registered.join(', ')}`);
      for (const key of Object.keys(NOT_A_MUTATION)) assert.ok(registered.includes(key), `${key} is exempt but no longer registered`);
    });

    for (const key of registered) {
      if (NOT_A_MUTATION[key]) continue;
      it(`${key} answers 403 and changes nothing`, async () => {
        const [method, pattern] = key.split(' ');
        const target = activeRule(own.id, `sweep target ${key} ${Math.random()}`);
        const learning = store.learnings.create({ projectId: own.id, content: `sweep learning ${Math.random()}` });
        const urlPath = pattern.replace(':id', String(pattern.startsWith('/api/learnings') ? learning.id : target.id));
        const snapshot = JSON.stringify([store.sessionRules.list({}), store.learnings.list(own.id), store.globalRules.load()]);
        const res = await request(method, urlPath,
          { content: 'swept', projectId: own.id, status: 'rejected', enabled: false, versionNo: 1, learningId: learning.id, tier: 'active' },
          UNBOUND);
        assert.equal(res.status, 403, `${key} answered ${res.status}`);
        assert.equal(JSON.stringify([store.sessionRules.list({}), store.learnings.list(own.id), store.globalRules.load()]), snapshot,
          `${key} changed a rule, a learning or the global rules while refusing`);
      });
    }
  });

  describe('POST /api/session-rules/:id/restore', () => {
    /**
     * A governing (active) rule carrying TWO real versions in its history —
     * built up while it was still `proposed` (#1696: a content change to an
     * already-ACTIVE rule now files a replacement proposal instead of
     * versioning in place, so this fixture accumulates its version history
     * before approval, exactly as an AI proposal revised once before the
     * operator approves it would).
     * @param {number} projectId - Owning project
     * @param {string} v1 - First version's text
     * @param {string} v2 - Second version's text, the one approved into force
     * @returns {object} The active rule, now governing `v2`
     */
    function activeRuleWithHistory(projectId, v1, v2) {
      const proposal = store.sessionRules.create({ content: v1, projectId, createdBy: 'ai' });
      store.sessionRules.update(proposal.id, { content: v2, changedBy: 'ai' });
      return store.sessionRules.setStatus(proposal.id, 'active', { changedBy: 'operator', expectedContent: v2 });
    }

    it('after approval, a bound session cannot restore an older text', async () => {
      const governing = activeRuleWithHistory(own.id, 'original text', 'approved text');
      const firstVersion = store.sessionRules.listVersions(governing.id).at(-1).versionNo;
      const res = await request('POST', `/api/session-rules/${governing.id}/restore`, { versionNo: firstVersion }, asOwn);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sessionRules.get(governing.id).content, 'approved text');
    });

    it('an unbound caller cannot restore', async () => {
      const governing = activeRuleWithHistory(own.id, 'restore v1', 'restore v2');
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
      // #1696: a still-PROPOSED rule's restore applies in place (200) — the
      // same roll back on an already-ACTIVE rule instead files a replacement
      // proposal (202), covered separately below.
      const proposal = proposedRule(own.id, 'op restore v1');
      await request('PUT', `/api/session-rules/${proposal.id}`, { content: 'op restore v2' }, asOwn);
      const firstVersion = store.sessionRules.listVersions(proposal.id).at(-1).versionNo;
      const res = await request('POST', `/api/session-rules/${proposal.id}/restore`,
        { versionNo: firstVersion, changedBy: 'ai' }, asOperator);
      assert.equal(res.status, 200);
      assert.equal(store.sessionRules.get(proposal.id).content, 'op restore v1');
      assert.equal(newestVersion(proposal.id).changedBy, 'operator');
    });

    it('rolling an ACTIVE rule back to different text files a replacement proposal instead of rewriting it, origin "restore"', async () => {
      const governing = activeRuleWithHistory(own.id, 'http restore origin v1', 'http restore origin v2');
      const firstVersion = store.sessionRules.listVersions(governing.id).at(-1).versionNo;
      const res = await request('POST', `/api/session-rules/${governing.id}/restore`, { versionNo: firstVersion }, asOperator);
      assert.equal(res.status, 202);
      assert.ok(res.data.replacementProposed);
      assert.equal(res.data.replacementProposed.content, 'http restore origin v1');
      assert.equal(res.data.replacementProposed.replacesRuleId, governing.id);
      assert.equal(res.data.replacementProposed.replacementOrigin, 'restore');
      assert.equal(newestVersion(res.data.replacementProposed.id).changedBy, 'operator');
      // The original rule is untouched — still governing its approved text.
      assert.equal(store.sessionRules.get(governing.id).content, 'http restore origin v2');
    });

    it('restoring an active rule to different text while a replacement is already pending is refused REPLACEMENT_PENDING', async () => {
      const governing = activeRuleWithHistory(own.id, 'pending-restore v1', 'pending-restore v2');
      const firstVersion = store.sessionRules.listVersions(governing.id).at(-1).versionNo;
      const pending = store.sessionRules.create({
        content: 'pending-restore v3', projectId: own.id, createdBy: 'ai', replacesRuleId: governing.id
      });
      const res = await request('POST', `/api/session-rules/${governing.id}/restore`, { versionNo: firstVersion }, asOperator);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'REPLACEMENT_PENDING');
      assert.equal(res.data.pendingReplacementId, pending.id);
      assert.equal(store.sessionRules.get(governing.id).content, 'pending-restore v2');
    });
  });
});
