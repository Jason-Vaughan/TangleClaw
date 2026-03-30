'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('Web UI session lifecycle', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  let projectId;
  let connId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-webui-'));
    store._setBasePath(tmpDir);
    store.init();

    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    sessions = require('../lib/sessions');

    // Create an OpenClaw connection with webui mode
    const conn = store.openclawConnections.create({
      name: 'WebUI-Test',
      host: '192.168.20.10',
      port: 18789,
      sshUser: 'habitat-admin',
      sshKeyPath: '~/.ssh/test_key',
      gatewayToken: 'test-token-123',
      localPort: 18789,
      availableAsEngine: true,
      defaultMode: 'webui'
    });
    connId = conn.id;

    // Create a project using the openclaw engine
    const projDir = path.join(projectsDir, 'webui-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({
      name: 'webui-proj',
      path: projDir,
      engine: `openclaw:${connId}`,
      methodology: 'minimal'
    });
    projectId = project.id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Clean up active sessions
    const project = store.projects.getByName('webui-proj');
    if (project) {
      const active = store.sessions.getActive(project.id);
      if (active) store.sessions.kill(active.id, 'test cleanup');
    }
  });

  // ── Schema v7: default_mode column ──

  describe('schema v7: default_mode on openclaw_connections', () => {
    it('should have schema version 11', () => {
      const db = store.getDb();
      const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(row.version, 12);
    });

    it('should have default_mode column in openclaw_connections', () => {
      const db = store.getDb();
      const cols = db.prepare("PRAGMA table_info(openclaw_connections)").all();
      const modeCol = cols.find(c => c.name === 'default_mode');
      assert.ok(modeCol, 'default_mode column should exist');
      assert.equal(modeCol.dflt_value, "'ssh'");
    });

    it('should default to ssh when not specified', () => {
      const conn = store.openclawConnections.create({
        name: 'SSH-Default',
        host: '10.0.0.1',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key'
      });
      assert.equal(conn.defaultMode, 'ssh');
      store.openclawConnections.delete(conn.id);
    });

    it('should store webui mode when specified', () => {
      const conn = store.openclawConnections.get(connId);
      assert.equal(conn.defaultMode, 'webui');
    });

    it('should update defaultMode', () => {
      const conn = store.openclawConnections.create({
        name: 'Mode-Update',
        host: '10.0.0.2',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        defaultMode: 'ssh'
      });
      assert.equal(conn.defaultMode, 'ssh');

      const updated = store.openclawConnections.update(conn.id, { defaultMode: 'webui' });
      assert.equal(updated.defaultMode, 'webui');

      store.openclawConnections.delete(conn.id);
    });

    it('should reject invalid defaultMode values by defaulting to ssh', () => {
      const conn = store.openclawConnections.create({
        name: 'Mode-Invalid',
        host: '10.0.0.3',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        defaultMode: 'invalid'
      });
      assert.equal(conn.defaultMode, 'ssh');
      store.openclawConnections.delete(conn.id);
    });
  });

  // ── launchSession webui detection ──

  describe('launchSession webui detection', () => {
    const enginesModule = require('../lib/engines');
    let originalDetectEngine;

    beforeEach(() => {
      originalDetectEngine = enginesModule.detectEngine;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/ssh' });
    });

    afterEach(() => {
      enginesModule.detectEngine = originalDetectEngine;
    });

    it('returns webui marker when connection defaultMode is webui', () => {
      const result = sessions.launchSession('webui-proj');
      assert.equal(result.webui, true);
      assert.ok(result._conn);
      assert.equal(result._conn.id, connId);
      assert.equal(result._conn.defaultMode, 'webui');
      assert.equal(result.error, null);
    });

    it('returns webui marker when mode override is webui', () => {
      // Create a connection with ssh default
      const sshConn = store.openclawConnections.create({
        name: 'SSH-Override',
        host: '10.0.0.4',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        availableAsEngine: true,
        defaultMode: 'ssh'
      });
      const projDir = path.join(projectsDir, 'override-proj');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'override-proj',
        path: projDir,
        engine: `openclaw:${sshConn.id}`,
        methodology: 'minimal'
      });

      const result = sessions.launchSession('override-proj', { mode: 'webui' });
      assert.equal(result.webui, true);

      // Cleanup
      store.openclawConnections.delete(sshConn.id);
    });

    it('does not return webui marker for ssh mode connections', () => {
      const sshConn = store.openclawConnections.create({
        name: 'SSH-Only',
        host: '10.0.0.5',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        availableAsEngine: true,
        defaultMode: 'ssh'
      });
      const projDir = path.join(projectsDir, 'ssh-proj');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'ssh-proj',
        path: projDir,
        engine: `openclaw:${sshConn.id}`,
        methodology: 'minimal'
      });

      const result = sessions.launchSession('ssh-proj');
      // Should NOT have webui marker — continues to tmux path (which may fail, but not our concern here)
      assert.notEqual(result.webui, true);

      store.openclawConnections.delete(sshConn.id);
    });
  });

  // ── launchWebuiSession ──

  describe('launchWebuiSession', () => {
    const tunnelModule = require('../lib/tunnel');
    let originalEnsureTunnel;
    let originalCheckHealth;
    let originalDetectTunnel;

    beforeEach(() => {
      originalEnsureTunnel = tunnelModule.ensureTunnel;
      originalCheckHealth = tunnelModule.checkHealth;
      originalDetectTunnel = tunnelModule.detectTunnel;
      // Default mock: no existing tunnel
      tunnelModule.detectTunnel = async () => ({ active: false, pid: null, port: 0, connectable: false });
    });

    afterEach(() => {
      tunnelModule.ensureTunnel = originalEnsureTunnel;
      tunnelModule.checkHealth = originalCheckHealth;
      tunnelModule.detectTunnel = originalDetectTunnel;
    });

    it('launches webui session with tunnel and returns iframeUrl', async () => {
      tunnelModule.ensureTunnel = async () => ({ ok: true, alreadyUp: false, pid: 1234, error: null });
      tunnelModule.checkHealth = async () => ({ healthy: true, error: null });

      const conn = store.openclawConnections.get(connId);
      const project = store.projects.getByName('webui-proj');
      const engineProfile = store.engines.get('openclaw');

      const result = await sessions.launchWebuiSession(
        'webui-proj', conn, `openclaw:${connId}`, engineProfile, project
      );

      assert.equal(result.error, null);
      assert.ok(result.session);
      assert.equal(result.session.sessionMode, 'webui');
      assert.equal(result.session.tmuxSession, null);
      assert.equal(result.session.engineId, `openclaw:${connId}`);
      assert.ok(result.iframeUrl);
      assert.ok(result.iframeUrl.includes('/openclaw/webui-proj/'));
      assert.ok(result.iframeUrl.includes('token=test-token-123'));
      assert.equal(result.ttydUrl, null);
      assert.equal(result.primePrompt, null);
    });

    it('returns error when tunnel fails', async () => {
      tunnelModule.ensureTunnel = async () => ({ ok: false, alreadyUp: false, pid: null, error: 'Connection refused' });

      const conn = store.openclawConnections.get(connId);
      const project = store.projects.getByName('webui-proj');
      const engineProfile = store.engines.get('openclaw');

      const result = await sessions.launchWebuiSession(
        'webui-proj', conn, `openclaw:${connId}`, engineProfile, project
      );

      assert.ok(result.error);
      assert.ok(result.error.includes('Tunnel failed'));
      assert.equal(result.session, null);
    });

    it('succeeds even when health check fails (non-fatal)', async () => {
      tunnelModule.ensureTunnel = async () => ({ ok: true, alreadyUp: true, pid: null, error: null });
      tunnelModule.checkHealth = async () => ({ healthy: false, error: 'timeout' });

      const conn = store.openclawConnections.get(connId);
      const project = store.projects.getByName('webui-proj');
      const engineProfile = store.engines.get('openclaw');

      const result = await sessions.launchWebuiSession(
        'webui-proj', conn, `openclaw:${connId}`, engineProfile, project
      );

      assert.equal(result.error, null);
      assert.ok(result.session);
      assert.equal(result.session.sessionMode, 'webui');
    });

    it('builds iframeUrl without token when gatewayToken is null', async () => {
      tunnelModule.ensureTunnel = async () => ({ ok: true, alreadyUp: true, pid: null, error: null });
      tunnelModule.checkHealth = async () => ({ healthy: true, error: null });

      // Create a connection without token
      const noTokenConn = store.openclawConnections.create({
        name: 'NoToken',
        host: '10.0.0.6',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        defaultMode: 'webui'
      });
      const projDir = path.join(projectsDir, 'notoken-proj');
      fs.mkdirSync(projDir, { recursive: true });
      const proj = store.projects.create({
        name: 'notoken-proj',
        path: projDir,
        engine: `openclaw:${noTokenConn.id}`,
        methodology: 'minimal'
      });

      const result = await sessions.launchWebuiSession(
        'notoken-proj', noTokenConn, `openclaw:${noTokenConn.id}`, store.engines.get('openclaw'), proj
      );

      assert.equal(result.error, null);
      assert.ok(result.iframeUrl);
      assert.ok(!result.iframeUrl.includes('token='));

      store.openclawConnections.delete(noTokenConn.id);
    });
  });

  // ── getSessionStatus for webui ──

  describe('getSessionStatus for webui sessions', () => {
    it('returns active webui status with sessionMode', () => {
      // Directly create a webui session in the store
      const session = store.sessions.start({
        projectId,
        engineId: `openclaw:${connId}`,
        tmuxSession: null,
        sessionMode: 'webui'
      });

      const status = sessions.getSessionStatus('webui-proj');
      assert.ok(status);
      assert.equal(status.active, true);
      assert.equal(status.sessionMode, 'webui');
      assert.equal(status.tmuxSession, null);
      assert.equal(status.idle, false);
      assert.equal(status.lastOutputAge, 0);
      assert.equal(typeof status.durationSeconds, 'number');
      assert.equal(status.sessionId, session.id);
    });

    it('includes iframeUrl with token in status response', () => {
      store.sessions.start({
        projectId,
        engineId: `openclaw:${connId}`,
        tmuxSession: null,
        sessionMode: 'webui'
      });

      const status = sessions.getSessionStatus('webui-proj');
      assert.ok(status.iframeUrl);
      assert.ok(status.iframeUrl.startsWith('/openclaw/webui-proj/'));
      assert.ok(status.iframeUrl.includes('chat?session=main'));
      assert.ok(status.iframeUrl.includes('token=test-token-123'));
    });

    it('includes iframeUrl without token when gatewayToken is null', () => {
      // Create a connection without token
      const noTokenConn = store.openclawConnections.create({
        name: 'Status-NoToken',
        host: '10.0.0.20',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        defaultMode: 'webui'
      });
      const ntProjDir = path.join(projectsDir, 'status-notoken');
      fs.mkdirSync(ntProjDir, { recursive: true });
      const ntProj = store.projects.create({
        name: 'status-notoken',
        path: ntProjDir,
        engine: `openclaw:${noTokenConn.id}`,
        methodology: 'minimal'
      });
      store.sessions.start({
        projectId: ntProj.id,
        engineId: `openclaw:${noTokenConn.id}`,
        tmuxSession: null,
        sessionMode: 'webui'
      });

      const status = sessions.getSessionStatus('status-notoken');
      assert.ok(status.iframeUrl);
      assert.ok(status.iframeUrl.startsWith('/openclaw/status-notoken/'));
      assert.ok(!status.iframeUrl.includes('token='));

      // Cleanup
      store.sessions.kill(store.sessions.getActive(ntProj.id).id, 'cleanup');
      store.openclawConnections.delete(noTokenConn.id);
    });

    it('returns null iframeUrl when connection is deleted', () => {
      // Create a connection, start session, then delete connection
      const tempConn = store.openclawConnections.create({
        name: 'Status-Deleted',
        host: '10.0.0.21',
        sshUser: 'admin',
        sshKeyPath: '~/.ssh/key',
        defaultMode: 'webui'
      });
      const dProjDir = path.join(projectsDir, 'status-deleted');
      fs.mkdirSync(dProjDir, { recursive: true });
      const dProj = store.projects.create({
        name: 'status-deleted',
        path: dProjDir,
        engine: `openclaw:${tempConn.id}`,
        methodology: 'minimal'
      });
      store.sessions.start({
        projectId: dProj.id,
        engineId: `openclaw:${tempConn.id}`,
        tmuxSession: null,
        sessionMode: 'webui'
      });

      // Delete the connection
      store.openclawConnections.delete(tempConn.id);

      const status = sessions.getSessionStatus('status-deleted');
      assert.equal(status.iframeUrl, null);

      // Cleanup
      store.sessions.kill(store.sessions.getActive(dProj.id).id, 'cleanup');
    });
  });

  // ── killSession for webui ──

  describe('killSession for webui sessions', () => {
    const tunnelModule = require('../lib/tunnel');
    let originalKillTunnel;
    let killTunnelCalled;

    beforeEach(() => {
      originalKillTunnel = tunnelModule.killTunnel;
      killTunnelCalled = null;
      tunnelModule.killTunnel = (name) => { killTunnelCalled = name; return { ok: true, error: null }; };
    });

    afterEach(() => {
      tunnelModule.killTunnel = originalKillTunnel;
    });

    it('calls tunnel.killTunnel instead of tmux for webui sessions', () => {
      store.sessions.start({
        projectId,
        engineId: `openclaw:${connId}`,
        tmuxSession: null,
        sessionMode: 'webui'
      });

      const result = sessions.killSession('webui-proj');
      assert.equal(result.error, null);
      assert.ok(result.session);
      assert.equal(result.session.status, 'killed');
      assert.equal(killTunnelCalled, 'webui-proj');
    });
  });

  // ── injectCommand rejects webui ──

  describe('injectCommand rejects webui sessions', () => {
    it('returns error for webui sessions', () => {
      store.sessions.start({
        projectId,
        engineId: `openclaw:${connId}`,
        tmuxSession: null,
        sessionMode: 'webui'
      });

      const result = sessions.injectCommand('webui-proj', 'ls');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('Web UI'));
    });
  });

  // ── peek rejects webui ──

  describe('peek rejects webui sessions', () => {
    it('returns error for webui sessions', () => {
      store.sessions.start({
        projectId,
        engineId: `openclaw:${connId}`,
        tmuxSession: null,
        sessionMode: 'webui'
      });

      const result = sessions.peek('webui-proj');
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('Web UI'));
    });
  });
});

