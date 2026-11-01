'use strict';

/**
 * Multi-provider usage & quota window telemetry (#2599).
 *
 * Reads what each coding-engine CLI already wrote to its own local transcript
 * log — Claude Code's per-session JSONL under `~/.claude/projects/*\/*.jsonl`
 * and Codex's rollout JSONL under `~/.codex/sessions/**\/*.jsonl` — and turns
 * per-turn token counts into rolling usage windows an operator (or a fleet
 * coordinator) can read a Builder-lane model policy off of, without either
 * CLI exposing a usage API of its own.
 *
 * Three windows, all derived from the same parsed records:
 *  - **5-hour**: a plain rolling window, `now - 5h` to `now`. No time zone.
 *  - **weekly**: anchored to the provider's reset instant — Thursday 06:00
 *    `America/Los_Angeles` — so it reports what has been spent SINCE THE LAST
 *    RESET, not an arbitrary trailing 7 days. `nextWeeklyResetAt` /
 *    `hoursUntilWeeklyReset` are derived the same way.
 *  - **monthly**: since the start of the current Pacific calendar month.
 *
 * `calibrateUsage` lets an operator correct the picture with the percentage a
 * provider's own dashboard reports (parsed-transcript totals are TOKEN
 * counts, not the provider's own, possibly weighted, quota accounting, so the
 * two can disagree) — stored in-memory by default, or in an injected store for
 * a caller that wants it to survive a restart.
 *
 * `getUsageWindows` composes all of the above into a recommended Builder
 * model-tier policy (#2599's "Conservation" vs. "Use-It-or-Lose-It" windows).
 * It recommends; it never selects one — {@link module:lib/model-switch} is
 * the only thing that actually changes a session's model.
 *
 * @module lib/usage-windows
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('usage-windows');

/** The one time zone every reset and calendar boundary here is defined in. */
const TIME_ZONE = 'America/Los_Angeles';

/** Rolling window length, in milliseconds. */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** The weekly reset's Pacific hour (06:00) and ISO weekday (Thursday = 4 in `Intl`'s Sun=0 scheme). */
const WEEKLY_RESET_HOUR = 6;
const WEEKLY_RESET_WEEKDAY = 4;

/** Providers this module knows how to read a transcript log for. */
const PROVIDERS = Object.freeze(['claude', 'codex']);

/** A usage record's token fields, always present, defaulting to 0. */
const TOKEN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens']);

/**
 * The Builder model tiers #2599's policy recommends between. Not every
 * engine currently offers these as selectable models ({@link
 * module:lib/engine-models}); this is the tier vocabulary the usage policy
 * reasons in, independent of what is installed.
 */
const MODEL_TIERS = Object.freeze({
  BOUNDED: 'claude-sonnet-5',
  MULTI_SEAM: ['claude-opus-5-5', 'claude-fable-5-1']
});

/** Below this percent of weekly headroom remaining, the policy is Conservation even inside the Use-It-or-Lose-It slot. */
const DEFAULT_LOW_HEADROOM_THRESHOLD_PCT = 15;

/**
 * Parts of an instant's Pacific wall clock.
 * @param {number} ms - Epoch milliseconds.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, weekday: number}}
 *   `weekday` is `Intl`'s Sun=0 .. Sat=6.
 */
function pacificParts(ms) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(new Date(ms))) {
    parts[type] = value;
  }
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAYS[parts.weekday]
  };
}

/**
 * The Pacific UTC offset, in minutes, in effect at an instant (negative: PDT
 * is -420, PST is -480).
 * @param {number} utcMs - Epoch milliseconds.
 * @returns {number}
 */
function _pacificOffsetMinutesAt(utcMs) {
  const p = pacificParts(utcMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((wallAsUtc - utcMs) / 60000);
}

/**
 * The epoch instant whose Pacific wall clock reads the given date and time.
 * Two-pass: the first pass's offset is usually right; a second pass catches
 * the (rare) case the correction itself crossed a DST transition.
 * @param {number} year
 * @param {number} month - 1-12.
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {number} Epoch milliseconds.
 */
function pacificWallClockToUtcMs(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = _pacificOffsetMinutesAt(guess);
  const actual1 = guess - offset1 * 60000;
  const offset2 = _pacificOffsetMinutesAt(actual1);
  return offset2 === offset1 ? actual1 : guess - offset2 * 60000;
}

/**
 * The next Thursday 06:00 `America/Los_Angeles` at or after `nowMs` — the
 * weekly reset instant #2599 anchors the weekly window to.
 * @param {number} nowMs - Epoch milliseconds.
 * @returns {number} Epoch milliseconds.
 */
function nextWeeklyResetAtMs(nowMs) {
  const p = pacificParts(nowMs);
  let daysAhead = (WEEKLY_RESET_WEEKDAY - p.weekday + 7) % 7;
  if (daysAhead === 0 && (p.hour > WEEKLY_RESET_HOUR || (p.hour === WEEKLY_RESET_HOUR && p.minute > 0))) {
    daysAhead = 7;
  }
  // Shift the Pacific calendar date by whole days in UTC (date-only
  // arithmetic, so DST on the way never double-counts an hour), then read
  // the shifted date's own y/m/d back out with UTC getters.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day) + daysAhead * 86400000);
  return pacificWallClockToUtcMs(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), WEEKLY_RESET_HOUR, 0);
}

/**
 * The most recent Thursday 06:00 `America/Los_Angeles` at or before `nowMs` —
 * the instant the weekly window currently in effect actually started.
 *
 * Deliberately NOT `nextWeeklyResetAtMs(nowMs) - 7 * 86400000`: a fixed
 * 7-day millisecond subtraction is wrong for the one week each spring/fall
 * that crosses a DST transition (America/Los_Angeles shifts by an hour), and
 * is also wrong exactly AT a reset instant — subtracting 7 days from "now"
 * (which the next-reset calculation also answers as "now" when standing
 * exactly on it) would report last week's start, carrying a week that just
 * ended into the week that just began. This instead derives the boundary
 * from the same real Pacific calendar components {@link nextWeeklyResetAtMs}
 * does, so both directions agree on the same reset even across a transition.
 * @param {number} nowMs - Epoch milliseconds.
 * @returns {number} Epoch milliseconds.
 */
function previousWeeklyResetAtMs(nowMs) {
  const p = pacificParts(nowMs);
  // Minute-granularity parts, so "at or after 06:00" is just "hour >= 6" —
  // there is no finer-grained moment this function can see or needs to.
  const afterOrAtResetToday = p.hour >= WEEKLY_RESET_HOUR;
  let daysBack = (p.weekday - WEEKLY_RESET_WEEKDAY + 7) % 7;
  if (daysBack === 0 && !afterOrAtResetToday) daysBack = 7;
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day) - daysBack * 86400000);
  return pacificWallClockToUtcMs(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), WEEKLY_RESET_HOUR, 0);
}

