'use strict';

/**
 * Session Switchboard v2 opt-in auto-inject gate and swarm stats
 * aggregation (#801, Architect Ruling A801, `v5.60.0` Car 60-C Slice 1).
 *
 * A pure evaluator/aggregator: {@link evaluateAutoInjectEligibility} and
 * {@link computeSwarmStats} take the caller's already-fetched session and
 * exchange facts as plain data and return a computed verdict or stats
 * object -- nothing here reads Medusa's store, delivers a message, or
 * verifies a live binding itself. Wiring this into `server.js`,
 * `lib/routes/*.js` and `public/app.js` (which would resolve the REAL
 * session binding and REAL exchange records) is Slice 2, deliberately
 * deferred so Car 60-C stays 100% file-disjoint from this wave's other
 * `v5.60.0` cars.
 *
 * @module lib/switchboard-swarm-stats
 */

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * Whether a target session may receive an auto-injected switchboard
 * message (#801): it must have explicitly opted in, AND every
 * delivery-guarantee precondition the ruling names must hold --
 * `liveSessionBindingVerified`, not `wedged`, and `ackTrackingActive`.
 * Refuses with `SWITCHBOARD_AUTO_INJECT_DISABLED` when the session never
 * opted in at all (the caller's own choice, not a guarantee failure) and
 * `SWITCHBOARD_DELIVERY_GUARANTEE_UNMET` when it opted in but the
 * guarantee itself cannot be verified -- two different refusals so a
 * caller can tell "ask the session to opt in" apart from "this would
 * silently drop the message right now".
 * @param {object} input
 * @param {string} input.sessionId
 * @param {boolean} input.optedIn
 * @param {boolean} input.liveSessionBindingVerified
 * @param {boolean} input.wedged
 * @param {boolean} input.ackTrackingActive
 * @returns {{ok: true, result: {sessionId: string, eligible: true}}|{ok: false, code: string, message: string}}
 */
function evaluateAutoInjectEligibility(input) {
  if (!input || typeof input !== 'object' || typeof input.sessionId !== 'string' || !input.sessionId) {
    return _refuse('SWITCHBOARD_SWARM_STATS_INVALID', 'input.sessionId is required.');
  }
  for (const key of ['optedIn', 'liveSessionBindingVerified', 'wedged', 'ackTrackingActive']) {
    if (typeof input[key] !== 'boolean') {
      return _refuse('SWITCHBOARD_SWARM_STATS_INVALID', `input.${key} must be a boolean.`);
    }
  }
  if (!input.optedIn) {
    return _refuse('SWITCHBOARD_AUTO_INJECT_DISABLED',
      `Session "${input.sessionId}" has not opted in to auto-inject.`);
  }
  if (!input.liveSessionBindingVerified || input.wedged || !input.ackTrackingActive) {
    return _refuse('SWITCHBOARD_DELIVERY_GUARANTEE_UNMET',
      `Session "${input.sessionId}" opted in, but the delivery guarantee cannot be verified right now.`);
  }
  return { ok: true, result: { sessionId: input.sessionId, eligible: true } };
}

/**
 * The nearest-rank percentile of a numeric array (deterministic, no
 * interpolation) -- `null` for an empty array.
 * @param {number[]} values
 * @param {number} p - `0`-`100`
 * @returns {number|null}
 */
function _percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index];
}

/**
 * One lane's (or the fleet's) slice of swarm stats from a list of
 * exchanges already scoped to it.
 * @param {object[]} exchanges
 * @returns {object}
 */
function _summarizeExchanges(exchanges) {
  const ackLatencies = exchanges.map((e) => e.ackLatencyMs).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const eligibleSessions = new Set();
  const verifiedSessions = new Set();
  for (const e of exchanges) {
    if (e.autoInjectEligible) eligibleSessions.add(e.lane);
    if (e.deliveryGuaranteeVerified) verifiedSessions.add(e.lane);
  }
  return {
    totalExchanges: exchanges.length,
    openExchanges: exchanges.filter((e) => e.state === 'open').length,
    owedReplies: exchanges.filter((e) => e.owed === true).length,
    ackLatencyMsP50: _percentile(ackLatencies, 50),
    ackLatencyMsP95: _percentile(ackLatencies, 95),
    autoInjectEligibleCount: eligibleSessions.size,
    deliveryGuaranteeVerifiedCount: verifiedSessions.size
  };
}

/**
 * Compute deterministic per-lane and fleet-wide switchboard swarm metrics
 * (#801) from a flat list of already-fetched exchange records.
 * `autoInjectEligibleCount`/`deliveryGuaranteeVerifiedCount` count distinct
 * LANES (sessions), not exchanges -- a scoping decision, since the ruling
 * names them as swarm-wide metrics and a lane with several exchanges
 * eligible for auto-inject is one eligible lane, not N.
 * @param {object[]} exchanges - Each: `{lane, state: 'open'|'closed',
 *   owed: boolean, ackLatencyMs: (number|null), autoInjectEligible?: boolean,
 *   deliveryGuaranteeVerified?: boolean}`
 * @returns {{ok: true, stats: object}|{ok: false, code: string, message: string}}
 */
function computeSwarmStats(exchanges) {
  if (!Array.isArray(exchanges)) {
    return _refuse('SWITCHBOARD_SWARM_STATS_INVALID', 'exchanges must be an array.');
  }
  for (let i = 0; i < exchanges.length; i++) {
    const e = exchanges[i];
    if (!e || typeof e !== 'object' || typeof e.lane !== 'string' || !e.lane) {
      return _refuse('SWITCHBOARD_SWARM_STATS_INVALID', `exchanges[${i}] has no "lane".`);
    }
    if (e.state !== 'open' && e.state !== 'closed') {
      return _refuse('SWITCHBOARD_SWARM_STATS_INVALID', `exchanges[${i}].state must be "open" or "closed".`);
    }
  }

  const byLane = new Map();
  for (const e of exchanges) {
    if (!byLane.has(e.lane)) byLane.set(e.lane, []);
    byLane.get(e.lane).push(e);
  }
  const byLaneStats = {};
  for (const [lane, laneExchanges] of byLane) {
    byLaneStats[lane] = _summarizeExchanges(laneExchanges);
  }

  return { ok: true, stats: { ..._summarizeExchanges(exchanges), byLane: byLaneStats } };
}

module.exports = {
  evaluateAutoInjectEligibility,
  computeSwarmStats
};
