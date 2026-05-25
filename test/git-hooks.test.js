'use strict';

/*
 * Unit tests for lib/git-hooks.js (#247).
 *
 * Mocks a project directory with a real `.git/` so install/uninstall hit the
 * filesystem path the library cares about. The hook source script is the
 * shipped `data/hooks/strip-ai-coauthors.sh` — keeps the tests honest about
 * the actual content being installed.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gitHooks = require('../lib/git-hooks');

/**
 * Make a tmp project dir with optional .git/. Returns the absolute path.
 * @param {{ git?: boolean }} [opts]
 * @returns {string}
 */
function makeProject(opts = { git: true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-githooks-test-'));
  if (opts.git) {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  }
  return root;
}

/**
 * Recursively remove a path. node 14.14+ has rmSync, gracefully degrade.
 * @param {string} p
 */
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); }
  catch (_) { /* test cleanup is best-effort */ }
}

let projectPath;
let originalSource;

beforeEach(() => {
  projectPath = makeProject({ git: true });
  // Capture default source for assertions below.
  originalSource = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'hooks', 'strip-ai-coauthors.sh'),
    'utf8'
  );
});

afterEach(() => {
  rmrf(projectPath);
});

describe('installCommitMsgHook', () => {
  it('installs the hook into .git/hooks/commit-msg with 0755 perms', () => {
    const result = gitHooks.installCommitMsgHook(projectPath);
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'refreshed');

    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    assert.ok(fs.existsSync(hookPath), 'commit-msg hook must exist');

    const content = fs.readFileSync(hookPath, 'utf8');
    assert.equal(content, originalSource, 'content must match source script byte-for-byte');
    assert.ok(content.includes(gitHooks.TC_HOOK_MARKER), 'content must carry TC ownership marker');

    const mode = fs.statSync(hookPath).mode & 0o777;
    assert.equal(mode, 0o755, 'hook must be executable (0755)');
  });

  it('returns no-git when the project directory has no .git/', () => {
    const noGit = makeProject({ git: false });
    try {
      const result = gitHooks.installCommitMsgHook(noGit);
      assert.equal(result.installed, false);
      assert.equal(result.reason, 'no-git');
    } finally {
      rmrf(noGit);
    }
  });

  it('is idempotent — re-installing reports idempotent and does not rewrite', () => {
    gitHooks.installCommitMsgHook(projectPath);
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    const mtimeFirst = fs.statSync(hookPath).mtimeMs;

    // tiny delay so mtime would change if the write actually happened
    const start = Date.now();
    while (Date.now() - start < 10) { /* busy wait */ }

    const result = gitHooks.installCommitMsgHook(projectPath);
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'idempotent');
    const mtimeSecond = fs.statSync(hookPath).mtimeMs;
    assert.equal(mtimeSecond, mtimeFirst, 'file must not have been re-written when content matches');
  });

  it('refreshes a TC-owned hook whose content has drifted', () => {
    // Install a stub that carries the marker but is older content.
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hookPath, '#!/bin/sh\n# TC-OWNED-HOOK: strip-ai-coauthors v0\nexit 0\n', { mode: 0o755 });

    const result = gitHooks.installCommitMsgHook(projectPath);
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'refreshed');

    const content = fs.readFileSync(hookPath, 'utf8');
    assert.equal(content, originalSource, 'drifted TC-owned hook must be refreshed to current source');
  });

  it('refuses to clobber a foreign (non-TC-owned) commit-msg hook', () => {
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    const foreign = '#!/bin/sh\n# operator-authored: commitlint wrapper\nexit 0\n';
    fs.writeFileSync(hookPath, foreign, { mode: 0o755 });

    const result = gitHooks.installCommitMsgHook(projectPath);
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'foreign-hook');
    assert.equal(result.existingPath, hookPath);

    assert.equal(fs.readFileSync(hookPath, 'utf8'), foreign, 'foreign hook content must be preserved');
  });

  it('treats a .git pointer file (worktree / submodule) as no-git for v1', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-githooks-worktree-'));
    try {
      // Worktrees use a `.git` FILE pointing at the gitdir, not a directory.
      fs.writeFileSync(path.join(root, '.git'), 'gitdir: /some/other/gitdir\n');
      const result = gitHooks.installCommitMsgHook(root);
      assert.equal(result.installed, false);
      assert.equal(result.reason, 'no-git', 'pointer-file .git should be treated as no-git in v1');
    } finally {
      rmrf(root);
    }
  });

  // F8 (#247 hardening) — `.git` as a SYMLINK to a real directory must also
  // be treated as no-git in v1. `statSync` would follow the symlink and
  // report `isDirectory() === true`, defeating the worktree carve-out;
  // `lstatSync` is the load-bearing call.
  it('treats a symlinked .git as no-git for v1 (symlink carve-out)', () => {
    const realGit = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-githooks-shared-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-githooks-symlink-'));
    try {
      fs.mkdirSync(path.join(realGit, 'hooks'), { recursive: true });
      fs.symlinkSync(realGit, path.join(root, '.git'));
      const result = gitHooks.installCommitMsgHook(root);
      assert.equal(result.installed, false);
      assert.equal(result.reason, 'no-git', 'symlinked .git should be treated as no-git in v1');
      // Confirm nothing was written into the symlink target — the v1
      // exclusion exists specifically to avoid clobbering shared gitdirs.
      assert.equal(fs.existsSync(path.join(realGit, 'hooks', 'commit-msg')), false);
    } finally {
      rmrf(root);
      rmrf(realGit);
    }
  });

  // F9 (#247 hardening) — operator's foreign hook may legitimately mention
  // the TC-OWNED-HOOK marker text in a docstring/comment ("this hook
  // coexists with TC-OWNED-HOOK: strip-ai-coauthors") without being
  // TC-managed. A bare substring check would misclassify it; the anchored
  // line check protects against the clobber.
  it('does NOT misclassify a foreign hook that mentions the marker text in a body comment', () => {
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    const foreign = '#!/bin/sh\n' +
      '# operator-authored commitlint wrapper.\n' +
      '# Note: this coexists with TC-OWNED-HOOK: strip-ai-coauthors v1 when both are installed.\n' +
      'commitlint --edit "$1"\n';
    fs.writeFileSync(hookPath, foreign, { mode: 0o755 });

    const result = gitHooks.installCommitMsgHook(projectPath);
    assert.equal(result.installed, false, 'must NOT clobber foreign hook that merely mentions marker');
    assert.equal(result.reason, 'foreign-hook');
    assert.equal(fs.readFileSync(hookPath, 'utf8'), foreign, 'foreign hook content preserved');
  });

  it('does NOT misclassify when the marker appears beyond the first 20 lines', () => {
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    const filler = Array.from({ length: 25 }, (_, i) => `# foreign line ${i + 1}`).join('\n');
    const foreign = `#!/bin/sh\n${filler}\n# TC-OWNED-HOOK: strip-ai-coauthors v1\nexit 0\n`;
    fs.writeFileSync(hookPath, foreign, { mode: 0o755 });

    const result = gitHooks.installCommitMsgHook(projectPath);
    assert.equal(result.installed, false, 'marker beyond the header line limit must NOT count as TC-owned');
    assert.equal(result.reason, 'foreign-hook');
    assert.equal(fs.readFileSync(hookPath, 'utf8'), foreign);
  });

  it('returns source-missing when the source script path is broken', () => {
    gitHooks.__setSourceScriptPath('/no/such/script/anywhere.sh');
    try {
      const result = gitHooks.installCommitMsgHook(projectPath);
      assert.equal(result.installed, false);
      assert.equal(result.reason, 'source-missing');
    } finally {
      gitHooks.__setSourceScriptPath(null);
    }
  });
});

