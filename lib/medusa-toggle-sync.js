'use strict';

/**
 * PM Medusa Toggle State Reconciliation (#1677 Slice 1, v5.61.0 Car 61-C,
 * Architect Ruling A1677 + its Completion Addendum, `#issuecomment-6611205452`).
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
 * an unsaved modal draft, or any other transient signal is reported as a
 * fact about the MOMENT -- `drifted` / `driftReasons` -- never substituted
 * for the persisted value as if it were more current. Nothing here ever
 * reports an effective value of `true` for a project whose persisted
 * setting is `false`, no matter what is happening at runtime, or what an
 * unsaved form currently shows, right now.
 *
 * **Two call shapes, by design.** The completion addendum prescribes a
 * richer object-input contract (`resolveMedusaToggleState({persistedConfig,
 * runtimeListener, draftForm})`); the original Slice 1 build (before the
 * addendum landed) shipped a narrower flat-argument one
 * (`resolveMedusaToggleState({persistedEnabled, persistedWake,
 * runtimeListening})`), already covered by its own tests. Per dispatch,
 * both stay callable under the SAME exported name -- detected by which
 * keys the single input object carries -- so neither the addendum's
 * prescribed shape nor the original one's existing callers/tests need to
 * change. `_v1`/`_v2` name which contract each implements internally; a
 * caller never sees those suffixes.
 *
 * **Vetoable interpretive choice (the addendum does not spell this out
 * explicitly)**: `effectiveEnabled`/`effectiveWake` stay pinned to
 * `persistedEnabled`/`persistedWake` always, exactly as `effectiveValue`
 * did in the original contract -- the PM's own earlier approval of that
 * invariant ("effectiveValue is always exactly the persisted value") is
 * read as still governing, since letting a live listener or an unsaved
 * draft substitute for the persisted value is the exact incident #1677
 * exists to prevent. `sessionOverrideActive`/`drifted`/`driftReasons` are
 * the separate, explicit signals for everything that disagrees with it.
 *
 * **Scoping notes carried over from the original build**:
 * - This module is pure: no `fs`/`store` reads, no network calls. The
 *   caller supplies the already-read persisted values and the already-
 *   observed runtime signal (e.g. `medusa.getStatus(sessionId).state !==
 *   'off'`, the same check `lib/coordinator-rotation.js`'s own `listening`
 *   seam already uses) — this module is the reconciliation LOGIC, not
 *   another reader of either source.
 * - Wiring a real caller (the settings modal's own DOM, the dashboard
 *   banner) through it is explicitly a later slice (the addendum's own
 *   "Slice 2 Follow-Up", Milestone #51), same discipline #1350 Slice 1
 *   applied to its own async I/O primitive.
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
 * The original (pre-addendum) flat-argument contract, kept verbatim for its
 * existing callers/tests. See the module doc comment's "two call shapes."
 * @param {object} params
 * @param {boolean} [params.persistedEnabled]
 * @param {boolean} [params.persistedWake]
 * @param {boolean} [params.runtimeListening]
 * @returns {{enabled: ToggleState, wake: ToggleState}}
 */
function _resolveMedusaToggleStateV1({ persistedEnabled, persistedWake, runtimeListening } = {}) {
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
 * The addendum-prescribed contract (`#issuecomment-6611205452`): distinguishes
 * a persisted project opt-in from a temporary per-session runtime listener
 * override AND an unsaved settings-modal draft, in one flat result shape.
 * @param {object} params
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}} [params.persistedConfig] -
 *   `.tangleclaw/project.json` as already read by the caller.
 * @param {{enabled?: boolean}} [params.runtimeListener] - Whether a switchboard
 *   listener is actually active for this project right now (a per-session
 *   toggle, or an auto-started one) -- any signal the caller already observed.
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}} [params.draftForm] -
 *   Unsaved settings-modal input, not yet persisted via {@link syncMedusaToggleSettings}.
 * @returns {{persistedEnabled: boolean, persistedWake: boolean, effectiveEnabled: boolean,
 *   effectiveWake: boolean, sessionOverrideActive: boolean, drifted: boolean, driftReasons: string[]}}
 */
