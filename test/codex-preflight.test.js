'use strict';

/*
 * #260 — lib/engines/codex-preflight.js: the Codex model-vs-auth-mode
 * predicate. Every unknown branch (auth mode unresolved, model unresolved,
 * model not in the dated retirement table) must return `null`, never a
 * guessed warning — that is the contract this file exists to pin down.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const codexPreflight = require('../lib/engines/codex-preflight');

/** A temp dir shaped like `~/.codex`, cleaned up after each test. */
function mkCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-home-'));
}

afterEach(() => {
  codexPreflight._clearAuthStatusCache();
});

describe('_codexHome', () => {
  afterEach(() => { delete process.env.CODEX_HOME; });

  it('defaults to ~/.codex', () => {
    delete process.env.CODEX_HOME;
    assert.equal(codexPreflight._codexHome(), path.join(os.homedir(), '.codex'));
  });

  it('honors CODEX_HOME when set — the same override the real CLI reads', () => {
    process.env.CODEX_HOME = '/tmp/some-other-codex-home';
    assert.equal(codexPreflight._codexHome(), '/tmp/some-other-codex-home');
  });
});

describe('KNOWN_CHATGPT_SIGNIN_RETIRED — the dated, sourced fallback table', () => {
  it('names exactly the retirements this chunk verified against the live doc on 2026-10-31', () => {
    assert.deepEqual(codexPreflight.KNOWN_CHATGPT_SIGNIN_RETIRED, {
      'gpt-5.4': '2026-08-31',
      'gpt-5.4-mini': '2026-08-31',
      'gpt-5.5': '2026-10-14'
    });
  });
});

describe('readCodexConfigModel', () => {
  const homes = [];
  afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
  const mk = () => { const h = mkCodexHome(); homes.push(h); return h; };

  it('reads the top-level model key', () => {
    const home = mk();
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-sol"\nmodel_reasoning_effort = "medium"\n');
    assert.equal(codexPreflight.readCodexConfigModel(home), 'gpt-6-sol');
  });

  it('is null when config.toml does not exist', () => {
    const home = mk();
    assert.equal(codexPreflight.readCodexConfigModel(home), null);
  });

  it('is null when the file has no model key', () => {
    const home = mk();
    fs.writeFileSync(path.join(home, 'config.toml'), 'check_for_update_on_startup = false\n');
    assert.equal(codexPreflight.readCodexConfigModel(home), null);
  });

  it('does not match a model key nested under a [section]', () => {
    const home = mk();
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      '[projects."/some/path"]\nmodel = "should-not-match"\n'
    );
    assert.equal(codexPreflight.readCodexConfigModel(home), null);
  });

  it('never throws on an unreadable file (directory in its place)', () => {
    const home = mk();
    fs.mkdirSync(path.join(home, 'config.toml'));
    assert.equal(codexPreflight.readCodexConfigModel(home), null);
  });
});

