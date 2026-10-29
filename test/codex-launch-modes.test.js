'use strict';

/*
 * #731 — Codex launch modes, and the silent fall-through that hid the breakage.
 *
 * `data/engines/codex.json` shipped `--full-auto` from #211, taken from #209's
 * unverified probe target. Codex CLI later removed the flag, so "Full Auto"
 * built `codex --full-auto`, which exits 2 with "unexpected argument" — the one
 * non-interactive Codex mode could not start a session at all. Nothing caught
 * it because every engine test asserted the profile against a literal copy of
 * itself.
 *
 * The flags themselves are probed against the installed binary in
 * test/engine-launch-flags.test.js. This file pins the mapping and the
 * assembly: which modes Codex offers, what each one builds, and that a mode key
 * the engine does not define is reported rather than silently dropped.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sessions = require('../lib/sessions');
const logger = require('../lib/logger');
const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

const codex = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8')
);

describe('Codex launch modes (#731)', () => {
  it('offers interactive, full-auto, and bypass', () => {
    assert.deepEqual(
      Object.keys(codex.launchModes).sort(),
      ['bypassPermissions', 'default', 'fullAuto']
    );
    assert.equal(codex.defaultLaunchMode, 'default');
  });

  it('never declares --full-auto again — the flag Codex removed', () => {
    const all = Object.values(codex.launchModes).flatMap((m) => m.args || []);
    assert.ok(!all.includes('--full-auto'), '--full-auto was removed from codex-cli; it exits 2');
    assert.ok(!all.includes('--auto-edit'), '--auto-edit was the other unverified guess in #209');
  });

  it('full auto skips approvals but keeps the sandbox', () => {
    // The distinction is the whole point of having two non-default modes: this
    // one is unattended, the other also removes the sandbox.
    assert.deepEqual(
      codex.launchModes.fullAuto.args,
      ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']
    );
    assert.ok(codex.launchModes.fullAuto.warning, 'unattended execution must carry a warning');
  });

  it('bypass drops the sandbox too, and says so', () => {
    assert.deepEqual(
      codex.launchModes.bypassPermissions.args,
      ['--dangerously-bypass-approvals-and-sandbox']
    );
    assert.ok(codex.launchModes.bypassPermissions.warning);
  });

  it('names bypass the same key as every other engine, so a stored mode stays portable', () => {
    // A project's defaultLaunchMode survives an engine change; matching keys
    // mean switching Claude -> Codex keeps the operator's intent instead of
    // silently degrading to interactive.
    for (const id of ['claude', 'antigravity']) {
      const other = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', `${id}.json`), 'utf8')
      );
      assert.ok(
        other.launchModes.bypassPermissions,
        `${id} uses a different bypass key — the shared name is the portability contract`
      );
    }
  });
});

describe('_buildLaunchCommand assembles Codex modes (#731)', () => {
  it('builds the interactive command with no extra args', () => {
    assert.equal(sessions._buildLaunchCommand(codex, null, 'default'), 'codex');
  });

  it('builds the full-auto command', () => {
    assert.equal(
      sessions._buildLaunchCommand(codex, null, 'fullAuto'),
      'codex --ask-for-approval never --sandbox workspace-write'
    );
  });

  it('builds the bypass command', () => {
    assert.equal(
      sessions._buildLaunchCommand(codex, null, 'bypassPermissions'),
      'codex --dangerously-bypass-approvals-and-sandbox'
    );
  });
});

describe('each Codex mode under the operator\'s launch-isolation override (#2229)', () => {
  const BIN = '/opt/fake/bin/codex';
  const refusal = { allowed: false, reasonCode: 'version_unverified', reason: 'r.', recovery: 'c.', overridable: true };
  const allowed = { effectiveFor: () => ({ allowed: true, scope: 'install', setAt: '2026-10-12T00:00:00.000Z', setBy: null }) };

  for (const [mode, args] of [
    ['default', ''],
    ['fullAuto', ' --ask-for-approval never --sandbox workspace-write'],
    ['bypassPermissions', ' --dangerously-bypass-approvals-and-sandbox']
  ]) {
    it(`${mode}: the exact executable, the mode's own flags, and no isolation flag`, () => {
      const attempt = sessions._overrideRefusedLaunch('codex', refusal, {
        launchCmd: sessions._buildLaunchCommand(codex, null, mode), engineProfile: codex, enginePath: BIN, probe: { version: '0.170.0', enginePath: BIN }
      }, null, allowed);
      assert.equal(attempt.allowed, true);
      assert.equal(attempt.command, `${BIN}${args}`);
      assert.deepEqual(attempt.record, {
        engineId: 'codex', enginePath: BIN, refusal: 'version_unverified', versionRead: '0.170.0',
        scope: 'install', setAt: '2026-10-12T00:00:00.000Z', setBy: null
      });
    });
  }
});

describe('each Codex mode on 0.161.0 and 0.162.0 is refused, not launched with --no-daemon (#2222)', () => {
  const adapter = require('../lib/startup-control-codex');
  const BIN = '/opt/fake/bin/codex';

  for (const version of ['0.161.0', '0.162.0']) {
    for (const mode of ['default', 'fullAuto', 'bypassPermissions']) {
      it(`${version} ${mode}: no isolated command is built, and the flagged command is refused`, () => {
        const launchCmd = sessions._buildLaunchCommand(codex, null, mode);
        const built = adapter.isolateLaunch({ engineId: 'codex', launchCmd, shell: 'codex', enginePath: BIN }, { probeVersionSync: () => version });
        assert.equal(built.applies, true);
        assert.equal(built.command, null, 'no --no-daemon command for an unlisted version');
        assert.equal(built.probe.version, version);
        const flagged = `${BIN}${launchCmd.slice('codex'.length)} --no-daemon`;
        const verdict = adapter.judgeLaunchCommand({ engineId: 'codex', command: flagged, enginePath: BIN, probe: built.probe, native: null, nativeVerifiedVersions: codex.capabilities.startupControl.verifiedVersions });
        assert.equal(verdict.allowed, false);
        assert.equal(verdict.reasonCode, 'version_unverified');
      });
    }
  }
});

describe('honorsLaunchMode is the single definition of "the engine will run this" (#731)', () => {
  const engines = require('../lib/engines');

  it('accepts a mode the profile declares', () => {
    assert.equal(engines.honorsLaunchMode(codex, 'bypassPermissions'), true);
  });

  it('rejects a mode the profile does not declare', () => {
    assert.equal(engines.honorsLaunchMode(codex, 'acceptEdits'), false);
  });

  it('rejects a declared-but-disabled mode', () => {
    const disabled = { launchModes: { fullAuto: { args: [], disabled: true } } };
    assert.equal(engines.honorsLaunchMode(disabled, 'fullAuto'), false);
  });

  it('rejects inherited Object members — a mode key arrives from request bodies', () => {
    // `constructor` / `__proto__` / `toString` resolve to truthy prototype
    // members. A bare index treats them as valid modes: no args appended, no
    // warning logged — the precise silent mismatch this predicate exists for.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(engines.honorsLaunchMode(codex, key), false, `${key} must not resolve as a mode`);
    }
  });

  it('handles a missing or malformed profile without throwing', () => {
    assert.equal(engines.honorsLaunchMode(null, 'default'), false);
    assert.equal(engines.honorsLaunchMode({}, 'default'), false);
    assert.equal(engines.honorsLaunchMode(codex, ''), false);
    assert.equal(engines.honorsLaunchMode(codex, undefined), false);
  });

  it('reconciles an unhonored mode to default, including inherited keys', () => {
    // `projects.reconcileLaunchMode` is module-internal and now delegates here;
    // that delegation is covered behaviorally by the engine-switch tests in
    // test/launch-mode-settings.test.js rather than by exporting it for a test.
    assert.equal(engines.reconcileLaunchMode('bypassPermissions', codex), 'bypassPermissions');
    assert.equal(engines.reconcileLaunchMode('acceptEdits', codex), 'default');
    assert.equal(engines.reconcileLaunchMode('__proto__', codex), 'default');
    assert.equal(engines.reconcileLaunchMode('default', null), 'default');
  });
});

describe('_buildLaunchCommand rejects prototype members as modes (#731)', () => {
  it('appends nothing and warns for an inherited key', () => {
    const captured = [];
    logger.setConsoleStream({ write: (s) => captured.push(s) });
    try {
      const cmd = sessions._buildLaunchCommand(codex, null, 'constructor');
      assert.equal(cmd, 'codex', 'a prototype member must never contribute args');
      assert.match(captured.join(''), /not honored by this engine/);
    } finally {
      logger.setConsoleStream(null);
    }
  });
});

describe('_resolvePreKeys uses the same honored-mode predicate (#731)', () => {
  it('ignores an inherited mode that would supply preKeys', () => {
    // The fixture has to be one where a bare index and hasOwnProperty actually
    // DIVERGE. `constructor` does not: `Object.preKeys` is undefined, so the
    // old bare-index path fell straight through to the same engine-level
    // branch, and a test using it passes identically before and after the
    // hardening — the exact defect this test exists to catch, which is why the
    // first version of it was worthless.
    //
    // An inherited mode that DOES carry preKeys separates them: a bare index
    // finds it through the prototype chain and returns ['X']; hasOwnProperty
    // does not, so engine-level preKeys win.
    const profile = {
      launch: { preKeys: ['Enter', 'Enter'], preKeyDelay: 3000 },
      launchModes: Object.create({ evil: { preKeys: ['X'] } })
    };
    profile.launchModes.default = { args: [] };

    const resolved = sessions._resolvePreKeys(profile, 'evil');
    assert.deepEqual(resolved.preKeys, ['Enter', 'Enter'], 'an inherited mode must not supply preKeys');
    assert.notDeepEqual(resolved.preKeys, ['X']);
  });

  it('still returns engine preKeys for a real mode that declares none', () => {
    // A mode with no preKeys of its own falls back to the engine's.
    const profile = { launch: { preKeys: ['Enter', 'Enter'], preKeyDelay: 3000 }, launchModes: { fullAuto: { args: [] } } };
    const resolved = sessions._resolvePreKeys(profile, 'fullAuto');
    assert.deepEqual(resolved.preKeys, ['Enter', 'Enter']);
  });

  it('the bundled Codex profile sends no preKeys in any mode (#2177)', () => {
    // Codex's two Enters were sent blind, three seconds after launch. Its
    // update prompt highlights "Update now" and its folder-trust prompt
    // highlights "Trust and continue", so an Enter answers whichever is up.
    // The profile declares those prompts instead, and nothing answers them.
    assert.ok(!('preKeys' in codex.launch), 'no engine-level preKeys');
    assert.ok(!('preKeyDelay' in codex.launch));
    for (const mode of Object.keys(codex.launchModes)) {
      assert.ok(!('preKeys' in codex.launchModes[mode]), `no preKeys on ${mode}`);
      assert.equal(sessions._resolvePreKeys(codex, mode).preKeys, null);
    }
    assert.deepEqual(codex.launch.guardedDialogs.map((p) => p.id), ['folder-trust', 'update']);
  });
});

describe('unknown launch mode is reported, not swallowed (#731)', () => {
  let captured;

  beforeEach(() => {
    captured = [];
    logger.setConsoleStream({ write: (s) => captured.push(s) });
  });

  afterEach(() => logger.setConsoleStream(null));

  it('warns when the engine has no such mode, naming what it does have', () => {
    // Reachable in normal use: modes are engine-specific, but a project's stored
    // defaultLaunchMode outlives a change of engine.
    const cmd = sessions._buildLaunchCommand(codex, null, 'acceptEdits');

    const text = captured.join('');
    assert.match(text, /not honored by this engine/);
    assert.match(text, /launchMode=acceptEdits/);
    assert.match(text, /engine=codex/);
    assert.match(text, /available=/, 'the warning must name the modes that do exist');
    // Still launches — refusing would strand a project over a cosmetic setting.
    assert.equal(cmd, 'codex');
  });

  it('stays quiet on a mode the engine does define', () => {
    sessions._buildLaunchCommand(codex, null, 'fullAuto');
    assert.doesNotMatch(captured.join(''), /not honored by this engine/);
  });
});

describe('fullAuto declares its loopback sandbox limitation (#1836)', () => {
  it('declares the sandbox blocks loopback, with a reason, a remedy and dated evidence', () => {
    const mode = codex.launchModes.fullAuto;
    assert.equal(mode.loopbackReachable, false);
    assert.equal(mode.sandboxBlocksLoopback, true);
    assert.equal(typeof mode.sandboxNote, 'string');
    assert.match(mode.sandboxNote, /workspace-write/);
    assert.match(mode.sandboxNote, /1836/);
    assert.equal(typeof mode.sandboxRemedy, 'string');
    assert.match(mode.sandboxRemedy, /network_access/);
    assert.match(mode.sandboxRemedy, /config\.toml/);
    assert.ok(mode.sandboxEvidence && mode.sandboxEvidence.verifiedOn, 'dated like every other declared evidence block');
  });

  it('is not declared for the modes that do reach loopback', () => {
    for (const key of ['default', 'bypassPermissions']) {
      const mode = codex.launchModes[key];
      assert.ok(!('sandboxBlocksLoopback' in mode), `${key} should not declare the fullAuto-only limitation`);
    }
  });
});

describe('launch-sequence status names the sandbox cause (#1836)', () => {
  // A synthetic engine carrying the same declared shape as Codex's fullAuto,
  // with no `capabilities.startupControl` — so the launch takes the plain
  // tmux/legacy path (same as test/launch-sequence.test.js's own fixtures)
  // and this test exercises `lib/launch-sequence.js`'s own integration
  // (`_loopbackSandboxNote` -> `_statusBlock` -> `status()`) without needing
  // Codex's native app-server machinery, already covered by
  // test/startup-control-codex.test.js.
  const ENGINE_ID = 'fake-sandboxed-engine';
  let tmpDir;
  let projectsDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-loopback-'));
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    store.engines.save({
      id: ENGINE_ID,
      name: 'Fake Sandboxed Engine',
      command: 'fake-sandboxed-engine',
      capabilities: { supportsPrimePrompt: true, launchSequence: { supported: true } },
      launchModes: {
        default: { label: 'Interactive', args: [] },
        fullAuto: {
          label: 'Full Auto',
          args: [],
          sandboxBlocksLoopback: true,
          sandboxNote: 'test fixture: this mode denies loopback',
          sandboxRemedy: 'test fixture: change the launch mode'
        }
      },
      defaultLaunchMode: 'default'
    });
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Launch a project with tmux and engine detection stubbed, same as
   * test/launch-sequence.test.js's own `launch()` helper.
   * @param {string} name - Project name
   * @param {object} [launchOptions] - Passed through to `sessions.launchSession`
   * @returns {object} The launch result
   */
  function launch(name, launchOptions = {}) {
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-sandboxed-engine' });
    try {
      return sessions.launchSession(name, launchOptions);
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  it('names the sandbox cause when an unread launch sits at cursor 0 on a sandbox-blocking mode', () => {
    const name = 'codex-loopback-fullauto';
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: ENGINE_ID });
    const result = launch(name, { launchMode: 'fullAuto' });
    assert.equal(result.error, null, result.error);

    const sequence = store.launchSequences.getBySession(result.session.id);
    assert.equal(sequence.cursor, 0, 'a fresh launch sits unread at cursor 0');

    const shown = launchSequence.status({ launchId: sequence.launchId, projectId: project.id }).body;
    assert.deepEqual(shown.status.sandboxNote, {
      code: 'CODEX_SANDBOX_BLOCKS_LOOPBACK',
      reason: 'test fixture: this mode denies loopback',
      remedy: 'test fixture: change the launch mode'
    });
  });

  it('is absent for the same engine in a mode that does not declare the limitation', () => {
    const name = 'codex-loopback-default';
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: ENGINE_ID });
    const result = launch(name, { launchMode: 'default' });
    assert.equal(result.error, null, result.error);

    const sequence = store.launchSequences.getBySession(result.session.id);
    assert.equal(sequence.cursor, 0);

    const shown = launchSequence.status({ launchId: sequence.launchId, projectId: project.id }).body;
    assert.ok(!('sandboxNote' in shown.status), 'no declaration for this mode, so no note');
  });

  it('is absent once the sequence has moved past cursor 0', () => {
    const name = 'codex-loopback-advanced';
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: ENGINE_ID });
    const result = launch(name, { launchMode: 'fullAuto' });
    assert.equal(result.error, null, result.error);

    const sequence = store.launchSequences.getBySession(result.session.id);
    // Advance the cursor directly, same as an ack would: cursor 0 is the
    // literal "unread" state this diagnostic is for, not every early step.
    store.launchSequences.transaction(() => {
      store.getDb().prepare('UPDATE launch_sequences SET cursor = 1 WHERE id = ?').run(sequence.id);
    });

    const shown = launchSequence.status({ launchId: sequence.launchId, projectId: project.id }).body;
    assert.ok(!('sandboxNote' in shown.status), 'only the unread, cursor-0 state gets the diagnostic');
  });
});
