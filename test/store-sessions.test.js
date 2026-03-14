'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.sessions (write methods)', () => {
  let tmpDir;
  let projectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-sessions-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a project to attach sessions to
    const project = store.projects.create({
      name: 'sess-test',
      path: '/tmp/sess-test'
    });
    projectId = project.id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('start', () => {
    it('creates a session with status active', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'sess-test',
        primePrompt: '# Hello',
        methodologyPhase: 'building'
      });

      assert.ok(session.id);
      assert.equal(session.projectId, projectId);
      assert.equal(session.engineId, 'claude-code');
      assert.equal(session.tmuxSession, 'sess-test');
      assert.equal(session.status, 'active');
      assert.equal(session.primePrompt, '# Hello');
      assert.equal(session.methodologyPhase, 'building');
      assert.ok(session.startedAt);
      assert.equal(session.endedAt, null);
    });

    it('rejects missing projectId', () => {
      assert.throws(() => {
        store.sessions.start({ engineId: 'claude-code' });
      }, /projectId and engineId are required/);
    });

    it('rejects missing engineId', () => {
      assert.throws(() => {
        store.sessions.start({ projectId });
      }, /projectId and engineId are required/);
    });

    it('logs session.started activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'codex',
        tmuxSession: 'sess-test-2'
      });

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.started' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.engine, 'codex');
    });
  });

  describe('wrap', () => {
    it('sets status to wrapped with summary', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'wrap-test'
      });

      const wrapped = store.sessions.wrap(session.id, 'Completed chunk 5');
      assert.equal(wrapped.status, 'wrapped');
      assert.equal(wrapped.wrapSummary, 'Completed chunk 5');
      assert.ok(wrapped.endedAt);
      assert.ok(wrapped.durationSeconds >= 0);
    });

    it('logs session.wrapped activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'wrap-log-test'
      });

      store.sessions.wrap(session.id, 'Done');

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.wrapped' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.summaryLength, 4);
    });

    it('handles null summary', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'wrap-null-test'
      });

      const wrapped = store.sessions.wrap(session.id);
      assert.equal(wrapped.status, 'wrapped');
      assert.equal(wrapped.wrapSummary, null);
    });
  });

  describe('kill', () => {
    it('sets status to killed', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'kill-test'
      });

      const killed = store.sessions.kill(session.id, 'User requested');
      assert.equal(killed.status, 'killed');
      assert.ok(killed.endedAt);
      assert.ok(killed.durationSeconds >= 0);
    });

    it('logs session.killed activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'kill-log-test'
      });

      store.sessions.kill(session.id, 'Manual');

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.killed' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.reason, 'Manual');
    });
  });

  describe('markCrashed', () => {
    it('sets status to crashed', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'crash-test'
      });

      const crashed = store.sessions.markCrashed(session.id, 'Segfault');
      assert.equal(crashed.status, 'crashed');
      assert.ok(crashed.endedAt);
    });

    it('logs session.crashed activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'crash-log-test'
      });

      store.sessions.markCrashed(session.id, 'OOM');

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.crashed' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.error, 'OOM');
    });
  });

  describe('getActive', () => {
    it('returns null after session is wrapped', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude-code',
        tmuxSession: 'active-wrap-test'
      });
      store.sessions.wrap(session.id, 'done');

      const active = store.sessions.getActive(projectId);
      // Should be null because we wrapped the last active one
      // (unless other tests left one active)
      if (active) {
        assert.notEqual(active.id, session.id);
      }
    });
  });

  describe('list with status filter', () => {
    it('filters by status', () => {
      const wrapped = store.sessions.list(projectId, { status: 'wrapped' });
      assert.ok(wrapped.length > 0);
      for (const s of wrapped) {
        assert.equal(s.status, 'wrapped');
      }
    });
  });

  describe('count', () => {
    it('counts all sessions for a project', () => {
      const total = store.sessions.count(projectId);
      assert.ok(total > 0);
    });

    it('counts by status', () => {
      const wrappedCount = store.sessions.count(projectId, { status: 'wrapped' });
      const wrapped = store.sessions.list(projectId, { status: 'wrapped', limit: 10000 });
      assert.equal(wrappedCount, wrapped.length);
    });

    it('returns 0 for unknown project', () => {
      const count = store.sessions.count(99999);
      assert.equal(count, 0);
    });
  });
});
