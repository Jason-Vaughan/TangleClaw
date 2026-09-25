'use strict';

/**
 * Medusa delivery watchdog (#1839): the server-owned timer.
 *
 * A deterministic loop over durable exchange state, not an agent: it spends no
 * turns, depends on no inbox of its own, and survives a restart because
 * everything it decides from is in the exchange record. It never injects
 * anything. What it may do is re-arm a wake, which only lets the wake monitor
 * (`lib/medusa-wake.js`) try again, through every gate, for a message whose
 * nudge provably did not land or went unanswered.
 *
 * Re-arm rules, read from the attempt history rather than the latest verdict
 * (a reconnect or a busy pane after an attempt does not undo the attempt):
 * - Only an exchange that has been attempted, with nothing read or
 *   acknowledged, no re-arm already pending, and no receipt saying the engine
 *   accepted the nudge. Accepted-but-unread is for escalation, not another wake.
 * - An attempt the pane proved not accepted (its nonce left in the composer)
 *   is eligible at once. An unconfirmed attempt becomes eligible
 *   `rearmAfterMs` after it.
 * - Each re-arm sets a persisted `next_eligible_at` from a backoff schedule,
 *   and the count is capped. Both live in the record, so duplicate ticks and a
 *   restart mid-backoff re-arm nothing twice.
 *
 * @module lib/medusa-watchdog
 */

const store = require('./store');
const exchanges = require('./medusa-exchanges');
const { createLogger } = require('./logger');

const log = createLogger('medusa-watchdog');

/** Defaults for `config.medusaWatchdog`. */
const DEFAULTS = Object.freeze({
  enabled: true,
  tickMs: 30 * 1000,
  rearmAfterMs: 3 * 60 * 1000,
  backoffMs: Object.freeze([2 * 60 * 1000, 4 * 60 * 1000, 8 * 60 * 1000]),
  maxRearms: 3
});

/** Bounds each numeric setting must fall within. */
const BOUNDS = Object.freeze({
  tickMs: [5 * 1000, 10 * 60 * 1000],
  rearmAfterMs: [30 * 1000, 60 * 60 * 1000],
  backoffStepMs: [30 * 1000, 60 * 60 * 1000],
  maxRearms: [0, 10]
});

/** Seams for tests. */
const _internal = {
  /** @returns {number} Server time in ms. */
  now: () => Date.now(),
  /** @returns {object} The stored global config. */
  loadConfig: () => store.config.load()
};

let _timer = null;

/**
 * Check a proposed `medusaWatchdog` setting against the bounds.
 * @param {object} value - Candidate settings (partial)
 * @returns {string|null} What is wrong, or null
 */
function _problem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'medusaWatchdog must be an object';
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULTS)) return `medusaWatchdog.${key} is not a setting`;
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') return 'medusaWatchdog.enabled must be true or false';
  for (const key of ['tickMs', 'rearmAfterMs', 'maxRearms']) {
    if (!(key in value)) continue;
    const [lo, hi] = BOUNDS[key];
    if (!Number.isInteger(value[key]) || value[key] < lo || value[key] > hi) {
      return `medusaWatchdog.${key} must be a whole number between ${lo} and ${hi}`;
    }
  }
  if ('backoffMs' in value) {
    const [lo, hi] = BOUNDS.backoffStepMs;
    const ok = Array.isArray(value.backoffMs) && value.backoffMs.length >= 1 && value.backoffMs.length <= 10
      && value.backoffMs.every((ms) => Number.isInteger(ms) && ms >= lo && ms <= hi);
    if (!ok) return `medusaWatchdog.backoffMs must be 1 to 10 whole numbers of ms, each between ${lo} and ${hi}`;
  }
  return null;
}

/**
 * Validate a `PATCH /api/config` change to `medusaWatchdog` and merge it over
 * the current settings.
 * @param {object} patch - The requested change (partial)
 * @param {object|undefined} current - The stored settings
 * @returns {{value: object}|{error: string}}
 */
