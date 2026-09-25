'use strict';

/**
 * Medusa delivery watchdog (#1839): the server-owned timer.
 *
 * A deterministic loop over durable exchange state, not an agent: it spends no
 * turns, depends on no inbox of its own, and survives a restart because
 * everything it decides from is in the exchange record. It never injects
 * anything. What it may do is re-arm a wake, which only lets the wake monitor
 * (`lib/medusa-wake.js`) try again, through every gate, for a message whose
 * nudge provably did not land, or whose session became ready again after it.
 *
 * Re-arm rules, read from the attempt history rather than the latest verdict
 * (a reconnect or a busy pane after an attempt does not undo the attempt):
 * - Only an exchange that has been attempted, with nothing read or
 *   acknowledged, no re-arm already pending, and no receipt saying the engine
 *   accepted the nudge. Accepted-but-unread is for escalation, not another wake.
 * - A re-arm needs a durable trigger newer than the attempt: a negative
 *   receipt (its nonce left in the composer), which is eligible at once, or a
 *   persisted readiness change (the gates found the session ineligible after
 *   the nudge and eligible again since), which is eligible once
 *   `rearmAfterMs` has also passed. Elapsed time alone never re-arms and never
 *   spends budget: an attempt with neither trigger stays unconfirmed and is
 *   left to escalate by age.
 * - Each re-arm sets a persisted `next_eligible_at` from a backoff schedule,
 *   and the count is capped. Both live in the record, so duplicate ticks and a
 *   restart mid-backoff re-arm nothing twice.
 *
 * Escalation (chunk 04): an open blocking or critical exchange that stays
 * unread, or unanswered after an ack when a reply is required, climbs a
 * one-way ladder: `aged` (the sender is told), `escalated` (the escalation
 * route on the recipient's control assignment is told), `operator` (the
 * dashboard shows it and it is logged). Each rung is reached once, from server
 * time, and recorded before any notice is sent, so a duplicate tick or a
 * restart never repeats a notice. A notice is recorded as queued, then accepted
 * (the Hub stored it, which is not "delivered") or failed. A target that cannot
 * receive it is recorded as undeliverable, and the operator alert stands.
 * Notices carry ids, ages, codes and names only, never message text. They come
 * from `system`, so they never become exchanges themselves.
 *
 * @module lib/medusa-watchdog
 */

const store = require('./store');
const exchanges = require('./medusa-exchanges');
const { createLogger } = require('./logger');
const control = require('./control-state');
const registry = require('./medusa-registry');

const log = createLogger('medusa-watchdog');

const MIN = 60 * 1000;

/** Defaults for `config.medusaWatchdog`. Escalation thresholds are measured from server time. */
const DEFAULTS = Object.freeze({
  enabled: true,
  tickMs: 30 * 1000,
  rearmAfterMs: 3 * MIN,
  backoffMs: Object.freeze([2 * MIN, 4 * MIN, 8 * MIN]),
  maxRearms: 3,
  // Unread since sent: when the sender is told it has aged.
  agedNormalMs: 30 * MIN,
  agedBlockingMs: 5 * MIN,
  // Unread since sent: when a blocking message reaches its escalation route. A
  // sender's escalateAfterMinutes may only shorten this.
  escalateBlockingMs: 15 * MIN,
  // When the operator is alerted. Critical messages reach the sender and the
  // escalation route at once; the operator alert follows.
  operatorBlockingMs: 60 * MIN,
  operatorCriticalMs: 5 * MIN,
  // Acknowledged but still unanswered, when a reply is required: measured from the ack.
  replyBlockingMs: 30 * MIN,
  replyCriticalMs: 15 * MIN
});

/** Bounds each numeric setting must fall within. */
const BOUNDS = Object.freeze({
  tickMs: [5 * 1000, 10 * MIN],
  rearmAfterMs: [30 * 1000, 60 * MIN],
  backoffStepMs: [30 * 1000, 60 * MIN],
  maxRearms: [0, 10],
  agedNormalMs: [MIN, 24 * 60 * MIN],
  agedBlockingMs: [MIN, 24 * 60 * MIN],
  escalateBlockingMs: [2 * MIN, 24 * 60 * MIN],
  operatorBlockingMs: [5 * MIN, 48 * 60 * MIN],
  operatorCriticalMs: [MIN, 24 * 60 * MIN],
  replyBlockingMs: [5 * MIN, 24 * 60 * MIN],
  replyCriticalMs: [MIN, 24 * 60 * MIN]
});

