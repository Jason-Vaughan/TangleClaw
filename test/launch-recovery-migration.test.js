'use strict';

/**
 * v42→43: the recovery columns on `launch_sequences` (Train 21, #1587).
 *
 * The property under test: a store upgraded today and a store created today are
 * indistinguishable afterwards, and no live pane is stranded by the upgrade. A
 * launch that happened before the gate existed was never told it owed a
 * recovery, so it must come out of the migration owing none — defaulting
 * existing rows to `required` would block every session already in flight
 * behind a clear nobody knew to give.
 *
 * The postcondition is checked here too, because the CHECK constraints are what
 * keep the three clearances apart, and `PRAGMA table_info` cannot see them: a
 * column added without its CHECK looks identical to one added with it, right up
 * until a row records a clearance word that means nothing.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const store = require('../lib/store.js');

const tmpDirs = [];

/** The `launch_sequences` table as v42 shipped it — before the recovery columns. */
const V42_LAUNCH_SEQUENCES_DDL = `
  CREATE TABLE launch_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT, launch_id TEXT NOT NULL UNIQUE, session_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL, engine_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    cursor INTEGER NOT NULL DEFAULT 0, page_budget INTEGER NOT NULL,
    applicability TEXT NOT NULL CHECK (applicability IN ('applicable','not-applicable')),
    not_applicable_reason TEXT, preflight TEXT NOT NULL, source_manifest TEXT NOT NULL,
    ready_at TEXT, ready_artifact TEXT, ready_digest TEXT, unready_at TEXT,
    nudge_count INTEGER NOT NULL DEFAULT 0, last_nudged_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (applicability = 'applicable' OR not_applicable_reason IS NOT NULL)
  );
  CREATE UNIQUE INDEX idx_launch_sequences_session ON launch_sequences(session_id);`;

/** One in-flight launch, recorded before the gate existed. */
const IN_FLIGHT_ROW = `
  INSERT INTO launch_sequences (launch_id, session_id, project_id, engine_id, page_budget,
    applicability, preflight, source_manifest)
  VALUES ('pre-gate-launch', 7, 1, 'claude', 8000, 'applicable', '{"verdict":"ok"}', '{}');`;

/** The six columns this migration adds. */
const ADDED = ['recovery', 'recovery_mode', 'recovery_revision',
  'recovery_cleared_at', 'recovery_cleared_by', 'recovery_clearance'];

/**
 * Seed a database at v42 with the pre-gate `launch_sequences` table.
 * @param {string} [extraSql] - Further DDL/rows for the case under test
 * @returns {string} The store's base directory
 */
function seedV42(extraSql = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-mig-'));
  tmpDirs.push(dir);
  const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (42);
    ${V42_LAUNCH_SEQUENCES_DDL}
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
 * The column names `launch_sequences` carries right now.
 * @returns {Set<string>}
 */
function columns() {
  return new Set(store.getDb().prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
}

/**
 * The table's DDL as SQLite stores it — the only place a CHECK is visible.
 * @returns {string}
 */
function ddl() {
  const row = store.getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='launch_sequences'").get();
  return (row && row.sql) || '';
}

describe('v42→43 launch recovery columns (Train 21, #1587)', () => {
  after(() => {
    store.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds every column to a store upgrading from v42', () => {
    open(seedV42(IN_FLIGHT_ROW));
    const have = columns();
    for (const col of ADDED) assert.ok(have.has(col), `v42→43 did not add ${col}`);
  });

  it('leaves a pre-gate launch owing no recovery', () => {
    open(seedV42(IN_FLIGHT_ROW));
    const row = store.getDb()
      .prepare("SELECT * FROM launch_sequences WHERE launch_id = 'pre-gate-launch'").get();
    assert.equal(row.recovery, 'none',
      'a launch that predates the gate was never told it owed a recovery');
    assert.equal(row.recovery_mode, 'operator');
    assert.equal(row.recovery_revision, 1);
    assert.equal(row.recovery_clearance, null);
  });

  it('gives an upgraded store the same shape as a fresh one', () => {
    // The two paths are written from one list of columns precisely so this can
    // be asserted: a column added to the fresh-database DDL and forgotten in the
    // upgrade is a difference no test of either path alone can see.
    open(seedV42(IN_FLIGHT_ROW));
    const upgraded = [...columns()].sort();
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-fresh-'));
    tmpDirs.push(fresh);
    open(fresh);
    assert.deepEqual([...columns()].sort(), upgraded);
  });

  it('keeps every CHECK, so the three clearances stay apart', () => {
    open(seedV42(IN_FLIGHT_ROW));
    const sql = ddl();
    for (const [col, values] of [
      ['recovery', ['none', 'required', 'cleared']],
      ['recovery_mode', ['operator', 'advisory']],
      ['recovery_clearance', ['operator-verified', 'open-install-unverified', 'agent-reconciled']]
    ]) {
      assert.match(sql, new RegExp(`${col}[^,]*CHECK\\s*\\(\\s*${col}\\s+IN`), `${col} lost its CHECK`);
      for (const value of values) assert.ok(sql.includes(`'${value}'`), `${col} no longer admits ${value}`);
    }
    assert.throws(
      () => store.getDb().exec("UPDATE launch_sequences SET recovery_clearance = 'operator-ish'"),
      /CHECK constraint failed/,
      'a clearance word that means nothing is refused by the database, not merely by a caller'
    );
  });

  it('stamps 43 and nothing between', () => {
    open(seedV42(IN_FLIGHT_ROW));
    const stamped = store.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all()
      .map((r) => r.version);
    assert.deepEqual(stamped, [42, 43]);
  });

  it('is a no-op on a store that already took it', () => {
    // A retried or half-applied upgrade re-runs this block. Each column is added
    // only when it is missing, so a second pass changes nothing and throws
    // nothing — which is what lets a failure be retried at all.
    const dir = seedV42(IN_FLIGHT_ROW);
    open(dir);
    const before = ddl();
    store.close();
    open(dir);
    assert.equal(ddl(), before);
    assert.equal(
      store.getDb().prepare("SELECT COUNT(*) AS n FROM schema_version WHERE version = 43").get().n, 1,
      'a re-run does not stamp 43 twice'
    );
  });

  it('refuses to advance over a recovery column that carries no CHECK', () => {
    // The reachable half-applied case: a `launch_sequences` that already has a
    // `recovery` column from somewhere else — a database restored from a
    // divergent build, or one repaired by hand. The loop adds only what is
    // MISSING, so nothing would be altered and the column would silently accept
    // any word at all. The DDL postcondition is what stops that, and it is the
    // only check that can: `PRAGMA table_info` cannot see a CHECK, so a column
    // with one and a column without one are identical to every other reader.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-refuse-'));
    tmpDirs.push(dir);
    const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    seed.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO schema_version (version) VALUES (42);
      ${V42_LAUNCH_SEQUENCES_DDL}
      ALTER TABLE launch_sequences ADD COLUMN recovery TEXT NOT NULL DEFAULT 'none';
    `);
    seed.close();
    assert.throws(() => open(dir), /launch_sequences\.recovery without its CHECK/);
    const after = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    const stamped = after.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
    const cols = new Set(after.prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
    after.close();
    assert.ok(!stamped.includes(43), 'a failed migration advertises no v43');
    assert.ok(!cols.has('recovery_mode'),
      'the whole batch rolled back — a partial set of columns is not a schema anyone can reason about');
  });
});
