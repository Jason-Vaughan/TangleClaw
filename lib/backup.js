'use strict';

/**
 * Standalone memory-backup module (#3314).
 *
 * Per-seat correction memory and durable learnings under
 * `~/.claude/projects/*\/memory/` (`MEMORY.md` and topic files) accumulate
 * high-value operational guardrails over weeks of operator collaboration,
 * but live outside every project's own git repository and outside
 * `~/.tangleclaw/tangleclaw.db`'s own backups — an accidental `rm -rf`, a
 * botched directory move, or a host loss takes them with it, with no
 * recovery path.
 *
 * This module is a self-contained, pure Node snapshot/verify/inspect/restore
 * tool for those directories (and, by the same mechanism, equivalent memory
 * directories any other engine keeps, plus an optional single extra file —
 * e.g. a SQLite database — named explicitly by the caller). It is
 * deliberately independent of `lib/update-applier.js`'s own, separate
 * pre-update SQLite backup (`_backupSqlite`/`_secureBackup`): that module
 * backs up this server's own live database before an in-place code update;
 * this one backs up an operator's accumulated memory, on demand or from
 * whatever external scheduler (`scripts/backup-db.js`, launchd, cron, a
 * pre-update hook) chooses to call it. No background daemon or timer lives
 * in this module or in `server.js`.
 *
 * A backup is a plain directory:
 *
 *   <backupsRoot>/<timestamp>/
 *     manifest.json        -- {@link createMemoryBackup}'s own record
 *     files/<label>/...    -- one subtree per source, mirroring its layout
 *
 * `manifest.json` is the one thing every other function here trusts: a
 * SHA-256 digest and byte count per file, so {@link verifyMemoryBackup} can
 * detect a missing or corrupted file without needing the original source
 * directories to still exist, and {@link restoreMemoryBackup} never writes
 * a single byte before that verification passes.
 *
 * @module lib/backup
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/** The manifest's own schema version — bump on an incompatible shape change. */
const MANIFEST_VERSION = 1;

/** The manifest filename inside a backup directory. */
const MANIFEST_FILENAME = 'manifest.json';

/** The subdirectory inside a backup directory that holds the actual file copies. */
const FILES_DIRNAME = 'files';

/**
 * The label {@link createMemoryBackup} gives the `~/.claude/projects/*\/memory/`
 * source — the one source every backup always includes, scoped per project.
 */
const CLAUDE_PROJECTS_LABEL = 'claude-projects-memory';

/** The label an optional `sqliteDbPath` lands under in the bundle. */
const SQLITE_LABEL = 'sqlite';

/**
 * @returns {string} The default root TangleClaw's own Claude Code seats keep
 *   their per-project memory under.
 */
function defaultClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * @returns {string} The default root a backup's own timestamped directories
 *   are written under.
 */
function defaultBackupsRoot() {
  return path.join(os.homedir(), '.tangleclaw', 'backups', 'memory');
}

/**
 * @param {Buffer} buf
 * @returns {string} Hex SHA-256 digest.
 */
function _sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve a POSIX-style, `/`-separated `relPath` against `baseDir`, refusing
 * if the result would land outside `baseDir` (PRR-B R-Gate Round 1 BLOCKING
 * on PR #3338): a manifest's SHA-256 digests only prove a file's BYTES
 * match what the manifest claims, never that the manifest's own PATHS are
 * safe — an attacker who controls both a manifest and the files it
 * describes can make the digests self-consistent while a `relPath` like
 * `"../../../../etc/cron.d/evil"` still escapes the intended directory
 * entirely. Every place a `relPath` from a manifest becomes a real
 * filesystem path (reading a backed-up file, OR choosing a restore
 * destination) must resolve it through here first, not trust `path.join`
 * alone — `path.join` normalizes `..` segments exactly like `path.resolve`
 * does, so it does not stop this on its own.
 * @param {string} baseDir
 * @param {string} relPath
 * @returns {string} The resolved, contained absolute path.
 * @throws {Error} if `relPath` would resolve outside `baseDir`.
 */
function _resolveContained(baseDir, relPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, ...String(relPath).split('/'));
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`path "${relPath}" escapes its intended root (${baseDir})`);
  }
  return resolved;
}

