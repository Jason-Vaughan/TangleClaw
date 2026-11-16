'use strict';

/*
 * #1537 — the self-updater must never delete or revert authored content
 * WITHOUT the operator's explicit, informed confirmation.
 *
 * On 2026-09-16 an update deleted an uncommitted plan under
 * `.tangleclaw/plans/`, because every `.tangleclaw/` path was classed as
 * TangleClaw-written, and the confirm dialog said nothing of the operator's was
 * in the list. The unit suites stub git; this one drives `applyUpdate` against a
 * REAL repository with a real origin, so the claim under test is the one the
 * operator cares about.
 *
 * #3126 changed what that claim IS, deliberately: the unconfirmed call
 * (`applyUpdate()`, no `discardDirty`) still refuses outright and leaves every
 * byte exactly where it was — that half of #1537's guarantee is unchanged and
 * still pinned here. The confirmed call (`applyUpdate({ discardDirty: true })`)
 * now backs up the file via `_secureBackup` and then restores/removes it, so
 * it is no longer "byte for byte in the working tree" afterward — it is byte
 * for byte in the reported backup copy instead. Both halves are pinned below,
 * reflecting Rulings A819/A820.
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
const { initRepo, cloneRepo } = require('./_temp-repo');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
};

/**
 * Run git in a directory.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
}

const TC_HOOK = { hooks: [{ type: 'command', command: 'bash data/hooks/sessionstart-prime-claude.sh' }] };
const OPERATOR_HOOK = { hooks: [{ type: 'command', command: 'echo mine' }] };
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

describe('the self-updater preserves authored content in a real repository (#1537)', () => {
  let root, work, orig;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1537-'));
    const origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    initRepo(root, ['--bare', '-b', 'main', origin], { env: GIT_ENV });
    initRepo(root, ['-b', 'main', work], { env: GIT_ENV });
    // The same ignore shape this repository ships: machine state ignored,
    // authored plans and priming re-included.
    fs.writeFileSync(path.join(work, '.gitignore'), '.tangleclaw/*\n!.tangleclaw/plans/\n!.tangleclaw/priming/\n');
    fs.mkdirSync(path.join(work, '.tangleclaw', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(work, '.tangleclaw', 'plans', 'tracked.md'), 'committed plan\n');
    fs.mkdirSync(path.join(work, '.claude'));
    fs.writeFileSync(path.join(work, '.claude', 'settings.json'),
      json({ hooks: { SessionStart: [OPERATOR_HOOK, TC_HOOK] } }));
    git(work, ['add', '-A']);
    git(work, ['commit', '-qm', 'v1']);
    git(work, ['tag', 'v1.0.0']);
    git(work, ['remote', 'add', 'origin', origin]);
    git(work, ['push', '-q', 'origin', 'main', '--tags']);
    // A newer release on origin, cut from a scratch clone so `work` stays at v1.
    const cutter = path.join(root, 'cutter');
    cloneRepo(origin, cutter, [], { cwd: root, env: GIT_ENV });
    fs.writeFileSync(path.join(cutter, 'server.js'), '// v9\n');
    git(cutter, ['add', '-A']);
    git(cutter, ['commit', '-qm', 'v9']);
    git(cutter, ['tag', 'v9.9.9']);
    git(cutter, ['push', '-q', 'origin', 'main', '--tags']);

    orig = {
      git: applier._internal.git, readFile: applier._internal.readFile,
      check: applier._internal.checkForUpdate, repoDir: applier._internal.repoDir
    };
    applier._internal.git = (args) => git(work, args);
    applier._internal.repoDir = work;
    // `repoDir` is `work`, so every path the applier reads is already under it:
    // read it as given, and refuse one that is not. Rebuilding it relative to
    // the checkout would depend on how deep the checkout and the temp
    // directory each sit, which differs between machines.
    applier._internal.readFile = (abs) => {
      assert.ok(!path.relative(work, abs).startsWith('..'), `read outside the test repo: ${abs}`);
      return fs.readFileSync(abs, 'utf8');
    };
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
    // Real-repo tests never need the real SQLite backup step — it runs only
    // after the dirty-tree check below has already passed, which half of
    // these tests reach now that #3126 lets a confirmed discard proceed.
    orig.backupSqlite = applier._internal.backupSqlite;
    applier._internal.backupSqlite = () => ({ path: '/dev/null/stub.db', sha256: '0'.repeat(64) });
    // The real-work backup (#3126) genuinely exercises `_secureBackup` — the
    // thing these tests now verify recovers the operator's bytes — so it is
    // NOT stubbed, only redirected to a scratch directory under `root`, never
    // this machine's own real ~/.tangleclaw/backups/ (the default `backupDir`
    // when `store._setBasePath` is never called, which this file never does).
    orig.backupDir = applier._internal.backupDir;
    applier._internal.backupDir = () => path.join(root, 'backups');
  });

  afterEach(() => {
    applier._internal.git = orig.git;
    applier._internal.readFile = orig.readFile;
    applier._internal.checkForUpdate = orig.check;
    applier._internal.repoDir = orig.repoDir;
    applier._internal.backupSqlite = orig.backupSqlite;
    applier._internal.backupDir = orig.backupDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('an uncommitted plan survives UNCONFIRMED, byte for byte, then is backed up and removed once confirmed', () => {
    const plan = path.join(work, '.tangleclaw', 'plans', 'inbox-triage.md');
    const content = '# my plan\n\nunsaved thought\n';
    fs.writeFileSync(plan, content);

    // Unconfirmed: #1537's original guarantee, unchanged by #3126 — nothing
    // moves without the operator's explicit discardDirty: true.
    const refused = applier.applyUpdate();
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'dirty-tree');
    assert.deepEqual(refused.dirty.discardable, []);
    assert.ok(refused.dirty.realWork.some((p) => p.startsWith('.tangleclaw/plans/')), JSON.stringify(refused.dirty));
    assert.equal(fs.readFileSync(plan, 'utf8'), content);
    assert.equal(git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main', 'nothing moved');

    // Confirmed: #3126 — backed up first, then removed (untracked), and the
    // update proceeds.
    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.toRef, 'v9.9.9');
    const backed = r.backedUpRealWork.find((b) => b.path === '.tangleclaw/plans/inbox-triage.md');
    assert.ok(backed, JSON.stringify(r.backedUpRealWork));
    assert.equal(fs.readFileSync(backed.backup, 'utf8'), content, 'the exact original bytes are recoverable from the backup');
    assert.equal(fs.existsSync(plan), false, 'removed from the working tree — untracked, so git has nothing to restore it from');
  });

  it('a hand edit to a tracked plan survives UNCONFIRMED, then is backed up and restored to the committed copy once confirmed', () => {
    const plan = path.join(work, '.tangleclaw', 'plans', 'tracked.md');
    const edited = 'committed plan\nplus my edit\n';
    fs.writeFileSync(plan, edited);

    const refused = applier.applyUpdate();
    assert.equal(refused.code, 'dirty-tree');
    assert.deepEqual(refused.dirty, { discardable: [], realWork: ['.tangleclaw/plans/tracked.md'], carried: [] });
    assert.equal(fs.readFileSync(plan, 'utf8'), edited);

    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const backed = r.backedUpRealWork.find((b) => b.path === '.tangleclaw/plans/tracked.md');
    assert.ok(backed, JSON.stringify(r.backedUpRealWork));
    assert.equal(fs.readFileSync(backed.backup, 'utf8'), edited, 'the hand edit is recoverable from the backup');
    assert.equal(fs.readFileSync(plan, 'utf8'), 'committed plan\n', 'restored to the committed copy, tracked — git had HEAD to restore it from');
  });

  it('TangleClaw retiring its own hook is restored and the update proceeds', () => {
    fs.writeFileSync(path.join(work, '.claude', 'settings.json'),
      json({ hooks: { SessionStart: [OPERATOR_HOOK] } }));
    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.toRef, 'v9.9.9');
    assert.equal(fs.readFileSync(path.join(work, 'server.js'), 'utf8'), '// v9\n');
  });

  it('an operator edit to .claude/settings.json blocks the update UNCONFIRMED, then is backed up and restored once confirmed', () => {
    const edited = json({ permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [OPERATOR_HOOK, TC_HOOK] } });
    const settings = path.join(work, '.claude', 'settings.json');
    fs.writeFileSync(settings, edited);

    const refused = applier.applyUpdate();
    assert.equal(refused.code, 'dirty-tree');
    assert.deepEqual(refused.dirty, { discardable: [], realWork: ['.claude/settings.json'], carried: [] });
    assert.equal(fs.readFileSync(settings, 'utf8'), edited);

    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const backed = r.backedUpRealWork.find((b) => b.path === '.claude/settings.json');
    assert.ok(backed, JSON.stringify(r.backedUpRealWork));
    assert.equal(fs.readFileSync(backed.backup, 'utf8'), edited, 'the operator permission edit is recoverable from the backup');
  });
});