/** Numeric settings validated against BOUNDS as whole numbers. */
const NUMERIC_KEYS = Object.freeze(['tickMs', 'rearmAfterMs', 'maxRearms', 'agedNormalMs', 'agedBlockingMs',
  'escalateBlockingMs', 'operatorBlockingMs', 'operatorCriticalMs', 'replyBlockingMs', 'replyCriticalMs']);

/** Seams for tests. */
const _internal = {
  /** @returns {number} Server time in ms. */
  now: () => Date.now(),
  /** @returns {object} The stored global config. */
  loadConfig: () => store.config.load(),
  /**
   * Send a system notice over Medusa.
   * @param {{to: string, message: string}} m
   * @returns {Promise<{status: string, id?: string}>}
   */
  sendSystemMessage: (m) => require('./medusa').sendSystemMessage(m),
  /**
   * The switchboard workspace of a project's live session, or null.
   * @param {number} projectId - Project id
   * @returns {string|null}
   */
  workspaceForProject: (projectId) => {
    const project = Number.isInteger(projectId) ? store.projects.get(projectId) : null;
    const active = project ? store.sessions.getActive(project.id) : null;
    return active ? registry.getWorkspaceId(project.path, active.id) : null;
  },
  /**
   * Whether a live session on this host holds a workspace id.
   * @param {string} workspaceId - Workspace id
   * @returns {boolean}
   */
  isLocalWorkspace: (workspaceId) => !!require('./medusa-wake').localParticipant(workspaceId),
  /**
   * The operator-facing meaning of a wake reason code.
   * @param {string} code - Reason code
   * @returns {string|null}
   */
  reasonMeaning: (code) => require('./medusa-wake').peerReasonMeaning(code),
  /**
   * Log an operator-visible activity row.
   * @param {object} event - `store.activity.log` event
   * @returns {void}
   */
  logActivity: (event) => store.activity.log(event)
};

let _timer = null;

/**
 * Check a proposed `medusaWatchdog` setting against the bounds.
 * @param {object} value - Candidate settings (partial)
 * @returns {string|null} What is wrong, or null
 */
function _problem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'medusaWatchdog must be an object';
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULTS)) return `medusaWatchdog.${key} is not a setting`;
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') return 'medusaWatchdog.enabled must be true or false';
  for (const key of NUMERIC_KEYS) {
    if (!(key in value)) continue;
    const [lo, hi] = BOUNDS[key];
    if (!Number.isInteger(value[key]) || value[key] < lo || value[key] > hi) {
      return `medusaWatchdog.${key} must be a whole number between ${lo} and ${hi}`;
    }
  }
  if ('backoffMs' in value) {
    const [lo, hi] = BOUNDS.backoffStepMs;
    const ok = Array.isArray(value.backoffMs) && value.backoffMs.length >= 1 && value.backoffMs.length <= 10
      && value.backoffMs.every((ms) => Number.isInteger(ms) && ms >= lo && ms <= hi);
    if (!ok) return `medusaWatchdog.backoffMs must be 1 to 10 whole numbers of ms, each between ${lo} and ${hi}`;
  }
  return null;
}

/**
 * Validate a `PATCH /api/config` change to `medusaWatchdog` and merge it over
 * the current settings.
 * @param {object} patch - The requested change (partial)
 * @param {object|undefined} current - The stored settings
 * @returns {{value: object}|{error: string}}
 */
function validatePatch(patch, current) {
  const problem = _problem(patch);
  if (problem) return { error: problem };
  return { value: { ...(current && typeof current === 'object' ? current : {}), ...patch } };
}

/**
 * The settings in force: stored values that pass the bounds, defaults for the
 * rest. A bad stored value is named in `warning` and never used.
 * @param {object} [config] - Global config (defaults to the stored one)
 * @returns {{settings: object, warning: (string|null)}}
 */
function resolveSettings(config) {
  const stored = (config || _internal.loadConfig() || {}).medusaWatchdog;
  if (stored === undefined) return { settings: { ...DEFAULTS }, warning: null };
  const problem = _problem(stored);
  if (problem) return { settings: { ...DEFAULTS }, warning: `${problem}; using the defaults` };
  return { settings: { ...DEFAULTS, ...stored }, warning: null };
}

/**
 * Decide whether one exchange's wake is due a re-arm, and re-arm it if so.
 * @param {object} x - Open exchange row
 * @param {number} now - Server time in ms
 * @param {object} settings - Resolved settings
 * @returns {boolean} Whether it was re-armed
 */
