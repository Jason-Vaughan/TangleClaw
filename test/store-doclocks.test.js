'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.documentLocks', () => {
  let tmpDir;
  let group;
  let doc;
  let proj;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doclocks-'));
    store._setBasePath(tmpDir);
    store.init();

    group = store.projectGroups.create({ name: 'habitat' });
    doc = store.sharedDocs.create({ groupId: group.id, name: 'Network', filePath: '/tmp/net.md' });
    proj = store.projects.create({ name: 'TestProj', path: '/tmp/tp' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('acquire', () => {
    it('should acquire a lock', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-test' });
      const lock = store.documentLocks.acquire(doc.id, session.id, 'TestProj');
      assert.equal(lock.documentId, doc.id);
      assert.equal(lock.lockedBySession, session.id);
      assert.equal(lock.lockedByProject, 'TestProj');
      assert.ok(lock.lockedAt);
      assert.ok(lock.expiresAt);
    });

    it('should reject lock when already held by another session', () => {
      const s1 = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-s1' });
      const proj2 = store.projects.create({ name: 'Proj2', path: '/tmp/p2' });
      const s2 = store.sessions.start({ projectId: proj2.id, engineId: 'claude', tmuxSession: 'tc-s2' });

      store.documentLocks.acquire(doc.id, s1.id, 'TestProj');
      assert.throws(
        () => store.documentLocks.acquire(doc.id, s2.id, 'Proj2'),
        { code: 'LOCK_CONFLICT' }
      );
    });

    it('should allow acquiring expired lock', () => {
      const s1 = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-s1' });
      store.documentLocks.acquire(doc.id, s1.id, 'TestProj', 0); // 0 min TTL = already expired

      // Force the expires_at to be in the past
      const db = store.getDb();
      db.prepare('UPDATE document_locks SET expires_at = ? WHERE document_id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), doc.id);

      const proj2 = store.projects.create({ name: 'Proj2', path: '/tmp/p2' });
      const s2 = store.sessions.start({ projectId: proj2.id, engineId: 'claude', tmuxSession: 'tc-s2' });
      const lock = store.documentLocks.acquire(doc.id, s2.id, 'Proj2');
      assert.equal(lock.lockedByProject, 'Proj2');
    });

    it('should throw NOT_FOUND for non-existent document', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      assert.throws(
        () => store.documentLocks.acquire('fake-doc', session.id, 'TestProj'),
        { code: 'NOT_FOUND' }
      );
    });
  });

  describe('release', () => {
    it('should release a lock', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      store.documentLocks.acquire(doc.id, session.id, 'TestProj');
      store.documentLocks.release(doc.id);
      assert.equal(store.documentLocks.check(doc.id), null);
    });

    it('should be safe to release non-existent lock', () => {
      store.documentLocks.release('nonexistent'); // No throw
    });
  });

  describe('releaseBySession', () => {
    it('should release all locks held by a session', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      const doc2 = store.sharedDocs.create({ groupId: group.id, name: 'SSH', filePath: '/tmp/ssh.md' });

      store.documentLocks.acquire(doc.id, session.id, 'TestProj');
      store.documentLocks.acquire(doc2.id, session.id, 'TestProj');

      const released = store.documentLocks.releaseBySession(session.id);
      assert.equal(released, 2);
      assert.equal(store.documentLocks.check(doc.id), null);
      assert.equal(store.documentLocks.check(doc2.id), null);
    });

    it('should return 0 when session holds no locks', () => {
      assert.equal(store.documentLocks.releaseBySession(999), 0);
    });
  });

  describe('check', () => {
    it('should return lock details when locked', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      store.documentLocks.acquire(doc.id, session.id, 'TestProj');
      const lock = store.documentLocks.check(doc.id);
      assert.equal(lock.documentId, doc.id);
      assert.equal(lock.lockedByProject, 'TestProj');
    });

    it('should return null when not locked', () => {
      assert.equal(store.documentLocks.check(doc.id), null);
    });
  });

  describe('expireStale', () => {
    it('should remove expired locks', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      store.documentLocks.acquire(doc.id, session.id, 'TestProj');

      // Force expiry into the past
      const db = store.getDb();
      db.prepare('UPDATE document_locks SET expires_at = ? WHERE document_id = ?')
        .run(new Date(Date.now() - 60000).toISOString(), doc.id);

      const count = store.documentLocks.expireStale();
      assert.equal(count, 1);
      assert.equal(store.documentLocks.check(doc.id), null);
    });

    it('should not remove non-expired locks', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      store.documentLocks.acquire(doc.id, session.id, 'TestProj', 60); // 60 min TTL
      const count = store.documentLocks.expireStale();
      assert.equal(count, 0);
      assert.ok(store.documentLocks.check(doc.id));
    });
  });

  describe('getBySession', () => {
    it('should return all locks held by a session', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      const doc2 = store.sharedDocs.create({ groupId: group.id, name: 'SSH', filePath: '/tmp/ssh.md' });

      store.documentLocks.acquire(doc.id, session.id, 'TestProj');
      store.documentLocks.acquire(doc2.id, session.id, 'TestProj');

      const locks = store.documentLocks.getBySession(session.id);
      assert.equal(locks.length, 2);
    });

    it('should return empty when session holds no locks', () => {
      assert.deepEqual(store.documentLocks.getBySession(999), []);
    });
  });

  describe('cascade from document delete', () => {
    it('should delete lock when document is deleted', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      store.documentLocks.acquire(doc.id, session.id, 'TestProj');
      store.sharedDocs.delete(doc.id);
      assert.equal(store.documentLocks.check(doc.id), null);
    });

    it('should delete lock when group is deleted (cascades through doc)', () => {
      const session = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'tc-t' });
      store.documentLocks.acquire(doc.id, session.id, 'TestProj');
      store.projectGroups.delete(group.id);
      assert.equal(store.documentLocks.check(doc.id), null);
    });
  });
});
