'use strict';

/**
 * v6.1 (#2993, V6-23 / C4+D2, Car V61-W1-A): the Operator-ratified standing
 * model failover policy (C4) and confidence-qualified, quota-aware model
 * placement (D2).
 *
 * C4 reconciles #109 ("never auto-swap engines without explicit user
 * confirmation"), #2188 (`MODEL_UNCONFIRMED` refusal over silent fallback)
 * and #2598 (`lib/model-switch.js`'s `boundary` and `outage-takeover`
 * modes) the way the ADR 0008 reconciliation register (Domain 4) resolves
 * them: silent ad-hoc fallback stays forbidden, and only a STANDING policy an
 * Operator ratified ahead of time may execute a switch without asking.
 *
 *  - `mode: 'confirm'` (the default, and what a missing policy means): every
 *    trigger yields a confirmation card (`restart` / `switch` /
 *    `continue-manually`), never an automatic switch.
 *  - `mode: 'standing-policy'`: a routine trigger (`chunk-boundary`,
 *    `quota-threshold`) may auto-switch through #2598's `boundary` mode to a
 *    target on that role's ordered allowlist. A mid-chunk trigger
 *    (`provider-outage`, `session-crashed`) may auto-switch through
 *    `outage-takeover` (work preserved on `wip/*`) only for a Builder,
 *    Reviewer or Observer and only to a target on `allowedOutageFallbacks`.
 *    A Decider/Coordinator (PM, Architect, Orchestrator) outage escalates to
 *    the Operator unless the policy sets `allowAutonomousDeciderFailover`.
 *    A role this module does not know is always `confirm`.
 *
 * {@link decideFailover} only DECIDES. Executing the switch is
 * `lib/model-switch.js#switchSessionModel`'s job and mounting it is Wave 2
 * (`Car V61-W2-ROUTES`); this module never requires `model-switch` itself
 * (that would pull the store, tmux and Medusa into a pure policy evaluator),
 * so the caller injects `validateTarget` — in production,
 * `modelSwitch.validateSwitchTarget` — and every candidate must pass it plus
 * the role's capability floor before it can be chosen.
 *
 * D2 ports PRR-A's canonical P04 prototype (`lib/engine-catalog.js`
 * `resolveEngineCatalog`/`normalizeQuotaWindow`, and
 * `lib/model-placement-scheduler.js` `recommendPlacement`) from ESM to
 * CommonJS, and adds #2993's two placement modes: `recommend` (advice only)
 * and `auto` (applied only when the selected tuple is on the policy's
 * `allowedAutoPlacements` and its quota reading is not `unknown`; otherwise
 * it downgrades to a recommendation and says why). Per the v5.74.0
 * retrospective (T07), a quota reading carries its confidence
 * (`measured` / `calibrated` / `estimate`) and reset time, an `estimate`
 * weighs less than a measurement, and placement never optimizes on catalog
 * presence alone. The scoring weights are P04's illustrative constants and
 * still need calibrating against real workloads.
 *
 * Ratified policies and decision receipts persist in this module's own two
 * tables, created idempotently by {@link ensureSchema} (no `_schema.js`
 * edit — Charter A624 Wave 1 guardrail).
 *
 * @module lib/v6/c4-d2-failover-and-quota-placement
 */

const crypto = require('node:crypto');

