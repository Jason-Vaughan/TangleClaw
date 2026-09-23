'use strict';

/*
 * #1730 — operator edits to data/global-rules.md survive an update, or the
 * update refuses before anything moves.
 *
 * The landing-page editor writes that tracked file in place, so an install that
 * customised its rules could not take any release that also changed it: without
 * skip-worktree the dirty guard refused with no way forward, and with it the
 * guard passed and `git checkout <tag>` aborted with a raw git error. These
 * tests drive `applyUpdate` against a REAL repository with a real origin whose
 * newer tag changes the file, so every claim is about what is on disk
 * afterwards: HEAD, the ref, the file's exact bytes and its index flags.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const applier = require('../lib/update-applier');

const RULES = 'data/global-rules.md';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
};

/**
 * Run git in a directory, returning utf8 stdout.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Run git in a directory, returning raw stdout bytes.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Buffer}
 */
function gitBytes(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
}

// v1 of the rules, and v9's change to them: a line appended at the end. An
// operator edit at the top merges cleanly; one at the end conflicts.
const RULES_V1 = '# Global Rules\n\n## General\n\n- one\n- two\n- three\n\n## Tail\n\n- last\n';
const RULES_V9 = `${RULES_V1}- shipped in v9\n`;
const EDIT_TOP = RULES_V1.replace('## General\n', '## General\n\n- my local rule\n');
const EDIT_END = `${RULES_V1}- my conflicting line\n`;

