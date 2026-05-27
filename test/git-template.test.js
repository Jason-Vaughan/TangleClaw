'use strict';

/*
 * Unit tests for lib/git-template.js (#252).
 *
 * The module shells out to `git config --global …`. Tests sandbox the
 * global config target via the `GIT_CONFIG_GLOBAL` env var (git 2.32+) so
 * the real `~/.gitconfig` is never touched. The template directory is
 * redirected via `__setTemplateDir` to a per-test tmp dir for the same
 * reason — neither the operator's `~/.tangleclaw/git-template/` nor the
 * runtime's `~/.gitconfig` should ever be mutated by the suite.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const gitTemplate = require('../lib/git-template');

const SHIPPED_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'data', 'hooks', 'strip-ai-coauthors.sh'),
  'utf8'
);

let sandboxDir;
let templateDir;
let gitconfigPath;
let originalEnvGitConfigGlobal;

/**
 * Read the sandboxed git config value directly via git (rather than by
 * parsing the .gitconfig file by hand). Returns null when unset.
 */
function readSandboxedTemplateDir() {
  try {
    const out = execFileSync('git', ['config', '--global', '--get', 'init.templateDir'], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfigPath },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

/** Pre-set the sandboxed init.templateDir to an arbitrary value. */
function presetSandboxedTemplateDir(value) {
  execFileSync('git', ['config', '--global', 'init.templateDir', value], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfigPath },
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); }
  catch (_) { /* best-effort */ }
}

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gittemplate-test-'));
  templateDir = path.join(sandboxDir, 'git-template');
  gitconfigPath = path.join(sandboxDir, 'gitconfig');
  // Create the gitconfig file so `git config --global` has somewhere to
  // write. An empty file is a valid empty config.
  fs.writeFileSync(gitconfigPath, '');

  originalEnvGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfigPath;

  gitTemplate.__setTemplateDir(templateDir);
});

afterEach(() => {
  if (originalEnvGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalEnvGitConfigGlobal;
  }
  gitTemplate.__setTemplateDir(null);
  gitTemplate.__setSourceScriptPath(null);
  rmrf(sandboxDir);
});

describe('installGlobalTemplate — fresh install (init.templateDir unset)', () => {
  it('writes the commit-msg hook to <templateDir>/hooks/commit-msg with 0755 perms', () => {
    const result = gitTemplate.installGlobalTemplate();
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'refreshed');

    const hookPath = path.join(templateDir, 'hooks', 'commit-msg');
    assert.ok(fs.existsSync(hookPath), 'hook file must exist');
    assert.equal(fs.readFileSync(hookPath, 'utf8'), SHIPPED_SOURCE);

    const mode = fs.statSync(hookPath).mode & 0o777;
    assert.equal(mode, 0o755, 'hook must be executable (0755)');
  });

  it('sets git config --global init.templateDir to the template root', () => {
    const result = gitTemplate.installGlobalTemplate();
    assert.equal(result.templateDirAction, 'set');
    assert.equal(readSandboxedTemplateDir(), templateDir);
  });

  it('writes the TC-ownership sentinel at the template-dir root', () => {
    gitTemplate.installGlobalTemplate();
    const sentinelPath = path.join(templateDir, '.tc-init-templatedir-owned');
    assert.ok(fs.existsSync(sentinelPath), 'sentinel must exist');
    // Sentinel must NOT be inside hooks/ — it would otherwise leak into
    // every `git init`'d repo's hook directory.
    assert.equal(
      fs.existsSync(path.join(templateDir, 'hooks', '.tc-init-templatedir-owned')),
      false,
      'sentinel must not be inside hooks/'
    );
  });
});

describe('installGlobalTemplate — idempotence', () => {
  it('second install reports idempotent reason and does not rewrite hook content', () => {
    gitTemplate.installGlobalTemplate();
    const hookPath = path.join(templateDir, 'hooks', 'commit-msg');
    const mtimeFirst = fs.statSync(hookPath).mtimeMs;

    // Busy-wait so mtime would change if the write actually happened.
    const start = Date.now();
    while (Date.now() - start < 15) { /* spin */ }

    const result = gitTemplate.installGlobalTemplate();
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'idempotent');
    const mtimeSecond = fs.statSync(hookPath).mtimeMs;
    assert.equal(mtimeSecond, mtimeFirst, 'hook file must not have been rewritten');
  });

  it('reports already-ours when init.templateDir is already pointing at us', () => {
    gitTemplate.installGlobalTemplate(); // sets the value + writes sentinel
    const second = gitTemplate.installGlobalTemplate();
    assert.equal(second.templateDirAction, 'already-ours');
    assert.equal(readSandboxedTemplateDir(), templateDir);
  });
});

