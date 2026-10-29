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
 * Escalation (chunk 04): an open exchange that stays unread, or unanswered
 * after an ack when a reply is required, climbs a one-way ladder: `aged` (the
 * sender is told), `escalated` (the escalation route on the recipient's
 * control assignment is told), `operator` (the dashboard shows it and it is
 * logged). Normal mail skips the `escalated` rung: it is aged, and reaches
 * the operator once for one of the reasons `_normalOperatorReason` names.
 * Each rung is reached once, from server
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
const { createTickMeter } = require('./tick-meter');
const { classifyReason, classifyForSender } = require('./medusa-delivery-disposition');

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
  // Normal mail that is merely waiting on its recipient is the sender's to
  // wait out, but not for ever (#2086): past this, the operator is alerted
  // once. Never sooner than the aged rung, whatever the two are set to.
  operatorNormalMs: 60 * MIN,
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
  operatorNormalMs: [5 * MIN, 48 * 60 * MIN],
  agedBlockingMs: [MIN, 24 * 60 * MIN],
  escalateBlockingMs: [2 * MIN, 24 * 60 * MIN],
  operatorBlockingMs: [5 * MIN, 48 * 60 * MIN],
  operatorCriticalMs: [MIN, 24 * 60 * MIN],
  replyBlockingMs: [5 * MIN, 24 * 60 * MIN],
  replyCriticalMs: [MIN, 24 * 60 * MIN]
});

/** Numeric settings validated against BOUNDS as whole numbers. */
const NUMERIC_KEYS = Object.freeze(['tickMs', 'rearmAfterMs', 'maxRearms', 'agedNormalMs', 'operatorNormalMs', 'agedBlockingMs',
  'escalateBlockingMs', 'operatorBlockingMs', 'operatorCriticalMs', 'replyBlockingMs', 'replyCriticalMs']);

