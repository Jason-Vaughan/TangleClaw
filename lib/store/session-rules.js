'use strict';

/**
 * The session-rules domain of the store: the rules themselves with their
 * lifecycle (`sessionRulesApi`, the status allow-list, the version snapshots
 * and their retention), the delivery ledger that records how a session's
 * rules reached its engine (`sessionRuleDeliveriesApi` and its retention),
 * the token helper the conflict-candidate hint reads, and the row mappers that
 * read a rule and a rule version back.
 *
 * The facade binds this module from `init()` and unbinds it from `close()`.
 * One thing the domain calls still lives in the facade until the projects
 * domain moves out: the project lookup that `create` checks a rule's project
 * against. It arrives beside the handle through `_bind`, the way the schema
 * receives what it calls, so this module never requires the facade and no
 * require cycle can hand it a half-built export. When the projects domain has
 * a module of its own, this one imports the api from it and the binding
 * shrinks to the handle.
 *
 * Everything below is moved from `lib/store.js` unchanged (#2248); what this
 * file adds is the handle, its binder and guard, and the export list.
 *
 * @module lib/store/session-rules
 */

const { createLogger } = require('../logger');
const { StoreError, _withSavepoint } = require('./_db');
const { activityApi } = require('./activity');
const { ruleLabel } = require('../rule-label');

// The logger keeps the facade's name so every log line this domain writes
// reads exactly as it did before the move.
const log = createLogger('store');

let _db = null;
/** The facade's projects api, while it still lives there; see `_bind`. */
let projectsApi = null;

/**
 * Bind the database handle the facade opened, with the facade-resident
 * projects api this domain still calls, or unbind both with `null`.
 * @param {{db: import('node:sqlite').DatabaseSync, projectsApi: object}|null} binding -
 *   The open database and the api, or null on close.
 * @returns {void}
 */
function _bind(binding) {
  _db = binding ? binding.db : null;
  projectsApi = binding ? binding.projectsApi : null;
}

/**
 * Refuse while THIS module holds no handle. Over the module's own handle, not
 * the handle module's: a domain the facade forgot to bind would otherwise pass
 * the shared guard and read a null handle. Checking here is what makes that
 * slip fail at the first use with `NOT_INITIALIZED`.
 * @returns {void}
 * @throws {StoreError} `NOT_INITIALIZED` when the facade has not bound this module.
 */
function _ensureDb() {
  if (!_db) {
    throw new StoreError('Store not initialized. Call store.init() first.', 'NOT_INITIALIZED');
  }
}

// ── Session Rules (#347/D1a; self-improvement D1b) ──

/**
 * Append a version snapshot of a session rule's full state (D1b). Called inside
 * create/update/delete/restore so every mutation is reversible. `version_no` is
 * monotonic per `rule_id`. Never throws on a missing row — callers pass the row
 * they already hold.
 * @param {object} ruleRow - Raw session_rules row (the post-mutation state, or
 *   the final state for a delete)
 * @param {string} op - 'create' | 'update' | 'delete' | 'restore'
 * @param {string} [changedBy] - Who made this change ('operator' default | 'ai')
 * @param {string} [changeReason] - Optional human-readable reason
 * @param {string} [criticGate] - SR-7K2P: attested Critic-gate status
 *   ('passed' | 'not-required' | 'unknown'). Absent an explicit attestation it is
 *   derived from the author — an operator edit legitimately skips the gate
 *   ('not-required'); an AI edit with no attestation is honestly 'unknown' (a
 *   landed AI edit *should* be 'passed', but the writer never assumes it).
 *   Callers must validate an explicit value via `_validateCriticGate` before any
 *   mutation, so this writer trusts the value it receives.
 */
