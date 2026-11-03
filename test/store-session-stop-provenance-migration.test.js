'use strict';

/**
 * v76→v77: `sessions.stopped_by` / `stop_reason` (#2249).
 *
 * The property under test: a store upgraded from v76 and a store created
 * today are indistinguishable afterwards; each column is gated on its own
 * existence check independently, so a half-applied database (one column
 * from a divergent build) still gets the other; and `stopped_by`'s CHECK
 * constraint survives the upgrade — `PRAGMA table_info` cannot see it, so a
 * column added without it looks identical to one added with it, right up
 * until a row records a stop source nothing recognizes.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const store = require('../lib/store.js');

const tmpDirs = [];

/** `sessions` as v76 shipped it — before the stop-provenance columns. */
const V76_SESSIONS_DDL = `
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, engine_id TEXT NOT NULL,
    tmux_session TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active', wrap_summary TEXT, prime_prompt TEXT,
    duration_seconds INTEGER, session_mode TEXT NOT NULL DEFAULT 'tmux', launch_mode TEXT,
    wrap_started_at TEXT, owner TEXT, launch_sha TEXT, launch_toplevel TEXT, launch_dirty TEXT,
    launch_blocker TEXT
  );`;

/** One session that ended before this migration existed. */
const KILLED_ROW = `
  INSERT INTO sessions (id, project_id, engine_id, status, ended_at)
  VALUES (9, 1, 'claude', 'killed', '2026-01-01T00:00:00Z');`;

/**
 * Seed a database at v76 with the pre-migration `sessions` table.
 * @param {string} [extraSql] - Further DDL/rows for the case under test
 * @returns {string} The store's base directory
 */
function seedV76(extraSql = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stop-prov-mig-'));
  tmpDirs.push(dir);
  const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (76);
    ${V76_SESSIONS_DDL}
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
 * The column names `sessions` carries right now.
 * @returns {Set<string>}
 */
function columns() {
  return new Set(store.getDb().prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
}

/**
 * The table's DDL as SQLite stores it — the only place a CHECK is visible.
 * @returns {string}
 */
function ddl() {
  const row = store.getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  return (row && row.sql) || '';
}

describe('v76→v77 sessions stop provenance (#2249)', () => {
  after(() => {
    store.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds both columns to a store upgrading from v76', () => {
    open(seedV76(KILLED_ROW));
    const have = columns();
    assert.ok(have.has('stopped_by'), 'v76→v77 did not add stopped_by');
    assert.ok(have.has('stop_reason'), 'v76→v77 did not add stop_reason');
  });

  it('leaves a pre-existing session with neither column recorded', () => {
    open(seedV76(KILLED_ROW));
    const row = store.getDb().prepare('SELECT * FROM sessions WHERE id = 9').get();
    assert.equal(row.stopped_by, null, 'a session that ended before #2249 has no stop source');
    assert.equal(row.stop_reason, null, 'nor a reason — not recorded, not recorded-as-empty');
  });

  it('gives an upgraded store the same shape as a fresh one, CHECK included', () => {
    open(seedV76(KILLED_ROW));
    const upgradedDdl = ddl().replace(/\s+/g, ' ');
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stop-prov-fresh-'));
    tmpDirs.push(fresh);
    open(fresh);
    const freshDdl = ddl().replace(/\s+/g, ' ');
    for (const sql of [upgradedDdl, freshDdl]) {
      assert.match(sql, /stopped_by\s+TEXT\s+CHECK\s*\(\s*stopped_by\s+IS\s+NULL\s+OR\s+stopped_by\s+IN/i,
        'stopped_by lost its CHECK');
      assert.match(sql, /stop_reason/i, 'stop_reason missing');
    }
  });

  it('refuses a stop source the CHECK does not recognize', () => {
    open(seedV76(KILLED_ROW));
    assert.throws(
      () => store.getDb().exec("UPDATE sessions SET stopped_by = 'operator-ish' WHERE id = 9"),
      /CHECK constraint failed/,
      'a stop source that means nothing is refused by the database, not merely by a caller'
    );
  });

  it('adds the missing column alone when the other already exists (divergent build)', () => {
    // The reachable half-applied case: a `sessions` that already has
    // `stopped_by` from somewhere else — a database restored from a
    // divergent build, or one repaired by hand. Each column is gated on its
    // OWN existence check, independently: this proves `stop_reason` is not
    // silently skipped alongside the column that was already there.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stop-prov-half-'));
    tmpDirs.push(dir);
    const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    seed.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO schema_version (version) VALUES (76);
      ${V76_SESSIONS_DDL}
      ALTER TABLE sessions ADD COLUMN stopped_by TEXT
        CHECK (stopped_by IS NULL OR stopped_by IN ('api','model-switch','wrap','crash'));
    `);
    seed.close();
    open(dir);
    assert.ok(columns().has('stop_reason'),
      'stop_reason must still be added when stopped_by already existed');
  });

  it('stamps the current version and nothing between', () => {
    open(seedV76(KILLED_ROW));
    const stamped = store.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all()
      .map((r) => r.version);
    assert.deepEqual(stamped, [76, store.CURRENT_SCHEMA_VERSION]);
  });

  it('is a no-op on a store that already took it', () => {
    const dir = seedV76(KILLED_ROW);
    open(dir);
    const before = ddl();
    store.close();
    open(dir);
    assert.equal(ddl(), before);
  });
});
