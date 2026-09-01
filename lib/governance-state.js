'use strict';

/**
 * Prawduct governance detection, as pure filesystem reads.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `engines.js`. These two functions
 * are read by the forked directory scanner (`dir-scanner-child.js`), a process
 * whose entire purpose is to be SIGKILLed while it is blocked in the kernel.
 * `engines.js` requires `store.js`, which opens the server's SQLite database at
 * require time — so importing it into the child would give a process designed to
 * be killed an open handle on the database the server depends on. Splitting the
 * pure-fs half out is what lets both sides share ONE implementation instead of
 * the child carrying a copy that drifts.
 *
 * Nothing here may acquire a dependency that touches the database, the network,
 * or a subprocess. `node:fs` and `node:path` only.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Detect whether a project's dev-time governance is owned by the Prawduct V2
 * Claude Code plugin. When true, TangleClaw must NOT generate or overwrite that
 * project's governance config: `syncEngineHooks` (.claude/settings.json hooks)
 * defers to the plugin, and `writeEngineConfig` (CLAUDE.md) writes only a
 * managed OPERATIONAL block, leaving everything outside its markers — the
 * plugin's governance content — byte-identical (#330 hybrid, narrowed by
 * #1021).
 *
 * Signal: the committed plugin install reference — a truthy
 * `enabledPlugins["prawduct@<marketplace>"]` in the project's
 * `.claude/settings.json`. This is the same reference `/prawduct:onboard` writes
 * and `/prawduct:doctor` validates. It is a STABLE detection anchor because
 * `syncEngineHooks` only ever mutates the `.hooks` key and preserves all other
 * keys — so the reference survives TC's own regeneration even though CLAUDE.md
 * does not. Fails closed (returns false) on a missing/unreadable/malformed file
 * so a parse error can never accidentally suppress normal config generation.
 *
 * @param {string} projectPath - Absolute path to the project root.
 * @returns {boolean} True iff the Prawduct V2 plugin governs this project.
 */
function isPluginGoverned(projectPath) {
  try {
    const settingsFile = path.join(projectPath, '.claude', 'settings.json');
    if (!fs.existsSync(settingsFile)) return false;
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const enabled = settings && settings.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') return false;
    return Object.keys(enabled).some((k) => k.startsWith('prawduct@') && enabled[k] === true);
  } catch {
    // prawduct:allow prawduct/broad-except -- fails closed by design: any
    // unreadable or malformed settings file must read as "not governed" rather
    // than suppress config generation. Logging is deliberately absent because
    // this runs per project on a ten-second poll.
    return false;
  }
}

/**
 * Classify a project's Prawduct governance state (#353). Reports what is
 * actually installed on disk — the V2 plugin, a legacy vendored governance
 * hook, or neither. Pure read: no DB, no writes, no mutation.
 *
 * The engine comes from the caller (the DB row is canonical — `.tangleclaw/
 * project.json` can be stale per #320) rather than this function re-reading
 * project config.
 *
 * There is deliberately no "drift" state. While projects carried a methodology
 * label, a Claude project labeled `prawduct` with no enforcement installed was a
 * detectable contradiction — it *claimed* governance it did not have. With the
 * label gone (#538), governance is simply a fact about the filesystem and
 * nothing can contradict it: `ungoverned` is a neutral answer, not a fault.
 *
 * @param {string} projectPath - Absolute path to the project root.
 * @param {{engineId?: string}} [meta] - Engine id from the canonical projects DB row.
 * @returns {'governed-plugin'|'governed-vendored'|'ungoverned'|'not-applicable'}
 *   `governed-plugin` (on the V2 plugin), `governed-vendored` (legacy in-repo
 *   hook present), `ungoverned` (a Claude project with neither — neutral), or
 *   `not-applicable` (non-Claude engine, where governance via the Claude
 *   plugin/hook cannot apply at all).
 */
function governanceState(projectPath, meta) {
  const engineId = meta && meta.engineId;
  // Prawduct governance is a Claude-plugin / Claude-hook concept; on any other
  // engine the question doesn't apply.
  if (engineId !== 'claude') return 'not-applicable';
  if (isPluginGoverned(projectPath)) return 'governed-plugin';
  // A vendored `tools/product-hook` means the project carries its own pre-plugin
  // copy of the governance runtime (Cohort A).
  if (fs.existsSync(path.join(projectPath, 'tools', 'product-hook'))) return 'governed-vendored';
  return 'ungoverned';
}

module.exports = { isPluginGoverned, governanceState };
