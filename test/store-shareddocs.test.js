'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.sharedDocs', () => {
  let tmpDir;
  let group;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shareddocs-'));
    store._setBasePath(tmpDir);
    store.init();
    group = store.projectGroups.create({ name: 'habitat', description: 'Infra docs' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a shared document with all fields', () => {
      const doc = store.sharedDocs.create({
        groupId: group.id,
        name: 'Network Topology',
        filePath: '/tmp/NETWORK.md',
        injectIntoConfig: true,
        injectMode: 'reference',
        description: 'Network layout docs'
      });
      assert.ok(doc.id);
      assert.equal(doc.groupId, group.id);
      assert.equal(doc.name, 'Network Topology');
      assert.equal(doc.filePath, '/tmp/NETWORK.md');
      assert.equal(doc.injectIntoConfig, true);
      assert.equal(doc.injectMode, 'reference');
      assert.equal(doc.description, 'Network layout docs');
      assert.ok(doc.createdAt);
    });

    it('should default injectIntoConfig to false and injectMode to reference', () => {
      const doc = store.sharedDocs.create({
        groupId: group.id,
        name: 'SSH',
        filePath: '/tmp/SSH.md'
      });
      assert.equal(doc.injectIntoConfig, false);
      assert.equal(doc.injectMode, 'reference');
    });

    it('should reject missing required fields', () => {
      assert.throws(() => store.sharedDocs.create({ groupId: group.id, name: 'x' }), { code: 'BAD_REQUEST' });
      assert.throws(() => store.sharedDocs.create({ groupId: group.id, filePath: '/x' }), { code: 'BAD_REQUEST' });
      assert.throws(() => store.sharedDocs.create({ name: 'x', filePath: '/x' }), { code: 'BAD_REQUEST' });
    });

    it('should reject invalid injectMode', () => {
      assert.throws(() => store.sharedDocs.create({
        groupId: group.id, name: 'x', filePath: '/x', injectMode: 'full'
      }), { code: 'BAD_REQUEST' });
    });

    it('should reject duplicate file_path within same group', () => {
      store.sharedDocs.create({ groupId: group.id, name: 'Doc1', filePath: '/tmp/same.md' });
      assert.throws(
        () => store.sharedDocs.create({ groupId: group.id, name: 'Doc2', filePath: '/tmp/same.md' }),
        { code: 'CONFLICT' }
      );
    });

    it('should allow same file_path in different groups', () => {
      const group2 = store.projectGroups.create({ name: 'other-group' });
      store.sharedDocs.create({ groupId: group.id, name: 'Doc1', filePath: '/tmp/shared.md' });
      const doc2 = store.sharedDocs.create({ groupId: group2.id, name: 'Doc1', filePath: '/tmp/shared.md' });
      assert.ok(doc2.id);
    });

    it('should reject non-existent group', () => {
      assert.throws(
        () => store.sharedDocs.create({ groupId: 'fake-group', name: 'x', filePath: '/x' }),
        { code: 'NOT_FOUND' }
      );
    });
  });

  describe('get and list', () => {
    it('should get by id', () => {
      const created = store.sharedDocs.create({ groupId: group.id, name: 'Net', filePath: '/tmp/net.md' });
      const fetched = store.sharedDocs.get(created.id);
      assert.equal(fetched.name, 'Net');
    });

    it('should return null for non-existent id', () => {
      assert.equal(store.sharedDocs.get('nonexistent'), null);
    });

    it('should list all docs', () => {
      store.sharedDocs.create({ groupId: group.id, name: 'A', filePath: '/a' });
      store.sharedDocs.create({ groupId: group.id, name: 'B', filePath: '/b' });
      const docs = store.sharedDocs.list();
      assert.equal(docs.length, 2);
    });

    it('should filter by groupId', () => {
      const group2 = store.projectGroups.create({ name: 'other' });
      store.sharedDocs.create({ groupId: group.id, name: 'A', filePath: '/a' });
      store.sharedDocs.create({ groupId: group2.id, name: 'B', filePath: '/b' });
      const docs = store.sharedDocs.list({ groupId: group.id });
      assert.equal(docs.length, 1);
      assert.equal(docs[0].name, 'A');
    });
  });

  describe('getByGroup', () => {
    it('should return docs for a group sorted by name', () => {
      store.sharedDocs.create({ groupId: group.id, name: 'Zebra', filePath: '/z' });
      store.sharedDocs.create({ groupId: group.id, name: 'Alpha', filePath: '/a' });
      const docs = store.sharedDocs.getByGroup(group.id);
      assert.equal(docs.length, 2);
      assert.equal(docs[0].name, 'Alpha');
      assert.equal(docs[1].name, 'Zebra');
    });
  });

  describe('update', () => {
    it('should update metadata fields', () => {
      const doc = store.sharedDocs.create({ groupId: group.id, name: 'Old', filePath: '/old' });
      const updated = store.sharedDocs.update(doc.id, {
        name: 'New',
        injectIntoConfig: true,
        injectMode: 'inline',
        description: 'Updated desc'
      });
      assert.equal(updated.name, 'New');
      assert.equal(updated.injectIntoConfig, true);
      assert.equal(updated.injectMode, 'inline');
      assert.equal(updated.description, 'Updated desc');
    });

    it('should reject invalid injectMode on update', () => {
      const doc = store.sharedDocs.create({ groupId: group.id, name: 'X', filePath: '/x' });
      assert.throws(() => store.sharedDocs.update(doc.id, { injectMode: 'bad' }), { code: 'BAD_REQUEST' });
    });

    it('should throw NOT_FOUND for non-existent doc', () => {
      assert.throws(() => store.sharedDocs.update('fake', { name: 'x' }), { code: 'NOT_FOUND' });
    });
  });

  describe('delete', () => {
    it('should delete a shared document', () => {
      const doc = store.sharedDocs.create({ groupId: group.id, name: 'X', filePath: '/x' });
      store.sharedDocs.delete(doc.id);
      assert.equal(store.sharedDocs.get(doc.id), null);
    });

    it('should throw NOT_FOUND for non-existent doc', () => {
      assert.throws(() => store.sharedDocs.delete('fake'), { code: 'NOT_FOUND' });
    });

    it('should cascade from group delete', () => {
      const doc = store.sharedDocs.create({ groupId: group.id, name: 'X', filePath: '/x' });
      store.projectGroups.delete(group.id);
      assert.equal(store.sharedDocs.get(doc.id), null);
    });
  });

  describe('getInjectableForProject', () => {
    it('should return injectable docs for a project via group membership', () => {
      const proj = store.projects.create({ name: 'MyProj', path: '/tmp/myproj' });
      store.projectGroups.addMember(group.id, proj.id);
      store.sharedDocs.create({ groupId: group.id, name: 'Net', filePath: '/net.md', injectIntoConfig: true });
      store.sharedDocs.create({ groupId: group.id, name: 'SSH', filePath: '/ssh.md', injectIntoConfig: false });

      const injectable = store.sharedDocs.getInjectableForProject(proj.id);
      assert.equal(injectable.length, 1);
      assert.equal(injectable[0].name, 'Net');
      assert.equal(injectable[0].groupName, 'habitat');
    });

    it('should deduplicate by file_path across groups', () => {
      const group2 = store.projectGroups.create({ name: 'other' });
      const proj = store.projects.create({ name: 'MyProj', path: '/tmp/myproj' });
      store.projectGroups.addMember(group.id, proj.id);
      store.projectGroups.addMember(group2.id, proj.id);

      store.sharedDocs.create({ groupId: group.id, name: 'Net', filePath: '/shared.md', injectIntoConfig: true });
      store.sharedDocs.create({ groupId: group2.id, name: 'Net Copy', filePath: '/shared.md', injectIntoConfig: true });

      const injectable = store.sharedDocs.getInjectableForProject(proj.id);
      assert.equal(injectable.length, 1, 'Should deduplicate by file_path');
    });

    it('should return empty for project with no groups', () => {
      const proj = store.projects.create({ name: 'Solo', path: '/tmp/solo' });
      assert.deepEqual(store.sharedDocs.getInjectableForProject(proj.id), []);
    });
  });
});
