'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('./store');

/**
 * Where to look for an engine's locally-installed extensions, per engine id.
 * An engine absent here has no known convention this module can probe, and
 * `extensionInventory` says so rather than guessing a path with no evidence
 * behind it.
 *
 * Each probe receives the resolved home directory and the caller's `deps`
 * seam, and returns the three inventory arrays.
 *
 * @type {Object<string, (home: string, deps: object) => {plugins: string[], skills: string[], mcpServers: string[]}>}
 */
const EXTENSION_PROBES = {
  claude: (home, deps) => {
    const pluginsData = _readJsonFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), deps);
    const plugins = pluginsData && pluginsData.plugins && typeof pluginsData.plugins === 'object'
      ? Object.keys(pluginsData.plugins)
      : [];
    const skills = _listDirNames(path.join(home, '.claude', 'skills'), deps);
    const globalConfig = _readJsonFile(path.join(home, '.claude.json'), deps);
    const mcpServers = globalConfig && globalConfig.mcpServers && typeof globalConfig.mcpServers === 'object'
      ? Object.keys(globalConfig.mcpServers)
      : [];
    return { plugins, skills, mcpServers };
  }
};

/**
 * This module's home directory, through the caller's seam.
 * @param {object} [deps] - Seam: `homedir`.
 * @returns {string}
 */
function _home(deps = {}) {
  return (deps.homedir || os.homedir)();
}

/**
 * Parse a JSON file, or `null` on any read/parse failure (missing file,
 * unreadable, malformed) — this is a best-effort local probe, not a write
 * path, so a bad file degrades to "nothing found" rather than throwing.
 * @param {string} filePath
 * @param {object} [deps] - Seam: `readFile`.
 * @returns {object|null}
 */
function _readJsonFile(filePath, deps = {}) {
  try {
    const raw = (deps.readFile || fs.readFileSync)(filePath, 'utf8');
    return JSON.parse(raw);
  } catch { // prawduct:allow prawduct/broad-except -- a best-effort local probe; missing, unreadable or malformed all degrade to "nothing found", never a thrown error
    return null;
  }
}

/**
 * The subdirectory names directly under `dirPath`, or `[]` on any failure
 * (missing directory, unreadable) — same best-effort degrade as
 * `_readJsonFile`.
 * @param {string} dirPath
 * @param {object} [deps] - Seam: `readdir`.
 * @returns {string[]}
 */
