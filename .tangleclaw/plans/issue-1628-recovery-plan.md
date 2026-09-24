# #1628 recovery — revalidation against main and plan

Issue: https://github.com/Jason-Vaughan/TangleClaw/issues/1628 (OPEN, checked 2026-09-23).
Dispatch: PM message `88fb8276`, "#1628 Recovery". This dispatch revokes merging, the live
checkout, the service restart, live checks and releases. The Operator integrates.
Status: **built to the Architect's final rulings D1–D8 on branch `fix/1628-appserver-wake-readiness`
(Builder2 worktree `.claude/worktrees/1628-appserver`). Next: the full suite, the Critic, then the PR.**
Authorization: the Architect's `two-builder-readiness-roadmap.md`, section "Builder2 recovery exception
— 2026-09-24". It is a one-task exception, and the general hold still stands.

## Rulings (Architect, 2026-09-24; durable record: Architect `issue-1628-readiness-provenance-ruling.md`, "Amendment")

| # | Ruling | What it changed in the build |
|---|---|---|
| D1 | APPROVE | Structured thread state is a required gate. `idle` is necessary, never sufficient. |
| D2 | **MODIFY (reversed my recommendation)** | A channel-less Codex session **holds** as `engine-channel-absent`, because the whole-tail pane gate false-idles on quoted prose (ledger 5030). Other engines are unchanged. Which engines this covers is decided generically by `declaresObserver`, never by an engine name. |
| D3 | MODIFY | The facade answers `channel: absent\|present`. Before any adapter is asked it validates the session, active status, launch sequence, engine and project. The adapter validates process identity, version and thread. |
| D4 | APPROVE | tmux delivery and every pane, draft, fleet, wrap, dedupe and identity gate are kept. |
| D5 | APPROVE | Fresh branch. The held branch and `backup/1628-pre-recovery-0bdab50` are untouched. |
| D6 | MODIFY | With a channel present, a missing, stale, failed or unknown answer **holds** as `engine-thread-unknown`. The cache and the in-flight read are keyed by session+channel+launch, late results are discarded, and nothing is injected from the callback. |
| D7 | APPROVE scope, MODIFY rationale | The launch gate is unchanged, and nothing creates a thread or spends a turn. Corrected rationale: shipped evidence says a fresh thread cannot be **subscribed to or have its turns listed** before its first user message. That is not the same as loaded-thread discovery, which the observer does use. |
| D8 | APPROVE option (b) with guards | An unrecorded channel thread is bound to the sole loaded project thread, compare-and-set (`updateAdapterStateIf`), and never replaces a recorded thread. After the bind, "only one" is re-established. Before `idle`, the row is re-read for the same generation. A lost race answers `unknown`. |

