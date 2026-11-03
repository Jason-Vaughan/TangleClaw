'use strict';

/**
 * PM Medusa Toggle State Reconciliation (#1677 Slice 1, v5.61.0 Car 61-C,
 * Architect Ruling A1677).
 *
 * #1677's own incident: an operator's settings-modal screenshot showed both
 * Medusa toggles ON, while the persisted project record (`.tangleclaw/project.json`,
 * read back through `GET /api/projects/<name>`) and the live install both
 * agreed the stored value was `false`. Separately, a temporary listener
 * started through the per-session toggle (not a persisted project opt-in)
 * received messages while the persisted setting stayed `false` the whole
 * time. Two different things were able to look identical to a caller that
 * only checked "is something happening right now": a genuinely persisted
 * opt-in, and a transient runtime override that will not survive the next
 * boot.
 *
 * **The one rule this module exists to enforce**: the persisted value is
 * always the project's actual state. A live listener, a per-session toggle,
 * or any other transient signal is reported as a fact about the MOMENT —
 * `drifted` — never substituted for the persisted value as if it were more
 * current. Nothing here ever reports `effectiveValue: true` for a project
 * whose persisted setting is `false`, no matter what is happening at runtime
 * right now.
 *
 * **Vetoable Slice 1 scoping assumptions** (the Architect Ruling comment
 * truncates after this contract's first numbered item; the issue's own body
 * is the source for the rest, same discipline this project already applies
 * to a truncated ruling elsewhere -- #1350, #1370):
 * - This module is pure: no `fs`/`store` reads, no network calls. The
 *   caller supplies the already-read persisted values and the already-
 *   observed runtime signal (e.g. `medusa.getStatus(sessionId).state !==
 *   'off'`, the same check `lib/coordinator-rotation.js`'s own `listening`
 *   seam already uses) — this module is the reconciliation LOGIC, not
 *   another reader of either source. Wiring a real caller (the settings
 *   modal's own API route, the dashboard banner) through it is a later
 *   slice, exactly as #1350 Slice 1 built the async I/O primitive without
 *   touching `lib/projects.js`'s own call sites.
 * - `medusaWake` has no independent runtime signal of its own today (it
 *   gates a nudge decision made at idle-check time, not an ongoing state a
 *   caller could observe "live") — its drift detection is therefore scoped
 *   to persisted-vs-persisted only (see {@link syncMedusaToggleSettings}),
 *   and `resolveMedusaToggleState` never reports `wake.drifted` from a
 *   runtime signal the way it does for `enabled`.
 * - `syncMedusaToggleSettings` returns the next persisted values only; it
 *   never writes them. `lib/projects.js`'s existing `updateProject` write
 *   path (`projConfig.medusaEnabled = updates.medusaEnabled`) is the one
 *   place that reaches disk, and stays that way — this module never
 *   duplicates it.
 *
 * @module lib/medusa-toggle-sync
 */

/**
 * One toggle's persisted value, the value callers should actually act on,
 * and whether a live runtime signal disagrees with it right now.
 * @typedef {{persistedValue: boolean, effectiveValue: boolean, drifted: boolean}} ToggleState
 */

/**
 * Reconcile the PM Medusa toggles against their persisted project settings.
 * `effectiveValue` is always exactly `persistedValue` -- never optimistically
 * `true` because something is listening right now, and never optimistically
 * `false` because nothing is. `drifted` is the separate, explicit signal a
 * caller (a dashboard banner, an incident trace) uses to say "this is
 * running opposite to what is saved" without ever treating that as license
 * to trust the runtime state instead.
 * @param {object} params
 * @param {boolean} [params.persistedEnabled] - `project.json`'s `medusaEnabled`, read by the caller.
 * @param {boolean} [params.persistedWake] - `project.json`'s `medusaWake`, read by the caller.
 * @param {boolean} [params.runtimeListening] - Whether a switchboard listener is
 *   actually active for this project right now (e.g. a per-session toggle, or an
 *   auto-started one) -- any truthy/falsy signal the caller already observed.
 *   Omitted (not merely `false`) means "unobserved": `drifted` is reported `false`
 *   rather than guessed, since "no live listener" and "never checked" must not
 *   read the same.
 * @returns {{enabled: ToggleState, wake: ToggleState}}
 */
function resolveMedusaToggleState({ persistedEnabled, persistedWake, runtimeListening } = {}) {
  const persistedEnabledBool = persistedEnabled === true;
  const persistedWakeBool = persistedWake === true;
  const enabled = {
    persistedValue: persistedEnabledBool,
    effectiveValue: persistedEnabledBool,
    drifted: runtimeListening === undefined ? false : persistedEnabledBool !== Boolean(runtimeListening)
  };
  const wake = {
    persistedValue: persistedWakeBool,
    effectiveValue: persistedWakeBool,
    drifted: false
  };
  return { enabled, wake };
}

/**
 * Apply a settings-modal save request's desired Medusa toggle values onto
 * the project's CURRENT persisted values, validating each provided key and
 * leaving an omitted one unchanged -- never silently flipping a setting the
 * caller did not actually ask to change. Returns the new persisted values to
 * write; the write itself is the caller's own job (see the module doc
 * comment's "zero duplication" note).
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}} current - The project's
 *   current persisted values, as already read by the caller.
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}} updates - The desired
 *   new values; a key omitted here leaves `current`'s value for it unchanged.
 * @returns {{medusaEnabled: boolean, medusaWake: boolean}}
 * @throws {Error} When a provided key's value is not a boolean.
 */
function syncMedusaToggleSettings(current = {}, updates = {}) {
  const next = {
    medusaEnabled: current.medusaEnabled === true,
    medusaWake: current.medusaWake === true
  };
  for (const key of ['medusaEnabled', 'medusaWake']) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    if (typeof updates[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean, got ${JSON.stringify(updates[key])}`);
    }
    next[key] = updates[key];
  }
  return next;
}

module.exports = {
  resolveMedusaToggleState,
  syncMedusaToggleSettings
};
