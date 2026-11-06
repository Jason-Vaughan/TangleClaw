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
 * A `not-applicable` launch whose preflight asked for recovery anyway (#1623).
 *
 * `recovery` on a not-applicable row is always `'none'` — `buildSnapshot`
 * (`lib/launch-sequence.js`) never asks one of these to withhold a step,
 * because it has none — so the ordinary `recovery === 'required'` gate below
 * never opens for it, and nothing else can: a not-applicable launch never
 * attests READY, so the session-side `agent-reconciled` clear
 * (`lib/launch-sequence.js`'s `ready()`) never runs for it either. This is the
 * one other door, read from the measured predicate rather than the verdict
 * word, for the same reason `buildSnapshot`'s comment gives: `requiresRecovery`
 * is not a function of the verdict string.
 * @param {object} sequence - A launch sequence row, from `store.launchSequences`
 * @returns {boolean}
 */
function isNotApplicableDamagedHandoff(sequence) {
  return sequence.applicability === 'not-applicable'
    && sequence.recovery === 'none'
    && !!(sequence.preflight && sequence.preflight.requiresRecovery)
    && !sequence.recoveryClearedAt;
}

/**
 * Whether a launch's session is still there for a clear to let through.
 *
 * The one judgement of "ended" for a launch: the clear below refuses on it, and
 * the read the panel renders from (`GET /api/launch-sequences`) reports it, so
 * the panel never offers a clear this module would refuse as `SESSION_ENDED`.
 * A session row that cannot be found counts as ended, because a clear must
 * never be recorded for a session nobody can show is running. The stored status
 * is the session row's own word; nothing here checks that a pane is alive.
 * @param {object|null|undefined} session - The session row, from `store.sessions.get`
 * @returns {boolean} True only for a row whose stored status is active
 */
function sessionIsActive(session) {
  return !!session && session.status === store.SESSION_STATUS.ACTIVE;
}

/**
 * Clear one launch's required recovery, bound to the exact launch the caller
 * was shown.
 *
 * On `CLEARED` the launch's durable clearance record is written with the
 * clear, in one transaction (`store.launchSequences.clearRecoveryAsOperator`),
 * and the `launch.recovery-cleared` activity row is written here, so no caller
 * can clear a launch and leave either out. A clear made in a batch writes that
 * batch's `cleared` item outcome in the same transaction. A record that cannot
 * be written throws, and the launch stays `required`.
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
 * @param {number|null} [args.batchItemIndex] - The item's position in that batch; required with `batchId`
 * @returns {{outcome: string, sequence: (object|null), sessionStatus: (string|null|undefined)}} One of
 *   {@link OUTCOMES}, with the cleared row on `CLEARED`, the row as read on any other outcome that
 *   found one, and null on `NOT_FOUND`. `sessionStatus` is present only on `SESSION_ENDED`: the
 *   session's stored status, or null when it has no row.
 * @throws {Error} When a record cannot be written; nothing is cleared.
 */
/**
 * The checks {@link clearOneLaunch} and {@link clearOneLaunchAsPeer} both
 * make before either writes anything: does the named launch exist and
 * belong to this project, is its recovery actually open to this kind of
 * clear, and is its session still there for a clear to let through. Shared
 * so the two doors can never drift apart on what "eligible to clear" means
 * — only WHO may walk through the door, and how the write itself is
 * recorded, differ between them.
 * @param {object} args
 * @param {object} args.project - The project the caller resolved; needs `id`.
 * @param {number} args.sessionId - The session the caller believes this launch is.
 * @param {number} args.sequenceId - The launch sequence being cleared.
 * @param {number} args.recoveryRevision - The recovery revision the caller read.
 * @returns {{outcome: string, sequence: (object|null), sessionStatus?: (string|null)}|{sequence: object}}
 *   A refusal shape (one of {@link OUTCOMES} other than `CLEARED`) with `outcome` set, or
 *   `{sequence}` alone when eligible to proceed.
 */
function _checkClearEligibility({ project, sessionId, sequenceId, recoveryRevision }) {
  const sequence = store.launchSequences.getBySession(sessionId);
  if (!sequence || sequence.id !== sequenceId || sequence.projectId !== project.id) {
    return { outcome: OUTCOMES.NOT_FOUND, sequence: null };
  }
  // A not-applicable damaged handoff is cleared through this door however the
  // project's recovery mode is set: it never reaches `ready()`, which is the
  // only place an advisory launch clears itself, so gating it on `recoveryMode`
  // the way the ordinary case below does would leave it stuck forever.
  if (!isNotApplicableDamagedHandoff(sequence)) {
    if (sequence.recoveryMode === 'advisory') return { outcome: OUTCOMES.ADVISORY, sequence };
    if (sequence.recovery !== 'required') return { outcome: OUTCOMES.NOT_REQUIRED, sequence };
  }

  // An ended session is refused only where the clear would otherwise have been
  // written. A launch that is already not `required`, or a request naming a
  // revision the launch has left, keeps the stale answer it always had: the
  // caller is told its view is out of date before it is told the session is
  // gone.
  const session = store.sessions.get(sequence.sessionId);
  if (!sessionIsActive(session)) {
    if (sequence.recoveryRevision !== recoveryRevision) return { outcome: OUTCOMES.BINDING_MOVED, sequence };
    return { outcome: OUTCOMES.SESSION_ENDED, sequence, sessionStatus: session ? session.status : null };
  }
  return { sequence };
}

function clearOneLaunch({
  project, sessionId, sequenceId, recoveryRevision, clearance, clearedBy, batchId = null, batchItemIndex = null
}) {
  const checked = _checkClearEligibility({ project, sessionId, sequenceId, recoveryRevision });
  if (checked.outcome) return checked;
  const { sequence } = checked;

  const cleared = store.launchSequences.clearRecoveryAsOperator(sequence.id, {
    sessionId, recoveryRevision, clearance, clearedBy, batchId, batchItemIndex
  });
  if (!cleared) return { outcome: OUTCOMES.BINDING_MOVED, sequence };

  store.activity.log({
    projectId: project.id,
    sessionId: cleared.sessionId,
    eventType: 'launch.recovery-cleared',
    detail: { sequenceId: cleared.id, clearance, clearedBy, recoveryRevision, ...(batchId ? { batchId } : {}) }
  });
  return { outcome: OUTCOMES.CLEARED, sequence: cleared };
}

/**
 * {@link clearOneLaunch}'s peer-clearance counterpart (#1713): the same
 * eligibility checks, written through
 * {@link module:lib/store/launch.launchSequencesApi.clearRecoveryAsPeer}
 * instead of the operator path, and under `clearance: 'peer-cleared'` in
 * the activity log. The route calling this has already run
 * {@link validatePeerClearance} and refused before reaching here — this
 * function does not re-ask "may this caller clear THIS launch", only
 * "is this launch eligible to be cleared at all".
 * @param {object} args
 * @param {object} args.project - The target launch's project; needs `id`.
 * @param {number} args.sessionId - The session the caller believes this launch is.
 * @param {number} args.sequenceId - The launch sequence being cleared.
 * @param {number} args.recoveryRevision - The recovery revision the caller read.
 * @param {number} args.clearedBySessionId - The clearing peer's own verified session id.
 * @param {number} args.clearedByProjectId - The clearing peer's own project id (Architect Ruling A505-R2.3).
 * @param {'architect'|'project-manager'} args.clearedByRole - The clearing peer's active project role.
 * @param {string} args.clearedByLaunchId - The clearing peer's own launch id.
 * @param {string|null} [args.reason] - Why the peer is clearing it, if given.
 * @returns {{outcome: string, sequence: (object|null), sessionStatus?: (string|null)}} One of
 *   {@link OUTCOMES}, same shape as {@link clearOneLaunch}.
 * @throws {Error} When a record cannot be written; nothing is cleared.
 */
function clearOneLaunchAsPeer({
  project, sessionId, sequenceId, recoveryRevision,
  clearedBySessionId, clearedByProjectId, clearedByRole, clearedByLaunchId, reason = null
}) {
  const checked = _checkClearEligibility({ project, sessionId, sequenceId, recoveryRevision });
  if (checked.outcome) return checked;
  const { sequence } = checked;

  const cleared = store.launchSequences.clearRecoveryAsPeer(sequence.id, {
    sessionId, recoveryRevision, clearedBySessionId, clearedByProjectId, clearedByRole, clearedByLaunchId, reason
  });
  if (!cleared) return { outcome: OUTCOMES.BINDING_MOVED, sequence };

  store.activity.log({
    projectId: project.id,
    sessionId: cleared.sessionId,
    eventType: 'launch.recovery-cleared',
    detail: {
      sequenceId: cleared.id, clearance: 'peer-cleared', clearedBySessionId, clearedByProjectId,
      clearedByRole, clearedByLaunchId, reason, recoveryRevision
    }
  });
  return { outcome: OUTCOMES.CLEARED, sequence: cleared };
}

/** Project-scoped coordinator roles #1713 admits as a delegated peer clearer. */
const PEER_CLEARANCE_ROLES = Object.freeze(['architect', 'project-manager']);

/**
 * What {@link validatePeerClearance} found. `OK` is the only outcome that
 * permits {@link module:lib/store/launch.launchSequencesApi.clearRecoveryAsPeer}
 * to run.
 * @enum {string}
 */
const PEER_CLEARANCE_REFUSALS = Object.freeze({
  // The clearing session named itself as the target.
  SELF: 'self',
  // The clearing session has no row, is not active, or belongs to a
  // different project than the launch being cleared.
  NOT_ACTIVE_PEER: 'not-active-peer',
  // This project has no active architect/project-manager coordinator role —
  // the opt-in that makes delegated peer clearance available at all.
  NOT_COORDINATOR: 'not-coordinator'
});

/**
 * Validate a delegated peer recovery clearance (#1713, Architect Ruling
 * A505-R2 / A505-R2.3): CROSS-PROJECT by design, confirmed against how this
 * fleet actually runs — `TC-Lane-PM`, `TC-Lane-Arc` and the lane they
 * coordinate (e.g. `TC-Lane-B`) are each their OWN `store.projects` row,
 * and `lib/sessions.js#launchSession` refuses a second active session for
 * any one project, so "the coordinator's session" can never be a second
 * session of the TARGET's own project — it is the active session of
 * WHATEVER project holds the opted-in `architect`/`project-manager` grant.
 *
 * This answers only "may THIS clearing session clear THAT target launch
 * through this door", the same split {@link clearOneLaunch} keeps from the
 * route: the write itself, and the launch/revision binding, stay
 * {@link module:lib/store/launch.launchSequencesApi.clearRecoveryAsPeer}'s.
 *
 * Nothing here can tell whether `clearingSessionId` is the SPECIFIC session
 * its project granted the role to, because `coordinator_roles` is a
 * project-wide grant, not a per-session one (`store.coordinatorRoles` has no
 * session column) — the same limit `lib/primer-launch-wiring.js
 * #resolveSessionRole` already lives with. What this DOES prove: SOME
 * project opted in by holding an active architect/project-manager grant,
 * and the clearing session is a real, currently active, launched session
 * of exactly that project — not an arbitrary session id taken on faith
 * from the request body, and not the target's own project (self-clear).
 * @param {object} args
 * @param {object} args.targetProject - The target launch's project (needs `id`).
 * @param {number} args.targetSessionId - The session whose recovery is being cleared.
 * @param {number} args.clearingSessionId - The caller's own VERIFIED session id
 *   (from its launch-binding headers, never the request body).
 * @returns {{ok: true, role: ('architect'|'project-manager'), clearedByProjectId: number}|{ok: false, refusal: string, message: string}}
 */
function validatePeerClearance({ targetProject, targetSessionId, clearingSessionId }) {
  if (clearingSessionId === targetSessionId) {
    return {
      ok: false, refusal: PEER_CLEARANCE_REFUSALS.SELF,
      message: 'A session may not clear its own recovery through the peer-clearance door; that is the agent-reconciled or operator door instead.'
    };
  }
  const clearingSession = store.sessions.get(clearingSessionId);
  if (!sessionIsActive(clearingSession)) {
    return {
      ok: false, refusal: PEER_CLEARANCE_REFUSALS.NOT_ACTIVE_PEER,
      message: 'The clearing session must be an active, launched session.'
    };
  }
  // A clearing session can only ever be ANOTHER project's session (at most
  // one active session per project), so this also catches the project
  // calling itself through the peer door by project id, not just by
  // session id.
  if (clearingSession.projectId === targetProject.id) {
    return {
      ok: false, refusal: PEER_CLEARANCE_REFUSALS.SELF,
      message: 'A project\'s own session may not clear its own launch\'s recovery through the peer-clearance door, whichever session of it is asking.'
    };
  }
  const activeRole = store.coordinatorRoles.getActiveForProject(clearingSession.projectId);
  if (!activeRole || !PEER_CLEARANCE_ROLES.includes(activeRole.role)) {
    return {
      ok: false, refusal: PEER_CLEARANCE_REFUSALS.NOT_COORDINATOR,
      message: 'The clearing session\'s own project has no active architect/project-manager coordinator role granted, so it is not opted in to delegated peer clearance.'
    };
  }
  return { ok: true, role: activeRole.role, clearedByProjectId: clearingSession.projectId };
}

module.exports = {
  OUTCOMES, clearOneLaunch, clearOneLaunchAsPeer, sessionIsActive, isNotApplicableDamagedHandoff,
  PEER_CLEARANCE_REFUSALS, validatePeerClearance
};
