'use strict';

/**
 * The automatic bootstrap at launch (#1825 B3).
 *
 * A launch that selected its engine's native startup channel — the launch row
 * says `startupDelivery: 'native'`, decided when the channel started and the
 * sequence applied, and frozen in the same transaction that bound the sequence
 * — gets its first turn from ONE automatic fire of the operator's startup
 * prompt through `startupPrompt.fire`, the same service the dashboard and the
 * API use. Nothing is typed into that pane: not the prime, not the kickoff,
 * and (`launch-unready`) not the nudge. The engine's own receipt, on the fire
 * row, is what says the prompt arrived.
 *
 * A launch that selected the keystroke path (`legacy`) is left exactly as it
 * was — the paste or the kickoff runs — and this module's one job for it is to
 * RECORD why it could not go native: the same service is asked with the same
 * internal caller, and its typed `unsupported` or `blocked` answer is the
 * durable reason (S3, Architect F4). This module never writes a fire row itself.
 *
 * Prerequisite for a native send: the pane must have been found ready. Where
 * the engine's adapter can prove that itself (its launch's thread idle, and
 * the launch's pane positively showing an empty composer), its answer is the
 * gate, and an adapter that has that read and cannot answer is a gate that
 * did not pass: nothing is sent, and no other gate is consulted in its place.
 * Only an engine whose adapter has no such read keeps the at-rest marker gate
 * (`_awaitPaneReady`). Either gate that does not pass still produces the
 * audited attempt, carried into the service as a launch-only pre-send result,
 * which settles the row `blocked` with `pane_not_ready` and never asks the
 * adapter to send. No retry, no fallback: the launch panel shows the reason,
 * and a human may Fire once it clears.
 *
 * Like the kickoff, this is at-most-once per session, claimed before the send
 * and given back only where nothing could have reached the engine.
 *
 * @module lib/launch-bootstrap
 */

const { createLogger } = require('./logger');

const log = createLogger('launch-bootstrap');

/**
 * What each outcome means, keyed by the code `bootstrap` returns.
 * @type {Record<string, string>}
 */
const OUTCOME_MEANINGS = Object.freeze({
  fired: 'the startup prompt was fired once through the engine\'s native channel; the fire row carries the engine\'s receipt',
  'not-sent': 'the one automatic attempt was recorded and nothing was sent; the fire row names the blocker (the pane gate, the adapter\'s own pre-send check, or its last look before the send)',
  'legacy-recorded': 'this launch keeps the keystroke path; why it could not go native is recorded on a fire row',
  'no-sequence': 'this launch has no sequence to read, so there is nothing to bootstrap and nothing to record',
  'already-fired': 'this launch has had its one automatic attempt',
  'session-gone': 'the session or its launch was gone when the bootstrap ran',
  'service-refused': 'the fire service refused the attempt for a reason that is not a launch outcome; the log names the code and nothing was sent'
});

/**
 * How many sessions to remember having bootstrapped; see `launch-kickoff`.
 * @type {number}
 */
const FIRED_MEMORY = 512;

/** Sessions that have had their one automatic attempt (in-memory; the durable record is the fire row). @type {Set<number>} */
const _fired = new Set();

/**
 * The deterministic key of a launch's automatic attempt (Architect F3): the
 * launch, at the prompt revision it fired. A replay of the same key returns
 * the same row and never reinjects.
 * @param {number} sequenceId - Launch-sequence row id.
 * @param {number} revision - Prompt revision.
 * @returns {string}
 */
function attemptKey(sequenceId, revision) {
  return `launch-${sequenceId}-r${revision}`;
}

/**
 * Bootstrap a freshly launched session — once.
 *
 * Never throws and never rejects: a launch must not fail on this, so every
 * failure resolves to a code instead.
 * @param {object} args
 * @param {number} args.sessionId - The session, and the one-shot key
 * @param {number} args.projectId - Its project
 * @param {string} args.projectName - The project name the fire route is keyed by
 * @param {string|null} args.tmuxName - The tmux session name, or null for a web UI session
 * @param {string} args.engineId - Which engine is driving the pane
 * @param {boolean} args.hasSequence - Whether this launch has a sequence to read
 * @param {'legacy'|'native'} args.startupDelivery - The path the launch selected
 * @returns {Promise<string>} A code from `OUTCOME_MEANINGS`
 */