function _snapshotSessionRule(ruleRow, op, changedBy = 'operator', changeReason = null, criticGate = undefined) {
  const gate = (criticGate === undefined || criticGate === null)
    ? (changedBy === 'ai' ? 'unknown' : 'not-required')
    : criticGate;
  const next = _db.prepare(
    'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM session_rule_versions WHERE rule_id = ?'
  ).get(ruleRow.id).n;
  _db.prepare(
    `INSERT INTO session_rule_versions
       (rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, critic_gate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ruleRow.id, next, op, ruleRow.content, ruleRow.enabled,
    ruleRow.created_by, ruleRow.owner, changedBy, changeReason, gate
  );
  _pruneSessionRuleVersions(ruleRow.id, _sessionRuleVersionRetention);
}

/**
 * Default per-rule retention for `session_rule_versions` (SR-5T1J). Each snapshot
 * write trims a rule's history to the newest this-many versions, bounding the
 * unbounded-growth failure mode under high autonomous (AI) edit volume. The
 * newest versions are always kept, so every restore target within the window,
 * the rule's current state (its latest version), and a deleted rule's tombstone
 * (`op='delete'`, that rule's latest version) survive — pruning only drops the
 * oldest, no-longer-restorable snapshots. `version_no` stays monotonic
 * (`MAX+1`); pruning leaves harmless gaps because `restore` looks a version up by
 * exact `version_no`, never by position. A value <= 0 disables pruning (keep all).
 * @type {number}
 */
const SESSION_RULE_VERSION_RETENTION = 200;

/** Live retention, defaulting to the constant; overridable via the test seam. */
let _sessionRuleVersionRetention = SESSION_RULE_VERSION_RETENTION;

/**
 * Test/embedder seam to override the per-rule version retention (SR-5T1J),
 * mirroring `_setBasePath`/`_setBundledGlobalRulesPath`.
 * @param {number} n - Versions to keep per rule; <= 0 keeps all (unbounded)
 */
function _setSessionRuleVersionRetention(n) {
  _sessionRuleVersionRetention = n;
}

/**
 * Trim a rule's version history to the newest `keep` snapshots (SR-5T1J). No-op
 * when `keep <= 0` (unbounded) or the rule already has <= `keep` versions.
 * Deletes only versions strictly older (by `version_no`) than the `keep`-th
 * newest, so the retained window is always the most recent — see
 * `SESSION_RULE_VERSION_RETENTION` for the preserved-invariants rationale.
 * @param {number} ruleId - rule_id whose history to prune
 * @param {number} keep - Newest versions to retain
 */
function _pruneSessionRuleVersions(ruleId, keep) {
  if (!keep || keep <= 0) return;
  _db.prepare(
    `DELETE FROM session_rule_versions
      WHERE rule_id = @ruleId
        AND version_no < (
          SELECT MIN(version_no) FROM (
            SELECT version_no FROM session_rule_versions
             WHERE rule_id = @ruleId
             ORDER BY version_no DESC
             LIMIT @keep
          )
        )`
  ).run({ ruleId, keep });
}

/**
 * Valid `session_rules.status` values (#569, #1709) — a rule's review state,
 * distinct from `enabled` (the operator's on/off switch for a rule they own).
 * @type {string[]}
 */
const SESSION_RULE_STATUSES = ['proposed', 'active', 'rejected', 'retired'];

/**
 * Every status change `setStatus` allows, from → [to], as ratified by the
 * Architect on #1709. Anything not listed is refused with
 * `INVALID_TRANSITION` — an allow-list, not a deny-list, because a deny-list
 * let an active rule be rejected in two password-free steps (active →
 * proposed → rejected) after the one-step move was ruled out. Six allowed
 * directed pairs out of 16 possible:
 *
 * - `proposed → active | rejected`: approve (operator authority and the
 *   #1053 text check) or decline.
 * - `rejected → active`: approve a declined proposal after all.
 * - `active → active | retired`: re-approve (a no-op beyond the text check),
 *   or retire. An active rule is never rejected and never sent back to
 *   proposed through this door: rejection answers a proposal that never
 *   governed, and either move would take a governing rule out of the list
 *   and the Graveyard alike. Retire is how a rule leaves force.
 * - `retired → active`: restore, landing disabled. A rule that never
 *   governed cannot be retired, so nothing else reaches or leaves 'retired'.
 *
 * `docs/session-rules-self-improvement.md` renders this table, and
 * `test/session-rule-lifecycle.test.js` holds the two to each other.
 * @type {Readonly<Record<string, string[]>>}
 */
const SESSION_RULE_TRANSITIONS = Object.freeze({
  proposed: ['active', 'rejected'],
  rejected: ['active'],
  active: ['active', 'retired'],
  retired: ['active']
});

/**
 * Decide the status a newly-created rule gets.
 *
 * **AI-authored content cannot become a governing rule on the AI's own say-so.**
 * That is the safety property of the self-improvement loop: the wrap may
 * propose, never apply. It is enforced here rather than only at the HTTP
 * boundary because this is the write site — `promoteFromLearning` and any
 * future internal caller reach the table through `create()` without passing
 * through a route.
 *
 * `createdBy` alone cannot decide this, because it records **authorship**, not
 * **authority**: a rule promoted from a learning is genuinely AI-authored, yet
 * the operator clicking Promote is a human decision and must produce a live
 * rule. Collapsing the two would either mislabel provenance (recording an
 * operator as the author of text they did not write) or make the operator's own
 * approval land as another proposal. So authority is carried separately and
 * explicitly by `approvedByOperator`, which only a human-initiated path sets.
 *
 * An explicit `'rejected'` is honored for either author — it records a decision
 * and governs nothing. Operator-authored rules default to `'active'`, which
 * preserves pre-#569 behavior for every existing caller.
 *
 * @param {string} createdBy - 'operator' | 'ai' | 'system' (authorship)
 * @param {string} [requested] - Caller-supplied status, if any
 * @param {boolean} [approvedByOperator] - True only on a path a human initiated
 * @returns {string} The status to persist
 */
function _resolveNewRuleStatus(createdBy, requested, approvedByOperator) {
  if (requested !== undefined && requested !== null) {
    if (!SESSION_RULE_STATUSES.includes(requested)) {
      throw new StoreError(`status must be one of ${SESSION_RULE_STATUSES.join(', ')}`, 'BAD_REQUEST');
    }
    // A rule that was never born cannot die: 'retired' is reachable only
    // from 'active', through setStatus, never at birth (#1709).
    if (requested === 'retired') {
      throw new StoreError('a rule cannot be created retired — only an active rule can be retired', 'INVALID_TRANSITION');
    }
    // AI authorship asking for 'active' without a human behind it is exactly
    // the request that must not be granted.
    if (createdBy === 'ai' && requested === 'active' && approvedByOperator !== true) return 'proposed';
    return requested;
  }
  if (createdBy !== 'ai') return 'active';
  return approvedByOperator === true ? 'active' : 'proposed';
}

/**
 * Valid `session_rules.kind` values (CC-6, #381). 'startup' rules inject into
 * the engine config at launch; 'wrap' rules inject into the wrap pipeline's
 * ai-content prompt (and are the self-learning sink). The former 'mode' kind
 * was retired — harness posture is now the structured per-project
 * `defaultLaunchMode`/`showLaunchModePicker` settings, not free-text rules.
 * 'master' rules are the Project Master's editable Hard-rules block
 * (lib/master.js): singleton-scoped (project_id NULL — the master is not a
 * project), rendered into the master's generated CLAUDE.md identity.
 * @type {string[]}
 */
const SESSION_RULE_KINDS = ['startup', 'wrap', 'master'];

/**
 * Valid `session_rule_versions.critic_gate` values (SR-7K2P). Attests whether an
 * edit passed the in-session Critic gate: `passed` (AI edit attested through the
 * gate), `not-required` (operator/trivial edit that legitimately skips it), or
 * `unknown` (backfilled legacy row, or an AI edit applied with no attestation).
 * @type {string[]}
 */
const SESSION_RULE_CRITIC_GATES = ['passed', 'not-required', 'unknown'];

/**
 * Reject an explicit-but-invalid `criticGate` before any mutation runs, so a bad
 * value never leaves a rule row without its version snapshot. `undefined`/`null`
 * mean "no attestation" and pass (the writer derives from the author).
 * @param {string} [criticGate] - Caller-supplied Critic-gate attestation
 * @throws {StoreError} BAD_REQUEST if a non-null value is out of enum
 */
function _validateCriticGate(criticGate) {
  if (criticGate !== undefined && criticGate !== null && !SESSION_RULE_CRITIC_GATES.includes(criticGate)) {
    throw new StoreError(`criticGate must be one of ${SESSION_RULE_CRITIC_GATES.join(', ')}`, 'BAD_REQUEST');
  }
}

/**
 * Retire an active rule in place (#1709), recording what superseded it when
 * a replacement's approval is the cause (#1696). The status test is part of
 * the UPDATE, so a rule that stopped being active in the meantime is left
 * alone rather than retired from some other state: only a rule that lived
 * can die. The caller supplies the transaction when this is one step of a
 * larger write.
 * @param {number} id - The rule to retire
 * @param {object} [opts]
 * @param {number|null} [opts.supersededBy] - The rule whose approval retires this one
 * @param {string} [opts.changedBy] - 'operator' (default) | 'ai'
 * @param {string} [opts.changeReason] - Recorded on the version snapshot
 * @returns {object|null} The retired row, or null when the rule was not
 *   active (nothing changed)
 */
function _retireActiveSessionRule(id, opts = {}) {
  const supersededBy = opts.supersededBy ?? null;
  const changedBy = opts.changedBy || 'operator';
  const done = _db.prepare(
    `UPDATE session_rules SET status = 'retired', superseded_by = ?, retired_at = datetime('now'),
       updated_at = datetime('now') WHERE id = ? AND status = 'active'`
  ).run(supersededBy, id);
  if (done.changes === 0) return null;
  const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
  _snapshotSessionRule(row, 'update', changedBy,
    opts.changeReason ?? (supersededBy === null ? 'retired' : `retired: superseded by rule ${supersededBy}`));
  activityApi.log({
    projectId: row.project_id,
    eventType: 'session_rule.retired',
    detail: { id, supersededBy, changedBy }
  });
  return row;
}

/**
 * Check a `replacesRuleId` at creation (#1696). A replacement must name a
 * rule that is still in force, in the same project and of the same kind:
 * that is the rule its approval will retire. Master rules are excluded;
 * they have their own shipped-baseline lifecycle.
 * @param {*} replacesRuleId - The caller's value
 * @param {number|null} projectId - The new rule's project
 * @param {string} kind - The new rule's kind
 * @returns {number|null} The validated id, or null when none was given
 * @throws {StoreError} INVALID_REPLACES when the value cannot be honoured
 */
function _validateReplacesTarget(replacesRuleId, projectId, kind) {
  if (replacesRuleId === undefined || replacesRuleId === null) return null;
  const refuse = (why) => { throw new StoreError(`replacesRuleId ${JSON.stringify(replacesRuleId)}: ${why}`, 'INVALID_REPLACES'); };
  if (!Number.isInteger(replacesRuleId) || replacesRuleId <= 0) refuse('must be a rule id (a positive integer)');
  if (kind === 'master') refuse('master rules are not replaced this way — they have their own baseline lifecycle');
  const target = _db.prepare('SELECT id, project_id, kind, status FROM session_rules WHERE id = ?').get(replacesRuleId);
  if (!target) refuse('no such rule');
  if (Number(target.project_id) !== Number(projectId) || (target.kind || 'startup') !== kind) {
    refuse(`it belongs to a different project or kind — a replacement must be a ${kind} rule of the same project`);
  }
  if ((target.status || 'active') !== 'active') refuse(`it is ${target.status}, and only an active rule can be replaced`);
  const pending = _pendingReplacementOf(target.id);
  if (pending !== null) {
    refuse(`rule ${target.id} already has a pending replacement (rule ${pending}) — decide that one first; two approved replacements of one rule would both govern`);
  }
  return target.id;
}

/**
 * The pending replacement of a rule, if there is one (Architect ruling on
 * #1696: at most one at a time per original). Rejected replacements do not
 * count: they were decided.
 * @param {number} targetId - The rule being replaced
 * @returns {number|null} The pending replacement's id, or null
 */
function _pendingReplacementOf(targetId) {
  const row = _db.prepare(
    "SELECT id FROM session_rules WHERE replaces_rule_id = ? AND status = 'proposed' ORDER BY id LIMIT 1"
  ).get(targetId);
  return row ? row.id : null;
}

/**
 * Is this rule one whose text may only change through approval? An active
 * project rule: its text governs sessions, so an edit or a version rollback
 * becomes a replacement proposal instead of rewriting it in place (Architect
 * ruling on #1696). Master rules are outside this contract — they keep their
 * own confirmed baseline path.
 * @param {object} row - A session_rules row
 * @returns {boolean}
 */
function _textChangesNeedApproval(row) {
  return (row.status || 'active') === 'active' && (row.kind || 'startup') !== 'master';
}

/**
 * Refuse a text change to a retired rule. A retired rule is history: its
 * text is what governed until it left force, and a restore brings back
 * exactly that. Letting it be rewritten while retired would let
 * retire → edit → restore → switch-on put text in force that no operator
 * ever approved.
 * @param {number} id - The rule
 * @returns {never}
 */
function _refuseRetiredTextChange(id) {
  throw new StoreError(
    `rule ${id} is retired: its text is history and cannot be changed. Restore it first; a change to an active rule goes through approval`,
    'RULE_RETIRED'
  );
}

/**
 * Throw the 409-mapped refusal for a second pending replacement of one rule.
 * @param {number} targetId - The active rule
 * @param {number} pendingId - Its pending replacement
 * @returns {never}
 */
function _refusePendingReplacement(targetId, pendingId) {
  const err = new StoreError(
    `rule ${targetId} already has a pending replacement (rule ${pendingId}): approve or reject that one before changing this rule again`,
    'REPLACEMENT_PENDING'
  );
  err.pendingReplacementId = pendingId;
  throw err;
}

/**
 * File a text change to an active project rule as a replacement proposal
 * instead of applying it (#1696): the rule keeps governing its approved
 * text until the operator approves the change. The one place both doors
 * into a rule's text (an edit, a version rollback) go through, so a check
 * added here covers both. Refuses a second pending replacement, and runs
 * in a savepoint so the proposal and any caller-supplied follow-up land
 * together or not at all.
 * @param {object} row - The active rule's row
 * @param {string} text - The proposed new text
 * @param {'edit'|'restore'} origin - Which door the change came through
 * @param {object} opts
 * @param {string} [opts.changedBy] - Who asked for the change
 * @param {string} opts.changeReason - Recorded on the proposal's first version
 * @param {string} [opts.criticGate] - Attestation carried onto the proposal
 * @param {Function} [opts.then] - Runs inside the same savepoint; returns the rule to report
 * @returns {object} The rule as reported, plus `replacementProposed`
 */
function _proposeTextChange(row, text, origin, opts) {
  const pending = _pendingReplacementOf(row.id);
  if (pending !== null) _refusePendingReplacement(row.id, pending);
  return _withSavepoint(() => {
    const proposal = sessionRulesApi.create({
      content: text,
      projectId: row.project_id,
      kind: row.kind || 'startup',
      createdBy: opts.changedBy || 'operator',
      status: 'proposed',
      replacesRuleId: row.id,
      replacementOrigin: origin,
      changeReason: opts.changeReason,
      criticGate: opts.criticGate
    });
    const reported = opts.then ? opts.then() : _rowToSessionRule(row);
    return { ...reported, replacementProposed: proposal };
  });
}

const sessionRulesApi = {
  /**
   * The launch-injection query: a project's active **startup** rules. Used by
   * `engines._getRulesContent` to build the cross-model `## Session Rules`
   * section at session launch. CC-6 (#381): only `kind='startup'` injects;
   * 'wrap' rules inject at wrap time instead. The former global tier
   * (project_id IS NULL rows) was retired — cross-project directives belong in
   * the Global rules document (`data/global-rules.md`), not per-row session rules.
   * @param {number|null} projectId - Project id (null/undefined → no rules)
   * @returns {object[]}
   */
  listActiveForProject(projectId) {
    _ensureDb();
    if (projectId === null || projectId === undefined) return [];
    // `id` is a required tiebreaker, not decoration: created_at comes from
    // SQLite's datetime('now'), which has SECOND resolution, so rules added in
    // the same second share a timestamp and their relative order would be
    // unspecified. That matters here beyond presentation — the delivery ledger
    // hashes this block to identify a rule set, and an unstable order would
    // produce a different digest for an unchanged set. Matches listActiveForMaster.
    return _db.prepare(
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND status = 'active' AND kind = 'startup' AND project_id = ?
       ORDER BY created_at, id`
    ).all(projectId).map(_rowToSessionRule);
  },

  /**
   * The master-identity query: the Project Master's active Hard rules, oldest
   * first (stable render order in the generated CLAUDE.md). Master rules are
   * singleton rows — kind 'master', project_id NULL (lib/master.js).
   * @returns {object[]}
   */
  listActiveForMaster() {
    _ensureDb();
    return _db.prepare(
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND status = 'active' AND kind = 'master' AND project_id IS NULL
       ORDER BY created_at, id`
    ).all().map(_rowToSessionRule);
  },

  /**
   * List session rules with optional filters (for the UI/API).
   * @param {object} [options]
   * @param {number} [options.enabled] - Filter by enabled (1 or 0)
   * @param {number} [options.projectId] - Filter by exact project id
   * @param {string} [options.kind] - CC-6: filter by rule kind ('startup'|'wrap'|'master')
   * @param {string} [options.status] - Filter by review state ('proposed'|'active'|'rejected').
   *   Unfiltered by default, because the UI needs to SEE proposals. Any caller
   *   using this list to inject rules into a session or prompt must pass
   *   `status: 'active'` — an unreviewed proposal reaching a live session is the
   *   failure this state exists to prevent (#569).
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    const conditions = [];
    const params = [];
    if (options.enabled !== undefined) {
      conditions.push('enabled = ?');
      params.push(options.enabled ? 1 : 0);
    }
    if (options.projectId !== undefined) {
      conditions.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(options.kind);
    }
    if (options.status !== undefined) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    let sql = 'SELECT * FROM session_rules';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    return _db.prepare(sql).all(...params).map(_rowToSessionRule);
  },

  /**
   * Get a single session rule by id.
   * @param {number} id - Rule id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    return row ? _rowToSessionRule(row) : null;
  },

  /**
   * Create a new session rule. Rules are project-scoped — the former global
   * tier (projectId null) was retired in favor of the Global rules document;
   * cross-project directives belong there. The one exception is the 'master'
   * kind: the Project Master is a singleton above all projects, so its rules
   * carry project_id NULL and a projectId here is rejected.
   * @param {object} data
   * @param {string} data.content - Rule content (required, non-empty)
   * @param {number} [data.projectId] - Project id (required for every kind
   *   except 'master', where it is forbidden)
   * @param {string} [data.createdBy] - 'operator' (default) | 'ai' | 'system'
   *   ('system' marks rows seeded from a shipped baseline)
   * @param {string} [data.kind] - CC-6: 'startup' (default) | 'wrap' | 'master'
   * @param {string} [data.owner] - Owner identity (auth seam, nullable)
   * @param {number} [data.sourceLearningId] - Provenance: the learning this rule
   *   was promoted from (D1b), nullable
   * @param {string} [data.changeReason] - Optional reason recorded on the v1 snapshot
   * @param {string} [data.criticGate] - SR-7K2P: attested Critic-gate status recorded
   *   on the v1 snapshot ('passed' | 'not-required' | 'unknown'); derived from author if omitted
   * @param {number} [data.replacesRuleId] - #1696: the active rule (same project
   *   and kind) this one replaces. Fixed at creation. Approving the replacement
   *   retires it; a replacement created already active retires it at once, in
   *   the same transaction, because creating a live rule is itself the
   *   operator's decision.
   * @param {string} [data.replacementOrigin] - 'amendment' (default, when
   *   `replacesRuleId` is given) | 'edit' | 'restore'. The latter two are set
   *   only by `_proposeTextChange` — the create route never passes them through.
   * @returns {object}
   * @throws {StoreError} BAD_REQUEST on missing/invalid fields; INVALID_PROJECT_ID
   *   when projectId names no existing project (#1121 — e.g. a project name
   *   passed where the numeric id belongs); INVALID_REPLACES when
   *   `replacesRuleId` cannot be honoured
   */
  create(data) {
    _ensureDb();
    if (!data || !data.content || !data.content.trim()) {
      throw new StoreError('content is required', 'BAD_REQUEST');
    }
    const createdBy = data.createdBy || 'operator';
    const kind = data.kind || 'startup';
    if (!SESSION_RULE_KINDS.includes(kind)) {
      throw new StoreError(`kind must be one of ${SESSION_RULE_KINDS.join(', ')}`, 'BAD_REQUEST');
    }
    if (kind === 'master') {
      if (data.projectId !== undefined && data.projectId !== null) {
        throw new StoreError('master rules are singleton-scoped — projectId must not be set', 'BAD_REQUEST');
      }
    } else if (data.projectId === undefined || data.projectId === null) {
      throw new StoreError('projectId is required — the global session-rules tier was retired; put cross-project directives in the Global rules document', 'BAD_REQUEST');
    } else if (!projectsApi.get(data.projectId)) {
      // #1121: without this check the insert dies on the FK constraint and
      // surfaces as a bare 500. The likeliest caller mistake is passing the
      // project's NAME — every /api/sessions/:project route addresses by name,
      // so the error must say which identifier this API wants.
      throw new StoreError(
        `unknown projectId ${JSON.stringify(data.projectId)} — pass the project's numeric id (see GET /api/projects), not its name`,
        'INVALID_PROJECT_ID'
      );
    }
    _validateCriticGate(data.criticGate);
    const status = _resolveNewRuleStatus(createdBy, data.status, data.approvedByOperator);
    const replaces = _validateReplacesTarget(data.replacesRuleId, data.projectId ?? null, kind);
    // 'amendment' unless this store made the replacement from an edit or a
    // version restore of the rule. Callers of the API cannot choose it: the
    // create route never passes it through.
    const origin = replaces === null ? null : (data.replacementOrigin || 'amendment');
    if (origin !== null && !['amendment', 'edit', 'restore'].includes(origin)) {
      throw new StoreError(`replacementOrigin must be amendment, edit or restore — got ${JSON.stringify(origin)}`, 'BAD_REQUEST');
    }
    const insert = () => {
      _db.prepare(
        'INSERT INTO session_rules (project_id, content, created_by, kind, owner, source_learning_id, status, replaces_rule_id, replacement_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        data.projectId ?? null,
        data.content.trim(),
        createdBy,
        kind,
        data.owner ?? null,
        data.sourceLearningId ?? null,
        status,
        replaces,
        origin
      );
      const inserted = _db.prepare('SELECT * FROM session_rules WHERE id = last_insert_rowid()').get();
      _snapshotSessionRule(inserted, 'create', createdBy, data.changeReason ?? null, data.criticGate);
      // Born live as a replacement: retire what it replaces now, or both
      // would govern — the #1696 defect, reached through creation instead
      // of approval.
      if (replaces !== null && status === 'active') {
        _retireActiveSessionRule(replaces, { supersededBy: inserted.id, changedBy: createdBy });
      }
      return inserted;
    };
    // Atomic only when there is a second row to change, and by savepoint, so
    // a create still works inside a caller's own transaction.
    const row = replaces === null ? insert() : _withSavepoint(insert);
    const rule = _rowToSessionRule(row);
    activityApi.log({
      projectId: rule.projectId,
      eventType: 'session_rule.created',
      // `status` belongs here: this is the write site enforcing "AI authorship
      // cannot mint a governing rule", and without it the audit trail cannot
      // tell a proposal from a live rule — which is the one distinction an
      // auditor of this event would be looking for.
      detail: {
        kind: rule.kind, createdBy: rule.createdBy, status: rule.status,
        contentPreview: rule.content.slice(0, 80),
        // A store-made edit or rollback proposal must be distinguishable from
        // a fresh proposal in the audit trail (#1696).
        ...(rule.replacesRuleId ? { replacesRuleId: rule.replacesRuleId, replacementOrigin: rule.replacementOrigin } : {})
      }
    });
    return rule;
  },

  /**
   * Update a session rule's content and/or enabled flag.
   *
   * An active project rule's text governs sessions, so a change to it does
   * not rewrite it in place: it becomes a replacement proposal (`202`-style
   * result, carrying `replacementProposed`), and the rule keeps governing
   * its approved text until the operator approves the new one (Architect
   * ruling on #1696). An enabled toggle in the same call still applies to
   * the rule itself, via `opts.then` inside the same proposal transaction.
   * A retired rule's text cannot be changed at all (`RULE_RETIRED`) — it is
   * history; restore it first.
   * @param {number} id - Rule id
   * @param {object} updates
   * @param {string} [updates.content] - New content (non-empty if provided)
   * @param {boolean|number} [updates.enabled] - New enabled state
   * @param {string} [updates.changedBy] - Who made this change ('operator' default | 'ai')
   * @param {string} [updates.changeReason] - Optional reason recorded on the snapshot
   * @param {string} [updates.criticGate] - SR-7K2P: attested Critic-gate status recorded
   *   on the snapshot ('passed' | 'not-required' | 'unknown'); derived from author if omitted
   * @returns {object} The rule, or (when a text change to an active,
   *   non-master rule is filed as a proposal instead) the rule as it stood
   *   plus `replacementProposed`
   * @throws {StoreError} RULE_RETIRED when the rule is retired and `content`
   *   would change it; BAD_REQUEST if `replacesRuleId` is present (fixed at
   *   creation, never updatable)
   */
  update(id, updates = {}) {
    _ensureDb();
    _validateCriticGate(updates.criticGate);
    // Refused rather than ignored: silently dropping this field is the
    // #1696 defect, and letting it change would retarget which rule an
    // approval retires after the operator was shown the original.
    if (updates.replacesRuleId !== undefined) {
      throw new StoreError('replacesRuleId is fixed when a rule is created and cannot be changed', 'BAD_REQUEST');
    }
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');
    if (updates.content !== undefined && (!updates.content || !updates.content.trim())) {
      throw new StoreError('content cannot be empty', 'BAD_REQUEST');
    }

    const newText = updates.content !== undefined ? updates.content.trim() : undefined;
    if (newText !== undefined && newText !== row.content && row.status === 'retired') _refuseRetiredTextChange(id);
    if (newText !== undefined && newText !== row.content && _textChangesNeedApproval(row)) {
      const { content: _dropped, ...rest } = updates;
      return _proposeTextChange(row, newText, 'edit', {
        changedBy: updates.changedBy,
        changeReason: updates.changeReason ?? `edit of active rule ${id}, awaiting approval`,
        criticGate: updates.criticGate,
        // A switch change in the same call applies to the rule itself.
        then: rest.enabled !== undefined ? () => sessionRulesApi.update(id, rest) : undefined
      });
    }

    const sets = [];
    const params = [];
    if (newText !== undefined) {
      sets.push('content = ?');
      params.push(newText);
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(updates.enabled ? 1 : 0);
    }
    if (sets.length === 0) return _rowToSessionRule(row);

    sets.push("updated_at = datetime('now')");
    params.push(id);
    _db.prepare(`UPDATE session_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const updated = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    _snapshotSessionRule(updated, 'update', updates.changedBy || 'operator', updates.changeReason ?? null, updates.criticGate);
    const rule = _rowToSessionRule(updated);
    activityApi.log({
      projectId: rule.projectId,
      eventType: 'session_rule.updated',
      detail: { enabled: rule.enabled, changedBy: updates.changedBy || 'operator' }
    });
    return rule;
  },

  /**
   * List the version history of a session rule, newest first (D1b).
   * @param {number} ruleId - Rule id
   * @returns {object[]}
   */
  listVersions(ruleId) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM session_rule_versions WHERE rule_id = ? ORDER BY version_no DESC'
    ).all(ruleId).map(_rowToSessionRuleVersion);
  },

  /**
   * Roll a session rule back to a prior version's content + enabled state
   * (D1b). Records a new `op='restore'` snapshot so the rollback itself is
   * in the history. Only restores an EXISTING rule (restoring a deleted
   * rule is out of scope for D1b).
   *
   * Rolling an active project rule back to different text is a text change
   * like any other: it becomes a replacement proposal, and the rule is
   * left exactly as it is — text and switch — until that is approved
   * (Architect ruling on #1696). A rollback that changes only the switch
   * applies as before. A retired rule's text cannot be rolled back at all
   * (`RULE_RETIRED`) — restore it (via `setStatus`) first.
   *
   * Not to be confused with restoring a *retired rule* back to 'active' —
   * that is `setStatus(id, 'active', {restoreOnly: true})`, a status-axis
   * move. This method only ever touches `content`/`enabled`.
   * @param {number} id - Rule id
   * @param {number} versionNo - Target version number to restore
   * @param {object} [opts]
   * @param {string} [opts.changedBy] - Who triggered the restore ('operator' default | 'ai')
   * @param {string} [opts.criticGate] - SR-7K2P: attested Critic-gate status recorded
   *   on the restore snapshot ('passed' | 'not-required' | 'unknown'); derived from author if omitted
   * @returns {object} - The restored rule, or (when the rollback changes an
   *   active, non-master rule's text) the rule as it stood plus
   *   `replacementProposed`
   * @throws {StoreError} RULE_RETIRED when the rule is retired and the
   *   target version's text differs from its current, frozen text
   */
  restore(id, versionNo, opts = {}) {
    _ensureDb();
    _validateCriticGate(opts.criticGate);
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');
    const version = _db.prepare(
      'SELECT * FROM session_rule_versions WHERE rule_id = ? AND version_no = ?'
    ).get(id, versionNo);
    if (!version) throw new StoreError(`Version ${versionNo} not found for rule ${id}`, 'NOT_FOUND');

    if (version.content !== row.content && row.status === 'retired') _refuseRetiredTextChange(id);
    if (version.content !== row.content && _textChangesNeedApproval(row)) {
      return _proposeTextChange(row, version.content, 'restore', {
        changedBy: opts.changedBy,
        changeReason: `restore of active rule ${id} to version ${versionNo}, awaiting approval`,
        criticGate: opts.criticGate
      });
    }

    _db.prepare(
      "UPDATE session_rules SET content = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(version.content, version.enabled, id);
    const updated = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    _snapshotSessionRule(updated, 'restore', opts.changedBy || 'operator', `restored to version ${versionNo}`, opts.criticGate);
    const rule = _rowToSessionRule(updated);
    activityApi.log({
      projectId: rule.projectId,
      eventType: 'session_rule.restored',
      detail: { restoredToVersion: versionNo, changedBy: opts.changedBy || 'operator' }
    });
    return rule;
  },

  /**
   * Promote a learning into a session rule (D1b). Operator-confirmed — the
   * caller (API/agent) is the explicit confirmation; this never auto-runs.
   * Defaults `createdBy='ai'` (the AI proposed it) and records provenance via
   * `source_learning_id`. Content defaults to the learning's text unless
   * overridden.
   * @param {number} learningId - The learning to promote
   * @param {object} [overrides]
   * @param {string} [overrides.content] - Rule content (defaults to learning text)
   * @param {number} [overrides.projectId] - Scope (defaults to the learning's
   *   own project — rules are always project-scoped since the global tier retired)
   * @param {string} [overrides.createdBy] - Defaults 'ai'
   * @param {string} [overrides.kind] - CC-6: target kind (defaults 'startup'). The
   *   wrap-time self-critique loop promotes into 'wrap'.
   * @param {string} [overrides.criticGate] - SR-7K2P: attested Critic-gate status. A
   *   promotion is AI-authored, so absent an attestation the v1 snapshot records 'unknown'.
   * @returns {object} - The created rule
   */
  promoteFromLearning(learningId, overrides = {}) {
    _ensureDb();
    const learning = _db.prepare('SELECT * FROM learnings WHERE id = ?').get(learningId);
    if (!learning) throw new StoreError(`Learning ${learningId} not found`, 'NOT_FOUND');
    const content = (overrides.content ?? learning.content ?? '').trim();
    if (!content) throw new StoreError('content is required', 'BAD_REQUEST');
    return this.create({
      content,
      projectId: overrides.projectId ?? learning.project_id,
      createdBy: overrides.createdBy || 'ai',
      kind: overrides.kind || 'startup',
      sourceLearningId: learningId,
      changeReason: `promoted from learning ${learningId}`,
      criticGate: overrides.criticGate,
      status: overrides.status,
      // The existing `/promote` route is the operator pressing Promote, so it
      // passes this and gets a live rule. The wrap's proposal step calls the
      // same method without it and gets a proposal — one code path, and which
      // one you get depends on whether a human decided.
      approvedByOperator: overrides.approvedByOperator
    });
  },

  /**
   * Resolve a proposal: approve it into a governing rule, or reject it
   * (#569). Retire an active rule, or restore a retired one (#1709).
   *
   * Rejection is recorded rather than deleted, and that is the point: the wrap
   * proposes from recurring learnings, so a deleted rejection would simply be
   * re-proposed at the next wrap that saw the same learning. A `'rejected'` row
   * is the memory of the operator's answer.
   *
   * Which moves are allowed at all is `SESSION_RULE_TRANSITIONS` — a move not
   * listed there is refused `INVALID_TRANSITION` before anything else about
   * it is checked. An **active** rule is never rejected and never sent back
   * to proposed through this door: rejection answers a proposal that never
   * governed, and either move would take a governing rule out of the list
   * and the Graveyard alike with no password (Architect ruling on #1709).
   * Retire is the only way a governing rule leaves force.
   *
   * **Retire** ('active'→'retired') and **restore** ('retired'→'active')
   * are the only moves into or out of 'retired'. A rule that never governed
   * cannot be retired ("if a rule was never born, it can never die" —
   * Operator ruling on #1709), and a restored rule comes back disabled, so
   * it never starts governing on the strength of one click. Neither needs
   * `expectedContent`: neither can make text govern.
   *
   * Approving a proposal created as a replacement (`replacesRuleId`) retires
   * the rule it replaces in the same transaction (#1696), so approving an
   * amendment and retiring what it amends are one decision, the second of
   * them never invisible. If that rule is no longer active by then (retired
   * or deleted meanwhile), what happens depends on how the replacement
   * arose. An 'amendment' filed with `replacesRuleId` still stands — the
   * operator's intent already holds — and the result says so in `replaced:
   * null` plus `replacementSkipped`. An 'edit' or 'restore' of an active
   * rule throws `REPLACEMENT_TARGET_INACTIVE` and changes nothing: it was a
   * change to THAT rule, not a rule of its own, and approving it would
   * resurrect edited text with nothing left to change. Whatever the origin,
   * if a DIFFERENT replacement already retired the rule, the approval
   * throws `REPLACEMENT_SUPERSEDED` and changes nothing: one rule is
   * replaced by one rule, never by two (Architect ruling on #1696).
   *
   * Snapshots a version like every other mutation, so the decision appears in
   * the rule's history rather than only in an activity log. Note the limit:
   * `session_rule_versions` has no `status` column, so the snapshot records the
   * transition in free-text `change_reason` plus `changed_by`, not as queryable
   * state. Two adjacent versions differing only by status therefore look
   * near-identical in the history UI. Adding the column is a table rebuild
   * (SQLite cannot ALTER in a CHECK) and is deliberately deferred.
   *
   * An approval must name the text it is approving (`expectedContent`), and is
   * refused if the rule no longer holds exactly that text. The operator
   * approves what a surface showed them, and that snapshot can be stale: the
   * content is editable by other callers between display and approval. Without
   * the comparison, approving would ratify whatever the row held at that
   * instant, which may be text nobody showed the operator. The comparison is the
   * UPDATE's own WHERE clause, so there is no gap between checking and writing.
   * It is exact: content is canonicalised (trimmed) when it is written, so the
   * persisted text is the canonical form and a surface echoes it back verbatim.
   * A rejection, a retire and a restore grant nothing and are never compared.
   *
   * @param {number} id - Rule id
   * @param {string} status - 'proposed' | 'active' | 'rejected' | 'retired'
   * @param {object} [opts]
   * @param {string} [opts.changedBy] - 'operator' (default) | 'ai'
   * @param {string} [opts.changeReason] - Recorded on the snapshot
   * @param {string} [opts.expectedContent] - Required for an approval: the exact
   *   persisted content the operator was shown. Missing throws
   *   `EXPECTED_CONTENT_REQUIRED`; a mismatch throws `CONTENT_CHANGED` with
   *   `currentContent` on the error. Either way nothing changes.
   * @param {boolean} [opts.restoreOnly] - The caller has authority for a
   *   restore and nothing more (the route's password-free door into
   *   'active'). Anything but a retired rule then throws
   *   `APPROVAL_REQUIRES_AUTHORITY`, so a rule that stopped being retired
   *   after the caller looked cannot be approved through it.
   * @returns {object} The updated rule. An approval of a replacement also
   *   carries `replaced`: `{id}` of the rule it retired, or `null` when that
   *   rule was no longer active (Architect ruling on #1696), in which case
   *   `replacementSkipped: {id, reason}` says which rule was named and why
   *   nothing was retired.
   * @throws {StoreError} INVALID_TRANSITION for a move the lifecycle forbids
   */
  setStatus(id, status, opts = {}) {
    _ensureDb();
    // Before any write: the snapshot writer trusts this value, so an
    // invalid one found late would leave a status change with no history row.
    _validateCriticGate(opts.criticGate);
    if (!SESSION_RULE_STATUSES.includes(status)) {
      throw new StoreError(`status must be one of ${SESSION_RULE_STATUSES.join(', ')}`, 'BAD_REQUEST');
    }
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');
    const from = row.status || 'active';

    const changedBy = opts.changedBy || 'operator';
    // An AI cannot approve its own proposal. Same property as `create()`, at the
    // other door into 'active' — a gate on one entrance is not a gate.
    if (changedBy === 'ai' && status === 'active') {
      throw new StoreError(
        'an AI cannot approve a proposed rule into an active one — approval is an operator decision',
        'FORBIDDEN'
      );
    }

    if (opts.restoreOnly === true && !(status === 'active' && from === 'retired')) {
      throw new StoreError(
        `rule ${id} is ${from}, not retired: only a restore can go through here, and anything else needs the operator's authority`,
        'APPROVAL_REQUIRES_AUTHORITY'
      );
    }
    if (!(SESSION_RULE_TRANSITIONS[from] || []).includes(status)) {
      let why = `${from} → ${status} is not a move the rule lifecycle allows`;
      if (from === 'active') why = 'an active rule leaves force only by being retired — it is never rejected or sent back to proposed';
      else if (status === 'retired') why = 'only an active rule can be retired — a rule that never governed has nothing to retire';
      else if (from === 'retired') why = "the only way out of retirement is to restore it (status 'active')";
      throw new StoreError(`rule ${id} is ${from}: ${why}`, 'INVALID_TRANSITION');
    }
    // Master rules keep their own shipped-baseline lifecycle (confirmBaselineEdit
    // on disable and delete, restore-defaults); retiring one would bypass it.
    if (status === 'retired' && (row.kind || 'startup') === 'master') {
      throw new StoreError(
        `rule ${id} is a Master rule: Master rules are disabled or deleted through their own confirmed path, not retired`,
        'INVALID_TRANSITION'
      );
    }

    if (status === 'retired') {
      const retired = _retireActiveSessionRule(id, { changedBy, changeReason: opts.changeReason });
      if (!retired) {
        throw new StoreError(`rule ${id} stopped being active before it could be retired`, 'INVALID_TRANSITION');
      }
      return _rowToSessionRule(retired);
    }

    if (from === 'retired') {
      const restored = _db.prepare(
        `UPDATE session_rules SET status = 'active', enabled = 0, retired_at = NULL,
           updated_at = datetime('now') WHERE id = ? AND status = 'retired'`
      ).run(id);
      if (restored.changes === 0) {
        throw new StoreError(`rule ${id} stopped being retired before it could be restored`, 'INVALID_TRANSITION');
      }
      const updated = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
      _snapshotSessionRule(updated, 'update', changedBy,
        opts.changeReason ?? 'restored from retirement (disabled until switched on)', opts.criticGate);
      activityApi.log({
        projectId: updated.project_id,
        // Not 'session_rule.restored': that event is a version rollback.
        eventType: 'session_rule.unretired',
        detail: { id, changedBy }
      });
      return _rowToSessionRule(updated);
    }

    // After the authority refusal above, never before it: a caller refused
    // authority must not be told anything about the text.
    const compare = status === 'active';
    if (compare && opts.expectedContent === undefined) {
      throw new StoreError(
        'approving a rule requires expectedContent — the exact rule text the operator was shown',
        'EXPECTED_CONTENT_REQUIRED'
      );
    }
    if (compare && typeof opts.expectedContent !== 'string') {
      throw new StoreError('expectedContent must be a string — the rule text being approved', 'BAD_REQUEST');
    }
    // Only an approval that brings a replacement into force retires
    // anything; re-approving a rule that already governs changes nothing
    // else.
    const replacing = compare && from !== 'active' && row.replaces_rule_id !== null && row.replaces_rule_id !== undefined;

    const apply = () => {
      const written = compare
        ? _db.prepare("UPDATE session_rules SET status = ?, updated_at = datetime('now') WHERE id = ? AND content = ?")
          .run(status, id, opts.expectedContent)
        : _db.prepare("UPDATE session_rules SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
      if (written.changes === 0) {
        const current = _db.prepare('SELECT content FROM session_rules WHERE id = ?').get(id);
        if (!current) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');
        const err = new StoreError(
          `Session rule ${id} no longer holds the text being approved — it changed after it was shown. Nothing was approved.`,
          'CONTENT_CHANGED'
        );
        err.currentContent = current.content;
        throw err;
      }
      const updated = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
      _snapshotSessionRule(updated, 'update', changedBy,
        opts.changeReason ?? `status ${from} → ${status}`, opts.criticGate);
      let replaced;
      let replacementSkipped;
      if (replacing) {
        const target = row.replaces_rule_id;
        const targetNow = _retireActiveSessionRule(target, { supersededBy: id, changedBy })
          ? null
          : _db.prepare('SELECT status, superseded_by FROM session_rules WHERE id = ?').get(target);
        if (targetNow === null) {
          replaced = { id: target };
        } else if (targetNow && targetNow.superseded_by !== null && targetNow.superseded_by !== id) {
          // Another replacement already took this rule out of force.
          // Approving a second one would leave two rules governing where
          // there was one rule — refused for every origin, so the lineage
          // stays single (Architect ruling on #1696).
          const err = new StoreError(
            `rule ${target} was already replaced by rule ${targetNow.superseded_by}: approving rule ${id} as a second `
            + 'replacement would leave two rules governing in its place. Nothing was approved.',
            'REPLACEMENT_SUPERSEDED'
          );
          err.targetId = target;
          err.supersededBy = targetNow.superseded_by;
          throw err;
        } else if (row.replacement_origin === 'edit' || row.replacement_origin === 'restore') {
          // An edit or rollback is a change to THAT rule. With the rule
          // gone it has nothing to change, and approving it would
          // resurrect edited text (Architect ruling on #1696). Throwing
          // inside the savepoint undoes the approval written above.
          const err = new StoreError(
            `rule ${id} is an ${row.replacement_origin} of rule ${target}, which is ${targetNow ? `now ${targetNow.status}` : 'deleted'}: `
            + 'it can no longer be approved. Nothing was approved.',
            'REPLACEMENT_TARGET_INACTIVE'
          );
          err.targetId = target;
          throw err;
        } else {
          replaced = null;
          replacementSkipped = {
            id: target,
            reason: targetNow ? `rule ${target} was already ${targetNow.status}, so there was nothing to retire`
              : `rule ${target} no longer exists, so there was nothing to retire`
          };
        }
      }
      const detail = { id, from, to: status };
      if (replacing) {
        detail.replaced = replaced;
        if (replacementSkipped) detail.replacementSkipped = replacementSkipped;
      }
      activityApi.log({ projectId: updated.project_id, eventType: 'session_rule.updated', detail });
      return { updated, replaced, replacementSkipped };
    };
    // A refused compare-and-set throws inside the transaction, so a
    // replacement is never retired unless its successor really was approved.
    const { updated, replaced, replacementSkipped } = replacing ? _withSavepoint(apply) : apply();
    const rule = _rowToSessionRule(updated);
    if (replacing) {
      rule.replaced = replaced;
      if (replacementSkipped) rule.replacementSkipped = replacementSkipped;
    }
    return rule;
  },

  /**
   * Surface CANDIDATE conflicts for a proposed rule (D1b) — the given project's
   * active rules sharing significant token overlap with the proposed content.
   * This is a NON-AUTHORITATIVE signal for the AI/operator to judge; per the
   * ratified design it does NOT auto-resolve and does NOT decide a conflict —
   * it only narrows what to compare before a Critic-gated review. Returns
   * matches sorted by overlap (most first).
   * @param {string} content - Proposed rule content
   * @param {number|null} [projectId] - Project to compare within (null → no matches)
   * @param {object} [opts]
   * @param {number} [opts.minOverlap] - Minimum shared significant tokens (default 2)
   * @param {string} [opts.kind] - CC-6: only compare against rules of this kind
   *   (a proposed 'wrap' rule shouldn't surface 'startup' rules as conflicts)
   * @returns {Array<{rule: object, overlap: string[]}>}
   */
  findConflictCandidates(content, projectId = null, opts = {}) {
    _ensureDb();
    const minOverlap = opts.minOverlap ?? 2;
    const proposed = _significantTokens(content);
    if (proposed.size === 0) return [];
    const kindClause = opts.kind ? ' AND kind = ?' : '';
    const kindParams = opts.kind ? [opts.kind] : [];
    if (projectId === null || projectId === undefined) return [];
    const active = _db.prepare(
      // `status = 'active'` matters here as the proposal queue grows: this
      // answers "what might a new rule conflict with", and an unreviewed
      // proposal or a rule the operator already declined is not something to
      // reconcile against. Without it, every accumulated proposal would start
      // surfacing as a conflict candidate against the next one.
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND status = 'active' AND project_id = ?${kindClause}
       ORDER BY created_at`
    ).all(projectId, ...kindParams);
    const matches = [];
    for (const row of active) {
      const tokens = _significantTokens(row.content);
      const overlap = [...proposed].filter((t) => tokens.has(t));
      if (overlap.length >= minOverlap) {
        matches.push({ rule: _rowToSessionRule(row), overlap });
      }
    }
    matches.sort((a, b) => b.overlap.length - a.overlap.length);
    return matches;
  },

  /**
   * Hard-delete a session rule (D1b: snapshots a tombstone first so history
   * survives the delete).
   * @param {number} id - Rule id
   * @param {object} [opts]
   * @param {string} [opts.changedBy] - Who deleted it ('operator' default | 'ai')
   * @param {string} [opts.changeReason] - Optional reason
   */
  delete(id, opts = {}) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');
    _snapshotSessionRule(row, 'delete', opts.changedBy || 'operator', opts.changeReason ?? null);
    _db.prepare('DELETE FROM session_rules WHERE id = ?').run(id);
    activityApi.log({
      projectId: row.project_id,
      eventType: 'session_rule.deleted',
      detail: { id, changedBy: opts.changedBy || 'operator' }
    });
  }
};

/**
 * The channels a session-rule block can travel to an engine (#595). Pinned as an
 * enum because the CHECK constraint on `session_rule_deliveries.channel` rejects
 * anything else — a typo would otherwise surface as an opaque SQLite error at
 * launch, on the path whose whole purpose is to make delivery observable.
 *
 * - `rules-hook`  — written to `.tangleclaw/session-rules-<n>.json` and read by
 *   a dedicated SessionStart hook, one per shard (#749). This is where startup
 *   rules go on a silent-prime engine. They rode `prime-file` until the engine's
 *   output cap started replacing that payload wholesale and taking them with it.
 * - `prime-file`  — written to `.tangleclaw/session-prime.md`, read by the
 *   engine's SessionStart hook as hidden context. Still the prime's own channel,
 *   and the value pre-#749 rows carry.
 * - `prime-paste` — pasted into the TUI via tmux send-keys at startup.
 * - `none`        — no channel exists for this engine; paired with a skipReason.
 * @type {string[]}
 */
const SESSION_RULE_DELIVERY_CHANNELS = ['prime-file', 'prime-paste', 'rules-hook', 'none'];

/**
 * How long after a delivery row is written a receipt for it is still believed
 * (#1063).
 *
 * A SessionStart hook fires at engine boot, seconds after the row is written.
 * The window exists to bound the one replay the token itself cannot: an
 * unconsumed token stands exactly while the row is `written`, and every
 * `claude` opened in that project directory runs the same startup hook. Ten
 * minutes is far longer than any boot and far shorter than "some later
 * session", which is the separation that matters.
 * @type {number}
 */
const RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The outcomes a delivery attempt can have (#595) — the ledger's source of
 * truth, deliberately an enum rather than a delivered boolean. Under a
 * boolean, "the project has no rules" and "the rules arrived" are the same
 * value, which is the conflation the ledger exists to end.
 *
 * - `delivered`  — the rule block reached the engine, and the writer observed
 *                  the channel ready to receive it.
 * - `no-rules`   — the launch path ran; the project had no active startup rules.
 * - `skipped`    — rules existed and did not arrive; `skipReason` says why.
 * - `unverified` — the block was sent and nothing observed the far side (#1063);
 *                  `skipReason` says what made it unobservable. A blind paste
 *                  records this, never `delivered` — a fully broken channel
 *                  must not produce a clean ledger.
 * - `written`    — the rule shards were written to disk and nothing has yet
 *                  confirmed the engine read them (#1063). The `rules-hook`
 *                  channel's honest write-time row: a hook that never runs
 *                  leaves this standing, and the #759 outage — every Claude
 *                  SessionStart hook failing, sessions booting with no rules —
 *                  produced a clean `delivered` ledger for as long as it
 *                  lasted precisely because this state did not exist. The hook
 *                  itself upgrades the row to `delivered` when it runs
 *                  (`markDelivered`), so `delivered` on this channel now means
 *                  the engine executed the hook, not that a file exists.
 * @type {string[]}
 */
const SESSION_RULE_DELIVERY_OUTCOMES = ['delivered', 'no-rules', 'skipped', 'unverified', 'written'];

/**
 * The skip reason a launch records when the rule TEXT rides the launch sequence
 * instead of the prime (Train 21, #1584).
 *
 * A constant because two places must agree on it exactly: `lib/sessions.js`
 * writes it, and `projectsWithUndeliveredRules` matches it to keep a pulled
 * project out of the undelivered warning. A `channel` value of its own would be
 * cleaner and needs a migration to widen the CHECK, which belongs with the next
 * schema version rather than beside this fix.
 * @type {string}
 */
const RULES_SERVED_BY_LAUNCH_SEQUENCE =
  "the rules are served in full by this session's launch sequence (`tc start next`), not by the prime";

/**
 * Rows kept per project in the delivery ledger before the oldest are pruned.
 *
 * The ledger is written once or twice per launch and would otherwise grow
 * without bound for the life of the install. Its questions are all about
 * *recent* state ("is this project receiving its rules?"), so deep history has
 * no consumer — matching the retention precedent already set by
 * `SESSION_RULE_VERSION_RETENTION` in this same subsystem.
 * @type {number}
 */
let SESSION_RULE_DELIVERY_RETENTION = 100;

/**
 * Override the delivery-retention cap. Test seam only, mirroring
 * `_setSessionRuleVersionRetention`.
 * @param {number} n - New per-project retention cap
 * @returns {void}
 */
function _setSessionRuleDeliveryRetention(n) {
  SESSION_RULE_DELIVERY_RETENTION = n;
}

/**
 * Map a `session_rule_deliveries` row to the camelCase shape the API/UI consume.
 * `ruleIds` is stored as a JSON array and parsed here so no caller has to know
 * the encoding; a corrupt value degrades to `[]` rather than throwing, because a
 * malformed audit row must never break the launch path that writes the next one.
 * @param {object} row - Raw SQLite row
 * @returns {{id: number, sessionId: number|null, projectId: number|null, engineId: string, kind: string, channel: string, outcome: string, delivered: boolean, skipReason: string|null, ruleIds: number[], ruleCount: number, digest: string, createdAt: string}}
 */
function _rowToSessionRuleDelivery(row) {
  let ruleIds = [];
  try {
    const parsed = JSON.parse(row.rule_ids);
    if (Array.isArray(parsed)) ruleIds = parsed;
  } catch {
    // Corrupt JSON in an audit column — report an empty set rather than throw.
    log.warn('session_rule_deliveries.rule_ids is not valid JSON', { id: row.id });
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    engineId: row.engine_id,
    kind: row.kind,
    channel: row.channel,
    outcome: row.outcome,
    // Derived from `outcome`, never stored independently — a convenience for
    // consumers that only care "did it arrive", with no second source of truth
    // that could disagree.
    delivered: row.outcome === 'delivered',
    confirmedAt: row.confirmed_at || null,
    skipReason: row.skip_reason,
    ruleIds,
    ruleCount: row.rule_count,
    digest: row.digest,
    createdAt: row.created_at
  };
}

/**
 * Trim a project's delivery history to the retention cap, oldest first.
 * Runs after each insert so the ledger stays bounded without a sweeper.
 *
 * Scoped per project, so rows with a NULL `project_id` are never pruned. That
 * is deliberate rather than an oversight: no production path writes one (both
 * launch paths always carry a project), so such rows can only arrive via a
 * direct store call, and a global sweeper would be machinery for a case the
 * product does not produce.
 * @param {number} projectId - Project whose history to prune
 * @returns {number} Rows deleted
 */
function _pruneSessionRuleDeliveries(projectId) {
  const info = _db.prepare(
    `DELETE FROM session_rule_deliveries
      WHERE project_id = ?
        AND id NOT IN (
          SELECT id FROM session_rule_deliveries
           WHERE project_id = ? ORDER BY id DESC LIMIT ?
        )`
  ).run(projectId, projectId, SESSION_RULE_DELIVERY_RETENTION);
  return info.changes;
}

const sessionRuleDeliveriesApi = {
  /**
   * Record one delivery attempt of a session-rule block (#595).
   *
   * Every outcome is recorded deliberately. `outcome` is the discriminator that
   * keeps "this engine has no channel" (`skipped`, with a reason) separate from
   * "this project has no rules" (`no-rules`) and from a real delivery — three
   * states that a single boolean collapses into two, which is how startup rules
   * stayed severed on 13 projects without anyone noticing.
   *
   * @param {object} entry
   * @param {number|null} [entry.sessionId] - Session this delivery belongs to
   * @param {number|null} [entry.projectId] - Project whose rules were delivered
   * @param {string} entry.engineId - Engine that received (or could not receive) the block
   * @param {string} [entry.kind] - Rule tier delivered (default 'startup')
   * @param {string} entry.channel - One of SESSION_RULE_DELIVERY_CHANNELS
   * @param {string} entry.outcome - One of SESSION_RULE_DELIVERY_OUTCOMES
   * @param {string} [entry.skipReason] - Why not; required when outcome is 'skipped'
   * @param {number[]} [entry.ruleIds] - Rule ids in delivery order
   * @param {string} [entry.digest] - sha256 of the rule content ('' when no rules)
   * @returns {object} The recorded delivery
   * @throws {StoreError} BAD_REQUEST on a missing engineId, a bad channel or
   *   outcome, a skip with no reason, or a delivery claimed through no channel
   */
  record(entry = {}) {
    _ensureDb();
    if (!entry.engineId) throw new StoreError('engineId is required', 'BAD_REQUEST');
    if (!SESSION_RULE_DELIVERY_CHANNELS.includes(entry.channel)) {
      throw new StoreError(`channel must be one of ${SESSION_RULE_DELIVERY_CHANNELS.join(', ')}`, 'BAD_REQUEST');
    }
    if (!SESSION_RULE_DELIVERY_OUTCOMES.includes(entry.outcome)) {
      throw new StoreError(`outcome must be one of ${SESSION_RULE_DELIVERY_OUTCOMES.join(', ')}`, 'BAD_REQUEST');
    }
    // A skip or an unverified send with no reason is the useless row: it
    // records that something went wrong while discarding the only field that
    // says what.
    if ((entry.outcome === 'skipped' || entry.outcome === 'unverified') && !entry.skipReason) {
      throw new StoreError(`skipReason is required when outcome is '${entry.outcome}'`, 'BAD_REQUEST');
    }
    // "Delivered through no channel" is self-contradictory, and so is an
    // unverified SEND — or a `written` one — through no channel. This list must
    // stay in step with the table's matching CHECK: when it did not, the DB
    // caught the case the guard missed, so the caller got a raw SQLite error
    // instead of a BAD_REQUEST naming the field. This ledger's only value is that its
    // rows can be trusted as evidence of what reached an engine, so a state
    // that cannot be true must not be storable.
    if (['delivered', 'unverified', 'written'].includes(entry.outcome) && entry.channel === 'none') {
      throw new StoreError(`channel 'none' cannot be ${entry.outcome}`, 'BAD_REQUEST');
    }
    const ruleIds = Array.isArray(entry.ruleIds) ? entry.ruleIds : [];
    const info = _db.prepare(
      `INSERT INTO session_rule_deliveries
         (session_id, project_id, engine_id, kind, channel, outcome, skip_reason, rule_ids, rule_count, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.sessionId ?? null,
      entry.projectId ?? null,
      entry.engineId,
      entry.kind || 'startup',
      entry.channel,
      entry.outcome,
      (entry.outcome === 'skipped' || entry.outcome === 'unverified') ? entry.skipReason : null,
      JSON.stringify(ruleIds),
      ruleIds.length,
      entry.digest || ''
    );
    if (entry.projectId !== null && entry.projectId !== undefined) {
      _pruneSessionRuleDeliveries(entry.projectId);
    }
    return _rowToSessionRuleDelivery(
      _db.prepare('SELECT * FROM session_rule_deliveries WHERE id = ?').get(info.lastInsertRowid)
    );
  },

  /**
   * Upgrade a `written` row to `delivered` on evidence the engine ran the hook
   * (#1063).
   *
   * The ONLY transition this ledger allows, and deliberately narrow. It moves
   * `written` → `delivered` and nothing else: a row that already says
   * `delivered` is left alone (a hook that fires twice is not new evidence), and
   * a `skipped` or `unverified` row is never rescued by a late receipt, because
   * those rows attest a different channel state and overwriting them would let
   * a receipt launder a failure into a success. A row that does not exist, or
   * is in any other state, returns `null` rather than throwing — the caller is
   * an inbound HTTP route fed an id from a file on a session's disk, so a stale
   * or wrong id is an ordinary condition, not an exception.
   *
   * **What a receipt actually proves, and the freshness window.** It proves
   * that *a* hook ran in the project directory and read the shards — not which
   * session's. It cannot prove that: the hook is registered on `startup` in the
   * project's own settings (`lib/engines.js`), so every `claude` opened in that
   * directory runs it, and the token names a row rather than a session. (It also
   * re-fires on `clear` and `compact`, but the hook posts no receipt for those.)
   * The token is consumed on a successful post, which handles the ordinary
   * case, but NOT the one that matters: when this session's hook never ran,
   * nothing was consumed and the token stands — exactly while the row is still
   * `written`, the only state this function acts on. Some later `claude` in
   * that directory would then credit its own hook run to a session that never
   * received anything.
   *
   * So the binding is temporal and enforced HERE, server-side, where a token on
   * a session's disk cannot influence it: a SessionStart hook fires within
   * seconds of the launch that wrote the row, so a receipt arriving more than
   * `RECEIPT_MAX_AGE_MS` after the row was written is refused.
   *
   * Residual, stated rather than closed: a `claude` opened by hand in that
   * directory *inside* the window, for a launch whose own hook failed, still
   * confirms that row. The window is what bounds it; nothing here makes it
   * impossible.
   *
   * @param {number} id - Delivery row id, from the receipt token the launch wrote.
   * @param {number} [nowMs] - Clock override for tests.
   * @returns {object|null} The upgraded row, or `null` if nothing was upgraded.
   */
  markDelivered(id, nowMs) {
    _ensureDb();
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    const row = _db.prepare(
      "SELECT id, created_at FROM session_rule_deliveries WHERE id = ? AND outcome = 'written'"
    ).get(numeric);
    if (!row) return null;
    // `created_at` is SQLite's `datetime('now')` — UTC, no zone marker, so it
    // is read as UTC explicitly rather than left to the host's local zone.
    const writtenAtMs = Date.parse(`${String(row.created_at).replace(' ', 'T')}Z`);
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    // `Math.abs`: a negative age means the host clock is behind the clock that
    // stamped the row. Without it that case is not `> RECEIPT_MAX_AGE_MS` and
    // so accepts unconditionally — a window that silently stops being one is
    // the shape this whole chunk is about, even where no abuse is realistic.
    const age = now - writtenAtMs;
    if (!Number.isFinite(writtenAtMs) || Math.abs(age) > RECEIPT_MAX_AGE_MS) {
      log.warn('Refused a rules-hook receipt outside the freshness window', {
        deliveryId: numeric, writtenAt: row.created_at, ageMs: Number.isFinite(writtenAtMs) ? age : null
      });
      return null;
    }
    const info = _db.prepare(
      "UPDATE session_rule_deliveries SET outcome = 'delivered', confirmed_at = datetime('now') "
      + "WHERE id = ? AND outcome = 'written'"
    ).run(numeric);
    if (!info.changes) return null;
    return _rowToSessionRuleDelivery(
      _db.prepare('SELECT * FROM session_rule_deliveries WHERE id = ?').get(numeric)
    );
  },

  /**
   * Every delivery recorded for one session, oldest first — the direct answer to
   * "did session X receive rule set Y at version Z" (compare `digest`).
   * @param {number} sessionId
   * @returns {object[]}
   */
  listForSession(sessionId) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM session_rule_deliveries WHERE session_id = ? ORDER BY id'
    ).all(sessionId).map(_rowToSessionRuleDelivery);
  },

  /**
   * A project's delivery history, newest first, for the operator-facing
   * "is this project actually receiving its rules" view.
   * @param {number} projectId
   * @param {object} [options]
   * @param {number} [options.limit=20] - Max rows
   * @returns {object[]}
   */
  listForProject(projectId, options = {}) {
    _ensureDb();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
    return _db.prepare(
      'SELECT * FROM session_rule_deliveries WHERE project_id = ? ORDER BY id DESC LIMIT ?'
    ).all(projectId, limit).map(_rowToSessionRuleDelivery);
  },

  /**
   * The most recent delivery attempt for a project, or null if it has never had
   * one. A null here on a project that has been launched means the launch path
   * never reached the ledger — itself a finding.
   * @param {number} projectId
   * @returns {object|null}
   */
  latestForProject(projectId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM session_rule_deliveries WHERE project_id = ? ORDER BY id DESC LIMIT 1'
    ).get(projectId);
    return row ? _rowToSessionRuleDelivery(row) : null;
  },

  /**
   * The fleet-wide health question #595 was filed to answer: which projects
   * that HAVE startup rules are not currently receiving them.
   *
   * Judged on the MOST RECENT delivery attempt, not on whether any `delivered`
   * row exists in history (#1063). History-wide NOT EXISTS was the poisoned
   * form: the paste path recorded fabricated `delivered` rows for 12 days, the
   * migration preserves them verbatim (the audit trail is not rewritten), and
   * under NOT EXISTS those rows would have hidden the exact 8 projects this
   * view exists to surface — forever. The latest attempt is also the honest
   * health signal: a channel that delivered last month and skips today is
   * broken today.
   *
   * Scoped to projects with rules on purpose — a project with none has nothing
   * to deliver and is not a finding. `lastOutcome` distinguishes the ways of
   * failing: `skipped` (a channel exists and the block did not arrive),
   * `unverified` (the block was sent and nothing confirmed it landed — #1063),
   * and `null` (no launch ever reached the ledger at all). Only a latest
   * outcome of `delivered` counts as delivered: an unverified-latest project
   * surfaces, which is the point.
   *
   * One skip is excluded, and only one: a project whose newest row is
   * `RULES_SERVED_BY_LAUNCH_SEQUENCE` deliberately sent no rule text on the
   * prime channel, and whether the rules were read is answered by that launch's
   * own record (`launch_sequences`, surfaced by the readiness panel). This
   * composes two records; it never upgrades a row — the skip stays a skip
   * (Train 21 §2.5, no cross-upgrades).
   *
   * @returns {Array<{projectId: number, projectName: string, ruleCount: number, lastOutcome: string|null, lastSkipReason: string|null}>}
   */
  projectsWithUndeliveredRules() {
    _ensureDb();
    return _db.prepare(
      `SELECT p.id   AS projectId,
              p.name AS projectName,
              (SELECT COUNT(*) FROM session_rules r
                WHERE r.project_id = p.id AND r.enabled = 1 AND r.kind = 'startup') AS ruleCount,
              (SELECT d.outcome FROM session_rule_deliveries d
                WHERE d.project_id = p.id ORDER BY d.id DESC LIMIT 1) AS lastOutcome,
              (SELECT d.skip_reason FROM session_rule_deliveries d
                WHERE d.project_id = p.id ORDER BY d.id DESC LIMIT 1) AS lastSkipReason
         FROM projects p
        WHERE ruleCount > 0
          AND (lastOutcome IS NULL OR lastOutcome != 'delivered')
          AND (lastSkipReason IS NULL OR lastSkipReason != ?)
        ORDER BY p.name`
    ).all(RULES_SERVED_BY_LAUNCH_SEQUENCE);
  }
};

