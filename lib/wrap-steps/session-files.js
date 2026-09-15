'use strict';

/**
 * `session-files` wrap step (#1406) — before the wrap writes anything, find the
 * uncommitted files this session did not change and ask the operator what to do
 * with each.
 *
 * The commit step used to run `git add -A`, so the operator's own uncommitted
 * work, and a co-resident session's, went into the wrap commit. The commit now
 * stages only what `./_file-ownership` allows. This step exists so the question
 * arrives at the start of the wrap, before any AI step runs, rather than at the
 * commit after all of them. The commit step checks again, because it is the step
 * that would do the damage.
 *
 * **Outcomes.**
 * - `done` — every uncommitted file is this session's, or has a decision. The
 *   output names what will be included and what will be left.
 * - `blocked` (a blocker) — at least one file needs a decision. The output lists
 *   each with the reason it is not the session's, and the drawer renders an
 *   Include / Leave choice per file that rides back as `options.pathDecisions`.
 * - `skipped` — the work tree is not a git repository.
 *
 * Also reports the tree being wrapped when it is a worktree the session moved
 * into (#1469), since this is the first row the operator reads.
 */

const { createLogger } = require('../logger');
const ownership = require('./_file-ownership');
const { execFileArgs } = require('./_exec-shell');

const log = createLogger('wrap-step-session-files');

/** Bound on the status read; `git status` is normally instant. */
const EXEC_TIMEOUT_MS = 30 * 1000;

/**
 * Step handler.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Scoped project record (`path` is the work tree)
 * @param {object} [context.scope] - The wrap run's scope (`lib/wrap-scope.js`)
 * @param {object} [context.options] - Reads `pathDecisions`
 * @returns {Promise<{ok:boolean, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, scope } = context;
  const workTree = scope && scope.worktreeTarget ? scope.workTree : null;
  if (scope && !scope.workToplevel && scope.workTreeProblem) {
    // Git failed rather than answering "not a repository": the wrap cannot tell
    // which files are the session's, and saying "not a git repository" would send
    // the operator to the wrong fix.
    return {
      ok: false,
      status: 'blocked',
      output: {
        workTree,
        remediation: `The wrap could not read this project's git repository, so it cannot tell which uncommitted files are this session's: ${scope.workTreeProblem}. Fix what git reports, then Retry.`
      },
      blockers: [`git could not be read: ${scope.workTreeProblem}`]
    };
  }
  if (!project || !project.path || !scope || !scope.workToplevel) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'not a git repository, so there are no uncommitted files to sort', workTree },
      blockers: []
    };
  }

  const res = await _internal.exec('git', ownership.statusArgs(), { cwd: project.path });
  if (res.exitCode !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim();
    return {
      ok: false,
      status: 'blocked',
      output: {
        workTree,
        remediation: res.timedOut
          ? '`git status` was stopped before it answered, so the wrap cannot tell which uncommitted files are this session\'s. An index lock left by another git process, or a very large untracked tree, is the usual cause. Check the repo, then Retry.'
          : 'The wrap could not read the uncommitted files, so it cannot tell which are this session\'s. Run `git status` in the project to see why, then Retry.'
      },
      blockers: [res.timedOut
        ? `git status did not finish and was stopped (${res.error || 'timed out'})`
        : `git status failed (exit ${res.exitCode})${detail ? `: ${detail}` : ''}`]
    };
  }

  const classified = ownership.classify(scope, ownership.parseStatus(res.stdout), {
    decisions: ownership.sanitizeDecisions(context.options && context.options.pathDecisions)
  });
  const summary = {
    workTree,
    // #1469: a session with a pane that is NOT being wrapped in a worktree says
    // why, so a failed pane read cannot silently put the wrap back on the checkout.
    checkoutReason: !workTree && scope.workTreeReason
      && !/^(no pane to read|pane is inside the registered checkout)$/.test(scope.workTreeReason)
      ? scope.workTreeReason : null,
    ownedCount: classified.owned.length,
    included: classified.included,
    left: classified.left,
    // #1508/#1509 — TangleClaw's own files, sorted out before anyone is asked.
    tangleclawMaintenance: classified.tangleclawMaintenance,
    tangleclawState: classified.tangleclawState
  };

  if (classified.undecided.length > 0) {
    log.info('wrap waiting on the operator for uncommitted files this session did not change', {
      project: project.name, count: classified.undecided.length
    });
    return {
      ok: false,
      status: 'blocked',
      output: {
        ...summary,
        foreignPaths: classified.undecided,
        remediation: ownership.remediation(classified.undecided)
      },
      blockers: [ownership.blockerLine(classified.undecided)]
    };
  }

  return { ok: true, status: 'done', output: { ...summary, detail: _detail(summary) }, blockers: [] };
}

/**
 * One line for the drawer row.
 *
 * @param {{workTree:(string|null), checkoutReason:(string|null), ownedCount:number, included:string[], left:string[],
 *   tangleclawMaintenance?:string[], tangleclawState?:string[]}} s
 * @returns {string}
 */
function _detail(s) {
  const parts = [];
  if (s.workTree) parts.push(`Wrapping worktree ${s.workTree}`);
  else if (s.checkoutReason) parts.push(`Wrapping the registered checkout (${s.checkoutReason})`);
  parts.push(`${s.ownedCount} changed since launch`);
  if (s.included.length) parts.push(`${s.included.length} included by you`);
  if (s.left.length) parts.push(`${s.left.length} left uncommitted`);
  const maintenance = (s.tangleclawMaintenance || []).length;
  const state = (s.tangleclawState || []).length;
  if (maintenance) parts.push(`${maintenance} TangleClaw update${maintenance === 1 ? '' : 's'} to commit`);
  if (state) parts.push(`${state} TangleClaw state file${state === 1 ? '' : 's'} not committed`);
  return parts.join(' · ');
}

const _internal = {
  exec: (file, args, options) => execFileArgs(file, args, {
    cwd: options.cwd, timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: 5 * 1024 * 1024
  })
};

module.exports = { run, _internal, _detail };
