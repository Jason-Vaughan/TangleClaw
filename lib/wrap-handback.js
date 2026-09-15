'use strict';

/**
 * The watched handback: what happens after the wrap drawer asks the session to
 * fix the step its wrap blocked on.
 *
 * Sending the fix prompt was always possible (`POST /command`); knowing when the
 * session had finished was not, so the operator guessed when to press Retry. This
 * module sends the prompt with the same completion instruction a pipeline content
 * step ends with — a fresh nonce, so a marker an earlier prompt left in the
 * scrollback cannot finish this one — and watches the pane for it. The watch ends
 * one of four ways:
 *
 *   - `ready`, `completedVia: 'marker'` — the session printed the line;
 *   - `ready`, `completedVia: 'quiet'` — an engine that never prints it went quiet
 *     for the content step's quiet window, and `completionNote` says the evidence
 *     was silence rather than the session saying so;
 *   - `timed-out` — neither within the content step's maximum wait;
 *   - `failed` — the pane could not be read (the session died).
 *
 * None of these gates Retry. The drawer lights Retry on `ready` and explains the
 * others; the operator can always press it.
 *
 * A handback belongs to the settled run it was sent for. It is dropped when a new
 * wrap begins (the run id no longer matches) and replaced when another handback is
 * sent, and a replaced or orphaned watch stops at its next poll. Process-local,
 * like the run registry it hangs off: a restart ends every watch.
 */

const crypto = require('node:crypto');
const { createLogger } = require('./logger');
const store = require('./store');
const wrapRunRegistry = require('./wrap-run-registry');
const aiContent = require('./wrap-steps/ai-content');
const { HANDBACK_STREAM_EVENTS: HB } = require('../public/wrap-stream-events');

const log = createLogger('wrap-handback');

// The drawer caps its composed prompt here; the completion instruction is
// appended after, and the whole must stay under `injectCommand`'s 4096 limit.
const MAX_PROMPT_CHARS = 3800;

/** @type {Map<string, object>} project name → the latest handback */
const _handbacks = new Map();

/**
 * A refusal in the route's terms.
 *
 * @param {number} status - HTTP status
 * @param {string} code - Error code
 * @param {string} error - Message for the operator
 * @returns {{ok: false, status: number, code: string, error: string}}
 */
function _refuse(status, code, error) {
  return { ok: false, status, code, error };
}

/**
 * The public view of a handback — what `GET /wrap/status` and the stream carry.
 *
 * @param {object} entry - Internal handback entry
 * @returns {{handbackId: string, stepId: string, state: string, completedVia: string|null, completionNote: string|null, error: string|null, startedAt: number, finishedAt: number|null}}
 */
function _view(entry) {
  return {
    handbackId: entry.handbackId,
    stepId: entry.stepId,
    state: entry.state,
    completedVia: entry.completedVia,
    completionNote: entry.completionNote,
    error: entry.error,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt
  };
}

/**
 * Append an event to a handback's log and deliver it. A throwing subscriber is
 * dropped: a watcher's progress must not depend on a network client.
 *
 * @param {object} entry - Internal handback entry
 * @param {string} type - Event name from `HANDBACK_STREAM_EVENTS`
 * @returns {void}
 */
function _append(entry, type) {
  const event = { type, seq: entry.events.length + 1, at: _internal.now(), ..._view(entry) };
  entry.events.push(event);
  for (const sub of entry.subscribers) {
    try {
      sub.onEvent(event);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a subscriber is a network client; its failure is logged and dropped so the watch continues
      log.warn('handback subscriber threw — dropping it', { handbackId: entry.handbackId, error: err.message });
      entry.subscribers.delete(sub);
    }
  }
}

/**
 * Settle a handback: record how it ended, deliver the terminal event, end every
 * subscriber. Idempotent — a watch that was already settled is left alone.
 *
 * @param {object} entry - Internal handback entry
 * @param {{state: string, completedVia?: string|null, completionNote?: string|null, error?: string|null}} outcome
 * @returns {void}
 */
function _settle(entry, outcome) {
  if (entry.finishedAt !== null) return;
  entry.state = outcome.state;
  entry.completedVia = outcome.completedVia || null;
  entry.completionNote = outcome.completionNote || null;
  entry.error = outcome.error || null;
  entry.finishedAt = _internal.now();
  _append(entry, HB.HANDBACK_DONE);
  for (const sub of entry.subscribers) {
    try {
      sub.onEnd();
    } catch (err) { // prawduct:allow prawduct/broad-except -- ending a dead client must not stop the others ending
      log.warn('handback subscriber end threw', { handbackId: entry.handbackId, error: err.message });
    }
  }
  entry.subscribers.clear();
  log.info('handback watch ended', {
    handbackId: entry.handbackId, stepId: entry.stepId, state: entry.state,
    completedVia: entry.completedVia, waitedMs: entry.finishedAt - entry.startedAt
  });
}

