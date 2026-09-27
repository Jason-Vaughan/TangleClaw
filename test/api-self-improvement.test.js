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
    pid = store.projects.create({ name: 'proj', path: projPath, engine: 'claude' }).id;
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
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
        { status: 'active', expectedContent: rule.content });
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
        { status: 'active', password: 'hunter2', expectedContent: rule.content });
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

    // #1053: the operator approves text a surface showed them. The rule's
    // content is editable by other callers in the meantime (PUT /:id is not
    // gated), so approval names the text and the server refuses a stale one.
    describe('approval names the text it approves (#1053)', () => {
      it('approves when the named text is current', async () => {
        const rule = proposal();
        const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
          { status: 'active', expectedContent: rule.content });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'active');
      });

      it('REFUSES a text swapped through PUT /:id between display and approval', async () => {
        const rule = proposal();
        const shown = rule.content;
        const swap = await request('PUT', `/api/session-rules/${rule.id}`, { content: 'swapped by another caller' });
        assert.equal(swap.status, 200, 'the swap itself is ungated — which is why approval must check');
        const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
          { status: 'active', expectedContent: shown });
        assert.equal(res.status, 409);
        assert.equal(res.data.code, 'RULE_CONTENT_CHANGED');
        assert.equal(res.data.currentContent, 'swapped by another caller',
          'the refusal carries the current text so the surface can show it');
        assert.equal(store.sessionRules.get(rule.id).status, 'proposed', 'nothing may be approved');
      });

      it('checks the password BEFORE the text, so a refused caller learns nothing about it', async () => {
        const rule = proposal();
        await request('PUT', `/api/session-rules/${rule.id}`, { content: 'swapped' });
        setOperatorPassword('hunter2');
        const stale = await request('PUT', `/api/session-rules/${rule.id}/status`,
          { status: 'active', expectedContent: 'not what it says' });
        assert.equal(stale.status, 403, 'a stale token without the password must answer 403, not 409');
        assert.equal(stale.data.currentContent, undefined, 'a 403 must not disclose the current text');
        const malformed = await request('PUT', `/api/session-rules/${rule.id}/status`,
          { status: 'active', expectedContent: 42 });
        assert.equal(malformed.status, 403, 'token validation must also wait for the password gate');
      });

      it('answers 409 to the operator once the password is supplied', async () => {
        const rule = proposal();
        await request('PUT', `/api/session-rules/${rule.id}`, { content: 'swapped' });
        setOperatorPassword('hunter2');
        const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
          { status: 'active', password: 'hunter2', expectedContent: 'not what it says' });
        assert.equal(res.status, 409);
        assert.equal(res.data.currentContent, 'swapped');
      });

      it('REFUSES an approval that names no text with 400 EXPECTED_CONTENT_REQUIRED', async () => {
        const rule = proposal();
        const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'active' });
        assert.equal(res.status, 400);
        assert.equal(res.data.code, 'EXPECTED_CONTENT_REQUIRED');
        assert.equal(store.sessionRules.get(rule.id).status, 'proposed', 'an unnamed approval must not activate');
      });

      it('checks the password before asking for the missing text', async () => {
        const rule = proposal();
        setOperatorPassword('hunter2');
        const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'active' });
        assert.equal(res.status, 403);
      });

      it('refuses a non-string expectedContent with 400', async () => {
        const rule = proposal();
        const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
          { status: 'active', expectedContent: 42 });
        assert.equal(res.status, 400);
        assert.equal(store.sessionRules.get(rule.id).status, 'proposed');
      });

      it('does not compare a rejection', async () => {
        const rule = proposal();
        const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
          { status: 'rejected', expectedContent: 'stale text' });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'rejected');
      });
    });
  });

  // #1696 / #1709 over HTTP: the lifecycle's one door is the status route.
  describe('the rule lifecycle over HTTP (#1696, #1709)', () => {
    /**
     * @param {string} content - Rule text
     * @returns {object} An operator-created, active startup rule
     */
    const live = (content) => store.sessionRules.create({ content, projectId: pid });
    const statusOf = (id) => store.sessionRules.get(id).status;
    /**
     * @returns {object} An AI-authored proposal
     */
    const proposal = () => store.sessionRules.create({
      content: `lifecycle proposal ${Date.now()}-${Math.random()}`, projectId: pid, createdBy: 'ai'
    });

    it('POST honours replacesRuleId, and approving the replacement retires the original', async () => {
      const old = live(`original ${Date.now()}`);
      const created = await request('POST', '/api/session-rules',
        { content: `amended ${Date.now()}`, projectId: pid, createdBy: 'ai', replacesRuleId: old.id });
      assert.equal(created.status, 201);
      assert.equal(created.data.replacesRuleId, old.id, 'the link is recorded, not dropped');
      const res = await request('PUT', `/api/session-rules/${created.data.id}/status`,
        { status: 'active', expectedContent: created.data.content });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.replaced, { id: old.id });
      assert.equal(statusOf(old.id), 'retired');
    });

    it('POST refuses a replacesRuleId it cannot honour, and creates nothing', async () => {
      const before = store.sessionRules.list({ projectId: pid }).length;
      const res = await request('POST', '/api/session-rules',
        { content: 'replaces nothing', projectId: pid, createdBy: 'ai', replacesRuleId: 99999999 });
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_REPLACES');
      assert.equal(store.sessionRules.list({ projectId: pid }).length, before);
    });

    it('an approval whose target is already gone stands, with replaced: null and the reason', async () => {
      const old = live(`gone ${Date.now()}`);
      const next = store.sessionRules.create({ content: `outlives ${Date.now()}`, projectId: pid, createdBy: 'ai', replacesRuleId: old.id });
      store.sessionRules.setStatus(old.id, 'retired');
      const res = await request('PUT', `/api/session-rules/${next.id}/status`,
        { status: 'active', expectedContent: next.content });
      assert.equal(res.status, 200);
      assert.equal(res.data.replaced, null);
      assert.match(res.data.replacementSkipped.reason, /already retired/);
    });

    it('PUT /:id refuses to change replacesRuleId', async () => {
      const old = live(`fixed target ${Date.now()}`);
      const next = store.sessionRules.create({ content: `x ${Date.now()}`, projectId: pid, createdBy: 'ai', replacesRuleId: old.id });
      const res = await request('PUT', `/api/session-rules/${next.id}`, { replacesRuleId: live('other').id });
      assert.equal(res.status, 400);
      assert.equal(store.sessionRules.get(next.id).replacesRuleId, old.id);
    });

    it('retires an active rule without the password — it grants nothing', async () => {
      const rule = live(`to retire ${Date.now()}`);
      setOperatorPassword('hunter2');
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'retired' });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'retired');
    });

    it('refuses to retire a proposal with 400 INVALID_TRANSITION', async () => {
      const rule = proposal();
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'retired' });
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_TRANSITION');
      assert.equal(statusOf(rule.id), 'proposed');
    });

    it('REFUSES to reject an active rule, atomically, and retire still works', async () => {
      const rule = live(`governing ${Date.now()}`);
      const versions = store.sessionRules.listVersions(rule.id).length;
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'rejected' });
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_TRANSITION');
      const after = store.sessionRules.get(rule.id);
      assert.equal(after.status, 'active');
      assert.equal(after.content, rule.content);
      assert.equal(store.sessionRules.listVersions(rule.id).length, versions);
      const retire = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'retired' });
      assert.equal(retire.status, 200);
    });

    it('restores a retired rule without the password, and it comes back disabled', async () => {
      const rule = live(`to restore ${Date.now()}`);
      store.sessionRules.setStatus(rule.id, 'retired');
      setOperatorPassword('hunter2');
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'active' });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'active');
      assert.equal(res.data.enabled, false, 'a restore never makes a rule govern on its own');
    });

    it('still demands the password to approve a proposal — the un-gated door is restore-only', async () => {
      const rule = proposal();
      setOperatorPassword('hunter2');
      const res = await request('PUT', `/api/session-rules/${rule.id}/status`,
        { status: 'active', expectedContent: rule.content });
      assert.equal(res.status, 403);
      assert.equal(statusOf(rule.id), 'proposed');
    });

    it('refuses to retire a Master rule with 400 INVALID_TRANSITION', async () => {
      const master = store.sessionRules.create({ content: `hard rule ${Date.now()}`, kind: 'master' });
      try {
        const res = await request('PUT', `/api/session-rules/${master.id}/status`, { status: 'retired' });
        assert.equal(res.status, 400);
        assert.equal(res.data.code, 'INVALID_TRANSITION');
        assert.equal(statusOf(master.id), 'active');
      } finally {
        store.sessionRules.delete(master.id);
      }
    });

    it('refuses active → proposed, so an active rule cannot be rejected in two steps', async () => {
      const rule = live(`two-step ${Date.now()}`);
      const demote = await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'proposed' });
      assert.equal(demote.status, 400);
      assert.equal(demote.data.code, 'INVALID_TRANSITION');
      assert.equal(statusOf(rule.id), 'active');
    });

    it('PUT of an active rule’s text answers 202 with the replacement proposal, and the rule is unchanged', async () => {
      const rule = live(`active text ${Date.now()}`);
      const res = await request('PUT', `/api/session-rules/${rule.id}`, { content: 'proposed wording', changedBy: 'ai' });
      assert.equal(res.status, 202, 'accepted for approval, not applied');
      assert.equal(res.data.content, rule.content);
      assert.equal(res.data.replacementProposed.replacementOrigin, 'edit');
      assert.equal(res.data.replacementProposed.status, 'proposed');
    });

    it('answers 409 REPLACEMENT_PENDING to a second edit, naming the pending one', async () => {
      const rule = live(`busy ${Date.now()}`);
      const first = await request('PUT', `/api/session-rules/${rule.id}`, { content: 'first' });
      const second = await request('PUT', `/api/session-rules/${rule.id}`, { content: 'second' });
      assert.equal(second.status, 409);
      assert.equal(second.data.code, 'REPLACEMENT_PENDING');
      assert.equal(second.data.pendingReplacementId, first.data.replacementProposed.id);
    });

    it('answers 409 REPLACEMENT_TARGET_INACTIVE to approving an edit whose rule was retired', async () => {
      const rule = live(`doomed ${Date.now()}`);
      const edit = (await request('PUT', `/api/session-rules/${rule.id}`, { content: 'late edit' })).data.replacementProposed;
      await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'retired' });
      const res = await request('PUT', `/api/session-rules/${edit.id}/status`, { status: 'active', expectedContent: 'late edit' });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'REPLACEMENT_TARGET_INACTIVE');
      assert.equal(res.data.targetId, rule.id);
      assert.equal(statusOf(edit.id), 'proposed');
    });

    it('POST /:id/restore of an active rule to other text answers 202 with a restore-origin proposal', async () => {
      const draft = store.sessionRules.create({ content: 'rv1', projectId: pid, createdBy: 'ai' });
      store.sessionRules.update(draft.id, { content: 'rv2' });
      store.sessionRules.setStatus(draft.id, 'active', { expectedContent: 'rv2' });
      const res = await request('POST', `/api/session-rules/${draft.id}/restore`, { versionNo: 1 });
      assert.equal(res.status, 202);
      assert.equal(res.data.content, 'rv2');
      assert.equal(res.data.replacementProposed.replacementOrigin, 'restore');
    });

    it('does not let a caller choose the replacement origin', async () => {
      const old = live(`origin fixed ${Date.now()}`);
      const res = await request('POST', '/api/session-rules',
        { content: `claims to be an edit ${Date.now()}`, projectId: pid, createdBy: 'ai', replacesRuleId: old.id, replacementOrigin: 'edit' });
      assert.equal(res.status, 201);
      assert.equal(res.data.replacementOrigin, 'amendment', 'only the store marks edits');
    });

    it('answers 409 RULE_RETIRED to a text change on a retired rule', async () => {
      const rule = live(`retired text ${Date.now()}`);
      await request('PUT', `/api/session-rules/${rule.id}/status`, { status: 'retired' });
      const res = await request('PUT', `/api/session-rules/${rule.id}`, { content: 'sneaked in' });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'RULE_RETIRED');
      assert.equal(store.sessionRules.get(rule.id).content, rule.content);
    });

    it('answers 409 REPLACEMENT_SUPERSEDED to a second replacement of one rule', async () => {
      const original = live(`contested ${Date.now()}`);
      const a = store.sessionRules.create({ content: `A ${Date.now()}`, projectId: pid, createdBy: 'ai', replacesRuleId: original.id });
      store.sessionRules.setStatus(a.id, 'rejected');
      const b = store.sessionRules.create({ content: `B ${Date.now()}`, projectId: pid, createdBy: 'ai', replacesRuleId: original.id });
      store.sessionRules.setStatus(b.id, 'active', { expectedContent: b.content });
      const res = await request('PUT', `/api/session-rules/${a.id}/status`, { status: 'active', expectedContent: a.content });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'REPLACEMENT_SUPERSEDED');
      assert.equal(res.data.targetId, original.id);
      assert.equal(res.data.supersededBy, b.id);
      assert.equal(statusOf(a.id), 'rejected');
    });

    it('answers 403, not 404, for an unknown rule without the password — as before', async () => {
      setOperatorPassword('hunter2');
      const res = await request('PUT', '/api/session-rules/99999999/status', { status: 'active' });
      assert.equal(res.status, 403);
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
