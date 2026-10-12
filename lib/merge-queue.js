'use strict';

/**
 * The merge queue's two rules of motion: one call at a time per queue, and
 * what one `advance` does.
 *
 * **One call at a time.** A call that reads an entry's state, waits on GitHub
 * and then writes can be overtaken by another call on the same queue: an entry
 * could gain a candidate while a withdrawal is deciding it has none, and leave
 * the queue with both branches still on GitHub. So a call that waits between
 * reading and writing takes its queue's slot for as long as it runs, and a
 * second such call is refused rather than queued behind it: the caller reads
 * the queue and decides again on what it then says.
 *
 * The slot is held in this process's memory. One server process serves an
 * install, and a restart frees every slot, which is safe because each call that
 * takes one is harmless to repeat.
 *
 * **One step per advance.** {@link advance} moves the entry at the front of a
 * queue one step and no further, so the longest a call can take is bounded:
 * it makes the entry's candidate, or, once the candidate's `test` has
 * concluded, checks everything again and merges the pull request, or fails the
 * entry with the reason. Nothing advances on a timer: an owner that is not
 * there lands nothing.
 *
 * Everything a landing rests on is read in the call that merges: the pull
 * request is open at the submitted head, the base branch has not moved since
 * the candidate was made, the candidate's `test` concluded success, the base
 * branch's own `test` is not red, every gate is recorded, and merging changes
 * no release-trigger path. A read that fails changes nothing.
 *
 * The caller's standing is not this module's to judge. Its `guard` is asked
 * immediately before every queue write, every branch deletion and the merge
 * request, with no wait in between, and throws when the caller may no longer
 * act. Once a merge request has been sent its outcome is recorded whatever the
 * guard would now say: a merge that happened is never left unrecorded, and is
 * never asked for twice.
 *
 * @module lib/merge-queue
 */

const queueStore = require('./merge-queue-store');
const state = require('./merge-queue-state');
const { CANDIDATE_PREFIX } = require('./merge-queue-github');
const { createLogger } = require('./logger');

const log = createLogger('merge-queue');

const { REFUSALS } = state;

/** The check a branch is judged by: the base branch's, and a candidate's. */
const CHECK_NAME = 'test';

/** The code of the refusal a call gets when its queue's slot is taken. */
const QUEUE_CALL_IN_FLIGHT = 'QUEUE_CALL_IN_FLIGHT';

/** The queue ids whose slot is taken now. */
const _taken = new Set();

/** The refusal of a call that found its queue's slot taken. */
class QueueSlotTaken extends Error {
  /**
   * @param {string} queueId - The queue whose slot is taken
   */
  constructor(queueId) {
    super('Another advance or withdrawal of this queue is running. Read `tc queue status`, then repeat.');
    this.name = 'QueueSlotTaken';
    this.code = QUEUE_CALL_IN_FLIGHT;
    this.queueId = queueId;
  }
}

/**
 * Run `fn` holding the slot of one queue. The slot is taken before this
 * function first yields and is given back when `fn` ends, whether it returned,
 * refused or threw.
 * @param {string} queueId - The queue's id
 * @param {() => (Promise<*>|*)} fn - The call to run inside the slot
 * @returns {Promise<*>} What `fn` returned
 * @throws {QueueSlotTaken} When another call holds this queue's slot; `fn` is not run
 * @throws {TypeError} When `queueId` is not a non-empty string; `fn` is not run
 */
async function withQueueSlot(queueId, fn) {
  if (typeof queueId !== 'string' || !queueId) throw new TypeError('withQueueSlot needs the queue\'s id');
  if (_taken.has(queueId)) throw new QueueSlotTaken(queueId);
  _taken.add(queueId);
  try {
    return await fn();
  } finally {
    _taken.delete(queueId);
  }
}

/**
 * Whether a queue's slot is taken now.
 * @param {string} queueId - The queue's id
 * @returns {boolean}
 */
function isQueueSlotTaken(queueId) {
  return _taken.has(queueId);
}

