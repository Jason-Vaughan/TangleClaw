'use strict';

/**
 * Explicit operator wake: re-nudging selected launches after their recovery
 * has been cleared, so a session waiting at its launch gate is told it can
 * continue (#2250, Architect Ruling A2250).
 *
 * This is its own write, apart from a recovery clear. A clear
 * (`lib/launch-recovery-batch.js`) never types into a pane; this never
 * clears a launch's recovery. The operator names the launches, by the exact
 * binding a fleet read gave them — there is no wildcard, the same contract
 * as a batch clear.
 *
 * For each named launch, this re-checks it is still the launch named, still
 * past its recovery gate, not already attested READY, and its session still
 * active with a live pane — then runs the SAME typed-send safeguards the
 * automatic unready nudge uses (`lib/launch-pane-writer.js`, shared with
 * `lib/launch-unready.js`): a busy or unprofiled pane fails closed, nothing
 * typed. Unlike the automatic nudge, this is a one-shot check
 * (`ticksRequired: 1`) — an operator who just asked for this launch by name
 * does not wait out a multi-tick idle streak first.
 *
 * It reports three things separately for every item and never merges them: a
 * send was attempted and (if so) whether it was actually typed; what the
 * launch's own step cursor says now; what its READY attestation says now. A
 * sent nudge is not proof it was received, read, or acted on.
 *
 * @module lib/launch-recovery-wake
 */

const store = require('./store');
const paneWriter = require('./launch-pane-writer');
const launchUnready = require('./launch-unready');
const medusaWake = require('./medusa-wake');
const { PART_STATES, REASON_CODES } = require('./launch-recovery-held');
const { createLogger } = require('./logger');

const log = createLogger('launch-recovery-wake');

/** The most launches one request may name. */
const MAX_ITEMS = 100;

const ITEM_KEYS = Object.freeze(['projectId', 'sessionId', 'sequenceId', 'recoveryRevision']);

/**
 * What happened to one item's send attempt.
 * @enum {string}
 */
const SEND_OUTCOMES = Object.freeze({
  SENT: 'sent',
  ALREADY_WOKEN: 'already-woken',
  STILL_BLOCKED: 'still-blocked',
  STALE: 'stale',
  ALREADY_READY: 'already-ready',
  NOT_FOUND: 'not-found',
  ARCHIVED: 'archived',
  SESSION_ENDED: 'session-ended',
  NATIVE_STARTUP: 'native-startup',
  NO_PANE: 'no-pane',
  UNPROFILED_ENGINE: 'unprofiled-engine',
  PANE_CAPTURE_FAILED: 'pane-capture-failed',
  PANE_BUSY: 'pane-busy',
  CONTROL_HELD: 'control-held',
  INJECT_FAILED: 'inject-failed',
  FAILED: 'failed'
});

/**
 * A2250: `send.attempted` means the typed-send (`paneWriter.injectLine`) was
 * actually invoked, not merely that the item got past every earlier gate.
 * `_attemptWake` returns it explicitly on every path — `attempted: false`
 * from every pre-send gate (`_pending`), `attempted: true` from every path
 * reached after `injectLine` is called, even when something throws right at
 * or after that call — rather than deriving it afterward from the outcome
 * alone, which is what let a thrown bookkeeping error downstream rewrite a
 * completed send back to "not attempted."
 */

/**
 * How many pane lines the busy-pane check reads, matching the unready
 * monitor's own tail length so the same profile's prompt/busy markers apply.
 */
const TMUX_TAIL_LINES = 50;

/**
 * Which (sequenceId, recoveryRevision) pairs this process has already sent a
 * wake for — the per-launch post-clear wake cap (one successful wake per
 * revision, A2250). In-memory and process-lifetime only, not durable: a
 * restart forgets it, which just means the cap starts over, never that a
 * launch is wrongly refused a wake it already got.
 *
 * Bounded by true LRU eviction, not a wholesale clear:
 * `_launchBlockerWarned`'s "clear outright once full" is safe for a
 * warn-once cache (re-warning is harmless), but wrong here, where clearing
 * every entry would let EVERY pair the cap had ever recorded be woken a
 * second time at once, not just the oldest. A `Map` preserves insertion
 * order, so once full only the single oldest pair is evicted per new entry
 * — the one least likely to be asked about again — keeping the one-wake
 * guarantee intact for every pair added more recently than the cap's depth.
 */
const WOKEN_CAP = 1000;
const _wokenAtRevision = new Map();

/**
 * The cap key for one (sequenceId, recoveryRevision) pair.
 * @param {number} sequenceId
 * @param {number} recoveryRevision
 * @returns {string}
 */
function _wokenKey(sequenceId, recoveryRevision) {
  return `${sequenceId}:${recoveryRevision}`;
}

