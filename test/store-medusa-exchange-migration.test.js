'use strict';

// #1839: schema v49 adds the Medusa exchange tables. A fresh install gets them
// at the current version; a v48 store gains them through the migration; the
// postcondition refuses to stamp a version over tables that cannot keep an
// append-only record.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const EXCHANGE_OBJECTS = [
  'medusa_exchanges', 'medusa_exchange_facts', 'idx_medusa_exchanges_hub',
  'medusa_exchange_facts_append_only_update', 'medusa_exchange_facts_append_only_delete'
];

let tmpDir = null;

/**
 * Names present in sqlite_master.
 * @returns {Set<string>}
 */
function objects() {
  return new Set(store.getDb().prepare('SELECT name FROM sqlite_master').all().map((r) => r.name));
}

/**
 * Open a fresh store in a new temp dir.
 * @param {string} label - Temp dir label
 * @returns {void}
 */
function freshStore(label) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-mx-${label}-`));
  store._setBasePath(tmpDir);
  store.init();
}

/**
 * Turn the open store back into a v48 one: drop every exchange object and the newer stamp.
 * @returns {void}
 */
function rewindToV48() {
  const db = store.getDb();
  db.exec('DROP TRIGGER medusa_exchange_facts_append_only_update');
  db.exec('DROP TRIGGER medusa_exchange_facts_append_only_delete');
  db.exec('DROP TABLE medusa_exchange_facts');
  db.exec('DROP TABLE medusa_exchanges');
  db.exec('DELETE FROM schema_version WHERE version >= 49');
  db.exec('INSERT INTO schema_version (version) VALUES (48)');
  store.close();
}

/**
 * Turn the open store back into a v73 one: restore the pre-#1879
 * unconditional delete trigger and the older stamp, leaving the tables
 * themselves untouched.
 * @returns {void}
 */
function rewindToV73() {
  const db = store.getDb();
  db.exec(`
    DROP TRIGGER medusa_exchange_facts_append_only_delete;
    CREATE TRIGGER medusa_exchange_facts_append_only_delete
      BEFORE DELETE ON medusa_exchange_facts
      BEGIN SELECT RAISE(ABORT, 'medusa_exchange_facts is append-only'); END;
  `);
  db.exec('DELETE FROM schema_version WHERE version >= 74');
  db.exec('INSERT INTO schema_version (version) VALUES (73)');
  store.close();
}

describe('store: Medusa exchange schema (v49, #1839)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has every exchange object at the current schema version', () => {
    freshStore('fresh');
    const have = objects();
    for (const name of EXCHANGE_OBJECTS) assert.ok(have.has(name), `missing ${name}`);
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 49);
  });

  it('a v48 store migrates to the current version with the exchange tables, and keeps its control rows', () => {
    freshStore('v48');
    store.control.insertAssignment({ assignment_id: 'asg_keep', project_id: 7, authority_json: '{}', state: 'held', state_generation: 2, created_by_kind: 'operator' });
    rewindToV48();

    store._setBasePath(tmpDir);
    store.init();
    const have = objects();
    for (const name of EXCHANGE_OBJECTS) assert.ok(have.has(name), `migration left ${name} missing`);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.equal(store.control.getAssignment('asg_keep').state, 'held');
  });

  it('one send row and one arrival row may share a Hub id, but not two of either', () => {
    freshStore('unique');
    const row = (id, origin) => ({
      exchange_id: id, request_id: `r-${id}`, hub_id: 'hub-1', origin, tracking: origin === 'send' ? 'tracked' : 'untracked',
      recipient_workspace_id: 'ws', priority: 'normal', reply_required: false, created_at: '2026-09-25T00:00:00.000Z',
      state: origin === 'send' ? 'stored' : 'untracked'
    });
    store.medusaExchanges.insert(row('mx_a', 'send'));
    store.medusaExchanges.insert(row('mx_b', 'arrival'));
    assert.throws(() => store.medusaExchanges.insert(row('mx_c', 'send')), /UNIQUE/);
  });

  it('refuses a projection write to a column that is not part of the projection', () => {
    freshStore('proj');
    assert.throws(() => store.medusaExchanges.writeProjection('mx_x', { priority: 'critical' }), /not a projection column/);
  });

  /**
   * Insert one exchange row directly, in a given state/terminal_at/esc_level,
   * with one fact so a delete has something to touch.
   * @param {string} id - Exchange id
   * @param {{state?: string, terminalAt?: (string|null), tracking?: string}} [opts]
   * @returns {void}
   */
  function insertExchangeWithFact(id, { state = 'stored', terminalAt = null, tracking = 'tracked' } = {}) {
    store.medusaExchanges.insert({
      exchange_id: id, request_id: `r-${id}`, origin: 'send', tracking,
      recipient_workspace_id: 'ws', priority: 'normal', reply_required: false,
      created_at: '2026-09-25T00:00:00.000Z', state
    });
    if (terminalAt) {
      store.getDb().prepare('UPDATE medusa_exchanges SET terminal_at = ? WHERE exchange_id = ?').run(terminalAt, id);
    }
    store.medusaExchanges.appendFact({ exchange_id: id, fact: 'send_pending', at: '2026-09-25T00:00:00.000Z' });
  }

  describe('the v74 retention delete trigger (#1879)', () => {
    const RETENTION_INDEXES = ['idx_medusa_exchanges_untracked_retention', 'idx_medusa_exchanges_terminal_retention'];

    it('a fresh install\'s delete trigger is conditional, not the old unconditional v49 shape, and has both retention indexes', () => {
      freshStore('v74-fresh');
      const ddl = store.getDb().prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'medusa_exchange_facts_append_only_delete'"
      ).get().sql;
      assert.match(ddl, /WHEN/i);
      assert.match(ddl, /terminal_at/i);
      for (const name of RETENTION_INDEXES) assert.ok(objects().has(name), `missing ${name}`);
    });

    it('a v73 store migrates the trigger to the conditional shape, keeps the tables, and gains both retention indexes', () => {
      freshStore('v74-migrate');
      insertExchangeWithFact('mx_keep', { state: 'stored' });
      for (const name of RETENTION_INDEXES) store.getDb().exec(`DROP INDEX IF EXISTS ${name}`); // a real v73 store never had them
      rewindToV73();

      store._setBasePath(tmpDir);
      store.init();
      assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
      const ddl = store.getDb().prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'medusa_exchange_facts_append_only_delete'"
      ).get().sql;
      assert.match(ddl, /WHEN/i);
      assert.ok(store.medusaExchanges.get('mx_keep'), 'the migration did not touch existing rows');
      for (const name of RETENTION_INDEXES) assert.ok(objects().has(name), `migration left ${name} missing`);
    });

    it('still refuses deleting a fact while its exchange is open', () => {
      freshStore('v74-open');
      insertExchangeWithFact('mx_open', { state: 'stored' });
      assert.throws(
        () => store.getDb().prepare('DELETE FROM medusa_exchange_facts WHERE exchange_id = ?').run('mx_open'),
        /append-only/
      );
    });

    it('allows deleting facts of a terminal exchange while its parent row still exists', () => {
      freshStore('v74-terminal');
      insertExchangeWithFact('mx_closed', { state: 'closed', terminalAt: '2026-09-25T00:00:01.000Z' });
      store.getDb().prepare('DELETE FROM medusa_exchange_facts WHERE exchange_id = ?').run('mx_closed');
      assert.equal(store.medusaExchanges.facts('mx_closed').length, 0);
    });

    it('allows deleting facts of an untracked exchange (no terminal_at) while its parent row still exists', () => {
      freshStore('v74-untracked');
      insertExchangeWithFact('mx_untracked', { state: 'untracked', tracking: 'untracked' });
      store.getDb().prepare('DELETE FROM medusa_exchange_facts WHERE exchange_id = ?').run('mx_untracked');
      assert.equal(store.medusaExchanges.facts('mx_untracked').length, 0);
    });
  });
});
