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
 * it's the output. `lib/projects.js:_readVersionCacheFile` reads the cache
 * for the landing-page enrichment chain (its own concern).
 *
 * **Why lazy-require `./projects`.** This module sits on a require cycle:
 * `projects.js` → `sessions.js` → here → `projects.js`. When the graph is
 * entered via `projects.js` (the server's load order), a top-level require
 * here captures projects' *partial* `module.exports` mid-cycle; projects.js
 * later replaces `module.exports` wholesale, so the captured object never
 * gains `_readChangelogVersion` and every `recordVersion` call warned and
 * bailed (#584). Requiring at call time resolves the complete module — same
 * pattern as `lib/wrap-steps/index-describe.js` / `project-map.js`.
 */

const fs = require('node:fs');
const path = require('node:path');
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
 * Read the version from a project's configured `versionFilePath`, if it set one.
 *
 * Mirrors the containment rule `lib/wrap-steps/version-bump.js` enforces at its
 * write site: a value that escapes the project root is ignored rather than read.
 * Any failure returns null so the caller falls through to the probe order — this
 * is a detection helper, and an unreadable file is a reason to keep looking, not
 * to fail the wrap.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {{version:string, source:string}|null}
 */
function _readConfiguredVersion(projectPath) {
  let configured = null;
  try {
    const store = require('./store'); // lazy — same require-cycle reason as above
    const cfg = store.projectConfig.load(projectPath);
    configured = cfg && typeof cfg.versionFilePath === 'string' && cfg.versionFilePath.trim() !== ''
      ? cfg.versionFilePath.trim()
      : null;
  } catch (err) {
    log.debug('project config unreadable for version detection', { projectPath, error: err.message });
    return null;
  }
  if (!configured) return null;

  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, configured);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    log.warn('versionFilePath resolves outside the project root — ignoring for version detection', { projectPath, configured });
    return null;
  }

  try {
    const json = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const v = json && json.version;
    if (typeof v === 'string' && v.trim() !== '') {
      return { version: v.trim(), source: path.basename(resolved) };
    }
    return null;
  } catch (err) {
    log.debug('configured version file unreadable', { projectPath, configured, error: err.message });
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

  const projects = require('./projects'); // lazy — breaks the require cycle (see module head)
  const fromChangelog = projects._readChangelogVersion(projectPath);
  if (fromChangelog) return { version: fromChangelog, source: 'CHANGELOG.md' };

  // A project that named its version file explicitly gets read from that file,
  // not from the probe order below. Otherwise the reader and the wrap's writer
  // disagree about where the version lives — the same reader/writer divergence
  // `versionFilePath` exists to close, displaced one layer.
  const fromConfigured = _readConfiguredVersion(projectPath);
  if (fromConfigured) return { version: fromConfigured.version, source: fromConfigured.source };

  const fromVersionJson = projects._readVersionJsonVersion(projectPath);
  if (fromVersionJson) return { version: fromVersionJson, source: 'version.json' };

  const fromPackageJson = projects._readPackageJsonVersion(projectPath);
  if (fromPackageJson) return { version: fromPackageJson, source: 'package.json' };

  const fromGit = _readGitTagVersion(projectPath);
  if (fromGit) return { version: fromGit, source: 'git tag' };

  return { version: FALLBACK_VERSION, source: 'fallback' };
}

/**
 * Format `{ version, source, recordedAt }` into the cache-file body.
 * Plain `key: value` lines, trailing newline. Mirrors the format the AI used
 * to write so existing readers continue to parse it.
 * @param {object} fields
 * @returns {string}
 */
function _formatCacheFile({ version, source, recordedAt }) {
  return [
    `version: ${version}`,
    `recorded_at: ${recordedAt}`,
    `source: ${source}`,
    ''
  ].join('\n');
}

/**
 * Detect the project's version and write it to
 * `<projectPath>/.tangleclaw/project-version.txt`. Idempotent.
 * Creates `.tangleclaw/` if missing. Never throws — returns `null` on
 * write failure and logs a warning.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {{ version: string, source: string, path: string }|null}
 */
function recordVersion(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return null;
  try {
    const { version, source } = detectVersion(projectPath);
    const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const dir = path.join(projectPath, '.tangleclaw');
    const file = path.join(dir, 'project-version.txt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, _formatCacheFile({ version, source, recordedAt }), 'utf8');
    return { version, source, path: file };
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
  _formatCacheFile
};
