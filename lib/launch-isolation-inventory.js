'use strict';

/**
 * The launch-isolation inventory (#2233): for every live session and the
 * Project Master, whether the command its pane was started with shows it was
 * kept off its engine's shared background process.
 *
 * Why it exists: a launch is judged for isolation as it starts
 * (`lib/sessions.js#_judgeLaunchIsolation`), which says nothing about a
 * session that was already running when that judgment was deployed. tmux
 * keeps the command each pane was started with for as long as the pane lives,
 * so that string is read back and judged here. Nothing is recorded for it and
 * nothing is changed by it: this module ends, restarts and writes nothing.
 *
 * Four verdicts. `isolated` and `not-isolated` are an engine adapter's answer
 * about a command it read. `not-applicable` is an engine with no shared
 * background process, or a session with no pane: one that runs elsewhere, or
 * one tmux answered it has no session for. `unknown` is every case
 * where the command could not be read or judged; it is never folded into
 * `isolated`, and a reader should treat it as `not-isolated`.
 *
 * Beside the verdict, a row says when its launch was started under the
 * operator's launch-isolation override (#2229). That is a fact about how the
 * launch was allowed to start, never a verdict: it is attached only to a row
 * that reads `not-isolated`, and it changes no verdict and no count. It is
 * claimed only on the launch's own record: the activity event that launch
 * wrote, whose reference to the launch id matches the id the live pane
 * carries. For a project row it is also the event with the row's session id.
 * A pane's command alone is not that record, and neither is an event for a
 * session whose tmux session has since been replaced under the same name. The command an overridden launch runs was also what a
 * profile naming Codex by absolute path ran before launches were judged, and
 * a tmux session can be made by hand under a project's name. So a row with
 * that command and no record reads `overrideUnproved`, in words, and is not
 * called overridden. The activity log keeps only its newest events, so an
 * overridden launch's row reads unproved once its event has aged out.
 *
 * What it cannot see: the process now running in a pane, which need not be
 * the one the command started; and whether a tmux session named for a project
 * is that project's current launch (a launch replaces a same-named session
 * before it creates its own, and no pane's environment is read here to
 * confirm it).
 *
 * @module lib/launch-isolation-inventory
 */

const store = require('./store');
const tmux = require('./tmux');
const bridgeHandoff = require('./bridge-handoff');
const startupControl = require('./startup-control');
const { createLogger } = require('./logger');

const log = createLogger('launch-isolation-inventory');

/** The verdicts, worst first: a session with several panes takes the first of these any pane got. */
const VERDICTS = Object.freeze(['not-isolated', 'unknown', 'isolated', 'not-applicable']);

/** Why a session reads `unknown` or `not-applicable` without an adapter's answer. */
const REASONS = Object.freeze({
  tmux_unanswered: 'tmux did not answer, so the command this session was started with could not be read.',
  session_name_unknown: 'TangleClaw could not work out this session\'s tmux name, so its start command could not be looked up.',
  no_pane: 'TangleClaw records this session as active, but tmux has no session of its name: no pane is running for it.',
  no_start_command: 'No pane in this session records a start command.',
  command_unreadable: 'The command this session was started with could not be read back from tmux exactly.',
  judgment_failed: 'TangleClaw could not judge the command this session was started with: its own check failed.',
  no_local_pane: 'This session has no pane on this machine, so no engine process was started here for it.',
  no_judge: 'This session runs an engine that shares a background process between sessions, and this TangleClaw has no check for it that could run.',
  not_shared: 'This engine has no shared background process that TangleClaw knows of.'
});

/**
 * The reads the inventory makes, injected so every branch can be tested
 * without tmux, a database or an engine.
 * @type {object}
 */
