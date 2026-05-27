'use strict';

/**
 * TangleClaw global git template installer (#252).
 *
 * Companion to `lib/git-hooks.js` (#247) which only covers TC-managed
 * projects. This module installs the same `strip-ai-coauthors.sh`
 * commit-msg hook into a TC-owned git template directory and points
 * `git config --global init.templateDir` at it, so every `git init` or
 * `git clone` on the host picks up the hook — including repos created
 * outside of `~/Documents/Projects` that TC has no visibility into.
 *
 * Three-case `init.templateDir` detection:
 *   1. Unset            → set to TC's path, write sentinel.
 *   2. Already TC path  → no-op (refresh hook content if drifted).
 *   3. Non-TC path      → log.warn, do NOT clobber, do NOT write sentinel.
 *
 * Drift-aware toggle-off: revert `init.templateDir` ONLY when the sentinel
 * confirms TC owned the value. Operator-set custom values are preserved.
 *
 * Limitation: `init.templateDir` only fires on `git init` / `git clone`.
 * Repos already on disk don't auto-acquire the hook. Two follow-ups
 * (out of scope for v1): a `TC Setup > Apply hook to all git repos`
 * sweep, and extending the unregistered-repo surface to suggest the
 * sweep.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { createLogger } = require('./logger');
const log = createLogger('git-template');

// Reuse the same source script the per-project installer ships, so the
// template-side hook and the per-project hook stay byte-for-byte
// identical. A future hook update lands in one place.
let _sourceScriptPath = path.join(__dirname, '..', 'data', 'hooks', 'strip-ai-coauthors.sh');
let _templateDir = path.join(os.homedir() || '', '.tangleclaw', 'git-template');

/**
 * Override the source script path. Test-only.
 * @param {string|null} p
 */
function __setSourceScriptPath(p) {
  _sourceScriptPath = p || path.join(__dirname, '..', 'data', 'hooks', 'strip-ai-coauthors.sh');
}

/**
 * Override the template directory root. Test-only.
 * @param {string|null} p
 */
function __setTemplateDir(p) {
  _templateDir = p || path.join(os.homedir() || '', '.tangleclaw', 'git-template');
}

/**
 * Current template directory root (test-aware).
 * @returns {string}
 */
function getTemplateDir() {
  return _templateDir;
}

function _hookPath() {
  return path.join(_templateDir, 'hooks', 'commit-msg');
}

function _sentinelPath() {
  // Sits at the template-dir root, NOT inside `hooks/`, so it isn't
  // copied into init'd repos as a stray dotfile in their `.git/hooks/`.
  // `git init --template` copies the contents of the template dir into
  // the repo's `.git/`, so a root-level sentinel becomes `.git/.tc-...`
  // — operator-visible but harmless. Placing it inside `hooks/` would
  // pollute every new repo's hook directory.
  return path.join(_templateDir, '.tc-init-templatedir-owned');
}

function _readHookSource() {
  try {
    return fs.readFileSync(_sourceScriptPath, 'utf8');
  } catch (err) {
    log.warn('Could not read hook source script', { path: _sourceScriptPath, error: err.message });
    return null;
  }
}

/**
 * Read `git config --global init.templateDir`. Returns null when the
 * value is unset (git exits 1 with no output) or when the git binary
 * itself is missing. Distinguishing the two cases isn't useful for v1
 * — both produce the same install decision (proceed as if unset).
 * @returns {string|null}
 */
