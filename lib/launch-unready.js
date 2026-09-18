'use strict';

/**
 * The unready-launch monitor (Train 21, car 21.5).
 *
 * A launch sequence is served on demand: TangleClaw hands out the steps when
 * the session asks for them, and until this monitor existed a session that
 * never asked was indistinguishable from one that read everything. The operator
 * was the transport — they noticed, or nobody did.
 *
 * Each tick this stamps the sequences whose window has passed with no
 * attestation, and nudges each one **once**, in its own pane.
 *
 * What it deliberately is not:
 * - **It is not a gate.** `unready_at` moves no cursor, requires no recovery,
 *   and takes nothing away from a later READY (plan §2.3). A launch is never
 *   blocked by it — that is R2, and it is the whole reason this is a monitor
 *   and not a check on the serving path.
 * - **It is not a retry loop.** `nudge_count` counts nudges SENT, on the
 *   sequence row rather than in the pruned activity log, and one is the budget.
 *   A session that ignores a nudge has been told; telling it again is noise the
 *   operator did not ask for.
 *
 * The idle gate is the wake monitor's (`medusaWake.assessSessionIdle`), not a
 * second one: deciding whether a pane is safe to type into is one question with
 * one answer, and `lib/sessions.js#_awaitPaneReady` already reuses it for the
 * prime paste. A pane that is not typeable is left alone and retried next tick.
 *
 * Lifecycle mirrors the other boot-time monitors (`wrap-sentinel`,
 * `medusa-wake`): `start()` arms a `setInterval` wired in `server.js`, `stop()`
 * clears it. The per-sequence state here is in-memory and ephemeral — the
 * durable facts (the stamp, the nudge count) are on the sequence row, so a
 * restart re-derives the rest rather than re-nudging.
 *
 * @module lib/launch-unready
 */

const { createLogger } = require('./logger');

const log = createLogger('launch-unready');

/**
 * Tick cadence. Short relative to the window (minutes) because the idle gate
 * needs consecutive observations to trust a pane, and a one-minute cadence
 * would turn that streak into a multi-minute wait after the window has already
 * passed.
 * @type {number}
 */
const DEFAULT_INTERVAL_MS = 15_000;

/** How many pane lines the idle gate reads, matching the wake monitor's window. */
const TMUX_TAIL_LINES = 15;

/**
 * What each tick's verdict means, keyed by the code the tick returns.
 *
 * Declared rather than left as bare strings: these are what the log and the
 * tests read, and a code with no meaning here is a state nobody can explain.
 * @type {Record<string, string>}
 */
const VERDICT_MEANINGS = Object.freeze({
  'within-window': 'the session still has time to attest; nothing is owed yet',
  nudged: 'the window passed and the session was nudged once, in its pane',
  'already-nudged': 'this launch has had its one nudge; the session owns it now',
  'no-project': 'the sequence names a project this install no longer has',
  'unreadable-created-at': 'the sequence has no readable creation time, so no window can be measured',
  'session-gone': 'the session ended between the query and this tick',
  'no-pane': 'the session has no tmux pane to nudge (a web UI session)',
  'unprofiled-engine': 'the engine has no live-probed pane signature, so nothing may be typed into it safely',
  'pane-capture-failed': 'the pane could not be read this tick; the next tick tries again',
  'pane-busy': 'the pane is working or holds unsent input; the next tick tries again',
  'inject-failed': 'typing the nudge into the pane failed; the next tick tries again'
});

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/**
 * Per-sequence monitor state, keyed by sequence id. Ephemeral: every durable
 * fact lives on the sequence row.
 * @type {Map<number, {idleTicks: number, prevDigest: (string|undefined), warnedCreatedAt: boolean,
 *   warnedWindow: boolean, loggedUnprofiled: boolean, cursorWarnLogged: boolean}>}
 */
const _sequences = new Map();

/**
 * The nudge line, containing only TangleClaw-controlled bytes.
 *
 * One line with no embedded newlines: `tmux.sendKeys` sends a single Enter
 * after the whole line, so a second line would submit half a sentence.
 * @param {object} sequence - The sequence row
 * @param {number} stepCount - How many steps the sequence has
 * @returns {string}
 */
