'use strict';

/*
 * Launch heal (#1511): migrate the retired key, keep state out of `git status`
 * with a local exclude, report tracked state, and never commit.
 *
 * Real repositories throughout: the behavior under test is what git itself does
 * with the exclude file (`git status`, `git check-ignore`), and where git keeps
 * that file in a worktree.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const heal = require('../lib/project-heal');
const wrapState = require('../lib/wrap-state');
const tcOwned = require('../lib/wrap-steps/_tc-owned-paths');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Run git with a fixed identity.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string} Trimmed stdout.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

/**
 * Write a file under a root.
 * @param {string} root
 * @param {string} rel
 * @param {string} text
 * @returns {void}
 */
function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/**
 * A repository on `main` with the given files committed.
 * @param {Object<string,string>} [files]
 * @returns {string} Repo path (symlinks resolved).
 */
function makeRepo(files = { 'README.md': 'x\n' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-heal-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

/**
 * Snapshot of what must not change when heal runs: HEAD, the index, and the log.
 * @param {string} repo
 * @returns {{head:string, index:string, count:string}}
 */
function gitSnapshot(repo) {
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    index: git(repo, 'ls-files', '-s'),
    count: git(repo, 'rev-list', '--count', 'HEAD')
  };
}

describe('the first launch heals, the second changes nothing', () => {
  it('migrates, writes the exclude block, reports, and commits nothing', () => {
    const repo = makeRepo({ '.tangleclaw/project.json': json({ engine: 'claude', lastWrapSha: 'abc1234' }) });
    write(repo, '.tangleclaw/session-prime.md', 'prime\n');
    write(repo, '.tangleclaw/continuity/index.md', 'i\n');
    const before = gitSnapshot(repo);

    const r = heal.healOnLaunch(repo);
    assert.equal(r.migrated, true);
    assert.equal(r.exclude, 'added');
    assert.deepEqual(r.trackedState, []);
    assert.match(r.report, /moved lastWrapSha out of project\.json/);
    assert.match(r.report, /local git exclude/);
    assert.match(r.report, /Nothing was committed\.$/);

    assert.deepEqual(gitSnapshot(repo), before, 'heal never commits or stages');
    assert.equal(wrapState.readLastWrapSha(repo).sha, 'abc1234');
    // Only the migration shows; every state file, the new state.json included, is ignored.
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), 'M .tangleclaw/project.json');
  });

  it('a second launch writes nothing and reports nothing', () => {
    const repo = makeRepo({ '.tangleclaw/project.json': json({ engine: 'claude', lastWrapSha: 'abc1234' }) });
    heal.healOnLaunch(repo);
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    const excludeAfter = fs.readFileSync(exclude, 'utf8');
    const configAfter = fs.readFileSync(path.join(repo, '.tangleclaw', 'project.json'), 'utf8');
    const stateAfter = fs.readFileSync(wrapState.statePath(repo), 'utf8');

    const r = heal.healOnLaunch(repo);
    assert.equal(r.report, null);
    assert.equal(r.exclude, 'current');
    assert.equal(r.migrated, false);
    assert.equal(fs.readFileSync(exclude, 'utf8'), excludeAfter);
    assert.equal(fs.readFileSync(path.join(repo, '.tangleclaw', 'project.json'), 'utf8'), configAfter);
    assert.equal(fs.readFileSync(wrapState.statePath(repo), 'utf8'), stateAfter);
  });
});

