'use strict';

/**
 * Finalizing a handoff attempt (Train 21, #1585).
 *
 * The only place the DB rows and the files are moved together. Everything here
 * is named by an exact `publicationId`, so a late finalize can only ever act on
 * its own attempt.
 *
 * The checks run inside one `BEGIN IMMEDIATE` before anything moves, because
 * the question "is this still the newest attempt" has to be answered and acted
 * on without another finalizer slipping between.
 */

const { createLogger } = require('./logger');
const store = require('./store');
const lockfile = require('./handoff-lockfile');

const log = createLogger('handoff-publish');

/**
 * Make a bound attempt the project's current handoff.
 *
 * Refusals are returned, never thrown: the wrap that produced this attempt has
 * already succeeded, and a handoff that cannot be published must not turn a
 * completed wrap into a failed one.
 *
 * @param {object} project - Project record (locates the handoff directory)
 * @param {string} publicationId - The attempt to publish
 * @returns {{published: boolean, reason: string|null, supersededId: string|null}}
 */
function publishHandoff(project, publicationId) {
  const refuse = (reason) => {
    log.warn('Refused to publish a handoff attempt', { project: project.name, publicationId, reason });
    return { published: false, reason, supersededId: null };
  };

  const row = store.handoffs.get(publicationId);
  if (!row) return refuse('no such publication');
  // A replayed finalize for an attempt already published is a no-op SUCCESS —
  // this is what makes a lost finalize response safe to retry.
  if (row.state === 'published') {
    return { published: true, reason: 'already published', supersededId: row.supersededBy || null };
  }
  if (row.state !== 'staged') return refuse(`publication is ${row.state}`);
  if (!row.eligibleAt) return refuse('publication is not eligible: its attempt never completed');

  // The bytes on disk must be the bytes the row attests to. A mismatched file
  // is never published — it is the one case where the record and the document
  // disagree, and publishing it would make the digest meaningless.
  const staged = lockfile.readHandoffFile(lockfile.stagedPath(project, publicationId));
  if (staged.outcome !== 'ok') return refuse(`staged file is ${staged.outcome}: ${staged.reason || 'unreadable'}`);
  if (staged.digest !== row.fileDigest) return refuse('staged file digest does not match the recorded digest');
  if (staged.doc.publicationId !== publicationId) return refuse('staged file names a different publication');
  if (staged.doc.kind !== row.kind) return refuse('staged file kind does not match the recorded kind');

  try {
    return store.handoffs.transaction(() => {
      // Re-read inside the transaction: between the checks above and here,
      // another finalizer may have published.
      const fresh = store.handoffs.get(publicationId);
      if (fresh.state === 'published') {
        return { published: true, reason: 'already published', supersededId: fresh.supersededBy || null };
      }
      if (fresh.state !== 'staged') {
        return { published: false, reason: `publication is ${fresh.state}`, supersededId: null };
      }

      const newer = store.handoffs.newerPublished(row.projectId, row.seq);
      if (newer) {
        // It completed, so it is superseded rather than abandoned, and
        // current.json is left exactly as the newer attempt wrote it.
        store.handoffs.supersedeBeforePublish(publicationId, newer.publicationId, new Date().toISOString());
        return {
          published: false,
          reason: `a newer publication (${newer.publicationId}) is already current`,
          supersededId: null
        };
      }

      const previous = store.handoffs.getPublished(row.projectId);
      const previousId = previous ? previous.publicationId : null;
      // Files first: the rename is what makes these bytes current, and the DB
      // write below is the record that it happened. A crash between them is
      // exactly what reconciliation exists to catch.
      lockfile.promoteStaged(project, publicationId, previousId);
      store.handoffs.recordPublished(publicationId, previousId, new Date().toISOString());
      log.info('Published a handoff', { project: project.name, publicationId, supersededId: previousId });
      return { published: true, reason: null, supersededId: previousId };
    });
  } catch (err) {
    return refuse(`publish failed: ${err.message}`);
  }
}

/**
 * Abandon an attempt that never became eligible.
 *
 * The staged file is deliberately left on disk: it is the forensic record of
 * what the failed attempt was going to say.
 * @param {string} publicationId - The attempt to abandon
 * @param {string} reason - Why, in a few words
 * @returns {boolean} True when the row moved
 */
function abandonHandoff(publicationId, reason) {
  try {
    const moved = store.handoffs.abandon(publicationId, reason, new Date().toISOString());
    if (moved) log.info('Abandoned a handoff attempt', { publicationId, reason });
    return moved;
  } catch (err) {
    log.warn('Could not abandon a handoff attempt', { publicationId, reason, error: err.message });
    return false;
  }
}

