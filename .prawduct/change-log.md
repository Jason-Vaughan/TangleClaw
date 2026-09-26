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

## 2026-09-26 — Caddy mode moves the tailnet host in two phases, with a strict check and an honest rollback (#1905, Chunk 2)

<!-- prawduct: type=bugfix | scope=1905-magicdns-host-inventory -->

Chunk 2 of `.tangleclaw/plans/1905-magicdns-host-inventory.md`, dispatched by the PM (d4027d15) after PR #1919 merged, the Rule 69 sync ran and health was verified. It is governed by Architect rulings A18 and A21 (addenda 1 and 2), plus the PM's A19 normalization request.

**The change.**
- **Prepare.** `reconcileTailnet: "prepare"` on generate-cert (caddy mode only) mints a transition cert with the old and new names and flips nothing. Caddy-mode `true` names prepare and apply in `next`.
- **Apply.** `ingress-cutover.js --tailnet-host` refuses before any write, using `lib/tailnet-cutover.validateTailnetApply` (invalid, not observed, no change, ungated, cert missing). The Caddyfile site and `caddyTailnetHost` ride one `configPatch`.
- **Verification.** After the reload, `strictHealth` accepts only HTTP 200 with `status: "ok"`, for the local site and for the candidate on 127.0.0.1 with SNI and Host set. The served cert must carry the name.
- **Rollback.** On failure, `rollbackTailnetApply` restores the Caddyfile, the config and the reload. It reports `rolledBack: true` only when all three are proven; anything less is `tailnet-rollback-failed` with `residual` and `recovery`.
- **Normalization.** `removeHosts` and the canonical check compare normalized names.

**Tests.**
- `test/tailnet-cutover.test.js` covers the refusals, strict health, retries, each injected rollback failure, the cutover's args, result fields and ordering, and parity through prepare, apply and rollback.
- `test/api-setup-https.test.js` covers prepare in each mode, the caddy-mode `next`, and normalized conflicts and removals.

**Fixed along the way.** Chunk 1's "removeHosts removes a carried name" test never reached its subject. The mkcert stub writes the same fixture cert every time, so a name added by an earlier request is never actually carried, and the test passed with removal disabled. It is rewritten as a one-request test and now turns red under that mutation.

**Mutations.** Each of these turns its tests red: dropping normalization, dropping the incoming name from prepare, and dropping the removal filter.

**Critic.** Cumulative review `rev-20260926T205207Z-2b1d8491` found 1 blocking issue, 3 warnings and 4 notes.
- Blocking, fixed: the boot drift warning and FEATURES said the caddy-mode flow did not exist. Both now name prepare and apply.
- Fixed: `--tailnet-host` is refused unless the install is already in caddy mode (`tailnet-not-caddy-mode`). Before this, a direct install could cut over and then report a clean rollback while the ingress stayed switched.
- Fixed: `runTailnetVerification` takes injectable `verify`, `execFile` and `configStore`. It is now driven against a temp Caddyfile for success, a rolled-back move, a failed reload and an unhealthy reload, which replaces a parity test that could not fail. Skipping the config restore turns two of those tests red.
- Fixed: `strictHealth` settles on an aborted response.
- Fixed: the verification promise has a `.catch` that still writes a result file.
- Fixed: the wording now says validation runs before the Caddyfile, the config or launchd is touched, since the cert is already staged by then.
- Fixed: the tailnet backup is dropped after a success or a proven rollback, and kept only for recovery.
- Warning (stale test evidence): resolved by recording the suite on the final tree.

## 2026-09-26 — The detected MagicDNS name is served through one host inventory (#1905, Chunk 1)

<!-- prawduct: type=bugfix | scope=1905-magicdns-host-inventory -->

Chunk 1 of `.tangleclaw/plans/1905-magicdns-host-inventory.md`. The PM dispatched it to Builder2 over Medusa (0f830344). It is governed by the Architect's rulings R45/R46, A17–A20 (2f34bdfe) and the approval A21 (43f5f31e). #1905 stays open for Chunk 2 (A21 addendum 4), so this uses `Refs`, not `Fixes`.

