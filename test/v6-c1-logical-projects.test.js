'use strict';

// v6 Stage 1 (#2118, V6-05 / C1, BRIDGE-1b): the v80→v81 Unified Logical
// Project → Fleet → Resource Module / Checkout / Role Lease / Shared Asset
// hierarchy schema (lib/store/_schema.js) plus lib/v6/c1-logical-projects.js,
// against a real node:sqlite-backed store. Sequenced after BRIDGE-1a (PR
// #3008) — this file does not retest trusted_*/runtime_*/reconciliation_*/
// incident_*/v6_g1_* (that is test/v6-stage1-authority-ledger-incidents.test.js's
// own coverage), only the C1 hierarchy and the legacy-project backfill/trigger.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const c1 = require('../lib/v6/c1-logical-projects');

const C1_TABLES = [
  'v6_logical_projects', 'v6_fleets', 'v6_resources', 'v6_checkouts',
  'v6_legacy_project_map', 'v6_role_leases', 'v6_shared_assets',
  'v6_asset_grants', 'v6_authority_grants'
];

let tmpDir = null;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-c1-hierarchy-'));
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

function cleanup() {
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

/** @returns {string} A fresh logical project id. */
function seedProject(db, displayName = 'demo') {
  const r = c1.createLogicalProject(db, { displayName, origin: 'native' });
  assert.equal(r.ok, true);
  return r.id;
}

describe('v6 C1 schema (#2118, BRIDGE-1b): every table exists and the legacy backfill/trigger work', () => {
  it('every C1 table exists after _createTables, and twice in a row is a no-op', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const table of C1_TABLES) assert.ok(existing.has(table), `${table} missing`);
    assert.doesNotThrow(() => store.init());
  });

  it('a pre-existing legacy project is backfilled into v6_logical_projects/v6_resources/v6_checkouts/v6_legacy_project_map', (t) => {
    const db = freshStore();
    t.after(cleanup);
    db.exec(`INSERT INTO projects (name, path, archived) VALUES ('legacy-one', '${path.join(tmpDir, 'legacy-one')}', 0)`);
    const legacyId = db.prepare("SELECT id FROM projects WHERE name = 'legacy-one'").get().id;
    const lp = db.prepare('SELECT * FROM v6_logical_projects WHERE id = ?').get(`lp-${legacyId}`);
    assert.ok(lp, 'logical project row missing');
    assert.equal(lp.origin, 'legacy');
    assert.equal(lp.state, 'active');
    const resource = db.prepare('SELECT * FROM v6_resources WHERE legacy_project_id = ?').get(legacyId);
    assert.ok(resource);
    assert.equal(resource.kind, 'harness');
    const checkout = db.prepare('SELECT * FROM v6_checkouts WHERE legacy_project_id = ?').get(legacyId);
    assert.ok(checkout);
    const map = db.prepare('SELECT * FROM v6_legacy_project_map WHERE legacy_project_id = ?').get(legacyId);
    assert.equal(map.logical_project_id, `lp-${legacyId}`);
    const view = db.prepare('SELECT * FROM v6_legacy_project_view WHERE legacy_project_id = ?').get(legacyId);
    assert.equal(view.legacy_name, 'legacy-one');
  });

  it('an archived legacy project backfills with state archived', (t) => {
    const db = freshStore();
    t.after(cleanup);
    db.exec(`INSERT INTO projects (name, path, archived) VALUES ('legacy-archived', '${path.join(tmpDir, 'legacy-archived')}', 1)`);
    const legacyId = db.prepare("SELECT id FROM projects WHERE name = 'legacy-archived'").get().id;
    const lp = db.prepare('SELECT * FROM v6_logical_projects WHERE id = ?').get(`lp-${legacyId}`);
    assert.equal(lp.state, 'archived');
  });

  it('deleting a legacy project cleans up its v6_checkouts/v6_resources/v6_logical_projects backfill, so creating a NEW project at the same path does not collide (Architect Ruling A543, PR #3009 R5)', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projPath = path.join(tmpDir, 'sr-proj');
    fs.mkdirSync(projPath, { recursive: true });

    const p1 = store.projects.create({ name: 'sr-proj', path: projPath, engine: 'claude' });
    assert.ok(db.prepare('SELECT 1 FROM v6_checkouts WHERE legacy_project_id = ?').get(p1.id), 'checkout not backfilled');

    store.projects.delete(p1.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM v6_checkouts WHERE id = ?').get(`co-legacy-${p1.id}`).n, 0, 'orphaned checkout survived delete');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM v6_resources WHERE id = ?').get(`res-legacy-${p1.id}`).n, 0, 'orphaned resource survived delete');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM v6_logical_projects WHERE id = ?').get(`lp-${p1.id}`).n, 0, 'orphaned logical project survived delete');

    // The real-world repro (test/engines.test.js, test/sessions.test.js's own
    // beforeEach/afterEach fixtures): the exact same path must be reusable.
    const p2 = store.projects.create({ name: 'sr-proj', path: projPath, engine: 'claude' });
    assert.ok(p2.id, 'recreating at the same path after delete must not throw DUPLICATE_NAME');
    assert.ok(db.prepare('SELECT 1 FROM v6_checkouts WHERE legacy_project_id = ?').get(p2.id));
  });

  it('deleting a legacy project preserves its C1 backfill when a native fleet/resource/lease/asset/grant has since grown on top of it', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projPath = path.join(tmpDir, 'sr-proj-grown');
    fs.mkdirSync(projPath, { recursive: true });
    const p1 = store.projects.create({ name: 'sr-proj-grown', path: projPath, engine: 'claude' });
    const logicalProjectId = `lp-${p1.id}`;

    const fleet = c1.createFleet(db, { logicalProjectId, displayName: 'Native Fleet' });
    assert.equal(fleet.ok, true);

    store.projects.delete(p1.id);
    // The checkout/resource backfill specific to the legacy mapping is still
    // torn down, but the logical project itself survives because a native
    // fleet now depends on it -- deleting it would orphan the fleet.
    assert.equal(db.prepare('SELECT COUNT(*) n FROM v6_checkouts WHERE id = ?').get(`co-legacy-${p1.id}`).n, 0);
    assert.ok(db.prepare('SELECT 1 FROM v6_logical_projects WHERE id = ?').get(logicalProjectId), 'logical project with a live native fleet must survive');
    assert.ok(db.prepare('SELECT 1 FROM v6_fleets WHERE id = ?').get(fleet.id), 'the native fleet itself must be untouched');
  });
});

