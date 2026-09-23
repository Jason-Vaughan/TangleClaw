'use strict';

/*
 * A wrap that cuts a release runs the project's `releasePrepareCommand` before
 * it commits (#1502).
 *
 * The first wrap-cut release of this repo went red in CI: the wrap bumped
 * `version.json` and promoted `CHANGELOG.md`, and never touched the README
 * clone pins or the released-sections lock that the release also needs. These
 * tests drive the commit step against real repositories, because which files a
 * command changed, and what the commit then contains, are git's answers.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const commitStep = require('../lib/wrap-steps/commit');
const launchBaseline = require('../lib/launch-baseline');
const wrapScope = require('../lib/wrap-scope');
const { execFileArgs } = require('../lib/exec');
const { initRepo } = require('./_temp-repo');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const OLD_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n- a thing\n\n## [1.0.0] - 2026-01-01\n\n- first\n';
const NEW_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-09-14\n\n### Added\n- a thing\n\n## [1.0.0] - 2026-01-01\n\n- first\n';

/**
 * Run git in a repo.
 * @param {string} cwd - Repo directory.
 * @param {...string} args - Argv after `git`.
 * @returns {string} Trimmed stdout.
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A temp directory removed after the suite.
 * @param {string} prefix - Directory name prefix.
 * @returns {string} Path, symlinks resolved.
 */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/**
 * A released project on a feature branch, with its project config committed so
 * the config file is not itself an uncommitted change.
 * @param {object} config - `.tangleclaw/project.json` contents.
 * @returns {string} Repo path.
 */
function makeRepo(config) {
  const dir = tmp('tc-relprep-');
  initRepo(dir, ['-q', '-b', 'main']);
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'version.json'), '{\n  "version": "1.0.0"\n}\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), OLD_CHANGELOG);
  fs.writeFileSync(path.join(dir, 'README.md'), 'clone --branch v1.0.0 x\n');
  fs.mkdirSync(path.join(dir, '.tangleclaw'));
  fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify(config));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'feat/session');
  return dir;
}

/**
 * Write a node script outside the repo and return a shell command running it.
 * @param {string} body - Script source.
 * @returns {string} Command.
 */
function script(body) {
  const file = path.join(tmp('tc-relprep-cmd-'), 'prep.js');
  fs.writeFileSync(file, body);
  return `node ${JSON.stringify(file)}`;
}

/**
 * The entries `version-bump` stages for a 1.0.0 → 1.1.0 cut.
 * @param {string} repo - Repo path.
 * @returns {object}
 */
function cutStaged(repo) {
  const meta = { changed: true, oldVersion: '1.0.0', newVersion: '1.1.0', bumpLevel: 'minor' };
  return {
    'version-bump:version-json': { primingPath: path.join(repo, 'version.json'), newContent: '{\n  "version": "1.1.0"\n}\n', ...meta },
    'version-bump:changelog': { primingPath: path.join(repo, 'CHANGELOG.md'), newContent: NEW_CHANGELOG, ...meta }
  };
}

/**
 * Run the commit step as the pipeline would, for a session launched now.
 * @param {string} repo - Repo path.
 * @param {object} staged - Staged writes.
 * @param {object} [options] - Run options.
 * @param {object|null} [baseline] - Launch baseline; captured now when omitted.
 * @returns {Promise<object>}
 */
async function runCommit(repo, staged, options = {}, baseline = launchBaseline.capture(repo)) {
  const scope = await wrapScope.resolve({ name: 'own', path: repo }, { id: 1, tmuxSession: 'own', startedAt: '2000-01-01 00:00:00' }, {
    exec: (file, args, opts) => execFileArgs(file, args, { cwd: opts.cwd, timeoutMs: 10000, maxBufferBytes: 1024 * 1024 }),
    paneCurrentPath: () => repo,
    getLaunchBaseline: () => baseline
  });
  return commitStep.run({
    project: wrapScope.stepProject({ id: 1, name: 'own', path: repo }, scope),
    session: null,
    step: { id: 'commit' },
    previousResults: [],
    staged,
    options,
    scope
  });
}

/**
 * Files in the HEAD commit.
 * @param {string} repo - Repo path.
 * @returns {string[]} Sorted paths.
 */
