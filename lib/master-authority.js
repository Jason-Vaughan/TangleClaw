'use strict';

/**
 * Project Master's scoped API token and fleet-mutation authority contract
 * (#966), and the exact lifecycle-action set its lifecycle authority toggle
 * (#2132) covers.
 *
 * Successor to #755: that issue gave the Master a file-write access-level
 * tier (`read-only`/`suggest`/`write`, `lib/master.js#MASTER_ACCESS_LEVELS`),
 * enforced structurally on Claude by a local `PreToolUse` guard. That
 * mechanism bounds file writes under the Master's own home; it has no
 * reach into TangleClaw's own API, so it cannot be the boundary for
 * fleet-mutation authority on any engine. This module is that boundary:
 * a scoped bearer token (`tc_master_` prefix, mirroring
 * `lib/service-token.js`'s AUTH-4 pattern exactly — generation, storage,
 * constant-time verification) PLUS the capability allowlist it may ever
 * cover.
 *
 * Deliberately narrow (#2132 acceptance criterion 6): this gate covers
 * exactly the session-lifecycle action set below — register/provision,
 * launch/relaunch/rebind, stop/kill, clear/wrap/drain/retire, and a
 * session's own lease issue/release — never "every mutating endpoint"
 * generically. `tc bridge` writes are explicitly out of scope
 * (`lib/master.js#MASTER_BRIDGE_EXCEPTION` already names that exemption in
 * prose; this gate's own allowlist simply never lists a bridge action, so
 * the exemption holds by omission, not by a second rule that could drift
 * from the first); they stay governed by the existing bridge credential and
 * bridge-enabled rules.
 *
 * **Ruling A491-W1B-R2 (unifying #2132's binary toggle with #966's 3-tier
 * `accessLevel` on one canonical axis):** there is exactly ONE stored
 * value, `config.master.accessLevel` (`lib/master.js#MASTER_ACCESS_LEVELS`,
 * already `#755`'s own field) — never a second, independently-stored
 * toggle that could disagree with it. `toggleState` is DERIVED from it,
 * deterministically (`toggleStateFor`): `'write'` → `'read-write'`;
 * `'read-only'` and `'suggest'` both → `'read-only'` (`'suggest'` is the
 * per-tool-call file-edit confirmation tier — it never grants standing
 * fleet-lifecycle mutation). An Operator transition may name either the
 * 3-tier `accessLevel` or the binary `toggleState`; `applyOperatorAuthorityChange`
 * accepts both and refuses if they disagree, rather than silently picking
 * one.
 *
 * This module exposes helpers only — no HTTP route. Wiring a fleet-mutation
 * route and the `PATCH /api/config` fields that set these values is
 * `server.js`/`lib/routes/*` work, out of this dispatch's file envelope by
 * design (a later wave, W2-A). Every helper here that changes state
 * (`applyOperatorAuthorityChange`) TRUSTS the caller about who is asking,
 * the same way `lib/control-state.js` documents its own trust boundary:
 * resolving a request to a verified Operator principal is the HTTP layer's
 * job. Call it only after that verification — never from a path a
 * non-Operator caller, including Project Master itself, can reach
 * (#2132 acceptance criterion 2).
 *
 * @module lib/master-authority
 */

const crypto = require('node:crypto');
const store = require('./store');
const { MASTER_ACCESS_LEVELS, masterSettings } = require('./master');

/**
 * Prefix on every generated token — distinct from `lib/service-token.js`'s
 * `tcsk_` (the general fleet M2M token) so the two credentials are never
 * confusable in a log or a config diff, and a reader can tell at a glance
 * which boundary a leaked token would have crossed.
 * @type {string}
 */
const TOKEN_PREFIX = 'tc_master_';

