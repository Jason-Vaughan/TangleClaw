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

## 2026-10-15 — #2389 (refs): an exact record of every shared-doc revision, with attested authorship; delivery unchanged

<!-- prawduct: type=feature | scope=w2-a1-shared-doc-notices-2389 -->

v5.34.0 Wave 2 chunk W2-A1 part A1a, the first of two (A1b, row-aware delivery with mute and subscribe, is not released). Branch `feat/2389-shared-doc-event-record`. References #2389 without closing it. Governance class: notification and wake routing; the design is the Architect's A79 to A81 (plan rev 3 `a4c6b94f…`), and the code is read by the Architect at its exact head before the suite. Schema v67, allocated by the PM.

**Why.** A shared-doc change wakes every member session, whoever's row it touched, and nothing records which rows changed or who changed them. Row-aware delivery needs both, and needs them recorded exactly before any notice is withheld on their strength.

**What changed.** `lib/shared-docs.js` (new): each distinct digest observed of a doc is one revision, classified against a persisted baseline as `row` (every changed member project, by id), `unknown`, `formatting` or `first-seen`; the watcher, notify, a base capture and an attestation observe through one serializer per doc. Over the 8 MB baseline cap, or compared with such a baseline, a revision is digest-only: `unknown`, `attribution: incomplete`, no rows claimed. `lib/store.js`: v67 `shared_doc_events` and `shared_doc_baselines`, both cascading from the doc, with a postcondition; seqs are never reused. `server.js`: `POST /api/shared-docs/:id/attest` (`{"base": true}` captures a base; `{baseSha256, sha256}` attests; project callers only, 1 KB cap) re-reads the registration, access and the lock after its file read (a doc re-pointed or unregistered meanwhile records nothing, `DOC_CHANGED`; a base capture is re-authorized the same way) and binds the session and project in one statement; notify records without delaying its notice; `GET /api/shared-docs/:id/events` with `latest`, `oldestRetainedSeq` and `gap`. `lib/tc-verbs.js`: `tc docs base` and `tc docs attest` (no fetched base, no retry). Each revision carries a SHADOW `shadowWouldSelect`; the broadcast is untouched and sends what it always sent. Labelled ATTESTED authorship throughout: lock-holder attestation in a cooperative-writer model, not proof of who wrote the bytes. Docs: `data/shared-docs-guide.md`, `docs/medusa-delivery.md`.

