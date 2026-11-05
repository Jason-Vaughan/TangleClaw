'use strict';

/**
 * The producer for the local project scorecard, `<base>/scorecard/v1.json`
 * (#2144, part of #1949's Train 30 umbrella).
 *
 * `lib/scorecard-cache.js` owns the cache file and its validator; its own
 * doc comment says "a producer computes every figure, including each trend
 * and net change, and replaces this file atomically." Nothing did that
 * before this module — on every install both scorecard cards said no
 * scorecard had been published, and the operator's visual check (VRF-1949-
 * C03) had no real figures to look at outside a hand-placed fixture.
 *
 * This module is two layers: pure figure computation (trend/net derivation,
 * day-record and document assembly — fully deterministic, fully tested),
 * and a thin GitHub-reading layer behind an `_internal.exec` seam, mirroring
 * `lib/roadmap-sync.js`'s pattern. `scripts/scorecard-produce.js` is the CLI
 * entry point that calls {@link produceScorecardDocument} and writes the
 * result through `writeScorecardCache`.
 *
 * #2144's own body leaves two questions explicitly undecided: "who runs the
 * producer and how often" and "where the figures come from." This module
 * answers the second one as far as it reasonably can and documents the
 * rest as open:
 *
 * - `issuesClosed`, `issuesOpened`, `prsMerged`, and the open-backlog figures
 *   are read from the GitHub Search API (`gh api search/issues`), one of
 *   the two sources the issue names. Search's `created:`/`closed:`/
 *   `merged:`/`updated:` date qualifiers are **UTC-day** boundaries; this
 *   module buckets by the project's Pacific calendar day, so a day's figures
 *   can be off by the few hours of boundary skew between the two zones.
 *   Documented here and in `docs/runbooks/release-certification.md`, not
 *   silently hidden.
 * - `trainsCompleted` is read from closed GitHub Milestones, this repo's
 *   existing train/release convention (ADR 0024) — bucketed by the Pacific
 *   calendar day each milestone's `closed_at` falls on.
 * - `carsCompleted` has **no canonical GitHub-queryable source**: a "car" is
 *   a `LANE_QUEUE.md` lane-assignment grouping, never a first-class GitHub
 *   object. This module always produces `0` for it, labeled so in the
 *   runbook, rather than invent a heuristic the issue itself never asked
 *   for. A future car can wire a real source once one is decided.
 * - Scheduling ("how often") is left to the caller/operator; the runbook
 *   documents running it manually and sketches a periodic option.
 *
 * The optional `certification` section is NOT populated by this module —
 * #2144 is scoped to the local development-figures cache; wiring the
 * published certification summary (`lib/release-certification/scorecard.js
 * #certificationSummary`) into this cache is a Slice 2 follow-on, same
 * boundary the Architect ruling drew for the roadmap admission/sync car
 * this session. {@link produceScorecardDocument} accepts an optional
 * pre-built `certification` summary and passes it through unvalidated
 * (`writeScorecardCache` validates); it never fetches one itself.
 *
 * @module lib/scorecard-producer
 */

const { execFileArgs, describeFailure, didNotRun } = require('./exec');
const scorecardCache = require('./scorecard-cache');
const { createLogger } = require('./logger');

const log = createLogger('scorecard-producer');

/** Error for producer input that does not match this module's contract. */
class ScorecardProducerError extends Error {}

function _need(cond, msg) {
  if (!cond) throw new ScorecardProducerError(msg);
}

/** Default comparison window length, matching the shipped fixture's "Last 7 days" / "Preceding 7 days" labels. */
const DEFAULT_WINDOW_DAYS = 7;

/** How long a produced document stays fresh, matching the shipped fixture's 6-hour gap between `generatedAt` and `freshUntil`. */
const DEFAULT_FRESH_FOR_MS = 6 * 60 * 60 * 1000;

/** How old (in days) an open issue must be, by its own last update, to count as part of the stale backlog. */
const STALE_BACKLOG_DAYS = 90;

const EXEC_TIMEOUT_MS = 15000;
const MAX_BUFFER_BYTES = 1024 * 1024;
/** Parallel `gh` calls per batch of per-day searches — same bound `lib/gh-issue-state.js`/`lib/roadmap-sync.js` use. */
const CONCURRENCY = 4;