/**
 * The start of the current Pacific calendar month, as an instant.
 * @param {number} nowMs - Epoch milliseconds.
 * @returns {number} Epoch milliseconds.
 */
function monthStartAtMs(nowMs) {
  const p = pacificParts(nowMs);
  return pacificWallClockToUtcMs(p.year, p.month, 1, 0, 0);
}

/**
 * Every `.jsonl` file under `dir`, found recursively. Missing or unreadable
 * directories answer with no files rather than throwing — a host that has
 * never run one of the two CLIs is the overwhelmingly common case, not a
 * fault.
 * @param {string} dir - Directory to walk.
 * @param {object} [deps] - Seam: `readdir` (defaults to `fs.readdirSync`).
 * @returns {string[]} Absolute paths.
 */
function _walkJsonlFiles(dir, deps = {}) {
  const readdir = deps.readdir || ((d) => fs.readdirSync(d, { withFileTypes: true, recursive: true }));
  let entries;
  try {
    entries = readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    const base = typeof entry.path === 'string' && entry.path ? entry.path : dir;
    out.push(path.join(base, entry.name));
  }
  return out;
}

/**
 * Read a file's lines, skipping one this process cannot read — a log file
 * being rotated or deleted mid-read must not take the whole read down.
 * @param {string} file - Absolute path.
 * @param {object} deps - Seam: `readFile` (defaults to `fs.readFileSync`).
 * @returns {string[]}
 */
function _readLines(file, deps) {
  const readFile = deps.readFile || ((f) => fs.readFileSync(f, 'utf8'));
  let text;
  try {
    text = readFile(file);
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim().length > 0);
}

/**
 * Antigravity's per-conversation log directory, one level under
 * `antigravityBrainDir`, holding `transcript.jsonl` alongside two things
 * that must NEVER be read for usage accounting (#2766 BLOCKING 1/2 root
 * cause — PRR-B Round 2): `transcript_full.jsonl`, a byte-for-byte-equivalent
 * duplicate for every usage-bearing record this module cares about (verified
 * against this machine's own real brain directory — same record count, same
 * token sums, every conversation checked), and `logs/chunks/**\/*.jsonl`, a
 * further chunked duplicate of BOTH of those. A directory recursively
 * walked for every `.jsonl` file (the old behavior, shared with
 * {@link parseClaudeTranscripts}/{@link parseCodexSessions}) reads all of
 * these for every conversation — multiplying both the bytes scanned and the
 * token totals themselves several times over, which is the real reason a
 * 2.6 GB `brain` directory produced a 24.7-36.0s cold scan, not merely "a
 * lot of data": most of the data read was the same handful of records
 * copied repeatedly.
 */
const ANTIGRAVITY_TRANSCRIPT_RELATIVE_PATH = ['.system_generated', 'logs', 'transcript.jsonl'];

/**
 * The one canonical transcript file per Antigravity conversation — never
 * `transcript_full.jsonl` or anything under `logs/chunks/`, see
 * {@link ANTIGRAVITY_TRANSCRIPT_RELATIVE_PATH}. A one-level, non-recursive
 * listing of `dir`'s immediate subdirectories (each a conversation id), so
 * the expensive part of the old recursive walk — descending into every
 * conversation's `scratch/`, `.user_uploaded/`, and `.system_generated/
 * {tasks,messages,steps,logs/chunks}/` subtrees — never happens at all.
 * @param {string} dir - `antigravityBrainDir`.
 * @param {object} deps - Seam: `readdir` (defaults to a non-recursive `fs.readdirSync`).
 * @returns {string[]} Absolute paths; a conversation with no transcript file
 *   contributes its (nonexistent) path anyway — `_readLines` already treats
 *   a missing file as zero lines, same as before this helper existed.
 */
function _listAntigravityTranscriptFiles(dir, deps) {
  const readdir = deps.readdir || ((d) => fs.readdirSync(d, { withFileTypes: true }));
  let entries;
  try {
    entries = readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.isDirectory()) continue;
    out.push(path.join(dir, entry.name, ...ANTIGRAVITY_TRANSCRIPT_RELATIVE_PATH));
  }
  return out;
}

/**
 * Parse a list of `.jsonl` files into records, honoring two opt-in bounds
 * (#2766 BLOCKING 1/2 — PRR-B Rounds 1-2): a cold scan across a host's full
 * transcript history can take tens of seconds, long enough to exceed `tc
 * usage windows`'s CLI timeout on the first call, and repeating that same
 * unbounded scan on a timer stalls the event loop on every refresh, not
 * just the first one.
 *
 * `deps.fileRecordCache` (a `Map`) skips re-reading and re-parsing a file
 * whose `(mtimeMs, size)` has not changed since it was last cached — the
 * dominant cost of a REPEATED scan, since almost no file changes between
 * one pass and the next. `deps.scanDeadlineMs` (an absolute `Date.now()`
 * value) stops `stat`-ing or opening any further file once that wall-clock
 * deadline passes — checked before EVERY file, including during the
 * stat-and-sort pass, not only the read-and-parse pass that follows it, so
 * a huge file COUNT cannot block past budget even before a single byte is
 * read. Files are read newest-mtime-first under a deadline, so a truncated
 * pass keeps the data most likely to matter (the 5-hour and weekly
 * windows). `deps.truncated` (an object with an `any` flag this function
 * sets, never reads) is how a truncated pass tells its caller — a caller
 * that does not pass one cannot observe it, which is fine: it is an
 * internal signal for the bound-cache wrapper, not a public contract. A
 * truncated pass returns only what it managed to read; it is the caller's
 * job (see `_getUsageWindowsCached`) to never trust that as a complete
 * snapshot. Neither bound is set by any existing caller (every test, and
 * every call through `getUsageWindows` that supplies its own `deps`), so
 * behavior is unchanged unless a caller opts in — only the bound-cache
 * wrapper does.
 * @template T
 * @param {string[]} files - Absolute paths, as discovered by the caller
 *   (recursively for Claude/Codex, one file per conversation for
 *   Antigravity — see {@link _listAntigravityTranscriptFiles}).
 * @param {object} deps
 * @param {(lines: string[], file: string) => T[]} parseFile - Parses one file's
 *   lines into that file's own records.
 * @returns {T[]}
 */