const DEFAULT_DEPS = Object.freeze({
  listPanes: (options) => tmux.listPaneStartCommands(options),
  liveSessions: () => store.sessions.listLiveAll(),
  project: (id) => store.projects.get(id),
  engineProfile: (engineId) => store.engines.get(engineId),
  openChannel: (sessionId) => store.startupControlChannels.getOpenBySession(sessionId),
  session: (id) => store.sessions.get(id),
  // The record an overridden launch left, and only when the pane now under
  // that tmux name is that launch's: the event carries a reference to the
  // launch id, and the live tmux session holds the id the launch gave its
  // pane. A session row names a tmux session, and a tmux session can be
  // replaced under its name while the row stays active, so the session id
  // alone would hand an old launch's record to a pane it never started. For a
  // project row the event is the one with its session id; the Project Master
  // has no session row, so its event is found by the reference alone. With no
  // launch id readable from the pane, no event is that pane's.
  overrideRecord: ({ sessionId, tmuxSession }) => {
    const sessions = require('./sessions');
    const live = sessionId
      ? tmux.readSessionEnv(tmuxSession, 'TANGLECLAW_LAUNCH_ID')
      : require('./master').liveMasterLaunchId();
    const ref = live && live.answered ? sessions._overrideLaunchRef(sessionId ? live.value : live.launchId) : null;
    if (!ref) return null;
    const events = store.activity.query(sessionId
      ? { sessionId, eventType: sessions.ISOLATION_OVERRIDDEN_EVENT, limit: 1 }
      : { eventType: sessions.ISOLATION_OVERRIDDEN_EVENT, limit: 50 });
    return events.find((event) => event.detail && event.detail.launchRef === ref
      && (sessionId ? event.detail.role === 'project' : event.detail.role === 'master')) || null;
  },
  currentSession: (projectId) => store.sessions.getActive(projectId),
  // Required lazily: the Master module loads the whole session stack. The
  // engine is the one the Master would be started with now. A running Master
  // started under an earlier setting is still judged by its own command, which
  // names the executable it runs.
  master: () => {
    const master = require('./master');
    let engineId = null;
    try {
      engineId = master._masterRuntime(store.config.load()).engineId || null;
    } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable engine setting leaves the Master judged by its command alone
      log.warn('The Project Master\'s engine could not be resolved for the isolation inventory', { error: err.message });
    }
    return { tmuxSession: master.MASTER_TMUX_SESSION, engineId };
  },
  adapters: startupControl.ADAPTERS,
  now: () => new Date()
});

/**
 * A row's verdict fields for a case no adapter answered.
 * @param {string} verdict - One of {@link VERDICTS}.
 * @param {string|null} reasonCode - A key of {@link REASONS}, or null for the plain not-applicable answer.
 * @returns {{verdict: string, basis: null, reasonCode: (string|null), reason: string}}
 */
function _plain(verdict, reasonCode) {
  return { verdict, basis: null, reasonCode, reason: REASONS[reasonCode || 'not_shared'] };
}

/**
 * Judge one pane's start command.
 * @param {object} facts
 * @param {string|null} facts.engineId - The session's engine id.
 * @param {object|null} facts.engineProfile - Its engine profile.
 * @param {string|null} facts.command - The pane's start command; null when it could not be read back.
 * @param {object|null} facts.channel - The state of the session's open native channel, if any.
 * @param {Object<string, object>} adapters - The adapter registry.
 * @returns {{verdict: string, basis: (string|null), reasonCode: (string|null), reason: string, startedUnisolatedByPath?: true}}
 *   `startedUnisolatedByPath` is the adapter's word that this is the command an overridden launch writes.
 */