/**
 * The exact action set the lifecycle authority gate covers (#2132
 * acceptance criterion 6, `rule-185-project-master-draft.md` §3's table).
 * Closed on purpose: `isLifecycleAction` is the only way code elsewhere
 * should ask "is this one of the gated actions," so the set can only grow
 * by editing it here, visibly, rather than by a caller assuming its own
 * action belongs.
 * @type {ReadonlyArray<string>}
 */
const LIFECYCLE_ACTIONS = Object.freeze([
  'register', 'provision',
  'launch', 'relaunch', 'rebind',
  'stop', 'kill',
  'clear', 'wrap', 'drain', 'retire',
  'lease-issue', 'lease-release'
]);

/**
 * Whether `action` is one of the exact actions the lifecycle authority gate
 * covers. A caller outside `LIFECYCLE_ACTIONS` is never gated by this
 * module — it is simply not this gate's business, by design (criterion 6).
 * @param {*} action
 * @returns {boolean}
 */
function isLifecycleAction(action) {
  return LIFECYCLE_ACTIONS.includes(action);
}

/**
 * The deterministic mapping Ruling A491-W1B-R2 fixes between the 3-tier
 * `accessLevel` and the binary lifecycle `toggleState`. `'write'` is the
 * only tier that grants standing fleet-lifecycle mutation; `'suggest'`
 * reads as `'read-only'` here on purpose — it is the per-tool-call
 * file-edit confirmation tier, never a standing fleet-mutation grant.
 * @param {string} accessLevel - One of `MASTER_ACCESS_LEVELS`.
 * @returns {'read-only'|'read-write'}
 */
function toggleStateFor(accessLevel) {
  return accessLevel === 'write' ? 'read-write' : 'read-only';
}

/**
 * Read the canonical lifecycle-authority state — the single source of
 * truth `checkLifecycleAuthority`/`evaluateLifecycleCall` evaluate fresh on
 * every call. Never throws: an absent, unreadable, malformed or ambiguous
 * `config.master.accessLevel` resolves to `'read-only'` (via
 * `masterSettings`, `lib/master.js`'s own existing fail-closed default),
 * which this function's `toggleStateFor` then reads as `'read-only'` too —
 * satisfying #2132 acceptance criterion 5 by construction, with no special
 * case needed here for "ambiguous state."
 *
 * **`toggleState` additionally requires a COMPLETE recorded transition**
 * (PRR-B BLOCKING C1/C5, round 2): `accessLevel === 'write'` alone is not
 * sufficient, and neither is `lifecycleGeneration` alone — round 1's fix
 * checked only the generation, which a config carrying `accessLevel:
 * 'write', lifecycleGeneration: 1` with no `lifecycleUpdatedAt`/
 * `lifecycleUpdatedBy` could still pass, despite there being no actual
 * evidence of who made the change or when. The pre-#966 `PATCH
 * /api/config` (`lib/routes/config.js`) can already set
 * `config.master.accessLevel = 'write'` directly, with no
 * `lifecycleGeneration` write at all — bypassing `applyOperatorAuthorityChange`
 * entirely, which is this module's only audited, generation-tracked path.
 * Treating a partial record as a legitimate grant would let a caller reach
 * `read-write` with no complete Operator transition ever recorded — the
 * "no toggle to flip, verify, or audit" gap #2132 exists to close. So
 * `toggleState` reads `'read-write'` only when ALL THREE of
 * `lifecycleGeneration` (a positive integer), `lifecycleUpdatedAt` and
 * `lifecycleUpdatedBy` (non-blank strings) are present together; any one
 * missing or malformed reads the WHOLE record as never transitioned
 * (`generation: 0`, `updatedAt`/`updatedBy`: `null`) rather than trusting
 * the fields that do look valid in isolation.
 * @param {object|null} config - A FRESHLY loaded config
 *   (`store.config.load()`). Atomicity (#2132 acceptance criterion 3) is
 *   the caller's responsibility: call this immediately before deciding,
 *   never against a config loaded earlier in the request or cached across
 *   requests.
 * @returns {{accessLevel: string, toggleState: 'read-only'|'read-write', generation: number, updatedAt: string|null, updatedBy: string|null}}
 */
