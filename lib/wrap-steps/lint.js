'use strict';

/**
 * `lint` wrap step (#139 Chunk 4) — runs the project's `lintCommand`
 * against files changed in this session. "In-session" scope (Chunk 4)
 * means the working tree's staged + unstaged + untracked-but-tracked
 * file set, detected via `git status --porcelain`. Chunk 9 will widen
 * this to "since last wrap commit" once the `commit` step starts
 * stamping `lastWrapSha` on project records.
 *
 * Blocker semantics:
 *   - `step.blocker === "errors-only"`: exit code ≠ 0 → step returns
 *     `ok:false` (errors); exit code 0 with output → ok:true, output
 *     surfaced as informational warnings.
 *   - `step.blocker === false`: never returns `ok:false` (output is
 *     captured as informational, but the pipeline keeps going).
 *   - `step.blocker === true`: handler returns `ok:false` on exit ≠ 0;
 *     the runner halts the pipeline (the runner only acts on boolean
 *     `true`; the enum forms above are resolved here).
 *
 * No `lintCommand` configured → skipped (project opted out).
 * No in-session files → skipped (nothing to lint).
 *
 * Shell-quoting: file arguments are single-quote-escaped before being
 * appended to the user's `lintCommand` string. This keeps `lintCommand`
 * in its natural form ("npx eslint --max-warnings 0") while preventing
 * file-name injection (spaces, semicolons, backticks).
 */

const { exec } = require('node:child_process');
const { createLogger } = require('../logger');
const store = require('../store');
const { wasTimedOut } = require('../exec-timeout');

const log = createLogger('wrap-step-lint');

const EXEC_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — lint should be faster than test
/** Conventional shell exit code for a command killed by a timeout. */
const TIMEOUT_EXIT_CODE = 124;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const OUTPUT_TAIL_LINES = 50;

/**
 * Default shell exec — same shape as `test.js#defaultExecShell`. Exposed
 * via `_internal` so tests can inject without spawning real processes.
 *
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs] - Test seam; defaults to EXEC_TIMEOUT_MS.
 * @param {number} [options.maxBufferBytes] - Test seam; defaults to MAX_BUFFER_BYTES.
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, error:string|null}>}
 */
function defaultExecShell(command, options) {
  // The cap is overridable ONLY so a guard can drive the timeout path in
  // milliseconds instead of waiting out the real one. Production callers pass
  // nothing and get EXEC_TIMEOUT_MS; without this seam the mapping from a real
  // kill to `timedOut` is the one thing no test could reach — which is where
  // this defect lived undetected (#894).
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(options.maxBufferBytes)
    ? options.maxBufferBytes : MAX_BUFFER_BYTES;
  return new Promise((resolve) => {
    exec(command, {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer,
      env: process.env
    }, (err, stdout, stderr) => {
      // `wasTimedOut`, not `err.code === undefined && err.killed`: async `exec`
      // DOES set `killed`, but its `code` is `null` rather than `undefined`, so
      // this branch died on its first clause and a killed command fell through
      // as an ordinary non-zero exit — reported to the operator as a failure
      // that never happened (#894).
      if (wasTimedOut(err)) {
        resolve({
          exitCode: TIMEOUT_EXIT_CODE,
          stdout: stdout || '',
          stderr: stderr || '',
          error: `timed out after ${timeoutMs}ms`,
          timedOut: true
        });
        return;
      }
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        exitCode,
        stdout: stdout || '',
        stderr: stderr || '',
        // A NUMERIC code means the command ran and exited; anything else is a
        // spawn-level failure (`ENOENT` for a command that is not installed),
        // which the old `=== undefined` test also never caught — so a mistyped
        // command reported as a plain failure with no error either.
        error: err && typeof err.code !== 'number' ? err.message : null,
        timedOut: false
      });
    });
  });
}

/**
 * Detect files changed in this session via `git status --porcelain`.
 * Returns repo-relative paths for tracked-modified, staged, and
 * untracked files. Renames map to the new path. Deleted files are
 * excluded (no file on disk to lint).
 *
 * Returns an empty array if the project is not a git repo or git is
 * unavailable — degrades to "no files, skip" rather than throwing.
 *
 * @param {string} cwd - Project root
 * @returns {Promise<string[]>}
 */
