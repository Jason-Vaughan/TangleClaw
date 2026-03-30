'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.portLeases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-portleases-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lease creation and retrieval', () => {
    const lease = store.portLeases.lease({
      port: 3100,
      project: 'TestProject',
      service: 'ttyd',
      permanent: true
    });

    assert.equal(lease.port, 3100);
    assert.equal(lease.project, 'TestProject');
    assert.equal(lease.service, 'ttyd');
    assert.equal(lease.permanent, true);
    assert.equal(lease.status, 'permanent');

    const fetched = store.portLeases.get(3100);
    assert.equal(fetched.port, 3100);
    assert.equal(fetched.project, 'TestProject');
  });

  it('lease by project filtering', () => {
    store.portLeases.lease({ port: 3100, project: 'ProjA', service: 'ttyd' });
    store.portLeases.lease({ port: 3101, project: 'ProjA', service: 'server' });
    store.portLeases.lease({ port: 4000, project: 'ProjB', service: 'dev' });

    const projA = store.portLeases.getByProject('ProjA');
    assert.equal(projA.length, 2);
    assert.ok(projA.every(l => l.project === 'ProjA'));

    const projB = store.portLeases.getByProject('ProjB');
    assert.equal(projB.length, 1);
  });

  it('release by port', () => {
    store.portLeases.lease({ port: 5000, project: 'Test', service: 'api' });
    assert.ok(store.portLeases.get(5000));

    store.portLeases.release(5000);
    assert.equal(store.portLeases.get(5000), null);
  });

  it('release by project (bulk)', () => {
    store.portLeases.lease({ port: 6000, project: 'Bulk', service: 'a' });
    store.portLeases.lease({ port: 6001, project: 'Bulk', service: 'b' });
    store.portLeases.lease({ port: 7000, project: 'Other', service: 'c' });

    const count = store.portLeases.releaseByProject('Bulk');
    assert.equal(count, 2);
    assert.equal(store.portLeases.getByProject('Bulk').length, 0);
    assert.equal(store.portLeases.getByProject('Other').length, 1);
  });

  it('heartbeat extends TTL lease', () => {
    store.portLeases.lease({
      port: 8000,
      project: 'TTLTest',
      service: 'dev',
      permanent: false,
      ttlMs: 60000
    });

    const before = store.portLeases.get(8000);
    assert.ok(before.expiresAt);

    const after = store.portLeases.heartbeat(8000);
    assert.ok(after);
    assert.ok(after.lastHeartbeat);
  });

  it('conflict detection', () => {
    store.portLeases.lease({ port: 9000, project: 'Existing', service: 'web', permanent: true });

    const conflict = store.portLeases.checkConflict(9000);
    assert.ok(conflict);
    assert.equal(conflict.project, 'Existing');

    const noConflict = store.portLeases.checkConflict(9999);
    assert.equal(noConflict, null);
  });

  it('alternative port suggestion', () => {
    store.portLeases.lease({ port: 3000, project: 'Test', service: 'a' });
    store.portLeases.lease({ port: 3001, project: 'Test', service: 'b' });

    const alt = store.portLeases.suggestAlternative(3000);
    assert.ok(alt > 3001, `Expected port > 3001, got ${alt}`);

    // Requesting a free port returns itself
    const free = store.portLeases.suggestAlternative(9999);
    assert.equal(free, 9999);
  });

  it('stale lease expiration', () => {
    // Create a lease that already expired (by directly inserting)
    const db = store.getDb();
    db.prepare(`
      INSERT INTO port_leases (port, project, service, status, permanent, ttl_ms, expires_at)
      VALUES (?, ?, ?, 'active', 0, 1000, datetime('now', '-1 hour'))
    `).run(11000, 'Stale', 'old-service');

    // Create a permanent lease that should NOT expire
    store.portLeases.lease({ port: 11001, project: 'Perm', service: 'keep', permanent: true });

    const expired = store.portLeases.expireStale();
    assert.equal(expired, 1);
    assert.equal(store.portLeases.get(11000), null);
    assert.ok(store.portLeases.get(11001), 'Permanent lease should survive');
  });

  it('list with filters', () => {
    store.portLeases.lease({ port: 2000, project: 'A', service: 'x', permanent: true });
    store.portLeases.lease({ port: 2001, project: 'B', service: 'y' });

    const all = store.portLeases.list();
    assert.equal(all.length, 2);

    const byProject = store.portLeases.list({ project: 'A' });
    assert.equal(byProject.length, 1);
    assert.equal(byProject[0].project, 'A');

    const byStatus = store.portLeases.list({ status: 'permanent' });
    assert.equal(byStatus.length, 1);
    assert.equal(byStatus[0].port, 2000);
  });

  it('upsert updates existing lease', () => {
    store.portLeases.lease({ port: 1234, project: 'Old', service: 'svc1' });
    store.portLeases.lease({ port: 1234, project: 'New', service: 'svc2', permanent: true });

    const lease = store.portLeases.get(1234);
    assert.equal(lease.project, 'New');
    assert.equal(lease.service, 'svc2');
    assert.equal(lease.permanent, true);
  });

  it('validates required fields', () => {
    assert.throws(() => store.portLeases.lease({ port: 1 }), /required/);
    assert.throws(() => store.portLeases.lease({ project: 'X', service: 'Y' }), /required/);
  });

  it('port_leases table exists after init', () => {
    const db = store.getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='port_leases'").get();
    assert.ok(row, 'port_leases table should exist');
  });

  it('schema version is 11', () => {
    const db = store.getDb();
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    assert.equal(row.version, 11);
  });
});
