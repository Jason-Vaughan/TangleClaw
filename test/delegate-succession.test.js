'use strict';

/**
 * Delegate role succession & surrogate hierarchy (#3272, V6-028, Car
 * V664-W1-B) — `lib/delegate-succession.js`, against a real isolated
 * SQLite store, the same isolation pattern `test/delegate-assignment.test.js`
 * uses. Medium tier: opens a real `node:sqlite` database.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const coordinatorRotation = require('../lib/coordinator-rotation');
const { DelegateSuccessionError, nextSurrogate, failoverToSurrogate, recoverToPrimary } = require('../lib/delegate-succession');
const { assignFleetDelegate } = require('../lib/delegate-assignment');

const OPERATOR = { kind: 'operator' };

/**
 * Grant `projectId` the active project-manager role DIRECTLY (bypassing
 * `assignFleetDelegate`'s own revoke-the-old-holder step), so a test can
 * construct genuine split-brain: `coordinator_roles`' unique index is
 * per-project, never global, so two independent grants really do leave
 * two different projects simultaneously active (#3272 PRR-B R2).
 * @param {number} projectId
 * @returns {void}
 */
function grantDirectly(projectId) {
  const result = coordinatorRotation.grantRole({ caller: OPERATOR, body: { projectId, role: 'project-manager' } });
  assert.equal(result.status, 201, 'test setup: the direct grant itself must succeed');
}

