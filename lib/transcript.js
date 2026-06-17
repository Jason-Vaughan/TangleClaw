'use strict';

/**
 * Transcript snapshot (CC-4b, #376) — the cold tier of the Continuity Contract
 * (`continuity-contract.md` §"Storage model & lifecycle"). At wrap, TC copies a
 * session's raw transcript into the consolidated per-project store under
 * `sessions/<sid>/transcript.jsonl` (CC-4's layout) and runs the secret scanner
 * over it. CC-5's drill-down deep-searches this cold tier.
 *
 * **Wrap-time resolution, no hook.** Rather than a SessionStart hook handshake
 * (which would touch the live hook chain — the #94/#145 hazard — and need a new
 * endpoint + schema column), TC resolves the transcript itself at wrap. A real-
 * surface probe confirmed Claude transcripts live at
 * `~/.claude/projects/<cwd-with-slashes-and-dots-as-dashes>/<session-uuid>.jsonl`
 * and that transcript lines carry `cwd` = the project path — so a session's
 * transcript is identifiable by **content match**, not just dir-name decoding.
 *
 * **Forward-compatibility seam.** Resolution dispatches through a harness-adapter
 * registry keyed by the session's engine. The Claude-Code adapter is implemented;
 * Gemini / Codex / Aider / OpenClaw are documented stubs that return `null`
 * (honest "no transcript yet"). Adding a harness later = implement one `resolve()`
 * — no core surgery. The envelope's `harness` field tells consumers which format
 * they hold; only the Claude payload is stored (raw `.jsonl`) for now.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createLogger } = require('./logger');
const continuity = require('./continuity');
const secretScan = require('./secret-scan');

const log = createLogger('transcript');

const TRANSCRIPT_FILENAME = 'transcript.jsonl';
const META_FILENAME = 'transcript.meta.json';

/** Max chars of a single JSONL line we run the secret scanner over (bounds work
 *  on a pathologically long line; the transcript itself has no whole-file cap). */
const MAX_LINE_SCAN = 64 * 1024;

/** How many leading bytes of a transcript we read to find its `cwd` field. */
const CWD_PROBE_BYTES = 64 * 1024;

/** Grace window (ms) subtracted from session start when filtering by mtime — a
 *  transcript created moments before TC records `started_at` still counts. */
const MTIME_GRACE_MS = 60 * 1000;

/**
 * Injectable seams so tests never touch the real `~/.claude` or wall clock.
 * Mirrors the `_internal` pattern in `continuity-write.js`.
 */
const _internal = {
  claudeHome: () => path.join(os.homedir(), '.claude'),
  now: () => new Date().toISOString(),
  // Above this size the transcript is still COPIED (disk-to-disk, no OOM) but the
  // line-by-line secret scan is SKIPPED — scanning a pathologically huge file
  // would dominate wrap time for negligible signal. ~25 MB ≈ millions of tokens,
  // far beyond any normal session. Injectable so tests can exercise the branch.
  maxScanBytes: 25 * 1024 * 1024
};

/**
 * Encode a project path into Claude Code's transcript dir name: every `/` and
 * `.` becomes `-` (observed encoding). Used as the fast-path lookup; the
 * content-match fallback covers any encoding surprise.
 * @param {string} projectPath
 * @returns {string}
 */
function _encodeDir(projectPath) {
  return String(projectPath).replace(/[/.]/g, '-');
}

/** @param {string} p @returns {boolean} */
function _isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the first `cwd` value from a transcript's leading bytes. The opening line
 * carries no `cwd` (type/mode/sessionId), but subsequent lines within the first
 * 64 KB do. Returns `null` if none found / unreadable. Bounded read (never slurps
 * a multi-MB file just to identify it).
 * @param {string} file
 * @returns {string|null}
 */
