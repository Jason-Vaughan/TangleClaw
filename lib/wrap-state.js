'use strict';

/**
 * TangleClaw's per-checkout wrap state, kept in `.tangleclaw/state.json` (#1510).
 *
 * The wrap boundary (`lastWrapSha`) used to live in `.tangleclaw/project.json`.
 * Many projects track that file, because the rest of it is durable config, so
 * every wrap left a tracked file changed and the next session started dirty.
 * The boundary describes one checkout on one machine, not the project, so it
 * belongs in a file git does not track.
 *
 * This module is the only reader and writer of that value. A project that has
 * not been migrated yet still has the key in `project.json`; the reader falls
 * back to it so the boundary is never lost, and `migrateProjectConfig` moves it.
 *
 * Record shape (`schema: 1`):
 * - `lastWrapSha` — the base the next session measures its range from.
 * - `lastWrapStampedAt`, `lastWrapStampedBy` — when, and by which TangleClaw version.
 * - `migratedFromProjectConfigAt` — when a legacy value was adopted, else absent.
 *
 * Which workspace id a checkout holds is answered by `medusa/registry.json`,
 * not here.
 */

const fs = require('node:fs');
const path = require('node:path');
const tcProjectFiles = require('./tangleclaw-project-files');

/** The record format this module reads and writes. */
const SCHEMA = 1;

/** The project.json key this module took over. */
const LEGACY_KEY = 'lastWrapSha';

/**
 * Absolute path of a checkout's state file.
 *
 * @param {string} projectPath - Absolute project root.
 * @returns {string}
 */
function statePath(projectPath) {
  return tcProjectFiles.resolveIn(projectPath, tcProjectFiles.WRAP_STATE_RELPATH);
}

/**
 * Absolute path of a checkout's project.json.
 *
 * @param {string} projectPath - Absolute project root.
 * @returns {string}
 */
function _projectConfigPath(projectPath) {
  return path.join(projectPath, '.tangleclaw', 'project.json');
}

/**
 * Read the state record.
 *
 * @param {string} projectPath - Absolute project root.
 * @returns {{record:(object|null), read:('present'|'absent'|'unreadable'), error:(string|null)}}
 *   `unreadable` covers an unparseable file, a non-object, and a schema this
 *   module does not know — a future format is refused rather than misread.
 */
