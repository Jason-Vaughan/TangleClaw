'use strict';

/**
 * Medusa workspace-id registry (MED-2K9P Chunk 01).
 *
 * Maps a TC session to a STABLE Medusa workspace id and persists it at
 * `<projectPath>/.tangleclaw/medusa/registry.json` so a session keeps the same
 * addressable id across reconnects and TC-server restarts. The registry is a
 * plain JSON map of `sessionId` → `{ sessionId, workspaceId, name, createdAt }`.
 *
 * A missing or corrupt registry file is treated as an empty registry (logged as
 * a warning, never thrown) — a bad file must not wedge the listener.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('./logger');

const log = createLogger('medusa-registry');

/**
 * Resolve the registry file path for a project.
 * @param {string} projectPath - Absolute path to the project directory.
 * @returns {string} Absolute path to `<projectPath>/.tangleclaw/medusa/registry.json`.
 */
function _registryPath(projectPath) {
  return path.join(projectPath, '.tangleclaw', 'medusa', 'registry.json');
}

/**
 * Slugify a workspace name: lowercase, non-alphanumerics collapse to `-`, and
 * leading/trailing hyphens trimmed. Falls back to `workspace` when a name has
 * no alphanumeric characters.
 * @param {string} name - Human-readable workspace/session name.
 * @returns {string} A URL-safe slug.
 */
function _slug(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

/**
 * Mint a new stable workspace id of the form `<name-slug>-<8-hex>`.
 * The 8-hex suffix is random (via `crypto.randomBytes`) so ids don't collide;
 * callers persist the result so it is minted once and reused thereafter.
 * @param {string} name - Human-readable workspace/session name.
 * @returns {string} A freshly minted workspace id.
 */
function _mintId(name) {
  const hex = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  return `${_slug(name)}-${hex}`;
}

/**
 * Load the registry map for a project. Missing file → empty map. A corrupt or
 * non-object file is logged and treated as empty rather than thrown.
 * @param {string} projectPath - Absolute path to the project directory.
 * @returns {Object<string, {sessionId: (string|number), workspaceId: string, name: string, createdAt: string}>}
 */
function _load(projectPath) {
  const file = _registryPath(projectPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    log.warn('Failed to read Medusa registry; treating as empty', { file, error: err.message });
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('Medusa registry is not an object; treating as empty', { file });
      return {};
    }
    return parsed;
  } catch (err) {
    log.warn('Medusa registry is corrupt JSON; treating as empty', { file, error: err.message });
    return {};
  }
}

/**
 * Persist the registry map for a project, creating `.tangleclaw/medusa/` if
 * missing. Write failures are logged with context (not silently swallowed).
 * @param {string} projectPath - Absolute path to the project directory.
 * @param {Object} data - The registry map to persist.
 * @returns {void}
 */
function _save(projectPath, data) {
  const file = _registryPath(projectPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (err) {
    log.error('Failed to persist Medusa registry', { file, error: err.message });
    throw err;
  }
}

/**
 * Return the existing workspace id for a session, minting and persisting a new
 * one if absent. Idempotent: a second call for the same session returns the
 * same id (that stability is the contract — the random hex is chosen once).
 * @param {string} projectPath - Absolute path to the project directory.
 * @param {string|number} sessionId - The TC session id.
 * @param {string} name - Human-readable name used to build the id slug.
 * @returns {string} The stable workspace id for this session.
 */
function ensureWorkspaceId(projectPath, sessionId, name) {
  const key = String(sessionId);
  const data = _load(projectPath);
  if (data[key] && data[key].workspaceId) {
    return data[key].workspaceId;
  }
  const workspaceId = _mintId(name);
  data[key] = { sessionId, workspaceId, name, createdAt: new Date().toISOString() };
  _save(projectPath, data);
  log.info('Minted Medusa workspace id', { sessionId: key, workspaceId });
  return workspaceId;
}

/**
 * Look up the persisted workspace id for a session without minting.
 * @param {string} projectPath - Absolute path to the project directory.
 * @param {string|number} sessionId - The TC session id.
 * @returns {string|null} The workspace id, or `null` if none is registered.
 */
function getWorkspaceId(projectPath, sessionId) {
  const entry = _load(projectPath)[String(sessionId)];
  return entry && entry.workspaceId ? entry.workspaceId : null;
}

/**
 * Remove a session's registry entry and persist. Used by later chunks on
 * session end / toggle-off. Idempotent — forgetting an unknown session is a
 * no-op that returns `false`.
 * @param {string} projectPath - Absolute path to the project directory.
 * @param {string|number} sessionId - The TC session id.
 * @returns {boolean} `true` if an entry was removed, `false` if none existed.
 */
function forgetWorkspace(projectPath, sessionId) {
  const key = String(sessionId);
  const data = _load(projectPath);
  if (!(key in data)) return false;
  delete data[key];
  _save(projectPath, data);
  log.info('Forgot Medusa workspace id', { sessionId: key });
  return true;
}

module.exports = {
  ensureWorkspaceId,
  getWorkspaceId,
  forgetWorkspace
};
