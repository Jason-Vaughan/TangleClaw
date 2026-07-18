'use strict';

/*
 * Store-level tests for the session_rules table + sessionRulesApi (#347/D1a).
 * Covers the CRUD round-trip, the injection query (per-project only — the
 * hidden global tier was retired with the Phase A settings cleanup), the
 * projectId-required contract, created_by default, cascade delete, and
 * activity logging.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('sessionRules store API (#347/D1a)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-rules-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a project and return its id. */
  function mkProject(name) {
    const projPath = path.join(tmpDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    return store.projects.create({ name, path: projPath, engine: 'claude', methodology: 'none' }).id;
  }

  describe('create', () => {
    it('creates a project-scoped rule with operator default and trims content', () => {
      const pid = mkProject('proj-trim');
      const rule = store.sessionRules.create({ content: '  Prefer X over Y  ', projectId: pid });
      assert.equal(rule.content, 'Prefer X over Y');
      assert.equal(rule.projectId, pid);
      assert.equal(rule.createdBy, 'operator');
      assert.equal(rule.enabled, true);
      assert.equal(rule.owner, null);
      assert.ok(rule.id > 0);
    });

    it('honors an explicit createdBy', () => {
      const pid = mkProject('proj-a');
      const rule = store.sessionRules.create({ content: 'AI rule', projectId: pid, createdBy: 'ai' });
      assert.equal(rule.createdBy, 'ai');
      assert.equal(rule.projectId, pid);
    });

    it('rejects empty content', () => {
      const pid = mkProject('proj-empty');
      assert.throws(() => store.sessionRules.create({ content: '   ', projectId: pid }), /content is required/);
      assert.throws(() => store.sessionRules.create({}), /content is required/);
    });

    it('rejects a projectId-less create (global tier retired)', () => {
      assert.throws(() => store.sessionRules.create({ content: 'global?' }), /projectId is required/);
      assert.throws(() => store.sessionRules.create({ content: 'global?', projectId: null }), /projectId is required/);
    });

    it('logs a session_rule.created activity event', () => {
      const pid = mkProject('proj-log');
      store.sessionRules.create({ content: 'logged rule', projectId: pid });
      const events = store.activity.query({ eventType: 'session_rule.created' });
      assert.equal(events.length, 1);
    });
  });

  describe('listActiveForProject (injection query)', () => {
    it('returns the project\'s rules in creation order', () => {
      const pidA = mkProject('proj-a');
      store.sessionRules.create({ content: 'first rule', projectId: pidA });
      store.sessionRules.create({ content: 'second rule', projectId: pidA });

      const forA = store.sessionRules.listActiveForProject(pidA).map((r) => r.content);
      assert.deepEqual(forA, ['first rule', 'second rule']);
    });

    it('excludes disabled rules', () => {
      const pid = mkProject('proj-disabled');
      const disabled = store.sessionRules.create({ content: 'off rule', projectId: pid });
      store.sessionRules.update(disabled.id, { enabled: false });
      store.sessionRules.create({ content: 'on rule', projectId: pid });

      const active = store.sessionRules.listActiveForProject(pid).map((r) => r.content);
      assert.deepEqual(active, ['on rule']);
    });

    it('excludes other projects rules', () => {
      const pidA = mkProject('proj-a');
      const pidB = mkProject('proj-b');
      store.sessionRules.create({ content: 'A only', projectId: pidA });
      store.sessionRules.create({ content: 'B only', projectId: pidB });

      const forA = store.sessionRules.listActiveForProject(pidA).map((r) => r.content);
      assert.deepEqual(forA, ['A only']);
    });

    it('returns [] when projectId is null (global tier retired)', () => {
      const pidA = mkProject('proj-a');
      store.sessionRules.create({ content: 'scoped', projectId: pidA });

      assert.deepEqual(store.sessionRules.listActiveForProject(null), []);
      assert.deepEqual(store.sessionRules.listActiveForProject(undefined), []);
    });
  });

  describe('list', () => {
    it('filters by projectId', () => {
      const pidA = mkProject('proj-a');
      const pidB = mkProject('proj-b');
      store.sessionRules.create({ content: 'a rule', projectId: pidA });
      store.sessionRules.create({ content: 'b rule', projectId: pidB });

      const forA = store.sessionRules.list({ projectId: pidA });
      assert.equal(forA.length, 1);
      assert.equal(forA[0].content, 'a rule');
    });

    it('filters by enabled', () => {
      const pid = mkProject('proj-enabled');
      const off = store.sessionRules.create({ content: 'off', projectId: pid });
      store.sessionRules.update(off.id, { enabled: false });
      store.sessionRules.create({ content: 'on', projectId: pid });

      assert.equal(store.sessionRules.list({ enabled: 1 }).length, 1);
      assert.equal(store.sessionRules.list({ enabled: 0 }).length, 1);
    });
  });

  describe('get / update / delete', () => {
    it('round-trips through get', () => {
      const pid = mkProject('proj-get');
      const created = store.sessionRules.create({ content: 'fetch me', projectId: pid });
      const fetched = store.sessionRules.get(created.id);
      assert.equal(fetched.content, 'fetch me');
      assert.equal(store.sessionRules.get(99999), null);
    });

    it('updates content and enabled, bumps updated_at, logs an event', () => {
      const pid = mkProject('proj-upd');
      const created = store.sessionRules.create({ content: 'before', projectId: pid });
      const updated = store.sessionRules.update(created.id, { content: 'after', enabled: false });
      assert.equal(updated.content, 'after');
      assert.equal(updated.enabled, false);
      const events = store.activity.query({ eventType: 'session_rule.updated' });
      assert.equal(events.length, 1);
    });

    it('rejects empty content on update', () => {
      const pid = mkProject('proj-keep');
      const created = store.sessionRules.create({ content: 'keep', projectId: pid });
      assert.throws(() => store.sessionRules.update(created.id, { content: '  ' }), /cannot be empty/);
    });

    it('throws NOT_FOUND on update/delete of a missing rule', () => {
      assert.throws(() => store.sessionRules.update(99999, { enabled: false }), /not found/);
      assert.throws(() => store.sessionRules.delete(99999), /not found/);
    });

    it('deletes a rule and logs an event', () => {
      const pid = mkProject('proj-del');
      const created = store.sessionRules.create({ content: 'goner', projectId: pid });
      store.sessionRules.delete(created.id);
      assert.equal(store.sessionRules.get(created.id), null);
      const events = store.activity.query({ eventType: 'session_rule.deleted' });
      assert.equal(events.length, 1);
    });
  });

  describe('cascade delete', () => {
    it('removes a project rule when its project is deleted', () => {
      const pid = mkProject('doomed');
      const otherPid = mkProject('survivor-proj');
      store.sessionRules.create({ content: 'doomed rule', projectId: pid });
      store.sessionRules.create({ content: 'survivor rule', projectId: otherPid });

      store.projects.delete(pid);

      const remaining = store.sessionRules.list().map((r) => r.content);
      assert.deepEqual(remaining, ['survivor rule']);
    });
  });

  describe('kind discriminator (CC-6, #381)', () => {
    it('defaults a rule to kind=startup', () => {
      const pid = mkProject('proj-kind-default');
      const rule = store.sessionRules.create({ content: 'no kind given', projectId: pid });
      assert.equal(rule.kind, 'startup');
    });

    it('honors an explicit valid kind', () => {
      const pid = mkProject('proj-kind-wrap');
      const wrap = store.sessionRules.create({ content: 'wrap rule', projectId: pid, kind: 'wrap' });
      assert.equal(wrap.kind, 'wrap');
    });

    it('rejects an unknown kind — including the retired mode kind', () => {
      const pid = mkProject('proj-kind-bad');
      assert.throws(
        () => store.sessionRules.create({ content: 'bad', projectId: pid, kind: 'bogus' }),
        /kind must be one of/
      );
      // 'mode' was a valid kind until the Phase A settings retask replaced it
      // with the structured defaultLaunchMode/showLaunchModePicker settings.
      assert.throws(
        () => store.sessionRules.create({ content: 'posture', projectId: pid, kind: 'mode' }),
        /kind must be one of/
      );
    });

    it('exposes SESSION_RULE_KINDS', () => {
      assert.deepEqual(store.SESSION_RULE_KINDS, ['startup', 'wrap', 'master']);
    });

    it('list filters by kind', () => {
      const pid = mkProject('proj-k');
      store.sessionRules.create({ content: 's', projectId: pid, kind: 'startup' });
      store.sessionRules.create({ content: 'w', projectId: pid, kind: 'wrap' });

      assert.deepEqual(store.sessionRules.list({ projectId: pid, kind: 'wrap' }).map((r) => r.content), ['w']);
      assert.equal(store.sessionRules.list({ projectId: pid }).length, 2);
    });

    it('listActiveForProject (launch injection) returns ONLY startup rules', () => {
      const pid = mkProject('proj-inject');
      store.sessionRules.create({ content: 'startup rule', projectId: pid, kind: 'startup' });
      store.sessionRules.create({ content: 'wrap rule', projectId: pid, kind: 'wrap' });

      const injected = store.sessionRules.listActiveForProject(pid).map((r) => r.content);
      assert.deepEqual(injected, ['startup rule']);
    });

    it('kind survives a version restore (immutable)', () => {
      const pid = mkProject('proj-restore');
      const wrap = store.sessionRules.create({ content: 'v1', projectId: pid, kind: 'wrap' });
      store.sessionRules.update(wrap.id, { content: 'v2' });
      const restored = store.sessionRules.restore(wrap.id, 1);
      assert.equal(restored.kind, 'wrap');
      assert.equal(restored.content, 'v1');
    });

    it('promoteFromLearning can target a wrap rule for the self-critique sink', () => {
      const pid = mkProject('proj-learn');
      const learning = store.learnings.create({ projectId: pid, content: 'always run lint before wrap', tier: 'provisional' });
      const rule = store.sessionRules.promoteFromLearning(learning.id, { kind: 'wrap' });
      assert.equal(rule.kind, 'wrap');
      assert.equal(rule.createdBy, 'ai');
      assert.equal(rule.sourceLearningId, learning.id);
      // No projectId override → the rule lands on the learning's own project.
      assert.equal(rule.projectId, pid);
    });

    it('findConflictCandidates scopes to the same kind when opts.kind given', () => {
      const pid = mkProject('proj-conflicts');
      store.sessionRules.create({ content: 'commit before wrapping the session', projectId: pid, kind: 'startup' });
      store.sessionRules.create({ content: 'commit before wrapping the session always', projectId: pid, kind: 'wrap' });

      const sameKind = store.sessionRules.findConflictCandidates(
        'remember to commit before wrapping',
        pid,
        { kind: 'wrap' }
      );
      assert.equal(sameKind.length, 1);
      assert.equal(sameKind[0].rule.kind, 'wrap');
    });

    it('findConflictCandidates returns [] for a null projectId (global tier retired)', () => {
      const pid = mkProject('proj-conflicts-null');
      store.sessionRules.create({ content: 'commit before wrapping the session', projectId: pid });
      assert.deepEqual(store.sessionRules.findConflictCandidates('commit before wrapping', null), []);
    });
  });

  describe('op CHECK constraint (SR-3MW8)', () => {
    it('every writer op (create → update → restore → delete) satisfies the constraint', () => {
      // The whole safety guarantee: the four real writers must only ever emit
      // enum-valid ops. Drive all four through the API and confirm none throws
      // and the recorded history carries exactly the enum values.
      const pid = mkProject('proj-ops');
      const rule = store.sessionRules.create({ content: 'v1', projectId: pid }); // op=create
      store.sessionRules.update(rule.id, { content: 'v2' });              // op=update
      store.sessionRules.restore(rule.id, 1);                            // op=restore
      store.sessionRules.delete(rule.id);                                // op=delete

      const ops = store.sessionRules.listVersions(rule.id).map((v) => v.op).sort();
      assert.deepEqual(ops, ['create', 'delete', 'restore', 'update']);
    });

    it('rejects a direct insert with an out-of-enum op (fresh-DB _createTables path)', () => {
      // Fresh DB gets the CHECK straight from the _createTables DDL. Prove it by
      // attempting a raw insert of a bogus op — the storage layer must reject it
      // even though no application code path would ever produce it.
      const pid = mkProject('proj-op-check');
      const rule = store.sessionRules.create({ content: 'guarded', projectId: pid });
      const db = store.getDb();
      assert.throws(
        () => db.prepare(
          `INSERT INTO session_rule_versions
             (rule_id, version_no, op, content, enabled, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(rule.id, 99, 'bogus', 'x', 1, 'operator'),
        /CHECK constraint failed/i,
        'out-of-enum op must be rejected by the CHECK constraint'
      );
      // A valid op via the same raw path still works.
      assert.doesNotThrow(() => db.prepare(
        `INSERT INTO session_rule_versions
           (rule_id, version_no, op, content, enabled, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(rule.id, 98, 'update', 'x', 1, 'operator'));
    });
  });

  describe('critic_gate provenance (SR-7K2P)', () => {
    it('derives not-required for an operator edit and unknown for an AI edit', () => {
      const pid = mkProject('proj-gate');
      const opRule = store.sessionRules.create({ content: 'op rule', projectId: pid });
      assert.equal(store.sessionRules.listVersions(opRule.id)[0].criticGate, 'not-required');

      const aiRule = store.sessionRules.create({ content: 'ai rule', projectId: pid, createdBy: 'ai' });
      assert.equal(store.sessionRules.listVersions(aiRule.id)[0].criticGate, 'unknown');
    });

    it('records an explicit attestation on create, update, and restore', () => {
      const pid = mkProject('proj-gate-attest');
      const rule = store.sessionRules.create({ content: 'v1', projectId: pid, createdBy: 'ai', criticGate: 'passed' });
      assert.equal(store.sessionRules.listVersions(rule.id)[0].criticGate, 'passed');

      store.sessionRules.update(rule.id, { content: 'v2', changedBy: 'ai', criticGate: 'passed' });
      assert.equal(store.sessionRules.listVersions(rule.id)[0].criticGate, 'passed');

      store.sessionRules.restore(rule.id, 1, { changedBy: 'ai', criticGate: 'passed' });
      assert.equal(store.sessionRules.listVersions(rule.id)[0].criticGate, 'passed');
    });

    it('derives per-change: an AI update on an operator rule records unknown', () => {
      // The mapping keys off THIS change's author (changed_by), not the rule's
      // original author — an operator-created rule updated by the AI with no
      // attestation must record 'unknown', not inherit 'not-required'.
      const pid = mkProject('proj-gate-per-change');
      const rule = store.sessionRules.create({ content: 'v1', projectId: pid }); // operator → not-required
      store.sessionRules.update(rule.id, { content: 'v2', changedBy: 'ai' });
      const versions = store.sessionRules.listVersions(rule.id);
      assert.equal(versions[0].criticGate, 'unknown');   // the AI update
      assert.equal(versions[1].criticGate, 'not-required'); // the operator create
    });

    it('a promoted learning is AI-authored, so its v1 defaults to unknown', () => {
      const pid = mkProject('promote-gate-proj');
      const learning = store.learnings.create({ projectId: pid, content: 'a recurring insight' });
      const rule = store.sessionRules.promoteFromLearning(learning.id);
      assert.equal(store.sessionRules.listVersions(rule.id)[0].criticGate, 'unknown');

      const attested = store.sessionRules.promoteFromLearning(learning.id, { criticGate: 'passed' });
      assert.equal(store.sessionRules.listVersions(attested.id)[0].criticGate, 'passed');
    });

    it('rejects an out-of-enum criticGate with BAD_REQUEST and writes nothing', () => {
      const pid = mkProject('proj-gate-bad');
      assert.throws(
        () => store.sessionRules.create({ content: 'bad', projectId: pid, criticGate: 'maybe' }),
        (err) => err.code === 'BAD_REQUEST'
      );
      // The rule was never created — validation runs before any mutation.
      assert.equal(store.sessionRules.list().length, 0);

      const rule = store.sessionRules.create({ content: 'ok', projectId: pid });
      assert.throws(
        () => store.sessionRules.update(rule.id, { content: 'v2', criticGate: 'nope' }),
        (err) => err.code === 'BAD_REQUEST'
      );
      assert.throws(
        () => store.sessionRules.restore(rule.id, 1, { criticGate: 'nope' }),
        (err) => err.code === 'BAD_REQUEST'
      );
      // The failed update/restore left no extra version — only the create snapshot.
      assert.equal(store.sessionRules.listVersions(rule.id).length, 1);
    });

    it('rejects a direct insert with an out-of-enum critic_gate (fresh-DB CHECK)', () => {
      const pid = mkProject('proj-gate-check');
      const rule = store.sessionRules.create({ content: 'guarded', projectId: pid });
      const db = store.getDb();
      assert.throws(
        () => db.prepare(
          `INSERT INTO session_rule_versions
             (rule_id, version_no, op, content, enabled, created_by, critic_gate)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(rule.id, 97, 'update', 'x', 1, 'operator', 'bogus'),
        /CHECK constraint failed/i,
        'out-of-enum critic_gate must be rejected by the CHECK constraint'
      );
    });
  });

  describe('version-history pruning (SR-5T1J)', () => {
    // The suite tunes retention to a small N for cheap, precise assertions;
    // restore the shipped default after each so it can't leak between tests.
    afterEach(() => {
      store._setSessionRuleVersionRetention(store.SESSION_RULE_VERSION_RETENTION);
    });

    /** Drive a rule through `total` mutations (1 create + updates) and return it. */
    let churnSeq = 0;
    function churn(total) {
      const pid = mkProject(`proj-churn-${++churnSeq}`);
      const rule = store.sessionRules.create({ content: 'v1', projectId: pid });
      for (let i = 2; i <= total; i++) {
        store.sessionRules.update(rule.id, { content: `v${i}` });
      }
      return rule;
    }

    it('defaults to keeping the newest 200 versions per rule', () => {
      assert.equal(store.SESSION_RULE_VERSION_RETENTION, 200);
      const rule = churn(205);
      const versions = store.sessionRules.listVersions(rule.id);
      assert.equal(versions.length, 200);
      // listVersions is newest-first: newest is v205, oldest kept is v6.
      assert.equal(versions[0].content, 'v205');
      assert.equal(versions[versions.length - 1].content, 'v6');
    });

    it('keeps exactly the newest N and drops older ones (N=3)', () => {
      store._setSessionRuleVersionRetention(3);
      const rule = churn(5); // versions v1..v5
      const versions = store.sessionRules.listVersions(rule.id);
      assert.equal(versions.length, 3);
      assert.deepEqual(versions.map((v) => v.content), ['v5', 'v4', 'v3']);
      // The pruned version_nos (1,2) are gone; the kept ones stay by exact number.
      assert.deepEqual(versions.map((v) => v.versionNo), [5, 4, 3]);
    });

    it('leaves version_no monotonic (MAX+1) after pruning — no reuse of gaps', () => {
      store._setSessionRuleVersionRetention(2);
      const rule = churn(4); // keeps v3,v4; v1,v2 pruned
      store.sessionRules.update(rule.id, { content: 'v5' });
      const versions = store.sessionRules.listVersions(rule.id);
      assert.deepEqual(versions.map((v) => v.versionNo), [5, 4]); // not 3, not a reused 1
    });

    it('restore works for a kept version and 404s for a pruned one', () => {
      store._setSessionRuleVersionRetention(2);
      const rule = churn(4); // keeps v3,v4; v1,v2 pruned
      const restored = store.sessionRules.restore(rule.id, 3);
      assert.equal(restored.content, 'v3');
      assert.throws(
        () => store.sessionRules.restore(rule.id, 1),
        (err) => err.code === 'NOT_FOUND'
      );
    });

    it('preserves a deleted rule\'s tombstone as its latest version', () => {
      store._setSessionRuleVersionRetention(2);
      const rule = churn(4);
      store.sessionRules.delete(rule.id); // tombstone op=delete
      const versions = store.sessionRules.listVersions(rule.id);
      assert.equal(versions.length, 2);
      assert.equal(versions[0].op, 'delete'); // newest, always kept
    });

    it('prunes per rule — one rule\'s churn never touches another\'s history', () => {
      store._setSessionRuleVersionRetention(2);
      const a = churn(4);
      const b = store.sessionRules.create({ content: 'b1', projectId: mkProject('proj-churn-b') });
      assert.equal(store.sessionRules.listVersions(a.id).length, 2);
      assert.equal(store.sessionRules.listVersions(b.id).length, 1);
    });

    it('keeps all history when retention is 0 (opt-out) or negative', () => {
      store._setSessionRuleVersionRetention(0);
      const rule = churn(6);
      assert.equal(store.sessionRules.listVersions(rule.id).length, 6);
      store._setSessionRuleVersionRetention(-1);
      const rule2 = churn(4);
      assert.equal(store.sessionRules.listVersions(rule2.id).length, 4);
    });
  });
});

describe('sessionRules v19→v20 kind migration (CC-6, #381)', () => {
  it('backfills pre-existing rows to kind=startup and keeps them injecting', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sr-kind-mig-'));
    try {
      // Seed a v19 DB: a session_rules table WITHOUT the kind column + one row,
      // schema_version pinned at 19. store.init() then fires the v19→v20 ALTER.
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (19);
        CREATE TABLE session_rules (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id  INTEGER,
          content     TEXT    NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_by  TEXT    NOT NULL DEFAULT 'operator',
          owner       TEXT,
          source_learning_id INTEGER,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO session_rules (project_id, content) VALUES (42, 'pre-CC-6 project rule');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      // init migrates a v19 DB all the way to the current schema (now v25 — the
      // kind backfill below is the v19→v20 step in that chain). The seeded row is
      // project-scoped: a global (project_id NULL) row would be purged by the
      // v24→v25 tier retirement, which has its own migration test below.
      const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(ver.version, 25);

      // The pre-existing row backfilled to kind='startup'…
      const rules = store.sessionRules.list();
      assert.equal(rules.length, 1);
      assert.equal(rules[0].kind, 'startup');
      // …and still injects (no launch-injection regression).
      const injected = store.sessionRules.listActiveForProject(42).map((r) => r.content);
      assert.deepEqual(injected, ['pre-CC-6 project rule']);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessionRules v22→v23 op CHECK migration (SR-3MW8)', () => {
  it('rebuilds session_rule_versions with the op CHECK, preserving existing rows', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sr-op-check-mig-'));
    try {
      // Seed a v22 DB: a session_rule_versions table WITHOUT the CHECK, holding
      // rows that carry the (already-valid) enum ops, schema_version pinned at 22.
      // store.init() then fires the v22→v23 table-rebuild.
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (22);
        CREATE TABLE session_rule_versions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id       INTEGER NOT NULL,
          version_no    INTEGER NOT NULL,
          op            TEXT    NOT NULL,
          content       TEXT    NOT NULL,
          enabled       INTEGER NOT NULL,
          created_by    TEXT    NOT NULL,
          owner         TEXT,
          changed_by    TEXT    NOT NULL DEFAULT 'operator',
          change_reason TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO session_rule_versions
          (id, rule_id, version_no, op, content, enabled, created_by, changed_by, change_reason)
        VALUES
          (1, 42, 1, 'create', 'rule v1', 1, 'operator', 'operator', null),
          (2, 42, 2, 'update', 'rule v2', 1, 'operator', 'ai', 'tightened wording');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      // Schema advanced to current (v22→v23 op CHECK, then v23→v24 critic_gate).
      const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(ver.version, 25);

      // The CHECK constraint is now present in the rebuilt table's DDL.
      const ddl = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_versions'"
      ).get();
      assert.match(ddl.sql, /CHECK\s*\(\s*op\s+IN/i, 'post-migration: op CHECK constraint present');

      // Data preservation: both pre-existing rows survive verbatim (id, op, etc.).
      const rows = db.prepare(
        'SELECT id, rule_id, version_no, op, content, changed_by, change_reason FROM session_rule_versions ORDER BY id'
      ).all();
      assert.equal(rows.length, 2);
      // node:sqlite returns null-prototype rows; spread into plain objects so
      // strict deepEqual compares values, not the prototype.
      assert.deepEqual({ ...rows[0] }, { id: 1, rule_id: 42, version_no: 1, op: 'create', content: 'rule v1', changed_by: 'operator', change_reason: null });
      assert.deepEqual({ ...rows[1] }, { id: 2, rule_id: 42, version_no: 2, op: 'update', content: 'rule v2', changed_by: 'ai', change_reason: 'tightened wording' });

      // Post-migration: the rebuilt table enforces the enum on new inserts.
      assert.throws(
        () => db.prepare(
          `INSERT INTO session_rule_versions
             (rule_id, version_no, op, content, enabled, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(42, 3, 'bogus', 'x', 1, 'operator'),
        /CHECK constraint failed/i,
        'post-migration: out-of-enum op rejected'
      );
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('aborts with an attributed error when a pre-existing row has an out-of-enum op', () => {
    // The corruption this constraint guards against, encountered retroactively:
    // a v22 DB already holding a bad op can't be copied into the CHECK-bearing
    // table. The migration must fail loudly AND name the real cause (the rejected
    // copy), not the misleading "did not produce a CHECK constraint" symptom, and
    // must NOT advance schema_version.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sr-op-bad-mig-'));
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (22);
        CREATE TABLE session_rule_versions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id       INTEGER NOT NULL,
          version_no    INTEGER NOT NULL,
          op            TEXT    NOT NULL,
          content       TEXT    NOT NULL,
          enabled       INTEGER NOT NULL,
          created_by    TEXT    NOT NULL,
          owner         TEXT,
          changed_by    TEXT    NOT NULL DEFAULT 'operator',
          change_reason TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO session_rule_versions (rule_id, version_no, op, content, enabled, created_by)
        VALUES (7, 1, 'corrupt-op', 'legacy junk', 1, 'operator');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      // init() runs the migration; the postcondition must throw with the cause named.
      assert.throws(
        () => store.init(),
        /table rebuild failed — likely a pre-existing out-of-enum op value/i,
        'migration attributes the failure to the offending row, not the symptom'
      );

      // schema_version did NOT advance past 22 (loud failure, no silent v23 stamp).
      const check = new DatabaseSync(dbPath);
      const ver = check.prepare('SELECT MAX(version) AS v FROM schema_version').get();
      check.close();
      assert.equal(ver.v, 22, 'schema_version stays at 22 until the corruption is resolved');
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessionRules v23→v24 critic_gate migration (SR-7K2P)', () => {
  it('rebuilds session_rule_versions with the critic_gate CHECK, defaulting existing rows to unknown', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sr-critic-gate-mig-'));
    try {
      // Seed a v23 DB: session_rule_versions WITH the op CHECK (from v23) but
      // WITHOUT the critic_gate column, holding pre-existing rows. store.init()
      // then fires the v23→v24 table-rebuild.
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (23);
        CREATE TABLE session_rule_versions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id       INTEGER NOT NULL,
          version_no    INTEGER NOT NULL,
          op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),
          content       TEXT    NOT NULL,
          enabled       INTEGER NOT NULL,
          created_by    TEXT    NOT NULL,
          owner         TEXT,
          changed_by    TEXT    NOT NULL DEFAULT 'operator',
          change_reason TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO session_rule_versions
          (id, rule_id, version_no, op, content, enabled, created_by, changed_by, change_reason)
        VALUES
          (1, 42, 1, 'create', 'rule v1', 1, 'operator', 'operator', null),
          (2, 42, 2, 'update', 'rule v2', 1, 'operator', 'ai', 'tightened wording');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      // Schema advanced to current (the v23→v24 rebuild is the last step).
      const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(ver.version, 25);

      // The critic_gate CHECK is now present in the rebuilt table's DDL.
      const ddl = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_versions'"
      ).get();
      assert.match(ddl.sql, /CHECK\s*\(\s*critic_gate\s+IN/i, 'post-migration: critic_gate CHECK present');
      assert.match(ddl.sql, /CHECK\s*\(\s*op\s+IN/i, 'post-migration: op CHECK preserved');

      // Data preservation: both pre-existing rows survive verbatim, and the new
      // column backfills to 'unknown' (honest — no attestation existed for them).
      const rows = db.prepare(
        'SELECT id, rule_id, version_no, op, content, changed_by, change_reason, critic_gate FROM session_rule_versions ORDER BY id'
      ).all();
      assert.equal(rows.length, 2);
      // node:sqlite returns null-prototype rows; spread into plain objects so
      // strict deepEqual compares values, not the prototype.
      assert.deepEqual({ ...rows[0] }, { id: 1, rule_id: 42, version_no: 1, op: 'create', content: 'rule v1', changed_by: 'operator', change_reason: null, critic_gate: 'unknown' });
      assert.deepEqual({ ...rows[1] }, { id: 2, rule_id: 42, version_no: 2, op: 'update', content: 'rule v2', changed_by: 'ai', change_reason: 'tightened wording', critic_gate: 'unknown' });

      // Post-migration: the rebuilt table enforces the enum on new inserts.
      assert.throws(
        () => db.prepare(
          `INSERT INTO session_rule_versions
             (rule_id, version_no, op, content, enabled, created_by, critic_gate)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(42, 3, 'update', 'x', 1, 'operator', 'bogus'),
        /CHECK constraint failed/i,
        'post-migration: out-of-enum critic_gate rejected'
      );
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessionRules v24→v25 tier-retirement purge', () => {
  it('purges mode-kind and global-tier rows, preserving project-scoped rules and all version history', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sr-purge-mig-'));
    try {
      // Seed a v24 DB: a session_rules table (with the kind column) holding one
      // row in each retired tier — a mode-kind rule and a global (project_id
      // NULL) rule — plus a project-scoped startup rule that must survive, and
      // a version row for the purged rule (history outlives the rule).
      // store.init() then fires the v24→v25 purge.
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (24);
        CREATE TABLE session_rules (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id  INTEGER,
          content     TEXT    NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_by  TEXT    NOT NULL DEFAULT 'operator',
          kind        TEXT    NOT NULL DEFAULT 'startup',
          owner       TEXT,
          source_learning_id INTEGER,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO session_rules (id, project_id, content, kind) VALUES
          (1, 7,    'survivor startup rule', 'startup'),
          (2, 7,    'stray mode rule',       'mode'),
          (3, NULL, 'stray global rule',     'startup');
        CREATE TABLE session_rule_versions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id       INTEGER NOT NULL,
          version_no    INTEGER NOT NULL,
          op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),
          content       TEXT    NOT NULL,
          enabled       INTEGER NOT NULL,
          created_by    TEXT    NOT NULL,
          owner         TEXT,
          changed_by    TEXT    NOT NULL DEFAULT 'operator',
          change_reason TEXT,
          critic_gate   TEXT    NOT NULL DEFAULT 'unknown' CHECK (critic_gate IN ('passed','not-required','unknown')),
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO session_rule_versions (rule_id, version_no, op, content, enabled, created_by)
        VALUES (2, 1, 'create', 'stray mode rule', 1, 'operator');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(ver.version, 25);

      // Only the project-scoped startup rule survives.
      const rows = db.prepare('SELECT id, content FROM session_rules ORDER BY id').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 1);
      assert.equal(rows[0].content, 'survivor startup rule');

      // The purged rule's version history is preserved (provenance outlives it).
      const versions = db.prepare('SELECT rule_id FROM session_rule_versions').all();
      assert.equal(versions.length, 1);
      assert.equal(versions[0].rule_id, 2);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
