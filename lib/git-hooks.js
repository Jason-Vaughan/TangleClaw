'use strict';

/**
 * TangleClaw git-hooks installer (#247).
 *
 * Parallel to `engines.syncEngineHooks` for Claude Code's settings.json
 * hooks, but operates on `<project>/.git/hooks/` shell scripts instead.
 * Single responsibility today: install/uninstall the `commit-msg` hook
 * that strips AI co-author trailers when `config.stripAiCoauthors` is on.
 *
 * Drift-aware uninstall: the installed hook embeds a `TC-OWNED-HOOK:`
 * marker. Uninstall only removes the file when that marker is present,
 * so operator hand-edits (or third-party commit-msg hooks like commitlint)
 * are preserved with a warning instead of clobbered.
 */

const fs = require('node:fs');
const path = require('node:path');

const { createLogger } = require('./logger');
const log = createLogger('git-hooks');

const TC_HOOK_MARKER = 'TC-OWNED-HOOK: strip-ai-coauthors';

// Single canonical source for the hook script content. Resolved lazily so
// tests can override the source path before first use.
let _sourceScriptPath = path.join(__dirname, '..', 'data', 'hooks', 'strip-ai-coauthors.sh');

/**
 * Override the source script path. Test-only.
 * @param {string|null} p - Path or null to reset to default.
 */
function __setSourceScriptPath(p) {
  _sourceScriptPath = p || path.join(__dirname, '..', 'data', 'hooks', 'strip-ai-coauthors.sh');
}

/**
 * Read the hook script content from the shipped data/hooks/ source.
 * @returns {string|null} Content or null if the source file is missing.
 */
function _readHookSource() {
  try {
    return fs.readFileSync(_sourceScriptPath, 'utf8');
  } catch (err) {
    log.warn('Could not read hook source script', { path: _sourceScriptPath, error: err.message });
    return null;
  }
}

/**
 * Path to a project's commit-msg hook file. Returns null if the project
 * isn't a git repo with a real `.git/` directory.
 *
 * Worktrees, submodules, and symlinked-`.git` setups are treated as
 * no-git in v1: in each case the path looks git-like but the hook
 * directory lives elsewhere (parent worktree, submodule gitdir, or the
 * symlink target) and writing into it would either silently miss the
 * operator's actual workflow or clobber state owned by another
 * checkout. `lstatSync` is the load-bearing call — `statSync` would
 * follow the symlink and report `isDirectory() === true`, defeating
 * the carve-out.
 *
 * @param {string} projectPath - Absolute project root path.
 * @returns {string|null}
 */
function _hookPath(projectPath) {
  const gitDir = path.join(projectPath, '.git');
  let stat;
  try {
    stat = fs.lstatSync(gitDir);
  } catch (_) {
    return null; // .git missing or unreadable
  }
  // Reject symlinks and non-directory file types (worktree/submodule
  // pointer file). Only a real on-disk directory is in scope for v1.
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  return path.join(gitDir, 'hooks', 'commit-msg');
}

// Critic-driven (#247 hardening): require the marker to anchor at start
// of line within the first 20 lines of the file. Without the anchor, a
// foreign hook whose docstring/comment merely mentions the marker text
// (e.g. "this hook coexists with a TC-OWNED-HOOK: strip-ai-coauthors
// sibling") would be misclassified as TC-owned and clobbered.
const TC_HOOK_MARKER_LINE_RE = /^[ \t]*#[ \t]*TC-OWNED-HOOK:[ \t]*strip-ai-coauthors\b/m;
const _HEADER_LINE_LIMIT = 20;

/**
 * Return true when the file content carries TC's ownership marker as a
 * comment at start-of-line within the first ${_HEADER_LINE_LIMIT} lines.
 * Substring matches deeper in the file or inside string literals do NOT
 * count — foreign hooks that mention the marker text in passing pass
 * through the install/uninstall guards untouched.
 * @param {string} content
 * @returns {boolean}
 */
function _isTcOwnedHook(content) {
  if (typeof content !== 'string') return false;
  const head = content.split('\n', _HEADER_LINE_LIMIT).join('\n');
  return TC_HOOK_MARKER_LINE_RE.test(head);
}

/**
 * Install the commit-msg hook into the project.
 *
 * - No-op when project isn't a git repo (returns `{ installed: false, reason: 'no-git' }`).
 * - When `.git/hooks/commit-msg` exists and is NOT TC-owned: leaves it
 *   alone and returns `{ installed: false, reason: 'foreign-hook',
 *   existingPath }`. Operators can `mv` the file aside and call install
 *   again, or chain manually.
 * - When the hook is already TC-owned and content matches: returns
 *   `{ installed: true, reason: 'idempotent' }`.
 * - When the hook is TC-owned but content has drifted (new version
 *   shipped): overwrites in place and returns `{ installed: true,
 *   reason: 'refreshed' }`.
 *
 * @param {string} projectPath
 * @returns {{ installed: boolean, reason: string, existingPath?: string, error?: string }}
 */