/** What an advance is refused with that is not one of the records' own refusals. */
const ADVANCE_REFUSALS = Object.freeze({
  GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',
  CANDIDATE_NOT_DISCARDED: 'CANDIDATE_NOT_DISCARDED',
  CANDIDATE_REF_EXISTS: 'CANDIDATE_REF_EXISTS',
  BASE_NOT_GREEN: 'BASE_NOT_GREEN'
});

/** Why an advance failed an entry, beyond the records' own `CANDIDATE_NOT_GREEN` and `RELEASE_TRIGGER_CHANGED`. */
const FAILURES = Object.freeze({
  PR_NOT_OPEN: 'PR_NOT_OPEN',
  PR_WRONG_BASE: 'PR_WRONG_BASE',
  PR_HEAD_MOVED: 'PR_HEAD_MOVED',
  PR_DRAFT: 'PR_DRAFT',
  CANDIDATE_CONFLICT: 'CANDIDATE_CONFLICT',
  NOTHING_TO_MERGE: 'NOTHING_TO_MERGE'
});

/** What one advance did, as its answer's `step` says it. */
const STEPS = Object.freeze({
  IDLE: 'idle',
  CLEANED_UP: 'cleaned-up',
  ASSEMBLED: 'assembled',
  ASSEMBLY_RETRY: 'assembly-retry',
  REASSEMBLING: 'reassembling',
  WAITING: 'waiting',
  FAILED: 'failed',
  LANDED: 'landed',
  LANDING_NOT_MADE: 'landing-not-made',
  LANDING_UNKNOWN: 'landing-unknown'
});

/**
 * Entries whose candidate branches were found there when their candidate was
 * to be made, and were removed once. A second time is not removed again: it
 * needs a person. Memory only: after a restart an entry gets one more removal.
 */
const _refExistsSeen = new Set();

/**
 * Landed entries whose candidate's branches are known to be gone. A landing is
 * recorded before its branches are deleted, so a landed entry not listed here
 * may still have them, and the next advance removes them before anything else.
 * Memory only: after a restart the latest landing's branches are removed once
 * more, which is harmless.
 */
const _branchesGone = new Set();

/** An advance that was refused: nothing was changed unless the message says what was. */
class AdvanceRefusal extends Error {
  /**
   * @param {string} code - A code from `ADVANCE_REFUSALS` or the records' `REFUSALS`
   * @param {string} message - What was refused and what to do next
   * @param {object} [details] - Further fields for the caller
   * @param {number} [status] - The HTTP status, when it is not the code's usual one
   */
  constructor(code, message, details, status) {
    super(message);
    this.name = 'AdvanceRefusal';
    this.code = code;
    this.details = details || {};
    this.status = status;
  }
}

/**
 * Throw the refusal a store answer carries, or return the answer.
 * @param {object} answer - A `merge-queue-store` write's answer
 * @returns {object} The answer, when it is not a refusal
 */
function _stored(answer) {
  if (answer.ok !== false) return answer;
  const { ok: _ok, code, message, ...details } = answer;
  throw new AdvanceRefusal(code, message, details);
}

/**
 * A GitHub read that could not be made, as the refusal an advance answers with.
 * @param {string} what - What was being read
 * @param {{reason: string}} answer - The `unavailable` answer
 * @returns {AdvanceRefusal}
 */
function _unread(what, answer) {
  return new AdvanceRefusal(ADVANCE_REFUSALS.GITHUB_UNAVAILABLE,
    `${what} could not be read from GitHub (${answer.reason}). Nothing was changed; advance again once GitHub answers.`,
    { reason: answer.reason }, 503);
}

/**
 * The branch an entry's candidate is on, or would be.
 * @param {object} entry - An entry as the store returns it
 * @returns {string}
 */
function _refOf(entry) {
  return (entry.candidate && entry.candidate.ref) || `${CANDIDATE_PREFIX}${entry.entryId}`;
}

/**
 * Read the entry's pull request, or throw the refusal of a read that failed.
 * @param {object} queue - The queue
 * @param {object} entry - The entry
 * @param {object} ctx - The advance's context
 * @returns {Promise<object>} The pull request as `readPull` answers it
 */
async function _pull(queue, entry, ctx) {
  const pull = await ctx.github.readPull(queue.repo, entry.prNumber);
  if (pull.status !== 'read') throw _unread(`Pull request ${entry.prNumber}`, pull);
  return pull;
}

