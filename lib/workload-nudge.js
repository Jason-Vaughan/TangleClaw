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
 * report expired, once per expired report. A report that stays unanswered is
 * then escalated, once: one switchboard message to the project the lane's
 * config names as its coordinator.
 *
 * What it deliberately is not:
 * - **It is off unless a project turns it on** (`workloadNudge.enabled` in the
 *   project's own config). A project that says nothing is never typed into.
 * - **It is not a retry loop.** One line per expired report. The fact that the
 *   line was typed is a row in `workload_nudge_facts`, so a server restart
 *   does not type it again.
 * - **It decides nothing about workload.** Whether a report is current, and
 *   why not, is `lib/workload-fleet.js`'s one composition; this reads it.
 * - **It ends nothing.** It types a line and sends a message. It never clears,
 *   restarts or closes a session.
 * - **It infers no role.** The coordinator is whatever project the silent
 *   lane's own config names (`workloadNudge.coordinatorProject`). No project
 *   is a coordinator because of what it is called.
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
 * The escalation has the same two effects and the same order: the message is
 * sent first and `escalated` recorded after the Hub accepts it, so the record
 * never claims a coordinator was told who was not. A send that throws records
 * nothing and is tried again on the next tick; after `MAX_SEND_ATTEMPTS` in
 * this process the coordinator is recorded as unreachable. A message accepted
 * whose record then fails is remembered and written later, and is not sent
 * again by this process.
 *
 * A lane with nobody to tell (no coordinator named, the lane naming itself, a
 * name that matches no project, a coordinator with no live session, or one the
 * Hub would not take a message for) gets an `escalated` fact on the operator
 * route. Nothing reads that route yet: the fact is a record that the operator
 * is owed the news, and this module pushes it nowhere.
 *
 * A lane that could not be nudged is escalated too, once the same time has
 * passed since its report expired, with the reason it was not nudged. That
 * does not apply to a lane left alone on purpose: one that is held or stopped,
 * or running a wrap, is neither nudged nor escalated.
 *
 * The send is not awaited by the tick. The switchboard call has no timeout of
 * its own, and a Hub that hangs must not hold up every other lane's nudge.
 *
 * Lifecycle mirrors `lib/launch-unready.js`: `start()` arms a `setInterval`
 * wired in `server.js`, `stop()` clears it.
 *
 * @module lib/workload-nudge
 */

const { createLogger } = require('./logger');
const compose = require('./workload-compose');

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
  'escalation-sending': 'the nudge went unanswered, or the lane could not be nudged, for the set time; a message to its coordinator is on its way to the Hub',
  'already-escalated': 'this expired report has been escalated once; nothing more is sent or typed for it',
  'escalated-operator': 'the lane has no coordinator that can be told, so the escalation was recorded on the operator route; nothing is pushed on that route yet',
  'escalated-unrecorded': 'the coordinator was sent the escalation but its record could not be written; the write is retried each tick and the message is not sent again',
  'check-failed': 'the check for this session threw; the next tick tries again'
});

/**
 * What each escalation outcome means, keyed by the `code` its fact carries.
 * @type {Record<string, string>}
 */
const ESCALATION_MEANINGS = Object.freeze({
  escalated: 'the coordinator the lane names was sent one switchboard message',
  'no-coordinator': 'the lane names no coordinator',
  'coordinator-is-self': 'the lane names itself as its coordinator, so there is nobody else to tell',
  'coordinator-unknown-project': 'the coordinator the lane names is not a project on this install',
  'coordinator-no-live-session': 'the coordinator the lane names has no live session with a switchboard workspace',
  'coordinator-send-failed': 'the Hub did not take a message for the coordinator in any attempt this server made'
});

/**
 * Verdicts under which a lane is left alone on purpose. Such a lane is not
 * escalated either: whoever held it, or started its wrap, already knows why it
 * is quiet.
 * @type {ReadonlySet<string>}
 */
const DELIBERATE = Object.freeze(new Set(['wrap-running', 'lane-held']));

/**
 * How many times one server process offers an escalation to the Hub before it
 * records the coordinator as unreachable. Unbounded, a Hub that is down for
 * the night would mean a silent lane is never recorded as anybody's to hear
 * about, which is the night this exists for.
 * @type {number}
 */
const MAX_SEND_ATTEMPTS = 5;

