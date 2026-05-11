'use strict';

/*
 * Tests for #149 — update-available pill becomes a clickable link to the
 * GitHub release page.
 *
 * Two surfaces:
 *   1. Backend: lib/update-checker.js exposes `releaseUrl` derived from
 *      `git remote get-url origin` so fork installs link to their fork.
 *   2. Frontend: landing.js wraps the pill's version label in an anchor
 *      when the API provides `releaseUrl`, falls back to plain text when
 *      it doesn't (pre-#149 servers / non-GitHub remotes).
 *
 * Frontend tests use source-level structural assertions — same pattern as
 * test/orphan-hooks-banner.test.js for #145 chunk 2.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const updateChecker = require('../lib/update-checker');

describe('update-checker releaseUrl derivation (#149)', () => {
  describe('_parseGitHubRemote', () => {
    const accepts = [
      ['https://github.com/foo/bar', 'foo', 'bar'],
      ['https://github.com/foo/bar.git', 'foo', 'bar'],
      ['https://github.com/foo/bar.git/', 'foo', 'bar'],
      ['https://github.com/foo/bar/', 'foo', 'bar'],
      // Case-insensitive host (GitHub.com is served as a valid alias)
      ['https://GitHub.com/foo/bar.git', 'foo', 'bar'],
      // Tokenized clones from `gh auth setup-git`
      ['https://user:token@github.com/foo/bar.git', 'foo', 'bar'],
      ['https://oauth2:abc123@github.com/foo/bar', 'foo', 'bar'],
      // ssh://git@github.com/... — Docker / CI variant
      ['ssh://git@github.com/foo/bar.git', 'foo', 'bar'],
      ['ssh://git@github.com/foo/bar', 'foo', 'bar'],
      // Classic SCP-style SSH
      ['git@github.com:foo/bar.git', 'foo', 'bar'],
      ['git@github.com:foo/bar', 'foo', 'bar'],
      // Whitespace tolerance (execSync output sometimes carries trailing newline)
      ['  https://github.com/foo/bar.git\n', 'foo', 'bar'],
      // Real-world owner/repo with hyphens, dots, underscores
      ['https://github.com/Jason-Vaughan/TangleClaw.git', 'Jason-Vaughan', 'TangleClaw'],
      ['git@github.com:my-org/my.repo_name.git', 'my-org', 'my.repo_name']
    ];

    for (const [input, owner, repo] of accepts) {
      it(`accepts: ${input}`, () => {
        assert.deepStrictEqual(updateChecker._parseGitHubRemote(input), { owner, repo });
      });
    }

    const rejects = [
      // Non-GitHub hosts
      'https://gitlab.com/foo/bar.git',
      'https://bitbucket.org/foo/bar.git',
      'git@gitlab.com:foo/bar.git',
      // GitHub-shaped but with extra path segments (would be a subdir, not a repo)
      'https://github.com/foo/bar/baz',
      'https://github.com/foo/bar/baz.git',
      // Empty / malformed
      '',
      '   ',
      null,
      undefined,
      'not-a-url',
      'https://github.com/',
      'https://github.com/foo',
      // Different protocols that aren't valid clone URLs
      'ftp://github.com/foo/bar.git',
      'file:///path/to/repo'
    ];

    for (const input of rejects) {
      it(`rejects: ${JSON.stringify(input)}`, () => {
        assert.strictEqual(updateChecker._parseGitHubRemote(input), null);
      });
    }

    it('defense-in-depth: rejects owners/repos containing chars outside [A-Za-z0-9._-]', () => {
      // If a future regex change relaxed the character class, this would be
      // the canary. esc() is the real escape boundary at the render layer,
      // but the parser should be strict about what it produces.
      assert.strictEqual(updateChecker._parseGitHubRemote('https://github.com/foo bar/repo'), null);
      assert.strictEqual(updateChecker._parseGitHubRemote('https://github.com/foo/bar baz'), null);
      assert.strictEqual(updateChecker._parseGitHubRemote('git@github.com:foo/bar"onclick=x'), null);
    });
  });

  describe('_getReleasesUrlBase', () => {
    it('derives a URL from the local repo\'s origin remote when it\'s GitHub', () => {
      // This test runs inside the TC repo itself, whose origin points at
      // github.com/Jason-Vaughan/TangleClaw. The function should return a
      // /releases/tag/ URL for that repo. If the test ever fails because
      // someone runs it in a fork, that's the correct behavior — the
      // assertion is on shape, not the specific owner.
      const url = updateChecker._getReleasesUrlBase();
      assert.ok(url, 'expected a URL base from the test-runner\'s origin');
      assert.match(url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/$/);
    });
  });

  describe('getCachedStatus shape', () => {
    it('returns a releaseUrl field even before any check has run', () => {
      updateChecker._reset();
      const status = updateChecker.getCachedStatus();
      assert.ok('releaseUrl' in status, 'releaseUrl must be present in cached status shape');
      // No check has run yet → null, not undefined, so frontend can safely
      // check `data.releaseUrl` without optional-chaining surprises.
      assert.equal(status.releaseUrl, null);
    });
  });
});

describe('Dashboard update-pill link (#149)', () => {
  let js, css;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  describe('landing.js wiring', () => {
    it('wraps the version label in an anchor when releaseUrl is present', () => {
      assert.match(js, /data\.releaseUrl/);
      assert.match(js, /<a class="update-pill-link" href="\$\{esc\(data\.releaseUrl\)\}"/);
    });

    it('opens the release page in a new tab with safe rel attrs', () => {
      // target="_blank" without rel="noopener noreferrer" is a tabnabbing
      // foot-gun; lock it in structurally.
      assert.match(js, /target="_blank" rel="noopener noreferrer"/);
    });

    it('falls back to plain text when releaseUrl is missing (pre-#149 server / non-GitHub remote)', () => {
      // The ternary on data.releaseUrl is the lock-in: either we get the
      // anchor branch, or the plain versionLabel branch. No anchor with an
      // empty href, no broken link.
      assert.match(js, /data\.releaseUrl\s*\?\s*`<a class="update-pill-link"/);
      assert.match(js, /:\s*versionLabel/);
    });

    it('escapes the releaseUrl through esc() to prevent attribute injection', () => {
      assert.match(js, /href="\$\{esc\(data\.releaseUrl\)\}"/);
    });

    it('preserves the existing per-version localStorage dismiss key', () => {
      // Regression guard — the link addition should not have touched the
      // dismiss-key contract that v3.13.0+ installs already use.
      assert.match(js, /tc_updateDismissed_\$\{data\.latestVersion\}/);
    });

    it('keeps the dismiss button intact alongside the new link', () => {
      assert.match(js, /class="update-pill-dismiss"/);
      assert.match(js, /pill\.querySelector\(['"]\.update-pill-dismiss['"]\)/);
    });
  });

  describe('CSS', () => {
    it('declares .update-pill-link with inherited color so the pill chrome stays consistent', () => {
      assert.match(css, /\.update-pill-link\s*\{[\s\S]*?color:\s*inherit/);
    });

    it('declares an underline treatment with a hover state for affordance', () => {
      assert.match(css, /\.update-pill-link\s*\{[\s\S]*?text-decoration:\s*underline/);
      assert.match(css, /\.update-pill-link:hover\s*\{\s*text-decoration:\s*none/);
    });
  });
});
