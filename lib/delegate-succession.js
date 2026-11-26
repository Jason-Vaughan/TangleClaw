'use strict';

/**
 * v6 (#3272, V6-028, Car V664-W1-B): Delegate Role Succession & Surrogate
 * Hierarchy (Primary Coordinator -> Technical Authority/Architect ->
 * Designated Surrogate) — explicitly distinct from Engine Fallback (V6-027).
 *
 * `lib/coordinator-rotation.js` already ships #2351 (Architect Ruling
 * A2351): detecting an unreachable decider and ALERTING a human via a
 * `decision_requests` row (`gate: 'decider-unreachable'`), with a FIXED
 * fallback mapping (`_fallbackRoute`: a project-manager's fallback is
 * whichever project holds the active architect role, or the operator).
 * That module's detection/alerting is reused, not re-built, by staying out
 * of this one entirely. What's missing, and what this module is: a
 * CONFIGURABLE succession chain (not the fixed PM-to-whoever's-architect
 * rule) and the actual, clean AUTHORITY TRANSFER once failover is decided
 * — #2351 only ever alerts a human; nothing in this repo moves coordinator
 * authority automatically today.
 *
 * Built directly on #3263's `lib/delegate-assignment.js#assignFleetDelegate`
 * (per the dispatch's own note, "builds cleanly on #3263 schema"): both
 * {@link failoverToSurrogate} and {@link recoverToPrimary} are thin
 * wrappers that compute WHICH reassignment the chain calls for, then hand
 * the actual coordinator_roles/fleetCoordinator/workloadNudge transfer to
 * that already-built, already-tested function. This module adds exactly
 * the chain logic and the split-brain guard: never transfer away from a
 * project the store doesn't actually show as the live active coordinator,
 * since a caller's belief about "who's live now" can be stale (a previous
 * failover it doesn't know about, a race between two triggers).
 *
 * Who DECIDES to call this (the configured escalation threshold, or an
 * explicit Operator/watchdog trigger) is the caller's job, same as #3263
 * left fleet-membership discovery to ITS caller — this module only
 * executes a transfer cleanly once something else has decided to ask for
 * one. `control_assignments`' own authority matrix is not updated by this
 * either, for the same reason {@link assignFleetDelegate} doesn't: see
 * that module's header.
 *
 * @module lib/delegate-succession
 */

const store = require('./store');
const { assignFleetDelegate } = require('./delegate-assignment');