/**
 * Read a wake-batch request's body into its items, or say why it is refused.
 *
 * The whole request is refused when any part of it is wrong — a batch with
 * one malformed item must not wake the items around it. Same shape as
 * `lib/launch-recovery-batch.js#parseRequest`.
 * @param {*} body - The parsed JSON body
 * @returns {{ok: true, items: object[]}|{ok: false, code: string, message: string}}
 */
function parseRequest(body) {
  const refuse = (code, message) => ({ ok: false, code, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refuse('BAD_REQUEST', 'The body must be an object with an "items" list naming the launches to wake.');
  }
  const extra = Object.keys(body).filter((key) => key !== 'items');
  if (extra.length) {
    return refuse('BAD_REQUEST',
      `The body may carry only "items". A wake names each launch it sends to, and "${extra[0]}" is not understood.`);
  }
  const { items } = body;
  if (!Array.isArray(items) || items.length === 0) {
    return refuse('BAD_REQUEST', '"items" must be a list of at least one launch to wake.');
  }
  if (items.length > MAX_ITEMS) {
    return refuse('TOO_MANY_ITEMS',
      `A wake sends to at most ${MAX_ITEMS} launches and this one names ${items.length}. Send them in smaller batches.`);
  }
  const parsed = [];
  const seenSequences = new Set();
  const seenSessions = new Set();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return refuse('BAD_REQUEST', `Item ${index} must be an object naming one launch.`);
    }
    const unknown = Object.keys(item).filter((key) => !ITEM_KEYS.includes(key));
    if (unknown.length) {
      return refuse('BAD_REQUEST', `Item ${index} carries "${unknown[0]}", which is not understood.`);
    }
    for (const key of ITEM_KEYS) {
      if (!Number.isSafeInteger(item[key]) || item[key] < 1) {
        return refuse('BAD_REQUEST',
          `Item ${index} needs ${ITEM_KEYS.join(', ')} as whole numbers, naming the launch as it was read.`);
      }
    }
    // A session has one launch, so two items naming one session or one launch
    // are two decisions about the same thing, whatever else they say.
    if (seenSequences.has(item.sequenceId) || seenSessions.has(item.sessionId)) {
      return refuse('DUPLICATE_ITEM', `Item ${index} names a launch that an earlier item already names.`);
    }
    seenSequences.add(item.sequenceId);
    seenSessions.add(item.sessionId);
    parsed.push({
      projectId: item.projectId,
      sessionId: item.sessionId,
      sequenceId: item.sequenceId,
      recoveryRevision: item.recoveryRevision
    });
  }
  return { ok: true, items: parsed };
}

const _internal = {
  /** Swappable so a test can make the pane read fail, or the pane stay busy. */
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  cursorInfo: (session) => require('./tmux').cursorInfo(session),
  assessIdle: (opts) => medusaWake.assessSessionIdle({ ...opts, ticksRequired: 1, mustBeTypeable: true }),
  inject: (projectName, line, options) => require('./sessions').injectCommand(projectName, line, options),
  wakeProfiles: () => medusaWake.ENGINE_WAKE_PROFILES,
  stepCount: () => store.LAUNCH_STEP_IDS.length,
  recordNudge: (sequenceId) => store.launchSequences.recordNudge(sequenceId),
  logActivity: (entry) => store.activity.log(entry),
  taskStepWithheld: (sequence) => require('./launch-sequence').taskStepWithheld(sequence),
  /**
   * The launch an item names, as stored now — null when it is not the launch
   * the item names. Swappable so a test can make this read fail.
   * @param {object} item - `{projectId, sessionId, sequenceId}`
   * @returns {object|null}
   */
  launchAsNamed: (item) => {
    const sequence = store.launchSequences.getBySession(item.sessionId);
    if (!sequence || sequence.id !== item.sequenceId || sequence.projectId !== item.projectId) return null;
    return sequence;
  },
  /**
   * Record a wake in the one-wake-per-pair cap, evicting the single oldest
   * entry if `map` is now over `cap` — never a wholesale clear. Exported so
   * a test can drive it directly at a small `cap`; the real cap (1000) is
   * impractical to reach through real launches.
   * @param {Map<string, true>} map
   * @param {string} key
   * @param {number} cap
   * @returns {void}
   */
  recordWoken: (map, key, cap) => {
    map.set(key, true);
    if (map.size > cap) map.delete(map.keys().next().value);
  }
};

/**
 * A pre-send refusal: every gate before `injectLine` is ever called, so
 * `attempted` is always false here — explicit on every return rather than
 * left to a caller to infer from the outcome alone.
 * @param {string} outcome - One of {@link SEND_OUTCOMES}
 * @param {string} reason
 * @returns {{outcome: string, reason: string, attempted: false}}
 */
