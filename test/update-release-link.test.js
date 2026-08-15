'use strict';

/*
 * Tests for #149 — the update-available notice carries a clickable link to
 * the GitHub release page.
 *
 * Two surfaces:
 *   1. Backend: lib/update-checker.js exposes `releaseUrl` derived from
 *      `git remote get-url origin` so fork installs link to their fork.
 *   2. Frontend: the update beacon links its version label when the API
 *      provides `releaseUrl`, and falls back to plain text when it doesn't
 *      (pre-#149 servers / non-GitHub remotes). That half is executed in
 *      test/update-beacon.test.js; only its stylesheet is pinned here.
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

describe('The release link on the update beacon (#149)', () => {
  let css;

  before(() => {
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  // The wiring assertions this block used to make were source pins on the
  // pill's template string in landing.js. Since #931 the link is built from
  // DOM nodes inside `public/update-beacon.js`, and every claim they made is
  // now asserted by EXECUTION in test/update-beacon.test.js — the anchor when
  // `releaseUrl` is present, `rel="noopener noreferrer"`, the plain-text
  // fallback for a non-GitHub remote, and (new) the refusal to link a
  // non-http scheme, which escaping never covered. What remains here is the
  // half that cannot be executed: the stylesheet.
  describe('CSS', () => {
    it('declares the link with inherited color so the toast chrome stays consistent', () => {
      assert.match(css, /\.beacon-toast-version a\s*\{[\s\S]*?color:\s*inherit/);
    });

    it('declares an underline treatment with a hover state for affordance', () => {
      assert.match(css, /\.beacon-toast-version a\s*\{[\s\S]*?text-decoration:\s*underline/);
      assert.match(css, /\.beacon-toast-version a:hover\s*\{\s*text-decoration:\s*none/);
    });
  });
});