function defaultDetectChangedFiles(cwd) {
  return new Promise((resolve) => {
    exec('git status --porcelain', {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: process.env
    }, (err, stdout) => {
      if (err) {
        log.warn('git status failed in lint step', { cwd, error: err.message });
        resolve([]);
        return;
      }
      const files = [];
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        // Porcelain format: "XY path" or "XY path -> newpath" for renames.
        // Status code chars occupy cols 0-1; path starts at col 3.
        const xy = line.slice(0, 2);
        const rest = line.slice(3);
        // Skip deletes — nothing on disk to lint.
        if (xy.includes('D')) continue;
        // Handle rename arrow → keep the destination path.
        const arrowIdx = rest.indexOf(' -> ');
        const filePath = arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest;
        // Strip porcelain quoting if present (paths with special chars).
        const cleaned = filePath.startsWith('"') && filePath.endsWith('"')
          ? filePath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          : filePath;
        files.push(cleaned);
      }
      resolve(files);
    });
  });
}

/**
 * Single-quote-escape a shell argument. Wraps the string in single
 * quotes and escapes any internal single quotes via the standard
 * `'\''` close-reopen idiom.
 *
 * @param {string} s
 * @returns {string}
 */
function _shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Take the last N lines of a string for surfacing in output/blockers.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function _tail(s, n) {
  if (!s) return '';
  return s.split('\n').slice(-n).join('\n');
}

/**
 * Step handler. See module docstring for semantics.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, step } = context;

  const cfg = store.projectConfig.load(project.path);
  const lintCommand = cfg.lintCommand;

  if (!lintCommand) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no lintCommand configured' },
      blockers: []
    };
  }

  const files = await _internal.detectChangedFiles(project.path);
  if (files.length === 0) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no in-session changes to lint' },
      blockers: []
    };
  }

  const quotedFiles = files.map(_shellQuote).join(' ');
  // `--` is the POSIX end-of-options separator. Without it, a git-legal
  // filename like `-rf.js` would be interpreted by eslint / prettier as
  // a flag rather than a path. Standard hardening for command lines
  // built from arbitrary paths.
  const fullCommand = `${lintCommand} -- ${quotedFiles}`;

  const execResult = await _internal.execShell(fullCommand, { cwd: project.path });

  const blocker = step.blocker;
  const tail = _tail(execResult.stderr || execResult.stdout, OUTPUT_TAIL_LINES);

  // exit 0 — lint passed (or warnings-only; same outcome for now)
  if (execResult.exitCode === 0) {
    return {
      ok: true,
      status: 'done',
      output: { exitCode: 0, filesLinted: files.length, warnings: tail || null },
      blockers: []
    };
  }

  // exit ≠ 0 — diverge by blocker mode
  if (blocker === false) {
    // Informational; never blocks.
    return {
      ok: true,
      status: 'done',
      output: { exitCode: execResult.exitCode, filesLinted: files.length, warnings: tail },
      blockers: []
    };
  }

  // A KILLED command and a FAILING lint need different words. "Fix the lint
  // errors shown above" is wrong advice when nothing finished and there are no
  // errors to show (#894).
  if (execResult.timedOut) {
    return {
      ok: false,
      status: 'blocked',
      output: {
        exitCode: execResult.exitCode,
        filesLinted: files.length,
        remediation: `The lint command did not finish within ${EXEC_TIMEOUT_MS / 60000} minutes and was stopped, so it reported nothing. Run it locally to see where it hangs. Nothing here says a file failed lint.`
      },
      blockers: [
        `Lint command timed out after ${EXEC_TIMEOUT_MS / 60000} minutes (exit ${execResult.exitCode})`,
        ...(tail ? [tail] : [])
      ]
    };
  }

  // blocker === true OR blocker === "errors-only": exit ≠ 0 → block.
  // The runner halts on either case (see `lib/wrap-pipeline.js` blocker
  // semantics). Any other blocker value falls through to the `false`
  // branch above (informational only).
  const blockers = [`Lint failed (exit ${execResult.exitCode}) on ${files.length} file(s)`];
  if (tail) blockers.push(tail);
  if (execResult.error) blockers.push(`exec error: ${execResult.error}`);

  return {
    ok: false,
    status: 'blocked',
    output: {
      exitCode: execResult.exitCode,
      filesLinted: files.length,
      remediation: 'The lint command reported errors. Fix the lint errors shown above (many linters auto-fix with a `--fix` flag), then re-run the wrap.'
    },
    blockers
  };
}

const _internal = {
  execShell: defaultExecShell,
  detectChangedFiles: defaultDetectChangedFiles
};

module.exports = { run, _internal, _shellQuote };
