'use strict';

/*
 * #1537 — the self-updater must never delete or revert authored content.
 *
 * On 2026-09-16 an update deleted an uncommitted plan under
 * `.tangleclaw/plans/`, because every `.tangleclaw/` path was classed as
 * TangleClaw-written, and the confirm dialog said nothing of the operator's was
 * in the list. The unit suites stub git; this one drives `applyUpdate` against a
 * REAL repository with a real origin, so the claim under test is the one the
 * operator cares about: after the update path runs, is the file still there,
 * byte for byte?
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

const REPO_DIR = path.join(__dirname, '..');
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
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['init', '-q', '-b', 'main', work]);
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
    git(root, ['clone', '-q', origin, cutter]);
    fs.writeFileSync(path.join(cutter, 'server.js'), '// v9\n');
    git(cutter, ['add', '-A']);
    git(cutter, ['commit', '-qm', 'v9']);
    git(cutter, ['tag', 'v9.9.9']);
    git(cutter, ['push', '-q', 'origin', 'main', '--tags']);

    orig = { git: applier._internal.git, readFile: applier._internal.readFile, check: applier._internal.checkForUpdate };
    applier._internal.git = (args) => git(work, args);
    applier._internal.readFile = (abs) => fs.readFileSync(path.join(work, path.relative(REPO_DIR, abs)), 'utf8');
    applier._internal.checkForUpdate = () => ({ updateAvailable: true, latestVersion: '9.9.9' });
  });

  afterEach(() => {
    applier._internal.git = orig.git;
    applier._internal.readFile = orig.readFile;
    applier._internal.checkForUpdate = orig.check;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('an uncommitted plan survives an update with the discard opt-in, byte for byte', () => {
    const plan = path.join(work, '.tangleclaw', 'plans', 'inbox-triage.md');
    fs.writeFileSync(plan, '# my plan\n\nunsaved thought\n');
    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'dirty-tree');
    assert.deepEqual(r.dirty.discardable, []);
    assert.ok(r.dirty.realWork.some((p) => p.startsWith('.tangleclaw/plans/')), JSON.stringify(r.dirty));
    assert.equal(fs.readFileSync(plan, 'utf8'), '# my plan\n\nunsaved thought\n');
    assert.equal(git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main', 'nothing moved');
  });

  it('a hand edit to a tracked plan survives, and is not reverted', () => {
    const plan = path.join(work, '.tangleclaw', 'plans', 'tracked.md');
    fs.writeFileSync(plan, 'committed plan\nplus my edit\n');
    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.code, 'dirty-tree');
    assert.deepEqual(r.dirty, { discardable: [], realWork: ['.tangleclaw/plans/tracked.md'] });
    assert.equal(fs.readFileSync(plan, 'utf8'), 'committed plan\nplus my edit\n');
  });

  it('TangleClaw retiring its own hook is restored and the update proceeds', () => {
    fs.writeFileSync(path.join(work, '.claude', 'settings.json'),
      json({ hooks: { SessionStart: [OPERATOR_HOOK] } }));
    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.toRef, 'v9.9.9');
    assert.equal(fs.readFileSync(path.join(work, 'server.js'), 'utf8'), '// v9\n');
  });

  it('an operator edit to .claude/settings.json blocks the update and is kept', () => {
    const edited = json({ permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [OPERATOR_HOOK, TC_HOOK] } });
    fs.writeFileSync(path.join(work, '.claude', 'settings.json'), edited);
    const r = applier.applyUpdate({ discardDirty: true });
    assert.equal(r.code, 'dirty-tree');
    assert.deepEqual(r.dirty, { discardable: [], realWork: ['.claude/settings.json'] });
    assert.equal(fs.readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'), edited);
  });
});
