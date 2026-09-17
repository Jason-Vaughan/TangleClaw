'use strict';

/**
 * `handoff-stage` wrap step (Train 21, #1585) — stages this wrap attempt's
 * `tc.handoff/1` document.
 *
 * Runs **last**, after `apply-pr-resolutions`, because the document records
 * what the wrap achieved: staged any earlier and it would describe a wrap that
 * had not finished happening.
 *
 * **Never a blocker.** A wrap that produced real work must not fail because the
 * handoff could not be written — the failure is recorded in the wrap result and
 * preflight reports the absent publication later. This is wrap-direction §3: a
 * gate blocks only where failure would otherwise be silent or destructive, and
 * this failure is neither.
 *
 * **Staging is not publishing.** This step writes bytes and a `staged` row and
 * stops. The attempt becomes eligible only when the lifecycle transition (or
 * `markCheckpointComplete`) binds it, and becomes current only when the wrap
 * finalizes it. An attempt that dies here is simply never published.
 */

const store = require('../store');
const { createLogger } = require('../logger');
const lockfile = require('../handoff-lockfile');
const { newPublicationId, buildHandoffDocument } = require('../handoff-publication');

const log = createLogger('wrap-step-handoff-stage');

/**
 * Every step that did not succeed, named — the document's `missingEvidence`.
 *
 * Named rather than counted: "3 steps degraded" tells the next session nothing
 * it can act on, and the whole point of the record is that the next session can
 * see what it is missing.
 * @param {object[]} previousResults - Prior step results
 * @returns {string[]} `"<stepId>: <status>"` for each non-ok step
 */
function _missingEvidence(previousResults) {
  return (previousResults || [])
    .filter((r) => r && r.ok !== true)
    .map((r) => `${r.stepId || r.id || 'step'}: ${r.status || 'not ok'}`);
}

/**
 * The `Next action` a prior `ai-content` step captured, if any.
 * @param {object[]} previousResults - Prior step results
 * @returns {string|null}
 */
function _nextAction(previousResults) {
  for (const result of previousResults || []) {
    const fields = result && result.output && result.output.parsedFields;
    if (fields && typeof fields.nextAction === 'string' && fields.nextAction.trim()) {
      return fields.nextAction.trim();
    }
  }
  return null;
}

/**
 * Step handler. See module docstring for the full contract.
 * @param {object} context - Pipeline runner context
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, session, previousResults, scope, options, wrapRunId } = context;

  if (!session || session.id == null) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no session to hand off from' },
      blockers: []
    };
  }
  if (!wrapRunId) {
    // Honest skip rather than a silent nothing: without the run id a
    // publication cannot be bound to the attempt that produced it, and an
    // unbindable publication is worse than none.
    log.warn('No wrap run id in context; the handoff cannot be bound to this attempt', {
      project: project.name, session: session.id
    });
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no wrap run id: the handoff could not be bound to this attempt' },
      blockers: []
    };
  }

  // Fixed at staging from the wrap's own option, never re-read later: a kept
  // session's attempt is a checkpoint for its whole life, even if the session
  // is wrapped for real minutes afterwards.
  const kind = options && options.keepSessionRunning ? 'checkpoint' : 'final';
  const missingEvidence = _missingEvidence(previousResults);

  try {
    const publicationId = newPublicationId();
    const doc = buildHandoffDocument({
      publicationId,
      projectId: project.id,
      workspaceId: (session && session.workspaceId) || null,
      sessionId: session.id,
      wrapRunId,
      engineId: session.engineId || project.engine || 'unknown',
      kind,
      stagedAt: new Date().toISOString(),
      worktree: (scope && scope.worktree) || null,
      rules: [],
      globalRulesHash: null,
      engineConfigHash: null,
      continuityIndexHash: null,
      wrapOutcome: missingEvidence.length > 0 ? 'degraded' : 'complete',
      missingEvidence,
      nextAction: _nextAction(previousResults),
      planRef: (scope && scope.planRef) || null
    });

    const written = lockfile.writeStaged(project, doc);
    const { publication, replayed } = store.handoffs.stage({
      publicationId,
      projectId: project.id,
      sessionId: session.id,
      wrapRunId,
      kind,
      fileDigest: written.digest,
      stagedAt: doc.stagedAt
    });

    log.info('Staged a handoff attempt', {
      project: project.name, session: session.id,
      publication: publication.publicationId, kind, replayed
    });

    return {
      ok: true,
      status: 'done',
      // The runner carries this to `_runClaimedWrap`, which binds and
      // finalizes it. A replay returns the FIRST attempt's id, so the wrap
      // finalizes the attempt it actually staged.
      output: {
        publicationId: publication.publicationId,
        kind,
        replayed,
        wrapOutcome: doc.wrapOutcome,
        missingEvidence
      },
      blockers: []
    };
  } catch (err) {
    log.error('Could not stage the handoff', {
      project: project.name, session: session.id, error: err.message
    });
    return {
      ok: false,
      status: 'blocked',
      output: { reason: `handoff staging failed: ${err.message}` },
      blockers: []
    };
  }
}

module.exports = { run, _missingEvidence, _nextAction };