describe('readCodexAuthMode — via `codex login status`, never auth.json', () => {
  beforeEach(() => codexPreflight._clearAuthStatusCache());

  /** @param {{stdout?: string, status?: number, error?: Error}} answer */
  const spawnReturning = (answer) => () => answer;

  it('"Logged in using ChatGPT" resolves to chatgpt', () => {
    const mode = codexPreflight.readCodexAuthMode({
      force: true, spawnSyncFn: spawnReturning({ stdout: 'Logged in using ChatGPT\n', status: 0 })
    });
    assert.equal(mode, 'chatgpt');
  });

  it('"Logged in using API key" resolves to apikey', () => {
    const mode = codexPreflight.readCodexAuthMode({
      force: true, spawnSyncFn: spawnReturning({ stdout: 'Logged in using API key\n', status: 0 })
    });
    assert.equal(mode, 'apikey');
  });

  it('"Not logged in" resolves to unknown (null), not a guessed mode', () => {
    const mode = codexPreflight.readCodexAuthMode({
      force: true, spawnSyncFn: spawnReturning({ stdout: 'Not logged in\n', status: 0 })
    });
    assert.equal(mode, null);
  });

  it('a non-zero exit is unknown', () => {
    const mode = codexPreflight.readCodexAuthMode({
      force: true, spawnSyncFn: spawnReturning({ stdout: '', status: 1 })
    });
    assert.equal(mode, null);
  });

  it('a spawn error (binary missing / timeout) is unknown, never thrown', () => {
    assert.doesNotThrow(() => {
      const mode = codexPreflight.readCodexAuthMode({
        force: true, spawnSyncFn: spawnReturning({ error: new Error('ENOENT') })
      });
      assert.equal(mode, null);
    });
  });

  it('a thrown spawnSyncFn is caught, not propagated', () => {
    assert.doesNotThrow(() => {
      const mode = codexPreflight.readCodexAuthMode({
        force: true, spawnSyncFn: () => { throw new Error('boom'); }
      });
      assert.equal(mode, null);
    });
  });

  it('caches the result within the TTL — a second call does not re-spawn', () => {
    let calls = 0;
    const spawnFn = () => { calls += 1; return { stdout: 'Logged in using ChatGPT\n', status: 0 }; };
    codexPreflight.readCodexAuthMode({ force: true, spawnSyncFn: spawnFn });
    codexPreflight.readCodexAuthMode({ spawnSyncFn: spawnFn }); // no `force` — reads the cache
    assert.equal(calls, 1, 'the second call must be served from the cache, not a fresh spawn');
  });

  it('re-spawns once AUTH_STATUS_CACHE_TTL_MS has elapsed, not a moment before', () => {
    let calls = 0;
    const spawnFn = () => { calls += 1; return { stdout: 'Logged in using ChatGPT\n', status: 0 }; };
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      codexPreflight.readCodexAuthMode({ force: true, spawnSyncFn: spawnFn });
      now += codexPreflight.AUTH_STATUS_CACHE_TTL_MS - 1;
      codexPreflight.readCodexAuthMode({ spawnSyncFn: spawnFn });
      assert.equal(calls, 1, 'still inside the TTL window — must be served from the cache');
      now += 2; // now strictly past the TTL boundary
      codexPreflight.readCodexAuthMode({ spawnSyncFn: spawnFn });
      assert.equal(calls, 2, 'past the TTL, the cache must be treated as expired');
    } finally {
      Date.now = realNow;
    }
  });

  it('`force: true` bypasses the cache', () => {
    let calls = 0;
    const spawnFn = () => { calls += 1; return { stdout: 'Logged in using ChatGPT\n', status: 0 }; };
    codexPreflight.readCodexAuthMode({ force: true, spawnSyncFn: spawnFn });
    codexPreflight.readCodexAuthMode({ force: true, spawnSyncFn: spawnFn });
    assert.equal(calls, 2);
  });
});

describe('checkCodexModelCompatibility — unknown stays unknown', () => {
  const homes = [];
  afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
  const mk = (model) => {
    const h = mkCodexHome();
    homes.push(h);
    if (model) fs.writeFileSync(path.join(h, 'config.toml'), `model = "${model}"\n`);
    return h;
  };
  const chatgptSpawn = () => ({ stdout: 'Logged in using ChatGPT\n', status: 0 });
  const apikeySpawn = () => ({ stdout: 'Logged in using API key\n', status: 0 });

  it('a known-retired model under confident ChatGPT auth is incompatible', () => {
    const result = codexPreflight.checkCodexModelCompatibility({
      codexHome: mk('gpt-5.4'), force: true, spawnSyncFn: chatgptSpawn
    });
    assert.equal(result.compatible, false);
    assert.equal(result.model, 'gpt-5.4');
    assert.equal(result.authMode, 'chatgpt');
    assert.match(result.reason, /retired/);
  });

  it('the SAME known-retired model under API-key auth is not flagged', () => {
    const result = codexPreflight.checkCodexModelCompatibility({
      codexHome: mk('gpt-5.4'), force: true, spawnSyncFn: apikeySpawn
    });
    assert.notEqual(result.compatible, false, 'API-key auth is documented as unaffected by this retirement');
    assert.equal(result.compatible, null);
  });

  it('a model not in the retirement table is unknown, not assumed fine or broken', () => {
    const result = codexPreflight.checkCodexModelCompatibility({
      codexHome: mk('gpt-6-sol'), force: true, spawnSyncFn: chatgptSpawn
    });
    assert.equal(result.compatible, null);
    assert.equal(result.model, 'gpt-6-sol');
  });

  it('no configured model at all is unknown', () => {
    const result = codexPreflight.checkCodexModelCompatibility({
      codexHome: mk(null), force: true, spawnSyncFn: chatgptSpawn
    });
    assert.equal(result.compatible, null);
    assert.equal(result.model, null);
  });

  it('an undetermined auth mode is unknown even for a known-retired model', () => {
    const result = codexPreflight.checkCodexModelCompatibility({
      codexHome: mk('gpt-5.5'), force: true, spawnSyncFn: () => ({ stdout: 'Not logged in\n', status: 0 })
    });
    assert.equal(result.compatible, null);
    assert.equal(result.authMode, null);
  });
});