describe('installGlobalTemplate — drift refresh', () => {
  it('refreshes a stale hook file in place', () => {
    fs.mkdirSync(path.join(templateDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'hooks', 'commit-msg'), '#!/bin/sh\n# stale content\nexit 0\n', { mode: 0o755 });

    const result = gitTemplate.installGlobalTemplate();
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'refreshed');
    assert.equal(
      fs.readFileSync(path.join(templateDir, 'hooks', 'commit-msg'), 'utf8'),
      SHIPPED_SOURCE
    );
  });
});

describe('installGlobalTemplate — operator owns init.templateDir', () => {
  it('does NOT clobber a non-TC init.templateDir value', () => {
    const operatorPath = path.join(sandboxDir, 'operator-template');
    fs.mkdirSync(operatorPath, { recursive: true });
    presetSandboxedTemplateDir(operatorPath);

    const result = gitTemplate.installGlobalTemplate();
    assert.equal(result.installed, true, 'hook is still installed in TC dir');
    assert.equal(result.templateDirAction, 'foreign');
    assert.equal(result.existingValue, operatorPath);

    // git config value stays as operator set it.
    assert.equal(readSandboxedTemplateDir(), operatorPath);
  });

  it('does NOT write the sentinel when the value is operator-owned', () => {
    const operatorPath = path.join(sandboxDir, 'operator-template');
    fs.mkdirSync(operatorPath, { recursive: true });
    presetSandboxedTemplateDir(operatorPath);

    gitTemplate.installGlobalTemplate();
    assert.equal(
      fs.existsSync(path.join(templateDir, '.tc-init-templatedir-owned')),
      false,
      'sentinel must not be written when TC did not claim ownership'
    );
  });

  it('still installs the hook file even when init.templateDir is foreign (per-project hooks still work)', () => {
    const operatorPath = path.join(sandboxDir, 'operator-template');
    fs.mkdirSync(operatorPath, { recursive: true });
    presetSandboxedTemplateDir(operatorPath);

    gitTemplate.installGlobalTemplate();
    assert.ok(
      fs.existsSync(path.join(templateDir, 'hooks', 'commit-msg')),
      'hook file is written to TC dir even when global config points elsewhere'
    );
  });
});

describe('uninstallGlobalTemplate', () => {
  it('removes the hook file and reverts init.templateDir when TC owned the value', () => {
    gitTemplate.installGlobalTemplate();
    assert.equal(readSandboxedTemplateDir(), templateDir, 'precondition: TC owns templateDir');

    const result = gitTemplate.uninstallGlobalTemplate();
    assert.equal(result.uninstalled, true);
    assert.equal(result.reason, 'removed');
    assert.equal(result.templateDirAction, 'unset');

    assert.equal(fs.existsSync(path.join(templateDir, 'hooks', 'commit-msg')), false);
    assert.equal(readSandboxedTemplateDir(), null, 'init.templateDir must be unset');
    assert.equal(
      fs.existsSync(path.join(templateDir, '.tc-init-templatedir-owned')),
      false,
      'sentinel must be removed after revert'
    );
  });

  it('removes the hook but leaves init.templateDir alone when no sentinel is present', () => {
    // Simulate the operator pointing init.templateDir at TC's path
    // manually without going through TC's installer (so no sentinel).
    fs.mkdirSync(path.join(templateDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'hooks', 'commit-msg'), SHIPPED_SOURCE, { mode: 0o755 });
    presetSandboxedTemplateDir(templateDir);

    const result = gitTemplate.uninstallGlobalTemplate();
    assert.equal(result.uninstalled, true);
    assert.equal(result.reason, 'removed');
    assert.equal(result.templateDirAction, 'left-alone');

    assert.equal(readSandboxedTemplateDir(), templateDir, 'value untouched without sentinel');
  });

  it('leaves operator-changed init.templateDir alone even when sentinel is present', () => {
    gitTemplate.installGlobalTemplate(); // writes sentinel + sets value
    // Operator changes the value out from under us.
    const operatorPath = path.join(sandboxDir, 'operator-template');
    fs.mkdirSync(operatorPath, { recursive: true });
    presetSandboxedTemplateDir(operatorPath);

    const result = gitTemplate.uninstallGlobalTemplate();
    assert.equal(result.uninstalled, true);
    assert.equal(result.templateDirAction, 'value-changed-by-operator');
    assert.equal(readSandboxedTemplateDir(), operatorPath, 'operator value preserved');
    // Sentinel cleanup happens regardless so a future install sees a
    // fresh decision point.
    assert.equal(
      fs.existsSync(path.join(templateDir, '.tc-init-templatedir-owned')),
      false
    );
  });

  it('is idempotent — second call reports absent with no error', () => {
    gitTemplate.installGlobalTemplate();
    const first = gitTemplate.uninstallGlobalTemplate();
    const second = gitTemplate.uninstallGlobalTemplate();
    assert.equal(first.uninstalled, true);
    assert.equal(first.reason, 'removed');
    assert.equal(second.uninstalled, true);
    assert.equal(second.reason, 'absent');
    assert.equal(second.templateDirAction, 'left-alone');
  });
});