describe('createLogicalProject / getLogicalProject / setLogicalProjectState', () => {
  it('creates, reads, and archives a logical project', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const r = c1.createLogicalProject(db, { displayName: 'Native Project', origin: 'native' });
    assert.equal(r.ok, true);
    assert.equal(c1.getLogicalProject(db, r.id).display_name, 'Native Project');
    assert.equal(c1.setLogicalProjectState(db, { id: r.id, nextState: 'archived' }).ok, true);
    assert.equal(c1.getLogicalProject(db, r.id).state, 'archived');
    assert.equal(c1.setLogicalProjectState(db, { id: r.id, nextState: 'archived' }).code, 'NOT_FOUND_OR_UNCHANGED');
  });

  it('rejects an invalid origin or blank display name', (t) => {
    const db = freshStore();
    t.after(cleanup);
    assert.equal(c1.createLogicalProject(db, { displayName: 'x', origin: 'bogus' }).code, 'INVALID_REQUEST');
    assert.equal(c1.createLogicalProject(db, { displayName: '  ', origin: 'native' }).code, 'INVALID_REQUEST');
  });
});

describe('createFleet / setFleetState (CAS on policy_revision, validated transition graph)', () => {
  it('creates a fleet in draft and walks draft→active→paused→active→retired', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const fleet = c1.createFleet(db, { logicalProjectId: projectId, displayName: 'Fleet One' });
    assert.equal(fleet.ok, true);
    assert.equal(c1.getFleet(db, fleet.id).state, 'draft');

    let r = c1.setFleetState(db, { id: fleet.id, logicalProjectId: projectId, nextState: 'active', expectedPolicyRevision: 1 });
    assert.deepEqual(r, { ok: true, code: 'UPDATED', policyRevision: 2 });
    r = c1.setFleetState(db, { id: fleet.id, logicalProjectId: projectId, nextState: 'paused', expectedPolicyRevision: 2 });
    assert.equal(r.ok, true);
    r = c1.setFleetState(db, { id: fleet.id, logicalProjectId: projectId, nextState: 'active', expectedPolicyRevision: 3 });
    assert.equal(r.ok, true);
    r = c1.setFleetState(db, { id: fleet.id, logicalProjectId: projectId, nextState: 'retired', expectedPolicyRevision: 4 });
    assert.equal(r.ok, true);
    assert.equal(c1.getFleet(db, fleet.id).state, 'retired');
  });

  it('refuses an unlisted transition and a stale policy_revision', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const fleet = c1.createFleet(db, { logicalProjectId: projectId, displayName: 'Fleet Two' });
    assert.equal(c1.setFleetState(db, { id: fleet.id, logicalProjectId: projectId, nextState: 'retired', expectedPolicyRevision: 1 }).ok, true);
    // retired is terminal: draft>retired is a listed edge, but retired>active is not.
    assert.equal(
      c1.setFleetState(db, { id: fleet.id, logicalProjectId: projectId, nextState: 'active', expectedPolicyRevision: 2 }).code,
      'INVALID_TRANSITION'
    );
    const fleet2 = c1.createFleet(db, { logicalProjectId: projectId, displayName: 'Fleet Three' });
    assert.equal(
      c1.setFleetState(db, { id: fleet2.id, logicalProjectId: projectId, nextState: 'active', expectedPolicyRevision: 99 }).code,
      'STALE_POLICY_REVISION'
    );
  });

  it('refuses a second fleet with the same display name in one project', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    assert.equal(c1.createFleet(db, { logicalProjectId: projectId, displayName: 'Dup' }).ok, true);
    assert.equal(c1.createFleet(db, { logicalProjectId: projectId, displayName: 'Dup' }).code, 'DISPLAY_NAME_TAKEN');
  });

  it('refuses a fleet under a project that does not exist', (t) => {
    const db = freshStore();
    t.after(cleanup);
    assert.equal(c1.createFleet(db, { logicalProjectId: 'lp-missing', displayName: 'X' }).code, 'PROJECT_NOT_FOUND');
  });
});

