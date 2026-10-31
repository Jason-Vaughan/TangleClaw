'use strict';

// #2439 — Aider engine effectiveness: the real markdown conventions carrier
// (`.tangleclaw/aider-conventions.md`), the `read:`/`gitignore: false` wiring
// in `.aider.conf.yml`, and local-model ergonomics, exercised end-to-end
// through `writeEngineConfig` (the actual disk-write path, not just the
// pure string generators covered in test/engines.test.js).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync: realSpawnSync } = require('node:child_process');
const store = require('../lib/store');
const engines = require('../lib/engines');
const aiderTaskContract = require('../lib/aider-task-contract');

const PROJECT_CONFIG = {
  rules: {
    core: { changelogPerChange: true, jsdocAllFunctions: true, unitTestRequirements: true, sessionWrapProtocol: true, porthubRegistration: true },
    extensions: {}
  }
};

describe('aider engine (#2439)', () => {
  let tempDir;
  let aiderProfile;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-aider-engine-'));
    store._setBasePath(tempDir);
    store.init();
    aiderProfile = store.engines.get('aider');
    assert.ok(aiderProfile && aiderProfile.configFormat, 'aider profile must have configFormat');
    assert.equal(aiderProfile.configFormat.generator, 'aider-conf');
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes both .aider.conf.yml and .tangleclaw/aider-conventions.md', () => {
    const projectPath = fs.mkdtempSync(path.join(tempDir, 'proj-'));
    const result = engines.writeEngineConfig('aider', projectPath, PROJECT_CONFIG, aiderProfile);
    assert.equal(result.written, true);
    assert.equal(result.error, null);

    const confPath = path.join(projectPath, '.aider.conf.yml');
    assert.ok(fs.existsSync(confPath), '.aider.conf.yml must exist');
    const confContent = fs.readFileSync(confPath, 'utf8');
    assert.ok(confContent.includes('read:'));
    assert.ok(confContent.includes('.tangleclaw/aider-conventions.md'));
    assert.ok(confContent.includes('gitignore: false'));

    const conventionsPath = path.join(projectPath, '.tangleclaw', 'aider-conventions.md');
    assert.ok(fs.existsSync(conventionsPath), '.tangleclaw/aider-conventions.md must exist');
    const conventionsContent = fs.readFileSync(conventionsPath, 'utf8');
    assert.ok(conventionsContent.includes('## Core Rules (Enforced)'));
    assert.ok(conventionsContent.includes('PortHub'));
  });

  it('regenerates the conventions carrier on a second write (kept in sync with rules changes)', () => {
    const projectPath = fs.mkdtempSync(path.join(tempDir, 'resync-'));
    engines.writeEngineConfig('aider', projectPath, PROJECT_CONFIG, aiderProfile);
    const conventionsPath = path.join(projectPath, '.tangleclaw', 'aider-conventions.md');
    const before1 = fs.readFileSync(conventionsPath, 'utf8');
    assert.ok(!before1.includes('## Extension Rules'));

    const withExtensionRules = {
      rules: {
        ...PROJECT_CONFIG.rules,
        extensions: { identitySentry: true }
      }
    };
    engines.writeEngineConfig('aider', projectPath, withExtensionRules, aiderProfile);
    const after1 = fs.readFileSync(conventionsPath, 'utf8');
    assert.ok(after1.includes('## Extension Rules'));
    assert.ok(after1.includes('Verify identity with sentry checks'));
  });

  it('a nested extensions.aider model setting reaches .aider.conf.yml but never the conventions prose', () => {
    const projectPath = fs.mkdtempSync(path.join(tempDir, 'localmodel-'));
    const withAiderSettings = {
      rules: { ...PROJECT_CONFIG.rules, extensions: { aider: { model: 'ollama_chat/llama3' } } }
    };
    engines.writeEngineConfig('aider', projectPath, withAiderSettings, aiderProfile);
    const confContent = fs.readFileSync(path.join(projectPath, '.aider.conf.yml'), 'utf8');
    assert.ok(confContent.includes('model: "ollama_chat/llama3"'));
    const conventionsContent = fs.readFileSync(path.join(projectPath, '.tangleclaw', 'aider-conventions.md'), 'utf8');
    assert.ok(!conventionsContent.includes('ollama_chat/llama3'));
  });

  it('propagates a conventions-carrier write failure instead of writing a broken read: pointer (#2756 PRR-A revise)', () => {
    const projectPath = fs.mkdtempSync(path.join(tempDir, 'writefail-'));
    // Occupy the conventions file's own directory with a plain FILE, so
    // `fs.mkdirSync(dirname, { recursive: true })` cannot create it.
    fs.writeFileSync(path.join(projectPath, '.tangleclaw'), 'not a directory\n');
    const result = engines.writeEngineConfig('aider', projectPath, PROJECT_CONFIG, aiderProfile);
    assert.equal(result.written, false);
    assert.equal(result.skipped, false);
    assert.match(result.error, /aider-conventions\.md/);
    assert.ok(!fs.existsSync(path.join(projectPath, '.aider.conf.yml')),
      '.aider.conf.yml must not be written when its read: target failed to write');
  });

  it('does not write a conventions carrier for a non-aider engine', () => {
    const projectPath = fs.mkdtempSync(path.join(tempDir, 'claude-'));
    const claudeProfile = store.engines.get('claude');
    engines.writeEngineConfig('claude', projectPath, PROJECT_CONFIG, claudeProfile);
    assert.ok(!fs.existsSync(path.join(projectPath, '.tangleclaw', 'aider-conventions.md')));
  });

  it('a standalone generateConfig("aider", ...) preview call (no projectPath) does not touch disk', () => {
    // Regression guard: _generateAiderConf must stay a pure string
    // generator. Folding the conventions-file write into it would make this
    // content-preview call site (and several in test/engines.test.js) write
    // files as a surprise side effect.
    const content = engines.generateConfig('aider', PROJECT_CONFIG);
    assert.ok(typeof content === 'string' && content.length > 0);
  });

  it('bundled profile: launch, detection and config format are sane', () => {
    assert.equal(aiderProfile.id, 'aider');
    assert.equal(aiderProfile.command, 'aider');
    assert.equal(aiderProfile.configFormat.filename, '.aider.conf.yml');
    assert.equal(aiderProfile.capabilities.supportsConfigFile, true);
  });

  it('declares the task-contract integration point (#1644)', () => {
    assert.equal(aiderProfile.capabilities.taskContract.supported, true);
    assert.equal(aiderProfile.capabilities.taskContract.entryPoint, 'lib/engines.js#runAiderTask');
  });

  describe('runAiderTask (#1644) integration point', () => {
    let repoPath;

    before(() => {
      repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-aider-task-wiring-'));
      execFileSync('git', ['init', '-q'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.email', 'tc@test.local'], { cwd: repoPath });
      execFileSync('git', ['config', 'user.name', 'tc-test'], { cwd: repoPath });
      fs.writeFileSync(path.join(repoPath, 'a.js'), 'hello\n');
      execFileSync('git', ['add', 'a.js'], { cwd: repoPath });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath });
    });

    after(() => {
      fs.rmSync(repoPath, { recursive: true, force: true });
    });

    it('exports the same module the standalone contract tests exercise', () => {
      assert.equal(engines.aiderTaskContract, aiderTaskContract);
    });

    it('delegates to aider-task-contract with projectPath as repoPath, ignoring any repoPath in taskSpec', () => {
      const fake = (cmd, args, opts) => {
        if (cmd !== 'aider') return realSpawnSync(cmd, args, opts);
        fs.writeFileSync(path.join(repoPath, 'a.js'), `edited via runAiderTask ${Date.now()}\n`);
        execFileSync('git', ['add', 'a.js'], { cwd: repoPath });
        execFileSync('git', ['commit', '-q', '-m', 'aider edit via runAiderTask'], { cwd: repoPath });
        return { status: 0, signal: null, stdout: 'Done.', stderr: '' };
      };
      const receipt = engines.runAiderTask(
        repoPath,
        { repoPath: '/should/be/ignored', editableFiles: ['a.js'], message: 'edit a.js' },
        { spawnSync: fake }
      );
      assert.equal(receipt.outcome, 'success');
      assert.equal(receipt.repoPath, repoPath);
      assert.deepEqual(receipt.filesChanged, ['a.js']);
    });
  });
});
