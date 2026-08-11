'use strict';

/**
 * `test` wrap step (#139 Chunk 4) — runs the project's `testCommand`
 * (loaded from `<projectPath>/.tangleclaw/project.json`). Non-zero exit
 * → the step returns `ok:false` with the command's stderr/stdout tail in
 * `blockers`. With `step.blocker === true`, the runner halts the
 * pipeline on that result; otherwise the failure is informational.
 *
 * Override path: when `step.allowOverride === true` AND
 * `context.options.skipTests === true`, the test step is reported as
 * `skipped` with an `output.override` flag so the eventual `commit`
 * step (Chunk 9) can record the skip in the wrap commit body.
 *
 * No `testCommand` configured → `skipped` with a reason — every project
 * is allowed to opt out of tests, and a missing command must not block.
 */

const { createLogger } = require('../logger');
const store = require('../store');
const { execShell } = require('./_exec-shell');

const log = createLogger('wrap-step-test');

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — long enough for real test suites; bounded so a hung process can't wedge the wrap UI forever
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB — generous; truncated to a tail before surfacing
const OUTPUT_TAIL_LINES = 50;

/**
 * This step's shell runner: the shared runner plus this step's own caps.
 *
 * The caps are overridable ONLY so a guard can drive the timeout and overflow
 * paths in milliseconds instead of waiting out the real ones. Production callers
 * pass neither. Without that seam the mapping from a real kill to `timedOut` is
 * the one thing no test could reach — which is exactly where this defect lived
 * undetected (#894).
 *
 * @param {string} command - Shell command string.
 * @param {object} options - Run options.
 * @param {string} options.cwd - Working directory.
 * @param {number} [options.timeoutMs] - Test seam; defaults to EXEC_TIMEOUT_MS.
 * @param {number} [options.maxBufferBytes] - Test seam; defaults to MAX_BUFFER_BYTES.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   error: string|null, timedOut: boolean}>}
 */
function defaultExecShell(command, options) {
  return execShell(command, {
    cwd: options.cwd,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS,
    maxBufferBytes: Number.isFinite(options.maxBufferBytes)
      ? options.maxBufferBytes : MAX_BUFFER_BYTES
  });
}

/**
 * Take the last N lines of a string for surfacing in blockers/output.
 * Empty or null input returns an empty string.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function _tail(s, n) {
  if (!s) return '';
  const lines = s.split('\n');
  return lines.slice(-n).join('\n');
}

/**
 * Step handler. See module docstring for semantics.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (id, name, path)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} [context.options] - Caller options (e.g. `skipTests`)
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, step } = context;
  const options = context.options || {};

  const cfg = store.projectConfig.load(project.path);
  const testCommand = cfg.testCommand;

  if (!testCommand) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no testCommand configured' },
      blockers: []
    };
  }

  if (step.allowOverride === true && options.skipTests === true) {
    log.info('test step skipped via user override', { project: project.name });
    return {
      ok: true,
      status: 'skipped',
      output: { override: true, reason: 'user opted to skip tests' },
      blockers: []
    };
  }

  const execResult = await _internal.execShell(testCommand, { cwd: project.path });

  if (execResult.exitCode === 0) {
    return {
      ok: true,
      status: 'done',
      output: { exitCode: 0 },
      blockers: []
    };
  }

  const tail = _tail(execResult.stderr || execResult.stdout, OUTPUT_TAIL_LINES);

  // A KILLED command and a FAILING suite need different words. Telling someone
  // whose test command hung to "fix the failing test(s) shown above" sends them
  // after a failure that never happened — there is no result to read, because
  // nothing finished (#894).
  if (execResult.timedOut) {
    // The serious half of #894 left no trace anywhere an operator or a support
    // question could find it: `lib/tmux.js` got a log line, this did not, and
    // `wrap-pipeline.js` does not persist step results.
    log.warn('Test command timed out', {
      project: project.name, timeoutMs: EXEC_TIMEOUT_MS, exitCode: execResult.exitCode
    });
    return {
      ok: false,
      status: 'blocked',
      output: {
        exitCode: execResult.exitCode,
        remediation: `The test command did not finish within ${EXEC_TIMEOUT_MS / 60000} minutes and was stopped, so there is no pass/fail result to read. Run it locally to see where it hangs — a watch mode left on, a prompt waiting for input, or a suite that genuinely needs longer are the usual causes. Nothing here says a test failed.`
      },
      blockers: [
        `Test command timed out after ${EXEC_TIMEOUT_MS / 60000} minutes (exit ${execResult.exitCode})`,
        ...(tail ? [tail] : [])
      ]
    };
  }

  const blockers = [`Tests failed (exit ${execResult.exitCode})`];
  if (tail) blockers.push(tail);
  if (execResult.error) blockers.push(`exec error: ${execResult.error}`);

  return {
    ok: false,
    status: 'blocked',
    output: {
      exitCode: execResult.exitCode,
      remediation: 'The test command exited non-zero. Run the suite locally, fix the failing test(s) shown above, and re-run the wrap. If the failure is unrelated to this session and you accept it knowingly, use the drawer’s "skip tests" override (recorded in the commit body).'
    },
    blockers
  };
}

const _internal = { execShell: defaultExecShell };

module.exports = { run, _internal };
