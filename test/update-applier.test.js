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
  'checkout --no-overwrite-ignore v9.9.9': '',
  // #1730: the preflight asks what the tag changes before anything moves. An
  // empty answer means nothing is in the checkout's way.
  'diff --name-status -z --no-renames HEAD v9.9.9': '',
  // #711: the provisioning step diffs the two shas. The stub table returns
  // the same sha for both rev-parse calls, so this is the key it produces.
  'diff --name-only aaaaaaa0000000000000000000000000000000 aaaaaaa0000000000000000000000000000000': '',
};

// `.claude/settings.json` as committed (carrying a hook entry TangleClaw
// retires) and as TangleClaw leaves it after the retirement write.
const TC_HOOK = { hooks: [{ type: 'command', command: 'bash data/hooks/sessionstart-prime-claude.sh' }] };
const OPERATOR_HOOK = { hooks: [{ type: 'command', command: 'echo mine' }] };
const SETTINGS_HEAD = JSON.stringify({ hooks: { SessionStart: [OPERATOR_HOOK, TC_HOOK] } }, null, 2);
const SETTINGS_RETIRED = JSON.stringify({ hooks: { SessionStart: [OPERATOR_HOOK] } }, null, 2);
const SETTINGS_HAND_EDITED = JSON.stringify({
  permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [OPERATOR_HOOK] } }, null, 2);

