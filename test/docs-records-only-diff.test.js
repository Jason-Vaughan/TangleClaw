'use strict';

/**
 * `scripts/docs-records-only-diff.js` (Bottleneck A/B).
 *
 * The predicate (`evaluate`) is exercised directly for its glob roster, and
 * the CLI is exercised once end to end over a real git repository so the
 * `git merge-base` / `git diff -z` plumbing is covered too, not just the glob.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');

const diffGuard = require('../scripts/docs-records-only-diff.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'docs-records-only-diff.js');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

describe('docs-records-only-diff: the glob roster', () => {
  it('passes an empty diff', () => {
    assert.deepEqual(diffGuard.evaluate([]), { ok: true, offender: null });
  });

  it('passes every named roster shape, including a nested docs/ file', () => {
    const verdict = diffGuard.evaluate([
      'FEATURES.md',
      'CHANGELOG.md',
      'changelog.d/2371.suite-evidence.internal.md',
      '.prawduct/project-state.yaml',
      '.prawduct/artifacts/build-plan.md',
      'docs/lane-ci-evidence.md',
      'README.md',
      'version.json',
      'test/fixtures/changelog-released-sections.lock.json'
    ]);
    assert.deepEqual(verdict, { ok: true, offender: null });
  });

  it('fails on a single code file mixed in with records files', () => {
    const verdict = diffGuard.evaluate(['CHANGELOG.md', 'lib/store.js']);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.offender, 'lib/store.js');
  });

  it('does not let a docs/-prefixed code path through on a filename coincidence', () => {
    // Guards the glob itself: "docs" must anchor a path SEGMENT, not just a
    // string prefix a later rename could abuse (e.g. `docsync/build.js`).
    const verdict = diffGuard.evaluate(['docsync/build.js']);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.offender, 'docsync/build.js');
  });

  it('a changelog fragment outside changelog.d/ does not pass as one', () => {
    const verdict = diffGuard.evaluate(['changelog.d.bak/2371.md']);
    assert.equal(verdict.ok, false);
  });
});

describe('docs-records-only-diff: parseArgs', () => {
  it('requires --base', () => {
    assert.throws(() => diffGuard.parseArgs([]), /--base is required/);
  });

  it('rejects an unrecognized flag', () => {
    assert.throws(() => diffGuard.parseArgs(['--base', 'main', '--bogus', 'x']), /unrecognized argument/);
  });
});

describe('docs-records-only-diff: the CLI over a real git repository', () => {
  /**
   * A throwaway repository with a base commit, then a branch carrying one edit.
   *
   * @param {(dir: string) => void} edit - Mutates the working tree for the branch commit.
   * @returns {{dir: string, cleanup: () => void}}
   */
  function makeRepo(edit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-records-only-diff-'));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: GIT_ENV });
    initRepo(dir, ['-b', 'main'], { env: GIT_ENV });
    run('config', 'user.email', 'guard@test.invalid');
    run('config', 'user.name', 'guard');
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    run('checkout', '-q', '-b', 'topic');
    edit(dir);
    run('add', '-A');
    run('commit', '-q', '-m', 'topic');
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  /**
   * @param {string} dir - Repository path.
   * @param {string[]} args - Extra arguments.
   * @returns {{status: number, out: string}}
   */
  function run(dir, args) {
    const res = require('node:child_process').spawnSync(
      process.execPath, [SCRIPT, '--repo', dir, ...args], { encoding: 'utf8', env: GIT_ENV }
    );
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
  }

  it('exits 0 and says yes for a docs-only branch', () => {
    const repo = makeRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '## Unreleased\n');
    });
    try {
      const { status, out } = run(repo.dir, ['--base', 'main', '--head', 'topic']);
      assert.equal(status, 0, out);
      assert.ok(out.includes('docs-only: yes'), out);
    } finally {
      repo.cleanup();
    }
  });

  it('exits 0 and says no, naming the file, for a branch touching code', () => {
    const repo = makeRepo((dir) => {
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib', 'store.js'), 'module.exports = {};\n');
    });
    try {
      const { status, out } = run(repo.dir, ['--base', 'main', '--head', 'topic']);
      assert.equal(status, 0, out);
      assert.ok(out.includes('docs-only: no'), out);
      assert.ok(out.includes('lib/store.js'), out);
    } finally {
      repo.cleanup();
    }
  });

  it('exits 1 with no --base', () => {
    const repo = makeRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'README.md'), 'topic\n');
    });
    try {
      const { status, out } = run(repo.dir, ['--head', 'topic']);
      assert.equal(status, 1, out);
    } finally {
      repo.cleanup();
    }
  });

  it('writes docs_only to $GITHUB_OUTPUT when set', () => {
    const repo = makeRepo((dir) => {
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '## Unreleased\n');
    });
    const outputFile = path.join(os.tmpdir(), `docs-records-only-diff-output-${process.pid}-${Date.now()}`);
    try {
      const res = require('node:child_process').spawnSync(
        process.execPath,
        [SCRIPT, '--repo', repo.dir, '--base', 'main', '--head', 'topic'],
        { encoding: 'utf8', env: { ...GIT_ENV, GITHUB_OUTPUT: outputFile } }
      );
      assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.equal(fs.readFileSync(outputFile, 'utf8'), 'docs_only=true\n');
    } finally {
      repo.cleanup();
      fs.rmSync(outputFile, { force: true });
    }
  });
});