function readState(projectPath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(projectPath), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { record: null, read: 'absent', error: null };
    return { record: null, read: 'unreadable', error: err.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { record: null, read: 'unreadable', error: err.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { record: null, read: 'unreadable', error: 'state file is not a JSON object' };
  }
  if (parsed.schema !== SCHEMA) {
    return { record: null, read: 'unreadable', error: `unknown state schema ${JSON.stringify(parsed.schema)}` };
  }
  return { record: parsed, read: 'present', error: null };
}

/**
 * Write the state record atomically (temp file + rename), creating
 * `.tangleclaw/` when needed. Throws on failure; callers decide how fatal it is.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {object} record - The full record; `schema` is set here.
 * @returns {void}
 */
function _writeState(projectPath, record) {
  const file = statePath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...record, schema: SCHEMA }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Whether a value is a usable recorded boundary.
 *
 * @param {*} v
 * @returns {boolean}
 */
function _isSha(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Raw-read project.json. Deliberately not `projectConfig.load`: that returns
 * defaults for an unparseable file, which would read as "no boundary" when one
 * is sitting on disk unread.
 *
 * @param {string} projectPath - Absolute project root.
 * @returns {{config:(object|null), read:('present'|'absent'|'unreadable'), error:(string|null)}}
 */
function _readProjectConfigRaw(projectPath) {
  let raw;
  try {
    raw = fs.readFileSync(_projectConfigPath(projectPath), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { config: null, read: 'absent', error: null };
    return { config: null, read: 'unreadable', error: err.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: null, read: 'unreadable', error: 'project.json is not a JSON object' };
    }
    return { config: parsed, read: 'present', error: null };
  } catch (err) {
    return { config: null, read: 'unreadable', error: err.message };
  }
}

/**
 * The boundary the previous wrap left, and how it was established.
 *
 * `absent` and `unreadable` stay distinct because a consumer acts on the
 * difference: with no boundary it may treat the branch range as the session's
 * work, and with an unreadable one it must not (#797).
 *
 * @param {string} projectPath - Absolute path of the registered checkout.
 * @returns {{sha:(string|null), read:('recorded'|'absent'|'unreadable'), source:('state'|'project-config'|null), error:(string|null)}}
 */
function readLastWrapSha(projectPath) {
  const state = readState(projectPath);
  if (state.read === 'unreadable') return { sha: null, read: 'unreadable', source: 'state', error: state.error };
  if (state.read === 'present' && _isSha(state.record.lastWrapSha)) {
    return { sha: state.record.lastWrapSha, read: 'recorded', source: 'state', error: null };
  }
  // No boundary in the state file: a checkout not migrated yet keeps it in project.json.
  const cfg = _readProjectConfigRaw(projectPath);
  if (cfg.read === 'unreadable') return { sha: null, read: 'unreadable', source: 'project-config', error: cfg.error };
  if (cfg.read === 'present' && _isSha(cfg.config[LEGACY_KEY])) {
    return { sha: cfg.config[LEGACY_KEY], read: 'recorded', source: 'project-config', error: null };
  }
  return { sha: null, read: 'absent', source: null, error: null };
}

/**
 * The running TangleClaw version, for the stamp. Null when unreadable.
 *
 * @returns {string|null}
 */
function _tcVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * Record a new wrap boundary. Never touches project.json. An unreadable state
 * file is replaced: the stamp is the newest truth, and keeping a file nobody
 * can read preserves nothing.
 *
 * @param {string} projectPath - Absolute path of the registered checkout.
 * @param {string} sha - The new boundary.
 * @param {object} [opts]
 * @param {() => Date} [opts.now] - Test seam.
 * @param {string|null} [opts.version] - Test seam for the stamping version.
 * @returns {void} Throws when the file cannot be written.
 */
function stampLastWrapSha(projectPath, sha, opts = {}) {
  const now = (opts.now || (() => new Date()))();
  const current = readState(projectPath);
  const base = current.read === 'present' ? current.record : {};
  _writeState(projectPath, {
    ...base,
    lastWrapSha: sha,
    lastWrapStampedAt: now.toISOString(),
    lastWrapStampedBy: opts.version !== undefined ? opts.version : _tcVersion()
  });
}

/**
 * Take over a boundary found in project.json, unless the state file already
 * records one — a recorded value is newer than anything left in project.json.
 *
 * @param {string} projectPath - Absolute path of the registered checkout.
 * @param {*} legacySha - The value found under `lastWrapSha`.
 * @param {object} [opts]
 * @param {() => Date} [opts.now] - Test seam.
 * @returns {{adopted:boolean, reason:string}} Throws when the state file cannot be written.
 */
function adoptLegacyLastWrapSha(projectPath, legacySha, opts = {}) {
  if (!_isSha(legacySha)) return { adopted: false, reason: 'no legacy boundary to adopt' };
  const current = readState(projectPath);
  if (current.read === 'present' && _isSha(current.record.lastWrapSha)) {
    return { adopted: false, reason: 'state file already records a boundary' };
  }
  const now = (opts.now || (() => new Date()))();
  const base = current.read === 'present' ? current.record : {};
  _writeState(projectPath, { ...base, lastWrapSha: legacySha, migratedFromProjectConfigAt: now.toISOString() });
  return { adopted: true, reason: 'adopted from project.json' };
}

/**
 * Move `lastWrapSha` out of project.json: adopt it into the state file, then
 * rewrite project.json without that one key, in the serialization
 * `store.projectConfig.save` uses. Idempotent — a file without the key is not
 * written. An unparseable project.json is left untouched.
 *
 * @param {string} projectPath - Absolute path of the registered checkout.
 * @param {object} [opts]
 * @param {() => Date} [opts.now] - Test seam.
 * @returns {{migrated:boolean, reason:string}}
 */
function migrateProjectConfig(projectPath, opts = {}) {
  const cfg = _readProjectConfigRaw(projectPath);
  if (cfg.read === 'absent') return { migrated: false, reason: 'no project.json' };
  if (cfg.read === 'unreadable') return { migrated: false, reason: `project.json could not be read: ${cfg.error}` };
  if (!Object.prototype.hasOwnProperty.call(cfg.config, LEGACY_KEY)) {
    return { migrated: false, reason: 'project.json holds no lastWrapSha' };
  }
  try {
    adoptLegacyLastWrapSha(projectPath, cfg.config[LEGACY_KEY], opts);
    const rest = { ...cfg.config };
    delete rest[LEGACY_KEY];
    fs.writeFileSync(_projectConfigPath(projectPath), JSON.stringify(rest, null, 2) + '\n');
  } catch (err) {
    return { migrated: false, reason: `could not move lastWrapSha: ${err.message}` };
  }
  return { migrated: true, reason: 'moved lastWrapSha from project.json to the untracked state file' };
}

module.exports = {
  SCHEMA,
  LEGACY_KEY,
  statePath,
  readState,
  readLastWrapSha,
  stampLastWrapSha,
  adoptLegacyLastWrapSha,
  migrateProjectConfig
};
