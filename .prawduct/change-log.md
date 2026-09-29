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

## 2026-09-29 — Soak guest definition and synthetic `soak-*` repos (#2020 Chunk 1)

<!-- prawduct: type=feature | scope=2020-chunk1-soak-guest-repos -->

#2020 Chunk 1. The PM dispatched it over Medusa under Rule #124 (RM-LEASE TC-RM07 generation 3). Chunk 1 was reassigned from TC-RM02 on #2020 on 2026-09-29. Plan: `.tangleclaw/plans/2020-chunk1-soak-guest-repos.md` (local, not tracked).

**Why.** The soak's `run` needs the synthetic projects to exist on the target, and the Architect ruling made generating them mandatory before the dry run. There was also no guest definition and no default-deny network profile.

**The change.**
- `lib/soak/repos.js` and `soak.js repos` create each `soak-*` repo with a local bare origin.
  - Deterministic seed commit: the SHA is also computed without git and checked.
  - Exact ownership: a `soak.owner` marker in both repos' config, plus the committed marker file.
  - Every path is inspected before anything is written.
  - Each repo is built in staging and renamed into place, origin first.
  - Running it again is a no-op.
- `deploy/soak/guest/`:
  - `guest.conf`;
  - `pf/soak-deny.conf`;
  - `host-provision.sh`: dry run unless `--execute` and `SOAK_OPERATOR_APPROVED=1`;
  - `guest-setup.sh`: in the guest only; loads pf and proves the loaded ruleset, working loopback, and no egress over IPv4, IPv6 or UDP DNS (Architect A38 refinement), installs the stub, creates the repos and attaches them.

**Decisions** (recorded in the plan):
- pf allows inbound SSH from the host, because the requirement is default-deny, not zero ingress.
- Installing and starting the pinned RC in the guest is left to the runbook chunk.
- Attach uses the dashboard client header while the guest's gate is down, and refuses when it is up.

**Tests.** `test/soak-repos.test.js`, all in temp directories:
- seed determinism across roots, and against the independent computation;
- idempotency, checked against a snapshot of path, size and mtime;
- each case that is not owned;
- rebuilding from the origin;
- immunity to `GIT_*` in the caller's environment;
- the CLI's exit codes.

`test/soak-guest.test.js` uses fake tart, sudo and sysctl, so no host action can run:
- the dry run by default, and the approval gate;
- refusing an existing VM, and refusing to share `$HOME` or `/`;
- the exact pf rules, and no secrets in the config;
- guest-setup refusing in a live pane, outside macOS, or on a machine that is not a VM.

The existing soak tests are unchanged.

**Review.** The cumulative Critic at `52beea1b` found 0 blocking, 4 warnings and 3 notes. All of them are fixed in the follow-up commit:
- The share guard now compares real paths and refuses any directory containing `$HOME`.
- The in-guest pf boundary is recorded as a decision, with its known limits. `--verify-network` lets the runner re-prove the boundary without reloading pf.
- New wrapper-driven tests cover `SEED_MISMATCH`, `GIT_FAILED` staging cleanup, and a path appearing before the rename. Mutation checks confirm the empty-directory pre-check is needed.
- `place()` checks the destination before the rename.
- `SOAK_PROJECTS` is trimmed.
- The DHCP expiry risk is documented, for the dry run to observe.

**Architect A38-final and A44 (security contract), in the third commit.**
- `guest-setup.sh` creates a dedicated non-admin workload user with no sudo.
- The pf SSH rule is bound to the guest interface. The DHCP allowance (68 to 67) reaches only the DHCP server attested from the lease or config, never assumed to be the host.
- All inputs are validated before `pfctl -D`, and every probe has a watchdog.
- Two JSON verifiers, `--verify-admin` and `--verify-workload`, carry the boot identity and separate `scriptSha256` and `profileSha256`. The admin verifier compares the loaded ruleset with pfctl's own parse and fingerprints it. The workload verifier proves sudo and pfctl are refused and that there is no egress, and never inspects pf.
- They replace `--verify-network`. The runner's joining of the two is left to its own chunk.
- No tests ran during RM01's quiet window. In the PM's scoped slot, the two soak test files passed 87/87 on this commit's tree. Full-suite evidence came later, at `99a72892` (below).

**The Critic at `8e139bf6`** found 0 blocking and 3 warnings. W1 (no suite evidence) closed with the full-suite run at `99a72892`. The fourth commit fixes the other two:
- W2: the guest TangleClaw must run as the workload user. `--bootstrap-user` makes that order workable on a fresh guest, and setup and the admin verifier refuse a TangleClaw listening as any other uid (`lsof`).
- W3: the egress probe addresses must be public literals, and are recorded in the workload attestation.

The focused run in PM scoped slot 2 found two real bugs, both fixed before `6d122ba0`:
- the admin attestation emitted during setup carried mode "setup" instead of "admin";
- under `pipefail`, `lsof` exiting non-zero when nothing listened ended the script with exit 1, instead of a refusal.

The rerun passed 107/107. Three mutation checks (dropping the TangleClaw-owner check, the DHCP config-equals-lease check, or the workload sudo refusal) each turned the tests red.

The same commit carries the Architect's further A44 acceptance conditions:
- Each attestation line is built by a real JSON encoder (`JSON.stringify` via node), with a fixed fallback line if node is missing.
- A duplicate or malformed `ipconfig` lease field is refused.
- The admin evidence records the lease, renewal and rebinding durations, the lease start (null where `ipconfig getsummary` does not report it) and when it was observed.
- The DHCP server must be configured and must match the lease's single server identifier. A lease-only identity stays refused until the dry run proves it is the host-controlled service.

**A48 (Architect), in the sixth commit.**
- The fallback line is fixed per mode, with `code: ENCODER_MISSING` and no interpolation. Encoded refusals carry `code: REFUSED`.
- The DHCP timing is normalized to epochs: start, expiry, renew, rebind, observed and remaining. It fails closed when the start is missing, duplicated, unparseable or out of range, when the lease has expired, when T1 < T2 < lease is violated, or when less than `SOAK_ATTEST_WINDOW` remains.
- The TangleClaw is bound as exactly one listening pid, whose uid comes from both lsof and ps and whose executable comes from lsof's txt entry, which must be node.
- `--bootstrap-user` refuses an existing account with a system uid or a foreign home.
- This also covers the Critic's O-3 lease tests (duplicate renewal field, malformed rebinding value, LeaseStartTime reported twice).

**A50 and A52 (Architect), also in `7e59dba8`.**
- The timing is strictly 0 < T1 < T2 < lease, with all three required; equality fails.
- The window is `SOAK_SAMPLE_INTERVAL` + `SOAK_SAFETY_MARGIN`, both bounded and recorded.
- The executable is exactly one node text entry from lsof, canonicalized (realpath), and must equal ps's canonicalized comm. Multiple node entries fail closed.
- The workload identity checks (uid, home and its owner, no admin or wheel, no sudo) now also run in every admin attestation, not only at setup.
- A52: sudo rights are judged by the exit status of `sudo -n -l -U <user> <cmd>` for a shell, pfctl and a no-op, never by sudo's wording.

**The cumulative Critic at `7e59dba8`** found 0 blocking, 2 warnings and 1 note. W1 (full-suite evidence) was left for the PM's window. The seventh commit, `99a72892`, fixes W2 and the note:
- W2: `public_ipv6` accepted malformed literals such as `2606::4700::1`, which `nc` fails to parse, so a denial would have been "proven" without testing pf. Probe literals are now judged by node's `net.isIP` and a `net.BlockList` of reserved ranges. That also refuses the IPv4 documentation and benchmark ranges (the earlier O-2).
- The note: a split sentence in the README's attestation section.

In PM scoped slot 4, the first run exposed a real bug in the new validator: node's `BlockList` matches an IPv4 address against the IPv4-mapped IPv6 subnet, so a shared list refused every IPv4 probe. The fix uses one list per family. `::2` then showed that `::/128` was too narrow, so the whole reserved `::/8` block is refused. The final run passed 137/137, and a mutation check dropping IPv6 probe validation turned 8 tests red.

