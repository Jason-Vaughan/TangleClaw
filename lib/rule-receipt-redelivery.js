'use strict';

/**
 * Bounded startup-rules receipt watcher & re-delivery coordinator (#1176).
 *
 * `lib/session-rules-channel.js` upgrades a `rules-hook` delivery from
 * `written` to `delivered` only when the SessionStart hook itself posts a
 * receipt (#1063). A hook that never fires leaves the row `written` forever,
 * with nothing watching for that — the exact silent-channel shape #759 and
 * #1063 exist to end. This module is that watch: for every live session whose
 * most recent rules-hook delivery is still `written` once the session has
 * stood active past a grace window, it disambiguates why (#1150) and, only
 * when nothing local explains the silence, re-delivers the rules a bounded
 * number of times through a caller-supplied open channel.
 *
 * **Sandbox loopback disambiguation (#1150).** The hook's receipt POST and
 * "the hook ran at all" are not the same fact: a managed sandbox that blocks
 * loopback networking (the exact shape #1150 reports for Codex) makes a
 * healthy hook's `curl` fail for a reason that has nothing to do with whether
 * the rules reached the engine — `cat`, which is what actually puts the rules
 * in front of the model, runs and succeeds either way. Treating "no receipt"
 * as "the channel is silent" in that case would re-deliver rules the engine
 * already has, and would misreport a healthy session as broken, which is
 * exactly the false-outage failure #1150 was filed over. The one piece of
 * local evidence this repo's hook already leaves behind is the receipt token
 * itself (`lib/session-rules-channel.js#receiptTokenPath`): the hook deletes
 * it ONLY on a successful POST, so a token still on disk for this exact
 * delivery means the question is still open — not yet evidence either way —
 * and must not be read as a failure. Only a `written` row with no live token
 * for it is safe to treat as needing re-delivery.
 *
 * **Bounded, in-memory attempts.** Attempt counters live in this process's
 * memory, keyed by delivery id, and are deliberately not persisted: a restart
 * that loses them can at worst cause one extra bounded attempt later, which is
 * the same cost an ordinary cooldown miss already accepts, never a correctness
 * problem. `deliverViaOpenChannel` has no default implementation — only the
 * caller wiring this watcher into a real deployment knows which channel
 * (Medusa, a pointer paste, …) actually reaches a given session, and resolving
 * is this module's only definition of "confirmed."
 */

const fs = require('node:fs');
const { createLogger } = require('./logger');
const store = require('./store');
const rulesChannel = require('./session-rules-channel');

const log = createLogger('rule-receipt-redelivery');

/** How long a session must have been observed active before its `written` row is judged. */
const DEFAULT_GRACE_MS = 5 * 60 * 1000;

/** Bounded re-delivery attempts per delivery row before giving up. */
const DEFAULT_MAX_ATTEMPTS = 2;

/** Minimum spacing between re-delivery attempts for the same delivery row. */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** `activity_log` event_type for one re-delivery attempt. */
const EVENT_ATTEMPT = 'session.rule_redelivery_attempt';

/** `activity_log` event_type for a delivery that exhausted its attempts unconfirmed. */
const EVENT_EXHAUSTED = 'session.rule_redelivery_exhausted';

/** Per-delivery attempt bookkeeping: deliveryId -> {count, lastAttemptAt, exhausted}. */
const _attempts = new Map();

/**
 * Test seam: drop all in-memory attempt bookkeeping.
 * @returns {void}
 */
function _resetAttemptState() {
  _attempts.clear();
}

/**
 * Read the local rules-hook receipt token for a project and say whether it
 * still names the given delivery.
 * @param {string} projectPath - Project checkout root.
 * @param {number} deliveryId - The `session_rule_deliveries` row id to match.
 * @returns {{exists: boolean, matches: boolean}}
 */
function probeLocalReceipt(projectPath, deliveryId) {
  const file = rulesChannel.receiptTokenPath(projectPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('Failed to read the rules-hook receipt token while disambiguating a written delivery', {
        file, error: err.message
      });
    }
    return { exists: false, matches: false };
  }
  try {
    const parsed = JSON.parse(raw);
    return { exists: true, matches: Number(parsed && parsed.deliveryId) === Number(deliveryId) };
  } catch (err) {
    log.warn('Rules-hook receipt token is not valid JSON', { file, error: err.message });
    return { exists: true, matches: false };
  }
}

/**
 * Classify one `written` rules-hook delivery row against the local receipt
 * token, disambiguating "nothing has explained the silence yet" from "this
 * row is simply stale" (#1150).
 * @param {{id: number}} delivery - A `rules-hook`/`written` delivery row.
 * @param {string} projectPath - The project's checkout root.
 * @param {object} [deps]
 * @param {(projectPath: string, deliveryId: number) => {exists: boolean, matches: boolean}} [deps.probeLocalReceipt]
 * @returns {{status: 'local-receipt-pending'|'superseded'|'needs-redelivery', reason: string}}
 */
