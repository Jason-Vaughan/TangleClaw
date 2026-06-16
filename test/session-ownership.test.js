'use strict';

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const ownership = require('../lib/session-ownership');

describe('session-ownership (#347 Slices 1–2a)', () => {
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

  // Make local-host resolution deterministic: by default tailscale "isn't
  // available" and the hostname falls through to 'localhost', so the Slice-1
  // address assertions below hold. Slice-2a tests override _internal.execSync.
  beforeEach(() => {
    ownership._resetHostCacheForTest();
    ownership._internal.execSync = () => { throw new Error('tailscale not available in test'); };
    ownership._internal.hostname = () => 'localhost';
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

    it('resolves a wrapping session (live = active OR wrapping)', (t) => {
      t.mock.method(tmux, 'hasSession', () => true);
      const { session } = makeLocalSession('wrapping-resolve');
      store.sessions.setWrapping(session.id);

      const own = ownership.resolveByProject('wrapping-resolve');
      assert.ok(own, 'a mid-wrap session should still resolve by project');
      assert.equal(own.sessionId, session.id);
      assert.equal(own.status, 'wrapping');
    });
  });

  describe('transport classification', () => {
    it('keys on engine prefix, then webui mode, else tmux', () => {
      assert.equal(ownership._transportOf({ engineId: 'openclaw:x', sessionMode: 'webui' }), 'openclaw');
      assert.equal(ownership._transportOf({ engineId: 'claude', sessionMode: 'webui' }), 'webui');
      assert.equal(ownership._transportOf({ engineId: 'claude', sessionMode: 'tmux' }), 'tmux');
      assert.equal(ownership._transportOf({}), 'tmux');
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

    it('confirms live against the session\'s own tmux handle, not the DB status', (t) => {
      const calls = [];
      t.mock.method(tmux, 'hasSession', (name) => { calls.push(name); return true; });
      const { session } = makeLocalSession('checks-tmux');

      ownership.resolveBySessionId(session.id);
      assert.ok(calls.includes('checks-tmux'), 'tmux.hasSession should be consulted with the session tmuxSession');
    });

    it('a paneless local session (no tmux handle) falls back to db liveness', (t) => {
      const failIfCalled = t.mock.method(tmux, 'hasSession', () => true);
      const project = store.projects.create({ name: 'paneless', path: '/tmp/paneless' });
      const session = store.sessions.start({ projectId: project.id, engineId: 'claude' }); // no tmuxSession

      const own = ownership.resolveBySessionId(session.id);
      assert.equal(own.transport, 'tmux');
      assert.equal(own.livenessSource, 'db');
      assert.equal(own.live, true); // active in DB
      assert.equal(failIfCalled.mock.calls.length, 0, 'no tmux handle → must not probe tmux');
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

  describe('Slice 2a — local Magic DNS resolution', () => {
    const TS_JSON = '{"Self":{"DNSName":"Cursatory.Tail123678.ts.net."}}';

    it('parses .Self.DNSName, strips the trailing dot, and lowercases', () => {
      ownership._internal.execSync = () => TS_JSON;
      assert.equal(ownership._detectMagicDnsName(), 'cursatory.tail123678.ts.net');
    });

    it('returns null when tailscale output is unparseable or Self is absent', () => {
      ownership._internal.execSync = () => 'not json';
      assert.equal(ownership._detectMagicDnsName(), null);
      ownership._internal.execSync = () => '{"BackendState":"Stopped"}';
      assert.equal(ownership._detectMagicDnsName(), null);
    });

    it('returns null (never throws) when the tailscale binary is unavailable', () => {
      ownership._internal.execSync = () => { throw new Error('command not found: tailscale'); };
      assert.equal(ownership._detectMagicDnsName(), null);
    });

    it('_localHost prefers the Magic DNS name', () => {
      ownership._resetHostCacheForTest();
      ownership._internal.execSync = () => TS_JSON;
      assert.equal(ownership._localHost(), 'cursatory.tail123678.ts.net');
    });

    it('_localHost falls back to the OS hostname when tailscale is unavailable', () => {
      ownership._resetHostCacheForTest();
      ownership._internal.execSync = () => { throw new Error('no tailscale'); };
      ownership._internal.hostname = () => 'cursatory-local';
      assert.equal(ownership._localHost(), 'cursatory-local');
    });

    it('_localHost falls back to localhost when neither is available', () => {
      ownership._resetHostCacheForTest();
      ownership._internal.execSync = () => { throw new Error('no tailscale'); };
      ownership._internal.hostname = () => '';
      assert.equal(ownership._localHost(), 'localhost');
    });

    it('memoizes — tailscale is probed at most once per process', () => {
      ownership._resetHostCacheForTest();
      let calls = 0;
      ownership._internal.execSync = () => { calls += 1; return TS_JSON; };
      ownership._localHost();
      ownership._localHost();
      assert.equal(calls, 1);
    });

    it('a local session address reflects the resolved Magic DNS name', (t) => {
      t.mock.method(tmux, 'hasSession', () => true);
      ownership._resetHostCacheForTest();
      ownership._internal.execSync = () => TS_JSON;
      const { session } = makeLocalSession('magic-dns-addr');

      const own = ownership.resolveBySessionId(session.id);
      assert.equal(own.host, 'cursatory.tail123678.ts.net');
      assert.equal(own.handle, `cursatory.tail123678.ts.net/magic-dns-addr#${session.id}`);
    });
  });

  describe('Slice 3 — in-session ownership prime', () => {
    it('renders an identity block naming the owned project, host, and transport', () => {
      const lines = ownership.primeSection({ name: 'my-proj', engineId: 'claude' });
      const text = lines.join('\n');
      assert.ok(text.includes('## Session Ownership'));
      assert.ok(text.includes('Owned project: `my-proj`'));
      assert.ok(text.includes('Host: `localhost`'));
      assert.ok(text.includes('Transport: `tmux`'));
    });

    it('marks an openclaw project as the openclaw transport', () => {
      const lines = ownership.primeSection({ name: 'remote-proj', engineId: 'openclaw:abc123' });
      assert.ok(lines.join('\n').includes('Transport: `openclaw`'));
    });

    it('reflects the resolved Magic DNS host', () => {
      ownership._resetHostCacheForTest();
      ownership._internal.execSync = () => '{"Self":{"DNSName":"cursatory.tail123678.ts.net."}}';
      const lines = ownership.primeSection({ name: 'p', engineId: 'claude' });
      assert.ok(lines.join('\n').includes('Host: `cursatory.tail123678.ts.net`'));
    });

    it('returns an empty block for a missing or nameless project', () => {
      assert.deepEqual(ownership.primeSection(null), []);
      assert.deepEqual(ownership.primeSection({}), []);
    });

    it('identity only — carries no wrong-tab flagging directive (that is #340)', () => {
      const text = ownership.primeSection({ name: 'p', engineId: 'claude' }).join('\n').toLowerCase();
      assert.ok(!text.includes('flag'), 'Slice 3 is identity-only; flagging behavior belongs to #340');
      assert.ok(!text.includes('wrong'), 'Slice 3 is identity-only; flagging behavior belongs to #340');
    });
  });
});
