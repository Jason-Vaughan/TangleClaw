'use strict';

/**
 * Clearing one launch's required recovery, as an operator's decision.
 *
 * One function decides whether a named launch may be cleared and performs the
 * clear, so every route that offers the decision asks the same questions in
 * the same order. It proves nothing about the caller: the route establishes who
 * is asking (`server.js#_requireOperatorWrite`) and hands the result in as
 * `clearance` and `clearedBy`.
 *
 * The caller resolves the project. A sequence is cleared only when it belongs
 * to that project, which is what stops a launch id from one project being
 * cleared through a request that named another.
 */

const store = require('./store');

/**
 * What `clearOneLaunch` found. `CLEARED` is the only outcome that wrote
 * anything.
 * @enum {string}
 */
const OUTCOMES = Object.freeze({
  CLEARED: 'cleared',
  // No sequence for that session, a different sequence id, or another project's.
  NOT_FOUND: 'not-found',
  // The launch clears by the session's own reconciliation, never by an operator.
  ADVISORY: 'advisory',
  // The recovery was not `required` when it was read.
  NOT_REQUIRED: 'not-required',
  // The compare-and-set wrote nothing: the session or recovery revision named
  // by the caller is not the row's.
  BINDING_MOVED: 'binding-moved',
  // The launch's session is no longer active, so there is no session left for
  // a clear to let through.
  SESSION_ENDED: 'session-ended'
});

/**
 * Clear one launch's required recovery, bound to the exact launch the caller
 * was shown.
 *
 * On `CLEARED` the launch's durable clearance record is written with the
 * clear, in one transaction (`store.launchSequences.clearRecoveryAsOperator`),
 * and the `launch.recovery-cleared` activity row is written here, so no caller
 * can clear a launch and leave either out. A record that cannot be written
 * throws, and the launch stays `required`.
 *
 * `sequence` on a refusal is the row as it was read BEFORE the compare-and-set.
 * For `BINDING_MOVED` its `recoveryRevision` is therefore the revision the
 * launch was at when this call looked, which is what a caller reports back.
 *
 * @param {object} args
 * @param {object} args.project - The project the caller resolved; needs `id`
 * @param {number} args.sessionId - The session the caller believes this launch is
 * @param {number} args.sequenceId - The launch sequence being cleared
 * @param {number} args.recoveryRevision - The recovery revision the caller read
 * @param {'operator-verified'|'open-install-unverified'} args.clearance - How the caller was proven
 * @param {string|null} args.clearedBy - The authenticated operator, or null where none was proven
 * @param {string|null} [args.batchId] - The batch this clear belongs to; null for a clear made on its own
 * @returns {{outcome: string, sequence: (object|null), sessionStatus: (string|null|undefined)}} One of
 *   {@link OUTCOMES}, with the cleared row on `CLEARED`, the row as read on any other outcome that
 *   found one, and null on `NOT_FOUND`. `sessionStatus` is present only on `SESSION_ENDED`: the
 *   session's stored status, or null when it has no row.
 * @throws {Error} When the clearance record cannot be written; nothing is cleared.
 */
function clearOneLaunch({ project, sessionId, sequenceId, recoveryRevision, clearance, clearedBy, batchId = null }) {
  const sequence = store.launchSequences.getBySession(sessionId);
  if (!sequence || sequence.id !== sequenceId || sequence.projectId !== project.id) {
    return { outcome: OUTCOMES.NOT_FOUND, sequence: null };
  }
  if (sequence.recoveryMode === 'advisory') return { outcome: OUTCOMES.ADVISORY, sequence };
  if (sequence.recovery !== 'required') return { outcome: OUTCOMES.NOT_REQUIRED, sequence };

  // An ended session is refused only where the clear would otherwise have been
  // written. A launch that is already not `required`, or a request naming a
  // revision the launch has left, keeps the stale answer it always had: the
  // caller is told its view is out of date before it is told the session is
  // gone. A session row that cannot be found is treated as ended, because a
  // clear must never be recorded for a session nobody can show is running.
  const session = store.sessions.get(sequence.sessionId);
  if (!session || session.status !== store.SESSION_STATUS.ACTIVE) {
    if (sequence.recoveryRevision !== recoveryRevision) return { outcome: OUTCOMES.BINDING_MOVED, sequence };
    return { outcome: OUTCOMES.SESSION_ENDED, sequence, sessionStatus: session ? session.status : null };
  }

  const cleared = store.launchSequences.clearRecoveryAsOperator(sequence.id, {
    sessionId, recoveryRevision, clearance, clearedBy, batchId
  });
  if (!cleared) return { outcome: OUTCOMES.BINDING_MOVED, sequence };

  store.activity.log({
    projectId: project.id,
    sessionId: cleared.sessionId,
    eventType: 'launch.recovery-cleared',
    detail: { sequenceId: cleared.id, clearance, clearedBy, recoveryRevision }
  });
  return { outcome: OUTCOMES.CLEARED, sequence: cleared };
}

module.exports = { OUTCOMES, clearOneLaunch };
