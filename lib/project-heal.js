'use strict';

/**
 * Heal TangleClaw's footprint in a project at launch (#1511).
 *
 * TangleClaw writes machine state into the projects it manages. Older versions
 * kept the wrap boundary inside `.tangleclaw/project.json`, and nothing told git
 * to ignore the state files, so they churned in `git status` and, where a
 * project had committed them, in every diff. This runs where TangleClaw is about
 * to use the project and repairs what it can without asking:
 *
 * 1. moves a leftover `lastWrapSha` out of `project.json` (`wrap-state`);
 * 2. writes TangleClaw's state paths into the repository's LOCAL exclude file
 *    (`info/exclude`, never `.gitignore`), inside a delimited block it owns;
 * 3. reports which state files git still tracks, other than those the operator
 *    chose to keep tracked — an exclude cannot hide a
 *    tracked file, and removing one from tracking is a commit, which only the
 *    wrap may offer (#1512).
 *
 * **It never creates a commit** and never runs a git command that writes:
 * only `rev-parse` and `ls-files`. Plain git and plain files, so it is the same
 * on every engine. It never throws; every failure becomes a stated reason.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createLogger } = require('./logger');
const wrapState = require('./wrap-state');
const tcOwned = require('./wrap-steps/_tc-owned-paths');
const untrackOffer = require('./wrap-steps/_untrack-offer');

const log = createLogger('project-heal');

/** Delimiters of the block TangleClaw owns inside `info/exclude`. */
const EXCLUDE_BEGIN = '# BEGIN:tangleclaw-state (machine state TangleClaw rewrites; local to this clone, managed by TangleClaw)';
const EXCLUDE_END = '# END:tangleclaw-state';

/** Bound on each git read. */
const GIT_TIMEOUT_MS = 10 * 1000;

/**
 * Seams, so tests can drive failures without breaking a real repository.
 */
