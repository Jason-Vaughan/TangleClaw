'use strict';

/**
 * The local copy of the project scorecard that served plan pages read (#1949).
 *
 * There is one scorecard document, `tc.scorecard/v1`, with a `development`
 * section (delivery and intake figures, open backlog, the day-by-day record)
 * and a `certification` section (release-candidate certification, which the
 * certification work validates with its own schema). A producer computes every figure, including
 * each trend and net change, and replaces this file atomically. A page request
 * only reads it: it never computes a figure and never reaches the network, so
 * a slow or unreachable GitHub cannot slow a page, and a number on a page is
 * always one the producer stated.
 *
 * `openBacklog.staleOver90Days` is the part of the open backlog with no update
 * in 90 or more days: tracked so it stays visible, not a figure to act on.
 *
 * The schema is closed at every level of the parts this module owns. A field
 * the producer adds later is refused here until someone adds it on purpose,
 * so the cache can only ever carry what the renderer was built to show.
 *
 * Times are epoch milliseconds in UTC, as in the rest of the scorecard; dates
 * are Pacific calendar days (`YYYY-MM-DD`), because "today" and each window are
 * defined in `America/Los_Angeles`.
 *
 * @module lib/scorecard-cache
 */

const fs = require('node:fs');
const path = require('node:path');
const stagedWrite = require('./staged-write');

/** Schema tag of the scorecard document. */
const SCHEMA = 'tc.scorecard/v1';

/** The one time zone the development section is defined in. */
const TIME_ZONE = 'America/Los_Angeles';

/** File name of the cache, under `<base>/scorecard/`. */
const CACHE_DIR = 'scorecard';
const CACHE_FILE = 'v1.json';

/** Prefix of the cache's staging files, for the atomic write and its sweep. */
const STAGING_PREFIX = '.v1.json.';

/** The file is small by construction; anything larger is not a scorecard. */
const MAX_BYTES = 256 * 1024;

/**
 * The latest instant a JavaScript Date can hold. A safe integer beyond it is
 * still a number, but `new Date(ms).toISOString()` throws on it, so the page
 * that formats the time would fail.
 */
const MAX_EPOCH_MS = 8.64e15;

/** Upper bounds, so one document cannot make a page arbitrarily large. */
const LIMITS = Object.freeze({ count: 1000000, days: 31, label: 60 });

/** Trend words a producer may state. `no-baseline` goes with a null baseline. */
const TRENDS = Object.freeze(['up', 'down', 'flat', 'no-baseline']);

/** Delivery measures, in display order. */
const DELIVERY_KEYS = Object.freeze(['issuesClosed', 'prsMerged', 'carsCompleted', 'trainsCompleted']);

/** Intake (discovery) measures, in display order. */
const INTAKE_KEYS = Object.freeze(['issuesOpened']);