function _firstCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CWD_PROBE_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.cwd === 'string') return o.cwd;
      } catch {
        // partial/last line in the chunk — ignore and keep scanning
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Search the given Claude project dirs for the newest `.jsonl` whose recorded
 * `cwd` matches `projectPath` and whose mtime is within the session window.
 * Newest-first; the cwd match is the correctness gate (so a stale transcript
 * from another cwd that happens to share an encoded dir is never picked).
 * @param {string[]} dirs - Absolute candidate directories
 * @param {string} projectPath
 * @param {number} startedMs - Session start (ms) or NaN to skip the mtime filter
 * @returns {string|null} Absolute transcript path, or null
 */
function _searchDirs(dirs, projectPath, startedMs) {
  const candidates = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!Number.isNaN(startedMs) && st.mtimeMs < startedMs - MTIME_GRACE_MS) continue;
      candidates.push({ full, mtimeMs: st.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    if (_firstCwd(c.full) === projectPath) return c.full;
  }
  return null;
}

/**
 * Claude-Code transcript adapter. Resolves the session's transcript under
 * `~/.claude/projects/`: try the deterministically-encoded dir first, then fall
 * back to scanning every project dir (covers an encoding surprise). Returns the
 * absolute path, or `null` when none matches (honest skip).
 * @param {string} projectPath
 * @param {object} session - TC session row (uses `startedAt`)
 * @returns {string|null}
 */
function _claudeResolve(projectPath, session) {
  const root = path.join(_internal.claudeHome(), 'projects');
  if (!_isDir(root)) return null;
  const startedMs = session && session.startedAt ? Date.parse(session.startedAt) : NaN;

  // Fast path: the encoded dir for this project.
  const encoded = path.join(root, _encodeDir(projectPath));
  if (_isDir(encoded)) {
    const hit = _searchDirs([encoded], projectPath, startedMs);
    if (hit) return hit;
  }

  // Fallback: scan every project dir for a cwd-matching transcript.
  let allDirs;
  try {
    allDirs = fs
      .readdirSync(root)
      .map((d) => path.join(root, d))
      .filter(_isDir);
  } catch {
    return null;
  }
  return _searchDirs(allDirs, projectPath, startedMs);
}

/**
 * Harness-adapter registry (forward-compatibility seam). Keyed by the normalized
 * engine id. Only the Claude adapter is implemented; the others are stubs naming
 * where a future implementer would look. A stub returning `null` makes the
 * snapshot an honest no-op for that harness, never an error.
 * @type {Record<string, { resolve: (projectPath: string, session: object) => string|null }>}
 */
const ADAPTERS = {
  claude: { resolve: _claudeResolve },
  // ~/.gemini/tmp/<project-hash>/logs.json (Gemini CLI) — implement when needed.
  gemini: { resolve: () => null },
  // ~/.codex/sessions/*.jsonl (Codex CLI) — implement when needed.
  codex: { resolve: () => null },
  // <project>/.aider.chat.history.md (Aider, in-repo) — implement when needed.
  aider: { resolve: () => null },
  // OpenClaw runs Claude on a REMOTE host; its ~/.claude is not local — needs a
  // remote fetch (future). Local resolution can't see it, so skip honestly.
  openclaw: { resolve: () => null }
};

/**
 * Normalize a TC `engineId` to an adapter key. `openclaw:<id>` → `openclaw`;
 * `claude-code` → `claude`; otherwise lowercased as-is.
 * @param {string} engineId
 * @returns {string}
 */
function _normalizeHarness(engineId) {
  const h = String(engineId || '').toLowerCase();
  if (h.startsWith('openclaw')) return 'openclaw';
  if (h === 'claude-code') return 'claude';
  return h || 'unknown';
}

/**
 * Resolve a session's transcript path via the harness adapter, or `null`.
 * @param {string} harness - Normalized harness key (see `_normalizeHarness`)
 * @param {string} projectPath
 * @param {object} session
 * @returns {string|null}
 */
function resolve(harness, projectPath, session) {
  const adapter = ADAPTERS[harness];
  if (!adapter || typeof adapter.resolve !== 'function') return null;
  try {
    return adapter.resolve(projectPath, session);
  } catch (err) {
    log.warn('Transcript resolve failed', { harness, error: err.message });
    return null;
  }
}

/**
 * Stream a transcript file line-by-line through the secret scanner. Bounded
 * memory (one line at a time) with no whole-file cap — the transcript is the
 * high-value secret-leak surface. Returns line count + aggregated pattern
 * **types** (never values). Never rejects.
 * @param {string} file
 * @returns {Promise<{lineCount:number, flagged:boolean, types:string[]}>}
 */
function _scanFile(file) {
  return new Promise((resolveP) => {
    let lineCount = 0;
    const typeSet = new Set();
    let stream;
    try {
      stream = fs.createReadStream(file, 'utf8');
    } catch {
      resolveP({ lineCount: 0, flagged: false, types: [] });
      return;
    }
    const finish = () =>
      resolveP({ lineCount, flagged: typeSet.size > 0, types: Array.from(typeSet).sort() });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lineCount++;
      const r = secretScan.scanText(line.length > MAX_LINE_SCAN ? line.slice(0, MAX_LINE_SCAN) : line);
      if (r.flagged) for (const t of r.types) typeSet.add(t);
    });
    rl.on('close', finish);
    stream.on('error', () => finish());
  });
}

