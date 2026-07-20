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

const { exec } = require('node:child_process');
const { createLogger } = require('../logger');
const store = require('../store');

const log = createLogger('wrap-step-test');

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — long enough for real test suites; bounded so a hung process can't wedge the wrap UI forever
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB — generous; truncated to a tail before surfacing
const OUTPUT_TAIL_LINES = 50;

/**
 * Default shell exec. Resolves to a structured result; never throws on
 * non-zero exit (that's the success path for "tests failed"). Exposed
 * via `_internal` so tests can inject without spawning real processes.
 *
 * @param {string} command - Shell command string (e.g. "npm test")
 * @param {object} options
 * @param {string} options.cwd - Working directory
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, error: string|null}>}
 */
function defaultExecShell(command, options) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: process.env
    }, (err, stdout, stderr) => {
      if (err && err.code === undefined && err.killed) {
        // Killed by timeout — surface as a synthetic non-zero exit
        resolve({ exitCode: 124, stdout: stdout || '', stderr: stderr || '', error: 'timed out' });
        return;
      }
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        exitCode,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err && err.code === undefined ? err.message : null
      });
    });
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
