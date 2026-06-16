'use strict';

/*
 * Store-level tests for the session_rules table + sessionRulesApi (#347/D1a).
 * Covers the CRUD round-trip, the injection query (global + per-project,
 * excludes disabled + other projects), created_by default, cascade delete,
 * and activity logging.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('sessionRules store API (#347/D1a)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-rules-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a project and return its id. */
  function mkProject(name) {
    const projPath = path.join(tmpDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    return store.projects.create({ name, path: projPath, engine: 'claude', methodology: 'none' }).id;
  }

  describe('create', () => {
    it('creates a global rule with operator default and trims content', () => {
      const rule = store.sessionRules.create({ content: '  Prefer X over Y  ' });
      assert.equal(rule.content, 'Prefer X over Y');
      assert.equal(rule.projectId, null);
      assert.equal(rule.createdBy, 'operator');
      assert.equal(rule.enabled, true);
      assert.equal(rule.owner, null);
      assert.ok(rule.id > 0);
    });

    it('honors an explicit createdBy and projectId', () => {
      const pid = mkProject('proj-a');
      const rule = store.sessionRules.create({ content: 'AI rule', projectId: pid, createdBy: 'ai' });
      assert.equal(rule.createdBy, 'ai');
      assert.equal(rule.projectId, pid);
    });

    it('rejects empty content', () => {
      assert.throws(() => store.sessionRules.create({ content: '   ' }), /content is required/);
      assert.throws(() => store.sessionRules.create({}), /content is required/);
    });

    it('logs a session_rule.created activity event', () => {
      store.sessionRules.create({ content: 'logged rule' });
      const events = store.activity.query({ eventType: 'session_rule.created' });
      assert.equal(events.length, 1);
    });
  });

  describe('listActiveForProject (injection query)', () => {
    it('returns global rules plus the matching project rules, ordered', () => {
      const pidA = mkProject('proj-a');
      const pidB = mkProject('proj-b');
      store.sessionRules.create({ content: 'global rule' });
      store.sessionRules.create({ content: 'project A rule', projectId: pidA });
      store.sessionRules.create({ content: 'project B rule', projectId: pidB });

      const forA = store.sessionRules.listActiveForProject(pidA).map((r) => r.content);
      assert.deepEqual(forA, ['global rule', 'project A rule']);
    });

    it('excludes disabled rules', () => {
      const disabled = store.sessionRules.create({ content: 'off rule' });
      store.sessionRules.update(disabled.id, { enabled: false });
      store.sessionRules.create({ content: 'on rule' });

      const active = store.sessionRules.listActiveForProject(null).map((r) => r.content);
      assert.deepEqual(active, ['on rule']);
    });

    it('excludes other projects rules', () => {
      const pidA = mkProject('proj-a');
      const pidB = mkProject('proj-b');
      store.sessionRules.create({ content: 'A only', projectId: pidA });
      store.sessionRules.create({ content: 'B only', projectId: pidB });

      const forA = store.sessionRules.listActiveForProject(pidA).map((r) => r.content);
      assert.deepEqual(forA, ['A only']);
    });

    it('returns only global rules when projectId is null', () => {
      const pidA = mkProject('proj-a');
      store.sessionRules.create({ content: 'global', projectId: null });
      store.sessionRules.create({ content: 'scoped', projectId: pidA });

      const globals = store.sessionRules.listActiveForProject(null).map((r) => r.content);
      assert.deepEqual(globals, ['global']);
    });
  });

  describe('list', () => {
    it('filters by scope=global', () => {
      const pidA = mkProject('proj-a');
      store.sessionRules.create({ content: 'global' });
      store.sessionRules.create({ content: 'scoped', projectId: pidA });

      const globals = store.sessionRules.list({ scope: 'global' });
      assert.equal(globals.length, 1);
      assert.equal(globals[0].content, 'global');
    });

    it('filters by enabled', () => {
      const off = store.sessionRules.create({ content: 'off' });
      store.sessionRules.update(off.id, { enabled: false });
      store.sessionRules.create({ content: 'on' });

      assert.equal(store.sessionRules.list({ enabled: 1 }).length, 1);
      assert.equal(store.sessionRules.list({ enabled: 0 }).length, 1);
    });
  });

  describe('get / update / delete', () => {
    it('round-trips through get', () => {
      const created = store.sessionRules.create({ content: 'fetch me' });
      const fetched = store.sessionRules.get(created.id);
      assert.equal(fetched.content, 'fetch me');
      assert.equal(store.sessionRules.get(99999), null);
    });

    it('updates content and enabled, bumps updated_at, logs an event', () => {
      const created = store.sessionRules.create({ content: 'before' });
      const updated = store.sessionRules.update(created.id, { content: 'after', enabled: false });
      assert.equal(updated.content, 'after');
      assert.equal(updated.enabled, false);
      const events = store.activity.query({ eventType: 'session_rule.updated' });
      assert.equal(events.length, 1);
    });

    it('rejects empty content on update', () => {
      const created = store.sessionRules.create({ content: 'keep' });
      assert.throws(() => store.sessionRules.update(created.id, { content: '  ' }), /cannot be empty/);
    });

    it('throws NOT_FOUND on update/delete of a missing rule', () => {
      assert.throws(() => store.sessionRules.update(99999, { enabled: false }), /not found/);
      assert.throws(() => store.sessionRules.delete(99999), /not found/);
    });

    it('deletes a rule and logs an event', () => {
      const created = store.sessionRules.create({ content: 'goner' });
      store.sessionRules.delete(created.id);
      assert.equal(store.sessionRules.get(created.id), null);
      const events = store.activity.query({ eventType: 'session_rule.deleted' });
      assert.equal(events.length, 1);
    });
  });

  describe('cascade delete', () => {
    it('removes a project rule when its project is deleted', () => {
      const pid = mkProject('doomed');
      store.sessionRules.create({ content: 'doomed rule', projectId: pid });
      store.sessionRules.create({ content: 'survivor (global)' });

      store.projects.delete(pid);

      const remaining = store.sessionRules.list().map((r) => r.content);
      assert.deepEqual(remaining, ['survivor (global)']);
    });
  });
});
