'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.learnings', () => {
  let tmpDir;
  let projectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-learnings-'));
    store._setBasePath(tmpDir);
    store.init();

    const project = store.projects.create({
      name: 'learn-test',
      path: '/tmp/learn-test'
    });
    projectId = project.id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a learning with default tier provisional', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'When X, do Y because Z'
      });

      assert.ok(learning.id);
      assert.equal(learning.projectId, projectId);
      assert.equal(learning.content, 'When X, do Y because Z');
      assert.equal(learning.tier, 'provisional');
      assert.equal(learning.confirmedCount, 0);
      assert.ok(learning.createdAt);
    });

    it('creates with explicit tier', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Always check return values',
        tier: 'active'
      });

      assert.equal(learning.tier, 'active');
    });

    it('creates with source session', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'learn-sess'
      });

      const learning = store.learnings.create({
        projectId,
        content: 'From session learning',
        sourceSession: session.id
      });

      assert.equal(learning.sourceSession, session.id);
    });

    it('rejects missing projectId', () => {
      assert.throws(() => {
        store.learnings.create({ content: 'test' });
      }, /projectId and content are required/);
    });

    it('rejects missing content', () => {
      assert.throws(() => {
        store.learnings.create({ projectId });
      }, /projectId and content are required/);
    });

    it('logs learning.captured activity', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Activity test learning content'
      });

      const activity = store.activity.query({ eventType: 'learning.captured' });
      const found = activity.find((a) => a.detail && a.detail.contentPreview === 'Activity test learning content');
      assert.ok(found);
    });
  });

  describe('list', () => {
    it('lists all learnings for a project', () => {
      const learnings = store.learnings.list(projectId);
      assert.ok(learnings.length >= 3); // Created above
    });

    it('filters by tier', () => {
      const active = store.learnings.list(projectId, { tier: 'active' });
      for (const l of active) {
        assert.equal(l.tier, 'active');
      }
    });

    it('returns empty for unknown project', () => {
      const learnings = store.learnings.list(99999);
      assert.deepEqual(learnings, []);
    });
  });

  describe('getActive', () => {
    it('returns only active tier learnings', () => {
      const active = store.learnings.getActive(projectId);
      for (const l of active) {
        assert.equal(l.tier, 'active');
      }
      assert.ok(active.length >= 1);
    });
  });

  describe('confirm', () => {
    it('increments confirmed count', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Confirm test learning'
      });

      const confirmed = store.learnings.confirm(learning.id);
      assert.equal(confirmed.confirmedCount, 1);
      assert.equal(confirmed.tier, 'provisional');
    });

    it('auto-promotes to active at 2 confirmations', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Auto-promote test'
      });

      store.learnings.confirm(learning.id);
      const promoted = store.learnings.confirm(learning.id);

      assert.equal(promoted.confirmedCount, 2);
      assert.equal(promoted.tier, 'active');
    });

    it('logs learning.promoted on auto-promote', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Promote log test'
      });

      store.learnings.confirm(learning.id);
      store.learnings.confirm(learning.id);

      const activity = store.activity.query({ eventType: 'learning.promoted' });
      const found = activity.find((a) => a.detail && a.detail.from === 'provisional' && a.detail.to === 'active');
      assert.ok(found);
    });

    it('throws for unknown learning', () => {
      assert.throws(() => {
        store.learnings.confirm(99999);
      }, /not found/);
    });
  });

  describe('setTier', () => {
    it('changes tier directly', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'SetTier test'
      });

      const updated = store.learnings.setTier(learning.id, 'reference');
      assert.equal(updated.tier, 'reference');
    });

    it('rejects invalid tier', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Invalid tier test'
      });

      assert.throws(() => {
        store.learnings.setTier(learning.id, 'bogus');
      }, /Invalid tier/);
    });

    it('throws for unknown learning', () => {
      assert.throws(() => {
        store.learnings.setTier(99999, 'active');
      }, /not found/);
    });

    it('logs tier change activity', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Tier change log test'
      });

      store.learnings.setTier(learning.id, 'archived');

      const activity = store.activity.query({ eventType: 'learning.promoted' });
      const found = activity.find((a) => a.detail && a.detail.to === 'archived');
      assert.ok(found);
    });
  });

  describe('delete', () => {
    it('removes a learning', () => {
      const learning = store.learnings.create({
        projectId,
        content: 'Delete test'
      });

      store.learnings.delete(learning.id);

      const list = store.learnings.list(projectId);
      const found = list.find((l) => l.id === learning.id);
      assert.equal(found, undefined);
    });
  });
});
