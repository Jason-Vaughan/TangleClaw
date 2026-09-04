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
  return gitAnswer(['ls-files', '--error-unmatch', relPath]);
}

/**
 * Whether git ignores a path in this repo.
 *
 * @param {string} relPath - Repo-relative path.
 * @returns {boolean}
 */
function isIgnored(relPath) {
  return gitAnswer(['check-ignore', '-q', '--', relPath]);
}

/**
 * Run a git query whose exit status IS the answer, distinguishing "no" from
 * "git could not answer".
 *
 * Both `ls-files --error-unmatch` and `check-ignore -q` exit 1 for a plain no
 * and 128 for a real failure (not a repo, no git). Folding those together is
 * how a guard passes vacuously outside a checkout, so an unexpected status
 * throws rather than quietly reading as `false`.
 *
 * @param {string[]} args - Arguments to git.
 * @returns {boolean} True on exit 0, false on exit 1.
 */
function gitAnswer(args) {
  try {
    execFileSync('git', args, { cwd: REPO_ROOT, stdio: 'pipe' });
    return true;
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- exit 1 is the negative answer
    // being asked for; anything else is rethrown on the next line.
    if (err && err.status === 1) return false;
    throw new Error(`git ${args.join(' ')} could not answer (status ${err && err.status}) — `
      + 'this guard cannot report a result it did not get');
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

  it('keeps the un-ignore one file wide', () => {
    // Asserted with `check-ignore`, not `ls-files`: the risk is a WIDER negation
    // (`!.claude/*`), and everything under `.claude/` would still read as
    // untracked until someone runs `git add -A` — so a tracking probe cannot
    // fail for the reason this test exists.
    assert.equal(isIgnored('.claude/settings.json'), false,
      '.claude/settings.json must not be ignored, or no clone reads as governed');
    assert.equal(isIgnored('.claude/settings.local.json'), true,
      'settings.local.json holds per-machine permissions and must stay ignored');
    assert.equal(isIgnored('.claude/worktrees'), true,
      'agent worktrees must stay ignored');
  });

  it('carries a COMPLETE plugin reference, both halves', () => {
    // Through the repo's own completeness contract rather than a hand-rolled
    // `enabledPlugins` scan. `_isCompletePluginRef` also requires a matching
    // `extraKnownMarketplaces` entry, and its docstring names the failure this
    // guards: enabledPlugins alone installs an unresolvable plugin that fails
    // silently wherever prawduct is not already registered — invisible on the
    // machine that wrote it. The recorded follow-up (splitting machine-local
    // keys out of this file) is exactly the edit that could drop that half.
    const settings = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
    assert.equal(engines._isCompletePluginRef(settings), true,
      `the committed reference must be complete (got ${JSON.stringify(settings)})`);
  });

  it('commits no absolute path, so a clone at another path is not broken', () => {
    // The `hooks` block TangleClaw writes carries absolute paths to THIS
    // checkout. Committed, every clone elsewhere would run two commands that do
    // not exist at every Claude Code start — and hook failures here feed back as
    // synthetic user messages. Only the portable governance keys are tracked.
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8');
    assert.doesNotMatch(raw, /"\/(Users|home)\//,
      'the tracked settings must carry no machine-absolute path');
    assert.equal(JSON.parse(raw).hooks, undefined,
      'the hooks block is machine-local — syncEngineHooks writes it at launch');
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
    // chain is asserted end to end rather than left to the comment above. Read
    // straight from the profile JSON — the raw artifact the assertion is about,
    // with no accessor in between that could normalise a default in later.
    const profile = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'data', 'engines', 'claude.json'), 'utf8'));
    assert.equal(profile.configFormat.filename, 'CLAUDE.md',
      'the claude profile must still carry CLAUDE.md, or this guard is testing nothing');
    assert.ok(!profile.configFormat.mergeStrategy
      || profile.configFormat.mergeStrategy === 'whole-file',
      'the profile still declares no managed-block strategy of its own — governance is '
      + 'what supplies it, which is why the reference has to be committed. If this ever '
      + 'changes, CLAUDE.md is protected on its own and this coupling can be revisited.');
  });

  it('carries no live service token, now that the file is public', () => {
    // `_generateClaudeMd` still inlines a live `Authorization: Bearer <token>`
    // when the AUTH-4 gate is on, because `committedCarrier` is a per-generator
    // constant it does not pass. That generator is the UNGOVERNED path, and
    // `isPluginGoverned` fails closed — so one unreadable settings.json plus the
    // gate enabled writes an M2M bearer into a tracked file. Deriving the flag
    // from whether the target is actually tracked is the class fix (#1240);
    // this asserts the outcome that would matter in the meantime.
    const claudeMd = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    for (const m of claudeMd.matchAll(/Authorization:\s*Bearer\s+(\S+)/gi)) {
      assert.match(m[1], /^[`<]/,
        `CLAUDE.md is tracked and must carry no live bearer token (found "${m[1].slice(0, 12)}…")`);
    }
  });

  it('keeps the Global Rules mirror equal to its source', () => {
    // The section is a hand-maintained copy of data/global-rules.md, and both
    // are now in git with nothing holding them equal. Derived from the source of
    // truth rather than pinned to a snapshot, so editing global-rules.md alone
    // fails here instead of silently leaving this repo on stale canon.
    const claudeMd = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8').split('\n');
    const source = fs.readFileSync(path.join(REPO_ROOT, 'data', 'global-rules.md'), 'utf8');

    const start = claudeMd.indexOf('# Global Rules');
    const end = claudeMd.findIndex((l) => l.startsWith('<!-- PRAWDUCT:ANCHOR'));
    assert.ok(start !== -1, 'CLAUDE.md must contain the mirrored "# Global Rules" heading');
    assert.ok(end > start, 'the PRAWDUCT:ANCHOR marker must follow the mirror, bounding it');

    assert.equal(claudeMd.slice(start, end).join('\n').trimEnd(), source.trimEnd(),
      'CLAUDE.md\'s Global Rules section has drifted from data/global-rules.md — '
      + 'edit the source and copy it here, never one alone');
  });
});