**Evidence at `99a72892`.** The full declared suite ran in the PM's exclusive window (16:08Z): 14769 tests, 0 fail, 1 ledgered skip. That closes W1, which the earlier paragraphs record as still pending. PR #2044 was opened at this head.

**The Rule #124 independent review blocked it (Architect A71).** The follow-up commit fixes:
- B1 (blocking): in every mode, before guest.conf is read, every admin-executed input and every ancestor up to / must be a plain file or directory, with no symlink or ambiguous path. Each must be owned by root or the admin, with no group or other write, and with no exception (Architect A73 vetoed a sticky-directory one). The checkout therefore lives under a dedicated root- or admin-owned hierarchy such as `/opt/tangleclaw-soak`. The workload must also be unable to write any of them, proven after a positive control. This runs in setup, `--bootstrap-user` and every `--verify-admin`, and guest.conf's sha256 joins both planes' attestations. host-provision.sh checks its own checkout the same way.
- A1: setup runs the admin verifier as its own process, so its `ok:false` line is printed.
- A3: host-provision refuses a share inside `$HOME`, and one not owned by the operator or open to group and others. With `--execute` it refuses a share that isn't empty. The default share moves to `/Users/Shared/tc-soak-share`.
- A4: two positive controls come first: the admin's `sudo -n true`, and `sudo -l` saying yes for the admin. After them, only a workload exit status of 1 counts as denial; a hang or any other status is unknown and refused.
- A6: the CHANGELOG entry is re-audited against the code.
- The uid floor is 501 on both planes.
- These corrections, disclosed at A68: the evidence wording above, and the A50 attribution, now listed under `7e59dba8` with A48.
- A2 (a positive control for egress in the dry run) and A5 (the UDP 68→67 channel and the DHCP limitation) are documented in the README.

**Evidence for the follow-up (PM A62 receipts, one per invocation).**
- The base run of the two soak files at 17:03Z passed 165/165 on the unmutated tree.
- Seven mutation checks each turned red, each under its own receipt (17:11Z to 17:38Z): M11 group/other-write, M12 owner, M13 workload write proof, M14 write proof in `--verify-admin`, M15 treating exit 2 as a denial, M16 a share inside `$HOME`, M17 a non-empty share.
- Earlier runs under the 16:45Z receipt are non-certifying, and a chained mutation run there was quarantined (Architect ruling).
- Those runs did find a real bug: `trust_path` declared a local named `mode`, and bash's dynamic scoping let `refuse` read it, so trust refusals printed no JSON line. The local is now `bits`.

## 2026-09-28 — Every rule is named "Rule #<id>" from its DB id (#2029)

<!-- prawduct: type=feature | scope=2029-rule-id-display -->

The PM dispatched this over Medusa as a v5.30 release blocker, under RULE #120 (RM-LEASE TC-RM02 generation 2). Every rule surface showed only authored text, so the only number an operator could see was one an author typed, which could be missing or name another rule.

**The change.** `lib/rule-label.js` derives the label from `session_rules.id`, and `public/api-helper.js` mirrors it for the pages. The label now appears on:
- the Project and Global lists, with their controls, status lines and confirmations;
- the wrap drawer (rows, notes and summary) and the `rule-proposal` step's detail;
- `tc rules`, the delivered startup rules (inline, hook and launch step), the wrap prompt and the Project Master's Hard rules;
- the delivery ledger, the operator-only refusal, and an API `label` field.

**Architect rulings.**
- Exactly one leading authored `RULE #<id> — ` naming the same rule is elided on display. A prefix naming a different id stays visible and is flagged *text says #N*.
- Stored text and the `expectedContent` approval semantics are unchanged.
- "Superseded" is not a stored state, so it is tested as an active rule disabled by its replacement. `rejected` is tested as its own state.

**Tests.** `test/rule-label.test.js`, `test/rule-label-drift.test.js` (server and browser agree) and `test/rule-id-display.test.js` (every surface × every state, plus a source guard that every approval-outcome line names the rule). Existing assertions on the old wording were updated to the labelled form, and each still checks the same thing. Mutation checks confirmed four new guards go red when their subject breaks.

**Review.** The cumulative Critic found 0 blocking and 2 warnings: the wrap prompt and the Master's instructions were still unlabelled. Both were fixed in `c4d70c75`, and verify-resolutions was clean. The independent exact-head review (TC-RM03) certified `c4d70c75` green. This also resolves #1695.
## 2026-09-29 — A Codex coordinator's context rotation is a governed transition (#2032)

<!-- prawduct: type=bugfix | scope=2032-coordinator-rotation -->

The Architect dispatched this as an emergency (message e2f2d7c2, the plan at TangleClaw-Architect/.tangleclaw/plans/2032-coordinator-context-rotation-emergency.md), and the PM confirmed it. The scope was E1–E3 first, then the replacement Architect's rulings A1–A16, which made E4 (relaunch parity and the operator surface) part of the certifying scope. The incident: Architect session 1199 survived `/clear`, but its startup-control channel stayed on the pre-clear Codex thread, so every wake answered `thread-not-loaded` and the replacement context resumed with no fence and no proof it had reconciled.

**Reproduction first.** `test/coordinator-rotation.test.js` opens with the incident against the fake app-server: the recorded thread unloads, a replacement loads, observation answers `thread-not-loaded` and keeps the old binding. It still does after this change, with or without an open rotation, so the #1628/D8 invariant (observation never replaces a recorded thread) holds.

**The change.**
- **Record and fence.** A `coordinator_rotations` record (schema v51) is created by `prepare` together with a validated, canonical-JSON-digested checkpoint and the inbox ids at that moment, in one insert, so the checkpoint never exists without the fence. A partial unique index allows one open rotation per project.
- **Clear and rebind.** The server's driver types `/clear` when the prior thread is idle, then binds the one provable replacement through `startup-control-codex#rebindThread`: new since the clear, root, same directory, prior gone. That function is a compare-and-set on the channel and the only writer allowed to move a recorded thread.
- **Re-entry.** The re-entry turn is delivered by `deliverTurn`, which reads the thread back for the rotation's client-id digest before sending.
- **Resume.** It is accepted only on the server's own checks, detailed below, and acceptance is the compare-and-set that lifts the fence.
- **What the fence holds.** Every coordinator-authority mutation, through the epoch gate below, plus the wake (`coordinator-rotating`).
- **Wiring.** `tc rotation prepare|show|advance|resume`, launch-bound routes under `/api/tc/rotation`, operator-only abandon, and driver recovery at boot. Engines without a rebindable channel are refused at prepare.

**Decisions.**
- **Schema.** v51, per ruling A17. Open PRs do not reserve migration numbers, and a v52 merged first would stamp past an absent v51. #2032 lands first; #1971 and then #1966 rebase onto it and take the following versions.
- **The first cut's readings are superseded.** "Dispatch" as outbound sends only, and "generation only at resume", were replaced by rulings A2, A11 and A12: the epoch gate covers every listed mutation.
- **Inbox high-water mark.** It stays the set of message ids present at prepare.

**Architect rulings A1–A16 (after the E1–E3 checkpoint).** The replacement Architect ruled most of the first cut insufficient, and each ruling is built:
- **A6a.** An operator-granted, versioned `coordinator_roles` contract is now the only authority to prepare. A role or version change during absence is non-acceptable authority drift.
- **A7a.** A content fingerprint of the checkout is taken at prepare, which refuses undeclared dirt. It is re-observed at resume, where any difference is non-acceptable integrity drift. The old receipt-asserted `git.head` and `github.checkedAt` fields were removed.
- **A11/A12.** The epoch gate now judges every listed coordinator-authority mutation, including control, session-rule, wrap and workload routes and the Medusa send, ack and close routes. It accepts them only from the bound replacement thread, session and launch. `tc` forwards `CODEX_THREAD_ID` as `x-tangleclaw-engine-thread`. Reconciling allows only workload, the control ack and interval-scoped replies, acks and closes. Resume needs a one-time nonce, minted lazily when the re-entry turn is actually sent and stored hashed. The adapter's `deliverTurn` now decides "already sent" by client id alone, because each send's text carries a fresh secret.
- **A10.** The checkpoint enumerates GitHub facts, which `lib/github-facts.js` reads through `gh` at prepare (unreadable or wrongly declared facts refuse the prepare) and at resume. There are two drift classes:
  - Trusted GitHub drift (key plus before/after digests) must be disposed of in `receipt.drift` (`accepted`/`superseded`/`follow-up`).
  - Authority and checkout-integrity drift can never be accepted.

  Unavailable evidence blocks. Observations and dispositions are persisted on every resume attempt.
