'use strict';

/**
 * v6 (#2983, V6-10 / B4, Car V60-T2-W1-B): the Global & Fleet/Project
 * Telemetry Header's data model, and the structural guarantee that hiding
 * it in the UI never disables background collection.
 *
 * {@link assembleTelemetryBar} normalizes a scope's raw metric readings
 * (tokens, the quota window from #2599, context utilization from #1622,
 * active sessions, health, pending Medusa messages, version/drift from
 * #2956) into one bar snapshot, each metric carrying an
 * `observed`/`estimated`/`unavailable` confidence badge.
 *
 * {@link createTelemetryVisibility} is the "HIDE means HIDE, never DISABLE"
 * invariant (#2983 deliverable 2) made structural rather than merely
 * documented: it exposes a setter for per-scope bar visibility and
 * per-metric configurability, but no setter anywhere in this module can
 * ever turn collection off — `isCollecting()` is a getter that always
 * returns `true`, full stop. A caller that wants collection genuinely
 * stopped needs a different, explicit mechanism elsewhere; nothing here
 * provides one, by design.
 *
 * This module does NOT read real telemetry — `lib/usage-windows.js` (#2599),
 * `lib/medusa-drift.js` (#2956), and whatever owns #1622 (context
 * utilization) remain the actual collectors. Wiring their output into
 * `assembleTelemetryBar`'s input shape, and rendering the bar in `public/**`,
 * are `BRIDGE-5`'s job (named in #2983 as the required integration bridge),
 * not this car's — this car's envelope is `lib/v6/*.js` plus tests only.
 *
 * Issue #2983 cites canonical prototypes `P16` and `P19` for the bar's
 * visual design — unavailable to this session (no match found in this repo
 * or its shared docs); nothing here depends on their visual layout, only on
 * the issue's own explicit metric list and the HIDE/DISABLE invariant.
 *
 * @module lib/v6/b4-telemetry-header
 */

/** Every metric the bar surfaces, in #2983's own listed order. */
const METRIC_KEYS = Object.freeze([
  'tokens',
  'quotaWindow',
  'contextUtilization',
  'activeSessions',
  'health',
  'pendingMedusaMessages',
  'versionDrift'
]);

/** The three confidence badges a metric reading can carry. */
const CONFIDENCE_LEVELS = Object.freeze(['observed', 'estimated', 'unavailable']);

/** The two scopes this header supports (#2983: "Global and Fleet/Project"). */
const SCOPES = Object.freeze(['global', 'fleet']);

/**
 * Normalize one caller-supplied metric reading. An unreadable/missing/
 * malformed reading degrades to `{value: null, confidence: 'unavailable'}`
 * rather than throwing — a telemetry bar must render something for every
 * metric even when the underlying collector has nothing to say.
 * @param {{value?: *, confidence?: string}} [raw]
 * @returns {{value: *, confidence: string}}
 */
function _normalizeMetric(raw) {
  if (!raw || typeof raw !== 'object' || !CONFIDENCE_LEVELS.includes(raw.confidence)) {
    return { value: null, confidence: 'unavailable' };
  }
  return { value: raw.value === undefined ? null : raw.value, confidence: raw.confidence };
}

/**
 * Assemble one telemetry bar snapshot for a scope (#2983 deliverable 1).
 * @param {string} scope - One of {@link SCOPES}.
 * @param {Record<string, {value?: *, confidence?: string}>} [metrics] -
 *   Keyed by {@link METRIC_KEYS}; a missing or malformed entry normalizes to
 *   `unavailable` rather than being refused, so a caller with partial data
 *   still gets a complete bar.
 * @param {{now?: () => number}} [opts] - `now` is injectable for tests.
 * @returns {{scope: string, generatedAt: string, metrics: Record<string, {value: *, confidence: string}>}}
 * @throws {RangeError} When `scope` is not one of {@link SCOPES}.
 */
function assembleTelemetryBar(scope, metrics = {}, opts = {}) {
  if (!SCOPES.includes(scope)) throw new RangeError(`unknown telemetry scope: ${scope}`);
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const assembled = {};
  for (const key of METRIC_KEYS) {
    assembled[key] = _normalizeMetric(metrics[key]);
  }
  return { scope, generatedAt: new Date(now).toISOString(), metrics: assembled };
}

/**
 * Create a per-scope visibility controller: whether a scope's whole bar is
 * collapsed/hidden, and which of its metrics are individually configured
 * visible (#2983 deliverable 1's "configurable, collapsible").
 *
 * "HIDE means HIDE, never DISABLE" (#2983 deliverable 2): this is the
 * STRUCTURAL form of that guarantee. There is no `setCollecting`,
 * `disable`, or any other export on the returned object that could stop
 * background collection — `isCollecting()` is a bare getter, always `true`.
 * Hiding the bar changes only what a viewer sees.
 * @param {{defaultVisibleMetrics?: string[]}} [opts] - `defaultVisibleMetrics`
 *   defaults to every metric in {@link METRIC_KEYS}.
 * @returns {{
 *   setBarHidden: (scope: string, hidden: boolean) => void,
 *   isBarHidden: (scope: string) => boolean,
 *   setMetricVisible: (scope: string, metricKey: string, visible: boolean) => void,
 *   isMetricVisible: (scope: string, metricKey: string) => boolean,
 *   isCollecting: () => true
 * }}
 */
function createTelemetryVisibility(opts = {}) {
  const defaultVisibleMetrics = Array.isArray(opts.defaultVisibleMetrics) ? opts.defaultVisibleMetrics : METRIC_KEYS;
  const barHidden = new Map();
  const metricVisibility = new Map();

  function metricsFor(scope) {
    if (!metricVisibility.has(scope)) metricVisibility.set(scope, new Set(defaultVisibleMetrics));
    return metricVisibility.get(scope);
  }

  return Object.freeze({
    setBarHidden(scope, hidden) {
      barHidden.set(scope, hidden === true);
    },
    isBarHidden(scope) {
      return barHidden.get(scope) === true;
    },
    setMetricVisible(scope, metricKey, visible) {
      if (!METRIC_KEYS.includes(metricKey)) throw new RangeError(`unknown metric: ${metricKey}`);
      const set = metricsFor(scope);
      if (visible) set.add(metricKey);
      else set.delete(metricKey);
    },
    isMetricVisible(scope, metricKey) {
      return metricsFor(scope).has(metricKey);
    },
    isCollecting() {
      return true;
    }
  });
}

module.exports = {
  METRIC_KEYS,
  CONFIDENCE_LEVELS,
  SCOPES,
  assembleTelemetryBar,
  createTelemetryVisibility
};
