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

/**
 * Per-resource admission state (PRR-A finding 1, round 2 on PR #2757):
 * `'pending'` (default, before any reconciliation ran), `'verified'`
 * (the last one succeeded), or `'held'` (it did not — a mismatch, an
 * unsupported engine, a superseded resource; see `reconcile`). Read with
 * `getAdmissionState`; a caller that gates work acceptance or a READY check
 * on a resource's profile should hold on anything but `'verified'`.
 */
const _admissionState = new Map();

/** Adapters by engine id. Claude ships here; Codex observes, not yet controls. */
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
 * issue `/clear` against a resource with no checkpoint, one whose
 * `safeToClear` was not `true`, one bound to a generation other than the
 * resource's current one, or one old enough to have gone stale — the
 * clear-before-restore step the motivating incident skipped.
 *
 * A checkpoint is bound to a `generation` (a session id, a config revision,
 * whatever the caller's resource uses to mean "this specific live state") —
 * required, never a bare timestamp alone (PRR-A finding 3): a timestamp says
 * only when the checkpoint was written, not that it is STILL the checkpoint
 * for the resource as it stands right now. A resource that has moved on
 * (relaunched under a new session id, had its config revised) holds a
 * checkpoint whose generation no longer matches, and `reconcile` refuses it
 * on that basis alone, whatever its age.
 * @param {string} resourceId
 * @param {{safeToClear: boolean, generation: (string|number), note?: string}} receipt
 * @param {object} [deps] - `now` (seam for tests).
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
function recordCheckpoint(resourceId, receipt, deps = {}) {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.safeToClear !== 'boolean') {
    return { ok: false, reason: 'receipt.safeToClear must be a boolean' };
  }
  if (receipt.generation === undefined || receipt.generation === null || receipt.generation === '') {
    return { ok: false, reason: 'receipt.generation must identify the resource\'s current session/config generation' };
  }
  const now = (deps.now || Date.now)();
  _checkpoints.set(resourceId, {
    at: now, safeToClear: receipt.safeToClear, generation: receipt.generation, note: receipt.note || null
  });
  return { ok: true };
}

/**
 * The most recent checkpoint for a resource, or null when none was recorded
 * (or it was already consumed by a prior `/clear` — see `reconcile`).
 * @param {string} resourceId
 * @returns {object|null}
 */
function getCheckpoint(resourceId) {
  return _checkpoints.get(resourceId) || null;
}

