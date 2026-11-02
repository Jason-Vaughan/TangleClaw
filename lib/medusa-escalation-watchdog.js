'use strict';

/**
 * External operator-alert delivery for Medusa escalations (#1876).
 *
 * `lib/medusa-watchdog.js` (#1839) already climbs each open exchange's
 * escalation ladder and raises the LOCAL dashboard alert
 * (`medusaWatchdog.escalationSummary()`) once an exchange reaches the
 * `operator` rung, or is `critical` priority. That alert is read-only state
 * in the exchange record; nothing here changes it, adds to its ladder, or
 * reads anything this module could get wrong badly enough to suppress it —
 * this module only ADDS a second, OPTIONAL delivery of the same facts to an
 * operator-configured external channel (a webhook, or ntfy), for the
 * operator who is not watching the dashboard. Disabling or misconfiguring
 * the external adapter changes nothing about the dashboard alert; the two
 * are read from the same durable source but delivered independently.
 *
 * **Structured facts only, never message text.** An alert carries exactly
 * what `lib/medusa-watchdog.js#listEscalations` already exposes for the
 * dashboard — exchange id, priority, age, the blocker's code and meaning,
 * sender/recipient names, condition — and nothing from any Medusa message
 * body. There is no message text in the exchange record to forward even by
 * mistake (#1839's own module docstring: "Notices carry ids, ages, codes and
 * names only, never message text").
 *
 * **Credentials are a key reference, never a secret in config
 * (`config.escalationExternalAlert.authTokenEnvVar` names an environment
 * variable; its VALUE is read from `process.env` at send time and never
 * stored, logged, or returned from {@link resolveSettings}).** A configured
 * env var that is not actually set is a misconfiguration (recorded and
 * logged once as `credential-missing`), not a reason to send unauthenticated
 * when the operator asked for auth.
 *
 * **Idempotency and backoff, in memory.** Keyed per `(exchangeId,
 * escalationLevel)`, so a duplicate tick for the same still-open escalation
 * sends nothing twice, and a failed attempt backs off exponentially
 * (`backoffMs`, capped at `maxAttempts`) rather than paging again every
 * tick. This is process-lifetime state (no new store schema is in this
 * module's file scope — `lib/store.js` is out of scope for #1876): a
 * restart loses it, so a still-outstanding escalation is reported again
 * once after a restart, exactly once, which is the accepted, bounded cost
 * of not persisting it (see `lib/check-watch.js#_ciNotified`'s identical
 * acceptance for the same reason, #1783).
 *
 * **Adapters are pluggable.** `'webhook'` POSTs a JSON body to a configured
 * URL; `'ntfy'` POSTs plain text to a configured ntfy topic URL. Either way
 * the HTTP call itself is `_internal.fetch`, injectable for tests, so a test
 * adapter needs no real network at all.
 *
 * Lifecycle mirrors `lib/check-watch.js`/`lib/workload-nudge.js`: `start()`
 * arms a `setInterval`, `stop()` clears it, `tick()` is one pass and is what
 * a caller drives by hand in a test.
 *
 * @module lib/medusa-escalation-watchdog
 */

const { createLogger } = require('./logger');

const log = createLogger('medusa-escalation-watchdog');

const SECOND = 1000;
const MIN = 60 * SECOND;

/** Defaults for `config.escalationExternalAlert`. */
const DEFAULTS = Object.freeze({
  enabled: false,
  // 'webhook' | 'ntfy' | null. null (the default) means no adapter is
  // configured, which reads identically to `enabled: false` — both skip
  // every tick without attempting a delivery or logging a misconfiguration
  // (an operator who never opted in is not told about a feature they never asked for).
  adapter: null,
  url: null,
  // Names an environment variable holding a bearer token; never the token
  // itself. null means the destination needs no auth.
  authTokenEnvVar: null,
  tickMs: 30 * SECOND,
  maxAttempts: 5,
  backoffMs: Object.freeze([30 * SECOND, MIN, 2 * MIN, 4 * MIN, 8 * MIN]),
  timeoutMs: 10 * SECOND
});