function getAuthorityState(config) {
  const accessLevel = masterSettings(config).accessLevel;
  const raw = (config && typeof config.master === 'object' && config.master) || {};
  const hasRecordedTransition = Number.isInteger(raw.lifecycleGeneration) && raw.lifecycleGeneration >= 1
    && typeof raw.lifecycleUpdatedAt === 'string' && raw.lifecycleUpdatedAt.trim() !== ''
    && typeof raw.lifecycleUpdatedBy === 'string' && raw.lifecycleUpdatedBy.trim() !== '';
  return {
    accessLevel,
    toggleState: (accessLevel === 'write' && hasRecordedTransition) ? 'read-write' : 'read-only',
    generation: hasRecordedTransition ? raw.lifecycleGeneration : 0,
    updatedAt: hasRecordedTransition ? raw.lifecycleUpdatedAt : null,
    updatedBy: hasRecordedTransition ? raw.lifecycleUpdatedBy : null
  };
}

/**
 * Apply an OPERATOR-authorized lifecycle-authority transition: advances the
 * generation, records who and when, and writes the one audit receipt for
 * this change (#2132 acceptance criteria 2 and 4). The caller — the HTTP
 * layer, not this module — must have already verified the request really
 * is the authenticated Operator; this function trusts that verification
 * completely and enforces nothing about identity itself (see the module
 * header). It is the ONLY function in this module that may move
 * `accessLevel`/the generation forward; nothing else here writes to
 * `config.master` at all.
 *
 * Accepts either the 3-tier `accessLevel` or the binary `toggleState` (not
 * both disagreeing) per Ruling A491-W1B-R2 — a caller that already knows
 * which it has need not translate it first, but a caller supplying BOTH is
 * refused rather than silently resolved one way, since that shape is
 * itself the sign of a confused caller.
 *
 * @param {object} config - Mutated in place; the caller persists it
 *   afterward (`store.config.save(config)`) — this function does not save.
 * @param {object} change
 * @param {string} [change.accessLevel] - One of `MASTER_ACCESS_LEVELS`.
 * @param {'read-only'|'read-write'} [change.toggleState]
 * @param {string} change.actor - Who authorized this (an operator
 *   identity string); recorded as `updatedBy`. Required — an authority
 *   change with no recorded "who" is exactly the gap this issue closes.
 * @returns {{accessLevel: string, toggleState: string, generation: number, updatedAt: string, updatedBy: string}}
 *   The new canonical state.
 * @throws {Error} `AUTHORITY_BAD_REQUEST` on a malformed or self-contradictory change.
 */
