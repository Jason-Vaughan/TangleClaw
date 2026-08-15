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
  checkForUpdate: () => updateChecker.checkForUpdate(),
  // `npm ci --omit=dev` in the repo, argv-form like `git` above. The PATH is
  // prepended with the running node's own directory because the launchd
  // service's PATH is not a login shell's — on a Homebrew install npm lives
  // beside node, and "npm not found under launchd" would otherwise be the
  // provisioning step's first field failure. Ten-minute timeout: a cold cache
  // install is minutes, and a hung registry should fail the update rather
  // than wedge the request forever.
  npmCi: () => execFileSync('npm', ['ci', '--omit=dev'], {
    cwd: REPO_DIR, timeout: 600000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '')
    })
  })
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
  // Log every refusal — a safety-relevant git-mutation endpoint should leave a
  // server-side trail that an update was attempted and why it was declined.
  log.info('Update apply refused', { code, error });
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
 * Apply the latest available release: fetch tags, `git checkout <latest tag>`,
 * then provision what the checkout alone does not move (#711 chunk 01).
 * Each guard fails closed; never restarts (the caller chains the restart route).
 *
 * Provisioning, precisely:
 * - `npm ci --omit=dev` runs ONLY when `package-lock.json` changed between the
 *   two shas — most releases ship no dependency change and skip it entirely.
 *   Without this, a dependency-bumping release ran new code against old
 *   `node_modules` and died at require-time after the restart, with no visible
 *   connection to the update the operator just clicked.
 * - Changed deploy assets (anything under `deploy/`: launchd plists,
 *   tmux.conf, install.sh) are DETECTED AND REPORTED, never auto-applied:
 *   re-running install.sh reloads launchd services, and a node without Full
 *   Disk Access on a repo under ~/Documents hangs the server silently (#324).
 *   The response names what changed so the operator can act; silence was the
 *   defect.
 * - If the dependency install fails, the result is `provision-failed` with the
 *   tree left at the new tag and the running process untouched — the caller
 *   must NOT restart. Automatic rollback is chunk 02 of the #711 plan; until
 *   it lands the error text carries the one-line manual recovery.
 *
 * @returns {{ok: boolean, code: string|null, error: string|null,
 *   fromSha: string|null, toRef: string|null, toSha: string|null,
 *   provisioning?: {lockfileChanged: boolean, npmCi: 'ran'|'skipped',
 *   assetsChanged: string[], assetsAction: 'manual'|null}}}
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

    // 7. Provision what the checkout did not move (#711 chunk 01).
    const changed = _git('diff', '--name-only', fromSha, toSha).split('\n').filter(Boolean);
    const lockfileChanged = changed.includes('package-lock.json');
    if (lockfileChanged) {
      try {
        log.info('Dependencies changed with this release — running npm ci', {
          fromSha: fromSha.slice(0, 7), toRef: latestTag
        });
        _internal.npmCi();
      } catch (err) {
        // The tree is at the new tag with the OLD node_modules; the running
        // process is untouched and keeps serving the previous version. The
        // caller must not restart onto this half-provisioned state.
        log.warn('Update provisioning failed — dependency install did not complete', {
          error: err.message, fromSha, toRef: latestTag
        });
        return {
          ok: false,
          code: 'provision-failed',
          error: `checked out ${latestTag}, but installing its dependencies failed: `
            + `${err.message}. The server was NOT restarted and keeps running the previous `
            + `version. Recover with \`git checkout ${fromSha.slice(0, 7)}\`, or fix the `
            + 'install (network, disk) and update again.',
          fromSha, toRef: latestTag, toSha
        };
      }
    }
    const assetsChanged = changed.filter((f) => f.startsWith('deploy/'));
    const provisioning = {
      lockfileChanged,
      npmCi: lockfileChanged ? 'ran' : 'skipped',
      assetsChanged,
      assetsAction: assetsChanged.length ? 'manual' : null
    };

    log.info(`Update applied: ${fromSha.slice(0, 7)} → ${latestTag} (${toSha.slice(0, 7)}); restart pending`, { provisioning });
    return { ok: true, code: null, error: null, fromSha, toRef: latestTag, toSha, provisioning };
  } catch (err) {
    // A git failure mid-flow (fetch/checkout) — report with the pre-update sha
    // so recovery is a one-line `git checkout <fromSha>`.
    log.warn('Update apply failed', { error: err.message, fromSha });
    return { ok: false, code: 'git-error', error: err.message, fromSha, toRef: null, toSha: null };
  }
}

module.exports = { applyUpdate, _internal, _headState };
