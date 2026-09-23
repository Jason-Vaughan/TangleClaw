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
 * project's governance config: `syncEngineHooks` (the .claude hook settings files)
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

/**
 * The capability a Prawduct-onboarded project needs to run its methodology.
 * Named so an engine-neutral record can say WHICH capability was missing.
 * @type {string}
 */
const METHODOLOGY_CAPABILITY = 'prawduct-methodology';

/**
 * Whether a project carries Prawduct onboarding on disk, whatever engine is
 * looking at it: a `.prawduct/` directory or the committed plugin reference.
 *
 * Deliberately engine-independent. `governanceState` answers `not-applicable`
 * for every non-Claude engine before it reads the disk, so it cannot tell a
 * project that was onboarded (and must be left dormant, untouched) from one
 * that never was. That distinction is the whole question here.
 *
 * @param {string} projectPath - Absolute path to the project root (or work tree).
 * @returns {boolean}
 */
function isOnboarded(projectPath) {
  if (!projectPath) return false;
  try {
    if (fs.statSync(path.join(projectPath, '.prawduct')).isDirectory()) return true;
  } catch {
    // prawduct:allow prawduct/broad-except -- a missing or unreadable .prawduct/ is "not onboarded this way"; the plugin reference is checked next
  }
  return isPluginGoverned(projectPath);
}

/**
 * Whether the engine running a session can host this project's Prawduct
 * methodology, and what a gate should say when it cannot.
 *
 * - `available` — onboarded, and the engine can run the methodology (Claude).
 * - `not-applicable` — not onboarded: there is no methodology to run, on any engine.
 * - `capability-unavailable` — onboarded, but this engine cannot run it. The
 *   project's Prawduct state is dormant: nothing may write it, and nothing that
 *   the methodology would have to authorize (a merge, a release) may proceed.
 *
 * The engine is the SESSION's (the attempt), not the project row's: a session
 * launched with an engine override is the thing doing the work.
 *
 * @param {string} projectPath - Absolute path to the project root (or work tree).
 * @param {{engineId?: string|null}} [meta] - The running session's engine id.
 * @returns {{onboarded: boolean, available: boolean,
 *   disposition: 'available'|'not-applicable'|'capability-unavailable',
 *   engineId: string|null, capability: string, reason: string}}
 */
function methodologyCapability(projectPath, meta) {
  const engineId = (meta && meta.engineId) || null;
  const onboarded = isOnboarded(projectPath);
  const base = { onboarded, engineId, capability: METHODOLOGY_CAPABILITY };
  if (!onboarded) {
    return { ...base, available: false, disposition: 'not-applicable', reason: 'this project is not onboarded to Prawduct, so there is no methodology to run' };
  }
  if (engineId === 'claude') {
    return { ...base, available: true, disposition: 'available', reason: 'the Claude engine hosts the Prawduct plugin' };
  }
  return {
    ...base,
    available: false,
    disposition: 'capability-unavailable',
    reason: `the ${engineId || 'unknown'} engine cannot run the Prawduct plugin; this project's Prawduct state is left dormant and untouched`
  };
}

/**
 * Repo-root-relative prefixes of the state Prawduct owns in a project.
 * @type {string[]}
 */
const PRAWDUCT_OWNED_PREFIXES = ['.prawduct/'];

/**
 * The path prefixes a wrap must leave out of its commit under this capability:
 * Prawduct's own state when the project is onboarded but the session's engine
 * cannot run it (the state is dormant, and a commit from this session would be
 * the unsupported engine mutating it), and nothing otherwise.
 *
 * @param {{disposition: string}|null} methodology - From {@link methodologyCapability}.
 * @returns {string[]}
 */
function withheldPrefixesFor(methodology) {
  return methodology && methodology.disposition === 'capability-unavailable' ? [...PRAWDUCT_OWNED_PREFIXES] : [];
}

module.exports = {
  isPluginGoverned, governanceState, isOnboarded, methodologyCapability, withheldPrefixesFor,
  METHODOLOGY_CAPABILITY, PRAWDUCT_OWNED_PREFIXES
};
