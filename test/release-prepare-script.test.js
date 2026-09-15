'use strict';

/*
 * `scripts/release-prepare.js` — this repo's releasePrepareCommand (#1502).
 *
 * It must produce exactly what the two release guards demand
 * (`readme-version-pins`, `changelog-released-immutable`), and it must never
 * relock a published section, which is the change the lock exists to catch.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const prep = require('../scripts/release-prepare');

const REPO_ROOT = path.resolve(__dirname, '..');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * A repo-shaped temp dir holding copies of this repo's release files.
 * @returns {string} Root path.
 */
function copyOfRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-relprep-script-'));
  dirs.push(root);
  for (const rel of ['version.json', 'README.md', 'CHANGELOG.md', 'test/fixtures/changelog-released-sections.lock.json']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  return root;
}

/**
 * Simulate a wrap's cut in `root`: bump version.json and promote [Unreleased].
 * @param {string} root - Copy root.
 * @param {string} version - New version.
 * @returns {void}
 */
function cut(root, version) {
  fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version }, null, 2) + '\n');
  const p = path.join(root, 'CHANGELOG.md');
  const text = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, text.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - 2099-01-01\n\n### Fixed\n- a release-prepare test entry\n`));
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCK = 'test/fixtures/changelog-released-sections.lock.json';

describe('scripts/release-prepare.js (#1502)', () => {
  it('on this repo as committed, it changes nothing (the lock and pins are already current)', () => {
    const root = copyOfRepo();
    const r = prep.prepareRelease(root, {});
    assert.deepEqual(r.changed, []);
  });

  it('after a cut, it moves every pin and adds only the new section to the lock', () => {
    const root = copyOfRepo();
    const before = JSON.parse(read(root, LOCK));
    cut(root, '99.0.0');
    const r = prep.prepareRelease(root, { TANGLECLAW_RELEASE_VERSION: '99.0.0' });

    assert.deepEqual(r.changed, ['README.md', LOCK]);
    const pins = [...read(root, 'README.md').matchAll(/--branch\s+v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(pins.length > 0);
    assert.ok(pins.every((v) => v === '99.0.0'), `every pin moved: ${pins.join(', ')}`);
    const lock = JSON.parse(read(root, LOCK));
    assert.deepEqual(Object.keys(lock)[0], '99.0.0', 'the new release leads, as the CHANGELOG lists it');
    const { ['99.0.0']: added, ...rest } = lock;
    assert.match(added, /^[0-9a-f]{16}$/);
    assert.deepEqual(rest, before, 'every existing entry is untouched');
  });

  it('is idempotent', () => {
    const root = copyOfRepo();
    cut(root, '99.0.0');
    prep.prepareRelease(root, {});
    assert.deepEqual(prep.prepareRelease(root, {}).changed, []);
  });

  it('what it writes satisfies both release guards, run as CI runs them', () => {
    const root = copyOfRepo();
    cut(root, '99.0.0');
    prep.prepareRelease(root, {});
    for (const guard of ['readme-version-pins.test.js', 'changelog-released-immutable.test.js']) {
      fs.mkdirSync(path.join(root, 'test'), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, 'test', guard), path.join(root, 'test', guard));
      // Throws with the guard's own output when it fails.
      execFileSync(process.execPath, ['--test', path.join(root, 'test', guard)], { cwd: root, stdio: 'pipe' });
    }
  });

  it('refuses to relock a published section that changed', () => {
    const root = copyOfRepo();
    cut(root, '99.0.0');
    const p = path.join(root, 'CHANGELOG.md');
    const text = read(root, 'CHANGELOG.md');
    const published = Object.keys(JSON.parse(read(root, LOCK)))[0];
    fs.writeFileSync(p, text.replace(new RegExp(`(## \\[${published.replace(/\./g, '\\.')}\\] - [^\\n]*\\n)`), '$1\n- smuggled into a released section\n'));
    const lockBefore = read(root, LOCK);

    assert.throws(() => prep.prepareRelease(root, {}), new RegExp(`already-released CHANGELOG sections changed since they were locked: ${published.replace(/\./g, '\\.')}`));
    assert.equal(read(root, LOCK), lockBefore, 'the lock is not written');
  });

  it('refuses when the wrap and version.json disagree about the release', () => {
    const root = copyOfRepo();
    cut(root, '99.0.0');
    assert.throws(() => prep.prepareRelease(root, { TANGLECLAW_RELEASE_VERSION: '98.0.0' }), /releasing 98\.0\.0 but version\.json says 99\.0\.0/);
  });

  it('refuses when the release has no CHANGELOG section, or the README pins nothing', () => {
    const root = copyOfRepo();
    fs.writeFileSync(path.join(root, 'version.json'), '{"version":"99.0.0"}\n');
    assert.throws(() => prep.prepareRelease(root, {}), /no "## \[99\.0\.0\] - <date>" section/);
    assert.throws(() => prep.updatePins('no pins here\n', '1.0.0'), /no `--branch vX\.Y\.Z` clone pin/);
  });

  it('refuses to lock a released section other than the one it is preparing', () => {
    assert.throws(
      () => prep.extendLock({}, '## [2.0.0] - d\n\n- b\n\n## [1.0.0] - d\n\n- a\n', '2.0.0'),
      /released sections other than 2\.0\.0 are not locked: 1\.0\.0/
    );
  });

  it('as a CLI, exits 1 with the reason on stderr', () => {
    const root = copyOfRepo();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'release-prepare.js'), path.join(root, 'scripts', 'release-prepare.js'));
    fs.writeFileSync(path.join(root, 'version.json'), '{"version":"99.0.0"}\n');
    let err;
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts', 'release-prepare.js')], { stdio: 'pipe' });
    } catch (e) { err = e; }
    assert.ok(err, 'the CLI failed');
    assert.equal(err.status, 1);
    assert.match(String(err.stderr), /release-prepare refused: .*99\.0\.0/);
  });
});
