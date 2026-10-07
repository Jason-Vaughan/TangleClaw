'use strict';

/**
 * The fleet's operator-held launches, as evidence for the operator who decides
 * whether to clear them.
 *
 * Read-only. It proves nothing about the caller: the route decides who may
 * read this (`server.js`, `GET /api/launch/recovery-held`).
 *
 * Each launch carries `uncertainWork`: what TangleClaw durably recorded about
 * work that may have been queued or in flight when the prior session ended.
 * It is a list of separately sourced parts, never one yes-or-no. A part's
 * `state` is one of {@link PART_STATES}, and the three mean different things:
 *
 * - `recorded`: the source holds rows, listed as ids and timestamps.
 * - `none-recorded`: the source was read and holds no row. Each part says how
 *   complete its source is, because an empty read of a pruned source is not
 *   proof that nothing happened.
 * - `unavailable`: the source could not be read, or no durable source exists.
 *   It carries a stable `reasonCode`. The underlying error is logged here and
 *   never sent, since it can name paths and SQL.
 *
 * No part carries payload text: ids, statuses and timestamps only.
 */

const store = require('./store');
const strandedWraps = require('./stranded-wraps');
const { createLogger } = require('./logger');

const log = createLogger('launch-recovery-held');

/**
 * What a part of `uncertainWork` can say about its source.
 * @enum {string}
 */
const PART_STATES = Object.freeze({
  RECORDED: 'recorded',
  NONE_RECORDED: 'none-recorded',
  UNAVAILABLE: 'unavailable'
});

/**
 * The stable reason codes an `unavailable` part or prior-session answer carries.
 * @enum {string}
 */
const REASON_CODES = Object.freeze({
  SOURCE_READ_FAILED: 'SOURCE_READ_FAILED',
  NO_DURABLE_SOURCE: 'NO_DURABLE_SOURCE'
});

const _internal = {
  /** Swappable so a test can make one source's read fail. */
  listStrandedWraps: (project) => strandedWraps.list(project),
  listStagedHandoffs: (sessionId) => store.handoffs.listStagedForSession(sessionId),
  activeStartupFire: (sequenceId) => store.startupPrompts.activeFire(sequenceId),
  previousSession: (projectId, sessionId) => store.sessions.getPreviousInProject(projectId, sessionId)
};

/**
 * Run one source's read and turn a throw into an `unavailable` part.
 *
 * A source that cannot be read must never be reported as holding nothing, so
 * the failure becomes its own state here and the caller's shape is used only
 * when the read returned.
 * @param {string} kind - The part's name
 * @param {string} source - Where the part's rows live
 * @param {object} context - Log fields naming the launch
 * @param {() => object} read - Returns the part's remaining fields
 * @returns {object} The part
 */
function _part(kind, source, context, read) {
  try {
    return { kind, source, ...read() };
  } catch (err) { // prawduct:allow prawduct/broad-except -- one unreadable source must not hide the other launches; it is reported as unavailable and logged
    log.warn('A fleet recovery evidence source could not be read', { kind, ...context, error: err.message });
    return { kind, source, state: PART_STATES.UNAVAILABLE, reasonCode: REASON_CODES.SOURCE_READ_FAILED };
  }
}

/**
 * The session that ended before this launch, as stored.
 *
 * `status` is the session row's own word (`killed`, `crashed`, `wrapped`). It
 * is not a judgment about why the session ended: no reason and no source of a
 * kill is recorded on the row.
 * @param {object} sequence - The held launch
 * @returns {object} `{source, state: 'recorded', sessionId, status, endedAt}`,
 *   `{source, state: 'none-recorded'}` when the project has no earlier session, or
 *   `{source, state: 'unavailable', reasonCode}`
 */
function _priorSession(sequence) {
  const context = { project: sequence.projectId, sequence: sequence.id };
  const { kind, ...answer } = _part('priorSession', 'sessions', context, () => {
    const prior = _internal.previousSession(sequence.projectId, sequence.sessionId);
    if (!prior) return { state: PART_STATES.NONE_RECORDED };
    return { state: PART_STATES.RECORDED, sessionId: prior.id, status: prior.status, endedAt: prior.endedAt };
  });
  return answer;
}

/**
 * What was durably recorded about work that may have been queued or in flight.
 * @param {object} project - The launch's project
 * @param {object} sequence - The held launch
 * @param {object} priorSession - From {@link _priorSession}
 * @returns {object[]} The parts, in a fixed order
 */