function _pending(outcome, reason) {
  return { outcome, reason, attempted: false };
}

/**
 * Try to wake one launch: every pre-send gate, then the shared pane-busy
 * check and injection, exactly the unready monitor's own safeguards run at
 * `ticksRequired: 1` instead of a multi-tick streak.
 * @param {object} item - `{projectId, sessionId, sequenceId, recoveryRevision}`
 * @returns {{outcome: string, reason: (string|null), attempted: boolean}}
 */
function _attemptWake(item) {
  const project = store.projects.get(item.projectId);
  if (!project) return _pending(SEND_OUTCOMES.NOT_FOUND, 'No such project.');
  if (project.archived) return _pending(SEND_OUTCOMES.ARCHIVED, 'The project is archived.');

  const sequence = _internal.launchAsNamed(item);
  if (!sequence) {
    return _pending(SEND_OUTCOMES.NOT_FOUND, 'That launch sequence does not belong to this project, or no longer exists.');
  }
  if (sequence.recovery === 'required' || _internal.taskStepWithheld(sequence)) {
    return _pending(SEND_OUTCOMES.STILL_BLOCKED, 'This launch\'s task step is still withheld by its recovery gate.');
  }
  if (sequence.recoveryRevision !== item.recoveryRevision) {
    return _pending(SEND_OUTCOMES.STALE,
      `That wake names recovery revision ${item.recoveryRevision}, and this launch is at ${sequence.recoveryRevision}.`);
  }
  if (sequence.readyAt) {
    return _pending(SEND_OUTCOMES.ALREADY_READY, `This launch already attested READY at ${sequence.readyAt}.`);
  }

  const session = store.sessions.get(sequence.sessionId);
  if (!session || session.status !== store.SESSION_STATUS.ACTIVE) {
    return _pending(SEND_OUTCOMES.SESSION_ENDED, 'That launch\'s session has ended.');
  }
  if (sequence.startupDelivery === 'native') {
    return _pending(SEND_OUTCOMES.NATIVE_STARTUP,
      'This launch selected its engine\'s native startup channel, so nothing is ever typed into its pane.');
  }
  if (session.sessionMode === 'webui' || !session.tmuxSession) {
    return _pending(SEND_OUTCOMES.NO_PANE, 'The session has no tmux pane to wake.');
  }

  const wokenKey = _wokenKey(sequence.id, sequence.recoveryRevision);
  if (_wokenAtRevision.has(wokenKey)) {
    return _pending(SEND_OUTCOMES.ALREADY_WOKEN, 'This launch, at this revision, already had its one wake.');
  }

  const profile = _internal.wakeProfiles()[session.engineId];
  if (!profile) {
    return _pending(SEND_OUTCOMES.UNPROFILED_ENGINE, 'The engine has no live-probed pane signature.');
  }

  let verdict;
  try {
    verdict = paneWriter.assessPaneIdle(session.tmuxSession, {
      capturePane: _internal.capturePane,
      cursorInfo: _internal.cursorInfo,
      assessIdle: _internal.assessIdle,
      profile,
      lineCount: TMUX_TAIL_LINES,
      idleTicks: 0,
      onCursorError: (err) => {
        log.warn('Cursor probe failed for a recovery-wake item — falling back to the text prompt check', {
          sequence: sequence.id, error: err.message
        });
      }
    });
  } catch (err) {
    log.warn('A recovery-wake item\'s pane could not be read', { sequence: sequence.id, error: err.message });
    return _pending(SEND_OUTCOMES.PANE_CAPTURE_FAILED, 'The pane could not be read.');
  }
  if (!verdict.idle) {
    // Fails closed without consuming the wake-cap slot: a busy pane can be
    // retried by the operator sending this launch again.
    return _pending(SEND_OUTCOMES.PANE_BUSY, verdict.reason);
  }

  // From here on, `attempted` is true no matter what happens next: the typed
  // send was invoked. A throw from `injectLine` itself (not just a {code}
  // refusal) still counts — caught below, reported as FAILED but attempted.
  let code;
  let sent;
  try {
    ({ code, sent } = paneWriter.injectLine(
      _internal.inject,
      project.name,
      launchUnready.nudgeLine(sequence, _internal.stepCount(), { taskWithheld: false }),
      { sessionId: sequence.sessionId, launchSend: true }
    ));
  } catch (err) {
    log.error('Typing the recovery wake into the pane threw', { sequence: sequence.id, error: err.message });
    return { outcome: SEND_OUTCOMES.FAILED, reason: 'An internal error occurred while typing the wake into the pane.', attempted: true };
  }
  if (code === 'control-held') {
    return { outcome: SEND_OUTCOMES.CONTROL_HELD, reason: 'The lane is held or stopped by its control assignment.', attempted: true };
  }
  if (code === 'inject-failed') {
    return { outcome: SEND_OUTCOMES.INJECT_FAILED, reason: sent.error || 'Typing the wake into the pane failed.', attempted: true };
  }

  // The pane WAS typed into. From here, the send is a committed fact: a
  // bookkeeping failure (the cap, the nudge count, the activity log) must
  // never rewrite it back to attempted:false/sent:false — it is logged and
  // swallowed instead, best-effort, the same discipline
  // `lib/launch-pane-writer.js#logActivityBestEffort` already uses for its
  // own callers.
  try {
    _internal.recordWoken(_wokenAtRevision, wokenKey, WOKEN_CAP);
    _internal.recordNudge(sequence.id);
    log.info('Explicitly woke a session past its cleared recovery', {
      sequence: sequence.id, session: sequence.sessionId, project: project.name
    });
    _internal.logActivity({
      projectId: sequence.projectId,
      sessionId: sequence.sessionId,
      eventType: 'launch.recovery-wake-nudged',
      detail: { sequenceId: sequence.id, recoveryRevision: sequence.recoveryRevision }
    });
  } catch (err) {
    log.warn('Post-send bookkeeping failed for a recovery wake that had already typed into the pane', {
      sequence: sequence.id, error: err.message
    });
  }
  return { outcome: SEND_OUTCOMES.SENT, reason: null, attempted: true };
}