describe('createResource / setResourceDesiredState (CAS on row_version, validated transition graph)', () => {
  it('creates a resource and walks available→reserved→starting→ready→assigned→held→retiring→retired', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const resource = c1.createResource(db, { logicalProjectId: projectId, kind: 'harness', displayName: 'Res One' });
    assert.equal(resource.ok, true);
    assert.equal(c1.getResource(db, resource.id).desired_state, 'available');

    const path_ = ['reserved', 'starting', 'ready', 'assigned', 'held', 'retiring', 'retired'];
    let version = 1;
    for (const nextState of path_) {
      const r = c1.setResourceDesiredState(db, { id: resource.id, logicalProjectId: projectId, nextState, expectedRowVersion: version });
      assert.equal(r.ok, true, `transition to ${nextState} failed: ${r.code}`);
      version = r.rowVersion;
    }
    assert.equal(c1.getResource(db, resource.id).desired_state, 'retired');
  });

  it('a resource may attach to a fleet in the same project, and refuses a fleet in a different one', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectA = seedProject(db, 'A');
    const projectB = seedProject(db, 'B');
    const fleetA = c1.createFleet(db, { logicalProjectId: projectA, displayName: 'Fleet A' });
    const resource = c1.createResource(db, { logicalProjectId: projectA, fleetId: fleetA.id, kind: 'master', displayName: 'Res' });
    assert.equal(resource.ok, true);
    assert.equal(c1.getResource(db, resource.id).fleet_id, fleetA.id);

    const fleetB = c1.createFleet(db, { logicalProjectId: projectB, displayName: 'Fleet B' });
    assert.equal(
      c1.createResource(db, { logicalProjectId: projectA, fleetId: fleetB.id, kind: 'master', displayName: 'Res2' }).code,
      'FLEET_NOT_FOUND'
    );
  });

  it('refuses an invalid kind and an invalid transition', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    assert.equal(c1.createResource(db, { logicalProjectId: projectId, kind: 'bogus', displayName: 'X' }).code, 'INVALID_REQUEST');
    const resource = c1.createResource(db, { logicalProjectId: projectId, kind: 'mcp', displayName: 'Y' });
    assert.equal(
      c1.setResourceDesiredState(db, { id: resource.id, logicalProjectId: projectId, nextState: 'retired', expectedRowVersion: 1 }).code,
      'INVALID_TRANSITION'
    );
  });

  it('refuses binding the same legacy_project_id to two resources', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    // legacy_project_id is a real FK into `projects`, so the uniqueness test needs
    // an actual row there (the legacy-project insert trigger backfills its own
    // resource for it — a SECOND manual createResource against the same id is
    // what exercises the UNIQUE constraint this test is for).
    db.exec(`INSERT INTO projects (name, path, archived) VALUES ('legacy-dup-target', '${path.join(tmpDir, 'legacy-dup-target')}', 0)`);
    const legacyId = db.prepare("SELECT id FROM projects WHERE name = 'legacy-dup-target'").get().id;
    assert.equal(
      c1.createResource(db, { logicalProjectId: projectId, kind: 'harness', displayName: 'Y', legacyProjectId: legacyId }).code,
      'LEGACY_PROJECT_ALREADY_MAPPED'
    );
  });
});

