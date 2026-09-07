'use strict';

/**
 * The pure-filesystem half of uploads: everything that touches a path the
 * operator chose, performed by whichever process is allowed to block on it.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `lib/uploads.js`. Every function here reads
 * or writes under `<project>/…`, and a TCC-protected or network-mounted project
 * directory does not fail those calls, it never answers them. Run on the
 * server's event loop that wedges the whole process; run in the forked scanner
 * child (`lib/dir-scanner-child.js`) the blocked thread belongs to something
 * disposable. So the child requires THIS module and `lib/uploads.js` requires
 * the scanner — the same split `lib/project-version-files.js` has from
 * `lib/projects.js`, and for the same reason. Nothing here may require
 * `./dir-scanner` (that would put a supervisor inside the child) or any module
 * that opens the database at require time.
 *
 * THE READS ARE SYNCHRONOUS ON PURPOSE. In the child a blocking read costs that
 * process and nothing else, and being killed is its job; `fs.promises` would buy
 * nothing but a threadpool thread that cannot be reclaimed.
 *
 * THE WRITES ARE STAGED AND RENAMED, and that is a consequence of the same
 * choice. The supervisor SIGKILLs this process mid-syscall with no chance to
 * clean up, and a `writeFileSync` straight to the destination truncates it
 * first — so a kill in that window leaves a zero-length or half-written file
 * that the next reader parses without complaint. For `_scan.json` that is a
 * silently emptied secret-flag manifest; for an upload it is a corrupt file the
 * operator is told was saved. `rename(2)` within one directory is atomic on
 * POSIX, so a reader sees either the previous file or the complete new one.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('./logger');
const continuity = require('./continuity');
const secretScan = require('./secret-scan');

const log = createLogger('uploads-fs');

/** Legacy flat uploads dir — pre-CC-4 location, still read for back-compat. */
const LEGACY_LEAF = '.uploads';

/** Per-session-uploads sidecar manifest of secret-scan flags (CC-4 #343). */
const SCAN_MANIFEST = '_scan.json';

/**
 * Name prefix for a staged write awaiting its rename.
 *
 * Leading dot and a fixed prefix so the listing can exclude staging files by
 * name alone: a stranded one is not an upload and must never be offered to the
 * operator as a file they can hand to their assistant.
 */
const STAGING_PREFIX = '.tc-upload-staging.';

/**
 * How old a staging file must be before the sweep treats it as a corpse.
 *
 * NOT a tidiness margin. Two processes can legitimately be writing here at once
 * — a save and a scan-flag record, or two saves from different sessions — so a
 * staging file the sweep finds may be another writer's, staged milliseconds ago
 * and about to be renamed. Unlinking it makes that writer's rename fail for no
 * reason. A live staging file exists for milliseconds even for a multi-megabyte
 * upload, so this threshold separates the two cases without ambiguity.
 */
const STAGING_STALE_MS = 60_000;

/**
 * Max upload size we attempt to secret-scan. Larger files are skipped — a
 * multi-MB blob is almost always binary/media, and scanning it would cost
 * memory for no signal. Flag-only detection is best-effort by design.
 */
const SCAN_SIZE_CAP = 1024 * 1024; // 1 MB

/**
 * Heuristic: does this buffer look like scannable text? A NUL byte (or a high
 * density of non-text control bytes) marks it binary — PNG/PDF/zip uploads
 * trip this and are skipped. Cheap and conservative: false negatives (a binary
 * we skip) are acceptable for flag-only detection; false positives just waste
 * a regex pass.
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function _looksLikeText(buffer) {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false; // NUL → definitely binary
    // Allow tab/LF/CR; count other C0 control bytes as binary signal.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious++;
  }
  return suspicious / sample.length < 0.1;
}

/**
 * Resolve a project's uploads directory for a given session. With a session
 * id, uploads land in the consolidated per-project store
 * (`.tangleclaw/continuity/sessions/<sid>/uploads/`, CC-4); without one (no
 * active session, or a unit test) they fall back to the legacy flat
 * `<project>/.uploads/` so behavior degrades rather than failing.
 *
 * Pure path arithmetic — no filesystem call — so the server may call it too.
 * @param {string} projectPath - Absolute project root
 * @param {string|number|null} [sid] - Session id, or null for the legacy dir
 * @returns {string}
 */