/**
 * What about a pull request stops its entry going on, if anything: it must
 * still be open, on the queue's base, not a draft, at the submitted head.
 * @param {object} queue - The queue
 * @param {object} entry - The entry
 * @param {object} pull - The pull request as read
 * @returns {{code: string, detail: string}|null}
 */
function _pullProblem(queue, entry, pull) {
  const pr = `Pull request ${entry.prNumber}`;
  if (pull.state !== 'open') {
    return { code: FAILURES.PR_NOT_OPEN, detail: `${pr} is ${pull.merged ? 'already merged, and not by this queue' : 'closed'}.` };
  }
  if (pull.baseRef !== queue.baseBranch) {
    return { code: FAILURES.PR_WRONG_BASE, detail: `${pr} now targets ${pull.baseRef}; this queue lands on ${queue.baseBranch}.` };
  }
  if (pull.headSha !== entry.headSha) {
    return { code: FAILURES.PR_HEAD_MOVED, detail: `${pr}'s head is ${pull.headSha}, not the submitted ${entry.headSha}. Review and test that head, then submit it.` };
  }
  if (pull.draft) return { code: FAILURES.PR_DRAFT, detail: `${pr} was made a draft again.` };
  return null;
}

/**
 * Read the commit the queue's base branch is at, or throw the refusal.
 * @param {object} queue - The queue
 * @param {object} ctx - The advance's context
 * @returns {Promise<string>} The commit id
 */
async function _baseTip(queue, ctx) {
  const tip = await ctx.github.readRefTip(queue.repo, queue.baseBranch);
  if (tip.status === 'read') return tip.sha;
  throw _unread(`The tip of ${queue.baseBranch}`, tip.status === 'not-found' ? { reason: 'GitHub says no such branch exists' } : tip);
}

/**
 * Read a branch's `test` check on one commit, or throw the refusal of a read
 * that failed, with the reader's own reason.
 * @param {object} queue - The queue
 * @param {string} branch - The branch judged
 * @param {string} sha - The commit
 * @param {object} ctx - The advance's context
 * @returns {Promise<object>} `not-found`, `running` or `concluded`, as `readBranchCheck` answers
 */
async function _check(queue, branch, sha, ctx) {
  const check = await ctx.github.readBranchCheck(queue.repo, branch, sha, CHECK_NAME);
  if (check.status === 'unavailable') throw _unread(`The ${CHECK_NAME} check of ${branch} on ${sha}`, check);
  return check;
}

/**
 * A check that has not concluded, in words.
 * @param {object} check - A `not-found` or `running` answer
 * @returns {string}
 */
function _pending(check) {
  return check.status === 'running' ? `is still running (run ${check.runId})` : 'has not started';
}

/**
 * The refusal of an advance while the base branch's own check is red.
 * @param {object} queue - The queue
 * @param {string} tip - The base branch's commit
 * @param {object} check - Its concluded check
 * @returns {AdvanceRefusal}
 */
function _baseRed(queue, tip, check) {
  return new AdvanceRefusal(ADVANCE_REFUSALS.BASE_NOT_GREEN,
    `The ${CHECK_NAME} check of ${queue.baseBranch} on ${tip} concluded "${check.conclusion}" (run ${check.runId}). `
    + `Nothing is assembled or landed on a red ${queue.baseBranch}, and nothing was changed: advance again once ${queue.baseBranch} is green.`,
    { baseSha: tip, check: { conclusion: check.conclusion, runId: check.runId } });
}

/**
 * Delete both branches of an entry's candidate, or throw: while either is
 * left, the entry does not move on.
 * @param {object} queue - The queue
 * @param {object} entry - The entry whose candidate goes
 * @param {object} ctx - The advance's context
 * @returns {Promise<{candidate: string, stage: string}>} What happened to each branch
 */
