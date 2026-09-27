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

## 2026-09-27 — Rules lifecycle, Chunk 4: edits of a governing rule go through approval (#1696, #1709)

<!-- prawduct: type=bugfix | scope=rule-retirement-1696-1709 -->

Chunk 04 of 04, cumulative-final. Rulings 7 and 8 (PM d40bf543 and 437ddd43): the replacement-proposal design, and Option A on the stale-approval conflict.

**The change.**
- **Schema.** `replacement_origin` (`amendment` | `edit` | `restore`, CHECK-constrained) is added to the table definition and to the still-unshipped v51 migration's frozen DDL; the migration postcondition checks for it.
- **Edits.** `update()` with a text change to an active project rule (`_textChangesNeedApproval`: active and not Master) files a proposal via `create()` (origin `edit`, `status: 'proposed'`, `replacesRuleId` = the rule) inside the savepoint, applies any `enabled` in the same call to the rule itself, and returns the rule plus `replacementProposed`.
- **Rollbacks.** `restore()` does the same for a rollback to different text (origin `restore`), leaving the rule, switch included, untouched. A rollback that changes only the switch applies as before.
- **One pending per rule.** `update()` and `restore()` refuse with `REPLACEMENT_PENDING` (carrying `pendingReplacementId`), and `create()` refuses a second amendment with `INVALID_REPLACES`. Rejected replacements do not count. Chains and cycles are impossible because a target must be active.
- **Fail closed (Option A).** An `edit` or `restore` replacement whose target is not active at approval throws `REPLACEMENT_TARGET_INACTIVE` inside the savepoint, which undoes the approval. An explicit `amendment` keeps C1's `replaced: null`. The origin is set only by the store; the create route never passes it.
- **Routes.** `PUT /:id` and `POST /:id/restore` answer 202 with `replacementProposed`, and 409 `REPLACEMENT_PENDING` with the pending id. The status route maps `REPLACEMENT_TARGET_INACTIVE` to 409 with `targetId`.
- **UI.** An edit or rollback proposal reads "Edit of: <text> — approving replaces it", or "...which is now retired — it can no longer be approved". A 409 on approval explains itself and redraws the list.
- **C3 review carry-overs.** R-4: project ids are compared numerically. R-5: restore keeps `superseded_by`. R-8: the `list()` docstring.