function installCommitMsgHook(projectPath) {
  const hookPath = _hookPath(projectPath);
  if (!hookPath) return { installed: false, reason: 'no-git' };

  const source = _readHookSource();
  if (source === null) return { installed: false, reason: 'source-missing' };

  try {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  } catch (err) {
    return { installed: false, reason: 'mkdir-failed', error: err.message };
  }

  if (fs.existsSync(hookPath)) {
    let existing;
    try {
      existing = fs.readFileSync(hookPath, 'utf8');
    } catch (err) {
      return { installed: false, reason: 'read-failed', error: err.message };
    }
    if (!_isTcOwnedHook(existing)) {
      log.warn('Existing commit-msg hook is not TC-owned; skipping install to avoid clobbering operator/third-party hook', {
        project: projectPath, hookPath
      });
      return { installed: false, reason: 'foreign-hook', existingPath: hookPath };
    }
    if (existing === source) {
      return { installed: true, reason: 'idempotent' };
    }
    // TC-owned but drifted (older version shipped, or operator added the
    // marker to a custom script). Refreshes are the intended path for
    // shipping updated hook content, but per the #240 `writeEngineConfig`
    // contract — operator hand-edits to a TC-managed file deserve a
    // visibility log BEFORE clobber. The marker is the operator's opt-in
    // to TC management; once they edit the body, the warning is the only
    // breadcrumb that explains where their change went.
    log.warn('TC-owned commit-msg hook drifted from shipped content; refreshing (operator edits will be overwritten)', {
      project: projectPath,
      hookPath
    });
  }

  // Write via tmp + atomic rename so a SIGKILL between the open() and
  // close() can't leave a half-written commit-msg hook that fails on
  // every subsequent `git commit` with "cannot exec hook". The chmod is
  // load-bearing on the refresh path because `writeFileSync`'s `mode`
  // option only applies on file CREATE, not overwrite — Node preserves
  // the existing inode's mode on rewrite. Same dir = same filesystem =
  // atomic rename guaranteed.
  const tmpPath = `${hookPath}.tcwrite.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, source, { mode: 0o755 });
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, hookPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* tmp already gone */ }
    return { installed: false, reason: 'write-failed', error: err.message };
  }
  return { installed: true, reason: 'refreshed' };
}

/**
 * Uninstall the commit-msg hook.
 *
 * - Removes ONLY when the on-disk file is TC-owned (carries the marker).
 *   Foreign hooks and operator hand-edits are preserved.
 * - No-op when project isn't a git repo or the hook isn't present.
 *
 * @param {string} projectPath
 * @returns {{ uninstalled: boolean, reason: string, error?: string }}
 */
function uninstallCommitMsgHook(projectPath) {
  const hookPath = _hookPath(projectPath);
  if (!hookPath) return { uninstalled: false, reason: 'no-git' };
  if (!fs.existsSync(hookPath)) return { uninstalled: false, reason: 'absent' };

  let existing;
  try {
    existing = fs.readFileSync(hookPath, 'utf8');
  } catch (err) {
    return { uninstalled: false, reason: 'read-failed', error: err.message };
  }
  if (!_isTcOwnedHook(existing)) {
    log.warn('commit-msg hook is not TC-owned; refusing to remove', { project: projectPath, hookPath });
    return { uninstalled: false, reason: 'foreign-hook' };
  }

  try {
    fs.unlinkSync(hookPath);
  } catch (err) {
    return { uninstalled: false, reason: 'unlink-failed', error: err.message };
  }
  return { uninstalled: true, reason: 'removed' };
}

/**
 * Sync TC-managed git hooks for a project against the current global config.
 *
 * Called from every project-lifecycle site that mutates hook-relevant state
 * (create, attach, sync-all, engine/methodology PATCH, session launch),
 * mirroring the call graph of `engines.syncEngineHooks`. Per
 * `feedback_symmetric_capability_gates`, this needs to be invoked everywhere
 * the engine-hook sync is — asymmetric gates leak orphan hook state.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {object} config - The global TC config (already merged with defaults).
 * @returns {{ action: 'installed'|'uninstalled'|'noop', result: object }}
 */
function syncGitHooks(projectPath, config) {
  // Default ON. The only way to opt OUT is an explicit
  // `config.stripAiCoauthors === false`. Null/undefined/omitted field all
  // resolve to ON so older config files and defensive callers get the new
  // behaviour automatically. Production callers always pass a config
  // loaded through `store.config.load()` which has DEFAULT_CONFIG fallback;
  // null is a defensive-call path only.
  const enabled = !config || config.stripAiCoauthors !== false;
  if (enabled) {
    const result = installCommitMsgHook(projectPath);
    return { action: result.installed ? 'installed' : 'noop', result };
  }
  const result = uninstallCommitMsgHook(projectPath);
  return { action: result.uninstalled ? 'uninstalled' : 'noop', result };
}

module.exports = {
  syncGitHooks,
  installCommitMsgHook,
  uninstallCommitMsgHook,
  TC_HOOK_MARKER,
  __setSourceScriptPath // test-only
};
