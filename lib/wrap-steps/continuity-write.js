'use strict';

/**
 * `continuity-write` wrap step (CC-1) — the WRITE half of the Continuity
 * Contract's thin first slice. Runs AFTER `commit` so its freshness stamp
 * anchors to the wrap commit's HEAD, and rewrites the project's hot
 * continuity index (`lib/continuity.js`) from:
 *
 *   - the `Next action` + `Where we are` the AI captured this wrap
 *     (a prior `ai-content` step's `parsedFields`), and
 *   - server-side git facts (short sha + branch).
 *
 * The next session's prime reads that index back and offers a visible
 * "we left off at X — continue?" resume (see `generatePrimePrompt`).
 *
 * **Mechanical floor / honest emptiness.** This step NEVER blocks a wrap
 * (`blocker: false` in the template, and it returns `ok: true` even when
 * inputs are missing). With no AI capture it still writes the freshness
 * stamp and a flagged-empty Next action rather than fabricating one — the
 * contract's "missing judgment is flagged-empty, never fabricated" rule.
 *
 * **Store is gitignored.** The index lives under `.tangleclaw/continuity/`
 * (gitignored), so writing it directly here — rather than staging for the
 * `commit` step — is correct: it must be on disk for the next prime, and
 * it should never land in the wrap commit. This is also why the step runs
 * after `commit` without needing a second commit.
 */

const { execFile } = require('node:child_process');
const continuity = require('../continuity');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-continuity-write');

const EXEC_TIMEOUT_MS = 30 * 1000;

/**
 * Thin `execFile` wrapper mirroring `commit.js:defaultExec` — resolves to
 * a structured result, never throws on non-zero exit. Overridable via
 * `_internal` so tests can stub git without a real repo.
 * @param {string} file
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string}>}
 */
function defaultExec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ exitCode, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

/**
 * Resolve the AI-captured continuity fields from prior step results.
 * Duck-typed on shape rather than keyed by step id (so a methodology that
 * renames its summary step still feeds continuity): scans for the most
 * recent prior result whose `output.parsedFields` carries a `summary` or
 * `nextSteps`. The prawduct `memory-update` step produces exactly this.
 *
 * @param {Array} previousResults - Runner's prior-step results
 * @returns {{currentState:string, nextAction:string}}
 */
function _resolveCapturedFields(previousResults) {
  const out = { currentState: '', nextAction: '' };
  if (!Array.isArray(previousResults)) return out;
  for (let i = previousResults.length - 1; i >= 0; i--) {
    const pf = previousResults[i] && previousResults[i].output && previousResults[i].output.parsedFields;
    if (pf && (pf.summary || pf.nextSteps)) {
      out.currentState = (pf.summary || '').trim();
      out.nextAction = (pf.nextSteps || '').trim();
      return out;
    }
  }
  return out;
}

/**
 * Read short HEAD sha + branch for the freshness stamp. Best-effort: a
 * non-repo or git failure yields empty values (renderIndex flags them
 * `unknown`) — the wrap still completes.
 * @param {string} cwd - Project root
 * @returns {Promise<{sha:string, branch:string}>}
 */
async function _gitFacts(cwd) {
  const facts = { sha: '', branch: '' };
  try {
    const sha = await _internal.exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    if (sha.exitCode === 0) facts.sha = sha.stdout.trim();
    const branch = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    if (branch.exitCode === 0) facts.branch = branch.stdout.trim();
  } catch (err) {
    log.debug('git facts unavailable for continuity stamp', { cwd, error: err.message });
  }
  return facts;
}

/**
 * Step handler. See module docstring for the full contract.
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record
 * @param {Array} context.previousResults - Prior step results
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, previousResults } = context;

  const captured = _resolveCapturedFields(previousResults || []);
  const facts = await _gitFacts(project.path);
  const writtenAt = _internal.today();

  let indexFile;
  try {
    indexFile = continuity.writeIndex(project.path, {
      project: project.name,
      currentState: captured.currentState,
      nextAction: captured.nextAction,
      freshness: { sha: facts.sha, branch: facts.branch, writtenAt }
    });
  } catch (err) {
    // Continuity is never worth halting a wrap over — record a note, not a
    // blocker. The `blocker: false` template entry already prevents a halt;
    // returning ok:false here would still surface a red row, so we keep it
    // honest as a non-blocking 'done' with the error in output.
    log.warn('Failed to write continuity index', { project: project.name, error: err.message });
    return {
      ok: true,
      status: 'done',
      output: { written: false, error: err.message },
      blockers: []
    };
  }

  const hadCapture = Boolean(captured.currentState || captured.nextAction);
  log.info('Continuity index written', {
    project: project.name,
    indexFile,
    hadCapture,
    sha: facts.sha
  });

  return {
    ok: true,
    status: 'done',
    output: {
      written: true,
      indexPath: indexFile,
      hadCapture,
      nextAction: captured.nextAction
    },
    blockers: []
  };
}

const _internal = {
  exec: defaultExec,
  today: () => new Date().toISOString().slice(0, 10)
};

module.exports = { run, _internal, _resolveCapturedFields };
