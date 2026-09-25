'use strict';

/**
 * Managed pre-commit / pre-push control hooks (#1861) — defense in depth,
 * NEVER server enforcement.
 *
 * A HOLD cannot stop a `git commit` or `git push` an agent runs from its own
 * shell: TangleClaw is not in that path. These hooks narrow the gap for the
 * accidental case. They are bypassed by `--no-verify`, by changing
 * `core.hooksPath`, by deleting or editing the hook or the marker, by `GIT_DIR`
 * tricks, and by talking to GitHub directly with `gh` or `curl` under the
 * operator's shared credentials. `gh pr merge/ready` and `gh release` have no
 * local git hook at all. docs/control-state.md says the same.
 *
 * Deliberately separate from `lib/git-hooks.js`, whose `commit-msg` installer
 * keeps its own contract.
 *
 * Governed marker — machine-local, never committed:
 * - `<git-dir>/tangleclaw-control.json` = `{assignmentId, api}` for a governed
 *   checkout. `git rev-parse --git-dir` is per-worktree, so a linked worktree
 *   has its own.
 * - When the governed checkout is its clone's MAIN worktree, the same marker is
 *   written to the common git dir with `inheritToLinkedWorktrees: true`, so a
 *   worktree the Builder creates under its own checkout is in the same lane.
 * - A registered project that is itself a linked worktree of a governed clone
 *   gets an explicit `{ungoverned: true}` marker, so two projects sharing one
 *   clone stay isolated.
 * - No marker anywhere: the hook only runs any chained hook.
 *
 * Hooks live where git reads them (`git rev-parse --git-path hooks`), which
 * honours `core.hooksPath` and resolves linked worktrees to the common hooks
 * directory. A hooks path inside the work tree is tracked content (a `.husky/`
 * directory, say): TangleClaw never writes there, and reports the checkout
 * UNPROTECTED.
 *
 * A foreign hook is preserved and chained, never overwritten: it is renamed to
 * `<hook>.tc-chained` (a rename keeps its type, bytes or link target, and
 * mode), fingerprinted in a TangleClaw-owned sidecar in the hooks directory,
 * and `exec`ed by the dispatcher with the original arguments and stdin once the
 * control check passes, so its exit status and signal are its own. Install is
 * transactional: any failed step puts everything back. Uninstall restores only
 * a chained hook whose fingerprint still matches; anything else is refused with
 * the exact recovery steps, and nothing is overwritten.
 *
 * @module lib/control-hooks
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('control-hooks');

const HOOK_NAMES = Object.freeze(['pre-commit', 'pre-push']);
const MARKER_FILE = 'tangleclaw-control.json';
const SIDECAR_FILE = 'tangleclaw-control-hooks.json';
const CHAINED_SUFFIX = '.tc-chained';
const OWNED_LINE = '# TC-OWNED-HOOK: control-state';
const OWNED_RE = /^[ \t]*#[ \t]*TC-OWNED-HOOK:[ \t]*control-state\b/m;

/** Seams for tests: fault injection into the install sequence. */
const _internal = {
  rename: (from, to) => fs.renameSync(from, to),
  writeFile: (file, data, mode) => fs.writeFileSync(file, data, { mode })
};

/**
 * A refusal the caller can show verbatim.
 */
class HookError extends Error {
  /**
   * @param {string} code - Stable code
   * @param {string} message - What happened and how to recover
   */
  constructor(code, message) {
    super(message);
    this.name = 'HookError';
    this.code = code;
  }
}

/**
 * Run git in a checkout and return trimmed stdout.
 * @param {string} cwd - Checkout
 * @param {string[]} args - Arguments
 * @returns {string}
 */
function _git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Where git keeps this checkout's state and hooks.
 * @param {string} checkoutPath - A checkout (main or linked worktree)
 * @returns {{toplevel: string, gitDir: string, commonDir: string, hooksDir: string, isMainWorktree: boolean, hooksTracked: boolean}}
 */
function locate(checkoutPath) {
  const toplevel = fs.realpathSync(_git(checkoutPath, ['rev-parse', '--show-toplevel']));
  const gitDir = fs.realpathSync(path.resolve(checkoutPath, _git(checkoutPath, ['rev-parse', '--git-dir'])));
  const commonDir = fs.realpathSync(path.resolve(checkoutPath, _git(checkoutPath, ['rev-parse', '--git-common-dir'])));
  const hooksRaw = path.resolve(checkoutPath, _git(checkoutPath, ['rev-parse', '--git-path', 'hooks']));
  const hooksDir = fs.existsSync(hooksRaw) ? fs.realpathSync(hooksRaw) : hooksRaw;
  // Tracked when it sits inside the work tree but outside every git dir.
  const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  const hooksTracked = inside(hooksDir, toplevel) && !inside(hooksDir, gitDir) && !inside(hooksDir, commonDir);
  return { toplevel, gitDir, commonDir, hooksDir, isMainWorktree: gitDir === commonDir, hooksTracked };
}