/**
 * Whether a watch should stop because it no longer describes the project's
 * current handback: another was sent, or a new wrap run began.
 *
 * @param {string} projectName - Registry key
 * @param {object} entry - Internal handback entry
 * @returns {boolean}
 */
function _orphaned(projectName, entry) {
  if (_handbacks.get(projectName) !== entry) return true;
  return wrapRunRegistry.get(projectName).runId !== entry.runId;
}

/**
 * Poll the pane until the completion marker, the quiet window, the maximum wait,
 * or a failed read ends the watch. Uses the content step's own constants, so a
 * handback waits exactly as long as the step it stands in for.
 *
 * @param {string} projectName - Registry key
 * @param {object} entry - Internal handback entry (carries `tmuxSession`, `nonce`)
 * @returns {Promise<void>}
 */
async function _watch(projectName, entry) {
  let quietLast = null;
  let quietSince = entry.startedAt;
  while (_internal.now() - entry.startedAt < aiContent.MAX_WAIT_MS) {
    await _internal.sleep(aiContent.POLL_INTERVAL_MS);
    if (entry.finishedAt !== null) return;
    if (_orphaned(projectName, entry)) {
      // Nobody reads an orphan's outcome; end its streams so no client waits on it.
      _settle(entry, { state: 'superseded' });
      return;
    }
    let tail;
    try {
      tail = _internal.readPaneTail(entry.tmuxSession);
    } catch (err) {
      _settle(entry, { state: 'failed', error: `Could not read the terminal: ${err.message}` });
      return;
    }
    if (aiContent._markerSeen(tail, entry.nonce)) {
      _settle(entry, { state: 'ready', completedVia: 'marker' });
      return;
    }
    if (tail !== quietLast) {
      quietLast = tail;
      quietSince = _internal.now();
    } else if (_internal.now() - quietSince >= aiContent.QUIET_FALLBACK_MS) {
      _settle(entry, {
        state: 'ready',
        completedVia: 'quiet',
        completionNote: `no completion marker seen — the terminal was unchanged for ${Math.round(aiContent.QUIET_FALLBACK_MS / 1000)}s`
      });
      return;
    }
  }
  _settle(entry, {
    state: 'timed-out',
    error: `The session did not print its completion line within ${Math.round(aiContent.MAX_WAIT_MS / 1000)}s, and the terminal never stayed unchanged for ${Math.round(aiContent.QUIET_FALLBACK_MS / 1000)}s.`
  });
}

/**
 * Send a fix prompt for the project's blocked wrap step and start watching for
 * the session to finish.
 *
 * Refused unless the project's latest run has settled with a halt AT `stepId`,
 * so a handback cannot be aimed at a running wrap, a completed one, or a step
 * that is not the one blocking. A `needs-operator` block is refused too: that
 * status means the pane discards what is typed into it.
 *
 * @param {string} projectName - Project name (registry key)
 * @param {{stepId?: unknown, prompt?: unknown}} body - Request body
 * @returns {{ok: true, handbackId: string, handback: object} | {ok: false, status: number, code: string, error: string}}
 */
