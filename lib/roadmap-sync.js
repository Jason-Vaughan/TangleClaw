'use strict';

/**
 * Incremental roadmap sync state, a publish gate, and GraphQL budget
 * telemetry (#2259).
 *
 * Measured on 2026-10-09: one refresh of the roadmap-sync job cost ~770
 * GraphQL points because `build-roadmap2.py` kept nothing between runs and
 * asked GitHub about every roadmap issue (and, since then, every roadmap
 * issue's linked PRs) on every run, whether or not anything had changed —
 * about 4,600 of the account's 5,000-point hourly budget, and 23 `gh-pages`
 * pushes in 24 hours, several of which carried no roadmap content change at
 * all (one changed only `roadmap-sync-status.json`'s own status field).
 *
 * This module is the fix's logic, as a self-contained library: a sync-state
 * snapshot format, a diff that says which issues actually need re-reading,
 * a full-resync fallback for whatever the incremental diff misses, a publish
 * gate that looks at the rendered roadmap's own content rather than the
 * status file, and a telemetry record so a regression is visible without a
 * manual measurement. `build-roadmap2.py` and the `com.tangleclaw.roadmap-
 * sync` launchd job live in a separate repository this checkout does not
 * hold and is read-only on ("the shared roadmap directory", per the issue's
 * own notes) — nothing here writes to that job's actual output; every
 * function takes plain JS objects/strings so that job can adopt the logic.
 *
 * The one piece that does reach GitHub, {@link fetchIssueSummaries}, mirrors
 * `lib/gh-issue-state.js`'s honesty rule: a lookup that could not run
 * answers `{available: false, reason}` rather than guessing, and only
 * definite answers are worth trusting for the diff above.
 *
 * {@link fetchLinkedPrIds} implements the cross-referenced-timeline
 * heuristic the issue names for "a PR newly linked to an old issue marks
 * that issue as changed" — the issue's own "To prove before relying on it"
 * section flags exactly this mechanism as **not tested** against a real
 * sync run. Treat its results as best-effort until measured.
 *
 * @module lib/roadmap-sync
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileArgs, describeFailure, didNotRun } = require('./exec');
const stagedWrite = require('./staged-write');
const { createLogger } = require('./logger');

const log = createLogger('roadmap-sync');

/** Error for sync-state input that does not match this module's contract. */
class RoadmapSyncError extends Error {}

function _need(cond, msg) {
  if (!cond) throw new RoadmapSyncError(msg);
}

/** Schema tag of a persisted sync-state snapshot. */
const SCHEMA = 'tc.roadmap-sync-state/v1';

/** Schema tag of a built status payload. */
const STATUS_SCHEMA = 'tc.roadmap-sync-status/v1';

/** How long between full re-reads, covering whatever the incremental diff misses — #2259's own "daily, say." */
const DEFAULT_FULL_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

const EXEC_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Parallel `gh` calls per batch — the same bound `lib/gh-issue-state.js` uses, for the same reason (quick, but not rate-limit-tripping). */
const CONCURRENCY = 4;
const NOT_FOUND_RE = /\(HTTP 404\)|\(HTTP 410\)/;

/**
 * This module's runner, overridable via `_internal` for tests. Never
 * rejects; prompts are disabled by `lib/exec.js`.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd: (string|undefined)}} options
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, error:(string|null), errorCode:(string|null), timedOut:boolean}>}
 */
function defaultExec(file, args, options) {
  return execFileArgs(file, args, { cwd: options && options.cwd, timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: MAX_BUFFER_BYTES });
}

const _internal = { exec: defaultExec };

/**
 * An empty sync state: nothing has ever been read.
 * @returns {object}
 */
function emptyState() {
  return { schema: SCHEMA, lastRunAt: null, lastFullResyncAt: null, issues: {} };
}

/**
 * Load a sync-state snapshot. A missing file is simply "nothing synced yet"
 * — {@link emptyState} — not an error.
 * @param {string} file
 * @returns {object}
 * @throws {RoadmapSyncError} On an unreadable or malformed existing file.
 */