function _listDirNames(dirPath, deps = {}) {
  try {
    const entries = (deps.readdir || fs.readdirSync)(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { // prawduct:allow prawduct/broad-except -- same best-effort degrade as `_readJsonFile`: a missing or unreadable directory reads as "none found"
    return [];
  }
}

/**
 * The locally-discovered extension inventory for one engine: its installed
 * plugins, skills and MCP servers, read from that engine's own convention.
 *
 * Read-only and best-effort throughout: a missing or unreadable file reads
 * as "none found", never as an error, because this is descriptive inventory,
 * not a gate. An engine with no entry in `EXTENSION_PROBES` returns
 * `probed: false` with a `reason` — an honest "not checked" rather than a
 * guess dressed as a finding.
 *
 * @param {object} engineProfile - An engine profile (needs `.id`).
 * @param {object} [deps] - Seams: `homedir`, `readFile`, `readdir` — all
 *   forwarded to the matching probe, so a test can point every read at a
 *   fixture tree without touching the real machine.
 * @returns {{probed: boolean, plugins: string[], skills: string[], mcpServers: string[], reason?: string}}
 */
function extensionInventory(engineProfile, deps = {}) {
  const id = engineProfile && engineProfile.id;
  // Object.hasOwn, not a bare `EXTENSION_PROBES[id]` lookup: an engine id of
  // "__proto__", "constructor" or "toString" would otherwise resolve to an
  // inherited Object.prototype member instead of undefined -- `__proto__`
  // (not a function) throws when called below, and `constructor`/`toString`
  // ARE callable, silently returning a String-wrapper object in place of the
  // real `{plugins, skills, mcpServers}` shape. Nothing upstream (the store,
  // a profile file on disk) refuses an engine id with one of these names.
  const probe = typeof id === 'string' && Object.hasOwn(EXTENSION_PROBES, id) ? EXTENSION_PROBES[id] : null;
  if (!probe) {
    return {
      probed: false,
      plugins: [],
      skills: [],
      mcpServers: [],
      reason: `no known local-extension convention for "${id}"`
    };
  }
  const found = probe(_home(deps), deps);
  return { probed: true, ...found };
}

/**
 * The capability dispositions this inventory surfaces: whether the engine
 * can receive a startup prime at all, and whether it can receive one
 * silently (ADR 0013). Read straight off `capabilities` rather than
 * re-derived, since those two flags are the engine's own declared facts, not
 * a per-project disposition (`silentPrimeDisposition` in `lib/engines.js`
 * answers the per-project question; this answers what the engine itself
 * declares).
 *
 * @param {object} engineProfile
 * @returns {{supportsPrimePrompt: boolean, supportsSilentPrime: boolean}}
 */
function capabilityDispositions(engineProfile) {
  const caps = (engineProfile && engineProfile.capabilities) || {};
  return {
    supportsPrimePrompt: caps.supportsPrimePrompt === true,
    supportsSilentPrime: caps.supportsSilentPrime === true
  };
}

/**
 * A summary of the generated-config carrier this engine writes into, if any
 * — the fact `ENGINE_CONDITIONAL_SETTINGS.generatedConfig` in `lib/engines.js`
 * gates on, read directly off the profile's own `configFormat` rather than
 * re-derived against a specific project's config (that disposition is
 * per-project; this is the engine's own declared carrier).
 *
 * @param {object} engineProfile
 * @returns {{filename: string|null, syntax: string|null, generator: string|null, absentReason: string|null}}
 */
function generatedConfigSummary(engineProfile) {
  const cf = (engineProfile && engineProfile.configFormat) || {};
  return {
    filename: cf.filename || null,
    syntax: cf.syntax || null,
    generator: cf.generator || null,
    absentReason: cf.absentReason || null
  };
}

/**
 * One engine's read-only inventory row: identity, its generated-config
 * carrier, status page, error patterns, declared capability dispositions,
 * and its locally-discovered extensions.
 *
 * Deliberately NOT a tab-bar projection (ADR 0013): this is introspection
 * data for a route, not a UI shape, so it carries the whole `statusPage` and
 * `errorPatterns` blocks rather than the trimmed set `engineClientPayload`
 * sends the picker.
 *
 * @param {object} engineProfile
 * @param {object} [deps] - Forwarded to `extensionInventory`.
 * @returns {object}
 */
function engineInventoryRow(engineProfile, deps = {}) {
  return {
    id: engineProfile.id,
    name: engineProfile.name,
    pickerHidden: engineProfile.pickerHidden === true,
    configFormat: generatedConfigSummary(engineProfile),
    statusPage: engineProfile.statusPage || null,
    errorPatterns: engineProfile.errorPatterns || null,
    capabilities: capabilityDispositions(engineProfile),
    extensions: extensionInventory(engineProfile, deps)
  };
}

/**
 * Every engine profile's inventory row — covering ALL profiles
 * `store.engines.list()` returns, including `pickerHidden` ones (OpenClaw):
 * this is an inventory, not the engine picker, so the exclusion
 * `listWithAvailability` applies there does not apply here (#764).
 *
 * @param {object} [deps] - Forwarded to each row's `extensionInventory`.
 * @returns {object[]}
 */
function inventory(deps = {}) {
  return store.engines.list().map((profile) => engineInventoryRow(profile, deps));
}

/**
 * One engine's inventory row by id, or `null` when no such profile exists.
 * Looks the profile up directly (`store.engines.get`), so — like `inventory`
 * — a `pickerHidden` id resolves here even though it is absent from the
 * engine picker.
 *
 * @param {string} id
 * @param {object} [deps] - Forwarded to `extensionInventory`.
 * @returns {object|null}
 */
function inventoryFor(id, deps = {}) {
  const profile = store.engines.get(id);
  if (!profile) return null;
  return engineInventoryRow(profile, deps);
}

module.exports = {
  inventory,
  inventoryFor,
  engineInventoryRow,
  extensionInventory,
  capabilityDispositions,
  generatedConfigSummary
};