/** The two adapters this module ships. A caller may inject any other `(alert, opts) => Promise<void>` via `opts.adapter` for a test or a future adapter. */
const BUILTIN_ADAPTERS = Object.freeze(['webhook', 'ntfy']);

/**
 * Validate and fill in defaults for `config.escalationExternalAlert`. Never
 * throws: a malformed setting reads as disabled, with the specific problem
 * named so `tick` can log it once rather than attempt a delivery from it.
 * @param {object} raw - `config.escalationExternalAlert` as stored, or anything
 * @returns {{settings: object, problem: (string|null)}} `problem` is null when `settings` is usable as given
 */
function resolveSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const settings = { ...DEFAULTS, ...r };
  settings.backoffMs = Array.isArray(r.backoffMs) && r.backoffMs.every((n) => Number.isFinite(n) && n > 0)
    ? r.backoffMs : DEFAULTS.backoffMs;
  settings.maxAttempts = Number.isInteger(r.maxAttempts) && r.maxAttempts > 0 ? r.maxAttempts : DEFAULTS.maxAttempts;
  settings.tickMs = Number.isFinite(r.tickMs) && r.tickMs >= SECOND ? r.tickMs : DEFAULTS.tickMs;
  settings.timeoutMs = Number.isFinite(r.timeoutMs) && r.timeoutMs >= SECOND ? r.timeoutMs : DEFAULTS.timeoutMs;
  if (!settings.enabled) return { settings, problem: null };
  if (!BUILTIN_ADAPTERS.includes(settings.adapter) && typeof r.adapterFn !== 'function') {
    return { settings, problem: `adapter must be one of ${BUILTIN_ADAPTERS.join(', ')}, or adapterFn a function` };
  }
  if (typeof settings.url !== 'string' || !/^https?:\/\//.test(settings.url)) {
    return { settings, problem: 'url must be an http(s) URL' };
  }
  if (settings.authTokenEnvVar !== null && typeof settings.authTokenEnvVar !== 'string') {
    return { settings, problem: 'authTokenEnvVar must be a string env var name, or null' };
  }
  return { settings, problem: null };
}

/**
 * The credential a delivery needs, resolved from the environment at send
 * time — never stored, logged or returned by {@link resolveSettings}.
 * @param {object} settings - From {@link resolveSettings}
 * @returns {{ok: true, token: (string|null)}|{ok: false, code: 'credential-missing'}}
 *   `token` is null when no `authTokenEnvVar` was configured (no auth needed).
 */
function _credential(settings) {
  if (!settings.authTokenEnvVar) return { ok: true, token: null };
  const token = _internal.env()[settings.authTokenEnvVar];
  if (!token) return { ok: false, code: 'credential-missing' };
  return { ok: true, token };
}

/**
 * The structured alert body for one escalated exchange — ids, ages, codes
 * and names only, matching `lib/medusa-watchdog.js#listEscalations`'s own
 * no-message-text contract. Nothing here is attacker-controlled free text:
 * every field is either a number, a code from a closed set, or a project
 * name/workspace id this server itself assigned.
 * @param {object} escalation - One entry from `medusaWatchdog.listEscalations()`
 * @returns {object}
 */
function _alertBody(escalation) {
  return {
    event: 'medusa_escalation',
    exchangeId: escalation.exchangeId,
    priority: escalation.priority,
    escalationLevel: escalation.escalation,
    condition: escalation.condition,
    ageMinutes: escalation.ageMinutes,
    blockerCode: escalation.blocker ? escalation.blocker.code : null,
    blockerMeaning: escalation.blocker ? escalation.blocker.meaning : null,
    sender: escalation.senderName,
    recipient: escalation.recipientName
  };
}

/**
 * The `webhook` adapter: POST the alert body as JSON.
 * @param {object} escalation - One entry from `medusaWatchdog.listEscalations()`
 * @param {{url: string, token: (string|null), timeoutMs: number}} opts
 * @returns {Promise<{ok: boolean, status: (number|null)}>}
 */
