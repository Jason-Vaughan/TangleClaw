'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const projects = require('../lib/projects');

describe('templates.getTemplates', () => {
  it('returns an array of templates', () => {
    const templates = projects.getTemplates();
    assert.ok(Array.isArray(templates));
    assert.ok(templates.length >= 4, `Expected at least 4 templates, got ${templates.length}`);
  });

  it('blank template is always first', () => {
    const templates = projects.getTemplates();
    assert.equal(templates[0].id, 'blank');
  });

  it('each template has required fields', () => {
    const templates = projects.getTemplates();
    for (const t of templates) {
      assert.ok(t.id, 'template must have id');
      assert.ok(t.name, 'template must have name');
      assert.equal(typeof t.description, 'string');
      assert.ok(Array.isArray(t.tags));
    }
  });
});

describe('templates.getTemplateFiles', () => {
  it('returns file list for node template', () => {
    const detail = projects.getTemplateFiles('node');
    assert.ok(detail);
    assert.equal(detail.id, 'node');
    assert.ok(detail.files.length > 0, 'node template should have files');
    assert.ok(detail.files.includes('index.js'));
    assert.ok(detail.files.includes('package.json.tmpl'));
  });

  it('returns null for nonexistent template', () => {
    const detail = projects.getTemplateFiles('nonexistent');
    assert.equal(detail, null);
  });

  it('excludes template.json from file list', () => {
    const detail = projects.getTemplateFiles('node');
    assert.ok(!detail.files.includes('template.json'));
  });

  it('blank template has no files besides template.json', () => {
    const detail = projects.getTemplateFiles('blank');
    assert.ok(detail);
    assert.equal(detail.files.length, 0);
  });
});

describe('templates.applyTemplate via create', () => {
  const testName = '_tc_test_' + Date.now();
  const testPath = path.join(projects.PROJECTS_DIR, testName);

  after(() => {
    // Clean up test project
    if (fs.existsSync(testPath)) {
      fs.rmSync(testPath, { recursive: true, force: true });
    }
  });

  it('creates project with node template and substitutes variables', () => {
    const result = projects.create(testName, { template: 'node' });
    assert.equal(result.name, testName);
    assert.ok(fs.existsSync(testPath));

    // package.json should exist (stripped .tmpl extension)
    const pkgPath = path.join(testPath, 'package.json');
    assert.ok(fs.existsSync(pkgPath), 'package.json should exist');

    // {{PROJECT_NAME}} should be substituted
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.name, testName);

    // index.js should exist
    assert.ok(fs.existsSync(path.join(testPath, 'index.js')));
  });
});
