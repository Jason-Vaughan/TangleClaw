'use strict';

/**
 * Member-level engine fallback chains (#3271, V6-027, Car V664-W1-A):
 * configurable Primary -> Secondary -> Tertiary engine/model/effort
 * profiles, deterministic failover triggers, and automatic/boundary
 * return-to-primary — built on top of `lib/model-switch.js`'s existing
 * `switchSessionModel` (its `'outage-takeover'` mode is exactly the
 * unattended, no-boundary-check relaunch a fallback trigger needs; its
 * `'boundary'` mode is exactly the clean-handoff switch a return-to-primary
 * needs), never duplicating that function's own validation, continuity
 * handoff capture, or project-config write path.
 *
 * Chain configuration and failover state are both persisted on the
 * project's own config object (`store.projectConfig.load`/`.save`), the
 * same storage `lib/model-switch.js` already uses for `engine`/`model` —
 * no new store module or SQL table, consistent with that file's own
 * convention. Config key: `engineFallbackChain` (`{primary, secondary,
 * tertiary}`, each `{engine, model, effort?}|null`). State key:
 * `engineFallbackState` (`{activeTier: 'primary'|'secondary'|'tertiary',
 * retryCounts: {secondary: number, tertiary: number}, lastFailoverAt:
 * string|null, lastFailoverReason: string|null}`).
 *
 * "Member-level (and fleet-default)" scoping (the issue's own phrase): this
 * module only ever resolves a chain for one named project/session, the
 * same granularity `switchSessionModel` already operates at. A fleet-wide
 * default that member settings can override is a UI/settings-merge concern
 * for a later car (`public/v6-shell.js`'s own Fleet Settings surface, out
 * of this car's file envelope) — `getFallbackChain` takes an optional
 * `fleetDefault` argument so that merge, once built, has something to
 * merge against without this module guessing at the merge policy itself.
 *
 * @module lib/engine-fallback-chain
 */

const store = require('./store');
const { switchSessionModel } = require('./model-switch');

const TIERS = ['primary', 'secondary', 'tertiary'];
/** The tier after `tier`, or null past tertiary — the fixed fallback order the issue names. */
const NEXT_TIER = { primary: 'secondary', secondary: 'tertiary', tertiary: null };

/** Deterministic fallback triggers the issue itself names. */
const TRIGGER_REASONS = Object.freeze({
  QUOTA_EXHAUSTED: 'quota-exhausted',
  LAUNCH_TIMEOUT: 'repeated-launch-timeout',
  TURN_TIMEOUT: 'repeated-turn-timeout',
  ENGINE_CRASH: 'unrecoverable-crash'
});

/** `{primary, secondary, tertiary}`, each `null` or `{engine, model, effort?}` — the shape every function here reads/writes. */
function _emptyChain() {
  return { primary: null, secondary: null, tertiary: null };
}

/** The shape `engineFallbackState` always has, never partially written. */
function _emptyState() {
  return { activeTier: 'primary', retryCounts: { secondary: 0, tertiary: 0 }, lastFailoverAt: null, lastFailoverReason: null };
}

/**
 * The project this chain is configured for, or null when it does not exist.
 * @param {string} sessionName
 * @param {object} deps - Seam: `getProject`.
 * @returns {object|null}
 */
function _project(sessionName, deps) {
  const getProject = deps.getProject || ((name) => store.projects.getByName(name));
  return getProject(sessionName) || null;
}

/**
 * Read a project's configured fallback chain, optionally merged onto a
 * fleet-wide default (the issue's "fleet-default" half) — any tier the
 * project's own config leaves `null` falls back to `fleetDefault`'s same
 * tier, when given. A project's own `null` for a tier it NEVER configured
 * is indistinguishable here from one it deliberately cleared; this module
 * does not need the distinction (both mean "use the default, if any").
 * @param {string} sessionName
 * @param {object} [deps] - Seams: `getProject`, `loadProjectConfig`.
 * @param {{primary: object, secondary: (object|null), tertiary: (object|null)}} [fleetDefault]
 * @returns {{ok: boolean, code: string, chain?: object}}
 */
function getFallbackChain(sessionName, deps = {}, fleetDefault = null) {
  const project = _project(sessionName, deps);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  const loadProjectConfig = deps.loadProjectConfig || ((p) => store.projectConfig.load(p));
  const config = loadProjectConfig(project.path) || {};
  const own = config.engineFallbackChain || _emptyChain();
  const chain = _emptyChain();
  for (const tier of TIERS) {
    chain[tier] = own[tier] || (fleetDefault && fleetDefault[tier]) || null;
  }
  return { ok: true, code: 'OK', chain };
}

/**
 * Set a project's own fallback chain. `secondary`/`tertiary` are optional
 * (a chain with only `primary` configured has nowhere to fall back to —
 * {@link applyFallback} reports `CHAIN_EXHAUSTED` rather than failing this
 * call); `primary` is required, since a chain with no primary names no
 * engine this project actually runs on day to day.
 * @param {string} sessionName
 * @param {{primary: {engine: string, model: string, effort?: string}, secondary?: (object|null), tertiary?: (object|null)}} chain
 * @param {object} [deps] - Seams: `getProject`, `loadProjectConfig`, `saveProjectConfig`.
 * @returns {{ok: boolean, code: string}}
 */