/** Failover policy modes; `confirm` is the default posture. */
const FAILOVER_MODES = Object.freeze(['confirm', 'standing-policy']);
/** Triggers a routine boundary switch answers. */
const BOUNDARY_TRIGGERS = Object.freeze(['chunk-boundary', 'quota-threshold']);
/** Triggers a mid-chunk outage takeover answers. */
const OUTAGE_TRIGGERS = Object.freeze(['provider-outage', 'session-crashed']);
/** Roles an outage takeover may switch automatically under a standing policy. */
const WORKER_ROLES = Object.freeze(['Builder', 'Reviewer', 'Observer']);
/** Roles whose outage defaults to Operator confirmation (#2598 requirement 3). */
const DECIDER_ROLES = Object.freeze(['PM', 'Architect', 'Orchestrator']);
/** The confirmation card's options (ADR 0008 Domain 4, default posture). */
const CONFIRM_OPTIONS = Object.freeze(['restart', 'switch', 'continue-manually']);
/** D2 scoring strategies (P04). */
const PLACEMENT_STRATEGIES = Object.freeze(['quality', 'conservation', 'balanced', 'maximize-useful-allowance']);
/** D2 placement modes (#2993). */
const PLACEMENT_MODES = Object.freeze(['recommend', 'auto']);
/** Quota confidence levels, and how much each one counts (P04). */
const QUOTA_CONFIDENCE_WEIGHT = Object.freeze({ measured: 1, calibrated: 0.65, estimate: 0.25 });
/** Scopes a policy can be ratified at. */
const POLICY_SCOPES = Object.freeze(['project', 'fleet']);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Create this module's two tables. Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_c4_failover_policies (
      scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('project','fleet')),
      scope_id    TEXT NOT NULL,
      version     INTEGER NOT NULL CHECK (version >= 1),
      policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
      ratified_by TEXT NOT NULL,
      ratified_at TEXT NOT NULL,
      PRIMARY KEY (scope_kind, scope_id)
    );
    CREATE TABLE IF NOT EXISTS v6_c4_failover_receipts (
      id          TEXT PRIMARY KEY,
      project_id  INTEGER NOT NULL,
      session_id  TEXT,
      role        TEXT NOT NULL,
      trigger     TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      decision    TEXT NOT NULL CHECK (decision IN ('execute','confirm','escalate','refuse')),
      switch_mode TEXT CHECK (switch_mode IS NULL OR switch_mode IN ('boundary','outage-takeover')),
      from_json   TEXT NOT NULL CHECK (json_valid(from_json)),
      to_json     TEXT CHECK (to_json IS NULL OR json_valid(to_json)),
      policy_version INTEGER,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_v6_c4_receipts_project ON v6_c4_failover_receipts(project_id, recorded_at);
  `);
}

/**
 * Whether `t` is a well-formed `{engine, model, effort?}` tuple.
 * @param {*} t
 * @returns {boolean}
 */
function _isTuple(t) {
  return !!t && typeof t === 'object' && SAFE_ID.test(t.engine || '') && SAFE_ID.test(t.model || '')
    && (t.effort === undefined || t.effort === null || SAFE_ID.test(t.effort));
}

/**
 * The canonical comparable key for a tuple.
 * @param {{engine: string, model: string, effort?: string}} t
 * @returns {string}
 */
function _key(t) {
  return `${t.engine}/${t.model}/${t.effort || ''}`;
}

/**
 * Validate and normalize a failover policy. Unknown keys are refused, not
 * dropped, so a typo cannot silently weaken an Operator's intent.
 * @param {*} raw
 * @returns {{ok: true, policy: object} | {ok: false, code: string, detail?: string}}
 */
function validatePolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'POLICY_MALFORMED' };
  const allowed = new Set(['mode', 'allowedBoundaryTargets', 'allowedOutageFallbacks', 'allowAutonomousDeciderFailover', 'capabilityFloor', 'allowedAutoPlacements']);
  const extra = Object.keys(raw).filter((k) => !allowed.has(k));
  if (extra.length) return { ok: false, code: 'POLICY_UNKNOWN_KEY', detail: extra.join(',') };
  if (!FAILOVER_MODES.includes(raw.mode)) return { ok: false, code: 'POLICY_MODE_INVALID' };
  const boundary = raw.allowedBoundaryTargets ?? {};
  if (typeof boundary !== 'object' || Array.isArray(boundary)) return { ok: false, code: 'POLICY_MALFORMED', detail: 'allowedBoundaryTargets' };
  const allowedBoundaryTargets = {};
  for (const [role, list] of Object.entries(boundary)) {
    if (![...WORKER_ROLES, ...DECIDER_ROLES].includes(role)) return { ok: false, code: 'POLICY_UNKNOWN_ROLE', detail: role };
    if (!Array.isArray(list) || !list.every(_isTuple)) return { ok: false, code: 'POLICY_TARGET_MALFORMED', detail: role };
    allowedBoundaryTargets[role] = list.map((t) => ({ engine: t.engine, model: t.model, effort: t.effort ?? null }));
  }
  const outage = raw.allowedOutageFallbacks ?? [];
  if (!Array.isArray(outage)) return { ok: false, code: 'POLICY_MALFORMED', detail: 'allowedOutageFallbacks' };
  const allowedOutageFallbacks = [];
  for (const entry of outage) {
    if (!_isTuple(entry)) return { ok: false, code: 'POLICY_TARGET_MALFORMED', detail: 'allowedOutageFallbacks' };
    const roles = entry.roles ?? WORKER_ROLES;
    if (!Array.isArray(roles) || !roles.every((r) => WORKER_ROLES.includes(r) || DECIDER_ROLES.includes(r))) {
      return { ok: false, code: 'POLICY_UNKNOWN_ROLE', detail: 'allowedOutageFallbacks.roles' };
    }
    allowedOutageFallbacks.push({ engine: entry.engine, model: entry.model, effort: entry.effort ?? null, roles: [...roles] });
  }
  const floor = raw.capabilityFloor ?? {};
  if (typeof floor !== 'object' || Array.isArray(floor)) return { ok: false, code: 'POLICY_MALFORMED', detail: 'capabilityFloor' };
  const capabilityFloor = {};
  for (const [role, f] of Object.entries(floor)) {
    if (![...WORKER_ROLES, ...DECIDER_ROLES].includes(role)) return { ok: false, code: 'POLICY_UNKNOWN_ROLE', detail: role };
    if (!f || typeof f !== 'object' || (f.minQuality !== undefined && !Number.isFinite(f.minQuality))
      || (f.capabilities !== undefined && (!Array.isArray(f.capabilities) || !f.capabilities.every((c) => typeof c === 'string')))) {
      return { ok: false, code: 'POLICY_MALFORMED', detail: `capabilityFloor.${role}` };
    }
    capabilityFloor[role] = { minQuality: f.minQuality ?? 0, capabilities: [...(f.capabilities ?? [])] };
  }
  const auto = raw.allowedAutoPlacements ?? [];
  if (!Array.isArray(auto) || !auto.every(_isTuple)) return { ok: false, code: 'POLICY_TARGET_MALFORMED', detail: 'allowedAutoPlacements' };
  if (raw.allowAutonomousDeciderFailover !== undefined && typeof raw.allowAutonomousDeciderFailover !== 'boolean') {
    return { ok: false, code: 'POLICY_MALFORMED', detail: 'allowAutonomousDeciderFailover' };
  }
  return {
    ok: true,
    policy: {
      mode: raw.mode, allowedBoundaryTargets, allowedOutageFallbacks, capabilityFloor,
      allowedAutoPlacements: auto.map((t) => ({ engine: t.engine, model: t.model, effort: t.effort ?? null })),
      allowAutonomousDeciderFailover: raw.allowAutonomousDeciderFailover === true
    }
  };
}

/**
 * The legacy project ids a ratification at this scope governs: the project
 * itself, or every project registered as a resource of the fleet
 * (`v6_resources.fleet_id` + `legacy_project_id`, C1). Empty when none.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} scopeKind
 * @param {string} scopeId
 * @returns {number[]}
 */
function _governedProjects(db, scopeKind, scopeId) {
  if (scopeKind === 'project') {
    const id = Number(scopeId);
    return Number.isSafeInteger(id) && String(id) === scopeId ? [id] : [];
  }
  const hasResources = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'v6_resources'").get();
  if (!hasResources) return [];
  return db.prepare('SELECT DISTINCT legacy_project_id AS id FROM v6_resources WHERE fleet_id = ? AND legacy_project_id IS NOT NULL ORDER BY legacy_project_id')
    .all(scopeId).map((r) => r.id);
}

/**
 * Ratify (create or replace) a standing policy. Operator-only: the
 * principal must hold the same `project.writePolicy` authority
 * `lib/v6/authority-service.js` gates every other authority-bearing setting
 * behind on EVERY project the policy governs — the project itself, or every
 * member project of the fleet — so authority over one project can never
 * ratify a policy for another. A version CAS stops two concurrent
 * ratifications from silently overwriting each other.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{scopeKind: string, scopeId: (string|number), policy: object, expectedVersion: number,
 *   principalId: string, auth: {authorize: Function}, now?: Function}} args
 * @returns {{ok: boolean, code: string, version?: number, detail?: string}}
 */
function ratifyPolicy(db, { scopeKind, scopeId, policy, expectedVersion, principalId, auth, now = () => new Date().toISOString() }) {
  ensureSchema(db);
  if (!POLICY_SCOPES.includes(scopeKind) || scopeId === undefined || scopeId === null || String(scopeId) === '') return { ok: false, code: 'SCOPE_INVALID' };
  const governed = _governedProjects(db, scopeKind, String(scopeId));
  if (!governed.length) return { ok: false, code: scopeKind === 'fleet' ? 'FLEET_HAS_NO_MEMBER_PROJECTS' : 'SCOPE_INVALID' };
  for (const projectId of governed) {
    const verdict = auth?.authorize?.(principalId, 'project.writePolicy', { type: 'project', id: projectId });
    if (!verdict?.allowed) return { ok: false, code: verdict?.code || 'DEFAULT_DENY', detail: `project ${projectId}` };
  }
  const valid = validatePolicy(policy);
  if (!valid.ok) return valid;
  const current = db.prepare('SELECT version FROM v6_c4_failover_policies WHERE scope_kind = ? AND scope_id = ?').get(scopeKind, String(scopeId));
  const currentVersion = current?.version ?? 0;
  if (expectedVersion !== currentVersion) return { ok: false, code: 'VERSION_CONFLICT', version: currentVersion };
  const version = currentVersion + 1;
  const changed = db.prepare(
    'INSERT INTO v6_c4_failover_policies (scope_kind, scope_id, version, policy_json, ratified_by, ratified_at) VALUES (?,?,?,?,?,?) '
    + 'ON CONFLICT(scope_kind, scope_id) DO UPDATE SET version = excluded.version, policy_json = excluded.policy_json, '
    + 'ratified_by = excluded.ratified_by, ratified_at = excluded.ratified_at WHERE v6_c4_failover_policies.version = ?'
  ).run(scopeKind, String(scopeId), version, JSON.stringify(valid.policy), principalId, now(), currentVersion).changes;
  if (!changed) return { ok: false, code: 'VERSION_CONFLICT' };
  return { ok: true, code: 'RATIFIED', version };
}

/**
 * The effective policy for a project: its own if ratified, else its fleet's,
 * else none (which {@link decideFailover} treats as `confirm`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: (string|number), fleetId?: (string|number|null)}} args
 * @returns {{policy: object, version: number, scopeKind: string}|null}
 */
function getEffectivePolicy(db, { projectId, fleetId = null }) {
  ensureSchema(db);
  const read = (kind, id) => db.prepare('SELECT * FROM v6_c4_failover_policies WHERE scope_kind = ? AND scope_id = ?').get(kind, String(id));
  const row = read('project', projectId) || (fleetId !== null && fleetId !== undefined ? read('fleet', fleetId) : null);
  if (!row) return null;
  return { policy: JSON.parse(row.policy_json), version: row.version, scopeKind: row.scope_kind };
}

/**
 * Whether a candidate meets the role's capability floor. A candidate whose
 * quality/capabilities are unknown never meets a non-trivial floor.
 * @param {object} candidate - `{engine, model, quality?, capabilities?}`.
 * @param {{minQuality: number, capabilities: string[]}|undefined} floor
 * @returns {boolean}
 */
function _meetsFloor(candidate, floor) {
  if (!floor) return true;
  if (floor.minQuality > 0 && !(Number.isFinite(candidate.quality) && candidate.quality >= floor.minQuality)) return false;
  const caps = Array.isArray(candidate.capabilities) ? candidate.capabilities : [];
  return floor.capabilities.every((c) => caps.includes(c));
}

/**
 * Decide what to do about one trigger for one session. Pure: reads nothing,
 * writes nothing, executes nothing.
 * @param {object} args
 * @param {object|null} args.policy - A validated policy, or null (= confirm).
 * @param {string} args.role
 * @param {string} args.trigger - One of {@link BOUNDARY_TRIGGERS} / {@link OUTAGE_TRIGGERS}.
 * @param {{engine: string, model: string, effort?: string}} args.current
 * @param {Object<string, object>} [args.candidateFacts] - Per tuple key (`engine/model/effort`):
 *   `{quality, capabilities}` from fresh engine evidence.
 * @param {Function} args.validateTarget - `({engine, model}) => {ok, code}`; production passes
 *   `lib/model-switch.js#validateSwitchTarget`.
 * @returns {{decision: string, code: string, switchMode: (string|null), target: (object|null),
 *   options?: string[], rejected?: Array<{target: object, code: string}>}}
 */
function decideFailover({ policy, role, trigger, current, candidateFacts = {}, validateTarget }) {
  const isBoundary = BOUNDARY_TRIGGERS.includes(trigger);
  const isOutage = OUTAGE_TRIGGERS.includes(trigger);
  if (!isBoundary && !isOutage) return { decision: 'refuse', code: 'UNKNOWN_TRIGGER', switchMode: null, target: null };
  if (!_isTuple(current)) return { decision: 'refuse', code: 'CURRENT_MALFORMED', switchMode: null, target: null };
  const confirm = (code, extra = {}) => ({ decision: 'confirm', code, switchMode: null, target: null, options: [...CONFIRM_OPTIONS], ...extra });
  if (typeof validateTarget !== 'function') return confirm('NO_TARGET_VALIDATOR');
  if (!policy || policy.mode !== 'standing-policy') return confirm('CONFIRM_DEFAULT_POSTURE');
  const isWorker = WORKER_ROLES.includes(role);
  const isDecider = DECIDER_ROLES.includes(role);
  if (!isWorker && !isDecider) return confirm('ROLE_NOT_COVERED');

  let list;
  let switchMode;
  if (isBoundary) {
    list = policy.allowedBoundaryTargets?.[role] ?? [];
    switchMode = 'boundary';
  } else {
    if (isDecider && !policy.allowAutonomousDeciderFailover) {
      return { decision: 'escalate', code: 'DECIDER_OUTAGE_REQUIRES_OPERATOR', switchMode: null, target: null, options: [...CONFIRM_OPTIONS] };
    }
    list = (policy.allowedOutageFallbacks ?? []).filter((t) => (t.roles ?? WORKER_ROLES).includes(role));
    switchMode = 'outage-takeover';
  }

  const rejected = [];
  for (const raw of list) {
    const target = { engine: raw.engine, model: raw.model, effort: raw.effort ?? null };
    if (_key(target) === _key({ ...current, effort: current.effort ?? null })) continue;
    let check;
    try {
      check = validateTarget({ engine: target.engine, model: target.model });
    } catch {
      check = { ok: false, code: 'VALIDATOR_THREW' };
    }
    if (!check?.ok) { rejected.push({ target, code: check?.code || 'TARGET_INVALID' }); continue; }
    const facts = Object.prototype.hasOwnProperty.call(candidateFacts, _key(target)) ? candidateFacts[_key(target)] : {};
    if (!_meetsFloor(facts, policy.capabilityFloor?.[role])) { rejected.push({ target, code: 'BELOW_CAPABILITY_FLOOR' }); continue; }
    return { decision: 'execute', code: isBoundary ? 'STANDING_BOUNDARY_SWITCH' : 'STANDING_OUTAGE_TAKEOVER', switchMode, target, rejected };
  }
  return confirm('NO_ALLOWED_TARGET', { rejected });
}

/**
 * Record a durable receipt for a failover decision with its exact trigger
 * reason (ADR 0008 Domain 4, "Audit & Visibility").
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, sessionId?: (string|null), role: string, trigger: string, reasonCode: string,
 *   decision: object, from: object, policyVersion?: (number|null), now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function recordFailoverReceipt(db, { projectId, sessionId = null, role, trigger, reasonCode, decision, from, policyVersion = null, now = () => new Date().toISOString(), newId = () => crypto.randomUUID() }) {
  ensureSchema(db);
  if (!Number.isSafeInteger(projectId) || typeof role !== 'string' || typeof trigger !== 'string'
    || typeof reasonCode !== 'string' || !reasonCode.trim() || !decision || !_isTuple(from)) {
    return { ok: false, code: 'RECEIPT_INVALID' };
  }
  const id = newId();
  db.prepare(
    'INSERT INTO v6_c4_failover_receipts (id, project_id, session_id, role, trigger, reason_code, decision, switch_mode, from_json, to_json, policy_version, recorded_at) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, projectId, sessionId === null ? null : String(sessionId), role, trigger, reasonCode.trim(), decision.decision,
    decision.switchMode ?? null, JSON.stringify(from), decision.target ? JSON.stringify(decision.target) : null, policyVersion, now());
  return { ok: true, code: 'RECORDED', id };
}

/**
 * A project's failover receipts, newest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @param {{limit?: number}} [opts]
 * @returns {Array<object>}
 */
function listFailoverReceipts(db, projectId, { limit = 50 } = {}) {
  ensureSchema(db);
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  return db.prepare('SELECT * FROM v6_c4_failover_receipts WHERE project_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?').all(projectId, cap)
    .map((r) => ({
      id: r.id, projectId: r.project_id, sessionId: r.session_id, role: r.role, trigger: r.trigger, reasonCode: r.reason_code,
      decision: r.decision, switchMode: r.switch_mode, from: JSON.parse(r.from_json), to: r.to_json ? JSON.parse(r.to_json) : null,
      policyVersion: r.policy_version, recordedAt: r.recorded_at
    }));
}

// ── D2: engine catalog, quota windows, placement (P04) ──────────────────

/**
 * Join the supported engine list with the observed installed inventory.
 * @param {Array<{id: string}>} supported
 * @param {Array<{id: string, healthy: boolean, version?: string, observedAt?: number, expiresAt: number}>} installed
 * @param {number} now
 * @returns {Array<object>}
 */
function resolveEngineCatalog(supported, installed, now) {
  const installedById = new Map(installed.map((x) => [x.id, x]));
  const rows = supported.map((spec) => {
    const local = installedById.get(spec.id);
    const reason = !local ? 'NOT_INSTALLED' : !local.healthy ? 'UNHEALTHY' : !(local.expiresAt > now) ? 'STALE_INVENTORY' : null;
    return { ...spec, supported: true, installed: !!local, available: !reason, version: local?.version ?? null, observedAt: local?.observedAt ?? null, reason };
  });
  for (const x of installed) {
    if (!supported.some((s) => s.id === x.id)) rows.push({ id: x.id, supported: false, installed: true, available: false, reason: 'UNSUPPORTED' });
  }
  return rows;
}

/**
 * Normalize one raw quota reading, refusing anything malformed, expired or
 * over-capacity rather than guessing.
 * @param {*} raw - `{accountId, engineId, confidence, remaining, capacity, resetAt, source?}`.
 * @param {number} now
 * @returns {{usable: true, accountId: string, engineId: string, remainingFraction: number, resetAt: number,
 *   confidence: string, source: string} | {usable: false, reason: string}}
 */
function normalizeQuotaWindow(raw, now) {
  if (!raw || !Object.prototype.hasOwnProperty.call(QUOTA_CONFIDENCE_WEIGHT, raw.confidence)
    || !Number.isFinite(raw.remaining) || raw.remaining < 0 || !Number.isFinite(raw.capacity)
    || raw.capacity <= 0 || raw.remaining > raw.capacity || !(raw.resetAt > now)
    || !raw.accountId || !raw.engineId) {
    return { usable: false, reason: 'INVALID_OR_STALE_QUOTA' };
  }
  return {
    usable: true, accountId: raw.accountId, engineId: raw.engineId, remainingFraction: raw.remaining / raw.capacity,
    resetAt: raw.resetAt, confidence: raw.confidence, source: raw.source ?? 'unspecified'
  };
}

/**
 * Rank eligible candidates for one approved job. Eligibility is filtered
 * BEFORE scoring — available in the catalog, selectable, meets the job's
 * quality floor, capabilities and account — so quota can only reorder work
 * that was already allowed, never create or unlock it.
 * @param {{strategy: string, job: object, candidates: Array<object>, catalog: Array<object>,
 *   quota?: Array<object>, now: number}} args - `quota` entries are raw readings.
 * @returns {{ok: true, selected: object, explanation: object, ranked: Array<object>} | {ok: false, code: string}}
 */
function recommendPlacement({ strategy, job, candidates, catalog, quota = [], now }) {
  if (!PLACEMENT_STRATEGIES.includes(strategy)) return { ok: false, code: 'UNKNOWN_STRATEGY' };
  if (!job?.approved || !job?.id) return { ok: false, code: 'NO_APPROVED_WORK' };
  const available = new Set(catalog.filter((x) => x.available).map((x) => x.id));
  const eligible = candidates.filter((x) => available.has(x.engineId) && x.selectable === true
    && Number.isFinite(x.quality) && x.quality >= (job.minQuality ?? 0)
    && (job.capabilities ?? []).every((c) => (x.capabilities ?? []).includes(c))
    && (!job.accountId || x.accountId === job.accountId));
  if (!eligible.length) return { ok: false, code: 'NO_ELIGIBLE_PLACEMENT' };
  const ranked = eligible.map((x) => {
    const raw = quota.find((q) => q.accountId === x.accountId && q.engineId === x.engineId);
    const q = raw ? normalizeQuotaWindow(raw, now) : null;
    const usable = q?.usable ? q : null;
    const allowance = usable ? usable.remainingFraction * QUOTA_CONFIDENCE_WEIGHT[usable.confidence] : 0;
    const cost = Math.max(0, x.relativeCost ?? 1);
    const quality = x.quality;
    const score = strategy === 'quality' ? quality * 100 - cost * 0.01
      : strategy === 'conservation' ? -cost * 100 + quality * 0.01
        : strategy === 'balanced' ? quality * 10 - cost * 5 + allowance
          : quality * 10 - cost + allowance * 20;
    return { candidate: x, score, quotaConfidence: usable?.confidence ?? 'unknown', allowance };
  }).sort((a, b) => b.score - a.score || a.candidate.engineId.localeCompare(b.candidate.engineId)
    || a.candidate.modelId.localeCompare(b.candidate.modelId));
  return {
    ok: true, selected: ranked[0].candidate,
    explanation: { strategy, score: ranked[0].score, quotaConfidence: ranked[0].quotaConfidence, eligibleCount: eligible.length },
    ranked
  };
}

/**
 * #2993's placement entry point: `recommend` always returns advice;
 * `auto` marks the placement `autoApply: true` only when the selected
 * `{engine, model}` is on the ratified policy's `allowedAutoPlacements` and
 * its quota reading is known — otherwise it returns the same recommendation
 * with `autoApply: false` and the reason it was not applied.
 * @param {{mode: string, strategy: string, job: object, candidates: Array<object>, catalog: Array<object>,
 *   quota?: Array<object>, now: number, policy?: (object|null)}} args
 * @returns {{ok: boolean, code: string, autoApply?: boolean, placement?: object}}
 */
function placeWork({ mode, policy = null, ...rest }) {
  if (!PLACEMENT_MODES.includes(mode)) return { ok: false, code: 'UNKNOWN_PLACEMENT_MODE' };
  const placement = recommendPlacement(rest);
  if (!placement.ok) return { ok: false, code: placement.code };
  if (mode === 'recommend') return { ok: true, code: 'RECOMMENDED', autoApply: false, placement };
  const sel = placement.selected;
  const listed = (policy?.allowedAutoPlacements ?? []).some((t) => t.engine === sel.engineId && t.model === sel.modelId);
  if (!policy || policy.mode !== 'standing-policy' || !listed) return { ok: true, code: 'AUTO_NOT_PERMITTED', autoApply: false, placement };
  if (placement.explanation.quotaConfidence === 'unknown') return { ok: true, code: 'AUTO_QUOTA_UNKNOWN', autoApply: false, placement };
  return { ok: true, code: 'AUTO_APPLIED', autoApply: true, placement };
}

module.exports = {
  ensureSchema,
  validatePolicy,
  ratifyPolicy,
  getEffectivePolicy,
  decideFailover,
  recordFailoverReceipt,
  listFailoverReceipts,
  resolveEngineCatalog,
  normalizeQuotaWindow,
  recommendPlacement,
  placeWork,
  BOUNDARY_TRIGGERS,
  OUTAGE_TRIGGERS
};
