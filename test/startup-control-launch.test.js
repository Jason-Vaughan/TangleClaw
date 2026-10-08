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
const wrapPipeline = require('../lib/wrap-pipeline');
const launchBootstrap = require('../lib/launch-bootstrap');
const launchKickoff = require('../lib/launch-kickoff');
const wrapRunRegistry = require('../lib/wrap-run-registry');

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
    // The deferred bootstrap and kickoff are stubbed for the whole file: the
    // real bootstrap of a native launch would wait on a pane that does not
    // exist for its 90 s window and keep this process alive. Their hops are
    // proven in test/launch-bootstrap-wiring.test.js.
    real.bootstrap = launchBootstrap.bootstrap;
    real.kickoff = launchKickoff.kickoff;
    launchBootstrap.bootstrap = () => Promise.resolve('fired');
    launchKickoff.kickoff = () => Promise.resolve('not-silent');
  });

  after(() => {
    Object.assign(codex._seams, realSeams);
    launchBootstrap.bootstrap = real.bootstrap;
    launchKickoff.kickoff = real.kickoff;
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
  /** What the stubbed creation says its pane was; undefined leaves `born` untouched, as an older tmux seam would. */
  let bornPane;

  function withStubbedTmux(fn) {
    tmux.createSession = (name, opts) => { calls.created.push({ name, opts }); if (opts.born && bornPane !== undefined) Object.assign(opts.born, bornPane); return true; };
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
    assert.match(l.command, /; \/opt\/fake\/bin\/codex --remote unix:\/\/\/private\/tmp\/fake-daemon\/[0-9a-f]{16} --ask-for-approval never --sandbox workspace-write$/, 'the pane runs the executable the app-server was started from, by path');
    assert.ok(!l.command.includes('--no-daemon'), 'a per-launch --remote server needs no legacy daemon isolation');
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

  it('the pane id the creating tmux call printed is what the launch stores on its channel, and no later lookup replaces it (#2186)', () => {
    healthySeams();
    const realSole = tmux.solePaneId;
    let asked = 0;
    // The session's one pane, if anyone asked, is already a replacement.
    tmux.solePaneId = () => { asked += 1; return '%40'; };
    try {
      bornPane = { paneId: '%31', server: '4242.1790431343' };
      const l = launched();
      assert.equal(store.startupControlChannels.getOpenBySession(l.session.id).adapterState.paneId, '%31');
      assert.equal(store.startupControlChannels.getOpenBySession(l.session.id).adapterState.paneServer, '4242.1790431343');
      assert.equal(asked, 0, 'the launch never asks the session which pane it has');

      for (const none of [{ paneId: null, server: null }, undefined, { paneId: 'not-a-pane', server: '4242.1790431343' }, { paneId: '%31', server: null }]) {
        bornPane = none;
        const l2 = launched();
        const row = store.startupControlChannels.getOpenBySession(l2.session.id);
        assert.ok(row, 'the launch still gets its channel');
        assert.equal(row.adapterState.paneServer, undefined);
        assert.equal(row.adapterState.paneId, undefined, `no pane on record when creation printed ${JSON.stringify(none)}`);
      }
      assert.equal(asked, 0);
    } finally {
      bornPane = undefined;
      tmux.solePaneId = realSole;
    }
  });

  it('a launch that started its channel and has a sequence selects the native path, frozen on the sequence row; every other launch is legacy (B3 F1)', async () => {
    healthySeams();
    // The question here is the durable selection the launch wrote; the hop to
    // the bootstrap is proven in test/launch-bootstrap-wiring.test.js.
    const native = launched({ primePrompt: true });
    assert.equal(native.sequence.applicability, 'applicable');
    assert.equal(native.sequence.startupDelivery, 'native');
    assert.ok(store.startupControlChannels.getOpenBySession(native.session.id), 'the channel the selection rests on is open');

    const noSequence = launched();
    assert.equal(noSequence.sequence.applicability, 'not-applicable');
    assert.equal(noSequence.sequence.startupDelivery, 'legacy', 'a channel with nothing to read through it is not a native launch');
    assert.ok(store.startupControlChannels.getOpenBySession(noSequence.session.id), 'the channel still opened; only the first turn stays legacy');

    // 0.157.1: not verified for the native channel, verified for `--no-daemon`,
    // so it still launches. An unlisted version no longer launches at all (#2233).
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    const unverified = launched();
    assert.equal(unverified.sequence.startupDelivery, 'legacy');
    assert.equal(store.startupControlChannels.getOpenBySession(unverified.session.id), null);
  });

  it('a channel whose row could not be recorded is closed out as unavailable, so a native launch never shows no channel at all', () => {
    healthySeams();
    const realAttach = codex.attachLaunch;
    codex.attachLaunch = (handle, launch) => { codex.abandonLaunch(handle, 'test: row not recorded'); return null; };
    let l;
    try {
      l = launched({ primePrompt: true });
    } finally {
      codex.attachLaunch = realAttach;
    }
    assert.equal(l.sequence.startupDelivery, 'native', 'the selection was frozen before the attach and stands');
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);
    const latest = store.startupControlChannels.getLatestBySession(l.session.id);
    assert.ok(latest, 'a closed row names the cause');
    assert.equal(latest.state, 'closed');
    assert.equal(latest.adapter, 'codex');
    assert.match(latest.closeReason, /^channel_unavailable: the channel row could not be recorded/);
    assert.equal(calls.kills.length, 1, 'the server the row would have named was stopped');
  });

  it('the app-server inherits the pane\'s environment: the PATH floor and the launch identity `tc` needs (B3)', () => {
    healthySeams();
    const l = launched();
    const env = calls.spawn[0].opts.env;
    // With --remote the agent loop and its shell tools run in the app-server,
    // not in the pane; a `tc start next` the fired prompt asks for runs here.
    assert.equal(env.TANGLECLAW_LAUNCH_ID, l.sequence.launchId, 'the launch id the server resolves to this session');
    assert.equal(env.TANGLECLAW_PROJECT_ID, String(l.project.id));
    assert.ok(env.PATH.startsWith(`${path.join(__dirname, '..', 'bin')}:`), `bin/tc leads PATH: ${env.PATH.slice(0, 80)}`);
    assert.equal(env.HOME, process.env.HOME, 'TangleClaw\'s own environment is still underneath');
    const created = calls.created[calls.created.length - 1];
    assert.equal(created.opts.env.TANGLECLAW_LAUNCH_ID, env.TANGLECLAW_LAUNCH_ID, 'pane and server carry the same identity');
  });

  it('a version without a verified native channel launches the exact executable with --no-daemon, and so does a native channel that fails to start', () => {
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    let l = launched({ launchMode: 'fullAuto' });
    assert.equal(calls.spawn.length, 0, 'an unverified native protocol does not start an app-server');
    assert.ok(!l.command.includes('--remote'));
    assert.match(l.command, /; \/opt\/fake\/bin\/codex --ask-for-approval never --sandbox workspace-write --no-daemon$/);
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);

    healthySeams({ spawn: () => { throw new Error('ENOENT'); } });
    l = launched();
    assert.ok(!l.command.includes('--remote'));
    assert.match(l.command, /; \/opt\/fake\/bin\/codex --no-daemon$/);
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);

    healthySeams({ resolveSocket: () => null, now: (() => { let t = 0; return () => (t += 3000); })() });
    l = launched();
    assert.ok(!l.command.includes('--remote'), 'a socket that never appears means no channel');
    assert.match(l.command, /; \/opt\/fake\/bin\/codex --no-daemon$/);
    assert.deepEqual(calls.kills, [[-calls.spawn[0].pid, 'SIGTERM']], 'the server that never opened its socket is stopped');
    assert.equal(store.startupControlChannels.getOpenBySession(l.session.id), null);
  });

  /**
   * Launch a codex project that is expected to be refused. tmux creation is
   * booby-trapped: a regressed guard fails loudly here instead of the test
   * passing over a pane that was started.
   * @returns {{result: object, name: string}}
   */
  function refused(detectPath) {
    counter += 1;
    const name = `sc-${counter}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name, path: dir, engine: 'codex' });
    const killed = [];
    const result = withStubbedTmux(() => {
      tmux.createSession = () => { throw new Error('a refused launch must not create a tmux session'); };
      tmux.hasSession = () => true;
      tmux.killSession = (n) => { killed.push(n); return true; };
      if (detectPath) enginesModule.detectEngine = () => ({ available: true, path: detectPath });
      return sessions.launchSession(name, { primePrompt: false });
    });
    assert.deepEqual(killed, [], 'a refused launch kills no existing tmux session either');
    return { result, name };
  }

  // Until #2233 each of these launched the bare `codex` command, which leaves
  // the pane on Codex's shared background process. Architect ruling A163 R3
  // reverses that contract: such a launch does not start.
  for (const [label, probe, reasonCode] of [
    ['a version that predates the isolation flag', () => 'codex-cli 0.150.0\n', 'version_unverified'],
    ['a version newer than any verified one', () => 'codex-cli 0.161.0\n', 'version_unverified'],
    ['version output the probe cannot parse', () => 'something unexpected\n', 'version_unknown'],
    ['a version probe that fails', () => { throw new Error('spawn codex ENOENT'); }, 'version_unknown']
  ]) {
    it(`refuses the launch for ${label}: no pane, no session row, and the operator is told what to install`, () => {
      healthySeams({ execFileSync: probe });
      const before = store.getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
      const { result, name } = refused();
      assert.equal(result.session, null);
      assert.equal(result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
      assert.equal(result.isolation.reasonCode, reasonCode);
      assert.match(result.error, new RegExp(`did not start the engine for project "${name}"`));
      assert.match(result.error, /0\.156\.1 or 0\.157\.1/);
      assert.match(result.error, /Nothing was started/);
      assert.equal(result.isolation.recovery.includes('launch again'), true);
      assert.equal(calls.spawn.length, 0, 'no app-server was started for it');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before, 'no session row was written');
    });
  }

  it('a launch refused after its app-server started stops that server', () => {
    healthySeams();
    const realJudge = codex.judgeLaunchCommand;
    codex.judgeLaunchCommand = () => ({ applies: true, allowed: false, reasonCode: 'command_unisolated', reason: 'test refusal.', recovery: 'test recovery.' });
    let out;
    try {
      out = refused();
    } finally {
      codex.judgeLaunchCommand = realJudge;
    }
    assert.equal(out.result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
    assert.equal(calls.spawn.length, 1);
    assert.deepEqual(calls.kills, [[-calls.spawn[0].pid, 'SIGTERM']], 'the server this launch started is not left running');
  });

  it('the judgment reads the command that will run: a builder that falls back to the bare name is refused', () => {
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    const realIsolate = codex.isolateLaunch;
    // The builder reports it built nothing, so the launch falls through to the
    // historical hardening, which names `codex` and lets the pane's PATH pick.
    codex.isolateLaunch = (input) => ({ ...realIsolate(input), command: null });
    let out;
    try {
      out = refused();
    } finally {
      codex.isolateLaunch = realIsolate;
    }
    assert.equal(out.result.isolation.reasonCode, 'command_not_pinned');
  });

  it('an adapter that throws while building or judging is a refusal, never a launch', () => {
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    const realIsolate = codex.isolateLaunch;
    codex.isolateLaunch = () => { throw new Error('builder fault'); };
    try {
      assert.equal(refused().result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
    } finally {
      codex.isolateLaunch = realIsolate;
    }
    const realJudge = codex.judgeLaunchCommand;
    codex.judgeLaunchCommand = () => { throw new Error('judge fault'); };
    try {
      const { result } = refused();
      assert.equal(result.isolation.reasonCode, 'judgment_failed');
    } finally {
      codex.judgeLaunchCommand = realJudge;
    }
  });

  describe('a launch that plainly runs Codex and that no judge covered is refused (#2233)', () => {
    const BIN = '/opt/fake/bin/codex';
    const verified = { command: `${BIN} --no-daemon`, enginePath: BIN, probe: { version: '0.157.1', enginePath: BIN }, native: null };
    const registries = [
      ['no adapter registered', {}],
      ['an adapter without the judgment', { codex: { isolateLaunch: () => ({ applies: false }) } }],
      ['an adapter that says the launch is not its engine', { codex: { judgeLaunchCommand: () => ({ applies: false }) } }],
      ['an adapter that answers nothing', { codex: { judgeLaunchCommand: () => undefined } }]
    ];

    for (const [label, registry] of registries) {
      it(`refuses with ${label}, even for a command that would otherwise be allowed`, () => {
        const verdict = sessions._judgeLaunchIsolation('codex', verified, registry);
        assert.equal(verdict.allowed, false);
        assert.equal(verdict.reasonCode, 'no_judge');
        assert.match(verdict.reason, /would run codex/);
        assert.match(verdict.recovery, /Nothing was started/);
      });
    }

    it('recognises Codex by any one sign, each without the others', () => {
      const none = { command: 'wrapper --x', enginePath: '/opt/x/wrapper', probe: null, native: null };
      for (const [label, engineId, input] of [
        ['the engine id', 'codex', none],
        ['the profile id', 'my-engine', { ...none, engineProfile: { id: 'codex' } }],
        ['the profile launch command', 'my-engine', { ...none, engineProfile: { id: 'x', launch: { shellCommand: 'codex' } } }],
        ['a profile launch command given as a path', 'my-engine', { ...none, engineProfile: { id: 'x', launch: { shellCommand: '/usr/local/bin/codex' } } }],
        ['the profile detection target', 'my-engine', { ...none, engineProfile: { id: 'x', detection: { strategy: 'which', target: 'codex' } } }],
        ['the resolved executable', 'my-engine', { ...none, enginePath: BIN }],
        ['the command', 'my-engine', { ...none, command: 'codex --x' }],
        ['a command given as a path', 'my-engine', { ...none, command: `${BIN} --x` }]
      ]) {
        assert.equal(sessions._judgeLaunchIsolation(engineId, input, {}).reasonCode, 'no_judge', label);
      }
      assert.deepEqual(sessions._judgeLaunchIsolation('my-engine', { ...none, engineProfile: { id: 'x', launch: { shellCommand: 'wrapper' }, detection: { target: 'wrapper' } } }, {}),
        { allowed: true, isolation: 'not-applicable', adapterName: null }, 'a launch with no sign of Codex is not this check\'s concern');
      assert.equal(sessions._judgeLaunchIsolation('claude', { command: 'claude', enginePath: '/opt/fake/bin/claude', probe: null, native: null, engineProfile: store.engines.get('claude') }, {}).allowed, true);
    });

    it('a launch only the profile identifies as Codex is judged by the Codex adapter, not blamed on the install', () => {
      // Nothing the adapter can see by itself names Codex here; the launch site's reading reaches it.
      const input = { command: 'wrapper --x', enginePath: '/opt/x/wrapper', probe: { version: '0.157.1', enginePath: '/opt/x/wrapper' }, native: null,
        engineProfile: { id: 'x', launch: { shellCommand: 'wrapper' }, detection: { target: 'codex' } } };
      const verdict = sessions._judgeLaunchIsolation('my-engine', input);
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.adapterName, 'codex');
      assert.equal(verdict.reasonCode, 'executable_unverified', 'refused for what the executable is, not as no_judge');
      const built = sessions._isolatedLegacyLaunch('my-engine', 'wrapper --x', input.engineProfile, '/opt/x/wrapper');
      assert.ok(built, 'the builder is asked too');
      assert.equal(built.adapterName, 'codex');
      assert.equal(built.command, null, 'and builds nothing for a wrapper');
      // A wrapper whose command is otherwise everything an allowed launch is stays refused.
      const dressed = sessions._judgeLaunchIsolation('my-engine', { ...input, command: '/opt/x/wrapper --no-daemon' });
      assert.equal(dressed.reasonCode, 'executable_unverified');
    });

    it('a throwing judgment refuses whether or not another adapter would have answered', () => {
      const verdict = sessions._judgeLaunchIsolation('codex', verified, { broken: { judgeLaunchCommand: () => { throw new Error('fault'); } }, codex });
      assert.equal(verdict.reasonCode, 'judgment_failed');
    });

    it('a project launch with the Codex judgment missing starts nothing', () => {
      healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
      const realJudge = codex.judgeLaunchCommand;
      delete codex.judgeLaunchCommand;
      let out;
      try {
        out = refused();
      } finally {
        codex.judgeLaunchCommand = realJudge;
      }
      assert.equal(out.result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
      assert.equal(out.result.isolation.reasonCode, 'no_judge');
    });
  });

  it('a native launch whose server is not on a version verified for the channel is refused, and the server is stopped', () => {
    healthySeams();
    const realPrepare = codex.prepareLaunch;
    // The server came up and the command attaches to it, but its recorded
    // version is one the profile has not verified for attaching.
    codex.prepareLaunch = (input, deps) => {
      const prepared = realPrepare(input, deps);
      prepared.handle.state.engineVersion = '0.157.1';
      return prepared;
    };
    let out;
    try {
      out = refused();
    } finally {
      codex.prepareLaunch = realPrepare;
    }
    assert.equal(out.result.isolation.reasonCode, 'native_version_unverified');
    assert.ok(!out.result.error.includes('0.157.1 or') && !out.result.error.includes('or 0.157.1'), 'the message does not offer a version this path refuses');
    assert.equal(calls.spawn.length, 1);
    assert.deepEqual(calls.kills, [[-calls.spawn[0].pid, 'SIGTERM']]);
  });

  it('the native allowance reads the verified versions from the launch\'s own profile', () => {
    healthySeams();
    const realJudge = codex.judgeLaunchCommand;
    const seen = [];
    codex.judgeLaunchCommand = (input) => { seen.push(input); return realJudge(input); };
    try {
      launched();
    } finally {
      codex.judgeLaunchCommand = realJudge;
    }
    assert.deepEqual(seen[0].nativeVerifiedVersions, store.engines.get('codex').capabilities.startupControl.verifiedVersions);
    assert.equal(seen[0].native.engineVersion, '0.156.1');
  });

  describe('a Codex project whose resolved executable is not named codex is refused (#2233)', () => {
    const WRAP = '/opt/fake/bin/codex-wrapper';
    const rows = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n;

    it('on the native path: a wrapper reporting the natively verified version starts nothing and its prepared server is stopped', () => {
      // The wrapper prints the version the native channel is verified on, so the channel is prepared before the judgment sees it.
      healthySeams({ execFileSync: () => 'codex-cli 0.156.1\n' });
      const before = rows();
      const { result } = refused(WRAP);
      assert.equal(result.session, null);
      assert.equal(result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
      assert.equal(result.isolation.reasonCode, 'executable_unverified');
      assert.ok(result.error.includes(WRAP));
      assert.match(result.error, /real Codex executable/);
      assert.doesNotMatch(result.error, /Install a Codex version/);
      assert.equal(rows(), before, 'no session row');
      assert.equal(calls.spawn.length, 1, 'the native channel had been prepared');
      assert.equal(calls.spawn[0].bin, WRAP);
      assert.deepEqual(calls.kills, [[-calls.spawn[0].pid, 'SIGTERM']], 'and its server was stopped');
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM startup_control_channels WHERE state = 'open'").get().n, 0);
    });

    it('on the fallback path: a wrapper reporting a version verified for --no-daemon starts nothing', () => {
      healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
      const before = rows();
      const { result } = refused(WRAP);
      assert.equal(result.isolation.reasonCode, 'executable_unverified');
      assert.equal(calls.spawn.length, 0);
      assert.equal(rows(), before);
    });

    it('on relaunch: a project that launched on the real Codex is refused once its executable resolves to a wrapper', () => {
      healthySeams({ execFileSync: () => 'codex-cli 0.156.1\n' });
      const l = launched();
      tmux.probeSession = () => ({ answered: true, live: false });
      try {
        const again = withStubbedTmux(() => {
          tmux.createSession = () => { throw new Error('a refused relaunch must not create a tmux session'); };
          enginesModule.detectEngine = () => ({ available: true, path: WRAP });
          return sessions.launchSession(l.project.name, { primePrompt: false });
        });
        assert.equal(again.session, null);
        assert.equal(again.isolation.reasonCode, 'executable_unverified');
      } finally {
        tmux.probeSession = real.probe;
      }
    });

    it('the real Codex at the same moment still launches', () => {
      healthySeams({ execFileSync: () => 'codex-cli 0.156.1\n' });
      const l = launched();
      assert.match(l.command, /; \/opt\/fake\/bin\/codex --remote /);
    });
  });

  it('the command handed to tmux ends with exactly the command that was judged', () => {
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    const realJudge = codex.judgeLaunchCommand;
    const judged = [];
    codex.judgeLaunchCommand = (input) => { judged.push(input); return realJudge(input); };
    let l;
    try {
      l = launched({ launchMode: 'fullAuto' });
    } finally {
      codex.judgeLaunchCommand = realJudge;
    }
    assert.equal(judged.length, 1, 'one judgment per launch');
    assert.equal(judged[0].enginePath, '/opt/fake/bin/codex');
    assert.deepEqual(judged[0].probe, { version: '0.157.1', enginePath: '/opt/fake/bin/codex' });
    assert.ok(l.command.endsWith(`; ${judged[0].command}`), `tmux got ${l.command}, the judgment saw ${judged[0].command}`);
  });

  it('the judgment is given this launch\'s own probe, not the module\'s version cache', () => {
    // The probe answers a verified version once (the launch's own), and the
    // cache is then overwritten as another launch's probe would overwrite it.
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    const realIsolate = codex.isolateLaunch;
    codex.isolateLaunch = (input) => { const built = realIsolate(input); codex._internal._version.version = '0.161.0'; return built; };
    let l;
    try {
      l = launched();
    } finally {
      codex.isolateLaunch = realIsolate;
    }
    assert.match(l.command, /; \/opt\/fake\/bin\/codex --no-daemon$/, 'the launch is judged on what it measured');
  });

  it('an engine no adapter judges launches on its own command', () => {
    healthySeams();
    counter += 1;
    const name = `sc-${counter}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name, path: dir, engine: 'claude' });
    const realJudge = codex.judgeLaunchCommand;
    const verdicts = [];
    codex.judgeLaunchCommand = (input) => { const v = realJudge(input); verdicts.push(v); return v; };
    let result;
    try {
      result = withStubbedTmux(() => {
        enginesModule.detectEngine = () => ({ available: true, path: '/opt/fake/bin/claude' });
        return sessions.launchSession(name, { primePrompt: false });
      });
    } finally {
      codex.judgeLaunchCommand = realJudge;
    }
    assert.ok(result.session, result.error);
    assert.deepEqual(verdicts, [{ applies: false }], 'the Codex check was asked and said the launch is not its engine');
    const command = calls.created[calls.created.length - 1].opts.command;
    assert.match(command, /; claude( |$)/, 'the Claude command is the one it always was');
    assert.equal(calls.spawn.length, 0);
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

  it('a wrap that ends the session ends the channel too', () => {
    healthySeams();
    const l = launched();
    const pid = calls.spawn[0].pid;
    let r;
    tmux.hasSession = () => false;
    try {
      r = sessions.completeWrap(l.project.name, 'wrapped in a test');
    } finally {
      tmux.hasSession = real.has;
    }
    assert.equal(r.error, null, r.error);
    assert.deepEqual(calls.kills, [[-pid, 'SIGTERM']]);
    const channel = store.getDb().prepare('SELECT * FROM startup_control_channels WHERE session_id = ?').get(l.session.id);
    assert.equal(channel.state, 'closed');
    assert.equal(channel.close_reason, 'session wrapped');
  });

  it('a keep-running wrap retains the channel, and the wrap that ends the session ends it (E1)', async () => {
    healthySeams();
    const l = launched();
    const pid = calls.spawn[0].pid;
    const realRun = wrapPipeline.runWrapPipeline;
    const realKillSession = tmux.killSession;
    wrapPipeline.runWrapPipeline = async () => ({ ok: true, blockedAt: null, results: [], commitSha: null, summary: null, error: null });
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    try {
      wrapRunRegistry._resetForTests();
      const kept = await sessions.triggerWrap(l.project.name, { keepSessionRunning: true });
      assert.equal(kept.ok, true, kept.error);
      assert.equal(kept.sessionKept, true);
      assert.deepEqual(calls.kills, [], 'the app-server is left running with the session');
      const open = store.startupControlChannels.getOpenBySession(l.session.id);
      assert.ok(open, 'the channel row is still open after a keep-running wrap');

      wrapRunRegistry._resetForTests();
      const ended = await sessions.triggerWrap(l.project.name, { keepSessionRunning: false });
      assert.equal(ended.ok, true, ended.error);
      assert.equal(ended.lifecycleCompleted, true);
    } finally {
      wrapPipeline.runWrapPipeline = realRun;
      tmux.hasSession = real.has;
      tmux.killSession = realKillSession;
    }
    assert.deepEqual(calls.kills, [[-pid, 'SIGTERM']], 'the wrap that ended the session ended the channel');
    const channel = store.getDb().prepare('SELECT * FROM startup_control_channels WHERE session_id = ?').get(l.session.id);
    assert.equal(channel.state, 'closed');
    assert.equal(channel.close_reason, 'session wrapped');
  });

  it('the boot-time Medusa re-sync that finds a dead pane ends its channel (E1)', () => {
    healthySeams();
    const l = launched();
    const pid = calls.spawn[0].pid;
    store.projectConfig.save(l.project.path, { medusaEnabled: true });
    const tmuxName = tmux.toSessionName(l.project.name);
    // Only THIS pane is dead; every other fixture in the store is left alone.
    tmux.probeSession = (name) => (name === tmuxName
      ? { answered: true, live: false, cause: null }
      : { answered: true, live: true, cause: null });
    try {
      sessions.resyncMedusaListeners();
    } finally {
      tmux.probeSession = real.probe;
    }
    assert.equal(store.sessions.get(l.session.id).status, 'crashed');
    assert.deepEqual(calls.kills, [[-pid, 'SIGTERM']]);
    const channel = store.getDb().prepare('SELECT * FROM startup_control_channels WHERE session_id = ?').get(l.session.id);
    assert.equal(channel.state, 'closed');
    assert.equal(channel.close_reason, 'tmux session died');
  });

  it('a pane found dead by the status read ends the channel', () => {
    healthySeams();
    const l = launched();
    const pid = calls.spawn[0].pid;
    tmux.probeSession = () => ({ answered: true, live: false });
    try {
      sessions.getSessionStatus(l.project.name);
    } finally {
      tmux.probeSession = real.probe;
    }
    assert.equal(store.sessions.get(l.session.id).status, 'crashed');
    assert.deepEqual(calls.kills, [[-pid, 'SIGTERM']]);
    const channel = store.getDb().prepare('SELECT * FROM startup_control_channels WHERE session_id = ?').get(l.session.id);
    assert.equal(channel.state, 'closed');
    assert.equal(channel.close_reason, 'tmux session died');
  });

  it('a launch that could not start its channel records why, and a later fire cites it', async () => {
    healthySeams({ spawn: () => { throw new Error('ENOENT: no codex'); } });
    const l = launched();
    const last = store.startupControlChannels.getLatestBySession(l.session.id);
    assert.ok(last, 'a closed row records the reason');
    assert.equal(last.state, 'closed');
    assert.equal(last.adapter, 'codex');
    assert.match(last.closeReason, /^channel_unavailable: could not start the app-server: ENOENT/);
    assert.deepEqual(last.adapterState, {});
    const row = store.startupPrompts.insertFire({
      idempotencyKey: 'unavail-000001', projectId: l.project.id, sessionId: l.session.id, sequenceId: l.sequence.id, promptRevision: 1,
      promptTextDigest: 'd'.repeat(64), policyDigest: 'p'.repeat(64), callerKind: 'operator', callerClearance: 'operator-verified',
      callerProjectId: null, outcome: 'pending', payload: {}, payloadDigest: 'a'.repeat(64)
    });
    const handles = codex.fire({
      session: store.sessions.get(l.session.id), project: l.project, sequenceId: l.sequence.id, promptText: 'x', promptTextDigest: 'd'.repeat(64), payloadDigest: 'a'.repeat(64),
      onUpdate: (patch) => store.startupPrompts.updateFire(row.id, patch).fire
    });
    const settled = await handles.settled;
    assert.equal(settled.outcome, 'blocked');
    assert.equal(settled.reasonCode, 'channel_unavailable');
    assert.match(settled.reason, /could not start the app-server: ENOENT/);
  });

  it('an engine that declares no channel records nothing', () => {
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    const l = launched();
    const last = store.startupControlChannels.getLatestBySession(l.session.id);
    assert.ok(last, 'an unverified version is a reason worth recording');
    assert.match(last.closeReason, /^version_unverified/);
  });

  it('a session row the reaper cannot read is left alone, never treated as ended', () => {
    healthySeams();
    const l = launched();
    const realGet = store.sessions.get;
    store.sessions.get = (id) => { if (id === l.session.id) throw new Error('database locked'); return realGet.call(store.sessions, id); };
    let out;
    try {
      out = codex.reap();
    } finally {
      store.sessions.get = realGet;
    }
    assert.deepEqual(out, { examined: 1, closed: 0 });
    assert.deepEqual(calls.kills, [], 'an unreadable session is not a dead one');
    assert.ok(store.startupControlChannels.getOpenBySession(l.session.id), 'the channel stays open');
  });

  it('a channel whose adapter is not registered is closed on release without a signal, and says so', () => {
    healthySeams({ execFileSync: () => 'codex-cli 0.157.1\n' });
    const l = launched();
    store.getDb().prepare('DELETE FROM startup_control_channels WHERE session_id = ?').run(l.session.id);
    store.startupControlChannels.open({ sessionId: l.session.id, sequenceId: l.sequence.id, engineId: 'codex', adapter: 'not-registered', adapterState: { pid: 1 } });
    const r = sessions.killSession(l.project.name, 'test');
    assert.equal(r.error, null);
    assert.deepEqual(calls.kills, []);
    const channel = store.getDb().prepare('SELECT * FROM startup_control_channels WHERE session_id = ? AND adapter = ?').get(l.session.id, 'not-registered');
    assert.equal(channel.state, 'closed');
    assert.equal(channel.close_reason, 'session killed');
    assert.equal(channel.teardown, 'skipped: adapter not registered');
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