function uploadsDirFor(projectPath, sid) {
  return sid == null
    ? path.join(projectPath, LEGACY_LEAF)
    : continuity.sessionUploadsDir(projectPath, sid);
}

/**
 * Absolute path of a fresh staging file in `dir`.
 *
 * The name carries the pid and four random bytes because several processes
 * legitimately write into one uploads directory, and a shared staging name
 * would let one writer truncate another's half-written file — reintroducing
 * exactly the partial-write window the staging exists to close.
 * @param {string} dir - Destination directory; the staging file is its sibling
 *   so the rename cannot cross a filesystem boundary and degrade into a copy.
 * @returns {string}
 */
function _stagingPath(dir) {
  return path.join(dir, `${STAGING_PREFIX}${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

/**
 * Delete staging files stranded by a process that died before its rename.
 *
 * The realistic source of those deaths is not this upload at all: one
 * unreadable directory anywhere kills the shared scanner child, and any
 * in-flight staged write dies with it. Sweeping on each successful write bounds
 * the leak at "however many kills landed between two writes" instead of letting
 * it grow for the life of the install.
 *
 * Best-effort by construction — this is cleanup, and failing it must never fail
 * the write that just succeeded.
 * @param {string} dir - The uploads directory to sweep.
 * @param {string} mine - Absolute path of the staging file this writer used and
 *   has already renamed. Skipped, because the name may have been reused since.
 * @returns {void}
 */
function _sweepStagingFiles(dir, mine) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // unreadable directory — the write already succeeded, so say nothing
  }
  const staleBefore = Date.now() - STAGING_STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX) || !name.endsWith('.tmp')) continue;
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
 * Write `contents` to `file` so no reader can ever observe a partial version.
 *
 * @param {string} file - Absolute destination path.
 * @param {Buffer|string} contents - What to write.
 * @returns {void}
 * @throws Whatever the underlying write or rename throws; callers decide
 *   whether their failure is fatal.
 */
function _writeAtomic(file, contents) {
  const dir = path.dirname(file);
  const tmp = _stagingPath(dir);
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (err) {
    // A staging file left behind is invisible to every reader (they name the
    // destination, and the listing skips the prefix), but it would accumulate
    // one per failed write, so clear it on the way out.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // It was never created, or it is as unremovable as it was unwritable.
    }
    throw err;
  }
  _sweepStagingFiles(dir, tmp);
}

/**
 * Read an uploads dir's secret-scan manifest. Returns an empty object when the
 * manifest is absent or unreadable (best-effort — never throws on a corrupt
 * sidecar; continuity is not worth failing an upload list over).
 * @param {string} uploadsDir
 * @returns {Record<string, { flagged: boolean, types: string[] }>}
 */
function readScanManifest(uploadsDir) {
  const file = path.join(uploadsDir, SCAN_MANIFEST);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('Failed to read scan manifest', { uploadsDir, error: err.message });
    }
    return {};
  }
}

/**
 * Record a flagged file in a uploads dir's secret-scan manifest. Only flagged
 * files are recorded — a clean (or unscanned) file is the absence of an entry,
 * which keeps the manifest tiny and the common path write-free. Best-effort:
 * a manifest write failure is logged, never thrown (the upload already saved).
 *
 * Staged and renamed: this is a read-modify-write of a file the listing parses,
 * so a kill during a plain write would leave a truncated manifest that
 * `readScanManifest` reports as "no file was ever flagged" — losing every
 * previous flag silently rather than noisily.
 * @param {string} uploadsDir
 * @param {string} name - On-disk filename (the manifest key)
 * @param {{ flagged: boolean, types: string[] }} result
 * @returns {void}
 */
function recordScan(uploadsDir, name, result) {
  const file = path.join(uploadsDir, SCAN_MANIFEST);
  try {
    const manifest = readScanManifest(uploadsDir);
    manifest[name] = { flagged: result.flagged, types: result.types };
    _writeAtomic(file, JSON.stringify(manifest, null, 2));
  } catch (err) {
    log.warn('Failed to record scan flag', { uploadsDir, name, error: err.message });
  }
}

/**
 * Save an uploaded file to the project's per-session uploads store (CC-4).
 *
 * With a `sid` the file lands in the consolidated store, session-linked and
 * cascade-deletable with the project; without one it falls back to the legacy
 * flat `<project>/.uploads/`. Text uploads within {@link SCAN_SIZE_CAP} are
 * secret-scanned (flag-only, #343) — a hit is recorded in the dir's `_scan.json`
 * sidecar and surfaced on the return value, but **the upload is never blocked
 * or modified**.
 *
 * ONE WINDOW REMAINS OPEN AND IS THE RIGHT ONE TO LEAVE OPEN. The file is
 * renamed into place before the flag is recorded, so a kill between the two
 * leaves a saved file with no manifest entry — it lists as unflagged. Closing
 * that would mean staging the flag first and reporting a secret in a file that
 * may never exist. A missed flag on a file the operator just chose to upload is
 * the cheaper error, and the scan is documented as best-effort.
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @param {string} filename - Original filename
 * @param {string} base64Data - Base64-encoded file content
 * @param {string|number|null} [sid] - Active session id, or null for legacy dir
 * @returns {{ path: string, name: string, size: number, createdAt: string,
 *   session: string|number|null, secretsFlagged: boolean, secretTypes: string[] }}
 */
function saveUpload(projectPath, filename, base64Data, sid = null) {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath is required');
  }
  if (!filename || typeof filename !== 'string') {
    throw new Error('filename is required');
  }
  if (!base64Data || typeof base64Data !== 'string') {
    throw new Error('base64Data is required');
  }

  // Any file type is allowed (#338). Uploads are stored under the project's
  // continuity store (or legacy .uploads/) and only ever referenced by local
  // path — never served over HTTP or executed — so the type carries no
  // execution/XSS vector. The safety boundary is the filename sanitization
  // below: it strips path separators (no traversal) and keeps the on-disk name
  // clean. The extension is taken from the original name but sanitized to
  // alphanumerics so a crafted name can't smuggle odd characters onto disk.
  const rawExt = path.extname(filename);
  const ext = rawExt ? '.' + rawExt.slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';

  // Sanitize the base filename (strip path separators / unusual chars); fall
  // back to "file" if nothing usable remains (e.g. a name that was all symbols).
  const baseName = path.basename(filename, rawExt).replace(/[^a-zA-Z0-9_-]/g, '_') || 'file';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeName = `${timestamp}-${baseName}${ext}`;

  const uploadsDir = uploadsDirFor(projectPath, sid);
  // No existence check in front of this: `recursive: true` is a no-op on a
  // directory that is already there, so a guard would buy nothing and add one
  // more call that a protected path can decline to answer.
  fs.mkdirSync(uploadsDir, { recursive: true });

  const filePath = path.join(uploadsDir, safeName);
  const buffer = Buffer.from(base64Data, 'base64');
  _writeAtomic(filePath, buffer);

  // Flag-only secret scan (#343): scan text uploads within the size cap; record
  // a hit in the sidecar manifest. Never blocks or alters the saved file.
  let scan = { flagged: false, types: [] };
  if (buffer.length <= SCAN_SIZE_CAP && _looksLikeText(buffer)) {
    scan = secretScan.scanText(buffer.toString('utf8'));
    if (scan.flagged) {
      recordScan(uploadsDir, safeName, scan);
      log.warn('Upload flagged for possible secrets', { path: filePath, types: scan.types });
    }
  }

  log.info('File uploaded', { path: filePath, size: buffer.length, session: sid });

  return {
    path: filePath,
    name: safeName,
    size: buffer.length,
    createdAt: now.toISOString(),
    session: sid == null ? null : sid,
    secretsFlagged: scan.flagged,
    secretTypes: scan.types
  };
}

/**
 * Scan one uploads directory, attaching each file's secret-scan flag from the
 * dir's manifest. The manifest file itself, and any staging file awaiting its
 * rename, are excluded from the listing.
 *
 * ABSENT AND UNREADABLE ARE DIFFERENT ANSWERS. A directory that was never
 * created reports no entries and no failure — that is what "nothing has been
 * uploaded" looks like. A directory that is there and refuses to be read
 * reports `unreadable` with the filesystem's own `code`, because reporting it
 * as empty tells the operator their uploads are gone.
 * @param {string} uploadsDir - Absolute uploads directory
 * @param {string|number|null} session - Session tag for these uploads (null = legacy)
 * @returns {{ entries: object[], unreadable: string|null, code: string|null }}
 */
function listDir(uploadsDir, session) {
  let names;
  try {
    names = fs.readdirSync(uploadsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], unreadable: null, code: null };
    return { entries: [], unreadable: err.message, code: err.code || null };
  }

  const manifest = readScanManifest(uploadsDir);
  const out = [];
  for (const name of names) {
    if (name === SCAN_MANIFEST) continue;
    if (name.startsWith(STAGING_PREFIX)) continue;
    const filePath = path.join(uploadsDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const flag = manifest[name];
      out.push({
        path: filePath,
        name,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        session,
        secretsFlagged: Boolean(flag && flag.flagged),
        secretTypes: flag && Array.isArray(flag.types) ? flag.types : []
      });
    } catch (err) {
      log.warn('Failed to stat upload', { name, error: err.message });
    }
  }
  return { entries: out, unreadable: null, code: null };
}

/**
 * List all uploads for a project — the legacy flat `<project>/.uploads/` dir
 * AND every per-session `sessions/<sid>/uploads/` dir in the consolidated
 * store (CC-4). Each entry is tagged with its `session` (the `<sid>` dir name,
 * or `null` for legacy files) and its secret-scan flag. Back-compat by
 * construction: pre-CC-4 uploads keep appearing, reported with `session: null`.
 *
 * A PARTIAL LIST IS REPORTED AS PARTIAL, not as the whole. If one directory
 * refuses to be read the others are still listed, and `unreadable` names the
 * first refusal — the alternative is a shorter list with nothing saying
 * anything failed, which is the shape the architecture Direction forbids.
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {{ uploads: Array<{ path: string, name: string, size: number,
 *   createdAt: string, session: string|null, secretsFlagged: boolean,
 *   secretTypes: string[] }>, unreadable: string|null, code: string|null }}
 */
function listUploads(projectPath) {
  let unreadable = null;
  let code = null;
  /**
   * Keep the FIRST refusal. A later one is almost always the same cause — one
   * unreadable project root refuses every directory beneath it — and
   * overwriting would report the last session dir walked rather than the one
   * that explains the failure.
   * @param {{unreadable: string|null, code: string|null}} r - A `listDir` result.
   * @returns {void}
   */
  const note = (r) => {
    if (unreadable === null && r.unreadable !== null) {
      unreadable = r.unreadable;
      code = r.code;
    }
  };

  const legacy = listDir(path.join(projectPath, LEGACY_LEAF), null);
  note(legacy);
  const all = legacy.entries;

  // Per-session dirs under the consolidated store. Absent store → just legacy.
  const sessionsRoot = continuity.sessionsRoot(projectPath);
  let sids;
  try {
    sids = fs.readdirSync(sessionsRoot);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      note({ unreadable: err.message, code: err.code || null });
    }
    sids = [];
  }

  for (const sid of sids) {
    // Stat-guard: skip non-directory entries in the sessions root.
    try {
      if (!fs.statSync(path.join(sessionsRoot, sid)).isDirectory()) continue;
    } catch {
      continue;
    }
    const dir = continuity.sessionUploadsDir(projectPath, sid);
    const result = listDir(dir, sid);
    note(result);
    all.push(...result.entries);
  }

  // Sort newest first.
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { uploads: all, unreadable, code };
}

module.exports = {
  saveUpload,
  listUploads,
  listDir,
  uploadsDirFor,
  readScanManifest,
  recordScan,
  LEGACY_LEAF,
  SCAN_MANIFEST,
  SCAN_SIZE_CAP,
  STAGING_PREFIX
};
