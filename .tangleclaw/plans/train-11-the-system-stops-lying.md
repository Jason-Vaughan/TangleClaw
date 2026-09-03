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
  renders "served from cache — not re-checked" with the cache age, never "up to date ✓"; cold
  cache (`checkedAt` null) renders check-unknown consistently in marker and label.
- `test/version-visibility.test.js` gains the fallback path (no `checkOk`, both cache states).
- **Done when:** the fallback tests are red before, green after; every existing `clickVersion`
  case unchanged.

### Chunk 4 — #994 the update pill names a version it may not install
- Options 1 + 3 from the issue: the pill and the confirmation say "v5.9.0 or newer" (never a bare
  promise); the post-update confirmation names the version actually checked out (`toRef` from the
  applier).
- Tests: pill copy with a stale poll; post-update copy reads `toRef`, not the polled version.
- **Done when:** no surface renders the polled version as the install target.

### Chunk 5 — #1056 a LAN-IP-bound ttyd reports not-wide
- `lib/ttyd-bind.js` `describeInstalledBind`: `wide` derives as "neither loopback nor a unix
  socket" instead of enumerating wide forms; an unparseable/unknown bind stays unknown (existing bias).
- Tests: `--interface 192.168.1.5` → wide; `127.0.0.1`/`::1`/`localhost`/unix socket → not wide;
  missing/unknown → the existing unknown outcome.
- **Done when:** the LAN-IP case is red before, green after; loopback and socket cases unchanged.

### Chunk 6 — #741 `silentPrime` is dropped on unsupporting engines without a word
- `lib/sessions.js`: parity with the `defaultLaunchMode` warning — when `silentPrime: true` and
  the engine lacks `supportsSilentPrime`, `log.warn` names the engine and the setting and the
  launch result carries the same warning the way the launch-mode drop does.
- The delivery ledger row for that launch carries `droppedPreference: 'silentPrime'` so the panel
  can show it (additive field; existing consumers ignore unknown keys — verified in the chunk).
- Test: codex profile + `silentPrime: true` → warning present, prime pasted, ledger field set;
  claude profile → no warning.
- **Done when:** the warning appears exactly on the drop path and nowhere else.

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
  a TTL, engine-neutral) renders a session-start line — "main CI: failing (run <url>, since
  <sha>)" — in the generated prime/context. Green renders nothing extra; **unknown renders as
  unknown** ("main CI: unknown — gh unavailable / no workflow / rate-limited"), never as green.
- Tests: red / green / unknown from a stubbed probe; TTL honoured; the unknown text never reads
  as passing.
- **Done when:** a failing `main` produces the line on every engine's generated context.

### Chunk 9 — #796 two binding rule sources contradict and nothing detects it
- Slice 1 (visibility): the session-start context states how many rule sources are in force and
  names them (TC global rules, TC project rules, plugin methodology when present).
- Slice 2 (pinned overlap): `test/global-rules-boundary.test.js` asserts `data/global-rules.md`
  does not prescribe on the methodology-owned topics — merge strategy, commit attribution
  trailers — and lists the checked topics so the guard is a checklist, not a heuristic.
- The live contradiction is reconciled minimally: the global rule keeps `--auto` and
  `--delete-branch` and drops the `--squash` prescription (merge strategy belongs to the
  methodology layer, ADR 0011). This regenerates managed configs; flagged to the operator as the
  vetoable decision of this train.
- **Done when:** the guard is red on the current file and green after the edit; the source line
  appears in generated context.

### Chunk 10 — #858 an engine switch leaves the previous config file as live canon
- Option 2 (the `syncEngineHooks` precedent): on an engine switch, the previous engine's config
  file — only when it carries TangleClaw's managed markers — has its managed block replaced by a
  short inactive notice naming the live engine and its config file, dated. Hand-written content
  outside the markers is untouched; a plugin-governed file is never touched.
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
- After a prime paste, the launcher observes the pane for a bounded window: the transcript digest
  must move with our content (or a response block appear). A swallowed paste records
  `unverified` with the reason and retries after backoff, bounded (profile-declared attempts).
- Uses the readiness signals #1133 shipped; the antigravity profile evidence is re-dated against
  1.1.22.
- Tests: digest moves → `delivered`; digest static → `unverified` + retry; retry succeeds →
  `delivered` with attempt count; profile without signals → honest skip reason.
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
- [ ] Chunk 2 — #1054
- [ ] Chunk 3 — #1061
- [ ] Chunk 4 — #994
- [ ] Chunk 5 — #1056
- [ ] Chunk 6 — #741
- [ ] Chunk 7 — #1150
- [ ] Chunk 8 — #991
- [ ] Chunk 9 — #796
- [ ] Chunk 10 — #858
- [ ] Chunk 11 — #429
- [ ] Chunk 12 — #1063
- [ ] Chunk 13 — #1134
- [ ] Chunk 14 — #1012

## Context
Session 2026-09-02/03, autonomous sprint (same shape as Train 10). Work in
`.claude/worktrees/train11`; the primary checkout stays on `main` (live install). Roadmap session
(`tangleclaw-roadmap-9aa2084a`) notified at start; message after each ship. Cars ordered
cheapest first (S → M → L) so a stopped sprint leaves the most defects closed.
