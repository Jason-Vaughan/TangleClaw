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
      const group = store.projectGroups.create({ name: 'habitat', description: 'Habitat infra' });
      assert.ok(group.id);
      assert.equal(group.name, 'habitat');
      assert.equal(group.description, 'Habitat infra');
      assert.ok(group.createdAt);
    });

    it('should trim whitespace from name', () => {
      const group = store.projectGroups.create({ name: '  habitat  ' });
      assert.equal(group.name, 'habitat');
    });

    it('should reject empty name', () => {
      assert.throws(() => store.projectGroups.create({ name: '' }), { code: 'BAD_REQUEST' });
      assert.throws(() => store.projectGroups.create({ name: '   ' }), { code: 'BAD_REQUEST' });
    });

    it('should reject duplicate name', () => {
      store.projectGroups.create({ name: 'habitat' });
      assert.throws(() => store.projectGroups.create({ name: 'habitat' }), { code: 'CONFLICT' });
    });
  });

  describe('get', () => {
    it('should return group by id', () => {
      const created = store.projectGroups.create({ name: 'habitat' });
      const fetched = store.projectGroups.get(created.id);
      assert.equal(fetched.name, 'habitat');
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
      const group = store.projectGroups.create({ name: 'habitat' });
      store.projectGroups.delete(group.id);
      assert.equal(store.projectGroups.get(group.id), null);
    });

    it('should throw NOT_FOUND for non-existent group', () => {
      assert.throws(() => store.projectGroups.delete('fake'), { code: 'NOT_FOUND' });
    });

    it('should cascade delete members', () => {
      const group = store.projectGroups.create({ name: 'habitat' });
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
      const group = store.projectGroups.create({ name: 'habitat' });
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      store.projectGroups.addMember(group.id, proj.id);
      const members = store.projectGroups.listMembers(group.id);
      assert.equal(members.length, 1);
      assert.equal(members[0], proj.id);
    });

    it('should be idempotent when adding same member twice', () => {
      const group = store.projectGroups.create({ name: 'habitat' });
      const proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
      store.projectGroups.addMember(group.id, proj.id);
      store.projectGroups.addMember(group.id, proj.id); // No throw
      assert.equal(store.projectGroups.listMembers(group.id).length, 1);
    });

    it('should remove a member', () => {
      const group = store.projectGroups.create({ name: 'habitat' });
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
  });
});
