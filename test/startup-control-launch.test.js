'use strict';

/*
 * The launch and teardown halves of startupControl (#1825 B2): a supported
 * Codex launch starts a per-launch app-server through the adapter's seams,
 * attaches the pane with --remote ahead of the already-validated mode args,
 * and records the channel against the session; an unverified version or a
 * failed start launches today's command unchanged and records why; the
 * channel ends with the session (kill) and the reaper closes channels of
 * ended sessions, signalling only a process it can prove is its own.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');
const codex = require('../lib/startup-control-codex');

describe('startupControl at launch and teardown (codex)', () => {
  let tempDir;
  let prevBase;
  let projectsDir;
  let sessions;
  let realSeams;
  let counter = 0;
  const real = {};
  const calls = { spawn: [], kills: [], created: [] };

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sc-launch-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    projectsDir = path.join(tempDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    config.authEnabled = false;
    store.config.save(config);
    sessions = require('../lib/sessions');
    real.create = tmux.createSession;
    real.has = tmux.hasSession;
    real.kill = tmux.killSession;
    real.probe = tmux.probeSession;
    real.detect = enginesModule.detectEngine;
    real.sendKeys = tmux.sendKeys;
    tmux.sendKeys = () => true;
    realSeams = { ...codex._seams };
  });

  after(() => {
    Object.assign(codex._seams, realSeams);
    tmux.sendKeys = real.sendKeys;
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Seams that stand in for a healthy Codex install: the probe answers the
   * verified version for the exact executable, spawn returns a fake child,
   * the socket "appears" at a short path, and ps agrees the pid is ours.
   * @param {object} [over] - Seam overrides.
   * @returns {void}
   */
  function healthySeams(over = {}) {
    calls.spawn.length = 0;
    calls.kills.length = 0;
    calls.created.length = 0;
    let pidN = 5000;
    const spawned = new Map();
    Object.assign(codex._seams, {
      execFileSync: (bin) => {
        if (bin !== '/opt/fake/bin/codex') throw new Error(`probed the wrong executable: ${bin}`);
        return 'codex-cli 0.156.1\n';
      },
      spawn: (bin, args, opts) => {
        const pid = ++pidN;
        const socketPath = args[2].replace(/^unix:\/\//, '');
        spawned.set(pid, socketPath);
        calls.spawn.push({ bin, args, opts, pid });
        return { pid, unref() {} };
      },
      psBirth: (pid) => (spawned.has(pid) ? `birth-${pid}` : ''),
      psCommand: (pid) => (spawned.has(pid) ? `codex app-server --listen unix://${spawned.get(pid)}` : 'something else'),
      resolveSocket: (requested) => `/private/tmp/fake-daemon/${path.basename(requested, '.sock')}`,
      sleep: () => {},
      kill: (pid, sig) => calls.kills.push([pid, sig]),
      ...over
    });
    codex._internal._version.version = null;
  }

  /**
   * Run `fn` with tmux creation and engine detection stubbed, restoring them
   * after, so the launch's deferred engine-init timers later find no pane and
   * bail instead of polling a session that never existed.
   * @param {() => *} fn - Work.
   * @returns {*}
   */
  function withStubbedTmux(fn) {
    tmux.createSession = (name, opts) => { calls.created.push({ name, opts }); return true; };
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/opt/fake/bin/codex' });
    try {
      return fn();
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  /**
   * Create and launch a codex project.
   * @param {object} [opts] - Launch options.
   * @returns {{project: object, session: object, sequence: object, command: string}}
   */
  function launched(opts = {}) {
    counter += 1;
    const name = `sc-${counter}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'codex' });
    // No prime paste: the deferred paste would poll a pane that never exists
    // for its readiness window and keep the process alive; the channel and
    // the launch sequence are unaffected by it.
    const result = withStubbedTmux(() => sessions.launchSession(name, { primePrompt: false, ...opts }));
    assert.ok(result.session, result.error);
    const created = calls.created[calls.created.length - 1];
    return { project, session: result.session, sequence: store.launchSequences.getBySession(result.session.id), command: created.opts.command };
  }

  beforeEach(() => {
    store.getDb().prepare('DELETE FROM startup_control_channels').run();
  });

  it('starts the app-server with the exact executable, attaches the pane with --remote before the mode args, and records the channel', () => {
    healthySeams();
    const l = launched({ launchMode: 'fullAuto' });
    assert.equal(calls.spawn.length, 1);
    const sp = calls.spawn[0];
    assert.equal(sp.bin, '/opt/fake/bin/codex');
    assert.deepEqual(sp.args.slice(0, 2), ['app-server', '--listen']);
    assert.match(sp.args[2], /^unix:\/\/.+\/run\/startup-control\/[0-9a-f]{16}\.sock$/);
    assert.ok(sp.args[2].includes(tempDir), 'the socket is requested under the store base path');
    assert.equal(sp.opts.detached, true);
    assert.equal(sp.opts.cwd, l.project.path);
    assert.match(l.command, /codex --remote unix:\/\/\/private\/tmp\/fake-daemon\/[0-9a-f]{16} --ask-for-approval never --sandbox workspace-write/);
    const channel = store.startupControlChannels.getOpenBySession(l.session.id);
    assert.ok(channel, 'a channel row is open for the session');
    assert.equal(channel.sequenceId, l.sequence.id);
    assert.equal(channel.adapter, 'codex');
    assert.equal(channel.engineId, 'codex');
    assert.equal(channel.adapterState.pid, sp.pid);
    assert.equal(channel.adapterState.birth, `birth-${sp.pid}`);
    assert.equal(channel.adapterState.engineVersion, '0.156.1');
    assert.equal(channel.adapterState.enginePath, '/opt/fake/bin/codex');
    assert.ok(!JSON.stringify(channel).includes(l.sequence.launchId), 'the launch bearer is not in the channel row');
  });

  it('an unverified version launches today\'s command with no channel, and so does a failed start', () => {
    healthySeams({ execFileSync: () => 'codex-cli 0.150.0\n' });
    let l = launched();
    assert.equal(calls.spawn.length, 0, 'no app-server for an unverified version');
    assert.ok(!l.command.includes('--remote'));
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);

    healthySeams({ spawn: () => { throw new Error('ENOENT'); } });
    l = launched();
    assert.ok(!l.command.includes('--remote'));
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);

    healthySeams({ resolveSocket: () => null, now: (() => { let t = 0; return () => (t += 3000); })() });
    l = launched();
    assert.ok(!l.command.includes('--remote'), 'a socket that never appears means no channel');
    assert.deepEqual(calls.kills, [[-calls.spawn[0].pid, 'SIGTERM']], 'the server that never opened its socket is stopped');
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);
  });

  it('a resolved socket path unsafe for a shell command is refused, not interpolated', () => {
    healthySeams({ resolveSocket: () => '/private/tmp/evil $(touch x)' });
    const l = launched();
    assert.ok(!l.command.includes('--remote'));
    assert.ok(!l.command.includes('$('));
    assert.equal(calls.kills.length, 1);
  });

  it('killing the session ends the channel: the process group is signalled and the row records the teardown', () => {
    healthySeams();
    const l = launched();
    const pid = calls.spawn[0].pid;
    const r = sessions.killSession(l.project.name, 'test');
    assert.equal(r.error, null);
    assert.deepEqual(calls.kills, [[-pid, 'SIGTERM']]);
    const channel = store.getDb().prepare('SELECT * FROM startup_control_channels WHERE session_id = ?').get(l.session.id);
    assert.equal(channel.state, 'closed');
    assert.equal(channel.close_reason, 'session killed');
    assert.equal(channel.teardown, 'ok');
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);
  });

  it('a session that ended without teardown is reaped, and a pid that is not ours is never signalled', () => {
    healthySeams();
    const l = launched();
    const pid = calls.spawn[0].pid;
    store.sessions.kill(l.session.id, 'ended elsewhere');
    // The pid was reused by an unrelated process since.
    codex._seams.psCommand = () => 'python3 unrelated.py';
    const out = codex.reap();
    assert.equal(out.examined, 1);
    assert.equal(out.closed, 1);
    assert.deepEqual(calls.kills, [], `pid ${pid} was not signalled`);
    const channel = store.getDb().prepare('SELECT * FROM startup_control_channels WHERE session_id = ?').get(l.session.id);
    assert.equal(channel.state, 'closed');
    assert.equal(channel.teardown, 'skipped');
    assert.match(channel.close_reason, /session killed/);
    assert.deepEqual(codex.reap(), { examined: 0, closed: 0 }, 'idempotent');
  });

  it('a live session\'s channel is left alone by the reaper', () => {
    healthySeams();
    const l = launched();
    assert.deepEqual(codex.reap(), { examined: 1, closed: 0 });
    assert.ok(store.startupControlChannels.getOpenBySession(l.session.id));
  });

  it('relaunching after a dead pane ends the old channel before the new one opens', () => {
    healthySeams();
    const l = launched();
    const firstPid = calls.spawn[0].pid;
    // The pane died: the next launch of the project finds the stale row.
    tmux.probeSession = () => ({ answered: true, live: false });
    try {
      const again = withStubbedTmux(() => sessions.launchSession(l.project.name, { primePrompt: false }));
      assert.ok(again.session, again.error);
      assert.ok(calls.kills.some(([pid]) => pid === -firstPid), 'the old app-server was signalled');
      const open = store.startupControlChannels.getOpenBySession(again.session.id);
      assert.ok(open && open.adapterState.pid !== firstPid, 'a new channel is open for the new session');
    } finally {
      tmux.probeSession = real.probe;
    }
  });
});