/** Bounds of the record's columns (`workload_nudge_facts`), and of a name kept in its detail. */
const ENGINE_ACTIVITY_MAX = 32;
const ENGINE_REASON_MAX = 64;
const COORDINATOR_NAME_MAX = 200;

/** What a lane reads as when the monitor was started without an observer. */
const NO_OBSERVER = Object.freeze({
  get: () => ({ activity: 'unknown', reason: 'not-observed', observedAt: null, ageSeconds: null, provenance: 'engine-observed' })
});

/** @type {NodeJS.Timeout|null} */
let _timer = null;

/** @type {{get: function(number, number=): object}} */
let _observer = NO_OBSERVER;

/**
 * Escalation sends the Hub has not answered yet. Kept so a caller that drives
 * the monitor by hand can wait for them ({@link settled}).
 * @type {Set<Promise<void>>}
 */
const _inFlight = new Set();

/**
 * Per-session monitor state, keyed by session id. Ephemeral, with one
 * exception that matters: `owed` holds each fact whose effect already happened
 * (a line typed, a message accepted) and whose row is not yet written. It is
 * what stops a second line or a second message while the store refuses the
 * write. `escalation` counts this process's attempts to reach the coordinator
 * for one receipt.
 * @type {Map<number, {warnedConfig: boolean, lastVerdict: (string|null), projectName: (string|null),
 *   owed: object[], escalation: ({receiptId: number, sending: boolean, failures: number}|null)}>}
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
 * Why a lane was not nudged, as a clause for a sentence: the verdict's declared
 * meaning without its "the next tick checks again" tail, which is about the
 * monitor and not about the lane.
 * @param {string} code - A code from `VERDICT_MEANINGS`
 * @returns {string}
 */
function _whyNotNudged(code) {
  return String(VERDICT_MEANINGS[code] || code).split(';')[0];
}

/**
 * The message a coordinator is sent about a silent lane. A fixed template over
 * values this module resolved: nothing a session wrote (a report's summary,
 * the project's nudge text) can reach it.
 * @param {object} v
 * @param {string} v.projectName - The silent lane's project
 * @param {number} v.silentMinutes - Minutes since its last report
 * @param {string} v.activity - The observer's reading of its engine
 * @param {string|null} v.reason - The observer's reason code
 * @param {number|null} v.nudgedMinutesAgo - Minutes since it was nudged, or null if it was not
 * @param {string|null} v.notNudgedCode - Why it was not nudged, when it was not
 * @returns {string} One paragraph, no newline
 */
function escalationBody({ projectName, silentMinutes, activity, reason, nudgedMinutesAgo, notNudgedCode }) {
  const told = nudgedMinutesAgo === null
    ? `It was not nudged: ${_whyNotNudged(notNudgedCode)}.`
    : `It was nudged in its pane ${nudgedMinutesAgo} minute(s) ago and has not answered.`;
  return `[TangleClaw] Lane "${projectName}" has not reported its workload for ${silentMinutes} minute(s): `
    + `its last report expired and no new one has arrived. ${told} `
    + `Its engine was last observed ${activity}${reason ? ` (${reason})` : ''}. `
    + 'TangleClaw has restarted, cleared and ended nothing. `tc sessions` shows the lane. '
    + 'This notice is sent once for this report and needs no reply.';
}

/**
 * A session's monitor state, made on first sight.
 * @param {number} sessionId - Session id
 * @returns {object}
 */
function _stateFor(sessionId) {
  let st = _sessions.get(sessionId);
  if (!st) {
    st = { warnedConfig: false, lastVerdict: null, projectName: null, owed: [], escalation: null };
    _sessions.set(sessionId, st);
  }
  return st;
}

/**
 * This process's attempts to reach the coordinator for one receipt. A new
 * receipt starts a new count.
 * @param {object} st - The session's monitor state
 * @param {number} receiptId - The expired receipt
 * @returns {{receiptId: number, sending: boolean, failures: number}}
 */
function _escalationState(st, receiptId) {
  if (!st.escalation || st.escalation.receiptId !== receiptId) st.escalation = { receiptId, sending: false, failures: 0 };
  return st.escalation;
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
  // prawduct:allow prawduct/broad-except -- a store write that fails must not lose the fact that the pane was typed into or the message sent; the caller keeps it and retries
  } catch (err) {
    return { ok: false, recorded: false, error: err.message };
  }
}

