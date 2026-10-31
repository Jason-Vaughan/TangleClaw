'use strict';

/**
 * Session Profile Reconciler (#1967).
 *
 * Motivating incident: during the #1957 security audit, a `[cyber]` safeguard
 * forced a fallback from one model to another, and the attempted restoration
 * back to the original model failed silently and unverified — a state-drift
 * capability gap nobody caught until after the fact.
 *
 * This module answers one question for one resource (a tmux session, a pane,
 * anything an adapter can observe and control): is the profile actually
 * running the one that was asked for, and if not, can it be brought back
 * without guessing? It never assumes success. An observation it cannot make
 * sense of, a control an adapter does not support, or a reconciliation that
 * still does not match afterward all fail CLOSED — a held resource, not a
 * resource treated as fine because nothing threw.
 *
 * Design choices the required contract calls for directly:
 * - Desired profile is stored per resource (`setDesiredProfile`), never a
 *   module-wide default. A resource nobody has set a profile for is UNKNOWN,
 *   not "the default" — there is no default.
 * - A `/clear` is never issued without a fresh safe-to-clear checkpoint
 *   recorded for that resource first (`recordCheckpoint`).
 * - Controls are tried in the declared, fixed order — `/clear`, then an
 *   explicit `/model <id>` argument, then effort/mode — and only the ones an
 *   adapter's `supports()` admits. Nothing here ever navigates an interactive
 *   menu by sending arrow keys or guessed keystrokes; every control is one
 *   direct, explicit command.
 * - Every transition (`requested`, `applied`, `verified`, `refused`) is
 *   appended to an audit log, per resource, in order.
 * - No API key, token, or other secret is read anywhere in this file. Every
 *   adapter acts only through what it can send to and read from the pane.
 *
 * Out of scope here (deferred, not dropped): wiring this into an actual wrap
 * or launch pipeline, and a Codex/Gemini adapter. Only the Claude adapter
 * ships in this version, per the issue's own "Claude adapter first,
 * extensible to Codex/Gemini" contract.
 */

const { createLogger } = require('./logger');

const log = createLogger('profile-reconciler');

/**
 * The controls a reconciliation may try, in the fixed order the contract
 * requires: a full reset first, then telling the engine explicitly what to
 * run, then the finer-grained effort/mode knob. An adapter that supports
 * fewer than all three is asked only for the ones it supports; the ones it
 * doesn't are never attempted and never silently skipped without an audit
 * entry saying so.
 * @type {string[]}
 */
const CONTROL_ORDER = ['clear', 'explicitModel', 'effortMode'];

/** Desired profile per resource. `resourceId -> {engine, model, effort?, mode?}`. */
const _desired = new Map();

/** The latest safe-to-clear checkpoint per resource. `resourceId -> {at, safeToClear, note}`. */
const _checkpoints = new Map();

/** Append-only per-resource audit log. `resourceId -> Array<entry>`. */
const _audit = new Map();

/** Adapters by engine id. Claude ships here; Codex/Gemini register later. */
const _adapters = new Map();

/**
 * Whether a value is a usable desired-profile shape.
 * @param {*} profile
 * @returns {string|null} A problem sentence, or null when the shape is fine.
 */
function _profileProblem(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return 'profile must be an object';
  }
  if (typeof profile.engine !== 'string' || !profile.engine.trim()) {
    return 'profile.engine must be a non-empty string';
  }
  if (profile.model !== undefined && profile.model !== null
    && (typeof profile.model !== 'string' || !profile.model.trim())) {
    return 'profile.model must be a non-empty string or null';
  }
  if (profile.effort !== undefined && profile.effort !== null && typeof profile.effort !== 'string') {
    return 'profile.effort must be a string or null';
  }
  if (profile.mode !== undefined && profile.mode !== null && typeof profile.mode !== 'string') {
    return 'profile.mode must be a string or null';
  }
  return null;
}

