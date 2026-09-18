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
 * Why this attempt's ROW cannot be acted on, or null when it can.
 *
 * The eligibility rules live here once. Both appliers need them and they are the
 * rules every handoff guarantee rests on, so a second copy is a copy that can be
 * updated on one path and not the other — the failure `applyHandoffRepairs`'
 * docblock argues against, which a second full restatement in this same file
 * would have walked straight into.
 *
 * `already` is returned separately from a refusal because a replayed finalize
 * for an attempt already published is a no-op SUCCESS, which is what makes a
 * lost response safe to retry.
 *
 * @param {object|null} row - The publication row, or null when there is none
 * @returns {{refuse: string}|{already: object}|null}
 */
function _attemptRowState(row) {
  if (!row) return { refuse: 'no such publication' };
  if (row.state === 'published') return { already: row };
  if (row.state !== 'staged') return { refuse: `publication is ${row.state}` };
  if (!row.eligibleAt) return { refuse: 'publication is not eligible: its attempt never completed' };
  return null;
}

/**
 * Why these bytes are not this attempt's, or null when they are.
 *
 * The same three comparisons whichever file holds them: a promoted document
 * earns no weaker check for having already been moved.
 *
 * @param {object} read - A `lockfile.readHandoffFile` result
 * @param {object} row - The publication row it should match
 * @param {string} label - What to call the file in a refusal ('staged file', 'current.json')
 * @returns {string|null}
 */
function _fileMismatch(read, row, label) {
  if (read.outcome !== 'ok') return `${label} is ${read.outcome}: ${read.reason || 'unreadable'}`;
  if (read.digest !== row.fileDigest) return `${label} digest does not match the recorded digest`;
  if (read.doc.publicationId !== row.publicationId) return `${label} names a different publication`;
  if (read.doc.kind !== row.kind) return `${label} kind does not match the recorded kind`;
  return null;
}

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
  const rowState = _attemptRowState(row);
  if (rowState && rowState.refuse) return refuse(rowState.refuse);
  if (rowState && rowState.already) {
    return { published: true, reason: 'already published', supersededId: rowState.already.supersededBy || null };
  }

  // The bytes on disk must be the bytes the row attests to. A mismatched file
  // is never published — it is the one case where the record and the document
  // disagree, and publishing it would make the digest meaningless.
  const staged = lockfile.readHandoffFile(lockfile.stagedPath(project, publicationId));
  const mismatch = _fileMismatch(staged, row, 'staged file');
  if (mismatch) return refuse(mismatch);

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
 * Record a publication whose bytes are ALREADY current.
 *
 * The mirror of `publishHandoff`: there the rename had not happened, here it
 * had. A wrap that crashed between `lockfile.promoteStaged` and
 * `store.handoffs.recordPublished` leaves `current.json` holding the new
 * document while the row still says `staged` — and no staged file remains to
 * publish from, which is why `publishHandoff` cannot serve this case and why a
 * scan that looks only in the staged files cannot even see it.
 *
 * The already-promoted file earns no weaker check for having been moved. It is
 * validated against the row exactly as a staged file would be, and the newest
 * published row is re-read inside the transaction, so an attempt that lost the
 * race is superseded rather than recorded over the winner.
 *
 * @param {object} project - Project record (locates the handoff directory)
 * @param {string} publicationId - The attempt whose row is behind its bytes
 * @returns {{published: boolean, reason: string|null, supersededId: string|null}}
 */
function recordPromotedHandoff(project, publicationId) {
  const refuse = (reason) => {
    log.warn('Refused to record a promoted handoff', { project: project.name, publicationId, reason });
    return { published: false, reason, supersededId: null };
  };

  const row = store.handoffs.get(publicationId);
  const rowState = _attemptRowState(row);
  if (rowState && rowState.refuse) return refuse(rowState.refuse);
  if (rowState && rowState.already) {
    return { published: true, reason: 'already published', supersededId: rowState.already.supersededBy || null };
  }

  try {
    return store.handoffs.transaction(() => {
      const fresh = store.handoffs.get(publicationId);
      if (fresh.state === 'published') {
        return { published: true, reason: 'already published', supersededId: fresh.supersededBy || null };
      }
      if (fresh.state !== 'staged') {
        return { published: false, reason: `publication is ${fresh.state}`, supersededId: null };
      }

      // The lost race is decided BEFORE the file is read, and the order is the
      // whole point. `publishHandoff` reads `staged-<pid>.json`, which belongs
      // to one attempt and stays valid whoever won; this reads `current.json`,
      // which is SHARED — a newer winner has already put its own bytes there.
      // Checking the file first would refuse with "names a different
      // publication" and never reach the supersede, leaving an attempt that
      // completed stuck at `staged` for good.
      const newer = store.handoffs.newerPublished(row.projectId, row.seq);
      if (newer) {
        store.handoffs.supersedeBeforePublish(publicationId, newer.publicationId, new Date().toISOString());
        return {
          published: false,
          reason: `a newer publication (${newer.publicationId}) is already current`,
          supersededId: null
        };
      }

      // Nothing newer won, so `current.json` should be this attempt's bytes. It
      // earns no weaker check for having already been moved — same three
      // comparisons, one implementation.
      const current = lockfile.readHandoffFile(lockfile.currentPath(project));
      const currentMismatch = _fileMismatch(current, row, 'current.json');
      if (currentMismatch) return { published: false, reason: currentMismatch, supersededId: null };

      const previous = store.handoffs.getPublished(row.projectId);
      const previousId = previous ? previous.publicationId : null;
      // No file moves: `promoteStaged` already ran, which is the whole premise.
      store.handoffs.recordPublished(publicationId, previousId, new Date().toISOString());
      log.info('Recorded a handoff whose bytes were already current', {
        project: project.name, publicationId, supersededId: previousId
      });
      return { published: true, reason: null, supersededId: previousId };
    });
  } catch (err) {
    return refuse(`recording failed: ${err.message}`);
  }
}

