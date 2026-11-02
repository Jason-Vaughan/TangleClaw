'use strict';

/**
 * The #1982 configuration-authority audit: which `DEFAULT_PROJECT_CONFIG`
 * settings belong to the operator — a session editing
 * `<project>/.tangleclaw/project.json` cannot choose them — versus which
 * belong to the project's own checkout.
 *
 * **Zero schema duplication (Ruling A491-W1D-R3).** `launchSequence.recoveryMode`
 * is the one setting already operator-pinned today, via `store.projectRecoveryState`
 * (`lib/store/launch.js`, schema v1937) and `lib/project-config.js#resolveRecoveryMode`
 * — shipped as part of #1937, before #1982 was ever filed. This module never
 * creates a second table or a second resolver for it: {@link resolveProjectAuthoritySettings}
 * and {@link detectAuthorityDiscrepancy} delegate `recoveryMode` straight
 * through to `resolveRecoveryMode`, so there is exactly one DB-backed answer
 * for it, not two that could disagree.
 *
 * **Everything else is verified, not assumed (#1982 itself asks "whether
 * other settings share this property").** `PATCH /api/projects/:name`
 * (`server.js`) admits a request via `operatorProjectCaller` ONLY for a
 * rename or for `launchSequence.recoveryMode`; every other key — including
 * `acceptFolderTrust`, `defaultLaunchMode`, `showLaunchModePicker`, and
 * `releaseMode` — falls through to `ownProjectCaller`, i.e. the project's own
 * session may set it. `defaultLaunchMode` + `showLaunchModePicker`'s one
 * risky combination (hiding the picker while the default is a warning-carrying
 * mode) additionally requires a `confirmBypassHidden` flag at PATCH time, but
 * that is a safety CONFIRMATION any caller can supply — including the
 * project's own session — not an operator-IDENTITY gate, so it stays
 * project-owned. {@link OPERATOR_AUTHORITY_SETTINGS} records this as
 * verified against `server.js`'s real admission logic, not against #1982's
 * or any dispatch's assumption of what "ought to" be gated.
 *
 * `rules.core` is a THIRD, narrower case worth naming but not a settings
 * tier of its own: `projectConfig.load` discards whatever a file's `rules.core`
 * says and always substitutes the hardcoded default — framework-forced, not
 * an operator decision at all, so no caller (operator included) can change it
 * through this settings surface.
 */

const projectConfig = require('./project-config');

/** The two tiers a setting's authority can occupy today. */
const AUTHORITY_TIERS = Object.freeze({
  /** A session's `project.json` can never choose this value; a DB-backed pin decides. */
  OPERATOR_PINNED: 'operator-pinned',
  /** The project's own session may set this via `PATCH /api/projects/:name`. */
  PROJECT_OWNED: 'project-owned'
});

/**
 * Every top-level `DEFAULT_PROJECT_CONFIG` setting's authority tier (#1982),
 * keyed the way a caller names it in a PATCH body (`launchSequence.recoveryMode`
 * for the one nested exception; every other key is a top-level field). A
 * setting not listed here is out of this audit's scope — `rules.core` (see
 * the module doc comment) and per-checkout state that was never a config
 * setting at all (`.tangleclaw/state.json`'s wrap boundary).
 * @type {Readonly<Record<string, {tier: string, note: string}>>}
 */