function nudgeLine(sequence, stepCount) {
  const attest = '`tc start ready --verdict <the preflight verdict step 3 stated> '
    + '--first-action "<what you propose to do first>"`';

  // #1599 — two shapes, because the cursor decides which is true. With every
  // step acknowledged, the old single sentence contradicted its own number
  // ("not acknowledged: 4 of 4") and sent the session back to re-read steps it
  // had already read. A nudge that describes a state it did not observe is the
  // exact failure this train exists to end.
  if (sequence.cursor >= stepCount) {
    return `[TangleClaw] Every step of your launch context is acknowledged (${stepCount} of ${stepCount}), `
      + `but you have not attested yet. Attest with ${attest}. `
      + 'Attesting records that the context arrived and was read; it authorizes nothing. '
      + 'There is nothing to re-read: if you cannot attest, say why.';
  }
  return `[TangleClaw] Your launch context is not acknowledged: ${sequence.cursor} of ${stepCount} step(s). `
    + 'Read each step with `tc start next` and acknowledge it with the command that step prints, then attest with '
    + `${attest}. `
    + 'Attesting records that the context arrived and was read; it authorizes nothing. '
    + 'If you cannot read the steps, say so rather than working from context you never received.';
}

/**
 * Judge one unready sequence and act on it.
 * @param {object} sequence - A row from `listUnready`
 * @param {number} now - The tick's clock reading, in ms
 * @returns {string} A code from `VERDICT_MEANINGS`
 */
function _judge(sequence, now) {
  let st = _sequences.get(sequence.id);
  if (!st) {
    // One flag per message, not one shared flag: a single `logged` boolean lets
    // whichever condition fires first silence the others for the whole launch.
    st = {
      idleTicks: 0, prevDigest: undefined,
      warnedCreatedAt: false, warnedWindow: false, loggedUnprofiled: false, cursorWarnLogged: false
    };
    _sequences.set(sequence.id, st);
  }

  const project = _internal.getProject(sequence.projectId);
  if (!project) return 'no-project';

  const createdMs = _internal.parseSqliteUtcMs(sequence.createdAt);
  if (!Number.isFinite(createdMs)) {
    if (!st.warnedCreatedAt) {
      st.warnedCreatedAt = true;
      log.warn('A launch sequence has no readable creation time, so its window cannot be measured', {
        sequence: sequence.id, createdAt: sequence.createdAt
      });
    }
    return 'unreadable-created-at';
  }
  const window = _internal.resolveUnreadyWindow(_internal.loadProjectConfig(project.path));
  if (window.warning && !st.warnedWindow) {
    st.warnedWindow = true;
    log.warn('Project config falls back for the unready window', { project: project.name, warning: window.warning });
  }
  if (now - createdMs < window.ms) return 'within-window';

  // The stamp comes first and unconditionally: it is the observation, and it
  // must not depend on whether a pane happens to be typeable. A session whose
  // pane can never be typed into is exactly the one the operator most needs to
  // see on the dashboard.
  if (_internal.markUnready(sequence.id)) {
    log.info('A launched session has not attested its context within the window', {
      sequence: sequence.id, session: sequence.sessionId, project: project.name, minutes: window.minutes
    });
    _internal.logActivity({
      projectId: sequence.projectId,
      sessionId: sequence.sessionId,
      eventType: 'launch.unready',
      detail: { sequenceId: sequence.id, windowMinutes: window.minutes, cursor: sequence.cursor }
    });
  }

  if (sequence.nudgeCount > 0) return 'already-nudged';

  const session = _internal.getSession(sequence.sessionId);
  if (!session) return 'session-gone';
  if (session.sessionMode === 'webui' || !session.tmuxSession) return 'no-pane';

  const profile = _internal.wakeProfiles()[session.engineId];
  if (!profile) {
    if (!st.loggedUnprofiled) {
      st.loggedUnprofiled = true;
      log.info('An unready session cannot be nudged: its engine has no probed pane signature', {
        sequence: sequence.id, engine: session.engineId
      });
    }
    return 'unprofiled-engine';
  }

  let captured;
  try {
    captured = _internal.capturePane(session.tmuxSession, { lines: TMUX_TAIL_LINES });
  } catch {
    // The pane vanished mid-poll (a session dying). The prune pass below drops
    // its state once the sequence stops being listed.
    st.idleTicks = 0;
    return 'pane-capture-failed';
  }
  let cursor = null;
  try {
    cursor = _internal.cursorInfo(session.tmuxSession);
  } catch (err) {
    // Best-effort, never fatal: a pane that cannot report a cursor is still
    // judged by the weaker text check rather than losing its nudge to a tmux
    // query that failed while the pane itself read fine.
    if (!st.cursorWarnLogged) {
      st.cursorWarnLogged = true;
      log.warn('Cursor probe failed for an unready session — falling back to the text prompt check', {
        sequence: sequence.id, error: err.message
      });
    }
  }
  const verdict = _internal.assessIdle({
    lines: (captured && captured.lines) || [], profile, cursor, prevDigest: st.prevDigest, idleTicks: st.idleTicks
  });
  st.prevDigest = verdict.digest;
  st.idleTicks = verdict.idleTicks;
  if (!verdict.idle) {
    // One code, because every one of these is the same answer to the operator:
    // not typed into, try again. Which gate held it is a debug fact, not a state.
    log.debug('An unready session was not nudged this tick', { sequence: sequence.id, reason: verdict.reason });
    return 'pane-busy';
  }

  const sent = _internal.inject(project.name, nudgeLine(sequence, _internal.stepCount()), { sessionId: sequence.sessionId });
  if (!sent.ok) {
    log.warn('Could not type the unready nudge into the session pane', {
      sequence: sequence.id, project: project.name, error: sent.error
    });
    return 'inject-failed';
  }
  // Counted only after a successful send: the count answers "was this session
  // told", and a failed paste told it nothing.
  _internal.recordNudge(sequence.id);
  st.idleTicks = 0;
  log.info('Nudged a session that had not attested its launch context', {
    sequence: sequence.id, session: sequence.sessionId, project: project.name
  });
  _internal.logActivity({
    projectId: sequence.projectId,
    sessionId: sequence.sessionId,
    eventType: 'launch.nudged',
    detail: { sequenceId: sequence.id, cursor: sequence.cursor }
  });
  return 'nudged';
}

