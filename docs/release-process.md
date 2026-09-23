# Release process

How a change in TangleClaw reaches an installed copy.

## The chain

```
Session Wrap  →  version.json bumped + CHANGELOG promoted  →  merged to main
                                                                    ↓
                                          .github/workflows/release.yml (automatic)
                                                                    ↓
                                              annotated tag + GitHub Release
                                                                    ↓
                            update-checker polls origin tags → update beacon → Update now
```

**A merged fix is not a delivered fix.** `lib/update-checker.js` and `lib/update-applier.js` both
take the newest tag on origin as their only input, so the tag is what delivers a release. Before this
was automated, five consecutive releases (4.31.2 through 4.32.0) shipped untagged and every install
was told it was up to date (#713).

## What is automatic

`.github/workflows/release.yml` runs on any push to `main` that changes `version.json`. It first
runs the full test suite on the commit that just landed, inside the same run (`test.yml`, called as a
reusable workflow). Only if that passes does it read the version from that commit, extract the
matching `CHANGELOG.md` section, create and push an annotated `vX.Y.Z` tag, confirm the tag on
origin dereferences to that commit, and publish a GitHub Release with those notes.

**A release publishes only the exact commit it tested (#1551).** The tested commit and the released
commit are the same `GITHUB_SHA` by construction: the publishing job `needs:` the test job, so a red
or cancelled suite publishes nothing. The tag must dereference to that commit too, and the run
refuses red, naming both SHAs, when it does not:

- **An existing tag on another commit refuses**, whether or not its Release exists. With no Release,
  healing would publish code this run never tested. With a Release, the version was already released
  from a different commit, and this commit reuses its number.
- **After a push**, the tag on origin is checked again before publishing.

The workflow never moves or deletes a tag. A refusal is for the Operator to resolve.

Only the publishing job holds `contents: write`. The workflow's default token, which the suite runs
with, is read-only.

**Tag and Release are checked independently, never as one "already done" flag.** A run that pushed
the tag and then failed before publishing would otherwise be unrecoverable — every re-run would see
the tag, report success, and publish nothing. Because the two are separate, re-running heals a
partial release, and a tag that arrived from anywhere else still gets its Release.

**Do not tag by hand.** The repo-wide global rules describe manual tagging as a follow-up step after
a substantive merge; that guidance applies to other projects TangleClaw manages, not to this repo
(`CLAUDE.md` carries the same exception). A hand-made tag races the workflow, and can pin a commit
whose `version.json` disagrees with the tag — see "Tag and version must agree" below.

### The post-commit hook is not the tagger

`hooks/post-commit` also tags from `version.json` on `main`. It is a template TangleClaw installs
into *managed* projects (README "Git hooks"), it is opt-in here, and it is **not installed in this
repo**. It creates a *lightweight, local* tag and never pushes, so it can never deliver a release on
its own — which is part of why tagging looked like it was happening while five releases shipped
undelivered. The workflow is the tagger for this repo; if the hook were installed, its local tag
would simply be superseded, and the Release still published.

The trigger is deliberately "`version.json` changed on `main`" rather than "a wrap ran". The wrap
cannot know whether or when its bump reaches `main`: it returns before its own PR merges, that PR is
squash-merged (so the wrap commit is replaced by a different SHA), its base may be a feature branch,
and it may never merge at all. Keying on `main` means every path that lands a bump gets tagged, and
the tag always points at the commit that actually carries the version.

## What is still manual

**Bumping the version.** Only an operator-driven Session Wrap bumps `version.json` and promotes the
`[Unreleased]` CHANGELOG section. Merging PRs does not. So a release happens when you run a wrap and
that wrap's PR merges to `main` — not when feature PRs merge.

Whether a wrap cuts at all is the project's `releaseMode` (`docs/configuration-reference.md`):

- `off` never cuts. A project on `off` releases by a PR that bumps `version.json`, not by a wrap.
- `auto` cuts when release readiness is `ready`. Readiness holds when `[Unreleased]` is empty, and
  when the project's active Prawduct build plan (`active_build_plan:` in `.prawduct/project-state.yaml`,
  else `.prawduct/artifacts/build-plan.md`) has an unticked box under `## Status`. A plan with no
  `## Status` section isn't judged.
  A signal that can't be read, such as a pointer to a missing plan, stops the wrap at `version-bump`
  and asks the operator to choose Cut or Hold.
- `ask` never cuts by itself: every wrap with a release to cut stops at `version-bump` and asks.

In `auto` and `ask`, the wrap modal's **Release** control decides for that wrap: Cut cuts (optionally
at a chosen level) and Hold doesn't, whatever readiness says. Auto follows the mode. A plain hold is
reported as a skipped `version-bump` step whose reason names the signal responsible. A stop is a
`needs-operator` row with the Cut / Hold choice under it; nothing is committed until you answer and
press Retry.

