'use strict';

/**
 * #569 — the wrap proposes rules; it never applies them.
 *
 * A learning that keeps recurring is evidence that something should govern
 * future sessions rather than be rediscovered each time. Until now nothing
 * closed that gap: `promoteFromLearning` existed and had exactly one caller —
 * an HTTP route no UI ever called — so turning a learning into a rule depended
 * on someone remembering to do it by hand. The compounding loop was drawn but
 * not connected.
 *
 * This step connects it, on the safe side of the line. It creates rules at
 * `status:'proposed'`, which nothing injects: not the launch prime
 * (`listActiveForProject`), not the master identity (`listActiveForMaster`),
 * not the wrap's own prompts (`_appendWrapRules`). A proposal governs nothing
 * until an operator approves it. The store enforces that at the write site too
 * — `create()` refuses to mint an active rule from AI authorship without an
 * explicit operator decision — because a gate on one entrance is not a gate.
 *
 * **Why this step proposes from ACTIVE learnings only.** A learning reaches
 * `active` by recurring (`learnings-db-write` confirms a repeat, and
 * `learnings.confirm` promotes at 2+). Proposing from provisional rows would
 * turn every passing observation into a rule proposal and bury the operator in
 * review; the recurrence requirement is what makes a proposal mean "this keeps
 * happening" rather than "this happened once".
 *
 * The step is deliberately mechanical: it does not ask an AI to invent rule
 * text. The learning's own text is the proposal, and the operator edits it at
 * approval time. That keeps the wrap's self-improvement auditable — every
 * proposal traces to a specific learning row via `source_learning_id` — and
 * avoids a second AI round-trip whose output nothing could verify.
 */

const { createLogger } = require('../logger');
const store = require('../store');

const log = createLogger('wrap-step-rule-proposal');

/**
 * Canonical skip signal — `status:'skipped'` with a reason the drawer renders.
 * @param {string} reason - Operator-readable explanation
 * @returns {{ok: boolean, status: string, output: object, blockers: string[]}}
 */
function _skipped(reason) {
  return { ok: true, status: 'skipped', output: { reason, detail: reason }, blockers: [] };
}

/**
 * Step handler — propose a rule for each active learning that has not already
 * produced one.
 *
 * Never blocks: a wrap must not fail because rule proposal was unavailable.
 *
 * @param {object} context - Runner context (`project`, `step`, ...)
 * @returns {Promise<{ok: boolean, status: string, output: object, blockers: string[]}>}
 */
async function run(context) {
  const project = context && context.project;
  if (!project || !project.id) return _skipped('no project id — cannot propose rules');

  let learnings;
  try {
    learnings = store.learnings.getActive(project.id);
  } catch (err) {
    return _skipped(`learnings.getActive failed: ${err.message}`);
  }
  if (!learnings || learnings.length === 0) {
    return _skipped('no active learnings — nothing recurring enough to propose');
  }

  // Every learning that has ALREADY produced a rule is off the table, whatever
  // that rule's status. Re-proposing a rejected one would make the operator's
  // decision meaningless and re-ask it at every wrap — the reason a rejection
  // is recorded rather than deleted.
  let alreadyProposed;
  try {
    alreadyProposed = new Set(
      store.sessionRules.list({ projectId: project.id })
        .map((r) => r.sourceLearningId)
        .filter((id) => id !== null && id !== undefined)
    );
  } catch (err) {
    return _skipped(`sessionRules.list failed: ${err.message}`);
  }

  const candidates = learnings.filter((l) => !alreadyProposed.has(l.id));
  if (candidates.length === 0) {
    return _skipped(`all ${learnings.length} active learning(s) already have a rule or a decision`);
  }

  const proposed = [];
  for (const learning of candidates) {
    try {
      const rule = store.sessionRules.promoteFromLearning(learning.id, {
        createdBy: 'ai',
        kind: 'startup',
        changeReason: `proposed by the wrap from recurring learning ${learning.id}`
        // No `approvedByOperator` and no `status` — so this lands as 'proposed'.
      });
      proposed.push({ ruleId: rule.id, learningId: learning.id, content: rule.content, status: rule.status });
    } catch (err) {
      // One bad proposal must not sink the others or the wrap.
      log.warn('rule proposal failed for one learning — continuing', {
        project: project.name, learningId: learning.id, error: err.message
      });
    }
  }

  if (proposed.length === 0) return _skipped(`found ${candidates.length} candidate(s) but every proposal failed`);

  // Fail loudly rather than quietly if anything ever lands active from here:
  // this step is the one place AI-authored rules enter the table, so a status
  // regression would silently start governing sessions.
  const leaked = proposed.filter((p) => p.status !== 'proposed');
  if (leaked.length > 0) {
    log.error('rule proposal produced a non-proposed rule — this should be impossible', {
      project: project.name, ruleIds: leaked.map((p) => p.ruleId)
    });
  }

  log.info('proposed rules from recurring learnings', { project: project.name, count: proposed.length });
  const detail = `${proposed.length} rule${proposed.length === 1 ? '' : 's'} proposed for your review `
    + '— nothing is applied until you approve';
  return {
    ok: true,
    status: 'done',
    output: { proposed, count: proposed.length, detail },
    blockers: []
  };
}

module.exports = { run, _skipped };