function applyOperatorAuthorityChange(config, change = {}) {
  const bad = (msg) => {
    const err = new Error(msg);
    err.code = 'AUTHORITY_BAD_REQUEST';
    throw err;
  };
  if (!config || typeof config !== 'object') bad('config is required');
  if (typeof change.actor !== 'string' || change.actor.trim() === '') {
    bad('actor is required to record who authorized this change');
  }

  let targetAccessLevel;
  if (change.accessLevel !== undefined) {
    if (!MASTER_ACCESS_LEVELS.includes(change.accessLevel)) {
      bad(`accessLevel must be one of ${MASTER_ACCESS_LEVELS.join(', ')}`);
    }
    targetAccessLevel = change.accessLevel;
  }
  if (change.toggleState !== undefined) {
    if (change.toggleState !== 'read-only' && change.toggleState !== 'read-write') {
      bad("toggleState must be 'read-only' or 'read-write'");
    }
    if (targetAccessLevel !== undefined) {
      // Compare DERIVED toggle states (`toggleStateFor`), never a raw
      // accessLevel string against a hand-mapped literal (PRR-B WARNING
      // C1): `'suggest'` and `'read-only'` both derive to `'read-only'`, so
      // `{accessLevel: 'suggest', toggleState: 'read-only'}` genuinely
      // agrees and must not be refused as a contradiction.
      if (toggleStateFor(targetAccessLevel) !== change.toggleState) {
        bad(`accessLevel "${targetAccessLevel}" (derives to "${toggleStateFor(targetAccessLevel)}") and toggleState "${change.toggleState}" disagree`);
      }
    } else {
      targetAccessLevel = change.toggleState === 'read-write' ? 'write' : 'read-only';
    }
  }
  if (targetAccessLevel === undefined) bad('accessLevel or toggleState is required');

  if (typeof config.master !== 'object' || config.master === null) config.master = {};

  // Advance from the RAW prior generation, not `getAuthorityState`'s
  // reported one — that function collapses "never set" and "present but
  // corrupted" to the same `0`, which is correct for a READER (both are
  // untrusted) but wrong for this WRITER: silently treating corrupted
  // input as "never set" would let the next generation regress below
  // whatever real value it replaced, breaking the monotonic guarantee
  // `expectedGeneration` checks depend on (PRR-B WARNING C1, round 2). A
  // genuinely absent value (fresh install, or #966's own path never run
  // yet) safely starts at 0; a VALID prior integer — even one the legacy
  // `PATCH /api/config` path left with no `updatedAt`/`updatedBy` — is
  // still a real generation to advance from; only a value that is present
  // but not a valid non-negative integer is actual corruption, and that
  // is refused outright rather than "repaired."
  const rawGeneration = config.master.lifecycleGeneration;
  let priorGeneration;
  if (rawGeneration === undefined) {
    priorGeneration = 0;
  } else if (Number.isInteger(rawGeneration) && rawGeneration >= 0) {
    priorGeneration = rawGeneration;
  } else {
    bad(`lifecycleGeneration is corrupted (${JSON.stringify(rawGeneration)}); refusing to advance a monotonic generation from it — repair it manually before retrying`);
  }
  const generation = priorGeneration + 1;
  const updatedAt = new Date().toISOString();
  config.master.accessLevel = targetAccessLevel;
  config.master.lifecycleGeneration = generation;
  config.master.lifecycleUpdatedAt = updatedAt;
  config.master.lifecycleUpdatedBy = change.actor;

  const next = getAuthorityState(config);
  recordAuthorityDecision({ ...next, action: 'operator-authority-change', decision: 'allow', reason: 'operator-transition', timestamp: updatedAt });
  return next;
}

/**
 * Generate a new high-entropy Master API token: `tc_master_` + 32 random
 * bytes base64url. Zero-dependency (node `crypto`), mirroring
 * `lib/service-token.js#generateToken` exactly.
 * @returns {string}
 */
function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Enforce the "enabled ⇒ token present" invariant on `config.master`, in
 * place — the Master-authority sibling of
 * `lib/service-token.js#ensureTokenWhenEnabled`. Stored under
 * `config.master.apiToken` (global `config.json`, never under the Master's
 * own home directory): the Master can write files under its home at the
 * `write` access-level tier, so a token stored there would be readable —
 * and rotatable — by the very principal it is meant to bound. Global
 * config is outside every path the Master's own write guard governs, which
 * is what satisfies #966's "token storage/rotation stays outside paths
 * writable by the Master home at the write tier" by construction, not by
 * new logic.
 * @param {object|null} config - Mutated in place when a token is generated.
 *   `config.master` is created if `config.master.apiTokenEnabled` is set on
 *   an object that does not yet have one — callers normally reach this
 *   through `store.config.load()`, which always returns an object.
 * @returns {boolean} `true` when a token was generated, else `false`.
 */
