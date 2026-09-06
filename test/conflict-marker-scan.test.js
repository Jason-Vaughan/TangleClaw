'use strict';

/**
 * The conflict-marker detector (#882).
 *
 * Every marker in this file is BUILT at runtime (`'<'.repeat(7)`) rather than
 * typed. A fixture carrying a literal marker would be a tracked file carrying a
 * conflict marker, so the detector would fail its own repository — and a
 * detector excluded from its own scan is a detector nobody can trust.
 *
 * Each case runs against a real temporary git repository, because `git grep`
 * reads the tracked working tree and no stub of it would prove that.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { initRepo } = require('./_temp-repo');
const scanner = require('../scripts/conflict-marker-scan');

/** The three lines `git merge` writes, assembled so this file carries none. */
const OPEN = `${'<'.repeat(7)} HEAD`;
const SEPARATOR = '='.repeat(7);
const CLOSE = `${'>'.repeat(7)} origin/main`;
/** The fourth form: `diff3`/`zdiff3` opens the base section with this. */
const BASE = `${'|'.repeat(7)} merged common ancestors`;

describe('conflict-marker-scan (#882)', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cms-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Create a git repo with the given files committed.
   *
   * @param {Record<string,string>} files - Relative path → contents.
   * @returns {string} Absolute path to the repo.
   */
  function repoWith(files) {
    const dir = fs.mkdtempSync(path.join(root, 'repo-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    initRepo(dir);
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    return dir;
  }

  it('passes a tree with no markers', () => {
    const dir = repoWith({
      'README.md': '# Title\n\nProse that mentions a merge conflict without carrying one.\n',
      'lib/thing.js': "'use strict';\nmodule.exports = 1;\n"
    });
    const res = scanner.scan(dir);
    assert.equal(res.ok, true);
    assert.deepEqual(res.hits, []);
    assert.equal(res.error, null);
  });

  // Each marker form on its own: a partially hand-resolved conflict can leave
  // any one of the three behind, so matching only the full triple would miss the
  // case where an entry was buried rather than bracketed.
  for (const [name, marker] of [['opening', OPEN], ['base', BASE], ['separator', SEPARATOR], ['closing', CLOSE]]) {
    it(`fails on a lone ${name} marker`, () => {
      const dir = repoWith({ 'docs/notes.md': `before\n${marker}\nafter\n` });
      const res = scanner.scan(dir);
      assert.equal(res.ok, false, `a ${name} marker must fail the scan`);
      assert.equal(res.error, null, 'git answered — this is a finding, not an outage');
      assert.equal(res.hits.length, 1);
      assert.match(res.hits[0], /^docs\/notes\.md:2:/);
    });
  }

  it('reports every hit across a whole committed conflict, with file and line', () => {
    const dir = repoWith({
      '.prawduct/change-log.md': [
        '# Change Log', '', OPEN, '- entry from this side', BASE,
        '- the common ancestor', SEPARATOR, '- entry from the other side', CLOSE, ''
      ].join('\n')
    });
    const res = scanner.scan(dir);
    assert.equal(res.ok, false);
    assert.equal(res.hits.length, 4, 'every marker line is reported, not just the first');
    assert.deepEqual(
      res.hits.map((h) => h.split(':')[1]),
      ['3', '5', '7', '9'],
      'line numbers locate each marker'
    );
  });

  it('ignores an untracked file — an unstaged marker is a merge still in progress', () => {
    const dir = repoWith({ 'lib/thing.js': "'use strict';\n" });
    fs.writeFileSync(path.join(dir, 'scratch.md'), `${OPEN}\n${SEPARATOR}\n${CLOSE}\n`);
    const res = scanner.scan(dir);
    assert.equal(res.ok, true, 'git grep reads tracked files only');
  });

  it('does not match a marker that is indented or unpadded', () => {
    // git writes markers flush left and pads the labelled ones with a space.
    // Anchoring on both is what lets the scan run with no exclusion list.
    const dir = repoWith({
      'docs/style.md': `  ${OPEN}\n${'='.repeat(6)}\n${'<'.repeat(7)}x\n`
    });
    const res = scanner.scan(dir);
    assert.equal(res.ok, true);
  });

  it('treats a git that cannot answer as a failure, never as a clean tree', () => {
    const res = scanner.scan(root, () => ({ error: new Error('spawn ENOENT'), status: null }));
    assert.equal(res.ok, false);
    assert.match(res.error, /ENOENT/);
    assert.deepEqual(res.hits, []);
  });

  it('treats a git grep failure exit (>1) as a failure', () => {
    const res = scanner.scan(root, () => ({ status: 128, stdout: '', stderr: 'not a git repository\n' }));
    assert.equal(res.ok, false);
    assert.match(res.error, /not a git repository/);
  });

  it('main() exits 0 on a clean tree and 1 on a hit, naming the file', () => {
    const clean = repoWith({ 'lib/thing.js': "'use strict';\n" });
    const dirty = repoWith({ 'docs/notes.md': `${SEPARATOR}\n` });

    const quiet = { log: () => {}, error: () => {} };
    assert.equal(scanner.main([clean], quiet), 0);

    const errors = [];
    assert.equal(scanner.main([dirty], { log: () => {}, error: (s) => errors.push(s) }), 1);
    assert.ok(errors.some((line) => line.includes('docs/notes.md')),
      'the operator is told which file to fix, not just that something is wrong');
    // The separator branch matches a seven-`=` setext underline. Naming it in the
    // failure is the whole remedy: a doc author who trips this otherwise reads
    // "resolve the merge properly" and goes looking for a merge that never was.
    assert.ok(errors.some((line) => /setext/.test(line)),
      'the one known false positive is named where someone hitting it will read it');
  });

  it('this repository is clean', () => {
    // The guard against the guard: the detector runs in CI over this tree, so a
    // marker landing here must fail the suite too rather than only the workflow.
    const res = scanner.scan(path.join(__dirname, '..'));
    assert.equal(res.error, null, 'the scan must be able to answer in this repo');
    assert.deepEqual(res.hits, [], 'tracked files carry no conflict markers');
  });
});
