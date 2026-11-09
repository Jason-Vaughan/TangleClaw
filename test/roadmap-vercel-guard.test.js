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
const ROOT_VERCEL_CONFIG = path.join(REPO_ROOT, 'vercel.json');
const WEBSITE_VERCEL_CONFIG = path.join(REPO_ROOT, 'website', 'vercel.json');

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

describe('Vercel repository wiring (#2258)', () => {
  function readConfig(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  it('disables gh-pages deployments at both possible Vercel project roots', () => {
    for (const file of [ROOT_VERCEL_CONFIG, WEBSITE_VERCEL_CONFIG]) {
      const config = readConfig(file);
      assert.equal(config.$schema, 'https://openapi.vercel.sh/vercel.json');
      assert.equal(config.git.deploymentEnabled['gh-pages'], false);
    }
  });

  it('runs the guard before a root build and keeps the website-root fallback self-contained', () => {
    assert.equal(readConfig(ROOT_VERCEL_CONFIG).ignoreCommand, 'bash scripts/vercel-ignore-gh-pages.sh');
    assert.equal(
      readConfig(WEBSITE_VERCEL_CONFIG).ignoreCommand,
      'test "$VERCEL_GIT_COMMIT_REF" = gh-pages'
    );
  });

  it('preserves legacy flat sprint-report paths at either project root', () => {
    for (const file of [ROOT_VERCEL_CONFIG, WEBSITE_VERCEL_CONFIG]) {
      assert.deepEqual(readConfig(file).redirects, [{
        source: '/sprint-:version.html',
        destination: '/reports/:version/',
        permanent: true
      }]);
    }
  });
});

describe('static roadmap and report export contract (#2258)', () => {
  it('names stable public routes below the Next.js public directory', () => {
    assert.deepEqual(
      guard.STATIC_EXPORT_TARGETS.map(({ relativePath, publicPath }) => ({ relativePath, publicPath })),
      [
        { relativePath: 'public/roadmap/index.html', publicPath: '/roadmap/' },
        {
          relativePath: 'public/roadmap/roadmap-sync-status.json',
          publicPath: '/roadmap/roadmap-sync-status.json'
        },
        { relativePath: 'public/reports/index.html', publicPath: '/reports/' }
      ]
    );
  });

  it('reports a complete staged export, including requested release reports', (t) => {
    const website = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-vercel-export-'));
    t.after(() => fs.rmSync(website, { recursive: true, force: true }));
    const files = [
      'public/roadmap/index.html',
      'public/roadmap/roadmap-sync-status.json',
      'public/reports/index.html',
      'public/reports/v5.73.0/index.html'
    ];
    for (const file of files) {
      const target = path.join(website, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.endsWith('.json') ? '{}' : '<!doctype html>');
    }

    const result = guard.inspectStaticExport(website, { reportVersions: ['v5.73.0'] });
    assert.equal(result.ready, true);
    assert.equal(result.missing.length, 0);
    assert.equal(result.present.length, 4);
    assert.equal(result.present.at(-1).publicPath, '/reports/v5.73.0/');
  });

  it('fails closed with the exact missing export targets', (t) => {
    const website = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-vercel-export-'));
    t.after(() => fs.rmSync(website, { recursive: true, force: true }));
    fs.mkdirSync(path.join(website, 'public', 'roadmap'), { recursive: true });
    fs.writeFileSync(path.join(website, 'public', 'roadmap', 'index.html'), '<!doctype html>');

    const result = guard.inspectStaticExport(website);
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.missing.map(({ relativePath }) => relativePath),
      ['public/roadmap/roadmap-sync-status.json', 'public/reports/index.html']
    );
  });

  it('rejects report versions that could escape the public reports directory', () => {
    assert.throws(
      () => guard.inspectStaticExport(path.join(REPO_ROOT, 'website'), { reportVersions: ['../secrets'] }),
      /invalid report version/
    );
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