The wrap picks the bump level from what is in `[Unreleased]`:

| `[Unreleased]` content | Bump |
|---|---|
| `BREAKING:` / `BREAKING(` anywhere in the body | major |
| Any `### Added`, `### Changed`, `### Removed`, `### Deprecated` | minor |
| Only `### Fixed`, `### Security`, `### Internal` | patch |

## Files a release needs besides the version

Two tests fail a release PR that carries only `version.json` and the promoted `CHANGELOG.md`:
`test/readme-version-pins.test.js` (the README's `--branch vX.Y.Z` clone pins) and
`test/changelog-released-immutable.test.js` (every released section must be in
`test/fixtures/changelog-released-sections.lock.json`). The first wrap-cut release, 5.26.0, went red
on both (#1501).

The wrap covers them through the project's `releasePrepareCommand` (#1502). This install's
`.tangleclaw/project.json` sets it to `node scripts/release-prepare.js`, which moves the pins and adds
the new section to the lock. It only ever adds: a locked section that changed, or an older released
section with no lock line, stops the script and the wrap's commit, because relocking is exactly what
the lock exists to catch. `.tangleclaw/project.json` is not tracked, so a fresh clone cuts releases
without it until the key is set. Run by hand, the script reads the version from `version.json`.

## If a release did not go out

Check in this order:

1. **Did `version.json` actually change on `main`?** The workflow's path filter means nothing runs
   otherwise. A wrap whose PR never merged, or which ran on a feature branch, leaves the bump
   stranded — this happened to 4.32.1 (recovered as PR #719). Compare
   `git show origin/main:version.json` against the version you expected.
2. **Did the workflow fail?** `gh run list --workflow=release.yml`. The most likely failure is a
   version bump with no matching `CHANGELOG.md` section, which fails deliberately rather than
   publishing an empty release. A red `test` job, or a tag that names a different commit, also
   stops it before anything is published (see "A release publishes only the exact commit it
   tested" above).
3. **Is the tag on origin?** `git ls-remote --tags origin | grep vX.Y.Z`. This is the exact thing
   installs poll.

To recover after fixing the cause, open the **original** failed Release run and choose **Re-run all
jobs**. A re-run keeps that run's `GITHUB_SHA` and `GITHUB_REF`, so it tests the same commit again
and releases exactly it. Re-run *all* jobs, not only the failed ones, so the commit is freshly
tested.

Re-running is the remedy, not a no-op: because tag and Release are checked independently, a re-run
publishes the missing Release for a tag that already exists. It only does nothing when the version is
genuinely tagged *and* released on that commit.

**GitHub allows re-running a run for 30 days.** Past that, or if the original run cannot be re-run
for any other reason, do not work around it. Stop and escalate to the Operator. There is
deliberately no way to name the commit to release by hand.

The manual trigger (`workflow_dispatch`) **from `main`** runs at main's *current* head. It releases
correctly only while that head is still the version's commit. Once a later commit has landed, a
dispatch refuses when a tag for the version already exists on the earlier commit, which is the
intended outcome and not a fault. A dispatch aimed at any branch other than `main` exits green
without doing anything, which looks like success.

If a run refuses because a tag names a different commit, **do not move or re-create the tag by
hand.** Escalate to the Operator.

## Versions 4.31.2 – 4.31.5 are deliberately untagged

Those four shipped before tagging was automated and were never backfilled. That is a decision, not an
oversight: anyone on a 4.31.x install already sees the newest release and can update to it, because
the checker compares against the *newest* tag rather than walking the sequence. Backfilling would
make the tag history tidier and change nothing functionally, and it would mint GitHub Releases dated
long after the work. Leave them.

## Tag and version must agree

The workflow reads the version from the commit it tags, so they cannot drift. Preserve that property
in any hand-recovery: tagging a tree whose `version.json` is older than the tag makes every install
see a permanent "update available" it can never satisfy — it applies the update and still reads the
old version.

## Related

- `docs/adr/0002-wrap-pipeline-contract.md` — the wrap pipeline's step contract.
- `lib/changelog-notes.js` — release-notes extraction, shared by the workflow and its tests.
- `scripts/release-tag-gate.js` — decides whether a tag on origin dereferences to the released
  commit; `test/release-workflow.test.js` pins how the workflow calls it and what publishing waits on.
