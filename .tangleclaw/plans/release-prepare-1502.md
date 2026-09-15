# Release-prepare hook for wrap cuts (#1502)

Critic mode: final

## Problem

The first wrap-driven release (PR #1501, 5.25.1 → 5.26.0) failed CI. The wrap promoted `CHANGELOG.md`
and bumped `version.json` correctly, but this repo's releases also have to update two other files:
the README clone pins (`test/readme-version-pins.test.js`, #976) and the released-sections lock
(`test/changelog-released-immutable.test.js`). Every hand cut touched all four files; the wrap
touches two. A wrap can therefore never produce a green release PR for this repo.

## Confidence check

1. **Problem:** a wrap that cuts a release commits only `version.json` + `CHANGELOG.md`, so a
   project whose release needs other files (pins, lockfiles) gets a red release PR.
2. **Success:** with `releasePrepareCommand` set, a wrap that cuts runs the command after the
   bump is on disk and before the commit, and the files it changes land in the wrap commit. A
   failing command stops the commit, names the failure, and puts the bump back so a Retry cuts
   again from scratch. No command configured → the commit output says so. For this repo,
   `scripts/release-prepare.js` updates the pins and the lock, and CI is green on the cut.
3. **Out of scope:** a settings-modal field (the key is hand-edited in `.tangleclaw/project.json`,
   same as `testCommand`); the FEATURES.md `TODO (auto-stubbed)` noise the #1501 wrap also
   produced (tracked separately); running the test suite in the wrap.

Requirements confidence: High.

## Decisions

- [DECISION: the command runs in the `commit` step, not `version-bump`.] `version-bump` never writes
  the filesystem (single-transaction discipline); its promote is only on disk after `commit`
  flushes. The command needs the promoted CHANGELOG on disk (the lock hashes it), so it runs right
  after the flush.
- [DECISION: a failing command restores the flushed files.] Without that, a Retry sees an empty
  `[Unreleased]`, `version-bump` skips, and the commit lands the bump WITHOUT its companions —
  exactly the red PR this fixes. Restoring the pre-flush contents makes Retry re-derive the cut.
- [DECISION: the release version reaches the command as env vars] (`TANGLECLAW_RELEASE_VERSION`,
  `TANGLECLAW_RELEASE_PREVIOUS`), not by string substitution into a shell command.
- [DECISION: the paths the command changed are found by diffing `git status` + content hashes]
  before and after, and join the wrap-written set, so they get exactly the ownership rules a
  flushed file gets (an operator's Leave still wins).
- [DECISION: halts as the commit step's `blocked`], not `needs-operator` as the issue sketched: the
  commit step's vocabulary, and the operator's remedy is to fix the command, not to choose.
- Engine-agnostic: mechanical layer only; no engine is consulted.

## Chunk 01 — hook + this repo's script

Files: `lib/wrap-steps/commit.js`, `lib/project-config.js`, `scripts/release-prepare.js`,
`test/wrap-release-prepare.test.js`, `test/release-prepare-script.test.js`,
`docs/configuration-reference.md`, `docs/adr/0002-wrap-pipeline-contract.md`,
`docs/release-process.md`, `CHANGELOG.md`.

Done when:
- Real-git tests: cut + command → companion files in the commit; no cut → command not run; cut +
  no command → honest skip in output; failing / timed-out command → nothing committed, flushed
  files restored, stderr in the blocker; Leave on a dirty-at-launch file the command rewrites holds.
- Script test: on a copy of this repo's README/CHANGELOG, the script's lock equals what the
  immutability test computes, and pins match the version; idempotent.
- Suite green; Critic final with zero blocking.

## Status

- [ ] Chunk 01 — hook + this repo's script
