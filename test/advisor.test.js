'use strict';

// #2819 — the persistent Morpheus 🕶️ Advisor role. Mirrors
// test/master.test.js's own style for the launch lifecycle (a tmux/engines
// stub injected via options, the REAL lib/sessions.js module monkey-patched
// for the isolation-refusal branches), scaled to the Advisor's much smaller
// surface: no access-level tiers, no guard hook, no Medusa/bridge wiring.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const advisor = require('../lib/advisor');

/**
 * A tmux-shaped stub, same probe/create/kill/readSessionEnv shape
 * `lib/tmux.js` exposes. Modelled on test/master.test.js's `fakeTmux`.
 * @param {object} [opts]
 * @param {boolean} [opts.alive] - Whether probeSession reports a live session
 * @param {boolean} [opts.answered] - Whether tmux answered at all
 * @param {Function} [opts.createSession] - Override creation (return false, throw)
 * @param {Function} [opts.killSession] - Override kill confirmation
 * @param {string|null} [opts.launchId] - What readSessionEnv answers for TANGLECLAW_LAUNCH_ID
 * @returns {object}
 */
function fakeTmux({ alive = false, answered = true, createSession, killSession, launchId = null } = {}) {
  const calls = [];
  const probeSession = () => ({
    live: answered ? alive : false,
    answered,
    cause: answered ? null : 'read-timed-out'
  });
  return {
    calls,
    probeSession,
    createSession: (name, opts) => {
      calls.push({ name, opts });
      return createSession ? createSession(name, opts) : true;
    },
    killSession: (name) => (killSession ? killSession(name) : true),
    readSessionEnv: (name, key) => ({
      value: answered ? launchId : null,
      answered,
      cause: answered ? null : 'read-timed-out'
    })
  };
}

/** An engines stub that reports `claude` installed and available, nothing else. */
const availableEngines = {
  detect: () => [{ id: 'claude', available: true, path: '/usr/bin/claude' }],
  detectEngine: () => ({ available: true, path: '/usr/bin/claude' })
};

/** An engines stub that reports nothing installed. */
const noEngines = {
  detect: () => [],
  detectEngine: () => ({ available: false, path: null })
};

