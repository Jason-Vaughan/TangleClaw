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
 * One usage record this module reasons about: one turn's token counts for
 * one model, attributed to one provider.
 * @typedef {object} UsageRecord
 * @property {string} provider - `'claude'` or `'codex'`.
 * @property {string} model - Model id as the CLI's own log names it.
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
  const records = [];
  for (const file of _walkJsonlFiles(dir, deps)) {
    for (const line of _readLines(file, deps)) {
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
      records.push({
        provider: 'claude',
        model: typeof message.model === 'string' && message.model ? message.model : 'unknown',
        timestampMs,
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cacheCreationInputTokens: Number(usage.cache_creation_input_tokens) || 0,
        cacheReadInputTokens: Number(usage.cache_read_input_tokens) || 0
      });
    }
  }
  return records;
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
  const records = [];
  for (const file of _walkJsonlFiles(dir, deps)) {
    let currentModel = 'unknown';
    for (const line of _readLines(file, deps)) {
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
      records.push({
        provider: 'codex',
        model: currentModel,
        timestampMs,
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cacheCreationInputTokens: Number(usage.cache_write_input_tokens) || 0,
        cacheReadInputTokens: Number(usage.cached_input_tokens) || 0
      });
    }
  }
  return records;
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
  const records = [];
  for (const file of _walkJsonlFiles(dir, deps)) {
    for (const line of _readLines(file, deps)) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj.input_tokens !== 'number') continue;
      const timestampMs = Date.parse(obj.created_at);
      if (!Number.isFinite(timestampMs)) continue;
      records.push({
        provider: 'antigravity',
        model: 'unknown',
        timestampMs,
        inputTokens: Number(obj.input_tokens) || 0,
        outputTokens: Number(obj.output_tokens) || 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: Number(obj.cache_read_tokens) || 0
      });
    }
  }
  return records;
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

  const aggregatesStore = opts.aggregatesStore || _defaultAggregatesStore();
  aggregatesStore.upsertMany(_flattenAggregateRows(byProviderModel, nowMs));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    resetSchedule: {
      nextWeeklyResetAt: new Date(resetAt).toISOString(),
      hoursUntilWeeklyReset: Math.max(0, (resetAt - nowMs) / 3600000)
    },
    byProviderModel,
    calibration,
    recommendedPolicy: recommendedPolicy(kind)
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
 * window kind) actually present, `sprint` included only when it is not null.
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
          provider, model, windowKind: windowKindName,
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
 * The stored-aggregates read fallback (#2599): the last computed window per
 * (provider, model, window kind) that {@link getUsageWindows} upserted,
 * reshaped into the same `byProviderModel` structure — for a caller that
 * wants the last known numbers without reparsing any transcript log (the
 * source of truth itself, which this is a cache of, never the other way
 * around).
 * @param {object} [deps] - Seam: `aggregatesStore`.
 * @returns {object} `{[provider]: {[model]: {fiveHour?, weekly?, monthly?, sprint?}}}` —
 *   only the window kinds actually on file for that (provider, model) are present.
 */
function getStoredAggregates(deps = {}) {
  const aggregatesStore = deps.aggregatesStore || _defaultAggregatesStore();
  const out = {};
  for (const row of aggregatesStore.listAll()) {
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
  getStoredAggregates
};
