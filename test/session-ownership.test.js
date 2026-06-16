'use strict';

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const ownership = require('../lib/session-ownership');

describe('session-ownership (#347 Slice 1)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ownership-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a project + active local session, returning both. */
  function makeLocalSession(name, engineId = 'claude') {
    const project = store.projects.create({ name, path: `/tmp/${name}` });
    const session = store.sessions.start({ projectId: project.id, engineId, tmuxSession: name });
    return { project, session };
  }

  describe('resolveBySessionId', () => {
    it('resolves a local active session into a host-qualified ownership object', (t) => {
      t.mock.method(tmux, 'hasSession', () => true);
      const { project, session } = makeLocalSession('resolve-by-id');

      const own = ownership.resolveBySessionId(session.id);

      assert.equal(own.sessionId, session.id);
      assert.equal(own.project, 'resolve-by-id');
      assert.equal(own.projectId, project.id);
      assert.equal(own.host, 'localhost');
      assert.equal(own.transport, 'tmux');
      assert.equal(own.remote, false);
      assert.equal(own.live, true);
      assert.equal(own.livenessSource, 'tmux');
      assert.equal(own.handle, `localhost/resolve-by-id#${session.id}`);
      assert.equal(own.engineId, 'claude');
      assert.equal(own.status, 'active');
    });

    it('returns null for an unknown session id', () => {
      assert.equal(ownership.resolveBySessionId(99999999), null);
    });
  });

  describe('resolveByProject', () => {
    it('resolves the project\'s active session', (t) => {
      t.mock.method(tmux, 'hasSession', () => true);
      const { session } = makeLocalSession('resolve-by-project');

      const own = ownership.resolveByProject('resolve-by-project');
      assert.equal(own.sessionId, session.id);
      assert.equal(own.project, 'resolve-by-project');
    });

    it('returns null when the project has no active session', () => {
      store.projects.create({ name: 'no-session', path: '/tmp/no-session' });
      assert.equal(ownership.resolveByProject('no-session'), null);
    });

    it('returns null for an unknown project', () => {
      assert.equal(ownership.resolveByProject('does-not-exist'), null);
    });
  });

  describe('liveness', () => {
    it('reports live:false for a local session whose tmux process is gone', (t) => {
      t.mock.method(tmux, 'hasSession', () => false);
      const { session } = makeLocalSession('dead-tmux');

      const own = ownership.resolveBySessionId(session.id);
      assert.equal(own.live, false);
      assert.equal(own.livenessSource, 'tmux');
    });

    it('confirms live against tmux, not just the DB status', (t) => {
      const calls = [];
      t.mock.method(tmux, 'hasSession', (name) => { calls.push(name); return true; });
      const { session } = makeLocalSession('checks-tmux');

      ownership.resolveBySessionId(session.id);
      assert.ok(calls.includes('checks-tmux'), 'tmux.hasSession should be consulted for local liveness');
    });
  });

  describe('remote (openclaw) sessions', () => {
    it('reads the connection host AS-IS and uses db-only liveness', (t) => {
      const failIfCalled = t.mock.method(tmux, 'hasSession', () => true);
      const conn = store.openclawConnections.create({
        name: 'cursatory',
        host: 'cursatory.tail-scale.ts.net',
        sshUser: 'jason',
        sshKeyPath: '/tmp/key'
      });
      const project = store.projects.create({ name: 'remote-proj', path: '/tmp/remote-proj' });
      const session = store.sessions.start({
        projectId: project.id,
        engineId: `openclaw:${conn.id}`,
        sessionMode: 'webui'
      });

      const own = ownership.resolveBySessionId(session.id);
      assert.equal(own.transport, 'openclaw');
      assert.equal(own.remote, true);
      assert.equal(own.host, 'cursatory.tail-scale.ts.net');
      assert.equal(own.mode, 'webui');
      assert.equal(own.livenessSource, 'db');
      assert.equal(own.live, true);
      assert.equal(own.handle, `cursatory.tail-scale.ts.net/remote-proj#${session.id}`);
      assert.equal(failIfCalled.mock.calls.length, 0, 'remote liveness must not consult tmux');
    });

    it('yields host:null and an "unknown" handle when the connection is missing', (t) => {
      t.mock.method(tmux, 'hasSession', () => true);
      const project = store.projects.create({ name: 'orphan-remote', path: '/tmp/orphan-remote' });
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'openclaw:nonexistent-conn-id'
      });

      const own = ownership.resolveBySessionId(session.id);
      assert.equal(own.host, null);
      assert.equal(own.handle, `unknown/orphan-remote#${session.id}`);
    });
  });

  describe('listLive', () => {
    it('enumerates active and wrapping sessions, excludes ended ones', (t) => {
      t.mock.method(tmux, 'hasSession', () => true);

      const active = makeLocalSession('live-active');
      const wrapping = makeLocalSession('live-wrapping');
      store.sessions.setWrapping(wrapping.session.id);
      const ended = makeLocalSession('live-ended');
      store.sessions.kill(ended.session.id, 'test');

      const ids = ownership.listLive().map((o) => o.sessionId);
      assert.ok(ids.includes(active.session.id), 'active session should be listed');
      assert.ok(ids.includes(wrapping.session.id), 'wrapping session should be listed (agent still running)');
      assert.ok(!ids.includes(ended.session.id), 'ended session should be excluded');
    });

    it('skips a live session whose project row is gone', (t) => {
      t.mock.method(tmux, 'hasSession', () => true);
      t.mock.method(store.sessions, 'listLiveAll', () => [
        { id: 777777, projectId: 888888, engineId: 'claude', sessionMode: 'tmux', status: 'active', startedAt: 'x' }
      ]);

      assert.deepEqual(ownership.listLive(), []);
    });
  });

  describe('store additions', () => {
    it('store.sessions.get returns a session of any status', () => {
      const { session } = makeLocalSession('store-get');
      store.sessions.kill(session.id, 'test');
      const row = store.sessions.get(session.id);
      assert.equal(row.id, session.id);
      assert.equal(row.status, 'killed');
    });

    it('store.sessions.listLiveAll returns only active/wrapping rows', () => {
      const all = store.sessions.listLiveAll();
      assert.ok(all.every((s) => s.status === 'active' || s.status === 'wrapping'));
    });
  });
});
