'use strict';

/*
 * The launch path of the operator's launch-isolation override (#2229): a
 * Codex whose version cannot be shown isolated is refused, unless the
 * operator turned an override on for the install or for that project. Then it
 * starts on the exact executable that was probed, without the isolation flag,
 * and says so in the server log, the activity log, the launch's answer and
 * the isolation inventory. No other refusal is set aside.
 *
 * The store is a scratch one and the override is set through its own
 * accessor. tmux and the Codex executable are stood in for: no pane and no
 * process is started.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logger = require('../lib/logger');
const store = require('../lib/store');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');
const codex = require('../lib/startup-control-codex');
const launchBootstrap = require('../lib/launch-bootstrap');
const launchKickoff = require('../lib/launch-kickoff');
const inventory = require('../lib/launch-isolation-inventory');
const verbs = require('../lib/tc-verbs');
const { createServer } = require('../server');
const { operatorHeaders, sendAs } = require('./_shared-docs-callers');

const CODEX_BIN = '/opt/fake/bin/codex';
const UNLISTED = '0.170.0';

describe('a launch under the operator\'s launch-isolation override (#2229)', () => {
  let tempDir;
  let prevBase;
  let projectsDir;
  let sessions;
  let overrides;
  let counter = 0;
  let logged = [];
  let seamAsked = 0;
  const real = {};
  const created = [];

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-override-launch-'));
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
    overrides = store.launchIsolationOverrides;
    Object.assign(real, {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, sendKeys: tmux.sendKeys,
      detect: enginesModule.detectEngine, seams: { ...codex._seams },
      bootstrap: launchBootstrap.bootstrap, kickoff: launchKickoff.kickoff,
      effectiveFor: overrides.effectiveFor
    });
    tmux.sendKeys = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    tmux.createSession = (name, opts) => { created.push({ name, command: opts.command }); return true; };
    enginesModule.detectEngine = () => ({ available: true, path: CODEX_BIN });
    // The deferred bootstrap would wait on a pane that does not exist.
    launchBootstrap.bootstrap = () => Promise.resolve('fired');
    launchKickoff.kickoff = () => Promise.resolve('not-silent');
    // Counted, so a test can show a launch never asked for the override.
    overrides.effectiveFor = (id) => { seamAsked += 1; return real.effectiveFor.call(overrides, id); };
  });

  after(() => {
    overrides.effectiveFor = real.effectiveFor;
    Object.assign(codex._seams, real.seams);
    launchBootstrap.bootstrap = real.bootstrap;
    launchKickoff.kickoff = real.kickoff;
    tmux.createSession = real.create;
    tmux.hasSession = real.has;
    tmux.killSession = real.kill;
    tmux.sendKeys = real.sendKeys;
    enginesModule.detectEngine = real.detect;
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    created.length = 0;
    logged = [];
    seamAsked = 0;
    overrides.clear({ projectId: null });
    for (const row of overrides.list().projects) overrides.clear({ projectId: row.projectId });
    codexReports(`codex-cli ${UNLISTED}\n`);
    logger.setLevel('warn');
    logger.setConsoleStream({ write: (line) => { logged.push(String(line)); } });
  });

  afterEach(() => {
    logger.setConsoleStream(null);
    logger.setLevel('error');
    enginesModule.detectEngine = () => ({ available: true, path: CODEX_BIN });
  });

  /**
   * Have the stand-in Codex answer `--version` with this output; null makes the probe fail.
   * @param {string|null} output - What the executable prints.
   * @returns {void}
   */
  function codexReports(output) {
    codex._seams.execFileSync = () => {
      if (output === null) throw new Error('spawn codex ENOENT');
      return output;
    };
    codex._internal._version.version = null;
    codex._internal._unanswered.clear();
  }

  /**
   * Create a Codex project and launch it.
   * @param {object} [opts] - Launch options.
   * @returns {{project: object, result: object, command: (string|null)}} `command` is what tmux was handed, or null when no pane was created.
   */
  function launch(opts = {}) {
    counter += 1;
    const name = `ovr-${counter}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'codex' });
    const before = created.length;
    const result = sessions.launchSession(name, { primePrompt: false, ...opts });
    return { project, result, command: created.length > before ? created[created.length - 1].command : null };
  }

  /**
   * The activity events overridden launches wrote for a project.
   * @param {number} projectId - The project.
   * @returns {object[]}
   */
  function overriddenEvents(projectId) {
    return store.activity.query({ projectId, eventType: sessions.ISOLATION_OVERRIDDEN_EVENT });
  }

  describe('with no override', () => {
    it('refuses an unlisted version exactly as before: no pane, no session row, no record, and the refusal names the override once', () => {
      const { project, result, command } = launch();
      assert.equal(result.session, null);
      assert.equal(result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
      assert.equal(result.isolation.reasonCode, 'version_unverified');
      assert.equal(command, null, 'no tmux session was created');
      assert.equal('isolationOverride' in result, false);
      assert.deepEqual(overriddenEvents(project.id), []);
      assert.equal(result.isolation.recovery.split('launch-isolation override').length - 1, 1, 'the override is named once');
      assert.match(result.isolation.recovery, /An operator can instead allow this launch without isolation/);
      assert.equal(seamAsked, 1, 'the override is asked about once the launch is refused');
    });

    it('a launch on a verified version never asks for the override and carries no mark of one', () => {
      codexReports('codex-cli 0.157.1\n');
      overrides.set({ projectId: null });
      const { project, result, command } = launch();
      assert.ok(result.session, result.error);
      assert.match(command, /--no-daemon$/, 'it starts isolated, override or not');
      assert.equal(seamAsked, 0);
      assert.equal('isolationOverride' in result, false);
      assert.deepEqual(overriddenEvents(project.id), []);
    });
  });

  describe('with the project\'s own override', () => {
    it('starts that project on the exact probed executable, with its own arguments and no isolation flag, and leaves the launch-side records', () => {
      counter += 1;
      const name = `ovr-${counter}`;
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name, path: dir, engine: 'codex' });
      overrides.set({ projectId: project.id, setBy: 'jason' });
      const result = sessions.launchSession(name, { primePrompt: false, launchMode: 'fullAuto' });
      assert.ok(result.session, result.error);
      const command = created[created.length - 1].command;
      assert.ok(command.endsWith(`; ${CODEX_BIN} --ask-for-approval never --sandbox workspace-write`), command);
      assert.ok(!command.includes('--no-daemon') && !command.includes('--remote'), command);

      assert.deepEqual(result.isolationOverride, {
        refusal: 'version_unverified', versionRead: UNLISTED, scope: 'project', risk: sessions.ISOLATION_OVERRIDE_RISK
      });
      const events = overriddenEvents(project.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].sessionId, result.session.id);
      assert.deepEqual(events[0].detail, {
        role: 'project', engineId: 'codex', versionRead: UNLISTED, refusal: 'version_unverified',
        scope: 'project', setBy: 'jason', setAt: overrides.list().projects[0].setAt
      });
      const warning = logged.find((line) => line.includes('WITHOUT isolation'));
      assert.ok(warning, 'the server log carries a warning');
      for (const part of [`project "${name}"`, UNLISTED, 'version_unverified', 'may borrow another project']) {
        assert.ok(warning.includes(part), `the warning names ${part}: ${warning}`);
      }
      assert.ok(!logged.some((line) => line.includes('Launch isolation verified')), 'nothing says this launch was verified isolated');
    });

    it('another project is still refused, and so is the project once its override is cleared', () => {
      const first = launch();
      assert.equal(first.result.session, null);
      overrides.set({ projectId: first.project.id });
      const other = launch();
      assert.equal(other.result.code, 'LAUNCH_ISOLATION_UNVERIFIED', 'one project\'s override is not another\'s');
      assert.equal(other.command, null);

      const again = sessions.launchSession(first.project.name, { primePrompt: false });
      assert.ok(again.session, again.error);
      sessions.killSession(first.project.name);
      overrides.clear({ projectId: first.project.id });
      const after = sessions.launchSession(first.project.name, { primePrompt: false });
      assert.equal(after.code, 'LAUNCH_ISOLATION_UNVERIFIED', 'a cleared override stops the next launch');
    });
  });

  describe('with the install-wide override', () => {
    beforeEach(() => { overrides.set({ projectId: null }); });

    it('starts any project, and says the override is the install-wide one', () => {
      const { result, command, project } = launch();
      assert.ok(result.session, result.error);
      assert.ok(command.endsWith(`; ${CODEX_BIN}`), command);
      assert.equal(result.isolationOverride.scope, 'install');
      assert.equal(overriddenEvents(project.id)[0].detail.scope, 'install');
    });

    for (const [label, output] of [['prints no version', 'something unexpected\n'], ['cannot be run', null]]) {
      it(`covers a Codex that ${label} (version_unknown), and its records say the version was not read`, () => {
        codexReports(output);
        const { result, project } = launch();
        assert.ok(result.session, result.error);
        assert.equal(result.isolationOverride.refusal, 'version_unknown');
        assert.equal(result.isolationOverride.versionRead, null);
        assert.equal(overriddenEvents(project.id)[0].detail.versionRead, null);
        assert.ok(logged.some((line) => line.includes('WITHOUT isolation') && line.includes('not read')));
      });
    }

    it('does not cover a wrapper executable: refused before anything is run, and the override is never asked', () => {
      enginesModule.detectEngine = () => ({ available: true, path: '/opt/fake/bin/codex-wrapper' });
      const { result, command } = launch();
      assert.equal(result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
      assert.equal(result.isolation.reasonCode, 'executable_unverified');
      assert.equal(command, null);
      assert.equal(seamAsked, 0);
    });

    it('does not cover an executable path that cannot be named safely', () => {
      enginesModule.detectEngine = () => ({ available: true, path: '/opt/it\'s/codex' });
      const { result, command } = launch();
      assert.equal(result.isolation.reasonCode, 'executable_unresolved');
      assert.equal(command, null);
      assert.equal(seamAsked, 0);
    });

    it('does not cover a fault in building the command, or in judging it', () => {
      const realIsolate = codex.isolateLaunch;
      codex.isolateLaunch = () => { throw new Error('builder fault'); };
      try {
        const { result, command } = launch();
        assert.equal(result.isolation.reasonCode, 'judgment_failed');
        assert.equal(command, null);
      } finally {
        codex.isolateLaunch = realIsolate;
      }
      const realJudge = codex.judgeLaunchCommand;
      codex.judgeLaunchCommand = () => { throw new Error('judge fault'); };
      try {
        assert.equal(launch().result.isolation.reasonCode, 'judgment_failed');
      } finally {
        codex.judgeLaunchCommand = realJudge;
      }
      assert.equal(seamAsked, 0, 'neither fault reached the override');
    });

    it('does not cover a refusal an adapter did not mark overridable, whatever its code', () => {
      const realJudge = codex.judgeLaunchCommand;
      for (const verdict of [
        { applies: true, allowed: false, reasonCode: 'command_unisolated', reason: 'r.', recovery: 'c.', overridable: false },
        { applies: true, allowed: false, reasonCode: 'native_version_unverified', reason: 'r.', recovery: 'c.' },
        { applies: true, allowed: false, reasonCode: 'version_unverified', reason: 'r.', recovery: 'c.', overridable: 'yes' }
      ]) {
        codex.judgeLaunchCommand = () => verdict;
        try {
          const { result, command } = launch();
          assert.equal(result.isolation.reasonCode, verdict.reasonCode);
          assert.equal(command, null);
        } finally {
          codex.judgeLaunchCommand = realJudge;
        }
      }
      assert.equal(seamAsked, 0);
    });

    it('a refusal the version refusal was hiding is found on the overridden command, and stops the launch', () => {
      for (const [args, reasonCode] of [
        ['--remote unix:///tmp/someone-elses.sock', 'command_unisolated'],
        ['--no-daemon', 'command_unisolated'],
        ['--config $(id)', 'command_unparseable'],
        ['-- --no-daemon', 'command_unparseable']
      ]) {
        const attempt = sessions._overrideRefusedLaunch('codex',
          { allowed: false, reasonCode: 'version_unverified', reason: 'r.', recovery: 'c.', overridable: true },
          { launchCmd: `codex ${args}`, engineProfile: { id: 'codex', launch: { shellCommand: 'codex' } }, enginePath: CODEX_BIN, probe: { version: UNLISTED, enginePath: CODEX_BIN } },
          null);
        assert.equal(attempt.allowed, false, args);
        assert.equal(attempt.refusal.reasonCode, reasonCode, args);
        assert.equal(attempt.refusal.overridable, undefined, 'the new refusal is not itself overridable');
      }
    });

    it('a command that does not open with the profile\'s launch word is not rebuilt on the executable', () => {
      const attempt = sessions._overrideRefusedLaunch('codex',
        { allowed: false, reasonCode: 'version_unverified', reason: 'r.', recovery: 'c.', overridable: true },
        { launchCmd: 'env X=1 codex', engineProfile: { id: 'codex', launch: { shellCommand: 'codex' } }, enginePath: CODEX_BIN, probe: null },
        null);
      assert.equal(attempt.allowed, false);
      assert.equal(attempt.refusal.reasonCode, 'command_not_pinned');
    });
  });

  describe('the override fails closed', () => {
    const refusal = { allowed: false, reasonCode: 'version_unverified', reason: 'r.', recovery: 'c.', overridable: true };
    const input = { launchCmd: 'codex', engineProfile: { id: 'codex', launch: { shellCommand: 'codex' } }, enginePath: CODEX_BIN, probe: { version: UNLISTED, enginePath: CODEX_BIN } };

    for (const [label, effectiveFor] of [
      ['says the setting is unreadable', () => ({ allowed: false, scope: null, setAt: null, setBy: null, reason: 'unreadable' })],
      ['says nothing is set', () => ({ allowed: false, scope: null, setAt: null, setBy: null, reason: 'not_set' })],
      ['throws', () => { throw new Error('database is locked'); }],
      ['answers nothing', () => undefined],
      ['answers a truthy value that is not true', () => ({ allowed: 'yes', scope: 'install' })],
      ['allows with no scope', () => ({ allowed: true, scope: null })],
      ['allows with a scope it does not have', () => ({ allowed: true, scope: 'fleet' })]
    ]) {
      it(`a store that ${label} leaves the launch refused, with the refusal it already had`, () => {
        logger.setConsoleStream({ write: () => {} });
        const attempt = sessions._overrideRefusedLaunch('codex', refusal, input, 7, { effectiveFor });
        assert.deepEqual(attempt, { allowed: false, refusal });
      });
    }

    it('through the launch itself: a store whose override cannot be read starts nothing', () => {
      overrides.set({ projectId: null });
      store.getDb().exec('ALTER TABLE launch_isolation_overrides RENAME TO launch_isolation_overrides_moved');
      try {
        logger.setConsoleStream({ write: () => {} });
        const { result, command } = launch();
        assert.equal(result.code, 'LAUNCH_ISOLATION_UNVERIFIED');
        assert.equal(result.isolation.reasonCode, 'version_unverified');
        assert.equal(command, null);
      } finally {
        store.getDb().exec('ALTER TABLE launch_isolation_overrides_moved RENAME TO launch_isolation_overrides');
      }
    });

    it('an adapter that throws on the overridden command starts nothing', () => {
      logger.setConsoleStream({ write: () => {} });
      const attempt = sessions._overrideRefusedLaunch('codex', refusal, input, null, {
        effectiveFor: () => ({ allowed: true, scope: 'install', setAt: 't', setBy: null }),
        adapters: { codex: { judgeOverriddenLaunch: () => { throw new Error('fault'); } } }
      });
      assert.deepEqual(attempt, { allowed: false, refusal });
    });

    it('an engine no adapter can build an overridden command for starts nothing', () => {
      const attempt = sessions._overrideRefusedLaunch('codex', refusal, input, null, {
        effectiveFor: () => ({ allowed: true, scope: 'install', setAt: 't', setBy: null }),
        adapters: { other: { judgeOverriddenLaunch: () => ({ applies: false }) }, bare: {} }
      });
      assert.deepEqual(attempt, { allowed: false, refusal });
    });
  });

  describe('the inventory and the launch route, for a launch that ran under the override', () => {
    let server;
    const savedAsync = { ...tmux._async };

    before(async () => {
      server = createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    after(async () => {
      Object.assign(tmux._async, savedAsync);
      await new Promise((resolve) => server.close(resolve));
    });

    it('POST /api/sessions/:project answers 201 with what the launch ran under, and the inventory row for it carries the mark and the words tc prints', async () => {
      overrides.set({ projectId: null });
      counter += 1;
      const name = `ovr-${counter}`;
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const project = store.projects.create({ name, path: dir, engine: 'codex' });
      const res = await sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(name)}`, { primePrompt: false }, operatorHeaders(server));
      assert.equal(res.status, 201, JSON.stringify(res.data));
      assert.deepEqual(res.data.isolationOverride, {
        refusal: 'version_unverified', versionRead: UNLISTED, scope: 'install', risk: sessions.ISOLATION_OVERRIDE_RISK
      });

      // tmux reports the command this launch handed it, as the pane's start command.
      const started = created[created.length - 1];
      const line = `${started.name}:"${started.command.replace(/(["$\\])/g, '\\$1')}"`;
      tmux._async.execFile = (_bin, _args, _opts, cb) => setImmediate(() => cb(null, `${line}\n`));
      const inv = await inventory.inventory();
      const row = inv.sessions.find((r) => r.sessionId === res.data.sessionId);
      assert.ok(row, 'the launch is listed');
      assert.equal(row.verdict, 'not-isolated', 'the mark changes no verdict');
      assert.equal(row.reasonCode, 'command_unisolated');
      assert.equal(row.projectId, project.id);
      assert.equal(row.override.launchedUnderOverride, true);
      assert.equal(row.override.scope, 'install');
      assert.equal(row.override.refusal, 'version_unverified');
      assert.equal(row.override.versionRead, UNLISTED);
      assert.equal(typeof row.override.recordedAt, 'string');
      assert.equal(row.overrideUnproved, false);
      assert.match(row.reason, new RegExp(`The operator's override allowed this launch to start although it could not be shown isolated \\(engine version read: ${UNLISTED.replace(/\./g, '\\.')}; refusal overridden: version_unverified; install-wide override\\)`));
      assert.ok(row.reason.endsWith(sessions.ISOLATION_OVERRIDE_RISK));
      assert.equal(inv.summary['not-isolated'] >= 1, true);
      assert.equal(inv.sessions.filter((r) => r.verdict === 'isolated' && r.override !== null).length, 0);

      const printed = verbs.renderServerIsolationRecord({ state: 'verified', role: 'project', sessionId: res.data.sessionId }, inv, null);
      assert.match(printed, /^Server's record \(not a verdict about this shell\): /);
      assert.match(printed, /is recorded as not isolated/i);
      assert.ok(printed.includes('The operator\'s override allowed this launch'), printed);
      assert.ok(printed.endsWith('That does not show this shell is that launch.'), printed);

      // A pane running the same command for a session that left no such record
      // (a profile that names Codex by absolute path, started before launches
      // were judged) is not called overridden.
      const dir2 = path.join(projectsDir, 'ovr-hand-made');
      fs.mkdirSync(dir2, { recursive: true });
      const other = store.projects.create({ name: 'ovr-hand-made', path: dir2, engine: 'codex' });
      const bare = store.sessions.start({ projectId: other.id, engineId: 'codex', tmuxSession: 'ovr-hand-made' });
      tmux._async.execFile = (_bin, _args, _opts, cb) => setImmediate(() => cb(null, `${line}\novr-hand-made:"${CODEX_BIN}"\n`));
      const both = await inventory.inventory();
      const plain = both.sessions.find((r) => r.sessionId === bare.id);
      assert.equal(plain.verdict, 'not-isolated');
      assert.equal(plain.override, null);
      assert.equal(plain.overrideUnproved, true);
      assert.ok(plain.reason.endsWith(inventory.OVERRIDE_UNPROVED));
      assert.equal(both.sessions.find((r) => r.sessionId === res.data.sessionId).override.launchedUnderOverride, true, 'the launch with its own record still is');
    });
  });
});
