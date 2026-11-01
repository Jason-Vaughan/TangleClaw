'use strict';

/**
 * Master continuity-handoff evaluation (#2120): a self-contained, pure
 * evaluation module. It decides WHETHER the Project Master's current context
 * health warrants a continuity handoff; it never decides HOW one happens.
 *
 * Master is deliberately not a `sessions` table row (`lib/master.js`'s own
 * architecture note) and never goes through the normal wrap pipeline, so
 * nothing watches its context health today — the only prior art is the fully
 * manual protocol used during the v5.31.0 operator-bridge activation (source
 * writes a capsule, a companion verifies, the operator relaunches). That
 * protocol is `~/.claude/skills/tangleclaw-session-continuity` (capsule
 * schema `tangleclaw-continuity/v1`; see `references/protocol.md`). This
 * module does not reimplement it or trigger it — Invariant 1 of that skill
 * is explicit that it alone authorizes any Wrap/Kill/relaunch side effect.
 * What this module produces is the SIGNAL that protocol is meant to act on:
 * a status (`ok` | `warning` | `critical`) and, once triggered, a small
 * structured hint naming the schema and the next safe action, so whoever
 * calls this (`lib/master.js` or `server.js`, in W2-A) has something
 * concrete to hand the skill rather than inventing that mapping itself.
 *
 * Deliberately decoupled from where a context reading comes from: #1622
 * (exposing an engine's own remaining-context percent via the TangleClaw
 * API) is still open, so {@link evaluateContinuityHealth} also accepts a
 * pane-buffer-size estimate as a fallback input shape. Once #1622 ships,
 * callers can switch to the reported-percent input with no change here.
 *
 * @module lib/master-continuity
 */

/**
 * Defaults for the warning/critical thresholds, expressed as the percent of
 * context remaining (not used) at which each status fires. Mirrors the
 * shape of `lib/medusa-watchdog.js`'s `DEFAULTS`/`resolveSettings` — a plain
 * object the caller may override, never read from global config here, since
 * this module is explicitly self-contained (no `./store` dependency).
 * @type {{enabled: boolean, warningRemainingPercent: number, criticalRemainingPercent: number}}
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  // 30%/15% remaining mirrors the kind of margin the session-continuity
  // skill's own context budget asks for (target 5%, hard ceiling 10% of the
  // REPLACEMENT'S incremental load) — these two numbers are the trigger on
  // the SOURCE side, early enough that a deliberate capsule/companion
  // handoff can happen before quality degrades, not only once it already has.
  warningRemainingPercent: 30,
  criticalRemainingPercent: 15
});

const STATUSES = Object.freeze(['ok', 'warning', 'critical']);

/**
 * Validate a settings override. Returns a human-readable problem, or null.
 * @param {object} value
 * @returns {string|null}
 */
function _problem(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'settings override must be a plain object';
  }
  for (const key of ['warningRemainingPercent', 'criticalRemainingPercent']) {
    if (key in value) {
      const n = value[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) {
        return `${key} must be a number between 0 and 100`;
      }
    }
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  if (
    'warningRemainingPercent' in value && 'criticalRemainingPercent' in value
    && value.criticalRemainingPercent > value.warningRemainingPercent
  ) {
    return 'criticalRemainingPercent must not exceed warningRemainingPercent (critical fires at or below warning)';
  }
  return null;
}

/**
 * The settings in force: a caller-supplied override merged over
 * {@link DEFAULTS}, or the defaults alone when the override is invalid.
 * @param {object} [overrides]
 * @returns {{settings: object, warning: (string|null)}}
 */
function resolveSettings(overrides) {
  if (overrides === undefined) return { settings: { ...DEFAULTS }, warning: null };
  const problem = _problem(overrides);
  if (problem) return { settings: { ...DEFAULTS }, warning: `${problem}; using the defaults` };
  const merged = { ...DEFAULTS, ...overrides };
  // A valid individual pair re-checked together, in case only one of the two
  // was overridden (each alone passes _problem's per-key bounds check).
  if (merged.criticalRemainingPercent > merged.warningRemainingPercent) {
    return {
      settings: { ...DEFAULTS },
      warning: 'criticalRemainingPercent must not exceed warningRemainingPercent; using the defaults'
    };
  }
  return { settings: merged, warning: null };
}

/**
 * Derive a remaining-context percent from a reading. Prefers a directly
 * reported percent; falls back to a pane-buffer-size estimate when that is
 * all the caller has (pre-#1622). Returns null when neither shape is usable.
 * @param {object} reading
 * @param {number} [reading.remainingPercent] - 0-100, directly reported.
 * @param {{usedBytes: number, capacityBytes: number}} [reading.paneBuffer] -
 *   Estimate input: bytes consumed vs. the pane's buffer capacity. Treated
 *   as a lower-bound proxy for context fill, not an exact measurement — the
 *   pane buffer and the engine's token context are different quantities
 *   that merely tend to grow together.
 * @returns {{remainingPercent: number, source: 'reported'|'estimated'}|null}
 */
