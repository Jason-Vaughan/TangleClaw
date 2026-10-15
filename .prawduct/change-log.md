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

## 2026-10-14 — #1380/#2142: a read-only host check says what this machine's names, Caddyfile, certificates and trust actually are

<!-- prawduct: type=feature | scope=host-migration-check-1380 -->

#1380/#2142 chunk H, of two (H, then G, the migration guide). Branch `feat/1380-host-check`, from `origin/main` `29e97d73`. The contract is the host-migration packet's chunk H (`/Users/jasonvaughan/Documents/Projects/TC-Lane-A/.tangleclaw/plans/host-migration-followups-packet.md` §1), as corrected by the Architect's A11 and accepted in A12.

**Why.** After a host migration nothing reports the host's actual ingress facts side by side: the tailnet name, the configured names, which Caddy site answers which name, whether each site's own certificate carries it, which serve routes exist, and whether the local root is trusted. Operators found the gaps one broken link at a time.

**What changed.**

- `scripts/host-check.js` (new): `node scripts/host-check.js [--reveal]`. A standalone process, so it works right after a deploy with no restart.
- `lib/host-check.js` (new): ten rows (tailnet identity, configured names, Caddyfile sites, certificates, advisory proposed names, per-site coverage, serve routes against PortHub leases, local trust, local-only resolution, the transaction journal). Each row is `ok`, `drift`, `ambiguous`, `observed` or `unknown` with a reason. Exit 0, 3 (drift/ambiguous), 4 (unknown), 2 (usage).
- Read-only by construction: three allow-listed commands through `execFile` with no shell; one loopback GET of `/api/ports` with no credentials and no redirects; `config.json` read directly, never through the store. Bounded: 5 s and 1 MiB per command, 20 s per run, file size caps, at most 64 names (more → `names` unknown, non-zero exit).
- Redacted by default with stable tokens; `--reveal` adds a PRIVATE banner and still never shows credentials, `basic_auth` hashes, key bytes or query strings, because they are never collected.
- The journal row reads "journal inspection unsupported in this version; not checked": it claims nothing it did not look at.
- Over HTTPS the `/api/ports` read keeps TLS verification. A certificate that cannot be verified for 127.0.0.1 makes the row `unknown` (`tls-unverified`), with no insecure retry and no lease data. The port comes from the installed server's launchd plist, then config.
- These follow the Architect's ruling A15 on five choices made while building. (1) Journal wording; (2) an undeclared tailnet name with no Caddy site is `observed`, and nothing else is claimed to answer it; (3) synthetic PEM certificates inside JSON; (4) logs silenced only inside the standalone script; (5) TLS verification kept, so the row is `unknown` instead.

**Tests.** `test/host-check.test.js` with synthetic fixtures under `test/fixtures/host-check/` (Tailscale field names checked against a live `tailscale` 1.102.3, keys only). T-H0 runs the real script under a preloaded spy (`spy-preload.js`) and asserts no file write, no database open, no `store.init` or file logging, only allow-listed commands, one credential-free loopback request, and no key file read. T-H1 to T-H7 cover every state and reason, per-site coverage, redaction both ways, leases, trust, the budget and the three A12 carry-ins. The certificates are kept as PEM text inside `certs.json`, because `.gitignore` excludes `*.pem` and `*.crt`; their signing keys were discarded.

## 2026-10-14 — #2403: the Master's bridge credential is reconciled before boot can create a Master

<!-- prawduct: type=bugfix | scope=master-boot-credential-order-2403 -->

#2403, one chunk. Branch `fix/2403-master-boot-credential-order`, from `origin/main` `add3a9ea`, on the PM's dispatch and the Architect's approval with corrections.

**Why.** At boot the Master auto-start ran before `listen`. It minted a pending credential and handed it to the pane in the background. Then the server reconciled the previous process's credentials in `onListening`, which revokes every pending row. That included the auto-started Master's own credential while it was mid-handoff. The Master ran, and every bridge call it made was refused with `BRIDGE_CREDENTIAL_REQUIRED`.

**What changed.**

- `lib/master.js`: `bootMaster()` runs the reconciliation, unconditionally, and then the auto-start if it is on. It is never fatal. A failed reconciliation is logged, reported as `error` on its result, and auto-start still runs: minting supersedes every live row in one transaction.
- `server.js`: the auto-start block is one call to `bootMaster()`, still before `listen`. The reconciliation in `onListening` is deleted. Every other way to create a Master is a request or the gateway's pass, and neither starts before `listen`.
- `docs/operator-bridge.md`: says when the boot check runs.
- Revocation semantics in `bridge-principal` and `bridge-store` are unchanged.

