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
 * Injectable seams so tests never touch the real `~/.claude`/`~/.codex` or
 * wall clock. Mirrors the `_internal` pattern in `continuity-write.js`.
 */
const _internal = {
  claudeHome: () => path.join(os.homedir(), '.claude'),
  codexHome: () => path.join(os.homedir(), '.codex'),
  now: () => new Date().toISOString(),
  // Above this size the transcript is still COPIED (disk-to-disk, no OOM) but the
  // line-by-line secret scan is SKIPPED — scanning a pathologically huge file
  // would dominate wrap time for negligible signal. ~25 MB ≈ millions of tokens,
  // far beyond any normal session. Injectable so tests can exercise the branch.
  maxScanBytes: 25 * 1024 * 1024,
  // A Codex rollout's OWN recorded start (`payload.timestamp` on its
  // `session_meta` line — real, embedded native identity, unlike Claude which
  // has none) may precede the TC session's `startedAt` by this much and still
  // count: TC's launch record can land a few seconds after Codex itself starts.
  // No upper bound, same asymmetry as Claude's MTIME_GRACE_MS — a long-running
  // Codex session legitimately started well before "now". Injectable for
  // boundary tests.
  codexWindowMs: 2 * 60 * 1000
};

/** Harnesses with a stub adapter (#376/#2074): named so a `reason` string says
 *  "not yet supported" rather than reading like a genuinely failed resolution
 *  for an implemented one (claude, codex) that simply found no match. */
const UNSUPPORTED_HARNESSES = new Set(['antigravity', 'aider', 'openclaw']);

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

