'use strict';

/**
 * Everything about a project's version that is a plain file operation: the
 * readers for each detection source, the live-detection ladder they form, and
 * the cache writer.
 *
 * WHY THIS IS ITS OWN MODULE. Two modules need these readers and, before this
 * existed, they reached for each other to get them: `lib/project-version.js`
 * called `projects._readChangelogVersion` and `lib/projects.js` called
 * `projectVersion._readConfiguredVersion`, so the two formed a require cycle
 * that both had to paper over with lazy call-time requires (#584 is what that
 * cost when the papering slipped). A cycle between two modules can be lived
 * with; a THIRD consumer cannot join one. The scanner child is that third
 * consumer, and it reads a project's version so the server never touches an
 * operator-chosen path itself (#884). Extracting the readers removes the cycle
 * rather than widening it — neither of the original two requires the other now.
 *
 * NOTHING HERE MAY REACH THE DATABASE, at require time or at call time. This
 * module is loaded inside a process that exists to be SIGKILLed mid-syscall
 * (`lib/dir-scanner-child.js`), and an open SQLite handle in a process that dies
 * without closing it is a handle on the server's own database. `lib/store.js`
 * opens that database at require time, so the rule is simply that it — and
 * anything that pulls it in — stays out. The lazy-require form of the same
 * mistake is the one that gets through review: it does not appear until first
 * call, so only a fresh-process probe can see it (`test/dir-scanner-child.test.js`).
 *
 * THE GIT-TAG RUNG IS DELIBERATELY ABSENT. `lib/project-version.js` adds it in
 * its own ladder, on top of these readers. It shells out, it is only wanted by
 * the launch/wrap writer, and keeping it out means this module never requires
 * `node:child_process`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const projectPaths = require('./project-paths');
const projectConfig = require('./project-config');

const { createLogger } = require('./logger');

const log = createLogger('project-version-files');

/** Basename of the per-project version cache, under `.tangleclaw/`. */
const VERSION_CACHE_FILENAME = 'project-version.txt';

/**
 * Read a UTF-8 text file, normalising the two things that otherwise break a
 * naive line match: a UTF-8 BOM (which makes the first line start with an
 * invisible character) and CRLF line endings.
 *
 * Returns null for a file that is not there, so callers distinguish "absent"
 * from "empty" without a second `existsSync`.
 *
 * @param {string} filePath - Absolute path to read.
 * @returns {string|null} - Normalised content, or null when the file is absent.
 */
function readTextFileNoBom(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n');
}

/**
 * Read the project's version cache file (`.tangleclaw/project-version.txt`).
 * Format is plain key:value lines:
 *   version: 3.12.7
 *   recorded_at: 2026-04-10T20:34:12Z
 *   source: CHANGELOG.md
 * Only the `version` line is required; others are advisory.
 *
 * Written by `writeVersionCacheFile` below, from two triggers: session
 * launch/wrap (`lib/project-version.js:recordVersion`, whose chain includes a
 * git-tag fallback) and the read-time self-heal in `detectProjectVersion` (whose
 * chain deliberately lacks that rung, which is why a null live read preserves
 * the cache rather than clobbering it).
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null} - Cached version string, or null if missing/invalid
 */
function readVersionCacheFile(projectPath) {
  try {
    const cachePath = path.join(projectPath, '.tangleclaw', VERSION_CACHE_FILENAME);
    const content = readTextFileNoBom(cachePath);
    if (content === null) return null;
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*version\s*:\s*(.*)$/i);
      if (!m) continue;
      const value = m[1].trim();
      if (value) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the project's first released version from CHANGELOG.md.
 * Looks for the first `## [X.Y.Z]` header that is NOT `[Unreleased]` and
 * matches a version-ish format (optional `v` prefix, then `digit.digit`
 * minimum). This rejects date-style headers (`## [2026-03-31]`) which some
 * projects use — those are not versions.
 * Handles Keep-a-Changelog format used across TangleClaw projects.
 * Accepted examples: `3.12.7`, `0.3.0`, `0.6.9-beta`, `v1.0.0`, `2.0.0-rc1`
 * Rejected examples: `Unreleased`, `2026-03-31`, `March 2026`, `TBD`
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null} - Released version string, or null if no released entries
 */