function _scanFiles(files, deps, parseFile) {
  const stat = deps.stat || fs.statSync;
  const bounded = Number.isFinite(deps.scanDeadlineMs);
  const cache = deps.fileRecordCache;
  const pastDeadline = () => bounded && Date.now() > deps.scanDeadlineMs;
  const markTruncated = () => { if (deps.truncated) deps.truncated.any = true; };
  let ordered = files;
  let stats = null;
  if (bounded || cache) {
    stats = new Map();
    const statCache = deps.statCache;
    for (const f of files) {
      // A recent cached stat is reused without a syscall at all (#2766
      // BLOCKING 2 — PRR-B Round 3): this is what lets a slow-stat pass's
      // LATER retry skip straight past everything an earlier retry already
      // paid for, rather than re-stat-ing from the start of the list and
      // hitting the deadline at the same point every time.
      const cachedStat = statCache && statCache.get(f);
      if (cachedStat && Date.now() - cachedStat.statAtMs < USAGE_WINDOWS_CACHE_TTL_MS) {
        stats.set(f, cachedStat);
        continue;
      }
      if (pastDeadline()) {
        markTruncated();
        break;
      }
      try {
        const st = stat(f);
        const entry = { mtimeMs: st.mtimeMs, size: st.size, statAtMs: Date.now() };
        stats.set(f, entry);
        if (statCache) statCache.set(f, entry);
      } catch {
        // Vanished between listing and stat (log rotation), or never
        // existed (a conversation with no transcript file yet) — dropped
        // below, same as a file `_readLines` later failed to open would be.
        if (statCache) statCache.delete(f);
      }
    }
    ordered = files.filter((f) => stats.has(f));
    if (bounded) ordered = [...ordered].sort((a, b) => stats.get(b).mtimeMs - stats.get(a).mtimeMs);
  }
  const out = [];
  for (const file of ordered) {
    if (pastDeadline()) {
      markTruncated();
      break;
    }
    if (cache) {
      const st = stats.get(file);
      const cached = cache.get(file);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        out.push(...cached.records);
        continue;
      }
      const records = parseFile(_readLines(file, deps), file);
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, records });
      out.push(...records);
      continue;
    }
    out.push(...parseFile(_readLines(file, deps), file));
  }
  return out;
}

/**
 * One usage record this module reasons about: one turn's token counts for
 * one model, attributed to one provider.
 * @typedef {object} UsageRecord
 * @property {string} provider - `'claude'`, `'codex'`, or `'antigravity'`.
 * @property {string} model - Model id as the CLI's own log names it.
 * @property {string} sessionId - The engine's own session/transcript identity
 *   (Claude: the transcript file's basename; Codex: `payload.session_id`;
 *   Antigravity: the `<conversation-id>` directory name) — `'unknown'` only
 *   where the source record itself carries nothing to key on.
 * @property {number} timestampMs - When the turn completed.
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheCreationInputTokens
 * @property {number} cacheReadInputTokens
 */

/**
 * Parse Claude Code's per-session JSONL transcripts for per-turn token usage.
 *
 * Each assistant turn is one `{"type":"assistant","timestamp":…,"message":
 * {"model":…,"usage":{"input_tokens":…,"output_tokens":…,
 * "cache_creation_input_tokens":…,"cache_read_input_tokens":…}}}` line
 * (verified against this machine's own `~/.claude/projects/*\/*.jsonl`); any
 * other line type, or an assistant line with no `usage` block (a line that is
 * not a model turn), contributes nothing.
 * @param {string} [claudeProjectsDir] - Defaults to `~/.claude/projects`.
 * @param {object} [deps] - Seams: `readdir`, `readFile`, `homedir`.
 * @returns {UsageRecord[]}
 */
function parseClaudeTranscripts(claudeProjectsDir, deps = {}) {
  const dir = claudeProjectsDir || path.join((deps.homedir || os.homedir)(), '.claude', 'projects');
  return _scanFiles(_walkJsonlFiles(dir, deps), deps, (lines, file) => {
    const out = [];
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || obj.type !== 'assistant') continue;
      const message = obj.message;
      const usage = message && message.usage;
      if (!usage || typeof usage !== 'object') continue;
      const timestampMs = Date.parse(obj.timestamp);
      if (!Number.isFinite(timestampMs)) continue;
      out.push({
        provider: 'claude',
        model: typeof message.model === 'string' && message.model ? message.model : 'unknown',
        // The transcript file's own basename IS the session id, by Claude
        // Code's own convention (`<sessionId>.jsonl`) — the same identity
        // `lib/profile-reconciler.js#_readClaudeActiveModel` keys on.
        sessionId: path.basename(file, '.jsonl'),
        timestampMs,
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cacheCreationInputTokens: Number(usage.cache_creation_input_tokens) || 0,
        cacheReadInputTokens: Number(usage.cache_read_input_tokens) || 0
      });
    }
    return out;
  });
}

/**
 * Parse Codex's rollout JSONL session logs for per-turn token usage.
 *
 * Codex's own per-turn record (`{"type":"token_usage_record","payload":
 * {"usage":{"input_tokens":…,"output_tokens":…,"cached_input_tokens":…,
 * "cache_write_input_tokens":…}}}`) carries no model id of its own (verified
 * against this machine's own `~/.codex/sessions/**\/*.jsonl`); the model is
 * instead reported separately, in a `world_state` event's
 * `payload.state.collaboration_mode.model`. This reads each file once, in
 * order, tracking the most recently seen model and attributing every
 * `token_usage_record` after it to that model — `'unknown'` for any usage
 * record that precedes the first `world_state` in its file.
 * @param {string} [codexSessionsDir] - Defaults to `~/.codex/sessions`.
 * @param {object} [deps] - Seams: `readdir`, `readFile`, `homedir`.
 * @returns {UsageRecord[]}
 */
function parseCodexSessions(codexSessionsDir, deps = {}) {
  const dir = codexSessionsDir || path.join((deps.homedir || os.homedir)(), '.codex', 'sessions');
  return _scanFiles(_walkJsonlFiles(dir, deps), deps, (lines) => {
    const out = [];
    let currentModel = 'unknown';
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      const payload = obj.payload;
      if (obj.type === 'world_state' && payload) {
        const model = payload.state && payload.state.collaboration_mode && payload.state.collaboration_mode.model;
        if (typeof model === 'string' && model) currentModel = model;
        continue;
      }
      if (obj.type !== 'token_usage_record' || !payload || !payload.usage) continue;
      const timestampMs = Date.parse(obj.timestamp);
      if (!Number.isFinite(timestampMs)) continue;
      const usage = payload.usage;
      out.push({
        provider: 'codex',
        model: currentModel,
        // `payload.session_id` (verified against this machine's own real
        // rollout files — see this function's own doc comment).
        sessionId: typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown',
        timestampMs,
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cacheCreationInputTokens: Number(usage.cache_write_input_tokens) || 0,
        cacheReadInputTokens: Number(usage.cached_input_tokens) || 0
      });
    }
    return out;
  });
}

/**
 * Parse Antigravity's per-conversation transcript JSONL for per-turn token
 * usage.
 *
 * Each model turn is a `{"step_index":…,"source":"MODEL","type":
 * "PLANNER_RESPONSE","created_at":…,"input_tokens":…,"output_tokens":…,
 * "cache_read_tokens":…}` line (verified against this machine's own
 * `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/
 * logs/transcript.jsonl`); every other step type (`USER_INPUT`, tool-call
 * steps, …) carries no token fields and contributes nothing. Filtered on
 * `typeof input_tokens === 'number'` rather than on `type` alone, so this
 * does not need to enumerate every step type Antigravity might ever add.
 *
 * Two fields this record shape does not have, unlike Claude's and Codex's:
 * a cache-WRITE count (only `cache_read_tokens` exists — reported as
 * `cacheCreationInputTokens: 0`, not omitted, so every `UsageRecord` keeps
 * the same shape) and a per-step model id (reported as `model: 'unknown'`
 * rather than invented from the conversation id or project config, neither
 * of which this function has access to).
 * @param {string} [antigravityBrainDir] - Defaults to `~/.gemini/antigravity-cli/brain`.
 * @param {object} [deps] - Seams: `readdir`, `readFile`, `homedir`.
 * @returns {UsageRecord[]}
 */
