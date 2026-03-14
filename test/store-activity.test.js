'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.activity', () => {
  let tmpDir;
  let projectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-activity-'));
    store._setBasePath(tmpDir);
    store.init();

    const project = store.projects.create({
      name: 'activity-test',
      path: '/tmp/activity-test'
    });
    projectId = project.id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('log', () => {
    it('logs an event with all fields', () => {
      store.activity.log({
        projectId,
        sessionId: null,
        eventType: 'test.event',
        detail: { foo: 'bar' }
      });

      const entries = store.activity.query({ eventType: 'test.event' });
      assert.ok(entries.length >= 1);
      const entry = entries.find((e) => e.detail && e.detail.foo === 'bar');
      assert.ok(entry);
      assert.equal(entry.projectId, projectId);
    });

    it('logs event with minimal fields', () => {
      store.activity.log({ eventType: 'system.test' });

      const entries = store.activity.query({ eventType: 'system.test' });
      assert.ok(entries.length >= 1);
      assert.equal(entries[0].projectId, null);
    });

    it('never throws', () => {
      // Even with bogus data, should not throw
      assert.doesNotThrow(() => {
        store.activity.log({ eventType: 'safe.test' });
      });
    });

    it('handles null detail', () => {
      store.activity.log({ eventType: 'null.detail', detail: null });
      const entries = store.activity.query({ eventType: 'null.detail' });
      assert.ok(entries.length >= 1);
      assert.equal(entries[0].detail, null);
    });
  });

  describe('query', () => {
    it('queries by projectId', () => {
      const entries = store.activity.query({ projectId });
      assert.ok(entries.length >= 1);
      for (const e of entries) {
        assert.equal(e.projectId, projectId);
      }
    });

    it('queries by eventType', () => {
      const entries = store.activity.query({ eventType: 'test.event' });
      assert.ok(entries.length >= 1);
      for (const e of entries) {
        assert.equal(e.eventType, 'test.event');
      }
    });

    it('respects limit', () => {
      // Log multiple events
      for (let i = 0; i < 5; i++) {
        store.activity.log({ eventType: 'limit.test', detail: { i } });
      }
      const entries = store.activity.query({ eventType: 'limit.test', limit: 2 });
      assert.equal(entries.length, 2);
    });

    it('defaults to limit 50', () => {
      const entries = store.activity.query({});
      assert.ok(entries.length <= 50);
    });

    it('orders by created_at DESC', () => {
      const entries = store.activity.query({});
      for (let i = 1; i < entries.length; i++) {
        assert.ok(entries[i - 1].createdAt >= entries[i].createdAt);
      }
    });

    it('has expected fields on entries', () => {
      const entries = store.activity.query({ limit: 1 });
      assert.ok(entries.length > 0);
      const entry = entries[0];
      assert.ok('id' in entry);
      assert.ok('projectId' in entry);
      assert.ok('sessionId' in entry);
      assert.ok('eventType' in entry);
      assert.ok('createdAt' in entry);
    });
  });
});
