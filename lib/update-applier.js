'use strict';

/**
 * UB (#228 / #229) — the self-update ACTION. Detect/notify already ship
 * (`lib/update-checker.js` → the update pill); restart already ships
 * (`lib/server-info.js` → `POST /api/server/restart`). This module fills the
 * one gap between them: fetch the latest release tag and move the checkout to
 * it, with safety guards that fail closed. It deliberately does **not** restart
 * — the route chains the existing restart path on success, so the proven
 * flush-202-then-kill dance lives in exactly one place.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createLogger } = require('./logger');
const updateChecker = require('./update-checker');

const log = createLogger('update-applier');

const REPO_DIR = path.join(__dirname, '..');

/**
 * Injection seam (mirrors `server-info._internal`) so tests drive every guard
 * without a real repo. `git` runs argv-form (NOT a shell string) so a tag ref
 * from `origin` can never inject — the ref is an argv element, never parsed by
 * a shell.
 */
const _internal = {
  git: (args) => execFileSync('git', args, {
    cwd: REPO_DIR, timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  }),
  checkForUpdate: () => updateChecker.checkForUpdate()
};

/**
 * Run a git subcommand in the repo dir and return trimmed stdout.
 * @param {...string} args - git argv (e.g. 'rev-parse', 'HEAD')
 * @returns {string}
 */
function _git(...args) {
  return _internal.git(args).trim();
}

/**
 * Build a refused-guard result.
 * @param {string} code - Stable machine code (e.g. 'dirty-tree')
 * @param {string} error - Human-readable reason
 * @param {string|null} [fromSha] - Pre-update HEAD sha when known
 * @returns {{ok: false, code: string, error: string, fromSha: string|null, toRef: null, toSha: null}}
 */
function _fail(code, error, fromSha = null) {
  return { ok: false, code, error, fromSha, toRef: null, toSha: null };
}

/**
 * Decide whether HEAD is in an updatable state (Decision A). Allowed:
 * on `main`, or detached exactly at a release tag (a prior UB checkout).
 * Refused: a feature branch, or a detached HEAD not sitting on a release tag —
 * so an update can never silently move a dev's working branch.
 * @returns {{ updatable: boolean, ref: string|null }}
 */
function _headState() {
  const branch = _git('rev-parse', '--abbrev-ref', 'HEAD'); // 'main' or 'HEAD' (detached)
  if (branch === 'main') return { updatable: true, ref: 'main' };
  if (branch === 'HEAD') {
    try {
      const tag = _git('describe', '--exact-match', '--tags', 'HEAD');
      if (/^v?\d+\.\d+\.\d+/.test(tag)) return { updatable: true, ref: tag };
    } catch { /* not exactly at a tag — fall through to refused */ }
  }
  return { updatable: false, ref: branch };
}

/**
 * Apply the latest available release: fetch tags and `git checkout <latest tag>`.
 * Each guard fails closed; never restarts (the caller chains the restart route).
 *
 * @returns {{ok: boolean, code: string|null, error: string|null, fromSha: string|null, toRef: string|null, toSha: string|null}}
 */
function applyUpdate() {
  let fromSha = null;

  // 1. Guard — is a git checkout at all.
  try {
    fromSha = _git('rev-parse', 'HEAD');
  } catch {
    return _fail('no-git', 'not a git checkout — cannot self-update');
  }

  try {
    // 2. Guard — an update is actually available (no silent no-op).
    const status = _internal.checkForUpdate();
    if (!status || !status.updateAvailable || !status.latestVersion) {
      return _fail('no-update', 'already up to date — no newer release available', fromSha);
    }

    // 3. Guard — clean working tree (never clobber local changes).
    if (_git('status', '--porcelain')) {
      return _fail('dirty-tree', 'local changes present — commit or stash before updating', fromSha);
    }

    // 4. Guard — HEAD is on an updatable ref (main, or detached at a release tag).
    const head = _headState();
    if (!head.updatable) {
      return _fail('wrong-ref', `refusing to update from "${head.ref}" — checkout main (or a release tag) first`, fromSha);
    }

    // 5. Fetch the latest tags.
    _git('fetch', '--tags', 'origin');

    // 6. Resolve + checkout the latest release tag (Decision A).
    const latestTag = updateChecker.findLatestVersion(
      updateChecker.parseTagsOutput(_git('ls-remote', '--tags', 'origin'))
    );
    if (!latestTag) {
      return _fail('no-tag', 'no release tag found on origin', fromSha);
    }
    _git('checkout', latestTag);

    const toSha = _git('rev-parse', 'HEAD');
    log.info(`Update applied: ${fromSha.slice(0, 7)} → ${latestTag} (${toSha.slice(0, 7)}); restart pending`);
    return { ok: true, code: null, error: null, fromSha, toRef: latestTag, toSha };
  } catch (err) {
    // A git failure mid-flow (fetch/checkout) — report with the pre-update sha
    // so recovery is a one-line `git checkout <fromSha>`.
    log.warn('Update apply failed', { error: err.message, fromSha });
    return { ok: false, code: 'git-error', error: err.message, fromSha, toRef: null, toSha: null };
  }
}

module.exports = { applyUpdate, _internal, _headState };