function loadSyncState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw new RoadmapSyncError(`could not read sync state ${file} (${err.code || 'error'})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RoadmapSyncError(`sync state ${file} is not valid JSON`);
  }
  _need(parsed !== null && typeof parsed === 'object' && parsed.schema === SCHEMA, `sync state ${file} must have schema ${SCHEMA}`);
  _need(parsed.issues !== null && typeof parsed.issues === 'object' && !Array.isArray(parsed.issues), `sync state ${file}.issues must be an object`);
  return parsed;
}

/**
 * Persist a sync-state snapshot atomically.
 * @param {string} file
 * @param {object} state
 * @returns {void}
 */
function saveSyncState(file, state) {
  _need(state !== null && typeof state === 'object' && state.schema === SCHEMA, `state.schema must be ${SCHEMA}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  stagedWrite.writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`, '.roadmap-sync.');
}

/**
 * Whether all of a previously-seen issue's linked PRs are final (merged or
 * closed) — #2259's "a closed issue's linked pull requests are final once
 * all of them are merged or closed, so they need no re-read" (flagged there
 * as not yet proven against a real run).
 * @param {{linkedPrs: ({state:string}[]|undefined)}} issueRecord
 * @returns {boolean}
 */
function _allLinkedPrsSettled(issueRecord) {
  const prs = issueRecord.linkedPrs || [];
  return prs.every((pr) => pr.state === 'merged' || pr.state === 'closed');
}

/**
 * Decide, from the last snapshot and a fresh live summary of each roadmap
 * issue, which ones actually need re-reading — "ask GitHub only about what
 * changed."
 *
 * @param {object} prevState - From {@link loadSyncState}.
 * @param {Array<{id: string, updatedAt: string, closed: boolean, linkedPrIds: (string[]|undefined)}>} liveSummaries -
 *   One entry per roadmap issue, read cheaply (a single list call, not a
 *   per-issue fetch) by the caller.
 * @returns {{changedIssueIds: string[], newlyLinkedPrIssueIds: string[], skippableClosedIssueIds: string[]}}
 */
function computeChangedSince(prevState, liveSummaries) {
  _need(Array.isArray(liveSummaries), 'liveSummaries must be an array');
  const prevIssues = (prevState && prevState.issues) || {};

  const changedIssueIds = [];
  const newlyLinkedPrIssueIds = [];

  for (const live of liveSummaries) {
    const prev = prevIssues[live.id];
    if (!prev) {
      changedIssueIds.push(live.id);
      continue;
    }
    if (prev.updatedAt !== live.updatedAt) {
      changedIssueIds.push(live.id);
      continue;
    }
    const prevLinked = new Set(prev.linkedPrIds || []);
    const newLinks = (live.linkedPrIds || []).filter((id) => !prevLinked.has(id));
    if (newLinks.length > 0) newlyLinkedPrIssueIds.push(live.id);
  }

  const skippableClosedIssueIds = Object.keys(prevIssues).filter((id) => {
    const prev = prevIssues[id];
    return prev.closed === true && _allLinkedPrsSettled(prev);
  });

  return { changedIssueIds, newlyLinkedPrIssueIds, skippableClosedIssueIds };
}

/**
 * Whether a full re-read is due, covering whatever the incremental diff
 * above misses.
 * @param {object} prevState
 * @param {number} now - Epoch ms.
 * @param {number} [intervalMs] - Overrides {@link DEFAULT_FULL_RESYNC_INTERVAL_MS}.
 * @returns {boolean}
 */
function needsFullResync(prevState, now, intervalMs = DEFAULT_FULL_RESYNC_INTERVAL_MS) {
  if (!prevState || typeof prevState.lastFullResyncAt !== 'number') return true;
  return now - prevState.lastFullResyncAt >= intervalMs;
}

/**
 * Whether the rendered roadmap should be published to `gh-pages` — the
 * one-line fix for "Some carry no roadmap change: commit `8ab64aaa0` changed
 * only `roadmap-sync-status.json`." Publishing is decided purely on the
 * roadmap's own rendered content; `prevStatus`/`nextStatus` are accepted for
 * call-site symmetry with the status payload but are deliberately never
 * inspected — a status-only flip (e.g. "Refresh failed" → "ok") must never
 * publish on its own, and this signature makes that an explicit contract
 * rather than an accident of what the function happens to read.
 *
 * @param {string} prevRoadmapHtml
 * @param {string} nextRoadmapHtml
 * @param {*} prevStatus - Unused; see above.
 * @param {*} nextStatus - Unused; see above.
 * @returns {boolean}
 */
function shouldPublishRoadmap(prevRoadmapHtml, nextRoadmapHtml, prevStatus, nextStatus) { // eslint-disable-line no-unused-vars
  _need(typeof prevRoadmapHtml === 'string' && typeof nextRoadmapHtml === 'string', 'prevRoadmapHtml and nextRoadmapHtml must be strings');
  return prevRoadmapHtml !== nextRoadmapHtml;
}

/**
 * Build the per-run status/telemetry payload #2259 asks to record "in its
 * status file or log, so a regression is visible without a manual
 * measurement."
 * @param {object} o
 * @param {number} o.rateLimitUsedDelta - GraphQL points spent this run.
 * @param {number} o.queriesExecuted
 * @param {number} o.changedIssuesCount
 * @param {boolean} o.published
 * @param {boolean} [o.ranFullResync]
 * @param {boolean} [o.ok] - Default true.
 * @param {string} [o.reason] - Failure reason when `ok` is false.
 * @param {number} [o.now] - Epoch ms; `Date.now()` when omitted.
 * @returns {object}
 */
function buildStatusPayload({ rateLimitUsedDelta, queriesExecuted, changedIssuesCount, published, ranFullResync = false, ok = true, reason = null, now = Date.now() }) {
  _need(Number.isFinite(rateLimitUsedDelta) && rateLimitUsedDelta >= 0, 'rateLimitUsedDelta must be a non-negative number');
  _need(Number.isInteger(queriesExecuted) && queriesExecuted >= 0, 'queriesExecuted must be a non-negative integer');
  _need(Number.isInteger(changedIssuesCount) && changedIssuesCount >= 0, 'changedIssuesCount must be a non-negative integer');
  return {
    schema: STATUS_SCHEMA,
    status: ok ? 'ok' : 'failed',
    reason: ok ? null : (reason || 'unknown'),
    updatedAt: new Date(now).toISOString(),
    published: !!published,
    ranFullResync: !!ranFullResync,
    telemetry: { rateLimitUsedDelta, queriesExecuted, changedIssuesCount }
  };
}

/**
 * Whether a failed `gh` call is "this number does not exist" rather than
 * "gh could not look at all" — same distinction `lib/gh-issue-state.js` makes.
 * @param {{stderr:string}} r
 * @returns {boolean}
 */
function _isNotFound(r) {
  if (didNotRun(r)) return false;
  return NOT_FOUND_RE.test(r.stderr || '');
}

/**
 * Parse one line of the issues-list `--jq` output below into `{number,
 * updatedAt, closed, isPullRequest}`, or `null` for a line that is not a
 * JSON object this reader understands.
 * @param {string} line
 * @returns {{number:number, updatedAt:(string|null), closed:boolean, isPullRequest:boolean}|null}
 */
function _parseListLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj.number !== 'number') return null;
  return { number: obj.number, updatedAt: obj.updatedAt || null, closed: obj.state === 'closed', isPullRequest: !!obj.pull_request };
}

/**
 * Read every wanted issue's `updatedAt`/`closed` summary with ONE paginated
 * list call (per #2259 Finding 3: a per-issue loop made ~390 calls before
 * diffing anything). `GET /repos/{owner}/{repo}/issues` returns both issues
 * and pull requests, filtered out here; passing `since` (ISO 8601) narrows
 * the list to items updated after that timestamp — GitHub's own documented
 * "updated-since" filter — so an incremental run reads only what changed
 * rather than the whole roadmap.
 *
 * In `since` mode, an issue GitHub does not return is, by that filter's own
 * definition, unchanged since `since` — it is simply omitted from
 * `summaries`, never guessed at with a placeholder. Without `since` (a full
 * resync), every wanted number is expected to appear; one that does not is
 * reported with `updatedAt: null, closed: false`, same as a 404 previously
 * read for that single number.
 *
 * @param {string} cwd - A checkout of the repository.
 * @param {Array<number|string>} numbers
 * @param {object} [opts]
 * @param {string} [opts.since] - ISO 8601 timestamp; omit for a full read.
 * @returns {Promise<{available:true, summaries: Array<{id:string, updatedAt:(string|null), closed:boolean}>} | {available:false, reason:string}>}
 */
async function fetchIssueSummaries(cwd, numbers, opts = {}) {
  const wanted = [...new Set((Array.isArray(numbers) ? numbers : [])
    .map((n) => Number(n))
    .filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (wanted.length === 0) return { available: true, summaries: [] };

  // `gh api` defaults to GET, UNLESS any -f/-F field is supplied, in which case its own
  // default silently switches to POST (`gh api --help`) — this list call supplies `state`
  // and `per_page` as -f fields, so --method GET must be explicit or the read becomes a write.
  const args = ['api', 'repos/{owner}/{repo}/issues', '--method', 'GET', '--paginate', '-f', 'state=all', '-f', 'per_page=100'];
  if (typeof opts.since === 'string' && opts.since.length > 0) args.push('-f', `since=${opts.since}`);
  args.push('--jq', '.[] | {number: .number, updatedAt: .updated_at, state: .state, pull_request: (.pull_request != null)}');

  const r = await _internal.exec('gh', args, { cwd });
  if (r.exitCode !== 0) {
    log.warn('roadmap issue list could not be read — callers are told unavailable, not a guess', { cwd, reason: describeFailure(r, 'gh api') });
    return { available: false, reason: describeFailure(r, 'gh api') };
  }

  const byNumber = new Map();
  for (const line of r.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = _parseListLine(trimmed);
    if (!parsed || parsed.isPullRequest) continue;
    byNumber.set(parsed.number, parsed);
  }

  const sinceMode = typeof opts.since === 'string' && opts.since.length > 0;
  const summaries = [];
  for (const n of wanted) {
    const hit = byNumber.get(n);
    if (hit) summaries.push({ id: String(n), updatedAt: hit.updatedAt, closed: hit.closed });
    else if (!sinceMode) summaries.push({ id: String(n), updatedAt: null, closed: false });
    // sinceMode + no hit: unchanged since `since`, by the filter's own definition — omit, never guess.
  }
  return { available: true, summaries };
}

/**
 * Read one issue's linked PR numbers from its timeline's `cross-referenced`
 * events. **Unverified mechanism** — see this module's doc comment: #2259
 * names this exact approach as "not tested" against a real sync run.
 * @param {string} cwd
 * @param {number} number
 * @returns {Promise<{id:string, linkedPrIds:string[]}|{failed:string}>}
 */
async function _readOneLinkedPrIds(cwd, number) {
  const r = await _internal.exec('gh', [
    'api', `repos/{owner}/{repo}/issues/${number}/timeline`,
    '--jq', '[.[] | select(.event == "cross-referenced" and .source.issue.pull_request != null) | .source.issue.number]'
  ], { cwd });
  if (r.exitCode !== 0) {
    if (_isNotFound(r)) return { id: String(number), linkedPrIds: [] };
    return { failed: describeFailure(r, 'gh api') };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { failed: `gh answered issue #${number}'s timeline with output this reader could not parse as JSON` };
  }
  return { id: String(number), linkedPrIds: (Array.isArray(parsed) ? parsed : []).map(String) };
}

