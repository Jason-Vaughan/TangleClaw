'use strict';

/**
 * Uploads, as the server sees them: every filesystem call performed in the
 * forked scanner child rather than on this process's event loop (#889).
 *
 * WHAT THIS BUYS, restated because it is not obvious from the call sites. The
 * three routes behind this module — `POST /api/upload`, `GET /api/uploads`, and
 * the session drill-down — all resolve to a path the operator chose. A
 * TCC-protected or stalled network mount does not fail a read of such a path,
 * it never answers one, and a synchronous call cannot be interrupted by any
 * deadline. `fs.promises` is not the fix: abandoning a promise does not cancel
 * the syscall, so the libuv threadpool thread is gone for good and four of them
 * end the server's ability to touch the filesystem at all. Only killing the
 * process that owns the blocked thread reclaims it, which is what
 * `lib/dir-scanner.js` supervises and `lib/uploads-fs.js` runs inside.
 *
 * THE INTERACTIVE SCANNER, DELIBERATELY. All three routes are things an
 * operator pressed a button for — attaching a file, opening the upload modal,
 * expanding a session. `dirScanner.request`'s per-path failure backoff exists
 * for the ten-second dashboard poll nobody asked for; answering a click from a
 * five-minute remembered refusal would tell an operator who has just granted
 * Full Disk Access that their uploads are still unreachable.
 */

const dirScanner = require('./dir-scanner');
const { createLogger } = require('./logger');

const log = createLogger('uploads');

/**
 * Largest upload body the server accepts, in bytes.
 *
 * Lives here rather than at the route because the deadline below is computed
 * from it: a cap raised at the route without moving the deadline would produce
 * uploads that are accepted and then killed for taking too long, which reads to
 * the operator as an unreadable directory.
 */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * How long a listing gets to answer.
 *
 * The work is a handful of `readdir`s and a `stat` per file on directories that
 * hold an operator's attachments — tens of entries, not thousands. The margin
 * is dominated by the fork and IPC round trip, not by the reads, so this is the
 * scanner's own default rather than a number derived from the work.
 */
const LIST_TIMEOUT_MS = 5000;

/**
 * How long a save gets to answer.
 *
 * DERIVED FROM THE CAP, NOT CHOSEN. The payload crosses the IPC channel as a
 * base64 string and is then decoded and written, so the floor scales with
 * {@link MAX_UPLOAD_BYTES}; 5 MB/s is a pessimistic figure for that pipeline on
 * a slow external disk. Expressed as arithmetic so raising the cap moves the
 * deadline with it — two numbers that must agree and are maintained separately
 * drift, and the failure that drift produces here is a successful upload
 * reported as a permissions problem.
 */
const SAVE_TIMEOUT_MS = 5000 + Math.ceil(MAX_UPLOAD_BYTES / (5 * 1024 * 1024)) * 1000;

/**
 * The remedy sentence for a path that never answered, and only for that.
 *
 * `tcTimedOut` is the one flag in the scanner's vocabulary that earns the Full
 * Disk Access advice — an `EACCES`, an aborted sibling, or a truncated walk all
 * mean something else, and sending an operator to change a privacy setting that
 * was never the problem is the misdiagnosis the scanner exists to remove.
 * @param {Error & {tcTimedOut?: boolean}} [err]
 * @returns {string|null}
 */
function _hintFor(err) {
  if (!err || !err.tcTimedOut) return null;
  return 'the directory did not respond. On macOS that is what a protected folder does when '
    + 'node has no Full Disk Access. Grant it, or move the project outside ~/Documents, '
    + '~/Desktop and ~/Downloads';
}

/**
 * List every upload a project holds, tagged with its session and secret-scan
 * flag, newest first.
 *
 * NEVER REPORTS A FAILED READ AS AN EMPTY LIST. An unreadable uploads directory
 * and a project that has never had an upload are different facts, and `[]`
 * answers only the second — returned for the first it tells the operator their
 * files are gone. `unreadable` names the refusal, `unreadableCode` classifies it
 * in the scanner's existing vocabulary (`SCAN_TIMEOUT` / `SCAN_CACHED` /
 * `SCAN_ABORTED` / `SCAN_FAILED`, or the filesystem's own errno where the
 * filesystem replied), and `uploads` still carries whatever WAS readable.
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {Promise<{uploads: Array<{path: string, name: string, size: number,
 *   createdAt: string, session: string|null, secretsFlagged: boolean,
 *   secretTypes: string[]}>, unreadable: string|null, unreadableHint: string|null,
 *   unreadableCode: string|null}>}
 */
