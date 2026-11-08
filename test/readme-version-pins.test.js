'use strict';

/*
 * #976 — the README hardcodes the release to clone, in two places, and nothing
 * kept them current. `lib/wrap-steps/version-bump.js` writes `version.json` and
 * promotes `CHANGELOG.md`; it never touches the README, so every release left
 * the install instruction pointing at the release before it.
 *
 * It drifted twice before this guard existed: #965 found the Quick Start snippet
 * pinned `v5.0.0` while the project was on 5.6.0, and v5.8.0 shipped leaving both
 * snippets on v5.7.0. That instruction is the one a stranger follows, and the
 * only third-party installer this project has reproduces defects this machine
 * structurally cannot — so a stale pin quietly hands them the wrong release.
 *
 * The guard is deliberately source-scanning: no install step, no network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

describe('README clone pins track version.json (#976)', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8'));

  // Every `--branch vX.Y.Z` in the README, with its line number for the message.
  const pins = readme.split('\n').flatMap((line, i) => {
    const m = line.match(/--branch\s+v(\d+\.\d+\.\d+)/);
    return m ? [{ line: i + 1, version: m[1] }] : [];
  });

  it('the README still pins a release at all (the guard has something to check)', () => {
    // Without this, deleting every pin would make the assertion below vacuously
    // true and the guard would pass while the README told nobody what to clone.
    assert.ok(pins.length > 0, 'expected at least one `--branch vX.Y.Z` clone snippet in README.md');
  });

  it('every clone pin names the current version', () => {
    const stale = pins.filter((p) => p.version !== version);
    assert.deepEqual(
      stale,
      [],
      stale.length === 0
        ? ''
        : `version.json is ${version} but README.md still clones `
          + stale.map((p) => `v${p.version} (line ${p.line})`).join(', ')
          + '. Bump the pins in the release PR — nothing else updates them.'
    );
  });
});

describe('README top release banner tracks version.json (#2935)', () => {
  // `scripts/release-prepare.js#updateReleaseBanner` keeps these three in
  // sync on every release cut; this guard is what fails the release PR if
  // that script was skipped or its regexes stopped matching.
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8'));
  const bannerLine = readme.split('\n').find((line) => line.startsWith('**Latest release:**'));

  it('the README still has a `**Latest release:**` banner line (the guard has something to check)', () => {
    assert.ok(bannerLine, 'expected a line starting with `**Latest release:**` in README.md');
  });

  it('the banner version tag matches version.json', () => {
    const m = bannerLine.match(/\*\*Latest release:\*\*\s+`v(\d+\.\d+\.\d+)`/);
    assert.ok(m, `expected the banner line to contain a backticked \`vX.Y.Z\` right after "Latest release:": ${bannerLine}`);
    assert.equal(
      m[1],
      version,
      `version.json is ${version} but the README banner still names v${m[1]}. `
        + 'Run `node scripts/release-prepare.js` (the release PR already does) — nothing else updates it.'
    );
  });

  it('the banner\'s release-status link and Sprint Report link both name the current version', () => {
    const statusMatch = bannerLine.match(/docs\/releases\/v(\d+\.\d+\.\d+)\.md/);
    assert.ok(statusMatch, `expected a \`docs/releases/vX.Y.Z.md\` link in the banner: ${bannerLine}`);
    assert.equal(statusMatch[1], version, `banner release-status link names v${statusMatch[1]}, not the current ${version}`);

    const reportMatch = bannerLine.match(/\[`v(\d+\.\d+\.\d+)`\s+Sprint Report\]\(https:\/\/jason-vaughan\.github\.io\/TangleClaw\/reports\/v(\d+\.\d+\.\d+)\/\)/);
    assert.ok(reportMatch, `expected a "\`vX.Y.Z\` Sprint Report" link in the banner: ${bannerLine}`);
    assert.equal(reportMatch[1], version, `banner Sprint Report link text names v${reportMatch[1]}, not the current ${version}`);
    assert.equal(reportMatch[2], version, `banner Sprint Report link target names v${reportMatch[2]}, not the current ${version}`);
  });
});