describe('operator-edited global rules across an update (#1730)', () => {
  let root, work, backups, orig;

  /**
   * Cut a release on origin from a scratch clone, so `work` stays where it is.
   * @param {string} tag
   * @param {(dir: string) => void} change - Edits the clone before the commit.
   */
  function release(tag, change) {
    const cutter = path.join(root, `cut-${tag}`);
    git(root, ['clone', '-q', path.join(root, 'origin.git'), cutter]);
    change(cutter);
    git(cutter, ['add', '-A']);
    git(cutter, ['commit', '-qm', tag]);
    git(cutter, ['tag', tag]);
    git(cutter, ['push', '-q', 'origin', 'main', '--tags']);
  }

  /** @returns {string} */
  const head = () => git(work, ['rev-parse', 'HEAD']).trim();
  /** @returns {string} */
  const ref = () => git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  /** @returns {Buffer} */
  const rulesBytes = () => fs.readFileSync(path.join(work, RULES));
  /** @returns {string} the `git ls-files -v` tag letter for the rules file */
  const flag = () => git(work, ['ls-files', '-v', RULES])[0];

  let v1Sha;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1730-'));
    const origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    backups = path.join(root, 'home', 'backups');
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['init', '-q', '-b', 'main', work]);
    fs.writeFileSync(path.join(work, '.gitignore'), '.tangleclaw/*\n!.tangleclaw/plans/\n');
    fs.mkdirSync(path.join(work, 'data'));
    fs.writeFileSync(path.join(work, RULES), RULES_V1);
    fs.writeFileSync(path.join(work, 'server.js'), '// v1\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-qm', 'v1']);
    git(work, ['tag', 'v1.0.0']);
    git(work, ['remote', 'add', 'origin', origin]);
    git(work, ['push', '-q', 'origin', 'main', '--tags']);
    v1Sha = head();
    release('v9.9.9', (dir) => {
      fs.writeFileSync(path.join(dir, RULES), RULES_V9);
      fs.writeFileSync(path.join(dir, 'server.js'), '// v9\n');
    });

    orig = { ...applier._internal };
    applier._internal.git = (args) => git(work, args);
    applier._internal.gitBytes = (args) => gitBytes(work, args);
    applier._internal.repoDir = work;
    applier._internal.backupDir = () => backups;
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
  });

  afterEach(() => {
    Object.assign(applier._internal, orig);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Assert the checkout is exactly where the update found it.
   * @param {Buffer|string} bytes - The rules file's expected bytes.
   * @param {string} [flagLetter] - Expected `ls-files -v` letter.
   * @param {string} [atRef] - Expected abbrev-ref.
   */
  function assertUntouched(bytes, flagLetter = 'H', atRef = 'main') {
    assert.equal(head(), v1Sha, 'HEAD did not move');
    assert.equal(ref(), atRef, 'still on the starting ref');
    assert.ok(rulesBytes().equals(Buffer.from(bytes)), 'the file holds its original bytes');
    assert.equal(flag(), flagLetter, 'the index flag is as it was');
  }

  describe('(a) a non-overlapping edit is carried', () => {
    it('updates, keeps the edit beside the release\'s change, and says where the copy is', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.toRef, 'v9.9.9');
      const now = rulesBytes().toString('utf8');
      assert.match(now, /- my local rule/, 'the operator\'s edit survived');
      assert.match(now, /- shipped in v9/, 'and the release\'s change landed');
      assert.equal(fs.readFileSync(path.join(work, 'server.js'), 'utf8'), '// v9\n');
      assert.equal(r.carried.length, 1);
      assert.equal(r.carried[0].path, RULES);
      assert.equal(fs.readFileSync(r.carried[0].backup, 'utf8'), EDIT_TOP, 'the backup is the pre-update copy');
    });

    it('keeps the backup private: directory 0700, file 0600', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(fs.statSync(backups).mode & 0o777, 0o700);
      assert.equal(fs.statSync(r.carried[0].backup).mode & 0o777, 0o600);
      assert.equal(path.basename(r.carried[0].backup), `global-rules.${v1Sha.slice(0, 7)}-v9.9.9.md`);
    });

    it('an unchanged rules file needs no carry, and no backup is written', () => {
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.carried, []);
      assert.equal(rulesBytes().toString('utf8'), RULES_V9);
      assert.equal(fs.existsSync(backups), false);
    });

    it('an edit the release does not touch is left to git, with no backup', () => {
      release('v9.9.10', (dir) => {
        fs.writeFileSync(path.join(dir, RULES), RULES_V1);
        fs.writeFileSync(path.join(dir, 'server.js'), '// v9.10\n');
      });
      applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.10' });
      fs.writeFileSync(path.join(work, RULES), EDIT_END);
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.toRef, 'v9.9.10');
      assert.deepEqual(r.carried, []);
      assert.equal(rulesBytes().toString('utf8'), EDIT_END);
    });
  });

  describe('(b) a conflicting edit refuses before anything moves', () => {
    it('returns reconcile-required with merge-conflict and leaves HEAD, bytes and flags alone', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_END);
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'reconcile-required');
      assert.equal(r.fromSha, v1Sha);
      assert.equal(r.toRef, null);
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]), [[RULES, 'merge-conflict']]);
      assert.match(r.reconcile[0].action, /Global Rules/);
      assert.doesNotMatch(r.reconcile[0].action, /\bgit\b/, 'no raw git in an action (ADR 0010)');
      assertUntouched(EDIT_END);
      assert.equal(fs.existsSync(backups), false, 'a refusal writes no backup');
    });

    it('keeps bytes that are not valid UTF-8 exactly', () => {
      const raw = Buffer.concat([Buffer.from(RULES_V1), Buffer.from([0xff, 0xfe, 0x0a])]);
      fs.writeFileSync(path.join(work, RULES), raw);
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assertUntouched(raw);
    });

    it('a release that deletes the edited file is a merge-conflict too', () => {
      release('v9.9.10', (dir) => fs.rmSync(path.join(dir, RULES)));
      applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.10' });
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => x.reason), ['merge-conflict']);
      assertUntouched(EDIT_TOP);
    });
  });

  describe('(c) the skip-worktree repro from the issue', () => {
    it('a non-overlapping edit is carried and the flag is back afterwards', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      git(work, ['update-index', '--skip-worktree', RULES]);
      assert.equal(git(work, ['status', '--porcelain']), '', 'the flag hides the edit, as in the issue');
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.match(rulesBytes().toString('utf8'), /- my local rule[\s\S]*- shipped in v9/);
      assert.equal(flag(), 'S', 'skip-worktree is restored');
      assert.equal(r.carried.length, 1);
    });

    it('a conflicting edit refuses, and the file and flag are unchanged', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_END);
      git(work, ['update-index', '--skip-worktree', RULES]);
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.equal(r.reconcile[0].reason, 'merge-conflict');
      assertUntouched(EDIT_END, 'S');
    });

    it('an unedited file with the flag set updates normally and keeps the flag', () => {
      git(work, ['update-index', '--skip-worktree', RULES]);
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.carried, [], 'nothing to carry');
      assert.equal(rulesBytes().toString('utf8'), RULES_V9);
      assert.equal(flag(), 'S');
    });

    it('an assume-unchanged edit is carried and the flag is back afterwards', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      git(work, ['update-index', '--assume-unchanged', RULES]);
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.match(rulesBytes().toString('utf8'), /- my local rule/);
      assert.equal(flag(), 'h', 'assume-unchanged is restored');
    });

    it('a flagged rules file that was deleted refuses with the flag as the reason', () => {
      git(work, ['update-index', '--skip-worktree', RULES]);
      fs.rmSync(path.join(work, RULES));
      assert.equal(git(work, ['status', '--porcelain']), '', 'the flag hides the deletion');
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]), [[RULES, 'skip-worktree']]);
      assert.equal(head(), v1Sha);
      assert.equal(fs.existsSync(path.join(work, RULES)), false, 'nothing was restored behind the refusal');
    });

    it('a flag on a file that is not carried refuses with its reason', () => {
      git(work, ['update-index', '--skip-worktree', 'server.js']);
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]), [['server.js', 'skip-worktree']]);
      assert.equal(head(), v1Sha);
    });
  });

  describe('(d) a file already where the release adds one', () => {
    it('an untracked file that porcelain shows is already refused as dirty work, and is kept', () => {
      // It never reaches the preflight: the dirty guard sees `?? notes.txt`
      // and refuses first, which is the earlier and stricter of the two.
      release('v9.9.10', (dir) => fs.writeFileSync(path.join(dir, 'notes.txt'), 'shipped\n'));
      applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.10' });
      fs.writeFileSync(path.join(work, 'notes.txt'), 'mine\n');
      const r = applier.applyUpdate();
      assert.equal(r.code, 'dirty-tree', JSON.stringify(r));
      assert.deepEqual(r.dirty.realWork, ['notes.txt']);
      assert.equal(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8'), 'mine\n');
      assert.equal(head(), v1Sha);
    });

    it('an IGNORED file, which git would overwrite silently, refuses too and is kept', () => {
      release('v9.9.10', (dir) => {
        fs.mkdirSync(path.join(dir, '.tangleclaw', 'memories'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.tangleclaw', 'memories', 'MEMORY.md'), 'shipped\n');
        git(dir, ['add', '-f', '.tangleclaw/memories/MEMORY.md']);
      });
      applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.10' });
      const mine = path.join(work, '.tangleclaw', 'memories', 'MEMORY.md');
      fs.mkdirSync(path.dirname(mine), { recursive: true });
      fs.writeFileSync(mine, 'my memory\n');
      assert.equal(git(work, ['status', '--porcelain']), '', 'ignored, so porcelain cannot see it');
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]),
        [['.tangleclaw/memories/MEMORY.md', 'untracked-collision']]);
      assert.equal(fs.readFileSync(mine, 'utf8'), 'my memory\n');
    });

    it('an ignored FILE where the release needs a directory refuses, and is kept', () => {
      // Git would delete `.tangleclaw/scratch` to make the directory the
      // release's `.tangleclaw/scratch/notes.md` needs, without a word.
      release('v9.9.10', (dir) => {
        fs.mkdirSync(path.join(dir, '.tangleclaw', 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.tangleclaw', 'scratch', 'notes.md'), 'shipped\n');
        git(dir, ['add', '-f', '.tangleclaw/scratch/notes.md']);
      });
      applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.10' });
      fs.mkdirSync(path.join(work, '.tangleclaw'), { recursive: true });
      const mine = path.join(work, '.tangleclaw', 'scratch');
      fs.writeFileSync(mine, 'my scratch file\n');
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]), [['.tangleclaw/scratch', 'untracked-collision']]);
      assert.equal(fs.readFileSync(mine, 'utf8'), 'my scratch file\n');
      assert.equal(head(), v1Sha);
    });

    it('the checkout itself refuses to overwrite an ignored file the preflight missed', () => {
      // The backstop, with the preflight bypassed: git's own refusal under
      // --no-overwrite-ignore maps to checkout-collision, and the file stays.
      release('v9.9.10', (dir) => {
        fs.mkdirSync(path.join(dir, '.tangleclaw', 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.tangleclaw', 'scratch', 'notes.md'), 'shipped\n');
        git(dir, ['add', '-f', '.tangleclaw/scratch/notes.md']);
      });
      applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.10' });
      fs.mkdirSync(path.join(work, '.tangleclaw'), { recursive: true });
      const mine = path.join(work, '.tangleclaw', 'scratch');
      fs.writeFileSync(mine, 'my scratch file\n');
      const realGit = applier._internal.git;
      applier._internal.git = (args) => {
        // Hide the release's changes from the preflight only.
        if (args[0] === 'diff' && args.includes('--name-status')) return '';
        return realGit(args);
      };
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]), [['.tangleclaw/scratch', 'checkout-collision']]);
      assert.equal(fs.readFileSync(mine, 'utf8'), 'my scratch file\n');
      assert.equal(head(), v1Sha);
    });

    it('every finding comes back in one refusal', () => {
      release('v9.9.10', (dir) => {
        fs.writeFileSync(path.join(dir, RULES), RULES_V9);
        fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.tangleclaw', 'notes.md'), 'shipped\n');
        git(dir, ['add', '-f', '.tangleclaw/notes.md']);
      });
      applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.10' });
      fs.mkdirSync(path.join(work, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(work, '.tangleclaw', 'notes.md'), 'mine\n');
      fs.writeFileSync(path.join(work, RULES), EDIT_END);
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => x.reason).sort(), ['merge-conflict', 'untracked-collision']);
    });
  });

  describe('(e) a failure after the preflight is compensated before a result', () => {
    /**
     * Fail one git call once, matched by its joined argv.
     * @param {string} key
     * @param {Error} err
     */
    function failGitOnce(key, err) {
      let fired = false;
      applier._internal.git = (args) => {
        if (!fired && args.join(' ') === key) {
          fired = true;
          throw err;
        }
        return git(work, args);
      };
    }

    const overwriteError = () => Object.assign(new Error('Command failed: git checkout v9.9.9'), {
      status: 1,
      stderr: 'error: The following untracked working tree files would be overwritten by checkout:\n'
        + '\tlate.txt\nPlease move or remove them before you switch branches.\nAborting\n'
    });

    it('a diagnosed overwrite maps to checkout-collision, not git-error, with the carry undone', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      git(work, ['update-index', '--skip-worktree', RULES]);
      failGitOnce('checkout --no-overwrite-ignore v9.9.9', overwriteError());
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]), [['late.txt', 'checkout-collision']]);
      assertUntouched(EDIT_TOP, 'S');
    });

    it('an unrelated checkout failure stays git-error, with the carry undone', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      failGitOnce('checkout --no-overwrite-ignore v9.9.9', new Error('fatal: unable to write new index file'));
      const r = applier.applyUpdate();
      assert.equal(r.code, 'git-error', JSON.stringify(r));
      assertUntouched(EDIT_TOP);
    });

    it('a failed write of the merged file puts back the ref, the bytes and the flag', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      git(work, ['update-index', '--skip-worktree', RULES]);
      const realWrite = orig.writeRepoFile;
      let n = 0;
      applier._internal.writeRepoFile = (...args) => {
        if (n++ === 0) throw new Error('disk full');
        return realWrite(...args);
      };
      const r = applier.applyUpdate();
      assert.equal(r.code, 'git-error', JSON.stringify(r));
      assert.match(r.error, /disk full/);
      assertUntouched(EDIT_TOP, 'S');
    });

    it('a write that fails after its temp file exists leaves nothing behind in the install', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      const realRename = fs.renameSync;
      let failed = false;
      fs.renameSync = (from, to) => {
        // Fail only the merged write's publish, once; the temp file is on disk
        // by then, which is the leftover this pins.
        if (!failed && String(to).endsWith(RULES)) { failed = true; throw new Error('EIO'); }
        return realRename(from, to);
      };
      let r;
      try {
        r = applier.applyUpdate();
      } finally {
        fs.renameSync = realRename;
      }
      assert.equal(r.code, 'git-error', JSON.stringify(r));
      assert.deepEqual(fs.readdirSync(path.join(work, 'data')).filter((f) => f.includes('.tc-update-')), [],
        'no temp file is left in the checkout');
      assert.equal(git(work, ['status', '--porcelain']), ' M data/global-rules.md\n', 'only the edit, as before');
      assertUntouched(EDIT_TOP);
    });

    it('a failed flag restore is compensated too', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      git(work, ['update-index', '--skip-worktree', RULES]);
      failGitOnce(`update-index --skip-worktree -- ${RULES}`, new Error('index.lock exists'));
      const r = applier.applyUpdate();
      assert.equal(r.code, 'git-error', JSON.stringify(r));
      assertUntouched(EDIT_TOP, 'S');
    });

    it('from a detached release tag, compensation returns to that exact commit', () => {
      git(work, ['checkout', '-q', 'v1.0.0']);
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      failGitOnce('checkout --no-overwrite-ignore v9.9.9', new Error('fatal: something else'));
      const r = applier.applyUpdate();
      assert.equal(r.code, 'git-error', JSON.stringify(r));
      assertUntouched(EDIT_TOP, 'H', 'HEAD');
    });

    it('when compensation itself fails, recovery-failed names the step, what was observed, and the backup', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      git(work, ['update-index', '--skip-worktree', RULES]);
      applier._internal.writeRepoFile = () => { throw new Error('read-only file system'); };
      const r = applier.applyUpdate();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'recovery-failed', JSON.stringify(r));
      assert.equal(r.recovery.failedStep, 'write-merged');
      assert.ok(applier.MOVE_STEPS.includes(r.recovery.failedStep), 'a stable step, not prose');
      assert.equal(r.recovery.fromSha, v1Sha);
      assert.equal(r.recovery.fromRef, 'main');
      assert.equal(r.recovery.backup.length, 1);
      assert.equal(fs.readFileSync(r.recovery.backup[0], 'utf8'), EDIT_TOP, 'the backup still holds the edit');
      // What was re-observed, each fact read for itself: the ref and the flag
      // were put back, the file's bytes were not.
      assert.deepEqual(r.recovery.observed, {
        headSha: v1Sha, ref: 'main', fileMatchesOriginal: false, flagsMatchOriginal: true
      });
      assert.match(r.error, /manual recovery is required/);
      assert.doesNotMatch(r.error, /read-only file system/, 'the repair\'s exception text stays in the log');
    });

    it('every injected failure reports a step from the stable list', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      failGitOnce('checkout --no-overwrite-ignore v9.9.9', new Error('boom'));
      applier._internal.writeRepoFile = () => { throw new Error('read-only file system'); };
      const r = applier.applyUpdate();
      assert.equal(r.code, 'recovery-failed', JSON.stringify(r));
      assert.equal(r.recovery.failedStep, 'checkout');
    });
  });

  describe('operator-facing text', () => {
    it('no reason\'s action names a git command (ADR 0010 clause 3, D4)', () => {
      // Every reason, for a carried path and for any other path, so a new
      // reason or a reworded one is swept too.
      const reasons = ['merge-conflict', 'skip-worktree', 'assume-unchanged', 'untracked-collision',
        'checkout-collision', 'backup-failed'];
      const GIT_ADVICE = /\b(git|commit|stash|checkout|pull|reset|rebase|merge-file|update-index)\b/i;
      for (const reason of reasons) {
        for (const p of [RULES, 'server.js']) {
          if (reason === 'merge-conflict' && p !== RULES) continue; // only a carried file is merged
          const item = applier._reconcileItem(p, reason, '/home/x/.tangleclaw/backups');
          assert.equal(typeof item.action, 'string', `${reason} has an action`);
          assert.doesNotMatch(item.action, GIT_ADVICE, `${reason} for ${p}: ${item.action}`);
        }
      }
    });
  });

  describe('(f) no backup, no update', () => {
    it('a backup directory that cannot be created refuses with backup-failed and changes nothing', () => {
      fs.mkdirSync(path.join(root, 'home'), { recursive: true });
      fs.writeFileSync(path.join(root, 'home', 'backups'), 'a file where the directory should be');
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      const r = applier.applyUpdate();
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.deepEqual(r.reconcile.map((x) => [x.path, x.reason]), [[RULES, 'backup-failed']]);
      assert.match(r.reconcile[0].action, /backups/, 'the action names the directory');
      assertUntouched(EDIT_TOP);
    });

    it('a backup that fails mid-write leaves no temporary file behind', () => {
      // fsync, not write: only the backup flushes, so this fails the backup
      // after its bytes are in the temporary file and nothing else.
      const realFsync = fs.fsyncSync;
      fs.fsyncSync = () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); };
      try {
        fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
        const r = applier.applyUpdate();
        assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
        assert.equal(r.reconcile[0].reason, 'backup-failed');
        assert.doesNotMatch(r.reconcile[0].action, /EIO/, 'the low-level error is not shown');
      } finally {
        fs.fsyncSync = realFsync;
      }
      assert.deepEqual(fs.readdirSync(backups), [], 'the unpublished temp file was removed');
      assertUntouched(EDIT_TOP);
    });

    it('never overwrites an earlier backup with different bytes', () => {
      fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
      const name = path.join(backups, `global-rules.${v1Sha.slice(0, 7)}-v9.9.9.md`);
      fs.writeFileSync(name, 'an earlier copy\n');
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(fs.readFileSync(name, 'utf8'), 'an earlier copy\n', 'the earlier backup is untouched');
      assert.notEqual(r.carried[0].backup, name);
      assert.equal(fs.readFileSync(r.carried[0].backup, 'utf8'), EDIT_TOP);
    });

    it('reuses an earlier backup whose bytes are identical', () => {
      fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
      const name = path.join(backups, `global-rules.${v1Sha.slice(0, 7)}-v9.9.9.md`);
      fs.writeFileSync(name, EDIT_TOP);
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      const r = applier.applyUpdate();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.carried[0].backup, name);
      assert.deepEqual(fs.readdirSync(backups), [path.basename(name)], 'no temporary file is left behind');
    });
  });

  describe('nothing is discarded before the preflight has passed', () => {
    const TC_HOOK = { hooks: [{ type: 'command', command: 'bash data/hooks/sessionstart-prime-claude.sh' }] };
    const OPERATOR_HOOK = { hooks: [{ type: 'command', command: 'echo mine' }] };
    const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

    it('a conflict refuses with the opted-in TangleClaw file still as it was', () => {
      // Commit a settings file carrying a hook TangleClaw retires, then retire
      // it: a proven TangleClaw delta the operator has agreed to discard.
      fs.mkdirSync(path.join(work, '.claude'));
      fs.writeFileSync(path.join(work, '.claude', 'settings.json'), json({ hooks: { SessionStart: [OPERATOR_HOOK, TC_HOOK] } }));
      git(work, ['add', '-A']);
      git(work, ['commit', '-qm', 'settings']);
      v1Sha = head();
      const retired = json({ hooks: { SessionStart: [OPERATOR_HOOK] } });
      fs.writeFileSync(path.join(work, '.claude', 'settings.json'), retired);
      fs.writeFileSync(path.join(work, RULES), EDIT_END);

      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.code, 'reconcile-required', JSON.stringify(r));
      assert.equal(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'), retired,
        'the discard did not run ahead of the refusal');
      assertUntouched(EDIT_END);
    });
  });

  describe('the dirty guard and the carried file (D3a, D9)', () => {
    it('an edited rules file is reported as carried: neither discardable nor blocking', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      fs.writeFileSync(path.join(work, 'server.js'), '// my edit\n');
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.code, 'dirty-tree', JSON.stringify(r));
      assert.deepEqual(r.dirty, { discardable: [], realWork: ['server.js'], carried: [RULES] });
      assert.equal(rulesBytes().toString('utf8'), EDIT_TOP);
    });

    it('a staged edit to the rules file is real work, not a carry', () => {
      fs.writeFileSync(path.join(work, RULES), EDIT_TOP);
      git(work, ['add', RULES]);
      const r = applier.applyUpdate({ discardDirty: true });
      assert.equal(r.code, 'dirty-tree', JSON.stringify(r));
      assert.deepEqual(r.dirty.realWork, [RULES]);
      assert.deepEqual(r.dirty.carried, [], 'an ambiguous state is never carried');
      assert.equal(head(), v1Sha);
    });
  });
});