describe('uninstallCommitMsgHook', () => {
  it('removes a TC-owned hook', () => {
    gitHooks.installCommitMsgHook(projectPath);
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    assert.ok(fs.existsSync(hookPath));

    const result = gitHooks.uninstallCommitMsgHook(projectPath);
    assert.equal(result.uninstalled, true);
    assert.equal(result.reason, 'removed');
    assert.equal(fs.existsSync(hookPath), false, 'hook file must be gone');
  });

  it('preserves a foreign commit-msg hook', () => {
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    const foreign = '#!/bin/sh\n# operator script\nexit 0\n';
    fs.writeFileSync(hookPath, foreign, { mode: 0o755 });

    const result = gitHooks.uninstallCommitMsgHook(projectPath);
    assert.equal(result.uninstalled, false);
    assert.equal(result.reason, 'foreign-hook');
    assert.equal(fs.readFileSync(hookPath, 'utf8'), foreign, 'foreign hook must be preserved');
  });

  it('returns absent when no commit-msg hook is installed', () => {
    const result = gitHooks.uninstallCommitMsgHook(projectPath);
    assert.equal(result.uninstalled, false);
    assert.equal(result.reason, 'absent');
  });

  it('returns no-git when project has no .git/', () => {
    const noGit = makeProject({ git: false });
    try {
      const result = gitHooks.uninstallCommitMsgHook(noGit);
      assert.equal(result.uninstalled, false);
      assert.equal(result.reason, 'no-git');
    } finally {
      rmrf(noGit);
    }
  });

  it('is idempotent — calling twice does nothing the second time', () => {
    gitHooks.installCommitMsgHook(projectPath);
    const first = gitHooks.uninstallCommitMsgHook(projectPath);
    const second = gitHooks.uninstallCommitMsgHook(projectPath);
    assert.equal(first.uninstalled, true);
    assert.equal(second.uninstalled, false);
    assert.equal(second.reason, 'absent');
  });
});