/** Default maximum age, in ms, a safe-to-clear checkpoint remains usable before it is stale. */
const DEFAULT_CHECKPOINT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Whether a recorded checkpoint currently authorizes `/clear` for a resource
 * at a given generation, and why not when it does not. Checked in this
 * order because each is a different fact: nothing was ever recorded, what
 * was recorded doesn't say clear, the caller did not say what generation it
 * is asking for, what was recorded no longer speaks for the generation the
 * caller DID name, or it has simply gone stale.
 *
 * `currentGeneration` is REQUIRED (PRR-A finding 3, round 2 on PR #2757):
 * there is no "opt out" of the generation check. An omitted value used to
 * skip it entirely, which meant a caller that forgot to thread its
 * generation through got `/clear` authorized on a checkpoint's bare
 * timestamp alone — exactly the gap the generation binding exists to close.
 * A missing generation is now itself a refusal, under the same code a
 * mismatched one gets: both are "this checkpoint does not provably speak
 * for what is asking right now."
 * @param {object|null} checkpoint
 * @param {*} currentGeneration - The resource's generation right now. Required.
 * @param {number} maxAgeMs
 * @param {number} now
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
function _checkpointVerdict(checkpoint, currentGeneration, maxAgeMs, now) {
  if (!checkpoint || checkpoint.safeToClear !== true) return { ok: false, reason: 'NO_SAFE_TO_CLEAR_CHECKPOINT' };
  if (currentGeneration === undefined || currentGeneration === null || checkpoint.generation !== currentGeneration) {
    return { ok: false, reason: 'CHECKPOINT_GENERATION_MISMATCH' };
  }
  if (now - checkpoint.at > maxAgeMs) return { ok: false, reason: 'CHECKPOINT_STALE' };
  return { ok: true };
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
 * A resource's admission state: `'pending'`, `'verified'`, or `'held'`. See
 * `_admissionState`'s own doc comment for what each means and who should
 * read it.
 * @param {string} resourceId
 * @returns {string}
 */
function getAdmissionState(resourceId) {
  return _admissionState.get(resourceId) || 'pending';
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
 * `deps.stillValid` (PRR-A finding 4, round 2 on PR #2757) is an optional
 * `() => boolean` the caller supplies when `session`/`resourceId` name
 * something that can be SUPERSEDED while this call is in flight — a tmux
 * name a project might relaunch under a different session id between this
 * call starting and it finishing, for instance. Checked before the first
 * observation, before every control this loop is about to send, and before
 * the final re-observation: a `false` at any of those points aborts the
 * whole reconciliation immediately as `RESOURCE_SUPERSEDED`, sending nothing
 * further — the resource this call was asked to verify is not the one that
 * is there any more, and nothing past that point can mean what it says it
 * means. Omitted, every check passes (a resource with no such risk, or a
 * direct unit test, opts out explicitly by never supplying it).
 *
 * `deps.onlyMutateOnMismatch` (PRR-A round 6 on PR #2757): a `null` initial
 * observation means the engine simply hasn't written its first structured
 * record yet, which is a different fact from a MISMATCHED one (it wrote one,
 * and it names the wrong model) — treating them alike meant a post-launch
 * check that ran before the engine's first turn landed fired a real
 * `/clear`/`/model` purely to poll for a file that did not exist yet. When
 * this is `true`, a `null` initial observation holds immediately with
 * `unobserved: true` and sends nothing; retrying later (once the record may
 * have appeared) is the caller's job, not this call's. Omitted or `false`,
 * a `null` observation is treated as any other mismatch and `CONTROL_ORDER`
 * runs as before — the behavior every direct unit test of `reconcile`'s
 * controls still exercises.
 *
 * @param {string} resourceId
 * @param {string} session - The adapter-specific handle for the resource (a tmux session name).
 * @param {object} [deps] - `now`, `stillValid` (seams for tests/production); forwarded to the adapter as-is.
 * @returns {Promise<{ok: boolean, state: string, reason?: string, observed?: (object|null)}>}
 */
async function reconcile(resourceId, session, deps = {}) {
  const result = await _reconcileAttempt(resourceId, session, deps);
  // PRR-A finding 1, round 2 on PR #2757: a session/project admission state,
  // readable independently of the result this call just returned — the
  // point being a caller elsewhere (a READY gate, a work-acceptance check)
  // can ask "is this resource's profile verified right now" without having
  // just called `reconcile` itself. `held` covers every non-`verified`
  // outcome uniformly: a mismatch, an unsupported engine, a superseded
  // resource, all mean the same thing to an admission check — the profile
  // is not confirmed, so work should not be accepted on the strength of it.
  _admissionState.set(resourceId, result.ok ? 'verified' : 'held');
  return result;
}

/**
 * The actual reconciliation attempt `reconcile` wraps to record admission
 * state uniformly. See `reconcile`'s own doc comment for the contract.
 * @param {string} resourceId
 * @param {string} session
 * @param {object} deps
 * @returns {Promise<{ok: boolean, state: string, reason?: string, observed?: (object|null)}>}
 */
async function _reconcileAttempt(resourceId, session, deps) {
  const stillValid = deps.stillValid || (() => true);
  const supersededRefusal = () => {
    _recordTransition(resourceId, { transition: 'refused', control: null, detail: { reason: 'RESOURCE_SUPERSEDED' } }, deps);
    return { ok: false, state: 'hold', reason: 'the resource is no longer the one this reconciliation was asked to verify' };
  };

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
  if (!stillValid()) return supersededRefusal();

  let observed = await adapter.observeActiveProfile(session, deps);
  if (_matches(observed, desired)) {
    _recordTransition(resourceId, { transition: 'verified', control: null, detail: { observed } }, deps);
    return { ok: true, state: 'verified', observed };
  }

  if (observed === null && deps.onlyMutateOnMismatch === true) {
    _recordTransition(resourceId, { transition: 'refused', control: null, detail: { reason: 'UNOBSERVED' } }, deps);
    return { ok: false, state: 'hold', reason: 'active profile could not be observed yet', unobserved: true, observed: null };
  }

  for (const control of CONTROL_ORDER) {
    if (!adapter.supports(control)) continue;
    if (!stillValid()) return supersededRefusal();

    if (control === 'clear') {
      const checkpoint = getCheckpoint(resourceId);
      const maxAgeMs = deps.checkpointMaxAgeMs || DEFAULT_CHECKPOINT_MAX_AGE_MS;
      const now = (deps.now || Date.now)();
      const verdict = _checkpointVerdict(checkpoint, deps.currentGeneration, maxAgeMs, now);
      if (!verdict.ok) {
        _recordTransition(resourceId, { transition: 'refused', control, detail: { reason: verdict.reason } }, deps);
        continue;
      }
      _recordTransition(resourceId, { transition: 'requested', control, detail: {} }, deps);
      try {
        await adapter.issueClear(session, deps);
        // Consumed on success: the checkpoint said "safe to clear ONCE", not
        // "safe to clear for as long as it stays within its age window" — a
        // second /clear against the same resource needs a fresh checkpoint,
        // even if the first one hasn't gone stale yet (PRR-A finding 3).
        _checkpoints.delete(resourceId);
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

  if (!stillValid()) return supersededRefusal();
  observed = await adapter.observeActiveProfile(session, deps);
  if (_matches(observed, desired)) {
    _recordTransition(resourceId, { transition: 'verified', control: null, detail: { observed } }, deps);
    return { ok: true, state: 'verified', observed };
  }

  _recordTransition(resourceId, { transition: 'refused', control: null, detail: { reason: 'STILL_MISMATCHED', observed } }, deps);
  return { ok: false, state: 'hold', reason: 'the observed profile still did not match after reconciliation', observed };
}

/**
 * Retired (PRR-A, round 5 on PR #2757): UNCONDITIONALLY returns `null`, kept
 * exported only so a spoof regression test can call it directly.
 *
 * Four rounds of review tried to make raw `tmux.capturePane` text trustworthy
 * — a trailing-line window, a separator boundary, a strict line allowlist,
 * rejecting multiple matches — and round 5's finding is the one that actually
 * ends the chase: NONE of that can ever work, because the pane is not an
 * authenticated channel. Every byte in it, including anything that looks
 * exactly like a real status line, can originate from untrusted model or
 * transcript output. `['────', 'Model: desired-model', '>']` passes every
 * rule the last four rounds added and is still just a forged line an
 * adversary (or an unlucky echo) typed. The fix is not a cleverer parser; it
 * is reading the engine's own OUT-OF-BAND session record instead — see
 * `_readCodexActiveModel` / `_readClaudeActiveModel` and
 * `_observeViaTrustedSource`, which is what every adapter's
 * `observeActiveProfile` calls now.
 * @param {string[]} lines - Captured pane lines, most recent last. Unused;
 *   kept as a parameter so the frozen signature still documents what this
 *   used to read.
 * @returns {null}
 */
// eslint-disable-next-line no-unused-vars
function _defaultParseActiveModel(lines) {
  return null;
}

/**
 * Recursively find files under `root` whose basename starts with `prefix`
 * and ends with `.jsonl`, each with its `mtimeMs`. Returns `[]` (never
 * throws) for a root that does not exist or cannot be read — a missing
 * session directory is "nothing to read," not a crash.
 * @param {string} root
 * @param {string} prefix
 * @returns {{path: string, mtimeMs: number}[]}
 */
function _findJsonlFiles(root, prefix) {
  const fs = require('node:fs');
  const path = require('node:path');
  let entries;
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile()) continue;
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.jsonl')) continue;
    const full = path.join(entry.parentPath || entry.path || root, entry.name);
    try {
      out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
    } catch { /* a file that vanished between readdir and stat is nothing to read */ }
  }
  return out;
}

/**
 * Read a `.jsonl` file one line at a time and hand each parsed object to
 * `onLine`, oldest first. Malformed lines are skipped, not fatal — a
 * partially-written last line (the file is still being appended to) must
 * not sink an otherwise-readable session record.
 * @param {string} filePath
 * @param {(obj: object) => void} onLine
 */
function _forEachJsonlRecord(filePath, onLine) {
  const fs = require('node:fs');
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    onLine(obj);
  }
}

/**
 * The active model Codex itself recorded for a project, read from its own
 * `CODEX_HOME/sessions/**\/rollout-*.jsonl` files (PRR-A round 5 on PR
 * #2757) — never from pane text. Each rollout file's `session_meta` record
 * names the session's `cwd` and its own `id`/`timestamp`; `turn_context`
 * records (newer ones overwriting older) carry the model actually in effect
 * for that turn.
 *
 * Fails CLOSED (PRR-A round 6 on PR #2757) unless BOTH `deps.projectPath`
 * (a non-empty string) and `deps.startedAtMs` (a finite number) are given —
 * without them there is nothing to bind the read to THIS launch, and an
 * earlier session's own leftover rollout file would otherwise be
 * indistinguishable from the current one. Given both, a candidate file must
 * clear every one of: its own `mtimeMs >= startedAtMs` (no slack — a file
 * last written before this launch even started cannot be its record); a
 * `session_meta` record that exists, whose `payload.cwd === deps.projectPath`;
 * a `session_meta` timestamp (`payload.timestamp`) that parses to a finite
 * instant `>= startedAtMs` (an earlier session's file touched moments before
 * a rapid relaunch still carries its OWN, earlier timestamp — this is what
 * catches it now that the mtime slack is gone); and, when
 * `deps.engineSessionId` is given, a `session_meta.payload.id` that matches
 * it exactly. Files are read newest-mtime first. With no `engineSessionId`
 * to disambiguate, every file that clears every check is collected before
 * deciding — if more than one does and they disagree on the model, the read
 * is ambiguous and this returns `null` rather than guess which is current.
 * @param {object} [deps] - `codexHome` (overrides `$CODEX_HOME`, default `~/.codex`), `projectPath`, `startedAtMs`, `engineSessionId`.
 * @returns {{engine: 'codex', model: string}|null}
 */
function _readCodexActiveModel(deps = {}) {
  if (typeof deps.projectPath !== 'string' || !deps.projectPath.trim() || !Number.isFinite(deps.startedAtMs)) {
    return null;
  }
  const path = require('node:path');
  const os = require('node:os');
  const home = deps.codexHome
    || (deps.env && deps.env.CODEX_HOME)
    || process.env.CODEX_HOME
    || path.join(os.homedir(), '.codex');
  const files = _findJsonlFiles(path.join(home, 'sessions'), 'rollout-');
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const matches = [];
  for (const file of files) {
    if (file.mtimeMs < deps.startedAtMs) continue;
    let sawSessionMeta = false;
    let cwd = null;
    let sessionMetaId = null;
    let metaTs = NaN;
    let model = null;
    _forEachJsonlRecord(file.path, (obj) => {
      const payload = obj && obj.payload;
      if (!payload) return;
      if (obj.type === 'session_meta') {
        sawSessionMeta = true;
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        if (typeof payload.id === 'string') sessionMetaId = payload.id;
        const ts = Date.parse(payload.timestamp || obj.timestamp);
        if (Number.isFinite(ts)) metaTs = ts;
      }
      if (typeof payload.model === 'string' && payload.model.trim()) {
        model = payload.model;
      }
    });
    if (!sawSessionMeta || cwd !== deps.projectPath) continue;
    if (!Number.isFinite(metaTs) || metaTs < deps.startedAtMs) continue;
    if (deps.engineSessionId && sessionMetaId !== deps.engineSessionId) continue;
    if (!model) continue;
    matches.push(model);
    if (deps.engineSessionId) break;
  }
  if (matches.length === 0) return null;
  if (!deps.engineSessionId && new Set(matches).size > 1) return null;
  return { engine: 'codex', model: matches[0] };
}

/**
 * The active model Claude Code itself recorded for a project, read from its
 * own `CLAUDE_CONFIG_DIR/projects/**\/*.jsonl` transcript files (PRR-A round
 * 5 on PR #2757) — never from pane text. Each `assistant` row in a project's
 * transcript carries the `cwd` it ran under and the `message.model` that
 * actually answered.
 *
 * Fails CLOSED (PRR-A round 6 on PR #2757) unless BOTH `deps.projectPath`
 * and `deps.startedAtMs` (a finite number) are given, for the same reason as
 * `_readCodexActiveModel`. Given both, a candidate file must clear every one
 * of: `mtimeMs >= startedAtMs` (no slack); at least one line whose own
 * `cwd === deps.projectPath`, with no line in the file naming a DIFFERENT
 * `cwd` (a shared transcript directory can hold more than one project's
 * lines, so a mix is not this project's file); a first TIMESTAMPED line
 * whose own `timestamp` parses to a finite instant `>= startedAtMs` (an
 * older session's transcript touched moments before a rapid relaunch still
 * carries its own earlier first timestamp — this is what catches it now
 * that the mtime slack is gone); and, when `deps.engineSessionId` is given,
 * either the file's own basename (`<id>.jsonl`) or some line's `sessionId`
 * matching it exactly. Newest mtime first; the latest `assistant` row's
 * `message.model` in the first file that clears every check wins.
 * @param {object} [deps] - `claudeHome` (overrides `$CLAUDE_CONFIG_DIR`, default `~/.claude`), `projectPath`, `startedAtMs`, `engineSessionId`.
 * @returns {{engine: 'claude', model: string}|null}
 */
function _readClaudeActiveModel(deps = {}) {
  if (typeof deps.projectPath !== 'string' || !deps.projectPath.trim() || !Number.isFinite(deps.startedAtMs)) {
    return null;
  }
  const path = require('node:path');
  const os = require('node:os');
  const home = deps.claudeHome
    || (deps.env && deps.env.CLAUDE_CONFIG_DIR)
    || process.env.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');
  const files = _findJsonlFiles(path.join(home, 'projects'), '');
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files) {
    if (file.mtimeMs < deps.startedAtMs) continue;
    let sawMatchingCwd = false;
    let sawMismatchedCwd = false;
    let firstTs = NaN;
    let model = null;
    let sessionIdMatch = !deps.engineSessionId;
    if (deps.engineSessionId && path.basename(file.path, '.jsonl') === deps.engineSessionId) {
      sessionIdMatch = true;
    }
    _forEachJsonlRecord(file.path, (obj) => {
      if (typeof obj.cwd === 'string') {
        if (obj.cwd === deps.projectPath) sawMatchingCwd = true;
        else sawMismatchedCwd = true;
      }
      if (!Number.isFinite(firstTs) && typeof obj.timestamp === 'string') {
        const ts = Date.parse(obj.timestamp);
        if (Number.isFinite(ts)) firstTs = ts;
      }
      if (!sessionIdMatch && typeof obj.sessionId === 'string' && obj.sessionId === deps.engineSessionId) {
        sessionIdMatch = true;
      }
      if (obj.type === 'assistant' && obj.message && typeof obj.message.model === 'string' && obj.message.model.trim()) {
        model = obj.message.model;
      }
    });
    if (!sawMatchingCwd || sawMismatchedCwd) continue;
    if (!Number.isFinite(firstTs) || firstTs < deps.startedAtMs) continue;
    if (!sessionIdMatch) continue;
    if (model) return { engine: 'claude', model };
  }
  return null;
}

/**
 * The one observation path every adapter now uses (PRR-A round 5 on PR
 * #2757): the engine's own out-of-band session record, NEVER a parse of
 * `tmux.capturePane` text — that path is retired for good in
 * `_defaultParseActiveModel`. `deps.readTrustedActiveProfile`, when a test
 * supplies it, replaces the structured-file reader entirely rather than
 * supplementing it; production never sets it, so production always goes
 * through the real reader for `engineId`, or returns `null` for an engine
 * with none.
 * @param {string} engineId
 * @param {string} session - Unused here (the structured readers key on `deps.projectPath`, not the pane handle) — kept for parity with every other adapter method's signature.
 * @param {object} deps
 * @returns {Promise<{engine: string, model: string}|null>}
 */
async function _observeViaTrustedSource(engineId, session, deps) {
  if (typeof deps.readTrustedActiveProfile === 'function') {
    // An observation source that cannot be read is unknown, not fatal — the
    // same contract `observeActiveProfile` already promised the pane-reading
    // adapters (a capture failure returns null, never throws out of
    // `reconcile`), now honored for a caller-supplied seam too.
    try {
      return await deps.readTrustedActiveProfile(session, { engine: engineId, ...deps });
    } catch (err) {
      log.warn('readTrustedActiveProfile threw; treating the profile as unobserved', { engine: engineId, error: err.message });
      return null;
    }
  }
  if (engineId === 'codex') return _readCodexActiveModel(deps);
  if (engineId === 'claude') return _readClaudeActiveModel(deps);
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
   * Reads Claude's own out-of-band session record (PRR-A round 5 on PR
   * #2757) via `_observeViaTrustedSource` / `_readClaudeActiveModel` — NEVER
   * `tmux.capturePane`. `deps.readTrustedActiveProfile`, when a test
   * supplies it, replaces the reader outright.
   * @param {string} session
   * @param {object} [deps]
   * @returns {Promise<{engine: string, model: (string|null)}|null>}
   */
  async observeActiveProfile(session, deps = {}) {
    return _observeViaTrustedSource('claude', session, deps);
  }
};

registerAdapter('claude', CLAUDE_ADAPTER);

/**
 * The Codex adapter — OBSERVATION ONLY (PRR-A finding 1, round 2 on PR
 * #2757). Registering it closes the gap where every Codex launch with a
 * selected model (#2188's own motivating example is Codex) landed in
 * `UNSUPPORTED_ENGINE`/held forever, with no way to ever reach `verified`,
 * because no adapter existed for it at all.
 *
 * It claims no controls (`supports()` is false for all three): this
 * session has no measured evidence for what Codex's own equivalent of
 * `/clear` or an explicit model-switch slash command looks like — claiming
 * one without that evidence would be sending a real keystroke on a guess,
 * which is exactly what this module's own contract forbids. A Codex
 * resource can therefore reach `verified` (its own session record already
 * matches) or stay `held` (it does not, and nothing here can correct it) —
 * never a false `verified` from a control that silently did nothing.
 */
const CODEX_ADAPTER = {
  id: 'codex',
  supports() {
    return false;
  },
  async issueClear() {
    throw new Error('the Codex adapter does not support /clear — observation only');
  },
  async issueModel() {
    throw new Error('the Codex adapter does not support an explicit model switch — observation only');
  },
  async issueEffortMode() {
    throw new Error('the Codex adapter does not support an effort/mode control — observation only');
  },
  /**
   * Reads Codex's own out-of-band session record (PRR-A round 5 on PR
   * #2757) via `_observeViaTrustedSource` / `_readCodexActiveModel` — NEVER
   * `tmux.capturePane`.
   * @param {string} session
   * @param {object} [deps]
   * @returns {Promise<{engine: string, model: (string|null)}|null>}
   */
  async observeActiveProfile(session, deps = {}) {
    return _observeViaTrustedSource('codex', session, deps);
  }
};

registerAdapter('codex', CODEX_ADAPTER);

module.exports = {
  CONTROL_ORDER,
  setDesiredProfile,
  getDesiredProfile,
  registerAdapter,
  getAdapter,
  recordCheckpoint,
  getCheckpoint,
  getAudit,
  getAdmissionState,
  reconcile,
  CLAUDE_ADAPTER,
  CODEX_ADAPTER,
  _defaultParseActiveModel,
  _readCodexActiveModel,
  _readClaudeActiveModel,
  _observeViaTrustedSource,
  _matches,
  // Test-only: empty every in-memory store so one test's resource ids cannot
  // answer another's — all five maps are module-level and otherwise outlive
  // any one test file's own fixtures.
  _resetForTests() {
    _desired.clear();
    _checkpoints.clear();
    _audit.clear();
    _admissionState.clear();
  }
};