| D9 | **PENDING** (asked after the Critic's blocking finding) | A Project Master running Codex never has a launch channel. Built to my recommendation (a): it holds as `master-engine-unobserved`, whose meaning says no relaunch will fix it. Rejected: (b) the Master keeps the pane gate, which carries the ledger-5030 false idle. With it, the wake consults channels only for engines that `declaresObserver`, so a channel-lookup failure cannot hold a Claude session. |

**Consequences recorded before the PR:** a Codex session launched before startupControl channels, or
whose app-server did not start, no longer gets wakes until it is relaunched. The ledger and the peer
route name this as `engine-channel-absent`. The first tick for a channelled session always holds
(`engine-thread-unknown`), because the read it starts answers the next tick. Each observation runs
`ps` twice, synchronously, to check the app-server's identity.

## Preserved state (nothing was reset, rewritten or discarded)

- Held branch `fix/1628-status-row-provenance` at `0bdab50`: 7 commits, merge-base `203120a`.
- Backup ref `backup/1628-pre-recovery-0bdab50` points at the same commit.
- The uncommitted `CLAUDE.md` diff is TangleClaw's launch rewrite of its own section. A copy is
  saved to the session scratchpad and it stays in the tree.

## Revalidation against main `6ddb2fc`

| Branch content | Verdict | Why |
|---|---|---|
| `c2c66c7` reads Codex readiness from its status row | **Superseded as the design** | The Architect ruling (`issue-1628-readiness-provenance-ruling.md`, 2026-09-19) rejects a status-row `Ready` as a readiness detector unless the layout's provenance is qualified. Nobody has shown that qualification can be implemented. |
| `a7a8efc` refuses a status row with no provable run-state | **Rejected** | This is the "frozen patch / code successor" the ruling named. Its `KNOWN LIMIT` test accepts a field that is not run-state. |
| `data/engines/codex.json` profile fields | **Do not ship** | The ruling notes that old code rejects the new fields, and profile-first rollout is forbidden. Main has also changed this file since the merge-base. |
| `9ab6208`, `e9b52a0`, `32df18b`, `b52b516` handoff and plan documents | **Keep as evidence** | Historical record. Nothing to ship. |
| Test fixtures and refusal cases (`test/medusa-wake-status-row.test.js`, `_wake-fixtures.js`) | **Partly reusable** | The adversarial cases (a non-state field named `Ready`, transcript text that looks like a footer, busy and Ready both present) should become regressions proving the pane-text path never wakes a Codex session. |

**What changed on main since then:** #1825 B2 (`7e8585f`, #1833) and B3 (`265c89f`, #1835) gave
every Codex launch its own **app-server channel**. `lib/startup-control-codex.js` `_readiness()`
now reads a thread's `status.type` over the protocol. It fails closed on an unknown answer, a
version mismatch, an ambiguous thread or a thread not bound to this launch, and it records
engine version and thread identity on the channel. The ruling listed a structured engine signal
as the alternative path, noting "no suitable accessible interface has been verified." That
interface now exists, has been verified and is shipped. It also satisfies most of the ruling's
invalidation requirements (1, 4, 6) structurally: the channel is bound to one launch, one process
and one thread, and it ends with the session.

**Conclusion:** the branch's detector should not ship, and I will not rebase it. #1628 can now be
completed on the structured signal instead.

## Architectural decisions (for the Architect)

- **D1: Readiness source for waking Codex.** *Recommend:* when the session has a live
  `startupControl` channel, the Medusa wake gate reads the thread state from the app-server:
  `idle` allows the wake; any other state holds. *Rejected:* (a) qualifying the status-row
  layout, whose feasibility is unestablished and would need a costly invalidation apparatus;
  (b) shipping `a7a8efc`, which was already ruled out.
- **D2: Codex session with no channel** (it predates B2/B3, the channel is lost, or a fire is
  unrecoverable). *Recommend:* keep main's current pane gate unchanged. #1628 stays fixed only for
  channelled launches, and this is recorded as a known limit. *Rejected:* falling back to status-row
  parsing, since the ruling forbids a heuristic without provenance; holding every channel-less
  Codex wake indefinitely, since that is a regression for sessions that wake today.
- **D3: Contract and module ownership (revised after reading the adapter).**
  `startup-control-codex.js` states that nothing outside it may know about sockets or threads,
  and adapters are reached through the generic contract in `docs/engine-guide.md`. *Recommend:*
  add an optional adapter method `observeActivity(channel, project)` to that contract, reached
  through a generic `startupControl.observeActivity(sessionId, project)`. It returns
  `{state: 'idle'|'busy'|'unknown', reasonCode}` and makes a read-only protocol read: it opens
  no turn, records no fire, and never checks trust, auth or quota, so a launch READY never counts
  as permission to wake. The Codex implementation needs three things: the server version equal
  to the channel's recorded version; the recorded thread loaded; and **no other loaded thread
  for the project's directory**. The last one is stricter than the fire's check, because `/new`
  in the TUI can leave the recorded thread idle while a different thread is working. After that
  it maps `idle` to idle and `active` to busy; any other answer is unknown. An adapter without
  the method reads as unknown. *Rejected:* `medusa-wake.js` talking to the socket, which breaks
  the module boundary.
- **D4: What delivers the wake.** *Recommend:* keep tmux injection. The app-server only answers
  whether the session is idle. The existing gates for composer and draft, fleet, active turn and
  deduplication stay in force, because the app-server cannot see text typed into the TUI composer.
  *Rejected:* delivering the nudge as an app-server `turn/start`. That would change the delivery
  contract, bypass the operator's draft protection, and belongs in a separate issue if wanted.
- **D5: Disposition of the held branch.** *Recommend:* build on a fresh branch
  `fix/1628-appserver-wake-readiness` cut from main. Leave `fix/1628-status-row-provenance` and
  the backup ref untouched as evidence until the Operator disposes of them. *Rejected:* rebasing
  7 commits across 121 on main, which rewrites held history and carries rejected code forward.

- **D6: Asynchronous read versus the synchronous wake tick.** *Recommend:* when a session has an
  open channel and mail pending, the tick starts the read (at most one in flight per session)
  and uses only an observation younger than two tick intervals. A missing or stale observation
  counts as unknown and falls to D2. *Rejected:* making `_tick` async, which widens the change
  to every gate and to the delivery race protections.
- **D7: The launch readiness gate is out of scope.** On codex-cli 0.156.1 a fresh thread cannot
  be listed before its first user message, so at launch the protocol can only say unknown. The
  native launch's pane gate therefore cannot use this signal. *Recommend:* fix the wake only,
  and record the launch gate as a known limit. *Rejected:* forcing a thread into existence at
  launch, which would spend a turn.

## Build (after the rulings; I may start on the recommendations meanwhile)

1. Add `observeThreadState` with JSDoc, plus unit tests on a fake connection covering idle,
   active, unknown, version mismatch, thread not bound and channel absent.
2. Wire it into the Codex path of the wake gate with a distinct reason code
   (`engine-thread-busy` / `engine-thread-unknown`). A channel-less session keeps today's code path.
3. Regression tests: the adversarial pane fixtures never produce a wake. `idle` with a composer
   draft still holds. `busy` wins over any pane text.
4. Update docs (`docs/engine-guide.md` wake section, the configuration reference if a reason code
   is surfaced) and CHANGELOG `### Fixed`.
5. Run the full suite, then the Critic, then open the PR with combined-baseline evidence
   (`npm test` on the rebuilt branch at `6ddb2fc`+). **No merge, restart or live check**: the
   Operator integrates.

## Found during the build

The live capture `CX_TRANSCRIPT_PROSE_PANE` (ledger 5030) shows **main's** whole-tail pane gate
reading a Codex pane as at rest on transcript prose that quotes `· Ready ·`. D2 was reversed on
exactly this evidence, so it is fixed for Codex: a channel answers, or no channel holds. Engines
without a channel observer keep the whole-tail gate. No case of this is known for them, but the
same shape could exist.

## Verification limits (stated up front)

- I cannot exercise a real Codex pane: probes in active operator panes are not authorized. The
  evidence will be unit and integration tests against a fake app-server socket.
- The app-server reports what the thread is doing, not what the TUI renders. A dialog that exists
  only in the TUI (trust) is caught by `_readiness`'s config read, but an arbitrary picker or
  preview opened by the operator is caught only by the retained pane gates.