describe('syncGitHooks', () => {
  it('installs when config.stripAiCoauthors is true', () => {
    const result = gitHooks.syncGitHooks(projectPath, { stripAiCoauthors: true });
    assert.equal(result.action, 'installed');
    assert.ok(fs.existsSync(path.join(projectPath, '.git', 'hooks', 'commit-msg')));
  });

  it('installs when config.stripAiCoauthors is omitted (default ON)', () => {
    const result = gitHooks.syncGitHooks(projectPath, {});
    assert.equal(result.action, 'installed', 'omitted field defaults to ON');
    assert.ok(fs.existsSync(path.join(projectPath, '.git', 'hooks', 'commit-msg')));
  });

  it('installs when config object is null (default ON)', () => {
    const result = gitHooks.syncGitHooks(projectPath, null);
    assert.equal(result.action, 'installed', 'null config defaults to ON');
  });

  it('uninstalls when config.stripAiCoauthors is explicitly false', () => {
    // Install first
    gitHooks.syncGitHooks(projectPath, { stripAiCoauthors: true });
    assert.ok(fs.existsSync(path.join(projectPath, '.git', 'hooks', 'commit-msg')));

    const result = gitHooks.syncGitHooks(projectPath, { stripAiCoauthors: false });
    assert.equal(result.action, 'uninstalled');
    assert.equal(fs.existsSync(path.join(projectPath, '.git', 'hooks', 'commit-msg')), false);
  });

  it('reports noop when toggle ON but project has no .git/', () => {
    const noGit = makeProject({ git: false });
    try {
      const result = gitHooks.syncGitHooks(noGit, { stripAiCoauthors: true });
      assert.equal(result.action, 'noop');
      assert.equal(result.result.reason, 'no-git');
    } finally {
      rmrf(noGit);
    }
  });

  it('reports noop when toggle OFF and hook never existed', () => {
    const result = gitHooks.syncGitHooks(projectPath, { stripAiCoauthors: false });
    assert.equal(result.action, 'noop');
    assert.equal(result.result.reason, 'absent');
  });

  it('reports noop when toggle ON but a foreign hook is installed', () => {
    const hookPath = path.join(projectPath, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hookPath, '#!/bin/sh\n# operator script\nexit 0\n', { mode: 0o755 });

    const result = gitHooks.syncGitHooks(projectPath, { stripAiCoauthors: true });
    assert.equal(result.action, 'noop');
    assert.equal(result.result.reason, 'foreign-hook');
  });
});
