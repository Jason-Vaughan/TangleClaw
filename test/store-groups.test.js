'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.projectGroups', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-groups-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a group with name and description', () => {
      const group = store.projectGroups.create({ name: 'shared-infra', description: 'Shared infra' });
      assert.ok(group.id);
      assert.equal(group.name, 'shared-infra');
      assert.equal(group.description, 'Shared infra');
      assert.ok(group.createdAt);
    });

    it('should trim whitespace from name', () => {
      const group = store.projectGroups.create({ name: '  shared-infra  ' });
      assert.equal(group.name, 'shared-infra');
    });

    it('should reject empty name', () => {
      assert.throws(() => store.projectGroups.create({ name: '' }), { code: 'BAD_REQUEST' });
      assert.throws(() => store.projectGroups.create({ name: '   ' }), { code: 'BAD_REQUEST' });
    });

    it('should reject duplicate name', () => {
      store.projectGroups.create({ name: 'shared-infra' });
      assert.throws(() => store.projectGroups.create({ name: 'shared-infra' }), { code: 'CONFLICT' });
    });
  });

  describe('get', () => {
    it('should return group by id', () => {
      const created = store.projectGroups.create({ name: 'shared-infra' });
      const fetched = store.projectGroups.get(created.id);
      assert.equal(fetched.name, 'shared-infra');
    });

    it('should return null for non-existent id', () => {
      assert.equal(store.projectGroups.get('nonexistent'), null);
    });
  });

  describe('list', () => {
    it('should return all groups sorted by name', () => {
      store.projectGroups.create({ name: 'zebra' });
      store.projectGroups.create({ name: 'alpha' });
      const groups = store.projectGroups.list();
      assert.equal(groups.length, 2);
      assert.equal(groups[0].name, 'alpha');
      assert.equal(groups[1].name, 'zebra');
    });

    it('should return empty array when no groups', () => {
      assert.deepEqual(store.projectGroups.list(), []);
    });
  });

  describe('update', () => {
    it('should update name and description', () => {
      const group = store.projectGroups.create({ name: 'old', description: 'old desc' });
      const updated = store.projectGroups.update(group.id, { name: 'new', description: 'new desc' });
      assert.equal(updated.name, 'new');
      assert.equal(updated.description, 'new desc');
    });

    it('should reject update to duplicate name', () => {
      const g1 = store.projectGroups.create({ name: 'alpha' });
      store.projectGroups.create({ name: 'beta' });
      assert.throws(() => store.projectGroups.update(g1.id, { name: 'beta' }), { code: 'CONFLICT' });
    });

    it('should throw NOT_FOUND for non-existent group', () => {
      assert.throws(() => store.projectGroups.update('fake', { name: 'x' }), { code: 'NOT_FOUND' });
    });
  });

  describe('delete', () => {
    it('should delete a group', () => {
      const group = store.projectGroups.create({ name: 'shared-infra' });
      store.projectGroups.delete(group.id);
      assert.equal(store.projectGroups.get(group.id), null);
    });

    it('should throw NOT_FOUND for non-existent group', () => {
      assert.throws(() => store.projectGroups.delete('fake'), { code: 'NOT_FOUND' });
    });

    it('should cascade delete members', () => {
      const group = store.projectGroups.create({ name: 'shared-infra' });
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      store.projectGroups.addMember(group.id, proj.id);
      assert.equal(store.projectGroups.listMembers(group.id).length, 1);
      store.projectGroups.delete(group.id);
      assert.equal(store.projectGroups.listMembers(group.id).length, 0);
    });
  });

  describe('sharedDir field', () => {
    it('should create a group with sharedDir', () => {
      const group = store.projectGroups.create({ name: 'with-dir', sharedDir: '/tmp/shared-docs' });
      assert.equal(group.sharedDir, '/tmp/shared-docs');
    });

    it('should default sharedDir to null', () => {
      const group = store.projectGroups.create({ name: 'no-dir' });
      assert.equal(group.sharedDir, null);
    });

    it('should update sharedDir', () => {
      const group = store.projectGroups.create({ name: 'update-dir' });
      assert.equal(group.sharedDir, null);
      const updated = store.projectGroups.update(group.id, { sharedDir: '/new/path' });
      assert.equal(updated.sharedDir, '/new/path');
    });

    it('should clear sharedDir with empty string', () => {
      const group = store.projectGroups.create({ name: 'clear-dir', sharedDir: '/some/path' });
      const updated = store.projectGroups.update(group.id, { sharedDir: '' });
      assert.equal(updated.sharedDir, null);
    });
  });

  describe('members', () => {
    it('should add and list members', () => {
      const group = store.projectGroups.create({ name: 'shared-infra' });
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      store.projectGroups.addMember(group.id, proj.id);
      const members = store.projectGroups.listMembers(group.id);
      assert.equal(members.length, 1);
      assert.equal(members[0], proj.id);
    });

    it('should be idempotent when adding same member twice', () => {
      const group = store.projectGroups.create({ name: 'shared-infra' });
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      store.projectGroups.addMember(group.id, proj.id);
      store.projectGroups.addMember(group.id, proj.id); // No throw
      assert.equal(store.projectGroups.listMembers(group.id).length, 1);
    });

    it('should remove a member', () => {
      const group = store.projectGroups.create({ name: 'shared-infra' });
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      store.projectGroups.addMember(group.id, proj.id);
      store.projectGroups.removeMember(group.id, proj.id);
      assert.equal(store.projectGroups.listMembers(group.id).length, 0);
    });

    it('should get groups by project', () => {
      const g1 = store.projectGroups.create({ name: 'alpha' });
      const g2 = store.projectGroups.create({ name: 'beta' });
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      store.projectGroups.addMember(g1.id, proj.id);
      store.projectGroups.addMember(g2.id, proj.id);

      const groups = store.projectGroups.getByProject(proj.id);
      assert.equal(groups.length, 2);
      assert.equal(groups[0].name, 'alpha');
      assert.equal(groups[1].name, 'beta');
    });

    it('should return empty when project has no groups', () => {
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      assert.deepEqual(store.projectGroups.getByProject(proj.id), []);
    });

    it('does not auto-claim a new vacant group when the project already defers to a different group\'s owner (#1697)', () => {
      const groupA = store.projectGroups.create({ name: 'fleet-a' });
      const groupB = store.projectGroups.create({ name: 'fleet-b' });
      const owner = store.projects.create({ name: 'OwnerProj', path: '/tmp/owner' });
      const member = store.projects.create({ name: 'MemberProj', path: '/tmp/member' });

      // Both projects resolve to the release-capable 'operator' default with
      // no on-disk config (#1702), so the owner auto-claims groupA the moment
      // it joins — the same auto-claim this test's fix still has to apply.
      store.projectGroups.addMember(groupA.id, owner.id);
      assert.equal(store.projectGroups.get(groupA.id).releaseOwnerProjectId, owner.id);

      // member joins groupA too (fine — groupA already has an owner, and
      // member isn't it), then joins a SECOND, vacant group. Before the fix,
      // addMember claimed groupB for member purely because it was vacant,
      // with no check that member already defers elsewhere; that let the
      // same project hold release authority in two groups at once.
      store.projectGroups.addMember(groupA.id, member.id);
      store.projectGroups.addMember(groupB.id, member.id);
      assert.equal(store.projectGroups.get(groupB.id).releaseOwnerProjectId, null,
        'groupB must stay vacant — member already defers to groupA\'s owner');
    });

    it('still lets a project with no owner elsewhere claim a vacant group it joins', () => {
      const group = store.projectGroups.create({ name: 'fleet-solo' });
      const proj = store.projects.create({ name: 'SoloProj', path: '/tmp/solo' });
      store.projectGroups.addMember(group.id, proj.id);
      assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, proj.id);
    });
  });

  describe('safeFindReleaseOwnerElsewhere (#1697)', () => {
    it('passes through a successful lookup unchanged, with unresolvable: false', () => {
      const group = store.projectGroups.create({ name: 'fleet-safe-ok' });
      const owner = store.projects.create({ name: 'SafeOwner', path: '/tmp/safe-owner' });
      const member = store.projects.create({ name: 'SafeMember', path: '/tmp/safe-member' });
      store.projectGroups.addMember(group.id, owner.id); // auto-claims
      store.projectGroups.addMember(group.id, member.id);

      const direct = store.projectGroups.findReleaseOwnerElsewhere(member.id);
      const safe = store.projectGroups.safeFindReleaseOwnerElsewhere(member.id);
      assert.deepEqual(safe, { elsewhere: direct, unresolvable: false });
      assert.equal(safe.elsewhere.ownerProjectId, owner.id);
    });

    it('fails CLOSED (unresolvable: true, elsewhere: null) when the underlying lookup throws', () => {
      const proj = store.projects.create({ name: 'SafeFail', path: '/tmp/safe-fail' });
      const saved = store.projectGroups.findReleaseOwnerElsewhere;
      store.projectGroups.findReleaseOwnerElsewhere = () => { throw new Error('simulated DB failure'); };
      try {
        assert.deepEqual(
          store.projectGroups.safeFindReleaseOwnerElsewhere(proj.id),
          { elsewhere: null, unresolvable: true }
        );
      } finally {
        store.projectGroups.findReleaseOwnerElsewhere = saved;
      }
    });

    it('treats NOT_INITIALIZED as "no group feature active," not unresolvable', () => {
      const proj = store.projects.create({ name: 'SafeNotInit', path: '/tmp/safe-not-init' });
      const saved = store.projectGroups.findReleaseOwnerElsewhere;
      store.projectGroups.findReleaseOwnerElsewhere = () => {
        const err = new Error('store not initialized');
        err.code = 'NOT_INITIALIZED';
        throw err;
      };
      try {
        assert.deepEqual(
          store.projectGroups.safeFindReleaseOwnerElsewhere(proj.id),
          { elsewhere: null, unresolvable: false }
        );
      } finally {
        store.projectGroups.findReleaseOwnerElsewhere = saved;
      }
    });
  });
});