**Final (cumulative) review** `rev-20260927T185142Z-4d706a82`: 0 blocking, 4 warnings, 4 notes.
- **R-2/R-4, fixed.** Edit-through-approval was keyed on status, so retire → edit (applied in place) → restore → switch on put unapproved text in force with no password. A retired rule's text is now immutable (`RULE_RETIRED`, 409, on both edit and rollback), and the test runs the four steps.
- **R-5, fixed.** A stale edit or rollback proposal shows only Reject.
- **R-6, fixed.** The creation event carries `replacesRuleId` and `replacementOrigin`.
- **R-3, routed to the Architect** and later ruled and fixed (below).
- **R-1.** At that point the evidence was degraded (a system-health timing flake). The full suite later passed cleanly at 342ec0fa and on the merged tree at ec9786b7. At the PR head 75e0eef1 it was degraded by three load-sensitive tests outside the rules surface (projects dir-scanner timing, system-health wall-clock, tc-cli #1960) at load average ~24, while every session-rules test passed. The evidence is recorded as degraded rather than green.
- **R-3, ruled and fixed (PM f690a64d).** Approving a replacement whose target was already superseded by a *different* replacement throws `REPLACEMENT_SUPERSEDED` (409, with `targetId` and `supersededBy`) inside the savepoint, for every origin, so the lineage stays single. A hand retirement still lets an amendment stand. The UI names the winning replacement and shows only Reject. The regression tests cover the Architect's exact sequence (reject A, approve sibling B, approve A: refused, only B governs), the edit variant, hand-retirement unchanged, and "latest retirement wins" after a restore. The mutant removing the guard fails 2 tests.

**PR-boundary cumulative review** `rev-20260927T192447Z-e8c17c32` (after the main merge and R-3): 0 blocking, 3 warnings, 3 notes. The PR reviewer, in parallel: 0 blocking, 1 warning.
- **R-1, fixed.** The wrap drawer's edit-then-approve read a 202 (edit filed as a replacement because the rule had been approved elsewhere) as the saved text, re-approved the OLD text and said "Approved ✓". It now says the edit was filed for approval and stops. There is a 202 widget test.
- **R-4, fixed.** The edit/rollback-through-approval sequence lives in one helper, `_proposeTextChange`, which both doors use and which always runs in the savepoint (the rollback path was not transactional before).
- **R-5, fixed, together with the PR reviewer's warning.** The docs table carries `RULE_RETIRED` and `REPLACEMENT_SUPERSEDED`, the amendment bullet is qualified, and the CHANGELOG has a rollback note for the v51 rebuild.
- **R-6, fixed for this branch.** The review ids are gone from shipped comments, docs and test names. A repo-wide lint is left as a follow-up.
- **R-2 and R-3, accepted and raised to the PM.** R-2: after restore → hand retire, a new amendment can govern beside the old replacement. That follows from explicit operator decisions, and the test now asserts it. R-3: the UI's approvability check is advisory; the server stays authoritative.

**PR #1971 review, N1 (Architect ruling, PM bad9e071).** Retirement is a destructive governance state, so `active → retired` is now gated by the operator password in the status route. The check runs before anything about the rule is read: a refused caller gets 403, not an INVALID_TRANSITION or 404. The Retire button sends a typed password and reveals the field on 403, like Approve. Restore stays ungated because it lands disabled. The earlier "retire needs no password" test became the 403 contract, with new with-password and refused-learns-nothing cases, and the UI password-send and 403-reveal tests were added. The docs, the lifecycle table and the CHANGELOG replace the old "deliberately ungated" reasoning. Mutation-checked: removing the gate fails 2 tests; the UI omitting the password fails 1.

**Existing tests reworked for the ruled contract, not weakened.** Tests that used "edit an active rule's text" only to generate version history (pruning, op constraint, critic_gate provenance, restore mechanics, `kind` survives a restore) now create their rule as `proposed`, whose text still edits in place. One of them ("kind survives a version restore") had started passing vacuously, and it now asserts the edit applied. The delivery digest test now also asserts that an unapproved edit does NOT change the delivered set, and that approving it does. The API critic-gate test keeps its operator-create check, adds the 202 path, and runs the in-place checks on an AI proposal.

**Tests.** Store (19 new: proposal filing, approve/reject, one-pending in both directions, fail closed for retired and deleted targets, the amendment contract unchanged, enabled with content, no-op text, proposal and Master in-place edits, rollback as proposal with fail-closed and switch-only, no chains or cycles, both carry-overs). HTTP (5: 202, 409 pending with id, 409 target inactive with id, restore 202, origin not settable). UI (2). Mutation-checked six mutants: an active edit applied in place, edits not failing closed, `update` or `create` ignoring pending, a rollback applied in place, and the route passing the origin. Each turns tests red.

## 2026-09-27 — Rules lifecycle, Chunk 3: the Rules Graveyard in Project Rules (#1696, #1709)

<!-- prawduct: type=bugfix | scope=rule-retirement-1696-1709 -->

Chunk 03 of 04. Authorized with rulings 6 and 7 (PM d40bf543): the allow-list is ratified, and the C4 replacement-proposal design is approved, with one open conflict against ruling 2, asked as a blocking question.

**The change.**
- **`renderProjectRulesList`** shows live rules only (proposed and active). Active rows get **Retire** (with a confirm); a replacement proposal shows "Approving retires: <text>", or the id when the target is not in the fetched set.
- **The new `renderRulesGraveyard`** renders a closed `<details>`: retired rows with "Replaced by: <text>" (or `rule #N`), the retire time, and **Restore**. It renders nothing when no rule is retired.
- **`retireProjectRule`** confirms first, then retires with no password. **`restoreProjectRule`** sends a bare `{status: 'active'}`, and its status line says the rule came back switched off. Both refresh the list; a failure is reported, not claimed as success.
- **CSS:** 44px targets, and muted text via `--text-muted`.
- **Docs.** The docs UI paragraph, the post-upgrade retire step (ruling 3), FEATURES and the CHANGELOG. The store JSDoc and docs now say the allow-list is ratified.
- **Operator verification:** VRF-001 in the local queue covers layout, phone width, disclosure behaviour and themes. Render, escaping and wiring are pinned by tests.

**Tests.** `test/project-rules-unknown.test.js` (#1054) had its own sandbox without the new helper or the #1053 shown-content map; both are added. Its handler-count guard now expects six mutation handlers (retire and restore joined add, toggle, delete and decide), and they all still re-read through the three-state refresh. The guard's real check, that `fetchProjectRules` is called only from the refresh, is unchanged. `test/project-rules-modal.test.js`: the #1053 harness now builds `renderRulesGraveyard`, `retireProjectRule` and `restoreProjectRule` from source, with a real escaper. Cases cover live/graveyard separation, the no-graveyard and ghost-only empty states, an unknown successor id, Retire on active rows only, the escaped replacement line, escaped retired and successor text, a declined confirm sending nothing, the Retire and Restore request bodies, a refused Retire reported honestly, handler routing, and the CSS targets.

## 2026-09-27 — Rules lifecycle, Chunk 2: routes, tc rules, and no rejecting an active rule (#1696, #1709)

<!-- prawduct: type=bugfix | scope=rule-retirement-1696-1709 -->

Chunk 02 of 04. The PM authorized it (4718a04b) together with the Architect's W5 ruling.

**The change.**
- **`POST /api/session-rules`** passes `replacesRuleId` to the store and maps `INVALID_REPLACES` to 400. It is no longer dropped at the route either.
- **Status route: retire and restore.** It is the lifecycle's one door (ruling 1). `retired` and a restore need no password. Without the password, `active` is accepted only as a restore: the route sets `restoreOnly`, and the store then refuses anything but `retired → active` (`APPROVAL_REQUIRES_AUTHORITY`, answered as 403). That closes the window between the route's read and the write.
- **Status route: errors.** `INVALID_TRANSITION` maps to 400. An unknown rule without the password still answers 403, as before.
- **W5 ruling.** `setStatus` refuses `active → rejected` with `INVALID_TRANSITION`, atomically, and retire still succeeds.
- **`tc rules`.** The footer says retired rules are never in force and how to amend with `replacesRuleId`. It is carried there, not in the ecosystem primer, which sits at 2764 of its 2800-character cap and would have needed a budget decision.
- **Carry-over O-4.** The wrap-reader test now calls `listWrapRules` itself.
- **Two pre-existing tests encoded the move the W5 ruling forbids** (`test/self-improvement-loop.test.js`): "approve and reject, recording each as a version" rejected an active rule, and "drops a rule out of injection the moment it is rejected" did the same. Each keeps its intent through a path the ruling allows: reject, then approve (both decisions still snapshotted on one rule), and leaving force by retire. This is the contract change the ruling made, not a weakened test.

**Chunk review** (`rev` at 7db44006): 1 blocking, 1 warning, 4 notes.
- **Blocking, fixed.** An active rule could still be rejected in two password-free steps (active → proposed → rejected), because `setStatus` refused named moves and allowed everything else. It now enforces an allow-list, `SESSION_RULE_TRANSITIONS` (exported). The docs lifecycle table renders it between markers, and a test holds the two to each other. `active → proposed` and `rejected → proposed` are refused; no product surface used either (both UIs send only `active`, `rejected` and `retired`).
- **Warning, fixed.** Master rules cannot be retired, which would have bypassed their `confirmBaselineEdit` path. Replacements already excluded them, and ruling 4 keeps Master rules outside this contract.
- **Tests.** An exhaustive check of every from/to pair (allowed moves succeed; refused ones change neither status nor history), the two-step route, docs sync, and a Master retire over the store and HTTP. Mutation-checked: reopening `active → proposed` fails 2 tests; a move in code but not in the docs fails the sync test.

**Tests.** Store (W5: status, text, history and delivery unchanged, plus the disabled-active case and retire still working; `restoreOnly`). HTTP (the create link and INVALID_REPLACES; approval `replaced` and `replacementSkipped`; `PUT /:id` refusing the field; ungated retire and restore; INVALID_TRANSITION; the approval gate unchanged; 403 for an unknown rule). `tc rules`. Mutation-checked seven mutants: restore gated, `restoreOnly` ignored, `active → rejected` allowed, `replacesRuleId` dropped at POST, INVALID_TRANSITION unmapped, the footer removed, and `listWrapRules` losing its filter. Each turns tests red.

## 2026-09-27 — Rules lifecycle: retirement and supersession, Chunk 1: schema v51 and store transitions (#1696, #1709)

<!-- prawduct: type=bugfix | scope=rule-retirement-1696-1709 -->

Chunk 01 of 04. The PM dispatched it (0f6fd06f). Architect rulings 1-4 (cc2f6e32): (1) the existing status route; (2) a replacement whose target is inactive still approves, with `replaced: null` and an audit detail; (3) no install-specific ids in the migration; (4) edits to an active project rule go through approval. Ruling 4(a) first said to demote the rule to proposed; Chunk 04 shipped the Architect's later refinement (ruling 7), where an edit files a replacement proposal and the rule keeps governing. Plan: `.tangleclaw/plans/1696-1709-rule-retirement.md` (local, not tracked).

**The change.**
- **Schema v51.** `'retired'` is added to the status CHECK, plus `replaces_rule_id`, `superseded_by` and `retired_at`. SQLite cannot alter a CHECK, so the table is rebuilt with rows verbatim and foreign keys off outside the transaction. A postcondition refuses to advance the version.
- **Table definition.** Fresh installs build the table from `_sessionRulesTableDdl()`. The v51 migration carries a frozen copy, and a test asserts that an upgraded store equals a fresh one. Pre-existing drift fixed: fresh installs never had `idx_session_rules_status`, because only the v26→v27 migration created it. It is now created after migrations in `init()`, not in the base schema, which would break a pre-v27 store that has no status column yet.
- **Transitions** in `setStatus`: retire only from `active` (the #1709 operator ruling); restore only `retired → active`, landing `enabled: false`; everything else into or out of `retired` is refused with `INVALID_TRANSITION`. `create` refuses a born-retired rule.
- **Supersession.** Approving a replacement retires its target atomically with #1053's CAS (the store's savepoint helper, so it also nests). The CAS runs first and throws inside the transaction, so a refused approval retires nothing. An inactive target yields `replaced: null` plus `replacementSkipped: {id, reason}` in both the result and the activity log (ruling 2). A replacement created already active retires its target at once.
- **replacesRuleId** is validated at create (`INVALID_REPLACES`: missing, non-integer, another project or kind, not active, Master) and refused by `update`, not ignored.

**Chunk review** (`rev-20260927T151645Z-8d41bfea`: 0 blocking, 6 warnings, 9 notes). Fixed before Chunk 02:
- The result shape now matches Architect ruling 2 exactly: `replaced: null` plus `replacementSkipped: {id, reason}`.
- `projectsWithUndeliveredRules` counts only active rules. Before, retired rules and, since #569, proposals raised false "undelivered" alarms.
- The missing reader tests are added (wrap, Master, conflict candidates).
- Supersession uses the savepoint helper, so it also works inside a caller's transaction.
- `criticGate` is validated before any write.
- Un-retiring logs `session_rule.unretired`, distinct from the version-rollback `restored`.
- The v51 migration carries a frozen copy of its DDL, and a new test asserts that an upgraded store equals a fresh one.
- The docs record why retire needs no password.

W5 (an active rule can be set to `rejected` with no password, leaving both the list and the Graveyard) predates this work and is routed to the Architect.

**Tests.** `test/session-rule-lifecycle.test.js` (new). `test/workload-receipts.test.js`'s upgrade assertion now compares against `CURRENT_SCHEMA_VERSION` instead of a literal 50, because a later migration runs after v50 on the same upgrade. Its table assertions are unchanged, so this is not a weakening. Mutation-checked eight mutants: retire from any status, restore leaving `enabled`, target status unchecked, a live replacement not retiring, `update` ignoring the field, retire-before-CAS without a transaction, an inactive target throwing, and a born-retired rule. Each turns tests red.

## 2026-09-27 — Rule approval compare-and-set: approval ratifies only the text the operator saw (#1053)

<!-- prawduct: type=bugfix | scope=rule-approval-cas-1053 -->

Chunks 01 and 02. The PM dispatched it over Medusa (874d9163) and authorized Chunk 02 (dfa9976c). The Architect ruled A, B and C (3802bf4d): A and B are approved; C rejects folding the adjacent active-rule edit hole into this work, so it is recorded for the #1696/#1709 ruling instead. Plan: `.tangleclaw/plans/1053-rule-approval-cas.md` (local, not tracked).

**Problem.** `PUT /api/session-rules/:id/status` activated whatever content the row held at the moment of approval. Both operator surfaces approve a snapshot (the wrap drawer's text from the wrap step, the Project Rules list's from its last fetch), and the content can change in between through the ungated `PUT /:id`, through `POST /:id/restore`, or across the drawer's own save-then-approve pair of writes.

**The change.**
- **Store.** `setStatus` takes `expectedContent`. For an approval the comparison is the UPDATE's own `WHERE id = ? AND content = ?`, and the rows it changed decide the result (ruling A: a true compare-and-set, not a read then a write). A mismatch throws `CONTENT_CHANGED` carrying `currentContent` and writes nothing, not even a version snapshot. The compare is exact because content is trimmed where it is written. A rejection is never compared.
- **Route.** The token is passed through only after the password gate (ruling B), so a 403 never reveals whether, or how, the text changed. `CONTENT_CHANGED` maps to `409 RULE_CONTENT_CHANGED` with `currentContent`.
- **Wrap drawer** (`resolveRuleProposal`). The approval sends the text shown, or after an edit the text the store persisted. A 409 swaps the current text into the row and leaves it undecided.
- **Chunk 02: Project Rules list.** `renderProjectRulesList` records each proposed row's stored text in `projectRuleShownContent`, beside the render rather than read back out of escaped HTML. `resolveProjectRuleProposal` sends it, and on a 409 redraws the list with a status line saying nothing was approved.
- **Chunk 02: mandatory (ruling B).** `setStatus` refuses an approval with no `expectedContent` (`EXPECTED_CONTENT_REQUIRED`, HTTP 400). It checks this after the authority refusals: the route's password gate and the store's own AI-approval `FORBIDDEN`. The existing approval tests now send the token; that is the contract change, not a weakened test.

**Release level (Critic R-1, cumulative review rev-20260927T143212Z-c73a01ff).** R-1 warned that the mandatory token is a compatibility break for id-only callers, shipped without a major-bump marker. It was reviewed and resolved by Architect ruling (PM message d178d817): Option 2, keep it in the v5 minor line. The route is a privileged, password-gated operator surface and not a listed integration endpoint, so id-only scripts are unsupported callers that must name the text they authorize. There is no marker and no legacy fallback; the CHANGELOG entry keeps an explicit compatibility note instead.

**Tests.** Store (7 cases plus a source pin on the conditional UPDATE, since a single-threaded test cannot tell a read-then-write from a compare-and-set). Route (6 cases: the PUT-swap race, 403 before 409 and before 400, a 409 with its body, a 400, and a rejection). Widget (5 behavioural cases that run the real function against a fake API). Mutation-checked: an unconditional UPDATE, a read-then-write, the route dropping the token, the widget omitting it, and the widget ignoring the 409 body each turn tests red.

**Chunk 02 tests.** Store: a missing token is refused and changes nothing; an AI approval is still `FORBIDDEN` before the token is asked for. Route: a missing token gives 400 `EXPECTED_CONTENT_REQUIRED`, but 403 when the password is also missing. Modal (4 behavioural cases running the real `renderProjectRulesList` and `resolveProjectRuleProposal`): it sends the stored rather than the escaped text, a re-render replaces the remembered text, a 409 redraws the list, and a rejection sends no token. Mutation-checked five more mutants: token not required, token checked before the AI refusal, the modal omitting the token, not redrawing on a 409, and not remembering on render. Each turns tests red.

## 2026-09-27 — dir-scanner deadline tests survive a loaded machine (#1884)

<!-- prawduct: type=bugfix | scope=dir-scanner-flake-1884 -->

The PM dispatched this over Medusa (61a61af3). Small, test-only change; no build plan.

**Root cause.** `request()` arms its deadline as soon as `_ensureChild()` has spawned the replacement child, before that node process has booted. Two tests in the "the deadline kills" suite set a scanner-wide 300 ms deadline so that a hung request dies quickly, and their healthy `ping` requests inherited it. A `ping` on a cold child therefore had to fit a node boot inside 300 ms, and under fleet load it did not. The #1884 test was the one seen failing; the sibling `a request that never answers…` had the same exposure in its setup `ping`. Production's 5 s default absorbs a cold start, so the product is unaffected.

**The change.** `COLD_START_MS` (10 s) is passed as the per-request deadline on both healthy pings. The hung requests keep the short deadline, which is the behaviour those tests check.

**Evidence.**
- A `--require` preload that busy-waits 500 ms on every node boot makes the old file fail 2/2 with the issue's exact error (`timed out after 300ms running ping`). The new file passes 2/2 under the same preload.
- Mutating `_failFor` to sweep every pending request regardless of owner still fails the successor test, at normal and at slowed boot. The longer deadline did not blunt the guard.
- The full declared suite is green.

## 2026-09-26 — Stop tracking this repo's internal plans and evidence

<!-- prawduct: type=chore | scope=untrack-internal-plans -->

Operator decision: forward-only privacy cleanup with NO history rewrite. PM dispatch (ed7331a8) and Architect approval (e7ed90bb, merge gate a122a426). The merge waits for the PM's explicit go.

**The change.** 170 files leave the index; their disk copies stay: 12 top-level plans, 126 in `plans/archive/`, 31 in `plans/1245-evidence/`, and the force-added `.tangleclaw/archive/1839-medusa-delivery-watchdog.md`. `.gitignore` drops `!.tangleclaw/plans/`, and its comments say why and that this is this repo's policy only. The 4 `.tangleclaw/priming/` files stay tracked pending their own audit. Nothing reads plans through git, and the wrap lists candidates with `git status --porcelain`, which omits ignored files, so no product behaviour changes.

**Preservation.** A checksum-verified copy (170/170) is in private Shared storage. Before merging, the PM backed up every local checkout, because pulling a commit that stops tracking files deletes them from disk.

**Tests.** `test/repo-governance-reference.test.js` asserts: nothing is tracked under either directory; new, nested, non-markdown and archive paths are ignored; and the committed `.gitignore` carries no re-include. Before the commit, the last assertion failed against the old `.gitignore`, which proves it detects the negation.
## 2026-09-26 — Roadmap Board: tc-queue block, train version/status, per-car state (#1933)

<!-- prawduct: type=feature | scope=1933-board-queue -->

This is the one renderer PR the operator budgeted for the dynamic board, following the Architect's ruling on A–D. Three pieces stay outside this PR: the generator grouping by v5, v6 and v7 plus the queue data (Shared `build-board.py`); the PM-owned 10-minute scheduled job; and the privacy cleanup, which is on HOLD.

**The change.** `lib/plan-train-card.js` gains the following.
- Optional train `version`, a short label matching `VERSION_RE`.
- Train `status`, a closed enum: `planned | ready | in-progress | blocked | shipped | sunset`.
- Optional car `state`, a closed enum: `open | in-progress | blocked | closed`. It must agree with `closed`, and when omitted the car keeps its old behaviour. Each pill is labelled in words.
- A `tc-queue` block with the same closed-schema and escaping discipline. `createdAt` must be ISO-8601 with a zone. Ages, the `isNew` mark (inclusive at `newDays`) and newest-first order are all computed at render time, so age never removes an item.

The shared JSON, item and issue checks were factored into `_parseObject`, `_needItem` and `_needIssue`. `lib/plan-docs.js` routes `tc-queue` blocks and threads an optional `now` through `renderPlanBody` and `renderPlanPage`; the server passes none, so the current time applies.

**Tests.** The new cases cover badges, every status, refused versions and statuses, car-state colours and words, state/closed disagreement, the old default, the queue summary pills and counts, newest-first order, ages in hours and days, the inclusive threshold, future-timestamp skew, a custom and an empty title, escaping, render-time ageing, and malformed queues. They caught a real bug before commit: the `<1h` age was emitted unescaped. Eight hand mutations each turned tests red: the status enum, state agreement, sort, threshold, age escape, label escape, the ISO check and the version pattern.

## 2026-09-26 — Roadmap train cards on served plan pages, and unbroken table cells (#1930)

<!-- prawduct: type=feature | scope=1930-train-cards -->

Operator request (2026-09-26, with a reference screenshot). It follows the Architect's ruling that no raw-HTML passthrough is allowed and that the pill look comes from a typed, schema-validated block that escapes every value.

**The change.** `lib/plan-train-card.js` is new. A ` ```tc-train ` fence holds one JSON object. `parseTrainBlock` validates it against a closed schema: unknown keys are refused (`__proto__` included), fields are type- and range-checked, sizes are bounded, and hrefs must be absolute https URLs that pass `_isSafeHref`. `renderTrainCard` builds a `<details>` card from fixed classes and escapes every string. The closed/total count is computed from `cars`. Thesis and sequencing go through the plan renderer's `renderInline`, which escapes first. An invalid block renders as escaped code, with the reason in a `block-error` paragraph. `lib/plan-docs.js` routes `tc-train` fences to it and appends its CSS. Table cells now use `overflow-wrap:normal`: the page-level `anywhere` had let a table column shrink to one character, splitting `#411`.

**Tests.** `test/plan-train-card.test.js` asserts on output through `renderPlanBody`: card structure, count, badge, empty train, tilde fence, other fences unchanged, escaping of every field, a quote inside an accepted href, refused reasons not echoing markup, 13 hostile hrefs on both train and car, the closed schema, the bounds, and the page CSS. Four hand mutations each turned tests red: dropping the https check, unescaping the title, accepting unknown keys, and trusting the count.

**Follow-up in the same branch.** Each car pill carries a `title` and an `aria-label` naming its number and open/closed state, so the state is not shown by colour alone. The State cell does not wrap, so `✅ closed` stays on one line.

**Operator direction, same branch: green means done.** A closed issue's title in the expanded table is no longer struck through; the ✅ state and the green car carry it.

**Visual check.** I rendered the real board, generated by the updated `build-board.py` from live GitHub state, through `renderPlanPage` and took headless-Chrome screenshots in dark mode at 760px (about phone width). All 7 trains became cards and no block was refused (94 closed cars, 40 open). The card row matches the operator's reference screenshot. In the expanded table, `#411` and `enhancement` no longer wrap. Light mode was not screenshotted; the card colours use the page's theme tokens, and only the closed-car green is fixed.

**Out of scope here.** Emitting the blocks is a separate change in the shared `build-board.py`, in the Shared repo, which has no remote.

## 2026-09-26 — Plan page "updated" stamp in the host's local time zone (#1928)

<!-- prawduct: type=bugfix | scope=1928-plan-stamp -->

PM dispatch over Medusa (f7dd1a06), under an Architect ruling (e0b2cb45 / 34c4efe1): host-resolved IANA zone as the default, the zone injectable for deterministic tests, and no new config key.

**The change.** `lib/plan-docs.js` gains `formatPlanStamp(iso, timeZone?)`, which uses `Intl.DateTimeFormat` with `timeZoneName: 'short'` and gives `YYYY-MM-DD HH:MM:SS PDT/PST`. `renderPlanPage` takes an optional `timeZone`, and the server passes none, so the host zone applies. `<time datetime>` keeps the ISO UTC value, a `title` tooltip gives the UTC reading, and an unparseable value falls back to its UTC reading rather than failing the page.

**Tests.** Unit: PDT and PST dates, the datetime and title attributes, host default equals the resolved zone, a zone ahead of UTC crossing the date line, and the unparseable fallback. The existing bar fixture now pins `timeZone: 'UTC'`, so its visible-string assertion is unchanged. API: with `TZ=America/Los_Angeles` set in-process, `GET /plans/:id/stamp.md` shows `PST` for a January mtime. This proves the server's call site takes the host zone. It also passes when the runner itself is on UTC.

**Out of scope.** The Roadmap Board's raw-HTML rendering belongs to the shared generator; the PM is coordinating it.

## 2026-09-26 — Fleet Workload Visibility, Phase A: launch-bound workload receipts, activity observer, composed fleet read (#1912)

<!-- prawduct: type=feature | scope=1912-fleet-workload -->

Chunks A1–A4 of `.tangleclaw/plans/1912-fleet-workload-core.md`, implementing ADR 0020, which the Architect accepted as FWV-A18 (PR #1916). The PM dispatched this over Medusa (806b9000).

**The change.**
- **A1:** `workload_receipts` (schema v50, append-only, `UNIQUE (launch_id, seq)`), the `lib/workload.js` write path, `POST/GET /api/tc/workload`, and `tc workload set/show`. `resolveAccess` now returns the verified `sessionId` and `launchId`.
- **A2:** `lib/activity-observer.js`. A 10 s tick of asynchronous serial captures, each bounded by min(1 s, the tick budget left), with a 3 s tick budget and round-robin. The strict at-rest gate reuses `assessSessionIdle`. Observations older than 30 s read `unknown`. Measured capture latency on this host: p95 29 ms.
- **A3:**
  - `lib/workload-compose.js` (pure): receipt currency, base rules 1–11, and monotone operator narrowing.
  - `lib/workload-fleet.js`: gathers the inputs.
  - `GET /api/tc/sessions` carries engine, workload and composed blocks, and runs no tmux.
  - `POST /api/tc/workload/narrowing` is operator-only, recorded in `workload_narrowings`.
  - A guard test fails if shipped code parses clearance phrases.
- **A4:** `workloadLine` in every engine's config, the `workload` capability, and the docs. The dashboard badge and detail row built in A4 were removed before merge under Architect ruling A24 (the operator UI freeze); the PM held them (Medusa message c9e2213a). They are preserved on `origin/held/ui-freeze-1912-dashboard-a3` (51c8b2dd) and tracked as #1923.
- **A29/A30 display safety:** every free-text field (summary, waitDetail, task ids, branch, the narrowing reason) is display-safe through one predicate, `isSafeText`. It refuses Unicode `Cc`, `Cf`, `Zl`, `Zp` and `Default_Ignorable_Code_Point`, and requires a visible character. ADR 0020 §3 is amended in this PR as the authority. Stricter at write time: invisible-only text, and emoji that need a variation selector or zero-width joiner, now get a 400. Normalization and homoglyph detection are out of scope.
- **Boundary-review fixes:** a wrap request supersedes a receipt even after the wrap drawer acknowledges it (`wrap-sentinel` keeps `requestedAt`). The guidance and capability text are built from the server's constants. One session's failed assessment no longer stalls the observer.

**Reviews.** A Critic review per chunk; carried findings rode each next commit. A3 had one blocking finding (the lane line untested), cleared by `verify-resolutions` rev-20260926T202440Z-ecd5128a.

**Deliberately not done.**
- Typed assignment-dispatch supersession (ADR §4, a named dependency not authorized by FWV-A18).
- Project Master workload (composes UNKNOWN).
- Table retention: #1918.

## 2026-09-26 — Detect, never auto-repair, legacy TangleClaw sections in governed CLAUDE.md (#1911)

<!-- prawduct: type=bugfix | scope=engines-1911 -->

The PM dispatched this over Medusa (d5b2a91a). The plan came first and stopped at Plan-Written. The Architect ruled A7–A10 (8869adf0). Plan: `.tangleclaw/plans/1911-governed-claude-md-legacy-copy.md`.

**Problem.** When a CLAUDE.md written whole-file was later governed by the plugin, the first governed write appended the managed block. `spliceManagedBlock` treats all existing text as operator content, so TC's legacy guide stayed above the anchor, and the PortHub, Shared Documents and Session Memory sections and the bootstrap bullets all appeared twice. B1 reproduced it on main c600a7c6: 212 → 419 lines.

**The change.**
- **Analysis.** `lib/legacy-claude-md.js` does pure analysis. A candidate is a proven duplicate: a `##` heading or preamble bullet that the file's own managed block also carries. The scan skips fenced code, because the guides' samples contain `# ` comment lines. It refuses duplicate candidate headings, an unterminated fence, more than one anchor, an anchor inside or after the block, and malformed markers. The rules tiers are never candidates (A9).
- **Guarded writer.** `applyLegacyRepair` takes a digest that covers both the file hash and the plan. It refuses on a mismatch or a read-only carrier (#1291). It writes a temp file, fsyncs it, re-hashes the target (compare-and-swap), then renames. It keeps the file mode, and a second run is a no-op. The header becomes neutral only when it is byte-identical (A8).
- **Detection only (A10).** `engines.writeEngineConfig` warns after a governed write, and `sessions._ruleSourcesSection` adds a launch note. Nothing heals on launch, boot or PATCH.
- **Operator action.** `scripts/repair-governed-claude-md.js` previews the removals, then `--apply <digest>` performs them.
- **Docs.** The engine guide, FEATURES and CHANGELOG `### Fixed`.

**Tests.** `test/legacy-claude-md.test.js` builds its fixtures with the real generators. It covers:
- detection without mutation;
- the digest binding, including a changed-after-preview refusal and a read-only refusal;
- preservation of operator edits, including a section flagged as differing from the managed copy;
- each ambiguous-bound refusal;
- the neutral header versus an altered one;
- idempotence and the preserved file mode;
- the CLI's preview and apply, and its refusal of an ungoverned project.

`test/sessions.test.js` covers the launch note, including that the prime never mutates the file. A mutation test that disabled the digest check turned the binding tests red.

**Architect A22 correction.** The merge was rejected at a5993f55 on three repair-path safety blockers, and all three are fixed on the same branch:
- `repairCommand` shellWord-quotes every argv word. A test sends hostile legal paths through `/bin/sh` and checks each arrives unchanged.
- `_writeAll` writes every byte or refuses, and the fstat size is checked before the rename. Tests inject short, zero and ENOSPC writes.
- A symlinked carrier is refused with `lstat`, before reading and again before the rename, and the preview refuses it too.

A mutation check on each fix turned its tests red.

**Cumulative review follow-up.** The preview always marked the legacy PortHub section as differing, because the whole-file layout put the API base URL and service-token lines after the PortHub guide with no heading between them, while the block keeps them in its first section. `_matchesManagedCopy` now accepts trailing lines that appear verbatim elsewhere in the block. Tests cover all four combinations of service token and Medusa on and off, plus an operator-edited PortHub body that must still be flagged.

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