async function _discard(queue, entry, ctx) {
  const ref = _refOf(entry);
  ctx.guard();
  const discarded = await ctx.github.discardCandidate(queue.repo, ref);
  const branches = { candidate: discarded.candidate, stage: discarded.stage };
  if (discarded.status === 'discarded') return branches;
  log.warn('A merge queue candidate could not be discarded', { queueId: queue.queueId, entryId: entry.entryId, ref, ...branches, reason: discarded.reason });
  throw new AdvanceRefusal(ADVANCE_REFUSALS.CANDIDATE_NOT_DISCARDED,
    `The candidate's branches could not both be removed (${discarded.reason}). ${ref} is ${discarded.candidate} and its stage branch is ${discarded.stage}. `
    + 'The entry stays as it is until they are gone: advance again, which tries the removal before anything else.',
    { entryId: entry.entryId, ref, ...branches, reason: discarded.reason }, 503);
}

/**
 * Fail an entry and free the queue for the next one. An entry that has or may
 * have a candidate loses its branches first, so a failed entry never leaves
 * any behind.
 * @param {object} queue - The queue
 * @param {object} entry - The entry
 * @param {{code: string, detail: string}} why - The failure
 * @param {object} ctx - The advance's context
 * @param {object} [options] - `{ branchesKnownGone }`: the candidate is known not to exist
 * @returns {Promise<object>} The advance's answer
 */
async function _fail(queue, entry, why, ctx, options = {}) {
  const branches = state.isActive(entry.state) && !options.branchesKnownGone ? await _discard(queue, entry, ctx) : null;
  ctx.guard();
  _stored(queueStore.failEntry(entry.entryId, { code: why.code, detail: why.detail, actor: ctx.actor }));
  _refExistsSeen.delete(entry.entryId);
  return {
    step: STEPS.FAILED, changed: true, entryId: entry.entryId, failure: why, branches,
    message: `Entry ${entry.entryId} (PR #${entry.prNumber}) FAILED [${why.code}]: ${why.detail} It is out of the queue; the next entry is now at the front.`
  };
}

/**
 * Make the front entry's candidate: the merge of its head into the base
 * branch's tip, on its own branch, where CI tests it.
 * @param {object} queue - The queue
 * @param {object} entry - A `queued` entry, or an `assembling` one an earlier call left
 * @param {object} ctx - The advance's context
 * @returns {Promise<object>} The advance's answer
 */
async function _assemble(queue, entry, ctx) {
  const problem = _pullProblem(queue, entry, await _pull(queue, entry, ctx));
  if (problem) return _fail(queue, entry, problem, ctx);
  const tip = await _baseTip(queue, ctx);
  const baseCheck = await _check(queue, queue.baseBranch, tip, ctx);
  if (baseCheck.status === 'concluded' && baseCheck.conclusion !== 'success') throw _baseRed(queue, tip, baseCheck);

  const ref = `${CANDIDATE_PREFIX}${entry.entryId}`;
  ctx.guard();
  if (entry.state === 'queued') _stored(queueStore.beginAssembly(entry.entryId, { actor: ctx.actor }));
  const began = entry.state === 'queued';
  const made = await ctx.github.createCandidate(queue.repo, ref, tip, entry.headSha);

  if (made.status === 'created') {
    ctx.guard();
    _stored(queueStore.recordCandidate(entry.entryId, { ref, baseSha: tip, sha: made.sha, tree: made.tree, actor: ctx.actor }));
    _refExistsSeen.delete(entry.entryId);
    return {
      step: STEPS.ASSEMBLED, changed: true, entryId: entry.entryId, candidate: { ref, sha: made.sha, baseSha: tip },
      message: `Entry ${entry.entryId} (PR #${entry.prNumber}): candidate ${ref} made at ${made.sha} on ${queue.baseBranch} ${tip}. `
        + `Its ${CHECK_NAME} check runs now; advance again once it has concluded.`
    };
  }
  if (made.status === 'conflict') {
    return _fail(queue, entry, {
      code: FAILURES.CANDIDATE_CONFLICT, detail: `Its head ${entry.headSha} does not merge cleanly into ${queue.baseBranch} at ${tip}.`
    }, ctx, { branchesKnownGone: true });
  }
  if (made.status === 'nothing-to-merge') {
    return _fail(queue, entry, {
      code: FAILURES.NOTHING_TO_MERGE, detail: `${queue.baseBranch} at ${tip} already holds its head ${entry.headSha}.`
    }, ctx, { branchesKnownGone: true });
  }
  if (made.status === 'ref-exists') {
    if (_refExistsSeen.has(entry.entryId)) {
      throw new AdvanceRefusal(ADVANCE_REFUSALS.CANDIDATE_REF_EXISTS,
        `A ${made.existing} branch for ${ref} is there again after this queue removed it, so something else is making it. `
        + 'Nothing was changed and this needs a person: find what creates that branch, or withdraw the entry.',
        { entryId: entry.entryId, ref, existing: made.existing });
    }
    const branches = await _discard(queue, entry, ctx);
    _refExistsSeen.add(entry.entryId);
    return {
      step: STEPS.ASSEMBLY_RETRY, changed: began, entryId: entry.entryId, branches,
      message: `Entry ${entry.entryId} (PR #${entry.prNumber}): a ${made.existing} branch for ${ref} was already there, left by an earlier call. `
        + 'It was removed and no candidate was made: advance again.'
    };
  }
  const left = made.refCreated !== false || made.stageLeft !== false;
  const branches = left ? await _discard(queue, entry, ctx) : null;
  throw new AdvanceRefusal(ADVANCE_REFUSALS.GITHUB_UNAVAILABLE,
    `The candidate for entry ${entry.entryId} could not be made (${made.reason}). `
    + `${left ? 'What it may have left on GitHub was removed' : 'It left no branch on GitHub'}; the entry is assembling and has no candidate. Advance again.`,
    { entryId: entry.entryId, reason: made.reason, branches }, 503);
}

