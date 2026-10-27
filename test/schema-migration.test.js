'use strict';

/**
 * v70→71: `launch_reconciliations` (post-READY additive reconciliation
 * against live drift, #2191) and `launch_readiness_receipts` (idempotent
 * durable READY receipt, #1877), plus `last_unready_verdict` /
 * `last_unready_verdict_at` provisioned on `launch_sequences` for #1596
 * (Architect ruling A477-COSIGN-20261027T2307Z).
 *
 * The property under test is the same one `launch-recovery-migration.test.js`
 * checks for the v42→43 columns: a store upgraded today and a store created
 * today must be indistinguishable afterwards, and the postcondition has to
 * actually look at the DDL — `PRAGMA table_info` cannot see a CHECK, a
 * UNIQUE constraint or a trigger, so a half-applied upgrade that merely adds
 * the column/table names would otherwise pass silently.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const store = require('../lib/store.js');

const tmpDirs = [];

/** `launch_sequences` as v70 shipped it — before the two unready-verdict columns. */
const V70_LAUNCH_SEQUENCES_DDL = `
  CREATE TABLE launch_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT, launch_id TEXT NOT NULL UNIQUE, session_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL, engine_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    cursor INTEGER NOT NULL DEFAULT 0, page_budget INTEGER NOT NULL,
    applicability TEXT NOT NULL CHECK (applicability IN ('applicable','not-applicable')),
    not_applicable_reason TEXT, preflight TEXT NOT NULL, source_manifest TEXT NOT NULL,
    ready_at TEXT, ready_artifact TEXT, ready_digest TEXT, unready_at TEXT,
    nudge_count INTEGER NOT NULL DEFAULT 0, last_nudged_at TEXT,
    recovery TEXT NOT NULL DEFAULT 'none' CHECK (recovery IN ('none','required','cleared')),
    recovery_mode TEXT NOT NULL DEFAULT 'operator' CHECK (recovery_mode IN ('operator','advisory')),
    recovery_revision INTEGER NOT NULL DEFAULT 1,
    recovery_cleared_at TEXT, recovery_cleared_by TEXT,
    recovery_clearance TEXT CHECK (recovery_clearance IN ('operator-verified','open-install-unverified','agent-reconciled')),
    startup_delivery TEXT NOT NULL DEFAULT 'legacy' CHECK (startup_delivery IN ('legacy','native')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (applicability = 'applicable' OR not_applicable_reason IS NOT NULL)
  );
  CREATE UNIQUE INDEX idx_launch_sequences_session ON launch_sequences(session_id);`;

/** One in-flight launch, recorded before this gate existed. */
const IN_FLIGHT_ROW = `
  INSERT INTO launch_sequences (launch_id, session_id, project_id, engine_id, page_budget,
    applicability, preflight, source_manifest)
  VALUES ('pre-v71-launch', 7, 1, 'claude', 8000, 'applicable', '{"verdict":"ok"}', '{}');`;

/**
 * Seed a database at v70 with the pre-v71 `launch_sequences` table.
 * @param {string} [extraSql] - Further DDL/rows for the case under test
 * @returns {string} The store's base directory
 */
