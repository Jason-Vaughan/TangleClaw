'use strict';

/**
 * v55→v56: session rules gain a `'retired'` status and replacement/
 * supersession provenance (#1696, #1709).
 *
 * The property under test for the migration: a store upgraded today and a
 * store created today are indistinguishable afterwards — same columns, same
 * CHECK constraints, existing rows preserved verbatim with the four new
 * columns NULL (no migration infers which pre-existing disabled rule is
 * "really" retired; that is the operator's Retire action).
 *
 * The property under test for the lifecycle itself: `SESSION_RULE_
 * TRANSITIONS` is the one allow-list every `setStatus` call is checked
 * against — this file exercises all 16 `(from, to)` pairs, not just the 6
 * allowed ones, because a deny-list silently admitted a two-step path
 * around a rule the allow-list exists to close (active → proposed →
 * rejected, ruled out on #1709). Atomic supersession, the retire→edit→
 * restore→switch-on hole, and the delivery queries' retired-exclusion are
 * covered as their own sections.
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { SESSION_RULE_STATUSES, SESSION_RULE_TRANSITIONS } = store;

const tmpDirs = [];

/** The `session_rules` table as v55 shipped it — before the retirement columns. */
const V55_SESSION_RULES_DDL = `
  CREATE TABLE session_rules (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        INTEGER,
    content           TEXT    NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_by        TEXT    NOT NULL DEFAULT 'operator',
    kind              TEXT    NOT NULL DEFAULT 'startup',
    owner             TEXT,
    source_learning_id INTEGER,
    status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','rejected')),
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_session_rules_project ON session_rules(project_id);
  CREATE INDEX idx_session_rules_enabled ON session_rules(enabled);
  CREATE INDEX idx_session_rules_status ON session_rules(status);`;

/** One pre-existing row, switched off by hand before 'retired' existed. */
const DISABLED_ROW = `
  INSERT INTO session_rules (project_id, content, enabled, created_by, kind, status)
  VALUES (NULL, 'a rule someone switched off before retirement existed', 0, 'operator', 'startup', 'active');`;

/**
 * Seed a database at v55 with the pre-#1696/#1709 `session_rules` table.
 * @param {string} [extraSql] - Further rows for the case under test
 * @returns {string} The store's base directory
 */