function _deriveRemainingPercent(reading) {
  if (reading && typeof reading.remainingPercent === 'number' && Number.isFinite(reading.remainingPercent)) {
    return { remainingPercent: Math.max(0, Math.min(100, reading.remainingPercent)), source: 'reported' };
  }
  const buf = reading && reading.paneBuffer;
  if (
    buf && typeof buf.usedBytes === 'number' && typeof buf.capacityBytes === 'number'
    && Number.isFinite(buf.usedBytes) && Number.isFinite(buf.capacityBytes) && buf.capacityBytes > 0
    && buf.usedBytes >= 0
  ) {
    const usedPercent = (buf.usedBytes / buf.capacityBytes) * 100;
    return { remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)), source: 'estimated' };
  }
  return null;
}

/**
 * The structured hint this module hands a caller once a non-`ok` status
 * fires — named fields a caller can act on without re-deriving the mapping
 * from status to protocol action, but never itself an authorization: only
 * the `tangleclaw-session-continuity` skill, run by a session with the
 * required authority, may actually prepare or act on a capsule.
 *
 * `transition: 'finalize-relaunch'` (not `'wrap'`) at critical: Master's own
 * generated identity states "you never wrap" (`lib/master.js`), because it is
 * not a `sessions` row and never goes through the wrap pipeline. The
 * `tangleclaw-continuity/v1` schema's own transition enum
 * (`clear|wrap|finalize-relaunch|engine-rebind`, see the
 * `tangleclaw-session-continuity` skill's `references/protocol.md`) has no
 * "companion-relaunch" value, so this uses its closest real member — a full
 * stop-and-relaunch, which is what the only prior art (the v5.31.0 manual
 * Kill+Retry protocol) actually is — and still carries `wrap: 'none'`
 * explicitly, since `finalize-relaunch` elsewhere in the schema describes an
 * ordinary session's wrap-then-relaunch, which Master does not do either.
 * @param {'warning'|'critical'} status
 * @returns {{schema: string, transition: string, wrap: string, next_safe_action: string}}
 */
function _continuityHint(status) {
  return {
    schema: 'tangleclaw-continuity/v1',
    transition: status === 'critical' ? 'finalize-relaunch' : 'clear',
    wrap: 'none',
    next_safe_action: status === 'critical'
      ? 'Prepare a continuity capsule now (tangleclaw-session-continuity skill, Prepare phase) and arm a companion for a Kill+Retry relaunch before continuing routing.'
      : 'Plan ahead for a continuity capsule; no immediate action required yet.'
  };
}

/**
 * Evaluate Master's current context-health reading against the configured
 * warning/critical thresholds and report whether a continuity handoff is
 * warranted.
 *
 * Pure function: takes its reading and settings as arguments, reads nothing
 * from disk, the store, or the live engine. The caller (`lib/master.js` or
 * `server.js`, in W2-A) is responsible for sourcing `reading` and for acting
 * on a non-`ok` result.
 *
 * @param {object} reading - See {@link _deriveRemainingPercent} for the two
 *   accepted shapes (`remainingPercent` or `paneBuffer`).
 * @param {object} [overrides] - Settings override; see {@link resolveSettings}.
 * @returns {{
 *   status: 'ok'|'warning'|'critical'|'unmeasured'|'disabled',
 *   trigger: boolean,
 *   remainingPercent: (number|null),
 *   source: ('reported'|'estimated'|null),
 *   thresholds: ({warningRemainingPercent: number, criticalRemainingPercent: number}|null),
 *   settingsWarning: (string|null),
 *   reason: (string|undefined),
 *   protocol: (object|null)
 * }}
 */
function evaluateContinuityHealth(reading, overrides) {
  const { settings, warning: settingsWarning } = resolveSettings(overrides);

  if (!settings.enabled) {
    return {
      status: 'disabled', trigger: false, remainingPercent: null, source: null,
      thresholds: null, settingsWarning, protocol: null
    };
  }

  const derived = _deriveRemainingPercent(reading);
  if (!derived) {
    return {
      status: 'unmeasured', trigger: false, remainingPercent: null, source: null,
      thresholds: null, settingsWarning,
      reason: 'no usable remainingPercent or paneBuffer reading supplied',
      protocol: null
    };
  }

  const { remainingPercent, source } = derived;
  let status;
  if (remainingPercent <= settings.criticalRemainingPercent) status = 'critical';
  else if (remainingPercent <= settings.warningRemainingPercent) status = 'warning';
  else status = 'ok';

  return {
    status,
    trigger: status !== 'ok',
    remainingPercent,
    source,
    thresholds: {
      warningRemainingPercent: settings.warningRemainingPercent,
      criticalRemainingPercent: settings.criticalRemainingPercent
    },
    settingsWarning,
    protocol: status === 'ok' ? null : _continuityHint(status)
  };
}

module.exports = {
  DEFAULTS,
  STATUSES,
  resolveSettings,
  evaluateContinuityHealth
};