/**
 * Record the profile a resource is supposed to be running. Per resource —
 * setting one resource's desired profile never implies anything about any
 * other resource's.
 * @param {string} resourceId
 * @param {{engine: string, model?: (string|null), effort?: (string|null), mode?: (string|null)}} profile
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
function setDesiredProfile(resourceId, profile) {
  if (typeof resourceId !== 'string' || !resourceId.trim()) {
    return { ok: false, reason: 'resourceId must be a non-empty string' };
  }
  const problem = _profileProblem(profile);
  if (problem) return { ok: false, reason: problem };
  _desired.set(resourceId, { engine: profile.engine, model: profile.model || null, effort: profile.effort || null, mode: profile.mode || null });
  return { ok: true };
}

/**
 * The desired profile for a resource, or null when none was ever set.
 * @param {string} resourceId
 * @returns {object|null}
 */
function getDesiredProfile(resourceId) {
  return _desired.get(resourceId) || null;
}

/**
 * Register (or replace) the control adapter for an engine id.
 * @param {string} engineId
 * @param {object} adapter - See `CLAUDE_ADAPTER` for the shape every adapter must implement.
 */
function registerAdapter(engineId, adapter) {
  _adapters.set(engineId, adapter);
}

/**
 * The adapter registered for an engine id, or null.
 * @param {string} engineId
 * @returns {object|null}
 */
function getAdapter(engineId) {
  return _adapters.get(engineId) || null;
}

/**
 * Record a safe-to-clear checkpoint for a resource. `reconcile` refuses to
 * issue `/clear` against a resource with no checkpoint, or one whose
 * `safeToClear` was not `true` — the clear-before-restore step the
 * motivating incident skipped.
 * @param {string} resourceId
 * @param {{safeToClear: boolean, note?: string}} receipt
 * @param {object} [deps] - `now` (seam for tests).
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
function recordCheckpoint(resourceId, receipt, deps = {}) {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.safeToClear !== 'boolean') {
    return { ok: false, reason: 'receipt.safeToClear must be a boolean' };
  }
  const now = (deps.now || Date.now)();
  _checkpoints.set(resourceId, { at: now, safeToClear: receipt.safeToClear, note: receipt.note || null });
  return { ok: true };
}

/**
 * The most recent checkpoint for a resource, or null when none was recorded.
 * @param {string} resourceId
 * @returns {object|null}
 */
function getCheckpoint(resourceId) {
  return _checkpoints.get(resourceId) || null;
}

/**
 * Append one transition to a resource's audit log.
 * @param {string} resourceId
 * @param {{transition: string, control: (string|null), detail: object}} entry
 * @param {object} [deps] - `now` (seam for tests).
 */
function _recordTransition(resourceId, entry, deps = {}) {
  const now = (deps.now || Date.now)();
  const list = _audit.get(resourceId) || [];
  list.push({ at: now, ...entry });
  _audit.set(resourceId, list);
  log.info('Profile reconciler transition', { resourceId, ...entry });
}

/**
 * The audit log for a resource, oldest first. A copy — callers cannot mutate
 * the recorded history.
 * @param {string} resourceId
 * @returns {object[]}
 */
function getAudit(resourceId) {
  return (_audit.get(resourceId) || []).slice();
}

/**
 * Whether an observed profile matches a desired one. `model`/`effort`/`mode`
 * compare only the fields the desired profile actually names (undefined/null
 * in `desired` is "don't care" for that field) — but `engine` always compares,
 * because a profile for the wrong engine is never a match whatever else lines up.
 * @param {object|null} observed
 * @param {object} desired
 * @returns {boolean}
 */
function _matches(observed, desired) {
  if (!observed) return false;
  if (observed.engine !== desired.engine) return false;
  for (const field of ['model', 'effort', 'mode']) {
    if (desired[field] && observed[field] !== desired[field]) return false;
  }
  return true;
}

/**
 * Reconcile one resource's running profile against its desired one.
 *
 * Order of operations, matching the required contract:
 * 1. A resource with no desired profile, or no registered adapter for the
 *    desired engine, is refused outright — there is no default to fall back to.
 * 2. The CURRENT profile is observed before anything is dispatched. A match
 *    is reported `verified` with nothing sent to the pane.
 * 3. On a mismatch (or an observation the adapter could not make sense of),
 *    each control in `CONTROL_ORDER` the adapter supports is tried in order:
 *    `clear` only when a fresh `safeToClear: true` checkpoint is on record,
 *    then `explicitModel` with the desired model id as a literal argument,
 *    then `effortMode`. Every attempt is `requested` before it is sent and
 *    `applied` or `refused` after.
 * 4. After the attempted controls, the profile is observed again. A match is
 *    `verified`; anything else is `refused` and the resource comes back
 *    `hold: true` — fail closed, never a guess that it probably worked.
 *
 * @param {string} resourceId
 * @param {string} session - The adapter-specific handle for the resource (a tmux session name).
 * @param {object} [deps] - `now` (seam for tests); forwarded to the adapter as-is.
 * @returns {Promise<{ok: boolean, state: string, reason?: string, observed?: (object|null)}>}
 */
