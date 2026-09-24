# #1766 — Remove the version-bump step's prawduct change-log `status=merged` flip

*Dual-Builder Pilot 2, Lane 2 (Continuity Subject). Branch `chore/1766-pilot-version-bump-flip`, cut from
`origin/main` @ `7aa12e05`. Dispatched by the PM on 2026-09-24. Boundary for this dispatch: **Plan Written**.*

## Status

- [x] Research + plan written (2026-09-24); parked here for the Continuity Test clear (PM, 2026-09-24)
- [x] Architectural items A1–A3 sent to the Architect (2026-09-24) → **STOP here** (Plan Written boundary)
- [x] Architect has ruled on A1–A3 (all approved 2026-09-24; see Rulings). Architectural gate cleared for this scope only
- [x] PM go to build (Medusa msg 40bd7164, 2026-09-24)
- [x] Build: remove the step + its staging key + commit-body line + tests; add the regression test; FEATURES.md + CHANGELOG (2026-09-24). Also dropped the now-stale "no stamp on `.prawduct/change-log.md`" clause from the #1738 hold comment in `run`
- [x] Verify: focused tests + full suite (this checkout only, never the main instance). Baseline at HEAD green; changed tree green (2026-09-24)
- [x] Critic: cumulative 0 blocking / 0 warning / 5 notes; R-1..R-3 fixed (verify-resolutions clean), R-4, R-5, O-1 accepted (2026-09-24)
- [ ] Draft PR opened. **STOP** (pilot boundary: no merge)

**Pilot envelope (IN FORCE):** no merging any PR, no pulling/updating the live checkout, no restarting the live
service, no tests on the main instance, no tag/publish/release, no deploy.

## Problem

`lib/wrap-steps/version-bump.js` couples the `[Unreleased]` promote to a rewrite of the project's
`.prawduct/change-log.md`. `_stagePrawductChangeLogStamp` reads the file and `_flipMergedTagLines`
changes every `<!-- prawduct: … status=merged … -->` tag line to `status=shipped`. The result is staged under
`staged['version-bump:prawduct-change-log']`, and `lib/wrap-steps/commit.js` then renders
"Stamped N prawduct change-log entries status=shipped" in the wrap commit body. This shipped as WRP-9F2K (PR #587,
2026-07-17), when prawduct's lifecycle still had a `merged` state that nothing stamped forward at release.

Prawduct no longer writes or reads that state:

- The merge flow stopped calling `stamp-merged` in prawduct **v2.3.2**. In v3.3.0 the command was emptied: it is
  inert, prints a deprecation notice and writes nothing. Its docstring gives the reason: `status=` "had exactly
  one reader — the derived-view regeneration — and that reader is retired". `regen-views` / `views_enabled` went
  in the same release. (Verified against the installed plugin, 3.6.0: `bin/prawduct-hook` `cmd_stamp_merged`,
  CHANGELOG v3.3.0.)
- A statusless tagged entry is now prawduct's *normal* release-pending state, so the step's other output,
  `output.changeLog.statusless` (described in its JSDoc as the "missed-merge-stamp diagnostic, REL-9F2T"), reports
  a healthy condition as a defect.

**The step has no input anywhere this host can see.** I checked all 24 projects under `~/Documents/Projects` that
carry a `.prawduct/change-log.md`. None has a tag line with `status=merged`. This repo's single `status=merged`
match is prose in the header, which the tag-line regex already skips. So the step stages nothing on every wrap
and only emits `changeLog: {flipped: 0, statusless: N}`, where N is a misleading count.

## Scope

**In:**

1. `lib/wrap-steps/version-bump.js`
   - Delete `PRAWDUCT_TAG_LINE_RE`, `_flipMergedTagLines`, `_stagePrawductChangeLogStamp`, and their two exports.
   - In `run`, delete the stamp call and the `output.changeLog` / `output.changeLogWarning` / `detail` suffix
     branch. Also drop `changeLogStamp` from the `version bumped` log line.
   - In the module JSDoc, delete the `staged['version-bump:prawduct-change-log']` bullet and the
     "Prawduct change-log release stamp (WRP-9F2K)" paragraph. The step's contract then reads as what it does:
     it stages `version-json` and `changelog`, nothing else.
   - This also removes the only `prawduct:allow prawduct/broad-except` waiver in this path, because the catch
     it covered goes too.
2. `lib/wrap-steps/commit.js` `_buildBodyLines`: delete the `changeLogFlipped` branch and its JSDoc bullet.
   An unknown staged entry already renders nothing ("extra staging keys aren't an error"), so there is no
   fallback to add.
3. `test/wrap-pipeline.test.js`: delete the `describe('wrap-step version-bump — prawduct change-log release stamp
   (WRP-9F2K)')` block (lines 3999–4159 at `7aa12e05`). Every test in it pins the removed behaviour.
4. **Regression contract (new test, same file, replacing the block).** A promotable project whose
   `.prawduct/change-log.md` holds a `status=merged` tag line gets a version bump. Afterwards:
   - no `version-bump:prawduct-change-log` key is staged;
   - `commit._flushStagedWrites` flushes exactly 2 files (version + CHANGELOG);
   - the change-log is byte-identical on disk;
   - `output` has no `changeLog` / `changeLogWarning`, and `detail` has no "stamped" suffix.

   This test pins the decision itself, so a future "helpful" reintroduction of the flip fails loudly. Deleted
   tests are not weakened contracts: the behaviour they covered is being removed on purpose, and this test is
   its replacement contract.
