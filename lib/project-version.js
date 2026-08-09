'use strict';

/**
 * Project version detection + cache writer.
 *
 * Owns `<projectPath>/.tangleclaw/project-version.txt` — TangleClaw writes it
 * at session launch and wrap, so the AI no longer has to. (#101)
 *
 * Detection chain (first hit wins):
 *   1. CHANGELOG.md — first non-`[Unreleased]` version-shaped header
 *   2. configured `versionFilePath` — `{ "version": "X.Y.Z" }`, when the project
 *      named its version file explicitly (kept ahead of the fixed probe so the
 *      reader and the wrap's writer agree on where the version lives)
 *   3. version.json — `{ "version": "X.Y.Z" }`
 *   4. package.json — `{ "version": "X.Y.Z" }`
 *   5. git tag — `git describe --tags --abbrev=0`
 *   6. fallback — `0.0.0-dev`
 *
 * Note: the cache file itself is intentionally NOT a detection source here —
 * it's the output. `lib/project-version-files.js:readVersionCacheFile` reads the
 * cache for the landing-page enrichment chain (its own concern).
 *
 * **There is no longer a require cycle here, and that is load-bearing.** This
 * module used to reach into `lib/projects.js` for its readers while that module
 * reached back here for `_readConfiguredVersion` — a cycle both sides papered
 * over with lazy call-time requires. Entered via `projects.js` (the server's
 * load order), a top-level require here captured projects' *partial*
 * `module.exports` mid-cycle, so `detectVersion` threw and every `recordVersion`
 * call warned and bailed (#584). The readers now live in a third module both
 * sides consume (`./project-version-files`), so the cycle is gone rather than
 * deferred — which is what let the scanner child become a third consumer (#884).
 * Do not reintroduce a `require('./projects')` here.
 */

const path = require('node:path');
const versionFiles = require('./project-version-files');
const { execFileSync } = require('node:child_process');

const { createLogger } = require('./logger');

const log = createLogger('project-version');

const FALLBACK_VERSION = '0.0.0-dev';

/**
 * Read the latest tag via `git describe --tags --abbrev=0`. Returns null on
 * any failure (no git, not a repo, no tags). Strips a leading `v` so tag
 * `v3.13.3` is reported as `3.13.3` to match the other sources.
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null}
 */
function _readGitTagVersion(projectPath) {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000
    });
    const tag = out.trim();
    if (!tag) return null;
    return tag.replace(/^v/, '');
  } catch (err) {
    // Common cases that aren't worth a warning: not a git repo, no tags yet,
    // git not on PATH. Log at debug so a slow-repo timeout is at least
    // diagnosable when someone turns the verbosity up.
    log.debug('git tag lookup failed', { projectPath, error: err.message });
    return null;
  }
}

/**
 * Detect the project's current version + the source it came from.
 *
 * Returns `{ version, source }` where `source` is one of:
 *   `'CHANGELOG.md'`, the basename of a configured `versionFilePath`,
 *   `'version.json'`, `'package.json'`, `'git tag'`, `'fallback'`.
 *
 * Always returns a value — fallback is `{ version: '0.0.0-dev', source: 'fallback' }`
 * so callers don't have to handle null.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {{ version: string, source: string }}
 */
function detectVersion(projectPath) {
  if (!projectPath) return { version: FALLBACK_VERSION, source: 'fallback' };

  const fromChangelog = versionFiles.readChangelogVersion(projectPath);
  if (fromChangelog) return { version: fromChangelog, source: 'CHANGELOG.md' };

  // A project that named its version file explicitly gets read from that file
  // rather than the fixed probe below, so the reader and the wrap's writer agree
  // on which FILE holds the version.
  //
  // Note the limit: CHANGELOG.md still wins above, by design — it is the more
  // authoritative published record — so a project with any released heading
  // never reaches this branch. The setting closes the reader/writer divergence
  // within the probe, not against the changelog.
  const fromConfigured = versionFiles.readConfiguredVersion(projectPath);
  if (fromConfigured) return { version: fromConfigured.version, source: fromConfigured.source };

  const fromVersionJson = versionFiles.readVersionJsonVersion(projectPath);
  if (fromVersionJson) return { version: fromVersionJson, source: 'version.json' };

  const fromPackageJson = versionFiles.readPackageJsonVersion(projectPath);
  if (fromPackageJson) return { version: fromPackageJson, source: 'package.json' };

  const fromGit = _readGitTagVersion(projectPath);
  if (fromGit) return { version: fromGit, source: 'git tag' };

  return { version: FALLBACK_VERSION, source: 'fallback' };
}

/**
 * Detect the project's version and write it to
 * `<projectPath>/.tangleclaw/project-version.txt`. Idempotent.
 * Creates `.tangleclaw/` if missing. Never throws — returns `null` on
 * write failure and logs a warning.
 *
 * The write goes through the shared cache writer rather than a second
 * `writeFileSync` here. That is not tidiness: this file and the read-time
 * self-heal both write the same path, from different processes, and a
 * hand-rolled copy is how the two formats drift apart while every test still
 * passes on the copy it was written against.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {{ version: string, source: string, path: string }|null}
 */
function recordVersion(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return null;
  try {
    const { version, source } = detectVersion(projectPath);
    if (!versionFiles.writeVersionCacheFile(projectPath, version, source)) return null;
    return {
      version,
      source,
      path: path.join(projectPath, '.tangleclaw', versionFiles.VERSION_CACHE_FILENAME)
    };
  } catch (err) {
    log.warn('Failed to record project version', { projectPath, error: err.message });
    return null;
  }
}

module.exports = {
  detectVersion,
  recordVersion,
  FALLBACK_VERSION,
  _readGitTagVersion,
  // Re-exported, not re-implemented. Both were moved to
  // `./project-version-files` so a third consumer — the scanner child — could
  // reach them without joining the cycle this module used to sit on. The names
  // stay because callers and tests address them here.
  _readConfiguredVersion: versionFiles.readConfiguredVersion,
  _formatCacheFile: versionFiles.formatCacheFile
};