function seedV70(extraSql = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-mig-'));
  tmpDirs.push(dir);
  const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (70);
    ${V70_LAUNCH_SEQUENCES_DDL}
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

/**
 * A table or index's DDL as SQLite stores it — the only place a CHECK,
 * UNIQUE or trigger body is visible.
 * @param {string} name - sqlite_master name
 * @returns {string}
 */
function ddl(name) {
  const row = store.getDb().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
  return (row && row.sql) || '';
}

/**
 * The column names `launch_sequences` carries right now.
 * @returns {Set<string>}
 */
function launchSequenceColumns() {
  return new Set(store.getDb().prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
}

describe('v70→71 launch_reconciliations, launch_readiness_receipts, unready-verdict columns', () => {
  after(() => {
    store.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds both unready-verdict columns and both new tables to a store upgrading from v70', () => {
    open(seedV70(IN_FLIGHT_ROW));
    const cols = launchSequenceColumns();
    assert.ok(cols.has('last_unready_verdict'), 'v70→71 did not add last_unready_verdict');
    assert.ok(cols.has('last_unready_verdict_at'), 'v70→71 did not add last_unready_verdict_at');
    assert.ok(ddl('launch_reconciliations'), 'v70→71 did not create launch_reconciliations');
    assert.ok(ddl('launch_readiness_receipts'), 'v70→71 did not create launch_readiness_receipts');
  });

  it('leaves a pre-existing launch with no unready verdict recorded', () => {
    open(seedV70(IN_FLIGHT_ROW));
    const row = store.getDb().prepare("SELECT * FROM launch_sequences WHERE launch_id = 'pre-v71-launch'").get();
    assert.equal(row.last_unready_verdict, null);
    assert.equal(row.last_unready_verdict_at, null);
  });

  it('gives an upgraded store the same shape as a fresh one', () => {
    open(seedV70(IN_FLIGHT_ROW));
    const upgraded = {
      cols: [...launchSequenceColumns()].sort(),
      reconciliations: ddl('launch_reconciliations').replace(/\s+/g, ' '),
      receipts: ddl('launch_readiness_receipts').replace(/\s+/g, ' ')
    };
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-fresh-'));
    tmpDirs.push(fresh);
    open(fresh);
    assert.deepEqual({
      cols: [...launchSequenceColumns()].sort(),
      reconciliations: ddl('launch_reconciliations').replace(/\s+/g, ' '),
      receipts: ddl('launch_readiness_receipts').replace(/\s+/g, ' ')
    }, upgraded);
  });

  it('keeps the CHECK that admits only a recognized unready verdict', () => {
    open(seedV70(IN_FLIGHT_ROW));
    assert.match(ddl('launch_sequences'), /last_unready_verdict[^,]*CHECK/);
    assert.throws(
      () => store.getDb().exec("UPDATE launch_sequences SET last_unready_verdict = 'made-up-verdict' WHERE launch_id = 'pre-v71-launch'"),
      /CHECK constraint failed/,
      'an unready verdict that means nothing is refused by the database'
    );
    store.getDb().exec("UPDATE launch_sequences SET last_unready_verdict = 'nudged' WHERE launch_id = 'pre-v71-launch'");
  });

  it('keeps launch_reconciliations append-only and idempotent on (sequence_id, revision, drift_digest)', () => {
    open(seedV70(IN_FLIGHT_ROW));
    const db = store.getDb();
    db.exec(`
      INSERT INTO launch_reconciliations (sequence_id, session_id, project_id, revision, drift_digest, reconciliation)
      VALUES (1, 7, 1, 1, 'abc123', 'A reconciliation of at least forty characters, honestly.');
    `);
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_reconciliations (sequence_id, session_id, project_id, revision, drift_digest, reconciliation)
        VALUES (1, 7, 1, 1, 'abc123', 'A second, different reconciliation text of forty-plus chars.');
      `),
      /UNIQUE constraint failed/,
      'a second row for the same (sequence, revision, drift) is refused by the database'
    );
    assert.throws(
      () => db.exec("UPDATE launch_reconciliations SET reconciliation = 'edited' WHERE sequence_id = 1"),
      /append-only/
    );
    assert.throws(
      () => db.exec('DELETE FROM launch_reconciliations WHERE sequence_id = 1'),
      /append-only/
    );
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_reconciliations (sequence_id, session_id, project_id, revision, drift_digest, reconciliation)
        VALUES (1, 7, 1, 1, 'xyz789', 'too short')
      `),
      /CHECK constraint failed/,
      'a reconciliation under 40 characters is refused by the database, not merely by a caller'
    );
  });

  it('keeps launch_readiness_receipts idempotent on (sequence_id, revision, assignment_id)', () => {
    open(seedV70(IN_FLIGHT_ROW));
    const db = store.getDb();
    db.exec(`
      INSERT INTO launch_readiness_receipts
        (receipt_id, sequence_id, launch_id, session_id, project_id, revision, ready_digest)
      VALUES ('receipt-one', 1, 'pre-v71-launch', 7, 1, 1, 'digest-one');
    `);
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_readiness_receipts
          (receipt_id, sequence_id, launch_id, session_id, project_id, revision, ready_digest)
        VALUES ('receipt-two', 1, 'pre-v71-launch', 7, 1, 1, 'digest-two');
      `),
      /UNIQUE constraint failed/,
      'a second receipt for the same (sequence, revision, no assignment) is refused by the database'
    );
    assert.throws(
      () => db.exec(`
        INSERT INTO launch_readiness_receipts
          (receipt_id, sequence_id, launch_id, session_id, project_id, revision, ready_digest, projection_state)
        VALUES ('receipt-bad', 2, 'pre-v71-launch', 7, 1, 1, 'digest-three', 'bogus-state');
      `),
      /CHECK constraint failed/,
      'an unrecognised projection_state is refused by the database'
    );
  });

  it('stamps the current version and nothing between', () => {
    open(seedV70(IN_FLIGHT_ROW));
    const stamped = store.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all()
      .map((r) => r.version);
    assert.deepEqual(stamped, [70, store.CURRENT_SCHEMA_VERSION]);
  });

  it('is a no-op on a store that already took it', () => {
    const dir = seedV70(IN_FLIGHT_ROW);
    open(dir);
    const before = { seq: ddl('launch_sequences'), rec: ddl('launch_reconciliations'), rcp: ddl('launch_readiness_receipts') };
    store.close();
    open(dir);
    assert.deepEqual(
      { seq: ddl('launch_sequences'), rec: ddl('launch_reconciliations'), rcp: ddl('launch_readiness_receipts') },
      before
    );
    assert.equal(
      store.getDb().prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = ?')
        .get(store.CURRENT_SCHEMA_VERSION).n, 1,
      'a re-run does not stamp the current version twice'
    );
  });

  it('refuses to advance over an unready-verdict column that carries no CHECK', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-refuse-'));
    tmpDirs.push(dir);
    const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    seed.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO schema_version (version) VALUES (70);
      ${V70_LAUNCH_SEQUENCES_DDL}
      ALTER TABLE launch_sequences ADD COLUMN last_unready_verdict TEXT;
    `);
    seed.close();
    assert.throws(() => open(dir), /last_unready_verdict without its CHECK.*Refusing to advance schema_version/);
    const after = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    const stamped = after.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
    after.close();
    assert.ok(!stamped.includes(71), 'a failed migration advertises no v71');
  });
});