function start(projectName, body) {
  const stepId = body && typeof body.stepId === 'string' ? body.stepId.trim() : '';
  const prompt = body && typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!stepId) return _refuse(400, 'BAD_REQUEST', 'stepId is required');
  if (!prompt) return _refuse(400, 'BAD_REQUEST', 'prompt is required');
  if (prompt.length > MAX_PROMPT_CHARS) {
    return _refuse(400, 'BAD_REQUEST', `prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  }
  if (/[\r\n]/.test(prompt)) {
    // Sent by tmux send-keys, where a newline is an Enter that submits half a prompt.
    return _refuse(400, 'BAD_REQUEST', 'prompt must be a single line');
  }

  const run = wrapRunRegistry.get(projectName);
  if (!run.runId || run.running || run.stale) {
    return _refuse(409, 'WRAP_NOT_SETTLED', `No settled wrap for "${projectName}" to hand a fix back for.`);
  }
  const pipelineResult = run.result && run.result.pipelineResult;
  if (!pipelineResult || pipelineResult.blockedAt !== stepId) {
    return _refuse(409, 'WRAP_STEP_NOT_BLOCKED', `The last wrap for "${projectName}" did not stop at "${stepId}".`);
  }
  const steps = Array.isArray(pipelineResult.results) ? pipelineResult.results : [];
  const blocked = steps.find((s) => s && s.stepId === stepId);
  if (blocked && blocked.status === 'needs-operator') {
    return _refuse(409, 'WRAP_STEP_NEEDS_OPERATOR', `"${stepId}" needs the operator: the session cannot act on a prompt.`);
  }

  const session = run.sessionId == null ? null : _internal.getSession(run.sessionId);
  if (!session || !session.tmuxSession) {
    return _refuse(404, 'NOT_FOUND', `The wrap's session for "${projectName}" is gone.`);
  }

  const nonce = _internal.newNonce();
  const text = `${prompt} ${aiContent._completionInstruction(nonce)}`;
  const injected = _internal.inject(projectName, text, { sessionId: run.sessionId });
  if (!injected.ok) {
    const status = /not found|No active|not a session|not active/.test(injected.error || '') ? 404 : 409;
    return _refuse(status, 'HANDBACK_NOT_SENT', injected.error || 'The prompt could not be sent.');
  }

  const previous = _handbacks.get(projectName);
  const entry = {
    handbackId: _internal.newHandbackId(),
    runId: run.runId,
    stepId,
    tmuxSession: session.tmuxSession,
    nonce,
    state: 'working',
    completedVia: null,
    completionNote: null,
    error: null,
    startedAt: _internal.now(),
    finishedAt: null,
    events: [],
    subscribers: new Set()
  };
  _handbacks.set(projectName, entry);
  if (previous) _settle(previous, { state: 'superseded' });
  _append(entry, HB.HANDBACK_START);
  log.info('handback sent', { project: projectName, handbackId: entry.handbackId, stepId });
  _internal.watch(projectName, entry).catch((err) => {
    log.error('handback watch crashed', { handbackId: entry.handbackId, error: err.message });
    _settle(entry, { state: 'failed', error: `The watch stopped unexpectedly: ${err.message}` });
  });
  return { ok: true, handbackId: entry.handbackId, handback: _view(entry) };
}

/**
 * The project's current handback for a run, or null when there is none or it
 * belongs to an earlier run.
 *
 * @param {string} projectName - Registry key
 * @param {string|null} runId - The run the caller is showing
 * @returns {object|null}
 */
function get(projectName, runId) {
  const entry = _handbacks.get(projectName);
  if (!entry || !runId || entry.runId !== runId) return null;
  return _view(entry);
}

/**
 * Attach to a handback's event log. Replays what was emitted; a settled
 * handback reports `finished` so the caller closes after the replay.
 *
 * @param {string} projectName - Registry key
 * @param {string} handbackId - The handback to watch
 * @param {{onEvent: (event: object) => void, onEnd: () => void}} listener
 * @returns {{ok: false} | {ok: true, replay: object[], finished: boolean, unsubscribe: () => void}}
 */
function subscribe(projectName, handbackId, listener) {
  const entry = _handbacks.get(projectName);
  if (!entry || entry.handbackId !== handbackId) return { ok: false };
  const replay = entry.events.slice();
  if (entry.finishedAt !== null) return { ok: true, replay, finished: true, unsubscribe: () => {} };
  const sub = { onEvent: listener.onEvent, onEnd: listener.onEnd };
  entry.subscribers.add(sub);
  return { ok: true, replay, finished: false, unsubscribe: () => { entry.subscribers.delete(sub); } };
}

/**
 * Test-only: settle and drop every handback.
 * @returns {void}
 */
function _resetForTests() {
  for (const entry of _handbacks.values()) entry.finishedAt = entry.finishedAt || _internal.now();
  _handbacks.clear();
}

/**
 * Real sleep.
 * @param {number} ms - Milliseconds
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const _internal = {
  now: () => Date.now(),
  sleep: defaultSleep,
  /**
   * Read the recent pane text — the content step's own reader, so both watches
   * see the same window.
   * @param {string} tmuxSession - tmux session name
   * @returns {string}
   */
  readPaneTail: (tmuxSession) => aiContent._internal.readPaneTail(tmuxSession),
  /**
   * A fresh completion nonce — the content step's own generator.
   * @returns {string}
   */
  newNonce: () => aiContent._internal.newNonce(),
  /**
   * A handback id: 128 random bits, hex, so presenting it to the stream is
   * evidence the caller got it from the POST or the status route.
   * @returns {string}
   */
  newHandbackId: () => crypto.randomBytes(16).toString('hex'),
  /**
   * The session record the wrap ran against.
   * @param {number} sessionId - Session record id
   * @returns {object|null}
   */
  getSession: (sessionId) => store.sessions.get(sessionId),
  /**
   * Send text into the session — `sessions.injectCommand`, required lazily
   * because `sessions` requires modules this one is loaded beside.
   * @param {string} projectName - Project name
   * @param {string} text - Single-line text
   * @param {{sessionId: number}} options - Address the wrap's own session
   * @returns {{ok: boolean, error: string|null}}
   */
  inject: (projectName, text, options) => require('./sessions').injectCommand(projectName, text, options),
  watch: _watch
};

module.exports = { start, get, subscribe, MAX_PROMPT_CHARS, _resetForTests, _internal };
