'use strict';

/**
 * Server notifications for the operator channel (#1799).
 *
 * TangleClaw tells the operator, through the channel's helper, when it needs
 * attention. A notification is an outbound item like a project's reply: it is
 * kept durably, listed by `GET /api/operator-channel/outbound` with its `kind`
 * and `type`, and settled only when the helper acknowledges it with the id the
 * chat gave the post. No route is added and the channel token is not widened.
 *
 * The schema is closed: a type from a fixed vocabulary, a
 * stable idempotency key, the project it concerns (or none), a timestamp, and
 * text rendered here from a fixed template that takes only a project name and
 * a count. Nothing an agent or a chat wrote can reach a notification.
 *
 * Three events have a source today and are emitted. Two are reserved and
 * refused until their triggers are defined.
 *
 * Emitting never throws into its caller: a notification is a courtesy to the
 * operator, and the watchdog tick or workload write that noticed the event must
 * not fail because the channel could not record it. Notifications are recorded
 * only while the channel is enabled, so turning it on does not deliver a backlog
 * of stale alerts.
 *
 * @module lib/operator-channel-notify
 */

const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('operator-channel-notify');

/** The events emitted today, each with the one place that detects it. */
const EMITTED = Object.freeze({
  'operator-needed': 'lib/medusa-watchdog.js _alertOperator: an exchange reached the operator rung',
  'work-blocked': 'lib/workload.js record: a lane\'s receipt entered `blocked`',
  'fleet-idle': 'evaluateFleetIdle, on the channel pump: every live lane became idle'
});

/** Reserved names with no trigger yet. Refused, never emitted. */
const DEFERRED = Object.freeze(['release-action-needed', 'certification-state-changed']);

/** The state key for the current fleet-idle episode's start. */
const FLEET_IDLE_EPISODE = 'fleet-idle-episode';

/**
 * The state key for an idle spell whose notice is not yet recorded: its start,
 * which is also its notice's key. Kept until the episode opens, so a retry
 * after a refusal or a crash uses the same key and cannot notify twice.
 */
const FLEET_IDLE_PENDING = 'fleet-idle-pending';

/** Lane availabilities that count as idle for `fleet-idle`. */
const IDLE = Object.freeze(new Set(['AVAILABLE', 'COMPLETE_NOT_CLEAR']));

/**
 * Fixed templates. Each takes only values this module resolved itself.
 * @type {Readonly<Record<string, function(object): string>>}
 */
const TEMPLATES = Object.freeze({
  'operator-needed': ({ project }) => `TangleClaw: a message to ${project || 'a project'} has gone unanswered long enough to need you.`,
  'work-blocked': ({ project }) => `TangleClaw: ${project || 'a project'} reports its work is blocked.`,
  'fleet-idle': ({ lanes }) => `TangleClaw: every live session is idle (${lanes} lane${lanes === 1 ? '' : 's'}). The fleet is waiting for work.`
});

/**
 * Injectable seams: the clock, the enabled check, and the fleet's lanes. The
 * lanes come from the server, which owns the activity observer a lane's
 * availability needs; without a source, the fleet is never judged idle.
 */
const _internal = {
  now: () => new Date(),
  // Required lazily: the channel module requires this one at load time.
  enabled: () => require('./operator-channel').settings().enabled,
  isSafe: (text) => require('./operator-channel').isSafeChannelText(text),
  fleetAvailabilities: null
};

/**
 * Let the server supply the fleet's lane availabilities.
 * @param {function(): string[]} fn - Returns one availability per live session
 * @returns {void}
 */
function setFleetSource(fn) {
  _internal.fleetAvailabilities = typeof fn === 'function' ? fn : null;
}

/**
 * A project's name for a template, or null.
 * @param {number|null|undefined} projectId - Project id
 * @returns {string|null}
 */
function _projectName(projectId) {
  if (!Number.isInteger(projectId)) return null;
  const p = store.projects.get(projectId);
  return p ? p.name : null;
}

/**
 * Record one notification.
 * @param {string} type - A key of EMITTED
 * @param {{key: string, projectId?: (number|null), values?: Object<string, number>}} n - Its key, scope, and
 *   integer template values (any other value is dropped)
 * @returns {{emitted: boolean, reason?: string, id?: number}}
 */
function emit(type, n) {
  try {
    if (DEFERRED.includes(type)) return { emitted: false, reason: 'deferred-type' };
    if (!Object.prototype.hasOwnProperty.call(EMITTED, type)) return { emitted: false, reason: 'unknown-type' };
    if (!n || typeof n.key !== 'string' || !n.key || n.key.length > 100) return { emitted: false, reason: 'bad-key' };
    if (!_internal.enabled()) return { emitted: false, reason: 'channel-disabled' };
    const projectId = Number.isInteger(n.projectId) ? n.projectId : null;
    // Only numbers from the caller (a lane count); the project name always comes
    // from the store, last, so no caller value can stand in for it.
    const numbers = {};
    for (const [k, v] of Object.entries(n.values || {})) if (Number.isInteger(v)) numbers[k] = v;
    let text = TEMPLATES[type]({ ...numbers, project: _projectName(projectId) });
    // A project name is operator-chosen, but it still passes the channel's own
    // display-safety rule before it reaches a chat. A name that fails it is
    // left out ("a project") rather than dropping the notice, so the operator
    // is still told, and the substitution is logged.
    if (!_internal.isSafe(text)) {
      log.warn('An operator channel notification left out a project name that is not display-safe', { type, projectId });
      text = TEMPLATES[type]({ ...numbers, project: null });
      if (!_internal.isSafe(text)) return { emitted: false, reason: 'unsafe-text' };
    }
    const { row, inserted } = store.operatorChannel.insertNotification({
      type, key: n.key, projectId, text, at: _internal.now().toISOString()
    });
    if (inserted) log.info('Operator channel notification recorded', { type, id: row.id });
    return { emitted: inserted, reason: inserted ? undefined : 'duplicate', id: row ? row.id : undefined };
  } catch (err) { // prawduct:allow prawduct/broad-except -- a notification must never fail the watchdog tick or workload write that raised it
    log.warn('Operator channel notification could not be recorded', { type, error: err.message });
    return { emitted: false, reason: 'error' };
  }
}

