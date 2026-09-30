# Change Log — TangleClaw

<!-- Append new entries at the top.

Tag-line conventions (ART-4K9M, ratified 2026-07-17):
- scope=  : ONE scope per unit of work. Work done under an ACTIVE build plan uses that
  plan's frontmatter scope (its ## Status roster derives checkbox flips from these tags).
  Post-plan work — backlog items, GH-issue fixes, chores landing after the plan is
  archived — gets its OWN scope (kebab-case of the backlog id or issue, e.g. ui-2p7t,
  wrap-583), NEVER a borrowed scope from an archived plan: an archived roster can't track
  new chunk ids, so borrowed tags rot (the ART-4K9M failure). A scope with no build-plan
  file is fine — regen-views flags it only while status=merged, and deliberately not once
  status=shipped (retired/planless scopes are expected history).
- chunks= and status= : **RETIRED upstream (prawduct 3.4.0, `lib/change_log.py`), along with
  the derived views that were their only reader.** Which chunks an entry shipped now belongs in
  the entry BODY, where readers actually look — the 2026-09-06 entries write `Train 13 Chunk NN.`
  as their first line. Historical entries carrying either key still parse (the parser preserves
  unknown keys), so nothing below needs rewriting; the two bullets that follow are kept as the
  record of why they existed and are no longer instructions. Noted 2026-09-06 because this header
  still read as live guidance and produced a `chunks=05` tag line on the Chunk 05 entry before a
  Critic pass caught it.
