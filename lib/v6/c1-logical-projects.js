'use strict';

/**
 * v6 Stage 1 (#2118, V6-05 / C1, BRIDGE-1b): the Unified Logical Project →
 * Fleet → Resource Module / Checkout / Role Lease / Shared Asset hierarchy
 * service.
 *
 * The DDL lives in `lib/store/_schema.js#_v6C1LogicalProjectHierarchyDdl`,
 * not here — this module only ever receives an already-migrated `db`. It
 * is ported near-verbatim in SHAPE from BRIDGE-1a's `lib/v6/authority-
 * service.js`/`lib/v6/transition-ledger.js` (`{ok, code}` returns,
 * `crypto.randomUUID()` ids, injectable `now`/`newId`, an immediate
 * transaction around every multi-statement write), the house style this
 * repo's v6 modules already share — not a new convention invented here.
 *
 * `v6_authority_grants` (mint/revoke below) is a DIFFERENT concept from
 * BRIDGE-1a's `project_authority_policies`: that is a server-pinned
 * settings registry per legacy project; this is a per-OPERATION,
 * per-fleet/project authority grant (fleet provision, resource reserve/
 * activate, role lease, settings write, session failover), expiring and
 * checked against a fleet's live `policy_revision` at mint time. Neither
 * supersedes the other, and this module does not itself gate any OTHER
 * function here behind a live grant — wiring "every write here requires a
 * held grant" is the authenticated HTTP route layer's job (a later
 * integration bridge, the same deferral BRIDGE-1a's own module already
 * states for its own `g1.*` mint/revoke pair), not this car's file
 * envelope.
 *
 * Every lifecycle transition (`setFleetState`, `setResourceDesiredState`)
 * is CAS-guarded against the row's own `policy_revision`/`row_version` and
 * validated against an explicit edge table — an unlisted transition is
 * refused (`INVALID_TRANSITION`), never silently coerced.
 *
 * @module lib/v6/c1-logical-projects
 */

const crypto = require('node:crypto');

/**
 * Run `fn` inside an immediate transaction, rolling back on throw.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Function} fn
 * @returns {*}
 */
function _tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Run `fn`, translating a SQLite UNIQUE/CHECK constraint violation into `{ok: false, code}` instead of throwing. */
function _guardConflict(fn, code) {
  try {
    return fn();
  } catch (error) {
    if (error && typeof error.message === 'string' && /UNIQUE constraint failed|CHECK constraint failed/.test(error.message)) {
      return { ok: false, code };
    }
    throw error;
  }
}

const NON_BLANK = (s) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 160;

