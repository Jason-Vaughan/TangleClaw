'use strict';

/*
 * #833 — this repository's own plugin install reference is a committed artifact.
 *
 * Why it is worth a guard rather than a comment. `CLAUDE.md` is the file Claude
 * Code reads in this directory, and it is now tracked. It is only SAFE to track
 * because `writeEngineConfig` picks its merge strategy from governance:
 *
 *     const mergeStrategy = governed ? 'managed-block' : (declared || 'whole-file')
 *
 * `CLAUDE.md` is not in `SHARED_CONVENTION_CARRIERS` and `data/engines/claude.json`
 * declares no `mergeStrategy`, so an UNGOVERNED clone resolves `whole-file` and
 * the first session launch overwrites the committed file with generated content.
 * Governance is the only thing standing between the two outcomes.
 *
 * And governance is read from `.claude/settings.json` — a file that was ignored
 * until #833, so a fresh clone carried no reference and read as ungoverned. The
 * three assertions below are one chain: the file is tracked, it carries the
 * reference, and therefore this repo reads as governed. Breaking any link
 * silently re-arms the overwrite, and the damage would only ever appear on
 * someone else's first clone — never on the machine that broke it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const engines = require('../lib/engines');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Whether git tracks a path in this repo.
 *
 * `git ls-files --error-unmatch` rather than `fs.existsSync`: the whole failure
 * this guards against is a file that exists on the machine that wrote it and in
 * nobody else's clone, which is exactly what an existence check cannot see.
 *
 * @param {string} relPath - Repo-relative path.
 * @returns {boolean}
 */
function isTracked(relPath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relPath], {
      cwd: REPO_ROOT, stdio: 'pipe'
    });
    return true;
  } catch {
    // prawduct:allow prawduct/broad-except -- ls-files exits non-zero for an
    // untracked path, which is the answer being asked for, not an error.
    return false;
  }
}

describe("this repo's plugin install reference is committed (#833)", () => {
  it('tracks .claude/settings.json', () => {
    assert.ok(isTracked('.claude/settings.json'),
      '.claude/settings.json must be tracked — a clone without it reads as ungoverned, '
      + 'which switches CLAUDE.md to whole-file and destroys it on first launch');
  });

  it('tracks CLAUDE.md', () => {
    assert.ok(isTracked('CLAUDE.md'),
      'CLAUDE.md must be tracked — untracked, a fresh clone gets generated content '
      + 'instead of the hand-maintained file');
  });

  it('does NOT track the machine-local settings', () => {
    // The negation in .gitignore is deliberately narrow. A broader rule would
    // sweep in permissions (settings.local.json) and every agent worktree.
    assert.equal(isTracked('.claude/settings.local.json'), false,
      'settings.local.json holds per-machine permissions and must stay ignored');
  });

  it('carries an enabled prawduct plugin entry', () => {
    const settings = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
    const enabled = settings.enabledPlugins || {};
    const keys = Object.keys(enabled).filter((k) => k.startsWith('prawduct@') && enabled[k] === true);
    assert.ok(keys.length > 0,
      `enabledPlugins must carry an enabled prawduct@* entry (got ${JSON.stringify(enabled)})`);
  });

  it('reads as plugin-governed, which is the property that protects CLAUDE.md', () => {
    // The assertion the other four exist to support. Run against the real repo
    // root through the real predicate — not a fixture, because the question is
    // about THIS checkout.
    assert.equal(engines.isPluginGoverned(REPO_ROOT), true,
      'isPluginGoverned must be true for this repo, or writeEngineConfig resolves '
      + "whole-file for CLAUDE.md and overwrites it");
  });

  it('CLAUDE.md would be spliced, not overwritten, for this repo', () => {
    // Ties the governance fact to the consequence it is being kept for, so the
    // chain is asserted end to end rather than left to the comment above.
    const profile = engines.getEngineProfile
      ? engines.getEngineProfile('claude')
      : JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'engines', 'claude.json'), 'utf8'));
    assert.equal(profile.configFormat.filename, 'CLAUDE.md',
      'the claude profile must still carry CLAUDE.md, or this guard is testing nothing');
    assert.ok(!profile.configFormat.mergeStrategy
      || profile.configFormat.mergeStrategy === 'whole-file',
      'the profile still declares no managed-block strategy of its own — governance is '
      + 'what supplies it, which is why the reference has to be committed. If this ever '
      + 'changes, CLAUDE.md is protected on its own and this coupling can be revisited.');
  });
});
