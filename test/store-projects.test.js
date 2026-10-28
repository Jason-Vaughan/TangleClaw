'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');

describe('store.projects', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-projects-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a project and returns it with an id', () => {
      const project = store.projects.create({
        name: 'test-project',
        path: '/tmp/test-project',
        engine: 'claude',
        tags: ['node'],
        ports: { dev: 8080 }
      });

      assert.ok(project.id);
      assert.equal(project.name, 'test-project');
      assert.equal(project.path, '/tmp/test-project');
      assert.equal(project.engineId, 'claude');
      assert.deepEqual(project.tags, ['node']);
      assert.deepEqual(project.ports, { dev: 8080 });
      assert.equal(project.archived, false);
    });

    it('rejects invalid project names', () => {
      assert.throws(() => {
        store.projects.create({ name: 'bad name!', path: '/tmp/bad' });
      }, /Invalid project name/);
    });

    it('rejects empty names', () => {
      assert.throws(() => {
        store.projects.create({ name: '', path: '/tmp/empty' });
      }, /Invalid project name/);
    });

    it('rejects missing path', () => {
      assert.throws(() => {
        store.projects.create({ name: 'no-path' });
      }, /path is required/);
    });

    it('rejects duplicate names', () => {
      store.projects.create({ name: 'dup-test', path: '/tmp/dup1' });
      assert.throws(() => {
        store.projects.create({ name: 'dup-test', path: '/tmp/dup2' });
      }, /already exists/);
    });

    it('uses defaults for engine', () => {
      const project = store.projects.create({
        name: 'defaults-test',
        path: '/tmp/defaults-test'
      });
      assert.equal(project.engineId, 'claude');
    });

    it('rejects an unknown option key instead of silently ignoring it (#1225)', () => {
      assert.throws(() => {
        store.projects.create({ name: 'p', path: '/tmp/p', groupId: 'g1' });
      }, (err) => {
        assert.ok(err instanceof store.StoreError);
        assert.equal(err.code, 'BAD_REQUEST');
        assert.match(err.message, /Unknown option "groupId" for projects\.create/);
        return true;
      });
    });

    it('rejects a snake_case unknown option key the same way (#1225)', () => {
      assert.throws(() => {
        store.projects.create({ name: 'p', path: '/tmp/p', group_id: 'g1' });
      }, /Unknown option "group_id" for projects\.create/);
    });

    it('rejects a null data bag', () => {
      assert.throws(() => {
        store.projects.create(null);
      }, /projects\.create requires an object/);
    });

    it('rejects an array data bag', () => {
      assert.throws(() => {
        store.projects.create(['name', 'path']);
      }, /projects\.create requires an object/);
    });
  });

  describe('get / getByName', () => {
    it('get returns project by id', () => {
      const created = store.projects.create({ name: 'get-test', path: '/tmp/get-test' });
      const found = store.projects.get(created.id);
      assert.equal(found.name, 'get-test');
    });

    it('get returns null for unknown id', () => {
      assert.equal(store.projects.get(99999), null);
    });

    it('getByName returns project by name', () => {
      store.projects.create({ name: 'by-name', path: '/tmp/by-name' });
      const found = store.projects.getByName('by-name');
      assert.equal(found.name, 'by-name');
    });

    it('getByName returns null for unknown name', () => {
      assert.equal(store.projects.getByName('nonexistent'), null);
    });

    describe('getByNameCaseInsensitive (#221 — case-insensitive identity lookup)', () => {
      it('matches across casing differences', () => {
        store.projects.create({ name: 'Case-Lookup', path: '/tmp/case-lookup' });
        const found = store.projects.getByNameCaseInsensitive('case-lookup');
        assert.ok(found, 'lowercase request must match mixed-case row');
        assert.equal(found.name, 'Case-Lookup', 'returned row preserves original casing for display');

        const found2 = store.projects.getByNameCaseInsensitive('CASE-LOOKUP');
        assert.ok(found2, 'uppercase request must match mixed-case row');
        assert.equal(found2.name, 'Case-Lookup');
      });

      it('exact-case match still works (back-compat)', () => {
        store.projects.create({ name: 'exact-ci', path: '/tmp/exact-ci' });
        const found = store.projects.getByNameCaseInsensitive('exact-ci');
        assert.ok(found);
        assert.equal(found.name, 'exact-ci');
      });

      it('returns null for unknown name (no row matches in any case)', () => {
        assert.equal(store.projects.getByNameCaseInsensitive('absent-ci'), null);
      });

      it('is distinct from getByName — getByName stays exact-case (regression pin)', () => {
        store.projects.create({ name: 'Distinct-CI', path: '/tmp/distinct-ci' });
        assert.ok(store.projects.getByNameCaseInsensitive('distinct-ci'),
          'case-insensitive variant matches');
        assert.equal(store.projects.getByName('distinct-ci'), null,
          'exact-case variant does NOT match — preserves the legacy contract that callers expecting exact case still get it');
      });
    });
  });

  describe('list', () => {
    it('lists non-archived projects by default', () => {
      const list = store.projects.list();
      assert.ok(list.length > 0);
      for (const p of list) {
        assert.equal(p.archived, false);
      }
    });


    it('filters by engine', () => {
      const list = store.projects.list({ engine: 'claude' });
      for (const p of list) {
        assert.equal(p.engineId, 'claude');
      }
    });

    it('filters by tag', () => {
      store.projects.create({ name: 'tagged', path: '/tmp/tagged', tags: ['special'] });
      const list = store.projects.list({ tag: 'special' });
      assert.ok(list.some((p) => p.name === 'tagged'));
    });

    it('rejects an unknown option key instead of silently ignoring it (#1225)', () => {
      assert.throws(() => {
        store.projects.list({ groupId: 'g1' });
      }, (err) => {
        assert.ok(err instanceof store.StoreError);
        assert.equal(err.code, 'BAD_REQUEST');
        assert.match(err.message, /Unknown option "groupId" for projects\.list/);
        return true;
      });
    });

    it('rejects a null options bag', () => {
      assert.throws(() => {
        store.projects.list(null);
      }, /projects\.list requires an object/);
    });

    it('rejects an array options bag', () => {
      assert.throws(() => {
        store.projects.list(['archived']);
      }, /projects\.list requires an object/);
    });
  });

  describe('update', () => {
    it('updates engine_id', () => {
      const created = store.projects.create({ name: 'update-engine', path: '/tmp/update-engine' });
      const updated = store.projects.update(created.id, { engine_id: 'codex' });
      assert.equal(updated.engineId, 'codex');
    });

    it('updates tags', () => {
      const created = store.projects.create({ name: 'update-tags', path: '/tmp/update-tags' });
      const updated = store.projects.update(created.id, { tags: ['python', 'active'] });
      assert.deepEqual(updated.tags, ['python', 'active']);
    });


    it('throws for unknown id', () => {
      assert.throws(() => {
        store.projects.update(99999, { engine_id: 'codex' });
      }, /not found/);
    });

    it('returns unchanged project when no updates', () => {
      const created = store.projects.create({ name: 'no-update', path: '/tmp/no-update' });
      const result = store.projects.update(created.id, {});
      assert.equal(result.name, 'no-update');
    });

    it('rejects an unknown data key instead of silently ignoring it — sibling hazard to create/list (#1225)', () => {
      const created = store.projects.create({ name: 'update-unknown', path: '/tmp/update-unknown' });
      assert.throws(() => {
        store.projects.update(created.id, { groupId: 'g1' });
      }, (err) => {
        assert.ok(err instanceof store.StoreError);
        assert.equal(err.code, 'BAD_REQUEST');
        assert.match(err.message, /Unknown option "groupId" for projects\.update/);
        return true;
      });
    });

    it('rejects the column\'s wrapper name "engine" (the row column is engine_id) rather than silently no-op-ing it', () => {
      const created = store.projects.create({ name: 'update-engine-alias', path: '/tmp/update-engine-alias' });
      assert.throws(() => {
        store.projects.update(created.id, { engine: 'codex' });
      }, /Unknown option "engine" for projects\.update/);
    });
  });

  describe('archive', () => {
    it('sets archived flag to true', () => {
      const created = store.projects.create({ name: 'archive-test', path: '/tmp/archive-test' });
      store.projects.archive(created.id);
      const found = store.projects.get(created.id);
      assert.equal(found.archived, true);
    });

    it('archived projects excluded from default list', () => {
      const list = store.projects.list();
      assert.ok(!list.some((p) => p.name === 'archive-test'));
    });

    it('archived projects included when requested', () => {
      const list = store.projects.list({ archived: true });
      assert.ok(list.some((p) => p.name === 'archive-test'));
    });
  });

  describe('unarchive', () => {
    it('restores archived flag to false', () => {
      const found = store.projects.getByName('archive-test');
      store.projects.unarchive(found.id);
      const restored = store.projects.get(found.id);
      assert.equal(restored.archived, false);
    });

    it('unarchived projects appear in default list', () => {
      const list = store.projects.list();
      assert.ok(list.some((p) => p.name === 'archive-test'));
    });
  });

  describe('delete', () => {
    it('removes project from database', () => {
      const created = store.projects.create({ name: 'delete-test', path: '/tmp/delete-test' });
      store.projects.delete(created.id);
      assert.equal(store.projects.get(created.id), null);
    });
  });
});