async function bootstrap(args) {
  const { sessionId, projectId, projectName, tmuxName, engineId, hasSequence, startupDelivery } = args;
  if (!hasSequence) return 'no-sequence';
  if (_fired.has(sessionId)) return 'already-fired';
  // Claimed BEFORE the send: the question is whether a second turn could ever
  // be submitted, and the answer must be no while the first is in flight.
  _fired.add(sessionId);
  while (_fired.size > FIRED_MEMORY) _fired.delete(_fired.values().next().value);

  const native = startupDelivery === 'native';
  let sequence;
  try {
    sequence = _internal.getSequence(sessionId);
  } catch (err) {
    log.warn('launch-bootstrap: the launch sequence could not be read', { session: sessionId, error: err.message });
    sequence = null;
  }
  if (!sequence) {
    _fired.delete(sessionId);
    return 'session-gone';
  }

  // The pane gate is the native path's prerequisite. A legacy launch is not
  // waiting on anything: its record is written now, and its paste or kickoff
  // runs on its own timers.
  const paneGate = native ? await _paneGate({ sessionId, sequenceId: sequence.id, tmuxName, engineId }) : null;

  const outcome = await _attempt({ sessionId, projectId, projectName, sequence, paneGate, native });
  _internal.logActivity({
    projectId,
    sessionId,
    eventType: 'launch.bootstrap',
    detail: { sequenceId: sequence.id, startupDelivery, outcome: outcome.code, fireId: outcome.fireId, reasonCode: outcome.reasonCode }
  });
  log.info('Launch bootstrap outcome', {
    project: projectName, session: sessionId, startupDelivery, outcome: outcome.code,
    reasonCode: outcome.reasonCode, meaning: OUTCOME_MEANINGS[outcome.code]
  });
  return outcome.code;
}

/**
 * Find out whether a native launch's pane is ready for its first turn.
 *
 * The engine's adapter is asked first. `unsupported` means it has no such
 * read, and only then is the at-rest marker gate used. Any other answer is
 * final: an adapter that has the read and could not make it (`unknown`) is not
 * ready, and the marker is never consulted to overrule that, whatever the pane
 * shows.
 * @param {{sessionId: number, sequenceId: number, tmuxName: (string|null), engineId: string}} a - The launch.
 * @returns {Promise<{ready: boolean, reason: string, proof?: 'adapter', unavailable?: boolean, remedy?: string, whole?: string}>}
 */
async function _paneGate(a) {
  const { sessionId, sequenceId, tmuxName, engineId } = a;
  if (!tmuxName) return { ready: false, reason: 'the session has no tmux pane to observe' };
  let asked;
  try {
    asked = await _internal.launchGate({ sessionId, sequenceId, engineId });
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- a launch must never fail on its gate; a gate that threw did not pass
    log.warn('launch-bootstrap: the launch-readiness read threw', { session: sessionId, error: err.message });
    asked = { answer: 'unknown', unavailable: true, observation: 'the launch-readiness read failed' };
  }
  if (!asked || asked.answer !== 'unsupported') {
    if (asked && asked.answer === 'ready') {
      return { ready: true, reason: 'the launch\'s thread was idle and its pane showed an empty composer', proof: 'adapter' };
    }
    const known = asked && (asked.answer === 'not-ready' || asked.answer === 'unknown');
    return {
      ready: false,
      proof: 'adapter',
      // Anything but a plain "seen not ready" is a proof that could not be made.
      unavailable: !(known && asked.answer === 'not-ready' && asked.unavailable !== true),
      reason: known && asked.observation ? asked.observation : 'the launch-readiness read gave no answer',
      ...(known && asked.remedy ? { remedy: asked.remedy } : {}),
      ...(known && asked.whole ? { whole: asked.whole } : {})
    };
  }
  try {
    const readiness = await _internal.awaitPaneReady(tmuxName, engineId);
    return readiness.ready === true
      ? { ready: true, reason: 'the pane rendered its at-rest marker over a settled transcript' }
      : { ready: false, reason: readiness.reason || (readiness.gated === false ? 'the engine declares no at-rest marker, so the pane cannot be observed ready' : 'the pane never rendered ready') };
  } catch (err) {
    return { ready: false, reason: `the readiness gate failed: ${err.message}` };
  }
}

