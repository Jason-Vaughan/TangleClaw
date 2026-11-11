'use strict';

/**
 * v6.1 (#2991, V6-20 / A2b, Car V61-W1-A): the bounded self-healing
 * remediation executor, its per-project recovery circuit breaker, and the
 * read model a Recovery Console renders.
 *
 * Builds on A2a (`lib/v6/incident-registry.js`, #2978), which records
 * incidents and the DECISION to attempt a repair but never executes one.
 * This module executes the repair — through an injected executor per
 * remediation, never a shell command of its own — and only for the
 * pre-authorized non-destructive repairs #2991 names: rebinding a stale
 * Medusa listener, reaping an orphan `ttyd`, and snapshotting a dirty
 * worktree onto `wip/*` before restarting a crashed harness. Everything the
 * ADR 0008 reconciliation register (Domain 2, resolution 3) forbids the
 * recovery principal — merging, releasing, deleting a branch or project,
 * altering credentials, raising an authority tier — is refused outright,
 * whoever asks, and so is any remediation id not on the allowlist.
 *
 * The bound (`maxAttempts`, default 2, ceiling 3, per incident) is enforced
 * by CLAIMING an attempt row (`outcome = 'in-flight'`) inside one
 * `BEGIN IMMEDIATE` transaction before the executor runs, so two concurrent
 * callers — in this process or another — cannot both pass the count, and a
 * crash mid-repair still spends the attempt rather than handing out a free
 * one. A restart loop is therefore structurally impossible, not merely
 * unlikely.
 *
 * Circuit states. `recovery_circuit_state` (schema v81, shared with A2a and
 * not editable by this car) CHECK-constrains `state` to
 * `closed`/`open`/`half-open`. The fourth state, `latched`, lives in this
 * module's own `v6_a2b_recovery_latches` table (created idempotently by
 * {@link ensureSchema}): once an incident has spent its attempt budget the
 * project is latched, and only an Operator principal — never the recovery
 * service itself — can clear it. {@link circuitState} composes the two into
 * the one four-state value callers see. Open → half-open happens when a
 * probe is admitted after the exponential backoff elapses; a failed
 * half-open probe re-opens with a doubled backoff.
 *
 * `{ok, code}` returns and injectable `clock`/`newId` follow the house style
 * of the other `lib/v6/*` modules.
 *
 * @module lib/v6/a2b-self-healing-remediator
 */

const crypto = require('node:crypto');

/** The dedicated principal every automatic repair runs as. */
const RECOVERY_PRINCIPAL = 'service:recovery-controller';

/** Default attempt budget per incident (#2991, ADR 0008 Domain 2). */
const DEFAULT_MAX_ATTEMPTS = 2;
/** The highest attempt budget a remediation may declare. */
const MAX_ATTEMPTS_CEILING = 3;
/** First backoff after the circuit opens; doubles per consecutive failure. */
const BASE_BACKOFF_MS = 30_000;
/** Backoff never grows past this. */
const MAX_BACKOFF_MS = 15 * 60_000;
/**
 * An `in-flight` attempt older than this is treated as abandoned (its
 * process crashed mid-repair): it is marked `abandoned`, still spends the
 * budget, and no longer blocks the project's next repair.
 */
const IN_FLIGHT_STALE_MS = 10 * 60_000;

/**
 * The pre-authorized, non-destructive repairs (#2991's scope list). Each one
 * is executed only through a caller-supplied executor of the same id.
 */
const REMEDIATIONS = Object.freeze({
  'medusa-listener-rebind': Object.freeze({ id: 'medusa-listener-rebind', destructive: false, maxAttempts: DEFAULT_MAX_ATTEMPTS }),
  'ttyd-orphan-reap': Object.freeze({ id: 'ttyd-orphan-reap', destructive: false, maxAttempts: DEFAULT_MAX_ATTEMPTS }),
  'wip-snapshot-harness-restart': Object.freeze({ id: 'wip-snapshot-harness-restart', destructive: false, maxAttempts: DEFAULT_MAX_ATTEMPTS })
});

/**
 * Actions the recovery principal may never take (ADR 0008 Domain 2 res. 3,
 * plus A2a's own `RESERVED` set). Named here so a refusal says why, rather
 * than falling through to the generic not-allowlisted code.
 */