function committedFiles(repo) {
  return git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter((p) => !p.startsWith('.tangleclaw/')).sort();
}

const PIN_SCRIPT = `
const fs = require('fs');
const v = process.env.TANGLECLAW_RELEASE_VERSION;
fs.writeFileSync('README.md', 'clone --branch v' + v + ' x\\n');
fs.appendFileSync('CHANGELOG.md', '<!-- prepared ' + process.env.TANGLECLAW_RELEASE_PREVIOUS + ' -> ' + v + ' -->\\n');
`;

describe('releasePrepareCommand on a release cut (#1502)', () => {
  it('runs after the flush with the release in its environment, and its files land in the wrap commit', async () => {
    const repo = makeRepo({ releasePrepareCommand: script(PIN_SCRIPT) });
    const r = await runCommit(repo, cutStaged(repo));

    assert.equal(r.status, 'done', JSON.stringify(r.blockers));
    assert.deepEqual(committedFiles(repo), ['CHANGELOG.md', 'README.md', 'version.json']);
    assert.equal(git(repo, 'show', 'HEAD:README.md'), 'clone --branch v1.1.0 x');
    assert.match(git(repo, 'show', 'HEAD:CHANGELOG.md'), /## \[1\.1\.0\] - 2026-09-14[\s\S]*<!-- prepared 1\.0\.0 -> 1\.1\.0 -->/,
      'the command saw the promoted CHANGELOG on disk, and its edit to a flushed file was committed');
    assert.deepEqual(r.output.releasePrepare.paths, ['CHANGELOG.md', 'README.md'],
      'a path already uncommitted before the command (the flushed CHANGELOG) still counts when the command changes it');
    assert.equal(r.output.releasePrepare.status, 'done');
    assert.match(r.output.message, /- Release files updated by releasePrepareCommand: CHANGELOG\.md, README\.md/);
    assert.equal(git(repo, 'status', '--porcelain', '--', 'README.md', 'CHANGELOG.md', 'version.json'), '');
  });

  it('does not run when the wrap cuts no release', async () => {
    const marker = path.join(tmp('tc-relprep-marker-'), 'ran');
    const repo = makeRepo({ releasePrepareCommand: script(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`) });
    const baseline = launchBaseline.capture(repo);
    fs.writeFileSync(path.join(repo, 'mine.js'), 'session work\n');
    // A new file waits for an explicit answer (#1724); this case is about the command, so it is included.
    const r = await runCommit(repo, {}, { pathDecisions: { 'mine.js': 'include' } }, baseline);

    assert.equal(r.status, 'done');
    assert.equal(fs.existsSync(marker), false, 'the command never ran');
    assert.equal(r.output.releasePrepare, null);
  });

  it('says so when a release is cut and no command is configured', async () => {
    const repo = makeRepo({});
    const r = await runCommit(repo, cutStaged(repo));

    assert.equal(r.status, 'done');
    assert.deepEqual(r.output.releasePrepare, { status: 'skipped', reason: 'no releasePrepareCommand configured' });
    assert.deepEqual(committedFiles(repo), ['CHANGELOG.md', 'version.json']);
  });

  it('treats a non-string command as unset rather than running or stopping on it', async () => {
    const repo = makeRepo({ releasePrepareCommand: ['node', 'x.js'] });
    const r = await runCommit(repo, cutStaged(repo));

    assert.equal(r.status, 'done');
    assert.deepEqual(r.output.releasePrepare, { status: 'skipped', reason: 'releasePrepareCommand is not a command string (got an array)' });
  });

  it('an unreadable project config is named as the reason, not reported as "not configured"', async () => {
    const repo = makeRepo({});
    fs.writeFileSync(path.join(repo, '.tangleclaw', 'project.json'), '{"releasePrepareCommand": "node x.js",');
    git(repo, 'commit', '-q', '-am', 'break the config');
    const r = await runCommit(repo, cutStaged(repo));

    assert.equal(r.status, 'done');
    assert.equal(r.output.releasePrepare.status, 'skipped');
    assert.match(r.output.releasePrepare.reason, /^\.tangleclaw\/project\.json could not be read \(.+\), so releasePrepareCommand was not run$/);
  });

  it('the auto-PR body names the release files, the same line the commit message carries', () => {
    const staged = {
      ...cutStaged('/r'),
      'commit:release-prepare': { releaseCompanions: ['README.md', 'test/fixtures/x.lock.json'] }
    };
    const lines = commitStep._buildBodyLines(staged);
    assert.ok(lines.includes('- Release files updated by releasePrepareCommand: README.md, test/fixtures/x.lock.json'), lines.join('\n'));
    assert.equal(lines.filter((l) => l.startsWith('- Bumped')).length, 1);
    assert.ok(!commitStep._buildBodyLines({ 'commit:release-prepare': { releaseCompanions: [] } }).length,
      'an empty list writes no line');
    assert.equal(commitStep._releaseCutOf({ x: { oldVersion: '1.0.0', newVersion: '1.1.0' } }), null,
      'the release test is the same one the body uses: an entry without a bump level is not a cut');
  });

  it('a failing command commits nothing, puts the release files back, and shows its output', async () => {
    const repo = makeRepo({
      releasePrepareCommand: script("require('fs').writeFileSync('README.md', 'half done\\n'); console.error('lock regen boom'); process.exit(3);")
    });
    const head = git(repo, 'rev-parse', 'HEAD');
    const staged = cutStaged(repo);
    staged['other:new-file'] = { primingPath: path.join(repo, 'NEW.md'), newContent: 'flushed\n', changed: true };
    const r = await runCommit(repo, staged);

    assert.equal(r.status, 'blocked');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.match(r.blockers[0], /releasePrepareCommand exited 3/);
    assert.ok(r.blockers.some((b) => b.includes('lock regen boom')), 'the command\'s stderr is in the blockers');
    assert.equal(fs.readFileSync(path.join(repo, 'version.json'), 'utf8'), '{\n  "version": "1.0.0"\n}\n', 'the bump was put back');
    assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), OLD_CHANGELOG, 'the promotion was put back, so Retry finds [Unreleased] to cut again');
    assert.equal(fs.existsSync(path.join(repo, 'NEW.md')), false, 'a flushed file that did not exist before is removed');
    assert.deepEqual(r.output.releasePrepare, { status: 'failed', command: r.output.releasePrepare.command, paths: ['README.md'] });
    assert.match(r.output.remediation, /put back, so Retry cuts the release again/);
    assert.match(r.output.remediation, /already changed README\.md/);
  });

  it('a command that outruns its limit is reported as stopped, not as failed', async () => {
    const repo = makeRepo({ releasePrepareCommand: script('setTimeout(() => {}, 20000);') });
    const saved = commitStep._internal.releasePrepareTimeoutMs;
    commitStep._internal.releasePrepareTimeoutMs = 300;
    let r;
    try {
      r = await runCommit(repo, cutStaged(repo));
    } finally {
      commitStep._internal.releasePrepareTimeoutMs = saved;
    }

    assert.equal(r.status, 'blocked');
    assert.match(r.blockers[0], /stopped after 0s without finishing/);
    assert.match(r.output.remediation, /did not finish in time and was stopped/);
    assert.doesNotMatch(r.output.remediation, /did not succeed/);
    assert.equal(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), OLD_CHANGELOG);
  });

  it('an operator\'s Leave on a file uncommitted at launch holds even when the command rewrites it', async () => {
    const repo = makeRepo({ releasePrepareCommand: script(PIN_SCRIPT) });
    fs.writeFileSync(path.join(repo, 'README.md'), 'operator draft\n');
    const baseline = launchBaseline.capture(repo);
    const r = await runCommit(repo, cutStaged(repo), { pathDecisions: { 'README.md': 'leave' } }, baseline);

    assert.equal(r.status, 'done', JSON.stringify(r.blockers));
    assert.deepEqual(committedFiles(repo), ['CHANGELOG.md', 'version.json']);
    assert.doesNotMatch(r.output.message, /README\.md/, 'the body names only what was committed');
    // Read untrimmed: the leading space is the "not staged" half of the status code.
    const status = execFileSync('git', ['status', '--porcelain', '--', 'README.md'], { cwd: repo, encoding: 'utf8' });
    assert.equal(status, ' M README.md\n', 'still uncommitted and unstaged');
    assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /v1\.1\.0/, 'the command did run on it');
  });
});