describe('update-applier (UB #228/#229)', () => {
  let origGit, origCheck, origRead, origGetDbPath, origVacuumDb, origIntegrityCheck, origReadBackupFile, origChmodBackupFile;

  beforeEach(() => {
    origGit = applier._internal.git;
    origCheck = applier._internal.checkForUpdate;
    origRead = applier._internal.readFile;
    origGetDbPath = applier._internal.getDbPath;
    origVacuumDb = applier._internal.vacuumDb;
    origIntegrityCheck = applier._internal.integrityCheck;
    origReadBackupFile = applier._internal.readBackupFile;
    origChmodBackupFile = applier._internal.chmodBackupFile;
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    // Happy-path SQLite backup stubs: vacuumDb is a noop (no file created), so
    // readBackupFile returns a fake buffer for SHA-256 computation and chmod is
    // silenced since the file doesn't exist.
    applier._internal.getDbPath = () => '/tmp/test-tangleclaw.db';
    applier._internal.vacuumDb = () => {};
    applier._internal.integrityCheck = () => ['ok'];
    applier._internal.readBackupFile = () => Buffer.from('fake-backup-content');
    applier._internal.chmodBackupFile = () => {};
  });

  afterEach(() => {
    applier._internal.git = origGit;
    applier._internal.checkForUpdate = origCheck;
    applier._internal.readFile = origRead;
    applier._internal.getDbPath = origGetDbPath;
    applier._internal.vacuumDb = origVacuumDb;
    applier._internal.integrityCheck = origIntegrityCheck;
    applier._internal.readBackupFile = origReadBackupFile;
    applier._internal.chmodBackupFile = origChmodBackupFile;
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
      assert.ok(calls.includes('checkout --no-overwrite-ignore v9.9.9'), 'should checkout the latest tag');
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
    /**
     * Git stub whose `status --porcelain` answer changes after a discard ran,
     * recording every call. Undeclared calls throw, same as gitStub.
     * @param {object} opts - { statuses: string[], extra: object }
     * @returns {{ fn: Function, calls: string[] }}
     */
    function statefulStub({ statuses, extra = {} }) {
      const calls = [];
      let statusIdx = 0;
      const table = { ...HAPPY, 'show HEAD:.claude/settings.json': SETTINGS_HEAD, ...extra };
      const fn = (args) => {
        const key = args.join(' ');
        calls.push(key);
        if (key === 'status --porcelain') {
          const v = statuses[Math.min(statusIdx, statuses.length - 1)];
          statusIdx++;
          return v;
        }
        if (key.startsWith('checkout HEAD -- ') || key.startsWith('clean -fd -- ')) return '';
        if (!(key in table)) throw new Error(`unexpected git call: ${key}`);
        const v = table[key];
        if (v instanceof Error) throw v;
        return v;
      };
      return { fn, calls };
    }

    it('a mixed dirty tree refuses with both lists and touches nothing', () => {
      const { fn, calls } = statefulStub({
        statuses: [' M lib/projects.js\n M .claude/settings.json\n'] });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_RETIRED;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.deepEqual(r.dirty, {
        discardable: ['.claude/settings.json'], realWork: ['lib/projects.js'], carried: [] });
      assert.equal(calls.some((c) => c.startsWith('checkout') || c.startsWith('clean')), false,
        'one real-work path anywhere means NOTHING is discarded, flag or no flag');
    });

    it('the settings hook file is discardable when TangleClaw only retired its hooks, and the refusal says how', () => {
      const { fn } = statefulStub({ statuses: [' M .claude/settings.json\n'] });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_RETIRED;
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.deepEqual(r.dirty, { discardable: ['.claude/settings.json'], realWork: [], carried: [] });
      assert.match(r.error, /discard option/,
        'an all-TC refusal must tell the operator the way out exists');
    });

    it('the rest of .claude/ is the operator\'s, and generated-looking files are not TC\'s', () => {
      // The ratified line is .tangleclaw/* plus exactly .claude/settings.json.
      // settings.local.json is the operator\'s; a modified CLAUDE.md is not
      // provably TC\'s even when TC once generated it — a later hand edit
      // must never be discarded under "nothing of yours is in this list".
      //
      // #1241 did not widen that line, and this case still proves it: with NO
      // containment test supplied, a carrier stays real work. The carrier is
      // admitted only when a caller can show the delta sits inside TC's markers
      // — test/update-applier-managed-carrier.test.js owns that half, including
      // the case where a hand edit outside them keeps this exact refusal.
      const d = applier._classifyDirty(' M .claude/settings.local.json\n M CLAUDE.md\n');
      assert.deepEqual(d.discardable, []);
      assert.deepEqual(d.realWork, ['.claude/settings.local.json', 'CLAUDE.md']);
    });

    it('discardDirty on an all-TC tree restores precisely and proceeds', () => {
      const { fn, calls } = statefulStub({
        statuses: [' M .claude/settings.json\n', ''] });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_RETIRED;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, true, 'the update must proceed once the tree is provably clean');
      assert.equal(r.toRef, 'v9.9.9');
      assert.ok(calls.includes('checkout HEAD -- .claude/settings.json'),
        'tracked TC files are restored from HEAD');
      assert.equal(calls.some((c) => c.startsWith('clean')), false,
        'the updater never deletes a file');
      assert.ok(calls.filter((c) => c === 'status --porcelain').length >= 2,
        'the discard must re-prove cleanliness before anything moves');
    });

    it('the discard opt-in is a strict boolean, not truthiness', () => {
      const { fn, calls } = statefulStub({ statuses: [' M .claude/settings.json\n'] });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_RETIRED;
      const r = applier.applyUpdate({ discardDirty: 'yes' });
      assert.equal(r.ok, false, 'a truthy string must not authorize a discard');
      assert.equal(r.code, 'dirty-tree');
      assert.equal(calls.some((c) => c.startsWith('checkout')), false);
    });

    it('without the flag, an all-TC tree still refuses', () => {
      const { fn, calls } = statefulStub({ statuses: [' M .claude/settings.json\n'] });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_RETIRED;
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(calls.some((c) => c.startsWith('checkout')), false,
        'the discard is opt-in per request, never a default');
    });

    it('authored content under .tangleclaw/ is real work, tracked or untracked (#1537)', () => {
      // The prefix used to be discardable, and a self-update deleted an
      // uncommitted plan under a dialog that said nothing of the operator's
      // was in the list. Plans, priming prompts and memories are authored.
      const d = applier._classifyDirty(
        '?? .tangleclaw/plans/x.md\n M .tangleclaw/plans/archive/y.md\n'
        + '?? .tangleclaw/priming/\n M .tangleclaw/memories/MEMORY.md\n?? .tangleclaw/\n',
        () => true);
      assert.deepEqual(d.discardable, [], 'no proof covers .tangleclaw/, whatever the caller answers');
      assert.deepEqual(d.realWork, ['.tangleclaw/plans/x.md', '.tangleclaw/plans/archive/y.md',
        '.tangleclaw/priming/', '.tangleclaw/memories/MEMORY.md', '.tangleclaw/']);
    });

    it('a dirty plan refuses the update even with the discard opt-in, and nothing is touched', () => {
      const { fn, calls } = statefulStub({ statuses: ['?? .tangleclaw/plans/x.md\n'] });
      applier._internal.git = fn;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.deepEqual(r.dirty, { discardable: [], realWork: ['.tangleclaw/plans/x.md'], carried: [] });
      assert.match(r.error, /commit or stash/);
      assert.equal(calls.some((c) => c.startsWith('checkout') || c.startsWith('clean')), false);
    });

    it('a hand edit to .claude/settings.json is real work, not a discardable TangleClaw write', () => {
      const { fn, calls } = statefulStub({ statuses: [' M .claude/settings.json\n'] });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_HAND_EDITED;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, false);
      assert.deepEqual(r.dirty, { discardable: [], realWork: ['.claude/settings.json'], carried: [] });
      assert.equal(calls.some((c) => c.startsWith('checkout')), false,
        'an operator permission must never be discarded under "nothing of yours"');
    });

    it('an unparseable .claude/settings.json is real work', () => {
      const { fn } = statefulStub({ statuses: [' M .claude/settings.json\n'] });
      applier._internal.git = fn;
      applier._internal.readFile = () => '{ not json';
      const r = applier.applyUpdate({ discardDirty: true });
      assert.deepEqual(r.dirty, { discardable: [], realWork: ['.claude/settings.json'], carried: [] });
    });

    it('a settings file missing from HEAD is real work', () => {
      const { fn } = statefulStub({ statuses: [' M .claude/settings.json\n'],
        extra: { 'show HEAD:.claude/settings.json': new Error('fatal: path not in HEAD') } });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_RETIRED;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.deepEqual(r.dirty, { discardable: [], realWork: ['.claude/settings.json'], carried: [] });
    });

    it('an untracked .claude/settings.json is never probed and never discardable', () => {
      let asked = false;
      const d = applier._classifyDirty('?? .claude/settings.json\n', () => { asked = true; return true; });
      assert.deepEqual(d.realWork, ['.claude/settings.json']);
      assert.equal(asked, false);
    });

    it('_discardTcFiles refuses to delete an untracked entry rather than removing it', () => {
      const calls = [];
      applier._internal.git = (args) => { calls.push(args.join(' ')); return ''; };
      assert.throws(() => applier._discardTcFiles([{ path: 'x', tracked: false }]),
        /refusing to delete untracked/);
      assert.deepEqual(calls, [], 'nothing runs when the contract is broken');
    });

    it('fails closed on renames and quoted paths', () => {
      const porcelain = 'R  old.js -> new.js\n?? "we ird.txt"\n';
      const d = applier._classifyDirty(porcelain);
      assert.equal(d.discardable.length, 0);
      assert.equal(d.realWork.length, 2,
        'anything the parser cannot read with certainty is real work');
    });

    it('refuses when the discard does not actually produce a clean tree', () => {
      const { fn } = statefulStub({
        statuses: [' M .claude/settings.json\n', ' M .claude/settings.json\n'] });
      applier._internal.git = fn;
      applier._internal.readFile = () => SETTINGS_RETIRED;
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
      assert.match(r.error, /did not produce a clean tree/);
    });
  });

  describe('_backupSqlite and SQLite backup step (#2577)', () => {
    it('returns reconcile-required with reason backup-failed when vacuumDb throws', () => {
      applier._internal.git = gitStub({ ...HAPPY });
      applier._internal.vacuumDb = () => { throw new Error('disk full'); };
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      // Uses _reconcile (not a top-level _fail code) so public/session.js needs no change.
      assert.equal(r.code, 'reconcile-required');
      assert.ok(Array.isArray(r.reconcile) && r.reconcile.length > 0, 'reconcile array present');
      assert.equal(r.reconcile[0].reason, 'backup-failed');
      assert.equal(r.fromSha, 'aaaaaaa0000000000000000000000000000000');
    });

    it('returns reconcile-required with reason backup-failed when integrity check returns non-ok result', () => {
      applier._internal.git = gitStub({ ...HAPPY });
      applier._internal.integrityCheck = () => ['*** in database main ***', 'On tree page 2 cell 0'];
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'reconcile-required');
      assert.equal(r.reconcile[0].reason, 'backup-failed');
    });

    it('returns reconcile-required with reason backup-failed when integrity check returns empty array', () => {
      applier._internal.git = gitStub({ ...HAPPY });
      applier._internal.integrityCheck = () => [];
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'reconcile-required');
      assert.equal(r.reconcile[0].reason, 'backup-failed');
    });

    it('includes dbBackup path and sha256 in a successful result', () => {
      applier._internal.git = gitStub({ ...HAPPY });
      let capturedDest;
      applier._internal.vacuumDb = (_src, dest) => { capturedDest = dest; };
      applier._internal.integrityCheck = () => ['ok'];
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.ok(r.dbBackup, 'result should include dbBackup');
      assert.ok(typeof r.dbBackup.path === 'string', 'dbBackup.path should be a string');
      assert.ok(typeof r.dbBackup.sha256 === 'string', 'dbBackup.sha256 should be a string');
      assert.equal(r.dbBackup.path, capturedDest, 'dbBackup.path should match the dest passed to vacuumDb');
      assert.match(r.dbBackup.path, /tangleclaw-pre-update-9\.9\.9-/, 'path should contain version');
      assert.match(r.dbBackup.path, /\.db$/, 'path should end in .db');
    });

    it('vacuumDb is called with getDbPath result and a backup-dir path', () => {
      applier._internal.git = gitStub({ ...HAPPY });
      const calls = [];
      applier._internal.getDbPath = () => '/custom/tangleclaw.db';
      applier._internal.vacuumDb = (src, dest) => calls.push({ src, dest });
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].src, '/custom/tangleclaw.db');
    });

    it('backup step runs AFTER headState guard and BEFORE fetch (wrong-ref aborts before backup)', () => {
      const calls = [];
      applier._internal.git = gitStub({
        ...HAPPY,
        'rev-parse --abbrev-ref HEAD': 'feat/something\n',
      });
      applier._internal.vacuumDb = () => calls.push('vacuum');
      const r = applier.applyUpdate();
      assert.equal(r.code, 'wrong-ref');
      assert.equal(calls.length, 0, 'vacuumDb should not be called when headState guard refuses');
    });
  });

  describe('_tryRebaseOntoTag (#2399)', () => {
    // A local branch forked from `main`, whose fork point is an ancestor of
    // the latest tag — the shape `_tryRebaseOntoTag` is eligible to handle.
    const REBASE_BASE = {
      'rev-parse HEAD': 'bbbbbbb1111111111111111111111111111111\n',
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'fix/local-commits\n',
      'fetch --tags origin': '',
      'ls-remote --tags origin': 'sha1\trefs/tags/v9.9.9\nsha2\trefs/tags/v1.0.0\n',
      'merge-base fix/local-commits main': 'ccccccc2222222222222222222222222222222\n',
      'merge-base --is-ancestor ccccccc2222222222222222222222222222222 v9.9.9': '',
      // Stub's rev-parse HEAD is static, so "after rebase" reads the same sha
      // back — the self-diff below is what the happy main-path test does too.
      'diff --name-only bbbbbbb1111111111111111111111111111111 bbbbbbb1111111111111111111111111111111': ''
    };

    it('rebases local commits onto the release tag when the fork point is an ancestor of it', () => {
      applier._internal.git = gitStub({ ...REBASE_BASE, 'rebase v9.9.9': '' });
      const r = applier.applyUpdate();
      assert.equal(r.ok, true);
      assert.equal(r.rebased, true);
      assert.equal(r.toRef, 'v9.9.9');
      assert.deepEqual(r.carried, []);
    });

    it('aborts and refuses with rebase-conflict, naming the conflicted files, on a failed rebase', () => {
      applier._internal.git = gitStub({
        ...REBASE_BASE,
        'rebase v9.9.9': new Error('CONFLICT (content): Merge conflict in lib/x.js'),
        'diff --name-only --diff-filter=U': 'lib/x.js\n',
        'rebase --abort': ''
      });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'rebase-conflict');
      assert.deepEqual(r.conflicts, ['lib/x.js']);
      assert.match(r.error, /fix\/local-commits/);
      assert.match(r.error, /v9\.9\.9/);
    });

    it('returns recovery-failed, never a clean rebase-conflict, when the abort itself fails', () => {
      let statusCalls = 0;
      applier._internal.git = (args) => {
        const key = args.join(' ');
        if (key === 'status --porcelain') {
          statusCalls++;
          // Clean at the step-3 dirty-tree guard; left dirty by the failed abort.
          return statusCalls === 1 ? '' : ' M lib/x.js\n';
        }
        if (key === 'rebase v9.9.9') throw new Error('CONFLICT (content): Merge conflict in lib/x.js');
        if (key === 'diff --name-only --diff-filter=U') return 'lib/x.js\n';
        if (key === 'rebase --abort') throw new Error('fatal: no rebase in progress?');
        if (!(key in REBASE_BASE)) throw new Error(`unexpected git call: ${key}`);
        const v = REBASE_BASE[key];
        if (v instanceof Error) throw v;
        return v;
      };
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'recovery-failed');
      assert.equal(r.recovery.failedStep, 'rebase');
      assert.match(r.error, /could not be verified as put back/);
      assert.match(r.error, /do not update or restart/);
    });

    it('still runs the abort and restores cleanly when listing the conflicted files itself fails', () => {
      // THE MUTATION THIS CATCHES: a `git diff` failure thrown ahead of `git
      // rebase --abort` would skip the abort entirely, leaving the rebase
      // stuck — this pins that diff failing never costs the abort call.
      applier._internal.git = gitStub({
        ...REBASE_BASE,
        'rebase v9.9.9': new Error('CONFLICT (content): Merge conflict in lib/x.js'),
        'diff --name-only --diff-filter=U': new Error('fatal: ambiguous argument'),
        'rebase --abort': ''
      });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'rebase-conflict');
      assert.deepEqual(r.conflicts, []);
    });

    it('falls through to the ordinary wrong-ref refusal when the branch shares no history with local main', () => {
      applier._internal.git = gitStub({
        ...HAPPY,
        'rev-parse --abbrev-ref HEAD': 'fix/orphan\n',
        'merge-base fix/orphan main': new Error('fatal: no merge base')
      });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'wrong-ref');
    });

    it('falls through to wrong-ref when the fork point is not an ancestor of the latest tag', () => {
      applier._internal.git = gitStub({
        ...REBASE_BASE,
        'merge-base --is-ancestor ccccccc2222222222222222222222222222222 v9.9.9': new Error('not an ancestor')
      });
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'wrong-ref');
    });

    it('refuses reconcile-required when the pre-update SQLite backup fails during a rebase attempt', () => {
      applier._internal.git = gitStub(REBASE_BASE);
      applier._internal.vacuumDb = () => { throw new Error('disk full'); };
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'reconcile-required');
      assert.equal(r.reconcile[0].reason, 'backup-failed');
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

  describe('applyAutomaticRecordsOnlyFastForward (#1710)', () => {
    let origAnyRunning;

    beforeEach(() => {
      origAnyRunning = applier._internal.anyRunning;
      applier._internal.anyRunning = () => null;
    });

    afterEach(() => {
      applier._internal.anyRunning = origAnyRunning;
    });

    const FF_HAPPY = {
      'rev-parse HEAD': 'aaaaaaa000000000000000000000000000000000\n',
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'status --porcelain': '',
      'merge --ff-only origin/main': '',
    };

    it('fast-forwards a proven records-only delta when every precondition holds', () => {
      let calls = 0;
      applier._internal.git = (args) => {
        calls += 1;
        const key = args.join(' ');
        const table = {
          'rev-parse HEAD': calls <= 1
            ? 'aaaaaaa000000000000000000000000000000000\n'
            : 'bbbbbbb000000000000000000000000000000000\n',
          'rev-parse --abbrev-ref HEAD': 'main\n',
          'status --porcelain': '',
          'rev-parse origin/main': 'bbbbbbb000000000000000000000000000000000\n',
          'merge --ff-only bbbbbbb000000000000000000000000000000000': '',
        };
        if (!(key in table)) throw new Error(`unexpected git call: ${key}`);
        return table[key];
      };
      const r = applier.applyAutomaticRecordsOnlyFastForward({
        delta: {
          delta: 'records-only',
          fromSha: 'aaaaaaa000000000000000000000000000000000',
          toSha: 'bbbbbbb000000000000000000000000000000000'
        }
      });
      assert.equal(r.ok, true);
      assert.equal(r.fromSha, 'aaaaaaa000000000000000000000000000000000');
      assert.equal(r.toSha, 'bbbbbbb000000000000000000000000000000000');
      assert.equal(r.toRef, 'origin/main');
    });

    it('refuses when the classification carries no verifiable fromSha/toSha (PRR-B Round 1 Blocker 1)', () => {
      applier._internal.git = gitStub(FF_HAPPY);
      for (const bad of [
        { delta: 'records-only' },
        { delta: 'records-only', fromSha: 'not-a-sha', toSha: 'bbbbbbb000000000000000000000000000000000' },
        { delta: 'records-only', fromSha: 'aaaaaaa000000000000000000000000000000000', toSha: null }
      ]) {
        const r = applier.applyAutomaticRecordsOnlyFastForward({ delta: bad });
        assert.equal(r.ok, false);
        assert.equal(r.code, 'unverified-delta');
      }
    });

    it('refuses when HEAD has moved since the classification was computed, never merging anyway', () => {
      applier._internal.git = gitStub({
        'rev-parse HEAD': 'ccccccc000000000000000000000000000000000\n',
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'status --porcelain': '',
      });
      const r = applier.applyAutomaticRecordsOnlyFastForward({
        delta: {
          delta: 'records-only',
          fromSha: 'aaaaaaa000000000000000000000000000000000',
          toSha: 'bbbbbbb000000000000000000000000000000000'
        }
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'drift-detected');
      assert.match(r.error, /HEAD/);
    });

    it('refuses when origin/main has moved since the classification was computed, never merging the moving ref', () => {
      applier._internal.git = gitStub({
        'rev-parse HEAD': 'aaaaaaa000000000000000000000000000000000\n',
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'status --porcelain': '',
        'rev-parse origin/main': 'ddddddd000000000000000000000000000000000\n',
      });
      const r = applier.applyAutomaticRecordsOnlyFastForward({
        delta: {
          delta: 'records-only',
          fromSha: 'aaaaaaa000000000000000000000000000000000',
          toSha: 'bbbbbbb000000000000000000000000000000000'
        }
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'drift-detected');
      assert.match(r.error, /origin\/main/);
    });

    it('refuses when the delta is not proven records-only', () => {
      applier._internal.git = gitStub(FF_HAPPY);
      const r = applier.applyAutomaticRecordsOnlyFastForward({ delta: { delta: 'executable' } });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'not-records-only');
    });

    it('refuses when no delta classification is passed at all', () => {
      applier._internal.git = gitStub(FF_HAPPY);
      const r = applier.applyAutomaticRecordsOnlyFastForward();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'not-records-only');
    });

    const VALID_DELTA = {
      delta: 'records-only',
      fromSha: 'aaaaaaa000000000000000000000000000000000',
      toSha: 'bbbbbbb000000000000000000000000000000000'
    };

    it('refuses off main, never attempting the merge', () => {
      applier._internal.git = gitStub({
        'rev-parse HEAD': 'aaaaaaa000000000000000000000000000000000\n',
        'rev-parse --abbrev-ref HEAD': 'feat/something\n',
      });
      const r = applier.applyAutomaticRecordsOnlyFastForward({ delta: VALID_DELTA });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'wrong-ref');
    });

    it('refuses on a dirty tree, never discarding anything', () => {
      applier._internal.git = gitStub({
        'rev-parse HEAD': 'aaaaaaa000000000000000000000000000000000\n',
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'status --porcelain': ' M some/file.js\n',
      });
      const r = applier.applyAutomaticRecordsOnlyFastForward({ delta: VALID_DELTA });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'dirty-tree');
    });

    it('refuses while a wrap is running anywhere on the host', () => {
      applier._internal.git = gitStub({
        'rev-parse HEAD': 'aaaaaaa000000000000000000000000000000000\n',
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'status --porcelain': '',
      });
      applier._internal.anyRunning = () => 'other-project';
      const r = applier.applyAutomaticRecordsOnlyFastForward({ delta: VALID_DELTA });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'wrap-running');
      assert.match(r.error, /other-project/);
    });

    it('reports git-error when the fast-forward itself fails (non-ff-only history)', () => {
      applier._internal.git = gitStub({
        'rev-parse HEAD': 'aaaaaaa000000000000000000000000000000000\n',
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'status --porcelain': '',
        'rev-parse origin/main': 'bbbbbbb000000000000000000000000000000000\n',
        'merge --ff-only bbbbbbb000000000000000000000000000000000': new Error('fatal: Not possible to fast-forward, aborting.'),
      });
      const r = applier.applyAutomaticRecordsOnlyFastForward({ delta: VALID_DELTA });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'git-error');
    });
  });

  describe('evaluateStaleInstallResponse (#1710)', () => {
    let origAnyRunning, origClassify, origGit;

    beforeEach(() => {
      origAnyRunning = applier._internal.anyRunning;
      origClassify = applier._internal.classifyUpstreamDelta;
      origGit = applier._internal.git;
      applier._internal.anyRunning = () => null;
    });

    afterEach(() => {
      applier._internal.anyRunning = origAnyRunning;
      applier._internal.classifyUpstreamDelta = origClassify;
      applier._internal.git = origGit;
    });

    it('reports none when already up to date', () => {
      applier._internal.classifyUpstreamDelta = () => ({ delta: 'none', reason: null, fromSha: 'a', toSha: 'a' });
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' });
      assert.deepEqual(r.action, 'none');
    });

    it('auto-pulls a records-only delta end to end', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'records-only', reason: null, fromSha: 'aaaaaaa000000000000000000000000000000000',
        toSha: 'bbbbbbb000000000000000000000000000000000', executablePaths: [], recordsPaths: ['docs/x.md']
      });
      let calls = 0;
      applier._internal.git = (args) => {
        calls += 1;
        const key = args.join(' ');
        const table = {
          'rev-parse HEAD': calls <= 1 ? 'aaaaaaa000000000000000000000000000000000\n' : 'bbbbbbb000000000000000000000000000000000\n',
          'rev-parse --abbrev-ref HEAD': 'main\n',
          'status --porcelain': '',
          'rev-parse origin/main': 'bbbbbbb000000000000000000000000000000000\n',
          'merge --ff-only bbbbbbb000000000000000000000000000000000': '',
        };
        if (!(key in table)) throw new Error(`unexpected git call: ${key}`);
        return table[key];
      };
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' });
      assert.equal(r.action, 'auto-pulled');
      assert.equal(r.result.ok, true);
    });

    it('reports auto-pull-refused when a records-only delta cannot be pulled (e.g. dirty tree)', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'records-only', reason: null, fromSha: 'aaaaaaa000000000000000000000000000000000',
        toSha: 'bbbbbbb000000000000000000000000000000000', executablePaths: [], recordsPaths: ['docs/x.md']
      });
      applier._internal.git = gitStub({
        'rev-parse HEAD': 'aaaaaaa000000000000000000000000000000000\n',
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'status --porcelain': ' M docs/x.md\n',
      });
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' });
      assert.equal(r.action, 'auto-pull-refused');
      assert.equal(r.result.code, 'dirty-tree');
    });

    it('reports pending-diagnosis for an unmeasured delta, never a restart prompt (PRR-B Round 1 Warning)', () => {
      for (const deltaType of ['unknown', 'pending']) {
        applier._internal.classifyUpstreamDelta = () => ({
          delta: deltaType, reason: 'upstream not observed', fromSha: null, toSha: null, executablePaths: [], recordsPaths: []
        });
        const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' });
        assert.equal(r.action, 'pending-diagnosis');
        assert.equal(r.prompt, undefined, 'no restart prompt is framed for a delta with nothing proven');
        assert.equal(r.fleetQuiet, undefined, 'fleetQuiet answers a question this delta never raised');
      }
    });

    it('never restarts unilaterally for an executable delta — asks instead, fleet quiet', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'executable', reason: null, fromSha: 'a', toSha: 'b', executablePaths: ['lib/foo.js'], recordsPaths: []
      });
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' }, { sessionsMidTurn: false });
      assert.equal(r.action, 'await_operator_restart_confirmation');
      assert.equal(r.requiresOperatorAuthorization, true);
      assert.equal(r.fleetQuiet, true);
      assert.match(r.prompt, /lib\/foo\.js/);
    });

    it('reports the fleet as busy when a wrap is running elsewhere', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'mixed', reason: null, fromSha: 'a', toSha: 'b', executablePaths: ['lib/foo.js'], recordsPaths: ['docs/x.md']
      });
      applier._internal.anyRunning = () => 'another-project';
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' }, { sessionsMidTurn: false });
      assert.equal(r.action, 'await_operator_restart_confirmation');
      assert.equal(r.fleetQuiet, false);
      assert.match(r.prompt, /busy/);
    });

    it('reports the fleet as busy when the caller says a session is mid-turn', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'executable', reason: null, fromSha: 'a', toSha: 'b', executablePaths: ['lib/foo.js'], recordsPaths: []
      });
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' }, { sessionsMidTurn: true });
      assert.equal(r.fleetQuiet, false);
    });

    it('reports the fleet as busy — never quiet — when the caller cannot answer whether anyone is mid-turn (PRR-B Round 1 Blocker 2)', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'executable', reason: null, fromSha: 'a', toSha: 'b', executablePaths: ['lib/foo.js'], recordsPaths: []
      });
      for (const opts of [{}, { sessionsMidTurn: null }, { sessionsMidTurn: undefined }]) {
        const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' }, opts);
        assert.equal(r.fleetQuiet, false, `opts=${JSON.stringify(opts)}: an unanswered signal must never prove quiet`);
        assert.equal(r.action, 'await_operator_restart_confirmation');
      }
    });

    it('Mode (a): standing consent authorizes without a prompt when the fleet is quiet', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'executable', reason: null, fromSha: 'a', toSha: 'b', executablePaths: ['lib/foo.js'], recordsPaths: []
      });
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' }, { standingConsent: true, sessionsMidTurn: false });
      assert.equal(r.action, 'restart-authorized-by-standing-consent');
      assert.equal(r.fleetQuiet, true);
    });

    it('Mode (a): standing consent never authorizes when the fleet is busy', () => {
      applier._internal.classifyUpstreamDelta = () => ({
        delta: 'executable', reason: null, fromSha: 'a', toSha: 'b', executablePaths: ['lib/foo.js'], recordsPaths: []
      });
      applier._internal.anyRunning = () => 'another-project';
      const r = applier.evaluateStaleInstallResponse({ id: 1, name: 'p', path: '/x' }, { standingConsent: true });
      assert.equal(r.action, 'await_operator_restart_confirmation');
    });
  });
});
