'use strict';

/**
 * The workload nudge monitor (#2262).
 *
 * A lane's workload report expires by age (`lib/workload-compose.js#EXPIRY_MS`)
 * and the lane then reads UNKNOWN. Until this monitor existed nothing told the
 * session: a coordinator saw the lane go quiet and could not tell a session
 * that was working and forgot to report from one that had stopped.
 *
 * Each tick this looks at every live project session whose project turned the
 * monitor on, and types one fixed line into the pane of each whose newest
 * report expired, once per expired report.
 *
 * What it deliberately is not:
 * - **It is off unless a project turns it on** (`workloadNudge.enabled` in the
 *   project's own config). A project that says nothing is never typed into.
 * - **It is not a retry loop.** One line per expired report. The fact that the
 *   line was typed is a row in `workload_nudge_facts`, so a server restart
 *   does not type it again.
 * - **It decides nothing about workload.** Whether a report is current, and
 *   why not, is `lib/workload-fleet.js`'s one composition; this reads it.
 * - **It ends nothing.** It types a line. It never clears, restarts or closes
 *   a session.
 *
 * It types only into a pane the activity observer saw at rest. "Not busy" is
 * not enough: a pane that is neither busy nor at rest may be showing a
 * permission prompt or a menu, and a line ending in Enter answers it.
 *
 * Order of the two effects, chosen on purpose: the line is typed first and the
 * fact recorded after. The fact means "this session was told", and every
 * refusal to type (a held lane, a startup dialog, a pane that vanished) happens
 * inside the send, so a fact written first would claim a nudge that never
 * reached anyone and could never be withdrawn from an append-only table. The
 * cost is the case where the line was typed and the write then failed: this
 * process remembers the receipt, never types for it again, and writes the fact
 * on a later tick. Only a server restart while the store still refuses the
 * write can lead to a second line for one expiry.
 *
 * Lifecycle mirrors `lib/launch-unready.js`: `start()` arms a `setInterval`
 * wired in `server.js`, `stop()` clears it.
 *
 * @module lib/workload-nudge
 */

const { createLogger } = require('./logger');

const log = createLogger('workload-nudge');

/**
 * Tick cadence. An expiry is measured in tens of minutes, so half a minute of
 * lateness is invisible, and each tick reads every enabled project's config
 * file from disk.
 * @type {number}
 */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * The line typed when a project sets no text of its own. One line with no
 * newline: the pane writer sends one Enter after the whole line, so a second
 * line would submit half a sentence.
 * @type {string}
 */
const DEFAULT_NUDGE_TEXT = '[TangleClaw] Your workload report has expired, so coordinators now read this lane as UNKNOWN. '
  + 'Report what you are doing with `tc workload set <working|waiting-external|blocked|complete> '
  + '--clearance <safe-to-clear|do-not-clear|unknown> --summary "<one line>"`. '
  + 'This is a reminder, sent once for this report; it changes nothing about your task.';

/**
 * What each verdict means, keyed by the code the judge returns. Declared
 * rather than left as bare strings: these are what the log, the record and the
 * tests read, and a code with no meaning here is a state nobody can explain.
 * @type {Record<string, string>}
 */