- **A8.** A readiness verdict: a workload receipt published after the re-entry turn, current, `working`/`waiting-external` and `do-not-clear`. It is persisted either way. Prepare and resume are now async.
- **A13/E4.** Relaunch parity:
  - A `relaunch`-mode rotation stays fenced across the session's end. The ending session may only wrap itself, from its prior thread.
  - An operator-only relaunch claim launches the successor and binds exactly its session, launch and channel in one compare-and-set.
  - The rebind takes only the thread the successor's own channel records. Per ruling A16 it never infers one from a visible thread, and waits with `successor-thread-unrecorded` instead. Unclaimed launches stay fenced, and an unbindable successor is recorded for operator recovery.
- **Operator surface.** `nextStep` gives exactly one next command per state. Every view shows the binding (session, thread, generation) and never a launch id or nonce. It surfaces in `tc rotation show`, the fleet lane (`tc sessions` shows `ROTATING …`) and the operator's `GET /api/rotations`.
- **A14 live-Codex check.** `scripts/rotation-live-check.js` (pre / prepare / post) is for an independent executor at the exact head. `GET /api/tc/rotation` reports the forwarded-vs-channel thread binding it reads. The script's own verdicts are tested against a stub.

**Independent review (TC-RM03) on 8192fa1a: NOT GREEN, 1 blocking.** The Medusa loop routes (open, continue, force-done, closeout) and the listener toggle bypassed the gate, so a prior context could dispatch during rebinding.
- **Fix.** They are now gated: loops are new dispatch, fenced until active; the toggle is allowed from the bound replacement while reconciling.
- **Why the table test missed them.** It was a hand-kept list, the Critic's O-1 observation. The route test now also walks every registered mutating route in the gated families through `server._routePatterns()`, so a new route is covered by existing. Its one exemption is named with its reason.