/**
 * Ask the fire service once, at the current prompt revision, retrying exactly
 * once if the prompt was saved between the read and the fire.
 * @param {object} a - `sessionId, projectId, projectName, sequence, paneGate, native`
 * @returns {Promise<{code: string, fireId: (number|null), reasonCode: (string|null)}>}
 */
async function _attempt(a) {
  const { sessionId, projectId, projectName, sequence, paneGate, native } = a;
  const caller = _internal.launchCaller({ sessionId, projectId });
  for (let tries = 0; tries < 2; tries++) {
    let revision;
    try {
      revision = _internal.currentPrompt().revision;
    } catch (err) {
      log.warn('launch-bootstrap: the startup prompt could not be read', { session: sessionId, error: err.message });
      return { code: 'service-refused', fireId: null, reasonCode: null };
    }
    let result;
    try {
      result = await _internal.fire({
        projectName, sessionId, sequenceId: sequence.id, expectedRevision: revision,
        idempotencyKey: attemptKey(sequence.id, revision), caller, clearance: _internal.launchClearance(),
        ...(paneGate ? { paneGate } : {})
      });
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- a launch must never fail on its bootstrap; the outcome is logged
      log.warn('launch-bootstrap: the fire service threw', { session: sessionId, error: err.message });
      return { code: 'service-refused', fireId: null, reasonCode: null };
    }
    const body = result && result.body ? result.body : {};
    const fire = body.fire || null;
    if (result.status === 200) return { code: 'fired', fireId: fire ? fire.id : null, reasonCode: fire ? fire.reasonCode : null };
    if (body.code === 'STALE_STARTUP_PROMPT' && tries === 0) continue;
    if (body.code === 'STARTUP_CONTROL_UNSUPPORTED' || body.code === 'STARTUP_FIRE_BLOCKED') {
      return { code: native ? 'not-sent' : 'legacy-recorded', fireId: fire ? fire.id : null, reasonCode: fire ? fire.reasonCode : (body.reasonCode || null) };
    }
    if (body.code === 'SESSION_NOT_FOUND' || body.code === 'LAUNCH_NOT_CURRENT') {
      return { code: 'session-gone', fireId: null, reasonCode: null };
    }
    if (body.code === 'STARTUP_PROMPT_ALREADY_APPLIED' || body.code === 'STARTUP_FIRE_IN_FLIGHT') {
      return { code: 'already-fired', fireId: body.fire ? body.fire.id : null, reasonCode: null };
    }
    log.warn('launch-bootstrap: the fire service refused the automatic attempt', { session: sessionId, status: result.status, code: body.code });
    return { code: 'service-refused', fireId: null, reasonCode: null };
  }
  return { code: 'service-refused', fireId: null, reasonCode: null };
}

/**
 * Forget which sessions have been bootstrapped. For the tests.
 * @returns {void}
 */
function reset() {
  _fired.clear();
}

/**
 * Injectable seams, lazily required the way `launch-kickoff` does it: this
 * module is reached from `lib/sessions.js`, which requires the store and the
 * fire service on its own.
 */
const _internal = {
  getSequence: (sessionId) => require('./store').launchSequences.getBySession(sessionId),
  currentPrompt: () => require('./store').startupPrompts.current(),
  awaitPaneReady: (tmuxName, engineId) => require('./sessions')._awaitPaneReady(tmuxName, engineId),
  launchGate: (launch) => require('./startup-prompt').launchGate(launch),
  fire: (input) => require('./startup-prompt').fire(input),
  launchCaller: (launch) => require('./startup-prompt').launchCaller(launch),
  launchClearance: () => require('./startup-prompt').LAUNCH_CLEARANCE,
  logActivity: (entry) => {
    try {
      require('./store').activity.log(entry);
    } catch (err) {
      // A timeline write must never be the reason a session goes unbootstrapped.
      log.warn('launch-bootstrap: failed to log an activity entry', { eventType: entry.eventType, error: err.message });
    }
  }
};

module.exports = { bootstrap, attemptKey, reset, FIRED_MEMORY, OUTCOME_MEANINGS, _fired, _internal };
