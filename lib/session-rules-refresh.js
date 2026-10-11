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
 * - It writes as many files as there are rules hooks registered, and no more.
 *   Each file is printed by a hook of its own, so a file with no hook is a rule
 *   in force and not delivered, with no sign of it. The registered hooks are
 *   read, never written: a rule set that outgrew them is named in the last file
 *   (`packFixedSlots`), and registering a further hook is the launch's to do.
 *
 * A refresh is not a delivery, so it writes no delivery-ledger row: those vouch
 * for a launch and its receipt. A log line records it.
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const rulesChannel = require('./session-rules-channel');
const { profileIdOf } = require('./startup-dialog');
const { LOCAL_SETTINGS_BASENAME, SHARED_HOOK_SETTINGS_PATHS, TC_HOOK_SCRIPTS } = require('./engines');
const { createLogger } = require('./logger');

const log = createLogger('session-rules-refresh');

/**
 * Suffix of the file a slot is written to before it replaces the live one. The
 * hook can fire at any moment, and a file written in place could be printed
 * half-written; a rename swaps the whole file or none of it.
 */
const TMP_SUFFIX = '.refresh-tmp';

/**
 * Whether the project's launch delivered rules files.
 *
 * The first file is the test: a launch that delivers rules always writes it,
 * and one that declines delivery removes every file.
 *
 * @param {string} projectPath - Project root.
 * @returns {boolean}
 */
function hasRulesFiles(projectPath) {
  return fs.existsSync(rulesChannel.shardPath(projectPath, 1));
}

/** Basenames of the scripts that print a rules file, as the hook sync names them. */
const RULES_HOOK_SCRIPTS = TC_HOOK_SCRIPTS.filter((script) => script.startsWith('sessionstart-rules-'));

/**
 * Count the rules hooks registered for a project, as slots 1..n with no gap.
 *
 * The hook sync writes one entry per rules file into the project's local
 * settings file, each command ending in the number of the file it prints. That
 * file is the only statement of which files have a reader, so it is what bounds
 * a refresh. It is read here and never written.
 *
 * @param {string} projectPath - Project root.
 * @returns {number} Zero when the file is absent or registers no rules hook.
 * @throws {Error} When the file is present and cannot be read as JSON: an
 *   unknown number of readers is not zero readers. The message names the file.
 */
function registeredSlots(projectPath) {
  // The directory comes from the one path the hook sync exports that carries it.
  const file = path.join(projectPath, path.dirname(SHARED_HOOK_SETTINGS_PATHS[0]), LOCAL_SETTINGS_BASENAME);
  if (!fs.existsSync(file)) return 0;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // The parser's own message names no file, and the fault is not where the
    // rules files are: say which file, so the reader is not sent to the wrong one.
    throw new Error(`the registered hooks could not be read from ${file}: ${err.message}`, { cause: err });
  }
  const entries = (settings && settings.hooks && settings.hooks.SessionStart) || [];
  const numbers = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const hook of (entry && Array.isArray(entry.hooks)) ? entry.hooks : []) {
      const command = hook && typeof hook.command === 'string' ? hook.command : '';
      if (!RULES_HOOK_SCRIPTS.some((script) => command.includes(`data/hooks/${script}`))) continue;
      const m = command.match(/\s(\d+)\s*$/);
      if (m) numbers.add(Number(m[1]));
    }
  }
  let count = 0;
  while (numbers.has(count + 1)) count += 1;
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
 * Replace slots 1..n with the given texts (a slot with no file yet gains one),
 * all or nothing as far as a write can
 * be: every file is written beside its target first, and only when all of them
 * are on disk is any target replaced.
 * @param {string} projectPath - Project root.
 * @param {string[]} texts - One per slot, in order.
 * @returns {void}
 * @throws {Error} When a file cannot be written or renamed. The error carries
 *   `filesReplaced`: zero when staging failed and every target is as it was,
 *   and the number already swapped when a rename failed part-way, which leaves
 *   the earlier files new and the later ones old.
 */
