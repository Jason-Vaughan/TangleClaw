'use strict';

/**
 * #569 — the self-improvement loop.
 *
 * Two halves, each previously broken in a different way. Learnings were written
 * at `tier:'provisional'` and nothing ever advanced them, so `## Active
 * Learnings` was empty on every project forever. And nothing ever turned a
 * learning into a rule — `promoteFromLearning` had one caller, an HTTP route no
 * UI invoked.
 *
 * The load-bearing property of the fix is that the loop can propose but not
 * apply. These tests pin that at every door into `status:'active'`, because a
 * gate on one entrance is not a gate.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const ruleProposal = require('../lib/wrap-steps/rule-proposal');

describe('self-improvement loop (#569)', () => {
  let tmpDir;
  let project;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-selfimprove-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const dir = path.join(tmpDir, `proj-${Math.floor(Math.random() * 1e9)}`);
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: path.basename(dir), path: dir, methodology: 'prawduct' });
  });

  describe('a proposal governs nothing until an operator approves it', () => {
    it('creates AI-authored rules as proposals, not active rules', () => {
      const rule = store.sessionRules.create({
        content: 'always run the linter', projectId: project.id, createdBy: 'ai'
      });
      assert.equal(rule.status, 'proposed');
    });

    it('REFUSES an AI request for an active rule — the request that must not be granted', () => {
      const rule = store.sessionRules.create({
        content: 'trust me', projectId: project.id, createdBy: 'ai', status: 'active'
      });
      assert.equal(rule.status, 'proposed', 'asking for active must not make it active');
    });

    it('still lets the operator create active rules directly (pre-#569 behavior)', () => {
      const rule = store.sessionRules.create({ content: 'operator rule', projectId: project.id });
      assert.equal(rule.status, 'active');
    });

    it('lets a human decision produce a live rule from AI-authored content', () => {
      // Authorship and authority are different things: the text is the AI's,
      // the decision is the operator's.
      const rule = store.sessionRules.create({
        content: 'operator approved this', projectId: project.id,
        createdBy: 'ai', status: 'active', approvedByOperator: true
      });
      assert.equal(rule.status, 'active');
      assert.equal(rule.createdBy, 'ai', 'provenance must survive the approval');
    });

    it('refuses to let an AI approve a proposal — the other door into active', () => {
      const rule = store.sessionRules.create({
        content: 'self approval attempt', projectId: project.id, createdBy: 'ai'
      });
      assert.throws(
        () => store.sessionRules.setStatus(rule.id, 'active', { changedBy: 'ai' }),
        (err) => err.code === 'FORBIDDEN'
      );
      assert.equal(store.sessionRules.get(rule.id).status, 'proposed');
    });

    it('lets the operator approve and reject, recording each as a version', () => {
      const rule = store.sessionRules.create({ content: 'a proposal', projectId: project.id, createdBy: 'ai' });
      const approved = store.sessionRules.setStatus(rule.id, 'active');
      assert.equal(approved.status, 'active');
      const rejected = store.sessionRules.setStatus(rule.id, 'rejected');
      assert.equal(rejected.status, 'rejected');
      const versions = store.sessionRules.listVersions(rule.id);
      assert.ok(versions.length >= 3, 'create + two decisions must all be snapshotted');
    });

    it('rejects an unknown status rather than storing it', () => {
      const rule = store.sessionRules.create({ content: 'x', projectId: project.id });
      assert.throws(() => store.sessionRules.setStatus(rule.id, 'maybe'), (e) => e.code === 'BAD_REQUEST');
    });
  });

  describe('no injection path can see a proposal', () => {
    it('keeps proposed startup rules out of the launch prime', () => {
      store.sessionRules.create({ content: 'proposed startup', projectId: project.id, createdBy: 'ai' });
      store.sessionRules.create({ content: 'real startup', projectId: project.id });
      const injected = store.sessionRules.listActiveForProject(project.id).map((r) => r.content);
      assert.deepEqual(injected, ['real startup']);
    });

    it('keeps proposed wrap rules out of the wrap prompts', () => {
      // The wrap taking instruction from a rule it proposed moments earlier is
      // the loop closing on itself with no human in it.
      store.sessionRules.create({ content: 'proposed wrap', projectId: project.id, createdBy: 'ai', kind: 'wrap' });
      store.sessionRules.create({ content: 'real wrap', projectId: project.id, kind: 'wrap' });
      const aiContent = require('../lib/wrap-steps/ai-content');
      const injected = aiContent._internal.listWrapRules(project.id).map((r) => r.content);
      assert.deepEqual(injected, ['real wrap']);
    });

    it('keeps proposed master rules out of the master identity', () => {
      store.sessionRules.create({ content: 'proposed master', createdBy: 'ai', kind: 'master' });
      const injected = store.sessionRules.listActiveForMaster().map((r) => r.content);
      assert.ok(!injected.includes('proposed master'));
    });

    it('drops a rule out of injection the moment it is rejected', () => {
      const rule = store.sessionRules.create({ content: 'was fine', projectId: project.id });
      assert.equal(store.sessionRules.listActiveForProject(project.id).length, 1);
      store.sessionRules.setStatus(rule.id, 'rejected');
      assert.equal(store.sessionRules.listActiveForProject(project.id).length, 0);
    });
  });

  describe('the v26→v27 migration', () => {
    const { DatabaseSync } = require('node:sqlite');

    /**
     * Seed a pre-v27 database and run it through `store.init()`.
     * @param {string} seedSql - Rows to insert into the pre-v27 session_rules
     * @returns {{dir: string, db: object, s: object}} Migrated handle
     */
    function migrateFrom(seedSql) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v27-'));
      const dbPath = path.join(dir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (26);
        CREATE TABLE session_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, content TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL DEFAULT 'operator',
          kind TEXT NOT NULL DEFAULT 'startup', owner TEXT, source_learning_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        ${seedSql}
      `);
      seed.close();

      delete require.cache[require.resolve('../lib/store')];
      const s = require('../lib/store');
      s._setBasePath(dir);
      s.init();
      return { dir, db: s.getDb(), s };
    }

    /**
     * Release a migrated handle and restore the suite's shared store module.
     * @param {object} h - Handle from `migrateFrom`
     */
    function done(h) {
      h.s.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
      delete require.cache[require.resolve('../lib/store')];
      require('../lib/store')._setBasePath(tmpDir);
    }

    it('backfills every pre-existing row to active — they already governed sessions', () => {
      const h = migrateFrom(`
        INSERT INTO session_rules (project_id, content, enabled, created_by, kind)
          VALUES (NULL, 'legacy master', 1, 'operator', 'master');
        INSERT INTO session_rules (project_id, content, enabled, created_by, kind)
          VALUES (NULL, 'legacy disabled', 0, 'ai', 'wrap');
      `);
      try {
        const rows = h.db.prepare('SELECT content, enabled, status FROM session_rules ORDER BY id').all();
        assert.deepEqual(rows.map((r) => r.status), ['active', 'active'],
          'back-dating live rules into review would silently switch them off on upgrade');
        assert.deepEqual(rows.map((r) => r.enabled), [1, 0], 'enabled must survive untouched');
      } finally { done(h); }
    });

    it('preserves a row whose foreign key is already orphaned', () => {
      // A migration preserves what it finds. Re-inserting under FK enforcement
      // would abort on such a row, so a pre-existing orphan would block the
      // upgrade instead of surviving it.
      const h = migrateFrom(
        "INSERT INTO session_rules (project_id, content) VALUES (424242, 'orphaned rule');");
      try {
        const row = h.db.prepare('SELECT content, project_id, status FROM session_rules').get();
        assert.equal(row.content, 'orphaned rule');
        assert.equal(row.project_id, 424242);
        assert.equal(row.status, 'active');
        assert.equal(
          h.db.prepare('SELECT MAX(version) v FROM schema_version').get().v, 27,
          'the upgrade must complete, not stall on the orphan');
      } finally { done(h); }
    });

    it('leaves foreign-key enforcement ON afterwards', () => {
      // The rebuild turns it off; leaving it off would silently disable FK
      // checking for the rest of the process's life.
      const h = migrateFrom("INSERT INTO session_rules (project_id, content) VALUES (NULL, 'x');");
      try {
        assert.equal(h.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      } finally { done(h); }
    });

    it('produces a status CHECK that actually rejects an invalid value', () => {
      const h = migrateFrom("INSERT INTO session_rules (project_id, content) VALUES (NULL, 'y');");
      try {
        assert.throws(() => h.db
          .prepare("INSERT INTO session_rules (content, status) VALUES ('bad', 'nonsense')").run());
      } finally { done(h); }
    });
  });

  describe('recurrence advances a learning into future sessions', () => {
    const dbWrite = require('../lib/wrap-steps/learnings-db-write');

    /**
     * Write learnings.md for the current project and run the mirror step.
     * @param {string} body - Full markdown content
     * @param {string} today - Date the step should treat as today
     * @returns {Promise<object>} Step result
     */
    async function mirror(body, today) {
      const file = path.join(project.path, '.tangleclaw', 'memories', 'learnings.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      const original = dbWrite._internal.todayIso;
      dbWrite._internal.todayIso = () => today;
      try {
        return await dbWrite.run({ project });
      } finally {
        dbWrite._internal.todayIso = original;
      }
    }

    it('recognises the same learning on a later day, despite the dated heading', async () => {
      // The stored text begins with its own `## YYYY-MM-DD` heading, so the raw
      // content of a repeat never matches its earlier self. Without a
      // date-independent key nothing would ever recur and nothing would advance.
      const first = await mirror('## 2026-01-01 — Cache invalidation bites\n\nIt bit again.\n', '2026-01-01');
      assert.equal(first.output.inserted, 1);
      const rows = store.learnings.list(project.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tier, 'provisional');

      const second = await mirror(
        '## 2026-01-01 — Cache invalidation bites\n\nIt bit again.\n\n'
        + '## 2026-02-09 — Cache invalidation bites\n\nIt bit again.\n', '2026-02-09');
      assert.equal(second.output.confirmed, 1, 'the repeat must be recognised');
      assert.equal(second.output.inserted, 0, 'and must not create a near-duplicate row');
      assert.equal(store.learnings.list(project.id).length, 1);
    });

    it('promotes provisional → active on the second sighting, reaching the next prime', async () => {
      await mirror('## 2026-03-01 — Flaky under load\n\nRetry masks it.\n', '2026-03-01');
      assert.equal(store.learnings.getActive(project.id).length, 0);

      const second = await mirror(
        '## 2026-03-01 — Flaky under load\n\nRetry masks it.\n\n'
        + '## 2026-03-08 — Flaky under load\n\nRetry masks it.\n', '2026-03-08');
      assert.equal(second.output.promoted, 1);
      const active = store.learnings.getActive(project.id);
      assert.equal(active.length, 1, 'an advanced learning must now reach ## Active Learnings');
    });

    it('still refuses to double-insert on a same-day wrap retry', async () => {
      const body = '## 2026-04-01 — Retry guard\n\nSame day twice.\n';
      await mirror(body, '2026-04-01');
      const retry = await mirror(body, '2026-04-01');
      assert.equal(retry.status, 'skipped');
      assert.equal(store.learnings.list(project.id).length, 1);
    });

    it('treats a genuinely different learning as new, not a recurrence', async () => {
      await mirror('## 2026-05-01 — Thing one\n\nBody one.\n', '2026-05-01');
      const next = await mirror(
        '## 2026-05-01 — Thing one\n\nBody one.\n\n'
        + '## 2026-05-02 — Thing two\n\nBody two.\n', '2026-05-02');
      assert.equal(next.output.inserted, 1);
      assert.equal(next.output.confirmed, 0);
      assert.equal(store.learnings.list(project.id).length, 2);
    });

    it('accrues confirmations to the OLDEST matching row, not the newest', async () => {
      // Without an explicit sort this is silently wrong: `learnings.list`
      // returns newest-first, so a first-wins map keeps the newest row and
      // confirmations scatter instead of accumulating on one canonical
      // learning. Two rows must share a recurrence key for the choice to be
      // observable at all — nothing else in the suite creates that state.
      const older = store.learnings.create({
        projectId: project.id, content: '## 2026-07-01 — Dupe subject\n\nShared body.'
      });
      const newer = store.learnings.create({
        projectId: project.id, content: '## 2026-07-02 — Dupe subject\n\nShared body.'
      });
      assert.ok(newer.id > older.id, 'precondition: the second row is the newer one');

      // Force distinct timestamps. Both rows are created in the same second, so
      // created_at ties and the newest-first query happens to return them in id
      // order — under which an unsorted map picks the oldest by luck and this
      // test cannot see the difference. Verified by reverting the sort: without
      // these two lines it passes either way.
      store.getDb().prepare('UPDATE learnings SET created_at = ? WHERE id = ?')
        .run('2026-07-01 00:00:00', older.id);
      store.getDb().prepare('UPDATE learnings SET created_at = ? WHERE id = ?')
        .run('2026-07-02 00:00:00', newer.id);

      await mirror('## 2026-07-03 — Dupe subject\n\nShared body.\n', '2026-07-03');

      const rows = store.learnings.list(project.id);
      const oldRow = rows.find((r) => r.id === older.id);
      const newRow = rows.find((r) => r.id === newer.id);
      assert.equal(oldRow.confirmedCount, 1, 'the oldest row must take the confirmation');
      assert.equal(newRow.confirmedCount, 0, 'the newer duplicate must be left alone');
    });

    it('matches across incidental whitespace and case, which is all normalization claims', async () => {
      await mirror('## 2026-06-01 — Normalize me\n\nSome   body text.\n', '2026-06-01');
      const next = await mirror(
        '## 2026-06-01 — Normalize me\n\nSome   body text.\n\n'
        + '## 2026-06-02 — normalize ME\n\nSome body   text.\n', '2026-06-02');
      assert.equal(next.output.confirmed, 1);
    });
  });

  describe('conflict candidates only compare against governing rules', () => {
    it('ignores proposals and rejections', () => {
      // Existing suites seed only operator-authored rules, which resolve to
      // active, so they stay green with the status filter removed. A proposal
      // has to exist for this to test anything.
      store.sessionRules.create({ content: 'migrations require postgres schema validation', projectId: project.id });
      store.sessionRules.create({
        content: 'migrations require postgres schema rollback', projectId: project.id, createdBy: 'ai'
      });
      const rejected = store.sessionRules.create({
        content: 'migrations require postgres schema snapshots', projectId: project.id, createdBy: 'ai'
      });
      store.sessionRules.setStatus(rejected.id, 'rejected');

      const candidates = store.sessionRules
        .findConflictCandidates('migrations require postgres schema review', project.id);
      const contents = candidates.map((c) => c.rule.content);
      assert.deepEqual(contents, ['migrations require postgres schema validation'],
        'an unreviewed proposal and a declined rule are not things to reconcile against');
    });
  });

  describe('the wrap proposal step', () => {
    it('proposes one rule per active learning, all at status proposed', async () => {
      const a = store.learnings.create({ projectId: project.id, content: 'lesson A', tier: 'active' });
      const b = store.learnings.create({ projectId: project.id, content: 'lesson B', tier: 'active' });
      const res = await ruleProposal.run({ project });
      assert.equal(res.status, 'done');
      assert.equal(res.output.count, 2);
      for (const p of res.output.proposed) assert.equal(p.status, 'proposed');
      const sources = res.output.proposed.map((p) => p.learningId).sort();
      assert.deepEqual(sources, [a.id, b.id].sort());
    });

    it('carries provenance, so every proposal traces to the learning behind it', async () => {
      const l = store.learnings.create({ projectId: project.id, content: 'traceable', tier: 'active' });
      const res = await ruleProposal.run({ project });
      const rule = store.sessionRules.get(res.output.proposed[0].ruleId);
      assert.equal(rule.sourceLearningId, l.id);
    });

    it('will not propose from a provisional learning — recurrence is the bar', async () => {
      store.learnings.create({ projectId: project.id, content: 'seen once', tier: 'provisional' });
      const res = await ruleProposal.run({ project });
      assert.equal(res.status, 'skipped');
      assert.match(res.output.reason, /no active learnings/);
    });

    it('never re-proposes a learning the operator already rejected', async () => {
      // The whole reason a rejection is recorded instead of deleted.
      store.learnings.create({ projectId: project.id, content: 'recurring', tier: 'active' });
      const first = await ruleProposal.run({ project });
      store.sessionRules.setStatus(first.output.proposed[0].ruleId, 'rejected');
      const second = await ruleProposal.run({ project });
      assert.equal(second.status, 'skipped');
      assert.match(second.output.reason, /already have a rule or a decision/);
    });

    it('is idempotent across repeated wraps', async () => {
      store.learnings.create({ projectId: project.id, content: 'once only', tier: 'active' });
      await ruleProposal.run({ project });
      const again = await ruleProposal.run({ project });
      assert.equal(again.status, 'skipped');
      assert.equal(store.sessionRules.list({ projectId: project.id }).length, 1);
    });

    it('skips rather than blocks when there is nothing to work with', async () => {
      const res = await ruleProposal.run({ project });
      assert.equal(res.ok, true, 'a wrap must not fail because rule proposal had nothing to do');
      assert.equal(res.status, 'skipped');
    });
  });

  describe('the provisional backlog is visible, not silent (#569 proposal 3)', () => {
    // Proposals only come from ACTIVE learnings, so without the backlog count a
    // young-but-healthy loop ("3 learnings one recurrence away") reads exactly
    // like a dead one ("no learnings at all"). Each exit path must carry it.

    it('a skip for no active learnings names how many provisional ones are building recurrence', async () => {
      store.learnings.create({ projectId: project.id, content: 'seen once', tier: 'provisional' });
      store.learnings.create({ projectId: project.id, content: 'also once', tier: 'provisional' });
      const res = await ruleProposal.run({ project });
      assert.equal(res.status, 'skipped');
      assert.match(res.output.reason, /2 provisional learnings building recurrence/);
    });

    it('a skip with a genuinely empty backlog does not claim one', async () => {
      const res = await ruleProposal.run({ project });
      assert.equal(res.status, 'skipped');
      assert.doesNotMatch(res.output.reason, /provisional/);
    });

    it('an all-decided skip still reports the backlog', async () => {
      store.learnings.create({ projectId: project.id, content: 'recurring', tier: 'active' });
      store.learnings.create({ projectId: project.id, content: 'young', tier: 'provisional' });
      await ruleProposal.run({ project });
      const again = await ruleProposal.run({ project });
      assert.equal(again.status, 'skipped');
      assert.match(again.output.reason, /already have a rule or a decision/);
      assert.match(again.output.reason, /1 provisional learning building recurrence/);
    });

    it('a done result carries the count as structured output for the drawer', async () => {
      store.learnings.create({ projectId: project.id, content: 'recurring', tier: 'active' });
      store.learnings.create({ projectId: project.id, content: 'young A', tier: 'provisional' });
      store.learnings.create({ projectId: project.id, content: 'young B', tier: 'provisional' });
      store.learnings.create({ projectId: project.id, content: 'young C', tier: 'provisional' });
      const res = await ruleProposal.run({ project });
      assert.equal(res.status, 'done');
      assert.deepEqual(res.output.backlog, { provisional: 3 });
    });
  });
});