/**
 * Try again to write each fact whose effect happened and whose row is owed.
 * @param {object} st - The session's monitor state
 * @returns {void}
 */
function _retryOwed(st) {
  st.owed = st.owed.filter((fact) => {
    if (!_recordFact(fact).ok) return true;
    log.info('Recorded a workload nudge fact whose record could not be written when it happened', {
      session: fact.session_id, project: fact.project_id, receipt: fact.receipt_id, kind: fact.kind
    });
    return false;
  });
}

/**
 * The fact of a kind this session still owes the record for a receipt.
 * @param {object} st - The session's monitor state
 * @param {number} receiptId - The expired receipt
 * @param {string} kind - `nudged` or `escalated`
 * @returns {object|undefined}
 */
function _owes(st, receiptId, kind) {
  return st.owed.find((f) => f.receipt_id === receiptId && f.kind === kind);
}

/**
 * A fact about this lane's expired receipt, with what the observer said now.
 * @param {object} ctx - From {@link _context}
 * @param {object} fields - `kind`, `code`, and the route, target and detail the kind takes
 * @returns {object} A row for `store.workloadNudgeFacts.record`
 */
function _fact(ctx, fields) {
  const engine = ctx.lane.engine || {};
  return {
    project_id: ctx.session.projectId,
    session_id: ctx.session.id,
    launch_id: ctx.launchId,
    receipt_id: ctx.receiptId,
    engine_activity: String(engine.activity || 'unknown').slice(0, ENGINE_ACTIVITY_MAX),
    engine_reason: engine.reason ? String(engine.reason).slice(0, ENGINE_REASON_MAX) : null,
    created_at: new Date(ctx.now).toISOString(),
    ...fields
  };
}

/**
 * Everything the two stages decide from, or the verdict that ends the check
 * before either: a lane this monitor has nothing to say about.
 * @param {object} session - A live session row
 * @param {object} st - Its monitor state
 * @param {number} now - The tick's clock reading, in ms
 * @returns {{verdict: string}|object} A verdict, or the lane's context: `session`, `st`, `now`,
 *   `project`, `setting`, `lane`, `receipt`, `receiptId`, `launchId`, `facts`
 */
function _context(session, st, now) {
  const project = _internal.getProject(session.projectId);
  if (!project) return { verdict: 'no-project' };
  st.projectName = project.name;

  const setting = _internal.resolveSetting(_internal.loadProjectConfig(project.path));
  if (setting.warnings.length > 0 && !st.warnedConfig) {
    st.warnedConfig = true;
    // The resolver describes a bad value by type and length and never quotes
    // it, so these are safe to log as they are.
    log.warn('Project config falls back for the workload nudge', { project: project.name, warnings: setting.warnings });
  }
  if (!setting.enabled) return { verdict: 'monitor-off' };
  if (session.status !== _internal.activeStatus()) return { verdict: 'session-not-active' };

  const { lane, receiptId, launchId } = _internal.laneContext(session, project.name, now);
  if (lane.composed.reasons.includes('unsupported-master-lane')) return { verdict: 'unsupported-lane' };
  const receipt = lane.workload.receipt;
  if (!receipt || receiptId === null) return { verdict: 'no-receipt' };
  if (lane.workload.provenance !== 'stale') return { verdict: 'receipt-current' };
  if (lane.workload.staleReason !== 'expired') return { verdict: 'stale-not-expired' };

  return { session, st, now, project, setting, lane, receipt, receiptId, launchId, facts: _internal.listFacts(receiptId) };
}

/**
 * Whether the lane is held or stopped by its control assignment.
 * @param {object} lane - The composed lane
 * @returns {boolean}
 */
function _laneHeld(lane) {
  return lane.composed.availability === compose.AVAILABILITY.HELD || lane.composed.availability === compose.AVAILABILITY.STOPPED;
}

/**
 * Decide whether the lane's pane may be typed into now. Decides only.
 * @param {object} ctx - From {@link _context}
 * @returns {string|null} The verdict that holds the nudge back, or null when the line may be typed
 */
