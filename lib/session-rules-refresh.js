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
 * - It only rewrites where files already exist OR where the project can still
 *   register the hooks that would print new ones (#2293). A project launched
 *   with no rule in force wrote no file and registered no hook on purpose —
 *   there was nothing to deliver — and that is not the same as a launch that
 *   declined delivery outright (silent prime off, or an engine with no second
 *   channel). The first case grows hooks on refresh so a rule approved mid-session
 *   still reaches the next `/clear`; the second never had anywhere to grow one,
 *   and a refresh must not start what the launch declined.
 * - It writes as many files as there are rules hooks registered, growing that
 *   count first when the live rule set needs more slots than are registered —
 *   whether that is zero slots (no rule was in force at launch) or a rule set
 *   that outgrew however many slots the launch did register (#2293). Growth is
 *   attempted by re-running the same hook sync a launch runs
 *   (`engines.syncEngineHooks`), which recomputes the slot count fresh from the
 *   rules in force, so it only ever asks for exactly what the live set needs.
 *   It is attempted, not guaranteed: an engine with no hook mechanism, or a
 *   project that opted out of hook delivery, registers nothing no matter how
 *   many times this runs, and the shortfall is named in the verdict instead
 *   (`packFixedSlots` still does the naming when growth does not fully cover
 *   the set, e.g. a sync that partially failed).
 *
 * A refresh is not a delivery, so it writes no delivery-ledger row: those vouch
 * for a launch and its receipt. A log line records it.
 *
 * A grown hook reaches a running session only through its own next trigger —
 * `startup`, `clear` or `compact` (`SESSION_START_REENTRY_MATCHER` in
 * `lib/engines.js`) — never mid-turn. For an engine with no hook mechanism at
 * all (no `capabilities.supportsSilentPrime`, or the project's own
 * `silentPrime` setting is off), no `/clear` delivers it either: the rule is in
 * force (`tc rules` always reads it) but not pushed into context until the
 * project's next launch, which is exactly what the `no-rules-files` /
 * `no-rules-hooks` verdict reasons below communicate to a caller deciding how
 * to tell the operator.
 *
 * **Empirical finding (#2293, real-engine test against `claude --version` ==
 * 2.1.283):** does a SessionStart hook added to `.claude/settings.local.json`
 * mid-session actually fire on a running session's next `/clear`? Tested by
 * launching a disposable `claude` session in a tmux pane with no hooks
 * registered, then writing a SessionStart hook into the live project's
 * `.claude/settings.local.json` mid-session and sending `/clear`, repeated
 * across ~10 trials varying the matcher position (first hook vs. a second
 * added beside an unchanged first one), the kind of change (a brand-new entry
 * vs. editing an existing entry's command), and the delay between the file
 * write and the `/clear` (zero delay vs. a few seconds).
 *
 * **Yes — Claude Code re-reads the hooks configuration fresh on every
 * `/clear`, not only at process startup.** The one wrinkle: a `/clear` sent
 * with NO delay at all after the write (same shell invocation, no
 * intervening sleep) unreliably missed the change in several trials — the
 * same edit, left to settle for as little as ~5 seconds before the next
 * `/clear`, picked it up every time afterward, including a change to an
 * already-registered hook's command text and a brand-new entry added beside
 * one that already fired at launch. This reads as a short settle window in
 * Claude Code's own file-change detection, not a permanent at-launch cache —
 * and it is never a concern in real operator usage, where a human reading a
 * response and typing the next one takes far longer than that window. A
 * fully scripted/automated `/clear` sent in the same instant as the write is
 * the one case this finding does not cover as reliable.
 *
 * For an engine with no `SessionStart` hook mechanism at all (`codex`,
 * `gemini`, `antigravity`, `aider` as of this writing — anything whose engine
 * profile has no `capabilities.supportsSilentPrime`), none of the above
 * applies: no hook is ever registered for it (`syncEngineHooks` builds no
 * baseline hooks for a non-`claude`-profile engine), so growth cannot help a
 * running session of one, same as a project that opted out of delivery. Its
 * rule reaches the project only on its next full launch, or immediately via
 * `tc rules`. This is exactly the `no-rules-files` reason below, and it is
 * not specific to #2293 — the same was already true of a delivery the launch
 * declined outright.
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const rulesChannel = require('./session-rules-channel');
const { profileIdOf } = require('./startup-dialog');
const {
  LOCAL_SETTINGS_BASENAME, SHARED_HOOK_SETTINGS_PATHS, TC_HOOK_SCRIPTS, syncEngineHooks
} = require('./engines');
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
    // A project delivering its first rule (#2293) never had `.tangleclaw/` —
    // a launch that did creates it via `writeShards`, but this is the first
    // write of any kind for one that did not. `recursive: true` is a no-op
    // when the directory already exists, so every other caller is unaffected.
    if (texts.length > 0) fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
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
 * The engine whose hook mechanism owns this project's delivery right now.
 *
 * A session can be launched on another engine than the project stores; the
 * live session's engine is used where one is running, the stored engine only
 * when nothing is. Shared by `_budgetFor` (what a file may hold) and the
 * rules-hook growth call in `refreshProjectRules` (which engine to register a
 * hook against, #2293) so the two never disagree about which engine this
 * refresh is actually for.
 *
 * @param {{id:number, engineId:(string|null)}} project - The project row.
 * @returns {string|null} The profile id, or null when no engine is named.
 */
function _effectiveEngineId(project) {
  const session = store.sessions.getActive(project.id);
  return profileIdOf((session && session.engineId) || project.engineId);
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
  const profileId = _effectiveEngineId(project);
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
 *   files:number, removed:number, omittedRuleIds:number[], hooksGrown:boolean}
 *   `hooksGrown` is true when this call itself registered one or more rules
 *   hooks that were not registered before it ran (#2293) — either the
 *   project's first rule, or a set that outgrew its launch-time slots.
 *   |{status:'nothing-to-refresh', projectId:(number|null), reason:string,
 *   rulesInForce:number} `reason` is
 *   `no-project`, `no-rules-files` (no file exists and nothing could be
 *   registered to print one — the project declined delivery, or its engine has
 *   no hook mechanism) or `no-rules-hooks` (a file exists from an earlier
 *   delivery but nothing is registered to print it, and growth did not
 *   change that). `rulesInForce` above zero means rules govern the project
 *   that no file states; for either reason, `tc rules` still reads them —
 *   only the engine's own context delivery is what is missing, and it stays
 *   missing until the project's next launch.
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

    const rules = store.sessionRules.listActiveForProject(project.id);
    const maxChars = _budgetFor(project);
    const neededSlots = rulesChannel.shardCount(rules, maxChars);

    let slots = registeredSlots(project.path);
    let hooksGrown = false;
    if (neededSlots > slots) {
      // Fewer slots are registered than the live set needs — either none ever
      // were (the project's first rule) or the set outgrew however many the
      // launch registered (#2293). Re-running the launch's own hook sync asks
      // it to recompute the slot count fresh from the store and register
      // exactly that many; it is a no-op for a project that declined delivery
      // or whose engine has no hook mechanism, which is why `slots` is
      // re-read rather than assumed to have grown.
      try {
        // Pin the SAME engine `_budgetFor` just sized against — a live
        // session's engine, when one is running, else the stored one — never
        // the bare DB-stored engine on its own. Without this, a project whose
        // live session runs a different engine than it stores would have its
        // existing hooks retired by a sync resolved against the wrong engine
        // (`syncEngineHooks` clears all hooks for a non-matching engine).
        syncEngineHooks(project.path, _effectiveEngineId(project));
      } catch (err) {
        log.warn('Could not grow registered rules hooks for a set that outgrew them; '
          + 'the shortfall is named in this refresh and the next launch still registers them', {
          projectId: project.id, project: project.name, error: err.message
        });
      }
      const grown = registeredSlots(project.path);
      hooksGrown = grown > slots;
      slots = grown;
    }

    if (slots === 0) {
      return _nothingToRefresh(project.id, hasRulesFiles(project.path) ? 'no-rules-hooks' : 'no-rules-files');
    }

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
      omittedRuleIds: rendered.omittedRuleIds,
      hooksGrown
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

module.exports = { refreshProjectRules, registeredSlots, TMP_SUFFIX };
