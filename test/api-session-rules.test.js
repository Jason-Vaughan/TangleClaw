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
const { execFileSync } = require('node:child_process');
const store = require('../lib/store');
const { createServer } = require('../server');
const { setLevel, setConsoleStream } = require('../lib/logger');
const channel = require('../lib/session-rules-channel');
const rulesRefresh = require('../lib/session-rules-refresh');
const { operatorHeaders, bindProject, sendAs } = require('./_shared-docs-callers');

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
        // These cases model the dashboard, so they are the operator's requests
        // (#2013 refuses an unnamed caller); caller classes are covered in
        // test/api-session-rules-authz.test.js.
        headers: { 'Content-Type': 'application/json', ...operatorHeaders(server) }
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

  describe('#1121 — unknown projectId is a 400, not a bare 500 or a silent empty list', () => {
    it('POST with the project NAME returns 400 INVALID_PROJECT_ID naming the fix', async () => {
      const res = await request('POST', '/api/session-rules',
        { content: 'rule', projectId: 'rules-proj' });
      assert.equal(res.status, 400, 'used to surface the FK failure as a 500');
      assert.equal(res.data.code, 'INVALID_PROJECT_ID');
      assert.match(res.data.error, /numeric id/, 'the error must say which identifier this API wants');
    });

    it('POST with a nonexistent numeric id returns 400 INVALID_PROJECT_ID', async () => {
      const res = await request('POST', '/api/session-rules', { content: 'rule', projectId: 999999 });
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_PROJECT_ID');
    });

    it('GET with an unknown projectId returns 400 instead of a silent empty list', async () => {
      const res = await request('GET', '/api/session-rules?projectId=rules-proj');
      assert.equal(res.status, 400, 'an empty list here is indistinguishable from a project with no rules');
      assert.equal(res.data.code, 'INVALID_PROJECT_ID');
    });

    it('GET with a valid projectId and no rules still returns 200 [] — valid-but-empty stays distinguishable', async () => {
      const res = await request('GET', `/api/session-rules?projectId=${projectId}&kind=wrap`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.rules, []);
    });

    it('conflicts: a present-but-unknown projectId is 400; an absent one stays a legitimate unscoped query', async () => {
      const bad = await request('POST', '/api/session-rules/conflicts',
        { content: 'anything', projectId: 'rules-proj' });
      assert.equal(bad.status, 400);
      assert.equal(bad.data.code, 'INVALID_PROJECT_ID');

      const unscoped = await request('POST', '/api/session-rules/conflicts', { content: 'anything' });
      assert.equal(unscoped.status, 200);
    });

    it('GET /api/learnings with an unknown projectId is 400, valid is 200', async () => {
      const bad = await request('GET', '/api/learnings?projectId=rules-proj');
      assert.equal(bad.status, 400);
      assert.equal(bad.data.code, 'INVALID_PROJECT_ID');

      const ok = await request('GET', `/api/learnings?projectId=${projectId}`);
      assert.equal(ok.status, 200);
      assert.ok(Array.isArray(ok.data.learnings));
    });
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

    it('answers NOT_FOUND, not CONFIRM_REQUIRED, for a versionNo that does not exist (#1048)', async () => {
      // The baseline-confirm gate fired before the version-existence check, so
      // the caller was told to confirm an operation that could never succeed —
      // fail-closed, but the misleading answer shadowed the accurate one.
      const system = store.sessionRules.create({
        content: 'missing-version boundary',
        kind: 'master',
        createdBy: 'system'
      });

      const missing = await request(
        'POST', `/api/session-rules/${system.id}/restore`, { versionNo: 999999 }
      );
      assert.equal(missing.status, 404);
      assert.equal(missing.data.code, 'NOT_FOUND');

      await request('DELETE', `/api/session-rules/${system.id}?confirm=true`);
    });

    it('still refuses a real weakening version without confirmation (#1048 did not open the gate)', async () => {
      // The half a NOT_FOUND fix could break by widening the fall-through: the
      // gate must still fire for a version that EXISTS and weakens. Without
      // this, dropping the whole `weakens` branch would pass the test above.
      const system = store.sessionRules.create({
        content: 'boundary original',
        kind: 'master',
        createdBy: 'system'
      });
      await request('PUT', `/api/session-rules/${system.id}`, {
        content: 'boundary edited', confirmBaselineEdit: true
      });

      const versions = store.sessionRules.listVersions(system.id);
      const original = versions.find((v) => v.content === 'boundary original');
      assert.ok(original, 'the pre-edit snapshot must be in the version history');

      const refused = await request(
        'POST', `/api/session-rules/${system.id}/restore`, { versionNo: original.versionNo }
      );
      assert.equal(refused.status, 400);
      assert.equal(refused.data.code, 'CONFIRM_REQUIRED');

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

  // #2273 — the session-start hook prints the rules files the launch wrote, on
  // every start including after a `/clear`. Each route that can change the
  // rules in force must leave those files saying what is in force.
  describe('#2273 — a rule change rewrites what a cleared session is re-delivered', () => {
    let seq = 0;
    let budget;
    before(() => { budget = channel.resolveChannelBudget(store.engines.get('claude')); });

    /**
     * A project whose launch delivered its rules: active rules in the store,
     * the files a launch writes for them, and one rules hook registered per
     * file, in the shape the hook sync writes.
     * @param {string[]} contents - Text of the rules in force at launch
     * @returns {{id:number, name:string, path:string, rules:object[]}}
     */
    function launchedProject(contents) {
      seq += 1;
      const name = `delivered-proj-${seq}`;
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name, path: dir, engine: 'claude' });
      const rules = contents.map((content) => store.sessionRules.create({ content, projectId: project.id }));
      if (rules.length > 0) {
        const shards = channel.buildShards(rules, budget);
        channel.writeShards(dir, shards, rules.length);
        registerHooks(dir, shards.length);
      }
      return { id: project.id, name, path: dir, rules };
    }

    /**
     * Register rules hooks 1..count in the project's local settings file.
     * @param {string} projectPath
     * @param {number} count
     */
    function registerHooks(projectPath, count) {
      const SessionStart = [];
      for (let i = 1; i <= count; i += 1) {
        SessionStart.push({
          matcher: 'startup|clear|compact',
          hooks: [{ type: 'command', command: `'/opt/tc'/data/hooks/sessionstart-rules-claude.sh ${i}` }]
        });
      }
      fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { SessionStart } }));
    }

    /**
     * What the hook would print for a project, every file joined.
     * @param {string} projectPath
     * @returns {string}
     */
    function deliveredText(projectPath) {
      const texts = [];
      for (let i = 1; fs.existsSync(channel.shardPath(projectPath, i)); i += 1) {
        texts.push(JSON.parse(fs.readFileSync(channel.shardPath(projectPath, i), 'utf8')).hookSpecificOutput.additionalContext);
      }
      return texts.join('\n');
    }

    /**
     * The raw bytes of a project's rules files, to show a call left them alone.
     * @param {string} projectPath
     * @returns {string[]}
     */
    function deliveredBytes(projectPath) {
      const files = [];
      for (let i = 1; fs.existsSync(channel.shardPath(projectPath, i)); i += 1) {
        files.push(fs.readFileSync(channel.shardPath(projectPath, i), 'utf8'));
      }
      return files;
    }

    /**
     * Hold the delivered files to what the API says is in force for the
     * project: every such rule is printed with its label and text, and no
     * other rule of the project is.
     * @param {{id:number, path:string}} project
     * @returns {Promise<object[]>} the rules in force
     */
    async function assertFilesMatchRulesInForce(project) {
      const listed = await request('GET', `/api/session-rules?projectId=${project.id}&kind=startup`);
      assert.equal(listed.status, 200);
      const inForce = listed.data.rules.filter((r) => r.status === 'active' && r.enabled);
      const text = deliveredText(project.path);
      for (const rule of inForce) {
        assert.ok(text.includes(`Rule #${rule.id} `), `rule ${rule.id} is in force and must be in the files`);
        assert.ok(text.includes(rule.content), `the files must carry rule ${rule.id}'s current text`);
      }
      const labels = [...text.matchAll(/Rule #(\d+) /g)].map((m) => Number(m[1])).sort((a, b) => a - b);
      assert.deepEqual(labels, inForce.map((r) => r.id).sort((a, b) => a - b), 'the files state the rules in force and no other');
      assert.match(text, new RegExp(`Rules in force: ${inForce.length}, as of`));
      return inForce;
    }

    /**
     * Bring a project's files level with the store after a direct store write.
     * @param {{id:number}} project
     */
    function rulesRefreshOf(project) {
      assert.equal(rulesRefresh.refreshProjectRules(project.id).status, 'refreshed');
    }

    /**
     * Run a call with warnings captured from the log.
     * @param {function(): Promise<object>} call
     * @returns {Promise<{res: object, logged: string}>}
     */
    async function withLog(call) {
      const lines = [];
      setLevel('warn');
      setConsoleStream({ write: (line) => { lines.push(String(line)); } });
      try {
        return { res: await call(), logged: lines.join('') };
      } finally {
        setConsoleStream(null);
        setLevel('error');
      }
    }

    it('POST: a rule the operator creates is in the files', async () => {
      const project = launchedProject(['Launch-time rule.']);
      const res = await request('POST', '/api/session-rules', { content: 'Created after the launch.', projectId: project.id });
      assert.equal(res.status, 201);
      assert.equal(res.data.deliveryWarning, undefined);
      const inForce = await assertFilesMatchRulesInForce(project);
      assert.equal(inForce.length, 2);
    });

    it('PUT: switching a rule off takes it out of the files, and on puts it back', async () => {
      const project = launchedProject(['Stays.', 'Switched off and on.']);
      const id = project.rules[1].id;

      const off = await request('PUT', `/api/session-rules/${id}`, { enabled: false });
      assert.equal(off.status, 200);
      assert.ok(!deliveredText(project.path).includes('Switched off and on.'));
      await assertFilesMatchRulesInForce(project);

      const on = await request('PUT', `/api/session-rules/${id}`, { enabled: true });
      assert.equal(on.status, 200);
      assert.ok(deliveredText(project.path).includes('Switched off and on.'));
      await assertFilesMatchRulesInForce(project);
    });

    it('DELETE: a deleted rule leaves the files, and the last one leaves a file that says none is in force', async () => {
      const project = launchedProject(['Kept until the end.', 'Deleted first.']);

      const first = await request('DELETE', `/api/session-rules/${project.rules[1].id}`);
      assert.equal(first.status, 200);
      assert.equal(first.data.ok, true);
      assert.ok(!deliveredText(project.path).includes('Deleted first.'));
      await assertFilesMatchRulesInForce(project);

      const last = await request('DELETE', `/api/session-rules/${project.rules[0].id}`);
      assert.equal(last.status, 200);
      const text = deliveredText(project.path);
      assert.match(text, /^## Project Rules\n/, 'a missing block reads as a failed delivery, so the heading stays');
      assert.ok(!text.includes('Kept until the end.'));
    });

    it('promote: a learning promoted into a startup rule is in the files; into a wrap rule it leaves them alone', async () => {
      const project = launchedProject(['Launch-time rule.']);
      const learning = store.learnings.create({ projectId: project.id, content: 'Promoted into a startup rule.' });
      const startup = await request('POST', '/api/session-rules/promote', { learningId: learning.id, projectId: project.id });
      assert.equal(startup.status, 201);
      assert.equal(startup.data.status, 'active');
      assert.ok(deliveredText(project.path).includes('Promoted into a startup rule.'));
      await assertFilesMatchRulesInForce(project);

      const before = deliveredBytes(project.path);
      const wrapLearning = store.learnings.create({ projectId: project.id, content: 'Promoted into a wrap rule.' });
      const wrap = await request('POST', '/api/session-rules/promote',
        { learningId: wrapLearning.id, projectId: project.id, kind: 'wrap' });
      assert.equal(wrap.status, 201);
      assert.equal(wrap.data.kind, 'wrap');
      assert.deepEqual(deliveredBytes(project.path), before, 'a wrap rule is not delivered by this channel');
    });

    it('status: retiring a rule removes it from the files', async () => {
      const project = launchedProject(['Stays in force.', 'Retired mid-session.']);
      const res = await request('PUT', `/api/session-rules/${project.rules[1].id}/status`, { status: 'retired' });
      assert.equal(res.status, 200);
      assert.ok(!deliveredText(project.path).includes('Retired mid-session.'),
        'a retired rule must not be re-delivered as binding');
      await assertFilesMatchRulesInForce(project);
    });

    it('status: approving a replacement leaves the new text and not the old, and the edit alone changed nothing', async () => {
      const project = launchedProject(['Stays in force.', 'The first wording.']);
      const before = deliveredBytes(project.path);

      const edit = await request('PUT', `/api/session-rules/${project.rules[1].id}`, { content: 'The second wording.' });
      assert.equal(edit.status, 202);
      assert.deepEqual(deliveredBytes(project.path), before, 'a text change awaiting approval is not in force');

      const approved = await request('PUT', `/api/session-rules/${edit.data.replacementProposed.id}/status`,
        { status: 'active', expectedContent: 'The second wording.' });
      assert.equal(approved.status, 200);
      const text = deliveredText(project.path);
      assert.ok(text.includes('The second wording.'));
      assert.ok(!text.includes('The first wording.'), 'the replaced text must not be re-delivered');
      const inForce = await assertFilesMatchRulesInForce(project);
      assert.equal(inForce.length, 2, 'the approval and the retirement it carries are one refresh, after both');
    });

    it('status: declining a proposal changes nothing in the files', async () => {
      const project = launchedProject(['In force.']);
      const proposal = store.sessionRules.create({ content: 'Proposed by a session.', projectId: project.id, createdBy: 'ai' });
      assert.equal(proposal.status, 'proposed');
      const before = deliveredBytes(project.path);
      const res = await request('PUT', `/api/session-rules/${proposal.id}/status`, { status: 'rejected' });
      assert.equal(res.status, 200);
      assert.deepEqual(deliveredBytes(project.path), before);
    });

    it('restore: a rollback that switches a rule back on puts it in the files; one that changes its text waits for approval', async () => {
      const project = launchedProject(['Stays.', 'Rolled back.']);
      const id = project.rules[1].id;
      await request('PUT', `/api/session-rules/${id}`, { enabled: false });
      assert.ok(!deliveredText(project.path).includes('Rolled back.'));

      const versions = store.sessionRules.listVersions(id);
      const enabledVersion = versions.find((v) => v.enabled);
      const restored = await request('POST', `/api/session-rules/${id}/restore`, { versionNo: enabledVersion.versionNo });
      assert.equal(restored.status, 200);
      assert.equal(restored.data.enabled, true);
      assert.ok(deliveredText(project.path).includes('Rolled back.'));
      await assertFilesMatchRulesInForce(project);

      // A proposal's text can be changed in place, so its history holds another wording.
      const draft = store.sessionRules.create({ content: 'Draft wording.', projectId: project.id, createdBy: 'ai' });
      store.sessionRules.update(draft.id, { content: 'Approved wording.' });
      store.sessionRules.setStatus(draft.id, 'active', { expectedContent: 'Approved wording.' });
      rulesRefreshOf(project);
      const before = deliveredBytes(project.path);
      const draftVersion = store.sessionRules.listVersions(draft.id).find((v) => v.content === 'Draft wording.');
      const textRollback = await request('POST', `/api/session-rules/${draft.id}/restore`, { versionNo: draftVersion.versionNo });
      assert.equal(textRollback.status, 202, 'a rollback to other text is filed as a proposal');
      assert.deepEqual(deliveredBytes(project.path), before);
    });

    it('the real hook prints the rules in force after a clear, once a route has changed them', async () => {
      const project = launchedProject(['Retired while the session runs.']);
      await request('PUT', `/api/session-rules/${project.rules[0].id}/status`, { status: 'retired' });
      const approved = await request('POST', '/api/session-rules', { content: 'Approved while the session runs.', projectId: project.id });

      const printed = execFileSync('bash', [path.join(__dirname, '..', 'data', 'hooks', 'sessionstart-rules-claude.sh'), '1'], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: project.path },
        input: '{"source":"clear"}',
        encoding: 'utf8'
      });

      const context = JSON.parse(printed).hookSpecificOutput.additionalContext;
      assert.ok(context.includes(`Rule #${approved.data.id} — Approved while the session runs.`));
      assert.ok(!context.includes('Retired while the session runs.'));
    });

    it('a session\'s own proposal, and its revision of it, change nothing in the files', async () => {
      const project = launchedProject(['In force.']);
      const asProject = bindProject(project).headers;
      const before = deliveredBytes(project.path);

      const proposed = await sendAs(server, 'POST', '/api/session-rules',
        { content: 'A session proposes this.', projectId: project.id }, asProject);
      assert.equal(proposed.status, 201);
      assert.equal(proposed.data.status, 'proposed');
      assert.equal(proposed.data.deliveryWarning, undefined);
      const revised = await sendAs(server, 'PUT', `/api/session-rules/${proposed.data.id}`,
        { content: 'A session revises its proposal.' }, asProject);
      assert.equal(revised.status, 200);
      const withdrawn = await sendAs(server, 'DELETE', `/api/session-rules/${proposed.data.id}`, undefined, asProject);
      assert.equal(withdrawn.status, 200);

      assert.deepEqual(deliveredBytes(project.path), before, 'a proposal is not in force');
    });

    it('a Project Master rule refreshes nothing and is answered as before', async () => {
      const res = await request('POST', '/api/session-rules', { content: 'a master rule for the refresh case', kind: 'master' });
      assert.equal(res.status, 201);
      assert.equal(res.data.deliveryWarning, undefined);
      await request('DELETE', `/api/session-rules/${res.data.id}`);
    });

    describe('when the files cannot be rewritten', () => {
      /**
       * A launched project whose registered hooks can no longer be read, which
       * fails every refresh before a file is touched.
       * @param {string[]} contents
       * @returns {{project: object, settings: string, before: string[]}}
       */
      function brokenProject(contents) {
        const project = launchedProject(contents);
        const settings = path.join(project.path, '.claude', 'settings.local.json');
        fs.writeFileSync(settings, '{ not json');
        return { project, settings, before: deliveredBytes(project.path) };
      }

      /**
       * The rule change succeeded, the caller was told, the log names the
       * project and the cause, and the files are as they were.
       * @param {{res: object, logged: string}} outcome
       * @param {number} status - The route's success status
       * @param {{project: object, settings: string, before: string[]}} fixture
       */
      function assertSavedWithWarning(outcome, status, fixture) {
        assert.equal(outcome.res.status, status, 'a refresh failure must not fail the rule change');
        assert.match(outcome.res.data.deliveryWarning, /The rule change is saved, but the rules files/);
        assert.ok(outcome.res.data.deliveryWarning.includes(fixture.project.name));
        assert.ok(outcome.res.data.deliveryWarning.includes(fixture.settings), 'the warning names the file at fault');
        assert.match(outcome.res.data.deliveryWarning, /`tc rules` is correct/);
        assert.ok(outcome.logged.includes(fixture.project.name), `the log names the project: ${outcome.logged}`);
        assert.ok(outcome.logged.includes(fixture.settings), 'the log names the cause');
        assert.deepEqual(deliveredBytes(fixture.project.path), fixture.before);
      }

      it('POST still creates the rule', async () => {
        const fixture = brokenProject(['Launch-time rule.']);
        const outcome = await withLog(() => request('POST', '/api/session-rules',
          { content: 'Saved though undelivered.', projectId: fixture.project.id }));
        assertSavedWithWarning(outcome, 201, fixture);
        assert.equal(store.sessionRules.get(outcome.res.data.id).content, 'Saved though undelivered.');
      });

      it('PUT still switches the rule off', async () => {
        const fixture = brokenProject(['Launch-time rule.']);
        const id = fixture.project.rules[0].id;
        const outcome = await withLog(() => request('PUT', `/api/session-rules/${id}`, { enabled: false }));
        assertSavedWithWarning(outcome, 200, fixture);
        assert.equal(store.sessionRules.get(id).enabled, false);
      });

      it('DELETE still deletes the rule', async () => {
        const fixture = brokenProject(['Launch-time rule.']);
        const id = fixture.project.rules[0].id;
        const outcome = await withLog(() => request('DELETE', `/api/session-rules/${id}`));
        assertSavedWithWarning(outcome, 200, fixture);
        assert.equal(store.sessionRules.get(id), null);
      });

      it('promote still mints the rule', async () => {
        const fixture = brokenProject(['Launch-time rule.']);
        const learning = store.learnings.create({ projectId: fixture.project.id, content: 'Promoted though undelivered.' });
        const outcome = await withLog(() => request('POST', '/api/session-rules/promote',
          { learningId: learning.id, projectId: fixture.project.id }));
        assertSavedWithWarning(outcome, 201, fixture);
        assert.equal(store.sessionRules.get(outcome.res.data.id).status, 'active');
      });

      it('status still retires the rule', async () => {
        const fixture = brokenProject(['Launch-time rule.']);
        const id = fixture.project.rules[0].id;
        const outcome = await withLog(() => request('PUT', `/api/session-rules/${id}/status`, { status: 'retired' }));
        assertSavedWithWarning(outcome, 200, fixture);
        assert.equal(store.sessionRules.get(id).status, 'retired');
      });

      it('restore still rolls the rule back', async () => {
        const project = launchedProject(['Launch-time rule.']);
        const id = project.rules[0].id;
        await request('PUT', `/api/session-rules/${id}`, { enabled: false });
        const settings = path.join(project.path, '.claude', 'settings.local.json');
        fs.writeFileSync(settings, '{ not json');
        const fixture = { project, settings, before: deliveredBytes(project.path) };
        const enabledVersion = store.sessionRules.listVersions(id).find((v) => v.enabled);
        const outcome = await withLog(() => request('POST', `/api/session-rules/${id}/restore`,
          { versionNo: enabledVersion.versionNo }));
        assertSavedWithWarning(outcome, 200, fixture);
        assert.equal(store.sessionRules.get(id).enabled, true);
      });

      it('says the files are part new and part old when a swap failed part-way', async () => {
        const big = 'w'.repeat(Math.floor(budget * 0.6));
        const project = launchedProject([`one ${big}`, `two ${big}`]);
        assert.equal(deliveredBytes(project.path).length, 2, 'the fixture needs two files');
        // A directory where the second file goes: the first swap lands, the second cannot.
        fs.rmSync(channel.shardPath(project.path, 2));
        fs.mkdirSync(channel.shardPath(project.path, 2));
        fs.writeFileSync(path.join(channel.shardPath(project.path, 2), 'occupied'), '');
        const outcome = await withLog(() => request('POST', '/api/session-rules',
          { content: 'A third rule.', projectId: project.id }));
        assert.equal(outcome.res.status, 201);
        assert.match(outcome.res.data.deliveryWarning, /part new and part old/);
      });
    });

    describe('where the launch wrote no rules file', () => {
      it('writes no file, and says nothing when no session of the project is running', async () => {
        const project = launchedProject([]);
        const outcome = await withLog(() => request('POST', '/api/session-rules',
          { content: 'The next launch delivers this.', projectId: project.id }));
        assert.equal(outcome.res.status, 201);
        assert.equal(outcome.res.data.deliveryWarning, undefined, 'the next launch writes the files; nothing is undelivered');
        assert.equal(outcome.logged, '');
        assert.equal(fs.existsSync(path.join(project.path, '.tangleclaw')), false,
          'a rule change must not start delivery the launch declined');
      });

      it('tells the caller and the log that a running session is not re-delivered its first rule (#2293)', async () => {
        const project = launchedProject([]);
        bindProject(project);
        const outcome = await withLog(() => request('POST', '/api/session-rules',
          { content: 'The first rule of a project launched with none.', projectId: project.id }));

        assert.equal(outcome.res.status, 201);
        assert.equal(outcome.res.data.status, 'active');
        const warning = outcome.res.data.deliveryWarning;
        assert.match(warning, /1 rule is in force/);
        assert.ok(warning.includes(project.name));
        assert.match(warning, /will not be re-delivered them after a clear or a compaction until its next launch/);
        assert.match(warning, /its launch wrote no rules file/);
        assert.match(warning, /`tc rules` shows them meanwhile/);
        assert.ok(outcome.logged.includes(project.name) && outcome.logged.includes('#2293'),
          `an undelivered rule is stated in the log, never silent: ${outcome.logged}`);
        assert.equal(fs.existsSync(path.join(project.path, '.tangleclaw')), false);

        const second = await request('POST', '/api/session-rules', { content: 'A second.', projectId: project.id });
        assert.match(second.data.deliveryWarning, /2 rules are in force/);
      });

      it('says nothing once no rule is left in force, or for a change that is not in force', async () => {
        const project = launchedProject([]);
        const asProject = bindProject(project).headers;
        const created = await request('POST', '/api/session-rules', { content: 'Only rule.', projectId: project.id });
        assert.ok(created.data.deliveryWarning);

        const proposed = await sendAs(server, 'POST', '/api/session-rules',
          { content: 'A proposal.', projectId: project.id }, asProject);
        assert.equal(proposed.data.status, 'proposed');
        assert.equal(proposed.data.deliveryWarning, undefined, 'a proposal is not a rule in force');

        const deleted = await request('DELETE', `/api/session-rules/${created.data.id}`);
        assert.equal(deleted.status, 200);
        assert.equal(deleted.data.deliveryWarning, undefined);
      });

      it('names the missing hook when files are on disk and nothing is registered to print them', async () => {
        const project = launchedProject(['Launch-time rule.']);
        registerHooks(project.path, 0);
        bindProject(project);
        const before = deliveredBytes(project.path);
        const res = await request('POST', '/api/session-rules', { content: 'Another.', projectId: project.id });
        assert.equal(res.status, 201);
        assert.match(res.data.deliveryWarning, /2 rules are in force/);
        assert.match(res.data.deliveryWarning, /no session-start hook is registered to print its rules files/);
        assert.deepEqual(deliveredBytes(project.path), before);
      });
    });
  });
});