const VERDICT_MEANINGS = Object.freeze({
  'monitor-off': 'the project has not turned the workload nudge on, so its sessions are never typed into',
  'no-project': 'the session names a project this install no longer has',
  'session-not-active': 'the session is no longer active',
  'unsupported-lane': 'this kind of lane has no workload report to expire (a Project Master lane)',
  'no-receipt': 'the session has written no workload report in this launch; this monitor acts only on a report that expired',
  'receipt-current': 'the newest workload report is still current; nothing is owed',
  'stale-not-expired': 'the newest report stopped counting for a reason other than its age (a wrap started, a control event, another launch), so no reminder is due',
  'already-nudged': 'this expired report has had its one nudge; the session owns it now',
  'no-pane': 'the session has no tmux pane to type into (a web UI session)',
  'unprofiled-engine': 'the engine has no live-probed pane signature, so nothing may be typed into it safely',
  'wrap-running': 'a wrap is running in this session, so nothing is typed into it; the next tick checks again',
  'engine-busy': 'the engine was observed working; the next tick checks again',
  'engine-not-at-rest': 'the pane was observed neither working nor at rest (a prompt, a menu or unsent input); the next tick checks again',
  'engine-unknown': 'the engine could not be observed, so the pane is not typed into; the next tick checks again',
  'lane-held': 'the lane is held or stopped by its control assignment, so nothing is typed into it; the next tick checks again',
  'startup-dialog': 'the pane shows an engine startup dialog, which takes no typed text; the next tick checks again',
  'send-failed': 'typing the nudge into the pane failed; the next tick tries again',
  nudged: 'the report expired and the session was nudged once, in its pane',
  'nudged-unrecorded': 'the nudge was typed but its record could not be written; the write is retried each tick and the pane is not typed into again',
  'check-failed': 'the check for this session threw; the next tick tries again'
});

/** Bounds of the record's two observer columns (`workload_nudge_facts`). */
const ENGINE_ACTIVITY_MAX = 32;
const ENGINE_REASON_MAX = 64;

/** What a lane reads as when the monitor was started without an observer. */
const NO_OBSERVER = Object.freeze({
  get: () => ({ activity: 'unknown', reason: 'not-observed', observedAt: null, ageSeconds: null, provenance: 'engine-observed' })
});

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/** @type {{get: function(number, number=): object}} */
let _observer = NO_OBSERVER;

/**
 * Per-session monitor state, keyed by session id. Ephemeral, with one
 * exception that matters: `unrecorded` is a nudge that was typed and whose
 * fact is not yet written, and it is what stops a second line while the store
 * refuses the write.
 * @type {Map<number, {warnedConfig: boolean, lastVerdict: (string|null), unrecorded: (object|null)}>}
 */
const _sessions = new Map();

/**
 * The line to type for a project's setting.
 * @param {{text: (string|null)}} setting - From `resolveWorkloadNudge`
 * @returns {string}
 */
function nudgeLine(setting) {
  return setting && typeof setting.text === 'string' ? setting.text : DEFAULT_NUDGE_TEXT;
}

/**
 * Write a nudge fact, reporting a refusal instead of throwing.
 * @param {object} row - The fact, as `store.workloadNudgeFacts.record` takes it
 * @returns {{ok: boolean, recorded: boolean, error: (string|null)}} `recorded` is false when the
 *   fact was already on record (another process, or an earlier tick)
 */
function _recordFact(row) {
  try {
    return { ok: true, recorded: _internal.recordFact(row).recorded, error: null };
  // prawduct:allow prawduct/broad-except -- a store write that fails must not lose the fact that the pane was already typed into; the caller keeps it and retries
  } catch (err) {
    return { ok: false, recorded: false, error: err.message };
  }
}

/**
 * Try again to write the fact of a nudge that was typed and not recorded.
 * @param {object} st - The session's monitor state
 * @returns {boolean} Whether a nudge is still unrecorded after the attempt
 */
function _retryUnrecorded(st) {
  if (!st.unrecorded) return false;
  const written = _recordFact(st.unrecorded);
  if (!written.ok) return true;
  log.info('Recorded a workload nudge whose record could not be written when it was typed', {
    session: st.unrecorded.session_id, project: st.unrecorded.project_id, receipt: st.unrecorded.receipt_id
  });
  st.unrecorded = null;
  return false;
}

/**
 * Judge one live session and act on it.
 * @param {object} session - A live session row
 * @param {number} now - The tick's clock reading, in ms
 * @returns {string} A code from `VERDICT_MEANINGS`
 */