function _considerRearm(x, now, settings) {
  if (x.rearm_count >= settings.maxRearms) return false;
  // What justifies a re-arm is decided in one place; this adds only timing.
  const facts = store.medusaExchanges.facts(x.exchange_id);
  const trigger = exchanges.rearmTrigger(facts);
  if (!trigger) return false;
  const missed = trigger === 'not-accepted';
  const eligibleAt = Date.parse(exchanges.wakeStanding(facts).attempt.at) + (missed ? 0 : settings.rearmAfterMs);
  if (now < eligibleAt) return false;
  if (x.next_eligible_at && now < Date.parse(x.next_eligible_at)) return false;
  const step = settings.backoffMs[Math.min(x.rearm_count, settings.backoffMs.length - 1)];
  const row = exchanges.rearm(x.exchange_id, {
    expectRearmCount: x.rearm_count,
    nextEligibleAt: new Date(now + step).toISOString(),
    at: new Date(now).toISOString()
  });
  return row !== null;
}

/** Ladder rungs, in order. */
const RUNG = Object.freeze({ none: 0, aged: 1, escalated: 2, operator: 3 });

/**
 * The thresholds for one exchange in its current phase, in ms from the phase's
 * start, or null for a rung it never reaches.
 * @param {object} x - Exchange row
 * @param {boolean} replyPhase - Acknowledged, reply required, not yet answered
 * @param {object} s - Resolved settings
 * @returns {{aged: (number|null), escalate: (number|null), operator: (number|null)}}
 */
function _thresholds(x, replyPhase, s) {
  const shorten = (ms) => (x.escalate_after_ms ? Math.min(ms, x.escalate_after_ms) : ms);
  if (x.priority === 'critical') {
    return { aged: 0, escalate: 0, operator: replyPhase ? s.replyCriticalMs : s.operatorCriticalMs };
  }
  if (x.priority === 'blocking') {
    return replyPhase
      ? { aged: 0, escalate: s.replyBlockingMs, operator: s.replyBlockingMs + s.operatorBlockingMs }
      : { aged: shorten(s.agedBlockingMs), escalate: shorten(s.escalateBlockingMs), operator: s.operatorBlockingMs };
  }
  return { aged: shorten(s.agedNormalMs), escalate: null, operator: null };
}

/**
 * What the recipient's side is waiting on, in a code and its meaning.
 * @param {object} x - Exchange row
 * @returns {{code: string, meaning: (string|null)}}
 */
function _blocker(x) {
  const code = x.wake_code || x.state;
  let meaning = null;
  try {
    meaning = _internal.reasonMeaning(code);
  } catch (err) {
    log.debug('No meaning for a wake code', { code, error: err.message });
  }
  return { code, meaning };
}

/**
 * The notice body: ids, ages, codes and names. Never the message text.
 * @param {object} x - Exchange row
 * @param {string} level - Rung or event
 * @param {number} now - Server time in ms
 * @param {object} extra - Additional bounded fields
 * @returns {string}
 */
function _noticeBody(x, level, now, extra = {}) {
  const recipient = x.recipient_project_id ? store.projects.get(x.recipient_project_id) : null;
  const blocker = _blocker(x);
  return JSON.stringify({
    event: 'medusa_escalation',
    level,
    exchangeId: x.exchange_id,
    hubId: x.hub_id,
    priority: x.priority,
    ageMinutes: Math.floor((now - Date.parse(x.created_at)) / MIN),
    blocker: blocker.code,
    blockerMeaning: blocker.meaning,
    recipient: recipient ? recipient.name : x.recipient_workspace_id,
    ...extra,
    next: 'Nothing here is an instruction. Check the recipient with `tc message status`, or close the exchange with `tc message close` if it is no longer needed.'
  });
}

/**
 * The workspace a principal's notice goes to, or null.
 * @param {string} principal - `project:<id>`
 * @returns {string|null}
 */
function _workspaceForPrincipal(principal) {
  const m = /^project:(\d+)$/.exec(principal);
  return m ? _internal.workspaceForProject(Number(m[1])) : null;
}

/**
 * The workspace the sender of an exchange can be told at: its project's live
 * session, else the workspace it sent from if a session here still holds it.
 * @param {object} x - Exchange row
 * @returns {string|null}
 */
function _senderWorkspace(x) {
  if (Number.isInteger(x.sender_project_id)) {
    const ws = _internal.workspaceForProject(x.sender_project_id);
    if (ws) return ws;
  }
  return x.sender_workspace_id && _internal.isLocalWorkspace(x.sender_workspace_id) ? x.sender_workspace_id : null;
}