**Architect ruling A18 (after RM03's review).** `8b160286` was not a candidate. A18 required:
- **Listener toggle.** While reconciling, only an explicit enable.
- **Serialized passes (W1).** Passes are serialized per rotation, so there is one re-entry turn and one live nonce.
- **Driver-error evidence (W2).** A first-pass throw is recorded as `driver-error`.
- **Verified operator (W3).** The operator exemption uses control's proof tiers.
- **The header's meaning (W4).** The docs now say the thread header is attribution, not authentication.
- **Clear pacing (W5).** Only admitted `/clear` attempts count, refusals retry after 15 s, and an admitted clear gets a 20 s settle window.
- **Fingerprint bounds (W6).** The fingerprint runs off the event loop under a 30 s total deadline, with each git call raced against it. Important-ignored paths are capped at 50 and checked in one batch, and hashing is capped at 256 MB in total.
- **N5–N7.** Repo segments made only of dots are refused. GitHub reads run 4 at a time under a 60 s deadline. JSON depth is capped at 32. The live script keeps its state in an owner-only directory it checks.
- **N8.** `POST /command` and startup-prompt fire are gated. The route sweep now covers the whole `/api/sessions/:project` family, with each exemption named and checked to still exist.
- **Item 10.** The search for DBs stamped v52 found none outside the system temp directory. The live install is at v50. The v51/v52 test stores left in temp were reported, not deleted.

**Cumulative Critic on 17a1d4be: 0 blocking.** Three of its warnings broke normal use, so they were fixed rather than accepted:
- **Own checkout check.** A rotation tripped its own checkout check. Now `tc` refuses checkpoint and receipt files inside the checkout, and a relaunch re-takes its baseline at the claim, after the wrap commit and the successor's config rewrite, keeping the earlier changes as `drift.relaunch`.
- **Epoch lapse.** An active epoch never released. Now it lapses when its bound session ends, so an ordinary relaunch needs no operator, and a completed rotation stays `active`, never `abandoned`.
- **Re-entry turn.** It sent the coordinator to raw routes it could no longer use. Now it names `tc message read|ack` and says why raw HTTP is refused.

**Architect ruling on the epoch lapse (message 704a075b): confirmed, fail-closed.** An epoch lapses only on persisted evidence that its bound session ended, meaning a terminal session status. A missing or unreadable row keeps the fence, and no successor inherits the epoch. A completed rotation stays completed. **Architect ruling on the relaunch baseline (message 3a04dd8d): confirmed.** The baseline is retaken exactly once, at the governed claim, after authoritative proof that the old session ended and after the successor has launched and its launch id and channel are bound. Pre-claim differences are kept as `drift.relaunch`, and nothing after the claim is forgiven. The claim now requires the old session's own row to record a terminal status: a missing or unreadable row refuses with `ROTATION_PRIOR_SESSION_NOT_ENDED` and stays fenced. Per the clarification in message 085f4f3c, READY need not come before the retake, but the successor gets no authority until its launch sequence is attested READY. Resume now refuses a relaunch whose successor sequence has no `readyAt`.

Also fixed:
- the dirty-path cap (1000) and the column sizes (1 MB) now agree;
- the live check requires a 201;
- the driver stops polling on failures that need the operator;
- failures are logged;
- the `GET /api/tc/rotation` comment is corrected.

**Live-Codex check (RM08) at 394aaab4: FAILED, 2 defects, plus a third found in its logs.** Real Codex keeps the old thread loaded about 2 s after `/clear` beside the new one, and opens a short-lived auxiliary thread beside a thread's first turn. The driver treated both as terminal operator failures.
- **Settle window.** Now, for 2 minutes after an admitted clear, they are retryable waits (`prior-thread-unloading`, `replacement-settling`), and only become `prior-thread-still-loaded` or `replacement-ambiguous` after that. No thread is ever inferred: binding still needs exactly one candidate.
- **Listener requirement.** RM08's resume was also refused, because its project runs without Medusa and the resume required a listener regardless. A listener is now required only when the prepare recorded messages to drain.
- **Tests.** Each live sequence is replayed in a test, and those tests fail with the window removed.

**8a9ceab6 NOT GREEN: two defects.**
- **RM03 W1.** Skipping the listener check when nothing was recorded also skipped it for a switchboard coordinator whose listener had died.
  - **Fix.** The listener requirement now follows the project's `medusaEnabled`, and an unreadable config counts as enabled. Prepare refuses a switchboard coordinator whose listener is down (`ROTATION_LISTENER_DOWN`).
- **RM08 procedural.** The live rotation itself passed, but the script's `post` phase expected `reconciling` after the coordinator had already resumed, as the re-entry turn tells it to.
  - **Fix.** `GET /api/tc/rotation` now also returns `latest`, and `post` accepts a rotation that is already active and bound to this thread.

**Tests.** Rotation tests cover prepare, the fence, the rebind and resume, including every rejection, crash-retry at the rebind and the re-entry send, concurrent passes and old-thread reappearance. They also cover the epoch gate per state and caller, the nonce, the role contract, integrity and GitHub drift, readiness, the relaunch claim and the next command. Separate tests cover the checkout fingerprint against real git repos, the GitHub reader, route binding, the verb and `bin/tc` header forwarding, the send-fence route, the wake gate and the live-check script's own verdicts. The v50 migration test compared against a literal `50`; it now reads `CURRENT_SCHEMA_VERSION`, as the store asks, so it still means "advances to HEAD". The four prime golden fixtures changed only by the new `rotation` verb in the generated verb list, regenerated with `UPDATE_PRIME_GOLDEN=1`. The other wake and watchdog tests now stub the new seam so none reads an ambient store.

## 2026-09-29 — Never certify a soak log whose lock ownership could not be verified (#2025 remediation, #2020 Chunk 2A)

<!-- prawduct: type=bugfix | scope=2020-soak-schedule -->

C2. Implements the Architect ruling on PR #2025 (comment 5880348030): RA2 option (i), RA3, RA4 and O1. RB1 retained. Lease RULE #121 (generation 3); PM dispatch `78adf766`. Started from `272ff56481306a4d73edb3cc93d3770972ac0e24`.

- **Why.** An independent review reproduced a laundering path (V1). A lock that could not be read mid-run was treated as lost. If the lock-lost sidecar could not be written either, the run failed `LOCK_LOST_UNRECORDED`, and once the lock read back naming the dead owner, the next run reclaimed it as an ordinary crash and resumed the log to `ended=true` with no trace. The same held for a lock unreadable at release after `end` was written.
- **What.**
  - `acquireLogLock` classifies an ownership failure as `removed`, `replaced` or `unverified` (any read error but `ENOENT`). `release()` never removes a lock it cannot read and reports `unverified`.
  - `runSchedule` handles `unverified` without a sidecar, a lock removal or a segment close, and refuses `OWNERSHIP_UNVERIFIED`, or attaches `ownershipUnverified` to the run's own error.
  - Every active-marker exact-owner reclaim records `recoveredFrom.state: "ownership-unverified"`, the already-complete path included, which now appends its `resume` and `lock-reclaimed` records.
  - An active marker whose owner is provably dead on this host, and whose lock is gone, names someone else, is unparseable or is unreadable at recovery, is condemned. The refusal is written to the bound `<log>.lock-lost` sidecar (`LOG_SEGMENT_UNRECONCILED`, `details.condemned`), so a lock restored later resumes nothing. An owner that may be alive, or is on another host, is refused without condemning, since it may be a run between its release and its segment close. `acquireLogLock` now refuses an unreadable or unparseable lock with `details.lockUnreadable`, instead of throwing a raw `EACCES`.
  - `readLog` returns `ownership` and a `certification` disposition: no automatic pass, a `fail-reset` default, and the exact evidence (path, bytes, sha256) an Operator acceptance must bind. `acceptanceMatches` gives a judge that check. A run with any unverified segment reports `*-ownership-unverified`, and the CLI exits 5.
  - O1: `SEGMENT_CLOSE_FAILED` says to start a new log or reset it by hand. `closeSegment` separates a failed unlink (`marker-remains`) from an unlink whose directory fsync failed (`unknown`).
- **Tests changed by the ruling, not weakened.** An ordinary crash now expects `ownership-unverified` and `*-ownership-unverified` statuses. A lock unreadable at release expects `ownershipUnverified`, not `lockLost`, plus no sidecar and an open segment. A crash between release and marker-clear now reads `LOG_LOCK_LOST`, a permanent refusal, instead of `LOG_SEGMENT_OPEN`. The complete-run result gains `ownershipUnverified: false`.
- **Tests added (RA4).** Both V1 variants (mid-run with an unwritable directory, and at release), each confirmed to fail against `272ff564`. Also: exact owner and binding (another host's lock, another dead pid, a marker on another host, rewritten log prefix); removed, replaced, unparseable and unreadable-at-recovery locks condemned, with a restored exact-owner lock still refused; a possibly-live owner never condemned; the read/run flags and certification disposition; `acceptanceMatches`; no clean completed status; CLI exit 5; and both O1 cleanup outcomes.
- **Critic round 1 (`rev-20260929T023053Z-d216c2dc`).**
  - Blocking, fixed: the old marker was replaced before the `resume` record was durable, so a failure in between (wrong `--schedule`, `LOG_UNREADABLE`, a failed write) released the lock and closed the new marker, and a correct rerun ended `completed`. Now a failure before the recovery is recorded releases and closes nothing, and reports `recoveryPending`, leaving a crash's state for the next exact-owner reclaim. Tests cover the wrong schedule, a damaged log (still refused after a repair, since that rewrites bytes the new marker bound), and an unwritable log. All three fail against `e5d52736`.
  - Warnings, fixed: suite evidence re-recorded at the new head. The certification judge is named as not built in the README, CHANGELOG and FEATURES, and the README no longer claims a judge enforces the disposition.
  - Notes: resume wording corrected (a logged event never runs again, but the one in flight at a crash does). A finished run's release-to-unlink crash window and `refuseLiveAddress` against a remote live install were accepted as outside this ruling's scope and reported to the PM.
- **RM05's reproduction steps** (relayed by the PM, read-only from its VRF packet). Its variant A (lock chmod 000 and directory chmod 500) is the V1 mid-run test. Its variant B (only the directory chmod 000, the lock file untouched) is added as its own test. It fails against `272ff564` and passes now.
- **TC-RM05 exact-head review of `d32bd752`: NOT GREEN, conditional** (relayed by the PM; the Architect required a bounded final patch). Functional requirements verified.
  - N1, documented: "refused for good" holds only once the refusal is recorded. When the log's whole directory is unreadable at recovery, or the sidecar write fails, nothing durable remains, so a later exact-owner reclaim resumes the log, still marked ownership-unverified. Stated in the README, CHANGELOG, FEATURES and `_condemnSegment`'s JSDoc.
  - N2, fixed: with the directory unreadable, `checkLockLost` said the log "has a lock-lost sidecar that cannot be read", though none existed. It now tells the two apart by `stat`ing the entry, which needs only the directory. It names the unreadable directory (`details.directoryUnreadable`) and says whether a sidecar exists is unknown. The code stays `LOG_LOCK_LOST_INVALID`. Tested for both a directory-only failure and an unreadable sidecar file.
- **Known limit, unchanged (RB1).** Ownership is still checked, then written, with no atomic lock. A lock that became unreadable and then read back cannot be told from one that never changed, which is why every exact-owner resume is marked.

## 2026-09-28 — A reproducible load-and-fault schedule for the release-candidate soak (#2020 Chunk 2A)

<!-- prawduct: type=feature | scope=2020-soak-schedule -->

#2020 Chunk 2, dispatched by the PM over Medusa after the Architect's rulings on the overlap checkpoint (Q1–Q4). This is TC-RM02's slice of #1949 Deliverable 2. C01/C02 (#1962, #1975) and Habitat were not touched.

**The change.**
- `lib/soak/schedule.js` is pure. It hashes a string seed into a mulberry32 PRNG, draws the load and fault streams separately, and applies a quiet window between faults. The schedule's `digest` is a sha256 of its canonical JSON.
- `validateSchedule` enforces every rule on any schedule, whoever produced it. That includes the Architect's Q3 ruling: no `fault.ttyd.restart` in a `certifying` schedule, because an owned-ttyd generation change hard-fails C01.
- `lib/soak/executors.js` implements the `api` and `engine` classes over HTTP. `engine.session.cycle` always kills a session it launched, even after a failed command, so one failure cannot leak a session into the rest of the soak.
- `lib/soak/driver.js` refuses on `INVALID_SCHEDULE`, `NO_EXECUTOR`, `LIVE_INSTALL_TARGET` and `LOG_MISMATCH`. It appends fsynced ndjson, keeps each event's wall-clock slot and records lateness, and resumes from the log. At this commit it truncated a torn final line; the F7 remediation below replaced that with append-only sealing.
- `scripts/soak.js` is the `plan` / `validate` / `run` CLI.
- `deploy/soak/stub-engine/` holds the Q4 stand-in engine, which has no network access.

**Descoped, explicitly:** the `browser` and `fault` executors. They act on processes inside the guest, so they can be neither verified nor safely run until Chunk 1's guest exists. `run` refuses them (`NO_EXECUTOR`) rather than skipping them. They need a follow-on dispatch.

**Architect ruling (2026-09-28, via the PM) on the items below:**
- Nothing is dropped from #2020. This branch is **Chunk 2A**, the core.
- Plans and switchboard load, and the wrap and switchboard engine journeys, are a mandatory **Chunk 2B**.
- The exact-owned synthetic `soak-*` repos with local bare origins are mandatory **Chunk 1** guest provisioning.
- Both are required before the first guest dry run, and each is dispatched separately.

**Also descoped, and not declared until the cumulative Critic `rev-20260928T185141Z-f04421bb` caught it (BLOCKING).** These are Chunk 2 items from the plan that were neither built nor listed. Nobody had ruled on them; they are pending the PM's ruling, now requested. They are recorded in the plan (§4), the README status block and the CHANGELOG:
- API load against **plans and the switchboard**. Built: health, server-info, projects, ports.
- Stub-engine sessions exercising **wrap and the switchboard**. Built: launch, commands, kill.
- **Synthetic repos with a local bare origin**. The README makes existing `soak-*` projects a prerequisite of the target instead; provisioning fits with the Chunk 1 guest.

**Verification.**
- New suites: `test/soak-{schedule,driver,executors,cli,stub-engine}.test.js`.
- Baseline suite on `origin/main` 69fc2253: green, with the one ledgered skip.
- Real-process smoke against a throwaway local HTTP server:
  - server hit counts matched the planned counts;
  - a rerun was a no-op;
  - the live `TANGLECLAW_API` was refused before any request.
- **Not verified:** the executors against a real TangleClaw server with the stub engine installed. That needs the guest, and the first dry run is where it happens.

**Critic review `rev-20260928T175410Z-bba5dd13` (cumulative, `222a8ee1`): 0 blocking, 3 warnings.**
- *Guard bypass: fixed.* `refuseLiveTarget` compared origins only, so `127.0.0.1`, `[::1]`, the hostname or MagicDNS name, or the other scheme on the live port got through. It now refuses any local alias of the live port.
  - A new `refuseSameInstall` also refuses a target whose `/api/server-info` reports the same `startedAt`/`startupSha`. That catches a proxy route that no address check can see.
  - Verified read-only against the live install: every alias was refused.
  - The live install's Caddy route on :8443 answers `401` because it is login-gated and this install has no service token. There the identity check reports `IDENTITY_UNCHECKED` and does not refuse. That is harmless: the same `401` would answer every load request, so nothing could be written.
- *Event params: fixed.* `validateSchedule` never checked event params. It now rejects anything `_taskParams` could not have produced (`EVENT_PARAMS`), and tamper tests cover each case.
- *No suite evidence: resolved.* The suite ran on the fix commit and its result was recorded.
- **The Critic's notes, not rated as findings:**
  - A resumed run fires overdue events back to back, which would bunch faults. That is for the fault-executor follow-on to decide, and it is recorded in the handoff notes.
  - The target's projects and delete-password prerequisites are now stated in the README.

**Independent review by TC-RM03 at `b852888b`: NOT GREEN, 4 blocking and 4 low.**
- The PM and the Architect dispatched all eight findings, with architectural requirements, as one bounded batch.
- The intermediate commit `c491995c` was written before those requirements arrived, and was never handed over for review.
- The commit after it aligns every finding to them:
- *F1: fixed.* `LIMITS` holds the params to fixed bounds, so validation no longer trusts params a hand edit also controls: synthetic `soak-` names, lease ports of 5000 and above, a cap on commands, and floors on the gaps. New tests tamper with params, events and digest together.
- *F2: fixed.*
  - `canonicalHost` unwraps IPv4-mapped forms, strips trailing dots and treats `*.localhost` as loopback.
  - `refuseLiveResolved` refuses a name that resolves to this machine, and fails closed on one that does not resolve (`TARGET_UNRESOLVED`).
  - Verified read-only against the live install: all of TC-RM03's spellings were refused. `localtest.me` was refused on resolution to `::1`.
- *F3: fixed.* An unreadable live identity refuses (`LIVE_IDENTITY_UNREADABLE`) unless `--allow-unverified-live` is given. The log header records that override, it is tested, and it is never passed on the operator's behalf.
- *F4: fixed.*
  - Stale load, more than `STALE_LOAD_MS` late, is skipped and recorded as `SKIPPED_STALE`.
  - Faults are deferred, never skipped. They keep `faultQuietMs` from the previous executed fault, including one read back from the log after a restart, and all of them drain before the end record.
  - Other overdue load is spaced by `CATCH_UP_GAP_MS`.
  - The restart test was confirmed to fail with the log read-back removed.
- *F5: fixed.* The engine cycle reads session status first:
  - it kills only a leftover `soak-stub` session;
  - it never touches another engine's session (`FOREIGN_SESSION`);
  - it kills nothing when the status is unreadable.
  - The server's `404`/`200` answers were checked against `server.js` and `sessions.killSession`.
- *F6: fixed as the Architect required.* With no `TANGLECLAW_API`, `run` refuses (`GUARD_CONTEXT_ABSENT`) unless `--no-live-install` is given.
  - That is the guest's case, and the override is recorded in the header.
  - Passing it while `TANGLECLAW_API` is set is a usage error.
  - My earlier objection, that a fallback would refuse the guest's own localhost, is answered by the override being explicit rather than a fallback.
- *F7: fixed.*
  - `readLog` is read-only.
  - `sealTornTail` closes a torn tail by appending a newline and a seal record, so no byte of evidence is rewritten.
  - A malformed line is accepted only when a seal directly follows it.
  - `acquireLogLock` gives one driver per log, reclaims only a dead holder on this host, and logs the reclaim. An empty or unreadable lock fails safe.
  - A header without a real `startEpochMs` is refused.
- *F8: fixed.* There are floors on the gaps, and an absolute cap of 300,000 events, enforced while generating and in validation.
- **Cumulative Critic `rev-20260928T182655Z-286f32cd` at `df6b7346`: 0 blocking, 3 warnings, 5 notes.** Fixed in the next commit:
  - *W1:* a deleted `faultQuietMs` validated, because it was filled with its default, but the driver read it raw, which switched spacing off. Params must now be written out in full canonical form, and the driver reads through the normalizer.
  - *W2:* when `TANGLECLAW_API` names this machine by a Tailscale or LAN name that is not its hostname, `127.0.0.1` on the live port passed both address checks. The live name is now resolved too, and an unresolvable live name counts as local.
  - *W3:* Ctrl-C waited out a whole deferred-fault window. Waits are now polled every second, and the first signal prints a `stopping` line.
  - *Notes:* an executor's result can no longer overwrite `type`, `index`, `kind` or `startedAt`. An unparseable `TANGLECLAW_API` is refused with `GUARD_CONTEXT_ABSENT` rather than a stack trace. Two doc contradictions were corrected.
  - *Note accepted:* a narrow race in stale-lock reclaim, where two drivers start at the same moment on a dead holder's lock. Closing it needs an atomic compare-and-swap that the filesystem does not offer portably. It needs a crash plus two simultaneous operator starts on one log, and a later `readLog` of a doubly-written log would show it.
  - The W2 and W3 regression tests were confirmed to fail with their fixes reverted.
- **TC-RM03 re-review at `2d9deff9`: F1–F8 all verified fixed. NOT GREEN on one blocker, R1.** The final dispatch (PM, matching the Architect) made R1, L1, L2 and L3 blocking and accepted L4:
  - *R1: fixed.* Every resumed segment appends and fsyncs a `resume` record before any resumed work. It carries the segment's `guard` results (live API, target, checked address, identity outcome), its overrides and `resumedFrom`. A fresh log's header carries the same `guard` results.
    - Override keys cannot overwrite the fixed fields.
    - CLI resume tests cover both flags and a no-override segment. With the record removed, all five new tests fail.
    - Real-process reproduction of TC-RM03's probe: a guarded segment stopped by SIGINT, then resumed with `--no-live-install`. The `resume` record carries the override.
  - *L1: fixed.* A certifying schedule's `faultQuietMs` must be at least 60,000 ms. A hand edit to 0 with a recomputed digest is `PARAMS`. A destructive schedule may still use 0.
  - *L2: fixed.* The stale-lock reclaim now has a single winner.
    - A reclaimer must win `mkdir` of `<log>.lock.reclaim`.
    - It re-reads the lock under that mutex and replaces it only if it is still the same dead holder.
    - It replaces it by writing a temp file and doing an atomic `rename`. The first version removed then created, and the concurrency test caught a process on its ordinary first attempt taking the lock in that gap (about 1 run in 25). The rename closes it.
    - The concurrency test holds eight processes just after their stale check (a test-only hook), so they all reach the reclaim together. It fails 5 of 5 against the old remove-then-create reclaim and passes 12 of 12 against the fix.
    - `release` never removes a lock it does not hold.
  - *L3: fixed.* With `TANGLECLAW_API` set, `--api` must be an IP literal (`TARGET_NOT_IP_LITERAL`), so the target is never resolved and there is no check-to-connect window to rebind. A test with a rebinding resolver asserts the target is never looked up. The live name is still resolved, to decide whether the live install is local.
    - Verified read-only against the live install: `localtest.me` and the MagicDNS name are refused unresolved, `127.0.0.1` and `[::ffff:127.0.0.1]` on the live port are refused, and a guest IP is allowed.
  - *L4: accepted and documented.* A deferred fault can make queued load stale, and that load is skipped and logged.
  - *Cumulative Critic `rev-20260928T185141Z-f04421bb` at `3a9f8005`:*
    - **1 blocking:** the silent descope above, now declared everywhere it applies.
    - *W2 fixed:* a torn line that was a complete, valid record, missing only its newline, parsed as a record, so its seal was refused as stray and the log could never resume again. `readLog` now identifies a fragment by the seal that follows it, before parsing. There is a regression test, which fails on the old reader.
    - *W3 fixed:* `appendRecord` and `sealTornTail` ignored partial `writeSync` results, so a nearly full disk could leave an unrepairable partial record mid-log. Both now use `writeAll`, which loops, or throws `ESHORTWRITE` when a write makes no progress. Tested.
    - *Notes:* the driver header and the CHANGELOG resume wording are corrected. Splitting `driver.js` into guard, log and loop modules is accepted and left for when the fault executors land.
  - *Verify-resolutions `rev-20260928T185604Z-c489e612` at `a42b1d1a`:* R-1 and R-3 were resolved. R-2 was half-resolved: a crash that tore the SEAL's own write still left the log unresumable, because the fragment became a complete, unsealed line and the half-written seal became the torn tail. Fixed:
    - A seal now binds a byte RANGE, from the start of the damage up to its own separator. It is found by its start offset, however many lines the range spans.
    - Unsealed damage is accepted only as the very end of the log, where it is the pending region the next run seals.
    - A regression test cuts `sealTornTail`'s write at every byte and requires each resulting log to resume and complete. It fails on the `a42b1d1a` reader.
    - The observations on CHANGELOG wording (fixed) and on the plan being gitignored (accepted, since the tracked records carry the descope) are disposed of.
  - *Verify-resolutions `rev-20260928T190033Z-92086e9a` at `f109c34e`:* R-2 was still open for one cut. The fragment was a complete, valid record, and the crash cut only the seal's trailing newline. That resumed once, then a later read refused the log, because a second seal landed on top of the first.
    - **Fixed at the root.** A torn tail that is itself a complete seal matching the damage right before it is accepted as a seal, and the run appends just its newline (`finishSeal`, via `appendRaw`). No seal ever lands on another seal.
    - The dead `restIsDamage` clause is dropped.
    - **Tests now enumerate the threat, not the reported case.** Both fragment kinds, a record cut mid-way and a complete record missing only its newline, are resumed with the seal cut at every byte. A two-level test cuts a second seal too. Each case must read back identically twice.
    - The complete-record test fails on the `f109c34e` reader.
  - *Verify-resolutions `rev-20260928T190622Z-463e228b` at `11a055e7`:* R-2 is resolved. Its three observations are folded into the final commit:
    - the seal-cut tests require `completed` and check that each event is on record exactly once, at every cut;
    - `readLog`'s JSDoc names `finishSeal`.
  - **TC-RM03 final verification of `911a5f73`: R1, L1, L2, L3 and L5 verified. NOT GREEN on R2.** Dispatched by the PM with the Architect's specifics:
    - *R2: fixed.* Every soak fetch followed redirects, so an IP-literal target could answer 307 and have the load replayed, method and body included, onto the live install after every guard passed. TC-RM03 reproduced it with local decoys.
      - Both fetch call sites now pass `redirect: 'manual'`. A 3xx from the load is `REDIRECT_REFUSED`, with its `location`. A 3xx from an identity probe counts as unreadable, so the live side fails closed.
      - Tests use real local HTTP servers, one per code (301, 302, 303, 307, 308), plus a target whose identity endpoint itself redirects. Each asserts the live stand-in receives nothing but its own identity probe.
      - A structural test pins every fetch call site to `redirect: 'manual'`.
      - With the option removed, all six real-server tests fail and the live stand-in receives the load.
    - *O2: fixed.* `release` reports a lock that vanished or changed hands instead of throwing. A clean run then ends with `LOCK_LOST`, carrying the result. A run that already failed throws its own error, with `lockLost` attached, never masked.
    - *Verify-resolutions `rev-20260928T192614Z-f110475b` at `fcef14de`:* clean. Its observation was a real (if unlikely) breach of the "never masked" requirement: a lock-file read error other than ENOENT at release, such as EIO or EPERM, still threw and replaced the run's own error. `release` now never throws. Any read or remove failure becomes a lost lock with its reason, and tests cover both the release and the primary-error path.
    - **TC-RM03 final verification of `9309bae4`: R2 and O2 verified. O2b was ruled BLOCKING by the Architect:** the `end` record was durable before release found the lock lost, so the log read as a clean run and a rerun said `already-complete`. The fix follows the Architect's sidecar design, dispatched by the PM:
      - the lock exposes `owned()`, and the run re-checks it before every log append (so the check just before `end` is exact) and before every executor event. A lock that cannot be read counts as lost;
      - on loss, nothing more is appended to the log (no event, no `end`, no loss record) and the run never resumes;
      - `writeLockLostSidecar` creates a fail-only `<log>.lock-lost` sidecar atomically (temp file, fsync, a hard link that never overwrites, then a directory fsync). It binds the absolute log path, the log's size and sha256 at the loss, the expected holder and the observed holder. If it cannot be written, the run reports `LOCK_LOST_UNRECORDED`;
      - `checkLockLost` runs first in `readLog` and before `runSchedule` takes the lock. A binding sidecar is `LOG_LOCK_LOST`; a tampered, mismatched, malformed or unreadable one is `LOG_LOCK_LOST_INVALID`. Both refuse;
      - a lock still owned but not removable is `LOCK_RELEASE_FAILED`, distinct from loss, with no sidecar and the log intact;
      - primary-error precedence is kept, with the recorded loss attached as `lockLost`.
      - Tests cover: loss during an event (that event and `end` are unwritten); loss exactly before `end`; rerun refused, taking no lock; five kinds of sidecar tamper; a log cut back after the loss; `LOCK_LOST_UNRECORDED` via an unwritable directory; primary precedence; and `LOCK_RELEASE_FAILED`.
      - Mutation checks: removing the pre-append check fails both loss tests, and removing the reader check fails the rerun and tamper tests. The loss-during-event test first keyed its trigger on the event kind, which event 0 shared, and passed vacuously. Its trigger is now the second executor call.
    - **TC-RM03 final verification of `79697d96`: GREEN.** The Architect then promoted residual **RA to a final blocker** and accepted RB. The PM dispatched RA and closed PR #2025 until it is done.
      - *RA:* a lock lost AND a sidecar that could not be written let a later run, once the directory was writable again, resume and complete. The log then read clean. My earlier argument, that a marker cannot tell that from a crash, was wrong. The lock state tells them apart: a crash leaves the marker and the old lock naming the same dead owner, while an unrecorded loss leaves the marker with the lock absent, replaced or unreadable.
      - **The fix:**
        - `openSegment` durably writes `<log>.segment` before any work, bound to the log path, the owner, and the log's size and sha256 at the start.
        - `closeSegment` removes it only after every append is fsynced and exact-owner release succeeds.
        - **Graceful stop, as ruled by the Architect (refining my first interpretation, which just cleared the marker):**
          - under exact ownership, a `stop` record is appended and fsynced;
          - `stopSegment` atomically transitions the marker to `stopped-clean`, bound to the whole log as it stands;
          - then the lock is released and the marker is cleaned up.
          - A leftover valid `stopped-clean` marker resumes even with no lock, recorded as `recoveredFrom.state: 'stopped-clean'`.
          - A loss before the stop commits writes neither the stop record nor the transition, since both are behind the ownership check.
        - Before work, `runSchedule` reconciles a leftover marker. It resumes only when the stale lock `acquireLogLock` reclaimed names exactly the marker's owner, a same-host process that is dead. It records `recoveredFrom` in the new segment's header or resume record, under the new lock. Otherwise it refuses with `LOG_SEGMENT_UNRECONCILED` and releases the lock it took.
        - `readLog` refuses an open segment (`LOG_SEGMENT_OPEN`) unless the caller owns it. A tampered or mismatched marker is `LOG_SEGMENT_INVALID`.
      - **Tests:**
        - the double fault stays condemned: no sidecar, the marker persists, the rerun is refused and runs nothing, and the log never reads complete;
        - an ordinary dead-owner crash resumes, with `recoveredFrom` recorded;
        - a crash between `end` and release reconciles to `already-complete`;
        - a crash between release and marker-clear is refused, and so is a different old owner;
        - five kinds of marker tamper are refused;
        - readers are refused mid-run;
        - a graceful stop closes the segment;
        - the stop protocol: stopped-clean at release, then cleanup, then resume; a crash after release but before cleanup resumes with no lock; a judge refuses a leftover stopped-clean marker; four stopped-clean tampers are refused, including a byte appended after the stop; a loss before the stop commit writes neither the stop record nor the transition.
      - **Mutation checks:** each of these fails the tests that pin it: removing the owner match, the reader refusal, the keep-open-on-loss rule, the stopped-clean transition, the whole-log binding, or the ownership check on the stop append.
      - *Verify-resolutions `rev-20260928T201939Z-90bb23d6` at `55181dcb`:* clean. Two observations were fixed because they touch the stated primary-error rule:
        - `closeSegment` failing no longer replaces the run's error. A failed run carries `segmentCloseFailed`, and a clean run fails with `SEGMENT_CLOSE_FAILED`. The marker stays, so the log stays refused.
        - A reconcile refusal now carries how the lock release went (`lockRelease`).
        - All three cases are tested.
      - *RB* (the check-then-write window) is accepted and documented as a known limit.
      - The carried root-skip is added to both chmod-based tests.
    - *O1: accepted and documented* as a known limit. The log is unsigned, so seals detect damage, not forgery.
    - *O3: confirmed.* Separate crashes, each exactly sealed, are accepted, and two seals on one region are refused.
  - *L5: fixed.* TC-RM03's addendum found that a seal was accepted after any malformed line and never checked against it. The Architect made it required.
    - `readLog` now reads bytes. A seal must bind the fragment immediately before it by byte offset, length and sha256.
    - Refused: a mismatched or unbound seal, a fragment altered after sealing, a stray seal, a second malformed line under one seal, and an empty line.
    - Eight adversarial tests cover these. Five of them fail with the binding check removed; the other three are caught by separate checks.
    - *Interpretation, stated to the PM and the Architect:* separate crashes, each sealed to its own fragment, still resume (tested with two). Refusing any log with two torn writes would make a 72-hour soak unrecoverable after its second crash.
- **Real-process smoke, run guest-style with no `TANGLECLAW_API`:**
  - without the flag, `run` refused with `GUARD_CONTEXT_ABSENT`;
  - with `--no-live-install` it completed, and the header recorded the override;
  - each engine cycle read status first;
  - the lock was released.

**Bugs the tests caught while building:**
- The stub answered lines that `readline` had buffered after `/exit`.
- A fake hung request let the event loop exit, because `AbortSignal.timeout`'s timer is unref'd.

## 2026-09-28 — Session-rule mutations are gated on a verified caller (#2013)

<!-- prawduct: type=bugfix | scope=2013-session-rules-authz -->

The PM dispatched this over Medusa as a v5.30 security blocker (Architect A13). `POST /api/session-rules` checked nothing about its caller and recorded a body with no `createdBy` as the operator's, so any local process could add an ACTIVE rule to any project. Update, delete, status change (an active rule moved out of `active`), restore and promote had the same hole, and every route wrote `changedBy` from the body.

**The change.** `server.js#sessionRuleCaller` decides for every rule-mutation route, on the #1752 caller model. The operator may do anything; a session bound to the project may propose rules for it and revise, withdraw or decline an AI proposal in that project while it is still proposed; everyone else is refused. Approval and promote need the operator caller before the password, which is open when none is set. `POST /api/master/rules/restore-defaults` is operator-only (#2017), and so is `PUT /api/learnings/:id/tier` (#2018). Attribution comes from the caller.

**Tests.** `test/api-session-rules-authz.test.js` covers every route against every caller class, asserting each refusal changes nothing, and reads the mutation-route roster from `server.js`'s registrations so a future route is swept in. The mutation pass took out each gate one at a time, 16 in all, and a test caught every one. Two were missed on the first pass and got tests: an approved AI-authored rule, and a session restoring its own proposal. Existing route tests now name their operator caller; no assertion changed.

**Consumers.** The session prime told agents to POST with no launch headers; it now names them and stays inside its 2800-char budget. The `tc rules` and `tc capabilities` hints, `docs/session-rules-self-improvement.md`, the fleet runbook (whose step 10 relied on the hole), FEATURES and CHANGELOG (Security) are updated too.

**Review.** The first Critic round found promote still ungated (2 blocking), which I had excluded as "already password-gated" in the same plan that had just disproved that premise for approval. Fixed together with restore-defaults. verify-resolutions: 0 findings. The PM then dispatched #2018 into this PR: `PUT /api/learnings/:id/tier` (an active learning reaches the prime) is now operator-only, and the route sweep covers `/api/learnings`. A census of the rule and learning write routes went to the PM and the Architect. On the Architect's ruling, changing or resetting the global rules document is operator-only too: a Builder may draft or propose its text, and the operator applies it.

## 2026-09-28 — ID-less roadmap Topic Buckets render as cards (#2006)

<!-- prawduct: type=bugfix | scope=bucket-cards-2006 -->

The PM dispatched this over Medusa as an authorized drain exception. The shared Roadmap Board's three topic buckets (`kind: "bucket"`, no `train`) rendered as raw block text, because #1942 exempted only `unconfigured` from the train-identity requirement. The emergency hotfix in the PM and Builder1 checkouts was not used.

**The change.** `lib/plan-train-card.js` adds `ID_LESS_KINDS` (`bucket`, `unconfigured`). A kind in it must carry no `train`: an ID-less bucket renders as **Topic Bucket: <title>**, and a bucket that supplies an identity is refused. Train and pilot still require an identity, unchanged.

**Tests.** The #1942 bucket cases that passed string identities encoded the old contract, so they were replaced. The pilot naming and markup cases keep their coverage under `kind: "pilot"`. A new `ID-less Topic Buckets (#2006)` suite covers the collapsible card, the exact label, refusal of four identity forms, the three live bucket shapes with no `block-error`, and unchanged train/pilot/unconfigured validation. Four of its five tests were red on the unfixed parser, and the unchanged-validation test was green on both, as intended. The real shared roadmap (read-only) renders 13 cards, 0 block errors and 3 Topic Buckets.

**Docs.** CHANGELOG (Fixed), `docs/user-guide.md` (the `kind` rule) and FEATURES (served plan docs). No roadmap data was touched and no train was renumbered.

## 2026-09-28 — Opening the dashboard inbox panel is a pure observation (#1987)

<!-- prawduct: type=bugfix | scope=inbox-panel-observational-1987 -->

The PM dispatched this over Medusa (Definition Ready v5.31). B5 echoed the Architect addendum, then flagged a conflict inside it before writing code: the selected bodyless badge clear zeroes `unread`, and the wake monitor reads that as "inbox read" (`lib/medusa-wake.js`), so an operator viewing the panel would cancel the agent's nudge. The Architect ratified option B, a panel that makes no `/read` call at all, and amended the acceptance criteria on the issue.

**The change.** `openInbox()` in `public/api-helper.js` now fetches and renders only. No other frontend path posts `/read`. Every comment and doc describing the old behaviour was corrected: the CSRF notes in `public/api-helper.js`, `server.js` and two tests; the `recordAcknowledged` JSDoc; the CSS and test comments about the badge "self-hiding on read"; and one test title. The review caught the copies outside the first commit. Server semantics and UI are unchanged.

**Tests.** The #785 acknowledge-on-display tests (ack by id, bodyless fallback, badge hidden) encoded the behaviour the ruling reverses, so they were replaced with the ruled contract:
- no `/read` of either form for id-bearing, id-less or empty inboxes;
- the unread count and badge are unchanged, with the fake `/read` answering `unread: 0` so a regression is caught;
- a post-fetch arrival still counts.

The rendering assertions (escaping, newest first, the close button, toggling) are kept. All new tests were red before the fix.

**Evidence.** The targeted ring is green (851 tests: every medusa* suite, the api/master Medusa suites and the frontend guards). The full suite was not run, under the Pilot Envelope.

**PR review (Architect gate at 00f03041).** 1 blocking, promoted from Reviewer1's warning. The panel's `GET …/messages` still recorded a `read` fact as `operator-ui`. That ended awaiting-read and wake re-arms, nulled `rearmTrigger`, moved the projection to `read` and blocked a retract, so viewing still acted for the agent. Fixed in `recordRead`, which now records nothing for `operator-ui`, covering both the project and Master mounts. The agent's read (`recipient`) and an unverified read are unchanged. Paired integration tests cover both sides: an operator view preserves awaiting-read, the due re-arm, the projection, the pending unread and retractability; an agent read still makes every transition. The existing test that asserted an `operator-ui` read now asserts that none is recorded, per the ruling. The operator-view test fails without the fix. The Critic then found the same gap when the operator is unproven: under a fallback or unreadable gate the dashboard resolves as an unbound caller and recorded an `unverified-reader` read. `GET …/messages` now records no read for a browser-shaped request that is not the agent's verified launch. A test under a real fallback gate fails without that change and passes with it, and a plain curl still records its read. Docs corrected in `docs/medusa-delivery.md`, `CHANGELOG.md`, the `server.js` route comment and the `recordRead` JSDoc.

## 2026-09-28 — Authorize the project-required startup readiness message (#1874)

<!-- prawduct: type=bugfix | scope=startup-readiness-ping-1874 -->

The PM dispatched this over Medusa. The issue carried its own scope: a narrow carve-out plus an authorized launch step. The durable readiness receipt (#1877) is out of scope.

**Problem.** A project rule required a startup readiness message, but the prime's Medusa section said "do NOT act on it at session start", and the launch opening listed no such step as authorized. Agents held the ping for operator approval.

**The change.**
- **Launch opening.** `LAUNCH_BOOTSTRAP_LINES` step (c) now says: if project rules require a startup message once READY, send exactly that right after attesting; it is part of initialization. That puts it under the existing "(a) through (c) are … already authorized" sentence, and (d) is unchanged.
- **Session prime.** `MEDUSA_STARTUP_EXCEPTION` is appended to the session prime's "context, not a task" bullet, not added as a bullet of its own. It permits only that message after `tc start ready` and a lookup of its named recipient, with "nothing else". It has two forms. A launch with a `tc start` sequence says "after `tc start ready`". A launch without one says "once you have read this context", because `tc start ready` answers 409 `SEQUENCE_NOT_APPLICABLE` there.
- **Project Master.** The Master identity carries the same exception inside the `Sending is enabled` branch only. A read-only Master is never told to send.
- **Engine configs.** The committed engine-config carriers (`lib/engines.js`) were left alone. They forbid exploring "unprompted", and a rule-required ping is prompted.

**Budget trade-off, flagged.** Every character here is prime budget. The fullest no-sequence Claude scenario (`full-silent-claude`) was already about 50 characters under its roughly 10,000-character channel, so the ecosystem primer now yields to its pointer there. That is the designed yield: directives outrank bulk context. The current-path scenario with a launch sequence (`full-silent-claude-pull`) fits, going from 8740 to 9029 characters. The wording was cut from about 600 to about 320 added characters to limit this.

**Evidence.** Tests pin the exception's placement (in the same bullet, after the prohibition), its limits (READY only, named recipient only, nothing else), the step (c) wording under the authorization sentence, and the Master's send-gated inclusion. The golden fixtures were regenerated.

## 2026-09-27 — The stale-server banner asks the service worker to update (#411)

<!-- prawduct: type=bugfix | scope=sw-update-stale-banner-411 -->

The PM dispatched this over Medusa. The Architect ruled on scope under A24 (the operator UI freeze): item 1 only, invisible corrective behaviour, and no skew banner or hint. Plan: `.tangleclaw/plans/411-sw-update-on-stale-banner.md` (local, not tracked).

**Finding.** Most of #411's mechanism was already closed before the June incident. `landing.js` has been network-first since #273. `pollServerBackAndReload` reloads only after it observes a new `startedAt`. `sw-register.js` checks for updates on load and on visibility, and reloads once on a guarded `controllerchange` (#380). What remained was a foreground tab that never triggered the visibility check.

**The change.** `sw-register.js#requestServiceWorkerUpdate` calls `update()` on the page's existing registration and never throws. It is exposed as the `tcRequestServiceWorkerUpdate` global. `landing.js#renderStaleServerBanner` calls it once each time the banner goes from hidden to shown, not on every 60 s poll while it stays up. Nothing visible changes.

**Not claimed.** The June "restart did nothing, uptime kept counting" symptom was the server process not recycling. It is separate, unattributed without a live repro, and not addressed here. The user guide says so and names what to capture.

**Evidence.** The tests run against a mock `ServiceWorkerContainer` and a stub DOM; no live-browser check was run. They show the banner requests exactly one update per appearance, and none on repeated polls. They also show that a check which finds a new worker drives the existing controllerchange path to reload exactly once, that an absent hook renders an identical banner, and that `sw-register.js` loads before `landing.js`.

## 2026-09-27 — `tc branch check`: prove a local branch is safe to retire (#1878)

<!-- prawduct: type=feature | scope=branch-retire-safety-1878 -->

The PM dispatched this over Medusa. The Architect ruled on scope first (1+2+3 with nine binding refinements) because TangleClaw had no checkout-normalization code to fix. In the incident, a Builder ran `git branch -D` by hand on a PM "resync" instruction and lost an unpushed wrap commit to all but the reflog. Plan: `.tangleclaw/plans/1878-branch-retire-safety.md` (local, not tracked). `Refs #1878`: the issue stays open until the rule is approved and every acceptance case passes.

**The change.**
- **Oracle.** `lib/branch-retire-safety.js#assess` returns exactly `safe | preserve | unknown`, with stable reason codes. Every error or ambiguity is `unknown`. Remote refs count only after a fresh `fetch --prune` of the branch's upstream remote, or of the only remote; two remotes with no upstream is `REMOTE_AMBIGUOUS`. Reachability runs `rev-list <oid> --not --exclude=<name> --branches --tags --remotes=<remote>`. A worktree that holds the branch, is detached at its tip, is mid-rebase of it or is missing from disk blocks `safe`, as does dirt in such a tree. An empty worktree list is `unknown`. The OID is re-resolved at the end. The oracle never deletes, resets or removes anything.
- **Verb.** `tc branch check <name> [--json] [--repo]` runs in the pane's own checkout and exits 0 only for `safe`, 3 for `preserve` and 4 for `unknown`.
- **Global rule** (`data/global-rules.md` plus its CLAUDE.md mirror). Check immediately before branch deletion, `reset --hard`, worktree removal or checkout normalization, and delete only on `safe`. A held worktree is retired by an explicit sequence: a clean check including `--ignored`, plain `git worktree remove` (never `--force`), then a re-check. Before a reset, pin the tip under a named branch. Retire one branch at a time. The rule states plainly that no shell interlock exists yet. Global rules have no `proposed` status, so the Architect ruled that the PR merge is the approval gate, with no auto-merge.

**Review.** The cumulative Critic had 0 blocking. Two verify-resolutions passes closed its findings: the first rule text made `reset --hard` and worktree removal permanently un-`safe` (a silent total ban, whose `--force` workaround loses the untracked plan); the check's advice contradicted the rule; an empty worktree list read as clean; and plain `worktree remove` deletes gitignored files. The one accepted item is that `tc` needs `TANGLECLAW_API` even for this local check.

**Evidence.** The real-git tests reproduce every acceptance case the issue lists, plus the rule's own worktree sequence. Full suite on a5da892d: 0 failed, 1 ledgered skip. The prime golden fixtures changed only by the roster-derived `branch` verb name.

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