// ── OpenClaw Reverse Proxy ──

describe('OpenClaw reverse proxy routing', () => {
  const http = require('node:http');
  const { createServer } = require('../server');
  let tmpDir;
  let server;
  let backendServer;
  let backendPort;

  /**
   * Make an HTTP request to the test server.
   * @param {string} method
   * @param {string} urlPath
   * @returns {Promise<{ status: number, data: string|object, headers: object }>}
   */
  function request(method, urlPath) {
    return new Promise((resolve, reject) => {
      const addr = server.address();
      const req = http.request({
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-proxy-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    // Spin up a mock OpenClaw backend
    backendServer = http.createServer((req, res) => {
      if (req.url === '/chat') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>OpenClaw Chat</html>');
      } else if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`path:${req.url}`);
      }
    });
    await new Promise((resolve) => backendServer.listen(0, '127.0.0.1', resolve));
    backendPort = backendServer.address().port;

    // Create a connection pointing to the mock backend
    const conn = store.openclawConnections.create({
      name: 'ProxyTest',
      host: '127.0.0.1',
      sshUser: 'admin',
      sshKeyPath: '~/.ssh/key',
      localPort: backendPort,
      availableAsEngine: true,
      defaultMode: 'webui'
    });

    // Create a project using this connection
    const projDir = path.join(projectsDir, 'proxy-proj');
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({
      name: 'proxy-proj',
      path: projDir,
      engine: `openclaw:${conn.id}`,
      methodology: 'minimal'
    });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(() => {
    server.close();
    backendServer.close();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('proxies /openclaw/:project/chat to the backend', async () => {
    const res = await request('GET', '/openclaw/proxy-proj/chat');
    assert.equal(res.status, 200);
    assert.ok(typeof res.data === 'string' ? res.data.includes('OpenClaw Chat') : false);
  });

  it('proxies /openclaw/:project/healthz to the backend', async () => {
    const res = await request('GET', '/openclaw/proxy-proj/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  });

  it('preserves sub-paths through the proxy', async () => {
    const res = await request('GET', '/openclaw/proxy-proj/api/v1/status');
    assert.equal(res.status, 200);
    assert.equal(res.data, 'path:/api/v1/status');
  });

  it('returns 404 for unknown project', async () => {
    const res = await request('GET', '/openclaw/nonexistent/chat');
    assert.equal(res.status, 404);
    assert.ok(res.data.error);
  });

  it('returns 404 for project without openclaw engine', async () => {
    // Create a non-openclaw project
    const projDir = path.join(tmpDir, 'projects', 'plain-proj');
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({
      name: 'plain-proj',
      path: projDir,
      engine: 'claude',
      methodology: 'minimal'
    });

    const res = await request('GET', '/openclaw/plain-proj/chat');
    assert.equal(res.status, 404);
  });

  it('returns 502 when backend is unreachable', async () => {
    // Create connection pointing to a closed port
    const deadConn = store.openclawConnections.create({
      name: 'DeadBackend',
      host: '127.0.0.1',
      sshUser: 'admin',
      sshKeyPath: '~/.ssh/key',
      localPort: 59999,
      availableAsEngine: true
    });
    const projDir = path.join(tmpDir, 'projects', 'dead-proj');
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({
      name: 'dead-proj',
      path: projDir,
      engine: `openclaw:${deadConn.id}`,
      methodology: 'minimal'
    });

    const res = await request('GET', '/openclaw/dead-proj/chat');
    assert.equal(res.status, 502);
    assert.ok(res.data.error.includes('unavailable'));
  });
});