describe('syncGlobalTemplate dispatcher', () => {
  it('installs when config.stripAiCoauthors is true', () => {
    const out = gitTemplate.syncGlobalTemplate({ stripAiCoauthors: true });
    assert.equal(out.action, 'installed');
    assert.equal(readSandboxedTemplateDir(), templateDir);
  });

  it('installs when the field is omitted (default ON)', () => {
    const out = gitTemplate.syncGlobalTemplate({});
    assert.equal(out.action, 'installed');
    assert.equal(readSandboxedTemplateDir(), templateDir);
  });

  it('installs when config is null (defensive default ON)', () => {
    const out = gitTemplate.syncGlobalTemplate(null);
    assert.equal(out.action, 'installed');
  });

  it('uninstalls when config.stripAiCoauthors is explicitly false', () => {
    gitTemplate.syncGlobalTemplate({ stripAiCoauthors: true });
    assert.equal(readSandboxedTemplateDir(), templateDir);

    const out = gitTemplate.syncGlobalTemplate({ stripAiCoauthors: false });
    assert.equal(out.action, 'uninstalled');
    assert.equal(readSandboxedTemplateDir(), null);
  });

  it('toggle round-trip leaves no orphan state', () => {
    gitTemplate.syncGlobalTemplate({ stripAiCoauthors: true });
    gitTemplate.syncGlobalTemplate({ stripAiCoauthors: false });
    gitTemplate.syncGlobalTemplate({ stripAiCoauthors: true });

    assert.equal(readSandboxedTemplateDir(), templateDir);
    assert.ok(fs.existsSync(path.join(templateDir, 'hooks', 'commit-msg')));
    assert.ok(fs.existsSync(path.join(templateDir, '.tc-init-templatedir-owned')));
  });
});

describe('partial-failure rollback (Critic #252 — Finding 1)', () => {
  it('rolls back init.templateDir when the sentinel write fails after the config set', () => {
    // Force `_writeSentinel` to fail by pre-creating the sentinel path
    // as a directory. The module's `fs.writeFileSync` to that path will
    // EISDIR. mkdir(recursive) on the parent succeeds because the dir
    // already exists; hook write via tmp+rename succeeds because the
    // hooks/ subdir is freshly created; git config set succeeds against
    // the sandboxed gitconfig; the sentinel write is the only thing
    // that fails — exactly the partial-failure path the Critic flagged.
    const sentinelPath = path.join(templateDir, '.tc-init-templatedir-owned');
    fs.mkdirSync(sentinelPath, { recursive: true });

    const result = gitTemplate.installGlobalTemplate();
    assert.equal(result.installed, true, 'hook write still succeeds');
    assert.equal(result.templateDirAction, 'sentinel-failed');

    // Critical assertion: rollback must have unset init.templateDir, so
    // the operator's gitconfig is not left holding a stranded value
    // that future uninstall couldn't revert.
    assert.equal(
      readSandboxedTemplateDir(),
      null,
      'init.templateDir must be reverted when sentinel write fails'
    );
  });
});

describe('source script resilience', () => {
  it('returns source-missing when the source script path is broken', () => {
    gitTemplate.__setSourceScriptPath('/no/such/path/anywhere.sh');
    const result = gitTemplate.installGlobalTemplate();
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'source-missing');
  });
});

describe('git init picks up the installed hook', () => {
  it('end-to-end: after install, `git init` in a fresh dir copies the hook into .git/hooks/', () => {
    gitTemplate.installGlobalTemplate();

    const freshRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gittemplate-end2end-'));
    try {
      // Run `git init` in a fresh repo with the sandboxed global config
      // active. The init.templateDir we just set should copy our hook
      // into the new repo's .git/hooks/.
      execFileSync('git', ['init'], {
        cwd: freshRepo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfigPath },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const copiedHook = path.join(freshRepo, '.git', 'hooks', 'commit-msg');
      assert.ok(fs.existsSync(copiedHook), 'commit-msg hook must be copied into new repo via template');
      assert.equal(fs.readFileSync(copiedHook, 'utf8'), SHIPPED_SOURCE);
    } finally {
      rmrf(freshRepo);
    }
  });
});