function classifyWrittenDelivery(delivery, projectPath, deps = {}) {
  const probe = deps.probeLocalReceipt || probeLocalReceipt;
  const receipt = probe(projectPath, delivery.id);
  if (receipt.exists && receipt.matches) {
    return {
      status: 'local-receipt-pending',
      reason: 'the rules-hook receipt token for this delivery is still on disk, unconsumed — the hook may '
        + 'have already run and only its receipt POST failed (a sandboxed engine with loopback blocked, #1150), '
        + 'so a missing receipt alone is not yet evidence of a silent channel'
    };
  }
  if (receipt.exists && !receipt.matches) {
    return {
      status: 'superseded',
      reason: 'a newer launch has overwritten the receipt token with a different delivery id; this row belongs '
        + 'to a session that is no longer the one being primed'
    };
  }
  return {
    status: 'needs-redelivery',
    reason: 'no local receipt token exists for this delivery and the grace window has elapsed'
  };
}

/**
 * Every live session whose most recent rules-hook delivery is still `written`.
 * @returns {Array<{delivery: object, session: object}>}
 */
function _defaultListCandidates() {
  const candidates = [];
  for (const session of store.sessions.listLiveAll()) {
    const deliveries = store.sessionRuleDeliveries.listForSession(session.id);
    const latest = deliveries[deliveries.length - 1];
    if (latest && latest.channel === 'rules-hook' && latest.outcome === 'written') {
      candidates.push({ delivery: latest, session });
    }
  }
  return candidates;
}

/**
 * Parse a SQLite `datetime('now')` timestamp (UTC, no zone marker) the same
 * way `store/session-rules.js#markDelivered` does, so grace-window math agrees
 * with the server-side freshness window that already governs this ledger.
 * @param {string} value
 * @returns {number} Milliseconds since epoch, or `NaN` if unparseable.
 */
function _parseSqliteUtc(value) {
  return Date.parse(`${String(value).replace(' ', 'T')}Z`);
}

/**
 * Surface an exhausted delivery: log it to the activity feed, warn, and run
 * the caller's optional escalation callback. Never throws.
 * @param {object} delivery
 * @param {object} session
 * @param {object} project
 * @param {{count: number}} state
 * @param {object} deps
 * @param {string|null} [reason]
 * @returns {void}
 */
function _surfaceExhaustion(delivery, session, project, state, deps, reason) {
  store.activity.log({
    projectId: project.id,
    sessionId: session.id,
    eventType: EVENT_EXHAUSTED,
    detail: { deliveryId: delivery.id, attempts: state.count, exhausted: true, reason: reason || null }
  });
  log.warn('Rules-hook receipt never confirmed after bounded re-delivery — session may be running undelivered rules', {
    deliveryId: delivery.id, sessionId: session.id, projectId: project.id, attempts: state.count
  });
  if (typeof deps.onExhausted === 'function') {
    try {
      deps.onExhausted({
        sessionId: session.id, projectId: project.id, deliveryId: delivery.id,
        attempts: state.count, reason: reason || null
      });
    } catch (err) {
      log.warn('rule-receipt-redelivery onExhausted escalation callback threw', { error: err.message });
    }
  }
}

/**
 * Judge and, if warranted, re-deliver one candidate delivery.
 * @param {object} delivery
 * @param {object} session
 * @param {{nowMs: number, graceMs: number, maxAttempts: number, cooldownMs: number, getRules: Function, deps: object}} ctx
 * @returns {Promise<object>} One outcome record.
 */
