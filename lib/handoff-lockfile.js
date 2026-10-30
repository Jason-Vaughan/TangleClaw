'use strict';

/**
 * The handoff lockfile on disk (Train 21, #1585).
 *
 * Everything lives under `<configRoot>/.tangleclaw/handoff/`, beside continuity
 * and for the same reason: the registered checkout is the one place that exists
 * whichever worktree a session happened to wrap from.
 *
 *   current.json                  the eligible handoff
 *   staged-<publicationId>.json   an attempt that has not been published
 *   history/<publicationId>.json  publications a newer one replaced
 *
 * A filesystem rename cannot join a SQL transaction, so a crash can always land
 * between renaming a file and recording that it happened. This module therefore
 * never treats a rename as proof the DB was updated — it reports what it
 * observed and leaves the judgement to the caller, which is what makes
 * reconciliation possible at all.
 */

const fs = require('node:fs');
const path = require('node:path');

const { configRootOf } = require('./wrap-steps/_config-root.js');
const { readDocument, serializeDocument, digestOf } = require('./handoff-publication.js');

/**
 * The handoff directory for a project.
 * @param {object} project - Project record (uses its registered checkout)
 * @returns {string} Absolute path, which may not exist yet
 */
function handoffDir(project) {
  return path.join(configRootOf(project), '.tangleclaw', 'handoff');
}

/**
 * Path of the current (eligible) handoff.
 * @param {object} project - Project record
 * @returns {string} Absolute path
 */
function currentPath(project) {
  return path.join(handoffDir(project), 'current.json');
}

/**
 * Path of a staged attempt.
 * @param {object} project - Project record
 * @param {string} publicationId - Attempt id
 * @returns {string} Absolute path
 */
function stagedPath(project, publicationId) {
  return path.join(handoffDir(project), `staged-${publicationId}.json`);
}

/**
 * Path a superseded publication is kept at.
 * @param {object} project - Project record
 * @param {string} publicationId - Attempt id
 * @returns {string} Absolute path
 */
function historyPath(project, publicationId) {
  return path.join(handoffDir(project), 'history', `${publicationId}.json`);
}

/**
 * Read a handoff file, distinguishing "there was nothing to read" from "the
 * read failed" — they are different facts and only one of them is a problem.
 *
 * A bare `existsSync` cannot tell ENOENT from EACCES, so this reads and
 * inspects the errno instead: an unreadable file is reported as `unreadable`,
 * never quietly as absent (a permission problem would otherwise look exactly
 * like a first launch).
 * @param {string} file - Absolute path
 * @returns {{outcome: string, doc: object|null, digest: string|null, reason: string|null, raw: string|null}}
 */
function readHandoffFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { outcome: 'absent', doc: null, digest: null, reason: null, raw: null };
    }
    return {
      outcome: 'unreadable',
      doc: null,
      digest: null,
      reason: `${err.code || 'read failed'}: ${err.message}`,
      raw: null
    };
  }
  return { ...readDocument(raw), raw };
}

/**
 * Write a staged attempt's bytes durably: a temp file in the same directory,
 * then a rename, so a reader never sees a half-written document.
 *
 * Returns the digest of exactly the bytes written, which is the value the DB
 * row stores. Digesting anything else — a re-serialization, the document
 * object — would let the two drift apart.
 * @param {object} project - Project record
 * @param {object} doc - Document from `buildHandoffDocument`
 * @returns {{path: string, digest: string, bytes: number}}
 */