const _internal = {
  // The C locale, because `_locate` recognises "not a git repository" by git's
  // message, and a translated message would turn a plain folder into a failure.
  git: (cwd, args) => execFileSync('git', args, {
    cwd, env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024
  }),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  writeFile: (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
};

/**
 * Where this project sits in its repository.
 *
 * @param {string} projectPath - Absolute project root.
 * @returns {{ok:true, toplevel:string, prefix:string, excludeFile:string}|{ok:false, reason:string, notARepo:boolean}}
 */
function _locate(projectPath) {
  let out;
  try {
    out = _internal.git(projectPath, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-path', 'info/exclude']);
  } catch (err) {
    const stderr = String((err && err.stderr) || '').trim();
    if (/not a git repository/i.test(stderr)) return { ok: false, reason: 'not a git repository', notARepo: true };
    return { ok: false, reason: `git could not locate the repository: ${stderr.split('\n')[0] || (err && err.message) || 'unknown error'}`, notARepo: false };
  }
  const [toplevel, prefix, gitPath] = String(out).split('\n');
  if (!toplevel || gitPath === undefined || gitPath === '') {
    return { ok: false, reason: 'git gave an unexpected answer locating the repository', notARepo: false };
  }
  // `--git-path` answers relative to the working directory unless it is absolute;
  // in a worktree it resolves to the common git dir, which is where git reads it.
  return { ok: true, toplevel, prefix, excludeFile: path.resolve(projectPath, gitPath) };
}

/**
 * The exclude file's text with TangleClaw's block set to `patterns`. Every line
 * outside the block is kept byte for byte.
 *
 * @param {string} current - Current file text ('' when absent).
 * @param {string[]} patterns - Anchored gitignore patterns.
 * @returns {{text:string, changed:boolean}|{error:string}}
 */
function renderExclude(current, patterns) {
  const block = [EXCLUDE_BEGIN, ...patterns, EXCLUDE_END].join('\n');
  const lines = current.split('\n');
  const begins = lines.reduce((acc, l, i) => (l === EXCLUDE_BEGIN ? [...acc, i] : acc), []);
  const ends = lines.reduce((acc, l, i) => (l === EXCLUDE_END ? [...acc, i] : acc), []);
  if (begins.length === 0 && ends.length === 0) {
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    return { text: `${current}${sep}${block}\n`, changed: true };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    return { error: 'the TangleClaw block in the exclude file is malformed (a marker is missing or repeated), so it was left alone' };
  }
  const text = [...lines.slice(0, begins[0]), block, ...lines.slice(ends[0] + 1)].join('\n');
  return { text, changed: text !== current };
}

/**
 * Tracked paths that are TangleClaw state.
 *
 * @param {string} toplevel - Repository root.
 * @returns {{paths:string[], error:(string|null)}}
 */
function trackedStatePaths(toplevel) {
  try {
    const out = _internal.git(toplevel, ['ls-files', '-z', '--', '.tangleclaw']);
    return { paths: String(out).split('\0').filter((p) => p && tcOwned.isStatePath(p)), error: null };
  } catch (err) {
    return { paths: [], error: `git ls-files failed: ${String((err && err.stderr) || (err && err.message) || '').trim().split('\n')[0]}` };
  }
}

/**
 * Repair TangleClaw's footprint in one project. Idempotent: a second call on an
 * unchanged project writes nothing and reports nothing.
 *
 * @param {string} projectPath - Absolute project root (the registered checkout).
 * @param {object} [opts]
 * @param {() => Date} [opts.now] - Test seam for the migration stamp.
 * @returns {{report:(string|null), migrated:boolean, migrateReason:string,
 *   exclude:('added'|'updated'|'current'|'skipped'), excludeReason:(string|null), trackedState:string[]}}
 */
function healOnLaunch(projectPath, opts = {}) {
  const result = { report: null, migrated: false, migrateReason: '', exclude: 'skipped', excludeReason: null, trackedState: [] };
  const problems = [];

  const migration = wrapState.migrateProjectConfig(projectPath, opts);
  result.migrated = migration.migrated;
  result.migrateReason = migration.reason;
  if (migration.failed) problems.push(migration.reason);

  const where = _locate(projectPath);
  if (!where.ok) {
    result.excludeReason = where.reason;
    if (!where.notARepo) problems.push(where.reason);
  } else if (where.prefix) {
    // The state paths are repository-root-relative; a project below the root
    // would need every pattern re-anchored and every tracked path re-mapped.
    result.excludeReason = `project is registered below its repository root (${where.prefix.replace(/\/$/, '')}), so its state paths are not excluded`;
  } else {
    let current = '';
    let readable = true;
    try {
      current = _internal.readFile(where.excludeFile);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        readable = false;
        result.excludeReason = `the exclude file could not be read: ${err.message}`;
        problems.push(result.excludeReason);
      }
    }
    if (readable) {
      const rendered = renderExclude(current, tcOwned.statePatterns());
      if (rendered.error) {
        result.excludeReason = rendered.error;
        problems.push(rendered.error);
      } else if (!rendered.changed) {
        result.exclude = 'current';
      } else {
        try {
          _internal.writeFile(where.excludeFile, rendered.text);
          result.exclude = current.includes(EXCLUDE_BEGIN) ? 'updated' : 'added';
        } catch (err) {
          result.excludeReason = `the exclude file could not be written: ${err.message}`;
          problems.push(result.excludeReason);
        }
      }
    }
    const tracked = trackedStatePaths(where.toplevel);
    // What the wrap would offer, by the wrap's own rule, so this line cannot promise
    // an offer the wrap will not make (#1512).
    result.trackedState = untrackOffer.resolve({
      tracked: tracked.paths, declined: wrapState.readUntrackDeclined(projectPath), answer: null
    }).pending;
    if (tracked.error) problems.push(tracked.error);
  }

  const parts = [];
  if (result.migrated) parts.push('moved lastWrapSha out of project.json into the untracked .tangleclaw/state.json');
  if (result.exclude === 'added' || result.exclude === 'updated') parts.push('listed TangleClaw\'s state files in this clone\'s local git exclude');
  if (result.trackedState.length) {
    const n = result.trackedState.length;
    parts.push(`${n} TangleClaw state file${n === 1 ? ' is' : 's are'} still tracked by git (the wrap offers to stop tracking ${n === 1 ? 'it' : 'them'})`);
  }
  for (const p of problems) parts.push(`could not finish: ${p}`);
  result.report = parts.length ? `TangleClaw housekeeping: ${parts.join('; ')}. Nothing was committed.` : null;

  log.info('Launch heal', {
    projectPath,
    migrated: result.migrated,
    exclude: result.exclude,
    excludeReason: result.excludeReason,
    tracked: result.trackedState.length,
    problems
  });
  return result;
}

module.exports = {
  healOnLaunch,
  renderExclude,
  trackedStatePaths,
  EXCLUDE_BEGIN,
  EXCLUDE_END,
  _internal
};