describe('createCheckout / setCheckoutState', () => {
  it('creates a checkout attached to a resource, and transitions its state', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const resource = c1.createResource(db, { logicalProjectId: projectId, kind: 'harness', displayName: 'R' });
    const checkout = c1.createCheckout(db, { logicalProjectId: projectId, resourceId: resource.id, absolutePath: '/tmp/x-checkout', kind: 'worktree' });
    assert.equal(checkout.ok, true);
    assert.equal(c1.setCheckoutState(db, { id: checkout.id, logicalProjectId: projectId, nextState: 'retired' }).ok, true);
  });

  it('refuses a non-absolute path and a duplicate absolute_path', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    assert.equal(c1.createCheckout(db, { logicalProjectId: projectId, absolutePath: 'relative/path', kind: 'clone' }).code, 'INVALID_REQUEST');
    assert.equal(c1.createCheckout(db, { logicalProjectId: projectId, absolutePath: '/tmp/dup-checkout', kind: 'clone' }).ok, true);
    assert.equal(c1.createCheckout(db, { logicalProjectId: projectId, absolutePath: '/tmp/dup-checkout', kind: 'clone' }).code, 'ABSOLUTE_PATH_TAKEN');
  });
});

describe('createRoleLease / closeRoleLease (one live role per resource, one exclusive domain owner)', () => {
  it('proposes an exclusive lease and refuses a second live lease on the same resource', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const resource = c1.createResource(db, { logicalProjectId: projectId, kind: 'harness', displayName: 'R' });
    const lease = c1.createRoleLease(db, {
      resourceId: resource.id, logicalProjectId: projectId, roleKey: 'builder', domainKey: 'lib/v6/**',
      exclusive: true, issuedByPrincipal: 'arc'
    });
    assert.equal(lease.ok, true);
    assert.equal(
      c1.createRoleLease(db, {
        resourceId: resource.id, logicalProjectId: projectId, roleKey: 'reviewer', domainKey: 'lib/v6/**',
        issuedByPrincipal: 'arc'
      }).code,
      'ROLE_CONFLICT'
    );
    assert.equal(c1.closeRoleLease(db, { id: lease.id, resourceId: resource.id, outcome: 'ended' }).ok, true);
    // Now the resource is free again.
    assert.equal(
      c1.createRoleLease(db, {
        resourceId: resource.id, logicalProjectId: projectId, roleKey: 'reviewer', domainKey: 'lib/v6/**',
        issuedByPrincipal: 'arc'
      }).ok,
      true
    );
  });

  it('refuses a second exclusive lease over the same domain on a DIFFERENT resource in the same project', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const resourceA = c1.createResource(db, { logicalProjectId: projectId, kind: 'harness', displayName: 'A' });
    const resourceB = c1.createResource(db, { logicalProjectId: projectId, kind: 'harness', displayName: 'B' });
    assert.equal(
      c1.createRoleLease(db, {
        resourceId: resourceA.id, logicalProjectId: projectId, roleKey: 'builder', domainKey: 'lib/v6/**',
        exclusive: true, issuedByPrincipal: 'arc'
      }).ok,
      true
    );
    assert.equal(
      c1.createRoleLease(db, {
        resourceId: resourceB.id, logicalProjectId: projectId, roleKey: 'builder', domainKey: 'lib/v6/**',
        exclusive: true, issuedByPrincipal: 'arc'
      }).code,
      'ROLE_CONFLICT'
    );
  });

  it('closing an unknown lease is NOT_FOUND_OR_ALREADY_CLOSED', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const resource = c1.createResource(db, { logicalProjectId: projectId, kind: 'harness', displayName: 'R' });
    assert.equal(c1.closeRoleLease(db, { id: 'nope', resourceId: resource.id, outcome: 'revoked' }).code, 'NOT_FOUND_OR_ALREADY_CLOSED');
  });
});

