'use strict';

/*
 * Store-level tests for the D1b session-rules self-improvement loop:
 * version history + rollback, learnings→rule promotion, and the
 * non-authoritative conflict-candidate signal.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('sessionRules self-improvement (D1b)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sr-selfimprove-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkProject(name) {
    const projPath = path.join(tmpDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    return store.projects.create({ name, path: projPath, engine: 'claude', methodology: 'none' }).id;
  }

  describe('version history', () => {
    it('snapshots v1 on create', () => {
      const rule = store.sessionRules.create({ content: 'first', projectId: mkProject('sip-1') });
      const versions = store.sessionRules.listVersions(rule.id);
      assert.equal(versions.length, 1);
      assert.equal(versions[0].versionNo, 1);
      assert.equal(versions[0].op, 'create');
      assert.equal(versions[0].content, 'first');
    });

    it('appends a version on each update (newest first)', () => {
      const rule = store.sessionRules.create({ content: 'v1 content', projectId: mkProject('sip-2') });
      store.sessionRules.update(rule.id, { content: 'v2 content' });
      store.sessionRules.update(rule.id, { content: 'v3 content', changedBy: 'ai' });
      const versions = store.sessionRules.listVersions(rule.id);
      assert.deepEqual(versions.map((v) => v.versionNo), [3, 2, 1]);
      assert.equal(versions[0].op, 'update');
      assert.equal(versions[0].content, 'v3 content');
      assert.equal(versions[0].changedBy, 'ai');
    });

    it('records changedBy on the snapshot', () => {
      const rule = store.sessionRules.create({ content: 'base', createdBy: 'ai', projectId: mkProject('sip-3') });
      assert.equal(store.sessionRules.listVersions(rule.id)[0].changedBy, 'ai');
    });

    it('snapshots a tombstone on delete so history survives', () => {
      const rule = store.sessionRules.create({ content: 'doomed', projectId: mkProject('sip-4') });
      store.sessionRules.delete(rule.id, { changedBy: 'ai', changeReason: 'cleanup' });
      const versions = store.sessionRules.listVersions(rule.id);
      assert.equal(versions[0].op, 'delete');
      assert.equal(versions[0].changedBy, 'ai');
      // The rule row is gone but its version history remains.
      assert.equal(store.sessionRules.get(rule.id), null);
    });
  });

  describe('restore (rollback)', () => {
    it('rolls content + enabled back to a prior version and records the restore', () => {
      const rule = store.sessionRules.create({ content: 'original', projectId: mkProject('sip-5') });
      store.sessionRules.update(rule.id, { content: 'risky autonomous edit' });

      const restored = store.sessionRules.restore(rule.id, 1);
      assert.equal(restored.content, 'original');

      const versions = store.sessionRules.listVersions(rule.id);
      assert.equal(versions[0].op, 'restore');
      assert.equal(versions[0].versionNo, 3); // create(1) → update(2) → restore(3)
      assert.equal(versions[0].content, 'original');
    });

    it('restores a disabled state', () => {
      const rule = store.sessionRules.create({ content: 'x', projectId: mkProject('sip-6') });          // v1 enabled
      store.sessionRules.update(rule.id, { enabled: false });            // v2 disabled
      store.sessionRules.update(rule.id, { enabled: true });             // v3 enabled
      const restored = store.sessionRules.restore(rule.id, 2);
      assert.equal(restored.enabled, false);
    });

    it('throws NOT_FOUND for a missing rule or version', () => {
      const rule = store.sessionRules.create({ content: 'x', projectId: mkProject('sip-7') });
      assert.throws(() => store.sessionRules.restore(99999, 1), /not found/);
      assert.throws(() => store.sessionRules.restore(rule.id, 99), /Version 99 not found/);
    });

    it('logs a session_rule.restored activity event', () => {
      const rule = store.sessionRules.create({ content: 'x', projectId: mkProject('sip-8') });
      store.sessionRules.update(rule.id, { content: 'y' });
      store.sessionRules.restore(rule.id, 1);
      assert.equal(store.activity.query({ eventType: 'session_rule.restored' }).length, 1);
    });
  });

  describe('promoteFromLearning', () => {
    it('creates an AI-authored rule with provenance from the learning text', () => {
      const pid = mkProject('p');
      const learning = store.learnings.create({ projectId: pid, content: 'Prefer X in this codebase' });
      const rule = store.sessionRules.promoteFromLearning(learning.id);
      assert.equal(rule.content, 'Prefer X in this codebase');
      assert.equal(rule.createdBy, 'ai');
      assert.equal(rule.sourceLearningId, learning.id);
      // v1 snapshot exists and records the promotion reason.
      assert.equal(store.sessionRules.listVersions(rule.id)[0].changeReason, `promoted from learning ${learning.id}`);
    });

    it('honors content + projectId + createdBy overrides', () => {
      const pid = mkProject('p');
      const learning = store.learnings.create({ projectId: pid, content: 'raw learning' });
      const rule = store.sessionRules.promoteFromLearning(learning.id, {
        content: 'reworded rule', projectId: pid, createdBy: 'operator'
      });
      assert.equal(rule.content, 'reworded rule');
      assert.equal(rule.projectId, pid);
      assert.equal(rule.createdBy, 'operator');
    });

    it('throws NOT_FOUND for a missing learning', () => {
      assert.throws(() => store.sessionRules.promoteFromLearning(99999), /Learning 99999 not found/);
    });
  });

  describe('findConflictCandidates (non-authoritative signal)', () => {
    it('surfaces active in-scope rules with significant token overlap, sorted by overlap', () => {
      const pid = mkProject('conflicts');
      store.sessionRules.create({ content: 'Always run the full test suite before committing', projectId: pid });
      store.sessionRules.create({ content: 'Document every public function with JSDoc', projectId: pid });
      const candidates = store.sessionRules.findConflictCandidates('Skip running the test suite for small commits', pid);
      assert.ok(candidates.length >= 1);
      assert.match(candidates[0].rule.content, /test suite/);
      assert.ok(candidates[0].overlap.length >= 2);
    });

    it('excludes disabled rules and other-project rules', () => {
      const pid = mkProject('p');
      const other = mkProject('other');
      const off = store.sessionRules.create({ content: 'test suite always required here', projectId: pid });
      store.sessionRules.update(off.id, { enabled: false });
      store.sessionRules.create({ content: 'test suite required other project', projectId: other });
      const candidates = store.sessionRules.findConflictCandidates('test suite skip', pid);
      assert.equal(candidates.length, 0);
    });

    it('returns empty for content with no significant tokens', () => {
      const pid = mkProject('stopwords');
      store.sessionRules.create({ content: 'run the full test suite', projectId: pid });
      assert.deepEqual(store.sessionRules.findConflictCandidates('the and for', pid), []);
    });

    it('respects minOverlap', () => {
      const pid = mkProject('overlap');
      store.sessionRules.create({ content: 'alpha beta gamma delta', projectId: pid });
      assert.equal(store.sessionRules.findConflictCandidates('alpha zeta', pid, { minOverlap: 2 }).length, 0);
      assert.equal(store.sessionRules.findConflictCandidates('alpha zeta', pid, { minOverlap: 1 }).length, 1);
    });
  });
});