/**
 * One pass over the unready sequences of live sessions.
 * @param {number} [now] - The clock reading to judge against
 * @returns {Record<number, string>} The verdict per sequence id, for the tests
 *   and for a caller driving the monitor by hand
 */
function tick(now = Date.now()) {
  const verdicts = {};
  const seen = new Set();
  for (const sequence of _internal.listUnready()) {
    seen.add(sequence.id);
    try {
      verdicts[sequence.id] = _judge(sequence, now);
    // prawduct:allow prawduct/broad-except -- one sequence must not stop the pass; the next tick retries it
    } catch (err) {
      log.warn('Unready check failed for one launch sequence', { sequence: sequence.id, error: err.message });
      verdicts[sequence.id] = 'pane-capture-failed';
    }
  }
  // Sequences that attested, or whose session ended, stop being listed — their
  // in-memory state goes with them rather than accumulating for the process's life.
  for (const id of [..._sequences.keys()]) {
    if (!seen.has(id)) _sequences.delete(id);
  }
  return verdicts;
}

/**
 * Start the monitor. Idempotent — a second call while running is a no-op.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=15000] - Tick cadence
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => {
    try {
      tick();
    // prawduct:allow prawduct/broad-except -- a monitor tick must never take the server down
    } catch (err) {
      log.warn('launch-unready: tick error', { error: err.message });
    }
  }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('launch-unready monitor started', { intervalMs });
}

/**
 * Stop the monitor and forget its in-memory state.
 * @returns {void}
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _sequences.clear();
}

/**
 * Injectable seams, lazily required the way the other monitors do it: this
 * module is required by `server.js` at load, and `lib/sessions.js` requires the
 * store, the wake monitor and the engines table on its own.
 */
const _internal = {
  listUnready: () => require('./store').launchSequences.listUnreadyOfActiveSessions(),
  getProject: (projectId) => require('./store').projects.get(projectId),
  getSession: (sessionId) => require('./store').sessions.get(sessionId),
  loadProjectConfig: (projectPath) => require('./store').projectConfig.load(projectPath),
  resolveUnreadyWindow: (projConfig) => require('./project-config').resolveUnreadyWindow(projConfig),
  markUnready: (sequenceId) => require('./store').launchSequences.markUnready(sequenceId),
  recordNudge: (sequenceId) => require('./store').launchSequences.recordNudge(sequenceId),
  stepCount: () => require('./store').LAUNCH_STEP_IDS.length,
  logActivity: (entry) => {
    try {
      require('./store').activity.log(entry);
    } catch (err) {
      // A timeline write must never be the reason a nudge does not happen; the
      // invariants this monitor cares about live on the sequence row.
      log.warn('launch-unready: failed to log an activity entry', { eventType: entry.eventType, error: err.message });
    }
  },
  parseSqliteUtcMs: (value) => require('./sessions')._parseSqliteUtcMs(value),
  wakeProfiles: () => require('./medusa-wake').ENGINE_WAKE_PROFILES,
  assessIdle: (opts) => require('./medusa-wake').assessSessionIdle(opts),
  capturePane: (session, options) => require('./tmux').capturePane(session, options),
  cursorInfo: (session) => require('./tmux').cursorInfo(session),
  inject: (projectName, command, options) => require('./sessions').injectCommand(projectName, command, options)
};

module.exports = {
  start,
  stop,
  tick,
  nudgeLine,
  DEFAULT_INTERVAL_MS,
  TMUX_TAIL_LINES,
  VERDICT_MEANINGS,
  _internal
};
