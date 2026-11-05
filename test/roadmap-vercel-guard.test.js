'use strict';

/*
 * #2258 — a push to `gh-pages` (the roadmap publisher's branch, which has no
 * `website` root directory) must start no Vercel deployment. The decision
 * lives in lib/roadmap-vercel-guard.js; scripts/vercel-ignore-gh-pages.sh is
 * the shell entry point Vercel's "Ignored Build Step" setting would call.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const guard = require('../lib/roadmap-vercel-guard');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'vercel-ignore-gh-pages.sh');

/**
 * A fresh temp directory, optionally with a `website` subdirectory.
 * @param {boolean} withWebsite - Whether to create `website` inside it.
 * @returns {string} The directory's path.
 */
function tempRoot(withWebsite) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-vercel-guard-'));
  if (withWebsite) fs.mkdirSync(path.join(dir, 'website'));
  return dir;
}

describe('shouldSkipBuild (#2258)', () => {
  it('skips gh-pages even when the checkout has a website directory', () => {
    assert.equal(guard.shouldSkipBuild({ ref: 'gh-pages', hasWebsiteDir: true }), true);
  });

  it('skips any ref whose checkout has no website directory', () => {
    assert.equal(guard.shouldSkipBuild({ ref: 'main', hasWebsiteDir: false }), true);
    assert.equal(guard.shouldSkipBuild({ ref: 'feat/x', hasWebsiteDir: false }), true);
    assert.equal(guard.shouldSkipBuild({ ref: undefined, hasWebsiteDir: false }), true);
  });

  it('proceeds for main and a feature branch when website exists', () => {
    assert.equal(guard.shouldSkipBuild({ ref: 'main', hasWebsiteDir: true }), false);
    assert.equal(guard.shouldSkipBuild({ ref: 'feat/2258-vercel-guard', hasWebsiteDir: true }), false);
  });

  it('names the ref it checks, so a rename of gh-pages is not silently missed', () => {
    assert.equal(guard.GH_PAGES_REF, 'gh-pages');
    assert.equal(guard.WEBSITE_DIR, 'website');
  });
});

describe('websiteDirExists (#2258)', () => {
  it('is true for a checkout that has a website directory', () => {
    const dir = tempRoot(true);
    assert.equal(guard.websiteDirExists(dir), true);
  });

  it('is false for a checkout with no website directory', () => {
    const dir = tempRoot(false);
    assert.equal(guard.websiteDirExists(dir), false);
  });

  it('is false when the path does not exist at all', () => {
    assert.equal(guard.websiteDirExists(path.join(os.tmpdir(), 'roadmap-vercel-guard-missing-xyz')), false);
  });

  it('is false when website exists but is a file, not a directory', () => {
    const dir = tempRoot(false);
    fs.writeFileSync(path.join(dir, 'website'), 'not a directory');
    assert.equal(guard.websiteDirExists(dir), false);
  });

  it('reads the real repository root when no root is given', () => {
    assert.equal(guard.websiteDirExists(), fs.existsSync(path.join(REPO_ROOT, 'website')));
  });
});

describe('decide (#2258)', () => {
  it('skips for gh-pages regardless of the checkout', () => {
    assert.equal(guard.decide({ VERCEL_GIT_COMMIT_REF: 'gh-pages' }, tempRoot(true)), true);
  });

  it('proceeds for main with a real checkout that has website', () => {
    assert.equal(guard.decide({ VERCEL_GIT_COMMIT_REF: 'main' }, REPO_ROOT), false);
  });

  it('skips when VERCEL_GIT_COMMIT_REF is unset and the checkout has no website', () => {
    assert.equal(guard.decide({}, tempRoot(false)), true);
  });
});

describe('scripts/vercel-ignore-gh-pages.sh (#2258)', () => {
  it('is executable', () => {
    const mode = fs.statSync(SCRIPT).mode;
    assert.ok(mode & 0o100, 'owner-executable bit is set');
  });

  it('exits 0 and says it is skipping, for gh-pages', () => {
    const out = execFileSync(SCRIPT, [], { env: { ...process.env, VERCEL_GIT_COMMIT_REF: 'gh-pages' }, encoding: 'utf8' });
    assert.match(out, /skipping build \(ref=gh-pages\)/);
  });

  it('exits non-zero and says it is proceeding, for main', () => {
    assert.throws(
      () => execFileSync(SCRIPT, [], { env: { ...process.env, VERCEL_GIT_COMMIT_REF: 'main' }, encoding: 'utf8' }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stdout, /proceeding with build \(ref=main\)/);
        return true;
      }
    );
  });
});
