'use strict';

/*
 * The release tag gate (#1551): a tag must DEREFERENCE to the commit the
 * release run tested, or the run refuses. These cover the parse of real
 * `git ls-remote --tags` shapes and the refusal the workflow relies on.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveTagCommit, checkTag, main } = require('../scripts/release-tag-gate');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'release-tag-gate.js');
const TESTED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);

/**
 * Build `ls-remote` output lines.
 * @param {Array<[string, string]>} rows - [sha, ref] pairs.
 * @returns {string}
 */
function lsRemote(rows) {
  return rows.map(([sha, ref]) => `${sha}\t${ref}`).join('\n') + '\n';
}

describe('resolveTagCommit', () => {
  it('resolves an annotated tag through its ^{} line, not the tag object', () => {
    const out = lsRemote([[TAG_OBJECT, 'refs/tags/v1.2.3'], [TESTED, 'refs/tags/v1.2.3^{}']]);
    assert.deepEqual(resolveTagCommit(out, 'v1.2.3'), { state: 'present', commit: TESTED });
  });

  it('resolves real ls-remote output for an annotated release tag', () => {
    // Captured from origin for v5.26.0, queried with both patterns as release.yml does.
    const out = 'f8598b7b3d776b940ecaee9b4a66da833092837c\trefs/tags/v5.26.0\n'
      + '0882ce58e27b829fde6dad7abdff723b694ef018\trefs/tags/v5.26.0^{}\n';
    assert.deepEqual(resolveTagCommit(out, 'v5.26.0'), {
      state: 'present',
      commit: '0882ce58e27b829fde6dad7abdff723b694ef018',
    });
  });

  it('resolves a lightweight tag through its plain line', () => {
    const out = lsRemote([[TESTED, 'refs/tags/v1.2.3']]);
    assert.deepEqual(resolveTagCommit(out, 'v1.2.3'), { state: 'present', commit: TESTED });
  });

  it('reads empty output as absent', () => {
    assert.deepEqual(resolveTagCommit('', 'v1.2.3'), { state: 'absent' });
  });

  it('does not let v1.2.30 satisfy a lookup for v1.2.3', () => {
    const out = lsRemote([[TESTED, 'refs/tags/v1.2.30'], [TESTED, 'refs/tags/v1.2.30^{}']]);
    assert.deepEqual(resolveTagCommit(out, 'v1.2.3'), { state: 'absent' });
  });

  it('ignores other refs that ls-remote tail-matched', () => {
    const out = lsRemote([[OTHER, 'refs/tags/x/refs/tags/v1.2.3'], [TESTED, 'refs/tags/v1.2.3']]);
    assert.deepEqual(resolveTagCommit(out, 'v1.2.3'), { state: 'present', commit: TESTED });
  });

  it('fails closed on a line it cannot parse, rather than reading it as absent', () => {
    assert.throws(() => resolveTagCommit('fatal: unable to access origin\n', 'v1.2.3'), /unparseable/);
    assert.throws(() => resolveTagCommit(`${TESTED.slice(0, 12)}\trefs/tags/v1.2.3\n`, 'v1.2.3'), /unparseable/);
  });

  it('fails closed when the tag is listed twice', () => {
    const out = lsRemote([[TESTED, 'refs/tags/v1.2.3'], [OTHER, 'refs/tags/v1.2.3']]);
    assert.throws(() => resolveTagCommit(out, 'v1.2.3'), /more than once/);
  });

  it('fails closed on a ^{} line with no plain line', () => {
    const out = lsRemote([[TESTED, 'refs/tags/v1.2.3^{}']]);
    assert.throws(() => resolveTagCommit(out, 'v1.2.3'), /without/);
  });

  it('refuses a tag name that is not a version tag', () => {
    assert.throws(() => resolveTagCommit('', 'main'), /invalid tag/);
  });
});