function readChangelogVersion(projectPath) {
  try {
    const changelogPath = path.join(projectPath, 'CHANGELOG.md');
    const content = readTextFileNoBom(changelogPath);
    if (content === null) return null;
    // Version must start with optional `v`, then `digit.digit` at minimum.
    // This rejects date headers like `2026-03-31` (no dot after year segment).
    const VERSION_SHAPE = /^v?\d+\.\d+/;
    for (const line of content.split('\n')) {
      const m = line.match(/^##\s*\[([^\]]+)\]/);
      if (!m || !m[1]) continue;
      const candidate = m[1].trim();
      if (candidate.toLowerCase() === 'unreleased') continue;
      if (!VERSION_SHAPE.test(candidate)) continue;
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the project's version from a `version.json` file at the project root.
 * Convention used by TangleClaw itself. Only accepts a string `version` field
 * — non-string values (numbers, objects, arrays) are rejected defensively.
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null}
 */
function readVersionJsonVersion(projectPath) {
  try {
    const verPath = path.join(projectPath, 'version.json');
    const content = readTextFileNoBom(verPath);
    if (content === null) return null;
    const data = JSON.parse(content);
    return data && typeof data.version === 'string' && data.version.trim()
      ? data.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the project's version from a `package.json` at the project root.
 * Convention used by Node projects. Only accepts a string `version` field.
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null}
 */
function readPackageJsonVersion(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    const content = readTextFileNoBom(pkgPath);
    if (content === null) return null;
    const pkg = JSON.parse(content);
    return pkg && typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version
      : null;
  } catch {
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
 * Reads the config through `./project-config`, NOT `./store`. Those are the same
 * reader, but the store module opens SQLite at require time and this one is pure
 * `fs` — and this runs in a process built to be killed. See the module header.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {{version:string, source:string}|null}
 */
function readConfiguredVersion(projectPath) {
  let cfg = null;
  try {
    cfg = projectConfig.load(projectPath);
  } catch (err) {
    log.debug('project config unreadable for version detection', { projectPath, error: err.message });
    return null;
  }

  // Same read-and-resolve recipe the wrap step uses. Only the on-failure policy
  // differs — the writer refuses outright, detection degrades to its probe —
  // and that difference is deliberate, unlike the four hand-rolled copies of the
  // resolution itself that preceded this.
  const configuredFile = projectPaths.resolveConfiguredFile(projectPath, cfg, 'versionFilePath');
  if (!configuredFile.configured) return null;
  if (!configuredFile.ok) {
    log.warn('versionFilePath not usable — ignoring for version detection', { projectPath, configured: configuredFile.raw, reason: configuredFile.reason });
    return null;
  }
  const configured = configuredFile.raw;
  const resolved = configuredFile.path;

  try {
    const json = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const v = json && json.version;
    if (typeof v === 'string' && v.trim() !== '') {
      return { version: v.trim(), source: path.basename(resolved) };
    }
    // The file read fine but carries no usable version. Logged for the same
    // reason as its sibling branches: the operator named this file, so falling
    // through to the probe is a stated intent going unhonored, and a bare
    // `return null` here made this the one degrade path that said nothing.
    log.warn('configured version file has no usable "version" field — falling back to the built-in probe', { projectPath, configured, found: v === undefined ? '(absent)' : typeof v });
    return null;
  } catch (err) {
    // WARN, not DEBUG: the operator explicitly named this file, so falling back
    // to the probe is a stated intent going unhonored. The wrap step refuses
    // outright in the same situation; detection only degrades, but it should
    // still say so at a level someone will see.
    log.warn('configured version file unreadable — falling back to the built-in probe', { projectPath, configured, error: err.message });
    return null;
  }
}

/**
 * Detect a project's current version from on-disk sources only (no cache).
 * Walks CHANGELOG.md → a configured `versionFilePath` → version.json →
 * package.json in priority order and returns `{ version, source }` from the
 * first hit, or null if none match. `source` is the reader that hit, which for
 * the configured rung is that file's basename rather than a fixed label.
 *
 * THE ORDER IS LOAD-BEARING, and specifically it must stay in step with
 * `lib/project-version.js:detectVersion`, which is the ladder that WRITES the
 * cache at session launch and wrap. Where the two disagree about which file
 * holds a project's version, this one's self-heal (`detectProjectVersion`)
 * overwrites what that one wrote and stamps a `source:` naming a file the value
 * did not come from. They legitimately differ in their TAIL — that one falls
 * back to a git tag, this one deliberately does not — which is why they share
 * rungs rather than a ladder.
 *
 * The consequence of that missing tail is the reason `detectProjectVersion`
 * preserves the cache when this returns null: the cached value may be
 * git-tag-derived, and no reader here can reproduce it.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {{ version: string, source: string }|null}
 */
function detectLiveVersion(projectPath) {
  const fromChangelog = readChangelogVersion(projectPath);
  if (fromChangelog) return { version: fromChangelog, source: 'CHANGELOG.md' };

  const fromConfigured = readConfiguredVersion(projectPath);
  if (fromConfigured) return fromConfigured;

  const fromVersionJson = readVersionJsonVersion(projectPath);
  if (fromVersionJson) return { version: fromVersionJson, source: 'version.json' };

  const fromPackageJson = readPackageJsonVersion(projectPath);
  if (fromPackageJson) return { version: fromPackageJson, source: 'package.json' };

  return null;
}

/**
 * Format `{ version, source, recordedAt }` into the cache-file body.
 * Plain `key: value` lines, trailing newline. Mirrors the format the AI used
 * to write so existing readers continue to parse it.
 * @param {object} fields
 * @param {string} fields.version - Detected version string.
 * @param {string} fields.source - Which reader produced it.
 * @param {string} fields.recordedAt - ISO-8601 timestamp, seconds precision.
 * @returns {string}
 */
function formatCacheFile({ version, source, recordedAt }) {
  return [
    `version: ${version}`,
    `recorded_at: ${recordedAt}`,
    `source: ${source}`,
    ''
  ].join('\n');
}

/**
 * Write `.tangleclaw/project-version.txt` atomically. Creates `.tangleclaw/` if
 * missing. Never throws — logs at warn and returns false, so a read-only or
 * permission-denied project still gets its version served rather than failing
 * the request that detected it.
 *
 * WHY TEMP-THEN-RENAME RATHER THAN A PLAIN WRITE. The self-heal that calls this
 * now runs inside the forked scanner child, which the supervisor SIGKILLs when a
 * path stops answering — mid-syscall, with no chance to clean up. A `writeFileSync`
 * straight to the destination truncates it first, so a kill in that window leaves
 * a zero-length or half-written cache that `readVersionCacheFile` will happily
 * parse: the project's version silently becomes whatever survived, or disappears.
 * `rename(2)` within one directory is atomic on POSIX, so a reader sees either
 * the previous file or the complete new one and never a partial. The temp name
 * carries the pid because two processes legitimately write this file — the
 * scanner child on a poll, the server at session launch and wrap — and a shared
 * temp name would let one truncate the other's staging file.
 *
 * @param {string} projectPath - Absolute project root path
 * @param {string} version - Detected version string to record
 * @param {string} source - Source label (e.g. `'CHANGELOG.md'`, `'version.json'`)
 * @returns {boolean} - True on success, false on any write failure
 */
function writeVersionCacheFile(projectPath, version, source) {
  const dir = path.join(projectPath, '.tangleclaw');
  const file = path.join(dir, VERSION_CACHE_FILENAME);
  const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Same directory as the destination, so the rename below cannot cross a
  // filesystem boundary — which is the one condition that would turn it back
  // into a copy, and with it back into a partially-observable write.
  const tmp = path.join(dir, `.${VERSION_CACHE_FILENAME}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, formatCacheFile({ version, source, recordedAt }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log.warn('Failed to write the project-version cache', { projectPath, error: err.message });
    // Best-effort: a temp file left behind is invisible to every reader (they
    // name the destination), but it would accumulate one per failed poll.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // It was never created, or it is as unremovable as it was unwritable.
    }
    return false;
  }
}

/**
 * Detect a project's current version using the universal detection chain
 * with read-time self-heal (#165).
 *
 * Strategy:
 *   1. Read the cached value (`.tangleclaw/project-version.txt`).
 *   2. Read the live value from on-disk sources (CHANGELOG → a configured
 *      `versionFilePath` → version.json → package.json).
 *   3. If live is present AND differs from cached, rewrite the cache and return live.
 *   4. If live is present AND matches cached, return cached (no rewrite).
 *   5. If live is null (no source files match), return cached — preserves
 *      git-tag-derived or fallback values that `recordVersion` may have written
 *      via the richer chain in `lib/project-version.js`. Accepted trade-off
 *      (Critic N2): a project whose live sources all vanished — CHANGELOG.md,
 *      a configured version file, version.json, package.json — keeps showing
 *      the pre-deletion value until the next
 *      session launch's `recordVersion` rewrites the cache with the fallback
 *      source. The alternative (clobber-on-null-live) would regress every
 *      git-tag-only project on each enrichment, which is worse.
 *   6. If both are null, return null.
 *
 * Pre-#165 behavior was cache-first with no self-heal — external version bumps
 * (release-PR merges via `gh`, `git pull`, manual `version.json` edits) left
 * the dashboard label stuck on the pre-bump value until the next session
 * launch/wrap (the only triggers that called `recordVersion`). The self-heal
 * closes that gap on every enrichment without introducing extra triggers.
 *
 * See issue #55 for the original cache design, #165 for the self-heal addition.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null}
 */
function detectProjectVersion(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;

  const cached = readVersionCacheFile(projectPath);
  const live = detectLiveVersion(projectPath);

  if (live) {
    if (live.version !== cached) {
      writeVersionCacheFile(projectPath, live.version, live.source);
    }
    return live.version;
  }

  return cached;
}

module.exports = {
  readTextFileNoBom,
  readVersionCacheFile,
  readChangelogVersion,
  readVersionJsonVersion,
  readPackageJsonVersion,
  readConfiguredVersion,
  detectLiveVersion,
  formatCacheFile,
  writeVersionCacheFile,
  detectProjectVersion,
  VERSION_CACHE_FILENAME
};
