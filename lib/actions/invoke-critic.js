'use strict';

/**
 * `invoke-critic` action handler (#139 Chunk 11b) — the write side of
 * the contract that `lib/wrap-steps/critic-check.js` (Chunk 7) reads.
 *
 * Appends an entry to `<project>/.tangleclaw/critic-runs.json` so the
 * `critic-check` wrap step's `criticRan` predicate can flip to `true`
 * for the current branch. Without this writer, `critic-check` always
 * emitted `warning: true` on medium+ work because no producer existed
 * for the file it reads. Chunk 11c flips `wrapV2: true` by default; in
 * that world, every prawduct wrap that crossed the medium+ heuristic
 * would warn forever without this handler.
 *
 * **Entry shape (matches Chunk 7 read contract):**
 *   `{branchName: string, timestamp: ISO 8601 string}`
 *
 * `critic-check.js:defaultLoadCriticRuns` defensively filters entries
 * lacking a string `branchName`, so a partial write or schema drift
 * never crashes the reader. This writer always produces both fields.
 *
 * **Concurrent-write race.** TangleClaw is single-process; Node JS is
 * single-threaded; this handler runs synchronously (no `await` between
 * the read and the write). Two HTTP requests cannot interleave their
 * read-modify-write within a single Node process. The atomic temp +
 * rename below additionally guarantees that a power-loss / kill-9
 * mid-write can never leave the file in a half-written state — readers
 * see either the pre-write content or the full post-write content.
 *
 * **Containment.** `project.path` is the only filesystem-rooting input;
 * the handler refuses an empty path and never writes outside
 * `<project.path>/.tangleclaw/`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createLogger } = require('../logger');

const log = createLogger('actions:invoke-critic');

const CRITIC_RUNS_RELPATH = path.join('.tangleclaw', 'critic-runs.json');

/**
 * Resolve the current git branch in `cwd`. Returns `null` for detached
 * HEAD, non-repo, missing git, or any other failure. Sync so the
 * caller can stay synchronous and avoid concurrent read-modify-write
 * windows.
 * @param {string} cwd
 * @returns {string|null}
 */
function defaultResolveBranchName(cwd) {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Hard cap so a pathological repo state (filesystem hang, broken
      // packed-refs, git-lfs prompting on stdin) cannot stall the
      // single-process server's event loop.
      timeout: 5000
    }).trim();
    if (!out || out === 'HEAD') return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Read existing critic-runs.json into an array. Returns `[]` on every
 * non-array outcome (missing file, malformed JSON, top-level object,
 * read error). The reader in `critic-check.js` applies the same
 * "tolerant degrade to empty" policy, so writer + reader stay
 * symmetric — a malformed file is silently rebuilt on next write
 * rather than producing a hard error.
 * @param {string} filePath
 * @returns {object[]}
 */
function loadExisting(filePath) {
  if (!fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log.warn('failed to read critic-runs.json before append', { filePath, error: err.message });
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('critic-runs.json malformed; rebuilding from empty', { filePath, error: err.message });
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Append a critic-run entry for `project` and persist atomically.
 *
 * @param {{path: string, name?: string}} project - Project record. `path`
 *   is the absolute project root; `.tangleclaw/critic-runs.json` is
 *   created inside it. `name` is used only for log lines.
 * @param {object} [options]
 * @param {string} [options.branchName] - Pre-resolved branch name. When
 *   omitted, the handler resolves via `git rev-parse --abbrev-ref HEAD`
 *   in `project.path`. Tests inject this seam.
 * @param {() => Date} [options.now] - Time-injection seam for tests.
 * @returns {{ok: boolean, output: object|null, error: string|null}}
 */
function run(project, options = {}) {
  if (!project || typeof project.path !== 'string' || !project.path.trim()) {
    return { ok: false, output: null, error: 'invoke-critic requires a non-empty project.path' };
  }

  const branchName = (typeof options.branchName === 'string' && options.branchName.trim())
    ? options.branchName.trim()
    : defaultResolveBranchName(project.path);

  if (!branchName) {
    return {
      ok: false,
      output: null,
      error: 'could not resolve current git branch (detached HEAD, not a git repo, or git missing)'
    };
  }

  const tangleclawDir = path.join(project.path, '.tangleclaw');
  const filePath = path.join(tangleclawDir, 'critic-runs.json');

  try {
    fs.mkdirSync(tangleclawDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      output: null,
      error: `failed to create .tangleclaw directory: ${_redactProjectPath(err.message, project.path)}`
    };
  }

  const existing = loadExisting(filePath);
  const now = typeof options.now === 'function' ? options.now() : new Date();
  const entry = {
    branchName,
    timestamp: now.toISOString()
  };
  const updated = existing.concat([entry]);

  // Atomic write: write to tmp file in the same directory, then
  // rename. POSIX rename within the same filesystem is atomic — a
  // concurrent reader sees either the old file or the new file, never
  // a partial write.
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', { encoding: 'utf8' });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist if writeFile threw before creating */ }
    return {
      ok: false,
      output: null,
      error: `failed to write critic-runs.json: ${_redactProjectPath(err.message, project.path)}`
    };
  }

  log.info('invoke-critic recorded critic run', {
    project: project.name,
    branchName,
    totalRuns: updated.length
  });

  return {
    ok: true,
    output: { entry, totalRuns: updated.length, filePath: CRITIC_RUNS_RELPATH },
    error: null
  };
}

/**
 * Replace absolute `projectPath` occurrences in an error message with
 * the literal `<project>` placeholder. Errors from `fs.*` include the
 * full absolute path of the operand; surfacing that through the HTTP
 * API leaks the server's filesystem layout. Project-relative paths
 * inside `.tangleclaw/` are preserved so the user still sees which
 * file the operation touched.
 *
 * @param {string} message
 * @param {string} projectPath
 * @returns {string}
 */
function _redactProjectPath(message, projectPath) {
  if (typeof message !== 'string' || !projectPath) return message;
  // Substring replacement is sufficient — fs error messages contain
  // the path verbatim; regex would over-match on shared prefixes.
  return message.split(projectPath).join('<project>');
}

module.exports = {
  run,
  loadExisting,
  defaultResolveBranchName,
  CRITIC_RUNS_RELPATH,
  _redactProjectPath
};
