'use strict';

/**
 * v6 Stage 1 (#1149, V6-02 / A1a): server-pinned project authority policies,
 * a default-deny `AuthorizationService`, and the Stage 1 lease/approval
 * mint/revoke surface for the G1 GitHub writer (V6-19, deferred).
 *
 * `createTables`/`backfillProject`/`detectDrift`/`getEffective`/`setPolicy`
 * are ported near-verbatim from PRR-A's tested Phase 6 bundle
 * (`v6-phase6-stage1-pr-ready-bundles-and-migration-verifier.md`, 80+4
 * `node:test` cases passing against a real v80 clone); the DDL itself lives
 * in `lib/store/_schema.js#_v6Stage1AuthorityLedgerIncidentDdl`, not here —
 * this module only ever receives an already-migrated `db`.
 *
 * `OPERATOR_AUTHORITY_SETTINGS` (`./project-authority-settings`, #1982) is
 * the real, already-shipped 32-key registry classifying every
 * `DEFAULT_PROJECT_CONFIG` setting's authority tier; this module imports it
 * rather than inventing a parallel list. The dispatch for this car described
 * "29 settings including 3 H1 branding keys" — the live registry has 32
 * keys and none are branding keys; the 3-key branding policy
 * (`branding.uiWatermark`/`gitCommitTrailer`/`generatedDocAttribution`) is
 * V6-15 (H1) under BRIDGE-4, a different issue and a different car, so it is
 * deliberately not added here.
 *
 * A pre-existing `project_recovery_state` pin still decides
 * `launchSequence.recoveryMode`; the policy row is an inventory mirror, never
 * a second recovery authority. An unverified `fleetCoordinator: true` file
 * flag is preserved in an import discrepancy but becomes a blocked import
 * and an effective `false` policy until an operator-created active
 * `project-manager` role proves it. The legacy file is never overwritten.
 * Writer CAS is deliberately limited to validated Fleet Coordinator booleans;
 * other setting writers require an approved field validator (out of this
 * car's scope).
 *
 * `createAuthorizationService` resolves DB-backed principals, membership,
 * exact grants and project/workspace scope, default-deny. The production
 * bridge mapping a verified `sharedDocsAccess` launch binding or an
 * authenticated `req.tcSession.userId` into a trusted principal is
 * `createVerifiedPrincipalResolver`'s job — it never trusts a
 * request-supplied principal header. Wiring either into `server.js` routes
 * is BRIDGE-2, out of this car's file envelope.
 *
 * `mintLease`/`revokeLease`/`mintApproval`/`revokeApproval` are new: no
 * bundle in any lane's plans implements the Stage 1 *issuer* side of
 * `v6_g1_leases`/`v6_g1_approvals` (INT's Phase 10 bundle is the G1 *writer*,
 * which only consumes these rows). "A distinct signed-in operator must
 * provision `v6_g1_approvals`" (P08) is a cross-request identity check this
 * library layer cannot itself enforce — the schema has no column tying an
 * approval back to the principal who minted its corresponding lease — so
 * that distinctness check is deferred to the authenticated HTTP route layer
 * (BRIDGE-3, not yet built) that will call these functions with a verified
 * principal per request.
 *
 * @module lib/v6/authority-service
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const projectConfig = require('../project-config');
const { OPERATOR_AUTHORITY_SETTINGS } = require('../project-authority-settings');

/** Every settings-registry key this module imports and resolves policy for. */
const KEYS = Object.freeze(Object.keys(OPERATOR_AUTHORITY_SETTINGS));

const _digest = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const _valueAt = (object, key) => key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), object);
const _equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Read a project's legacy `.tangleclaw/project.json` RAW, if present — not
 * through `projectConfig.load()`, which always returns a defaults-merged
 * object and so cannot tell "no file" apart from "file present"; backfill's
 * digest/discrepancy tracking needs that distinction.
 * @param {{path: string}} project - The project row (needs only `path`).
 * @param {Function} [readFile] - Injectable for tests; defaults to `fs.readFileSync`.
 * @returns {{data: object, source: ('approved-import'|'default'), digest: (string|null)}}
 * @throws {TypeError} When the file exists but does not hold a JSON object.
 */
