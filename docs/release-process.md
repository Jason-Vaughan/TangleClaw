# Release process

How a change in TangleClaw reaches an installed copy.

## The chain

```
Session Wrap  →  changelog.d/ fragments compiled into [Unreleased]
              →  version.json bumped + CHANGELOG promoted + fragments deleted, one commit
              →  merged to main
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

**Release notes are measured before anything is tagged (#2080).** `gh release create` runs after
the tag is pushed, so a body GitHub refuses would leave a tag with no Release. The run therefore
measures the exact UTF-8 bytes of the extracted notes first (`scripts/release-notes-gate.js`), and
refuses red, before any tag, push or release, when they are empty or over **120,000 bytes**. That
ceiling is conservatively below GitHub's limit and counts bytes, not characters. The notes are never
truncated. An oversized section is fixed by shortening it in `CHANGELOG.md`; "If a release did not
go out" below has the steps, because the fix is a new commit and touches the released-section lock.

That refusal should never be the first warning. `test/changelog-unreleased-size.test.js` fails the
suite once `[Unreleased]` would publish more than **110,000 bytes**. It runs the workflow's own
extractor command and counts the file that command writes, trailing newline included, so the pull
request whose entry crosses the line goes red while there is still room to condense the section or
to release what has accumulated.

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
that wrap's PR merges to `main` — not when feature PRs merge. A wrap that cuts first compiles every
fragment under `changelog.d/` into `[Unreleased]`, in memory, and decides the bump level on the result;
the promoted `CHANGELOG.md`, the bumped version file and the deletion of each compiled fragment land as
one commit, whose body says `Compiled N changelog fragment(s)`. A fragment the contract refuses stops
the cut at `version-bump` with the file and its code named; nothing is promoted or deleted until it is
fixed or removed.

**Logging the change.** A change records its entry as a fragment, `changelog.d/<issue>.<slug>.<type>.md`,
not as an edit under `[Unreleased]`: `docs/changelog-fragments.md` is the contract and `CONTRIBUTING.md`
says how to write one. The wrap's `changelog-update` step asks for a fragment and its coverage gate
accepts one, dirty or committed. The bump table below reads the compiled text, so a pending fragment
counts exactly as an entry written under `[Unreleased]` would. **Transition:** a pull request created
before PR #2520 merged (merge commit `c774d21d630145b54504b8ce2393fb93dc1c313b`, 2026-10-21T18:39:01Z)
may still add its entry directly under `[Unreleased]`, and the gate accepts both routes.

A release cut commits all of its files or none. If the wrap's file decisions leave any release file out of
the commit (`CHANGELOG.md`, the version file or a compiled fragment), the commit step refuses before
anything is branched or staged, puts the cut back, and asks you to include every release file or choose
Release: Hold; a half-committed cut would consume fragments that never publish.

Whether a wrap cuts at all is the project's `releaseMode` (`docs/configuration-reference.md`):

- `off` never cuts. A project on `off` releases by a PR that bumps `version.json`, not by a wrap.
- `auto` cuts when release readiness is `ready`. Readiness holds when there is nothing to release
  (`[Unreleased]` empty and no fragment pending under `changelog.d/`), and
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

## Proposed: PR fragment gate (NOT IN FORCE)

Nothing in this section binds anyone. It records, word for word, the gate the Operator-conditional
chunk of #1220 would add, so the Operator can rule on it (`1220 obligation now`, logged in the lane
queue) by reading what it is rather than what it might be. Until that ruling, and until the pull
request that builds it merges, no CI step refuses a pull request for a missing fragment. What runs
today: the repository's own test suite checks every fragment under `changelog.d/` on every run
(`test/changelog-fragments-repo.test.js`), so a file the contract refuses fails the pull request that
adds it rather than the next release cut; and a change that ships with no entry at all is caught by the
wrap's `changelog-update` coverage gate in the session that made it, not at the pull request.

### What the gate would check

- **Which pull requests.** One whose diff touches `lib/`, `server.js`, `public/` or `scripts/`. A pull
  request that touches none of these (docs, tests, records) is not asked for a fragment.
- **What satisfies it.** At least one file added under `changelog.d/` whose name `parseFragmentName`
  in `lib/changelog-fragments.js` accepts: `<issue>.<slug>.<type>.md`. The name is judged, as the
  wrap's coverage gate judges it; the body is read at release preparation.
- **The escape.** The pull request body carries the exact line `Changelog: none`, followed on the same
  line by the reason, for a change with nothing to log (a revert, a refactor an existing entry already
  covers). The line with no reason refuses.
- **Fail closed.** An unreadable body, an unreadable file list, or a file under `changelog.d/` whose
  name the contract refuses, each refuse. The gate never passes on missing evidence.

### Exit codes

| Exit | Meaning |
|---|---|
| `0` | pass: a valid fragment was added, the pull request touches no code path, or the escape line carries a reason |
| `1` | refused, with the reason printed: no fragment on a code change, a malformed fragment name, or the escape line without a reason |
| `4` | could not measure: the file list or the body could not be read, so nothing was judged |

### The one workflow step

A single step in `.github/workflows/test.yml`, on `pull_request` only, after the conflict-marker scan
and before the suite. The script, `scripts/changelog-fragment-gate.js`, reads the pull request's
changed files and body with `gh pr view --json files,body`; its tests hand it a `--files` and
`--body-file` pair instead, so no test needs the network. It prints as `scripts/release-prepare.js`
does.

```yaml
      - name: Require a changelog fragment on a code change
        # A push event has no pull request to read; the gate is a pull-request contract.
        if: ${{ github.event_name == 'pull_request' }}
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: node scripts/changelog-fragment-gate.js --pr "$PR_NUMBER"
```

### What has to happen before it is in force

1. The Operator rules `1220 obligation now`, logged in the lane queue. Without the ruling the chunk is
   not built, #1220 stays open with that chunk named as the remainder, and this section stays as it is.
2. The chunk ships the script, its tests and the workflow step in one pull request, which the gate
   refuses once for a missing fragment and then passes with one; both CI run links go in its body.
3. This heading is removed and the gate is documented as in force, here and in `CONTRIBUTING.md`.

### The transition exception ends separately

The transition in "What is still manual" (a pull request created before the boundary may still edit
`[Unreleased]` directly, and the coverage gate accepts both routes) ends when no such pull request is
open, not when the gate above arrives. The open list was taken on 2026-10-21 and two pre-boundary pull
requests were still open (#2385, #2217), so the wording and the direct-edit route stay; #2523 removes
them once both are closed or merged.

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
the lock exists to catch. It also refuses while `changelog.d/` still holds a valid fragment: it runs
after the wrap's flush, so on a correct cut the directory is already empty, and a fragment still there
is one the cut did not compile and would publish twice or never. `.tangleclaw/project.json` is not
tracked, so a fresh clone cuts releases without it until the key is set. Run by hand, the script reads
the version from `version.json`.

## If a release did not go out

**The wrap stopped after the fragments were consumed** (a halt at or after the `commit` step's
flush: the release-prepare command, a blocked file decision, `git add`, a pre-commit hook). Nothing
is committed. Before it flushes a release cut, the commit step records every release file's prior
bytes (`CHANGELOG.md`, the version file and each fragment, an untracked one included) and their
index entries, in memory and under `.tangleclaw/release-recovery/<run id>/` in the project's
TangleClaw config root, and any such halt puts the work tree back from that record, and the index
entries of those files once `git add` had run. The commit row's remediation says what was put back;
when everything was, the record is removed and Retry cuts the release again from scratch. Two cases
leave the record on disk, and `version-bump` refuses every cut while it exists, naming it, so a retry
can neither compile a fragment twice nor skip one:

- **Something could not be put back** (the remediation says so and never claims the tree is clean).
  `manifest.json` in that directory names each file's path, whether it existed, and its index entry;
  copy each file in `files/` back to the path it names, put back each index entry it lists
  (`git update-index --add --cacheinfo <mode>,<object>,<path>`, or `--force-remove -- <path>` for one
  recorded as absent), then delete the directory.
- **`git commit` was stopped by its timeout.** Nothing is put back, because the commit may still land.
  Run `git log -1` first: if the wrap commit is there, the release landed and only the wrap was cut
  short, so delete the directory; if it is not, recover as above.

Never `git checkout -- <path>` to recover: it discards unrelated uncommitted edits the files carried,
and an untracked fragment is not in `HEAD` at all. The record is the source.

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

How to recover depends on whether the failed run **pushed the tag**. Step 3 above tells you:
the tag is on origin or it is not.

**The tag is NOT on origin** (the run stopped before tagging: a red `test` job, a missing
`CHANGELOG.md` section, release notes refused as empty or oversized, a network error):

- **The fix is a new commit** (the usual case: a promoted CHANGELOG section, a test fix). Land it
  on `main`, then run the manual trigger (`workflow_dispatch`) **from `main`**. This is a **new
  release candidate that replaces the failed one**, not a continuation of it: it tests main's
  current head and creates the still-absent tag on that commit, which carries the same
  `version.json`. Do not re-run the original run: it checks out the old commit, which still lacks
  the fix, and fails again.
- **The notes were refused as oversized** (the `notes-gate` step). This is the new-commit
  case with one extra step, because the cut already recorded this version's section in
  `test/fixtures/changelog-released-sections.lock.json`:
  1. Confirm with step 3 that the tag is not on origin. The section was then never published, so
     it may still change. If the tag *is* on origin, stop: see the next heading.
  2. Shorten the version's section in `CHANGELOG.md`. Keep every entry; cut narration.
  3. Delete **that one version's line** from the lock file, then run
     `node scripts/release-prepare.js`. It re-adds only that line, from the shortened section, and
     still refuses if any other released section has drifted.
  4. Land both files in one commit on `main`, then dispatch from `main`.

  Do not do what the failing test seems to ask. With the section shortened and the lock untouched,
  `test/changelog-released-immutable.test.js` says to move the edits back and not relock, and
  `release-prepare.js` refuses the same way. Both are right for a section that was published,
  which this one was not. Never regenerate the whole lock: that would accept every other drift
  the lock exists to catch.
- **Nothing needed fixing** (a flaky test, a network error): open the original run and choose
  **Re-run all jobs**. That is the default. A dispatch from `main` is equivalent only while main's
  head is still that run's commit. If `main` has moved on, a dispatch releases a *different*
  candidate, so it needs an explicit Operator decision first.

**The tag IS on origin** (the run failed after pushing the tag, so the Release is missing): open the
**original** run and choose **Re-run all jobs**. A re-run keeps that run's `GITHUB_SHA` and
`GITHUB_REF`, so it re-tests the tagged commit and publishes its Release. Re-run *all* jobs, not only
the failed ones, so that commit is freshly tested. A dispatch from `main` heals it too, but only
while main's head is still the tagged commit. Once a later commit has landed, a dispatch refuses,
because the tag names an earlier commit. That refusal is intended, not a fault.

**One case a re-run cannot heal: the tag is on origin and the notes are refused as oversized.** The
workflow no longer produces this state, since the notes are measured before it tags, but a tag
pushed by an older workflow or by hand can still meet it. The re-run tests the same commit, extracts
the same notes and is refused again. Shortening the section does not help either: the fix would be
a new commit, and the tag names the old one. Do not shorten, relock, move the tag or dispatch.
Escalate to the Operator, who decides how that tag gets its Release.

**GitHub allows re-running a run for 30 days.** If a tag is on origin with no Release and the
original run can no longer be re-run, do not work around it. Stop and escalate to the Operator.
There is deliberately no way to name the commit to release by hand.

Re-running is the remedy, not a no-op: because tag and Release are checked independently, a re-run
publishes the missing Release for a tag that already exists. It only does nothing when the version is
genuinely tagged *and* released on that commit.

A dispatch aimed at any branch other than `main` exits green without doing anything, which looks
like success.

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
- `scripts/release-notes-gate.js` — refuses empty or oversized release notes before tagging.
- `scripts/release-tag-gate.js` — decides whether a tag on origin dereferences to the released
  commit; `test/release-workflow.test.js` pins how the workflow calls it and what publishing waits on.
