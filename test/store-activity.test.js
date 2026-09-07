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

  describe('retention (#869)', () => {
    let originalRetention;
    before(() => {
      // Need a clean table for precise counting, but activity_log is 
      // heavily appended by other tests. Best to just use specific event types.
    });

    after(() => {
      store._setActivityLogRetention(500); // restore default
    });

    it('bounds a churny type at its cap while an older forensic row survives (per-type cap)', () => {
      store._setActivityLogRetention(3);

      // The forensic row (rare type)
      store.activity.log({ eventType: 'wrap.auto_pr', detail: { id: 'forensic-1' } });

      // The churny rows (volume exceeds cap)
      store.activity.log({ eventType: 'port.leased', detail: { id: 'churn-1' } });
      store.activity.log({ eventType: 'port.leased', detail: { id: 'churn-2' } });
      store.activity.log({ eventType: 'port.leased', detail: { id: 'churn-3' } });
      store.activity.log({ eventType: 'port.leased', detail: { id: 'churn-4' } }); // This triggers prune of churn-1

      const forensic = store.activity.query({ eventType: 'wrap.auto_pr' });
      assert.equal(forensic.length, 1, 'forensic type is untouched because it never hit the cap');
      assert.equal(forensic[0].detail.id, 'forensic-1');

      const churny = store.activity.query({ eventType: 'port.leased' }).sort((a, b) => b.id - a.id);
      assert.equal(churny.length, 3, 'churny type is capped at 3');
      
      // Newest rows kept: churn-2, churn-3, churn-4
      assert.equal(churny[0].detail.id, 'churn-4');
      assert.equal(churny[1].detail.id, 'churn-3');
      assert.equal(churny[2].detail.id, 'churn-2');
    });

    it('subjects NULL-project_id rows to the policy (Master footprint)', () => {
      store._setActivityLogRetention(2);
      
      store.activity.log({ eventType: 'master.ping', detail: { n: 1 } });
      store.activity.log({ eventType: 'master.ping', detail: { n: 2 } });
      store.activity.log({ eventType: 'master.ping', detail: { n: 3 } });

      const pings = store.activity.query({ eventType: 'master.ping' }).sort((a, b) => b.id - a.id);
      assert.equal(pings.length, 2);
      assert.equal(pings[0].detail.n, 3);
      assert.equal(pings[1].detail.n, 2);
      assert.equal(pings[0].projectId, null, 'row is a NULL-project row');
    });

    it('reports the first prune on a real table via activity.pruned', () => {
      store._setActivityLogRetention(2);
      
      // Ensure we trigger a prune of a new type
      store.activity.log({ eventType: 'test.report', detail: 1 });
      store.activity.log({ eventType: 'test.report', detail: 2 });
      
      // Clear out any previous activity.pruned so we can measure just this one
      // (not strictly necessary if we query carefully, but safe)
      
      store.activity.log({ eventType: 'test.report', detail: 3 }); // Triggers prune of 1 row
      
      const prunes = store.activity.query({ eventType: 'activity.pruned' });
      // Might be more than 1 if earlier tests triggered it, but we can look for test.report
      const reportPrune = prunes.find(p => p.detail && p.detail.prunedType === 'test.report');
      assert.ok(reportPrune, 'prune was reported');
      assert.equal(reportPrune.detail.count, 1);
    });
  });
});