describe('Advisor (#2819)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-advisor-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // One store (and so one config.json) spans the whole file; without this,
  // saveAdvisorSettings calls in one describe block (e.g. a leftover
  // `model: 'opus'`) silently leak into another's ensureAdvisorSession
  // tests, which then refuse on a model-selection check nothing in THAT
  // test ever asked for.
  beforeEach(() => {
    const config = store.config.load();
    delete config.advisor;
    store.config.save(config);
  });

  describe('ensureAdvisorSandbox', () => {
    let home;
    beforeEach(() => { home = path.join(tmpDir, `sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}`); });

    it('creates the home + knowledge dir and seeds curated files', () => {
      advisor.ensureAdvisorSandbox(home);
      assert.ok(fs.existsSync(path.join(home, 'README.md')));
      assert.ok(fs.existsSync(path.join(home, 'knowledge', 'architecture-overview.md')));
      assert.ok(fs.existsSync(path.join(home, 'knowledge', 'engineering-principles.md')));
    });

    it('is idempotent: calling it again overwrites rather than duplicating or erroring', () => {
      advisor.ensureAdvisorSandbox(home);
      fs.writeFileSync(path.join(home, 'README.md'), 'hand-edited');
      advisor.ensureAdvisorSandbox(home);
      assert.notEqual(fs.readFileSync(path.join(home, 'README.md'), 'utf8'), 'hand-edited');
    });
  });

  describe('advisorSettings / saveAdvisorSettings', () => {
    it('defaults to no engine, no model, autoStart false, from an empty or missing config', () => {
      assert.deepEqual(advisor.advisorSettings({}), { engine: null, model: null, autoStart: false });
      assert.deepEqual(advisor.advisorSettings({ advisor: {} }), { engine: null, model: null, autoStart: false });
    });

    it('a config with no "advisor" key does not share lib/store.js\'s DEFAULT_CONFIG object (no such key exists there)', () => {
      const config = store.config.load();
      assert.equal(Object.prototype.hasOwnProperty.call(config, 'advisor'), false);
    });

    it('saveAdvisorSettings merges a partial patch over what is stored, and persists it', () => {
      const first = advisor.saveAdvisorSettings({ engine: 'claude', model: 'opus' });
      assert.deepEqual(first, { engine: 'claude', model: 'opus', autoStart: false });
      const second = advisor.saveAdvisorSettings({ autoStart: true });
      assert.deepEqual(second, { engine: 'claude', model: 'opus', autoStart: true });
      assert.deepEqual(advisor.advisorSettings(store.config.load()), second);
    });
  });

  describe('_resolveAdvisorEngineId', () => {
    it('uses the configured engine when it has a verified read-only flag and is installed', () => {
      assert.equal(advisor._resolveAdvisorEngineId({ engine: 'claude' }, availableEngines), 'claude');
    });

    it('falls back to the first verified-and-installed engine when the configured one is not installed', () => {
      assert.equal(advisor._resolveAdvisorEngineId({ engine: 'codex' }, availableEngines), 'claude');
    });

    it('returns null when nothing installed has a verified read-only flag', () => {
      assert.equal(advisor._resolveAdvisorEngineId({ engine: 'claude' }, noEngines), null);
    });
  });

  describe('_toolStrippedLaunchCommand', () => {
    it('appends the verified --disallowedTools flag for claude', () => {
      const cmd = advisor._toolStrippedLaunchCommand('claude --model x', 'claude');
      assert.match(cmd, /^claude --model x --disallowedTools /);
      assert.match(cmd, /Bash/);
      assert.match(cmd, /Write/);
    });

    it('refuses (null) for an engine with no verified flag', () => {
      assert.equal(advisor._toolStrippedLaunchCommand('codex', 'codex'), null);
    });
  });

  describe('ensureAdvisorSession', () => {
    let home;
    beforeEach(() => { home = path.join(tmpDir, `home-${Date.now()}-${Math.random().toString(36).slice(2)}`); });

    it('creates the sandbox and launches when the session is absent', () => {
      const t = fakeTmux({ alive: false });
      const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, true);
      assert.equal(r.tmuxSession, advisor.ADVISOR_TMUX_SESSION);
      assert.equal(r.error, undefined);
      assert.ok(fs.existsSync(path.join(home, 'knowledge')));
      assert.equal(t.calls.length, 1);
      assert.equal(t.calls[0].name, advisor.ADVISOR_TMUX_SESSION);
      assert.equal(t.calls[0].opts.cwd, home);
      assert.match(t.calls[0].opts.command, /--disallowedTools/);
    });

    it('the launch carries TANGLECLAW_ROLE=advisor and a fresh TANGLECLAW_LAUNCH_ID, never a project id', () => {
      const t = fakeTmux({ alive: false });
      const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, true);
      const env = t.calls[0].opts.env;
      assert.equal(env.TANGLECLAW_ROLE, 'advisor');
      assert.equal(typeof env.TANGLECLAW_LAUNCH_ID, 'string');
      assert.ok(env.TANGLECLAW_LAUNCH_ID.length > 0);
      assert.equal(env.TANGLECLAW_PROJECT_ID, undefined);
    });

    it('is a no-op (not created) when the session is already live', () => {
      const t = fakeTmux({ alive: true });
      const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, false);
      assert.equal(t.calls.length, 0, 'never attempts a second tmux session over a live one');
    });

    it('refuses to start a second session when tmux liveness could not be established', () => {
      const t = fakeTmux({ answered: false });
      const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, false);
      assert.deepEqual(r.incomplete, ['exists']);
      assert.match(r.error, /tmux did not answer/);
      assert.equal(t.calls.length, 0);
    });

    it('refuses when no engine with a verified read-only flag is installed', () => {
      const t = fakeTmux({ alive: false });
      const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: noEngines });
      assert.equal(r.created, false);
      assert.match(r.error, /No engine with a verified read-only launch flag/);
      assert.equal(t.calls.length, 0);
    });

    it('refuses an unselectable configured model before anything is launched', () => {
      advisor.saveAdvisorSettings({ engine: 'claude', model: 'not-a-real-model-id' });
      const t = fakeTmux({ alive: false });
      const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, false);
      assert.match(r.error, /could not be selected/);
      assert.equal(t.calls.length, 0);
      advisor.saveAdvisorSettings({ model: null });
    });

    it('a failed tmux session creation is reported, never silently swallowed', () => {
      const t = fakeTmux({ alive: false, createSession: () => false });
      const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, false);
      assert.match(r.error, /Failed to create tmux session/);
    });
  });

  describe('killAdvisorSession', () => {
    it('is success (not killed, not running) when the session is already absent', () => {
      const r = advisor.killAdvisorSession({ tmuxLib: fakeTmux({ alive: false }) });
      assert.deepEqual(r, { tmuxSession: advisor.ADVISOR_TMUX_SESSION, incomplete: [], cause: null, killed: false, wasRunning: false });
    });

    it('kills a live session and confirms it', () => {
      const r = advisor.killAdvisorSession({ tmuxLib: fakeTmux({ alive: true, killSession: () => true }) });
      assert.equal(r.killed, true);
      assert.equal(r.wasRunning, true);
    });

    it('reports an unconfirmed kill distinctly from a confirmed one', () => {
      const r = advisor.killAdvisorSession({ tmuxLib: fakeTmux({ alive: true, killSession: () => false }) });
      assert.equal(r.killed, false);
      assert.equal(r.wasRunning, true, 'it WAS seen running a moment ago');
      assert.equal(r.cause, 'kill-unconfirmed');
    });

    it('refuses to report anything when tmux liveness could not be established', () => {
      const r = advisor.killAdvisorSession({ tmuxLib: fakeTmux({ answered: false }) });
      assert.equal(r.killed, false);
      assert.equal(r.wasRunning, false);
      assert.deepEqual(r.incomplete, ['exists']);
    });
  });

  describe('getAdvisorStatus', () => {
    it('reports exists:false for an absent session, with current settings', () => {
      advisor.saveAdvisorSettings({ engine: 'claude', model: null, autoStart: false });
      const r = advisor.getAdvisorStatus({ tmuxLib: fakeTmux({ alive: false }) });
      assert.equal(r.exists, false);
      assert.equal(r.tmuxSession, advisor.ADVISOR_TMUX_SESSION);
      assert.equal(r.settings.engine, 'claude');
    });

    it('reports exists:null (not false) when tmux did not answer — unknown is not "down"', () => {
      const r = advisor.getAdvisorStatus({ tmuxLib: fakeTmux({ answered: false }) });
      assert.equal(r.exists, null);
      assert.deepEqual(r.incomplete, ['exists']);
    });

    it('reports exists:true for a live session', () => {
      const r = advisor.getAdvisorStatus({ tmuxLib: fakeTmux({ alive: true }) });
      assert.equal(r.exists, true);
    });
  });

  describe('liveAdvisorLaunchId', () => {
    it('answers the launch id tmux reports for a live Advisor', () => {
      const r = advisor.liveAdvisorLaunchId({ tmuxLib: fakeTmux({ alive: true, launchId: 'launch-advisor-1' }) });
      assert.deepEqual(r, { launchId: 'launch-advisor-1', answered: true, cause: null });
    });

    it('answered:false when tmux does not reply, distinct from "no advisor running"', () => {
      const r = advisor.liveAdvisorLaunchId({ tmuxLib: fakeTmux({ answered: false }) });
      assert.equal(r.answered, false);
      assert.equal(r.launchId, null);
    });
  });

  describe('isAdvisorRequest', () => {
    it('false with no role header at all', () => {
      assert.equal(advisor.isAdvisorRequest({ headers: {} }), false);
    });

    it('false with the role header but the WRONG launch id (a forged claim)', () => {
      const req = { headers: { 'x-tangleclaw-role': 'advisor', 'x-tangleclaw-launch-id': 'not-the-real-one' } };
      assert.equal(advisor.isAdvisorRequest(req, { tmuxLib: fakeTmux({ alive: true, launchId: 'the-real-one' }) }), false);
    });

    it('false when tmux cannot confirm the live launch id at all', () => {
      const req = { headers: { 'x-tangleclaw-role': 'advisor', 'x-tangleclaw-launch-id': 'x' } };
      assert.equal(advisor.isAdvisorRequest(req, { tmuxLib: fakeTmux({ answered: false }) }), false);
    });

    it('true with the role header AND the matching live launch id', () => {
      const req = { headers: { 'x-tangleclaw-role': 'advisor', 'x-tangleclaw-launch-id': 'the-real-one' } };
      assert.equal(advisor.isAdvisorRequest(req, { tmuxLib: fakeTmux({ alive: true, launchId: 'the-real-one' }) }), true);
    });

    it('false for a role claim of "master", even with a matching-shaped header', () => {
      const req = { headers: { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'the-real-one' } };
      assert.equal(advisor.isAdvisorRequest(req, { tmuxLib: fakeTmux({ alive: true, launchId: 'the-real-one' }) }), false);
    });
  });

  describe('isolation refusals (real lib/sessions.js, monkey-patched for the one branch under test)', () => {
    let home;
    let sessionsLib;
    beforeEach(() => {
      home = path.join(tmpDir, `iso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      sessionsLib = require('../lib/sessions');
    });

    it('refuses before launching anything when the engine executable is not admitted', () => {
      const original = sessionsLib._admitEngineExecutable;
      sessionsLib._admitEngineExecutable = () => ({ allowed: false, reasonCode: 'TEST_REFUSAL', reason: 'test', recovery: null });
      try {
        const t = fakeTmux({ alive: false });
        const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
        assert.equal(r.created, false);
        assert.equal(r.code, 'LAUNCH_ISOLATION_UNVERIFIED');
        assert.equal(t.calls.length, 0);
      } finally {
        sessionsLib._admitEngineExecutable = original;
      }
    });

    it('refuses when no launch command can be built for the engine', () => {
      const original = sessionsLib._buildLaunchCommand;
      sessionsLib._buildLaunchCommand = () => undefined;
      try {
        const t = fakeTmux({ alive: false });
        const r = advisor.ensureAdvisorSession({ home, tmuxLib: t, enginesLib: availableEngines });
        assert.equal(r.created, false);
        assert.match(r.error, /has no launch command/);
      } finally {
        sessionsLib._buildLaunchCommand = original;
      }
    });
  });
});
