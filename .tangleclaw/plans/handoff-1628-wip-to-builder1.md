# Handoff — #1628 WIP, Builder2 → Builder1

**Status: WIP CHECKPOINT. EXPLICITLY NOT APPROVED FOR MERGE.**
The acting PM (Architect) has not approved this code. Do not push, do not open a
PR, do not merge, do not deploy. It is handed over so the work survives the
transfer, not because it is finished.

## Exact state

| Fact | Value |
|---|---|
| Branch | `fix/1628-status-row-provenance` |
| **WIP HEAD (full SHA)** | `a7a8efc76315873f6887d6c5e8668dc104617762` |
| Prior commit (preserved, do not squash away) | `c2c66c7f0cbcbbe1ae599d7f00488c02f05f2908` |
| Base | `203120a125d37e73336adf9ddc4a0720b00544df` (`origin/main` at branch time) |
| Working tree | **clean** — 0 modified, 0 untracked, everything is in the two commits |
| Pushed? | **No.** Local to the Builder2 checkout only |
| PR? | None |

`c2c66c7` is the pre-review version and **still contains all three Architect
blockers**. Only `a7a8efc` fixes them. If anyone inspects this work, inspect
`a7a8efc` — inspecting `c2c66c7` is what produced the earlier "not fixed"
finding, correctly.

## How to obtain it WITHOUT pushing or touching the Builder2 checkout

A git bundle is written beside this file:

```
/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.tangleclaw/reference/1628-probes/fix-1628-status-row-provenance.bundle
```

From an isolated worktree elsewhere:

```sh
git bundle verify <path-to>/fix-1628-status-row-provenance.bundle
git fetch <path-to>/fix-1628-status-row-provenance.bundle \
  fix/1628-status-row-provenance:fix/1628-status-row-provenance
git switch fix/1628-status-row-provenance   # expect HEAD a7a8efc7631587...
```

The bundle carries both commits and their base, so it needs no network and no
write to this checkout. Its checksum is in `MANIFEST.sha256` beside it.

## What the change does

Readiness for an engine declaring `idleMarkerRow` is read from the **status
row** — the capture's last non-empty line — instead of `includes()` over the
whole pane. One exported `readReadiness(lines, profile)` owns the choice, so the
wake monitor and the launch readiness gate cannot disagree.

Rules, in evaluation order, all fail-closed:

1. no row → `status-row-unavailable`
2. row ends `U+2026` → `status-row-truncated` — **decisive, read before any
   token**, because dropped segments mean nothing visible proves the run-state
   rendered
3. any `busyStates` segment → `not-at-rest` — **busy before idle**
4. more than one segment equal to the marker → `status-row-ambiguous`
5. exactly one → at rest
6. otherwise → `status-row-no-state`

Segments are split on the measured `statusRowSeparator` (`" · "`, U+0020 U+00B7
U+0020) and matched **whole**, so a sentence ending in the word is not a state.
`idleMarkerRow` without that separator is refused at the read — without it the
match silently degrades to the token match that was broken.

Opt-in per engine: claude and antigravity keep the whole-pane reading they were
measured against, pinned by tests.

## Residual limit — READ THIS BEFORE CLAIMING #1628 IS FIXED

Text alone cannot establish which segment is the run-state. An **untruncated**
row carrying a segment that is exactly `Ready`, in a status line where the
run-state is **not configured at all**, is indistinguishable from the real
thing. Truncation catches the clipped case; ambiguity catches the two-candidate
case; this one has nothing to key on. No regex closes it.

It is pinned as a named test that fails if someone closes it
(`test/medusa-wake-status-row.test.js`, the `KNOWN LIMIT` case) and stated in
`a7a8efc`'s commit message. The two real exits, both the Architect's to rule on:
a constrained layout where the run-state is known to render, or a structured
signal that is not scraped from a terminal (codex ships an app-server; its
binary carries `remoteControl/status` — **not investigated**, named only).

## Test results — real, not asserted

Full suite at `a7a8efc`: **11623 tests, 11622 pass, 0 fail, 1 skipped, exit 0.**
JUnit report has **0** `<failure>` elements. Evidence recorded 2026-09-19T05:25Z,
which post-dates every test in this change.

Earlier in the session one intermediate run was reported as passing when it had
been piped through `tail`, so the exit code observed was `tail`'s. That run
actually had 3 failures; all were chased. Every number above comes from an
unpiped run with a real exit code.

## Evidence files

`/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.tangleclaw/reference/1628-probes/`

| File | What it is |
|---|---|
| `EVIDENCE-1628.md` | the full diagnosis, including the retraction of the version-attribution claim |
| `probe1-idle.txt` | `status_line=["run-state"]` at rest — `  Ready`, no separators |
| `probe2-final.txt` | three-segment layout — `  Ready · Ask for approval` |
| `probe3-after.txt` | the compact layout verified live after the picker |
| `arch-pane-raw.txt`, `arch-samples.json` | the clipped operator pane, 10 at-rest samples, marker absent 10/10 |
| `ledger-rows.txt` | wake ledger rows for sessions 1041-1044 |
| `junit4.xml` | the JUnit report behind the numbers above |
| `MANIFEST.sha256` | sha256 for every file here |

**These are gitignored** (`.prawduct/*` and `.tangleclaw/*` except `plans/`), so
they exist only in this checkout and in the archive. The build plan at
`.prawduct/artifacts/build-plan-1628-status-row-provenance.md` is likewise local.

## Outstanding

- **Architect re-review of `a7a8efc`** — the three blockers are fixed and verified
  at that SHA, but the Architect has not signed off.
- **Restore-live needs BOTH steps, in order**, and re-sync alone does nothing:
  (a) make the run-state visible on the operator's pane (the `/statusline`
  picker, which **rewrites `~/.codex/config.toml`** — measured, it is a real
  persisted config change); (b) re-sync `data/engines/codex.json` into
  `~/.tangleclaw/engines/`, because the runtime reads there and not from the repo.
  Note the compact layout `[model-with-reasoning, run-state, approval-mode]`
  renders `… · Ready · …`, which the *old* installed matcher also accepts — so
  (a) alone restores a working wake without (b).

## Holds still in force

No push, no PR, no merge, no deploy, no publication. No engine-profile sync. No
active-pane injection. `#1635` implementation, `#1626`, rollout and Train 21 all
held. Only the Architect lifts these.

## Open advisories nobody has actioned

structural-coverage (DISCOVERY NOT CAPTURED), external-backlog-detected
(`ROADMAP.md`), oversized-change-log (789KB vs 40KB). All three relayed to the
operator, none answered.

## Repo hazard worth fixing at fleet level

`.prawduct/*` is gitignored with three negations, so a second checkout starts
bare. It bit twice this session: `project-state.yaml` was absent (the backlog
read as unmigrated and re-proposed a migration that had already happened), and
`project-preferences.md` exists only in the primary checkout — so this session
had to read the *other* clone to learn that merges here are squash.
