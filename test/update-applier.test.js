'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const applier = require('../lib/update-applier');

/**
 * Build a git stub keyed by `args.join(' ')`. A value that is an Error is
 * thrown; an undefined key throws an "unexpected" guard so a test that drives
 * an unanticipated git call fails loudly rather than silently passing.
 * @param {Object<string, string|Error>} table
 * @returns {(args: string[]) => string}
 */
function gitStub(table) {
  return (args) => {
    const key = args.join(' ');
    if (!(key in table)) throw new Error(`unexpected git call: ${key}`);
    const v = table[key];
    if (v instanceof Error) throw v;
    return v;
  };
}

// A clean on-main checkout with a newer release tag available — the happy path
// the per-test overrides mutate.
const HAPPY = {
  'rev-parse HEAD': 'aaaaaaa0000000000000000000000000000000\n',
  'status --porcelain': '',
  'rev-parse --abbrev-ref HEAD': 'main\n',
  'fetch --tags origin': '',
  'ls-remote --tags origin': 'sha1\trefs/tags/v9.9.9\nsha2\trefs/tags/v1.0.0\n',
  'checkout v9.9.9': '',
};

describe('update-applier (UB #228/#229)', () => {
  let origGit, origCheck;

  beforeEach(() => {
    origGit = applier._internal.git;
    origCheck = applier._internal.checkForUpdate;
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
  });

  afterEach(() => {
    applier._internal.git = origGit;
    applier._internal.checkForUpdate = origCheck;
  });

  describe('applyUpdate guards', () => {
    it('refuses with no-git when HEAD cannot be read', () => {
      applier._internal.git = gitStub({ 'rev-parse HEAD': new Error('not a git repo') });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'no-git');
      assert.equal(r.toSha, null);
    });

    it('refuses with no-update when no newer release is available', () => {
      applier._internal.git = gitStub({ 'rev-parse HEAD': 'abc\n' });
      applier._internal.checkForUpdate = () => ({ updateAvailable: false, latestVersion: null });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'no-update');
      assert.equal(r.fromSha, 'abc'); // pre-update sha preserved
    });

    it('refuses with dirty-tree when the working tree is not clean', () => {
      applier._internal.git = gitStub({ ...HAPPY, 'status --porcelain': ' M lib/x.js\n' });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.match(r.error, /commit or stash/);
    });

    it('refuses with wrong-ref on a feature branch (never moves a dev branch)', () => {
      applier._internal.git = gitStub({
        ...HAPPY,
        'rev-parse --abbrev-ref HEAD': 'feat/something\n',
      });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'wrong-ref');
      assert.match(r.error, /feat\/something/);
    });

    it('refuses with no-tag when origin has no release tags', () => {
      applier._internal.git = gitStub({ ...HAPPY, 'ls-remote --tags origin': 'sha\trefs/heads/main\n' });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'no-tag');
    });

    it('reports git-error with the pre-update sha when a fetch fails mid-flow', () => {
      applier._internal.git = gitStub({ ...HAPPY, 'fetch --tags origin': new Error('network down') });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'git-error');
      assert.equal(r.fromSha, 'aaaaaaa0000000000000000000000000000000');
      assert.match(r.error, /network down/);
    });
  });

  describe('applyUpdate happy path', () => {
    it('checks out the latest tag from main and returns from/to shas', () => {
      const calls = [];
      const base = gitStub({ ...HAPPY, 'rev-parse HEAD': 'aaaaaaa0000000000000000000000000000000\n' });
      // Second `rev-parse HEAD` (post-checkout) returns the new sha.
      let revParseCount = 0;
      applier._internal.git = (args) => {
        calls.push(args.join(' '));
        if (args.join(' ') === 'rev-parse HEAD') {
          revParseCount++;
          return revParseCount === 1 ? 'aaaaaaa111\n' : 'bbbbbbb222\n';
        }
        return base(args);
      };
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.equal(r.code, null);
      assert.equal(r.toRef, 'v9.9.9');
      assert.equal(r.fromSha, 'aaaaaaa111');
      assert.equal(r.toSha, 'bbbbbbb222');
      assert.ok(calls.includes('checkout v9.9.9'), 'should checkout the latest tag');
      assert.ok(calls.includes('fetch --tags origin'), 'should fetch tags first');
    });

    it('allows updating from a detached HEAD sitting exactly on a release tag', () => {
      applier._internal.git = gitStub({
        ...HAPPY,
        'rev-parse --abbrev-ref HEAD': 'HEAD\n', // detached
        'describe --exact-match --tags HEAD': 'v1.0.0\n',
      });
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.equal(r.toRef, 'v9.9.9');
    });
  });

  describe('_headState', () => {
    it('updatable on main', () => {
      applier._internal.git = gitStub({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
      assert.deepEqual(applier._headState(), { updatable: true, ref: 'main' });
    });

    it('updatable when detached exactly at a release tag', () => {
      applier._internal.git = gitStub({
        'rev-parse --abbrev-ref HEAD': 'HEAD\n',
        'describe --exact-match --tags HEAD': 'v2.3.4\n',
      });
      assert.deepEqual(applier._headState(), { updatable: true, ref: 'v2.3.4' });
    });

    it('NOT updatable on a feature branch', () => {
      applier._internal.git = gitStub({ 'rev-parse --abbrev-ref HEAD': 'fix/bug\n' });
      assert.equal(applier._headState().updatable, false);
    });

    it('NOT updatable when detached but not on a tag', () => {
      applier._internal.git = gitStub({
        'rev-parse --abbrev-ref HEAD': 'HEAD\n',
        'describe --exact-match --tags HEAD': new Error('no tag points at HEAD'),
      });
      assert.equal(applier._headState().updatable, false);
    });
  });
});