- status= : (none) on branch → `shipped` stamped at merge (AMENDED 2026-07-17, ratified
  under ART-7W2J/PRW-9K4C: upstream trunk semantics — TC restarts the server onto main
  right after merge, so merged work IS live; the wrap's version number is bookkeeping.
  The prior intermediate `merged` state created a merge→wrap window where prawduct
  3.0.5's fail-closed regen-views flagged every planless small-fix scope fatally).
  The WRP-9F2K release flip stays as a safety net (flips any `merged` stragglers at
  the next wrap promote); a STATUSLESS tag line remains the missed-stamp diagnostic.
  TC skips `release=` tokens — CHANGELOG.md is TC's release-notes surface, not
  prawduct's release-notes.md. regen-views derives build-plan Status checkboxes from
  status=shipped ONLY — the old convention left released work stuck at `merged`, which
  un-ticked genuinely shipped chunks (2026-07-17 back-stamp: 29 entries across
  v4.5.0–v4.19.0).
-->

<!-- Older entries live in .prawduct/change-log-archive/YYYY-MM.md, moved there verbatim by `prawduct-hook archive-change-log`. -->

## 2026-09-30 — #2020: derive DHCP renewal and rebinding times for a Tart lease that omits both

<!-- prawduct: type=fix | scope=2020-dhcp-timing -->

PM dispatch (Route A, operator's blanket approval). The Architect released Builder2 from standby for this chunk only. Branch `fix/2020-dhcp-timing-derivation` from `origin/main` `75c499f1`.

**Why.** Tart's vmnet DHCP server sends a lease with `lease_time` but no `renewal_t1_time_value` or `rebinding_t2_time_value`. The admin verifier required all three, so it could never attest a Tart guest.

**What.**
- `deploy/soak/guest/guest-setup.sh`: when both timers are absent, T1 = floor(lease/2) and T2 = floor(lease*7/8) (RFC 2131 4.4.5). A lease with only one timer is still refused, and the message names which one it reports. The new field `dhcp.timingSource` is `lease` or `derived-rfc2131`. The server identity, start/expiry, strict ordering and remaining-window checks all apply to derived times, unchanged.
- `test/soak-guest.test.js`: explicit timings (`timingSource: 'lease'`); both absent, the Tart shape; rounding down; partial absence refused either way round; missing `lease_time`; leases too short for ordered derived timers; a duplicate `lease_time`; a malformed timer; expiry; and the remaining window.
- Docs: the README explains the derivation and that a derived time is not evidence of renewal. New install-runbook step 12 observes SSH and the address surviving a real renewal on the dry run. Static addressing is the fallback only if that fails. Step 11 now has the host confirm the lease's server before `SOAK_DHCP_SERVER` is exported: no step set it, so setup could not succeed as written.

**Test contract changed, not weakened.** The admin-line `deepEqual` gains `timingSource: 'lease'`. The existing partial-absence test now also requires the refusal to name the timer the lease reports.

## 2026-09-29 — #2020 Chunk 3: fault and browser executors, integrity sampling, evidence bundle, operator runbooks

<!-- prawduct: type=feature | scope=2020-chunk-3 -->

Lease Rule #142 (RM-LEASE TC-RM08 generation 3). PM dispatch `fe7c8a9d`. Branch `feat/2020-chunk3-soak-runbook-executors` from `origin/main` `a5253de6`.

**Why.** The schedule already drew `browser` and `fault` events, but `run` refused them (`NO_EXECUTOR`). Nothing sampled the guest database or the server process, nothing gathered a run into one evidence set, and no procedure installed the pinned candidate in the guest. The Architect ruling on #2020 requires all of it before the dry run.

**What.**
- **3a: local control and faults.** `lib/soak/local.js` admits a schedule with any fault or browser kind only inside the guest: `--no-live-install`, `kern.hv_vmm_present` = 1, a loopback IP `--api`, and an owned `--home` with its `tangleclaw.db`. Otherwise it refuses with `LOCAL_CONTROL_REFUSED` before any load. `lib/soak/faults.js` implements the six faults (the table is in `deploy/soak/README.md`).
- **3b: browser events.** `lib/soak/webdriver.js` is a minimal W3C client, and `lib/soak/browser.js` implements the dashboard load and the terminal attach. The attach is proven by the server's `pty-activity` counter on the same instance.
- **3c: sampling and the bundle.** `lib/soak/integrity.js` backs `soak sample`: database check verdicts, RSS and descriptors, disk, and health. `lib/soak/bundle.js` backs `soak bundle`: copies, a `VACUUM INTO` snapshot checked with `integrity_check`, and a sha256 manifest. Both are admitted by `local.admitGuestReader`.
- **3d: runbooks and docs.** `docs/runbooks/soak-install-the-candidate.md` and `docs/runbooks/soak-run-sample-and-bundle.md`. `deploy/soak/README.md`, CHANGELOG and FEATURES are updated too.

**Decisions.**
- The server restart goes through `POST /api/server/restart`, and is never forced past a wrap.
- The tmux kill targets only the session the harness's own launch named (`=<name>`).
- The ttyd restart reuses `lib/ttyd-watcher.js`'s kickstart form, and refuses outside the destructive phase.
- Disk ballast leaves 2 GiB free, is capped at 64 GiB, and is swept at the start of the next disk fault.
- `lib/soak/` stays self-contained, so the guest's checkout trust check (`lib/soak/*.js`) still covers everything the soak runs. That is why the pidfile is parsed locally.

**Test contract changed, not weakened.** `test/soak-cli.test.js` expected `NO_EXECUTOR` for a full schedule. Every kind now has an executor, and the new guard is what stops a full schedule outside the guest. The test now expects `LOCAL_CONTROL_REFUSED` with no request sent and no log written. A new test pins an executor for every catalogue kind.

**Ruling A1.** The workload user had no GUI login session (it was created with a password nobody keeps). But the product restarts the server and ttyd through launchd `gui/<uid>`. The Architect ruled option A (exchange `mx_2MqeMZK9ZwoqbQr5`):
- a login secret generated inside the guest, never exposed;
- guest-only auto-login;
- `launchctl print` checks of the domain and both labels;
- fail closed otherwise, and no `nohup` fallback;
- auto-login disabled at teardown.

Install runbook steps 8 and 10 carry this, and the run runbook's step 9 carries the teardown. **Still open:** which macOS commands set that password with no command-line argument is not provable from the host. Step 8 marks it for the dry run to prove, with the no-argv constraint written as a stop condition.

**Review.** Cumulative `rev-20260929T232557Z-d0b342f2`: 0 blocking, 4 warnings, 6 notes. The code findings were fixed in `e8b1f356`, and verify-resolutions `rev-20260929T233248Z-a6f74105` confirmed them with 0 new findings. Its observation that the runbook's gap check assumed the default interval was fixed with the ruling edits: the bundle now reports the run's own `intervalMs`.

**Pre-existing test fixed, by PM ruling (1).** The full suite at `07c92aa5` failed one case in `test/soak-guest.test.js`, a file this branch had not touched. Its lease fixture (300 s left) was built when the file loaded, so in a run longer than that the lease had really expired by the time the case ran. It passed when run alone. The fixture is now built when the case runs, and the case's contract is unchanged.

**Verification.** Unit and integration tests use fakes for HTTP, WebDriver, launchctl, tmux and statfs, and a real SQLite database and real files. Nothing was run in a real guest: the runbooks mark those steps unverified until the first dry run.

## 2026-08-20 — #990: forensic review of the ungoverned Antigravity window fixes 8 confirmed bugs

<!-- prawduct: type=bugfix | scope=antigravity-window-990 | chunks=01,02,03,04,05,06,07 -->

A 5-dimension multi-agent adversarially-verified review of commit range `v5.8.0..v5.10.0` — a
window where a different AI engine (Antigravity) committed directly to `main` with no Prawduct
governance active — surfaced 17 raw findings collapsing to ~10 distinct root issues. One
(`startWrapSse` ReferenceError) was already fixed post-v5.10.0 by #1005. This work fixes the rest,
confirmed still live on `main`:

- Shared-doc `fs.watch` handles never re-targeted on a `filePath` edit and leaked on delete — the
  most severe finding, independently corroborated by 4 of 5 review dimensions.
- `codex.json` advertised `capabilities.supportsSilentPrime: true`, but `syncEngineHooks()` clears
  hooks for any non-`claude` engine instead of writing them — not dead code, a live UI lie: an
  operator could enable "Silent Prime" for a Codex project and nothing would happen. Turned off;
  real support filed as backlog ENG-8V3N.
- Multi-file upload had no `FileReader.onerror` — a failed read hung the modal forever.
- CHANGELOG's `## [5.9.0]` "Master Session Recovery" `### Fixed` entry was fabricated (no such fix
  exists anywhere in history) — corrected via an `[Unreleased]` note, without touching the locked
  released section.
- Removed the dead live-wrap-progress SSE subsystem (zero consumers since #1005 removed its only
  client) and deduped shared-doc notify logic between two drifting implementations.

Cumulative Critic review (`rev-20260820T181429Z-411d7e43`): 0 blocking, 2 warning + 2 note, all
fixed and re-verified clean. Full suite: 6508 pass / 0 fail / 1 skipped.

One thing worth naming for the next reader of this repo's history: two of the fixes above exist
*because* re-checking a claim rather than trusting it surfaced something worse than reported — the
Codex "dead code" finding turned out to be a live capability lie, and a shipped commit's own
message ("Added Next Action preview") didn't match what the diff actually built (documented
honestly in `FEATURES.md` rather than propagated).