function parseAntigravityTranscripts(antigravityBrainDir, deps = {}) {
  const dir = antigravityBrainDir || path.join((deps.homedir || os.homedir)(), '.gemini', 'antigravity-cli', 'brain');
  return _scanFiles(_listAntigravityTranscriptFiles(dir, deps), deps, (lines, file) => {
    const out = [];
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj.input_tokens !== 'number') continue;
      const timestampMs = Date.parse(obj.created_at);
      if (!Number.isFinite(timestampMs)) continue;
      out.push({
        provider: 'antigravity',
        model: 'unknown',
        // The `<conversation-id>` directory name — three levels up from
        // `.system_generated/logs/transcript.jsonl`, verified against this
        // machine's own real layout.
        sessionId: path.basename(path.dirname(path.dirname(path.dirname(file)))),
        timestampMs,
        inputTokens: Number(obj.input_tokens) || 0,
        outputTokens: Number(obj.output_tokens) || 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: Number(obj.cache_read_tokens) || 0
      });
    }
    return out;
  });
}

/**
 * Sum every token field over the records falling in `[startMs, endMs)`.
 * @param {UsageRecord[]} records
 * @param {number} startMs
 * @param {number} endMs
 * @returns {{inputTokens: number, outputTokens: number, cacheCreationInputTokens: number,
 *   cacheReadInputTokens: number, totalTokens: number, windowStart: string, windowEnd: string}}
 */
function _sumWindow(records, startMs, endMs) {
  const sums = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  for (const r of records) {
    if (r.timestampMs < startMs || r.timestampMs >= endMs) continue;
    for (const field of TOKEN_FIELDS) sums[field] += r[field];
  }
  return {
    ...sums,
    totalTokens: sums.inputTokens + sums.outputTokens + sums.cacheCreationInputTokens + sums.cacheReadInputTokens,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString()
  };
}

/**
 * Group records by provider, then model.
 * @param {UsageRecord[]} records
 * @returns {Map<string, Map<string, UsageRecord[]>>}
 */
function _groupByProviderModel(records) {
  const byProvider = new Map();
  for (const r of records) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, new Map());
    const byModel = byProvider.get(r.provider);
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  return byProvider;
}

/**
 * Group records by `sessionId`, then `provider`, then `model` (PRR-A Round
 * 4, #2599 BLOCKING 3) — NOT by `sessionId` alone. A session that switched
 * models mid-session (#2598's own live model switch is exactly this case)
 * has records under more than one model; grouping by `sessionId` alone and
 * attributing the whole session to its FIRST record's model silently folded
 * a later model's usage into the wrong model's bucket.
 * @param {UsageRecord[]} records
 * @returns {Map<string, Map<string, Map<string, UsageRecord[]>>>}
 */
function _groupBySession(records) {
  const bySession = new Map();
  for (const r of records) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, new Map());
    const byProvider = bySession.get(r.sessionId);
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, new Map());
    const byModel = byProvider.get(r.provider);
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  return bySession;
}

/**
 * Per-session rolling windows (#2599 BLOCKING 4, re-keyed by PRR-A Round 4
 * BLOCKING 3 to `(sessionId, provider, model)`) — the same `fiveHour`/
 * `weekly`/`sprint` windows {@link _windowsByProviderModel} computes
 * fleet-wide, now broken out per session so one session's own usage is
 * distinguishable from the model-level roll-up, AND per model within that
 * session, so a session that switched models mid-session gets separate
 * breakdowns for each rather than one combined count misattributed to
 * whichever model its first record happened to name. No `monthly` here: a
 * single session rarely spans a calendar month, and the fleet-wide monthly
 * figure is what a caller asking "how much this month" actually wants.
 * @param {UsageRecord[]} records
 * @param {number} nowMs
 * @param {number|null} sprintStartMs
 * @returns {object} `{[sessionId]: {[provider]: {[model]: {fiveHour, weekly, sprint}}}}`
 */
function _windowsBySession(records, nowMs, sprintStartMs) {
  const weeklyStart = previousWeeklyResetAtMs(nowMs);
  const fiveHourStart = nowMs - FIVE_HOUR_MS;
  const out = {};
  for (const [sessionId, byProvider] of _groupBySession(records)) {
    out[sessionId] = {};
    for (const [provider, byModel] of byProvider) {
      out[sessionId][provider] = {};
      for (const [model, modelRecords] of byModel) {
        out[sessionId][provider][model] = {
          fiveHour: _sumWindow(modelRecords, fiveHourStart, nowMs + 1),
          weekly: _sumWindow(modelRecords, weeklyStart, nowMs + 1),
          sprint: Number.isFinite(sprintStartMs) ? _sumWindow(modelRecords, sprintStartMs, nowMs + 1) : null
        };
      }
    }
  }
  return out;
}

/** How far back the sprint window falls back to when no real anchor can be found at all. */
const DEFAULT_SPRINT_FALLBACK_MS = 24 * 3600000;

/**
 * A default `sprintStartMs` when the caller gives none: the timestamp of
 * this install's own most recent git tag (`git describe --tags --abbrev=0`,
 * then that tag's commit time) — a real anchor in THIS repo's own dual-
 * sprint versioning convention (each tag IS a sprint boundary here), not an
 * invented fixed span. Falls back to `nowMs - 24h` when there is no git
 * repo, no tag, or git itself is unavailable — still a real instant, never
 * null, so `windows.sprint` is populated whenever a caller asks for the
 * auto-resolved default rather than an explicit `sprintStartMs`.
 * @param {number} nowMs
 * @param {object} [deps] - Seams: `execGit` (defaults to a real `execFileSync('git', …, {cwd: repoRoot})`), `repoRoot` (defaults to `process.cwd()`).
 * @returns {number}
 */
function _defaultSprintStartMs(nowMs, deps = {}) {
  const repoRoot = deps.repoRoot || process.cwd();
  const execGit = deps.execGit || ((args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }));
  try {
    const tag = execGit(['describe', '--tags', '--abbrev=0']).trim();
    const epochSeconds = execGit(['log', '-1', '--format=%ct', tag]).trim();
    const ms = Number(epochSeconds) * 1000;
    if (Number.isFinite(ms) && ms > 0) return ms;
  } catch {
    // No repo, no tag, or git unavailable — fall through to the fixed fallback.
  }
  return nowMs - DEFAULT_SPRINT_FALLBACK_MS;
}