/**
 * The dispatcher script for one hook.
 * @param {string} hookName - `pre-commit` or `pre-push`
 * @returns {string}
 */
function dispatcherScript(hookName) {
  const check = [
    "const fs=require('fs');",
    'const hook=process.argv[2];',
    "const fail=(m)=>{process.stderr.write('TangleClaw control: '+hook+' refused: '+m+'\\n');process.exit(1)};",
    'let m;try{m=JSON.parse(fs.readFileSync(process.argv[1],\'utf8\'))}catch(e){fail(\'the governed marker is unreadable, so this governed checkout fails closed\')}',
    'if(m.ungoverned===true)process.exit(0);',
    "if(typeof m.api!=='string'||typeof m.assignmentId!=='string')fail('the governed marker is incomplete, so this governed checkout fails closed');",
    "fetch(m.api.replace(/\\/+$/,'')+'/api/control/check?assignmentId='+encodeURIComponent(m.assignmentId),{signal:AbortSignal.timeout(5000)})",
    '.then(async(r)=>{const b=await r.json().catch(()=>null);',
    "if(!r.ok||!b)fail('control state could not be read (HTTP '+r.status+'), so this governed checkout fails closed');",
    "if(b.blocked===true)fail('this lane is '+String(b.code||b.state).toUpperCase()+' at generation '+b.stateGeneration+'. Run `tc control status`. (A hook is not enforcement; honour the hold even where it cannot reach.)');",
    'process.exit(0)})',
    ".catch(()=>fail('TangleClaw is unreachable, so this governed checkout fails closed'));"
  ].join('');
  return [
    '#!/bin/sh',
    OWNED_LINE,
    `# Managed by TangleClaw (#1861) for the ${hookName} hook. Defense in depth, NOT enforcement:`,
    '# --no-verify, a changed core.hooksPath, or deleting this file bypasses it. A hook that was',
    `# here before TangleClaw is kept beside it as ${hookName}${CHAINED_SUFFIX} and runs after the check.`,
    `hook_name='${hookName}'`,
    'hooks_dir=$(cd "$(dirname "$0")" && pwd)',
    'git_dir=$(git rev-parse --git-dir 2>/dev/null)',
    'common_dir=$(git rev-parse --git-common-dir 2>/dev/null)',
    'marker=""',
    `if [ -n "$git_dir" ] && [ -f "$git_dir/${MARKER_FILE}" ]; then`,
    `  marker="$git_dir/${MARKER_FILE}"`,
    `elif [ -n "$common_dir" ] && [ -f "$common_dir/${MARKER_FILE}" ] && grep -q '"inheritToLinkedWorktrees": *true' "$common_dir/${MARKER_FILE}"; then`,
    `  marker="$common_dir/${MARKER_FILE}"`,
    'fi',
    'if [ -n "$marker" ]; then',
    `  "\${TANGLECLAW_NODE:-node}" -e '${check.replace(/'/g, "'\\''")}' "$marker" "$hook_name" </dev/null || exit 1`,
    'fi',
    `chained="$hooks_dir/$hook_name${CHAINED_SUFFIX}"`,
    'if [ -x "$chained" ]; then',
    '  exec "$chained" "$@"',
    'fi',
    'exit 0',
    ''
  ].join('\n');
}

/**
 * The fingerprint of a path as `lstat` sees it.
 * @param {string} file - Path
 * @returns {{type: string, sha256?: string, linkTarget?: string, mode: number}|null} Null when absent
 */
function fingerprint(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) return { type: 'symlink', linkTarget: fs.readlinkSync(file), mode: st.mode & 0o7777 };
  if (st.isFile()) {
    return { type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mode: st.mode & 0o7777 };
  }
  return { type: 'other', mode: st.mode & 0o7777 };
}

/**
 * Whether two fingerprints describe the same artifact.
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
function _same(a, b) {
  return !!a && !!b && a.type === b.type && a.sha256 === b.sha256 && a.linkTarget === b.linkTarget && a.mode === b.mode;
}

/**
 * Whether a hook file is TangleClaw's dispatcher.
 * @param {string} file - Path
 * @returns {boolean}
 */
function _isOwned(file) {
  const fp = fingerprint(file);
  if (!fp || fp.type !== 'file') return false;
  return OWNED_RE.test(fs.readFileSync(file, 'utf8').slice(0, 512));
}

/**
 * Read the hooks-directory sidecar.
 * @param {string} hooksDir
 * @returns {Record<string, object>} hook name → recorded fingerprint of its chained hook
 */