**Problem.** The operator links named the host that `tailscale status` reports. The certificate names and the served-Host allowlist read only `caddyTailnetHost`, which is null on a default install. So a browser write to the linked host got `403 HOST_NOT_SERVED`.

**The change.**
- `lib/host-inventory.js` holds one `normalizeHostName` and one overlay-DNS probe with a provider registry. It also holds the process-wide observation (a miss is retried after 60 s) and `resolveTailnetHost` (configured, else detected, with drift and omission reported).
- `certHostUnion`, the allowlist, the operator-link fallback and `mandatoryCertHosts` all read it.
- The trailing dot is stripped from `Host`. The allowlist cache key includes the observed name.
- generate-cert behaviour:
  - It always unions the mandatory names: the mkcert defaults, the mDNS name and the canonical tailnet host.
  - `hosts` now adds names (a ruled contract change, A19). `removeHosts` removes non-canonical names, and a canonical one gets `409 CANONICAL_HOST_REMOVAL`.
  - Direct-mode `reconcileTailnet` checks the gate (`caddy.tailnetSiteGated`, pinned to the generator), then mints both names, then saves the config last.
  - Caddy mode is refused with `RECONCILE_NEEDS_CUTOVER`. The message says the flow is not in this version (A21 addendum 3).

**Tests.** `host-inventory` covers the probe shapes, normalization, resolution, the mandatory set and cross-consumer parity. `api-setup-https` covers:
- the extras contract;
- `removeHosts` and the three canonical-removal conflicts;
- direct-mode reconcile with parity before and after;
- mint failure;
- an injected save failure, after which the old host stays canonical and covered;
- the ungated refusal and the caddy-mode refusal.

`caddy` checks gate agreement across every combination. `server` covers a request under the detected name, with a trailing dot, and under a different tailnet name. Mutations: reverting the union turns the route, invariant and request tests red, and dropping the canonical-removal refusal turns the three conflict tests red.

**Critic.** The cumulative review `rev-20260926T201752Z-cd65bda6` found 0 blocking, 3 warnings and 3 notes.
- Fixed: `resolveOperatorHost()` called with no config now reads the saved config for the tailnet answer (the primer path).
- Fixed: the Train 2 entry, which this entry's first rewrite had deleted, is restored word for word.
- Fixed: the retry's blocking cost is documented.
- Accepted: R-5 (`caddySite` describes the config key) and R-6 (the plan format).
- Verified by `rev-20260926T202127Z-e44e45c7`, with 0 findings.

**Process.** The first version of this chunk used a verbatim `hosts` list and a caddy-mode reconcile that left the Caddyfile "pending". The Architect rejected both (A18/A19) while I kept building past the unread veto. Nothing was pushed. I rewrote the chunk to the approved plan and squashed it into one commit before the review.

## 2026-09-26 — Train 2: malformed project tags, inline-handler encoding, the Not a project mark (#1375, #1384, #1768)

<!-- prawduct: type=bugfix | scope=train-2 -->

Chunks 1–3 of `.tangleclaw/plans/train-2-ui-hardening.md`, dispatched by the ProjectManager over Medusa (de99255a) under Architect clearance R44 (0f8b59dc).

