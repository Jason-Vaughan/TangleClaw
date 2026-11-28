#!/usr/bin/env node
'use strict';

/**
 * Idempotently mirror `bin/tc` and `lib/` into `~/.tangleclaw/tc-cli-staged/`
 * (#3347, KZ-v667-07).
 *
 * A TCC-staged pane (or any lane-local invocation that runs the staged copy
 * rather than the live checkout) can lag behind a newly merged `tc` verb
 * until something refreshes it. This module is that refresh, callable
 * idempotently from an operator's own terminal, a deploy script, or a
 * future server-startup hook (none of which this module wires up itself —
 * invoking it is the caller's decision, same as `lib/backup.js`'s own
 * CLI-only, no-daemon shape).
 *
 * `bin/tc` requires `lib/tc-verbs.js` by relative path (`path.join(__dirname,
 * '..', 'lib', 'tc-verbs.js')`), so staging always mirrors `bin/tc` and the
 * whole `lib/` directory together — every verb's own transitive `lib/*`
 * dependencies ride along automatically, never a hand-maintained file list
 * that drifts behind a new `require('./something-new')`.
 *
 * Whether a restage is NEEDED is answered by a composite fingerprint:
 * `version.json`'s own version string, `bin/tc`'s own SHA-256, and a single
 * combined digest of every `lib/**\/*.js` file's own path and content (PRR-B
 * R-Gate Round 1 BLOCKING on PR #3348) — an earlier version of this module
 * trusted `version.json`/`bin/tc` alone, on the assumption that this repo's
 * own release discipline always bumps `version.json` alongside any `lib/`
 * change; that assumption is exactly the kind of claim this fleet's own
 * practice says to verify rather than lean on, and PRR-B was right not to
 * accept it as a substitute for actually checking `lib/`. The combined
 * digest costs reading and hashing every staged file on every call (lib/ is
 * ~13MB across ~430 files in this repo today) — accepted deliberately as
 * the correctness/cost trade-off #3347's own "digest changes" acceptance
 * criterion asks for, not a cheaper approximation of it.
 *
 * @module scripts/stage-tc-cli
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/** The marker file recording what is currently staged, inside the staged directory itself. */
const MANIFEST_FILENAME = '.stage-manifest.json';

/**
 * @returns {string} This repo's own root (one level up from `scripts/`).
 */
function defaultRepoRoot() {
  return path.resolve(__dirname, '..');
}

/**
 * @returns {string} The default staging target.
 */
function defaultStagedDir() {
  return path.join(os.homedir(), '.tangleclaw', 'tc-cli-staged');
}

/**
 * A single SHA-256 digest over every `.js` file under `repoRoot/lib`,
 * recursively — each file's own path and content both feed the digest, so
 * an added, removed, or edited file all change the result, never just a
 * file's own content in isolation (PRR-B R-Gate Round 1 BLOCKING on PR
 * #3348). Deterministic regardless of filesystem directory-listing order:
 * paths are collected first and sorted before anything is hashed.
 * @param {string} repoRoot
 * @returns {string} Hex digest, or the digest of nothing (`lib/` missing or empty).
 */
function _libTreeDigest(repoRoot) {
  const libDir = path.join(repoRoot, 'lib');
  const relPaths = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) relPaths.push(relPath);
    }
  };
  walk(libDir, '');
  relPaths.sort();
  const hash = crypto.createHash('sha256');
  for (const relPath of relPaths) {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(libDir, ...relPath.split('/')));
    } catch {
      bytes = Buffer.alloc(0);
    }
    hash.update(relPath).update('\0').update(bytes).update('\n');
  }
  return hash.digest('hex');
}

/**
 * The signals that decide whether a restage is needed: the live
 * `version.json`'s version string, the live `bin/tc`'s own SHA-256, and
 * {@link _libTreeDigest} over the live `lib/` tree. Each reads as `null`
 * when its own source is missing or unreadable, which always compares
 * unequal to a staged manifest's own non-null value — so a broken/missing
 * source is a `changed` signal, not a silent no-op.
 * @param {string} repoRoot
 * @returns {{version: (string|null), binTcSha256: (string|null), libTreeSha256: (string|null)}}
 */