/**
 * Whether a commit is this queue's own landing of a tree its candidate's check
 * passed on: the one case in which the base branch's check need not have
 * concluded, since the same tree's check already has.
 * @param {object[]} entries - Every entry of the queue
 * @param {string} tip - The base branch's commit
 * @returns {boolean}
 */
function _isOwnGreenLanding(entries, tip) {
  return entries.some((e) => e.state === 'landed' && e.landed && e.landed.sha === tip && e.landed.treeMatches
    && e.candidate && e.candidate.checkConclusion === 'success');
}

/**
 * An answer that says the entry waits and nothing was changed.
 * @param {object} entry - The entry
 * @param {string} what - What it waits for
 * @returns {object} The advance's answer
 */
function _waiting(entry, what) {
  return {
    step: STEPS.WAITING, changed: false, entryId: entry.entryId,
    message: `Entry ${entry.entryId} (PR #${entry.prNumber}) waits: ${what}. Nothing was changed; advance again later.`
  };
}

/**
 * Check everything a landing rests on and, if all of it holds, ask GitHub to
 * merge the pull request and record what came of it.
 * @param {object} queue - The queue
 * @param {object} entry - A `testing` entry
 * @param {object[]} entries - Every entry of the queue
 * @param {object} ctx - The advance's context
 * @returns {Promise<object>} The advance's answer
 */
