'use strict';

/*
 * #1529 — the non-blocking runners behind the OpenClaw routes that reach a
 * remote host. Driven with REAL processes: the error shapes async `exec` and
 * `execFile` produce are exactly what this repo has modelled wrongly before
 * (lib/exec-timeout.js), so a stub would only assert our own assumptions.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const remote = require('../lib/openclaw-remote');
const { wasTimedOut } = require('../lib/exec-timeout');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('openclaw-remote runShell (#1529)', () => {
  it('writes input to stdin and resolves stdout', async () => {
    const { stdout } = await remote._runShell('cat', { input: 'discovery script\n' });
    assert.equal(stdout, 'discovery script\n');
  });

  it('rejects a failing command with its stderr and numeric exit code', async () => {
    await assert.rejects(
      remote._runShell('echo nope >&2; exit 3'),
      (err) => {
        assert.equal(err.code, 3);
        assert.equal(err.stderr, 'nope\n');
        assert.equal(wasTimedOut(err), false, 'an ordinary failure is not a timeout');
        return true;
      }
    );
  });

  it('kills a command that outlives its timeout and names the timeout', async () => {
    await assert.rejects(
      remote._runShell('sleep 5', { timeout: 100 }),
      (err) => {
        assert.equal(wasTimedOut(err), true);
        assert.equal(err.timedOut, true);
        assert.equal(err.message, 'timed out after 100ms');
        assert.equal(err.stderr, '', 'nothing was said, so the message carries the timeout');
        return true;
      }
    );
  });

  it('keeps what a timed-out command said, and still names the timeout', async () => {
    await assert.rejects(
      remote._runShell('echo connecting >&2; sleep 5', { timeout: 300 }),
      (err) => {
        assert.equal(err.stderr, 'connecting (timed out after 300ms)');
        return true;
      }
    );
  });

  it('never echoes the command line in a failure message', async () => {
    await assert.rejects(
      remote._runShell('exit 4 # -i /secret/key/path'),
      (err) => {
        assert.equal(err.message, 'exited with status 4');
        assert.doesNotMatch(err.message, /secret/);
        return true;
      }
    );
  });

  it('does not hold the event loop while the command runs', async () => {
    let settled = false;
    const pending = remote._runShell('sleep 0.3').then(() => { settled = true; });
    const ranWhilePending = await new Promise((resolve) => setTimeout(() => resolve(!settled), 20));
    assert.equal(ranWhilePending, true, 'a timer ran while the child was still running');
    await pending;
  });

  it('tolerates a child that exits without reading its input', async () => {
    const { stdout } = await remote._runShell('echo done', { input: 'x'.repeat(1 << 20) });
    assert.equal(stdout, 'done\n');
  });
});

describe('openclaw-remote resolveReachableHost (#1531)', () => {
  const orig = remote._internal.probePort;
  afterEach(() => {
    remote._internal.probePort = orig;
    remote._resolved.clear();
  });

  it('returns immediately with no probing for a connection with no fallbackHosts — zero overhead', async () => {
    let probed = false;
    remote._internal.probePort = () => { probed = true; return Promise.resolve(true); };
    const r = await remote.resolveReachableHost({ id: 'c1', host: 'h1', fallbackHosts: [] });
    assert.deepEqual(r, { host: 'h1', fallbackUsed: false, candidatesTried: ['h1'] });
    assert.equal(probed, false, 'no fallbackHosts means no probe at all');
  });

  it('also skips probing when fallbackHosts is absent entirely (undefined)', async () => {
    let probed = false;
    remote._internal.probePort = () => { probed = true; return Promise.resolve(true); };
    const r = await remote.resolveReachableHost({ id: 'c2', host: 'h1' });
    assert.deepEqual(r, { host: 'h1', fallbackUsed: false, candidatesTried: ['h1'] });
    assert.equal(probed, false);
  });

  it('probes every candidate IN PARALLEL and picks the highest-priority one that answered', async () => {
    const started = [];
    remote._internal.probePort = (host) => {
      started.push(host);
      // h1 (primary) never answers; h2 and h3 both do, h2 is higher priority.
      return new Promise((resolve) => setImmediate(() => resolve(host !== 'h1')));
    };
    const r = await remote.resolveReachableHost({ id: 'c3', host: 'h1', fallbackHosts: ['h2', 'h3'] });
    assert.deepEqual(started, ['h1', 'h2', 'h3'], 'all three candidates were probed before any answer was known');
    assert.deepEqual(r, { host: 'h2', fallbackUsed: true, candidatesTried: ['h1', 'h2', 'h3'] });
  });

  it('a slower higher-priority candidate still wins over a faster lower-priority one', async () => {
    remote._internal.probePort = (host) => {
      if (host === 'h1') return new Promise((resolve) => setTimeout(() => resolve(true), 15)); // slow but highest priority
      return Promise.resolve(true); // h2 answers instantly
    };
    const r = await remote.resolveReachableHost({ id: 'c4', host: 'h1', fallbackHosts: ['h2'] });
    assert.equal(r.host, 'h1', 'priority order wins, not speed');
  });

  it('falls back to the primary host when nothing answers, rather than inventing a diagnosis', async () => {
    remote._internal.probePort = () => Promise.resolve(false);
    const r = await remote.resolveReachableHost({ id: 'c5', host: 'h1', fallbackHosts: ['h2'] });
    assert.deepEqual(r, { host: 'h1', fallbackUsed: false, candidatesTried: ['h1', 'h2'] });
  });

  it('dedupes a fallback that repeats the primary host (or another fallback)', async () => {
    remote._internal.probePort = (host) => Promise.resolve(host === 'h1');
    const r = await remote.resolveReachableHost({ id: 'c6', host: 'h1', fallbackHosts: ['h1', 'h2', 'h2'] });
    assert.deepEqual(r.candidatesTried, ['h1', 'h2']);
  });

  it('caches the resolution per connection id for the TTL — a second call does not re-probe', async () => {
    let calls = 0;
    remote._internal.probePort = (host) => { calls++; return Promise.resolve(host === 'h2'); };
    const first = await remote.resolveReachableHost({ id: 'c7', host: 'h1', fallbackHosts: ['h2'] });
    const callsAfterFirst = calls;
    const second = await remote.resolveReachableHost({ id: 'c7', host: 'h1', fallbackHosts: ['h2'] });
    assert.deepEqual(second, first);
    assert.equal(calls, callsAfterFirst, 'no new probes on the cached call');
  });

  it('re-probes once the TTL has elapsed', async () => {
    let calls = 0;
    remote._internal.probePort = (host) => { calls++; return Promise.resolve(host === 'h2'); };
    await remote.resolveReachableHost({ id: 'c8', host: 'h1', fallbackHosts: ['h2'] }, { ttlMs: 10 });
    const callsAfterFirst = calls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await remote.resolveReachableHost({ id: 'c8', host: 'h1', fallbackHosts: ['h2'] }, { ttlMs: 10 });
    assert.ok(calls > callsAfterFirst, 'the stale cache entry triggered a fresh probe');
  });

  it('accepts an injected probePortImpl per call, independent of the cached default', async () => {
    const r = await remote.resolveReachableHost(
      { id: 'c9', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => Promise.resolve(host === 'h2') }
    );
    assert.equal(r.host, 'h2');
  });
});

describe('openclaw-remote invalidateResolvedHost / getActiveRoute (#1531)', () => {
  afterEach(() => { remote._resolved.clear(); });

  it('getActiveRoute reads back the cached resolution', async () => {
    await remote.resolveReachableHost(
      { id: 'c10', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => Promise.resolve(host === 'h2') }
    );
    const route = remote.getActiveRoute('c10');
    assert.equal(route.activeHost, 'h2');
    assert.equal(route.fallbackUsed, true);
    assert.equal(typeof route.resolvedAt, 'number');
  });

  it('getActiveRoute is null for an unknown or never-resolved connection', () => {
    assert.equal(remote.getActiveRoute('nonexistent'), null);
    assert.equal(remote.getActiveRoute(undefined), null);
  });

  it('getActiveRoute honors RESOLUTION_TTL_MS itself — a past-TTL entry reads as null and is '
    + 'deleted, not handed back stale (I-Gate Round 4 C1)', () => {
    remote._resolved.set('c12', { activeHost: 'h2', fallbackUsed: true, resolvedAt: Date.now() - 120_000 });
    assert.equal(remote.getActiveRoute('c12'), null);
    // Deleted, not merely masked: a direct read of the underlying map confirms it.
    assert.equal(remote._resolved.has('c12'), false);
  });

  it('getActiveRoute still returns a route within its TTL', () => {
    remote._resolved.set('c13', { activeHost: 'h2', fallbackUsed: true, resolvedAt: Date.now() - 1000 });
    const route = remote.getActiveRoute('c13');
    assert.equal(route.activeHost, 'h2');
  });

  it('invalidateResolvedHost clears the cache, forcing the next call to re-probe', async () => {
    let calls = 0;
    await remote.resolveReachableHost(
      { id: 'c11', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => { calls++; return Promise.resolve(host === 'h2'); } }
    );
    const callsAfterFirst = calls;
    remote.invalidateResolvedHost('c11');
    assert.equal(remote.getActiveRoute('c11'), null);
    await remote.resolveReachableHost(
      { id: 'c11', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => { calls++; return Promise.resolve(host === 'h2'); } }
    );
    assert.ok(calls > callsAfterFirst, 're-probed after invalidation');
  });

  it('invalidateResolvedHost on an unknown id is a no-op, never throws', () => {
    assert.doesNotThrow(() => remote.invalidateResolvedHost('nonexistent'));
    assert.doesNotThrow(() => remote.invalidateResolvedHost(undefined));
  });
});

describe('openclaw-remote _probePort — the real TCP probe, against a real listener (#1531)', () => {
  it('resolves true for a host:port actually accepting connections', async () => {
    const net = require('node:net');
    const srv = net.createServer((sock) => sock.end());
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    try {
      const ok = await remote._internal.probePort('127.0.0.1', port, 1000);
      assert.equal(ok, true);
    } finally {
      srv.close();
    }
  });

  it('resolves false for a port nothing is listening on', async () => {
    // Port 1 is a privileged port essentially never bound in test environments.
    const ok = await remote._internal.probePort('127.0.0.1', 1, 300);
    assert.equal(ok, false);
  });

  it('resolves false (not rejects) on a connect timeout against a non-routable address', async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — reserved, never routable.
    const ok = await remote._internal.probePort('192.0.2.1', 22, 200);
    assert.equal(ok, false);
  });
});

describe('openclaw-remote runFile (#1529)', () => {
  it('passes arguments verbatim, with no shell in between', async () => {
    const hostile = 'a; echo PWNED $(whoami)';
    const { stdout } = await remote._runFile('printf', ['%s', hostile]);
    assert.equal(stdout, hostile);
  });

  it('rejects with the exit code and stderr', async () => {
    await assert.rejects(
      remote._runFile('sh', ['-c', 'echo denied >&2; exit 255']),
      (err) => {
        assert.equal(err.code, 255);
        assert.equal(err.stderr, 'denied\n');
        return true;
      }
    );
  });

  it('reports a timeout it caused, by name', async () => {
    await assert.rejects(
      remote._runFile('sleep', ['5'], { timeout: 100 }),
      (err) => wasTimedOut(err) && typeof err.code !== 'number' && err.message === 'timed out after 100ms'
    );
  });
});

describe('resolveReachableHost integration — lib/sessions.js#launchWebuiSession (#1531)', () => {
  const store = require('../lib/store');
  const tunnel = require('../lib/tunnel');
  let tmpDir, projectsDir, sessions, projectCounter = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-remote-sessions-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let originalTunnel;
  let originalProbe;
  const ensureCalls = [];
  beforeEach(() => {
    ensureCalls.length = 0;
    originalTunnel = { detectTunnel: tunnel.detectTunnel, ensureTunnel: tunnel.ensureTunnel };
    originalProbe = remote._internal.probePort;
    tunnel.detectTunnel = async () => ({ active: false, pid: null });
    tunnel.ensureTunnel = async (projectName, config) => { ensureCalls.push(config); return { ok: true }; };
  });
  afterEach(() => {
    Object.assign(tunnel, originalTunnel);
    remote._internal.probePort = originalProbe;
    remote._resolved.clear();
  });

  /** A fresh OpenClaw connection + project pair, never colliding with another test's. */
  function makeConnAndProject(overrides = {}) {
    projectCounter += 1;
    const conn = store.openclawConnections.create({
      name: `Fallback-${projectCounter}`,
      host: '192.0.2.1', // TEST-NET-1 (RFC 5737), never routable — primary never answers
      sshUser: 'u', sshKeyPath: '~/.ssh/k', localPort: 20000 + projectCounter, defaultMode: 'webui',
      ...overrides
    });
    const projDir = path.join(projectsDir, `fb-proj-${projectCounter}`);
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({ name: `fb-proj-${projectCounter}`, path: projDir, engine: `openclaw:${conn.id}` });
    return { conn, project };
  }

  it('wires fallbackHosts/connId into ensureTunnel\'s config, so a rebuild can use the resolver', async () => {
    const { conn, project } = makeConnAndProject({ fallbackHosts: ['203.0.113.5'] });
    const result = await sessions.launchWebuiSession(project.name, conn, `openclaw:${conn.id}`, store.engines.get('openclaw'), project);
    assert.equal(result.error, null);
    assert.equal(ensureCalls.length, 1);
    assert.deepEqual(ensureCalls[0].fallbackHosts, ['203.0.113.5']);
    assert.equal(ensureCalls[0].connId, conn.id);
    store.sessions.kill(result.session.id, 'test cleanup');
  });

  it('detectTunnel resolves the fallback-up host when the primary does not answer port 22', async () => {
    remote._internal.probePort = (host) => Promise.resolve(host === '203.0.113.5');
    const { conn, project } = makeConnAndProject({ fallbackHosts: ['203.0.113.5'] });
    let seenHost = null;
    tunnel.detectTunnel = async (port, host) => { seenHost = host; return { active: false, pid: null }; };
    const result = await sessions.launchWebuiSession(project.name, conn, `openclaw:${conn.id}`, store.engines.get('openclaw'), project);
    assert.equal(result.error, null);
    assert.equal(seenHost, '203.0.113.5', 'detectTunnel was called with the RESOLVED fallback host, not the dead primary');
    store.sessions.kill(result.session.id, 'test cleanup');
  });

  it('a connection with no fallbackHosts is unaffected — same host passed through, no probing', async () => {
    let probed = false;
    remote._internal.probePort = () => { probed = true; return Promise.resolve(true); };
    const { conn, project } = makeConnAndProject({ fallbackHosts: [] });
    const result = await sessions.launchWebuiSession(project.name, conn, `openclaw:${conn.id}`, store.engines.get('openclaw'), project);
    assert.equal(result.error, null);
    assert.equal(probed, false);
    assert.deepEqual(ensureCalls[0].fallbackHosts, []);
    store.sessions.kill(result.session.id, 'test cleanup');
  });
});