describe('checkTag', () => {
  it('passes when the tag dereferences to the tested commit', () => {
    const out = lsRemote([[TAG_OBJECT, 'refs/tags/v1.2.3'], [TESTED, 'refs/tags/v1.2.3^{}']]);
    const v = checkTag({ output: out, tag: 'v1.2.3', expected: TESTED });
    assert.equal(v.ok, true);
    assert.equal(v.state, 'match');
  });

  it('refuses a tag that dereferences elsewhere and names both commits', () => {
    const out = lsRemote([[TAG_OBJECT, 'refs/tags/v1.2.3'], [OTHER, 'refs/tags/v1.2.3^{}']]);
    const v = checkTag({ output: out, tag: 'v1.2.3', expected: TESTED });
    assert.equal(v.ok, false);
    assert.equal(v.state, 'mismatch');
    assert.match(v.message, new RegExp(OTHER));
    assert.match(v.message, new RegExp(TESTED));
  });

  it('refuses when the tag object SHA equals the expected commit but the commit does not', () => {
    // Guards against comparing the plain line of an annotated tag.
    const out = lsRemote([[TESTED, 'refs/tags/v1.2.3'], [OTHER, 'refs/tags/v1.2.3^{}']]);
    assert.equal(checkTag({ output: out, tag: 'v1.2.3', expected: TESTED }).ok, false);
  });

  it('refuses an absent tag unless absence is allowed', () => {
    assert.equal(checkTag({ output: '', tag: 'v1.2.3', expected: TESTED }).ok, false);
    assert.equal(checkTag({ output: '', tag: 'v1.2.3', expected: TESTED, allowAbsent: true }).ok, true);
  });

  it('refuses an expected commit that is not a full SHA', () => {
    assert.throws(() => checkTag({ output: '', tag: 'v1.2.3', expected: 'abc123' }), /40-hex/);
    assert.throws(() => checkTag({ output: '', tag: 'v1.2.3', expected: '' }), /40-hex/);
  });
});

describe('main (CLI contract the workflow calls)', () => {
  const mismatch = lsRemote([[TAG_OBJECT, 'refs/tags/v1.2.3'], [OTHER, 'refs/tags/v1.2.3^{}']]);

  it('exits 0 on a match', () => {
    const out = lsRemote([[TESTED, 'refs/tags/v1.2.3']]);
    assert.equal(main(['--tag', 'v1.2.3', '--expect', TESTED], out).code, 0);
  });

  it('exits 1 with an ::error:: on a mismatch', () => {
    const r = main(['--tag', 'v1.2.3', '--expect', TESTED], mismatch);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^::error::/);
  });

  it('exits 1 on an absent tag, and 0 with --allow-absent', () => {
    assert.equal(main(['--tag', 'v1.2.3', '--expect', TESTED], '').code, 1);
    assert.equal(main(['--tag', 'v1.2.3', '--expect', TESTED, '--allow-absent'], '').code, 0);
  });

  it('has no flag that downgrades a mismatch', () => {
    // An already-released tag on another commit refuses too; there is no warn mode.
    assert.equal(main(['--tag', 'v1.2.3', '--expect', TESTED, '--warn-only'], mismatch).code, 2);
    assert.equal(main(['--tag', 'v1.2.3', '--expect', TESTED, '--allow-absent'], mismatch).code, 1);
  });

  it('exits 2 on malformed output or bad arguments', () => {
    assert.equal(main(['--tag', 'v1.2.3', '--expect', TESTED], 'garbage\n').code, 2);
    assert.equal(main(['--tag', 'v1.2.3'], '').code, 2);
    assert.equal(main(['--tag', 'v1.2.3', '--expect', TESTED, '--bogus'], '').code, 2);
    assert.equal(main(['--tag', 'v1.2.3', '--expect'], '').code, 2);
  });

  it('runs as a script reading stdin', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--tag', 'v1.2.3', '--expect', TESTED], { input: mismatch, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing to release/);
  });
});
