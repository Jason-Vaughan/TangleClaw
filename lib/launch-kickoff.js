'use strict';

/**
 * The launch kickoff (#1635).
 *
 * A silently primed session boots fully briefed and completely idle. The
 * SessionStart hook hands the prime to the engine as hidden model context, and
 * context is not a turn: the agent has everything it needs and nothing to
 * answer, so it sits at an empty prompt. Nothing in the launch path types into
 * that pane, because `_deferEngineInit`'s paste is the thing silent prime
 * exists to skip.
 *
 * The result was a launch that worked exactly as designed and still served its
 * first step ten minutes late — `launch-unready` was the only writer left, and
 * it is a monitor with a window measured in minutes. Two launches put the same
 * shape on the record: one waited out the window to the second, the other was
 * rescued by a human typing.
 *
 * This module sends ONE line, once, at launch: read your launch context. It is
 * the turn the silent path removed, not a new channel — `prime-delivery-direction.md`
 * §3 already permits serving rules by acknowledged pull, and its first bounding
 * condition is that the pull is acknowledged rather than merely available. A
 * pull nobody is asked to begin cannot be acknowledged, so restoring the prompt
 * is what makes that amendment reachable.
 *
 * What it deliberately is not:
 * - **It is not a retry loop.** One send per session, marked before the send
 *   rather than after. At-most-once is the right side to fail on here: a
 *   duplicate turn is the worse outcome, and `launch-unready` is already the
 *   backstop for a send that never lands.
 * - **It is not a gate.** It cannot block, fail or delay a launch, and an
 *   engine it cannot type into safely is left exactly as it is today
 *   (`wrap-direction.md` commitment 3).
 * - **It is not authorization.** The line asks the session to READ its context.
 *   Every confirmation gate the prime carries survives it untouched.
 * - **It carries no rules,** so it writes no `session_rule_deliveries` row. The
 *   hook delivered the rules; a delivery row for a line that carries none is
 *   the true-but-useless accounting Direction §4 exists to forbid.
 *
 * The gates are borrowed, not invented. `ENGINE_WAKE_PROFILES` is what keeps
 * this engine-agnostic: an engine with no live-probed pane signature is never
 * typed into, and degrades to today's behavior with a recorded reason.
 * `assessSessionIdle` is the one idle gate — it refuses a pane that is working
 * and, through `composer-has-input`, one that holds an unsent draft.
 *
 * @module lib/launch-kickoff
 */

const { createLogger } = require('./logger');

const log = createLogger('launch-kickoff');

/** How many pane lines the idle gate reads, matching the other monitors. */
const TMUX_TAIL_LINES = 15;

/**
 * How long to keep looking for a typeable pane before giving up, and how often
 * to look. The idle gate needs consecutive observations to trust a pane, so a
 * single glance can never satisfy it.
 * @type {number}
 */
const IDLE_POLL_MS = 750;

/** @type {number} */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * What each outcome means, keyed by the code `kickoff` returns.
 *
 * Declared rather than left as bare strings, for the same reason
 * `launch-unready` declares its own: these are what the log and the tests read,
 * and a code with no meaning here is a state nobody can explain.
 * @type {Record<string, string>}
 */
const OUTCOME_MEANINGS = Object.freeze({
  sent: 'the session was asked, once, to read its launch context',
  'already-fired': 'this launch has had its one kickoff; the session owns it now',
  'no-sequence': 'this launch has no sequence to read, so there is nothing to begin',
  'not-silent': 'the prime was pasted into the pane, which is itself the first turn',
  'no-pane': 'the session has no tmux pane to type into (a web UI session)',
  'unprofiled-engine': 'the engine has no live-probed pane signature, so nothing may be typed into it safely',
  'pane-busy': 'the pane stayed busy, or held unsent input, for the whole window',
  'inject-failed': 'typing the kickoff into the pane failed'
});