/**
 * Every repair action `runPreflight` is allowed to propose.
 *
 * An unknown action is refused rather than ignored. A proposal this cannot
 * carry out is a disagreement between the detector and the applier, and the one
 * safe response is to say so — skipping it silently would report the repair
 * pass as clean while the condition that produced the proposal is still there.
 */
const REPAIR_ACTIONS = Object.freeze(['publish']);

/**
 * Apply the repair proposals `runPreflight` returned.
 *
 * **This is the only thing that acts on a proposal, and it trusts none of it.**
 * Detection is pure and therefore blind to anything that changed after the
 * context was gathered: a concurrent finalizer may have published, the staged
 * bytes may have been replaced, the attempt may have been abandoned. So a
 * proposal is treated as a *nomination of a publication id*, and every
 * condition that made it repairable is re-established here, inside the
 * transaction that acts — which is what `publishHandoff` already does, against
 * the live row and the live file, in the same order. Reusing it rather than
 * re-deriving the checks is deliberate: a second copy of the eligibility rules
 * is a second copy that can drift from the one the wrap path uses.
 *
 * **Refusals are outcomes, not failures.** This runs on the launch path, before
 * anything is rendered, and a launch must never fail because a repair could
 * not be applied — the unrepaired state is what the following preflight pass is
 * for. Nothing here throws to the caller.
 *
 * **Highest `seq` first.** Two eligible attempts can both sit ahead of the
 * published row — a kept session that staged a checkpoint and then a final,
 * with the crash landing before either was published. Publishing the newest
 * first means the older ones find a newer publication current and are recorded
 * as `superseded`, which is what they are. The other order would briefly make
 * an older attempt the project's current handoff, and `current.json` is never
 * overwritten by an older attempt. The ordering is taken from the stored rows,
 * not from the `seq` the proposal carries, for the same reason nothing else
 * here is taken on trust.
 *
 * @param {object} project - Project record (locates the handoff directory)
 * @param {Array<{action: string, publicationId: string}>} proposals - From `runPreflight`
 * @returns {{outcomes: Array<{publicationId: string|null, action: string|null, applied: boolean, reason: string|null, supersededId: string|null}>, appliedCount: number}}
 */
function applyHandoffRepairs(project, proposals) {
  const outcomes = [];
  const publishable = [];

  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    const action = proposal && proposal.action ? proposal.action : null;
    const publicationId = proposal && typeof proposal.publicationId === 'string'
      ? proposal.publicationId
      : null;
    if (!REPAIR_ACTIONS.includes(action) || !publicationId) {
      outcomes.push({
        publicationId,
        action,
        applied: false,
        reason: `not a repair this can apply: ${action === null ? 'no action' : `action "${action}"`}${publicationId ? '' : ', no publication id'}`,
        supersededId: null
      });
      log.warn('Refused an unrecognized handoff repair proposal', {
        project: project && project.name, action, publicationId
      });
      continue;
    }
    // The row is read here only to order the work. Whether it may be published
    // is decided by `publishHandoff`, against the row as it stands then.
    let seq = null;
    try {
      const row = store.handoffs.get(publicationId);
      seq = row ? row.seq : null;
    } catch (err) {
      log.warn('Could not read a proposed publication while ordering repairs', {
        project: project && project.name, publicationId, error: err.message
      });
    }
    publishable.push({ publicationId, seq });
  }

  // A proposal whose row could not be read keeps its place at the end rather
  // than being dropped: `publishHandoff` is still the thing that decides, and
  // it will refuse a publication that does not exist with a reason worth
  // recording.
  publishable.sort((a, b) => {
    if (a.seq === b.seq) return 0;
    if (a.seq === null) return 1;
    if (b.seq === null) return -1;
    return b.seq - a.seq;
  });

  for (const { publicationId } of publishable) {
    let result;
    try {
      result = publishHandoff(project, publicationId);
    } catch (err) {
      // `publishHandoff` returns its refusals, so reaching here means something
      // unanticipated. The launch still proceeds; preflight runs again and
      // reports whatever state this left.
      log.warn('A handoff repair threw', {
        project: project && project.name, publicationId, error: err.message
      });
      result = { published: false, reason: `repair failed: ${err.message}`, supersededId: null };
    }
    outcomes.push({
      publicationId,
      action: 'publish',
      applied: result.published === true,
      reason: result.reason,
      supersededId: result.supersededId
    });
  }

  const appliedCount = outcomes.filter((o) => o.applied).length;
  if (outcomes.length > 0) {
    log.info('Applied handoff repair proposals', {
      project: project && project.name,
      proposed: outcomes.length,
      applied: appliedCount
    });
  }
  return { outcomes, appliedCount };
}

module.exports = { publishHandoff, abandonHandoff, applyHandoffRepairs, REPAIR_ACTIONS };