async function _land(queue, entry, entries, ctx) {
  const problem = _pullProblem(queue, entry, await _pull(queue, entry, ctx));
  if (problem) return _fail(queue, entry, problem, ctx);
  const tip = await _baseTip(queue, ctx);
  const candidate = entry.candidate;
  if (tip !== candidate.baseSha) {
    const branches = await _discard(queue, entry, ctx);
    ctx.guard();
    _stored(queueStore.discardCandidate(entry.entryId, {
      reason: `${queue.baseBranch} moved from ${candidate.baseSha} to ${tip}`, actor: ctx.actor
    }));
    return {
      step: STEPS.REASSEMBLING, changed: true, entryId: entry.entryId, branches,
      message: `Entry ${entry.entryId} (PR #${entry.prNumber}): ${queue.baseBranch} moved to ${tip} after its candidate was made on ${candidate.baseSha}. `
        + 'The candidate was discarded, which is not a failure: advance again to make a new one.'
    };
  }

  // The candidate's check is read while its branch still exists: a failure below deletes the branch.
  const candidateCheck = await _check(queue, candidate.ref, candidate.sha, ctx);
  if (candidateCheck.status !== 'concluded') {
    return _waiting(entry, `the ${CHECK_NAME} check of its candidate ${candidate.ref} at ${candidate.sha} ${_pending(candidateCheck)}`);
  }
  if (candidateCheck.conclusion !== 'success') {
    return _fail(queue, entry, {
      code: REFUSALS.CANDIDATE_NOT_GREEN,
      detail: `The ${CHECK_NAME} check of its candidate ${candidate.sha} concluded "${candidateCheck.conclusion}" (run ${candidateCheck.runId}).`
    }, ctx);
  }
  const baseCheck = await _check(queue, queue.baseBranch, tip, ctx);
  if (baseCheck.status === 'concluded' && baseCheck.conclusion !== 'success') throw _baseRed(queue, tip, baseCheck);
  if (baseCheck.status !== 'concluded' && !_isOwnGreenLanding(entries, tip)) {
    return _waiting(entry, `the ${CHECK_NAME} check of ${queue.baseBranch} at ${tip} ${_pending(baseCheck)}`);
  }
  const problems = state.gateProblems(queueStore.getEntry(entry.entryId));
  if (problems.length) {
    throw new AdvanceRefusal(REFUSALS.GATES_NOT_MET,
      `Entry ${entry.entryId} (PR #${entry.prNumber}) is green and cannot land yet: ${problems.map((p) => p.message).join(' ')} `
      + 'Nothing was changed: advance again once every gate is recorded.',
      { entryId: entry.entryId, problems });
  }
  const files = await ctx.github.readCompareFiles(queue.repo, tip, candidate.sha);
  if (files.status !== 'read') {
    return _fail(queue, entry, {
      code: REFUSALS.RELEASE_TRIGGER_CHANGED,
      detail: `What landing it would change on ${queue.baseBranch} could not be read whole (${files.reason}), so it is not known to start no release.`
    }, ctx);
  }
  const triggers = state.releaseTriggerPaths(files.paths);
  if (triggers.length) {
    return _fail(queue, entry, {
      code: REFUSALS.RELEASE_TRIGGER_CHANGED,
      detail: `Landing it would change ${triggers.join(' and ')} on ${queue.baseBranch}, which starts a release. The queue is never a release path.`
    }, ctx);
  }

  // From the guard to the merge request nothing waits: the caller that is
  // admitted here is the caller the merge is asked for.
  ctx.guard();
  _stored(queueStore.beginLanding(entry.entryId, {
    candidateCheck: { runId: candidateCheck.runId, conclusion: candidateCheck.conclusion }, actor: ctx.actor
  }));
  const merged = await ctx.github.mergePull(queue.repo, entry.prNumber, entry.headSha);
  if (merged.status === 'merged') return _recordLanding(queue, entry, merged.sha, ctx);
  if (merged.status === 'unavailable' && merged.applied !== false) return _reconcile(queue, entry, ctx);
  return _landingNotMade(entry, `GitHub did not merge it (${merged.reason})`, ctx);
}

/**
 * Record that a merge that was asked for was not made, and say so.
 * @param {object} entry - A `landing` entry
 * @param {string} reason - What was read
 * @param {object} ctx - The advance's context
 * @returns {object} The advance's answer
 */
function _landingNotMade(entry, reason, ctx) {
  _stored(queueStore.recordLandingNotMade(entry.entryId, { reason: reason.slice(0, 300), actor: ctx.actor }));
  return {
    step: STEPS.LANDING_NOT_MADE, changed: true, entryId: entry.entryId,
    message: `Entry ${entry.entryId} (PR #${entry.prNumber}) was NOT merged: ${reason}. It is back to waiting with its candidate. `
      + 'Advance again to check everything anew, or withdraw it.'
  };
}

/**
 * An answer that says a merge was asked for and what became of it is not yet
 * recorded. The entry stays `landing`, and the next advance reads the pull
 * request before it does anything else.
 * @param {object} entry - A `landing` entry
 * @param {string} what - What is known and what is not
 * @param {object} [extra] - Further fields for the answer
 * @returns {object} The advance's answer
 */
