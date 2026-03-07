'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const projects = require('../lib/projects');

describe('projects.create', () => {
  const createdPaths = [];

  function testProject(suffix) {
    const name = `_tc_test_${suffix}_${Date.now()}`;
    createdPaths.push(path.join(projects.PROJECTS_DIR, name));
    return name;
  }

  after(() => {
    for (const p of createdPaths) {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  });

  it('creates a blank project directory', () => {
    const name = testProject('blank');
    const result = projects.create(name);
    assert.equal(result.name, name);
    assert.ok(fs.existsSync(result.path));
  });

  it('initializes git when gitInit is true', () => {
    const name = testProject('git');
    const result = projects.create(name, { gitInit: true });
    assert.ok(fs.existsSync(path.join(result.path, '.git')));
  });

  it('writes CLAUDE.md when provided', () => {
    const name = testProject('claude');
    const result = projects.create(name, { claudeMd: '# Test\n' });
    const content = fs.readFileSync(path.join(result.path, 'CLAUDE.md'), 'utf8');
    assert.equal(content, '# Test\n');
  });

  it('rejects invalid project names', () => {
    assert.throws(() => projects.create('bad name!'), /Invalid project name/);
    assert.throws(() => projects.create('bad/name'), /Invalid project name/);
    assert.throws(() => projects.create(''), /Invalid project name/);
    assert.throws(() => projects.create(null), /Invalid project name/);
  });

  it('rejects duplicate project names', () => {
    const name = testProject('dup');
    projects.create(name);
    assert.throws(() => projects.create(name), /already exists/);
  });

  it('applies python template correctly', () => {
    const name = testProject('python');
    const result = projects.create(name, { template: 'python' });
    assert.ok(fs.existsSync(path.join(result.path, 'main.py')));
    assert.ok(fs.existsSync(path.join(result.path, 'requirements.txt')));
  });

  it('throws for nonexistent template', () => {
    const name = testProject('badtmpl');
    assert.throws(() => projects.create(name, { template: 'nonexistent' }), /not found/);
  });
});

describe('projects.getAll', () => {
  it('returns an array of project names', () => {
    const all = projects.getAll();
    assert.ok(Array.isArray(all));
    assert.ok(all.length > 0, 'Should have at least one project');
  });

  it('returns sorted names (case-insensitive)', () => {
    const all = projects.getAll();
    const sorted = [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    assert.deepEqual(all, sorted);
  });
});