**Tests.** `test/master-boot-order.test.js` drives `bootMaster` with the real store and FIFO handoff:
- The pane reads only after boot returns. The old order is kept as a failing negative control.
- Cases: prior pending, active survivor (and tmux silent), a Master that did not survive, auto-start off, a handoff never taken (read through `settled()`), superseded, a failed reconciliation, a throwing launch.
- Two structural guards pin the callers that can create a Master and `server.js`'s placement. They pin positions in source, not run-time order.
- Swapping the order inside `bootMaster` turns 6 of the 13 red.
- `test/master.test.js`: the auto-start pin matched the old inline block's source text. Its contract (boot honours `autoStart`, and a throwing launch is never fatal) moved with the code into `bootMaster`. The test now exercises `bootMaster` and pins that `server.js` calls it, so the guarantee is the same and the check is stronger.

## 2026-10-12 — #2229: the launch-isolation override's two switches, the way to them from a refused launch, and the line for a session running under one

<!-- prawduct: type=feature | scope=codex-override-2229 -->

#2229 Chunk 02, the issue's last: the override on screen. Branch `feat/2229-02-override-screens`, from `origin/main` `78b13a7e`, with `main` at `c7251728` (chunk 01c) merged in before the guides and this entry, on the Integrator's word.

Visual change: yes. Two new switches, one button on a launch-failed message, one new line in Launch readiness.

**Why.** Chunks 01a to 01c built the override, its launch path and `tc`'s wording, and left it settable only through its routes. Nothing on the dashboard offered it, and a refused launch named a setting the operator had no way to reach.

**What changed.**

- `public/ui.js`, Global Settings, "Launch isolation override": the install-wide switch. It says it covers every project and the Project Master.
- `public/ui.js`, a project's Settings, "Launch isolation override": that project's switch. It says when the install-wide override already covers the project, whatever the switch reads.
- Both switches read `GET /api/launch/isolation-overrides` and write its `PUT` and `DELETE` routes through the page's `api()`, with no body, and never a settings route. Each shows what the server answered and is read again after every change, the refused ones included. Settings that were not read are said to be unread, never shown as off. A page the server does not take as the operator's is told so and offered nothing.
- Both carry the sentence each overridden launch's record carries. The screen holds its own copy (the override routes do not send it) and a test holds it equal to `sessions.ISOLATION_OVERRIDE_RISK`.
- Turning one on where no login is in force: the server answers `403 LOGIN_GATE_REQUIRED`, and the switch stays off and says a login must be in force. The switch is still offered there, with a hint that says so before the click, because turning one off works without a login.
- `public/landing.js`: a launch refused as `version_unknown` or `version_unverified` carries one button, "Open launch isolation settings", which opens the project's Settings with the switch in view and focused. A page that would not be offered the switch (signed out while a login is in force) is told who can instead. No other refusal carries it.
- `public/ui.js`, Launch readiness: one line for the project's running session, read from `GET /api/launch/isolation`: "running under the operator's launch isolation override" with the version read and the refusal set aside, or "override unproved" with the server's reason. Nothing for any other row, and no session is called isolated.
- `public/style.css`: the switch keeps its checkbox in the tab order under the house toggle's look (the existing settings toggles hide theirs), with a focus ring; the button on the message.
- Docs: `docs/user-guide.md` (where the switches and the button are; the readiness line), `docs/engine-guide.md` (the same, under "The operator's override"). In `docs/user-guide.md` the sentence that told the reader a second time to skip Codex's update prompt is removed (a note from the review of #2377).