function _landingUnknown(entry, what, extra = {}) {
  return {
    step: STEPS.LANDING_UNKNOWN, changed: false, entryId: entry.entryId, ...extra,
    message: `Entry ${entry.entryId} (PR #${entry.prNumber}): ${what} No second merge is asked for. `
      + 'Advance again: it reads the pull request and records what happened before anything else.'
  };
}

/**
 * The merge commit of a pull request read back as merged, when its merge's
 * own answer was not read: the base branch's tip, if that commit is the merge
 * of this entry's head into the base its candidate was made on.
 * @param {object} queue - The queue
 * @param {object} entry - A `landing` entry
 * @param {object} ctx - The advance's context
 * @returns {Promise<{sha: string}|{unknown: string}>}
 */
async function _mergeCommitOf(queue, entry, ctx) {
  const tip = await ctx.github.readRefTip(queue.repo, queue.baseBranch);
  if (tip.status !== 'read') return { unknown: `the tip of ${queue.baseBranch} could not be read` };
  const commit = await ctx.github.readCommit(queue.repo, tip.sha);
  if (commit.status !== 'read') return { unknown: `the commit ${queue.baseBranch} is at could not be read (${commit.reason})` };
  const isIt = commit.parents.length === 2 && commit.parents[0] === entry.candidate.baseSha && commit.parents[1] === entry.headSha;
  return isIt ? { sha: tip.sha } : { unknown: `${queue.baseBranch} is at ${tip.sha}, which is not the merge of ${entry.headSha} into ${entry.candidate.baseSha}` };
}

/**
 * Read what became of a merge that was asked for and whose answer was not
 * read, and record it: landed, or not made. Never asks for a merge.
 * @param {object} queue - The queue
 * @param {object} entry - A `landing` entry
 * @param {object} ctx - The advance's context
 * @returns {Promise<object>} The advance's answer
 */
async function _reconcile(queue, entry, ctx) {
  const pull = await ctx.github.readPull(queue.repo, entry.prNumber);
  if (pull.status !== 'read') {
    return _landingUnknown(entry, `its merge was asked for, the answer was not read, and the pull request could not be read either (${pull.reason}).`);
  }
  if (!pull.merged) {
    return _landingNotMade(entry, pull.state === 'open' ? 'the pull request was read back still open' : 'the pull request was read back closed and not merged', ctx);
  }
  const found = await _mergeCommitOf(queue, entry, ctx);
  if (found.unknown) {
    return _landingUnknown(entry, `the pull request IS MERGED, but its merge commit is not known: ${found.unknown}. The landing is not recorded.`, { merged: true });
  }
  return _recordLanding(queue, entry, found.sha, ctx);
}

/**
 * Record a landing: read the merge commit's tree, record it against the
 * candidate's, then remove the candidate's branches. The record comes first,
 * and no refusal of the removal undoes or hides it.
 * @param {object} queue - The queue
 * @param {object} entry - A `landing` entry
 * @param {string} sha - The merge commit on the base branch
 * @param {object} ctx - The advance's context
 * @returns {Promise<object>} The advance's answer
 */
async function _recordLanding(queue, entry, sha, ctx) {
  const commit = await ctx.github.readCommit(queue.repo, sha);
  if (commit.status !== 'read') {
    return _landingUnknown(entry, `the pull request WAS MERGED as ${sha}, but that commit could not be read (${commit.reason}), so the landing is not recorded yet.`,
      { merged: true, mergeSha: sha });
  }
  const done = _stored(queueStore.recordLanded(entry.entryId, { landedSha: sha, landedTree: commit.tree, actor: ctx.actor }));
  log.info('Merge queue landed an entry', { queueId: queue.queueId, entryId: entry.entryId, prNumber: entry.prNumber, landedSha: sha, treeMatches: done.treeMatches });
  let branches = null;
  let cleanup = null;
  try {
    branches = await _discard(queue, entry, ctx);
    _branchesGone.add(entry.entryId);
  } catch (err) { // prawduct:allow prawduct/broad-except -- the landing is recorded and must be answered as one: a refusal of the branch removal is reported beside it, and anything that is not a refusal is rethrown
    if (typeof err.code !== 'string') throw err;
    cleanup = { code: err.code, message: err.message };
  }
  const tree = done.treeMatches
    ? 'Its tree is the tested candidate\'s.'
    : `ITS TREE IS NOT THE TESTED CANDIDATE'S, so the queue HALTED itself: nothing advances until the Operator clears the halt. ${queue.baseBranch} holds a tree no test passed.`;
  const after = cleanup
    ? ` Its candidate's branches were NOT removed [${cleanup.code}]; the next advance removes them before anything else.`
    : '';
  return {
    step: STEPS.LANDED, changed: true, entryId: entry.entryId, landed: { sha, tree: commit.tree, treeMatches: done.treeMatches },
    queueHalted: done.queueHalted, branches, cleanup,
    message: `Entry ${entry.entryId} (PR #${entry.prNumber}) LANDED on ${queue.baseBranch} as ${sha}. ${tree}${after} `
      + 'This is a merge and nothing else: nothing was deployed and nothing was released.'
  };
}