/**
 * Snapshot a session's transcript into the consolidated store (CC-4b). Resolves
 * the transcript via the harness adapter; if none, writes nothing and returns
 * `{captured:false}` (honest skip for non-Claude / remote / no-transcript). On a
 * hit: copies the raw `.jsonl` to `sessions/<sid>/transcript.jsonl`, scans it for
 * secrets (flag-only, types not values), and writes the `transcript.meta.json`
 * envelope sidecar.
 *
 * @param {object} project - Project record (uses `.path`)
 * @param {object} session - TC session row (uses `.engineId`, `.startedAt`)
 * @param {string|number} sid - TC session id (the store key)
 * @returns {Promise<{captured:boolean, reason?:string, bytes?:number,
 *   lineCount?:number, secretsFlagged?:boolean, secretTypes?:string[]}>}
 */
async function snapshot(project, session, sid) {
  const harness = _normalizeHarness(session && session.engineId);
  const src = resolve(harness, project.path, session);
  if (!src) {
    return { captured: false, reason: `no transcript for harness '${harness}'` };
  }

  const destDir = continuity.sessionDir(project.path, sid);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, TRANSCRIPT_FILENAME);
  fs.copyFileSync(src, dest);
  const bytes = fs.statSync(dest).size;

  // Always keep the transcript (CC-5 search needs it most when it's big); cap
  // only the secret SCAN's cost on a pathological file.
  let lineCount = 0;
  let flagged = false;
  let types = [];
  const scanSkipped = bytes > _internal.maxScanBytes;
  if (scanSkipped) {
    log.warn('Transcript too large to secret-scan; copied without scan', { project: project.name, sid, bytes });
  } else {
    ({ lineCount, flagged, types } = await _scanFile(dest));
  }

  const meta = {
    harness,
    claudeSessionId: path.basename(src, '.jsonl'),
    cwd: project.path,
    capturedAt: _internal.now(),
    bytes,
    lineCount,
    secretsFlagged: flagged,
    secretTypes: types,
    scanSkipped,
    source: src
  };
  fs.writeFileSync(path.join(destDir, META_FILENAME), JSON.stringify(meta, null, 2) + '\n');

  if (flagged) {
    log.warn('Transcript flagged for possible secrets', { project: project.name, sid, types });
  }
  log.info('Transcript snapshot written', { project: project.name, sid, bytes, lineCount, scanSkipped });

  return { captured: true, bytes, lineCount, secretsFlagged: flagged, secretTypes: types, scanSkipped };
}

module.exports = {
  resolve,
  snapshot,
  ADAPTERS,
  TRANSCRIPT_FILENAME,
  META_FILENAME,
  _internal,
  _normalizeHarness,
  _encodeDir,
  _claudeResolve
};
