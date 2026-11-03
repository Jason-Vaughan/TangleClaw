'use strict';

// #2819 — the persistent Morpheus 🕶️ Advisor role. Mirrors
// test/master.test.js's own style for the launch lifecycle (a tmux/engines
// stub injected via options, the REAL lib/sessions.js module monkey-patched
// for the isolation-refusal branches), scaled to the Advisor's much smaller
// surface: no access-level tiers, no Medusa/bridge wiring. It DOES have a
// guard hook (R1: PRR-B found the sandbox's cwd confinement alone was not
// a real filesystem boundary) -- a read-confinement allowlist, not the
// Master's write-confinement denylist.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const http = require('node:http');
const store = require('../lib/store');
const advisor = require('../lib/advisor');
const { createServer } = require('../server');
const { operatorHeaders } = require('./_shared-docs-callers');

/**
 * One JSON request against a listening test server.
 * @param {import('node:http').Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object|null} body
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status: number, data: object|null}>}
 */
function send(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

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

    it('also writes the structural guardrails: an empty Advisor-only MCP config and the read-confinement hook (#2819 PRR-B R1)', () => {
      advisor.ensureAdvisorSandbox(home);
      const mcpConfig = JSON.parse(fs.readFileSync(advisor.advisorMcpConfigPath(home), 'utf8'));
      assert.deepEqual(mcpConfig, { mcpServers: {} });
      assert.ok(fs.existsSync(advisor.advisorGuardScriptPath(home)));
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      assert.equal(settings.hooks.PreToolUse[0].matcher, '', 'the catch-all matcher, not a Read/Glob/Grep-only one');
      assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /guard-reads\.js/);
    });
  });

  describe('buildAdvisorGuardScript (#2819 PRR-B R1 finding 1): the read-confinement PreToolUse hook', () => {
    let home;
    let scriptPath;

    beforeEach(() => {
      home = path.join(tmpDir, `guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(path.join(home, 'knowledge'), { recursive: true });
      fs.writeFileSync(path.join(home, 'knowledge', 'a.md'), 'hi');
      scriptPath = path.join(home, 'guard.js');
      fs.writeFileSync(scriptPath, advisor.buildAdvisorGuardScript(home));
    });

    /**
     * Run the generated guard script against one tool-call shape, the same
     * way Claude Code's own PreToolUse harness would: JSON on stdin,
     * `hookSpecificOutput` parsed from stdout.
     * @param {object} input - `{tool_name, tool_input}`
     * @returns {{permissionDecision: string, permissionDecisionReason: string}}
     */
    function runGuard(input) {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(process.execPath, [scriptPath], { input: JSON.stringify(input) });
      return JSON.parse(out.toString()).hookSpecificOutput;
    }

    it('is valid, syntactically-standalone JavaScript', () => {
      assert.doesNotThrow(() => require('node:child_process').execFileSync(process.execPath, ['-c', scriptPath]));
    });

    it('allows Read inside the sandbox', () => {
      const r = runGuard({ tool_name: 'Read', tool_input: { file_path: path.join(home, 'knowledge', 'a.md') } });
      assert.equal(r.permissionDecision, 'allow');
    });

    it('denies Read outside the sandbox', () => {
      const r = runGuard({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } });
      assert.equal(r.permissionDecision, 'deny');
    });

    it('denies Read via a relative traversal that climbs out of the sandbox', () => {
      const r = runGuard({ tool_name: 'Read', tool_input: { file_path: path.join(home, '..', '..', 'etc', 'passwd') } });
      assert.equal(r.permissionDecision, 'deny');
    });

    it('denies a Read with no file_path at all, rather than defaulting to allow', () => {
      const r = runGuard({ tool_name: 'Read', tool_input: {} });
      assert.equal(r.permissionDecision, 'deny');
    });

    it('allows Glob/Grep with no explicit path (defaults to the sandbox cwd)', () => {
      assert.equal(runGuard({ tool_name: 'Glob', tool_input: { pattern: '*.md' } }).permissionDecision, 'allow');
      assert.equal(runGuard({ tool_name: 'Grep', tool_input: { pattern: 'hi' } }).permissionDecision, 'allow');
    });

    it('denies Glob/Grep given an explicit path outside the sandbox', () => {
      assert.equal(runGuard({ tool_name: 'Glob', tool_input: { pattern: '*', path: '/etc' } }).permissionDecision, 'deny');
      assert.equal(runGuard({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '/etc' } }).permissionDecision, 'deny');
    });

    it('denies a Glob/Grep pattern that embeds its own parent-directory traversal, independent of "path"', () => {
      const r = runGuard({ tool_name: 'Glob', tool_input: { pattern: '../../etc/*' } });
      assert.equal(r.permissionDecision, 'deny');
      assert.match(r.permissionDecisionReason, /parent directory/);
    });

    it('denies every other tool by allowlist, not denylist -- including ones disallowedTools cannot name', () => {
      for (const name of ['Bash', 'Edit', 'Write', 'Task', 'WebFetch', 'mcp__claude-in-chrome__navigate', 'SomeFutureTool']) {
        const r = runGuard({ tool_name: name, tool_input: {} });
        assert.equal(r.permissionDecision, 'deny', `tool "${name}"`);
      }
    });

    it('fails closed on unparseable stdin', () => {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(process.execPath, [scriptPath], { input: 'not json' });
      assert.equal(JSON.parse(out.toString()).hookSpecificOutput.permissionDecision, 'deny');
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

    it('with no home given, appends no MCP isolation flags (the units that exercise tool-stripping alone)', () => {
      const cmd = advisor._toolStrippedLaunchCommand('claude --model x', 'claude');
      assert.doesNotMatch(cmd, /--mcp-config/);
      assert.doesNotMatch(cmd, /--strict-mcp-config/);
    });

    it('with a home given, also isolates MCP servers (#2819 PRR-B R1 finding 1): --mcp-config pointing at an empty, Advisor-only config, plus --strict-mcp-config', () => {
      const cmd = advisor._toolStrippedLaunchCommand('claude --model x', 'claude', '/tmp/some-advisor-home');
      assert.match(cmd, /--mcp-config '\/tmp\/some-advisor-home\/\.claude\/mcp-config\.json'|--mcp-config \/tmp\/some-advisor-home\/\.claude\/mcp-config\.json/);
      assert.match(cmd, /--strict-mcp-config/);
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

  describe('bootAdvisor (#2819, Architect Ruling A2819 R1)', () => {
    it('server startup runs the Advisor boot sequence', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      assert.match(src, /advisor\.bootAdvisor\(\)/, 'server startup must run the Advisor boot sequence');
    });

    it('honors advisor.autoStart, and a launch that throws is never fatal', () => {
      let launched = 0;
      const counting = () => { launched += 1; return { created: true }; };
      advisor.bootAdvisor({ config: { advisor: { autoStart: false } }, ensureAdvisorSession: counting });
      assert.equal(launched, 0, 'auto-start off launches nothing');
      const r = advisor.bootAdvisor({ config: { advisor: { autoStart: true } }, ensureAdvisorSession: counting });
      assert.equal(launched, 1, 'auto-start on launches the Advisor');
      assert.deepEqual(r, { attempted: true, created: true, error: null });

      // "Never fatal" needs a real catch: ensureAdvisorSession types tmux/
      // engine failures into result.error but can still throw on fs faults.
      const boot = advisor.bootAdvisor({
        config: { advisor: { autoStart: true } },
        ensureAdvisorSession: () => { throw new Error('home unwritable'); }
      });
      assert.match(boot.error, /home unwritable/, 'a throw is caught and reported');
      assert.equal(boot.attempted, true);
      assert.equal(boot.created, false);
    });

    it('reports attempted:false, created:false when auto-start is off', () => {
      const r = advisor.bootAdvisor({ config: { advisor: { autoStart: false } } });
      assert.deepEqual(r, { attempted: false, created: false, error: null });
    });

    it('reports a typed launch error from ensureAdvisorSession without throwing', () => {
      const r = advisor.bootAdvisor({
        config: { advisor: { autoStart: true } },
        ensureAdvisorSession: () => ({ created: false, error: 'no engine installed' })
      });
      assert.equal(r.attempted, true);
      assert.equal(r.created, false);
      assert.equal(r.error, 'no engine installed');
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

  describe('role-boundary enforcement: _requireSessionLifecycleCaller (#2819, Charter A496 section 3)', () => {
    const callers = require('../lib/routes/_callers');

    /** A minimal res that captures what errorResponse/jsonResponse write. */
    function fakeRes() {
      const res = { statusCode: null, headers: null, body: null };
      res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
      res.end = (body) => { res.body = body ? JSON.parse(body) : null; };
      return res;
    }

    it('refuses the Advisor outright, before anything else is resolved', () => {
      const original = advisor.isAdvisorRequest;
      advisor.isAdvisorRequest = () => true;
      try {
        const res = fakeRes();
        const result = callers._requireSessionLifecycleCaller({ headers: {} }, res, { action: 'launch' });
        assert.equal(result, null, 'refused: no caller is returned');
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 'ADVISOR_SCOPE_VIOLATION');
      } finally {
        advisor.isAdvisorRequest = original;
      }
    });

    it('does not refuse a caller isAdvisorRequest says is not the Advisor (falls through to the real access resolution)', () => {
      const original = advisor.isAdvisorRequest;
      advisor.isAdvisorRequest = () => false;
      try {
        const res = fakeRes();
        // No operator/master/project binding on this bare request either, so
        // it still ends refused -- but through the UNBOUND/launch-binding
        // path, never ADVISOR_SCOPE_VIOLATION, which is the one thing this
        // test is actually checking.
        callers._requireSessionLifecycleCaller({ headers: {} }, res, { action: 'launch' });
        assert.notEqual(res.body && res.body.code, 'ADVISOR_SCOPE_VIOLATION');
      } finally {
        advisor.isAdvisorRequest = original;
      }
    });
  });

  describe('HTTP: the /api/advisor/* routes and the dispatch-floor refusal (#2819)', () => {
    // Reuses the outer describe's own store (its before()/after() already
    // span this block) -- a second store._setBasePath/init here would
    // re-point the shared store mid-file, same hazard as leaking config.advisor
    // across describes (see the top-level beforeEach above).
    let server;
    let op;

    before(async () => {
      server = createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      op = operatorHeaders(server);
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('GET /api/advisor/status needs no auth, same as GET /api/master/status', async () => {
      const r = await send(server, 'GET', '/api/advisor/status', null);
      assert.equal(r.status, 200);
      assert.equal(r.data.tmuxSession, advisor.ADVISOR_TMUX_SESSION);
    });

    it('GET /api/advisor/settings is readable with no auth', async () => {
      const r = await send(server, 'GET', '/api/advisor/settings', null);
      assert.equal(r.status, 200);
      assert.deepEqual(r.data, { engine: null, model: null, autoStart: false });
    });

    it('POST /api/advisor/settings is operator-only', async () => {
      const refused = await send(server, 'POST', '/api/advisor/settings', { engine: 'claude' });
      assert.equal(refused.status, 403);
      const ok = await send(server, 'POST', '/api/advisor/settings', { engine: 'claude', model: null, autoStart: true }, op);
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.data, { engine: 'claude', model: null, autoStart: true });
    });

    it('POST /api/advisor/settings rejects a malformed body before anything is saved', async () => {
      const r = await send(server, 'POST', '/api/advisor/settings', { autoStart: 'yes' }, op);
      assert.equal(r.status, 400);
      assert.equal(r.data.code, 'BAD_REQUEST');
    });

    it('POST /api/advisor/launch and /kill are operator-only', async () => {
      assert.equal((await send(server, 'POST', '/api/advisor/launch', null)).status, 403);
      assert.equal((await send(server, 'POST', '/api/advisor/kill', null)).status, 403);
    });

    it('POST /api/advisor/kill is idempotent success as the operator, with no Advisor running', async () => {
      const r = await send(server, 'POST', '/api/advisor/kill', null, op);
      assert.equal(r.status, 200);
      assert.equal(r.data.killed, false);
      assert.equal(r.data.wasRunning, false);
    });

    it('the dispatch floor refuses a verified Advisor-role request against an ordinary route outside /api/advisor/*', async () => {
      const original = advisor.isAdvisorRequest;
      advisor.isAdvisorRequest = (req) => req.headers['x-tangleclaw-role'] === 'advisor';
      try {
        const r = await send(server, 'GET', '/api/master/status', null, { 'x-tangleclaw-role': 'advisor', 'x-tangleclaw-launch-id': 'x' });
        assert.equal(r.status, 403);
        assert.equal(r.data.code, 'ADVISOR_SCOPE_VIOLATION');
      } finally {
        advisor.isAdvisorRequest = original;
      }
    });

    it('the dispatch floor refuses a MUTATING (POST) request from a verified Advisor before the mutating-only launch-binding floor ever runs (Architect Ruling A2819 R1)', async () => {
      // The bug this guards: sharedDocsAccess.resolveBinding has no concept
      // of an advisor caller, so a verified Advisor's own POST used to reach
      // launchBindingGuard.judge FIRST and get refused as a generic 403
      // LAUNCH_BINDING_INVALID/project-claim-missing -- never reaching this
      // route's own ADVISOR_SCOPE_VIOLATION message. Ordering, not logic, was
      // the defect: this check must run before binding.allowed, not after.
      const original = advisor.isAdvisorRequest;
      advisor.isAdvisorRequest = (req) => req.headers['x-tangleclaw-role'] === 'advisor';
      try {
        const r = await send(server, 'POST', '/api/master/kill', null, { 'x-tangleclaw-role': 'advisor', 'x-tangleclaw-launch-id': 'x' });
        assert.equal(r.status, 403);
        assert.equal(r.data.code, 'ADVISOR_SCOPE_VIOLATION');
        assert.notEqual(r.data.code, 'LAUNCH_BINDING_INVALID');
      } finally {
        advisor.isAdvisorRequest = original;
      }
    });

    it('omitting the role header entirely is NOT read as the Advisor -- it falls through to whatever the pre-existing floor already does for an unclaimed caller (PRR-B R1 finding 2)', async () => {
      // isAdvisorRequest is NOT stubbed: a request carrying no
      // x-tangleclaw-role header at all must not be treated as the Advisor,
      // and this check must not be the thing standing between it and
      // /api/master/status -- that is the PRE-EXISTING launch-binding/
      // open-mode floor's job, unchanged by this car. Documented reasoning
      // for why this is the system's existing trust model, not a gap this
      // PR introduces, lives in lib/advisor.js#isAdvisorRequest's own
      // docstring.
      const r = await send(server, 'GET', '/api/master/status', null, {});
      assert.notEqual(r.data && r.data.code, 'ADVISOR_SCOPE_VIOLATION');
    });

    it('the dispatch floor does NOT refuse the Advisor calling its own API', async () => {
      const original = advisor.isAdvisorRequest;
      advisor.isAdvisorRequest = (req) => req.headers['x-tangleclaw-role'] === 'advisor';
      try {
        const r = await send(server, 'GET', '/api/advisor/status', null, { 'x-tangleclaw-role': 'advisor', 'x-tangleclaw-launch-id': 'x' });
        assert.equal(r.status, 200);
      } finally {
        advisor.isAdvisorRequest = original;
      }
    });

    it('an unverified role claim (no matching live launch) is refused by the ordinary binding floor already in place, independent of this car\'s own check', async () => {
      // isAdvisorRequest is NOT stubbed here -- a bare role+launch-id header
      // with no live Advisor session behind it fails isAdvisorRequest's own
      // verification, so this exercises the PRE-EXISTING generic
      // launch-binding floor (lib/launch-binding-guard.js), not this car's
      // ADVISOR_SCOPE_VIOLATION check -- confirming the two layers compose
      // rather than one silently relying on the other.
      const r = await send(server, 'POST', '/api/master/kill', null, { 'x-tangleclaw-role': 'advisor', 'x-tangleclaw-launch-id': 'not-live' });
      assert.notEqual(r.status, 200);
      assert.notEqual(r.data && r.data.code, 'ADVISOR_SCOPE_VIOLATION');
    });
  });
});