/**
 * `operator-needed`: an exchange reached the operator rung. Called once per
 * exchange by the watchdog, and keyed by the exchange so a repeat is a no-op.
 * @param {{exchange_id: string, recipient_project_id: (number|null)}} exchange - The exchange row
 * @returns {object} What emit answered
 */
function onOperatorAlerted(exchange) {
  return emit('operator-needed', { key: `operator-needed:${exchange.exchange_id}`, projectId: exchange.recipient_project_id });
}

/**
 * `work-blocked`: a receipt entered `blocked`. A lane re-reporting `blocked`
 * is not a new event, so only a receipt whose predecessor in the same launch
 * was not blocked (or that has none) emits.
 * @param {{receipt_id: number, launch_id: string, seq: number, state: string, project_id: number}} receipt - The new receipt row
 * @returns {object|null} What emit answered, or null when this is not an entry into `blocked`
 */
function onReceipt(receipt) {
  try {
    if (!receipt || receipt.state !== 'blocked') return null;
    const prev = store.workloadReceipts.previousForLaunch(receipt.launch_id, receipt.seq);
    if (prev && prev.state === 'blocked') return null;
  } catch (err) { // prawduct:allow prawduct/broad-except -- the workload write already succeeded; a lookup failure must not turn it into an error
    log.warn('Could not judge a workload receipt for a notification', { error: err.message });
    return null;
  }
  return emit('work-blocked', { key: `work-blocked:${receipt.receipt_id}`, projectId: receipt.project_id });
}

/**
 * `fleet-idle`: judged on the channel pump, which calls this whether or not
 * the channel is on. Emits once when the fleet ENTERS idle (at least one live
 * lane, every lane idle), keyed by the episode's start.
 *
 * The spell's start is persisted first as the pending key, and the episode is
 * opened only once its notification is recorded under that key. A refusal or a
 * failure therefore leaves the episode closed and the next pass retries under
 * the same key, and a crash between recording and opening is answered as a
 * duplicate, so the operator is told once, never twice and never not at all.
 * Both close whenever any lane is not idle or no lane is live, whether or not
 * the channel is on, so an idle spell that began and ended while the channel
 * was off cannot hide the next one.
 * @returns {{idle: boolean, emitted: boolean}}
 */
function evaluateFleetIdle() {
  try {
    if (!_internal.fleetAvailabilities) return { idle: false, emitted: false };
    const lanes = _internal.fleetAvailabilities();
    const idle = Array.isArray(lanes) && lanes.length > 0 && lanes.every((a) => IDLE.has(a));
    const episode = store.operatorChannel.getNotifyState(FLEET_IDLE_EPISODE);
    const pending = store.operatorChannel.getNotifyState(FLEET_IDLE_PENDING);
    const at = _internal.now().toISOString();
    if (!idle) {
      if (episode) store.operatorChannel.setNotifyState(FLEET_IDLE_EPISODE, null, at);
      if (pending) store.operatorChannel.setNotifyState(FLEET_IDLE_PENDING, null, at);
      return { idle: false, emitted: false };
    }
    if (episode) return { idle: true, emitted: false };
    const start = pending || at;
    if (!pending) store.operatorChannel.setNotifyState(FLEET_IDLE_PENDING, start, at);
    const out = emit('fleet-idle', { key: `fleet-idle:${start}`, projectId: null, values: { lanes: lanes.length } });
    // `duplicate`: this spell's notice was recorded before a crash stopped the
    // episode opening. Either way it is recorded now, so the episode opens.
    if (out.emitted || out.reason === 'duplicate') {
      store.operatorChannel.setNotifyState(FLEET_IDLE_EPISODE, start, at);
      store.operatorChannel.setNotifyState(FLEET_IDLE_PENDING, null, at);
    }
    return { idle: true, emitted: out.emitted };
  } catch (err) { // prawduct:allow prawduct/broad-except -- one evaluation failing must not stop the channel pump
    log.warn('Fleet-idle evaluation failed', { error: err.message });
    return { idle: false, emitted: false };
  }
}

module.exports = {
  EMITTED,
  DEFERRED,
  TEMPLATES,
  FLEET_IDLE_EPISODE,
  FLEET_IDLE_PENDING,
  emit,
  onOperatorAlerted,
  onReceipt,
  evaluateFleetIdle,
  setFleetSource,
  _internal
};