/**
 * What one launch's step cursor and READY attestation say right now — read
 * fresh, after the send attempt. Stored facts only: a cursor past zero is not
 * proof of acknowledgement beyond what was recorded, and a READY attestation
 * is not proof of resumed work. Same three-states-apart shape as
 * `lib/launch-recovery-held.js`'s parts.
 * @param {object} item - `{projectId, sessionId, sequenceId}`
 * @returns {{stepAcknowledgement: object, readyAttestation: object}}
 */
function _observeAfter(item) {
  const unavailable = { state: PART_STATES.UNAVAILABLE, reasonCode: REASON_CODES.SOURCE_READ_FAILED };
  try {
    const sequence = _internal.launchAsNamed(item);
    if (!sequence) return { stepAcknowledgement: { state: PART_STATES.NONE_RECORDED }, readyAttestation: { state: PART_STATES.NONE_RECORDED } };
    return {
      stepAcknowledgement: { state: PART_STATES.RECORDED, cursor: sequence.cursor, stepCount: _internal.stepCount() },
      readyAttestation: { state: PART_STATES.RECORDED, attestedReady: Boolean(sequence.readyAt), readyAt: sequence.readyAt || null }
    };
  } catch (err) { // prawduct:allow prawduct/broad-except -- a re-read failure must not undo the send already attempted; it is reported as unavailable and logged
    log.warn('A recovery-wake item could not be re-read for its observation', {
      session: item.sessionId, sequence: item.sequenceId, error: err.message
    });
    return { stepAcknowledgement: unavailable, readyAttestation: unavailable };
  }
}

/**
 * Wake a batch of launches past their cleared recovery, as one operator's
 * request.
 * @param {object} args
 * @param {object[]} args.items - From {@link parseRequest}
 * @param {string} args.requestedBy - The signed-in operator
 * @returns {{requestedBy: string, requestedAt: string, observedAt: string, items: object[]}}
 */
function wakeBatch({ items, requestedBy }) {
  const requestedAt = new Date().toISOString();
  const results = items.map((item, index) => {
    let outcome;
    let reason;
    let attempted;
    try {
      ({ outcome, reason, attempted } = _attemptWake(item));
    } catch (err) { // prawduct:allow prawduct/broad-except -- one item that throws must not abandon the items after it; it is reported as failed and logged
      // _attemptWake's own try/catch around injectLine and the post-send
      // bookkeeping means a throw escaping all the way here happened before
      // injectLine was ever called (a pre-send gate's own read) — genuinely
      // not attempted.
      log.error('A recovery-wake item failed', {
        project: item.projectId, session: item.sessionId, sequence: item.sequenceId, error: err.message
      });
      outcome = SEND_OUTCOMES.FAILED;
      reason = 'An internal error prevented this item from being decided.';
      attempted = false;
    }
    return {
      index,
      ...item,
      send: { attempted, sent: outcome === SEND_OUTCOMES.SENT, outcome, reason },
      ..._observeAfter(item)
    };
  });
  const observedAt = new Date().toISOString();
  return { requestedBy, requestedAt, observedAt, items: results };
}

module.exports = { MAX_ITEMS, SEND_OUTCOMES, parseRequest, wakeBatch, _internal };
