'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');
const continuity = require('./continuity');
const secretScan = require('./secret-scan');

const log = createLogger('uploads');

/** Legacy flat uploads dir — pre-CC-4 location, still read for back-compat. */
const LEGACY_LEAF = '.uploads';

/** Per-session-uploads sidecar manifest of secret-scan flags (CC-4 #343). */
const SCAN_MANIFEST = '_scan.json';

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
 * Read a uploads dir's secret-scan manifest. Returns an empty object when the
 * manifest is absent or unreadable (best-effort — never throws on a corrupt
 * sidecar; continuity is not worth failing an upload list over).
 * @param {string} uploadsDir
 * @returns {Record<string, { flagged: boolean, types: string[] }>}
 */
function _readScanManifest(uploadsDir) {
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
 * @param {string} uploadsDir
 * @param {string} name - On-disk filename (the manifest key)
 * @param {{ flagged: boolean, types: string[] }} result
 */
function _recordScan(uploadsDir, name, result) {
  const file = path.join(uploadsDir, SCAN_MANIFEST);
  try {
    const manifest = _readScanManifest(uploadsDir);
    manifest[name] = { flagged: result.flagged, types: result.types };
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
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
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const filePath = path.join(uploadsDir, safeName);
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filePath, buffer);

  // Flag-only secret scan (#343): scan text uploads within the size cap; record
  // a hit in the sidecar manifest. Never blocks or alters the saved file.
  let scan = { flagged: false, types: [] };
  if (buffer.length <= SCAN_SIZE_CAP && _looksLikeText(buffer)) {
    scan = secretScan.scanText(buffer.toString('utf8'));
    if (scan.flagged) {
      _recordScan(uploadsDir, safeName, scan);
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
 * dir's manifest. The manifest file itself is excluded from the listing.
 * @param {string} uploadsDir - Absolute uploads directory
 * @param {string|number|null} session - Session tag for these uploads (null = legacy)
 * @returns {Array<object>} upload entries (unsorted)
 */
function _listDir(uploadsDir, session) {
  if (!fs.existsSync(uploadsDir)) return [];
  const manifest = _readScanManifest(uploadsDir);
  const out = [];
  for (const name of fs.readdirSync(uploadsDir)) {
    if (name === SCAN_MANIFEST) continue;
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
  return out;
}

/**
 * List all uploads for a project — the legacy flat `<project>/.uploads/` dir
 * AND every per-session `sessions/<sid>/uploads/` dir in the consolidated
 * store (CC-4). Each entry is tagged with its `session` (the `<sid>` dir name,
 * or `null` for legacy files) and its secret-scan flag. Back-compat by
 * construction: pre-CC-4 uploads keep appearing, reported with `session: null`.
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {Array<{ path: string, name: string, size: number, createdAt: string,
 *   session: string|null, secretsFlagged: boolean, secretTypes: string[] }>}
 */
function listUploads(projectPath) {
  const all = _listDir(path.join(projectPath, LEGACY_LEAF), null);

  // Per-session dirs under the consolidated store. Absent store → just legacy.
  const sessionsRoot = continuity.sessionsRoot(projectPath);
  if (fs.existsSync(sessionsRoot)) {
    for (const sid of fs.readdirSync(sessionsRoot)) {
      const dir = continuity.sessionUploadsDir(projectPath, sid);
      // Stat-guard: skip non-directory entries in the sessions root.
      try {
        if (!fs.statSync(path.join(sessionsRoot, sid)).isDirectory()) continue;
      } catch {
        continue;
      }
      all.push(..._listDir(dir, sid));
    }
  }

  // Sort newest first.
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return all;
}

module.exports = { saveUpload, listUploads, uploadsDirFor };
