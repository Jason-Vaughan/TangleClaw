'use strict';

/**
 * Write a file so no reader can ever observe a partial version, and collect the
 * corpses that failing to do so leaves behind.
 *
 * WHY THIS IS ONE MODULE AND NOT A PATTERN EACH CALLER REBUILDS. Every writer
 * that runs inside `lib/dir-scanner-child.js` needs this, and needs it for the
 * same reason: the supervisor SIGKILLs that process mid-syscall with no chance
 * to clean up, and `writeFileSync` straight to the destination truncates it
 * first — so a kill in that window leaves a zero-length or half-written file
 * that the next reader parses without complaint. `rename(2)` within one
 * directory is atomic on POSIX, so a reader sees either the previous file or the
 * complete new one.
 *
 * The second and third writers arrived a chunk apart and the second one
 * reconstructed the first's cleanup line for line. A mechanism that is
 * reconstructed rather than modelled drifts as soon as one copy is fixed, and
 * the defect class here — a partially-observable write — is one nobody notices
 * from reading the code that has it.
 *
 * Deliberately dependency-free: it is required by modules the scanner child
 * loads, which may not reach the database or anything that opens it.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * How old a staging file must be before the sweep treats it as a corpse.
 *
 * NOT a tidiness margin. Several processes legitimately write into one directory
 * — the scanner child on a poll, the server at session launch and wrap, two
 * uploads from different sessions — so a staging file the sweep finds may be
 * another writer's, staged milliseconds ago and about to be renamed. Unlinking
 * it makes that writer's rename fail for no reason.
 *
 * The separation is guaranteed rather than merely likely, and by something
 * outside this file: no staged write performed inside the scanner child can
 * outlive its caller's deadline, because the supervisor kills the process
 * performing it. Every such deadline today is single-digit seconds, so a staging
 * file older than this threshold cannot belong to a writer that is still
 * running. A caller that ever sets a deadline near a minute has to revisit this.
 */
const STAGING_STALE_MS = 60_000;

/**
 * Absolute path of a fresh staging file beside `file`.
 *
 * The name carries the pid and four random bytes because several processes
 * legitimately write into one directory, and a shared staging name would let one
 * writer truncate another's half-written file — reintroducing exactly the
 * partial-write window the staging exists to close. It is a sibling of the
 * destination so the rename cannot cross a filesystem boundary, which is the one
 * condition that would turn it back into a copy and with it back into a
 * partially-observable write.
 *
 * @param {string} dir - Directory holding the destination.
 * @param {string} prefix - The caller's staging-name prefix.
 * @returns {string}
 */
function stagingPath(dir, prefix) {
  return path.join(dir, `${prefix}${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

/**
 * Delete staging files stranded by a process that died before its rename.
 *
 * The realistic source of those deaths is not the caller's own write: one
 * unreadable directory anywhere kills the shared scanner child, and every
 * in-flight staged write dies with it. Sweeping on each successful write bounds
 * the leak for a directory that keeps receiving writes; a directory that never
 * receives another one keeps its stray, which is the honest limit of a sweep
 * that only runs on the write path.
 *
 * Best-effort by construction — this is cleanup, and failing it must never fail
 * the write that just succeeded.
 *
 * @param {string} dir - The directory to sweep.
 * @param {string} prefix - Only names starting with this are candidates.
 * @param {string} mine - Absolute path of the staging file this writer used and
 *   has already renamed. Skipped, because the name may have been reused since.
 * @returns {void}
 */
function sweepStagingFiles(dir, prefix, mine) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // unreadable directory — the write already succeeded, so say nothing
  }
  const staleBefore = Date.now() - STAGING_STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const full = path.join(dir, name);
    if (full === mine) continue;
    try {
      if (fs.statSync(full).mtimeMs >= staleBefore) continue; // a live write, not a corpse
      fs.unlinkSync(full);
    } catch {
      // It vanished between the readdir and here — the normal outcome when the
      // writer that owns it finished its rename — or it is as unremovable as it
      // was unwritable. Either way the next successful write tries again.
    }
  }
}

/**
 * Write `contents` to `file` atomically, then sweep the directory's strays.
 *
 * Throws rather than reporting, because whether a failed write is fatal is the
 * caller's question and not this module's: one caller degrades to serving a
 * stale version, another must tell the operator the upload did not save. The
 * staging file is removed on the way out either way, so a failure leaves nothing
 * behind for the sweep to find later.
 *
 * A string is written as UTF-8 and a Buffer verbatim, which is `writeFileSync`'s
 * own default — no encoding argument is offered, so no caller can pick one that
 * disagrees with what its reader expects.
 *
 * @param {string} file - Absolute destination path. Its directory must exist.
 * @param {Buffer|string} contents - What to write.
 * @param {string} prefix - Staging-name prefix, distinct per caller so one
 *   caller's sweep cannot claim another's staging files in a shared directory.
 * @returns {void}
 * @throws Whatever the underlying write or rename throws.
 */
function writeAtomic(file, contents, prefix) {
  const dir = path.dirname(file);
  const tmp = stagingPath(dir, prefix);
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (err) {
    // A staging file left behind is invisible to every reader (they name the
    // destination), but it would accumulate one per failed write.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // It was never created, or it is as unremovable as it was unwritable.
    }
    throw err;
  }
  sweepStagingFiles(dir, prefix, tmp);
}

module.exports = { writeAtomic, sweepStagingFiles, stagingPath, STAGING_STALE_MS };
