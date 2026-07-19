'use strict';

/**
 * `pr-merge` wrap step (#570) — applies the PR resolutions the `pr-check`
 * gate collected, by enqueueing GitHub auto-merge for every PR the operator
 * resolved as `merge`.
 *
 * **Why this is a separate step from the gate.** The two halves have opposite
 * ordering requirements. The gate must run EARLY: it blocks on an undecided
 * PR, and blocking is only cheap before the AI-content steps have prompted
 * the session and before `commit` has landed. The merge must run LATE: it
 * merges the PR that the wrap commit belongs to, so enqueueing it before
 * `commit` would merge a PR missing that commit — and `--delete-branch` could
 * delete the branch mid-wrap. One step cannot be both first and last, so the
 * decision is gated up front and applied at the end.
 *
 * **This step never blocks.** It runs after `commit`, so a halt here would
 * strand the wrap half-finished — the commit landed, the session's AI steps
 * already fired, but the pipeline reports failure and the session lifecycle
 * never completes. A failed enqueue is also not something a retry fixes
 * (auto-merge disabled on the repo, a closed PR): it needs the operator to
 * act on GitHub. So a failure surfaces as `output.warning` with remediation
 * and the wrap completes honestly, rather than trading a stale PR for a
 * stranded session.
 *
 * **Input.** Duck-typed on the staged shape `{resolutions, sessionScoped}`
 * rather than keyed to the gate's step id, so a template that renames its
 * gate step still feeds this one.
 */

const prCheck = require('./pr-check');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-pr-merge');

/**
 * Find the staged PR resolutions produced by the gate. Shape-typed: the
 * first staged entry carrying a `resolutions` object alongside a
 * `sessionScoped` array wins.
 *
 * @param {Record<string, object>} staged - Pipeline scratch space
 * @returns {{resolutions: Record<string,string>}|null}
 */
function _findStagedResolutions(staged) {
  if (!staged || typeof staged !== 'object') return null;
  for (const entry of Object.values(staged)) {
    if (entry
        && typeof entry.resolutions === 'object' && entry.resolutions !== null
        && Array.isArray(entry.sessionScoped)) {
      return entry;
    }
  }
  return null;
}

/**
 * Step handler. See module docstring for the full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:true, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, step, staged } = context;

  if (!project || !project.path) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'pr-merge requires context.project.path' },
      blockers: []
    };
  }

  const entry = _findStagedResolutions(staged);
  if (!entry) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no PR resolutions were staged this wrap' },
      blockers: []
    };
  }

  const merges = Object.keys(entry.resolutions).filter((n) => entry.resolutions[n] === 'merge');
  if (merges.length === 0) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no PR was resolved as merge', resolutions: entry.resolutions },
      blockers: []
    };
  }

  const { applied, failures } = await prCheck._applyResolutions(project.path, entry.resolutions);
  // Record the outcome back onto the gate's staged entry so anything reading
  // the wrap's staged state sees what actually happened, not just what was
  // asked for. `commit` has already run, so this is a record, not an input.
  entry.applied = applied;

  const output = {
    resolutions: entry.resolutions,
    applied,
    enqueued: merges.length - failures.length,
    failures
  };

  if (failures.length > 0) {
    output.warning = true;
    output.remediation = 'Auto-merge could not be enqueued. Enable it for the repository '
      + '(Settings → Pull Requests → Allow auto-merge), or merge the PR yourself. '
      + 'The wrap itself completed — nothing needs to be re-run.';
    log.warn('pr-merge could not enqueue every auto-merge', {
      project: project.name, failures
    });
    return { ok: true, status: 'done', output, blockers: [] };
  }

  log.info('pr-merge enqueued auto-merge', { project: project.name, enqueued: merges.length });
  return { ok: true, status: 'done', output, blockers: [] };
}

module.exports = { run, _findStagedResolutions };