/**
 * The three rolling windows for every (provider, model) found in `records`.
 * @param {UsageRecord[]} records
 * @param {number} nowMs
 * @returns {object} `{[provider]: {[model]: {fiveHour, weekly, monthly}}}`
 */
function _windowsByProviderModel(records, nowMs, sprintStartMs) {
  const weeklyStart = previousWeeklyResetAtMs(nowMs);
  const monthlyStart = monthStartAtMs(nowMs);
  const fiveHourStart = nowMs - FIVE_HOUR_MS;
  const out = {};
  for (const [provider, byModel] of _groupByProviderModel(records)) {
    out[provider] = {};
    for (const [model, modelRecords] of byModel) {
      out[provider][model] = {
        fiveHour: _sumWindow(modelRecords, fiveHourStart, nowMs + 1),
        weekly: _sumWindow(modelRecords, weeklyStart, nowMs + 1),
        monthly: _sumWindow(modelRecords, monthlyStart, nowMs + 1),
        // Null, not a fabricated default boundary, when the caller gives no
        // sprint start: this repo's own "sprint" is a Charter-dispatched
        // span of arbitrary length (LANE_QUEUE's own Sprint/Wave sections),
        // not a fixed-duration calendar window this module could derive on
        // its own without guessing at a boundary nothing here is told.
        sprint: Number.isFinite(sprintStartMs) ? _sumWindow(modelRecords, sprintStartMs, nowMs + 1) : null
      };
    }
  }
  return out;
}

/**
 * The calibration store {@link calibrateUsage}/{@link getCalibration} use
 * absent an injected one: `usage_calibration` (schema v75), durable across a
 * restart — a calibration is an operator's standing correction, not a
 * per-process cache, so losing it on every restart would be the wrong
 * default. A caller that wants a different store (a test, in particular —
 * nothing in this file's own test suite should touch the real database)
 * injects `deps.calibrationStore` with the same `get`/`set` shape.
 * @returns {{get: function(string): (object|null), set: function(string, object): void}}
 */
function _defaultStore() {
  // Lazy: a store-free caller of the parsers alone (deps.calibrationStore
  // always supplied) must never pay for opening the database.
  const store = require('./store');
  return {
    get: (provider) => store.usageCalibration.get(provider),
    set: (provider, value) => store.usageCalibration.set(provider, value)
  };
}

/**
 * Validate a calibration input. Percentages are "remaining", 0-100.
 * @param {*} input
 * @returns {string[]} Problems; empty when usable.
 */
function _validateCalibrationInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return ['calibration input must be an object'];
  if (!PROVIDERS.includes(input.provider)) errors.push(`provider must be one of ${PROVIDERS.join(', ')}`);
  for (const field of ['weeklyPct', 'fiveHourPct']) {
    if (input[field] === undefined || input[field] === null) continue;
    if (!(Number.isFinite(input[field]) && input[field] >= 0 && input[field] <= 100)) {
      errors.push(`${field} must be a number between 0 and 100 when present`);
    }
  }
  if (input.weeklyPct === undefined && input.fiveHourPct === undefined) {
    errors.push('at least one of weeklyPct or fiveHourPct is required');
  }
  return errors;
}

/**
 * Record an operator's percentage calibration for a provider — the remaining
 * headroom the provider's OWN dashboard reports, which parsed-transcript
 * token totals cannot derive (a provider's quota accounting can weight or cap
 * tokens differently than a raw count).
 * @param {{provider: string, weeklyPct?: number, fiveHourPct?: number, calibratedAt?: number}} input
 * @param {object} [deps] - Seams: `calibrationStore`, `now`.
 * @returns {{ok: true, calibration: object}|{ok: false, errors: string[]}}
 */
function calibrateUsage(input, deps = {}) {
  const errors = _validateCalibrationInput(input);
  if (errors.length > 0) return { ok: false, errors };
  const calStore = deps.calibrationStore || _defaultStore();
  const calibratedAt = Number.isFinite(input.calibratedAt) ? input.calibratedAt : (deps.now || Date.now)();
  const record = {
    provider: input.provider,
    weeklyPct: Number.isFinite(input.weeklyPct) ? input.weeklyPct : null,
    fiveHourPct: Number.isFinite(input.fiveHourPct) ? input.fiveHourPct : null,
    calibratedAt
  };
  calStore.set(input.provider, record);
  return { ok: true, calibration: record };
}

/**
 * The calibration on file for a provider, or null.
 * @param {string} provider
 * @param {object} [deps] - Seam: `calibrationStore`.
 * @returns {object|null}
 */
function getCalibration(provider, deps = {}) {
  const calStore = deps.calibrationStore || _defaultStore();
  return calStore.get(provider) || null;
}

/**
 * Whether a provider's calibrated weekly remaining is still above the
 * low-headroom threshold. True (headroom assumed fine) when nothing has been
 * calibrated — calibration is an operator correction, not a precondition.
 * @param {string} provider
 * @param {number} thresholdPct
 * @param {object} deps
 * @returns {boolean}
 */
function _weeklyHeadroomOk(provider, thresholdPct, deps) {
  const cal = getCalibration(provider, deps);
  if (!cal || !Number.isFinite(cal.weeklyPct)) return true;
  return cal.weeklyPct >= thresholdPct;
}

/**
 * #2599's two named windows. Conservation is Friday through Tuesday
 * (Pacific), OR calibrated weekly headroom below the threshold, OR the
 * default for any Pacific time not explicitly named by the
 * Use-It-or-Lose-It slot below — Thursday daytime, right after the reset,
 * falls here deliberately: it is the start of a fresh week, not yet the
 * pre-reset window the Use-It-or-Lose-It slot exists for.
 *
 * Use-It-or-Lose-It is Wednesday 00:00 through Thursday 06:00 (Pacific) —
 * the run-up to the weekly reset — and only while weekly headroom remains:
 * a provider already low on headroom stays in Conservation even inside this
 * slot.
 * @param {number} nowMs
 * @param {string} provider - Whose calibration gates the slot.
 * @param {number} thresholdPct
 * @param {object} deps
 * @returns {'conservation'|'use-it-or-lose-it'}
 */
function windowKind(nowMs, provider, thresholdPct, deps) {
  const p = pacificParts(nowMs);
  const inUseItSlot = p.weekday === 3 || (p.weekday === 4 && p.hour < WEEKLY_RESET_HOUR);
  if (inUseItSlot && _weeklyHeadroomOk(provider, thresholdPct, deps)) return 'use-it-or-lose-it';
  return 'conservation';
}

/**
 * The Builder model-tier recommendation for a window kind.
 * @param {'conservation'|'use-it-or-lose-it'} kind
 * @returns {{window: string, recommendedModels: string[], reservedModels: string[], reason: string}}
 */