<!-- prawduct: type=bugfix | scope=master-level-takes-effect-968 | chunks=01,02 -->

The first real use of #755 found it: the toggle moved, the guard permitted the write, and the Master
refused anyway. It was refusing itself — the change path refreshed the guard and not the identity, so
the Master read `read-only` from month-old instructions and never attempted the write the guard was
waiting to allow.

Three things generalise:

- **"One call site is not the family" applies to ARTIFACTS, not just code sites.** #755 chunk 1 made
  the guard immediate and chunk 2 put the level into the identity; the change path refreshed one of
  the two, and every test in the suite read one of the artifacts that WAS being written. The fix was
  to delete the partial refresher rather than add a third write to it.
- **A detector that fires on the healthy path is worse than no detector.** The first shape of the
  staleness check compared the identity's mtime to the session start — and the identity was rewritten
  unconditionally on every ensure, which both surfaces fire on drawer open. It would have shown
  "restart to apply" permanently, which is the exact permanent nag the ruling behind it rejected.
  Caught by review, not by me. Write-if-changed; the mtime is load-bearing, so not touching it is
  part of the contract.
- **Verify a mechanism before offering it as an option.** The tmux session-start comparison was
  probed before it was put to the operator as a choice, and the probe found more than the bug: the
  live Master had been running a month against instructions rewritten the day before, so *nothing*
  regenerated in that month had reached it.

Also learned: `tmux display-message` does not fail on an absent session — it answers for the attached
client — so an exact-match target cannot protect it and the caller must check existence separately.
The codebase already documented this at one call site; the new one repeated the mistake. It cannot be
held behaviourally in a headless run (no attached client to fall back to), so a source-level guard
holds it, and the guard had to strip comments first because both callers explain the hazard in prose
directly above the check.

**Chunk 2 — Master Kill (also #768 chunk 3).** `POST /api/master/kill` plus the bar's Kill button,
which shipped dim from #768 waiting for this route. It is the remedy chunk 1 makes load-bearing: the
guard binds a level change at once, the running Master does not, so restarting it is what makes it
act. Killing an absent Master is SUCCESS — the operator's intent is "not running" and it already
holds — while a tmux that will not answer refuses, because a kill that could not be confirmed is not
a kill, and `hasSession` would have flattened that wedge into "already stopped" during exactly the
condition where the Master is most likely still running. `kill` leaving `tcMasterPendingReasons` is
the assertion that the pending treatment came off WITH the backend rather than beside it — the same
pattern `access` set in #755.

**Classification:** bugfix