describe('store.activity', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-activity-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs an event without throwing', () => {
    assert.doesNotThrow(() => {
      store.activity.log({
        eventType: 'project.created',
        detail: { name: 'test' }
      });
    });
  });

  it('logs with project and session ids', () => {
    // Create a project first so projectId is valid
    store.projects.create({ name: 'activity-proj', path: '/tmp/activity-proj' });

    store.activity.log({
      projectId: 1,
      sessionId: null,
      eventType: 'session.started',
      detail: { engine: 'claude' }
    });

    const entries = store.activity.query({ eventType: 'session.started' });
    assert.ok(entries.length > 0);
    assert.equal(entries[0].eventType, 'session.started');
  });

  it('queries by event type', () => {
    store.activity.log({ eventType: 'config.changed', detail: { field: 'theme' } });
    const entries = store.activity.query({ eventType: 'config.changed' });
    assert.ok(entries.some((e) => e.eventType === 'config.changed'));
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.activity.log({ eventType: 'test.event', detail: { i } });
    }
    const entries = store.activity.query({ eventType: 'test.event', limit: 2 });
    assert.ok(entries.length <= 2);
  });

  it('never throws even with bad data', () => {
    assert.doesNotThrow(() => {
      store.activity.log({ eventType: null });
    });
  });

  it('returns parsed detail as object', () => {
    store.activity.log({ eventType: 'detail.test', detail: { key: 'value' } });
    const entries = store.activity.query({ eventType: 'detail.test' });
    assert.ok(entries.length > 0);
    assert.deepEqual(entries[0].detail, { key: 'value' });
  });
});

