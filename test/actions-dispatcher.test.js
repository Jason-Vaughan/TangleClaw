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

  it('runs invoke-critic for a prawduct project', () => {
    const project = makeProject('disp-prawduct', 'prawduct');
    const result = actions.runAction('disp-prawduct', 'invoke-critic');
    assert.equal(result.ok, true);
    assert.equal(typeof result.output.entry.branchName, 'string');
    assert.ok(fs.existsSync(path.join(project.path, '.tangleclaw', 'critic-runs.json')));
  });

  it('rejects an action not declared by the project methodology', () => {
    makeProject('disp-minimal', 'minimal');
    // `minimal` template does not declare invoke-critic in `actions[]`.
    const result = actions.runAction('disp-minimal', 'invoke-critic');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('does not declare action'));
  });

  it('rejects an unknown command even if methodology declared something else', () => {
    makeProject('disp-prawduct-2', 'prawduct');
    const result = actions.runAction('disp-prawduct-2', 'frobnicate');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('does not declare action'));
  });

  it('returns "Project not found" for missing project', () => {
    const result = actions.runAction('nonexistent', 'invoke-critic');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('validates input parameters', () => {
    assert.equal(actions.runAction(null, 'invoke-critic').ok, false);
    assert.equal(actions.runAction('', 'invoke-critic').ok, false);
    assert.equal(actions.runAction('any', null).ok, false);
    assert.equal(actions.runAction('any', '').ok, false);
  });

  it('forwards options to the handler', () => {
    const project = makeProject('disp-opts', 'prawduct');
    const result = actions.runAction('disp-opts', 'invoke-critic', {
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

  it('catches a handler that throws and reports a structured error', () => {
    makeProject('disp-throw', 'prawduct');
    const original = actions.ACTION_DISPATCH['invoke-critic'].run;
    actions.ACTION_DISPATCH['invoke-critic'].run = () => { throw new Error('handler exploded'); };
    try {
      const result = actions.runAction('disp-throw', 'invoke-critic');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('threw'));
      assert.ok(result.error.includes('handler exploded'));
    } finally {
      actions.ACTION_DISPATCH['invoke-critic'].run = original;
    }
  });
});