/**
 * How many sessions to remember having kicked off.
 *
 * The set has no natural eviction signal — this module never learns that a
 * session ended — so without a bound it grows for the server's whole life. The
 * oldest entries are the safe ones to drop: session ids only increase, and a
 * session old enough to fall off this window launched long ago and is not about
 * to be kicked off a second time.
 * @type {number}
 */
const FIRED_MEMORY = 512;

/**
 * Sessions already kicked off, so a second call cannot produce a second turn.
 * Keyed by session because that is the granularity of the thing being
 * protected: one launch gets one pane and one first turn.
 *
 * In-memory and ephemeral on purpose: the kickoff is a launch-time one-shot,
 * and the durable answer to whether it worked is already on the sequence row as
 * `pagesServed`/`servedAt`. A restart loses the marker and the unready monitor
 * covers what follows.
 * @type {Set<number>}
 */
const _fired = new Set();

/**
 * The kickoff line, containing only TangleClaw-controlled bytes.
 *
 * One line with no embedded newlines: `tmux.sendKeys` sends a single Enter
 * after the whole line, so a second line would submit half a sentence.
 *
 * It states what reading costs and what it does not buy, because the line is
 * the first thing the session acts on and an instruction to start reading is
 * one word away from reading as an instruction to start working.
 * @param {number} stepCount - How many steps the sequence has
 * @returns {string}
 */
function kickoffLine(stepCount) {
  return '[TangleClaw] Your launch context is waiting and none of it has been read yet: '
    + `0 of ${stepCount} step(s) acknowledged. Begin now with \`tc start next\`, acknowledge each step with `
    + 'the command that step prints, then attest with `tc start ready --verdict <the preflight verdict '
    + 'step 3 stated> --first-action "<what you propose to do first>"`. '
    + 'Reading and attesting record that the context arrived; they authorize nothing, so honour every '
    + 'confirmation gate your context states. '
    + 'If you cannot read the steps, say so rather than working from context you never received.';
}

/**
 * Wait for a pane that is safe to type into, using the shared idle gate.
 *
 * Returns as soon as the gate has seen the streak it requires, so a pane that
 * is ready immediately costs one extra poll rather than the whole window.
 * @param {string} tmuxName - The tmux session name
 * @param {object} profile - The engine's wake profile
 * @param {number} deadline - Absolute ms after which to give up
 * @returns {Promise<{idle: boolean, reason: string}>}
 */
async function _awaitTypeable(tmuxName, profile, deadline) {
  let idleTicks = 0;
  let prevDigest;
  let reason = 'no window to look in';
  while (_internal.now() < deadline) {
    let captured = null;
    try {
      captured = _internal.capturePane(tmuxName, { lines: TMUX_TAIL_LINES });
    } catch (err) {
      // Not-ready, not broken: the pane may not exist for the first instants of
      // a launch. A persistent failure still ends at the deadline.
      reason = `pane could not be read (${err.message})`;
    }
    if (captured) {
      let cursor = null;
      try {
        cursor = _internal.cursorInfo(tmuxName);
      } catch {
        // Best-effort, exactly as the unready monitor treats it: a pane that
        // cannot report a cursor is judged by the weaker text check rather than
        // losing its kickoff to a tmux query that failed while the pane read fine.
      }
      const verdict = _internal.assessIdle({
        lines: captured.lines || [], profile, cursor, prevDigest, idleTicks
      });
      prevDigest = verdict.digest;
      idleTicks = verdict.idleTicks;
      reason = verdict.reason;
      if (verdict.idle) return { idle: true, reason };
    }
    await _internal.sleep(IDLE_POLL_MS);
  }
  return { idle: false, reason };
}

/**
 * Ask a freshly launched session to read its launch context — once.
 *
 * Never throws and never rejects: a launch must not fail on this, so every
 * failure resolves to a code instead.
 * @param {object} args
 * @param {number} args.sessionId - The session whose pane to type into, and the one-shot key
 * @param {number} args.projectId - The project, for the activity entry
 * @param {string} args.projectName - The project name `injectCommand` addresses
 * @param {string|null} args.tmuxName - The tmux session name, or null for a web UI session
 * @param {string} args.engineId - Which engine is driving the pane
 * @param {boolean} args.silentPrime - Whether the prime was delivered silently
 * @param {boolean} args.hasSequence - Whether this launch has a sequence to read
 * @returns {Promise<string>} A code from `OUTCOME_MEANINGS`
 */