function _judge(session, now) {
  let st = _sessions.get(session.id);
  if (!st) {
    st = { warnedConfig: false, lastVerdict: null, unrecorded: null };
    _sessions.set(session.id, st);
  }
  // Before anything else, and whatever the lane says now: the pane was typed
  // into, and that is owed a record even if the project has since turned the
  // monitor off or the session has reported again.
  const stillUnrecorded = _retryUnrecorded(st);

  const project = _internal.getProject(session.projectId);
  if (!project) return 'no-project';

  const setting = _internal.resolveSetting(_internal.loadProjectConfig(project.path));
  if (setting.warnings.length > 0 && !st.warnedConfig) {
    st.warnedConfig = true;
    // The resolver describes a bad value by type and length and never quotes
    // it, so these are safe to log as they are.
    log.warn('Project config falls back for the workload nudge', { project: project.name, warnings: setting.warnings });
  }
  if (!setting.enabled) return 'monitor-off';
  if (session.status !== _internal.activeStatus()) return 'session-not-active';

  const { lane, receiptId, launchId } = _internal.laneContext(session, project.name, now);
  if (lane.composed.reasons.includes('unsupported-master-lane')) return 'unsupported-lane';
  const receipt = lane.workload.receipt;
  if (!receipt || receiptId === null) return 'no-receipt';
  if (lane.workload.provenance !== 'stale') return 'receipt-current';
  if (lane.workload.staleReason !== 'expired') return 'stale-not-expired';

  if (st.unrecorded && st.unrecorded.receipt_id === receiptId) return stillUnrecorded ? 'nudged-unrecorded' : 'already-nudged';
  if (_internal.listFacts(receiptId).some((f) => f.kind === 'nudged')) return 'already-nudged';

  if (session.sessionMode === 'webui' || !session.tmuxSession) return 'no-pane';
  if (!_internal.wakeProfiles()[session.engineId]) return 'unprofiled-engine';
  // The pane writer does not refuse a pane running a wrap, so this monitor asks.
  if (_internal.wrapRunning(project.name)) return 'wrap-running';

  const activity = lane.engine ? lane.engine.activity : 'unknown';
  if (activity === 'busy') return 'engine-busy';
  if (activity !== 'at-rest') return activity === 'not-at-rest' ? 'engine-not-at-rest' : 'engine-unknown';

  const sent = _internal.inject(project.name, nudgeLine(setting), { sessionId: session.id });
  if (!sent.ok && sent.controlRefusal) return 'lane-held';
  if (!sent.ok && sent.startupDialog) return 'startup-dialog';
  if (!sent.ok) {
    log.warn('Could not type the workload nudge into the session pane', {
      session: session.id, project: project.name, receiptSeq: receipt.seq, error: sent.error
    });
    return 'send-failed';
  }

  const fact = {
    project_id: session.projectId,
    session_id: session.id,
    launch_id: launchId,
    receipt_id: receiptId,
    kind: 'nudged',
    code: 'nudged',
    engine_activity: String(activity).slice(0, ENGINE_ACTIVITY_MAX),
    engine_reason: lane.engine && lane.engine.reason ? String(lane.engine.reason).slice(0, ENGINE_REASON_MAX) : null,
    detail_json: JSON.stringify({ receiptSeq: receipt.seq, silentSeconds: lane.workload.ageSeconds }),
    created_at: new Date(now).toISOString()
  };
  const written = _recordFact(fact);
  if (!written.ok) {
    st.unrecorded = fact;
    log.error('A workload nudge was typed and its record could not be written; the write is retried each tick and the pane is not typed into again', {
      session: session.id, project: project.name, receiptSeq: receipt.seq, error: written.error
    });
    return 'nudged-unrecorded';
  }
  log.info('Nudged a session whose workload report expired', {
    session: session.id, project: project.name, receiptSeq: receipt.seq, silentSeconds: lane.workload.ageSeconds
  });
  return 'nudged';
}

/**
 * Say in the log what the judge decided for a session, when that changes.
 *
 * Without this a stale lane with no nudge on it cannot be explained: the
 * verdict is the only place that says which gate held it, and a tick's return
 * value reaches nobody. Logged on a change, so a lane waiting an hour at one
 * gate is one line. A project that never turned the monitor on is not logged
 * at all.
 * @param {object} session - The session judged
 * @param {string} verdict - A code from `VERDICT_MEANINGS`
 * @returns {void}
 */