function ensureApiTokenWhenEnabled(config) {
  if (!config || typeof config.master !== 'object' || config.master === null) return false;
  const master = config.master;
  // Exact-type checks, not truthiness (PRR-B WARNING C5): a malformed
  // `apiTokenEnabled` (e.g. the string `'false'`, truthy in JS) must never
  // activate the gate, and anything that is not a genuinely usable token
  // (missing, not a string, or empty) is treated as absent and replaced —
  // never left in place just because it happened to be truthy.
  const hasUsableToken = typeof master.apiToken === 'string' && master.apiToken.length > 0;
  if (master.apiTokenEnabled === true && !hasUsableToken) {
    master.apiToken = generateToken();
    return true;
  }
  return false;
}

/**
 * Extract a bearer token from request headers. Identical to
 * `lib/service-token.js#_extractBearer`; kept as its own small copy rather
 * than a cross-module call, because the two gates must never be able to
 * drift into accepting each other's header shape by sharing code that
 * later changes for one gate's reason alone.
 * @param {object|null} headers - `req.headers` (keys lower-cased by Node).
 * @returns {string|null}
 */
function _extractBearer(headers) {
  if (!headers) return null;
  const raw = headers.authorization;
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return null;
  const token = raw.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time string equality, length-safe.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate a request's Master API token. Identity only — whether the
 * presented bearer token IS the Master's own token. Whether the action it
 * is attached to is actually permitted right now is a separate question
 * (the lifecycle authority check), never folded into this one: a reader
 * must be able to tell "wrong credential" apart from "right credential,
 * not currently authorized" from the result alone.
 *
 * Fail-closed, and deliberately the opposite default from
 * `lib/service-token.js#validateRequest`'s "gate off ⇒ allow": that gate
 * protects already-open local traffic, so turning it off restores a prior
 * open surface. This one IS the Master's only way to authenticate itself
 * for fleet mutation — gate off must mean "the Master has no credential,"
 * never "let it through unauthenticated."
 *
 * @param {object|null} headers - `req.headers`.
 * @param {object|null} config - Merged TC config; reads
 *   `config.master.apiTokenEnabled`/`apiToken` only.
 * @returns {{ok: true} | {ok: false, status: number, code: string, message: string}}
 */
function validateApiToken(headers, config) {
  const master = (config && typeof config.master === 'object' && config.master) || {};
  // Exact-type checks, not truthiness (PRR-B WARNING C5): a malformed
  // `apiTokenEnabled` (the string `'false'` is truthy in JS) must never
  // activate the gate, and a malformed `apiToken` (a number, an object)
  // must refuse cleanly here rather than reach `_safeEqual`, whose
  // `Buffer.from` would throw on a non-string — a 500 misconfiguration
  // refusal, never an uncaught exception.
  if (master.apiTokenEnabled !== true) {
    return {
      ok: false,
      status: 403,
      code: 'MASTER_API_TOKEN_DISABLED',
      message: 'The Master API token is not enabled for this install'
    };
  }
  if (typeof master.apiToken !== 'string' || master.apiToken.length === 0) {
    return {
      ok: false,
      status: 500,
      code: 'MASTER_API_TOKEN_MISCONFIGURED',
      message: 'The Master API token is enabled but no token is configured'
    };
  }
  const presented = _extractBearer(headers);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Missing or malformed Authorization: Bearer header'
    };
  }
  if (!_safeEqual(presented, master.apiToken)) {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_MASTER_API_TOKEN',
      message: 'Invalid Master API token'
    };
  }
  return { ok: true };
}

/**
 * Record an authority decision — an Operator state change, or an endpoint
 * allow/refuse verdict — against the exact state it was evaluated under
 * (#2132 acceptance criterion 4; shape fixed by Ruling A491-W1B-R2).
 * Never throws: `store.activity.log` swallows its own write failures, and
 * an audit write must never be the reason a lifecycle call itself fails.
 * @param {object} fields
 * @param {string} fields.accessLevel
 * @param {string} fields.toggleState
 * @param {number} fields.generation
 * @param {string} fields.action - The action evaluated, or
 *   `'operator-authority-change'` for an Operator transition.
 * @param {'allow'|'refuse'} fields.decision
 * @param {string} fields.reason - A short code, not free prose.
 * @param {string} fields.timestamp - ISO 8601.
 * @returns {void}
 */