const OPERATOR_AUTHORITY_SETTINGS = Object.freeze({
  'launchSequence.recoveryMode': {
    tier: AUTHORITY_TIERS.OPERATOR_PINNED,
    note: 'Backed by store.projectRecoveryState (#1937); project.json can never loosen an operator pin, and a disagreement is reported as drift, never obeyed.'
  },
  engine: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  silentPrime: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  featureIndexEnabled: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  acceptFolderTrust: {
    tier: AUTHORITY_TIERS.PROJECT_OWNED,
    note: 'Settable by the project\'s own session via PATCH — verified against server.js\'s real admission logic, which gates only a rename and recoveryMode to the operator.'
  },
  projectMapEnabled: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  releaseMode: {
    tier: AUTHORITY_TIERS.PROJECT_OWNED,
    note: 'Settable by the project\'s own session via PATCH — not operator-gated in the current PATCH handler.'
  },
  versionBumpEnabled: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  versionFilePath: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  wrapAutoPrEnabled: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  wrapKeepSessionRunning: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  wrapSections: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  wrapStepOverrides: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH — the project\'s own per-step customization surface by design.' },
  provenanceWatermark: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  defaultLaunchMode: {
    tier: AUTHORITY_TIERS.PROJECT_OWNED,
    note: 'Settable by the project\'s own session via PATCH. Paired with showLaunchModePicker, the one risky combination requires a confirmBypassHidden flag — a safety confirmation any caller can supply, not an operator-identity gate.'
  },
  showLaunchModePicker: {
    tier: AUTHORITY_TIERS.PROJECT_OWNED,
    note: 'Settable by the project\'s own session via PATCH, subject to the same confirmBypassHidden confirmation as defaultLaunchMode.'
  },
  orchestrationKeyRef: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  ports: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  quickCommands: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  tags: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  evalAuditMode: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  testCommand: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  lintCommand: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  'launchSequence.pasteRules': { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH, unlike its sibling launchSequence.recoveryMode.' },
  'launchSequence.unreadyWindowMinutes': { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  releasePrepareCommand: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  workloadNudge: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  replyGuidance: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  suppressNonActionableWakes: { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH.' },
  'rules.extensions': { tier: AUTHORITY_TIERS.PROJECT_OWNED, note: 'Settable by the project\'s own session via PATCH — rules.core (separately) is framework-forced and not settable by anyone, operator included.' }
});

/**
 * The authority tier a setting was classified into, or `null` for a setting
 * this audit doesn't cover.
 * @param {string} settingKey - As keyed in {@link OPERATOR_AUTHORITY_SETTINGS}.
 * @returns {string|null}
 */
function authorityTierOf(settingKey) {
  const entry = OPERATOR_AUTHORITY_SETTINGS[settingKey];
  return entry ? entry.tier : null;
}

/**
 * Resolve every operator-authority setting's effective value and where it
 * came from — the #1982 entry point a caller uses instead of reading
 * `project.json` directly for any setting this audit classifies as
 * {@link AUTHORITY_TIERS.OPERATOR_PINNED}.
 *
 * Only `launchSequence.recoveryMode` has an operator-pinned resolution
 * today; this delegates it verbatim to `projectConfig.resolveRecoveryMode`
 * rather than re-implementing it. A `project-owned` setting resolves to
 * whatever `projConfig` already holds (post-merge-with-defaults) — there is
 * no separate authority to consult for those, by definition.
 * @param {object|null|undefined} projConfig - A config as `projectConfig.load` returns it.
 * @param {{pinnedMode: ('operator'|null), pinnedAt: (string|null)}|null} [recoveryPin] - The
 *   project's `store.projectRecoveryState.get(projectId)` row, or null when it has none.
 * @param {object} [options] - Forwarded to `resolveRecoveryMode` (`advisoryDefault`).
 * @returns {Record<string, {tier: string, value: *, source?: string, warning?: string, discrepancy?: string}>}
 */
function resolveProjectAuthoritySettings(projConfig, recoveryPin, options) {
  const resolved = {};
  for (const key of Object.keys(OPERATOR_AUTHORITY_SETTINGS)) {
    const tier = OPERATOR_AUTHORITY_SETTINGS[key].tier;
    if (key === 'launchSequence.recoveryMode') {
      const recovery = projectConfig.resolveRecoveryMode(projConfig, recoveryPin, options);
      resolved[key] = { tier, value: recovery.mode, source: recovery.source, warning: recovery.warning, discrepancy: recovery.discrepancy };
      continue;
    }
    resolved[key] = { tier, value: _readProjectOwnedValue(projConfig, key) };
  }
  return resolved;
}

/**
 * Whether `project.json` disagrees with an operator-authority decision on
 * record — reported, never obeyed, the same contract `resolveRecoveryMode`
 * already keeps for `recoveryMode` (#1982).
 * @param {object|null|undefined} projConfig
 * @param {{pinnedMode: ('operator'|null), pinnedAt: (string|null)}|null} [recoveryPin]
 * @param {object} [options]
 * @returns {string[]} Each discrepancy found, human-readable; empty when none.
 */
function detectAuthorityDiscrepancy(projConfig, recoveryPin, options) {
  const resolved = resolveProjectAuthoritySettings(projConfig, recoveryPin, options);
  const discrepancies = [];
  for (const entry of Object.values(resolved)) {
    if (entry.discrepancy) discrepancies.push(entry.discrepancy);
  }
  return discrepancies;
}

/**
 * Read a project-owned setting's value out of an already-loaded config,
 * following the one nested path this audit tracks (`launchSequence.*`
 * siblings of `recoveryMode`).
 * @param {object|null|undefined} projConfig
 * @param {string} key
 * @returns {*}
 */
function _readProjectOwnedValue(projConfig, key) {
  if (!projConfig || typeof projConfig !== 'object') return undefined;
  const dot = key.indexOf('.');
  if (dot === -1) return projConfig[key];
  const parent = projConfig[key.slice(0, dot)];
  return parent && typeof parent === 'object' ? parent[key.slice(dot + 1)] : undefined;
}

module.exports = {
  AUTHORITY_TIERS,
  OPERATOR_AUTHORITY_SETTINGS,
  authorityTierOf,
  resolveProjectAuthoritySettings,
  detectAuthorityDiscrepancy
};