5. `FEATURES.md:387`: drop the "also flips … `status=merged` … (WRP-9F2K)" clause from the `version-bump` entry.
6. `CHANGELOG.md` `[Unreleased]`: one entry, `### Internal` (see A3).
7. Housekeeping that the last handoff assigned to the next PR. Move `1311-kill-modal-sessionmode.md` and
   `1059-origin-lookup-backoff.md` to `.tangleclaw/plans/archive/`. Both issues are CLOSED and PRs #1842 and #1843
   are merged.

**Out (left alone deliberately):**

- **Historical records:** CHANGELOG history, `.prawduct/change-log-archive/*`, and the `status=`
  bullet in `.prawduct/change-log.md`'s header, which that header already marks as "kept as the record … no longer
  instructions". Also the shipped WRP-9F2K entry in `.prawduct/backlog.md`. Rewriting records to match current code
  would erase why the code existed.
- `test/version-bump-release-gate.test.js:395` and `test/wrap-methodology-authority.test.js:45` seed a
  `status=merged` ledger and assert that a withheld/dormant run leaves it byte-identical. They stay green. One
  caveat: after this change, the ledger assertion no longer proves the withhold by itself, because a
  *granted* run would not touch the ledger either. The proof is still carried by the `version.json` /
  `CHANGELOG.md` assertions beside it (`version` stays `1.0.0`, `[Unreleased]` unpromoted), which fail if the
  release is not withheld. I'll add a one-line comment at each seed saying so, so a later reader doesn't mistake
  the seed for the load-bearing part. I won't change any assertion.
- Prawduct's own `stamp-merged` / `regen-views`. They are upstream and inert.

## Architectural items (for the Architect)

**A1 — Remove outright, or keep a guarded fallback for projects on old prawduct?**
The issue asks to confirm before deleting, because TangleClaw is engine-agnostic and other installs may manage
projects on older prawduct.
*Evidence:* the only writer of `status=merged` left prawduct's flow at v2.3.2 and was emptied by v3.3.0, and zero of
the 24 local prawduct projects carries a live tag line. A project that still had one would lose nothing it depends
on, because no prawduct version that reads `status=` can still run: the reader (`regen-views`) is the part that was
retired. The flip only mattered to feed that reader.
*Recommendation:* **remove outright.** Keeping it means keeping ~65 lines and 10 tests for a state that no supported
prawduct reads, plus a statusless counter that now misreports healthy entries.

**A2 — Remove the `statusless` count along with the flip?**
It rides in the same helper. Its premise ("statusless = missed merge stamp") is inverted by current prawduct.
*Recommendation:* **remove.** If a release-pending count is wanted in the wrap output, it should be a separate,
correctly named feature built on prawduct's `release_readiness`, not this counter kept alive.

**A3 — CHANGELOG subsection: `### Internal` (patch) or `### Removed` (minor)?**
The removed behaviour cannot fire on any project this host manages. The "Stamped N" commit line and the "stamped N
shipped" detail suffix have not appeared since the ledger went statusless. The one visible change is that the
step output drops `changeLog: {flipped: 0, statusless: N}`, and no UI reads it (`public/` has no reference).
*Recommendation:* **`### Internal`**. The operator-notices test ("would an operator notice next session?") answers
no. A `### Removed` entry would bump the minor version for dead-code removal.

## Rulings (Architect, 2026-09-24, Medusa msg 3107ad9a)

**Controlling rationale: ADR 0011 (`docs/adr/0011-prawduct-boundary.md`).** Decision 3 lists `.prawduct/` in the seam
as "plugin-owned state TangleClaw reads at agreed paths and never authors". The standing constraints say it
outright: "No TangleClaw code may write inside `.prawduct/`." The WRP-9F2K flip stages a rewrite of
`.prawduct/change-log.md`, so it is a TangleClaw write inside `.prawduct/`: an ADR 0011 violation that predates this
issue. Removing it restores conformance and needs no ADR amendment. The 24-project census and the prawduct
version history above are supporting evidence only. **The deletion rests on the ADR, not on the absence of
input.** A project that did still carry `status=merged` lines would not change the answer.

- **A1: APPROVED.** Remove the flip outright. A fallback for older prawduct would keep the prohibited seam alive,
  and it would not be valid compatibility.
- **A2: APPROVED.** Remove `statusless` together with `output.changeLog` / `output.changeLogWarning`. Its meaning is
  inverted and no consumer exists.
- **A3: APPROVED.** CHANGELOG `### Internal` (patch). The change removes dead bookkeeping that conflicts with the
  ADR, plus undocumented internal output. No supported behavior an operator can see changes.

Implications for the build:
- The regression test (scope item 4) pins the ADR constraint, not only the WRP-9F2K removal. Its title and comment
  cite ADR 0011: "version-bump never writes inside `.prawduct/`".
- The CHANGELOG `### Internal` entry names the ADR 0011 conformance as the *why*.
- The gates for implementation, Critic, review, CI, PR and merge are unchanged. The PM's go is still needed to
  build, and merging stays outside the pilot envelope.

## Risks

- **Out-of-tree consumers of `output.changeLog`.** `git grep` over `lib/ public/ server.js test/ docs/` finds no
  reader other than the tests being deleted. Wrap step output is persisted in wrap run history, but only as
  display data, and older runs keep whatever they recorded.
- **Line-number drift.** The test block's bounds are pinned to `7aa12e05`. Re-locate the block by its `describe`
  title at build time rather than by line numbers.

## Verification plan

- Focused: `node --test test/wrap-pipeline.test.js test/version-bump-release-gate.test.js
  test/wrap-methodology-authority.test.js`
- Full suite in this checkout (`npm test`), never against the main instance.
- `git grep -n -e _flipMergedTagLines -e _stagePrawductChangeLogStamp -e prawduct-change-log -e changeLogFlipped`
  should return only the new regression test's negative assertions.
- Critic (cumulative) before the Draft PR.