function readSnapshot(project, readFile = fs.readFileSync) {
  const file = path.join(project.path, '.tangleclaw', 'project.json');
  let raw = null;
  let source = 'default';
  try {
    raw = readFile(file, 'utf8');
    source = 'approved-import';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const data = raw === null ? {} : JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('PROJECT_CONFIG_INVALID');
  return { data, source, digest: raw === null ? null : _digest(raw) };
}

/**
 * Import a project's legacy settings into `project_authority_policies`, once.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @param {{now?: Function}} [opts]
 * @returns {{ok: boolean, code: string, count?: number, discrepancies?: object[]}}
 */
function backfillProject(db, projectId, { now = () => new Date().toISOString() } = {}) {
  const project = db.prepare('SELECT id, path FROM projects WHERE id = ?').get(projectId);
  if (!project) return { ok: false, code: 'PROJECT_MISSING' };
  const snapshot = readSnapshot(project);
  const count = db.prepare('SELECT COUNT(*) n FROM project_authority_policies WHERE project_id = ?').get(projectId).n;
  if (count === KEYS.length) {
    const imported = db.prepare('SELECT status, discrepancies_json FROM project_authority_imports WHERE project_id = ?').get(projectId);
    return imported?.status === 'verified'
      ? { ok: true, code: 'ALREADY_IMPORTED', count }
      : { ok: false, code: 'IMPORT_BLOCKED', count, discrepancies: imported ? JSON.parse(imported.discrepancies_json) : [] };
  }
  if (count !== 0) return { ok: false, code: 'PARTIAL_IMPORT', count };
  db.exec('BEGIN IMMEDIATE');
  try {
    const discrepancies = [];
    for (const key of KEYS) {
      const rawValue = _valueAt(snapshot.data, key);
      let value = rawValue === undefined ? _valueAt(projectConfig.DEFAULT_PROJECT_CONFIG, key) : rawValue;
      if (key === 'fleetCoordinator' && value === true) {
        const role = db.prepare(
          "SELECT 1 FROM coordinator_roles WHERE project_id = ? AND role = 'project-manager' AND status = 'active' AND created_by = 'operator'"
        ).get(projectId);
        if (!role) {
          value = false;
          discrepancies.push({ settingKey: key, code: 'UNVERIFIED_FLEET_FLAG', legacyFileValue: true });
        }
      }
      const writerClass = key === 'launchSequence.recoveryMode' || key === 'fleetCoordinator' ? 'operator' : 'delegated';
      db.prepare(
        'INSERT INTO project_authority_policies (project_id, setting_key, policy_value_json, writer_class, registry_version, source, changed_at, legacy_file_digest) VALUES (?,?,?,?,?,?,?,?)'
      ).run(projectId, key, JSON.stringify(value), writerClass, 1, snapshot.source, now(), snapshot.digest);
    }
    const pin = db.prepare('SELECT pinned_mode, pinned_at FROM project_recovery_state WHERE project_id = ?').get(projectId);
    db.prepare(
      'INSERT INTO project_authority_imports (project_id, registry_version, source_file_digest, recovery_pin_digest, migrated_at, migrated_by_version, verified_at, status, discrepancies_json) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      projectId, 1, snapshot.digest, pin ? _digest(pin) : null, now(), 'v6-stage1',
      discrepancies.length ? null : now(), discrepancies.length ? 'blocked' : 'verified', JSON.stringify(discrepancies)
    );
    db.exec('COMMIT');
    return { ok: discrepancies.length === 0, code: discrepancies.length ? 'IMPORTED_BLOCKED' : 'IMPORTED', count: KEYS.length, discrepancies };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Backfill every existing project.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @returns {object[]} One result per project, in id order.
 */
function backfillAll(db, opts) {
  return db.prepare('SELECT id FROM projects ORDER BY id').all().map((row) => backfillProject(db, row.id, opts));
}

/**
 * Whether a project's legacy file has drifted from the imported policy rows.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @returns {object[]} Empty when no drift.
 */
function detectDrift(db, projectId) {
  const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId);
  if (!project) return [{ code: 'PROJECT_MISSING' }];
  let snapshot;
  try {
    snapshot = readSnapshot(project);
  } catch (error) {
    return [{ code: 'FILE_UNREADABLE', reason: error.message }];
  }
  const rows = db.prepare('SELECT setting_key, policy_value_json FROM project_authority_policies WHERE project_id = ?').all(projectId);
  if (rows.length !== KEYS.length) return [{ code: 'POLICY_INCOMPLETE' }];
  return rows.flatMap((row) => {
    const fileValue = _valueAt(snapshot.data, row.setting_key);
    const value = fileValue === undefined ? _valueAt(projectConfig.DEFAULT_PROJECT_CONFIG, row.setting_key) : fileValue;
    return _equal(value, JSON.parse(row.policy_value_json)) ? [] : [{ code: 'FILE_TAMPER', settingKey: row.setting_key }];
  });
}

/**
 * The one entry point a caller uses instead of reading `project.json`
 * directly for a registered setting — fails closed if the policy row is
 * missing (never silently falls back to the file).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @param {string} key - One of {@link KEYS}.
 * @returns {{ok: boolean, code?: string, value?: *, source?: string, rowVersion?: number}}
 */
function getEffective(db, projectId, key) {
  if (!KEYS.includes(key)) return { ok: false, code: 'UNREGISTERED_SETTING' };
  const row = db.prepare('SELECT * FROM project_authority_policies WHERE project_id = ? AND setting_key = ?').get(projectId, key);
  if (!row) return { ok: false, code: 'POLICY_MISSING' };
  if (key === 'launchSequence.recoveryMode') {
    const pin = db.prepare('SELECT pinned_mode AS pinnedMode, pinned_at AS pinnedAt FROM project_recovery_state WHERE project_id = ?').get(projectId);
    const value = projectConfig.resolveRecoveryMode({ launchSequence: { recoveryMode: JSON.parse(row.policy_value_json) } }, pin).mode;
    return { ok: true, value, source: 'existing-recovery-pin-resolver', rowVersion: row.row_version };
  }
  return { ok: true, value: JSON.parse(row.policy_value_json), source: 'policy-db', rowVersion: row.row_version };
}

/**
 * Write a registered, validated policy setting under optimistic CAS.
 * Deliberately limited to `fleetCoordinator` until an approved field
 * validator exists for every other key.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, key: string, value: *, expectedVersion: number, principalId: string,
 *   requestId: string, auth: {authorize: Function}, operatorProof?: boolean, now?: Function}} args
 * @returns {{ok: boolean, code: string, rowVersion?: number}}
 */
function setPolicy(db, { projectId, key, value, expectedVersion, principalId, requestId, auth, operatorProof = false, now = () => new Date().toISOString() }) {
  if (!KEYS.includes(key) || !Number.isSafeInteger(expectedVersion) || !requestId) return { ok: false, code: 'INVALID_REQUEST' };
  if (key !== 'fleetCoordinator') return { ok: false, code: 'POLICY_VALIDATOR_REQUIRED' };
  if (typeof value !== 'boolean') return { ok: false, code: 'INVALID_VALUE' };
  const verdict = auth.authorize(principalId, 'project.writePolicy', { type: 'project', id: projectId });
  if (!verdict.allowed) return { ok: false, code: verdict.code };
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM project_authority_policies WHERE project_id = ? AND setting_key = ?').get(projectId, key);
    if (!row || row.row_version !== expectedVersion) { db.exec('ROLLBACK'); return { ok: false, code: 'STALE_POLICY' }; }
    if (row.writer_class === 'operator' && !operatorProof) { db.exec('ROLLBACK'); return { ok: false, code: 'OPERATOR_PROOF_REQUIRED' }; }
    if (key === 'launchSequence.recoveryMode') { db.exec('ROLLBACK'); return { ok: false, code: 'USE_EXISTING_RECOVERY_PIN' }; }
    const serialized = JSON.stringify(value);
    const next = expectedVersion + 1;
    db.prepare(
      'UPDATE project_authority_policies SET policy_value_json = ?, row_version = ?, source = ?, changed_at = ?, changed_by = ? WHERE project_id = ? AND setting_key = ? AND row_version = ?'
    ).run(serialized, next, row.writer_class === 'operator' ? 'operator-decision' : 'delegated-api', now(), principalId, projectId, key, expectedVersion);
    db.prepare(
      'INSERT INTO project_authority_policy_events (id, project_id, setting_key, old_version, new_version, old_digest, new_digest, actor, action, outcome, reason_code, request_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(crypto.randomUUID(), projectId, key, expectedVersion, next, _digest(row.policy_value_json), _digest(serialized), principalId, 'set', 'applied', 'CAS_OK', requestId, now());
    db.exec('COMMIT');
    return { ok: true, code: 'UPDATED', rowVersion: next };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Every action `AuthorizationService#authorize` recognizes; anything else is `DEFAULT_DENY`. */
const ACTIONS = new Set([
  'runtime.readOperation', 'runtime.readFinding', 'runtime.readIncident',
  'runtime.createTransition', 'runtime.reconcile', 'runtime.recover',
  'project.readPolicy', 'project.writePolicy',
  'g1.mintLease', 'g1.revokeLease', 'g1.mintApproval', 'g1.revokeApproval'
]);
/** The read-only subset of {@link ACTIONS}, open to any workspace member. */
const READ = new Set(['runtime.readOperation', 'runtime.readFinding', 'runtime.readIncident', 'project.readPolicy']);

/**
 * A default-deny authorization service: a principal must resolve, be scoped
 * to the project's workspace, unexpired, and (for a non-read action) hold
 * owner/admin membership or an exact capability grant.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: Function}} [opts]
 * @returns {{authorize: Function}}
 */
function createAuthorizationService(db, { now = () => new Date().toISOString() } = {}) {
  function authorize(principalId, action, ref) {
    if (!principalId || !ACTIONS.has(action) || ref?.type !== 'project' || !Number.isSafeInteger(ref.id)) {
      return { allowed: false, code: 'DEFAULT_DENY' };
    }
    const principal = db.prepare('SELECT * FROM trusted_principals WHERE id = ? AND revoked_at IS NULL').get(principalId);
    const project = db.prepare(
      'SELECT p.id, w.workspace_id FROM projects p JOIN trusted_project_workspaces w ON w.project_id = p.id WHERE p.id = ?'
    ).get(ref.id);
    if (!principal || !project || principal.workspace_id !== project.workspace_id || (principal.expires_at && principal.expires_at <= now())) {
      return { allowed: false, code: 'SCOPE_DENIED' };
    }
    if (principal.kind === 'user') {
      const membership = db.prepare('SELECT role FROM trusted_memberships WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL')
        .get(project.workspace_id, principal.user_id);
      if (!membership) return { allowed: false, code: 'MEMBERSHIP_DENIED' };
      const allowed = READ.has(action) || ['owner', 'admin'].includes(membership.role);
      return { allowed, code: allowed ? 'USER_ALLOWED' : 'ROLE_DENIED' };
    }
    if (principal.kind === 'agent') {
      const initiator = db.prepare('SELECT * FROM trusted_principals WHERE id = ? AND kind = ? AND revoked_at IS NULL')
        .get(principal.initiating_principal_id, 'user');
      const membership = initiator && db.prepare('SELECT role FROM trusted_memberships WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL')
        .get(project.workspace_id, initiator.user_id);
      if (!membership) return { allowed: false, code: 'INITIATOR_CEILING' };
      if (!READ.has(action) && !['owner', 'admin'].includes(membership.role)) return { allowed: false, code: 'INITIATOR_CEILING' };
    }
    const grant = db.prepare(
      'SELECT * FROM trusted_capability_grants WHERE principal_id = ? AND action = ? AND resource_type = ? AND resource_id = ? AND revoked_at IS NULL'
    ).get(principalId, action, 'project', String(ref.id));
    const allowed = !!grant && (!grant.expires_at || grant.expires_at > now()) && (grant.max_uses === null || grant.uses < grant.max_uses);
    return { allowed, code: allowed ? 'GRANT_ALLOWED' : 'GRANT_DENIED' };
  }
  return { authorize };
}

/**
 * Map a verified launch binding or an authenticated operator session into a
 * trusted principal id — never a request-supplied header.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Function} resolveAccess - The production launch-binding resolver (`sharedDocsAccess.resolveAccess`
 *   or equivalent); injected so this module never requires the route layer.
 * @returns {Function} `(req) => string|null`
 */
function createVerifiedPrincipalResolver(db, resolveAccess) {
  return (req) => {
    const access = resolveAccess(req);
    if (access.kind === 'project' && access.sessionId != null && access.projectId != null) {
      const row = db.prepare('SELECT id FROM trusted_principals WHERE kind = ? AND session_id = ? AND project_id = ? AND revoked_at IS NULL')
        .get('agent', access.sessionId, access.projectId);
      return row?.id ?? null;
    }
    if (access.kind === 'operator' && req.tcSession?.userId != null) {
      const row = db.prepare('SELECT id FROM trusted_principals WHERE kind = ? AND user_id = ? AND revoked_at IS NULL')
        .get('user', req.tcSession.userId);
      return row?.id ?? null;
    }
    return null;
  };
}

/**
 * Mint a Stage 1 operator/coordinator lease for the G1 writer (#1149).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, auth: {authorize: Function}, projectId: number, actor: string,
 *   repo: string, connectionEpoch: number, actions: string[], ttlMs: number, now?: Function,
 *   newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function mintLease(db, { principalId, auth, projectId, actor, repo, connectionEpoch, actions, ttlMs, now = () => Date.now(), newId = crypto.randomUUID }) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || typeof actor !== 'string' || !actor ||
    typeof repo !== 'string' || !repo || !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0 ||
    !Array.isArray(actions) || !actions.length || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const verdict = auth.authorize(principalId, 'g1.mintLease', { type: 'project', id: projectId });
  if (!verdict.allowed) return { ok: false, code: verdict.code };
  const id = newId();
  db.prepare('INSERT INTO v6_g1_leases (id, project_id, actor, repo, connection_epoch, actions_json, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, projectId, actor, repo, connectionEpoch, JSON.stringify(actions), now() + ttlMs);
  return { ok: true, code: 'MINTED', id };
}

/**
 * Revoke a live Stage 1 lease.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, auth: {authorize: Function}, projectId: number, leaseId: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function revokeLease(db, { principalId, auth, projectId, leaseId, now = () => Date.now() }) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || typeof leaseId !== 'string' || !leaseId) return { ok: false, code: 'INVALID_REQUEST' };
  const verdict = auth.authorize(principalId, 'g1.revokeLease', { type: 'project', id: projectId });
  if (!verdict.allowed) return { ok: false, code: verdict.code };
  const changed = db.prepare('UPDATE v6_g1_leases SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL')
    .run(now(), leaseId, projectId).changes;
  return changed === 1 ? { ok: true, code: 'REVOKED' } : { ok: false, code: 'NOT_FOUND_OR_ALREADY_REVOKED' };
}

/**
 * Mint a Tier 3 milestone approval against an exact target digest (#1149).
 * The "distinct signed-in operator" rule (P08) — this approval's minter must
 * differ from whoever minted the lease it backs — is not enforced here: the
 * schema carries no link from an approval back to a specific lease's minting
 * principal, so that check belongs to the authenticated HTTP route layer
 * (BRIDGE-3) that resolves both principals per request.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, auth: {authorize: Function}, projectId: number, operatorActor: string,
 *   action: string, repo: string, targetDigest: string, ttlMs: number, now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function mintApproval(db, { principalId, auth, projectId, operatorActor, action, repo, targetDigest, ttlMs, now = () => Date.now(), newId = crypto.randomUUID }) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || typeof operatorActor !== 'string' || !operatorActor ||
    typeof action !== 'string' || !action || typeof repo !== 'string' || !repo ||
    typeof targetDigest !== 'string' || !targetDigest || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const verdict = auth.authorize(principalId, 'g1.mintApproval', { type: 'project', id: projectId });
  if (!verdict.allowed) return { ok: false, code: verdict.code };
  const id = newId();
  db.prepare('INSERT INTO v6_g1_approvals (id, project_id, operator_actor, action, repo, target_digest, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, projectId, operatorActor, action, repo, targetDigest, now() + ttlMs);
  return { ok: true, code: 'MINTED', id };
}

/**
 * Revoke a live, unconsumed approval.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, auth: {authorize: Function}, projectId: number, approvalId: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function revokeApproval(db, { principalId, auth, projectId, approvalId, now = () => Date.now() }) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || typeof approvalId !== 'string' || !approvalId) return { ok: false, code: 'INVALID_REQUEST' };
  const verdict = auth.authorize(principalId, 'g1.revokeApproval', { type: 'project', id: projectId });
  if (!verdict.allowed) return { ok: false, code: verdict.code };
  const changed = db.prepare('UPDATE v6_g1_approvals SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL AND consumed_at IS NULL')
    .run(now(), approvalId, projectId).changes;
  return changed === 1 ? { ok: true, code: 'REVOKED' } : { ok: false, code: 'NOT_FOUND_OR_ALREADY_RESOLVED' };
}

module.exports = {
  KEYS,
  backfillProject,
  backfillAll,
  detectDrift,
  getEffective,
  setPolicy,
  ACTIONS,
  createAuthorizationService,
  createVerifiedPrincipalResolver,
  mintLease,
  revokeLease,
  mintApproval,
  revokeApproval
};