async function _processOne(delivery, session, ctx) {
  const { nowMs, graceMs, maxAttempts, cooldownMs, getRules, deps } = ctx;
  const base = { deliveryId: delivery.id, sessionId: session.id };

  // Re-checked here, not just by `_defaultListCandidates`'s own filter: a
  // caller-supplied `listCandidates` could hand this a row that is not a
  // `written` rules-hook delivery, and `written` is the only outcome a
  // receipt (or this watcher) may ever act on (mirrors the same guard in
  // `store/session-rules.js#markDelivered`).
  if (delivery.channel !== 'rules-hook' || delivery.outcome !== 'written') {
    return { ...base, status: 'not-applicable' };
  }

  const startedAtMs = _parseSqliteUtc(session.startedAt);
  const activeForMs = Number.isFinite(startedAtMs) ? nowMs - startedAtMs : -Infinity;
  if (activeForMs < graceMs) {
    return { ...base, status: 'pending-grace' };
  }

  const project = store.projects.get(session.projectId);
  if (!project) {
    return { ...base, status: 'no-project' };
  }
  const withProject = { ...base, projectId: project.id };

  const classification = classifyWrittenDelivery(delivery, project.path, deps);
  if (classification.status !== 'needs-redelivery') {
    return { ...withProject, status: classification.status, reason: classification.reason };
  }

  const state = _attempts.get(delivery.id) || { count: 0, lastAttemptAt: 0, exhausted: false, confirmed: false };
  // The underlying ledger row stays `written` by design (`markDelivered` is
  // reserved for the original hook's own receipt, never for a confirmation
  // through a different channel — see the module doc), so an already-confirmed
  // delivery would otherwise look like a fresh `needs-redelivery` candidate on
  // every later pass. This is what stops that.
  if (state.confirmed) {
    return { ...withProject, status: 'already-redelivered', attempts: state.count };
  }
  if (state.exhausted) {
    return { ...withProject, status: 'exhausted', attempts: state.count };
  }
  if (state.count >= maxAttempts) {
    state.exhausted = true;
    _attempts.set(delivery.id, state);
    _surfaceExhaustion(delivery, session, project, state, deps);
    return { ...withProject, status: 'exhausted', attempts: state.count };
  }
  if (state.count > 0 && nowMs - state.lastAttemptAt < cooldownMs) {
    return { ...withProject, status: 'cooling-down', attempts: state.count };
  }

  const attempt = state.count + 1;
  const rules = getRules(project.id);
  let confirmed = false;
  let detail = null;
  try {
    await deps.deliverViaOpenChannel({ sessionId: session.id, projectId: project.id, rules, attempt });
    confirmed = true;
  } catch (err) {
    detail = err.message;
  }

  state.count = attempt;
  state.lastAttemptAt = nowMs;
  _attempts.set(delivery.id, state);

  store.activity.log({
    projectId: project.id,
    sessionId: session.id,
    eventType: EVENT_ATTEMPT,
    detail: { deliveryId: delivery.id, attempt, confirmed, error: detail }
  });

  if (confirmed) {
    state.confirmed = true;
    _attempts.set(delivery.id, state);
    return { ...withProject, status: 'redelivered', attempt };
  }
  if (attempt >= maxAttempts) {
    state.exhausted = true;
    _attempts.set(delivery.id, state);
    _surfaceExhaustion(delivery, session, project, state, deps, detail);
    return { ...withProject, status: 'exhausted', attempts: attempt, reason: detail };
  }
  return { ...withProject, status: 'attempt-failed', attempt, reason: detail };
}

/**
 * Run one pass of the watcher.
 * @param {object} deps
 * @param {(entry: {sessionId: number, projectId: number, rules: object[], attempt: number}) => Promise<any>} deps.deliverViaOpenChannel -
 *   Resolving means the open channel confirmed delivery; throwing (or rejecting)
 *   means it did not. Required — see the module doc for why there is no default.
 * @param {() => Array<{delivery: object, session: object}>} [deps.listCandidates] - Test seam; defaults to the live store.
 * @param {(projectId: number) => object[]} [deps.getRules] - Defaults to `store.sessionRules.listActiveForProject`.
 * @param {(projectPath: string, deliveryId: number) => {exists: boolean, matches: boolean}} [deps.probeLocalReceipt]
 * @param {() => number} [deps.now] - Clock override for tests; defaults to `Date.now`.
 * @param {number} [deps.graceMs] - Defaults to `DEFAULT_GRACE_MS`.
 * @param {number} [deps.maxAttempts] - Defaults to `DEFAULT_MAX_ATTEMPTS`.
 * @param {number} [deps.cooldownMs] - Defaults to `DEFAULT_COOLDOWN_MS`.
 * @param {(entry: {sessionId: number, projectId: number, deliveryId: number, attempts: number, reason: string|null}) => void} [deps.onExhausted] -
 *   Optional escalation hook, run once a delivery exhausts its attempts unconfirmed. Errors from it are logged, never thrown.
 * @returns {Promise<object[]>} One outcome record per `written` rules-hook delivery examined.
 * @throws {Error} If `deps.deliverViaOpenChannel` is not a function.
 */
async function checkAndRedeliver(deps = {}) {
  if (typeof deps.deliverViaOpenChannel !== 'function') {
    throw new Error('rule-receipt-redelivery: deliverViaOpenChannel({sessionId, projectId, rules, attempt}) is required');
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const graceMs = Number.isFinite(deps.graceMs) ? deps.graceMs : DEFAULT_GRACE_MS;
  const maxAttempts = Number.isInteger(deps.maxAttempts) && deps.maxAttempts > 0 ? deps.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const cooldownMs = Number.isFinite(deps.cooldownMs) ? deps.cooldownMs : DEFAULT_COOLDOWN_MS;
  const listCandidates = deps.listCandidates || _defaultListCandidates;
  const getRules = deps.getRules || ((projectId) => store.sessionRules.listActiveForProject(projectId));
  const nowMs = now();

  const outcomes = [];
  for (const { delivery, session } of listCandidates()) {
    outcomes.push(await _processOne(delivery, session, { nowMs, graceMs, maxAttempts, cooldownMs, getRules, deps }));
  }
  return outcomes;
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_COOLDOWN_MS,
  EVENT_ATTEMPT,
  EVENT_EXHAUSTED,
  probeLocalReceipt,
  classifyWrittenDelivery,
  checkAndRedeliver,
  _resetAttemptState
};
