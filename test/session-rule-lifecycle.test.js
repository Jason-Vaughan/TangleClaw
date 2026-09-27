'use strict';

/**
 * #1696 / #1709 — a rule's lifecycle past approval.
 *
 * Two defects, one mechanism. Approving a rule written to replace another left
 * the old one governing beside it, because `replacesRuleId` was silently
 * dropped (#1696). And the only way to take a dead rule out of force was to
 * switch it off, which reads as "resting, re-enableable" when re-enabling it is
 * a regression (#1709). A rule now has a place to die: status 'retired', never
 * delivered, reachable only from 'active', and a replacement's approval puts
 * the rule it replaces there in the same transaction.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('session rule lifecycle (#1696, #1709)', () => {
  let tmpDir;
  let project;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rule-lifecycle-'));
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
    project = store.projects.create({ name: path.basename(dir), path: dir });
  });

  /**
   * @param {string} content - Rule text
   * @param {object} [extra] - Further create fields
   * @returns {object} An operator-created, active startup rule
   */
  function activeRule(content, extra = {}) {
    return store.sessionRules.create({ content, projectId: project.id, ...extra });
  }

  /**
   * @param {string} content - Rule text
   * @param {object} [extra] - Further create fields
   * @returns {object} An AI-authored proposal
   */
  function proposal(content, extra = {}) {
    return store.sessionRules.create({ content, projectId: project.id, createdBy: 'ai', ...extra });
  }

  /**
   * @returns {string[]} The content of every rule this project would deliver at launch
   */
  function delivered() {
    return store.sessionRules.listActiveForProject(project.id).map((r) => r.content);
  }

  /**
   * @param {string} code - Expected StoreError code
   * @returns {Function} An assert.throws matcher
   */
  const code = (c) => (err) => err.code === c;

  describe('retiring a rule', () => {
    it('retires an active rule, which then is never delivered', () => {
      const rule = activeRule('dead path rule');
      const retired = store.sessionRules.setStatus(rule.id, 'retired');
      assert.equal(retired.status, 'retired');
      assert.ok(retired.retiredAt, 'when it was retired is recorded');
      assert.equal(retired.supersededBy, null, 'a rule retired by hand has no successor');
      assert.ok(!delivered().includes('dead path rule'));
    });

    it('retires a rule that was switched off, leaving its switch as it was', () => {
      const rule = activeRule('resting then dead');
      store.sessionRules.update(rule.id, { enabled: false });
      const retired = store.sessionRules.setStatus(rule.id, 'retired');
      assert.equal(retired.status, 'retired');
      assert.equal(retired.enabled, false);
    });

    for (const from of ['proposed', 'rejected']) {
      it(`REFUSES to retire a ${from} rule — a rule that never governed cannot die`, () => {
        const rule = proposal(`never born ${from}`);
        if (from === 'rejected') store.sessionRules.setStatus(rule.id, 'rejected');
        assert.throws(() => store.sessionRules.setStatus(rule.id, 'retired'), code('INVALID_TRANSITION'));
        assert.equal(store.sessionRules.get(rule.id).status, from);
      });
    }

    it('refuses to retire a rule that is already retired', () => {
      const rule = activeRule('twice');
      store.sessionRules.setStatus(rule.id, 'retired');
      assert.throws(() => store.sessionRules.setStatus(rule.id, 'retired'), code('INVALID_TRANSITION'));
    });

    it('refuses an invalid criticGate before changing anything', () => {
      const rule = activeRule('gate checked first');
      assert.throws(() => store.sessionRules.setStatus(rule.id, 'retired', { criticGate: 'bogus' }));
      assert.equal(store.sessionRules.get(rule.id).status, 'active');
    });

    it('refuses to create a rule already retired', () => {
      assert.throws(() => activeRule('born dead', { status: 'retired' }), code('INVALID_TRANSITION'));
    });

    it('records the retirement in the rule history and the activity log', () => {
      const rule = activeRule('audited retirement');
      const before = store.sessionRules.listVersions(rule.id).length;
      store.sessionRules.setStatus(rule.id, 'retired');
      assert.equal(store.sessionRules.listVersions(rule.id).length, before + 1);
      const events = store.activity.query({ projectId: project.id, eventType: 'session_rule.retired' });
      assert.equal(events.length, 1);
    });
  });

  describe('a retired rule reaches no reader that delivers rules', () => {
    it('is absent from the launch, wrap, Master and conflict readers', () => {
      const startup = activeRule('retired startup rule about linting');
      const wrap = activeRule('retired wrap rule about linting', { kind: 'wrap' });
      const master = store.sessionRules.create({ content: 'retired master rule', kind: 'master' });
      try {
        for (const r of [startup, wrap, master]) store.sessionRules.setStatus(r.id, 'retired');
        assert.ok(!delivered().includes('retired startup rule about linting'));
        const wrapRules = store.sessionRules.list({ projectId: project.id, enabled: 1, status: 'active', kind: 'wrap' });
        assert.ok(!wrapRules.some((r) => r.id === wrap.id), 'the wrap prompt reads active rules only');
        assert.ok(!store.sessionRules.listActiveForMaster().some((r) => r.id === master.id));
        const candidates = store.sessionRules.findConflictCandidates('retired startup rule about linting', project.id);
        assert.ok(!candidates.some((c) => c.rule.id === startup.id), 'a dead rule cannot conflict with anything');
      } finally {
        store.sessionRules.delete(master.id);
      }
    });

    it('does not count toward the undelivered-rules alarm', () => {
      const rule = activeRule('only rule, then retired');
      const flagged = () => store.sessionRuleDeliveries.projectsWithUndeliveredRules()
        .some((p) => p.projectId === project.id);
      assert.ok(flagged(), 'an active enabled rule with no delivery on record is flagged');
      store.sessionRules.setStatus(rule.id, 'retired');
      assert.ok(!flagged(), 'a retired rule is not waiting to be delivered');
    });

    it('does not count a proposal toward the undelivered-rules alarm either', () => {
      proposal('awaiting approval, not delivery');
      assert.ok(!store.sessionRuleDeliveries.projectsWithUndeliveredRules().some((p) => p.projectId === project.id));
    });
  });

  describe('restoring a retired rule', () => {
    it('brings it back active but DISABLED, so one click never makes it govern', () => {
      const rule = activeRule('back from the dead');
      store.sessionRules.setStatus(rule.id, 'retired');
      const restored = store.sessionRules.setStatus(rule.id, 'active');
      assert.equal(restored.status, 'active');
      assert.equal(restored.enabled, false);
      assert.equal(restored.retiredAt, null);
      assert.ok(!delivered().includes('back from the dead'), 'disabled until the operator switches it on');
      assert.equal(store.activity.query({ projectId: project.id, eventType: 'session_rule.unretired' }).length, 1,
        'distinct from session_rule.restored, which is a version rollback');
      store.sessionRules.update(rule.id, { enabled: true });
      assert.ok(delivered().includes('back from the dead'));
    });

    it('needs no expectedContent — a restore cannot make text govern', () => {
      const rule = activeRule('restore without text');
      store.sessionRules.setStatus(rule.id, 'retired');
      assert.equal(store.sessionRules.setStatus(rule.id, 'active').status, 'active');
    });

    for (const to of ['proposed', 'rejected']) {
      it(`refuses to move a retired rule to ${to}`, () => {
        const rule = activeRule(`retired then ${to}`);
        store.sessionRules.setStatus(rule.id, 'retired');
        assert.throws(() => store.sessionRules.setStatus(rule.id, to), code('INVALID_TRANSITION'));
        assert.equal(store.sessionRules.get(rule.id).status, 'retired');
      });
    }

    it('still refuses an AI approval into active, restore included', () => {
      const rule = activeRule('ai restore attempt');
      store.sessionRules.setStatus(rule.id, 'retired');
      assert.throws(() => store.sessionRules.setStatus(rule.id, 'active', { changedBy: 'ai' }), code('FORBIDDEN'));
    });
  });

  describe('the transitions that existed before stay as they were', () => {
    it('a proposal can be rejected, and a rejection approved with its text', () => {
      const rule = proposal('reconsidered');
      store.sessionRules.setStatus(rule.id, 'rejected');
      const approved = store.sessionRules.setStatus(rule.id, 'active', { expectedContent: 'reconsidered' });
      assert.equal(approved.status, 'active');
    });

    it('an active rule can still be set back to proposed or rejected', () => {
      const a = activeRule('demoted by status');
      assert.equal(store.sessionRules.setStatus(a.id, 'proposed').status, 'proposed');
      const b = activeRule('rejected after the fact');
      assert.equal(store.sessionRules.setStatus(b.id, 'rejected').status, 'rejected');
    });
  });

  describe('a replacement retires what it replaces (#1696)', () => {
    it('approving the replacement retires the old rule, so only the new one is delivered', () => {
      const old = activeRule('live checkout is /Projects/TangleClaw-Builder');
      const next = proposal('live checkout is /Projects/TangleClaw-Builder1', { replacesRuleId: old.id });
      assert.equal(next.replacesRuleId, old.id);

      const approved = store.sessionRules.setStatus(next.id, 'active',
        { expectedContent: 'live checkout is /Projects/TangleClaw-Builder1' });

      assert.deepEqual(approved.replaced, { id: old.id });
      assert.equal(approved.replacementSkipped, undefined);
      const oldNow = store.sessionRules.get(old.id);
      assert.equal(oldNow.status, 'retired');
      assert.equal(oldNow.supersededBy, next.id, 'the Graveyard can say what replaced it');
      assert.deepEqual(delivered(), ['live checkout is /Projects/TangleClaw-Builder1']);
    });

    it('a refused approval retires nothing — the two writes are one', () => {
      const old = activeRule('the original');
      const next = proposal('the amendment', { replacesRuleId: old.id });
      store.sessionRules.update(next.id, { content: 'an amendment nobody was shown' });
      assert.throws(
        () => store.sessionRules.setStatus(next.id, 'active', { expectedContent: 'the amendment' }),
        code('CONTENT_CHANGED')
      );
      assert.equal(store.sessionRules.get(old.id).status, 'active', 'the original must keep governing');
      assert.equal(store.sessionRules.get(next.id).status, 'proposed');
    });

    it('approves anyway when the old rule was retired meanwhile, and says so', () => {
      const old = activeRule('already gone');
      const next = proposal('its replacement', { replacesRuleId: old.id });
      store.sessionRules.setStatus(old.id, 'retired');
      const approved = store.sessionRules.setStatus(next.id, 'active', { expectedContent: 'its replacement' });
      assert.equal(approved.status, 'active', 'the operator’s intent already holds, so the approval stands');
      assert.equal(approved.replaced, null, 'Architect ruling: replaced is null, not a refusal');
      assert.equal(approved.replacementSkipped.id, old.id, 'the named rule is still reported');
      assert.match(approved.replacementSkipped.reason, /already retired/);
      assert.equal(store.sessionRules.get(old.id).supersededBy, null, 'its retirement is not rewritten');
    });

    it('approves anyway when the old rule was deleted meanwhile, and says so', () => {
      const old = activeRule('deleted before approval');
      const next = proposal('outlives it', { replacesRuleId: old.id });
      store.sessionRules.delete(old.id);
      const approved = store.sessionRules.setStatus(next.id, 'active', { expectedContent: 'outlives it' });
      assert.equal(approved.status, 'active');
      assert.equal(approved.replaced, null);
      assert.match(approved.replacementSkipped.reason, /no longer exists/);
    });

    it('keeps the outcome in the audit trail as well as the result', () => {
      const old = activeRule('audited original');
      const next = proposal('audited amendment', { replacesRuleId: old.id });
      store.sessionRules.setStatus(old.id, 'retired');
      store.sessionRules.setStatus(next.id, 'active', { expectedContent: 'audited amendment' });
      const approvals = store.activity.query({ projectId: project.id, eventType: 'session_rule.updated' })
        .map((e) => (typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail))
        .filter((d) => d && d.id === next.id && d.to === 'active');
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].replaced, null);
      assert.match(approvals[0].replacementSkipped.reason, /already retired/);
    });

    it('re-approving a replacement that already governs retires nothing further', () => {
      const old = activeRule('first original');
      const next = proposal('first amendment', { replacesRuleId: old.id });
      store.sessionRules.setStatus(next.id, 'active', { expectedContent: 'first amendment' });
      store.sessionRules.setStatus(old.id, 'active'); // restore the original, disabled
      const again = store.sessionRules.setStatus(next.id, 'active', { expectedContent: 'first amendment' });
      assert.equal(again.replaced, undefined);
      assert.equal(store.sessionRules.get(old.id).status, 'active', 'the restored original is left alone');
    });

    it('a replacement the operator creates already live retires the old rule at once', () => {
      const old = activeRule('operator original');
      const next = activeRule('operator amendment', { replacesRuleId: old.id });
      assert.equal(next.status, 'active');
      assert.equal(store.sessionRules.get(old.id).status, 'retired');
      assert.equal(store.sessionRules.get(old.id).supersededBy, next.id);
      assert.deepEqual(delivered(), ['operator amendment']);
    });

    it('a replacement proposal leaves the old rule governing until it is approved', () => {
      const old = activeRule('still in force');
      proposal('waiting for approval', { replacesRuleId: old.id });
      assert.equal(store.sessionRules.get(old.id).status, 'active');
      assert.deepEqual(delivered(), ['still in force']);
    });
  });

  describe('replacesRuleId is honoured or refused, never ignored', () => {
    it('refuses a rule that does not exist', () => {
      assert.throws(() => proposal('replaces nothing', { replacesRuleId: 99999999 }), code('INVALID_REPLACES'));
    });

    it('refuses a non-integer id', () => {
      const old = activeRule('numeric target');
      assert.throws(() => proposal('by string', { replacesRuleId: String(old.id) }), code('INVALID_REPLACES'));
      assert.throws(() => proposal('by float', { replacesRuleId: old.id + 0.5 }), code('INVALID_REPLACES'));
    });

    it('refuses a rule of another kind', () => {
      const old = activeRule('a wrap rule', { kind: 'wrap' });
      assert.throws(() => proposal('a startup replacement', { replacesRuleId: old.id }), code('INVALID_REPLACES'));
    });

    it('refuses a rule of another project', () => {
      const old = activeRule('this project’s rule');
      const otherDir = path.join(tmpDir, `other-${Math.floor(Math.random() * 1e9)}`);
      fs.mkdirSync(otherDir, { recursive: true });
      const other = store.projects.create({ name: path.basename(otherDir), path: otherDir });
      assert.throws(
        () => store.sessionRules.create({ content: 'cross-project', projectId: other.id, createdBy: 'ai', replacesRuleId: old.id }),
        code('INVALID_REPLACES')
      );
    });

    it('refuses a rule that is not in force', () => {
      const pending = proposal('only proposed');
      assert.throws(() => proposal('replaces a proposal', { replacesRuleId: pending.id }), code('INVALID_REPLACES'));
      const dead = activeRule('retired target');
      store.sessionRules.setStatus(dead.id, 'retired');
      assert.throws(() => proposal('replaces the dead', { replacesRuleId: dead.id }), code('INVALID_REPLACES'));
    });

    it('refuses a master rule — master rules keep their own baseline lifecycle', () => {
      const master = store.sessionRules.create({ content: 'a hard rule', kind: 'master' });
      try {
        assert.throws(
          () => store.sessionRules.create({ content: 'another', kind: 'master', replacesRuleId: master.id }),
          code('INVALID_REPLACES')
        );
      } finally {
        store.sessionRules.delete(master.id);
      }
    });

    it('creates nothing when it refuses', () => {
      const before = store.sessionRules.list({ projectId: project.id }).length;
      assert.throws(() => proposal('refused', { replacesRuleId: 99999999 }));
      assert.equal(store.sessionRules.list({ projectId: project.id }).length, before);
    });

    it('cannot be changed after creation — an approval must retire the rule it was shown', () => {
      const a = activeRule('target a');
      const b = activeRule('target b');
      const next = proposal('replaces a', { replacesRuleId: a.id });
      assert.throws(() => store.sessionRules.update(next.id, { replacesRuleId: b.id }), code('BAD_REQUEST'));
      assert.equal(store.sessionRules.get(next.id).replacesRuleId, a.id);
    });
  });

  describe('the v50→v51 migration', () => {
    /**
     * Take a fresh store back to a v50 install holding the given rows, then
     * upgrade it.
     * @param {string} rowsSql - INSERTs into the v50-shape session_rules
     * @returns {{dir: string, s: object, db: object}} The upgraded store
     */
    function upgradeFromV50(rowsSql) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v51-'));
      delete require.cache[require.resolve('../lib/store')];
      const fresh = require('../lib/store');
      fresh._setBasePath(dir);
      fresh.init();
      fresh.close();

      const raw = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
      raw.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE session_rules;
        CREATE TABLE session_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL DEFAULT 'operator',
          kind TEXT NOT NULL DEFAULT 'startup',
          owner TEXT,
          source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','rejected')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        ${rowsSql}
        DELETE FROM schema_version WHERE version >= 51;
        INSERT INTO schema_version (version) VALUES (50);
      `);
      raw.close();

      const s = require('../lib/store');
      s._setBasePath(dir);
      s.init();
      return { dir, s, db: s.getDb() };
    }

    /**
     * @param {object} h - Handle from upgradeFromV50
     */
    function done(h) {
      h.s.close();
      fs.rmSync(h.dir, { recursive: true, force: true });
      delete require.cache[require.resolve('../lib/store')];
      require('../lib/store')._setBasePath(tmpDir);
    }

    it('keeps every row verbatim, including disabled rules, and starts the new columns empty', () => {
      const h = upgradeFromV50(`
        INSERT INTO session_rules (id, project_id, content, enabled, created_by, kind, status, created_at)
          VALUES (6, 424242, 'dead path, switched off by hand', 0, 'operator', 'startup', 'active', '2026-09-20 12:58:18');
        INSERT INTO session_rules (id, project_id, content, enabled, created_by, kind, status)
          VALUES (9, 424242, 'a proposal', 1, 'ai', 'wrap', 'proposed');
        INSERT INTO session_rules (id, project_id, content, enabled, created_by, kind, status)
          VALUES (12, 424242, 'a rejection', 1, 'ai', 'startup', 'rejected');
      `);
      try {
        const rows = h.db.prepare('SELECT * FROM session_rules ORDER BY id').all();
        assert.deepEqual(rows.map((r) => [r.id, r.content, r.enabled, r.status]), [
          [6, 'dead path, switched off by hand', 0, 'active'],
          [9, 'a proposal', 1, 'proposed'],
          [12, 'a rejection', 1, 'rejected']
        ], 'a migration must not guess which disabled rules are dead — that is the operator’s call');
        assert.equal(rows[0].created_at, '2026-09-20 12:58:18');
        for (const r of rows) {
          assert.equal(r.replaces_rule_id, null);
          assert.equal(r.superseded_by, null);
          assert.equal(r.retired_at, null);
        }
        assert.equal(h.db.prepare('SELECT MAX(version) v FROM schema_version').get().v, h.s.CURRENT_SCHEMA_VERSION);
      } finally { done(h); }
    });

    it('accepts retired and still rejects a nonsense status', () => {
      const h = upgradeFromV50("INSERT INTO session_rules (project_id, content) VALUES (NULL, 'x');");
      try {
        h.db.prepare("UPDATE session_rules SET status = 'retired'").run();
        assert.throws(() => h.db.prepare("UPDATE session_rules SET status = 'nonsense'").run());
      } finally { done(h); }
    });

    it('leaves foreign-key enforcement on and the lookup indexes in place', () => {
      const h = upgradeFromV50("INSERT INTO session_rules (project_id, content) VALUES (NULL, 'y');");
      try {
        assert.equal(h.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        const idx = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_rules'")
          .all().map((r) => r.name).sort();
        assert.deepEqual(idx, ['idx_session_rules_enabled', 'idx_session_rules_project', 'idx_session_rules_status']);
      } finally { done(h); }
    });

    it('leaves an upgraded store with exactly the table a fresh install gets', () => {
      // What keeps the migration's frozen DDL and the fresh-install DDL in step:
      // if either changes alone, the two stores stop matching and this fails.
      const shape = (db) => ({
        columns: db.prepare('PRAGMA table_info(session_rules)').all()
          .map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
        check: /CHECK\s*\(status IN \(([^)]*)\)\)/.exec(
          db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_rules'").get().sql)[1]
          .replace(/\s+/g, ''),
        indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_rules'")
          .all().map((r) => r.name).sort()
      });
      const freshShape = shape(store.getDb());
      const h = upgradeFromV50("INSERT INTO session_rules (project_id, content) VALUES (NULL, 'z');");
      try {
        assert.deepEqual(shape(h.db), freshShape);
      } finally { done(h); }
    });

    it('gives a fresh install the same table and indexes as an upgraded one', () => {
      const db = store.getDb();
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_rules'").get().sql;
      assert.match(sql, /'retired'/);
      const cols = db.prepare('PRAGMA table_info(session_rules)').all().map((c) => c.name);
      for (const c of ['replaces_rule_id', 'superseded_by', 'retired_at']) assert.ok(cols.includes(c), c);
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_rules'")
        .all().map((r) => r.name).sort();
      assert.deepEqual(idx, ['idx_session_rules_enabled', 'idx_session_rules_project', 'idx_session_rules_status']);
    });
  });
});