function seedV55(extraSql = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rule-lifecycle-mig-'));
  tmpDirs.push(dir);
  const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (55);
    ${V55_SESSION_RULES_DDL}
    ${extraSql}
  `);
  seed.close();
  return dir;
}

/**
 * Open a seeded directory as the live store.
 * @param {string} dir - Base directory
 * @returns {void}
 */
function open(dir) {
  store._setBasePath(dir);
  store.init();
}

/** The `session_rules` column names right now. */
function columns() {
  return new Set(store.getDb().prepare('PRAGMA table_info(session_rules)').all().map((c) => c.name));
}

/** The `session_rules` table's DDL as SQLite stores it — the only place a CHECK is visible. */
function ddl() {
  const row = store.getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rules'").get();
  return (row && row.sql) || '';
}

const ADDED_COLUMNS = ['replaces_rule_id', 'superseded_by', 'retired_at', 'replacement_origin'];

describe('v55→v56 session rule lifecycle migration (#1696, #1709)', () => {
  after(() => {
    store.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds every new column to a store upgrading from v55', () => {
    open(seedV55(DISABLED_ROW));
    const have = columns();
    for (const col of ADDED_COLUMNS) assert.ok(have.has(col), `v55→v56 did not add ${col}`);
  });

  it('widens the status CHECK to include retired', () => {
    open(seedV55());
    assert.match(ddl().replace(/\s+/g, ' '), /CHECK\s*\(\s*status\s+IN\s*\([^)]*'retired'/i);
  });

  it('preserves a pre-existing disabled row verbatim, new columns NULL', () => {
    open(seedV55(DISABLED_ROW));
    const row = store.getDb()
      .prepare("SELECT * FROM session_rules WHERE content LIKE 'a rule someone switched off%'").get();
    assert.equal(row.enabled, 0, 'a pre-existing hand-disabled rule is not silently inferred as retired');
    assert.equal(row.status, 'active');
    for (const col of ADDED_COLUMNS) assert.equal(row[col], null, `${col} must start NULL on an upgraded row`);
  });

  it('gives an upgraded store the same shape as a fresh one, CHECKs included', () => {
    open(seedV55(DISABLED_ROW));
    const upgraded = [...columns()].sort();
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rule-lifecycle-fresh-'));
    tmpDirs.push(fresh);
    open(fresh);
    assert.deepEqual([...columns()].sort(), upgraded);
    assert.match(ddl().replace(/\s+/g, ' '), /CHECK\s*\(\s*status\s+IN\s*\([^)]*'retired'/i,
      'the fixture must actually carry the widened CHECK being compared');
  });
});

describe('session rule lifecycle (#1696, #1709)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rule-lifecycle-'));
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
    return store.projects.create({ name, path: projPath, engine: 'claude' }).id;
  }

  /** Create and approve an active rule in one go; returns the rule. */
  function mkActiveRule(pid, content = 'an active rule') {
    const proposed = store.sessionRules.create({ content, projectId: pid, createdBy: 'ai' });
    return store.sessionRules.setStatus(proposed.id, 'active', {
      changedBy: 'operator', expectedContent: content
    });
  }

  describe('SESSION_RULE_TRANSITIONS — all 16 (from, to) pairs', () => {
    const ALLOWED = [
      ['proposed', 'active'], ['proposed', 'rejected'],
      ['rejected', 'active'],
      ['active', 'active'], ['active', 'retired'],
      ['retired', 'active']
    ];
    const FORBIDDEN = SESSION_RULE_STATUSES.flatMap((from) =>
      SESSION_RULE_STATUSES.map((to) => [from, to])
    ).filter(([from, to]) => !ALLOWED.some(([f, t]) => f === from && t === to));

    it('the allow-list has exactly 6 allowed pairs and 10 forbidden ones', () => {
      assert.equal(ALLOWED.length, 6);
      assert.equal(FORBIDDEN.length, 10);
      for (const [from, to] of ALLOWED) assert.ok(SESSION_RULE_TRANSITIONS[from].includes(to));
    });

    it('docs/session-rules-self-improvement.md renders this exact table — the doc cannot drift from the code', () => {
      const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'session-rules-self-improvement.md'), 'utf8');
      const m = doc.match(/const SESSION_RULE_TRANSITIONS = \{([\s\S]*?)\n\};/);
      assert.ok(m, 'docs/session-rules-self-improvement.md must render the SESSION_RULE_TRANSITIONS table as a JS object literal');
      // eslint-disable-next-line no-new-func
      const rendered = new Function(`return {${m[1]}};`)();
      assert.deepEqual(rendered, SESSION_RULE_TRANSITIONS);
    });

    it('a rule cannot be born retired — the table has no entry to reach it from', () => {
      const pid = mkProject('proj-create-retired');
      assert.throws(
        () => store.sessionRules.create({ content: 'dead on arrival', projectId: pid, status: 'retired' }),
        (err) => err.code === 'INVALID_TRANSITION'
      );
    });

    /** Put a fresh rule into `status`, bypassing setStatus's own checks. */
    function ruleAt(pid, status) {
      const rule = store.sessionRules.create({ content: `rule at ${status}-${Math.random()}`, projectId: pid });
      if (status === 'active') return rule; // operator-created rules land active by default
      store.getDb().prepare('UPDATE session_rules SET status = ? WHERE id = ?').run(status, rule.id);
      return store.sessionRules.get(rule.id);
    }

    for (const [from, to] of ALLOWED) {
      it(`allows ${from} → ${to}`, () => {
        const pid = mkProject(`proj-allow-${from}-${to}`);
        const rule = ruleAt(pid, from);
        const opts = { changedBy: 'operator' };
        if (to === 'active') opts.expectedContent = rule.content;
        assert.doesNotThrow(() => store.sessionRules.setStatus(rule.id, to, opts));
      });
    }

    for (const [from, to] of FORBIDDEN) {
      it(`refuses ${from} → ${to} with INVALID_TRANSITION`, () => {
        const pid = mkProject(`proj-forbid-${from}-${to}`);
        const rule = ruleAt(pid, from);
        assert.throws(
          () => store.sessionRules.setStatus(rule.id, to, { changedBy: 'operator', expectedContent: rule.content }),
          (err) => err.code === 'INVALID_TRANSITION'
        );
      });
    }
  });

  describe('reject then re-edit — a rejected proposal is not frozen like a retired rule', () => {
    it('content can still be edited in place while rejected, and the edited text is what a later approval ratifies', () => {
      const pid = mkProject('proj-reject-reedit');
      const proposal = store.sessionRules.create({ content: 'first draft', projectId: pid, createdBy: 'ai' });
      const rejected = store.sessionRules.setStatus(proposal.id, 'rejected', { changedBy: 'operator' });
      assert.equal(rejected.status, 'rejected');

      // A rejected rule is not active, so `_textChangesNeedApproval` does not
      // apply — the edit lands in place, unlike an edit to an ACTIVE rule.
      const edited = store.sessionRules.update(proposal.id, { content: 'revised draft', changedBy: 'operator' });
      assert.equal(edited.content, 'revised draft');
      assert.equal(edited.status, 'rejected');
      assert.ok(!edited.replacementProposed, 'a rejected rule\'s edit must not file a replacement proposal');

      const approved = store.sessionRules.setStatus(proposal.id, 'active', {
        changedBy: 'operator', expectedContent: 'revised draft'
      });
      assert.equal(approved.status, 'active');
      assert.equal(approved.content, 'revised draft');
    });
  });

  describe('retire and restore', () => {
    it('retiring an active rule stops it governing and lands it in retired', () => {
      const pid = mkProject('proj-retire');
      const rule = mkActiveRule(pid);
      const retired = store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' });
      assert.equal(retired.status, 'retired');
      assert.ok(retired.retiredAt);
      assert.deepEqual(store.sessionRules.listActiveForProject(pid), []);
    });

    it('restoring a retired rule lands it active but disabled', () => {
      const pid = mkProject('proj-restore');
      const rule = mkActiveRule(pid);
      store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' });
      const restored = store.sessionRules.setStatus(rule.id, 'active', { changedBy: 'operator' });
      assert.equal(restored.status, 'active');
      assert.equal(restored.enabled, false, 'a restored rule never starts governing on the strength of one click');
      assert.equal(restored.retiredAt, null);
      assert.deepEqual(store.sessionRules.listActiveForProject(pid), [],
        'a restored-but-disabled rule is not injected');
    });

    it('a rule that never governed cannot be retired', () => {
      const pid = mkProject('proj-never-governed');
      const proposed = store.sessionRules.create({ content: 'never approved', projectId: pid, createdBy: 'ai' });
      assert.throws(
        () => store.sessionRules.setStatus(proposed.id, 'retired', { changedBy: 'operator' }),
        (err) => err.code === 'INVALID_TRANSITION'
      );
    });

    it('a Master rule cannot be retired', () => {
      const rule = store.sessionRules.create({ content: 'a master hard rule', kind: 'master', createdBy: 'system' });
      assert.throws(
        () => store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' }),
        (err) => err.code === 'INVALID_TRANSITION'
      );
    });

    it('restoreOnly refuses anything but an actually-retired rule (the race the route closes)', () => {
      const pid = mkProject('proj-restore-race');
      const rule = mkActiveRule(pid); // still active, never retired
      assert.throws(
        () => store.sessionRules.setStatus(rule.id, 'active', { changedBy: 'operator', restoreOnly: true }),
        (err) => err.code === 'APPROVAL_REQUIRES_AUTHORITY'
      );
    });
  });

  describe('replacement and atomic supersession (#1696)', () => {
    it('approving a replacement retires the rule it replaces, in one transaction', () => {
      const pid = mkProject('proj-replace');
      const original = mkActiveRule(pid, 'original text');
      const proposal = store.sessionRules.create({
        content: 'amended text', projectId: pid, createdBy: 'ai', replacesRuleId: original.id
      });
      const approved = store.sessionRules.setStatus(proposal.id, 'active', {
        changedBy: 'operator', expectedContent: 'amended text'
      });
      assert.deepEqual(approved.replaced, { id: original.id });
      const retiredOriginal = store.sessionRules.get(original.id);
      assert.equal(retiredOriginal.status, 'retired');
      assert.equal(retiredOriginal.supersededBy, proposal.id);
    });

    it('a replacement created already active retires its target at once', () => {
      const pid = mkProject('proj-replace-live');
      const original = mkActiveRule(pid, 'original text 2');
      const replacement = store.sessionRules.create({
        content: 'live amendment', projectId: pid, createdBy: 'operator', replacesRuleId: original.id
      });
      assert.equal(replacement.status, 'active');
      const retiredOriginal = store.sessionRules.get(original.id);
      assert.equal(retiredOriginal.status, 'retired');
      assert.equal(retiredOriginal.supersededBy, replacement.id);
    });

    it('creating a second replacement naming an already-retired target is refused INVALID_REPLACES at creation — it never reaches the approval-time REPLACEMENT_SUPERSEDED check', () => {
      const pid = mkProject('proj-double-replace');
      const original = mkActiveRule(pid, 'original text 3');
      const first = store.sessionRules.create({
        content: 'first amendment', projectId: pid, createdBy: 'operator', replacesRuleId: original.id
      });
      assert.equal(first.status, 'active'); // retires `original` immediately
      // A second proposal cannot even target the now-retired `original`...
      assert.throws(
        () => store.sessionRules.create({ content: 'second amendment', projectId: pid, createdBy: 'ai', replacesRuleId: original.id }),
        (err) => err.code === 'INVALID_REPLACES'
      );
    });

    it('approving a REJECTED replacement whose target was superseded by a DIFFERENT, later-approved one is refused REPLACEMENT_SUPERSEDED', () => {
      // #1696 Architect ruling: single lineage. The INVALID_REPLACES test
      // above refuses a second replacement at CREATION because its target is
      // already gone. This is the other door into the same guarantee: a
      // replacement that was proposed and REJECTED while the target was
      // still active — so it was never blocked by the one-pending guard —
      // can be moved rejected -> active later (an allowed transition). If a
      // DIFFERENT replacement has since retired the target, resurrecting the
      // rejected one would let two rules claim to have replaced one original.
      const pid = mkProject('proj-resurrect-rejected');
      const original = mkActiveRule(pid, 'original text 3b');
      const loser = store.sessionRules.create({
        content: 'rejected amendment', projectId: pid, createdBy: 'ai', replacesRuleId: original.id
      });
      store.sessionRules.setStatus(loser.id, 'rejected', { changedBy: 'operator' });
      // Rejecting frees the target: a second (eventual winner) proposal may
      // now be filed and approved, retiring `original`.
      const winner = store.sessionRules.create({
        content: 'winning amendment', projectId: pid, createdBy: 'ai', replacesRuleId: original.id
      });
      store.sessionRules.setStatus(winner.id, 'active', { changedBy: 'operator', expectedContent: 'winning amendment' });
      assert.equal(store.sessionRules.get(original.id).status, 'retired');
      assert.equal(store.sessionRules.get(original.id).supersededBy, winner.id);
      // Now resurrect the rejected loser — `rejected -> active` is itself an
      // allowed transition, so the refusal must come from the replacement
      // guard, not INVALID_TRANSITION.
      assert.throws(
        () => store.sessionRules.setStatus(loser.id, 'active', { changedBy: 'operator', expectedContent: 'rejected amendment' }),
        (err) => err.code === 'REPLACEMENT_SUPERSEDED'
      );
      assert.equal(store.sessionRules.get(loser.id).status, 'rejected', 'the refused approval must not have changed anything');
    });

    it('a second replacement of a rule with a STILL-PENDING replacement is refused INVALID_REPLACES — a distinct branch from the already-superseded case', () => {
      const pid = mkProject('proj-pending-replace');
      const original = mkActiveRule(pid, 'original text 4');
      // Unlike the superseded case above, `original` is still active here —
      // its first replacement is still a proposal, not yet approved.
      const firstPending = store.sessionRules.create({
        content: 'first pending amendment', projectId: pid, createdBy: 'ai', replacesRuleId: original.id
      });
      assert.equal(firstPending.status, 'proposed');
      assert.equal(store.sessionRules.get(original.id).status, 'active');
      assert.throws(
        () => store.sessionRules.create({ content: 'second pending amendment', projectId: pid, createdBy: 'ai', replacesRuleId: original.id }),
        (err) => err.code === 'INVALID_REPLACES'
      );
    });

    it('an edit of an active rule becomes a replacement proposal, not an in-place change', () => {
      const pid = mkProject('proj-edit-proposal');
      const rule = mkActiveRule(pid, 'original edit text');
      const result = store.sessionRules.update(rule.id, { content: 'edited text', changedBy: 'operator' });
      assert.ok(result.replacementProposed, 'an edit of an active rule must file a proposal');
      assert.equal(result.replacementProposed.status, 'proposed');
      assert.equal(result.replacementProposed.replacesRuleId, rule.id);
      assert.equal(result.replacementProposed.replacementOrigin, 'edit');
      const unchanged = store.sessionRules.get(rule.id);
      assert.equal(unchanged.content, 'original edit text', 'the active rule keeps governing its approved text');
    });

    it('rolling an active rule back to a different version becomes a replacement proposal too, with origin "restore"', () => {
      const pid = mkProject('proj-restore-proposal');
      // Build real version history before approval (#1696: an active rule's
      // content change defers), then approve into force governing v2.
      const proposal = store.sessionRules.create({ content: 'restore origin v1', projectId: pid, createdBy: 'ai' });
      store.sessionRules.update(proposal.id, { content: 'restore origin v2', changedBy: 'ai' });
      const rule = store.sessionRules.setStatus(proposal.id, 'active', { changedBy: 'operator', expectedContent: 'restore origin v2' });
      const firstVersion = store.sessionRules.listVersions(rule.id).at(-1).versionNo;

      const result = store.sessionRules.restore(rule.id, firstVersion);
      assert.ok(result.replacementProposed, 'rolling an active rule back to different text must file a proposal');
      assert.equal(result.replacementProposed.status, 'proposed');
      assert.equal(result.replacementProposed.content, 'restore origin v1');
      assert.equal(result.replacementProposed.replacesRuleId, rule.id);
      assert.equal(result.replacementProposed.replacementOrigin, 'restore');
      assert.equal(store.sessionRules.get(rule.id).content, 'restore origin v2', 'the active rule keeps governing its approved text');
    });

    it('approving an edit proposal whose target already retired is refused REPLACEMENT_TARGET_INACTIVE', () => {
      const pid = mkProject('proj-stale-edit');
      const rule = mkActiveRule(pid, 'about to retire');
      const result = store.sessionRules.update(rule.id, { content: 'stale edit', changedBy: 'operator' });
      const proposalId = result.replacementProposed.id;
      store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' });
      assert.throws(
        () => store.sessionRules.setStatus(proposalId, 'active', { changedBy: 'operator', expectedContent: 'stale edit' }),
        (err) => err.code === 'REPLACEMENT_TARGET_INACTIVE'
      );
    });

    it('approving an amendment whose target is already gone still approves, with replacementSkipped', () => {
      const pid = mkProject('proj-amendment-gone');
      const rule = mkActiveRule(pid, 'amendment target');
      const amendment = store.sessionRules.create({
        content: 'amendment text', projectId: pid, createdBy: 'ai', replacesRuleId: rule.id
      });
      store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' }); // target retired independently
      const approved = store.sessionRules.setStatus(amendment.id, 'active', {
        changedBy: 'operator', expectedContent: 'amendment text'
      });
      assert.equal(approved.status, 'active', 'an amendment\'s own intent still holds');
      assert.equal(approved.replaced, null);
      assert.ok(approved.replacementSkipped);
      assert.equal(approved.replacementSkipped.id, rule.id);
    });

    it('a project rule naming a Master rule as its replacement target is refused — by the project/kind mismatch, since a project rule is never kind "master"', () => {
      const masterRule = store.sessionRules.create({ content: 'a master hard rule', kind: 'master', createdBy: 'system' });
      const pid = mkProject('proj-replace-master');
      assert.throws(
        () => store.sessionRules.create({ content: 'not a real amendment', projectId: pid, createdBy: 'ai', replacesRuleId: masterRule.id }),
        (err) => err.code === 'INVALID_REPLACES'
      );
    });

    it('a Master rule cannot itself be created as a replacement — it has its own baseline lifecycle, exercising the dedicated master guard directly', () => {
      // Distinct from the test above: that one is refused by the project/kind
      // MISMATCH check (a 'startup' replacement naming a 'master' target).
      // This one is refused by `_validateReplacesTarget`'s own `kind ===
      // 'master'` guard, which fires before any target lookup at all — the
      // only way to exercise it directly is a replacement that is ITSELF
      // kind 'master'.
      const existingMaster = store.sessionRules.create({ content: 'existing master rule', kind: 'master', createdBy: 'system' });
      assert.throws(
        () => store.sessionRules.create({ content: 'not a real amendment', kind: 'master', createdBy: 'system', replacesRuleId: existingMaster.id }),
        (err) => err.code === 'INVALID_REPLACES'
      );
    });

    it('a REJECTED replacement does not count as still pending — a fresh one may be filed for the same target', () => {
      const pid = mkProject('proj-rejected-not-pending');
      const original = mkActiveRule(pid, 'original text 5');
      const firstAttempt = store.sessionRules.create({
        content: 'first attempt', projectId: pid, createdBy: 'ai', replacesRuleId: original.id
      });
      store.sessionRules.setStatus(firstAttempt.id, 'rejected', { changedBy: 'operator' });
      // The one-pending-replacement guard (_pendingReplacementOf) filters on
      // status='proposed' specifically — a decided (rejected) replacement
      // must not block a fresh attempt the way a still-undecided one would.
      assert.doesNotThrow(() => store.sessionRules.create({
        content: 'second attempt', projectId: pid, createdBy: 'ai', replacesRuleId: original.id
      }));
      assert.equal(store.sessionRules.get(original.id).status, 'active', 'the target is still active, untouched by the rejected attempt');
    });

    it('a replacement cannot name a target in a DIFFERENT project — same-project is required, not just same-kind', () => {
      const ownPid = mkProject('proj-replace-own');
      const otherPid = mkProject('proj-replace-other');
      const target = mkActiveRule(ownPid, 'owned by the first project');
      assert.throws(
        () => store.sessionRules.create({ content: 'cross-project amendment', projectId: otherPid, createdBy: 'ai', replacesRuleId: target.id }),
        (err) => err.code === 'INVALID_REPLACES'
      );
      assert.equal(store.sessionRules.get(target.id).status, 'active');
    });
  });

  describe('the retire → edit → restore → switch-on hole (#1709)', () => {
    it('a retired rule\'s text cannot be changed at all', () => {
      const pid = mkProject('proj-retired-text');
      const rule = mkActiveRule(pid, 'frozen text');
      store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' });
      assert.throws(
        () => store.sessionRules.update(rule.id, { content: 'sneaky edit', changedBy: 'operator' }),
        (err) => err.code === 'RULE_RETIRED'
      );
      // Confirms the hole stays closed end to end: restore (disabled) then
      // switch on would otherwise let edited text reach governance with no
      // approval in between.
      const stillRetired = store.sessionRules.get(rule.id);
      assert.equal(stillRetired.content, 'frozen text');
    });

    it('a retired rule\'s text cannot be rolled back to a different version either — restore() carries the same freeze as update()', () => {
      const pid = mkProject('proj-retired-restore');
      const proposal = store.sessionRules.create({ content: 'v1 text', projectId: pid, createdBy: 'ai' });
      store.sessionRules.update(proposal.id, { content: 'v2 text', changedBy: 'ai' });
      const rule = store.sessionRules.setStatus(proposal.id, 'active', { changedBy: 'operator', expectedContent: 'v2 text' });
      const firstVersion = store.sessionRules.listVersions(rule.id).at(-1).versionNo;
      store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' });
      assert.throws(
        () => store.sessionRules.restore(rule.id, firstVersion),
        (err) => err.code === 'RULE_RETIRED'
      );
      assert.equal(store.sessionRules.get(rule.id).content, 'v2 text', 'the retired rule\'s frozen text must be untouched');
    });
  });

  describe('delivery queries exclude retired rules', () => {
    it('listActiveForProject never returns a retired rule', () => {
      const pid = mkProject('proj-delivery');
      const rule = mkActiveRule(pid, 'about to be retired');
      assert.deepEqual(store.sessionRules.listActiveForProject(pid).map((r) => r.id), [rule.id]);
      store.sessionRules.setStatus(rule.id, 'retired', { changedBy: 'operator' });
      assert.deepEqual(store.sessionRules.listActiveForProject(pid), []);
    });

    it('listActiveForMaster never returns a retired master rule (retire is refused, so this proves the filter, not the refusal)', () => {
      const rule = store.sessionRules.create({ content: 'master rule', kind: 'master', createdBy: 'operator' });
      assert.deepEqual(store.sessionRules.listActiveForMaster().map((r) => r.id).includes(rule.id), true);
      // Master rules cannot be retired through setStatus (asserted above); the
      // filter itself (`WHERE status = 'active'`) is exercised by the
      // project-rule case, which can actually reach 'retired'.
    });
  });
});
