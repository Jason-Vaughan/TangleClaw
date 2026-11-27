#!/usr/bin/env node
'use strict';

/**
 * CLI entry point over `lib/backup.js` (#3314) — the memory-backup module's
 * own operator surface, for an operator's own terminal, a launchd/cron job,
 * or a pre-update hook to invoke on demand or on a schedule. This script
 * has no scheduling logic of its own: whatever calls it decides when.
 *
 *   node scripts/backup-db.js create [--claude-projects-dir <dir>]
 *     [--backups-root <dir>] [--sqlite-db <path>]
 *     [--extra-memory-dir <label>=<dir>]...
 *   node scripts/backup-db.js verify <backupDir>
 *   node scripts/backup-db.js inspect <backupDir>
 *   node scripts/backup-db.js restore <backupDir> [--claude-projects-dir <dir>]
 *     [--sqlite-dest <path>] [--extra-memory-dest <label>=<dir>]...
 *     [--only-project <name>] [--dry-run]
 *   node scripts/backup-db.js prune <backupsRoot> [--keep-last <n>]
 *
 * Exit: 0 success (or `verify`/`inspect`/`restore` whose own backup was
 * already good) · 1 a verification failed, or the command threw · 2 usage
 * error (unknown command, or a required argument missing).
 */

/** Flags taking a value more than once, collected into an array. */
const REPEATABLE_FLAGS = new Set(['extra-memory-dir', 'extra-memory-dest']);

/** Flags taking no value at all. */
const BOOLEAN_FLAGS = new Set(['dry-run']);

/**
 * Split `args` into `--flag value` / `--flag` entries and bare positional
 * arguments. Minimal on purpose: this CLI has no flag that itself looks like
 * `--something`, so no quoting/escaping concern arises.
 * @param {string[]} args
 * @returns {{flags: Object<string, (string|string[]|true)>, positional: string[]}}
 * @throws {Error} if a non-boolean flag is given with no following value.
 */
function _parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    i += 1;
    if (REPEATABLE_FLAGS.has(key)) {
      (flags[key] = flags[key] || []).push(value);
    } else {
      flags[key] = value;
    }
  }
  return { flags, positional };
}

/**
 * Parse `label=dir` pairs (as `--extra-memory-dir` collects them) into
 * {@link module:lib/backup.createMemoryBackup}'s own `extraMemoryDirs` shape.
 * @param {string[]|undefined} values
 * @returns {{label: string, dir: string}[]}
 * @throws {Error} on a value with no `=`, or an empty label.
 */
function _parseLabelDirPairs(values) {
  return (values || []).map((value) => {
    const eq = value.indexOf('=');
    if (eq <= 0) throw new Error(`expected "<label>=<dir>", got "${value}"`);
    return { label: value.slice(0, eq), dir: value.slice(eq + 1) };
  });
}

/**
 * Same pairs, as a `{label: dir}` map — the shape
 * {@link module:lib/backup.restoreMemoryBackup}'s own `extraMemoryDestDirs` takes.
 * @param {string[]|undefined} values
 * @returns {Object<string,string>}
 */
function _parseLabelDirMap(values) {
  const map = {};
  for (const { label, dir } of _parseLabelDirPairs(values)) map[label] = dir;
  return map;
}

/**
 * @param {object} result
 * @returns {{code: 0, stdout: string, stderr: ''}}
 */
function _ok(result) {
  return { code: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
}

/**
 * @param {object} result
 * @returns {{code: 1, stdout: string, stderr: ''}}
 */
function _fail(result) {
  return { code: 1, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
}

/**
 * @param {string} message
 * @returns {{code: 2, stdout: '', stderr: string}}
 */
function _usageError(message) {
  return {
    code: 2,
    stdout: '',
    stderr: `backup-db: ${message}\n`
      + 'usage: node scripts/backup-db.js <create|verify|inspect|restore|prune> ...\n'
  };
}

/**
 * Run the CLI.
 * @param {string[]} argv - Arguments after the script name: the command,
 *   then its own positional and flag arguments.
 * @param {object} [backupLib] - `lib/backup.js`'s exports (a seam for tests).
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function main(argv, backupLib = require('../lib/backup')) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'create': {
        const { flags } = _parseArgs(rest);
        const opts = {};
        if (flags['claude-projects-dir']) opts.claudeProjectsDir = flags['claude-projects-dir'];
        if (flags['backups-root']) opts.backupsRoot = flags['backups-root'];
        if (flags['sqlite-db']) opts.sqliteDbPath = flags['sqlite-db'];
        if (flags['extra-memory-dir']) opts.extraMemoryDirs = _parseLabelDirPairs(flags['extra-memory-dir']);
        return _ok(backupLib.createMemoryBackup(opts));
      }
      case 'verify': {
        const [backupDir] = rest;
        if (!backupDir) return _usageError('verify requires <backupDir>');
        const result = backupLib.verifyMemoryBackup(backupDir);
        return result.ok ? _ok(result) : _fail(result);
      }
      case 'inspect': {
        const [backupDir] = rest;
        if (!backupDir) return _usageError('inspect requires <backupDir>');
        const result = backupLib.inspectMemoryBackup(backupDir);
        return result.verification.ok ? _ok(result) : _fail(result);
      }
      case 'restore': {
        const [backupDir, ...flagArgs] = rest;
        if (!backupDir) return _usageError('restore requires <backupDir>');
        const { flags } = _parseArgs(flagArgs);
        const opts = {};
        if (flags['claude-projects-dir']) opts.claudeProjectsDir = flags['claude-projects-dir'];
        if (flags['sqlite-dest']) opts.sqliteDestPath = flags['sqlite-dest'];
        if (flags['extra-memory-dest']) opts.extraMemoryDestDirs = _parseLabelDirMap(flags['extra-memory-dest']);
        if (flags['only-project']) opts.onlyProject = flags['only-project'];
        if (flags['dry-run']) opts.dryRun = true;
        return _ok(backupLib.restoreMemoryBackup(backupDir, opts));
      }
      case 'prune': {
        const [backupsRoot, ...flagArgs] = rest;
        if (!backupsRoot) return _usageError('prune requires <backupsRoot>');
        const { flags } = _parseArgs(flagArgs);
        const opts = {};
        if (flags['keep-last'] !== undefined) opts.keepLast = Number.parseInt(flags['keep-last'], 10);
        return _ok(backupLib.pruneMemoryBackups(backupsRoot, opts));
      }
      default:
        return _usageError(`unknown command "${command || ''}"`);
    }
  } catch (err) {
    return { code: 1, stdout: '', stderr: `backup-db: ${err.message}\n` };
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = main(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}

module.exports = { main, _parseArgs, _parseLabelDirPairs, _parseLabelDirMap };
