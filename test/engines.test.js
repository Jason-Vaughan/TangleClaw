'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const engines = require('../lib/engines');

describe('engines', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-engines-test-'));
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('detect', () => {
    it('should return an array of detection results', () => {
      const results = engines.detect();
      assert.ok(Array.isArray(results));
      for (const result of results) {
        assert.ok(typeof result.id === 'string');
        assert.ok(typeof result.available === 'boolean');
      }
    });

    it('should detect engines with "which" strategy', () => {
      const results = engines.detect();
      // At least the bundled profiles should be checked
      assert.ok(results.length > 0);
    });
  });

  describe('detectEngine', () => {
    it('should detect an available binary', () => {
      // "node" should be available
      const result = engines.detectEngine({
        id: 'test-node',
        detection: { strategy: 'which', target: 'node' }
      });
      assert.equal(result.id, 'test-node');
      assert.equal(result.available, true);
      assert.ok(result.path);
    });

    it('should handle unavailable binary', () => {
      const result = engines.detectEngine({
        id: 'test-missing',
        detection: { strategy: 'which', target: '__nonexistent_binary_12345__' }
      });
      assert.equal(result.id, 'test-missing');
      assert.equal(result.available, false);
      assert.equal(result.path, null);
    });

    it('should detect by path', () => {
      const result = engines.detectEngine({
        id: 'test-path',
        detection: { strategy: 'path', target: '/usr/bin/env' }
      });
      assert.equal(result.available, true);
      assert.equal(result.path, '/usr/bin/env');
    });

    it('should handle missing path', () => {
      const result = engines.detectEngine({
        id: 'test-path-missing',
        detection: { strategy: 'path', target: '/nonexistent/binary' }
      });
      assert.equal(result.available, false);
      assert.equal(result.path, null);
    });

    it('should handle unknown strategy', () => {
      const result = engines.detectEngine({
        id: 'test-unknown',
        detection: { strategy: 'magic', target: 'foo' }
      });
      assert.equal(result.available, false);
    });

    it('should handle profile with no detection', () => {
      const result = engines.detectEngine({ id: 'no-detect' });
      assert.equal(result.available, false);
    });
  });

  describe('validateProfile', () => {
    it('should validate a complete profile', () => {
      const profile = {
        id: 'test',
        name: 'Test Engine',
        command: 'test',
        interactionModel: 'session',
        configFormat: { filename: 'test.md', syntax: 'markdown', generator: 'test-md' },
        detection: { strategy: 'which', target: 'test' },
        launch: { shellCommand: 'test', args: [], env: {} }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('should catch missing required fields', () => {
      const result = engines.validateProfile({});
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.some((e) => e.includes('id')));
    });

    it('should catch invalid interactionModel', () => {
      const profile = {
        id: 'test',
        name: 'Test',
        command: 'test',
        interactionModel: 'invalid',
        configFormat: { filename: 'f', syntax: 's', generator: 'g' },
        detection: { strategy: 'which', target: 't' }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('interactionModel')));
    });

    it('should require launch for session engines', () => {
      const profile = {
        id: 'test',
        name: 'Test',
        command: 'test',
        interactionModel: 'session',
        configFormat: { filename: 'f', syntax: 's', generator: 'g' },
        detection: { strategy: 'which', target: 't' }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('launch')));
    });

    it('should not require launch for persistent engines', () => {
      const profile = {
        id: 'test',
        name: 'Test',
        command: 'test',
        interactionModel: 'persistent',
        configFormat: { filename: 'f', syntax: 's', generator: 'g' },
        detection: { strategy: 'which', target: 't' }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, true);
    });
  });

  describe('listWithAvailability', () => {
    it('should return profiles with availability info', () => {
      const list = engines.listWithAvailability();
      assert.ok(Array.isArray(list));
      for (const engine of list) {
        assert.ok(typeof engine.id === 'string');
        assert.ok(typeof engine.name === 'string');
        assert.ok(typeof engine.available === 'boolean');
      }
    });
  });

  describe('getWithAvailability', () => {
    it('should return null for non-existent engine', () => {
      const result = engines.getWithAvailability('__nonexistent__');
      assert.equal(result, null);
    });

    it('should return profile with availability for existing engine', () => {
      const result = engines.getWithAvailability('claude-code');
      assert.ok(result !== null);
      assert.equal(result.id, 'claude-code');
      assert.ok(typeof result.available === 'boolean');
    });
  });

  describe('generateConfig', () => {
    it('should generate CLAUDE.md content', () => {
      const projectConfig = {
        rules: {
          core: {
            changelogPerChange: true,
            jsdocAllFunctions: true,
            unitTestRequirements: true,
            sessionWrapProtocol: true,
            porthubRegistration: true
          },
          extensions: {
            identitySentry: true,
            docsParity: false
          }
        }
      };
      const template = { id: 'prawduct', name: 'Prawduct', description: 'Test methodology' };

      const content = engines.generateConfig('claude-code', projectConfig, template);
      assert.ok(content);
      assert.ok(content.includes('CLAUDE.md'));
      assert.ok(content.includes('Core Rules'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('identitySentry') || content.includes('identity'));
      assert.ok(content.includes('Prawduct'));
    });

    it('should return null for non-existent engine', () => {
      const result = engines.generateConfig('__nonexistent__', {});
      assert.equal(result, null);
    });

    it('should generate codex yaml', () => {
      const content = engines._generateCodexYaml(
        { rules: { extensions: { loggingLevel: 'debug' } } },
        { id: 'prawduct' }
      );
      assert.ok(content.includes('methodology: prawduct'));
      assert.ok(content.includes('logging_level: debug'));
    });

    it('should generate aider conf', () => {
      const content = engines._generateAiderConf(
        { rules: { extensions: { loggingLevel: 'debug' } } },
        null
      );
      assert.ok(content.includes('verbose: true'));
    });
  });

  describe('_generateClaudeMd', () => {
    it('should include all core rules by default', () => {
      const content = engines._generateClaudeMd({}, null);
      assert.ok(content.includes('CHANGELOG'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('tests'));
      assert.ok(content.includes('session wrap'));
      assert.ok(content.includes('PortHub'));
    });

    it('should include methodology info when provided', () => {
      const content = engines._generateClaudeMd({}, { name: 'TiLT', description: 'Identity-first' });
      assert.ok(content.includes('TiLT'));
      assert.ok(content.includes('Identity-first'));
    });

    it('should include active extension rules', () => {
      const config = {
        rules: {
          extensions: {
            identitySentry: true,
            docsParity: true,
            decisionFramework: false
          }
        }
      };
      const content = engines._generateClaudeMd(config, null);
      assert.ok(content.includes('Extension Rules'));
      assert.ok(content.includes('identity') || content.includes('sentry'));
      assert.ok(content.includes('docs'));
    });
  });
});