function validatePatch(patch, current) {
  const problem = _problem(patch);
  if (problem) return { error: problem };
  return { value: { ...(current && typeof current === 'object' ? current : {}), ...patch } };
}

/**
 * The settings in force: stored values that pass the bounds, defaults for the
 * rest. A bad stored value is named in `warning` and never used.
 * @param {object} [config] - Global config (defaults to the stored one)
 * @returns {{settings: object, warning: (string|null)}}
 */
function resolveSettings(config) {
  const stored = (config || _internal.loadConfig() || {}).medusaWatchdog;
  if (stored === undefined) return { settings: { ...DEFAULTS }, warning: null };
  const problem = _problem(stored);
  if (problem) return { settings: { ...DEFAULTS }, warning: `${problem}; using the defaults` };
  return { settings: { ...DEFAULTS, ...stored }, warning: null };
}

/**
 * Decide whether one exchange's wake is due a re-arm, and re-arm it if so.
 * @param {object} x - Open exchange row
 * @param {number} now - Server time in ms
 * @param {object} settings - Resolved settings
 * @returns {boolean} Whether it was re-armed
 */
function _considerRearm(x, now, settings) {
  if (x.rearm_count >= settings.maxRearms) return false;
  const facts = store.medusaExchanges.facts(x.exchange_id);
  if (facts.some((f) => f.fact === 'read' || f.fact === 'acknowledged')) return false;
  const standing = exchanges.wakeStanding(facts);
  if (!standing.attempt || standing.rearmPending || standing.outcome === 'wake_accepted') return false;
  const missed = standing.outcome === 'wake_not_accepted';
  const eligibleAt = Date.parse(standing.attempt.at) + (missed ? 0 : settings.rearmAfterMs);
  if (now < eligibleAt) return false;
  if (x.next_eligible_at && now < Date.parse(x.next_eligible_at)) return false;
  const step = settings.backoffMs[Math.min(x.rearm_count, settings.backoffMs.length - 1)];
  const row = exchanges.rearm(x.exchange_id, {
    expectRearmCount: x.rearm_count,
    nextEligibleAt: new Date(now + step).toISOString(),
    code: missed ? 'not-accepted' : 'unconfirmed',
    at: new Date(now).toISOString()
  });
  return row !== null;
}

/**
 * One pass over every open exchange. Safe to call any number of times: each
 * decision is made from the durable record and re-checked inside the
 * transaction that acts on it.
 * @param {number} [now] - Server time in ms
 * @returns {{rearmed: number}}
 */
function tick(now = _internal.now()) {
  const { settings } = resolveSettings();
  if (!settings.enabled) return { rearmed: 0 };
  let rearmed = 0;
  for (const x of store.medusaExchanges.listOpen()) {
    try {
      if (_considerRearm(x, now, settings)) rearmed += 1;
    } catch (err) { // prawduct:allow prawduct/broad-except -- one exchange's store error must not stop the pass over the rest
      log.warn('Watchdog could not judge an exchange', { exchangeId: x.exchange_id, error: err.message });
    }
  }
  return { rearmed };
}

/**
 * Start the timer. Idempotent.
 * @param {{intervalMs?: number}} [opts] - Override the configured tick
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const { settings, warning } = resolveSettings();
  if (warning) log.warn('Medusa watchdog settings ignored', { warning });
  const intervalMs = Number.isInteger(opts.intervalMs) ? opts.intervalMs : settings.tickMs;
  _timer = setInterval(() => {
    try {
      tick();
    } catch (err) { // prawduct:allow prawduct/broad-except -- a failed pass is logged and the next tick tries again; the timer must not die
      log.warn('Medusa watchdog pass failed', { error: err.message });
    }
  }, intervalMs);
  _timer.unref();
  log.info('Medusa watchdog started', { intervalMs, enabled: settings.enabled });
}

/**
 * Stop the timer. Idempotent.
 * @returns {void}
 */
function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { DEFAULTS, BOUNDS, validatePatch, resolveSettings, tick, start, stop, _internal };