function _logVerdictChange(session, verdict) {
  const st = _sessions.get(session.id);
  if (!st || st.lastVerdict === verdict) return;
  const first = st.lastVerdict === null;
  st.lastVerdict = verdict;
  if (first && verdict === 'monitor-off') return;
  log.info('Workload nudge verdict for a session', {
    session: session.id, projectId: session.projectId, verdict, meaning: VERDICT_MEANINGS[verdict]
  });
}

/**
 * One pass over the live project sessions.
 * @param {number} [now] - The clock reading to judge against
 * @returns {Record<number, string>} The verdict per session id, for the tests
 *   and for a caller driving the monitor by hand
 */
function tick(now = Date.now()) {
  const verdicts = {};
  const seen = new Set();
  for (const session of _internal.listSessions()) {
    seen.add(session.id);
    try {
      verdicts[session.id] = _judge(session, now);
    // prawduct:allow prawduct/broad-except -- one session must not stop the pass; the next tick retries it
    } catch (err) {
      log.warn('Workload nudge check failed for one session', { session: session.id, error: err.message });
      verdicts[session.id] = 'check-failed';
    }
    _logVerdictChange(session, verdicts[session.id]);
  }
  // A session that ended stops being listed, and its state goes with it rather
  // than accumulating for the life of the process.
  for (const [id, st] of [..._sessions]) {
    if (seen.has(id)) continue;
    if (st.unrecorded) {
      log.error('A session ended with a workload nudge typed and never recorded', {
        session: id, project: st.unrecorded.project_id, receipt: st.unrecorded.receipt_id
      });
    }
    _sessions.delete(id);
  }
  return verdicts;
}

/**
 * Start the monitor. Idempotent: a second call while running is a no-op.
 * @param {object} [opts]
 * @param {{get: function(number, number=): object}} [opts.observer] - The activity observer whose
 *   reading decides whether a pane may be typed into. Without one every lane reads unknown, and
 *   nothing is ever typed.
 * @param {number} [opts.intervalMs=30000] - Tick cadence
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  _observer = opts.observer || NO_OBSERVER;
  if (!opts.observer) log.warn('workload-nudge monitor started without an activity observer; it will type into nothing');
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => {
    try {
      tick();
    // prawduct:allow prawduct/broad-except -- a monitor tick must never take the server down
    } catch (err) {
      log.warn('workload-nudge: tick error', { error: err.message });
    }
  }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
  log.info('workload-nudge monitor started', { intervalMs });
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
  _observer = NO_OBSERVER;
  _sessions.clear();
}

/**
 * Injectable seams, lazily required the way the other monitors do it: this
 * module is required by `server.js` at load, before the store is initialized.
 */
const _internal = {
  listSessions: () => require('./store').sessions.listLiveAll(),
  getProject: (projectId) => require('./store').projects.get(projectId),
  activeStatus: () => require('./store').SESSION_STATUS.ACTIVE,
  loadProjectConfig: (projectPath) => require('./store').projectConfig.load(projectPath),
  resolveSetting: (projConfig) => require('./project-config').resolveWorkloadNudge(projConfig),
  laneContext: (session, projectName, nowMs) => require('./workload-fleet')
    .laneContext(session, { observer: _observer, projectName, nowMs }),
  listFacts: (receiptId) => require('./store').workloadNudgeFacts.listForReceipt(receiptId),
  recordFact: (row) => require('./store').workloadNudgeFacts.record(row),
  wakeProfiles: () => require('./medusa-wake').ENGINE_WAKE_PROFILES,
  wrapRunning: (projectName) => require('./wrap-run-registry').get(projectName).running,
  inject: (projectName, command, options) => require('./sessions').injectCommand(projectName, command, options)
};

module.exports = {
  start,
  stop,
  tick,
  nudgeLine,
  DEFAULT_INTERVAL_MS,
  DEFAULT_NUDGE_TEXT,
  VERDICT_MEANINGS,
  _internal
};