function judgePaneCommand(facts, adapters) {
  const { engineId, engineProfile, channel } = facts;
  if (typeof facts.command !== 'string') return _plain('unknown', 'command_unreadable');
  // Required lazily, as the launch path's own helpers: the same wrapper
  // builders and the same test of which engines need a judgment.
  const sessions = require('./sessions');
  const command = bridgeHandoff.unwrapLaunchCommand(sessions._withoutPathFloor(facts.command));
  const needs = sessions._engineNeedingIsolation(engineId, engineProfile, null, command);
  const declared = engineProfile && engineProfile.capabilities ? engineProfile.capabilities.startupControl : null;
  const nativeVerifiedVersions = declared && Array.isArray(declared.verifiedVersions) ? declared.verifiedVersions : null;
  for (const name of Object.keys(adapters)) {
    const adapter = adapters[name];
    if (!adapter || typeof adapter.judgeRecordedCommand !== 'function') continue;
    let verdict;
    try {
      verdict = adapter.judgeRecordedCommand({ engineId, command, identifiedAs: needs, channel, nativeVerifiedVersions });
    } catch (err) { // prawduct:allow prawduct/broad-except -- a judgment that cannot be made is reported as unknown, which a reader treats as not isolated
      log.warn('An engine adapter could not judge a recorded launch command', { adapter: name, engine: engineId, error: err.message });
      return _plain('unknown', 'judgment_failed');
    }
    if (!verdict || !verdict.applies) continue;
    return {
      verdict: verdict.verdict, basis: verdict.basis || null, reasonCode: verdict.reasonCode || null, reason: verdict.reason,
      ...(verdict.verdict === 'not-isolated' && verdict.startedUnisolatedByPath === true ? { startedUnisolatedByPath: true } : {})
    };
  }
  // As at launch: an engine that needs a judgment and got none is not a pass.
  return needs ? _plain('not-isolated', 'no_judge') : _plain('not-applicable', null);
}

/**
 * Judge a session from what tmux recorded for it.
 * @param {object} facts
 * @param {string|null} facts.tmuxSession - The tmux session name; null when it could not be derived.
 * @param {string|null} facts.engineId - The session's engine id.
 * @param {object|null} facts.engineProfile - Its engine profile.
 * @param {object|null} facts.channel - The state of its open native channel, if any.
 * @param {{answered: boolean, sessions: Map<string, Array<string|null>>}} panes - From `tmux.listPaneStartCommands`.
 * @param {Object<string, object>} adapters - The adapter registry.
 * @returns {{verdict: string, basis: (string|null), reasonCode: (string|null), reason: string}}
 */
function judgeSession(facts, panes, adapters) {
  if (!panes.answered) return _plain('unknown', 'tmux_unanswered');
  // No name to look up is a read that failed, not a session with no pane.
  if (typeof facts.tmuxSession !== 'string' || facts.tmuxSession === '') return _plain('unknown', 'session_name_unknown');
  const commands = panes.sessions.get(facts.tmuxSession);
  // tmux answered and has no such session: an observed absence, not a failed
  // read. There is no pane whose process could be on a shared one.
  if (!commands) return _plain('not-applicable', 'no_pane');
  if (commands.length === 0) return _plain('unknown', 'no_start_command');
  const judged = commands.map((command) => judgePaneCommand({ ...facts, command }, adapters));
  return VERDICTS.map((v) => judged.find((j) => j.verdict === v)).find(Boolean);
}

/** What a row says when its pane runs the command of an overridden launch and no record shows this launch was one. */
const OVERRIDE_UNPROVED = 'This is the command a launch the operator\'s override allowed would run, but TangleClaw holds no record that this launch '
  + 'was started under it: the record may have aged out of the activity log, the session was started another way, or its pane is not the one that launch started.';

/**
 * A row's fields once its judgment is known: the judgment, and what is known
 * of the operator's override.
 *
 * `override` is set only when three things hold: the row reads
 * `not-isolated`, its start command is the one an overridden launch runs, and
 * the launch's own record is read and says which refusal was set aside under
 * which override. With the command and no such record the row carries
 * `overrideUnproved: true` and says so in its reason; it is not called
 * overridden. Every other row carries `override: null` and
 * `overrideUnproved: false`. The verdict is left exactly as judged.
 * @param {{verdict: string, basis: (string|null), reasonCode: (string|null), reason: string, startedUnisolatedByPath?: true}} judged - From {@link judgeSession}.
 * @param {{sessionId: (number|null), tmuxSession: (string|null)}} who - The row's session id (null for the Project Master) and the tmux session its pane was read from.
 * @param {object} deps - Reads (see {@link DEFAULT_DEPS}).
 * @returns {{verdict: string, basis: (string|null), reasonCode: (string|null), reason: string, override: ({launchedUnderOverride: true, scope: string, refusal: string, versionRead: (string|null), recordedAt: (string|null)}|null), overrideUnproved: boolean}}
 */