/**
 * Read several issues' linked PR ids in one batch. Same honesty rule as
 * {@link fetchIssueSummaries}; same unverified-mechanism caveat as
 * {@link _readOneLinkedPrIds}.
 * @param {string} cwd
 * @param {Array<number|string>} numbers
 * @returns {Promise<{available:true, linkedPrIds: Object<string,string[]>} | {available:false, reason:string}>}
 */
async function fetchLinkedPrIds(cwd, numbers) {
  const wanted = [...new Set((Array.isArray(numbers) ? numbers : [])
    .map((n) => Number(n))
    .filter((n) => Number.isSafeInteger(n) && n > 0))];

  const linkedPrIds = {};
  for (let i = 0; i < wanted.length; i += CONCURRENCY) {
    const batch = wanted.slice(i, i + CONCURRENCY);
    const answers = await Promise.all(batch.map((n) => _readOneLinkedPrIds(cwd, n)));
    for (const answer of answers) {
      if (answer.failed) {
        log.warn('roadmap linked-PR ids could not be read — callers are told unavailable, not a guess', { cwd, reason: answer.failed });
        return { available: false, reason: answer.failed };
      }
      linkedPrIds[answer.id] = answer.linkedPrIds;
    }
  }
  return { available: true, linkedPrIds };
}

module.exports = {
  RoadmapSyncError,
  SCHEMA,
  STATUS_SCHEMA,
  DEFAULT_FULL_RESYNC_INTERVAL_MS,
  emptyState,
  loadSyncState,
  saveSyncState,
  computeChangedSince,
  needsFullResync,
  shouldPublishRoadmap,
  buildStatusPayload,
  fetchIssueSummaries,
  fetchLinkedPrIds,
  _internal
};