function recordAuthorityDecision({ accessLevel, toggleState, generation, action, decision, reason, timestamp }) {
  store.activity.log({
    eventType: 'master.lifecycle-authority-decision',
    detail: { accessLevel, toggleState, generation, action, decision, reason, timestamp }
  });
}

/**
 * Evaluate whether a fleet-lifecycle call is authorized, right now — the
 * single entry point Ruling A491-W1B-R2 describes (#2132 acceptance
 * criteria 3, 5 and 6; #966). Composes token identity, generation
 * freshness and the toggle-state + capability allowlist into one verdict,
 * and writes exactly ONE audit receipt per call — never one per sub-check,
 * so a call's audit trail is never more decisions than were actually made.
 *
 * Checked in this order, each one short-circuiting the rest: (1) the
 * action must be one of `LIFECYCLE_ACTIONS` at all — scope comes before
 * identity, since an action outside the allowlist is refused the same way
 * whoever is asking; (2) the Master's bearer token must verify; (3) when
 * the caller supplies `expectedGeneration`, it must match the canonical
 * one exactly — a stale or mismatched generation is refused outright, not
 * rounded to "close enough"; (4) the canonical `toggleState` must be
 * `'read-write'`. Any absent, unreadable, malformed or ambiguous canonical
 * state already reads as `'read-only'` (see `getAuthorityState`), so step
 * (4) alone carries #2132 acceptance criterion 5's fail-closed guarantee —
 * no separate special case is needed for it.
 *
 * @param {object|null} config - A FRESHLY loaded config
 *   (`store.config.load()`), loaded by the CALLER immediately before this
 *   call. This function does not load it itself; the atomicity the ruling
 *   requires depends on the caller never passing a cached or stale config.
 * @param {object} call
 * @param {object|null} [call.headers] - `req.headers`, for the Master
 *   bearer token (`validateApiToken`).
 * @param {string} call.action - The action being attempted.
 * @param {number} [call.expectedGeneration] - The generation the caller
 *   believes current.
 * @returns {{allowed: boolean, status: number, code: string|null, reason: string, accessLevel: string, toggleState: string, generation: number}}
 */
function evaluateLifecycleCall(config, call = {}) {
  const { headers = null, action, expectedGeneration } = call;
  const state = getAuthorityState(config);
  const timestamp = new Date().toISOString();

  const refuse = (status, code, reason) => {
    recordAuthorityDecision({ ...state, action, decision: 'refuse', reason, timestamp });
    return { allowed: false, status, code, reason, ...state };
  };

  if (!isLifecycleAction(action)) {
    return refuse(400, 'AUTHORITY_ACTION_NOT_ALLOWLISTED', 'action-not-allowlisted');
  }

  const tokenCheck = validateApiToken(headers, config);
  if (!tokenCheck.ok) {
    return refuse(tokenCheck.status, tokenCheck.code, tokenCheck.code);
  }

  if (expectedGeneration !== undefined) {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration !== state.generation) {
      return refuse(409, 'AUTHORITY_GENERATION_STALE', 'generation-stale');
    }
  }

  if (state.toggleState !== 'read-write') {
    return refuse(403, 'AUTHORITY_READ_ONLY', 'read-only');
  }

  recordAuthorityDecision({ ...state, action, decision: 'allow', reason: 'ok', timestamp });
  return { allowed: true, status: 200, code: null, reason: 'ok', ...state };
}

module.exports = {
  TOKEN_PREFIX,
  LIFECYCLE_ACTIONS,
  isLifecycleAction,
  toggleStateFor,
  getAuthorityState,
  applyOperatorAuthorityChange,
  generateToken,
  ensureApiTokenWhenEnabled,
  validateApiToken,
  evaluateLifecycleCall
};