**The change.**
- **Chunk 1 (#1375):** `lib/store.js` `_normalizeTags` gives every consumer `string[]`. A legacy JSON-string row is split on commas, an array keeps its string members, and anything else is empty. `public/ui.js` `formatTagList` checks the shape itself, so the card detail shows None instead of throwing, and the tag filter matches whole tags, not substrings.
- **Chunk 2 (#1384):** `public/landing.js` `jsArg(value)` = `esc(JSON.stringify(value))` is the one encoder for inline-handler arguments. All 34 single-quoted handler sites in `ui.js` use it, and `importLeaseProjects` receives its names array directly. A scan test keeps the single-quote form out of `ui.js`; a mutation check flags 34 offenders on main.
- **Chunk 3 (#1768):** the ports panel badges an owner group whose leases are `external` and offers **Is a project**, which posts `ownerKind: 'project'` for the name, then reloads the ports and re-checks the import banner. The button stops click and keydown. [DECISION] The badge and undo are per owner name, not per lease; the reasoning is in the plan.
- **Tests:** `test/project-tags-shape.test.js`, `test/inline-handler-args.test.js` and `test/port-owner-kind-panel.test.js` are new. Six existing harnesses now load the real `jsArg`/`formatTagList`, and three assertions that matched the rendered handler text follow the new encoding. None were weakened.

**Reviews.** Chunk reviews found 0 blocking. The cumulative review rev-20260926T171739Z-91357fff found one blocking finding: the saved suite evidence includes the known `test/dir-scanner.test.js` 300ms deadline failure (#1884, red on a clean main on this host), accepted by the PM's owner ruling (c06c9eb8).

**Follow-ups filed:** #1902 (the same apostrophe bug in other page scripts), #1903 (test-helper consolidation), #1906 (buttons nested in role=button rows).
## 2026-09-26 — install.sh refuses on a caddy-mode host before anything is changed (#1900)

<!-- prawduct: type=bugfix | scope=install-1900 -->

The PM dispatched this over Medusa (289a9266) under Architect ruling R43. Plan: `.tangleclaw/plans/1900-install-caddy-refusal.md`.

**Problem.** `deploy/install.sh` always wrote the direct-mode ttyd plist (TCP 3100) and reloaded launchd. On a host whose persisted `ingressMode` is `caddy`, the server expects ttyd on a Unix socket, so the dashboard answered 502. The script did read the mode, but only after the restart, and only to print advice.

**The change.**
- A guard runs right after the Node.js check, before any dependency install, runtime build, plist write or launchctl call.
- On `caddy` it refuses. It names `ingress-cutover.js --to caddy`, which re-applies the ttyd and Caddy plists, and `--to direct`, which switches the host.
- A config that cannot be read or parsed also refuses, because the server cannot load that file either. A missing config, or one without the key, is direct mode.
- The post-restart detection and its now-unreachable caddy closing branch are removed.
- The README update steps branch by mode. The configuration reference, the rollout runbook and FEATURES say the installer enforces this.

**Decision (PM-ratified, e4c76eab).** Selecting direct means running `ingress-cutover.js --to direct`, the only writer of `ingressMode`. install.sh gets no override flag, because one would reinstall the outage.

**Tests.** `test/install-sh.test.js` › "ingress-mode guard (#1900, executed)" runs the real script in a sandbox, with stubbed brew, curl and launchctl.
- Caddy mode and an unparseable config leave HOME byte-identical, call no stub, and name the repair.
- Direct, key absent, and no config all get past the guard.
- Interlocks pin the guard ahead of every mutation, and pin the brew stop ahead of the real runtime build.

**Critic.** `rev-20260926T164727Z-856105c8` found 0 blocking, 3 warnings and 1 note. All four were fixed in 99f89ecf and verified by `rev-20260926T165841Z-edb10e1d`, and both of its observations were accepted.

**Filed.** #1901: a caddy-mode host has no supported refresh for the server plist, `~/.tmux.conf` or dependencies.

**Suite.** Two full runs each failed only the known load flake in `test/dir-scanner.test.js` (#1884/#1658) while another session's suite ran alongside. That test passes 3/3 in isolation on this tree and on base. Recorded `--degraded`.
## 2026-09-26 — A stranded wake nudge no longer blocks its own recovery (#1621)

<!-- prawduct: type=bugfix | scope=1621-stranded-wake-nudge -->

The single chunk of `.tangleclaw/plans/1621-stranded-wake-nudge.md`. The PM dispatched it to Builder2 over Medusa (73798d5f) and approved the fix scope (081f2259).

**Problem.** A nudge whose Enter is lost stays unsubmitted in the composer. #1839's receipt check records it as not accepted and the watchdog re-arms the wake, but the draft gate read the stranded nudge as operator input. So it refused the re-arm, and every later wake, until the exchange escalated.

**The change.**
- `medusa-wake.isOwnNudge` recognises a composer holding only a switchboard nudge and its wake ref. The pattern is derived from `_nudgeLineFor` + `withNonce`, and every slot is pinned. `_assessPane` treats such a composer as `at-prompt`, but only when its lower border was seen, and it checks before both refusal branches, because a wrapped nudge leaves the cursor on a continuation row, where the gate would otherwise say `no-prompt`.
- `tmux._clearPromptLine` clears a stranded nudge without filing it in the draft store. It then re-reads the composer, and `sendKeys` refuses to paste after anything left behind.
- Docs: `docs/medusa-delivery.md` "Wakes and re-arms" and CHANGELOG `### Fixed`, which also amends #1839's "still waits for a clear composer" sentence.

**Not done.** The reason the Enter is lost at all is not established. Whether one `C-u` clears a wrapped nudge was not checked on a live Claude pane; the re-read guard makes a partial clear fail as `inject-failed`.

## 2026-09-26 — Opt-in provenance line on TangleClaw's private generated files (#1885, #1888)

<!-- prawduct: type=feature | scope=1885-provenance-watermarks -->

Chunks 01–03 (TangleClaw-Pilot-B2). The plan is `.tangleclaw/plans/1885-provenance-watermarks.md`. Architect ruling R25 and ADR 0019 (`docs/adr/0019-generated-file-provenance.md`) govern it.

**The problem.** Across many projects and instances, nothing said which TangleClaw project generated a given file.

**The change.**
- **`lib/provenance.js`, one leaf module and one writer.**
  - A frozen registry is keyed by an explicit `surfaceId` each writer passes. It names five private surfaces: `session-prime`, `session-reentry`, `ui-wrap-advisory`, and `codex-config` and `aider-config` while git ignores them.
  - The template is bounded, and substituted values are neutralized. A line that would still contain an ownership marker renders as the fixed `Built by TangleClaw`, so a provenance line can never grant overwrite permission.
  - `applyProvenance` is pure and idempotent. `writeOwnedFile` writes atomically by default, and in place for the carriers, which keeps the file's mode and symlink.
- **Per-project `provenanceWatermark`, default null, which means off.** A bounded validator row. A blank template resets to the default. There is no global key and no `tc` mutation verb.
- **Carriers.** The #1619 committed-carrier predicate decides both insertion and removal. Drift is judged without the provenance line.
- **#1888, a live bug fixed here.** The prime was budgeted as the SessionStart hook's only output, so the whole hook output could pass the engine's 10k cap and be cut to a preview. `lib/prime-hook-output.js` now owns the composition and reserves the companions' worst case. A parity test runs the real hook script.
- **Operator and agent surfaces.** A Project Settings toggle, line field and preview. The save sends only the changed half (`tcProvenancePatch`). A read-only `provenance-watermark` row in `tc capabilities` names surfaces by id, never by path.

**Verification.** Each chunk had a cumulative Critic plus verify-resolutions; the last pair is rev-20260926T032840Z-d99ab744, then rev-20260926T033429Z-61386ed9, which was clean. The suite is green at 614f0e17. End-to-end checks ran against scratch projects: with the setting off, every generated file is byte-identical to `main`.
## 2026-09-26 — Restart Session on the ended bar after a completed wrap (#1637)

<!-- prawduct: type=feature | scope=1637-restart-session -->

Chunks 01 and 02 of `.tangleclaw/plans/1637-restart-session.md`, under Architect ruling R26. The PM dispatched both chunks over Medusa (fb7882f1, 343a758e) and approved the eligible-no-redirect decision (67e3a1f8).

**Problem.** After a wrap ended the session, relaunching the same project meant going back to the landing page, clicking the project and passing the launch dialogs again. A context refresh is the most common reason to wrap, so this was the common case.

**The change.**
- **`public/session-relaunch.js`** is DOM-free and exported as `window.tcSessionRelaunch`.
  - It offers the button only when `active === false`, no wrap is running, the session is tracked, and the newest session row is `wrapped`.
  - The launch body is `{continuityMode: 'continue'}` alone, so the server applies the project's defaults.
  - Refusals fall into four classes: retryable, needs-landing, liveness-unknown and uncertain.
  - A controller latches before it sends, and an uncertain outcome is settled by a status read, never a second POST.
- **Page wiring:**
  - `applyRelaunchEligibility` is shared by both ended-bar painters. `handleSessionEnded` decides from its payload. `handleWrapCompleted` makes one status read, and a failed read hides the button.
  - An eligible end suppresses the 10 s redirect.
  - The launch POST is bounded at 60 s and a timeout goes to reconcile.
  - `#relaunchStatus` is a polite live region.
  - When the only way forward is the landing page, focus moves to Back to Projects.
- **`sw.js`** serves the module network-first, in lockstep with `session.js`, and precaches it.
- **Docs:** ADR 0002 "Amended 2026-09-26", the user guide, FEATURES and CHANGELOG. The server and its routes are unchanged.

**Review.**
- Chunk 01 Critic rev-20260926T040831Z-cf8f4842: 0 blocking. Its R-5 (no launch timeout) was built in chunk 02.
- Cumulative Critic rev-20260926T042927Z-787c1eed: its one blocker was saved test evidence carrying the #1884 dir-scanner flake. A clean full run replaced it, and verify-resolutions rev-20260926T043459Z-f0760bdd confirmed.

## 2026-09-26 — ADR 0018 §4 states the mode-aware repair; backup ref deleted (#1245, Architect R41/R42)

<!-- prawduct: type=docs | scope=ttyd-1245 -->

- **R41:** ADR 0018 §4 said the cutover directs the operator to "rerun the installer", which is wrong on a caddy-mode
  host (install.sh rewrites the ttyd plist for direct mode). The Architect ruled a narrow correction to the implemented
  `SELECT_BY_MODE` contract: `provision` first, then `deploy/install.sh` (direct) or the cutover (caddy). The ADR now
  says that, with a dated correction note. It is a normative-doc change that matches existing, reviewed code.
- **R42:** the local-only `backup/1245-pre-r39-redaction` ref (the pre-rewrite head, 2fe1c50d, holding the unredacted
  run5 evidence) is deleted before any push. `git for-each-ref --contains` confirms no local ref still reaches the
  pre-rewrite commits. No object-store purge is required.

## 2026-09-26 — Close the two blockers verify-resolutions left open (#1245)

<!-- prawduct: type=fix | scope=ttyd-1245 -->

`verify-resolutions` rev-20260926T152837Z-80909b30 on ede42d18 found prior R-2 and R-7 not fully closed.

- **R-1 (prior R-2), the real leak path:** `defaultDeps().build` gains an optional `script` (build-ttyd.js by default).
  A new test runs the DEFAULT build in a child process with a stand-in builder that prints to stdout, and asserts
  that nothing reaches the child's stdout. Mutation-checked: `stdio: ['ignore', 'inherit', 2]` fails it.
- **R-2 (prior R-7), the class, not the site:** one exported `SELECT_BY_MODE` text (direct: install.sh; caddy: the
  cutover; never install.sh on caddy) is used by REPAIR and by the CLI's `install` and `rollback` output. Rollback
  also names the kickstart when the plist already runs the owned path. A test pins every site to the constant.
- O-1, O-2 and O-3 are ACCEPTed, reasons recorded. O-2 (ADR 0018 §4's "rerun the installer") is the Architect's to
  decide.

## 2026-09-26 — Resolve cumulative review rev-20260926T150050Z-6620a07c; redact the run5 evidence from history (#1245)

<!-- prawduct: type=fix | scope=ttyd-1245 -->

The cumulative review of 2fe1c50d found 0 blocking, 6 warnings and 5 notes. Architect R39 and R40 (recorded in the
plan) ruled on R-8 and R-7.

- **R-8 (R39):** the local branch history was rewritten before any push. In the run5 pre-cleanup and post-cleanup
  snapshots, every lsof line of the unrelated `agy` process keeps its first five columns, and the rest is replaced by
  a stable marker, so its LAN and IPv6 addresses and its oauth-token and conversation paths are gone.
  - `git filter-branch --index-filter` rewrote 310dfbc3..HEAD. Only the 5 commits from 626280ec onward changed. The
    tree diff against the backup is exactly those two files.
  - A scan of every commit in the range (trees, added lines, messages) finds none of the values.
  - The pre-rewrite head survives only as the local ref `backup/1245-pre-r39-redaction`, which is never pushed.
- **R-1:** the last known good and the set-aside copy are written to a `.tmp` name and renamed into place
  (`_copyPairAside`), never overwritten in place. Tests: the inode changes on replacement. The pinned boundary lists
  gain the temp-and-rename steps, and the recovery invariant holds at each of them. Both guards were mutation-checked.
- **R-9:** the refusal text is mode-aware. It leads with `provision`, then names `./deploy/install.sh` for direct mode
  and the cutover for caddy mode, and never install.sh on a caddy host. The by-hand route stays. My chunk 08 test
  pinned the old "Re-run deploy/install.sh" text; it now pins `REPAIR` itself, and a new test pins the mode split.
  The configuration reference, the user guide, the CHANGELOG and FEATURES are corrected.
  - Unchanged, and the Architect's to decide: ADR 0018 §4's own wording, "directing the operator to rerun the
    installer".
- **R-4:** `readPinnedInputs` reads inputs.json once and hashes exactly those bytes. The resolver's `expectedInputs`
  and build-ttyd (its new `manifestInputs`) share it.
  - Changed test contract: the source-regex test "build-ttyd records the same digest the resolver compares" is
    REPLACED by three behavioural tests. They check the helper's digest of the parsed bytes, that a build records the
    digest it read even when the file changes afterwards, and that a builder-shaped manifest is current for the
    resolver.
- **R-2:** four CLI tests pin that `provision` prints only the bare path on stdout (when it builds, when the runtime is
  already current, and under the Homebrew rollback), and nothing when it refuses. Mutation-checked.
- **R-5:** `takeReading` and `_measure` no longer take `opts`. They always read the configured label and threshold,
  and no production caller passed any.
- **R-3:** the guarantee wording no longer overclaims, in the lib header, `_recoverably`'s message, the configuration
  reference and the CHANGELOG. A last known good that verified before the failure still verifies; with none,
  `provision` rebuilds.
- **R-7 (R40):** the rollout runbook's checkpoint runs on the first switch AND after every rebuild. It records the
  sha256 and the `codesign -dv` identity, and adds a live `ls` access check under `~/Documents` that STOPS on
  denial. The rollback runbook repeats the checkpoint and the check for the restored binary (steps 2a and 7).
- **R-11:** the plan's Verify line says the PR uses `Refs #1245`, not `Fixes`. R-6 and R-10 are ACCEPTed through
  `prawduct-hook disposition`.
- **Review of the rewritten head, rev-20260926T151846Z-e094065e:** `verify-resolutions` could not anchor to the
  rewritten-away 2fe1c50d, so it fell back to a cumulative review of the committed head, WITHOUT this batch. Its
  blocking R-2 and R-7 are the prior R-2 and R-9, fixed here. It also raised three items, fixed in the same commit:
  - R-5: tests pin the cutover's `ttydRuntime` result key (and null before a runtime resolves) and
    `describeTtydRuntime`.
  - R-6/R-9: when the install of a verified build fails, `provisionRuntime` keeps the stage, names it, and gives the
    `install --from <stage>` command instead of "re-run provision". A new test covers this.
  - R-8: the `_isExiting` docstring no longer claims that the harness's and the watcher's wedge counts match. They
    share the predicate, not the wedge age.

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