function _readSidecar(hooksDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(hooksDir, SIDECAR_FILE), 'utf8')).chained || {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new HookError('SIDECAR_UNREADABLE', `${path.join(hooksDir, SIDECAR_FILE)} is unreadable (${err.message}); fix or remove it by hand before installing`);
  }
}

/**
 * Write the hooks-directory sidecar atomically.
 * @param {string} hooksDir
 * @param {Record<string, object>} chained
 * @returns {void}
 */
function _writeSidecar(hooksDir, chained) {
  const file = path.join(hooksDir, SIDECAR_FILE);
  if (Object.keys(chained).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ chained }, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/**
 * Install or refresh one hook's dispatcher, chaining a foreign hook.
 * @param {string} hooksDir
 * @param {string} hookName
 * @returns {string} `installed`, `refreshed`, `unchanged` or `chained`
 */
function _installHook(hooksDir, hookName) {
  const target = path.join(hooksDir, hookName);
  const chained = target + CHAINED_SUFFIX;
  const sidecar = _readSidecar(hooksDir);
  const script = dispatcherScript(hookName);
  const current = fingerprint(target);
  const chainedFp = fingerprint(chained);
  const recorded = sidecar[hookName] || null;

  if (chainedFp && !_same(chainedFp, recorded)) {
    throw new HookError('CHAINED_COLLISION',
      `${chained} exists but TangleClaw has no matching record of chaining it. Nothing was changed. `
      + `Inspect it; if it is yours, move it elsewhere, then install again.`);
  }

  if (current && current.type === 'file' && _isOwned(target)) {
    if (fs.readFileSync(target, 'utf8') === script) return 'unchanged';
    const tmp = `${target}.tc-tmp-${process.pid}`;
    _internal.writeFile(tmp, script, 0o755);
    _internal.rename(tmp, target);
    return 'refreshed';
  }

  if (current && current.type === 'other') {
    throw new HookError('HOOK_NOT_A_FILE', `${target} is neither a file nor a symlink. Nothing was changed.`);
  }

  // Stage the dispatcher first, so a failure before any rename leaves the
  // directory exactly as it was.
  const tmp = `${target}.tc-tmp-${process.pid}`;
  let movedForeign = false;
  try {
    _internal.writeFile(tmp, script, 0o755);
    if (current) {
      _internal.rename(target, chained);
      movedForeign = true;
    }
    _internal.rename(tmp, target);
    if (current) {
      _writeSidecar(hooksDir, { ...sidecar, [hookName]: fingerprint(chained) });
    }
  } catch (err) {
    // Put everything back: the dispatcher out, the foreign hook home.
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    try {
      if (movedForeign) {
        if (_isOwned(target)) fs.rmSync(target, { force: true });
        fs.renameSync(chained, target);
      } else if (!current && _isOwned(target)) {
        fs.rmSync(target, { force: true });
      }
    } catch (rollbackErr) {
      throw new HookError('ROLLBACK_FAILED',
        `Installing ${hookName} failed (${err.message}) and the rollback failed too (${rollbackErr.message}). `
        + `Restore by hand: if ${chained} exists, move it back to ${target}.`);
    }
    throw new HookError('INSTALL_FAILED', `Installing ${hookName} failed and was rolled back: ${err.message}`);
  }
  return current ? 'chained' : 'installed';
}

/**
 * Remove one hook's dispatcher, restoring a chained hook only when it is still
 * exactly what TangleClaw moved aside.
 * @param {string} hooksDir
 * @param {string} hookName
 * @returns {string} `absent`, `removed` or `restored`
 */
function _uninstallHook(hooksDir, hookName) {
  const target = path.join(hooksDir, hookName);
  const chained = target + CHAINED_SUFFIX;
  const sidecar = _readSidecar(hooksDir);
  const recorded = sidecar[hookName] || null;
  const current = fingerprint(target);
  if (!current && !fingerprint(chained)) return 'absent';
  if (!current || !_isOwned(target)) {
    throw new HookError('NOT_OWNED',
      `${target} is not TangleClaw's dispatcher, so it was left alone.`
      + (fingerprint(chained) ? ` A chained hook is still at ${chained}; restore it by hand if you want it back.` : ''));
  }
  const chainedFp = fingerprint(chained);
  if (chainedFp) {
    if (!_same(chainedFp, recorded)) {
      throw new HookError('CHAINED_MODIFIED',
        `${chained} changed after TangleClaw chained it, so nothing was overwritten. `
        + `To finish by hand: rm ${target} && mv ${chained} ${target}`);
    }
    fs.rmSync(target);
    fs.renameSync(chained, target);
    const rest = { ...sidecar };
    delete rest[hookName];
    _writeSidecar(hooksDir, rest);
    return 'restored';
  }
  fs.rmSync(target);
  return 'removed';
}

/**
 * Write a marker file atomically.
 * @param {string} dir - Git dir
 * @param {object} body - Marker contents
 * @returns {void}
 */
function _writeMarker(dir, body) {
  const file = path.join(dir, MARKER_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Mark a checkout governed and install its hooks. A tracked hooks path is left
 * untouched and reported UNPROTECTED; the marker is still written, so the
 * state is visible.
 * @param {string} checkoutPath - The project's checkout
 * @param {{assignmentId: string, api: string}} marker
 * @returns {{protected: boolean, reason: (string|null), hooks: Record<string, string>}}
 */
function install(checkoutPath, marker) {
  const where = locate(checkoutPath);
  const body = { assignmentId: marker.assignmentId, api: marker.api };
  _writeMarker(where.gitDir, body);
  if (where.isMainWorktree) {
    // gitDir === commonDir: the same file, now also inherited by worktrees the
    // Builder creates under this checkout.
    _writeMarker(where.commonDir, { ...body, inheritToLinkedWorktrees: true });
  }
  if (where.hooksTracked) {
    log.warn('Control hooks not installed: the hooks path is tracked content', { checkout: where.toplevel });
    return { protected: false, reason: 'UNPROTECTED (tracked hooksPath)', hooks: {} };
  }
  fs.mkdirSync(where.hooksDir, { recursive: true });
  const hooks = {};
  for (const name of HOOK_NAMES) hooks[name] = _installHook(where.hooksDir, name);
  return { protected: true, reason: null, hooks };
}

/**
 * Mark a checkout ungoverned. Its hooks stay installed and become a
 * pass-through; a linked worktree gets an explicit ungoverned marker so it
 * does not inherit its clone's lane.
 * @param {string} checkoutPath
 * @returns {void}
 */
function unmark(checkoutPath) {
  let where;
  try {
    where = locate(checkoutPath);
  } catch (err) {
    return; // not a git checkout: nothing to mark
  }
  if (where.isMainWorktree) {
    fs.rmSync(path.join(where.gitDir, MARKER_FILE), { force: true });
    return;
  }
  const common = path.join(where.commonDir, MARKER_FILE);
  if (fs.existsSync(common)) _writeMarker(where.gitDir, { ungoverned: true });
  else fs.rmSync(path.join(where.gitDir, MARKER_FILE), { force: true });
}

/**
 * Remove the dispatchers from a checkout's hooks directory, restoring chained
 * hooks. Refuses per hook rather than overwrite anything it did not write.
 * @param {string} checkoutPath
 * @returns {Record<string, string>} Per-hook outcome
 */
function uninstall(checkoutPath) {
  const where = locate(checkoutPath);
  if (where.hooksTracked) return {};
  const out = {};
  for (const name of HOOK_NAMES) out[name] = _uninstallHook(where.hooksDir, name);
  return out;
}

/**
 * What the hooks look like for a checkout, for status displays.
 * @param {string} checkoutPath
 * @returns {{governed: boolean, protected: boolean, reason: (string|null), hooks: Record<string, string>}}
 */
function status(checkoutPath) {
  const where = locate(checkoutPath);
  const own = path.join(where.gitDir, MARKER_FILE);
  let governed = false;
  try {
    const m = JSON.parse(fs.readFileSync(own, 'utf8'));
    governed = m.ungoverned !== true;
  } catch { /* no marker of its own */ }
  if (!governed && !where.isMainWorktree) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(where.commonDir, MARKER_FILE), 'utf8'));
      governed = c.inheritToLinkedWorktrees === true && !fs.existsSync(own);
    } catch { /* none */ }
  }
  if (where.hooksTracked) return { governed, protected: false, reason: 'UNPROTECTED (tracked hooksPath)', hooks: {} };
  const hooks = {};
  for (const name of HOOK_NAMES) {
    const file = path.join(where.hooksDir, name);
    hooks[name] = !fingerprint(file) ? 'absent' : (_isOwned(file) ? (fingerprint(file + CHAINED_SUFFIX) ? 'installed+chained' : 'installed') : 'foreign');
  }
  const allInstalled = HOOK_NAMES.every((n) => hooks[n].startsWith('installed'));
  return { governed, protected: allInstalled, reason: allInstalled ? null : 'UNPROTECTED (hooks not installed)', hooks };
}

module.exports = {
  HOOK_NAMES,
  MARKER_FILE,
  SIDECAR_FILE,
  CHAINED_SUFFIX,
  HookError,
  locate,
  dispatcherScript,
  fingerprint,
  install,
  unmark,
  uninstall,
  status,
  _internal
};
