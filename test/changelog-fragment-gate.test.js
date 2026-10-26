'use strict';

/**
 * `scripts/changelog-fragment-gate.js` (#1220 C05 / #2523).
 *
 * `evaluate` is exercised directly for the gate's rules; the CLI is
 * exercised end to end over the `--files`/`--body-file` test seam, so the
 * argument parsing and exit codes are covered with no network call to `gh`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gate = require('../scripts/changelog-fragment-gate.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'changelog-fragment-gate.js');

describe('changelog-fragment-gate: evaluate', () => {
  it('passes a PR that touches no code path, whatever the body says', () => {
    const verdict = gate.evaluate(['docs/release-process.md', 'README.md'], '');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 0);
  });

  it('passes a code change that adds a valid fragment', () => {
    const verdict = gate.evaluate(['lib/store.js', 'changelog.d/1220.fragment-gate.added.md'], '');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 0);
  });

  it('refuses a code change with no fragment and no escape', () => {
    const verdict = gate.evaluate(['server.js'], 'just a description, nothing else');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 1);
    assert.match(verdict.reason, /no changelog\.d/);
  });

  it('passes a code change carrying the escape line with a reason', () => {
    const verdict = gate.evaluate(['scripts/release-prepare.js'], 'revert of #999\n\nChangelog: none reverts an unreleased change\n');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 0);
  });

  it('refuses the escape line with no reason', () => {
    const verdict = gate.evaluate(['public/ui.js'], 'Changelog: none\n');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 1);
    assert.match(verdict.reason, /no reason/);
  });

  it('refuses a malformed fragment name even when a valid one is also present', () => {
    const verdict = gate.evaluate(
      ['lib/store.js', 'changelog.d/1220.fragment-gate.added.md', 'changelog.d/README.md'],
      ''
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 1);
    assert.match(verdict.reason, /changelog\.d\/README\.md/);
  });

  it('refuses a malformed fragment name even with a valid escape line present', () => {
    const verdict = gate.evaluate(
      ['lib/store.js', 'changelog.d/not-a-fragment.txt'],
      'Changelog: none this should not matter\n'
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 1);
  });

  it('a fragment nested deeper than changelog.d/ is not a fragment', () => {
    const verdict = gate.evaluate(['lib/store.js', 'changelog.d/sub/1220.x.added.md'], '');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 1);
  });

  it('refuses a code change that only DELETES an existing fragment (PRR-A F1)', () => {
    const verdict = gate.evaluate(
      [
        { path: 'lib/store.js', additions: 3, deletions: 0 },
        { path: 'changelog.d/1220.old-entry.fixed.md', additions: 0, deletions: 5 }
      ],
      ''
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 1);
    assert.match(verdict.reason, /no changelog\.d/);
  });

  it('refuses a code change that only MODIFIES an existing fragment, with no added one', () => {
    const verdict = gate.evaluate(
      [
        { path: 'lib/store.js', additions: 3, deletions: 0 },
        { path: 'changelog.d/1220.old-entry.fixed.md', additions: 2, deletions: 1 }
      ],
      ''
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 1);
  });

  it('passes a code change that both deletes one fragment and adds another', () => {
    const verdict = gate.evaluate(
      [
        { path: 'lib/store.js', additions: 3, deletions: 0 },
        { path: 'changelog.d/1220.old-entry.fixed.md', additions: 0, deletions: 5 },
        { path: 'changelog.d/1220.new-entry.fixed.md', additions: 4, deletions: 0 }
      ],
      ''
    );
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 0);
  });

  it('a pure deletion of a malformed stray file under changelog.d/ does not refuse the cleanup', () => {
    const verdict = gate.evaluate(
      [
        { path: 'lib/store.js', additions: 3, deletions: 0 },
        { path: 'changelog.d/README.md', additions: 0, deletions: 2 }
      ],
      'Changelog: none removes a leftover stray file\n'
    );
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 0);
  });

  it('a plain string entry is shorthand for an added file (additions:1, deletions:0)', () => {
    const verdict = gate.evaluate(['lib/store.js', 'changelog.d/1220.fragment-gate.added.md'], '');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 0);
  });
});

describe('changelog-fragment-gate: touchesCode', () => {
  it('matches lib/, public/, scripts/ and exactly server.js', () => {
    assert.equal(gate.touchesCode('lib/store.js'), true);
    assert.equal(gate.touchesCode('public/ui.js'), true);
    assert.equal(gate.touchesCode('scripts/release-prepare.js'), true);
    assert.equal(gate.touchesCode('server.js'), true);
  });

  it('does not match a docs, test or record path, or a filename coincidence', () => {
    assert.equal(gate.touchesCode('docs/lib-notes.md'), false);
    assert.equal(gate.touchesCode('test/lib.test.js'), false);
    assert.equal(gate.touchesCode('server.js.bak'), false);
  });
});

describe('changelog-fragment-gate: parseArgs', () => {
  it('requires exactly one of --pr or the --files/--body-file pair', () => {
    assert.throws(() => gate.parseArgs([]), /pass exactly one of/);
    assert.throws(() => gate.parseArgs(['--files', 'a.json']), /pass exactly one of/);
    assert.throws(() => gate.parseArgs(['--pr', '1', '--files', 'a.json', '--body-file', 'b.txt']), /pass exactly one of/);
  });

  it('rejects an unrecognized flag', () => {
    assert.throws(() => gate.parseArgs(['--bogus', 'x']), /unrecognized argument/);
  });

  it('accepts --pr alone, or --files with --body-file', () => {
    assert.deepEqual(gate.parseArgs(['--pr', '42']), { pr: '42', filesPath: null, bodyFilePath: null });
    assert.deepEqual(gate.parseArgs(['--files', 'a.json', '--body-file', 'b.txt']), { pr: null, filesPath: 'a.json', bodyFilePath: 'b.txt' });
  });
});

describe('changelog-fragment-gate: the CLI over the --files/--body-file seam', () => {
  /**
   * @param {string[]} files
   * @param {string} body
   * @returns {{status: number, out: string}}
   */
  function run(files, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-fragment-gate-'));
    try {
      const filesPath = path.join(dir, 'files.json');
      const bodyFilePath = path.join(dir, 'body.txt');
      fs.writeFileSync(filesPath, JSON.stringify(files));
      fs.writeFileSync(bodyFilePath, body);
      const res = spawnSync(process.execPath, [SCRIPT, '--files', filesPath, '--body-file', bodyFilePath], { encoding: 'utf8' });
      return { status: res.status, out: `${res.stdout}${res.stderr}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 and says pass for a valid fragment', () => {
    const { status, out } = run(['lib/store.js', 'changelog.d/1220.fragment-gate.added.md'], '');
    assert.equal(status, 0, out);
    assert.ok(out.includes('pass'), out);
  });

  it('exits 1 and says refused with no fragment or escape', () => {
    const { status, out } = run(['server.js'], '');
    assert.equal(status, 1, out);
    assert.ok(out.includes('refused'), out);
  });

  it('exits 1 for a code change that only deletes an existing fragment (the gh-shaped --files form)', () => {
    const { status, out } = run(
      [
        { path: 'lib/store.js', additions: 3, deletions: 0 },
        { path: 'changelog.d/1220.old-entry.fixed.md', additions: 0, deletions: 5 }
      ],
      ''
    );
    assert.equal(status, 1, out);
    assert.ok(out.includes('refused'), out);
  });

  it('exits 4 when --files holds something unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-fragment-gate-'));
    try {
      const filesPath = path.join(dir, 'missing.json');
      const bodyFilePath = path.join(dir, 'body.txt');
      fs.writeFileSync(bodyFilePath, '');
      const res = spawnSync(process.execPath, [SCRIPT, '--files', filesPath, '--body-file', bodyFilePath], { encoding: 'utf8' });
      assert.equal(res.status, 4, `${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 4 with neither --pr nor the --files/--body-file pair', () => {
    const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 4, `${res.stdout}${res.stderr}`);
  });
});