/** What reading the cache found. Only `ok` and `stale` carry a document. */
const STATUS = Object.freeze({
  OK: 'ok',
  STALE: 'stale',
  MISSING: 'missing',
  UNREADABLE: 'unreadable',
  INVALID: 'invalid'
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Labels are plain words: letters, digits, punctuation and spaces only. */
const LABEL_RE = /^[\p{L}\p{N}\p{P} ]+$/u;

/**
 * Error for a document that does not match the schema. Its message names the
 * field and never echoes the value, because it is shown on a page.
 */
class ScorecardError extends Error {}

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond - The check.
 * @param {string} msg - Reader-facing reason.
 * @returns {void}
 */
function _need(cond, msg) {
  if (!cond) throw new ScorecardError(msg);
}

/**
 * Require a plain object carrying exactly the given keys.
 * @param {*} obj - Candidate.
 * @param {string} where - Its path, for the reason.
 * @param {string[]} required - Keys it must have.
 * @param {string[]} [optional] - Keys it may have.
 * @returns {void}
 */
function _needShape(obj, where, required, optional = []) {
  _need(obj !== null && typeof obj === 'object' && !Array.isArray(obj), `${where} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) _need(allowed.has(key), `${where} has unknown key "${key.slice(0, 40)}"`);
  for (const key of required) _need(obj[key] !== undefined, `${where}.${key} is missing`);
}

/**
 * Require a non-negative integer count.
 * @param {*} n - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needCount(n, where) {
  _need(Number.isInteger(n) && n >= 0 && n <= LIMITS.count, `${where} must be a whole number from 0 to ${LIMITS.count}`);
}

/**
 * Require a signed integer change.
 * @param {*} n - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needNet(n, where) {
  _need(Number.isInteger(n) && Math.abs(n) <= LIMITS.count, `${where} must be a whole number within ±${LIMITS.count}`);
}

/**
 * Require a real calendar date written `YYYY-MM-DD`.
 * @param {*} d - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needDate(d, where) {
  _need(typeof d === 'string' && DATE_RE.test(d), `${where} must be a date written YYYY-MM-DD`);
  const t = Date.parse(`${d}T00:00:00Z`);
  _need(!Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d, `${where} is not a real calendar date`);
}

/**
 * Require a short display label.
 * @param {*} s - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needLabel(s, where) {
  _need(typeof s === 'string' && s.trim().length > 0 && s.length <= LIMITS.label && LABEL_RE.test(s),
    `${where} must be 1–${LIMITS.label} letters, digits, punctuation or spaces`);
}

/**
 * Require a trend word, consistent with whether a baseline exists.
 * @param {*} trend - Candidate.
 * @param {*} baseline - The baseline figure it compares against, or null.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needTrend(trend, baseline, where) {
  _need(TRENDS.includes(trend), `${where}.trend must be one of ${TRENDS.join(', ')}`);
  _need((baseline === null) === (trend === 'no-baseline'), `${where}.trend is "no-baseline" exactly when the baseline is null`);
}

/**
 * Validate a comparison window.
 * @param {*} w - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needWindow(w, where) {
  _needShape(w, where, ['label', 'start', 'end']);
  _needLabel(w.label, `${where}.label`);
  _needDate(w.start, `${where}.start`);
  _needDate(w.end, `${where}.end`);
  _need(w.start <= w.end, `${where} starts after it ends`);
}

/**
 * Validate one measure compared across the two windows.
 * @param {*} m - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needMeasure(m, where) {
  _needShape(m, where, ['current', 'baseline', 'trend']);
  _needCount(m.current, `${where}.current`);
  if (m.baseline !== null) _needCount(m.baseline, `${where}.baseline`);
  _needTrend(m.trend, m.baseline, where);
}

/**
 * Validate a group of measures (delivery or intake) with exactly its keys.
 * @param {*} group - Candidate.
 * @param {string} where - Its path.
 * @param {readonly string[]} keys - The group's measures.
 * @param {(v: *, where: string) => void} check - Validator for one measure.
 * @returns {void}
 */
function _needGroup(group, where, keys, check) {
  _needShape(group, where, [...keys]);
  for (const key of keys) check(group[key], `${where}.${key}`);
}

/**
 * Validate one Pacific day's record.
 * @param {*} day - Candidate.
 * @param {string} where - Its path.
 * @returns {void}
 */
function _needDay(day, where) {
  _needShape(day, where, ['date', 'delivery', 'intake', 'openBacklogNet']);
  _needDate(day.date, `${where}.date`);
  _needGroup(day.delivery, `${where}.delivery`, DELIVERY_KEYS, _needCount);
  _needGroup(day.intake, `${where}.intake`, INTAKE_KEYS, _needCount);
  _needNet(day.openBacklogNet, `${where}.openBacklogNet`);
}

/**
 * Validate the development section: the figures the progress cards show.
 * Checks shape and ranges only. It never recomputes a trend or a net: those
 * are the producer's statements, and the renderer shows them as stated.
 * @param {*} dev - Candidate section.
 * @returns {void}
 * @throws {ScorecardError}
 */
function validateDevelopment(dev) {
  const where = 'development';
  _needShape(dev, where, ['timeZone', 'windows', 'openBacklog', 'delivery', 'intake', 'today', 'days']);
  _need(dev.timeZone === TIME_ZONE, `${where}.timeZone must be ${TIME_ZONE}`);

  _needShape(dev.windows, `${where}.windows`, ['current', 'baseline']);
  _needWindow(dev.windows.current, `${where}.windows.current`);
  _needWindow(dev.windows.baseline, `${where}.windows.baseline`);
  _need(dev.windows.baseline.end < dev.windows.current.start, `${where}.windows.baseline must end before the current window starts`);

  const ob = dev.openBacklog;
  _needShape(ob, `${where}.openBacklog`, ['count', 'staleOver90Days', 'net', 'baselineNet', 'trend']);
  _needCount(ob.count, `${where}.openBacklog.count`);
  _needCount(ob.staleOver90Days, `${where}.openBacklog.staleOver90Days`);
  _need(ob.staleOver90Days <= ob.count, `${where}.openBacklog.staleOver90Days cannot exceed the open count`);
  _needNet(ob.net, `${where}.openBacklog.net`);
  if (ob.baselineNet !== null) _needNet(ob.baselineNet, `${where}.openBacklog.baselineNet`);
  _needTrend(ob.trend, ob.baselineNet, `${where}.openBacklog`);

  _needGroup(dev.delivery, `${where}.delivery`, DELIVERY_KEYS, _needMeasure);
  _needGroup(dev.intake, `${where}.intake`, INTAKE_KEYS, _needMeasure);

  _needDay(dev.today, `${where}.today`);

  _need(Array.isArray(dev.days) && dev.days.length >= 1 && dev.days.length <= LIMITS.days,
    `${where}.days must list 1–${LIMITS.days} days`);
  dev.days.forEach((d, i) => _needDay(d, `${where}.days[${i}]`));
  for (let i = 1; i < dev.days.length; i += 1) {
    _need(dev.days[i].date < dev.days[i - 1].date, `${where}.days must be newest first, one entry per date`);
  }
  // `today` is the summary line's copy of the newest day; the drawer shows
  // `days[0]`. They must be the same record, or one card shows two answers.
  _need(JSON.stringify(_dayKey(dev.today)) === JSON.stringify(_dayKey(dev.days[0])),
    `${where}.today must be the same record as ${where}.days[0]`);
}

/**
 * A day's record with its fields in a fixed order, for comparison.
 * @param {object} day - A validated day.
 * @returns {Array}
 */
function _dayKey(day) {
  return [day.date, ...DELIVERY_KEYS.map((k) => day.delivery[k]), ...INTAKE_KEYS.map((k) => day.intake[k]), day.openBacklogNet];
}

/**
 * Whether a value is an instant a Date can represent: a positive integer no
 * later than `MAX_EPOCH_MS`.
 * @param {*} ms - Candidate.
 * @returns {boolean}
 */
function _isEpochMs(ms) {
  return Number.isInteger(ms) && ms > 0 && ms <= MAX_EPOCH_MS;
}

/**
 * Validate a whole scorecard document. The `certification` section, when
 * present, must be an object; its contents are judged by the certification
 * work's own validator, not here.
 * @param {*} doc - Candidate document.
 * @returns {void}
 * @throws {ScorecardError}
 */
function validateScorecard(doc) {
  _needShape(doc, 'scorecard', ['schema', 'generatedAt', 'freshUntil', 'development'], ['certification']);
  _need(doc.schema === SCHEMA, `scorecard.schema must be ${SCHEMA}`);
  _need(_isEpochMs(doc.generatedAt), 'scorecard.generatedAt must be epoch milliseconds');
  _need(_isEpochMs(doc.freshUntil) && doc.freshUntil > doc.generatedAt, 'scorecard.freshUntil must be epoch milliseconds after generatedAt');
  if (doc.certification !== undefined) {
    _need(doc.certification !== null && typeof doc.certification === 'object' && !Array.isArray(doc.certification),
      'scorecard.certification must be an object');
  }
  validateDevelopment(doc.development);
}

/**
 * Where the cache lives under a TangleClaw base directory.
 * @param {string} baseDir - The base directory (the store's base path).
 * @returns {string}
 */
function cachePath(baseDir) {
  return path.join(baseDir, CACHE_DIR, CACHE_FILE);
}

/**
 * Read the cache and say what was found. Never throws for anything the file
 * holds: a page must render whatever state the cache is in.
 *
 * A document past its `freshUntil` is returned as `stale`, figures included,
 * so the page can show them marked as out of date rather than show nothing.
 * @param {string} file - Cache file path.
 * @param {object} [opts] - Options.
 * @param {number} [opts.now] - Current time in epoch ms; `Date.now()` when omitted.
 * @returns {{status: string, doc?: object, reason?: string}}
 */
function readScorecardCache(file, { now = Date.now() } = {}) {
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { status: STATUS.UNREADABLE, reason: 'the scorecard cache is not a regular file' };
    if (st.size > MAX_BYTES) return { status: STATUS.INVALID, reason: `the scorecard cache is larger than ${MAX_BYTES} bytes` };
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: STATUS.MISSING, reason: 'no scorecard has been published to this host yet' };
    return { status: STATUS.UNREADABLE, reason: `the scorecard cache could not be read (${err.code || 'error'})` };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { status: STATUS.INVALID, reason: 'the scorecard cache is not valid JSON' };
  }
  try {
    validateScorecard(doc);
  } catch (err) {
    if (!(err instanceof ScorecardError)) throw err;
    return { status: STATUS.INVALID, reason: err.message };
  }
  if (now > doc.freshUntil) return { status: STATUS.STALE, doc, reason: 'the scorecard is past its refresh deadline' };
  return { status: STATUS.OK, doc };
}

/**
 * Replace the cache with a new document, atomically: a reader sees either the
 * previous file or the complete new one. The document is validated first, so
 * nothing the renderer would refuse ever reaches the cache.
 * @param {string} file - Cache file path.
 * @param {object} doc - The scorecard document.
 * @returns {void}
 * @throws {ScorecardError} When the document does not match the schema.
 */
function writeScorecardCache(file, doc) {
  validateScorecard(doc);
  const body = JSON.stringify(doc, null, 2) + '\n';
  if (Buffer.byteLength(body) > MAX_BYTES) throw new ScorecardError(`scorecard is larger than ${MAX_BYTES} bytes`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  stagedWrite.writeAtomic(file, body, STAGING_PREFIX);
}

module.exports = {
  SCHEMA,
  TIME_ZONE,
  TRENDS,
  DELIVERY_KEYS,
  INTAKE_KEYS,
  STATUS,
  LIMITS,
  MAX_BYTES,
  MAX_EPOCH_MS,
  ScorecardError,
  validateDevelopment,
  validateScorecard,
  cachePath,
  readScorecardCache,
  writeScorecardCache
};