describe('#260 lib/sessions.js getSessionStatus — codexModelWarning', () => {
  let tmpDir;
  let sessions;
  let tmux;
  let store;
  let codexProjectId;
  let claudeProjectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-status-payload-'));
    store = require('../lib/store');
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    tmux = require('../lib/tmux');
    const codexDir = path.join(tmpDir, 'projects', 'codex-status-payload');
    fs.mkdirSync(codexDir, { recursive: true });
    codexProjectId = store.projects.create({ name: 'codex-status-payload', path: codexDir, engine: 'codex' }).id;
    const claudeDir = path.join(tmpDir, 'projects', 'claude-status-payload');
    fs.mkdirSync(claudeDir, { recursive: true });
    claudeProjectId = store.projects.create({ name: 'claude-status-payload', path: claudeDir, engine: 'claude' }).id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run `fn` with the pane probe stubbed alive and `checkCodexModelCompatibility` stubbed to `result`. */
  function withStatus(engineId, projectId, projectName, result, fn) {
    const realProbe = tmux.probeSession;
    const realCapture = tmux.capturePane;
    const realCursor = tmux.cursorInfo;
    const realCheck = codexPreflight.checkCodexModelCompatibility;
    tmux.probeSession = () => ({ live: true, answered: true, cause: null });
    tmux.capturePane = () => ({ lines: ['transcript', '', '> '] });
    tmux.cursorInfo = () => null;
    codexPreflight.checkCodexModelCompatibility = () => result;
    const session = store.sessions.start({
      projectId, engineId, tmuxSession: `tc-codex-status-${Math.random().toString(36).slice(2)}`
    });
    sessions.clearIdleCache(session.tmuxSession);
    try {
      return fn(sessions.getSessionStatus(projectName));
    } finally {
      tmux.probeSession = realProbe;
      tmux.capturePane = realCapture;
      tmux.cursorInfo = realCursor;
      codexPreflight.checkCodexModelCompatibility = realCheck;
      sessions.clearIdleCache(session.tmuxSession);
      try { store.sessions.end(session.id); } catch { /* fixture teardown */ }
    }
  }

  it('sets codexModelWarning for a codex session with a confirmed incompatibility', () => {
    const incompatible = { compatible: false, model: 'gpt-5.4', authMode: 'chatgpt', reason: 'retired 2026-08-31' };
    withStatus('codex', codexProjectId, 'codex-status-payload', incompatible, (status) => {
      assert.deepEqual(status.codexModelWarning, { model: 'gpt-5.4', authMode: 'chatgpt', reason: 'retired 2026-08-31' });
    });
  });

  it('is null for a codex session the predicate does not flag', () => {
    const unknown = { compatible: null, model: 'gpt-6-sol', authMode: 'chatgpt', reason: null };
    withStatus('codex', codexProjectId, 'codex-status-payload', unknown, (status) => {
      assert.equal(status.codexModelWarning, null);
    });
  });

  it('is null for a non-codex engine, even if the predicate would flag it — the engine gate, not just the predicate', () => {
    const incompatible = { compatible: false, model: 'gpt-5.4', authMode: 'chatgpt', reason: 'retired 2026-08-31' };
    withStatus('claude', claudeProjectId, 'claude-status-payload', incompatible, (status) => {
      assert.equal(status.codexModelWarning, null, 'checkCodexModelCompatibility must never even be consulted for a non-codex engine');
    });
  });
});

describe('toCodexModelWarning', () => {
  it('maps a confirmed incompatibility to the banner shape', () => {
    const w = codexPreflight.toCodexModelWarning({
      compatible: false, model: 'gpt-5.4', authMode: 'chatgpt', reason: 'retired 2026-08-31'
    });
    assert.deepEqual(w, { model: 'gpt-5.4', authMode: 'chatgpt', reason: 'retired 2026-08-31' });
  });

  it('is null for every other outcome, including null and undefined', () => {
    assert.equal(codexPreflight.toCodexModelWarning({ compatible: null, model: 'x', authMode: 'chatgpt', reason: null }), null);
    assert.equal(codexPreflight.toCodexModelWarning({ compatible: true, model: 'x', authMode: 'apikey', reason: null }), null);
    assert.equal(codexPreflight.toCodexModelWarning(null), null);
    assert.equal(codexPreflight.toCodexModelWarning(undefined), null);
  });
});