/**
 * Every `u@<host>` target in a generated launch command, in the order they
 * appear — the candidate order, independent of the exact shell glue
 * (`||`, or the exit-255-conditional chain I-Gate Round 7 requires) joining
 * them.
 * @param {string} cmd
 * @returns {string[]}
 */
function _hostsInOrder(cmd) {
  return [...cmd.matchAll(/\bu@([^\s"]+)/g)].map((m) => m[1]);
}

describe('resolveReachableHost integration — _buildLaunchCommand\'s synchronous activeHost read (#1531)', () => {
  const store = require('../lib/store');
  const sessions = require('../lib/sessions');
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-remote-cmd-'));
    store._setBasePath(tmpDir);
    store.init();
  });
  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  afterEach(() => { remote._resolved.clear(); });

  it('uses conn.host when nothing has resolved a route yet', () => {
    const conn = store.openclawConnections.create({
      name: 'CmdNoRoute', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw'
    });
    const project = { engineId: `openclaw:${conn.id}` };
    const cmd = sessions._buildLaunchCommand({}, project);
    assert.match(cmd, /u@192\.0\.2\.1/);
  });

  it('never chains at all when the connection has NO fallbackHosts — a single plain command, '
    + 'unchanged from before this feature existed', () => {
    // No manual cache entry here on purpose: a no-fallbackHosts connection
    // can never actually have one in practice — resolveReachableHost's own
    // fast path never writes to the cache when fallbackHosts is empty, and
    // store.openclawConnections.update() invalidates any pre-existing entry
    // on every edit (including one that removes fallbackHosts).
    const conn = store.openclawConnections.create({
      name: 'CmdWithRouteNoFallback', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw'
    });
    const project = { engineId: `openclaw:${conn.id}` };
    const cmd = sessions._buildLaunchCommand({}, project);
    assert.match(cmd, /^ssh -t -i "[^"]+" u@192\.0\.2\.1 "openclaw-cli"$/);
    assert.doesNotMatch(cmd, /\|\|/, 'no fallbackHosts at all means no chain, ever');
  });

  it('a FRESH cached route with fallbackHosts STILL chains — activeHost first, the rest behind it '
    + '(I-Gate Round 4 C1: a cached host can die inside its own TTL, so caching must never reduce '
    + 'the candidates offered, only their order)', () => {
    const conn = store.openclawConnections.create({
      name: 'CmdFreshRouteWithFallback', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw',
      fallbackHosts: ['203.0.113.9']
    });
    remote._resolved.set(conn.id, { activeHost: '203.0.113.9', fallbackUsed: true, resolvedAt: Date.now() });
    const project = { engineId: `openclaw:${conn.id}` };
    const cmd = sessions._buildLaunchCommand({}, project);
    assert.deepEqual(_hostsInOrder(cmd), ['203.0.113.9', '192.0.2.1'],
      'the cached route goes FIRST, but conn.host is still offered as a fallback, not dropped');
  });

  it('an EXPIRED cached route (past RESOLUTION_TTL_MS) is treated as no route at all — getActiveRoute '
    + 'returns null, and the launch command chains primary + fallback in their original order', () => {
    const conn = store.openclawConnections.create({
      name: 'CmdExpiredRoute', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw',
      fallbackHosts: ['203.0.113.9']
    });
    remote._resolved.set(conn.id, { activeHost: '203.0.113.9', fallbackUsed: true, resolvedAt: Date.now() - 120_000 });
    assert.equal(remote.getActiveRoute(conn.id), null, 'the TTL check itself must report this route as gone');

    const project = { engineId: `openclaw:${conn.id}` };
    const cmd = sessions._buildLaunchCommand({}, project);
    assert.deepEqual(_hostsInOrder(cmd), ['192.0.2.1', '203.0.113.9'],
      'no fresh route cached, so the primary leads, same as a cold cache');
  });

  it('a fresh cached route that has since gone dead is actually bypassed by the chain, for real — '
    + 'executed through a real shell with a stub ssh binary, not just asserted on the command string', () => {
    const execSync = require('node:child_process').execSync;
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stub-ssh-'));
    const stubPath = path.join(stubDir, 'ssh');
    fs.writeFileSync(stubPath, [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  case "$a" in',
      // The CACHED host now fails (it died inside its own TTL window);
      // the ORIGINAL primary, offered as the chain's second candidate,
      // answers instead.
      '    *@203.0.113.9) exit 255 ;;',
      '    *@192.0.2.1) exit 0 ;;',
      '  esac',
      'done',
      'exit 1',
      ''
    ].join('\n'), { mode: 0o755 });

    try {
      const conn = store.openclawConnections.create({
        name: 'CmdFreshRouteDead', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw',
        fallbackHosts: ['203.0.113.9']
      });
      remote._resolved.set(conn.id, { activeHost: '203.0.113.9', fallbackUsed: true, resolvedAt: Date.now() });
      const project = { engineId: `openclaw:${conn.id}` };
      const cmd = sessions._buildLaunchCommand({}, project);
      assert.doesNotThrow(() => {
        execSync(cmd, { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }, stdio: 'pipe' });
      }, 'the chain must succeed by falling through to the original primary once the cached host fails');
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('a COLD cache with fallbackHosts emits an ordered ||-chain trying every candidate, '
    + 'not just the dead primary (I-Gate Round 3 C1)', () => {
    const conn = store.openclawConnections.create({
      name: 'CmdColdCache', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw',
      fallbackHosts: ['100.64.0.2']
    });
    remote.invalidateResolvedHost(conn.id); // explicit, even though nothing cached it yet
    const project = { engineId: `openclaw:${conn.id}` };
    const cmd = sessions._buildLaunchCommand({}, project);
    assert.deepEqual(_hostsInOrder(cmd), ['192.0.2.1', '100.64.0.2']);
  });

  it('refuses the launch if ANY candidate host is unsafe, not just the one about to be used', () => {
    const conn = store.openclawConnections.get(
      store.openclawConnections.create({
        name: 'CmdUnsafeFallback', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw'
      }).id
    );
    // fallbackHosts is normally validated at write time; reach past that to
    // prove this function's OWN defense-in-depth check, not the store's.
    const db = store.getDb();
    db.prepare('UPDATE openclaw_connections SET fallback_hosts = ? WHERE id = ?')
      .run(JSON.stringify(['a; rm -rf /']), conn.id);
    const project = { engineId: `openclaw:${conn.id}` };
    assert.equal(sessions._buildLaunchCommand({}, project), undefined);
  });

  it('a fresh (cold-cache) interactive launch actually connects to the fallback host when the '
    + 'primary refuses — executed for real, not just asserted on the command string', () => {
    const execSync = require('node:child_process').execSync;
    // A stub `ssh` on PATH: exits 255 (connection refused) for the primary,
    // 0 (connected) for the fallback — exactly ssh's own exit code for a
    // refused connection vs. a successful one.
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stub-ssh-'));
    const stubPath = path.join(stubDir, 'ssh');
    fs.writeFileSync(stubPath, [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  case "$a" in',
      '    *@192.0.2.1) exit 255 ;;',
      '    *@100.64.0.2) exit 0 ;;',
      '  esac',
      'done',
      'exit 1',
      ''
    ].join('\n'), { mode: 0o755 });

    try {
      const conn = store.openclawConnections.create({
        name: 'CmdColdCacheExec', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw',
        fallbackHosts: ['100.64.0.2']
      });
      const project = { engineId: `openclaw:${conn.id}` };
      const cmd = sessions._buildLaunchCommand({}, project);
      // The real shell evaluates the || chain: 255 (primary) is non-zero, so
      // it falls through to the fallback, which exits 0 — the WHOLE chain
      // succeeds only because the fallback actually got tried and answered.
      assert.doesNotThrow(() => {
        execSync(cmd, { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }, stdio: 'pipe' });
      }, 'the chain must succeed via the fallback host, not hang on or fail with only the dead primary');
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('a connected host whose remote command exits nonzero is invoked ONLY ONCE — never retried '
    + 'against the fallback (I-Gate Round 7 C1: OpenSSH exits 255 ONLY on a transport/connection '
    + 'failure; any other nonzero is the REMOTE COMMAND\'s own status, and a plain || chain cannot '
    + 'tell the two apart)', () => {
    const execSync = require('node:child_process').execSync;
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stub-ssh-'));
    const stubPath = path.join(stubDir, 'ssh');
    const logPath = path.join(stubDir, 'invocations.log');
    fs.writeFileSync(stubPath, [
      '#!/bin/sh',
      `echo "$@" >> "${logPath}"`,
      'for a in "$@"; do',
      '  case "$a" in',
      // The primary CONNECTS fine, but the remote `openclaw-cli` itself
      // reports an application error (exit 1, NOT a connection failure).
      '    *@192.0.2.1) exit 1 ;;',
      // The fallback would happily succeed IF it were ever invoked.
      '    *@100.64.0.2) exit 0 ;;',
      '  esac',
      'done',
      'exit 1',
      ''
    ].join('\n'), { mode: 0o755 });

    try {
      const conn = store.openclawConnections.create({
        name: 'CmdAppErrorNoRetry', host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw',
        fallbackHosts: ['100.64.0.2']
      });
      const project = { engineId: `openclaw:${conn.id}` };
      const cmd = sessions._buildLaunchCommand({}, project);

      let caught = null;
      try {
        execSync(cmd, { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` }, stdio: 'pipe' });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'the overall launch must exit nonzero, preserving the application error');
      assert.equal(caught.status, 1, 'the EXACT application exit code must survive, not be swallowed by a retry');

      const log = fs.readFileSync(logPath, 'utf8');
      const invokedHosts = [...log.matchAll(/u@([^\s]+)/g)].map((m) => m[1]);
      assert.deepEqual(invokedHosts, ['192.0.2.1'],
        'the fallback must NEVER be invoked once the primary actually connected and ran the remote command');
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

describe('resolveReachableHost integration — POST /api/openclaw/test (#1531)', () => {
  const { createServer } = require('../server');
  const http = require('node:http');
  const store = require('../lib/store');
  const { operatorHeaders } = require('./_shared-docs-callers');
  let tmpDir, server, baseUrl;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-remote-testroute-'));
    store._setBasePath(tmpDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let originalRunShell, originalProbe;
  beforeEach(() => {
    originalRunShell = remote._internal.runShell;
    originalProbe = remote._internal.probePort;
  });
  afterEach(() => {
    remote._internal.runShell = originalRunShell;
    remote._internal.probePort = originalProbe;
    remote._resolved.clear();
  });

  /**
   * POST a JSON body to the running server.
   * @param {string} urlPath
   * @param {object} body
   * @returns {Promise<{status: number, data: object}>}
   */
  function post(urlPath, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...operatorHeaders(server) }
      }, (res) => {
        let raw = ''; res.on('data', (c) => raw += c);
        res.on('end', () => { let data; try { data = JSON.parse(raw); } catch { data = raw; } resolve({ status: res.statusCode, data }); });
      });
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('the ssh probe targets the resolved fallback host, not the dead primary', async () => {
    remote._internal.probePort = (host) => Promise.resolve(host === '203.0.113.7');
    // Two shell calls happen (the ssh probe, then the curl healthz probe) --
    // capture all of them and find the ssh one, rather than the last one.
    const cmds = [];
    remote._internal.runShell = async (cmd) => { cmds.push(cmd); return { stdout: 'ok\n', stderr: '' }; };
    const { status, data } = await post('/api/openclaw/test', {
      host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', fallbackHosts: ['203.0.113.7']
    });
    assert.equal(status, 200);
    assert.equal(data.ssh, true);
    const sshCmd = cmds.find((c) => c.startsWith('ssh'));
    assert.match(sshCmd, /u@203\.0\.113\.7/);
  });

  it('refuses an unsafe fallbackHosts entry before any probe or ssh runs', async () => {
    let ran = false;
    remote._internal.probePort = () => { ran = true; return Promise.resolve(true); };
    const { status, data } = await post('/api/openclaw/test', {
      host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k', fallbackHosts: ['a; rm -rf /']
    });
    assert.equal(status, 400);
    assert.equal(data.code, 'BAD_REQUEST');
    assert.equal(ran, false);
  });

  it('a request with no fallbackHosts and no id behaves exactly as before — no probing', async () => {
    let probed = false;
    remote._internal.probePort = () => { probed = true; return Promise.resolve(true); };
    const cmds = [];
    remote._internal.runShell = async (cmd) => { cmds.push(cmd); return { stdout: 'ok\n', stderr: '' }; };
    const { status, data } = await post('/api/openclaw/test', { host: '192.0.2.1', sshUser: 'u', sshKeyPath: '~/.ssh/k' });
    assert.equal(status, 200);
    assert.equal(data.ssh, true);
    assert.equal(probed, false);
    const sshCmd = cmds.find((c) => c.startsWith('ssh'));
    assert.match(sshCmd, /u@192\.0\.2\.1/);
  });
});
