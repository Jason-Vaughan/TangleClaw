'use strict';

/*
 * The repository checks its own changelog fragments on every test run (#1220).
 *
 * `changelog.d/` is compiled into `[Unreleased]` by the next release cut, and a
 * fragment the contract refuses stops that cut by name
 * (`lib/wrap-steps/version-bump.js`). Checking the directory here moves the
 * refusal from the release to the pull request that introduced the file: CI runs
 * `test/*.test.js`, so this is the fail-closed schema check without a workflow
 * step of its own. A CI gate that would REQUIRE a fragment on every code change
 * is a separate, Operator-gated proposal (`docs/release-process.md`, "Proposed:
 * PR fragment gate"); this test asks only that whatever is there is valid.
 *
 * The directory is empty or absent after a cut, and both states pass. The
 * fixture cases below pin that the check is not vacuous: the same assertion
 * names a stray file with its code when one is present.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readFragments, FRAGMENT_DIR } = require('../lib/changelog-fragments');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Read a root's fragment directory and describe every refusal as one line,
 * `<path>: <code> (<reason>)`, so a failing assertion names the file to fix.
 *
 * @param {string} root - Project root holding `changelog.d/`
 * @returns {{ok:boolean, dirMissing:boolean, fragmentCount:number, refusals:string[]}}
 */
function inspectFragments(root) {
  const result = readFragments(root);
  return {
    ok: result.ok,
    dirMissing: result.dirMissing,
    fragmentCount: result.fragments.length,
    refusals: result.refused.map((r) => `${r.path}: ${r.code} (${r.reason})`)
  };
}

/**
 * The assertion the repository is held to: no refusal, whatever else is there.
 *
 * @param {string} root - Project root to check
 */
function assertAllFragmentsAccepted(root) {
  const seen = inspectFragments(root);
  assert.deepEqual(seen.refusals, [],
    `every file under ${FRAGMENT_DIR}/ must be a fragment the contract accepts; fix or remove:\n  ${seen.refusals.join('\n  ')}`);
  assert.equal(seen.ok, true);
}

describe('changelog.d/ in this repository (#1220)', () => {
  it('holds only fragments the contract accepts, or nothing', () => {
    assertAllFragmentsAccepted(REPO_ROOT);
  });

  it('every fragment present parses to an issue, a slug and a type', () => {
    const result = readFragments(REPO_ROOT);
    for (const fragment of result.fragments) {
      assert.ok(Number.isInteger(fragment.issue) && fragment.issue > 0, `${fragment.path}: issue`);
      assert.ok(fragment.slug.length > 0, `${fragment.path}: slug`);
      assert.ok(fragment.type.length > 0, `${fragment.path}: type`);
      assert.ok(fragment.body.length > 0, `${fragment.path}: body`);
    }
  });
});

describe('changelog.d/ check — the states it passes and the one it names', () => {
  let tmpRoot;
  let seq = 0;

  before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fragments-repo-')); });
  after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  /**
   * A fresh project root, with the fragment directory created when asked.
   *
   * @param {{dir?:boolean, files?:Record<string,string>}} [spec]
   * @returns {string} The root path
   */
  function root(spec = {}) {
    const r = path.join(tmpRoot, `root-${seq += 1}`);
    fs.mkdirSync(r, { recursive: true });
    if (spec.dir || spec.files) fs.mkdirSync(path.join(r, FRAGMENT_DIR));
    for (const [name, body] of Object.entries(spec.files || {})) {
      fs.writeFileSync(path.join(r, FRAGMENT_DIR, name), body);
    }
    return r;
  }

  it('passes on an empty directory (the state after a release cut)', () => {
    const r = root({ dir: true });
    assertAllFragmentsAccepted(r);
    assert.equal(inspectFragments(r).fragmentCount, 0);
  });

  it('passes on a missing directory', () => {
    const r = root();
    assertAllFragmentsAccepted(r);
    assert.equal(inspectFragments(r).dirMissing, true);
  });

  it('passes with valid fragments present', () => {
    const r = root({ files: { '1220.pilot-a.added.md': '- An entry.\n', '2519.pilot-b.fixed.md': '- Another.\n' } });
    assertAllFragmentsAccepted(r);
    assert.equal(inspectFragments(r).fragmentCount, 2);
  });

  it('names a stray file with its path and code, so the check is not vacuous', () => {
    const r = root({ files: { '1220.ok.added.md': '- Fine.\n', 'README.md': '# not a fragment\n' } });
    assert.throws(() => assertAllFragmentsAccepted(r), (err) => {
      assert.match(err.message, /README\.md: MALFORMED_NAME/);
      return true;
    });
  });

  it('names a fragment whose body the contract refuses', () => {
    const r = root({ files: { '1220.heading.added.md': '## not a list entry\n' } });
    assert.throws(() => assertAllFragmentsAccepted(r), (err) => {
      assert.match(err.message, /1220\.heading\.added\.md: /);
      return true;
    });
  });
});