describe('store.sessions (store layer)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-sessions-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a project for session tests
    store.projects.create({ name: 'session-proj', path: '/tmp/session-proj' });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getActive returns null when no sessions', () => {
    const project = store.projects.getByName('session-proj');
    const active = store.sessions.getActive(project.id);
    assert.equal(active, null);
  });

  it('getLatest returns null when no sessions', () => {
    const project = store.projects.getByName('session-proj');
    const latest = store.sessions.getLatest(project.id);
    assert.equal(latest, null);
  });

  it('list returns empty array when no sessions', () => {
    const project = store.projects.getByName('session-proj');
    const sessions = store.sessions.list(project.id);
    assert.deepEqual(sessions, []);
  });
});

describe('store options-key guard audit (#2681)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-options-guard-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function assertsBadRequest(fn, key, fnName) {
    assert.throws(fn, (err) => {
      assert.ok(err instanceof store.StoreError);
      assert.equal(err.code, 'BAD_REQUEST');
      assert.match(err.message, new RegExp(`Unknown option "${key}" for ${fnName}`));
      return true;
    });
  }

  it('projectConfig.load rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.projectConfig.load(tmpDir, { bogus: 1 }), 'bogus', 'projectConfig\\.load');
    assert.doesNotThrow(() => store.projectConfig.load(tmpDir, { onError: () => {} }));
  });

  it('learnings.list rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.learnings.list(1, { bogus: 1 }), 'bogus', 'learnings\\.list');
    assert.deepEqual(store.learnings.list(1, { tier: 'active' }), []);
  });

  it('medusaDeliveries.listForSession rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.medusaDeliveries.listForSession('s1', { bogus: 1 }), 'bogus', 'medusaDeliveries\\.listForSession');
    assert.deepEqual(store.medusaDeliveries.listForSession('s1', { limit: 5 }), []);
  });

  it('awarenessReceipts.listForProject rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.awarenessReceipts.listForProject(1, { bogus: 1 }), 'bogus', 'awarenessReceipts\\.listForProject');
    assert.deepEqual(store.awarenessReceipts.listForProject(1, { limit: 5 }), []);
  });

  it('awarenessReceipts.fleetAwareness rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.awarenessReceipts.fleetAwareness({ bogus: 1 }), 'bogus', 'awarenessReceipts\\.fleetAwareness');
    assert.doesNotThrow(() => store.awarenessReceipts.fleetAwareness({ sessionsPerProject: 2 }));
  });

  it('portLeases.list rejects an unknown option key, accepts known ones', () => {
    assertsBadRequest(() => store.portLeases.list({ bogus: 1 }), 'bogus', 'portLeases\\.list');
    assert.deepEqual(store.portLeases.list({ project: 'x', status: 'active', host: 'localhost' }), []);
  });

  it('portLeases.release rejects an unknown option key, accepts known ones', () => {
    assertsBadRequest(() => store.portLeases.release(9901, 'localhost', { bogus: 1 }), 'bogus', 'portLeases\\.release');
    assert.doesNotThrow(() => store.portLeases.release(9901, 'localhost', { project: 'x', force: true }));
  });

  it('portLeases.releaseByProject rejects an unknown option key, accepts known ones', () => {
    assertsBadRequest(() => store.portLeases.releaseByProject('nonexistent', { bogus: 1 }), 'bogus', 'portLeases\\.releaseByProject');
    assert.equal(store.portLeases.releaseByProject('nonexistent', { reason: 'orphan-sweep', ownerKind: 'project' }), 0);
  });

  it('portLeases.setOwnerKind rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.portLeases.setOwnerKind('nonexistent', 'project', { bogus: 1 }), 'bogus', 'portLeases\\.setOwnerKind');
    assert.equal(store.portLeases.setOwnerKind('nonexistent', 'project', { host: 'localhost' }), 0);
  });

  it('portLeases.heartbeat rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.portLeases.heartbeat(9902, 'localhost', { bogus: 1 }), 'bogus', 'portLeases\\.heartbeat');
    assert.equal(store.portLeases.heartbeat(9902, 'localhost', { project: 'x' }), null);
  });

  it('sharedDocs.list rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.sharedDocs.list({ bogus: 1 }), 'bogus', 'sharedDocs\\.list');
    assert.deepEqual(store.sharedDocs.list({ groupId: 'g1' }), []);
  });

  it('openclawConnections.list rejects an unknown option key, accepts a known one', () => {
    assertsBadRequest(() => store.openclawConnections.list({ bogus: 1 }), 'bogus', 'openclawConnections\\.list');
    assert.deepEqual(store.openclawConnections.list({ availableAsEngine: true }), []);
  });

  it('evalExchanges.list/count/listSessions reject an unknown option key, accept known ones', () => {
    assertsBadRequest(() => store.evalExchanges.list({ bogus: 1 }), 'bogus', 'evalExchanges\\.list');
    assert.deepEqual(store.evalExchanges.list({ sessionId: 's1', project: 'p1', scored: 0, from: '2024-01-01', to: '2024-12-31', limit: 10 }), []);

    assertsBadRequest(() => store.evalExchanges.count({ bogus: 1 }), 'bogus', 'evalExchanges\\.count');
    assert.equal(store.evalExchanges.count({ project: 'p1', sessionId: 's1' }), 0);

    assertsBadRequest(() => store.evalExchanges.listSessions('p1', { bogus: 1 }), 'bogus', 'evalExchanges\\.listSessions');
    assert.deepEqual(store.evalExchanges.listSessions('p1', { limit: 5 }), []);
  });

  it('evalScores.list/listByProject reject an unknown option key, accept known ones', () => {
    assertsBadRequest(() => store.evalScores.list({ bogus: 1 }), 'bogus', 'evalScores\\.list');
    assert.deepEqual(store.evalScores.list({ from: '2024-01-01', to: '2024-12-31', anomaliesOnly: true, limit: 10 }), []);

    assertsBadRequest(() => store.evalScores.listByProject('p1', { bogus: 1 }), 'bogus', 'evalScores\\.listByProject');
    assert.deepEqual(store.evalScores.listByProject('p1', { from: '2024-01-01', to: '2024-12-31', anomaliesOnly: true, limit: 10 }), []);
  });

  it('evalIncidents.list rejects an unknown option key, accepts known ones and no options at all', () => {
    assertsBadRequest(() => store.evalIncidents.list('p1', { bogus: 1 }), 'bogus', 'evalIncidents\\.list');
    assert.deepEqual(store.evalIncidents.list('p1', { status: 'open', type: 'drift', limit: 10 }), []);
    assert.deepEqual(store.evalIncidents.list('p1'), []);
  });
});