function defaultExec(file, args, options) {
  return execFileArgs(file, args, { cwd: options && options.cwd, timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: MAX_BUFFER_BYTES });
}

const _internal = { exec: defaultExec };

// ── Pacific calendar-day helpers ──

/**
 * The Pacific calendar date of an instant, as `YYYY-MM-DD`.
 * @param {number} ms - Epoch milliseconds.
 * @returns {string}
 */
function pacificDateString(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: scorecardCache.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

/**
 * A calendar date, shifted by whole days. Pure calendar-date arithmetic —
 * once a date is a `YYYY-MM-DD` string, shifting it by days needs no time
 * zone, only `Date`'s own UTC calendar math as a convenient implementation.
 * @param {string} dateStr - `YYYY-MM-DD`.
 * @param {number} deltaDays - May be negative.
 * @returns {string}
 */
function shiftDateString(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Every calendar date in `[start, end]` inclusive, oldest first.
 * @param {string} start
 * @param {string} end
 * @returns {string[]}
 */
function dateRange(start, end) {
  const dates = [];
  let cur = start;
  while (cur <= end) {
    dates.push(cur);
    cur = shiftDateString(cur, 1);
  }
  return dates;
}

/**
 * The current and baseline comparison windows ending today (Pacific).
 * @param {number} nowMs - Epoch milliseconds.
 * @param {object} [opts]
 * @param {number} [opts.windowDays] - Overrides {@link DEFAULT_WINDOW_DAYS}.
 * @returns {{current: {label:string,start:string,end:string}, baseline: {label:string,start:string,end:string}}}
 */
function computeWindows(nowMs, { windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  _need(Number.isInteger(windowDays) && windowDays >= 1, 'windowDays must be a positive integer');
  const currentEnd = pacificDateString(nowMs);
  const currentStart = shiftDateString(currentEnd, -(windowDays - 1));
  const baselineEnd = shiftDateString(currentStart, -1);
  const baselineStart = shiftDateString(baselineEnd, -(windowDays - 1));
  return {
    current: { label: `Last ${windowDays} days`, start: currentStart, end: currentEnd },
    baseline: { label: `Preceding ${windowDays} days`, start: baselineStart, end: baselineEnd }
  };
}

// ── Pure figure computation ──

/**
 * The trend word for a current/baseline comparison.
 * @param {number} current
 * @param {number|null} baseline
 * @returns {string} One of {@link scorecardCache.TRENDS}.
 */
function computeTrend(current, baseline) {
  if (baseline === null) return 'no-baseline';
  if (current > baseline) return 'up';
  if (current < baseline) return 'down';
  return 'flat';
}

/**
 * Build one `{current, baseline, trend}` measure.
 * @param {number} current
 * @param {number|null} baseline
 * @returns {{current:number, baseline:(number|null), trend:string}}
 */
function buildMeasure(current, baseline) {
  return { current, baseline, trend: computeTrend(current, baseline) };
}

/**
 * Build the `openBacklog` figure.
 * @param {object} o
 * @param {number} o.count
 * @param {number} o.staleOver90Days
 * @param {number} o.net
 * @param {number|null} o.baselineNet
 * @returns {object}
 */
function buildOpenBacklog({ count, staleOver90Days, net, baselineNet }) {
  return { count, staleOver90Days, net, baselineNet, trend: computeTrend(net, baselineNet) };
}

/**
 * Build the `development` section from already-gathered raw counts.
 * @param {object} o
 * @param {{current:object, baseline:object}} o.windows
 * @param {object} o.openBacklog - Raw `{count, staleOver90Days, net, baselineNet}`.
 * @param {Object<string, {current:number, baseline:(number|null)}>} o.delivery - Keyed by `scorecardCache.DELIVERY_KEYS`.
 * @param {Object<string, {current:number, baseline:(number|null)}>} o.intake - Keyed by `scorecardCache.INTAKE_KEYS`.
 * @param {Array<{date:string, delivery:Object<string,number>, intake:Object<string,number>, openBacklogNet:number}>} o.days - Newest first.
 * @returns {object} A `development` section, ready for `scorecardCache.validateDevelopment`.
 */
function buildDevelopmentSection({ windows, openBacklog, delivery, intake, days }) {
  _need(Array.isArray(days) && days.length >= 1, 'days must be a non-empty array');
  const developedDelivery = {};
  for (const key of scorecardCache.DELIVERY_KEYS) {
    _need(delivery && delivery[key] !== undefined, `delivery.${key} is missing`);
    developedDelivery[key] = buildMeasure(delivery[key].current, delivery[key].baseline);
  }
  const developedIntake = {};
  for (const key of scorecardCache.INTAKE_KEYS) {
    _need(intake && intake[key] !== undefined, `intake.${key} is missing`);
    developedIntake[key] = buildMeasure(intake[key].current, intake[key].baseline);
  }
  return {
    timeZone: scorecardCache.TIME_ZONE,
    windows: { current: { ...windows.current }, baseline: { ...windows.baseline } },
    openBacklog: buildOpenBacklog(openBacklog),
    delivery: developedDelivery,
    intake: developedIntake,
    today: days[0],
    days
  };
}

/**
 * Build the full scorecard document.
 * @param {object} o
 * @param {object} o.development - From {@link buildDevelopmentSection}.
 * @param {object} [o.certification] - A pre-built certification summary; passed through, never fetched here.
 * @param {number} [o.now] - Epoch ms; `Date.now()` when omitted.
 * @param {number} [o.freshForMs] - Overrides {@link DEFAULT_FRESH_FOR_MS}.
 * @returns {object}
 */
function buildScorecardDocument({ development, certification, now = Date.now(), freshForMs = DEFAULT_FRESH_FOR_MS }) {
  const doc = {
    schema: scorecardCache.SCHEMA,
    generatedAt: now,
    freshUntil: now + freshForMs,
    development
  };
  if (certification !== undefined && certification !== null) doc.certification = certification;
  return doc;
}

// ── GitHub reading (search-based; see module doc for the UTC/Pacific boundary caveat) ──

/**
 * This repository's `owner/name`, resolved once so search queries can embed
 * it literally — `gh api`'s `{owner}`/`{repo}` placeholder substitution is
 * documented for the request PATH; this module does not assume it also
 * applies inside a `-f` field value, so it never relies on that there.
 * @param {string} cwd
 * @returns {Promise<{available:true, slug:string}|{available:false, reason:string}>}
 */
async function _resolveRepoSlug(cwd) {
  const r = await _internal.exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
  if (r.exitCode !== 0) return { available: false, reason: describeFailure(r, 'gh repo view') };
  const slug = r.stdout.trim();
  if (!slug.includes('/')) return { available: false, reason: 'gh repo view did not answer with an owner/name slug' };
  return { available: true, slug };
}

/**
 * One GitHub Search API count query.
 * @param {string} cwd
 * @param {string} q - Full search query, repo qualifier included.
 * @returns {Promise<{count:number}|{failed:string}>}
 */
async function _searchCount(cwd, q) {
  const r = await _internal.exec('gh', ['api', 'search/issues', '--method', 'GET', '-f', `q=${q}`, '--jq', '.total_count'], { cwd });
  if (r.exitCode !== 0) {
    if (didNotRun(r)) return { failed: describeFailure(r, 'gh api search/issues') };
    return { failed: describeFailure(r, 'gh api search/issues') };
  }
  const n = Number(r.stdout.trim());
  if (!Number.isInteger(n) || n < 0) return { failed: `gh answered a search query with output this reader could not parse as a count: ${JSON.stringify(r.stdout.slice(0, 80))}` };
  return { count: n };
}

/**
 * Per-day issuesOpened/issuesClosed/prsMerged for each date, plus the
 * window-level totals for `start..end`.
 * @param {string} cwd
 * @param {string} slug - `owner/name`.
 * @param {string[]} dates - Dates to fetch per-day counts for (current window).
 * @param {{start:string, end:string}} baselineRange - For the baseline window's totals.
 * @returns {Promise<{available:true, perDay: Array<{date,issuesOpened,issuesClosed,prsMerged}>, baselineTotals:{issuesOpened:number,issuesClosed:number,prsMerged:number}} | {available:false, reason:string}>}
 */
async function _fetchDeliveryIntakeCounts(cwd, slug, dates, baselineRange) {
  const perDay = [];
  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const batch = dates.slice(i, i + CONCURRENCY);
    const answers = await Promise.all(batch.map(async (date) => {
      const [opened, closed, merged] = await Promise.all([
        _searchCount(cwd, `repo:${slug} is:issue created:${date}`),
        _searchCount(cwd, `repo:${slug} is:issue closed:${date}`),
        _searchCount(cwd, `repo:${slug} is:pr merged:${date}`)
      ]);
      return { date, opened, closed, merged };
    }));
    for (const a of answers) {
      for (const r of [a.opened, a.closed, a.merged]) {
        if (r.failed) {
          log.warn('scorecard per-day search count could not be read', { cwd, date: a.date, reason: r.failed });
          return { available: false, reason: r.failed };
        }
      }
      perDay.push({ date: a.date, issuesOpened: a.opened.count, issuesClosed: a.closed.count, prsMerged: a.merged.count });
    }
  }

  const [baseOpened, baseClosed, baseMerged] = await Promise.all([
    _searchCount(cwd, `repo:${slug} is:issue created:${baselineRange.start}..${baselineRange.end}`),
    _searchCount(cwd, `repo:${slug} is:issue closed:${baselineRange.start}..${baselineRange.end}`),
    _searchCount(cwd, `repo:${slug} is:pr merged:${baselineRange.start}..${baselineRange.end}`)
  ]);
  for (const r of [baseOpened, baseClosed, baseMerged]) {
    if (r.failed) return { available: false, reason: r.failed };
  }
  return {
    available: true,
    perDay,
    baselineTotals: { issuesOpened: baseOpened.count, issuesClosed: baseClosed.count, prsMerged: baseMerged.count }
  };
}

/**
 * The current open-backlog count and its 90-day-stale subset.
 * @param {string} cwd
 * @param {string} slug
 * @param {number} now - Epoch ms, for the stale-day boundary.
 * @returns {Promise<{available:true, count:number, staleOver90Days:number} | {available:false, reason:string}>}
 */
async function _fetchOpenBacklog(cwd, slug, now) {
  const staleBoundary = pacificDateString(now - STALE_BACKLOG_DAYS * 24 * 60 * 60 * 1000);
  const [openCount, staleCount] = await Promise.all([
    _searchCount(cwd, `repo:${slug} is:issue is:open`),
    _searchCount(cwd, `repo:${slug} is:issue is:open updated:<${staleBoundary}`)
  ]);
  if (openCount.failed) return { available: false, reason: openCount.failed };
  if (staleCount.failed) return { available: false, reason: staleCount.failed };
  return { available: true, count: openCount.count, staleOver90Days: staleCount.count };
}

/**
 * Closed-milestone counts ("trains completed"), bucketed by the Pacific
 * calendar day each milestone closed, plus the baseline window's total.
 * @param {string} cwd
 * @returns {Promise<{available:true, byDate: Object<string,number>, baselineTotal:(count:number)} | {available:false, reason:string}>}
 */
async function _fetchTrainsCompleted(cwd, baselineRange) {
  const r = await _internal.exec('gh', [
    'api', 'repos/{owner}/{repo}/milestones', '--method', 'GET', '--paginate',
    '-f', 'state=closed', '-f', 'per_page=100',
    '--jq', '.[] | {closedAt: .closed_at}'
  ], { cwd });
  if (r.exitCode !== 0) {
    return { available: false, reason: describeFailure(r, 'gh api repos/{owner}/{repo}/milestones') };
  }
  const byDate = {};
  let baselineTotal = 0;
  for (const line of r.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed.closedAt) continue;
    const date = pacificDateString(Date.parse(parsed.closedAt));
    byDate[date] = (byDate[date] || 0) + 1;
    if (date >= baselineRange.start && date <= baselineRange.end) baselineTotal += 1;
  }
  return { available: true, byDate, baselineTotal };
}

/**
 * Gather every raw fact {@link buildDevelopmentSection} needs, from GitHub.
 * `carsCompleted` is always `0` — see the module doc comment.
 * @param {string} cwd - A checkout of the repository.
 * @param {object} [opts]
 * @param {number} [opts.now] - Epoch ms; `Date.now()` when omitted.
 * @param {number} [opts.windowDays] - Overrides {@link DEFAULT_WINDOW_DAYS}.
 * @returns {Promise<{available:true, windows:object, openBacklog:object, delivery:object, intake:object, days:Array} | {available:false, reason:string}>}
 */
async function fetchScorecardFacts(cwd, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const windows = computeWindows(now, { windowDays });
  const slugResult = await _resolveRepoSlug(cwd);
  if (!slugResult.available) return { available: false, reason: slugResult.reason };
  const slug = slugResult.slug;

  const dates = dateRange(windows.current.start, windows.current.end).reverse(); // newest first

  const [deliveryResult, backlogResult, trainsResult] = await Promise.all([
    _fetchDeliveryIntakeCounts(cwd, slug, dates, windows.baseline),
    _fetchOpenBacklog(cwd, slug, now),
    _fetchTrainsCompleted(cwd, windows.baseline)
  ]);
  if (!deliveryResult.available) return { available: false, reason: deliveryResult.reason };
  if (!backlogResult.available) return { available: false, reason: backlogResult.reason };
  if (!trainsResult.available) return { available: false, reason: trainsResult.reason };

  const perDayByDate = new Map(deliveryResult.perDay.map((d) => [d.date, d]));
  const days = dates.map((date) => {
    const d = perDayByDate.get(date) || { issuesOpened: 0, issuesClosed: 0, prsMerged: 0 };
    const trainsCompletedToday = trainsResult.byDate[date] || 0;
    return {
      date,
      delivery: { issuesClosed: d.issuesClosed, prsMerged: d.prsMerged, carsCompleted: 0, trainsCompleted: trainsCompletedToday },
      intake: { issuesOpened: d.issuesOpened },
      openBacklogNet: d.issuesOpened - d.issuesClosed
    };
  });

  const currentTotals = days.reduce((acc, d) => ({
    issuesClosed: acc.issuesClosed + d.delivery.issuesClosed,
    prsMerged: acc.prsMerged + d.delivery.prsMerged,
    trainsCompleted: acc.trainsCompleted + d.delivery.trainsCompleted,
    issuesOpened: acc.issuesOpened + d.intake.issuesOpened
  }), { issuesClosed: 0, prsMerged: 0, trainsCompleted: 0, issuesOpened: 0 });
  const netCurrent = currentTotals.issuesOpened - currentTotals.issuesClosed;
  const netBaseline = deliveryResult.baselineTotals.issuesOpened - deliveryResult.baselineTotals.issuesClosed;

  return {
    available: true,
    windows,
    openBacklog: { count: backlogResult.count, staleOver90Days: backlogResult.staleOver90Days, net: netCurrent, baselineNet: netBaseline },
    delivery: {
      issuesClosed: { current: currentTotals.issuesClosed, baseline: deliveryResult.baselineTotals.issuesClosed },
      prsMerged: { current: currentTotals.prsMerged, baseline: deliveryResult.baselineTotals.prsMerged },
      carsCompleted: { current: 0, baseline: 0 },
      trainsCompleted: { current: currentTotals.trainsCompleted, baseline: trainsResult.baselineTotal }
    },
    intake: {
      issuesOpened: { current: currentTotals.issuesOpened, baseline: deliveryResult.baselineTotals.issuesOpened }
    },
    days
  };
}

/**
 * Gather facts from GitHub and produce the full scorecard document, ready
 * for `scorecardCache.writeScorecardCache`.
 * @param {string} cwd - A checkout of the repository.
 * @param {object} [opts]
 * @param {number} [opts.now] - Epoch ms; `Date.now()` when omitted.
 * @param {number} [opts.windowDays] - Overrides {@link DEFAULT_WINDOW_DAYS}.
 * @param {number} [opts.freshForMs] - Overrides {@link DEFAULT_FRESH_FOR_MS}.
 * @param {object} [opts.certification] - A pre-built certification summary; passed through, never fetched.
 * @returns {Promise<{available:true, document:object} | {available:false, reason:string}>}
 */
async function produceScorecardDocument(cwd, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const facts = await fetchScorecardFacts(cwd, { now, windowDays: opts.windowDays });
  if (!facts.available) return { available: false, reason: facts.reason };
  const development = buildDevelopmentSection(facts);
  const document = buildScorecardDocument({ development, certification: opts.certification, now, freshForMs: opts.freshForMs });
  return { available: true, document };
}

module.exports = {
  ScorecardProducerError,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_FRESH_FOR_MS,
  STALE_BACKLOG_DAYS,
  pacificDateString,
  shiftDateString,
  dateRange,
  computeWindows,
  computeTrend,
  buildMeasure,
  buildOpenBacklog,
  buildDevelopmentSection,
  buildScorecardDocument,
  fetchScorecardFacts,
  produceScorecardDocument,
  _internal
};
