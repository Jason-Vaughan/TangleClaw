'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');

describe('migration — detectExistingProjects', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-migration-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();

    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects project with .tangleclaw/project.json marker', () => {
    const projDir = path.join(projectsDir, 'tc-marked');
    fs.mkdirSync(path.join(projDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.tangleclaw', 'project.json'), '{}');

    const result = projects.detectExistingProjects();
    const found = result.detected.find(d => d.name === 'tc-marked');
    assert.ok(found, 'should detect project with .tangleclaw config');
    assert.equal(found.hasTangleclawConfig, true);
  });

  it('detects project with .prawduct methodology marker', () => {
    const projDir = path.join(projectsDir, 'prawduct-proj');
    fs.mkdirSync(path.join(projDir, '.prawduct'), { recursive: true });

    const result = projects.detectExistingProjects();
    const found = result.detected.find(d => d.name === 'prawduct-proj');
    assert.ok(found, 'should detect project with .prawduct marker');
    assert.ok(found.methodology, 'should have detected methodology');
  });

  it('detects project with .tilt methodology marker', () => {
    const projDir = path.join(projectsDir, 'tilt-proj');
    fs.mkdirSync(path.join(projDir, '.tilt'), { recursive: true });

    const result = projects.detectExistingProjects();
    const found = result.detected.find(d => d.name === 'tilt-proj');
    assert.ok(found, 'should detect project with .tilt marker');
  });

  it('skips already registered projects', () => {
    // Create and register a project
    projects.createProject({ name: 'registered-proj', methodology: 'minimal', gitInit: false });

    const result = projects.detectExistingProjects();
    assert.ok(!result.detected.some(d => d.name === 'registered-proj'),
      'should not detect already registered project');
  });

  it('skips hidden directories', () => {
    fs.mkdirSync(path.join(projectsDir, '.hidden-project'), { recursive: true });
    fs.mkdirSync(path.join(projectsDir, '.hidden-project', '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, '.hidden-project', '.tangleclaw', 'project.json'), '{}');

    const result = projects.detectExistingProjects();
    assert.ok(!result.detected.some(d => d.name === '.hidden-project'),
      'should skip hidden directories');
  });

  it('skips non-directory entries', () => {
    fs.writeFileSync(path.join(projectsDir, 'just-a-file.txt'), 'not a project');

    const result = projects.detectExistingProjects();
    assert.ok(!result.detected.some(d => d.name === 'just-a-file.txt'),
      'should skip regular files');
  });

  it('returns empty array for empty projectsDir', () => {
    const emptyDir = path.join(tmpDir, 'empty-projects');
    fs.mkdirSync(emptyDir, { recursive: true });

    const config = store.config.load();
    const origDir = config.projectsDir;
    config.projectsDir = emptyDir;
    store.config.save(config);

    const result = projects.detectExistingProjects();
    assert.deepEqual(result.detected, []);
    assert.deepEqual(result.errors, []);

    // Restore
    config.projectsDir = origDir;
    store.config.save(config);
  });

  it('detects project with both .tangleclaw and methodology markers', () => {
    const projDir = path.join(projectsDir, 'both-markers');
    fs.mkdirSync(path.join(projDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.tangleclaw', 'project.json'), '{}');
    fs.mkdirSync(path.join(projDir, '.prawduct'), { recursive: true });

    const result = projects.detectExistingProjects();
    const found = result.detected.find(d => d.name === 'both-markers');
    assert.ok(found, 'should detect project with both markers');
    assert.equal(found.hasTangleclawConfig, true);
    assert.ok(found.methodology, 'should also detect methodology');
  });
});