/**
 * A sortable, filesystem-safe directory name for `now` — colons and dots
 * (illegal or awkward in a directory name on some filesystems) replaced
 * with hyphens, so lexicographic sort order still matches chronological
 * order (what {@link pruneMemoryBackups} relies on).
 * @param {Date} now
 * @returns {string}
 */
function _timestampDirName(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Every regular file under `dir`, recursively, as POSIX-style paths
 * relative to `dir` (forward slashes always, so a manifest written on one
 * host reads correctly on another). A symlink is never followed and never
 * listed: a memory directory of operator-edited markdown has no legitimate
 * reason to contain one, and following it risks silently walking outside
 * `dir` entirely.
 *
 * `dir` itself is checked too (PRR-B R-Gate Round 1 WARNING on PR #3338):
 * the loop below already skips a symlink ENTRY found via `readdirSync`
 * before ever recursing into it, but `dir` is this function's own starting
 * point, never such an entry — so a symlinked `memory/` directory (or an
 * `extraMemoryDirs` root that is itself a symlink) would otherwise be
 * followed and archived from wherever it actually points.
 * @param {string} dir
 * @returns {string[]}
 */
function _listFilesRecursive(dir) {
  const out = [];
  let rootStat;
  try {
    rootStat = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return out;
    throw err;
  }
  if (rootStat.isSymbolicLink()) return out;
  function walk(current, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  walk(dir, '');
  return out;
}

/**
 * Every file under `rootDir`'s immediate child directories' own `memory/`
 * subdirectory — never the rest of a project directory (chat transcripts,
 * settings, anything else a seat's own checkout holds) — matching
 * `~/.claude/projects/*\/memory/` exactly.
 * @param {string} rootDir - e.g. {@link defaultClaudeProjectsDir}'s value.
 * @returns {{project: string, relPath: string, absPath: string}[]}
 */
function _collectClaudeProjectsMemoryFiles(rootDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return out;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const memoryDir = path.join(rootDir, entry.name, 'memory');
    if (!fs.existsSync(memoryDir)) continue;
    for (const relPath of _listFilesRecursive(memoryDir)) {
      out.push({ project: entry.name, relPath, absPath: path.join(memoryDir, relPath) });
    }
  }
  return out;
}

/**
 * Every file directly under `rootDir`, recursively — for an `extraMemoryDirs`
 * entry, which already names the exact memory directory to archive (engine
 * layouts vary too much to assume a `<seat>/memory/` nesting the way the
 * Claude Code source does).
 * @param {string} rootDir
 * @returns {{relPath: string, absPath: string}[]}
 */
function _collectDirFiles(rootDir) {
  return _listFilesRecursive(rootDir).map((relPath) => ({ relPath, absPath: path.join(rootDir, relPath) }));
}

/**
 * Validate and normalize `opts.extraMemoryDirs` into the sources list every
 * caller walks, alongside the always-present `claude-projects-memory` one.
 * @param {object} opts - {@link createMemoryBackup}'s own opts.
 * @returns {{label: string, rootDir: string, perProject: boolean}[]}
 * @throws {TypeError} on a malformed entry.
 */
function _resolveSources(opts) {
  const sources = [{
    label: CLAUDE_PROJECTS_LABEL,
    rootDir: opts.claudeProjectsDir || defaultClaudeProjectsDir(),
    perProject: true
  }];
  for (const extra of opts.extraMemoryDirs || []) {
    if (!extra || typeof extra.label !== 'string' || !extra.label.trim()
      || typeof extra.dir !== 'string' || !extra.dir.trim()) {
      throw new TypeError('extraMemoryDirs entries need a non-empty string label and dir');
    }
    if (extra.label.trim() === CLAUDE_PROJECTS_LABEL || extra.label.trim() === SQLITE_LABEL) {
      throw new TypeError(`extraMemoryDirs label "${extra.label}" collides with a reserved label`);
    }
    sources.push({ label: extra.label.trim(), rootDir: extra.dir, perProject: false });
  }
  return sources;
}

/**
 * Copy one source file into the bundle's `files/` tree and append its
 * manifest entry.
 * @param {string} srcAbsPath - The real file to copy.
 * @param {string} filesDir - `<backupDir>/files`.
 * @param {string} bundleRelPath - POSIX-style path, relative to `filesDir`.
 * @param {{relPath: string, bytes: number, sha256: string}[]} manifestFiles - Appended to in place.
 * @returns {void}
 */
function _copyIntoBundle(srcAbsPath, filesDir, bundleRelPath, manifestFiles) {
  const destAbsPath = path.join(filesDir, ...bundleRelPath.split('/'));
  fs.mkdirSync(path.dirname(destAbsPath), { recursive: true });
  const bytes = fs.readFileSync(srcAbsPath);
  fs.writeFileSync(destAbsPath, bytes);
  manifestFiles.push({ relPath: bundleRelPath, bytes: bytes.length, sha256: _sha256(bytes) });
}

/**
 * Snapshot `~/.claude/projects/*\/memory/` (and any configured extra engine
 * memory directories, plus an optional single extra file) into a new,
 * timestamped backup directory, with a deterministic SHA-256 manifest —
 * then verifies the bundle it just wrote before returning.
 * @param {object} [opts]
 * @param {string} [opts.claudeProjectsDir] - Defaults to {@link defaultClaudeProjectsDir}.
 * @param {{label: string, dir: string}[]} [opts.extraMemoryDirs] - Additional
 *   engine memory directories to archive, each under its own label.
 * @param {string} [opts.sqliteDbPath] - A single extra file (e.g. a SQLite
 *   database) to include as-is, under the `sqlite/` label.
 * @param {string} [opts.backupsRoot] - Defaults to {@link defaultBackupsRoot}.
 * @param {Date} [opts.now] - Injectable clock, for deterministic tests.
 * @returns {{backupDir: string, manifest: object, verification: object}}
 * @throws {Error} if the target backup directory already exists, a source
 *   file cannot be read, or the bundle fails its own post-write verification.
 */
function createMemoryBackup(opts = {}) {
  // Validated before anything touches the filesystem: a malformed request
  // must never leave behind a half-created, empty backup directory.
  const sources = _resolveSources(opts);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const backupsRoot = opts.backupsRoot || defaultBackupsRoot();
  const backupDir = path.join(backupsRoot, _timestampDirName(now));
  if (fs.existsSync(backupDir)) {
    throw new Error(`backup directory already exists: ${backupDir}`);
  }
  const filesDir = path.join(backupDir, FILES_DIRNAME);
  fs.mkdirSync(filesDir, { recursive: true });

  const manifestFiles = [];
  const projectsCovered = new Set();

  for (const source of sources) {
    if (source.perProject) {
      for (const { project, relPath, absPath } of _collectClaudeProjectsMemoryFiles(source.rootDir)) {
        projectsCovered.add(project);
        _copyIntoBundle(absPath, filesDir, `${source.label}/${project}/${relPath}`, manifestFiles);
      }
    } else {
      for (const { relPath, absPath } of _collectDirFiles(source.rootDir)) {
        _copyIntoBundle(absPath, filesDir, `${source.label}/${relPath}`, manifestFiles);
      }
    }
  }

  const sourceLabels = sources.map((s) => s.label);
  if (opts.sqliteDbPath) {
    _copyIntoBundle(opts.sqliteDbPath, filesDir, `${SQLITE_LABEL}/${path.basename(opts.sqliteDbPath)}`, manifestFiles);
    sourceLabels.push(SQLITE_LABEL);
  }

  manifestFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const manifest = {
    version: MANIFEST_VERSION,
    createdAt: now.toISOString(),
    sources: sourceLabels,
    projects: Array.from(projectsCovered).sort(),
    fileCount: manifestFiles.length,
    totalBytes: manifestFiles.reduce((sum, f) => sum + f.bytes, 0),
    files: manifestFiles
  };
  fs.writeFileSync(path.join(backupDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2) + '\n');

  const verification = verifyMemoryBackup(backupDir);
  if (!verification.ok) {
    throw new Error(`backup at ${backupDir} failed its own post-write verification: ${JSON.stringify(verification)}`);
  }
  return { backupDir, manifest, verification };
}

/**
 * Verify every file `manifest.json` records against its recorded SHA-256
 * digest and byte count — detects a missing, truncated, or tampered file
 * without needing the original source directories to still exist. Also
 * rejects any entry whose `relPath` would resolve outside the backup's own
 * `files/` directory (`invalid`) — a digest match proves nothing about a
 * crafted manifest's own paths (PRR-B R-Gate Round 1 BLOCKING on PR #3338;
 * see {@link _resolveContained}), so a `../`-escaping entry is refused
 * before it is ever read, not merely reported as missing.
 * @param {string} backupDir
 * @returns {{ok: boolean, checked: number, missing: string[], mismatched: string[],
 *   invalid: string[], error?: string}}
 */
function verifyMemoryBackup(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_FILENAME);
  const filesDir = path.join(backupDir, FILES_DIRNAME);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false, checked: 0, missing: [], mismatched: [], invalid: [],
      error: `could not read manifest at ${manifestPath}: ${err.message}`
    };
  }
  const missing = [];
  const mismatched = [];
  const invalid = [];
  let checked = 0;
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    let abs;
    try {
      abs = _resolveContained(filesDir, entry.relPath);
    } catch {
      invalid.push(entry.relPath);
      continue;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      missing.push(entry.relPath);
      continue;
    }
    checked += 1;
    if (bytes.length !== entry.bytes || _sha256(bytes) !== entry.sha256) {
      mismatched.push(entry.relPath);
    }
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0 && invalid.length === 0,
    checked, missing, mismatched, invalid
  };
}

