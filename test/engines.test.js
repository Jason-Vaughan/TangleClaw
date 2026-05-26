'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
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
  let tempRulesPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-engines-test-'));
    store._setBasePath(tempDir);
    store.init();
    // #240 — redirect canonical global-rules to tmp and seed so the
    // engine config generators have realistic rules content to inject.
    tempRulesPath = path.join(tempDir, 'global-rules.md');
    fs.writeFileSync(tempRulesPath, '# Global Rules\n\nThese rules apply to all projects managed by TangleClaw.\n\n- Test seed for engine config generation\n');
    store.globalRules._setBundledGlobalRulesPath(tempRulesPath);
  });

  after(() => {
    store.globalRules._resetBundledGlobalRulesPath();
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

    it('should include launchModes for engines that define them', () => {
      const list = engines.listWithAvailability();
      const claude = list.find(e => e.id === 'claude');
      assert.ok(claude, 'Claude should be in the list');
      assert.ok(claude.launchModes, 'Claude should have launchModes');
      assert.ok(claude.launchModes.auto, 'Claude should have auto mode');
      assert.ok(Array.isArray(claude.launchModes.auto.args), 'Auto mode should have args array');
      assert.equal(claude.defaultLaunchMode, 'default');
    });

    // #209 — YOLO mode parity across engines. Each non-Claude engine that supports
    // an unattended/skip-permissions equivalent gets a `launchModes` block so the
    // session-launch modal renders and the flag flows through `_buildLaunchCommand`.
    // These tests pin (a) the YOLO key exists, (b) the flag args match the upstream
    // CLI's documented flag — a future flag rename in any of these CLIs will fail
    // here loudly rather than silently routing users into the wrong mode.
    describe('launchModes parity across engines (#209)', () => {
      it('gemini exposes yolo via --yolo', () => {
        const gemini = engines.listWithAvailability().find(e => e.id === 'gemini');
        assert.ok(gemini.launchModes, 'gemini should have launchModes');
        assert.equal(gemini.defaultLaunchMode, 'default');
        assert.deepEqual(gemini.launchModes.yolo.args, ['--yolo']);
        assert.ok(gemini.launchModes.yolo.warning, 'YOLO mode must carry a warning');
        // Approval-mode parity with Claude (default / auto-equivalent / plan / yolo)
        assert.deepEqual(gemini.launchModes.autoEdit.args, ['--approval-mode', 'auto_edit']);
        assert.deepEqual(gemini.launchModes.plan.args, ['--approval-mode', 'plan']);
        assert.deepEqual(gemini.launchModes.default.args, []);
      });

      it('aider exposes yolo via --yes-always', () => {
        const aider = engines.listWithAvailability().find(e => e.id === 'aider');
        assert.ok(aider.launchModes, 'aider should have launchModes');
        assert.equal(aider.defaultLaunchMode, 'default');
        assert.deepEqual(aider.launchModes.yesAlways.args, ['--yes-always']);
        assert.ok(aider.launchModes.yesAlways.warning, 'YOLO mode must carry a warning');
        assert.deepEqual(aider.launchModes.default.args, []);
      });

      it('codex exposes fullAuto via --full-auto (sandboxed, not true YOLO)', () => {
        const codex = engines.listWithAvailability().find(e => e.id === 'codex');
        assert.ok(codex.launchModes, 'codex should have launchModes');
        assert.equal(codex.defaultLaunchMode, 'default');
        assert.deepEqual(codex.launchModes.fullAuto.args, ['--full-auto']);
        assert.ok(codex.launchModes.fullAuto.warning, 'fullAuto must carry a warning even though sandboxed');
        // Label calls out the distinction from Claude/Gemini YOLO — codex is sandboxed.
        assert.equal(codex.launchModes.fullAuto.label, 'Full Auto');
      });

      it('every engine with launchModes has a default key that matches defaultLaunchMode', () => {
        const list = engines.listWithAvailability();
        const withModes = list.filter(e => e.launchModes);
        assert.ok(withModes.length >= 4, `expected ≥4 engines with launchModes, got ${withModes.length}`);
        for (const engine of withModes) {
          assert.ok(
            engine.launchModes[engine.defaultLaunchMode],
            `engine "${engine.id}" defaultLaunchMode="${engine.defaultLaunchMode}" must exist in launchModes`
          );
        }
      });

      it('every engine with launchModes has >1 mode so the modal renders', () => {
        // public/landing.js:470 renders the modal only when Object.keys(launchModes).length > 1.
        // A single-entry launchModes block would silently skip the picker.
        const list = engines.listWithAvailability();
        for (const engine of list.filter(e => e.launchModes)) {
          assert.ok(
            Object.keys(engine.launchModes).length > 1,
            `engine "${engine.id}" must have >1 launchMode or the picker won't render`
          );
        }
      });

      it('openclaw launchModes mirror ClawBridge permissionMode values (#210 Phase 1)', () => {
        // Phase 1 of #210 (2026-05-26): ship the engine-profile scaffold +
        // sentinel update, with every openclaw mode marked `disabled: true`
        // so the picker gate at public/landing.js doesn't fire until Phase
        // 2 wires the propagation through the SSH tunnel to ClawBridge.
        // The sentinel that previously asserted "openclaw has no
        // launchModes" was retired here once ClawBridge v1.6.0 shipped the
        // permissionMode field on POST /v2/session/start (PR ClawBridge#3).
        //
        // Phase 2 will (a) add the lib/clawbridge.js HTTP helper for
        // POST /v2/session/start through the existing tunnel, (b) wire it
        // into lib/sessions.js#launchWebuiSession when launchMode is set,
        // (c) flip every mode's `disabled: false` here, and (d) this test
        // gets updated to assert disabled === false.
        const openclaw = engines.listWithAvailability().find(e => e.id === 'openclaw');
        assert.ok(openclaw, 'openclaw engine should exist');
        assert.ok(openclaw.launchModes, 'openclaw must declare launchModes once #210 Phase 1 lands');
        const BRIDGE_ACCEPTS = new Set(['default', 'acceptEdits', 'bypassPermissions', 'auto', 'plan', 'dontAsk']);
        for (const [key, mode] of Object.entries(openclaw.launchModes)) {
          assert.ok(BRIDGE_ACCEPTS.has(key),
            `openclaw mode key "${key}" must be one of ClawBridge's accepted permissionMode values: ${[...BRIDGE_ACCEPTS].join(', ')}`);
          assert.equal(typeof mode.bridgePermissionMode, 'string',
            `openclaw mode "${key}" must declare a string bridgePermissionMode for the future tunnel-direct POST to read`);
          assert.ok(BRIDGE_ACCEPTS.has(mode.bridgePermissionMode),
            `openclaw mode "${key}".bridgePermissionMode "${mode.bridgePermissionMode}" must be one of ClawBridge's accepted enum`);
          // Phase 1 contract: every openclaw mode is shipped disabled.
          // When this fails, Phase 2 has either landed (intentional) or
          // someone forgot to flip the flag (regression). Update the
          // assertion to `=== false` when Phase 2 lands.
          assert.equal(mode.disabled, true,
            `openclaw mode "${key}" must declare disabled: true while Phase 1 ships without propagation`);
        }
      });
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

    it('should include playbook content in codex instructions when methodology has a playbook', () => {
      const content = engines._generateCodexYaml(
        {},
        { id: 'prawduct', name: 'Prawduct', description: 'Structured governance' }
      );
      assert.ok(content.includes('Session Playbook'), 'should include playbook header in instructions');
      assert.ok(content.includes('One chunk per session'), 'should include session discipline');
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

    it('should include shared docs guide', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.sharedDocsGuide !== null, 'Should include shared docs guide');
      assert.ok(typeof rules.sharedDocsGuide === 'string');
      assert.ok(rules.sharedDocsGuide.includes('Shared Documents'));
    });

    it('should include session memory guide', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.sessionMemoryGuide !== null, 'Should include session memory guide');
      assert.ok(typeof rules.sessionMemoryGuide === 'string');
      assert.ok(rules.sessionMemoryGuide.includes('Session Memory'));
    });

    it('does not load a project version recording guide (#101 — TC owns the writer)', () => {
      const rules = engines._getRulesContent({});
      assert.equal(rules.projectVersionGuide, undefined, 'projectVersionGuide field is no longer surfaced');
    });
  });

  describe('project version recording NOT injected (#101)', () => {
    const projectConfig = {
      rules: {
        core: {
          changelogPerChange: true,
          jsdocAllFunctions: true,
          unitTestRequirements: true,
          sessionWrapProtocol: true,
          porthubRegistration: true
        }
      }
    };
    const template = { id: 'prawduct', name: 'Prawduct', description: 'Test methodology' };

    it('no generator with supportsConfigFile includes a Project Version Recording section anymore', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4, `Expected at least 4 config-supporting engines, got ${profiles.length}`);

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, projectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.equal(
          content.includes('Project Version Recording'),
          false,
          `${profile.id}: should not contain Project Version Recording section (TC writes the cache file directly)`
        );
        assert.equal(
          content.includes('project-version.txt'),
          false,
          `${profile.id}: should not reference the cache file path`
        );
      }
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

    it('all generators should include playbook when methodology has one', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(content.includes('Session Playbook'),
          `${profile.id}: missing playbook content`);
      }
    });

    it('all generators should include shared docs guide', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(
          content.includes('Shared Documents') || content.includes('Shared Docs Guide'),
          `${profile.id}: missing shared docs guide`
        );
      }
    });

    it('all generators should include session memory guide', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig, template);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(
          content.includes('Session Memory') || content.includes('session memory'),
          `${profile.id}: missing session memory guide`
        );
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

    it('should include playbook content when methodology has a playbook', () => {
      const content = engines._generateGeminiMd({}, { id: 'prawduct', name: 'Prawduct', description: 'Structured governance' });
      assert.ok(content.includes('Session Playbook'), 'should include playbook header');
      assert.ok(content.includes('One chunk per session'), 'should include session discipline');
    });

    it('should omit playbook when methodology has no playbook', () => {
      const content = engines._generateGeminiMd({}, { id: 'minimal', name: 'Minimal', description: 'Basic' });
      assert.ok(!content.includes('Session Playbook'), 'should not include playbook content');
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

    it('should include playbook content when methodology has a playbook', () => {
      const content = engines._generateClaudeMd({}, { id: 'prawduct', name: 'Prawduct', description: 'Structured governance' });
      assert.ok(content.includes('Session Playbook'), 'should include playbook header');
      assert.ok(content.includes('One chunk per session'), 'should include session discipline');
      assert.ok(content.includes('Independent Critic'), 'should include Critic protocol');
    });

    it('should omit playbook when methodology has no playbook', () => {
      const content = engines._generateClaudeMd({}, { id: 'minimal', name: 'Minimal', description: 'Basic' });
      assert.ok(!content.includes('Session Playbook'), 'should not include playbook content');
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

  describe('writeEngineConfig (#240 drift detection)', () => {
    // Captures log.warn calls via the logger module's internal sink so
    // we can assert drift warnings fire without sprinkling spies.
    let writeDir;
    let claudeProfile;
    let prawduct;
    const minimalProjConfig = {
      rules: { core: { changelogPerChange: true, jsdocAllFunctions: true, unitTestRequirements: true, sessionWrapProtocol: true, porthubRegistration: true }, extensions: {} },
      methodologyArchives: []
    };

    before(() => {
      writeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-write-engine-config-'));
      claudeProfile = store.engines.get('claude');
      prawduct = store.templates.get('prawduct');
      assert.ok(claudeProfile && claudeProfile.configFormat, 'claude profile must have configFormat for these tests');
    });

    after(() => {
      fs.rmSync(writeDir, { recursive: true, force: true });
    });

    it('writes the file when it does not exist (no drift)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'fresh-'));
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      assert.equal(result.written, true);
      assert.equal(result.drifted, false, 'no drift when target file did not exist');
      assert.equal(result.error, null);
      assert.ok(fs.existsSync(result.configFilePath), 'file written at the helper-reported path');
      assert.ok(fs.readFileSync(result.configFilePath, 'utf8').includes('Generated by TangleClaw'));
    });

    it('writes the file when it exists and matches (no drift, idempotent)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'match-'));
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      assert.equal(first.drifted, false);
      const second = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      assert.equal(second.written, true);
      assert.equal(second.drifted, false, 'unchanged content must not register as drift');
    });

    it('detects drift when the existing on-disk file differs (the #240 surface)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'drift-'));
      // Seed the target file with content that would never match the
      // regenerated output — a hand-edit a contributor might have committed.
      const configFilePath = path.join(projectPath, claudeProfile.configFormat.filename);
      fs.writeFileSync(configFilePath, '# CLAUDE.md\n\n## Manually Added Rule\n\n- This was hand-edited\n');
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      assert.equal(result.written, true, 'still writes the regenerated content (warn is informational, not blocking)');
      assert.equal(result.drifted, true, 'drift must be reported');
      assert.equal(result.error, null);
      // Overwrite happened — the hand-edited content is gone (this IS
      // the silent-clobber failure mode; the warning is what's new).
      const after = fs.readFileSync(configFilePath, 'utf8');
      assert.ok(!after.includes('Manually Added Rule'), 'hand-edit was overwritten as expected');
      assert.ok(after.includes('Generated by TangleClaw'), 'replacement content is the regenerated CLAUDE.md');
    });

    it('treats trailing-whitespace-only differences as non-drift (tolerant comparator)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'whitespace-'));
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      // Append/prepend extra newlines to the existing file — semantically
      // identical, should not trigger a drift warning on next write.
      const configFilePath = first.configFilePath;
      const existing = fs.readFileSync(configFilePath, 'utf8');
      fs.writeFileSync(configFilePath, '\n\n' + existing + '\n\n\n');
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      assert.equal(result.drifted, false, 'pure whitespace differences must not register as drift');
    });

    it('returns skipped (not error) when engineProfile has no configFormat — openclaw / genesis path', () => {
      // Pre-Critic this returned an error string for what is intentional
      // behavior (engines without config files: openclaw, genesis). The
      // 4 call sites would surface that as "Failed to write engine
      // config" on every createProject / launchSession for such engines.
      // The helper now returns `{skipped: true, skipReason, error: null}`
      // and callers gate on `!skipped` before pushing errors.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'noformat-'));
      const fakeProfile = { id: 'phantom' };
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, fakeProfile, prawduct);
      assert.equal(result.written, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, null, 'skipped must NOT surface as an error');
      assert.match(result.skipReason, /configFormat/i);
    });

    it("returns skipped when configFormat exists but filename is null (real openclaw / genesis shape)", () => {
      // Pin: openclaw's actual shape is `configFormat: {filename: null, ...}`
      // — truthy as an object, but no usable filename. Earlier guard
      // `if (engineProfile.configFormat)` would pass and the helper
      // would emit an error. Fixed by checking `configFormat.filename`
      // directly.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'nullfilename-'));
      const openclawShape = { id: 'fake-openclaw', configFormat: { filename: null, syntax: null, generator: null } };
      const result = engines.writeEngineConfig('fake-openclaw', projectPath, minimalProjConfig, openclawShape, prawduct);
      assert.equal(result.written, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, null);
    });

    it('returns skipped when generateConfig produces empty content (no error)', () => {
      // For engines with `supportsConfigFile: false` the generator
      // returns null/empty even though configFormat may exist. Helper
      // must treat this as a deliberate skip, not an error.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'emptygen-'));
      // Synthesize an engineId that has no registered generator —
      // generateConfig returns null. Profile-shape is borrowed from
      // claude so the configFormat.filename check passes first.
      const fakeProfile = { id: 'no-such-engine', configFormat: claudeProfile.configFormat };
      const result = engines.writeEngineConfig('no-such-engine', projectPath, minimalProjConfig, fakeProfile, prawduct);
      assert.equal(result.written, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, null);
      assert.match(result.skipReason, /generateConfig|empty/i);
    });

    it('CRLF line endings in the on-disk file do NOT register as drift (#240 Critic n1)', () => {
      // Windows editors save with CRLF; the regenerator emits LF.
      // Without normalization, every session launch on a Windows-saved
      // file would emit a drift warning that doesn't represent a real
      // semantic change.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'crlf-'));
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      const configFilePath = first.configFilePath;
      // Convert the file's line endings to CRLF in-place, semantically
      // identical content.
      const lf = fs.readFileSync(configFilePath, 'utf8');
      fs.writeFileSync(configFilePath, lf.replace(/\n/g, '\r\n'));
      const second = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile, prawduct);
      assert.equal(second.drifted, false, 'CRLF-vs-LF must not register as drift');
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

  describe('validateStatusParity', () => {
    it('should return valid when all engines have statusPage field', () => {
      const result = engines.validateStatusParity();
      assert.equal(result.valid, true, `Status parity failed: ${JSON.stringify(result.engines.filter(e => !e.valid))}`);
    });

    it('should include all engines (not just config-supporting)', () => {
      const result = engines.validateStatusParity();
      const ids = result.engines.map(e => e.id);
      assert.ok(ids.includes('claude'), 'Missing claude');
      assert.ok(ids.includes('codex'), 'Missing codex');
      assert.ok(ids.includes('gemini'), 'Missing gemini');
      assert.ok(ids.includes('aider'), 'Missing aider');
      assert.ok(ids.includes('genesis'), 'Missing genesis');
    });

    it('known providers should have adapter and url', () => {
      const result = engines.validateStatusParity();
      const knownProviders = ['claude', 'codex', 'gemini'];
      for (const id of knownProviders) {
        const engine = result.engines.find(e => e.id === id);
        assert.ok(engine, `${id} not found in parity results`);
        assert.equal(engine.valid, true, `${id} status parity failed: ${engine.errors.join(', ')}`);
      }
    });

    it('engines without status pages should have null statusPage', () => {
      const result = engines.validateStatusParity();
      const noStatus = ['aider', 'genesis'];
      for (const id of noStatus) {
        const engine = result.engines.find(e => e.id === id);
        assert.ok(engine, `${id} not found`);
        assert.equal(engine.valid, true, `${id} should be valid with null statusPage`);
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

  describe('shared docs injection', () => {
    let groupId;
    let projectId;
    let sharedDocFile;

    before(() => {
      // Create a temp file for inline injection
      sharedDocFile = path.join(tempDir, 'shared-api-spec.md');
      fs.writeFileSync(sharedDocFile, '# API Spec\n\nGET /api/health → 200\nPOST /api/data → 201\n');

      // Create a project
      const projPath = path.join(tempDir, 'test-shared-proj');
      fs.mkdirSync(projPath, { recursive: true });
      const project = store.projects.create({
        name: 'test-shared-proj',
        path: projPath,
        engineId: 'claude',
        methodology: 'prawduct'
      });
      projectId = project.id;

      // Create a group and add the project
      const group = store.projectGroups.create({ name: 'SharedDocsTestGroup' });
      groupId = group.id;
      store.projectGroups.addMember(groupId, projectId);
    });

    it('should include reference mode shared docs in generated config', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'API Reference',
        filePath: '/docs/api-ref.md',
        injectIntoConfig: true,
        injectMode: 'reference',
        description: 'REST API reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('Shared Documents'), 'Should include Shared Documents section');
      assert.ok(content.includes('API Reference'), 'Should include doc name');
      assert.ok(content.includes('/docs/api-ref.md'), 'Should include file path');
      assert.ok(content.includes('REST API reference'), 'Should include description');

      // Clean up
      store.sharedDocs.delete(doc.id);
    });

    it('should include inline mode shared docs with file content', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Inline API Spec',
        filePath: sharedDocFile,
        injectIntoConfig: true,
        injectMode: 'inline',
        description: 'Full API specification'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('Inline API Spec'), 'Should include doc name');
      assert.ok(content.includes('GET /api/health'), 'Should include inlined file content');
      assert.ok(content.includes('POST /api/data'), 'Should include all file content');

      store.sharedDocs.delete(doc.id);
    });

    it('should warn about missing files in reference mode', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Missing Doc',
        filePath: '/nonexistent/path/doc.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('file not found'), 'Should warn about missing file');

      store.sharedDocs.delete(doc.id);
    });

    it('should warn about missing files in inline mode', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Missing Inline',
        filePath: '/nonexistent/inline.md',
        injectIntoConfig: true,
        injectMode: 'inline'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('File not found'), 'Should warn about missing inline file');

      store.sharedDocs.delete(doc.id);
    });

    it('should include lock warnings for locked documents', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Locked Doc',
        filePath: '/docs/locked.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      // Acquire a lock
      store.documentLocks.acquire(doc.id, 999, 'other-project');

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('LOCKED'), 'Should show lock warning');
      assert.ok(content.includes('other-project'), 'Should show who locked it');

      // Clean up
      store.documentLocks.release(doc.id);
      store.sharedDocs.delete(doc.id);
    });

    it('should not include docs when inject_into_config is false', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Non-Injectable',
        filePath: '/docs/private.md',
        injectIntoConfig: false,
        injectMode: 'reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(!content.includes('Non-Injectable'), 'Should not include non-injectable docs');

      store.sharedDocs.delete(doc.id);
    });

    it('should inject shared docs into all 4 engine generators', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Parity Doc',
        filePath: '/docs/parity.md',
        injectIntoConfig: true,
        injectMode: 'reference',
        description: 'Parity test doc'
      });

      const projectConfig = { id: projectId, rules: { core: {} } };

      const claude = engines._generateClaudeMd(projectConfig, null);
      assert.ok(claude.includes('Parity Doc'), 'Claude should include shared doc');

      const gemini = engines._generateGeminiMd(projectConfig, null);
      assert.ok(gemini.includes('Parity Doc'), 'Gemini should include shared doc');

      const codex = engines._generateCodexYaml(projectConfig, null);
      assert.ok(codex.includes('Parity Doc'), 'Codex should include shared doc');

      const aider = engines._generateAiderConf(projectConfig, null);
      assert.ok(aider.includes('Parity Doc'), 'Aider should include shared doc');

      store.sharedDocs.delete(doc.id);
    });

    it('should deduplicate shared docs across multiple groups', () => {
      // Create second group with same project
      const group2 = store.projectGroups.create({ name: 'SecondGroup' });
      store.projectGroups.addMember(group2.id, projectId);

      // Add same file path to both groups
      const doc1 = store.sharedDocs.create({
        groupId,
        name: 'Shared File',
        filePath: '/docs/shared.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });
      const doc2 = store.sharedDocs.create({
        groupId: group2.id,
        name: 'Shared File Copy',
        filePath: '/docs/shared.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      // Should only appear once (deduplicated by file path)
      const occurrences = content.split('/docs/shared.md').length - 1;
      assert.equal(occurrences, 1, 'Should deduplicate shared docs by file path');

      // Clean up
      store.sharedDocs.delete(doc1.id);
      store.sharedDocs.delete(doc2.id);
      store.projectGroups.delete(group2.id);
    });
  });

  describe('syncEngineHooks', () => {
    let projectDir;

    // Critic M2: switched from before/after to beforeEach/afterEach so each
    // test gets a fresh project dir. With baseline-hooks merging now in play
    // (#103), shared dir state between tests would let a future contributor
    // accidentally pollute the null-template assertion via a leftover
    // .tangleclaw/project.json with silentPrime: true.
    //
    // Post-#129: silentPrime defaults to true, so these methodology-hook
    // tests would now pick up the silentPrime baseline SessionStart entry
    // from the new default. Write an explicit projConfig with silentPrime:
    // false to keep the tests focused on methodology-hook behavior only.
    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-hooks-test-'));
      const tcDir = path.join(projectDir, '.tangleclaw');
      fs.mkdirSync(tcDir, { recursive: true });
      fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: false
      }));
    });

    afterEach(() => {
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
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
            }],
            Stop: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
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
              hooks: [{ type: 'command', command: 'python3 "{{TANGLECLAW_DIR}}/tools/some-hook" stop' }]
            }]
          }
        }
      };

      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      const cmd = settings.hooks.Stop[0].hooks[0].command;
      assert.ok(!cmd.includes('{{TANGLECLAW_DIR}}'), 'placeholder should be resolved');
      assert.ok(cmd.includes('/tools/some-hook'), 'resolved path should contain tools/some-hook');
    });

    it('should pass through $CLAUDE_PROJECT_DIR without modification', () => {
      const template = {
        id: 'test-meth',
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
            }]
          }
        }
      };

      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      assert.ok(cmd.includes('$CLAUDE_PROJECT_DIR'), 'should preserve $CLAUDE_PROJECT_DIR env var');
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

  describe('_filterHookEntriesByRequires (#145)', () => {
    let projectDir;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-requires-test-'));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    function makeEntry(extra = {}) {
      return {
        matcher: 'startup',
        hooks: [{ type: 'command', command: 'noop' }],
        ...extra
      };
    }

    it('keeps entries whose `requires` paths all exist', () => {
      fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'tools', 'product-hook'), '#!/bin/sh\n');
      const hooks = { SessionStart: [makeEntry({ requires: ['tools/product-hook'] })] };

      const filtered = engines._filterHookEntriesByRequires(hooks, projectDir);

      assert.equal(filtered.SessionStart.length, 1, 'entry with satisfied requires should be kept');
      assert.ok(!('requires' in filtered.SessionStart[0]), 'requires field should be stripped from output');
    });

    it('skips entries whose single `requires` path is missing', () => {
      const hooks = { Stop: [makeEntry({ requires: ['tools/product-hook'] })] };

      const filtered = engines._filterHookEntriesByRequires(hooks, projectDir);

      assert.deepStrictEqual(filtered, {}, 'event key with no kept entries should be omitted');
    });

    it('skips entries when one of multiple `requires` paths is missing', () => {
      fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'tools', 'present'), '');
      const hooks = { Stop: [makeEntry({ requires: ['tools/present', 'tools/missing'] })] };

      const filtered = engines._filterHookEntriesByRequires(hooks, projectDir);

      assert.deepStrictEqual(filtered, {}, 'AND-semantics: any missing path skips the entry');
    });

    it('keeps entries without a `requires` field (backwards-compatible)', () => {
      const hooks = { SessionStart: [makeEntry()] };

      const filtered = engines._filterHookEntriesByRequires(hooks, projectDir);

      assert.equal(filtered.SessionStart.length, 1, 'no-requires entry must inject unconditionally');
    });

    it('keeps entries with empty `requires` array (degenerate, no preconditions)', () => {
      const hooks = { SessionStart: [makeEntry({ requires: [] })] };

      const filtered = engines._filterHookEntriesByRequires(hooks, projectDir);

      assert.equal(filtered.SessionStart.length, 1, 'empty requires array means no preconditions');
      assert.ok(!('requires' in filtered.SessionStart[0]), 'requires field should still be stripped');
    });

    it('coerces non-empty string `requires` to a single-element array (Critic S1)', () => {
      // Forgiving handling for the common single-precondition case where a
      // template author writes `requires: "tools/x"` instead of an array.
      fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'tools', 'product-hook'), '');
      const hooks = { Stop: [makeEntry({ requires: 'tools/product-hook' })] };

      const filtered = engines._filterHookEntriesByRequires(hooks, projectDir);

      assert.equal(filtered.Stop.length, 1, 'string requires should be honored as single precondition');
    });

    it('skips entries whose `requires` contains an empty string or non-string entry (fail-closed)', () => {
      fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'tools', 'present'), '');
      const hooksEmpty = { Stop: [makeEntry({ requires: ['', 'tools/present'] })] };
      const hooksNonString = { Stop: [makeEntry({ requires: [123, 'tools/present'] })] };

      assert.deepStrictEqual(
        engines._filterHookEntriesByRequires(hooksEmpty, projectDir),
        {},
        'empty-string entry must be treated as missing'
      );
      assert.deepStrictEqual(
        engines._filterHookEntriesByRequires(hooksNonString, projectDir),
        {},
        'non-string entry must be treated as missing'
      );
    });

    it('rejects path traversal and absolute paths in `requires` (Critic S2)', () => {
      // Even if these paths resolve to a real file outside the project,
      // `requires` is documented project-relative; anything else fails closed.
      const traversal = { Stop: [makeEntry({ requires: ['../etc/hosts'] })] };
      const absolute = { Stop: [makeEntry({ requires: ['/etc/hosts'] })] };
      const nestedTraversal = { Stop: [makeEntry({ requires: ['tools/../../etc/hosts'] })] };

      assert.deepStrictEqual(engines._filterHookEntriesByRequires(traversal, projectDir), {}, '../ rejected');
      assert.deepStrictEqual(engines._filterHookEntriesByRequires(absolute, projectDir), {}, 'absolute path rejected');
      assert.deepStrictEqual(engines._filterHookEntriesByRequires(nestedTraversal, projectDir), {}, 'nested .. segment rejected');
    });

    it('mixes kept and skipped entries within the same event', () => {
      fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'tools', 'present'), '');
      const hooks = {
        SessionStart: [
          makeEntry({ matcher: 'a', requires: ['tools/present'] }),
          makeEntry({ matcher: 'b', requires: ['tools/missing'] }),
          makeEntry({ matcher: 'c' })
        ]
      };

      const filtered = engines._filterHookEntriesByRequires(hooks, projectDir);

      assert.equal(filtered.SessionStart.length, 2, 'kept = present-requires + no-requires');
      assert.deepStrictEqual(
        filtered.SessionStart.map((e) => e.matcher),
        ['a', 'c'],
        'order preserved among kept entries'
      );
    });
  });

  describe('syncEngineHooks + requires precondition (#145)', () => {
    let projectDir;

    // Same pattern as the syncEngineHooks suite above — explicit silentPrime:false
    // projConfig so the tests can focus on the requires-filter behavior without
    // the post-#129 silentPrime baseline injecting a SessionStart entry.
    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-sync-requires-'));
      const tcDir = path.join(projectDir, '.tangleclaw');
      fs.mkdirSync(tcDir, { recursive: true });
      fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: false
      }));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it('strips orphan hook entries from .claude/settings.json (self-heal for existing affected projects)', () => {
      // Simulate an existing project with a stale orphan hook block already
      // written by a pre-#145 syncEngineHooks pass — exactly the RentalClaw
      // / prawduct-test state. The bundled template now declares requires.
      fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
      const stale = {
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
          Stop: [{
            matcher: '',
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
          }]
        }
      };
      fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify(stale, null, 2));
      const template = {
        id: 'prawduct',
        hooks: {
          claude: {
            Stop: [{
              matcher: '',
              requires: ['tools/product-hook'],
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
            }]
          }
        }
      };

      engines.syncEngineHooks(projectDir, template);

      const settings = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
      assert.ok(!settings.hooks, 'orphan hook block must be removed when requires unmet');
      assert.deepStrictEqual(settings.permissions, { allow: ['Bash(ls)'] }, 'non-hook keys preserved');
    });

    it('idempotency: orphan stays gone on re-sync; appears once requirement is installed', () => {
      const template = {
        id: 'prawduct',
        hooks: {
          claude: {
            Stop: [{
              matcher: '',
              requires: ['tools/product-hook'],
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
            }]
          }
        }
      };

      // First pass: requirement missing — no hooks written.
      engines.syncEngineHooks(projectDir, template);
      const first = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
      assert.ok(!first.hooks, 'no hooks written when requirement missing');

      // Install the runtime, re-sync — hook should now appear.
      fs.mkdirSync(path.join(projectDir, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'tools', 'product-hook'), '#!/bin/sh\n');
      engines.syncEngineHooks(projectDir, template);
      const second = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
      assert.ok(second.hooks && second.hooks.Stop, 'hook injected once requirement is satisfied');
      assert.ok(!('requires' in second.hooks.Stop[0]), 'requires field stripped from .claude/settings.json');
    });
  });

  describe('bundled prawduct template hook tripwire (#145)', () => {
    it('every hook entry that calls tools/product-hook declares it in `requires`', () => {
      // Tripwire: the entire #145 fix exists to ensure prawduct's runtime-
      // dependent hooks declare their preconditions. If a future PR adds a
      // hook entry referencing tools/product-hook without a `requires`
      // annotation, this test fires before the orphan-injection regression
      // ships.
      const tmpl = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'data', 'templates', 'prawduct', 'template.json'),
        'utf8'
      ));
      const claudeHooks = tmpl.hooks && tmpl.hooks.claude;
      assert.ok(claudeHooks, 'bundled prawduct template must declare claude hooks');

      for (const [eventName, entries] of Object.entries(claudeHooks)) {
        for (const entry of entries) {
          const referencesProductHook = (entry.hooks || []).some((h) =>
            typeof h.command === 'string' && h.command.includes('tools/product-hook')
          );
          if (!referencesProductHook) continue;
          assert.ok(
            Array.isArray(entry.requires) && entry.requires.includes('tools/product-hook'),
            `${eventName} entry references tools/product-hook but does not declare it in \`requires\``
          );
        }
      }
    });
  });

  describe('_buildBaselineHooks (#103)', () => {
    const supportingProfile = { capabilities: { supportsSilentPrime: true } };

    it('returns empty object when silentPrime is false', () => {
      const result = engines._buildBaselineHooks({ silentPrime: false }, supportingProfile);
      assert.deepStrictEqual(result, {});
    });

    it('returns empty object when silentPrime is missing (default off)', () => {
      const result = engines._buildBaselineHooks({}, supportingProfile);
      assert.deepStrictEqual(result, {});
    });

    it('returns empty object when projConfig is null', () => {
      const result = engines._buildBaselineHooks(null, supportingProfile);
      assert.deepStrictEqual(result, {});
    });

    it('returns SessionStart entry when silentPrime is true and engine supports it', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile);
      assert.ok(result.SessionStart, 'SessionStart should be present');
      assert.equal(result.SessionStart.length, 1);
      assert.equal(result.SessionStart[0].matcher, 'startup');
    });

    it('returns empty object when silentPrime is true but engine lacks supportsSilentPrime (Critic M1)', () => {
      const profileWithout = { capabilities: { supportsSilentPrime: false } };
      const result = engines._buildBaselineHooks({ silentPrime: true }, profileWithout);
      assert.deepStrictEqual(result, {}, 'baseline must gate on engine capability, not just projConfig');
    });

    it('returns empty object when engineProfile is omitted entirely (Critic M1)', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true });
      assert.deepStrictEqual(result, {}, 'absent engine profile cannot satisfy the capability gate');
    });

    it('SessionStart entry references {{TANGLECLAW_DIR}} placeholder', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile);
      const cmd = result.SessionStart[0].hooks[0].command;
      assert.ok(cmd.includes('{{TANGLECLAW_DIR}}'), 'should use placeholder for portability');
      assert.ok(cmd.endsWith('sessionstart-prime.sh'), 'should point at the bundled hook script');
    });

    it('SessionStart entry has command type and a status message', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile);
      const hook = result.SessionStart[0].hooks[0];
      assert.equal(hook.type, 'command');
      assert.ok(hook.statusMessage, 'should set a statusMessage so the UI shows what is loading');
    });
  });

  describe('_mergeHookObjects (#103)', () => {
    it('merges two non-overlapping events', () => {
      const a = { Stop: [{ matcher: 'a', hooks: [] }] };
      const b = { SessionStart: [{ matcher: 'b', hooks: [] }] };
      const merged = engines._mergeHookObjects(a, b);
      assert.equal(merged.Stop.length, 1);
      assert.equal(merged.SessionStart.length, 1);
    });

    it('concatenates entries under the same eventName, a before b', () => {
      const a = { SessionStart: [{ matcher: 'first' }] };
      const b = { SessionStart: [{ matcher: 'second' }] };
      const merged = engines._mergeHookObjects(a, b);
      assert.equal(merged.SessionStart.length, 2);
      assert.equal(merged.SessionStart[0].matcher, 'first');
      assert.equal(merged.SessionStart[1].matcher, 'second');
    });

    it('handles empty inputs', () => {
      assert.deepStrictEqual(engines._mergeHookObjects({}, {}), {});
      assert.deepStrictEqual(engines._mergeHookObjects(null, null), {});
      assert.deepStrictEqual(engines._mergeHookObjects(null, { Stop: [{ matcher: 'x' }] }), { Stop: [{ matcher: 'x' }] });
    });

    it('deep-clones entries so mutating the result does not leak into inputs', () => {
      const a = { SessionStart: [{ matcher: 'orig', hooks: [{ command: 'cmd' }] }] };
      const merged = engines._mergeHookObjects(a, {});
      merged.SessionStart[0].matcher = 'mutated';
      merged.SessionStart[0].hooks[0].command = 'mutated';
      assert.equal(a.SessionStart[0].matcher, 'orig');
      assert.equal(a.SessionStart[0].hooks[0].command, 'cmd');
    });
  });

  describe('syncEngineHooks silentPrime integration (#103)', () => {
    let projectDir;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-silentprime-'));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    function readSettings() {
      return JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    }

    function writeProjConfig(config) {
      const dir = path.join(projectDir, '.tangleclaw');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(config));
    }

    it('appends baseline SessionStart entry alongside methodology hooks', () => {
      writeProjConfig({ engine: 'claude', silentPrime: true });
      const template = {
        id: 'prawduct',
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              hooks: [{ type: 'command', command: 'python3 prawduct-hook' }]
            }],
            Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 stop-hook' }] }]
          }
        }
      };
      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      assert.equal(settings.hooks.SessionStart.length, 2, 'methodology + baseline coexist');
      assert.equal(settings.hooks.SessionStart[0].matcher, 'startup|clear|resume', 'methodology entry first');
      assert.equal(settings.hooks.SessionStart[1].matcher, 'startup', 'baseline entry second');
      assert.ok(settings.hooks.Stop, 'Stop hook still present');
    });

    it('writes only the baseline entry when methodology has no hooks', () => {
      writeProjConfig({ engine: 'claude', silentPrime: true });
      engines.syncEngineHooks(projectDir, { id: 'minimal', hooks: {} });

      const settings = readSettings();
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.SessionStart[0].matcher, 'startup');
      assert.ok(settings.hooks.SessionStart[0].hooks[0].command.endsWith('sessionstart-prime.sh'));
    });

    it('writes only methodology hooks when silentPrime is off', () => {
      writeProjConfig({ engine: 'claude', silentPrime: false });
      const template = {
        id: 'prawduct',
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup',
              hooks: [{ type: 'command', command: 'python3 prawduct-hook' }]
            }]
          }
        }
      };
      engines.syncEngineHooks(projectDir, template);

      const settings = readSettings();
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'python3 prawduct-hook');
    });

    it('resolves {{TANGLECLAW_DIR}} in the baseline entry on disk', () => {
      writeProjConfig({ engine: 'claude', silentPrime: true });
      engines.syncEngineHooks(projectDir, null);

      const settings = readSettings();
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      assert.ok(!cmd.includes('{{TANGLECLAW_DIR}}'), 'placeholder should be resolved before write');
      assert.ok(path.isAbsolute(cmd), 'resolved path should be absolute');
      assert.ok(cmd.endsWith('/data/hooks/sessionstart-prime.sh'));
    });

    it('does not run for non-claude engines even with silentPrime enabled', () => {
      writeProjConfig({ engine: 'codex', silentPrime: true });
      engines.syncEngineHooks(projectDir, null);

      assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'settings.json')), false,
        'should not write .claude/settings.json for non-claude engine');
    });
  });
});