/**
 * Tokenize text into a set of significant lowercased tokens for the
 * conflict-candidate signal (D1b) — words >3 chars, minus a small stopword set.
 * Deliberately simple: this feeds a non-authoritative "rules to compare" hint,
 * not a semantic conflict decision.
 * @param {string} text
 * @returns {Set<string>}
 */
function _significantTokens(text) {
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'over', 'than',
    'then', 'when', 'must', 'always', 'never', 'should', 'before', 'after', 'each',
    'every', 'your', 'will', 'have', 'just', 'only', 'also', 'them', 'they'
  ]);
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 3 && !STOP.has(raw)) out.add(raw);
  }
  return out;
}

/**
 * Convert a SQLite session_rules row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSessionRule(row) {
  return {
    id: row.id,
    // #2029: every consumer names a rule by this, derived from the id and never
    // from the authored content, so API readers need not format their own.
    label: ruleLabel(row.id),
    projectId: row.project_id,
    content: row.content,
    enabled: !!row.enabled,
    createdBy: row.created_by,
    // CC-6 (#381): 'startup' (launch-injected) | 'wrap' (wrap-prompt-injected).
    // Older rows predating the column read back as 'startup' via the schema default.
    kind: row.kind || 'startup',
    owner: row.owner,
    sourceLearningId: row.source_learning_id ?? null,
    // #569 review state. Rows predating the column read back as 'active' via the
    // schema default — they already governed sessions and were never proposals.
    status: row.status || 'active',
    // #1696/#1709: replacement/supersession provenance. `null` for every rule
    // not involved in a replacement — the common case — not `undefined`, so a
    // JSON-serialized rule always carries the key.
    replacesRuleId: row.replaces_rule_id ?? null,
    supersededBy: row.superseded_by ?? null,
    retiredAt: row.retired_at ?? null,
    replacementOrigin: row.replacement_origin ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Convert a SQLite session_rule_versions row to an app-level object (D1b).
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSessionRuleVersion(row) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    versionNo: row.version_no,
    op: row.op,
    content: row.content,
    enabled: !!row.enabled,
    createdBy: row.created_by,
    owner: row.owner,
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    criticGate: row.critic_gate,
    createdAt: row.created_at
  };
}

module.exports = {
  _bind,
  sessionRulesApi,
  SESSION_RULE_KINDS,
  SESSION_RULE_STATUSES,
  SESSION_RULE_TRANSITIONS,
  SESSION_RULE_VERSION_RETENTION,
  _setSessionRuleVersionRetention,
  sessionRuleDeliveriesApi,
  SESSION_RULE_DELIVERY_CHANNELS,
  SESSION_RULE_DELIVERY_OUTCOMES,
  RULES_SERVED_BY_LAUNCH_SEQUENCE,
  _setSessionRuleDeliveryRetention
};