**Tests.** `test/shared-docs-events.test.js` (classification, the shadow rule, restart baseline, the cap both ways, serialized concurrent observations, retention), `test/shared-docs-attest-route.test.js` (the plan's A1a criteria through the route with bound callers, every refusal leaving the binding unchanged, the stated unobserved-overwrite limit, the events route, and the CLI), `test/store-shared-doc-events-migration.test.js`; one case each added to the two broadcast tests (payload byte-identical; a failed record never stops a notice) and one to `test/launch-binding-routes.test.js`.

## 2026-10-15 — #2364: the Operator settles a merge queue entry stuck in landing

<!-- prawduct: type=feature | scope=w1-a2-merge-queue-2372-2364 -->

v5.34.0 Wave 1 chunk W1-A2 part A2b, the second of two (A2a, #2372, merged as `55ed0669`). Branch `fix/2364-settle-stuck-landing`. Closes #2364. Governance class: the design is the Architect's A60, A72 and A73, and the code is accepted by the Architect at its exact head before the merge.

**Why.** A merged pull request that GitHub will not name a landing for (no merge commit, or one that is not a merge of the submitted head) left its entry `landing` for good, and nothing behind it advanced. No route moved it; it needed a change to the records by hand.

**What changed.** `POST /api/merge-queue/entries/:id/settle-landing`, the Operator's alone (`OPERATOR_ONLY` for any project, the owner included), with a reference and an attestation, for an entry in `landing` only. It holds the queue's slot as an advance and a withdrawal do, reads the entry again inside it, and the store checks `landing` in the write, so of two settlements one is recorded. `landed` names a commit: it is read (`SETTLE_COMMIT_UNREADABLE`), the base tip is read now, and the commit must be reachable from it (`readAncestry` in `lib/merge-queue-github.js`, the compare call `readCompareFiles` already makes; `SETTLE_NOT_ON_BASE` otherwise). The tip never stands in for the commit; the tree decides a `TREE_MISMATCH` halt. `failed` is the Operator's disposition: the pull request is read now, and the queue halts `LANDING_SETTLED_UNRECONCILED` unless it reads back unmerged AND the Operator sends `mergeAttempt: 'unsuccessful'`; the answer calls an unmerged read a snapshot, never proof. Every GitHub read is required and an unreadable one refuses `503` with nothing changed. An existing halt is kept, code and detail; a settlement that would itself halt records its reason as a further `queue-halted` event, one that would not adds none, and `settlement.haltReasonRecorded` says which. `recordLanded`'s own tree-mismatch halt now keeps an existing halt the same way. The candidate's branches are removed only after the write, only the entry's recorded `tc-queue/` branch, never a name made from its id or one another unfinished entry records; a skip is reported, a failed removal is retried by the next advance under the same checks (`cleanupRefFor`, `cleanupFinished` in `lib/merge-queue.js`, which now also owes cleanup for a settled failure). `docs/merge-queue.md`: the route, a "Settling a stuck landing" section, the refusals, `readAncestry`, and the Limits bullet replaced. No schema: the codes live in existing free-text columns and event details.

**Tests.** `test/merge-queue-api.test.js` (12 cases, through the route with bound callers): both of the issue's reproductions, every refusal and unreadable read with nothing changed, callers and bodies refused before any read, a repeated settlement, a settlement refused while the slot is held, two at once, an entry leaving `landing` mid-read, halts kept, the three `failed` cases, and cleanup skipped, failed and retried. `test/merge-queue-store.test.js` (11), `test/merge-queue-advance.test.js` (6: no advance reaches `failed` from `landing`; the retry's ownership checks), `test/merge-queue-github.test.js` (6 plus `readAncestry` in the failed-read loop, replaying the recorded comparisons), `test/launch-binding-routes.test.js` (the route is guarded). Run against `origin/main`'s code, all 37 new or changed cases fail.

## 2026-10-15 — #2371 (refs): the CI-as-suite governance packet, for the Architect's acceptance; nothing put in force

<!-- prawduct: type=docs | scope=w1b2-ci-as-suite-activation -->

v5.34.0 Wave 1, chunk W1-B2, its one chunk (doc-only, as the Architect's A61 scoped it). Branch `docs/w1b2-ci-as-suite-packet`. References #2371 without closing it: the packet is not activation.

**Why.** #2321 built the evidence tooling; what #2371 still needs is not code here but three decisions outside this repository: Prawduct accepting CI evidence, the Operator activating a lane rule, and one measured chunk. A61 asked for the packet those decisions are made on, with the Prawduct claim traced rather than searched for. The trace of the installed 3.6.1 shows every gate that reads suite evidence reads only `.prawduct/.test-evidence.json` and the store's `test-run` facts, written only by `test-evidence record`, whose `--from-junit` stamps the local tree whatever the report's origin. So a rule cannot come first.

**What changed.** The packet itself is a lane plan, `.tangleclaw/plans/w1b2-ci-as-suite-packet.md`, untracked and served at its plan link: the trace (readers, the one writer, line references, the executable's digest); the upstream report's bytes by digest; the replacement Builder (#262/#264, clause 4) and Integrator (#266, clauses 1 and 2(d)) texts, each made by replacing only the named sentences, with full texts and digests; the measurement protocol with the measured Wave 1 suite times; the live tooling check, two parts done and two owed. `docs/prawduct-feedback.md`: the upstream draft rewritten as one fenced block (the only bytes that would be sent; scrubbed of paths, hosts, accounts, numbers of this install), with the 3.6.1 trace, `ci_evidence_command:` as the preferred ask, and baseline, measured and target figures kept apart (measured: runs started 15:00 to 16:50 PDT on 2026-10-15, four completed and one killed, with each run's receipts in the notes outside the block); still NOT SENT. `docs/lane-ci-evidence.md`: the opening and the "changes nothing a gate accepts" paragraph state the trace; the proposed section gives the activation order (Prawduct, then the rule bound to this page's accepted revision by digest, then the complement verified before first use, then exactly one pilot chunk named at plan approval, which needs the charter's pre-suite order amended by name, then broader use decided separately from the pilot's time and safety results), makes Prawduct's acceptance the rule's first condition, requires the reviewer to read the workflow at the exact commit, bans recording CI's result by hand, keeps the nine exceptions, names the four rule sentences it would change, and records that a lane host can skip tests CI runs (`test/engine-temp-root.test.js` on a host whose `/tmp` is not sticky); still NOT IN FORCE.

**Tests.** No code changed. `test/ci-evidence.test.js`'s four document assertions (the NOT IN FORCE heading, the opening, the nine exceptions, NOT SENT) pass on the edited files.

## 2026-10-15 — #2372: the merge queue will not land while its owner has an unhandled message

<!-- prawduct: type=feature | scope=w1-a2-merge-queue-2372-2364 -->

v5.34.0 Wave 1 chunk W1-A2 part A2a, the first of two (A2b, #2364, stays design-held). Branch `fix/2372-merge-queue-unread-guard`. Closes #2372. Governance class: the design is the Architect's A60, and the code is accepted by the Architect at its exact head before the merge.

**Why.** On 2026-10-12 a pull request was merged while its authorizer had an unread message objecting to it. Nothing in the queue looked at the owner's inbox, so an approval nobody had read could be acted on and an objection nobody had read could be passed over.

**What changed.** `lib/merge-queue.js`: a landing reads the owner's inbox last, then asks the caller's guard, then records `landing-started` and sends the merge request, with nothing awaited between them. Any message still unhandled refuses it `AUTHORIZER_MESSAGE_UNREAD`, naming each by id and sender and never its text; an inbox that cannot be read refuses it `AUTHORIZER_INBOX_UNREADABLE`; an advance given no inbox check lands nothing. Either refusal changes nothing: the entry stays `testing` with its candidate. Assembly, discards, failures and branch cleanup read no inbox. `lib/merge-queue-api.js`: the inbox is that of the session behind the launch the request was verified as, never one the request names; the binding is resolved again at the read, so a launch that has ended or been replaced cannot land, and a listener that is not listening reads as unreadable, never as empty. A message whose envelope `from` is `system` is counted and does not block; the body is never judged. `lib/merge-queue-store.js`: `landing-started` records the head, base and candidate, and the check's binding (project, launch, session), time, listener state and count of system notices left out, keeping only those fields; a malformed check is refused. `docs/merge-queue.md`: the landing table, a paragraph on the inbox, two refusals, and three limits (a hand merge is not guarded; the check is a snapshot that misses mail in transit; a process reaching the Bridge directly can pass as `system`). An owner project without the switchboard can no longer land through the queue.

**Tests.** `test/merge-queue-advance.test.js` (8 cases): unreadable, absent and empty checks, an unhandled message, the record after handling, the order inbox, guard, merge request, a guard refusing after a clear inbox, and the steps that merge nothing. `test/merge-queue-api.test.js` (9 cases, through the route with bound callers): no listener, a listener not listening, the bound session's inbox only, an unread approval, an objection arriving mid-landing, a system notice against a peer posing as one, landing after handling, assembly unaffected, and a launch ended and replaced mid-landing. `test/merge-queue-store.test.js` (3 cases): the record, field stripping, malformed checks. The existing API advance tests' shared setup now gives the owner a listening, empty inbox; no existing assertion changed. Run against `origin/main`'s code, 18 of the 20 new cases fail; the other two check that steps which merge nothing read no inbox, which was already so.

## 2026-10-15 — #2304/#2408 (refs #2412): a checkout fingerprint leaves no git running when its deadline ends, and the wedged-tmux test counts what it started

<!-- prawduct: type=bugfix | scope=w1b1-fingerprint-and-tmux-test-races -->

v5.34.0 Wave 1, chunk W1-B1, its one chunk. Branch `fix/w1b1-fingerprint-orphan-git`. Fixes #2304 and #2408; closes #2045 by reference (already fixed by `c95d855d`, #2061's PR, which never named it); references #2412 without closing it, because its own failed run was not reproduced.

**Why.** `fingerprint()` races each git call against its deadline. When the deadline won, it returned `deadline` at once, and the git it had started kept running in the checkout until `execFile`'s own timeout killed it. Reproduced on demand against `main`'s code with a stand-in git at the `status` call (9 of 9 failed): a hung or SIGTERM-deaf git was still alive when `fingerprint()` returned, and with a git writing inside `.git`, removing the repository at once threw `ENOTEMPTY: directory not empty, rmdir <tmp>/.git/…`, #2304's error. Node's test runner reports an `afterEach` failure as a failure of the test before it, which is how #2304 appeared on the early-timer test; #2412 failed on that same test with its message lost, and is probably the same failure, unproven (that test passed 200 of 200 alone on `main`). In the product the same orphan can leave `git status` holding `index.lock` in a live checkout after a rotation's fingerprint times out. Separately, #2408: the wedged-tmux test counted started commands from the stand-in's own log, which the stand-in wrote only after forking `cat`; killed at 300 ms on a loaded host before that line, it read 0. Reproduced by delaying the stand-in's start by 0.5 s: `main`'s test fails with #2408's exact `0 !== 1`.

**What changed.** `lib/checkout-fingerprint.js`: a git call the deadline ends is aborted; `_runGit` sends SIGTERM (git removes its own lock files on it), then SIGKILL after `KILL_GRACE_MS` (1000 ms), and settles only once the child has exited. `fingerprint()` waits for that, bounded by the grace plus `REAP_MARGIN_MS` (500 ms) so a runner that ignores the abort cannot hold it; a timeout is still told by the `DEADLINE` sentinel, never by the clock. The program run is a seam (`_seams.bin`). No caller changes: they only await the result, which can now come up to 1.5 s after the deadline.

**Tests.** `test/checkout-fingerprint.test.js`: four new cases through the real runner and a stand-in git (hang, deaf to SIGTERM, writing inside `.git`) and a runner that ignores the abort: each ends as `deadline`, with the child gone at return, the repository removable at once without retries, and the return bounded. The stalled runners in the two existing deadline cases now settle on abort, as the real runner does. `test/tmux-read-pane-async.test.js`: the two wedged-read cases count children from the spawn, through the `tmux._async.execFile` seam, not from the stand-in's log; the stand-in logs its pid first. The reads in that file whose assertions are about what is answered, not how fast, now share one generous named timeout (`ANSWER_TIMEOUT`, 60 s): on a run beside a full suite (load 13) two of them hit the 5 s default on the first session probe; the four timeout cases keep their own short bounds. No assertion was weakened.
## 2026-10-15 — #2417, #2365, #2312: the bridge's status pages say what shipped, and three doc pointers are corrected

<!-- prawduct: type=docs | scope=w1-a1-docs-2417-2365-2312 -->

v5.34.0 Wave 1 chunk W1-A1, the only chunk of its plan. Branch `docs/w1a1-bridge-status-pointers`. Closes #2417, #2365 and #2312. The status wording is a public statement, accepted by the Architect (A60 limits, A62 corrections, A63 acceptance) before the suite; the cutover facts are the ProjectManager's.

**Why.** The operator bridge and its Discord helper shipped in v5.31.0, but three pages still said the helper had never run against Discord and that cutover had not started, and no entry page led to the bridge (#2417). `docs/merge-queue.md` listed four of the six codes an entry fails with (#2365). The user guide sent readers to a "pane-check section" of the engine guide that does not exist (#2312).

**What changed.** `docs/operator-bridge-helper.md`, `docs/operator-bridge.md` and `docs/discord-operator-notifications.md`: shipped in v5.31.0 as a fact about the release; off by default; cutover per install; the direct procedure applies only where an existing rule explicitly authorizes it, and a fresh install has none; Rule #188 and #145 dates given only as the project's own install's identifiers; the fresh inbound round trip (#1836) and the live `lane-silent` / `gateway-down` / `gateway-recovered` notifications (#2262, #2272) still unproved. The helper page gains a fresh-install quick start that links its own steps, and its bot-token paragraph tells a fresh install to use `set-secret bot`. `README.md`, `docs/setup-guide.md` and `docs/user-guide.md` each gain a short "Discord operator bridge" section. `docs/merge-queue.md` names `CANDIDATE_CONFLICT` and `NOTHING_TO_MERGE`. The user guide links the engine guide's "The ambient-awareness floor (`tc` on PATH)". `docs/discord-operator-notifications.md` also no longer calls the bridge a "Future path" (heading, one subheading and its closing line, accepted in A64). One wrong cross-reference fixed on the way: the rollback bullet's interim section is above it, not below. The older #2363 entry that #2365 also mentions is left as written.

**Tests.** New `test/docs-w1a1-pointers.test.js`: each entry page has exactly one bridge section linking all three bridge pages; every relative link and anchor in those sections, the helper's status and the user guide's pointer resolves to a file and heading that exist; no bridge page keeps the stale claims or says a direct procedure is in force everywhere; no page says "supported since v5.31"; `docs/merge-queue.md` names every code in `FAILURES`. Run against `origin/main`'s pages, 7 of its 8 cases fail; the eighth is a guard those pages already met.

## 2026-10-15 — #1380/#2142: a public guide to moving TangleClaw to another machine

<!-- prawduct: type=feature | scope=host-migration-guide-1380 -->

#1380/#2142 chunk G, the second of two (H, the host check, merged first). Branch `docs/1380-host-migration-guide`. References #1380 and #2142 without closing either. The contract is chunk G of the host-migration follow-ups packet (TC-Lane-A's plan for #1380, not in the repository), as corrected by the Architect's A11 and accepted in A12; its source is the ProjectManager's reviewed draft guide.

**Why.** A real migration showed that moving an install mixes two layers (a name that resolves, and a name TangleClaw answers to) and two different procedures (a planned move with a fresh identity, and recovery from an accidental clone). Nothing in the repository said how to tell them apart, or how to change only what was diagnosed and undo it exactly.

**What changed.** New `docs/host-migration.md`: the two layers; the two migrations as separate sections (clone recovery never logs out or revokes the source while it shares the identity); a before-the-move checklist with a consistent, verified SQLite backup of the database (`.backup`, `PRAGMA integrity_check`), never a live-file copy; how to run `node scripts/host-check.js [--reveal]`, its row states and exit codes, what it never prints, that it is not network-silent, and why a direct-mode HTTPS install may read `unknown` on its routes row (`lease comparison: tls-unverified` means only that validation failed: diagnose trust, validity and names, and never re-mint on that row alone); then each change (re-trust, mint, serve route, Caddyfile hand edit, the last only with a tested recovery path independent of TangleClaw and a restore plan) with the row that triggers it, the snapshot taken first and the exact state its rollback restores; proof per name from another device; renaming; rollback triggers; today's limits. Placeholders only. One link line each in `docs/recovery.md` and `deploy/INGRESS.md`.

**Tests.** New `test/host-migration-guide.test.js`: a shape-based privacy linter (private, CGNAT and unique-local addresses other than the `100.64.0.10` placeholder; `*.ts.net` and `*.local` names other than all-placeholder ones; absolute home paths; UUID, launch-id and workspace-id shapes), run against synthetic sentinels so a rule that stops matching fails, and against the guide. It also checks the guide's exit codes and row states against `lib/host-check.js`, and that every script it names exists. No deny-list of real values is in the repository; the private scan ran outside it.

## 2026-10-14 — #1380/#2142: the host check prints an error code only when it is on a finite list of known codes

<!-- prawduct: type=bugfix | scope=host-check-error-codes-1380 -->

#1380/#2142, the second redaction follow-up to chunk H, required by the Architect's A23 before H is called share-safe, released or deployed. Branch `fix/1380-host-check-error-code-allowlist`. References #1380 and #2142 without closing either: chunk G remains. Merges only on the Architect's acceptance of its exact head.

**Why.** The entry below kept an error's `code` when it matched `/^E[A-Z0-9_]{1,63}$/`. That is a spelling filter, not a list: a thrower can set any `code`, and a secret spelled like one (`ERR_TOKEN_SECRET123`) passed it into the internal-error reason, the `--reveal` diagnostic, the local-resolution result and the CLI's failure line. Root cause: "shaped like an errno code" was treated as "is a known errno code", and every sentinel the tests seeded was lower case or held a path, so none passed the filter.

**What changed.** `lib/host-check.js` replaces the pattern with `KNOWN_ERROR_CODES`, a finite list of the codes this check's own calls can raise: file reads (`ENOENT`, `EACCES`, `EPERM`, …), `dns.lookup` (`ENOTFOUND`, `ENODATA`, `EAI_AGAIN`, …), the local ports request (`ECONNREFUSED`, `ETIMEDOUT`, …), running a command (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) and Node's argument checks (`ERR_INVALID_ARG_TYPE`, …). Any other code, however it is spelled, gives the same fixed text as no code: `internal-error`, `lookup-failed`, or a diagnostic of the error class alone. The module header, `safeErrorCode`'s JSDoc and the CLI's comment no longer call a shape a closed set. An operator sees no change unless a code outside the list was thrown.

**Tests.** `test/host-check.test.js`: three synthetic secrets spelled exactly like codes (`ERR_TOKEN_SECRET_QX7`, `ESECRETQX7`, `EAI_QX7`) go through every path that prints a code: a thrown row (reason and `--reveal` diagnostic), a lookup failure (default and `--reveal`), the CLI's failure line, and `safeErrorCode` itself, which also now refuses `EFIXTURE`. The CLI's positive case uses `EACCES`, a real code. Run against the module as merged in #2410, the four new or extended cases fail and the rest pass.

## 2026-10-14 — #1380/#2142: the host check prints no raw value from a file or a command, and no error message even under `--reveal`

<!-- prawduct: type=bugfix | scope=host-check-redaction-1380 -->

#1380/#2142, the redaction follow-up to chunk H, required by the Architect's A22 before H is called share-safe, released or deployed. Branch `fix/1380-host-check-redaction`. References #1380 and #2142 without closing either: chunk G remains.

**Why.** The redactor shows a value of kind `code` verbatim, and a row's reason is printed as written. H labelled some values `code` that came straight from a hand-editable file or a command: `config.ingressMode`, the topology marker's version, Tailscale's `BackendState`, and an error's `code`. Those values could carry a name, path or secret past redaction. And `--reveal` printed a thrown error's message and stack frame, which breaks its promise never to show credentials. Root cause: redaction was decided by the field's label, not by where the value came from. H's redaction test seeded sentinels only in the fields H already redacted.

**What changed.** In `lib/host-check.js` every value read from outside reaches a code or a reason only through a closed set:

- `ingressMode`: `direct` or `caddy` (the set `server.js` accepts; absent means `direct`). Anything else prints `unsupported`, and the config row is `unknown: ingressMode-unsupported`. With no Caddyfile, that row reads `unknown: absent; ingressMode unsupported` rather than `observed`.
- The topology marker: only `v1` is kept. Any other version prints `marker of an unsupported version` and is never stored in the parse result.
- `BackendState`: Tailscale's own states map to `daemon-<state>`. Any other value gives `daemon-unrecognized-state`.
- Error codes (`internal-error:<code>`, the local-resolution result, the CLI's top-level failure line in `scripts/host-check.js`): kept only when shaped like a Node or errno code (`safeErrorCode`), else `internal-error` or `lookup-failed`. (Not a closed set: the entry above replaces the shape with a list.)
- The `/api/ports` row's reason for an unexpected HTTP status is `status-<n>` only when the status is an integer, else `status-other`.
- The diagnostic a thrown row keeps for `--reveal` is now its built-in error class and safe code (`TypeError EACCES`; a custom class prints as `Error`; a thrown non-error prints `non-error-value`). It never holds the message or a stack frame.

**Contract change, by ruling.** H's test "keeps the message for `--reveal` only" asserted `diagnostic: boom at /private/fixture/path` in the revealed output. A22 ruled that contract wrong, so the test now asserts the opposite: the message and stack never appear, and the diagnostic is the error class. This is not a weakened test.

**Tests.** `test/host-check.test.js`: each closed set with a sentinel value, checked against the default and the `--reveal` output. One run seeds a sentinel in every input at once (config fields, Caddyfile marker, hosts, tls paths, `basic_auth`, redirect query, Tailscale status and serve routes, lease project, lookup error, `security` output, hostname, home). The default output must contain none of them, and `--reveal` none of the ones that reach codes or reasons. A further case covers the CLI's failure line with a code that is not code-shaped. Run against the module as merged in H, every new case fails except the one pinning the default `direct`, which H already got right.

## 2026-10-14 — #1380/#2142: a read-only host check says what this machine's names, Caddyfile, certificates and trust actually are

<!-- prawduct: type=feature | scope=host-migration-check-1380 -->

#1380/#2142 chunk H, of two (H, then G, the migration guide). Branch `feat/1380-host-check`. The contract is chunk H of the host-migration follow-ups packet (TC-Lane-A's plan for #1380, not in the repository), as corrected by the Architect's A11 and accepted in A12.

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