function _replaceSlots(projectPath, texts) {
  const targets = texts.map((_, i) => rulesChannel.shardPath(projectPath, i + 1));
  const staged = [];
  let filesReplaced = 0;
  try {
    texts.forEach((text, i) => {
      const tmp = targets[i] + TMP_SUFFIX;
      fs.writeFileSync(tmp, rulesChannel.renderShardPayload(text));
      staged.push(tmp);
    });
    staged.forEach((tmp, i) => {
      fs.renameSync(tmp, targets[i]);
      filesReplaced += 1;
    });
  } catch (err) {
    err.filesReplaced = filesReplaced;
    throw err;
  } finally {
    for (const tmp of staged) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* a leftover staging file is printed by nothing */ }
    }
  }
}

/**
 * The budget of the engine that prints the project's files.
 *
 * A session can be launched on another engine than the project stores, and the
 * cap belongs to the engine whose hook prints the file. Sizing for the stored
 * engine could write a file the running one replaces with a preview, which
 * loses every rule in it. The live session's engine is used where there is one;
 * the stored engine is the answer only when nothing is running.
 *
 * @param {{id:number, engineId:(string|null)}} project - The project row.
 * @returns {number} Character budget for one file.
 */
function _budgetFor(project) {
  const session = store.sessions.getActive(project.id);
  const profileId = profileIdOf((session && session.engineId) || project.engineId);
  return rulesChannel.resolveChannelBudget(profileId ? store.engines.get(profileId) : null);
}

/**
 * The verdict for a project whose files are left as they are.
 *
 * It carries the count of rules in force because "nothing to refresh" has two
 * meanings a caller must tell apart: no rule governs the project, or rules do
 * and no file states them. A project launched with no rule has neither a file
 * nor a hook, so its first rule lands here.
 *
 * @param {number|null} projectId - The project asked about.
 * @param {string} reason - `no-project`, `no-rules-files` or `no-rules-hooks`.
 * @returns {{status:'nothing-to-refresh', projectId:(number|null), reason:string, rulesInForce:number}}
 */
function _nothingToRefresh(projectId, reason) {
  return {
    status: 'nothing-to-refresh',
    projectId,
    reason,
    rulesInForce: store.sessionRules.listActiveForProject(projectId).length
  };
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
 *   |{status:'nothing-to-refresh', projectId:(number|null), reason:string,
 *   rulesInForce:number} `reason` is
 *   `no-project`, `no-rules-files` (the launch delivered none) or `no-rules-hooks`
 *   (files are on disk and nothing is registered to print them). `rulesInForce`
 *   above zero means rules govern the project that no file states.
 *   |{status:'failed', projectId:(number|null), project:(string|undefined), reason:string,
 *   filesReplaced:number}} `filesReplaced` above zero means the set on disk is
 *   part new and part old.
 */
function refreshProjectRules(projectId, options = {}) {
  let project;
  try {
    if (projectId === null || projectId === undefined) return _nothingToRefresh(null, 'no-project');
    project = store.projects.get(projectId);
    if (!project || !project.path) return _nothingToRefresh(projectId, 'no-project');
    if (!hasRulesFiles(project.path)) return _nothingToRefresh(projectId, 'no-rules-files');
    const slots = registeredSlots(project.path);
    if (slots === 0) return _nothingToRefresh(projectId, 'no-rules-hooks');

    const rules = store.sessionRules.listActiveForProject(project.id);
    const maxChars = _budgetFor(project);
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
    const filesReplaced = err.filesReplaced || 0;
    const left = filesReplaced > 0
      ? `${filesReplaced} of them were replaced before the failure, so the set on disk is part new and part old.`
      : 'they still hold the rule set from before this change.';
    log.warn(
      `Could not rewrite the delivered rules files; ${left} `
      + '`tc rules` is correct, and the next launch of the project rewrites the files.',
      { projectId, project: name, dir: project && path.join(project.path, '.tangleclaw'), error: err.message }
    );
    return {
      status: 'failed', projectId: projectId ?? null, project: name || undefined, reason: err.message, filesReplaced
    };
  }
}

module.exports = { refreshProjectRules, hasRulesFiles, registeredSlots, TMP_SUFFIX };