function _withOverrideMark(judged, who, deps) {
  const { startedUnisolatedByPath, ...row } = judged;
  if (row.verdict !== 'not-isolated' || startedUnisolatedByPath !== true) return { ...row, override: null, overrideUnproved: false };
  const event = typeof deps.overrideRecord === 'function'
    ? _try('an overridden launch\'s record', () => deps.overrideRecord(who))
    : null;
  const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : null;
  const text = (value) => (typeof value === 'string' && value !== '' ? value : null);
  const scope = detail && (detail.scope === 'install' || detail.scope === 'project') ? detail.scope : null;
  const refusal = detail ? text(detail.refusal) : null;
  if (!scope || !refusal) {
    return { ...row, reason: `${row.reason} ${OVERRIDE_UNPROVED}`, override: null, overrideUnproved: true };
  }
  const versionRead = text(detail.versionRead);
  const sessions = require('./sessions');
  return {
    ...row,
    reason: `${row.reason} The operator's override allowed this launch to start although it could not be shown isolated `
      + `(engine version read: ${versionRead || 'not read'}; refusal overridden: ${refusal}; `
      + `${scope === 'install' ? 'install-wide override' : 'this project\'s override'}). ${sessions.ISOLATION_OVERRIDE_RISK}`,
    override: { launchedUnderOverride: true, scope, refusal, versionRead, recordedAt: text(event.createdAt) },
    overrideUnproved: false
  };
}

/**
 * A read that must not take the inventory down: null, and a warning, when it throws.
 * @param {string} what - What was being read, for the log.
 * @param {function(): *} read - The read.
 * @returns {*}
 */
function _try(what, read) {
  try {
    return read();
  } catch (err) { // prawduct:allow prawduct/broad-except -- one row's lookup failing leaves that row with less to go on; it never reads as isolated for it
    log.warn(`Isolation inventory: ${what} could not be read`, { error: err.message });
    return null;
  }
}

/**
 * The inventory: one row per live session, and one for the Project Master
 * while it may be running.
 * @param {object} [deps] - Reads (see {@link DEFAULT_DEPS}).
 * @returns {Promise<{observedAt: string, tmux: {answered: boolean, cause: (string|null)}, sessions: Array<{sessionId: (number|null), projectId: (number|null), projectName: (string|null), engineId: (string|null), role: ('project'|'master'), verdict: string, basis: (string|null), reasonCode: (string|null), reason: string, override: (object|null), overrideUnproved: boolean}>, summary: Object<string, number>}>}
 *   The command itself is never returned: it holds paths and a credential handoff file name.
 */
async function inventory(deps = DEFAULT_DEPS) {
  const panes = await deps.listPanes();
  const rows = [];
  for (const session of deps.liveSessions()) {
    const project = _try('a project', () => deps.project(session.projectId));
    const head = {
      sessionId: session.id, projectId: session.projectId, projectName: project ? project.name : null,
      engineId: session.engineId || null, role: 'project'
    };
    if (session.sessionMode && session.sessionMode !== 'tmux') {
      rows.push({ ...head, ..._plain('not-applicable', 'no_local_pane'), override: null, overrideUnproved: false });
      continue;
    }
    const channelRow = _try('a startup channel', () => deps.openChannel(session.id));
    const tmuxSession = session.tmuxSession || (project ? tmux.toSessionName(project.name) : null);
    rows.push({
      ...head,
      ..._withOverrideMark(judgeSession({
        tmuxSession,
        engineId: session.engineId || null,
        engineProfile: session.engineId ? _try('an engine profile', () => deps.engineProfile(session.engineId)) : null,
        channel: channelRow ? channelRow.adapterState || null : null
      }, panes, deps.adapters), { sessionId: session.id, tmuxSession }, deps)
    });
  }
  const master = _try('the Project Master', () => deps.master());
  // The Master has no session row. It is listed when tmux shows its pane, and
  // when tmux did not answer, because it may be running.
  if (master && (!panes.answered || panes.sessions.has(master.tmuxSession))) {
    rows.push({
      sessionId: null, projectId: null, projectName: null, engineId: master.engineId || null, role: 'master',
      ..._withOverrideMark(judgeSession({
        tmuxSession: master.tmuxSession,
        engineId: master.engineId || null,
        engineProfile: master.engineId ? _try('an engine profile', () => deps.engineProfile(master.engineId)) : null,
        channel: null
      }, panes, deps.adapters), { sessionId: null, tmuxSession: master.tmuxSession }, deps)
    });
  }
  const summary = {};
  for (const verdict of ['isolated', 'not-isolated', 'unknown', 'not-applicable']) {
    summary[verdict] = rows.filter((r) => r.verdict === verdict).length;
  }
  return { observedAt: deps.now().toISOString(), tmux: { answered: panes.answered, cause: panes.cause || null }, sessions: rows, summary };
}