async function reconcile(resourceId, session, deps = {}) {
  const desired = getDesiredProfile(resourceId);
  if (!desired) {
    _recordTransition(resourceId, { transition: 'refused', control: null, detail: { reason: 'NO_DESIRED_PROFILE' } }, deps);
    return { ok: false, state: 'hold', reason: 'no desired profile is on record for this resource' };
  }
  const adapter = getAdapter(desired.engine);
  if (!adapter) {
    _recordTransition(resourceId, { transition: 'refused', control: null, detail: { reason: 'UNSUPPORTED_ENGINE', engine: desired.engine } }, deps);
    return { ok: false, state: 'hold', reason: `no control adapter is registered for engine "${desired.engine}"` };
  }

  let observed = await adapter.observeActiveProfile(session, deps);
  if (_matches(observed, desired)) {
    _recordTransition(resourceId, { transition: 'verified', control: null, detail: { observed } }, deps);
    return { ok: true, state: 'verified', observed };
  }

  for (const control of CONTROL_ORDER) {
    if (!adapter.supports(control)) continue;

    if (control === 'clear') {
      const checkpoint = getCheckpoint(resourceId);
      if (!checkpoint || checkpoint.safeToClear !== true) {
        _recordTransition(resourceId, { transition: 'refused', control, detail: { reason: 'NO_SAFE_TO_CLEAR_CHECKPOINT' } }, deps);
        continue;
      }
      _recordTransition(resourceId, { transition: 'requested', control, detail: {} }, deps);
      try {
        await adapter.issueClear(session, deps);
        _recordTransition(resourceId, { transition: 'applied', control, detail: {} }, deps);
      } catch (err) {
        _recordTransition(resourceId, { transition: 'refused', control, detail: { reason: 'ADAPTER_ERROR', error: err.message } }, deps);
      }
      continue;
    }

    if (control === 'explicitModel') {
      if (!desired.model) continue;
      _recordTransition(resourceId, { transition: 'requested', control, detail: { model: desired.model } }, deps);
      try {
        await adapter.issueModel(session, desired.model, deps);
        _recordTransition(resourceId, { transition: 'applied', control, detail: { model: desired.model } }, deps);
      } catch (err) {
        _recordTransition(resourceId, { transition: 'refused', control, detail: { reason: 'ADAPTER_ERROR', error: err.message } }, deps);
      }
      continue;
    }

    // effortMode
    if (!desired.effort && !desired.mode) continue;
    _recordTransition(resourceId, { transition: 'requested', control, detail: { effort: desired.effort, mode: desired.mode } }, deps);
    try {
      await adapter.issueEffortMode(session, { effort: desired.effort, mode: desired.mode }, deps);
      _recordTransition(resourceId, { transition: 'applied', control, detail: { effort: desired.effort, mode: desired.mode } }, deps);
    } catch (err) {
      _recordTransition(resourceId, { transition: 'refused', control, detail: { reason: 'ADAPTER_ERROR', error: err.message } }, deps);
    }
  }

  observed = await adapter.observeActiveProfile(session, deps);
  if (_matches(observed, desired)) {
    _recordTransition(resourceId, { transition: 'verified', control: null, detail: { observed } }, deps);
    return { ok: true, state: 'verified', observed };
  }

  _recordTransition(resourceId, { transition: 'refused', control: null, detail: { reason: 'STILL_MISMATCHED', observed } }, deps);
  return { ok: false, state: 'hold', reason: 'the observed profile still did not match after reconciliation', observed };
}

