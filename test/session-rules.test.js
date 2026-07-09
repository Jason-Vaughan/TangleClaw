'use strict';

/*
 * Store-level tests for the session_rules table + sessionRulesApi (#347/D1a).
 * Covers the CRUD round-trip, the injection query (global + per-project,
 * excludes disabled + other projects), created_by default, cascade delete,
 * and activity logging.
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
    it('creates a global rule with operator default and trims content', () => {
      const rule = store.sessionRules.create({ content: '  Prefer X over Y  ' });
      assert.equal(rule.content, 'Prefer X over Y');
      assert.equal(rule.projectId, null);
      assert.equal(rule.createdBy, 'operator');
      assert.equal(rule.enabled, true);
      assert.equal(rule.owner, null);
      assert.ok(rule.id > 0);
    });

    it('honors an explicit createdBy and projectId', () => {
      const pid = mkProject('proj-a');
      const rule = store.sessionRules.create({ content: 'AI rule', projectId: pid, createdBy: 'ai' });
      assert.equal(rule.createdBy, 'ai');
      assert.equal(rule.projectId, pid);
    });

    it('rejects empty content', () => {
      assert.throws(() => store.sessionRules.create({ content: '   ' }), /content is required/);
      assert.throws(() => store.sessionRules.create({}), /content is required/);
    });

    it('logs a session_rule.created activity event', () => {
      store.sessionRules.create({ content: 'logged rule' });
      const events = store.activity.query({ eventType: 'session_rule.created' });
      assert.equal(events.length, 1);
    });
  });

  describe('listActiveForProject (injection query)', () => {
    it('returns global rules plus the matching project rules, ordered', () => {
      const pidA = mkProject('proj-a');
      const pidB = mkProject('proj-b');
      store.sessionRules.create({ content: 'global rule' });
      store.sessionRules.create({ content: 'project A rule', projectId: pidA });
      store.sessionRules.create({ content: 'project B rule', projectId: pidB });

      const forA = store.sessionRules.listActiveForProject(pidA).map((r) => r.content);
      assert.deepEqual(forA, ['global rule', 'project A rule']);
    });

    it('excludes disabled rules', () => {
      const disabled = store.sessionRules.create({ content: 'off rule' });
      store.sessionRules.update(disabled.id, { enabled: false });
      store.sessionRules.create({ content: 'on rule' });

      const active = store.sessionRules.listActiveForProject(null).map((r) => r.content);
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

    it('returns only global rules when projectId is null', () => {
      const pidA = mkProject('proj-a');
      store.sessionRules.create({ content: 'global', projectId: null });
      store.sessionRules.create({ content: 'scoped', projectId: pidA });

      const globals = store.sessionRules.listActiveForProject(null).map((r) => r.content);
      assert.deepEqual(globals, ['global']);
    });
  });

  describe('list', () => {
    it('filters by scope=global', () => {
      const pidA = mkProject('proj-a');
      store.sessionRules.create({ content: 'global' });
      store.sessionRules.create({ content: 'scoped', projectId: pidA });

      const globals = store.sessionRules.list({ scope: 'global' });
      assert.equal(globals.length, 1);
      assert.equal(globals[0].content, 'global');
    });

    it('filters by enabled', () => {
      const off = store.sessionRules.create({ content: 'off' });
      store.sessionRules.update(off.id, { enabled: false });
      store.sessionRules.create({ content: 'on' });

      assert.equal(store.sessionRules.list({ enabled: 1 }).length, 1);
      assert.equal(store.sessionRules.list({ enabled: 0 }).length, 1);
    });
  });

  describe('get / update / delete', () => {
    it('round-trips through get', () => {
      const created = store.sessionRules.create({ content: 'fetch me' });
      const fetched = store.sessionRules.get(created.id);
      assert.equal(fetched.content, 'fetch me');
      assert.equal(store.sessionRules.get(99999), null);
    });

    it('updates content and enabled, bumps updated_at, logs an event', () => {
      const created = store.sessionRules.create({ content: 'before' });
      const updated = store.sessionRules.update(created.id, { content: 'after', enabled: false });
      assert.equal(updated.content, 'after');
      assert.equal(updated.enabled, false);
      const events = store.activity.query({ eventType: 'session_rule.updated' });
      assert.equal(events.length, 1);
    });

    it('rejects empty content on update', () => {
      const created = store.sessionRules.create({ content: 'keep' });
      assert.throws(() => store.sessionRules.update(created.id, { content: '  ' }), /cannot be empty/);
    });

    it('throws NOT_FOUND on update/delete of a missing rule', () => {
      assert.throws(() => store.sessionRules.update(99999, { enabled: false }), /not found/);
      assert.throws(() => store.sessionRules.delete(99999), /not found/);
    });

    it('deletes a rule and logs an event', () => {
      const created = store.sessionRules.create({ content: 'goner' });
      store.sessionRules.delete(created.id);
      assert.equal(store.sessionRules.get(created.id), null);
      const events = store.activity.query({ eventType: 'session_rule.deleted' });
      assert.equal(events.length, 1);
    });
  });

  describe('cascade delete', () => {
    it('removes a project rule when its project is deleted', () => {
      const pid = mkProject('doomed');
      store.sessionRules.create({ content: 'doomed rule', projectId: pid });
      store.sessionRules.create({ content: 'survivor (global)' });

      store.projects.delete(pid);

      const remaining = store.sessionRules.list().map((r) => r.content);
      assert.deepEqual(remaining, ['survivor (global)']);
    });
  });

  describe('kind discriminator (CC-6, #381)', () => {
    it('defaults a rule to kind=startup', () => {
      const rule = store.sessionRules.create({ content: 'no kind given' });
      assert.equal(rule.kind, 'startup');
    });

    it('honors an explicit valid kind', () => {
      const wrap = store.sessionRules.create({ content: 'wrap rule', kind: 'wrap' });
      const mode = store.sessionRules.create({ content: 'mode rule', kind: 'mode' });
      assert.equal(wrap.kind, 'wrap');
      assert.equal(mode.kind, 'mode');
    });

    it('rejects an unknown kind', () => {
      assert.throws(
        () => store.sessionRules.create({ content: 'bad', kind: 'bogus' }),
        /kind must be one of/
      );
    });

    it('exposes SESSION_RULE_KINDS', () => {
      assert.deepEqual(store.SESSION_RULE_KINDS, ['startup', 'wrap', 'mode']);
    });

    it('list filters by kind', () => {
      const pid = mkProject('proj-k');
      store.sessionRules.create({ content: 's', projectId: pid, kind: 'startup' });
      store.sessionRules.create({ content: 'w', projectId: pid, kind: 'wrap' });
      store.sessionRules.create({ content: 'm', projectId: pid, kind: 'mode' });

      assert.deepEqual(store.sessionRules.list({ projectId: pid, kind: 'wrap' }).map((r) => r.content), ['w']);
      assert.deepEqual(store.sessionRules.list({ projectId: pid, kind: 'mode' }).map((r) => r.content), ['m']);
      assert.equal(store.sessionRules.list({ projectId: pid }).length, 3);
    });

    it('listActiveForProject (launch injection) returns ONLY startup rules', () => {
      const pid = mkProject('proj-inject');
      store.sessionRules.create({ content: 'startup rule', projectId: pid, kind: 'startup' });
      store.sessionRules.create({ content: 'wrap rule', projectId: pid, kind: 'wrap' });
      store.sessionRules.create({ content: 'mode rule', projectId: pid, kind: 'mode' });
      store.sessionRules.create({ content: 'global startup', kind: 'startup' });
      store.sessionRules.create({ content: 'global wrap', kind: 'wrap' });

      const injected = store.sessionRules.listActiveForProject(pid).map((r) => r.content);
      assert.deepEqual(injected, ['startup rule', 'global startup']);
    });

    it('kind survives a version restore (immutable)', () => {
      const wrap = store.sessionRules.create({ content: 'v1', kind: 'wrap' });
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
    });

    it('findConflictCandidates scopes to the same kind when opts.kind given', () => {
      store.sessionRules.create({ content: 'commit before wrapping the session', kind: 'startup' });
      store.sessionRules.create({ content: 'commit before wrapping the session always', kind: 'wrap' });

      const sameKind = store.sessionRules.findConflictCandidates(
        'remember to commit before wrapping',
        null,
        { kind: 'wrap' }
      );
      assert.equal(sameKind.length, 1);
      assert.equal(sameKind[0].rule.kind, 'wrap');
    });
  });

  describe('op CHECK constraint (SR-3MW8)', () => {
    it('every writer op (create → update → restore → delete) satisfies the constraint', () => {
      // The whole safety guarantee: the four real writers must only ever emit
      // enum-valid ops. Drive all four through the API and confirm none throws
      // and the recorded history carries exactly the enum values.
      const rule = store.sessionRules.create({ content: 'v1' });          // op=create
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
      const rule = store.sessionRules.create({ content: 'guarded' });
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
        INSERT INTO session_rules (content) VALUES ('pre-CC-6 global rule');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      // init migrates a v19 DB all the way to the current schema (now v23 — the
      // kind backfill below is the v19→v20 step in that chain).
      const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(ver.version, 23);

      // The pre-existing row backfilled to kind='startup'…
      const rules = store.sessionRules.list();
      assert.equal(rules.length, 1);
      assert.equal(rules[0].kind, 'startup');
      // …and still injects (no launch-injection regression).
      const injected = store.sessionRules.listActiveForProject(null).map((r) => r.content);
      assert.deepEqual(injected, ['pre-CC-6 global rule']);
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
      // Schema advanced to current (the v22→v23 rebuild is the last step).
      const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(ver.version, 23);

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
});