/** Seams for tests. */
const _internal = {
  /** @returns {number} Server time in ms. */
  now: () => Date.now(),
  /** @returns {number} Monotonic ms for the pass meter; separate from `now`, which tests pin. */
  clock: () => require('node:perf_hooks').performance.now(),
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
   * Ask the wake monitor to look at a recipient workspace's local session
   * sooner than its next timer tick (#2716), right after this module re-armed
   * something for it. No-op for a workspace with no live local session.
   * @param {string} workspaceId - Workspace id
   * @param {string} reason - Why, for the wake monitor's own log
   * @returns {boolean} Whether a scan was actually requested
   */
  requestWakeScan: (workspaceId, reason) => {
    const wake = require('./medusa-wake');
    const local = wake.localParticipant(workspaceId);
    return local ? wake.requestScan(local.sessionKey, reason) : false;
  },
  /**
   * The operator-facing meaning of a wake reason code.
   * @param {string} code - Reason code
   * @returns {string|null}
   */
  reasonMeaning: (code) => require('./medusa-wake').peerReasonMeaning(code),
  /**
   * Whether the wake monitor is running. A notice must not promise a retry
   * from a monitor that is stopped.
   * @returns {boolean}
   */
  monitorRunning: () => require('./medusa-wake').isRunning(),
  /**
   * How long `engine-thread-unknown` must hold before it is a stall. The wake
   * monitor's own interval, so the two alerts mean the same thing.
   * @returns {number} Milliseconds
   */
  stallMs: () => require('./medusa-wake').WAKE_STALL_ALERT_MS,
  /**
   * Write an operator-visible activity row, or throw. It runs inside the
   * transaction that records the alert, so a row that cannot be written must
   * throw to take the fact back with it: `store.activity.log` never throws.
   * @param {object} event - `store.activity.logOrThrow` event
   * @returns {void}
   * @throws {Error} When the row could not be written
   */
  logActivity: (event) => store.activity.logOrThrow(event)
};

let _timer = null;

// What each pass cost (#2086). It observes the pass and decides nothing.
const _meter = createTickMeter({ clock: () => _internal.clock() });

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

/**
 * Re-arm every open exchange addressed to one recipient workspace that is
 * durably eligible right now, without waiting for the next periodic tick
 * (#2716) — called right after a `wake_not_accepted` receipt, so the first
 * miss re-arms at once instead of waiting up to `tickMs` (30s). Same
 * eligibility rule as `tick`'s own loop (`_considerRearm`), over this one
 * workspace's exchanges instead of every open one, so a re-arm still respects
 * `maxRearms` and `next_eligible_at` backoff on subsequent misses — this
 * never re-arms anything `tick` itself would have refused.
 *
 * Requests an immediate wake scan for the workspace's local session, but only
 * when something was actually re-armed: a call that re-arms nothing has
 * nothing new for the wake monitor to look at sooner.
 * @param {string} workspaceId - The recipient workspace to consider
 * @param {number} [now] - Server time in ms
 * @returns {number} How many exchanges were re-armed
 */
function rearmWorkspace(workspaceId, now = _internal.now()) {
  if (!workspaceId) return 0;
  const { settings } = resolveSettings();
  if (!settings.enabled) return 0;
  let rearmed = 0;
  for (const x of store.medusaExchanges.listOpenForRecipient(workspaceId)) {
    try {
      if (_considerRearm(x, now, settings)) rearmed += 1;
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- one exchange's store error must not stop re-arming the rest, or stop this from running at all
      log.warn('Watchdog could not judge an exchange for an immediate re-arm', { exchangeId: x.exchange_id, workspaceId, error: err.message });
    }
  }
  if (rearmed > 0) {
    try {
      _internal.requestWakeScan(workspaceId, 'wake-rearmed');
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- the re-arm itself already landed; a scan request that fails just leaves the next timer tick to find it, same as before #2716
      log.warn('Could not request an immediate wake scan after an immediate re-arm', { workspaceId, error: err.message });
    }
  }
  return rearmed;
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
    // Acknowledged but unanswered: nothing happens until replyBlockingMs after
    // the ack, when the sender and the route are told together.
    return replyPhase
      ? { aged: s.replyBlockingMs, escalate: s.replyBlockingMs, operator: s.replyBlockingMs + s.operatorBlockingMs }
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
 * The wake reason an exchange's state stands for, for classification (#2086).
 *
 * `wake_code` is a wake reason only while the exchange is blocked or pending,
 * and even then the exchange record writes codes of its own there, so it is
 * translated by the record's one mapping and never classified raw. After an
 * attempt `wake_code` holds the transport. So: a blocked or pending wake is
 * the reason its code stands for; a message that was nudged, read or
 * acknowledged is `nudged`, since no wake is being held; and anything the
 * monitor has not assessed yet is `not-observed`.
 *
 * A nudge that was proven NOT accepted is not a nudge. It waits on a re-arm,
 * which is `not-observed`, and that is a promise of a retry only while a
 * re-arm can still happen: see `_disposition`.
 * @param {object} x - Exchange row
 * @returns {string} A reason code from the wake monitor's vocabulary
 */
function _wakeReason(x) {
  if (x.state === 'wake_blocked' || x.state === 'wake_pending') return exchanges.wakeReasonForCode(x.wake_code);
  if (['wake_attempted', 'wake_accepted', 'read', 'acknowledged'].includes(x.state)) return 'nudged';
  return 'not-observed';
}

/**
 * Whether an exchange is waiting to be read or waiting to be answered. Kept
 * apart from the wake class on purpose: an acknowledged message that still
 * owes a reply holds no wake (its class is `none`) and is plainly unanswered.
 * @param {object} x - Exchange row
 * @returns {'unread'|'unanswered'}
 */
function _condition(x) {
  if (!x.reply_required) return 'unread';
  const facts = store.medusaExchanges.facts(x.exchange_id);
  return facts.some((f) => f.fact === 'acknowledged') && !facts.some((f) => f.fact === 'replied') ? 'unanswered' : 'unread';
}

/**
 * Whether waiting will fix what an exchange is held by, from the one
 * classifier the sender-facing answer and the undelivered list use.
 *
 * A retry is promised only where something will retry. With the wake monitor
 * stopped nothing does, and a nudge that was not accepted is retried only by a
 * re-arm, whose budget is finite. Either way an otherwise `actionable` hold
 * becomes one someone has to look at. That override is for held wakes only: a
 * message that was nudged, read or acknowledged holds no wake, so its class
 * stays `none` whatever the monitor is doing, and a `configuration` hold
 * stays what it is.
 * @param {object} x - Exchange row
 * @param {object} settings - The pass's resolved settings
 * @returns {{reason: string, class: string, nextAction: string, nextActionMeaning: string}}
 */
function _disposition(x, settings) {
  const reason = _wakeReason(x);
  let c = classifyReason(reason);
  if (c.class === 'actionable') {
    let monitorRunning = false;
    try {
      monitorRunning = _internal.monitorRunning() === true;
    } catch (err) {
      log.debug('Could not tell whether the wake monitor is running', { error: err.message });
    }
    const exhausted = x.state === 'wake_not_accepted' && x.rearm_count >= settings.maxRearms;
    c = classifyForSender(reason, { monitorRunning: monitorRunning && !exhausted });
  }
  return { reason, class: c.class, nextAction: c.nextAction, nextActionMeaning: c.nextActionMeaning };
}

/**
 * The notice body: ids, ages, codes and names. Never the message text.
 * @param {object} x - Exchange row
 * @param {string} level - Rung or event
 * @param {number} now - Server time in ms
 * @param {object} extra - Additional bounded fields
 * @param {object} settings - The pass's resolved settings
 * @returns {string}
 */
function _noticeBody(x, level, now, extra, settings) {
  const recipient = x.recipient_project_id ? store.projects.get(x.recipient_project_id) : null;
  const blocker = _blocker(x);
  const disposition = _disposition(x, settings);
  return JSON.stringify({
    event: 'medusa_escalation',
    level,
    exchangeId: x.exchange_id,
    hubId: x.hub_id,
    priority: x.priority,
    ageMinutes: Math.floor((now - Date.parse(x.created_at)) / MIN),
    blocker: blocker.code,
    blockerMeaning: blocker.meaning,
    // Unread, or acknowledged and still owed a reply.
    condition: _condition(x),
    // Whether waiting will fix it (#2086).
    class: disposition.class,
    nextAction: disposition.nextAction,
    nextActionMeaning: disposition.nextActionMeaning,
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
    log.warn('Medusa escalation notice undeliverable: no live session', { exchangeId: x.exchange_id, target, code });
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
    log.warn('Medusa escalation notice failed', { exchangeId: x.exchange_id, target, code, error: err.message });
  }
}

/**
 * The project an exchange's activity row is filed under: its recipient, when
 * that project still exists. The row references the project, and it is written
 * with a write that throws, so a recipient project that is gone would refuse
 * the row on every pass and the alert would never be raised. The row names the
 * exchange either way.
 * @param {object} x - Exchange row
 * @returns {number|undefined}
 */
function _activityProjectId(x) {
  return Number.isInteger(x.recipient_project_id) && store.projects.get(x.recipient_project_id) ? x.recipient_project_id : undefined;
}

/**
 * Raise the operator alert for an exchange: the dashboard lists it, and an
 * activity row records it.
 *
 * Once per exchange, and the two together. The `operator_alerted` fact is
 * once-only, and the activity row is written inside the transaction that
 * records it, only by the call that did. A second pass, a concurrent pass and
 * a restart write neither, and a pass that cannot write the row records no
 * fact, so the next one tries again. The row is written with the store's
 * throwing write for that reason: the ordinary one swallows its failures.
 *
 * The fact keeps what was true when the alert was raised: the blocker, the
 * condition, its class and next action, and why the operator was told. A later change of
 * class neither repeats the alert nor rewrites this.
 *
 * @param {object} x - Exchange row
 * @param {string} code - Why the operator is told
 * @param {object} settings - The pass's resolved settings
 * @returns {boolean} Whether this call raised the alert
 */
function _alertOperator(x, code, settings) {
  const blocker = _blocker(x).code;
  const disposition = _disposition(x, settings);
  const condition = _condition(x);
  const snapshot = {
    blocker, condition, class: disposition.class,
    nextAction: disposition.nextAction, nextActionMeaning: disposition.nextActionMeaning, why: code
  };
  return exchanges.recordEscalationFactOnce(x.exchange_id, 'operator_alerted', {
    code,
    detail: snapshot,
    onRecorded: () => _internal.logActivity({
      projectId: _activityProjectId(x),
      eventType: 'medusa-escalation',
      detail: { exchangeId: x.exchange_id, priority: x.priority, reason: code, blocker, condition, class: disposition.class, nextAction: disposition.nextAction }
    })
  }).recorded;
}

/**
 * Whether `engine-thread-unknown` has held, without a break, for the stall
 * interval. Read from the durable record: an unchanged verdict is not recorded
 * again, so the newest wake fact is when the current one began, and any
 * attempt or other verdict since restarts the count.
 * @param {object} x - Exchange row
 * @param {number} now - Server time in ms
 * @returns {boolean}
 */
function _engineThreadStalled(x, now) {
  const facts = store.medusaExchanges.facts(x.exchange_id);
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (!f.fact.startsWith('wake_')) continue;
    // The caller has established that the standing reason is `engine-thread-unknown`,
    // so the newest wake fact is the block that carries it.
    return f.fact === 'wake_blocked' && now - Date.parse(f.at) >= _internal.stallMs();
  }
  return false;
}

/**
 * Why the operator should be told about a NORMAL message that has aged, or
 * null when it is still the sender's to wait out (#2086).
 *
 * Blocking and critical mail reach the operator by their own rungs. Normal
 * mail used to stop at the sender, which left the two cases only an operator
 * can resolve silent for ever. Read afresh on every pass after the aged rung,
 * until the alert is recorded, so a hold that becomes one of these later is
 * still told once:
 *
 *   - `configuration-hold`: nothing changes until someone acts.
 *   - `engine-thread-unknown-stalled`: the engine's own channel has not said
 *     the session is idle for the stall interval, unbroken. A recipient whose
 *     verdict only just became this is not stalled yet. The monitor still
 *     retries and the class stays `actionable`; this is the one retrying
 *     state told before `operatorNormalMs`.
 *   - `prolonged-unanswered`: acknowledged, a reply is owed, and none has come
 *     for `operatorNormalMs` since the acknowledgement.
 *   - `prolonged-actionable` / `prolonged-unread`: the recipient is merely
 *     busy, or was nudged and has not read, and has been for
 *     `operatorNormalMs`.
 *
 * @param {object} x - Exchange row, already at the aged rung
 * @param {number} age - Milliseconds since the phase started
 * @param {number} now - Server time in ms
 * @param {object} settings - Resolved settings
 * @returns {string|null} The escalation reason
 */
function _normalOperatorReason(x, age, now, settings) {
  const disposition = _disposition(x, settings);
  if (disposition.class === 'configuration') return 'configuration-hold';
  if (disposition.reason === 'engine-thread-unknown' && _engineThreadStalled(x, now)) return 'engine-thread-unknown-stalled';
  if (age >= Math.max(settings.agedNormalMs, settings.operatorNormalMs)) {
    if (_condition(x) === 'unanswered') return 'prolonged-unanswered';
    return disposition.class === 'actionable' ? 'prolonged-actionable' : 'prolonged-unread';
  }
  return null;
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
  // A send a TangleClaw component has declared its own never climbs. That
  // component decides what happens when it goes unread or unanswered and ends
  // it itself; nobody is waiting on the sender, the route or the operator.
  // It is still re-armed and still ended when its recipient retires: only the
  // ladder is skipped. Today that is the operator bridge's send to a project,
  // whose route has its own one status notice (ADR 0023 Decision 17).
  // Normal priority only. A blocking or critical message says somebody
  // cannot continue, and that is escalated whoever sent it.
  if (x.priority === 'normal' && exchanges.systemOwnerOf(x)) return [];
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
    inFlight.push(_notice(x, 'sender', _senderWorkspace(x), _noticeBody(x, 'aged', now, { to: 'sender' }, settings), code));
  }
  if (rung < RUNG.escalated && t.escalate !== null && (age >= t.escalate || budgetSpent)) {
    const route = control.escalationRouteFor(x.recipient_project_id, x.priority);
    exchanges.recordEscalationFact(x.exchange_id, 'escalated', { code, detail: { route: route.principals, controlState: route.controlState } });
    rung = RUNG.escalated;
    if (route.principals.length === 0) {
      exchanges.recordEscalationFact(x.exchange_id, 'escalation_undeliverable', { code, detail: { target: 'route', why: 'no-escalation-route' } });
      _alertOperator(x, 'no-escalation-route', settings);
      rung = RUNG.operator;
    }
    for (const principal of route.principals) {
      const body = _noticeBody(x, 'escalated', now, { to: 'escalation', controlState: route.controlState, controlGeneration: route.stateGeneration }, settings);
      inFlight.push(_notice(x, principal, _workspaceForPrincipal(principal), body, code));
    }
    inFlight.push(_notice(x, 'sender', _senderWorkspace(x),
      _noticeBody(x, 'escalated', now, { to: 'sender', escalatedTo: route.principals.length ? route.principals : ['operator'] }, settings), code));
  }
  if (rung < RUNG.operator && t.operator !== null && age >= t.operator) {
    _alertOperator(x, code, settings);
    rung = RUNG.operator;
  }
  // Normal mail has no operator threshold of its own (`t.operator` is null).
  // Once aged, it reaches the operator for one of the reasons above, once.
  if (x.priority === 'normal' && rung >= RUNG.aged && rung < RUNG.operator) {
    // Re-read: this pass may have just aged or re-armed it.
    const current = store.medusaExchanges.get(x.exchange_id);
    const why = _normalOperatorReason(current, age, now, settings);
    if (why) _alertOperator(current, why, settings);
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
  const { settings } = resolveSettings();
  return Promise.all(ended.map((x) => _notice(x, 'sender', _senderWorkspace(x),
    _noticeBody(x, 'recipient_retired', now, { to: 'sender' }, settings), 'recipient-retired'))).then(() => undefined);
}

/**
 * The first-escalation delay per priority a sender's `escalateAfterMinutes`
 * may shorten, from the settings in force: the one place the send-time bound
 * and the ladder agree on.
 * @returns {{normal: number, blocking: number, critical: number}}
 */
function sendThresholds() {
  const { settings } = resolveSettings();
  return { normal: settings.agedNormalMs, blocking: settings.escalateBlockingMs, critical: 0 };
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
    blocker: _blocker(x),
    // Unread, or acknowledged and still owed a reply.
    condition: _condition(x)
  }));
}

