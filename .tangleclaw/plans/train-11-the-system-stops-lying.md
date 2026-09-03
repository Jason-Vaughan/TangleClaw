# Train 11 — The System Stops Lying

**Roadmap:** `TangleClaw-Roadmap/ROADMAP_STATE.md` "Blessed Next Train" — Train 11 follows Train 10
(complete 2026-09-03). Sequencing is the Roadmap session's; this plan holds the executable cars.
**Working artifact:** https://claude.ai/code/artifact/19374776-7690-4603-b793-9c573d42c0e4
**Critic mode:** chunk per car (each car is its own branch + PR); `final` on the last car.
Cars are numbered as chunks (`Chunk N`) so the record lint can grade each one.

## Why this train exists

Train 10 made a green run mean "everything ran and passed". This train applies the same standard
to what TangleClaw *tells* the operator and the session. Fourteen filed defects share one shape:
a surface reports a fact it did not measure — a failed fetch renders as an empty ruleset (#948,
#1054), a check that did not run says "up to date" (#1061), a pill promises a version it will not
install (#994), a LAN-bound ttyd says "not wide" (#1056), a discarded setting says nothing (#741),
a sandbox-blocked loopback says "server down" (#1150), a red `main` says nothing (#991), two
contradicting rule sources arrive as one seamless text (#796), a retired engine's config stays on
disk as live canon (#858), a plan-mode wrap times out as `blocked` (#429), the delivery ledger
says `delivered` when shards were merely written (#1063), a paste the engine discarded is logged
as delivered (#1134), and an OpenClaw connection that will not serve a byte shows a green dot
(#1012). The v5.4.0 rule — an unknown must never render as a fact — gets applied to every
surface that still breaks it.

## Confidence check

1. **Problem:** operator- and agent-facing surfaces state outcomes they never verified, so the
   operator hunts in the wrong place (a 17-minute tunnel back-off read as a browser-extension bug;
   a fleet-wide outage of the Claude hook logged as clean deliveries).
2. **Success:** every surface named above has three states, not two — the affirmative fact, the
   affirmative absence, and an explicit unknown that names why and what to do; the ledger records
   `delivered` only on evidence the engine read the material; a session learns at start that its
   base branch is red and that N rule sources are in force.
3. **Out of scope:** a host-side bridge/proxy so sandboxed sessions can reach the API (#1150
   asks 3–4 — operator decision, filed separately if wanted); adding silent prime to Codex (#133);
   the general semantic detection of rule contradictions (#796 says why not); OpenClaw's own
   error-card wording (OpenClaw-Genesis owns it); regenerating every engine's config on every rule
   change (#858 option 1 — option 2 chosen); a wrap-time release refusal on red `main` (#991
   option 3 — a later train; option 1 first, as the issue asks).

## Requirements Confidence

**High** on the eleven S/M cars: each is a filed defect with the code path named and verified
against source this session, and the fix direction chosen from the issue's own option list.
**Medium** on the three L cars (#1063, #1134, #1012): the receipt shape for #1063 is a persisted
format, so the chunk opens with the consumer enumeration the build-plan's confidence note asks
for; #1134's post-paste observation needs the antigravity 1.1.22 pane to measure against; #1012's
usability probe depends on what the OpenClaw gateway exposes over the SSH channel. Each L car
records what it measured before it fixes.

## Engine-agnostic bar (project rule)

Every car's mechanism is engine-neutral: generated text, ledger rows, server-side probes, and
per-engine profile fields. Where an engine lacks a capability (a read-only-mode marker for #429,
a post-paste readiness signal for #1134) the adapter reports an honest skip reason; it never
silently does nothing.

## Chunks

### Chunk 1 — #948 Master rules modal renders a failed fetch as the shipped baseline
- `public/api-helper.js` `loadMasterRules` and `toggleMasterRuleHistory`: a `null` from `api()`
  renders the unknown state through ONE shared helper, `tcRulesUnknownHtml(label, read)`, fed a
  `tcDegradedRead(false, why, remedy)` record — never "No rules — the shipped baseline applies".
  The helper is exported so Chunk 2's copy of the widget renders through it too (Critic R-7).
- Empty-but-successful (`{rules: []}`, `{versions: []}`) still renders the affirmative empty state.
- `test/master-settings-mount.test.js` drives both through the real component with a stubbed
  `api`; red first on the null case.
- **Done when:** the null-stub test is red before and green after; the empty-success test stays
  green throughout.

### Chunk 2 — #1054 `fetchProjectRules` renders a failed fetch as "No rules yet."
- `public/ui.js` `fetchProjectRules` returns `null` on failure; the list body renders
  `window.tcRulesUnknownHtml` (Chunk 1's shared helper) — no third hand-written sentence. The
  load loop and the four mutation handlers all re-read through one `refreshProjectRulesList`;
  a mutation whose re-read fails additionally says so on the status line (the handler's own
  "Added"/"Deleted" is true, but a green status over "Rules unknown" would contradict it). A
  failed initial load says it in the list body only — the transient status line is shared by
  both kinds and would name one failure for two lists.
- Test through the real fetch path with a failing `api` stub; empty success still says "No rules yet."
- **Done when:** failure and empty-success render differently, both asserted.

### Chunk 3 — #1061 manual update-check says "up to date ✓" for a check that did not run
- `public/landing.js` `wireVersionCheck`: `checkOk === undefined` (an older server's cached GET)
  renders "cached 5m ago — not re-checked", never "up to date ✓"; a cold cache renders "not
  checked yet" in label and marker alike. The payload is classified ONCE, in
  `tcUpdateAnswerState` beside the shared `tcIsUpdateAnswer` predicate in `update-beacon.js`,
  and the tooltip ladder, the click ladder, the beacon and the session poll all read that one
  state (Critic R-5 on this car: three parallel ladders had begun to disagree).
- `test/version-visibility.test.js` gains the fallback path (no `checkOk`, both cache states).
- **Done when:** the fallback tests are red before, green after; every existing `clickVersion`
  case unchanged.

### Chunk 4 — #994 the update pill names a version it may not install
- Options 1 + 3 from the issue: the pill and the confirmation say "v5.9.0 or newer" (never a bare
  promise); the post-update confirmation names the version actually checked out (`toRef` from the
  applier).
- The family is every `latestVersion` interpolation in `public/*.js` — the beacon's toast, dot
  and confirm, the session page's confirm override and its agent prompt, and the landing page's
  header tooltip (Critic R-1 on this car: the sweep had stopped at the beacon). Option 2
  (re-resolve at click time) is dropped: it costs a network round-trip per click to promise a
  number the applier would still re-resolve a moment later.
- Tests: each surface's copy; post-update copy reads `toRef`, not the polled version; a guard
  scans every page script for an unqualified interpolation.
- **Done when:** no surface renders the polled version as the install target.

### Chunk 5 — #1056 a LAN-IP-bound ttyd reports not-wide
- `lib/ttyd-bind.js` `describeInstalledBind`: `wide` derives as "neither loopback nor a unix
  socket" instead of enumerating wide forms. The surface models exposed/not-exposed only, so a
  bind the reader cannot classify is reported EXPOSED (the existing bias: a false alarm costs a
  notice, silence costs an open shell).
- Tests: `--interface 192.168.1.5` / `en0` → wide; `127.0.0.1`/`::1`/`localhost`/`lo0`/unix
  socket → not wide; missing → wide.
- **Done when:** the LAN-IP case is red before, green after; loopback and socket cases unchanged.

### Chunk 6 — #741 `silentPrime` is dropped on unsupporting engines without a word
- One owner, `engines.silentPrimeDisposition(projConfig, profile)` → `on` / `off` /
  `not-applicable`, beside `honorsLaunchMode`. The launch path reads it; no restated predicate.
- **Why not a warning (the plan's first cut):** `DEFAULT_PROJECT_CONFIG.silentPrime` is `true`, the
  create path persists it for every engine, and the settings UI hid the toggle on engines
  without the capability — so a stored `true` on a Codex project is indistinguishable from the
  default, and a warn-level line would fire on every non-Claude launch about a preference
  nobody set (Critic R-5 on this car: warning on a default is the shape this train removes).
- The surface the operator actually reads is the settings modal: on an engine without the
  capability it now renders the toggle inert with "Not available on codex" rather than hiding it
  (the first cut added "— the session prime is typed into the terminal instead", dropped in
  Chunk 7 because it is false for an engine with no prime channel; the hint states the fact,
  not a downstream outcome). The launch records the same fact at info level, naming project,
  engine, setting and why.
- Descoped: a `droppedPreference` field on the delivery ledger row (fixed-column table with CHECK
  constraints; the row's `prime-paste` channel already records what happened; revisit with the
  receipt work in Chunk 12).
- Tests: the owner's three answers; the launch line on codex (either stored value) and its absence
  on claude; the settings branch renders the sentence and no saveable control.
- **Done when:** a non-Claude project's settings say the setting does not apply; the launch
  records it; nothing at warn level fires on a default.

### Chunk 7 — #1150 `tc` reports sandbox-blocked loopback as "the server may be down" (third-party)
- `bin/tc`: a fetch failure says the API is unreachable **from this execution context**, names
  managed-sandbox loopback blocking as a likely cause, carries a stable code
  (`API_UNREACHABLE_FROM_CONTEXT`) and an exact instruction: do not report an outage until a
  host-context check (launchd state / listening socket) is made; ask the operator or Master.
- The generated operational guide (the `tc capabilities` paragraph) and the Master's primer carry
  "a failed localhost `tc`/curl is not proof of outage".
- Regression test: `bin/tc` against a refused connection asserts the wording, the code, and the
  absence of "down"; the guide generator's output is asserted to carry the sentence.
- Asks 3–4 (host-side bridge) are out of scope; the operator decides whether to file them.
- **Done when:** the old sentence cannot be produced; the guide and primer carry the new one.

### Chunk 8 — #991 a red `main` is invisible to every session
- Option 1: a server-side probe of the project's default-branch CI status (via `gh`, cached with
  a TTL, engine-neutral) renders a session-start line — "main is FAILING (run <url> on <sha>)"
  — in the generated prime. Green renders nothing; **unknown renders as unknown**, never as
  green, and is logged at warn so the operator learns the probe is off.
- The verdict is per workflow over a 20-run window of push/dispatch runs (Critic R-1 on this
  car: the single newest run on the branch let a green scheduled run mask a red test run).
  `none` is reserved for facts — no origin remote, no push-triggered runs; an origin whose
  `origin/HEAD` was never set (a `git remote add` clone) is resolved through `gh repo view` and
  otherwise reported unknown with the `git remote set-head` remedy (Critic R-2).
- The spawn is async: `refresh()` is awaited by the launch route before the synchronous
  `launchSession`/`generatePrimePrompt`, which reads `readCached()`; a cold cache is an honest
  unknown (Critic R-9: a synchronous `gh` on the launch path holds the whole server).
- Tests: every state through an injected exec, including the masked-red-run shape and the
  timeout; TTL honoured; the prime for red / unknown / green; the route awaits the refresh.
- **Done when:** a failing `main` produces the line on every engine's generated context.

### Chunk 9 — #796 two binding rule sources contradict and nothing detects it
- Slice 1 (visibility): the session-start context states how many rule sources are in force and
  names them (TC global rules, TC project rules, plugin methodology when present). On a
  plugin-governed project the #1021 operational block carries no rules tier, so the section
  says the global rules do NOT reach that session by file rather than claiming delivery
  (Critic R-1 on this car).
- Slice 2 (pinned overlap): `test/global-rules-boundary.test.js` asserts `data/global-rules.md`
  does not prescribe on the methodology-owned topics. The topic list is ONE module,
  `lib/methodology-topics.js`, read by the guard and by the prime's plugin line (Critic R-8:
  two hand-typed lists had already diverged).
- TangleClaw's own `CLAUDE.md` is gitignored, plugin-governed and hand-maintained (the learnings
  file records it): its `--squash` lines were hand-edited on the primary in this car, since no
  sync reaches them. The wrap pipeline still hard-codes `--squash` in `lib/wrap-steps/`
  (`commit.js`, `pr-merge.js`) — filed as its own issue; out of this car's minimal scope.
- The live contradiction is reconciled minimally: the global rule keeps `--auto` and
  `--delete-branch` and drops the `--squash` prescription (merge strategy belongs to the
  methodology layer, ADR 0011). This regenerates managed configs; flagged to the operator as the
  vetoable decision of this train.
- **Done when:** the guard is red on the current file and green after the edit; the source line
  appears in generated context.

### Chunk 10 — #858 an engine switch leaves the previous config file as live canon
- Option 2 (the `syncEngineHooks` precedent): on an engine switch, the previous engine's config
  file — when it carries TangleClaw's managed markers OR the generated whole-file header
  (`GENERATED_HEADER_MARK`, one constant every generator and the detector share) — is marked
  with a short, locally-dated inactive notice naming the live engine and its config file. A
  managed block keeps the operator's content outside the markers; a hand-written file and a
  plugin-owned `CLAUDE.md` are never touched, with the reason logged. A failed retirement
  (unreadable, unwritable, refused merge) is logged at warn — the file is live canon by accident,
  not by choice — and no retirement runs when the new engine's config was not written.
- Switching back regenerates the file normally (verified, not assumed — the issue scoped it out).
- Tests: switch claude→antigravity marks `CLAUDE.md`; switch back regenerates; plugin-governed
  and unmanaged files untouched.
- **Done when:** after a switch exactly one config file reads as live.

### Chunk 11 — #429 plan-mode wraps time out to `blocked` instead of saying why
- Engine profiles gain an optional `readOnlyModeMarker` (evidence-dated, Claude's plan-mode
  indicator). Before an ai-content wrap step injects, the wrap samples the pane; a present marker
  fails the step immediately with "Exit plan mode to wrap — content steps need write access"
  (status `needs-operator`, not `blocked`) instead of waiting out the idle cap.
- Engines with no marker: the pre-check reports the honest skip reason in the step record and
  proceeds as today.
- Tests: marker present → immediate actionable status; absent → unchanged; profile without the
  field → skip reason recorded.
- **Done when:** a plan-mode pane fails the step in under a second with the actionable message.

### Chunk 12 — #1063 delivery is recorded as `delivered` when shards are written
- Opens with the consumer enumeration the prime-delivery build plan asks for: every reader of the
  delivery ledger (delivery panel, `sessionAwareness`, awareness endpoints, tests) listed in the
  PR before the format changes.
- `rules-hook` channel: write-time outcome becomes `written`; the hook, when it runs, posts a
  receipt (`POST /api/tc/receipt` or the existing awareness-receipt path) that upgrades the row to
  `delivered`. A row still `written` after the session is observed active renders as
  **unverified** on every consumer — the outage shape #759 produced now shows.
- Engine-neutral: any engine's hook/prime channel can post the receipt; engines without a hook
  keep their existing channel outcomes.
- Tests: write → `written`; receipt → `delivered`; no receipt + active session → unverified on the
  panel and in `sessionAwareness`; the #759 replay (hook fails) never yields `delivered`.
- **Done when:** a launch whose hook never ran cannot produce a `delivered` row.

### Chunk 13 — #1134 a paste the engine discarded is logged as delivered
- After a prime paste, the launcher watches the pane for a bounded window and records
  `unverified` with the reason when the send is observed to fail, retrying once, bounded.
- **Amended during build (Critic R-1, blocking).** The chunk specified watching for the transcript
  *digest moving with our content*. That is not implementable from a pane tail and was measured to
  be actively harmful: a real generated prime is 37–225 lines on this machine, so once it echoes
  and the engine answers, no part of it is still in view — the check reads "not landed" on every
  healthy launch and re-pastes the whole prime into a session that already had it, which is worse
  than the defect. Digest movement is no substitute either: measured on agy 1.1.24, typing alone
  moves the pane digest before Enter, so it is satisfied by our own keystrokes.
  What shipped watches for the engine's own **rejection** text instead (profile-declared,
  `pasteRejectedMarker`), which is one line, on screen when it matters, and positive evidence
  rather than the absence of evidence. It only ever DOWNGRADES: a watch that saw no rejection, or
  could not look, leaves the pre-existing verdict untouched. The stated cost is that a swallow the
  engine does not announce is still missed — the reported case closes, the unreported one does not.
- Uses the readiness signals #1133 shipped; the antigravity profile evidence is re-dated against
  1.1.22.
- Tests: an announced rejection → `unverified` + one bounded re-paste; a healthy pane → the gate's
  verdict and NO re-paste (the regression guard for the abandoned mechanism); a busy or dead pane →
  the retry is held; a styled banner still matches; an unreadable pane → `unmeasured`, never
  "no rejection".
- **Done when:** the swallowed-paste replay records `unverified`, not `delivered`.

### Chunk 14 — #1012 OpenClaw connections show a green dot while unusable
- The connection indicator distinguishes **reachable · paired · authenticated · serving**. The
  probe goes past HTTP: over the connection's SSH channel it reads the gateway's pending device
  requests (`openclaw devices list`) and the gateway's health; the UI renders
  "unpaired — approve device `<id>` on `<host>`" with the exact command, and "reachable, gateway
  error: <message>" for a gateway that answers HTTP but cannot serve.
- The Control-UI index is served `Cache-Control: no-store` so a post-update bundle hash cannot
  pair with a stale index.
- The `[::1]` recreate-probe lead is measured (does the probe require both stacks?) and fixed or
  recorded as not-a-defect with the evidence.
- Tests: each state from a stubbed probe; no-store header on the index route; the fleet smoke
  (`/api/openclaw/connections` reporting per-connection state) covers all four states.
- **Done when:** a paired-but-unapproved gateway cannot render a green dot.

## Status
- [x] Chunk 1 — #948 (PR #1162)
- [x] Chunk 2 — #1054 (PR #1163)
- [x] Chunk 3 — #1061 (PR #1165)
- [x] Chunk 4 — #994 (PR #1166)
- [x] Chunk 5 — #1056 (PR #1167)
- [x] Chunk 6 — #741 (PR #1168)
- [x] Chunk 7 — #1150 (PR #1169)
- [x] Chunk 8 — #991 (PR #1170)
- [x] Chunk 9 — #796 (PR #1171)
- [x] Chunk 10 — #858 (PR #1173)
- [x] Chunk 11 — #429 (PR #1174)
- [x] Chunk 12 — #1063 (PR #1175)
- [x] Chunk 13 — #1134 (PR #1177)
- [ ] Chunk 14 — #1012

## Context
Session 2026-09-02/03, autonomous sprint (same shape as Train 10). Work in
`.claude/worktrees/train11`; the primary checkout stays on `main` (live install). Roadmap session
(`tangleclaw-roadmap-9aa2084a`) notified at start; message after each ship. Cars ordered
cheapest first (S → M → L) so a stopped sprint leaves the most defects closed.