/**
 * A structured summary of one backup — its own metadata plus a fresh
 * integrity verification, so a caller never has to run both separately to
 * answer "is this backup good and what does it cover".
 * @param {string} backupDir
 * @returns {{backupDir: string, createdAt: (string|null), sources: string[],
 *   projects: string[], fileCount: (number|null), totalBytes: (number|null),
 *   verification: object}}
 */
function inspectMemoryBackup(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_FILENAME);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }
  return {
    backupDir,
    createdAt: manifest ? manifest.createdAt : null,
    sources: manifest && Array.isArray(manifest.sources) ? manifest.sources : [],
    projects: manifest && Array.isArray(manifest.projects) ? manifest.projects : [],
    fileCount: manifest ? manifest.fileCount : null,
    totalBytes: manifest ? manifest.totalBytes : null,
    verification: verifyMemoryBackup(backupDir)
  };
}

/**
 * Restore a backup's files to their live locations. Fails closed: the
 * backup is verified first, and NOTHING is written if that verification
 * does not pass.
 * @param {string} backupDir
 * @param {object} [opts]
 * @param {string} [opts.claudeProjectsDir] - Where `claude-projects-memory`
 *   entries are restored to; defaults to {@link defaultClaudeProjectsDir}.
 * @param {Object<string,string>} [opts.extraMemoryDestDirs] - Destination
 *   directory for each `extraMemoryDirs` label used at backup time; a label
 *   with no entry here is skipped (restoring an unknown engine's memory
 *   nowhere is safer than guessing a destination).
 * @param {string} [opts.sqliteDestPath] - Destination for the `sqlite/`
 *   entry, if the backup has one; omit to skip restoring it.
 * @param {boolean} [opts.dryRun] - Compute and return the restore plan
 *   without writing anything.
 * @param {string} [opts.onlyProject] - Restore only this one
 *   `claude-projects-memory` project/seat; other sources are unaffected by
 *   this filter (they are not organized by project).
 * @returns {{backupDir: string, dryRun: boolean, verification: object,
 *   restored: {relPath: string, destAbs: string}[]}}
 * @throws {Error} if the backup's own integrity verification fails.
 */