function _uncertainWork(project, sequence, priorSession) {
  const context = { project: project.id, sequence: sequence.id };
  return [
    _part('strandedWraps', 'activity_log (wrap.stranded), project-wide', context, () => {
      const items = _internal.listStrandedWraps(project).items.map((item) => ({
        branch: item.branch,
        headSha: item.headSha,
        recordedAt: item.recordedAt,
        sessionId: item.sessionId,
        acknowledged: item.acknowledged,
        grandfathered: item.grandfathered
      }));
      return {
        state: items.length ? PART_STATES.RECORDED : PART_STATES.NONE_RECORDED,
        // The activity log keeps a fixed number of rows per event type, so an
        // empty read cannot show that no wrap was ever stranded.
        completeness: 'incomplete-history',
        note: 'Wrap branches recorded as pushed with no pull request. The record is pruned, so an empty '
          + 'list is not proof that no wrap was stranded.',
        items
      };
    }),
    _part('stagedHandoff', 'handoff_publications (state staged), prior session', context, () => {
      // Looked up by the prior session. When that session could not be read,
      // this part is unknown too: it must not fall back to an empty list.
      if (priorSession.state === PART_STATES.UNAVAILABLE) {
        return { state: PART_STATES.UNAVAILABLE, reasonCode: REASON_CODES.SOURCE_READ_FAILED };
      }
      if (priorSession.state === PART_STATES.NONE_RECORDED) {
        return {
          state: PART_STATES.NONE_RECORDED,
          completeness: 'unpruned',
          note: 'This project has no earlier session, so no prior session staged a handoff.',
          items: []
        };
      }
      const items = _internal.listStagedHandoffs(priorSession.sessionId).map((p) => ({
        publicationId: p.publicationId,
        kind: p.kind,
        wrapRunId: p.wrapRunId,
        stagedAt: p.stagedAt,
        eligibleAt: p.eligibleAt
      }));
      return {
        state: items.length ? PART_STATES.RECORDED : PART_STATES.NONE_RECORDED,
        completeness: 'unpruned',
        note: 'Handoff attempts the prior session staged and never finished. This covers staged handoffs '
          + 'only, not every kind of queued work.',
        items
      };
    }),
    _part('startupPromptFire', 'startup_prompt_fires, this launch', context, () => {
      const fire = _internal.activeStartupFire(sequence.id);
      return {
        state: fire ? PART_STATES.RECORDED : PART_STATES.NONE_RECORDED,
        // Retention removes fire rows of ended sessions only, so for a launch
        // whose session is active every fire row is still there to be read.
        completeness: 'complete-while-session-active',
        note: 'A startup prompt dispatch still in flight for this launch. This covers startup prompt '
          + 'dispatch only, not every kind of queued work.',
        items: fire ? [{
          fireId: fire.id,
          outcome: fire.outcome,
          createdAt: fire.createdAt,
          dispatchedAt: fire.dispatchedAt,
          acceptedAt: fire.acceptedAt,
          updatedAt: fire.updatedAt
        }] : []
      };
    }),
    _part('launchNudge', 'launch_sequences, this launch', context, () => ({
      state: sequence.nudgeCount > 0 ? PART_STATES.RECORDED : PART_STATES.NONE_RECORDED,
      completeness: 'unpruned',
      note: 'Each nudge is an attempt to type a reminder into the pane. A sent nudge is not proof it was '
        + 'received or read.',
      nudgeCount: sequence.nudgeCount,
      lastNudgedAt: sequence.lastNudgedAt,
      unreadyAt: sequence.unreadyAt
    })),
    {
      kind: 'paneInput',
      source: 'none',
      state: PART_STATES.UNAVAILABLE,
      reasonCode: REASON_CODES.NO_DURABLE_SOURCE,
      note: 'Text typed or queued in the pane, a prompt the engine queued itself and a pasted prime are '
        + 'recorded nowhere durable, so nothing is known about them.'
    }
  ];
}

/**
 * Every launch on this install that is waiting on an operator's clear.
 *
 * A launch is listed when its recovery is `required` in `operator` mode, its
 * session's stored status is active and its project is not archived. A launch
 * whose project row cannot be found is left out and logged: without the
 * project there is no name to show and nothing to clear it through.
 * @returns {object[]} One entry per held launch, oldest launch first
 */
function listHeld() {
  const launches = [];
  for (const sequence of store.launchSequences.listOperatorHeldOfActiveSessions()) {
    const project = store.projects.get(sequence.projectId);
    if (!project) {
      log.warn('An operator-held launch has no project row and was left out of the fleet read', {
        sequence: sequence.id, project: sequence.projectId
      });
      continue;
    }
    const priorSession = _priorSession(sequence);
    launches.push({
      projectId: project.id,
      projectName: project.name,
      sessionId: sequence.sessionId,
      sequenceId: sequence.id,
      revision: sequence.revision,
      recoveryRevision: sequence.recoveryRevision,
      createdAt: sequence.createdAt,
      recovery: sequence.recovery,
      recoveryMode: sequence.recoveryMode,
      // The stored status the launch was selected on. Nothing here checked
      // that the session's pane is alive.
      sessionStatus: { value: store.SESSION_STATUS.ACTIVE, basis: 'stored-session-status' },
      // The preflight record exactly as the launch stored it, and null when the
      // store could not parse it. Nothing is picked out, defaulted or coerced: the operator
      // is deciding on this evidence, `requiresRecovery` is the predicate the
      // gate obeyed and is not a function of the verdict, and a `worktreeDirty`
      // of null ("never measured") must not arrive as false ("measured clean").
      preflight: sequence.preflight,
      priorSession,
      uncertainWork: _uncertainWork(project, sequence, priorSession)
    });
  }
  return launches;
}

module.exports = { PART_STATES, REASON_CODES, listHeld, _internal };