function setFallbackChain(sessionName, chain, deps = {}) {
  const project = _project(sessionName, deps);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  const primary = chain && chain.primary;
  if (!primary || typeof primary.engine !== 'string' || !primary.engine || typeof primary.model !== 'string' || !primary.model) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const loadProjectConfig = deps.loadProjectConfig || ((p) => store.projectConfig.load(p));
  const saveProjectConfig = deps.saveProjectConfig || ((p, cfg) => store.projectConfig.save(p, cfg));
  const config = loadProjectConfig(project.path) || {};
  const stored = _emptyChain();
  for (const tier of TIERS) {
    const t = chain[tier];
    stored[tier] = t && typeof t.engine === 'string' && typeof t.model === 'string'
      ? { engine: t.engine, model: t.model, ...(t.effort ? { effort: t.effort } : {}) }
      : null;
  }
  saveProjectConfig(project.path, { ...config, engineFallbackChain: stored });
  return { ok: true, code: 'UPDATED' };
}

/**
 * A project's current failover state (which tier is active, retry counts
 * so far), defaulting to a fresh `_emptyState()` when none has ever been
 * written — a project that has never failed over is simply "on primary,
 * no retries yet," not an error.
 * @param {string} sessionName
 * @param {object} [deps] - Seams: `getProject`, `loadProjectConfig`.
 * @returns {{ok: boolean, code: string, state?: object}}
 */
function getFallbackState(sessionName, deps = {}) {
  const project = _project(sessionName, deps);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  const loadProjectConfig = deps.loadProjectConfig || ((p) => store.projectConfig.load(p));
  const config = loadProjectConfig(project.path) || {};
  return { ok: true, code: 'OK', state: config.engineFallbackState || _emptyState() };
}

/**
 * Whether `status` reports a deterministic fallback trigger — pure, no I/O,
 * so a caller (a health-check loop, a launch-failure handler) can call this
 * on every observation without this module reaching for the database or a
 * live pane itself; those live checks are the caller's own concern, named
 * in `status`.
 * @param {object} status
 * @param {boolean} [status.quotaExhausted] - A provider 5h/weekly quota report.
 * @param {number} [status.consecutiveLaunchTimeouts]
 * @param {number} [status.consecutiveTurnTimeouts]
 * @param {boolean} [status.crashed] - An unrecoverable engine crash.
 * @param {object} [thresholds] - `launchTimeouts`/`turnTimeouts` (default 2 each — "repeated", never a single transient timeout).
 * @returns {{trigger: boolean, reason: (string|null)}}
 */
function evaluateFallbackTrigger(status, thresholds = {}) {
  const s = status || {};
  const launchThreshold = Number.isFinite(thresholds.launchTimeouts) ? thresholds.launchTimeouts : 2;
  const turnThreshold = Number.isFinite(thresholds.turnTimeouts) ? thresholds.turnTimeouts : 2;
  if (s.crashed) return { trigger: true, reason: TRIGGER_REASONS.ENGINE_CRASH };
  if (s.quotaExhausted) return { trigger: true, reason: TRIGGER_REASONS.QUOTA_EXHAUSTED };
  if (Number.isFinite(s.consecutiveLaunchTimeouts) && s.consecutiveLaunchTimeouts >= launchThreshold) {
    return { trigger: true, reason: TRIGGER_REASONS.LAUNCH_TIMEOUT };
  }
  if (Number.isFinite(s.consecutiveTurnTimeouts) && s.consecutiveTurnTimeouts >= turnThreshold) {
    return { trigger: true, reason: TRIGGER_REASONS.TURN_TIMEOUT };
  }
  return { trigger: false, reason: null };
}

/**
 * Fall back to the next configured tier after the project's current
 * `activeTier`, via `switchSessionModel`'s `'outage-takeover'` mode (the
 * unattended relaunch path — no boundary check, bounded by the issue's own
 * "bounded retries" requirement via `maxRetries`). Context restoration is
 * `switchSessionModel`/`_writeContinuityHandoff`'s own existing job, not
 * duplicated here.
 * @param {string} sessionName
 * @param {object} [args]
 * @param {string} [args.reason] - One of `TRIGGER_REASONS`, or any string — recorded in state and forwarded to `switchSessionModel` as `opts.reason`.
 * @param {number} [args.maxRetries] - Per-tier retry ceiling (default 3): a tier already retried this many times without recovering is skipped straight to the NEXT one, never retried forever.
 * @param {object} [deps] - Forwarded to `switchSessionModel`, plus this module's own `getProject`/`loadProjectConfig`/`saveProjectConfig`/`now`/`switchSessionModel` (test-only override) seams.
 * @returns {Promise<{ok: boolean, code: string, tier?: string, switchResult?: object}>}
 */