function _nudgeGate(ctx) {
  const { session, st, project, lane, receiptId, facts } = ctx;
  if (_owes(st, receiptId, 'nudged')) return 'nudged-unrecorded';
  if (facts.some((f) => f.kind === 'nudged')) return 'already-nudged';
  // A lane escalated without a nudge is not nudged afterwards: its coordinator
  // was told it was not, and a line typed later would make the record read as
  // if the lane had been told first and ignored it.
  if (_owes(st, receiptId, 'escalated')) return 'escalated-unrecorded';
  if (facts.some((f) => f.kind === 'escalated')) return 'already-escalated';

  if (session.sessionMode === 'webui' || !session.tmuxSession) return 'no-pane';
  if (!_internal.wakeProfiles()[session.engineId]) return 'unprofiled-engine';
  // The pane writer does not refuse a pane running a wrap, so this monitor asks.
  if (_internal.wrapRunning(project.name)) return 'wrap-running';
  if (_laneHeld(lane)) return 'lane-held';

  const activity = lane.engine ? lane.engine.activity : 'unknown';
  if (activity === 'busy') return 'engine-busy';
  if (activity !== 'at-rest') return activity === 'not-at-rest' ? 'engine-not-at-rest' : 'engine-unknown';
  return null;
}

/**
 * Type the nudge and record it, in that order.
 * @param {object} ctx - From {@link _context}, for a lane {@link _nudgeGate} let through
 * @returns {string} `nudged`, `nudged-unrecorded`, or the pane writer's refusal
 */