**Limits.** The line is about a running session only: a launch that has ended has no row in the inventory and no line. Its own six-second timer removes the button, or using it removes it sooner; an earlier toast timer can hide the message first, leaving its button focusable off screen until that six-second timer fires (#2339). The switch is reachable from the project's Settings at any time. The session page's relaunch refusal has no button: that page has no way into the dashboard's Project Settings, and the refusal's own text names the override. A session's own page and the Project Master's settings are offered no switch.

**Tests.** New `test/launch-isolation-override-ui.test.js`, run against the shipped functions lifted from `public/`: what each switch says; who is offered it (signed in, no login, signed out, not the operator's page, settings unread); what each answer to a change is told; the request each switch sends and the re-read after it; the refusal's button for the two version refusals and no other; the wiring into both modals; no switch on the session page. `test/launch-readiness-panel.test.js`: the line for a marked row, an unproved row, every other row, another project's row, the Project Master's, and a failed read.

**Browser check.** Done on `2c088fee`, 22:33 to 22:45 PDT on 2026-10-12, by an automated browser run; not yet seen by the Operator. Two scratch servers (no login; a login in force), desktop, 375 and 320. The refused launch's button was read again on `f7c3974a` (22:55 to 22:57 PDT, automated, one scratch server, no login); the switches and the panel line were not read again. Not covered: a real phone, a screen reader, the button reached inside six seconds by a person, the signed-out and not-the-operator wording on screen.

## 2026-10-12 — #2229: `tc` names a session running under the operator's override, and stops advising a relaunch that would change nothing

<!-- prawduct: type=feature | scope=2229-01c-tc-override-wording -->

#2229 Chunk 01c: what `tc` prints for a row of the isolation inventory that carries chunk 01b's mark. Branch `feat/2229-01c-tc-override-wording`, from `origin/main` `9b803ae9`, with `main` at `78b13a7e` (chunk 01b) merged in before the docs and the final tree. The code and its first tests were built beside 01b against the field its plan fixed; the two guides and this entry waited for 01b's merge, on the Integrator's word.

Visual change: no. No file under `public/` changes; what changes is text `tc` prints in a pane.

**Why.** A session the override let start is not isolated, and a relaunch starts it the same way while the override stands. `tc sessions isolation` told the operator to end and relaunch exactly those sessions and offered their ids to `--replaced`. Under `tc whoami` the server's line named the override only at the end of the row's reason, which is the part a notice cut to a page's room loses.

**What changed.**

- `lib/tc-verbs.js`, `tc sessions isolation`: a row with the mark prints `NOT ISOLATED (operator's override)`, after the plain `NOT ISOLATED` rows. The count line says how many of the not-isolated run under the override, and nothing of it when none do. Such a row is left out of the relaunch sentence and of the `--replaced` ids; when both kinds are present the sentence adds "except those marked (operator's override)". One closing sentence names the marked sessions and says what a relaunch does. When only marked sessions are not isolated the list says "Apart from the sessions under the operator's override, no live session needs relaunching", never a bare all-clear.
- `lib/tc-verbs.js`, the server's attributed line under `tc whoami`, `tc capabilities` and the state step: for a marked row it reads "recorded as not isolated, started under the operator's override (a relaunch can isolate it only on a Codex version TangleClaw has verified; on the same version it starts the same way while the override stands, and is refused once the override is cleared)", before the row's reason.
- `tc`'s own `Launch isolation:` line is unchanged. It is read from the pane alone, and a binding can be another launch's, so nothing in the server's row alters `tc`'s own advice (queue Rulings items 11, 13 and 56).
- `tc` reads one thing of the row: verdict `not-isolated` and `override.launchedUnderOverride === true`. Any other shape of the field, a mark beside another verdict, and a row carrying `overrideUnproved` keep the ordinary label and the ordinary advice to relaunch.
- Docs: `docs/engine-guide.md` (the cutover steps, and the server's second line), `docs/user-guide.md` (the `NOT ISOLATED` row).

**Corrected at the build.** The release's wording said a relaunch isolates such a session "only on a verified Codex or with the override cleared". Clearing the override isolates nothing: on the same Codex version the next launch is then refused. Found by the cumulative review and by the decider, and reworded before anything was pushed.

**Limits.** The mark is the server's, and ages out with the activity log (chunk 01b's limit): a long-lived overridden session then reads unproved and is listed for relaunch again. Not run against a real overridden Codex pane: that waits for the deploy.

**Tests.** `test/tc-verbs.test.js`: the fleet list with a marked row, with only marked rows, with a mark whose detail is null, with malformed and unproved marker shapes, with a mark beside each other verdict; no positive verdict; a fleet with no mark printed exactly as before; and the same renderers over rows written by the real `lib/launch-isolation-inventory.js` for a marked project session, a marked Project Master, an unproved session and a plain one. `test/tc-pane-identity.test.js`: the server's line, the Project Master's row, `tc`'s own line the same bytes with and without the mark for six readings of the pane, an unproved row, and the cut notice keeping the override.

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