describe('the exclude block', () => {
  it('every state pattern ignores exactly what its matcher calls state', () => {
    const repo = makeRepo();
    heal.healOnLaunch(repo);
    const samples = {
      state: ['.tangleclaw/session-prime.md', '.tangleclaw/ui-wrap-advisory.md', '.tangleclaw/medusa/registry.json',
        '.tangleclaw/state.json', '.tangleclaw/session-rules-3.json', '.tangleclaw/session-rules-receipt.json',
        '.tangleclaw/project-version.txt', '.tangleclaw/.project-version.txt.42.tmp', '.tangleclaw/critic-runs.json',
        '.tangleclaw/continuity/sessions/1/transcript.jsonl', '.tangleclaw/.wrap-summary.md'],
      authored: ['.tangleclaw/project.json', '.tangleclaw/plans/next.md', '.tangleclaw/memories/MEMORY.md',
        '.tangleclaw/priming/role.md', 'src/.tangleclaw/session-prime.md', 'CLAUDE.md']
    };
    const ignored = (p) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: repo });
        return true;
      } catch {
        return false;
      }
    };
    for (const p of samples.state) {
      assert.equal(tcOwned.isStatePath(p), true, `fixture: ${p} is state`);
      assert.equal(ignored(p), true, `${p} is excluded`);
    }
    for (const p of samples.authored) {
      assert.equal(ignored(p), false, `${p} is NOT excluded`);
    }
  });

  it('keeps the operator\'s own exclude lines and replaces a stale block in place', () => {
    const repo = makeRepo();
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, `# mine\n*.local\n${heal.EXCLUDE_BEGIN}\n/.tangleclaw/old-name.md\n${heal.EXCLUDE_END}\nafter.txt\n`);
    const r = heal.healOnLaunch(repo);
    assert.equal(r.exclude, 'updated');
    const text = fs.readFileSync(exclude, 'utf8');
    assert.ok(text.startsWith('# mine\n*.local\n'));
    assert.ok(text.endsWith(`${heal.EXCLUDE_END}\nafter.txt\n`));
    assert.doesNotMatch(text, /old-name/);
    assert.equal(text.split(heal.EXCLUDE_BEGIN).length, 2, 'exactly one block');
  });

  it('appends after a file with no trailing newline without merging lines', () => {
    const out = heal.renderExclude('*.local', ['/a']);
    assert.equal(out.text, `*.local\n${heal.EXCLUDE_BEGIN}\n/a\n${heal.EXCLUDE_END}\n`);
  });

  it('leaves a malformed block alone and says so', () => {
    const repo = makeRepo();
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    const broken = `${heal.EXCLUDE_BEGIN}\n/x\n`;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, broken);
    const r = heal.healOnLaunch(repo);
    assert.equal(r.exclude, 'skipped');
    assert.match(r.excludeReason, /malformed/);
    assert.match(r.report, /could not finish: .*malformed/);
    assert.equal(fs.readFileSync(exclude, 'utf8'), broken);
  });

  it('a worktree writes the exclude git actually reads — the shared one — not a file in the worktree', () => {
    const repo = makeRepo();
    const wt = `${repo}-wt`;
    dirs.push(wt);
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/wt', wt);
    assert.equal(fs.statSync(path.join(wt, '.git')).isFile(), true, 'fixture: a worktree\'s .git is a file');

    const r = heal.healOnLaunch(wt);
    assert.equal(r.exclude, 'added');
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /BEGIN:tangleclaw-state/);
    write(wt, '.tangleclaw/session-prime.md', 'p\n');
    assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=all'), '', 'git honors it inside the worktree');
  });
});

describe('what heal only reports', () => {
  it('names tracked state files, which an exclude cannot hide, and leaves them tracked', () => {
    const repo = makeRepo({ 'README.md': 'x\n', '.tangleclaw/medusa/registry.json': '{}\n', '.tangleclaw/session-prime.md': 'p\n', '.tangleclaw/plans/a.md': 'plan\n' });
    const r = heal.healOnLaunch(repo);
    assert.deepEqual(r.trackedState.sort(), ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md']);
    assert.match(r.report, /2 TangleClaw state files are still tracked by git \(the wrap offers to stop tracking them\)/);
    assert.equal(git(repo, 'ls-files', '--', '.tangleclaw/medusa/registry.json'), '.tangleclaw/medusa/registry.json');
  });

  it('a folder that is not a repository gets a reason and no report, and still migrates', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-heal-norepo-')));
    dirs.push(dir);
    write(dir, '.tangleclaw/project.json', json({ engine: 'claude', lastWrapSha: 'abc1234' }));
    const r = heal.healOnLaunch(dir);
    assert.equal(r.exclude, 'skipped');
    assert.equal(r.excludeReason, 'not a git repository');
    assert.equal(r.migrated, true);
    assert.doesNotMatch(r.report, /could not finish/);
  });

  it('a project below its repository root is skipped for the exclude, with the reason', () => {
    const repo = makeRepo({ 'svc/README.md': 'x\n' });
    const r = heal.healOnLaunch(path.join(repo, 'svc'));
    assert.equal(r.exclude, 'skipped');
    assert.match(r.excludeReason, /below its repository root \(svc\)/);
    assert.equal(fs.existsSync(path.join(repo, '.git', 'info', 'exclude'))
      && fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes('tangleclaw-state'), false);
  });

  it('a git failure that is not "not a repository" is reported as unfinished', () => {
    const orig = heal._internal.git;
    heal._internal.git = () => { const e = new Error('boom'); e.stderr = 'fatal: index file corrupt'; throw e; };
    try {
      const r = heal.healOnLaunch(makeRepo());
      assert.match(r.report, /could not finish: git could not locate the repository: fatal: index file corrupt/);
    } finally {
      heal._internal.git = orig;
    }
  });
});
