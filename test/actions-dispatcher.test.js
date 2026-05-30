'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('lib/actions dispatcher (#139 Chunk 11b)', () => {
  let actions;
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-actions-disp-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    actions = require('../lib/actions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a fresh project + git repo for a test. */
  function makeProject(name, methodologyId) {
    const projPath = path.join(projectsDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    execSync('git init -q', { cwd: projPath });
    execSync('git config user.email test@example.com', { cwd: projPath });
    execSync('git config user.name test', { cwd: projPath });
    execSync('git commit --allow-empty -m init -q', { cwd: projPath });
    return store.projects.create({
      name,
      path: projPath,
      engine: 'claude',
      methodology: methodologyId
    });
  }

  beforeEach(() => {
    // Best-effort cleanup of any state from prior tests so each test
    // gets a fresh project namespace.
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        try {
          const proj = store.projects.getByName(entry.name);
          if (proj) store.projects.delete(proj.id);
        } catch { /* ignore */ }
        fs.rmSync(path.join(projectsDir, entry.name), { recursive: true, force: true });
      }
    }
  });

  it('runs invoke-critic for a prawduct project', async () => {
    const project = makeProject('disp-prawduct', 'prawduct');
    const result = await actions.runAction('disp-prawduct', 'invoke-critic');
    assert.equal(result.ok, true);
    assert.equal(typeof result.output.entry.branchName, 'string');
    assert.ok(fs.existsSync(path.join(project.path, '.tangleclaw', 'critic-runs.json')));
  });

  it('rejects an action not declared by the project methodology', async () => {
    makeProject('disp-minimal', 'minimal');
    // `minimal` template does not declare invoke-critic in `actions[]`.
    const result = await actions.runAction('disp-minimal', 'invoke-critic');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('does not declare action'));
  });

  it('rejects an unknown command even if methodology declared something else', async () => {
    makeProject('disp-prawduct-2', 'prawduct');
    const result = await actions.runAction('disp-prawduct-2', 'frobnicate');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('does not declare action'));
  });

  it('returns "Project not found" for missing project', async () => {
    const result = await actions.runAction('nonexistent', 'invoke-critic');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('validates input parameters', async () => {
    assert.equal((await actions.runAction(null, 'invoke-critic')).ok, false);
    assert.equal((await actions.runAction('', 'invoke-critic')).ok, false);
    assert.equal((await actions.runAction('any', null)).ok, false);
    assert.equal((await actions.runAction('any', '')).ok, false);
  });

  it('forwards options to the handler', async () => {
    const project = makeProject('disp-opts', 'prawduct');
    const result = await actions.runAction('disp-opts', 'invoke-critic', {
      branchName: 'forwarded/branch',
      now: () => new Date('2026-05-19T05:00:00.000Z')
    });
    assert.equal(result.ok, true);
    const arr = JSON.parse(fs.readFileSync(
      path.join(project.path, '.tangleclaw', 'critic-runs.json'), 'utf8'
    ));
    assert.equal(arr[0].branchName, 'forwarded/branch');
    assert.equal(arr[0].timestamp, '2026-05-19T05:00:00.000Z');
  });

  it('catches a handler that throws and reports a structured error', async () => {
    makeProject('disp-throw', 'prawduct');
    const original = actions.ACTION_DISPATCH['invoke-critic'].run;
    actions.ACTION_DISPATCH['invoke-critic'].run = () => { throw new Error('handler exploded'); };
    try {
      const result = await actions.runAction('disp-throw', 'invoke-critic');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('threw'));
      assert.ok(result.error.includes('handler exploded'));
    } finally {
      actions.ACTION_DISPATCH['invoke-critic'].run = original;
    }
  });

  it('injects the active session from store.sessions.getActive into handler options (#267)', async () => {
    // Critic regression pin: the dispatcher's session-injection
    // contract was unverified by the original test suite — only the
    // BLOCKING engine-field bug surfaced it. This test pins that
    // (a) a real active session created via `store.sessions.create`
    // is looked up and injected as `options.session`, AND
    // (b) the injected record carries the production `engineId` field
    // so handlers reading the right field receive the engine identifier.
    const project = makeProject('disp-session-inject', 'prawduct');
    const session = store.sessions.start({
      projectId: project.id,
      engineId: 'claude',
      tmuxSession: 'tc-test-session-inject',
      primePrompt: ''
    });
    // Capture what the handler actually received via the dispatch path.
    let receivedOptions = null;
    const original = actions.ACTION_DISPATCH['invoke-critic'].run;
    actions.ACTION_DISPATCH['invoke-critic'].run = (project, options) => {
      receivedOptions = options;
      return { ok: true, output: { entry: { branchName: 'test', timestamp: 'x' } }, error: null };
    };
    try {
      await actions.runAction('disp-session-inject', 'invoke-critic');
      assert.ok(receivedOptions, 'handler was invoked');
      assert.ok(receivedOptions.session, 'dispatcher injected session into options');
      assert.equal(receivedOptions.session.id, session.id,
        'injected session matches the active session for this project');
      assert.equal(receivedOptions.session.engineId, 'claude',
        'session record carries the engineId field that the engine-guard reads');
      assert.equal(receivedOptions.session.tmuxSession, 'tc-test-session-inject',
        'session record carries the tmuxSession field that the dispatch path needs');
    } finally {
      actions.ACTION_DISPATCH['invoke-critic'].run = original;
      store.sessions.kill(session.id, 'test cleanup');
    }
  });

  it('does NOT overwrite explicit options.session from the caller (test-injection seam preserved)', async () => {
    makeProject('disp-session-seam', 'prawduct');
    const fakeSession = { id: 'caller-supplied', tmuxSession: 'fake', engineId: 'gemini' };
    let receivedOptions = null;
    const original = actions.ACTION_DISPATCH['invoke-critic'].run;
    actions.ACTION_DISPATCH['invoke-critic'].run = (project, options) => {
      receivedOptions = options;
      return { ok: true, output: {}, error: null };
    };
    try {
      await actions.runAction('disp-session-seam', 'invoke-critic', { session: fakeSession });
      assert.equal(receivedOptions.session, fakeSession,
        'caller-supplied session passes through unchanged — dispatcher does not stomp');
    } finally {
      actions.ACTION_DISPATCH['invoke-critic'].run = original;
    }
  });
});