describe('delegate succession (#3272)', () => {
  let prevBase;
  let tempDir;
  const projectDirs = [];
  let pm;
  let arc;
  let surrogate2;
  let member;

  function mkProjectDir(name) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tc-succession-${name}-`)));
    projectDirs.push(dir);
    return dir;
  }

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-succession-home-'));
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
    store.getDb().prepare('DELETE FROM coordinator_roles').run();
    uniq += 1;
    pm = store.projects.create({ name: `PM-${uniq}`, path: mkProjectDir('pm'), engine: 'claude' });
    arc = store.projects.create({ name: `Arc-${uniq}`, path: mkProjectDir('arc'), engine: 'claude' });
    surrogate2 = store.projects.create({ name: `Surrogate2-${uniq}`, path: mkProjectDir('s2'), engine: 'claude' });
    member = store.projects.create({ name: `Member-${uniq}`, path: mkProjectDir('member'), engine: 'claude' });
  });

  describe('nextSurrogate (pure)', () => {
    it('returns the entry right after the current one', () => {
      assert.equal(nextSurrogate([1, 2, 3], 1), 2);
      assert.equal(nextSurrogate([1, 2, 3], 2), 3);
    });
    it('returns null at the end of the chain', () => {
      assert.equal(nextSurrogate([1, 2, 3], 3), null);
    });
    it('returns null when the current project is not in the chain at all', () => {
      assert.equal(nextSurrogate([1, 2, 3], 999), null);
    });
  });

  describe('failoverToSurrogate', () => {
    it('transfers from the live active delegate to the next surrogate in the chain', () => {
      assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [member.id] }, OPERATOR);
      const result = failoverToSurrogate({ chain: [pm.id, arc.id, surrogate2.id], currentProjectId: pm.id, memberProjectIds: [member.id] }, OPERATOR);
      assert.equal(result.ok, true);
      assert.equal(result.from, pm.id);
      assert.equal(result.to, arc.id);
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id), null);
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id).role, 'project-manager');
      assert.equal(store.projectConfig.load(member.path).workloadNudge.coordinatorProject, arc.name);
    });

    it('refuses when currentProjectId is not genuinely the live active delegate (split-brain guard)', () => {
      // Nobody holds the role at all.
      assert.throws(
        () => failoverToSurrogate({ chain: [pm.id, arc.id], currentProjectId: pm.id, memberProjectIds: [] }, OPERATOR),
        (err) => err instanceof DelegateSuccessionError && err.code === 'CURRENT_NOT_LIVE_DELEGATE' && err.status === 409
      );
    });

    it('refuses when a DIFFERENT project already holds the role than the caller believes', () => {
      // arc is actually live, but the caller still believes pm is.
      assignFleetDelegate({ newDelegateProjectId: arc.id, memberProjectIds: [] }, OPERATOR);
      assert.throws(
        () => failoverToSurrogate({ chain: [pm.id, arc.id], currentProjectId: pm.id, memberProjectIds: [] }, OPERATOR),
        (err) => err instanceof DelegateSuccessionError && err.code === 'CURRENT_NOT_LIVE_DELEGATE'
      );
      // Nothing was transferred as a result of the refused attempt.
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id).role, 'project-manager');
    });

    it('refuses with SPLIT_BRAIN_DETECTED when another chain member is ALSO currently active (#3272 PRR-B R2)', () => {
      // pm is believed-current, but arc independently also holds the role --
      // a true split-brain, not just a stale belief (CURRENT_NOT_LIVE_DELEGATE
      // only fires when the BELIEVED-current one itself isn't active).
      grantDirectly(pm.id);
      grantDirectly(arc.id);
      assert.throws(
        () => failoverToSurrogate({ chain: [pm.id, arc.id, surrogate2.id], currentProjectId: pm.id, memberProjectIds: [] }, OPERATOR),
        (err) => {
          assert.ok(err instanceof DelegateSuccessionError);
          assert.equal(err.code, 'SPLIT_BRAIN_DETECTED');
          assert.equal(err.status, 409);
          assert.deepEqual(err.detail.alsoActive, [arc.id]);
          return true;
        }
      );
      // Nothing was transferred as a result of the refused attempt.
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id).role, 'project-manager');
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id).role, 'project-manager');
    });

    it('refuses when the chain names no surrogate after the current project (end of chain)', () => {
      assignFleetDelegate({ newDelegateProjectId: surrogate2.id, memberProjectIds: [] }, OPERATOR);
      assert.throws(
        () => failoverToSurrogate({ chain: [pm.id, arc.id, surrogate2.id], currentProjectId: surrogate2.id, memberProjectIds: [] }, OPERATOR),
        (err) => err instanceof DelegateSuccessionError && err.code === 'NO_SURROGATE_AVAILABLE' && err.status === 409
      );
    });

    for (const [name, chain, code] of [
      ['empty chain', [], 'CHAIN_REQUIRED'],
      ['non-array chain', 'nope', 'CHAIN_REQUIRED'],
      ['non-integer entry', [1, 'two'], 'CHAIN_INVALID'],
      ['duplicate entries', [1, 2, 1], 'CHAIN_DUPLICATE']
    ]) {
      it(`refuses a malformed chain: ${name}`, () => {
        assert.throws(
          () => failoverToSurrogate({ chain, currentProjectId: 1, memberProjectIds: [] }, OPERATOR),
          (err) => err instanceof DelegateSuccessionError && err.code === code
        );
      });
    }
  });

  describe('recoverToPrimary', () => {
    it('is a no-op when the primary already holds the live active delegate role', () => {
      assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [] }, OPERATOR);
      const result = recoverToPrimary({ chain: [pm.id, arc.id], memberProjectIds: [] }, OPERATOR);
      assert.deepEqual(result, { ok: true, noop: true, from: null, to: pm.id, assignment: null, revokedExtraneous: [] });
    });

    it('transfers back from whichever surrogate is currently active to the primary', () => {
      assignFleetDelegate({ newDelegateProjectId: arc.id, memberProjectIds: [member.id] }, OPERATOR);
      const result = recoverToPrimary({ chain: [pm.id, arc.id, surrogate2.id], memberProjectIds: [member.id] }, OPERATOR);
      assert.equal(result.ok, true);
      assert.equal(result.noop, false);
      assert.equal(result.from, arc.id);
      assert.equal(result.to, pm.id);
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id), null);
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id).role, 'project-manager');
      assert.equal(store.projectConfig.load(member.path).workloadNudge.coordinatorProject, pm.name);
    });

    it('recovers cleanly even when nobody in the chain currently holds the role', () => {
      const result = recoverToPrimary({ chain: [pm.id, arc.id], memberProjectIds: [] }, OPERATOR);
      assert.equal(result.ok, true);
      assert.equal(result.from, null);
      assert.equal(result.to, pm.id);
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id).role, 'project-manager');
    });

    it('reconciles true split-brain: revokes a surrogate ALSO active alongside the primary (#3272 PRR-B R2)', () => {
      // Both pm (primary) AND arc independently hold the role at once --
      // the old no-op check ("is primary active?") would have stopped here
      // and left arc's lingering role in place.
      grantDirectly(pm.id);
      grantDirectly(arc.id);
      const result = recoverToPrimary({ chain: [pm.id, arc.id], memberProjectIds: [] }, OPERATOR);
      assert.equal(result.ok, true);
      assert.equal(result.noop, false);
      assert.equal(result.from, arc.id);
      assert.equal(result.to, pm.id);
      assert.deepEqual(result.revokedExtraneous, [{ projectId: arc.id, ok: true, detail: result.revokedExtraneous[0].detail }]);
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id), null);
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id).role, 'project-manager');
    });

    it('reconciles true split-brain with TWO extraneous active surrogates, revoking both', () => {
      grantDirectly(pm.id);
      grantDirectly(arc.id);
      grantDirectly(surrogate2.id);
      const result = recoverToPrimary({ chain: [pm.id, arc.id, surrogate2.id], memberProjectIds: [] }, OPERATOR);
      assert.equal(result.ok, true);
      assert.deepEqual(result.revokedExtraneous.map((r) => r.projectId).sort(), [arc.id, surrogate2.id].sort());
      assert.ok(result.revokedExtraneous.every((r) => r.ok));
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id), null);
      assert.equal(store.coordinatorRoles.getActiveForProject(surrogate2.id), null);
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id).role, 'project-manager');
    });

    it('refuses a malformed chain', () => {
      assert.throws(
        () => recoverToPrimary({ chain: [], memberProjectIds: [] }, OPERATOR),
        (err) => err instanceof DelegateSuccessionError && err.code === 'CHAIN_REQUIRED'
      );
    });
  });

  describe('a full failover-then-recovery cycle leaves no trace of split-brain', () => {
    it('PM fails over to Arc, then recovers back to PM, each step verified against the live store', () => {
      assignFleetDelegate({ newDelegateProjectId: pm.id, memberProjectIds: [member.id] }, OPERATOR);

      const failover = failoverToSurrogate({ chain: [pm.id, arc.id, surrogate2.id], currentProjectId: pm.id, memberProjectIds: [member.id] }, OPERATOR);
      assert.equal(failover.to, arc.id);
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id), null);
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id).role, 'project-manager');

      const recovery = recoverToPrimary({ chain: [pm.id, arc.id, surrogate2.id], memberProjectIds: [member.id] }, OPERATOR);
      assert.equal(recovery.from, arc.id);
      assert.equal(recovery.to, pm.id);
      assert.equal(store.coordinatorRoles.getActiveForProject(arc.id), null);
      assert.equal(store.coordinatorRoles.getActiveForProject(pm.id).role, 'project-manager');

      // Exactly one project holds the role at every point -- never zero, never two.
    });
  });

  describe('DelegateSuccessionError', () => {
    it('carries code, status and detail', () => {
      const err = new DelegateSuccessionError('SOME_CODE', 'a message', 409, { x: 1 });
      assert.equal(err.name, 'DelegateSuccessionError');
      assert.equal(err.code, 'SOME_CODE');
      assert.equal(err.status, 409);
      assert.deepEqual(err.detail, { x: 1 });
      assert.ok(err instanceof Error);
    });

    it('defaults status to 400 when not given', () => {
      const err = new DelegateSuccessionError('SOME_CODE', 'a message');
      assert.equal(err.status, 400);
    });
  });
});