async function applyFallback(sessionName, args = {}, deps = {}) {
  const maxRetries = Number.isFinite(args.maxRetries) ? args.maxRetries : 3;
  const now = deps.now || (() => new Date().toISOString());
  const doSwitch = deps.switchSessionModel || switchSessionModel;

  const chainResult = getFallbackChain(sessionName, deps);
  if (!chainResult.ok) return chainResult;
  const stateResult = getFallbackState(sessionName, deps);
  if (!stateResult.ok) return stateResult;
  const { chain } = chainResult;
  const state = stateResult.state;

  let nextTier = NEXT_TIER[state.activeTier];
  // Skip a tier that already exhausted its own retry budget, straight to
  // the one after it — a tier retried past `maxRetries` without recovering
  // is not retried a fourth time just because it is "next" in the chain.
  while (nextTier && state.retryCounts[nextTier] >= maxRetries) {
    nextTier = NEXT_TIER[nextTier];
  }
  if (!nextTier || !chain[nextTier]) {
    return { ok: false, code: 'CHAIN_EXHAUSTED' };
  }

  const target = chain[nextTier];
  const reason = args.reason || TRIGGER_REASONS.ENGINE_CRASH;
  const switchResult = await doSwitch(sessionName, {
    engine: target.engine, model: target.model, effort: target.effort,
    mode: 'outage-takeover', reason: `engine-fallback-chain: ${reason} -> ${nextTier}`
  }, deps);
  if (!switchResult.ok) return { ok: false, code: 'SWITCH_FAILED', switchResult };

  const project = _project(sessionName, deps);
  const loadProjectConfig = deps.loadProjectConfig || ((p) => store.projectConfig.load(p));
  const saveProjectConfig = deps.saveProjectConfig || ((p, cfg) => store.projectConfig.save(p, cfg));
  const config = loadProjectConfig(project.path) || {};
  const nextState = {
    activeTier: nextTier,
    retryCounts: { ...state.retryCounts, [nextTier]: (state.retryCounts[nextTier] || 0) + 1 },
    lastFailoverAt: now(),
    lastFailoverReason: reason
  };
  saveProjectConfig(project.path, { ...config, engineFallbackState: nextState });
  return { ok: true, code: 'FAILED_OVER', tier: nextTier, switchResult };
}

/**
 * Automatic/boundary return-to-primary (the issue's own phrase, verbatim):
 * when the project is not already on `primary` and `deps.isPrimaryHealthy()`
 * says the primary tier has recovered, switch directly back to `primary` —
 * never to an intermediate tier — via `switchSessionModel`'s `'boundary'`
 * mode (a clean handoff, never an unattended takeover for a RECOVERY; the
 * issue calls this "automatic/boundary", not "immediate", and boundary
 * mode's own blocker checks are what make that distinction real).
 * @param {string} sessionName
 * @param {object} [deps] - Forwarded to `switchSessionModel`, plus this module's own seams. `isPrimaryHealthy()` defaults to `() => false` (test-only default; a real caller always supplies this, backed by a live engine health probe).
 * @returns {Promise<{ok: boolean, code: string, tier?: string, switchResult?: object}>}
 */
async function checkReturnToPrimary(sessionName, deps = {}) {
  const isPrimaryHealthy = deps.isPrimaryHealthy || (() => false);
  const doSwitch = deps.switchSessionModel || switchSessionModel;

  const stateResult = getFallbackState(sessionName, deps);
  if (!stateResult.ok) return stateResult;
  const { state } = stateResult;
  if (state.activeTier === 'primary') return { ok: true, code: 'ALREADY_PRIMARY' };
  if (!isPrimaryHealthy()) return { ok: true, code: 'PRIMARY_STILL_UNHEALTHY' };

  const chainResult = getFallbackChain(sessionName, deps);
  if (!chainResult.ok) return chainResult;
  const target = chainResult.chain.primary;
  if (!target) return { ok: false, code: 'CHAIN_EXHAUSTED' };

  const switchResult = await doSwitch(sessionName, {
    engine: target.engine, model: target.model, effort: target.effort,
    mode: 'boundary', reason: 'engine-fallback-chain: return-to-primary'
  }, deps);
  if (!switchResult.ok) return { ok: false, code: 'SWITCH_FAILED', switchResult };

  const project = _project(sessionName, deps);
  const loadProjectConfig = deps.loadProjectConfig || ((p) => store.projectConfig.load(p));
  const saveProjectConfig = deps.saveProjectConfig || ((p, cfg) => store.projectConfig.save(p, cfg));
  const config = loadProjectConfig(project.path) || {};
  saveProjectConfig(project.path, { ...config, engineFallbackState: _emptyState() });
  return { ok: true, code: 'RETURNED', tier: 'primary', switchResult };
}

module.exports = {
  TRIGGER_REASONS,
  getFallbackChain, setFallbackChain, getFallbackState,
  evaluateFallbackTrigger, applyFallback, checkReturnToPrimary
};