function recommendedPolicy(kind) {
  if (kind === 'use-it-or-lose-it') {
    return {
      window: kind,
      recommendedModels: [MODEL_TIERS.BOUNDED, ...MODEL_TIERS.MULTI_SEAM],
      reservedModels: [],
      reason: 'Weekly headroom remains ahead of the Thursday 06:00 PT reset — step Builder lanes up before it resets unused.'
    };
  }
  return {
    window: kind,
    recommendedModels: [MODEL_TIERS.BOUNDED],
    reservedModels: MODEL_TIERS.MULTI_SEAM,
    reason: 'Conservation window — reserve the higher tiers for multi-seam cars and keep bounded Builder lanes on the cheaper model.'
  };
}

/**
 * The full usage-window read #2599 asks for: parsed telemetry's rolling
 * windows per provider/model, the weekly reset schedule, each provider's
 * calibration (if any), and the recommended Builder model-tier policy.
 * @param {object} [opts]
 * @param {string} [opts.claudeProjectsDir] - Override for {@link parseClaudeTranscripts}.
 * @param {string} [opts.codexSessionsDir] - Override for {@link parseCodexSessions}.
 * @param {string} [opts.antigravityBrainDir] - Override for {@link parseAntigravityTranscripts}.
 * @param {number} [opts.nowMs] - Clock; defaults to `Date.now()`.
 * @param {string} [opts.policyProvider] - Which provider's calibration gates the
 *   recommended policy's window kind. Defaults to `'claude'` — the provider
 *   whose fleet (#2599's own worked example) this policy exists for.
 * @param {number} [opts.lowHeadroomThresholdPct] - Defaults to {@link DEFAULT_LOW_HEADROOM_THRESHOLD_PCT}.
 * @param {number|null} [opts.sprintStartMs] - Each (provider, model) gets a
 *   `sprint` window summed from this instant. Left `undefined`, it is
 *   auto-resolved via {@link _defaultSprintStartMs} (this install's latest
 *   git tag, or `now - 24h`) so `windows.sprint` is always populated by
 *   default; pass `null` explicitly to opt OUT and get `sprint: null`
 *   instead, when a caller means something more specific by "sprint" than
 *   this module's own best guess.
 * @param {object} [opts.calibrationStore] - Seam; see {@link calibrateUsage}.
 * @param {object} [opts.deps] - Parse-time seams forwarded to the parsers (`readdir`, `readFile`, `homedir`).
 * @returns {object}
 */
function getUsageWindows(opts = {}) {
  if (_usageWindowsCacheEligible(opts)) return _getUsageWindowsCached(opts);
  return _computeUsageWindows(opts);
}

/**
 * How long a cached snapshot is served before the next call pays for a
 * fresh scan (#2766). The background warmer (below) runs well inside this,
 * so in steady state a caller only ever sees the cached result, never the
 * cold scan.
 */
const USAGE_WINDOWS_CACHE_TTL_MS = 30000;

/** How often the background warmer refreshes a key already in the cache. */
const USAGE_WINDOWS_REFRESH_INTERVAL_MS = 20000;

/**
 * Wall-clock budget for one scan pass behind the cache (#2766 BLOCKING 1/2 —
 * PRR-B Round 1). The cold path (the very first call, before anything is
 * cached) and every background refresh both go through
 * {@link _boundedScanDeps}, so neither one can block the event loop longer
 * than this, however large the real transcript history is — a truncated
 * pass is incomplete, not slow, and `_usageWindowsFileRecordCache` means the
 * NEXT pass (a real caller forced to compute, or the warmer 20s later) picks
 * up wherever this one left off rather than re-paying for files it already
 * parsed.
 */
const USAGE_WINDOWS_SCAN_BUDGET_MS = 1500;

/** @type {Map<string, {result: object, computedAtMs: number}>} */
const _usageWindowsCache = new Map();

/**
 * Per-file parsed-record cache, shared across every bound-cache-eligible
 * call and every warmer tick (#2766 BLOCKING 2): keyed by absolute path,
 * holding the `(mtimeMs, size)` last seen for that file and what it parsed
 * to, via {@link _scanFiles}. An unchanged file costs one `stat` on a
 * repeat pass instead of a full read-and-parse, which is what actually
 * keeps the 20s warmer cheap once a host's history is warm.
 * @type {Map<string, {mtimeMs: number, size: number, records: object[]}>}
 */
const _usageWindowsFileRecordCache = new Map();

/**
 * Per-file STAT cache (#2766 BLOCKING 2 — PRR-B Round 3): separate from
 * {@link _usageWindowsFileRecordCache} because a file can be stat-ed long
 * before it is ever read. Without this, every bounded pass re-stats from
 * the START of the file list — if `stat` work ALONE (not reading) ever
 * exceeds `USAGE_WINDOWS_SCAN_BUDGET_MS`, every retry hits the deadline at
 * the same point and NEVER reaches a later file, so `complete` never
 * becomes `true` no matter how many times the warmer ticks. A cached stat
 * younger than `USAGE_WINDOWS_CACHE_TTL_MS` is reused instead of re-stat-ed,
 * so a slow-stat pass's later retries skip what earlier ones already paid
 * for and keep moving forward through the list — monotonic progress
 * toward a complete pass, the same guarantee the record cache gives the
 * read loop. Old enough to be stale, it is re-stat-ed normally, so a real
 * change is still caught; nothing here weakens the record cache's own
 * change detection, which always compares against a freshly-seen stat.
 * @type {Map<string, {mtimeMs: number, size: number, statAtMs: number}>}
 */
const _usageWindowsStatCache = new Map();

/** @type {NodeJS.Timeout|null} */
let _usageWindowsWarmTimer = null;

/**
 * The `deps` a bounded scan runs with: the shared file-record cache, plus a
 * fresh deadline `USAGE_WINDOWS_SCAN_BUDGET_MS` from now. A new deadline
 * every call — the budget is per PASS, not a standing clock the process
 * could run out of.
 * @returns {{fileRecordCache: Map, scanDeadlineMs: number}}
 */
function _boundedScanDeps() {
  return {
    fileRecordCache: _usageWindowsFileRecordCache,
    statCache: _usageWindowsStatCache,
    scanDeadlineMs: Date.now() + USAGE_WINDOWS_SCAN_BUDGET_MS,
    // Written by `_scanFiles`, read by `_getUsageWindowsCached`/the warmer
    // through `result.complete` (#2766 BLOCKING 2) — a fresh object every
    // call, never shared across passes, so one pass's truncation can never
    // be misread as another's.
    truncated: { any: false }
  };
}

/**
 * Whether a call's inputs are the plain production shape this cache exists
 * for — no caller has ever supplied any of these: they are test-only seams
 * (a directory override, a fixed clock, an injected store) that exist
 * precisely so a test can see fresh, deterministic data on every call. A
 * call naming any of them opts out of caching entirely and always gets a
 * direct, uncached computation — the same behavior this function had before
 * #2766, so no existing caller or test observes any change.
 * @param {object} opts
 * @returns {boolean}
 */
