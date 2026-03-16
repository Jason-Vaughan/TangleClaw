'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const engines = require('../lib/engines');
const portScanner = require('../lib/port-scanner');
const porthub = require('../lib/porthub');

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
      const result = engines.getWithAvailability('claude');
      assert.ok(result !== null);
      assert.equal(result.id, 'claude');
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

      const content = engines.generateConfig('claude', projectConfig, template);
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

    it('should generate codex yaml with instructions containing rules', () => {
      const content = engines._generateCodexYaml(
        { rules: { extensions: { loggingLevel: 'debug' } } },
        { id: 'prawduct', name: 'Prawduct', description: 'Test methodology' }
      );
      assert.ok(content.includes('methodology: prawduct'));
      assert.ok(content.includes('logging_level: debug'));
      assert.ok(content.includes('instructions: |'), 'Should have instructions block');
      assert.ok(content.includes('Core Rules'), 'Instructions should contain core rules');
      assert.ok(content.includes('PortHub'), 'Instructions should mention PortHub');
    });

    it('should produce valid YAML block scalar indentation in codex instructions', () => {
      const content = engines._generateCodexYaml(
        { rules: { core: { porthubRegistration: true } } },
        { id: 'test', name: 'Test', description: 'Test methodology' }
      );
      const instrStart = content.indexOf('instructions: |');
      assert.ok(instrStart >= 0, 'Should have instructions block');
      // Every line after "instructions: |" that is part of the block scalar
      // must start with exactly 2 spaces (or be blank)
      const afterInstr = content.slice(instrStart + 'instructions: |\n'.length);
      const instrLines = afterInstr.split('\n');
      for (let i = 0; i < instrLines.length; i++) {
        const line = instrLines[i];
        if (line.length === 0 || line.trim() === '') continue;
        assert.ok(line.startsWith('  '),
          `Line ${i + 1} of instructions block must start with 2-space indent, got: "${line.slice(0, 40)}..."`);
      }
    });

    it('should generate aider conf with rules as comments', () => {
      const content = engines._generateAiderConf(
        { rules: { extensions: { loggingLevel: 'debug' } } },
        null
      );
      assert.ok(content.includes('verbose: true'));
      assert.ok(content.includes('# Core Rules'), 'Should have core rules as comments');
      assert.ok(content.includes('PortHub'), 'Should mention PortHub');
    });

    it('should generate aider config via public API (regression: generator name mismatch)', () => {
      const content = engines.generateConfig('aider', {
        rules: { core: {}, extensions: {} }
      });
      assert.ok(content !== null, 'generateConfig("aider") must not return null — check profile generator matches switch case');
      assert.ok(typeof content === 'string');
      assert.ok(content.length > 0);
    });
  });

  describe('_getRulesContent', () => {
    it('should return core rules by default', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.coreRulesLines.length > 0, 'Should have default core rules');
      assert.ok(rules.coreRulesLines.some(r => r.includes('CHANGELOG')));
      assert.ok(rules.coreRulesLines.some(r => r.includes('PortHub')));
    });

    it('should respect disabled core rules', () => {
      const rules = engines._getRulesContent({
        rules: { core: { changelogPerChange: false, porthubRegistration: false } }
      });
      assert.ok(!rules.coreRulesLines.some(r => r.includes('CHANGELOG')));
      assert.ok(!rules.coreRulesLines.some(r => r.includes('PortHub')));
      assert.equal(rules.porthubGuide, null, 'PortHub guide should be null when disabled');
    });

    it('should include extension rules', () => {
      const rules = engines._getRulesContent({
        rules: { extensions: { identitySentry: true, docsParity: true, decisionFramework: false } }
      });
      assert.equal(rules.extensionRulesLines.length, 2);
    });

    it('should include PortHub guide when porthubRegistration is active', () => {
      const rules = engines._getRulesContent({
        rules: { core: { porthubRegistration: true } }
      });
      assert.ok(rules.porthubGuide !== null, 'Should include PortHub guide');
      assert.ok(rules.porthubGuide.includes('Port Management'));
    });

    it('should include global rules content', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.globalRules !== null, 'Should include global rules');
      assert.ok(typeof rules.globalRules === 'string');
      assert.ok(rules.globalRules.includes('Global Rules'));
    });
  });

  describe('rule injection parity', () => {
    const fullProjectConfig = {
      rules: {
        core: {
          changelogPerChange: true,
          jsdocAllFunctions: true,
          unitTestRequirements: true,
          sessionWrapProtocol: true,
          porthubRegistration: true
        },
        extensions: {
          identitySentry: true
        }
      }
    };
    const template = { id: 'prawduct', name: 'Prawduct', description: 'Test methodology' };

    it('all generators with supportsConfigFile should include core rules', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4, `Expected at least 4 config-supporting engines, got ${profiles.length}`);

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(content.includes('CHANGELOG') || content.includes('changelog'),
          `${profile.id}: missing CHANGELOG rule`);
        assert.ok(content.includes('PortHub') || content.includes('porthub') || content.includes('port'),
          `${profile.id}: missing PortHub reference`);
        assert.ok(content.includes('test') || content.includes('Test'),
          `${profile.id}: missing test rule`);
      }
    });

    it('all generators should include PortHub guide or reference when enabled', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        // Claude gets full guide, Codex gets it in instructions, Aider gets comment reference
        assert.ok(
          content.includes('Port Management') || content.includes('TangleClaw API'),
          `${profile.id}: missing PortHub guide or API reference`
        );
      }
    });

    it('all generators should include global rules', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(
          content.includes('Global Rules') || content.includes('global') || content.includes('Global'),
          `${profile.id}: missing global rules`
        );
      }
    });

    it('all generators should include methodology info when provided', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(content.includes('Prawduct'),
          `${profile.id}: missing methodology name`);
      }
    });
  });

  describe('_generateGeminiMd', () => {
    it('should include GEMINI.md header', () => {
      const content = engines._generateGeminiMd({}, null);
      assert.ok(content.includes('GEMINI.md'));
      assert.ok(content.includes('Generated by TangleClaw'));
    });

    it('should include all core rules by default', () => {
      const content = engines._generateGeminiMd({}, null);
      assert.ok(content.includes('CHANGELOG'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('tests'));
      assert.ok(content.includes('session wrap'));
      assert.ok(content.includes('PortHub'));
    });

    it('should include methodology info when provided', () => {
      const content = engines._generateGeminiMd({}, { name: 'TiLT', description: 'Identity-first' });
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
      const content = engines._generateGeminiMd(config, null);
      assert.ok(content.includes('Extension Rules'));
      assert.ok(content.includes('identity') || content.includes('sentry'));
      assert.ok(content.includes('docs'));
    });

    it('should include PortHub guide when porthubRegistration is active', () => {
      const config = {
        rules: { core: { porthubRegistration: true } }
      };
      const content = engines._generateGeminiMd(config, null);
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide header');
      assert.ok(content.includes('TangleClaw API'), 'Should include API base URL');
    });

    it('should exclude PortHub guide when porthubRegistration is disabled', () => {
      const config = {
        rules: { core: { porthubRegistration: false } }
      };
      const content = engines._generateGeminiMd(config, null);
      assert.ok(!content.includes('Port Management'));
    });

    it('should generate via public API with gemini engine id', () => {
      const content = engines.generateConfig('gemini', {
        rules: { core: {}, extensions: {} }
      });
      assert.ok(content !== null, 'generateConfig("gemini") must not return null');
      assert.ok(typeof content === 'string');
      assert.ok(content.includes('GEMINI.md'));
    });

    it('should include global rules', () => {
      const content = engines._generateGeminiMd({}, null);
      assert.ok(content.includes('Global Rules'), 'GEMINI.md should include global rules');
    });

    it('should have config filename with subdirectory path', () => {
      const profile = store.engines.get('gemini');
      assert.ok(profile, 'Gemini profile should exist');
      assert.ok(profile.configFormat.filename.includes('/'),
        'Gemini config filename should include a subdirectory path');
      assert.equal(profile.configFormat.filename, '.gemini/GEMINI.md');
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

    it('should include global rules', () => {
      const content = engines._generateClaudeMd({}, null);
      assert.ok(content.includes('Global Rules'), 'CLAUDE.md should include global rules');
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

    it('should include PortHub guide when porthubRegistration rule is active', () => {
      const config = {
        rules: {
          core: { porthubRegistration: true }
        }
      };
      const content = engines._generateClaudeMd(config, null);
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide header');
      assert.ok(content.includes('Never hardcode ports'), 'Should include guide rules');
      assert.ok(content.includes('Port Ranges Convention'), 'Should include port ranges');
    });

    it('should exclude PortHub guide when porthubRegistration rule is disabled', () => {
      const config = {
        rules: {
          core: { porthubRegistration: false }
        }
      };
      const content = engines._generateClaudeMd(config, null);
      assert.ok(!content.includes('Port Management'), 'Should not include PortHub guide');
      assert.ok(!content.includes('Never hardcode ports'), 'Should not include guide rules');
    });
  });

  describe('validateParity', () => {
    it('should return valid when all engines pass parity checks', () => {
      const result = engines.validateParity();
      assert.equal(result.valid, true, `Parity failed: ${JSON.stringify(result.engines.filter(e => !e.valid))}`);
      assert.ok(result.engines.length >= 4, `Expected at least 4 config-supporting engines, got ${result.engines.length}`);
    });

    it('should return per-engine results with id and valid flag', () => {
      const result = engines.validateParity();
      for (const engine of result.engines) {
        assert.ok(typeof engine.id === 'string');
        assert.ok(typeof engine.valid === 'boolean');
        assert.ok(Array.isArray(engine.errors));
      }
    });

    it('should include all config-supporting engines', () => {
      const result = engines.validateParity();
      const ids = result.engines.map(e => e.id);
      assert.ok(ids.includes('claude'), 'Missing claude');
      assert.ok(ids.includes('codex'), 'Missing codex');
      assert.ok(ids.includes('aider'), 'Missing aider');
      assert.ok(ids.includes('gemini'), 'Missing gemini');
    });

    it('should report no errors for any engine', () => {
      const result = engines.validateParity();
      for (const engine of result.engines) {
        assert.deepEqual(engine.errors, [], `${engine.id} has parity errors: ${engine.errors.join(', ')}`);
      }
    });
  });

  describe('cross-feature integration', () => {
    it('Gemini config contains all required sections', () => {
      const projectConfig = {
        rules: {
          core: {
            changelogPerChange: true,
            jsdocAllFunctions: true,
            unitTestRequirements: true,
            sessionWrapProtocol: true,
            porthubRegistration: true
          },
          extensions: { docsParity: true, independentCritic: true }
        }
      };
      const template = { id: 'prawduct', name: 'Prawduct', description: 'Structured governance' };

      const content = engines.generateConfig('gemini', projectConfig, template);
      assert.ok(content !== null, 'Gemini config should not be null');
      assert.ok(content.includes('GEMINI.md'), 'Should have GEMINI.md header');
      assert.ok(content.includes('Core Rules'), 'Should have core rules section');
      assert.ok(content.includes('Extension Rules'), 'Should have extension rules section');
      assert.ok(content.includes('docs'), 'Should include docsParity extension');
      assert.ok(content.includes('Critic') || content.includes('critic'), 'Should include independentCritic extension');
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide');
      assert.ok(content.includes('TangleClaw API'), 'Should include API base URL');
      assert.ok(content.includes('Prawduct'), 'Should include methodology name');
      assert.ok(content.includes('Structured governance'), 'Should include methodology description');
      assert.ok(content.includes('Global Rules'), 'Should include global rules');
    });

    it('global rules changes are reflected in regenerated config', () => {
      // Save current global rules
      const original = store.globalRules.load();

      try {
        // Write custom global rules
        store.globalRules.save('## Global Rules\n\n- Custom integration test rule alpha\n- Custom rule beta\n');

        // Generate config — should include the new rules
        const content = engines.generateConfig('claude', { rules: { core: {} } });
        assert.ok(content.includes('Custom integration test rule alpha'),
          'Regenerated config should include updated global rules');
        assert.ok(content.includes('Custom rule beta'),
          'Regenerated config should include all updated global rules');

        // Also verify Gemini picks them up
        const geminiContent = engines.generateConfig('gemini', { rules: { core: {} } });
        assert.ok(geminiContent.includes('Custom integration test rule alpha'),
          'Gemini config should also reflect updated global rules');
      } finally {
        // Restore original global rules
        store.globalRules.save(original);
      }
    });

    it('port scanner conflict detection works with checkPort', () => {
      // Run a scan to populate cache
      portScanner.scan();

      // A port that's unlikely to be in use should be available
      const freeResult = porthub.checkPort(59999);
      assert.equal(freeResult.systemDetected, false, 'Port 59999 should not be system-detected');

      // If any ports were detected by the scanner, verify checkPort reflects it
      const systemPorts = portScanner.getSystemPorts();
      if (systemPorts.length > 0) {
        // Find a system port that is NOT in our lease DB
        const unleased = systemPorts.find(sp => {
          const leaseCheck = store.portLeases.checkConflict(sp.port);
          return !leaseCheck;
        });
        if (unleased) {
          const result = porthub.checkPort(unleased.port);
          assert.equal(result.available, false, `Port ${unleased.port} should be unavailable (in use by ${unleased.command})`);
          assert.equal(result.systemDetected, true, `Port ${unleased.port} should be flagged as system-detected`);
          assert.ok(result.process, 'Should include process name');
        }
      }
    });

    it('all engines produce parity-equivalent output for same input', () => {
      const projectConfig = {
        rules: {
          core: {
            changelogPerChange: true,
            porthubRegistration: true
          },
          extensions: { identitySentry: true }
        }
      };
      const template = { id: 'test', name: 'TestMethod', description: 'Test desc' };

      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      const configs = {};
      for (const profile of profiles) {
        configs[profile.id] = engines.generateConfig(profile.id, projectConfig, template);
        assert.ok(configs[profile.id] !== null, `${profile.id} returned null`);
      }

      // All configs should mention CHANGELOG, PortHub, TestMethod, and identity/sentry
      for (const [id, content] of Object.entries(configs)) {
        assert.ok(content.includes('CHANGELOG') || content.includes('changelog'), `${id}: missing CHANGELOG`);
        assert.ok(content.includes('PortHub') || content.includes('Port Management') || content.includes('TangleClaw API'), `${id}: missing PortHub`);
        assert.ok(content.includes('TestMethod'), `${id}: missing methodology name`);
        assert.ok(content.includes('identity') || content.includes('sentry') || content.includes('Identity'), `${id}: missing identitySentry`);
      }
    });
  });

  describe('syncEngineHooks', () => {
    let projectDir;

    before(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-hooks-test-'));
    });

    after(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    /**
     * Helper to read .claude/settings.json from the test project dir.
     * @returns {object}
     */
    function readSettings() {
      return JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    }

    it('should create .claude/settings.json with hooks when methodology has hooks', () => {
      const template = {
        id: 'test-meth',
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              hooks: [{ type: 'command', command: 'python3 "{{TANGLECLAW_DIR}}/tools/product-hook" clear' }]
            }],
            Stop: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'python3 "{{TANGLECLAW_DIR}}/tools/product-hook" stop' }]
            }]
          }
        }
      };

      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      assert.ok(settings.hooks, 'hooks key should exist');
      assert.ok(settings.hooks.SessionStart, 'SessionStart hooks should exist');
      assert.ok(settings.hooks.Stop, 'Stop hooks should exist');
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.Stop.length, 1);
    });

    it('should resolve {{TANGLECLAW_DIR}} placeholder', () => {
      const template = {
        id: 'test-meth',
        hooks: {
          claude: {
            Stop: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'python3 "{{TANGLECLAW_DIR}}/tools/product-hook" stop' }]
            }]
          }
        }
      };

      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      const cmd = settings.hooks.Stop[0].hooks[0].command;
      assert.ok(!cmd.includes('{{TANGLECLAW_DIR}}'), 'placeholder should be resolved');
      assert.ok(cmd.includes('/tools/product-hook'), 'resolved path should contain tools/product-hook');
    });

    it('should preserve existing non-hook settings', () => {
      // Pre-populate with permissions and companyAnnouncements
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        permissions: { allow: ['Bash(git status:*)'] },
        companyAnnouncements: ['Test announcement'],
        hooks: { Old: [{ matcher: '', hooks: [] }] }
      }, null, 2));

      const template = {
        id: 'test-meth',
        hooks: {
          claude: {
            SessionStart: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'echo test' }]
            }]
          }
        }
      };

      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      assert.deepStrictEqual(settings.permissions, { allow: ['Bash(git status:*)'] });
      assert.deepStrictEqual(settings.companyAnnouncements, ['Test announcement']);
      // Old hooks should be replaced, not merged
      assert.ok(!settings.hooks.Old, 'old hooks should be replaced');
      assert.ok(settings.hooks.SessionStart, 'new hooks should be present');
    });

    it('should remove hooks when methodology has no hooks', () => {
      // Pre-populate with hooks
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        permissions: { allow: [] },
        hooks: { Stop: [{ matcher: '', hooks: [] }] }
      }, null, 2));

      const template = { id: 'minimal', hooks: {} };
      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      assert.ok(!settings.hooks, 'hooks key should be removed');
      assert.ok(settings.permissions, 'permissions should be preserved');
    });

    it('should handle null template gracefully', () => {
      // Pre-populate
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        permissions: { allow: [] },
        hooks: { Stop: [{ matcher: '', hooks: [] }] }
      }, null, 2));

      engines.syncEngineHooks(projectDir, null);

      const settings = readSettings();
      assert.ok(!settings.hooks, 'hooks should be removed for null template');
      assert.ok(settings.permissions, 'permissions preserved');
    });

    it('should create .claude directory if missing', () => {
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-hooks-fresh-'));
      try {
        const template = {
          id: 'test-meth',
          hooks: {
            claude: {
              Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] }]
            }
          }
        };

        engines.syncEngineHooks(freshDir, template);

        assert.ok(fs.existsSync(path.join(freshDir, '.claude', 'settings.json')));
        const settings = JSON.parse(fs.readFileSync(path.join(freshDir, '.claude', 'settings.json'), 'utf8'));
        assert.ok(settings.hooks.Stop);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });
});
