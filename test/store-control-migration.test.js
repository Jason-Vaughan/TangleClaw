'use strict';

// #1861: schema v48 adds the control-state tables. A fresh install gets them
// at the current version; a v47 store gains them through the migration, and
// the migration's postcondition names what is missing rather than stamping a
// version over a store that cannot enforce append-only audit.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const CONTROL_OBJECTS = [
  'control_assignments', 'control_holds', 'control_events', 'control_receipts',
  'idx_control_assignments_open', 'idx_control_events_create_request',
  'control_events_append_only_update', 'control_events_append_only_delete',
  'control_receipts_append_only_update', 'control_receipts_append_only_delete'
];

let tmpDir = null;

/**
 * Names present in sqlite_master.
 * @returns {Set<string>}
 */
function objects() {
  return new Set(store.getDb().prepare('SELECT name FROM sqlite_master').all().map((r) => r.name));
}

describe('store: control-state schema (v48, #1861)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has every control object at the current schema version', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-fresh-'));
    store._setBasePath(tmpDir);
    store.init();
    const have = objects();
    for (const name of CONTROL_OBJECTS) assert.ok(have.has(name), `missing ${name}`);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.equal(store.CURRENT_SCHEMA_VERSION, 48);
  });

  it('a v47 store without the control tables migrates to v48 with them', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-v47-'));
    store._setBasePath(tmpDir);
    store.init();
    const db = store.getDb();
    for (const trigger of CONTROL_OBJECTS.filter((n) => n.includes('append_only'))) db.exec(`DROP TRIGGER ${trigger}`);
    for (const table of ['control_receipts', 'control_events', 'control_holds', 'control_assignments']) db.exec(`DROP TABLE ${table}`);
    // A fresh store stamps only its current version, so stand in for the v47 stamp.
    db.exec('DELETE FROM schema_version WHERE version >= 48');
    db.exec('INSERT INTO schema_version (version) VALUES (47)');
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 47);
    store.close();

    store._setBasePath(tmpDir);
    store.init();
    const have = objects();
    for (const name of CONTROL_OBJECTS) assert.ok(have.has(name), `migration left ${name} missing`);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 48);
  });

  it('one open assignment per project is enforced by the database itself', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-unique-'));
    store._setBasePath(tmpDir);
    store.init();
    const row = (id) => ({ assignment_id: id, project_id: 7, authority_json: '{}', state: 'active', state_generation: 1, created_by_kind: 'operator' });
    store.control.insertAssignment(row('asg_a'));
    assert.throws(() => store.control.insertAssignment(row('asg_b')), /UNIQUE/);
  });
});