function _usageWindowsCacheEligible(opts) {
  return opts.claudeProjectsDir === undefined
    && opts.codexSessionsDir === undefined
    && opts.antigravityBrainDir === undefined
    && opts.nowMs === undefined
    && opts.aggregatesStore === undefined
    && opts.calibrationStore === undefined
    && opts.sprintStartMs === undefined
    && opts.lowHeadroomThresholdPct === undefined;
}

/**
 * Bound-cache (#2766): a cold scan across this host's full transcript
 * history can take tens of seconds — long enough to exceed `tc usage
 * windows`'s CLI timeout. Only `opts.policyProvider` varies across the
 * eligible call shape, so it is the whole cache key; a fresh-enough entry is
 * returned immediately, and any other call recomputes and (re)starts the
 * background warmer so the NEXT call for that key is cheap too.
 * @param {object} opts
 * @returns {object}
 */
function _getUsageWindowsCached(opts) {
  const key = opts.policyProvider || 'claude';
  const cached = _usageWindowsCache.get(key);
  // #2766 BLOCKING 2 (PRR-B Round 1/2): an entry from a TRUNCATED pass is
  // never treated as fresh-enough, however recent — it is a known-partial
  // answer, not a complete one merely due for its next refresh, so every
  // call keeps trying (each still individually bounded by the scan budget)
  // until a pass completes. The per-file cache means each retry is cheaper
  // than the last, converging quickly rather than retrying from scratch.
  if (cached && cached.result.complete && Date.now() - cached.computedAtMs < USAGE_WINDOWS_CACHE_TTL_MS) {
    return cached.result;
  }
  const result = _computeUsageWindows({ ...opts, deps: { ...opts.deps, ..._boundedScanDeps() } });
  _startUsageWindowsWarmer();
  if (result.complete || !cached || !cached.result.complete) {
    _usageWindowsCache.set(key, { result, computedAtMs: Date.now() });
    return result;
  }
  // This pass truncated, but a PRIOR complete pass's entry is still on
  // file — serve that rather than regress to a fresher but undercounting
  // answer. The file-record cache still grew, so the next attempt is
  // cheaper and likelier to finish; nothing is lost by waiting for it.
  return cached.result;
}

/**
 * Pre-warm (#2766): proactively refreshes every key the cache already holds
 * so a caller arriving after `USAGE_WINDOWS_CACHE_TTL_MS` still finds a warm
 * entry rather than paying for the cold scan itself. Started lazily on the
 * first cache-eligible call and left running (`.unref()`'d so it never
 * holds the process open on its own); a refresh that throws (a transient
 * read error) is logged and leaves the last good entry in place rather than
 * evicting it or crashing the timer.
 */
function _startUsageWindowsWarmer() {
  if (_usageWindowsWarmTimer) return;
  _usageWindowsWarmTimer = setInterval(() => {
    for (const key of _usageWindowsCache.keys()) {
      try {
        const existing = _usageWindowsCache.get(key);
        const result = _computeUsageWindows({ policyProvider: key, deps: _boundedScanDeps() });
        // Same regression guard as the cold path (#2766 BLOCKING 2): a
        // truncated refresh must not replace an existing COMPLETE entry
        // with a worse, undercounting one.
        if (result.complete || !existing || !existing.result.complete) {
          _usageWindowsCache.set(key, { result, computedAtMs: Date.now() });
        }
      } catch (err) {
        log.warn('usage-windows background warmer failed; serving the last cached snapshot', { provider: key, error: err.message });
      }
    }
  }, USAGE_WINDOWS_REFRESH_INTERVAL_MS);
  _usageWindowsWarmTimer.unref();
}

/**
 * Test-only: drops every cached entry and stops the background warmer, so
 * each test starts from a clean cache regardless of what an earlier test
 * left behind.
 */
function _resetUsageWindowsCacheForTests() {
  _usageWindowsCache.clear();
  _usageWindowsFileRecordCache.clear();
  _usageWindowsStatCache.clear();
  if (_usageWindowsWarmTimer) {
    clearInterval(_usageWindowsWarmTimer);
    _usageWindowsWarmTimer = null;
  }
}

/**
 * Test-only: the live cache map, so a test can inspect entry counts or back-date
 * `computedAtMs` to force the next call past TTL without waiting on a real clock.
 * @returns {Map<string, {result: object, computedAtMs: number}>}
 */
function _usageWindowsCacheForTests() {
  return _usageWindowsCache;
}

function _computeUsageWindows(opts) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const deps = opts.deps || {};
  const records = [
    ...parseClaudeTranscripts(opts.claudeProjectsDir, deps),
    ...parseCodexSessions(opts.codexSessionsDir, deps),
    ...parseAntigravityTranscripts(opts.antigravityBrainDir, deps)
  ];
  const thresholdPct = Number.isFinite(opts.lowHeadroomThresholdPct) ? opts.lowHeadroomThresholdPct : DEFAULT_LOW_HEADROOM_THRESHOLD_PCT;
  const policyProvider = opts.policyProvider || 'claude';
  const calibDeps = { calibrationStore: opts.calibrationStore };
  const resetAt = nextWeeklyResetAtMs(nowMs);
  const kind = windowKind(nowMs, policyProvider, thresholdPct, calibDeps);

  const calibration = {};
  for (const provider of PROVIDERS) calibration[provider] = getCalibration(provider, calibDeps);

  const sprintStartMs = opts.sprintStartMs === undefined ? _defaultSprintStartMs(nowMs, deps) : opts.sprintStartMs;
  const byProviderModel = _windowsByProviderModel(records, nowMs, sprintStartMs);
  const bySession = _windowsBySession(records, nowMs, sprintStartMs);

  // #2766 BLOCKING 2 (PRR-B Round 1): `deps.truncated` is set only by the
  // bound-cache wrapper (`_boundedScanDeps`) — every other caller sees
  // `complete: true` unconditionally, unchanged from before this existed.
  // A truncated pass skips the persisted-aggregate upsert too: `upsertMany`
  // REPLACES the stored row for each (provider, model)/(session, provider,
  // model) key, so writing partial sums here would overwrite a prior
  // COMPLETE pass's numbers with smaller, wrong ones — `getStoredAggregates`
  // must keep answering from the last trustworthy pass, not this one.
  const complete = deps.truncated ? !deps.truncated.any : true;
  if (complete) {
    const aggregatesStore = opts.aggregatesStore || _defaultAggregatesStore();
    aggregatesStore.upsertMany([
      ..._flattenAggregateRows(byProviderModel, nowMs),
      ..._flattenSessionAggregateRows(bySession, nowMs)
    ]);
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    resetSchedule: {
      nextWeeklyResetAt: new Date(resetAt).toISOString(),
      hoursUntilWeeklyReset: Math.max(0, (resetAt - nowMs) / 3600000)
    },
    byProviderModel,
    bySession,
    calibration,
    recommendedPolicy: recommendedPolicy(kind),
    complete
  };
}

