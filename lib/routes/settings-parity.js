'use strict';

/**
 * Settings API parity audit (#3278, V6-049 acceptance criterion 1).
 *
 * #3278 asks to "audit every setting" across Global, Fleet, Workspace and
 * Session configuration and expose 100% of it through authenticated REST
 * APIs. That is a whole-product sweep, far beyond what this car's exclusive
 * file envelope (`lib/routes/settings-parity.js`, `lib/routes/projects.js`,
 * one test file) can safely cover in one PR without touching every settings
 * surface in the codebase — so this module is the audit PRIMITIVE, not the
 * finished sweep: a schema-validation function any settings domain can run
 * itself through, plain-objects-in/plain-objects-out like
 * `lib/roadmap-admission.js` and `lib/fleet-sdlc-policy.js` before it. The
 * one concrete domain this car wires all the way through is the project
 * domain (`lib/project-config.js`'s own `DEFAULT_PROJECT_CONFIG`), via
 * `lib/routes/projects.js`'s new `GET /api/projects/:name/settings-parity`.
 * Auditing Global/Fleet/Workspace/Session settings the same way is a
 * concrete, scoped follow-up this module already makes cheap, not a gap left
 * unacknowledged.
 *
 * @module lib/routes/settings-parity
 */

const { DEFAULT_PROJECT_CONFIG } = require('../project-config');

/** The project domain's own known setting keys, read once from its real default object. */
const PROJECT_CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_PROJECT_CONFIG));

/**
 * Audit a project's resolved config against the real, live
 * `DEFAULT_PROJECT_CONFIG` schema (not a copy of its key list kept here,
 * which would drift the moment a field is added or removed there).
 * @param {object} config - A project's resolved config, as `lib/project-config.js#load` returns it.
 * @param {object} [options]
 * @param {string[]} [options.exposedKeys] - Which of the schema's keys a
 *   caller's own read/write surface (a route, a UI form) actually lets
 *   through. Omitted means "this audit's own caller is the exposure" — the
 *   default when nothing names a narrower surface is zero gaps, since the
 *   config itself is what gets returned in full.
 * @returns {{knownKeys: string[], unknownKeys: string[], missingKeys: string[], gaps: string[]}}
 *   `unknownKeys` — present in `config` but not in the schema (drift: a
 *   stale or undocumented field). `missingKeys` — in the schema but absent
 *   from `config` (should not happen once `load()` has merged defaults in;
 *   meaningful when auditing a raw, un-merged object). `gaps` — schema keys
 *   `options.exposedKeys` does not cover, when that option is given.
 */
function auditProjectSettings(config, options = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('auditProjectSettings: config must be an object');
  }
  const configKeys = new Set(Object.keys(config));
  const knownKeys = new Set(PROJECT_CONFIG_KEYS);

  const unknownKeys = [...configKeys].filter((k) => !knownKeys.has(k));
  const missingKeys = PROJECT_CONFIG_KEYS.filter((k) => !configKeys.has(k));

  let gaps = [];
  if (Array.isArray(options.exposedKeys)) {
    const exposed = new Set(options.exposedKeys);
    gaps = PROJECT_CONFIG_KEYS.filter((k) => !exposed.has(k));
  }

  return { knownKeys: [...PROJECT_CONFIG_KEYS], unknownKeys, missingKeys, gaps };
}

module.exports = { PROJECT_CONFIG_KEYS, auditProjectSettings };