const FORBIDDEN_ACTIONS = new Set([
  'merge', 'release', 'delete-branch', 'delete-project', 'delete-worktree',
  'alter-credentials', 'rotate-secret', 'raise-authority-tier', 'kill', 'cross-engine-takeover'
]);

/** The four observable circuit states, in escalation order. */
const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half-open', 'latched']);

/**
 * Create this module's own table. Idempotent; safe to call on every boot.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS v6_a2b_recovery_latches (
      project_id   INTEGER PRIMARY KEY REFERENCES projects(id),
      incident_id  TEXT NOT NULL,
      reason       TEXT NOT NULL,
      latched_at   TEXT NOT NULL,
      cleared_at   TEXT,
      cleared_by   TEXT,
      clear_reason TEXT
    );
  `);
}

/**
 * Backoff for the Nth consecutive failure (1-based), capped.
 * @param {number} failures
 * @returns {number} Milliseconds.
 */
function backoffMs(failures) {
  const n = Math.max(1, failures);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (n - 1));
}

/**
 * The project's live latch row, or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @returns {object|null}
 */
function _activeLatch(db, projectId) {
  return db.prepare('SELECT * FROM v6_a2b_recovery_latches WHERE project_id = ? AND cleared_at IS NULL').get(projectId) || null;
}

/**
 * The project's composed four-state circuit.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @returns {{state: string, failures: number, nextProbeAt: number, latch: (object|null)}}
 */
function circuitState(db, projectId) {
  const latch = _activeLatch(db, projectId);
  const row = db.prepare('SELECT * FROM recovery_circuit_state WHERE project_id = ?').get(projectId);
  const base = { failures: row?.failures ?? 0, nextProbeAt: row?.next_probe_at ?? 0 };
  if (latch) {
    return { state: 'latched', ...base, latch: { incidentId: latch.incident_id, reason: latch.reason, latchedAt: latch.latched_at } };
  }
  return { state: row?.state ?? 'closed', ...base, latch: null };
}

/**
 * Write the shared circuit row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @param {string} state
 * @param {number} failures
 * @param {number} nextProbeAt
 * @returns {void}
 */
function _writeCircuit(db, projectId, state, failures, nextProbeAt) {
  db.prepare(
    'INSERT INTO recovery_circuit_state (project_id, state, failures, next_probe_at) VALUES (?,?,?,?) '
    + 'ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, failures = excluded.failures, next_probe_at = excluded.next_probe_at'
  ).run(projectId, state, failures, nextProbeAt);
}

/**
 * Whether an executor's verification is a fresh, real, healthy observation:
 * observed after the attempt started, healthy, and naming its source. The
 * same freshness rule A2a's `step` applies to its `verification`.
 * @param {*} verification
 * @param {number} startedAt
 * @returns {boolean}
 */