/**
 * The landed entry whose candidate's branches may still be on GitHub: the
 * latest landing, unless its branches are known gone.
 * @param {object[]} entries - Every entry of the queue, in submission order
 * @returns {object|null}
 */
function _cleanupOwed(entries) {
  const landed = entries.filter((e) => e.state === 'landed' && e.candidate && e.candidate.ref);
  const latest = landed[landed.length - 1];
  return latest && !_branchesGone.has(latest.entryId) ? latest : null;
}

/**
 * Move a queue's front entry one step. Call it inside the queue's slot
 * ({@link withQueueSlot}).
 *
 * `ctx.github` holds the GitHub calls, as `lib/merge-queue-github.js` exports
 * them: `readPull`, `readRefTip`, `readCommit`, `readCompareFiles`,
 * `readBranchCheck`, `createCandidate`, `discardCandidate`, `mergePull`.
 * `ctx.guard` throws when the caller may no longer act; what it throws is
 * passed on unchanged. `ctx.actor` is the owner's launch as the records keep it.
 * @param {object} queue - The queue, as the store returns it
 * @param {{actor: object, guard: () => void, github: object}} ctx - The advance's context
 * @returns {Promise<{step: string, changed: boolean, message: string, entryId?: string}>} What the call did
 * @throws {AdvanceRefusal} When the call was refused; its message says whether anything was changed
 */
async function advance(queue, ctx) {
  const current = queueStore.getQueue(queue.queueId);
  if (!current || current.status !== 'active') {
    throw new AdvanceRefusal(REFUSALS.QUEUE_RETIRED, 'This queue is retired. It keeps its history and advances nothing; the Operator makes a new one.');
  }
  if (current.halt) {
    throw new AdvanceRefusal(REFUSALS.QUEUE_HALTED,
      `This queue halted itself (${current.halt.code}): ${current.halt.detail || 'no detail recorded'} Nothing advances until the Operator clears the halt.`,
      { halt: current.halt });
  }
  const entries = queueStore.listEntries(current.queueId);
  const owed = _cleanupOwed(entries);
  if (owed) {
    const branches = await _discard(current, owed, ctx);
    _branchesGone.add(owed.entryId);
    return {
      step: STEPS.CLEANED_UP, changed: false, entryId: owed.entryId, branches,
      message: `The candidate's branches of landed entry ${owed.entryId} are gone (${_refOf(owed)} ${branches.candidate}, its stage branch ${branches.stage}). `
        + 'No entry was moved: advance again.'
    };
  }
  const front = state.nextActive(entries.filter((e) => !state.isFinished(e.state)));
  if (!front) return { step: STEPS.IDLE, changed: false, message: 'Nothing is waiting in this queue.' };
  if (front.state === 'testing') return _land(current, front, entries, ctx);
  if (front.state === 'landing') return _reconcile(current, front, ctx);
  return _assemble(current, front, ctx);
}


module.exports = {
  QUEUE_CALL_IN_FLIGHT,
  QueueSlotTaken,
  withQueueSlot,
  isQueueSlotTaken,
  ADVANCE_REFUSALS,
  FAILURES,
  STEPS,
  CHECK_NAME,
  AdvanceRefusal,
  advance,
  _internal: { refExistsSeen: _refExistsSeen, branchesGone: _branchesGone }
};