async function listUploads(projectPath) {
  try {
    const result = await dirScanner.interactiveRequest(
      'listUploads',
      { projectPath },
      { timeoutMs: LIST_TIMEOUT_MS, what: `listing uploads under ${projectPath}` }
    );
    return {
      uploads: result.uploads,
      // Carries the filesystem's own message, absolute path included. That is
      // consistent rather than a leak: every entry in `uploads` already reports
      // an absolute `path`, because handing one to an assistant is what the
      // feature is for, and this route sits behind the same gate they do. The
      // wizard's rule — free-text errors naming paths stay server-side — is
      // about a pre-auth surface, which this is not.
      unreadable: result.unreadable,
      // A refusal the filesystem answered needs no remedy sentence: the operator
      // is not missing a permission macOS would grant, the directory said no.
      unreadableHint: null,
      unreadableCode: result.code || null
    };
  } catch (err) {
    const hint = _hintFor(err);
    // Always at warn. `lib/project-facts.js` drops a cached refusal to debug,
    // and that branch would be dead here: `tcCached` is set only inside the
    // supervisor's `if (pathKey)`, and none of these calls opt into the backoff
    // — they are all operator-initiated, which is the reason they use the
    // interactive scanner at all. A quiet branch that can never be taken reads
    // as restraint while doing nothing.
    log.warn('Could not list a project\'s uploads', {
      projectPath,
      error: err && err.message,
      hint
    });
    return {
      uploads: [],
      unreadable: (err && err.message) || 'the uploads directory did not answer',
      unreadableHint: hint,
      unreadableCode: dirScanner.failureCode(err)
    };
  }
}

/**
 * Save one uploaded file into the project's per-session uploads store.
 *
 * Returns a status rather than throwing, because the two ways this fails are
 * different answers to the caller and a thrown error flattens them: a project
 * directory that is not on disk is the operator's to fix (400), while a
 * directory that would not answer is the server reporting its own limit (500).
 * Both verdicts come from the child, because establishing which one applies is
 * itself a read of an operator-chosen path and cannot be done here.
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @param {string} filename - Original filename (sanitised before it hits disk)
 * @param {string} base64Data - Base64-encoded file content
 * @param {string|number|null} [sid] - Active session id, or null for legacy dir
 * A directory that is there but refuses to be read is `unavailable`, never
 * `project-missing`: reporting a refusal as a deletion is the misdiagnosis this
 * whole family of changes exists to remove.
 *
 * @returns {Promise<{status: 'saved'|'project-missing'|'unavailable',
 *   upload?: object, unreadable?: string, unreadableHint?: string|null,
 *   unreadableCode?: string}>}
 */
async function saveUpload(projectPath, filename, base64Data, sid = null) {
  try {
    const result = await dirScanner.interactiveRequest(
      'saveUpload',
      { projectPath, filename, base64Data, sid },
      { timeoutMs: SAVE_TIMEOUT_MS, what: `saving an upload under ${projectPath}` }
    );
    if (result.status === 'saved') return { status: 'saved', upload: result.upload };
    if (result.status === 'project-missing') return { status: 'project-missing' };
    // Anything else is named rather than collapsed. The route turns
    // `project-missing` into a 400 asserting a specific fact about the
    // operator's disk, so a status this function does not recognise must not
    // silently acquire that meaning — it is reported as the server's own limit,
    // with a log line to contradict it.
    if (result.status !== 'project-refused') {
      log.error('The scanner child answered an upload with a status this module does not know',
        { projectPath, status: result.status });
    }
    return {
      status: 'unavailable',
      unreadable: result.status === 'project-refused'
        ? 'the project directory is there but this server may not read it'
        : `the uploads child answered '${result.status}', which is not a status this server handles`,
      unreadableHint: null,
      unreadableCode: result.code || 'SCAN_FAILED'
    };
  } catch (err) {
    const hint = _hintFor(err);
    log.warn('Could not save an upload', {
      projectPath,
      filename,
      error: err && err.message,
      hint
    });
    return {
      status: 'unavailable',
      unreadable: (err && err.message) || 'the uploads directory did not answer',
      unreadableHint: hint,
      unreadableCode: dirScanner.failureCode(err)
    };
  }
}

// No `uploadsDirFor` re-export. It has no caller, and re-exporting it would make
// this module require `lib/uploads-fs.js` — pulling the child-side module, and
// `node:fs` with it, into the server's require graph for the sake of a name
// nobody reads. A module whose whole contract is "no filesystem on the event
// loop" should not import one to forward path arithmetic.
module.exports = {
  saveUpload,
  listUploads,
  MAX_UPLOAD_BYTES,
  LIST_TIMEOUT_MS,
  SAVE_TIMEOUT_MS
};