/** What became of an earlier session, in words. */
const REPLACED_DETAIL = Object.freeze({
  'unknown-session': 'TangleClaw has no session with this id.',
  'still-running': 'This session is still running. It has not been ended.',
  'ended-not-relaunched': 'This session has ended and its project has no running session.',
  'relaunched-isolated': 'This session has ended, and its project\'s current session reads isolated.',
  'relaunched-not-isolated': 'This session has ended, but its project\'s current session does not read isolated.',
  'relaunched-unknown': 'This session has ended, and its project\'s current session could not be judged.',
  'relaunched-not-applicable': 'This session has ended, and its project\'s current session runs an engine with no shared background process, or has no local pane.'
});

/**
 * Say, for each earlier session id, whether that session was ended and its
 * project relaunched isolated. This is the check that an end-and-relaunch
 * took: the session named is no longer live, and the project's current
 * session is a row of the inventory that reads `isolated`.
 * @param {number[]} ids - Earlier session ids, as an inventory listed them.
 * @param {{sessions: Array<{sessionId: (number|null), verdict: string}>}} inv - An inventory read now.
 * @param {object} [deps] - Reads (see {@link DEFAULT_DEPS}).
 * @returns {Array<{sessionId: number, outcome: string, replacedBy: (number|null), detail: string}>}
 */
function verifyReplaced(ids, inv, deps = DEFAULT_DEPS) {
  const answer = (sessionId, outcome, replacedBy = null) => ({ sessionId, outcome, replacedBy, detail: REPLACED_DETAIL[outcome] });
  return ids.map((id) => {
    const earlier = deps.session(id);
    if (!earlier) return answer(id, 'unknown-session');
    if (earlier.status === store.SESSION_STATUS.ACTIVE) return answer(id, 'still-running');
    const current = deps.currentSession(earlier.projectId);
    if (!current) return answer(id, 'ended-not-relaunched');
    const row = inv.sessions.find((r) => r.sessionId === current.id);
    const verdict = row ? row.verdict : 'unknown';
    const outcome = verdict === 'isolated' || verdict === 'not-isolated' || verdict === 'not-applicable' ? `relaunched-${verdict}` : 'relaunched-unknown';
    return answer(id, outcome, current.id);
  });
}

/**
 * Read a comma-separated list of session ids from a query value.
 * @param {string} raw - The value.
 * @returns {{ok: true, ids: number[]} | {ok: false}}
 */
function parseSessionIds(raw) {
  const parts = String(raw).split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !/^[1-9]\d{0,14}$/.test(p))) return { ok: false };
  return { ok: true, ids: [...new Set(parts.map(Number))] };
}

module.exports = {
  VERDICTS,
  REASONS,
  OVERRIDE_UNPROVED,
  DEFAULT_DEPS,
  judgePaneCommand,
  judgeSession,
  inventory,
  verifyReplaced,
  parseSessionIds
};