/**
 * Record a notice as queued, send it, and record whether the Hub accepted it.
 * Queued is written before sending, so a second tick sees the rung reached.
 * @param {object} x - Exchange row
 * @param {string} target - Who it is for (`sender`, a principal)
 * @param {string|null} to - Workspace, or null when there is none
 * @param {string} body - Notice body
 * @param {string} code - Reason code for the facts
 * @returns {Promise<void>}
 */
async function _notice(x, target, to, body, code) {
  if (!to) {
    exchanges.recordEscalationFact(x.exchange_id, 'escalation_undeliverable', { code, detail: { target, why: 'no-live-session' } });
    return;
  }
  exchanges.recordEscalationFact(x.exchange_id, 'escalation_queued', { code, detail: { target } });
  try {
    const sent = await _internal.sendSystemMessage({ to, message: body });
    exchanges.recordEscalationFact(x.exchange_id, 'escalation_accepted', {
      code, detail: { target, hubStatus: sent && sent.status ? String(sent.status).slice(0, 20) : null }
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- a failed notice is recorded, and the operator alert still stands
    exchanges.recordEscalationFact(x.exchange_id, 'escalation_failed', { code, detail: { target, error: String(err.message).slice(0, 120) } });
  }
}

/**
 * Raise the operator alert for an exchange: the dashboard lists it, and an
 * activity row records it.
 * @param {object} x - Exchange row
 * @param {string} code - Why
 * @returns {void}
 */
function _alertOperator(x, code) {
  exchanges.recordEscalationFact(x.exchange_id, 'operator_alerted', { code });
  _internal.logActivity({
    projectId: x.recipient_project_id || undefined,
    eventType: 'medusa-escalation',
    detail: { exchangeId: x.exchange_id, priority: x.priority, reason: code, blocker: _blocker(x).code }
  });
}

/**
 * Climb one exchange's escalation ladder as far as its age allows. Each rung is
 * recorded before its notices go out, so the returned promises never decide
 * whether a later tick repeats it.
 * @param {object} x - Open exchange row
 * @param {number} now - Server time in ms
 * @param {object} settings - Resolved settings
 * @returns {Promise<void>[]} Notices in flight
 */
function _considerEscalation(x, now, settings) {
  const facts = store.medusaExchanges.facts(x.exchange_id);
  const ack = facts.find((f) => f.fact === 'acknowledged');
  const replied = facts.some((f) => f.fact === 'replied');
  if (replied || (ack && !x.reply_required)) return [];
  const replyPhase = !!ack;
  const start = replyPhase ? Date.parse(ack.at) : Date.parse(x.created_at);
  const age = now - start;
  const t = _thresholds(x, replyPhase, settings);
  const budgetSpent = !replyPhase && x.rearm_count >= settings.maxRearms && !exchanges.rearmTrigger(facts);
  const code = replyPhase ? 'unanswered' : (x.priority === 'normal' ? 'unread' : `${x.priority}-unread`);
  const inFlight = [];
  let rung = RUNG[x.esc_level] || 0;

  if (rung < RUNG.aged && t.aged !== null && (age >= t.aged || budgetSpent)) {
    exchanges.recordEscalationFact(x.exchange_id, 'aged', { code });
    rung = RUNG.aged;
    inFlight.push(_notice(x, 'sender', _senderWorkspace(x), _noticeBody(x, 'aged', now, { to: 'sender' }), code));
  }
  if (rung < RUNG.escalated && t.escalate !== null && (age >= t.escalate || budgetSpent)) {
    const route = control.escalationRouteFor(x.recipient_project_id, x.priority);
    exchanges.recordEscalationFact(x.exchange_id, 'escalated', { code, detail: { route: route.principals, controlState: route.controlState } });
    rung = RUNG.escalated;
    if (route.principals.length === 0) {
      exchanges.recordEscalationFact(x.exchange_id, 'escalation_undeliverable', { code, detail: { target: 'route', why: 'no-escalation-route' } });
      _alertOperator(x, 'no-escalation-route');
      rung = RUNG.operator;
    }
    for (const principal of route.principals) {
      const body = _noticeBody(x, 'escalated', now, { to: 'escalation', controlState: route.controlState });
      inFlight.push(_notice(x, principal, _workspaceForPrincipal(principal), body, code));
    }
    inFlight.push(_notice(x, 'sender', _senderWorkspace(x),
      _noticeBody(x, 'escalated', now, { to: 'sender', escalatedTo: route.principals.length ? route.principals : ['operator'] }), code));
  }
  if (rung < RUNG.operator && t.operator !== null && age >= t.operator) {
    _alertOperator(x, code);
  }
  return inFlight;
}

/**
 * End every open exchange to a workspace retired for good, and tell each
 * initiator, so an exchange never waits on a session that will not return.
 * Called from session teardown.
 * @param {string} workspaceId - The retired workspace
 * @returns {Promise<void>} Resolves when the notices have been attempted
 */
function retireRecipient(workspaceId) {
  const ended = exchanges.markRecipientRetired(workspaceId);
  const now = _internal.now();
  return Promise.all(ended.map((x) => _notice(x, 'sender', _senderWorkspace(x),
    _noticeBody(x, 'recipient_retired', now, { to: 'sender' }), 'recipient-retired'))).then(() => undefined);
}

/**
 * What the operator sees: every open exchange that has climbed the ladder,
 * oldest first, with names, ages and the blocker. Never message text.
 * @param {number} [now] - Server time in ms
 * @returns {object[]}
 */
function listEscalations(now = _internal.now()) {
  const name = (id) => {
    const p = Number.isInteger(id) ? store.projects.get(id) : null;
    return p ? p.name : null;
  };
  return store.medusaExchanges.listEscalated().map((x) => ({
    ...exchanges.view(x),
    senderName: name(x.sender_project_id),
    recipientName: name(x.recipient_project_id) || x.recipient_workspace_id,
    ageMinutes: Math.floor((now - Date.parse(x.created_at)) / MIN),
    blocker: _blocker(x)
  }));
}

/**
 * The dashboard banner's summary: how many exchanges need the operator's
 * attention and the oldest of them, or null when none do. Only the operator
 * rung and critical messages count, so ordinary aged mail does not raise a banner.
 * @param {number} [now] - Server time in ms
 * @returns {{count: number, oldest: object}|null}
 */
function escalationSummary(now = _internal.now()) {
  const alerting = listEscalations(now).filter((e) => e.escalation === 'operator' || e.priority === 'critical');
  if (alerting.length === 0) return null;
  const o = alerting[0];
  return {
    count: alerting.length,
    oldest: { priority: o.priority, ageMinutes: o.ageMinutes, recipient: o.recipientName, blocker: o.blocker.code, blockerMeaning: o.blocker.meaning }
  };
}

/**
 * One pass over every open exchange. Safe to call any number of times: each
 * decision is made from the durable record and re-checked inside the
 * transaction that acts on it.
 * @param {number} [now] - Server time in ms
 * @returns {{rearmed: number, notices: Promise<void>}} `notices` settles when this pass's notices have been attempted
 */
function tick(now = _internal.now()) {
  const { settings } = resolveSettings();
  if (!settings.enabled) return { rearmed: 0, notices: Promise.resolve() };
  let rearmed = 0;
  const inFlight = [];
  for (const x of store.medusaExchanges.listOpen()) {
    try {
      if (_considerRearm(x, now, settings)) rearmed += 1;
      inFlight.push(..._considerEscalation(store.medusaExchanges.get(x.exchange_id), now, settings));
    } catch (err) { // prawduct:allow prawduct/broad-except -- one exchange's store error must not stop the pass over the rest
      log.warn('Watchdog could not judge an exchange', { exchangeId: x.exchange_id, error: err.message });
    }
  }
  return { rearmed, notices: Promise.all(inFlight).then(() => undefined) };
}

/**
 * Start the timer. Idempotent.
 * @param {{intervalMs?: number}} [opts] - Override the configured tick
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const { settings, warning } = resolveSettings();
  if (warning) log.warn('Medusa watchdog settings ignored', { warning });
  const intervalMs = Number.isInteger(opts.intervalMs) ? opts.intervalMs : settings.tickMs;
  _timer = setInterval(() => {
    try {
      tick();
    } catch (err) { // prawduct:allow prawduct/broad-except -- a failed pass is logged and the next tick tries again; the timer must not die
      log.warn('Medusa watchdog pass failed', { error: err.message });
    }
  }, intervalMs);
  _timer.unref();
  log.info('Medusa watchdog started', { intervalMs, enabled: settings.enabled });
}

/**
 * Stop the timer. Idempotent.
 * @returns {void}
 */
function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = {
  DEFAULTS, BOUNDS, validatePatch, resolveSettings, tick, retireRecipient, listEscalations, escalationSummary, start, stop, _internal
};