/**
 * How each repair action is carried out.
 *
 * An unknown action is refused rather than ignored. A proposal this cannot carry
 * out is a disagreement between the detector and the applier, and the one safe
 * response is to say so — skipping it silently would report the repair pass as
 * clean while the condition that produced the proposal is still there.
 *
 * Two entries because the two crashes leave the bytes in different places, and
 * an applier that guessed would publish from whichever file happened to exist.
 */
const REPAIR_APPLIERS = Object.freeze({
  publish: publishHandoff,
  'record-published': recordPromotedHandoff
});

/** Every repair action a proposal may name. @type {readonly string[]} */
const REPAIR_ACTIONS = Object.freeze(Object.keys(REPAIR_APPLIERS));

/**
 * The order a mixed batch is applied in. See `applyHandoffRepairs`: the two
 * actions contend for one `current.json`, and recording the document that is
 * already there has to precede renaming another one over it.
 *
 * An action absent from this list ranks LAST, deliberately. `indexOf` answers
 * -1 for an unknown one, and -1 sorts ahead of everything — so a third applier
 * added to `REPAIR_APPLIERS` and forgotten here would silently run before
 * `record-published`, which is the one ordering this list exists to prevent.
 * Ranking the unknown last is the fail-safe direction, and
 * `test/handoff-repairs.test.js` pins that every action has an explicit rank so
 * nobody has to rely on it.
 * @type {readonly string[]}
 */
const REPAIR_ORDER = Object.freeze(['record-published', 'publish']);

/**
 * Where an action sorts in a mixed batch. Unknown actions rank last.
 * @param {string} action - A repair action
 * @returns {number}
 */
function repairRank(action) {
  const at = REPAIR_ORDER.indexOf(action);
  return at === -1 ? REPAIR_ORDER.length : at;
}

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
 * **`record-published` before `publish`, then highest `seq` first within each.**
 * Both halves matter and they are different rules.
 *
 * Highest `seq` first, because two eligible attempts can both sit ahead of the
 * published row — a kept session that staged a checkpoint and then a final, with
 * the crash landing before either was published. Publishing the newest first
 * means the older ones find a newer publication current and are recorded as
 * `superseded`, which is what they are; the other order would briefly make an
 * older attempt the project's current handoff.
 *
 * Action first, because the two actions contend for ONE file. A
 * `record-published` proposal exists only when `current.json` already holds its
 * bytes, and a `publish` renames over `current.json`. Ordering a mixed batch by
 * `seq` alone puts the rename first whenever the promoted attempt has the lower
 * `seq`, and then either `promoteStaged` refuses to retire a `current.json`
 * naming someone else (the launch reports `unfinished` — a recovery verdict — on
 * a fully repairable state) or, with no published row to retire, the rename
 * destroys the promoted document outright. Recording first costs nothing: it
 * moves no file, and it leaves the record consistent for the rename that
 * follows.
 *
 * The ordering is taken from the stored rows, not from the `seq` the proposal
 * carries, for the same reason nothing else here is taken on trust.
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
    publishable.push({ publicationId, action, seq });
  }

  // A proposal whose row could not be read keeps its place at the end rather
  // than being dropped: `publishHandoff` is still the thing that decides, and
  // it will refuse a publication that does not exist with a reason worth
  // recording.
  publishable.sort((a, b) => {
    const rankA = repairRank(a.action);
    const rankB = repairRank(b.action);
    if (rankA !== rankB) return rankA - rankB;
    if (a.seq === b.seq) return 0;
    if (a.seq === null) return 1;
    if (b.seq === null) return -1;
    return b.seq - a.seq;
  });

  for (const { publicationId, action } of publishable) {
    let result;
    try {
      result = REPAIR_APPLIERS[action](project, publicationId);
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
      action,
      applied: result.published === true,
      reason: result.reason,
      supersededId: result.supersededId
    });
    // A refusal decided INSIDE the transaction returns its reason and logs
    // nothing on its own, so without this a launch that proposes, is refused and
    // reports `unfinished` leaves no trace of WHICH check refused — the one
    // question an operator looking at a stuck project has.
    if (result.published !== true) {
      log.warn('A handoff repair was not applied', {
        project: project && project.name, publicationId, action, reason: result.reason
      });
    }
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

module.exports = {
  publishHandoff,
  recordPromotedHandoff,
  abandonHandoff,
  applyHandoffRepairs,
  REPAIR_ACTIONS,
  REPAIR_ORDER,
  repairRank
};