function _resolveMedusaToggleStateV2({ persistedConfig, runtimeListener, draftForm } = {}) {
  const persistedEnabled = Boolean(persistedConfig && persistedConfig.medusaEnabled === true);
  const persistedWake = Boolean(persistedConfig && persistedConfig.medusaWake === true);
  // Distinguish "never observed" (runtimeListener omitted entirely) from an
  // EXPLICIT observation of either value -- I-Gate Round 2 (#5757487201):
  // the opposite mismatch (persisted true, an explicitly observed
  // enabled:false) must drift too, which an "absent reads the same as
  // false" check would silently miss.
  const runtimeObserved = Boolean(runtimeListener) && typeof runtimeListener === 'object'
    && Object.prototype.hasOwnProperty.call(runtimeListener, 'enabled');
  const runtimeActive = runtimeObserved && runtimeListener.enabled === true;
  // A listener running despite NOT being persisted-enabled is the override
  // #1677's own incident describes; one running because it IS persisted-on
  // is just ordinary operation, not an override of anything.
  const sessionOverrideActive = runtimeObserved && runtimeActive && !persistedEnabled;
  // The opposite direction: persisted says on, but an explicitly observed
  // listener reports off. Not an "override" (nothing is incorrectly
  // running) -- still a real saved-versus-live disagreement that must
  // surface, the same as the original flat API already reported it.
  const listenerStoppedWhilePersistedEnabled = runtimeObserved && !runtimeActive && persistedEnabled;

  const driftReasons = [];
  if (sessionOverrideActive) driftReasons.push('session-override-enabled');
  if (listenerStoppedWhilePersistedEnabled) driftReasons.push('listener-off-while-persisted-enabled');
  if (draftForm && Object.prototype.hasOwnProperty.call(draftForm, 'medusaEnabled')
    && draftForm.medusaEnabled !== persistedEnabled) driftReasons.push('draft-unsaved-enabled');
  if (draftForm && Object.prototype.hasOwnProperty.call(draftForm, 'medusaWake')
    && draftForm.medusaWake !== persistedWake) driftReasons.push('draft-unsaved-wake');

  return {
    persistedEnabled,
    persistedWake,
    // Never optimistic: the effective value is always exactly the persisted
    // one, whatever a live listener or an unsaved draft currently shows --
    // see the module doc comment's vetoable interpretive choice.
    effectiveEnabled: persistedEnabled,
    effectiveWake: persistedWake,
    sessionOverrideActive,
    drifted: driftReasons.length > 0,
    driftReasons
  };
}

/**
 * Reconcile the PM Medusa toggles against their persisted project settings.
 * Accepts either call shape (see the module doc comment); dispatches on
 * which keys the single input object carries.
 * @param {object} [input]
 * @returns {{enabled: ToggleState, wake: ToggleState}|{persistedEnabled: boolean, persistedWake: boolean, effectiveEnabled: boolean, effectiveWake: boolean, sessionOverrideActive: boolean, drifted: boolean, driftReasons: string[]}}
 */
function resolveMedusaToggleState(input = {}) {
  if (input && typeof input === 'object'
    && ('persistedConfig' in input || 'runtimeListener' in input || 'draftForm' in input)) {
    return _resolveMedusaToggleStateV2(input);
  }
  return _resolveMedusaToggleStateV1(input);
}

/**
 * The original (pre-addendum) two-positional-argument contract, kept
 * verbatim for its existing callers/tests.
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}} current
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}} updates
 * @returns {{medusaEnabled: boolean, medusaWake: boolean}}
 */
function _syncMedusaToggleSettingsV1(current = {}, updates = {}) {
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

/**
 * Apply a settings-modal save request's desired Medusa toggle values onto
 * the project's CURRENT persisted values, validating each provided key and
 * leaving an omitted one unchanged -- never silently flipping a setting the
 * caller did not actually ask to change. Returns the new persisted values to
 * write; the write itself is the caller's own job (see the module doc
 * comment's "zero duplication" note). Accepts either call shape (see the
 * module doc comment).
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}|{persistedConfig?: object, patch?: object}} current -
 *   Either the current persisted values directly (original contract), or
 *   `{persistedConfig, patch}` (addendum contract).
 * @param {{medusaEnabled?: boolean, medusaWake?: boolean}} [updates] - Required
 *   with the original two-argument contract; omitted with the addendum one.
 * @returns {{medusaEnabled: boolean, medusaWake: boolean}}
 * @throws {Error} When a provided key's value is not a boolean.
 */
function syncMedusaToggleSettings(current = {}, updates = {}) {
  if (current && typeof current === 'object' && ('persistedConfig' in current || 'patch' in current)) {
    return _syncMedusaToggleSettingsV1(current.persistedConfig, current.patch);
  }
  return _syncMedusaToggleSettingsV1(current, updates);
}

module.exports = {
  resolveMedusaToggleState,
  syncMedusaToggleSettings
};
