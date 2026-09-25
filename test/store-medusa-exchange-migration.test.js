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
});