async function webhookAdapter(escalation, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await _internal.fetch(opts.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(_alertBody(escalation)),
    signal: _internal.timeoutSignal(opts.timeoutMs)
  });
  return { ok: res.ok, status: res.status };
}

/**
 * The `ntfy` adapter: POST a short, bounded plain-text line to a configured
 * ntfy topic URL. ntfy's body IS the notification text, so this is the one
 * adapter that renders the alert as a sentence rather than JSON — still
 * built only from the same closed set of codes and names, never message text.
 * @param {object} escalation - One entry from `medusaWatchdog.listEscalations()`
 * @param {{url: string, token: (string|null), timeoutMs: number}} opts
 * @returns {Promise<{ok: boolean, status: (number|null)}>}
 */
async function ntfyAdapter(escalation, opts) {
  const headers = { 'Content-Type': 'text/plain' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = `Medusa escalation: ${escalation.priority} message to ${escalation.recipientName || 'unknown'} `
    + `is ${escalation.condition} (${escalation.blocker ? escalation.blocker.code : 'unknown'}), `
    + `${escalation.ageMinutes}m old. Exchange ${escalation.exchangeId}.`;
  const res = await _internal.fetch(opts.url, { method: 'POST', headers, body, signal: _internal.timeoutSignal(opts.timeoutMs) });
  return { ok: res.ok, status: res.status };
}

/** Built-in adapter functions, by name. */
const ADAPTERS = Object.freeze({ webhook: webhookAdapter, ntfy: ntfyAdapter });

/**
 * Per-`(exchangeId, escalationLevel)` delivery state. Process-lifetime only
 * — see the module docstring's "Idempotency and backoff" section for why.
 * @type {Map<string, {state: string, attempts: number, nextAttemptAt: number, lastError: (string|null)}>}
 */
const _deliveries = new Map();

/**
 * The idempotency key one escalation's alert is tracked under.
 * @param {object} escalation - One entry from `medusaWatchdog.listEscalations()`
 * @returns {string}
 */
function _key(escalation) {
  return `${escalation.exchangeId}:${escalation.escalation || (escalation.priority === 'critical' ? 'critical' : 'unknown')}`;
}

/**
 * Attempt one escalation's delivery, respecting its own backoff, and record
 * what happened. Never throws.
 * @param {object} escalation - One entry from `medusaWatchdog.listEscalations()`
 * @param {object} settings - From {@link resolveSettings}
 * @param {number} now - Ms
 * @returns {Promise<void>}
 */
async function _deliver(escalation, settings, now) {
  const key = _key(escalation);
  const prior = _deliveries.get(key);
  const names = { exchangeId: escalation.exchangeId, level: escalation.escalation, priority: escalation.priority };

  if (prior && prior.state === 'accepted') return;
  if (prior && prior.state === 'retry-exhausted') return;
  if (prior && now < prior.nextAttemptAt) return;

  const credential = _credential(settings);
  if (!credential.ok) {
    if (!prior || prior.state !== 'failed' || prior.lastError !== credential.code) {
      log.warn('An external escalation alert could not be sent: its configured credential is not set', { ...names, code: credential.code, envVar: settings.authTokenEnvVar });
    }
    _deliveries.set(key, { state: 'failed', attempts: prior ? prior.attempts : 0, nextAttemptAt: Infinity, lastError: credential.code });
    return;
  }

  const attempts = (prior ? prior.attempts : 0) + 1;
  _deliveries.set(key, { state: 'queued', attempts: prior ? prior.attempts : 0, nextAttemptAt: prior ? prior.nextAttemptAt : now, lastError: prior ? prior.lastError : null });
  log.info('Sending an external escalation alert', { ...names, attempt: attempts, of: settings.maxAttempts });

  const deliverFn = typeof settings.adapterFn === 'function' ? settings.adapterFn : ADAPTERS[settings.adapter];
  try {
    const result = await deliverFn(escalation, { url: settings.url, token: credential.token, timeoutMs: settings.timeoutMs });
    if (result && result.ok) {
      _deliveries.set(key, { state: 'accepted', attempts, nextAttemptAt: Infinity, lastError: null });
      log.info('External escalation alert accepted', { ...names, attempts, status: result.status });
      return;
    }
    throw Object.assign(new Error(`destination answered ${result && result.status}`), { status: result && result.status });
  // prawduct:allow prawduct/broad-except -- a failed delivery is recorded and retried on its own backoff; it must never stop the pass over the rest
  } catch (err) {
    const message = String((err && err.message) || 'delivery failed').slice(0, 200);
    if (attempts >= settings.maxAttempts) {
      _deliveries.set(key, { state: 'retry-exhausted', attempts, nextAttemptAt: Infinity, lastError: message });
      log.warn('External escalation alert retry budget exhausted; it will not be sent again for this escalation', { ...names, attempts, error: message });
      return;
    }
    const backoff = settings.backoffMs[Math.min(attempts - 1, settings.backoffMs.length - 1)];
    _deliveries.set(key, { state: 'failed', attempts, nextAttemptAt: now + backoff, lastError: message });
    log.warn('External escalation alert delivery failed; retrying with backoff', { ...names, attempts, retryInMs: backoff, error: message });
  }
}

/**
 * One pass: read the same escalations the dashboard alert reads, and
 * deliver (or retry, or skip) each one's external alert. Never throws.
 * @param {number} [given] - Clock reading to judge against; read here when omitted
 * @returns {Promise<{considered: number, skippedDisabled: boolean, skippedMisconfigured: (string|null)}>}
 */
async function tick(given) {
  const now = given === undefined ? _internal.now() : given;
  const config = _internal.loadConfig();
  const { settings, problem } = resolveSettings(config && config.escalationExternalAlert);
  if (!settings.enabled) return { considered: 0, skippedDisabled: true, skippedMisconfigured: null };
  if (problem) {
    log.warn('External escalation alert is enabled but misconfigured; nothing is sent until it is fixed', { problem });
    return { considered: 0, skippedDisabled: false, skippedMisconfigured: problem };
  }
  let escalations;
  try {
    escalations = _internal.listEscalations(now).filter((e) => e.escalation === 'operator' || e.priority === 'critical');
  // prawduct:allow prawduct/broad-except -- a store read that fails this tick is tried again next tick; it must not throw into the timer
  } catch (err) {
    log.warn('Could not read escalations for the external alert pass', { error: err && err.message });
    return { considered: 0, skippedDisabled: false, skippedMisconfigured: null };
  }
  await Promise.all(escalations.map((e) => _deliver(e, settings, now)));
  return { considered: escalations.length, skippedDisabled: false, skippedMisconfigured: null };
}

/** @type {NodeJS.Timeout|null} */
let _timer = null;
/** @type {Promise<object>|null} */
let _pass = null;

/**
 * Start the watchdog. Idempotent.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]
 * @returns {void}
 */
function start(opts = {}) {
  if (_timer) return;
  const intervalMs = opts.intervalMs || DEFAULTS.tickMs;
  _timer = setInterval(() => {
    _pass = tick().finally(() => { _pass = null; });
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  log.info('Medusa escalation external-alert watchdog started', { intervalMs });
}

/** Stop the watchdog. The pass already running finishes. @returns {void} */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** Wait for the pass now running, if one is. @returns {Promise<void>} */
async function settled() {
  while (_pass) await _pass;
}

/**
 * Test-only: forget every delivery's state, as if the process had just
 * restarted. Production never calls this.
 * @returns {void}
 */
function __unsafeResetDeliveries() {
  _deliveries.clear();
}

const _internal = {
  now: () => Date.now(),
  env: () => process.env,
  loadConfig: () => require('./store').config.load(),
  listEscalations: (now) => require('./medusa-watchdog').listEscalations(now),
  fetch: (...args) => fetch(...args),
  timeoutSignal: (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined)
};

module.exports = {
  start,
  stop,
  tick,
  settled,
  resolveSettings,
  DEFAULTS,
  BUILTIN_ADAPTERS,
  ADAPTERS,
  __unsafeResetDeliveries,
  _internal
};
