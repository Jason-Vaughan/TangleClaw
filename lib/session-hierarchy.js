'use strict';

/**
 * Session hierarchy: a persistent, project-level delegation relationship
 * letting one session (the "superior") direct, wrap, and clear another
 * (the "subordinate") -- #1578.
 *
 * Complementary to, not a replacement for, the ephemeral per-sprint
 * delegated lifecycle authority `lib/routes/_callers.js`'s
 * `_hasDelegatedLifecycleAuthority` already provides (#2824): that
 * authority lives only as long as an open control assignment names the
 * caller project in `authority.lifecycle`. This module's config is a
 * standing relationship an operator sets up once, independent of any
 * active sprint assignment, and persisted per subordinate project as its
 * own JSON file (`medusa-registry.js`'s own `_load`/`_save` pattern) --
 * never a new SQL column, since `lib/store.js`/`lib/store/_schema.js`
 * are outside this module's file scope.
 *
 * @module lib/session-hierarchy
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const tcProjectFiles = require('./tangleclaw-project-files');
const medusaRegistry = require('./medusa-registry');
const sharedDocsAccess = require('./shared-docs-access');
const { createLogger } = require('./logger');

const log = createLogger('session-hierarchy');

/** `<projectPath>/.tangleclaw/session-hierarchy.json` */
const HIERARCHY_RELPATH = '.tangleclaw/session-hierarchy.json';

/** Scopes an operator may delegate to a configured superior. */
const DELEGABLE_SCOPES = Object.freeze(['plan', 'build', 'pr', 'wrap', 'clear']);

/**
 * Operator-reserved actions. Always refused to a superior, however
 * `delegatedScope` is written, and whatever any OTHER authority mechanism
 * grants the same caller through a different path (#2824, the Master) --
 * this list exists so a misconfiguration here can never hand a peer
 * session one of these; it is this module's own floor, not a cross-check
 * of someone else's.
 */
const RESERVED_SCOPES = Object.freeze([
  'external_pr', 'release', 'ci', 'deploy', 'secrets',
  'delete_data', 'service_restart', 'delete_project', 'kill_session'
]);

/**
 * @param {string} projectPath
 * @returns {string}
 */
function _hierarchyPath(projectPath) {
  return tcProjectFiles.resolveIn(projectPath, HIERARCHY_RELPATH);
}

/**
 * Validate and normalize a raw `{reportsTo, delegatedScope}` hierarchy
 * config. A reserved or unrecognized scope is a validation ERROR, never a
 * silent drop -- a misconfiguration here must be visible to whoever wrote
 * it, not quietly narrowed into something that happens to be safe.
 * @param {*} raw
 * @returns {{ok: true, config: {reportsTo: string, delegatedScope: string[]}}|{ok: false, errors: string[]}}
 */
function normalizeHierarchyConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const reportsTo = raw.reportsTo;
  if (typeof reportsTo !== 'string' || reportsTo.trim() === '') {
    errors.push('reportsTo must be a non-empty project name or id string');
  }
  const scopeInput = raw.delegatedScope;
  if (!Array.isArray(scopeInput)) {
    errors.push('delegatedScope must be an array');
  } else {
    for (const scope of scopeInput) {
      if (typeof scope !== 'string') {
        errors.push('delegatedScope entries must be strings');
      } else if (RESERVED_SCOPES.includes(scope)) {
        errors.push(`"${scope}" is operator-reserved and can never be delegated`);
      } else if (!DELEGABLE_SCOPES.includes(scope)) {
        errors.push(`"${scope}" is not a recognized delegable scope (${DELEGABLE_SCOPES.join(', ')})`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { reportsTo: reportsTo.trim(), delegatedScope: [...new Set(scopeInput)] } };
}

/**
 * Load a project's stored hierarchy config. Missing, corrupt, or
 * failed-validation file all read as "no hierarchy configured" (`null`),
 * logged rather than thrown -- a bad file on disk must not turn an
 * authority check into a crash; it turns it into a refusal instead,
 * which is the safe default for every caller below.
 * @param {string} projectPath
 * @returns {{reportsTo: string, delegatedScope: string[]}|null}
 */
function _load(projectPath) {
  const file = _hierarchyPath(projectPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    log.warn('Failed to read session-hierarchy config; treating as unset', { file, error: err.message });
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('session-hierarchy config is corrupt JSON; treating as unset', { file, error: err.message });
    return null;
  }
  const normalized = normalizeHierarchyConfig(parsed);
  if (!normalized.ok) {
    log.warn('Stored session-hierarchy config failed validation; treating as unset', { file, errors: normalized.errors });
    return null;
  }
  return normalized.config;
}

/**
 * Persist a project's hierarchy config, creating `.tangleclaw/` if missing.
 * @param {string} projectPath
 * @param {{reportsTo: string, delegatedScope: string[]}} config - Already normalized.
 * @returns {void}
 */
function _save(projectPath, config) {
  const file = _hierarchyPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Read a subordinate project's configured hierarchy.
 * @param {{path: string}|null} project - A project row (needs `path`).
 * @returns {{reportsTo: string, delegatedScope: string[]}|null}
 */
function getConfig(project) {
  if (!project || !project.path) return null;
  return _load(project.path);
}

/**
 * Validate and persist a subordinate project's hierarchy config.
 * @param {{path: string}} project - A project row (needs `path`).
 * @param {*} raw - The config to validate and store.
 * @returns {{ok: true, config: {reportsTo: string, delegatedScope: string[]}}|{ok: false, errors: string[]}}
 */
function setConfig(project, raw) {
  if (!project || !project.path) return { ok: false, errors: ['project (with a path) is required'] };
  const normalized = normalizeHierarchyConfig(raw);
  if (!normalized.ok) return normalized;
  _save(project.path, normalized.config);
  return normalized;
}

/**
 * Remove a subordinate project's hierarchy config, if any.
 * @param {{path: string}} project
 * @returns {boolean} `true` if a config was removed, `false` if none existed.
 */
function clearConfig(project) {
  if (!project || !project.path) return false;
  const file = _hierarchyPath(project.path);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Resolve a configured `reportsTo` string (a numeric id, or a project
 * name) to the superior's live project row.
 * @param {string} reportsTo
 * @returns {object|null}
 */
function _resolveSuperiorProject(reportsTo) {
  const trimmed = reportsTo.trim();
  const asId = Number(trimmed);
  if (Number.isSafeInteger(asId) && String(asId) === trimmed) {
    return store.projects.get(asId);
  }
  return store.projects.getByName(trimmed);
}

/**
 * Whether `callerContext` is `subordinateProject`'s configured superior AT
 * ALL, independent of `delegatedScope` -- for the one place that
 * distinguishes "a configured superior, explicitly refused" from "not a
 * superior at all": the kill/delete routes' `SUPERIOR_ACTION_FORBIDDEN`
 * refusal. `canSuperiorExecute` already refuses a reserved action
 * unconditionally; this is a NARROWER, purely diagnostic question for a
 * clearer error, never a looser gate -- nothing here grants anything.
 * @param {{id: number, path: string}|null} subordinateProject
 * @param {{kind: string, projectId?: number}|null} callerContext
 * @returns {boolean}
 */
function isConfiguredSuperior(subordinateProject, callerContext) {
  if (!subordinateProject || !callerContext || callerContext.kind !== sharedDocsAccess.KINDS.PROJECT) return false;
  if (typeof callerContext.projectId !== 'number' || callerContext.projectId === subordinateProject.id) return false;
  const config = getConfig(subordinateProject);
  if (!config) return false;
  const superior = _resolveSuperiorProject(config.reportsTo);
  return !!superior && superior.id === callerContext.projectId;
}

/**
 * Whether the configured superior may execute `action` against
 * `subordinateProject`, for the verified caller context
 * `sharedDocsAccess.resolveAccess` already proved -- never anything the
 * request body itself claims. Reserved actions are refused
 * unconditionally, checked FIRST, before the subordinate's own config is
 * even read: no stored config, however written, can reach them.
 * @param {{id: number, path: string}|null} subordinateProject - The target project row.
 * @param {{kind: string, projectId?: number}|null} callerContext - From `sharedDocsAccess.resolveAccess`.
 * @param {string} action - One of `DELEGABLE_SCOPES` (or a reserved one, always refused).
 * @returns {boolean}
 */
function canSuperiorExecute(subordinateProject, callerContext, action) {
  if (RESERVED_SCOPES.includes(action)) return false;
  if (!subordinateProject || !callerContext || callerContext.kind !== sharedDocsAccess.KINDS.PROJECT) return false;
  if (typeof callerContext.projectId !== 'number') return false;
  if (callerContext.projectId === subordinateProject.id) return false;
  const config = getConfig(subordinateProject);
  if (!config || !config.delegatedScope.includes(action)) return false;
  const superior = _resolveSuperiorProject(config.reportsTo);
  return !!superior && superior.id === callerContext.projectId;
}

/**
 * Whether `fromWorkspaceId` is the subordinate's configured superior's
 * CURRENT active session's workspace id -- never a historical or stale
 * one, the same discipline `_requireSessionLifecycleCaller` applies to a
 * launch-bound HTTP caller. A superior that has since relaunched (and so
 * minted a new workspace id) is not authenticated by its old one.
 * @param {{path: string}|null} subordinateProject - The target project row.
 * @param {string|null|undefined} fromWorkspaceId - The Medusa envelope's `from`.
 * @returns {boolean}
 */
function isAuthorizedSuperiorSender(subordinateProject, fromWorkspaceId) {
  if (!subordinateProject || typeof fromWorkspaceId !== 'string' || fromWorkspaceId === '') return false;
  const config = getConfig(subordinateProject);
  if (!config) return false;
  const superior = _resolveSuperiorProject(config.reportsTo);
  if (!superior) return false;
  const activeSession = store.sessions.getActive(superior.id);
  if (!activeSession) return false;
  const currentWorkspaceId = medusaRegistry.getWorkspaceId(superior.path, activeSession.id);
  return currentWorkspaceId !== null && currentWorkspaceId === fromWorkspaceId;
}

/**
 * Every live project configured to report to `superiorProject`, with its
 * config -- the reverse lookup the SUPERIOR's own primer needs (config is
 * stored per SUBORDINATE, so finding who reports to a given project means
 * scanning, not a single read). Cheap at the scale this is for: once per
 * primer build, over `store.projects.list()`, each read a tiny local JSON
 * file.
 * @param {{id: number}} superiorProject
 * @returns {Array<{project: object, config: {reportsTo: string, delegatedScope: string[]}}>}
 */
function findSubordinatesOf(superiorProject) {
  if (!superiorProject) return [];
  const found = [];
  for (const candidate of store.projects.list()) {
    if (candidate.id === superiorProject.id) continue;
    const config = getConfig(candidate);
    if (!config) continue;
    const superior = _resolveSuperiorProject(config.reportsTo);
    if (superior && superior.id === superiorProject.id) found.push({ project: candidate, config });
  }
  return found;
}

/**
 * Deterministic startup text for the SUBORDINATE's own primer: names its
 * superior, its delegated scopes, the wrap/clear handshake it must honor,
 * and the fixed reserved list no delegation can ever reach.
 * @param {string} subordinateProjectName
 * @param {{reportsTo: string, delegatedScope: string[]}} config
 * @returns {string}
 */
function generateSubordinateInstructions(subordinateProjectName, config) {
  const scopes = config.delegatedScope.length > 0 ? config.delegatedScope.join(', ') : '(none)';
  return [
    '## Session Hierarchy',
    `This project (**${subordinateProjectName}**) reports to **${config.reportsTo}** (#1578).`,
    `Delegated scopes: ${scopes}.`,
    'Handshake: when the superior sends "prepare to wrap" or "prepare to clear", commit your work, '
      + 'write your handoff notes, and reply "ready" BEFORE the superior issues the actual wrap/clear '
      + 'call. Never act on an instruction as if it already authorized the action unless it is in '
      + 'those exact terms.',
    `Never delegable, whatever is configured, from anyone but the operator: ${RESERVED_SCOPES.join(', ')}.`
  ].join('\n');
}

/**
 * Deterministic startup text for the SUPERIOR's own primer: names the
 * subordinate and what it may direct.
 * @param {string} subordinateProjectName
 * @param {{reportsTo: string, delegatedScope: string[]}} config
 * @returns {string}
 */
function generateSuperiorInstructions(subordinateProjectName, config) {
  const scopes = config.delegatedScope.length > 0 ? config.delegatedScope.join(', ') : '(none)';
  return [
    '## Session Hierarchy',
    `**${subordinateProjectName}** reports to this project (#1578).`,
    `You may direct it within: ${scopes}.`,
    'Handshake: send "prepare to wrap" or "prepare to clear" and wait for its "ready" reply before '
      + 'issuing the actual wrap/clear call.',
    `Never yours to direct, whatever is configured: ${RESERVED_SCOPES.join(', ')} -- these stay operator-only.`
  ].join('\n');
}

module.exports = {
  DELEGABLE_SCOPES,
  RESERVED_SCOPES,
  normalizeHierarchyConfig,
  getConfig,
  setConfig,
  clearConfig,
  isConfiguredSuperior,
  canSuperiorExecute,
  isAuthorizedSuperiorSender,
  findSubordinatesOf,
  generateSubordinateInstructions,
  generateSuperiorInstructions
};