function restoreMemoryBackup(backupDir, opts = {}) {
  const verification = verifyMemoryBackup(backupDir);
  if (!verification.ok) {
    throw new Error(`refusing to restore ${backupDir}: integrity verification failed (${JSON.stringify(verification)})`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, MANIFEST_FILENAME), 'utf8'));
  const claudeProjectsDir = opts.claudeProjectsDir || defaultClaudeProjectsDir();
  const dryRun = opts.dryRun === true;
  const onlyProject = opts.onlyProject || null;

  // `verification.ok` above already rejected any manifest with an escaping
  // `relPath` (verifyMemoryBackup's own `invalid` bucket), so every entry
  // reached here already resolved safely once -- `_resolveContained` is
  // used again below anyway, on both the read and every write side, rather
  // than relying on that earlier check alone (PRR-B R-Gate Round 1 BLOCKING
  // on PR #3338): defense in depth against a future caller of this
  // function, or of `_resolveContained`'s own siblings, skipping the gate.
  const restored = [];
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    const [label, ...rest] = String(entry.relPath).split('/');
    let destAbs;
    if (label === CLAUDE_PROJECTS_LABEL) {
      const [project, ...memRest] = rest;
      if (onlyProject && project !== onlyProject) continue;
      destAbs = _resolveContained(claudeProjectsDir, [project, 'memory', ...memRest].join('/'));
    } else if (label === SQLITE_LABEL) {
      if (onlyProject || !opts.sqliteDestPath) continue;
      destAbs = opts.sqliteDestPath;
    } else {
      const destRoot = opts.extraMemoryDestDirs && opts.extraMemoryDestDirs[label];
      if (onlyProject || !destRoot) continue;
      destAbs = _resolveContained(destRoot, rest.join('/'));
    }
    const srcAbs = _resolveContained(path.join(backupDir, FILES_DIRNAME), entry.relPath);
    restored.push({ relPath: entry.relPath, destAbs });
    if (!dryRun) {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.writeFileSync(destAbs, fs.readFileSync(srcAbs));
    }
  }
  return { backupDir, dryRun, verification, restored };
}

