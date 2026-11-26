'use strict';

/**
 * Explicit fleet delegate assignment (#3263, V6-010, Car V663-W1-B) —
 * `lib/delegate-assignment.js`, against a real isolated SQLite store and
 * real (temp-directory) project.json files, the same isolation pattern
 * `test/coordinator-rotation.test.js` uses for `store._setBasePath`.
 * Medium tier: opens a real `node:sqlite` database.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { DelegateAssignmentError, assignFleetDelegate } = require('../lib/delegate-assignment');

const OPERATOR = { kind: 'operator' };
const NOT_OPERATOR = { kind: 'project', projectId: 999 };

describe('assignFleetDelegate (#3263)', () => {
  let prevBase;
  let tempDir;
  const projectDirs = [];
  let pm;
  let member1;
  let member2;

  /** A fresh real temp project directory, tracked for cleanup. */
  function mkProjectDir(name) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tc-delegate-${name}-`)));
    projectDirs.push(dir);
    return dir;
  }

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-delegate-home-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const dir of projectDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  let uniq = 0;

  beforeEach(() => {
    for (const t of ['coordinator_roles']) store.getDb().prepare(`DELETE FROM ${t}`).run();
    uniq += 1;
    pm = store.projects.create({ name: `PM-${uniq}`, path: mkProjectDir('pm'), engine: 'claude' });
    member1 = store.projects.create({ name: `Lane-A-${uniq}`, path: mkProjectDir('a'), engine: 'claude' });
    member2 = store.projects.create({ name: `Lane-B-${uniq}`, path: mkProjectDir('b'), engine: 'claude' });
  });

  it('grants the coordinator role and sets fleetCoordinator on a fresh delegate with no predecessor', () => {
    const result = assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [member1.id, member2.id] }, OPERATOR);
    assert.equal(result.ok, true);
    assert.equal(result.controlAssignmentsPending, true);
    assert.deepEqual(result.steps.map((s) => s.step), [
      'grantCoordinatorRole', 'setNewFleetCoordinatorFlag', 'updateMemberCoordinatorProject', 'updateMemberCoordinatorProject'
    ]);
    assert.ok(result.steps.every((s) => s.ok));

    const role = store.coordinatorRoles.getActiveForProject(pm.id);
    assert.equal(role.role, 'project-manager');

    const pmConfig = store.projectConfig.load(pm.path);
    assert.equal(pmConfig.fleetCoordinator, true);

    for (const member of [member1, member2]) {
      const config = store.projectConfig.load(member.path);
      assert.equal(config.workloadNudge.coordinatorProject, pm.name);
    }
  });

  it('revokes the old delegate\'s role and clears its fleetCoordinator flag when one is named', () => {
    // Seed the OLD delegate as if it were already the active coordinator.
    assignFleetDelegate({ newDelegateProjectId: member1.id, memberProjectIds: [] }, OPERATOR);
    assert.equal(store.coordinatorRoles.getActiveForProject(member1.id).role, 'project-manager');

    const result = assignFleetDelegate(
      { newDelegateProjectId: member2.id, oldDelegateProjectId: member1.id, memberProjectIds: [pm.id] }, OPERATOR
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.steps.map((s) => s.step), [
      'grantCoordinatorRole', 'revokeOldCoordinatorRole', 'clearOldFleetCoordinatorFlag', 'setNewFleetCoordinatorFlag', 'updateMemberCoordinatorProject'
    ]);

    assert.equal(store.coordinatorRoles.getActiveForProject(member1.id), null);
    assert.equal(store.coordinatorRoles.getActiveForProject(member2.id).role, 'project-manager');
    assert.equal(store.projectConfig.load(member1.path).fleetCoordinator, false);
    assert.equal(store.projectConfig.load(member2.path).fleetCoordinator, true);
    assert.equal(store.projectConfig.load(pm.path).workloadNudge.coordinatorProject, member2.name);
  });

  it('treats a named old delegate that already holds no active role as nothing to undo, not a failure', () => {
    // member1 never actually held a role (no seed grant this time).
    const result = assignFleetDelegate(
      { newDelegateProjectId: member2.id, oldDelegateProjectId: member1.id, memberProjectIds: [] }, OPERATOR
    );
    assert.equal(result.ok, true);
    const revokeStep = result.steps.find((s) => s.step === 'revokeOldCoordinatorRole');
    assert.equal(revokeStep.ok, true);
    assert.equal(revokeStep.detail.code, 'ROLE_NOT_FOUND');
    // Old delegate's fleetCoordinator flag is still cleared even though it held no role.
    assert.equal(store.projectConfig.load(member1.path).fleetCoordinator, false);
  });

  it('stops at the first failing step and reports exactly which steps ran, never claiming full success', () => {
    const result = assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [] }, NOT_OPERATOR);
    assert.equal(result.ok, false);
    assert.equal(result.controlAssignmentsPending, true);
    assert.deepEqual(result.steps.map((s) => s.step), ['grantCoordinatorRole']);
    assert.equal(result.steps[0].ok, false);
    assert.equal(result.steps[0].detail.code, 'OPERATOR_ONLY');
    // No fleetCoordinator/workloadNudge writes happened once the first step failed.
    assert.equal(store.projectConfig.load(pm.path).fleetCoordinator, false);
  });

  it('records a failing projectConfig write as a failed step rather than throwing (#3263 PRR-B R2)', () => {
    // A project whose `.path` is actually a FILE, not a directory: `load()`
    // stays safe (returns defaults, same as a missing path), but `save()`'s
    // `fs.mkdirSync(path.join(path, '.tangleclaw'))` throws ENOTDIR -- a
    // real filesystem failure, not a simulated one.
    const brokenPath = path.join(os.tmpdir(), `tc-delegate-broken-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(brokenPath, 'not a directory');
    try {
      const broken = store.projects.create({ name: `Broken-${uniq}`, path: brokenPath, engine: 'claude' });
      const result = assignFleetDelegate({ newDelegateProjectId: broken.id, memberProjectIds: [] }, OPERATOR);
      assert.equal(result.ok, false);
      assert.equal(result.controlAssignmentsPending, true);
      const failed = result.steps.find((s) => !s.ok);
      assert.equal(failed.step, 'setNewFleetCoordinatorFlag');
      assert.match(failed.detail.error, /ENOTDIR/);
      // The coordinator role WAS granted (an earlier step) before the config write failed.
      assert.equal(store.coordinatorRoles.getActiveForProject(broken.id).role, 'project-manager');
    } finally {
      fs.rmSync(brokenPath, { force: true });
    }
  });

  it('records a failing MEMBER projectConfig write as a failed step too, not just the delegate\'s own', () => {
    const brokenPath = path.join(os.tmpdir(), `tc-delegate-broken-member-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(brokenPath, 'not a directory');
    try {
      const brokenMember = store.projects.create({ name: `BrokenMember-${uniq}`, path: brokenPath, engine: 'claude' });
      const result = assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [brokenMember.id] }, OPERATOR);
      assert.equal(result.ok, false);
      const failed = result.steps.find((s) => !s.ok);
      assert.equal(failed.step, 'updateMemberCoordinatorProject');
      assert.match(failed.detail.error, /ENOTDIR/);
      // The delegate's own grant + fleetCoordinator flag already committed before the member write failed.
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id).role, 'project-manager');
      assert.equal(store.projectConfig.load(pm.path).fleetCoordinator, true);
    } finally {
      fs.rmSync(brokenPath, { force: true });
    }
  });

  it('refuses an invalid member project id before any step runs, leaving no partial state', () => {
    assert.throws(
      () => assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [999999] }, OPERATOR),
      (err) => err instanceof DelegateAssignmentError && err.code === 'PROJECT_NOT_FOUND' && err.status === 404
    );
    assert.equal(store.coordinatorRoles.getActiveForProject(pm.id), null);
  });

  it('refuses a non-integer newDelegateProjectId', () => {
    assert.throws(
      () => assignFleetDelegate({ newDelegateProjectId: 'nope' }, OPERATOR),
      (err) => err instanceof DelegateAssignmentError && err.code === 'PROJECT_ID_INVALID'
    );
  });

  it('refuses a non-array memberProjectIds', () => {
    assert.throws(
      () => assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: 'not-an-array' }, OPERATOR),
      (err) => err instanceof DelegateAssignmentError && err.code === 'MEMBER_IDS_INVALID'
    );
  });

  it('defaults memberProjectIds to empty and oldDelegateProjectId to null when omitted', () => {
    const result = assignFleetDelegate({ newDelegateProjectId: pm.id }, OPERATOR);
    assert.equal(result.ok, true);
    assert.equal(result.oldDelegateProjectId, null);
    assert.deepEqual(result.steps.map((s) => s.step), ['grantCoordinatorRole', 'setNewFleetCoordinatorFlag']);
  });

  it('preserves every other key already in a member\'s workloadNudge setting', () => {
    const existing = store.projectConfig.load(member1.path);
    store.projectConfig.save(member1.path, { ...existing, workloadNudge: { enabled: true, text: 'custom nudge', escalateAfterMinutes: 30 } });
    assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [member1.id] }, OPERATOR);
    const after = store.projectConfig.load(member1.path);
    assert.equal(after.workloadNudge.enabled, true);
    assert.equal(after.workloadNudge.text, 'custom nudge');
    assert.equal(after.workloadNudge.escalateAfterMinutes, 30);
    assert.equal(after.workloadNudge.coordinatorProject, pm.name);
  });

  it('DelegateAssignmentError carries code, status and detail', () => {
    const err = new DelegateAssignmentError('SOME_CODE', 'a message', 404, { x: 1 });
    assert.equal(err.name, 'DelegateAssignmentError');
    assert.equal(err.code, 'SOME_CODE');
    assert.equal(err.status, 404);
    assert.deepEqual(err.detail, { x: 1 });
    assert.ok(err instanceof Error);
  });

  it('defaults status to 400 when not given', () => {
    const err = new DelegateAssignmentError('SOME_CODE', 'a message');
    assert.equal(err.status, 400);
  });
});
