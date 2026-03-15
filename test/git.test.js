'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const git = require('../lib/git');

describe('git', () => {
  afterEach(() => {
    git.clearCache();
  });

  describe('isGitRepo', () => {
    it('should return true for a git repository', () => {
      // This project is a git repo
      assert.ok(git.isGitRepo(path.join(__dirname, '..')));
    });

    it('should return false for a non-repo directory', () => {
      assert.equal(git.isGitRepo('/tmp'), false);
    });

    it('should return false for non-existent directory', () => {
      assert.equal(git.isGitRepo('/nonexistent/path'), false);
    });
  });

  describe('getInfo', () => {
    it('should return git info for a valid repo', () => {
      const info = git.getInfo(path.join(__dirname, '..'));
      assert.ok(info !== null);
      assert.ok(typeof info.branch === 'string');
      assert.ok(typeof info.dirty === 'boolean');
      assert.ok(typeof info.lastCommit === 'string');
      assert.ok(typeof info.lastCommitAge === 'string');
    });

    it('should return null for non-git directory', () => {
      const info = git.getInfo('/tmp');
      assert.equal(info, null);
    });

    it('should cache results', () => {
      const dir = path.join(__dirname, '..');
      const info1 = git.getInfo(dir);
      const info2 = git.getInfo(dir);
      // Same object reference since it's cached
      assert.equal(info1, info2);
    });

    it('should return fresh data after cache clear', () => {
      const dir = path.join(__dirname, '..');
      const info1 = git.getInfo(dir);
      git.clearCache();
      const info2 = git.getInfo(dir);
      // Different object reference but same data
      assert.notEqual(info1, info2);
      assert.equal(info1.branch, info2.branch);
    });
  });

  describe('clearCacheFor', () => {
    it('should clear cache for a specific directory', () => {
      const dir = path.join(__dirname, '..');
      const info1 = git.getInfo(dir);
      git.clearCacheFor(dir);
      const info2 = git.getInfo(dir);
      assert.notEqual(info1, info2);
    });
  });

  describe('_fetchInfo', () => {
    it('should return info without caching', () => {
      const info = git._fetchInfo(path.join(__dirname, '..'));
      assert.ok(info !== null);
      assert.ok(info.branch);
    });

    it('should return null for non-repo', () => {
      const info = git._fetchInfo('/tmp');
      assert.equal(info, null);
    });
  });

  describe('latestTag', () => {
    it('should include latestTag in getInfo result', () => {
      const info = git.getInfo(path.join(__dirname, '..'));
      assert.ok(info !== null);
      // latestTag is either a string (if tags exist) or null
      assert.ok(info.latestTag === null || typeof info.latestTag === 'string');
    });

    it('should return null latestTag for repo with no tags', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const { execSync } = require('node:child_process');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
      try {
        execSync('git init && git commit --allow-empty -m "init"', { cwd: tmp, encoding: 'utf8' });
        const info = git._fetchInfo(tmp);
        assert.ok(info !== null);
        assert.equal(info.latestTag, null);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