/**
 * Default, best-effort parser for a captured pane's text into an active
 * profile. This is intentionally conservative: it would rather report
 * `null` (unknown) than guess, because a false positive here is exactly the
 * "restoration looked fine but wasn't" failure #1967 exists to end. Pending
 * confirmation of each adapter's actual banner text, a caller with a precise
 * reader should pass `deps.parseActiveProfile(lines) -> profile|null` to
 * `observeActiveProfile` rather than rely on this default.
 * @param {string[]} lines - Captured pane lines, most recent last.
 * @returns {{model: (string|null)}|null}
 */
function _defaultParseActiveModel(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^\s*Model:\s*(\S+)\s*$/i.exec(lines[i]);
    if (m) return { model: m[1] };
  }
  return null;
}

/**
 * The Claude adapter (first implementation; the required contract names it
 * "Claude adapter first, extensible to Codex/Gemini"). Acts only through
 * `deps.tmux` (defaulting to the real `./tmux`) sending literal, explicit
 * commands — never a guessed keystroke or menu navigation.
 */
const CLAUDE_ADAPTER = {
  id: 'claude',

  /**
   * @param {string} control - One of `CONTROL_ORDER`.
   * @returns {boolean}
   */
  supports(control) {
    // Claude Code's effort/mode controls are not a single explicit
    // slash-command argument the way `/model <id>` is (#2188's own sibling
    // work is still settling what that argument looks like) — so this
    // adapter claims only the two controls it can issue as one direct,
    // unambiguous command today. Claiming effortMode before that is settled
    // would be a control this module pretends to have.
    return control === 'clear' || control === 'explicitModel';
  },

  /**
   * @param {string} session
   * @param {object} [deps]
   */
  async issueClear(session, deps = {}) {
    const tmux = deps.tmux || require('./tmux');
    tmux.sendKeys(session, '/clear', { engineId: 'claude' });
  },

  /**
   * @param {string} session
   * @param {string} modelId - Sent verbatim as `/model`'s explicit argument — never through a picker.
   * @param {object} [deps]
   */
  async issueModel(session, modelId, deps = {}) {
    const tmux = deps.tmux || require('./tmux');
    tmux.sendKeys(session, `/model ${modelId}`, { engineId: 'claude' });
  },

  /**
   * Not yet supported — see `supports()`. Throwing here (rather than being
   * reachable at all) would be unreachable in practice since `reconcile`
   * checks `supports()` first, but a direct caller gets a clear refusal
   * rather than a silent no-op.
   * @param {string} session
   * @param {{effort: (string|null), mode: (string|null)}} target
   * @param {object} [deps]
   */
  async issueEffortMode(session, target, deps = {}) {
    throw new Error('the Claude adapter does not yet support an effort/mode control');
  },

  /**
   * Read back what the pane actually shows, never what was last sent.
   * `deps.parseActiveProfile(lines)` overrides the default best-effort
   * parser; both can return null (unknown), which `reconcile` treats as a
   * mismatch, never as a pass.
   * @param {string} session
   * @param {object} [deps]
   * @returns {Promise<{engine: string, model: (string|null)}|null>}
   */
  async observeActiveProfile(session, deps = {}) {
    const tmux = deps.tmux || require('./tmux');
    let lines;
    try {
      ({ lines } = tmux.capturePane(session, { lines: 200 }));
    } catch (err) {
      log.warn('Could not capture the pane to observe the active profile', { session, error: err.message });
      return null;
    }
    const parse = deps.parseActiveProfile || _defaultParseActiveModel;
    const parsed = parse(lines);
    if (!parsed || !parsed.model) return null;
    return { engine: 'claude', model: parsed.model };
  }
};

registerAdapter('claude', CLAUDE_ADAPTER);

module.exports = {
  CONTROL_ORDER,
  setDesiredProfile,
  getDesiredProfile,
  registerAdapter,
  getAdapter,
  recordCheckpoint,
  getCheckpoint,
  getAudit,
  reconcile,
  CLAUDE_ADAPTER,
  _defaultParseActiveModel,
  _matches,
  // Test-only: empty every in-memory store so one test's resource ids cannot
  // answer another's — all four maps are module-level and otherwise outlive
  // any one test file's own fixtures.
  _resetForTests() {
    _desired.clear();
    _checkpoints.clear();
    _audit.clear();
  }
};