/** SQLite's own `datetime('now')` shape: UTC, but with no timezone marker at all. */
const SQLITE_BARE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Parse a TC session timestamp (`session.startedAt`/`session.endedAt`) as the
 * UTC instant it actually is. `store/_schema.js`'s `sessions.started_at`/
 * `ended_at` default to and are written as SQLite's `datetime('now')` —
 * `'YYYY-MM-DD HH:MM:SS'`, UTC, but carrying no `T`/`Z`/offset at all. Node's
 * `Date.parse` on a string shaped like that reads it as LOCAL time, not UTC
 * (an 8-hour shift on this host's America/Los_Angeles clock) — confirmed via
 * PRR-A's PR #2829 review: a real stored `'2026-11-03 09:00:00'` round-trips
 * to `17:00:00Z` through bare `Date.parse`, not `09:00:00Z`. Normalizing the
 * bare SQLite shape to an explicit-UTC ISO string before parsing fixes it;
 * anything that already carries its own zone (a real ISO string, a test
 * fixture) parses exactly as `Date.parse` would parse it unchanged.
 * @param {*} value - `session.startedAt`/`session.endedAt`, or anything else
 * @returns {number} Milliseconds since epoch, or `NaN`
 */
function _parseStoreTimestamp(value) {
  if (typeof value !== 'string' || !value) return NaN;
  return Date.parse(SQLITE_BARE_UTC.test(value) ? `${value.replace(' ', 'T')}Z` : value);
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
  const startedMs = session && session.startedAt ? _parseStoreTimestamp(session.startedAt) : NaN;

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
 * Collect every `.jsonl` file under `root`, recursing through subdirectories
 * (Codex partitions `~/.codex/sessions` as `<root>/<YYYY>/<MM>/<DD>/*.jsonl`,
 * unlike Claude's flat per-project dirs). Each directory read is independently
 * fault-tolerant — a permission error or a surprise non-directory entry skips
 * that branch rather than aborting the whole walk, same defensive posture as
 * `_searchDirs`. Depth-bounded well above the real 3-level layout so a future
 * reshuffle doesn't need this constant touched.
 * @param {string} dir
 * @param {string[]} out - Accumulator (mutated)
 * @param {number} [depth]
 * @returns {void}
 */
function _walkJsonl(dir, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) _walkJsonl(full, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

/**
 * Read a Codex rollout's own `session_meta` record — always its first JSONL
 * line (confirmed against real `~/.codex/sessions` files: `{type:
 * "session_meta", payload: {id, timestamp, cwd, ...}}`), bounded to the same
 * probe budget as Claude's `_firstCwd` (observed first-line sizes top out
 * around 25 KB, well under the 64 KB budget, even with a large embedded
 * system prompt). Unlike Claude, Codex carries real native identity
 * (`payload.id`, stable across every sampled CLI version) and its own
 * semantic start time (`payload.timestamp`) rather than relying on
 * filesystem mtime alone. Returns `null` for anything unreadable, truncated,
 * or not shaped as expected — an honest skip, never a throw.
 * @param {string} file
 * @returns {{cwd: string, nativeId: (string|null), startedMs: number}|null}
 */
function _codexSessionMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CWD_PROBE_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);
    const newline = text.indexOf('\n');
    const firstLine = newline === -1 ? text : text.slice(0, newline);
    const record = JSON.parse(firstLine);
    if (!record || record.type !== 'session_meta' || !record.payload || typeof record.payload.cwd !== 'string') {
      return null;
    }
    const { payload } = record;
    return {
      cwd: payload.cwd,
      nativeId: typeof payload.id === 'string' ? payload.id : null,
      startedMs: typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN
    };
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
 * Codex CLI transcript adapter (#2074). Resolves under `~/.codex/sessions/`,
 * matching each rollout's own recorded `cwd` and start time — real native
 * identity, not just dir-name decoding. **Fail-closed on ambiguity**,
 * deliberately stricter than `_claudeResolve`'s newest-wins tie-break: when
 * more than one rollout matches both `cwd` and the time window, this returns
 * `null` rather than guess, because attaching the WRONG session's transcript
 * is worse than attaching none (the issue's own "fail-closed identity
 * strategy" requirement — real multi-session-per-cwd collisions exist on a
 * live machine, confirmed against `~/.codex/sessions`).
 *
 * **Bounded on both sides** (I-Gate Round 1, Architect ruling): a rollout
 * must have started no earlier than `session.startedAt - codexWindowMs` AND
 * no later than `session.endedAt + codexWindowMs` (or "now" + the window when
 * the session has not recorded an end yet — a live wrap). An upper-bound-only
 * check would let a LATER, unrelated session at the same `cwd` be attached to
 * an OLDER, already-wrapped one during backfill — the exact scenario a
 * lower-bound-only check (as this function first shipped) cannot catch,
 * because a later rollout is never "too old" to match. **Fails closed on an
 * invalid native timestamp**: `Number.isNaN(meta.startedMs)` is never treated
 * as "no time filter, so anything matches" — an unparseable `payload.timestamp`
 * is reason to skip the candidate outright, not relax the check.
 * @param {string} projectPath
 * @param {object} session - TC session row (uses `startedAt`, `endedAt`)
 * @returns {string|null}
 */
function _codexResolve(projectPath, session) {
  const root = path.join(_internal.codexHome(), 'sessions');
  if (!_isDir(root)) return null;
  const startedMs = session && session.startedAt ? _parseStoreTimestamp(session.startedAt) : NaN;
  const endedMs = session && session.endedAt ? _parseStoreTimestamp(session.endedAt) : NaN;
  const upperBoundMs = Number.isNaN(endedMs) ? Date.parse(_internal.now()) : endedMs;

  const files = [];
  _walkJsonl(root, files);

  const candidates = [];
  for (const file of files) {
    const meta = _codexSessionMeta(file);
    if (!meta || meta.cwd !== projectPath) continue;
    // Fail closed: a rollout whose own recorded start we cannot parse is
    // never a match, never "no filter applies" — the opposite of the old
    // (buggy) behavior, where NaN silently bypassed both bounds below.
    if (Number.isNaN(meta.startedMs)) continue;
    if (!Number.isNaN(startedMs) && meta.startedMs < startedMs - _internal.codexWindowMs) continue;
    if (!Number.isNaN(upperBoundMs) && meta.startedMs > upperBoundMs + _internal.codexWindowMs) continue;
    candidates.push(file);
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  log.warn('Multiple Codex transcripts match this session\'s cwd and time window; refusing rather than guessing', {
    projectPath, count: candidates.length
  });
  return null;
}

/**
 * Harness-adapter registry (forward-compatibility seam). Keyed by the normalized
 * engine id. The Claude and Codex adapters are implemented; the others are
 * stubs naming where a future implementer would look. A stub returning `null`
 * makes the snapshot an honest no-op for that harness, never an error.
 * @type {Record<string, { resolve: (projectPath: string, session: object) => string|null }>}
 */
const ADAPTERS = {
  claude: { resolve: _claudeResolve },
  // Antigravity CLI (agy, #456) — conversation-log location TBD; implement when needed.
  antigravity: { resolve: () => null },
  // ~/.codex/sessions/**/*.jsonl (Codex CLI, #2074) — implemented above.
  codex: { resolve: _codexResolve },
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
 * Why a harness resolved to nothing, worded so a reader (operator, log, or a
 * future UI) does not mistake an honest skip for a missed setting (#2074):
 * a stub harness has never supported capture; an implemented one (claude,
 * codex) simply found no transcript (including Codex's own fail-closed
 * ambiguity refusal — both collapse to "no match" at this boundary, since a
 * caller cannot act differently on either). A genuine capture failure (e.g.
 * `_capture`'s copy/scan/write throwing) is a different thing entirely: it
 * propagates as a rejected promise rather than this honest-skip shape, so it
 * is never worded as a "no transcript" reason at all.
 * @param {string} harness
 * @returns {string}
 */
function _noTranscriptReason(harness) {
  return UNSUPPORTED_HARNESSES.has(harness)
    ? `harness '${harness}' does not support transcript capture yet`
    : `no matching transcript found for harness '${harness}'`;
}

/**
 * Copy a resolved transcript into the consolidated store and record it —
 * the steps shared by `snapshot` (always captures) and `backfillTranscript`
 * (captures only when nothing is there yet). Always overwrites whatever
 * currently sits at the destination; a caller that must never overwrite
 * checks for an existing capture itself before calling this.
 *
 * Records which of the two callers made this capture (`meta.capturedVia`,
 * #2830 I-Gate Round 1 Finding 1): a session's transcript can be captured
 * live at wrap time OR filled in later from the harness's native log, and a
 * consumer that only ever reads "is there a transcript" cannot otherwise
 * tell the two apart on a later read -- the meta envelope is the one place
 * that provenance survives past this call.
 * @param {string} harness
 * @param {string} src - Resolved absolute transcript path
 * @param {object} project - Project record (uses `.path`, `.name`)
 * @param {string|number} sid - TC session id (the store key)
 * @param {{backfilled?: boolean}} [opts] - `backfilled: true` from `backfillTranscript`; omitted (live) from `snapshot`
 * @returns {Promise<{captured:true, bytes:number, lineCount:number,
 *   secretsFlagged:boolean, secretTypes:string[], scanSkipped:boolean}>}
 */
async function _capture(harness, src, project, sid, opts) {
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
    capturedVia: opts && opts.backfilled ? 'backfill' : 'snapshot',
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

/**
 * Snapshot a session's transcript into the consolidated store (CC-4b). Resolves
 * the transcript via the harness adapter; if none, writes nothing and returns
 * `{captured:false}` (honest skip for an unsupported harness, a remote one, or
 * no match — see `_noTranscriptReason`). On a hit: copies the raw `.jsonl` to
 * `sessions/<sid>/transcript.jsonl`, scans it for secrets (flag-only, types not
 * values), and writes the `transcript.meta.json` envelope sidecar.
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
  if (!src) return { captured: false, reason: _noTranscriptReason(harness) };
  return _capture(harness, src, project, sid);
}

/**
 * Backfill a transcript for a session that was already wrapped WITHOUT one
 * (#2074). Idempotent and safe to call repeatedly: a session that already
 * carries a captured transcript is left completely untouched — never
 * overwritten, never re-scanned — and an unresolved or (for Codex)
 * ambiguous source is the same honest skip `snapshot` gives a session being
 * wrapped for the first time. Enumerating which previously-wrapped sessions
 * are missing a transcript, and calling this for each, is a caller concern
 * outside this module (e.g. a future admin/backfill endpoint) — this
 * function is the single-session primitive the issue's backfill path needs.
 * @param {object} project - Project record (uses `.path`, `.name`)
 * @param {object} session - TC session row (uses `.engineId`, `.startedAt`)
 * @param {string|number} sid - TC session id (the store key)
 * @returns {Promise<{captured:boolean, reason?:string, bytes?:number,
 *   lineCount?:number, secretsFlagged?:boolean, secretTypes?:string[]}>}
 */
async function backfillTranscript(project, session, sid) {
  const destDir = continuity.sessionDir(project.path, sid);
  if (fs.existsSync(path.join(destDir, TRANSCRIPT_FILENAME))) {
    return { captured: false, reason: 'already captured' };
  }
  const harness = _normalizeHarness(session && session.engineId);
  const src = resolve(harness, project.path, session);
  if (!src) return { captured: false, reason: _noTranscriptReason(harness) };
  return _capture(harness, src, project, sid, { backfilled: true });
}

module.exports = {
  resolve,
  snapshot,
  backfillTranscript,
  ADAPTERS,
  TRANSCRIPT_FILENAME,
  META_FILENAME,
  _internal,
  _normalizeHarness,
  _encodeDir,
  _claudeResolve,
  _codexResolve,
  _parseStoreTimestamp
};