/** A typed refusal: `code` is stable, `status` is the HTTP status a route should answer with. */
class DelegateSuccessionError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {object} [detail]
   */
  constructor(code, message, status = 400, detail) {
    super(message);
    this.name = 'DelegateSuccessionError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Throw a {@link DelegateSuccessionError} unless `condition` holds.
 * @param {*} condition
 * @param {string} code
 * @param {string} message
 * @param {number} [status]
 * @param {object} [detail]
 * @returns {void}
 */
function need(condition, code, message, status = 400, detail) {
  if (!condition) throw new DelegateSuccessionError(code, message, status, detail);
}

/**
 * Validate a succession chain: a non-empty array of distinct positive
 * integer project ids, primary first.
 * @param {*} chain
 * @returns {number[]}
 */
function _validateChain(chain) {
  need(Array.isArray(chain) && chain.length >= 1, 'CHAIN_REQUIRED', 'chain must be a non-empty array of project ids');
  need(chain.every((id) => Number.isSafeInteger(id) && id > 0), 'CHAIN_INVALID', 'chain must hold only positive integer project ids');
  need(new Set(chain).size === chain.length, 'CHAIN_DUPLICATE', 'chain must not repeat a project id');
  return chain;
}

/**
 * The next candidate after `currentProjectId` in `chain` — the first entry
 * strictly after it, so a chain with an already-skipped-over surrogate
 * (one that itself later became unreachable) is not retried first. `null`
 * when `currentProjectId` is the chain's last entry (nothing further to
 * fail over to) or is not in the chain at all.
 * @param {number[]} chain - Already validated.
 * @param {number} currentProjectId
 * @returns {number|null}
 */
function nextSurrogate(chain, currentProjectId) {
  const at = chain.indexOf(currentProjectId);
  if (at === -1 || at === chain.length - 1) return null;
  return chain[at + 1];
}

/**
 * Whether `projectId` is genuinely the live, active `project-manager`
 * coordinator right now — the split-brain guard every transfer in this
 * module runs before acting, so a caller's stale belief about who is
 * currently the delegate can never trigger a transfer away from a project
 * that already isn't (a race between two triggers, or a failover the
 * caller doesn't know already happened).
 * @param {number} projectId
 * @returns {boolean}
 */
function _isLiveActiveDelegate(projectId) {
  const role = store.coordinatorRoles.getActiveForProject(projectId);
  return Boolean(role && role.role === 'project-manager');
}

/**
 * Fail over from the chain's currently-active project to the next
 * surrogate after it, transferring real coordinator authority via
 * {@link assignFleetDelegate}. Refuses rather than acts when
 * `currentProjectId` is not genuinely the live active delegate (split-brain
 * guard) or when the chain names no surrogate after it.
 *
 * @param {{chain: number[], currentProjectId: number, memberProjectIds?: number[], note?: string}} input
 * @param {{kind: string}} caller - Forwarded to {@link assignFleetDelegate}; must resolve to the operator.
 * @param {{now?: () => string}} [deps]
 * @returns {{ok: boolean, from: number, to: number, assignment: object}}
 * @throws {DelegateSuccessionError} `CHAIN_REQUIRED`, `CHAIN_INVALID`, `CHAIN_DUPLICATE`,
 *   `CURRENT_NOT_LIVE_DELEGATE`, `NO_SURROGATE_AVAILABLE`.
 */
function failoverToSurrogate(input, caller, deps = {}) {
  const chain = _validateChain(input.chain);
  need(Number.isSafeInteger(input.currentProjectId) && input.currentProjectId > 0, 'CURRENT_PROJECT_ID_INVALID', 'currentProjectId must be a positive integer');
  need(_isLiveActiveDelegate(input.currentProjectId), 'CURRENT_NOT_LIVE_DELEGATE',
    'currentProjectId is not the live active project-manager delegate -- refusing to avoid a split-brain transfer away from a stale belief',
    409, { projectId: input.currentProjectId });
  const surrogate = nextSurrogate(chain, input.currentProjectId);
  need(surrogate !== null, 'NO_SURROGATE_AVAILABLE', 'the chain names no surrogate after currentProjectId', 409, { chain, currentProjectId: input.currentProjectId });

  const assignment = assignFleetDelegate({
    newDelegateProjectId: surrogate, oldDelegateProjectId: input.currentProjectId,
    memberProjectIds: input.memberProjectIds, note: input.note || 'Delegate succession failover (#3272)'
  }, caller, deps);
  return { ok: assignment.ok, from: input.currentProjectId, to: surrogate, assignment };
}

/**
 * Hand coordinator authority cleanly back to the chain's primary (`chain[0]`)
 * once it has recovered, via {@link assignFleetDelegate}. A no-op (not a
 * refusal) when the primary already holds the live active delegate role —
 * recovery is idempotent, so calling it twice, or calling it when nothing
 * ever failed over, does nothing rather than erroring.
 *
 * @param {{chain: number[], memberProjectIds?: number[], note?: string}} input
 * @param {{kind: string}} caller - Forwarded to {@link assignFleetDelegate}; must resolve to the operator.
 * @param {{now?: () => string}} [deps]
 * @returns {{ok: true, noop: boolean, from: (number|null), to: number, assignment: (object|null)}}
 * @throws {DelegateSuccessionError} `CHAIN_REQUIRED`, `CHAIN_INVALID`, `CHAIN_DUPLICATE`.
 */
function recoverToPrimary(input, caller, deps = {}) {
  const chain = _validateChain(input.chain);
  const primary = chain[0];
  if (_isLiveActiveDelegate(primary)) {
    return { ok: true, noop: true, from: null, to: primary, assignment: null };
  }
  const current = chain.find((id) => _isLiveActiveDelegate(id));
  const assignment = assignFleetDelegate({
    newDelegateProjectId: primary, oldDelegateProjectId: current ?? null,
    memberProjectIds: input.memberProjectIds, note: input.note || 'Delegate succession recovery to primary (#3272)'
  }, caller, deps);
  return { ok: assignment.ok, noop: false, from: current ?? null, to: primary, assignment };
}

module.exports = { DelegateSuccessionError, nextSurrogate, failoverToSurrogate, recoverToPrimary };
