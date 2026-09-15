'use strict';

/*
 * The launch baseline (#1309, #1406): what a project's tree looked like when a
 * session launched. Capture is driven against REAL temp repos rather than a
 * stubbed git, because the whole point is the shape git actually prints —
 * porcelain rename records, untracked-file expansion, a repo with no commits.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchBaseline = require('../lib/launch-baseline');

/**
 * Run git in a directory with a fixed identity.
 * @param {string} cwd - Repo directory.
 * @param {...string} args - Argv after `git`.
 * @returns {string} Trimmed stdout.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  }).trim();
}

/**
 * Make a repo with one commit containing `a.txt` and `dir/b.txt`.
 * @returns {string} Repo path.
 */
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-baseline-')));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.mkdirSync(path.join(dir, 'dir'));
  fs.writeFileSync(path.join(dir, 'dir', 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('launch-baseline.capture', () => {
  const dirs = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  it('records HEAD, the toplevel, and an empty dirty set on a clean repo', () => {
    const dir = makeRepo(); dirs.push(dir);
    const b = launchBaseline.capture(dir);
    assert.equal(b.sha, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(b.toplevel, dir);
    assert.deepEqual(b.dirty, { paths: [], truncated: false });
  });

  it('lists modified, deleted, and untracked files — each untracked file, not its directory', () => {
    const dir = makeRepo(); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    fs.rmSync(path.join(dir, 'dir', 'b.txt'));
    fs.mkdirSync(path.join(dir, 'new'));
    fs.writeFileSync(path.join(dir, 'new', 'c.txt'), 'c\n');
    const b = launchBaseline.capture(dir);
    assert.deepEqual([...b.dirty.paths].sort(), ['a.txt', 'dir/b.txt', 'new/c.txt']);
  });

  it('records paths relative to the repo root even when the project is a subdirectory', () => {
    const dir = makeRepo(); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'dir', 'b.txt'), 'changed\n');
    const b = launchBaseline.capture(path.join(dir, 'dir'));
    assert.equal(b.toplevel, dir);
    assert.deepEqual(b.dirty.paths, ['dir/b.txt']);
  });

  it('records both names of a staged rename', () => {
    const dir = makeRepo(); dirs.push(dir);
    git(dir, 'mv', 'a.txt', 'renamed.txt');
    const b = launchBaseline.capture(dir);
    assert.deepEqual([...b.dirty.paths].sort(), ['a.txt', 'renamed.txt']);
  });

  it('is null for a directory that is not a repo, and for a repo with no commits', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-plain-')); dirs.push(plain);
    assert.equal(launchBaseline.capture(plain), null);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-empty-')); dirs.push(empty);
    git(empty, 'init', '-q');
    assert.equal(launchBaseline.capture(empty), null, 'no HEAD means no start point to measure from');
    assert.equal(launchBaseline.capture(null), null);
  });

  it('keeps the start point but records dirty as NOT captured when only the status listing fails', () => {
    const dir = makeRepo(); dirs.push(dir);
    const exec = (file, args, opts) => {
      if (args[0] === 'status') {
        const err = new Error('spawnSync git ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return execFileSync(file, args, opts);
    };
    const b = launchBaseline.capture(dir, { exec });
    assert.equal(b.sha, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(b.dirty, null, 'a stopped listing is not a clean tree');
  });

  it('marks the dirty set truncated past the cap rather than storing a partial list as complete', () => {
    const dir = makeRepo(); dirs.push(dir);
    const many = Array.from({ length: launchBaseline.MAX_DIRTY_PATHS + 3 }, (_, i) => `?? f${i}`).join('\0') + '\0';
    const exec = (file, args, opts) => (args[0] === 'status' ? many : execFileSync(file, args, opts));
    const b = launchBaseline.capture(dir, { exec });
    assert.equal(b.dirty.truncated, true);
    assert.equal(b.dirty.paths.length, launchBaseline.MAX_DIRTY_PATHS);
  });
});

describe('store.sessions launch baseline (schema v39)', () => {
  let tmpDir;
  let projectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-launch-baseline-'));
    store._setBasePath(tmpDir);
    store.init();
    projectId = store.projects.create({ name: 'lb-test', path: '/tmp/lb-test' }).id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a baseline, and keeps it off the session object every API serves', () => {
    const baseline = { sha: 'a'.repeat(40), toplevel: '/tmp/lb-test', dirty: { paths: ['x.js', 'y/z.md'], truncated: false } };
    const s = store.sessions.start({ projectId, engineId: 'claude', launchBaseline: baseline });
    assert.deepEqual(store.sessions.getLaunchBaseline(s.id), baseline);
    assert.equal('launchBaseline' in store.sessions.get(s.id), false);
    store.sessions.kill(s.id, 'test');
  });

  it('reads null for a session started with no baseline, and for an unknown id', () => {
    const s = store.sessions.start({ projectId, engineId: 'claude' });
    assert.equal(store.sessions.getLaunchBaseline(s.id), null);
    assert.equal(store.sessions.getLaunchBaseline(999999), null);
    store.sessions.kill(s.id, 'test');
  });

  it('reads a corrupt dirty column as not captured, keeping the start point', () => {
    const s = store.sessions.start({ projectId, engineId: 'claude', launchBaseline: { sha: 'b'.repeat(40), toplevel: '/t', dirty: null } });
    store.getDb().prepare('UPDATE sessions SET launch_dirty = ? WHERE id = ?').run('{not json', s.id);
    assert.deepEqual(store.sessions.getLaunchBaseline(s.id), { sha: 'b'.repeat(40), toplevel: '/t', dirty: null });
    store.sessions.kill(s.id, 'test');
  });
});

// Sibling top-level describe: the suite above has already run init at the
// current schema, which would pre-create the columns this migration adds.
describe('sessions v38→v39 launch baseline migration on a REAL old DB', () => {
  it('adds the three columns to an existing sessions table; old rows read no baseline', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lb-mig-'));
    try {
      const { DatabaseSync } = require('node:sqlite');
      const seed = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      seed.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO schema_version (version) VALUES (38);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL, engine_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          archived INTEGER NOT NULL DEFAULT 0, migration_status TEXT, orchestration_profile TEXT
        );
        INSERT INTO projects (id, name, path) VALUES (1, 'pre-v39', '/tmp/pre-v39');
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          engine_id TEXT NOT NULL, tmux_session TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
          status TEXT NOT NULL DEFAULT 'active', wrap_summary TEXT, prime_prompt TEXT, duration_seconds INTEGER,
          session_mode TEXT NOT NULL DEFAULT 'tmux', launch_mode TEXT, wrap_started_at TEXT, owner TEXT
        );
        INSERT INTO sessions (project_id, engine_id, tmux_session) VALUES (1, 'claude', 'pre-v39-sess');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();
      const db = store.getDb();
      assert.equal(db.prepare('SELECT MAX(version) v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
      const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
      for (const c of ['launch_sha', 'launch_toplevel', 'launch_dirty']) assert.ok(cols.includes(c), `adds ${c}`);
      assert.equal(store.sessions.getLaunchBaseline(1), null, 'a pre-migration session has no baseline');
      const fresh = store.sessions.start({ projectId: 1, engineId: 'claude', launchBaseline: { sha: 'c'.repeat(40), toplevel: '/x', dirty: { paths: [], truncated: false } } });
      assert.equal(store.sessions.getLaunchBaseline(fresh.id).sha, 'c'.repeat(40));
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('launchSession stamps the baseline taken before the launch writes anything', () => {
  let tmpDir;
  let sessions;
  let tmux;
  let engines;
  const saved = {};
  const { installTmuxGuard, removeTmuxGuard, reapFixtureSessions } = require('./_tmux-guard');

  before(() => {
    installTmuxGuard();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lb-launch-'));
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    tmux = require('../lib/tmux');
    engines = require('../lib/engines');
    saved.createSession = tmux.createSession;
    saved.probeSession = tmux.probeSession;
    saved.sendKeys = tmux.sendKeys;
    saved.detectEngine = engines.detectEngine;
    tmux.createSession = () => true;
    tmux.probeSession = () => ({ live: false, answered: true, cause: null });
    tmux.sendKeys = () => true;
    engines.detectEngine = () => ({ available: true, path: '/usr/bin/engine' });
  });

  after(() => {
    tmux.createSession = saved.createSession;
    tmux.probeSession = saved.probeSession;
    tmux.sendKeys = saved.sendKeys;
    engines.detectEngine = saved.detectEngine;
    store.close();
    removeTmuxGuard();
    const leaked = reapFixtureSessions(['lbl-']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.deepEqual(leaked, [], `leaked tmux sessions: ${leaked.join(', ')}`);
  });

  it('records HEAD and the pre-existing dirty file, and not the files the launch itself generated', () => {
    const dir = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'operator wip\n');
      // Track the engine config file the launch regenerates, clean, so a launch
      // that captured AFTER writing it would list it as dirty.
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# placeholder\n');
      git(dir, 'add', 'CLAUDE.md');
      git(dir, 'commit', '-q', '-m', 'track CLAUDE.md');
      store.projects.create({ name: 'lbl-repo', path: dir, engine: 'claude' });
      store.projectConfig.save(dir, { engine: 'claude' });
      const result = sessions.launchSession('lbl-repo');
      assert.ok(result.session, `launch must succeed: ${result.error}`);
      const b = store.sessions.getLaunchBaseline(result.session.id);
      assert.equal(b.sha, git(dir, 'rev-parse', 'HEAD'));
      assert.ok(b.dirty.paths.includes('a.txt'), 'the operator\'s uncommitted file is recorded');
      assert.equal(b.dirty.paths.includes('CLAUDE.md'), false,
        'a file the launch regenerates is this session\'s change, not dirty-before-launch');
      assert.notEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# placeholder\n',
        'fixture precondition: the launch really did rewrite CLAUDE.md');
      store.sessions.kill(result.session.id, 'test cleanup');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('heals after the baseline: the migrated project.json is the session\'s change, and the prime says so (#1511)', () => {
    const dir = makeRepo();
    try {
      fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), `${JSON.stringify({ engine: 'claude', silentPrime: false, lastWrapSha: 'abc1234' }, null, 2)}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'track project.json with the retired key');
      store.projects.create({ name: 'lbl-heal', path: dir, engine: 'claude' });
      const result = sessions.launchSession('lbl-heal');
      assert.ok(result.session, `launch must succeed: ${result.error}`);

      const b = store.sessions.getLaunchBaseline(result.session.id);
      assert.equal(b.dirty.paths.includes('.tangleclaw/project.json'), false,
        'heal ran before the baseline, so its rewrite would read as dirty-before-launch and repeat every session');
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.tangleclaw', 'project.json'), 'utf8'));
      assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'lastWrapSha'), false, 'the launch migrated the key');
      assert.equal(require('../lib/wrap-state').readLastWrapSha(dir).sha, 'abc1234');
      assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /BEGIN:tangleclaw-state/);
      assert.match(result.primePrompt, /TangleClaw housekeeping: moved lastWrapSha out of project\.json/);
      store.sessions.kill(result.session.id, 'test cleanup');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the web UI launch path heals too, after its baseline', async () => {
    const tunnel = require('../lib/tunnel');
    const heal = require('../lib/project-heal');
    const launchBaseline = require('../lib/launch-baseline');
    const order = [];
    const savedTunnel = { detectTunnel: tunnel.detectTunnel, ensureTunnel: tunnel.ensureTunnel };
    const savedHeal = heal.healOnLaunch;
    const savedCapture = launchBaseline.capture;
    tunnel.detectTunnel = async () => ({ active: false });
    tunnel.ensureTunnel = async () => ({ ok: false, error: 'no tunnel in tests' });
    heal.healOnLaunch = (p) => { order.push(['heal', p]); return { report: null }; };
    launchBaseline.capture = (p) => { order.push(['baseline', p]); return null; };
    try {
      const r = await sessions.launchWebuiSession('lbl-webui', { localPort: 1, host: 'h' }, 'openclaw:x', {}, { path: '/tmp/lbl-webui' });
      assert.match(r.error, /Tunnel failed/, 'fixture: the launch stops at the stubbed tunnel');
      assert.deepEqual(order, [['baseline', '/tmp/lbl-webui'], ['heal', '/tmp/lbl-webui']]);
    } finally {
      Object.assign(tunnel, savedTunnel);
      heal.healOnLaunch = savedHeal;
      launchBaseline.capture = savedCapture;
    }
  });
});