/**
 * The dashboard banner's summary: how many exchanges need the operator's
 * attention and the oldest of them, or null when none do. Only the operator
 * rung and critical messages count: normal mail that is only aged raises no
 * banner until it reaches the operator rung.
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
 * @param {object} [opts]
 * @param {boolean} [opts.scheduled=false] - Whether the timer fired this pass
 * @returns {{rearmed: number, notices: Promise<void>}} `notices` settles when this pass's notices have been attempted
 */
function tick(now = _internal.now(), opts = {}) {
  const { settings } = resolveSettings();
  if (!settings.enabled) return { rearmed: 0, notices: Promise.resolve() };
  const pass = _meter.begin({ scheduled: opts.scheduled === true });
  let rearmed = 0;
  const inFlight = [];
  try {
    for (const x of store.medusaExchanges.listOpen()) {
      try {
        pass.item(x.exchange_id, () => {
          if (_considerRearm(x, now, settings)) {
            rearmed += 1;
            // #2716 -- the periodic tick re-arms too, and a re-arm here
            // deserves the same immediate look as `rearmWorkspace`'s: the
            // next watchdog tick is up to `tickMs` away, but the wake
            // monitor's own timer may be sooner than that only by luck.
            try {
              _internal.requestWakeScan(x.recipient_workspace_id, 'wake-rearmed');
            } catch (err) {
              // prawduct:allow prawduct/broad-except -- the re-arm itself already landed; a scan request that fails just leaves the wake monitor's own timer to find it
              log.warn('Could not request an immediate wake scan after a periodic re-arm', { exchangeId: x.exchange_id, error: err.message });
            }
          }
          inFlight.push(..._considerEscalation(store.medusaExchanges.get(x.exchange_id), now, settings));
        });
      } catch (err) { // prawduct:allow prawduct/broad-except -- one exchange's store error must not stop the pass over the rest
        log.warn('Watchdog could not judge an exchange', { exchangeId: x.exchange_id, error: err.message });
      }
    }
  } finally {
    pass.end();
  }
  return { rearmed, notices: Promise.all(inFlight).then(() => undefined) };
}

/**
 * What the watchdog's recent passes cost (#2086): duration and start-lag
 * percentiles, overruns, and the open exchanges the last pass judged, in
 * order. Read-only and in memory.
 * @returns {object} A `lib/tick-meter.js` snapshot
 */
function tickMetrics() {
  return _meter.snapshot();
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
  _meter.schedule(intervalMs);
  _timer = setInterval(() => {
    try {
      tick(_internal.now(), { scheduled: true }).notices.catch((err) => log.warn('Medusa watchdog notices failed', { error: err.message }));
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
  _meter.unschedule();
}

module.exports = {
  DEFAULTS, BOUNDS, validatePatch, resolveSettings, sendThresholds, tick, tickMetrics, retireRecipient, listEscalations, escalationSummary,
  rearmWorkspace, start, stop, _internal
};
