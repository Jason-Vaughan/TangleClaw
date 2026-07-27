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
                              update-checker polls origin tags → update pill → Update & restart
```

**A merged fix is not a delivered fix.** `lib/update-checker.js` and `lib/update-applier.js` both
take the newest tag on origin as their only input, so the tag is what delivers a release. Before this
was automated, five consecutive releases (4.31.2 through 4.32.0) shipped untagged and every install
was told it was up to date (#713).

## What is automatic

`.github/workflows/release.yml` runs on any push to `main` that changes `version.json`. It reads the
version from the commit that just landed, skips cleanly if that tag already exists, extracts the
matching `CHANGELOG.md` section, creates and pushes an annotated `vX.Y.Z` tag, confirms the tag is
visible on origin, and publishes a GitHub Release with those notes.

**Do not tag by hand.** The repo-wide global rules still describe manual tagging as a follow-up step
after a substantive merge; that guidance applies to other projects TangleClaw manages, not to this
repo. Tagging here manually races the workflow and can produce a release the workflow then skips.

The trigger is deliberately "`version.json` changed on `main`" rather than "a wrap ran". The wrap
cannot know whether or when its bump reaches `main`: it returns before its own PR merges, that PR is
squash-merged (so the wrap commit is replaced by a different SHA), its base may be a feature branch,
and it may never merge at all. Keying on `main` means every path that lands a bump gets tagged, and
the tag always points at the commit that actually carries the version.

## What is still manual

**Bumping the version.** Only an operator-driven Session Wrap bumps `version.json` and promotes the
`[Unreleased]` CHANGELOG section. Merging PRs does not. So a release happens when you run a wrap and
that wrap's PR merges to `main` — not when feature PRs merge.

The wrap picks the bump level from what is in `[Unreleased]`:

| `[Unreleased]` content | Bump |
|---|---|
| `BREAKING:` / `BREAKING(` anywhere in the body | major |
| Any `### Added`, `### Changed`, `### Removed`, `### Deprecated` | minor |
| Only `### Fixed`, `### Security`, `### Internal` | patch |

## If a release did not go out

Check in this order:

1. **Did `version.json` actually change on `main`?** The workflow's path filter means nothing runs
   otherwise. A wrap whose PR never merged, or which ran on a feature branch, leaves the bump
   stranded — this happened to 4.32.1 (recovered as PR #719). Compare
   `git show origin/main:version.json` against the version you expected.
2. **Did the workflow fail?** `gh run list --workflow=release.yml`. The most likely failure is a
   version bump with no matching `CHANGELOG.md` section, which fails deliberately rather than
   publishing an empty release.
3. **Is the tag on origin?** `git ls-remote --tags origin | grep vX.Y.Z`. This is the exact thing
   installs poll.

To re-run after fixing the cause, use the workflow's manual trigger (`workflow_dispatch`); it is
idempotent and will skip if the tag already exists.

## Tag and version must agree

The workflow reads the version from the commit it tags, so they cannot drift. Preserve that property
in any hand-recovery: tagging a tree whose `version.json` is older than the tag makes every install
see a permanent "update available" it can never satisfy — it applies the update and still reads the
old version.

## Related

- `docs/adr/0002-wrap-pipeline-contract.md` — the wrap pipeline's step contract.
- `lib/changelog-notes.js` — release-notes extraction, shared by the workflow and its tests.