function _isFreshHealthy(verification, startedAt) {
  return !!verification
    && verification.healthy === true
    && Number.isFinite(verification.observedAt)
    && verification.observedAt > startedAt
    && typeof verification.source === 'string'
    && verification.source.trim().length > 0;
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE`, rolling back on a throw.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Function} fn
 * @returns {*} Whatever `fn` returns.
 */
function _immediate(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Build the remediator.
 * @param {import('node:sqlite').DatabaseSync} db - A migrated (v81+) database.
 * @param {{authorize: Function}} auth - An `AuthorizationService` (`lib/v6/authority-service.js`).
 * @param {object} opts
 * @param {Object<string, Function>} opts.executors - One async function per remediation id:
 *   `({projectId, incidentId, evidence}) => ({verification: {healthy, observedAt, source}})`.
 * @param {Function} [opts.clock] - Epoch ms.
 * @param {Function} [opts.newId]
 * @returns {{remediate: Function, clearLatch: Function}}
 */
function createRemediator(db, auth, { executors = {}, clock = () => Date.now(), newId = () => crypto.randomUUID() } = {}) {
  ensureSchema(db);

  /**
   * Attempt one bounded, pre-authorized repair against an open incident.
   * @param {{projectId: number, incidentId: string, remediation: string, evidence?: object}} args
   * @returns {Promise<{ok: boolean, code: string, attemptId?: string, circuit?: object}>}
   */
  async function remediate({ projectId, incidentId, remediation, evidence = {} }) {
    if (FORBIDDEN_ACTIONS.has(remediation)) return { ok: false, code: 'FORBIDDEN_ACTION' };
    const spec = Object.prototype.hasOwnProperty.call(REMEDIATIONS, remediation) ? REMEDIATIONS[remediation] : null;
    if (!spec) return { ok: false, code: 'REMEDIATION_NOT_ALLOWED' };
    const executor = executors[remediation];
    if (typeof executor !== 'function') return { ok: false, code: 'NO_EXECUTOR' };
    const verdict = auth.authorize(RECOVERY_PRINCIPAL, 'runtime.recover', { type: 'project', id: projectId });
    if (!verdict?.allowed) return { ok: false, code: verdict?.code || 'DEFAULT_DENY' };
    const maxAttempts = Math.min(spec.maxAttempts, MAX_ATTEMPTS_CEILING);

    const startedAt = clock();
    const claim = _immediate(db, () => {
      if (_activeLatch(db, projectId)) return { ok: false, code: 'LATCHED' };
      const incident = db.prepare('SELECT * FROM runtime_incidents WHERE id = ?').get(incidentId);
      if (!incident || incident.project_id !== projectId) return { ok: false, code: 'INCIDENT_NOT_FOUND' };
      if (incident.state !== 'open') return { ok: false, code: 'INCIDENT_NOT_OPEN' };
      db.prepare("UPDATE remediation_attempts SET outcome = 'abandoned' WHERE outcome = 'in-flight' AND attempted_at < ? "
        + 'AND incident_id IN (SELECT id FROM runtime_incidents WHERE project_id = ?)')
        .run(new Date(startedAt - IN_FLIGHT_STALE_MS).toISOString(), projectId);
      const pending = db.prepare("SELECT COUNT(*) n FROM remediation_attempts a JOIN runtime_incidents i ON i.id = a.incident_id WHERE i.project_id = ? AND a.outcome = 'in-flight'").get(projectId).n;
      if (pending > 0) return { ok: false, code: 'IN_FLIGHT' };
      const circuit = db.prepare('SELECT * FROM recovery_circuit_state WHERE project_id = ?').get(projectId);
      if (circuit?.state === 'open' && startedAt < circuit.next_probe_at) return { ok: false, code: 'BACKOFF', nextProbeAt: circuit.next_probe_at };
      const spent = db.prepare('SELECT COUNT(*) n FROM remediation_attempts WHERE incident_id = ?').get(incidentId).n;
      if (spent >= maxAttempts) {
        _latch(projectId, incidentId, 'MAX_ATTEMPTS');
        return { ok: false, code: 'MAX_ATTEMPTS' };
      }
      const probing = circuit?.state === 'open';
      if (probing) _writeCircuit(db, projectId, 'half-open', circuit.failures, circuit.next_probe_at);
      const attemptId = newId();
      db.prepare('INSERT INTO remediation_attempts (id, incident_id, action, outcome, attempted_at) VALUES (?,?,?,?,?)')
        .run(attemptId, incidentId, remediation, 'in-flight', new Date(startedAt).toISOString());
      return { ok: true, attemptId, spent: spent + 1, priorFailures: circuit?.failures ?? 0 };
    });
    if (!claim.ok) return { ...claim, circuit: circuitState(db, projectId) };

    let result = null;
    let threw = false;
    try {
      result = await executor({ projectId, incidentId, evidence });
    } catch {
      threw = true;
    }
    const verified = !threw && _isFreshHealthy(result?.verification, startedAt);
    const outcome = verified ? 'verified' : threw ? 'error' : 'failed';
    const finishedAt = clock();

    _immediate(db, () => {
      db.prepare('UPDATE remediation_attempts SET outcome = ? WHERE id = ?').run(outcome, claim.attemptId);
      if (verified) {
        _writeCircuit(db, projectId, 'closed', 0, 0);
        db.prepare("UPDATE runtime_incidents SET state = 'resolved' WHERE id = ?").run(incidentId);
        return;
      }
      const failures = claim.priorFailures + 1;
      _writeCircuit(db, projectId, 'open', failures, finishedAt + backoffMs(failures));
      if (claim.spent >= maxAttempts) _latch(projectId, incidentId, 'MAX_ATTEMPTS');
    });

    const circuit = circuitState(db, projectId);
    if (verified) return { ok: true, code: 'VERIFIED', attemptId: claim.attemptId, circuit };
    return { ok: false, code: circuit.state === 'latched' ? 'LATCHED_AFTER_FAILURE' : threw ? 'EXECUTOR_ERROR' : 'NOT_VERIFIED', attemptId: claim.attemptId, circuit };
  }

  /**
   * Latch a project (inside an already-open transaction).
   * @param {number} projectId
   * @param {string} incidentId
   * @param {string} reason
   * @returns {void}
   */
  function _latch(projectId, incidentId, reason) {
    db.prepare(
      'INSERT INTO v6_a2b_recovery_latches (project_id, incident_id, reason, latched_at) VALUES (?,?,?,?) '
      + 'ON CONFLICT(project_id) DO UPDATE SET incident_id = excluded.incident_id, reason = excluded.reason, '
      + 'latched_at = excluded.latched_at, cleared_at = NULL, cleared_by = NULL, clear_reason = NULL'
    ).run(projectId, incidentId, reason, new Date(clock()).toISOString());
  }

  /**
   * Clear a project's latch and close its circuit. Operator-only: the
   * recovery service can never clear its own latch.
   * @param {{principalId: string, projectId: number, reason: string}} args
   * @returns {{ok: boolean, code: string, circuit?: object}}
   */
  function clearLatch({ principalId, projectId, reason }) {
    if (!principalId || principalId === RECOVERY_PRINCIPAL) return { ok: false, code: 'OPERATOR_REQUIRED' };
    if (typeof reason !== 'string' || !reason.trim()) return { ok: false, code: 'REASON_REQUIRED' };
    const verdict = auth.authorize(principalId, 'project.writePolicy', { type: 'project', id: projectId });
    if (!verdict?.allowed) return { ok: false, code: verdict?.code || 'DEFAULT_DENY' };
    const cleared = _immediate(db, () => {
      if (!_activeLatch(db, projectId)) return false;
      db.prepare('UPDATE v6_a2b_recovery_latches SET cleared_at = ?, cleared_by = ?, clear_reason = ? WHERE project_id = ?')
        .run(new Date(clock()).toISOString(), principalId, reason.trim(), projectId);
      _writeCircuit(db, projectId, 'closed', 0, 0);
      return true;
    });
    if (!cleared) return { ok: false, code: 'NOT_LATCHED', circuit: circuitState(db, projectId) };
    return { ok: true, code: 'CLEARED', circuit: circuitState(db, projectId) };
  }

  return { remediate, clearLatch };
}

/**
 * The Recovery Console read model for one project: the four-state circuit,
 * open incidents, and the most recent attempts. Read-only.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @param {{limit?: number}} [opts]
 * @returns {{projectId: number, circuit: object, openIncidents: Array, recentAttempts: Array}}
 */
function recoveryConsole(db, projectId, { limit = 20 } = {}) {
  ensureSchema(db);
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  const openIncidents = db.prepare("SELECT id, fingerprint, generation, created_at FROM runtime_incidents WHERE project_id = ? AND state = 'open' ORDER BY created_at")
    .all(projectId).map((r) => ({ id: r.id, fingerprint: r.fingerprint, generation: r.generation, createdAt: r.created_at }));
  const recentAttempts = db.prepare(
    'SELECT a.id, a.incident_id, a.action, a.outcome, a.attempted_at FROM remediation_attempts a '
    + 'JOIN runtime_incidents i ON i.id = a.incident_id WHERE i.project_id = ? ORDER BY a.attempted_at DESC, a.rowid DESC LIMIT ?'
  ).all(projectId, cap).map((r) => ({ id: r.id, incidentId: r.incident_id, action: r.action, outcome: r.outcome, attemptedAt: r.attempted_at }));
  return { projectId, circuit: circuitState(db, projectId), openIncidents, recentAttempts };
}

module.exports = {
  ensureSchema,
  createRemediator,
  circuitState,
  recoveryConsole,
  backoffMs,
  RECOVERY_PRINCIPAL,
  REMEDIATIONS,
  FORBIDDEN_ACTIONS,
  CIRCUIT_STATES,
  DEFAULT_MAX_ATTEMPTS,
  MAX_ATTEMPTS_CEILING,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  IN_FLIGHT_STALE_MS
};