function _readGlobalTemplateDir() {
  try {
    const out = execFileSync('git', ['config', '--global', '--get', 'init.templateDir'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

/**
 * Set `git config --global init.templateDir`. Returns true on success.
 * @param {string} dir
 * @returns {boolean}
 */
function _setGlobalTemplateDir(dir) {
  try {
    execFileSync('git', ['config', '--global', 'init.templateDir', dir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
    return true;
  } catch (err) {
    log.warn('Failed to set git global init.templateDir', { dir, error: err.message });
    return false;
  }
}

/**
 * Unset `git config --global init.templateDir`. Returns true on success
 * or when the value was already absent (exit 5 — `--unset` of a missing
 * key). Other failures return false.
 * @returns {boolean}
 */
function _unsetGlobalTemplateDir() {
  try {
    execFileSync('git', ['config', '--global', '--unset', 'init.templateDir'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
    return true;
  } catch (err) {
    // git config --unset exits 5 when the key is already absent. That's
    // the success case for an idempotent uninstall.
    if (err.status === 5) return true;
    log.warn('Failed to unset git global init.templateDir', { error: err.message });
    return false;
  }
}

/**
 * Compare two absolute paths for equality, tolerant of trailing slashes
 * and `~` expansion. Both inputs are resolved before comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir() || '~'));
  return norm(a) === norm(b);
}

function _writeSentinel() {
  try {
    fs.mkdirSync(_templateDir, { recursive: true });
    fs.writeFileSync(_sentinelPath(), `TC owns init.templateDir\n${new Date().toISOString()}\n`);
    return true;
  } catch (err) {
    log.warn('Failed to write template ownership sentinel', { error: err.message });
    return false;
  }
}

function _hasSentinel() {
  try {
    return fs.statSync(_sentinelPath()).isFile();
  } catch (_) {
    return false;
  }
}

function _removeSentinel() {
  try {
    fs.unlinkSync(_sentinelPath());
  } catch (_) { /* already gone */ }
}

/**
 * Install the commit-msg hook into the global template directory and,
 * conditionally, point `init.templateDir` at it.
 *
 * Return shape mirrors `lib/git-hooks.js#installCommitMsgHook` for
 * call-site symmetry.
 *
 * @returns {{ installed: boolean, reason: string, templateDirAction?: string, existingValue?: string, error?: string }}
 */
function installGlobalTemplate() {
  const source = _readHookSource();
  if (source === null) return { installed: false, reason: 'source-missing' };

  const hookPath = _hookPath();
  try {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  } catch (err) {
    return { installed: false, reason: 'mkdir-failed', error: err.message };
  }

  // Write hook content atomically. Same tmp-then-rename pattern used by
  // the per-project installer — a SIGKILL between open() and close()
  // can't leave a half-written hook script. Refresh detection: if the
  // file already exists and matches byte-for-byte, skip the write (no
  // mtime churn, no inode flip).
  let hookAction = 'refreshed';
  if (fs.existsSync(hookPath)) {
    try {
      const existing = fs.readFileSync(hookPath, 'utf8');
      if (existing === source) {
        hookAction = 'idempotent';
      }
    } catch (_) { /* fall through to refresh */ }
  }
  if (hookAction === 'refreshed') {
    const tmpPath = `${hookPath}.tcwrite.${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, source, { mode: 0o755 });
      fs.chmodSync(tmpPath, 0o755);
      fs.renameSync(tmpPath, hookPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* tmp already gone */ }
      return { installed: false, reason: 'write-failed', error: err.message };
    }
  }

  // Now decide whether to set git's global init.templateDir.
  const currentValue = _readGlobalTemplateDir();
  let templateDirAction;
  if (!currentValue) {
    if (!_setGlobalTemplateDir(_templateDir)) {
      // Hook is written but git-config failed. Don't write the sentinel;
      // a later retry can complete the install. Callers see `installed:
      // true` because the hook itself is on disk and a future
      // operator-run `git config --global init.templateDir <ours>` would
      // light it up. Surface the partial state in the return value so
      // the toggle handler can decide whether to warn.
      templateDirAction = 'set-failed';
    } else if (!_writeSentinel()) {
      // Critic-driven (#252 review, Finding 1 — orphan state). We
      // claimed `init.templateDir` but couldn't write the sentinel that
      // authorizes future revert. Without the sentinel, uninstall would
      // leave the value stranded forever (the `_hasSentinel()` guard
      // forbids revert). Roll back the config set to keep state
      // consistent: a future install retry can re-attempt cleanly. This
      // is the same orphan-state pattern `feedback_symmetric_capability_gates`
      // protects against — every state-mutation pair (set + sentinel)
      // must be all-or-nothing.
      _unsetGlobalTemplateDir();
      templateDirAction = 'sentinel-failed';
    } else {
      templateDirAction = 'set';
    }
  } else if (_samePath(currentValue, _templateDir)) {
    // Already pointing at us. Make sure the sentinel is current so a
    // future toggle-off can revert cleanly — operator may have set the
    // value to our path manually before TC ever owned it, but once TC
    // confirms the value matches, claiming ownership is safe (revert
    // would just restore the natural "set to TC's path" state anyway).
    if (!_hasSentinel()) _writeSentinel();
    templateDirAction = 'already-ours';
  } else {
    // Operator-set custom path. Do NOT clobber and do NOT write the
    // sentinel — the operator owns the value and TC must not assume
    // permission to revert it later. Surface a one-time warn so the
    // operator can see WHY the global enforcement isn't fully active.
    log.warn('git config --global init.templateDir already set to a non-TC path; global template install skipped (per-project hooks still work)', {
      existingValue: currentValue, tcPath: _templateDir
    });
    templateDirAction = 'foreign';
  }

  return { installed: true, reason: hookAction, templateDirAction, existingValue: currentValue || undefined };
}

/**
 * Uninstall the commit-msg hook from the global template directory and,
 * if the sentinel confirms TC ownership, revert `init.templateDir`.
 *
 * @returns {{ uninstalled: boolean, reason: string, templateDirAction?: string, error?: string }}
 */
function uninstallGlobalTemplate() {
  const hookPath = _hookPath();
  let hookAction = 'absent';
  if (fs.existsSync(hookPath)) {
    try {
      fs.unlinkSync(hookPath);
      hookAction = 'removed';
    } catch (err) {
      return { uninstalled: false, reason: 'unlink-failed', error: err.message };
    }
  }

  let templateDirAction = 'left-alone';
  if (_hasSentinel()) {
    // Only revert when the sentinel confirms TC owned the value. If the
    // operator changed the value out from under us in between install
    // and uninstall, the sentinel is still there but the current value
    // is theirs — leave it alone in that case too.
    const currentValue = _readGlobalTemplateDir();
    if (currentValue && _samePath(currentValue, _templateDir)) {
      if (_unsetGlobalTemplateDir()) {
        templateDirAction = 'unset';
      } else {
        templateDirAction = 'unset-failed';
      }
    } else {
      templateDirAction = 'value-changed-by-operator';
    }
    _removeSentinel();
  }

  return { uninstalled: true, reason: hookAction, templateDirAction };
}

/**
 * Sync the global git template against current config. Mirrors
 * `lib/git-hooks.js#syncGitHooks` semantics: default ON when the field
 * is omitted, only OFF when explicitly `false`.
 *
 * @param {object|null} config
 * @returns {{ action: 'installed'|'uninstalled', result: object }}
 */
function syncGlobalTemplate(config) {
  const enabled = !config || config.stripAiCoauthors !== false;
  if (enabled) {
    const result = installGlobalTemplate();
    return { action: 'installed', result };
  }
  const result = uninstallGlobalTemplate();
  return { action: 'uninstalled', result };
}

module.exports = {
  syncGlobalTemplate,
  installGlobalTemplate,
  uninstallGlobalTemplate,
  getTemplateDir,
  __setSourceScriptPath, // test-only
  __setTemplateDir       // test-only
};
