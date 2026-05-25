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
 * isn't a git repo (no `.git/` dir present).
 * @param {string} projectPath - Absolute project root path.
 * @returns {string|null}
 */
function _hookPath(projectPath) {
  const gitDir = path.join(projectPath, '.git');
  if (!fs.existsSync(gitDir)) return null;
  // Worktrees and submodules use a file `.git` pointing at gitdir — not
  // supported in v1; treat as no-git so we don't try to write into a
  // shared gitdir. Future: parse gitdir pointer.
  try {
    const stat = fs.statSync(gitDir);
    if (!stat.isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return path.join(gitDir, 'hooks', 'commit-msg');
}

/**
 * Return true when the file content carries TC's hook marker.
 * @param {string} content
 * @returns {boolean}
 */
function _isTcOwnedHook(content) {
  return typeof content === 'string' && content.indexOf(TC_HOOK_MARKER) !== -1;
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
    // TC-owned but drifted (older version shipped, or operator added a marker
    // to a custom script). Overwrite — drift on a TC-owned hook is fine to
    // refresh because the marker is the operator's opt-in to TC management.
  }

  try {
    fs.writeFileSync(hookPath, source, { mode: 0o755 });
    fs.chmodSync(hookPath, 0o755); // Force perms in case writeFile honoured umask.
  } catch (err) {
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