function _nudge(ctx) {
  const { session, st, project, setting, lane, receipt } = ctx;
  const sent = _internal.inject(project.name, nudgeLine(setting), { sessionId: session.id });
  if (!sent.ok && sent.controlRefusal) return 'lane-held';
  if (!sent.ok && sent.startupDialog) return 'startup-dialog';
  if (!sent.ok) {
    log.warn('Could not type the workload nudge into the session pane', {
      session: session.id, project: project.name, receiptSeq: receipt.seq, error: sent.error
    });
    return 'send-failed';
  }

  const fact = _fact(ctx, {
    kind: 'nudged',
    code: 'nudged',
    detail_json: JSON.stringify({ receiptSeq: receipt.seq, silentSeconds: lane.workload.ageSeconds })
  });
  const written = _recordFact(fact);
  if (!written.ok) {
    st.owed.push(fact);
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
 * When the escalation falls due: the set time after the nudge, or, for a lane
 * that was never nudged, the same time after its report expired.
 * @param {object} ctx - From {@link _context}
 * @param {object|undefined} nudged - The lane's `nudged` fact, on record or owed
 * @returns {number} Epoch ms
 */
function _escalationDueAt(ctx, nudged) {
  const afterMs = ctx.setting.escalateAfterMs;
  const nudgedAt = nudged ? compose.parseTime(nudged.created_at) : NaN;
  if (Number.isFinite(nudgedAt)) return nudgedAt + afterMs;
  const reportedAt = ctx.now - ctx.lane.workload.ageSeconds * 1000;
  return reportedAt + compose.EXPIRY_MS[ctx.receipt.state] + afterMs;
}

/**
 * Who the escalation goes to. Decides only.
 * @param {object} ctx - From {@link _context}
 * @param {{failures: number}} attempts - This process's attempts for the receipt
 * @returns {{workspace: string, coordinator: object}|{code: string, coordinator?: object, named?: string, known?: boolean}}
 *   A workspace to send to; or the `ESCALATION_MEANINGS` code for why there is none, with the
 *   coordinator project when the name resolved, `named` when a name was given, and `known` when
 *   the record already says the coordinator could not be reached
 */
function _coordinator(ctx, attempts) {
  const { project, setting, facts } = ctx;
  const unreachable = facts.find((f) => f.kind === 'escalation-undeliverable' && f.route === 'coordinator');
  if (unreachable) return { code: unreachable.code, known: true };

  const named = setting.coordinatorProject;
  if (!named) return { code: 'no-coordinator' };
  const coordinator = _internal.getProjectByName(named);
  if (named === project.name || (coordinator && coordinator.id === project.id)) return { code: 'coordinator-is-self' };
  if (!coordinator) return { code: 'coordinator-unknown-project', named };
  if (attempts.failures >= MAX_SEND_ATTEMPTS) return { code: 'coordinator-send-failed', coordinator, named };
  const workspace = _internal.workspaceForProject(coordinator);
  if (!workspace) return { code: 'coordinator-no-live-session', coordinator, named };
  return { workspace, coordinator };
}

/**
 * Send the escalation and, once the Hub accepts it, record it. Not awaited:
 * the outcome lands in the record and the log, and the next tick reads it.
 * @param {object} ctx - From {@link _context}
 * @param {{sending: boolean, failures: number}} attempts - This process's attempts for the receipt
 * @param {{workspace: string, coordinator: object}} target - From {@link _coordinator}
 * @param {object} said - The values for {@link escalationBody}
 * @returns {void}
 */
function _sendEscalation(ctx, attempts, target, said) {
  const { session, st, project, lane, receipt } = ctx;
  const names = { session: session.id, project: project.name, receiptSeq: receipt.seq, coordinator: target.coordinator.name };
  attempts.sending = true;
  const sending = Promise.resolve()
    .then(() => _internal.sendMessage({ to: target.workspace, message: escalationBody(said) }))
    .then((sent) => {
      const fact = _fact(ctx, {
        kind: 'escalated',
        route: 'coordinator',
        target_project_id: target.coordinator.id,
        code: 'escalated',
        detail_json: JSON.stringify({
          receiptSeq: receipt.seq,
          silentSeconds: lane.workload.ageSeconds,
          nudged: said.nudgedMinutesAgo !== null,
          hubStatus: sent && sent.status ? String(sent.status).slice(0, 20) : null
        })
      });
      const written = _recordFact(fact);
      if (written.ok) {
        log.info('Escalated a silent lane to its coordinator', names);
        return;
      }
      st.owed.push(fact);
      log.error('A silent lane was escalated and the record could not be written; the write is retried each tick and the message is not sent again', {
        ...names, error: written.error
      });
    }, (err) => {
      attempts.failures += 1;
      log.warn('Could not send a silent lane\'s escalation to its coordinator; the next tick tries again', {
        ...names, attempt: attempts.failures, of: MAX_SEND_ATTEMPTS, error: err.message
      });
    })
    // prawduct:allow prawduct/broad-except -- nothing awaits this promise, so a throw from its own handlers would be an unhandled rejection
    .catch((err) => log.error('The workload escalation handler threw', { ...names, error: err.message }))
    .finally(() => {
      attempts.sending = false;
      _inFlight.delete(sending);
    });
  _inFlight.add(sending);
}

/**
 * Record that a lane has nobody to be told about it: the reason the named
 * coordinator could not be reached, when one was named, and the escalation on
 * the operator route. Nothing is sent.
 * @param {object} ctx - From {@link _context}
 * @param {{code: string, coordinator?: object, named?: string, known?: boolean}} target - From {@link _coordinator}
 * @returns {void}
 * @throws {Error} When the store refuses a write; the tick reports the check failed and the next one retries
 */
function _recordOperatorRoute(ctx, target) {
  const { session, project, lane, receipt } = ctx;
  const detail = JSON.stringify({
    receiptSeq: receipt.seq,
    silentSeconds: lane.workload.ageSeconds,
    ...(target.named ? { coordinator: String(target.named).slice(0, COORDINATOR_NAME_MAX) } : {})
  });
  if (target.named && !target.known) {
    _internal.recordFact(_fact(ctx, {
      kind: 'escalation-undeliverable',
      route: 'coordinator',
      target_project_id: target.coordinator ? target.coordinator.id : null,
      code: target.code,
      detail_json: detail
    }));
  }
  const written = _internal.recordFact(_fact(ctx, { kind: 'escalated', route: 'operator', code: target.code, detail_json: detail }));
  if (!written.recorded) return;
  log.warn('A silent lane has no coordinator that can be told; recorded on the operator route, which pushes nothing yet', {
    session: session.id, project: project.name, receiptSeq: receipt.seq, code: target.code, meaning: ESCALATION_MEANINGS[target.code]
  });
}

/**
 * Decide whether the lane's silence is due for escalation, and escalate it.
 * @param {object} ctx - From {@link _context}
 * @param {string} held - Why the lane was not nudged on this tick: a gate's verdict, the pane
 *   writer's refusal, or `already-nudged`
 * @returns {string} A code from `VERDICT_MEANINGS`; `held` itself while nothing is due
 */
function _escalate(ctx, held) {
  const { st, project, lane, receiptId, facts, now } = ctx;
  if (_owes(st, receiptId, 'escalated')) return 'escalated-unrecorded';
  if (facts.some((f) => f.kind === 'escalated')) return 'already-escalated';
  if (DELIBERATE.has(held)) return held;
  // A lane nudged earlier never reaches the nudge's own gates again, so the two
  // deliberate holds are asked about here as well.
  if (_internal.wrapRunning(project.name)) return 'wrap-running';
  if (_laneHeld(lane)) return 'lane-held';

  const nudged = facts.find((f) => f.kind === 'nudged') || _owes(st, receiptId, 'nudged');
  if (now < _escalationDueAt(ctx, nudged)) return held;
  const attempts = _escalationState(st, receiptId);
  if (attempts.sending) return 'escalation-sending';

  // One row per receipt says why it was never nudged: the reason at the moment
  // the escalation fell due, not one row per tick it waited.
  if (!nudged) {
    _internal.recordFact(_fact(ctx, {
      kind: 'not-nudged', code: held, detail_json: JSON.stringify({ receiptSeq: ctx.receipt.seq, silentSeconds: lane.workload.ageSeconds })
    }));
  }

  const target = _coordinator(ctx, attempts);
  if (!target.workspace) {
    _recordOperatorRoute(ctx, target);
    return 'escalated-operator';
  }
  const nudgedAt = nudged ? compose.parseTime(nudged.created_at) : NaN;
  _sendEscalation(ctx, attempts, target, {
    projectName: project.name,
    silentMinutes: Math.round(lane.workload.ageSeconds / 60),
    activity: lane.engine ? lane.engine.activity : 'unknown',
    reason: lane.engine && lane.engine.reason ? lane.engine.reason : null,
    nudgedMinutesAgo: Number.isFinite(nudgedAt) ? Math.max(0, Math.round((now - nudgedAt) / 60_000)) : null,
    notNudgedCode: nudged ? null : held
  });
  return 'escalation-sending';
}

/**
 * Judge one live session and act on it: the nudge first, and the escalation
 * only on a tick that typed nothing.
 * @param {object} session - A live session row
 * @param {number} now - The tick's clock reading, in ms
 * @returns {string} A code from `VERDICT_MEANINGS`
 */
function _judge(session, now) {
  const st = _stateFor(session.id);
  // Before anything else, and whatever the lane says now: an effect that
  // happened is owed a record even if the project has since turned the monitor
  // off or the session has reported again.
  _retryOwed(st);

  const ctx = _context(session, st, now);
  if (ctx.verdict) return ctx.verdict;

  const gate = _nudgeGate(ctx);
  const held = gate === null ? _nudge(ctx) : gate;
  if (gate === null && (held === 'nudged' || held === 'nudged-unrecorded')) return held;
  return _escalate(ctx, held);
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
    session: session.id, project: st.projectName, projectId: session.projectId, verdict, meaning: VERDICT_MEANINGS[verdict]
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
    for (const fact of st.owed) {
      log.error('A session ended with a workload nudge fact that happened and was never recorded', {
        session: id, project: fact.project_id, receipt: fact.receipt_id, kind: fact.kind
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
 * Wait for every escalation send in flight to be answered and recorded. For a
 * caller driving the monitor by hand; the timer never waits.
 * @returns {Promise<void>}
 */
async function settled() {
  while (_inFlight.size > 0) await Promise.allSettled([..._inFlight]);
}

/**
 * Stop the monitor and forget its in-memory state. A send already with the Hub
 * still records its outcome when the Hub answers.
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
  inject: (projectName, command, options) => require('./sessions').injectCommand(projectName, command, options),
  getProjectByName: (name) => require('./store').projects.getByName(name),
  /**
   * The switchboard workspace of a project's live session, or null.
   * @param {{id: number, path: string}} project - The coordinator project
   * @returns {string|null}
   */
  workspaceForProject: (project) => {
    const active = require('./store').sessions.getActive(project.id);
    return active ? require('./medusa-registry').getWorkspaceId(project.path, active.id) : null;
  },
  sendMessage: (m) => require('./medusa').sendSystemMessage(m)
};

module.exports = {
  start,
  stop,
  tick,
  settled,
  nudgeLine,
  escalationBody,
  DEFAULT_INTERVAL_MS,
  DEFAULT_NUDGE_TEXT,
  MAX_SEND_ATTEMPTS,
  VERDICT_MEANINGS,
  ESCALATION_MEANINGS,
  _internal
};