async function kickoff(args) {
  const {
    sessionId, projectId, projectName, tmuxName, engineId, silentPrime, hasSequence
  } = args;

  // The three shapes that have no turn to restore, cheapest first. A pasted
  // prime IS the session's first turn, so kicking off after one would be the
  // duplicate submission this fix must not introduce.
  if (!hasSequence) return 'no-sequence';
  if (!silentPrime) return 'not-silent';
  if (!tmuxName) return 'no-pane';

  if (_fired.has(sessionId)) return 'already-fired';

  const profile = _internal.wakeProfiles()[engineId];
  if (!profile) {
    log.info('A launched session cannot be kicked off: its engine has no probed pane signature', {
      session: sessionId, engine: engineId
    });
    return 'unprofiled-engine';
  }

  // Marked BEFORE the send, not after. `launch-unready` counts nudges after a
  // success because it is answering "was this session told"; this one is
  // answering "could a second turn ever be submitted", and the honest answer to
  // that has to be no even when the send is still in flight.
  _fired.add(sessionId);
  // Oldest-first, which is the order a Set iterates in.
  while (_fired.size > FIRED_MEMORY) _fired.delete(_fired.values().next().value);

  const typeable = await _awaitTypeable(tmuxName, profile, _internal.now() + IDLE_TIMEOUT_MS);
  if (!typeable.idle) {
    log.info('A launched session was not kicked off: its pane never became safe to type into', {
      session: sessionId, project: projectName, reason: typeable.reason
    });
    return 'pane-busy';
  }

  const sent = _internal.inject(projectName, kickoffLine(_internal.stepCount()), { sessionId });
  if (!sent.ok) {
    log.warn('Could not type the launch kickoff into the session pane', {
      session: sessionId, project: projectName, error: sent.error
    });
    return 'inject-failed';
  }

  log.info('Asked a launched session to read its launch context', {
    session: sessionId, project: projectName
  });
  // The activity entry records that the line was SENT. It deliberately claims
  // no more: typing bytes into a pane is not proof the engine consumed the
  // turn, and the receipt that settles that is the sequence's own `pagesServed`.
  _internal.logActivity({
    projectId,
    sessionId,
    eventType: 'launch.kickoff',
    detail: { observed: 'sent' }
  });
  return 'sent';
}

/**
 * Forget which sessions have been kicked off. For the tests, and for a caller
 * driving the module by hand.
 * @returns {void}
 */
function reset() {
  _fired.clear();
}

/**
 * Injectable seams, lazily required the way the other launch modules do it:
 * this module is reached from `lib/sessions.js`, which requires the store, the
 * wake monitor and tmux on its own.
 */
const _internal = {
  stepCount: () => require('./store').LAUNCH_STEP_IDS.length,
  wakeProfiles: () => require('./medusa-wake').ENGINE_WAKE_PROFILES,
  assessIdle: (opts) => require('./medusa-wake').assessSessionIdle(opts),
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  cursorInfo: (session) => require('./tmux').cursorInfo(session),
  inject: (projectName, command, options) => require('./sessions').injectCommand(projectName, command, options),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logActivity: (entry) => {
    try {
      require('./store').activity.log(entry);
    } catch (err) {
      // A timeline write must never be the reason a session goes unkicked.
      log.warn('launch-kickoff: failed to log an activity entry', { eventType: entry.eventType, error: err.message });
    }
  }
};

module.exports = {
  kickoff,
  kickoffLine,
  reset,
  FIRED_MEMORY,
  IDLE_POLL_MS,
  IDLE_TIMEOUT_MS,
  TMUX_TAIL_LINES,
  OUTCOME_MEANINGS,
  _awaitTypeable,
  _fired,
  _internal
};