function _fingerprint(repoRoot) {
  let version = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8'));
    version = typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    version = null;
  }
  let binTcSha256 = null;
  try {
    binTcSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, 'bin', 'tc'))).digest('hex');
  } catch {
    binTcSha256 = null;
  }
  let libTreeSha256 = null;
  try {
    libTreeSha256 = _libTreeDigest(repoRoot);
  } catch {
    libTreeSha256 = null;
  }
  return { version, binTcSha256, libTreeSha256 };
}

/**
 * @param {string} stagedDir
 * @returns {{version: (string|null), binTcSha256: (string|null)}|null} `null`
 *   if nothing has been staged yet, or the manifest is unreadable/malformed.
 */
function _readStagedFingerprint(stagedDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stagedDir, MANIFEST_FILENAME), 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Stage `bin/tc` and `lib/` into `stagedDir`, idempotently: a no-op when
 * the live fingerprint already matches what is staged, otherwise a full,
 * clean mirror (stale staged files that no longer exist in the live source
 * are removed first, via `rm -rf` on each staged subtree before copying —
 * never a partial overlay that could leave a deleted verb's old file
 * sitting beside the rest).
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - Defaults to {@link defaultRepoRoot}.
 * @param {string} [opts.stagedDir] - Defaults to {@link defaultStagedDir}.
 * @param {boolean} [opts.force] - Restage even when the fingerprint already matches.
 * @returns {{staged: boolean, reason: string, stagedDir: string,
 *   fingerprint: {version: (string|null), binTcSha256: (string|null)}}}
 * @throws {Error} if `repoRoot`'s own `bin/tc` or `lib/` cannot be read when
 *   a restage is actually needed (a fingerprint-only call with nothing to
 *   restage never touches either).
 */
function stageTcCli(opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const stagedDir = opts.stagedDir || defaultStagedDir();
  const force = opts.force === true;
  const current = _fingerprint(repoRoot);
  const staged = _readStagedFingerprint(stagedDir);
  const upToDate = !force && staged !== null
    && staged.version === current.version && staged.binTcSha256 === current.binTcSha256
    && staged.libTreeSha256 === current.libTreeSha256;
  if (upToDate) {
    return { staged: false, reason: 'up-to-date', stagedDir, fingerprint: current };
  }

  const stagedBinDir = path.join(stagedDir, 'bin');
  const stagedLibDir = path.join(stagedDir, 'lib');
  fs.mkdirSync(stagedDir, { recursive: true });
  fs.rmSync(stagedBinDir, { recursive: true, force: true });
  fs.rmSync(stagedLibDir, { recursive: true, force: true });
  fs.mkdirSync(stagedBinDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'bin', 'tc'), path.join(stagedBinDir, 'tc'));
  fs.chmodSync(path.join(stagedBinDir, 'tc'), 0o755);
  fs.cpSync(path.join(repoRoot, 'lib'), stagedLibDir, { recursive: true });

  fs.writeFileSync(
    path.join(stagedDir, MANIFEST_FILENAME),
    `${JSON.stringify({ ...current, stagedAt: new Date().toISOString() }, null, 2)}\n`
  );
  return { staged: true, reason: force ? 'forced' : (staged === null ? 'never-staged' : 'changed'), stagedDir, fingerprint: current };
}

/**
 * Run the CLI: `node scripts/stage-tc-cli.js [--repo-root <dir>] [--staged-dir <dir>] [--force]`.
 * Exit: 0 always (staging or confirming up-to-date are both success; a
 * thrown error is the only failure path, exit 1).
 * @param {string[]} argv
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') { opts.force = true; continue; }
    if (arg === '--repo-root') { opts.repoRoot = argv[++i]; continue; }
    if (arg === '--staged-dir') { opts.stagedDir = argv[++i]; continue; }
  }
  try {
    const result = stageTcCli(opts);
    return { code: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `stage-tc-cli: ${err.message}\n` };
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = main(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}

module.exports = {
  stageTcCli, main, defaultRepoRoot, defaultStagedDir,
  // Exported for tests only.
  _fingerprint, _readStagedFingerprint, _libTreeDigest
};
