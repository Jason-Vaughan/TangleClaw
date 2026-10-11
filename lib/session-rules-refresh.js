'use strict';

/**
 * Rewrite a project's delivered rules files from the rules in force (#2273).
 *
 * The launch writes `.tangleclaw/session-rules-<n>.json` once, and the
 * session-start hook prints those files on every start, including after a
 * `/clear` and a compaction. A rule approved, edited or retired while the
 * session runs changed the store and left the files alone, so a cleared session
 * was re-delivered the launch-time set as binding: new rules missing, retired
 * ones still stated.
 *
 * This module regenerates the files in place. The hook stays what it is, a
 * script that prints a file, and the store stays the authority: the files are a
 * rendering of its rows, not a second record of them.
 *
 * Two limits it keeps:
 *
 * - It only rewrites where files already exist. A launch that chose no rules
 *   delivery (silent prime off, a bare launch, an engine with no second channel)
 *   pruned its files on purpose, and a refresh must not start what the launch
 *   declined.
 * - It never adds a file. Each file is printed by a hook of its own, and the
 *   files on disk are the ones the launch wrote for the hooks it registered.
 *   Whether the running session fires a hook for a file added since is not
 *   something this module can read, and a rule in a file nothing prints is lost
 *   with no sign. A rule set that outgrew its files is named in the last one
 *   instead (`packFixedSlots`).
 *
 * A refresh is not a delivery, so it writes no delivery-ledger row: those vouch
 * for a launch and its receipt. A log line records it.
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const rulesChannel = require('./session-rules-channel');
const { createLogger } = require('./logger');

const log = createLogger('session-rules-refresh');

/**
 * Suffix of the file a slot is written to before it replaces the live one. The
 * hook can fire at any moment, and a file written in place could be printed
 * half-written; a rename swaps the whole file or none of it.
 */
const TMP_SUFFIX = '.refresh-tmp';

/**
 * Count the rules files a project has, as slots 1..n with no gap.
 *
 * The hooks are registered as 1..n, so a file after a gap has no settled
 * meaning and is not counted as a slot.
 *
 * @param {string} projectPath - Project root.
 * @returns {number} Zero when the first file is absent.
 */
function existingSlots(projectPath) {
  let count = 0;
  while (fs.existsSync(rulesChannel.shardPath(projectPath, count + 1))) count += 1;
  return count;
}

/**
 * Render the text of every slot for a rule set.
 * @param {object[]} rules - Rules in force.
 * @param {number} maxChars - Budget for one slot.
 * @param {number} slots - Slots available.
 * @param {string} writtenAt - When the set is being written.
 * @returns {{texts: string[], omittedRuleIds: number[], ruleCount: number}}
 */
function _renderSlots(rules, maxChars, slots, writtenAt) {
  const packed = rulesChannel.packFixedSlots(rules, maxChars, slots, { writtenAt });
  if (packed.length === 0) {
    return { texts: [rulesChannel.renderNoRulesText({ writtenAt })], omittedRuleIds: [], ruleCount: 0 };
  }
  const omittedRuleIds = packed.flatMap((slot) => slot.omittedIds);
  const printed = packed.reduce((n, slot) => n + slot.ruleIds.length, 0);
  return { texts: packed.map((slot) => slot.text), omittedRuleIds, ruleCount: printed + omittedRuleIds.length };
}

/**
 * Replace slots 1..n with the given texts, all or nothing as far as a write can
 * be: every file is written beside its target first, and only when all of them
 * are on disk is any target replaced.
 * @param {string} projectPath - Project root.
 * @param {string[]} texts - One per slot, in order.
 * @returns {void}
 * @throws {Error} When a file cannot be written or renamed; the targets not yet
 *   replaced are left as they were.
 */
function _replaceSlots(projectPath, texts) {
  const targets = texts.map((_, i) => rulesChannel.shardPath(projectPath, i + 1));
  const staged = [];
  try {
    texts.forEach((text, i) => {
      const tmp = targets[i] + TMP_SUFFIX;
      fs.writeFileSync(tmp, rulesChannel.renderShardPayload(text));
      staged.push(tmp);
    });
    staged.forEach((tmp, i) => fs.renameSync(tmp, targets[i]));
  } finally {
    for (const tmp of staged) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* a leftover staging file is printed by nothing */ }
    }
  }
}

/**
 * Regenerate a project's delivered rules files from the rules in force.
 *
 * Never throws: it is called from a rule change that has already succeeded, and
 * a failure here must not undo or fail that change. The verdict says what
 * happened so the caller can log it and tell the requester.
 *
 * @param {number|null|undefined} projectId - The project whose rules changed. A
 *   rule with no project (the Project Master's) has nothing delivered this way.
 * @param {object} [options]
 * @param {Date} [options.now] - The time to state in the block (default: now).
 * @returns {{status:'refreshed', projectId:number, project:string, rules:number,
 *   files:number, removed:number, omittedRuleIds:number[]}
 *   |{status:'nothing-to-refresh', projectId:(number|null), reason:string}
 *   |{status:'failed', projectId:(number|null), project:(string|undefined), reason:string}}
 */
function refreshProjectRules(projectId, options = {}) {
  let project;
  try {
    if (projectId === null || projectId === undefined) {
      return { status: 'nothing-to-refresh', projectId: null, reason: 'no-project' };
    }
    project = store.projects.get(projectId);
    if (!project || !project.path) {
      return { status: 'nothing-to-refresh', projectId, reason: 'no-project' };
    }
    const slots = existingSlots(project.path);
    if (slots === 0) {
      return { status: 'nothing-to-refresh', projectId, reason: 'no-rules-files' };
    }

    const rules = store.sessionRules.listActiveForProject(project.id);
    const maxChars = rulesChannel.resolveChannelBudget(store.engines.get(project.engineId));
    const writtenAt = (options.now || new Date()).toISOString();
    const rendered = _renderSlots(rules, maxChars, slots, writtenAt);

    _replaceSlots(project.path, rendered.texts);
    const removed = rulesChannel.pruneShards(project.path, rendered.texts.length);

    const verdict = {
      status: 'refreshed',
      projectId: project.id,
      project: project.name,
      rules: rendered.ruleCount,
      files: rendered.texts.length,
      removed,
      omittedRuleIds: rendered.omittedRuleIds
    };
    log.info('Delivered rules files rewritten from the rules in force', verdict);
    return verdict;
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- a rule change that already succeeded must survive any failure to rewrite its delivered copy
    const name = project && project.name;
    log.warn(
      'Could not rewrite the delivered rules files; they still hold the rule set from before this change. '
      + '`tc rules` is correct, and the next launch of the project rewrites the files.',
      { projectId, project: name, dir: project && path.join(project.path, '.tangleclaw'), error: err.message }
    );
    return { status: 'failed', projectId: projectId ?? null, project: name || undefined, reason: err.message };
  }
}

module.exports = { refreshProjectRules, existingSlots, TMP_SUFFIX };
