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
  // #711: the provisioning step diffs the two shas. The stub table returns
  // the same sha for both rev-parse calls, so this is the key it produces.
  'diff --name-only aaaaaaa0000000000000000000000000000000 aaaaaaa0000000000000000000000000000000': '',
};

describe('update-applier (UB #228/#229)', () => {
  let origGit, origCheck, origHead;

  beforeEach(() => {
    origGit = applier._internal.git;
    origCheck = applier._internal.checkForUpdate;
    origHead = applier._internal.headOfFile;
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    // Safe default: an unprobed file reads as NOT TangleClaw's (fail closed),
    // matching the real seam's unreadable-file answer.
    applier._internal.headOfFile = () => '';
  });

  afterEach(() => {
    applier._internal.git = origGit;
    applier._internal.checkForUpdate = origCheck;
    applier._internal.headOfFile = origHead;
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
        if (args.join(' ') === 'diff --name-only aaaaaaa111 bbbbbbb222') return '';
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

  describe('applyUpdate provisioning report (#711 chunk 01)', () => {
    // DETECT AND REPORT, never execute. TangleClaw is zero-npm-dep by ratified
    // norm (dependency-manifest.md), so the manifest branch is the forward
    // guard for a release that reverses that norm upstream — the updater tells
    // the operator, it does not become an npm executor (the git-over-packaged
    // ruling cited npm supply-chain exposure as a reason to keep npm out of
    // this path).

    it('reports a quiet release as needing nothing', () => {
      applier._internal.git = gitStub({ ...HAPPY,
        ['diff --name-only aaaaaaa0000000000000000000000000000000 aaaaaaa0000000000000000000000000000000']: 'lib/projects.js\npublic/landing.js\n' });
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.deepEqual(r.provisioning,
        { manifestChanged: false, assetsChanged: [], action: null });
    });

    it('reports a dependency manifest appearing, and runs nothing for it', () => {
      applier._internal.git = gitStub({ ...HAPPY,
        ['diff --name-only aaaaaaa0000000000000000000000000000000 aaaaaaa0000000000000000000000000000000']: 'package.json\npackage-lock.json\nlib/projects.js\n' });
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, 'reporting is advisory — the checkout itself landed');
      assert.equal(r.provisioning.manifestChanged, true);
      assert.equal(r.provisioning.action, 'manual');
      // gitStub throws on any undeclared call and no npm seam exists: had the
      // applier tried to execute an install, this test could not have passed.
    });

    it('reports changed deploy assets for the human, never applies them', () => {
      applier._internal.git = gitStub({ ...HAPPY,
        ['diff --name-only aaaaaaa0000000000000000000000000000000 aaaaaaa0000000000000000000000000000000']: 'deploy/com.tangleclaw.server.plist\ndeploy/tmux.conf\nserver.js\n' });
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.deepEqual(r.provisioning.assetsChanged,
        ['deploy/com.tangleclaw.server.plist', 'deploy/tmux.conf']);
      assert.equal(r.provisioning.action, 'manual');
    });

    it('manifest and assets together: both reported, one manual flag', () => {
      applier._internal.git = gitStub({ ...HAPPY,
        ['diff --name-only aaaaaaa0000000000000000000000000000000 aaaaaaa0000000000000000000000000000000']: 'package-lock.json\ndeploy/install.sh\n' });
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.equal(r.provisioning.manifestChanged, true);
      assert.deepEqual(r.provisioning.assetsChanged, ['deploy/install.sh']);
      assert.equal(r.provisioning.action, 'manual');
    });
  });

  describe('applyUpdate dirty-tree escape (#711 chunk 03)', () => {
    const TC_HEADER = '# CLAUDE.md — Generated by TangleClaw';

    /**
     * Git stub whose `status --porcelain` answer changes after a discard ran,
     * recording every call. Undeclared calls throw, same as gitStub.
     * @param {object} opts - { statuses: string[], extra: object }
     * @returns {{ fn: Function, calls: string[] }}
     */
    function statefulStub({ statuses, extra = {} }) {
      const calls = [];
      let statusIdx = 0;
      const table = { ...HAPPY, ...extra };
      const fn = (args) => {
        const key = args.join(' ');
        calls.push(key);
        if (key === 'status --porcelain') {
          const v = statuses[Math.min(statusIdx, statuses.length - 1)];
          statusIdx++;
          return v;
        }
        if (key.startsWith('checkout -- ') || key.startsWith('clean -fd -- ')) return '';
        if (!(key in table)) throw new Error(`unexpected git call: ${key}`);
        const v = table[key];
        if (v instanceof Error) throw v;
        return v;
      };
      return { fn, calls };
    }

    it('a mixed dirty tree refuses with both lists and touches nothing', () => {
      const { fn, calls } = statefulStub({
        statuses: [' M lib/projects.js\n?? .tangleclaw/\n'] });
      applier._internal.git = fn;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.deepEqual(r.dirty, {
        discardable: ['.tangleclaw/'], realWork: ['lib/projects.js'] });
      assert.equal(calls.some((c) => c.startsWith('checkout --') || c.startsWith('clean')), false,
        'one real-work path anywhere means NOTHING is discarded, flag or no flag');
    });

    it('a TC-stamped tracked file is discardable, and the refusal says how', () => {
      applier._internal.headOfFile = (p) => (p === 'CLAUDE.md' ? TC_HEADER : '');
      const { fn } = statefulStub({ statuses: [' M CLAUDE.md\n'] });
      applier._internal.git = fn;
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.deepEqual(r.dirty, { discardable: ['CLAUDE.md'], realWork: [] });
      assert.match(r.error, /discard option/,
        'an all-TC refusal must tell the operator the way out exists');
    });

    it('discardDirty on an all-TC tree discards precisely and proceeds', () => {
      applier._internal.headOfFile = (p) => (p === 'CLAUDE.md' ? TC_HEADER : '');
      const { fn, calls } = statefulStub({
        statuses: [' M CLAUDE.md\n?? .tangleclaw/\n', ''] });
      applier._internal.git = fn;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, true, 'the update must proceed once the tree is provably clean');
      assert.equal(r.toRef, 'v9.9.9');
      assert.ok(calls.includes('checkout -- CLAUDE.md'),
        'tracked TC files are restored from HEAD');
      assert.ok(calls.includes('clean -fd -- .tangleclaw/'),
        'untracked TC files are deleted, scoped by path');
      assert.ok(calls.filter((c) => c === 'status --porcelain').length >= 2,
        'the discard must re-prove cleanliness before anything moves');
    });

    it('without the flag, an all-TC tree still refuses', () => {
      applier._internal.headOfFile = () => TC_HEADER;
      const { fn, calls } = statefulStub({ statuses: [' M CLAUDE.md\n'] });
      applier._internal.git = fn;
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(calls.some((c) => c.startsWith('checkout --')), false,
        'the discard is opt-in per request, never a default');
    });

    it('fails closed on renames and quoted paths', () => {
      const porcelain = 'R  old.js -> new.js\n?? "we ird.txt"\n';
      const d = applier._classifyDirty(porcelain);
      assert.equal(d.discardable.length, 0);
      assert.equal(d.realWork.length, 2,
        'anything the parser cannot read with certainty is real work');
    });

    it('fails closed when the marker probe cannot read the file', () => {
      // Default headOfFile stub answers '' (unreadable) — a modified tracked
      // file that MIGHT be TC-generated is treated as real work.
      const d = applier._classifyDirty(' M CLAUDE.md\n');
      assert.deepEqual(d.realWork, ['CLAUDE.md']);
    });

    it('refuses when the discard does not actually produce a clean tree', () => {
      applier._internal.headOfFile = () => TC_HEADER;
      const { fn } = statefulStub({
        statuses: [' M CLAUDE.md\n', ' M CLAUDE.md\n'] });
      applier._internal.git = fn;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.match(r.error, /did not produce a clean tree/);
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