function writeStaged(project, doc) {
  const dir = handoffDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const text = serializeDocument(doc);
  const finalPath = stagedPath(project, doc.publicationId);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, finalPath);
  return { path: finalPath, digest: digestOf(text), bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Move the staged attempt into place as `current.json`, retiring whatever was
 * there into `history/`.
 *
 * The order is fixed and matters (plan §2.6 step 3): retire the old file first,
 * then rename the new one in. Doing it the other way round would destroy the
 * old publication's bytes before they were preserved, and a crash between the
 * two steps would leave nothing to reconstruct from.
 *
 * @param {object} project - Project record
 * @param {string} publicationId - The attempt becoming current
 * @param {string|null} previousId - The publication being retired, if any
 * @returns {{retired: boolean, previousId: string|null}} What actually moved
 * @throws {Error} When the staged file is missing — the caller must not then
 *   record a publication that has no bytes behind it.
 */
function promoteStaged(project, publicationId, previousId) {
  const staged = stagedPath(project, publicationId);
  if (!fs.existsSync(staged)) {
    throw new Error(`cannot publish ${publicationId}: its staged file is missing at ${staged}`);
  }
  const current = currentPath(project);

  let retired = false;
  if (previousId && fs.existsSync(current)) {
    // Retire it under the name it actually carries, never under the id the DB
    // merely expects. If the two disagree, the file is evidence of a state
    // nobody recorded — filing it as `previousId` would overwrite that
    // publication's history entry with a different document and destroy both
    // records at once.
    const existing = readHandoffFile(current);
    if (existing.outcome === 'ok' && existing.doc.publicationId !== previousId) {
      throw new Error(
        `refusing to retire current.json as ${previousId}: it names ${existing.doc.publicationId}`
      );
    }
    const dest = historyPath(project, previousId);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(current, dest);
    retired = true;
  }
  fs.renameSync(staged, current);
  return { retired, previousId: previousId || null };
}

/**
 * What the filesystem says right now, for reconciliation.
 *
 * Deliberately returns observations rather than a verdict: detection is pure
 * and proposes, application decides (plan §2.6). A function that returned
 * "repair this" would make the two inseparable.
 * @param {object} project - Project record
 * @returns {{dir: string, current: object, staged: string[]}}
 */
function observe(project) {
  const dir = handoffDir(project);
  const current = readHandoffFile(currentPath(project));

  let staged = [];
  try {
    staged = fs.readdirSync(dir)
      .filter((name) => name.startsWith('staged-') && name.endsWith('.json'))
      .map((name) => name.slice('staged-'.length, -'.json'.length));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { dir, current, staged };
}

/**
 * Unlink one path, reporting ENOENT as "nothing to remove" rather than an
 * error — any other errno is a real problem and is thrown.
 * @param {string} file - Absolute path
 * @returns {boolean} True when a file was actually removed
 */
function _unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Remove a pruned publication's bytes, wherever they ended up (#1602).
 *
 * A publication retired to `history/` (it was once published, then
 * displaced by a newer one) lives at `historyPath`; one that lost the race
 * before ever being promoted (`supersedeBeforePublish`) or was abandoned
 * (`abandonHandoff`, which deliberately leaves the staged file for
 * forensics) still lives at `stagedPath`. Both are attempted, both
 * ENOENT-safe, since a given id is normally at exactly one of the two.
 * @param {object} project - Project record
 * @param {string} publicationId - The pruned attempt
 * @returns {{removedStaged: boolean, removedHistory: boolean}}
 */
function removePublicationFiles(project, publicationId) {
  return {
    removedStaged: _unlinkIfPresent(stagedPath(project, publicationId)),
    removedHistory: _unlinkIfPresent(historyPath(project, publicationId))
  };
}

/**
 * Remove any `history/*.json` file whose publication id names no row
 * currently in the DB for this project (#1602) — drift from a prior partial
 * or crashed prune, not merely an old file (retention is enforced on the DB
 * rows; this only catches a file a prior sweep failed to retire with them).
 * @param {object} project - Project record
 * @param {string[]} retainedIds - Every publication id the DB still has for this project
 * @returns {string[]} Publication ids whose orphan file was removed
 */
function sweepOrphanHistoryFiles(project, retainedIds) {
  const retained = new Set(retainedIds);
  const dir = path.join(handoffDir(project), 'history');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const removed = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const publicationId = name.slice(0, -'.json'.length);
    if (retained.has(publicationId)) continue;
    if (_unlinkIfPresent(path.join(dir, name))) removed.push(publicationId);
  }
  return removed;
}

/**
 * Remove any `staged-<id>.json` file whose publication id names no row
 * currently in the DB for this project (#1602) — the mirror of
 * {@link sweepOrphanHistoryFiles} for the OTHER location a pruned row's
 * bytes can be at (lost-the-race or abandoned attempts never reach
 * `history/`). A live `staged` row's id is still in `retainedIds`
 * (`allIdsForProject` returns every id, any state), so an attempt still
 * mid-flight is never swept here — only a file with no DB row at all is.
 * @param {object} project - Project record
 * @param {string[]} retainedIds - Every publication id the DB still has for this project
 * @returns {string[]} Publication ids whose orphan file was removed
 */
function sweepOrphanStagedFiles(project, retainedIds) {
  const retained = new Set(retainedIds);
  const dir = handoffDir(project);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const removed = [];
  for (const name of names) {
    if (!name.startsWith('staged-') || !name.endsWith('.json')) continue;
    const publicationId = name.slice('staged-'.length, -'.json'.length);
    if (retained.has(publicationId)) continue;
    if (_unlinkIfPresent(path.join(dir, name))) removed.push(publicationId);
  }
  return removed;
}

module.exports = {
  handoffDir,
  currentPath,
  stagedPath,
  historyPath,
  readHandoffFile,
  writeStaged,
  promoteStaged,
  observe,
  removePublicationFiles,
  sweepOrphanHistoryFiles,
  sweepOrphanStagedFiles
};
