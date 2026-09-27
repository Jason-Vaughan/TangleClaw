'use strict';

// Schema v51 adds the operator channel's two mail tables. A fresh install gets
// them at the current version; a v50 store gains them through the migration
// and keeps its older rows; each table refuses a second row for the same
// message, which is what makes a replayed delivery harmless.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const CHANNEL_OBJECTS = [
  'operator_channel_inbound', 'operator_channel_outbound',
  'idx_operator_channel_inbound_state', 'idx_operator_channel_outbound_state'
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-oc-${label}-`));
  store._setBasePath(tmpDir);
  store.init();
}

/**
 * Turn the open store back into a v50 one: drop the channel tables and the newer stamp.
 * @returns {void}
 */
function rewindToV50() {
  const db = store.getDb();
  db.exec('DROP TABLE operator_channel_inbound');
  db.exec('DROP TABLE operator_channel_outbound');
  db.exec('DELETE FROM schema_version WHERE version >= 51');
  db.exec('INSERT INTO schema_version (version) VALUES (50)');
  store.close();
}

/**
 * An inbound row's values.
 * @param {string} id - The helper's message id
 * @returns {object}
 */
const inbound = (id) => ({
  external_id: id, author_id: 'u1', space_id: 'g1', channel_id: 'c1', target_project_id: 1,
  text: 'hello', created_at: '2026-09-27T00:00:00.000Z'
});

describe('store: operator channel schema (v51)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has both channel tables at the current schema version', () => {
    freshStore('fresh');
    const have = objects();
    for (const name of CHANNEL_OBJECTS) assert.ok(have.has(name), `missing ${name}`);
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 51);
  });

  it('a v50 store migrates to the current version with the channel tables, and keeps its exchange rows', () => {
    freshStore('v50');
    store.medusaExchanges.insert({
      exchange_id: 'mx_keep', request_id: 'r-keep', hub_id: 'hub-keep', origin: 'send', tracking: 'tracked',
      recipient_workspace_id: 'ws', priority: 'normal', reply_required: false,
      created_at: '2026-09-27T00:00:00.000Z', state: 'stored'
    });
    rewindToV50();

    store._setBasePath(tmpDir);
    store.init();
    const have = objects();
    for (const name of CHANNEL_OBJECTS) assert.ok(have.has(name), `migration left ${name} missing`);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.equal(store.medusaExchanges.get('mx_keep').state, 'stored');
  });

  it('records one inbound row per message id, and answers a replay with the first row', () => {
    freshStore('inbound');
    const first = store.operatorChannel.insertInbound(inbound('m1'));
    const again = store.operatorChannel.insertInbound({ ...inbound('m1'), text: 'a different body' });
    assert.equal(first.inserted, true);
    assert.equal(again.inserted, false);
    assert.equal(again.row.id, first.row.id);
    assert.equal(again.row.text, 'hello');
  });

  it('records one outbound row per Hub id', () => {
    freshStore('outbound');
    const first = store.operatorChannel.insertOutbound({ hub_id: 'hub-1', from_workspace_id: 'ws', text: 'x', received_at: '2026-09-27T00:00:00.000Z' });
    const again = store.operatorChannel.insertOutbound({ hub_id: 'hub-1', from_workspace_id: 'ws', text: 'y', received_at: '2026-09-27T00:00:01.000Z' });
    assert.equal(first.inserted, true);
    assert.equal(again.inserted, false);
    assert.equal(again.row.text, 'x');
  });

  it('clears an inbound text once it is handed on, and keeps it while the row waits', () => {
    freshStore('settle');
    const { row } = store.operatorChannel.insertInbound(inbound('m2'));
    const waiting = store.operatorChannel.settleInbound(row.id, { state: 'pending', error: 'no target', at: '2026-09-27T00:00:02.000Z' });
    assert.equal(waiting.text, 'hello');
    assert.equal(waiting.attempts, 1);
    const sent = store.operatorChannel.settleInbound(row.id, { state: 'sent', hubId: 'hub-9', exchangeId: 'mx_9', at: '2026-09-27T00:00:03.000Z' });
    assert.equal(sent.text, null);
    assert.equal(sent.hub_id, 'hub-9');
    const late = store.operatorChannel.settleInbound(row.id, { state: 'failed', error: 'late', at: '2026-09-27T00:00:04.000Z' });
    assert.equal(late.state, 'sent', 'a settled row does not move again');
  });

  it('an unknown outcome records its error without spending an attempt', () => {
    freshStore('unknown');
    const { row } = store.operatorChannel.insertInbound(inbound('m3'));
    const after = store.operatorChannel.settleInbound(row.id, { state: 'pending', error: 'threw', countAttempt: false, at: '2026-09-27T00:00:02.000Z' });
    assert.equal(after.attempts, 0);
    assert.equal(after.last_error, 'threw');
  });
});
