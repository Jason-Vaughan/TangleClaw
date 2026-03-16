'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');

describe('store.globalRules', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-globalrules-test-'));
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load defaults when no user file exists', () => {
    const content = store.globalRules.load();
    assert.ok(content.includes('Global Rules'), 'Should contain default header');
    assert.ok(content.length > 0);
  });

  it('should create user file from defaults on first load', () => {
    const userFile = path.join(tempDir, 'global-rules.md');
    assert.ok(fs.existsSync(userFile), 'User file should be created');
  });

  it('should return saved content on subsequent loads', () => {
    const custom = '# My Custom Rules\n\n- Rule one\n- Rule two\n';
    store.globalRules.save(custom);
    const loaded = store.globalRules.load();
    assert.equal(loaded, custom);
  });

  it('should reset to bundled defaults', () => {
    store.globalRules.save('# Totally custom stuff');
    const defaults = store.globalRules.reset();
    assert.ok(defaults.includes('Global Rules'), 'Reset should restore default header');
    const loaded = store.globalRules.load();
    assert.equal(loaded, defaults);
  });

  it('should save empty content', () => {
    store.globalRules.save('');
    const loaded = store.globalRules.load();
    assert.equal(loaded, '');
  });

  it('should handle unicode content', () => {
    const unicode = '# Rules\n\n- Use proper encoding: \u00e9\u00e0\u00fc\u00f1\n';
    store.globalRules.save(unicode);
    assert.equal(store.globalRules.load(), unicode);
  });
});