/**
 * The default store {@link getUsageWindows} upserts computed aggregates
 * into: `store.usageWindowAggregates` (schema v76). A caller that wants a
 * different store (every test in this file's own suite) injects
 * `opts.aggregatesStore` with the same `upsertMany`/`listAll` shape.
 * @returns {{upsertMany: function(Array<object>): void, listAll: function(): Array<object>}}
 */
function _defaultAggregatesStore() {
  // Lazy, same reason the calibration default is: a store-free caller must
  // never pay for opening the database.
  const store = require('./store');
  return store.usageWindowAggregates;
}

/**
 * Flatten `byProviderModel` into the flat rows {@link module:lib/store}'s
 * `usageWindowAggregates.upsertMany` takes — one row per (provider, model,
 * window kind) actually present, `sprint` included only when it is not
 * null. `sessionId: ''` — these are the fleet-wide, per-model rows.
 * @param {object} byProviderModel - As {@link getUsageWindows} returns it.
 * @param {number} nowMs
 * @returns {Array<object>}
 */
function _flattenAggregateRows(byProviderModel, nowMs) {
  const rows = [];
  for (const [provider, byModel] of Object.entries(byProviderModel)) {
    for (const [model, windows] of Object.entries(byModel)) {
      for (const windowKindName of ['fiveHour', 'weekly', 'monthly', 'sprint']) {
        const w = windows[windowKindName];
        if (!w) continue;
        rows.push({
          sessionId: '', provider, model, windowKind: windowKindName,
          inputTokens: w.inputTokens, outputTokens: w.outputTokens,
          cacheCreationTokens: w.cacheCreationInputTokens, cacheReadTokens: w.cacheReadInputTokens,
          totalTokens: w.totalTokens, windowStart: w.windowStart, windowEnd: w.windowEnd, computedAt: nowMs
        });
      }
    }
  }
  return rows;
}

/**
 * Flatten `bySession` (#2599 BLOCKING 4, re-keyed by PRR-A Round 4 BLOCKING
 * 3) the same way {@link _flattenAggregateRows} flattens `byProviderModel`
 * — one row per (session, provider, model, window kind) actually present,
 * this time with the session's own non-empty `sessionId`. A session that
 * used two models produces two separate rows, never one combined count
 * misattributed to a single model.
 * @param {object} bySession - As {@link getUsageWindows} returns it: `{[sessionId]: {[provider]: {[model]: {fiveHour?, weekly?, sprint?}}}}`.
 * @param {number} nowMs
 * @returns {Array<object>}
 */
function _flattenSessionAggregateRows(bySession, nowMs) {
  const rows = [];
  for (const [sessionId, byProvider] of Object.entries(bySession)) {
    for (const [provider, byModel] of Object.entries(byProvider)) {
      for (const [model, windows] of Object.entries(byModel)) {
        for (const windowKindName of ['fiveHour', 'weekly', 'sprint']) {
          const w = windows[windowKindName];
          if (!w) continue;
          rows.push({
            sessionId, provider, model, windowKind: windowKindName,
            inputTokens: w.inputTokens, outputTokens: w.outputTokens,
            cacheCreationTokens: w.cacheCreationInputTokens, cacheReadTokens: w.cacheReadInputTokens,
            totalTokens: w.totalTokens, windowStart: w.windowStart, windowEnd: w.windowEnd, computedAt: nowMs
          });
        }
      }
    }
  }
  return rows;
}

/**
 * The stored-aggregates read fallback (#2599): the last computed windows
 * {@link getUsageWindows} upserted, reshaped back into `byModel`/`bySession`
 * structures — for a caller that wants the last known numbers without
 * reparsing any transcript log (the source of truth itself, which this is a
 * cache of, never the other way around).
 * @param {{sessionId?: string}} [opts] - `sessionId` narrows to one session's
 *   own rows (returned directly, not wrapped); omitted, returns both.
 * @param {object} [deps] - Seam: `aggregatesStore`.
 * @returns {object|null} With `opts.sessionId`: that session's
 *   `{[provider]: {[model]: {fiveHour?, weekly?, sprint?}}}` — nested the
 *   same way `byModel` is, since a session that switched models (or,
 *   boundary-mode, providers) mid-session has rows under more than one —
 *   or `null` if it has no rows on file. Without it: `{byModel, bySession}`,
 *   each shaped the way {@link getUsageWindows}'s own
 *   `byProviderModel`/`bySession` are — only the window kinds actually on
 *   file for a given key are present.
 */
function getStoredAggregates(opts = {}, deps = {}) {
  const aggregatesStore = deps.aggregatesStore || _defaultAggregatesStore();
  if (opts.sessionId !== undefined) {
    const rows = aggregatesStore.listAll({ sessionId: opts.sessionId });
    if (rows.length === 0) return null;
    const out = {};
    for (const row of rows) {
      if (!out[row.provider]) out[row.provider] = {};
      if (!out[row.provider][row.model]) out[row.provider][row.model] = {};
      out[row.provider][row.model][row.windowKind] = {
        inputTokens: row.inputTokens, outputTokens: row.outputTokens,
        cacheCreationInputTokens: row.cacheCreationTokens, cacheReadInputTokens: row.cacheReadTokens,
        totalTokens: row.totalTokens, windowStart: row.windowStart, windowEnd: row.windowEnd, computedAt: row.computedAt
      };
    }
    return out;
  }
  const byModel = {};
  const bySession = {};
  for (const row of aggregatesStore.listAll()) {
    const w = {
      inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      cacheCreationInputTokens: row.cacheCreationTokens, cacheReadInputTokens: row.cacheReadTokens,
      totalTokens: row.totalTokens, windowStart: row.windowStart, windowEnd: row.windowEnd, computedAt: row.computedAt
    };
    if (row.sessionId === '') {
      if (!byModel[row.provider]) byModel[row.provider] = {};
      if (!byModel[row.provider][row.model]) byModel[row.provider][row.model] = {};
      byModel[row.provider][row.model][row.windowKind] = w;
    } else {
      if (!bySession[row.sessionId]) bySession[row.sessionId] = {};
      if (!bySession[row.sessionId][row.provider]) bySession[row.sessionId][row.provider] = {};
      if (!bySession[row.sessionId][row.provider][row.model]) bySession[row.sessionId][row.provider][row.model] = {};
      bySession[row.sessionId][row.provider][row.model][row.windowKind] = w;
    }
  }
  return { byModel, bySession };
}

module.exports = {
  pacificParts,
  pacificWallClockToUtcMs,
  nextWeeklyResetAtMs,
  previousWeeklyResetAtMs,
  parseClaudeTranscripts,
  parseCodexSessions,
  parseAntigravityTranscripts,
  calibrateUsage,
  getCalibration,
  windowKind,
  recommendedPolicy,
  getUsageWindows,
  getStoredAggregates,
  USAGE_WINDOWS_CACHE_TTL_MS,
  USAGE_WINDOWS_SCAN_BUDGET_MS,
  _resetUsageWindowsCacheForTests,
  _usageWindowsCacheForTests
};