/**
 * Retention helper for scheduled invocations: keep only the newest
 * `keepLast` backup directories under `backupsRoot`, removing the rest.
 * Directory names sort chronologically (they are {@link _timestampDirName}'s
 * own ISO-derived format), so a plain string sort is enough — no need to
 * parse each one back into a Date.
 * @param {string} backupsRoot
 * @param {object} [opts]
 * @param {number} [opts.keepLast] - Defaults to 1.
 * @returns {{kept: string[], removed: string[]}}
 */
function pruneMemoryBackups(backupsRoot, opts = {}) {
  const keepLast = Number.isInteger(opts.keepLast) && opts.keepLast > 0 ? opts.keepLast : 1;
  let entries;
  try {
    entries = fs.readdirSync(backupsRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { kept: [], removed: [] };
    throw err;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const kept = dirs.slice(Math.max(0, dirs.length - keepLast));
  const removed = dirs.slice(0, dirs.length - kept.length);
  for (const name of removed) {
    fs.rmSync(path.join(backupsRoot, name), { recursive: true, force: true });
  }
  return { kept, removed };
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_FILENAME,
  FILES_DIRNAME,
  CLAUDE_PROJECTS_LABEL,
  SQLITE_LABEL,
  defaultClaudeProjectsDir,
  defaultBackupsRoot,
  createMemoryBackup,
  verifyMemoryBackup,
  inspectMemoryBackup,
  restoreMemoryBackup,
  pruneMemoryBackups,
  // Exported for tests only.
  _listFilesRecursive,
  _resolveContained,
  _sha256
};
