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
        methodology: 'minimal',
        tags: ['node'],
        ports: { dev: 8080 }
      });

      assert.ok(project.id);
      assert.equal(project.name, 'test-project');
      assert.equal(project.path, '/tmp/test-project');
      assert.equal(project.engineId, 'claude');
      assert.equal(project.methodology, 'minimal');
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

    it('uses defaults for engine and methodology', () => {
      const project = store.projects.create({
        name: 'defaults-test',
        path: '/tmp/defaults-test'
      });
      assert.equal(project.engineId, 'claude');
      assert.equal(project.methodology, 'minimal');
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
  });

  describe('list', () => {
    it('lists non-archived projects by default', () => {
      const list = store.projects.list();
      assert.ok(list.length > 0);
      for (const p of list) {
        assert.equal(p.archived, false);
      }
    });

    it('filters by methodology', () => {
      const list = store.projects.list({ methodology: 'minimal' });
      for (const p of list) {
        assert.equal(p.methodology, 'minimal');
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

    it('updates methodology', () => {
      const created = store.projects.create({ name: 'update-method', path: '/tmp/update-method' });
      const updated = store.projects.update(created.id, { methodology: 'tilt' });
      assert.equal(updated.methodology, 'tilt');
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
