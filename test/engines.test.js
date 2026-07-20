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
      // gemini's yolo-parity test retired with the engine (#457) — Antigravity's
      // launch-mode flag pins live in test/antigravity-engine.test.js.

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

      it('openclaw launchModes mirror ClawBridge permissionMode values (#210 Phase 2 — picker active end-to-end)', () => {
        // Phase 2 of #210: ClawBridge v1.7.0 shipped `attachIfExists` on
        // /v2/session/start. TC now pre-creates the bridge session with
        // the picked permissionMode inside launchWebuiSession (via the
        // new lib/clawbridge.js HTTP helper); the chat UI then attaches
        // to the existing session via the bridge's idempotent attach.
        // Every openclaw mode flips disabled: false here so the picker
        // renders end-to-end for OpenClaw connections that carry a
        // bridgePort.
        //
        // History: Phase 1 (PR #249) shipped the engine-profile scaffold
        // with disabled: true; the assertion below was `=== true` then.
        // Phase 2 flips the flags and adds the HTTP helper.
        // #459: openclaw is pickerHidden, so it no longer appears in
        // listWithAvailability — resolve it directly. The launch-mode ↔
        // ClawBridge contract below is unchanged: launchWebuiSession reads
        // engineProfile.launchModes server-side to propagate the picked
        // permissionMode to the bridge. Only the PROJECT engine picker
        // dropped openclaw.
        const openclaw = engines.getWithAvailability('openclaw');
        assert.ok(openclaw, 'openclaw engine should exist');
        assert.ok(openclaw.launchModes, 'openclaw must declare launchModes');
        const BRIDGE_ACCEPTS = new Set(['default', 'acceptEdits', 'bypassPermissions', 'auto', 'plan', 'dontAsk']);
        for (const [key, mode] of Object.entries(openclaw.launchModes)) {
          assert.ok(BRIDGE_ACCEPTS.has(key),
            `openclaw mode key "${key}" must be one of ClawBridge's accepted permissionMode values: ${[...BRIDGE_ACCEPTS].join(', ')}`);
          assert.equal(typeof mode.bridgePermissionMode, 'string',
            `openclaw mode "${key}" must declare a string bridgePermissionMode for clawbridge.startSession to read`);
          assert.ok(BRIDGE_ACCEPTS.has(mode.bridgePermissionMode),
            `openclaw mode "${key}".bridgePermissionMode "${mode.bridgePermissionMode}" must be one of ClawBridge's accepted enum`);
          // Phase 2 contract: every openclaw mode is enabled now that
          // propagation is wired. If this regresses to true, the picker
          // would silently swallow the choice — surface loudly.
          assert.equal(mode.disabled, false,
            `openclaw mode "${key}" must declare disabled: false now that #210 Phase 2 has shipped`);
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
      const content = engines.generateConfig('claude', projectConfig);
      assert.ok(content);
      assert.ok(content.includes('CLAUDE.md'));
      assert.ok(content.includes('Core Rules'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('identitySentry') || content.includes('identity'));
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

  describe('AUTH-4b — service-token injection', () => {
    // Shape-only token, assembled at runtime so it doesn't trip GH push protection.
    const TOKEN = 'tcsk_' + 'A'.repeat(43);
    const proj = { rules: { core: { porthubRegistration: true } } };

    function enableGate() {
      const c = store.config.load();
      c.serviceTokenEnabled = true;
      c.serviceToken = TOKEN;
      store.config.save(c);
    }

    afterEach(() => {
      // Restore default gate state so it doesn't leak into other tests.
      const c = store.config.load();
      c.serviceTokenEnabled = false;
      c.serviceToken = null;
      store.config.save(c);
    });

    it('_getRulesContent surfaces the raw token only when the gate is enabled', () => {
      assert.equal(engines._getRulesContent(proj).serviceToken, null);
      assert.equal(engines._getRulesContent(proj).serviceTokenEnabled, false);
      enableGate();
      const rules = engines._getRulesContent(proj);
      assert.equal(rules.serviceTokenEnabled, true);
      assert.equal(rules.serviceToken, TOKEN);
    });

    it('_serviceTokenAuthLines: [] when off/null, an Authorization block when on', () => {
      assert.deepEqual(engines._serviceTokenAuthLines({ serviceTokenEnabled: false, serviceToken: null }), []);
      assert.deepEqual(engines._serviceTokenAuthLines({ serviceTokenEnabled: true, serviceToken: null }), []);
      const md = engines._serviceTokenAuthLines({ serviceTokenEnabled: true, serviceToken: TOKEN });
      assert.ok(md.some((l) => l.includes(`Authorization: Bearer ${TOKEN}`)));
      const comment = engines._serviceTokenAuthLines({ serviceTokenEnabled: true, serviceToken: TOKEN }, 'comment');
      assert.ok(comment.length > 0 && comment.every((l) => l.startsWith('#')), 'comment form must be all #-prefixed');
      assert.ok(comment.some((l) => l.includes(`Authorization: Bearer ${TOKEN}`)));
    });

    it('injects the bearer header into all four engine configs when enabled', () => {
      enableGate();
      const generated = {
        claude: engines._generateClaudeMd(proj),
        gemini: engines._generateGeminiMd(proj),
        codex: engines._generateCodexYaml(proj),
        aider: engines._generateAiderConf(proj)
      };
      for (const [name, content] of Object.entries(generated)) {
        assert.ok(content.includes(`Authorization: Bearer ${TOKEN}`), `${name} config must carry the bearer header`);
      }
    });

    it('injects nothing when the gate is off (no raw token, no injected auth block)', () => {
      // The static PortHub/shared-docs guides mention `Authorization: Bearer
      // $TANGLECLAW_SERVICE_TOKEN` as documentation; the DYNAMIC injection is
      // distinguished by the bold marker + the real token value, both absent here.
      const claudeOff = engines._generateClaudeMd(proj);
      assert.ok(!claudeOff.includes('**TangleClaw API authentication**'), 'no injected auth block when gate off');
      assert.ok(!claudeOff.includes(TOKEN), 'no raw token value when gate off');
    });

    it('static guides document the service-token Authentication requirement', () => {
      const porthubGuide = fs.readFileSync(path.join(__dirname, '..', 'data', 'porthub-guide.md'), 'utf8');
      const sharedGuide = fs.readFileSync(path.join(__dirname, '..', 'data', 'shared-docs-guide.md'), 'utf8');
      assert.match(porthubGuide, /### Authentication/);
      assert.ok(porthubGuide.includes('Authorization: Bearer'));
      assert.match(sharedGuide, /### Authentication/);
      assert.ok(sharedGuide.includes('Authorization: Bearer'));
    });
  });

  describe('ENG-5R2W — injected API base URL matches the served protocol', () => {
    const proj = { rules: { core: { porthubRegistration: true } } };
    let origConfig;

    beforeEach(() => {
      origConfig = store.config.load();
    });

    afterEach(() => {
      store.config.save(origConfig);
    });

    function patchConfig(patch) {
      store.config.save(Object.assign(store.config.load(), patch));
    }

    it('injects http:// in caddy ingress mode even with full HTTPS config', () => {
      patchConfig({
        ingressMode: 'caddy', httpsEnabled: true,
        httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem', serverPort: 3102
      });
      assert.equal(engines._getRulesContent(proj).serverProtocol, 'http');
      const content = engines._generateClaudeMd(proj);
      // Assert on the injected line itself — the static guide prose may mention
      // https://localhost:3102 as documentation, only the injected URL is live.
      assert.ok(
        content.includes('**TangleClaw API base URL**: `http://localhost:3102`'),
        'injected base URL must be http in caddy mode'
      );
      assert.ok(
        !content.includes('**TangleClaw API base URL**: `https://'),
        'must not inject an https base URL nothing serves'
      );
    });

    it('injects https:// in direct mode only with the full willServeHttps conjunction', () => {
      patchConfig({
        ingressMode: 'direct', httpsEnabled: true,
        httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem', serverPort: 3102
      });
      assert.ok(engines._generateClaudeMd(proj).includes('https://localhost:3102'));
      // httpsEnabled defaults to true — a no-cert install serves HTTP.
      patchConfig({ httpsCertPath: null, httpsKeyPath: null });
      assert.ok(engines._generateClaudeMd(proj).includes('http://localhost:3102'));
    });
  });

  describe('session rules NOT injected into config files (#595)', () => {
    let project;

    beforeEach(() => {
      const projPath = path.join(tempDir, 'sr-proj');
      fs.mkdirSync(projPath, { recursive: true });
      project = store.projects.create({ name: 'sr-proj', path: projPath, engine: 'claude' });
    });

    afterEach(() => {
      // Clear rules so other generator tests in this shared-store suite
      // don't see leaked content.
      for (const rule of store.sessionRules.list()) {
        store.sessionRules.delete(rule.id);
      }
      if (project) store.projects.delete(project.id);
    });

    // These assertions are INVERTED from their original form on purpose (#595).
    // Config-file injection was this tier's only delivery path, and it is
    // skipped wholesale for plugin-governed projects — so it delivered nothing
    // on all 13 of them while looking healthy. Delivery moved to the session
    // prime (see sessions.buildStartupRulesSection, covered in sessions.test.js).
    // Re-adding injection here would restore a second path for one tier, which
    // is what let the broken one hide; these tests fail if that happens.

    it('_getRulesContent no longer carries session rules at all', () => {
      store.sessionRules.create({ content: 'Prefer composition over inheritance', projectId: project.id });
      const rules = engines._getRulesContent({ id: project.id });
      assert.equal(rules.sessionRulesLines, undefined);
      assert.doesNotMatch(JSON.stringify(rules), /Prefer composition over inheritance/);
    });

    it('CLAUDE.md carries no Session Rules section even when rules exist', () => {
      store.sessionRules.create({ content: 'Always run lint', projectId: project.id });
      const content = engines._generateClaudeMd({ id: project.id });
      assert.doesNotMatch(content, /## Session Rules/);
      assert.doesNotMatch(content, /Always run lint/);
    });

    it('GEMINI.md carries no Session Rules section even when rules exist', () => {
      store.sessionRules.create({ content: 'Gemini must not see this', projectId: project.id });
      const content = engines._generateGeminiMd({ id: project.id });
      assert.doesNotMatch(content, /## Session Rules/);
      assert.doesNotMatch(content, /Gemini must not see this/);
    });

    it('.codex.yaml carries no Session Rules section even when rules exist', () => {
      store.sessionRules.create({ content: 'Codex must not see this', projectId: project.id });
      const content = engines._generateCodexYaml({ id: project.id });
      assert.doesNotMatch(content, /## Session Rules/);
      assert.doesNotMatch(content, /Codex must not see this/);
    });

    it('.aider.conf.yml carries no Session Rules comments even when rules exist', () => {
      store.sessionRules.create({ content: 'Aider must not see this', projectId: project.id });
      const content = engines._generateAiderConf({ id: project.id });
      assert.doesNotMatch(content, /# Session Rules:/);
      assert.doesNotMatch(content, /Aider must not see this/);
    });

    it('renders NOTHING when there are no active session rules', () => {
      const claude = engines._generateClaudeMd({ id: project.id });
      const gemini = engines._generateGeminiMd({ id: project.id });
      const codex = engines._generateCodexYaml({ id: project.id });
      const aider = engines._generateAiderConf({ id: project.id });
      assert.doesNotMatch(claude, /## Session Rules/);
      assert.doesNotMatch(gemini, /## Session Rules/);
      assert.doesNotMatch(codex, /## Session Rules/);
      assert.doesNotMatch(aider, /# Session Rules:/);
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

    it('no generator with supportsConfigFile includes a Project Version Recording section anymore', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4, `Expected at least 4 config-supporting engines, got ${profiles.length}`);

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, projectConfig);
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

    it('all generators with supportsConfigFile should include core rules', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4, `Expected at least 4 config-supporting engines, got ${profiles.length}`);

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig);
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
        const content = engines.generateConfig(profile.id, fullProjectConfig);
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
        const content = engines.generateConfig(profile.id, fullProjectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(
          content.includes('Global Rules') || content.includes('global') || content.includes('Global'),
          `${profile.id}: missing global rules`
        );
      }
    });



    it('all generators should include shared docs guide', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig);
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
        const content = engines.generateConfig(profile.id, fullProjectConfig);
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
      const content = engines._generateGeminiMd({});
      assert.ok(content.includes('GEMINI.md'));
      assert.ok(content.includes('Generated by TangleClaw'));
    });

    it('should include all core rules by default', () => {
      const content = engines._generateGeminiMd({});
      assert.ok(content.includes('CHANGELOG'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('tests'));
      assert.ok(content.includes('session wrap'));
      assert.ok(content.includes('PortHub'));
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
      const content = engines._generateGeminiMd(config);
      assert.ok(content.includes('Extension Rules'));
      assert.ok(content.includes('identity') || content.includes('sentry'));
      assert.ok(content.includes('docs'));
    });

    it('should include PortHub guide when porthubRegistration is active', () => {
      const config = {
        rules: { core: { porthubRegistration: true } }
      };
      const content = engines._generateGeminiMd(config);
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide header');
      assert.ok(content.includes('TangleClaw API'), 'Should include API base URL');
    });

    it('should exclude PortHub guide when porthubRegistration is disabled', () => {
      const config = {
        rules: { core: { porthubRegistration: false } }
      };
      const content = engines._generateGeminiMd(config);
      assert.ok(!content.includes('Port Management'));
    });

    it('should generate via public API with antigravity engine id (shared generator)', () => {
      const content = engines.generateConfig('antigravity', {
        rules: { core: {}, extensions: {} }
      });
      assert.ok(content !== null, 'generateConfig("antigravity") must not return null');
      assert.ok(typeof content === 'string');
      assert.ok(content.includes('.antigravity.md'));
    });

    it('should include global rules', () => {
      const content = engines._generateGeminiMd({});
      assert.ok(content.includes('Global Rules'), 'GEMINI.md should include global rules');
    });

    // The `.gemini/GEMINI.md` subdirectory-filename test retired with the
    // gemini profile (#457). No bundled engine writes into a subdirectory now;
    // writeEngineConfig's mkdir path still supports it for custom profiles.
  });

  describe('_generateClaudeMd', () => {
    it('should include all core rules by default', () => {
      const content = engines._generateClaudeMd({});
      assert.ok(content.includes('CHANGELOG'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('tests'));
      assert.ok(content.includes('session wrap'));
      assert.ok(content.includes('PortHub'));
    });

    it('should include global rules', () => {
      const content = engines._generateClaudeMd({});
      assert.ok(content.includes('Global Rules'), 'CLAUDE.md should include global rules');
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
      const content = engines._generateClaudeMd(config);
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
      const content = engines._generateClaudeMd(config);
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
      const content = engines._generateClaudeMd(config);
      assert.ok(!content.includes('Port Management'), 'Should not include PortHub guide');
      assert.ok(!content.includes('Never hardcode ports'), 'Should not include guide rules');
    });
  });

  describe('writeEngineConfig (#240 drift detection)', () => {
    // Captures log.warn calls via the logger module's internal sink so
    // we can assert drift warnings fire without sprinkling spies.
    let writeDir;
    let claudeProfile;
    const minimalProjConfig = {
      rules: { core: { changelogPerChange: true, jsdocAllFunctions: true, unitTestRequirements: true, sessionWrapProtocol: true, porthubRegistration: true }, extensions: {} }
    };

    before(() => {
      writeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-write-engine-config-'));
      claudeProfile = store.engines.get('claude');
      assert.ok(claudeProfile && claudeProfile.configFormat, 'claude profile must have configFormat for these tests');
    });

    after(() => {
      fs.rmSync(writeDir, { recursive: true, force: true });
    });

    it('writes the file when it does not exist (no drift)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'fresh-'));
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(result.written, true);
      assert.equal(result.drifted, false, 'no drift when target file did not exist');
      assert.equal(result.error, null);
      assert.ok(fs.existsSync(result.configFilePath), 'file written at the helper-reported path');
      assert.ok(fs.readFileSync(result.configFilePath, 'utf8').includes('Generated by TangleClaw'));
    });

    it('writes the file when it exists and matches (no drift, idempotent)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'match-'));
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(first.drifted, false);
      const second = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(second.written, true);
      assert.equal(second.drifted, false, 'unchanged content must not register as drift');
    });

    it('detects drift when the existing on-disk file differs (the #240 surface)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'drift-'));
      // Seed the target file with content that would never match the
      // regenerated output — a hand-edit a contributor might have committed.
      const configFilePath = path.join(projectPath, claudeProfile.configFormat.filename);
      fs.writeFileSync(configFilePath, '# CLAUDE.md\n\n## Manually Added Rule\n\n- This was hand-edited\n');
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
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
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      // Append/prepend extra newlines to the existing file — semantically
      // identical, should not trigger a drift warning on next write.
      const configFilePath = first.configFilePath;
      const existing = fs.readFileSync(configFilePath, 'utf8');
      fs.writeFileSync(configFilePath, '\n\n' + existing + '\n\n\n');
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
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
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, fakeProfile);
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
      const result = engines.writeEngineConfig('fake-openclaw', projectPath, minimalProjConfig, openclawShape);
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
      const result = engines.writeEngineConfig('no-such-engine', projectPath, minimalProjConfig, fakeProfile);
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
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      const configFilePath = first.configFilePath;
      // Convert the file's line endings to CRLF in-place, semantically
      // identical content.
      const lf = fs.readFileSync(configFilePath, 'utf8');
      fs.writeFileSync(configFilePath, lf.replace(/\n/g, '\r\n'));
      const second = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(second.drifted, false, 'CRLF-vs-LF must not register as drift');
    });
  });

  describe('Prawduct V2 plugin-governed deferral (#330)', () => {
    let govDir;
    let claudeProfile;
    const minimalProjConfig = {
      rules: { core: { changelogPerChange: true, jsdocAllFunctions: true, unitTestRequirements: true, sessionWrapProtocol: true, porthubRegistration: true }, extensions: {} }
    };

    before(() => {
      govDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-plugin-governed-'));
      claudeProfile = store.engines.get('claude');
    });

    after(() => {
      fs.rmSync(govDir, { recursive: true, force: true });
    });

    /**
     * Make a fresh project dir, optionally seeding .claude/settings.json and
     * .tangleclaw/project.json.
     * @param {object|null} settings - settings.json contents, or null to omit.
     * @param {object} [projConfig] - .tangleclaw/project.json contents (e.g. to
     *   pin engine + silentPrime so baseline-hook behavior is deterministic).
     * @returns {string} the project path
     */
    function mkProject(settings, projConfig) {
      const p = fs.mkdtempSync(path.join(govDir, 'proj-'));
      if (settings !== null) {
        fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
      }
      if (projConfig) {
        fs.mkdirSync(path.join(p, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(path.join(p, '.tangleclaw', 'project.json'), JSON.stringify(projConfig, null, 2) + '\n');
      }
      return p;
    }

    describe('isPluginGoverned', () => {
      it('is true when enabledPlugins has a truthy prawduct@<marketplace> key', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        assert.equal(engines.isPluginGoverned(p), true);
      });

      it('is false when the prawduct plugin is present but disabled', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': false } });
        assert.equal(engines.isPluginGoverned(p), false);
      });

      it('is false when there is no settings.json at all', () => {
        const p = mkProject(null);
        assert.equal(engines.isPluginGoverned(p), false);
      });

      it('is false when enabledPlugins is absent or unrelated', () => {
        assert.equal(engines.isPluginGoverned(mkProject({})), false);
        assert.equal(engines.isPluginGoverned(mkProject({ enabledPlugins: { 'swift-lsp@claude-plugins-official': true } })), false);
      });

      it('fails closed (false) on malformed JSON rather than throwing', () => {
        const p = fs.mkdtempSync(path.join(govDir, 'badjson-'));
        fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(p, '.claude', 'settings.json'), '{ not valid json');
        assert.equal(engines.isPluginGoverned(p), false);
      });
    });

    describe('governanceState (#353)', () => {
      const claudeMeta = { engineId: 'claude' };

      /** Drop a vendored governance hook file into a project (Cohort A shape). */
      function addVendoredHook(p) {
        fs.mkdirSync(path.join(p, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(p, 'tools', 'product-hook'), '#!/usr/bin/env python3\n');
      }

      it('is governed-plugin when the V2 plugin is enabled', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        assert.equal(engines.governanceState(p, claudeMeta), 'governed-plugin');
      });

      it('is governed-vendored when a vendored product-hook is present (no plugin)', () => {
        const p = mkProject({});
        addVendoredHook(p);
        assert.equal(engines.governanceState(p, claudeMeta), 'governed-vendored');
      });

      it('is ungoverned for a Claude project with neither plugin nor vendored hook', () => {
        const p = mkProject({});
        assert.equal(engines.governanceState(p, claudeMeta), 'ungoverned');
      });

      it('prefers plugin over vendored when both are present (no double-governance ambiguity)', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        addVendoredHook(p);
        assert.equal(engines.governanceState(p, claudeMeta), 'governed-plugin');
      });

      it('is not-applicable for a non-Claude engine regardless of files', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        addVendoredHook(p);
        assert.equal(engines.governanceState(p, { engineId: 'gemini' }), 'not-applicable');
      });

      it('is not-applicable when meta is missing the engine', () => {
        const p = mkProject({});
        assert.equal(engines.governanceState(p, {}), 'not-applicable');
        assert.equal(engines.governanceState(p), 'not-applicable');
      });

      it('fails closed to ungoverned on malformed settings (no throw)', () => {
        const p = fs.mkdtempSync(path.join(govDir, 'gov-badjson-'));
        fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(p, '.claude', 'settings.json'), '{ not valid json');
        // isPluginGoverned fails closed (false) + no vendored hook → ungoverned, not a throw.
        assert.equal(engines.governanceState(p, claudeMeta), 'ungoverned');
      });

      it('never reports an alarming state for an ordinary un-onboarded project (#538)', () => {
        // The vocabulary deliberately has no fault state: with the methodology
        // label gone there is nothing for the filesystem to contradict, so a
        // project that simply is not governed must read as neutral.
        const p = mkProject(null);
        const state = engines.governanceState(p, claudeMeta);
        assert.equal(state, 'ungoverned');
        assert.ok(!/drift/.test(state), 'ungoverned must not be reported as drift');
      });
    });

    describe('writeEngineConfig defers', () => {
      it('skips (no error) and does NOT overwrite an existing CLAUDE.md when plugin-governed', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        const anchor = '# CLAUDE.md\n\n<!-- PRAWDUCT:ANCHOR -->\nGoverned by the Prawduct V2 plugin.\n';
        const claudeMd = path.join(p, claudeProfile.configFormat.filename);
        fs.writeFileSync(claudeMd, anchor);

        const result = engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);

        assert.equal(result.written, false);
        assert.equal(result.skipped, true);
        assert.equal(result.error, null, 'deferral must not surface as an error');
        assert.match(result.skipReason, /plugin/i);
        assert.equal(fs.readFileSync(claudeMd, 'utf8'), anchor, 'the plugin-owned CLAUDE.md anchor must be untouched');
      });

      it('still writes CLAUDE.md normally when NOT plugin-governed (regression)', () => {
        const p = mkProject(null);
        const result = engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);
        assert.equal(result.written, true);
        assert.ok(fs.readFileSync(result.configFilePath, 'utf8').includes('Generated by TangleClaw'));
      });
    });

    describe('syncEngineHooks defers GOVERNANCE but keeps TC L1 prime (#330)', () => {
      const staleGovHook = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }] }] };

      it('silentPrime OFF: drops the governance hook entirely, preserves the install reference', () => {
        const p = mkProject({
          extraKnownMarketplaces: { prawduct: { source: { source: 'github', repo: 'brookstalley/prawduct' }, autoUpdate: false } },
          enabledPlugins: { 'prawduct@prawduct': true },
          hooks: staleGovHook
        }, { engine: 'claude', methodology: 'prawduct', silentPrime: false });

        engines.syncEngineHooks(p);

        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined, 'no governance hook and no L1 prime → hooks block removed');
        assert.equal(settings.enabledPlugins['prawduct@prawduct'], true, 'the plugin enablement must be preserved');
        assert.ok(settings.extraKnownMarketplaces && settings.extraKnownMarketplaces.prawduct, 'the marketplace reference must be preserved');
      });

      it('silentPrime ON: keeps TC\'s L1 prime hook but drops the governance Stop hook', () => {
        const p = mkProject({
          enabledPlugins: { 'prawduct@prawduct': true },
          hooks: staleGovHook
        }, { engine: 'claude', methodology: 'prawduct', silentPrime: true });

        engines.syncEngineHooks(p);

        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.ok(settings.hooks, 'the L1 prime hook block must remain');
        assert.ok(settings.hooks.SessionStart, 'TC L1 silent-prime SessionStart hook must survive on a governed project');
        assert.equal(settings.hooks.Stop, undefined, 'the governance Stop hook must be dropped (delegated to the plugin)');
        // No surviving hook may reference the vendored governance script.
        const allCommands = JSON.stringify(settings.hooks);
        assert.ok(!allCommands.includes('product-hook'), 'no surviving hook may reference the removed vendored governance script');
        assert.equal(settings.enabledPlugins['prawduct@prawduct'], true, 'the plugin enablement must be preserved');
      });

      it('does not inject methodology/governance hooks for a governed project (no stale block)', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } }, { engine: 'claude', methodology: 'prawduct', silentPrime: false });
        engines.syncEngineHooks(p);
        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined, 'governed + no L1 → no hooks block');
        assert.equal(settings.enabledPlugins['prawduct@prawduct'], true);
      });

      it('drops a pre-existing governance Stop hook whatever the governance state (#538)', () => {
        // TC emits only its own L1 baseline now — it has no governance hooks of
        // its own to suppress. So the contract is unconditional: a Stop hook
        // left behind by a pre-V2 install is cleared on the next sync whether or
        // not the plugin is enabled. Ungoverned is the case that would regress
        // silently if this became conditional again, since that project has no
        // plugin to own the gate in TC's place.
        const legacy = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo governance-gate' }] }] };

        for (const [label, settings] of [
          ['ungoverned', {}],
          ['governed', { enabledPlugins: { 'prawduct@prawduct': true } }]
        ]) {
          const p = mkProject({ ...settings, hooks: legacy }, { engine: 'claude', silentPrime: false });
          engines.syncEngineHooks(p);
          const written = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
          assert.equal(written.hooks, undefined, `${label}: the legacy governance Stop hook must be cleared`);
        }
      });
    });

    describe('syncEngineHooks resolves the engine from the DB, projConfig only as fallback', () => {
      it('registered non-claude project with no projConfig engine key takes the cleanup branch', () => {
        // Sibling of the boot-sync engine fix: a registered codex project whose
        // legacy project.json lacks the `engine` key must NOT resolve as claude
        // here — that wrote baseline hooks into .claude/settings.json for a
        // project whose runtime never reads them, and skipped the stale-hooks
        // cleanup the non-claude branch exists for.
        // silentPrime true is the discriminator: resolved-as-claude writes the
        // L1 SessionStart baseline hook; resolved-as-codex takes the cleanup
        // branch and removes the hooks block entirely.
        const p = mkProject(
          { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo stale' }] }] } },
          { methodology: 'minimal', silentPrime: true } // no engine key
        );
        store.projects.create({ name: `db-hooks-${path.basename(p)}`, path: p, engine: 'codex' });

        engines.syncEngineHooks(p);

        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined,
          'DB says codex → stale hooks cleared, no baseline hooks written');
      });

      it('unregistered path still falls back to projConfig.engine', () => {
        const p = mkProject(
          { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo stale' }] }] } },
          { engine: 'codex', methodology: 'minimal', silentPrime: false }
        );
        engines.syncEngineHooks(p);
        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined,
          'projConfig engine=codex honored for a path the DB does not know');
      });
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
      assert.ok(ids.includes('antigravity'), 'Missing antigravity');
      assert.ok(!ids.includes('gemini'), 'gemini retired (#457) — must not resurface');
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
      assert.ok(ids.includes('aider'), 'Missing aider');
      assert.ok(ids.includes('antigravity'), 'Missing antigravity');
      assert.ok(!ids.includes('gemini'), 'gemini retired (#457) — must not resurface');
      assert.ok(!ids.includes('genesis'), 'genesis retired (#458) — must not resurface');
    });

    it('known providers should have adapter and url', () => {
      const result = engines.validateStatusParity();
      const knownProviders = ['claude', 'codex', 'antigravity'];
      for (const id of knownProviders) {
        const engine = result.engines.find(e => e.id === id);
        assert.ok(engine, `${id} not found in parity results`);
        assert.equal(engine.valid, true, `${id} status parity failed: ${engine.errors.join(', ')}`);
      }
    });

    it('engines without status pages should have null statusPage', () => {
      const result = engines.validateStatusParity();
      const noStatus = ['aider'];
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
      const content = engines.generateConfig('antigravity', projectConfig);
      assert.ok(content !== null, 'Antigravity config should not be null');
      assert.ok(content.includes('.antigravity.md'), 'Should have .antigravity.md header');
      assert.ok(content.includes('Core Rules'), 'Should have core rules section');
      assert.ok(content.includes('Extension Rules'), 'Should have extension rules section');
      assert.ok(content.includes('docs'), 'Should include docsParity extension');
      assert.ok(content.includes('Critic') || content.includes('critic'), 'Should include independentCritic extension');
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide');
      assert.ok(content.includes('TangleClaw API'), 'Should include API base URL');
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

        // Also verify Antigravity picks them up
        const agyContent = engines.generateConfig('antigravity', { rules: { core: {} } });
        assert.ok(agyContent.includes('Custom integration test rule alpha'),
          'Antigravity config should also reflect updated global rules');
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
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      const configs = {};
      for (const profile of profiles) {
        configs[profile.id] = engines.generateConfig(profile.id, projectConfig);
        assert.ok(configs[profile.id] !== null, `${profile.id} returned null`);
      }

      // All configs should mention CHANGELOG, PortHub, TestMethod, and identity/sentry
      for (const [id, content] of Object.entries(configs)) {
        assert.ok(content.includes('CHANGELOG') || content.includes('changelog'), `${id}: missing CHANGELOG`);
        assert.ok(content.includes('PortHub') || content.includes('Port Management') || content.includes('TangleClaw API'), `${id}: missing PortHub`);
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
        engineId: 'claude'
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

      const claude = engines._generateClaudeMd(projectConfig);
      assert.ok(claude.includes('Parity Doc'), 'Claude should include shared doc');

      const gemini = engines._generateGeminiMd(projectConfig);
      assert.ok(gemini.includes('Parity Doc'), 'Gemini should include shared doc');

      const codex = engines._generateCodexYaml(projectConfig);
      assert.ok(codex.includes('Parity Doc'), 'Codex should include shared doc');

      const aider = engines._generateAiderConf(projectConfig);
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

    // Each test gets a fresh project dir: with baseline-hook writing in play
    // (#103), shared dir state would let a leftover .tangleclaw/project.json
    // silently change what gets written.
    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-hooks-test-'));
      const tcDir = path.join(projectDir, '.tangleclaw');
      fs.mkdirSync(tcDir, { recursive: true });
      fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({
        engine: 'claude',
        silentPrime: true
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

    it('writes the baseline SessionStart hook when silentPrime is on', () => {
      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.ok(settings.hooks, 'hooks key should exist');
      assert.ok(settings.hooks.SessionStart, 'SessionStart hooks should exist');
      assert.equal(settings.hooks.SessionStart.length, 1);
    });

    it('resolves the {{TANGLECLAW_DIR}} placeholder in the hooks it writes', () => {
      engines.syncEngineHooks(projectDir);

      const cmd = readSettings().hooks.SessionStart[0].hooks[0].command;
      assert.ok(!cmd.includes('{{TANGLECLAW_DIR}}'), 'placeholder should be resolved');
      assert.ok(path.isAbsolute(cmd.split(' ')[0].replace(/^"/, '')) || cmd.includes('/'),
        'resolved command should carry a real path');
    });

    it('preserves existing non-hook settings and replaces the hooks block wholesale', () => {
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        permissions: { allow: ['Bash(git status:*)'] },
        companyAnnouncements: ['Test announcement'],
        hooks: { Old: [{ matcher: '', hooks: [] }] }
      }, null, 2));

      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.deepStrictEqual(settings.permissions, { allow: ['Bash(git status:*)'] });
      assert.deepStrictEqual(settings.companyAnnouncements, ['Test announcement']);
      assert.ok(!settings.hooks.Old, 'old hooks should be replaced, not merged');
      assert.ok(settings.hooks.SessionStart, 'new hooks should be present');
    });

    it('removes the hooks block when there are no hooks to write', () => {
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        permissions: { allow: [] },
        hooks: { Stop: [{ matcher: '', hooks: [] }] }
      }, null, 2));
      fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), JSON.stringify({
        engine: 'claude',
        silentPrime: false
      }));

      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.ok(!settings.hooks, 'hooks key should be removed');
      assert.ok(settings.permissions, 'permissions should be preserved');
    });

    it('should create .claude directory if missing', () => {
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-hooks-fresh-'));
      try {
        fs.mkdirSync(path.join(freshDir, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(path.join(freshDir, '.tangleclaw', 'project.json'), JSON.stringify({
          engine: 'claude',
          silentPrime: true
        }));

        engines.syncEngineHooks(freshDir);

        assert.ok(fs.existsSync(path.join(freshDir, '.claude', 'settings.json')));
        const settings = JSON.parse(fs.readFileSync(path.join(freshDir, '.claude', 'settings.json'), 'utf8'));
        assert.ok(settings.hooks.SessionStart);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
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


    it('writes only the baseline entry', () => {
      writeProjConfig({ engine: 'claude', silentPrime: true });
      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.SessionStart[0].matcher, 'startup');
      assert.ok(settings.hooks.SessionStart[0].hooks[0].command.endsWith('sessionstart-prime.sh'));
    });


    it('resolves {{TANGLECLAW_DIR}} in the baseline entry on disk', () => {
      writeProjConfig({ engine: 'claude', silentPrime: true });
      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      assert.ok(!cmd.includes('{{TANGLECLAW_DIR}}'), 'placeholder should be resolved before write');
      assert.ok(path.isAbsolute(cmd), 'resolved path should be absolute');
      assert.ok(cmd.endsWith('/data/hooks/sessionstart-prime.sh'));
    });

    it('does not run for non-claude engines even with silentPrime enabled', () => {
      writeProjConfig({ engine: 'codex', silentPrime: true });
      engines.syncEngineHooks(projectDir);

      assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'settings.json')), false,
        'should not write .claude/settings.json for non-claude engine');
    });
  });
});