// ── Logical Projects ────────────────────────────────────────────────────

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{displayName: string, origin: ('legacy'|'native'), now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function createLogicalProject(db, { displayName, origin, now = () => new Date().toISOString(), newId = crypto.randomUUID }) {
  if (!NON_BLANK(displayName) || !['legacy', 'native'].includes(origin)) return { ok: false, code: 'INVALID_REQUEST' };
  const id = newId();
  db.prepare('INSERT INTO v6_logical_projects (id, display_name, state, origin, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, displayName, 'active', origin, now(), now());
  return { ok: true, code: 'CREATED', id };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {object|undefined}
 */
function getLogicalProject(db, id) {
  return db.prepare('SELECT * FROM v6_logical_projects WHERE id = ?').get(id);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, nextState: ('active'|'archived'), now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function setLogicalProjectState(db, { id, nextState, now = () => new Date().toISOString() }) {
  if (!['active', 'archived'].includes(nextState)) return { ok: false, code: 'INVALID_REQUEST' };
  const changed = db.prepare('UPDATE v6_logical_projects SET state = ?, updated_at = ? WHERE id = ? AND state != ?')
    .run(nextState, now(), id, nextState).changes;
  return changed === 1 ? { ok: true, code: 'UPDATED' } : { ok: false, code: 'NOT_FOUND_OR_UNCHANGED' };
}

// ── Fleets ───────────────────────────────────────────────────────────────

/** Every valid `v6_fleets.state` edge; an unlisted pair is `INVALID_TRANSITION`. */
const FLEET_EDGES = new Set(['draft>active', 'active>paused', 'paused>active', 'draft>retired', 'active>retired', 'paused>retired']);

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{logicalProjectId: string, displayName: string, templateId?: string, templateVersion?: number,
 *   now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function createFleet(db, { logicalProjectId, displayName, templateId = null, templateVersion = null, now = () => new Date().toISOString(), newId = crypto.randomUUID }) {
  if (!logicalProjectId || !NON_BLANK(displayName)) return { ok: false, code: 'INVALID_REQUEST' };
  const project = getLogicalProject(db, logicalProjectId);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  const id = newId();
  return _guardConflict(() => {
    db.prepare(
      'INSERT INTO v6_fleets (id, logical_project_id, display_name, template_id, template_version, state, policy_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, logicalProjectId, displayName, templateId, templateVersion, 'draft', 1, now(), now());
    return { ok: true, code: 'CREATED', id };
  }, 'DISPLAY_NAME_TAKEN');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {object|undefined}
 */
function getFleet(db, id) {
  return db.prepare('SELECT * FROM v6_fleets WHERE id = ?').get(id);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, logicalProjectId: string, nextState: string, expectedPolicyRevision: number, now?: Function}} args
 * @returns {{ok: boolean, code: string, policyRevision?: number}}
 */
function setFleetState(db, { id, logicalProjectId, nextState, expectedPolicyRevision, now = () => new Date().toISOString() }) {
  const fleet = getFleet(db, id);
  if (!fleet || fleet.logical_project_id !== logicalProjectId) return { ok: false, code: 'NOT_FOUND' };
  if (!FLEET_EDGES.has(`${fleet.state}>${nextState}`)) return { ok: false, code: 'INVALID_TRANSITION' };
  const next = expectedPolicyRevision + 1;
  const changed = db.prepare(
    'UPDATE v6_fleets SET state = ?, policy_revision = ?, updated_at = ? WHERE id = ? AND policy_revision = ?'
  ).run(nextState, next, now(), id, expectedPolicyRevision).changes;
  return changed === 1 ? { ok: true, code: 'UPDATED', policyRevision: next } : { ok: false, code: 'STALE_POLICY_REVISION' };
}

// ── Resource Modules ────────────────────────────────────────────────────

const RESOURCE_KINDS = ['harness', 'master', 'advisor', 'mcp', 'external'];
/** Every valid `v6_resources.desired_state` edge; an unlisted pair is `INVALID_TRANSITION`. */
const RESOURCE_EDGES = new Set([
  'available>reserved', 'reserved>starting', 'reserved>available',
  'starting>ready', 'starting>available', 'ready>assigned', 'ready>available',
  'assigned>held', 'assigned>available', 'held>assigned', 'held>retiring',
  'assigned>retiring', 'ready>retiring', 'reserved>retiring', 'starting>retiring',
  'retiring>retired'
]);

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{logicalProjectId: string, fleetId?: string, kind: string, displayName: string,
 *   legacyProjectId?: number, now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function createResource(db, { logicalProjectId, fleetId = null, kind, displayName, legacyProjectId = null, now = () => new Date().toISOString(), newId = crypto.randomUUID }) {
  if (!logicalProjectId || !RESOURCE_KINDS.includes(kind) || !NON_BLANK(displayName)) return { ok: false, code: 'INVALID_REQUEST' };
  if (!getLogicalProject(db, logicalProjectId)) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  if (fleetId) {
    const fleet = getFleet(db, fleetId);
    if (!fleet || fleet.logical_project_id !== logicalProjectId) return { ok: false, code: 'FLEET_NOT_FOUND' };
  }
  const id = newId();
  return _guardConflict(() => {
    db.prepare(
      'INSERT INTO v6_resources (id, logical_project_id, fleet_id, kind, display_name, desired_state, legacy_project_id, row_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(id, logicalProjectId, fleetId, kind, displayName, 'available', legacyProjectId, 1, now(), now());
    return { ok: true, code: 'CREATED', id };
  }, 'LEGACY_PROJECT_ALREADY_MAPPED');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {object|undefined}
 */
function getResource(db, id) {
  return db.prepare('SELECT * FROM v6_resources WHERE id = ?').get(id);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, logicalProjectId: string, nextState: string, expectedRowVersion: number, now?: Function}} args
 * @returns {{ok: boolean, code: string, rowVersion?: number}}
 */
function setResourceDesiredState(db, { id, logicalProjectId, nextState, expectedRowVersion, now = () => new Date().toISOString() }) {
  const resource = getResource(db, id);
  if (!resource || resource.logical_project_id !== logicalProjectId) return { ok: false, code: 'NOT_FOUND' };
  if (!RESOURCE_EDGES.has(`${resource.desired_state}>${nextState}`)) return { ok: false, code: 'INVALID_TRANSITION' };
  const next = expectedRowVersion + 1;
  const changed = db.prepare(
    'UPDATE v6_resources SET desired_state = ?, row_version = ?, updated_at = ? WHERE id = ? AND row_version = ?'
  ).run(nextState, next, now(), id, expectedRowVersion).changes;
  return changed === 1 ? { ok: true, code: 'UPDATED', rowVersion: next } : { ok: false, code: 'STALE_ROW_VERSION' };
}

// ── Checkouts ────────────────────────────────────────────────────────────

const CHECKOUT_KINDS = ['primary', 'worktree', 'clone', 'external'];

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{logicalProjectId: string, resourceId?: string, absolutePath: string, repositoryKey?: string,
 *   kind: string, legacyProjectId?: number, now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function createCheckout(db, { logicalProjectId, resourceId = null, absolutePath, repositoryKey = null, kind, legacyProjectId = null, now = () => new Date().toISOString(), newId = crypto.randomUUID }) {
  if (!logicalProjectId || typeof absolutePath !== 'string' || !absolutePath.startsWith('/') || !CHECKOUT_KINDS.includes(kind)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (!getLogicalProject(db, logicalProjectId)) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  if (resourceId) {
    const resource = getResource(db, resourceId);
    if (!resource || resource.logical_project_id !== logicalProjectId) return { ok: false, code: 'RESOURCE_NOT_FOUND' };
  }
  const id = newId();
  return _guardConflict(() => {
    db.prepare(
      'INSERT INTO v6_checkouts (id, logical_project_id, resource_id, legacy_project_id, absolute_path, repository_key, kind, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(id, logicalProjectId, resourceId, legacyProjectId, absolutePath, repositoryKey, kind, 'present', now(), now());
    return { ok: true, code: 'CREATED', id };
  }, 'ABSOLUTE_PATH_TAKEN');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, logicalProjectId: string, nextState: ('present'|'missing'|'retired'), now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function setCheckoutState(db, { id, logicalProjectId, nextState, now = () => new Date().toISOString() }) {
  if (!['present', 'missing', 'retired'].includes(nextState)) return { ok: false, code: 'INVALID_REQUEST' };
  const changed = db.prepare('UPDATE v6_checkouts SET state = ?, updated_at = ? WHERE id = ? AND logical_project_id = ? AND state != ?')
    .run(nextState, now(), id, logicalProjectId, nextState).changes;
  return changed === 1 ? { ok: true, code: 'UPDATED' } : { ok: false, code: 'NOT_FOUND_OR_UNCHANGED' };
}

// ── Role Leases ──────────────────────────────────────────────────────────

/**
 * Propose a role lease. Refused with `ROLE_CONFLICT` if the resource
 * already holds a live (`active`/`held`) lease, or (for an exclusive
 * lease) the domain already has a live exclusive owner in this project —
 * both enforced by `v6_role_leases`' own partial unique indexes, not
 * re-derived here.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{resourceId: string, logicalProjectId: string, fleetId?: string, roleKey: string, domainKey: string,
 *   exclusive?: boolean, issuedByPrincipal: string, startsAt?: string, endsAt?: string,
 *   now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function createRoleLease(db, {
  resourceId, logicalProjectId, fleetId = null, roleKey, domainKey, exclusive = false,
  issuedByPrincipal, startsAt = null, endsAt = null, now = () => new Date().toISOString(), newId = crypto.randomUUID
}) {
  if (!resourceId || !logicalProjectId || !NON_BLANK(roleKey) || !NON_BLANK(domainKey) || !NON_BLANK(issuedByPrincipal)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const resource = getResource(db, resourceId);
  if (!resource || resource.logical_project_id !== logicalProjectId) return { ok: false, code: 'RESOURCE_NOT_FOUND' };
  const id = newId();
  return _guardConflict(() => {
    db.prepare(
      'INSERT INTO v6_role_leases (id, resource_id, logical_project_id, fleet_id, role_key, domain_key, exclusive, state, lease_generation, issued_by_principal, starts_at, ends_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(id, resourceId, logicalProjectId, fleetId, roleKey, domainKey, exclusive ? 1 : 0, 'active', 1, issuedByPrincipal, startsAt, endsAt, now(), now());
    return { ok: true, code: 'CREATED', id };
  }, 'ROLE_CONFLICT');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, resourceId: string, outcome: ('ended'|'revoked'), now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function closeRoleLease(db, { id, resourceId, outcome, now = () => new Date().toISOString() }) {
  if (!['ended', 'revoked'].includes(outcome)) return { ok: false, code: 'INVALID_REQUEST' };
  const changed = db.prepare(
    "UPDATE v6_role_leases SET state = ?, updated_at = ? WHERE id = ? AND resource_id = ? AND state IN ('proposed','active','held')"
  ).run(outcome, now(), id, resourceId).changes;
  return changed === 1 ? { ok: true, code: 'CLOSED' } : { ok: false, code: 'NOT_FOUND_OR_ALREADY_CLOSED' };
}

// ── Shared Assets ────────────────────────────────────────────────────────

const ASSET_KINDS = ['document', 'rule', 'plan', 'config', 'artifact'];
const ASSET_CLASSIFICATIONS = ['public', 'project', 'restricted', 'secret'];

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ownerProjectId: string, kind: string, classification?: string, displayName: string,
 *   canonicalRef: string, legacySharedDocumentId?: string, now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function createSharedAsset(db, {
  ownerProjectId, kind, classification = 'project', displayName, canonicalRef,
  legacySharedDocumentId = null, now = () => new Date().toISOString(), newId = crypto.randomUUID
}) {
  if (!ownerProjectId || !ASSET_KINDS.includes(kind) || !ASSET_CLASSIFICATIONS.includes(classification) ||
    !NON_BLANK(displayName) || typeof canonicalRef !== 'string' || !canonicalRef) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (!getLogicalProject(db, ownerProjectId)) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  const id = newId();
  return _guardConflict(() => {
    db.prepare(
      'INSERT INTO v6_shared_assets (id, owner_project_id, kind, classification, display_name, canonical_ref, legacy_shared_document_id, asset_revision, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(id, ownerProjectId, kind, classification, displayName, canonicalRef, legacySharedDocumentId, 1, 'active', now(), now());
    return { ok: true, code: 'CREATED', id };
  }, 'CANONICAL_REF_TAKEN');
}

/**
 * Grant another logical project access to a shared asset. Refused with
 * `GRANT_EXISTS` if the grantee already holds a live active grant on this
 * asset (`v6_one_active_asset_grant`) — revoke the existing one first to
 * change access level.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{assetId: string, granteeProjectId: string, access: ('read'|'write'), grantedByPrincipal: string,
 *   expiresAt?: string, now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function grantAssetAccess(db, { assetId, granteeProjectId, access, grantedByPrincipal, expiresAt = null, now = () => new Date().toISOString(), newId = crypto.randomUUID }) {
  if (!assetId || !granteeProjectId || !['read', 'write'].includes(access) || !NON_BLANK(grantedByPrincipal)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const asset = db.prepare('SELECT 1 FROM v6_shared_assets WHERE id = ?').get(assetId);
  if (!asset) return { ok: false, code: 'ASSET_NOT_FOUND' };
  if (!getLogicalProject(db, granteeProjectId)) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  const id = newId();
  return _guardConflict(() => {
    db.prepare(
      'INSERT INTO v6_asset_grants (id, asset_id, grantee_project_id, access, granted_by_principal, grant_revision, state, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(id, assetId, granteeProjectId, access, grantedByPrincipal, 1, 'active', expiresAt, now(), now());
    return { ok: true, code: 'CREATED', id };
  }, 'GRANT_EXISTS');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, assetId: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function revokeAssetGrant(db, { id, assetId, now = () => new Date().toISOString() }) {
  const changed = db.prepare("UPDATE v6_asset_grants SET state = 'revoked', updated_at = ? WHERE id = ? AND asset_id = ? AND state = 'active'")
    .run(now(), id, assetId).changes;
  return changed === 1 ? { ok: true, code: 'REVOKED' } : { ok: false, code: 'NOT_FOUND_OR_ALREADY_REVOKED' };
}

// ── Authority Grants ─────────────────────────────────────────────────────

const AUTHORITY_OPERATIONS = ['fleet.provision', 'resource.reserve', 'resource.activate', 'role.lease', 'settings.write', 'session.failover'];

/**
 * Mint a fleet/resource authority grant, checked against the fleet's own
 * LIVE `policy_revision` at mint time (a grant minted against a stale
 * revision is refused — the caller re-reads the fleet and retries with the
 * current one, the same CAS discipline {@link setFleetState} enforces on
 * writes). No OTHER function in this module currently checks a live grant
 * before acting — see this module's own doc comment for why that wiring is
 * deferred to a later integration bridge.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principal: string, logicalProjectId: string, fleetId?: string, operation: string,
 *   limits?: object, expectedPolicyRevision: number, issuedByPrincipal: string, expiresAt?: string,
 *   now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function grantAuthority(db, {
  principal, logicalProjectId, fleetId = null, operation, limits = {}, expectedPolicyRevision,
  issuedByPrincipal, expiresAt = null, now = () => new Date().toISOString(), newId = crypto.randomUUID
}) {
  if (!NON_BLANK(principal) || !logicalProjectId || !AUTHORITY_OPERATIONS.includes(operation) ||
    !Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision <= 0 || !NON_BLANK(issuedByPrincipal)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (!getLogicalProject(db, logicalProjectId)) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  if (fleetId) {
    const fleet = getFleet(db, fleetId);
    if (!fleet || fleet.logical_project_id !== logicalProjectId) return { ok: false, code: 'FLEET_NOT_FOUND' };
    if (fleet.policy_revision !== expectedPolicyRevision) return { ok: false, code: 'STALE_POLICY_REVISION' };
  }
  const id = newId();
  db.prepare(
    'INSERT INTO v6_authority_grants (id, principal, logical_project_id, fleet_id, operation, limits_json, expected_policy_revision, state, issued_by_principal, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, principal, logicalProjectId, fleetId, operation, JSON.stringify(limits), expectedPolicyRevision, 'active', issuedByPrincipal, expiresAt, now(), now());
  return { ok: true, code: 'MINTED', id };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, logicalProjectId: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function revokeAuthority(db, { id, logicalProjectId, now = () => new Date().toISOString() }) {
  const changed = db.prepare("UPDATE v6_authority_grants SET state = 'revoked', updated_at = ? WHERE id = ? AND logical_project_id = ? AND state = 'active'")
    .run(now(), id, logicalProjectId).changes;
  return changed === 1 ? { ok: true, code: 'REVOKED' } : { ok: false, code: 'NOT_FOUND_OR_ALREADY_RESOLVED' };
}

// ── Composite read ───────────────────────────────────────────────────────

/**
 * The whole hierarchy under one logical project, read-only — every fleet,
 * resource, checkout and live role lease. Not itself transactional; a
 * caller that needs a point-in-time-consistent snapshot wraps this in its
 * own `_tx`/read-transaction.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} logicalProjectId
 * @returns {{project: object, fleets: object[], resources: object[], checkouts: object[], roleLeases: object[]}|null}
 */
function getHierarchy(db, logicalProjectId) {
  const project = getLogicalProject(db, logicalProjectId);
  if (!project) return null;
  return {
    project,
    fleets: db.prepare('SELECT * FROM v6_fleets WHERE logical_project_id = ? ORDER BY created_at').all(logicalProjectId),
    resources: db.prepare('SELECT * FROM v6_resources WHERE logical_project_id = ? ORDER BY created_at').all(logicalProjectId),
    checkouts: db.prepare('SELECT * FROM v6_checkouts WHERE logical_project_id = ? ORDER BY created_at').all(logicalProjectId),
    roleLeases: db.prepare("SELECT * FROM v6_role_leases WHERE logical_project_id = ? AND state IN ('proposed','active','held') ORDER BY created_at").all(logicalProjectId)
  };
}

module.exports = {
  createLogicalProject, getLogicalProject, setLogicalProjectState,
  createFleet, getFleet, setFleetState,
  createResource, getResource, setResourceDesiredState,
  createCheckout, setCheckoutState,
  createRoleLease, closeRoleLease,
  createSharedAsset, grantAssetAccess, revokeAssetGrant,
  grantAuthority, revokeAuthority,
  getHierarchy
};
