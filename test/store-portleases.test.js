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

  it('bulk release records each lease as owner-initiated, with its host', () => {
    store.portLeases.lease({ port: 6100, project: 'Owned', service: 'a' });
    store.portLeases.lease({ port: 6101, project: 'Owned', service: 'b' });

    store.portLeases.releaseByProject('Owned');

    const released = store.activity.query({ eventType: 'port.released' });
    assert.equal(released.length, 2);
    const detail = released.map(r => r.detail).sort((x, y) => x.port - y.port);
    assert.deepEqual(detail[0], { host: 'localhost', port: 6100, project: 'Owned', service: 'a' });
    assert.deepEqual(detail[1], { host: 'localhost', port: 6101, project: 'Owned', service: 'b' });
    assert.equal(store.activity.query({ eventType: 'port.orphan_swept' }).length, 0);
  });

  it('a swept release is recorded as a sweep, not as the owner giving the port back', () => {
    store.portLeases.lease({ port: 6200, project: 'Ghost', service: 'a' });
    store.portLeases.lease({ port: 6201, project: 'Ghost', service: 'b' });
    store.portLeases.lease({ port: 6202, project: 'Ghost', service: 'c' });

    const count = store.portLeases.releaseByProject('Ghost', { reason: 'orphan-sweep' });
    assert.equal(count, 3);

    const swept = store.activity.query({ eventType: 'port.orphan_swept' });
    assert.equal(swept.length, 3, 'one row per displaced lease, not one per project');
    assert.deepEqual(
      swept.map(r => r.detail).sort((x, y) => x.port - y.port),
      [
        { host: 'localhost', port: 6200, project: 'Ghost', service: 'a' },
        { host: 'localhost', port: 6201, project: 'Ghost', service: 'b' },
        { host: 'localhost', port: 6202, project: 'Ghost', service: 'c' }
      ]
    );
    // The discriminator is the whole point: a swept lease must not also read as
    // an ordinary release, or the trail cannot answer who decided it should go.
    assert.equal(store.activity.query({ eventType: 'port.released' }).length, 0);
  });

  it('an unrecognized reason releases as owner-initiated rather than as a sweep', () => {
    store.portLeases.lease({ port: 6300, project: 'Owned', service: 'a' });

    store.portLeases.releaseByProject('Owned', { reason: 'something-else' });

    assert.equal(store.activity.query({ eventType: 'port.released' }).length, 1);
    assert.equal(store.activity.query({ eventType: 'port.orphan_swept' }).length, 0);
  });

  it('releasing a project that holds nothing records nothing', () => {
    assert.equal(store.portLeases.releaseByProject('Absent', { reason: 'orphan-sweep' }), 0);
    assert.equal(store.activity.query({ eventType: 'port.orphan_swept' }).length, 0);
    assert.equal(store.activity.query({ eventType: 'port.released' }).length, 0);
  });

  it('names every displaced lease in the log, not only in the activity table', () => {
    // The activity row needs a query to find. The warn is what an operator
    // sees tailing a boot, so it is the half a human actually reads — and
    // nothing else in this file asserts it, because the suite runs at `error`.
    const { setLevel: setLogLevel } = require('../lib/logger');
    store.portLeases.lease({ port: 6400, project: 'Ghost', service: 'dev-server' });
    store.portLeases.lease({ port: 6401, project: 'Ghost', service: 'api' });

    const lines = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    setLogLevel('warn');
    process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return originalWrite(chunk, ...rest); };
    try {
      store.portLeases.releaseByProject('Ghost', { reason: 'orphan-sweep' });
    } finally {
      process.stdout.write = originalWrite;
      setLogLevel('error');
    }

    const swept = lines.filter((l) => l.includes('Orphan sweep released a port lease'));
    assert.equal(swept.length, 2, 'one warn per displaced lease');
    assert.ok(swept.some((l) => l.includes('6400') && l.includes('dev-server')));
    assert.ok(swept.some((l) => l.includes('6401') && l.includes('api')));
    assert.ok(swept.every((l) => l.includes('Ghost') && l.includes('localhost')));
  });

  it('an owner-initiated bulk release is not announced as a displacement', () => {
    const { setLevel: setLogLevel } = require('../lib/logger');
    store.portLeases.lease({ port: 6500, project: 'Owned', service: 'a' });

    const lines = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    setLogLevel('warn');
    process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return originalWrite(chunk, ...rest); };
    try {
      store.portLeases.releaseByProject('Owned');
    } finally {
      process.stdout.write = originalWrite;
      setLogLevel('error');
    }

    assert.equal(lines.filter((l) => l.includes('Orphan sweep released a port lease')).length, 0);
  });

  it('a forced cross-project release names both sides, not just the displaced owner', () => {
    store.portLeases.lease({ port: 6600, project: 'Holder', service: 'dev-server' });

    store.portLeases.release(6600, 'localhost', { project: 'Taker', force: true });

    // `port.released` says "this project gave the port back". Nobody gave this
    // one back, so recording it that way names the victim as the actor.
    assert.equal(store.activity.query({ eventType: 'port.released' }).length, 0);
    const forced = store.activity.query({ eventType: 'port.force_released' });
    assert.equal(forced.length, 1);
    assert.deepEqual(forced[0].detail, {
      host: 'localhost',
      port: 6600,
      displacedProject: 'Holder',
      displacedService: 'dev-server',
      byProject: 'Taker'
    });
  });

  it('an owner releasing its own port is still an ordinary release', () => {
    store.portLeases.lease({ port: 6601, project: 'Holder', service: 'dev-server' });

    store.portLeases.release(6601, 'localhost', { project: 'Holder' });

    assert.equal(store.activity.query({ eventType: 'port.force_released' }).length, 0);
    const released = store.activity.query({ eventType: 'port.released' });
    assert.equal(released.length, 1);
    assert.equal(released[0].detail.project, 'Holder');
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

  // This block replaces a test named 'upsert updates existing lease', which
  // asserted that leasing a port owned by a DIFFERENT project silently replaced
  // the owner — it pinned the #613 defect as correct behavior. It is inverted
  // rather than deleted because the renewal half of that upsert is real and
  // still needs a contract; only the cross-project half was wrong.
  describe('ownership (#613)', () => {
    it('renews a lease the same project already holds', () => {
      store.portLeases.lease({ port: 1234, project: 'Same', service: 'svc1' });
      store.portLeases.lease({ port: 1234, project: 'Same', service: 'svc2', permanent: true });

      const lease = store.portLeases.get(1234);
      assert.equal(lease.project, 'Same');
      assert.equal(lease.service, 'svc2', 'a renewal still updates the lease fields');
      assert.equal(lease.permanent, true);
    });

    it('refuses a live lease held by another project', () => {
      store.portLeases.lease({ port: 1235, project: 'Owner', service: 'dev-server' });

      assert.throws(
        () => store.portLeases.lease({ port: 1235, project: 'Intruder', service: 'other' }),
        (err) => err.code === 'PORT_CONFLICT' && /Owner/.test(err.message),
        'a cross-project claim must be refused, naming the owner'
      );

      const lease = store.portLeases.get(1235);
      assert.equal(lease.project, 'Owner', 'the original owner must survive the refusal');
      assert.equal(lease.service, 'dev-server');
    });

    it('carries the current owner on the error so the caller can act on it', () => {
      store.portLeases.lease({ port: 1236, project: 'Owner', service: 'dev-server' });

      try {
        store.portLeases.lease({ port: 1236, project: 'Intruder', service: 'other' });
        assert.fail('expected a PORT_CONFLICT');
      } catch (err) {
        assert.equal(err.code, 'PORT_CONFLICT');
        assert.equal(err.owner.project, 'Owner');
        assert.equal(err.owner.service, 'dev-server');
      }
    });

    it('allows an explicit forced takeover', () => {
      store.portLeases.lease({ port: 1237, project: 'Owner', service: 'dev-server' });
      store.portLeases.lease({ port: 1237, project: 'Taker', service: 'other', force: true });

      const lease = store.portLeases.get(1237);
      assert.equal(lease.project, 'Taker', 'force takes the port over');
      assert.equal(lease.service, 'other');
    });

    it('records a forced takeover in the activity log', () => {
      // The displaced project keeps running against a port the registry no
      // longer says is theirs; without this entry there is no trace of who held
      // it, which is what made the live incident so expensive to unwind.
      store.portLeases.lease({ port: 1238, project: 'Owner', service: 'dev-server' });
      store.portLeases.lease({ port: 1238, project: 'Taker', service: 'other', force: true });

      const events = store.activity.query({ eventType: 'port.takeover', limit: 50 });
      const entry = events.find((e) => e.detail && e.detail.port === 1238);
      assert.ok(entry, 'a forced takeover must be logged');
      assert.equal(entry.detail.displacedProject, 'Owner');
      assert.equal(entry.detail.project, 'Taker');
    });

    it('lets a different project claim a port whose lease has expired', () => {
      // An expired lease is garbage awaiting the sweep — treating it as live
      // would strand ports behind projects that are already gone.
      store.portLeases.lease({ port: 1239, project: 'Gone', service: 'old', ttlMs: -1000 });
      store.portLeases.lease({ port: 1239, project: 'Fresh', service: 'new' });

      assert.equal(store.portLeases.get(1239).project, 'Fresh');
    });

    it('still refuses when another project holds a permanent lease', () => {
      store.portLeases.lease({ port: 1240, project: 'Owner', service: 'db', permanent: true });

      assert.throws(
        () => store.portLeases.lease({ port: 1240, project: 'Intruder', service: 'other' }),
        (err) => err.code === 'PORT_CONFLICT',
        'a permanent lease never expires, so it always blocks'
      );
    });

    it('scopes ownership to the host — the same port on another host is free', () => {
      store.portLeases.lease({ port: 1241, project: 'Owner', service: 'svc' });
      store.portLeases.lease({ port: 1241, host: 'other-box', project: 'Elsewhere', service: 'svc' });

      assert.equal(store.portLeases.get(1241).project, 'Owner');
      assert.equal(store.portLeases.get(1241, 'other-box').project, 'Elsewhere');
    });
  });

  describe('release & heartbeat ownership (#656)', () => {
    it('release with no project deletes unconditionally (backward compat)', () => {
      store.portLeases.lease({ port: 1300, project: 'Owner', service: 'svc' });
      store.portLeases.release(1300);
      assert.equal(store.portLeases.get(1300), null);
    });

    it('release with the owning project succeeds', () => {
      store.portLeases.lease({ port: 1301, project: 'Owner', service: 'svc' });
      store.portLeases.release(1301, 'localhost', { project: 'Owner' });
      assert.equal(store.portLeases.get(1301), null);
    });

    it('refuses to release another project\'s live lease, carrying the owner, leaving it intact', () => {
      store.portLeases.lease({ port: 1302, project: 'Owner', service: 'dev-server' });
      try {
        store.portLeases.release(1302, 'localhost', { project: 'Intruder' });
        assert.fail('expected a PORT_CONFLICT');
      } catch (err) {
        assert.equal(err.code, 'PORT_CONFLICT');
        assert.equal(err.owner.project, 'Owner');
      }
      assert.ok(store.portLeases.get(1302), 'the lease must survive a refused release');
    });

    it('force releases another project\'s live lease', () => {
      store.portLeases.lease({ port: 1303, project: 'Owner', service: 'svc' });
      store.portLeases.release(1303, 'localhost', { project: 'Intruder', force: true });
      assert.equal(store.portLeases.get(1303), null);
    });

    it('releasing an EXPIRED lease of another project is never a conflict', () => {
      store.portLeases.lease({ port: 1304, project: 'Gone', service: 'old', ttlMs: -1000 });
      store.portLeases.release(1304, 'localhost', { project: 'Someone' });
      assert.equal(store.portLeases.get(1304), null, 'expired garbage is releasable by anyone');
    });

    it('heartbeat with the owning project renews', () => {
      store.portLeases.lease({ port: 1305, project: 'Owner', service: 'svc', ttlMs: 60000 });
      const out = store.portLeases.heartbeat(1305, 'localhost', { project: 'Owner' });
      assert.ok(out, 'the owner can renew');
      assert.equal(out.project, 'Owner');
    });

    it('refuses to heartbeat another project\'s lease (no force — never legitimate)', () => {
      store.portLeases.lease({ port: 1306, project: 'Owner', service: 'svc', ttlMs: 60000 });
      assert.throws(
        () => store.portLeases.heartbeat(1306, 'localhost', { project: 'Intruder' }),
        (err) => err.code === 'PORT_CONFLICT' && err.owner.project === 'Owner'
      );
    });

    it('heartbeat with no project renews unconditionally (backward compat)', () => {
      store.portLeases.lease({ port: 1307, project: 'Owner', service: 'svc', ttlMs: 60000 });
      assert.ok(store.portLeases.heartbeat(1307), 'a bare 2-arg call still renews');
    });

    it('heartbeat on a missing lease returns null even with a project', () => {
      assert.equal(store.portLeases.heartbeat(1308, 'localhost', { project: 'Anyone' }), null);
    });
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

  it('schema version matches CURRENT_SCHEMA_VERSION', () => {
    const db = store.getDb();
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    assert.equal(row.version, store.CURRENT_SCHEMA_VERSION);
  });

  describe('reach — how far the service is MEANT to be reachable (#1394)', () => {
    it('defaults to loopback, the weakest claim', () => {
      const lease = store.portLeases.lease({ port: 3250, project: 'TangleBrain', service: 'gui' });
      assert.equal(lease.reach, 'loopback');
      assert.equal(store.portLeases.get(3250).reach, 'loopback');
    });

    it('round-trips every declared reach', () => {
      for (const reach of store.LEASE_REACHES) {
        const lease = store.portLeases.lease({
          port: 3300, project: 'P', service: 's', reach
        });
        assert.equal(lease.reach, reach);
        assert.equal(store.portLeases.get(3300).reach, reach);
      }
    });

    it('rejects an unknown reach by name, and says which values exist', () => {
      assert.throws(
        () => store.portLeases.lease({ port: 3301, project: 'P', service: 's', reach: 'world' }),
        (err) => {
          assert.equal(err.code, 'BAD_REQUEST');
          for (const reach of store.LEASE_REACHES) {
            assert.ok(err.message.includes(reach), `error should name ${reach}`);
          }
          return true;
        }
      );
      assert.equal(store.portLeases.get(3301), null, 'the bad lease left no row behind');
    });

    it('a renewal that omits reach narrows back to loopback', () => {
      store.portLeases.lease({ port: 3302, project: 'P', service: 's', reach: 'tailnet' });
      assert.equal(store.portLeases.get(3302).reach, 'tailnet');

      // Replace semantics, deliberately: a caller that stops declaring a wide
      // reach has stopped claiming it. The divergence check over-reports on a
      // stale-narrow value and would MISS an exposure on a stale-wide one.
      store.portLeases.lease({ port: 3302, project: 'P', service: 's' });
      assert.equal(store.portLeases.get(3302).reach, 'loopback');
    });

    it('list and getByProject carry reach too, not just get', () => {
      store.portLeases.lease({ port: 3303, project: 'Reachy', service: 's', reach: 'lan' });
      assert.equal(store.portLeases.list({ project: 'Reachy' })[0].reach, 'lan');
      assert.equal(store.portLeases.getByProject('Reachy')[0].reach, 'lan');
    });
  });
});

describe('#1394 — schema v34→v35 on a REAL old DB', () => {
  it('backfills existing leases to loopback and enforces the CHECK afterwards', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v35-mig-'));
    const prevBase = store._getBasePath();
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (34);
        CREATE TABLE port_leases (
          host        TEXT NOT NULL DEFAULT 'localhost',
          port        INTEGER NOT NULL,
          project     TEXT NOT NULL,
          service     TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','expired','permanent')),
          permanent   INTEGER NOT NULL DEFAULT 0,
          ttl_ms      INTEGER,
          expires_at  TEXT,
          last_heartbeat TEXT,
          description TEXT,
          auto_renew  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (host, port)
        );
        INSERT INTO port_leases (host, port, project, service, status, permanent)
        VALUES ('localhost', 3250, 'TangleBrain', 'tanglebrain-gui', 'permanent', 1);
      `);
      seed.close();

      // Precondition: the v34 table really has no reach column, or the
      // assertions below prove nothing about what the migration did.
      const pre = new DatabaseSync(dbPath);
      const preCols = pre.prepare('PRAGMA table_info(port_leases)').all().map((c) => c.name);
      assert.ok(!preCols.includes('reach'), 'fixture precondition: v34 has no reach column');
      pre.close();

      store.close();
      store._setBasePath(tmpDir);
      store.init();

      const lease = store.portLeases.get(3250);
      assert.equal(lease.project, 'TangleBrain', 'the pre-existing lease survives');
      assert.equal(lease.reach, 'loopback',
        'a lease that predates the field never claimed a wide reach, so it reads as the narrowest');

      // The CHECK is really on the column, not just in the validator above it.
      const db = store.getDb();
      assert.throws(
        () => db.prepare(
          "INSERT INTO port_leases (host, port, project, service, reach) VALUES ('localhost', 9, 'P', 's', 'world')"
        ).run(),
        /CHECK constraint failed/,
        'the migration added the constraint, not just the column'
      );
    } finally {
      try { store.close(); } catch { /* already closed */ }
      store._setBasePath(prevBase);
      store.init();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // `_createTables` runs BEFORE the migrations and creates a MISSING table at
  // the current shape, reach included — so a DB whose port_leases table is
  // absent reaches v34→v35 with the column already there, and an unconditional
  // ALTER aborts the whole upgrade with "duplicate column name".
  //
  // The seed version matters and is not arbitrary: it must be >= 8. Below that,
  // the v7→v8 migration rebuilds port_leases from scratch at the v8 shape,
  // stripping reach again, and the duplicate never happens — a fixture seeded
  // at v1 passes this test against the broken code.
  it('upgrades an install whose port_leases table is absent (seeded past the v8 rebuild)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v35-nopl-'));
    const prevBase = store._getBasePath();
    try {
      const { DatabaseSync } = require('node:sqlite');
      const seed = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (20);
      `);
      seed.close();

      store.close();
      store._setBasePath(tmpDir);
      assert.doesNotThrow(() => store.init(), 'the upgrade must not abort on a duplicate column');

      const lease = store.portLeases.lease({ port: 3400, project: 'P', service: 's' });
      assert.equal(lease.reach, 'loopback');
      // The constraint has to be real on this path too, not only on the ALTER path.
      assert.throws(
        () => store.getDb().prepare(
          "INSERT INTO port_leases (host, port, project, service, reach) VALUES ('localhost', 8, 'P', 's', 'world')"
        ).run(),
        /CHECK constraint failed/
      );
    } finally {
      try { store.close(); } catch { /* already closed */ }
      store._setBasePath(prevBase);
      store.init();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