describe('createSharedAsset / grantAssetAccess / revokeAssetGrant', () => {
  it('creates an asset, grants read access, and refuses a second live grant to the same grantee', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const owner = seedProject(db, 'owner');
    const grantee = seedProject(db, 'grantee');
    const asset = c1.createSharedAsset(db, { ownerProjectId: owner, kind: 'plan', displayName: 'Plan A', canonicalRef: 'plan-a.md' });
    assert.equal(asset.ok, true);
    const grant = c1.grantAssetAccess(db, { assetId: asset.id, granteeProjectId: grantee, access: 'read', grantedByPrincipal: 'pm' });
    assert.equal(grant.ok, true);
    assert.equal(
      c1.grantAssetAccess(db, { assetId: asset.id, granteeProjectId: grantee, access: 'write', grantedByPrincipal: 'pm' }).code,
      'GRANT_EXISTS'
    );
    assert.equal(c1.revokeAssetGrant(db, { id: grant.id, assetId: asset.id }).ok, true);
    assert.equal(c1.grantAssetAccess(db, { assetId: asset.id, granteeProjectId: grantee, access: 'write', grantedByPrincipal: 'pm' }).ok, true);
  });

  it('refuses a second asset with the same canonical_ref under the same owner', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const owner = seedProject(db, 'owner2');
    assert.equal(c1.createSharedAsset(db, { ownerProjectId: owner, kind: 'rule', displayName: 'R', canonicalRef: 'dup.md' }).ok, true);
    assert.equal(c1.createSharedAsset(db, { ownerProjectId: owner, kind: 'rule', displayName: 'R2', canonicalRef: 'dup.md' }).code, 'CANONICAL_REF_TAKEN');
  });
});

describe('grantAuthority / revokeAuthority', () => {
  it('mints a project-scoped grant, and a fleet-scoped grant checked against the live policy_revision', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    const projectGrant = c1.grantAuthority(db, {
      principal: 'tc-lane-d', logicalProjectId: projectId, operation: 'settings.write',
      expectedPolicyRevision: 1, issuedByPrincipal: 'pm'
    });
    assert.equal(projectGrant.ok, true);
    assert.equal(c1.revokeAuthority(db, { id: projectGrant.id, logicalProjectId: projectId }).ok, true);

    const fleet = c1.createFleet(db, { logicalProjectId: projectId, displayName: 'F' });
    const fleetGrant = c1.grantAuthority(db, {
      principal: 'tc-lane-d', logicalProjectId: projectId, fleetId: fleet.id, operation: 'fleet.provision',
      expectedPolicyRevision: fleet.ok && 1, issuedByPrincipal: 'pm'
    });
    assert.equal(fleetGrant.ok, true);
    assert.equal(
      c1.grantAuthority(db, {
        principal: 'tc-lane-d', logicalProjectId: projectId, fleetId: fleet.id, operation: 'fleet.provision',
        expectedPolicyRevision: 99, issuedByPrincipal: 'pm'
      }).code,
      'STALE_POLICY_REVISION'
    );
  });

  it('refuses an unknown operation', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const projectId = seedProject(db);
    assert.equal(
      c1.grantAuthority(db, { principal: 'x', logicalProjectId: projectId, operation: 'bogus.op', expectedPolicyRevision: 1, issuedByPrincipal: 'pm' }).code,
      'INVALID_REQUEST'
    );
  });
});

describe('getHierarchy', () => {
  it('returns null for an unknown project, and the nested shape for a real one', (t) => {
    const db = freshStore();
    t.after(cleanup);
    assert.equal(c1.getHierarchy(db, 'lp-missing'), null);

    const projectId = seedProject(db);
    const fleet = c1.createFleet(db, { logicalProjectId: projectId, displayName: 'F' });
    const resource = c1.createResource(db, { logicalProjectId: projectId, fleetId: fleet.id, kind: 'harness', displayName: 'R' });
    c1.createCheckout(db, { logicalProjectId: projectId, resourceId: resource.id, absolutePath: '/tmp/h', kind: 'worktree' });
    c1.createRoleLease(db, { resourceId: resource.id, logicalProjectId: projectId, roleKey: 'builder', domainKey: 'lib/**', issuedByPrincipal: 'arc' });

    const h = c1.getHierarchy(db, projectId);
    assert.equal(h.project.id, projectId);
    assert.equal(h.fleets.length, 1);
    assert.equal(h.resources.length, 1);
    assert.equal(h.checkouts.length, 1);
    assert.equal(h.roleLeases.length, 1);
  });
});
